/* Frostline Kart - a snowy kart racer. Game module for the LAN party shell.

   Contract (every game module exports this):
     create({ mount, audio, send, hooks }) -> Promise<instance>
       mount  element the game owns; build the HUD into it, empty it in destroy()
       audio  shared synth from core/audio.js (already unlocked by the shell's first click)
       send   send(msg) relays a JSON message to the rest of the room; a no-op when playing solo
       hooks  { onRestart(), onExit() } - what R / ESC and the result-screen buttons mean is the shell's call
     instance.start(session)   begin a round; session = { players: [{ id, name, avatar }], myId, hostId, isHost, online, opts }
     instance.stop()           end the round and go quiet (back to the lobby); the instance may be started again
     instance.destroy()        release everything: DOM, listeners, GL, audio voices
     instance.onNetMessage(m)  a relayed message from another player (m.from is their id)
     instance.playerLeft(id)   a player dropped out mid-round

   Netcode: each machine simulates only the karts it owns - its own kart plus, on the host, every CPU kart,
   shells, bananas, item boxes and the race clock. Everything else is interpolated from 30 Hz snapshots.
   Hits are decided by the victim's machine. */
import * as THREE from 'three';
import { clamp, lerp, wrapAngle, ordinal, makeRng } from '../../core/math.js';
import { createToasts, esc, fmtTime, loadStylesheet } from '../../core/ui.js';
import { createInput } from '../../core/input.js';
import { createLoop, fixedStep } from '../../core/loop.js';
import { nowSec, pushSnap, sampleSnaps } from '../../core/interp.js';

/* kart skins, indexed by the shared avatar index (core/avatars.js) */
const SKINS = [
  { name: 'Frost', color: 0xff3b3b, helmet: 0xffffff },
  { name: 'Yeti', color: 0x3b82f6, helmet: 0xffd54a }, { name: 'Blizzard', color: 0xfacc15, helmet: 0x1e293b }, { name: 'Glacier', color: 0x22c55e, helmet: 0xffffff },
  { name: 'Aurora', color: 0xa855f7, helmet: 0x7fd0ff }, { name: 'Flurry', color: 0xf97316, helmet: 0x111827 }, { name: 'Penguin', color: 0x06b6d4, helmet: 0xff3b3b }, { name: 'Frostbite', color: 0xf472b6, helmet: 0xffffff },
];

const HUD = `
<canvas id="c"></canvas>
<div id="item" class="hud panel"><canvas id="itemCanvas" width="168" height="168"></canvas><div id="itemLabel"></div></div>
<div id="lapbox" class="hud panel"><div id="lap">LAP <b>1</b>/3</div><div id="timer">0:00.00</div></div>
<div id="pos" class="hud">8<sup>th</sup></div>
<div id="speedo" class="hud"><canvas id="speedCanvas" width="260" height="150" style="width:260px;height:150px"></canvas></div>
<div id="map" class="hud panel"><canvas id="mapCanvas" width="380" height="380"></canvas></div>
<div id="toasts" class="hud"></div>
<div id="count" class="hud"></div>
<div id="wrong" class="hud">⟲ WRONG WAY</div>
<div id="hint" class="hud"></div>
<div id="flash"></div>
<div id="results"><div class="card"><h1>FINISH!</h1><h2 id="resSub">FINAL STANDINGS</h2><table id="resTable"></table><div class="foot" id="resFoot"></div></div></div>`;

function disposeScene(scene) {
  scene.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { for (const v of Object.values(m)) if (v && v.isTexture) v.dispose(); m.dispose(); }
  });
}

export async function create({ mount, audio, send, hooks }) {
const unloadCss = await loadStylesheet('/games/kart/kart.css');
mount.innerHTML = HUD;
const $ = id => mount.querySelector('#' + id);
const { rnd, rr } = makeRng(1337);

/* ============================================================ renderer / scene */
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color(0x3a4370);
scene.fog = new THREE.Fog(FOG_COLOR, 160, 820);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 3200);
const onResize = () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }; addEventListener('resize', onResize);

scene.add(new THREE.HemisphereLight(0x8ea6ff, 0x4b5482, 1.15));
scene.add(new THREE.AmbientLight(0x7080b0, 0.35));
const moonLight = new THREE.DirectionalLight(0xe4ecff, 2.1);
moonLight.position.set(-0.45, 0.8, -0.55).multiplyScalar(400);
scene.add(moonLight);

const timeU = { value: 0 };

/* sky dome */
const skyMat = new THREE.ShaderMaterial({
  side: THREE.BackSide, depthWrite: false,
  uniforms: { uTime: timeU },
  vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `varying vec3 vDir; uniform float uTime;
    void main(){ float t = clamp(vDir.y, -0.1, 1.0);
      vec3 hor = vec3(0.23,0.26,0.44); vec3 top = vec3(0.02,0.03,0.11);
      vec3 col = mix(hor, top, pow(smoothstep(0.0,0.75,t),0.7));
      float sunGlow = pow(max(0.0, dot(normalize(vDir), normalize(vec3(-0.6,0.05,-0.75)))), 6.0);
      col += vec3(0.75,0.35,0.45) * sunGlow * (1.0 - smoothstep(0.0,0.35,t));
      gl_FragColor = vec4(col, 1.0); }`
});
const sky = new THREE.Mesh(new THREE.SphereGeometry(2400, 32, 16), skyMat);
sky.renderOrder = -10; scene.add(sky);

/* stars */
{
  const n = 1400, p = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { const a = rnd() * Math.PI * 2, e = Math.asin(rnd() * 0.95 + 0.05), r = 2200; p[i*3] = Math.cos(a) * Math.cos(e) * r; p[i*3+1] = Math.sin(e) * r; p[i*3+2] = Math.sin(a) * Math.cos(e) * r; }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 })));
}
/* moon */
{ const m = new THREE.Mesh(new THREE.SphereGeometry(70, 20, 12), new THREE.MeshBasicMaterial({ color: 0xfff6d8, fog: false })); m.position.copy(moonLight.position).normalize().multiplyScalar(2100); scene.add(m); }

/* aurora ribbons */
const auroraMat = new THREE.ShaderMaterial({
  transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  uniforms: { uTime: timeU, uHue: { value: 0 } },
  vertexShader: `uniform float uTime; varying vec2 vUv; void main(){ vUv = uv; vec3 p = position;
      float w = sin(uv.x*12.566 + uTime*0.35)*18.0 + sin(uv.x*31.4 - uTime*0.6)*7.0;
      p.xz += normalize(p.xz) * w * uv.y; p.y += sin(uv.x*20.0 + uTime*0.5)*6.0;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(p,1.0); }`,
  fragmentShader: `uniform float uTime; uniform float uHue; varying vec2 vUv; void main(){ float x = vUv.x, y = vUv.y;
      float bands = 0.55 + 0.45*sin(x*46.0 + uTime*0.7 + sin(x*13.0 - uTime*0.45)*3.0);
      bands *= 0.65 + 0.35*sin(x*110.0 - uTime*1.1 + y*4.0);
      float vert = smoothstep(0.0,0.12,y) * (1.0 - smoothstep(0.3,1.0,y));
      float edge = smoothstep(0.0,0.12,x) * (1.0 - smoothstep(0.88,1.0,x));
      vec3 g = mix(vec3(0.15,1.0,0.55), vec3(0.2,0.9,1.0), uHue);
      vec3 col = mix(g, vec3(0.5,0.25,1.0), smoothstep(0.05,0.75,y));
      col = mix(col, vec3(1.0,0.35,0.6), smoothstep(0.55,1.0,y)*0.55);
      float a = bands * vert * edge * 0.8; gl_FragColor = vec4(col*a, a); }`
});
function auroraRibbon(a0, a1, R, y0, H, hue) {
  const segs = 80, rows = 10, pos = [], uv = [], idx = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= segs; i++) {
    const a = lerp(a0, a1, i / segs); pos.push(Math.cos(a) * R, y0 + H * j / rows, Math.sin(a) * R); uv.push(i / segs, j / rows);
  }
  for (let j = 0; j < rows; j++) for (let i = 0; i < segs; i++) { const k = j * (segs + 1) + i; idx.push(k, k + 1, k + segs + 1, k + 1, k + segs + 2, k + segs + 1); }
  const g = new THREE.BufferGeometry(); g.setIndex(idx); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  const mat = auroraMat.clone(); mat.uniforms.uTime = timeU; mat.uniforms.uHue.value = hue;
  const m = new THREE.Mesh(g, mat); m.frustumCulled = false; scene.add(m); return m;
}
auroraRibbon(3.4, 5.6, 1500, 260, 380, 0);
auroraRibbon(3.9, 5.2, 1250, 330, 260, 0.6);
auroraRibbon(0.2, 1.6, 1600, 300, 300, 0.3);

/* ============================================================ terrain */
function terrainH(x, z) {
  let h = 3.0 * Math.sin(x * 0.021 + 0.4) * Math.sin(z * 0.017 + 0.9) + 1.3 * Math.sin(x * 0.047 + z * 0.033) + 1.8 * Math.cos(z * 0.029 - x * 0.012);
  const d = Math.hypot(x, z);
  if (d > 330) { const t = (d - 330) / 500; h += t * t * 140 * (1 + 0.45 * Math.sin(Math.atan2(z, x) * 7 + 1.3)); }
  return h;
}
const SNOW = new THREE.Color(0xe6eeff);
{
  const size = 1700, segs = 150, g = new THREE.PlaneGeometry(size, size, segs, segs);
  g.rotateX(-Math.PI / 2);
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) { const x = p.getX(i), z = p.getZ(i); p.setY(i, terrainH(x, z) - 0.05); }
  const ng = g.toNonIndexed(); ng.computeVertexNormals();
  const pp = ng.attributes.position, col = new Float32Array(pp.count * 3), c = new THREE.Color();
  for (let i = 0; i < pp.count; i += 3) {
    const y = pp.getY(i); const f = clamp(0.92 + y * 0.006 + (rnd() - 0.5) * 0.06, 0.7, 1.08);
    c.copy(SNOW).multiplyScalar(f); if (y > 60) c.lerp(new THREE.Color(0x9aa7c8), clamp((y - 60) / 120, 0, 0.6));
    for (let k = 0; k < 3; k++) { col[(i + k) * 3] = c.r; col[(i + k) * 3 + 1] = c.g; col[(i + k) * 3 + 2] = c.b; }
  }
  ng.setAttribute('color', new THREE.BufferAttribute(col, 3));
  scene.add(new THREE.Mesh(ng, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.95 })));
}

/* ============================================================ track */
const CTRL = [[-30,0],[40,0],[95,2],[132,14],[158,50],[152,95],[120,122],[85,118],[55,140],[20,168],[-20,158],[-35,122],[-22,85],[-50,62],[-80,80],[-82,118],[-110,150],[-150,140],[-175,100],[-170,55],[-140,20],[-110,2],[-80,0]];
const HW = 7.0, CURB = 1.3, WALL = 11.8, ROAD_Y = 0.14;
const curve = new THREE.CatmullRomCurve3(CTRL.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'catmullrom', 0.6);
const N = 2200;
const pts = curve.getSpacedPoints(N); pts.pop();
const L = curve.getLength(), DS = L / N;
const S = pts.map(p => ({ x: p.x, z: p.z, y: terrainH(p.x, p.z) + ROAD_Y, tx: 0, tz: 0, lx: 0, lz: 0, k: 0 }));
for (let i = 0; i < N; i++) {
  const a = S[(i - 1 + N) % N], b = S[(i + 1) % N]; let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz); tx /= l; tz /= l;
  S[i].tx = tx; S[i].tz = tz; S[i].lx = tz; S[i].lz = -tx;
}
for (let i = 0; i < N; i++) { const a = S[(i - 2 + N) % N], b = S[(i + 2) % N]; S[i].k = wrapAngle(Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz)) / (4 * DS); }
const trackPoint = (dist, lat, out) => {
  dist = ((dist % L) + L) % L; const f = dist / DS; const i = Math.floor(f) % N, j = (i + 1) % N, t = f - Math.floor(f);
  const x = lerp(S[i].x, S[j].x, t) + lerp(S[i].lx, S[j].lx, t) * lat, z = lerp(S[i].z, S[j].z, t) + lerp(S[i].lz, S[j].lz, t) * lat;
  out = out || new THREE.Vector3(); out.set(x, terrainH(x, z) + ROAD_Y, z); return out;
};
const headingAt = i => Math.atan2(S[i].tx, S[i].tz);
function nearestSample(x, z, guess, span) {
  let best = -1, bd = Infinity;
  if (guess < 0) { for (let i = 0; i < N; i += 4) { const d = (S[i].x - x) ** 2 + (S[i].z - z) ** 2; if (d < bd) { bd = d; best = i; } } guess = best; span = 8; }
  bd = Infinity; for (let o = -span; o <= span; o++) { const i = (guess + o + N * 4) % N; const d = (S[i].x - x) ** 2 + (S[i].z - z) ** 2; if (d < bd) { bd = d; best = i; } }
  return best;
}

/* racing line: relax offsets toward a smooth path inside the corridor */
const RL = new Float32Array(N), RLM = HW - 1.6;
{
  const px = new Float32Array(N), pz = new Float32Array(N);
  for (let it = 0; it < 260; it++) {
    for (let i = 0; i < N; i++) { px[i] = S[i].x + S[i].lx * RL[i]; pz[i] = S[i].z + S[i].lz * RL[i]; }
    const W = 14;
    for (let i = 0; i < N; i++) {
      let ax = 0, az = 0; for (let o = -W; o <= W; o++) { const j = (i + o + N) % N; ax += px[j]; az += pz[j]; }
      ax /= 2 * W + 1; az /= 2 * W + 1;
      const off = (ax - S[i].x) * S[i].lx + (az - S[i].z) * S[i].lz;
      RL[i] = clamp(lerp(RL[i], off, 0.5), -RLM, RLM);
    }
  }
  for (let pass = 0; pass < 3; pass++) { const c = Float32Array.from(RL); for (let i = 0; i < N; i++) RL[i] = (c[(i - 1 + N) % N] + c[i] + c[(i + 1) % N]) / 3; }
}
const RLX = new Float32Array(N), RLZ = new Float32Array(N), RLK = new Float32Array(N);
for (let i = 0; i < N; i++) { RLX[i] = S[i].x + S[i].lx * RL[i]; RLZ[i] = S[i].z + S[i].lz * RL[i]; }
for (let i = 0; i < N; i++) {
  const a = (i - 3 + N) % N, b = (i + 3) % N, c = (i - 9 + N) % N, d = (i + 9) % N;
  const h1 = Math.atan2(RLX[b] - RLX[a], RLZ[b] - RLZ[a]), h0 = Math.atan2(RLX[a] - RLX[c], RLZ[a] - RLZ[c]), h2 = Math.atan2(RLX[d] - RLX[b], RLZ[d] - RLZ[b]);
  RLK[i] = Math.abs(wrapAngle(h2 - h0)) / (12 * DS);
}
for (let pass = 0; pass < 4; pass++) { const c = Float32Array.from(RLK); for (let i = 0; i < N; i++) RLK[i] = (c[(i - 2 + N) % N] + c[(i - 1 + N) % N] + c[i] + c[(i + 1) % N] + c[(i + 2) % N]) / 5; }

