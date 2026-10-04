(() => {
  'use strict';

  // ---------- настройки сети ----------
  // Своего сервера нет: каждое устройство хранит полную копию партии
  // (историю ходов) и само считает по ней доску, счёт и очередь хода.
  // Сообщения между устройствами идут через публичный MQTT-брокер по WebSocket,
  // он только пересылает их. Брокер можно переопределить параметром
  // ?broker=wss://host:port/path
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
    id: loadId(),
    name: safeStorage('get', 'ttt-name') || '',
    status: 'lobby', // lobby | waiting | playing
  };
  const players = new Map(); // id -> { name, status, game, seen }
  let client = null;
  let brokerIdx = 0;
  let pendingJoin = null;
  // Текущая партия. Хранится на обоих устройствах и переживает закрытие приложения.
  // moves — строка из номеров клеток (0–8) по порядку за все раунды.
  let game = null;

  game = loadGame();

  // ---------- утилиты ----------
  function safeStorage(op, key, val) {
    try {
      if (op === 'get') return localStorage.getItem(key);
      if (op === 'remove') return localStorage.removeItem(key);
      localStorage.setItem(key, val);
    } catch (e) { /* приватный режим */ }
    return null;
  }

  function loadId() {
    let id = safeStorage('get', 'ttt-id');
    if (!id || !/^[a-z0-9]{6,24}$/.test(id)) {
      id = uid();
      safeStorage('set', 'ttt-id', id);
    }
    return id;
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

  function ask(html, okLabel) {
    return new Promise((resolve) => {
      $('cText').innerHTML = html;
      $('cOk').textContent = okLabel || 'Да';
      $('confirm').classList.remove('hidden');
      const done = (v) => {
        $('confirm').classList.add('hidden');
        $('cOk').onclick = $('cCancel').onclick = null;
        resolve(v);
      };
      $('cOk').onclick = () => done(true);
      $('cCancel').onclick = () => done(false);
    });
  }

  function esc(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  // ---------- хранение партии ----------
  function newGame(id, oppId, oppName, firstId) {
    return { id, oppId, oppName, firstId, moves: '', oppState: 'offline', ui: freshUi() };
  }

  function freshUi() {
    return { round: 0, finished: 0, advanced: 0, lineRound: 0, nextTimer: null, overlayTimer: null, score: null, openedAt: Date.now() };
  }

  function loadGame() {
    try {
      const g = JSON.parse(safeStorage('get', 'ttt-game') || 'null');
      if (!g || typeof g.id !== 'string' || typeof g.oppId !== 'string' || typeof g.firstId !== 'string') return null;
      const res = newGame(g.id, g.oppId, cleanName(g.oppName) || 'Игрок', g.firstId);
      res.moves = sanitizeMoves(res, g.moves);
      return res;
    } catch (e) {
      return null;
    }
  }

  function saveGame() {
    if (!game) return;
    const { id, oppId, oppName, firstId, moves } = game;
    safeStorage('set', 'ttt-game', JSON.stringify({ id, oppId, oppName, firstId, moves }));
  }

  function endedList() {
    try { return JSON.parse(safeStorage('get', 'ttt-ended') || '[]'); } catch (e) { return []; }
  }

  function dropGame() {
    if (!game) return;
    clearTimeout(game.ui.nextTimer);
    clearTimeout(game.ui.overlayTimer);
    const ended = endedList().filter((x) => x !== game.id);
    ended.push(game.id);
    safeStorage('set', 'ttt-ended', JSON.stringify(ended.slice(-30)));
    safeStorage('remove', 'ttt-game');
    game = null;
  }

  // ---------- правила: состояние считается из истории ходов ----------
  function otherId(id) { return id === me.id ? game.oppId : me.id; }

  // Право первого хода чередуется каждый раунд
  function firstOfRound(r) {
    return r % 2 === 1 ? game.firstId : otherId(game.firstId);
  }

  function moverOf(r, k) {
    const first = firstOfRound(r);
    return (k % 2 === 0 ? first : otherId(first)) === me.id ? 'me' : 'opp';
  }

  function checkBoard(b) {
    for (const line of LINES) {
      const [a, c, d] = line;
      if (b[a] && b[a] === b[c] && b[a] === b[d]) return { winner: b[a], line };
    }
    if (b.every(Boolean)) return { winner: null };
    return null;
  }

  function replay(moves, g) {
    const saved = game;
    if (g) game = g;
    const s = { round: 1, board: Array(9).fill(null), score: { me: 0, opp: 0, draw: 0 }, over: false, result: null, valid: 0 };
    let start = 0;
    for (let i = 0; i < moves.length; i++) {
      if (s.over) {
        s.round++;
        s.board = Array(9).fill(null);
        s.over = false;
        s.result = null;
        start = i;
      }
      const cell = moves.charCodeAt(i) - 48;
      if (!(cell >= 0 && cell <= 8) || s.board[cell]) break;
      s.board[cell] = moverOf(s.round, i - start);
      s.valid = i + 1;
      const res = checkBoard(s.board);
      if (res) {
        s.over = true;
        s.result = res;
        if (res.winner) s.score[res.winner]++;
        else s.score.draw++;
      }
    }
    s.turn = s.over ? null : moverOf(s.round, s.valid - start);
    game = saved;
    return s;
  }

  function sanitizeMoves(g, moves) {
    moves = typeof moves === 'string' ? moves.replace(/[^0-8]/g, '').slice(0, 5000) : '';
    return moves.slice(0, replay(moves, g).valid);
  }

  // Две копии одной партии: берём более полную. Ходить может только тот,
  // чья очередь, поэтому одна копия всегда продолжение другой.
  function mergeMoves(a, b) {
    if (a === b || a.startsWith(b)) return a;
    if (b.startsWith(a)) return b;
    if (a.length !== b.length) return a.length > b.length ? a : b;
    return a < b ? a : b; // одинаковое правило на обоих устройствах
  }

  // что показывать: после конца раунда и паузы — уже пустое поле следующего
  function view(s) {
    if (s.over && game.ui.advanced === s.round) {
      return { round: s.round + 1, board: Array(9).fill(null), over: false, result: null, score: s.score, turn: moverOf(s.round + 1, 0) };
    }
    return s;
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
    const ms = $('meState');
    ms.className = 'opp-state ' + (state === 'online' ? 'ingame' : state === 'offline' ? 'offline' : 'lobby');
    ms.textContent = state === 'online' ? 'в сети' : state === 'offline' ? 'нет связи' : 'подключение…';
  }

  function connect() {
    const url = BROKERS[brokerIdx];
    setConn('connecting', 'Подключение…');
    let everConnected = false;
    let switched = false;
    client = mqtt.connect(url, {
      // id игрока постоянный, а id соединения — свой у каждой вкладки
      clientId: 'ttt_' + me.id + '_' + uid().slice(0, 6),
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
      if (game) sendState();
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
    if (!client || !client.connected) return;
    msg.from = me.id;
    client.publish(topic.inbox(id), JSON.stringify(msg), { qos: 1 });
  }

  function sendState() {
    if (!game) return;
    send(game.oppId, { t: 'state', game: game.id, moves: game.moves, first: game.firstId, name: me.name });
  }

  function publishPresence() {
    if (!client || !client.connected) return;
    const payload = JSON.stringify({
      name: me.name || 'Игрок',
      status: me.status,
      game: game ? game.id : null,
      ts: Date.now(),
    });
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
      if (id === me.id) return;
      if (!text) {
        players.delete(id);
      } else {
        let p;
        try { p = JSON.parse(text); } catch (e) { return; }
        // для сохранённых (retained) сообщений доверяем метке времени отправителя
        const seen = packet.retain ? Number(p.ts) || 0 : Date.now();
        players.set(id, { name: cleanName(p.name) || 'Игрок', status: p.status, game: p.game || null, seen });
      }
      refreshOpp();
      renderLobby();
      return;
    }
    if (t === topic.inbox(me.id)) {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (msg && typeof msg.from === 'string') handleDirect(msg);
    }
  }

  function handleDirect(msg) {
    switch (msg.t) {
      case 'join': {
        if (me.status === 'waiting' && !game) {
          const first = Math.random() < 0.5 ? me.id : msg.from;
          const id = uid();
          game = newGame(id, msg.from, cleanName(msg.name) || 'Игрок', first);
          saveGame();
          send(msg.from, { t: 'accept', game: id, name: me.name, first });
          toast(`Соперник: ${game.oppName}. Игра началась!`);
          openGame(true);
        } else {
          send(msg.from, { t: 'busy' });
        }
        break;
      }
      case 'accept': {
        if (!pendingJoin || pendingJoin.id !== msg.from || game || typeof msg.game !== 'string') {
          // соперник принял, а мы уже передумали — сообщаем ему
          if (typeof msg.game === 'string') send(msg.from, { t: 'end', game: msg.game });
          return;
        }
        clearTimeout(pendingJoin.timer);
        pendingJoin = null;
        const first = msg.first === me.id ? me.id : msg.from;
        game = newGame(msg.game, msg.from, cleanName(msg.name) || 'Игрок', first);
        saveGame();
        toast(`Соперник: ${game.oppName}. Игра началась!`);
        openGame(true);
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
      case 'state': {
        if (!game || msg.game !== game.id || msg.from !== game.oppId) {
          // партия уже завершена у нас — напоминаем сопернику
          if (endedList().includes(msg.game)) send(msg.from, { t: 'end', game: msg.game });
          return;
        }
        onState(msg);
        break;
      }
      case 'end': {
        if (game && msg.game === game.id && msg.from === game.oppId) opponentEnded();
        break;
      }
    }
  }

  function onState(msg) {
    const name = cleanName(msg.name);
    if (name && name !== game.oppName) {
      game.oppName = name;
      saveGame();
      updateNames();
    }
    const theirs = sanitizeMoves(game, msg.moves);
    const merged = mergeMoves(game.moves, theirs);
    if (merged !== game.moves) {
      game.moves = merged;
      saveGame();
      if (me.status === 'playing') render(true);
    }
    // у соперника копия отстаёт — отправляем ему свою
    if (merged !== theirs) sendState();
    renderLobby();
  }

  // ---------- соперник: в игре / в лобби / не в сети ----------
  function oppStateNow() {
    const p = players.get(game.oppId);
    if (!p || Date.now() - p.seen > PRESENCE_TTL) return 'offline';
    return p.status === 'playing' && p.game === game.id ? 'ingame' : 'lobby';
  }

  const OPP_TEXT = { ingame: 'в игре', lobby: 'в лобби', offline: 'не в сети' };

  function refreshOpp() {
    if (!game) return;
    const p = players.get(game.oppId);
    if (p && p.name && p.name !== game.oppName && p.name !== 'Игрок') {
      game.oppName = p.name;
      saveGame();
      updateNames();
    }
    const prev = game.oppState;
    const now = oppStateNow();
    game.oppState = now;
    // сразу после открытия список игроков ещё догружается — не шумим уведомлениями
    const settled = Date.now() - game.ui.openedAt > 4000;
    if (prev !== now) {
      if (now === 'ingame') {
        sendState(); // соперник вернулся — отдаём ему свою копию партии
        if (me.status === 'playing' && settled) toast(`${game.oppName} снова в игре!`);
      } else if (prev === 'ingame' && me.status === 'playing' && settled) {
        toast(now === 'offline'
          ? `${game.oppName}: нет связи. Игра сохранена — продолжите, когда соперник вернётся`
          : `${game.oppName} сейчас в лобби. Игра сохранена`);
      }
    }
    const el = $('oppState');
    el.className = 'opp-state ' + now;
    el.textContent = OPP_TEXT[now];
    if (me.status === 'playing') render(false);
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
    let online = 1;
    const waiting = [];
    for (const [id, p] of players) {
      if (now - p.seen > PRESENCE_TTL) continue;
      online++;
      if (p.status === 'waiting') waiting.push([id, p]);
    }
    waiting.sort((a, b) => a[1].name.localeCompare(b[1].name));
    $('onlineCount').textContent = 'онлайн: ' + (client && client.connected ? online : 0);

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
    $('lobbyEmpty').classList.toggle('hidden', waiting.length !== 0);

    // карточка незаконченной партии
    const card = $('resumeCard');
    card.classList.toggle('hidden', !game);
    if (game) {
      const s = replay(game.moves);
      $('resumeSub').innerHTML = `Соперник: <b>${esc(game.oppName)}</b> · счёт ${s.score.me} : ${s.score.opp}` +
        (s.score.draw ? ` · ничьих ${s.score.draw}` : '');
      const st = $('resumeState');
      const os = oppStateNow();
      st.className = 'opp-state ' + os;
      st.textContent = os === 'ingame' ? `${game.oppName} в игре и ждёт тебя` : `${game.oppName} ${OPP_TEXT[os]}`;
    }
  }

  async function confirmDropSaved() {
    if (!game) return true;
    const ok = await ask(`У тебя есть незаконченная игра (соперник: <b>${esc(game.oppName)}</b>).<br>Завершить её и начать новую?`, 'Завершить');
    if (ok) endGameByMe();
    return ok;
  }

  async function createGame() {
    if (!requireName()) return;
    if (!client || !client.connected) { toast('Нет подключения к сети, подожди немного', 'err'); return; }
    if (!(await confirmDropSaved())) return;
    setStatus('waiting');
    showScreen('wait');
  }

  function cancelWait() {
    setStatus('lobby');
    showScreen('lobby');
    renderLobby();
  }

  async function joinGame(id) {
    if (pendingJoin) return;
    if (!requireName()) return;
    if (!client || !client.connected) { toast('Нет подключения к сети', 'err'); return; }
    if (!(await confirmDropSaved())) return;
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
  function updateNames() {
    if (!game) return;
    $('meName').textContent = (me.name || 'Ты') + ' (ты)';
    $('oppName').textContent = game.oppName;
  }

  function openGame(isNew) {
    if (!game) return;
    game.ui = freshUi();
    game.oppState = oppStateNow();
    me.status = 'playing';
    publishPresence();
    sendState();
    updateNames();
    $('overlay').classList.add('hidden');
    showScreen('game');
    refreshOpp();
    render(isNew);
  }

  function pauseGame() {
    if (game) {
      clearTimeout(game.ui.nextTimer);
      clearTimeout(game.ui.overlayTimer);
    }
    $('overlay').classList.add('hidden');
    setStatus('lobby');
    showScreen('lobby');
    renderLobby();
  }

  function endGameByMe() {
    if (!game) return;
    send(game.oppId, { t: 'end', game: game.id });
    dropGame();
    publishPresence();
  }

  async function endGameClick() {
    if (!game) return;
    const s = replay(game.moves);
    const ok = await ask(`Завершить игру? Соперник: <b>${esc(game.oppName)}</b>.<br>Счёт ${s.score.me} : ${s.score.opp} — продолжить её будет нельзя.`, 'Завершить');
    if (!ok || !game) return;
    endGameByMe();
    pauseGame();
  }

  function opponentEnded() {
    const s = replay(game.moves);
    const name = game.oppName;
    const wasPlaying = me.status === 'playing';
    dropGame();
    publishPresence();
    if (!wasPlaying) {
      toast(`Соперник ${name} завершил вашу игру`);
      renderLobby();
      return;
    }
    $('board').classList.remove('my-turn');
    $('pMe').classList.remove('active');
    $('pOpp').classList.remove('active');
    $('turnInfo').textContent = '';
    $('rIcon').textContent = '👋';
    const rt = $('rTitle');
    rt.textContent = 'Игра завершена';
    rt.className = 'r-title';
    $('rSub').textContent = `Соперник ${name} завершил игру`;
    $('rNext').textContent = `Итоговый счёт ${s.score.me} : ${s.score.opp}` +
      (s.score.draw ? `, ничьих: ${s.score.draw}` : '');
    $('toLobbyBtn').classList.remove('hidden');
    $('overlay').classList.remove('hidden');
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
    const wl = $('winLine');
    wl.classList.remove('show', 'x', 'o');
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

  function bump(id) {
    const el = $(id);
    el.classList.remove('bump');
    void el.offsetWidth;
    el.classList.add('bump');
  }

  // Перерисовка игры по истории ходов. live = изменение произошло только что
  // (ход, синхронизация), а не при открытии сохранённой партии.
  function render(live) {
    if (!game || me.status !== 'playing') return;
    const ui = game.ui;
    const s = replay(game.moves);

    if (s.over && ui.finished !== s.round) {
      ui.finished = s.round;
      if (live) roundFinished(s);
      else ui.advanced = s.round;
    }
    const d = view(s);

    if (d.round !== ui.round) {
      clearTimeout(ui.nextTimer);
      clearTimeout(ui.overlayTimer);
      $('overlay').classList.add('hidden');
      ui.round = d.round;
      buildBoard();
    }
    const cells = $('board').children;
    d.board.forEach((who, i) => {
      if (who && cells[i].classList.contains('empty')) drawMark(i, who);
    });
    if (d.over && ui.lineRound !== d.round) {
      ui.lineRound = d.round;
      $('board').classList.add('done');
      if (d.result.winner) {
        for (const i of d.result.line) cells[i].classList.add('win', d.result.winner === 'me' ? 'wx' : 'wo');
        drawWinLine(d.result.line, d.result.winner === 'me' ? 'x' : 'o');
      }
    }

    // счёт
    const sc = d.score;
    if (ui.score) {
      if (sc.me !== ui.score.me) bump('meScore');
      if (sc.opp !== ui.score.opp) bump('oppScore');
      if (sc.draw !== ui.score.draw) bump('drawScore');
    }
    ui.score = { ...sc };
    $('meScore').textContent = sc.me;
    $('oppScore').textContent = sc.opp;
    $('drawScore').textContent = sc.draw;
    $('roundInfo').textContent = 'Раунд ' + d.round;
    updateTurn(d);
  }

  function roundFinished(s) {
    const ui = game.ui;
    const r = s.round;
    const winner = s.result.winner;
    let icon, title, cls, sub;
    if (winner === 'me') {
      icon = '🏆'; title = 'Победа!'; cls = 'win'; sub = 'Победитель: <b></b>';
      confetti();
    } else if (winner === 'opp') {
      icon = '😮'; title = 'Поражение'; cls = 'lose'; sub = 'Победитель: <b></b>';
    } else {
      icon = '🤝'; title = 'Ничья!'; cls = ''; sub = 'Никто не уступил';
    }
    const delay = winner ? 1300 : 500;
    ui.overlayTimer = setTimeout(() => {
      if (!game || game.ui !== ui || ui.round !== r || ui.advanced === r) return;
      $('rIcon').textContent = icon;
      const rt = $('rTitle');
      rt.textContent = title;
      rt.className = 'r-title ' + cls;
      const rs = $('rSub');
      rs.innerHTML = sub;
      const b = rs.querySelector('b');
      if (b) b.textContent = winner === 'me' ? me.name : game.oppName;
      $('toLobbyBtn').classList.add('hidden');
      const nextFirst = moverOf(r + 1, 0) === 'me' ? 'ты' : game.oppName;
      $('rNext').textContent = `Счёт ${s.score.me} : ${s.score.opp}. Следующий раунд — первым ходит ${nextFirst}`;
      $('overlay').classList.remove('hidden');
    }, delay);
    ui.nextTimer = setTimeout(() => {
      if (!game || game.ui !== ui || ui.finished !== r) return;
      ui.advanced = r;
      render(false);
    }, NEXT_ROUND_DELAY + delay);
  }

  function updateTurn(d) {
    const t = $('turnInfo');
    const mine = d.turn === 'me' && !d.over;
    $('board').classList.toggle('my-turn', mine);
    $('pMe').classList.toggle('active', mine);
    $('pOpp').classList.toggle('active', d.turn === 'opp' && !d.over);
    if (d.over) { t.className = 'turn'; t.textContent = ''; return; }
    if (mine) {
      t.className = 'turn mine';
      t.textContent = 'Твой ход!';
      return;
    }
    t.className = 'turn theirs';
    t.innerHTML = '';
    const os = game.oppState;
    t.append(os === 'ingame' ? 'Ходит ' + game.oppName
      : os === 'lobby' ? `${game.oppName} в лобби — ждём возвращения`
        : `${game.oppName} не в сети — ждём возвращения`);
    const dots = document.createElement('span');
    dots.className = 'dots';
    t.append(dots);
  }

  function onCellClick(i) {
    if (!game || me.status !== 'playing') return;
    const d = view(replay(game.moves));
    if (d.over || d.turn !== 'me' || d.board[i]) return;
    game.moves += String(i);
    saveGame();
    sendState();
    render(true);
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
    if (client.connected) {
      publishPresence();
      if (game) sendState();
    } else if (!client.reconnecting && !client.disconnecting) client.reconnect();
    renderLobby();
  });


  // ---------- запуск ----------
  $('nameInput').value = me.name;
  $('nameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') createGame(); });
  $('nameInput').addEventListener('change', () => {
    const n = cleanName($('nameInput').value);
    if (n) {
      me.name = n;
      safeStorage('set', 'ttt-name', n);
      publishPresence();
      if (game) sendState();
    }
  });
  $('createBtn').addEventListener('click', createGame);
  $('cancelWaitBtn').addEventListener('click', cancelWait);
  $('leaveBtn').addEventListener('click', pauseGame);
  $('toLobbyBtn').addEventListener('click', pauseGame);
  $('endBtn').addEventListener('click', endGameClick);
  $('resumeBtn').addEventListener('click', () => openGame(false));
  $('resumeEndBtn').addEventListener('click', async () => {
    if (!game) return;
    const ok = await ask(`Завершить игру? Соперник: <b>${esc(game.oppName)}</b>.<br>Продолжить её будет нельзя.`, 'Завершить');
    if (ok && game) { endGameByMe(); renderLobby(); }
  });

  setInterval(() => { publishPresence(); refreshOpp(); renderLobby(); }, PRESENCE_EVERY);
  addEventListener('pagehide', clearPresence);

  setupInstall();
  setConn('connecting', 'Подключение…');
  // незаконченная партия — сразу возвращаемся в неё
  if (game) openGame(false);
  renderLobby();
  if (typeof mqtt === 'undefined') {
    setConn('offline', 'Ошибка загрузки');
    toast('Не удалось загрузить сетевой модуль', 'err');
  } else {
    connect();
  }
})();
