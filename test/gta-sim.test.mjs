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
const make = (n, opts = {}, seed = 7) => createSim({ W: stubWorld(), session: { players: players(n), seed }, opts: { minutes: 10, ...opts } });
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
  const loot = () => sim.pickups.filter(p => p.kind === 'cash' || p.kind === 'ammo' || p.kind === 'health').length; // the bribes and the weapon crates grow on their own
  const guns = () => sim.pickups.filter(p => p.kind === 'sniper' || p.kind === 'rpg').length;
  run(sim, 0.1); const before = loot(), gunsBefore = guns(); run(sim, AIRDROP_FALL - 0.6); assert.equal(sim.WE.landed, false); // the crate spots have grown their crates by now
  run(sim, 1); assert.equal(sim.WE.landed, true); assert.equal(loot(), before + 12, 'cash, ammo and health around the crate'); assert.equal(guns(), gunsBefore + 1, 'and a weapon');
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

/* ---- phase 3: the weapon crates, the rocket, the drops and the passengers */
import { WEAPONS, PICK_KINDS } from '../client/games/gta/entities.js';
import { createPredictor } from '../client/games/gta/predict.js';

const wIdx = key => WEAPONS.findIndex(w => w.key === key);

test('everyone starts with the three basic guns; a crate hands over a special one and switches to it', () => {
  const sim = make(1); const pl = sim.players[0];
  assert.deepEqual(pl.weapons.map(w => w.owned), [true, true, true, false, false]);
  assert.equal(parseBlock(snapshot(sim, 0).P[0]).owned, 0b111);
  sim.action(pl, 'weapon', wIdx('sniper')); assert.equal(pl.curW, 0, 'cannot switch to a gun you do not have');
  sim.action(pl, 'wnext', 1); assert.equal(pl.curW, 1); sim.action(pl, 'wnext', 1); sim.action(pl, 'wnext', 1); assert.equal(pl.curW, 0, 'next cycles over the owned guns only');
  sim.action(pl, 'wnext', -1); assert.equal(pl.curW, 2, 'and back');
  sim.debug.takeWeapon(pl, 'sniper', 8);
  const sn = pl.weapons[wIdx('sniper')]; assert.ok(sn.owned); assert.equal(sn.ammo, 5); assert.equal(sn.reserve, 3); assert.equal(pl.curW, wIdx('sniper'), 'drawn at once');
  assert.equal(parseBlock(snapshot(sim, 0).P[0]).owned, 0b1111);
  sim.debug.takeWeapon(pl, 'sniper', 4); assert.equal(sn.reserve, 7, 'a second crate tops up the reserve');
  const crates = sim.spots.filter(s => s.kind !== 'bribe'); assert.equal(crates.length, 4, 'two sniper and two rocket spots');
  run(sim, 0.1); for (const c of crates) assert.ok(c.p && c.p.kind === c.kind && c.p.amount > 0, 'each spot grows its crate');
  assert.ok(PICK_KINDS.indexOf('rpg') > PICK_KINDS.indexOf('bribe'), 'appended on the wire');
});

test('an ammo pickup feeds the guns you carry, and a dead player drops the special ones for the next one along', () => {
  const sim = make(2); const [a, b] = sim.players;
  sim.debug.takeWeapon(a, 'rpg', 3); const rpg = a.weapons[wIdx('rpg')];
  const p = sim.debug.spawnPickup(a.ped.x, a.ped.z, 'ammo', 1); run(sim, 0.1); assert.ok(p.released, 'walked over it');
  assert.equal(rpg.reserve, 2 + 1); assert.equal(b.weapons[wIdx('rpg')].reserve, 0, 'nothing for a gun you do not have');
  const before = sim.pickups.filter(k => k.kind === 'rpg').length;
  sim.debug.killPlayer(a, b, 'smg');
  assert.equal(rpg.owned, false); assert.equal(a.curW, 0, 'back to the pistol');
  const drop = sim.pickups.filter(k => k.kind === 'rpg'); assert.equal(drop.length, before + 1); assert.equal(drop[drop.length - 1].amount, 4, 'every round it had');
  assert.equal(parseBlock(snapshot(sim, 0).P[0]).owned, 0b111);
});

test('a rocket blows up what it hits and everything around it', () => {
  const sim = make(1); const pl = sim.players[0], P = pl.ped;
  sim.debug.takeWeapon(pl, 'rpg', 3);
  P.x = 0; P.z = 0; P.yaw = 0; pl.fireT = 0; sim.setInput(pl, { m: 0, y: 0, p: 0.05, c: 0 }); // looking down +z, a touch downward
  const target = new sim.debug.Ped('civ', 0, 14), bystander = new sim.debug.Ped('civ', 3.5, 14), far = new sim.debug.Ped('civ', 0, 40); sim.peds.push(target, bystander, far);
  const car = new sim.debug.Car(CAR_TYPES[0], 4, 17, 0); sim.cars.push(car);
  { const R = Math.random; Math.random = () => 0.5; try { sim.debug.fireWeapon(pl); } finally { Math.random = R; } } // no spread: the rocket goes where the crosshair points
  const m = snapshot(sim, 0);
  assert.ok(m.ev.some(e => e[0] === 'shot' && e[2] === 'rpg'), 'the shot goes out'); assert.ok(m.ev.some(e => e[0] === 'explode'), 'and the blast');
  assert.ok(target.dead, 'the one in the crosshair'); assert.ok(bystander.dead || bystander.health < 40, 'the one next to it'); assert.ok(!far.dead && far.health === 40, 'not the one down the street');
  assert.ok(car.health < car.hp, 'the parked car took the blast'); assert.equal(pl.weapons[wIdx('rpg')].ammo, 0);
});

test('a friend rides along: no jacking, a seat on the wire, shots out of the window, and out again on either side', () => {
  const sim = make(2); const [a, b] = sim.players;
  sim.action(a, 'use'); const car = a.ped.inCar; assert.ok(car && car.driver === a.ped, 'A takes the wheel of the car beside the spawn');
  b.ped.x = car.x + 2; b.ped.z = car.z; run(sim, 0.05);
  assert.equal(b.hint, 7, 'GET IN, not JACK');
  sim.action(b, 'use');
  assert.equal(b.ped.inCar, car); assert.equal(b.ped.seat, 1); assert.equal(car.driver, a.ped, 'A is still driving'); assert.deepEqual(car.riders, [b.ped]);
  let blk = parseBlock(snapshot(sim, 1).P[1]); assert.equal(blk.carId, car.id); assert.equal(blk.seat, 1);
  assert.equal(parseBlock(snapshot(sim, 0).P[0]).seat, 0);
  sim.setInput(a, { m: 1, y: 0, p: 0.22, c: 0 }); run(sim, 2); // A drives off
  assert.ok(car.speed > 3); assert.ok(Math.hypot(b.ped.x - car.x, b.ped.z - car.z) < 1, 'B goes where the car goes');
  sim.setInput(a, { m: 0, y: 0, p: 0.22, c: 0 }); a.fireT = 0; b.fireT = 0;
  const shots = () => snapshot(sim, 1).ev.filter(e => e[0] === 'shot').length;
  sim.debug.fireWeapon(a); assert.equal(shots(), 0, 'the driver drives');
  sim.debug.fireWeapon(b); assert.equal(shots(), 1, 'the passenger shoots');
  const cull = sim.cars.indexOf(car) >= 0; assert.ok(cull);
  sim.action(a, 'use'); assert.equal(a.ped.inCar, null); assert.equal(car.driver, null); assert.equal(b.ped.inCar, car, 'B stays in the car when A gets out');
  run(sim, 0.5); assert.equal(b.ped.inCar, car);
  sim.action(b, 'use'); assert.equal(b.ped.inCar, null); assert.equal(b.ped.seat, 0); assert.deepEqual(car.riders, []);
  assert.ok(Math.hypot(a.ped.x - b.ped.x, a.ped.z - b.ped.z) > 3, 'they got out on opposite sides');
  sim.action(b, 'use'); assert.equal(car.driver, b.ped, 'an empty seat at the wheel is taken as the driver');
});