/* road / curbs / shoulders / snow banks as one vertex-colored mesh */
function stripMesh(defs) {
  const pos = [], col = [], c = new THREE.Color();
  const push = (x, y, z, cc) => { pos.push(x, y, z); col.push(cc.r, cc.g, cc.b); };
  for (const d of defs) for (let i = 0; i < N; i++) {
    const a = S[i], b = S[(i + 1) % N];
    const va = (s, lat, dy) => [s.x + s.lx * lat, terrainH(s.x + s.lx * lat, s.z + s.lz * lat) + dy, s.z + s.lz * lat];
    const c0 = d.color(i), A0 = va(a, d.l0, d.y0), A1 = va(a, d.l1, d.y1), B0 = va(b, d.l0, d.y0), B1 = va(b, d.l1, d.y1);
    push(...A0, c0); push(...B0, c0); push(...A1, c0); push(...A1, c0); push(...B0, c0); push(...B1, c0);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3)); g.computeVertexNormals();
  return g;
}
const ASPH = new THREE.Color(0x3b4150), CURB_B = new THREE.Color(0x2f6df6), CURB_W = new THREE.Color(0xf4f8ff), SLUSH = new THREE.Color(0xd8e4f8), BANK = new THREE.Color(0xeef3ff);
const tmpC = new THREE.Color();
const roadGeo = stripMesh([
  { l0: -HW, l1: HW, y0: ROAD_Y, y1: ROAD_Y, color: i => tmpC.copy(ASPH).multiplyScalar(0.94 + 0.12 * ((i * 7919) % 13) / 13) },
  { l0: HW, l1: HW + CURB, y0: ROAD_Y + 0.05, y1: ROAD_Y + 0.05, color: i => (Math.floor(i / 7) % 2 ? CURB_B : CURB_W) },
  { l0: -HW - CURB, l1: -HW, y0: ROAD_Y + 0.05, y1: ROAD_Y + 0.05, color: i => (Math.floor(i / 7) % 2 ? CURB_W : CURB_B) },
  { l0: HW + CURB, l1: WALL, y0: ROAD_Y - 0.02, y1: 0.02, color: () => SLUSH },
  { l0: -WALL, l1: -HW - CURB, y0: 0.02, y1: ROAD_Y - 0.02, color: () => SLUSH },
  { l0: WALL, l1: WALL + 1.6, y0: 0.02, y1: 1.7, color: () => BANK }, { l0: WALL + 1.6, l1: WALL + 4.2, y0: 1.7, y1: 0.1, color: () => BANK },
  { l0: -WALL - 1.6, l1: -WALL, y0: 1.7, y1: 0.02, color: () => BANK }, { l0: -WALL - 4.2, l1: -WALL - 1.6, y0: 0.1, y1: 1.7, color: () => BANK },
]);
scene.add(new THREE.Mesh(roadGeo, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 })));

/* ============================================================ scenery helpers */
function mergeGeoms(items) {
  const pos = [], nor = [], col = [], c = new THREE.Color();
  for (const it of items) {
    let g = it.geo.index ? it.geo.toNonIndexed() : it.geo.clone(); if (it.m) g.applyMatrix4(it.m);
    if (!g.attributes.normal) g.computeVertexNormals();
    const p = g.attributes.position, n = g.attributes.normal; c.set(it.color);
    for (let i = 0; i < p.count; i++) { pos.push(p.getX(i), p.getY(i), p.getZ(i)); nor.push(n.getX(i), n.getY(i), n.getZ(i)); col.push(c.r, c.g, c.b); }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}
const M4 = (x, y, z, ry = 0, sx = 1, sy = sx, sz = sx, rx = 0, rz = 0) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
const flatMat = (opts = {}) => new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.85, ...opts });
const vcMat = (opts = {}) => flatMat({ vertexColors: true, ...opts });
const trackDistOf = (x, z) => { let b = 0, bd = Infinity; for (let i = 0; i < N; i += 2) { const d = (S[i].x - x) ** 2 + (S[i].z - z) ** 2; if (d < bd) { bd = d; b = i; } } return { dist: b * DS, d: Math.sqrt(bd) }; };
function placeOnTrack(obj, dist, lat, faceTrack = true) {
  const p = trackPoint(dist, lat); const i = Math.floor(((dist % L) + L) % L / DS) % N;
  obj.position.set(p.x, terrainH(p.x, p.z), p.z); obj.rotation.y = headingAt(i) + (faceTrack ? (lat > 0 ? -Math.PI / 2 : Math.PI / 2) : 0); return obj;
}

/* start line, grid boxes */
{
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64; const g = cv.getContext('2d');
  for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#fff'; g.fillRect(x * 32, y * 32, 32, 32); }
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const line = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 3.2), new THREE.MeshBasicMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2 }));
  line.rotation.x = -Math.PI / 2; const p = trackPoint(0, 0); line.position.set(p.x, p.y + 0.02, p.z); line.rotation.z = -headingAt(0); scene.add(line);
  const gridMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -2 });
  for (let i = 0; i < 8; i++) { const m = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3.4), gridMat); m.rotation.x = -Math.PI / 2; const q = trackPoint(L - 9 - Math.floor(i / 2) * 6, i % 2 ? -2.8 : 2.8); m.position.set(q.x, q.y + 0.02, q.z); m.rotation.z = -headingAt(Math.floor((L - 9 - Math.floor(i / 2) * 6) / DS)); scene.add(m); }
}

/* gantry with lights */
const gantryLights = [];
{
  const g = new THREE.Group(); const dark = flatMat({ color: 0x23283a }); const pillarG = new THREE.BoxGeometry(1.4, 9.5, 1.4);
  for (const s of [-1, 1]) { const pl = new THREE.Mesh(pillarG, dark); pl.position.set(s * (WALL + 1.2), 4.75, 0); g.add(pl); }
  const beam = new THREE.Mesh(new THREE.BoxGeometry(WALL * 2 + 4, 2.4, 1.6), dark); beam.position.y = 9.4; g.add(beam);
  const cv = document.createElement('canvas'); cv.width = 1024; cv.height = 128; const c = cv.getContext('2d');
  for (let y = 0; y < 4; y++) for (let x = 0; x < 32; x++) { c.fillStyle = (x + y) % 2 ? '#15181f' : '#f6f8ff'; c.fillRect(x * 32, y * 32, 32, 32); }
  c.fillStyle = 'rgba(20,24,40,.9)'; c.fillRect(256, 16, 512, 96); c.fillStyle = '#ffd54a'; c.font = 'bold 72px Trebuchet MS, Arial'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('FROSTLINE', 512, 66);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const panel = new THREE.Mesh(new THREE.BoxGeometry(WALL * 2 + 2, 3.2, 0.5), [null, null, null, null, new THREE.MeshBasicMaterial({ map: tex }), new THREE.MeshBasicMaterial({ map: tex })].map(m => m || dark)); panel.position.y = 12.2; g.add(panel);
  for (const s of [-1, 1]) { const fl = new THREE.Mesh(new THREE.BoxGeometry(1, 0.6, 0.6), flatMat({ color: 0xfff2c0, emissive: 0xffe6a0, emissiveIntensity: 1.5 })); fl.position.set(s * 6, 8.0, 0.9); g.add(fl); }
  const lampG = new THREE.SphereGeometry(0.55, 10, 8);
  for (let i = 0; i < 5; i++) { const m = new THREE.Mesh(lampG, new THREE.MeshStandardMaterial({ color: 0x331111, emissive: 0x330000, emissiveIntensity: 1 })); m.position.set((i - 2) * 1.8, 7.9, 0.6); g.add(m); gantryLights.push(m); }
  placeOnTrack(g, 0, 0, false); scene.add(g);
  const pl = new THREE.PointLight(0xfff0c8, 60, 60); pl.position.set(0, 8, 2); g.add(pl);
}
function setGantry(stage) { // 0 idle,1..3 reds, 4 green
  gantryLights.forEach((m, i) => { const on = stage === 4 ? true : i < stage * 2 - 1; const g = stage === 4; m.material.color.set(on ? (g ? 0x30ff70 : 0xff3030) : 0x331111); m.material.emissive.set(on ? (g ? 0x20ff60 : 0xff2020) : 0x220000); m.material.emissiveIntensity = on ? 2.5 : 0.6; });
}

/* grandstands */
const crowdBodyMat = flatMat({ roughness: 0.7 }), crowdHeadMat = flatMat({ roughness: 0.7 });
const crowdShader = s => { s.uniforms.uTime = timeU; s.vertexShader = 'uniform float uTime;\n' + s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  #ifdef USE_INSTANCING
  float ph = float(gl_InstanceID) * 1.618; float j = step(0.55, fract(ph * 0.37)) * max(0.0, sin(uTime * 5.0 + ph)) * 0.45; transformed.y += j;
  #endif`); };
crowdBodyMat.onBeforeCompile = crowdShader; crowdHeadMat.onBeforeCompile = crowdShader;
const CROWD_COLORS = [0xff4b4b, 0x3b82f6, 0xfbbf24, 0x22c55e, 0xf472b6, 0xf97316, 0xa78bfa, 0xffffff, 0x14b8a6];
const standDefs = [];
function grandstand(dist, lat, len, rows = 6) {
  const g = new THREE.Group(); const step = 2.2, rise = 1.4, seats = Math.floor(len / 1.25);
  const concrete = flatMat({ color: 0x8d94ab }), steel = flatMat({ color: 0x3a4158 });
  for (let r = 0; r < rows; r++) { const m = new THREE.Mesh(new THREE.BoxGeometry(len, rise * (r + 1), step), concrete); m.position.set(0, rise * (r + 1) / 2, r * step + step / 2); g.add(m); }
  const back = new THREE.Mesh(new THREE.BoxGeometry(len + 1, rows * rise + 6, 0.5), steel); back.position.set(0, (rows * rise + 6) / 2, rows * step + 0.3); g.add(back);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 2, 0.5, rows * step + 3), flatMat({ color: 0x1f6fd6 })); roof.position.set(0, rows * rise + 6, rows * step / 2 + 0.6); roof.rotation.x = 0.12; g.add(roof);
  for (const s of [-1, 1]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, rows * rise + 6, 6), steel); post.position.set(s * (len / 2 + 0.5), (rows * rise + 6) / 2, 0.5); g.add(post); }
  const stripe = new THREE.Mesh(new THREE.BoxGeometry(len, 1.2, 0.2), flatMat({ color: 0xffffff })); stripe.position.set(0, rise * 0.6, -0.1); g.add(stripe);
  placeOnTrack(g, dist, lat, true); g.rotation.y += Math.PI; g.updateMatrixWorld(true);
  standDefs.push({ g, rows, seats, len, step, rise }); scene.add(g);
}
grandstand(28, WALL + 8, 60); grandstand(110, WALL + 8, 60); grandstand(560, WALL + 8, 44, 5); grandstand(980, WALL + 8, 44, 5);
{
  const total = standDefs.reduce((a, d) => a + d.rows * d.seats, 0);
  const bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(0.75, 1.0, 0.6), crowdBodyMat, total), heads = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.34, 1), crowdHeadMat, total);
  let k = 0; const m = new THREE.Matrix4(), v = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), col = new THREE.Color();
  for (const d of standDefs) for (let r = 0; r < d.rows; r++) for (let s = 0; s < d.seats; s++) {
    v.set(-d.len / 2 + 0.7 + s * 1.25 + rr(-0.15, 0.15), d.rise * (r + 1) + 0.5, r * d.step + d.step * 0.55); v.applyMatrix4(d.g.matrixWorld);
    q.setFromEuler(new THREE.Euler(0, d.g.rotation.y + rr(-0.3, 0.3), 0));
    m.compose(v, q, sc); bodies.setMatrixAt(k, m); bodies.setColorAt(k, col.set(CROWD_COLORS[Math.floor(rnd() * CROWD_COLORS.length)]));
    v.y += 0.85; m.compose(v, q, sc); heads.setMatrixAt(k, m); heads.setColorAt(k, col.set(rnd() < 0.5 ? 0xf1c9a5 : CROWD_COLORS[Math.floor(rnd() * CROWD_COLORS.length)]));
    k++;
  }
  scene.add(bodies, heads);
}
const crowdFlashSpots = []; for (const d of standDefs) for (let i = 0; i < 12; i++) { const v = new THREE.Vector3(rr(-d.len / 2, d.len / 2), d.rise * rr(1, d.rows) + 1.2, rr(0, d.rows * d.step)); v.applyMatrix4(d.g.matrixWorld); crowdFlashSpots.push(v); }

