/* Things that move: how a pedestrian or a car is drawn into the instanced pools, and the static tables that
   describe them. A "view" owns pool slots and draws whatever state object it is given, so the host draws its
   simulated entities and a client draws its interpolated copies through the same code.

   State fields read by PedView.draw:  x y z yaw dead deadT inCar moving hitT armRaise kind camPitch gun down ride seat
   State fields read by CarView.draw:  x y z yaw steer speed dead lights */
import { lerp } from '../../core/math.js';
import { AVATARS } from '../../core/avatars.js';
import { makeRng } from '../../core/math.js';
import { PI, groundY } from './world.js';

export const KINDS = ['civ', 'cop', 'guard', 'vinny', 'player', 'swat']; // indexed on the wire, so only ever append
export const kindIdx = k => KINDS.indexOf(k);

/* ped state flags on the wire */
export const PF = { DEAD: 1, INCAR: 2, WALK: 4, RUN: 8, ARM: 16, HIT: 32, OLDDEAD: 64, DOWN: 128, RIDE: 256 }; // DOWN: lying hurt but alive (a patient waiting for the ambulance); RIDE: on a motorcycle, drawn in the saddle
/* car state flags on the wire */
export const CF = { DEAD: 1, SMOKE: 2, BURN: 4, LIGHTS: 8 };

/* `basic` weapons are everyone's from the start; the others come out of the crates around the city (and the airdrop) and are
   dropped again when their owner dies. `pick` is what an ammo pickup adds to the reserve; `splash` is a rocket's blast radius. */
export const WEAPONS = [
  { key: 'pistol', name: 'PISTOL', mag: 12, ammo: 12, reserve: 96, rate: 0.2, dmg: 34, spread: 0.012, auto: false, pellets: 1, reload: 1.1, range: 140, recoil: 0.01, basic: true, pick: 24 },
  { key: 'shotgun', name: 'SHOTGUN', mag: 6, ammo: 6, reserve: 30, rate: 0.7, dmg: 17, spread: 0.065, auto: false, pellets: 8, reload: 1.9, range: 45, recoil: 0.035, basic: true, pick: 8 },
  { key: 'smg', name: 'SMG', mag: 30, ammo: 30, reserve: 180, rate: 0.08, dmg: 13, spread: 0.032, auto: true, pellets: 1, reload: 1.5, range: 110, recoil: 0.006, basic: true, pick: 40 },
  { key: 'sniper', name: 'SNIPER', mag: 5, ammo: 5, reserve: 10, rate: 1.1, dmg: 120, spread: 0.002, auto: false, pellets: 1, reload: 2.4, range: 260, recoil: 0.05, pick: 3 },
  { key: 'rpg', name: 'ROCKET', mag: 1, ammo: 1, reserve: 2, rate: 1.5, dmg: 60, spread: 0.004, auto: false, pellets: 1, reload: 2.8, range: 200, recoil: 0.08, pick: 1, splash: 7 },
]; // indexed on the wire, so only ever append