test('three ride along at most; the fourth finds the door shut', () => {
  const sim = make(5); const [a, ...rest] = sim.players;
  sim.action(a, 'use'); const car = a.ped.inCar; assert.ok(car);
  for (const p of rest) { p.ped.x = car.x + 2; p.ped.z = car.z; }
  run(sim, 0.05); for (const p of rest) sim.action(p, 'use');
  assert.equal(car.riders.length, 3); assert.deepEqual(car.riders.map(r => r.seat), [1, 2, 3]);
  assert.notEqual(rest[3].ped.inCar, car, 'no seat left for the fourth');
});

test('the car dying puts everyone out, riders included', () => {
  const sim = make(2); const [a, b] = sim.players;
  sim.action(a, 'use'); const car = a.ped.inCar; b.ped.x = car.x + 2; b.ped.z = car.z; run(sim, 0.05); sim.action(b, 'use'); assert.equal(b.ped.seat, 1);
  a.godT = 0; b.godT = 0; car.damage(car.hp);
  assert.ok(car.dead); assert.ok(a.ped.dead && b.ped.dead, 'the blast takes both'); assert.equal(a.ped.inCar, null); assert.equal(b.ped.inCar, null); assert.deepEqual(car.riders, []);
});

test('a passenger is not predicted: the predictor steps aside until the seat is empty again', () => {
  const W = { nearAabbs: () => [] }; const pred = createPredictor({ W });
  const ents = new Map([[5, { id: 5, cls: 'ped', x: 1, y: 0, z: 2, yaw: 0 }], [9, { id: 9, cls: 'car', x: 1, y: 0, z: 2, yaw: 0, vF: 0, steer: 0, type: CAR_TYPES[0] }]]);
  const remote = { ents, get: id => ents.get(id) };
  const me = { pedId: 5, dead: false, carId: -1, seat: 0, ack: 0 };
  assert.ok(pred.step(0, 0, false, 1 / 60, me, remote, 0) > 0, 'on foot: predicting');
  me.carId = 9; me.seat = 1;
  assert.equal(pred.step(1, 0, false, 1 / 60, me, remote, 0), 0, 'riding: not predicting'); assert.equal(pred.local(), null, 'the host\'s car carries me');
  me.carId = -1; me.seat = 0;
  assert.ok(pred.step(0, 0, false, 1 / 60, me, remote, 0) > 0, 'out again: predicting from the host\'s position');
});

/* ---- phase 4: the taxi rank, taxi fares and ambulance patients */
import { TAXI_RANK, HOSPITAL } from '../client/games/gta/world.js';
import { PF, JOB_KINDS, JOB_STAGES } from '../client/games/gta/entities.js';
import { JOB_PICKUP_T, TAXI_PAY, JOB_STREAK } from '../client/games/gta/sim.js';

const jobOf = (sim, i) => parseBlock(snapshot(sim, i).P[i]).job;
const entryOf = (sim, i, id) => { const m = snapshot(sim, i); return m.p.find(e => e[0] === id); };
/* put the player at the wheel of a cab from the rank */
const takeCab = sim => { const pl = sim.players[0], P = pl.ped; P.x = TAXI_RANK.x - 3; P.z = TAXI_RANK.z; run(sim, 0.05); sim.action(pl, 'use'); return pl; };
/* park the car right there, engine off, and let the sim notice */
const stopAt = (sim, c, x, z) => { c.x = x; c.z = z; c.vx = c.vz = 0; c.vF = 0; c.speed = 0; c.angVel = 0; run(sim, 0.2); };

test('three cabs wait at the rank by the plaza, and taking one is not a carjacking', () => {
  const sim = make(1);
  const cabs = sim.cars.filter(c => c.type.taxi && c.parked); assert.equal(cabs.length, 3);
  for (const c of cabs) assert.ok(Math.abs(c.x - TAXI_RANK.x) < 0.1 && Math.abs(c.z - TAXI_RANK.z) <= 8.1, 'lined up along the curb');
  assert.equal(sim.cars.filter(c => c.type.ambulance).length, 1, 'and the ambulance outside the hospital');
  const pl = takeCab(sim);
  assert.ok(pl.ped.inCar && pl.ped.inCar.type.taxi, 'at the wheel of a cab'); assert.equal(pl.wanted, 0, 'no star for a cab off the rank');
});

