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
   shells, bananas, item boxes and the race clock - and broadcasts them as two streams (net.js): motion at 30 Hz from a
   steady worker timer and status at 5 Hz or on change, each stamped with the sender's clock. Everyone else's karts and
   the host's hazards are dead-reckoned to the present from those snapshots with the same kinematics (kartMotion), and
   the correction a fresh snapshot brings is hidden in a decaying visual offset. A client shows a ghost of its own throw
   until the host's copy arrives. Hits are decided by the victim's machine. F3 / I shows frame and network stats.

   Touch screens (core/touch.js): the left side is a steering pad, gas is automatic, BRAKE and ITEM sit under the right thumb and the
   item slot at the top left is a second ITEM button, ☰ opens a menu card, a phone held upright is asked to rotate, and rendering
   starts a detail tier lower. */
import * as THREE from 'three';
import { clamp, lerp, wrapAngle, ordinal, makeRng } from '../../core/math.js';
import { createToasts, esc, fmtTime, loadStylesheet } from '../../core/ui.js';
import { createInput } from '../../core/input.js';
import { createTouch, isCoarse } from '../../core/touch.js';
import { createLoop, fixedStep } from '../../core/loop.js';
import { nowSec, pushSnap, sampleSnaps, createSnapClock } from '../../core/interp.js';
import { createTicker } from '../../core/ticker.js';
import { NET_HZ, STATUS_HZ, F, HAZ_TYPES, packMotion, unpackMotion, packStatus, unpackStatus, statusKey, packHaz, unpackHaz } from './net.js';

/* kart skins, indexed by the shared avatar index (core/avatars.js) */
const SKINS = [
  { name: 'Frost', color: 0xff3b3b, helmet: 0xffffff, w: 'medium' },
  { name: 'Yeti', color: 0x3b82f6, helmet: 0xffd54a, w: 'heavy' }, { name: 'Blizzard', color: 0xfacc15, helmet: 0x1e293b, w: 'light' }, { name: 'Glacier', color: 0x22c55e, helmet: 0xffffff, w: 'medium' },
  { name: 'Aurora', color: 0xa855f7, helmet: 0x7fd0ff, w: 'light' }, { name: 'Flurry', color: 0xf97316, helmet: 0x111827, w: 'heavy' }, { name: 'Penguin', color: 0x06b6d4, helmet: 0xff3b3b, w: 'light' }, { name: 'Frostbite', color: 0xf472b6, helmet: 0xffffff, w: 'medium' },
];
/* weight classes: light karts launch and turn, heavy karts are fast and shove others aside; `bars` are the stat card */
const WEIGHT = {
  light: { label: 'LIGHT', vmax: 0.96, acc: 1.15, turn: 1.1, mass: 0.8, bars: [45, 95, 90] },
  medium: { label: 'MEDIUM', vmax: 1, acc: 1, turn: 1, mass: 1, bars: [70, 70, 70] },
  heavy: { label: 'HEAVY', vmax: 1.05, acc: 0.88, turn: 0.92, mass: 1.3, bars: [95, 45, 50] },
};

const HUD = `
<canvas id="c"></canvas>
<div id="item" class="hud panel"><canvas id="itemCanvas" width="168" height="168"></canvas><small>▲</small><div id="itemLabel"></div></div>
<div id="standings" class="hud panel"></div>
<div id="rightcol" class="hud"><div id="lapbox" class="panel"><div id="cupline" hidden></div><div id="lap">LAP <b>1</b>/3</div><div id="timer">0:00.00</div></div>
<div id="coinbox" class="panel"><i></i><b id="coinN">0</b></div></div>
<div id="pos" class="hud">8<sup>th</sup></div>
<div id="speedo" class="hud"><canvas id="speedCanvas" width="260" height="150"></canvas></div>
<div id="map" class="hud panel"><canvas id="mapCanvas" width="380" height="380"></canvas></div>
<div id="toasts" class="hud"></div>
<div id="count" class="hud"></div>
<div id="kartcard" class="hud panel"><b id="kcName"></b><span id="kcClass"></span><div class="bars"><div><i>SPEED</i><u><s></s></u></div><div><i>ACCEL</i><u><s></s></u></div><div><i>HANDLING</i><u><s></s></u></div></div></div>
<div id="wrong" class="hud">⟲ WRONG WAY</div>
<div id="hint" class="hud"></div>
<div id="corner" class="hud"></div>
<pre id="stats" class="hud panel" hidden></pre>
<div id="netwait" class="hud" hidden>WAITING FOR THE HOST…</div>
<div id="flash"></div>
<div id="ink"></div>
<div id="pad" class="ctl"><div class="ring"><div class="knob"></div></div><div class="lbl">◀ DRAG TO STEER ▶</div></div>
<div id="btnBrake" class="ctl btn-ctl">BRAKE</div>
<div id="btnItem" class="ctl btn-ctl"><b>ITEM</b><canvas id="btnItemCanvas" width="96" height="96"></canvas><small>▲</small></div>
<div id="btnMenu" class="ctl">☰</div>
<div id="pause" class="overlay"><div class="card"><h1>MENU</h1><div id="pauseBtns"></div></div></div>
<div id="rotate" class="overlay"><div><div class="phone">📱</div>ROTATE YOUR DEVICE<small>FROSTLINE KART PLAYS IN LANDSCAPE</small></div></div>
<div id="results"><div class="card"><h1 id="resTitle">FINISH!</h1><h2 id="resSub">FINAL STANDINGS</h2>
  <div class="tables"><div><table id="resTable"></table><div id="resLaps" class="laps"></div></div><div id="cupBox" hidden><h3 id="cupSub">CUP STANDINGS</h3><table id="cupTable"></table></div></div>
  <div class="foot" id="resFoot"></div><div id="resNext" class="next"></div></div></div>`;

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
const touch = isCoarse();                        // phones and tablets: on-screen controls, automatic gas, lighter rendering
mount.classList.toggle('touch', touch);
if (touch) $('rightcol').appendChild($('map'));  // the minimap stacks under the lap box, freeing both bottom corners for the thumbs

/* ============================================================ renderer / scene */
const canvas = $('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !touch, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.outputColorSpace = THREE.SRGBColorSpace;
const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color(0x3a4370);
scene.fog = new THREE.Fog(FOG_COLOR, 160, 820);
const camera = new THREE.PerspectiveCamera(70, innerWidth / innerHeight, 0.3, 3200);
const onResize = () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); }; addEventListener('resize', onResize);

/* detail ladder: pixel ratio, point lights, pine and snow counts. Touch devices start on MEDIUM; auto mode steps down when the
   frame rate stays low mid-race (see the frame loop); L (or the touch menu) cycles auto -> HIGH -> MEDIUM -> LOW -> auto, remembered per browser. */
const QUALITY = [{ name: 'HIGH', pr: 2, lights: true, pines: 1, snow: 1 }, { name: 'MEDIUM', pr: 1.25, lights: true, pines: 0.6, snow: 0.6 }, { name: 'LOW', pr: 0.8, lights: false, pines: 0.3, snow: 0.3 }];
const defaultQuality = touch ? 1 : 0;
let quality = defaultQuality, autoQuality = true, lowFpsT = 0, fps = 60, pineIm = null, snowRef = null;
{ let saved = null; try { saved = localStorage.getItem('lan_kart_quality'); } catch {} if (saved !== null && QUALITY[+saved]) { quality = +saved; autoQuality = false; } }
function applyQuality() {
  const q = QUALITY[quality]; renderer.setPixelRatio(Math.min(devicePixelRatio || 1, q.pr)); renderer.setSize(innerWidth, innerHeight);
  scene.traverse(o => { if (o.isPointLight) o.visible = q.lights; });
  if (pineIm) pineIm.count = Math.max(1, Math.round(pineIm.userData.total * q.pines));
  if (snowRef) snowRef.geo.setDrawRange(0, Math.round(snowRef.n * q.snow));
}
function setQuality(i, manual) { quality = clamp(i | 0, 0, QUALITY.length - 1); if (manual) { autoQuality = false; try { localStorage.setItem('lan_kart_quality', String(quality)); } catch {} } applyQuality(); }
function cycleQuality() {
  if (autoQuality) setQuality(0, true); else if (quality < QUALITY.length - 1) setQuality(quality + 1, true); else { autoQuality = true; try { localStorage.removeItem('lan_kart_quality'); } catch {} setQuality(defaultQuality); }
  toast((autoQuality ? 'AUTO' : QUALITY[quality].name) + ' DETAIL', 'blue');
}
const qualityLabel = () => 'DETAIL: ' + (autoQuality ? 'AUTO' : QUALITY[quality].name);

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

/* ============================================================ track
   One hand-built circuit driven in four variants (the Grand Prix races): `mirror` flips the world's x axis, `reverse` flips
   the direction of travel. Everything track-shaped lives in the `world` group and buildWorld() rebuilds it when the variant
   changes; the helpers below read the `let` state it fills in. */
const CTRL_BASE = [[-30,0],[40,0],[95,2],[132,14],[158,50],[152,95],[120,122],[85,118],[55,140],[20,168],[-20,158],[-35,122],[-22,85],[-50,62],[-80,80],[-82,118],[-110,150],[-150,140],[-175,100],[-170,55],[-140,20],[-110,2],[-80,0]];
const HW = 7.0, CURB = 1.3, WALL = 11.8, ROAD_Y = 0.14;
const VARIANTS = [
  { id: 0, name: 'FROSTLINE', mirror: false, reverse: false }, { id: 1, name: 'FROSTLINE REVERSE', mirror: false, reverse: true },
  { id: 2, name: 'FROSTLINE MIRROR', mirror: true, reverse: false }, { id: 3, name: 'FROSTLINE MIRROR REVERSE', mirror: true, reverse: true },
];
const N = 2200, RLM = HW - 1.6;
let variant = null, world = null;
let S = [], L = 1, DS = 1;                                   // track samples in the direction of travel, lap length, sample spacing
let RL, RLX, RLZ, RLK;                                       // racing line: lateral offset, world points and curvature per sample
let itemBoxes = [], coins = [], coinIm = null, gantryLights = [], standDefs = [], crowdFlashSpots = [], chimneys = [];
let mapBg = null, mapX = x => x, mapZ = z => z;              // minimap background and the world -> map projection
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

/* mountains ring the valley and never move */
{
  const geo = mergeGeoms([{ geo: new THREE.ConeGeometry(1, 1, 6), m: M4(0, 0.5, 0), color: 0x7a86a8 }, { geo: new THREE.ConeGeometry(0.42, 0.42, 6), m: M4(0, 0.79, 0), color: 0xf4f7ff }]);
  const im = new THREE.InstancedMesh(geo, vcMat(), 34);
  for (let i = 0; i < 34; i++) { const a = i / 34 * Math.PI * 2 + rr(-0.1, 0.1), r = rr(520, 760); const x = Math.cos(a) * r, z = Math.sin(a) * r + 80; const w = rr(120, 260), h = rr(150, 330); im.setMatrixAt(i, M4(x, terrainH(x, z) - 20, z, rnd() * 6.28, w, h, w * rr(0.8, 1.2))); }
  scene.add(im);
}
const CROWD_COLORS = [0xff4b4b, 0x3b82f6, 0xfbbf24, 0x22c55e, 0xf472b6, 0xf97316, 0xa78bfa, 0xffffff, 0x14b8a6];
function disposeObject(root) {
  root.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { for (const v of Object.values(m)) if (v && v.isTexture) v.dispose(); m.dispose(); }
  });
}

