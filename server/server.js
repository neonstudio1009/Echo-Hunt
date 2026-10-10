const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DB_URL = (process.env.FIREBASE_DB_URL || '').replace(/\/+$/, '');
const RANGE = 12, ARENA = 45, DURATION = 180, MAXP = 8;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Echo Hunt server OK' + (DB_URL ? ' (leaderboard: persistent)' : ' (leaderboard: memory only)'));
});
const wss = new WebSocketServer({ server });
const rooms = new Map();

const rid = () => Math.random().toString(36).slice(2, 10);
const randMel = () => [0, 1, 2].map(() => Math.floor(Math.random() * 3));
const randPos = () => ({ x: (Math.random() - 0.5) * 80, z: (Math.random() - 0.5) * 80 });
const sameMel = (a, b) => a.length === 3 && b.length === 3 && a.every((v, i) => v === b[i]);
const r2 = n => Math.round(n * 100) / 100;
const tag = v => (typeof v === 'string' && /^[a-z]{1,12}$/.test(v)) ? v : 'none';
function cleanLook(l) {
  l = l || {};
  return { s: tag(l.s) === 'none' ? 'yellow' : tag(l.s), a: tag(l.a), t: tag(l.t) };
}
const validPid = v => typeof v === 'string' && /^[a-z0-9]{8,24}$/.test(v);

/* ---------- 排行榜 ---------- */
// board[pid] = { n:名字, e:無盡最高淘汰, et:該局秒數, o:線上累計淘汰, w:線上勝場 }
let board = {};
const dirty = new Set();

async function loadBoard() {
  if (!DB_URL) { console.log('FIREBASE_DB_URL 未設定:排行榜只存在記憶體'); return; }
  try {
    const r = await fetch(DB_URL + '/lb.json');
    const d = await r.json();
    if (d && typeof d === 'object') board = d;
    console.log('排行榜已載入:' + Object.keys(board).length + ' 筆');
  } catch (e) { console.log('排行榜載入失敗:' + e.message); }
}
function entry(pid, name) {
  if (!board[pid]) {
    if (Object.keys(board).length > 20000) return null;
    board[pid] = { n: name, e: 0, et: 0, o: 0, w: 0 };
  }
  if (name) board[pid].n = name;
  return board[pid];
}
function markDirty(pid) { dirty.add(pid); }
setInterval(() => {
  if (!DB_URL || dirty.size === 0) return;
  for (const pid of dirty) {
    fetch(DB_URL + '/lb/' + pid + '.json', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(board[pid])
    }).catch(() => {});
  }
  dirty.clear();
}, 5000);

function sortedBoard(kind) {
  const arr = Object.keys(board).map(pid => ({ pid, ...board[pid] }));
  if (kind === 'online') {
    return arr.filter(x => (x.o || 0) > 0).sort((a, b) => (b.o - a.o) || ((b.w || 0) - (a.w || 0)));
  }
  return arr.filter(x => (x.e || 0) > 0).sort((a, b) => (b.e - a.e) || ((a.et || 0) - (b.et || 0)));
}
function lbReply(kind, pid) {
  const list = sortedBoard(kind);
  const rows = list.slice(0, 20).map(x => ({
    n: x.n,
    v: kind === 'online' ? x.o : x.e,
    s: kind === 'online' ? (x.w || 0) : (x.et || 0),
    me: x.pid === pid
  }));
  let me = null;
  const idx = list.findIndex(x => x.pid === pid);
  if (idx >= 0) me = { rank: idx + 1, v: kind === 'online' ? list[idx].o : list[idx].e, s: kind === 'online' ? (list[idx].w || 0) : (list[idx].et || 0) };
  return { t: 'lb', kind, rows, me, total: list.length, persist: !!DB_URL };
}

/* ---------- 房間 ---------- */
function send(ws, o) { if (ws.readyState === 1) ws.send(JSON.stringify(o)); }
function broadcast(room, o) { for (const p of room.players.values()) send(p.ws, o); }
function lobbyMsg(room) {
  return { t: 'lobby', state: room.state, players: [...room.players.values()].map(p => ({ id: p.id, name: p.name })) };
}
function newCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}
function cleanName(n) { return String(n || '玩家').replace(/[<>&]/g, '').trim().slice(0, 8) || '玩家'; }

function joinRoom(ws, room, name, look, pid) {
  const p = { id: rid(), pid: validPid(pid) ? pid : null, ws, name: cleanName(name), look: cleanLook(look), x: 0, z: 0, c: 0, m: 0, mel: randMel(), sc: 0, room };
  ws.player = p;
  room.players.set(p.id, p);
  send(ws, { t: 'joined', code: room.code, id: p.id });
  broadcast(room, lobbyMsg(room));
}

function startRound(room) {
  room.state = 'playing';
  for (const p of room.players.values()) {
    const pos = randPos();
    Object.assign(p, pos, { sc: 0, mel: randMel(), c: 0, m: 0 });
    send(p.ws, { t: 'start', x: pos.x, z: pos.z, duration: DURATION });
  }
  broadcast(room, lobbyMsg(room));
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room), DURATION * 1000);
}

