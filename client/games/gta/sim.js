/* The host's simulation of Los Pixeles: every pedestrian, car, cop, pickup, the mission and the clock, for N
   players at once. Solo play runs the same code with one player and no network.

   Players feed it input bits + camera angles + an optional thumb-stick pair (setInput) and one-shot actions
   (action). Everything the other
   machines need to see or hear leaves through two channels:
     - `emit(ev, x, z)` queues a one-shot event ([type, ...args]) and fires the local onEvent immediately;
     - `prepareNet()` / `snapshotFor(client)` / `endNet()` build per-client delta snapshots (entities within
       range that changed since the last tick, plus a per-player HUD block and the events that concern them). */
import { clamp, lerp } from '../../core/math.js';
import { AVATARS } from '../../core/avatars.js';
import { PI, TAU, dist2, angDiff, X, NB, HALF, ROAD, PITCH, SW, LANE, PARK, cellOf, inCity, BEACH_Z1, groundY, PLAZA, HOSPITAL, POLICE, POLICE_DOOR, SPRAY, FERRIS, TAXI_RANK, cornerXZ, nearestNode, streetAt, districtAt, rayAabb, raySphere, computeCamera } from './world.js';
import { kindIdx, PF, CF, WEAPONS, CAR_TYPES, PedView, CarView, drawPickup, PICK_COLOR, PICK_KINDS, CAUSES, EVENT_KINDS, JOB_KINDS, JOB_STAGES, seatsOf, seatOffset } from './entities.js';
import { IN, pedCollideWorld, pushOutOfCars, stepOnFoot, driveInput, stepCar, carOffs } from './motion.js';
import { raceCourse, planLap, nodeXZ, progressOf, gridSlot, LAPS, CP_RADIUS } from './race.js';
export { IN };

const rnd = Math.random;
const rr = (a, b) => a + Math.random() * (b - a);
const ri = (a, b) => Math.floor(rr(a, b + 1));
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;

export const HINT = ['', 'F  EXIT CAR      SPACE  HANDBRAKE', 'F  JACK CAR', 'F  ENTER CAR', 'STOP IN THE BAY TO RESPRAY   $100 A STAR', 'F  TURN YOURSELF IN   $100 A STAR', 'F  GET OUT', 'F  GET IN'];
export const MISSION_STATES = ['intro', 'goto', 'hit', 'passed', 'escape', 'done'];
export const OBJECTIVES = { intro: 'Get to Diamond Plaza, downtown.', goto: 'Get to Diamond Plaza, downtown.', hit: "Whack Vinny 'Snitch' Voxel. Watch the bodyguards.", passed: 'Mission passed. Lose the cops.', escape: "Lose the wanted level: hide out, find a bribe, hit the Pay 'n' Spray or turn yourself in.", done: 'Free roam. Cause chaos in Los Pixeles.' };
export const INTRO_T = 5.5;
/* the soft lock: a shot that misses still takes the nearest pedestrian this close (radians) to the crosshair;
   a touch player aiming with a thumb gets a wider cone. The HUD uses the same rule to colour the crosshair. */
export const aimTol = (d, assist) => assist ? Math.max(0.16, Math.atan(2.4 / d)) : Math.max(0.05, Math.atan(0.8 / d));
export const START_CLOCK = { morning: 9.4, sunset: 18.2, night: 23.5 };
/* the game modes, indexed on the wire (append, never reorder). Most Wanted and the deathmatch need two players: solo they fall back to the sandbox. A race alone is a time trial. */
export const MODES = ['sandbox', 'mostWanted', 'race', 'deathmatch'];
/* the deathmatch: the kills that win it outright (the clock is the backstop; on an unlimited round it is the only end) */
export const KILL_CAP = 20;
export const killCapOf = opts => Number(opts.killCap) > 0 ? Math.floor(Number(opts.killCap)) : KILL_CAP;
/* the lobby's knobs: how many laps a race is, which guns everyone starts with (the kit is what a dead player keeps and
   what respawns with them; anything else they pick up is dropped in the street), and how thick the traffic and the
   police are (a factor on the caps and the spawn rates) */
export const lapsOf = opts => Number(opts.laps) > 0 ? Math.floor(Number(opts.laps)) : LAPS;
export const LOADOUTS = { pistol: ['pistol'], basic: ['pistol', 'shotgun', 'smg'], all: WEAPONS.map(w => w.key) };
export const loadoutOf = opts => LOADOUTS[opts.loadout] || LOADOUTS.basic;
export const TRAFFIC_LEVELS = { light: 0.5, normal: 1, heavy: 1.75 };
export const COP_LEVELS = { soft: 0.5, normal: 1, hard: 1.5 };
export const gunsOn = opts => opts.guns !== false;
export const modeOf = (opts, nPlayers) => opts.mode === 'race' ? 'race' : (opts.mode === 'mostWanted' || opts.mode === 'deathmatch') && nPlayers >= 2 ? opts.mode : 'sandbox';
/* the race: the countdown on the grid, and how long the rest get once the first car is across the line */
export const COUNTDOWN_T = 5, RACE_END_T = 20;
/* Most Wanted: what the mark earns a second, the bounty on it, how long after the start the first mark is drawn, the stars it always carries */
export const MARK_CASH_PER_S = 15, MARK_BOUNTY = 500, MARK_PICK_T = 8, MARK_STARS = 2;
/* a five-star chase shaken off (not bought off at the precinct) pays this */
export const ESCAPE_BONUS = 1000;
const NET_RANGE2 = 320 * 320, EV_RANGE2 = 360 * 360;
/* the police budget grows with the room: this many foot cops and cars per player, capped; a player alone gets the solo game's original force */
const COPS_PER_PLAYER = 16, COP_CARS_PER_PLAYER = 5, MAX_COPS_ROOM = 72, MAX_COP_CARS_ROOM = 20, SOLO_COPS = 24, SOLO_COP_CARS = 8, ROADBLOCK_EVERY = 14, MAX_ROADBLOCKS = 2;
const TARGETED = new Set(['hurt', 'wasted', 'respawn', 'wanted', 'float', 'pickup', 'click', 'enter', 'reload', 'cleared', 'job', 'cp']);
/* the wanted level: what a star costs to buy off, how long a taken bribe stays gone, how often a dead cop drops one */
const STAR_PRICE = 100, BRIBE_RESPAWN = 90, COP_BRIBE_CHANCE = 0.35;
/* the weapon crates: how long a taken one takes to grow back, how long a dropped weapon lies in the street */
export const CRATE_RESPAWN = 120, DROP_LIFE = 60;
/* a motorcycle rider is thrown by a hit at least this hard (a crash impulse) and takes this much per unit of it */
const THROW_IMP = 7, THROW_DMG = 3;
/* the world events: seconds between them, how long each runs, and what the armored truck spills */
const EVENT_GAP = [70, 110], TRUCK_T = 150, TRUCK_CASH = 12;
export const AIRDROP_T = 75, AIRDROP_FALL = 10;
/* the driving jobs: seconds to reach a waiting fare or patient, the base fare and the rate per metre, the bonus for a fast run, what each delivery in a row adds */
export const JOB_PICKUP_T = 60, TAXI_PAY = [30, 0.6], AMB_PAY = [60, 0.8], JOB_TIP = 0.5, JOB_STREAK = 25, STREAK_NEWS = 3;
/* what the room is told about through the feed, besides kills: `news` events carry one of these, a player index (or -1) and a detail */
export const NEWS = ['gun', 'stars', 'escape', 'busted', 'truck', 'drop', 'streak', 'left'];
/* the round's awards (`awards` in the sim): which exist, how many the results card shows, and how far one has to have driven to be judged a driver */
export const AWARD_KEYS = ['lap', 'killer', 'nemesis', 'victim', 'fugitive', 'cabbie', 'speed', 'driver', 'loot'], AWARDS_SHOWN = 6, DRIVER_MIN_M = 400;
const AMB_BAY = { x: HOSPITAL.x, z: HOSPITAL.z + ROAD / 2 + SW / 2 - 2.5 }; // the road outside the hospital's front door
const SPAWN_ROAD = 3, SPAWN_BLOCK = 7; // the players line up on Ender Ave beside block (3,7), four per sidewalk
export const SPAWNS = Array.from({ length: 8 }, (_, i) => { const side = i < 4 ? -1 : 1, z = X(SPAWN_BLOCK) + 12 + (i % 4) * 8;
  return { x: X(SPAWN_ROAD) + side * 9.6, z, cx: X(SPAWN_ROAD) + side * PARK, yaw: side < 0 ? 0 : PI, face: side < 0 ? PI / 2 : -PI / 2 }; });