/* build (or rebuild) the circuit and everything placed around it for one variant */
function buildWorld(v) {
  if (world) { scene.remove(world); disposeObject(world); }
  variant = v; world = new THREE.Group(); scene.add(world);
  const { rnd, rr } = makeRng(4242);            // the layout is deterministic: every machine builds the same world
  const MX = v.mirror ? -1 : 1;
  const ctrl = CTRL_BASE.map(([x, z]) => [x * MX, z]);
  if (v.reverse) { const head = ctrl.shift(); ctrl.reverse(); ctrl.unshift(head); } // same loop and start point, opposite direction
  const add = o => { world.add(o); return o; };

  /* ---- samples along the direction of travel */
  const curve = new THREE.CatmullRomCurve3(ctrl.map(([x, z]) => new THREE.Vector3(x, 0, z)), true, 'catmullrom', 0.6);
  const pts = curve.getSpacedPoints(N); pts.pop();
  L = curve.getLength(); DS = L / N;
  S = pts.map(p => ({ x: p.x, z: p.z, y: terrainH(p.x, p.z) + ROAD_Y, tx: 0, tz: 0, lx: 0, lz: 0, k: 0 }));
  for (let i = 0; i < N; i++) {
    const a = S[(i - 1 + N) % N], b = S[(i + 1) % N]; let tx = b.x - a.x, tz = b.z - a.z; const l = Math.hypot(tx, tz); tx /= l; tz /= l;
    S[i].tx = tx; S[i].tz = tz; S[i].lx = tz; S[i].lz = -tx;
  }
  for (let i = 0; i < N; i++) { const a = S[(i - 2 + N) % N], b = S[(i + 2) % N]; S[i].k = wrapAngle(Math.atan2(b.tx, b.tz) - Math.atan2(a.tx, a.tz)) / (4 * DS); }

  /* ---- racing line: relax offsets toward a smooth path inside the corridor */
  RL = new Float32Array(N);
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
  RLX = new Float32Array(N); RLZ = new Float32Array(N); RLK = new Float32Array(N);
  for (let i = 0; i < N; i++) { RLX[i] = S[i].x + S[i].lx * RL[i]; RLZ[i] = S[i].z + S[i].lz * RL[i]; }
  for (let i = 0; i < N; i++) {
    const a = (i - 3 + N) % N, b = (i + 3) % N, c = (i - 9 + N) % N, d = (i + 9) % N;
    const h0 = Math.atan2(RLX[a] - RLX[c], RLZ[a] - RLZ[c]), h2 = Math.atan2(RLX[d] - RLX[b], RLZ[d] - RLZ[b]);
    RLK[i] = Math.abs(wrapAngle(h2 - h0)) / (12 * DS);
  }
  for (let pass = 0; pass < 4; pass++) { const c = Float32Array.from(RLK); for (let i = 0; i < N; i++) RLK[i] = (c[(i - 2 + N) % N] + c[(i - 1 + N) % N] + c[i] + c[(i + 1) % N] + c[(i + 2) % N]) / 5; }

  /* ---- road */
  add(new THREE.Mesh(stripMesh([
    { l0: -HW, l1: HW, y0: ROAD_Y, y1: ROAD_Y, color: i => tmpC.copy(ASPH).multiplyScalar(0.94 + 0.12 * ((i * 7919) % 13) / 13) },
    { l0: HW, l1: HW + CURB, y0: ROAD_Y + 0.05, y1: ROAD_Y + 0.05, color: i => (Math.floor(i / 7) % 2 ? CURB_B : CURB_W) },
    { l0: -HW - CURB, l1: -HW, y0: ROAD_Y + 0.05, y1: ROAD_Y + 0.05, color: i => (Math.floor(i / 7) % 2 ? CURB_W : CURB_B) },
    { l0: HW + CURB, l1: WALL, y0: ROAD_Y - 0.02, y1: 0.02, color: () => SLUSH },
    { l0: -WALL, l1: -HW - CURB, y0: 0.02, y1: ROAD_Y - 0.02, color: () => SLUSH },
    { l0: WALL, l1: WALL + 1.6, y0: 0.02, y1: 1.7, color: () => BANK }, { l0: WALL + 1.6, l1: WALL + 4.2, y0: 1.7, y1: 0.1, color: () => BANK },
    { l0: -WALL - 1.6, l1: -WALL, y0: 1.7, y1: 0.02, color: () => BANK }, { l0: -WALL - 4.2, l1: -WALL - 1.6, y0: 0.1, y1: 1.7, color: () => BANK },
  ]), new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9 })));

  /* scenery is authored against the forward track; in a reversed variant these map it back to the same physical spots */
  const pd = d => v.reverse ? ((L - d) % L + L) % L : d, pl = lat => v.reverse ? -lat : lat;
  const tp = (dist, lat) => trackPoint(pd(dist), pl(lat));
  const th = dist => headingAt(Math.floor(((pd(dist) % L) + L) % L / DS) % N);
  const place = (obj, dist, lat, faceTrack = true) => placeOnTrack(obj, pd(dist), pl(lat), faceTrack);

  /* ---- start line, grid boxes (these follow the direction of travel) */
  {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64; const g = cv.getContext('2d');
    for (let y = 0; y < 2; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#fff'; g.fillRect(x * 32, y * 32, 32, 32); }
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 3.2), new THREE.MeshBasicMaterial({ map: tex, polygonOffset: true, polygonOffsetFactor: -2 }));
    line.rotation.x = -Math.PI / 2; const p = trackPoint(0, 0); line.position.set(p.x, p.y + 0.02, p.z); line.rotation.z = -headingAt(0); add(line);
    const gridMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, polygonOffset: true, polygonOffsetFactor: -2 });
    for (let i = 0; i < 8; i++) { const m = new THREE.Mesh(new THREE.PlaneGeometry(2.6, 3.4), gridMat); m.rotation.x = -Math.PI / 2; const q = trackPoint(L - 9 - Math.floor(i / 2) * 6, i % 2 ? -2.8 : 2.8); m.position.set(q.x, q.y + 0.02, q.z); m.rotation.z = -headingAt(Math.floor((L - 9 - Math.floor(i / 2) * 6) / DS)); add(m); }
  }

  /* ---- gantry with lights */
  gantryLights = [];
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
    placeOnTrack(g, 0, 0, false); add(g);
    const pl = new THREE.PointLight(0xfff0c8, 60, 60); pl.position.set(0, 8, 2); g.add(pl);
  }

  /* ---- grandstands + crowd */
  const crowdBodyMat = flatMat({ roughness: 0.7 }), crowdHeadMat = flatMat({ roughness: 0.7 });
  const crowdShader = s => { s.uniforms.uTime = timeU; s.vertexShader = 'uniform float uTime;\n' + s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
    #ifdef USE_INSTANCING
    float ph = float(gl_InstanceID) * 1.618; float j = step(0.55, fract(ph * 0.37)) * max(0.0, sin(uTime * 5.0 + ph)) * 0.45; transformed.y += j;
    #endif`); };
  crowdBodyMat.onBeforeCompile = crowdShader; crowdHeadMat.onBeforeCompile = crowdShader;
  standDefs = [];
  const grandstand = (dist, lat, len, rows = 6) => {
    const g = new THREE.Group(); const step = 2.2, rise = 1.4, seats = Math.floor(len / 1.25);
    const concrete = flatMat({ color: 0x8d94ab }), steel = flatMat({ color: 0x3a4158 });
    for (let r = 0; r < rows; r++) { const m = new THREE.Mesh(new THREE.BoxGeometry(len, rise * (r + 1), step), concrete); m.position.set(0, rise * (r + 1) / 2, r * step + step / 2); g.add(m); }
    const back = new THREE.Mesh(new THREE.BoxGeometry(len + 1, rows * rise + 6, 0.5), steel); back.position.set(0, (rows * rise + 6) / 2, rows * step + 0.3); g.add(back);
    const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 2, 0.5, rows * step + 3), flatMat({ color: 0x1f6fd6 })); roof.position.set(0, rows * rise + 6, rows * step / 2 + 0.6); roof.rotation.x = 0.12; g.add(roof);
    for (const s of [-1, 1]) { const post = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.25, rows * rise + 6, 6), steel); post.position.set(s * (len / 2 + 0.5), (rows * rise + 6) / 2, 0.5); g.add(post); }
    const stripe = new THREE.Mesh(new THREE.BoxGeometry(len, 1.2, 0.2), flatMat({ color: 0xffffff })); stripe.position.set(0, rise * 0.6, -0.1); g.add(stripe);
    place(g, dist, lat, true); g.rotation.y += Math.PI; g.updateMatrixWorld(true);
    standDefs.push({ g, rows, seats, len, step, rise }); add(g);
  };
  grandstand(28, WALL + 8, 60); grandstand(110, WALL + 8, 60); grandstand(560, WALL + 8, 44, 5); grandstand(980, WALL + 8, 44, 5);
  {
    const total = standDefs.reduce((a, d) => a + d.rows * d.seats, 0);
    const bodies = new THREE.InstancedMesh(new THREE.BoxGeometry(0.75, 1.0, 0.6), crowdBodyMat, total), heads = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(0.34, 1), crowdHeadMat, total);
    let k = 0; const m = new THREE.Matrix4(), vv = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3(1, 1, 1), col = new THREE.Color();
    for (const d of standDefs) for (let r = 0; r < d.rows; r++) for (let s = 0; s < d.seats; s++) {
      vv.set(-d.len / 2 + 0.7 + s * 1.25 + rr(-0.15, 0.15), d.rise * (r + 1) + 0.5, r * d.step + d.step * 0.55); vv.applyMatrix4(d.g.matrixWorld);
      q.setFromEuler(new THREE.Euler(0, d.g.rotation.y + rr(-0.3, 0.3), 0));
      m.compose(vv, q, sc); bodies.setMatrixAt(k, m); bodies.setColorAt(k, col.set(CROWD_COLORS[Math.floor(rnd() * CROWD_COLORS.length)]));
      vv.y += 0.85; m.compose(vv, q, sc); heads.setMatrixAt(k, m); heads.setColorAt(k, col.set(rnd() < 0.5 ? 0xf1c9a5 : CROWD_COLORS[Math.floor(rnd() * CROWD_COLORS.length)]));
      k++;
    }
    add(bodies); add(heads);
  }
  crowdFlashSpots = []; for (const d of standDefs) for (let i = 0; i < 12; i++) { const vv = new THREE.Vector3(rr(-d.len / 2, d.len / 2), d.rise * rr(1, d.rows) + 1.2, rr(0, d.rows * d.step)); vv.applyMatrix4(d.g.matrixWorld); crowdFlashSpots.push(vv); }

  /* ---- pines */
  {
    const pineGeo = mergeGeoms([
      { geo: new THREE.CylinderGeometry(0.35, 0.5, 2.4, 6), m: M4(0, 1.2, 0), color: 0x5a3a22 },
      { geo: new THREE.ConeGeometry(3.2, 4.2, 7), m: M4(0, 3.6, 0), color: 0x1f6b3a }, { geo: new THREE.ConeGeometry(2.5, 3.6, 7), m: M4(0, 6.0, 0, 0.3), color: 0x2a7d45 }, { geo: new THREE.ConeGeometry(1.7, 3.0, 7), m: M4(0, 8.2, 0, 0.6), color: 0x35905a },
      { geo: new THREE.ConeGeometry(3.25, 1.2, 7), m: M4(0, 5.35, 0), color: 0xf3f7ff }, { geo: new THREE.ConeGeometry(2.55, 1.0, 7), m: M4(0, 7.45, 0, 0.3), color: 0xf3f7ff }, { geo: new THREE.ConeGeometry(1.75, 0.9, 7), m: M4(0, 9.3, 0, 0.6), color: 0xf3f7ff },
    ]);
    const spots = []; let tries = 0; const probe = new THREE.Vector3();
    while (spots.length < 900 && tries++ < 20000) {
      const a = rnd() * Math.PI * 2, r = 30 + Math.pow(rnd(), 0.6) * 520; const x = Math.cos(a) * r - 10 * MX, z = Math.sin(a) * r + 80;
      const td = trackDistOf(x, z); if (td.d < WALL + 8) continue; if (Math.hypot(x, z) > 620) continue;
      let ok = true; for (const d of standDefs) if (d.g.position.distanceTo(probe.set(x, 0, z)) < d.len / 2 + 10) ok = false; if (!ok) continue;
      spots.push([x, z]);
    }
    const im = new THREE.InstancedMesh(pineGeo, vcMat(), spots.length);
    spots.forEach(([x, z], i) => { const s = rr(0.7, 1.6); im.setMatrixAt(i, M4(x, terrainH(x, z) - 0.2, z, rnd() * 6.28, s, s * rr(0.9, 1.3), s)); });
    pineIm = im; im.userData.total = spots.length; add(im);
  }
  /* ---- snowmen */
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
    for (let i = 0; i < 14; i++) { const dist = i / 14 * L + rr(0, 40), lat = (rnd() < 0.5 ? -1 : 1) * rr(WALL + 5, WALL + 11); const p = tp(dist, lat); const s = rr(0.8, 1.3); im.setMatrixAt(i, M4(p.x, terrainH(p.x, p.z) - 0.1, p.z, rnd() * 6.28, s)); }
    add(im);
  }
  /* ---- flags along the track + bunting near the start */
  const flagMat = flatMat({ side: THREE.DoubleSide }); flagMat.onBeforeCompile = s => { s.uniforms.uTime = timeU; s.vertexShader = 'uniform float uTime;\n' + s.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
    #ifdef USE_INSTANCING
    float fx = max(0.0, position.x); transformed.z += sin(uTime * 6.0 + fx * 2.5 + float(gl_InstanceID)) * 0.22 * fx; transformed.y += sin(uTime * 4.0 + fx * 3.0 + float(gl_InstanceID)) * 0.06 * fx;
    #endif`); };
  {
    const poles = 44; const poleIm = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.12, 0.16, 7, 6), flatMat({ color: 0xdfe6f5 }), poles);
    const flagGeo = new THREE.PlaneGeometry(2.4, 1.4, 6, 1); flagGeo.translate(1.2, 0, 0); const flagIm = new THREE.InstancedMesh(flagGeo, flagMat, poles); const col = new THREE.Color();
    for (let i = 0; i < poles; i++) { const dist = i / poles * L + 12, lat = (i % 2 ? -1 : 1) * (WALL + 3); const p = tp(dist, lat); const h = th(dist); const y = terrainH(p.x, p.z);
      poleIm.setMatrixAt(i, M4(p.x, y + 3.5, p.z)); flagIm.setMatrixAt(i, M4(p.x, y + 6.2, p.z, h + Math.PI / 2 * (pl(lat) > 0 ? 1 : -1))); flagIm.setColorAt(i, col.set(CROWD_COLORS[i % CROWD_COLORS.length])); }
    add(poleIm); add(flagIm);
  }
  {
    const n = 120; const im = new THREE.InstancedMesh(new THREE.ConeGeometry(0.35, 0.8, 3), flagMat, n); const col = new THREE.Color();
    for (let i = 0; i < n; i++) { const dist = 12 + (i % 40) * 1.2 - 24 + (i < 40 ? 0 : i < 80 ? 60 : 130); const p = tp(dist, 0); im.setMatrixAt(i, M4(p.x, p.y + 10.2 + Math.sin((i % 40) / 40 * Math.PI) * -1.6, p.z, 0, 1, 1, 1, Math.PI)); im.setColorAt(i, col.set(CROWD_COLORS[i % 5])); }
    add(im);
    for (const d of [-12, 48, 118, 168]) for (const s of [-1, 1]) { const p = tp(d, s * (WALL + 1)); const post = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 10.5, 6), flatMat({ color: 0xdfe6f5 })); post.position.set(p.x, terrainH(p.x, p.z) + 5.25, p.z); add(post); }
  }
  /* ---- cabins with lit windows and chimney */
  chimneys = [];
  const cabin = (x, z, ry, s = 1) => {
    const g = new THREE.Group(); const wood = flatMat({ color: 0x8b5a2b }), snowM = flatMat({ color: 0xf2f6ff }), glow = flatMat({ color: 0xffd080, emissive: 0xffb040, emissiveIntensity: 1.6 });
    const walls = new THREE.Mesh(new THREE.BoxGeometry(12, 6, 9), wood); walls.position.set(0, 3, 0); g.add(walls);
    const roof = new THREE.Mesh(new THREE.ConeGeometry(8.8, 4.5, 4), snowM); roof.position.y = 8.2; roof.rotation.y = Math.PI / 4; roof.scale.set(1, 1, 0.8); g.add(roof);
    const roofU = new THREE.Mesh(new THREE.ConeGeometry(8.4, 4.2, 4), flatMat({ color: 0x5a3a22 })); roofU.position.y = 7.9; roofU.rotation.y = Math.PI / 4; roofU.scale.set(1, 1, 0.8); g.add(roofU);
    for (const [wx, wz] of [[-3.5, 4.55], [3.5, 4.55], [-6.05, 0], [6.05, 0], [-3.5, -4.55], [3.5, -4.55]]) { const w = new THREE.Mesh(new THREE.BoxGeometry(2, 1.8, 0.2), glow); w.position.set(wx, 3.3, wz); if (Math.abs(wx) > 6) w.rotation.y = Math.PI / 2; g.add(w); }
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.6, 3, 0.2), flatMat({ color: 0x3b2314 })); door.position.set(0, 1.5, 4.55); g.add(door);
    const ch = new THREE.Mesh(new THREE.BoxGeometry(1.2, 4, 1.2), flatMat({ color: 0x6b6f80 })); ch.position.set(3, 8.5, -1.5); g.add(ch);
    const pl = new THREE.PointLight(0xffb060, 40, 40); pl.position.set(0, 4, 6); g.add(pl);
    g.position.set(x * MX, terrainH(x * MX, z) - 0.2, z); g.rotation.y = ry * MX; g.scale.setScalar(s); add(g);
    chimneys.push(new THREE.Vector3(3, 10.5, -1.5).applyMatrix4(g.matrix.compose(g.position, g.quaternion, g.scale)));
  };
  cabin(60, 70, 0.4); cabin(-125, 75, -1.9, 1.15); cabin(210, 150, 2.4, 0.9);
  /* ---- frozen pond + ice crystals */
  {
    const pond = new THREE.Mesh(new THREE.CircleGeometry(20, 24), new THREE.MeshStandardMaterial({ color: 0xa9d6ff, roughness: 0.15, metalness: 0.4 })); pond.rotation.x = -Math.PI / 2; pond.scale.set(1.5, 1, 1); pond.position.set(40 * MX, terrainH(40 * MX, 60) + 0.15, 60); add(pond);
    const crystal = new THREE.InstancedMesh(new THREE.OctahedronGeometry(1, 0), new THREE.MeshStandardMaterial({ color: 0xa8e8ff, emissive: 0x3ab0ff, emissiveIntensity: 0.6, flatShading: true, transparent: true, opacity: 0.85 }), 60);
    for (let i = 0; i < 60; i++) { const dist = rnd() * L, lat = (rnd() < 0.5 ? -1 : 1) * rr(WALL + 4.5, WALL + 9); const p = tp(dist, lat); crystal.setMatrixAt(i, M4(p.x, terrainH(p.x, p.z) + 0.8, p.z, rnd() * 3, rr(0.5, 1.2), rr(1.2, 3.2), rr(0.5, 1.2), rr(-0.3, 0.3), rr(-0.3, 0.3))); }
    add(crystal);
  }
  /* ---- lamp posts */
  {
    const im = new THREE.InstancedMesh(mergeGeoms([{ geo: new THREE.CylinderGeometry(0.14, 0.2, 8, 6), m: M4(0, 4, 0), color: 0x2c3247 }, { geo: new THREE.BoxGeometry(1.6, 0.6, 0.9), m: M4(0, 8.1, 0), color: 0x2c3247 }]), vcMat(), 20);
    const lampIm = new THREE.InstancedMesh(new THREE.BoxGeometry(1.3, 0.25, 0.7), new THREE.MeshBasicMaterial({ color: 0xffe9b0 }), 20);
    for (let i = 0; i < 20; i++) { const dist = i / 20 * L + 30, lat = (i % 2 ? 1 : -1) * (WALL + 2.4); const p = tp(dist, lat); const y = terrainH(p.x, p.z); im.setMatrixAt(i, M4(p.x, y, p.z)); lampIm.setMatrixAt(i, M4(p.x, y + 7.75, p.z)); }
    add(im); add(lampIm);
  }
  /* ---- item boxes: four rows of three */
  itemBoxes = [];
  {
    const outerG = new THREE.BoxGeometry(1.7, 1.7, 1.7), innerG = new THREE.OctahedronGeometry(0.55, 0);
    for (const f of [0.10, 0.36, 0.62, 0.84]) for (const lat of [-4.2, 0, 4.2]) {
      const g = new THREE.Group(); const outer = new THREE.Mesh(outerG, new THREE.MeshStandardMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.55, roughness: 0.2, metalness: 0.3, emissive: 0x2a80ff, emissiveIntensity: 0.5 })); const inner = new THREE.Mesh(innerG, new THREE.MeshStandardMaterial({ color: 0xffd54a, emissive: 0xffb000, emissiveIntensity: 1.2, flatShading: true }));
      g.add(outer, inner); const p = tp(f * L, lat); g.position.set(p.x, p.y + 1.3, p.z); add(g); itemBoxes.push({ g, outer, inner, x: p.x, z: p.z, y: p.y, active: true, respawn: 0, hideUntil: 0, ph: rnd() * 6 });
    }
  }
  /* ---- coins: eight diagonal runs of six, between the item box rows */
  coins = [];
  {
    const geo = new THREE.CylinderGeometry(0.55, 0.55, 0.14, 12); geo.rotateX(Math.PI / 2);
    coinIm = new THREE.InstancedMesh(geo, flatMat({ color: 0xffd23f, emissive: 0xb07800, emissiveIntensity: 0.45, roughness: 0.35, metalness: 0.6 }), 48); coinIm.frustumCulled = false;
    [0.02, 0.18, 0.26, 0.44, 0.52, 0.70, 0.76, 0.92].forEach((f, g) => { for (let j = 0; j < 6; j++) { const p = tp(f * L + j * 2.6, (g % 2 ? 1 : -1) * (-3.5 + j * 1.4)); coins.push({ x: p.x, z: p.z, y: p.y, active: true, respawn: 0, hideUntil: 0 }); } });
    add(coinIm);
  }
  /* ---- minimap background */
  {
    const mapB ={ minx: Infinity, maxx: -Infinity, minz: Infinity, maxz: -Infinity }; for (const s of S) { mapB.minx = Math.min(mapB.minx, s.x); mapB.maxx = Math.max(mapB.maxx, s.x); mapB.minz = Math.min(mapB.minz, s.z); mapB.maxz = Math.max(mapB.maxz, s.z); }
    const mapScale = 340 / Math.max(mapB.maxx - mapB.minx, mapB.maxz - mapB.minz); mapX = x => 20 + (x - mapB.minx) * mapScale + (340 - (mapB.maxx - mapB.minx) * mapScale) / 2; mapZ = z => 20 + (z - mapB.minz) * mapScale + (340 - (mapB.maxz - mapB.minz) * mapScale) / 2;
    mapBg = document.createElement('canvas'); mapBg.width = mapBg.height = 380;
    const c = mapBg.getContext('2d'); c.lineJoin = 'round'; c.lineCap = 'round'; const path = () => { c.beginPath(); for (let i = 0; i <= N; i += 6) { const s = S[i % N]; i ? c.lineTo(mapX(s.x), mapZ(s.z)) : c.moveTo(mapX(s.x), mapZ(s.z)); } c.closePath(); };
    path(); c.lineWidth = 22; c.strokeStyle = 'rgba(255,255,255,.35)'; c.stroke(); path(); c.lineWidth = 14; c.strokeStyle = '#2c3350'; c.stroke();
    const s = S[0]; c.strokeStyle = '#fff'; c.lineWidth = 4; c.beginPath(); c.moveTo(mapX(s.x + s.lx * 9), mapZ(s.z + s.lz * 9)); c.lineTo(mapX(s.x - s.lx * 9), mapZ(s.z - s.lz * 9)); c.stroke();
    const a = S[Math.round(N * 0.04)]; const ax = mapX(a.x), az = mapZ(a.z), ang = Math.atan2(mapZ(a.z + a.tz) - az, mapX(a.x + a.tx) - ax); // direction arrow just past the line
    c.fillStyle = '#ffd54a'; c.beginPath(); c.moveTo(ax + Math.cos(ang) * 9, az + Math.sin(ang) * 9); c.lineTo(ax + Math.cos(ang + 2.5) * 8, az + Math.sin(ang + 2.5) * 8); c.lineTo(ax + Math.cos(ang - 2.5) * 8, az + Math.sin(ang - 2.5) * 8); c.closePath(); c.fill();
  }
}
buildWorld(VARIANTS[0]);
function setGantry(stage) { // 0 idle,1..3 reds, 4 green
  gantryLights.forEach((m, i) => { const on = stage === 4 ? true : i < stage * 2 - 1; const g = stage === 4; m.material.color.set(on ? (g ? 0x30ff70 : 0xff3030) : 0x331111); m.material.emissive.set(on ? (g ? 0x20ff60 : 0xff2020) : 0x220000); m.material.emissiveIntensity = on ? 2.5 : 0.6; });
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
  snow.vel = new Float32Array(snow.n).map(() => rr(3, 7)); snowRef = snow;
}
applyQuality();

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
/* per-race tuning: the engine class (lobby option) scales these; the kart code only ever reads the variables */
let VMAX = 32, ACC = 18, BOOST_ACC = 52, BRAKE = 30, REV_MAX = 9, TURN = 2.6;
const TURN_HI = 0.55, GRIP = 7.5, KART_R = 1.3;
const CLASS = { 50: { speed: 0.8, turn: 1 }, 100: { speed: 1, turn: 1 }, 150: { speed: 1.18, turn: 1.08 } };
function applyClass(cc) { const c = CLASS[cc] || CLASS[100]; VMAX = 32 * c.speed; ACC = 18 * c.speed; BOOST_ACC = 52 * c.speed; BRAKE = 30 * c.speed; REV_MAX = 9 * c.speed; TURN = 2.6 * c.turn; }
/* CPU difficulty (lobby option): top-speed skill range, rubber-band window and pull, lane wander, item cadence */
const CPU = {
  easy: { skill: [0.84, 0.92], rubber: [-0.14, 0.05], pull: 0.6, wander: 1.5, item: 1.8 },
  normal: { skill: [0.93, 1.0], rubber: [-0.07, 0.11], pull: 0.45, wander: 1.0, item: 1.0 },
  hard: { skill: [0.99, 1.05], rubber: [-0.03, 0.14], pull: 0.4, wander: 0.7, item: 0.6 },
};
let cpuCfg = CPU.normal;
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
  return { id: i, name: def.name, color: def.color, w: WEIGHT[def.w], kind: i === 0 ? 'local' : 'ai', pid: null, vis, buf: [], status: null, statusT: 0, lastTs: -1, netA: null, netB: null, clock: null, clockFrom: null, ox: 0, oz: 0, oh: 0, sentKey: '', startDelay: 0, x: 0, y: 0, z: 0, h: 0, vx: 0, vz: 0, vf: 0, steer: 0, throttle: 0, idx: -1, dist: 0, lat: 0, lap: 0, cpNext: 0, score: 0, place: i + 1, finished: false, finishTime: 0,
    item: null, itemN: 0, held: false, coins: 0, timed: 0, fireCd: 0, bullet: 0, ink: 0, roulette: 0, boost: 0, spin: 0, spinAng: 0, star: 0, shrink: 0, hitCd: 0, wallCd: 0, offroad: false, lapTimes: [], lapStart: 0, wheelRot: 0, roll: 0, pitch: 0, prevVf: 0, steerVis: 0, wrongWay: 0,
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
  Object.assign(k, { x: p.x, y: p.y, z: p.z, h: headingAt(i), vx: 0, vz: 0, vf: 0, steer: 0, throttle: 0, idx: i, dist: s.dist, lat: s.lat, lap: 0, cpNext: 0, score: 0, finished: false, finishTime: 0, item: null, itemN: 0, held: false, coins: 0, timed: 0, fireCd: 0, bullet: 0, ink: 0, roulette: 0, boost: 0, spin: 0, spinAng: 0, star: 0, shrink: 0, hitCd: 0, wallCd: 0, offroad: false, lapTimes: [], lapStart: 0, prevVf: 0, wrongWay: 0, startDelay: 0, buf: [], status: null, statusT: 0, lastTs: -1, netA: null, netB: null, clock: null, clockFrom: null, ox: 0, oz: 0, oh: 0, sentKey: '' });
  k.ai = freshAi(k.kind === 'ai');
  k.vis.body.scale.setScalar(1); k.vis.bodyMat.color.set(k.color); k.vis.bodyMat.emissive.set(0); k.vis.bodyMat.emissiveIntensity = 0; heldVisual(k);
}
const freshAi = cpu => ({ skill: cpu ? rr(cpuCfg.skill[0], cpuCfg.skill[1]) : 1, wander: rr(0.6, 1.4) * cpuCfg.wander, aggr: rr(0.2, 0.9), lane: 0, laneTarget: 0, laneTimer: rr(0, 2), stuck: 0, reverse: 0, itemTimer: 0, rubber: 1 });

