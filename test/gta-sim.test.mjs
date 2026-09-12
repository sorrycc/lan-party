/* Fable Theft Auto's host simulation (sim.js) run headless: a stub world with nothing to bump into and pools that
   swallow every draw, so the rules (modes, the mark, the wanted level, the world events, the wire) can be checked
   in node without a browser. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSim, MODES, MARK_CASH_PER_S, MARK_BOUNTY, MARK_PICK_T, MARK_STARS, ESCAPE_BONUS, AIRDROP_T, AIRDROP_FALL, aimTol } from '../client/games/gta/sim.js';
import { parseBlock, parseMode } from '../client/games/gta/remote.js';
import { CAUSES, EVENT_KINDS, CAR_TYPES } from '../client/games/gta/entities.js';

const pool = () => ({ alloc() { return 0; }, release() {}, color() {}, hide() {}, set() {}, dirty() {} });
const stubWorld = () => ({ THREE, aabbs: [], nearAabbs: () => [], hasLOS: () => true, pickPool: pool(), pedPools: Array.from({ length: 7 }, pool), gunPool: pool(), carBody: pool(), carCabin: pool(), carWheel: pool(), carLight: pool(), dirtyDynamic() {} });
const players = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, avatar: i }));
const make = (n, opts = {}) => createSim({ W: stubWorld(), session: { players: players(n) }, opts: { minutes: 10, ...opts } });
const DT = 1 / 30;
const run = (sim, secs) => { for (let t = 0; t < secs; t += DT) sim.update(DT); };
const snapshot = (sim, i) => { sim.prepareNet(); const m = sim.snapshotFor({ id: 'p' + i, known: new Set(), pl: sim.players[i] }); sim.endNet(); return m; };

test('a room starts in the sandbox with a player, a car and the mission for everyone', () => {
  const sim = make(3);
  assert.equal(sim.mode, 'sandbox'); assert.equal(sim.mission.state, 'intro'); assert.ok(sim.mission.vinny);
  assert.equal(sim.players.length, 3); for (const pl of sim.players) assert.ok(pl.ped && !pl.ped.dead);
  run(sim, 1);
  const m = snapshot(sim, 1), md = parseMode(m.md), b = parseBlock(m.P[1]);
  assert.equal(md.mode, MODES.indexOf('sandbox')); assert.equal(md.mark, -1); assert.equal(md.we, null);
  assert.equal(b.cash, 250); assert.equal(b.killer, -1); assert.equal(b.cause, 0); assert.equal(b.markT, 0);
  assert.ok(m.p.length > 3 && m.v.length > 3, 'pedestrians and cars in the first snapshot');
});

test('who got you and how ride in your block, and a kill is announced to the room', () => {
  const sim = make(2); const [a, b] = sim.players;
  sim.debug.killPlayer(a, b, 'smg');
  const m = snapshot(sim, 0), blk = parseBlock(m.P[0]);
  assert.equal(blk.dead, true); assert.equal(blk.killer, 1); assert.equal(CAUSES[blk.cause], 'smg');
  assert.ok(m.ev.some(e => e[0] === 'kill' && e[1] === 1 && e[2] === 0), 'the kill event reaches everyone');
  assert.equal(b.kills, 1); assert.equal(b.wanted, 1, 'killing a player in the sandbox costs a star');
  sim.debug.killPlayer(b, null, 'cop');
  assert.equal(parseBlock(snapshot(sim, 1).P[1]).killer, -1); assert.equal(CAUSES[sim.players[1].cause], 'cop');
});

test('shaking off a five-star chase pays, turning yourself in does not', () => {
  const sim = make(1); const pl = sim.players[0]; const cash = pl.cash;
  sim.debug.addWanted(pl, 5); sim.debug.clearWanted(pl, 'lost');
  assert.equal(pl.cash, cash + ESCAPE_BONUS); assert.equal(pl.wanted, 0); assert.equal(pl.peak, 0);
  sim.debug.addWanted(pl, 5); sim.debug.clearWanted(pl, 'busted');
  assert.equal(pl.cash, cash + ESCAPE_BONUS, 'no bonus at the precinct');
  sim.debug.addWanted(pl, 3); sim.debug.clearWanted(pl, 'lost');
  assert.equal(pl.cash, cash + ESCAPE_BONUS, 'three stars are not a chase worth paying for');
});

test('Most Wanted: the mark is drawn, pays by the second, carries stars and moves to its killer without a star', () => {
  const sim = make(2, { mode: 'mostWanted', friendlyFire: false });
  assert.equal(sim.mode, 'mostWanted'); assert.equal(sim.mission.state, 'done'); assert.equal(sim.mission.vinny, null, 'no snitch to whack');
  run(sim, MARK_PICK_T - 1); assert.equal(sim.mark.idx, -1);
  run(sim, 1.2); assert.ok(sim.mark.idx === 0 || sim.mark.idx === 1, 'the mark is drawn after the intro');
  const h = sim.players[sim.mark.idx], o = sim.players[1 - sim.mark.idx], cash = h.cash;
  run(sim, 2);
  assert.ok(h.cash - cash > MARK_CASH_PER_S * 1.8 && h.cash - cash < MARK_CASH_PER_S * 2.3, 'the mark earns by the second');
  assert.equal(h.wanted, MARK_STARS, 'the mark always has the cops on it'); assert.ok(h.markT > 1.9);
  const oc = o.cash, ow = o.wanted;
  sim.debug.killPlayer(h, o, 'pistol');
  assert.equal(sim.mark.idx, o.idx, 'the killer takes the mark'); assert.equal(o.cash, oc + 100 + MARK_BOUNTY); assert.equal(o.wanted, ow, 'hunting the mark is legal');
  const md = parseMode(snapshot(sim, 0).md); assert.equal(md.mark, o.idx); assert.ok(md.markT < 0.1, 'the hold timer restarts');
  run(sim, 6); assert.ok(!h.ped.dead, 'the first mark is back from the hospital');
  sim.debug.killPlayer(o, null, 'cop');
  assert.equal(sim.mark.idx, h.idx, 'killed by the cops: the mark goes to another player');
});

test('Most Wanted needs two players: solo it is the sandbox', () => {
  const sim = make(1, { mode: 'mostWanted' });
  assert.equal(sim.mode, 'sandbox'); assert.equal(sim.mission.state, 'intro'); run(sim, MARK_PICK_T + 2); assert.equal(sim.mark.idx, -1);
});

test('the airdrop lands ten seconds in with its pickups, the armored truck spills cash when it goes', () => {
  const sim = make(2);
  assert.ok(sim.debug.startEvent('airdrop')); assert.equal(sim.WE.kind, 'airdrop');
  const loot = () => sim.pickups.filter(p => p.kind !== 'bribe').length; // the bribes grow on their own
  const before = loot(); run(sim, AIRDROP_FALL - 0.5); assert.equal(sim.WE.landed, false);
  run(sim, 1); assert.equal(sim.WE.landed, true); assert.equal(loot(), before + 12, 'cash, ammo and health around the crate');
  let md = parseMode(snapshot(sim, 0).md); assert.equal(md.we.kind, EVENT_KINDS.indexOf('airdrop')); assert.ok(md.we.landed); assert.ok(md.we.t < AIRDROP_T - AIRDROP_FALL);
  assert.equal(sim.debug.startEvent('truck'), false, 'one event at a time');
  sim.WE.t = 0; run(sim, 0.1); assert.equal(sim.WE.kind, null);
  assert.ok(sim.debug.startEvent('truck')); const truck = sim.WE.car; assert.ok(truck && truck.type.armored); assert.equal(truck.health, CAR_TYPES[7].hp);
  const cash = sim.pickups.filter(p => p.kind === 'cash').length;
  truck.damage(truck.hp); assert.ok(truck.dead);
  assert.ok(sim.pickups.filter(p => p.kind === 'cash').length >= cash + 12, 'the truck is open');
  md = parseMode(snapshot(sim, 0).md); assert.ok(md.we && md.we.landed, 'the event lingers over the spill');
});

test('four stars and driving: a roadblock waits at the next intersection', () => {
  const sim = make(1); const pl = sim.players[0];
  sim.action(pl, 'use'); assert.ok(pl.ped.inCar, 'into the car parked beside the spawn');
  sim.debug.addWanted(pl, 4); pl.ped.inCar.speed = 12;
  sim.debug.spawnRoadblock(pl);
  const block = sim.cars.filter(c => c.roadblock); assert.equal(block.length, 2);
  assert.equal(sim.cops.length, 4, 'two cops behind each car');
  for (const c of block) { const d = Math.hypot(c.x - pl.ped.x, c.z - pl.ped.z); assert.ok(d > 55 && d < 170, 'ahead, not on top of the player'); }
  sim.debug.spawnRoadblock(pl); assert.equal(sim.cars.filter(c => c.roadblock).length, 2, 'not twice in the same place');
});

test('a thumb gets a wider soft lock than a mouse', () => {
  for (const d of [5, 20, 60]) assert.ok(aimTol(d, true) > aimTol(d, false) * 1.5);
  assert.ok(aimTol(100, true) >= 0.16);
});
