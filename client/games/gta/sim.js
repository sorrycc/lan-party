/* The host's simulation of Los Pixeles: every pedestrian, car, cop, pickup, the mission and the clock, for N
   players at once. Solo play runs the same code with one player and no network.

   Players feed it input bits + camera angles (setInput) and one-shot actions (action). Everything the other
   machines need to see or hear leaves through two channels:
     - `emit(ev, x, z)` queues a one-shot event ([type, ...args]) and fires the local onEvent immediately;
     - `prepareNet()` / `snapshotFor(client)` / `endNet()` build per-client delta snapshots (entities within
       range that changed since the last tick, plus a per-player HUD block and the events that concern them). */
import { clamp, lerp } from '../../core/math.js';
import { AVATARS } from '../../core/avatars.js';
import { PI, TAU, dist2, angDiff, X, NB, HALF, ROAD, PITCH, SW, LANE, PARK, cellOf, inCity, BEACH_Z1, groundY, PLAZA, HOSPITAL, POLICE, cornerXZ, rayAabb, raySphere, computeCamera } from './world.js';
import { kindIdx, PF, CF, WEAPONS, CAR_TYPES, PedView, CarView, drawPickup, PICK_COLOR, PICK_KINDS } from './entities.js';

const rnd = Math.random;
const rr = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rr(a, b + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;

export const IN = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, SPRINT: 16, SPACE: 32, FIRE: 64 };
export const HINT = ['', 'F  EXIT CAR      SPACE  HANDBRAKE', 'F  JACK CAR', 'F  ENTER CAR'];
export const MISSION_STATES = ['intro', 'goto', 'hit', 'passed', 'escape', 'done'];
export const OBJECTIVES = { intro: 'Get to Diamond Plaza, downtown.', goto: 'Get to Diamond Plaza, downtown.', hit: "Whack Vinny 'Snitch' Voxel. Watch the bodyguards.", passed: 'Mission passed. Lose the cops.', escape: 'Lose the wanted level.', done: 'Free roam. Cause chaos in Los Pixeles.' };
export const INTRO_T = 5.5;
export const START_CLOCK = { morning: 9.4, sunset: 18.2, night: 23.5 };
const NET_RANGE2 = 320 * 320, EV_RANGE2 = 360 * 360, MAX_COPS = 24, MAX_COP_CARS = 8;
const TARGETED = new Set(['hurt', 'wasted', 'respawn', 'wanted', 'float', 'pickup', 'click', 'enter', 'reload']);
const SPAWN_ROAD = 3, SPAWN_BLOCK = 7; // the players line up on Ender Ave beside block (3,7), four per sidewalk
export const SPAWNS = Array.from({ length: 8 }, (_, i) => { const side = i < 4 ? -1 : 1, z = X(SPAWN_BLOCK) + 12 + (i % 4) * 8;
  return { x: X(SPAWN_ROAD) + side * 9.6, z, cx: X(SPAWN_ROAD) + side * PARK, yaw: side < 0 ? 0 : PI, face: side < 0 ? PI / 2 : -PI / 2 }; });