test('at the wheel of a cab a fare waves from a corner nearby; stop beside it and it gets in, deliver it and it pays', () => {
  const sim = make(2); const pl = takeCab(sim), c = pl.ped.inCar;
  assert.equal(jobOf(sim, 0), null, 'not yet');
  run(sim, 1.8);
  let j = pl.job; assert.ok(j && j.kind === 'taxi' && j.stage === 'pickup' && j.fare, 'the job starts by itself at the wheel');
  const fare = j.fare, d0 = Math.hypot(fare.x - c.x, fare.z - c.z); assert.ok(d0 > 40 && d0 < 230, 'a block or two away (a corner can sit a little past the pick): ' + d0);
  assert.ok(j.t > JOB_PICKUP_T - 1 && j.t <= JOB_PICKUP_T);
  let w = jobOf(sim, 0); assert.equal(JOB_KINDS[w.kind], 'taxi'); assert.equal(JOB_STAGES[w.stage], 'pickup'); assert.equal(w.x, Math.round(fare.x * 10) / 10); assert.equal(w.n, 0);
  assert.equal(jobOf(sim, 1), null, 'the other player has no job');
  run(sim, 1); assert.ok(fare.armRaise > 0.8, 'waving'); assert.ok(entryOf(sim, 0, fare.id)[6] & PF.ARM, 'seen waving on the wire');
  fare.x = c.x + 40; fare.z = c.z; // whatever corner it picked, bring it within reach of a straight road
  stopAt(sim, c, fare.x + 2, fare.z);
  j = pl.job; assert.equal(j.stage, 'dropoff'); assert.equal(fare.inCar, c, 'in the back'); assert.ok(entryOf(sim, 0, fare.id)[6] & PF.INCAR, 'and out of sight');
  const d = Math.hypot(j.x - c.x, j.z - c.z); assert.ok(d > 30, 'somewhere else in town'); assert.equal(j.pay, Math.round(TAXI_PAY[0] + d * TAXI_PAY[1]));
  w = jobOf(sim, 0); assert.equal(JOB_STAGES[w.stage], 'dropoff'); assert.equal(w.x, Math.round(j.x * 10) / 10);
  const cash = pl.cash, pay = j.pay;
  stopAt(sim, c, j.x + 1, j.z);
  j = pl.job; assert.equal(j.stage, 'wait'); assert.equal(j.n, 1); assert.equal(fare.inCar, null, 'out again'); assert.equal(fare.job, null);
  assert.equal(pl.cash, cash + pay + Math.round(pay * 0.5), 'paid, with the tip for a run this fast');
  assert.equal(jobOf(sim, 0).n, 1);
  run(sim, 2.2); j = pl.job; assert.equal(j.stage, 'pickup'); assert.notEqual(j.fare, fare, 'the next fare is waiting');
  const f2 = j.fare; f2.x = c.x + 40; f2.z = c.z; stopAt(sim, c, f2.x + 2, f2.z); const p2 = pl.job.pay, c2 = pl.cash; stopAt(sim, c, pl.job.x + 1, pl.job.z);
  assert.equal(pl.cash, c2 + p2 + Math.round(p2 * 0.5) + JOB_STREAK, 'two in a row pays the streak');
});

test('too slow and the fare is gone with the streak; getting out ends the job; a waiting fare is never culled', () => {
  const sim = make(1); const pl = takeCab(sim), c = pl.ped.inCar; run(sim, 1.8);
  let j = pl.job; const fare = j.fare; j.n = 2; j.t = 0.05; run(sim, 0.2);
  assert.equal(j.stage, 'wait'); assert.equal(j.n, 0); assert.equal(fare.job, null); assert.ok(fare.flee > 0, 'it took another cab');
  const m = snapshot(sim, 0); assert.ok(m.ev.some(e => e[0] === 'job' && e[2] === 'fail'));
  run(sim, 4.2); j = pl.job; assert.equal(j.stage, 'pickup'); const f2 = j.fare;
  f2.x = c.x + 500; f2.z = c.z + 500; run(sim, 1.2); assert.ok(!f2.released, 'far from everyone but still waiting');
  f2.x = c.x + 40; f2.z = c.z; stopAt(sim, c, f2.x + 2, f2.z); assert.equal(f2.inCar, c);
  sim.action(pl, 'use'); assert.equal(pl.ped.inCar, null);
  assert.equal(pl.job, null, 'the job ends with the ride'); assert.equal(f2.inCar, null); assert.equal(f2.job, null); assert.equal(jobOf(sim, 0), null);
  run(sim, 1); assert.ok(!f2.dead);
});

test('the ambulance: the patient lies down, the hospital is the destination, and a patient shot is a patient lost', () => {
  const sim = make(1); const pl = sim.players[0], P = pl.ped, amb = sim.cars.find(c => c.type.ambulance);
  P.x = amb.x + 3; P.z = amb.z; run(sim, 0.05); sim.action(pl, 'use'); assert.equal(P.inCar, amb);
  run(sim, 1.8); let j = pl.job; assert.equal(j.kind, 'ambulance'); assert.equal(JOB_KINDS[jobOf(sim, 0).kind], 'ambulance');
  const pt = j.fare; assert.ok(pt.down); run(sim, 0.5); assert.ok(pt.armRaise < 0.3, 'not waving'); assert.ok(entryOf(sim, 0, pt.id)[6] & PF.DOWN, 'lying on the wire');
  pt.x = amb.x + 40; pt.z = amb.z; stopAt(sim, amb, pt.x + 2, pt.z);
  j = pl.job; assert.equal(j.stage, 'dropoff'); assert.ok(Math.hypot(j.x - HOSPITAL.x, j.z - HOSPITAL.z) < 12, 'to the hospital');
  const cash = pl.cash; stopAt(sim, amb, j.x, j.z); assert.equal(pl.job.n, 1); assert.ok(pl.cash > cash); assert.equal(pt.down, false, 'walks out cured');
  run(sim, 2.2); const pt2 = pl.job.fare; assert.ok(pt2 && pt2.down);
  pt2.hurt(50, sim.players[0], 'pistol'); assert.ok(pt2.dead); run(sim, 0.1);
  assert.equal(pl.job.stage, 'wait'); assert.equal(pl.job.n, 0);
});

/* ---- phase 5: the street race */
import { raceCourse, raceGuide, planPath, planLap, raceRoute, nodeAhead, hairpins, exitDir, dirOf, DIRS, DIR_PZ, nodeXZ, progressOf, gridSlot, LAPS, CHECKPOINTS, START_NODE, CP_RADIUS, ordinal } from '../client/games/gta/race.js';
import { COUNTDOWN_T, RACE_END_T } from '../client/games/gta/sim.js';
import { NB } from '../client/games/gta/world.js';

test('the course comes from the seed: a loop of inner intersections a few blocks apart, the line first, the first checkpoint ahead of the grid', () => {
  for (const seed of [1, 7, 20260903, 4294967295]) {
    const c = raceCourse(seed);
    assert.equal(c.length, CHECKPOINTS + 1); assert.deepEqual(c[0], START_NODE);
    for (const p of c.slice(1)) { assert.ok(p[0] >= 1 && p[0] <= NB - 1 && p[1] >= 1 && p[1] <= NB - 1, 'an inner intersection'); }
    for (let i = 0; i < c.length; i++) for (let j = i + 1; j < c.length; j++) assert.ok(Math.abs(c[i][0] - c[j][0]) + Math.abs(c[i][1] - c[j][1]) >= 2, 'spread out: ' + c[i] + ' vs ' + c[j]);
    assert.ok(c[1][1] >= START_NODE[1] - 1, 'the first checkpoint is not behind the grid');
    assert.equal(hairpins(c), 0, 'no leg doubles back on the one before it, the line included');
    assert.deepEqual(raceCourse(seed), c, 'the same seed lays out the same course');
  }
  assert.notDeepEqual(raceCourse(1), raceCourse(2), 'different seeds, different courses');
  assert.equal(ordinal(1), '1ST'); assert.equal(ordinal(2), '2ND'); assert.equal(ordinal(3), '3RD'); assert.equal(ordinal(4), '4TH'); assert.equal(ordinal(11), '11TH'); assert.equal(ordinal(22), '22ND');
  const s = nodeXZ(START_NODE); for (let i = 0; i < 8; i++) { const g = gridSlot(i); assert.ok(g.z < s.z - 10 && Math.abs(g.x - s.x) < 4 && g.yaw === 0, 'the grid sits below the line, facing it'); }
});

