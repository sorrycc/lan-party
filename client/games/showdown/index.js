/* Sundown Showdown - a desert brawl: eleven brawlers to pick from (an attack, a super and a passive each), power cubes, tall grass, poison gas, last one standing.
   Game module for the LAN party shell; the contract is documented at the top of games/kart/index.js.

   Up to 8 players share one showdown of ten: the room's players take the first slots (sorted by id, in their avatar's
   colour), CPU brawlers fill the rest when the host leaves "fill with CPU" on. Every round starts with everybody
   picking a brawler (20 seconds online, or until all are locked in), then a countdown, then the fight: break power
   boxes for cubes (+400 health and +10% damage each), hide in tall grass, charge the super by dealing damage and keep
   out of the gas as it closes in while day turns to night (the clock at the top says when it moves next, and an arrow on the
   screen's edge points the way back from out in it). A drone under the fight climbs with every closing of the gas, and a
   heartbeat joins it when three are left. A dead player watches whoever beat them, and A / D (or ◀ ▶) switch to anyone standing.
   CPU brawlers step out of a bomb's marked landing spot, the better ones sooner and more often.

   Words: strings.js (Chinese by default), redrawn on a language change (words()). A guest's result card and ☰ menu (Esc on a
   keyboard) ask for a rematch (hooks.onRematch) or leave the room (hooks.onLeave); the host's card shows rematchVotes().

   Netcode: host-authoritative. The host runs sim.js (every body, bullet, bomb, cube, the gas and the CPU brains) and
   sends 30 Hz `s` snapshots (net.js: the packed brawlers, the gas and the events since the last one). Clients send their
   stick, aim and FIRE as numbered `in` messages plus one `fi` / `su` per shot released from a touch stick, render
   everyone else interpolated a little in the past, and predict their own body with the same movement code
   (map.js moveBy): each snapshot puts it where the host has it and replays the last `lag` seconds of the player's own
   stick on top, the correction hidden in a decaying offset. The arena comes from the round's seed (map.js), so only
   what breaks travels. Everything visible or audible goes through sim events -> applyEvent(), so the host and the
   clients produce the same particles, numbers and sounds; bullets and bombs fly on every machine from their launch
   event. An online host keeps simulating from a worker timer while its tab is hidden.

   Touch screens (core/touch.js): twin sticks. The left part of the screen is the move stick; FIRE under the right
   thumb is an aim stick (drag to aim, release to shoot; a tap shoots at the nearest enemy; drag back to the middle to
   cancel) and SUPER next to it works the same once it is charged. ☰ opens a menu card, a phone held upright is asked
   to rotate, and rendering drops the bloom pass, antialiasing, half the lantern lights and some grass. */
import * as THREE from 'three';
import { clamp, lerp } from '../../core/math.js';
import { esc, hex, loadStylesheet } from '../../core/ui.js';
import { createInput } from '../../core/input.js';
import { createTouch, isCoarse } from '../../core/touch.js';
import { createLoop } from '../../core/loop.js';
import { createTicker } from '../../core/ticker.js';
import { createQuality } from '../../core/quality.js';
import { nowSec, pushSnap, sampleSnaps } from '../../core/interp.js';
import { T, N, HALF, E, STONE, CRATE, WATER, GRASS, BOX, WALL, ti, wx, blocksShot, makeMap } from './map.js';
import { CLASSES, BULLETS, GAS_R, STEP, CUBE_FLY, createSim, angDiff, hiddenFrom, statBars, moveMul } from './sim.js';
import { makeT, onLang, nextLang } from '../../core/i18n.js';
import { STR } from './strings.js';
import { buildRoster, packBrawler, unpackBrawler, createSnapGuard, cleanInput, cleanShot, cleanPick, STATES } from './net.js';

const TX = makeT(STR); // the words (`T` is the tile size)
const CJK = '"PingFang SC","Hiragino Sans GB","Noto Sans SC","Microsoft YaHei"'; // canvas text falls back to these for Chinese
const NET_HZ = 30, INTERP = 0.08, MINE = 0x38c8ff, FOE = 0xff4444, PICK_KEY = 'lan_showdown_brawler';
const R = Math.random, RR = (a, b) => a + R() * (b - a);
const smooth = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const r2 = v => Math.round(v * 100) / 100;

/* `data-t` elements hold one word each from strings.js, filled in (and again on a language change) by words() */
const HTML = `
<canvas class="gl"></canvas><canvas class="ov"></canvas>
<div class="hud" data-hud hidden>
  <div class="vign" data-vign></div>
  <div class="alive stroke"><span>☠ <em data-alive>10</em> <span data-t="left"></span></span><span class="cube">◆ <span data-cubes>0</span></span><span>⚔ <span data-kills>0</span></span></div>
  <div class="clock stroke"><span data-clock></span><span class="gast" data-gast></span></div>
  <div class="feed" data-feed></div>
  <div class="banner stroke" data-banner data-t="gasBanner"></div>
  <div class="count stroke" data-count></div>
  <div class="spec stroke" data-spec hidden></div>
  <div class="bottom"><div class="ammo" data-ammo><i><u></u></i><i><u></u></i><i><u></u></i></div><div class="hpbar" data-hp><u></u><span class="stroke"></span></div><div class="keys" data-keys></div></div>
  <div class="super" data-super><span class="stroke"></span></div>
</div>
<div class="specnav" data-specnav hidden><button class="btn" type="button" data-sprev>◀</button><button class="btn" type="button" data-snext>▶</button></div>
<div class="ctl pad" data-pad><div class="ring"><div class="knob"></div></div><div class="lbl" data-t="dragMove"></div></div>
<div class="ctl stick fire" data-fire><div class="knob"></div><b data-t="fire"></b></div>
<div class="ctl stick sup" data-sup><div class="knob"></div><b data-t="superBtn"></b></div>
<div class="ctl menu-btn" data-menu>☰</div>
<div class="pick" data-pick>
  <div class="title stroke"><span data-t="title"></span><span data-t="pickYours"></span></div>
  <div class="cards" data-cards></div>
  <div class="pinfo" data-pinfo></div>
  <button class="btn primary" type="button" data-lock></button>
  <div class="pstat" data-pstat></div>
</div>
<div class="end" data-end hidden><div class="in"><div class="endT stroke" data-endt></div><div class="endR stroke" data-endr></div><table data-table></table><div class="votes" data-votes hidden></div><div class="foot" data-foot></div></div></div>
<div class="overlay pause" data-pause><div class="mcard"><h1 data-t="menu"></h1><div data-pause-btns></div></div></div>
<div class="overlay rotate"><div><div class="phone">📱</div><span data-t="rotate"></span><small data-t="rotateSub"></small></div></div>`;

/* ============================================================ sound: the original's little synth on the shell's shared AudioContext,
   and a tension bed under the fight (music()): a low drone that climbs two semitones, opens up and grows louder each time the
   gas closes in, and a heartbeat once three or fewer are left, quicker the fewer. The drone is two detuned saws through a
   breathing lowpass on its own bus; the heartbeat is scheduled a little ahead from a timer, like hog's sequencer, and while
   muted or not wanted its clock just keeps up with the audio clock, so no beats pile up to burst out on unmute. */
function createSfx(audio) {
  let noiseBuf = null, bus = null, drone = null, hbNext = 0, hbTimer = 0; const mus = { on: false, stage: -1, left: 99 };
  const off = audio.whenReady(ctx => {
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    if (!bus) { bus = ctx.createGain(); bus.gain.value = 0; bus.connect(audio.master); } if (!hbTimer) hbTimer = setInterval(heartbeat, 100);
  });
  function tone(f, dur, type = 'square', vol = .2, f2 = null, delay = 0) {
    const ctx = audio.ctx; if (!ctx || audio.muted || vol < .004) return; const t = ctx.currentTime + delay, o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.001, t + dur); o.connect(g); g.connect(audio.master); o.start(t); o.stop(t + dur + .02);
  }
  function noise(dur, vol = .3, freq = 1200, f2 = null, delay = 0) {
    const ctx = audio.ctx; if (!ctx || !noiseBuf || audio.muted || vol < .004) return; const t = ctx.currentTime + delay, s = ctx.createBufferSource(), g = ctx.createGain(), fl = ctx.createBiquadFilter();
    s.buffer = noiseBuf; s.loop = true; fl.type = 'lowpass'; fl.frequency.setValueAtTime(freq, t); if (f2) fl.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.001, t + dur); s.connect(fl); fl.connect(g); g.connect(audio.master); s.start(t, Math.random()); s.stop(t + dur + .02);
  }
  function tuneDrone(ctx) {
    const t = ctx.currentTime, st = Math.max(0, mus.stage), f = 73.4 * 2 ** (st * 2 / 12); // D2, then up a tone a stage
    drone.o1.frequency.setTargetAtTime(f, t, .9); drone.o2.frequency.setTargetAtTime(f * 1.5 * 1.006, t, .9); drone.f.frequency.setTargetAtTime(260 + st * 110, t, .9);
    drone.lfoG.gain.setTargetAtTime(90 + st * 30, t, .9); bus.gain.setTargetAtTime(.05 + st * .016, t, 1.2);
  }
  function startDrone(ctx) {
    if (drone) return; const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), f = ctx.createBiquadFilter(), lfo = ctx.createOscillator(), lfoG = ctx.createGain(), g = ctx.createGain();
    o1.type = o2.type = 'sawtooth'; f.type = 'lowpass'; f.Q.value = 4; lfo.frequency.value = .18; g.gain.value = .5;
    lfo.connect(lfoG); lfoG.connect(f.frequency); o1.connect(f); o2.connect(f); f.connect(g); g.connect(bus); for (const o of [o1, o2, lfo]) o.start();
    drone = { o1, o2, f, lfo, lfoG, g }; mus.stage = -1;
  }
  function stopDrone() {
    const ctx = audio.ctx; if (!drone || !ctx) return; const d = drone, t = ctx.currentTime; drone = null;
    bus.gain.cancelScheduledValues(t); bus.gain.setTargetAtTime(0, t, .35); for (const o of [d.o1, d.o2, d.lfo]) o.stop(t + 1.6); setTimeout(() => d.g.disconnect(), 1800);
  }
  function heartbeat() {
    const ctx = audio.ctx; if (!ctx) return; const now = ctx.currentTime;
    if (!mus.on || mus.left > 3 || mus.left < 2 || audio.muted) { hbNext = now + .1; return; }
    const period = 60 / (mus.left === 2 ? 104 : 84); if (hbNext < now) hbNext = now + .05;
    while (hbNext < now + .3) { const d = hbNext - now; tone(64, .18, 'sine', .55, 36, d); tone(56, .15, 'sine', .38, 32, d + .19); hbNext += period; }
  }
  /* the tension bed, told every frame: is a fight on, which gas stage, how many are left */
  function music(on, stage, left) {
    const ctx = audio.ctx; if (!ctx || !bus) return; mus.left = left;
    if (on !== mus.on) { mus.on = on; if (on) startDrone(ctx); else stopDrone(); }
    if (on && drone && stage !== mus.stage) { mus.stage = stage; tuneDrone(ctx); }
  }
  return {
    music,
    dispose: () => { off(); mus.on = false; stopDrone(); clearInterval(hbTimer); hbTimer = 0; if (bus) setTimeout(() => bus.disconnect(), 1800); },
    shotgun: v => { noise(.16, .5 * v, 2600, 300); tone(140, .12, 'sawtooth', .2 * v, 50); },
    rifle: v => { noise(.09, .35 * v, 5000, 900); tone(900, .14, 'square', .16 * v, 160); },
    lob: v => { tone(260, .22, 'sine', .25 * v, 520); noise(.08, .15 * v, 900); },
    swing: v => { noise(.16, .4 * v, 700, 2400); tone(110, .12, 'triangle', .25 * v, 60); },
    pistol: v => { noise(.07, .32 * v, 4200, 700); tone(520, .08, 'square', .14 * v, 140); },
    knife: v => { noise(.07, .22 * v, 6000, 2500); tone(1400, .06, 'triangle', .1 * v, 700); },
    flame: v => { noise(.28, .3 * v, 900, 2600); },
    ice: v => { tone(1500, .16, 'sine', .14 * v, 700); noise(.08, .18 * v, 7000, 3000); },
    zap: v => { tone(880, .1, 'sawtooth', .13 * v, 220); noise(.05, .16 * v, 5000); },
    freeze: v => { tone(2000, .5, 'sine', .2 * v, 300); noise(.35, .3 * v, 8000, 1200); },
    hooked: v => { tone(200, .18, 'sawtooth', .25 * v, 90); noise(.12, .3 * v, 1800, 400); },
    vanish: v => { noise(.4, .25 * v, 3000, 200); tone(600, .3, 'sine', .12 * v, 150); },
    build: v => { tone(330, .08, 'square', .16 * v); tone(440, .08, 'square', .16 * v, null, .08); noise(.1, .2 * v, 2200, 600, .16); },
    hit: v => { tone(320, .07, 'square', .16 * v, 120); noise(.05, .2 * v, 3000); },
    boom: v => { noise(.5, .7 * v, 1400, 60); tone(90, .4, 'sine', .5 * v, 30); },
    crate: v => { noise(.2, .4 * v, 1800, 200); tone(180, .1, 'square', .12 * v, 70); },
    pickup: v => { tone(660, .08, 'square', .16 * v); tone(990, .1, 'square', .16 * v, null, .07); tone(1320, .16, 'square', .16 * v, null, .14); },
    die: v => { tone(440, .5, 'sawtooth', .25 * v, 55); noise(.4, .35 * v, 1500, 100); },
    super: v => { tone(220, .4, 'sawtooth', .25 * v, 880); noise(.4, .3 * v, 400, 5000); },
    ready: () => { tone(523, .1, 'square', .14); tone(784, .1, 'square', .14, null, .09); tone(1046, .2, 'square', .14, null, .18); },
    empty: () => tone(150, .06, 'square', .1),
    beep: () => tone(520, .18, 'square', .22),
    go: () => { tone(784, .5, 'square', .25); tone(1046, .5, 'square', .2); noise(.4, .2, 5000); },
    warn: () => { for (let i = 0; i < 3; i++) tone(300, .22, 'sawtooth', .2, 240, i * .3); },
    win: () => [523, 659, 784, 1046, 1318].forEach((f, i) => tone(f, .3, 'square', .2, null, i * .13)),
    lose: () => [392, 349, 311, 233].forEach((f, i) => tone(f, .4, 'sawtooth', .18, null, i * .2)),
    click: () => tone(700, .05, 'square', .12, 900),
  };
}