export const CAR_TYPES = [
  { name: 'sedan', w: 2.0, l: 4.4, bh: 0.75, ch: 0.62, cl: 0.46, cz: -0.06, acc: 11, max: 27, brake: 20, mass: 1.0, colors: [0xd12b2b, 0x2b5fd1, 0xf0f0f0, 0x222222, 0x8a8a8a, 0x2ba64a, 0x6a2bd1, 0xd18a2b, 0x7fb8e0] },
  { name: 'sports', w: 2.05, l: 4.5, bh: 0.58, ch: 0.46, cl: 0.4, cz: -0.1, acc: 16, max: 36, brake: 24, mass: 0.9, colors: [0xff2020, 0xffe14d, 0xffffff, 0x111111, 0x20d0ff, 0xff40c0] },
  { name: 'taxi', w: 2.0, l: 4.4, bh: 0.75, ch: 0.62, cl: 0.46, cz: -0.06, acc: 11, max: 26, brake: 20, mass: 1.0, colors: [0xf2c014], taxi: true },
  { name: 'pickup', w: 2.15, l: 5.1, bh: 0.9, ch: 0.72, cl: 0.32, cz: 0.14, acc: 10, max: 25, brake: 18, mass: 1.3, colors: [0x8a3a1a, 0x2b4a8a, 0xdddddd, 0x3a3a3a, 0x5a7a3a] },
  { name: 'van', w: 2.2, l: 5.2, bh: 0.95, ch: 1.0, cl: 0.74, cz: -0.06, acc: 8.5, max: 23, brake: 17, mass: 1.45, colors: [0xffffff, 0x3a7ad1, 0xd1d1d1, 0x7a3a8a, 0x2a2a2a] },
  { name: 'cop', w: 2.0, l: 4.6, bh: 0.75, ch: 0.62, cl: 0.46, cz: -0.06, acc: 14, max: 31, brake: 22, mass: 1.1, colors: [0x111111], cabin: 0xf4f4f4, cop: true },
  { name: 'ambulance', w: 2.2, l: 5.4, bh: 1.0, ch: 1.05, cl: 0.72, cz: -0.08, acc: 9, max: 24, brake: 18, mass: 1.5, colors: [0xffffff], cabin: 0xe02020, ambulance: true },
  /* the armored truck of the world event: slow, heavy, takes four cars' worth of damage and spills cash when it goes */
  { name: 'armored', w: 2.3, l: 5.6, bh: 1.05, ch: 0.8, cl: 0.5, cz: -0.1, acc: 8, max: 22, brake: 16, mass: 2.2, colors: [0x3a4a3a], cabin: 0x2a2f2a, armored: true, hp: 400 },
  /* the SWAT van that comes at five stars: a cop car with four SWAT inside */
  { name: 'swat', w: 2.3, l: 5.4, bh: 1.0, ch: 0.95, cl: 0.7, cz: -0.06, acc: 12, max: 29, brake: 20, mass: 1.8, colors: [0x101418], cabin: 0x101418, cop: true, swat: true, hp: 160 },
  /* the bus: twice a sedan's length (so it collides along four spheres, see motion.js carOffs), slow to turn, hard to stop, seven ride along */
  { name: 'bus', w: 2.5, l: 10.5, bh: 1.25, ch: 1.35, cl: 0.94, cz: 0, acc: 6.5, max: 21, brake: 13, mass: 3.2, turn: 1.5, colors: [0x2f8fd1, 0xd18a2b, 0x3fa04a], cabin: 0x9fd0ff, bus: true, hp: 220, seats: 7 },
  /* the motorcycle: quick and nimble, light as a feather in a crash, the rider sits in the open and is thrown by a hard hit; one rides pillion */
  { name: 'bike', w: 0.8, l: 2.3, bh: 0.42, ch: 0.28, cl: 0.34, cz: -0.12, acc: 19, max: 39, brake: 22, mass: 0.35, turn: 3.4, colors: [0xd12b2b, 0x222222, 0xffe14d, 0x2b5fd1, 0xf0f0f0], bike: true, hp: 60, seats: 1 },
]; // indexed on the wire, so only ever append
CAR_TYPES.forEach((t, i) => { t.idx = i; });
/* how many ride along besides the driver */
export const seatsOf = T => T.seats !== undefined ? T.seats : 3;
/* where a seat is in the car: `side` is +1 for the right window, -1 for the left (0 on a bike), `back` is along the length from the
   centre. Seat 1 is the front right, then the rows behind alternate left / right; a bike's pillion sits behind the rider. */
export function seatOffset(T, seat) {
  if (T.bike) return { side: 0, back: seat > 0 ? -0.55 : 0 };
  if (seat <= 1) return { side: 1, back: 0.2 };
  return { side: seat % 2 ? 1 : -1, back: Math.max(0.2 - Math.floor(seat / 2) * 1.2, -(T.l / 2 - 0.9)) };
}