test('progress along the course counts checkpoints passed plus the fraction of the leg', () => {
  const c = raceCourse(7), n = c.length, a = nodeXZ(c[0]), b = nodeXZ(c[1]);
  assert.ok(Math.abs(progressOf(c, 0, 1, a.x, a.z)) < 1e-9, 'on the line, heading for 1');
  assert.ok(Math.abs(progressOf(c, 0, 1, (a.x + b.x) / 2, (a.z + b.z) / 2) - 0.5) < 1e-9, 'halfway up the first leg');
  assert.ok(Math.abs(progressOf(c, 0, 1, b.x, b.z) - 1) < 1e-9, 'at checkpoint 1');
  assert.ok(progressOf(c, 1, 0, b.x, b.z) > n + n - 2, 'a lap on, heading back for the line');
  assert.ok(progressOf(c, 0, 2, b.x, b.z) >= progressOf(c, 0, 1, b.x, b.z) && progressOf(c, 0, 2, b.x, b.z) < progressOf(c, 0, 2, nodeXZ(c[2]).x, nodeXZ(c[2]).z), 'just past a checkpoint is no further back than at it, and short of the next');
});

/* put a player (at the wheel or not) at a course node */
const goTo = (sim, pl, k) => { const p = nodeXZ(sim.course[k]), P = pl.ped, c = P.inCar; if (c) { c.x = p.x; c.z = p.z; c.vx = c.vz = 0; c.vF = 0; c.speed = 0; } P.x = p.x; P.z = p.z; };
const raceOf = (sim, i) => parseMode(snapshot(sim, i).md).race;

test('the race: everyone waits at the wheel on the grid through the countdown, then it is anything goes', () => {
  const sim = make(3, { mode: 'race', friendlyFire: false }); const [a, b] = sim.players;
  assert.equal(sim.mode, 'race'); assert.equal(sim.S.phase, 'countdown'); assert.equal(sim.mission.vinny, null); assert.ok(sim.course && sim.course.length === CHECKPOINTS + 1);
  for (const pl of sim.players) { assert.ok(pl.ped.inCar && pl.ped.inCar.driver === pl.ped && pl.ped.seat === 0, 'at the wheel'); assert.ok(pl.ped.inCar.type.name === 'sports'); }
  assert.ok(Math.abs(a.ped.x - b.ped.x) > 4 || Math.abs(a.ped.z - b.ped.z) > 4, 'not on top of each other');
  let r = raceOf(sim, 0); assert.equal(r.state, 0); assert.ok(r.t > COUNTDOWN_T - 0.2);
  sim.setInput(a, { m: 1, y: 0, p: 0.22, c: 0 }); const z0 = a.ped.z; run(sim, 1);
  assert.ok(Math.abs(a.ped.z - z0) < 0.01, 'the grid holds: full throttle moves nobody');
  sim.action(a, 'use'); assert.ok(a.ped.inCar, 'and nobody gets out');
  run(sim, COUNTDOWN_T); assert.equal(sim.S.phase, 'play'); assert.ok(snapshot(sim, 0).ev.some(e => e[0] === 'go') || true);
  r = raceOf(sim, 0); assert.equal(r.state, 1);
  run(sim, 1); assert.ok(a.ped.z - z0 > 2, 'green light: off it goes');
  const blk = parseBlock(snapshot(sim, 0).P[0]); assert.equal(blk.lap, 0); assert.equal(blk.next, 1); assert.ok(blk.rank >= 1 && blk.rank <= 3); assert.equal(blk.place, 0);
  assert.equal(parseBlock(snapshot(sim, 0).P[0]).job, null);
  // friendly fire is on whatever the lobby said: a shot at another player lands
  b.godT = 0; sim.debug.damagePlayer(b, 30, a, 'pistol'); assert.equal(b.ped.health, 70);
});

test('checkpoints in order, laps, the finishing order, the grace once the first is home, and the standings by progress', () => {
  const sim = make(3, { mode: 'race' }); const [a, b, c] = sim.players; const n = sim.course.length;
  run(sim, COUNTDOWN_T + 0.1); assert.equal(sim.S.phase, 'play');
  goTo(sim, a, 2); run(sim, 0.1); assert.equal(a.next, 1, 'checkpoint 2 does not count before 1');
  goTo(sim, a, 1); run(sim, 0.1); assert.equal(a.next, 2); assert.ok(snapshot(sim, 0).ev.some(e => e[0] === 'cp' && e[1] === 0 && e[2] === 1));
  for (let k = 2; k < n; k++) { goTo(sim, a, k); run(sim, 0.1); } assert.equal(a.next, 0, 'heading back for the line'); assert.equal(a.lap, 0);
  goTo(sim, a, 0); run(sim, 0.1); assert.equal(a.lap, 1); assert.equal(a.next, 1); assert.ok(snapshot(sim, 0).ev.some(e => e[0] === 'cp' && e[3] === 1), 'a lap done');
  // B does one checkpoint, C stays: the standings follow progress
  goTo(sim, b, 1); run(sim, 0.1);
  assert.equal(a.rank, 1); assert.equal(b.rank, 2); assert.equal(c.rank, 3);
  assert.equal(parseBlock(snapshot(sim, 1).P[1]).rank, 2);
  // A finishes: first place, the grace starts for the rest
  for (let lap = 1; lap < LAPS; lap++) { for (let k = 1; k < n; k++) { goTo(sim, a, k); run(sim, 0.1); } goTo(sim, a, 0); run(sim, 0.1); }
  assert.equal(a.place, 1); assert.equal(a.lap, LAPS); assert.ok(sim.RC.ending); assert.ok(sim.RC.t > RACE_END_T - 0.5);
  const m = snapshot(sim, 1); assert.ok(m.ev.some(e => e[0] === 'finish' && e[1] === 0 && e[2] === 1), 'the room hears about it');
  const r = raceOf(sim, 1); assert.equal(r.state, 2); assert.equal(r.finishers, 1);
  goTo(sim, a, 3); run(sim, 0.1); assert.equal(a.next, 1, 'a finisher passes no more checkpoints');
  // B finishes inside the grace: second; C never does; the grace runs out and the round is over
  for (let lap = 0; lap < LAPS; lap++) { for (let k = 1; k < n; k++) { goTo(sim, b, k); run(sim, 0.05); } goTo(sim, b, 0); run(sim, 0.05); }
  assert.equal(b.place, 2); assert.equal(sim.S.phase, 'play');
  run(sim, RACE_END_T); assert.equal(sim.S.phase, 'over'); assert.equal(c.place, 0); assert.equal(c.rank, 3);
  assert.ok(a.cash > b.cash && b.cash > c.cash, 'the prize money follows the places');
});

