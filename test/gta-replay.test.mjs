/* Fable Theft Auto's killcam (replay.js): the ring of recorded frames, the clip a death starts, the interpolated
   playback and the camera behind the killer, with stand-in entities and views. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReplay, REPLAY_KEEP, REPLAY_MIN, REPLAY_RATE, REPLAY_DELAY } from '../client/games/gta/replay.js';

const view = () => ({ released: false, drawn: [], draw(s, dt, t) { this.drawn.push({ ...s, dt, t }); } });
const ped = (id, x, z, extra = {}) => ({ cls: 'ped', id, view: view(), kind: 'player', x, y: 0, z, yaw: 0, dead: false, deadT: 0, moving: 0, hitT: 0, armRaise: 0, camPitch: 0, gun: 'pistol', down: false, ride: false, seat: 0, inCar: null, ...extra });
const car = (id, x, z, extra = {}) => ({ cls: 'car', id, view: view(), type: { name: 'sedan' }, x, y: 0, z, yaw: 1, steer: 0, vF: 10, speed: 10, dead: false, lights: false, ...extra });
const blocks = (...ps) => ps.map(([pedId, carId = -1, camPitch = 0]) => ({ pedId, carId, camPitch }));

/* a killer (player 0, ped 1) walking +x at 10 m/s for `secs`, a victim (player 1, ped 2) standing still, a car and a pickup */
function scene(secs, opts = {}) {
  const rp = createReplay(), k = ped(1, 0, 0, { moving: 5, armRaise: 1 }), v = ped(2, 20, 0), c = car(3, 5, 5), pick = { cls: 'pick', id: 4, i: 0 };
  let t = 0;
  for (; t <= secs + 1e-9; t += 1 / 60) { k.x = 10 * t; k.yaw = 0.5; c.x = 5 + 3 * t; if (opts.step) opts.step(t, k, v, c); rp.record(t, [k, v, c, pick], blocks([1, -1, 0.3], [2])); }
  return { rp, k, v, c, t: t - 1 / 60 };
}

test('the ring keeps the last REPLAY_KEEP seconds at REPLAY_RATE, pedestrians and cars only', () => {
  const { rp, t } = scene(6);
  assert.ok(rp.span <= REPLAY_KEEP + 1e-6 && rp.span > REPLAY_KEEP - 0.1, 'span ' + rp.span);
  assert.ok(rp.frames <= REPLAY_KEEP * REPLAY_RATE + 2 && rp.frames >= REPLAY_KEEP * REPLAY_RATE - 2, 'frames ' + rp.frames);
  assert.equal(rp.active, false);
  assert.ok(rp.start(0, t)); assert.ok(rp.active); assert.equal(rp.killer, 0);
  const f = rp.frame(0); assert.equal(f.states.length, 3, 'the pickup is not recorded'); assert.equal(f.done, false);
});

test('a death is played back from behind the killer, interpolated between recorded frames, and ends', () => {
  const { rp, k, t } = scene(4);
  assert.ok(rp.start(0, t));
  let f = rp.frame(0), first = f.states.find(s => s.id === 1);
  assert.ok(first.x < k.x - REPLAY_KEEP * 10 + 1, 'starts REPLAY_KEEP seconds back: ' + first.x);
  assert.equal(f.cam.subj.x, first.x); assert.equal(f.cam.subj.inCar, null); assert.equal(f.cam.yaw, 0.5); assert.equal(f.cam.pitch, 0.3, 'the block says where the killer looks');
  f = rp.frame(1 / REPLAY_RATE / 2); const mid = f.states.find(s => s.id === 1); // half a recorded frame later: between two frames
  assert.ok(mid.x > first.x && mid.x < first.x + 10 / REPLAY_RATE, 'interpolated ' + mid.x);
  assert.equal(mid.moving, 5); assert.equal(mid.armRaise, 1); assert.equal(mid.gun, 'pistol');
  let n = 0; while (!(f = rp.frame(1 / 60)).done) n++;
  assert.ok(n > 3 * 60 && n < 4 * 60, 'about REPLAY_KEEP seconds of frames: ' + n);
  assert.ok(Math.abs(f.states.find(s => s.id === 1).x - k.x) < 0.5, 'ends where the killer is now'); assert.equal(f.progress, 1);
  rp.stop(); assert.equal(rp.active, false); assert.equal(rp.frame(0), null);
});

test('a killer at the wheel is followed behind the car, looking the way it drives', () => {
  const { rp, t } = scene(3, { step: (t, k, v, c) => { k.inCar = c; k.x = c.x; } });
  const rp2 = createReplay(); // the same scene again, with the block saying the killer is in car 3
  for (let s = 0; s <= 3; s += 1 / 60) { const c = car(3, 5 + 3 * s, 5); const k = ped(1, c.x, 5, { inCar: c }); rp2.record(s, [k, ped(2, 20, 0), c], blocks([1, 3], [2])); }
  assert.ok(rp2.start(0, 3)); const f = rp2.frame(0);
  assert.equal(f.cam.subj.inCar.id, 3); assert.equal(f.cam.yaw, 1); assert.equal(f.cam.pitch, 0.22);
  assert.deepEqual(f.states.find(s => s.id === 1).inCar, { type: { name: 'sedan' } }, 'the view sees a car with a type, for the saddle pose');
  void rp; void t;
});

