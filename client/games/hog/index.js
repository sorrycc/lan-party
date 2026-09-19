/* Hog the Throne - four pigs, a few minigames, one throne. Game module for the LAN party shell; the contract is
   documented at the top of games/kart/index.js.

   Up to 4 hogs: the room's players take the first slots (sorted by id, wearing their avatar's colour), CPU pigs fill the
   rest when the host leaves "fill with CPU" on. The host picks a shuffled plan of minigames from the round's seed
   (Whirly Bacon, Balloon Butt, Crumble Cake, Truffle Rush) and always ends on The Throne, a king-of-the-hill finale
   where every second sat on the throne counts; the minigames bank bonus seconds for it.

   Netcode: host-authoritative. The host runs the physics (cannon-es) and every CPU brain, and sends 30 Hz `s` snapshots
   (games/hog/net.js: the packed pigs, the current mode's state, and the effects since the last snapshot). Clients send
   their wish (`in`: direction + HOP held) and one `da` per DASH press, and render the snapshots interpolated a little
   in the past. Everything visible or audible goes through emit() -> applyEvent(), so the host and the clients produce
   the same sounds, particles and toasts. An online host keeps simulating from a worker timer while its tab is hidden.

   Clients predict only what is cheap and safe: their own pig turns to the stick at once, and a HOP or DASH press plays its
   sound and dust immediately (the host's matching event is then not played twice). A DASH pressed a little early (while
   still cooling down or mid-air) is kept for DASH_BUFFER seconds instead of lost.

   Words: strings.js (Chinese by default, English from the shell's toggle or the ☰ menu); toasts cross the wire as keys.
   Guests get LEAVE ROOM and a REMATCH toggle on the title card and in the menu; the host sees how many want one.

   Touch screens (core/touch.js): the left part of the screen is a thumb stick, HOP (hold to keep hopping) and DASH sit
   under the right thumb (DASH draws its cooldown), ☰ opens a menu card, and a phone held upright is asked to rotate.
   Your own pig wears a ring on the ground (the dash cooldown fills it back up) and a bobbing arrow. */
import * as THREE from 'three';
import * as CANNON from 'cannon-es';
import { clamp, lerp, makeRng } from '../../core/math.js';
import { esc, hex, loadStylesheet } from '../../core/ui.js';
import { createInput } from '../../core/input.js';
import { createTouch, isCoarse } from '../../core/touch.js';
import { createLoop } from '../../core/loop.js';
import { createTicker } from '../../core/ticker.js';
import { nowSec, pushSnap, sampleSnaps } from '../../core/interp.js';
import { makeT, onLang, nextLang } from '../../core/i18n.js';
import { buildRoster, packPig, unpackPig, createSnapGuard, cleanWish, toastText, STATES, MODES } from './net.js';
import { STR } from './strings.js';
const T = makeT(STR);