/* pines */
const pineGeo = mergeGeoms([
  { geo: new THREE.CylinderGeometry(0.35, 0.5, 2.4, 6), m: M4(0, 1.2, 0), color: 0x5a3a22 },
  { geo: new THREE.ConeGeometry(3.2, 4.2, 7), m: M4(0, 3.6, 0), color: 0x1f6b3a }, { geo: new THREE.ConeGeometry(2.5, 3.6, 7), m: M4(0, 6.0, 0, 0.3), color: 0x2a7d45 }, { geo: new THREE.ConeGeometry(1.7, 3.0, 7), m: M4(0, 8.2, 0, 0.6), color: 0x35905a },
  { geo: new THREE.ConeGeometry(3.25, 1.2, 7), m: M4(0, 5.35, 0), color: 0xf3f7ff }, { geo: new THREE.ConeGeometry(2.55, 1.0, 7), m: M4(0, 7.45, 0, 0.3), color: 0xf3f7ff }, { geo: new THREE.ConeGeometry(1.75, 0.9, 7), m: M4(0, 9.3, 0, 0.6), color: 0xf3f7ff },
]);
{
  const spots = []; let tries = 0;
  while (spots.length < 900 && tries++ < 20000) {
    const a = rnd() * Math.PI * 2, r = 30 + Math.pow(rnd(), 0.6) * 520; const x = Math.cos(a) * r - 10, z = Math.sin(a) * r + 80;
    const td = trackDistOf(x, z); if (td.d < WALL + 8) continue; if (Math.hypot(x, z) > 620) continue;
    let ok = true; for (const d of standDefs) if (d.g.position.distanceTo(new THREE.Vector3(x, 0, z)) < d.len / 2 + 10) ok = false; if (!ok) continue;
    spots.push([x, z]);
  }
  const im = new THREE.InstancedMesh(pineGeo, vcMat(), spots.length); const m = new THREE.Matrix4();
  spots.forEach(([x, z], i) => { const s = rr(0.7, 1.6); im.setMatrixAt(i, M4(x, terrainH(x, z) - 0.2, z, rnd() * 6.28, s, s * rr(0.9, 1.3), s)); });
  scene.add(im);
}
/* mountains */
{
  const geo = mergeGeoms([{ geo: new THREE.ConeGeometry(1, 1, 6), m: M4(0, 0.5, 0), color: 0x7a86a8 }, { geo: new THREE.ConeGeometry(0.42, 0.42, 6), m: M4(0, 0.79, 0), color: 0xf4f7ff }]);
  const im = new THREE.InstancedMesh(geo, vcMat(), 34);
  for (let i = 0; i < 34; i++) { const a = i / 34 * Math.PI * 2 + rr(-0.1, 0.1), r = rr(520, 760); const x = Math.cos(a) * r, z = Math.sin(a) * r + 80; const w = rr(120, 260), h = rr(150, 330); im.setMatrixAt(i, M4(x, terrainH(x, z) - 20, z, rnd() * 6.28, w, h, w * rr(0.8, 1.2))); }
  scene.add(im);
}
/* snowmen */
{
  const geo = mergeGeoms([
    { geo: new THREE.IcosahedronGeometry(1.25, 1), m: M4(0, 1.15, 0), color: 0xf6f9ff }, { geo: new THREE.IcosahedronGeometry(0.95, 1), m: M4(0, 2.9, 0), color: 0xf6f9ff }, { geo: new THREE.IcosahedronGeometry(0.7, 1), m: M4(0, 4.2, 0), color: 0xf6f9ff },
    { geo: new THREE.ConeGeometry(0.16, 0.9, 6), m: M4(0, 4.25, 0.9, 0, 1, 1, 1, Math.PI / 2), color: 0xff7a1a },
    { geo: new THREE.SphereGeometry(0.1, 6, 4), m: M4(-0.25, 4.45, 0.62), color: 0x111111 }, { geo: new THREE.SphereGeometry(0.1, 6, 4), m: M4(0.25, 4.45, 0.62), color: 0x111111 },
    { geo: new THREE.CylinderGeometry(0.55, 0.55, 0.9, 8), m: M4(0, 5.2, 0), color: 0x202030 }, { geo: new THREE.CylinderGeometry(0.95, 0.95, 0.12, 8), m: M4(0, 4.8, 0), color: 0x202030 },
    { geo: new THREE.TorusGeometry(0.72, 0.16, 6, 10), m: M4(0, 3.65, 0, 0, 1, 1, 1, Math.PI / 2), color: 0xe63946 },
    { geo: new THREE.CylinderGeometry(0.07, 0.1, 2.2, 5), m: M4(-1.3, 3.3, 0, 0, 1, 1, 1, 0, 1.1), color: 0x5a3a22 }, { geo: new THREE.CylinderGeometry(0.07, 0.1, 2.2, 5), m: M4(1.3, 3.3, 0, 0, 1, 1, 1, 0, -1.1), color: 0x5a3a22 },
    { geo: new THREE.SphereGeometry(0.09, 5, 4), m: M4(0, 3.1, 0.92), color: 0x111111 }, { geo: new THREE.SphereGeometry(0.09, 5, 4), m: M4(0, 2.6, 0.92), color: 0x111111 },
  ]);
  const im = new THREE.InstancedMesh(geo, vcMat(), 14);
  for (let i = 0; i < 14; i++) { const dist = i / 14 * L + rr(0, 40), lat = (rnd() < 0.5 ? -1 : 1) * rr(WALL + 5, WALL + 11); const p = trackPoint(dist, lat); const s = rr(0.8, 1.3); im.setMatrixAt(i, M4(p.x, terrainH(p.x, p.z) - 0.1, p.z, rnd() * 6.28, s)); }
  scene.add(im);
}
/* flags along the track */
const flagMat = flatMat({ side: THREE.DoubleSide }); flagMat.onBeforeCompile = s => { s.uniforms.uTime = timeU; s.vertexShader = 'uniform float uTime;\n' + s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
  #ifdef USE_INSTANCING
  float fx = max(0.0, position.x); transformed.z += sin(uTime * 6.0 + fx * 2.5 + float(gl_InstanceID)) * 0.22 * fx; transformed.y += sin(uTime * 4.0 + fx * 3.0 + float(gl_InstanceID)) * 0.06 * fx;
  #endif`); };
{
  const poles = 44; const poleIm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.16, 7, 6), flatMat({ color: 0xdfe6f5 }), poles);
  const flagGeo = new THREE.PlaneGeometry(2.4, 1.4, 6, 1); flagGeo.translate(1.2, 0, 0); const flagIm = new THREE.InstancedMesh(flagGeo, flagMat, poles); const col = new THREE.Color();
  for (let i = 0; i < poles; i++) { const dist = i / poles * L + 12, lat = (i % 2 ? -1 : 1) * (WALL + 3); const p = trackPoint(dist, lat); const h = headingAt(Math.floor(dist / DS) % N); const y = terrainH(p.x, p.z);
    poleIm.setMatrixAt(i, M4(p.x, y + 3.5, p.z)); flagIm.setMatrixAt(i, M4(p.x, y + 6.2, p.z, h + Math.PI / 2 * (lat > 0 ? 1 : -1))); flagIm.setColorAt(i, col.set(CROWD_COLORS[i % CROWD_COLORS.length])); }
  scene.add(poleIm, flagIm);
}
/* bunting near the start */
{
  const n = 120; const im = new THREE.InstancedMesh(new THREE.ConeGeometry(0.35, 0.8, 3), flagMat, n); const col = new THREE.Color();
  for (let i = 0; i < n; i++) { const dist = 12 + (i % 40) * 1.2 - 24 + (i < 40 ? 0 : i < 80 ? 60 : 130), lat = 0; const p = trackPoint(dist, lat); im.setMatrixAt(i, M4(p.x, p.y + 10.2 + Math.sin((i % 40) / 40 * Math.PI) * -1.6, p.z, 0, 1, 1, 1, Math.PI)); im.setColorAt(i, col.set(CROWD_COLORS[i % 5])); }
  scene.add(im);
  for (const d of [-12, 48, 118, 168]) for (const s of [-1, 1]) { const p = trackPoint(d, s * (WALL + 1)); const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 10.5, 6), flatMat({ color: 0xdfe6f5 })); post.position.set(p.x, terrainH(p.x, p.z) + 5.25, p.z); scene.add(post); }
}
/* cabins with lit windows and chimney */
const chimneys = [];
function cabin(x, z, ry, s = 1) {
  const g = new THREE.Group(); const wood = flatMat({ color: 0x8b5a2b }), snowM = flatMat({ color: 0xf2f6ff }), glow = flatMat({ color: 0xffd080, emissive: 0xffb040, emissiveIntensity: 1.6 });
  const walls = new THREE.Mesh(new THREE.BoxGeometry(12, 6, 9), wood); walls.position.set(0, 3, 0); g.add(walls);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(8.8, 4.5, 4), snowM); roof.position.y = 8.2; roof.rotation.y = Math.PI / 4; roof.scale.set(1, 1, 0.8); g.add(roof);
  const roofU = new THREE.Mesh(new THREE.ConeGeometry(8.4, 4.2, 4), flatMat({ color: 0x5a3a22 })); roofU.position.y = 7.9; roofU.rotation.y = Math.PI / 4; roofU.scale.set(1, 1, 0.8); g.add(roofU);
  for (const [wx, wz] of [[-3.5, 4.55], [3.5, 4.55], [-6.05, 0], [6.05, 0], [-3.5, -4.55], [3.5, -4.55]]) { const w = new THREE.Mesh(new THREE.BoxGeometry(2, 1.8, 0.2), glow); w.position.set(wx, 3.3, wz); if (Math.abs(wx) > 6) w.rotation.y = Math.PI / 2; g.add(w); }
  const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3, 0.2), flatMat({ color: 0x3b2314 })); door.position.set(0, 1.5, 4.55); g.add(door);
  const ch = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4, 1.2), flatMat({ color: 0x6b6f80 })); ch.position.set(3, 8.5, -1.5); g.add(ch);
  const pl = new THREE.PointLight(0xffb060, 40, 40); pl.position.set(0, 4, 6); g.add(pl);
  g.position.set(x, terrainH(x, z) - 0.2, z); g.rotation.y = ry; g.scale.setScalar(s); scene.add(g);
  chimneys.push(new THREE.Vector3(3, 10.5, -1.5).applyMatrix4(g.matrix.compose(g.position, g.quaternion, g.scale)));
}
cabin(60, 70, 0.4); cabin(-125, 75, -1.9, 1.15); cabin(210, 150, 2.4, 0.9);

/* frozen pond + ice crystals */
{
  const pond = new THREE.Mesh(new THREE.CircleGeometry(20, 24), new THREE.MeshStandardMaterial({ color: 0xa9d6ff, roughness: 0.15, metalness: 0.4 })); pond.rotation.x = -Math.PI / 2; pond.scale.set(1.5, 1, 1); pond.position.set(40, terrainH(40, 60) + 0.15, 60); scene.add(pond);
  const crystal = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0xa8e8ff, emissive: 0x3ab0ff, emissiveIntensity: 0.6, flatShading: true, transparent: true, opacity: 0.85 }), 60);
  for (let i = 0; i < 60; i++) { const dist = rnd() * L, lat = (rnd() < 0.5 ? -1 : 1) * rr(WALL + 4.5, WALL + 9); const p = trackPoint(dist, lat); crystal.setMatrixAt(i, M4(p.x, terrainH(p.x, p.z) + 0.8, p.z, rnd() * 3, rr(0.5, 1.2), rr(1.2, 3.2), rr(0.5, 1.2), rr(-0.3, 0.3), rr(-0.3, 0.3))); }
  scene.add(crystal);
}
/* lamp posts */
{
  const im = new THREE.InstancedMesh(mergeGeoms([{ geo: new THREE.CylinderGeometry(0.14, 0.2, 8, 6), m: M4(0, 4, 0), color: 0x2c3247 }, { geo: new THREE.BoxGeometry(1.6, 0.6, 0.9), m: M4(0, 8.1, 0), color: 0x2c3247 }]), vcMat(), 20);
  const lampIm = new THREE.InstancedMesh(new THREE.BoxGeometry(1.3, 0.25, 0.7), new THREE.MeshBasicMaterial({ color: 0xffe9b0 }), 20);
  for (let i = 0; i < 20; i++) { const dist = i / 20 * L + 30, lat = (i % 2 ? 1 : -1) * (WALL + 2.4); const p = trackPoint(dist, lat); const y = terrainH(p.x, p.z); im.setMatrixAt(i, M4(p.x, y, p.z)); lampIm.setMatrixAt(i, M4(p.x, y + 7.75, p.z)); }
  scene.add(im, lampIm);
}
/* hot-air balloons */
const balloons = [];
function balloon(x, z, y, c1, c2) {
  const g = new THREE.Group(); const env = new THREE.SphereGeometry(7, 12, 8); const col = new Float32Array(env.attributes.position.count * 3); const p = env.attributes.position; const A = new THREE.Color(c1), B = new THREE.Color(c2);
  for (let i = 0; i < p.count; i++) { const a = Math.atan2(p.getX(i), p.getZ(i)); const c = Math.floor((a + Math.PI) / (Math.PI * 2) * 12) % 2 ? A : B; col[i*3] = c.r; col[i*3+1] = c.g; col[i*3+2] = c.b; }
  env.setAttribute('color', new THREE.BufferAttribute(col, 3)); env.scale(1, 1.2, 1);
  g.add(new THREE.Mesh(env, vcMat({ emissive: 0xff8020, emissiveIntensity: 0.25 })));
  const basket = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.8, 2.4), flatMat({ color: 0x7a4a22 })); basket.position.y = -11.5; g.add(basket);
  const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 4, 4), flatMat({ color: 0xcccccc }));
  for (const [rx, rz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const r = rope.clone(); r.position.set(rx, -9, rz); g.add(r); }
  const flame = new THREE.PointLight(0xff9040, 30, 30); flame.position.y = -8; g.add(flame);
  g.position.set(x, y, z); scene.add(g); balloons.push({ g, x, z, y, ph: rnd() * 6 });
}
balloon(60, 110, 55, 0xff4b4b, 0xfff3c0); balloon(-130, 40, 70, 0x3b82f6, 0xffd54a); balloon(190, 40, 62, 0x22c55e, 0xffffff);

/* snowfall */
const snow = { n: 2200, geo: new THREE.BufferGeometry(), range: 90 };
{
  const p = new Float32Array(snow.n * 3); for (let i = 0; i < snow.n; i++) { p[i*3] = rr(-snow.range, snow.range); p[i*3+1] = rr(0, 60); p[i*3+2] = rr(-snow.range, snow.range); }
  snow.geo.setAttribute('position', new THREE.BufferAttribute(p, 3)); snow.pts = new THREE.Points(snow.geo, new THREE.PointsMaterial({ color: 0xffffff, size: 0.28, transparent: true, opacity: 0.8 })); snow.pts.frustumCulled = false; scene.add(snow.pts);
  snow.vel = new Float32Array(snow.n).map(() => rr(3, 7));
}

/* particle pool (cubes) */
const PMAX = 600;
const particles = { mesh: new THREE.InstancedMesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }), PMAX), data: [], next: 0 };
particles.mesh.frustumCulled = false; scene.add(particles.mesh);
for (let i = 0; i < PMAX; i++) particles.data.push({ life: 0, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: 1, g: 0 });
const pcol = new THREE.Color();
function spawnP(x, y, z, vx, vy, vz, life, color, s = 1, g = 0) {
  const d = particles.data[particles.next]; particles.next = (particles.next + 1) % PMAX; Object.assign(d, { life, max: life, x, y, z, vx, vy, vz, s, g }); particles.mesh.setColorAt(particles.next === 0 ? PMAX - 1 : particles.next - 1, pcol.set(color)); particles.mesh.instanceColor.needsUpdate = true;
}
const pm = new THREE.Matrix4(), pq = new THREE.Quaternion(), pv = new THREE.Vector3(), ps = new THREE.Vector3();
function updateParticles(dt) {
  for (let i = 0; i < PMAX; i++) { const d = particles.data[i];
    if (d.life > 0) { d.life -= dt; d.vy -= d.g * dt; d.x += d.vx * dt; d.y += d.vy * dt; d.z += d.vz * dt; const s = d.s * clamp(d.life / d.max, 0, 1); pv.set(d.x, d.y, d.z); pq.setFromEuler(new THREE.Euler(d.life * 3, d.life * 5, 0)); ps.set(s, s, s); pm.compose(pv, pq, ps); }
    else { ps.set(0, 0, 0); pm.compose(pv.set(0, -100, 0), pq, ps); }
    particles.mesh.setMatrixAt(i, pm); }
  particles.mesh.instanceMatrix.needsUpdate = true;
}