test('no clip when the ring is too short, the killer is unknown, or their body was not seen', () => {
  const short = scene(REPLAY_MIN / 2); assert.equal(short.rp.start(0, short.t), false);
  const { rp, t } = scene(3);
  assert.equal(rp.start(5, t), false, 'no such player');
  const rp2 = createReplay(); for (let s = 0; s <= 3; s += 1 / 60) rp2.record(s, [ped(2, 20, 0)], blocks([1], [2]));
  assert.equal(rp2.start(0, 3), false, 'the killer\'s ped was never in range');
  assert.equal(rp2.start(1, 3), true, 'the victim\'s own body is');
});

test('recording goes on during a playback, so a second death soon after has its own clip; reset empties the ring', () => {
  const { rp, k, v, c, t } = scene(4);
  assert.ok(rp.start(0, t));
  for (let s = t; s <= t + 5; s += 1 / 60) { k.x = 10 * s; rp.record(s, [k, v, c], blocks([1], [2])); rp.frame(1 / 60); }
  rp.stop(); assert.ok(rp.start(0, t + 5)); assert.ok(Math.abs(rp.frame(0).states.find(s => s.id === 1).x - 10 * (t + 5 - REPLAY_KEEP)) < 1);
  rp.reset(); assert.equal(rp.frames, 0); assert.equal(rp.active, false); assert.equal(rp.start(0, t + 5), false);
});

test('a released view is left out of the recording, and a state is drawn through the entity\'s own view', () => {
  const k = ped(1, 0, 0), v = ped(2, 20, 0), gone = ped(9, 1, 1); gone.view.released = true;
  const rp = createReplay(); for (let s = 0; s <= 2; s += 1 / 60) rp.record(s, [k, v, gone], blocks([1], [2]));
  assert.ok(rp.start(0, 2)); const f = rp.frame(0);
  assert.equal(f.states.length, 2); for (const st of f.states) st.view.draw(st, 1 / 60, 2);
  assert.equal(k.view.drawn.length, 1); assert.equal(k.view.drawn[0].id, 1);
  assert.ok(REPLAY_DELAY > 0 && REPLAY_DELAY < 1);
});

/* ---- against the real thing: the host's simulation and a client's copy, drawn through the real views into stub pools */
import * as THREE from 'three';
import { createSim } from '../client/games/gta/sim.js';
import { createRemote, parseBlock } from '../client/games/gta/remote.js';

const pool = () => ({ n: 0, alloc() { return this.n++; }, release() {}, color() {}, hide() {}, set() { this.sets = (this.sets || 0) + 1; }, dirty() {} });
const stubWorld = () => ({ THREE, aabbs: [], nearAabbs: () => [], hasLOS: () => true, pickPool: pool(), pedPools: Array.from({ length: 7 }, pool), gunPool: pool(), carBody: pool(), carCabin: pool(), carWheel: pool(), carLight: pool(), dirtyDynamic() {} });
const players = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, avatar: i }));

test('the host records its simulation and plays a kill back from behind the killer through the real views', () => {
  const W = stubWorld(), sim = createSim({ W, session: { players: players(2), seed: 7 }, opts: { minutes: 10 } }), rp = createReplay();
  const [a, b] = sim.players; let t = 0;
  const tick = () => { sim.update(1 / 60); t += 1 / 60; rp.record(t, sim.ents.values(), sim.players.map(p => parseBlock(sim.block(p)))); };
  for (let k = 0; k < 120; k++) tick();
  sim.debug.killPlayer(b, a, 'pistol'); for (let k = 0; k < 30; k++) tick(); // half a second of the fall (REPLAY_DELAY)
  assert.ok(rp.start(0, t), 'a clip for player 0, the killer');
  sim.S.draw = false; const before = W.carBody.sets || 0; sim.update(1 / 60); assert.equal(W.carBody.sets || 0, before, 'the sim leaves the pools alone while the killcam draws');
  let f = rp.frame(0); assert.ok(f.cam && f.states.length > 10);
  const killer = f.states.find(s => s.id === a.ped.id), victim = f.states.find(s => s.id === b.ped.id);
  assert.ok(killer && victim); assert.equal(victim.dead, false, 'the clip starts before the death');
  for (const st of f.states) st.view.draw(st, 1 / 60, t); // every state drawn through its own view without complaint
  let last; while (!(last = rp.frame(1 / 60)).done);
  assert.equal(last.states.find(s => s.id === b.ped.id).dead, true, 'and ends with the victim down');
  sim.S.draw = true; sim.dispose();
});

test('a client records the copy it interpolates from the host\'s snapshots, and finds the killer there', () => {
  const HW = stubWorld(), sim = createSim({ W: HW, session: { players: players(2), seed: 7 }, opts: { minutes: 10 } });
  const CW = stubWorld(), remote = createRemote({ W: CW }), rp = createReplay(), client = { id: 'p1', known: new Set(), pl: sim.players[1] };
  const [a, b] = sim.players; let t = 0;
  const tick = () => { sim.update(1 / 30); sim.prepareNet(); remote.apply(sim.snapshotFor(client)); sim.endNet(); t += 1 / 30; remote.update(1 / 30, t, 1, 0, null, false); rp.record(t, remote.ents.values(), remote.R.P); };
  for (let k = 0; k < 90; k++) tick();
  const before = CW.carBody.sets || 0; assert.equal(before, 0, 'update(draw = false) leaves the views alone');
  sim.debug.killPlayer(b, a, 'smg'); for (let k = 0; k < 15; k++) tick();
  assert.ok(rp.start(0, t)); const f = rp.frame(0);
  assert.ok(f.cam && f.states.find(s => s.id === a.ped.id), 'the killer\'s body is in the client\'s copy');
  for (const st of f.states) st.view.draw(st, 1 / 30, t); assert.ok((CW.carBody.sets || 0) > 0, 'the playback draws the cars');
  remote.clear(); sim.dispose();
});