const kartVmax = k => VMAX * k.w.vmax * (1 + 0.009 * k.coins) * (k.boost > 0 ? 1.42 : 1) * (k.star > 0 ? 1.18 : 1) * (k.bullet > 0 ? 1.9 : 1) * (k.shrink > 0 ? 0.72 : 1) * (k.offroad && k.star <= 0 && k.bullet <= 0 ? 0.55 : 1) * (k.kind === 'ai' ? k.ai.skill * k.ai.rubber : 1);
const turnRate = vf => TURN * (1 - TURN_HI * clamp(Math.abs(vf) / VMAX, 0, 1));

/* the kinematic core, shared by kartStep (the karts this machine drives) and the dead reckoning of everyone else's:
   accelerate, turn, slide, integrate, then keep the kart inside the walls. Reads the effect timers, never changes them.
   Returns the side (+1 / -1) of a hard wall hit, else 0. */
function kartMotion(k, dt, throttle, steer) {
  const fx = Math.sin(k.h), fz = Math.cos(k.h), lx = Math.cos(k.h), lz = -Math.sin(k.h);
  let vf = k.vx * fx + k.vz * fz, vl = k.vx * lx + k.vz * lz;
  const vmax = kartVmax(k);
  if (k.ink > 0) steer = clamp(steer + Math.sin(timeU.value * 6 + k.id) * 0.3, -1, 1); // inked: the kart wanders
  if (k.spin > 0) { throttle = 0; steer = 0; vf *= Math.exp(-2.2 * dt); }
  if (k.boost > 0 && vf < vmax) vf = Math.min(vmax, vf + BOOST_ACC * dt);
  if (k.bullet > 0) { throttle = 1; if (vf < vmax) vf = Math.min(vmax, vf + BOOST_ACC * 1.5 * dt); }
  if (throttle > 0) { const acc = (k.boost > 0 ? BOOST_ACC : ACC) * k.w.acc; vf += (throttle * acc - acc * Math.max(vf, 0) / vmax) * dt; }
  else if (throttle < 0) { if (vf > 0.4) vf -= BRAKE * dt; else vf = Math.max(vf - ACC * 0.6 * dt, -REV_MAX * -throttle); }
  else { vf -= Math.sign(vf) * Math.min(Math.abs(vf), (4 + Math.abs(vf) * 0.35) * dt); }
  if (vf > vmax * 1.02 && k.boost <= 0 && k.bullet <= 0) vf -= (vf - vmax) * 1.6 * dt;
  const w = (k.bullet > 0 ? TURN * 1.6 : turnRate(vf) * k.w.turn) * clamp(vf / 6, -1, 1); // a bullet bill corners on rails
  k.h += steer * w * dt;
  if (Math.abs(steer) > 0.3 && Math.abs(vf) > 12) vl -= steer * Math.abs(vf) * 0.09 * dt; // a hint of slide
  vl *= Math.exp(-(k.spin > 0 ? 1.5 : k.bullet > 0 ? 20 : k.ink > 0 ? GRIP * 0.5 : GRIP) * dt);
  const nfx = Math.sin(k.h), nfz = Math.cos(k.h), nlx = Math.cos(k.h), nlz = -Math.sin(k.h);
  k.vx = nfx * vf + nlx * vl; k.vz = nfz * vf + nlz * vl; k.vf = vf;
  k.x += k.vx * dt; k.z += k.vz * dt;
  return trackClamp(k);
}
/* project onto the track (idx, lat, dist, offroad, road height) and push back inside the walls; returns the side of a hard wall hit */
function trackClamp(k) {
  k.idx = nearestSample(k.x, k.z, k.idx, k.idx < 0 ? 0 : 40);
  const s = S[k.idx]; const dx = k.x - s.x, dz = k.z - s.z; let lat = dx * s.lx + dz * s.lz; const along = clamp(dx * s.tx + dz * s.tz, -DS, DS);
  const lim = WALL - KART_R; let hit = 0;
  if (Math.abs(lat) > lim) {
    const sign = Math.sign(lat); const over = Math.abs(lat) - lim; k.x -= s.lx * over * sign; k.z -= s.lz * over * sign; lat = sign * lim;
    const vn = k.vx * s.lx + k.vz * s.lz; if (vn * sign > 0) { k.vx -= s.lx * vn * 1.3; k.vz -= s.lz * vn * 1.3; if (Math.abs(vn) > 6 && k.wallCd <= 0) { k.wallCd = 0.4; k.vf *= 0.8; k.vx *= 0.8; k.vz *= 0.8; hit = sign; } }
  }
  k.lat = lat; k.offroad = Math.abs(lat) > HW + CURB * 0.6; k.y = terrainH(k.x, k.z) + ROAD_Y;
  k.dist = ((k.idx * DS + along) % L + L) % L;
  return hit;
}
/* lap progress: laps, then checkpoints, then distance within the segment (finishers rank by time) */
function scoreOf(k) { const last = (k.cpNext - 1 + CP) % CP; return k.finished ? 1e7 - k.finishTime : k.lap * L + last * CPL + clamp(wrapHalf(k.dist - last * CPL), -CPL, CPL * 1.5); }

function kartStep(k, dt, canMove) {
  // timed items and status effects
  if (k.timed > 0) { k.timed -= dt; if (k.timed <= 0) { k.timed = 0; if (k.item && ITEM_DEF[k.item].timed) takeOne(k); } }
  if (k.fireCd > 0) k.fireCd -= dt; if (k.ink > 0) k.ink -= dt;
  if (k.bullet > 0) { k.bullet -= dt; if (k.bullet <= 0) { k.boost = Math.max(k.boost, 1.0); k.hitCd = Math.max(k.hitCd, 1.0); } }
  const spinning = k.spin > 0, boosting = k.boost > 0;
  const hit = kartMotion(k, dt, canMove ? k.throttle : 0, k.steer);
  if (spinning) { k.spin -= dt; k.spinAng += dt * 10.5; }
  if (boosting) k.boost -= dt;
  if (hit) { const s = S[k.idx]; for (let i = 0; i < 6; i++) spawnP(k.x + s.lx * hit, k.y + 0.6, k.z + s.lz * hit, rr(-3, 3), rr(2, 6), rr(-3, 3), rr(0.3, 0.6), 0xfff2a0, 0.8, 12); if (isMe(k)) sfx.bump(); }
  k.wallCd -= dt; k.hitCd -= dt;
  // checkpoints + laps
  const segStart = k.cpNext * CPL; const rel = ((k.dist - segStart) % L + L) % L;
  if (rel < CPL) { if (k.cpNext === 0) onLapLine(k); k.cpNext = (k.cpNext + 1) % CP; }
  k.score = scoreOf(k);
  // wrong way (local player only)
  const s = S[k.idx]; const dot = Math.sin(k.h) * s.tx + Math.cos(k.h) * s.tz; k.wrongWay = (dot < -0.3 && k.vf > 3) ? k.wrongWay + dt : 0;
  k.star -= dt; k.shrink -= dt;
  if (k.shrink > 0 && k.shrink < 0.01) k.vis.body.scale.setScalar(1);
}

/* ---- remote karts: dead-reckoned to the present from their owner's snapshots
   Each snapshot carries pose, velocity and controls, stamped with the sender's clock (mapped into ours by its SnapClock).
   The kart is shown at `now - D`, D being that clock's adaptive delay: zero on a clean LAN, so the latest snapshot is
   carried forward with the shared kinematics and the kart is where it really is; more on a jittery link, so there is
   usually a later snapshot to interpolate toward instead. When a fresh snapshot lands somewhere other than where the
   extrapolation had put the kart, the difference goes into a visual offset (ox, oz, oh) that decays over a few frames, so
   the correction is a glide rather than a jump; a jump too big to hide snaps. Collisions and hits use the predicted pose;
   the offset is for the eyes only. */
const MAX_LEAD = 0.35, DR_STEP = 1 / 60, SNAP_DIST = 4, SNAP_ANG = 1.2, OFFSET_DECAY = 14;
const drA = {}, drB = {}; // scratch karts for dead reckoning
/* a snapshot far from the kart's last known sample (a long stall, a respawn) needs a fresh full search, or the narrow local
   search would lock onto the wrong part of the circuit and the wall clamp would drag the kart there */
const idxNear = (idx, x, z) => { if (idx < 0) return -1; const s = S[idx]; return (s.x - x) ** 2 + (s.z - z) ** 2 > 12 * 12 ? -1 : idx; };
/* carry snapshot `a` of kart k forward by `lead` seconds into `out` */
function deadReckon(k, a, lead, out) {
  Object.assign(out, { id: k.id, w: k.w, kind: 'remote', coins: k.coins, x: a.x, z: a.z, h: a.h, vx: a.vx, vz: a.vz, vf: a.vf, idx: idxNear(k.idx, a.x, a.z), wallCd: 0, lat: 0, dist: 0, y: 0,
    boost: a.fl & F.BOOST ? 1 : 0, spin: a.fl & F.SPIN ? 1 : 0, star: a.fl & F.STAR ? 1 : 0, bullet: a.fl & F.BULLET ? 1 : 0, shrink: a.fl & F.SHRINK ? 1 : 0, ink: a.fl & F.INK ? 1 : 0, offroad: !!(a.fl & F.OFFROAD) });
  const n = lead > 0 ? Math.ceil(lead / DR_STEP) : 0;
  if (!n) trackClamp(out); else { const dt = lead / n; for (let i = 0; i < n; i++) kartMotion(out, dt, a.th, a.st); }
  return out;
}
/* hide a pose jump in the object's visual offset, or snap when it is too big to glide */
function absorbJump(o, jx, jz, jh) {
  if (jx * jx + jz * jz > SNAP_DIST * SNAP_DIST || Math.abs(jh) > SNAP_ANG) { o.ox = o.oz = o.oh = 0; netStats.snaps++; return; }
  o.ox += jx; o.oz += jz; o.oh += jh; netStats.corr++; netStats.corrM += Math.hypot(jx, jz);
}
function decayOffset(o, dt) { const f = Math.exp(-OFFSET_DECAY * dt); o.ox *= f; o.oz *= f; o.oh *= f; }
function applyRemote(k, dt) {
  decayOffset(k, dt);
  const buf = k.buf; if (!buf.length || !k.clock) return;
  const now = nowSec(), rt = now + k.clock.transit - k.clock.D, latest = buf[buf.length - 1]; // the sender's present, less the jitter backoff
  const { a, b, f } = sampleSnaps(buf, rt);
  let p;
  if (b) { p = drA; Object.assign(p, { x: lerp(a.x, b.x, f), z: lerp(a.z, b.z, f), h: a.h + wrapAngle(b.h - a.h) * f, vx: lerp(a.vx, b.vx, f), vz: lerp(a.vz, b.vz, f), vf: lerp(a.vf, b.vf, f), idx: idxNear(k.idx, a.x, a.z), wallCd: 0 }); trackClamp(p); }
  else { const lead = rt - a.t; if (lead > MAX_LEAD) { if (!k.frozen) { k.frozen = true; netStats.frozen++; } } else k.frozen = false; p = deadReckon(k, a, clamp(lead, 0, MAX_LEAD), drA); } // past MAX_LEAD the kart holds still: a stall, counted once
  if (k.netA && !k.netB && (a !== k.netA || b)) { // we were extrapolating from netA: how far off was that, carried to the same instant?
    const c = deadReckon(k, k.netA, clamp(rt - k.netA.t, 0, MAX_LEAD), drB);
    absorbJump(k, c.x - p.x, c.z - p.z, wrapAngle(c.h - p.h));
  }
  k.netA = a; k.netB = b; netStats.lead += ((now - latest.t) - netStats.lead) * 0.05;
  k.x = p.x; k.z = p.z; k.h = p.h; k.vx = p.vx; k.vz = p.vz; k.vf = p.vf; k.idx = p.idx; k.lat = p.lat; k.dist = p.dist; k.offroad = p.offroad; k.y = p.y;
  k.steer = latest.st; k.throttle = latest.th; k.finished = !!(latest.fl & F.FINISHED);
  // laps, items and the effect timers arrive at STATUS_HZ; the motion flags say which effects are on right now
  const st = k.status, age = st ? now - k.statusT : 0, fl = latest.fl, tmr = (bit, v) => fl & bit ? Math.max(v - age, 0.05) : 0;
  if (st) {
    k.lap = st.lp; k.cpNext = st.cp; k.item = st.it; k.itemN = st.ic; k.held = st.he; k.coins = st.co; k.roulette = st.ro; k.finishTime = st.ft; if (st.fi) k.finished = true;
    k.boost = tmr(F.BOOST, st.bo); k.spin = tmr(F.SPIN, st.sp); k.star = tmr(F.STAR, st.sr); k.shrink = tmr(F.SHRINK, st.sh); k.bullet = tmr(F.BULLET, st.bu); k.ink = tmr(F.INK, st.ik);
    k.spinAng = k.spin > 0 ? st.sa + age * 10.5 : 0;
  } else { k.boost = fl & F.BOOST ? 1 : 0; k.spin = fl & F.SPIN ? 1 : 0; k.star = fl & F.STAR ? 1 : 0; k.shrink = fl & F.SHRINK ? 1 : 0; k.bullet = fl & F.BULLET ? 1 : 0; k.ink = fl & F.INK ? 1 : 0; }
  if (k.finished && !k.finishTime) k.finishTime = race.time; // until the status with the real time lands
  k.score = scoreOf(k);
}

const kvN = new THREE.Vector3(), kvUp = new THREE.Vector3(0, 1, 0), kvQt = new THREE.Quaternion(), kvQy = new THREE.Quaternion();
function kartVisual(k, dt) {
  const v = k.vis; v.g.position.set(k.x + k.ox, k.y, k.z + k.oz);
  const e = 0.6, hx = terrainH(k.x + e, k.z) - terrainH(k.x - e, k.z), hz = terrainH(k.x, k.z + e) - terrainH(k.x, k.z - e);
  const n = kvN.set(-hx, 2 * e, -hz).normalize(); const qt = kvQt.setFromUnitVectors(kvUp, n); const qy = kvQy.setFromAxisAngle(kvUp, k.h + k.oh);
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
  if (v.label) { v.label.visible = race.state !== 'intro'; v.label.position.set(k.x + k.ox, k.y + 3.4, k.z + k.oz); }
  if (k.bullet > 0) { // the kart becomes a bullet bill
    if (!v.bullet) { v.bullet = bulletMesh(); v.g.add(v.bullet); }
    v.bullet.visible = true; v.body.visible = false; v.bullet.rotation.z = Math.sin(timeU.value * 20) * 0.04; v.bullet.position.y = 1.0 + Math.sin(timeU.value * 9) * 0.06;
    for (let q = 0; q < 2; q++) spawnP(k.x - fx * 2.2, k.y + 1.0, k.z - fz * 2.2, -fx * 6 + rr(-3, 3), rr(0, 3), -fz * 6 + rr(-3, 3), rr(0.25, 0.5), q ? 0xff8a20 : 0xffd040, 1.4);
  } else { v.body.visible = true; if (v.bullet) v.bullet.visible = false; }
  if (k.ink > 0 && Math.random() < 0.3) spawnP(k.x + rr(-0.8, 0.8), k.y + rr(0.5, 1.5), k.z + rr(-0.8, 0.8), 0, -1, 0, 0.5, 0x101430, 0.7, 4);
  heldVisual(k);
}
function bulletMesh() {
  const g = new THREE.Group(); const black = flatMat({ color: 0x14161c, roughness: 0.5 });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 2.2, 14), black); body.rotation.x = Math.PI / 2; g.add(body);
  const nose = new THREE.Mesh(new THREE.ConeGeometry(0.95, 1.3, 14), black); nose.rotation.x = Math.PI / 2; nose.position.z = 1.75; g.add(nose);
  const tail = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.95, 0.4, 14), flatMat({ color: 0xffb300 })); tail.rotation.x = Math.PI / 2; tail.position.z = -1.3; g.add(tail);
  for (const s of [-1, 1]) { const eye = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.42, 0.12), new THREE.MeshBasicMaterial({ color: 0xffffff })); eye.position.set(s * 0.45, 0.35, 1.05); g.add(eye); const arm = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.8), flatMat({ color: 0xffffff })); arm.position.set(s * 1.05, -0.2, 0.2); g.add(arm); }
  return g;
}
/* a deployed item trails behind the kart (one) or orbits it (a triple); the same spots are the shield hit-zones */
function heldPositions(k, out = []) {
  out.length = 0; if (!k.held || !k.item || k.itemN <= 0) return out;
  const n = k.itemN;
  if (n === 1) { out.push({ x: k.x - Math.sin(k.h) * 2.4, z: k.z - Math.cos(k.h) * 2.4 }); return out; }
  for (let i = 0; i < n; i++) { const a = timeU.value * 3 + i * Math.PI * 2 / n; out.push({ x: k.x + Math.sin(a) * 2.3, z: k.z + Math.cos(a) * 2.3 }); }
  return out;
}
const heldTmp = [];
function heldVisual(k) {
  const v = k.vis; if (!v.held) v.held = { type: null, meshes: [] };
  const spots = heldPositions(k, heldTmp), type = spots.length ? k.item : null;
  if (v.held.type !== type || v.held.meshes.length !== spots.length) {
    for (const m of v.held.meshes) { scene.remove(m); disposeObject(m); } v.held.meshes = []; v.held.type = type;
    for (let i = 0; i < spots.length; i++) v.held.meshes.push(hazMesh(type));
  }
  spots.forEach((s, i) => { const m = v.held.meshes[i]; m.position.set(s.x, terrainH(s.x, s.z) + ROAD_Y + 0.6, s.z); m.rotation.y += 0.1; });
}

