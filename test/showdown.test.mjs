/* Sundown Showdown without a browser: the seeded arena, the roster and the wire format, and the host's simulation
   played through to a result. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMap, N, BOX, CRATE, E, SPAWNS, ti, blocksMove } from '../client/games/showdown/map.js';
import { buildRoster, packBrawler, unpackBrawler, createSnapGuard, cleanInput, cleanPick, MAX_BRAWLERS } from '../client/games/showdown/net.js';
import { createSim, CLASSES, BULLETS, STEP, GO_AT, TURRET, FIRE_ZONE, BURN_TIME, BURN_DMG, STEALTH_TIME, SLOW_MUL, hiddenFrom, moveMul } from '../client/games/showdown/sim.js';
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
  assert.equal(new Set(r.slice(2).map(p => p.name)).size, 8); assert.equal(new Set(r.slice(2).map(p => p.cls)).size, 8, 'no two CPU brawlers alike');
  assert.deepEqual(buildRoster({ players: [{ id: 7, name: 'ZOE', avatar: 3 }, { id: 2, name: 'ABE', avatar: 1 }], opts: {}, seed: 9 }), r, 'the same on every machine');
  assert.equal(buildRoster(session(1, { fillAI: false })).length, 2, 'a lone player still gets one to fight');
  assert.equal(buildRoster(session(3, { fillAI: false })).length, 3);
});

test('a brawler, an input and a pick survive the wire; stale snapshots do not', () => {
  const b = { x: 1.2345, z: -7.5, dir: 3.14159, mvx: 7.3, mvz: 0, hp: 2599.2, maxhp: 3000, cubes: 1, ammo: 2.456, sup: .5, alive: true, inGrass: true, reveal: 0, dash: { t: .1 }, human: true, kills: 2, cls: 9, ack: 41, fx: { slow: .4, stun: 0, burn: 1, stealth: 0, haste: 2 } };
  const s = unpackBrawler(wire(packBrawler(b)));
  assert.deepEqual(s, { x: 1.23, z: -7.5, dir: 3.14, mvx: 7.3, mvz: 0, hp: 2600, maxhp: 3000, cubes: 1, ammo: 2.46, sup: .5, alive: true, inGrass: true, revealed: false, dash: true, human: true, slow: true, stun: false, burn: true, stealth: false, haste: true, kills: 2, cls: 9, ack: 41 });
  assert.equal(unpackBrawler('junk'), null);
  const inp = cleanInput({ x: 3, y: 4, a: 'x', d: 999, f: 1, q: 7.9 }); assert.ok(Math.abs(Math.hypot(inp.mx, inp.mz) - 1) < 1e-9); assert.equal(inp.a, 0); assert.equal(inp.d, 40); assert.equal(inp.fire, true); assert.equal(inp.q, 7);
  assert.deepEqual(cleanPick({ c: 99, ok: 1 }), { cls: CLASSES.length - 1, ok: true });
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

/* ---- the brawlers' own tricks. A duel: two brawlers of the classes asked for on a cleared strip of sand, the second one standing
   still (it is flagged human, so no CPU brain moves it), `gap` metres apart along x. */
const cid = id => CLASSES.findIndex(c => c.id === id), dmgOf = id => CLASSES[cid(id)].dmg;
function duel(a, b, gap = 5) {
  const S = newSim(1, { fillAI: false }); S.picks[1].cls = cid(b); S.pick(0, cid(a), true); run(S, GO_AT + .1); assert.equal(S.state, 'play');
  for (let j = 3; j <= 9; j++) for (let i = 3; i <= 26; i++) S.map.tiles[ti(i, j)] = E;
  const [me, foe] = S.brawlers; foe.human = true; me.x = -24; foe.x = -24 + gap; me.z = foe.z = -24; me.dir = foe.dir = Math.PI / 2; S.events.length = 0; return { S, me, foe, east: Math.PI / 2 };
}
const hurt = (S, i) => S.events.filter(e => e[0] === 'd' && e[1] === i).map(e => e[2]);

test('every brawler has its words in both languages, a bullet, an aim shape and a super', async () => {
  const { STR } = await import('../client/games/showdown/strings.js'), S = duel('buck', 'buck').S;
  for (const c of CLASSES) {
    for (const k of ['n.', 'role.', 'atk.', 'sup.', 'pas.']) for (const l of ['zh', 'en']) assert.ok(STR[l][k + c.id], `${l} ${k}${c.id}`);
    assert.ok(c.lob || c.melee || BULLETS[c.bk], c.id + ' fires something'); assert.ok(c.aim && c.supAim && c.mz > 0 && c.snd);
  }
  for (const c of CLASSES) { const b = duel(c.id, 'brick', 4); b.me.sup = 1; assert.equal(b.S.superAttack(b.me, b.east, 4), true, c.id + ' super'); run(b.S, 1.5); }
  assert.ok(S);
});