/* ============================================================ config + utils */
const STEP = 1 / 60, R = 0.55, SPEED = 6.8, JUMP = 8.8, DASH_SPEED = 16, DASH_TIME = 0.2, DASH_CD = 1.0, DASH_BUFFER = 0.25;
const CARD_TIME = 4.4, COUNT_STEP = 0.8, COUNT_FROM = 3; // the intro: the round card, then 3-2-1 over the arena for the last COUNT_FROM * COUNT_STEP s
const MINE = 0x7cff9a; // your own pig's ring and arrow
const NET_HZ = 30, INTERP = 0.08, TAU = Math.PI * 2;
const GOLD = 0xffd166, INK = 0x2a0a1a;
const rand = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
const damp = (rate, dt) => 1 - Math.exp(-rate * dt);
const lerpAngle = (a, b, t) => { const d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI; return a + d * t; };
const angDiff = (a, b) => ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
const shuffleR = (R, a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(R.rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;

/* ============================================================ sound - the original synth and its tiny sequencer on the shell's shared AudioContext */
function createSfx(audio) {
  let ctx = null, master = null, music = null, noiseBuf = null, timer = 0;
  const mus = { bpm: 150, step: 0, next: 0, on: false, finale: false };
  const midi = n => 440 * Math.pow(2, (n - 69) / 12);
  const unsub = audio.whenReady((c, m) => {
    ctx = c; master = m; noiseBuf = null; music = c.createGain(); music.gain.value = 0.35; music.connect(m);
    mus.next = c.currentTime + 0.1; if (!timer) timer = setInterval(schedule, 80);
  });
  function tone({ type = 'square', f0 = 440, f1, dur = 0.15, vol = 0.25, at = 0.005, lp = 0, delay = 0, dest }) {
    if (!ctx || audio.muted) return; const t = ctx.currentTime + delay; const o = ctx.createOscillator(); const g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); if (f1 !== undefined) o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(vol, t + at); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    let node = o; if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; o.connect(f); node = f; }
    node.connect(g); g.connect(dest || master); o.start(t); o.stop(t + dur + 0.05);
  }
  function noise({ dur = 0.1, vol = 0.3, lp = 3000, hp = 0, delay = 0, dest }) {
    if (!ctx || audio.muted) return;
    if (!noiseBuf) { noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    const t = ctx.currentTime + delay; const s = ctx.createBufferSource(); s.buffer = noiseBuf; const g = ctx.createGain();
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    let node = s; if (lp) { const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; node.connect(f); node = f; }
    if (hp) { const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp; node.connect(f); node = f; }
    node.connect(g); g.connect(dest || master); s.start(t); s.stop(t + dur + 0.05);
  }
  const LEAD = [72, 0, 76, 0, 79, 0, 76, 0, 74, 0, 77, 0, 81, 79, 77, 74, 72, 0, 76, 0, 79, 0, 84, 0, 83, 0, 79, 0, 76, 74, 72, 0];
  const BASS = [48, 0, 48, 0, 55, 0, 55, 0, 53, 0, 53, 0, 55, 0, 55, 0, 45, 0, 45, 0, 52, 0, 52, 0, 50, 0, 50, 0, 55, 0, 55, 0];
  const FLEAD = [69, 0, 72, 0, 76, 0, 72, 0, 69, 0, 72, 0, 77, 76, 72, 69, 68, 0, 71, 0, 76, 0, 71, 0, 68, 0, 71, 0, 76, 74, 71, 68];
  const FBASS = [45, 0, 45, 0, 45, 0, 52, 0, 41, 0, 41, 0, 41, 0, 48, 0, 44, 0, 44, 0, 44, 0, 52, 0, 40, 0, 40, 0, 47, 0, 47, 0];
  function schedule() { if (!ctx || !mus.on || audio.muted) return; const sd = 60 / mus.bpm / 4; if (mus.next < ctx.currentTime) mus.next = ctx.currentTime + 0.05; while (mus.next < ctx.currentTime + 0.25) { playStep(mus.step, mus.next, sd); mus.next += sd; mus.step++; } }
  function playStep(i, t, sd) {
    const s = i % 32; const lead = mus.finale ? FLEAD : LEAD, bass = mus.finale ? FBASS : BASS; const d = t - ctx.currentTime;
    if (lead[s]) tone({ type: 'square', f0: midi(lead[s]), dur: sd * 1.6, vol: 0.07, delay: d, dest: music, lp: 2400 });
    if (bass[s]) tone({ type: 'triangle', f0: midi(bass[s]), dur: sd * 1.8, vol: 0.16, delay: d, dest: music });
    if (s % 4 === 0) tone({ type: 'sine', f0: 160, f1: 40, dur: 0.12, vol: 0.35, delay: d, dest: music });
    if (s % 2 === 1) noise({ dur: 0.03, vol: 0.08, hp: 6000, delay: d, dest: music });
    if (s % 8 === 4) noise({ dur: 0.12, vol: 0.12, lp: 1500, delay: d, dest: music });
  }
  return {
    setMusic(on, finale = false) { mus.on = on; mus.finale = finale; mus.bpm = finale ? 172 : 150; if (ctx && on && mus.next < ctx.currentTime) mus.next = ctx.currentTime + 0.05; },
    dispose() { unsub(); if (timer) clearInterval(timer); timer = 0; mus.on = false; if (music) music.disconnect(); },
    oink() { tone({ type: 'sawtooth', f0: rand(260, 380), f1: 130, dur: 0.16, vol: 0.22, lp: 900 }); tone({ type: 'square', f0: rand(600, 800), f1: 200, dur: 0.08, vol: 0.06, lp: 1200 }); },
    squeal() { tone({ type: 'sawtooth', f0: 700, f1: 1400, dur: 0.25, vol: 0.12, lp: 2500 }); },
    hop() { tone({ type: 'sine', f0: 300, f1: 600, dur: 0.12, vol: 0.18 }); },
    boing() { tone({ type: 'sine', f0: 180, f1: 640, dur: 0.22, vol: 0.28 }); tone({ type: 'triangle', f0: 90, f1: 320, dur: 0.22, vol: 0.18 }); },
    pop() { noise({ dur: 0.07, vol: 0.6, lp: 2500 }); tone({ type: 'square', f0: 1000, f1: 300, dur: 0.06, vol: 0.2 }); },
    ding() { tone({ type: 'sine', f0: 1320, dur: 0.18, vol: 0.18 }); tone({ type: 'sine', f0: 1980, dur: 0.3, vol: 0.1, delay: 0.05 }); },
    whoosh() { noise({ dur: 0.18, vol: 0.35, lp: 1400, hp: 300 }); },
    thud() { tone({ type: 'triangle', f0: 130, f1: 45, dur: 0.18, vol: 0.4 }); noise({ dur: 0.08, vol: 0.3, lp: 600 }); },
    land() { tone({ type: 'triangle', f0: 90, f1: 50, dur: 0.08, vol: 0.15 }); },
    crack() { noise({ dur: 0.15, vol: 0.3, lp: 900 }); tone({ type: 'square', f0: 120, f1: 60, dur: 0.15, vol: 0.15 }); },
    fall() { tone({ type: 'sine', f0: 700, f1: 120, dur: 0.5, vol: 0.2 }); },
    beep() { tone({ type: 'square', f0: 880, dur: 0.1, vol: 0.15 }); tone({ type: 'square', f0: 880, dur: 0.1, vol: 0.15, delay: 0.15 }); },
    tick() { tone({ type: 'square', f0: 1200, dur: 0.05, vol: 0.12 }); },
    whistle() { tone({ type: 'sine', f0: 1500, f1: 2400, dur: 0.3, vol: 0.2 }); },
    fanfare() { [60, 64, 67, 72].forEach((n, i) => tone({ type: 'square', f0: midi(n + 12), dur: 0.25, vol: 0.12, delay: i * 0.09, lp: 3000 })); },
    cheer() { noise({ dur: 1.2, vol: 0.25, lp: 2500, hp: 400 }); [72, 76, 79].forEach((n, i) => tone({ type: 'square', f0: midi(n), dur: 0.4, vol: 0.1, delay: i * 0.12, lp: 2500 })); },
    sting() { [48, 55, 60, 64, 67, 72, 79].forEach((n, i) => tone({ type: 'sawtooth', f0: midi(n), dur: 1.2, vol: 0.08, delay: i * 0.06, lp: 1800 })); tone({ type: 'sine', f0: 60, f1: 30, dur: 1.2, vol: 0.5 }); },
  };
}

/* ============================================================ the HUD */
const HTML = `<canvas class="gl"></canvas>
<div class="hud ov" data-hud>
  <div class="top"><div class="round stroke"><span data-round>ROUND 1</span><small data-sub></small></div><div class="timer stroke" data-timer></div></div>
  <div class="chips" data-chips></div>
  <div class="foot" data-foot><span data-keys></span><button class="snd" data-snd type="button"></button></div>
</div>
<div class="toasts" data-toasts></div>
<div class="card ov" data-card hidden><div class="in"><div class="kick stroke" data-kick></div><h2 class="stroke" data-cname></h2><p data-csub></p><div class="who" data-who hidden></div></div></div>
<div class="title ov" data-title hidden><canvas class="confetti" data-confetti></canvas><div class="in">
  <div class="kick" data-t="title.kick"></div><h1 data-t="title.name"></h1><div class="win" data-twin></div><div class="again" data-tfoot></div>
</div></div>
<div class="menu-btn ctl" data-menu>☰</div>
<div class="pad ctl" data-pad><div class="ring"><div class="knob"></div></div><div class="lbl" data-t="pad"></div></div>
<div class="tbtn ctl hop" data-hop><span data-t="hop"></span></div>
<div class="tbtn ctl dash" data-dash><span data-t="dash"></span></div>
<div class="overlay pause" data-pause><div class="mcard"><h1 data-t="menu.title"></h1><div data-pause-btns></div></div></div>
<div class="overlay rotate"><div><div class="phone">📱</div><span data-t="rotate"></span><small data-t="rotateSub"></small></div></div>`;

/* ============================================================ the game */
export async function create({ mount, audio, send, hooks }) {
  const unloadCss = await loadStylesheet('/games/hog/hog.css');
  const touch = isCoarse(); // phones and tablets: the thumb stick, HOP, DASH and ☰ appear and the keyboard footer goes
  const root = document.createElement('div'); root.className = 'hog' + (touch ? ' touch' : ''); root.innerHTML = HTML; mount.appendChild(root);
  const $ = sel => root.querySelector(sel);
  const dom = { hud: $('[data-hud]'), round: $('[data-round]'), sub: $('[data-sub]'), timer: $('[data-timer]'), chips: $('[data-chips]'), keys: $('[data-keys]'), snd: $('[data-snd]'), toasts: $('[data-toasts]'),
    card: $('[data-card]'), kick: $('[data-kick]'), cname: $('[data-cname]'), csub: $('[data-csub]'), who: $('[data-who]'),
    title: $('[data-title]'), confetti: $('[data-confetti]'), twin: $('[data-twin]'), tfoot: $('[data-tfoot]'),
    menuBtn: $('[data-menu]'), pause: $('[data-pause]'), pauseBtns: $('[data-pause-btns]'), hopBtn: $('[data-hop]'), dashBtn: $('[data-dash]') };
  const sfx = createSfx(audio);

  /* ---- renderer / scene */
  const canvas = $('.gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !touch, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, touch ? 1.5 : 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0x86d1ff); scene.fog = new THREE.Fog(0x86d1ff, 45, 110);
  const camera = new THREE.PerspectiveCamera(42, 1, 0.1, 300);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x9a6a3a, 0.9));
  const sun = new THREE.DirectionalLight(0xfff4d6, 1.7); sun.position.set(18, 32, 14); sun.castShadow = true;
  sun.shadow.mapSize.set(touch ? 1024 : 2048, touch ? 1024 : 2048); sun.shadow.camera.near = 5; sun.shadow.camera.far = 90;
  sun.shadow.camera.left = -19; sun.shadow.camera.right = 19; sun.shadow.camera.top = 19; sun.shadow.camera.bottom = -19; sun.shadow.bias = -0.0008;
  scene.add(sun); scene.add(sun.target);
  function resize() { const w = root.clientWidth || innerWidth, h = root.clientHeight || innerHeight; renderer.setSize(w, h, false); camera.aspect = w / h; camera.updateProjectionMatrix(); }
  addEventListener('resize', resize); resize();
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(resize) : null; ro?.observe(root);

  /* toon gradient (3 bands) for the chunky cel look; materials and geometries are shared through these caches */
  const grad = new THREE.DataTexture(new Uint8Array([110, 110, 110, 255, 190, 190, 190, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
  grad.minFilter = grad.magFilter = THREE.NearestFilter; grad.needsUpdate = true;
  const MATS = new Map(), GEOS = new Map();
  const mat = (c, extra) => { const k = c + (extra ? JSON.stringify(extra) : ''); let m = MATS.get(k); if (!m) { m = new THREE.MeshToonMaterial({ color: c, gradientMap: grad, ...(extra || {}) }); MATS.set(k, m); } return m; };
  const geo = (key, make) => { let g = GEOS.get(key); if (!g) { g = make(); GEOS.set(key, g); } return g; };
  const GEO = {
    sphere: (r, s = 14) => geo(`s${r},${s}`, () => new THREE.SphereGeometry(r, s, Math.max(6, s * 0.7 | 0))),
    box: (w, h, d) => geo(`b${w},${h},${d}`, () => new THREE.BoxGeometry(w, h, d)),
    cyl: (rt, rb, h, s = 16) => geo(`c${rt},${rb},${h},${s}`, () => new THREE.CylinderGeometry(rt, rb, h, s)),
    cone: (r, h, s = 8) => geo(`k${r},${h},${s}`, () => new THREE.ConeGeometry(r, h, s)),
    torus: (r, t, arc) => geo(`t${r},${t},${arc}`, () => new THREE.TorusGeometry(r, t, 7, 14, arc)),
  };
  const M = (g, color, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(g, mat(color)); m.position.set(x, y, z); m.castShadow = true; m.receiveShadow = true; return m; };
  const setSky = c => { scene.background.set(c); scene.fog.color.set(c); root.style.background = hex(c); };

  /* ---- physics. The world exists on every machine (the arenas add their static bodies without asking), but only the
     host ever steps it; a client's pig bodies are just where its snapshots put them. */
  const world = new CANNON.World({ gravity: new CANNON.Vec3(0, -24, 0) });
  world.broadphase = new CANNON.NaiveBroadphase(); world.allowSleep = false;
  const matPig = new CANNON.Material('pig'), matGround = new CANNON.Material('ground');
  world.defaultContactMaterial.friction = 0; world.defaultContactMaterial.restitution = 0.1;
  world.addContactMaterial(new CANNON.ContactMaterial(matPig, matGround, { friction: 0, restitution: 0.15 }));
  world.addContactMaterial(new CANNON.ContactMaterial(matPig, matPig, { friction: 0, restitution: 0.6 }));
  const UPV = new CANNON.Vec3(0, 1, 0), tmpQ = new CANNON.Quaternion(), tmpV = new CANNON.Vec3(), tmpV2 = new CANNON.Vec3();

  class Arena {
    constructor() { this.group = new THREE.Group(); scene.add(this.group); this.bodies = []; }
    add(m) { this.group.add(m); return m; }
    addBody(b) { world.addBody(b); this.bodies.push(b); return b; }
    removeBody(b) { const i = this.bodies.indexOf(b); if (i >= 0) { this.bodies.splice(i, 1); world.removeBody(b); } }
    dispose() { for (const b of this.bodies) world.removeBody(b); this.bodies.length = 0; scene.remove(this.group); }
  }
  function sbox(A, w, h, d, color, x, y, z, ry = 0, physics = true) {
    const m = M(GEO.box(w, h, d), color, x, y, z); m.rotation.y = ry; A.add(m);
    if (physics) { const b = new CANNON.Body({ mass: 0, material: matGround, shape: new CANNON.Box(new CANNON.Vec3(w / 2, h / 2, d / 2)) }); b.position.set(x, y, z); b.quaternion.setFromAxisAngle(UPV, ry); A.addBody(b); m.body = b; }
    return m;
  }
  function scyl(A, r, h, color, x, y, z, seg = 24, physics = true) {
    const m = M(GEO.cyl(r, r, h, seg), color, x, y, z); A.add(m);
    if (physics) { const b = new CANNON.Body({ mass: 0, material: matGround, shape: new CANNON.Cylinder(r, r, h, seg) }); b.position.set(x, y, z); A.addBody(b); m.body = b; }
    return m;
  }
  const underside = (A, r, color, depth = 6) => { const m = new THREE.Mesh(GEO.cyl(r, r * 0.25, depth, 10), mat(color)); m.position.y = -depth / 2 - 0.9; m.receiveShadow = true; A.add(m); };

  /* ---- particles (one InstancedMesh) */
  const FX = (() => {
    const N = 600; const fxMat = new THREE.MeshLambertMaterial({ color: 0xffffff }); const mesh = new THREE.InstancedMesh(GEO.box(0.2, 0.2, 0.2), fxMat, N);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); mesh.frustumCulled = false; mesh.castShadow = false; scene.add(mesh);
    const P = []; for (let i = 0; i < N; i++) P.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, g: 12, s: 1, rx: 0, ry: 0 });
    let next = 0; const dummy = new THREE.Object3D(); const col = new THREE.Color();
    for (let i = 0; i < N; i++) { dummy.scale.setScalar(0); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix); mesh.setColorAt(i, col); }
    function spawn(x, y, z, color, { n = 8, speed = 3, up = 3, size = 1, life = 0.7, g = 12, spread = 0.3 } = {}) {
      for (let k = 0; k < n; k++) {
        const i = next; next = (next + 1) % N; const p = P[i]; const a = rand(TAU), r = rand(speed * 0.3, speed);
        p.x = x + rand(-spread, spread); p.y = y + rand(-spread, spread); p.z = z + rand(-spread, spread);
        p.vx = Math.cos(a) * r; p.vz = Math.sin(a) * r; p.vy = rand(up * 0.3, up * 1.3); p.life = p.max = life * rand(0.6, 1.3); p.s = size * rand(0.5, 1.3); p.g = g; p.rx = rand(TAU); p.ry = rand(TAU);
        col.set(Array.isArray(color) ? color[k % color.length] : color); mesh.setColorAt(i, col);
      }
      mesh.instanceColor.needsUpdate = true;
    }
    function update(dt) {
      for (let i = 0; i < N; i++) {
        const p = P[i]; if (p.life <= 0) continue; p.life -= dt; p.vy -= p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.rx += dt * 4; p.ry += dt * 3;
        const s = p.life > 0 ? p.s * clamp(p.life / p.max * 2.5, 0, 1) : 0; dummy.position.set(p.x, p.y, p.z); dummy.rotation.set(p.rx, p.ry, 0); dummy.scale.setScalar(s); dummy.updateMatrix(); mesh.setMatrixAt(i, dummy.matrix);
      }
      mesh.instanceMatrix.needsUpdate = true;
    }
    return { spawn, update, dispose() { scene.remove(mesh); mesh.dispose(); fxMat.dispose(); },
      dust: (p, n = 6) => spawn(p.x, p.y - 0.4, p.z, [0xfff3d6, 0xe8d5b5], { n, speed: 2.5, up: 2, size: 0.8, life: 0.5, g: 6 }),
      stars: (p, n = 8) => spawn(p.x, p.y + 0.6, p.z, [0xffd60a, 0xffffff], { n, speed: 3, up: 3, size: 0.9, life: 0.6, g: 9 }),
      pop: (p, c) => spawn(p.x, p.y, p.z, [c, 0xffffff], { n: 14, speed: 4, up: 3, size: 0.8, life: 0.6, g: 10 }),
      poof: p => spawn(p.x, p.y, p.z, [0xffffff, 0xffe6f0], { n: 18, speed: 3, up: 4, size: 1.4, life: 0.8, g: 2 }),
      confetti: (p, cs) => spawn(p.x, p.y + 3, p.z, cs, { n: 40, speed: 4, up: 6, size: 0.9, life: 1.6, g: 5, spread: 1.5 }),
    };
  })();

  /* ---- pig model */
  function buildHat(type) {
    const h = new THREE.Group(); let prop = null;
    const dome = () => geo('dome', () => new THREE.SphereGeometry(0.43, 14, 8, 0, TAU, 0, Math.PI / 2));
    if (type === 'tophat') { h.add(M(GEO.cyl(0.4, 0.4, 0.05), 0x1b1b2f, 0, 0.02, 0)); h.add(M(GEO.cyl(0.25, 0.27, 0.44), 0x1b1b2f, 0, 0.26, 0)); h.add(M(GEO.cyl(0.26, 0.28, 0.1), 0xe63946, 0, 0.1, 0)); }
    else if (type === 'cone') { h.add(M(GEO.cone(0.27, 0.62, 12), 0xffd60a, 0, 0.31, 0)); h.add(M(GEO.cone(0.19, 0.06, 12), 0x4cc9f0, 0, 0.45, 0)); h.add(M(GEO.cyl(0.27, 0.27, 0.07, 12), 0x4cc9f0, 0, 0.04, 0)); h.add(M(GEO.sphere(0.1, 8), 0xff5c8a, 0, 0.64, 0)); h.rotation.z = 0.22; }
    else if (type === 'viking') { h.add(new THREE.Mesh(dome(), mat(0x8d99ae))); h.add(M(GEO.cyl(0.44, 0.44, 0.09), 0x5c677d, 0, 0.02, 0)); for (const s of [-1, 1]) { const horn = M(GEO.cone(0.09, 0.42, 8), 0xfff1d6, s * 0.42, 0.2, 0); horn.rotation.z = -s * 1.15; h.add(horn); } }
    else if (type === 'beanie') { h.add(new THREE.Mesh(dome(), mat(0xe63946))); h.add(M(GEO.cyl(0.44, 0.44, 0.09), 0x2b2d42, 0, 0.02, 0)); h.add(M(GEO.cyl(0.03, 0.03, 0.18, 6), 0x2b2d42, 0, 0.48, 0)); prop = M(GEO.box(0.6, 0.03, 0.1), 0xffd60a, 0, 0.57, 0); h.add(prop); }
    else if (type === 'crown') { h.add(M(GEO.cyl(0.34, 0.3, 0.26, 10), GOLD, 0, 0.13, 0)); for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; h.add(M(GEO.cone(0.08, 0.22, 4), GOLD, Math.cos(a) * 0.3, 0.34, Math.sin(a) * 0.3)); } h.add(M(GEO.sphere(0.07, 8), 0xe63946, 0, 0.15, 0.31)); }
    h.traverse(o => { if (o.isMesh) o.castShadow = true; });
    return { h, prop };
  }
  function buildPig(color, hat) {
    const g = new THREE.Group(), v = new THREE.Group(); g.add(v); v.position.y = -0.05;
    const dark = new THREE.Color(color).multiplyScalar(0.7).getHex();
    const snoutC = new THREE.Color(color).lerp(new THREE.Color(0xff4f86), 0.35).getHex();
    const body = M(GEO.sphere(0.55, 16), color); body.scale.set(1.12, 0.95, 1.22); v.add(body);
    const belly = M(GEO.sphere(0.4, 10), snoutC, 0, -0.18, 0.15); belly.scale.set(1.1, 0.75, 1.1); v.add(belly);
    const head = new THREE.Group(); head.position.set(0, 0.3, 0.6); v.add(head);
    head.add(M(GEO.sphere(0.4, 14), color));
    head.add(M(GEO.box(0.36, 0.26, 0.2), snoutC, 0, -0.06, 0.4));
    for (const s of [-1, 1]) head.add(M(GEO.box(0.07, 0.09, 0.03), 0x5a1e35, s * 0.09, -0.06, 0.51));
    const eyes = [];
    for (const s of [-1, 1]) { const e = new THREE.Group(); e.position.set(s * 0.17, 0.14, 0.33); e.add(M(GEO.sphere(0.085, 8), 0xffffff)); e.add(M(GEO.sphere(0.045, 6), 0x222222, 0, 0.005, 0.065)); head.add(e); eyes.push(e); }
    for (const s of [-1, 1]) { const ear = M(GEO.cone(0.13, 0.3, 4), dark, s * 0.27, 0.36, -0.02); ear.rotation.z = -s * 0.55; ear.rotation.x = -0.25; head.add(ear); }
    const legs = [];
    for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) { const leg = new THREE.Group(); leg.position.set(sx * 0.3, -0.3, sz * 0.36); leg.add(M(GEO.cyl(0.14, 0.14, 0.36, 8), color, 0, -0.12, 0)); leg.add(M(GEO.cyl(0.15, 0.15, 0.1, 8), dark, 0, -0.33, 0)); v.add(leg); legs.push(leg); }
    const tailG = new THREE.Group(); tailG.position.set(0, 0.18, -0.66); const tail = M(GEO.torus(0.11, 0.035, 4.6), color); tail.rotation.y = Math.PI / 2; tailG.add(tail); v.add(tailG);
    const { h: hatM, prop } = buildHat(hat); hatM.position.set(0, 0.34, -0.03); head.add(hatM);
    g.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; } });
    return { group: g, visual: v, head, legs, eyes, tail: tailG, hat: hatM, prop };
  }
  /* your own pig's marker: a ring on the ground whose bright arc is the dash cooldown filling back up (16 cached arcs, no
     per-frame geometry), and an arrow bobbing over the hat. Unlit, so it reads in every arena's light. */
  const MARK_ARCS = 16;
  const markDim = new THREE.MeshBasicMaterial({ color: MINE, transparent: true, opacity: 0.28, depthWrite: false });
  const markLit = new THREE.MeshBasicMaterial({ color: MINE, transparent: true, opacity: 0.9, depthWrite: false });
  const markArrow = new THREE.MeshBasicMaterial({ color: MINE });
  const ringArc = k => geo(`mk${k}`, () => new THREE.RingGeometry(0.74, 0.92, 32, 1, Math.PI / 2, k / MARK_ARCS * TAU).rotateX(-Math.PI / 2));
  function buildMarker() {
    const g = new THREE.Group();
    const base = new THREE.Mesh(ringArc(MARK_ARCS), markDim), fill = new THREE.Mesh(ringArc(MARK_ARCS), markLit);
    const arrow = new THREE.Mesh(GEO.cone(0.24, 0.42, 4), markArrow); arrow.rotation.x = Math.PI;
    for (const m of [base, fill]) { m.renderOrder = 5; m.position.y = 0.02; }
    g.add(base, fill, arrow); g.visible = false; scene.add(g);
    return { g, fill, arrow, k: MARK_ARCS, pulse: 0 };
  }

  /* ============================================================ state */
  let session = null, isHost = false, online = false, hostId = null, myId = null, me = null, guard = null;
  const G = { state: null, pigs: [], mode: null, arena: null, plan: [], round: 0, t: 0, time: 0, frozen: false, card: 0, lastTick: 99, winner: -1, running: false };
  const CAM = { target: new THREE.Vector3(), pos: new THREE.Vector3(0, 14, 18), shake: 0, tmp: new THREE.Vector3() };
  let events = [];
  const bumpQueue = [];

  /* ============================================================ pig */
  class Pig {
    constructor(slot) {
      this.i = slot.i; this.slot = slot; this.name = slot.name; this.human = slot.human; this.pid = slot.pid; this.color = slot.color; this.emoji = slot.emoji;
      this.body = new CANNON.Body({ mass: 3, shape: new CANNON.Sphere(R), material: matPig, linearDamping: 0, angularDamping: 0.5 });
      this.body.pig = this; this.body.addEventListener('collide', e => onCollide(this, e));
      Object.assign(this, buildPig(slot.color, slot.hat)); scene.add(this.group);
      this.yaw = 0; this.stun = 0; this.grounded = 0; this.wasGrounded = false; this.prevVy = 0; this.dash = 0; this.dashCd = 0; this.jumpCd = 0;
      this.out = false; this.inWorld = false; this.respawn = -1; this.lastBump = -9;
      this.bank = 0; this.throne = 0; this.balloons = 3; this.truffles = 0; this.hits = 0; this.pops = 0; this.outTime = 0;
      this.squash = 0; this.stretch = 0; this.legPhase = 0; this.blink = rand(2, 5); this.stunFx = 0; this.dashFx = 0;
      this.ai = { mx: 0, mz: 0, jump: false, dash: false, think: 0, tx: 0, tz: 0, react: rand(0.8, 1.2), fumble: rand(0.02, 0.1), target: null, side: rand() < 0.5 ? 1 : -1 };
      this.ctl = { mx: 0, mz: 0, jump: false, dash: false };
      this.want = { mx: 0, mz: 0, jump: false }; this.dashQ = 0; // a human's latest wish (local keys, or the network); dashQ: seconds a DASH press stays buffered
      this.buf = []; // a client's snapshots of this pig
      this.marker = null; this.echoHop = -9; this.echoDash = -9; this.lyaw = 0; // your own pig: its marker, and a client's local echo (press times, the yaw it shows)
    }
    get pos() { return this.body.position; }
    place(x, y, z, face) { const b = this.body; b.position.set(x, y, z); b.velocity.set(0, 0, 0); b.angularVelocity.set(0, 0, 0); this.yaw = face ?? Math.atan2(-x, -z); b.quaternion.setFromAxisAngle(UPV, this.yaw); this.stun = 0; this.dash = 0; this.grounded = 0; this.buf = []; }
    enter() { if (!this.inWorld) { if (isHost) world.addBody(this.body); this.inWorld = true; } this.group.visible = true; this.respawn = -1; }
    leave() { if (this.inWorld) { if (isHost) world.removeBody(this.body); this.inWorld = false; } this.group.visible = false; }
    resetRound() { this.out = false; this.balloons = 3; this.truffles = 0; this.hits = 0; this.pops = 0; this.outTime = 0; this.throne = 0; this.enter(); }
    toAI() { if (!this.human) return; this.human = false; this.pid = null; if (this === me) me = null; if (this.marker) this.marker.g.visible = false; }
    dispose() { this.leave(); scene.remove(this.group); if (this.marker) scene.remove(this.marker.g); }
    mark() { if (!this.marker) this.marker = buildMarker(); }
    readInput(step) {
      const c = this.ctl;
      if (G.frozen || this.out) { c.mx = c.mz = 0; c.jump = c.dash = false; this.dashQ = 0; return; }
      /* a DASH press waits up to DASH_BUFFER s for the cooldown or a stun to run out; fixed() clears it once the dash goes */
      if (this.human) { c.mx = this.want.mx; c.mz = this.want.mz; c.jump = this.want.jump; c.dash = this.dashQ > 0; this.dashQ = Math.max(0, this.dashQ - step); }
      else { const a = this.ai; a.jump = false; G.mode.ai(this, step); c.mx = a.mx; c.mz = a.mz; c.jump = a.jump; c.dash = a.dash; a.dash = false; }
    }
    fixed(step) {
      if (this.respawn > 0) { this.dashQ = 0; this.respawn -= step; if (this.respawn <= 0) { this.enter(); const s = G.mode.respawnPos(this); this.place(s.x, s.y, s.z); emit('poof', r2(s.x), r2(s.y), r2(s.z)); } return; }
      if (!this.inWorld) return;
      this.readInput(step);
      const b = this.body, v = b.velocity, c = this.ctl, grounded = this.grounded > 0;
      if (this.stun > 0) { this.stun -= step; if (grounded) { const f = Math.exp(-3 * step); v.x *= f; v.z *= f; } }
      this.dashCd = Math.max(0, this.dashCd - step); this.jumpCd = Math.max(0, this.jumpCd - step);
      let mx = c.mx, mz = c.mz; const len = Math.hypot(mx, mz); if (len > 1) { mx /= len; mz /= len; }
      if (this.stun <= 0) {
        if (this.dash > 0) { this.dash -= step; v.x = Math.sin(this.yaw) * DASH_SPEED; v.z = Math.cos(this.yaw) * DASH_SPEED; if (this.dash <= 0) { v.x *= 0.35; v.z *= 0.35; } }
        else {
          const acc = grounded ? 13 : 4, k = Math.min(1, acc * step);
          v.x += (mx * SPEED - v.x) * k; v.z += (mz * SPEED - v.z) * k;
          if (len > 0.1) this.yaw = lerpAngle(this.yaw, Math.atan2(mx, mz), damp(14, step));
          if (c.jump && grounded && this.jumpCd <= 0) { v.y = JUMP; this.jumpCd = 0.25; this.grounded = 0; emit('hop', this.i); }
          if (c.dash && this.dashCd <= 0) { this.dashQ = 0; if (len > 0.1) this.yaw = Math.atan2(mx, mz); this.dash = DASH_TIME; this.dashCd = DASH_CD; emit('dash', this.i); if (grounded) v.y = Math.max(v.y, 2.5); }
        }
        tmpQ.setFromAxisAngle(UPV, this.yaw); b.quaternion.slerp(tmpQ, damp(11, step), b.quaternion); b.angularVelocity.set(0, 0, 0);
      }
    }
    hit(ix, iy, iz, stun, power = 1) {
      const b = this.body; b.velocity.x += ix; b.velocity.y += iy; b.velocity.z += iz; this.stun = Math.max(this.stun, stun); this.dash = 0; this.hits++;
      b.angularVelocity.set(rand(-1, 1) * 9 * power, rand(-1, 1) * 5 * power, rand(-1, 1) * 9 * power);
    }
    post(step) { // after world.step
      if (!this.inWorld) return;
      const g = this.grounded > 0;
      if (g && !this.wasGrounded && this.prevVy < -4) emit('land', this.i, this.prevVy < -9 ? 1 : 0);
      this.wasGrounded = g; this.prevVy = this.body.velocity.y;
      if (this.grounded > 0) this.grounded--;
      if (this.pos.y < -7) G.mode.onFall(this);
    }
    frame(dt, t) {
      if (!this.inWorld) return;
      const b = this.body, v = b.velocity; this.group.position.copy(b.position); this.group.quaternion.copy(b.quaternion);
      const sp = Math.hypot(v.x, v.z), moving = sp > 0.8 && this.grounded > 0 && this.stun <= 0;
      this.legPhase += dt * (moving ? sp * 2.4 : 0);
      for (let i = 0; i < 4; i++) { const l = this.legs[i]; const ph = this.legPhase + ((i === 1 || i === 2) ? Math.PI : 0); const tg = moving ? Math.sin(ph) * 0.75 : 0; l.rotation.x = lerp(l.rotation.x, tg, damp(18, dt)); }
      this.squash *= Math.exp(-dt * 7); this.stretch *= Math.exp(-dt * 9);
      const sq = this.squash, st = this.stretch; this.visual.scale.set(1 + sq * 0.32 - st * 0.14, 1 - sq * 0.36 + st * 0.32, 1 + sq * 0.32 - st * 0.14);
      this.visual.position.y = -0.05 + (moving ? Math.abs(Math.sin(this.legPhase)) * 0.08 : 0);
      this.head.rotation.z = Math.sin(t * 3 + this.i) * 0.05 + (moving ? Math.sin(this.legPhase) * 0.06 : 0);
      this.head.rotation.x = this.stun > 0 ? -0.3 : (moving ? 0.05 : 0);
      this.tail.rotation.x = Math.sin(t * (moving ? 16 : 4) + this.i) * (moving ? 0.7 : 0.25);
      this.blink -= dt; const closed = this.blink < 0 && this.blink > -0.12; if (this.blink < -0.12) this.blink = rand(2, 5);
      for (const e of this.eyes) e.scale.y = lerp(e.scale.y, closed ? 0.12 : 1, damp(40, dt));
      if (this.prop) this.prop.rotation.y += dt * (7 + sp * 3);
      if (this.stun > 0) { this.stunFx -= dt; if (this.stunFx <= 0) { this.stunFx = 0.14; FX.stars(this.pos, 2); } }
      if (this.dash > 0) { this.dashFx -= dt; if (this.dashFx <= 0) { this.dashFx = 0.03; FX.dust(this.pos, 3); } }
      const mk = this.marker; if (mk) {
        mk.g.position.set(b.position.x, b.position.y - R, b.position.z);
        const k = Math.round(clamp(1 - this.dashCd / DASH_CD, 0, 1) * MARK_ARCS); if (k !== mk.k) { if (k === MARK_ARCS) mk.pulse = 1; mk.k = k; mk.fill.visible = k > 0; if (k > 0) mk.fill.geometry = ringArc(k); }
        mk.pulse *= Math.exp(-dt * 6); mk.fill.scale.setScalar(1 + mk.pulse * 0.35);
        mk.arrow.position.y = 3.3 + Math.sin(t * 5) * 0.14; mk.arrow.rotation.y = t * 2;
      }
    }
  }
  function onCollide(pig, e) {
    if (!isHost) return;
    const other = e.body; const rel = Math.abs(e.contact.getImpactVelocityAlongNormal());
    if (other.pig) { if (pig.i < other.pig.i) bumpQueue.push({ a: pig, b: other.pig, rel }); }
    else if (other.hazard) bumpQueue.push({ a: pig, hazard: other, contact: e.contact });
  }
  function processBumps() {
    for (const q of bumpQueue) {
      if (q.hazard) { hazardHit(q); continue; }
      const { a, b, rel } = q; if (a.out || b.out || !a.inWorld || !b.inWorld) continue;
      if (G.time - a.lastBump < 0.25 && G.time - b.lastBump < 0.25) continue;
      const aD = a.dash > 0, bD = b.dash > 0;
      if (rel < 2.2 && !aD && !bD) continue;
      a.lastBump = b.lastBump = G.time;
      const dx = b.pos.x - a.pos.x, dz = b.pos.z - a.pos.z, d = Math.hypot(dx, dz) || 1, nx = dx / d, nz = dz / d;
      const pow = clamp(rel / 9, 0.5, 1.5);
      const mid = { x: (a.pos.x + b.pos.x) / 2, y: (a.pos.y + b.pos.y) / 2, z: (a.pos.z + b.pos.z) / 2 };
      let dashHit = false;
      if (aD && !bD) { b.hit(nx * 11, 5.5, nz * 11, 1.1, 1.4); a.body.velocity.x *= 0.2; a.body.velocity.z *= 0.2; a.dash = 0; G.mode.onBump(a, b, true, rel); dashHit = true; }
      else if (bD && !aD) { a.hit(-nx * 11, 5.5, -nz * 11, 1.1, 1.4); b.body.velocity.x *= 0.2; b.body.velocity.z *= 0.2; b.dash = 0; G.mode.onBump(b, a, true, rel); dashHit = true; }
      else { a.hit(-nx * 5 * pow, 3.5 * pow, -nz * 5 * pow, 0.5 * pow, pow); b.hit(nx * 5 * pow, 3.5 * pow, nz * 5 * pow, 0.5 * pow, pow); G.mode.onBump(a, b, false, rel); G.mode.onBump(b, a, false, rel); }
      emit('bump', r2(mid.x), r2(mid.y), r2(mid.z), r2(pow), dashHit ? 1 : 0);
    }
    bumpQueue.length = 0;
  }
  function hazardHit(q) {
    const p = q.a; if (p.out || !p.inWorld) return; if (G.time - p.lastBump < 0.35) return; p.lastBump = G.time;
    const c = q.contact; if (c.bi === p.body) c.bi.position.vadd(c.ri, tmpV); else c.bj.position.vadd(c.rj, tmpV);
    q.hazard.getVelocityAtWorldPoint(tmpV, tmpV2);
    p.hit(tmpV2.x * 1.1 + rand(-1, 1), 7.5, tmpV2.z * 1.1 + rand(-1, 1), 1.4, 1.6);
    const v = p.body.velocity, hs = Math.hypot(v.x, v.z); if (hs > 8) { v.x *= 8 / hs; v.z *= 8 / hs; }
    emit('hazard', p.i);
  }

  /* ============================================================ effects: the host emits, everyone applies */
  function emit(...ev) { applyEvent(ev); if (online && isHost) events.push(ev); }
  const pigAt = i => G.pigs[i | 0] || null;
  /* a client already played its own HOP / DASH the moment it pressed (echoHop / echoDash); the host's event for it is swallowed once */
  const ECHO_WINDOW = 0.5;
  const echoed = (p, k) => { if (isHost || p !== me || nowSec() - p[k] > ECHO_WINDOW) return false; p[k] = -9; return true; };
  const hopFx = p => { sfx.hop(); FX.dust(p.pos, 5); p.stretch = 1; }, dashFx = p => { sfx.whoosh(); FX.dust(p.pos, 8); p.stretch = 1; };
  const wordToast = ev => { const w = toastText(ev, G.pigs, T); if (w) toast(w.text, w.color); };
  function applyEvent(ev) {
    const p = pigAt(ev[1]);
    switch (ev[0]) {
      case 'hop': if (p && !echoed(p, 'echoHop')) hopFx(p); break;
      case 'dash': if (p && !echoed(p, 'echoDash')) dashFx(p); break;
      case 'land': if (p) { p.squash = 1; FX.dust(p.pos, ev[2] ? 10 : 4); if (ev[2]) sfx.land(); } break;
      case 'bump': { const [, x, y, z, pow, dashHit] = ev; if (dashHit) sfx.thud(); sfx.boing(); sfx.oink(); FX.stars({ x, y, z }, 10); CAM.shake += 0.25 * pow; break; }
      case 'hazard': if (p) { sfx.thud(); sfx.squeal(); FX.stars(p.pos, 12); CAM.shake += 0.5; } break;
      case 'out': if (p) { sfx.fall(); wordToast(['toast', 'out', ev[1]]); } break;
      case 'fall': if (p) { sfx.fall(); FX.poof(p.pos); } break;
      case 'poof': FX.poof({ x: ev[1], y: ev[2], z: ev[3] }); break;
      case 'pop': { const [, x, y, z, i] = ev; const q = pigAt(i); FX.pop({ x, y, z }, q ? q.color : 0xffffff); sfx.pop(); break; }
      case 'toast': wordToast(ev); break;
      case 'crack': sfx.crack(); break;
      case 'tile': FX.spawn(ev[1], 0, ev[2], [0xfff1c9, 0x8b5a2b], { n: 6, speed: 2, up: 2, size: 0.7, life: 0.6 }); break;
      case 'ding': { const [, x, y, z, gold] = ev; sfx.ding(); if (gold) sfx.fanfare(); FX.spawn(x, y, z, [gold ? 0xffd60a : 0x3e2723, 0xffffff], { n: 8, speed: 2.5, up: 3, size: 0.7, life: 0.5 }); break; }
      case 'beep': sfx.beep(); break;
      case 'fanfare': sfx.fanfare(); break;
      case 'whistle': sfx.whistle(); break;
      case 'tick': sfx.tick(); break;
      case 'count': dom.card.hidden = true; toast(String(ev[1] | 0), 0xffffff, 'count'); sfx.tick(); break;
      case 'go': dom.card.hidden = true; toast(T('go'), 0x7cff9a, 'count'); sfx.whistle(); break;
      case 'cheer': sfx.cheer(); clearToasts(); FX.confetti(p && p.inWorld ? p.pos : { x: 0, y: 2, z: 0 }, [p ? p.color : 0xffffff, GOLD, 0xffffff]); break;
      case 'sting': sfx.sting(); sfx.cheer(); break;
    }
  }

  /* ============================================================ modes */
  class Mode {
    constructor() { this.key = ''; this.duration = 30; this.safeR = 6; this.spawnR = 4.5; this.sky = 0x86d1ff; this.finale = false; this.camUp = 0.85; this.camDist = 1; this.t = 0; }
    build(A) {} reset() {} fixed(step) {} frame(dt, t) {} onBump(a, b, dash, rel) {}
    pack() { return null; } apply(m) {}
    ai(pig, step) { this.wander(pig, step); }
    onFall(pig) { this.eliminate(pig); }
    rank() { return this.survivalRank(); }
    finished() { return this.alive().length <= 1; }
    get name() { return T('mode.' + this.key); }
    get sub() { return T('mode.' + this.key + '.sub'); }
    stat(p) { return p.out ? T('stat.out') : '🐷'; }
    camPoints() { return null; }
    alive() { return G.pigs.filter(p => !p.out); }
    spawnPos(i) { const n = Math.max(4, G.pigs.length), a = i / n * TAU + Math.PI / 4; return { x: Math.cos(a) * this.spawnR, y: 3.5 + i * 0.4, z: Math.sin(a) * this.spawnR }; }
    respawnPos(pig) { const a = rand(TAU), r = this.spawnR; return { x: Math.cos(a) * r, y: 5, z: Math.sin(a) * r }; }
    eliminate(pig) { if (pig.out) return; pig.out = true; pig.outTime = G.t; pig.leave(); emit('out', pig.i); }
    survivalRank() { const a = this.alive().sort((x, y) => x.hits - y.hits); const o = G.pigs.filter(p => p.out).sort((x, y) => y.outTime - x.outTime); return a.concat(o); }
    wander(pig, step, rmin = 1, rmax = this.safeR * 0.8) { const ai = pig.ai; ai.think -= step; if (ai.think <= 0) { ai.think = rand(0.8, 2); const a = rand(TAU), r = rand(rmin, rmax); ai.tx = Math.cos(a) * r; ai.tz = Math.sin(a) * r; } return this.steer(pig, ai.tx, ai.tz); }
    steer(pig, tx, tz, stop = 0.3) { const p = pig.pos; const dx = tx - p.x, dz = tz - p.z; const d = Math.hypot(dx, dz); if (d < stop) { pig.ai.mx = pig.ai.mz = 0; return d; } pig.ai.mx = dx / d; pig.ai.mz = dz / d; return d; }
    nearestPig(pig, pred) { let best = null, bd = 1e9; for (const o of G.pigs) { if (o === pig || o.out || !o.inWorld || o.respawn > 0) continue; if (pred && !pred(o)) continue; const d = Math.hypot(o.pos.x - pig.pos.x, o.pos.z - pig.pos.z); if (d < bd) { bd = d; best = o; } } return { pig: best, d: bd }; }
    facing(pig, o) { return Math.abs(angDiff(pig.yaw, Math.atan2(o.pos.x - pig.pos.x, o.pos.z - pig.pos.z))); }
    flags(A, r, n, colors, h = 2.6) { this.flagList = []; for (let i = 0; i < n; i++) { const a = i / n * TAU; const x = Math.cos(a) * r, z = Math.sin(a) * r; A.add(M(GEO.cyl(0.07, 0.07, h, 6), 0xfff1d6, x, h / 2, z)); const f = M(GEO.box(0.9, 0.55, 0.06), colors[i % colors.length], 0, 0, 0); const fg = new THREE.Group(); fg.position.set(x, h - 0.35, z); fg.rotation.y = -a; f.position.x = 0.45; fg.add(f); A.add(fg); this.flagList.push(fg); } }
    waveFlags(t) { if (this.flagList) this.flagList.forEach((f, i) => { f.rotation.z = Math.sin(t * 4 + i) * 0.12; f.rotation.y += Math.sin(t * 2.3 + i) * 0.002; }); }
  }

  class SpinBar extends Mode {
    constructor() { super(); this.key = 'spin'; this.duration = 32; this.safeR = 5.5; this.spawnR = 4.5; this.sky = 0xffc857; this.angle = 0; this.w = 0; }
    build(A) {
      scyl(A, 7.5, 1, 0xff6b6b, 0, -0.5, 0, 36); underside(A, 7.5, 0xc44536);
      const ring = new THREE.Mesh(geo('sring', () => new THREE.RingGeometry(6.6, 7.5, 36)), mat(0xffe66d)); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.01; ring.receiveShadow = true; A.add(ring);
      for (let i = 0; i < 8; i++) { const a = i / 8 * TAU; const w = new THREE.Mesh(GEO.box(0.7, 0.02, 2.2), mat(0xffe66d)); w.position.set(Math.cos(a) * 4.2, 0.02, Math.sin(a) * 4.2); w.rotation.y = -a; w.receiveShadow = true; A.add(w); }
      scyl(A, 0.7, 1.3, 0x2b2d42, 0, 0.65, 0, 16); A.add(M(GEO.sphere(0.5, 10), 0xffd60a, 0, 1.4, 0));
      const bm = new THREE.Group(); const L = 15.6; bm.add(M(GEO.box(L, 0.5, 0.5), 0xffd60a)); for (let i = 0; i < 8; i++) bm.add(M(GEO.box(0.8, 0.52, 0.52), 0x2b2d42, -L / 2 + 1 + i * 2, 0, 0)); for (const s of [-1, 1]) bm.add(M(GEO.sphere(0.42, 10), 0xe63946, s * L / 2, 0, 0)); bm.position.y = 0.62; A.add(bm); this.barMesh = bm;
      const b = new CANNON.Body({ mass: 0, type: CANNON.Body.KINEMATIC, shape: new CANNON.Box(new CANNON.Vec3(L / 2, 0.25, 0.25)), material: matGround }); b.position.set(0, 0.62, 0); b.hazard = true; A.addBody(b); this.bar = b;
      this.flags(A, 7.2, 6, [0xffe66d, 0x2b2d42]);
    }
    reset() { this.t = 0; this.dir = 1; this.w = 0; this.angle = 0; this.nextFlip = rand(9, 13); }
    fixed(step) {
      this.t += step; const target = Math.min(3.4, 1.3 + this.t * 0.075) * this.dir; this.w += (target - this.w) * Math.min(1, 2.2 * step);
      if (this.t > this.nextFlip) { this.dir *= -1; this.nextFlip += rand(8, 12); emit('beep'); emit('toast', 'reverse'); }
      this.bar.angularVelocity.set(0, this.w, 0);
      const q = this.bar.quaternion; this.angle = 2 * Math.atan2(q.y, q.w);
    }
    pack() { return { a: r3(this.angle), w: r2(this.w) }; }
    apply(m) { if (m) { this.netA = +m.a || 0; this.w = +m.w || 0; } }
    frame(dt, t) {
      if (isHost) this.barMesh.quaternion.copy(this.bar.quaternion);
      else { this.angle += this.w * dt; if (this.netA !== undefined) this.angle = lerpAngle(this.angle, this.netA, damp(12, dt)); this.barMesh.rotation.y = this.angle; }
      this.waveFlags(t);
    }
    timeToHit(pig) {
      this.bar.quaternion.vmult(new CANNON.Vec3(1, 0, 0), tmpV); const alpha = Math.atan2(tmpV.z, tmpV.x); const phi = Math.atan2(pig.pos.z, pig.pos.x); const ad = -this.w; if (Math.abs(ad) < 0.05) return 9;
      let d = ((phi - alpha) % Math.PI + Math.PI) % Math.PI; if (ad < 0) d = Math.PI - d; const r = Math.max(1, Math.hypot(pig.pos.x, pig.pos.z)); return (d - 0.85 / r) / Math.abs(ad);
    }
    ai(pig, step) {
      const ai = pig.ai; this.wander(pig, step, 3.6, 5.4); const tth = this.timeToHit(pig);
      if (pig.grounded <= 0) { ai.mx = ai.mz = 0; return; }
      if (tth < 0.16 * ai.react && pig.jumpCd <= 0) { if (rand() > ai.fumble) ai.jump = true; }
      if (rand() < step * 0.15) { const { pig: o, d } = this.nearestPig(pig); if (o && d < 2.5 && pig.dashCd <= 0 && tth > 0.8) { this.steer(pig, o.pos.x, o.pos.z); ai.dash = true; } }
    }
  }

  class Balloon extends Mode {
    constructor() { super(); this.key = 'balloon'; this.duration = 35; this.safeR = 7.5; this.spawnR = 5.5; this.sky = 0x9be7ff; }
    build(A) {
      sbox(A, 18, 1, 18, 0xb388ff, 0, -0.5, 0); underside(A, 10, 0x5e548e);
      const tiles = new THREE.InstancedMesh(GEO.box(1.9, 0.08, 1.9), mat(0xffffff), 81); const d = new THREE.Object3D(); const c = new THREE.Color();
      for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) { d.position.set((i - 4) * 2, 0.03, (j - 4) * 2); d.updateMatrix(); tiles.setMatrixAt(i * 9 + j, d.matrix); tiles.setColorAt(i * 9 + j, c.set((i + j) % 2 ? 0xffc6ff : 0xe0aaff)); } tiles.receiveShadow = true; A.add(tiles);
      for (const [x, z, col] of [[-4.5, -4.5, 0x4cc9f0], [4.5, -4.5, 0xffd60a], [-4.5, 4.5, 0xff5c8a], [4.5, 4.5, 0x7cff9a]]) sbox(A, 1.8, 1.6, 1.8, col, x, 0.8, z, 0.3);
      this.flags(A, 8.6, 8, [0xff5c8a, 0xffd60a, 0x4cc9f0]);
      this.bal = G.pigs.map(p => { const arr = []; const bc = new THREE.Color(p.color).lerp(new THREE.Color(0xffffff), 0.25).getHex(); for (let k = 0; k < 3; k++) { const g = new THREE.Group(); const s = M(GEO.sphere(0.26, 10), bc); s.scale.y = 1.15; g.add(s); const knot = M(GEO.cone(0.06, 0.1, 5), bc, 0, -0.32, 0); knot.rotation.x = Math.PI; g.add(knot); const str = new THREE.Mesh(GEO.cyl(0.015, 0.015, 1, 4), mat(0x2b2d42)); g.add(str); A.add(g); arr.push({ g, str }); } return arr; });
    }
    frame(dt, t) {
      this.waveFlags(t); const up = new THREE.Vector3(0, 1, 0), dir = new THREE.Vector3();
      G.pigs.forEach((p, i) => { const arr = this.bal[i]; for (let k = 0; k < 3; k++) { const { g, str } = arr[k]; const vis = !p.out && p.inWorld && k < p.balloons; g.visible = vis; if (!vis) continue;
        const ox = Math.sin(t * 2 + k * 2.1 + i) * 0.3, oy = 1.55 + k * 0.15 + Math.sin(t * 3 + k) * 0.08, oz = Math.cos(t * 1.7 + k * 2.1 + i) * 0.3 - 0.2;
        g.position.set(p.pos.x + ox, p.pos.y + oy, p.pos.z + oz);
        dir.set(-ox, -(oy - 0.1), -oz); const len = dir.length(); dir.normalize(); str.quaternion.setFromUnitVectors(up, dir); str.scale.y = len; str.position.copy(dir).multiplyScalar(len / 2); } });
    }
    onBump(a, b, dash, rel) { if (!dash && rel < 6.5) return; if (b.balloons > 0 && !b.out) { b.balloons--; a.pops++; const bp = this.bal[b.i][b.balloons].g.position; emit('pop', r2(bp.x), r2(bp.y), r2(bp.z), b.i); if (b.balloons === 0) { this.eliminate(b); emit('toast', 'popped', b.i); } } }
    onFall(pig) { pig.balloons--; if (pig.balloons <= 0) this.eliminate(pig); else { emit('fall', pig.i); pig.leave(); pig.respawn = 1.2; emit('toast', 'balloon', pig.i); } }
    respawnPos() { return { x: rand(-5, 5), y: 5, z: rand(-5, 5) }; }
    ai(pig, step) {
      const ai = pig.ai; ai.think -= step; if (ai.think <= 0) { ai.think = 0.15; ai.target = this.nearestPig(pig).pig; }
      const o = ai.target; if (!o || o.out || !o.inWorld) { this.wander(pig, step); return; }
      const d = Math.hypot(o.pos.x - pig.pos.x, o.pos.z - pig.pos.z);
      if (o.dash > 0 && d < 4 && pig.dashCd > 0.4) { this.steer(pig, pig.pos.x + (o.pos.z - pig.pos.z) * ai.side, pig.pos.z - (o.pos.x - pig.pos.x) * ai.side); return; }
      const lead = 0.25; this.steer(pig, o.pos.x + o.body.velocity.x * lead, o.pos.z + o.body.velocity.z * lead, 0.5);
      if (d < 2.4 && pig.dashCd <= 0 && this.facing(pig, o) < 0.7 && rand() > ai.fumble * 3) ai.dash = true;
      if (Math.abs(pig.pos.x) > 7.2 || Math.abs(pig.pos.z) > 7.2) this.steer(pig, 0, 0);
    }
    rank() { const a = this.alive().sort((x, y) => (y.balloons - x.balloons) || (y.pops - x.pops)); const o = G.pigs.filter(p => p.out).sort((x, y) => (y.outTime - x.outTime)); return a.concat(o); }
    stat(p) { return p.out ? T('stat.out') : '🎈'.repeat(p.balloons); }
  }

  class Crumble extends Mode {
    constructor() { super(); this.key = 'crumble'; this.duration = 35; this.safeR = 8; this.spawnR = 5.5; this.sky = 0xffafcc; }
    build(A) {
      underside(A, 9, 0x8b5a2b, 4); this.tiles = []; const cols = [0xff8fab, 0xfff1c9, 0x8b5a2b, 0xfff1c9, 0xff8fab];
      for (let i = 0; i < 9; i++) for (let j = 0; j < 9; j++) {
        const x = (i - 4) * 2, z = (j - 4) * 2; const ring = Math.max(Math.abs(i - 4), Math.abs(j - 4));
        const m = M(GEO.box(1.92, 0.7, 1.92), cols[ring], x, -0.35, z); A.add(m);
        const b = new CANNON.Body({ mass: 0, material: matGround, shape: new CANNON.Box(new CANNON.Vec3(0.96, 0.35, 0.96)) }); b.position.set(x, -0.35, z); A.addBody(b);
        if (ring === 0) A.add(M(GEO.sphere(0.35, 10), 0xe63946, x, 0.35, z));
        this.tiles.push({ m, b, x, z, i, j, state: 0, t: 0, heat: 0 });
      }
      this.flags(A, 9.4, 8, [0xff8fab, 0xfff1c9]);
    }
    reset() { this.t = 0; this.rc = 4; }
    tileAt(x, z) { const i = Math.round(x / 2) + 4, j = Math.round(z / 2) + 4; if (i < 0 || i > 8 || j < 0 || j > 8) return null; return this.tiles[i * 9 + j]; }
    fixed(step) {
      this.t += step;
      for (const p of G.pigs) { if (p.out || !p.inWorld || p.grounded <= 0) continue; const tl = this.tileAt(p.pos.x, p.pos.z); if (tl && tl.state === 0) { tl.heat += step; if (tl.heat > 0.4) { tl.state = 1; tl.t = 0; emit('crack'); } } }
      this.rc -= step; if (this.rc <= 0) { this.rc = Math.max(0.35, 2.4 - this.t * 0.06); const solid = this.tiles.filter(t => t.state === 0); if (solid.length) { const tl = solid[Math.floor(rand(solid.length))]; tl.state = 1; tl.t = 0; } }
      for (const tl of this.tiles) {
        if (tl.state === 1) { tl.t += step; if (tl.t > 1.2) this.drop(tl); }
        else if (tl.state === 2) { tl.t += step; if (tl.t > 1.4) { tl.state = 3; tl.m.visible = false; } }
      }
    }
    drop(tl) { tl.state = 2; tl.t = 0; G.arena.removeBody(tl.b); emit('tile', tl.x, tl.z); }
    pack() { return { s: this.tiles.map(t => t.state).join('') }; }
    apply(m) {
      const s = m && typeof m.s === 'string' ? m.s : ''; if (s.length !== this.tiles.length) return;
      this.tiles.forEach((tl, k) => { const st = +s[k]; if (st === tl.state) return; if (st === 1 || st === 2) tl.t = 0; if (st === 3) tl.m.visible = false; if (st < 2) { tl.m.visible = true; tl.m.position.y = -0.35; tl.m.rotation.x = 0; } tl.state = st; });
    }
    frame(dt, t) {
      this.waveFlags(t);
      for (const tl of this.tiles) {
        if (tl.state === 1) { tl.m.position.x = tl.x + rand(-0.07, 0.07); tl.m.position.z = tl.z + rand(-0.07, 0.07); tl.m.position.y = -0.35 + rand(-0.04, 0.04); }
        else if (tl.state === 2) { if (!isHost) tl.t += dt; tl.m.position.set(tl.x, -0.35 - 12 * tl.t * tl.t, tl.z); tl.m.rotation.x += dt * 1.5 * (tl.i % 2 ? 1 : -1); }
      }
    }
    ai(pig, step) {
      const ai = pig.ai; ai.think -= step; const cur = this.tileAt(pig.pos.x, pig.pos.z);
      if (ai.think <= 0 || !ai.target || ai.target.state !== 0) {
        ai.think = rand(0.3, 0.6); let best = null, bs = -1e9;
        for (const tl of this.tiles) { if (tl.state !== 0) continue; let nb = 0; for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = this.tiles[(tl.i + di) * 9 + (tl.j + dj)]; if (tl.i + di >= 0 && tl.i + di < 9 && tl.j + dj >= 0 && tl.j + dj < 9 && n && n.state === 0) nb++; }
          const d = Math.hypot(tl.x - pig.pos.x, tl.z - pig.pos.z); const s = -d * 0.9 + nb * 0.9 - Math.max(Math.abs(tl.i - 4), Math.abs(tl.j - 4)) * 0.35 + rand(1.5) - (tl === cur ? 2 : 0); if (s > bs) { bs = s; best = tl; } }
        ai.target = best;
      }
      if (ai.target) { this.steer(pig, ai.target.x, ai.target.z, 0.4); const nx = pig.pos.x + ai.mx * 1.3, nz = pig.pos.z + ai.mz * 1.3; const nt = this.tileAt(nx, nz); if ((!nt || nt.state >= 2) && pig.grounded > 0) ai.jump = true; }
      else this.wander(pig, step);
    }
    stat(p) { return p.out ? T('stat.out') : '🍰'; }
  }

  class Truffle extends Mode {
    constructor() { super(); this.key = 'truffle'; this.duration = 32; this.safeR = 8; this.spawnR = 5.5; this.sky = 0xb5e48c; this.nextId = 1; }
    build(A) {
      scyl(A, 9.5, 1, 0x8d5524, 0, -0.5, 0, 36); underside(A, 9.5, 0x5c3a1e);
      for (let i = 0; i < 28; i++) { const a = i / 28 * TAU; sbox(A, 2.3, 1.3, 0.8, i % 2 ? 0x98d86b : 0x6fbf4a, Math.cos(a) * 9.7, 0.4, Math.sin(a) * 9.7, -a); }
      for (const [x, z] of [[-3, -2.5], [3.5, 2], [0.5, -4.5]]) { const p = new THREE.Mesh(GEO.cyl(1.4, 1.4, 0.04, 18), mat(0x6b4423)); p.position.set(x, 0.02, z); p.receiveShadow = true; A.add(p); }
      for (let i = 0; i < 5; i++) { const a = i / 5 * TAU + 0.4; const x = Math.cos(a) * 11.5, z = Math.sin(a) * 11.5; A.add(M(GEO.cyl(0.3, 0.4, 2.5, 7), 0x6b4423, x, 0.8, z)); A.add(M(GEO.sphere(1.5, 9), [0x4caf50, 0x7cff9a, 0x2e8b57][i % 3], x, 2.8, z)); }
      for (let i = 0; i < 6; i++) { const a = i / 6 * TAU; const x = Math.cos(a) * 6.5, z = Math.sin(a) * 6.5; A.add(M(GEO.cyl(0.12, 0.16, 0.4, 6), 0xfff1d6, x, 0.2, z)); A.add(M(GEO.sphere(0.32, 8), i % 2 ? 0xe63946 : 0xffd60a, x, 0.45, z)); }
      this.items = []; this.A = A;
    }
    reset() { this.items.length = 0; this.spawnT = 0.3; }
    spawnItem(x, y, z, value, age = 0, id = this.nextId++) {
      const g = new THREE.Group(); const gold = value > 1; g.add(M(geo('truf', () => new THREE.IcosahedronGeometry(0.3, 0)), gold ? 0xffd60a : 0x3e2723)); const spark = M(GEO.box(0.12, 0.12, 0.12), gold ? 0xffffff : 0xffd60a, 0, 0.55, 0); g.add(spark); g.position.set(x, y, z); this.A.add(g);
      const it = { id, g, spark, value, age, x, z, vy: age < 0 ? 5 : 0 }; this.items.push(it); return it;
    }
    removeItem(it) { this.A.group.remove(it.g); const i = this.items.indexOf(it); if (i >= 0) this.items.splice(i, 1); }
    fixed(step) {
      this.spawnT -= step; if (this.spawnT <= 0 && this.items.length < 9) { this.spawnT = 0.75; const a = rand(TAU), r = rand(1, 8); this.spawnItem(Math.cos(a) * r, 0.35, Math.sin(a) * r, rand() < 0.12 ? 3 : 1, -0.2); }
      for (let i = this.items.length - 1; i >= 0; i--) {
        const it = this.items[i]; it.age += step; if (it.vy) { it.g.position.y += it.vy * step; it.vy -= 20 * step; if (it.g.position.y < 0.35) { it.g.position.y = 0.35; it.vy = 0; } } if (it.age < 0.3) continue;
        for (const p of G.pigs) { if (p.out || !p.inWorld) continue; if (Math.hypot(p.pos.x - it.g.position.x, p.pos.z - it.g.position.z) < 1 && Math.abs(p.pos.y - it.g.position.y) < 1.4) { p.truffles += it.value; emit('ding', r2(it.g.position.x), r2(it.g.position.y), r2(it.g.position.z), it.value > 1 ? 1 : 0); this.removeItem(it); break; } }
      }
    }
    pack() { return { it: this.items.map(it => [it.id, r2(it.g.position.x), r2(it.g.position.y), r2(it.g.position.z), it.value, r2(it.age)]) }; }
    apply(m) {
      const list = m && Array.isArray(m.it) ? m.it : []; const seen = new Set();
      for (const e of list) {
        if (!Array.isArray(e)) continue; const [id, x, y, z, value, age] = e; seen.add(id);
        let it = this.items.find(q => q.id === id); if (!it) it = this.spawnItem(+x || 0, +y || 0.35, +z || 0, +value || 1, +age || 0, id);
        it.g.position.set(+x || 0, +y || 0.35, +z || 0); it.age = +age || 0; it.vy = 0;
      }
      for (const it of [...this.items]) if (!seen.has(it.id)) this.removeItem(it);
    }
    frame(dt, t) { for (const it of this.items) { if (!isHost) it.age += dt; it.g.rotation.y += dt * 2; it.spark.rotation.y -= dt * 5; it.spark.position.y = 0.55 + Math.sin(t * 5 + it.x) * 0.08; const s = clamp((it.age + 0.4) * 3, 0.1, 1); it.g.scale.setScalar(s); } }
    onBump(a, b, dash) { if (!dash || b.truffles <= 0) return; const n = Math.min(3, b.truffles); b.truffles -= n; for (let k = 0; k < n; k++) { const ang = rand(TAU), r = rand(1.5, 2.5); this.spawnItem(clamp(b.pos.x + Math.cos(ang) * r, -8, 8), b.pos.y + 0.5, clamp(b.pos.z + Math.sin(ang) * r, -8, 8), 1, -0.6); } emit('toast', 'drops', b.i, n); }
    onFall(pig) { emit('fall', pig.i); pig.leave(); pig.respawn = 1; }
    ai(pig, step) {
      const ai = pig.ai; ai.think -= step; if (ai.think <= 0) { ai.think = 0.2; let best = null, bs = 1e9; for (const it of this.items) { const d = Math.hypot(it.g.position.x - pig.pos.x, it.g.position.z - pig.pos.z) / it.value; if (d < bs) { bs = d; best = it; } } ai.target = best; }
      const { pig: o, d } = this.nearestPig(pig, q => q.truffles >= 2); if (o && d < 2.6 && pig.dashCd <= 0 && o.truffles > pig.truffles - 1 && rand() > ai.fumble * 2) { this.steer(pig, o.pos.x, o.pos.z); if (this.facing(pig, o) < 0.8) ai.dash = true; return; }
      if (ai.target && this.items.includes(ai.target)) this.steer(pig, ai.target.g.position.x, ai.target.g.position.z, 0.2); else this.wander(pig, step);
    }
    rank() { return G.pigs.slice().sort((x, y) => (y.truffles - x.truffles) || (x.hits - y.hits)); }
    finished() { return false; }
    stat(p) { return `🍄 ${p.truffles}`; }
  }

  class Throne extends Mode {
    constructor() { super(); this.key = 'throne'; this.duration = 45; this.safeR = 11; this.spawnR = 9; this.sky = 0x7b6cf6; this.finale = true; this.camUp = 1.0; this.camDist = 1.15; this.king = null; this.contested = false; }
    build(A) {
      scyl(A, 13, 1.2, 0x6fcf6f, 0, -0.6, 0, 40); underside(A, 13, 0x5c3a1e, 8);
      const road = new THREE.Mesh(geo('rring', () => new THREE.RingGeometry(7.6, 9, 40)), mat(GOLD)); road.rotation.x = -Math.PI / 2; road.position.y = 0.01; road.receiveShadow = true; A.add(road);
      // hill: square frustum (ConvexPolyhedron) with CCW-from-outside faces
      const bw = 7, tw = 2.4, h = 2.6, hh = h / 2;
      const V = [[-bw, -hh, -bw], [bw, -hh, -bw], [bw, -hh, bw], [-bw, -hh, bw], [-tw, hh, -tw], [tw, hh, -tw], [tw, hh, tw], [-tw, hh, tw]].map(v => new CANNON.Vec3(...v));
      const F = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
      const hb = new CANNON.Body({ mass: 0, material: matGround, shape: new CANNON.ConvexPolyhedron({ vertices: V, faces: F }) }); hb.position.set(0, hh, 0); A.addBody(hb);
      const N = 9; for (let k = 0; k < N; k++) { const y1 = (k + 1) / N * h, w = bw - (bw - tw) * y1 / h; A.add(M(GEO.box(w * 2, h / N, w * 2), k % 2 ? 0xe63946 : 0xc1121f, 0, y1 - h / N / 2, 0)); }
      const cap = new THREE.Mesh(GEO.box(tw * 2 + 0.2, 0.1, tw * 2 + 0.2), mat(GOLD)); cap.position.y = h + 0.04; cap.receiveShadow = true; A.add(cap);
      for (let i = 0; i < 4; i++) { const a = i / 4 * TAU; const s = new THREE.Mesh(GEO.box(1.4, 0.05, 4.9), mat(GOLD)); s.position.set(Math.sin(a) * 4.7, hh + 0.03, Math.cos(a) * 4.7); s.rotation.y = a; s.rotation.x = Math.atan2(h, bw - tw); s.receiveShadow = true; A.add(s); }
      sbox(A, 1.9, 0.5, 1.5, GOLD, 0, h + 0.25, -0.3); sbox(A, 1.9, 2.2, 0.35, GOLD, 0, h + 1.1, -1.2); for (const s of [-1, 1]) sbox(A, 0.3, 0.5, 1.1, GOLD, s * 0.95, h + 0.75, -0.4);
      A.add(M(GEO.box(1.5, 0.14, 1.2), 0xe63946, 0, h + 0.57, -0.25)); A.add(M(GEO.box(1.5, 1.4, 0.1), 0xe63946, 0, h + 1.3, -0.97)); A.add(M(GEO.sphere(0.3, 10), 0xe63946, 0, h + 2.4, -1.2)); for (const s of [-1, 1]) A.add(M(GEO.sphere(0.2, 8), GOLD, s * 0.95, h + 2.2, -1.2));
      this.seat = { x: 0, z: -0.3, y: h + 0.5 };
      this.flags(A, 12.2, 10, G.pigs.map(s => s.color).concat([GOLD]), 3.2);
      const { h: crown } = buildHat('crown'); crown.scale.setScalar(1.3); crown.visible = false; A.add(crown); this.crown = crown;
      for (let i = 0; i < 4; i++) { const a = i / 4 * TAU + Math.PI / 4; A.add(M(GEO.cyl(0.12, 0.12, 2.2, 6), 0xfff1d6, Math.cos(a) * 10.5, 1.1, Math.sin(a) * 10.5)); A.add(M(GEO.sphere(0.35, 8), 0xffb703, Math.cos(a) * 10.5, 2.4, Math.sin(a) * 10.5)); }
    }
    reset() { this.king = null; this.contested = false; this.kingT = 0; for (const p of G.pigs) p.throne = p.bank; }
    camPoints() { return [{ x: 0, y: 2.6, z: 0 }]; }
    fixed(step) {
      const zone = []; for (const p of G.pigs) { if (p.out || !p.inWorld) continue; if (Math.hypot(p.pos.x - this.seat.x, p.pos.z - this.seat.z) < 1.15 && p.pos.y > this.seat.y + 0.65) zone.push(p); }
      if (zone.length === 1) { const k = zone[0]; if (k !== this.king) { this.king = k; this.kingT = 0; emit('fanfare'); emit('toast', 'king', k.i); } k.throne += step; this.kingT += step; this.contested = false; }
      else { this.contested = zone.length > 1; if (this.king && (zone.length === 0 || this.contested)) { this.king = null; if (this.contested) emit('toast', 'contested'); } }
    }
    pack() { return { k: this.king ? this.king.i : -1, c: this.contested ? 1 : 0 }; }
    apply(m) { if (m) { this.king = pigAt(m.k); this.contested = !!m.c; } }
    frame(dt, t) { this.waveFlags(t); const k = this.king; this.crown.visible = !!(k && k.inWorld); if (k) { this.crown.position.set(k.pos.x, k.pos.y + 1.9 + Math.sin(t * 4) * 0.1, k.pos.z); this.crown.rotation.y = t * 2; } }
    onFall(pig) { emit('fall', pig.i); pig.leave(); pig.respawn = 1; }
    respawnPos() { const a = rand(TAU); return { x: Math.cos(a) * 10, y: 5, z: Math.sin(a) * 10 }; }
    ai(pig, step) {
      const ai = pig.ai; const s = this.seat; const ds = Math.hypot(pig.pos.x - s.x, pig.pos.z - s.z); const king = this.king;
      if (king === pig) { const { pig: o, d } = this.nearestPig(pig); if (o && d < 2.6 && pig.dashCd <= 0 && o.pos.y > s.y - 0.5) { this.steer(pig, o.pos.x, o.pos.z); if (this.facing(pig, o) < 0.9) ai.dash = true; return; } this.steer(pig, s.x, s.z, 0.15); return; }
      if (king && !king.out && king.inWorld) { const d = Math.hypot(king.pos.x - pig.pos.x, king.pos.z - pig.pos.z); if (d < 2.8 && pig.pos.y > s.y - 0.6) { this.steer(pig, king.pos.x, king.pos.z); if (pig.dashCd <= 0 && this.facing(pig, king) < 0.8 && rand() > ai.fumble * 2) ai.dash = true; else if (pig.grounded > 0 && rand() < step * 2) ai.jump = true; return; } }
      ai.think -= step; if (ai.think <= 0) { ai.think = rand(0.4, 1); ai.tx = s.x + rand(-0.6, 0.6); ai.tz = s.z + rand(-0.4, 0.6); }
      this.steer(pig, ai.tx, ai.tz, 0.2);
      const sp = Math.hypot(pig.body.velocity.x, pig.body.velocity.z);
      if (pig.grounded > 0 && (ds < 1.8 && pig.pos.y < s.y + 0.6 || sp < 1.5 && ds > 1) && pig.jumpCd <= 0 && rand() < step * 6) ai.jump = true;
      const { pig: o, d } = this.nearestPig(pig); if (o && d < 2 && pig.dashCd <= 0 && rand() < step * 1.5 && this.facing(pig, o) < 0.9) ai.dash = true;
    }
    rank() { return G.pigs.slice().sort((x, y) => (y.throne - x.throne) || (x.hits - y.hits)); }
    finished() { return false; }
    stat(p) { return T('stat.sec', { n: p.throne.toFixed(1) }); }
  }
  const MODE_CLASSES = { spin: SpinBar, balloon: Balloon, crumble: Crumble, truffle: Truffle, throne: Throne }; // keyed by net.js MODES

  /* ---- decor: clouds + sun */
  const clouds = [];
  for (let i = 0; i < 14; i++) {
    const g = new THREE.Group(); const n = 3 + Math.floor(rand(3)); for (let k = 0; k < n; k++) { const m = new THREE.Mesh(GEO.box(rand(1.5, 3.5), rand(0.8, 1.6), rand(1.2, 2.5)), mat(0xffffff)); m.position.set(k * 1.4 - n * 0.7, rand(-0.3, 0.3), rand(-0.6, 0.6)); g.add(m); }
    const a = rand(TAU), r = rand(18, 50); g.position.set(Math.cos(a) * r, rand(7, 20), Math.sin(a) * r); g.userData.v = rand(0.3, 0.9); scene.add(g); clouds.push(g);
  }
  const sunMat = new THREE.MeshBasicMaterial({ color: 0xfff3a0, fog: false }), sunM = new THREE.Mesh(GEO.sphere(4, 12), sunMat); sunM.position.set(60, 55, -90); scene.add(sunM);

  /* ============================================================ camera */
  function updateCamera(dt) {
    const m = G.mode; if (!m) return; const pts = []; for (const p of G.pigs) if (p.inWorld) pts.push(p.pos); const extra = m.camPoints(); if (extra) pts.push(...extra);
    if (!pts.length) pts.push({ x: 0, y: 0, z: 0 });
    let cx = 0, cy = 0, cz = 0; for (const p of pts) { cx += p.x; cy += p.y; cz += p.z; } cx /= pts.length; cy /= pts.length; cz /= pts.length;
    let ext = 3; for (const p of pts) ext = Math.max(ext, Math.hypot(p.x - cx, p.z - cz) + 1);
    const aspect = camera.aspect; let dist = (9 + ext * 1.7) * m.camDist * Math.max(1, 1.25 / aspect);
    dist = clamp(dist, 12, 44);
    CAM.tmp.set(0, m.camUp, 1).normalize().multiplyScalar(dist).add({ x: cx, y: cy * 0.5, z: cz });
    const k = damp(3.5, dt); CAM.target.lerp(new THREE.Vector3(cx, cy * 0.5 + 0.5, cz), k); CAM.pos.lerp(CAM.tmp, k);
    CAM.shake = Math.max(0, CAM.shake - dt * 1.8); const s = CAM.shake * 0.35;
    camera.position.set(CAM.pos.x + rand(-s, s), CAM.pos.y + rand(-s, s), CAM.pos.z + rand(-s, s)); camera.lookAt(CAM.target);
  }

  /* ============================================================ rounds (host drives; a client mirrors from the snapshots) */
  /* the mode resets after the pigs do: resetRound() zeroes p.throne, and the Throne's reset() then seeds it from p.bank */
  function setArena(modeId) {
    if (G.arena) G.arena.dispose(); G.arena = new Arena(); G.mode = new MODE_CLASSES[modeId](); G.mode.build(G.arena); setSky(G.mode.sky);
    G.pigs.forEach((p, i) => { p.resetRound(); const s = G.mode.spawnPos(i); p.place(s.x, s.y, s.z); });
    bumpQueue.length = 0; G.mode.reset();
    CAM.pos.set(0, 14, 18); CAM.target.set(0, 0, 0); CAM.shake = 0;
  }
  function startGame() {
    const n = clamp(Number(session.opts && session.opts.rounds) || 3, 1, MODES.length - 1), R = makeRng(session.seed >>> 0);
    G.plan = shuffleR(R, MODES.slice(0, -1)).slice(0, n).concat(['throne']); G.round = 0; G.winner = -1;
    for (const p of G.pigs) p.bank = 0;
    emit('whistle'); nextRound();
  }
  function nextRound() {
    if (G.round >= G.plan.length) { G.round = 0; }
    setArena(G.plan[G.round]); G.state = 'intro'; G.frozen = true; G.card = CARD_TIME; G.t = 0; G.lastTick = 99; G.winner = -1;
    onRoundStarted();
  }
  /* the HUD and the music for the round in progress: run on every arena change, so a client that joins the round late
     (its first accepted snapshot already says `play`) is not left on the waiting text without music */
  function syncRound() {
    sfx.setMusic(true, G.mode.finale); roundWords();
    dom.title.hidden = true; root.classList.remove('over'); confetti = null;
  }
  function roundWords() { const m = G.mode; dom.round.textContent = m.finale ? T('finaleLine', { name: m.name }) : T('roundLine', { n: G.round + 1, name: m.name }); dom.sub.textContent = m.sub; }
  function onRoundStarted() { syncRound(); showCard('intro'); if (G.mode.finale) sfx.fanfare(); }
  function endRound() {
    const ranking = G.mode.rank(); const w = ranking[0];
    if (G.mode.finale) { showTitle(w); return; }
    const pts = [3, 2, 1, 0]; ranking.forEach((p, i) => { p.bank += pts[i] || 0; });
    G.state = 'result'; G.frozen = true; G.card = 2.4; G.winner = w.i; emit('cheer', w.i);
    onResult();
  }
  function onResult() { if (pigAt(G.winner)) showCard('result'); }
  function showTitle(w) {
    G.state = 'title'; G.frozen = true; G.winner = w.i; emit('sting');
    onTitle();
  }
  function onTitle() {
    const w = pigAt(G.winner); if (!w) return;
    sfx.setMusic(false); dom.card.hidden = true; dom.title.hidden = false; root.classList.add('over'); showMenu(false);
    titleWords(); startConfetti();
  }
  function titleWords() {
    const w = pigAt(G.winner); if (!w) return;
    dom.twin.style.setProperty('--c', hex(w.color));
    dom.twin.innerHTML = `${w.emoji} ${T('title.hogged', { name: esc(w.name) + (w.human ? '' : ' ' + T('title.cpu')) })}<small>${T('title.secs', { n: w.throne.toFixed(1) })}</small>`;
    renderTitleFoot();
  }
  function hostFixedStep(step) {
    G.time += step;
    if (G.state === 'intro') {
      G.card -= step; const n = Math.ceil(G.card / COUNT_STEP); // 3-2-1 over the arena once the round card has had its time
      if (G.card <= 0) { G.state = 'play'; G.frozen = false; G.t = 0; G.lastTick = 99; dom.card.hidden = true; emit('go'); } // lastTick: the countdown's, then the last 5 s
      else if (n <= COUNT_FROM && n < G.lastTick) { G.lastTick = n; emit('count', n); }
    }
    else if (G.state === 'play') {
      G.t += step; const left = G.mode.duration - G.t; const sec = Math.ceil(left); if (sec <= 5 && sec < G.lastTick && sec > 0) { G.lastTick = sec; emit('tick'); }
      if (G.mode.finished() || left <= 0) { endRound(); return; } G.mode.fixed(step);
    }
    else if (G.state === 'result') { G.card -= step; if (G.card <= 0) { G.round++; nextRound(); return; } }
    else if (G.state === 'title') return;
    for (const p of G.pigs) p.fixed(step);
    world.step(STEP);
    for (const c of world.contacts) { let p = null, ny = 0; if (c.bi.pig) { p = c.bi.pig; ny = -c.ni.y; } else if (c.bj.pig) { p = c.bj.pig; ny = c.ni.y; } if (p && ny > 0.5) p.grounded = 3; }
    processBumps();
    for (const p of G.pigs) p.post(step);
  }

  /* ============================================================ networking: the host packs, a client applies + interpolates */
  let seq = 0;
  function packSnapshot() {
    const msg = { t: 's', mid: session.seed >>> 0, q: ++seq, st: STATES.indexOf(G.state), rd: G.round, pl: G.plan.map(id => MODES.indexOf(id)), tm: r2(G.t), cd: r2(G.card), w: G.winner, p: G.pigs.map(packPig), m: G.mode ? G.mode.pack() : null, ev: events };
    events = []; return msg;
  }
  function applySnapshot(m) {
    if (!guard.accept(m)) return;
    const now = nowSec();
    const plan = Array.isArray(m.pl) ? m.pl.map(i => MODES[i | 0]).filter(Boolean) : [], round = clamp(m.rd | 0, 0, Math.max(0, plan.length - 1));
    const modeId = plan[round]; if (!modeId) return;
    const st = STATES[m.st] || 'intro';
    if (modeId !== (G.plan[G.round] || null) || round !== G.round || !G.mode) { G.plan = plan; G.round = round; setArena(modeId); G.state = null; syncRound(); }
    G.t = +m.tm || 0; G.card = +m.cd || 0; G.winner = Number.isInteger(m.w) ? m.w : -1;
    (m.p || []).forEach((e, i) => {
      const p = G.pigs[i], s = unpackPig(e); if (!p || !s) return;
      p.out = s.out; p.dash = s.dash ? 1 : 0; p.grounded = s.grounded ? 3 : 0; p.stun = s.stun ? 1 : 0; p.balloons = s.balloons; p.truffles = s.truffles; p.throne = s.throne; p.bank = s.bank; p.hits = s.hits; p.respawn = s.respawn;
      /* my own dash I may have predicted a moment ago; the host's copy catches up once my `da` arrives */
      p.dashCd = p === me && nowSec() - p.echoDash < 0.3 ? Math.max(p.dashCd, s.dashCd) : s.dashCd;
      if (p.human && !s.human) p.toAI();
      if (s.inWorld !== p.inWorld) { p.inWorld = s.inWorld; p.group.visible = s.inWorld; if (s.inWorld) { p.buf = []; p.body.position.set(s.x, s.y, s.z); } }
      pushSnap(p.buf, { x: s.x, y: s.y, z: s.z, qx: s.qx, qy: s.qy, qz: s.qz, qw: s.qw, vx: s.vx, vy: s.vy, vz: s.vz }, now);
    });
    G.mode.apply(m.m);
    if (st !== G.state) {
      G.state = st; G.frozen = st !== 'play';
      if (st === 'intro') onRoundStarted(); else if (st === 'play') dom.card.hidden = true; else if (st === 'result') onResult(); else if (st === 'title') onTitle();
    }
    for (const ev of Array.isArray(m.ev) ? m.ev : []) if (Array.isArray(ev)) applyEvent(ev);
  }
  const qa = new THREE.Quaternion(), qb = new THREE.Quaternion();
  /* my own pig turns to the stick at once instead of a round trip later (it only ever turns in place, so nothing snaps back);
     stunned or dashing it shows the host's tumble and heading as they are */
  function updateClient(dt, want) {
    if (G.state === 'play') G.t += dt; // smooth between snapshots; every snapshot puts it right
    const rt = nowSec() - INTERP;
    for (const p of G.pigs) {
      p.dashCd = Math.max(0, p.dashCd - dt);
      if (!p.inWorld) continue; const s = sampleSnaps(p.buf, rt); if (!s) continue; const { a, b, f } = s; const body = p.body;
      if (b) { body.position.set(lerp(a.x, b.x, f), lerp(a.y, b.y, f), lerp(a.z, b.z, f)); qa.set(a.qx, a.qy, a.qz, a.qw); qb.set(b.qx, b.qy, b.qz, b.qw); qa.slerp(qb, f); }
      else { const ex = clamp(rt - a.t, 0, 0.2); body.position.set(a.x + a.vx * ex, a.y + a.vy * ex, a.z + a.vz * ex); qa.set(a.qx, a.qy, a.qz, a.qw); }
      body.quaternion.set(qa.x, qa.y, qa.z, qa.w); body.velocity.set(a.vx, a.vy, a.vz);
      if (p === me && want) {
        const hostYaw = 2 * Math.atan2(qa.y, qa.w);
        if (p.stun > 0 || p.dash > 0 || G.frozen) { p.lyaw = hostYaw; continue; }
        const moving = Math.hypot(want.mx, want.mz) > 0.1;
        p.lyaw = lerpAngle(p.lyaw, moving ? Math.atan2(want.mx, want.mz) : hostYaw, damp(moving ? 14 : 6, dt));
        tmpQ.setFromAxisAngle(UPV, p.lyaw); body.quaternion.copy(tmpQ);
      }
    }
  }
  let netAcc = 0, lastSent = null, sinceSent = 0;
  function hostNetTick(dt) {
    if (!online) { events.length = 0; return; }
    netAcc += dt; if (netAcc < 1 / NET_HZ - 0.002) return; netAcc = Math.max(0, netAcc - 1 / NET_HZ);
    send(packSnapshot());
  }
  function clientSendInput(want, dt) {
    sinceSent += dt;
    const changed = !lastSent || lastSent.mx !== want.mx || lastSent.mz !== want.mz || lastSent.jump !== want.jump;
    if ((changed && sinceSent >= 1 / 60) || sinceSent >= 0.4) { lastSent = { ...want }; sinceSent = 0; send({ t: 'in', to: hostId, x: want.mx, y: want.mz, j: want.jump ? 1 : 0 }); }
  }

  /* ============================================================ HUD, cards, toasts, title */
  /* toasts stack (newest at the bottom, at most TOASTS_MAX, the oldest goes first) so a burst of news is not erased; a toast
     with a tag replaces the live one with the same tag (the 3-2-1-GO countdown, the sound toggle) */
  const TOASTS_MAX = 3;
  function toast(text, color = 0xffffff, tag = '') {
    const box = dom.toasts; if (tag) for (const o of box.children) if (o.dataset.tag === tag) o.remove();
    while (box.children.length >= TOASTS_MAX) box.firstElementChild.remove();
    const t = document.createElement('div'); t.className = 'toast stroke'; t.textContent = text; t.style.color = hex(color); if (tag) t.dataset.tag = tag;
    t.addEventListener('animationend', () => t.remove()); box.appendChild(t);
  }
  const clearToasts = () => { dom.toasts.textContent = ''; };
  /* the round card: 'intro' (the minigame, its rule and, on the finale, my head start) or 'result' (the winner and the bonus);
     cardWords() fills it in the current language, so a language switch redraws it without replaying its entrance */
  let cardKind = '';
  function showCard(kind) {
    cardKind = kind; cardWords();
    dom.card.hidden = false; const inner = dom.card.firstElementChild; inner.style.animation = 'none'; void inner.offsetWidth; inner.style.animation = '';
  }
  function cardWords() {
    const m = G.mode; if (!m || !cardKind) return; const who = cardKind === 'result' ? pigAt(G.winner) : null;
    dom.kick.textContent = cardKind === 'result' ? T('card.winner') : m.finale ? T('finale') : T('round', { n: G.round + 1 }); dom.cname.textContent = m.name;
    dom.csub.textContent = cardKind === 'result' ? T('card.bonus') : m.sub + (m.finale && me ? '\n' + (me.bank > 0 ? T('card.headStart', { n: me.bank }) : T('card.headZero')) : '');
    if (who) { dom.who.hidden = false; dom.who.style.setProperty('--c', hex(who.color)); dom.who.textContent = `${who.emoji} ${T('card.wins', { name: who.name })}`; } else dom.who.hidden = true;
  }
  const chips = [], chipCache = [];
  function buildChips() {
    dom.chips.innerHTML = ''; chips.length = 0; chipCache.length = 0;
    for (const p of G.pigs) { const d = document.createElement('div'); d.className = 'chip'; d.style.setProperty('--c', hex(p.color)); d.innerHTML = `<span class="dot"></span><span class="nm"></span><span class="st"></span>`; dom.chips.appendChild(d); chips.push(d); chipCache.push(''); }
  }
  const hudCache = {};
  function syncHud() {
    const m = G.mode; if (!m) return;
    G.pigs.forEach((p, i) => {
      const c = chips[i]; if (!c) return; const nm = p.name + (p.human ? '' : ' 🤖') + (p === me ? ' ' + T('chip.you') : ''); const king = !!(m.king && m.king === p);
      const s = `${nm}|${m.stat(p)}|${p.bank}|${p.out}|${king}`; if (chipCache[i] === s) return; chipCache[i] = s;
      /* the banked bonus shows in the finale too: there it is the head start already counted into the throne seconds */
      c.children[1].textContent = nm; c.children[2].textContent = m.stat(p) + ' · ' + T('chip.bank', { n: p.bank }); c.classList.toggle('out', p.out); c.classList.toggle('king', king); c.classList.toggle('me', p === me);
    });
    const playing = G.state === 'play', left = playing ? Math.max(0, m.duration - G.t) : 0, ts = playing ? String(Math.ceil(left)) : '';
    if (hudCache.timer !== ts) { hudCache.timer = ts; dom.timer.textContent = ts; }
    const hot = playing && left <= 5.5; if (hudCache.hot !== hot) { hudCache.hot = hot; dom.timer.classList.toggle('hot', hot); }
  }
  /* the title card's buttons: the host (and solo) restart or leave; a guest votes for a rematch and may leave the room, and the
     host sees how many guests voted (rematchVotes) */
  let wantRematch = false, rematchIds = [];
  const note = (f, text) => { const d = document.createElement('div'); d.className = 'note'; d.textContent = text; f.appendChild(d); };
  const mkBtn = f => (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn; f.appendChild(b); };
  const rematchLabel = () => T(wantRematch ? 'btn.rematchOn' : 'btn.rematch');
  function toggleRematch() { wantRematch = !wantRematch; hooks.onRematch?.(wantRematch); renderTitleFoot(); if (dom.pause.classList.contains('show')) renderMenu(); }
  function renderTitleFoot() {
    const f = dom.tfoot; f.innerHTML = ''; const btn = mkBtn(f);
    const key = k => touch ? '' : `  (${k})`;
    if (!online) { btn(T('btn.again') + key('R'), 'primary', () => hooks.onRestart?.()); btn(T('btn.menu') + key('ESC'), '', () => hooks.onExit?.()); }
    else if (isHost) {
      btn(T('btn.again') + key('R'), 'primary', () => hooks.onRestart?.()); btn(T('btn.lobby') + key('ESC'), '', () => hooks.onExit?.());
      const n = rematchIds.filter(id => id !== myId).length; if (n) note(f, n === 1 ? T('rematch1') : T('rematchN', { n }));
    }
    else { btn(rematchLabel() + key('R'), wantRematch ? 'primary on' : 'primary', toggleRematch); btn(T('btn.leave'), '', () => hooks.onLeave?.()); note(f, T(wantRematch ? 'foot.voted' : 'foot.wait')); }
  }
  function rematchVotes(ids) { rematchIds = Array.isArray(ids) ? ids.slice() : []; if (session && isHost && G.state === 'title') renderTitleFoot(); }
  /* confetti on the title card (2D canvas) */
  let confetti = null;
  function startConfetti() {
    const c = dom.confetti; c.width = root.clientWidth; c.height = root.clientHeight; confetti = []; const cols = G.pigs.map(p => hex(p.color)).concat(['#ffd166', '#ffffff']);
    for (let i = 0; i < 220; i++) confetti.push({ x: rand(c.width), y: rand(-c.height, 0), vx: rand(-40, 40), vy: rand(80, 220), r: rand(TAU), vr: rand(-4, 4), w: rand(6, 14), h: rand(8, 20), c: cols[i % cols.length] });
  }
  function titleFrame(dt) {
    const c = dom.confetti; if (!confetti) return; if (c.width !== root.clientWidth || c.height !== root.clientHeight) { c.width = root.clientWidth; c.height = root.clientHeight; }
    const x = c.getContext('2d'); x.clearRect(0, 0, c.width, c.height);
    for (const p of confetti) { p.x += p.vx * dt + Math.sin(p.y * 0.02) * 0.8; p.y += p.vy * dt; p.r += p.vr * dt; if (p.y > c.height + 20) { p.y = -20; p.x = rand(c.width); } x.save(); x.translate(p.x, p.y); x.rotate(p.r); x.fillStyle = p.c; x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); x.restore(); }
  }

  /* ============================================================ input: the keyboard, plus the touch controls on a coarse-pointer screen */
  const setSnd = () => { dom.snd.textContent = T(audio.muted ? 'snd.off' : 'snd.on'); };
  const canPlay = () => !!(session && me && G.state === 'play' && !me.out);
  /* a press: the host buffers it for its own pig; a client sends it and, when the press will surely take, plays it at once */
  const canEcho = () => !isHost && canPlay() && me.inWorld && me.stun <= 0 && me.dash <= 0;
  function dashPressed() {
    if (!session || !me) return;
    if (isHost) { me.dashQ = DASH_BUFFER; return; }
    send({ t: 'da', to: hostId });
    if (canEcho() && me.dashCd <= 0) { dashFx(me); me.echoDash = nowSec(); me.dashCd = DASH_CD; }
  }
  function hopPressed() { if (canEcho() && me.grounded > 0 && nowSec() - me.echoHop > ECHO_WINDOW) { hopFx(me); me.echoHop = nowSec(); } }
  const kb = createInput({ KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'jump', ShiftLeft: 'dash', ShiftRight: 'dash', KeyE: 'dash' }, {
    onDown: name => { audio.init(); if (name === 'dash') dashPressed(); else if (name === 'jump') hopPressed(); },
    /* R / ESC are the host's (and solo's) restart and exit; a guest's R votes for a rematch on the title card, its ESC opens the menu (LEAVE ROOM is there) */
    onKey: e => {
      const guest = online && !isHost;
      if (e.code === 'KeyM') { audio.toggle(); setSnd(); toast(T(audio.muted ? 'toast.muted' : 'toast.sound'), 0xffffff, 'snd'); if (dom.pause.classList.contains('show')) renderMenu(); }
      else if (e.code === 'KeyR') { if (!guest) hooks.onRestart?.(); else if (G.state === 'title') toggleRematch(); }
      else if (e.code === 'Escape') { if (!guest) hooks.onExit?.(); else showMenu(!dom.pause.classList.contains('show')); }
    },
  });
  const held = kb.held;
  dom.snd.addEventListener('click', () => { audio.toggle(); setSnd(); });

  const tc = createTouch();
  const shake = el => { el.classList.remove('nope'); void el.offsetWidth; el.classList.add('nope'); };
  for (const el of [dom.hopBtn, dom.dashBtn]) el.addEventListener('animationend', () => el.classList.remove('nope'));
  const stickS = touch ? tc.pad($('[data-pad]'), { range: 60, dead: 6, axes: 2, onDown: () => audio.init() }) : null;
  const hopS = touch ? tc.button(dom.hopBtn, { onDown: () => { audio.init(); if (!canPlay()) shake(dom.hopBtn); else hopPressed(); } }) : null;
  const dashS = touch ? tc.button(dom.dashBtn, { onDown: () => { audio.init(); if (!canPlay()) shake(dom.dashBtn); dashPressed(); } }) : null;
  /* what my pig is told to do this frame: the keys, or the stick and HOP */
  function readWant() {
    let mx = (held.right ? 1 : 0) - (held.left ? 1 : 0), mz = (held.down ? 1 : 0) - (held.up ? 1 : 0), jump = !!held.jump;
    if (touch) { if (!mx && !mz && stickS.held) { mx = r2(stickS.x); mz = r2(stickS.y); } jump = jump || hopS.held; }
    return { mx, mz, jump };
  }
  /* DASH draws its cooldown as a shrinking dark wedge (--cd, 0..1 in twentieths so the style is only touched when it changes) */
  let lastCd = -1;
  function syncTouch() {
    if (!touch) return; const ok = canPlay(); dom.hopBtn.classList.toggle('dim', !ok); dom.dashBtn.classList.toggle('dim', !ok);
    const cd = ok ? Math.ceil(clamp(me.dashCd / DASH_CD, 0, 1) * 20) / 20 : 0; if (cd !== lastCd) { lastCd = cd; dom.dashBtn.style.setProperty('--cd', cd); }
  }

  /* ☰ (and a guest's ESC): a card with sound, language and the ways out; the round keeps running underneath */
  function renderMenu() {
    const f = dom.pauseBtns; f.innerHTML = ''; const btn = mkBtn(f);
    btn(T('btn.resume'), 'primary', () => showMenu(false));
    btn(T(audio.muted ? 'btn.soundOff' : 'btn.soundOn'), '', () => { audio.toggle(); setSnd(); renderMenu(); });
    btn(T('btn.lang'), '', () => nextLang()); // onLang redraws everything, this card included
    if (!online || isHost) { btn(T(!online ? 'btn.restart' : 'btn.again'), '', () => { showMenu(false); hooks.onRestart?.(); }); btn(T(!online ? 'btn.quit' : 'btn.lobby'), '', () => { showMenu(false); hooks.onExit?.(); }); }
    else { btn(rematchLabel(), wantRematch ? 'on' : '', toggleRematch); btn(T('btn.leave'), '', () => { showMenu(false); hooks.onLeave?.(); }); }
  }
  function showMenu(on) { dom.pause.classList.toggle('show', on); if (on) { tc.releaseAll(); renderMenu(); } }
  if (touch) dom.menuBtn.addEventListener('click', () => { audio.init(); showMenu(!dom.pause.classList.contains('show')); });
  dom.pause.addEventListener('click', e => { if (e.target === dom.pause) showMenu(false); });

  /* ============================================================ main loop. The simulation advances by the wall clock (`simAt`): from the frame
     loop while the tab is visible and, for an online host, from a worker timer while it is hidden, so the round goes on for everyone else. */
  let simAt = 0, acc = 0, tAll = 0;
  function step(now) {
    const dt = clamp((now - simAt) / 1000, 0, 0.05); simAt = now;
    const want = readWant();
    if (isHost) { if (me) me.want = want; acc += dt; let n = 0; while (acc >= STEP && n < 4) { hostFixedStep(STEP); acc -= STEP; n++; } if (n === 4) acc = 0; hostNetTick(dt); }
    else { if (me) clientSendInput(want, dt); updateClient(dt, want); }
    return dt;
  }
  const ticker = createTicker(NET_HZ, () => { if (session && online && isHost && document.hidden) step(performance.now()); });
  const loop = createLoop((real, now) => {
    if (!session) return;
    const dt = step(now); tAll += dt;
    if (G.state === 'title') { titleFrame(dt); syncHud(); return; }
    if (!G.mode) return; // a client before its first snapshot
    for (const p of G.pigs) p.frame(dt, tAll);
    if (me && me.marker) me.marker.g.visible = me.inWorld;
    G.mode.frame(dt, tAll);
    FX.update(dt);
    for (const c of clouds) { c.position.x += c.userData.v * dt; if (c.position.x > 60) c.position.x = -60; }
    updateCamera(dt); syncHud(); syncTouch();
    renderer.render(scene, camera);
  });

  /* ============================================================ session API */
  function start(s) {
    session = s; isHost = !!s.isHost; online = !!s.online; hostId = s.hostId; myId = s.myId;
    for (const p of G.pigs) p.dispose(); G.pigs = buildRoster(s).map(slot => new Pig(slot)); me = G.pigs.find(p => p.pid === myId) || null; me?.mark();
    wantRematch = false; rematchIds = []; cardKind = ''; lastCd = -1; clearToasts();
    guard = createSnapGuard(s.seed >>> 0); seq = 0; events = []; netAcc = 0; lastSent = null; sinceSent = 1; acc = 0; simAt = performance.now();
    if (G.arena) { G.arena.dispose(); G.arena = null; } G.mode = null; G.state = null; G.plan = []; G.round = 0; G.t = 0; G.time = 0; G.frozen = true; G.winner = -1; bumpQueue.length = 0;
    for (const k of Object.keys(hudCache)) delete hudCache[k]; buildChips();
    dom.card.hidden = true; dom.title.hidden = true; root.classList.remove('over'); dom.timer.textContent = '';
    words(); showMenu(false); audio.init(); kb.attach(); if (touch) tc.attach(); resize(); loop.start(); if (online && isHost) ticker.start(); else ticker.stop();
    if (isHost) startGame(); else setSky(0x86d1ff);
  }
  /* every word on screen, in the current language: run on start and on every language switch */
  function words() {
    for (const el of root.querySelectorAll('[data-t]')) el.textContent = T(el.dataset.t);
    setSnd(); chipCache.fill('');
    dom.keys.innerHTML = touch || !session ? '' : `<kbd>WASD</kbd> ${T('k.move')} <kbd>SPACE</kbd> ${T('k.hop')} <kbd>SHIFT</kbd>/<kbd>E</kbd> ${T('k.dash')} <kbd>M</kbd> ${T('k.sound')}`
      + (!online ? ` <kbd>R</kbd> ${T('k.restart')} <kbd>ESC</kbd> ${T('k.menu')}` : isHost ? ` <kbd>R</kbd> ${T('k.again')} <kbd>ESC</kbd> ${T('k.lobby')}` : ` <kbd>ESC</kbd> ${T('k.menu')}`);
    if (G.mode) roundWords(); else { dom.round.textContent = T('getReady'); dom.sub.textContent = online && !isHost ? T('waitHost') : ''; }
    if (!dom.card.hidden) cardWords();
    if (!dom.title.hidden) titleWords();
    if (dom.pause.classList.contains('show')) renderMenu();
  }
  const unLang = onLang(() => words());
  words();
  function stop() {
    session = null; kb.detach(); tc.detach(); ticker.stop(); loop.stop(); sfx.setMusic(false); showMenu(false);
    for (const p of G.pigs) p.dispose(); G.pigs = []; me = null; if (G.arena) { G.arena.dispose(); G.arena = null; } G.mode = null; G.state = null; confetti = null;
    dom.card.hidden = true; dom.title.hidden = true;
  }
  function destroy() {
    stop(); unLang(); ticker.dispose(); sfx.dispose(); ro?.disconnect(); removeEventListener('resize', resize);
    FX.dispose(); markDim.dispose(); markLit.dispose(); markArrow.dispose(); for (const g of GEOS.values()) g.dispose(); GEOS.clear(); for (const m of MATS.values()) m.dispose(); MATS.clear(); grad.dispose(); sunMat.dispose();
    renderer.dispose(); renderer.forceContextLoss?.(); root.remove(); mount.innerHTML = ''; unloadCss();
    if (window.__hog === debug) delete window.__hog;
  }
  function playerLeft(pid) { if (!session || !isHost) return; const p = G.pigs.find(q => q.pid === pid); if (p) p.toAI(); } // clients learn it from the next snapshot
  function onNetMessage(msg) {
    if (!session) return;
    switch (msg.t) {
      case 's': if (!isHost && msg.from === hostId) applySnapshot(msg); break;
      case 'in': if (isHost) { const p = G.pigs.find(q => q.pid === msg.from); if (p && p.human) p.want = cleanWish(msg); } break;
      case 'da': if (isHost) { const p = G.pigs.find(q => q.pid === msg.from); if (p && p.human) p.dashQ = true; } break;
    }
  }
  const debug = { G, get me() { return me; }, get session() { return session; }, packSnapshot, applySnapshot, loop, touch: { on: touch, stick: stickS, hop: hopS, dash: dashS, showMenu }, skipCard() { G.card = 0; } };
  window.__hog = debug;
  return { start, stop, destroy, onNetMessage, playerLeft, rematchVotes, debug };
}
