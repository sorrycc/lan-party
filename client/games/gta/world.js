/* Los Pixeles: the procedurally generated voxel city, its collision boxes, the static instanced pools and the
   dynamic pools that pedestrians, cars and effects draw into. Generation is seeded, so every machine in a room
   builds the identical city and only moving things ever travel over the network.

   Module level holds pure layout constants and helpers (safe to import anywhere, nothing is created on import);
   `buildWorld({ THREE, scene })` does the heavy lifting once per game instance. */
import { clamp, lerp, makeRng } from '../../core/math.js';
import { FONT } from './font.js';
import { makeT } from '../../core/i18n.js';
import { STR } from './strings.js';

export const PI = Math.PI, TAU = PI * 2;
export const dist2 = (ax, az, bx, bz) => (ax - bx) * (ax - bx) + (az - bz) * (az - bz);
export const angDiff = (a, b) => { let d = (a - b) % TAU; if (d > PI) d -= TAU; if (d < -PI) d += TAU; return d; };

/* ---------------------------------------------------------------- layout */
export const BLOCK = 40, ROAD = 14, PITCH = BLOCK + ROAD, NB = 12, HALF = NB * PITCH / 2, SW = 3.5, LANE = 2.4, PARK = 5.4;
export const X = k => (k - NB / 2) * PITCH;          // road centre line k (0..NB)
export const cellOf = v => Math.floor((v + HALF) / PITCH);
export const inCity = (x, z) => x > -HALF - ROAD / 2 && x < HALF + ROAD / 2 && z > -HALF - ROAD / 2 && z < HALF + ROAD / 2;
export const BEACH_Z0 = HALF + ROAD / 2, BEACH_Z1 = HALF + 62, WATER_Y = -0.45;
export function groundY(x, z) {
  if (!inCity(x, z)) return 0;
  const u = (x + HALF) % PITCH, v = (z + HALF) % PITCH;
  return (u > ROAD / 2 && u < PITCH - ROAD / 2 && v > ROAD / 2 && v < PITCH - ROAD / 2) ? 0.2 : 0;
}
const AVENUES = ['Notch Ave', 'Mojang Blvd', 'Creeper St', 'Ender Ave', 'Obsidian Way', 'Redstone Rd', 'Diamond Ave', 'Emerald Blvd', 'Nether Ave', 'Cobble St', 'Spruce Ave', 'Bedrock Blvd', 'Slime Ln'];
const STREETS = ['Glowstone St', 'Pickaxe St', 'Lava Ln', 'Shulker St', 'Piston Pkwy', 'Quartz St', 'Voxel Blvd', 'Torch St', 'Anvil St', 'Furnace St', 'Lantern St', 'Kelp St', 'Ocean Dr'];
const DISTRICTS = [
  { name: 'CRAFTON HILLS', t: (i, j) => j <= 3 && i <= 5 },
  { name: 'REDSTONE INDUSTRIAL', t: (i, j) => j <= 3 && i >= 6 },
  { name: 'LITTLE CUBO', t: (i, j) => j >= 4 && j <= 8 && i <= 3 },
  { name: 'DOWNTOWN', t: (i, j) => j >= 4 && j <= 8 && i >= 4 && i <= 7 },
  { name: 'PIXEL HEIGHTS', t: (i, j) => j >= 4 && j <= 8 && i >= 8 },
  { name: 'VOXEL BEACH', t: (i, j) => j >= 9 },
];
/* Places travel as numbers and are named on each screen in its own language (strings.js holds the Chinese and English).
   A district is its index in DISTRICTS, then the sea, the boardwalk and the outskirts (6, 7, 8). A street is 0 (a dirt road),
   1 (the boardwalk), 100 + k (avenue k), 200 + k (street k) or 1000 + 100 * avenue + street (a crossing). streetAt / districtAt
   stay the English world data (the building styles, the tests); streetName / districtName are what the HUD says. */
export function districtRef(x, z) {
  if (z > BEACH_Z0 && x > -HALF - 40 && x < HALF + 40) return z > BEACH_Z1 ? 6 : 7;
  if (!inCity(x, z)) return 8;
  const i = clamp(cellOf(x), 0, NB - 1), j = clamp(cellOf(z), 0, NB - 1);
  for (let k = 0; k < DISTRICTS.length; k++) if (DISTRICTS[k].t(i, j)) return k;
  return 3;
}
const DISTRICT_EN = [...DISTRICTS.map(d => d.name), 'PACIFIC OF PIXELS', 'VOXEL BEACH BOARDWALK', 'THE OUTSKIRTS'];
export const districtAt = (x, z) => DISTRICT_EN[districtRef(x, z)];
export function streetRef(x, z) {
  if (!inCity(x, z)) return z > BEACH_Z0 ? 1 : 0;
  const kx = Math.round((x + HALF) / PITCH), kz = Math.round((z + HALF) / PITCH);
  const dx = Math.abs(x - X(kx)), dz = Math.abs(z - X(kz));
  const onA = dx < ROAD / 2 + SW, onS = dz < ROAD / 2 + SW;
  if (onA && onS) return 1000 + kx * 100 + kz;
  if (onA) return 100 + kx;
  if (onS) return 200 + kz;
  return dx < dz ? 100 + kx : 200 + kz;
}
const nameStreet = (ref, av, st, cross, board, dirt) => ref >= 1000 ? cross(av[Math.floor((ref - 1000) / 100)], st[(ref - 1000) % 100]) : ref >= 200 ? st[ref - 200] : ref >= 100 ? av[ref - 100] : ref === 1 ? board : dirt;
export const streetAt = (x, z) => nameStreet(streetRef(x, z), AVENUES, STREETS, (a, b) => a + ' & ' + b, 'Boardwalk', 'Dirt road');
const TW = makeT(STR);
/* a street or a district (from streetRef / districtRef, or off the wire) in the current language */
export const streetName = ref => nameStreet(ref | 0, TW('avenues'), TW('streets'), (a, b) => TW('street.cross', { a, b }), TW('street.boardwalk'), TW('street.dirt')) || '?';
export const districtName = ref => TW('districts')[ref | 0] || '?';
export const SPECIAL = { '6,6': 'plaza', '9,3': 'hospital', '8,5': 'police', '4,4': 'spray', '2,2': 'park', '10,9': 'park', '3,10': 'park', '1,7': 'park' };
export const PLAZA = { x: X(6) + PITCH / 2, z: X(6) + PITCH / 2 };
export const HOSPITAL = { x: X(9) + PITCH / 2, z: X(3) + PITCH - ROAD / 2 - SW / 2 - 0.5 };
export const POLICE = { x: X(8) + PITCH / 2, z: X(5) + PITCH - ROAD / 2 - 2 };
/* the precinct's front door (turn yourself in on foot) and the Pay 'n' Spray bay (drive in and stop); hw/hd are the bay's half extents */
export const POLICE_DOOR = { x: POLICE.x, z: X(5) + PITCH - ROAD / 2 - SW - 7.2 };
export const SPRAY = { x: X(4) + PITCH / 2, z: X(4) + PITCH - ROAD / 2 - SW - 7.5, hw: 4.5, hd: 6.5 };
export const FERRIS = { x: 0, y: 26, z: BEACH_Z0 + 30, r: 22 };
/* the taxi rank: three cabs parked along the plaza's west curb, so a taxi job starts without a carjacking */
export const TAXI_RANK = { x: X(6) + PARK, z: X(6) + 22 };
export const cornerXZ = (i, j, k) => {
  const c = ROAD / 2 + SW / 2;
  return k === 0 ? [X(i) + c, X(j) + c] : k === 1 ? [X(i + 1) - c, X(j) + c] : k === 2 ? [X(i + 1) - c, X(j + 1) - c] : [X(i) + c, X(j + 1) - c];
};
/* road-graph routing for the minimap and traffic */
export const nearestNode = (x, z) => [clamp(Math.round((x + HALF) / PITCH), 0, NB), clamp(Math.round((z + HALF) / PITCH), 0, NB)];
export function bfsRoute(from, to) {
  const N = NB + 1, key = (i, j) => j * N + i, prev = new Int16Array(N * N).fill(-1), q = [key(from[0], from[1])]; prev[q[0]] = q[0];
  while (q.length) { const k = q.shift(); const i = k % N, j = (k - i) / N; if (i === to[0] && j === to[1]) break;
    for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const ni = i + ox, nj = j + oz; if (ni < 0 || ni > NB || nj < 0 || nj > NB) continue; const nk = key(ni, nj); if (prev[nk] >= 0) continue; prev[nk] = k; q.push(nk); } }
  const out = []; let k = key(to[0], to[1]); if (prev[k] < 0) return out;
  while (true) { out.push([k % N, Math.floor(k / N)]); if (prev[k] === k) break; k = prev[k]; }
  return out.reverse();
}

