/* Sundown Showdown without a browser: the seeded arena, the roster and the wire format, and the host's simulation
   played through to a result. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMap, N, BOX, CRATE, E, SPAWNS, ti, blocksMove } from '../client/games/showdown/map.js';
import { buildRoster, packBrawler, unpackBrawler, createSnapGuard, cleanInput, cleanPick, MAX_BRAWLERS } from '../client/games/showdown/net.js';
import { createSim, CLASSES, STEP, GO_AT } from '../client/games/showdown/sim.js';
import { AVATARS } from '../client/core/avatars.js';

const wire = msg => JSON.parse(JSON.stringify(msg)); // what actually crosses the network
const lcg = (s = 1) => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const session = (n = 1, opts = {}, seed = 12345) => ({ players: Array.from({ length: n }, (_, k) => ({ id: k + 1, name: 'P' + (k + 1), avatar: k })), opts, seed });
function newSim(n = 1, opts = {}, seed = 12345) { const s = session(n, opts, seed), map = makeMap(seed), roster = buildRoster(s); return createSim({ map, roster, opts, online: n > 1, rand: lcg(seed) }); }
const run = (S, seconds, each) => { for (let k = 0; k < seconds / STEP; k++) { S.step(STEP); each?.(); } };
function toPlay(S) { S.roster.forEach((r, i) => { if (r.human) S.pick(i, i % CLASSES.length, true); }); run(S, GO_AT + .1); S.events.length = 0; assert.equal(S.state, 'play'); return S; }

test('a seed always gives the same arena, mirrored through the centre, with every spawn reachable', () => {
  const a = makeMap(777), b = makeMap(777), c = makeMap(778);
  assert.deepEqual([...a.tiles], [...b.tiles]); assert.deepEqual(a.spawns, b.spawns); assert.notDeepEqual([...a.tiles], [...c.tiles]);
  assert.equal(a.spawns.length, SPAWNS); assert.ok(a.spawns.every(s => !blocksMove(a.tileAt(s.x, s.z))));
  assert.equal(a.boxes.length, 16); assert.ok(a.boxes.every((q, k) => q.k === k && a.tiles[ti(q.i, q.j)] === BOX));
  for (const q of a.boxes) assert.equal(a.tiles[ti(N - 1 - q.i, N - 1 - q.j)], BOX, 'every power box has a twin opposite');
});

test('a body slides along a wall and a bull rush breaks the crates in its way', () => {
  const map = makeMap(5), k = [...map.tiles].indexOf(CRATE), i = k % N, j = (k / N) | 0, broken = [];
  const b = { x: (i + .5) * 2 - N, z: (j + .5) * 2 - N - 2.5, r: .78 }; map.tiles[ti(i, j - 1)] = E; map.tiles[ti(i, j - 2)] = E;
  assert.equal(map.moveBy(b, 0, 3), true); assert.ok(b.z < (j + .5) * 2 - N - 1.7, 'stopped at the crate');
  map.moveBy(b, 0, 3, (ci, cj) => { broken.push([ci, cj]); map.tiles[ti(ci, cj)] = E; }); assert.deepEqual(broken[0], [i, j]);
});

test('humans take the first slots in their colours and CPU brawlers fill the showdown to ten', () => {
  const r = buildRoster({ players: [{ id: 7, name: 'ZOE', avatar: 3 }, { id: 2, name: 'ABE', avatar: 1 }], opts: {}, seed: 9 });
  assert.equal(r.length, MAX_BRAWLERS); assert.deepEqual(r.slice(0, 2).map(p => p.name), ['ABE', 'ZOE']); assert.equal(r[1].color, AVATARS[3].color);
  assert.deepEqual(r.map(p => p.human), [true, true, ...Array(8).fill(false)]); assert.ok(r.slice(2).every(p => p.cls >= 0 && p.pid === null));
  assert.equal(new Set(r.slice(2).map(p => p.name)).size, 8);
  assert.deepEqual(buildRoster({ players: [{ id: 7, name: 'ZOE', avatar: 3 }, { id: 2, name: 'ABE', avatar: 1 }], opts: {}, seed: 9 }), r, 'the same on every machine');
  assert.equal(buildRoster(session(1, { fillAI: false })).length, 2, 'a lone player still gets one to fight');
  assert.equal(buildRoster(session(3, { fillAI: false })).length, 3);
});

test('a brawler, an input and a pick survive the wire; stale snapshots do not', () => {
  const b = { x: 1.2345, z: -7.5, dir: 3.14159, mvx: 7.3, mvz: 0, hp: 2599.2, maxhp: 3000, cubes: 1, ammo: 2.456, sup: .5, alive: true, inGrass: true, reveal: 0, dash: { t: .1 }, human: true, kills: 2, cls: 3, ack: 41 };
  const s = unpackBrawler(wire(packBrawler(b)));
  assert.deepEqual(s, { x: 1.23, z: -7.5, dir: 3.14, mvx: 7.3, mvz: 0, hp: 2600, maxhp: 3000, cubes: 1, ammo: 2.46, sup: .5, alive: true, inGrass: true, revealed: false, dash: true, human: true, kills: 2, cls: 3, ack: 41 });
  assert.equal(unpackBrawler('junk'), null);
  const inp = cleanInput({ x: 3, y: 4, a: 'x', d: 999, f: 1, q: 7.9 }); assert.ok(Math.abs(Math.hypot(inp.mx, inp.mz) - 1) < 1e-9); assert.equal(inp.a, 0); assert.equal(inp.d, 40); assert.equal(inp.fire, true); assert.equal(inp.q, 7);
  assert.deepEqual(cleanPick({ c: 99, ok: 1 }), { cls: 3, ok: true });
  const g = createSnapGuard(5); assert.ok(g.accept({ mid: 5, q: 1 })); assert.ok(!g.accept({ mid: 5, q: 1 })); assert.ok(!g.accept({ mid: 4, q: 9 })); assert.ok(g.accept({ mid: 5, q: 3 }));
});

test('the pick screen waits for every human online, then counts down to the fight', () => {
  const S = newSim(2); run(S, 1); assert.equal(S.state, 'pick');
  S.pick(0, 2, true); S.pick(0, 1, true); run(S, .1); assert.equal(S.state, 'pick'); assert.equal(S.picks[0].cls, 2, 'a locked pick stays');
  S.toAI(1); run(S, .1); assert.equal(S.state, 'countdown', 'a player who left no longer holds the room up'); assert.equal(S.brawlers[0].cls, 2); assert.equal(S.brawlers[1].human, false);
  const ev = []; run(S, GO_AT, () => { ev.push(...S.events.map(e => e[0])); S.events.length = 0; }); assert.deepEqual(ev, ['c', 'c', 'c', 'go']); assert.equal(S.state, 'play');
  const T = newSim(2); run(T, 20.1); assert.notEqual(T.state, 'pick', 'the clock locks everyone in');
});

test('a human moves by its stick, shoots where it aims, and a shot released during the cooldown still comes out', () => {
  const S = toPlay(newSim(1)), b = S.brawlers[0], x0 = b.x, z0 = b.z, a = Math.atan2(-b.x, -b.z);
  S.setInput(0, { mx: Math.sin(a), mz: Math.cos(a), a, d: 6, fire: false, q: 5 }); run(S, .5); assert.equal(b.ack, 5);
  assert.ok(Math.hypot(b.x - x0, b.z - z0) > 1, 'walked toward the middle');
  S.setInput(0, { mx: 0, mz: 0, a, d: 6, fire: false, q: 6 }); S.queueFire(0, { a, d: 6 }); S.step(STEP); assert.ok(b.ammo < 3 && b.ammo > 1.9); assert.ok(S.events.some(e => e[0] === 'a' && e[1] === 0));
  S.queueFire(0, { a, d: 6 }); S.step(STEP); assert.ok(b.ammo > 1.9, 'still cooling down'); run(S, b.c.cd); assert.ok(b.ammo < 1.9, 'the queued shot came out');
  S.queueSuper(0, { a, d: 6 }); assert.equal(b.supQ, null, 'no super without the charge'); b.sup = 1; S.queueSuper(0, { a, d: 6 }); S.step(STEP); assert.equal(b.sup, 0);
});

test('damage charges the super, a kill drops cubes, and a cube is health and damage', () => {
  const S = toPlay(newSim(1)), [me, foe] = S.brawlers; S.damage(foe, 1100, me); assert.equal(me.sup, 1100 / me.c.need); assert.equal(me.dealt, 1100);
  S.damage(foe, 99999, me); assert.equal(foe.alive, false); assert.equal(foe.rank, S.brawlers.length); assert.equal(me.kills, 1);
  const q = S.events.find(e => e[0] === 'q'); assert.ok(q); assert.ok(S.events.some(e => e[0] === 'k' && e[1] === foe.i && e[2] === me.i));
  me.x = q[4]; me.z = q[5]; const hp = me.maxhp; run(S, .6); assert.ok(me.cubes >= 1); assert.equal(me.maxhp, hp + 400 * me.cubes);
});

test('the gas waits sixteen seconds, then closes in and hurts whoever is outside it', () => {
  const S = toPlay(newSim(1)), me = S.brawlers[0]; me.hp = me.maxhp = 1e9; let warned = false;
  run(S, 25, () => { warned ||= S.events.some(e => e[0] === 'g'); S.events.length = 0; }); assert.ok(warned); assert.ok(S.gas.r < 52 && S.gas.stage === 1);
  me.x = 0; me.z = S.gas.r + 3; const hp = me.hp; run(S, 1); assert.ok(me.hp < hp);
});

test('a whole showdown plays out: brawlers fall and the standings name everyone once', () => {
  const S = toPlay(newSim(1, { botSkill: 'hard' }, 4242)), seen = {}; let n = 0;
  while (S.state !== 'result' && n++ < 60 * 300) { S.step(STEP); for (const e of S.events) seen[e[0]] = (seen[e[0]] || 0) + 1; S.events.length = 0; }
  assert.equal(S.state, 'result'); for (const k of ['a', 'd', 'k', 'q']) assert.ok(seen[k] > 0, k + ' happened');
  assert.deepEqual(S.result.map(r => r[1]), S.result.map((_, k) => k + 1), 'ranks 1..n'); assert.equal(new Set(S.result.map(r => r[0])).size, S.brawlers.length);
  for (const b of S.brawlers) assert.ok(Number.isFinite(b.x) && Number.isFinite(b.z) && !blocksMove(S.map.tileAt(b.x, b.z)) || !b.alive);
});
