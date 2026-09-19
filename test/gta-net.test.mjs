/* Fable Theft Auto's client side of the wire, headless: remote.js keeps the host's snapshot spacing through bursts and stalls
   (the host's stamps through core/interp.js's snapshot clock, a short dead-reckoning instead of a freeze), and predict.js keeps a
   predicted car out of the other cars and glides a mid-sized correction in instead of snapping. */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createRemote, EXTRAP } from '../client/games/gta/remote.js';
import { createPredictor, CAR_GATE, CAR_BLEND } from '../client/games/gta/predict.js';
import { CAR_TYPES } from '../client/games/gta/entities.js';
import { IN } from '../client/games/gta/motion.js';

const pool = () => ({ alloc() { return 0; }, release() {}, color() {}, hide() {}, set() {}, dirty() {} });
const stubWorld = () => ({ THREE, aabbs: [], nearAabbs: () => [], hasLOS: () => true, pickPool: pool(), pedPools: Array.from({ length: 7 }, pool), gunPool: pool(), carBody: pool(), carCabin: pool(), carWheel: pool(), carLight: pool(), dirtyDynamic() {} });
/* a car entry as sim.js packs it: id, type, colours, x, z, yaw, steer, vF, flags */
const carAt = (id, x, z, vF = 10) => [id, 0, 0xffffff, 0x222630, x, z, 0, 0, vF, 0];
const SPEED = 10, HZ = 30, FRAME = 1 / 60;

/* a host sending a car driving along +x at SPEED, 30 snapshots a second stamped with its clock; `deliver(i)` says when snapshot i
   arrives (seconds on our clock); the client renders at 60 fps and we record the car's x every frame */
function drive(deliver, secs = 4, stamped = true) {
  let now = 100; const remote = createRemote({ W: stubWorld(), now: () => now });
  const sends = []; for (let i = 0; i < secs * HZ; i++) { const m = { t: 's', v: [carAt(7, i / HZ * SPEED, 0)] }; if (stamped) m.ts = 5000 + i * 1000 / HZ; sends.push({ m, at: deliver(i) }); }
  const xs = []; let k = 0;
  for (let f = 0; f < secs * 60; f++) { now = 100 + f * FRAME;
    while (k < sends.length && sends[k].at <= now) remote.apply(sends[k++].m);
    remote.update(FRAME, now, 0, 0, null, true); const e = remote.get(7); xs.push(e ? e.x : NaN); }
  return xs;
}
const steps = xs => xs.slice(1).map((x, i) => x - xs[i]).filter(Number.isFinite);

test('bursts: three snapshots arriving at once keep their spacing, so the car glides instead of stalling and jumping', () => {
  const burst = i => 100 + 0.005 + (Math.floor(i / 3) * 3 + 2) / HZ; // every third frame the network delivers the last three together
  const d = steps(drive(burst)).slice(90), want = SPEED * FRAME; // after a second and a half of warm-up
  const stalls = d.filter(v => v < want * 0.3).length, jumps = d.filter(v => v > want * 2).length;
  assert.equal(stalls, 0, 'no frame stands still'); assert.equal(jumps, 0, 'no frame leaps');
  const old = steps(drive(burst, 4, false)).slice(90); // the same stream stamped on arrival (an old host without `ts`)
  assert.ok(old.filter(v => v < want * 0.3).length > 10, 'stamped on arrival it would stutter');
});

test('a stall: past the newest snapshot a moving car is carried on for a moment instead of freezing, then held, and never runs backwards', () => {
  const stall = i => 100 + 0.004 + (i >= 60 && i <= 67 ? 67 : i) / HZ; // two seconds in the link stalls for a quarter second, then delivers the backlog at once
  const xs = drive(stall, 3), d = steps(xs), want = SPEED * FRAME;
  const out = xs.findIndex((x, f) => f > 100 && d[f] !== undefined && d[f] === 0) ; // the first frame the car stood still
  assert.ok(out > 0, 'it does hold at some point during the stall');
  let moved = 0; for (let f = 118; f < out; f++) if (d[f] > want * 0.5) moved++;
  assert.ok(moved >= 5, 'but it went on moving for ' + moved + ' frames after the data ran out (EXTRAP ' + EXTRAP + ' s)');
  assert.ok(Math.min(...d) >= 0, 'never backwards'); assert.ok(Math.max(...d) < SPEED * 0.2, 'the catch-up is under two tenths of a second of travel');
});

