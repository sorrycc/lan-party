/* Fable Theft Auto's movement code (motion.js): a thumb stick's analog pair moves a pedestrian and drives a car the
   way the keys do, a half push is a stroll, and the keys win whenever one is down. Runs against an empty city. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { IN, stepOnFoot, driveInput, stepCar } from '../client/games/gta/motion.js';

const W = { nearAabbs: () => [] }; // nothing to bump into
const DT = 1 / 60;
const ped = () => ({ x: 0, y: 0, z: 0, yaw: 0, vy: 0, moving: 0, jumpLatch: false, r: 0.42, stuck: 0, inCar: null });
const walk = (p, bits, sx, sz, camYaw = 0, frames = 60) => { for (let i = 0; i < frames; i++) stepOnFoot(W, p, bits, camYaw, false, DT, [], sx, sz); return p; };
const travelled = p => Math.hypot(p.x, p.z);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

test('the stick walks a pedestrian exactly where the keys would', () => {
  const keys = walk(ped(), IN.UP, 0, 0), stick = walk(ped(), 0, 0, 1);
  assert.ok(near(keys.x, stick.x) && near(keys.z, stick.z), 'forward');
  const keysR = walk(ped(), IN.RIGHT, 0, 0), stickR = walk(ped(), 0, 1, 0);
  assert.ok(near(keysR.x, stickR.x) && near(keysR.z, stickR.z), 'sideways');
  const turned = walk(ped(), 0, 0, 1, Math.PI / 2), keysT = walk(ped(), IN.UP, 0, 0, Math.PI / 2);
  assert.ok(near(turned.x, keysT.x) && near(turned.z, keysT.z), 'the stick is relative to the camera like the keys');
  assert.ok(near(travelled(walk(ped(), 0, 0, 1)), 4.6, 1e-3), 'a second of walking covers the walking speed');
});

test('a half push strolls, a diagonal is no faster than straight, and the sprint bit runs', () => {
  assert.ok(near(travelled(walk(ped(), 0, 0, 0.5)), 2.3, 1e-3), 'half the push, half the speed');
  assert.ok(near(travelled(walk(ped(), 0, Math.SQRT1_2, Math.SQRT1_2)), 4.6, 1e-3), 'a diagonal at full push is the walking speed');
  assert.ok(near(travelled(walk(ped(), 0, 3, 4)), 4.6, 1e-3), 'a push past the unit circle is clamped');
  assert.ok(near(travelled(walk(ped(), IN.SPRINT, 0, 1)), 7.6, 1e-3), 'the sprint bit runs on the stick too');
  assert.equal(walk(ped(), 0, 0, 0).moving, 0, 'a centred stick stands still');
  assert.ok(walk(ped(), 0, 0, 0.5, 0, 1).moving < 3, 'a stroll animates as a walk, not a run');
});

test('a direction key wins over the stick', () => {
  const keys = walk(ped(), IN.UP, 0, 0), both = walk(ped(), IN.UP, 1, -1);
  assert.ok(near(keys.x, both.x) && near(keys.z, both.z));
});

const TYPE = { w: 2.0, l: 4.4, acc: 11, max: 27, brake: 20, mass: 1 };
const car = () => ({ type: TYPE, x: 0, y: 0, z: 0, yaw: 0, vx: 0, vz: 0, angVel: 0, steer: 0, throttle: 0, hand: false, vF: 0, speed: 0, fx: 0, fz: 1, rx: -1, rz: 0, dead: false, r: 1.12, off: 1.08, mass: 1 });
const drive = (c, bits, sx, sz, frames = 60) => { for (let i = 0; i < frames; i++) { driveInput(c, bits, DT, sx, sz); stepCar(W, c, DT, null); } return c; };

test('the stick drives: forward is gas, back is the brake, sideways steers, and the keys win', () => {
  const c = car(); driveInput(c, 0, DT, 0, 0.6); assert.equal(c.throttle, 0.6, 'the gas follows the push');
  driveInput(c, 0, DT, 0, -1); assert.equal(c.throttle, -1);
  driveInput(c, IN.UP, DT, 0, -1); assert.equal(c.throttle, 1, 'the key wins over the stick');
  driveInput(c, 0, DT, 0, 0); assert.equal(c.throttle, 0);
  const s = car(); for (let i = 0; i < 30; i++) driveInput(s, 0, DT, 1, 0); assert.ok(s.steer < -0.95, 'a stick held right reaches full lock the way the right key would (' + s.steer + ')');
  for (let i = 0; i < 60; i++) driveInput(s, IN.LEFT, DT, 1, 0); assert.ok(s.steer > 0.9, 'the left key wins over a stick held right (the key eases in over a second)');
  for (let i = 0; i < 60; i++) driveInput(s, 0, DT, 0, 0); assert.ok(Math.abs(s.steer) < 0.02, 'a centred stick lets the wheel straighten');
  driveInput(s, IN.SPACE, DT, 0, 0); assert.equal(s.hand, true, 'the handbrake is still the key bit');
});

test('a stick-driven car goes forward and turns the way the keys would', () => {
  const keys = drive(car(), IN.UP, 0, 0), stick = drive(car(), 0, 0, 1);
  assert.ok(stick.z > 3 && near(stick.z, keys.z, 1e-6) && near(stick.x, keys.x, 1e-6), 'full gas on the stick is full gas');
  const keysR = drive(car(), IN.UP | IN.RIGHT, 0, 0), stickR = drive(car(), 0, 1, 1);
  assert.ok(keysR.yaw < -0.05 && stickR.yaw < -0.05, 'right on the stick turns the same way as the right key');
  const stroll = drive(car(), 0, 0, 0.5); assert.ok(stroll.z > 0.5 && stroll.z < stick.z, 'half the push is less gas');
});