/* each machine only moves the karts it owns; a pair with no owned kart is left to the other machines */
function collideKarts() {
  for (let i = 0; i < active.length; i++) for (let j = i + 1; j < active.length; j++) {
    const a = active[i], b = active[j]; const oa = owned(a), ob = owned(b); if (!oa && !ob) continue;
    const dx = b.x - a.x, dz = b.z - a.z; const d = Math.hypot(dx, dz), minD = KART_R * 2 * (a.shrink > 0 ? 0.8 : 1) * (b.shrink > 0 ? 0.8 : 1);
    if (d < minD && d > 1e-4) {
      const nx = dx / d, nz = dz / d, over = (minD - d) * 0.5;
      const tot = a.w.mass + b.w.mass, sa = 2 * b.w.mass / tot, sb = 2 * a.w.mass / tot; // the lighter kart takes more of the shove
      if (oa) { a.x -= nx * over * sa; a.z -= nz * over * sa; } if (ob) { b.x += nx * over * sb; b.z += nz * over * sb; }
      const rel = (b.vx - a.vx) * nx + (b.vz - a.vz) * nz;
      if (rel < 0) {
        const imp = -rel * 0.65; if (oa) { a.vx -= nx * imp * sa; a.vz -= nz * imp * sa; } if (ob) { b.vx += nx * imp * sb; b.vz += nz * imp * sb; }
        if (-rel > 4) { const mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2; for (let q = 0; q < 5; q++) spawnP(mx, a.y + 0.6, mz, rr(-4, 4), rr(2, 5), rr(-4, 4), rr(0.25, 0.5), 0xfff0a0, 0.7, 12); if (isMe(a) || isMe(b)) sfx.bump(); }
        const aP = a.star > 0 || a.bullet > 0, bP = b.star > 0 || b.bullet > 0;
        if (aP && !bP && ob) hitKart(b, a.bullet > 0 ? 'bullet' : 'star', a.id); if (bP && !aP && oa) hitKart(a, b.bullet > 0 ? 'bullet' : 'star', b.id);
      }
    }
  }
}

/* a bullet bill drives itself down the racing line at full tilt */
function bulletControl(k) {
  const la = 6 + Math.abs(k.vf) * 0.3; const j = (k.idx + Math.round(la / DS)) % N;
  k.steer = clamp(wrapAngle(Math.atan2(RLX[j] - k.x, RLZ[j] - k.z) - k.h) * 3, -1, 1); k.throttle = 1;
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
  a.lane = lerp(a.lane, clamp(laneT, -RLM - 1, RLM + 1), 1 - Math.exp(-2.2 * dt));
  const vf = k.vf; const la = 4.5 + Math.abs(vf) * 0.34; const j = (k.idx + Math.round(la / DS)) % N;
  const tx = RLX[j] + S[j].lx * a.lane, tz = RLZ[j] + S[j].lz * a.lane;
  const err = wrapAngle(Math.atan2(tx - k.x, tz - k.z) - k.h);
  k.steer = clamp(err * 2.6, -1, 1);
  let kmax = 0; const n0 = Math.round(3 / DS), n1 = Math.round((6 + Math.abs(vf) * 1.05) / DS);
  for (let o = n0; o <= n1; o += 4) kmax = Math.max(kmax, RLK[(k.idx + o) % N]);
  const R = 1 / Math.max(kmax, 1e-4), sf = 0.92 * a.skill, T = TURN * k.w.turn; const vt = Math.min(kartVmax(k) + 5, T * R * sf / (1 + T * TURN_HI * R * sf / VMAX)); // fastest speed the turn rate can hold radius R at
  k.throttle = vf < vt ? 1 : (vf - vt > 4 ? -0.6 : 0.15);
  if (Math.abs(vf) < 1.5 && race.state !== 'countdown' && k.spin <= 0) a.stuck += dt; else a.stuck = 0;
  if (a.stuck > 1.3) { a.reverse = 0.9; a.stuck = 0; a.stuckCount = (a.stuckCount || 0) + 1; }
  if (a.reverse > 0) { a.reverse -= dt; k.throttle = -1; k.steer = -Math.sign(err); }
  a.rubber = 1 + clamp((race.humanScore - k.score) / L * cpuCfg.pull, cpuCfg.rubber[0], cpuCfg.rubber[1]); // rubber-band toward the humans
  // items
  if (k.item && k.roulette <= 0) {
    a.itemTimer += dt / cpuCfg.item; const ahead = active.some(o => o !== k && wrapHalf(o.dist - k.dist) > 0 && wrapHalf(o.dist - k.dist) < 45);
    const behind = active.some(o => o !== k && wrapHalf(k.dist - o.dist) > 0 && wrapHalf(k.dist - o.dist) < 10);
    const t = k.item, tm = a.itemTimer;
    if (HOLDABLE(t)) { // carried as a shield until there is something worth throwing at
      if (!k.held) k.held = true;
      let dir = 0;
      if (t === 'banana') { if ((behind && tm > 0.5) || tm > 6) dir = -1; }
      else if (t === 'green') { if (ahead && tm > 0.4) dir = 1; else if (behind && tm > 0.4) dir = -1; else if (tm > 6) dir = 1; }
      else if (t === 'red') { if ((ahead && tm > 0.6) || tm > 7) dir = 1; }
      else if (t === 'bomb') { if (ahead && tm > 0.6) dir = 1; else if (behind && tm > 0.6) dir = -1; else if (tm > 8) dir = 1; }
      if (dir) { itemRelease(k, dir); a.itemTimer = 0; }
    } else if (t === 'golden') { if (tm > 0.9) { itemPress(k); a.itemTimer = 0; } }
    else if (t === 'fire') { const dir = ahead ? 1 : behind ? -1 : 0; if ((dir && tm > 0.7) || tm > 3) { itemPress(k, dir || 1); a.itemTimer = 0; } }
    else {
      const use = t === 'mushroom' ? tm > 0.8 && kmax < 0.03 : t === 'blue' ? (k.place > 1 ? tm > 1 : tm > 6) : t === 'blooper' ? (k.place > 1 && tm > 0.5) || tm > 8 : tm > 0.6;
      if (use) { useItem(k); a.itemTimer = 0; }
    }
  }
}

/* ============================================================ race state */
const race = { state: 'intro', t: 0, time: 0, laps: 3, stage: 0, shake: 0, flash: 0, placeCand: 0, placeCandT: 0, shownPlace: 0, resultsT: 0, humanScore: 0, zapCd: 0 };
/* Grand Prix: one race per track variant, points carried across races while the same roster keeps going.
   The host banks the points when it moves the room on (auto-advance, R or the button) and tells everyone;
   `pending` holds them until the next start() so every machine agrees on the totals. */
const CUP_POINTS = [15, 12, 10, 9, 8, 7, 6, 5];
const series = { on: false, race: 0, total: VARIANTS.length, points: {}, last: {}, roster: '', pending: null, done: false, nextT: -1 };
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
    coin() { beep(1320, 0.07, 'square', 0.14); beep(1760, 0.14, 'square', 0.14, 0.07); }, block() { noise(0.2, 0.4, 1200, 0.8); beep(500, 0.15, 'square', 0.2); }, deploy() { beep(300, 0.08, 'square', 0.12); },
    explode() { noise(0.7, 0.8, 200, 0.4); beep(70, 0.6, 'sawtooth', 0.35); }, ink() { noise(0.4, 0.4, 600, 0.5); beep(200, 0.3, 'sine', 0.2); }, bullet() { noise(0.8, 0.5, 300, 0.3); beep(140, 0.9, 'sawtooth', 0.3); }, fire() { noise(0.15, 0.3, 1800, 0.6); beep(700, 0.1, 'square', 0.15); },
    lap() { beep(700, 0.1); beep(900, 0.1, 'square', 0.22, 0.1); beep(1200, 0.3, 'square', 0.22, 0.2); },
    star() { [523, 659, 784, 1046, 1318].forEach((f, i) => beep(f, 0.18, 'square', 0.2, i * 0.09)); }, lightning() { noise(0.8, 0.7, 900, 0.3); beep(60, 0.8, 'sawtooth', 0.35); },
    finish() { [784, 784, 784, 1046].forEach((f, i) => beep(f, i === 3 ? 0.7 : 0.15, 'square', 0.25, i * 0.18)); }, };
})();

/* ============================================================ music: a small chiptune loop, scheduled ahead on the shared context */
const music = (() => {
  // four bars of sixteenths in G; 0 is a rest
  const LEAD = [79, 0, 74, 0, 76, 0, 74, 0, 71, 0, 74, 0, 79, 0, 81, 0, 83, 0, 81, 0, 79, 0, 0, 0, 76, 0, 79, 0, 81, 0, 83, 0, 84, 0, 83, 0, 81, 0, 79, 0, 81, 0, 83, 0, 81, 0, 79, 0, 76, 0, 79, 0, 74, 0, 0, 0, 71, 0, 74, 0, 79, 0, 0, 0];
  const BASS = [43, 0, 0, 0, 50, 0, 0, 0, 43, 0, 0, 0, 50, 0, 0, 0, 40, 0, 0, 0, 47, 0, 0, 0, 40, 0, 0, 0, 47, 0, 0, 0, 36, 0, 0, 0, 43, 0, 0, 0, 36, 0, 0, 0, 43, 0, 0, 0, 38, 0, 0, 0, 45, 0, 0, 0, 38, 0, 0, 0, 45, 0, 45, 0];
  let ctx = null, gain = null, timer = 0, step = 0, nextT = 0, tempo = 1, on = false;
  const unsub = audio.whenReady((c, m) => { ctx = c; gain = c.createGain(); gain.gain.value = 0.07; gain.connect(m); if (on) begin(); });
  const freq = n => 440 * Math.pow(2, (n - 69) / 12);
  const tone = (n, t, d, type, vol) => { const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.value = freq(n); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + d); o.connect(g).connect(gain); o.start(t); o.stop(t + d + 0.02); };
  const hat = t => { const n = Math.floor(ctx.sampleRate * 0.03), b = ctx.createBuffer(1, n, ctx.sampleRate), dd = b.getChannelData(0); for (let i = 0; i < n; i++) dd[i] = (Math.random() * 2 - 1) * (1 - i / n); const s = ctx.createBufferSource(); s.buffer = b; const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6000; const g = ctx.createGain(); g.gain.value = 0.2; s.connect(hp).connect(g).connect(gain); s.start(t); };
  function schedule() {
    if (!ctx || audio.muted) return; const spb = 60 / (138 * tempo) / 4;
    while (nextT < ctx.currentTime + 0.3) { const i = step % LEAD.length; if (LEAD[i]) tone(LEAD[i], nextT, spb * 0.9, 'square', 0.5); if (BASS[i]) tone(BASS[i], nextT, spb * 0.95, 'triangle', 0.9); if (i % 2 === 0) hat(nextT); step++; nextT += spb; }
  }
  function begin() { step = 0; nextT = ctx.currentTime + 0.05; clearInterval(timer); timer = setInterval(schedule, 100); }
  return {
    start() { if (on) return; on = true; if (ctx) begin(); },
    stop() { on = false; clearInterval(timer); timer = 0; },
    setTempo(t) { tempo = t; },
    dispose() { this.stop(); unsub(); if (gain) gain.disconnect(); },
  };
})();

/* ============================================================ toasts / flash */
const toasts = createToasts($('toasts')), toast = toasts.toast;
const flashEl = $('flash');
function flash(color, strength = 0.6) { flashEl.style.background = color; race.flash = strength; }


/* ============================================================ items
   The slot holds k.item (a type) x k.itemN (a count; triples are the base type with 3). Shells and bananas are holdable:
   pressing the item key deploys them - a single one trails behind the kart, a triple orbits it - where they block incoming
   shells; releasing the key throws one (the brake key flips the default direction). Everything else fires on press.
   Rolls are weighted by the gap to the leader rather than by place. */
const ITEM_DEF = {
  mushroom: { label: 'MUSHROOM' }, green: { label: 'GREEN SHELL', hold: true }, red: { label: 'RED SHELL', hold: true }, banana: { label: 'BANANA', hold: true },
  tgreen: { label: 'TRIPLE GREEN SHELLS', base: 'green', n: 3 }, tred: { label: 'TRIPLE RED SHELLS', base: 'red', n: 3 }, tbanana: { label: 'TRIPLE BANANAS', base: 'banana', n: 3 },
  star: { label: 'STAR' }, lightning: { label: 'LIGHTNING' }, coin: { label: 'COIN' },
  blue: { label: 'BLUE SHELL' }, bomb: { label: 'BOB-OMB', hold: true }, blooper: { label: 'BLOOPER' }, bullet: { label: 'BULLET BILL' },
  golden: { label: 'GOLDEN MUSHROOM', timed: 8 }, fire: { label: 'FIRE FLOWER', timed: 9 },
};
const HOLDABLE = t => !!(ITEM_DEF[t] && ITEM_DEF[t].hold);
/* roll weights per gap bucket: 0 = leading, 1 = right behind the leader ... 5 = far behind */
const ROLL = {
  coin: [4, 2, 1, 0, 0, 0], banana: [4, 3, 2, 1, 0.5, 0], green: [2, 3, 3, 2, 1, 0.5], tbanana: [0, 1, 2, 1, 0, 0],
  red: [0, 2, 3, 3, 2, 1], tgreen: [0, 0.5, 2, 2, 1, 0], tred: [0, 0, 1, 2, 2, 1], mushroom: [0.5, 1, 2, 3, 3, 2],
  fire: [0, 1, 2, 2, 1, 0], bomb: [0, 0.5, 1.5, 2, 1, 0], blooper: [0, 0, 1, 1.5, 1, 0.5], golden: [0, 0, 0, 1, 2.5, 2],
  star: [0, 0, 0, 0.5, 2, 3], blue: [0, 0, 0, 0.5, 1.5, 2], lightning: [0, 0, 0, 0, 1, 2.5], bullet: [0, 0, 0, 0, 0.5, 2.5],
};
const ROLL_ICONS = ['mushroom', 'green', 'red', 'banana', 'star', 'lightning', 'coin', 'blue', 'bomb', 'blooper', 'bullet', 'golden', 'fire']; // shown while the roulette spins
const blueInFlight = () => hazards.some(h => h.type === 'blue') || [...remoteHaz.values()].some(h => h.type === 'blue');
function gapBucket(k) {
  let lead = -Infinity; for (const o of active) if (o.score > lead) lead = o.score;
  const gap = (lead - k.score) / L; // laps behind the leader
  return k.place === 1 ? 0 : gap < 0.06 ? 1 : gap < 0.14 ? 2 : gap < 0.25 ? 3 : gap < 0.4 ? 4 : 5;
}
function rollItem(k) {
  const b = gapBucket(k), names = Object.keys(ROLL);
  const w = names.map(t => (t === 'lightning' && race.zapCd > 0) || (t === 'blue' && blueInFlight()) ? 0 : ROLL[t][b]); // one lightning / blue shell at a time
  let r = Math.random() * w.reduce((a, c) => a + c, 0);
  for (let i = 0; i < names.length; i++) { r -= w[i]; if (r <= 0) return names[i]; }
  return 'mushroom';
}
function giveItem(k, roll) {
  const d = ITEM_DEF[roll]; k.item = d.base || roll; k.itemN = d.n || 1; k.held = false;
  if (k.kind === 'ai') { k.ai.itemTimer = 0; if (HOLDABLE(k.item)) k.held = true; } // bots deploy at once and carry the shield around
  if (isMe(k)) { drawItemSlot(k.item, false, k.itemN); const el = $('item'); el.classList.remove('pulse'); void el.offsetWidth; el.classList.add('pulse'); toast(d.label + '!', 'blue'); }
}
function addCoins(k, n) { k.coins = clamp(k.coins + n, 0, 10); }
function loseCoins(k, n) { const lost = Math.min(k.coins, n); k.coins -= lost; for (let i = 0; i < lost; i++) spawnP(k.x, k.y + 1, k.z, rr(-5, 5), rr(4, 8), rr(-5, 5), 0.8, 0xffd23f, 1.1, 14); }

const hazards = [];              // host-simulated shells, bananas and the like
let nextHazId = 1;
const remoteHaz = new Map();     // client-side mirrors of the host's hazards, keyed by id
const ignoreHaz = new Map();     // hazards this client already destroyed, until the host confirms
const shellGeo = new THREE.IcosahedronGeometry(0.65, 1); shellGeo.scale(1, 0.75, 1);
const bananaGeo = new THREE.TorusGeometry(0.55, 0.2, 6, 10, Math.PI * 1.1); bananaGeo.rotateZ(-Math.PI * 0.05);
function shellMesh(color) { const g = new THREE.Group(); g.add(new THREE.Mesh(shellGeo, flatMat({ color, roughness: 0.4 }))); const base = new THREE.Mesh(new THREE.IcosahedronGeometry(0.62, 1), flatMat({ color: 0xfff3d0 })); base.scale.set(1, 0.35, 1); base.position.y = -0.2; g.add(base); const rim = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.09, 5, 12), flatMat({ color: 0xfff3d0 })); rim.rotation.x = Math.PI / 2; rim.position.y = -0.05; g.add(rim); scene.add(g); return g; }
function bananaMesh() { const m = new THREE.Mesh(bananaGeo, flatMat({ color: 0xffe135, roughness: 0.5 })); m.rotation.x = Math.PI / 2; const g = new THREE.Group(); g.add(m); scene.add(g); return g; }
function blueMesh() { const g = shellMesh(0x2f6df6); const wing = new THREE.BoxGeometry(1.1, 0.08, 0.55); for (const s of [-1, 1]) { const w = new THREE.Mesh(wing, flatMat({ color: 0xffffff })); w.position.set(s * 0.95, 0.15, -0.1); w.rotation.z = s * 0.35; g.add(w); } return g; }
function bombMesh() { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.72, 1), flatMat({ color: 0x181c28, roughness: 0.6 }))); const fuse = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 0.5, 5), flatMat({ color: 0xc8c8c8 })); fuse.position.y = 0.9; g.add(fuse); const spark = new THREE.Mesh(new THREE.SphereGeometry(0.14, 6, 4), new THREE.MeshBasicMaterial({ color: 0xffd040 })); spark.position.y = 1.15; g.add(spark); for (const s of [-1, 1]) { const eye = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.24, 0.1), new THREE.MeshBasicMaterial({ color: 0xffffff })); eye.position.set(s * 0.22, 0.12, 0.66); g.add(eye); } g.userData.spark = spark; scene.add(g); return g; }
function fireMesh() { const g = new THREE.Group(); g.add(new THREE.Mesh(new THREE.IcosahedronGeometry(0.45, 1), new THREE.MeshBasicMaterial({ color: 0xff7a1a }))); scene.add(g); return g; }
const hazMesh = type => type === 'banana' ? bananaMesh() : type === 'blue' ? blueMesh() : type === 'bomb' ? bombMesh() : type === 'fire' ? fireMesh() : shellMesh(type === 'green' ? 0x2ecc71 : 0xe74c3c);
const hazCause = h => h.type === 'banana' ? 'banana' : h.type === 'bomb' ? 'bomb' : h.type === 'blue' ? 'blue' : h.type === 'fire' ? 'fire' : 'shell';
function hazBurst(h) { for (let q = 0; q < 8; q++) spawnP(h.x, h.y + 0.6 + h.air, h.z, rr(-4, 4), rr(2, 6), rr(-4, 4), 0.4, h.type === 'banana' ? 0xffe135 : h.type === 'fire' ? 0xff8a20 : 0xffffff, 0.7, 10); }
/* an explosion at (x,z): every kart this machine owns inside r is hit; the host also tells the others so they check their own */
function blast(x, z, r, by, cause, relay = true) {
  for (let q = 0; q < 40; q++) { const a = rr(0, 6.28), sp = rr(3, 14); spawnP(x, terrainH(x, z) + ROAD_Y + 0.8, z, Math.cos(a) * sp, rr(2, 12), Math.sin(a) * sp, rr(0.5, 1.1), q % 3 ? 0xff8a20 : 0x333333, 1.6, 10); }
  for (const k of active) if (owned(k) && (k.x - x) ** 2 + (k.z - z) ** 2 < r * r) { hitKart(k, cause, by); if (online) send({ t: 'hitev', v: k.id, c: cause, by }); }
  if (Math.hypot(me.x - x, me.z - z) < r + 10) { race.shake = Math.max(race.shake, 0.5); sfx.explode(); }
  if (relay && online && isHost) send({ t: 'blast', x: +x.toFixed(2), z: +z.toFixed(2), r, by, c: cause });
}
/* a blooper inks everyone ahead of the thrower (by score) - each machine handles its own karts */
function inkFrom(by, score) { for (const k of active) if (owned(k) && k.id !== by && k.score > score && k.star <= 0 && k.bullet <= 0) { k.ink = 6; if (isMe(k)) { toast('INKED!', 'down'); sfx.ink(); } } }

