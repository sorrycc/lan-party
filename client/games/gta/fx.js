/* Cosmetic effects that every machine spawns for itself from events: particles, ground decals, bullet tracers. */
import { PI } from './world.js';
import { groundY } from './world.js';

const rr = (a, b) => a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];

export function createFx({ W }) {
  const THREE = W.THREE, M = new THREE.Matrix4(), M2 = new THREE.Matrix4(), V3 = new THREE.Vector3(), Q = new THREE.Quaternion(), Zaxis = new THREE.Vector3(0, 0, 1), P3 = new THREE.Vector3(), S3 = new THREE.Vector3();
  const dummy = new THREE.Object3D();
  const particles = [], tracers = [], decalOrder = [];

  function spawnParticle(x, y, z, vx, vy, vz, color, size, life, smoke = false) {
    const i = W.partPool.alloc(); if (i < 0) return;
    W.partPool.color(i, color); particles.push({ i, x, y, z, vx, vy, vz, size, life, maxLife: life, smoke });
  }
  function updateParticles(dt) {
    for (let k = particles.length - 1; k >= 0; k--) { const p = particles[k]; p.life -= dt;
      if (p.life <= 0) { W.partPool.release(p.i); particles[k] = particles[particles.length - 1]; particles.pop(); continue; }
      if (p.smoke) { p.vy += 1.5 * dt; p.vx *= 0.98; p.vz *= 0.98; } else p.vy -= 14 * dt;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      if (p.y < 0.05 && !p.smoke) { p.y = 0.05; p.vx *= 0.5; p.vz *= 0.5; p.vy = 0; }
      const f = p.life / p.maxLife, s = p.size * (p.smoke ? 1 + (1 - f) * 2.5 : Math.min(1, f * 3));
      M.makeTranslation(p.x, p.y, p.z); M.multiply(M2.makeRotationY(p.life * 3)); M.multiply(M2.makeScale(s, s, s)); W.partPool.set(p.i, M); }
    W.partPool.dirty();
  }
  function decalBox(x, z, sx, sz, ry, color) {
    let i = W.decalPool.alloc(); if (i < 0) i = decalOrder.shift(); decalOrder.push(i);
    dummy.position.set(x, groundY(x, z) + 0.03, z); dummy.rotation.set(-PI / 2, 0, ry, 'YXZ'); dummy.scale.set(sx, sz, 1); dummy.updateMatrix();
    W.decalPool.set(i, dummy.matrix); W.decalPool.color(i, color); W.decalPool.dirty();
  }
  function bloodSplat(x, z, size, yaw) {
    const c = pick([0x7a0a0a, 0x8f1010, 0x6a0808]);
    if (yaw !== undefined) { decalBox(x, z, 1.4 * size * 0.6, rr(4, 7), yaw, c); decalBox(x + rr(-1, 1), z + rr(-1, 1), 1.2, 1.2, rr(0, PI), c); }
    decalBox(x, z, rr(1.2, 2) * size, rr(1.2, 2) * size, rr(0, PI), c);
    for (let k = 0; k < 3; k++) decalBox(x + rr(-1.2, 1.2), z + rr(-1.2, 1.2), rr(0.3, 0.7), rr(0.3, 0.7), rr(0, PI), c);
  }
  function addTracer(ax, ay, az, bx, by, bz) {
    const i = W.bulletPool.alloc(); if (i < 0) return;
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz) || 0.01;
    V3.set(dx / len, dy / len, dz / len); Q.setFromUnitVectors(Zaxis, V3);
    M.compose(P3.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2), Q, S3.set(0.05, 0.05, len));
    W.bulletPool.set(i, M); W.bulletPool.color(i, 0xfff0a0); W.bulletPool.dirty(); tracers.push({ i, life: 0.06 });
  }
  function updateTracers(dt) { for (let k = tracers.length - 1; k >= 0; k--) { const t = tracers[k]; t.life -= dt; if (t.life <= 0) { W.bulletPool.release(t.i); tracers.splice(k, 1); } } }
  /* the burst effects the game uses, so callers stay one-liners */
  const burst = {
    blood: (x, y, z, dx = 0, dz = 0) => { for (let q = 0; q < 4; q++) spawnParticle(x, y, z, rr(-2, 2) + dx * 2, rr(0, 3), rr(-2, 2) + dz * 2, 0x9a0a0a, 0.14, rr(0.3, 0.7)); },
    sparks: (x, y, z, n = 4) => { for (let q = 0; q < n; q++) spawnParticle(x, y, z, rr(-3, 3), rr(1, 4), rr(-3, 3), 0xffd070, 0.1, 0.35); },
    dust: (x, y, z) => { for (let q = 0; q < 3; q++) spawnParticle(x, y, z, rr(-2, 2), rr(0.5, 3), rr(-2, 2), 0xbbbbbb, 0.12, 0.35); },
    death: (x, y, z) => { for (let k = 0; k < 8; k++) spawnParticle(x, y + 1, z, rr(-2, 2), rr(1, 4), rr(-2, 2), 0x9a0a0a, 0.18, rr(0.4, 0.9)); },
    explosion: (x, y, z) => { for (let k = 0; k < 70; k++) spawnParticle(x, y, z, rr(-9, 9), rr(2, 14), rr(-9, 9), k % 3 ? pick([0xff8a20, 0xffc020, 0xff4010]) : 0x222222, rr(0.3, 0.9), rr(0.6, 1.6)); },
    crash: (x, y, z, n = 6) => { for (let q = 0; q < n; q++) spawnParticle(x, y, z, rr(-4, 4), rr(1, 5), rr(-4, 4), 0xffd070, 0.12, 0.4); },
    flash: (x, y, z, size = 0.45) => spawnParticle(x, y, z, 0, 0, 0, 0xfff0a0, size, 0.05),
  };
  function update(dt) { updateParticles(dt); updateTracers(dt); }
  function reset() {
    for (const p of particles) W.partPool.release(p.i); particles.length = 0;
    for (const t of tracers) W.bulletPool.release(t.i); tracers.length = 0;
    decalOrder.length = 0; W.decalPool.clear(); W.partPool.dirty(); W.bulletPool.dirty();
  }
  return { spawnParticle, decalBox, bloodSplat, addTracer, burst, update, reset };
}