export function createSim({ W, session, opts = {}, onEvent = () => {} }) {
  const peds = [], cars = [], pickups = [], cops = [], players = [], events = [];
  const ents = new Map(); // id -> entity, everything that can appear on the wire
  let nextId = 1;
  const friendly = opts.friendlyFire !== false;
  const S = { clockH: START_CLOCK[opts.time] ?? START_CLOCK.morning, timeLeft: (Number(opts.minutes) || 0) * 60, unlimited: !(Number(opts.minutes) > 0), phase: 'play', t: 0, spawnT: 0 };
  const mission = { state: 'intro', t: 0, vinny: null, guards: [], hostile: false, passedT: 0, killer: null };
  const emit = (ev, x, z) => { events.push({ e: ev, x, z }); onEvent(ev); };
  const camTmp = {};

  /* ============================================================ players */
  class Player {
    constructor(info, idx) {
      this.id = info.id; this.idx = idx; this.name = info.name || 'Player'; this.avatar = info.avatar | 0; this.ped = null; this.gone = false;
      this.camYaw = 0; this.camPitch = 0.22; this.bits = 0; this.clicks = 0; this.clicksSeen = null;
      this.wanted = 0; this.heat = 0; this.crimeT = 0; this.seenT = 0; this.copSpawnT = 0; this.cash = 250; this.kills = 0;
      this.weapons = WEAPONS.map(w => ({ ...w })); this.curW = 0; this.reloadT = 0; this.fireT = 0; this.armTimer = 0; this.godT = 0; this.noDmgT = 0; this.wastedT = 0; this.hint = 0; this.jumpLatch = false;
    }
    get car() { return this.ped ? this.ped.inCar : null; }
    get dead() { return !this.ped || this.ped.dead; }
  }
  const alive = pl => pl && !pl.gone && pl.ped && !pl.ped.dead;
  function nearestPlayer(x, z, pred) { let best = null, bd = Infinity; for (const pl of players) { if (!alive(pl) || (pred && !pred(pl))) continue; const d = dist2(pl.ped.x, pl.ped.z, x, z); if (d < bd) { bd = d; best = pl; } } return best; }
  function minPlayerDist2(x, z) { let bd = Infinity; for (const pl of players) { if (pl.gone || !pl.ped) continue; const d = dist2(pl.ped.x, pl.ped.z, x, z); if (d < bd) bd = d; } return bd; }
  function anchor() { const list = []; for (const pl of players) if (!pl.gone && pl.ped) list.push(pl); return list.length ? pick(list) : null; }
  const driverOf = c => c.driver && c.driver.owner ? c.driver.owner : null;

  /* ============================================================ pedestrians */
  class Ped {
    constructor(kind, x, z, style, owner) {
      this.id = nextId++; this.cls = 'ped'; this.kind = kind; this.owner = owner || null; this.x = x; this.z = z; this.y = groundY(x, z); this.vy = 0; this.yaw = rr(0, TAU);
      this.health = kind === 'vinny' ? 170 : kind === 'guard' ? 90 : kind === 'cop' ? 55 : kind === 'player' ? 100 : 40;
      this.dead = false; this.deadT = 0; this.state = kind === 'civ' ? 'walk' : 'idle'; this.moving = 0;
      this.flee = 0; this.tx = x; this.tz = z; this.speedMul = rr(0.8, 1.25); this.shootT = rr(0.5, 1.5); this.hostile = false; this.pause = 0;
      this.hitT = 0; this.inCar = null; this.armRaise = 0; this.stuck = 0; this.detourT = 0; this.carStuck = 0; this.camPitch = 0; this.gun = null; this.target = null;
      this.threatX = x; this.threatZ = z; this.killedBy = null; this.released = false; this.sent = null; this.entry = null; this.dirty = true;
      this.style = style !== undefined ? style : kind === 'player' ? (owner ? owner.avatar : 0) : ri(0, 1e6);
      this.view = new PedView(W, kind, this.style); this.r = 0.42;
      ents.set(this.id, this);
      if (kind === 'civ') this.pickNearestCorner();
    }
    pickNearestCorner() {
      const i = clamp(cellOf(this.x), 0, NB - 1), j = clamp(cellOf(this.z), 0, NB - 1);
      let best = 0, bd = 1e9;
      for (let k = 0; k < 4; k++) { const [cx, cz] = cornerXZ(i, j, k); const d = dist2(cx, cz, this.x, this.z); if (d < bd) { bd = d; best = k; } }
      this.bi = i; this.bj = j; this.corner = best; this.dir = rnd() < 0.5 ? 1 : -1;
      const [cx, cz] = cornerXZ(i, j, best); this.tx = cx + rr(-1, 1); this.tz = cz + rr(-1, 1); this.state = 'walk';
    }
    nextTarget() {
      const k = this.corner; let ni = this.bi, nj = this.bj, nk;
      if (rnd() < 0.3) {
        const opts = [];
        if (k === 0) { opts.push([this.bi - 1, this.bj, 1]); opts.push([this.bi, this.bj - 1, 3]); }
        if (k === 1) { opts.push([this.bi + 1, this.bj, 0]); opts.push([this.bi, this.bj - 1, 2]); }
        if (k === 2) { opts.push([this.bi + 1, this.bj, 3]); opts.push([this.bi, this.bj + 1, 1]); }
        if (k === 3) { opts.push([this.bi - 1, this.bj, 2]); opts.push([this.bi, this.bj + 1, 0]); }
        const o = pick(opts);
        if (o[0] >= 0 && o[0] < NB && o[1] >= 0 && o[1] < NB) { ni = o[0]; nj = o[1]; nk = o[2]; }
      }
      if (nk === undefined) { if (rnd() < 0.1) this.dir = -this.dir; nk = (k + this.dir + 4) % 4; }
      this.bi = ni; this.bj = nj; this.corner = nk;
      const [cx, cz] = cornerXZ(ni, nj, nk); this.tx = cx + rr(-1.2, 1.2); this.tz = cz + rr(-1.2, 1.2);
      if (rnd() < 0.12) this.pause = rr(1, 4);
    }
    release() { if (this.released) return; this.released = true; this.view.release(); ents.delete(this.id); }
    hide() { this.view.hide(); }
    moveToward(tx, tz, speed, dt) {
      const dx = tx - this.x, dz = tz - this.z, d = Math.hypot(dx, dz);
      if (d < 0.05) return d;
      const yaw = Math.atan2(dx, dz); this.yaw += angDiff(yaw, this.yaw) * Math.min(1, 10 * dt);
      const s = Math.min(speed, d / dt);
      this.x += dx / d * s * dt; this.z += dz / d * s * dt; this.moving = speed;
      return d;
    }
    collideWorld() {
      const list = W.nearAabbs(this.x, this.z), r = this.r;
      for (let k = 0; k < list.length; k++) { const b = list[k];
        const nx = clamp(this.x, b.x0, b.x1), nz = clamp(this.z, b.z0, b.z1); let dx = this.x - nx, dz = this.z - nz; const d2 = dx * dx + dz * dz;
        if (d2 < r * r) { if (d2 < 1e-6) { const px = Math.min(this.x - b.x0, b.x1 - this.x), pz = Math.min(this.z - b.z0, b.z1 - this.z);
            if (px < pz) this.x += (this.x - b.x0 < b.x1 - this.x) ? -(px + r) : (px + r); else this.z += (this.z - b.z0 < b.z1 - this.z) ? -(pz + r) : (pz + r); }
          else { const d = Math.sqrt(d2); this.x += dx / d * (r - d); this.z += dz / d * (r - d); } this.stuck += 1; }
      }
      if (this.z > BEACH_Z1 - 2) this.z = BEACH_Z1 - 2;
      this.x = clamp(this.x, -HALF - 120, HALF + 120); this.z = Math.max(this.z, -HALF - 120);
    }
    hurt(dmg, by) {
      if (this.dead) return;
      if (this.kind === 'player') { damagePlayer(this.owner, dmg, by); return; }
      this.health -= dmg; this.hitT = 0.25;
      if (this.kind === 'civ') { const tp = by && by.ped ? by.ped : null; this.flee = rr(6, 10); this.threatX = tp ? tp.x : this.x + rr(-1, 1); this.threatZ = tp ? tp.z : this.z + rr(-1, 1); this.state = 'flee'; this.pause = 0; }
      if (this.kind === 'guard' || this.kind === 'vinny') setHostile();
      if (this.health <= 0) this.die(by);
    }
    die(by) {
      if (this.dead) return;
      this.dead = true; this.deadT = 0; this.state = 'dead'; this.moving = 0; this.killedBy = by || null;
      emit(['die', r1(this.x), r1(this.z)], this.x, this.z);
      if (by) { by.kills++; onPlayerKill(this, by); }
      alertPeds(this.x, this.z, 25);
    }
    update(dt) {
      if (this.dead) { this.deadT += dt; if (this.deadT > 30 && minPlayerDist2(this.x, this.z) > 900) this.release(); this.draw(dt); return; }
      this.moving = 0; this.hitT = Math.max(0, this.hitT - dt);
      if (this.kind === 'civ') {
        this.armRaise = lerp(this.armRaise, 0, 3 * dt);
        if (this.flee > 0) { this.flee -= dt; const dx = this.x - this.threatX, dz = this.z - this.threatZ, d = Math.hypot(dx, dz) || 1;
          this.moveToward(this.x + dx / d * 10, this.z + dz / d * 10, 5.5 * this.speedMul, dt);
          if (this.flee <= 0) this.pickNearestCorner(); }
        else if (this.pause > 0) { this.pause -= dt; }
        else { const d = this.moveToward(this.tx, this.tz, 1.5 * this.speedMul, dt); if (d < 0.7) this.nextTarget(); }
      } else if (this.kind === 'cop' || (this.kind === 'guard' && this.hostile)) {
        const tp = this.kind === 'cop' ? nearestPlayer(this.x, this.z, p => p.wanted > 0) : nearestPlayer(this.x, this.z);
        this.target = tp;
        if (tp) {
          const T = tp.ped, car = T.inCar, dP = Math.hypot(T.x - this.x, T.z - this.z);
          const engage = dP < 60 && W.hasLOS(this.x, this.z, T.x, T.z);
          const wantDist = car ? 10 : 7;
          if (engage) { if (dP > wantDist) this.moveToward(T.x, T.z, 5.6, dt); else this.yaw += angDiff(Math.atan2(T.x - this.x, T.z - this.z), this.yaw) * Math.min(1, 10 * dt);
            this.armRaise = lerp(this.armRaise, 1, 6 * dt);
            this.shootT -= dt;
            if (this.shootT <= 0 && dP < 26) { const agg = this.kind === 'guard' ? 1 : clamp(0.45 + tp.wanted * 0.14, 0.5, 1.1); this.shootT = rr(0.8, 1.6) / agg; npcShoot(this, tp, (car ? 0.55 : 0.4) * agg, car ? 3 : this.kind === 'guard' ? 9 : 6); }
          } else { this.armRaise = lerp(this.armRaise, 0, 3 * dt);
            if (this.detourT > 0) { this.detourT -= dt; this.moveToward(this.dtx, this.dtz, 5.2, dt); }
            else { this.moveToward(T.x, T.z, 5.2, dt);
              if (this.stuck > 15) { const a = Math.atan2(T.x - this.x, T.z - this.z) + (rnd() < 0.5 ? 1 : -1) * PI / 2; this.dtx = this.x + Math.sin(a) * 9; this.dtz = this.z + Math.cos(a) * 9; this.detourT = 1.6; this.stuck = 0; } } }
        } else this.armRaise = lerp(this.armRaise, 0, 3 * dt);
      } else if (this.kind === 'vinny') {
        const tp = nearestPlayer(this.x, this.z); const dP = tp ? Math.hypot(tp.ped.x - this.x, tp.ped.z - this.z) : 1e9;
        if (this.hostile) {
          if (tp && (dP < 70 || this.fleeing)) { this.fleeing = dP < 90; const dx = this.x - tp.ped.x, dz = this.z - tp.ped.z, d = Math.hypot(dx, dz) || 1;
            let tx = this.x + dx / d * 8, tz = this.z + dz / d * 8;
            if (this.stuck > 6) { const a = this.yaw + rr(-2, 2); tx = this.x + Math.sin(a) * 8; tz = this.z + Math.cos(a) * 8; this.stuck = 0; }
            this.moveToward(tx, tz, 5.0, dt); }
        } else if (dP < 12 && mission.state === 'hit') setHostile();
      } else if (this.kind === 'guard') { // idle guard: face the nearest player
        const tp = nearestPlayer(this.x, this.z); const dP = tp ? Math.hypot(tp.ped.x - this.x, tp.ped.z - this.z) : 1e9;
        if (tp && dP < 20) this.yaw += angDiff(Math.atan2(tp.ped.x - this.x, tp.ped.z - this.z), this.yaw) * Math.min(1, 4 * dt);
        if (dP < 8 && mission.state === 'hit') setHostile();
      }
      const beforeStuck = this.stuck; this.stuck = 0; this.collideWorld(); if (this.stuck) this.stuck = beforeStuck + 1; else this.stuck = 0;
      if (this.kind === 'civ' && this.stuck > 40) { this.pickNearestCorner(); this.stuck = 0; }
      this.y = groundY(this.x, this.z);
      this.draw(dt);
    }
    draw(dt) { this.view.draw(this, dt); }
  }

  /* ============================================================ cars */
  function segInfo(a, b) {
    const ax = X(a[0]), az = X(a[1]), bx = X(b[0]), bz = X(b[1]); const len = Math.hypot(bx - ax, bz - az);
    const dx = (bx - ax) / len, dz = (bz - az) / len;
    return { a, b, ax, az, bx, bz, dx, dz, len, rx: -dz, rz: dx };
  }
  function chooseNext(a, b) {
    const opts = []; const dx = b[0] - a[0], dz = b[1] - a[1];
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const n = [b[0] + ox, b[1] + oz]; if (n[0] < 0 || n[0] > NB || n[1] < 0 || n[1] > NB) continue;
      if (n[0] === a[0] && n[1] === a[1]) continue;
      opts.push(n); if (ox === dx && oz === dz) { opts.push(n); opts.push(n); }
    }
    return opts.length ? pick(opts) : a;
  }
  class Car {
    constructor(type, x, z, yaw, color) {
      this.id = nextId++; this.cls = 'car'; this.type = type; this.x = x; this.z = z; this.y = groundY(x, z); this.yaw = yaw; this.vx = 0; this.vz = 0; this.angVel = 0;
      this.steer = 0; this.throttle = 0; this.hand = false; this.vF = 0; this.speed = 0;
      this.health = 100; this.dead = false; this.burn = 0; this.driver = null; this.ai = null; this.panic = 0; this.desired = 0; this.target = null; this.lastHitBy = null; this.lights = false; this.smoking = false;
      this.r = type.w / 2 + 0.12; this.off = type.l / 2 - this.r; this.mass = type.mass; this.occupants = 0; this.hornT = 0; this.age = 0; this.yieldT = 0; this.why = ''; this.stuckT = 0; this.pedWaitT = 0;
      this.color = color !== undefined ? color : pick(type.colors);
      this.cabinColor = type.cabin !== undefined ? type.cabin : (rnd() < 0.5 ? this.color : 0x222630);
      this.released = false; this.sent = null; this.entry = null; this.dirty = true;
      this.view = new CarView(W, type, this.color, this.cabinColor);
      this.fx = Math.sin(yaw); this.fz = Math.cos(yaw); this.rx = -this.fz; this.rz = this.fx;
      ents.set(this.id, this);
    }
    setSeg(a, b) { this.seg = segInfo(a, b); this.next = chooseNext(a, b); this.nseg = segInfo(b, this.next); }
    rejoin() { // find the nearest lane heading roughly our way
      const kx = Math.round((this.x + HALF) / PITCH), kz = Math.round((this.z + HALF) / PITCH);
      const onA = Math.abs(this.x - X(kx)) <= Math.abs(this.z - X(kz));
      let a, b;
      if (onA) { const k = clamp(kx, 0, NB); const j = clamp(cellOf(this.z), 0, NB - 1); if (this.fz >= 0) { a = [k, j]; b = [k, j + 1]; } else { a = [k, j + 1]; b = [k, j]; } }
      else { const k = clamp(kz, 0, NB); const i = clamp(cellOf(this.x), 0, NB - 1); if (this.fx >= 0) { a = [i, k]; b = [i + 1, k]; } else { a = [i + 1, k]; b = [i, k]; } }
      this.setSeg(a, b); this.ai = 'traffic'; this.target = null;
    }
    release() { if (this.released) return; this.released = true; this.view.release(); ents.delete(this.id); }
    damage(d) {
      if (this.dead) return;
      this.health -= d;
      if (this.ai === 'traffic') this.panic = Math.max(this.panic, 2.5);
      if (this.health <= 0) this.explode();
      else if (this.health < 35 && !this.smoking) this.smoking = true;
    }
    explode() {
      if (this.dead) return;
      this.dead = true; this.burn = 7; this.ai = null; this.throttle = 0;
      emit(['explode', r1(this.x), r1(this.y + 1), r1(this.z)], this.x, this.z);
      const by = this.lastHitBy || driverOf(this);
      for (const p of peds) if (!p.dead && !p.inCar && p.kind !== 'player' && dist2(p.x, p.z, this.x, this.z) < 64) p.hurt(200, by);
      for (const pl of players) { if (!alive(pl)) continue; if (pl.ped.inCar === this) damagePlayer(pl, 500, by); else if (!pl.ped.inCar && dist2(pl.ped.x, pl.ped.z, this.x, this.z) < 81) damagePlayer(pl, 70, by); }
      for (const c of cars) if (c !== this && !c.dead && dist2(c.x, c.z, this.x, this.z) < 100) { c.lastHitBy = this.lastHitBy; c.damage(60); }
      if (this.driver && !this.driver.owner) { this.driver.inCar = null; this.driver.hurt(500, by); }
      this.driver = null;
      if (this.lastHitBy) addWanted(this.lastHitBy, 1);
      alertPeds(this.x, this.z, 60);
    }
    drive(dt) {
      if (this.dead || !this.ai) { if (!this.driver) { this.throttle = 0; this.steer = 0; if (!this.dead) this.hand = this.speed < 1; } return; }
      let tx, tz, desired = 12;
      if (this.ai === 'traffic') {
        const s = this.seg; const t = (this.x - s.ax) * s.dx + (this.z - s.az) * s.dz;
        const lat = (this.x - s.ax) * s.rx + (this.z - s.az) * s.rz;
        if (Math.abs(lat - LANE) > 6 || t < -12) { this.rejoin(); return; }
        if (t > s.len - 1.5) { this.setSeg(s.b, this.next); }
        const la = 5 + this.speed * 0.4;
        if (t + la <= s.len) { tx = s.ax + s.dx * (t + la) + s.rx * LANE; tz = s.az + s.dz * (t + la) + s.rz * LANE; }
        else { const n = this.nseg, t2 = t + la - s.len; tx = n.ax + n.dx * t2 + n.rx * LANE; tz = n.az + n.dz * t2 + n.rz * LANE; }
        const turning = (this.nseg.dx !== s.dx || this.nseg.dz !== s.dz);
        desired = this.type.name === 'sports' ? 16 : this.type.name === 'van' ? 11 : 13;
        this.why = ''; if (turning && t > s.len - 14) desired = 6;
        // intersection yield: someone already in the box ahead who is not going my way
        if (t > s.len - 13 && t < s.len - 6 && this.yieldT < 4) {
          let held = false;
          for (const c of cars) { if (c === this || c.dead) continue; if (Math.abs(c.x - s.bx) < 9 && Math.abs(c.z - s.bz) < 9 && Math.abs(angDiff(c.yaw, this.yaw)) > 0.6 && c.speed > 0.5) { desired = 0; this.why = 'yield'; held = true; break; } }
          this.yieldT = held ? this.yieldT + dt : Math.max(0, this.yieldT - dt * 0.3);
        } else if (t >= s.len - 6 || t <= s.len - 13) this.yieldT = 0;
        if (this.panic > 0) { this.panic -= dt; desired = 0; this.why = 'panic'; }
        this.stuckT = (this.speed < 0.5 && this.age > 3) ? this.stuckT + dt : 0;
      } else if (this.ai === 'cop') {
        const tp = nearestPlayer(this.x, this.z, p => p.wanted > 0); this.target = tp;
        if (!tp) { this.rejoin(); return; }
        const T = tp.ped, car = T.inCar, target = car || T; tx = target.x; tz = target.z; const d = Math.hypot(tx - this.x, tz - this.z);
        desired = car ? 27 : (d > 16 ? 24 : 0);
        if (!car && d < 18 && this.speed < 2.5 && this.occupants > 0) { const n = this.occupants; this.occupants = 0;
          for (let k = 0; k < n; k++) { const side = k ? 2.4 : -2.4; const c = new Ped('cop', this.x + this.rx * side, this.z + this.rz * side); c.hostile = true; peds.push(c); cops.push(c); } }
        if (car && d < 8) desired = 30; // ram
      }
      // car ahead / ped ahead sensing
      const fx = this.fx, fz = this.fz, rx = -fz, rz = fx;
      for (const c of cars) { if (c === this) continue; const dx = c.x - this.x, dz = c.z - this.z; if (dx * dx + dz * dz > 400) continue;
        const along = dx * fx + dz * fz, lat = dx * rx + dz * rz;
        if (along > 0 && Math.abs(lat) < 2.5) { const gap = along - this.type.l / 2 - c.type.l / 2; const cv = c.vx * fx + c.vz * fz;
          if (this.ai === 'cop' && this.target && c === this.target.car) continue;
          const obstacle = c.speed < 0.5 && c.ai !== 'traffic' && Math.abs(lat) > 1.1 && this.ai === 'traffic';
          if (obstacle) { if (gap < 6) desired = Math.min(desired, gap < 0.8 ? 0.8 : 3); this.why = 'creep'; }
          else if (gap < 1.5) { if (this.ai === 'traffic' && this.stuckT > 3 && c.speed < 0.5 && (c.ai !== 'traffic' || (c.stuckT || 0) > 3) && (cars.indexOf(this) < cars.indexOf(c) || c.ai !== 'traffic')) { desired = Math.min(desired, 2.5); this.why = 'unstick'; } else { desired = 0; this.why = 'car'; } } else if (gap < 12) { const lim = Math.max(0, cv + (gap - 3) * 1.2); if (lim < desired) desired = lim; } } }
      let pedAhead = false;
      if (this.ai === 'traffic') for (const p of peds) { if (p.dead || p.inCar) continue; const dx = p.x - this.x, dz = p.z - this.z; if (dx * dx + dz * dz > 120) continue;
        const along = dx * fx + dz * fz, lat = dx * rx + dz * rz; if (along > 0 && along < 9 && Math.abs(lat) < 2.0) { desired = this.pedWaitT > 4 ? Math.min(desired, 1.5) : 0; this.why = 'ped'; pedAhead = true; if (this.hornT <= 0 && rnd() < 0.3) { this.hornT = 3; emit(['horn', r1(this.x), r1(this.z)], this.x, this.z); } } }
      if (this.ai === 'traffic') for (const pl of players) { if (!alive(pl) || pl.ped.inCar) continue; const dx = pl.ped.x - this.x, dz = pl.ped.z - this.z; if (dx * dx + dz * dz < 100) { const along = dx * fx + dz * fz, lat = dx * rx + dz * rz; if (along > 0 && Math.abs(lat) < 2.2) { desired = 0; this.why = 'player'; } } }
      this.hornT -= dt; this.pedWaitT = pedAhead ? this.pedWaitT + dt : 0;
      // steer & throttle
      const want = Math.atan2(tx - this.x, tz - this.z); const err = angDiff(want, this.yaw);
      this.steer = clamp(err * 2.2, -1, 1);
      this.desired = desired;
      this.throttle = desired > this.vF + 0.6 ? Math.min(1, (desired - this.vF) * 0.4 + 0.3) : desired < this.vF - 0.8 ? -1 : 0;
      this.hand = desired === 0 && this.speed < 1.5;
    }
    step(dt) {
      const T = this.type; this.age += dt;
      let fx = Math.sin(this.yaw), fz = Math.cos(this.yaw), rx = -fz, rz = fx;
      let vF = this.vx * fx + this.vz * fz, vR = this.vx * rx + this.vz * rz;
      if (!this.dead) {
        if (this.throttle > 0) { if (vF < T.max) vF += T.acc * this.throttle * dt; }
        else if (this.throttle < 0) { if (vF > 0.3) vF -= T.brake * dt; else if (vF > -T.max * 0.33) vF -= T.acc * 0.55 * dt; }
      }
      vF -= vF * 0.4 * dt + Math.sign(vF) * vF * vF * 0.0035 * dt;
      if (this.hand || this.dead) vF -= Math.sign(vF) * Math.min(Math.abs(vF), (this.dead ? 3 : 8) * dt);
      const offroad = groundY(this.x, this.z) > 0.1 && inCity(this.x, this.z);
      const grip = this.hand ? 1.3 : offroad ? 5 : 9;
      vR *= Math.exp(-grip * dt);
      const steerEff = this.steer * clamp(Math.abs(vF) / 6, 0, 1) * (this.hand ? 1.6 : 1) * (1 - clamp((Math.abs(vF) - 16) / 45, 0, 0.5));
      this.yaw += steerEff * 2.4 * dt * (vF < 0 ? -1 : 1) + this.angVel * dt;
      this.angVel *= Math.exp(-3.5 * dt);
      this.vx = fx * vF + rx * vR; this.vz = fz * vF + rz * vR;
      this.x += this.vx * dt; this.z += this.vz * dt;
      this.vF = vF; this.speed = Math.abs(vF);
      this.fx = Math.sin(this.yaw); this.fz = Math.cos(this.yaw); this.rx = -this.fz; this.rz = this.fx;
      this.collideWorld();
      this.y = lerp(this.y, groundY(this.x, this.z), Math.min(1, 12 * dt));
      if (offroad && this.ai === 'traffic' && this.speed > 1) this.panic = Math.max(this.panic, 1);
      // run over peds (players are knocked aside, everyone else is flattened)
      if (this.speed > 2.5) {
        const hitR2 = (T.l / 2 + 1.2) ** 2, drv = driverOf(this);
        for (const p of peds) { if (p.dead || p.inCar) continue; const dx = p.x - this.x, dz = p.z - this.z; if (dx * dx + dz * dz > hitR2) continue;
          const lx = dx * this.rx + dz * this.rz, lz = dx * this.fx + dz * this.fz;
          if (Math.abs(lx) < T.w / 2 + 0.3 && Math.abs(lz) < T.l / 2 + 0.3) {
            if (p.kind === 'player') { if (friendly || !drv) damagePlayer(p.owner, this.speed * 3.5, drv); p.x += this.fx * 1.5 + this.rx * (lx > 0 ? 1.5 : -1.5); p.z += this.fz * 1.5 + this.rz * (lx > 0 ? 1.5 : -1.5); p.vy = 4; emit(['crash', r1(this.x), r1(this.y + 0.8), r1(this.z), 10], this.x, this.z); }
            else { p.hurt(500, drv); emit(['runover', r1(p.x), r1(p.z), r2(this.yaw)], p.x, p.z); p.yaw = this.yaw + rr(-0.5, 0.5); this.damage(1); if (drv) addWanted(drv, 1); } } }
      }
      if (this.burn > 0) this.burn -= dt;
    }
    collideWorld() {
      const list = W.nearAabbs(this.x, this.z), r = this.r;
      for (const s of [-1, 1]) {
        const cx = this.x + this.fx * this.off * s, cz = this.z + this.fz * this.off * s;
        for (let k = 0; k < list.length; k++) { const b = list[k]; if (b.h < 0.6) continue;
          const nx = clamp(cx, b.x0, b.x1), nz = clamp(cz, b.z0, b.z1); let dx = cx - nx, dz = cz - nz; const d2 = dx * dx + dz * dz;
          if (d2 >= r * r) continue;
          let d = Math.sqrt(d2);
          if (d < 1e-4) { const px = Math.min(cx - b.x0, b.x1 - cx), pz = Math.min(cz - b.z0, b.z1 - cz);
            if (px < pz) { dx = (cx - b.x0 < b.x1 - cx) ? -1 : 1; dz = 0; d = -px; } else { dz = (cz - b.z0 < b.z1 - cz) ? -1 : 1; dx = 0; d = -pz; } }
          else { dx /= d; dz /= d; }
          const pen = r - d; this.x += dx * pen; this.z += dz * pen;
          const vn = this.vx * dx + this.vz * dz;
          if (vn < 0) { const imp = -vn; this.vx -= dx * vn * 1.25; this.vz -= dz * vn * 1.25; this.vx *= 0.9; this.vz *= 0.9;
            const rxv = this.fx * this.off * s, rzv = this.fz * this.off * s; this.angVel += (rzv * dx * imp - rxv * dz * imp) * 0.35 / this.mass;
            if (imp > 3) { this.damage(Math.min(30, imp * 0.9)); emit(['crash', r1(nx), r1(this.y + 0.8), r1(nz), r1(imp)], nx, nz); if (this.ai === 'traffic') this.panic = Math.max(this.panic, 1.5); } }
        }
      }
      // beach / bounds
      if (this.z > BEACH_Z1 - 3) { this.z = BEACH_Z1 - 3; if (this.vz > 0) this.vz *= -0.3; }
      const lim = HALF + 100; if (this.x < -lim) { this.x = -lim; this.vx = Math.abs(this.vx) * 0.3; } if (this.x > lim) { this.x = lim; this.vx = -Math.abs(this.vx) * 0.3; } if (this.z < -lim) { this.z = -lim; this.vz = Math.abs(this.vz) * 0.3; }
    }
    draw(dt) { this.lights = !this.dead && (this.ai === 'cop' || !!this.type.ambulance); this.view.draw(this, dt, S.t); }
  }
  function collideCars() {
    for (let i = 0; i < cars.length; i++) { const A = cars[i]; if (A.released) continue;
      for (let j = i + 1; j < cars.length; j++) { const B = cars[j]; if (B.released) continue;
        if (dist2(A.x, A.z, B.x, B.z) > 64) continue;
        for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
          const ax = A.x + A.fx * A.off * sa, az = A.z + A.fz * A.off * sa, bx = B.x + B.fx * B.off * sb, bz = B.z + B.fz * B.off * sb;
          let dx = bx - ax, dz = bz - az; const d2 = dx * dx + dz * dz, rs = A.r + B.r;
          if (d2 >= rs * rs || d2 < 1e-6) continue;
          const d = Math.sqrt(d2); dx /= d; dz /= d; const pen = rs - d, ma = A.mass, mb = B.mass, tot = ma + mb;
          A.x -= dx * pen * (mb / tot); A.z -= dz * pen * (mb / tot); B.x += dx * pen * (ma / tot); B.z += dz * pen * (ma / tot);
          const vn = (B.vx - A.vx) * dx + (B.vz - A.vz) * dz;
          if (vn < 0) { const jimp = -(1 + 0.35) * vn / (1 / ma + 1 / mb), jx = dx * jimp, jz = dz * jimp;
            A.vx -= jx / ma; A.vz -= jz / ma; B.vx += jx / mb; B.vz += jz / mb;
            A.angVel += (A.fz * A.off * sa * (-jx) - A.fx * A.off * sa * (-jz)) * 0.12 / ma; B.angVel += (B.fz * B.off * sb * jx - B.fx * B.off * sb * jz) * 0.12 / mb;
            const imp = -vn;
            if (imp > 2.5) { const byP = driverOf(A) || driverOf(B); if (byP) { A.lastHitBy = byP; B.lastHitBy = byP; }
              A.damage(Math.min(30, imp * 1.1)); B.damage(Math.min(30, imp * 1.1)); emit(['crash', r1((ax + bx) / 2), r1(A.y + 0.9), r1((az + bz) / 2), r1(imp), 8], (ax + bx) / 2, (az + bz) / 2);
              if (byP && !A.type.cop && !B.type.cop && imp > 6 && rnd() < 0.35) byP.heat += 3; if (byP && (A.ai === 'cop' || B.ai === 'cop') && imp > 5) byP.heat += 4;
              if (byP && byP.heat > 8 && byP.wanted === 0) { addWanted(byP, 1); byP.heat = 0; } }
          }
        }
      }
    }
  }

  /* ============================================================ pickups */
  function spawnPickup(x, z, kind, amount) {
    const i = W.pickPool.alloc(); if (i < 0) return;
    W.pickPool.color(i, PICK_COLOR(kind));
    const p = { id: nextId++, cls: 'pick', i, x, z, kind, amount, t: rr(0, TAU), life: 70, released: false, sent: null, entry: null, dirty: true }; pickups.push(p); ents.set(p.id, p);
  }
  function updatePickups(dt) {
    for (let k = pickups.length - 1; k >= 0; k--) { const p = pickups[k]; p.t += dt; p.life -= dt; let take = false;
      for (const pl of players) { if (!alive(pl)) continue; const P = pl.ped; if (dist2(p.x, p.z, P.x, P.z) >= (P.inCar ? 4 : 1.6)) continue; take = true;
        if (p.kind === 'cash') pl.cash += p.amount; else if (p.kind === 'ammo') { pl.weapons[0].reserve += 24; pl.weapons[1].reserve += 8; pl.weapons[2].reserve += 40; } else P.health = Math.min(100, P.health + 40);
        emit(['pickup', pl.idx, p.kind, p.amount]); break; }
      if (take || p.life <= 0) { W.pickPool.release(p.i); p.released = true; ents.delete(p.id); pickups.splice(k, 1); continue; }
      drawPickup(W, p.i, p.x, p.z, p.t); }
    W.pickPool.dirty();
  }

  /* ============================================================ raycasting & shooting */
  function raycast(ox, oy, oz, dx, dy, dz, maxD, ignorePed, ignoreCar) {
    let best = maxD, hit = null; const aabbs = W.aabbs;
    if (dy < 0) { const t = -oy / dy; if (t < best) { best = t; hit = { kind: 'ground' }; } }
    for (let k = 0; k < aabbs.length; k++) { const b = aabbs[k];
      const t = rayAabb(ox, oy, oz, dx, dy, dz, b.x0, -1, b.z0, b.x1, b.h, b.z1); if (t !== null && t < best) { best = t; hit = { kind: 'world', b }; } }
    for (const p of peds) { if (p.dead || p === ignorePed || p.inCar || p.released) continue;
      const t = raySphere(ox, oy, oz, dx, dy, dz, p.x, p.y + 0.95, p.z, 0.75); if (t !== null && t < best) { best = t; hit = { kind: 'ped', p }; } }
    for (const c of cars) { if (c === ignoreCar || c.released) continue;
      const q = raySphere(ox, oy, oz, dx, dy, dz, c.x, c.y + 0.9, c.z, c.type.l / 2 + 0.6); if (q === null || q > best) continue;
      const lox = (ox - c.x) * c.rx + (oz - c.z) * c.rz, loz = (ox - c.x) * c.fx + (oz - c.z) * c.fz, ldx = dx * c.rx + dz * c.rz, ldz = dx * c.fx + dz * c.fz;
      const t = rayAabb(lox, oy - c.y, loz, ldx, dy, ldz, -c.type.w / 2, 0.2, -c.type.l / 2, c.type.w / 2, 0.35 + c.type.bh + c.type.ch, c.type.l / 2);
      if (t !== null && t < best) { best = t; hit = { kind: 'car', c }; } }
    return { t: best, hit, x: ox + dx * best, y: oy + dy * best, z: oz + dz * best };
  }
  function muzzlePos(P, camPitch) {
    const fx = Math.sin(P.yaw), fz = Math.cos(P.yaw), rx = -fz, rz = fx;
    return [P.x + rx * 0.39 + fx * 0.75, P.y + 1.32 - camPitch * 0.5, P.z + rz * 0.39 + fz * 0.75];
  }
  function startReload(pl) { const w = pl.weapons[pl.curW]; if (pl.reloadT > 0 || w.ammo === w.mag || w.reserve <= 0 || pl.dead) return; pl.reloadT = w.reload; emit(['reload', pl.idx]); }
  function switchWeapon(pl, i) { i = ((i % 3) + 3) % 3; if (i === pl.curW) return; pl.curW = i; pl.reloadT = 0; pl.fireT = 0.15; emit(['click', pl.idx]); }
  function fireWeapon(pl) {
    const w = pl.weapons[pl.curW], P = pl.ped; if (pl.reloadT > 0 || pl.fireT > 0 || P.dead || P.inCar) return;
    if (w.ammo <= 0) { if (w.reserve > 0) startReload(pl); else { emit(['click', pl.idx]); pl.fireT = 0.3; } return; }
    w.ammo--; pl.fireT = w.rate; pl.armTimer = 1.6; P.armRaise = 1;
    P.yaw = pl.camYaw;
    const cam = computeCamera(W, P, pl.camYaw, pl.camPitch, camTmp); const o = cam, vx = cam.dx, vy = cam.dy, vz = cam.dz;
    let aim = raycast(o.x, o.y, o.z, vx, vy, vz, 400, P, null);
    if (!aim.hit || aim.hit.kind !== 'ped') { // soft lock: nearest ped within ~3 degrees of the crosshair
      let best = 1e9, bp = null;
      for (const p of peds) { if (p === P || p.dead || p.inCar || p.released || (!friendly && p.kind === 'player')) continue;
        for (const hy of [0.3, 1.0, 1.6]) { const dx = p.x - o.x, dy = p.y + hy - o.y, dz = p.z - o.z, d = Math.hypot(dx, dy, dz); if (d > w.range || d < 1.5 || d > aim.t + 1.5) continue;
          const ang = Math.acos(clamp((dx * vx + dy * vy + dz * vz) / d, -1, 1)); const tol = Math.max(0.05, Math.atan(0.8 / d));
          if (ang < tol && ang < best) { best = ang; bp = p; } } }
      if (bp && W.hasLOS(P.x, P.z, bp.x, bp.z)) aim = { x: bp.x, y: bp.y + 1.0, z: bp.z, t: Math.hypot(bp.x - o.x, bp.z - o.z) };
    }
    const [mx, my, mz] = muzzlePos(P, pl.camPitch); const hits = [];
    for (let k = 0; k < w.pellets; k++) {
      let dx = aim.x - mx, dy = aim.y - my, dz = aim.z - mz; let l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      dx += rr(-w.spread, w.spread); dy += rr(-w.spread, w.spread); dz += rr(-w.spread, w.spread); l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      const h = raycast(mx, my, mz, dx, dy, dz, w.range, P, null);
      let kind = 0;
      if (h.hit) {
        if (h.hit.kind === 'ped') { const p = h.hit.p; kind = 1; if (friendly || p.kind !== 'player') p.hurt(w.dmg, pl); if (p.kind === 'civ' || p.kind === 'cop') pl.heat += 2; }
        else if (h.hit.kind === 'car') { const c = h.hit.c; kind = 2; c.lastHitBy = pl; c.damage(w.dmg * 0.4);
          if (c.driver && c.driver.kind !== 'player' && rnd() < 0.25) c.driver.hurt(w.dmg, pl); if (c.ai === 'traffic') c.panic = Math.max(c.panic, 4); }
        else kind = 3;
      }
      hits.push([r1(h.x), r1(h.y), r1(h.z), kind]);
    }
    emit(['shot', pl.idx, w.key, r1(mx), r1(my), r1(mz), hits], mx, mz);
    alertPeds(P.x, P.z, 45);
    pl.heat += 1; if (pl.heat > 8 && pl.wanted === 0) { addWanted(pl, 1); pl.heat = 0; }
    if (mission.state === 'hit' && dist2(P.x, P.z, PLAZA.x, PLAZA.z) < 45 * 45) setHostile();
  }
  function npcShoot(sh, tp, chance, dmg) {
    const T = tp.ped, car = T.inCar;
    const fx = Math.sin(sh.yaw), fz = Math.cos(sh.yaw); const sx = sh.x + fx * 0.6 - fz * 0.39, sy = sh.y + 1.3, sz = sh.z + fz * 0.6 + fx * 0.39;
    const hit = rnd() < chance && (car || W.hasLOS(sh.x, sh.z, T.x, T.z));
    const tx = T.x + (hit ? 0 : rr(-2.5, 2.5)), ty = T.y + 1 + (hit ? 0 : rr(-1, 1.5)), tz = T.z + (hit ? 0 : rr(-2.5, 2.5));
    emit(['nshot', r1(sx), r1(sy), r1(sz), r1(tx), r1(ty), r1(tz), hit && car ? 1 : 0], sx, sz);
    if (hit) { if (car) { car.damage(dmg); car.lastHitBy = null; } else damagePlayer(tp, dmg, null); }
    alertPeds(sh.x, sh.z, 30);
  }
  function alertPeds(x, z, radius) {
    const r2 = radius * radius;
    for (const p of peds) { if (p.kind !== 'civ' || p.dead) continue; if (dist2(p.x, p.z, x, z) < r2) { p.flee = Math.max(p.flee, rr(5, 9)); p.threatX = x; p.threatZ = z; p.state = 'flee'; p.pause = 0; } }
  }

  /* ============================================================ player life */
  function damagePlayer(pl, d, by) {
    if (!alive(pl) || pl.godT > 0 || S.phase !== 'play') return;
    pl.ped.health -= d; pl.noDmgT = 0; emit(['hurt', pl.idx, r1(d)]);
    if (pl.ped.health <= 0) { pl.ped.health = 0; killPlayer(pl, by); }
  }
  function killPlayer(pl, by) {
    const P = pl.ped; if (P.dead) return;
    P.dead = true; P.deadT = 0; P.moving = 0; pl.wastedT = 5.5; P.killedBy = by || null;
    if (P.inCar) leaveCar(pl, true);
    emit(['wasted', pl.idx]); emit(['blood', r1(P.x), r1(P.z)], P.x, P.z);
    if (by && by !== pl) { by.kills++; by.cash += 100; emit(['float', by.idx, 'WASTED ' + pl.name.toUpperCase() + '  +$100', 0xff6060]); if (by.wanted < 2) addWanted(by, 1); }
  }
  function respawn(pl) {
    const P = pl.ped; P.dead = false; P.health = 100; P.x = HOSPITAL.x - 2 + (pl.idx % 4) * 1.2; P.z = HOSPITAL.z - Math.floor(pl.idx / 4) * 1.2; P.y = groundY(P.x, P.z); P.vy = 0; P.yaw = 0;
    pl.wanted = 0; pl.cash = Math.max(0, pl.cash - 300); pl.godT = 3; pl.heat = 0; pl.crimeT = 0; pl.seenT = 0;
    for (const c of cars) if (c.target === pl) c.target = null;
    for (const w of pl.weapons) w.ammo = w.mag;
    emit(['float', pl.idx, 'HOSPITAL BILL -$300', 0xff6060]); emit(['respawn', pl.idx]);
    for (let k = 0; k < 20; k++) spawnCiv(pl);
    for (let k = 0; k < 10; k++) spawnTrafficCar(pl);
  }
  function onPlayerKill(p, by) {
    if (p.kind === 'cop') { addWanted(by, 1); spawnPickup(p.x + rr(-1, 1), p.z + rr(-1, 1), 'ammo', 1); }
    else if (p.kind === 'civ') { if (rnd() < 0.75 || by.wanted === 0) addWanted(by, 1); if (rnd() < 0.7) spawnPickup(p.x + rr(-1, 1), p.z + rr(-1, 1), 'cash', ri(5, 60)); }
    else if (p.kind === 'guard') { if (by.wanted < 1) addWanted(by, 1); if (rnd() < 0.6) spawnPickup(p.x + rr(-1, 1), p.z + rr(-1, 1), 'ammo', 1); }
  }
  function addWanted(pl, n) {
    if (!pl || pl.gone) return;
    const old = pl.wanted; pl.wanted = clamp(pl.wanted + n, 0, 5); pl.crimeT = 0; pl.seenT = 0;
    if (pl.wanted > old) emit(['wanted', pl.idx, pl.wanted]);
  }

  /* ============================================================ cars: enter / exit */
  function nearestCar(P, maxD) {
    let best = null, bd = maxD * maxD;
    for (const c of cars) { if (c.released || c.dead || (c.driver && c.driver.kind === 'player')) continue; const d = dist2(c.x, c.z, P.x, P.z) - (c.type.l / 2) ** 2; if (d < bd) { bd = d; best = c; } }
    return best;
  }
  function leaveCar(pl, silent) {
    const P = pl.ped, c = P.inCar; if (!c) return;
    P.x = c.x + c.fz * 2.1; P.z = c.z - c.fx * 2.1; P.y = groundY(P.x, P.z); P.vy = 0; P.yaw = c.yaw;
    P.inCar = null; c.driver = null; c.throttle = 0; c.steer = 0; c.hand = c.speed < 4; if (!silent) emit(['enter', pl.idx]);
    P.collideWorld();
  }
  function enterCar(pl, c) {
    const P = pl.ped;
    if (c.ai === 'traffic' && !c.type.cop) { const d = new Ped('civ', c.x + c.rx * 2.4, c.z + c.rz * 2.4); d.flee = 9; d.threatX = P.x; d.threatZ = P.z; d.state = 'flee'; d.yaw = c.yaw; peds.push(d);
      addWanted(pl, 1); emit(['float', pl.idx, 'CARJACKING', 0xff6060]); }
    if (c.ai === 'cop' && c.occupants > 0) { for (let k = 0; k < c.occupants; k++) { const p = new Ped('cop', c.x + c.rx * 2.4, c.z + c.rz * 2.4 + k * 1.2); p.hostile = true; peds.push(p); cops.push(p); } c.occupants = 0; addWanted(pl, 1); }
    if (c.driver && c.driver !== P) { const d = c.driver; d.inCar = null; d.x = c.x + c.rx * 2.4; d.z = c.z + c.rz * 2.4; c.driver = null; }
    c.ai = null; c.driver = P; c.panic = 0; c.hand = false; c.target = null; P.inCar = c; P.moving = 0; emit(['enter', pl.idx]);
    if (c.type.cop && pl.wanted < 1) addWanted(pl, 1);
  }
  function tryEnterExit(pl) {
    const P = pl.ped; if (!P || P.dead) return;
    if (P.inCar) { leaveCar(pl, false); return; }
    const c = nearestCar(P, 4.2); if (c) enterCar(pl, c);
  }
  function pushOutOfCars(e, r, isPlayer) {
    let pushed = false;
    for (const c of cars) { if (c.released || c === e.inCar) continue; const dx = e.x - c.x, dz = e.z - c.z; if (dx * dx + dz * dz > 30) continue;
      const lx = dx * c.rx + dz * c.rz, lz = dx * c.fx + dz * c.fz, hw = c.type.w / 2 + r, hl = c.type.l / 2 + r;
      if (Math.abs(lx) < hw && Math.abs(lz) < hl) { const px = hw - Math.abs(lx), pz = hl - Math.abs(lz); pushed = true;
        // the player is pushed out the short way; peds slide along the car's length so a crossing ped walks around it
        if (px < pz && (isPlayer || c.speed > 1)) { const s = lx > 0 ? px : -px; e.x += c.rx * s; e.z += c.rz * s; }
        else { const step = isPlayer ? pz : Math.min(pz, 0.08); const s = lz > 0 ? step : -step; e.x += c.fx * s; e.z += c.fz * s; if (!isPlayer && px < pz) { const s2 = lx > 0 ? px * 0.5 : -px * 0.5; e.x += c.rx * s2; e.z += c.rz * s2; } } } }
    return pushed;
  }

  /* ============================================================ spawning */
  function spawnCopFoot(pl) {
    const P = pl.ped;
    for (let tries = 0; tries < 12; tries++) { const a = rr(0, TAU), d = rr(38, 70); const x = P.x + Math.sin(a) * d, z = P.z + Math.cos(a) * d; if (!inCity(x, z)) continue;
      const [cx, cz] = cornerXZ(clamp(cellOf(x), 0, NB - 1), clamp(cellOf(z), 0, NB - 1), ri(0, 3));
      const c = new Ped('cop', cx + rr(-1, 1), cz + rr(-1, 1)); c.hostile = true; c.target = pl; peds.push(c); cops.push(c); return; }
  }
  function laneSpawnPoint(minD, maxD, pl) {
    const P = pl.ped;
    for (let tries = 0; tries < 20; tries++) { const a = [ri(0, NB), ri(0, NB)]; const dx = X(a[0]) - P.x, dz = X(a[1]) - P.z, d = Math.hypot(dx, dz); if (d < minD || d > maxD) continue;
      if (minPlayerDist2(X(a[0]), X(a[1])) < minD * minD) continue;
      const b = chooseNext([a[0] + (a[0] > 0 ? -1 : 1), a[1]], a); if (b[0] === a[0] && b[1] === a[1]) continue;
      const s = segInfo(a, b); const t = rr(8, s.len - 8); return { a, b, x: s.ax + s.dx * t + s.rx * LANE, z: s.az + s.dz * t + s.rz * LANE, yaw: Math.atan2(s.dx, s.dz), s }; }
    return null;
  }
  function spawnCopCar(pl) {
    const p = laneSpawnPoint(70, 150, pl); if (!p) return;
    const c = new Car(CAR_TYPES[5], p.x, p.z, p.yaw); c.ai = 'cop'; c.occupants = 2; c.target = pl; c.setSeg(p.a, p.b); cars.push(c);
  }
  function spawnTrafficCar(pl) {
    if (!pl) return; const p = laneSpawnPoint(60, 170, pl); if (!p) return;
    const type = pick([CAR_TYPES[0], CAR_TYPES[0], CAR_TYPES[0], CAR_TYPES[1], CAR_TYPES[2], CAR_TYPES[2], CAR_TYPES[3], CAR_TYPES[4]]);
    const c = new Car(type, p.x, p.z, p.yaw); c.ai = 'traffic'; c.setSeg(p.a, p.b); c.vx = c.fx * 8; c.vz = c.fz * 8; cars.push(c);
  }
  function spawnCiv(pl) {
    if (!pl) return; const P = pl.ped;
    for (let tries = 0; tries < 12; tries++) { const a = rr(0, TAU), d = rr(35, 130); const x = P.x + Math.sin(a) * d, z = P.z + Math.cos(a) * d; if (!inCity(x, z)) continue;
      const [cx, cz] = cornerXZ(clamp(cellOf(x), 0, NB - 1), clamp(cellOf(z), 0, NB - 1), ri(0, 3));
      if (minPlayerDist2(cx, cz) < 30 * 30) continue;
      peds.push(new Ped('civ', cx + rr(-1.2, 1.2), cz + rr(-1.2, 1.2))); return; }
  }

  /* ============================================================ wanted level (per player) */
  function updateWanted(dt) {
    for (let k = cops.length - 1; k >= 0; k--) if (cops[k].dead || cops[k].released) cops.splice(k, 1);
    let anyWanted = false, copCars = 0; for (const c of cars) if (c.ai === 'cop' && !c.dead) copCars++;
    for (const pl of players) {
      if (pl.gone || !pl.ped) continue;
      pl.heat = Math.max(0, pl.heat - dt * 0.8);
      if (pl.wanted <= 0) { if (pl.seenT > 0) pl.seenT = 0; continue; }
      anyWanted = true; pl.crimeT += dt; const P = pl.ped;
      let seen = false;
      for (const c of cops) if (dist2(c.x, c.z, P.x, P.z) < 3600 && W.hasLOS(c.x, c.z, P.x, P.z)) { seen = true; break; }
      if (!seen) for (const c of cars) if (c.ai === 'cop' && dist2(c.x, c.z, P.x, P.z) < 4900) { seen = true; break; }
      if (seen) pl.seenT = 0; else pl.seenT += dt;
      if (pl.seenT > 16 && pl.crimeT > 16) { pl.wanted--; pl.seenT = 4; emit(['float', pl.idx, pl.wanted ? 'LOSING THE HEAT' : 'YOU LOST THE COPS', 0x7fe0ff]); }
      pl.copSpawnT -= dt;
      const wantFoot = pl.wanted * 2 + 1, wantCars = Math.max(0, pl.wanted - 1) + (pl.wanted >= 4 ? 1 : 0);
      let myFoot = 0, myCars = 0; for (const c of cops) if (c.target === pl) myFoot++; for (const c of cars) if (c.ai === 'cop' && !c.dead && c.target === pl) myCars++;
      if (pl.copSpawnT <= 0 && !P.dead) { pl.copSpawnT = clamp(5.5 - pl.wanted * 0.8, 1.2, 4.5);
        const canFoot = cops.length < MAX_COPS, canCar = copCars < MAX_COP_CARS;
        if (canCar && myCars < wantCars && (myFoot >= pl.wanted || rnd() < 0.5)) { spawnCopCar(pl); copCars++; }
        else if (canFoot && myFoot < wantFoot) spawnCopFoot(pl);
        else if (canCar && myCars < wantCars) { spawnCopCar(pl); copCars++; } }
    }
    if (!anyWanted && cops.length) {
      for (const c of cops) { let keep = false; for (const pl of players) { if (pl.gone || !pl.ped) continue; if (dist2(c.x, c.z, pl.ped.x, pl.ped.z) <= 900 && W.hasLOS(c.x, c.z, pl.ped.x, pl.ped.z)) { keep = true; break; } } if (!keep) { c.release(); c.dead = true; } }
      for (const c of cars) if (c.ai === 'cop') c.rejoin();
    }
  }

  /* ============================================================ mission (shared by the whole room) */
  function initMission() {
    const v = new Ped('vinny', PLAZA.x + 6, PLAZA.z + 3); v.yaw = PI; peds.push(v); mission.vinny = v;
    for (let k = 0; k < 4; k++) { const a = k * TAU / 4 + PI / 4; const g = new Ped('guard', PLAZA.x + 6 + Math.sin(a) * 4.5, PLAZA.z + 3 + Math.cos(a) * 4.5); g.yaw = a; g.state = 'idle'; peds.push(g); mission.guards.push(g); }
  }
  function setHostile() {
    if (mission.hostile) return; mission.hostile = true;
    mission.guards.forEach(g => { g.hostile = true; }); if (mission.vinny) { mission.vinny.hostile = true; mission.vinny.fleeing = true; }
    if (mission.state === 'goto' || mission.state === 'hit') { mission.state = 'hit'; emit(['float', -1, "VINNY'S MAKING A RUN FOR IT!", 0xffe14d]); }
  }
  function updateMission(dt) {
    mission.t += dt; const v = mission.vinny;
    if (mission.state === 'intro') { if (mission.t > INTRO_T) mission.state = 'goto'; }
    else if (mission.state === 'goto') { for (const pl of players) { if (!alive(pl)) continue; if (dist2(pl.ped.x, pl.ped.z, PLAZA.x, PLAZA.z) < 34 * 34) { mission.state = 'hit'; emit(['float', -1, 'THERE HE IS. TAKE HIM OUT.', 0xffe14d]); break; } } }
    else if (mission.state === 'hit') { if (v.dead) { mission.state = 'passed'; mission.passedT = 6; const k = v.killedBy; mission.killer = k;
      if (k) { k.cash += 5000; addWanted(k, 2); } emit(['passed', k ? k.idx : -1]);
      mission.guards.forEach(g => { if (!g.dead) { g.kind = 'civ'; g.hostile = false; g.flee = 12; g.threatX = v.x; g.threatZ = v.z; g.state = 'flee'; } }); } }
    else if (mission.state === 'passed') { mission.passedT -= dt; if (mission.passedT <= 0) mission.state = mission.killer && !mission.killer.gone && mission.killer.wanted > 0 ? 'escape' : 'done'; }
    else if (mission.state === 'escape') { const k = mission.killer; if (!k || k.gone || k.wanted === 0) { mission.state = 'done'; if (k && !k.gone) emit(['float', k.idx, 'CLEAN GETAWAY', 0x7fe0ff]); } }
  }

  /* ============================================================ the players' own update */
  function updatePlayer(pl, dt, live) {
    const P = pl.ped; pl.noDmgT += dt; pl.godT -= dt; pl.fireT -= dt; pl.armTimer -= dt;
    if (P.dead) { P.deadT += dt; pl.wastedT -= dt; if (pl.wastedT <= 0 && live) respawn(pl); P.gun = null; P.draw(dt); return; }
    if (pl.noDmgT > 8 && P.health < 100) P.health = Math.min(100, P.health + 3 * dt);
    if (pl.reloadT > 0) { pl.reloadT -= dt; if (pl.reloadT <= 0) { const w = pl.weapons[pl.curW]; const take = Math.min(w.mag - w.ammo, w.reserve); w.ammo += take; w.reserve -= take; } }
    const b = live ? pl.bits : 0;
    if (pl.clicksSeen === null) pl.clicksSeen = pl.clicks;
    let clicks = Math.min(3, pl.clicks - pl.clicksSeen); pl.clicksSeen = pl.clicks;
    if (live) { const w = pl.weapons[pl.curW]; if (w.auto) { if (b & IN.FIRE) fireWeapon(pl); } else while (clicks-- > 0) fireWeapon(pl); }
    pl.hint = 0;
    if (P.inCar) {
      const c = P.inCar;
      c.throttle = (b & IN.UP) ? 1 : (b & IN.DOWN) ? -1 : 0;
      const st = ((b & IN.LEFT) ? 1 : 0) - ((b & IN.RIGHT) ? 1 : 0);
      c.steer = st ? lerp(c.steer, st, Math.min(1, 5 * dt)) : lerp(c.steer, 0, Math.min(1, 8 * dt));
      c.hand = !!(b & IN.SPACE);
      P.x = c.x; P.z = c.z; P.y = c.y; P.yaw = c.yaw; P.moving = 0;
      pl.hint = 1;
      if (c.dead) leaveCar(pl, false);
    } else {
      const fx = Math.sin(pl.camYaw), fz = Math.cos(pl.camYaw), rx = -fz, rz = fx;
      let mx = ((b & IN.RIGHT) ? 1 : 0) - ((b & IN.LEFT) ? 1 : 0), mz = ((b & IN.UP) ? 1 : 0) - ((b & IN.DOWN) ? 1 : 0);
      const ground = groundY(P.x, P.z);
      if (mx || mz) { const l = Math.hypot(mx, mz); mx /= l; mz /= l; const speed = (b & IN.SPRINT) && !(pl.armTimer > 0) ? 7.6 : 4.6;
        const dx = fx * mz + rx * mx, dz = fz * mz + rz * mx; P.x += dx * speed * dt; P.z += dz * speed * dt; P.moving = speed;
        const ty = pl.armTimer > 0 ? pl.camYaw : Math.atan2(dx, dz); P.yaw += angDiff(ty, P.yaw) * Math.min(1, 14 * dt); }
      else { P.moving = 0; if (pl.armTimer > 0) P.yaw += angDiff(pl.camYaw, P.yaw) * Math.min(1, 14 * dt); }
      if ((b & IN.SPACE) && P.y <= ground + 0.02 && !pl.jumpLatch) { P.vy = 5.5; pl.jumpLatch = true; }
      if (!(b & IN.SPACE)) pl.jumpLatch = false;
      P.vy -= 16 * dt; P.y += P.vy * dt; if (P.y <= ground) { P.y = ground; P.vy = 0; }
      P.collideWorld(); pushOutOfCars(P, 0.35, true);
      for (const p of peds) { if (p === P || p.dead || p.inCar) continue; const d2 = dist2(p.x, p.z, P.x, P.z); if (d2 < 0.7 && d2 > 1e-4) { const d = Math.sqrt(d2), push = (0.84 - d) / d; p.x += (p.x - P.x) * push; p.z += (p.z - P.z) * push; } }
      const c = nearestCar(P, 4.2);
      if (c) pl.hint = (c.ai === 'traffic' || (c.ai === 'cop' && c.occupants)) ? 2 : 3;
      if (dist2(P.x, P.z, HOSPITAL.x, HOSPITAL.z) < 36 && P.health < 100) P.health = Math.min(100, P.health + 25 * dt);
    }
    P.armRaise = lerp(P.armRaise, pl.armTimer > 0 && !P.inCar ? 1 : 0, Math.min(1, 10 * dt));
    P.camPitch = pl.camPitch; P.gun = P.inCar ? null : pl.weapons[pl.curW].key;
    P.draw(dt);
  }

  /* ============================================================ world tick */
  function update(dt) {
    S.t += dt; const live = S.phase === 'play';
    for (const pl of players) if (!pl.gone && pl.ped) updatePlayer(pl, dt, live);
    for (const c of cars) { if (c.released) continue; c.drive(dt); c.step(dt); }
    collideCars();
    for (const c of cars) if (!c.released) c.draw(dt);
    for (let k = peds.length - 1; k >= 0; k--) { const p = peds[k]; if (p.released) { peds.splice(k, 1); continue; } if (p.kind === 'player') continue; p.update(dt);
      if (!p.dead && !p.inCar) { if (pushOutOfCars(p, 0.3, false)) { p.carStuck++; if (p.carStuck > 90 && p.kind === 'civ') { p.carStuck = 0; p.flee = 2; p.threatX = p.x + rr(-1, 1); p.threatZ = p.z + rr(-1, 1); p.state = 'flee'; } } else p.carStuck = 0; } }
    if (live) { updateWanted(dt); updateMission(dt); }
    updatePickups(dt);
    W.dirtyDynamic();
    // population maintenance: cull what is far from everyone, top up near a random player
    S.spawnT -= dt;
    if (S.spawnT <= 0) { S.spawnT = 0.5;
      let civs = 0, traffic = 0;
      for (let k = peds.length - 1; k >= 0; k--) { const p = peds[k]; if (p.kind === 'player') continue;
        const far = minPlayerDist2(p.x, p.z) > 240 * 240;
        if (far && (p.kind === 'civ' || p.kind === 'cop' || p.dead) && p !== mission.vinny) { p.release(); peds.splice(k, 1); continue; }
        if (p.kind === 'civ' && !p.dead) civs++; }
      for (let k = cars.length - 1; k >= 0; k--) { const c = cars[k]; if (c.driver && c.driver.kind === 'player') continue;
        const far = minPlayerDist2(c.x, c.z) > 270 * 270;
        if (far && (c.ai === 'traffic' || c.ai === 'cop' || c.dead || (!c.ai && !c.parked))) { c.release(); cars.splice(k, 1); continue; }
        if (c.ai === 'traffic') traffic++; }
      for (let k = 0; k < 3 && civs + k < 92; k++) spawnCiv(anchor());
      for (let k = 0; k < 2 && traffic + k < 40; k++) spawnTrafficCar(anchor());
    }
    S.clockH += dt / 45; if (S.clockH >= 24) S.clockH -= 24;
    if (live && !S.unlimited) { S.timeLeft -= dt; if (S.timeLeft <= 0) { S.timeLeft = 0; S.phase = 'over'; for (const pl of players) { pl.bits = 0; pl.godT = 1e9; } emit(['over']); } }
  }

  /* ============================================================ input from the players */
  function setInput(pl, m) { if (!pl || pl.gone || !m) return; pl.bits = m.m | 0; if (typeof m.y === 'number') pl.camYaw = m.y; if (typeof m.p === 'number') pl.camPitch = clamp(m.p, -0.45, 1.1); if (typeof m.c === 'number') pl.clicks = m.c; }
  function action(pl, a, n) {
    if (!pl || pl.gone || !pl.ped || S.phase !== 'play') return;
    if (a === 'use') tryEnterExit(pl); else if (a === 'reload') startReload(pl); else if (a === 'weapon') switchWeapon(pl, n | 0);
  }
  function playerLeft(id) {
    const pl = players.find(p => p.id === id); if (!pl || pl.gone) return;
    pl.gone = true;
    if (pl.ped) { if (pl.ped.inCar) leaveCar(pl, true); pl.ped.release(); const i = peds.indexOf(pl.ped); if (i >= 0) peds.splice(i, 1); pl.ped = null; }
    for (const c of cars) if (c.target === pl) c.target = null;
    emit(['float', -1, pl.name.toUpperCase() + ' LEFT THE CITY', 0x9fb4dc]);
  }

  /* ============================================================ the wire */
  const pedEntry = p => { const f = (p.dead ? PF.DEAD : 0) | (p.inCar ? PF.INCAR : 0) | (p.moving > 3 ? PF.RUN : p.moving > 0 ? PF.WALK : 0) | (p.armRaise > 0.5 ? PF.ARM : 0) | (p.hitT > 0 ? PF.HIT : 0) | (p.dead && p.deadT > 1 ? PF.OLDDEAD : 0);
    const e = [p.id, kindIdx(p.kind), p.style, r2(p.x), r2(p.z), r2(p.yaw), f]; if (p.kind === 'player') e.push(r2(p.y)); return e; };
  const carEntry = c => [c.id, c.type.idx, c.color, c.cabinColor, r2(c.x), r2(c.z), r2(c.yaw), r2(c.steer), r2(c.vF), (c.dead ? CF.DEAD : 0) | (c.smoking ? CF.SMOKE : 0) | (c.burn > 0 ? CF.BURN : 0) | (c.lights ? CF.LIGHTS : 0)];
  const pickEntry = p => [p.id, PICK_KINDS.indexOf(p.kind), r1(p.x), r1(p.z)];
  const same = (a, b) => { if (!b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  const block = pl => { const P = pl.ped, w = pl.weapons[pl.curW];
    return [P ? P.id : -1, P ? Math.round(P.health) : 0, pl.wanted, Math.floor(pl.cash), pl.kills, pl.curW, w.ammo, w.reserve, r2(pl.reloadT), P && P.dead ? 1 : 0, r1(pl.wastedT), P && P.inCar ? P.inCar.id : -1, pl.hint, r2(pl.camPitch), pl.godT > 0 ? 1 : 0, pl.gone ? 1 : 0]; };
  function prepareNet() {
    for (const e of ents.values()) { const entry = e.cls === 'ped' ? pedEntry(e) : e.cls === 'car' ? carEntry(e) : pickEntry(e); e.entry = entry; e.dirty = !same(entry, e.sent); }
  }
  /* client = { id, known: Set<entityId>, pl: Player } */
  function snapshotFor(client) {
    const pl = client.pl, P = pl.ped, cx = P ? P.x : 0, cz = P ? P.z : 0, known = client.known;
    const v = mission.vinny;
    const msg = { t: 's', to: client.id, c: r2(S.clockH), tl: S.unlimited ? -1 : r1(S.timeLeft), ph: S.phase === 'over' ? 1 : 0, ms: MISSION_STATES.indexOf(mission.state),
      vin: v && !v.released ? [r1(v.x), r1(v.z), v.dead ? 1 : 0] : null, P: players.map(block), p: [], v: [], k: [], rm: [], ev: [] };
    for (const e of ents.values()) {
      const inRange = (e.cls === 'ped' && e.kind === 'player') || dist2(e.x, e.z, cx, cz) < NET_RANGE2;
      if (inRange) { if (e.dirty || !known.has(e.id)) { (e.cls === 'ped' ? msg.p : e.cls === 'car' ? msg.v : msg.k).push(e.entry); known.add(e.id); } }
      else if (known.has(e.id)) { msg.rm.push(e.id); known.delete(e.id); }
    }
    for (const id of known) if (!ents.has(id)) { msg.rm.push(id); known.delete(id); }
    for (const ev of events) {
      const e = ev.e;
      if (TARGETED.has(e[0])) { if (e[1] !== -1 && e[1] !== pl.idx) continue; }
      else if (ev.x !== undefined && dist2(ev.x, ev.z, cx, cz) > EV_RANGE2) continue;
      msg.ev.push(e);
    }
    return msg;
  }
  function endNet() { for (const e of ents.values()) if (e.dirty) { e.sent = e.entry; e.dirty = false; } events.length = 0; }
  function clearEvents() { events.length = 0; }
  function dispose() { for (const p of peds) p.release(); for (const c of cars) c.release(); for (const p of pickups) W.pickPool.release(p.i); peds.length = cars.length = pickups.length = cops.length = 0; ents.clear(); W.dirtyDynamic(); W.pickPool.dirty(); }

  /* ============================================================ populate the city */
  function placeParkedCars() {
    for (let k = 0; k <= NB; k++) for (let m = 0; m < NB; m++) for (const vert of [true, false]) for (const side of [1, -1]) {
      if (rnd() > 0.09) continue;
      if (vert && k === SPAWN_ROAD && m === SPAWN_BLOCK) continue; // the players' cars line this street
      const a = vert ? [k, m] : [m, k], b = vert ? [k, m + 1] : [m + 1, k]; const s = side > 0 ? segInfo(a, b) : segInfo(b, a);
      const t = rr(12, s.len - 14); const x = s.ax + s.dx * t + s.rx * PARK, z = s.az + s.dz * t + s.rz * PARK;
      const type = pick([CAR_TYPES[0], CAR_TYPES[0], CAR_TYPES[1], CAR_TYPES[3], CAR_TYPES[4]]);
      const c = new Car(type, x, z, Math.atan2(s.dx, s.dz)); c.hand = true; c.parked = true; cars.push(c);
    }
    for (const ox of [-6, 0, 6]) { const c = new Car(CAR_TYPES[5], POLICE.x + ox, POLICE.z, PI); c.hand = true; c.parked = true; cars.push(c); }
    const amb = new Car(CAR_TYPES[6], HOSPITAL.x + 9, HOSPITAL.z - 1, PI / 2); amb.hand = true; amb.parked = true; cars.push(amb);
  }
  (session.players || []).forEach((info, i) => {
    const pl = new Player(info, i); players.push(pl); const s = SPAWNS[i % SPAWNS.length];
    pl.ped = new Ped('player', s.x, s.z, pl.avatar, pl); pl.ped.yaw = s.face; peds.push(pl.ped);
    const car = new Car(CAR_TYPES[1], s.cx, s.z, s.yaw, (AVATARS[pl.avatar] || AVATARS[0]).color); car.hand = true; car.parked = true; cars.push(car);
  });
  placeParkedCars(); initMission();
  for (let k = 0; k < 90; k++) spawnCiv(anchor());
  for (let k = 0; k < 40; k++) spawnTrafficCar(anchor());

  return { players, peds, cars, cops, pickups, mission, S, ents, update, setInput, action, playerLeft, block, prepareNet, snapshotFor, endNet, clearEvents, dispose, playerOf: id => players.find(p => p.id === id) || null };
}