function pickRedTarget(k) {
  let target = null, best = Infinity;
  for (const o of active) if (o !== k && !o.finished && o.score > k.score && o.score - k.score < best) { best = o.score - k.score; target = o; }
  if (!target) for (const o of active) if (o !== k && wrapHalf(o.dist - k.dist) > 0 && (!target || wrapHalf(o.dist - k.dist) < wrapHalf(target.dist - k.dist))) target = o;
  return target;
}
/* build a hazard thrown by kart `owner` from the given pose; dir is +1 forward, -1 backward. h.y is the road height under
   it and h.air its height above that (thrown things arc through the air first). Shared by the host's spawn and a client's
   ghost of its own throw; returns null for a type that is not a hazard. */
const spawnStats = { n: 0, last: '' }; // debug / test hook
let ghostN = 0;
function makeHazard(type, owner, x, z, h, vf, target, dir = 1) {
  if (!HAZ_TYPES.includes(type)) return null;
  const fx = Math.sin(h), fz = Math.cos(h); const idx = nearestSample(x, z, owner.idx, 80);
  const base = { id: 0, type, owner: owner.id, x: x + fx * 2.6 * dir, z: z + fz * 2.6 * dir, y: 0, air: 0, vy: 0, vx: 0, vz: 0, fly: false, idx, age: 0, ox: 0, oz: 0, oh: 0, mesh: hazMesh(type) };
  base.y = terrainH(base.x, base.z) + ROAD_Y;
  const lob = { vx: fx * 22 + owner.vx * 0.3, vz: fz * 22 + owner.vz * 0.3, vy: 7, air: 1.0, fly: true };
  let hz;
  if (type === 'green') { const sp = 52 + (dir > 0 ? Math.max(vf, 0) * 0.6 : 0); hz = { ...base, vx: fx * sp * dir, vz: fz * sp * dir, life: 9, bounces: 0 }; }
  else if (type === 'red') hz = { ...base, target: dir > 0 ? target : null, h: dir > 0 ? h : h + Math.PI, dir, life: 11 };
  else if (type === 'banana') hz = dir > 0 ? { ...base, ...lob, life: 90 } : { ...base, life: 90 };
  else if (type === 'bomb') hz = dir > 0 ? { ...base, ...lob, fuse: 2.2, life: 30 } : { ...base, fuse: 2.2, life: 30 };
  else if (type === 'fire') { const sp = 42; hz = { ...base, vx: fx * sp * dir, vz: fz * sp * dir, life: 2.4, bounces: 0 }; }
  else { const tg = blueTarget(); hz = { ...base, x: x + fx * 2.6, z: z + fz * 2.6, h, dir: 1, air: 2.5, life: 25, target: tg ? tg.id : -1 }; } // blue: hunts the leader; target is re-read every tick
  hz.mesh.position.set(hz.x, hz.y + 0.6 + hz.air, hz.z);
  return hz;
}
/* host: put a new hazard into play */
function spawnHazard(type, owner, x, z, h, vf, target, dir = 1) {
  const hz = makeHazard(type, owner, x, z, h, vf, target, dir); if (!hz) return null;
  spawnStats.n++; spawnStats.last = type; hz.id = nextHazId++; hazards.push(hz); return hz;
}
/* client: tell the host about a throw and show a ghost of it at once; the host's copy takes the ghost over when it arrives */
function throwRemote(type, k, target, dir) {
  send({ t: 'use', it: type, x: +k.x.toFixed(2), z: +k.z.toFixed(2), h: +k.h.toFixed(3), vf: +k.vf.toFixed(2), tg: target ? target.id : -1, dir });
  const g = makeHazard(type, k, k.x, k.z, k.h, k.vf, target, dir); if (!g) return;
  g.id = -(++ghostN); g.ghost = true; g.ghostT = 1.5; remoteHaz.set(g.id, g); netStats.ghosts++;
}

/* item key down: deploy a holdable item (it becomes a shield), or use anything else at once */
function itemPress(k, dir = 1) {
  if (!k.item || k.roulette > 0) return;
  const t = k.item;
  if (HOLDABLE(t)) { if (!k.held) { k.held = true; if (isMe(k)) sfx.deploy(); } }
  else if (t === 'golden') { if (k.timed <= 0) { k.timed = ITEM_DEF.golden.timed; if (isMe(k)) toast('GOLDEN MUSHROOM!', 'gold'); } k.boost = Math.max(k.boost, 1.0); if (isMe(k)) sfx.boost(); }
  else if (t === 'fire') {
    if (k.timed <= 0) { k.timed = ITEM_DEF.fire.timed; if (isMe(k)) toast('FIRE FLOWER!', 'orange'); }
    if (k.fireCd > 0) return; k.fireCd = 0.28;
    if (isHost) spawnHazard('fire', k, k.x, k.z, k.h, k.vf, null, dir);
    else throwRemote('fire', k, null, dir);
    if (isMe(k)) sfx.fire();
  }
  else useItem(k);
}
/* item key up: throw one deployed item in direction dir (+1 forward, -1 backward) */
function itemRelease(k, dir) {
  if (!k.held || !k.item || k.itemN <= 0) return;
  const t = k.item; const target = t === 'red' && dir > 0 ? pickRedTarget(k) : null;
  if (isHost) spawnHazard(t, k, k.x, k.z, k.h, k.vf, target, dir);
  else throwRemote(t, k, target, dir);
  if (isMe(k) && t !== 'banana') sfx.throwIt();
  takeOne(k);
}
function takeOne(k) { k.itemN--; if (k.itemN <= 0) { k.item = null; k.itemN = 0; k.held = false; } if (isMe(k)) drawItemSlot(k.item, false, k.itemN); }
/* a hazard reached one of the kart's deployed items: the item is spent instead of the kart */
function shieldSpot(k, h) { if (!k.held) return null; for (const s of heldPositions(k, heldTmp)) if ((s.x - h.x) ** 2 + (s.z - h.z) ** 2 < 1.5 * 1.5) return { x: s.x, z: s.z }; return null; }
function shieldBlock(k, spot) {
  for (let q = 0; q < 8; q++) spawnP(spot.x, k.y + 0.8, spot.z, rr(-3, 3), rr(2, 5), rr(-3, 3), 0.4, k.item === 'banana' ? 0xffe135 : 0xffffff, 0.7, 10);
  takeOne(k); if (isMe(k)) { toast('BLOCKED!', 'up'); sfx.block(); }
}
function dropHeld(k) {
  for (const s of heldPositions(k, heldTmp)) for (let q = 0; q < 5; q++) spawnP(s.x, k.y + 0.6, s.z, rr(-3, 3), rr(2, 5), rr(-3, 3), 0.4, 0xffffff, 0.6, 10);
  k.item = null; k.itemN = 0; k.held = false; if (isMe(k)) drawItemSlot(null);
}

function useItem(k) {
  const t = k.item; if (!t || k.roulette > 0 || HOLDABLE(t) || ITEM_DEF[t].timed) return;
  takeOne(k);
  if (t === 'mushroom') { k.boost = Math.max(k.boost, 1.4); if (isMe(k)) { toast('MUSHROOM!', 'orange'); sfx.boost(); } }
  else if (t === 'coin') { addCoins(k, 2); k.boost = Math.max(k.boost, 0.35); if (isMe(k)) { toast('+2 COINS', 'gold'); sfx.coin(); } }
  else if (t === 'star') { k.star = 7.5; if (isMe(k)) { toast('★ STAR POWER!', 'gold'); sfx.star(); } }
  else if (t === 'bullet') { k.bullet = 6; k.held = false; if (isMe(k)) { toast('BULLET BILL!', 'gold'); flash('#ffffff', 0.3); } sfx.bullet(); }
  else if (t === 'blue') {
    if (isHost) spawnHazard('blue', k, k.x, k.z, k.h, k.vf, null, 1);
    else throwRemote('blue', k, null, 1);
    if (isMe(k)) { toast('BLUE SHELL!', 'blue'); sfx.throwIt(); }
  }
  else if (t === 'blooper') {
    inkFrom(k.id, k.score); if (online) send({ t: 'ink', by: k.id, sc: +k.score.toFixed(2) });
    if (isMe(k)) { toast('BLOOPER!', 'blue'); sfx.ink(); }
  }
  else if (t === 'lightning') {
    race.zapCd = 25;
    for (const o of active) if (o !== k && owned(o)) hitKart(o, 'lightning', k.id);
    if (online) send({ t: 'zap', by: k.id });
    if (isMe(k)) { toast('⚡ LIGHTNING!', 'gold'); flash('#ffffff', 0.5); } sfx.lightning(); if (!isMe(k) && me.star <= 0) flash('#ffff80', 0.7);
  }
}

/* `by` is the id of the kart responsible, if any */
const HIT_TOAST = { lightning: 'ZAPPED!', banana: 'SLIPPED!', star: 'BOWLED OVER!', bullet: 'RUN DOWN!', blue: 'BLUE SHELLED!', bomb: 'KABOOM!', fire: 'BURNED!' };
function hitKart(k, cause, by) {
  if (k.star > 0 || k.bullet > 0) return; if (k.hitCd > 0 && cause !== 'lightning') return;
  k.spin = cause === 'lightning' ? 1.0 : cause === 'fire' ? 0.9 : cause === 'blue' ? 2.0 : 1.5; k.spinAng = 0; k.hitCd = 2.4; k.boost = 0;
  if (cause === 'lightning') { k.shrink = 5.5; }
  loseCoins(k, 3); if (k.held) dropHeld(k);
  hitBurst(k, cause);
  if (isMe(k)) { flash(cause === 'lightning' ? '#ffff60' : cause === 'bomb' || cause === 'blue' ? '#ffa030' : '#ff2030', 0.65); race.shake = cause === 'blue' || cause === 'bomb' ? 0.9 : 0.6; toast(HIT_TOAST[cause] || 'HIT!', 'down'); sfx.hit(); }
  else if (by === me.id && cause !== 'lightning') niceShot();
}
function hitBurst(k, cause) { for (let i = 0; i < 14; i++) spawnP(k.x, k.y + 0.8, k.z, rr(-6, 6), rr(3, 9), rr(-6, 6), rr(0.4, 0.8), cause === 'lightning' ? 0xffff60 : 0xffb070, 1, 14); }
function niceShot() { toast('NICE SHOT!', 'up'); sfx.up(); }

function killHazard(i) { const h = hazards[i]; hazBurst(h); scene.remove(h.mesh); hazards.splice(i, 1); }
const BLAST_R = { bomb: 5.5, blue: 6 };
/* host: a bomb or blue shell goes off */
function explodeHazard(i) { const h = hazards[i]; blast(h.x, h.z, BLAST_R[h.type] || 5, h.owner, hazCause(h)); killHazard(i); }
/* client: a hazard hit (or was blocked by) the local kart - destroy it here and tell the host */
function localKillHazard(h, spun) {
  hazBurst(h); scene.remove(h.mesh); remoteHaz.delete(h.id); ignoreHaz.set(h.id, nowSec() + 3);
  send({ t: 'hit', id: h.id, v: me.id, c: hazCause(h), s: spun ? 1 : 0 });
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
  for (let ci = 0; ci < coins.length; ci++) {
    const c = coins[ci];
    if (!c.active) { if (isHost) { c.respawn -= dt; if (c.respawn <= 0) c.active = true; } continue; }
    for (const k of active) if (owned(k) && (k.x - c.x) ** 2 + (k.z - c.z) ** 2 < 1.8 * 1.8) {
      c.active = false; c.respawn = 5; c.hideUntil = nowSec() + 1.0; addCoins(k, 1);
      for (let i = 0; i < 4; i++) spawnP(c.x, c.y + 1, c.z, rr(-2, 2), rr(2, 5), rr(-2, 2), 0.35, 0xffd23f, 0.6, 8);
      if (isMe(k)) sfx.coin(); if (!isHost) send({ t: 'coin', c: ci }); break;
    }
  }
  for (const k of active) if (owned(k) && k.roulette > 0) { k.roulette -= dt; if (k.roulette <= 0) giveItem(k, rollItem(k)); else if (isMe(k)) { drawItemSlot(ROLL_ICONS[Math.floor(timeU.value * 14) % ROLL_ICONS.length], true); if (Math.floor(timeU.value * 14) !== k._tick) { k._tick = Math.floor(timeU.value * 14); sfx.tick(); } } }
  if (isHost) updateHostHazards(dt); else updateRemoteHazards(dt);
}

/* keep a hazard inside the corridor; returns true when it touched a wall */
function hazWall(h, bounce) {
  h.idx = nearestSample(h.x, h.z, h.idx, 40); const s = S[h.idx]; const lat = (h.x - s.x) * s.lx + (h.z - s.z) * s.lz; const lim = WALL - 0.7;
  if (Math.abs(lat) <= lim) return false;
  const sg = Math.sign(lat); h.x -= s.lx * (Math.abs(lat) - lim) * sg; h.z -= s.lz * (Math.abs(lat) - lim) * sg;
  const vn = h.vx * s.lx + h.vz * s.lz;
  if (vn * sg > 0) { if (bounce) { h.vx -= 2 * vn * s.lx; h.vz -= 2 * vn * s.lz; } else { h.vx = h.vz = 0; } return true; }
  return false;
}
/* one step of a hazard's own motion, no hits: thrown arcs, bouncing shells, homing, fuses. Shared by the host's hazards and
   a client's ghosts. Returns false, true (spent) or 'boom' (a bomb's fuse ran out). */
function moveHazard(h, dt) {
  h.life -= dt; h.age += dt; let dead = h.life <= 0;
  if (h.fly) { // thrown in an arc; it lands where it comes down
    h.x += h.vx * dt; h.z += h.vz * dt; h.vy -= 22 * dt; h.air += h.vy * dt; hazWall(h, false); h.y = terrainH(h.x, h.z) + ROAD_Y;
    if (h.air <= 0) { h.air = 0; h.vy = 0; h.vx = h.vz = 0; h.fly = false; }
    h.mesh.rotation.y += dt * 6;
  } else if (h.type === 'green' || h.type === 'fire') {
    h.x += h.vx * dt; h.z += h.vz * dt;
    if (hazWall(h, true)) { h.bounces++; for (let q = 0; q < 5; q++) spawnP(h.x, h.y + 0.5, h.z, rr(-3, 3), rr(2, 5), rr(-3, 3), 0.4, 0xfff0a0, 0.6, 12); if (h.bounces > (h.type === 'fire' ? 2 : 5)) dead = true; }
    h.y = terrainH(h.x, h.z) + ROAD_Y; h.mesh.rotation.y += dt * 12;
    if (h.type === 'fire') spawnP(h.x, h.y + 0.6, h.z, rr(-1, 1), rr(0.5, 2), rr(-1, 1), 0.25, Math.random() < 0.5 ? 0xff7a1a : 0xffd040, 0.6);
  } else if (h.type === 'blue') { // flies above the pack along the racing line, dives onto the leader
    const sp = 68, tg = blueTarget(); h.target = tg ? tg.id : -1;
    const tgd = tg ? Math.hypot(tg.x - h.x, tg.z - h.z) : 1e9; let want; h.tgd = tgd;
    if (tg && tgd < 40) want = Math.atan2(tg.x - h.x, tg.z - h.z); else { const j = (h.idx + Math.round(18 / DS)) % N; want = Math.atan2(RLX[j] - h.x, RLZ[j] - h.z); }
    h.h += clamp(wrapAngle(want - h.h), -1, 1) * 6 * dt; h.vx = Math.sin(h.h) * sp; h.vz = Math.cos(h.h) * sp; h.x += h.vx * dt; h.z += h.vz * dt;
    hazWall(h, false); h.y = terrainH(h.x, h.z) + ROAD_Y; h.air = lerp(h.air, tgd < 12 ? 0.3 : 2.5, 1 - Math.exp(-4 * dt)); h.mesh.rotation.y += dt * 10;
    spawnP(h.x, h.y + 0.6 + h.air, h.z, rr(-1, 1), rr(0, 1), rr(-1, 1), 0.35, 0x4fa0ff, 0.6);
  } else if (h.type === 'bomb') {
    h.fuse -= dt; h.mesh.userData.spark.visible = Math.floor(h.fuse * (h.fuse < 0.8 ? 16 : 6)) % 2 === 0;
    if (h.fuse <= 0) return 'boom';
    h.mesh.rotation.y += dt * 0.5;
  } else if (h.type === 'red') {
    const sp = 50; let want;
    const tg = h.target; const tgd = tg ? Math.hypot(tg.x - h.x, tg.z - h.z) : 1e9;
    if (tg && tgd < 30 && !tg.finished) want = Math.atan2(tg.x - h.x, tg.z - h.z); else { const j = (h.idx + h.dir * Math.round(14 / DS) + N) % N; want = Math.atan2(RLX[j] - h.x, RLZ[j] - h.z); }
    h.h += clamp(wrapAngle(want - h.h), -1, 1) * 5.5 * dt; h.vx = Math.sin(h.h) * sp; h.vz = Math.cos(h.h) * sp; h.x += h.vx * dt; h.z += h.vz * dt;
    hazWall(h, false); h.y = terrainH(h.x, h.z) + ROAD_Y; h.mesh.rotation.y += dt * 12;
    if (Math.random() < 0.5) spawnP(h.x, h.y + 0.5, h.z, rr(-1, 1), rr(0, 1), rr(-1, 1), 0.3, 0xff6040, 0.5);
  } else { h.mesh.rotation.y += dt * 0.5; }
  h.mesh.position.set(h.x + h.ox, h.y + 0.6 + h.air, h.z + h.oz);
  return dead;
}
function updateHostHazards(dt) {
  for (let i = hazards.length - 1; i >= 0; i--) {
    const h = hazards[i]; let dead = moveHazard(h, dt);
    if (dead === 'boom') { explodeHazard(i); continue; }
    if (h.type === 'blue') { const tg = blueTarget(); if (tg && owned(tg) && h.age > 0.6 && h.tgd < KART_R + 1.2) { explodeHazard(i); continue; } } // a remote target reports its own hit
    // hits against the karts this machine owns; other players report their own hits
    if (!dead && !h.fly && h.type !== 'blue') for (const k of active) {
      if (!owned(k)) continue; if (k.id === h.owner && h.age < 0.6) continue;
      const sp = shieldSpot(k, h); if (sp) { shieldBlock(k, sp); dead = true; break; }
      if ((k.x - h.x) ** 2 + (k.z - h.z) ** 2 < (KART_R + 0.8) ** 2) {
        if (h.type === 'bomb') { dead = 'boom'; break; }
        if (k.star > 0 || k.bullet > 0) { dead = true; break; }
        if (k.hitCd <= 0) { const cause = hazCause(h); hitKart(k, cause, h.owner); if (online) send({ t: 'hitev', v: k.id, c: cause, by: h.owner }); dead = true; break; }
      }
    }
    if (dead === 'boom') explodeHazard(i); else if (dead) killHazard(i);
  }
}
function blueTarget() { let best = null; for (const k of active) if (!k.finished && (!best || k.score > best.score)) best = k; return best; }