/* ============================================================ karts */
const VMAX = 32, ACC = 18, BOOST_ACC = 52, BRAKE = 30, REV_MAX = 9, TURN = 2.6, TURN_HI = 0.55, GRIP = 7.5, KART_R = 1.3;
const CP = 12, CPL = L / CP;
const wrapHalf = d => { d = ((d % L) + L) % L; return d > L / 2 ? d - L : d; };
const r2 = v => Math.round((v > 0 ? v : 0) * 100) / 100;

function buildKart(def) {
  const g = new THREE.Group(), body = new THREE.Group(); g.add(body);
  const bodyMat = flatMat({ color: def.color, roughness: 0.5 }), darkMat = flatMat({ color: 0x1c2030 }), chromeMat = flatMat({ color: 0xc8d0e0, roughness: 0.3, metalness: 0.5 }), suitMat = flatMat({ color: new THREE.Color(def.color).multiplyScalar(0.55) });
  const add = (geo, mat, x, y, z, rx = 0, ry = 0, rz = 0, parent = body) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.rotation.set(rx, ry, rz); parent.add(m); return m; };
  add(new THREE.BoxGeometry(1.7, 0.5, 2.7), bodyMat, 0, 0.55, 0);
  add(new THREE.BoxGeometry(1.1, 0.4, 1.0), bodyMat, 0, 0.62, 1.6).rotation.x = 0.18;
  add(new THREE.BoxGeometry(0.7, 0.16, 0.3), chromeMat, 0, 0.9, 2.05);
  add(new THREE.BoxGeometry(2.1, 0.22, 0.55), darkMat, 0, 0.36, 0.9); add(new THREE.BoxGeometry(2.1, 0.22, 0.55), darkMat, 0, 0.36, -0.95);
  add(new THREE.BoxGeometry(1.5, 0.55, 0.7), darkMat, 0, 0.85, -1.15);
  add(new THREE.BoxGeometry(1.9, 0.1, 0.6), bodyMat, 0, 1.45, -1.45); add(new THREE.BoxGeometry(0.1, 0.4, 0.4), darkMat, -0.75, 1.2, -1.45); add(new THREE.BoxGeometry(0.1, 0.4, 0.4), darkMat, 0.75, 1.2, -1.45);
  for (const s of [-1, 1]) { add(new THREE.CylinderGeometry(0.12, 0.14, 0.7, 6), chromeMat, s * 0.45, 0.75, -1.65, Math.PI / 2 + 0.3); add(new THREE.BoxGeometry(0.3, 0.16, 0.1), flatMat({ color: 0xfff6c0, emissive: 0xffe8a0, emissiveIntensity: 2 }), s * 0.55, 0.75, 2.12); }
  add(new THREE.BoxGeometry(1.0, 0.7, 0.5), darkMat, 0, 1.05, -0.55);
  const driver = new THREE.Group(); driver.position.set(0, 0.85, -0.25); body.add(driver);
  add(new THREE.BoxGeometry(0.8, 0.7, 0.55), suitMat, 0, 0.4, 0, 0, 0, 0, driver);
  add(new THREE.CylinderGeometry(0.12, 0.12, 0.7, 5), suitMat, -0.45, 0.55, 0.25, 0.9, 0, 0.3, driver); add(new THREE.CylinderGeometry(0.12, 0.12, 0.7, 5), suitMat, 0.45, 0.55, 0.25, 0.9, 0, -0.3, driver);
  const head = new THREE.Group(); head.position.set(0, 1.05, 0); driver.add(head);
  add(new THREE.IcosahedronGeometry(0.42, 1), flatMat({ color: def.helmet, roughness: 0.4 }), 0, 0, 0, 0, 0, 0, head);
  add(new THREE.BoxGeometry(0.5, 0.2, 0.2), flatMat({ color: 0x111622, roughness: 0.2, metalness: 0.4 }), 0, 0.02, 0.36, 0, 0, 0, head);
  add(new THREE.BoxGeometry(0.16, 0.16, 0.16), bodyMat, 0, 0.45, 0, 0, 0, 0, head);
  add(new THREE.TorusGeometry(0.28, 0.05, 6, 10), darkMat, 0, 1.1, 0.5, -1.1);
  const wheelGeo = new THREE.CylinderGeometry(0.4, 0.4, 0.36, 10); wheelGeo.rotateZ(Math.PI / 2);
  const hubGeo = new THREE.CylinderGeometry(0.22, 0.22, 0.38, 6); hubGeo.rotateZ(Math.PI / 2);
  const wheels = [], pivots = []; const tyre = flatMat({ color: 0x1a1d26, roughness: 0.9 });
  for (const [x, z] of [[-1.0, 1.0], [1.0, 1.0], [-1.0, -0.95], [1.0, -0.95]]) {
    const piv = new THREE.Group(); piv.position.set(x, 0.4, z); body.add(piv); const w = new THREE.Mesh(wheelGeo, tyre); piv.add(w); const hub = new THREE.Mesh(hubGeo, chromeMat); w.add(hub); wheels.push(w); if (z > 0) pivots.push(piv);
  }
  const shadow = new THREE.Mesh(new THREE.CircleGeometry(1.6, 14), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -3 })); shadow.rotation.x = -Math.PI / 2; shadow.position.y = 0.03; shadow.scale.set(0.9, 1.1, 1); g.add(shadow);
  scene.add(g); return { g, body, wheels, pivots, head, bodyMat, shadow, label: null };
}

/* floating name tag for human karts */
function makeLabel(text, color) {
  const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64; const c = cv.getContext('2d');
  c.font = 'bold 34px Trebuchet MS, Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
  const w = Math.min(244, c.measureText(text).width + 30);
  c.fillStyle = 'rgba(6,10,28,.72)'; c.beginPath(); c.roundRect(128 - w / 2, 8, w, 48, 12); c.fill();
  c.strokeStyle = '#' + color.toString(16).padStart(6, '0'); c.lineWidth = 4; c.stroke();
  c.fillStyle = '#fff'; c.fillText(text, 128, 33);
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); sp.scale.set(6, 1.5, 1); sp.renderOrder = 5; sp.visible = false; scene.add(sp); return sp;
}
function setLabel(k, text) {
  if (k.vis.label) { scene.remove(k.vis.label); k.vis.label.material.map.dispose(); k.vis.label.material.dispose(); k.vis.label = null; }
  if (text) k.vis.label = makeLabel(text, k.color);
}

/* kart.kind: 'local' (driven here), 'remote' (another player's machine), 'ai' (driven by the host), 'none' (unused slot) */
const karts = SKINS.map((def, i) => {
  const vis = buildKart(def);
  return { id: i, name: def.name, color: def.color, kind: i === 0 ? 'local' : 'ai', pid: null, vis, buf: [], startDelay: 0, x: 0, y: 0, z: 0, h: 0, vx: 0, vz: 0, vf: 0, steer: 0, throttle: 0, idx: -1, dist: 0, lat: 0, lap: 0, cpNext: 0, score: 0, place: i + 1, finished: false, finishTime: 0,
    item: null, roulette: 0, boost: 0, spin: 0, spinAng: 0, star: 0, shrink: 0, hitCd: 0, wallCd: 0, offroad: false, lapTimes: [], lapStart: 0, wheelRot: 0, roll: 0, pitch: 0, prevVf: 0, steerVis: 0, wrongWay: 0,
    ai: { skill: 1, wander: 1, aggr: 0.5, lane: 0, laneTarget: 0, laneTimer: 0, stuck: 0, reverse: 0, itemTimer: 0, rubber: 1 } };
});
let me = karts[0];          // the kart driven on this machine
let active = karts;         // karts taking part in the current race
let isHost = true;          // this machine simulates AI karts, hazards and item boxes
let online = false;         // networked race
let gridOrder = karts.map(k => k.id);
const owned = k => k.kind === 'local' || (isHost && k.kind === 'ai');
const isMe = k => k === me;
const gridSlot = i => ({ dist: L - 9 - Math.floor(i / 2) * 6, lat: i % 2 ? -2.8 : 2.8 });
function resetKart(k, slot) {
  const s = gridSlot(slot); const p = trackPoint(s.dist, s.lat); const i = Math.floor(s.dist / DS) % N;
  Object.assign(k, { x: p.x, y: p.y, z: p.z, h: headingAt(i), vx: 0, vz: 0, vf: 0, steer: 0, throttle: 0, idx: i, dist: s.dist, lat: s.lat, lap: 0, cpNext: 0, score: 0, finished: false, finishTime: 0, item: null, roulette: 0, boost: 0, spin: 0, spinAng: 0, star: 0, shrink: 0, hitCd: 0, wallCd: 0, offroad: false, lapTimes: [], lapStart: 0, prevVf: 0, wrongWay: 0, startDelay: 0, buf: [] });
  k.ai = { skill: k.kind === 'ai' ? rr(0.93, 1.0) : 1, wander: rr(0.6, 1.4), aggr: rr(0.2, 0.9), lane: 0, laneTarget: 0, laneTimer: rr(0, 2), stuck: 0, reverse: 0, itemTimer: 0, rubber: 1 };
  k.vis.body.scale.setScalar(1); k.vis.bodyMat.color.set(k.color); k.vis.bodyMat.emissive.set(0); k.vis.bodyMat.emissiveIntensity = 0;
}

const kartVmax = k => VMAX * (k.boost > 0 ? 1.42 : 1) * (k.star > 0 ? 1.18 : 1) * (k.shrink > 0 ? 0.72 : 1) * (k.offroad && k.star <= 0 ? 0.55 : 1) * (k.kind === 'ai' ? k.ai.skill * k.ai.rubber : 1);
const turnRate = vf => TURN * (1 - TURN_HI * clamp(Math.abs(vf) / VMAX, 0, 1));

function kartStep(k, dt, canMove) {
  const fx = Math.sin(k.h), fz = Math.cos(k.h), lx = Math.cos(k.h), lz = -Math.sin(k.h);
  let vf = k.vx * fx + k.vz * fz, vl = k.vx * lx + k.vz * lz;
  const vmax = kartVmax(k);
  let throttle = canMove ? k.throttle : 0, steer = k.steer;
  if (k.spin > 0) { throttle = 0; steer = 0; k.spin -= dt; k.spinAng += dt * 10.5; vf *= Math.exp(-2.2 * dt); }
  if (k.boost > 0) { k.boost -= dt; if (vf < vmax) vf = Math.min(vmax, vf + BOOST_ACC * dt); }
  if (throttle > 0) { const acc = k.boost > 0 ? BOOST_ACC : ACC; vf += (throttle * acc - acc * Math.max(vf, 0) / vmax) * dt; }
  else if (throttle < 0) { if (vf > 0.4) vf -= BRAKE * dt; else vf = Math.max(vf - ACC * 0.6 * dt, -REV_MAX * -throttle); }
  else { vf -= Math.sign(vf) * Math.min(Math.abs(vf), (4 + Math.abs(vf) * 0.35) * dt); }
  if (vf > vmax * 1.02 && k.boost <= 0) vf -= (vf - vmax) * 1.6 * dt;
  const w = turnRate(vf) * clamp(vf / 6, -1, 1);
  k.h += steer * w * dt;
  if (Math.abs(steer) > 0.3 && Math.abs(vf) > 12) vl -= steer * Math.abs(vf) * 0.09 * dt; // a hint of slide
  vl *= Math.exp(-(k.spin > 0 ? 1.5 : GRIP) * dt);
  const nfx = Math.sin(k.h), nfz = Math.cos(k.h), nlx = Math.cos(k.h), nlz = -Math.sin(k.h);
  k.vx = nfx * vf + nlx * vl; k.vz = nfz * vf + nlz * vl; k.vf = vf;
  k.x += k.vx * dt; k.z += k.vz * dt;
  // track projection + walls
  k.idx = nearestSample(k.x, k.z, k.idx, k.idx < 0 ? 0 : 40);
  const s = S[k.idx]; const dx = k.x - s.x, dz = k.z - s.z; let lat = dx * s.lx + dz * s.lz; const along = clamp(dx * s.tx + dz * s.tz, -DS, DS);
  const lim = WALL - KART_R;
  if (Math.abs(lat) > lim) {
    const sign = Math.sign(lat); const over = Math.abs(lat) - lim; k.x -= s.lx * over * sign; k.z -= s.lz * over * sign; lat = sign * lim;
    const vn = k.vx * s.lx + k.vz * s.lz; if (vn * sign > 0) { k.vx -= s.lx * vn * 1.3; k.vz -= s.lz * vn * 1.3; if (Math.abs(vn) > 6 && k.wallCd <= 0) { k.wallCd = 0.4; k.vf *= 0.8; k.vx *= 0.8; k.vz *= 0.8; for (let i = 0; i < 6; i++) spawnP(k.x + s.lx * sign, k.y + 0.6, k.z + s.lz * sign, rr(-3, 3), rr(2, 6), rr(-3, 3), rr(0.3, 0.6), 0xfff2a0, 0.8, 12); if (isMe(k)) sfx.bump(); } }
  }
  k.wallCd -= dt; k.hitCd -= dt; k.lat = lat; k.offroad = Math.abs(lat) > HW + CURB * 0.6; k.y = terrainH(k.x, k.z) + ROAD_Y;
  k.dist = ((k.idx * DS + along) % L + L) % L;
  // checkpoints + laps
  const segStart = k.cpNext * CPL; const rel = ((k.dist - segStart) % L + L) % L;
  if (rel < CPL) { if (k.cpNext === 0) onLapLine(k); k.cpNext = (k.cpNext + 1) % CP; }
  const last = (k.cpNext - 1 + CP) % CP;
  k.score = k.finished ? 1e7 - k.finishTime : k.lap * L + last * CPL + clamp(wrapHalf(k.dist - last * CPL), -CPL, CPL * 1.5);
  // wrong way (local player only)
  const dot = nfx * s.tx + nfz * s.tz; k.wrongWay = (dot < -0.3 && k.vf > 3) ? k.wrongWay + dt : 0;
  k.star -= dt; k.shrink -= dt;
  if (k.shrink > 0 && k.shrink < 0.01) k.vis.body.scale.setScalar(1);
}