const PART_DEF = { // [pivot xyz, offset xyz, size xyz]
  head: [[0, 1.55, 0], [0, 0, 0], [0.5, 0.5, 0.5]],
  hair: [[0, 1.55, 0], [0, 0.29, 0.02], [0.54, 0.16, 0.54]],
  torso: [[0, 0.98, 0], [0, 0, 0], [0.55, 0.65, 0.3]],
  armL: [[-0.39, 1.28, 0], [0, -0.3, 0], [0.22, 0.62, 0.22]],
  armR: [[0.39, 1.28, 0], [0, -0.3, 0], [0.22, 0.62, 0.22]],
  legL: [[-0.14, 0.68, 0], [0, -0.33, 0], [0.25, 0.68, 0.25]],
  legR: [[0.14, 0.68, 0], [0, -0.33, 0], [0.25, 0.68, 0.25]],
};
const PART_NAMES = Object.keys(PART_DEF);
const GUN_DEF = [[0.39, 1.28, 0], [0, -0.58, 0.16], [0.14, 0.22, 0.45]];
const SKINS = [0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffdbac, 0xa0714f];
const HAIRS = [0x1a1a1a, 0x4a2a10, 0xd8b060, 0x8a3a1a, 0x666666, 0x2a1a0a, 0xe04a2a];
const PANTS = [0x2c3e73, 0x333333, 0x5a4632, 0x777777, 0x1a1a2a, 0x8a5a3a, 0xd8d0c0];

/* Body colours for a kind and a style seed (a player's style is their avatar index). Deterministic, so the host
   and every client dress a pedestrian identically from the two numbers that travel over the wire. */
export function pedCols(THREE, kind, style) {
  const { rnd, rr } = makeRng(style * 7919 + 13);
  const pick = arr => arr[Math.floor(rnd() * arr.length)];
  const skin = pick(SKINS);
  if (kind === 'cop') return [skin, 0x1a2a5a, 0x2a3f8f, 0x2a3f8f, 0x2a3f8f, 0x1a2040, 0x1a2040];
  if (kind === 'guard') return [skin, 0x111111, 0x151515, 0x151515, 0x151515, 0x151515, 0x151515];
  if (kind === 'vinny') return [skin, 0xf4f4f4, 0xf4f4f4, 0xf4f4f4, 0xf4f4f4, 0xf4f4f4, 0xf4f4f4];
  if (kind === 'swat') return [skin, 0x111111, 0x1c2430, 0x1c2430, 0x1c2430, 0x161a22, 0x161a22];
  if (kind === 'player') { const av = AVATARS[style] || AVATARS[0]; return [0xc68642, 0x1a1a1a, av.color, 0xc68642, 0xc68642, 0x2a2f45, 0x2a2f45]; }
  const shirt = new THREE.Color().setHSL(rnd(), rr(0.5, 0.9), rr(0.35, 0.6)).getHex(); const pants = pick(PANTS); const sleeves = rnd() < 0.5 ? shirt : skin;
  return [skin, pick(HAIRS), shirt, sleeves, sleeves, pants, pants];
}

function partMatrix(M2, out, ent, def, rotX, scaleY = 1) {
  const [pv, off, sz] = def;
  out.makeTranslation(pv[0], pv[1], pv[2]);
  if (rotX) out.multiply(M2.makeRotationX(rotX));
  out.multiply(M2.makeTranslation(off[0], off[1] * scaleY, off[2]));
  out.multiply(M2.makeScale(sz[0], sz[1] * scaleY, sz[2]));
  out.premultiply(ent);
  return out;
}