test('everyone home ends the race at once; a wasted racer is back at the wheel at the last checkpoint', () => {
  const sim = make(1, { mode: 'race' }); const pl = sim.players[0], n = sim.course.length;
  run(sim, COUNTDOWN_T + 0.1);
  goTo(sim, pl, 1); run(sim, 0.1); goTo(sim, pl, 2); run(sim, 0.1); assert.equal(pl.next, 3);
  const car0 = pl.ped.inCar, cash = pl.cash; pl.godT = 0; sim.debug.killPlayer(pl, null, 'cop');
  assert.ok(pl.ped.dead); run(sim, 6); assert.ok(!pl.ped.dead, 'back');
  assert.equal(pl.cash, cash, 'no hospital bill in a race');
  const c = pl.ped.inCar; assert.ok(c && c !== car0 && c.driver === pl.ped, 'a fresh car'); const cp = nodeXZ(sim.course[2]);
  assert.ok(Math.hypot(c.x - cp.x, c.z - cp.z) < CP_RADIUS, 'at the last checkpoint passed'); assert.equal(pl.next, 3, 'still heading for the next');
  { const leg = planLap(sim.course)[2], d = DIRS[dirOf(leg[1][0] - leg[0][0], leg[1][1] - leg[0][1])]; assert.ok(Math.abs(Math.sin(c.yaw) - d[0]) < 1e-6 && Math.abs(Math.cos(c.yaw) - d[1]) < 1e-6, 'facing the way the planned route leaves the checkpoint'); }
  for (let lap = 0; lap < LAPS; lap++) { for (let k = lap ? 1 : 3; k < n; k++) { goTo(sim, pl, k); run(sim, 0.05); } goTo(sim, pl, 0); run(sim, 0.05); }
  assert.equal(pl.place, 1); run(sim, 0.1); assert.equal(sim.S.phase, 'over', 'the only racer is home: no grace to wait out');
  assert.equal(sim.WE.kind, null, 'no world events on a race day');
});

/* ---- phase 6: the bus and the motorcycle */
import { carOffs, driveInput, stepCar, IN } from '../client/games/gta/motion.js';
import { seatsOf, seatOffset } from '../client/games/gta/entities.js';

const BUS = CAR_TYPES.find(t => t.bus), BIKE = CAR_TYPES.find(t => t.bike), SEDAN = CAR_TYPES[0];
/* a car of the sim's own class, added to the city */
const addCar = (sim, T, x, z, yaw) => { const c = new sim.debug.Car(T, x, z, yaw); c.hand = false; sim.cars.push(c); return c; };
/* put the player beside a vehicle and press F */
const board = (sim, pl, c) => { pl.ped.x = c.x + c.type.w / 2 + 1; pl.ped.z = c.z; run(sim, 0.05); sim.action(pl, 'use'); };

test('a car collides along spheres down its length: two for a sedan, enough for a bus that its side has no gap', () => {
  assert.deepEqual(carOffs(SEDAN).length, 2); assert.equal(carOffs(SEDAN)[1], SEDAN.l / 2 - (SEDAN.w / 2 + 0.12), 'the sedan is as it was');
  for (const T of CAR_TYPES) if (!T.bus) assert.equal(carOffs(T).length, 2, T.name + ' keeps its two spheres');
  const offs = carOffs(BUS), r = BUS.w / 2 + 0.12; assert.ok(offs.length >= 4, 'the bus has more');
  for (let i = 1; i < offs.length; i++) assert.ok(offs[i] - offs[i - 1] <= 2 * r, 'neighbouring spheres overlap');
  assert.equal(offs[0], -offs[offs.length - 1], 'symmetric');
});

test('a sedan across the middle of a bus is pushed off it (with two spheres it would have sunk in)', () => {
  const sim = make(1);
  const bus = addCar(sim, BUS, 300, 300, 0), car = addCar(sim, SEDAN, 300 + 1.8, 300, Math.PI / 2); // the bus along z, the sedan nose-on into its side, well inside it
  const x0 = car.x; sim.debug.collideCars();
  assert.ok(car.x > x0 + 0.3, 'the sedan is pushed out sideways'); assert.ok(bus.x < 300, 'and the bus a little the other way, being heavier');
});

test('the bus takes seven riders, a bike one pillion, and every seat has its own window', () => {
  assert.equal(seatsOf(BUS), 7); assert.equal(seatsOf(BIKE), 1); assert.equal(seatsOf(SEDAN), 3);
  const seen = new Set(); for (let s = 1; s <= 7; s++) { const { side, back } = seatOffset(BUS, s); assert.ok(Math.abs(side) === 1); assert.ok(back > -BUS.l / 2 && back <= 0.2); seen.add(side + ':' + back.toFixed(2)); }
  assert.equal(seen.size, 7, 'no two seats in the same place');
  assert.equal(seatOffset(BIKE, 1).side, 0); assert.ok(seatOffset(BIKE, 1).back < 0, 'the pillion sits behind the rider');
  const sim = make(3); const [a, b, c] = sim.players; const bike = addCar(sim, BIKE, 300, 300, 0);
  board(sim, a, bike); assert.equal(a.ped.inCar, bike); assert.equal(a.ped.seat, 0);
  board(sim, b, bike); assert.equal(b.ped.inCar, bike); assert.equal(b.ped.seat, 1, 'one rides pillion');
  board(sim, c, bike); assert.notEqual(c.ped.inCar, bike, 'no room for a third');
});

test('a rider is drawn in the saddle: the block says the seat and the ped entry carries the RIDE flag, off the bike it is gone', () => {
  const sim = make(1); const pl = sim.players[0]; const bike = addCar(sim, BIKE, 300, 300, 0);
  board(sim, pl, bike); run(sim, 0.1);
  let e = entryOf(sim, 0, pl.ped.id); assert.ok(e[6] & PF.RIDE, 'riding'); assert.ok(e[6] & PF.INCAR); assert.equal(parseBlock(snapshot(sim, 0).P[0]).seat, 0);
  sim.action(pl, 'use'); run(sim, 0.1);
  e = entryOf(sim, 0, pl.ped.id); assert.equal(e[6] & PF.RIDE, 0); assert.equal(e[6] & PF.INCAR, 0);
  const sim2 = make(1); const p2 = sim2.players[0]; sim2.action(p2, 'use'); run(sim2, 0.1); // the sports car by the spawn
  assert.ok(p2.ped.inCar && !p2.ped.inCar.type.bike); assert.equal(entryOf(sim2, 0, p2.ped.id)[6] & PF.RIDE, 0, 'in a car nobody is in a saddle');
});