export async function create({ mount, audio, send, hooks }) {
  const unloadCss = await loadStylesheet('/games/showdown/showdown.css');
  const touch = isCoarse(); // phones and tablets: twin sticks and ☰ appear, the keyboard line goes, and rendering gets lighter
  const root = document.createElement('div'); root.className = 'showdown' + (touch ? ' touch' : ''); root.innerHTML = HTML; mount.appendChild(root);
  const $ = sel => root.querySelector(sel);
  const dom = { hud: $('[data-hud]'), vign: $('[data-vign]'), alive: $('[data-alive]'), cubes: $('[data-cubes]'), kills: $('[data-kills]'), clock: $('[data-clock]'), gast: $('[data-gast]'), feed: $('[data-feed]'), banner: $('[data-banner]'),
    count: $('[data-count]'), spec: $('[data-spec]'), ammo: [...$('[data-ammo]').children], hp: $('[data-hp]'), keys: $('[data-keys]'), sup: $('[data-super]'), pick: $('[data-pick]'), cards: $('[data-cards]'), pinfo: $('[data-pinfo]'), lock: $('[data-lock]'),
    pstat: $('[data-pstat]'), end: $('[data-end]'), endT: $('[data-endt]'), endR: $('[data-endr]'), table: $('[data-table]'), foot: $('[data-foot]'), pad: $('[data-pad]'), fire: $('[data-fire]'), supStick: $('[data-sup]'),
    menuBtn: $('[data-menu]'), pause: $('[data-pause]'), pauseBtns: $('[data-pause-btns]'), votes: $('[data-votes]'), specnav: $('[data-specnav]') };
  const sfx = createSfx(audio);

  /* ============================================================ renderer / scene */
  const canvas = $('.gl'), ov = $('.ov'), octx = ov.getContext('2d');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: !touch, powerPreference: 'high-performance' });
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = touch ? THREE.PCFShadowMap : THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.toneMappingExposure = .95;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(0xe8b877); scene.fog = new THREE.Fog(0xe8b877, 60, 150);
  const camera = new THREE.PerspectiveCamera(36, 1, 1, 400);
  /* the glow (bloom) is a desktop luxury: three full-screen passes are too much to ask of a phone, and without them the
     over-bright colours that feed it would only burn out to white, so they are toned down instead (glow()) */
  let composer = null, bloom = null;
  if (!touch) {
    try {
      const [{ EffectComposer }, { RenderPass }, { UnrealBloomPass }, { OutputPass }] = await Promise.all(['EffectComposer', 'RenderPass', 'UnrealBloomPass', 'OutputPass'].map(n => import(`three/addons/postprocessing/${n}.js`)));
      composer = new EffectComposer(renderer); composer.addPass(new RenderPass(scene, camera));
      bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), .8, .6, 1.0); composer.addPass(bloom); composer.addPass(new OutputPass());
    } catch (e) { console.warn('Sundown Showdown: no bloom', e); composer = bloom = null; }
  }
  /* the picture gives way before the frame rate does: a busy main thread (a 1000 Hz mouse is enough) on top of a full frame
     stutters, so long frames first drop the bloom and some pixels, then the shadow map; full-rate frames bring them back */
  const QUALITY = [{ bloom: true, dpr: 1.5, shadow: 2048 }, { bloom: false, dpr: 1.25, shadow: 2048 }, { bloom: false, dpr: 1, shadow: 1024 }];
  const quality = createQuality({ levels: QUALITY.length, onChange: applyQuality });
  const bloomOn = () => !!composer && QUALITY[quality.level].bloom;
  const glow = k => bloomOn() || k <= 1 ? k : 1 + (k - 1) * .12;
  const view = { w: 1, h: 1, dpr: 1, left: 0, top: 0, tall: 1 };
  /* one fit() sizes the renderer, the bloom, the camera and the overlay canvas together, from the stage and not the window */
  function fit() {
    const w = root.clientWidth || innerWidth, h = root.clientHeight || innerHeight, rect = root.getBoundingClientRect();
    view.w = w; view.h = h; view.left = rect.left; view.top = rect.top; view.dpr = Math.min(window.devicePixelRatio || 1, QUALITY[quality.level].dpr);
    renderer.setPixelRatio(view.dpr); renderer.setSize(w, h, false); if (composer) { composer.setPixelRatio(view.dpr); composer.setSize(w, h); }
    camera.aspect = w / h; camera.updateProjectionMatrix(); view.tall = clamp(1.45 / camera.aspect, 1, 1.9); // an upright screen is narrow: pull the camera back so the sides stay in view
    ov.width = Math.round(w * view.dpr); ov.height = Math.round(h * view.dpr);
  }
  function applyQuality() {
    const q = QUALITY[quality.level], size = touch ? Math.min(1024, q.shadow) : q.shadow;
    if (sun.shadow.mapSize.x !== size) { sun.shadow.mapSize.set(size, size); sun.shadow.map?.dispose(); sun.shadow.map = null; }
    cubeMat.color.set(0x35ff8a).multiplyScalar(glow(2.2)); fit(); // the one glowing colour that is not set again every frame or every shot
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null; ro?.observe(root); addEventListener('resize', fit); fit();

  const hemi = new THREE.HemisphereLight(0xfff1d0, 0xc98a4b, 1.1); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d8, 2.5); sun.castShadow = true; sun.shadow.mapSize.set(touch ? 1024 : 2048, touch ? 1024 : 2048);
  { const sc = sun.shadow.camera; sc.left = -34; sc.right = 34; sc.top = 34; sc.bottom = -34; sc.near = 1; sc.far = 160; }
  sun.shadow.bias = -.0004; sun.shadow.normalBias = .05; sun.shadow.radius = 4; scene.add(sun, sun.target);
  const moon = new THREE.DirectionalLight(0x6f8cff, 0); moon.position.set(-30, 60, -20); scene.add(moon);
  const LIGHTS = []; for (let i = 0; i < (touch ? 3 : 6); i++) { const p = new THREE.PointLight(0xffa040, 0, 15, 1.6); p.position.y = 3.4; scene.add(p); LIGHTS.push(p); }
  const myLamp = new THREE.PointLight(0xffc070, 0, 13, 1.5); scene.add(myLamp);

  /* ---- procedural textures */
  function canvasTex(size, draw, repeat) {
    const c = document.createElement('canvas'); c.width = c.height = size; draw(c.getContext('2d'), size);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repeat, repeat); } return t;
  }
  const sandTex = canvasTex(512, (g, s) => {
    g.fillStyle = '#dfa458'; g.fillRect(0, 0, s, s);
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) { g.fillStyle = (i + j) % 2 ? 'rgba(255,225,160,.13)' : 'rgba(170,100,40,.08)'; g.fillRect(i * s / 4 + 2, j * s / 4 + 2, s / 4 - 4, s / 4 - 4); }
    for (let k = 0; k < 900; k++) { g.fillStyle = R() < .5 ? 'rgba(140,85,35,.16)' : 'rgba(255,240,200,.2)'; g.beginPath(); g.arc(R() * s, R() * s, RR(1, 3.5), 0, 7); g.fill(); }
    g.strokeStyle = 'rgba(150,95,45,.18)'; g.lineWidth = 3; for (let k = 0; k < 14; k++) { const x = R() * s, y = R() * s; g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 30, y - 8, x + 60, y); g.stroke(); }
  }, N / 4);
  const crateTex = canvasTex(128, (g, s) => {
    g.fillStyle = '#b9772f'; g.fillRect(0, 0, s, s); g.fillStyle = '#a5641f'; for (let k = 0; k < 4; k++) g.fillRect(0, k * 32 + 29, s, 3);
    g.strokeStyle = '#6e3d12'; g.lineWidth = 16; g.strokeRect(8, 8, s - 16, s - 16); g.lineWidth = 12; g.beginPath(); g.moveTo(10, 10); g.lineTo(s - 10, s - 10); g.stroke();
    g.fillStyle = '#3d2208'; for (const [x, y] of [[14, 14], [s - 14, 14], [14, s - 14], [s - 14, s - 14]]) { g.beginPath(); g.arc(x, y, 4, 0, 7); g.fill(); }
  });
  const diamond = (g, a, b) => { g.beginPath(); g.moveTo(64, a); g.lineTo(b, 64); g.lineTo(64, b); g.lineTo(a, 64); g.fill(); };
  const boxTex = canvasTex(128, (g, s) => { g.fillStyle = '#2f6d8f'; g.fillRect(0, 0, s, s); g.strokeStyle = '#173a52'; g.lineWidth = 14; g.strokeRect(7, 7, s - 14, s - 14); g.fillStyle = '#173a52'; diamond(g, 22, 106); g.fillStyle = '#fff'; diamond(g, 34, 94); });
  const boxEmis = canvasTex(128, (g, s) => { g.fillStyle = '#000'; g.fillRect(0, 0, s, s); g.fillStyle = '#fff'; diamond(g, 34, 94); });

  /* ---- the arena's meshes, rebuilt from the map at every start() */
  const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SC = new THREE.Vector3(), COL = new THREE.Color(), EUL = new THREE.Euler();
  const setInst = (m, k, x, y, z, sx, sy, sz, ry = 0) => { Q.setFromEuler(EUL.set(0, ry, 0)); M4.compose(V.set(x, y, z), Q, SC.set(sx, sy, sz)); m.setMatrixAt(k, M4); };
  const postMat = new THREE.MeshStandardMaterial({ color: 0x3a2a1c, flatShading: true });
  const geoCache = {}, geo = (k, f) => geoCache[k] || (geoCache[k] = f());
  const unitBox = geo('box', () => new THREE.BoxGeometry(1, 1, 1));
  const shared = new Set([postMat, unitBox]); // survive a rebuild of the world; destroy() frees them
  const grassU = { value: 0 };
  let map = null, world = null, crateMesh = null, waterMat = null, gasMesh = null, gasWall = null;
  const crateIdx = new Map(), lanterns = [], boxV = [];
  function disposeGroup(g) { g.traverse(o => { if (o.geometry && !shared.has(o.geometry) && !Object.values(geoCache).includes(o.geometry)) o.geometry.dispose(); for (const m of [].concat(o.material || [])) if (!shared.has(m)) m.dispose(); }); }
  function addLantern(x, y, z, big) {
    const gp = new THREE.Group(), post = new THREE.Mesh(geo('post', () => new THREE.CylinderGeometry(.09, .12, 1, 5)), postMat); post.position.y = .5; post.castShadow = true;
    const lamp = new THREE.Mesh(geo('lamp', () => new THREE.BoxGeometry(.42, .5, .42)), new THREE.MeshBasicMaterial({ color: 0xffb040, toneMapped: false })); lamp.position.y = 1.2;
    const roof = new THREE.Mesh(geo('roof', () => new THREE.ConeGeometry(.42, .3, 4)), postMat); roof.position.y = 1.6; roof.rotation.y = Math.PI / 4;
    gp.add(post, lamp, roof); gp.position.set(x, y, z); if (big) gp.scale.setScalar(1.5); world.add(gp); lanterns.push({ x, y: y + 1.2, z, lamp, ph: R() * 9 });
  }
  function buildWorld() {
    if (world) { scene.remove(world); disposeGroup(world); }
    world = new THREE.Group(); scene.add(world); crateIdx.clear(); lanterns.length = 0; boxV.length = 0;
    const tiles = map.tiles, cnt = {}; for (let k = 0; k < N * N; k++) cnt[tiles[k]] = (cnt[tiles[k]] || 0) + 1;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(N * T, N * T), new THREE.MeshStandardMaterial({ map: sandTex, roughness: 1 })); ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true; world.add(ground);
    const far = new THREE.Mesh(new THREE.PlaneGeometry(600, 600), new THREE.MeshStandardMaterial({ color: 0xd9a561, roughness: 1 })); far.rotation.x = -Math.PI / 2; far.position.y = -.05; far.receiveShadow = true; world.add(far);
    const nS = (cnt[STONE] || 0) + (cnt[WALL] || 0), nW = cnt[WATER] || 0, blades = touch ? 5 : 8, nG = (cnt[GRASS] || 0) * blades;
    const stone = new THREE.InstancedMesh(unitBox, new THREE.MeshStandardMaterial({ roughness: .95, flatShading: true }), nS), cap = new THREE.InstancedMesh(unitBox, new THREE.MeshStandardMaterial({ roughness: .9, flatShading: true }), nS);
    stone.castShadow = stone.receiveShadow = cap.castShadow = cap.receiveShadow = true;
    crateMesh = new THREE.InstancedMesh(unitBox, new THREE.MeshStandardMaterial({ map: crateTex, roughness: .85 }), cnt[CRATE] || 0); crateMesh.castShadow = crateMesh.receiveShadow = true;
    waterMat = new THREE.MeshStandardMaterial({ color: 0x1f9fd8, roughness: .15, metalness: .2, emissive: 0x0a4a7a, emissiveIntensity: .5, transparent: true, opacity: .92 });
    const water = new THREE.InstancedMesh(unitBox, waterMat, nW); water.receiveShadow = true;
    const rim = new THREE.InstancedMesh(unitBox, new THREE.MeshStandardMaterial({ color: 0x9c6a35, roughness: 1 }), nW); rim.receiveShadow = true;
    const bladeGeo = new THREE.ConeGeometry(.5, 1, 4, 1); bladeGeo.translate(0, .5, 0);
    const grassMat = new THREE.MeshStandardMaterial({ roughness: .9, flatShading: true });
    grassMat.onBeforeCompile = sh => { // the blades sway in the vertex shader, each by its own place in the field
      sh.uniforms.uT = grassU;
      sh.vertexShader = 'uniform float uT;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        float ph=instanceMatrix[3].x*.6+instanceMatrix[3].z*.45;
        transformed.x+=sin(uT*1.9+ph)*.22*position.y;transformed.z+=cos(uT*1.4+ph*1.3)*.16*position.y;
        #endif`);
    };
    const grass = new THREE.InstancedMesh(bladeGeo, grassMat, nG); grass.receiveShadow = true;
    const grassBase = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.MeshStandardMaterial({ color: 0x4f9a2c, roughness: 1 }), cnt[GRASS] || 0); grassBase.receiveShadow = true;
    let s = 0, c = 0, w = 0, g = 0, gb = 0;
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) {
      const t = tiles[ti(i, j)], x = wx(i), z = wx(j);
      if (t === STONE || t === WALL) {
        const h = t === WALL ? RR(3, 4.2) : RR(2, 2.7);
        setInst(stone, s, x, h / 2, z, T, h, T); COL.setHSL(t === WALL ? .06 : .08 + R() * .02, t === WALL ? .45 : .2, t === WALL ? RR(.34, .4) : RR(.4, .47)); stone.setColorAt(s, COL);
        setInst(cap, s, x, h + .12, z, T * .86, .3, T * .86); COL.offsetHSL(0, 0, .07); cap.setColorAt(s, COL); s++;
        if (t === STONE && R() < .16 && lanterns.length < 14) addLantern(x, h + .27, z);
      } else if (t === CRATE) { setInst(crateMesh, c, x, .925, z, 1.8, 1.85, 1.8, RR(-.08, .08)); COL.setHSL(.08, .1, RR(.85, 1)); crateMesh.setColorAt(c, COL); crateIdx.set(ti(i, j), c); c++; }
      else if (t === WATER) { setInst(water, w, x, -.14, z, T, .3, T); setInst(rim, w, x, -.246, z, T + .3, .5, T + .3); w++; }
      else if (t === GRASS) {
        setInst(grassBase, gb++, x, .02, z, T, 1, T);
        for (let k = 0; k < blades; k++) { setInst(grass, g, x + RR(-.8, .8), 0, z + RR(-.8, .8), RR(.7, 1.1), RR(2.2, 3.1), RR(.7, 1.1), R() * 3); COL.setHSL(RR(.24, .31), RR(.55, .7), RR(.3, .43)); grass.setColorAt(g, COL); g++; }
      }
    }
    for (const m of [stone, cap, crateMesh, water, rim, grass, grassBase]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; m.frustumCulled = false; world.add(m); }
    for (const q of map.boxes) { // power boxes, in the map's order so a box has the same index everywhere
      const mat = new THREE.MeshStandardMaterial({ map: boxTex, emissiveMap: boxEmis, emissive: 0x4dffb0, emissiveIntensity: 1, roughness: .6 });
      const mesh = new THREE.Mesh(geo('pbox', () => new THREE.BoxGeometry(1.7, 1.7, 1.7)), mat); mesh.position.set(q.x, .85, q.z); mesh.castShadow = mesh.receiveShadow = true; world.add(mesh);
      boxV.push({ q, mesh, mat, flash: 0, shake: 0, hp: q.maxhp, dead: false });
    }
    for (const [a, b] of [[0, 0], [N - 1, 0], [0, N - 1], [N - 1, N - 1], [N / 2, 0], [N / 2, N - 1], [0, N / 2], [N - 1, N / 2]]) addLantern(wx(a), 4.3, wx(b), true); // lanterns on the walls so night is never pitch black
    /* decor: pebbles inside, cacti and mesas outside */
    const peb = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(.22, 0), new THREE.MeshStandardMaterial({ color: 0xb08a5c, flatShading: true, roughness: 1 }), 90);
    for (let k = 0; k < 90; k++) { let x, z, n = 0; do { x = RR(-HALF + 2, HALF - 2); z = RR(-HALF + 2, HALF - 2); } while (map.tileAt(x, z) !== E && n++ < 50); setInst(peb, k, x, .08, z, RR(.6, 1.6), RR(.4, .9), RR(.6, 1.6), R() * 6); }
    peb.receiveShadow = peb.castShadow = true; world.add(peb);
    const cacMat = new THREE.MeshStandardMaterial({ color: 0x3f8f3a, flatShading: true, roughness: .9 }), mesaMat = new THREE.MeshStandardMaterial({ color: 0xb5673a, flatShading: true, roughness: 1 });
    for (let k = 0; k < 46; k++) {
      const a = R() * 6.28, d = RR(HALF + 5, HALF + 60), x = Math.cos(a) * d * 1.2, z = Math.sin(a) * d * 1.2;
      if (R() < .6) {
        const cg = new THREE.Group(), tr = new THREE.Mesh(new THREE.CylinderGeometry(.5, .6, RR(3, 5), 6), cacMat); tr.position.y = 2; cg.add(tr);
        for (const sgn of [-1, 1]) { if (R() < .3) continue; const arm = new THREE.Mesh(new THREE.CylinderGeometry(.32, .32, 1.6, 6), cacMat); arm.position.set(sgn * .95, RR(1.8, 2.8), 0); cg.add(arm); const el = new THREE.Mesh(new THREE.BoxGeometry(.7, .5, .5), cacMat); el.position.set(sgn * .6, arm.position.y - .7, 0); cg.add(el); }
        cg.position.set(x, 0, z); cg.rotation.y = R() * 6; cg.scale.setScalar(RR(.8, 1.5)); cg.traverse(o => { o.castShadow = true; }); world.add(cg);
      } else { const h = RR(4, 14), m = new THREE.Mesh(new THREE.CylinderGeometry(RR(3, 7), RR(6, 11), h, 7), mesaMat); m.position.set(x * 1.3, h / 2 - .2, z * 1.3); m.rotation.y = R() * 6; m.castShadow = true; world.add(m); }
    }
    /* poison gas: a flat ring with a hole the size of the safe zone, and a glowing wall at its edge */
    gasMesh = new THREE.Mesh(new THREE.RingGeometry(1, 70, 72, 1), new THREE.MeshBasicMaterial({ color: 0x58d81c, transparent: true, opacity: .42, depthWrite: false, side: THREE.DoubleSide }));
    gasMesh.rotation.x = -Math.PI / 2; gasMesh.position.y = .35; gasMesh.renderOrder = 5; world.add(gasMesh);
    gasWall = new THREE.Mesh(new THREE.CylinderGeometry(1, 1, 1, 72, 1, true), new THREE.MeshBasicMaterial({ color: 0x9dff3a, transparent: true, opacity: .22, depthWrite: false, side: THREE.DoubleSide, toneMapped: false }));
    gasWall.position.y = 1.2; gasWall.renderOrder = 6; world.add(gasWall);
  }

  /* ---- brawler models: boxes, cylinders and a hat, each part with its own material so one brawler can flash */
  function part(g, color, geom, x, y, z, mats, opt = {}) {
    const mat = opt.basic ? new THREE.MeshBasicMaterial({ color, toneMapped: false }) : new THREE.MeshStandardMaterial({ color, roughness: opt.rough ?? .65, flatShading: true, metalness: opt.metal ?? 0 });
    const m = new THREE.Mesh(geom, mat); m.position.set(x, y, z); m.castShadow = !opt.basic; g.add(m); if (!opt.basic) mats.push(mat); return m;
  }
  function makeModel(ci, shirt) {
    const cls = CLASSES[ci], rootG = new THREE.Group(), body = new THREE.Group(), mats = []; rootG.add(body);
    const skin = 0xf2c29b, bx = unitBox;
    const legL = part(rootG, 0x3a3350, bx, -.3, .3, 0, mats), legR = part(rootG, 0x3a3350, bx, .3, .3, 0, mats); legL.scale.set(.36, .6, .46); legR.scale.set(.36, .6, .46);
    const wide = cls.wide || 1;
    part(body, shirt, geo('torso', () => new THREE.CylinderGeometry(.52, .66, .95, 7)), 0, 1.05, 0, mats).scale.set(wide, 1, wide * .9);
    part(body, 0x2a2230, bx, 0, .66, 0, mats).scale.set(1.15 * wide, .16, wide);
    part(body, skin, geo('head', () => new THREE.IcosahedronGeometry(.56, 1)), 0, 1.98, 0, mats).scale.set(1.05, .95, 1);
    for (const s of [-1, 1]) { part(body, 0xffffff, bx, s * .22, 2.02, .47, mats).scale.set(.2, .24, .08); part(body, 0x111111, bx, s * .22, 2.0, .52, [], { basic: true }).scale.set(.1, .13, .05); }
    const armL = new THREE.Group(), armR = new THREE.Group(); armL.position.set(-.72 * wide, 1.38, 0); armR.position.set(.72 * wide, 1.38, 0); body.add(armL, armR);
    for (const a of [armL, armR]) { part(a, shirt, bx, 0, -.18, 0, mats).scale.set(.3, .5, .34); part(a, skin, bx, 0, -.55, 0, mats).scale.set(.28, .28, .3); }
    const wp = new THREE.Group(); armR.add(wp); wp.position.set(0, -.55, .2);
    if (cls.id === 'buck') {
      part(body, cls.hat, geo('brim', () => new THREE.CylinderGeometry(.95, .95, .1, 10)), 0, 2.4, 0, mats); part(body, cls.hat, geo('crown', () => new THREE.CylinderGeometry(.45, .55, .5, 8)), 0, 2.68, 0, mats);
      part(body, 0xffd23f, geo('band', () => new THREE.CylinderGeometry(.57, .57, .12, 8)), 0, 2.5, 0, mats); part(body, cls.color, bx, 0, 1.62, .3, mats).scale.set(.7, .3, .5);
      part(wp, 0x5a3a1c, bx, 0, 0, .1, mats).scale.set(.2, .24, .7); for (const s of [-1, 1]) part(wp, 0x555b66, bx, s * .08, .04, .85, mats, { metal: .6 }).scale.set(.13, .13, 1);
    } else if (cls.id === 'viper') {
      part(body, cls.hat, geo('hood', () => new THREE.IcosahedronGeometry(.64, 1)), 0, 2.08, -.08, mats).scale.set(1.05, 1, 1);
      part(body, 0xff3355, bx, 0, 2.05, .5, [], { basic: true }).scale.set(.72, .13, .1); part(body, cls.color, geo('scarf', () => new THREE.CylinderGeometry(.5, .62, .3, 7)), 0, 1.58, 0, mats);
      part(wp, 0x22262e, bx, 0, 0, .9, mats, { metal: .5 }).scale.set(.12, .14, 2.3); part(wp, 0x3d7bff, bx, 0, .16, .6, mats).scale.set(.12, .14, .5); part(wp, 0x5a3a1c, bx, 0, -.04, -.1, mats).scale.set(.16, .26, .5);
    } else if (cls.id === 'boomer') {
      part(body, cls.hat, geo('hcap', () => new THREE.SphereGeometry(.6, 8, 5, 0, 6.3, 0, 1.6)), 0, 2.1, 0, mats); part(body, 0xffb627, bx, 0, 2.3, .46, mats).scale.set(.5, .2, .18);
      part(body, 0x88ddff, bx, 0, 2.04, .5, mats, { rough: .2 }).scale.set(.8, .2, .08); part(body, cls.color, bx, 0, 1.1, -.55, mats).scale.set(.7, .8, .4);
      part(wp, 0x222222, geo('bombh', () => new THREE.IcosahedronGeometry(.34, 1)), 0, -.05, .25, mats); part(wp, 0xffd040, bx, 0, .32, .25, [], { basic: true }).scale.set(.08, .2, .08);
    } else if (cls.id === 'frost') { // a pointed hood with a fur trim, and a staff with a shard of ice on it
      part(body, cls.hat, geo('wizhat', () => new THREE.ConeGeometry(.66, 1.2, 7)), 0, 2.85, -.05, mats).rotation.x = -.18; part(body, 0xf4fbff, geo('band', () => new THREE.CylinderGeometry(.57, .57, .12, 8)), 0, 2.32, 0, mats).scale.set(1.2, 1.5, 1.2);
      part(body, cls.color, geo('scarf', () => new THREE.CylinderGeometry(.5, .62, .3, 7)), 0, 1.58, 0, mats);
      part(wp, 0x6b4a2a, bx, 0, .1, .5, mats).scale.set(.1, .1, 1.9); part(wp, 0xa8f0ff, geo('shard', () => new THREE.OctahedronGeometry(.3, 0)), 0, .1, 1.6, [], { basic: true }).scale.set(1, 1, 1.6);
    } else if (cls.id === 'shade') { // a dark hood, a violet slit for eyes, a knife in each hand
      part(body, cls.hat, geo('hood', () => new THREE.IcosahedronGeometry(.64, 1)), 0, 2.08, -.08, mats).scale.set(1.08, 1.05, 1.05);
      part(body, 0xc77dff, bx, 0, 2.03, .52, [], { basic: true }).scale.set(.66, .09, .1); part(body, cls.color, bx, 0, 1.2, -.5, mats).scale.set(1.1, 1, .12);
      for (const arm of [armL, armR]) { part(arm, 0x22222a, bx, 0, -.55, .3, mats).scale.set(.1, .14, .3); part(arm, 0xdfe6f0, bx, 0, -.55, .75, mats, { metal: .7, rough: .25 }).scale.set(.06, .16, .7); }
    } else if (cls.id === 'blaze') { // a welder's mask, a fuel tank on the back, a fat nozzle with a pilot light
      part(body, cls.hat, geo('hcap', () => new THREE.SphereGeometry(.6, 8, 5, 0, 6.3, 0, 1.6)), 0, 2.1, 0, mats, { metal: .4, rough: .5 }); part(body, 0x1a1a1f, bx, 0, 1.98, .46, mats, { rough: .25 }).scale.set(.86, .42, .16);
      part(body, 0xffa040, bx, 0, 2.02, .55, [], { basic: true }).scale.set(.56, .1, .05); part(body, 0xb8352a, geo('tank', () => new THREE.CylinderGeometry(.3, .3, 1, 8)), 0, 1.2, -.62, mats, { metal: .5, rough: .4 });
      part(wp, 0x3a3d45, bx, 0, 0, .5, mats, { metal: .5 }).scale.set(.26, .26, 1.5); part(wp, 0x22262e, bx, 0, 0, 1.35, mats, { metal: .5 }).scale.set(.36, .36, .3); part(wp, 0xffb030, bx, 0, 0, 1.55, [], { basic: true }).scale.set(.16, .16, .12);
    } else if (cls.id === 'hook') { // a red bandana, a beard, and a hook on a chain
      part(body, cls.hat, geo('hcap', () => new THREE.SphereGeometry(.6, 8, 5, 0, 6.3, 0, 1.6)), 0, 2.08, 0, mats).scale.set(1, .8, 1); part(body, cls.hat, bx, .2, 2.0, -.62, mats).scale.set(.2, .16, .5);
      part(body, 0x5a3a1c, bx, 0, 1.7, .4, mats).scale.set(.7, .4, .3); part(body, cls.color, bx, 0, 1.15, .02, mats).scale.set(1.28 * wide, .22, 1.2 * wide);
      for (let k = 0; k < 3; k++) part(wp, 0x8a929e, bx, 0, 0, .2 + k * .32, mats, { metal: .7, rough: .3 }).scale.set(k % 2 ? .1 : .2, k % 2 ? .2 : .1, .26);
      const hk = part(wp, 0xc8d0da, geo('hookt', () => new THREE.TorusGeometry(.3, .08, 5, 10, 4.2)), 0, -.1, 1.35, mats, { metal: .8, rough: .25 }); hk.rotation.set(0, Math.PI / 2, -.6);
    } else if (cls.id === 'dash') { // a cap worn backwards, goggles, a pistol in each hand
      part(body, cls.hat, geo('hcap', () => new THREE.SphereGeometry(.6, 8, 5, 0, 6.3, 0, 1.6)), 0, 2.12, 0, mats); part(body, cls.hat, bx, 0, 2.2, -.7, mats).scale.set(.7, .08, .5);
      part(body, 0x55e0ff, bx, 0, 2.06, .5, mats, { rough: .15 }).scale.set(.84, .22, .08); part(body, cls.color, geo('scarf', () => new THREE.CylinderGeometry(.5, .62, .3, 7)), 0, 1.58, 0, mats);
      for (const arm of [armL, armR]) { part(arm, 0x5a3a1c, bx, 0, -.6, .22, mats).scale.set(.13, .26, .2); part(arm, 0x9aa2ae, bx, 0, -.5, .55, mats, { metal: .7, rough: .3 }).scale.set(.12, .15, .7); }
    } else if (cls.id === 'sparky') { // a hard hat with an aerial, a toolbox on the back, a bolt gun with a lit tip
      part(body, cls.hat, geo('hcap', () => new THREE.SphereGeometry(.6, 8, 5, 0, 6.3, 0, 1.6)), 0, 2.12, 0, mats); part(body, cls.hat, geo('brim', () => new THREE.CylinderGeometry(.95, .95, .1, 10)), 0, 2.16, .1, mats).scale.set(.78, .7, .82);
      part(body, 0x333842, bx, .3, 2.95, -.2, mats).scale.set(.05, .7, .05); part(body, 0x5dffc8, bx, .3, 3.32, -.2, [], { basic: true }).scale.set(.13, .13, .13); part(body, cls.color, bx, 0, 1.12, -.56, mats).scale.set(.8, .7, .4);
      part(wp, 0x3a4150, bx, 0, 0, .45, mats, { metal: .5 }).scale.set(.22, .3, 1.1); part(wp, 0xf2c230, bx, 0, .18, .3, mats).scale.set(.16, .12, .5); part(wp, 0x5dffc8, bx, 0, 0, 1.08, [], { basic: true }).scale.set(.14, .14, .2);
    } else if (cls.id === 'rico') { // a wide flat hat, a bandolier, a long pink revolver
      part(body, cls.hat, geo('brim', () => new THREE.CylinderGeometry(.95, .95, .1, 10)), 0, 2.42, 0, mats).scale.set(1.2, 1, 1.2); part(body, cls.hat, geo('crown', () => new THREE.CylinderGeometry(.45, .55, .5, 8)), 0, 2.6, 0, mats).scale.set(1, .6, 1);
      part(body, cls.color, geo('band', () => new THREE.CylinderGeometry(.57, .57, .12, 8)), 0, 2.5, 0, mats); const belt = part(body, 0x6b4a2a, bx, 0, 1.15, .02, mats); belt.scale.set(1.5, .16, 1.25); belt.rotation.z = .7;
      part(wp, 0x5a3a1c, bx, 0, -.08, .08, mats).scale.set(.15, .3, .24); part(wp, 0xd9dde4, bx, 0, .04, .4, mats, { metal: .7, rough: .3 }).scale.set(.24, .24, .34); part(wp, cls.color, bx, 0, .06, 1, mats, { metal: .5, rough: .3 }).scale.set(.1, .12, 1.1);
    } else {
      part(body, cls.hat, geo('helm', () => new THREE.SphereGeometry(.64, 8, 5, 0, 6.3, 0, 1.75)), 0, 2.02, 0, mats, { metal: .5, rough: .4 });
      for (const s of [-1, 1]) { part(body, 0xfff2cc, geo('horn', () => new THREE.ConeGeometry(.14, .6, 5)), s * .66, 2.42, 0, mats).rotation.z = -s * .7; part(body, cls.color, geo('pad', () => new THREE.IcosahedronGeometry(.4, 0)), s * .86, 1.55, 0, mats); }
      part(wp, 0x5a3a1c, bx, 0, .1, .5, mats).scale.set(.13, .13, 1.5); part(wp, 0x8a929e, bx, 0, .1, 1.25, mats, { metal: .6 }).scale.set(.6, .6, .55);
    }
    armR.rotation.x = -1.25; armL.rotation.x = cls.hold === 'two' ? -1.1 : cls.hold === 'dual' ? -1.25 : -.3; if (cls.hold === 'two') armL.rotation.z = -.5; // `hold`: both hands on one weapon, or one in each
    const ring = new THREE.Mesh(geo('ring', () => new THREE.RingGeometry(.95, 1.18, 28).rotateX(-Math.PI / 2)), new THREE.MeshBasicMaterial({ color: FOE, transparent: true, opacity: .75, depthWrite: false }));
    ring.position.y = .06; rootG.add(ring);
    return { root: rootG, body, legL, legR, armL, armR, mats, ring };
  }
  const disposeModel = m => { scene.remove(m.root); m.root.traverse(o => { if (o.material) o.material.dispose(); }); };

  /* ---- particles and effect pools */
  const PMAX = touch ? 420 : 700;
  const pMesh = new THREE.InstancedMesh(unitBox, new THREE.MeshBasicMaterial({ toneMapped: false }), PMAX); pMesh.frustumCulled = false; pMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage); scene.add(pMesh);
  const P = []; for (let i = 0; i < PMAX; i++) { P.push({ life: 0, max: 1, x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0, s: .2, g: 1, rx: 0, ry: 0, sp: 0 }); pMesh.setColorAt(i, COL.set(0xffffff)); }
  let pNext = 0;
  function spawnP(x, y, z, vx, vy, vz, size, life, color, bright = 1, grav = 1) {
    const p = P[pNext]; p.life = p.max = life; p.x = x; p.y = y; p.z = z; p.vx = vx; p.vy = vy; p.vz = vz; p.s = size; p.g = grav; p.rx = R() * 6; p.ry = R() * 6; p.sp = RR(-8, 8);
    COL.set(color); pMesh.setColorAt(pNext, COL.multiplyScalar(bright > 1 ? glow(bright) : bright * lerp(1, .35, G.night))); pNext = (pNext + 1) % PMAX;
  }
  function burst(x, y, z, n, color, speed = 6, size = .22, bright = 1, up = 4, life = .6) { for (let i = 0; i < n; i++) { const a = R() * 6.28, s = RR(.3, 1) * speed; spawnP(x, y, z, Math.cos(a) * s, RR(.2, 1) * up, Math.sin(a) * s, size * RR(.6, 1.3), life * RR(.6, 1.2), color, bright); } }
  function updateParticles(dt) {
    for (let i = 0; i < PMAX; i++) {
      const p = P[i]; if (p.life <= 0) { if (p.life > -1) { p.life = -2; M4.makeScale(0, 0, 0); pMesh.setMatrixAt(i, M4); } continue; }
      p.life -= dt; p.vy -= 18 * p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt; p.vx *= 1 - 1.5 * dt; p.vz *= 1 - 1.5 * dt;
      if (p.y < .08 && p.g > 0) { p.y = .08; p.vy *= -.4; p.vx *= .6; p.vz *= .6; }
      const k = p.s * Math.min(1, p.life / p.max * 2.2); p.rx += p.sp * dt; Q.setFromEuler(EUL.set(p.rx, p.ry, p.rx * .7)); M4.compose(V.set(p.x, p.y, p.z), Q, SC.set(k, k, k)); pMesh.setMatrixAt(i, M4);
    }
    pMesh.instanceMatrix.needsUpdate = true; if (pMesh.instanceColor) pMesh.instanceColor.needsUpdate = true;
  }
  /* expanding rings, flash spheres and melee arcs */
  const FX = [];
  const fxPool = (n, mk) => { const a = []; for (let i = 0; i < n; i++) { const m = mk(); m.visible = false; scene.add(m); a.push({ m, life: 0, max: 1, s0: 1, s1: 1 }); } return a; };
  const fxMat = () => new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false, depthWrite: false, side: THREE.DoubleSide });
  const ringPool = fxPool(20, () => { const m = new THREE.Mesh(geo('fxring', () => new THREE.RingGeometry(.78, 1, 40).rotateX(-Math.PI / 2)), fxMat()); m.renderOrder = 7; return m; });
  const ballPool = fxPool(16, () => new THREE.Mesh(geo('fxball', () => new THREE.IcosahedronGeometry(1, 2)), fxMat()));
  const arcPool = fxPool(8, () => { const m = new THREE.Mesh(geo('fxarc', () => new THREE.RingGeometry(.45, 1, 24, 1, Math.PI / 2 - .95, 1.9).rotateX(-Math.PI / 2)), fxMat()); m.renderOrder = 7; return m; });
  function fx(pool, x, y, z, s0, s1, life, color, bright = 2, rotY = 0) {
    const f = pool.find(q => q.life <= 0) || pool[0]; f.life = f.max = life; f.s0 = s0; f.s1 = s1; f.m.visible = true; f.m.position.set(x, y, z); f.m.rotation.y = rotY;
    f.m.material.color.set(color).multiplyScalar(glow(bright)); f.m.scale.setScalar(s0); if (!FX.includes(f)) FX.push(f);
  }
  function updateFX(dt) {
    for (let i = FX.length - 1; i >= 0; i--) { const f = FX[i]; f.life -= dt; const t = 1 - Math.max(0, f.life) / f.max; f.m.scale.setScalar(lerp(f.s0, f.s1, 1 - (1 - t) * (1 - t))); f.m.material.opacity = (1 - t) * (1 - t); if (f.life <= 0) { f.m.visible = false; FX.splice(i, 1); } }
  }
  /* sounds fade with the distance from what the camera follows */
  const listener = { x: 0, z: 0 };
  const att = (x, z) => clamp(1 - Math.hypot(x - listener.x, z - listener.z) / 34, 0, 1) ** 1.6;
  let shake = 0, hurtFlash = 0; const dmgNums = [];
  function explosionFX(x, z, r, color = 0xffa030) {
    fx(ballPool, x, .9, z, r * .25, r * .85, .32, color, 3); fx(ballPool, x, .9, z, r * .15, r * .5, .2, 0xffffff, 4); fx(ringPool, x, .15, z, .5, r * 1.15, .45, color, 2.5);
    burst(x, .6, z, 22, color, 11, .3, 3, 9, .7); burst(x, .4, z, 14, 0x5a4a3a, 7, .4, 1, 7, .9); burst(x, .3, z, 10, 0xe9bf7c, 5, .5, 1, 3, .8);
    shake = Math.min(1.2, shake + .75 * att(x, z) + .05); sfx.boom(att(x, z));
  }
  const dmgNum = (x, y, z, text, color = '#fff', big = false) => { dmgNums.push({ x: x + RR(-.4, .4), y, z, text, color, life: .9, big, vx: RR(-1, 1) }); if (dmgNums.length > 60) dmgNums.shift(); };

  /* ============================================================ the match as this machine shows it.
     `B` holds one view brawler per roster slot: on the host a copy of the simulation's brawler each frame, on a client
     the snapshots (interpolated, or predicted for its own). Bullets, bombs and cubes here are only pictures: they fly
     from their launch events on every machine, and what they hit is the host's call. */
  const G = { state: null, time: 0, night: 0, gasR: GAS_R[0], gasTo: GAS_R[0], gasStage: 0, gasT: 0, gasShrink: false, slow: 1, picks: [], pickT: Infinity, result: null, spectate: -1 };
  let session = null, isHost = false, online = false, hostId = null, myId = null, sim = null, roster = [], B = [], me = null, guard = null, seq = 0, outEvents = [];
  const bullets = new Map(), bombs = [], cubes = new Map(), turrets = new Map(), zones = [];
  const bulletGeo = new THREE.SphereGeometry(1, 8, 6), bombGeo = new THREE.IcosahedronGeometry(.42, 1), bombMat = new THREE.MeshStandardMaterial({ color: 0x222228, flatShading: true, emissive: 0xff5a1a, emissiveIntensity: .6 }), iceMat = new THREE.MeshStandardMaterial({ color: 0xcdf6ff, flatShading: true, emissive: 0x4fc8ff, emissiveIntensity: .9 });
  const cubeGeo = new THREE.OctahedronGeometry(.48, 0), cubeMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0x35ff8a).multiplyScalar(glow(2.2)), toneMapped: false });
  const markGeo = new THREE.RingGeometry(.86, 1, 36).rotateX(-Math.PI / 2), discGeo = new THREE.CircleGeometry(1, 36).rotateX(-Math.PI / 2);
  /* SPARKY's turret: a drum in its owner's colour, a head that turns to whoever it shoots at, a lit barrel */
  function makeTurret(color) {
    const g = new THREE.Group(), head = new THREE.Group(), mats = []; head.position.y = 1.15; g.add(head);
    part(g, color, geo('tbase', () => new THREE.CylinderGeometry(.7, .9, .8, 8)), 0, .4, 0, mats, { metal: .3 }); part(g, 0x2a2f3a, geo('tneck', () => new THREE.CylinderGeometry(.3, .3, .4, 6)), 0, .95, 0, mats, { metal: .5 });
    part(head, 0x3a4150, unitBox, 0, .15, 0, mats, { metal: .5, rough: .4 }).scale.set(.8, .5, .9); part(head, 0x8a929e, unitBox, 0, .15, .8, mats, { metal: .7, rough: .3 }).scale.set(.2, .2, 1); part(head, 0x5dffc8, unitBox, 0, .15, 1.32, [], { basic: true }).scale.set(.16, .16, .1);
    return { g, head, mats };
  }
  function dropTurret(t, boom) { turrets.delete(t.id); scene.remove(t.g); t.g.traverse(o => { if (o.material) o.material.dispose(); }); if (boom) { burst(t.x, 1, t.z, 18, 0x8a929e, 8, .3, 1, 8, .8); burst(t.x, 1, t.z, 10, 0x5dffc8, 7, .2, 3, 7, .5); fx(ringPool, t.x, .2, t.z, .4, 3, .4, 0x5dffc8, 2.5); sfx.crate(att(t.x, t.z)); } }

  function makeViewBrawler(slot) {
    return { i: slot.i, pid: slot.pid, name: slot.name, shirt: slot.color, human: slot.human, mine: slot.pid !== null && slot.pid === myId, cls: -1, model: null, color: slot.color,
      x: 0, z: 0, dir: 0, face: 0, mvx: 0, mvz: 0, hp: 1, maxhp: 1, cubes: 0, ammo: 3, sup: 0, kills: 0, alive: false, inGrass: false, revealed: false, dash: false, slow: false, stun: false, burn: false, stealth: false, haste: false,
      rank: 0, seen: true, hid: false, walkT: R() * 6, flash: 0, wasFlash: false, glowing: false, recoil: 0, swing: 0, lastHp: 0, buf: [], placed: false };
  }
  function ensureModel(b, cls) {
    if (b.cls === cls && b.model) return; if (b.model) disposeModel(b.model);
    b.cls = cls; b.model = makeModel(cls, b.shirt); b.model.ring.material.color.set(b.mine ? MINE : FOE); b.color = b.mine ? MINE : b.shirt; b.hid = false; scene.add(b.model.root);
  }
  function clearMatch() {
    for (const b of B) if (b.model) disposeModel(b.model); B = []; me = null;
    for (const b of bullets.values()) { scene.remove(b.m); b.m.material.dispose(); } bullets.clear();
    for (const b of bombs) { scene.remove(b.m, b.mark); b.mark.material.dispose(); } bombs.length = 0;
    for (const c of cubes.values()) scene.remove(c.m); cubes.clear();
    for (const t of [...turrets.values()]) dropTurret(t, false); for (const q of zones) { scene.remove(q.m, q.ring); q.m.material.dispose(); q.ring.material.dispose(); } zones.length = 0;
    for (const f of FX) { f.life = 0; f.m.visible = false; } FX.length = 0; for (const p of P) if (p.life > 0) p.life = 0;
    dmgNums.length = 0; dom.feed.innerHTML = ''; shake = 0; hurtFlash = 0; superAim = false; for (const t of timers) clearTimeout(t); timers.length = 0;
  }
  const timers = [], later = (ms, fn) => timers.push(setTimeout(fn, ms));

  /* ---- events: the one road from the simulation to the screen and the speakers, on the host and on every client */
  function applyEvent(ev) {
    const b = B[ev[1]];
    switch (ev[0]) {
      case 'c': showCount(String(ev[1]), '#ffd23f'); sfx.beep(); break;
      case 'go': showCount(TX('brawl'), '#ff6b35'); sfx.go(); shake = .5; break;
      case 'a': { // an attack: the flash, the swing, the noise; the bullets and bombs have their own events
        if (!b || b.cls < 0) break; const c = CLASSES[b.cls], a = ev[2], v = att(b.x, b.z) * (b.mine ? 1 : .7), mz = c.mz * .8, mx = b.x + Math.sin(a) * mz, mzz = b.z + Math.cos(a) * mz;
        if (!b.mine) b.dir = a; b.revealed = true;
        if (ev[3]) {
          b.recoil = 1.5; sfx.super(v); fx(ringPool, b.x, .2, b.z, .5, 4, .5, 0xffd23f, 3); burst(b.x, 1, b.z, 16, 0xffd23f, 8, .2, 3.5, 8, .6); dmgNum(b.x, 3.8, b.z, TX('super'), '#ffd23f', true);
          if (c.id === 'buck') { sfx.shotgun(v); shake += b.mine ? .6 : .2 * v; } else if (c.id === 'viper') { sfx.rifle(v); shake += b.mine ? .5 : .15 * v; }
          else if (c.id === 'shade') { sfx.vanish(v); burst(b.x, 1.2, b.z, 26, 0x2a1a3a, 5, .5, 1, 4, .9); burst(b.x, 1.2, b.z, 10, 0xc77dff, 6, .2, 3, 5, .6); }
          else if (c.id === 'frost' || c.id === 'blaze' || c.id === 'sparky') sfx.lob(v); else if (c.id === 'hook') sfx.swing(v); else if (c.id === 'rico') { sfx.pistol(v); shake += b.mine ? .4 : .12 * v; }
          break;
        }
        b.recoil = 1;
        if (c.melee) { b.swing = 1; sfx.swing(v); fx(arcPool, b.x, 1, b.z, c.range * .5, c.range, .22, 0xb8ffd0, 2.2, a + Math.PI); burst(mx, 1, mzz, 5, 0xe9bf7c, 5, .2, 1, 3, .4); }
        else if (c.lob) sfx.lob(v);
        else { // a gun: its own noise, and a muzzle flash in the colour of what it fires (a flamethrower's flash is its flames)
          const k = BULLETS[c.bk]; (sfx[c.snd] || sfx.rifle)(v); if (c.hold === 'dual') b.swing = 1;
          if (!k.flame) { fx(ballPool, mx, 1.2, mzz, .2, c.id === 'buck' ? .95 : .7, .09, c.bk > 1 ? k.color : 0xffe08a, 4); burst(mx, 1.2, mzz, 4, c.bk > 1 ? k.color : 0xffd060, 6, .12, 3, 2, .2); } if (b.mine) shake += c.id === 'buck' ? .22 : k.flame ? .05 : .14;
        }
        break;
      }
      case 'b': {
        const [, id, , x, z, a, speed, left, kind] = ev, k = BULLETS[kind] || BULLETS[0];
        const m = new THREE.Mesh(bulletGeo, new THREE.MeshBasicMaterial({ color: new THREE.Color(k.color).multiplyScalar(glow(k.bright || 2.6)), toneMapped: false }));
        m.scale.set(k.r, k.r, k.r * k.len); m.rotation.y = a; m.position.set(x, 1.15, z); scene.add(m); bullets.set(id, { id, x, z, vx: Math.sin(a) * speed, vz: Math.cos(a) * speed, left, k, m, trail: 0, nb: 0, by: ev[2] }); break;
      }
      case 'bb': { // the host's word on a ricochet; if this machine's copy has already come off that wall, it stands
        const q = bullets.get(ev[1]); if (!q || q.nb >= ev[6]) break; const sp = Math.hypot(q.vx, q.vz); q.x = ev[2]; q.z = ev[3]; q.vx = Math.sin(ev[4]) * sp; q.vz = Math.cos(ev[4]) * sp; q.left = ev[5]; q.nb = ev[6]; ricochet(q); break;
      }
      case 'bx': { const q = bullets.get(ev[1]); if (q) { q.x = ev[2]; q.z = ev[3]; killBullet(q); } break; }
      case 'o': {
        const [, , x0, z0, x1, z1, dur, h, radius, delay, ice] = ev, m = new THREE.Mesh(bombGeo, ice ? iceMat : bombMat); m.castShadow = true; m.visible = false; scene.add(m);
        const mark = new THREE.Mesh(markGeo, new THREE.MeshBasicMaterial({ color: b && b.mine ? MINE : ice ? 0x9fe8ff : 0xff3b30, transparent: true, opacity: .8, depthWrite: false, toneMapped: false }));
        mark.position.set(x1, .12, z1); mark.scale.setScalar(radius); mark.visible = false; scene.add(mark); bombs.push({ x0, z0, x1, z1, t: -delay, dur, h, radius, m, mark, mine: !!(b && b.mine), ice: !!ice }); break;
      }
      case 'z': { // burning ground: a disc and a ring that flicker until it burns out
        const [, id, , x, z, r, dur] = ev, mk = (g, op) => { const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color: new THREE.Color(0xff6a1a).multiplyScalar(glow(2)), transparent: true, opacity: op, depthWrite: false, toneMapped: false })); m.position.set(x, .13, z); m.scale.setScalar(r); m.renderOrder = 6; scene.add(m); return m; };
        zones.push({ id, x, z, r, t: dur, m: mk(discGeo, .3), ring: mk(markGeo, .8) }); explosionFX(x, z, r * .8, 0xff7a1a); break;
      }
      case 'hk': if (b) { const v = att(b.x, b.z); sfx.hooked(v); fx(ringPool, b.x, .3, b.z, .4, 2.6, .3, 0x2fd0e0, 3); burst(b.x, 1.2, b.z, 10, 0x9adfe8, 7, .2, 2.5, 5, .4); if (b.mine) shake = Math.min(1.2, shake + .6); } break;
      case 'tu': {
        const [, id, i, x, z, maxhp] = ev, o = B[i], t = makeTurret(o ? o.shirt : 0x42d6a4); t.g.position.set(x, 0, z); scene.add(t.g);
        turrets.set(id, Object.assign(t, { id, x, z, hp: maxhp, maxhp, dir: 0, face: 0, recoil: 0, flash: 0, mine: !!(o && o.mine), age: 0 })); sfx.build(att(x, z)); fx(ringPool, x, .2, z, .4, 2.6, .4, 0x5dffc8, 2.5); burst(x, .4, z, 12, 0xe9bf7c, 5, .3, 1, 4, .6); break;
      }
      case 'ta': { const t = turrets.get(ev[1]); if (!t) break; t.dir = ev[2]; t.recoil = 1; const mx = t.x + Math.sin(t.dir) * 1.2, mz = t.z + Math.cos(t.dir) * 1.2; sfx.zap(att(t.x, t.z) * .6); fx(ballPool, mx, 1.3, mz, .15, .55, .08, 0x5dffc8, 4); break; }
      case 'td': { const t = turrets.get(ev[1]); if (!t) break; t.hp = ev[3]; t.flash = 1; burst(t.x, 1.2, t.z, 5, 0x8a929e, 5, .16, 1.5, 4, .35); dmgNum(t.x, 2.6, t.z, ev[2], B[ev[4]] && B[ev[4]].mine ? '#ffe14d' : '#bff'); sfx.hit(att(t.x, t.z) * .7); break; }
      case 'tx': { const t = turrets.get(ev[1]); if (t) dropTurret(t, true); break; }
      case 'de': if (b) { fx(ringPool, b.x, .2, b.z, .5, 3.4, .35, 0x7dffb0, 2.5); shake += .3 * att(b.x, b.z); } break;
      case 'd': {
        if (!b) break; const [, , amount, by, hx, hz, silent] = ev, src = B[by], a = att(b.x, b.z); b.flash = 1; b.revealed = true;
        if (!silent) { burst(hx, 1.3, hz, 7, b.color, 6, .2, 1.6, 5, .45); burst(b.x, 1.2, b.z, 4, 0xffffff, 5, .14, 3, 4, .3); sfx.hit(a); if (amount >= 1000) fx(ringPool, b.x, .3, b.z, .4, 3, .3, 0xffffff, 3); }
        else if (b.mine) sfx.hit(.6);
        if (b.seen || b.mine) dmgNum(b.x, 3, b.z, amount, b.mine ? '#ff5a4d' : src && src.mine ? '#ffe14d' : '#fff', amount >= 900);
        if (b.mine) { shake = Math.min(1.2, shake + .3 + amount / 2500); hurtFlash = .35; } else if (src && src.mine) shake = Math.min(1, shake + .16 + amount / 5000);
        break;
      }
      case 'k': {
        if (!b) break; const src = B[ev[2]]; b.alive = false; b.hp = 0; b.rank = ev[3]; if (b.model) b.model.root.visible = false;
        burst(b.x, 1.2, b.z, 30, b.color, 10, .34, 1.8, 10, 1); burst(b.x, 1.2, b.z, 16, 0xffffff, 8, .2, 3.5, 9, .6); burst(b.x, .5, b.z, 10, 0x3a3350, 6, .3, 1, 6, .9);
        fx(ringPool, b.x, .2, b.z, .5, 5, .55, 0xffffff, 3); fx(ballPool, b.x, 1.2, b.z, .4, 2.4, .3, b.color, 3); shake = Math.min(1.4, shake + .6 * att(b.x, b.z)); sfx.die(att(b.x, b.z));
        feed(src || null, b); if (b.mine) { G.spectate = src ? src.i : -1; superAim = false; tc.releaseAll(); sfx.lose(); }
        else if (me && !me.alive && G.spectate === b.i && src && src.alive) G.spectate = src.i; // the one I watched fell: watch whoever did it
        break;
      }
      case 'bd': {
        const q = boxV[ev[1]]; if (!q || q.dead) break; const [, , amount, hp, by] = ev, { x, z } = q.q; q.hp = hp; q.flash = 1; q.shake = .25;
        burst(x, 1.2, z, 5, 0x4dffb0, 5, .18, 2.5, 5, .4); dmgNum(x, 2.2, z, amount, '#bff'); sfx.hit(att(x, z) * .7);
        if (hp <= 0) {
          q.dead = true; q.q.dead = true; q.q.hp = 0; map.tiles[ti(q.q.i, q.q.j)] = E; world.remove(q.mesh); q.mat.dispose();
          burst(x, 1, z, 20, 0x2f6d8f, 8, .35, 1, 8, .9); burst(x, 1, z, 12, 0x4dffb0, 7, .2, 3, 8, .7); fx(ringPool, x, .2, z, .4, 3, .4, 0x4dffb0, 2.5); sfx.crate(att(x, z)); if (B[by] && B[by].mine) shake += .25;
        }
        break;
      }
      case 'cr': {
        const k = ti(ev[1], ev[2]), id = crateIdx.get(k); map.tiles[k] = E; if (id === undefined) break; crateIdx.delete(k);
        M4.makeScale(0, 0, 0); crateMesh.setMatrixAt(id, M4); crateMesh.instanceMatrix.needsUpdate = true;
        const x = wx(ev[1]), z = wx(ev[2]); burst(x, 1, z, 16, 0xb9772f, 7, .35, 1, 7, .9); burst(x, .5, z, 6, 0x6e3d12, 5, .25, 1, 5, .8); sfx.crate(att(x, z)); break;
      }
      case 'q': { const [, id, x0, z0, x1, z1] = ev, m = new THREE.Mesh(cubeGeo, cubeMat); m.position.set(x0, 1, z0); scene.add(m); cubes.set(id, { x0, z0, x1, z1, t: 0, m, ph: R() * 6 }); break; }
      case 'p': {
        const c = cubes.get(ev[1]), who = B[ev[2]]; if (!c) break; cubes.delete(ev[1]); scene.remove(c.m);
        burst(c.x1, 1.2, c.z1, 12, 0x35ff8a, 6, .2, 3, 7, .5); if (who) { fx(ringPool, who.x, .2, who.z, .4, 2.4, .35, 0x35ff8a, 2.5); if (who.seen || who.mine) dmgNum(who.x, 3.4, who.z, '+◆', '#5dff9d', true); }
        sfx.pickup(who && who.mine ? 1 : att(c.x1, c.z1) * .4); break;
      }
      case 'g': dom.banner.classList.add('on'); sfx.warn(); later(3600, () => dom.banner.classList.remove('on')); break;
    }
  }
  function ricochet(q) { q.m.rotation.y = Math.atan2(q.vx, q.vz); burst(q.x, 1.15, q.z, 6, q.k.color, 6, .14, 3, 3, .3); fx(ringPool, q.x, 1.1, q.z, .1, .8, .18, q.k.color, 3); sfx.knife(att(q.x, q.z) * .8); }
  function killBullet(q) { scene.remove(q.m); q.m.material.dispose(); bullets.delete(q.id); burst(q.x, 1.1, q.z, 5, q.k.color, 5, .13, 2.6, 3, .3); burst(q.x, 1, q.z, 3, 0xcaa472, 3, .2, 1, 3, .4); }
  function updateBullets(dt) {
    for (const q of bullets.values()) {
      const step = Math.hypot(q.vx, q.vz) * dt, n = Math.max(1, Math.ceil(step / .45)); let dead = false;
      for (let s = 0; s < n && !dead; s++) {
        const px = q.x, pz = q.z; q.x += q.vx * dt / n; q.z += q.vz * dt / n; q.left -= step / n; const t = map.tileAt(q.x, q.z);
        if (blocksShot(t) && !(t === CRATE && q.k.breaks) && !(t === BOX && q.k.pierce)) { if (t !== BOX && q.nb < (q.k.bounce || 0)) { map.bounce(q, px, pz); q.nb++; ricochet(q); } else dead = true; } // a wall stops it here and now (or turns it, with the host's code); who it hits is the host's `bx`
        if (q.left <= 0) dead = true;
      }
      q.m.position.set(q.x, 1.15, q.z); q.trail -= dt;
      if (q.k.flame) { q.age = (q.age || 0) + dt; const g = q.k.r * (1 + q.age * 5); q.m.scale.set(g, g, g); if (q.trail <= 0) { q.trail = .02; spawnP(q.x + RR(-.2, .2), RR(.8, 1.4), q.z + RR(-.2, .2), RR(-1, 1), RR(1, 3), RR(-1, 1), RR(.2, .4), .3, R() < .5 ? 0xffc23a : 0xff5a1a, 3, -.1); } }
      else if (q.k.hook) { const o = B[q.by]; if (o && q.trail <= 0) { q.trail = .02; for (let k = 1; k < 6; k++) spawnP(lerp(o.x, q.x, k / 6), 1.15, lerp(o.z, q.z, k / 6), 0, 0, 0, .14, .05, 0x9adfe8, 2, 0); } } // the chain back to the thrower
      else if (q.trail <= 0) { q.trail = .03; spawnP(q.x, 1.15, q.z, RR(-.5, .5), RR(0, 1), RR(-.5, .5), q.k.r * .7, .22, q.k.color, 2.2, 0); }
      if (dead) killBullet(q);
    }
  }
  function updateBombs(dt) {
    for (let i = bombs.length - 1; i >= 0; i--) {
      const b = bombs[i]; b.t += dt; if (b.t < 0) continue; const f = Math.min(1, b.t / b.dur); b.m.visible = b.mark.visible = true;
      b.m.position.set(lerp(b.x0, b.x1, f), 1.2 + Math.sin(f * Math.PI) * b.h - f * .8, lerp(b.z0, b.z1, f)); b.m.rotation.x += dt * 9; b.mark.material.opacity = .4 + .4 * Math.sin(b.t * 26);
      if (R() < .6) spawnP(b.m.position.x, b.m.position.y + .4, b.m.position.z, RR(-1, 1), 2, RR(-1, 1), .13, .3, 0xffb030, 3, .2);
      if (f < 1) continue;
      scene.remove(b.m, b.mark); b.mark.material.dispose(); bombs.splice(i, 1); explosionFX(b.x1, b.z1, b.radius, b.ice ? 0x9fe8ff : b.mine ? 0x55c8ff : 0xff8a2a); if (b.ice) { sfx.freeze(att(b.x1, b.z1)); burst(b.x1, .8, b.z1, 24, 0xd8f8ff, 9, .26, 3, 6, .9); }
    }
  }
  function updateZones(dt) {
    for (let i = zones.length - 1; i >= 0; i--) {
      const q = zones[i]; q.t -= dt; if (q.t <= 0) { scene.remove(q.m, q.ring); q.m.material.dispose(); q.ring.material.dispose(); zones.splice(i, 1); continue; }
      const fade = Math.min(1, q.t / .6); q.m.material.opacity = (.22 + .1 * Math.sin(G.time * 17 + q.id)) * fade; q.ring.material.opacity = (.6 + .25 * Math.sin(G.time * 11)) * fade;
      for (let k = 0; k < (touch ? 2 : 4); k++) { const a = R() * 6.28, d = Math.sqrt(R()) * q.r; spawnP(q.x + Math.cos(a) * d, .2, q.z + Math.sin(a) * d, RR(-.5, .5), RR(2, 5), RR(-.5, .5), RR(.18, .42), RR(.3, .6), R() < .5 ? 0xffc23a : 0xff5a1a, 3, -.15); }
    }
  }
  function updateTurrets(dt) {
    for (const t of turrets.values()) {
      t.age += dt; t.face += angDiff(t.dir, t.face) * Math.min(1, dt * 18); t.head.rotation.y = t.face; t.recoil = Math.max(0, t.recoil - dt * 8); t.head.position.z = -t.recoil * .15; t.g.scale.setScalar(Math.min(1, t.age * 5) * (1 + t.flash * .1));
      if (t.flash > 0) { t.flash = Math.max(0, t.flash - dt * 7); for (const mt of t.mats) mt.emissive.setRGB(t.flash, t.flash, t.flash); }
    }
  }
  function updateCubes(dt) {
    for (const c of cubes.values()) { c.t += dt; const f = Math.min(1, c.t / CUBE_FLY); c.m.position.set(lerp(c.x0, c.x1, f), .9 + Math.sin(f * Math.PI) * 2.2 + (f >= 1 ? Math.sin(c.t * 3 + c.ph) * .15 : 0), lerp(c.z0, c.z1, f)); c.m.rotation.y += dt * 2.5; c.m.scale.setScalar(1 + Math.sin(G.time * 6 + c.ph) * .08); }
  }

  /* ============================================================ netcode */
  function packSnapshot() {
    const m = { t: 's', mid: session.seed >>> 0, q: ++seq, st: STATES.indexOf(sim.state), tm: r2(sim.time), g: [r2(sim.gas.r), sim.gas.stage, r2(Math.max(0, sim.gas.timer)), sim.gas.phase === 'shrink' ? 1 : 0], ev: outEvents }; outEvents = [];
    if (sim.state === 'pick') { m.pt = Number.isFinite(sim.pickT) ? r2(sim.pickT) : -1; m.pk = sim.picks.map(p => [p.cls, p.ok ? 1 : 0]); } else m.p = sim.brawlers.map(packBrawler);
    if (sim.state === 'result') m.res = sim.result;
    return m;
  }
  function applySnapshot(m) {
    if (!guard.accept(m)) return; const st = STATES[m.st]; if (!st) return; const now = nowSec();
    G.time = +m.tm || 0; if (Array.isArray(m.g)) { G.gasTo = +m.g[0] || 0; G.gasStage = m.g[1] | 0; G.gasT = +m.g[2] || 0; G.gasShrink = !!m.g[3]; }
    if (Array.isArray(m.pk)) { G.picks = m.pk.map(p => ({ cls: p[0] | 0, ok: !!p[1] })); G.pickT = m.pt >= 0 ? +m.pt : Infinity; }
    (m.p || []).forEach((e, i) => {
      const b = B[i], s = unpackBrawler(e); if (!b || !s) return;
      ensureModel(b, s.cls); if (b.human && !s.human) b.human = false;
      Object.assign(b, { hp: s.hp, maxhp: s.maxhp, cubes: s.cubes, ammo: s.ammo, sup: s.sup, kills: s.kills, inGrass: s.inGrass, revealed: s.revealed, dash: s.dash, slow: s.slow, stun: s.stun, burn: s.burn, stealth: s.stealth, haste: s.haste });
      if (s.alive && !b.alive && !b.rank) b.alive = true; // a death arrives as its event, which is never undone by a snapshot
      if (!b.placed) { b.placed = true; b.x = s.x; b.z = s.z; b.dir = b.face = s.dir; if (b.mine) predReset(s.x, s.z); }
      pushSnap(b.buf, { x: s.x, z: s.z, dir: s.dir, mvx: s.mvx, mvz: s.mvz }, now);
      if (b.mine) predReconcile(s, now);
    });
    if (m.res) G.result = m.res;
    if (st !== G.state) setState(st);
    for (const ev of Array.isArray(m.ev) ? m.ev : []) if (Array.isArray(ev)) applyEvent(ev);
  }
  let netAcc = 0, netNow = false;
  function hostNetTick(dt) {
    if (!online) { outEvents.length = 0; return; }
    netAcc += dt; const hz = sim.state === 'pick' || sim.state === 'result' ? 5 : NET_HZ; // nothing moves on the pick and result screens
    if (!netNow && netAcc < 1 / hz - 0.002) return; netAcc = netNow ? 0 : Math.max(0, netAcc - 1 / hz); netNow = false;
    send(packSnapshot());
  }

  /* ---- a client's own body, predicted. Each snapshot puts it where the host has it and replays the last `lag`
     seconds of this player's own stick on top (the input the host had not seen yet when it took the snapshot); `lag`
     is measured from how long an input takes to come back acknowledged. What the correction moves is hidden in an
     offset that decays over a few frames, so the body never jumps. A bull rush and a death are the host's alone. */
  const pred = { x: 0, z: 0, r: .78, ox: 0, oz: 0, lag: .08, hist: [], sentAt: new Map(), seq: 0, last: null, since: 1 };
  function predReset(x, z) { pred.x = x; pred.z = z; pred.ox = pred.oz = 0; pred.hist = []; pred.sentAt.clear(); }
  const predictable = () => !!(me && me.alive && !me.dash && !me.stun && G.state === 'play'); // a rush, a roll, a stun and a hook's drag are the host's to move
  function predMove(mx, mz, dt) { const sp = CLASSES[me.cls].speed * moveMul(me); while (dt > 1e-4) { const d = Math.min(dt, 1 / 30); map.moveBy(pred, mx * sp * d, mz * sp * d); dt -= d; } }
  function predReconcile(s, now) {
    const t = pred.sentAt.get(s.ack); if (t !== undefined) { pred.lag += (clamp(now - t, .02, .4) - pred.lag) * .1; for (const k of pred.sentAt.keys()) if (k <= s.ack) pred.sentAt.delete(k); }
    const oldX = pred.x, oldZ = pred.z; pred.x = s.x; pred.z = s.z;
    if (predictable()) { const from = now - pred.lag, h = pred.hist; for (let k = 0; k < h.length; k++) { const a = Math.max(h[k].t, from), b = k + 1 < h.length ? h[k + 1].t : now; if (b > a && (h[k].mx || h[k].mz)) predMove(h[k].mx, h[k].mz, b - a); } }
    while (pred.hist.length > 1 && pred.hist[1].t <= now - .5) pred.hist.shift();
    pred.ox += oldX - pred.x; pred.oz += oldZ - pred.z; if (Math.hypot(pred.ox, pred.oz) > 3) pred.ox = pred.oz = 0; // too far to be a correction: it was moved
  }
  function clientInput(inp, dt, now) {
    const h = pred.hist, l = h[h.length - 1]; if (!l || l.mx !== inp.mx || l.mz !== inp.mz) h.push({ t: now, mx: inp.mx, mz: inp.mz });
    if (predictable()) predMove(inp.mx, inp.mz, dt);
    pred.since += dt; const p = pred.last, changed = !p || p.mx !== inp.mx || p.mz !== inp.mz || p.fire !== inp.fire || Math.abs(angDiff(p.a, inp.a)) > .02 || Math.abs(p.d - inp.d) > .3;
    if ((changed && pred.since >= 1 / NET_HZ) || pred.since >= .2) { pred.last = { ...inp }; pred.since = 0; pred.sentAt.set(++pred.seq, now); send({ t: 'in', to: hostId, q: pred.seq, x: inp.mx, y: inp.mz, a: inp.a, d: inp.d, f: inp.fire ? 1 : 0 }); }
  }

  /* ---- where every brawler is this frame */
  function syncBrawlers(dt) {
    if (isHost) {
      for (const s of sim.brawlers) { const b = B[s.i]; ensureModel(b, s.cls); b.placed = true; Object.assign(b, { x: s.x, z: s.z, dir: s.dir, mvx: s.mvx, mvz: s.mvz, hp: s.hp, maxhp: s.maxhp, cubes: s.cubes, ammo: s.ammo, sup: s.sup, kills: s.kills, alive: s.alive, inGrass: s.inGrass, revealed: s.reveal > 0, dash: !!s.dash, human: s.human, slow: s.fx.slow > 0, stun: s.fx.stun > 0 || !!s.pull, burn: s.fx.burn > 0, stealth: s.stealth, haste: s.fx.haste > 0 }); }
      G.time = sim.time; G.gasTo = G.gasR = sim.gas.r; G.gasStage = sim.gas.stage; G.gasT = sim.gas.timer; G.gasShrink = sim.gas.phase === 'shrink'; return;
    }
    const rt = nowSec() - INTERP;
    for (const b of B) {
      const s = sampleSnaps(b.buf, rt); if (!s || !b.alive) continue; const { a, b: nx, f } = s;
      if (b.mine && predictable()) { const k = Math.exp(-10 * dt), sp = CLASSES[b.cls].speed * moveMul(b); pred.ox *= k; pred.oz *= k; b.x = pred.x + pred.ox; b.z = pred.z + pred.oz; b.mvx = input.mx * sp; b.mvz = input.mz * sp; b.dir = input.a; continue; }
      if (nx) { b.x = lerp(a.x, nx.x, f); b.z = lerp(a.z, nx.z, f); b.dir = a.dir + angDiff(nx.dir, a.dir) * f; } else { const ex = clamp(rt - a.t, 0, .15); b.x = a.x + a.mvx * ex; b.z = a.z + a.mvz * ex; b.dir = a.dir; }
      b.mvx = a.mvx; b.mvz = a.mvz;
      if (b.mine) { pred.ox = b.x - pred.x; pred.oz = b.z - pred.z; if (!b.dash) b.dir = input.a; } // a bull rush or the countdown is the host's to move: prediction picks up from where this shows me
    }
    G.gasR += (G.gasTo - G.gasR) * Math.min(1, dt * 12); if (G.state === 'play') G.time += dt;
  }
  function animateBrawler(b, dt) {
    const m = b.model; if (!m) return; if (!b.alive) { m.root.visible = false; return; }
    /* tall grass and SHADE's vanish: others disappear unless close (or, in grass, shooting or hit); my own brawler turns translucent instead. A spectator sees everyone. */
    if (!b.mine) { const seen = !(me && me.alive) || !hiddenFrom(b, Math.hypot(b.x - me.x, b.z - me.z)); if (seen !== b.seen) { b.seen = seen; if (b.stealth) burst(b.x, 1.2, b.z, 10, 0x2a1a3a, 4, .4, 1, 4, .7); else burst(b.x, 1, b.z, 6, 0x4f9a2c, 4, .22, 1, 5, .5); } m.root.visible = seen; }
    else { m.root.visible = true; const hid = (b.inGrass && !b.revealed) || b.stealth; if (hid !== b.hid) { b.hid = hid; for (const mt of m.mats) { mt.transparent = hid; mt.opacity = hid ? .5 : 1; mt.needsUpdate = true; } } }
    const c = CLASSES[b.cls], sp = Math.hypot(b.mvx, b.mvz), mv = clamp(sp / c.speed, 0, 1); b.walkT += dt * (4 + sp * 1.5);
    b.face += angDiff(b.dir, b.face) * Math.min(1, dt * 16); m.root.position.set(b.x, 0, b.z); m.root.rotation.y = b.face;
    const sw = Math.sin(b.walkT) * mv; m.legL.rotation.x = sw * .9; m.legR.rotation.x = -sw * .9; m.legL.position.z = sw * .25; m.legR.position.z = -sw * .25;
    m.body.position.y = Math.abs(Math.cos(b.walkT)) * .1 * mv + Math.sin(G.time * 3 + b.walkT * .01) * .025; m.body.position.z = -b.recoil * .22;
    m.body.rotation.x = mv * .12 - b.recoil * .12 + (b.dash ? .5 : 0) + (b.stun ? Math.sin(G.time * 9) * .1 : 0); m.body.rotation.z = Math.sin(b.walkT) * .05 * mv + (b.stun ? Math.cos(G.time * 7) * .12 : 0);
    b.recoil = Math.max(0, b.recoil - dt * 7); b.swing = Math.max(0, b.swing - dt * 4.5);
    if (c.melee) { m.armR.rotation.x = -1.25 - Math.sin(b.swing * Math.PI) * 1.4; m.armR.rotation.y = (b.swing - .5) * 2.4 * (b.swing > 0 ? 1 : 0); } else if (c.lob) m.armR.rotation.x = -1.25 - b.recoil * 1.2;
    if (c.hold === 'dual') { m.armR.rotation.x = -1.25 - b.recoil * .5 - Math.sin(b.swing * Math.PI) * .5; m.armL.rotation.x = -1.25 - b.recoil * .5 + Math.sin(b.swing * Math.PI) * .3; }
    else m.armL.rotation.x = (c.hold === 'two' ? -1.1 : -.3) - sw * .5 * (c.hold === 'two' ? 0 : 1);
    const s = 1 + b.flash * .14; m.root.scale.set(s, 1 / s * (1 + b.flash * .05), s);
    if (b.flash > 0 || b.wasFlash) { b.flash = Math.max(0, b.flash - dt * 7); const f = b.flash * 1.4, sg = b.sup >= 1 ? .12 + .1 * Math.sin(G.time * 8) : 0; for (const mt of m.mats) mt.emissive.setRGB(f + sg, f + sg * .8, f); b.wasFlash = b.flash > 0; }
    else if (b.sup >= 1) { const sg = .14 + .1 * Math.sin(G.time * 8); for (const mt of m.mats) mt.emissive.setRGB(sg, sg * .8, 0); b.glowing = true; } // a charged super glows
    else if (b.glowing) { b.glowing = false; for (const mt of m.mats) mt.emissive.setRGB(0, 0, 0); }
    m.ring.rotation.y = -b.face + G.time; m.ring.scale.setScalar(1 + Math.sin(G.time * 5) * .04);
    /* dust, the bull rush's trail, the green of healing and of the gas: all read off the state, so no events are spent on them */
    if (!m.root.visible) { b.lastHp = b.hp; return; }
    if (mv > .5 && R() < dt * 10) spawnP(b.x, .1, b.z, RR(-1, 1), RR(.5, 1.5), RR(-1, 1), .2, .4, 0xe9bf7c, 1, .3);
    if (b.dash) { spawnP(b.x + RR(-.5, .5), .3, b.z + RR(-.5, .5), RR(-2, 2), RR(1, 3), RR(-2, 2), .35, .5, 0xe9bf7c, 1); spawnP(b.x, 1.2, b.z, RR(-1, 1), 1, RR(-1, 1), .25, .3, 0x7dffb0, 3, 0); }
    if (b.hp > b.lastHp && b.hp < b.maxhp && R() < dt * 8) spawnP(b.x + RR(-.6, .6), RR(.5, 2), b.z + RR(-.6, .6), 0, 2, 0, .14, .5, 0x7dff6b, 2.5, -.1);
    if (b.slow && R() < dt * 16) spawnP(b.x + RR(-.7, .7), RR(1.4, 2.6), b.z + RR(-.7, .7), 0, -.6, 0, .13, .6, 0xbdf3ff, 2.6, .05); // what it is under, read off the flags: frost, flames, stars, speed
    if (b.burn && R() < dt * 26) spawnP(b.x + RR(-.5, .5), RR(.6, 2), b.z + RR(-.5, .5), RR(-.5, .5), RR(2, 4), RR(-.5, .5), RR(.15, .3), .4, R() < .5 ? 0xffc23a : 0xff5a1a, 3, -.15);
    if (b.stun && R() < dt * 22) { const a = G.time * 6 + R() * .6; spawnP(b.x + Math.cos(a) * .8, 3, b.z + Math.sin(a) * .8, 0, .2, 0, .17, .3, 0xffe14d, 3.2, 0); }
    if (b.haste && mv > .3 && R() < dt * 30) spawnP(b.x + RR(-.4, .4), RR(.4, 1.8), b.z + RR(-.4, .4), -b.mvx * .25, 0, -b.mvz * .25, .12, .28, 0xffffff, 2.4, 0);
    if (Math.hypot(b.x, b.z) > G.gasR && R() < dt * 14) spawnP(b.x + RR(-.6, .6), RR(.5, 2), b.z + RR(-.6, .6), 0, 1.5, 0, .2, .5, 0x9dff3a, 2, -.1);
    b.lastHp = b.hp;
  }

  /* ============================================================ gas, sky, camera */
  function updateGas() {
    const r = Math.max(.5, G.state === 'pick' ? GAS_R[0] : G.gasR); gasMesh.scale.set(r, r, 1); gasWall.scale.set(r, 2.6 + Math.sin(G.time * 2) * .3, r);
    const gk = lerp(1, .3, G.night); gasMesh.material.color.setRGB(.35 * gk, .85 * gk, .11 * gk); gasWall.material.color.setRGB(.62 * gk, gk, .23 * gk); gasMesh.material.opacity = .4 + .06 * Math.sin(G.time * 3); gasWall.material.opacity = .16 + .06 * Math.sin(G.time * 4.3);
    if (G.state !== 'play' && G.state !== 'end') return;
    const ca = Math.atan2(listener.z, listener.x), span = Math.min(Math.PI, 34 / Math.max(r, 1)); // puffs along the edge, on the camera's side of it
    for (let k = 0; k < 3; k++) { const a = ca + RR(-span, span), d = r + RR(0, 5); spawnP(Math.cos(a) * d, RR(.3, 1.5), Math.sin(a) * d, RR(-1, 1), RR(1, 3), RR(-1, 1), RR(.3, .65), RR(.8, 1.5), 0x6fd024, .75, -.05); }
  }
  const C3 = h => new THREE.Color(h), lerp3 = (out, a, b, c, t) => t < .5 ? out.lerpColors(a, b, t * 2) : out.lerpColors(b, c, t * 2 - 1);
  const SKY = [C3(0xe8b877), C3(0xd65f38), C3(0x0a0f24)], SUNC = [C3(0xfff0d8), C3(0xffa058), C3(0x31407a)], HS = [C3(0xfff1d0), C3(0xffb98a), C3(0x2c3c7a)], HG = [C3(0xc98a4b), C3(0x9a6048), C3(0x181830)];
  let lampTimer = 0, clockText = '';
  function updateSky(dt, focus) { // the match starts at noon and ends in the dark; the pick screen drifts between the two
    const n = G.night = G.state === 'pick' ? .5 + .5 * Math.sin(performance.now() / 9000) : smooth((G.time - 22) / 100);
    lerp3(scene.background, SKY[0], SKY[1], SKY[2], n); scene.fog.color.copy(scene.background);
    lerp3(sun.color, SUNC[0], SUNC[1], SUNC[2], n); sun.intensity = lerp(2.5, .35, smooth(n * 1.15));
    lerp3(hemi.color, HS[0], HS[1], HS[2], n); lerp3(hemi.groundColor, HG[0], HG[1], HG[2], n); hemi.intensity = lerp(.85, .62, n); moon.intensity = smooth((n - .5) / .4) * 1.1;
    const el = lerp(1.05, .2, smooth(n * 1.3)), az = lerp(.6, 1.5, n);
    sun.position.set(focus.x + Math.cos(el) * Math.cos(az) * 80, Math.sin(el) * 80, focus.z + Math.cos(el) * Math.sin(az) * 80); sun.target.position.set(focus.x, 0, focus.z);
    const L = smooth((n - .3) / .4); if (bloom) bloom.strength = lerp(.7, 1.15, n);
    lampTimer -= dt; if (lampTimer <= 0) { lampTimer = .5; lanterns.sort((a, b) => Math.hypot(a.x - focus.x, a.z - focus.z) - Math.hypot(b.x - focus.x, b.z - focus.z)); LIGHTS.forEach((l, i) => { const q = lanterns[i]; if (q) l.position.set(q.x, q.y + .3, q.z); l.userData.q = q; }); } // the few real lights go to the nearest lanterns
    for (const l of LIGHTS) l.intensity = l.userData.q ? L * (20 + Math.sin(G.time * 9 + l.userData.q.ph) * 2.5 + Math.sin(G.time * 23 + l.userData.q.ph) * 1.5) : 0;
    for (const q of lanterns) q.lamp.material.color.setRGB(1, .62, .22).multiplyScalar(glow(lerp(.7, 2.6, L) + Math.sin(G.time * 9 + q.ph) * .2 * L));
    myLamp.intensity = me && me.alive ? L * 10 : 0; if (me) myLamp.position.set(me.x, 3.4, me.z);
    waterMat.emissiveIntensity = lerp(.5, .9, n) + Math.sin(G.time * 2) * .12; grassU.value = G.time;
    const ct = TX(n < .25 ? 'day' : n < .55 ? 'sunset' : n < .82 ? 'dusk' : 'night'); if (ct !== clockText) { clockText = ct; dom.clock.textContent = ct; }
  }
  const cf = new THREE.Vector3(), camOff = new THREE.Vector3(0, 37, 25);
  const watched = () => { if (me && me.alive) return me; const k = B[G.spectate]; return k && k.alive ? k : B.find(b => b.alive && b.human) || B.find(b => b.alive) || null; };
  /* a dead player picks whom to watch: A / D or the arrow keys, or the ◀ ▶ buttons */
  function cycleWatch(dir) {
    if (!me || me.alive || (G.state !== 'play' && G.state !== 'end')) return; const alive = B.filter(b => b.alive && b.model); if (!alive.length) return;
    const k = alive.indexOf(watched()); G.spectate = alive[((k < 0 ? 0 : k + dir) % alive.length + alive.length) % alive.length].i; sfx.click();
  }
  function updateCamera(dt) {
    if (G.state === 'pick' || !B.some(b => b.placed)) { const t = performance.now() / 1000 * .07; camera.position.set(Math.sin(t) * 46 * view.tall, 34 * view.tall, Math.cos(t) * 46 * view.tall); camera.lookAt(0, 0, 0); listener.x = listener.z = 0; cf.set(0, 0, 0); return; }
    const w = watched(); let fx_ = cf.x, fz = cf.z;
    if (w) { fx_ = w.x; fz = w.z; if (w === me) { fx_ += clamp(Math.sin(input.a) * input.look, -3, 3); fz += clamp(Math.cos(input.a) * input.look, -3, 3); } } // look a little toward where I aim
    const k = 1 - Math.exp(-5 * dt); cf.x += (fx_ - cf.x) * k; cf.z += (fz - cf.z) * k; listener.x = cf.x; listener.z = cf.z;
    shake = Math.max(0, shake - dt * 2.6); const sh = shake * shake * .9;
    camera.position.set(cf.x + camOff.x + RR(-sh, sh), camOff.y * view.tall + RR(-sh, sh) * .6, cf.z + camOff.z * view.tall + RR(-sh, sh)); camera.lookAt(cf.x + RR(-sh, sh) * .3, 0, cf.z - 1.5);
  }

  /* ============================================================ input: keys and the mouse, or the twin sticks on a touch screen.
     `input` is what my brawler is told this frame: the stick (mx, mz), the aim as a world angle `a`, how far away the aim
     point is (`d`, where a lobbed bomb lands), FIRE held, and `look`, how far the camera leans toward the aim. */
  const input = { mx: 0, mz: 0, a: 0, d: 6, fire: false, look: 0 };
  const mouse = { x: 0, y: 0, down: false, seen: false }, aimPt = { x: 0, z: 0 };
  let superAim = false;
  const ray = new THREE.Raycaster(), groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -1), ndc = new THREE.Vector2(), hitV = new THREE.Vector3();
  const canAct = () => !!(session && me && me.alive && G.state === 'play');
  function fireSuper(a, d) { if (!canAct() || me.sup < 1) return; if (isHost) sim.queueSuper(me.i, { a, d }); else send({ t: 'su', to: hostId, a: r2(a), d: r2(d) }); }
  function fireOnce(a, d) { if (!canAct()) return; if (me.ammo < 1) { sfx.empty(); return; } if (isHost) sim.queueFire(me.i, { a, d }); else send({ t: 'fi', to: hostId, a: r2(a), d: r2(d) }); }
  const kb = createInput({ KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', Space: 'super' }, {
    onDown: name => { audio.init(); if (G.state === 'pick' && (name === 'left' || name === 'right')) choose((sel + (name === 'left' ? CLASSES.length - 1 : 1)) % CLASSES.length); if (name === 'super' && canAct() && me.sup >= 1) superAim = true; if (me && !me.alive && (name === 'left' || name === 'right')) cycleWatch(name === 'left' ? -1 : 1); },
    onUp: name => { if (name === 'super' && superAim) { superAim = false; fireSuper(input.a, input.d); } }, // hold SPACE to aim the super, let go to fire it
    onKey: e => {
      if (e.code === 'KeyM') audio.toggle();
      else if (e.code === 'Escape') { if (!online || isHost) hooks.onExit?.(); else showMenu(!dom.pause.classList.contains('show')); } // a guest's Esc opens the menu: leaving is a button there
      else if (e.code === 'KeyR') { if (G.state === 'result') { if (!online || isHost) hooks.onRestart?.(); else toggleRematch(); } } // R sits next to WASD: only the result screen listens to it
      else if (G.state === 'pick') { const n = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus'].indexOf(e.code); if (n >= 0 && n < CLASSES.length) choose(n); else if (e.code === 'Enter') lockIn(); }
    },
  });
  const onPointer = e => { mouse.x = e.clientX - view.left; mouse.y = e.clientY - view.top; mouse.seen = true; };
  if (!touch) {
    canvas.addEventListener('pointermove', onPointer);
    canvas.addEventListener('pointerdown', e => { if (e.button !== 0) return; onPointer(e); audio.init(); try { canvas.setPointerCapture(e.pointerId); } catch {} if (superAim) { superAim = false; fireSuper(input.a, input.d); return; } mouse.down = true; if (canAct() && me.ammo < 1) sfx.empty(); });
    for (const t of ['pointerup', 'pointercancel']) canvas.addEventListener(t, () => { mouse.down = false; });
    canvas.addEventListener('contextmenu', e => e.preventDefault());
  }
  const onBlur = () => { mouse.down = false; superAim = false; };

  /* twin sticks. FIRE and SUPER are aim sticks: the knob follows the thumb, the aim shape is drawn while it is held, the
     shot goes where it pointed on release. Never dragged: a tap, aimed for the player. Dragged and brought back: cancelled. */
  const tc = createTouch();
  const moveS = touch ? tc.pad(dom.pad, { range: 56, dead: 6, axes: 2, onDown: () => audio.init() }) : null;
  const shakeEl = el => { el.classList.remove('nope'); void el.offsetWidth; el.classList.add('nope'); };
  for (const el of [dom.fire, dom.supStick]) el.addEventListener('animationend', () => el.classList.remove('nope'));
  function aimStick(el, isSuper) {
    const st = { pad: null, dragged: false };
    st.pad = tc.pad(el, { range: 52, dead: 12, axes: 2,
      onDown: () => { audio.init(); st.dragged = false; if (!canAct() || (isSuper && me.sup < 1)) shakeEl(el); },
      onUp: p => {
        const mag = Math.hypot(p.ux, p.uy), dragged = st.dragged || mag > 0; st.dragged = false;
        if (!canAct() || !['up', 'touchend', 'lost'].includes(p.last) || (dragged && !mag)) return; // a cancelled touch, or a drag brought back to the middle, shoots nothing
        const aim = mag ? { a: Math.atan2(p.ux, p.uy), d: Math.max(2, mag * CLASSES[me.cls].range) } : autoAim();
        if (isSuper) fireSuper(aim.a, aim.d); else fireOnce(aim.a, aim.d);
      } });
    return st;
  }
  const fireS = touch ? aimStick(dom.fire, false) : null, supS = touch ? aimStick(dom.supStick, true) : null;
  /* a tap aims itself: the nearest enemy in sight and in range, else the nearest power box, else straight ahead */
  function autoAim() {
    const c = CLASSES[me.cls], reach = c.range + (c.melee ? .8 : 0); let best = null, bd = 1e9;
    for (const b of B) { if (!b.alive || b.mine || !b.seen) continue; const d = Math.hypot(b.x - me.x, b.z - me.z); if (d < reach && d < bd && (c.lob || map.losShot(me.x, me.z, b.x, b.z))) { bd = d; best = b; } }
    if (!best) for (const q of boxV) { if (q.dead) continue; const d = Math.hypot(q.q.x - me.x, q.q.z - me.z); if (d < reach + .5 && d < bd) { bd = d; best = q.q; } }
    return best ? { a: Math.atan2(best.x - me.x, best.z - me.z), d: bd } : { a: me.dir, d: c.range * .6 };
  }
  function readInput() {
    const held = kb.held; let mx = (held.right ? 1 : 0) - (held.left ? 1 : 0), mz = (held.down ? 1 : 0) - (held.up ? 1 : 0); const l = Math.hypot(mx, mz); if (l > 1) { mx /= l; mz /= l; }
    input.fire = false; input.look = 0;
    if (touch) {
      if (!mx && !mz && moveS.held) { mx = r2(moveS.x); mz = r2(moveS.y); }
      const s = supS.pad.held ? supS : fireS.pad.held ? fireS : null, mag = s ? Math.hypot(s.pad.x, s.pad.y) : 0; if (s && mag > 0) s.dragged = true;
      if (s && mag > 0 && me) { input.a = Math.atan2(s.pad.x, s.pad.y); input.d = Math.max(2, mag * CLASSES[Math.max(0, me.cls)].range); input.look = 2.5; }
      else if (mx || mz) { input.a = Math.atan2(mx, mz); input.d = 6; } // nothing aimed: face the way I walk
      aiming = !!(s && mag > 0); aimSuper = aiming && s === supS;
    } else if (me && mouse.seen) {
      ndc.set(mouse.x / view.w * 2 - 1, -(mouse.y / view.h) * 2 + 1); ray.setFromCamera(ndc, camera); if (ray.ray.intersectPlane(groundPlane, hitV)) { aimPt.x = hitV.x; aimPt.z = hitV.z; }
      const dx = aimPt.x - me.x, dz = aimPt.z - me.z; input.a = Math.atan2(dx, dz); input.d = Math.hypot(dx, dz); input.look = input.d * .14; input.fire = mouse.down && !superAim; aiming = true; aimSuper = superAim;
    }
    if (superAim && !(canAct() && me.sup >= 1)) superAim = false;
    input.mx = mx; input.mz = mz; input.a = r2(input.a); input.d = r2(input.d);
  }
  let aiming = false, aimSuper = false;

  /* the shape on the ground that shows what the attack will cover: a cone, a line, or a line to a blast circle */
  const aimMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: .3, depthWrite: false, side: THREE.DoubleSide });
  const sector = ang => new THREE.CircleGeometry(1, 20, -Math.PI / 2 - ang / 2, ang).rotateX(-Math.PI / 2);
  const aimLine = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2).translate(0, 0, .5), aimMat), aimCone = new THREE.Mesh(sector(.6), aimMat);
  const aimRing = new THREE.Mesh(new THREE.RingGeometry(.9, 1, 40).rotateX(-Math.PI / 2), aimMat.clone()), aimDisc = new THREE.Mesh(new THREE.CircleGeometry(1, 32).rotateX(-Math.PI / 2), aimMat);
  aimRing.material.opacity = .7; for (const m of [aimLine, aimCone, aimRing, aimDisc]) { m.position.y = .14; m.renderOrder = 8; m.visible = false; scene.add(m); }
  let coneAng = .6;
  function updateAimIndicator() {
    for (const m of [aimLine, aimCone, aimRing, aimDisc]) m.visible = false;
    if (!canAct() || me.dash || !aiming) return;
    const p = me, c = CLASSES[p.cls], a = input.a, sup = aimSuper && p.sup >= 1; aimMat.color.set(sup ? 0xffd23f : p.ammo < 1 ? 0xff6a5a : 0xffffff); aimRing.material.color.copy(aimMat.color); aimMat.opacity = sup ? .42 : .28;
    const line = (w, len) => { aimLine.visible = true; aimLine.position.set(p.x, .14, p.z); aimLine.rotation.y = a; aimLine.scale.set(w, 1, len); };
    const cone = (ang, r) => { if (coneAng !== ang) { coneAng = ang; aimCone.geometry.dispose(); aimCone.geometry = sector(ang); } aimCone.visible = true; aimCone.position.set(p.x, .14, p.z); aimCone.rotation.y = a; aimCone.scale.set(r, 1, r); };
    const sh = sup ? c.supAim : c.aim, ring = (x, z, r, disc) => { aimRing.visible = true; aimDisc.visible = disc; aimRing.position.set(x, .15, z); aimDisc.position.set(x, .14, z); aimRing.scale.set(r, 1, r); aimDisc.scale.set(r, 1, r); };
    if (sh[0] === 'cone') cone(sh[1], sh[2] || c.range); else if (sh[0] === 'arc') cone(c.arc, c.range);
    else if (sh[0] === 'line') line(sh[1], sh[2] || map.rayWall(p.x, p.z, a, c.range)); // an attack's line stops at the wall; a super's runs its length
    else if (sh[0] === 'lob') { const d = Math.min(sh[1], Math.max(2, input.d)); line(.22, d); ring(p.x + Math.sin(a) * d, p.z + Math.cos(a) * d, sh[2], true); }
    else ring(p.x, p.z, 1.7, false); // a super that is about me
  }

  /* ============================================================ HUD, overlay, the pick and result screens */
  function feed(killer, victim) {
    const d = document.createElement('div'); d.className = 'kf' + ((killer && killer.mine) || victim.mine ? ' me' : ''); d.innerHTML = `<b>${killer ? esc(killer.name) : esc(TX('gasKill'))}</b> &nbsp;☠&nbsp; <s>${esc(victim.name)}</s>`;
    dom.feed.prepend(d); while (dom.feed.children.length > 5) dom.feed.lastChild.remove(); later(5200, () => { d.style.opacity = 0; later(700, () => d.remove()); });
  }
  function showCount(text, color) { const c = dom.count; c.textContent = text; c.style.color = color; c.classList.remove('pop'); void c.offsetWidth; c.classList.add('pop'); }
  const hudCache = {};
  const setText = (key, el, text) => { if (hudCache[key] !== text) { hudCache[key] = text; el.textContent = text; } };
  function updateHud(dt) {
    setText('alive', dom.alive, String(B.filter(b => b.alive).length)); const p = me; hurtFlash -= dt;
    const fight = G.state === 'play' || G.state === 'end', last = G.gasStage >= GAS_R.length - 1 && !G.gasShrink; // the gas clock under the day's
    setText('gast', dom.gast, !fight ? '' : G.gasShrink ? TX('gasClosing') : last ? TX('gasFinal') : TX('gasIn', { s: Math.max(0, Math.ceil(G.gasT)) }));
    const hot = fight && (G.gasShrink || (!last && G.gasT <= 5)); if (hudCache.hot !== hot) { hudCache.hot = hot; dom.gast.classList.toggle('hot', hot); }
    if (!p) { dom.vign.className = 'vign'; return; }
    setText('cubes', dom.cubes, String(p.cubes)); setText('kills', dom.kills, String(p.kills));
    const hpw = clamp(p.hp / p.maxhp * 100, 0, 100).toFixed(1) + '%'; if (hudCache.hpw !== hpw) { hudCache.hpw = hpw; dom.hp.firstElementChild.style.width = hpw; } setText('hp', dom.hp.lastElementChild, Math.max(0, Math.ceil(p.hp)) + ' / ' + p.maxhp);
    dom.ammo.forEach((el, i) => { const f = clamp(p.ammo - i, 0, 1), k = 'am' + i, w = Math.round(f * 100) + '%'; if (hudCache[k] !== w) { hudCache[k] = w; el.firstElementChild.style.width = w; el.classList.toggle('full', f >= 1); } });
    const pct = Math.round(p.sup * 100), ready = p.sup >= 1 && p.alive, st = `${pct}|${ready}|${superAim}`;
    if (hudCache.sup !== st) {
      if (ready && hudCache.ready === false) sfx.ready(); hudCache.ready = ready; hudCache.sup = st;
      for (const el of [dom.sup, dom.supStick]) { el.style.setProperty('--p', pct + '%'); el.classList.toggle('ready', ready); }
      dom.sup.firstElementChild.innerHTML = ready ? TX(superAim ? 'supRelease' : 'supReady') : TX('supPct', { n: pct });
    }
    dom.vign.className = 'vign' + (p.alive && Math.hypot(p.x, p.z) > G.gasR ? ' gas' : '') + (hurtFlash > 0 ? ' hurt' : '');
    const w = !p.alive && G.state !== 'result' ? watched() : null, spec = w ? TX('watching', { r: p.rank || '?', name: w.name.toUpperCase() }) + (touch ? '' : '   ' + TX('watchKeys')) : '';
    if (hudCache.spec !== spec) { hudCache.spec = spec; dom.spec.textContent = spec; dom.spec.hidden = !spec; dom.specnav.hidden = !spec; }
    if (touch) { const dim = !canAct(); if (hudCache.dim !== dim) { hudCache.dim = dim; dom.fire.classList.toggle('dim', dim); dom.supStick.classList.toggle('dim', dim); } }
  }
  function project(x, y, z) { V.set(x, y, z).project(camera); return V.z > 1 ? null : { x: (V.x + 1) / 2 * ov.width, y: (1 - V.y) / 2 * ov.height }; }
  function rrect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }
  function drawOverlay(dt) { // names, health bars and damage numbers, drawn in 2D over the scene
    const g = octx, k = view.dpr; g.clearRect(0, 0, ov.width, ov.height); if (G.state === 'pick') return;
    g.textAlign = 'center'; g.lineJoin = 'round';
    for (const q of boxV) { if (q.dead || q.hp >= q.q.maxhp) continue; const s = project(q.q.x, 2.4, q.q.z); if (!s) continue; const w = 46 * k; g.fillStyle = '#000c'; rrect(g, s.x - w / 2 - 2 * k, s.y - 2 * k, w + 4 * k, 9 * k, 4 * k); g.fill(); g.fillStyle = '#4dffb0'; rrect(g, s.x - w / 2, s.y, w * clamp(q.hp / q.q.maxhp, 0, 1), 5 * k, 2.5 * k); g.fill(); }
    for (const t of turrets.values()) { const s = project(t.x, 2.6, t.z); if (!s) continue; const w = 46 * k; g.fillStyle = '#000c'; rrect(g, s.x - w / 2 - 2 * k, s.y - 2 * k, w + 4 * k, 9 * k, 4 * k); g.fill(); g.fillStyle = t.mine ? '#4be04b' : '#ff4b3e'; const f = clamp(t.hp / t.maxhp, 0, 1); if (f > 0) { rrect(g, s.x - w / 2, s.y, Math.max(5 * k, w * f), 5 * k, 2.5 * k); g.fill(); } }
    for (const b of B) {
      if (!b.alive || !b.model || (!b.mine && !b.seen)) continue; const s = project(b.x, 3.5, b.z); if (!s) continue; const w = 66 * k, h = 9 * k, x = s.x - w / 2, y = s.y;
      g.font = `900 ${13 * k}px "Arial Black",Arial,${CJK},sans-serif`; g.lineWidth = 4 * k; g.strokeStyle = '#000'; g.strokeText(b.name, s.x, y - 6 * k); g.fillStyle = b.mine ? '#5fe0ff' : b.human ? hex(b.shirt) : '#fff'; g.fillText(b.name, s.x, y - 6 * k);
      g.fillStyle = '#000d'; rrect(g, x - 2 * k, y - 2 * k, w + 4 * k, h + 4 * k, 5 * k); g.fill();
      const f = clamp(b.hp / b.maxhp, 0, 1); g.fillStyle = b.mine ? '#4be04b' : '#ff4b3e'; if (f > 0) { rrect(g, x, y, Math.max(h, w * f), h, 3.5 * k); g.fill(); }
      g.fillStyle = 'rgba(255,255,255,.35)'; g.fillRect(x + 2 * k, y + k, Math.max(0, w * f - 4 * k), 2 * k);
      g.font = `900 ${9 * k}px Arial,${CJK},sans-serif`; g.lineWidth = 3 * k; g.strokeText(Math.ceil(b.hp), s.x, y + h - k); g.fillStyle = '#fff'; g.fillText(Math.ceil(b.hp), s.x, y + h - k);
      if (b.cubes) { g.font = `900 ${12 * k}px Arial,${CJK},sans-serif`; g.lineWidth = 4 * k; const t = '◆' + b.cubes; g.strokeText(t, x + w + 16 * k, y + h); g.fillStyle = '#4dffa0'; g.fillText(t, x + w + 16 * k, y + h); }
      if (b.sup >= 1 && !b.mine) { g.fillStyle = '#ffd23f'; g.beginPath(); g.arc(x - 9 * k, y + h / 2, 5 * k, 0, 7); g.fill(); g.lineWidth = 2 * k; g.stroke(); }
      if (b.mine) for (let i = 0; i < 3; i++) { const aw = (w - 4 * k) / 3, fa = clamp(b.ammo - i, 0, 1); g.fillStyle = '#000c'; g.fillRect(x + i * (aw + 2 * k), y + h + 4 * k, aw, 5 * k); g.fillStyle = fa >= 1 ? '#ffb627' : '#a86a10'; g.fillRect(x + i * (aw + 2 * k) + k, y + h + 5 * k, (aw - 2 * k) * fa, 3 * k); }
    }
    safeArrow(g, k);
    for (let i = dmgNums.length - 1; i >= 0; i--) {
      const d = dmgNums[i]; d.life -= dt; if (d.life <= 0) { dmgNums.splice(i, 1); continue; } d.y += dt * 2.4; d.x += d.vx * dt; const s = project(d.x, d.y, d.z); if (!s) continue;
      const t = d.life / .9, sz = (d.big ? 24 : 17) * k * (1 + Math.max(0, t - .8) * 4); g.globalAlpha = Math.min(1, t * 3); g.font = `900 ${sz}px "Arial Black",Arial,${CJK},sans-serif`; g.lineWidth = 5 * k; g.strokeStyle = '#000'; g.strokeText(d.text, s.x, s.y); g.fillStyle = d.color; g.fillText(d.text, s.x, s.y); g.globalAlpha = 1;
    }
  }

  /* out in the gas, an arrow shows the way back: on the edge of the screen (or over the safe ground, once that is in view), pointing
     at the middle of the arena where every safe zone is, with how far it is to the edge of the gas */
  function safeArrow(g, k) {
    if (!me || !me.alive || (G.state !== 'play' && G.state !== 'end')) return; const dc = Math.hypot(me.x, me.z), out = dc - G.gasR; if (out <= 0 || dc < .5) return;
    const s0 = project(me.x, 1, me.z), s1 = project(me.x - me.x / dc * 4, 1, me.z - me.z / dc * 4); if (!s0 || !s1) return;
    let ux = s1.x - s0.x, uy = s1.y - s0.y; const l = Math.hypot(ux, uy) || 1; ux /= l; uy /= l;
    const m = 64 * k, W = ov.width, H = ov.height, sx = clamp(s0.x, m, W - m), sy = clamp(s0.y, m, H - m);
    let t = Math.min(ux > 0 ? (W - m - sx) / ux : ux < 0 ? (m - sx) / ux : 1e9, uy > 0 ? (H - m - sy) / uy : uy < 0 ? (m - sy) / uy : 1e9);
    const tgt = project(me.x - me.x / dc * (out + 2), 1, me.z - me.z / dc * (out + 2)); if (tgt) t = Math.min(t, Math.max(70 * k, Math.hypot(tgt.x - s0.x, tgt.y - s0.y)));
    const ax = sx + ux * t, ay = sy + uy * t, a = Math.atan2(uy, ux), p = 1 + .12 * Math.sin(G.time * 10), r = 22 * k * p;
    g.save(); g.translate(ax, ay); g.rotate(a); g.beginPath(); g.moveTo(r, 0); g.lineTo(-r * .7, r * .75); g.lineTo(-r * .35, 0); g.lineTo(-r * .7, -r * .75); g.closePath();
    g.lineWidth = 4 * k; g.strokeStyle = '#000'; g.stroke(); g.fillStyle = '#9dff3a'; g.fill(); g.restore();
    const text = TX('safeDist', { d: Math.ceil(out) }), lx = ax - ux * 40 * k, ly = ay - uy * 40 * k + 5 * k;
    g.font = `900 ${14 * k}px "Arial Black",Arial,${CJK},sans-serif`; g.lineWidth = 4 * k; g.strokeStyle = '#000'; g.strokeText(text, lx, ly); g.fillStyle = '#d6ff9d'; g.fillText(text, lx, ly);
  }

  /* ---- the pick screen: a small card per brawler (its portrait, drawn once by a throwaway renderer, its name and role), and under them
     what the chosen one does: attack, super, passive and its five bars. ← → or 1..9, 0, - choose on a keyboard. */
  let sel = 0, locked = false; try { sel = clamp(Number(localStorage.getItem(PICK_KEY)) | 0, 0, CLASSES.length - 1); } catch {}
  {
    const tmp = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true }); tmp.setSize(460, 240, false); tmp.toneMapping = THREE.ACESFilmicToneMapping;
    const sc2 = new THREE.Scene(); sc2.add(new THREE.HemisphereLight(0xffffff, 0x886644, 1.6)); const dl = new THREE.DirectionalLight(0xffffff, 2.8); dl.position.set(3, 6, 5); sc2.add(dl);
    const cam = new THREE.PerspectiveCamera(30, 460 / 240, .1, 50); cam.position.set(2.6, 3.2, 6.2); cam.lookAt(0, 1.35, 0);
    CLASSES.forEach((c, i) => {
      const m = makeModel(i, c.color); m.ring.visible = false; m.root.rotation.y = .5; sc2.add(m.root); tmp.render(sc2, cam); sc2.remove(m.root);
      const el = document.createElement('div'); el.className = 'pcard'; el.innerHTML = '<canvas width="460" height="240"></canvas><div class="words"></div>';
      el.querySelector('canvas').getContext('2d').drawImage(tmp.domElement, 0, 0); el.onclick = () => choose(i); dom.cards.appendChild(el);
      m.root.traverse(o => { if (o.material) o.material.dispose(); });
    });
    tmp.dispose(); tmp.forceContextLoss?.();
  }
  /* the cards' words, and the chosen brawler's panel with its five bars (sim.js statBars: speed and reload are spread over the brawlers) */
  const STAT_COL = ['#ff5a4d', '#4da3ff', '#ffc93f', '#6bff8a', '#ff9df0'], STAT_KEY = ['st.hp', 'st.range', 'st.dmg', 'st.speed', 'st.reload'];
  function cardWords() { [...dom.cards.children].forEach((el, i) => { const id = CLASSES[i].id; el.querySelector('.words').innerHTML = `<h3 class="stroke">${esc(TX('n.' + id))}</h3><div class="role">${esc(TX('role.' + id))}</div>`; }); }
  function pickInfo() {
    const c = CLASSES[sel], id = c.id;
    dom.pinfo.innerHTML = `<div class="ptext"><h3 class="stroke" style="color:${hex(c.color)}">${esc(TX('n.' + id))} <small>${esc(TX('role.' + id))}</small></h3><p>${esc(TX('atk.' + id))}</p><p class="psup">${esc(TX('sup.' + id))}</p><p class="ppas"><b>${esc(TX('passive'))}</b> ${esc(TX('pas.' + id))}</p></div><div class="pbars">`
      + statBars(c).map((v, k) => `<div class="stat"><b>${esc(TX(STAT_KEY[k]))}</b><i><u style="width:${Math.round(v * 100)}%;background:${STAT_COL[k]}"></u></i></div>`).join('') + '</div>';
  }
  function sendPick() { if (!session) return; const slot = roster.find(s => s.pid === myId); if (!slot) return; if (isHost) { sim.pick(slot.i, sel, locked); netNow = true; } else send({ t: 'pk', to: hostId, c: sel, ok: locked ? 1 : 0 }); }
  function choose(i) { if (locked || G.state !== 'pick') return; sel = i; audio.init(); sfx.click(); try { localStorage.setItem(PICK_KEY, String(i)); } catch {} renderPick(); dom.cards.children[i]?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' }); sendPick(); }
  function lockIn() { if (locked || G.state !== 'pick') return; locked = true; audio.init(); sfx.click(); renderPick(); sendPick(); }
  function renderPick() {
    [...dom.cards.children].forEach((el, k) => { el.classList.toggle('sel', k === sel); el.classList.toggle('off', locked && k !== sel); }); pickInfo();
    dom.lock.disabled = locked; dom.lock.textContent = TX(locked ? 'lockedIn' : online ? 'lockIn' : 'play');
  }
  function updatePickStatus() {
    if (G.state !== 'pick' || !online) { setText('pstat', dom.pstat, ''); return; }
    const picks = isHost ? sim.picks : G.picks, humans = roster.filter(s => s.human), ok = humans.filter(s => picks[s.i] && picks[s.i].ok).length, t = isHost ? sim.pickT : G.pickT;
    setText('pstat', dom.pstat, Number.isFinite(t) ? TX('pstatT', { ok, n: humans.length, s: Math.max(0, Math.ceil(t)) }) : TX('pstat', { ok, n: humans.length }));
  }
  dom.lock.addEventListener('click', lockIn);

  /* the result card. Solo and the host: play again or leave. A guest: ask for a rematch (the host sees how many did) or leave the room. */
  let rematchOn = false, votes = [];
  function renderResults() {
    const res = G.result || [], mine = me ? res.find(r => r[0] === me.i) : null, first = res[0] ? B[res[0][0]] : null, win = !!(mine && mine[1] === 1);
    dom.endT.textContent = TX(win ? 'victory' : mine ? 'defeated' : 'over'); dom.endT.className = 'endT stroke ' + (win ? 'win' : 'lose');
    dom.endR.textContent = (mine ? TX('rankOf', { r: mine[1], n: res.length }) : '') + (first && !win ? `${mine ? ' · ' : ''}${TX('wins', { name: first.name.toUpperCase() })}` : '');
    dom.table.innerHTML = `<tr><th>#</th><th></th><th>${esc(TX('thBrawler'))}</th><th>⚔</th><th>◆</th><th>${esc(TX('thDamage'))}</th></tr>` + res.map(([i, rank, kills, cb, dealt]) => { const b = B[i]; if (!b) return ''; return `<tr class="${b.mine ? 'me' : ''}"><td>${rank}</td><td><span class="sw" style="background:${hex(b.shirt)}"></span></td><td>${esc(b.name)}${b.human ? '' : ' 🤖'} <small>${b.cls >= 0 ? esc(TX('n.' + CLASSES[b.cls].id)) : ''}</small></td><td>${kills}</td><td>${cb}</td><td>${dealt}</td></tr>`; }).join('');
    const f = dom.foot; f.innerHTML = ''; const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.type = 'button'; b.textContent = label; b.onclick = fn; f.appendChild(b); }, key = k => touch ? '' : `  (${k})`;
    if (!online) { btn(TX('playAgain') + key('R'), 'primary', () => hooks.onRestart?.()); btn(TX('menuBtn') + key('ESC'), '', () => hooks.onExit?.()); }
    else if (isHost) { btn(TX('playAgain') + key('R'), 'primary', () => hooks.onRestart?.()); btn(TX('toLobby') + key('ESC'), '', () => hooks.onExit?.()); }
    else { btn(TX(rematchOn ? 'rematchOn' : 'rematch') + key('R'), rematchOn ? 'on' : 'primary', toggleRematch); btn(TX('leave'), '', () => hooks.onLeave?.()); const w = document.createElement('div'); w.className = 'wait'; w.textContent = TX('waitHost'); f.appendChild(w); }
    renderVotes();
  }
  function renderVotes() { const n = online && isHost && G.state === 'result' ? votes.length : 0; dom.votes.hidden = !n; if (n) dom.votes.textContent = n === 1 ? TX('votes1') : TX('votes', { n }); }
  function toggleRematch() { if (!online || isHost || G.state !== 'result') return; rematchOn = !rematchOn; sfx.click(); hooks.onRematch?.(rematchOn); renderResults(); if (dom.pause.classList.contains('show')) renderMenu(); }
  function showResults() {
    const res = G.result || [], mine = me ? res.find(r => r[0] === me.i) : null, win = !!(mine && mine[1] === 1);
    renderResults(); dom.end.hidden = false; (win ? sfx.win : sfx.lose)();
    if (win) for (let k = 0; k < 5; k++) later(k * 350, () => { const a = R() * 6.28; explosionFX(me.x + Math.cos(a) * 5, me.z + Math.sin(a) * 5, 2.5, [0xffd23f, 0xff4fd8, 0x55c8ff][k % 3]); });
  }
  /* the match's stages, as the screen follows them: the host reads them off its simulation, a client off the snapshots */
  function setState(st) {
    G.state = st; G.slow = st === 'end' ? .3 : 1; root.classList.toggle('over', st === 'result' || st === 'pick');
    dom.pick.hidden = st !== 'pick'; dom.hud.hidden = st === 'pick'; dom.end.hidden = st !== 'result';
    if (st === 'pick') renderPick();
    if (st === 'countdown') { tc.releaseAll(); if (me) cf.set(me.x, 0, me.z); }
    if (st === 'end' || st === 'result') { superAim = false; mouse.down = false; tc.releaseAll(); }
    if (st === 'result') showResults();
  }

  /* ☰ (and a guest's Esc): a card with what M, R and Esc do on a keyboard, the language, and a guest's way out; the round keeps running underneath */
  function renderMenu() {
    const f = dom.pauseBtns; f.innerHTML = ''; const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.type = 'button'; b.textContent = label; b.onclick = fn; f.appendChild(b); };
    btn(TX('resume'), 'primary', () => showMenu(false)); btn(TX(audio.muted ? 'soundOff' : 'soundOn'), '', () => { audio.toggle(); renderMenu(); }); btn(TX('lang'), '', () => nextLang());
    if (!online || isHost) { btn(TX(!online ? 'restart' : 'playAgain'), '', () => { showMenu(false); hooks.onRestart?.(); }); btn(TX(!online ? 'quit' : 'toLobby'), '', () => { showMenu(false); hooks.onExit?.(); }); }
    else { if (G.state === 'result') btn(TX(rematchOn ? 'rematchOn' : 'rematch'), '', toggleRematch); btn(TX('leave'), '', () => { showMenu(false); hooks.onLeave?.(); }); }
  }
  function showMenu(on) { dom.pause.classList.toggle('show', on); if (on) { tc.releaseAll(); renderMenu(); } }
  dom.menuBtn.addEventListener('click', () => { audio.init(); showMenu(!dom.pause.classList.contains('show')); }); dom.pause.addEventListener('click', e => { if (e.target === dom.pause) showMenu(false); });

  /* ============================================================ main loop. The simulation advances by the wall clock (`simAt`): from the frame
     loop while the tab is visible and, for an online host, from a worker timer while it is hidden, so the round goes on for everyone else. */
  let simAt = 0, acc = 0;
  function step(now) {
    const dt = clamp((now - simAt) / 1000, 0, .05); simAt = now; readInput();
    if (isHost) {
      if (me) sim.setInput(me.i, { mx: input.mx, mz: input.mz, a: input.a, d: input.d, fire: input.fire, q: 0 });
      acc += dt; let n = 0; while (acc >= STEP && n < 4) { sim.step(STEP); acc -= STEP; n++; } if (n === 4) acc = 0;
      if (sim.events.length) { for (const ev of sim.events) { applyEvent(ev); if (online) outEvents.push(ev); } sim.events.length = 0; }
      if (sim.state !== G.state) { if (sim.state === 'result') G.result = sim.result; if (sim.state !== 'pick') syncBrawlers(0); setState(sim.state); netNow = true; }
      hostNetTick(dt);
    } else if (me && me.placed) clientInput(input, dt, nowSec());
    return dt;
  }
  const ticker = createTicker(NET_HZ, () => { if (session && online && isHost && document.hidden) step(performance.now()); });
  const loop = createLoop((real, now) => {
    if (!session) return;
    const raw = step(now), dt = raw * G.slow; quality.sample(real);
    if (G.state !== 'pick') syncBrawlers(raw); else updatePickStatus();
    for (const b of B) animateBrawler(b, dt);
    updateBullets(dt); updateBombs(dt); updateZones(dt); updateTurrets(dt); updateCubes(dt); updateGas();
    for (const q of boxV) { if (q.dead) continue; if (q.flash > 0 || q.shake > 0) { q.flash = Math.max(0, q.flash - dt * 6); q.shake = Math.max(0, q.shake - dt); q.mat.emissiveIntensity = 1 + q.flash * 5; q.mesh.position.x = q.q.x + RR(-1, 1) * q.shake * .4; q.mesh.scale.setScalar(1 + q.flash * .08); } else q.mat.emissiveIntensity = 1 + Math.sin(G.time * 3 + q.q.i) * .35; }
    updateAimIndicator(); updateParticles(dt); updateFX(dt); updateCamera(raw); updateSky(dt, cf);
    if (bloomOn()) composer.render(); else renderer.render(scene, camera);
    drawOverlay(dt); if (G.state !== 'pick') updateHud(raw);
    sfx.music(G.state === 'play' || G.state === 'end', G.gasStage, B.reduce((n, b) => n + (b.alive ? 1 : 0), 0));
  });

  /* ============================================================ session API */
  function start(s) {
    session = s; isHost = !!s.isHost; online = !!s.online; hostId = s.hostId; myId = s.myId;
    clearMatch(); map = makeMap(s.seed >>> 0); buildWorld(); roster = buildRoster(s); B = roster.map(makeViewBrawler); me = B.find(b => b.mine) || null;
    sim = isHost ? createSim({ map, roster, opts: s.opts || {}, online }) : null;
    guard = createSnapGuard(s.seed >>> 0); seq = 0; outEvents = []; netAcc = 0; netNow = true; acc = 0; simAt = performance.now(); predReset(0, 0); pred.seq = 0; pred.last = null; pred.since = 1; pred.lag = .08;
    Object.assign(G, { state: null, time: 0, gasR: GAS_R[0], gasTo: GAS_R[0], gasStage: 0, gasT: 0, gasShrink: false, slow: 1, picks: [], pickT: Infinity, result: null, spectate: -1 }); for (const k of Object.keys(hudCache)) delete hudCache[k];
    locked = false; input.mx = input.mz = 0; input.fire = false; mouse.down = false; dom.count.textContent = ''; dom.banner.classList.remove('on'); dom.spec.hidden = true;
    rematchOn = false; votes = []; dom.votes.hidden = true; dom.specnav.hidden = true; keysLine();
    setState('pick'); sendPick(); showMenu(false); audio.init(); kb.attach(); if (touch) tc.attach(); addEventListener('blur', onBlur); fit(); loop.start(); if (online && isHost) ticker.start(); else ticker.stop();
  }
  function stop() {
    session = null; sfx.music(false, 0, 99); kb.detach(); tc.detach(); removeEventListener('blur', onBlur); ticker.stop(); loop.stop(); showMenu(false); clearMatch(); sim = null; dom.end.hidden = true;
  }
  function destroy() {
    stop(); offLang(); ticker.dispose(); sfx.dispose(); ro?.disconnect(); removeEventListener('resize', fit);
    const seen = new Set(); scene.traverse(o => { for (const r of [o.geometry, ...[].concat(o.material || [])]) if (r && !seen.has(r)) { seen.add(r); r.dispose(); } });
    for (const r of [...Object.values(geoCache), postMat, bulletGeo, bombGeo, bombMat, iceMat, discGeo, cubeGeo, cubeMat, markGeo, sandTex, crateTex, boxTex, boxEmis]) r.dispose();
    composer?.dispose?.(); renderer.dispose(); renderer.forceContextLoss?.(); root.remove(); mount.innerHTML = ''; unloadCss();
    if (window.__showdown === debug) delete window.__showdown;
  }
  function playerLeft(pid) { if (!session || !isHost) return; const slot = roster.find(s => s.pid === pid); if (slot) { sim.toAI(slot.i); netNow = true; } } // clients learn it from the next snapshot
  function onNetMessage(msg) {
    if (!session) return;
    if (!isHost) { if (msg.t === 's' && msg.from === hostId) applySnapshot(msg); return; }
    const slot = roster.find(s => s.pid !== null && s.pid === msg.from); if (!slot || !slot.human) return;
    switch (msg.t) {
      case 'pk': { const p = cleanPick(msg); sim.pick(slot.i, p.cls, p.ok); netNow = true; break; }
      case 'in': sim.setInput(slot.i, cleanInput(msg)); break;
      case 'fi': sim.queueFire(slot.i, cleanShot(msg)); break;
      case 'su': sim.queueSuper(slot.i, cleanShot(msg)); break;
    }
  }
  function rematchVotes(ids) { votes = Array.isArray(ids) ? ids : []; renderVotes(); }
  /* words: every `data-t`, the cards, the keyboard line and whatever card is up, again whenever the language changes */
  function keysLine() { dom.keys.innerHTML = touch ? '' : TX('keys', { esc: TX(online && isHost ? 'kLobby' : 'kMenu') }); }
  function words() {
    for (const el of root.querySelectorAll('[data-t]')) el.textContent = TX(el.dataset.t);
    cardWords(); keysLine(); clockText = ''; for (const k of Object.keys(hudCache)) if (k !== 'ready') delete hudCache[k];
    if (session) { renderPick(); updatePickStatus(); if (G.state === 'result') renderResults(); }
    if (dom.pause.classList.contains('show')) renderMenu();
  }
  words(); const offLang = onLang(words);
  dom.specnav.addEventListener('click', e => { const b = e.target.closest('button'); if (b) cycleWatch(b.hasAttribute('data-sprev') ? -1 : 1); });
  const debug = { G, get B() { return B; }, get me() { return me; }, get sim() { return sim; }, get session() { return session; }, get map() { return map; }, input, pred, view, quality, packSnapshot, applySnapshot, loop,
    touch: { on: touch, move: moveS, fire: fireS, sup: supS, showMenu }, choose, lockIn, cycleWatch, words };
  window.__showdown = debug;
  return { start, stop, destroy, onNetMessage, playerLeft, rematchVotes, debug };
}