/* ---- client: the host's hazards, dead-reckoned like the karts (straight flight with wall bounces, plus the arc of a thrown one) */
const hzA = { x: 0, z: 0, vx: 0, vz: 0, idx: 0, air: 0 }, hzB = { x: 0, z: 0, vx: 0, vz: 0, idx: 0, air: 0 };
function reckonHaz(h, a, lead, out) {
  out.x = a.x; out.z = a.z; out.vx = a.vx; out.vz = a.vz; out.idx = h.idx; out.air = a.a;
  const n = lead > 0 ? Math.ceil(lead / DR_STEP) : 0;
  if (n) { const dt = lead / n, bounce = h.type === 'green' || h.type === 'fire'; for (let i = 0; i < n; i++) { out.x += out.vx * dt; out.z += out.vz * dt; hazWall(out, bounce); } if (a.vy) out.air = Math.max(0, a.a + a.vy * lead - 11 * lead * lead); }
  return out;
}
function dropRemote(h, burst) { if (burst) hazBurst(h); scene.remove(h.mesh); remoteHaz.delete(h.id); }
function updateRemoteHazards(dt) {
  const rt = nowSec() + (hostClock ? hostClock.transit - hostClock.D : 0);
  for (const h of remoteHaz.values()) {
    decayOffset(h, dt);
    if (h.ghost) { h.ghostT -= dt; if (h.ghostT <= 0 || moveHazard(h, dt)) dropRemote(h, false); continue; } // my own throw, until the host's copy arrives
    h.age += dt; const smp = sampleSnaps(h.buf, rt); if (!smp) continue; const { a, b, f } = smp;
    let p;
    if (b) { p = hzA; p.x = lerp(a.x, b.x, f); p.z = lerp(a.z, b.z, f); p.air = lerp(a.a, b.a, f); }
    else { p = reckonHaz(h, a, clamp(rt - a.t, 0, MAX_LEAD), hzA); h.idx = p.idx; }
    if (h.netA && !h.netB && (a !== h.netA || b)) { const c = reckonHaz(h, h.netA, clamp(rt - h.netA.t, 0, MAX_LEAD), hzB); absorbJump(h, c.x - p.x, c.z - p.z, 0); }
    h.netA = a; h.netB = b;
    h.x = p.x; h.z = p.z; h.air = p.air; h.h = a.h; h.target = a.tg; h.fuse = a.f; h.vx = a.vx; h.vz = a.vz;
    h.y = terrainH(h.x, h.z) + ROAD_Y; h.mesh.position.set(h.x + h.ox, h.y + 0.6 + h.air, h.z + h.oz); h.mesh.rotation.y += dt * (h.type === 'banana' || h.type === 'bomb' ? 0.5 : 12);
    if (h.type === 'red' && Math.random() < 0.5) spawnP(h.x, h.y + 0.5, h.z, rr(-1, 1), rr(0, 1), rr(-1, 1), 0.3, 0xff6040, 0.5);
    if (h.type === 'blue') spawnP(h.x, h.y + 0.6 + h.air, h.z, rr(-1, 1), rr(0, 1), rr(-1, 1), 0.35, 0x4fa0ff, 0.6);
    if (h.type === 'fire') spawnP(h.x, h.y + 0.6, h.z, rr(-1, 1), rr(0.5, 2), rr(-1, 1), 0.25, Math.random() < 0.5 ? 0xff7a1a : 0xffd040, 0.6);
    if (h.type === 'bomb' && h.mesh.userData.spark) h.mesh.userData.spark.visible = Math.floor((h.fuse || 0) * (h.fuse < 0.8 ? 16 : 6)) % 2 === 0;
    if (me.kind !== 'local') continue; if (h.owner === me.id && h.age < 0.6) continue;
    if (h.type === 'blue') { // it only ever lands on its target
      if (h.target === me.id && h.air < 1.2 && (me.x - h.x) ** 2 + (me.z - h.z) ** 2 < (KART_R + 1.2) ** 2) { hitKart(me, 'blue', h.owner); localKillHazard(h, me.star <= 0 && me.bullet <= 0); }
      continue;
    }
    if (h.air > 0.05) continue;
    const sp = shieldSpot(me, h); if (sp) { shieldBlock(me, sp); localKillHazard(h, false); continue; }
    if ((me.x - h.x) ** 2 + (me.z - h.z) ** 2 < (KART_R + 0.8) ** 2) {
      if (h.type === 'bomb') { hitKart(me, 'bomb', h.owner); localKillHazard(h, me.star <= 0 && me.bullet <= 0); } // the host blasts whoever else is close
      else if (me.star > 0 || me.bullet > 0) localKillHazard(h, false);
      else if (me.hitCd <= 0) { hitKart(me, hazCause(h), h.owner); localKillHazard(h, true); }
    }
  }
}
/* client: mirror the host's hazard list; `t` is the message's stamp in our clock, `ts` the sender's raw one (for ordering) */
const oldestGhost = type => { let best = null; for (const h of remoteHaz.values()) if (h.ghost && h.type === type && (!best || h.age > best.age)) best = h; return best; };
function syncHazards(list, t, ts) {
  const now = nowSec(); for (const [id, until] of ignoreHaz) if (until < now) ignoreHaz.delete(id);
  const seen = new Set();
  for (const raw of list) {
    const hs = unpackHaz(raw); if (ignoreHaz.has(hs.id)) continue; seen.add(hs.id);
    let h = remoteHaz.get(hs.id);
    if (!h) {
      h = { id: hs.id, type: hs.ty, owner: hs.o, x: hs.x, z: hs.z, y: terrainH(hs.x, hs.z) + ROAD_Y, air: hs.a, vx: hs.vx, vz: hs.vz, h: hs.h, target: hs.tg, fuse: hs.f, age: 0, buf: [], idx: nearestSample(hs.x, hs.z, -1), ox: 0, oz: 0, oh: 0, netA: null, netB: null, lastTs: -1, mesh: null };
      const g = hs.o === me.id ? oldestGhost(hs.ty) : null; // my own throw: the host's copy takes over the ghost and glides from where the ghost is
      if (g) { h.mesh = g.mesh; h.age = g.age; h.ox = g.x + g.ox - hs.x; h.oz = g.z + g.oz - hs.z; remoteHaz.delete(g.id); } else h.mesh = hazMesh(hs.ty);
      h.mesh.position.set(h.x + h.ox, h.y + 0.6 + h.air, h.z + h.oz); remoteHaz.set(hs.id, h);
    }
    if (ts > h.lastTs) { h.lastTs = ts; pushSnap(h.buf, hs, t); }
  }
  for (const [id, h] of remoteHaz) if (id > 0 && !seen.has(id)) dropRemote(h, true);
}
function syncBoxes(mask) {
  const now = nowSec();
  itemBoxes.forEach((b, i) => { const on = !!(mask & (1 << i)); if (on && b.hideUntil > now) return; b.active = on; b.g.visible = on; });
}
function syncCoins(off) {
  const now = nowSec(), set = new Set(off);
  coins.forEach((c, i) => { const on = !set.has(i); if (on && c.hideUntil > now) return; c.active = on; });
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
  if (k.lap > race.laps) { k.finished = true; k.finishTime = race.time; if (isMe(k)) finishPlayer(); }
  else if (isMe(k) && k.lap === race.laps && race.laps > 1) { toast('FINAL LAP!', 'orange'); $('lapbox').classList.add('final'); sfx.lap(); music.setTempo(1.12); }
  else if (isMe(k) && k.lap > 1) { toast(`LAP ${k.lap}  ·  ` + fmtT(k.lapTimes[k.lapTimes.length - 1]), 'blue'); sfx.lap(); }
}
function finishPlayer() {
  race.state = 'finished'; race.resultsT = 1.6; toast('FINISH!', 'gold'); music.stop(); sfx.finish(); flash('#ffffff', 0.4);
  for (let i = 0; i < 60; i++) spawnP(me.x + rr(-6, 6), me.y + rr(1, 6), me.z + rr(-6, 6), rr(-4, 4), rr(2, 10), rr(-4, 4), rr(0.8, 1.6), CROWD_COLORS[i % CROWD_COLORS.length], 1.2, 8);
}
const nameCell = k => `<span class="sw" style="background:#${k.color.toString(16).padStart(6, '0')}"></span>${esc(k.name)}${k.kind === 'ai' ? ' <span class="cpu">CPU</span>' : ''}`;
function renderResults() {
  const sorted = active.slice().sort((a, b) => b.score - a.score), cup = series.on;
  const prov = {}; sorted.forEach((k, i) => { prov[k.id] = CUP_POINTS[i] || 0; }); // this race's points, provisional until the host banks them
  const earned = cup && series.done ? series.last : prov;
  $('resTable').innerHTML = sorted.map((k, i) => `<tr class="${isMe(k) ? 'me' : ''}"><td>${ordinal(i + 1)}</td><td>${nameCell(k)}</td><td class="t">${k.finished ? fmtT(k.finishTime) : 'racing…'}</td><td class="t dim">${k.coins} ¢</td>${cup ? `<td class="t pts">+${earned[k.id] ?? 0}</td>` : ''}</tr>`).join('');
  const pp = sorted.indexOf(me) + 1;
  $('resSub').textContent = `YOU FINISHED ${ordinal(pp).toUpperCase()} · ${fmtT(me.finishTime)}` + (me.lapTimes.length ? ` · BEST LAP ${fmtT(Math.min(...me.lapTimes))}` : '');
  $('resLaps').textContent = me.lapTimes.length > 1 ? 'LAPS  ' + me.lapTimes.map(fmtT).join('  ·  ') : '';
  $('resTitle').textContent = cup ? (series.done ? '🏆 GRAND PRIX' : `RACE ${series.race + 1} OF ${series.total}`) : 'FINISH!';
  $('cupBox').hidden = !cup;
  if (cup) {
    const totals = active.map(k => ({ k, pts: (series.points[k.id] || 0) + (series.done ? 0 : prov[k.id]), tie: earned[k.id] || 0 })).sort((a, b) => b.pts - a.pts || b.tie - a.tie);
    $('cupSub').textContent = series.done ? 'FINAL STANDINGS' : `CUP STANDINGS · AFTER RACE ${series.race + 1} OF ${series.total}`;
    $('cupTable').innerHTML = totals.map((t, i) => `<tr class="${isMe(t.k) ? 'me' : ''}${series.done && i === 0 ? ' win' : ''}"><td>${series.done && i === 0 ? '🏆' : ordinal(i + 1)}</td><td>${nameCell(t.k)}</td><td class="t pts">${t.pts}</td></tr>`).join('');
  }
}
/* host / solo: bank this race's points; returns true when that was the last race of the cup */
function awardCup() {
  const sorted = active.slice().sort((a, b) => b.score - a.score); const last = {}, points = { ...series.points };
  sorted.forEach((k, i) => { last[k.id] = CUP_POINTS[i] || 0; points[k.id] = (points[k.id] || 0) + last[k.id]; });
  const final = series.race >= series.total - 1;
  if (final) { Object.assign(series, { points, last, done: true, pending: null, nextT: -1 }); renderResults(); renderFoot(); drawNext(); sfx.finish(); }
  else series.pending = { points, last };
  if (online) send({ t: 'cup', points, last, final: final ? 1 : 0 });
  return final;
}
/* host / solo: leave this race behind - the auto-advance, the R key and the RACE AGAIN button all land here */
function nextRace() {
  if (series.on && !series.done) { if (awardCup()) return; }
  hooks.onRestart?.();
}
function restartKey() {
  if (online && !isHost) return;
  if (series.on && !series.done && race.state !== 'finished') { toast('FINISH THE RACE FIRST', 'blue'); return; }
  nextRace();
}