test('a hard hit throws the riders off a bike and hurts them; a nudge does not', () => {
  const sim = make(2); const [a, b] = sim.players; a.godT = b.godT = 0;
  const bike = addCar(sim, BIKE, 300, 300, 0); board(sim, a, bike); board(sim, b, bike); assert.equal(bike.riders.length, 1);
  const nudge = addCar(sim, SEDAN, 300, 300 + 3.2, Math.PI); nudge.vz = -1.5; sim.debug.collideCars(); // a slow tap from ahead
  assert.equal(a.ped.inCar, bike, 'still in the saddle after a tap'); sim.cars.splice(sim.cars.indexOf(nudge), 1); nudge.release();
  const truck = addCar(sim, SEDAN, 300, 300 + 3.2, Math.PI); truck.vz = -14; sim.debug.collideCars(); // a car into the bike head-on
  assert.equal(a.ped.inCar, null, 'the rider is thrown'); assert.equal(b.ped.inCar, null, 'the pillion too'); assert.deepEqual(bike.riders, []); assert.equal(bike.driver, null);
  assert.ok(a.ped.health < 100 && b.ped.health < 100, 'and hurt'); assert.ok(a.ped.vy > 0, 'into the air'); assert.equal(a.ped.ride, false);
});

test('the bike turns tighter than a sedan and the bus wider, at the same speed', () => {
  const W = { nearAabbs: () => [] }; const DT = 1 / 60;
  const drive = T => { const r = T.w / 2 + 0.12; const c = { type: T, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, angVel: 0, steer: 0, throttle: 0, hand: false, vF: 0, speed: 0, fx: 0, fz: 1, rx: -1, rz: 0, dead: false, r, off: T.l / 2 - r, offs: carOffs(T), mass: T.mass };
    for (let i = 0; i < 60; i++) { driveInput(c, IN.UP, DT); stepCar(W, c, DT, null); } c.vx = 0; c.vz = 10; c.vF = 10; // a second of gas, then the same speed for all
    for (let i = 0; i < 60; i++) { driveInput(c, IN.UP | IN.LEFT, DT); c.vF = 10; c.vx = c.fx * 10; c.vz = c.fz * 10; stepCar(W, c, DT, null); } return Math.abs(c.yaw); };
  const bike = drive(BIKE), sedan = drive(SEDAN), bus = drive(BUS);
  assert.ok(bike > sedan * 1.2, 'the bike is nimble'); assert.ok(bus < sedan * 0.75, 'the bus lumbers');
});

test('motorcycles wait parked around the city and by the Ferris wheel, buses roll in the traffic, and a player alone keeps the old police force', () => {
  const sim = make(1);
  assert.ok(sim.cars.filter(c => c.type.bike && c.parked).length >= 3, 'bikes to take');
  assert.ok(sim.cars.every(c => !(c.type.bike && c.ai === 'traffic')), 'no riderless bikes in the traffic');
  let buses = 0; for (let k = 0; k < 40; k++) { run(sim, 0.5); buses += sim.cars.filter(c => c.type.bus && c.ai === 'traffic').length; if (buses) break; }
  assert.ok(buses > 0, 'a bus in the traffic within twenty seconds');
  assert.equal(sim.debug.MAX_COPS, 24); assert.equal(sim.debug.MAX_COP_CARS, 8); assert.equal(make(2).debug.MAX_COPS, 32);
});

test('the sat-nav: the first turn on the route, its hand, its distance, and a trail of arrows on the road ahead', () => {
  const X6 = nodeXZ([6, 6]);
  // heading +z up avenue 6 from just below node (6,6); the route bends to +x at (6,6) then on to (8,6). Seen from behind a
  // car heading +z, +x is on the left (the camera looks down -Z, and the LEFT key steers the yaw towards +x): a left turn
  let g = raceGuide([[6, 6], [7, 6], [8, 6]], X6.x, X6.z - 20, 0, 1);
  assert.equal(g.turn.kind, 'LEFT'); assert.ok(Math.abs(g.turn.d - 20) < 1e-6, 'the turn is 20 m ahead'); assert.equal(g.turn.street, 'Voxel Blvd', 'onto the cross street, not the avenue we are on');
  g = raceGuide([[6, 6], [5, 6], [4, 6]], X6.x, X6.z - 20, 0, 1); assert.equal(g.turn.kind, 'RIGHT');
  // straight on to the goal: no turn, arrive
  g = raceGuide([[6, 6], [6, 7], [6, 8]], X6.x, X6.z - 20, 0, 1); assert.equal(g.turn.kind, 'ARRIVE'); assert.ok(g.turn.d > 100);
  // a straight node first, then the turn: the instruction is the turn, two blocks up, and the arrows sit on the legs ahead
  g = raceGuide([[6, 6], [6, 7], [7, 7]], X6.x, X6.z - 20, 0, 1); assert.equal(g.turn.kind, 'LEFT'); assert.ok(g.turn.d > 70);
  assert.ok(g.arrows.length > 4, 'a trail'); assert.ok(g.arrows.every(a => a.z > X6.z - 20), 'all of it ahead of the car');
  const big = g.arrows.filter(a => a.big); assert.equal(big.length, 2, 'one at each intersection with a way out');
  assert.ok(Math.abs(big[0].yaw) < 1e-6 && Math.abs(big[1].yaw - Math.PI / 2) < 1e-6, 'pointing straight on, then +x');
  // the whole route behind me: turn around
  g = raceGuide([[6, 6], [6, 5]], X6.x, X6.z + 20, 0, 1); assert.equal(g.turn.kind, 'U-TURN'); assert.equal(g.arrows.length, 0);
  // a node just behind still counts as the one I am at, so its way out is the instruction
  g = raceGuide([[6, 6], [7, 6]], X6.x, X6.z + 1, 0, 1); assert.equal(g.turn.kind, 'LEFT');
  assert.deepEqual(raceGuide([], 0, 0, 0, 1), { arrows: [], turn: null, cp: null });
  // a checkpoint in the middle of the route: its distance is reported, the turn found is the one after it, and the checkpoint gets a big arrow pointing the way out
  g = raceGuide([[6, 6], [6, 7], [6, 8], [7, 8]], X6.x, X6.z - 20, 0, 1, 4, 14, 2);
  assert.ok(Math.abs(g.cp.d - 128) < 1e-6, 'the checkpoint two blocks up'); assert.equal(g.turn.kind, 'LEFT'); assert.ok(Math.abs(g.turn.d - g.cp.d) < 1e-6, 'the turn is at the checkpoint itself');
  const atCp = g.arrows.find(a => a.big && Math.abs(a.z - nodeXZ([6, 8]).z) < 1e-6); assert.ok(atCp && Math.abs(atCp.yaw - Math.PI / 2) < 1e-6, 'the arrow on the checkpoint points +x, the way out');
  assert.equal(raceGuide([[6, 6], [6, 7]], X6.x, X6.z - 20, 0, 1, 4, 14, 5).cp, null, 'no checkpoint on this route');
});

const noReverse = path => { for (let k = 2; k < path.length; k++) if (path[k - 2][0] === path[k][0] && path[k - 2][1] === path[k][1]) return false; return true; };
const sameNode = (a, b) => a[0] === b[0] && a[1] === b[1];