/* ---------------------------------------------------------------- geometry helpers */
export function rayAabb(ox, oy, oz, dx, dy, dz, x0, y0, z0, x1, y1, z1) {
  let t0 = 0, t1 = Infinity;
  for (let a = 0; a < 3; a++) { const o = a === 0 ? ox : a === 1 ? oy : oz, d = a === 0 ? dx : a === 1 ? dy : dz, mn = a === 0 ? x0 : a === 1 ? y0 : z0, mx = a === 0 ? x1 : a === 1 ? y1 : z1;
    if (Math.abs(d) < 1e-9) { if (o < mn || o > mx) return null; } else { let ta = (mn - o) / d, tb = (mx - o) / d; if (ta > tb) { const s = ta; ta = tb; tb = s; } if (ta > t0) t0 = ta; if (tb < t1) t1 = tb; if (t0 > t1) return null; } }
  return t0;
}
export function raySphere(ox, oy, oz, dx, dy, dz, cx, cy, cz, r) {
  const lx = cx - ox, ly = cy - oy, lz = cz - oz; const tca = lx * dx + ly * dy + lz * dz; if (tca < 0) return null;
  const d2 = lx * lx + ly * ly + lz * lz - tca * tca; if (d2 > r * r) return null; return tca - Math.sqrt(r * r - d2);
}
export const segment2dHitsAabbs = (ax, az, bx, bz, list, minH = 1.5) => {
  const dx = bx - ax, dz = bz - az;
  for (let k = 0; k < list.length; k++) { const b = list[k]; if (b.h < minH) continue;
    let t0 = 0, t1 = 1;
    if (Math.abs(dx) < 1e-9) { if (ax < b.x0 || ax > b.x1) continue; } else { let ta = (b.x0 - ax) / dx, tb = (b.x1 - ax) / dx; if (ta > tb) [ta, tb] = [tb, ta]; t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) continue; }
    if (Math.abs(dz) < 1e-9) { if (az < b.z0 || az > b.z1) continue; } else { let ta = (b.z0 - az) / dz, tb = (b.z1 - az) / dz; if (ta > tb) [ta, tb] = [tb, ta]; t0 = Math.max(t0, ta); t1 = Math.min(t1, tb); if (t0 > t1) continue; }
    return true;
  }
  return false;
};

/* Third-person camera for a subject { x, y, z, inCar: { x, y, z, speed } | null, dead }. Used by every machine to
   render its own view and by the host to build the aiming ray of each player. Writes { x, y, z, dx, dy, dz, lx, ly, lz }. */
export function computeCamera(W, s, camYaw, camPitch, out) {
  let tx, ty, tz, dist, shoulder = 0.65;
  if (s.inCar) { const c = s.inCar; tx = c.x; ty = c.y + 1.4; tz = c.z; dist = 8.5 + c.speed * 0.07; shoulder = 0; }
  else { tx = s.x; ty = s.y + 1.55; tz = s.z; dist = 4.2; }
  const fx = Math.sin(camYaw), fz = Math.cos(camYaw), rx = -fz, rz = fx, cp = Math.cos(camPitch), sp = Math.sin(camPitch);
  tx += rx * shoulder; tz += rz * shoulder;
  const dx = -fx * cp, dy = sp, dz = -fz * cp; const list = W.nearAabbs(tx, tz);
  for (let k = 0; k < list.length; k++) { const b = list[k]; if (b.h < 1) continue; const h = rayAabb(tx, ty, tz, dx, dy, dz, b.x0 - 0.7, -1, b.z0 - 0.7, b.x1 + 0.7, b.h + 0.5, b.z1 + 0.7); if (h !== null && h < dist) dist = Math.max(0.8, h - 0.15); }
  out.x = tx + dx * dist; out.y = Math.max(0.5, ty + dy * dist + 0.2); out.z = tz + dz * dist;
  out.lx = out.x + fx * cp; out.ly = out.y - sp; out.lz = out.z + fz * cp;
  const l = Math.hypot(out.lx - out.x, out.ly - out.y, out.lz - out.z) || 1;
  out.dx = (out.lx - out.x) / l; out.dy = (out.ly - out.y) / l; out.dz = (out.lz - out.z) / l;
  return out;
}

/* minimap scale + offset shared by the map image and the HUD that draws on it */
export const MAP = { MS: 1.5, MOFF: HALF + 220 };

/* ---------------------------------------------------------------- instanced pools */
export class Pool {
  constructor(THREE, scene, geom, mat, cap, shadow = true, receive = true) {
    this.THREE = THREE; this.mesh = new THREE.InstancedMesh(geom, mat, cap);
    this.cap = cap; this.n = 0; this.free = []; this.overflow = 0;
    this.zero = new THREE.Matrix4().makeScale(0, 0, 0); this.dummy = new THREE.Object3D(); this.tmpColor = new THREE.Color();
    this.mesh.frustumCulled = false; this.mesh.castShadow = shadow; this.mesh.receiveShadow = receive;
    const white = new THREE.Color(1, 1, 1);
    for (let i = 0; i < cap; i++) { this.mesh.setMatrixAt(i, this.zero); this.mesh.setColorAt(i, white); }
    scene.add(this.mesh);
  }
  alloc() { if (this.free.length) return this.free.pop(); if (this.n < this.cap) return this.n++; return -1; }
  release(i) { if (i < 0) return; this.mesh.setMatrixAt(i, this.zero); this.free.push(i); this.dirty(); }
  set(i, m) { if (i >= 0) this.mesh.setMatrixAt(i, m); }
  hide(i) { if (i >= 0) this.mesh.setMatrixAt(i, this.zero); }
  color(i, c) { if (i < 0) return; this.mesh.setColorAt(i, typeof c === 'number' ? this.tmpColor.set(c) : c); this.mesh.instanceColor.needsUpdate = true; }
  dirty() { this.mesh.instanceMatrix.needsUpdate = true; }
  finish() { this.mesh.count = this.n; this.dirty(); this.mesh.instanceColor.needsUpdate = true; }
  clear() { for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, this.zero); this.n = 0; this.free.length = 0; this.dirty(); }
  box(x, y, z, sx, sy, sz, color, rx = 0, ry = 0, rz = 0) {
    const i = this.alloc(); if (i < 0) { this.overflow++; return -1; }
    const d = this.dummy; d.position.set(x, y, z); d.rotation.set(rx, ry, rz, 'YXZ'); d.scale.set(sx, sy, sz); d.updateMatrix();
    this.mesh.setMatrixAt(i, d.matrix); this.mesh.setColorAt(i, this.tmpColor.set(color));
    return i;
  }
  quad(x, y, z, w, h, rx, ry, color) { return this.box(x, y, z, w, h, 1, color, rx, ry, 0); }
}
/* Static geometry is bucketed into spatial chunks (one InstancedMesh each) so the frustum test skips whole districts. */
const CHUNK = 108;
class ChunkedPool {
  constructor(THREE, scene, geom, mat, cap, shadow = true, receive = true) { this.THREE = THREE; this.scene = scene; this.geom = geom; this.mat = mat; this.cap = cap; this.shadow = shadow; this.receive = receive; this.chunks = new Map(); this.n = 0; }
  chunkFor(x, z) {
    const coarse = Math.abs(x) > HALF + 70 || z < -HALF - 70 || z > BEACH_Z1 + 40; const cs = coarse ? 600 : CHUNK;
    const key = (coarse ? 'o' : 'c') + Math.floor(x / cs) + ',' + Math.floor(z / cs);
    let pl = this.chunks.get(key);
    if (!pl) { pl = new Pool(this.THREE, this.scene, this.geom, this.mat, coarse ? Math.max(200, this.cap >> 2) : this.cap, this.shadow, this.receive); this.chunks.set(key, pl); }
    return pl;
  }
  box(x, y, z, sx, sy, sz, color, rx = 0, ry = 0, rz = 0) { this.n++; return this.chunkFor(x, z).box(x, y, z, sx, sy, sz, color, rx, ry, rz); }
  quad(x, y, z, w, h, rx, ry, color) { this.n++; return this.chunkFor(x, z).quad(x, y, z, w, h, rx, ry, color); }
  finish() { for (const pl of this.chunks.values()) { pl.finish(); pl.mesh.computeBoundingSphere(); pl.mesh.frustumCulled = true; } }
  get overflow() { let n = 0; for (const pl of this.chunks.values()) n += pl.overflow; return n; }
}