function resetRace() {
  karts.forEach(k => resetKart(k, Math.max(gridOrder.indexOf(k.id), 0)));
  clearHazards();
  for (const b of itemBoxes) { b.active = true; b.g.visible = true; b.hideUntil = 0; }
  for (const c of coins) { c.active = true; c.hideUntil = 0; }
  Object.assign(race, { state: 'countdown', t: 0, time: 0, stage: 0, shake: 0, placeCand: active.length, placeCandT: 0, shownPlace: active.length, resultsT: 0, humanScore: 0, zapCd: 0 });
  $('results').classList.remove('show'); $('lapbox').classList.remove('final'); toasts.clear(); drawItemSlot(null); setGantry(0); setPosHud(active.length); input.pressAt = -1; input.padAt = -1; input.up = input.down = input.left = input.right = false; tc.releaseAll();
  music.stop(); music.setTempo(1);
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
  else if (type === 'coin') { c.fillStyle = '#ffd23f'; c.beginPath(); c.ellipse(0, 0, r * 0.7, r, 0, 0, 7); c.fill(); c.stroke(); c.fillStyle = '#b07800'; c.beginPath(); c.ellipse(0, 0, r * 0.38, r * 0.65, 0, 0, 7); c.fill(); c.fillStyle = '#ffd23f'; c.beginPath(); c.ellipse(0, 0, r * 0.22, r * 0.5, 0, 0, 7); c.fill(); }
  else if (type === 'blue') { c.fillStyle = '#fff'; for (const s of [-1, 1]) { c.beginPath(); c.moveTo(s * r * 0.5, -r * 0.1); c.lineTo(s * r * 1.15, -r * 0.7); c.lineTo(s * r * 1.05, r * 0.15); c.closePath(); c.fill(); c.stroke(); } c.fillStyle = '#2f6df6'; c.beginPath(); c.arc(0, 0, r * 0.85, 0, 7); c.fill(); c.stroke(); c.fillStyle = '#fff5d8'; c.beginPath(); c.ellipse(0, r * 0.5, r * 0.8, r * 0.25, 0, 0, 7); c.fill(); c.stroke(); c.beginPath(); for (let i = 0; i < 6; i++) { const a = i / 6 * Math.PI * 2; c.moveTo(0, 0); c.lineTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7 - r * 0.15); } c.stroke(); }
  else if (type === 'bomb') { c.strokeStyle = '#c8c8c8'; c.lineWidth = r * 0.1; c.beginPath(); c.moveTo(0, -r * 0.7); c.quadraticCurveTo(r * 0.1, -r * 1.05, r * 0.45, -r * 0.95); c.stroke(); c.fillStyle = '#ffd040'; c.beginPath(); c.arc(r * 0.5, -r * 0.95, r * 0.14, 0, 7); c.fill(); c.strokeStyle = '#1a1e30'; c.lineWidth = r * 0.12; c.fillStyle = '#23283a'; c.beginPath(); c.arc(0, r * 0.1, r * 0.8, 0, 7); c.fill(); c.stroke(); c.fillStyle = '#fff'; c.beginPath(); c.rect(-r * 0.33, -r * 0.15, r * 0.18, r * 0.32); c.rect(r * 0.15, -r * 0.15, r * 0.18, r * 0.32); c.fill(); }
  else if (type === 'blooper') { c.fillStyle = '#fff'; c.beginPath(); c.moveTo(-r * 0.6, r * 0.1); c.quadraticCurveTo(-r * 0.7, -r, 0, -r); c.quadraticCurveTo(r * 0.7, -r, r * 0.6, r * 0.1); c.closePath(); c.fill(); c.stroke(); for (let i = -2; i <= 2; i++) { c.beginPath(); c.moveTo(i * r * 0.26, r * 0.05); c.quadraticCurveTo(i * r * 0.32, r * 0.6, i * r * 0.22 + (i % 2 ? r * 0.12 : -r * 0.1), r * 0.95); c.lineTo(i * r * 0.26 + r * 0.14, r * 0.05); c.closePath(); c.fill(); c.stroke(); } c.fillStyle = '#222'; c.beginPath(); c.ellipse(-r * 0.25, -r * 0.35, r * 0.1, r * 0.18, 0, 0, 7); c.ellipse(r * 0.25, -r * 0.35, r * 0.1, r * 0.18, 0, 0, 7); c.fill(); }
  else if (type === 'golden') { c.fillStyle = '#f5e6c8'; c.beginPath(); c.roundRect(-r * 0.45, 0, r * 0.9, r * 0.75, r * 0.15); c.fill(); c.stroke(); c.fillStyle = '#ffc21a'; c.beginPath(); c.arc(0, 0, r, Math.PI, 0); c.closePath(); c.fill(); c.stroke(); c.fillStyle = '#fff3b0'; for (const [x, y, s] of [[-0.5, -0.35, 0.22], [0.45, -0.3, 0.2], [0, -0.75, 0.18]]) { c.beginPath(); c.arc(x * r, y * r, s * r, 0, 7); c.fill(); } c.fillStyle = '#222'; c.beginPath(); c.arc(-r * 0.18, r * 0.35, r * 0.06, 0, 7); c.arc(r * 0.18, r * 0.35, r * 0.06, 0, 7); c.fill(); }
  else if (type === 'bullet') { c.fillStyle = '#23283a'; c.beginPath(); c.moveTo(-r * 0.9, -r * 0.5); c.lineTo(r * 0.2, -r * 0.5); c.quadraticCurveTo(r * 1.05, -r * 0.5, r * 1.05, 0); c.quadraticCurveTo(r * 1.05, r * 0.5, r * 0.2, r * 0.5); c.lineTo(-r * 0.9, r * 0.5); c.closePath(); c.fill(); c.stroke(); c.fillStyle = '#ffb300'; c.fillRect(-r * 0.9, -r * 0.5, r * 0.25, r); c.strokeRect(-r * 0.9, -r * 0.5, r * 0.25, r); c.fillStyle = '#fff'; c.beginPath(); c.rect(r * 0.15, -r * 0.35, r * 0.16, r * 0.3); c.rect(r * 0.5, -r * 0.35, r * 0.16, r * 0.3); c.fill(); }
  else if (type === 'fire') { c.strokeStyle = '#2f9e44'; c.lineWidth = r * 0.14; c.beginPath(); c.moveTo(0, r * 0.2); c.lineTo(0, r); c.stroke(); c.strokeStyle = '#1a1e30'; c.lineWidth = r * 0.1; c.fillStyle = '#ff7a1a'; for (let i = 0; i < 8; i++) { const a = i / 8 * Math.PI * 2; c.beginPath(); c.ellipse(Math.cos(a) * r * 0.5, Math.sin(a) * r * 0.5 - r * 0.2, r * 0.3, r * 0.2, a, 0, 7); c.fill(); c.stroke(); } c.fillStyle = '#ffe94a'; c.beginPath(); c.arc(0, -r * 0.2, r * 0.32, 0, 7); c.fill(); c.stroke(); c.fillStyle = '#222'; c.beginPath(); c.arc(-r * 0.1, -r * 0.25, r * 0.05, 0, 7); c.arc(r * 0.1, -r * 0.25, r * 0.05, 0, 7); c.fill(); }
  c.restore();
}
function drawItemSlot(type, spinning = false, n = 1, ring = 0) {
  const c = itemCtx; c.clearRect(0, 0, 168, 168); if (type) { c.globalAlpha = spinning ? 0.75 : 1; drawItemIcon(c, type, 84, 84, 58); c.globalAlpha = 1; }
  if (ring > 0) { c.strokeStyle = '#ffd54a'; c.lineWidth = 7; c.lineCap = 'round'; c.beginPath(); c.arc(84, 84, 78, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ring); c.stroke(); } // time left on a timed item
  if (type && !spinning && n > 1) { c.fillStyle = '#ffd54a'; c.strokeStyle = '#1a1e30'; c.lineWidth = 6; c.font = 'italic 900 44px Trebuchet MS, Arial'; c.textAlign = 'right'; c.textBaseline = 'alphabetic'; c.strokeText('×' + n, 160, 160); c.fillText('×' + n, 160, 160); }
  $('itemLabel').textContent = type && !spinning ? ITEM_DEF[type].label + (n > 1 ? ' ×' + n : '') : (spinning ? '???' : '');
  if (btnItemCtx) { btnItemCtx.clearRect(0, 0, 96, 96); if (type && !spinning) drawItemIcon(btnItemCtx, type, 48, 48, 32); } // the touch ITEM button shows the same icon
}
/* coins: instanced, spinning, hidden while collected */
const coinM = new THREE.Matrix4(), coinQ = new THREE.Quaternion(), coinV = new THREE.Vector3(), coinS = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
function drawCoins() {
  coins.forEach((c, i) => {
    if (c.active) { coinV.set(c.x, c.y + 0.9 + Math.sin(timeU.value * 2 + i) * 0.1, c.z); coinQ.setFromAxisAngle(UP, timeU.value * 3 + i); coinS.set(1, 1, 1); } else { coinV.set(0, -100, 0); coinS.set(0, 0, 0); }
    coinM.compose(coinV, coinQ, coinS); coinIm.setMatrixAt(i, coinM);
  });
  coinIm.instanceMatrix.needsUpdate = true;
}
const coinNEl = $('coinN'); let coinShown = -1;
function drawCoinHud() { if (me.coins === coinShown) return; coinShown = me.coins; coinNEl.textContent = me.coins; const b = $('coinbox'); b.classList.remove('bump'); void b.offsetWidth; b.classList.add('bump'); }
const spCanvas = $('speedCanvas'); spCanvas.width = 520; spCanvas.height = 300; const spCtx = spCanvas.getContext('2d'); spCtx.scale(2, 2);
function drawSpeedo(speed, boosting) {
  const c = spCtx; c.clearRect(0, 0, 260, 150); const cx = 130, cy = 98, R = 76, a0 = Math.PI * 0.8, a1 = Math.PI * 2.2; const f = clamp(speed / (VMAX * 1.45), 0, 1);
  c.lineCap = 'round'; c.lineWidth = 16; c.strokeStyle = 'rgba(6,10,28,.65)'; c.beginPath(); c.arc(cx, cy, R, a0, a1); c.stroke();
  const col = boosting ? '#ff8c1a' : '#4fd1ff', a2 = a0 + (a1 - a0) * f; c.strokeStyle = col; // glow: a wide translucent stroke (shadowBlur costs a frame's worth of time on some GPUs)
  c.globalAlpha = boosting ? 0.45 : 0.3; c.lineWidth = boosting ? 26 : 20; c.beginPath(); c.arc(cx, cy, R, a0, a2); c.stroke(); c.globalAlpha = 1;
  c.lineWidth = 12; c.beginPath(); c.arc(cx, cy, R, a0, a2); c.stroke();
  c.strokeStyle = 'rgba(255,255,255,.5)'; c.lineWidth = 2; for (let i = 0; i <= 10; i++) { const a = a0 + (a1 - a0) * i / 10; c.beginPath(); c.moveTo(cx + Math.cos(a) * (R - 14), cy + Math.sin(a) * (R - 14)); c.lineTo(cx + Math.cos(a) * (R - 22), cy + Math.sin(a) * (R - 22)); c.stroke(); }
  const na = a0 + (a1 - a0) * f; c.strokeStyle = '#fff'; c.lineWidth = 4; c.beginPath(); c.moveTo(cx, cy); c.lineTo(cx + Math.cos(na) * (R - 26), cy + Math.sin(na) * (R - 26)); c.stroke(); c.fillStyle = '#fff'; c.beginPath(); c.arc(cx, cy, 6, 0, 7); c.fill();
  c.fillStyle = boosting ? '#ffb060' : '#fff'; c.font = 'italic 900 40px Trebuchet MS, Arial'; c.textAlign = 'center'; c.fillText(Math.round(Math.abs(speed) * 3.3), cx, cy + 4); c.font = 'bold 13px Trebuchet MS, Arial'; c.fillStyle = 'rgba(255,255,255,.75)'; c.fillText(boosting ? 'BOOST' : 'km/h', cx, cy + 22);
}
const mapCanvas = $('mapCanvas'), mapCtx = mapCanvas.getContext('2d');
function drawMap() {
  const c = mapCtx; c.clearRect(0, 0, 380, 380); c.drawImage(mapBg, 0, 0);
  const order = active.slice().sort((a, b) => (isMe(a) ? 1 : 0) - (isMe(b) ? 1 : 0));
  for (const k of order) { const x = mapX(k.x), z = mapZ(k.z), mine = isMe(k), human = k.kind !== 'ai'; c.beginPath(); c.arc(x, z, mine ? 11 : human ? 9 : 8, 0, 7); c.fillStyle = '#' + k.color.toString(16).padStart(6, '0'); c.fill(); c.lineWidth = mine ? 4 : human ? 3 : 2; c.strokeStyle = mine || human ? '#fff' : 'rgba(0,0,0,.6)'; c.stroke(); if (k.item) { c.fillStyle = '#fff'; c.beginPath(); c.arc(x, z, 2.5, 0, 7); c.fill(); } }
}
const posEl = $('pos');
function setPosHud(p) { posEl.innerHTML = `${p}<sup>${ordinal(p).slice(-2)}</sup>`; posEl.className = 'hud p' + p; posEl.classList.add('bump'); setTimeout(() => posEl.classList.remove('bump'), 160); }
/* live standings column: every racer by place, refreshed a few times a second */
const standEl = $('standings'); let standN = 0, standKey = '';
function drawStandings() {
  standN = (standN + 1) % 5; if (standN) return;
  const sorted = active.slice().sort((a, b) => a.place - b.place);
  const key = sorted.map(k => k.id + (k.finished ? 'f' : '')).join(',') + me.id; if (key === standKey) return; standKey = key;
  standEl.innerHTML = sorted.map(k => `<div class="row${isMe(k) ? ' me' : ''}${k.finished ? ' done' : ''}"><b>${k.place}</b><i style="background:#${k.color.toString(16).padStart(6, '0')}"></i><span>${esc(k.name)}</span></div>`).join('');
}

/* ============================================================ input */
/* Space / Enter / E: press deploys or uses the item, release throws a deployed one; the brake key flips the throw direction.
   Shift is left free for a future drift key. */
const canAct = () => race.state === 'race' && me.kind === 'local' && !me.finished;
/* +1 throws forward, -1 backward; bananas default backward. `flip` is the brake key, the BRAKE button, or ITEM dragged down */
const throwDir = (k, flip) => { const def = k.item === 'banana' ? -1 : 1; return flip ? -def : def; };
const kb = createInput({ ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', Space: 'item', Enter: 'item', KeyE: 'item' }, {
  onDown: (name, e, wasHeld) => { audio.init(); if (name === 'up' && !wasHeld) input.pressAt = race.t; if (name === 'item' && !wasHeld && canAct()) itemPress(me); },
  onUp: name => { if (name === 'up') input.pressAt = -1; if (name === 'item' && canAct()) itemRelease(me, throwDir(me, input.down)); },
  onKey: e => {
    audio.init();
    if (e.code === 'KeyR') restartKey();
    if (e.code === 'Escape') hooks.onExit?.();
    if (e.code === 'KeyM') toast(audio.toggle() ? 'SOUND OFF' : 'SOUND ON', 'blue');
    if (e.code === 'F3' || e.code === 'KeyI') { e.preventDefault(); toggleStats(); }
    if (e.code === 'KeyL') cycleQuality();
  },
});
const input = kb.held; input.pressAt = -1; input.padAt = -1;
/* touch: the left side of the screen is a steering pad, the kart accelerates by itself, and BRAKE and ITEM sit under the right thumb.
   The item slot at the top left is a second ITEM button. Both work like the key: touch to deploy, lift to throw; drag down (or hold
   BRAKE) before lifting to throw the other way. A press with nothing to use (empty slot, roulette still spinning) shakes the button,
   so a tap is never silent. A finger resting on the pad as the countdown hits GO is the rocket start. */
const tc = createTouch();
const ITEM_FLIP_PX = 36;
const padS = touch ? tc.pad($('pad'), { range: 80, onDown: () => { audio.init(); input.padAt = race.t; }, onUp: () => { input.padAt = -1; } }) : null;
const brakeS = touch ? tc.button($('btnBrake'), { onDown: () => audio.init() }) : null;
const shake = el => { el.classList.remove('nope'); void el.offsetWidth; el.classList.add('nope'); };
function bindItemControl(el) {
  const s = tc.button(el, {
    onDown: () => { audio.init(); if (!canAct()) return; if (me.item && me.roulette <= 0) itemPress(me); else shake(el); },
    onUp: st => { if (canAct()) itemRelease(me, throwDir(me, brakeS.held || st.dy > ITEM_FLIP_PX)); },
  });
  s.el = el; s.arrow = el.querySelector('small'); return s;
}
const itemCtls = touch ? [$('btnItem'), $('item')].map(bindItemControl) : [];
const itemFlip = () => !!(touch && (brakeS.held || itemCtls.some(s => s.held && s.dy > ITEM_FLIP_PX)));
/* what the local kart is told to do this step: keyboard, touch, or both at once */
function readControls(k) {
  let th = input.up ? 1 : input.down ? -1 : 0, st = (input.left ? 1 : 0) - (input.right ? 1 : 0);
  if (touch) { if (brakeS.held) th = -1; else if (!input.down) th = 1; if (!st && padS.held) st = -padS.x; }
  k.throttle = th; k.steer = clamp(st, -1, 1);
}
const rocketHeld = () => (input.up && input.pressAt >= 0 && race.t - input.pressAt < 1.0) || (touch && padS.held && input.padAt >= 0 && race.t - input.padAt < 1.0);
const btnItemCtx = touch ? $('btnItemCanvas').getContext('2d') : null;
let touchHudKey = '';
function drawTouchHud() {
  if (!touch) return;
  const has = !!me.item, back = itemFlip(), dir = has ? throwDir(me, back) : 0, key = `${has}${has && HOLDABLE(me.item)}${back}${dir}`;
  if (key === touchHudKey) return; touchHudKey = key;
  for (const s of itemCtls) { s.el.classList.toggle('has', has); s.el.classList.toggle('arm', has && HOLDABLE(me.item)); s.el.classList.toggle('back', has && back); s.arrow.textContent = dir > 0 ? '▲' : '▼'; }
}