export class PedView {
  constructor(W, kind, style) {
    this.W = W; this.kind = kind; this.phase = Math.random() * PI * 2; this.released = false;
    this.M = new W.THREE.Matrix4(); this.M2 = new W.THREE.Matrix4(); this.M3 = new W.THREE.Matrix4();
    this.idx = W.pedPools.map(p => p.alloc());
    this.cols = pedCols(W.THREE, kind, style);
    this.cols.forEach((c, i) => W.pedPools[i].color(this.idx[i], c));
    this.gun = kind === 'player' ? W.gunPool.alloc() : -1;
  }
  hide() { const W = this.W; this.idx.forEach((ix, i) => W.pedPools[i].hide(ix)); if (this.gun >= 0) W.gunPool.hide(this.gun); }
  release() { if (this.released) return; this.released = true; const W = this.W; this.idx.forEach((ix, i) => W.pedPools[i].release(ix)); if (this.gun >= 0) W.gunPool.release(this.gun); }
  draw(s, dt) {
    if (this.released) return;
    const W = this.W, M = this.M, M2 = this.M2, M3 = this.M3;
    const ride = !!(s.inCar && s.ride); // in the saddle of a motorcycle, in the open; in any other car out of sight
    if (s.inCar && !ride) { this.hide(); return; }
    let bodyPitch = 0, y = s.y, x = s.x, z = s.z;
    if (s.dead) { bodyPitch = -PI / 2 * Math.min(1, s.deadT * 4); y = s.y + 0.28 * Math.min(1, s.deadT * 4); }
    else if (s.down) { bodyPitch = -PI / 2; y = s.y + 0.28; } // a patient lies where it fell
    else if (ride) { const T = s.inCar.type, back = T ? seatOffset(T, s.seat || 0).back : 0; x += Math.sin(s.yaw) * back; z += Math.cos(s.yaw) * back; y = s.y + 0.32; bodyPitch = 0.18; } // pillion behind the rider, seat height, a lean over the bars
    M.makeTranslation(x, y, z); M.multiply(M2.makeRotationY(s.yaw)); if (bodyPitch) M.multiply(M2.makeRotationX(bodyPitch));
    if (s.moving > 0) this.phase += dt * (s.moving > 3 ? 11 : 6.5); else this.phase = lerp(this.phase, Math.round(this.phase / PI) * PI, Math.min(1, 10 * dt));
    const amp = s.moving > 3 ? 1.1 : s.moving > 0 ? 0.7 : 0;
    const sw = Math.sin(this.phase) * amp * (s.moving > 0 ? 1 : 0);
    const raise = s.armRaise || 0;
    const aimAngle = -PI / 2 + (s.kind === 'player' ? (s.camPitch || 0) : 0);
    for (let i = 0; i < 7; i++) {
      const name = PART_NAMES[i]; let rot = 0;
      if (ride) { if (name === 'armL' || name === 'armR') rot = -1.1; else if (name === 'legL' || name === 'legR') rot = -1.35; } // hands on the bars, knees up
      else if (name === 'armL') rot = -sw * (1 - raise * 0.5); else if (name === 'armR') rot = lerp(sw, aimAngle, raise);
      else if (name === 'legL') rot = sw; else if (name === 'legR') rot = -sw;
      const def = PART_DEF[name]; let scaleY = 1;
      if (name === 'hair' && s.kind === 'vinny') scaleY = 2.2;
      partMatrix(M2, M3, M, def, rot, scaleY);
      if (name === 'head' && s.hitT > 0) M3.multiply(M2.makeScale(1.1, 1.1, 1.1));
      W.pedPools[i].set(this.idx[i], M3);
    }
    if (this.gun >= 0) {
      if (s.gun && !s.dead) { GUN_DEF[2][2] = s.gun === 'pistol' ? 0.45 : s.gun === 'sniper' ? 1.25 : s.gun === 'rpg' ? 1.1 : 0.85; partMatrix(M2, M3, M, GUN_DEF, lerp(sw, aimAngle, raise)); W.gunPool.set(this.gun, M3); }
      else W.gunPool.hide(this.gun);
    }
  }
}