/* ---- remote karts: snapshot buffer + interpolation (rendered INTERP seconds in the past) */
const INTERP = 0.1;
function packKart(k) {
  return { i: k.id, x: +k.x.toFixed(2), z: +k.z.toFixed(2), h: +k.h.toFixed(3), vx: +k.vx.toFixed(2), vz: +k.vz.toFixed(2), vf: +k.vf.toFixed(2), st: +k.steer.toFixed(2), th: k.throttle, lp: k.lap, cp: k.cpNext, d: +k.dist.toFixed(1), sc: +k.score.toFixed(2),
    bo: r2(k.boost), sp: r2(k.spin), sa: +k.spinAng.toFixed(2), sr: r2(k.star), sh: r2(k.shrink), it: k.item, ro: r2(k.roulette), fi: k.finished ? 1 : 0, ft: r2(k.finishTime), or: k.offroad ? 1 : 0 };
}
function applyRemote(k, dt) {
  const buf = k.buf, rt = nowSec() - INTERP; const smp = sampleSnaps(buf, rt); if (!smp) return;
  const { a, b, f } = smp, latest = buf[buf.length - 1];
  if (b) { k.x = lerp(a.x, b.x, f); k.z = lerp(a.z, b.z, f); k.h = a.h + wrapAngle(b.h - a.h) * f; }
  else { const ex = clamp(rt - a.t, 0, 0.25); k.x = a.x + a.vx * ex; k.z = a.z + a.vz * ex; k.h = a.h; }
  const age = nowSec() - latest.t;
  Object.assign(k, { vx: latest.vx, vz: latest.vz, vf: latest.vf, steer: latest.st, throttle: latest.th, lap: latest.lp, cpNext: latest.cp, dist: latest.d, score: latest.sc, item: latest.it, roulette: latest.ro, finished: !!latest.fi, finishTime: latest.ft, offroad: !!latest.or });
  k.boost = latest.bo - age; k.spin = latest.sp - age; k.star = latest.sr - age; k.shrink = latest.sh - age;
  k.spinAng = k.spin > 0 ? latest.sa + age * 10.5 : 0;
  k.idx = nearestSample(k.x, k.z, k.idx, k.idx < 0 ? 0 : 60); const s = S[k.idx]; k.lat = (k.x - s.x) * s.lx + (k.z - s.z) * s.lz;
  k.y = terrainH(k.x, k.z) + ROAD_Y;
}

function kartVisual(k, dt) {
  const v = k.vis; v.g.position.set(k.x, k.y, k.z);
  const e = 0.6, hx = terrainH(k.x + e, k.z) - terrainH(k.x - e, k.z), hz = terrainH(k.x, k.z + e) - terrainH(k.x, k.z - e);
  const n = new THREE.Vector3(-hx, 2 * e, -hz).normalize(); const qt = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n); const qy = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), k.h);
  v.g.quaternion.copy(qt).multiply(qy);
  const sp = clamp(Math.abs(k.vf) / VMAX, 0, 1);
  k.steerVis = lerp(k.steerVis, k.steer, 1 - Math.exp(-10 * dt)); k.roll = lerp(k.roll, k.steerVis * 0.12 * sp, 1 - Math.exp(-6 * dt));
  const acc = (k.vf - k.prevVf) / Math.max(dt, 1e-3); k.prevVf = k.vf; k.pitch = lerp(k.pitch, clamp(-acc * 0.004, -0.12, 0.12) + (k.boost > 0 ? -0.05 : 0), 1 - Math.exp(-5 * dt));
  v.body.rotation.set(k.pitch, k.spin > 0 ? k.spinAng : 0, k.roll); v.body.position.y = k.boost > 0 ? Math.sin(timeU.value * 40) * 0.03 : 0;
  k.wheelRot += k.vf * dt / 0.4; v.wheels.forEach(w => w.rotation.x = k.wheelRot); v.pivots.forEach(p => p.rotation.y = k.steerVis * 0.45);
  v.head.rotation.z = -k.steerVis * 0.25; v.head.rotation.x = k.boost > 0 ? -0.25 : 0;
  const sc = k.shrink > 0 ? 0.62 : 1; v.body.scale.setScalar(lerp(v.body.scale.x, sc, 1 - Math.exp(-8 * dt))); v.shadow.scale.set(0.9 * sc, 1.1 * sc, 1);
  if (k.star > 0) { v.bodyMat.color.setHSL((timeU.value * 3) % 1, 0.9, 0.6); v.bodyMat.emissive.copy(v.bodyMat.color); v.bodyMat.emissiveIntensity = 0.6; if (Math.random() < 0.5) spawnP(k.x + rr(-1, 1), k.y + rr(0.3, 1.8), k.z + rr(-1, 1), rr(-1, 1), rr(1, 3), rr(-1, 1), 0.5, 0xffe066, 0.6); }
  else if (v.bodyMat.emissiveIntensity > 0) { v.bodyMat.color.set(k.color); v.bodyMat.emissive.set(0); v.bodyMat.emissiveIntensity = 0; }
  const fx = Math.sin(k.h), fz = Math.cos(k.h), lx = Math.cos(k.h), lz = -Math.sin(k.h);
  if (k.boost > 0) for (const s of [-1, 1]) spawnP(k.x - fx * 1.7 + lx * s * 0.45, k.y + 0.7, k.z - fz * 1.7 + lz * s * 0.45, -fx * 8 + rr(-2, 2), rr(0.5, 2), -fz * 8 + rr(-2, 2), rr(0.2, 0.4), Math.random() < 0.5 ? 0xff8a20 : 0xffd040, 1.2);
  else if (Math.abs(k.vf) > 3 && Math.random() < 0.25) spawnP(k.x - fx * 1.8, k.y + 0.7, k.z - fz * 1.8, rr(-0.5, 0.5), rr(0.8, 1.5), rr(-0.5, 0.5), 0.5, 0x9aa3b8, 0.5);
  if (k.offroad && Math.abs(k.vf) > 6) for (const s of [-1, 1]) if (Math.random() < 0.6) spawnP(k.x - fx * 0.9 + lx * s, k.y + 0.3, k.z - fz * 0.9 + lz * s, lx * s * rr(2, 5) - fx * 3, rr(2, 5), lz * s * rr(2, 5) - fz * 3, rr(0.3, 0.6), 0xf4f8ff, 0.9, 10);
  if (v.label) { v.label.visible = race.state !== 'intro'; v.label.position.set(k.x, k.y + 3.4, k.z); }
}

/* each machine only moves the karts it owns; a pair with no owned kart is left to the other machines */
function collideKarts() {
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const a = active[i], b = active[j]; const oa = owned(a), ob = owned(b); if (!oa && !ob) continue;
    const dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz), minD = KART_R * 2 * (a.shrink > 0 ? 0.8 : 1) * (b.shrink > 0 ? 0.8 : 1);
    if (d < minD && d > 1e-4) {
      const nx = dx / d, nz = dz / d, over = (minD - d) * 0.5;
      if (oa) { a.x -= nx * over; a.z -= nz * over; } if (ob) { b.x += nx * over; b.z += nz * over; }
      const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (rel < 0) {
        const imp = -rel * 0.65; if (oa) { a.vx -= nx * imp; a.vz -= nz * imp; } if (ob) { b.vx += nx * imp; b.vz += nz * imp; }
        if (-rel > 4) { const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2; for (let q = 0; q < 5; q++) spawnP(mx, a.y + 0.6, mz, rr(-4, 4), rr(2, 5), rr(-4, 4), rr(0.25, 0.5), 0xfff0a0, 0.7, 12); if (isMe(a) || isMe(b)) sfx.bump(); }
        if (a.star > 0 && b.star <= 0 && ob) hitKart(b, 'star', a.id); if (b.star > 0 && a.star <= 0 && oa) hitKart(a, 'star', b.id);
      }
    }
  }
}

/* ============================================================ AI */
function aiControl(k, dt) {
  const a = k.ai;
  a.laneTimer -= dt; if (a.laneTimer <= 0) { a.laneTimer = rr(1.5, 4.5); a.laneTarget = rr(-2.8, 2.8) * a.wander; }
  // jostle: avoid / squeeze past a kart directly ahead
  let block = null, bestD = 11;
  for (const o of active) { if (o === k) continue; const dd = wrapHalf(o.dist - k.dist); if (dd > 0 && dd < bestD && Math.abs(o.lat - k.lat) < 2.6) { bestD = dd; block = o; } }
  let laneT = a.laneTarget;
  if (block) { const side = block.lat > k.lat ? -1 : 1; laneT = clamp(block.lat + side * 3.2 - RL[k.idx], -RLM - 1, RLM + 1); if (a.aggr > 0.6 && bestD < 4) laneT = block.lat - RL[k.idx]; }
  a.lane = lerp(a.lane, laneT, 1 - Math.exp(-2.2 * dt));
  const vf = k.vf; const la = 4.5 + Math.abs(vf) * 0.34; const j = (k.idx + Math.round(la / DS)) % N;
  const tx = RLX[j] + S[j].lx * a.lane, tz = RLZ[j] + S[j].lz * a.lane;
  const err = wrapAngle(Math.atan2(tx - k.x, tz - k.z) - k.h);
  k.steer = clamp(err * 2.6, -1, 1);
  let kmax = 0; const n0 = Math.round(3 / DS), n1 = Math.round((6 + Math.abs(vf) * 1.05) / DS);
  for (let o = n0; o <= n1; o += 4) kmax = Math.max(kmax, RLK[(k.idx + o) % N]);
  const R = 1 / Math.max(kmax, 1e-4), sf = 0.92 * a.skill; const vt = Math.min(kartVmax(k) + 5, 2.6 * R * sf / (1 + 1.43 * R * sf / VMAX));
  k.throttle = vf < vt ? 1 : (vf - vt > 4 ? -0.6 : 0.15);
  if (Math.abs(vf) < 1.5 && race.state !== 'countdown' && k.spin <= 0) a.stuck += dt; else a.stuck = 0;
  if (a.stuck > 1.3) { a.reverse = 0.9; a.stuck = 0; a.stuckCount = (a.stuckCount || 0) + 1; }
  if (a.reverse > 0) { a.reverse -= dt; k.throttle = -1; k.steer = -Math.sign(err); }
  a.rubber = 1 + clamp((race.humanScore - k.score) / L * 0.45, -0.07, 0.11); // rubber-band toward the humans
  // items
  if (k.item && k.roulette <= 0) {
    a.itemTimer += dt; const ahead = active.filter(o => o !== k && wrapHalf(o.dist - k.dist) > 0 && wrapHalf(o.dist - k.dist) < 45);
    const behind = active.some(o => o !== k && wrapHalf(k.dist - o.dist) > 0 && wrapHalf(k.dist - o.dist) < 9);
    const t = k.item; let use = false;
    if (t === 'mushroom') use = a.itemTimer > 0.8 && kmax < 0.03; else if (t === 'green') use = (ahead.length && a.itemTimer > 0.4) || a.itemTimer > 6; else if (t === 'red') use = (ahead.length && a.itemTimer > 0.6) || a.itemTimer > 7;
    else if (t === 'banana') use = (behind && a.itemTimer > 0.5) || a.itemTimer > 6; else use = a.itemTimer > 0.6;
    if (use) { useItem(k); a.itemTimer = 0; }
  }
}

/* ============================================================ race state */
const race = { state: 'intro', t: 0, time: 0, stage: 0, shake: 0, flash: 0, placeCand: 0, placeCandT: 0, shownPlace: 0, resultsT: 0, humanScore: 0 };
/* ============================================================ audio: kart cues on top of the shared synth */
const sfx = (() => {
  const { beep, noise } = audio; let eng = null, engGain = null;
  const unsub = audio.whenReady((ctx, master) => {
    eng = ctx.createOscillator(); eng.type = 'sawtooth'; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 700; engGain = ctx.createGain(); engGain.gain.value = 0; eng.connect(f).connect(engGain).connect(master); eng.start();
  });
  return {
    engine(speed, boost) { if (!engGain) return; const ctx = audio.ctx; eng.frequency.setTargetAtTime(50 + speed * 4.2 + (boost ? 60 : 0), ctx.currentTime, 0.05); engGain.gain.setTargetAtTime(audio.muted ? 0 : 0.05 + speed * 0.0012, ctx.currentTime, 0.05); },
    silence() { if (engGain) engGain.gain.setTargetAtTime(0, audio.ctx.currentTime, 0.05); },
    dispose() { unsub(); if (eng) { try { eng.stop(); } catch {} eng.disconnect(); eng = null; engGain = null; } },
    count() { beep(440, 0.25); }, go() { beep(880, 0.7, 'square', 0.28); },
    pickup() { beep(660, 0.1); beep(880, 0.1, 'square', 0.22, 0.08); beep(1100, 0.2, 'square', 0.22, 0.16); },
    tick() { beep(1400, 0.03, 'square', 0.07); }, boost() { noise(0.6, 0.3, 1600, 0.7); beep(220, 0.5, 'sawtooth', 0.12); },
    hit() { noise(0.45, 0.6, 350, 0.5); beep(110, 0.5, 'sawtooth', 0.3); }, bump() { noise(0.12, 0.25, 500); }, throwIt() { noise(0.3, 0.3, 2600, 0.6); },
    up() { beep(620, 0.1); beep(930, 0.18, 'square', 0.22, 0.1); }, down() { beep(520, 0.1); beep(300, 0.25, 'square', 0.22, 0.1); },
    lap() { beep(700, 0.1); beep(900, 0.1, 'square', 0.22, 0.1); beep(1200, 0.3, 'square', 0.22, 0.2); },
    star() { [523, 659, 784, 1046, 1318].forEach((f, i) => beep(f, 0.18, 'square', 0.2, i * 0.09)); }, lightning() { noise(0.8, 0.7, 900, 0.3); beep(60, 0.8, 'sawtooth', 0.35); },
    finish() { [784, 784, 784, 1046].forEach((f, i) => beep(f, i === 3 ? 0.7 : 0.15, 'square', 0.25, i * 0.18)); }, };
})();

/* ============================================================ toasts / flash */
const toasts = createToasts($('toasts')), toast = toasts.toast;
const flashEl = $('flash');
function flash(color, strength = 0.6) { flashEl.style.background = color; race.flash = strength; }


/* ============================================================ items */
const ITEMS = ['mushroom', 'green', 'red', 'banana', 'star', 'lightning'];
const ITEM_LABEL = { mushroom: 'MUSHROOM', green: 'GREEN SHELL', red: 'RED SHELL', banana: 'BANANA', star: 'STAR', lightning: 'LIGHTNING' };
const ITEM_W = { mushroom: p => 2.5 + p * 0.5, green: p => 3 + (p <= 4 ? 1.2 : 0), red: p => p <= 2 ? 0.4 : 1.8 + p * 0.35, banana: p => p <= 3 ? 3.2 : 1.4, star: p => p >= 5 ? (p - 4) * 0.9 : 0, lightning: p => p >= 6 ? (p - 5) * 1.0 : 0 };
function rollItem(place) { const w = ITEMS.map(t => ITEM_W[t](place)); let r = Math.random() * w.reduce((a, b) => a + b, 0); for (let i = 0; i < ITEMS.length; i++) { r -= w[i]; if (r <= 0) return ITEMS[i]; } return 'mushroom'; }