const PALETTES = {
  'CRAFTON HILLS': [0xf2e6c9, 0xe8c9a0, 0xd9b38c, 0xc9d6e8, 0xe6d3f2, 0xf5f5f0, 0xbfd8b8, 0xf0c8b0],
  'REDSTONE INDUSTRIAL': [0x8a8a8a, 0x9a7b5e, 0x7d6a5a, 0xa64b3a, 0x6c7a89, 0xb8b0a0, 0x5e5e66],
  'LITTLE CUBO': [0xe25a4a, 0xf2b134, 0x3aa2c9, 0x8fc94e, 0xe27ab5, 0xf7e15c, 0x5ac9a5, 0xf08a4b],
  'DOWNTOWN': [0x8fa5b8, 0x5c6f82, 0xbcc6d1, 0x3d4b5c, 0x9fb7c9, 0xd9dde0, 0x6e8fb0, 0x2f3a4a, 0xa8b8c8],
  'PIXEL HEIGHTS': [0xc9c2b5, 0x9fb0a0, 0xd6c8a8, 0x7f8fa0, 0xb3a58a, 0xe0d8c8, 0x8c9aa8],
  'VOXEL BEACH': [0xfff5e6, 0xffd1dc, 0x9fe6e0, 0xffe9a8, 0xd1f0ff, 0xf7b7a3, 0xc8f0c0],
};
const SHOPS = ["CLUCKIN' CUBE", 'PIXEL PIZZA', 'BLOCKBUSTED VIDEO', 'VOXEL VAPES', 'CRAFT MART', "NOTCH'S BAR", 'AMMO-CUBE', 'MINE & DINE',
  'PAWN SHOP', '24/7 SLAB', 'SQUAREBUCKS', 'CUBEHUB', 'DIAMOND DENTAL', "STEVE'S GYM", 'ENDER LIQUOR', 'CREEPER CLEANERS', 'REDSTONE ELECTRIC',
  'NETHER NAILS', 'OBSIDIAN OPTICS', 'GRIEF & SON LAW', 'BEDROCK BANK', 'ZOMBIE TACOS', 'PIG & PICKAXE', 'SKELETON TATTOO', 'LAVA LOUNGE',
  'SLIME CAR WASH', 'BURGER BLOCK', 'CUBE-A-COLA', 'HOTEL CUBANA', 'MOB MOTEL', 'ANVIL AUTO', 'GLOWSTONE GRILL', 'THE DRUNK PIG', 'PIXEL PALACE',
  'KELP SUSHI', 'IRON GOLEM GYM', 'BLOCKBUSTER BAIL', 'CUBIC CAFE', 'SPAWN POINT INN', 'VILLAGER VET', 'DIAMOND PAWN', 'TNT FIREWORKS', 'BAD LUCK CASINO',
  'CHUNK CHURROS', 'NOTCH & CO', 'SUS PHARMACY', 'BIG SMOKE BBQ', 'VOXEL VISION', 'MINECART REPAIR'];
const SIGN_COLORS = [[0x1a1a2a, 0xffe14d], [0x8b1a1a, 0xffffff], [0x123c6b, 0x7fe0ff], [0xffffff, 0xd12b2b], [0x1f5f2a, 0xf5f5f5], [0x5a1a6b, 0xffb3f0], [0xf2b134, 0x1a1a1a], [0x111111, 0x3dff7a], [0xff5a36, 0xfff1c0]];
const AWNINGS = [0xd12b2b, 0x2b7fd1, 0x2ba64a, 0xf2b134, 0xffffff, 0x8b3a8b];

