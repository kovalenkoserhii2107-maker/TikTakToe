(() => {
  'use strict';

  // ---------- настройки сети ----------
  // Игра работает без собственного сервера: игроки обмениваются сообщениями
  // через публичный MQTT-брокер по WebSocket. Брокер можно переопределить
  // параметром ?broker=wss://host:port/path
  const PREFIX = 'tiktaktoe-ks/v1';
  const params = new URLSearchParams(location.search);
  const BROKERS = params.get('broker')
    ? [params.get('broker')]
    : ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const PRESENCE_EVERY = 20000;   // как часто обновлять своё присутствие
  const PRESENCE_TTL = 75000;     // через сколько считать игрока пропавшим
  const NEXT_ROUND_DELAY = 3500;
  const JOIN_TIMEOUT = 8000;

  const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];

  const $ = (id) => document.getElementById(id);
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  const me = {
    id: uid(),
    name: safeStorage('get', 'ttt-name') || '',
    status: 'lobby', // lobby | waiting | playing
  };
  const players = new Map(); // id -> { name, status, seen }
  let client = null;
  let brokerIdx = 0;
  let game = null;
  let pendingJoin = null;

  // ---------- утилиты ----------
  function safeStorage(op, key, val) {
    try {
      if (op === 'get') return localStorage.getItem(key);
      localStorage.setItem(key, val);
    } catch (e) { /* приватный режим */ }
    return null;
  }

  function cleanName(s) {
    return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 20);
  }

  function toast(text, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'err' ? ' err' : '');
    el.textContent = text;
    $('toasts').appendChild(el);
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3200);
  }

  function showScreen(name) {
    for (const s of ['lobby', 'wait', 'game']) {
      $('screen-' + s).classList.toggle('hidden', s !== name);
    }
  }

  function hueOf(str) {
    let h = 0;
    for (const ch of str) h = (h * 31 + ch.charCodeAt(0)) % 360;
    return h;
  }

  // ---------- сеть ----------
  const topic = {
    player: (id) => `${PREFIX}/players/${id}`,
    inbox: (id) => `${PREFIX}/inbox/${id}`,
  };

  function setConn(state, text) {
    const el = $('conn');
    el.classList.toggle('online', state === 'online');
    el.classList.toggle('offline', state === 'offline');
    $('connText').textContent = text;
  }

  function connect() {
    const url = BROKERS[brokerIdx];
    setConn('connecting', 'Подключение…');
    let everConnected = false;
    let switched = false;
    client = mqtt.connect(url, {
      clientId: 'ttt_' + me.id,
      keepalive: 30,
      reconnectPeriod: 2500,
      connectTimeout: 8000,
      clean: true,
      will: { topic: topic.player(me.id), payload: '', retain: true, qos: 1 },
    });

    client.on('connect', () => {
      everConnected = true;
      setConn('online', 'Онлайн');
      client.subscribe([`${PREFIX}/players/+`, topic.inbox(me.id)], { qos: 1 });
      publishPresence();
    });
    client.on('reconnect', () => setConn('connecting', 'Переподключение…'));
    client.on('offline', () => setConn('offline', 'Нет связи'));
    client.on('error', () => {});
    client.on('close', () => {
      // если основной брокер недоступен с самого начала — пробуем запасной
      if (!everConnected && !switched && BROKERS.length > 1) {
        switched = true;
        client.end(true);
        brokerIdx = (brokerIdx + 1) % BROKERS.length;
        setTimeout(connect, 500);
      }
    });
    client.on('message', onMessage);
  }

  function send(id, msg) {
    if (!client) return;
    msg.from = me.id;
    client.publish(topic.inbox(id), JSON.stringify(msg), { qos: 1 });
  }

  function publishPresence() {
    if (!client || !client.connected) return;
    const payload = JSON.stringify({ name: me.name || 'Игрок', status: me.status, ts: Date.now() });
    client.publish(topic.player(me.id), payload, { qos: 1, retain: true });
  }

  function clearPresence() {
    if (client && client.connected) client.publish(topic.player(me.id), '', { qos: 1, retain: true });
  }

  function setStatus(status) {
    me.status = status;
    publishPresence();
  }

  function onMessage(t, buf, packet) {
    const text = buf.toString();
    if (t.startsWith(`${PREFIX}/players/`)) {
      const id = t.slice(`${PREFIX}/players/`.length);
      if (!text) {
        players.delete(id);
        if (game && game.oppId === id && !game.left) opponentLeft();
      } else {
        let p;
        try { p = JSON.parse(text); } catch (e) { return; }
        // для сохранённых (retained) сообщений доверяем метке времени отправителя
        const seen = packet.retain ? Number(p.ts) || 0 : Date.now();
        players.set(id, { name: cleanName(p.name) || 'Игрок', status: p.status, seen });
        if (game && game.oppId === id && !game.left) {
          // статус «не играет» считаем выходом только после того, как соперник уже был в игре
          if (p.status === 'playing') game.oppSeenPlaying = true;
          else if (game.oppSeenPlaying) opponentLeft();
        }
      }
      renderLobby();
      return;
    }
    if (t === topic.inbox(me.id)) {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      handleDirect(msg);
    }
  }

  function handleDirect(msg) {
    switch (msg.t) {
      case 'join': {
        if (me.status === 'waiting' && !game) {
          const first = Math.random() < 0.5 ? me.id : msg.from;
          send(msg.from, { t: 'accept', name: me.name, first });
          startGame(msg.from, cleanName(msg.name) || 'Игрок', first);
        } else {
          send(msg.from, { t: 'busy' });
        }
        break;
      }
      case 'accept': {
        if (!pendingJoin || pendingJoin.id !== msg.from || game) {
          // соперник принял, а мы уже передумали — сообщаем ему
          send(msg.from, { t: 'leave' });
          return;
        }
        clearTimeout(pendingJoin.timer);
        pendingJoin = null;
        startGame(msg.from, cleanName(msg.name) || 'Игрок', msg.first);
        break;
      }
      case 'busy': {
        if (pendingJoin && pendingJoin.id === msg.from) {
          clearTimeout(pendingJoin.timer);
          pendingJoin = null;
          renderLobby();
          toast('Эта игра уже занята', 'err');
        }
        break;
      }
      case 'move': {
        if (game && msg.from === game.oppId) onOpponentMove(msg.round, msg.cell);
        break;
      }
      case 'leave': {
        if (game && msg.from === game.oppId && !game.left) opponentLeft();
        break;
      }
    }
  }

  // ---------- лобби ----------
  function requireName() {
    const input = $('nameInput');
    const name = cleanName(input.value);
    if (!name) {
      input.classList.remove('shake');
      void input.offsetWidth;
      input.classList.add('shake');
      input.focus();
      toast('Сначала напиши своё имя', 'err');
      return false;
    }
    me.name = name;
    input.value = name;
    safeStorage('set', 'ttt-name', name);
    return true;
  }

  function renderLobby() {
    const now = Date.now();
    const list = $('lobbyList');
    let online = 0;
    const waiting = [];
    for (const [id, p] of players) {
      if (now - p.seen > PRESENCE_TTL) continue;
      online++;
      if (p.status === 'waiting' && id !== me.id) waiting.push([id, p]);
    }
    waiting.sort((a, b) => a[1].name.localeCompare(b[1].name));
    $('onlineCount').textContent = 'онлайн: ' + Math.max(online, client && client.connected ? 1 : 0);

    const keep = new Set(waiting.map(([id]) => id));
    for (const li of [...list.children]) {
      if (!keep.has(li.dataset.id) && !li.classList.contains('leaving')) {
        li.classList.add('leaving');
        setTimeout(() => li.remove(), 300);
      }
    }
    for (const [id, p] of waiting) {
      let li = list.querySelector(`li[data-id="${CSS.escape(id)}"]:not(.leaving)`);
      if (!li) {
        li = document.createElement('li');
        li.className = 'lobby-item';
        li.dataset.id = id;
        li.innerHTML = '<div class="avatar"></div><div class="li-info"><div class="li-name"></div>' +
          '<div class="li-status">ждёт соперника</div></div><button class="btn join">Играть</button>';
        li.querySelector('button').addEventListener('click', () => joinGame(id));
        list.appendChild(li);
      }
      const h = hueOf(id);
      const av = li.querySelector('.avatar');
      av.textContent = (p.name[0] || '?').toUpperCase();
      av.style.background = `linear-gradient(135deg, hsl(${h} 85% 62%), hsl(${(h + 50) % 360} 85% 52%))`;
      li.querySelector('.li-name').textContent = p.name;
      const btn = li.querySelector('button');
      const joining = pendingJoin && pendingJoin.id === id;
      btn.disabled = !!pendingJoin;
      btn.textContent = joining ? 'Подключение…' : 'Играть';
    }
    const empty = waiting.length === 0;
    $('lobbyEmpty').classList.toggle('hidden', !empty);
  }

  function createGame() {
    if (!requireName()) return;
    if (!client || !client.connected) { toast('Нет подключения к сети, подожди немного', 'err'); return; }
    setStatus('waiting');
    showScreen('wait');
  }

  function cancelWait() {
    setStatus('lobby');
    showScreen('lobby');
    renderLobby();
  }

  function joinGame(id) {
    if (pendingJoin) return;
    if (!requireName()) return;
    if (!client || !client.connected) { toast('Нет подключения к сети', 'err'); return; }
    publishPresence();
    pendingJoin = {
      id,
      timer: setTimeout(() => {
        pendingJoin = null;
        renderLobby();
        toast('Игрок не отвечает', 'err');
      }, JOIN_TIMEOUT),
    };
    send(id, { t: 'join', name: me.name });
    renderLobby();
  }

  // ---------- игра ----------
  function startGame(oppId, oppName, firstId) {
    game = {
      oppId, oppName, firstId,
      round: 0,
      board: Array(9).fill(null),
      turn: null,
      over: false,
      left: false,
      oppSeenPlaying: players.get(oppId)?.status === 'playing',
      score: { me: 0, opp: 0, draw: 0 },
      nextTimer: null,
    };
    setStatus('playing');
    $('meName').textContent = me.name + ' (ты)';
    $('oppName').textContent = oppName;
    $('meScore').textContent = '0';
    $('oppScore').textContent = '0';
    $('drawScore').textContent = '0';
    $('overlay').classList.add('hidden');
    showScreen('game');
    toast(`Соперник: ${oppName}. Игра началась!`);
    startRound(1);
  }

  // Право первого хода чередуется каждый раунд
  function firstOfRound(r) {
    const other = game.firstId === me.id ? game.oppId : me.id;
    return r % 2 === 1 ? game.firstId : other;
  }

  function startRound(r) {
    clearTimeout(game.nextTimer);
    game.round = r;
    game.board = Array(9).fill(null);
    game.over = false;
    game.turn = firstOfRound(r) === me.id ? 'me' : 'opp';
    $('overlay').classList.add('hidden');
    $('roundInfo').textContent = 'Раунд ' + r;
    const wl = $('winLine');
    wl.classList.remove('show', 'x', 'o');
    buildBoard();
    updateTurn();
  }

  function buildBoard() {
    const board = $('board');
    board.innerHTML = '';
    board.classList.remove('done');
    for (let i = 0; i < 9; i++) {
      const c = document.createElement('button');
      c.className = 'cell empty';
      c.style.animationDelay = (i * 0.04) + 's';
      c.setAttribute('aria-label', 'Клетка ' + (i + 1));
      c.innerHTML = '<svg class="x ghost" viewBox="0 0 40 40"><path d="M10 10L30 30M30 10L10 30"/></svg>';
      c.addEventListener('click', () => onCellClick(i));
      board.appendChild(c);
    }
  }

  function drawMark(i, who) {
    const c = $('board').children[i];
    c.classList.remove('empty');
    c.classList.add('placed');
    c.style.animationDelay = '0s';
    c.innerHTML = who === 'me'
      ? '<svg class="x drawn" viewBox="0 0 40 40"><path d="M10 10L30 30"/><path d="M30 10L10 30"/></svg>'
      : '<svg class="o drawn" viewBox="0 0 40 40"><circle cx="20" cy="20" r="12"/></svg>';
  }

  function updateTurn() {
    const t = $('turnInfo');
    const mine = game.turn === 'me' && !game.over;
    $('board').classList.toggle('my-turn', mine);
    $('pMe').classList.toggle('active', game.turn === 'me' && !game.over);
    $('pOpp').classList.toggle('active', game.turn === 'opp' && !game.over);
    if (game.over) { t.className = 'turn'; t.textContent = ''; return; }
    if (mine) {
      t.className = 'turn mine';
      t.textContent = 'Твой ход!';
    } else {
      t.className = 'turn theirs';
      t.innerHTML = '';
      t.append('Ходит ' + game.oppName);
      const d = document.createElement('span');
      d.className = 'dots';
      t.append(d);
    }
  }

  function onCellClick(i) {
    if (!game || game.over || game.left || game.turn !== 'me' || game.board[i]) return;
    send(game.oppId, { t: 'move', round: game.round, cell: i });
    place(i, 'me');
  }

  function onOpponentMove(round, cell) {
    if (game.left) return;
    // соперник уже начал следующий раунд, а у нас ещё идёт отсчёт
    if (round === game.round + 1 && game.over) startRound(round);
    if (round !== game.round || game.over) return;
    if (game.turn !== 'opp' || !Number.isInteger(cell) || cell < 0 || cell > 8 || game.board[cell]) return;
    place(cell, 'opp');
  }

  function place(i, who) {
    game.board[i] = who;
    drawMark(i, who);
    const res = checkResult();
    if (res) return finishRound(res);
    game.turn = who === 'me' ? 'opp' : 'me';
    updateTurn();
  }

  function checkResult() {
    const b = game.board;
    for (const line of LINES) {
      const [a, c, d] = line;
      if (b[a] && b[a] === b[c] && b[a] === b[d]) return { winner: b[a], line };
    }
    if (b.every(Boolean)) return { winner: null };
    return null;
  }

  function bump(id) {
    const el = $(id);
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  function finishRound(res) {
    game.over = true;
    updateTurn();
    $('board').classList.add('done');

    if (res.winner) {
      const cells = $('board').children;
      for (const i of res.line) cells[i].classList.add('win', res.winner === 'me' ? 'wx' : 'wo');
      drawWinLine(res.line, res.winner === 'me' ? 'x' : 'o');
    }

    let icon, title, cls, sub;
    if (res.winner === 'me') {
      game.score.me++;
      $('meScore').textContent = game.score.me;
      bump('meScore');
      icon = '🏆'; title = 'Победа!'; cls = 'win';
      sub = `Победил <b></b>`;
      confetti();
    } else if (res.winner === 'opp') {
      game.score.opp++;
      $('oppScore').textContent = game.score.opp;
      bump('oppScore');
      icon = '😮'; title = 'Поражение'; cls = 'lose';
      sub = `Победил <b></b>`;
    } else {
      game.score.draw++;
      $('drawScore').textContent = game.score.draw;
      bump('drawScore');
      icon = '🤝'; title = 'Ничья!'; cls = '';
      sub = 'Никто не уступил';
    }

    setTimeout(() => {
      if (!game || game.left || !game.over) return;
      $('rIcon').textContent = icon;
      const rt = $('rTitle');
      rt.textContent = title;
      rt.className = 'r-title ' + cls;
      const rs = $('rSub');
      rs.innerHTML = sub;
      const b = rs.querySelector('b');
      if (b) b.textContent = res.winner === 'me' ? me.name : game.oppName;
      $('toLobbyBtn').classList.add('hidden');
      const nextFirst = firstOfRound(game.round + 1) === me.id ? 'ты' : game.oppName;
      $('rNext').textContent = `Счёт ${game.score.me} : ${game.score.opp}. Следующий раунд — первым ходит ${nextFirst}`;
      $('overlay').classList.remove('hidden');
    }, res.winner ? 1300 : 500);

    game.nextTimer = setTimeout(() => {
      if (game && !game.left && game.over) startRound(game.round + 1);
    }, NEXT_ROUND_DELAY + (res.winner ? 1300 : 500));
  }

  function drawWinLine(line, cls) {
    const center = (i) => [50 + (i % 3) * 100, 50 + Math.floor(i / 3) * 100];
    let [x1, y1] = center(line[0]);
    let [x2, y2] = center(line[2]);
    const dx = x2 - x1, dy = y2 - y1, len = Math.hypot(dx, dy);
    const ext = 30;
    x1 -= dx / len * ext; y1 -= dy / len * ext;
    x2 += dx / len * ext; y2 += dy / len * ext;
    const el = $('winLineEl');
    el.setAttribute('x1', x1); el.setAttribute('y1', y1);
    el.setAttribute('x2', x2); el.setAttribute('y2', y2);
    const wl = $('winLine');
    wl.classList.remove('show', 'x', 'o');
    void wl.getBoundingClientRect();
    wl.classList.add('show', cls);
  }

  function opponentLeft() {
    if (!game) return;
    game.left = true;
    clearTimeout(game.nextTimer);
    $('board').classList.remove('my-turn');
    $('pMe').classList.remove('active');
    $('pOpp').classList.remove('active');
    $('turnInfo').textContent = '';
    $('rIcon').textContent = '👋';
    const rt = $('rTitle');
    rt.textContent = 'Соперник вышел';
    rt.className = 'r-title';
    $('rSub').textContent = `${game.oppName} покинул игру`;
    $('rNext').textContent = `Итоговый счёт ${game.score.me} : ${game.score.opp}` +
      (game.score.draw ? `, ничьих: ${game.score.draw}` : '');
    $('toLobbyBtn').classList.remove('hidden');
    $('overlay').classList.remove('hidden');
    setStatus('lobby');
  }

  function leaveGame() {
    if (game && !game.left) send(game.oppId, { t: 'leave' });
    if (game) clearTimeout(game.nextTimer);
    game = null;
    $('overlay').classList.add('hidden');
    setStatus('lobby');
    showScreen('lobby');
    renderLobby();
  }

  // ---------- конфетти ----------
  function confetti() {
    const canvas = $('confetti');
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    canvas.width = innerWidth * dpr;
    canvas.height = innerHeight * dpr;
    ctx.scale(dpr, dpr);
    const colors = ['#ff5e9c', '#ff9a5e', '#3fd8ff', '#7b6cff', '#3ee89b', '#ffe066'];
    const parts = Array.from({ length: 160 }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 120,
      y: innerHeight / 2.4,
      vx: (Math.random() - 0.5) * 16,
      vy: -Math.random() * 15 - 4,
      s: Math.random() * 8 + 5,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[(Math.random() * colors.length) | 0],
    }));
    const start = performance.now();
    (function frame(t) {
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      for (const p of parts) {
        p.vy += 0.35; p.vx *= 0.99;
        p.x += p.vx; p.y += p.vy; p.r += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.r);
        ctx.fillStyle = p.c;
        ctx.fillRect(-p.s / 2, -p.s / 4, p.s, p.s / 2);
        ctx.restore();
      }
      if (t - start < 3200) requestAnimationFrame(frame);
      else ctx.clearRect(0, 0, innerWidth, innerHeight);
    })(start);
  }

  // ---------- установка ярлыка (PWA) ----------
  const ua = navigator.userAgent;
  const isIOS = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /Android/i.test(ua);
  const isInApp = /FBAN|FBAV|Instagram|Line\/|Telegram|VKClient|OKApp/i.test(ua);
  const DISMISS_KEY = 'ttt-install-dismissed';
  const DISMISS_FOR = 3 * 24 * 3600 * 1000;
  let installEvent = null;

  function isStandalone() {
    return matchMedia('(display-mode: standalone)').matches ||
      matchMedia('(display-mode: fullscreen)').matches ||
      navigator.standalone === true;
  }

  function installDismissed() {
    return Date.now() - Number(safeStorage('get', DISMISS_KEY) || 0) < DISMISS_FOR;
  }

  const SHARE_ICON = '<svg class="share-ico" viewBox="0 0 24 24"><path d="M12 3v12M7.5 7.5L12 3l4.5 4.5"/>' +
    '<path d="M8 10H6a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1h-2"/></svg>';

  function showInstall(mode) {
    if (isStandalone() || installDismissed()) return;
    const sub = $('installSub');
    const btn = $('installBtn');
    if (mode === 'prompt') {
      sub.textContent = 'Ярлык на главном экране, игра на весь экран';
      btn.classList.remove('hidden');
    } else if (mode === 'ios') {
      sub.innerHTML = isInApp
        ? 'Открой эту страницу в <b>Safari</b>, чтобы добавить ярлык'
        : `Нажми ${SHARE_ICON} <b>«Поделиться»</b>, затем <b>«На экран „Домой“»</b>`;
      btn.classList.add('hidden');
    } else {
      sub.innerHTML = 'Открой меню браузера <b>⋮</b> и выбери <b>«Добавить на главный экран»</b>';
      btn.classList.add('hidden');
    }
    $('installCard').classList.remove('hidden');
  }

  function hideInstall() {
    $('installCard').classList.add('hidden');
  }

  function setupInstall() {
    document.documentElement.classList.toggle('standalone', isStandalone());
    if (isStandalone()) return;

    // Android / Chrome / Edge / Samsung: браузер сам умеет ставить ярлык
    addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      installEvent = e;
      showInstall('prompt');
    });
    addEventListener('appinstalled', () => {
      installEvent = null;
      hideInstall();
      toast('Игра установлена! Запускай с ярлыка 🎉');
    });
    $('installBtn').addEventListener('click', async () => {
      if (!installEvent) return;
      const ev = installEvent;
      installEvent = null;
      ev.prompt();
      try {
        const { outcome } = await ev.userChoice;
        if (outcome === 'accepted') hideInstall();
      } catch (e) { /* ничего */ }
    });
    $('installClose').addEventListener('click', () => {
      safeStorage('set', DISMISS_KEY, String(Date.now()));
      hideInstall();
    });

    // iPhone / iPad: автоматической установки нет — показываем инструкцию
    if (isIOS) showInstall('ios');
    // Android-браузеры без автоматической установки (например, Firefox)
    else if (isAndroid) setTimeout(() => { if (!installEvent) showInstall('manual'); }, 4000);
  }

  // если ярлык запустили, пока открыта вкладка, — убираем баннер
  matchMedia('(display-mode: standalone)').addEventListener?.('change', (e) => {
    document.documentElement.classList.toggle('standalone', e.matches);
    if (e.matches) hideInstall();
  });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(() => {}));
  }

  // приложение с ярлыка могло долго лежать в фоне — соединение надо оживить
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !client) return;
    if (client.connected) publishPresence();
    else if (!client.reconnecting && !client.disconnecting) client.reconnect();
    renderLobby();
  });

  // ---------- запуск ----------
  $('nameInput').value = me.name;
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') createGame(); });
  $('nameInput').addEventListener('change', () => {
    const n = cleanName($('nameInput').value);
    if (n) { me.name = n; safeStorage('set', 'ttt-name', n); publishPresence(); }
  });
  $('createBtn').addEventListener('click', createGame);
  $('cancelWaitBtn').addEventListener('click', cancelWait);
  $('leaveBtn').addEventListener('click', leaveGame);
  $('toLobbyBtn').addEventListener('click', leaveGame);

  setInterval(() => { publishPresence(); renderLobby(); }, PRESENCE_EVERY);
  addEventListener('pagehide', () => {
    if (game && !game.left) send(game.oppId, { t: 'leave' });
    clearPresence();
  });

  setupInstall();
  renderLobby();
  if (typeof mqtt === 'undefined') {
    setConn('offline', 'Ошибка загрузки');
    toast('Не удалось загрузить сетевой модуль', 'err');
  } else {
    connect();
  }
})();