test('FROST: a shard slows, the slow wears off, and the super freezes whoever it lands on', () => {
  const { S, me, foe, east } = duel('frost', 'viper', 6); foe.hp = foe.maxhp = 1e6; assert.equal(S.attack(me, east, 6), true); run(S, .4);
  assert.ok(foe.fx.slow > 0, 'slowed'); assert.equal(hurt(S, 1)[0], dmgOf('frost')); assert.equal(moveMul({ slow: true }), SLOW_MUL);
  const x0 = foe.x; S.setInput(1, { mx: 1, mz: 0, a: 0, d: 6, fire: false, q: 1 }); run(S, .5); const slowWalk = foe.x - x0; run(S, 1.5); assert.equal(foe.fx.slow, 0);
  const x1 = foe.x; run(S, .5); assert.ok(slowWalk < (foe.x - x1) * .75, 'walked slower while slowed'); S.setInput(1, { mx: 0, mz: 0, a: 0, d: 6, fire: false, q: 2 });
  foe.x = me.x + 6; S.events.length = 0; S.attack(me, east, 6); run(S, .5); assert.equal(hurt(S, 1)[0], dmgOf('frost'), 'the hit that slows is not yet boosted'); S.events.length = 0; S.attack(me, east, 6); run(S, .5); assert.equal(hurt(S, 1)[0], Math.round(dmgOf('frost') * 1.15), 'the passive: harder on the slowed');
  me.sup = 1; S.superAttack(me, east, Math.hypot(foe.x - me.x, foe.z - me.z)); run(S, 1.1); assert.ok(foe.fx.stun > 0, 'frozen'); assert.equal(S.attack(foe, 0, 6), false, 'a stunned brawler cannot shoot');
  const x2 = foe.x; S.setInput(1, { mx: 1, mz: 0, a: 0, d: 6, fire: false, q: 3 }); run(S, .2); assert.ok(Math.abs(foe.x - x2) < 1.5, 'nor walk'); run(S, 1.5); assert.equal(foe.fx.stun, 0);
});

test('BLAZE: flames burn for a while to the credit of whoever lit them, the ring of fire burns what stands in it, and BLAZE does not catch', () => {
  const { S, me, foe, east } = duel('blaze', 'viper', 3); S.attack(me, east, 3); run(S, .3); assert.ok(foe.fx.burn > 0); const hp = foe.hp, dealt = me.dealt;
  run(S, BURN_TIME + .2); assert.equal(foe.fx.burn, 0); assert.ok(foe.hp < hp || foe.hp === foe.maxhp); assert.ok(me.dealt >= dealt + BURN_DMG * 5, 'five ticks at least');
  me.sup = 1; S.events.length = 0; S.superAttack(me, east, 3); const z = S.events.find(e => e[0] === 'z'); assert.ok(z); assert.equal(S.zones.length, 1);
  foe.hp = foe.maxhp = 1e6; const h0 = foe.hp; run(S, 1.2); assert.ok(h0 - foe.hp >= FIRE_ZONE.dmg * 2); run(S, FIRE_ZONE.dur); assert.equal(S.zones.length, 0);
  const d = duel('blaze', 'blaze', 3); d.S.attack(d.me, d.east, 3); run(d.S, .3); assert.equal(d.foe.fx.burn, 0, 'the passive');
});

test('SHADE: the super hides it anywhere, a strike from out of sight hits harder and gives it away, and so does being hurt', () => {
  const { S, me, foe, east } = duel('shade', 'brick', 5); assert.equal(hiddenFrom(me, 8), false); me.sup = 1; S.superAttack(me, east, 5); S.step(STEP);
  assert.ok(me.stealth && me.fx.haste > 0); assert.equal(hiddenFrom(me, 8), true); assert.equal(hiddenFrom(me, 2), false, 'not at arm\'s length');
  S.events.length = 0; S.attack(me, east, 5); assert.equal(me.stealth, false); run(S, .4); assert.deepEqual(hurt(S, 1), Array(3).fill(Math.round(dmgOf('shade') * 1.4)), 'three knives, each 40% harder');
  me.sup = 1; S.superAttack(me, east, 5); S.damage(me, 10, foe); assert.equal(me.stealth, false);
  me.sup = 1; S.superAttack(me, east, 5); run(S, STEALTH_TIME + .1); assert.equal(me.stealth, false, 'it wears off');
});

test('HOOK: the chain goes through, the hook drags its catch in stunned, and an anchor is hard to shove', () => {
  const { S, me, foe, east } = duel('hook', 'viper', 10); me.sup = 1; S.superAttack(me, east, 10); run(S, 1);
  assert.ok(S.events.some(e => e[0] === 'hk' && e[1] === 1 && e[2] === 0)); assert.ok(Math.hypot(foe.x - me.x, foe.z - me.z) < 3, 'dragged in'); assert.equal(foe.pull, null); assert.equal(hurt(S, 1)[0], 500);
  const d = duel('brick', 'hook', 3), e = duel('brick', 'viper', 3); for (const q of [d, e]) { q.foe.hp = q.foe.maxhp = 1e6; q.S.attack(q.me, q.east, 3); run(q.S, .5); }
  assert.ok(d.foe.x - d.me.x < e.foe.x - e.me.x - .1, 'shoved less far');
});