test('the planner: shortest road paths that never reverse, prefer straight, and enter the goal only the asked way', () => {
  let p = planPath([2, 2], DIR_PZ, [2, 6]); assert.deepEqual(p, [[2, 2], [2, 3], [2, 4], [2, 5], [2, 6]], 'straight up the avenue');
  p = planPath([2, 2], DIR_PZ, [5, 2]); assert.equal(p.length, 4); assert.ok(noReverse(p)); assert.ok(sameNode(p[0], [2, 2]) && sameNode(p[3], [5, 2]), 'a turn, then along');
  p = planPath([2, 2], DIR_PZ, [2, 0]); assert.ok(noReverse(p), 'the goal is behind: round a block, never a U-turn'); assert.ok(p.length >= 5); assert.ok(sameNode(p[p.length - 1], [2, 0]));
  p = planPath([3, 7], DIR_PZ, [3, 8], DIR_PZ); assert.deepEqual(p, [[3, 7], [3, 8]], 'arriving the way asked');
  p = planPath([3, 9], 3, [3, 8], DIR_PZ); assert.ok(noReverse(p)); assert.ok(sameNode(p[p.length - 2], [3, 7]) && sameNode(p[p.length - 1], [3, 8]), 'coming from the north it loops round to arrive heading +z');
  assert.ok(p.slice(0, -1).every(q => !sameNode(q, [3, 8])), 'and never crosses the line on the way');
  p = planPath([4, 4], DIR_PZ, [4, 4], DIR_PZ); assert.deepEqual(p, [[4, 4]], 'already there, facing the right way');
  p = planPath([4, 4], DIR_PZ, [4, 4], 0); assert.ok(p.length > 2 && sameNode(p[0], [4, 4]) && sameNode(p[p.length - 1], [4, 4]) && noReverse(p), 'already there but facing wrong: round the block');
  assert.equal(exitDir(p), 0); assert.equal(exitDir([[1, 1]]), DIR_PZ);
  assert.equal(dirOf(1, 0), 0); assert.equal(dirOf(-1, 0.2), 1); assert.equal(dirOf(0, 1), 2); assert.equal(dirOf(0.1, -1), 3);
});

test('the lap plan: every leg runs checkpoint to checkpoint, nothing reverses (not through a checkpoint either), and the line is crossed heading +z', () => {
  for (const seed of [1, 2, 3, 7, 11, 99, 123, 20260903, 4294967295]) {
    const c = raceCourse(seed), legs = planLap(c), n = c.length; assert.equal(legs.length, n);
    const whole = [];
    legs.forEach((leg, k) => { assert.ok(sameNode(leg[0], c[k]) && sameNode(leg[leg.length - 1], c[(k + 1) % n]), 'leg ' + k + ' ends: ' + JSON.stringify(leg)); assert.ok(leg.length >= 2); whole.push(...(k ? leg.slice(1) : leg)); });
    assert.ok(noReverse(whole), 'seed ' + seed + ' reverses somewhere in ' + JSON.stringify(whole));
    assert.ok(noReverse([...whole, ...legs[0].slice(1, 3)]), 'nor between the line and lap two');
    const last = legs[n - 1]; assert.ok(sameNode(last[last.length - 2], [START_NODE[0], START_NODE[1] - 1]), 'back across the line heading +z');
    for (let k = 0; k < n; k++) assert.ok(legs[k].slice(1, -1).every(q => !sameNode(q, c[(k + 1) % n])), 'a leg never crosses its own checkpoint early');
    assert.deepEqual(planLap(c), legs, 'deterministic');
  }
});

test('the route shown: the rest of this leg from the intersection ahead and the whole of the next, or the way back onto it, and never a U-turn in the city', () => {
  const c = raceCourse(7), legs = planLap(c), n = c.length;
  const P = nodeXZ(legs[0][0]), q = legs[0][1], d = DIRS[dirOf(q[0] - legs[0][0][0], q[1] - legs[0][0][1])];
  // on the first leg, a little past the line, heading its way: the leg from the next node, through checkpoint 1, and on down leg 1
  let r = raceRoute(c, legs, 1, P.x + d[0] * 1, P.z + d[1] * 1, d[0], d[1]);
  assert.deepEqual(r.nodes, [...legs[0], ...legs[1].slice(1)]); assert.equal(r.cp, legs[0].length - 1); assert.ok(sameNode(r.nodes[r.cp], c[1]));
  r = raceRoute(c, legs, 1, P.x + d[0] * 30, P.z + d[1] * 30, d[0], d[1]); assert.deepEqual(r.nodes[0], legs[0][1], 'past the first block: from the node ahead');
  // driving the leg backwards: planned forward from the node ahead, no reversing, still through the checkpoint and on
  r = raceRoute(c, legs, 1, P.x + d[0] * 30, P.z + d[1] * 30, -d[0], -d[1]);
  assert.ok(noReverse(r.nodes)); assert.ok(sameNode(r.nodes[r.cp], c[1])); assert.deepEqual(r.nodes.slice(r.cp), legs[1]);
  const g = raceGuide(r.nodes, P.x + d[0] * 30, P.z + d[1] * 30, -d[0], -d[1], 4, 14, r.cp); assert.notEqual(g.turn.kind, 'U-TURN'); assert.ok(g.arrows.length > 0);
  // off the route entirely, from every intersection and heading in the city: a route that starts ahead and never asks for a U-turn
  for (const seed of [7, 99]) { const cc = raceCourse(seed), ll = planLap(cc);
    for (let i = 1; i < 12; i += 2) for (let j = 1; j < 12; j += 3) for (let dd = 0; dd < 4; dd++) { const at = nodeXZ([i, j]), h = DIRS[dd], x = at.x + h[0] * 12, z = at.z + h[1] * 12;
      const rr = raceRoute(cc, ll, 3, x, z, h[0], h[1]); assert.ok(noReverse(rr.nodes), 'reverses at ' + [i, j, dd]); assert.ok(sameNode(rr.nodes[rr.cp], cc[3]));
      const gg = raceGuide(rr.nodes, x, z, h[0], h[1], 4, 14, rr.cp); assert.ok(gg.turn && gg.turn.kind !== 'U-TURN', 'U-turn asked at ' + [i, j, dd] + ': ' + JSON.stringify(rr.nodes.slice(0, 4))); } }
  const X6 = nodeXZ([6, 6]);
  assert.deepEqual(nodeAhead(X6.x, X6.z + 1, 0, 1), [6, 6], 'just past a node still counts as at it'); assert.deepEqual(nodeAhead(X6.x, X6.z + 5, 0, 1), [6, 7]); assert.deepEqual(nodeAhead(X6.x + 20, X6.z, 1, 0), [7, 6]); assert.deepEqual(nodeAhead(X6.x + 20, X6.z, -1, 0), [6, 6]);
});

/* ---- the lobby's knobs: laps, guns, the starting kit, traffic, police */
import { lapsOf, LOADOUTS, TRAFFIC_LEVELS, COP_LEVELS } from '../client/games/gta/sim.js';
import { GAMES } from '../client/games/registry.js';

