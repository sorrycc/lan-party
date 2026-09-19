/* Fable Theft Auto's rules around the edges, run headless like gta-sim.test.mjs: spawn protection that ends on the first shot,
   arena spawn points that two respawns never share, the host's END ROUND for an unlimited round, the free mark going to whoever
   is behind, Most Wanted's cut fares, and the wire carrying keys and places by number instead of sentences. */
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSim, GOD_T, SPAWN_CLAIM_T, MW_JOB_PAY, TAXI_PAY } from '../client/games/gta/sim.js';
import { farthestSpawn, arenaSpawns, arenaOf } from '../client/games/gta/arena.js';
import { TAXI_RANK, streetRef, streetName, districtRef, districtName, streetAt } from '../client/games/gta/world.js';
import { STR } from '../client/games/gta/strings.js';
import { setLang } from '../client/core/i18n.js';

/* the sim and the bots roll Math.random (the crowd, the traffic, aim errors, spread): each test runs on the same seeded sequence, so a
   result never depends on the luck of the draw (the thresholds still hold with room to spare on unseeded runs) */
const seeded = seed => { let s = seed >>> 0; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const realRandom = Math.random;
beforeEach(() => { Math.random = seeded(20260919); }); afterEach(() => { Math.random = realRandom; });
const pool = () => ({ alloc() { return 0; }, release() {}, color() {}, hide() {}, set() {}, dirty() {} });
const stubWorld = () => ({ THREE, aabbs: [], nearAabbs: () => [], hasLOS: () => true, pickPool: pool(), pedPools: Array.from({ length: 7 }, pool), gunPool: pool(), carBody: pool(), carCabin: pool(), carWheel: pool(), carLight: pool(), dirtyDynamic() {} });
const players = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, avatar: i }));
const make = (n, opts = {}, seed = 7) => createSim({ W: stubWorld(), session: { players: players(n), seed }, opts: { minutes: 10, fillAI: false, ...opts } });
const DT = 1 / 30;
const run = (sim, secs) => { for (let t = 0; t < secs; t += DT) sim.update(DT); };
const snapshot = (sim, i) => { sim.prepareNet(); const m = sim.snapshotFor({ id: 'p' + i, known: new Set(), pl: sim.players[i] }); sim.endNet(); return m; };

test('spawn protection keeps the damage off, but the first shot ends it', () => {
  const sim = make(2, { mode: 'deathmatch' }); const [a, b] = sim.players; a.godT = b.godT = 0;
  sim.debug.killPlayer(b, a, 'pistol'); run(sim, 5); assert.ok(!b.ped.dead, 'back'); assert.ok(b.godT > 0 && b.godT <= GOD_T, 'protected');
  sim.debug.damagePlayer(b, 30, a, 'pistol'); assert.equal(b.ped.health, 100, 'nothing gets through');
  b.fireT = 0; b.reloadT = 0; b.camYaw = 0; sim.debug.fireWeapon(b); assert.equal(b.godT, 0, 'shooting drops it');
  sim.debug.damagePlayer(b, 30, a, 'pistol'); assert.equal(b.ped.health, 70);
});

test('two respawns in the same tick never share a spawn point, and a point stays claimed for a moment', () => {
  const sp = arenaSpawns(arenaOf(7)), foes = [{ x: sp[0].x, z: sp[0].z }];
  const first = farthestSpawn(sp, foes), second = farthestSpawn(sp, foes, [first]);
  assert.notEqual(second, first); assert.equal(farthestSpawn(sp, foes, sp), first, 'all claimed: the farthest after all');
  const sim = make(4, { mode: 'deathmatch' }); for (const p of sim.players) p.godT = 0; const [a, b, c] = sim.players;
  sim.debug.killPlayer(b, a, 'pistol'); sim.debug.killPlayer(c, a, 'pistol'); run(sim, 5);
  assert.ok(!b.ped.dead && !c.ped.dead); assert.ok(Math.hypot(b.ped.x - c.ped.x, b.ped.z - c.ped.z) > 5, 'apart');
  assert.ok(SPAWN_CLAIM_T >= 1);
});

