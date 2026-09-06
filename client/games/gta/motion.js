/* Movement shared by the host's simulation and a client's prediction of its own player: how a pedestrian walks
   from input bits, how a car answers the pedals and rolls, and how both stay out of buildings. Pure functions
   over plain state objects, so the same code moves the authoritative body on the host and the predicted copy
   on the client.
   Input is the key bits plus an optional analog pair `sx` / `sz` (-1..1: strafe right, forward) from a touch
   thumb stick. The bits win when any direction key is down; otherwise the stick sets the direction and, on
   foot, how fast to walk. */
import { clamp, lerp } from '../../core/math.js';
import { angDiff, groundY, inCity, HALF, BEACH_Z1 } from './world.js';

export const IN = { UP: 1, DOWN: 2, LEFT: 4, RIGHT: 8, SPRINT: 16, SPACE: 32, FIRE: 64 };

/* keep a pedestrian { x, z, r, stuck } out of the world's boxes; bumps `stuck` when it had to push */
export function pedCollideWorld(W, p) {
  const list = W.nearAabbs(p.x, p.z), r = p.r;
  for (let k = 0; k < list.length; k++) { const b = list[k];
    const nx = clamp(p.x, b.x0, b.x1), nz = clamp(p.z, b.z0, b.z1); let dx = p.x - nx, dz = p.z - nz; const d2 = dx * dx + dz * dz;
    if (d2 < r * r) { if (d2 < 1e-6) { const px = Math.min(p.x - b.x0, b.x1 - p.x), pz = Math.min(p.z - b.z0, b.z1 - p.z);
        if (px < pz) p.x += (p.x - b.x0 < b.x1 - p.x) ? -(px + r) : (px + r); else p.z += (p.z - b.z0 < b.z1 - p.z) ? -(pz + r) : (pz + r); }
      else { const d = Math.sqrt(d2); p.x += dx / d * (r - d); p.z += dz / d * (r - d); } p.stuck += 1; }
  }
  if (p.z > BEACH_Z1 - 2) p.z = BEACH_Z1 - 2;
  p.x = clamp(p.x, -HALF - 120, HALF + 120); p.z = Math.max(p.z, -HALF - 120);
}

/* push a pedestrian out of every car in `cars` (anything with x, z, yaw, type, speed); returns true if it did */
export function pushOutOfCars(e, r, isPlayer, cars) {
  let pushed = false;
  for (const c of cars) { if (c.cls !== 'car' || c.released || c === e.inCar) continue; const dx = e.x - c.x, dz = e.z - c.z; if (dx * dx + dz * dz > 30) continue;
    const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw), rx = -fz, rz = fx;
    const lx = dx * rx + dz * rz, lz = dx * fx + dz * fz, hw = c.type.w / 2 + r, hl = c.type.l / 2 + r;
    if (Math.abs(lx) < hw && Math.abs(lz) < hl) { const px = hw - Math.abs(lx), pz = hl - Math.abs(lz); pushed = true;
      // the player is pushed out the short way; peds slide along the car's length so a crossing ped walks around it
      if (px < pz && (isPlayer || c.speed > 1)) { const s = lx > 0 ? px : -px; e.x += rx * s; e.z += rz * s; }
      else { const step = isPlayer ? pz : Math.min(pz, 0.08); const s = lz > 0 ? step : -step; e.x += fx * s; e.z += fz * s; if (!isPlayer && px < pz) { const s2 = lx > 0 ? px * 0.5 : -px * 0.5; e.x += rx * s2; e.z += rz * s2; } } } }
  return pushed;
}

/* one frame of a player's on-foot movement: p = { x, y, z, yaw, vy, moving, jumpLatch, r, stuck, inCar } */
export function stepOnFoot(W, p, bits, camYaw, aiming, dt, cars, sx = 0, sz = 0) {
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw), rx = -fz, rz = fx;
  let mx = ((bits & IN.RIGHT) ? 1 : 0) - ((bits & IN.LEFT) ? 1 : 0), mz = ((bits & IN.UP) ? 1 : 0) - ((bits & IN.DOWN) ? 1 : 0);
  if (!mx && !mz) { mx = clamp(sx, -1, 1); mz = clamp(sz, -1, 1); }
  const ground = groundY(p.x, p.z);
  if (mx || mz) { const l = Math.hypot(mx, mz); mx /= l; mz /= l; const speed = ((bits & IN.SPRINT) && !aiming ? 7.6 : 4.6) * Math.min(1, l); // a half-pushed stick is a stroll
    const dx = fx * mz + rx * mx, dz = fz * mz + rz * mx; p.x += dx * speed * dt; p.z += dz * speed * dt; p.moving = speed;
    const ty = aiming ? camYaw : Math.atan2(dx, dz); p.yaw += angDiff(ty, p.yaw) * Math.min(1, 14 * dt); }
  else { p.moving = 0; if (aiming) p.yaw += angDiff(camYaw, p.yaw) * Math.min(1, 14 * dt); }
  if ((bits & IN.SPACE) && p.y <= ground + 0.02 && !p.jumpLatch) { p.vy = 5.5; p.jumpLatch = true; }
  if (!(bits & IN.SPACE)) p.jumpLatch = false;
  p.vy -= 16 * dt; p.y += p.vy * dt; if (p.y <= ground) { p.y = ground; p.vy = 0; }
  pedCollideWorld(W, p); pushOutOfCars(p, 0.35, true, cars);
}