test('a car that sat still starts moving when it really did, not smeared back over the quiet spell', () => {
  let now = 100; const remote = createRemote({ W: stubWorld(), now: () => now });
  remote.apply({ ts: 1000, v: [carAt(3, 0, 0, 0)] });
  for (let f = 0; f < 120; f++) { now += FRAME; remote.update(FRAME, now, 0, 0, null, true); }
  assert.equal(remote.get(3).x, 0, 'parked');
  const t0 = 1000 + 120 * FRAME * 1000; let x = 0; const xs = [];
  for (let i = 0; i < 30; i++) { x += SPEED / HZ; if (i % 2 === 0) remote.apply({ ts: t0 + i * 1000 / HZ, v: [carAt(3, x, 0)] }); now += FRAME; remote.update(FRAME, now, 0, 0, null, true); xs.push(remote.get(3).x);
    if (i % 2 === 1) { now += FRAME; remote.update(FRAME, now, 0, 0, null, true); xs.push(remote.get(3).x); } }
  const d = steps(xs); assert.ok(Math.max(...d) < SPEED * FRAME * 3, 'no leap on the first moves: ' + Math.max(...d).toFixed(3));
});

/* ---------------------------------------------------------------- the predicted car */
const T = CAR_TYPES[0];
function world(parkedZ) {
  const ents = new Map();
  ents.set(1, { id: 1, cls: 'ped', x: 0, y: 0, z: 0, yaw: 0 });
  ents.set(2, { id: 2, cls: 'car', type: T, x: 0, y: 0, z: 0, yaw: 0, vF: 0, steer: 0 });
  if (parkedZ !== undefined) ents.set(3, { id: 3, cls: 'car', type: T, x: 0, y: 0, z: parkedZ, yaw: 0, vF: 0, steer: 0 });
  return { ents, get: id => ents.get(id) };
}
const ME = { pedId: 1, carId: 2, seat: 0, dead: false, ack: 0 };

test('a predicted car stops against a parked one instead of driving through it', () => {
  const remote = world(20), pred = createPredictor({ W: stubWorld() });
  for (let f = 0; f < 240; f++) pred.step(IN.UP, 0, false, FRAME, ME, remote, f * 16);
  const c = pred.local().car; assert.ok(c.z < 20 - T.l * 0.8, 'held behind it: ' + c.z.toFixed(2));
  const free = createPredictor({ W: stubWorld() }), open = world(); for (let f = 0; f < 240; f++) free.step(IN.UP, 0, false, FRAME, ME, open, f * 16);
  assert.ok(free.local().car.z > 30, 'with the road clear it would be long past');
});

test('a correction past the old gate glides in; only a teleport snaps', () => {
  const remote = world(), pred = createPredictor({ W: stubWorld() }); let q = 0;
  for (let f = 0; f < 30; f++) q = pred.step(IN.UP, 0, false, FRAME, ME, remote, f * 16);
  const before = { ...pred.local().car }, c0 = pred.corrections, off = (CAR_GATE + CAR_BLEND) / 2;
  pred.reconcile({ v: [[2, 0, 0, 0, before.x + off, before.z, 0, 0, before.vF, 0]] }, { ...ME, ack: q }, 600);
  const after = pred.local().car; assert.ok(Math.abs(after.x - before.x) < 0.5, 'no visible jump: ' + (after.x - before.x).toFixed(2)); assert.equal(pred.corrections, c0 + 1, 'counted');
  for (let f = 0; f < 30; f++) pred.step(0, 0, false, FRAME, ME, remote, 600 + f * 16);
  assert.ok(pred.local().car.x > off * 0.9, 'and glided over within half a second: ' + pred.local().car.x.toFixed(2));
  const q2 = pred.step(0, 0, false, FRAME, ME, remote, 1200); const here = { ...pred.local().car };
  pred.reconcile({ v: [[2, 0, 0, 0, here.x + 40, here.z, 0, 0, 0, 0]] }, { ...ME, ack: q2 }, 1300);
  assert.ok(Math.abs(pred.local().car.x - (here.x + 40)) < 1e-6, 'forty metres out is a teleport: snapped');
});
