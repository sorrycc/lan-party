/* Rooms and lobby: a game-agnostic state machine. The server never simulates anything; the host
   player's browser does. In-game messages (any `t` not in the lobby protocol) are relayed as-is.

   Lobby protocol (client -> server): create, join, lobby, opt, start, end, leave
   Lobby protocol (server -> client): joined, lobby, start, end, left, closed, error */
import { gameById, defaultOpts, cleanOpts, teamById } from '../client/games/registry.js';
import { AVATARS, cleanName, cleanAvatar } from '../client/core/avatars.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const send = (ws, msg) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg)); };

export function createRooms({ addrHint, log = console.log }) {
  const rooms = new Map();   // code -> room
  let nextId = 1;

  function newCode() { let c; do { c = ''; for (let i = 0; i < 4; i++) c += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]; } while (rooms.has(c)); return c; }
  function broadcast(room, msg, except) { const data = JSON.stringify(msg); for (const p of room.players.values()) if (p.ws !== except && p.ws.readyState === p.ws.OPEN) p.ws.send(data); }
  function freeAvatar(room, want) { const taken = new Set([...room.players.values()].map(p => p.avatar)); if (want >= 0 && !taken.has(want)) return want; for (let i = 0; i < AVATARS.length; i++) if (!taken.has(i)) return i; return -1; }
  const playersOf = room => [...room.players.values()].map(p => ({ id: p.id, name: p.name, avatar: p.avatar, ready: p.ready, team: p.team }));
  /* team games: count a side, and pick the emptier side for a newcomer (ties go to the first side) */
  const teamCount = (room, id) => [...room.players.values()].filter(p => p.team === id).length;
  function balancedTeam(room) { const teams = room.game.teams; if (!teams) return null; let best = teams[0]; for (const t of teams) if (teamCount(room, t.id) < teamCount(room, best.id)) best = t; return best.id; }
  const lobbyMsg = room => ({ t: 'lobby', room: room.code, game: room.game.id, hostId: room.hostId, state: room.state, opts: room.opts, players: playersOf(room) });

  function joinRoom(ws, room, name, avatar) {
    const p = ws.meta; p.room = room; p.name = cleanName(name); p.avatar = freeAvatar(room, cleanAvatar(avatar)); p.ready = false; p.team = balancedTeam(room);
    room.players.set(p.id, p);
    send(ws, { t: 'joined', id: p.id, room: room.code, game: room.game.id, hostId: room.hostId, addr: addrHint() });
    broadcast(room, lobbyMsg(room));
  }
  function leaveRoom(ws) {
    const p = ws.meta, room = p.room; if (!room) return; p.room = null; room.players.delete(p.id);
    if (room.hostId === p.id || room.players.size === 0) {
      broadcast(room, { t: 'closed', reason: 'The host left the room' }); for (const o of room.players.values()) o.room = null; rooms.delete(room.code); log(`room ${room.code} closed`); return;
    }
    broadcast(room, { t: 'left', id: p.id }); broadcast(room, lobbyMsg(room));
  }

  function onMessage(ws, msg) {
    const p = ws.meta, room = p.room, isHost = room && room.hostId === p.id;
    switch (msg.t) {
      case 'create': {
        const game = gameById(msg.game); if (!game) { send(ws, { t: 'error', msg: 'Unknown game' }); break; }
        if (room) leaveRoom(ws);
        const r = { code: newCode(), game, hostId: p.id, state: 'lobby', opts: defaultOpts(game), players: new Map() };
        rooms.set(r.code, r); joinRoom(ws, r, msg.name, msg.avatar); log(`room ${r.code} (${game.id}) created by ${p.name}`); break;
      }
      case 'join': {
        const code = String(msg.room || '').trim().toUpperCase(); const r = rooms.get(code);
        if (!r) { send(ws, { t: 'error', msg: `Room ${code || '?'} not found` }); break; }
        if (r.state !== 'lobby') { send(ws, { t: 'error', msg: 'That game is already running - wait for it to finish' }); break; }
        if (r.players.size >= r.game.maxPlayers) { send(ws, { t: 'error', msg: 'Room is full' }); break; }
        if (room) leaveRoom(ws); joinRoom(ws, r, msg.name, msg.avatar); log(`${p.name} joined ${r.code}`); break;
      }
      case 'lobby': {
        if (!room) break;
        if (msg.name !== undefined) p.name = cleanName(msg.name);
        if (msg.avatar !== undefined) { const a = cleanAvatar(msg.avatar); if (a >= 0 && ![...room.players.values()].some(o => o !== p && o.avatar === a)) p.avatar = a; }
        if (msg.ready !== undefined) p.ready = !!msg.ready;
        if (msg.team !== undefined && room.game.teams) { // switch sides (until READY); a side holds at most teamSize players
          const t = teamById(room.game, msg.team);
          if (t && t.id !== p.team && !p.ready) { if (teamCount(room, t.id) >= (room.game.teamSize || Infinity)) send(ws, { t: 'error', msg: `${t.label} is full` }); else p.team = t.id; }
        }
        broadcast(room, lobbyMsg(room)); break;
      }
      case 'opt': if (isHost && room.state === 'lobby') { room.opts = cleanOpts(room.game, msg.opts, room.opts); broadcast(room, lobbyMsg(room)); } break;
      case 'start': {
        if (!isHost) break;
        if (room.players.size < room.game.minPlayers) { send(ws, { t: 'error', msg: `Needs at least ${room.game.minPlayers} players` }); break; }
        room.state = 'playing';
        const seed = (Math.random() * 0x100000000) >>> 0; // one seed per round, so games that generate their world agree on it
        broadcast(room, { t: 'start', players: playersOf(room), hostId: room.hostId, opts: room.opts, seed }); broadcast(room, lobbyMsg(room));
        log(`room ${room.code}: ${room.game.id} started with ${room.players.size} player(s)`); break;
      }
      case 'end': if (isHost) { room.state = 'lobby'; for (const o of room.players.values()) o.ready = false; broadcast(room, { t: 'end' }); broadcast(room, lobbyMsg(room)); } break;
      case 'leave': leaveRoom(ws); break;
      default: // in-game traffic: relay to the rest of the room (or to one recipient)
        if (!room) break; msg.from = p.id;
        if (msg.to !== undefined) { const o = room.players.get(msg.to); if (o) send(o.ws, msg); } else broadcast(room, msg, ws);
    }
  }

  function attach(wss) {
    wss.on('connection', ws => {
      ws.meta = { id: nextId++, ws, room: null, name: 'Player', avatar: 0, ready: false, team: null }; ws.isAlive = true;
      ws.on('pong', () => { ws.isAlive = true; });
      ws.on('message', raw => { let msg; try { msg = JSON.parse(raw); } catch { return; } if (!msg || typeof msg.t !== 'string') return; onMessage(ws, msg); });
      ws.on('close', () => leaveRoom(ws));
    });
    const heartbeat = setInterval(() => { for (const ws of wss.clients) { if (!ws.isAlive) { ws.terminate(); continue; } ws.isAlive = false; ws.ping(); } }, 15000);
    wss.on('close', () => clearInterval(heartbeat));
  }

  return { rooms, attach };
}