const itemBoxes = [];
{
  const outerG = new THREE.BoxGeometry(1.7, 1.7, 1.7), innerG = new THREE.OctahedronGeometry(0.55, 0);
  for (const f of [0.10, 0.36, 0.62, 0.84]) for (const lat of [-4.2, 0, 4.2]) {
    const g = new THREE.Group(); const outer = new THREE.Mesh(outerG, new THREE.MeshStandardMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.55, roughness: 0.2, metalness: 0.3, emissive: 0x2a80ff, emissiveIntensity: 0.5 })); const inner = new THREE.Mesh(innerG, new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0xffb000, emissiveIntensity: 1.2, flatShading: true }));
    g.add(outer, inner); const p = trackPoint(f * L, lat); g.position.set(p.x, p.y + 1.3, p.z); scene.add(g); itemBoxes.push({ g, outer, inner, x: p.x, z: p.z, y: p.y, active: true, respawn: 0, hideUntil: 0, ph: Math.random() * 6 });
  }
}
const hazards = [];              // host-simulated shells + bananas
let nextHazId = 1;
const remoteHaz = new Map();     // client-side mirrors of the host's hazards, keyed by id
const ignoreHaz = new Map();     // hazards this client already destroyed, until the host confirms
const shellGeo = new THREE.IcosahedronGeometry(0.65, 1); shellGeo.scale(1, 0.75, 1);
const bananaGeo = new THREE.TorusGeometry(0.55, 0.2, 6, 10, Math.PI * 1.1); bananaGeo.rotateZ(-Math.PI * 0.05);
function shellMesh(color) { const g = new THREE.Group(); g.add(new THREE.Mesh(shellGeo, flatMat({ color, roughness: 0.4 }))); const base = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), flatMat({ color: 0xfff3d0 })); base.scale.set(1, 0.35, 1); base.position.y = -0.2; g.add(base); const rim = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.09, 5, 12), flatMat({ color: 0xfff3d0 })); rim.rotation.x = Math.PI / 2; rim.position.y = -0.05; g.add(rim); scene.add(g); return g; }
function bananaMesh() { const m = new THREE.Mesh(bananaGeo, flatMat({ color: 0xffe135, roughness: 0.5 })); m.rotation.x = Math.PI / 2; const g = new THREE.Group(); g.add(m); scene.add(g); return g; }
const hazMesh = type => type === 'banana' ? bananaMesh() : shellMesh(type === 'green' ? 0x2ecc71 : 0xe74c3c);
function hazBurst(h) { for (let q = 0; q < 8; q++) spawnP(h.x, h.y + 0.6, h.z, rr(-4, 4), rr(2, 6), rr(-4, 4), 0.4, h.type === 'banana' ? 0xffe135 : 0xffffff, 0.7, 10); }

function pickRedTarget(k) {
  let target = null, best = Infinity;
  for (const o of active) if (o !== k && !o.finished && o.score > k.score && o.score - k.score < best) { best = o.score - k.score; target = o; }
  if (!target) for (const o of active) if (o !== k && wrapHalf(o.dist - k.dist) > 0 && (!target || wrapHalf(o.dist - k.dist) < wrapHalf(target.dist - k.dist))) target = o;
  return target;
}
/* host only: create a shell or banana thrown by kart `owner` from the given pose */
function spawnHazard(type, owner, x, z, h, vf, target) {
  const fx = Math.sin(h), fz = Math.cos(h); const idx = nearestSample(x, z, owner.idx, 80); const y = terrainH(x, z) + ROAD_Y;
  if (type === 'green') { const sp = 52 + Math.max(vf, 0) * 0.6; hazards.push({ id: nextHazId++, type, owner: owner.id, x: x + fx * 2.6, z: z + fz * 2.6, y, vx: fx * sp, vz: fz * sp, idx, life: 9, age: 0, bounces: 0, mesh: hazMesh(type) }); }
  else if (type === 'red') hazards.push({ id: nextHazId++, type, owner: owner.id, target, x: x + fx * 2.6, z: z + fz * 2.6, y, h, idx, life: 11, age: 0, mesh: hazMesh(type) });
  else if (type === 'banana') hazards.push({ id: nextHazId++, type, owner: owner.id, x: x - fx * 2.6, z: z - fz * 2.6, y, life: 90, age: 0, mesh: hazMesh(type) });
}

function useItem(k) {
  const t = k.item; if (!t || k.roulette > 0) return; k.item = null; if (isMe(k)) drawItemSlot(null);
  if (t === 'mushroom') { k.boost = Math.max(k.boost, 1.4); if (isMe(k)) { toast('MUSHROOM!', 'orange'); sfx.boost(); } }
  else if (t === 'green' || t === 'red' || t === 'banana') {
    const target = t === 'red' ? pickRedTarget(k) : null;
    if (isHost) spawnHazard(t, k, k.x, k.z, k.h, k.vf, target);
    else send({ t: 'use', it: t, x: +k.x.toFixed(2), z: +k.z.toFixed(2), h: +k.h.toFixed(3), vf: +k.vf.toFixed(2), tg: target ? target.id : -1 });
    if (isMe(k) && t !== 'banana') sfx.throwIt();
  }
  else if (t === 'star') { k.star = 7.5; if (isMe(k)) { toast('★ STAR POWER!', 'gold'); sfx.star(); } }
  else if (t === 'lightning') {
    for (const o of active) if (o !== k && owned(o)) hitKart(o, 'lightning', k.id);
    if (online) send({ t: 'zap', by: k.id });
    if (isMe(k)) { toast('⚡ LIGHTNING!', 'gold'); flash('#ffffff', 0.5); } sfx.lightning(); if (!isMe(k) && me.star <= 0) flash('#ffff80', 0.7);
  }
}

/* `by` is the id of the kart responsible, if any */
function hitKart(k, cause, by) {
  if (k.star > 0) return; if (k.hitCd > 0 && cause !== 'lightning') return;
  k.spin = cause === 'lightning' ? 1.0 : 1.5; k.spinAng = 0; k.hitCd = 2.4; k.boost = 0;
  if (cause === 'lightning') { k.shrink = 5.5; }
  hitBurst(k, cause);
  if (isMe(k)) { flash(cause === 'lightning' ? '#ffff60' : '#ff2030', 0.65); race.shake = 0.6; toast(cause === 'lightning' ? 'ZAPPED!' : cause === 'banana' ? 'SLIPPED!' : cause === 'star' ? 'BOWLED OVER!' : 'HIT!', 'down'); sfx.hit(); }
  else if (by === me.id && cause !== 'lightning') niceShot();
}
function hitBurst(k, cause) { for (let i = 0; i < 14; i++) spawnP(k.x, k.y + 0.8, k.z, rr(-6, 6), rr(3, 9), rr(-6, 6), rr(0.4, 0.8), cause === 'lightning' ? 0xffff60 : 0xffb070, 1, 14); }
function niceShot() { toast('NICE SHOT!', 'up'); sfx.up(); }

function killHazard(i) { const h = hazards[i]; hazBurst(h); scene.remove(h.mesh); hazards.splice(i, 1); }
/* client: a hazard hit (or bounced off) the local kart - destroy it here and tell the host */
function localKillHazard(h, spun) {
  hazBurst(h); scene.remove(h.mesh); remoteHaz.delete(h.id); ignoreHaz.set(h.id, nowSec() + 3);
  send({ t: 'hit', id: h.id, v: me.id, c: h.type === 'banana' ? 'banana' : 'shell', s: spun ? 1 : 0 });
}

function updateItems(dt) {
  for (let bi = 0; bi < itemBoxes.length; bi++) {
    const b = itemBoxes[bi];
    b.g.rotation.y += dt * 1.6; b.g.rotation.x += dt * 0.9; b.g.position.y = b.y + 1.3 + Math.sin(timeU.value * 2 + b.ph) * 0.2; b.inner.rotation.y -= dt * 3;
    if (!b.active) { if (isHost) { b.respawn -= dt; if (b.respawn <= 0) { b.active = true; b.g.visible = true; } } continue; }
    b.outer.material.emissive.setHSL((timeU.value * 0.3 + b.ph) % 1, 0.8, 0.5);
    for (const k of active) if (owned(k) && !k.item && k.roulette <= 0 && (k.x - b.x) ** 2 + (k.z - b.z) ** 2 < 2.1 * 2.1) {
      b.active = false; b.g.visible = false; b.respawn = 3.5; b.hideUntil = nowSec() + 1.0; k.roulette = 1.35; k.ai.itemTimer = 0;
      for (let i = 0; i < 10; i++) spawnP(b.x, b.y + 1.3, b.z, rr(-4, 4), rr(1, 6), rr(-4, 4), rr(0.3, 0.6), 0x9fe8ff, 0.8, 6);
      if (isMe(k)) sfx.pickup(); if (!isHost) send({ t: 'pick', b: bi }); break;
    }
  }
  for (const k of active) if (owned(k) && k.roulette > 0) { k.roulette -= dt; if (k.roulette <= 0) { k.item = rollItem(k.place); if (isMe(k)) { drawItemSlot(k.item); $('item').classList.remove('pulse'); void $('item').offsetWidth; $('item').classList.add('pulse'); toast(ITEM_LABEL[k.item] + '!', 'blue'); } } else if (isMe(k)) { drawItemSlot(ITEMS[Math.floor(timeU.value * 14) % ITEMS.length], true); if (Math.floor(timeU.value * 14) !== k._tick) { k._tick = Math.floor(timeU.value * 14); sfx.tick(); } } }
  if (isHost) updateHostHazards(dt); else updateRemoteHazards(dt);
}

function updateHostHazards(dt) {
  for (let i = hazards.length - 1; i >= 0; i--) {
    const h = hazards[i]; h.life -= dt; h.age += dt; let dead = h.life <= 0;
    if (h.type === 'green') {
      h.x += h.vx * dt; h.z += h.vz * dt; h.idx = nearestSample(h.x, h.z, h.idx, 40); const s = S[h.idx]; const lat = (h.x - s.x) * s.lx + (h.z - s.z) * s.lz; const lim = WALL - 0.7;
      if (Math.abs(lat) > lim) { const sg = Math.sign(lat); h.x -= s.lx * (Math.abs(lat) - lim) * sg; h.z -= s.lz * (Math.abs(lat) - lim) * sg; const vn = h.vx * s.lx + h.vz * s.lz; if (vn * sg > 0) { h.vx -= 2 * vn * s.lx; h.vz -= 2 * vn * s.lz; h.bounces++; for (let q = 0; q < 5; q++) spawnP(h.x, h.y + 0.5, h.z, rr(-3, 3), rr(2, 5), rr(-3, 3), 0.4, 0xfff0a0, 0.6, 12); if (h.bounces > 5) dead = true; } }
      h.y = terrainH(h.x, h.z) + ROAD_Y; h.mesh.rotation.y += dt * 12;
    } else if (h.type === 'red') {
      const sp = 50; let want;
      const tg = h.target; const tgd = tg ? Math.hypot(tg.x - h.x, tg.z - h.z) : 1e9;
      if (tg && tgd < 30 && !tg.finished) want = Math.atan2(tg.x - h.x, tg.z - h.z); else { const j = (h.idx + Math.round(14 / DS)) % N; want = Math.atan2(RLX[j] - h.x, RLZ[j] - h.z); }
      h.h += clamp(wrapAngle(want - h.h), -1, 1) * 5.5 * dt; h.x += Math.sin(h.h) * sp * dt; h.z += Math.cos(h.h) * sp * dt;
      h.idx = nearestSample(h.x, h.z, h.idx, 40); const s = S[h.idx]; const lat = (h.x - s.x) * s.lx + (h.z - s.z) * s.lz; const lim = WALL - 0.7;
      if (Math.abs(lat) > lim) { const sg = Math.sign(lat); h.x -= s.lx * (Math.abs(lat) - lim) * sg; h.z -= s.lz * (Math.abs(lat) - lim) * sg; }
      h.y = terrainH(h.x, h.z) + ROAD_Y; h.mesh.rotation.y += dt * 12;
      if (Math.random() < 0.5) spawnP(h.x, h.y + 0.5, h.z, rr(-1, 1), rr(0, 1), rr(-1, 1), 0.3, 0xff6040, 0.5);
    } else { h.mesh.rotation.y += dt * 0.5; }
    h.mesh.position.set(h.x, h.y + 0.6, h.z);
    // hits against the karts this machine owns; other players report their own hits
    if (!dead) for (const k of active) {
      if (!owned(k)) continue; if (k.id === h.owner && h.age < 0.6) continue;
      if ((k.x - h.x) ** 2 + (k.z - h.z) ** 2 < (KART_R + 0.8) ** 2) {
        if (k.star > 0) { dead = true; break; }
        if (k.hitCd <= 0) { const cause = h.type === 'banana' ? 'banana' : 'shell'; hitKart(k, cause, h.owner); if (online) send({ t: 'hitev', v: k.id, c: cause, by: h.owner }); dead = true; break; }
      }
    }
    if (dead) killHazard(i);
  }
}

function updateRemoteHazards(dt) {
  const rt = nowSec() - INTERP;
  for (const h of remoteHaz.values()) {
    h.age += dt; const smp = sampleSnaps(h.buf, rt); if (!smp) continue; const { a, b, f, prev: p } = smp;
    if (b) { h.x = lerp(a.x, b.x, f); h.z = lerp(a.z, b.z, f); }
    else { const ex = clamp(rt - a.t, 0, 0.2); if (p && h.type !== 'banana') { const it = Math.max(a.t - p.t, 1e-3); h.x = a.x + (a.x - p.x) / it * ex; h.z = a.z + (a.z - p.z) / it * ex; } else { h.x = a.x; h.z = a.z; } }
    h.h = a.h; h.y = terrainH(h.x, h.z) + ROAD_Y; h.mesh.position.set(h.x, h.y + 0.6, h.z); h.mesh.rotation.y += dt * (h.type === 'banana' ? 0.5 : 12);
    if (h.type === 'red' && Math.random() < 0.5) spawnP(h.x, h.y + 0.5, h.z, rr(-1, 1), rr(0, 1), rr(-1, 1), 0.3, 0xff6040, 0.5);
    if (me.kind !== 'local') continue; if (h.owner === me.id && h.age < 0.6) continue;
    if ((me.x - h.x) ** 2 + (me.z - h.z) ** 2 < (KART_R + 0.8) ** 2) {
      if (me.star > 0) localKillHazard(h, false);
      else if (me.hitCd <= 0) { hitKart(me, h.type === 'banana' ? 'banana' : 'shell', h.owner); localKillHazard(h, true); }
    }
  }
}
/* client: mirror the host's hazard list */
function syncHazards(list) {
  const now = nowSec(); for (const [id, until] of ignoreHaz) if (until < now) ignoreHaz.delete(id);
  const seen = new Set();
  for (const hs of list) {
    if (ignoreHaz.has(hs.id)) continue; seen.add(hs.id);
    let h = remoteHaz.get(hs.id);
    if (!h) { h = { id: hs.id, type: hs.ty, owner: hs.o, x: hs.x, z: hs.z, y: terrainH(hs.x, hs.z) + ROAD_Y, h: hs.h || 0, age: 0, buf: [], mesh: hazMesh(hs.ty) }; h.mesh.position.set(h.x, h.y + 0.6, h.z); remoteHaz.set(hs.id, h); }
    pushSnap(h.buf, { x: hs.x, z: hs.z, h: hs.h || 0 }, now);
  }
  for (const [id, h] of remoteHaz) if (!seen.has(id)) { hazBurst(h); scene.remove(h.mesh); remoteHaz.delete(id); }
}
function syncBoxes(mask) {
  const now = nowSec();
  itemBoxes.forEach((b, i) => { const on = !!(mask & (1 << i)); if (on && b.hideUntil > now) return; b.active = on; b.g.visible = on; });
}
function clearHazards() {
  for (const h of hazards) scene.remove(h.mesh); hazards.length = 0;
  for (const h of remoteHaz.values()) scene.remove(h.mesh); remoteHaz.clear(); ignoreHaz.clear(); nextHazId = 1;
}

