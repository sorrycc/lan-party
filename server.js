/* Frostline Kart LAN server: serves the static files and relays room messages over WebSocket.
   The server never simulates the race; the host player's browser does. */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT) || 3000;
const ROOT = __dirname;
const MAX_PLAYERS = 8, SKIN_COUNT = 8;
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml' };
const STATIC = new Set(['/index.html', '/app.js', '/game.js', '/net.js', '/style.css']);
const THREE_PATH = path.join(ROOT, 'node_modules', 'three', 'build', 'three.module.js');

const server = http.createServer((req, res) => {
  let url = req.url.split('?')[0]; if (url === '/') url = '/index.html';
  let file = null;
  if (url === '/lib/three.module.js') file = THREE_PATH; else if (STATIC.has(url)) file = path.join(ROOT, url);
  if (url === '/favicon.ico') { res.writeHead(204); res.end(); return; }
  if (!file) { res.writeHead(404); res.end('not found'); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(err.code === 'ENOENT' && file === THREE_PATH ? 500 : 404); res.end(file === THREE_PATH ? 'three.js missing - run: npm install' : 'not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(data);
  });
});

/* ---------------------------------------------------------------- rooms */
const rooms = new Map();   // code -> room
let nextId = 1;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newCode() { let c; do { c = ''; for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]; } while (rooms.has(c)); return c; }
const cleanName = n => (String(n || '').trim().slice(0, 12)) || 'Racer';
const cleanSkin = s => Number.isInteger(s) && s >= 0 && s < SKIN_COUNT ? s : -1;
const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };
function broadcast(room, msg, except) { const data = JSON.stringify(msg); for (const p of room.players.values()) if (p.ws !== except && p.ws.readyState === p.ws.OPEN) p.ws.send(data); }
function freeSkin(room, want) { const taken = new Set([...room.players.values()].map(p => p.skin)); if (want >= 0 && !taken.has(want)) return want; for (let i = 0; i < SKIN_COUNT; i++) if (!taken.has(i)) return i; return -1; }
function lobbyMsg(room) { return { t: 'lobby', room: room.code, hostId: room.hostId, state: room.state, fillAI: room.fillAI, players: [...room.players.values()].map(p => ({ id: p.id, name: p.name, skin: p.skin, ready: p.ready })) }; }
function slotsOf(room) {
  const slots = []; for (let i = 0; i < SKIN_COUNT; i++) slots.push({ kind: room.fillAI ? 'ai' : 'none' });
  for (const p of room.players.values()) slots[p.skin] = { kind: 'human', id: p.id, name: p.name };
  return slots;
}
function lanAddresses() {
  const out = []; for (const list of Object.values(os.networkInterfaces())) for (const a of list) if (a.family === 'IPv4' && !a.internal) out.push(a.address); return out;
}
const addrHint = () => { const a = lanAddresses(); return a.length ? `http://${a[0]}:${PORT}` : `http://localhost:${PORT}`; };

function joinRoom(ws, room, name, skin) {
  const p = ws.meta; p.room = room; p.name = cleanName(name); p.skin = freeSkin(room, cleanSkin(skin)); p.ready = false;
  room.players.set(p.id, p);
  send(ws, { t: 'joined', id: p.id, room: room.code, hostId: room.hostId, addr: addrHint() });
  broadcast(room, lobbyMsg(room));
}
function leaveRoom(ws) {
  const p = ws.meta, room = p.room; if (!room) return; p.room = null; room.players.delete(p.id);
  if (room.hostId === p.id || room.players.size === 0) { broadcast(room, { t: 'closed', reason: 'The host left the room' }); for (const o of room.players.values()) o.room = null; rooms.delete(room.code); console.log(`room ${room.code} closed`); return; }
  broadcast(room, { t: 'left', id: p.id }); broadcast(room, lobbyMsg(room));
}

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  ws.meta = { id: nextId++, ws, room: null, name: 'Racer', skin: 0, ready: false }; ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => {
    let msg; try { msg = JSON.parse(raw); } catch { return; } if (!msg || typeof msg.t !== 'string') return;
    const p = ws.meta, room = p.room, isHost = room && room.hostId === p.id;
    switch (msg.t) {
      case 'create': { if (room) leaveRoom(ws); const r = { code: newCode(), hostId: p.id, state: 'lobby', fillAI: true, players: new Map() }; rooms.set(r.code, r); joinRoom(ws, r, msg.name, msg.skin); console.log(`room ${r.code} created by ${p.name}`); break; }
      case 'join': {
        const code = String(msg.room || '').trim().toUpperCase(); const r = rooms.get(code);
        if (!r) { send(ws, { t: 'error', msg: `Room ${code || '?'} not found` }); break; }
        if (r.state !== 'lobby') { send(ws, { t: 'error', msg: 'That race is already running - wait for it to finish' }); break; }
        if (r.players.size >= MAX_PLAYERS) { send(ws, { t: 'error', msg: 'Room is full' }); break; }
        if (room) leaveRoom(ws); joinRoom(ws, r, msg.name, msg.skin); console.log(`${p.name} joined ${r.code}`); break;
      }
      case 'lobby': {
        if (!room) break;
        if (msg.name !== undefined) p.name = cleanName(msg.name);
        if (msg.skin !== undefined) { const s = cleanSkin(msg.skin); if (s >= 0 && ![...room.players.values()].some(o => o !== p && o.skin === s)) p.skin = s; }
        if (msg.ready !== undefined) p.ready = !!msg.ready;
        broadcast(room, lobbyMsg(room)); break;
      }
      case 'opt': if (isHost && msg.fillAI !== undefined) { room.fillAI = !!msg.fillAI; broadcast(room, lobbyMsg(room)); } break;
      case 'start': if (isHost) { room.state = 'racing'; broadcast(room, { t: 'start', slots: slotsOf(room), hostId: room.hostId }); broadcast(room, lobbyMsg(room)); console.log(`room ${room.code}: race started with ${room.players.size} player(s)`); } break;
      case 'end': if (isHost) { room.state = 'lobby'; for (const o of room.players.values()) o.ready = false; broadcast(room, { t: 'end' }); broadcast(room, lobbyMsg(room)); } break;
      case 'leave': leaveRoom(ws); break;
      default: // in-race traffic: relay to the rest of the room (or one recipient)
        if (!room) break; msg.from = p.id;
        if (msg.to !== undefined) { const o = room.players.get(msg.to); if (o) send(o.ws, msg); } else broadcast(room, msg, ws);
    }
  });
  ws.on('close', () => leaveRoom(ws));
});
const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 15000);
wss.on('close', () => clearInterval(heartbeat));

server.listen(PORT, '0.0.0.0', () => {
  console.log('Frostline Kart server running. Open one of these on every Mac:');
  console.log(`  http://localhost:${PORT}   (this machine)`);
  for (const a of lanAddresses()) console.log(`  http://${a}:${PORT}`);
  if (!fs.existsSync(THREE_PATH)) console.log('WARNING: three.js not found - run `npm install` first.');
});
