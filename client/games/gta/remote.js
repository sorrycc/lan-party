/* A client's copy of the city: entities created, updated and removed from the host's delta snapshots, rendered a
   little in the past by interpolating between the last two states of each one. The per-player HUD blocks and the
   shared round state (clock, timer, mission) come along in the same message. */
import { lerp } from '../../core/math.js';
import { nowSec, pushSnap, sampleSnaps } from '../../core/interp.js';
import { groundY, angDiff } from './world.js';
import { KINDS, PF, CF, CAR_TYPES, WEAPONS, PedView, CarView, drawPickup, PICK_COLOR, PICK_KINDS } from './entities.js';

export const INTERP = 0.08;

/* the per-player block the host packs in sim.js (`block`) */
export const parseBlock = b => ({ pedId: b[0], health: b[1], wanted: b[2], cash: b[3], kills: b[4], curW: b[5], ammo: b[6], reserve: b[7], reloadT: b[8], dead: !!b[9], wastedT: b[10], carId: b[11], hint: b[12], camPitch: b[13], god: !!b[14], gone: !!b[15], ack: b[16] | 0,
  killer: b[17] === undefined ? -1 : b[17], cause: b[18] | 0, markT: b[19] || 0, owned: b[20] === undefined ? 7 : b[20], seat: b[21] | 0,
  lap: b[22] | 0, next: b[23] === undefined ? 1 : b[23], rank: b[24] | 0, place: b[25] | 0, // the race: laps done, the checkpoint I head for, my standing, my finishing place (0 = still racing)
  job: b[26] ? { kind: b[26], stage: b[27] | 0, x: b[28], z: b[29], t: b[30] || 0, n: b[31] | 0 } : null }); // job (last, it is variable): the taxi fare / ambulance patient I am on (JOB_KINDS, JOB_STAGES, the target, seconds left, the streak)
/* the shared mode state the host packs (`modeState`): { mode index, the mark's player index, seconds held, the world event or null, the race or null } */
export const parseMode = m => m ? { mode: m[0] | 0, mark: m[1], markT: m[2] || 0, we: m[3] ? { kind: m[3][0], x: m[3][1], z: m[3][2], t: m[3][3], landed: !!m[3][4] } : null,
  race: m[4] ? { state: m[4][0] | 0, t: m[4][1] || 0, finishers: m[4][2] | 0 } : null } : { mode: 0, mark: -1, markT: 0, we: null, race: null };