/* pedals and wheel from input bits (the steering is eased) or the stick (forward is gas, back is brake then
   reverse, sideways steers; the wheel follows the thumb almost at once) */
export function driveInput(c, bits, dt, sx = 0, sz = 0) {
  c.throttle = (bits & IN.UP) ? 1 : (bits & IN.DOWN) ? -1 : clamp(sz, -1, 1);
  const st = ((bits & IN.LEFT) ? 1 : 0) - ((bits & IN.RIGHT) ? 1 : 0);
  if (st) c.steer = lerp(c.steer, st, Math.min(1, 5 * dt));
  else if (sx) c.steer = lerp(c.steer, clamp(-sx, -1, 1), Math.min(1, 14 * dt));
  else c.steer = lerp(c.steer, 0, Math.min(1, 8 * dt));
  c.hand = !!(bits & IN.SPACE);
}

/* a car's kinematics for one frame plus its collision with the world; crashes with the world are pushed into
   `crashes` as { x, z, imp } when given. Returns whether the car was off the road when the frame began. */
export function stepCar(W, c, dt, crashes) {
  const T = c.type;
  const fx = Math.sin(c.yaw), fz = Math.cos(c.yaw), rx = -fz, rz = fx;
  let vF = c.vx * fx + c.vz * fz, vR = c.vx * rx + c.vz * rz;
  if (!c.dead) {
    if (c.throttle > 0) { if (vF < T.max) vF += T.acc * c.throttle * dt; }
    else if (c.throttle < 0) { if (vF > 0.3) vF -= T.brake * dt; else if (vF > -T.max * 0.33) vF -= T.acc * 0.55 * dt; }
  }
  vF -= vF * 0.4 * dt + Math.sign(vF) * vF * vF * 0.0035 * dt;
  if (c.hand || c.dead) vF -= Math.sign(vF) * Math.min(Math.abs(vF), (c.dead ? 3 : 8) * dt);
  const offroad = groundY(c.x, c.z) > 0.1 && inCity(c.x, c.z);
  const grip = c.hand ? 1.3 : offroad ? 5 : 9;
  vR *= Math.exp(-grip * dt);
  const steerEff = c.steer * clamp(Math.abs(vF) / 6, 0, 1) * (c.hand ? 1.6 : 1) * (1 - clamp((Math.abs(vF) - 16) / 45, 0, 0.5));
  c.yaw += steerEff * 2.4 * dt * (vF < 0 ? -1 : 1) + c.angVel * dt;
  c.angVel *= Math.exp(-3.5 * dt);
  c.vx = fx * vF + rx * vR; c.vz = fz * vF + rz * vR;
  c.x += c.vx * dt; c.z += c.vz * dt;
  c.vF = vF; c.speed = Math.abs(vF);
  c.fx = Math.sin(c.yaw); c.fz = Math.cos(c.yaw); c.rx = -c.fz; c.rz = c.fx;
  carCollideWorld(W, c, crashes);
  c.y = lerp(c.y, groundY(c.x, c.z), Math.min(1, 12 * dt));
  return offroad;
}
export function carCollideWorld(W, c, crashes) {
  const list = W.nearAabbs(c.x, c.z), r = c.r;
  for (const s of [-1, 1]) {
    const cx = c.x + c.fx * c.off * s, cz = c.z + c.fz * c.off * s;
    for (let k = 0; k < list.length; k++) { const b = list[k]; if (b.h < 0.6) continue;
      const nx = clamp(cx, b.x0, b.x1), nz = clamp(cz, b.z0, b.z1); let dx = cx - nx, dz = cz - nz; const d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue;
      let d = Math.sqrt(d2);
      if (d < 1e-4) { const px = Math.min(cx - b.x0, b.x1 - cx), pz = Math.min(cz - b.z0, b.z1 - cz);
        if (px < pz) { dx = (cx - b.x0 < b.x1 - cx) ? -1 : 1; dz = 0; d = -px; } else { dz = (cz - b.z0 < b.z1 - cz) ? -1 : 1; dx = 0; d = -pz; } }
      else { dx /= d; dz /= d; }
      const pen = r - d; c.x += dx * pen; c.z += dz * pen;
      const vn = c.vx * dx + c.vz * dz;
      if (vn < 0) { const imp = -vn; c.vx -= dx * vn * 1.25; c.vz -= dz * vn * 1.25; c.vx *= 0.9; c.vz *= 0.9;
        const rxv = c.fx * c.off * s, rzv = c.fz * c.off * s; c.angVel += (rzv * dx * imp - rxv * dz * imp) * 0.35 / c.mass;
        if (imp > 3 && crashes) crashes.push({ x: nx, z: nz, imp }); }
    }
  }
  // beach / bounds
  if (c.z > BEACH_Z1 - 3) { c.z = BEACH_Z1 - 3; if (c.vz > 0) c.vz *= -0.3; }
  const lim = HALF + 100; if (c.x < -lim) { c.x = -lim; c.vx = Math.abs(c.vx) * 0.3; } if (c.x > lim) { c.x = lim; c.vx = -Math.abs(c.vx) * 0.3; } if (c.z < -lim) { c.z = -lim; c.vz = Math.abs(c.vz) * 0.3; }
}