/* ============================================================ laps / finish */
const fmtT = fmtTime;
function onLapLine(k) {
  if (race.state === 'intro' || race.state === 'countdown') return;
  k.lap++;
  if (k.lap > 1) k.lapTimes.push(race.time - k.lapStart); k.lapStart = race.time;
  if (k.lap === 4) { k.finished = true; k.finishTime = race.time; if (isMe(k)) finishPlayer(); }
  else if (isMe(k) && k.lap === 2) { toast('LAP 2  ·  ' + fmtT(k.lapTimes[0]), 'blue'); sfx.lap(); }
  else if (isMe(k) && k.lap === 3) { toast('FINAL LAP!', 'orange'); $('lapbox').classList.add('final'); sfx.lap(); }
}
function finishPlayer() {
  race.state = 'finished'; race.resultsT = 1.6; toast('FINISH!', 'gold'); sfx.finish(); flash('#ffffff', 0.4);
  for (let i = 0; i < 60; i++) spawnP(me.x + rr(-6, 6), me.y + rr(1, 6), me.z + rr(-6, 6), rr(-4, 4), rr(2, 10), rr(-4, 4), rr(0.8, 1.6), CROWD_COLORS[i % CROWD_COLORS.length], 1.2, 8);
}
function renderResults() {
  const sorted = active.slice().sort((a, b) => b.score - a.score);
  $('resTable').innerHTML = sorted.map((k, i) => `<tr class="${isMe(k) ? 'me' : ''}"><td>${ordinal(i + 1)}</td><td><span class="sw" style="background:#${k.color.toString(16).padStart(6, '0')}"></span>${esc(k.name)}${k.kind === 'ai' ? ' <span class="cpu">CPU</span>' : ''}</td><td class="t">${k.finished ? fmtT(k.finishTime) : 'racing…'}</td></tr>`).join('');
  const pp = sorted.indexOf(me) + 1; $('resSub').textContent = `YOU FINISHED ${ordinal(pp).toUpperCase()} · ${fmtT(me.finishTime)}` + (me.lapTimes.length ? ` · BEST LAP ${fmtT(Math.min(...me.lapTimes))}` : '');
}

function resetRace() {
  karts.forEach(k => resetKart(k, Math.max(gridOrder.indexOf(k.id), 0)));
  clearHazards();
  for (const b of itemBoxes) { b.active = true; b.g.visible = true; b.hideUntil = 0; }
  Object.assign(race, { state: 'countdown', t: 0, time: 0, stage: 0, shake: 0, placeCand: active.length, placeCandT: 0, shownPlace: active.length, resultsT: 0, humanScore: 0 });
  $('results').classList.remove('show'); $('lapbox').classList.remove('final'); toasts.clear(); drawItemSlot(null); setGantry(0); setPosHud(active.length); input.pressAt = -1; input.up = input.down = input.left = input.right = false;
  karts.forEach(k => { k.startDelay = k.kind === 'ai' ? rr(0.05, 0.45) : 0; });
  camState.pos.copy(trackPoint(L - 40, 0)).add(new THREE.Vector3(0, 8, 0)); camState.init = true;
}
/* ============================================================ HUD */
const itemCtx = $('itemCanvas').getContext('2d');
function drawItemIcon(c, type, cx, cy, r) {
  c.save(); c.translate(cx, cy); c.lineWidth = r * 0.12; c.strokeStyle = '#1a1e30'; c.lineJoin = 'round';
  if (type === 'mushroom') { c.fillStyle = '#f5e6c8'; c.beginPath(); c.roundRect(-r * 0.45, 0, r * 0.9, r * 0.75, r * 0.15); c.fill(); c.stroke(); c.fillStyle = '#ff3b3b'; c.beginPath(); c.arc(0, 0, r, Math.PI, 0); c.closePath(); c.fill(); c.stroke(); c.fillStyle = '#fff'; for (const [x, y, s] of [[-0.5, -0.35, 0.22], [0.45, -0.3, 0.2], [0, -0.75, 0.18]]) { c.beginPath(); c.arc(x * r, y * r, s * r, 0, 7); c.fill(); } c.fillStyle = '#222'; c.beginPath(); c.arc(-r * 0.18, r * 0.35, r * 0.06, 0, 7); c.arc(r * 0.18, r * 0.35, r * 0.06, 0, 7); c.fill(); }
  else if (type === 'green' || type === 'red') { c.fillStyle = type === 'green' ? '#2ecc71' : '#e74c3c'; c.beginPath(); c.arc(0, 0, r, 0, 7); c.fill(); c.stroke(); c.fillStyle = '#fff5d8'; c.beginPath(); c.ellipse(0, r * 0.62, r * 0.95, r * 0.28, 0, 0, 7); c.fill(); c.stroke(); c.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; c.moveTo(0, 0); c.lineTo(Math.cos(a) * r * 0.85, Math.sin(a) * r * 0.85 - r * 0.15); } c.stroke(); }
  else if (type === 'banana') { c.strokeStyle = '#1a1e30'; c.lineWidth = r * 0.5; c.lineCap = 'round'; c.beginPath(); c.arc(0, -r * 0.2, r * 0.75, Math.PI * 0.15, Math.PI * 0.85); c.stroke(); c.strokeStyle = '#ffe135'; c.lineWidth = r * 0.34; c.stroke(); }
  else if (type === 'star') { c.fillStyle = '#ffd54a'; c.beginPath(); for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + i * Math.PI / 5, rad = i % 2 ? r * 0.45 : r; c.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); } c.closePath(); c.fill(); c.stroke(); c.fillStyle = '#222'; c.beginPath(); c.arc(-r * 0.18, r * 0.05, r * 0.07, 0, 7); c.arc(r * 0.18, r * 0.05, r * 0.07, 0, 7); c.fill(); }
  else if (type === 'lightning') { c.fillStyle = '#ffe94a'; c.beginPath(); [[-0.2, -1], [0.35, -1], [0.05, -0.25], [0.5, -0.25], [-0.3, 1], [-0.05, 0.1], [-0.5, 0.1]].forEach(([x, y], i) => i ? c.lineTo(x * r, y * r) : c.moveTo(x * r, y * r)); c.closePath(); c.fill(); c.stroke(); }
  c.restore();
}
function drawItemSlot(type, spinning = false) {
  const c = itemCtx; c.clearRect(0, 0, 168, 168); if (type) { c.globalAlpha = spinning ? 0.75 : 1; drawItemIcon(c, type, 84, 84, 58); c.globalAlpha = 1; }
  $('itemLabel').textContent = type && !spinning ? ITEM_LABEL[type] : (spinning ? '???' : '');
}
const spCanvas = $('speedCanvas'); spCanvas.width = 520; spCanvas.height = 300; const spCtx = spCanvas.getContext('2d'); spCtx.scale(2, 2);
function drawSpeedo(speed, boosting) {
  const c = spCtx; c.clearRect(0, 0, 260, 150); const cx = 130, cy = 98, R = 76, a0 = Math.PI * 0.8, a1 = Math.PI * 2.2; const f = clamp(speed / (VMAX * 1.45), 0, 1);
  c.lineCap = 'round'; c.lineWidth = 16; c.strokeStyle = 'rgba(6,10,28,.65)'; c.beginPath(); c.arc(cx, cy, R, a0, a1); c.stroke();
  const col = boosting ? '#ff8c1a' : '#4fd1ff'; c.shadowColor = col; c.shadowBlur = boosting ? 24 : 10; c.strokeStyle = col; c.lineWidth = 12; c.beginPath(); c.arc(cx, cy, R, a0, a0 + (a1 - a0) * f); c.stroke(); c.shadowBlur = 0;
  c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 2; for (let i = 0; i <= 10; i++) { const a = a0 + (a1 - a0) * i / 10; c.beginPath(); c.moveTo(cx + Math.cos(a) * (R - 14), cy + Math.sin(a) * (R - 14)); c.lineTo(cx + Math.cos(a) * (R - 22), cy + Math.sin(a) * (R - 22)); c.stroke(); }
  const na = a0 + (a1 - a0) * f; c.strokeStyle = '#fff'; c.lineWidth = 4; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(na) * (R - 26), cy + Math.sin(na) * (R - 26)); c.stroke(); c.fillStyle = '#fff'; c.beginPath(); c.arc(cx, cy, 6, 0, 7); c.fill();
  c.fillStyle = boosting ? '#ffb060' : '#fff'; c.font = 'italic 900 40px Trebuchet MS, Arial'; c.textAlign = 'center'; c.fillText(Math.round(Math.abs(speed) * 3.3), cx, cy + 4); c.font = 'bold 13px Trebuchet MS, Arial'; c.fillStyle = 'rgba(255,255,255,.75)'; c.fillText(boosting ? 'BOOST' : 'km/h', cx, cy + 22);
}
const mapCanvas = $('mapCanvas'), mapCtx = mapCanvas.getContext('2d');
const mapB = { minx: Infinity, maxx: -Infinity, minz: Infinity, maxz: -Infinity }; for (const s of S) { mapB.minx = Math.min(mapB.minx, s.x); mapB.maxx = Math.max(mapB.maxx, s.x); mapB.minz = Math.min(mapB.minz, s.z); mapB.maxz = Math.max(mapB.maxz, s.z); }
const mapScale = 340 / Math.max(mapB.maxx - mapB.minx, mapB.maxz - mapB.minz); const mapX = x => 20 + (x - mapB.minx) * mapScale + (340 - (mapB.maxx - mapB.minx) * mapScale) / 2, mapZ = z => 20 + (z - mapB.minz) * mapScale + (340 - (mapB.maxz - mapB.minz) * mapScale) / 2;
const mapBg = document.createElement('canvas'); mapBg.width = mapBg.height = 380;
{ const c = mapBg.getContext('2d'); c.lineJoin = 'round'; c.lineCap = 'round'; const path = () => { c.beginPath(); for (let i = 0; i <= N; i += 6) { const s = S[i % N]; i ? c.lineTo(mapX(s.x), mapZ(s.z)) : c.moveTo(mapX(s.x), mapZ(s.z)); } c.closePath(); };
  path(); c.lineWidth = 22; c.strokeStyle = 'rgba(255,255,255,.35)'; c.stroke(); path(); c.lineWidth = 14; c.strokeStyle = '#2c3350'; c.stroke();
  const s = S[0]; c.strokeStyle = '#fff'; c.lineWidth = 4; c.beginPath(); c.moveTo(mapX(s.x + s.lx * 9), mapZ(s.z + s.lz * 9)); c.lineTo(mapX(s.x - s.lx * 9), mapZ(s.z - s.lz * 9)); c.stroke(); }
function drawMap() {
  const c = mapCtx; c.clearRect(0, 0, 380, 380); c.drawImage(mapBg, 0, 0);
  const order = active.slice().sort((a, b) => (isMe(a) ? 1 : 0) - (isMe(b) ? 1 : 0));
  for (const k of order) { const x = mapX(k.x), z = mapZ(k.z), mine = isMe(k), human = k.kind !== 'ai'; c.beginPath(); c.arc(x, z, mine ? 11 : human ? 9 : 8, 0, 7); c.fillStyle = '#' + k.color.toString(16).padStart(6, '0'); c.fill(); c.lineWidth = mine ? 4 : human ? 3 : 2; c.strokeStyle = mine || human ? '#fff' : 'rgba(0,0,0,.6)'; c.stroke(); if (k.item) { c.fillStyle = '#fff'; c.beginPath(); c.arc(x, z, 2.5, 0, 7); c.fill(); } }
}
const posEl = $('pos');
function setPosHud(p) { posEl.innerHTML = `${p}<sup>${ordinal(p).slice(-2)}</sup>`; posEl.className = 'hud p' + p; posEl.classList.add('bump'); setTimeout(() => posEl.classList.remove('bump'), 160); }

/* ============================================================ input */
const kb = createInput({ ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' }, {
  onDown: (name, e, wasHeld) => { audio.init(); if (name === 'up' && !wasHeld) input.pressAt = race.t; },
  onUp: name => { if (name === 'up') input.pressAt = -1; },
  onKey: e => {
    audio.init();
    if (e.code === 'Space' || e.code === 'Enter' || e.code === 'ShiftLeft' || e.code === 'KeyE') { e.preventDefault(); if (race.state === 'race' && me.kind === 'local' && !me.finished) useItem(me); }
    if (e.code === 'KeyR') hooks.onRestart?.();
    if (e.code === 'Escape') hooks.onExit?.();
    if (e.code === 'KeyM') toast(audio.toggle() ? 'SOUND OFF' : 'SOUND ON', 'blue');
  },
});
const input = kb.held; input.pressAt = -1;

