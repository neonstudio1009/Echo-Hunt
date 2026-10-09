const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const RANGE = 12, ARENA = 45, DURATION = 180, MAXP = 8;

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Echo Hunt server OK');
});
const wss = new WebSocketServer({ server });
const rooms = new Map();

const rid = () => Math.random().toString(36).slice(2, 10);
const randMel = () => [0, 1, 2].map(() => Math.floor(Math.random() * 3));
const randPos = () => ({ x: (Math.random() - 0.5) * 80, z: (Math.random() - 0.5) * 80 });
const sameMel = (a, b) => a.length === 3 && b.length === 3 && a.every((v, i) => v === b[i]);
const r2 = n => Math.round(n * 100) / 100;

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

function joinRoom(ws, room, name) {
  const p = { id: rid(), ws, name: cleanName(name), x: 0, z: 0, c: 0, m: 0, mel: randMel(), sc: 0, room };
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
  const ranking = [...room.players.values()].sort((a, b) => b.sc - a.sc).map(p => ({ id: p.id, name: p.name, sc: p.sc }));
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
        joinRoom(ws, room, m.name);
        break;
      }
      case 'join': {
        if (p) return;
        const room = rooms.get(String(m.code));
        if (!room) return send(ws, { t: 'err', msg: '找不到這個房間' });
        if (room.state === 'playing') return send(ws, { t: 'err', msg: '這個房間正在遊戲中,請稍後再加入' });
        if (room.players.size >= MAXP) return send(ws, { t: 'err', msg: '房間已滿(最多 8 人)' });
        joinRoom(ws, room, m.name);
        break;
      }
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
      const others = all.filter(q => q !== p).map(q => ({ id: q.id, name: q.name, x: r2(q.x), z: r2(q.z), c: q.c, m: q.m, mel: q.mel }));
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

server.listen(PORT, () => console.log('Echo Hunt server on ' + PORT));