export function createRemote({ W }) {
  const ents = new Map();
  const R = { ents, P: [], clock: 9.4, timeLeft: -1, phase: 0, ms: 0, vin: null, md: parseMode(null), got: false };
  function drop(e) { if (e.cls === 'pick') W.pickPool.release(e.i); else e.view.release(); ents.delete(e.id); }
  function apply(m) {
    const now = nowSec();
    for (const id of m.rm || []) { const e = ents.get(id); if (e) drop(e); }
    for (const a of m.p || []) {
      let e = ents.get(a[0]);
      if (!e) { const kind = KINDS[a[1]] || 'civ'; e = { id: a[0], cls: 'ped', kind, style: a[2], view: new PedView(W, kind, a[2]), buf: [], x: a[3], y: a[7] !== undefined ? a[7] : groundY(a[3], a[4]), z: a[4], yaw: a[5], dead: false, deadT: 0, moving: 0, hitT: 0, armRaise: 0, inCar: false, down: false, camPitch: 0, gun: null }; ents.set(e.id, e); }
      pushSnap(e.buf, { x: a[3], z: a[4], yaw: a[5], f: a[6], y: a[7] }, now);
    }
    for (const a of m.v || []) {
      let e = ents.get(a[0]);
      if (!e) { const type = CAR_TYPES[a[1]] || CAR_TYPES[0]; e = { id: a[0], cls: 'car', type, view: new CarView(W, type, a[2], a[3]), buf: [], x: a[4], y: groundY(a[4], a[5]), z: a[5], yaw: a[6], steer: 0, vF: 0, speed: 0, dead: false, smoking: false, burn: false, lights: false }; ents.set(e.id, e); }
      else if (e.view.color !== a[2] || e.view.cabin !== a[3]) e.view.recolor(a[2], a[3]); // resprayed
      pushSnap(e.buf, { x: a[4], z: a[5], yaw: a[6], steer: a[7], vF: a[8], f: a[9] }, now);
    }
    for (const a of m.k || []) {
      if (ents.has(a[0])) continue;
      const i = W.pickPool.alloc(); if (i < 0) continue; const kind = PICK_KINDS[a[1]] || 'cash'; W.pickPool.color(i, PICK_COLOR(kind));
      ents.set(a[0], { id: a[0], cls: 'pick', i, kind, x: a[2], z: a[3], t: Math.random() * 6 });
    }
    if (m.P) R.P = m.P.map(parseBlock);
    if (m.c !== undefined) R.clock = m.c; if (m.tl !== undefined) R.timeLeft = m.tl; if (m.ph !== undefined) R.phase = m.ph; if (m.ms !== undefined) R.ms = m.ms; if (m.vin !== undefined) R.vin = m.vin; if (m.md !== undefined) R.md = parseMode(m.md);
    R.got = true;
    return m.ev || [];
  }
  /* `local`, when given, is the predictor's view of my own body: { pedId, ped: { x, y, z, yaw, moving }, carId, car: { x, y, z, yaw, steer, vF } } */
  function update(dt, t, myIdx, localCamPitch, local) {
    const rt = nowSec() - INTERP;
    R.P.forEach((P, i) => { const e = ents.get(P.pedId); if (!e) return; e.camPitch = i === myIdx ? localCamPitch : P.camPitch; e.gun = P.carId < 0 && !P.dead ? WEAPONS[P.curW].key : null; e.seat = P.seat; e.inCar = P.carId >= 0 ? ents.get(P.carId) || true : false; });
    for (const e of ents.values()) {
      if (e.cls === 'pick') { e.t += dt; drawPickup(W, e.i, e.x, e.z, e.t); continue; }
      const smp = sampleSnaps(e.buf, rt); if (!smp) continue; const { a, b, f } = smp;
      const mine = local && (e.id === local.pedId ? local.ped : e.id === local.carId ? local.car : null);
      if (mine) { e.x = mine.x; e.z = mine.z; e.yaw = mine.yaw; }
      else if (b) { e.x = lerp(a.x, b.x, f); e.z = lerp(a.z, b.z, f); e.yaw = a.yaw + angDiff(b.yaw, a.yaw) * f; } else { e.x = a.x; e.z = a.z; e.yaw = a.yaw; }
      const s = b && f > 0.5 ? b : a, fl = s.f;
      if (e.cls === 'ped') {
        e.y = mine ? mine.y : a.y !== undefined ? (b && b.y !== undefined ? lerp(a.y, b.y, f) : a.y) : groundY(e.x, e.z);
        const dead = !!(fl & PF.DEAD); if (dead && !e.dead) e.deadT = (fl & PF.OLDDEAD) ? 5 : 0; e.dead = dead; if (dead) e.deadT += dt;
        if (!(fl & PF.INCAR)) e.inCar = false; else if (!e.inCar) e.inCar = true; e.ride = !!(fl & PF.RIDE); e.down = !!(fl & PF.DOWN); // a player's inCar is its car (set above, the saddle pose needs the type); anyone else's is just a flag e.moving = mine ? mine.moving : (fl & PF.RUN) ? 5 : (fl & PF.WALK) ? 1.5 : 0; e.armRaise = lerp(e.armRaise, (fl & PF.ARM) ? 1 : 0, Math.min(1, 8 * dt)); e.hitT = (fl & PF.HIT) ? 0.25 : 0;
        e.view.draw(e, dt);
      } else {
        if (mine) { e.steer = mine.steer; e.vF = mine.vF; } else { e.steer = b ? lerp(a.steer, b.steer, f) : a.steer; e.vF = b ? lerp(a.vF, b.vF, f) : a.vF; } e.speed = Math.abs(e.vF);
        e.y = lerp(e.y, groundY(e.x, e.z), Math.min(1, 12 * dt));
        e.dead = !!(fl & CF.DEAD); e.smoking = !!(fl & CF.SMOKE); e.burn = !!(fl & CF.BURN); e.lights = !!(fl & CF.LIGHTS);
        e.view.draw(e, dt, t);
      }
    }
    W.dirtyDynamic(); W.pickPool.dirty();
  }
  function clear() { for (const e of [...ents.values()]) drop(e); R.P = []; R.got = false; W.dirtyDynamic(); W.pickPool.dirty(); }
  return { R, ents, apply, update, clear, get: id => ents.get(id) };
}