/* ============================================================ camera */
const camState = { pos: new THREE.Vector3(0, 10, -30), look: new THREE.Vector3(), fov: 70, init: false };
function updateCamera(dt) {
  const k = me; const fx = Math.sin(k.h), fz = Math.cos(k.h); const want = new THREE.Vector3(), look = new THREE.Vector3();
  if (race.state === 'countdown') { const a = race.t * 0.45 + 2.2; want.set(k.x + Math.sin(a) * 13, k.y + 4.5 + race.t * 0.3, k.z + Math.cos(a) * 13); look.set(k.x, k.y + 1.2, k.z); }
  else if (race.state === 'finished') { const a = timeU.value * 0.4; want.set(k.x + Math.sin(a) * 15, k.y + 6, k.z + Math.cos(a) * 15); look.set(k.x, k.y + 1, k.z); }
  else { const sp = clamp(Math.abs(k.vf) / VMAX, 0, 1.4); const back = 8.5 + sp * 2.2, up = 3.6 + sp * 0.4; want.set(k.x - fx * back, k.y + up, k.z - fz * back); look.set(k.x + fx * 5, k.y + 1.4, k.z + fz * 5); }
  want.y = Math.max(want.y, terrainH(want.x, want.z) + 1.4);
  const rate = race.state === 'race' ? 1 - Math.exp(-7 * dt) : 1 - Math.exp(-3 * dt);
  if (!camState.init) { camState.pos.copy(want); camState.look.copy(look); camState.init = true; }
  camState.pos.lerp(want, rate); camState.look.lerp(look, 1 - Math.exp(-12 * dt));
  camera.position.copy(camState.pos);
  if (race.shake > 0) { race.shake -= dt; camera.position.x += rr(-1, 1) * race.shake * 0.5; camera.position.y += rr(-1, 1) * race.shake * 0.5; }
  camera.lookAt(camState.look);
  const fovT = race.state === 'race' ? (k.boost > 0 ? 88 : 70 + clamp(Math.abs(k.vf) / VMAX, 0, 1.2) * 8) : 62; camState.fov = lerp(camState.fov, fovT, 1 - Math.exp(-5 * dt)); camera.fov = camState.fov; camera.updateProjectionMatrix();
}

/* ============================================================ ambient animation */
let smokeT = 0, resultsRefresh = 0;
function updateAmbient(dt) {
  const p = snow.geo.attributes.position.array, cx = camera.position.x, cy = camera.position.y, cz = camera.position.z, R = snow.range;
  for (let i = 0; i < snow.n; i++) { let x = p[i*3], y = p[i*3+1] - snow.vel[i] * dt, z = p[i*3+2]; x += Math.sin(timeU.value * 0.8 + i) * dt * 1.5;
    if (y < cy - 12) y += 60; if (x < cx - R) x += 2 * R; else if (x > cx + R) x -= 2 * R; if (z < cz - R) z += 2 * R; else if (z > cz + R) z -= 2 * R; p[i*3] = x; p[i*3+1] = y; p[i*3+2] = z; }
  snow.geo.attributes.position.needsUpdate = true;
  for (const b of balloons) { const t = timeU.value; b.g.position.set(b.x + Math.sin(t * 0.09 + b.ph) * 16, b.y + Math.sin(t * 0.5 + b.ph) * 2.2, b.z + Math.cos(t * 0.07 + b.ph) * 14); b.g.rotation.y = t * 0.1; }
  if (Math.random() < dt * 14) { const s = crowdFlashSpots[Math.floor(Math.random() * crowdFlashSpots.length)]; spawnP(s.x, s.y, s.z, 0, 0, 0, 0.12, 0xffffff, 2.2); }
  smokeT -= dt; if (smokeT <= 0) { smokeT = 0.12; for (const c of chimneys) spawnP(c.x + rr(-0.3, 0.3), c.y, c.z + rr(-0.3, 0.3), rr(-0.4, 0.4), rr(1.5, 2.5), rr(-0.4, 0.4), rr(1.5, 2.5), 0xb8c0d0, 2.2, -0.5); }
}

/* ============================================================ networking glue */
let netAcc = 0;
function netTick(dt) {
  if (!online) return; netAcc += dt; if (netAcc < 1 / 30) return; netAcc = 0;
  const msg = { t: 's', k: [] }; for (const k of active) if (owned(k)) msg.k.push(packKart(k));
  if (isHost) {
    msg.r = { p: race.state === 'countdown' ? 'countdown' : 'race', t: +race.t.toFixed(3), tm: +race.time.toFixed(3) };
    msg.z = hazards.map(h => ({ id: h.id, ty: h.type, o: h.owner, x: +h.x.toFixed(2), z: +h.z.toFixed(2), h: h.type === 'red' ? +h.h.toFixed(3) : 0 }));
    let m = 0; itemBoxes.forEach((b, i) => { if (b.active) m |= 1 << i; }); msg.b = m;
  }
  send(msg);
}
/* client: follow the host's clock */
function syncRace(r) {
  if (race.state === 'countdown') { if (r.p === 'countdown' || r.t < 3.6) race.t = Math.max(race.t, r.t); else race.t = Math.max(race.t, 3.6); }
  else if (race.state === 'race' || race.state === 'finished') { const d = r.tm - race.time; race.time += Math.abs(d) > 0.5 ? d : d * 0.2; }
}
const kartOf = pid => karts.find(k => k.pid === pid && k.kind !== 'none');

/* ============================================================ main loop */
const lapEl = $('lap'), timerEl = $('timer'), countEl = $('count');
/* simulation step: fixed-size sub-steps so game time keeps up with real time even on a slow machine */
function simStep(dt) {
  race.t += dt;
  if (race.state === 'countdown') {
    const stage = race.t < 0.6 ? 0 : race.t < 1.6 ? 1 : race.t < 2.6 ? 2 : race.t < 3.6 ? 3 : 4;
    if (stage !== race.stage) { race.stage = stage; setGantry(stage);
      countEl.className = 'hud'; void countEl.offsetWidth;
      if (stage < 4) { countEl.textContent = 4 - stage; countEl.className = 'hud show'; sfx.count(); }
      else { countEl.textContent = 'GO!'; countEl.className = 'hud show go'; sfx.go(); race.state = 'race'; race.time = 0;
        if (me.kind === 'local' && input.up && input.pressAt >= 0 && race.t - input.pressAt < 1.0) { me.boost = 1.6; toast('ROCKET START!', 'orange'); sfx.boost(); }
        for (const k of active) if (k.kind === 'ai' && owned(k) && Math.random() < 0.45) k.boost = rr(0.6, 1.1); } }
  }
  if (race.state === 'race' || race.state === 'finished') race.time += dt;
  if (race.state === 'finished') { race.resultsT -= dt; if (race.resultsT <= 0 && !$('results').classList.contains('show')) { $('results').classList.add('show'); renderResults(); } resultsRefresh -= dt; if (resultsRefresh <= 0 && $('results').classList.contains('show')) { resultsRefresh = 0.5; renderResults(); } }
  const moving = race.state === 'race' || race.state === 'finished';
  { let s = 0, n = 0; for (const k of active) if (k.kind !== 'ai') { s += k.score; n++; } race.humanScore = n ? s / n : 0; }
  // controls + physics for the karts this machine owns; everyone else is interpolated
  for (const k of active) {
    if (owned(k)) {
      if (k.kind === 'local' && !k.finished) { k.throttle = input.up ? 1 : input.down ? -1 : 0; k.steer = (input.left ? 1 : 0) - (input.right ? 1 : 0); }
      else if (moving) aiControl(k, dt);
      if (moving && k.startDelay > 0) k.startDelay -= dt;
      kartStep(k, dt, moving && k.startDelay <= 0);
    } else applyRemote(k, dt);
  }
  collideKarts(); updateItems(dt);
  // ranking
  const sorted = active.slice().sort((a, b) => b.score - a.score); sorted.forEach((k, i) => k.place = i + 1);
  if (race.state === 'race' && !me.finished) {
    if (me.place !== race.placeCand) { race.placeCand = me.place; race.placeCandT = 0; } else race.placeCandT += dt;
    if (race.placeCand !== race.shownPlace && race.placeCandT > 0.22) { const up = race.placeCand < race.shownPlace; race.shownPlace = race.placeCand; setPosHud(race.shownPlace); toast((up ? '▲ ' : '▼ ') + ordinal(race.shownPlace).toUpperCase(), up ? 'up' : 'down'); up ? sfx.up() : sfx.down(); }
  }
  netTick(dt);
}
/* once per rendered frame */
function present(dt) {
  for (const k of active) kartVisual(k, dt);
  updateCamera(dt); updateParticles(dt); updateAmbient(dt);
  lapEl.innerHTML = `LAP <b>${clamp(me.lap, 1, 3)}</b>/3`; timerEl.textContent = fmtT(race.time);
  drawSpeedo(me.vf, me.boost > 0); drawMap();
  $('wrong').style.display = me.wrongWay > 0.8 && race.state === 'race' ? 'block' : 'none';
  if (race.flash > 0) { race.flash -= dt * 1.8; flashEl.style.opacity = Math.max(race.flash, 0); }
  sfx.engine(Math.abs(me.vf), me.boost > 0);
}
const SUB = 1 / 60;
const loop = createLoop(real => { timeU.value += real; fixedStep(real, SUB, simStep); present(real); renderer.render(scene, camera); });
karts.forEach((k, i) => resetKart(k, i)); karts.forEach(k => kartVisual(k, 0.016));
drawItemSlot(null); setPosHud(8); setGantry(0);

/* ============================================================ session API (used by the shell) */
let session = null;
const hintEl = $('hint');
/* 8 slots indexed by kart/avatar id: { kind: 'human' | 'ai' | 'none', id?, name? } */
function slotsFor({ players, opts }) {
  const slots = SKINS.map(() => ({ kind: opts && opts.fillAI ? 'ai' : 'none' }));
  for (const p of players) if (SKINS[p.avatar]) slots[p.avatar] = { kind: 'human', id: p.id, name: p.name };
  return slots;
}
function renderFoot() {
  const f = $('resFoot'); f.innerHTML = '';
  const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn small ' + cls; b.textContent = label; b.onclick = fn; f.appendChild(b); };
  if (!online) { btn('RACE AGAIN  (R)', 'primary', () => hooks.onRestart?.()); btn('MENU  (ESC)', '', () => hooks.onExit?.()); }
  else if (isHost) { btn('RACE AGAIN  (R)', 'primary', () => hooks.onRestart?.()); btn('BACK TO LOBBY  (ESC)', '', () => hooks.onExit?.()); }
  else f.textContent = 'WAITING FOR THE HOST TO RESTART OR RETURN TO THE LOBBY…';
}
function start(s) {
  session = s; isHost = !!s.isHost; online = !!s.online; me = null;
  const slots = slotsFor(s);
  for (const k of karts) {
    const sl = slots[k.id] || { kind: 'none' };
    k.kind = sl.kind === 'human' ? (sl.id === s.myId ? 'local' : 'remote') : sl.kind === 'ai' ? 'ai' : 'none';
    k.pid = sl.kind === 'human' ? sl.id : null; k.name = sl.kind === 'human' ? (sl.name || SKINS[k.id].name) : SKINS[k.id].name; k.buf = [];
    k.vis.g.visible = k.kind !== 'none'; setLabel(k, k.kind === 'remote' ? k.name : null);
    if (k.kind === 'local') me = k;
  }
  if (!me) { me = karts.find(k => k.kind !== 'none') || karts[0]; } // spectator fallback
  active = karts.filter(k => k.kind !== 'none');
  gridOrder = active.filter(k => k.kind === 'ai').map(k => k.id).concat(active.filter(k => k.kind !== 'ai').map(k => k.id));
  for (const k of karts) if (k.kind === 'none') k.place = 99;
  resetRace();
  hintEl.textContent = !online ? 'ARROWS / WASD · SPACE item · R restart · ESC menu · M sound' : isHost ? 'ARROWS / WASD · SPACE item · R again · ESC lobby · M sound' : 'ARROWS / WASD · SPACE item · M sound';
  renderFoot();
  audio.init(); kb.attach(); loop.start();
}
function stop() {
  session = null; race.state = 'intro'; clearHazards();
  $('results').classList.remove('show'); $('lapbox').classList.remove('final'); toasts.clear(); countEl.className = 'hud'; $('wrong').style.display = 'none'; flashEl.style.opacity = 0;
  for (const k of karts) { setLabel(k, null); k.vis.g.visible = true; k.vis.bodyMat.color.set(k.color); k.vis.bodyMat.emissive.set(0); k.vis.bodyMat.emissiveIntensity = 0; }
  active = karts; karts.forEach((k, i) => resetKart(k, i)); for (const b of itemBoxes) { b.active = true; b.g.visible = true; }
  kb.detach(); loop.stop(); sfx.silence();
}
function destroy() {
  stop(); sfx.dispose(); removeEventListener('resize', onResize);
  disposeScene(scene); renderer.dispose(); renderer.forceContextLoss?.();
  mount.innerHTML = ''; unloadCss(); if (window.__kart === debug) delete window.__kart;
}
/* a player dropped out mid-race: the host drives that kart from now on */
function playerLeft(pid) {
  const k = kartOf(pid); if (!k) return;
  k.kind = 'ai'; k.pid = null; k.buf = []; k.name = SKINS[k.id].name; setLabel(k, null);
  k.ai = { skill: rr(0.93, 1.0), wander: rr(0.6, 1.4), aggr: rr(0.2, 0.9), lane: 0, laneTarget: 0, laneTimer: rr(0, 2), stuck: 0, reverse: 0, itemTimer: 0, rubber: 1 };
  k.throttle = 0; k.steer = 0; k.roulette = 0;
}
function onNetMessage(msg) {
  if (race.state === 'intro') return;
  switch (msg.t) {
    case 's':
      for (const ks of msg.k || []) { const k = karts[ks.i]; if (k && !owned(k) && k.kind !== 'none') pushSnap(k.buf, ks); }
      if (!isHost && msg.r) { syncRace(msg.r); syncHazards(msg.z || []); if (msg.b !== undefined) syncBoxes(msg.b); }
      break;
    case 'pick': if (isHost) { const b = itemBoxes[msg.b]; if (b && b.active) { b.active = false; b.g.visible = false; b.respawn = 3.5; for (let i = 0; i < 10; i++) spawnP(b.x, b.y + 1.3, b.z, rr(-4, 4), rr(1, 6), rr(-4, 4), rr(0.3, 0.6), 0x9fe8ff, 0.8, 6); } } break;
    case 'use': if (isHost) { const k = kartOf(msg.from); if (k) spawnHazard(msg.it, k, msg.x, msg.z, msg.h, msg.vf, msg.tg >= 0 ? karts[msg.tg] : null); } break;
    case 'zap': { for (const o of active) if (owned(o) && o.id !== msg.by) hitKart(o, 'lightning', msg.by); sfx.lightning(); if (me.star <= 0) flash('#ffff80', 0.7); break; }
    case 'hit': if (isHost) { const i = hazards.findIndex(h => h.id === msg.id); if (i >= 0) { const h = hazards[i]; killHazard(i); if (msg.s) { const v = karts[msg.v]; if (v) hitBurst(v, msg.c); if (h.owner === me.id) niceShot(); send({ t: 'hitev', v: msg.v, c: msg.c, by: h.owner }); } } } break;
    case 'hitev': { const v = karts[msg.v]; if (!v || owned(v)) break; hitBurst(v, msg.c); if (msg.by === me.id && msg.c !== 'lightning') niceShot(); break; }
  }
}
const debug = { karts, race, hazards, remoteHaz, itemBoxes, S, L, N, get me() { return me; }, get active() { return active; }, get isHost() { return isHost; }, get online() { return online; }, get session() { return session; } };
window.__kart = debug;
return { start, stop, destroy, onNetMessage, playerLeft, debug };
}
