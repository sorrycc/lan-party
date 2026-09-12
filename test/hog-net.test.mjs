/* Hog the Throne's roster and wire format: the same pigs on every machine, a lossless pig round trip, and the snapshot
   guard that keeps a straggler from the finished match away from the next one after PLAY AGAIN. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRoster, packPig, unpackPig, createSnapGuard, cleanWish, MAX_PIGS, HATS } from '../client/games/hog/net.js';
import { AVATARS } from '../client/core/avatars.js';

const wire = msg => JSON.parse(JSON.stringify(msg)); // what actually crosses the network

test('humans take the first slots sorted by id and CPU pigs fill the rest', () => {
  const r = buildRoster({ players: [{ id: 7, name: 'ZOE', avatar: 3 }, { id: 2, name: 'ABE', avatar: 1 }], myId: 7, opts: {} });
  assert.equal(r.length, MAX_PIGS);
  assert.deepEqual(r.map(p => p.name), ['ABE', 'ZOE', 'HAMLET', 'PORKY']);
  assert.deepEqual(r.map(p => p.human), [true, true, false, false]);
  assert.deepEqual(r.map(p => p.i), [0, 1, 2, 3]);
  assert.deepEqual(r.map(p => p.hat), HATS.map(h => h.id), 'one hat per slot');
  assert.equal(r[0].color, AVATARS[1].color); assert.equal(r[1].color, AVATARS[3].color);
  assert.equal(new Set(r.map(p => p.color)).size, 4, 'a CPU never wears a colour a player picked');
});

test('without CPU fill a lone player still gets one pig to bump, and a full room gets none', () => {
  const solo = buildRoster({ players: [{ id: 'me', name: 'ME', avatar: 0 }], opts: { fillAI: false } });
  assert.deepEqual(solo.map(p => p.human), [true, false]);
  const full = buildRoster({ players: [1, 2, 3, 4, 5].map(id => ({ id, name: 'P' + id, avatar: id % 8 })), opts: {} });
  assert.equal(full.length, MAX_PIGS); assert.ok(full.every(p => p.human));
});

test('a pig survives the wire', () => {
  const pig = { body: { position: { x: 1.2345, y: -0.5, z: 3 }, quaternion: { x: 0, y: 0.7071, z: 0, w: 0.7071 }, velocity: { x: 6.8, y: -2.25, z: 0 } },
    out: false, inWorld: true, dash: 0.1, grounded: 3, human: true, stun: 0, balloons: 2, truffles: 5, throne: 12.34, bank: 3, hits: 1, respawn: -1 };
  const s = unpackPig(wire(packPig(pig)));
  assert.equal(s.x, 1.235); assert.equal(s.y, -0.5); assert.equal(s.qy, 0.707); assert.equal(s.vx, 6.8);
  assert.equal(s.out, false); assert.equal(s.inWorld, true); assert.equal(s.dash, true); assert.equal(s.grounded, true); assert.equal(s.human, true); assert.equal(s.stun, false);
  assert.equal(s.balloons, 2); assert.equal(s.truffles, 5); assert.equal(s.throne, 12.34); assert.equal(s.bank, 3); assert.equal(s.hits, 1); assert.equal(s.respawn, -1);
  pig.out = true; pig.inWorld = false; pig.dash = 0; pig.stun = 0.4; pig.human = false;
  const t = unpackPig(wire(packPig(pig)));
  assert.equal(t.out, true); assert.equal(t.inWorld, false); assert.equal(t.dash, false); assert.equal(t.stun, true); assert.equal(t.human, false);
  assert.equal(unpackPig('junk'), null);
});

test('the snapshot guard takes the current match in order and drops a straggler from the last one', () => {
  const g = createSnapGuard(0xB0B);
  assert.equal(g.accept({ mid: 0xB0B, q: 1 }), true);
  assert.equal(g.accept({ mid: 0xB0B, q: 1 }), false, 'a duplicate');
  assert.equal(g.accept({ mid: 0xB0B, q: 3 }), true);
  assert.equal(g.accept({ mid: 0xB0B, q: 2 }), false, 'out of order');
  assert.equal(g.accept({ mid: 0xA11CE, q: 4031 }), false, 'the old match, far ahead');
  assert.equal(g.lastSeq, 3, 'the straggler did not poison the sequence');
  assert.equal(g.accept({ mid: 0xB0B, q: 4 }), true);
  assert.equal(g.accept({ q: 5 }), true, 'an unstamped snapshot (an older build) is followed');
  assert.equal(g.accept(null), false);
});

test('a wish from the wire is clamped and boolean', () => {
  assert.deepEqual(cleanWish({ x: 2, y: -0.5, j: 1 }), { mx: 1, mz: -0.5, jump: true });
  assert.deepEqual(cleanWish({ x: 'no', y: undefined }), { mx: 0, mz: 0, jump: false });
});