export class CarView {
  constructor(W, type, color, cabin) {
    this.W = W; this.type = type; this.color = color; this.cabin = cabin; this.released = false; this.wasDead = false; this.wheelSpin = 0;
    this.M = new W.THREE.Matrix4(); this.M2 = new W.THREE.Matrix4(); this.M3 = new W.THREE.Matrix4();
    this.ib = W.carBody.alloc(); this.ic = W.carCabin.alloc(); this.iw = [0, 1, 2, 3].map(() => W.carWheel.alloc()); this.il = [0, 1, 2, 3, 4, 5].map(() => W.carLight.alloc());
    W.carBody.color(this.ib, color); W.carCabin.color(this.ic, cabin);
    this.iw.forEach(i => W.carWheel.color(i, 0x1a1a1a));
    W.carLight.color(this.il[0], 0xfff6c0); W.carLight.color(this.il[1], 0xfff6c0); W.carLight.color(this.il[2], 0xff2020); W.carLight.color(this.il[3], 0xff2020);
    W.carLight.color(this.il[4], type.cop ? 0xff2020 : type.taxi ? 0xffe14d : type.ambulance ? 0xff2020 : 0x000000); W.carLight.color(this.il[5], type.cop ? 0x2040ff : type.ambulance ? 0x2040ff : 0x000000);
  }
  release() { if (this.released) return; this.released = true; const W = this.W; W.carBody.release(this.ib); W.carCabin.release(this.ic); this.iw.forEach(i => W.carWheel.release(i)); this.il.forEach(i => W.carLight.release(i)); }
  /* a fresh paint job (the Pay 'n' Spray); a wreck stays charred */
  recolor(color, cabin) {
    if (this.released) return; this.color = color; this.cabin = cabin;
    if (!this.wasDead) { this.W.carBody.color(this.ib, color); this.W.carCabin.color(this.ic, cabin); }
  }
  draw(s, dt, t) {
    if (this.released) return;
    const W = this.W, T = this.type, M = this.M, M2 = this.M2, M3 = this.M3;
    if (s.dead && !this.wasDead) { this.wasDead = true; W.carBody.color(this.ib, 0x151515); W.carCabin.color(this.ic, 0x101010); this.il.forEach(i => W.carLight.color(i, 0x000000)); }
    this.wheelSpin += (s.vF !== undefined ? s.vF : s.speed) * dt / 0.38;
    M.makeTranslation(s.x, s.y, s.z); M.multiply(M2.makeRotationY(s.yaw));
    const roll = Math.max(-0.06, Math.min(0.06, -s.steer * s.speed * 0.004)); if (roll) M.multiply(M2.makeRotationZ(roll));
    const set = (pool, idx, x, y, z, sx, sy, sz, ry = 0, rx = 0) => { M3.makeTranslation(x, y, z); if (ry) M3.multiply(M2.makeRotationY(ry)); if (rx) M3.multiply(M2.makeRotationX(rx)); M3.multiply(M2.makeScale(sx, sy, sz)); M3.premultiply(M); pool.set(idx, M3); };
    const steerA = s.steer * 0.5;
    if (T.bike) { // a slim frame, the tank as the cabin, two wheels in line, one lamp each end, and a lean into the turn
      const lean = Math.max(-0.35, Math.min(0.35, s.steer * Math.min(1, s.speed / 12) * 0.45)); if (lean) M.multiply(M2.makeRotationZ(-lean));
      set(W.carBody, this.ib, 0, 0.35 + T.bh / 2, 0, T.w * 0.45, T.bh, T.l * 0.8);
      set(W.carCabin, this.ic, 0, 0.35 + T.bh + T.ch / 2, T.l * T.cz, T.w * 0.6, T.ch, T.l * T.cl);
      set(W.carWheel, this.iw[0], 0, 0.38, T.l * 0.36, 0.8, 1, 1, steerA, this.wheelSpin); set(W.carWheel, this.iw[1], 0, 0.38, -T.l * 0.36, 0.8, 1, 1, 0, this.wheelSpin);
      W.carWheel.hide(this.iw[2]); W.carWheel.hide(this.iw[3]);
      const ly = 0.35 + T.bh * 0.8;
      set(W.carLight, this.il[0], 0, ly, T.l / 2 + 0.03, 0.26, 0.2, 0.1); W.carLight.hide(this.il[1]);
      set(W.carLight, this.il[2], 0, ly, -T.l / 2 - 0.03, 0.26, 0.16, 0.1); W.carLight.hide(this.il[3]); W.carLight.hide(this.il[4]); W.carLight.hide(this.il[5]);
      return;
    }
    set(W.carBody, this.ib, 0, 0.35 + T.bh / 2, 0, T.w, T.bh, T.l);
    set(W.carCabin, this.ic, 0, 0.35 + T.bh + T.ch / 2, T.l * T.cz, T.w * 0.86, T.ch, T.l * T.cl);
    for (let k = 0; k < 4; k++) { const sx = k % 2 ? 1 : -1, front = k < 2; set(W.carWheel, this.iw[k], sx * (T.w / 2 - 0.05), 0.38, (front ? 1 : -1) * T.l * 0.32, 1, 1, 1, front ? steerA : 0, this.wheelSpin); }
    const ly = 0.35 + T.bh * 0.6;
    set(W.carLight, this.il[0], -T.w * 0.34, ly, T.l / 2 + 0.03, 0.42, 0.22, 0.1); set(W.carLight, this.il[1], T.w * 0.34, ly, T.l / 2 + 0.03, 0.42, 0.22, 0.1);
    set(W.carLight, this.il[2], -T.w * 0.34, ly, -T.l / 2 - 0.03, 0.42, 0.18, 0.1); set(W.carLight, this.il[3], T.w * 0.34, ly, -T.l / 2 - 0.03, 0.42, 0.18, 0.1);
    const topY = 0.35 + T.bh + T.ch;
    if (T.cop || T.ambulance) { const on = Math.floor(t * 4) % 2; const lit = !!s.lights;
      W.carLight.color(this.il[4], !s.dead && lit ? (on ? 0xff2020 : 0x400000) : 0x400000); W.carLight.color(this.il[5], !s.dead && lit ? (on ? 0x200040 : 0x2040ff) : 0x000040);
      set(W.carLight, this.il[4], -0.5, topY + 0.15, T.l * T.cz, 0.8, 0.28, 0.4); set(W.carLight, this.il[5], 0.5, topY + 0.15, T.l * T.cz, 0.8, 0.28, 0.4); }
    else if (T.taxi) { set(W.carLight, this.il[4], 0, topY + 0.2, T.l * T.cz, 1.2, 0.35, 0.3); W.carLight.hide(this.il[5]); }
    else { W.carLight.hide(this.il[4]); W.carLight.hide(this.il[5]); }
  }
}