export function createSim({ W, session, opts = {}, onEvent = () => {} }) {
  const peds = [], cars = [], pickups = [], cops = [], players = [], events = [];
  const ents = new Map(); // id -> entity, everything that can appear on the wire
  let nextId = 1;
  const nPlayers = (session.players || []).length;
  const mode = modeOf(opts, nPlayers);
  const friendly = mode !== 'sandbox' || opts.friendlyFire !== false; // the mark can only be hunted, and a race is anything goes, with friendly fire on
  const openCity = mode === 'sandbox' || mode === 'mostWanted'; // the free-roam modes: world events run and the cabs and the ambulance take jobs; a race or a deathmatch has neither
  const laps = lapsOf(opts), killCap = killCapOf(opts), guns = gunsOn(opts), kit = loadoutOf(opts), trafficK = TRAFFIC_LEVELS[opts.traffic] || 1, copK = COP_LEVELS[opts.cops] || 1;
  const MAX_COPS = Math.round((nPlayers <= 1 ? SOLO_COPS : Math.min(MAX_COPS_ROOM, COPS_PER_PLAYER * nPlayers)) * copK), MAX_COP_CARS = Math.round((nPlayers <= 1 ? SOLO_COP_CARS : Math.min(MAX_COP_CARS_ROOM, COP_CARS_PER_PLAYER * nPlayers)) * copK);
  const MAX_TRAFFIC = Math.round(40 * trafficK), TRAFFIC_TOPUP = Math.ceil(2 * trafficK); // cars driving around, and how many are added per half second
  /* phase: 'countdown' (the race grid, nobody moves) | 'play' | 'over' */
  const S = { clockH: START_CLOCK[opts.time] ?? START_CLOCK.morning, timeLeft: (Number(opts.minutes) || 0) * 60, unlimited: !(Number(opts.minutes) > 0), phase: mode === 'race' ? 'countdown' : 'play', t: 0, spawnT: 0, draw: true }; // draw: false while the killcam draws the views from its own frames
  const mission = { state: mode === 'sandbox' ? 'intro' : 'done', t: 0, vinny: null, guards: [], hostile: false, passedT: 0, killer: null };
  /* the race: the course (from the seed, the same on every machine), the countdown, then the grace once someone has finished */
  const course = mode === 'race' ? raceCourse(session.seed) : null, legs = course ? planLap(course) : null; // the planned lap decides which way a respawned car faces
  const RC = { t: COUNTDOWN_T, finishers: 0, ending: false };
  /* Most Wanted: who carries the mark and for how long this time */
  const mark = { idx: -1, heldT: 0, pickT: MARK_PICK_T };
  /* the current world event (one at a time): kind, where it is, how long it has left; the truck's car or the airdrop's landing timer */
  const WE = { kind: null, x: 0, z: 0, t: 0, nextT: rr(EVENT_GAP[0], EVENT_GAP[1]), car: null, landT: 0, landed: false };
  const emit = (ev, x, z) => { events.push({ e: ev, x, z }); onEvent(ev); };
  /* a line for the feed on every screen: what happened (NEWS), to whom (a player index, or -1), and a detail */
  const news = (kind, idx, extra) => emit(['news', kind, idx, extra]);
  const camTmp = {};

  /* ============================================================ players */
  class Player {
    constructor(info, idx) {
      this.id = info.id; this.idx = idx; this.name = info.name || 'Player'; this.avatar = info.avatar | 0; this.ped = null; this.gone = false;
      this.camYaw = 0; this.camPitch = 0.22; this.bits = 0; this.sx = 0; this.sz = 0; this.assist = false; this.clicks = 0; this.clicksSeen = null; this.seq = 0; this.seqApplied = 0;
      this.wanted = 0; this.heat = 0; this.crimeT = 0; this.seenT = 0; this.copSpawnT = 0; this.cash = 250; this.kills = 0;
      this.weapons = WEAPONS.map(w => { const basic = guns && kit.includes(w.key); return { ...w, basic, owned: basic, ammo: basic ? w.ammo : 0, reserve: basic ? w.reserve : 0 }; }); this.curW = 0; this.reloadT = 0; this.fireT = 0; this.armTimer = 0; this.godT = 0; this.noDmgT = 0; this.wastedT = 0; this.hint = 0; this.jumpLatch = false; // the kit is drawn; the other guns are empty until a crate (or a corpse) fills them
      this.msgT = 0; // cooldown on the "can't afford it" reminder
      this.killer = -1; this.cause = 0; // who and what got me last (the death camera and its card)
      this.markT = 0; this.peak = 0; this.blockT = 0; // seconds carrying the mark; the highest wanted level since it was last cleared; the roadblock timer
      this.job = null; // the taxi or ambulance job I am driving: { kind, stage, fare, x, z, t, dist, pay, n }
      this.lap = 0; this.next = 1; this.rank = 0; this.place = 0; // the race: laps done, the checkpoint I am heading for (0 = the line), my standing, my finishing place (0 = still racing)
      this.deaths = 0; this.killsOf = new Array(nPlayers).fill(0); this.crashes = 0; this.driven = 0; this.topSpeed = 0; this.chaseT = 0; this.chaseBest = 0; this.streakBest = 0; this.loot = 0; this.lapT = 0; this.lapBest = 0; // the round's tally, for the awards (below)
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
      this.health = kind === 'vinny' ? 170 : kind === 'guard' ? 90 : kind === 'swat' ? 110 : kind === 'cop' ? 55 : kind === 'player' ? 100 : 40;
      this.dead = false; this.deadT = 0; this.state = kind === 'civ' ? 'walk' : 'idle'; this.moving = 0;
      this.flee = 0; this.tx = x; this.tz = z; this.speedMul = rr(0.8, 1.25); this.shootT = rr(0.5, 1.5); this.hostile = false; this.pause = 0;
      this.hitT = 0; this.inCar = null; this.seat = 0; this.armRaise = 0; this.stuck = 0; this.detourT = 0; this.carStuck = 0; this.camPitch = 0; this.gun = null; this.target = null; this.jumpLatch = false;
      this.threatX = x; this.threatZ = z; this.killedBy = null; this.released = false; this.sent = null; this.entry = null; this.dirty = true;
      this.job = null; this.down = false; this.ride = false; // the player whose fare or patient I am; lying hurt, waiting for the ambulance; in the saddle of a motorcycle
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
    collideWorld() { pedCollideWorld(W, this); }
    hurt(dmg, by, cause) {
      if (this.dead) return;
      if (this.kind === 'player') { damagePlayer(this.owner, dmg, by, cause); return; }
      this.health -= dmg; this.hitT = 0.25;
      if (this.kind === 'civ') { const tp = by && by.ped ? by.ped : null; this.flee = rr(6, 10); this.threatX = tp ? tp.x : this.x + rr(-1, 1); this.threatZ = tp ? tp.z : this.z + rr(-1, 1); this.state = 'flee'; this.pause = 0;
        if (this.job && this.health > 0 && !this.down) failJob(this.job, 'THE FARE RAN OFF'); } // a patient just dies of it
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
      if (this.inCar) { const c = this.inCar; this.x = c.x; this.z = c.z; this.y = c.y; this.moving = 0; this.draw(dt); return; } // a fare rides along, out of sight
      this.moving = 0; this.hitT = Math.max(0, this.hitT - dt);
      if (this.kind === 'civ') {
        this.armRaise = lerp(this.armRaise, this.job && !this.down ? 1 : 0, 3 * dt); // a fare waves the cab down
        if (this.job) { const tp = this.down ? null : nearestPlayer(this.x, this.z); if (tp) this.yaw += angDiff(Math.atan2(tp.ped.x - this.x, tp.ped.z - this.z), this.yaw) * Math.min(1, 4 * dt); } // waiting (a patient lies still)
        else if (this.flee > 0) { this.flee -= dt; const dx = this.x - this.threatX, dz = this.z - this.threatZ, d = Math.hypot(dx, dz) || 1;
          this.moveToward(this.x + dx / d * 10, this.z + dz / d * 10, 5.5 * this.speedMul, dt);
          if (this.flee <= 0) this.pickNearestCorner(); }
        else if (this.pause > 0) { this.pause -= dt; }
        else { const d = this.moveToward(this.tx, this.tz, 1.5 * this.speedMul, dt); if (d < 0.7) this.nextTarget(); }
      } else if (this.kind === 'cop' || this.kind === 'swat' || (this.kind === 'guard' && this.hostile)) {
        const police = this.kind !== 'guard', swat = this.kind === 'swat';
        const tp = police ? nearestPlayer(this.x, this.z, p => p.wanted > 0) : nearestPlayer(this.x, this.z);
        this.target = tp;
        if (tp) {
          const T = tp.ped, car = T.inCar, dP = Math.hypot(T.x - this.x, T.z - this.z);
          const engage = dP < 60 && W.hasLOS(this.x, this.z, T.x, T.z);
          const wantDist = car ? 10 : 7;
          if (engage) { if (dP > wantDist) this.moveToward(T.x, T.z, swat ? 6.2 : 5.6, dt); else this.yaw += angDiff(Math.atan2(T.x - this.x, T.z - this.z), this.yaw) * Math.min(1, 10 * dt);
            this.armRaise = lerp(this.armRaise, 1, 6 * dt);
            this.shootT -= dt;
            if (this.shootT <= 0 && dP < (swat ? 32 : 26)) { const agg = this.kind === 'guard' ? 1 : swat ? 1.3 : clamp(0.45 + tp.wanted * 0.14, 0.5, 1.1); this.shootT = rr(0.8, 1.6) / agg; npcShoot(this, tp, (car ? 0.55 : 0.4) * agg, car ? (swat ? 5 : 3) : this.kind === 'guard' ? 9 : swat ? 9 : 6); }
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
    draw(dt) { if (S.draw) this.view.draw(this, dt); }
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
      this.hp = type.hp || 100; this.health = this.hp; this.dead = false; this.burn = 0; this.driver = null; this.ai = null; this.panic = 0; this.desired = 0; this.target = null; this.lastHitBy = null; this.lights = false; this.smoking = false; this.roadblock = false; this.riders = []; // the player passengers (seat 1..SEATS)
      this.r = type.w / 2 + 0.12; this.off = type.l / 2 - this.r; this.offs = carOffs(type); this.mass = type.mass; this.occupants = 0; this.hornT = 0; this.age = 0; this.yieldT = 0; this.why = ''; this.stuckT = 0; this.pedWaitT = 0;
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
      if (this.ai === 'traffic' && !this.type.armored) this.panic = Math.max(this.panic, 2.5); // the armored truck keeps rolling under fire
      if (this.health <= 0) this.explode();
      else if (this.health < this.hp * 0.35 && !this.smoking) this.smoking = true;
    }
    explode() {
      if (this.dead) return;
      this.dead = true; this.burn = 7; this.ai = null; this.throttle = 0;
      emit(['explode', r1(this.x), r1(this.y + 1), r1(this.z)], this.x, this.z);
      const by = this.lastHitBy || driverOf(this);
      for (const p of peds) if (!p.dead && !p.inCar && p.kind !== 'player' && dist2(p.x, p.z, this.x, this.z) < 64) p.hurt(200, by, 'explosion');
      for (const pl of players) { if (!alive(pl)) continue; if (pl.ped.inCar === this) damagePlayer(pl, 500, by, 'explosion'); else if (!pl.ped.inCar && dist2(pl.ped.x, pl.ped.z, this.x, this.z) < 81) damagePlayer(pl, 70, by, 'explosion'); }
      for (const c of cars) if (c !== this && !c.dead && dist2(c.x, c.z, this.x, this.z) < 100) { c.lastHitBy = this.lastHitBy; c.damage(60); }
      if (this.driver && !this.driver.owner) { this.driver.inCar = null; this.driver.hurt(500, by, 'explosion'); }
      for (const p of peds) if (p.inCar === this && p.kind !== 'player') { p.inCar = null; p.hurt(500, by, 'explosion'); } // a fare or a patient inside
      this.driver = null;
      if (this.lastHitBy) addWanted(this.lastHitBy, 1);
      alertPeds(this.x, this.z, 60);
      if (this.type.armored) truckOpened(this);
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
        desired = this.type.name === 'sports' ? 16 : this.type.name === 'van' ? 11 : this.type.armored ? 10 : this.type.bus ? 10 : 13;
        this.why = ''; if (turning && t > s.len - 14) desired = this.type.bus ? 4 : 6;
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
          for (let k = 0; k < n; k++) { const side = (k % 2 ? 2.4 : -2.4), back = k < 2 ? 0 : -1.4; const c = new Ped(this.type.swat ? 'swat' : 'cop', this.x + this.rx * side + this.fx * back, this.z + this.rz * side + this.fz * back); c.hostile = true; peds.push(c); cops.push(c); } }
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
      const T = this.type; this.age += dt; const crashes = [];
      const offroad = stepCar(W, this, dt, crashes);
      if (crashes.length) { const d = driverOf(this); if (d) d.crashes += crashes.length; }
      for (const cr of crashes) { this.damage(Math.min(30, cr.imp * 0.9)); emit(['crash', r1(cr.x), r1(this.y + 0.8), r1(cr.z), r1(cr.imp)], cr.x, cr.z); if (this.ai === 'traffic') this.panic = Math.max(this.panic, 1.5); if (T.bike && cr.imp >= THROW_IMP) throwRiders(this, cr.imp, null); }
      if (offroad && this.ai === 'traffic' && this.speed > 1) this.panic = Math.max(this.panic, 1);
      // run over peds (players are knocked aside, everyone else is flattened)
      if (this.speed > 2.5) {
        const hitR2 = (T.l / 2 + 1.2) ** 2, drv = driverOf(this);
        for (const p of peds) { if (p.dead || p.inCar) continue; const dx = p.x - this.x, dz = p.z - this.z; if (dx * dx + dz * dz > hitR2) continue;
          const lx = dx * this.rx + dz * this.rz, lz = dx * this.fx + dz * this.fz;
          if (Math.abs(lx) < T.w / 2 + 0.3 && Math.abs(lz) < T.l / 2 + 0.3) {
            if (p.kind === 'player') { if (friendly || !drv) damagePlayer(p.owner, this.speed * 3.5, drv, 'runover'); p.x += this.fx * 1.5 + this.rx * (lx > 0 ? 1.5 : -1.5); p.z += this.fz * 1.5 + this.rz * (lx > 0 ? 1.5 : -1.5); p.vy = 4; emit(['crash', r1(this.x), r1(this.y + 0.8), r1(this.z), 10], this.x, this.z); }
            else { p.hurt(500, drv, 'runover'); emit(['runover', r1(p.x), r1(p.z), r2(this.yaw)], p.x, p.z); p.yaw = this.yaw + rr(-0.5, 0.5); this.damage(1); if (drv) addWanted(drv, 1); } } }
      }
      if (this.burn > 0) this.burn -= dt;
    }
    draw(dt) { this.lights = !this.dead && (this.ai === 'cop' || !!this.type.ambulance); if (S.draw) this.view.draw(this, dt, S.t); }
  }
  function collideCars() {
    for (let i = 0; i < cars.length; i++) { const A = cars[i]; if (A.released) continue;
      for (let j = i + 1; j < cars.length; j++) { const B = cars[j]; if (B.released) continue;
        if (dist2(A.x, A.z, B.x, B.z) > 64) continue;
        for (const oa of A.offs) for (const ob of B.offs) {
          const ax = A.x + A.fx * oa, az = A.z + A.fz * oa, bx = B.x + B.fx * ob, bz = B.z + B.fz * ob;
          let dx = bx - ax, dz = bz - az; const d2 = dx * dx + dz * dz, rs = A.r + B.r;
          if (d2 >= rs * rs || d2 < 1e-6) continue;
          const d = Math.sqrt(d2); dx /= d; dz /= d; const pen = rs - d, ma = A.mass, mb = B.mass, tot = ma + mb;
          A.x -= dx * pen * (mb / tot); A.z -= dz * pen * (mb / tot); B.x += dx * pen * (ma / tot); B.z += dz * pen * (ma / tot);
          const vn = (B.vx - A.vx) * dx + (B.vz - A.vz) * dz;
          if (vn < 0) { const jimp = -(1 + 0.35) * vn / (1 / ma + 1 / mb), jx = dx * jimp, jz = dz * jimp;
            A.vx -= jx / ma; A.vz -= jz / ma; B.vx += jx / mb; B.vz += jz / mb;
            A.angVel += (A.fz * oa * (-jx) - A.fx * oa * (-jz)) * 0.12 / ma; B.angVel += (B.fz * ob * jx - B.fx * ob * jz) * 0.12 / mb;
            const imp = -vn;
            if (imp > 2.5) { const byP = driverOf(A) || driverOf(B); if (byP) { A.lastHitBy = byP; B.lastHitBy = byP; }
              A.damage(Math.min(30, imp * 1.1)); B.damage(Math.min(30, imp * 1.1)); { const dA = driverOf(A), dB = driverOf(B); if (dA) dA.crashes++; if (dB) dB.crashes++; } emit(['crash', r1((ax + bx) / 2), r1(A.y + 0.9), r1((az + bz) / 2), r1(imp), 8], (ax + bx) / 2, (az + bz) / 2);
              if (byP && !A.type.cop && !B.type.cop && imp > 6 && rnd() < 0.35) byP.heat += 3; if (byP && (A.ai === 'cop' || B.ai === 'cop') && imp > 5) byP.heat += 4;
              if (byP && byP.heat > 8 && byP.wanted === 0) { addWanted(byP, 1); byP.heat = 0; }
              if (imp >= THROW_IMP) { if (A.type.bike) throwRiders(A, imp, driverOf(B)); if (B.type.bike) throwRiders(B, imp, driverOf(A)); } }
          }
        }
      }
    }
  }

  /* a hard hit throws everyone off a motorcycle: out of the saddle, into the air along the bike's travel, and hurt by the impulse */
  function throwRiders(c, imp, by) {
    const list = []; if (c.driver && c.driver.owner) list.push(c.driver.owner); for (const r of c.riders) if (r.owner) list.push(r.owner);
    for (const pl of list) { const P = pl.ped; leaveCar(pl, true); P.vy = 5; P.x += c.fx * 1.2; P.z += c.fz * 1.2; P.collideWorld();
      emit(['float', pl.idx, 'THROWN OFF', 0xff6060]); if (friendly || !by) damagePlayer(pl, Math.min(90, imp * THROW_DMG), by, 'crash'); }
  }

  /* ============================================================ pickups */
  const isWeapon = kind => WEAPONS.some(w => w.key === kind);
  function spawnPickup(x, z, kind, amount, life = 70) {
    if (!guns && (kind === 'ammo' || isWeapon(kind))) return null; // no guns this round: no rounds, no crates, nothing off a corpse
    const i = W.pickPool.alloc(); if (i < 0) return null;
    W.pickPool.color(i, PICK_COLOR(kind));
    const p = { id: nextId++, cls: 'pick', i, x, z, kind, amount, t: rr(0, TAU), life, spot: null, released: false, sent: null, entry: null, dirty: true }; pickups.push(p); ents.set(p.id, p);
    return p;
  }
  function updatePickups(dt) {
    for (let k = pickups.length - 1; k >= 0; k--) { const p = pickups[k]; p.t += dt; p.life -= dt; let take = false;
      for (const pl of players) { if (!alive(pl)) continue; const P = pl.ped; if (dist2(p.x, p.z, P.x, P.z) >= (P.inCar ? 4 : 1.6)) continue;
        if (p.kind === 'bribe' && pl.wanted <= 0) continue; // nothing to buy off: leave it for when it matters
        take = true;
        if (p.kind === 'cash') { pl.cash += p.amount; pl.loot += p.amount; } else if (p.kind === 'ammo') { for (const w of pl.weapons) if (w.owned) w.reserve += w.pick; }
        else if (p.kind === 'bribe') { pl.wanted--; if (pl.wanted <= 0) clearWanted(pl, 'bribe'); }
        else if (isWeapon(p.kind)) takeWeapon(pl, p.kind, p.amount);
        else P.health = Math.min(100, P.health + 40);
        emit(['pickup', pl.idx, p.kind, p.kind === 'bribe' ? pl.wanted : p.amount]); break; }
      if (take || p.life <= 0) { W.pickPool.release(p.i); p.released = true; ents.delete(p.id); pickups.splice(k, 1); if (p.spot) { p.spot.p = null; p.spot.t = p.spot.kind === 'bribe' ? BRIBE_RESPAWN : CRATE_RESPAWN; } continue; }
      drawPickup(W, p.i, p.x, p.z, p.t); }
    W.pickPool.dirty();
  }
  /* the bribes and the weapon crates hidden around the city: each spot holds one until it is taken, then grows a new one after a while */
  const parkSpot = (i, j, ox, oz) => ({ x: X(i) + PITCH / 2 + ox, z: X(j) + PITCH / 2 + oz });
  const crate = kind => { const w = WEAPONS.find(w => w.key === kind); return { kind, amount: w.mag + w.reserve }; };
  const spots = [
    { ...parkSpot(2, 2, 7, 7), kind: 'bribe' }, { ...parkSpot(10, 9, -7, -7), kind: 'bribe' }, { ...parkSpot(3, 10, 7, -7), kind: 'bribe' }, { ...parkSpot(1, 7, -7, 7), kind: 'bribe' }, // the four parks
    { x: POLICE.x, z: X(5) + ROAD / 2 + 2.2, kind: 'bribe' },                                       // the alley behind the precinct
    { x: FERRIS.x + 9, z: FERRIS.z, kind: 'bribe' },                                                // beside the Ferris wheel
    { x: -60, z: BEACH_Z1 - 4, ...crate('sniper') }, { ...parkSpot(3, 10, 7, 7), ...crate('sniper') },  // the end of the pier, the beach park
    { ...parkSpot(10, 9, 7, 7), ...crate('rpg') }, { ...parkSpot(2, 2, -7, -7), ...crate('rpg') },    // the far corners of two parks
  ].filter(s => guns || !isWeapon(s.kind)).map(s => ({ amount: 1, ...s, p: null, t: 0 }));
  function growSpots(dt) {
    for (const s of spots) { if (s.p) continue; s.t -= dt; if (s.t > 0) continue;
      const p = spawnPickup(s.x, s.z, s.kind, s.amount, Infinity); if (p) { p.spot = s; s.p = p; } else s.t = 5; }
  }
  /* a weapon out of a crate (or off a corpse): new to you it is drawn at once with what was inside; already yours, the rounds top up the reserve */
  function takeWeapon(pl, key, rounds) {
    const i = WEAPONS.findIndex(w => w.key === key), w = pl.weapons[i]; if (!w) return;
    if (w.owned) { w.reserve += rounds; return; }
    w.owned = true; w.ammo = Math.min(w.mag, rounds); w.reserve = rounds - w.ammo; switchWeapon(pl, i);
    if (!w.basic) news('gun', pl.idx, key); // a sniper or a rocket in someone's hands is worth knowing about
  }
  /* a dead player leaves the special weapons in the street for whoever gets there first */
  function dropWeapons(pl) {
    const P = pl.ped;
    pl.weapons.forEach((w, i) => { if (w.basic || !w.owned) return; w.owned = false; const rounds = w.ammo + w.reserve; w.ammo = 0; w.reserve = 0;
      if (rounds > 0) spawnPickup(P.x + rr(-1, 1), P.z + rr(-1, 1), w.key, rounds, DROP_LIFE); });
    if (!pl.weapons[pl.curW].owned) switchWeapon(pl, 0);
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
  /* where a passenger's gun pokes out: its window (seatOffset), or the pillion's shoulder on a bike */
  function windowPos(c, seat) {
    const { side, back } = seatOffset(c.type, seat), out = side * (c.type.w / 2 + 0.2);
    return [c.x + c.rx * out + c.fx * back, c.y + 0.35 + c.type.bh + (c.type.bike ? 0.9 : 0.35), c.z + c.rz * out + c.fz * back];
  }
  function startReload(pl) { const w = pl.weapons[pl.curW]; if (pl.reloadT > 0 || w.ammo === w.mag || w.reserve <= 0 || pl.dead) return; pl.reloadT = w.reload; emit(['reload', pl.idx]); }
  function switchWeapon(pl, i) { const n = pl.weapons.length; i = ((i % n) + n) % n; if (i === pl.curW || !pl.weapons[i].owned) return; pl.curW = i; pl.reloadT = 0; pl.fireT = 0.15; emit(['click', pl.idx]); }
  /* the next (dir 1) or previous (dir -1) weapon the player owns, cycling */
  function nextOwned(pl, dir) { const n = pl.weapons.length; for (let k = 1; k < n; k++) { const i = (pl.curW + dir * k + n * k) % n; if (pl.weapons[i].owned) return i; } return pl.curW; }
  /* a rocket's blast: everyone and everything near the hit, the shooter included */
  function explodeAt(x, y, z, pl, radius) {
    emit(['explode', r1(x), r1(y), r1(z)], x, z);
    const r2 = radius * radius, fall = d2 => 1 - Math.sqrt(d2) / radius * 0.5;
    for (const p of peds) { if (p.dead || p.inCar || p.released) continue; const d = dist2(p.x, p.z, x, z); if (d < r2) { if (p.kind === 'player') { if (friendly || p.owner === pl) damagePlayer(p.owner, 110 * fall(d), pl, 'rpg'); } else { p.hurt(200, pl, 'rpg'); if (p.kind === 'civ' || p.kind === 'cop' || p.kind === 'swat') pl.heat += 3; } } }
    for (const c of cars) { if (c.dead || c.released) continue; const d = dist2(c.x, c.z, x, z); if (d < (radius + c.type.l / 2) ** 2) { c.lastHitBy = pl; c.damage(120 * fall(Math.min(d, r2))); if (c.ai === 'traffic' && !c.type.armored) c.panic = Math.max(c.panic, 4); } }
    alertPeds(x, z, 70); pl.heat += 4;
  }
  function fireWeapon(pl) {
    const w = pl.weapons[pl.curW], P = pl.ped; if (!guns || pl.reloadT > 0 || pl.fireT > 0 || P.dead || (P.inCar && P.seat === 0)) return; // a passenger shoots out of the window, the driver drives
    if (w.ammo <= 0) { if (w.reserve > 0) startReload(pl); else { emit(['click', pl.idx]); pl.fireT = 0.3; } return; }
    w.ammo--; pl.fireT = w.rate; pl.armTimer = 1.6; P.armRaise = 1;
    P.yaw = pl.camYaw;
    const cam = computeCamera(W, P, pl.camYaw, pl.camPitch, camTmp); const o = cam, vx = cam.dx, vy = cam.dy, vz = cam.dz;
    const own = P.inCar; let aim = raycast(o.x, o.y, o.z, vx, vy, vz, 400, P, own);
    if (!aim.hit || aim.hit.kind !== 'ped') { // soft lock: nearest ped within ~3 degrees of the crosshair
      let best = 1e9, bp = null;
      for (const p of peds) { if (p === P || p.dead || p.inCar || p.released || (!friendly && p.kind === 'player')) continue;
        for (const hy of [0.3, 1.0, 1.6]) { const dx = p.x - o.x, dy = p.y + hy - o.y, dz = p.z - o.z, d = Math.hypot(dx, dy, dz); if (d > w.range || d < 1.5 || d > aim.t + 1.5) continue;
          const ang = Math.acos(clamp((dx * vx + dy * vy + dz * vz) / d, -1, 1)); const tol = aimTol(d, pl.assist);
          if (ang < tol && ang < best) { best = ang; bp = p; } } }
      if (bp && W.hasLOS(P.x, P.z, bp.x, bp.z)) aim = { x: bp.x, y: bp.y + 1.0, z: bp.z, t: Math.hypot(bp.x - o.x, bp.z - o.z) };
    }
    const [mx, my, mz] = own ? windowPos(own, P.seat) : muzzlePos(P, pl.camPitch); const hits = [];
    for (let k = 0; k < w.pellets; k++) {
      let dx = aim.x - mx, dy = aim.y - my, dz = aim.z - mz; let l = Math.hypot(dx, dy, dz) || 1; dx /= l; dy /= l; dz /= l;
      dx += rr(-w.spread, w.spread); dy += rr(-w.spread, w.spread); dz += rr(-w.spread, w.spread); l = Math.hypot(dx, dy, dz); dx /= l; dy /= l; dz /= l;
      const h = raycast(mx, my, mz, dx, dy, dz, w.range, P, own);
      let kind = 0;
      if (h.hit) {
        if (h.hit.kind === 'ped') { const p = h.hit.p; kind = 1; if (friendly || p.kind !== 'player') p.hurt(w.dmg, pl, w.key); if (p.kind === 'civ' || p.kind === 'cop' || p.kind === 'swat') pl.heat += 2; }
        else if (h.hit.kind === 'car') { const c = h.hit.c; kind = 2; c.lastHitBy = pl; c.damage(w.dmg * 0.4);
          if (c.driver && c.driver.kind !== 'player' && rnd() < 0.25) c.driver.hurt(w.dmg, pl, w.key); if (c.ai === 'traffic' && !c.type.armored) c.panic = Math.max(c.panic, 4); }
        else kind = 3;
      }
      hits.push([r1(h.x), r1(h.y), r1(h.z), kind]);
      if (w.splash) explodeAt(h.x, Math.max(h.y, 0.3), h.z, pl, w.splash);
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
    if (hit) { if (car) { car.damage(dmg); car.lastHitBy = null; } else damagePlayer(tp, dmg, null, sh.kind); }
    alertPeds(sh.x, sh.z, 30);
  }
  function alertPeds(x, z, radius) {
    const r2 = radius * radius;
    for (const p of peds) { if (p.kind !== 'civ' || p.dead) continue; if (dist2(p.x, p.z, x, z) < r2) { p.flee = Math.max(p.flee, rr(5, 9)); p.threatX = x; p.threatZ = z; p.state = 'flee'; p.pause = 0; } }
  }

  /* ============================================================ player life */
  /* `cause` is a CAUSES entry: the weapon key, 'runover', 'explosion' or the kind of NPC that fired */
  function damagePlayer(pl, d, by, cause) {
    if (!alive(pl) || pl.godT > 0 || S.phase !== 'play') return;
    pl.ped.health -= d; pl.noDmgT = 0; emit(['hurt', pl.idx, r1(d)]);
    if (pl.ped.health <= 0) { pl.ped.health = 0; killPlayer(pl, by, cause); }
  }
  function killPlayer(pl, by, cause) {
    const P = pl.ped; if (P.dead) return;
    P.dead = true; P.deadT = 0; P.moving = 0; pl.wastedT = 5.5; P.killedBy = by || null;
    pl.killer = by && by !== pl ? by.idx : -1; pl.cause = Math.max(0, CAUSES.indexOf(cause || '')); pl.deaths++; endChase(pl);
    if (P.inCar) leaveCar(pl, true);
    dropWeapons(pl);
    emit(['wasted', pl.idx]); emit(['blood', r1(P.x), r1(P.z)], P.x, P.z);
    const wasMark = mode === 'mostWanted' && mark.idx === pl.idx;
    emit(['kill', pl.killer, pl.idx, pl.cause]); // the feed on every screen: who, whom, how (the killer is -1 for the cops, the traffic, a crash)
    if (by && by !== pl) { by.kills++; by.killsOf[pl.idx]++; by.cash += 100; emit(['float', by.idx, 'WASTED ' + pl.name.toUpperCase() + '  +$100', 0xff6060]);
      if (by.wanted < 2 && !wasMark && mode !== 'deathmatch') addWanted(by, 1); } // hunting the mark is legal, and so is everything in a deathmatch
    if (wasMark) { if (by && by !== pl) { by.cash += MARK_BOUNTY; emit(['float', by.idx, 'BOUNTY  +$' + MARK_BOUNTY, 0xffe14d]); setMark(by.idx, 'kill'); } else setMark(randomPlayer(pl), 'cops'); }
    if (mode === 'deathmatch' && by && by !== pl && by.kills >= killCap) endRound(); // first to the cap takes the round
  }
  function respawn(pl) {
    const P = pl.ped; P.dead = false; P.health = 100; P.vy = 0;
    if (mode === 'race') { // back at the wheel of a fresh car at the last checkpoint, facing the way the planned route leaves it
      const n = course.length, k = (pl.next + n - 1) % n, at = nodeXZ(course[k]), leg = legs[k], to = nodeXZ(course[pl.next]);
      const yaw = leg.length > 1 ? Math.atan2(leg[1][0] - leg[0][0], leg[1][1] - leg[0][1]) : Math.atan2(to.x - at.x, to.z - at.z), side = pl.idx % 2 ? 3 : -3;
      const c = new Car(CAR_TYPES[1], at.x - Math.cos(yaw) * side, at.z + Math.sin(yaw) * side, yaw, (AVATARS[pl.avatar] || AVATARS[0]).color); cars.push(c);
      P.x = c.x; P.z = c.z; P.y = c.y; P.yaw = yaw; c.driver = P; P.inCar = c; P.seat = 0;
      emit(['float', pl.idx, 'BACK ON THE COURSE', 0x2fd0ff]);
    } else { P.x = HOSPITAL.x - 2 + (pl.idx % 4) * 1.2; P.z = HOSPITAL.z - Math.floor(pl.idx / 4) * 1.2; P.y = groundY(P.x, P.z); P.yaw = 0; pl.cash = Math.max(0, pl.cash - 300); emit(['float', pl.idx, 'HOSPITAL BILL -$300', 0xff6060]); }
    pl.wanted = 0; pl.godT = 3; pl.heat = 0; pl.crimeT = 0; pl.seenT = 0;
    for (const c of cars) if (c.target === pl) c.target = null;
    for (const w of pl.weapons) w.ammo = w.mag;
    emit(['respawn', pl.idx]);
    for (let k = 0; k < 20; k++) spawnCiv(pl);
    { let traffic = 0; for (const c of cars) if (c.ai === 'traffic') traffic++; for (let k = 0; k < Math.round(10 * trafficK) && traffic + k < MAX_TRAFFIC; k++) spawnTrafficCar(pl); } // company around the hospital, within the cap
  }
  function onPlayerKill(p, by) {
    if (p.kind === 'cop' || p.kind === 'swat') { addWanted(by, 1); spawnPickup(p.x + rr(-1, 1), p.z + rr(-1, 1), rnd() < COP_BRIBE_CHANCE ? 'bribe' : 'ammo', 1); }
    else if (p.kind === 'civ') { if (rnd() < 0.75 || by.wanted === 0) addWanted(by, 1); if (rnd() < 0.7) spawnPickup(p.x + rr(-1, 1), p.z + rr(-1, 1), 'cash', ri(5, 60)); }
    else if (p.kind === 'guard') { if (by.wanted < 1) addWanted(by, 1); if (rnd() < 0.6) spawnPickup(p.x + rr(-1, 1), p.z + rr(-1, 1), 'ammo', 1); }
  }
  const endChase = pl => { pl.chaseBest = Math.max(pl.chaseBest, pl.chaseT); pl.chaseT = 0; }; // a chase is one unbroken stretch with the cops on you
  function addWanted(pl, n) {
    if (!pl || pl.gone) return;
    const old = pl.wanted; pl.wanted = clamp(pl.wanted + n, 0, 5); pl.crimeT = 0; pl.seenT = 0; pl.peak = Math.max(pl.peak, pl.wanted);
    if (pl.wanted > old) { emit(['wanted', pl.idx, pl.wanted]); if (pl.wanted === 5 && old < 5) news('stars', pl.idx, 5); }
  }
  /* the heat is off: no stars, no simmering heat, and the cops on this player's tail pick a new target or stand down.
     Shaking off (or buying off) a five-star chase pays a bonus the whole room hears about; turning yourself in does not. */
  function clearWanted(pl, how = 'lost') {
    pl.wanted = 0; pl.heat = 0; pl.crimeT = 0; pl.seenT = 0;
    for (const c of cars) if (c.target === pl) c.target = null;
    for (const c of cops) if (c.target === pl) c.target = null;
    if (pl.peak >= 5 && how !== 'busted') { pl.cash += ESCAPE_BONUS; emit(['float', pl.idx, '5-STAR ESCAPE  +$' + ESCAPE_BONUS, 0xffe14d]); news('escape', pl.idx, ESCAPE_BONUS); }
    pl.peak = 0; endChase(pl);
  }
  /* Most Wanted: hand the mark to a player (-1 clears it); `why` is 'start', 'kill', 'cops' or 'left' */
  function setMark(idx, why) {
    if (mode !== 'mostWanted') return;
    mark.idx = idx; mark.heldT = 0;
    if (idx >= 0) emit(['mark', idx, why]);
  }
  /* a random player who is still in the city, preferably alive and not `excl` */
  function randomPlayer(excl) {
    const here = players.filter(p => !p.gone && p !== excl), up = here.filter(alive);
    const list = up.length ? up : here.length ? here : players.filter(p => !p.gone);
    return list.length ? pick(list).idx : -1;
  }
  function updateMark(dt) {
    if (mode !== 'mostWanted') return;
    if (mark.idx < 0) { mark.pickT -= dt; if (mark.pickT <= 0) setMark(randomPlayer(null), 'start'); return; }
    const h = players[mark.idx];
    if (!h || h.gone) { setMark(randomPlayer(h), 'left'); return; }
    if (!alive(h)) return;
    mark.heldT += dt; h.markT += dt; h.cash += MARK_CASH_PER_S * dt;
    if (h.wanted < MARK_STARS) addWanted(h, MARK_STARS - h.wanted); // the mark always has the cops on it
  }
  /* the Pay 'n' Spray: parked in the bay with stars, pay per star, get a new colour and a clean record */
  function trySpray(pl, c) {
    const cost = STAR_PRICE * pl.wanted;
    if (pl.cash < cost) { if (pl.msgT <= 0) { pl.msgT = 4; emit(['float', pl.idx, 'THE RESPRAY COSTS $' + cost, 0xff6060]); } return; }
    pl.cash -= cost; clearWanted(pl, 'spray');
    const colors = c.type.colors.filter(k => k !== c.color); c.color = colors.length ? pick(colors) : c.color;
    if (c.type.cabin === undefined) c.cabinColor = rnd() < 0.5 ? c.color : 0x222630;
    c.view.recolor(c.color, c.cabinColor);
    emit(['cleared', pl.idx, 'spray']); emit(['float', pl.idx, 'RESPRAYED  -$' + cost, 0x2fd0ff]);
  }
  /* turning yourself in at the precinct: the fine is a star's price each, capped at what you carry, and the spare ammo goes */
  function surrender(pl) {
    const fine = Math.min(pl.cash, STAR_PRICE * pl.wanted);
    pl.cash -= fine; for (const w of pl.weapons) w.reserve = 0;
    clearWanted(pl, 'busted');
    emit(['cleared', pl.idx, 'busted']); news('busted', pl.idx, fine); emit(['float', pl.idx, 'BUSTED  -$' + fine, 0x4d7fff]); emit(['float', pl.idx, 'SPARE AMMO CONFISCATED', 0xff6060]);
  }

  /* ============================================================ cars: enter / exit */
  /* the car to get into: a player at the wheel means riding along (if a seat is free), never jacking them */
  const hasDriverPlayer = c => c.driver && c.driver.kind === 'player';
  function nearestCar(P, maxD) {
    let best = null, bd = maxD * maxD;
    for (const c of cars) { if (c.released || c.dead || (hasDriverPlayer(c) && c.riders.length >= seatsOf(c.type))) continue; const d = dist2(c.x, c.z, P.x, P.z) - (c.type.l / 2) ** 2; if (d < bd) { bd = d; best = c; } }
    return best;
  }
  function leaveCar(pl, silent) {
    const P = pl.ped, c = P.inCar; if (!c) return;
    const side = P.seat === 0 ? -1 : seatOffset(c.type, P.seat).side || 1; // the driver steps out on the left, a passenger on its window's side (a pillion to the right)
    P.x = c.x + c.rx * side * (c.type.w / 2 + 1.1); P.z = c.z + c.rz * side * (c.type.w / 2 + 1.1); P.y = groundY(P.x, P.z); P.vy = 0; P.yaw = c.yaw;
    P.inCar = null; P.ride = false;
    if (P.seat === 0) { c.driver = null; c.throttle = 0; c.steer = 0; c.hand = c.speed < 4; if (pl.job) endJob(pl); }
    else { const i = c.riders.indexOf(P); if (i >= 0) c.riders.splice(i, 1); c.riders.forEach((r, k) => { r.seat = k + 1; }); P.seat = 0; }
    if (!silent) emit(['enter', pl.idx]);
    P.collideWorld();
  }
  function enterCar(pl, c) {
    const P = pl.ped;
    if (hasDriverPlayer(c) && c.driver !== P) { if (c.riders.length >= seatsOf(c.type)) return; c.riders.push(P); P.seat = c.riders.length; P.inCar = c; P.moving = 0; emit(['enter', pl.idx]); return; } // ride along
    if (c.ai === 'traffic' && !c.type.cop) { const d = new Ped('civ', c.x + c.rx * 2.4, c.z + c.rz * 2.4); d.flee = 9; d.threatX = P.x; d.threatZ = P.z; d.state = 'flee'; d.yaw = c.yaw; peds.push(d);
      addWanted(pl, 1); emit(['float', pl.idx, 'CARJACKING', 0xff6060]); }
    if (c.ai === 'cop' && c.occupants > 0) { for (let k = 0; k < c.occupants; k++) { const p = new Ped(c.type.swat ? 'swat' : 'cop', c.x + c.rx * 2.4, c.z + c.rz * 2.4 + k * 1.2); p.hostile = true; peds.push(p); cops.push(p); } c.occupants = 0; addWanted(pl, 1); }
    if (c.driver && c.driver !== P) { const d = c.driver; d.inCar = null; d.x = c.x + c.rx * 2.4; d.z = c.z + c.rz * 2.4; c.driver = null; }
    c.ai = null; c.driver = P; c.panic = 0; c.hand = false; c.target = null; P.inCar = c; P.seat = 0; P.moving = 0; emit(['enter', pl.idx]);
    if (c.type.cop && pl.wanted < 1) addWanted(pl, 1);
  }
  const atPoliceDoor = P => dist2(P.x, P.z, POLICE_DOOR.x, POLICE_DOOR.z) < 3 * 3;
  const inSprayBay = c => Math.abs(c.x - SPRAY.x) < SPRAY.hw && Math.abs(c.z - SPRAY.z) < SPRAY.hd;
  function tryEnterExit(pl) {
    const P = pl.ped; if (!P || P.dead) return;
    if (P.inCar) { leaveCar(pl, false); return; }
    if (pl.wanted > 0 && atPoliceDoor(P)) { surrender(pl); return; }
    const c = nearestCar(P, 4.2); if (c) enterCar(pl, c);
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
    const swat = pl.wanted >= 5 && rnd() < 0.6; // five stars: more often than not it is the SWAT van, four inside
    const c = new Car(CAR_TYPES[swat ? 8 : 5], p.x, p.z, p.yaw); c.ai = 'cop'; c.occupants = swat ? 4 : 2; c.target = pl; c.setSeg(p.a, p.b); cars.push(c);
  }
  /* four stars and driving: two cop cars parked across the road at the next intersection ahead, two cops behind each */
  function spawnRoadblock(pl) {
    const c = pl.ped.inCar; if (!c) return;
    let n = 0; for (const o of cars) if (o.roadblock && o.target === pl && !o.dead && !o.released) n++; if (n >= MAX_ROADBLOCKS * 2) return;
    const fx = c.fx, fz = c.fz, node = nearestNode(c.x + fx * 110, c.z + fz * 110), nx = X(node[0]), nz = X(node[1]);
    const alongX = Math.abs(fx) > Math.abs(fz), dir = alongX ? Math.sign(fx) || 1 : Math.sign(fz) || 1;
    const bx = alongX ? nx - dir * 12 : c.x, bz = alongX ? c.z : nz - dir * 12; // a little before the intersection, on the player's road
    const d = Math.hypot(bx - c.x, bz - c.z); if (d < 55 || d > 170 || !inCity(bx, bz)) return;
    for (const o of cars) if (o.roadblock && !o.released && dist2(o.x, o.z, bx, bz) < 30 * 30) return; // one block per intersection
    const ax = alongX ? 0 : 1, az = alongX ? 1 : 0, yaw = alongX ? 0 : PI / 2; // the cars sit across the road, noses along it
    for (const side of [-1, 1]) { const car = new Car(CAR_TYPES[5], bx + ax * side * 3.4, bz + az * side * 3.4, yaw); car.hand = true; car.roadblock = true; car.target = pl; cars.push(car);
      for (let k = 0; k < 2; k++) { const cop = new Ped('cop', car.x + (alongX ? dir : 0) * 3 + ax * k * 1.4, car.z + (alongX ? 0 : dir) * 3 + az * k * 1.4); cop.hostile = true; cop.target = pl; peds.push(cop); cops.push(cop); } } // the cops take cover on the far side
    emit(['float', pl.idx, 'ROADBLOCK AHEAD', 0xff6060]);
  }
  function spawnTrafficCar(pl) {
    if (!pl) return; const p = laneSpawnPoint(60, 170, pl); if (!p) return;
    const type = pick([CAR_TYPES[0], CAR_TYPES[0], CAR_TYPES[0], CAR_TYPES[1], CAR_TYPES[2], CAR_TYPES[2], CAR_TYPES[3], CAR_TYPES[4], CAR_TYPES[9]]); // one in nine is the bus
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
      anyWanted = true; pl.crimeT += dt; pl.chaseT += dt; const P = pl.ped;
      let seen = false;
      for (const c of cops) if (dist2(c.x, c.z, P.x, P.z) < 3600 && W.hasLOS(c.x, c.z, P.x, P.z)) { seen = true; break; }
      if (!seen) for (const c of cars) if (c.ai === 'cop' && dist2(c.x, c.z, P.x, P.z) < 4900) { seen = true; break; }
      if (seen) pl.seenT = 0; else pl.seenT += dt;
      const marked = mode === 'mostWanted' && mark.idx === pl.idx; // the mark never drops below its stars
      if (pl.seenT > 16 && pl.crimeT > 16 && !(marked && pl.wanted <= MARK_STARS)) { pl.wanted--; pl.seenT = 4; emit(['float', pl.idx, pl.wanted ? 'LOSING THE HEAT' : 'YOU LOST THE COPS', 0x7fe0ff]); if (!pl.wanted) clearWanted(pl, 'lost'); }
      if (pl.wanted >= 4 && P.inCar && P.inCar.speed > 8) { pl.blockT -= dt; if (pl.blockT <= 0) { pl.blockT = ROADBLOCK_EVERY / copK; spawnRoadblock(pl); } } else pl.blockT = Math.min(pl.blockT, 4);
      pl.copSpawnT -= dt;
      const wantFoot = pl.wanted * 2 + 1, wantCars = Math.max(0, pl.wanted - 1) + (pl.wanted >= 4 ? 1 : 0);
      let myFoot = 0, myCars = 0; for (const c of cops) if (c.target === pl) myFoot++; for (const c of cars) if (c.ai === 'cop' && !c.dead && c.target === pl) myCars++;
      if (pl.copSpawnT <= 0 && !P.dead) { pl.copSpawnT = clamp(5.5 - pl.wanted * 0.8, 1.2, 4.5) / copK;
        const canFoot = cops.length < MAX_COPS, canCar = copCars < MAX_COP_CARS;
        if (canCar && myCars < wantCars && (myFoot >= pl.wanted || rnd() < 0.5)) { spawnCopCar(pl); copCars++; }
        else if (canFoot && myFoot < wantFoot) spawnCopFoot(pl);
        else if (canCar && myCars < wantCars) { spawnCopCar(pl); copCars++; } }
    }
    if (!anyWanted && cops.length) {
      for (const c of cops) { let keep = false; for (const pl of players) { if (pl.gone || !pl.ped) continue; if (dist2(c.x, c.z, pl.ped.x, pl.ped.z) <= 900 && W.hasLOS(c.x, c.z, pl.ped.x, pl.ped.z)) { keep = true; break; } } if (!keep) { c.release(); c.dead = true; } }
      for (const c of cars) if (c.ai === 'cop') c.rejoin();
    }
    for (const c of cars) if (c.roadblock && !c.dead && !c.driver && (!c.target || c.target.gone || c.target.wanted === 0) && minPlayerDist2(c.x, c.z) > 40 * 40) c.release(); // the chase is over: the block packs up out of sight
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
    else if (mission.state === 'hit') { if (v && v.dead) { mission.state = 'passed'; mission.passedT = 6; const k = v.killedBy; mission.killer = k;
      if (k) { k.cash += 5000; addWanted(k, 2); } emit(['passed', k ? k.idx : -1]);
      mission.guards.forEach(g => { if (!g.dead) { g.kind = 'civ'; g.hostile = false; g.flee = 12; g.threatX = v.x; g.threatZ = v.z; g.state = 'flee'; } }); } }
    else if (mission.state === 'passed') { mission.passedT -= dt; if (mission.passedT <= 0) mission.state = mission.killer && !mission.killer.gone && mission.killer.wanted > 0 ? 'escape' : 'done'; }
    else if (mission.state === 'escape') { const k = mission.killer; if (!k || k.gone || k.wanted === 0) { mission.state = 'done'; if (k && !k.gone) emit(['float', k.idx, 'CLEAN GETAWAY', 0x7fe0ff]); } }
  }

  /* ============================================================ world events (one at a time, the whole room hears about them)
     'truck': an armored truck joins the traffic near someone; blow it open and it spills cash.
     'airdrop': a crate is called in over a park or the plaza and lands ten seconds later with cash, ammo and health around it. */
  const DROP_SPOTS = [parkSpot(2, 2, 0, 0), parkSpot(10, 9, 0, 0), parkSpot(3, 10, 0, 0), parkSpot(1, 7, 0, 0), { x: PLAZA.x, z: PLAZA.z }, { x: FERRIS.x - 34, z: FERRIS.z }];
  function startEvent(kind) {
    if (WE.kind) return false;
    if (kind === 'truck') { const pl = anchor(); if (!pl || !pl.ped) return false; const p = laneSpawnPoint(120, 220, pl); if (!p) return false;
      const c = new Car(CAR_TYPES[7], p.x, p.z, p.yaw); c.ai = 'traffic'; c.setSeg(p.a, p.b); c.vx = c.fx * 6; c.vz = c.fz * 6; cars.push(c);
      WE.kind = kind; WE.car = c; WE.x = c.x; WE.z = c.z; WE.t = TRUCK_T; WE.landed = false;
      emit(['wevent', EVENT_KINDS.indexOf(kind), r1(c.x), r1(c.z), 'ARMORED TRUCK ON ' + streetAt(c.x, c.z).toUpperCase() + '  ·  BLOW IT OPEN']); return true; }
    if (kind === 'airdrop') { const s = pick(DROP_SPOTS);
      WE.kind = kind; WE.car = null; WE.x = s.x; WE.z = s.z; WE.t = AIRDROP_T; WE.landT = AIRDROP_FALL; WE.landed = false;
      emit(['wevent', EVENT_KINDS.indexOf(kind), r1(s.x), r1(s.z), 'AIRDROP INCOMING  ·  ' + districtAt(s.x, s.z)]); return true; }
    return false;
  }
  function endEvent() { WE.kind = null; WE.car = null; WE.landed = false; WE.nextT = rr(EVENT_GAP[0], EVENT_GAP[1]); }
  function truckOpened(c) {
    for (let k = 0; k < TRUCK_CASH; k++) { const a = rr(0, TAU), d = rr(2.5, 6.5); spawnPickup(c.x + Math.sin(a) * d, c.z + Math.cos(a) * d, 'cash', ri(80, 160), 90); }
    emit(['float', -1, 'THE ARMORED TRUCK IS OPEN. GRAB THE CASH!', 0x3dff7a]); news('truck', c.lastHitBy ? c.lastHitBy.idx : -1, streetAt(c.x, c.z));
    if (WE.car === c) { WE.t = Math.min(WE.t, 45); WE.landed = true; } // the event lingers over the spill, then ends
  }
  function updateEvents(dt) {
    if (!WE.kind) { WE.nextT -= dt; if (WE.nextT <= 0) { if (!startEvent(pick(EVENT_KINDS))) WE.nextT = 3; } return; }
    WE.t -= dt;
    if (WE.kind === 'truck') { const c = WE.car; if (c && !c.released && !c.dead) { WE.x = c.x; WE.z = c.z; } if (!c || c.released) { endEvent(); return; } }
    else if (WE.kind === 'airdrop' && !WE.landed) { WE.landT -= dt; if (WE.landT <= 0) { WE.landed = true;
      for (let k = 0; k < 8; k++) { const a = k * TAU / 8, d = 3.2; spawnPickup(WE.x + Math.sin(a) * d, WE.z + Math.cos(a) * d, 'cash', 100, AIRDROP_T); }
      for (let k = 0; k < 3; k++) { const a = k * TAU / 3 + 0.4, d = 1.6; spawnPickup(WE.x + Math.sin(a) * d, WE.z + Math.cos(a) * d, 'ammo', 1, AIRDROP_T); }
      spawnPickup(WE.x, WE.z, 'health', 40, AIRDROP_T);
      { const c = crate(rnd() < 0.5 ? 'sniper' : 'rpg'); spawnPickup(WE.x + 1.2, WE.z - 1.2, c.kind, c.amount, AIRDROP_T); } // and a weapon
      emit(['wland', r1(WE.x), r1(WE.z)], WE.x, WE.z); news('drop', -1, districtAt(WE.x, WE.z)); alertPeds(WE.x, WE.z, 30); } }
    if (WE.t <= 0) endEvent();
  }

  /* ============================================================ the driving jobs: taxi fares and ambulance patients
     At the wheel of a taxi (or the ambulance) a job starts by itself: a fare waves from a street corner a block or two away
     (a patient lies there), stop beside it and it gets in, then a destination is named (the hospital for a patient) with a
     timer and a price by the metre. Delivered in time it pays, fast pays a tip, every delivery in a row adds to the next.
     Too slow, or the fare is hurt or the car is left, and the fare is gone and the streak with it. */
  function pickCorner(x, z, minD, maxD) {
    for (let tries = 0; tries < 24; tries++) { const a = rr(0, TAU), d = rr(minD, maxD); const px = x + Math.sin(a) * d, pz = z + Math.cos(a) * d; if (!inCity(px, pz)) continue;
      const [cx, cz] = cornerXZ(clamp(cellOf(px), 0, NB - 1), clamp(cellOf(pz), 0, NB - 1), ri(0, 3)); if (dist2(cx, cz, x, z) < (minD * 0.7) ** 2) continue; return { x: cx, z: cz }; }
    return null;
  }
  const jobWord = j => j.kind === 'taxi' ? 'FARE' : 'PATIENT';
  function newFare(pl) {
    const j = pl.job, c = pl.ped.inCar; const spot = pickCorner(c.x, c.z, 60, 170); if (!spot) { j.t = 3; return; }
    const p = new Ped('civ', spot.x + rr(-1, 1), spot.z + rr(-1, 1)); p.job = pl; p.state = 'wait'; p.pause = 0; p.flee = 0;
    if (j.kind === 'ambulance') { p.down = true; p.health = 25; }
    peds.push(p); j.fare = p; j.stage = 'pickup'; j.x = p.x; j.z = p.z; j.t = JOB_PICKUP_T;
    emit(['float', pl.idx, jobWord(j) + ' WAITING ON ' + streetAt(p.x, p.z).toUpperCase(), 0xf2c014]); emit(['job', pl.idx, 'fare']);
  }
  /* the fare steps out beside the car; delivered it walks off, otherwise it runs */
  function fareOut(p, c, ok) {
    p.inCar = null; p.job = null; p.down = false; p.x = c.x + c.rx * 2.4; p.z = c.z + c.rz * 2.4; p.y = groundY(p.x, p.z);
    if (ok) p.pickNearestCorner(); else { p.flee = 6; p.threatX = c.x; p.threatZ = c.z; p.state = 'flee'; }
    p.collideWorld();
  }
  function releaseFare(j, ok) {
    const p = j.fare; j.fare = null; if (!p || p.dead || p.released) return;
    if (p.inCar) fareOut(p, p.inCar, ok); else { p.job = null; p.down = false; if (ok) p.pickNearestCorner(); else { p.flee = 5; p.state = 'flee'; } }
  }
  function endJob(pl) { const j = pl.job; if (!j) return; pl.job = null; releaseFare(j, true); emit(['job', pl.idx, 'end']); }
  function failJob(pl, text) {
    const j = pl.job; if (!j) return;
    releaseFare(j, false); j.n = 0; j.stage = 'wait'; j.t = 4;
    emit(['float', pl.idx, text, 0xff6060]); emit(['job', pl.idx, 'fail']);
  }
  function updateJob(pl, dt) {
    const P = pl.ped, c = P.inCar; const kind = c && P.seat === 0 && !c.dead && openCity ? (c.type.taxi ? 'taxi' : c.type.ambulance ? 'ambulance' : null) : null; // no fares mid-race or in a deathmatch
    if (!kind) { if (pl.job) endJob(pl); return; }
    if (!pl.job) { pl.job = { kind, stage: 'wait', fare: null, x: 0, z: 0, t: 1.5, dist: 0, pay: 0, n: 0 };
      emit(['float', pl.idx, kind === 'taxi' ? 'TAXI JOB  ·  FARES PAY BY THE METRE' : 'PARAMEDIC  ·  GET THE PATIENTS TO THE HOSPITAL', 0xf2c014]); emit(['job', pl.idx, 'start']); }
    const j = pl.job; j.t -= dt;
    if (j.stage === 'wait') { if (j.t <= 0) newFare(pl); return; }
    const p = j.fare;
    if (!p || p.dead || p.released) { failJob(pl, kind === 'taxi' ? 'YOUR FARE IS GONE' : "THE PATIENT DIDN'T MAKE IT"); return; }
    if (j.t <= 0) { failJob(pl, j.stage === 'pickup' ? (kind === 'taxi' ? 'THE FARE TOOK ANOTHER CAB' : 'TOO LATE FOR THE PATIENT') : 'TOO SLOW. THE ' + jobWord(j) + ' GOT OUT'); return; }
    if (c.speed > 1.5) return;
    if (j.stage === 'pickup') { if (dist2(c.x, c.z, p.x, p.z) > 8 * 8) return;
      p.inCar = c; p.armRaise = 0; p.flee = 0;
      const dest = kind === 'taxi' ? (pickCorner(c.x, c.z, 90, 260) || pickCorner(c.x, c.z, 40, 300) || AMB_BAY) : AMB_BAY;
      const d = Math.hypot(dest.x - c.x, dest.z - c.z), rate = kind === 'taxi' ? TAXI_PAY : AMB_PAY;
      j.stage = 'dropoff'; j.x = dest.x; j.z = dest.z; j.dist = d; j.t = d / 8 + 20; j.pay = Math.round(rate[0] + d * rate[1]);
      emit(['float', pl.idx, (kind === 'taxi' ? 'TAKE THE FARE TO ' + streetAt(dest.x, dest.z).toUpperCase() : 'GET THE PATIENT TO THE HOSPITAL') + '  $' + j.pay, 0xf2c014]); emit(['job', pl.idx, 'pickup']); }
    else { if (dist2(c.x, c.z, j.x, j.z) > 9 * 9) return;
      j.n++; const tip = j.t > (j.dist / 8 + 20) * 0.4 ? Math.round(j.pay * JOB_TIP) : 0, streak = JOB_STREAK * (j.n - 1), total = j.pay + tip + streak;
      pl.cash += total; releaseFare(j, true); j.stage = 'wait'; j.t = 2; pl.streakBest = Math.max(pl.streakBest, j.n); if (j.n >= STREAK_NEWS) news('streak', pl.idx, j.n);
      emit(['float', pl.idx, (kind === 'taxi' ? 'FARE PAID' : 'PATIENT DELIVERED') + '  +$' + total + (tip ? '  (TIP $' + tip + ')' : '') + (streak ? '  (' + j.n + ' IN A ROW +$' + streak + ')' : ''), 0x3dff7a]); emit(['job', pl.idx, 'paid']); }
  }

  /* ============================================================ the race (mode 'race')
     Everyone starts at the wheel on the grid below the start intersection, a countdown holds them, then it is `laps` laps (three unless the lobby says otherwise)
     through the course's checkpoints in order and back across the line. Anything goes: guns, traffic, cops. The first
     across the line starts a grace period for the rest; when it runs out (or everyone is home, or the round timer
     ends) the standings are the finishing order, then progress along the course. */
  const racing = pl => !pl.gone && pl.ped && !pl.place;
  function updateRace(dt) {
    if (S.phase === 'countdown') { RC.t -= dt; if (RC.t <= 0) { RC.t = 0; S.phase = 'play'; emit(['go']); } return; }
    if (S.phase !== 'play') return;
    const n = course.length;
    for (const pl of players) { if (!racing(pl)) continue; pl.lapT += dt; if (pl.ped.dead) continue; const P = pl.ped, cp = nodeXZ(course[pl.next]);
      if (dist2(P.x, P.z, cp.x, cp.z) > CP_RADIUS * CP_RADIUS) continue;
      if (pl.next === 0) { pl.lap++; pl.next = 1; if (!pl.lapBest || pl.lapT < pl.lapBest) pl.lapBest = pl.lapT; pl.lapT = 0;
        if (pl.lap >= laps) { pl.place = ++RC.finishers; pl.cash += Math.max(0, 1000 - (pl.place - 1) * 250); emit(['finish', pl.idx, pl.place]);
          if (!RC.ending) { RC.ending = true; RC.t = RACE_END_T; } continue; }
        emit(['cp', pl.idx, pl.lap * n, pl.lap]); }
      else { pl.next = (pl.next + 1) % n; emit(['cp', pl.idx, pl.lap * n + (pl.next === 0 ? n - 1 : pl.next - 1), pl.lap]); } }
    // the standings: finishers by place, then everyone by how far along they are
    const here = players.filter(p => !p.gone && p.ped), key = p => p.place ? 1e6 - p.place : progressOf(course, p.lap, p.next, p.ped.x, p.ped.z);
    here.sort((a, b) => key(b) - key(a)).forEach((p, i) => { p.rank = i + 1; });
    if (RC.ending) { RC.t -= dt; if (RC.t <= 0 || here.every(p => p.place)) endRound(); }
  }
  function endRound() { if (S.phase === 'over') return; S.phase = 'over'; S.timeLeft = Math.max(0, S.timeLeft); for (const pl of players) { pl.bits = 0; pl.godT = 1e9; endChase(pl); } emit(['over', awards()]); }
  /* the round's awards: [key, player index, value, extra?] for up to AWARDS_SHOWN of AWARD_KEYS, in that order of importance (the fastest lap
     leads a race day); each has a bar to clear so an empty room hands nothing out, and the first player along wins a tie */
  function awards() {
    const here = players.filter(p => p.ped), out = [];
    const best = (val, ok, lower = false) => { let b = null, bv = 0; for (const p of here) { const v = val(p); if (!ok(v)) continue; if (!b || (lower ? v < bv : v > bv)) { b = p; bv = v; } } return b ? [b.idx, r1(bv)] : null; };
    const add = (key, r, extra) => { if (r) out.push(extra === undefined ? [key, r[0], r[1]] : [key, r[0], r[1], extra(players[r[0]])]); };
    if (mode === 'race') add('lap', best(p => p.lapBest, v => v > 0, true));
    add('killer', best(p => p.kills, v => v >= 1));
    { let ba = null, bb = -1, bn = 1; for (const p of here) p.killsOf.forEach((n, j) => { if (n > bn) { bn = n; ba = p; bb = j; } }); if (ba) out.push(['nemesis', ba.idx, bn, bb]); }
    add('victim', best(p => p.deaths, v => v >= 2));
    add('fugitive', best(p => p.chaseBest, v => v >= 30));
    if (openCity) add('cabbie', best(p => p.streakBest, v => v >= 2)); // no fares to run otherwise
    add('speed', best(p => p.topSpeed * 3.6, v => v >= 60));
    add('driver', best(p => p.driven >= DRIVER_MIN_M ? p.crashes : -1, v => v >= 0, true), p => r1(p.driven / 1000));
    add('loot', best(p => p.loot, v => v >= 100));
    return out.slice(0, AWARDS_SHOWN);
  }

  /* ============================================================ the players' own update */
  function updatePlayer(pl, dt, live) {
    const P = pl.ped; pl.noDmgT += dt; pl.godT -= dt; pl.fireT -= dt; pl.armTimer -= dt; pl.msgT -= dt;
    if (P.dead) { P.deadT += dt; pl.wastedT -= dt; if (pl.wastedT <= 0 && live) respawn(pl); P.gun = null; P.draw(dt); return; }
    if (pl.noDmgT > 8 && P.health < 100) P.health = Math.min(100, P.health + 3 * dt);
    if (pl.reloadT > 0) { pl.reloadT -= dt; if (pl.reloadT <= 0) { const w = pl.weapons[pl.curW]; const take = Math.min(w.mag - w.ammo, w.reserve); w.ammo += take; w.reserve -= take; } }
    const b = live ? pl.bits : 0, sx = live ? pl.sx : 0, sz = live ? pl.sz : 0; pl.seqApplied = pl.seq;
    if (pl.clicksSeen === null) pl.clicksSeen = pl.clicks;
    let clicks = Math.min(3, pl.clicks - pl.clicksSeen); pl.clicksSeen = pl.clicks;
    if (live) { const w = pl.weapons[pl.curW]; if (w.auto) { if (b & IN.FIRE) fireWeapon(pl); } else while (clicks-- > 0) fireWeapon(pl); }
    pl.hint = 0;
    if (P.inCar) {
      const c = P.inCar, driving = P.seat === 0; if (driving) { driveInput(c, b, dt, sx, sz); pl.driven += c.speed * dt; if (c.speed > pl.topSpeed) pl.topSpeed = c.speed; }
      P.x = c.x; P.z = c.z; P.y = c.y; P.yaw = c.yaw; P.moving = 0; P.ride = !!c.type.bike;
      pl.hint = driving ? 1 : 6;
      if (c.dead) leaveCar(pl, false);
      else if (driving && live && pl.wanted > 0 && dist2(c.x, c.z, SPRAY.x, SPRAY.z) < 22 * 22) { pl.hint = 4; if (c.speed < 1.5 && inSprayBay(c)) trySpray(pl, c); }
    } else {
      stepOnFoot(W, P, b, pl.camYaw, pl.armTimer > 0, dt, cars, sx, sz);
      for (const p of peds) { if (p === P || p.dead || p.inCar) continue; const d2 = dist2(p.x, p.z, P.x, P.z); if (d2 < 0.7 && d2 > 1e-4) { const d = Math.sqrt(d2), push = (0.84 - d) / d; p.x += (p.x - P.x) * push; p.z += (p.z - P.z) * push; } }
      const c = nearestCar(P, 4.2);
      if (c) pl.hint = hasDriverPlayer(c) ? 7 : (c.ai === 'traffic' || (c.ai === 'cop' && c.occupants)) ? 2 : 3;
      if (pl.wanted > 0 && atPoliceDoor(P)) pl.hint = 5;
      if (dist2(P.x, P.z, HOSPITAL.x, HOSPITAL.z) < 36 && P.health < 100) P.health = Math.min(100, P.health + 25 * dt);
    }
    if (live) updateJob(pl, dt);
    P.armRaise = lerp(P.armRaise, pl.armTimer > 0 && !P.inCar ? 1 : 0, Math.min(1, 10 * dt));
    P.camPitch = pl.camPitch; P.gun = P.inCar ? null : pl.weapons[pl.curW].key;
    if (!pl.weapons[pl.curW].owned) switchWeapon(pl, 0);
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
      if (!p.dead && !p.inCar) { if (pushOutOfCars(p, 0.3, false, cars)) { p.carStuck++; if (p.carStuck > 90 && p.kind === 'civ') { p.carStuck = 0; p.flee = 2; p.threatX = p.x + rr(-1, 1); p.threatZ = p.z + rr(-1, 1); p.state = 'flee'; } } else p.carStuck = 0; } }
    if (live) { updateWanted(dt); updateMission(dt); updateMark(dt); if (openCity) updateEvents(dt); }
    if (mode === 'race') updateRace(dt);
    updatePickups(dt); growSpots(dt);
    W.dirtyDynamic();
    // population maintenance: cull what is far from everyone, top up near a random player
    S.spawnT -= dt;
    if (S.spawnT <= 0) { S.spawnT = 0.5;
      let civs = 0, traffic = 0;
      for (let k = peds.length - 1; k >= 0; k--) { const p = peds[k]; if (p.kind === 'player') continue;
        const far = minPlayerDist2(p.x, p.z) > 240 * 240;
        if (far && (p.kind === 'civ' || p.kind === 'cop' || p.kind === 'swat' || p.dead) && p !== mission.vinny && !p.job) { p.release(); peds.splice(k, 1); continue; }
        if (p.kind === 'civ' && !p.dead) civs++; }
      for (let k = cars.length - 1; k >= 0; k--) { const c = cars[k]; if (hasDriverPlayer(c) || c.riders.length) continue;
        const far = minPlayerDist2(c.x, c.z) > 270 * 270;
        if (far && (c.ai === 'traffic' || c.ai === 'cop' || c.dead || (!c.ai && !c.parked)) && c !== WE.car) { c.release(); cars.splice(k, 1); continue; }
        if (c.released) { cars.splice(k, 1); continue; }
        if (c.ai === 'traffic') traffic++; }
      for (let k = 0; k < 3 && civs + k < 92; k++) spawnCiv(anchor());
      for (let k = 0; k < TRAFFIC_TOPUP && traffic + k < MAX_TRAFFIC; k++) spawnTrafficCar(anchor());
    }
    S.clockH += dt / 45; if (S.clockH >= 24) S.clockH -= 24;
    if (live && !S.unlimited) { S.timeLeft -= dt; if (S.timeLeft <= 0) { S.timeLeft = 0; endRound(); } }
  }

  /* ============================================================ input from the players */
  function setInput(pl, m) {
    if (!pl || pl.gone || !m) return; pl.bits = m.m | 0;
    pl.sx = typeof m.x === 'number' ? clamp(m.x, -1, 1) : 0; pl.sz = typeof m.z === 'number' ? clamp(m.z, -1, 1) : 0; pl.assist = !!m.a;
    if (typeof m.y === 'number') pl.camYaw = m.y; if (typeof m.p === 'number') pl.camPitch = clamp(m.p, -0.45, 1.1); if (typeof m.c === 'number') pl.clicks = m.c; if (typeof m.q === 'number') pl.seq = m.q;
  }
  function action(pl, a, n) {
    if (!pl || pl.gone || !pl.ped || S.phase !== 'play') return;
    if (a === 'use') tryEnterExit(pl); else if (!guns) return; else if (a === 'reload') startReload(pl); else if (a === 'weapon') switchWeapon(pl, n | 0); else if (a === 'wnext') switchWeapon(pl, nextOwned(pl, n < 0 ? -1 : 1));
  }
  function playerLeft(id) {
    const pl = players.find(p => p.id === id); if (!pl || pl.gone) return;
    pl.gone = true;
    if (pl.ped) { if (pl.ped.inCar) leaveCar(pl, true); pl.ped.release(); const i = peds.indexOf(pl.ped); if (i >= 0) peds.splice(i, 1); pl.ped = null; }
    for (const c of cars) if (c.target === pl) c.target = null;
    news('left', pl.idx);
    if (mode === 'mostWanted' && mark.idx === pl.idx) setMark(randomPlayer(pl), 'left');
  }

  /* ============================================================ the wire */
  const pedEntry = p => { const f = (p.dead ? PF.DEAD : 0) | (p.inCar ? PF.INCAR : 0) | (p.moving > 3 ? PF.RUN : p.moving > 0 ? PF.WALK : 0) | (p.armRaise > 0.5 ? PF.ARM : 0) | (p.hitT > 0 ? PF.HIT : 0) | (p.dead && p.deadT > 1 ? PF.OLDDEAD : 0) | (p.down && !p.dead ? PF.DOWN : 0) | (p.ride && p.inCar ? PF.RIDE : 0);
    const e = [p.id, kindIdx(p.kind), p.style, r2(p.x), r2(p.z), r2(p.yaw), f]; if (p.kind === 'player') e.push(r2(p.y)); return e; };
  const carEntry = c => [c.id, c.type.idx, c.color, c.cabinColor, r2(c.x), r2(c.z), r2(c.yaw), r2(c.steer), r2(c.vF), (c.dead ? CF.DEAD : 0) | (c.smoking ? CF.SMOKE : 0) | (c.burn > 0 ? CF.BURN : 0) | (c.lights ? CF.LIGHTS : 0)];
  const pickEntry = p => [p.id, PICK_KINDS.indexOf(p.kind), r1(p.x), r1(p.z)];
  const same = (a, b) => { if (!b || a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };
  const block = pl => { const P = pl.ped, w = pl.weapons[pl.curW];
    return [P ? P.id : -1, P ? Math.round(P.health) : 0, pl.wanted, Math.floor(pl.cash), pl.kills, pl.curW, w.ammo, w.reserve, r2(pl.reloadT), P && P.dead ? 1 : 0, r1(pl.wastedT), P && P.inCar ? P.inCar.id : -1, pl.hint, r2(pl.camPitch), pl.godT > 0 ? 1 : 0, pl.gone ? 1 : 0, pl.seqApplied,
      pl.killer, pl.cause, r1(pl.markT), pl.weapons.reduce((m, w, i) => m | (w.owned ? 1 << i : 0), 0), P ? P.seat : 0, // appended: who killed me last and how, seconds as the mark, the weapons I own (a bit each), my seat (0 = the wheel)
      pl.lap, pl.next, pl.rank, pl.place, // the race: laps done, the checkpoint I head for, my standing, my finishing place
      ...(pl.job ? [JOB_KINDS.indexOf(pl.job.kind), JOB_STAGES.indexOf(pl.job.stage), r1(pl.job.x), r1(pl.job.z), r1(Math.max(0, pl.job.t)), pl.job.n] : [0])]; }; // the job (last, it is variable): kind, stage, where to go, seconds left, deliveries in a row
  /* the shared mode state: [mode, the mark's player index, seconds it has held, the world event or null ([kind, x, z, seconds left, landed]),
     the race or null ([0 countdown / 1 racing / 2 someone is home, seconds left of the countdown or the grace, finishers]),
     the deathmatch or null ([the kills that win, the leader's player index or -1, the leader's kills])] */
  const leader = () => { let b = null; for (const p of players) if (p.kills > 0 && (!b || p.kills > b.kills)) b = p; return b; }; // the first along wins a tie
  const modeState = () => [MODES.indexOf(mode), mark.idx, r1(mark.heldT), WE.kind ? [EVENT_KINDS.indexOf(WE.kind), r1(WE.x), r1(WE.z), r1(WE.t), WE.landed ? 1 : 0] : null,
    mode === 'race' ? [S.phase === 'countdown' ? 0 : RC.ending ? 2 : 1, r1(RC.t), RC.finishers] : null,
    mode === 'deathmatch' ? (l => [killCap, l ? l.idx : -1, l ? l.kills : 0])(leader()) : null];
  function prepareNet() {
    for (const e of ents.values()) { const entry = e.cls === 'ped' ? pedEntry(e) : e.cls === 'car' ? carEntry(e) : pickEntry(e); e.entry = entry; e.dirty = !same(entry, e.sent); }
  }
  /* client = { id, known: Set<entityId>, pl: Player } */
  function snapshotFor(client) {
    const pl = client.pl, P = pl.ped, cx = P ? P.x : 0, cz = P ? P.z : 0, known = client.known;
    const v = mission.vinny;
    const msg = { t: 's', to: client.id, c: r2(S.clockH), tl: S.unlimited ? -1 : r1(S.timeLeft), ph: S.phase === 'over' ? 1 : 0, ms: MISSION_STATES.indexOf(mission.state),
      vin: v && !v.released ? [r1(v.x), r1(v.z), v.dead ? 1 : 0] : null, md: modeState(), P: players.map(block), p: [], v: [], k: [], rm: [], ev: [] };
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
      if (vert && k === 6 && m === 6 && side < 0) continue; // the taxi rank
      const a = vert ? [k, m] : [m, k], b = vert ? [k, m + 1] : [m + 1, k]; const s = side > 0 ? segInfo(a, b) : segInfo(b, a);
      const t = rr(12, s.len - 14); const x = s.ax + s.dx * t + s.rx * PARK, z = s.az + s.dz * t + s.rz * PARK;
      const type = pick([CAR_TYPES[0], CAR_TYPES[0], CAR_TYPES[1], CAR_TYPES[3], CAR_TYPES[4], CAR_TYPES[10]]); // one parked vehicle in six is a motorcycle (the traffic has none: nobody would be in the saddle)
      const c = new Car(type, x, z, Math.atan2(s.dx, s.dz)); c.hand = true; c.parked = true; cars.push(c);
    }
    for (const ox of [-4, 0, 4]) { const c = new Car(CAR_TYPES[10], FERRIS.x + 30 + ox, FERRIS.z + 4, 0); c.hand = true; c.parked = true; cars.push(c); } // three bikes by the Ferris wheel
    for (const ox of [-6, 0, 6]) { const c = new Car(CAR_TYPES[5], POLICE.x + ox, POLICE.z, PI); c.hand = true; c.parked = true; cars.push(c); }
    const amb = new Car(CAR_TYPES[6], HOSPITAL.x + 9, HOSPITAL.z - 1, PI / 2); amb.hand = true; amb.parked = true; cars.push(amb);
    for (const oz of [-8, 0, 8]) { const c = new Car(CAR_TYPES[2], TAXI_RANK.x, TAXI_RANK.z + oz, PI); c.hand = true; c.parked = true; cars.push(c); } // the rank: three cabs, no carjacking needed
  }
  (session.players || []).forEach((info, i) => {
    const pl = new Player(info, i); players.push(pl); const s = SPAWNS[i % SPAWNS.length], color = (AVATARS[pl.avatar] || AVATARS[0]).color;
    if (mode === 'race') { const g = gridSlot(i); const car = new Car(CAR_TYPES[1], g.x, g.z, g.yaw, color); cars.push(car); // on the grid, at the wheel, facing the line
      pl.ped = new Ped('player', g.x, g.z, pl.avatar, pl); pl.ped.yaw = g.yaw; peds.push(pl.ped); car.driver = pl.ped; pl.ped.inCar = car; pl.ped.seat = 0; return; }
    pl.ped = new Ped('player', s.x, s.z, pl.avatar, pl); pl.ped.yaw = s.face; peds.push(pl.ped);
    const car = new Car(CAR_TYPES[1], s.cx, s.z, s.yaw, color); car.hand = true; car.parked = true; cars.push(car);
  });
  placeParkedCars(); if (mode === 'sandbox') initMission();
  for (let k = 0; k < 90; k++) spawnCiv(anchor());
  for (let k = 0; k < MAX_TRAFFIC; k++) spawnTrafficCar(anchor());

  return { players, peds, cars, cops, pickups, spots, mission, S, ents, mode, laps, killCap, guns, kit, mark, WE, course, RC, modeState, update, setInput, action, playerLeft, block, prepareNet, snapshotFor, endNet, clearEvents, dispose, playerOf: id => players.find(p => p.id === id) || null,
    /* for the tests and the console: reach into the rules directly */
    debug: { damagePlayer, killPlayer, addWanted, clearWanted, surrender, setMark, startEvent, spawnRoadblock, fireWeapon, enterCar, leaveCar, takeWeapon, spawnPickup, newFare, failJob, endJob, throwRiders, collideCars, Ped, Car, MAX_COPS, MAX_COP_CARS, MAX_TRAFFIC } };
}