/* ============================================================ camera */
const camState = { pos: new THREE.Vector3(0, 10, -30), look: new THREE.Vector3(), fov: 70, init: false }, camWant = new THREE.Vector3(), camLook = new THREE.Vector3();
function updateCamera(dt) {
  const k = me; const fx = Math.sin(k.h), fz = Math.cos(k.h); const want = camWant, look = camLook;
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

/* ============================================================ stats (the detail ladder itself sits next to the renderer) */
let showStats = false;
function toggleStats() { showStats = !showStats; statsEl.hidden = !showStats; if (showStats) drawStats(); }
const timing = { frame: 16, sim: 0, hud: 0, render: 0 };
const cornerEl = $('corner'), statsEl = $('stats'), waitEl = $('netwait');
const netStats = { inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0, rateIn: 0, kbIn: 0, rateOut: 0, kbOut: 0, hostFps: 0, corr: 0, corrM: 0, snaps: 0, frozen: 0, ghosts: 0, lead: 0, lastT: 0 };
const ctlWord = s => (s.held ? 'HELD #' + s.pid : 'FREE') + (s.last ? ' · LAST ' + s.last.toUpperCase() : ''); // one touch control's state
/* the corner line always; the panel (F3 / I, or STATS in the ☰ menu) with the frame breakdown, the touch controls, message rates,
   every sender's clock and the remote-object corrections */
function drawStats() {
  let line = `FPS ${Math.round(fps)}`;
  if (online) line += isHost ? ' · HOST' : hostClock ? ` · PING ${Math.round(hostClock.rtt * 1000)} MS · JITTER ${Math.round(hostClock.jitter * 1000)} MS · HOST ${netStats.hostFps} FPS` : ' · WAITING FOR THE HOST';
  cornerEl.textContent = line;
  if (!showStats) return;
  const lines = [
    `FRAME ${timing.frame.toFixed(1)} MS (${Math.round(fps)} FPS)   SIM ${timing.sim.toFixed(1)}   HUD ${timing.hud.toFixed(1)}   RENDER ${timing.render.toFixed(1)}`,
    `DETAIL ${QUALITY[quality].name}${autoQuality ? ' (AUTO)' : ''}   PIXEL RATIO ${renderer.getPixelRatio().toFixed(2)}   ${innerWidth}X${innerHeight}   (L CYCLES)`,
  ];
  if (touch) lines.push(`TOUCH    PAD ${ctlWord(padS)}   BRAKE ${ctlWord(brakeS)}   ITEM ${ctlWord(itemCtls[0])}   SLOT ${ctlWord(itemCtls[1])}`); // a control that stays HELD after the finger left is the bug this line is for
  if (!online) lines.push('SOLO · NO NETWORK');
  else {
    lines.push(`${isHost ? 'HOST  ' : 'CLIENT'}   MESSAGES IN ${netStats.rateIn.toFixed(0)}/S  ${netStats.kbIn.toFixed(1)} KB/S   OUT ${netStats.rateOut.toFixed(0)}/S  ${netStats.kbOut.toFixed(1)} KB/S${isHost ? '' : `   HOST ${netStats.hostFps} FPS`}`);
    for (const [pid, c] of clocks) { const p = session && session.players.find(q => q.id === pid); lines.push(`${(p ? p.name : 'PLAYER ' + pid).toUpperCase().padEnd(12)} PING ${Math.round(c.rtt * 1000)} MS   SNAPSHOT EVERY ${Math.round(c.interval * 1000)} MS   JITTER ${Math.round(c.jitter * 1000)} MS (MAX ${Math.round(c.jitterMax * 1000)})   SHOWN ${Math.round((c.transit - c.D) * 1000)} MS AHEAD OF THE DATA`); }
    lines.push(`REMOTE   DATA AGE ${Math.round(netStats.lead * 1000)} MS   CORRECTIONS ${netStats.corr} (AVG ${netStats.corr ? Math.round(netStats.corrM / netStats.corr * 100) : 0} CM)   SNAPS ${netStats.snaps}   STALLS ${netStats.frozen}   HAZARDS ${hazards.length + remoteHaz.size}   GHOSTS ${netStats.ghosts}`);
  }
  statsEl.textContent = lines.join('\n');
}
/* once a second: message rates */
function netSample() { const now = nowSec(), dt = now - netStats.lastT; if (dt < 1) return; netStats.rateIn = netStats.inMsgs / dt; netStats.kbIn = netStats.inBytes / 1024 / dt; netStats.rateOut = netStats.outMsgs / dt; netStats.kbOut = netStats.outBytes / 1024 / dt; netStats.inMsgs = netStats.inBytes = netStats.outMsgs = netStats.outBytes = 0; netStats.lastT = now; }

/* ============================================================ networking glue
   Two streams (net.js): motion at NET_HZ from a steady worker timer, so a slow or hidden tab never bunches snapshots, and
   status at STATUS_HZ or at once when something discrete changes. Every message carries the sender's clock; the receiver
   maps it through a SnapClock per sender. */
const clocks = new Map(); // player id -> SnapClock
let hostClock = null, hostSeen = 0, simNow = 0, tickN = 0, lastSentTs = -1;
const clockOf = pid => { let c = clocks.get(pid); if (!c) { c = createSnapClock(); clocks.set(pid, c); } return c; };
function sendCounted(msg) { send(msg); netStats.outMsgs++; netStats.outBytes += JSON.stringify(msg).length; }
function netTick() {
  if (!online || race.state === 'intro') return;
  tickN++; const ts = simNow;
  if (ts !== lastSentTs) { // only when the simulation has moved on since the last tick
    lastSentTs = ts;
    const msg = { t: 's', ts, k: [] }; for (const k of active) if (owned(k)) msg.k.push(packMotion(k));
    if (isHost) { msg.r = { p: race.state === 'countdown' ? 'countdown' : 'race', t: +race.t.toFixed(3), tm: +race.time.toFixed(3), nx: series.on ? +series.nextT.toFixed(1) : -1 }; msg.z = hazards.map(packHaz); }
    if (msg.k.length || isHost) sendCounted(msg);
  }
  let due = tickN % Math.round(NET_HZ / STATUS_HZ) === 0;
  if (!due) for (const k of active) if (owned(k) && statusKey(k) !== k.sentKey) { due = true; break; }
  if (!due) return;
  const u = { t: 'u', ts, k: [] }; for (const k of active) if (owned(k)) { u.k.push(packStatus(k)); k.sentKey = statusKey(k); }
  if (isHost) { let m = 0; itemBoxes.forEach((b, i) => { if (b.active) m |= 1 << i; }); u.b = m; u.c = []; coins.forEach((c, i) => { if (!c.active) u.c.push(i); }); u.hf = Math.round(fps); }
  if (u.k.length || isHost) sendCounted(u);
  if (tickN % NET_HZ === 0 && session) for (const p of session.players) if (p.id !== session.myId) sendCounted({ t: 'pg', to: p.id, at: performance.now() }); // once a second: a round trip to every other player
}
/* advance the simulation to wall time `now` (ms). Called by the frame loop and, online, by the network ticker, so the state a
   snapshot carries is fresh when it leaves whatever the frame rate is doing, and the race keeps going in a hidden tab. */
function advanceSim(now) { const real = Math.min((now - simNow) / 1000, 0.25); if (real <= 0) return; timeU.value += real; fixedStep(real, SUB, simStep); simNow = now; }
const ticker = createTicker(NET_HZ, () => { if (!loop.running) return; advanceSim(performance.now()); netTick(); });
const onVisibility = () => { if (!document.hidden && loop.running) { loop.stop(); loop.start(); } }; // restart the frame clock so the first frame back is not a 250 ms jump
document.addEventListener('visibilitychange', onVisibility);
/* client: follow the host's clock */
function syncRace(r) {
  if (race.state === 'countdown') { if (r.p === 'countdown' || r.t < 3.6) race.t = Math.max(race.t, r.t); else race.t = Math.max(race.t, 3.6); }
  else if (race.state === 'race' || race.state === 'finished') { const d = r.tm - race.time; race.time += Math.abs(d) > 0.5 ? d : d * 0.2; }
  if (r.nx !== undefined && !series.done) series.nextT = r.nx;
}
const kartOf = pid => karts.find(k => k.pid === pid && k.kind !== 'none');

/* ============================================================ main loop */
const lapEl = $('lap'), timerEl = $('timer'), countEl = $('count'), inkEl = $('ink');
/* simulation step: fixed-size sub-steps so game time keeps up with real time even on a slow machine */
function simStep(dt) {
  race.t += dt;
  if (race.state === 'countdown') {
    const stage = race.t < 0.6 ? 0 : race.t < 1.6 ? 1 : race.t < 2.6 ? 2 : race.t < 3.6 ? 3 : 4;
    if (stage !== race.stage) { race.stage = stage; setGantry(stage);
      countEl.className = 'hud'; void countEl.offsetWidth;
      if (stage < 4) { countEl.textContent = 4 - stage; countEl.className = 'hud show'; sfx.count(); }
      else { countEl.textContent = 'GO!'; countEl.className = 'hud show go'; sfx.go(); race.state = 'race'; race.time = 0; $('kartcard').classList.remove('show'); music.start();
        if (me.kind === 'local' && rocketHeld()) { me.boost = 1.6; toast('ROCKET START!', 'orange'); sfx.boost(); }
        for (const k of active) if (k.kind === 'ai' && owned(k) && Math.random() < 0.45) k.boost = rr(0.6, 1.1); } }
  }
  if (race.state === 'race' || race.state === 'finished') race.time += dt;
  race.zapCd -= dt;
  if (race.state === 'finished') {
    race.resultsT -= dt; if (race.resultsT <= 0 && !$('results').classList.contains('show')) { $('results').classList.add('show'); renderResults(); }
    resultsRefresh -= dt; if (resultsRefresh <= 0 && $('results').classList.contains('show') && !series.done) { resultsRefresh = 0.5; renderResults(); }
    if (series.on && !series.done && (isHost || !online)) { // the host moves the cup on: soon after everyone finishes, or eventually anyway
      const all = active.every(k => k.kind === 'ai' || k.finished);
      if (series.nextT < 0) series.nextT = all ? 6 : 20; else { if (all && series.nextT > 6) series.nextT = 6; series.nextT -= dt; if (series.nextT <= 0) { series.nextT = -1; nextRace(); } }
    }
    drawNext();
  }
  const moving = race.state === 'race' || race.state === 'finished';
  { let s = 0, n = 0; for (const k of active) if (k.kind !== 'ai') { s += k.score; n++; } race.humanScore = n ? s / n : 0; }
  // controls + physics for the karts this machine owns; everyone else is interpolated
  for (const k of active) {
    if (owned(k)) {
      if (k.bullet > 0) bulletControl(k);
      else if (k.kind === 'local' && !k.finished) readControls(k);
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
}
/* once per rendered frame: visuals every frame, the HUD at 20 Hz and only the parts that changed */
let hudAcc = 0, statsAcc = 0, lapShown = '', inkShown = -1, wrongShown = false; const wrongEl = $('wrong');
function present(dt) {
  for (const c of clocks.values()) c.tick(dt);
  for (const k of active) kartVisual(k, dt);
  updateCamera(dt); updateParticles(dt); updateAmbient(dt); drawCoins();
  if (race.flash > 0) { race.flash -= dt * 1.8; flashEl.style.opacity = Math.max(race.flash, 0); }
  sfx.engine(Math.abs(me.vf), me.boost > 0);
  hudAcc += dt; if (hudAcc >= 0.05) { hudAcc = hudAcc > 0.5 ? 0 : hudAcc - 0.05; hudRefresh(); }
}
function hudRefresh() {
  const lapTxt = `LAP <b>${clamp(me.lap, 1, race.laps)}</b>/${race.laps}`; if (lapTxt !== lapShown) { lapShown = lapTxt; lapEl.innerHTML = lapTxt; }
  timerEl.textContent = fmtT(race.time);
  drawSpeedo(me.vf, me.boost > 0); drawMap(); drawStandings(); drawCoinHud(); drawTouchHud();
  if (me.item && ITEM_DEF[me.item].timed && me.timed > 0) drawItemSlot(me.item, false, 1, me.timed / ITEM_DEF[me.item].timed);
  const ink = me.ink > 0 ? clamp(me.ink / 1.5, 0, 1) : 0; if (ink !== inkShown) { inkShown = ink; inkEl.style.opacity = ink; }
  const wrong = me.wrongWay > 0.8 && race.state === 'race'; if (wrong !== wrongShown) { wrongShown = wrong; wrongEl.style.display = wrong ? 'block' : 'none'; }
  waitEl.hidden = !(online && !isHost && hostSeen > 0 && nowSec() - hostSeen > 0.8);
  netSample(); statsAcc += 0.05; if (statsAcc >= 0.25) { statsAcc = 0; drawStats(); }
}
const SUB = 1 / 60;
const loop = createLoop((real, now) => {
  const t0 = performance.now();
  advanceSim(now);
  const t1 = performance.now(); present(real);
  const t2 = performance.now(); renderer.render(scene, camera);
  const t3 = performance.now();
  timing.sim = lerp(timing.sim, t1 - t0, 0.1); timing.hud = lerp(timing.hud, t2 - t1, 0.1); timing.render = lerp(timing.render, t3 - t2, 0.1); timing.frame = lerp(timing.frame, real * 1000, 0.1);
  fps = lerp(fps, 1 / Math.max(real, 1e-3), 0.05);
  if (autoQuality && race.state === 'race' && race.time > 3) { // detail steps down by itself when the frame rate stays low
    if (fps < 40) { lowFpsT += real; if (lowFpsT > 2 && quality < QUALITY.length - 1) { setQuality(quality + 1); lowFpsT = 0; toast('LOW FRAME RATE · ' + QUALITY[quality].name + ' DETAIL', 'blue'); } } else lowFpsT = 0;
  }
});
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
  const again = series.on ? (series.done ? 'NEW CUP  (R)' : 'NEXT RACE  (R)') : 'RACE AGAIN  (R)';
  if (!online) { btn(again, 'primary', restartKey); btn('MENU  (ESC)', '', () => hooks.onExit?.()); }
  else if (isHost) { btn(again, 'primary', restartKey); btn('BACK TO LOBBY  (ESC)', '', () => hooks.onExit?.()); }
  else f.textContent = series.on && !series.done ? 'THE NEXT RACE STARTS WHEN EVERYONE HAS FINISHED…' : 'WAITING FOR THE HOST TO RESTART OR RETURN TO THE LOBBY…';
}
/* touch: the ☰ button opens a card with what R, ESC, M and L do on a keyboard; the race keeps running underneath */
const pauseEl = $('pause');
function renderMenu() {
  const f = $('pauseBtns'); f.innerHTML = '';
  const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn; f.appendChild(b); };
  btn('RESUME', 'primary', () => showMenu(false));
  btn(audio.muted ? 'SOUND: OFF' : 'SOUND: ON', '', () => { audio.toggle(); renderMenu(); });
  btn(qualityLabel(), '', () => { cycleQuality(); renderMenu(); });
  btn(showStats ? 'STATS: ON' : 'STATS: OFF', '', () => { toggleStats(); renderMenu(); });
  if (!online || isHost) { btn(series.on ? (series.done ? 'NEW CUP' : 'NEXT RACE') : 'RESTART', '', () => { showMenu(false); restartKey(); }); btn(!online ? 'QUIT TO MENU' : 'BACK TO LOBBY', '', () => { showMenu(false); hooks.onExit?.(); }); }
}
function showMenu(on) { pauseEl.classList.toggle('show', on); if (on) renderMenu(); }
if (touch) { $('btnMenu').addEventListener('click', () => { audio.init(); showMenu(!pauseEl.classList.contains('show')); }); pauseEl.addEventListener('click', e => { if (e.target === pauseEl) showMenu(false); }); }
let nextShown = '';
function drawNext() {
  const txt = series.on && !series.done && series.nextT >= 0 && race.state === 'finished' ? `NEXT RACE IN ${Math.ceil(series.nextT)}` : '';
  if (txt !== nextShown) { nextShown = txt; $('resNext').textContent = txt; }
}
function start(s) {
  session = s; isHost = !!s.isHost; online = !!s.online; me = null;
  const o = s.opts || {};
  race.laps = clamp(Math.round(Number(o.laps)) || 3, 1, 9); applyClass(Number(o.cc) || 100); cpuCfg = CPU[o.cpu] || CPU.normal;
  const cup = o.mode === 'cup', roster = s.players.map(p => p.id + ':' + p.avatar).sort().join(',');
  if (cup && series.on && !series.done && series.pending && series.roster === roster) { series.race++; series.points = series.pending.points; series.last = series.pending.last; }
  else if (cup) Object.assign(series, { on: true, race: 0, points: {}, last: {}, roster, done: false });
  else series.on = false;
  series.pending = null; series.nextT = -1;
  const v = series.on ? VARIANTS[series.race % VARIANTS.length] : VARIANTS[clamp(Math.round(Number(o.variant)) || 0, 0, VARIANTS.length - 1)]; if (v !== variant) { buildWorld(v); applyQuality(); }
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
  hintEl.textContent = touch ? 'DRAG THE LEFT SIDE TO STEER · GAS IS AUTOMATIC · ITEM or the item icon: touch to carry, lift to throw, drag down to throw back'
    : 'ARROWS / WASD · SPACE hold + release to throw (↓ flips) · ' + (!online ? 'R restart · ESC menu · ' : isHost ? 'R again · ESC lobby · ' : '') + 'M sound · L detail · F3 stats';
  const cupline = $('cupline'); cupline.hidden = !series.on; cupline.textContent = series.on ? `RACE ${series.race + 1}/${series.total} · ${v.name}` : '';
  $('kcName').textContent = me.name; $('kcClass').textContent = me.w.label; $('kartcard').querySelectorAll('.bars s').forEach((el, i) => { el.style.width = me.w.bars[i] + '%'; }); $('kartcard').classList.add('show');
  if (series.on) { toast(`RACE ${series.race + 1} OF ${series.total}`, 'gold'); toast(v.name, 'blue'); }
  renderFoot(); drawNext();
  clocks.clear(); hostClock = null; hostSeen = nowSec(); simNow = performance.now(); tickN = 0; lastSentTs = -1; ghostN = 0;
  Object.assign(netStats, { corr: 0, corrM: 0, snaps: 0, frozen: 0, ghosts: 0, lead: 0, hostFps: 0 });
  audio.init(); kb.attach(); if (touch) tc.attach(); loop.start(); if (online) ticker.start(); else ticker.stop();
}
function stop() {
  session = null; race.state = 'intro'; clearHazards(); series.on = false; series.pending = null; series.nextT = -1;
  $('results').classList.remove('show'); $('lapbox').classList.remove('final'); toasts.clear(); countEl.className = 'hud'; $('wrong').style.display = 'none'; flashEl.style.opacity = 0;
  for (const k of karts) { setLabel(k, null); k.vis.g.visible = true; k.vis.bodyMat.color.set(k.color); k.vis.bodyMat.emissive.set(0); k.vis.bodyMat.emissiveIntensity = 0; }
  active = karts; karts.forEach((k, i) => resetKart(k, i)); for (const b of itemBoxes) { b.active = true; b.g.visible = true; } for (const c of coins) c.active = true;
  $('kartcard').classList.remove('show'); music.stop();
  kb.detach(); tc.detach(); showMenu(false); loop.stop(); ticker.stop(); sfx.silence(); waitEl.hidden = true;
}
function destroy() {
  stop(); sfx.dispose(); music.dispose(); ticker.dispose(); removeEventListener('resize', onResize); document.removeEventListener('visibilitychange', onVisibility);
  disposeScene(scene); renderer.dispose(); renderer.forceContextLoss?.();
  mount.classList.remove('touch'); mount.innerHTML = ''; unloadCss(); if (window.__kart === debug) delete window.__kart;
}
/* a player dropped out mid-race: the host drives that kart from now on */
function playerLeft(pid) {
  const k = kartOf(pid); if (!k) return;
  k.kind = 'ai'; k.pid = null; k.buf = []; k.status = null; k.netA = k.netB = null; k.clock = null; k.clockFrom = null; k.ox = k.oz = k.oh = 0; k.sentKey = ''; k.name = SKINS[k.id].name; setLabel(k, null);
  k.ai = freshAi(true); k.throttle = 0; k.steer = 0; k.roulette = 0;
}
function onNetMessage(msg) {
  if (race.state === 'intro') return;
  netStats.inMsgs++; netStats.inBytes += msg._len || 0;
  switch (msg.t) {
    case 's': { // motion: everything the sender drives, plus the race clock and the hazards from the host
      const from = msg.from, clock = clockOf(from), ts = +msg.ts || 0, t = clock.map(ts);
      if (session && from === session.hostId) { hostClock = clock; hostSeen = nowSec(); }
      for (const raw of msg.k || []) {
        const m = unpackMotion(raw), k = karts[m.i]; if (!k || owned(k) || k.kind === 'none') continue;
        if (k.clockFrom !== from) { k.clockFrom = from; k.clock = clock; k.buf = []; k.netA = k.netB = null; k.lastTs = -1; } // a new owner (the host took over a leaver's kart): fresh timeline
        if (ts <= k.lastTs) continue; k.lastTs = ts; pushSnap(k.buf, m, t);
      }
      if (!isHost && msg.r) { syncRace(msg.r); syncHazards(msg.z || [], t, ts); }
      break; }
    case 'u': { // status: laps, items, effect timers; item boxes and coins from the host
      const from = msg.from, t = clockOf(from).map(+msg.ts || 0);
      for (const raw of msg.k || []) { const st = unpackStatus(raw), k = karts[st.i]; if (!k || owned(k) || k.kind === 'none' || (k.status && t < k.statusT)) continue; k.status = st; k.statusT = t; }
      if (!isHost && session && from === session.hostId) { if (msg.b !== undefined) syncBoxes(msg.b); if (msg.c) syncCoins(msg.c); if (msg.hf !== undefined) netStats.hostFps = msg.hf | 0; }
      break; }
    case 'pg': sendCounted({ t: 'po', to: msg.from, at: msg.at }); break; // ping: answer with the sender's stamp
    case 'po': clockOf(msg.from).ping(Math.max(0, (performance.now() - (+msg.at || 0)) / 1000)); break; // pong: that round trip belongs to their clock
    case 'pick': if (isHost) { const b = itemBoxes[msg.b]; if (b && b.active) { b.active = false; b.g.visible = false; b.respawn = 3.5; for (let i = 0; i < 10; i++) spawnP(b.x, b.y + 1.3, b.z, rr(-4, 4), rr(1, 6), rr(-4, 4), rr(0.3, 0.6), 0x9fe8ff, 0.8, 6); } } break;
    case 'coin': if (isHost) { const c = coins[msg.c]; if (c && c.active) { c.active = false; c.respawn = 5; for (let i = 0; i < 4; i++) spawnP(c.x, c.y + 1, c.z, rr(-2, 2), rr(2, 5), rr(-2, 2), 0.35, 0xffd23f, 0.6, 8); } } break;
    case 'use': if (isHost) { const k = kartOf(msg.from); if (k && ITEM_DEF[msg.it]) spawnHazard(msg.it, k, msg.x, msg.z, msg.h, msg.vf, msg.tg >= 0 ? karts[msg.tg] : null, msg.dir < 0 ? -1 : 1); } break;
    case 'zap': { race.zapCd = 25; for (const o of active) if (owned(o) && o.id !== msg.by) hitKart(o, 'lightning', msg.by); sfx.lightning(); if (me.star <= 0) flash('#ffff80', 0.7); break; }
    case 'hit': if (isHost) { const i = hazards.findIndex(h => h.id === msg.id); if (i >= 0) { const h = hazards[i], c = hazCause(h);
      if (h.type === 'bomb' || h.type === 'blue') explodeHazard(i); else killHazard(i);
      if (msg.s) { const v = karts[msg.v]; if (v) hitBurst(v, c); if (h.owner === me.id && c !== 'blue') niceShot(); send({ t: 'hitev', v: msg.v, c, by: h.owner }); } } } break;
    case 'hitev': { const v = karts[msg.v]; if (!v || owned(v)) break; hitBurst(v, msg.c); if (msg.by === me.id && msg.c !== 'lightning' && msg.c !== 'blue') niceShot(); break; }
    case 'blast': if (!isHost) blast(msg.x, msg.z, msg.r, msg.by, msg.c, false); break;
    case 'ink': inkFrom(msg.by, msg.sc); break;
    case 'cup': if (!isHost && series.on) { // the host banked this race's points
      if (msg.final) { Object.assign(series, { points: msg.points || {}, last: msg.last || {}, done: true, pending: null, nextT: -1 }); if (race.state === 'race') { race.state = 'finished'; race.resultsT = 0.8; } else if (race.state === 'finished') { $('results').classList.add('show'); renderResults(); } renderFoot(); drawNext(); sfx.finish(); }
      else series.pending = { points: msg.points || {}, last: msg.last || {} };
    } break;
  }
}
const debug = { karts, race, series, get net() { return netStats; }, clocks, timing, get fps() { return fps; }, get hostClock() { return hostClock; }, get simNow() { return simNow; }, nextRace, awardCup, hazards, remoteHaz, VARIANTS, ITEM_DEF, giveItem, itemPress, itemRelease, useItem, rollItem, blast, inkFrom, debugSpawn: spawnHazard, spawnStats, get coins() { return coins; }, get itemBoxes() { return itemBoxes; }, get variant() { return variant; }, get S() { return S; }, get L() { return L; }, get N() { return N; }, get me() { return me; }, get active() { return active; }, get isHost() { return isHost; }, get online() { return online; }, get session() { return session; },
  get tune() { return { VMAX, ACC, TURN, cpu: cpuCfg }; },
  get detail() { return { tier: QUALITY[quality].name, auto: autoQuality, fps: Math.round(fps), pixelRatio: renderer.getPixelRatio() }; }, setQuality, cycleQuality,
  touch: { on: touch, pad: padS, brake: brakeS, items: itemCtls, showMenu, toggleStats },
  restartWith(opts) { if (session) start({ ...session, opts: { ...session.opts, ...opts } }); } };
window.__kart = debug;
return { start, stop, destroy, onNetMessage, playerLeft, debug };
}