/* A floating, spinning pickup cube in the pick pool (host and client both draw them from state). */
const _pm = { M: null, M2: null };
export function drawPickup(W, i, x, z, t) {
  if (!_pm.M) { _pm.M = new W.THREE.Matrix4(); _pm.M2 = new W.THREE.Matrix4(); }
  const { M, M2 } = _pm; const gy = groundY(x, z);
  M.makeTranslation(x, gy + 0.7 + Math.sin(t * 3) * 0.15, z); M.multiply(M2.makeRotationY(t * 2)); M.multiply(M2.makeScale(0.55, 0.55, 0.55)); W.pickPool.set(i, M);
}
export const PICK_COLOR = kind => kind === 'cash' ? 0x3dff7a : kind === 'ammo' ? 0xffe14d : kind === 'bribe' ? 0x4d8bff : kind === 'sniper' ? 0xf4f4ff : kind === 'rpg' ? 0xff7a20 : 0xff4d4d;
/* indexed on the wire, so only ever append; the last two are the weapon crates (their amount is the rounds inside) */
export const PICK_KINDS = ['cash', 'ammo', 'health', 'bribe', 'sniper', 'rpg'];
/* how a player died, indexed on the wire (the per-player block); the weapon keys are among them */
export const CAUSES = ['', 'pistol', 'shotgun', 'smg', 'runover', 'explosion', 'cop', 'guard', 'swat', 'sniper', 'rpg', 'crash']; // crash: thrown off a motorcycle
/* the world events, indexed on the wire */
export const EVENT_KINDS = ['truck', 'airdrop'];
/* the driving jobs (taxi fares, ambulance patients) and their stages, indexed on the wire (the per-player block) */
export const JOB_KINDS = ['', 'taxi', 'ambulance'];
export const JOB_STAGES = ['wait', 'pickup', 'dropoff'];