test('DASH: the roll covers ground, hurts nobody and reloads; a kill is a rush', () => {
  const { S, me, foe, east } = duel('dash', 'viper', 4); me.ammo = 0; me.sup = 1; const x0 = me.x, hp = foe.hp; S.superAttack(me, east, 4); assert.equal(me.ammo, 3); run(S, .5);
  assert.ok(me.x - x0 > 5 && !me.dash); assert.equal(foe.hp, hp); assert.equal(me.fx.haste, 0); S.damage(foe, 1e6, me); assert.ok(me.fx.haste > 2.9);
});

test('SPARKY: the turret shoots for its owner, can be shot down, runs out, and a cube charges the super', () => {
  const { S, me, foe, east } = duel('sparky', 'viper', 7); foe.hp = foe.maxhp = 1e6; me.sup = 1; S.events.length = 0; S.superAttack(me, east, 3);
  const tu = S.events.find(e => e[0] === 'tu'); assert.ok(tu); assert.equal(S.turrets.length, 1); const t = S.turrets[0], dealt = me.dealt; run(S, 3);
  assert.ok(S.events.some(e => e[0] === 'ta' && e[1] === t.id)); assert.ok(me.dealt >= dealt + TURRET.dmg * 2, 'its hits are the owner\'s');
  me.sup = 1; S.superAttack(me, east, 5); assert.equal(S.turrets.filter(q => q.alive).length, 1, 'one turret a brawler');
  const t2 = S.turrets.find(q => q.alive); S.damage(t2, TURRET.hp + 1, foe); run(S, .1); assert.equal(S.turrets.length, 0); assert.ok(S.events.some(e => e[0] === 'tx' && e[1] === t2.id));
  me.sup = 1; S.superAttack(me, east, 5); run(S, TURRET.life + .2); assert.equal(S.turrets.length, 0, 'it runs out');
  me.sup = 1; S.superAttack(me, east, 5); S.damage(me, 1e6, foe); run(S, .1); assert.equal(S.turrets.length, 0, 'and goes with its owner');
  const d = duel('sparky', 'viper', 7); d.S.cubes.push({ id: 999, x0: d.me.x, z0: d.me.z, x1: d.me.x, z1: d.me.z, t: 1 }); run(d.S, .1); assert.equal(d.me.cubes, 1); assert.equal(d.me.sup, .25);
});

test('RICO: a shot comes off a wall once, harder, and the same way on every machine', () => {
  const { S, me, foe } = duel('rico', 'viper', 6); foe.x = me.x; foe.z = me.z + 6; foe.hp = foe.maxhp = 1e6; // the foe stands south; the shot goes west into the arena's wall and comes back
  const map = S.map, q = { x: -34.2, z: -24, vx: -10, vz: 3 }; map.bounce(q, -33.8, -24.1); assert.deepEqual([q.x, q.z, q.vx, q.vz], [-33.8, -24.1, 10, 3]);
  const c = { x: -34.2, z: -34.2, vx: -5, vz: -5 }; map.bounce(c, -33.9, -33.9); assert.deepEqual([c.vx, c.vz], [5, 5], 'a corner sends it back');
  me.x = -30; foe.x = -27; foe.z = me.z; S.events.length = 0; S.attack(me, -Math.PI / 2, 6); run(S, .6);
  const bb = S.events.filter(e => e[0] === 'bb'); assert.equal(bb.length, 1); assert.equal(bb[0][6], 1); assert.ok(Math.abs(bb[0][4] - Math.PI / 2) < .05, 'now flying east');
  assert.equal(hurt(S, 0).length, 0, 'never its own'); assert.equal(hurt(S, 1)[0], Math.round(dmgOf('rico') * 1.25), 'the passive');
});

test('the first four have a passive too: BUCK point blank, VIPER steadied, BRICK when low', () => {
  let d = duel('buck', 'viper', 2.5); d.S.damage(d.foe, 100, d.me); d.foe.x += 6; d.S.damage(d.foe, 100, d.me); assert.deepEqual(hurt(d.S, 1), [115, 100]);
  d = duel('viper', 'brick', 8); d.S.attack(d.me, d.east, 8); run(d.S, 1.2); d.S.attack(d.me, d.east, 8); run(d.S, .4); assert.deepEqual(hurt(d.S, 1), [dmgOf('viper'), Math.round(dmgOf('viper') * 1.2)]);
  d = duel('viper', 'brick', 8); d.foe.hp = d.foe.maxhp * .3; d.S.damage(d.foe, 1000, d.me); assert.deepEqual(hurt(d.S, 1), [750]);
});