test('an unlimited round never ends by itself, and the host ends it with the results and the awards', () => {
  for (const mode of ['sandbox', 'mostWanted', 'deathmatch']) {
    const sim = make(2, { mode, minutes: 0 }); run(sim, 3); assert.equal(sim.S.phase, 'play', mode + ' runs on');
    snapshot(sim, 0); sim.endRound(); assert.equal(sim.S.phase, 'over');
    const ov = snapshot(sim, 1).ev.find(e => e[0] === 'over'); assert.ok(ov && Array.isArray(ov[1]), mode + ': the over event with the awards reaches everyone');
    sim.endRound(); assert.equal(snapshot(sim, 1).ev.filter(e => e[0] === 'over').length, 0, 'and only once');
  }
});

test('Most Wanted: a mark the cops took goes to someone behind, never the cash leader while others can take it', () => {
  const sim = make(3, { mode: 'mostWanted' }); const [a, b, c] = sim.players; for (const p of sim.players) p.godT = 0;
  run(sim, 9); a.cash = 3000; b.cash = 200; c.cash = 900;
  const got = { 0: 0, 1: 0, 2: 0 };
  for (let k = 0; k < 300; k++) got[sim.debug.underdog(null)]++;
  assert.equal(got[0], 0, 'never the leader'); assert.ok(got[1] > got[2], 'the poorest likelier: ' + JSON.stringify(got));
  sim.debug.setMark(c.idx, 'kill'); sim.debug.killPlayer(c, null, 'cop'); assert.equal(sim.mark.idx, b.idx, 'with the leader out, the only one left behind it');
  const two = make(2, { mode: 'mostWanted' }); run(two, 9); two.players[0].cash = 5000; assert.equal(two.debug.underdog(two.players[1]), 0, 'nobody else: the leader after all');
});

test('Most Wanted cuts the fares: a delivery pays its share of the sandbox price', () => {
  const pay = mode => {
    const sim = make(2, { mode }); const pl = sim.players[0], P = pl.ped; P.x = TAXI_RANK.x - 3; P.z = TAXI_RANK.z; run(sim, 0.05); sim.action(pl, 'use');
    const c = pl.ped.inCar; run(sim, 1.8); const fare = pl.job.fare; fare.x = c.x + 40; fare.z = c.z;
    const stop = (x, z) => { c.x = x; c.z = z; c.vx = c.vz = 0; c.vF = 0; c.speed = 0; c.angVel = 0; run(sim, 0.2); };
    stop(fare.x + 2, fare.z); const j = pl.job, d = j.dist; return { pay: j.pay, raw: TAXI_PAY[0] + d * TAXI_PAY[1] };
  };
  const sb = pay('sandbox'), mw = pay('mostWanted');
  assert.equal(sb.pay, Math.round(sb.raw)); assert.equal(mw.pay, Math.round(mw.raw * MW_JOB_PAY), 'the share of the unrounded price, as the sim takes it'); assert.ok(mw.pay < sb.pay);
});

test('the wire carries keys and numbers: every float is a strings.js key with its vars, a world event has no sentence, places are named on each screen', () => {
  const sim = make(2); const [a, b] = sim.players; a.godT = b.godT = 0; snapshot(sim, 0);
  sim.debug.killPlayer(b, a, 'pistol'); sim.debug.addWanted(a, 5); sim.debug.clearWanted(a, 'lost'); sim.debug.addWanted(a, 2); sim.debug.surrender(a);
  assert.ok(sim.debug.startEvent('truck'));
  const m = snapshot(sim, 0), floats = m.ev.filter(e => e[0] === 'float');
  assert.ok(floats.length >= 4, 'floats: ' + floats.length);
  for (const f of floats) { assert.ok(f[2] in STR.en && f[2] in STR.zh, 'a key: ' + f[2]); assert.equal(typeof f[3], 'number'); if (f[4]) assert.equal(typeof f[4], 'object'); }
  const w = floats.find(f => f[2] === 'f.wasted'); assert.deepEqual(w[4], { p: 1 }, 'the victim by index, named where it is shown');
  const we = m.ev.find(e => e[0] === 'wevent'); assert.equal(we.length, 4, 'kind, x, z: no sentence'); assert.equal(typeof we[1], 'number');
  const ref = streetRef(we[2], we[3]); setLang('en'); const en = streetName(ref); setLang('zh'); const zh = streetName(ref);
  assert.equal(en, streetAt(we[2], we[3]), 'the English name is the world\'s'); assert.notEqual(zh, en, 'and it has a Chinese one'); assert.ok(districtName(districtRef(0, 0)).length > 1);
});
