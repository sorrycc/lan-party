/* Client-side prediction of my own body. The host stays authoritative, but waiting for its snapshot before my
   character reacts costs a round trip plus the interpolation delay, so the client runs the same movement code
   (motion.js) on its own input every frame and shows that. Every input carries a sequence number; the host
   reports the last one it applied (`ack`) and its resulting position, the predictor compares that with what it
   had predicted for the same input and shifts its state by the difference. Small differences are hidden with a
   visual offset that decays over a few frames; big ones (a respawn, a car crash the client could not see) snap. */
import { angDiff, groundY } from './world.js';
import { stepOnFoot, driveInput, stepCar } from './motion.js';

export function createPredictor({ W }) {
  const ped = { cls: 'ped', x: 0, y: 0, z: 0, yaw: 0, vy: 0, moving: 0, jumpLatch: false, r: 0.42, stuck: 0, inCar: null };
  const vis = { x: 0, z: 0, yaw: 0 };   // rendering offset that hides corrections
  const view = { pedId: -1, ped: { x: 0, y: 0, z: 0, yaw: 0, moving: 0 }, carId: -1, car: null };
  let car = null, carId = -1, pedId = -1, seq = 0, synced = false, lag = 0, corrections = 0;
  const hist = [];
  const snapPed = e => { ped.x = e.x; ped.y = e.y; ped.z = e.z; ped.yaw = e.yaw; ped.vy = 0; vis.x = vis.z = vis.yaw = 0; hist.length = 0; };
  function attachCar(e) {
    const T = e.type, r = T.w / 2 + 0.12;
    car = { cls: 'car', type: T, x: e.x, y: e.y, z: e.z, yaw: e.yaw, vx: Math.sin(e.yaw) * e.vF, vz: Math.cos(e.yaw) * e.vF, angVel: 0, steer: e.steer || 0, throttle: 0, hand: false, vF: e.vF, speed: Math.abs(e.vF),
      fx: Math.sin(e.yaw), fz: Math.cos(e.yaw), rx: -Math.cos(e.yaw), rz: Math.sin(e.yaw), dead: false, r, off: T.l / 2 - r, mass: T.mass, released: false };
    ped.inCar = car; vis.x = vis.z = vis.yaw = 0; hist.length = 0;
  }
  const otherCars = remote => { const out = []; for (const e of remote.ents.values()) if (e.cls === 'car' && e.id !== carId) out.push(e); return out; };

  /* one local frame; returns the sequence number to stamp on this frame's input, or 0 when not predicting */
  function step(bits, camYaw, aiming, dt, me, remote, now) {
    if (!me || me.pedId < 0) return 0;
    const pe = remote.get(me.pedId);
    if (me.pedId !== pedId) { pedId = me.pedId; synced = false; car = null; carId = -1; }
    if (me.dead) { synced = false; car = null; carId = -1; ped.inCar = null; return 0; }
    if (!synced) { if (!pe) return 0; snapPed(pe); synced = true; }
    if (me.carId !== carId) { carId = me.carId; if (carId >= 0) { const ce = remote.get(carId); if (!ce) { carId = -1; return 0; } attachCar(ce); } else { car = null; ped.inCar = null; if (pe) snapPed(pe); } }
    seq++;
    if (car) { driveInput(car, bits, dt); stepCar(W, car, dt, null); ped.x = car.x; ped.z = car.z; ped.y = car.y; ped.yaw = car.yaw; ped.moving = 0; }
    else stepOnFoot(W, ped, bits, camYaw, aiming, dt, otherCars(remote));
    hist.push({ q: seq, sentAt: now, x: ped.x, z: ped.z, yaw: ped.yaw, car: car ? { x: car.x, z: car.z, yaw: car.yaw, vF: car.vF } : null });
    if (hist.length > 240) hist.shift();
    const k = Math.min(1, 12 * dt); vis.x -= vis.x * k; vis.z -= vis.z * k; vis.yaw -= vis.yaw * k;
    return seq;
  }
  /* a snapshot arrived: compare the host's state for the acknowledged input with what was predicted for it */
  function reconcile(msg, me, now) {
    if (!synced || !me || me.dead || !(me.ack > 0)) return;
    let hi = -1; for (let i = hist.length - 1; i >= 0; i--) if (hist[i].q <= me.ack) { hi = i; break; }
    if (hi < 0) return;
    const h = hist[hi]; lag = now - h.sentAt;
    if (car) {
      const a = (msg.v || []).find(v => v[0] === carId); if (!a || !h.car) { hist.splice(0, hi); return; }
      const ex = a[4] - h.car.x, ez = a[5] - h.car.z, eyaw = angDiff(a[6], h.car.yaw), evF = a[8] - h.car.vF;
      if (ex * ex + ez * ez > 36 || Math.abs(eyaw) > 1.2) { car.x = a[4]; car.z = a[5]; car.yaw = a[6]; car.vF = a[8]; car.steer = a[7]; car.vx = Math.sin(car.yaw) * car.vF; car.vz = Math.cos(car.yaw) * car.vF; car.angVel = 0; vis.x = vis.z = vis.yaw = 0; hist.length = 0; corrections++; return; }
      if (Math.abs(ex) + Math.abs(ez) + Math.abs(eyaw) + Math.abs(evF) < 1e-3) { hist.splice(0, hi); return; }
      car.x += ex; car.z += ez; car.yaw += eyaw; vis.x -= ex; vis.z -= ez; vis.yaw -= eyaw;
      car.vx += Math.sin(car.yaw) * evF * 0.5; car.vz += Math.cos(car.yaw) * evF * 0.5;
      for (const e of hist) if (e.car) { e.car.x += ex; e.car.z += ez; e.car.yaw += eyaw; }
    } else {
      const a = (msg.p || []).find(p => p[0] === pedId); if (!a) { hist.splice(0, hi); return; }
      const ex = a[3] - h.x, ez = a[4] - h.z;
      if (ex * ex + ez * ez > 16) { ped.x = a[3]; ped.z = a[4]; ped.y = a[7] !== undefined ? a[7] : groundY(ped.x, ped.z); ped.vy = 0; vis.x = vis.z = 0; hist.length = 0; corrections++; return; }
      if (Math.abs(ex) + Math.abs(ez) < 1e-3) { hist.splice(0, hi); return; }
      ped.x += ex; ped.z += ez; vis.x -= ex; vis.z -= ez;
      for (const e of hist) { e.x += ex; e.z += ez; }
    }
    hist.splice(0, hi);
  }
  /* what remote.update should draw for my body this frame (null while the host is in charge) */
  function local() {
    if (!synced) return null;
    view.pedId = pedId; view.ped.x = ped.x + vis.x; view.ped.z = ped.z + vis.z; view.ped.y = ped.y; view.ped.yaw = ped.yaw + vis.yaw; view.ped.moving = ped.moving;
    view.carId = car ? carId : -1;
    if (car) { const c = view.car || (view.car = {}); c.x = car.x + vis.x; c.z = car.z + vis.z; c.y = car.y; c.yaw = car.yaw + vis.yaw; c.steer = car.steer; c.vF = car.vF; c.speed = car.speed; } else view.car = null;
    return view;
  }
  function reset() { synced = false; car = null; carId = -1; pedId = -1; seq = 0; hist.length = 0; vis.x = vis.z = vis.yaw = 0; lag = 0; corrections = 0; }
  return { step, reconcile, local, reset, get lag() { return lag; }, get synced() { return synced; }, get corrections() { return corrections; }, get seq() { return seq; } };
}
