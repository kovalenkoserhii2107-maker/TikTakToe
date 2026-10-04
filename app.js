(() => {
  'use strict';

  // ---------- настройки сети ----------
  // Своего сервера нет: каждое устройство хранит полную копию партии —
  // журнал событий (ходы, вход и выход игроков) — и само считает по нему
  // доску, очки, очередь и кто сейчас за столом. Сообщения между устройствами
  // идут через публичный MQTT-брокер по WebSocket, он только пересылает их.
  // Брокер можно переопределить параметром ?broker=wss://host:port/path
  const PREFIX = 'tiktaktoe-ks/v2';
  const params = new URLSearchParams(location.search);
  const BROKERS = params.get('broker')
    ? [params.get('broker')]
    : ['wss://broker.emqx.io:8084/mqtt', 'wss://broker.hivemq.com:8884/mqtt'];
  const PRESENCE_EVERY = 20000;   // как часто обновлять своё присутствие
  const PRESENCE_TTL = 75000;     // через сколько считать игрока пропавшим
  const NEXT_ROUND_DELAY = 3500;
  const JOIN_TIMEOUT = 12000;
  const MAX_PLAYERS = 3;
  const PTS_WIN = 2;
  const PTS_DRAW = 1;
  const STORE_KEY = 'ttt-game2';

  const LINES = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
  const ID_RE = /^[a-z0-9]{6,24}$/;
  const TOKEN_RE = /^(?:[0-8]|[+-][a-z0-9]{6,24})$/;
  const X_SVG = '<svg viewBox="0 0 40 40"><path d="M11 11L29 29M29 11L11 29"/></svg>';
  const O_SVG = '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="10"/></svg>';

  const $ = (id) => document.getElementById(id);
  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

  const me = {
    id: loadId(),
    name: safeStorage('get', 'ttt-name') || '',
    status: 'lobby', // lobby | waiting | playing
  };
  const players = new Map(); // id -> { name, status, game, members, names, seen }
  let client = null;
  let brokerIdx = 0;
  let pendingJoin = null;
  // Текущая партия: { id, log: [...события], names: {id: имя}, pending: [...], ms: {id: статус}, ui }
  // log: '0'–'8' — ход в клетку, '+id' — игрок вошёл, '-id' — игрок вышел.
  let game = null;
  safeStorage('remove', 'ttt-game'); // партии прежней версии несовместимы
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
    if (!id || !ID_RE.test(id)) {
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
    setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3400);
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

  function avatarBg(id) {
    const h = hueOf(id);
    return `linear-gradient(135deg, hsl(${h} 85% 62%), hsl(${(h + 50) % 360} 85% 52%))`;
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

  function nameOf(id) {
    if (id === me.id) return me.name || 'Ты';
    return (game && game.names[id]) || (players.get(id) || {}).name || 'Игрок';
  }

  function listNames(ids) {
    const n = ids.map(nameOf);
    return n.length > 1 ? n.slice(0, -1).join(', ') + ' и ' + n[n.length - 1] : (n[0] || '');
  }

  // ---------- хранение партии ----------
  function makeGame(id, log, names) {
    return { id, log, names: names || {}, pending: [], ms: {}, ui: freshUi() };
  }

  function freshUi() {
    return { round: -1, finished: 0, advanced: 0, lineRound: 0, nextTimer: null, overlayTimer: null,
      pts: null, members: null, openedAt: Date.now() };
  }

  function sanitizeLog(log) {
    if (!Array.isArray(log)) return [];
    const out = [];
    for (const t of log.slice(0, 20000)) {
      if (typeof t !== 'string' || !TOKEN_RE.test(t)) break;
      out.push(t);
    }
    return out.slice(0, replay(out).valid);
  }

  function sanitizeNames(n) {
    const res = {};
    if (n && typeof n === 'object') {
      for (const [k, v] of Object.entries(n)) if (ID_RE.test(k)) res[k] = cleanName(v) || 'Игрок';
    }
    return res;
  }

  function loadGame() {
    try {
      const g = JSON.parse(safeStorage('get', STORE_KEY) || 'null');
      if (!g || typeof g.id !== 'string') return null;
      const res = makeGame(g.id, sanitizeLog(g.log), sanitizeNames(g.names));
      // без соперника партия не начиналась — нечего восстанавливать
      if (replay(res.log).players.length < 2 || !replay(res.log).players.includes(me.id)) {
        safeStorage('remove', STORE_KEY);
        return null;
      }
      return res;
    } catch (e) {
      return null;
    }
  }

  function saveGame() {
    if (!game) return;
    safeStorage('set', STORE_KEY, JSON.stringify({ id: game.id, log: game.log, names: game.names }));
  }

  function dropGame() {
    if (!game) return;
    clearTimeout(game.ui.nextTimer);
    clearTimeout(game.ui.overlayTimer);
    safeStorage('remove', STORE_KEY);
    game = null;
  }

  // ---------- правила: всё состояние считается из журнала ----------
  function other(pair, id) { return pair[0] === id ? pair[1] : pair[0]; }

  // Кто сядет за стол в следующем раунде и кто ходит первым.
  // Победитель остаётся, проигравший уступает место ожидающему.
  // При ничьей уходит тот, кто дольше сидит за столом. Новичок ходит первым.
  function nextSetup(st) {
    const P = st.players;
    if (P.length < 2) return null;
    if (!st.pair) return { pair: [P[0], P[1]], first: P[1] };
    const prev = st.pair.filter((id) => P.includes(id));
    const waiting = P.filter((id) => !prev.includes(id));
    if (prev.length === 2) {
      if (!waiting.length) {
        // те же двое — право первого хода переходит к другому
        return { pair: prev, first: other(prev, st.first) };
      }
      let out;
      const w = st.result && st.result.winner;
      if (w) out = other(prev, w);
      else {
        const [a, b] = prev;
        out = st.since[a] < st.since[b] ? a : st.since[b] < st.since[a] ? b : st.first;
      }
      const inn = waiting[0];
      return { pair: [other(prev, out), inn], first: inn };
    }
    if (prev.length === 1) {
      const inn = waiting[0];
      return { pair: [prev[0], inn], first: inn };
    }
    return { pair: [waiting[0], waiting[1]], first: waiting[1] };
  }

  function moverOf(st) {
    return st.k % 2 === 0 ? st.first : other(st.pair, st.first);
  }

  function checkBoard(b) {
    for (const line of LINES) {
      const [a, c, d] = line;
      if (b[a] && b[a] === b[c] && b[a] === b[d]) return { winner: b[a], line };
    }
    if (b.every(Boolean)) return { winner: null };
    return null;
  }

  function replay(log) {
    const st = {
      players: [], pair: null, first: null, board: Array(9).fill(null), k: 0,
      round: 0, over: true, result: null, since: {}, pts: {}, wins: {}, draws: {}, order: {}, valid: 0, seq: 0,
    };
    const startRound = () => {
      const nx = nextSetup(st);
      if (!nx) return false;
      st.round++;
      // запоминаем, с какого раунда игрок сидит за столом
      for (const id of nx.pair) if (!st.pair || !st.pair.includes(id)) st.since[id] = st.round;
      st.pair = nx.pair;
      st.first = nx.first;
      st.board = Array(9).fill(null);
      st.k = 0;
      st.over = false;
      st.result = null;
      return true;
    };
    for (let i = 0; i < log.length; i++) {
      const t = log[i];
      if (t[0] === '+') {
        const id = t.slice(1);
        if (st.players.includes(id) || st.players.length >= MAX_PLAYERS) break;
        if (!st.players.length && i !== 0) break;
        st.players.push(id);
        if (!(id in st.pts)) { st.pts[id] = 0; st.wins[id] = 0; st.draws[id] = 0; st.order[id] = st.seq++; }
      } else if (t[0] === '-') {
        const id = t.slice(1);
        if (!st.players.includes(id)) break;
        st.players = st.players.filter((x) => x !== id);
        if (st.pair && st.pair.includes(id) && !st.over) {
          // игрок ушёл посреди раунда — раунд не засчитывается
          st.over = true;
          st.result = { aborted: true };
        }
      } else {
        if (st.over && !startRound()) break;
        const cell = +t;
        if (st.board[cell]) break;
        const who = moverOf(st);
        st.board[cell] = who;
        st.k++;
        const res = checkBoard(st.board);
        if (res) {
          st.over = true;
          st.result = res;
          if (res.winner) {
            st.pts[res.winner] += PTS_WIN;
            st.wins[res.winner]++;
          } else {
            for (const id of st.pair) { st.pts[id] += PTS_DRAW; st.draws[id]++; }
          }
        }
      }
      st.valid = i + 1;
    }
    return st;
  }

  // Писать в журнал в каждый момент может ровно один игрок — тот, чей ход
  // (а между раундами — тот, кто ходит первым в следующем). Поэтому копии
  // журнала на разных устройствах всегда продолжают друг друга.
  function appenderOf(st) {
    if (st.players.length < 2) return st.players[0] || null;
    if (!st.over && st.pair) return moverOf(st);
    const nx = nextSetup(st);
    return nx ? nx.first : null;
  }

  function mergeLogs(a, b) {
    const n = Math.min(a.length, b.length);
    let i = 0;
    while (i < n && a[i] === b[i]) i++;
    if (i === n) return a.length >= b.length ? a : b;
    if (a.length !== b.length) return a.length > b.length ? a : b;
    return JSON.stringify(a) < JSON.stringify(b) ? a : b; // одинаковое правило на всех устройствах
  }

  // Что показывать: текущий раунд или (после паузы) уже следующий.
  function view(st) {
    const ui = game.ui;
    if (st.over && (st.round === 0 || st.result?.aborted || ui.advanced === st.round)) {
      const nx = nextSetup(st);
      if (!nx) return { round: st.round, pair: null, board: Array(9).fill(null), over: false, waitingPlayers: true };
      return { round: st.round + 1, pair: nx.pair, first: nx.first, board: Array(9).fill(null), over: false, result: null, turn: nx.first };
    }
    return { round: st.round, pair: st.pair, first: st.first, board: st.board, over: st.over, result: st.result, turn: st.over ? null : moverOf(st) };
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
    if (!client || !client.connected || id === me.id) return;
    msg.from = me.id;
    client.publish(topic.inbox(id), JSON.stringify(msg), { qos: 1 });
  }

  function stateMsg() {
    return { t: 'state', game: game.id, log: game.log, names: { ...game.names, [me.id]: me.name || 'Игрок' } };
  }

  // отправить свою копию партии всем участникам (или одному)
  function sendState(to) {
    if (!game) return;
    const ids = to ? [to] : replay(game.log).players;
    for (const id of ids) send(id, stateMsg());
  }

  function publishPresence() {
    if (!client || !client.connected) return;
    const members = game ? replay(game.log).players : [];
    const payload = JSON.stringify({
      name: me.name || 'Игрок',
      status: me.status,
      game: game ? game.id : null,
      members,
      names: members.map(nameOf),
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
        const members = Array.isArray(p.members) ? p.members.filter((x) => typeof x === 'string' && ID_RE.test(x)).slice(0, MAX_PLAYERS) : [];
        const names = Array.isArray(p.names) ? p.names.slice(0, MAX_PLAYERS).map((x) => cleanName(x) || 'Игрок') : [];
        players.set(id, { name: cleanName(p.name) || 'Игрок', status: p.status, game: typeof p.game === 'string' ? p.game : null, members, names, seen });
      }
      refreshMembers();
      renderLobby();
      return;
    }
    if (t === topic.inbox(me.id)) {
      let msg;
      try { msg = JSON.parse(text); } catch (e) { return; }
      if (msg && typeof msg.from === 'string' && ID_RE.test(msg.from)) handleDirect(msg);
    }
  }

  function handleDirect(msg) {
    switch (msg.t) {
      case 'join': {
        // кто-то просится в нашу партию (вторым или третьим)
        if (!game || msg.game !== game.id) { send(msg.from, { t: 'busy', game: msg.game }); return; }
        const st = replay(game.log);
        if (st.players.includes(msg.from)) { sendState(msg.from); return; }
        if (st.players.length >= MAX_PLAYERS) { send(msg.from, { t: 'busy', game: msg.game }); return; }
        if (!game.pending.some((op) => op.op === '+' && op.id === msg.from)) {
          game.pending.push({ op: '+', id: msg.from, name: cleanName(msg.name) || 'Игрок' });
        }
        flushPending();
        break;
      }
      case 'busy': {
        if (pendingJoin && pendingJoin.game === msg.game) {
          clearTimeout(pendingJoin.timer);
          pendingJoin = null;
          renderLobby();
          toast('В этой игре уже нет мест', 'err');
        }
        break;
      }
      case 'state': {
        onState(msg);
        break;
      }
      case 'leave':
      case 'gone': {
        // игрок покинул партию (или давно вышел, а мы не знали)
        if (!game || msg.game !== game.id) return;
        const st = replay(game.log);
        if (!st.players.includes(msg.from)) return;
        if (st.players.length <= 2) { partyEnded(msg.from); return; }
        if (!game.pending.some((op) => op.op === '-' && op.id === msg.from)) game.pending.push({ op: '-', id: msg.from });
        flushPending();
        break;
      }
      case 'end': {
        if (game && msg.game === game.id && replay(game.log).players.includes(msg.from)) partyEnded(msg.from);
        break;
      }
    }
  }

  function onState(msg) {
    if (typeof msg.game !== 'string') return;
    const theirs = sanitizeLog(msg.log);
    const theirPlayers = replay(theirs).players;
    const names = sanitizeNames(msg.names);

    if (!game || game.id !== msg.game) {
      // нас приняли в игру, куда мы просились
      if (pendingJoin && pendingJoin.game === msg.game && theirPlayers.includes(me.id) && !game) {
        clearTimeout(pendingJoin.timer);
        pendingJoin = null;
        game = makeGame(msg.game, theirs, names);
        delete game.names[me.id];
        saveGame();
        toast(`Ты в игре! Игроки: ${listNames(theirPlayers.filter((x) => x !== me.id))}`);
        openGame(true);
        return;
      }
      // нас считают участником партии, которой у нас уже нет
      if (theirPlayers.includes(me.id)) send(msg.from, { t: 'gone', game: msg.game });
      return;
    }
    const before = replay(game.log);
    if (!before.players.includes(msg.from) && !theirPlayers.includes(msg.from)) return;
    for (const [id, n] of Object.entries(names)) if (id !== me.id) game.names[id] = n;
    const merged = mergeLogs(game.log, theirs);
    if (merged !== game.log) {
      game.log = merged;
      afterLogChange(before, true);
    }
    // у отправителя копия отстаёт — отправляем ему свою (сравниваем содержимое, иначе пинг-понг)
    if (game && JSON.stringify(merged) !== JSON.stringify(theirs)) sendState(msg.from);
    if (game) { refreshMembers(); renderLobby(); }
  }

  // Применить отложенные изменения состава, если сейчас наша очередь писать в журнал.
  function flushPending() {
    if (!game || !game.pending.length) return;
    const before = replay(game.log);
    let changed = false;
    for (let guard = 0; guard < 10 && game.pending.length; guard++) {
      const st = replay(game.log);
      if (appenderOf(st) !== me.id) break;
      const op = game.pending.shift();
      if (op.op === '+') {
        if (st.players.includes(op.id)) continue;
        if (st.players.length >= MAX_PLAYERS) { send(op.id, { t: 'busy', game: game.id }); continue; }
        game.log = [...game.log, '+' + op.id];
        game.names[op.id] = op.name;
      } else {
        if (!st.players.includes(op.id)) continue;
        game.log = [...game.log, '-' + op.id];
      }
      changed = true;
    }
    if (changed) {
      afterLogChange(before, true);
      sendState();
      // ушедшему тоже сообщаем, что его выход учтён
    }
  }

  // Журнал изменился: сохранить, объявить новичков/ушедших, перерисовать.
  function afterLogChange(before, live) {
    const st = replay(game.log);
    if (!st.players.includes(me.id)) { dropGame(); showScreen('lobby'); setStatus('lobby'); renderLobby(); return; }
    saveGame();
    const joined = st.players.filter((id) => !before.players.includes(id) && id !== me.id);
    const left = before.players.filter((id) => !st.players.includes(id) && id !== me.id);
    if (me.status === 'waiting' && st.players.length >= 2) {
      toast(`Соперник: ${nameOf(joined[0] || st.players.find((x) => x !== me.id))}. Игра началась!`);
      openGame(true);
      sendState();
      return;
    }
    if (st.players.length < 2) { partyEnded(left[0]); return; }
    for (const id of joined) {
      if (before.players.length >= 2) toast(`${nameOf(id)} присоединяется! Сыграет с победителем раунда`);
    }
    for (const id of left) toast(`${nameOf(id)} покидает игру`);
    if (joined.length || left.length) publishPresence();
    if (me.status === 'playing') render(live);
    flushPending();
  }

  // ---------- участники: в игре / в лобби / не в сети ----------
  function memberState(id) {
    if (id === me.id) return client && client.connected ? 'ingame' : 'offline';
    const p = players.get(id);
    if (!p || Date.now() - p.seen > PRESENCE_TTL) return 'offline';
    return p.status === 'playing' && p.game === game.id ? 'ingame' : 'lobby';
  }

  const STATE_TEXT = { ingame: 'в игре', lobby: 'в лобби', offline: 'не в сети' };

  function refreshMembers() {
    if (!game) return;
    const st = replay(game.log);
    const settled = Date.now() - game.ui.openedAt > 4000;
    for (const id of st.players) {
      if (id === me.id) continue;
      const p = players.get(id);
      if (p && p.name && p.name !== 'Игрок' && p.name !== game.names[id]) { game.names[id] = p.name; saveGame(); }
      const prev = game.ms[id];
      const now = memberState(id);
      game.ms[id] = now;
      if (prev && prev !== now) {
        if (now === 'ingame') {
          sendState(id); // игрок вернулся — отдаём ему свою копию партии
          if (me.status === 'playing' && settled) toast(`${nameOf(id)} снова в игре!`);
        } else if (prev === 'ingame' && me.status === 'playing' && settled) {
          toast(now === 'offline'
            ? `${nameOf(id)}: нет связи. Игра сохранена — продолжите, когда игрок вернётся`
            : `${nameOf(id)} сейчас в лобби. Игра сохранена`);
        }
      } else if (!prev && now === 'ingame') {
        sendState(id);
      }
    }
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

  // Игры, к которым можно подключиться: кто-то ждёт соперника или двое уже играют.
  function openGames() {
    const now = Date.now();
    const games = new Map();
    for (const [id, p] of players) {
      if (now - p.seen > PRESENCE_TTL || !p.game) continue;
      if (game && p.game === game.id) continue;
      if (p.status !== 'waiting' && p.status !== 'playing') continue;
      if (!p.members.includes(id)) continue;
      const g = games.get(p.game);
      if (!g || p.members.length > g.members.length || (p.members.length === g.members.length && p.seen > g.ts)) {
        games.set(p.game, { id: p.game, members: p.members, names: p.names, ts: p.seen, waiting: p.status === 'waiting' });
      }
    }
    return [...games.values()].filter((g) => g.members.length >= 1 && g.members.length < MAX_PLAYERS && !g.members.includes(me.id));
  }

  function renderLobby() {
    const now = Date.now();
    const list = $('lobbyList');
    let online = 1;
    for (const p of players.values()) if (now - p.seen <= PRESENCE_TTL) online++;
    $('onlineCount').textContent = 'онлайн: ' + (client && client.connected ? online : 0);

    const items = openGames().sort((a, b) => a.members.length - b.members.length || a.id.localeCompare(b.id));
    const keep = new Set(items.map((g) => g.id));
    for (const li of [...list.children]) {
      if (!keep.has(li.dataset.id) && !li.classList.contains('leaving')) {
        li.classList.add('leaving');
        setTimeout(() => li.remove(), 300);
      }
    }
    for (const g of items) {
      let li = list.querySelector(`li[data-id="${CSS.escape(g.id)}"]:not(.leaving)`);
      if (!li) {
        li = document.createElement('li');
        li.className = 'lobby-item';
        li.dataset.id = g.id;
        li.innerHTML = '<div class="avatars"></div><div class="li-info"><div class="li-name"></div>' +
          '<div class="li-status"></div></div><button class="btn join"></button>';
        li.querySelector('button').addEventListener('click', () => joinGame(li.dataset.id));
        list.appendChild(li);
      }
      const av = li.querySelector('.avatars');
      av.innerHTML = '';
      g.members.forEach((id, i) => {
        const a = document.createElement('div');
        a.className = 'avatar';
        a.textContent = ((g.names[i] || '?')[0] || '?').toUpperCase();
        a.style.background = avatarBg(id);
        av.appendChild(a);
      });
      const two = g.members.length >= 2;
      li.classList.toggle('busy-game', two);
      li.querySelector('.li-name').textContent = two ? `${g.names[0] || 'Игрок'} и ${g.names[1] || 'Игрок'}` : (g.names[0] || 'Игрок');
      li.querySelector('.li-status').textContent = two ? 'играют · можно третьим' : 'ждёт соперника';
      const btn = li.querySelector('button');
      const joining = pendingJoin && pendingJoin.game === g.id;
      btn.disabled = !!pendingJoin;
      btn.textContent = joining ? 'Подключение…' : two ? 'Третьим' : 'Играть';
    }
    $('lobbyEmpty').classList.toggle('hidden', items.length !== 0);

    // карточка незаконченной партии
    const card = $('resumeCard');
    card.classList.toggle('hidden', !game || me.status === 'waiting');
    if (game && me.status !== 'waiting') {
      const st = replay(game.log);
      const others = st.players.filter((x) => x !== me.id);
      const place = placeOf(st, me.id);
      $('resumeSub').innerHTML = `${others.length > 1 ? 'Соперники' : 'Соперник'}: <b>${esc(listNames(others))}</b> · ` +
        `у тебя ${st.pts[me.id] || 0} очк. · ${place} место`;
      const stEl = $('resumeState');
      const states = others.map((id) => memberState(id));
      const best = states.includes('ingame') ? 'ingame' : states.includes('lobby') ? 'lobby' : 'offline';
      stEl.className = 'opp-state ' + best;
      const inGame = others.filter((id, i) => states[i] === 'ingame');
      stEl.textContent = inGame.length ? `${listNames(inGame)} в игре и ${inGame.length > 1 ? 'ждут' : 'ждёт'} тебя`
        : others.map((id, i) => `${nameOf(id)} ${STATE_TEXT[states[i]]}`).join(' · ');
    }
  }

  async function confirmDropSaved() {
    if (!game) return true;
    const ok = await ask('У тебя есть незаконченная игра.<br>Выйти из неё и начать новую?', 'Выйти');
    if (ok) leaveGameByMe();
    return ok;
  }

  async function createGame() {
    if (!requireName()) return;
    if (!client || !client.connected) { toast('Нет подключения к сети, подожди немного', 'err'); return; }
    if (!(await confirmDropSaved())) return;
    game = makeGame(uid(), ['+' + me.id], {});
    me.status = 'waiting';
    publishPresence();
    showScreen('wait');
  }

  function cancelWait() {
    // в партии никого, кроме нас, — просто забываем её
    if (game && replay(game.log).players.length < 2) dropGame();
    setStatus('lobby');
    showScreen('lobby');
    renderLobby();
  }

  async function joinGame(gid) {
    if (pendingJoin) return;
    if (!requireName()) return;
    if (!client || !client.connected) { toast('Нет подключения к сети', 'err'); return; }
    const g = openGames().find((x) => x.id === gid);
    if (!g) { toast('Эта игра уже недоступна', 'err'); return; }
    if (!(await confirmDropSaved())) return;
    publishPresence();
    pendingJoin = {
      game: gid,
      timer: setTimeout(() => {
        pendingJoin = null;
        renderLobby();
        toast('Игроки не отвечают — попробуй позже', 'err');
      }, JOIN_TIMEOUT),
    };
    // просимся у всех участников: впишет нас тот, чья сейчас очередь
    for (const id of g.members) send(id, { t: 'join', game: gid, name: me.name });
    renderLobby();
  }

  // ---------- игра ----------
  function openGame(live) {
    if (!game) return;
    clearTimeout(game.ui.nextTimer);
    clearTimeout(game.ui.overlayTimer);
    game.ui = freshUi();
    me.status = 'playing';
    publishPresence();
    sendState();
    $('overlay').classList.add('hidden');
    $('podium').querySelectorAll('.ptoken').forEach((el) => el.remove());
    showScreen('game');
    for (const id of replay(game.log).players) if (id !== me.id) game.ms[id] = memberState(id);
    render(live);
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

  // Выйти из партии насовсем. Вдвоём — партия заканчивается для обоих,
  // втроём — оставшиеся двое продолжают.
  function leaveGameByMe() {
    if (!game) return;
    const st = replay(game.log);
    const others = st.players.filter((x) => x !== me.id);
    if (st.players.length <= 2) {
      for (const id of others) send(id, { t: 'end', game: game.id });
    } else if (appenderOf(st) === me.id) {
      game.log = [...game.log, '-' + me.id];
      for (const id of others) send(id, stateMsg());
    } else {
      for (const id of others) send(id, { t: 'leave', game: game.id });
    }
    dropGame();
    publishPresence();
  }

  async function endGameClick() {
    if (!game) return;
    const st = replay(game.log);
    const three = st.players.length > 2;
    const ok = await ask(three
      ? 'Покинуть игру?<br>Остальные продолжат без тебя, вернуться в эту партию будет нельзя.'
      : `Завершить игру? Соперник: <b>${esc(listNames(st.players.filter((x) => x !== me.id)))}</b>.<br>Продолжить её будет нельзя.`,
    three ? 'Покинуть' : 'Завершить');
    if (!ok || !game) return;
    leaveGameByMe();
    pauseGame();
  }

  // Партия закончилась: в ней не осталось соперников.
  function partyEnded(byId) {
    if (!game) return;
    const st = replay(game.log);
    const name = byId ? nameOf(byId) : 'Соперник';
    const pts = st.pts[me.id] || 0;
    const place = placeOf(st, me.id);
    const wasPlaying = me.status === 'playing';
    dropGame();
    publishPresence();
    if (!wasPlaying) {
      toast(`${name}: игра завершена`);
      renderLobby();
      return;
    }
    $('board').classList.remove('my-turn');
    $('turnInfo').textContent = '';
    $('rIcon').textContent = '👋';
    const rt = $('rTitle');
    rt.textContent = 'Игра завершена';
    rt.className = 'r-title';
    $('rSub').textContent = `${name} выходит из игры`;
    $('rNext').textContent = `Итог: ${place} место, ${pts} очк.`;
    $('toLobbyBtn').classList.remove('hidden');
    $('overlay').classList.remove('hidden');
  }

  // при равенстве очков место общее
  function placeOf(st, id) {
    return 1 + st.players.filter((x) => st.pts[x] > st.pts[id]).length;
  }

  function rankOf(st) {
    return [...st.players].sort((a, b) =>
      (st.pts[b] - st.pts[a]) || (st.wins[b] - st.wins[a]) || (st.order[a] - st.order[b]));
  }

  // ---------- пьедестал ----------
  const STEP_H = { 1: 44, 2: 30, 3: 20 };
  const STEP_COL = { 1: 1, 2: 0, 3: 2 };

  function placeStyle(el, place) {
    el.style.left = `calc(${STEP_COL[place]} * ((100% - 12px) / 3 + 6px))`;
    el.style.bottom = (STEP_H[place] + 4) + 'px';
  }

  function renderPodium(st, d) {
    const pod = $('podium');
    const rank = rankOf(st);
    const ui = game.ui;
    const prevRank = ui.members;
    const atTable = new Set(d.pair || []);
    const tokens = new Map([...pod.querySelectorAll('.ptoken')].map((el) => [el.dataset.id, el]));
    rank.forEach((id, i) => {
      let el = tokens.get(id);
      tokens.delete(id);
      if (!el) {
        el = document.createElement('div');
        el.className = 'ptoken enter';
        el.dataset.id = id;
        el.innerHTML = '<div class="pav"><span class="pini"></span><span class="pbadge"></span></div><div class="pname"></div><div class="ppts"></div>';
        placeStyle(el, i + 1);
        pod.appendChild(el);
      }
      const prevPlace = prevRank ? prevRank.indexOf(id) : -1;
      if (prevPlace >= 0 && prevPlace !== i) {
        el.classList.remove('rise', 'fall');
        void el.offsetWidth;
        el.classList.add(i < prevPlace ? 'rise' : 'fall');
      }
      placeStyle(el, i + 1);
      el.classList.toggle('me', id === me.id);
      el.classList.toggle('atable', atTable.has(id));
      const pav = el.querySelector('.pav');
      pav.style.background = avatarBg(id);
      el.querySelector('.pini').textContent = (nameOf(id)[0] || '?').toUpperCase();
      el.querySelector('.pbadge').textContent = atTable.has(id) || st.players.length < 3 ? '' : '👀';
      let crown = el.querySelector('.crown');
      const lead = i === 0 && st.pts[id] > 0 && (rank.length < 2 || st.pts[id] > st.pts[rank[1]]);
      if (lead && !crown) { crown = document.createElement('div'); crown.className = 'crown'; crown.textContent = '👑'; el.prepend(crown); }
      if (!lead && crown) crown.remove();
      el.querySelector('.pname').textContent = nameOf(id) + (id === me.id ? ' (ты)' : '');
      const ptsEl = el.querySelector('.ppts');
      const val = String(st.pts[id] || 0);
      if (ptsEl.dataset.v !== undefined && ptsEl.dataset.v !== val) {
        ptsEl.classList.remove('bump');
        void ptsEl.offsetWidth;
        ptsEl.classList.add('bump');
      }
      ptsEl.dataset.v = val;
      ptsEl.innerHTML = `${val} <small>очк.</small>`;
    });
    // свободное место для третьего
    if (rank.length < MAX_PLAYERS) {
      let free = tokens.get('free');
      tokens.delete('free');
      if (!free) {
        free = document.createElement('div');
        free.className = 'ptoken free enter';
        free.dataset.id = 'free';
        free.innerHTML = '<div class="pav">+</div><div class="pname">ждём третьего игрока</div>';
        pod.appendChild(free);
      }
      placeStyle(free, rank.length + 1);
    }
    for (const el of tokens.values()) {
      el.style.opacity = '0';
      setTimeout(() => el.remove(), 400);
    }
    ui.members = rank;
  }

  // ---------- доска ----------
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
    $('winLine').classList.remove('show', 'x', 'o');
  }

  function drawMark(i, mark) {
    const c = $('board').children[i];
    c.classList.remove('empty');
    c.classList.add('placed');
    c.style.animationDelay = '0s';
    c.innerHTML = mark === 'x'
      ? '<svg class="x drawn" viewBox="0 0 40 40"><path d="M10 10L30 30"/><path d="M30 10L10 30"/></svg>'
      : '<svg class="o drawn" viewBox="0 0 40 40"><circle cx="20" cy="20" r="12"/></svg>';
  }

  // Каким значком рисовать игрока: у себя ты всегда ✕, соперник ◯.
  // Наблюдатель видит ✕ у того, кто в этом раунде ходит первым.
  function markOf(d, id) {
    if (d.pair && d.pair.includes(me.id)) return id === me.id ? 'x' : 'o';
    return id === d.first ? 'x' : 'o';
  }

  // Перерисовка игры по журналу. live = изменение произошло только что
  // (ход, синхронизация), а не при открытии сохранённой партии.
  function render(live) {
    if (!game || me.status !== 'playing') return;
    const ui = game.ui;
    const st = replay(game.log);

    if (st.over && st.round > 0 && !st.result?.aborted && ui.finished !== st.round) {
      ui.finished = st.round;
      if (live && ui.round === st.round) roundFinished(st);
      else ui.advanced = st.round;
    }
    const d = view(st);

    if (d.round !== ui.round) {
      clearTimeout(ui.nextTimer);
      clearTimeout(ui.overlayTimer);
      $('overlay').classList.add('hidden');
      ui.round = d.round;
      buildBoard();
    }
    const cells = $('board').children;
    d.board.forEach((who, i) => {
      if (who && cells[i].classList.contains('empty')) drawMark(i, markOf(d, who));
    });
    if (d.over && ui.lineRound !== d.round) {
      ui.lineRound = d.round;
      $('board').classList.add('done');
      if (d.result.winner) {
        const m = markOf(d, d.result.winner);
        for (const i of d.result.line) cells[i].classList.add('win', m === 'x' ? 'wx' : 'wo');
        drawWinLine(d.result.line, m);
      }
    }

    renderPodium(st, d);
    renderMatch(st, d);
    $('roundInfo').textContent = 'Раунд ' + Math.max(1, d.round);
    const waiting = d.pair ? st.players.filter((id) => !d.pair.includes(id)) : [];
    $('queueInfo').innerHTML = waiting.length
      ? `Ждёт очереди: <b>${esc(waiting.map((id) => id === me.id ? 'ты' : nameOf(id)).join(', '))}</b>` : '';
    $('endBtn').textContent = st.players.length > 2 ? 'Покинуть' : 'Завершить';
  }

  function renderMatch(st, d) {
    const sides = [$('mA'), $('mB')];
    if (!d.pair) {
      sides.forEach((s) => s.classList.add('hidden'));
      $('turnInfo').textContent = 'Ждём игроков…';
      return;
    }
    // слева — ты (если играешь) или тот, кто ходит первым
    const left = d.pair.includes(me.id) ? me.id : d.first;
    const ids = [left, other(d.pair, left)];
    ids.forEach((id, i) => {
      const s = sides[i];
      const m = markOf(d, id);
      s.classList.remove('hidden', 'x', 'o');
      s.classList.add(m);
      s.classList.toggle('active', !d.over && d.turn === id);
      s.querySelector('.m-mark').innerHTML = m === 'x' ? X_SVG : O_SVG;
      s.querySelector('.m-name').textContent = nameOf(id) + (id === me.id ? ' (ты)' : '');
      const stEl = s.querySelector('.opp-state');
      const ms = memberState(id);
      stEl.className = 'opp-state ' + ms;
      stEl.textContent = id === me.id ? (ms === 'ingame' ? 'в сети' : 'нет связи') : STATE_TEXT[ms];
    });
    updateTurn(st, d);
  }

  function updateTurn(st, d) {
    const t = $('turnInfo');
    const playing = d.pair && d.pair.includes(me.id);
    const mine = playing && !d.over && d.turn === me.id;
    const board = $('board');
    board.classList.toggle('my-turn', !!mine);
    board.classList.toggle('spectating', !!d.pair && !playing);
    let eye = document.querySelector('.board-wrap .eye');
    if (d.pair && !playing) {
      if (!eye) {
        eye = document.createElement('div');
        eye.className = 'eye';
        eye.textContent = '👀 ты наблюдаешь';
        document.querySelector('.board-wrap').appendChild(eye);
      }
    } else if (eye) eye.remove();

    t.innerHTML = '';
    if (d.over) { t.className = 'turn'; return; }
    if (!playing) {
      t.className = 'turn watch';
      t.append(`👀 Не твой ход · ходит ${nameOf(d.turn)}`);
    } else if (mine) {
      t.className = 'turn mine';
      t.textContent = 'Твой ход!';
      return;
    } else {
      t.className = 'turn theirs';
      const ms = memberState(d.turn);
      t.append(ms === 'ingame' ? 'Ходит ' + nameOf(d.turn)
        : ms === 'lobby' ? `${nameOf(d.turn)} в лобби — ждём возвращения`
          : `${nameOf(d.turn)} не в сети — ждём возвращения`);
    }
    const dots = document.createElement('span');
    dots.className = 'dots';
    t.append(dots);
  }

  function roundFinished(st) {
    const ui = game.ui;
    const r = st.round;
    const winner = st.result.winner;
    const playing = st.pair.includes(me.id);
    const nx = nextSetup(st);
    let icon, title, cls, sub;
    if (winner === me.id) {
      icon = '🏆'; title = 'Победа!'; cls = 'win'; sub = `+${PTS_WIN} очка`;
      confetti();
    } else if (winner && playing) {
      icon = '😮'; title = 'Поражение'; cls = 'lose'; sub = 'Победитель: <b></b>';
    } else if (winner) {
      icon = '🏆'; title = 'Раунд сыгран'; cls = ''; sub = 'Победитель: <b></b>';
    } else {
      icon = '🤝'; title = 'Ничья!'; cls = ''; sub = playing ? `+${PTS_DRAW} очко` : `${listNames(st.pair)}: по ${PTS_DRAW} очку`;
    }
    let next = '';
    if (nx) {
      const [a, b] = nx.pair;
      if (!nx.pair.includes(me.id)) next = `Ты уступаешь место и пока наблюдаешь. Дальше играют: ${nameOf(a)} и ${nameOf(b)}`;
      else if (!playing) next = `Твоя очередь! В следующем раунде твой соперник — ${nameOf(other(nx.pair, me.id))}`;
      else if (st.players.length > 2) next = `Ты остаёшься за столом. Следующий соперник — ${nameOf(other(nx.pair, me.id))}`;
      else next = `Следующий раунд — первым ходит ${nx.first === me.id ? 'ты' : nameOf(nx.first)}`;
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
      if (b) b.textContent = nameOf(winner);
      $('toLobbyBtn').classList.add('hidden');
      $('rNext').textContent = next;
      $('overlay').classList.remove('hidden');
    }, delay);
    ui.nextTimer = setTimeout(() => {
      if (!game || game.ui !== ui || ui.finished !== r) return;
      ui.advanced = r;
      render(false);
    }, NEXT_ROUND_DELAY + delay);
  }

  function onCellClick(i) {
    if (!game || me.status !== 'playing') return;
    flushPending();
    if (!game) return;
    const st = replay(game.log);
    const d = view(st);
    if (!d.pair || d.over || d.turn !== me.id || d.board[i]) return;
    const before = st;
    game.log = [...game.log, String(i)];
    afterLogChange(before, true);
    sendState();
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
    const three = replay(game.log).players.length > 2;
    const ok = await ask(three ? 'Покинуть игру? Остальные продолжат без тебя.' : 'Завершить игру? Продолжить её будет нельзя.',
      three ? 'Покинуть' : 'Завершить');
    if (ok && game) { leaveGameByMe(); renderLobby(); }
  });

  setInterval(() => { publishPresence(); refreshMembers(); renderLobby(); }, PRESENCE_EVERY);
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