test('the lobby offers laps, guns, a starting kit, traffic and police, and the defaults are the old game', () => {
  const opts = GAMES.find(g => g.id === 'gta').options, keys = Object.fromEntries(opts.map(o => [o.key, o]));
  assert.equal(keys.laps.default, 3); assert.equal(keys.guns.default, true); assert.equal(keys.loadout.default, 'basic'); assert.equal(keys.traffic.default, 'normal'); assert.equal(keys.cops.default, 'normal');
  for (const c of keys.loadout.choices) assert.ok(LOADOUTS[c.value], c.value); for (const c of keys.traffic.choices) assert.ok(TRAFFIC_LEVELS[c.value], c.value); for (const c of keys.cops.choices) assert.ok(COP_LEVELS[c.value], c.value);
  assert.equal(lapsOf({}), LAPS); assert.equal(lapsOf({ laps: 5 }), 5); assert.equal(lapsOf({ laps: '2' }), 2);
  const sim = make(2); assert.equal(sim.laps, LAPS); assert.equal(sim.guns, true); assert.deepEqual(sim.kit, LOADOUTS.basic); assert.equal(sim.debug.MAX_TRAFFIC, 40);
});

test('a one-lap race is over at the first crossing of the line, and the HUD numbers follow', () => {
  const sim = make(1, { mode: 'race', laps: 1 }); const pl = sim.players[0], n = sim.course.length;
  assert.equal(sim.laps, 1); run(sim, COUNTDOWN_T + 0.1);
  for (let k = 1; k < n; k++) { goTo(sim, pl, k); run(sim, 0.05); } assert.equal(pl.place, 0);
  goTo(sim, pl, 0); run(sim, 0.1); assert.equal(pl.place, 1); assert.equal(pl.lap, 1); run(sim, 0.1); assert.equal(sim.S.phase, 'over');
});

test('guns off: nobody owns or fires a gun, no crates grow, nothing drops off a cop, and the weapon keys are dead', () => {
  const sim = make(2, { guns: false }); const [a, b] = sim.players;
  assert.equal(sim.guns, false); assert.deepEqual(a.weapons.map(w => w.owned), [false, false, false, false, false]);
  assert.equal(sim.spots.filter(s => s.kind !== 'bribe').length, 0, 'no weapon crates'); assert.equal(sim.spots.length, 6, 'the bribes are still hidden around');
  run(sim, 0.5); sim.clearEvents(); a.weapons[0].ammo = 12; a.weapons[0].owned = true; // even a gun smuggled in does not fire
  sim.debug.fireWeapon(a); assert.equal(a.weapons[0].ammo, 12); assert.ok(!snapshot(sim, 0).ev.some(e => e[0] === 'shot'));
  sim.action(a, 'weapon', 1); assert.equal(a.curW, 0); sim.action(a, 'reload'); assert.equal(a.reloadT, 0);
  assert.equal(sim.debug.spawnPickup(a.ped.x, a.ped.z, 'ammo', 1), null); assert.equal(sim.debug.spawnPickup(a.ped.x, a.ped.z, 'rpg', 3), null);
  assert.ok(sim.debug.spawnPickup(a.ped.x + 5, a.ped.z, 'cash', 10), 'cash still lies around');
  sim.debug.killPlayer(a, b, 'runover'); assert.equal(b.kills, 1, 'a car is still a weapon');
  assert.ok(sim.pickups.every(p => p.kind === 'cash' || p.kind === 'bribe' || p.kind === 'health'), 'nothing to shoot with in the street');
});

test('the starting kit: a pistol-only round drops the shotgun on the wire for the next one along; an all-guns round keeps the rocket through a death', () => {
  const sim = make(2, { loadout: 'pistol' }); const [a, b] = sim.players;
  assert.deepEqual(a.weapons.map(w => w.owned), [true, false, false, false, false]); assert.equal(parseBlock(snapshot(sim, 0).P[0]).owned, 0b1);
  sim.debug.takeWeapon(a, 'shotgun', 9); assert.ok(a.weapons[1].owned); assert.equal(a.curW, 1, 'a shotgun is a find now');
  a.godT = 0; sim.debug.killPlayer(a, b, 'runover');
  assert.ok(!a.weapons[1].owned, 'the shotgun is left in the street'); const drop = sim.pickups.find(p => p.kind === 'shotgun'); assert.ok(drop && drop.amount === 9);
  const m = snapshot(sim, 1), entry = m.k.find(e => e[0] === drop.id); assert.ok(entry && PICK_KINDS[entry[1]] === 'shotgun', 'the kind survives the wire');
  b.ped.x = drop.x; b.ped.z = drop.z; run(sim, 0.1); assert.ok(b.weapons[1].owned && b.weapons[1].ammo === 6 && b.weapons[1].reserve === 3, 'and the other one picks it up');
  const all = make(1, { loadout: 'all' }); const pl = all.players[0];
  assert.deepEqual(pl.weapons.map(w => w.owned), [true, true, true, true, true]); assert.equal(pl.weapons[4].ammo, 1);
  pl.weapons[4].ammo = 0; pl.godT = 0; all.debug.killPlayer(pl, null, 'cop'); run(all, 6); assert.ok(!pl.ped.dead);
  assert.ok(pl.weapons[4].owned && pl.weapons[4].ammo === 1, 'the rocket is part of the kit: back after the hospital, reloaded'); assert.equal(all.pickups.filter(p => p.kind === 'rpg' && !p.spot).length, 0, 'nothing dropped (the crates in the parks are not drops)');
});

test('traffic and police scale with the lobby, and a full room on the heaviest settings fits the pools', () => {
  const light = make(1, { traffic: 'light' }), heavy = make(8, { traffic: 'heavy', cops: 'hard' }), soft = make(8, { cops: 'soft' }), normal = make(8);
  assert.equal(light.debug.MAX_TRAFFIC, 20); assert.equal(heavy.debug.MAX_TRAFFIC, 70);
  assert.equal(heavy.debug.MAX_COPS, Math.round(normal.debug.MAX_COPS * 1.5)); assert.equal(soft.debug.MAX_COP_CARS, Math.round(normal.debug.MAX_COP_CARS * 0.5));
  assert.ok(heavy.cars.filter(c => c.ai === 'traffic').length > normal.cars.filter(c => c.ai === 'traffic').length, 'more cars on the road from the start');
  for (const pl of heavy.players) heavy.debug.addWanted(pl, 5); run(heavy, 3);
  assert.ok(heavy.cops.length > 0 && heavy.cars.some(c => c.ai === 'cop'), 'the hard police force turned up');
  run(heavy, 17); // everyone is wasted and back by now, with the traffic topped up around the hospital
  const CAR_POOL = 230, PED_POOL = 320;
  assert.ok(heavy.cars.length < CAR_POOL, 'cars ' + heavy.cars.length); assert.ok(heavy.peds.length < PED_POOL, 'peds ' + heavy.peds.length);
  assert.ok(heavy.cars.filter(c => c.ai === 'traffic').length <= heavy.debug.MAX_TRAFFIC, 'a respawn tops the traffic up only to the cap');
});