/* ---------------------------------------------------------------- the world */
export function buildWorld({ THREE, scene, seed = 20260903 }) {
  const { rnd, rr } = makeRng(seed);
  const ri = (a, b) => Math.floor(rr(a, b + 1));
  const pick = arr => arr[Math.floor(rnd() * arr.length)];

  scene.background = new THREE.Color(0x8ec9ff);
  scene.fog = new THREE.Fog(0x8ec9ff, 160, 560);
  const hemi = new THREE.HemisphereLight(0xbfdfff, 0x6f6a55, 0.75); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xffffff, 1.7);
  sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048);
  { const sc = sun.shadow.camera; sc.left = -85; sc.right = 85; sc.top = 85; sc.bottom = -85; sc.near = 5; sc.far = 600; }
  sun.shadow.bias = -0.002; scene.add(sun); scene.add(sun.target);

  const BOX = new THREE.BoxGeometry(1, 1, 1);
  const WHEEL_GEO = new THREE.CylinderGeometry(0.38, 0.38, 0.36, 10).rotateZ(PI / 2);
  const QUAD = new THREE.PlaneGeometry(1, 1);

  // Building material: Lambert + procedural window grid in world space, lit at night.
  const uNight = { value: 0 };
  const bldgMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  bldgMat.onBeforeCompile = sh => {
    sh.uniforms.uNight = uNight;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos; varying vec3 vWNrm;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\nvWNrm = normalize(mat3(modelMatrix) * (mat3(instanceMatrix) * objectNormal));');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vWPos; varying vec3 vWNrm; uniform float uNight;
        float hash21(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        vec3 wn = normalize(vWNrm); float side = 1.0 - abs(wn.y);
        vec2 wuv = abs(wn.x) > 0.5 ? vec2(vWPos.z, vWPos.y) : vec2(vWPos.x, vWPos.y);
        vec2 cellSz = vec2(2.6, 3.0); vec2 cell = floor(wuv / cellSz); vec2 wf = fract(wuv / cellSz);
        float win = step(0.2, wf.x) * step(wf.x, 0.8) * step(0.3, wf.y) * step(wf.y, 0.82) * side * step(3.6, vWPos.y);
        float wh = hash21(cell + floor(vWPos.xz * 0.02) * 7.0 + wn.xz * 3.0);
        float lit = step(0.5, wh) * uNight;
        vec3 glass = mix(diffuseColor.rgb * 0.3 + vec3(0.03, 0.06, 0.1), vec3(1.0, 0.86, 0.55), lit);
        diffuseColor.rgb = mix(diffuseColor.rgb, glass, win);
        float winLit = win * lit;`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(1.0, 0.8, 0.45) * winLit * 0.9;');
  };
  const lambert = new THREE.MeshLambertMaterial({ color: 0xffffff });
  const basicMat = new THREE.MeshBasicMaterial({ color: 0xffffff });

  const bldgPool = new ChunkedPool(THREE, scene, BOX, bldgMat, 400);
  const propPool = new ChunkedPool(THREE, scene, BOX, lambert, 2600);
  const flatPool = new ChunkedPool(THREE, scene, QUAD, new THREE.MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }), 1200, false, true);
  const textPool = new ChunkedPool(THREE, scene, QUAD, basicMat, 2600, false, false);
  const glowPool = new ChunkedPool(THREE, scene, BOX, basicMat, 300, false, false);
  // dynamic pools (peds, cars, effects, pickups, guns)
  const pedPools = ['head', 'hair', 'torso', 'armL', 'armR', 'legL', 'legR'].map(() => new Pool(THREE, scene, BOX, lambert, 320));
  const carBody = new Pool(THREE, scene, BOX, lambert, 230), carCabin = new Pool(THREE, scene, BOX, lambert, 230), carWheel = new Pool(THREE, scene, WHEEL_GEO, lambert, 920), carLight = new Pool(THREE, scene, BOX, basicMat, 1380, false, false); // room for heavy traffic and a hard police force on top of the parked cars
  const partPool = new Pool(THREE, scene, BOX, basicMat, 600, false, false);
  const decalPool = new Pool(THREE, scene, QUAD, new THREE.MeshLambertMaterial({ color: 0xffffff, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }), 600, false, true);
  const pickPool = new Pool(THREE, scene, BOX, basicMat, 80, false, false);
  const bulletPool = new Pool(THREE, scene, BOX, basicMat, 40, false, false);
  const gunPool = new Pool(THREE, scene, BOX, new THREE.MeshLambertMaterial({ color: 0x222226 }), 16);

  /* collision AABBs, bucketed per city cell + a global list for things outside the grid */
  const aabbs = [], cellAabbs = Array.from({ length: NB * NB }, () => []), outsideAabbs = [];
  function addAABB(x0, z0, x1, z1, h) {
    const b = { x0, z0, x1, z1, h }; aabbs.push(b);
    const i = cellOf((x0 + x1) / 2), j = cellOf((z0 + z1) / 2);
    if (i >= 0 && i < NB && j >= 0 && j < NB) cellAabbs[j * NB + i].push(b); else outsideAabbs.push(b);
    return b;
  }
  const _near = [];
  function nearAabbs(x, z) {       // 3x3 cells around a point + outside list
    _near.length = 0;
    const ci = cellOf(x), cj = cellOf(z);
    for (let j = cj - 1; j <= cj + 1; j++) for (let i = ci - 1; i <= ci + 1; i++)
      if (i >= 0 && i < NB && j >= 0 && j < NB) { const l = cellAabbs[j * NB + i]; for (let k = 0; k < l.length; k++) _near.push(l[k]); }
    for (let k = 0; k < outsideAabbs.length; k++) _near.push(outsideAabbs[k]);
    return _near;
  }
  const hasLOS = (ax, az, bx, bz) => !segment2dHitsAabbs(ax, az, bx, bz, nearAabbs((ax + bx) / 2, (az + bz) / 2));

  let shopIdx = 0;
  function addSign(text, face, x0, z0, x1, z1, y, extras = true) {
    const fw = (face % 2 === 0) ? (x1 - x0) : (z1 - z0);
    const p = Math.min(0.26, (fw - 1.6) / (6 * text.length));
    if (p < 0.11) return;
    const w = (6 * text.length - 1) * p, h = 7 * p;
    const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, out = 0.25;
    const [bg, fg] = pick(SIGN_COLORS);
    let ox, oz, dx, dz, nx = 0, nz = 0;
    if (face === 0) { ox = cx; oz = z0 - out; dx = -1; dz = 0; nz = -1; }
    else if (face === 1) { ox = x1 + out; oz = cz; dx = 0; dz = -1; nx = 1; }
    else if (face === 2) { ox = cx; oz = z1 + out; dx = 1; dz = 0; nz = 1; }
    else { ox = x0 - out; oz = cz; dx = 0; dz = 1; nx = -1; }
    const side = face % 2 === 1;
    propPool.box(ox, y, oz, side ? 0.3 : w + 1.2, h + 0.8, side ? w + 1.2 : 0.3, bg);
    const sx = ox - dx * w / 2 + nx * 0.17, sz = oz - dz * w / 2 + nz * 0.17, top = y + h / 2, faceYaw = Math.atan2(nx, nz);
    let cursor = 0;
    for (const ch of text) {
      const g = FONT[ch];
      if (g) for (let r = 0; r < 7; r++) {
        const bits = g[r]; if (!bits) continue;
        let c = 0;
        while (c < 5) {
          if (bits & (16 >> c)) { let c2 = c; while (c2 + 1 < 5 && (bits & (16 >> (c2 + 1)))) c2++;
            const len = (c2 - c + 1) * p, mid = cursor + c * p + len / 2;
            textPool.quad(sx + dx * mid, top - r * p - p / 2, sz + dz * mid, len, p, 0, faceYaw, fg); c = c2 + 1; }
          else c++;
        }
      }
      cursor += 6 * p;
    }
    if (extras) {
      // awning, storefront glass, door
      propPool.box(ox + nx * 0.45, y - h / 2 - 0.55, oz + nz * 0.45, side ? 1.2 : w + 1.6, 0.18, side ? w + 1.6 : 1.2, pick(AWNINGS));
      propPool.box(ox - nx * 0.18, 1.7, oz - nz * 0.18, side ? 0.12 : w + 1.6, 2.6, side ? w + 1.6 : 0.12, 0x9fd8ff);
      propPool.box(ox - nx * 0.12, 1.3, oz - nz * 0.12, side ? 0.16 : 1.2, 2.4, side ? 1.2 : 0.16, 0x3a2a1a);
    }
  }
  function roofProps(x0, z0, x1, z1, top, tower) {
    const w = x1 - x0, d = z1 - z0;
    if (tower) { if (rnd() < 0.7) propPool.box((x0 + x1) / 2, top + 4, (z0 + z1) / 2, 0.35, 8, 0.35, 0x333333);
      if (rnd() < 0.5) glowPool.box((x0 + x1) / 2, top + 8.2, (z0 + z1) / 2, 0.6, 0.6, 0.6, 0xff3030); }
    if (w > 6 && d > 6) {
      if (rnd() < 0.45) propPool.box(x0 + rr(2, w - 2), top + 1.2, z0 + rr(2, d - 2), 2, 2.4, 2, 0x6b5a4a);
      const n = ri(0, 3); for (let k = 0; k < n; k++) propPool.box(x0 + rr(1.5, w - 1.5), top + 0.5, z0 + rr(1.5, d - 1.5), 1.3, 1, 1.3, 0x9a9a9a);
      if (rnd() < 0.3) propPool.box((x0 + x1) / 2, top + 0.4, (z0 + z1) / 2, w - 1, 0.8, d - 1, 0x777770);   // roof ledge
    }
  }
  function addBuilding(x0, z0, x1, z1, h, color, opts = {}) {
    const w = x1 - x0, d = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
    bldgPool.box(cx, h / 2, cz, w, h, d, color);
    addAABB(x0, z0, x1, z1, h);
    let top = h;
    if (opts.tiers) {
      let tw = w, td = d;
      for (let t = 0; t < opts.tiers; t++) { tw *= 0.72; td *= 0.72; const th = h * rr(0.25, 0.4);
        bldgPool.box(cx, top + th / 2, cz, tw, th, td, color); top += th; }
    }
    if (opts.house) {
      propPool.box(cx, top + 0.6, cz, w + 0.8, 1.2, d + 0.8, opts.roof);
      propPool.box(cx, top + 1.6, cz, w * 0.6, 1.0, d * 0.6, opts.roof);
      propPool.box(cx + w * 0.3, top + 2.6, cz + d * 0.2, 0.8, 2, 0.8, 0x7a5a4a); // chimney
      propPool.box(cx, 1.2, opts.doorZ, 1.0, 2.2, 0.15, 0x5a3a22);
    } else if (!opts.noRoof) roofProps(x0, z0, x1, z1, top, h > 35);
    if (opts.sign) addSign(opts.sign, opts.face, x0, z0, x1, z1, opts.signY || 4.6, !opts.noExtras);
    return { x0, z0, x1, z1, h: top };
  }
  function addTree(x, z, palm) {
    const gy = groundY(x, z);
    if (palm) {
      const th = rr(6, 9);
      propPool.box(x, gy + th / 2, z, 0.55, th, 0.55, 0x8a6a3a);
      for (let k = 0; k < 6; k++) { const a = k * TAU / 6 + rr(-0.2, 0.2);
        propPool.box(x + Math.sin(a) * 1.4, gy + th + 0.1, z + Math.cos(a) * 1.4, 0.6, 0.2, 3.4, 0x3fa34d, 0.45, a, 0); }
      propPool.box(x, gy + th + 0.3, z, 0.9, 0.7, 0.9, 0x5a8a2a);
      addAABB(x - 0.3, z - 0.3, x + 0.3, z + 0.3, th);
    } else {
      const th = rr(1.6, 2.6), c = pick([0x3f8f3a, 0x4fa04a, 0x2f7a30, 0x6fb04a, 0x8fbf3a]);
      propPool.box(x, gy + th / 2, z, 0.6, th, 0.6, 0x6b4a2a);
      const s = rr(2.6, 3.8);
      propPool.box(x, gy + th + s / 2 - 0.3, z, s, s, s, c);
      propPool.box(x + rr(-1, 1), gy + th + s * 0.8, z + rr(-1, 1), s * 0.6, s * 0.6, s * 0.6, c);
      addAABB(x - 0.35, z - 0.35, x + 0.35, z + 0.35, th + s);
    }
  }
  function addLamp(x, z) {
    const gy = groundY(x, z);
    propPool.box(x, gy + 2.6, z, 0.25, 5.2, 0.25, 0x444448);
    glowPool.box(x, gy + 5.3, z, 0.9, 0.3, 0.9, 0xfff2c0);
    addAABB(x - 0.15, z - 0.15, x + 0.15, z + 0.15, 5.4);
  }
  function addBench(x, z, ry) {
    const gy = groundY(x, z);
    propPool.box(x, gy + 0.45, z, 1.8, 0.12, 0.5, 0x8a5a2a, 0, ry, 0);
    propPool.box(x - Math.cos(ry) * 0.2, gy + 0.7, z + Math.sin(ry) * 0.2, 1.8, 0.5, 0.12, 0x8a5a2a, 0, ry, 0);
    propPool.box(x, gy + 0.2, z, 1.6, 0.4, 0.4, 0x333333, 0, ry, 0);
  }

  function genBlock(i, j) {
    const bx0 = X(i) + ROAD / 2, bz0 = X(j) + ROAD / 2, bx1 = bx0 + BLOCK, bz1 = bz0 + BLOCK, cx = (bx0 + bx1) / 2, cz = (bz0 + bz1) / 2;
    const district = districtAt(cx, cz);
    propPool.box(cx, 0.1, cz, BLOCK, 0.2, BLOCK, pick([0xb8b8b2, 0xb2b2ac, 0xbebeb8]));
    addLamp(bx0 + 1.2, bz0 + 1.2); addLamp(bx1 - 1.2, bz1 - 1.2);
    const lx0 = bx0 + SW, lz0 = bz0 + SW, lx1 = bx1 - SW, lz1 = bz1 - SW; // buildable lot area (33x33)
    const special = SPECIAL[i + ',' + j];
    if (special === 'park') {
      propPool.box(cx, 0.25, cz, BLOCK - 2, 0.12, BLOCK - 2, 0x4c9a3c);
      for (let k = 0; k < 11; k++) addTree(rr(lx0 + 2, lx1 - 2), rr(lz0 + 2, lz1 - 2), rnd() < 0.35);
      addBench(cx - 6, cz, 0); addBench(cx + 6, cz, PI); addBench(cx, cz - 6, PI / 2); addBench(cx, cz + 6, -PI / 2);
      propPool.box(cx, 0.9, cz, 3, 1.4, 3, 0x777777); propPool.box(cx, 1.9, cz, 2.2, 0.6, 2.2, 0x3a8fd1);
      addAABB(cx - 1.5, cz - 1.5, cx + 1.5, cz + 1.5, 2.2);
      return;
    }
    if (special === 'plaza') {
      propPool.box(cx, 0.25, cz, BLOCK - 2, 0.12, BLOCK - 2, 0xd8d0c0);
      propPool.box(cx, 0.6, cz, 9, 0.7, 9, 0x8a8a95); propPool.box(cx, 0.85, cz, 8, 0.4, 8, 0x4aa8e8);
      propPool.box(cx, 2.0, cz, 1.2, 2.6, 1.2, 0x8a8a95); propPool.box(cx, 3.3, cz, 2.6, 0.3, 2.6, 0x8a8a95);
      addAABB(cx - 4.5, cz - 4.5, cx + 4.5, cz + 4.5, 3.5);
      for (const [ox, oz] of [[-13, -13], [13, -13], [-13, 13], [13, 13]]) addTree(cx + ox, cz + oz, true);
      for (const [ox, oz] of [[-13, 0], [13, 0], [0, -13], [0, 13]]) addTree(cx + ox, cz + oz, false);
      addBench(cx - 7, cz - 7, PI / 4); addBench(cx + 7, cz - 7, -PI / 4); addBench(cx - 7, cz + 7, 3 * PI / 4); addBench(cx + 7, cz + 7, -3 * PI / 4);
      for (let k = 0; k < 3; k++) { propPool.box(cx - 8 + k * 8, 5, cz + 15, 0.25, 10, 0.25, 0xcccccc); propPool.box(cx - 8 + k * 8 + 0.9, 9.2, cz + 15, 1.6, 1, 0.1, pick([0x2fd0ff, 0xffe14d, 0xff4d4d])); }
      addSign('DIAMOND PLAZA', 0, cx - 8, bz0 + 0.5, cx + 8, bz0 + 0.5, 6.5, false);
      return;
    }
    if (special === 'hospital') {
      addBuilding(lx0 + 1, lz0 + 1, lx1 - 1, lz1 - 8, 14, 0xf4f4f0, { sign: 'VOXEL GENERAL HOSPITAL', face: 2, signY: 5.2, noRoof: true });
      propPool.box(cx, 14.35, cz - 4, 6, 0.6, 1.6, 0xe02020); propPool.box(cx, 14.35, cz - 4, 1.6, 0.6, 6, 0xe02020);
      propPool.box(cx, 14.6, lz0 + 2.5, 2.5, 1.2, 2.5, 0x999999);
      propPool.box(cx, 15.5, cz + 4, 1.2, 3.5, 1.2, 0xcc2222);
      propPool.box(cx, 2.9, lz1 - 8 + 2, 12, 0.3, 4, 0xe8e8e8); // entrance canopy
      for (const ox of [-5.5, 5.5]) propPool.box(cx + ox, 1.5, lz1 - 8 + 3.6, 0.4, 2.8, 0.4, 0xdddddd);
      addTree(lx0 + 3, lz1 - 3, true); addTree(lx1 - 3, lz1 - 3, true);
      return;
    }
    if (special === 'police') {
      addBuilding(lx0 + 1, lz0 + 1, lx1 - 1, lz1 - 9, 11, 0x5b6b8a, { sign: 'LPPD PRECINCT 5.1', face: 2, signY: 5.0, noRoof: true });
      propPool.box(cx, 11.3, cz - 4, 8, 0.6, 3, 0x3a4a68);
      glowPool.box(cx - 2, 12, cz - 4, 1.2, 0.8, 1.2, 0x2040ff); glowPool.box(cx + 2, 12, cz - 4, 1.2, 0.8, 1.2, 0xff2020);
      propPool.box(cx, 6, lz1 - 5, 0.3, 12, 0.3, 0xcccccc); propPool.box(cx + 1.2, 11, lz1 - 5, 2.2, 1.3, 0.1, 0x2050c0);
      glowPool.box(POLICE_DOOR.x, 0.26, POLICE_DOOR.z, 3.2, 0.08, 3.2, 0x4d7fff); // the surrender pad at the front door
      return;
    }
    if (special === 'spray') {
      // Pay 'n' Spray: a low shop at the back of the lot and an open drive-in bay facing the street to the south.
      // Only the side walls and the shop collide, so a car can roll in under the roof.
      addBuilding(lx0 + 1, lz0 + 1, lx1 - 1, lz1 - 15, 9, 0x6c7a89, { sign: "PAY 'N' SPRAY", face: 2, signY: 7.4, noRoof: true, noExtras: true });
      const bz = SPRAY.z;
      for (const sx of [-1, 1]) { propPool.box(cx + sx * 6.5, 2.7, bz, 1, 5.4, 15, 0x8a8a8a); addAABB(cx + sx * 6.5 - 0.5, bz - 7.5, cx + sx * 6.5 + 0.5, bz + 7.5, 5.4); }
      propPool.box(cx, 5.6, bz, 14, 0.5, 15, 0x5e5e66);                       // roof, no collision box
      propPool.box(cx, 0.24, bz, 12, 0.1, 15, 0x2b2b30);                      // bay floor
      for (const oz of [-5, 0, 5]) glowPool.box(cx, 0.31, bz + oz, 10, 0.06, 0.6, 0x2fd0ff);   // floor stripes
      glowPool.box(cx, 5.95, bz + 7.2, 14, 0.25, 0.4, 0xff40c0);               // neon lip over the entrance
      for (const [ox, oz, col] of [[-11, -3, 0xd12b2b], [-11, 0, 0x2b5fd1], [-11, 3, 0xffe14d], [11, -2, 0x2ba64a], [11, 2, 0xff40c0]]) propPool.box(cx + ox, 0.9, bz + oz, 1.4, 1.4, 1.4, col); // paint drums
      addTree(lx0 + 2, lz1 - 2, false); addTree(lx1 - 2, lz1 - 2, false);
      return;
    }
    // regular block: split into lots
    let nx, nz, hmin, hmax, tiers = 0, house = false, signP = 0.7;
    const pal = PALETTES[district] || PALETTES.DOWNTOWN;
    switch (district) {
      case 'CRAFTON HILLS': nx = 3; nz = 3; hmin = 5; hmax = 9; house = true; signP = 0.08; break;
      case 'REDSTONE INDUSTRIAL': nx = pick([1, 2, 2]); nz = pick([1, 2]); hmin = 7; hmax = 15; signP = 0.45; break;
      case 'LITTLE CUBO': nx = pick([2, 3]); nz = pick([2, 3]); hmin = 8; hmax = 22; break;
      case 'DOWNTOWN': nx = pick([1, 2, 2, 3]); nz = pick([1, 2, 2]); hmin = 28; hmax = 95; break;
      case 'PIXEL HEIGHTS': nx = pick([2, 2, 3]); nz = pick([2, 3]); hmin = 12; hmax = 38; break;
      default: nx = pick([2, 3]); nz = pick([2, 3]); hmin = 6; hmax = 20; signP = 0.6;
    }
    const lw = (lx1 - lx0) / nx, ld = (lz1 - lz0) / nz;
    for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
      if (nx * nz > 1 && rnd() < 0.06 && district !== 'DOWNTOWN') { // empty lot with a couple of trees
        addTree(lx0 + (a + 0.5) * lw + rr(-2, 2), lz0 + (b + 0.5) * ld + rr(-2, 2), district === 'VOXEL BEACH'); continue;
      }
      const gap = house ? rr(1.6, 2.4) : rr(0.7, 1.4);
      const x0 = lx0 + a * lw + gap, x1 = lx0 + (a + 1) * lw - gap, z0 = lz0 + b * ld + gap, z1 = lz0 + (b + 1) * ld - gap;
      let h = rr(hmin, hmax); if (district === 'DOWNTOWN' && rnd() < 0.35) h = rr(hmin, hmin + 15);
      h = Math.round(h / 3) * 3 + 0.5;
      const color = pick(pal);
      const faces = []; if (b === 0) faces.push(0); if (a === nx - 1) faces.push(1); if (b === nz - 1) faces.push(2); if (a === 0) faces.push(3);
      const opts = {};
      if (house) { opts.house = true; opts.roof = pick([0x7a3b2e, 0x4a4a55, 0x8a6a4a, 0x5a3a3a]); opts.doorZ = b === nz - 1 ? z1 + 0.05 : z0 - 0.05; }
      else if (h > 40) opts.tiers = ri(1, 2);
      if (faces.length && rnd() < signP) { opts.sign = SHOPS[shopIdx++ % SHOPS.length]; opts.face = pick(faces); if (h < 12 && opts.sign.length > 14) opts.sign = SHOPS[shopIdx++ % SHOPS.length]; }
      else if (faces.length && district !== 'CRAFTON HILLS' && rnd() < 0.5) { // plain storefront glass on street-facing side
        const f = pick(faces); const n = f === 0 ? [0, -1] : f === 1 ? [1, 0] : f === 2 ? [0, 1] : [-1, 0];
        const fw = f % 2 === 0 ? x1 - x0 : z1 - z0, mx = (x0 + x1) / 2 + n[0] * ((x1 - x0) / 2 + 0.07), mz = (z0 + z1) / 2 + n[1] * ((z1 - z0) / 2 + 0.07);
        propPool.box(mx, 1.6, mz, f % 2 ? 0.12 : fw - 1.5, 2.6, f % 2 ? fw - 1.5 : 0.12, pick([0x9fd8ff, 0x7fc0e0, 0x3a4a5a]));
      }
      addBuilding(x0, z0, x1, z1, h, color, opts);
      if (house && rnd() < 0.6) addTree(rr(x0 - 1.5, x1 + 1.5), b === nz - 1 ? z1 + 1.5 : z0 - 1.5, false);
    }
  }
  function genRoads() {
    const yellow = 0xe8c832, white = 0xf0f0f0;
    for (let k = 0; k <= NB; k++) {
      for (let t = -HALF - ROAD / 2; t < HALF + ROAD / 2; t += 5) {
        const near = Math.abs(((t + HALF) % PITCH + PITCH) % PITCH - 0) < 8.5 || Math.abs(((t + HALF) % PITCH) - PITCH) < 8.5;
        if (near) continue;
        flatPool.quad(X(k) - 0.3, 0.03, t, 0.22, 3, -PI / 2, 0, yellow); flatPool.quad(X(k) + 0.3, 0.03, t, 0.22, 3, -PI / 2, 0, yellow);
        flatPool.quad(t, 0.03, X(k) - 0.3, 3, 0.22, -PI / 2, 0, yellow); flatPool.quad(t, 0.03, X(k) + 0.3, 3, 0.22, -PI / 2, 0, yellow);
      }
    }
    for (let a = 0; a <= NB; a++) for (let b = 0; b <= NB; b++) {
      const x = X(a), z = X(b);
      for (let s = -6; s <= 6; s += 1.7) {
        if (b > 0) flatPool.quad(x + s, 0.03, z - 8.2, 0.7, 2.2, -PI / 2, 0, white);
        if (b < NB) flatPool.quad(x + s, 0.03, z + 8.2, 0.7, 2.2, -PI / 2, 0, white);
        if (a > 0) flatPool.quad(x - 8.2, 0.03, z + s, 2.2, 0.7, -PI / 2, 0, white);
        if (a < NB) flatPool.quad(x + 8.2, 0.03, z + s, 2.2, 0.7, -PI / 2, 0, white);
      }
    }
  }
  // Ferris wheel (rotating instanced mesh + upright cabins updated per frame)
  let wheelMesh, cabinPool;
  function genBeach() {
    const sandW = HALF + ROAD / 2 + 60;
    propPool.box(0, -0.05, (BEACH_Z0 + BEACH_Z1) / 2 + 2, sandW * 2, 0.12, BEACH_Z1 - BEACH_Z0 + 4, 0xe8d8a0);
    propPool.box(0, 0.15, BEACH_Z0 + 6, HALF * 2 + ROAD, 0.3, 12, 0x9a7a55);         // boardwalk planks strip
    for (let x = -HALF + 6; x < HALF; x += 14) { addTree(x + rr(-2, 2), BEACH_Z0 + rr(14, 22), true); if (rnd() < 0.5) addLamp(x, BEACH_Z0 + 11.5); }
    for (let x = -HALF + 20; x < HALF; x += 45) { // beach huts & umbrellas
      propPool.box(x, 1.4, BEACH_Z0 + rr(30, 45), 3.5, 2.8, 3, pick([0xff6b6b, 0x4dd0e1, 0xffe14d, 0x9be15d]));
      for (let k = 0; k < 3; k++) { const ux = x + rr(-12, 12), uz = BEACH_Z0 + rr(28, 52); propPool.box(ux, 1.2, uz, 0.15, 2.4, 0.15, 0xffffff); propPool.box(ux, 2.4, uz, 2.6, 0.25, 2.6, pick([0xff4d4d, 0x4d9fff, 0xffdd4d]), 0, rr(0, PI), 0); }
    }
    // pier
    propPool.box(-60, 0.6, BEACH_Z1 + 25, 14, 1.2, 70, 0x8a6a45); for (let z = BEACH_Z0 + 8; z < BEACH_Z1 + 58; z += 10) { propPool.box(-66, -0.5, z, 0.8, 4, 0.8, 0x5a4a35); propPool.box(-54, -0.5, z, 0.8, 4, 0.8, 0x5a4a35); }
    for (let z = BEACH_Z1 + 5; z < BEACH_Z1 + 55; z += 16) { addLamp(-66, z); addLamp(-54, z); }
    propPool.box(-60, 3, BEACH_Z1 + 52, 8, 4, 6, 0xff8a5c); addSign('PIER 51 SHRIMP', 0, -64, BEACH_Z1 + 49, -56, BEACH_Z1 + 49, 6, false);
    addAABB(-64, BEACH_Z1 + 49, -56, BEACH_Z1 + 55, 5);
    // ferris wheel
    const F = FERRIS, FP = new Pool(THREE, scene, BOX, lambert, 90); wheelMesh = FP.mesh;
    for (let k = 0; k < 24; k++) { const th = k * TAU / 24 + TAU / 48; for (const sx of [-1.8, 1.8]) FP.box(sx, F.r * Math.sin(th), F.r * Math.cos(th), 0.6, 0.6, 5.9, k % 2 ? 0xff3355 : 0xffffff, -(th + PI / 2), 0, 0); }
    for (let k = 0; k < 12; k++) { const th = k * TAU / 12; for (const sx of [-1.8, 1.8]) FP.box(sx, F.r / 2 * Math.sin(th), F.r / 2 * Math.cos(th), 0.4, 0.4, F.r, 0xdddddd, -th, 0, 0); }
    FP.box(0, 0, 0, 5.2, 3.2, 3.2, 0xffcc33);
    FP.finish(); FP.mesh.position.set(F.x, F.y, F.z);
    cabinPool = new Pool(THREE, scene, BOX, lambert, 12);
    for (let k = 0; k < 12; k++) { cabinPool.alloc(); cabinPool.color(k, [0xff5a5a, 0x5ad0ff, 0xffe14d, 0x9be15d, 0xff9de2, 0xffa14d][k % 6]); }
    cabinPool.finish();
    for (const sx of [-3, 3]) for (const dz of [-1, 1]) { propPool.box(F.x + sx, F.y / 2, F.z + dz * 7, 1.2, 1.2, Math.hypot(F.y, 14), 0x8899aa, Math.atan2(dz * 14, F.y), 0, 0); }
    addAABB(F.x - 4, F.z - 15, F.x + 4, F.z + 15, 4);
    propPool.box(F.x, 0.5, F.z, 12, 1, 26, 0x777777);
    addSign('PIXEL WHEEL', 0, F.x - 8, F.z - 17, F.x + 8, F.z - 17, 4.5, false);
  }
  let water, cloudMesh, boatPool, wavePool, sunDisc, moonDisc;
  function genOutside() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), new THREE.MeshLambertMaterial({ color: 0x4f8a3c }));
    ground.rotation.x = -PI / 2; ground.position.y = -0.02; ground.receiveShadow = true; scene.add(ground);
    const asphalt = new THREE.Mesh(BOX, new THREE.MeshLambertMaterial({ color: 0x2b2b30 }));
    asphalt.scale.set(NB * PITCH + ROAD, 0.3, NB * PITCH + ROAD); asphalt.position.y = -0.15; asphalt.receiveShadow = true; scene.add(asphalt);
    water = new THREE.Mesh(new THREE.PlaneGeometry(4000, 1400), new THREE.MeshLambertMaterial({ color: 0x1f6fbf, transparent: true, opacity: 0.92 }));
    water.rotation.x = -PI / 2; water.position.set(0, WATER_Y, BEACH_Z1 + 700); scene.add(water);
    wavePool = new Pool(THREE, scene, BOX, basicMat, 60, false, false);
    for (let k = 0; k < 60; k++) { wavePool.alloc(); wavePool.color(k, 0xdff4ff); } wavePool.finish();
    boatPool = new Pool(THREE, scene, BOX, lambert, 12);
    for (let k = 0; k < 12; k++) { boatPool.alloc(); boatPool.color(k, k % 2 ? 0x334455 : 0xffffff); } boatPool.finish();
    // hills around the north / east / west edges
    for (let k = 0; k < 90; k++) {
      const side = rnd(); let x, z;
      if (side < 0.5) { x = rr(-HALF - 500, HALF + 500); z = -HALF - rr(60, 520); }
      else if (side < 0.75) { x = -HALF - rr(60, 500); z = rr(-HALF - 200, HALF); }
      else { x = HALF + rr(60, 500); z = rr(-HALF - 200, HALF); }
      const s = rr(25, 90), h = rr(6, 42) * (1 + (Math.abs(x) + Math.abs(z) - HALF) / 800);
      propPool.box(x, h / 2 - 1, z, s, h, s * rr(0.6, 1.4), pick([0x3f7a33, 0x4a8a3a, 0x5a9a44, 0x6a8a55]));
      if (Math.abs(x) > HALF + 30 || z < -HALF - 30) addAABB(x - s / 2, z - s / 2, x + s / 2, z + s / 2, h);
    }
    for (let k = 0; k < 120; k++) { const side = rnd(); let x, z;
      if (side < 0.5) { x = rr(-HALF, HALF); z = -HALF - rr(12, 50); } else if (side < 0.75) { x = -HALF - rr(12, 50); z = rr(-HALF, HALF); } else { x = HALF + rr(12, 50); z = rr(-HALF, HALF); }
      addTree(x, z, false); }
    // clouds
    cloudMesh = new Pool(THREE, scene, BOX, new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.92 }), 150, false, false);
    for (let k = 0; k < 45; k++) { const x = rr(-900, 900), z = rr(-900, 900), y = rr(120, 170), s = rr(14, 40);
      cloudMesh.box(x, y, z, s, s * 0.25, s * rr(0.5, 0.9), 0xffffff); cloudMesh.box(x + s * 0.4, y + s * 0.1, z + s * 0.2, s * 0.6, s * 0.25, s * 0.5, 0xffffff); cloudMesh.box(x - s * 0.35, y + s * 0.05, z - s * 0.1, s * 0.5, s * 0.2, s * 0.4, 0xffffff); }
    cloudMesh.finish();
    // sun and moon discs
    sunDisc = new THREE.Mesh(new THREE.SphereGeometry(28, 12, 8), new THREE.MeshBasicMaterial({ color: 0xfff2b0, fog: false })); scene.add(sunDisc);
    moonDisc = new THREE.Mesh(new THREE.SphereGeometry(16, 10, 8), new THREE.MeshBasicMaterial({ color: 0xdde6ff, fog: false })); scene.add(moonDisc);
  }

  for (let j = 0; j < NB; j++) for (let i = 0; i < NB; i++) genBlock(i, j);
  genRoads(); genBeach(); genOutside();
  bldgPool.finish(); propPool.finish(); flatPool.finish(); textPool.finish(); glowPool.finish();
  const plazaMarker = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: 0xffe14d, transparent: true, opacity: 0.45 }));
  plazaMarker.scale.set(1.2, 40, 1.2); plazaMarker.position.set(PLAZA.x, 20, PLAZA.z); scene.add(plazaMarker);
  const sprayMarker = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color: 0x2fd0ff, transparent: true, opacity: 0.4 }));
  sprayMarker.scale.set(1.2, 40, 1.2); sprayMarker.position.set(SPRAY.x, 26, SPRAY.z); scene.add(sprayMarker);
  /* a tall translucent column like the two above, for whatever the game wants to point at (a world event, a checkpoint); hidden until placed */
  function makeMarker(color) { const m = new THREE.Mesh(BOX, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4 })); m.scale.set(1.2, 40, 1.2); m.visible = false; scene.add(m); return m; }
  const eventMarker = makeMarker(0x3dff7a);
  /* a flat arrow on the road (the race's sat-nav lays a trail of them); its tip points along +z at yaw 0, so rotation.y takes a
     heading like a car's. One shared material, so a pulse set on any arrow's material pulses them all. Hidden until placed. */
  const ARROW = (() => { const sh = new THREE.Shape(); sh.moveTo(-0.8, 2.2); sh.lineTo(0.8, 2.2); sh.lineTo(0.8, -0.4); sh.lineTo(2.1, -0.4); sh.lineTo(0, -3); sh.lineTo(-2.1, -0.4); sh.lineTo(-0.8, -0.4); sh.closePath(); return new THREE.ShapeGeometry(sh); })();
  const arrowMat = new THREE.MeshBasicMaterial({ color: 0x2fd0ff, transparent: true, opacity: 0.7, depthWrite: false, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 });
  function makeArrow() { const m = new THREE.Mesh(ARROW, arrowMat); m.rotation.order = 'YXZ'; m.rotation.x = -PI / 2; m.position.y = 0.06; m.visible = false; scene.add(m); return m; }

  /* ---- per-frame scenery animation (Ferris wheel, clouds, boats, waves) - identical, purely cosmetic, on every machine */
  const M = new THREE.Matrix4(), M2 = new THREE.Matrix4(), M3 = new THREE.Matrix4();
  const clouds = []; for (let i = 0; i < cloudMesh.n; i++) { cloudMesh.mesh.getMatrixAt(i, M); clouds.push({ i, x: M.elements[12], y: M.elements[13], z: M.elements[14], sx: M.elements[0], sy: M.elements[5], sz: M.elements[10] }); }
  const waves = []; for (let k = 0; k < 60; k++) waves.push({ x: rr(-HALF - 200, HALF + 200), z: rr(BEACH_Z1, BEACH_Z1 + 70), w: rr(6, 16), s: rr(1.5, 3) });
  let ferrisAngle = 0;
  function animate(dt, t, camera) {
    ferrisAngle += dt * 0.15; wheelMesh.rotation.x = ferrisAngle;
    for (let k = 0; k < 12; k++) { const th = k * TAU / 12 - ferrisAngle; M.makeTranslation(FERRIS.x, FERRIS.y + FERRIS.r * Math.sin(th) - 1.4, FERRIS.z + FERRIS.r * Math.cos(th)); M.multiply(M2.makeScale(3.0, 2.2, 2.4)); cabinPool.set(k, M); }
    cabinPool.dirty();
    for (const c of clouds) { c.x += dt * 1.4; if (c.x > 950) c.x -= 1900; M.makeTranslation(c.x, c.y, c.z); M.multiply(M2.makeScale(c.sx, c.sy, c.sz)); cloudMesh.set(c.i, M); }
    cloudMesh.dirty();
    for (let k = 0; k < 6; k++) { const dir = k % 2 ? 1 : -1; const x = ((t * (4 + k) * dir + k * 190 + 5000) % 1400) - 700, z = BEACH_Z1 + 55 + k * 40, bob = Math.sin(t * 1.4 + k) * 0.25;
      M.makeTranslation(x, WATER_Y + 0.7 + bob, z); M.multiply(M2.makeRotationY(dir > 0 ? PI / 2 : -PI / 2)); M.multiply(M2.makeRotationZ(Math.sin(t + k) * 0.05)); M3.copy(M).multiply(M2.makeScale(3.2, 1.3, 8)); boatPool.set(k * 2, M3);
      M3.copy(M).multiply(M2.makeTranslation(0, 1.3, -1)).multiply(M2.makeScale(2.4, 1.3, 2.6)); boatPool.set(k * 2 + 1, M3); }
    boatPool.dirty();
    for (let k = 0; k < waves.length; k++) { const w = waves[k]; w.z -= w.s * dt; if (w.z < BEACH_Z1 - 3) { w.z = BEACH_Z1 + 70; w.x = rr(-HALF - 200, HALF + 200); }
      const f = clamp((w.z - BEACH_Z1) / 25, 0.1, 1); M.makeTranslation(w.x, WATER_Y + 0.06, w.z); M.multiply(M2.makeScale(w.w * f, 0.05, 0.5)); wavePool.set(k, M); }
    wavePool.dirty();
    water.position.x = camera.position.x;
  }

  /* ---- sky, fog, sun and window lights for a clock hour; the sun and its shadow camera follow the local player */
  const cSky = new THREE.Color(), cDay = new THREE.Color(0x8ec9ff), cNight = new THREE.Color(0x101a3a), cDusk = new THREE.Color(0xff9a5c), cSun = new THREE.Color(), cSunDay = new THREE.Color(0xffffff), cSunDusk = new THREE.Color(0xffc080), cSunNight = new THREE.Color(0x8090c0);
  function dayNight(clockH, px, pz, camera) {
    const sunA = (clockH - 6) / 12 * PI, elev = Math.sin(sunA);
    const day = clamp(elev * 2.4, 0, 1), dusk = clamp(1 - Math.abs(elev) * 5, 0, 1) * 0.7;
    cSky.copy(cNight).lerp(cDay, day).lerp(cDusk, dusk * (elev > -0.1 ? 1 : 0.3));
    scene.background.copy(cSky); scene.fog.color.copy(cSky); scene.fog.near = lerp(90, 170, day); scene.fog.far = lerp(380, 620, day);
    const dirx = Math.cos(sunA) * 0.9, diry = Math.max(elev, 0.3), dirz = 0.35;
    sun.position.set(px + dirx * 220, diry * 220, pz + dirz * 220); sun.target.position.set(px, 0, pz); sun.target.updateMatrixWorld();
    sun.intensity = 0.3 + day * 1.5; cSun.copy(cSunNight).lerp(cSunDay, day).lerp(cSunDusk, dusk); sun.color.copy(cSun);
    hemi.intensity = 0.4 + day * 0.45; uNight.value = 1 - day;
    const sd = 1200; sunDisc.position.set(camera.position.x + Math.cos(sunA) * sd, elev * sd - 30, camera.position.z + 0.35 * sd); sunDisc.visible = elev > -0.15;
    moonDisc.position.set(camera.position.x - Math.cos(sunA) * sd, -elev * sd + 40, camera.position.z + 0.3 * sd); moonDisc.visible = elev < 0.1;
  }

  /* ---- minimap image (only where there is a document; the simulation can run headless) */
  let mapCanvas = null;
  if (typeof document !== 'undefined') {
    const { MS, MOFF } = MAP; mapCanvas = document.createElement('canvas');
    const size = Math.ceil((HALF + 220) * 2 * MS); mapCanvas.width = size; mapCanvas.height = size; const c = mapCanvas.getContext('2d');
    c.fillStyle = '#2f4a2a'; c.fillRect(0, 0, size, size);
    const wx = v => (v + MOFF) * MS;
    c.fillStyle = '#1b4d8a'; c.fillRect(0, wx(BEACH_Z1), size, size);
    c.fillStyle = '#d8c890'; c.fillRect(wx(-HALF - 40), wx(BEACH_Z0), (HALF + 40) * 2 * MS, (BEACH_Z1 - BEACH_Z0) * MS);
    c.fillStyle = '#b9b9b4'; c.fillRect(wx(-HALF - ROAD / 2), wx(-HALF - ROAD / 2), (NB * PITCH + ROAD) * MS, (NB * PITCH + ROAD) * MS);
    for (let j = 0; j < NB; j++) for (let i = 0; i < NB; i++) { const sp = SPECIAL[i + ',' + j];
      c.fillStyle = sp === 'park' ? '#3f8a3a' : sp === 'plaza' ? '#c9b98a' : sp === 'hospital' ? '#e8e8e8' : sp === 'police' ? '#5b6b8a' : sp === 'spray' ? '#2f6f7f' : '#585860';
      c.fillRect(wx(X(i) + ROAD / 2), wx(X(j) + ROAD / 2), BLOCK * MS, BLOCK * MS); }
    c.fillStyle = '#8a6a45'; c.fillRect(wx(-67), wx(BEACH_Z0 + 8), 14 * MS, 80 * MS);
    c.fillStyle = '#ffffff'; c.beginPath(); c.arc(wx(FERRIS.x), wx(FERRIS.z), 22 * MS, 0, TAU); c.lineWidth = 3; c.strokeStyle = '#ff3355'; c.stroke();
  }

  return {
    THREE, scene, sun, hemi, plazaMarker, sprayMarker, eventMarker, makeMarker, makeArrow, mapCanvas,
    aabbs, nearAabbs, hasLOS,
    pedPools, carBody, carCabin, carWheel, carLight, partPool, decalPool, pickPool, bulletPool, gunPool,
    animate, dayNight,
    get overflow() { return bldgPool.overflow + propPool.overflow + flatPool.overflow + textPool.overflow + glowPool.overflow; },
    dirtyDynamic() { for (const p of pedPools) p.dirty(); carBody.dirty(); carCabin.dirty(); carWheel.dirty(); carLight.dirty(); gunPool.dirty(); },
  };
}