function endRound(room) {
  if (room.state !== 'playing') return;
  room.state = 'lobby';
  const sorted = [...room.players.values()].sort((a, b) => b.sc - a.sc);
  const ranking = sorted.map(p => ({ id: p.id, name: p.name, sc: p.sc }));
  if (sorted.length >= 2 && sorted[0].sc > 0) {
    const top = sorted[0].sc;
    for (const p of sorted) {
      if (p.sc === top && p.pid) {
        const e = entry(p.pid, p.name);
        if (e) { e.w = (e.w || 0) + 1; markDirty(p.pid); }
      }
    }
  }
  broadcast(room, { t: 'end', ranking });
  broadcast(room, lobbyMsg(room));
}

function leave(ws) {
  const p = ws.player;
  if (!p) return;
  const room = p.room;
  room.players.delete(p.id);
  ws.player = null;
  if (room.players.size === 0) { clearTimeout(room.timer); rooms.delete(room.code); }
  else broadcast(room, lobbyMsg(room));
}

wss.on('connection', ws => {
  ws.isAlive = true;
  ws.lastSubmit = 0;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    ws.isAlive = true;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    const p = ws.player;
    switch (m.t) {
      case 'create': {
        if (p) return;
        const room = { code: newCode(), state: 'lobby', players: new Map(), timer: null };
        rooms.set(room.code, room);
        joinRoom(ws, room, m.name, m.look, m.pid);
        break;
      }
      case 'join': {
        if (p) return;
        const room = rooms.get(String(m.code));
        if (!room) return send(ws, { t: 'err', msg: '找不到這個房間' });
        if (room.state === 'playing') return send(ws, { t: 'err', msg: '這個房間正在遊戲中,請稍後再加入' });
        if (room.players.size >= MAXP) return send(ws, { t: 'err', msg: '房間已滿(最多 8 人)' });
        joinRoom(ws, room, m.name, m.look, m.pid);
        break;
      }
      case 'look':
        if (p) p.look = cleanLook(m.look);
        break;
      case 'start':
        if (p && p.room.state === 'lobby') startRound(p.room);
        break;
      case 'pos':
        if (p && p.room.state === 'playing') {
          p.x = Math.max(-ARENA, Math.min(ARENA, +m.x || 0));
          p.z = Math.max(-ARENA, Math.min(ARENA, +m.z || 0));
          p.c = m.c ? 1 : 0;
          p.m = m.m ? 1 : 0;
        }
        break;
      case 'guess': {
        if (!p || p.room.state !== 'playing' || !Array.isArray(m.mel)) return;
        let hit = null, hd = 1e9;
        for (const q of p.room.players.values()) {
          if (q === p) continue;
          const d = Math.hypot(q.x - p.x, q.z - p.z);
          if (d < RANGE + 2 && sameMel(q.mel, m.mel) && d < hd) { hit = q; hd = d; }
        }
        if (hit) {
          p.sc++;
          if (p.pid) {
            const e = entry(p.pid, p.name);
            if (e) { e.o = (e.o || 0) + 1; markDirty(p.pid); }
          }
          const pos = randPos();
          const hx = hit.x, hz = hit.z;
          Object.assign(hit, pos, { mel: randMel() });
          broadcast(p.room, { t: 'kill', by: p.id, byName: p.name, victim: hit.id, victimName: hit.name, x: hx, z: hz });
          send(hit.ws, { t: 'respawn', x: pos.x, z: pos.z });
        } else {
          broadcast(p.room, { t: 'noise', id: p.id, x: r2(p.x), z: r2(p.z) });
        }
        break;
      }
      case 'submit': {
        const now = Date.now();
        if (now - ws.lastSubmit < 5000) return send(ws, { t: 'ack', ok: false });
        ws.lastSubmit = now;
        if (!validPid(m.pid)) return send(ws, { t: 'ack', ok: false });
        const score = Math.floor(+m.score), time = Math.floor(+m.time);
        if (!(score >= 0 && score <= 500) || !(time >= 0 && time <= 7200) || score > time / 2.5 + 3) return send(ws, { t: 'ack', ok: false });
        const e = entry(m.pid, cleanName(m.name));
        if (!e) return send(ws, { t: 'ack', ok: false });
        if (score > (e.e || 0) || (score === e.e && time < (e.et || 1e9))) { e.e = score; e.et = time; }
        markDirty(m.pid);
        const r = lbReply('endless', m.pid);
        send(ws, { t: 'ack', ok: true, rank: r.me ? r.me.rank : null, best: e.e, persist: !!DB_URL });
        break;
      }
      case 'lb':
        send(ws, lbReply(m.kind === 'online' ? 'online' : 'endless', validPid(m.pid) ? m.pid : ''));
        break;
      case 'leave':
        leave(ws);
        break;
    }
  });
  ws.on('close', () => leave(ws));
  ws.on('error', () => {});
});

setInterval(() => {
  for (const room of rooms.values()) {
    if (room.state !== 'playing') continue;
    const sc = {};
    const all = [...room.players.values()];
    for (const p of all) sc[p.id] = p.sc;
    for (const p of all) {
      const others = all.filter(q => q !== p).map(q => ({ id: q.id, name: q.name, look: q.look, x: r2(q.x), z: r2(q.z), c: q.c, m: q.m, mel: q.mel }));
      send(p.ws, { t: 'snap', p: others, sc });
    }
  }
}, 100);

setInterval(() => {
  wss.clients.forEach(ws => {
    if (!ws.isAlive) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

loadBoard().then(() => {
  server.listen(PORT, () => console.log('Echo Hunt server on ' + PORT));
});
