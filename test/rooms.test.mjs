/* The lobby server with fake sockets: errors travel as codes, the host leaving hands the room on (and ends a running round),
   guests vote for a rematch, and custom room codes keep to the code alphabet. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRooms } from '../server/rooms.js';

function harness() {
  const wss = new EventEmitter(); wss.clients = new Set();
  const rooms = createRooms({ addrHint: () => 'http://test', log: () => {} }); rooms.attach(wss);
  const connect = () => {
    const ws = new EventEmitter(); ws.OPEN = 1; ws.readyState = 1; ws.inbox = [];
    ws.send = data => ws.inbox.push(JSON.parse(data)); ws.ping = () => {}; ws.terminate = () => {};
    wss.clients.add(ws); wss.emit('connection', ws);
    ws.say = msg => ws.emit('message', JSON.stringify(msg));
    ws.last = t => [...ws.inbox].reverse().find(m => m.t === t);
    return ws;
  };
  return { rooms, connect, done: () => wss.emit('close') };
}

test('errors are codes with vars, never sentences', () => {
  const h = harness(), a = h.connect();
  a.say({ t: 'join', room: 'ZZZZ', name: 'A' });
  assert.deepEqual(a.last('error'), { t: 'error', code: 'noRoom', vars: { code: 'ZZZZ' } });
  a.say({ t: 'create', room: 'OOPS', name: 'A', game: 'kart' }); // O is not in the code alphabet
  assert.equal(a.last('error').code, 'badCode');
  a.say({ t: 'create', room: 'ABCD', name: 'A', game: 'kart' });
  assert.equal(a.last('joined').room, 'ABCD');
  const b = h.connect(); b.say({ t: 'create', room: 'ABCD', name: 'B', game: 'kart' });
  assert.deepEqual(b.last('error'), { t: 'error', code: 'roomExists', vars: { code: 'ABCD' } });
  h.done();
});

test('the host leaving the lobby hands the room to the next player', () => {
  const h = harness(), a = h.connect(), b = h.connect(), c = h.connect();
  a.say({ t: 'create', name: 'A', game: 'kart' }); const code = a.last('joined').room;
  b.say({ t: 'join', room: code, name: 'B' }); c.say({ t: 'join', room: code, name: 'C' });
  a.say({ t: 'leave' });
  const lobby = b.last('lobby');
  assert.equal(lobby.hostId, b.meta.id);
  assert.equal(lobby.players.length, 2);
  assert.deepEqual(c.last('notice'), { t: 'notice', code: 'newHost', vars: { name: 'B' } });
  assert.equal(b.last('closed'), undefined);
  h.done();
});

test('the host leaving mid-round ends the round for the rest', () => {
  const h = harness(), a = h.connect(), b = h.connect();
  a.say({ t: 'create', name: 'A', game: 'kart' }); const code = a.last('joined').room;
  b.say({ t: 'join', room: code, name: 'B' }); a.say({ t: 'start' });
  assert.ok(b.last('start'));
  a.emit('close'); // the socket drops
  assert.ok(b.last('end'));
  const lobby = b.last('lobby');
  assert.equal(lobby.state, 'lobby'); assert.equal(lobby.hostId, b.meta.id);
  h.done();
});

test('guests vote for a rematch during a round; a new round clears the votes', () => {
  const h = harness(), a = h.connect(), b = h.connect(), c = h.connect();
  a.say({ t: 'create', name: 'A', game: 'kart' }); const code = a.last('joined').room;
  b.say({ t: 'join', room: code, name: 'B' }); c.say({ t: 'join', room: code, name: 'C' });
  b.say({ t: 'rematch' }); assert.equal(a.last('rematch'), undefined, 'no votes in the lobby');
  a.say({ t: 'start' });
  b.say({ t: 'rematch' }); assert.deepEqual(a.last('rematch').ids, [b.meta.id]);
  c.say({ t: 'rematch' }); assert.deepEqual(a.last('rematch').ids, [b.meta.id, c.meta.id]);
  b.say({ t: 'rematch', on: false }); assert.deepEqual(a.last('rematch').ids, [c.meta.id]);
  a.say({ t: 'rematch' }); assert.deepEqual(c.last('rematch').ids, [c.meta.id], 'the host does not vote');
  a.say({ t: 'start' }); c.inbox.length = 0; b.say({ t: 'rematch' }); assert.deepEqual(c.last('rematch').ids, [b.meta.id]);
  h.done();
});
