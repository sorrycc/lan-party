/* Fable Theft Auto 5.1 - a voxel crime sandbox. Game module for the LAN party shell; the contract is documented
   at the top of games/kart/index.js.

   Netcode: host-authoritative. The host's browser runs the whole city (sim.js) for every player. The other
   players send their input bits, camera angles and one-shot actions to the host (`in` / `a`, addressed with
   `to`) and render the host's 30 Hz delta snapshots (`s`) a little in the past (remote.js). One-shot events
   ride inside the snapshots and every machine plays its own particles and sounds from them; the camera, the
   HUD, the minimap route and the scenery animation are local. Solo play is the host path without a network.

   Files: world.js (the city + pools), entities.js (how peds/cars draw), sim.js (the host's simulation),
   remote.js (a client's copy), fx.js (particles/decals/tracers), font.js (the bitmap font). */
import * as THREE from 'three';
import { clamp, lerp } from '../../core/math.js';
import { esc, hex, loadStylesheet } from '../../core/ui.js';
import { createInput } from '../../core/input.js';
import { createLoop } from '../../core/loop.js';
import { AVATARS } from '../../core/avatars.js';
import { buildWorld, computeCamera, districtAt, streetAt, nearestNode, bfsRoute, PLAZA, HOSPITAL, X, MAP, dist2, angDiff, PI, TAU } from './world.js';
import { WEAPONS } from './entities.js';
import { createFx } from './fx.js';
import { createSim, IN, HINT, MISSION_STATES, OBJECTIVES, INTRO_T, START_CLOCK } from './sim.js';
import { createRemote, parseBlock, INTERP } from './remote.js';
import { createPredictor } from './predict.js';
import { ptext, textW, wrapText, ICONS, drawIcon } from './font.js';

const NET_HZ = 30;
const BRIEF = "Vinny 'Snitch' Voxel sold out the crew to the LPPD. He's hiding at Diamond Plaza downtown with hired muscle. Make him disappear.";
const CONTROLS = [['WASD', 'move / drive'], ['MOUSE', 'look / aim'], ['CLICK', 'shoot'], ['1 2 3', 'switch weapon (or the wheel)'], ['R', 'reload'], ['F', 'enter / exit car'], ['SHIFT', 'sprint'], ['SPACE', 'jump / handbrake'], ['M', 'sound on / off'], ['F3 / I', 'stats panel'], ['L', 'graphics detail'], ['ESC', 'pause']];
/* graphics detail levels; the auto mode steps down when the frame rate stays low */
const QUALITY = [{ name: 'HIGH', pr: 1.5, shadow: 2048 }, { name: 'MEDIUM', pr: 1, shadow: 1024 }, { name: 'LOW', pr: 1, shadow: 0 }];
const HTML = `<canvas class="gl"></canvas><canvas class="hud"></canvas>
<div class="overlay" hidden><div class="card"><h1 data-title></h1><div class="sub" data-sub></div><div class="controls" data-controls></div><table class="score" data-score hidden></table><div class="foot" data-foot></div></div></div>`;
const rr = (a, b) => a + Math.random() * (b - a);
const r3 = v => Math.round(v * 1000) / 1000;
const fmtClock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/* ============================================================ sound - the original synth on the shell's shared AudioContext */
function createSfx(audio) {
  let noise = null, noiseCtx = null;
  const ctxOf = () => { const ctx = audio.ctx; if (!ctx || audio.muted) return null;
    if (noiseCtx !== ctx) { const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = buf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; noise = buf; noiseCtx = ctx; }
    return ctx; };
  const hiss = (dur, freq, vol, q = 0.7) => { const ctx = ctxOf(); if (!ctx || vol <= 0.001) return;
    const src = ctx.createBufferSource(); src.buffer = noise; const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = freq; f.Q.value = q;
    const g = ctx.createGain(); const t = ctx.currentTime; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f); f.connect(g); g.connect(audio.master); src.start(t); src.stop(t + dur + 0.05); };
  const tone = (f0, f1, dur, vol, type = 'sine', delay = 0) => { const ctx = ctxOf(); if (!ctx || vol <= 0.001) return;
    const o = ctx.createOscillator(); o.type = type; const t = ctx.currentTime + delay;
    o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    o.connect(g); g.connect(audio.master); o.start(t); o.stop(t + dur + 0.05); };
  return {
    shot(kind, vol = 1) {
      if (vol <= 0.02) return;
      if (kind === 'shotgun') { hiss(0.35, 700, 0.9 * vol); tone(140, 40, 0.2, 0.5 * vol, 'square'); }
      else if (kind === 'smg') { hiss(0.08, 2400, 0.45 * vol); tone(300, 90, 0.06, 0.25 * vol, 'square'); }
      else { hiss(0.16, 1500, 0.6 * vol); tone(240, 60, 0.12, 0.35 * vol, 'square'); }
    },
    reload() { tone(900, 600, 0.05, 0.15, 'square'); tone(600, 1200, 0.06, 0.15, 'square', 0.18); },
    hurt() { tone(180, 90, 0.18, 0.3, 'sawtooth'); },
    scream(vol = 1) { tone(700 + Math.random() * 300, 250, 0.35, 0.18 * vol, 'sawtooth'); },
    crash(vol = 1) { hiss(0.3, 500, clamp(vol, 0.1, 1)); tone(90, 30, 0.25, 0.4 * clamp(vol, 0.1, 1), 'square'); },
    explode(vol = 1) { hiss(1.2, 250, 1.2 * vol, 1.5); tone(70, 20, 0.9, 0.7 * vol, 'sawtooth'); },
    cash() { tone(1200, 1200, 0.08, 0.25, 'square'); tone(1800, 1800, 0.12, 0.25, 'square', 0.09); },
    wanted() { tone(500, 500, 0.12, 0.3, 'square'); tone(380, 380, 0.16, 0.3, 'square', 0.14); },
    wasted() { tone(220, 40, 1.6, 0.5, 'sawtooth'); },
    passed() { [523, 659, 784, 1046].forEach((f, i) => tone(f, f, 0.22, 0.28, 'square', i * 0.14)); },
    enter() { tone(300, 200, 0.12, 0.2, 'square'); },
    horn(vol = 1) { tone(420, 420, 0.4, 0.3 * vol, 'sawtooth'); tone(330, 330, 0.4, 0.2 * vol, 'sawtooth'); },
    pickup() { tone(880, 1320, 0.1, 0.2, 'square'); },
    click() { tone(1500, 800, 0.03, 0.15, 'square'); },
  };
}
function disposeScene(scene) {
  scene.traverse(o => {
    if (o.geometry) o.geometry.dispose();
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) { for (const v of Object.values(m)) if (v && v.isTexture) v.dispose(); m.dispose(); }
  });
}

export async function create({ mount, audio, send, hooks }) {
  const unloadCss = await loadStylesheet('/games/gta/gta.css');
  const root = document.createElement('div'); root.className = 'gta'; root.innerHTML = HTML; mount.appendChild(root);
  const $ = sel => root.querySelector(sel);
  const glCanvas = $('canvas.gl'), hudCanvas = $('canvas.hud'), hctx = hudCanvas.getContext('2d');
  const ov = { el: $('.overlay'), title: $('[data-title]'), sub: $('[data-sub]'), controls: $('[data-controls]'), score: $('[data-score]'), foot: $('[data-foot]') };

  /* ---- renderer, scene, the city */
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.BasicShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.3, 1600);
  const W = buildWorld({ THREE, scene });
  const fx = createFx({ W });
  const sfx = createSfx(audio);
  const V3 = new THREE.Vector3();
  function sizeHud() { const dpr = Math.min(window.devicePixelRatio || 1, 2); hudCanvas.width = Math.round(innerWidth * dpr); hudCanvas.height = Math.round(innerHeight * dpr); hctx.setTransform(dpr, 0, 0, dpr, 0, 0); hctx.imageSmoothingEnabled = false; }
  const onResize = () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); sizeHud(); };
  addEventListener('resize', onResize); sizeHud();

  /* ---- continuous voices: my car's engine and the nearest siren */
  let eng = null;
  const unsubAudio = audio.whenReady((ctx, master) => {
    const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 60;
    const filter = ctx.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 400;
    const gain = ctx.createGain(); gain.gain.value = 0; osc.connect(filter); filter.connect(gain); gain.connect(master); osc.start();
    const siren = ctx.createOscillator(); siren.type = 'triangle'; siren.frequency.value = 700;
    const sirenGain = ctx.createGain(); sirenGain.gain.value = 0; siren.connect(sirenGain); sirenGain.connect(master); siren.start();
    eng = { ctx, osc, gain, siren, sirenGain };
  });

  /* ---- session + local state */
  let sim = null, remote = null, session = null, isHost = false, online = false, hostId = null, myId = null, myIdx = 0, me = null, clients = [];
  let state = 'idle'; // idle | grab (click to play) | play | paused | over
  let camYaw = 0, camPitch = 0.22, mouseIdle = 10, fallbackMouse = false, lockPending = 0, lastMX = null, lastMY = null;
  let t = 0, roundT = 0, fps = 60, clock = START_CLOCK.morning;
  let dmgFlash = 0, wantedFlash = 0, areaT = 0, curDistrict = '', curStreet = '', routeT = 0, route = [], routeTarget = null, wasDead = false;
  const floats = [];
  let clicks = 0, fireHeld = false, netAcc = 0, lastIn = null, sinceIn = 0, pred = null, localFireT = 0, localArm = 0;
  const timing = { frame: 0, sim: 0, render: 0, hud: 0 };
  const net = { inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0, rateIn: 0, kbIn: 0, rateOut: 0, kbOut: 0, at: 0, hostFps: 0 };
  let showStats = false, quality = 0, autoQuality = true, lowFpsT = 0;
  function setQuality(i, manual) {
    quality = clamp(i | 0, 0, QUALITY.length - 1); if (manual) { autoQuality = false; try { localStorage.setItem('lan_gta_quality', String(quality)); } catch {} }
    const q = QUALITY[quality]; renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pr)); renderer.setSize(innerWidth, innerHeight);
    W.sun.castShadow = q.shadow > 0;
    if (q.shadow > 0 && W.sun.shadow.mapSize.x !== q.shadow) { W.sun.shadow.mapSize.set(q.shadow, q.shadow); if (W.sun.shadow.map) { W.sun.shadow.map.dispose(); W.sun.shadow.map = null; } }
  }
  { let saved = null; try { saved = localStorage.getItem('lan_gta_quality'); } catch {} if (saved !== null && QUALITY[+saved]) setQuality(+saved, true); }
  const cam = { x: 0, y: 5, z: 0, dx: 0, dy: 0, dz: 1, lx: 0, ly: 0, lz: 1 };
  /* the view model the camera, HUD and audio read; filled from the sim (host) or the snapshot store (client) */
  const V = { me: null, subj: { x: 0, y: 0, z: 0, inCar: null, dead: false }, car: null, timeLeft: -1, phase: 0, ms: 0, vin: null, cops: [], players: [], blocks: [] };
  const playerColor = i => (AVATARS[(session.players[i] || {}).avatar] || AVATARS[0]).color;
  function hostView() {
    const P = me.ped;
    V.blocks = sim.players.map(p => parseBlock(sim.block(p))); V.me = V.blocks[myIdx];
    V.subj.x = P ? P.x : 0; V.subj.y = P ? P.y : 0; V.subj.z = P ? P.z : 0; V.subj.inCar = P ? P.inCar : null; V.subj.dead = !P || P.dead; V.car = P ? P.inCar : null;
    V.timeLeft = sim.S.unlimited ? -1 : sim.S.timeLeft; V.phase = sim.S.phase === 'over' ? 1 : 0; V.ms = MISSION_STATES.indexOf(sim.mission.state);
    const v = sim.mission.vinny; V.vin = v && !v.released ? { x: v.x, z: v.z, dead: v.dead } : null;
    V.cops.length = 0; for (const c of sim.cops) if (!c.dead && !c.released) V.cops.push({ x: c.x, z: c.z, car: false }); for (const c of sim.cars) if (c.ai === 'cop' && !c.dead) V.cops.push({ x: c.x, z: c.z, car: true });
    V.players.length = 0; sim.players.forEach((p, i) => V.players.push({ name: p.name, color: playerColor(i), x: p.ped ? p.ped.x : 0, y: p.ped ? p.ped.y : 0, z: p.ped ? p.ped.z : 0, gone: p.gone, dead: p.dead, me: i === myIdx }));
    clock = sim.S.clockH;
  }
  function clientView() {
    const R = remote.R; V.blocks = R.P; V.me = R.P[myIdx] || null;
    const e = V.me ? remote.get(V.me.pedId) : null, car = V.me && V.me.carId >= 0 ? remote.get(V.me.carId) : null;
    V.subj.x = e ? e.x : 0; V.subj.y = e ? e.y : 0; V.subj.z = e ? e.z : 0; V.subj.inCar = car || null; V.subj.dead = !e || e.dead; V.car = car || null;
    V.timeLeft = R.timeLeft; V.phase = R.phase; V.ms = R.ms; V.vin = R.vin ? { x: R.vin[0], z: R.vin[1], dead: !!R.vin[2] } : null;
    V.cops.length = 0; for (const en of R.ents.values()) { if (en.cls === 'ped' && en.kind === 'cop' && !en.dead) V.cops.push({ x: en.x, z: en.z, car: false }); else if (en.cls === 'car' && en.type.cop && en.lights && !en.dead) V.cops.push({ x: en.x, z: en.z, car: true }); }
    V.players.length = 0; session.players.forEach((p, i) => { const b = R.P[i], pe = b ? remote.get(b.pedId) : null; V.players.push({ name: p.name, color: playerColor(i), x: pe ? pe.x : 0, y: pe ? pe.y : 0, z: pe ? pe.z : 0, gone: !!(b && b.gone), dead: !!(b && b.dead), me: i === myIdx }); });
    if (R.got) clock = R.clock;
  }

  /* ---- events from the simulation (host: as they happen; client: from the snapshots) -> local effects and sounds */
  const floatText = (text, color) => floats.push({ text, color, t: 0 });
  const mine = idx => idx === myIdx;
  function onEvent(ev) {
    const mx = V.subj.x, mz = V.subj.z, d2 = (x, z) => dist2(x, z, mx, mz), near = (x, z) => d2(x, z) < 350 * 350, vol = (x, z, range) => clamp(1 - Math.sqrt(d2(x, z)) / range, 0, 1);
    switch (ev[0]) {
      case 'shot': { const [, who, key, x, y, z, hits] = ev; const n = near(x, z), predicted = mine(who) && !isHost; // a client already played its own shot
        if (n) { if (!predicted) fx.burst.flash(x, y, z); for (const h of hits) { fx.addTracer(x, y, z, h[0], h[1], h[2]); if (h[3] === 1) fx.burst.blood(h[0], h[1], h[2]); else if (h[3] === 2) fx.burst.sparks(h[0], h[1], h[2]); else if (h[3] === 3) fx.burst.dust(h[0], h[1], h[2]); } }
        if (!predicted) { sfx.shot(key, mine(who) ? 1 : vol(x, z, 120)); if (mine(who)) camPitch -= WEAPONS.find(w => w.key === key).recoil; } break; }
      case 'nshot': { const [, sx, sy, sz, tx, ty, tz, carHit] = ev; if (near(sx, sz)) { fx.burst.flash(sx, sy, sz, 0.35); fx.addTracer(sx, sy, sz, tx, ty, tz); if (carHit) fx.burst.sparks(tx, ty, tz, 1); } sfx.shot('pistol', vol(sx, sz, 70) * 0.7); break; }
      case 'die': { const [, x, z] = ev; if (near(x, z)) { fx.bloodSplat(x, z, 1); fx.burst.death(x, 0, z); sfx.scream(clamp(1 - d2(x, z) / 3600, 0.05, 1)); } break; }
      case 'blood': if (near(ev[1], ev[2])) fx.bloodSplat(ev[1], ev[2], 1); break;
      case 'runover': if (near(ev[1], ev[2])) fx.bloodSplat(ev[1], ev[2], 2, ev[3]); break;
      case 'explode': { const [, x, y, z] = ev; if (near(x, z)) fx.burst.explosion(x, y, z); sfx.explode(vol(x, z, 260)); break; }
      case 'crash': { const [, x, y, z, imp, n] = ev; if (near(x, z)) fx.burst.crash(x, y, z, n || 6); const v = clamp(imp / 20, 0.15, 1) * clamp(1 - d2(x, z) / 4000, 0, 1); if (v > 0.02) sfx.crash(v); break; }
      case 'horn': if (d2(ev[1], ev[2]) < 2500) sfx.horn(); break;
      case 'hurt': if (mine(ev[1])) { dmgFlash = Math.min(1, dmgFlash + ev[2] / 25); sfx.hurt(); } break;
      case 'wasted': if (mine(ev[1])) sfx.wasted(); break;
      case 'respawn': if (mine(ev[1])) { camYaw = 0; camPitch = 0.22; } break;
      case 'wanted': if (mine(ev[1])) { wantedFlash = 3; sfx.wanted(); } break;
      case 'float': if (ev[1] === -1 || mine(ev[1])) floatText(ev[2], ev[3]); break;
      case 'pickup': if (mine(ev[1])) { if (ev[2] === 'cash') { sfx.cash(); floatText('+$' + ev[3], 0x3dff7a); } else if (ev[2] === 'ammo') { sfx.pickup(); floatText('AMMO', 0xffe14d); } else { sfx.pickup(); floatText('+HEALTH', 0xff4d4d); } } break;
      case 'click': if (mine(ev[1])) sfx.click(); break;
      case 'enter': if (mine(ev[1])) sfx.enter(); break;
      case 'reload': if (mine(ev[1])) sfx.reload(); break;
      case 'passed': sfx.passed(); break;
      case 'over': showOver(); break;
    }
  }

  /* ---- input */
  const act = (a, n) => { if (state !== 'play') return; if (isHost) { if (sim) sim.action(me, a, n); } else send({ t: 'a', to: hostId, a, n }); };
  const curW = () => V.me ? V.me.curW : 0;
  const kb = createInput({ KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', ShiftLeft: 'sprint', ShiftRight: 'sprint', Space: 'space' }, {
    onKey: e => {
      if (e.code === 'Escape') { if (state === 'play' && fallbackMouse) pause(); else if (state === 'paused') grab(); return; }
      if (e.code === 'KeyM') { audio.toggle(); return; }
      if (e.code === 'F3' || e.code === 'KeyI') { e.preventDefault(); showStats = !showStats; return; }
      if (e.code === 'KeyL') { // HIGH -> MEDIUM -> LOW -> AUTO
        if (autoQuality) setQuality(0, true); else if (quality < QUALITY.length - 1) setQuality(quality + 1, true); else { autoQuality = true; setQuality(0); try { localStorage.removeItem('lan_gta_quality'); } catch {} }
        floatText((autoQuality ? 'AUTO' : QUALITY[quality].name) + ' DETAIL', 0x9fb4dc); return; }
      if (state !== 'play') return;
      if (e.code === 'KeyF' || e.code === 'KeyE') act('use');
      else if (e.code === 'KeyR') act('reload');
      else if (e.code === 'Digit1') act('weapon', 0); else if (e.code === 'Digit2') act('weapon', 1); else if (e.code === 'Digit3') act('weapon', 2);
      else if (e.code === 'KeyQ') act('weapon', curW() + 1);
    },
  });
  const held = kb.held;
  function readInput() {
    let m = 0;
    if (state === 'play') { if (held.up) m |= IN.UP; if (held.down) m |= IN.DOWN; if (held.left) m |= IN.LEFT; if (held.right) m |= IN.RIGHT; if (held.sprint) m |= IN.SPRINT; if (held.space) m |= IN.SPACE; if (fireHeld) m |= IN.FIRE; }
    return { m, y: camYaw, p: camPitch, c: clicks };
  }
  const onMouseDown = e => {
    if (e.target && e.target.closest && e.target.closest('button')) return;
    if (state === 'grab' || state === 'paused') { if (e.button === 0) grab(); return; }
    if (state !== 'play') return;
    if (e.button === 0) { fireHeld = true; clicks++; localShot(false); }
  };
  /* a client plays its own shot the moment it clicks; the host's 'shot' event for it then only adds the tracer and the impact */
  function localShot(auto) {
    const me = V.me; if (isHost || state !== 'play' || !me || me.dead || me.carId >= 0 || me.reloadT > 0 || localFireT > 0) return;
    const w = WEAPONS[me.curW]; if (w.auto !== auto || me.ammo <= 0) return;
    localFireT = w.rate; localArm = 1.6; sfx.shot(w.key, 1); camPitch -= w.recoil;
    const fx0 = Math.sin(camYaw), fz0 = Math.cos(camYaw), sj = V.subj; fx.burst.flash(sj.x - fz0 * 0.39 + fx0 * 0.75, sj.y + 1.32 - camPitch * 0.5, sj.z + fx0 * 0.39 + fz0 * 0.75);
  }
  const onMouseUp = e => { if (e.button === 0) fireHeld = false; };
  const onMouseMove = e => {
    let dx = e.movementX || 0, dy = e.movementY || 0;
    if (!document.pointerLockElement) { if (lastMX !== null && !dx && !dy) { dx = e.clientX - lastMX; dy = e.clientY - lastMY; } lastMX = e.clientX; lastMY = e.clientY; }
    if (state !== 'play') return;
    if (!document.pointerLockElement && !fallbackMouse) return;
    camYaw -= dx * 0.0022; camPitch = clamp(camPitch + dy * 0.0018, -0.45, 1.1); mouseIdle = 0;
  };
  const onWheel = e => { if (state === 'play') act('weapon', curW() + (e.deltaY > 0 ? 1 : -1)); };
  const onContext = e => e.preventDefault();
  /* a lock request can fail (Chrome refuses one right after an Esc exit): go back to the card so the next click retries;
     only a browser that never grants the lock at all drops into the mouse-delta fallback */
  let lockFails = 0;
  const onLockChange = () => { if (document.pointerLockElement === root) { lockFails = 0; lockPending = 0; } else if (state === 'play' && !fallbackMouse && lockPending <= 0) pause(); };
  const onLockError = () => { lockPending = 0; if (++lockFails >= 3) fallbackMouse = true; else pause(); };
  root.addEventListener('mousedown', onMouseDown); root.addEventListener('contextmenu', onContext);
  addEventListener('mouseup', onMouseUp); addEventListener('mousemove', onMouseMove); addEventListener('wheel', onWheel, { passive: true });
  document.addEventListener('pointerlockchange', onLockChange); document.addEventListener('pointerlockerror', onLockError);

  /* ---- pointer lock: "click to play" at the start of a round, pause when the lock is lost */
  function grab() {
    if (state !== 'grab' && state !== 'paused') return;
    state = 'play'; ov.el.hidden = true; audio.init(); kb.reset();
    if (!fallbackMouse && !document.pointerLockElement) {
      lockPending = 0.8;
      try { const p = root.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { fallbackMouse = true; }
    }
  }
  function pause() { if (state !== 'play') return; state = 'paused'; fireHeld = false; kb.reset(); showOverlay('paused'); }
  function showOver() { if (state === 'over' || state === 'idle') return; state = 'over'; fireHeld = false; kb.reset(); if (document.pointerLockElement === root) document.exitPointerLock(); showOverlay('over'); }

  /* ---- overlays: click to play / paused / time's up */
  function button(label, cls, fn) { const b = document.createElement('button'); b.className = 'btn small ' + cls; b.textContent = label; b.onclick = fn; ov.foot.appendChild(b); return b; }
  function showOverlay(kind) {
    ov.el.hidden = false; ov.foot.innerHTML = ''; ov.score.hidden = kind !== 'over'; ov.controls.hidden = kind === 'over';
    ov.controls.innerHTML = CONTROLS.map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('');
    const restart = !online || isHost, exitLabel = !online ? 'MENU' : 'BACK TO LOBBY';
    if (kind === 'grab') {
      ov.title.innerHTML = 'FABLE THEFT AUTO <b>5.1</b>'; ov.sub.textContent = 'LOS PIXELES  ·  CLICK TO PLAY';
      const f = document.createElement('div'); f.textContent = 'MISSION: THE DOWNTOWN HIT'; f.style.color = '#ffe14d'; ov.foot.appendChild(f);
    } else if (kind === 'paused') {
      ov.title.textContent = 'PAUSED'; ov.sub.textContent = online ? 'THE CITY KEEPS RUNNING WITHOUT YOU  ·  CLICK TO RESUME' : 'CLICK TO RESUME';
      button('RESUME', 'good', grab);
      if (restart) { button(!online ? 'RESTART' : 'RESTART FOR EVERYONE', '', () => hooks.onRestart?.()); button(exitLabel, '', () => hooks.onExit?.()); }
    } else {
      ov.title.textContent = "TIME'S UP"; ov.sub.textContent = 'FINAL STANDINGS  ·  MOST CASH WINS';
      const rows = V.blocks.map((b, i) => ({ b, i, name: (session.players[i] || {}).name || '?', color: playerColor(i) })).sort((a, c) => (c.b.cash - a.b.cash) || (c.b.kills - a.b.kills));
      ov.score.innerHTML = rows.map((r, k) => `<tr class="${r.i === myIdx ? 'me' : ''}"><td>${k + 1}</td><td><span class="sw" style="background:${hex(r.color)}"></span>${esc(r.name)}${r.b.gone ? '<span class="left">LEFT</span>' : ''}</td><td class="n cash">$${r.b.cash}</td><td class="n kills">${r.b.kills} kills</td></tr>`).join('');
      if (restart) { button('PLAY AGAIN', 'primary', () => hooks.onRestart?.()); button(exitLabel, '', () => hooks.onExit?.()); }
      else ov.foot.textContent = 'WAITING FOR THE HOST TO PLAY AGAIN OR RETURN TO THE LOBBY…';
    }
  }

  /* ---- networking glue */
  function hostNetTick(dt) {
    netAcc += dt; if (netAcc < 1 / NET_HZ) return; netAcc = 0;
    sim.prepareNet();
    for (const c of clients) if (!c.pl.gone) { const msg = sim.snapshotFor(c); msg.hf = Math.round(fps); send(msg); count(netStats.out, 's'); net.outMsgs++; net.outBytes += JSON.stringify(msg).length; }
    sim.endNet();
  }
  /* while playing, every frame carries an input (with its sequence number for the predictor); otherwise only changes and a keepalive */
  function clientSendInput(inp, dt) {
    sinceIn += dt;
    const changed = !lastIn || lastIn.m !== inp.m || lastIn.c !== inp.c || Math.abs(lastIn.y - inp.y) > 0.002 || Math.abs(lastIn.p - inp.p) > 0.002;
    const due = state === 'play' ? sinceIn >= 1 / 65 : (changed && sinceIn >= 1 / 60) || sinceIn >= 0.25;
    if (due) { lastIn = { ...inp }; sinceIn = 0; send({ t: 'in', to: hostId, m: inp.m, y: r3(inp.y), p: r3(inp.p), c: inp.c, q: inp.q || 0 }); count(netStats.out, 'in'); net.outMsgs++; net.outBytes += 64; }
  }

  /* ---- per-frame local work: camera, sky, scenery, effects, audio, area names, minimap route */
  function carAmbient(dt) {
    const list = isHost ? sim.cars : remote.ents.values();
    for (const c of list) { if (c.cls !== 'car' || c.released) continue; const fx0 = Math.sin(c.yaw), fz0 = Math.cos(c.yaw), l = c.type.l;
      if (c.smoking && !c.dead && Math.random() < dt * 12) fx.spawnParticle(c.x + fx0 * l * 0.4, c.y + 1, c.z + fz0 * l * 0.4, rr(-0.5, 0.5), rr(1, 2.5), rr(-0.5, 0.5), 0x444444, rr(0.3, 0.7), rr(0.8, 1.6), true);
      if (c.burn > 0 && Math.random() < dt * 25) fx.spawnParticle(c.x + rr(-1, 1), c.y + 1.2, c.z + rr(-1.5, 1.5), rr(-0.5, 0.5), rr(2, 5), rr(-0.5, 0.5), Math.random() < 0.6 ? [0xff8a20, 0xffc020, 0xff3010][Math.floor(Math.random() * 3)] : 0x222222, rr(0.3, 0.8), rr(0.5, 1.2), true); }
  }
  function updateAudio() {
    if (!eng) return; const ctx = eng.ctx, c = V.car, playing = state === 'play' || (online && state !== 'idle');
    const thr = c ? ((held.up || held.down) && state === 'play' ? 1 : 0) : 0;
    eng.gain.gain.setTargetAtTime(playing && c && !c.dead ? 0.045 + thr * 0.03 : 0, ctx.currentTime, 0.1);
    if (c) eng.osc.frequency.setTargetAtTime(45 + c.speed * 5.5 + thr * 20, ctx.currentTime, 0.05);
    let near = 0; for (const cp of V.cops) if (cp.car) near = Math.max(near, 1 - Math.hypot(cp.x - V.subj.x, cp.z - V.subj.z) / 160);
    eng.sirenGain.gain.setTargetAtTime(playing ? clamp(near, 0, 1) * 0.035 : 0, ctx.currentTime, 0.1);
    eng.siren.frequency.setTargetAtTime(Math.floor(t * 2.5) % 2 ? 620 : 900, ctx.currentTime, 0.05);
  }
  function localFrame(dt) {
    if (lockPending > 0) { lockPending -= dt; if (lockPending <= 0 && !document.pointerLockElement && state === 'play') fallbackMouse = true; }
    if (V.subj.dead) { camYaw += dt * 0.35; camPitch = lerp(camPitch, 0.75, dt); }
    else if (V.car && mouseIdle > 1.0) { const c = V.car; const target = c.vF < -1 ? c.yaw + PI : c.yaw; camYaw += angDiff(target, camYaw) * Math.min(1, 2.2 * dt); camPitch = lerp(camPitch, 0.22, dt); }
    computeCamera(W, V.subj, camYaw, camPitch, cam); camera.position.set(cam.x, cam.y, cam.z); camera.lookAt(cam.lx, cam.ly, cam.lz);
    W.dayNight(clock, V.subj.x, V.subj.z, camera); W.animate(dt, t, camera); fx.update(dt); carAmbient(dt); updateAudio();
    W.plazaMarker.visible = V.ms < 2; W.plazaMarker.rotation.y += dt; W.plazaMarker.material.opacity = 0.3 + Math.sin(roundT * 4) * 0.15;
    const d = districtAt(V.subj.x, V.subj.z), s = streetAt(V.subj.x, V.subj.z);
    if (d !== curDistrict) { curDistrict = d; curStreet = s; areaT = 5; } else if (s !== curStreet) { curStreet = s; areaT = Math.max(areaT, 3.5); }
    routeT -= dt;
    if (routeT <= 0) { routeT = 0.6; const ms = MISSION_STATES[V.ms]; const tgt = ms === 'goto' || ms === 'intro' ? PLAZA : ms === 'hit' && V.vin ? V.vin : null; route = tgt ? bfsRoute(nearestNode(V.subj.x, V.subj.z), nearestNode(tgt.x, tgt.z)) : []; routeTarget = tgt; }
    areaT -= dt; wantedFlash -= dt; dmgFlash = Math.max(0, dmgFlash - dt * 1.4); mouseIdle += dt; localFireT -= dt; localArm -= dt;
    if (autoQuality && state === 'play' && roundT > 4) { if (fps < 40) { lowFpsT += dt; if (lowFpsT > 2 && quality < QUALITY.length - 1) { setQuality(quality + 1); lowFpsT = 0; floatText('LOW FRAME RATE: ' + QUALITY[quality].name + ' DETAIL', 0x9fb4dc); } } else lowFpsT = 0; }
    for (let k = floats.length - 1; k >= 0; k--) { floats[k].t += dt; if (floats[k].t > 2.5) floats.splice(k, 1); }
    if (V.phase === 1 && state !== 'over') showOver();
  }

  /* ---- HUD on the 2D canvas */
  const wx = v => (v + MAP.MOFF) * MAP.MS;
  function drawMinimap(x, y, size) {
    const cx = x + size / 2, cy = y + size / 2, me = V.subj;
    hctx.save(); hctx.fillStyle = 'rgba(0,0,0,0.55)'; hctx.fillRect(x - 4, y - 4, size + 8, size + 8);
    hctx.beginPath(); hctx.rect(x, y, size, size); hctx.clip();
    hctx.translate(cx, cy); hctx.rotate(camYaw + PI);
    hctx.translate(-(me.x + MAP.MOFF) * MAP.MS, -(me.z + MAP.MOFF) * MAP.MS);
    if (W.mapCanvas) hctx.drawImage(W.mapCanvas, 0, 0);
    if (route.length > 1) { hctx.strokeStyle = '#d64fd6'; hctx.lineWidth = 4; hctx.beginPath(); hctx.moveTo(wx(me.x), wx(me.z));
      for (const [i, j] of route) hctx.lineTo(wx(X(i)), wx(X(j))); if (routeTarget) hctx.lineTo(wx(routeTarget.x), wx(routeTarget.z)); hctx.stroke(); }
    if (routeTarget) { hctx.fillStyle = '#ffe14d'; hctx.fillRect(wx(routeTarget.x) - 6, wx(routeTarget.z) - 6, 12, 12); }
    hctx.fillStyle = '#ffffff'; hctx.fillRect(wx(HOSPITAL.x) - 6, wx(HOSPITAL.z - 10) - 6, 12, 12); hctx.fillStyle = '#e02020'; hctx.fillRect(wx(HOSPITAL.x) - 4, wx(HOSPITAL.z - 10) - 1.5, 8, 3); hctx.fillRect(wx(HOSPITAL.x) - 1.5, wx(HOSPITAL.z - 10) - 4, 3, 8);
    for (const c of V.cops) { if (c.car) { hctx.fillStyle = Math.floor(t * 6) % 2 ? '#4d7fff' : '#ff4d4d'; hctx.fillRect(wx(c.x) - 5, wx(c.z) - 5, 10, 10); } else { hctx.fillStyle = '#4d7fff'; hctx.beginPath(); hctx.arc(wx(c.x), wx(c.z), 4, 0, TAU); hctx.fill(); } }
    if (V.vin && !V.vin.dead && MISSION_STATES[V.ms] === 'hit') { hctx.fillStyle = '#ff4d4d'; hctx.beginPath(); hctx.arc(wx(V.vin.x), wx(V.vin.z), 5, 0, TAU); hctx.fill(); }
    for (const p of V.players) if (!p.me && !p.gone) { hctx.fillStyle = hex(p.color); hctx.fillRect(wx(p.x) - 5, wx(p.z) - 5, 10, 10); hctx.strokeStyle = '#fff'; hctx.lineWidth = 1.5; hctx.strokeRect(wx(p.x) - 5, wx(p.z) - 5, 10, 10); }
    hctx.restore();
    hctx.save(); hctx.translate(cx, cy); hctx.fillStyle = '#ffffff'; hctx.beginPath(); hctx.moveTo(0, -9); hctx.lineTo(6, 7); hctx.lineTo(0, 4); hctx.lineTo(-6, 7); hctx.closePath(); hctx.fill(); hctx.restore();
    const th = camYaw + PI, nx = Math.sin(th), ny = -Math.cos(th);
    const ax = cx + nx * (size / 2 - 14), ay = cy + ny * (size / 2 - 14);
    hctx.fillStyle = '#ff3333'; hctx.beginPath(); hctx.arc(ax, ay, 9, 0, TAU); hctx.fill(); ptext(hctx, 'N', ax, ay - 5, 2, '#ffffff', 'center', false);
    hctx.strokeStyle = '#ffffff'; hctx.lineWidth = 2; hctx.strokeRect(x, y, size, size);
  }
  function bar(x, y, w, h, f, color) { hctx.fillStyle = 'rgba(0,0,0,0.7)'; hctx.fillRect(x - 2, y - 2, w + 4, h + 4); hctx.fillStyle = '#333'; hctx.fillRect(x, y, w, h); hctx.fillStyle = color; hctx.fillRect(x, y, w * clamp(f, 0, 1), h); }
  function drawNames(Wd, Hd, s) {
    for (const p of V.players) { if (p.me || p.gone) continue; const d = Math.hypot(p.x - V.subj.x, p.z - V.subj.z); if (d > 120) continue;
      V3.set(p.x, p.y + 2.15, p.z).project(camera); if (V3.z > 1 || V3.x < -1.2 || V3.x > 1.2 || V3.y < -1.2 || V3.y > 1.2) continue;
      const sx = (V3.x + 1) / 2 * Wd, sy = (1 - V3.y) / 2 * Hd, sc = s * clamp(1.4 - d / 60, 0.55, 1.1);
      ptext(hctx, p.name, sx, sy - 7 * sc, sc, p.dead ? '#888888' : hex(p.color), 'center'); }
  }
  function drawHUD() {
    const Wd = innerWidth, Hd = innerHeight; hctx.clearRect(0, 0, Wd, Hd);
    const s = Math.max(2, Math.round(Wd / 640)), me = V.me;
    if (!me) { ptext(hctx, 'WAITING FOR THE HOST…', Wd / 2, Hd / 2, s, '#ffffff', 'center'); return; }
    const dead = me.dead, inCar = me.carId >= 0, deadT = dead ? Math.max(0, 5.5 - me.wastedT) : 0;
    const lowHp = me.health < 30 && !dead ? 0.12 + 0.08 * Math.sin(t * 6) : 0;
    if (dmgFlash > 0 || lowHp) { const a = clamp(dmgFlash * 0.65 + lowHp, 0, 0.85); const g = hctx.createRadialGradient(Wd / 2, Hd / 2, Hd * 0.2, Wd / 2, Hd / 2, Hd * 0.8); g.addColorStop(0, `rgba(190,0,0,${a * 0.35})`); g.addColorStop(1, `rgba(190,0,0,${a})`); hctx.fillStyle = g; hctx.fillRect(0, 0, Wd, Hd); }
    drawNames(Wd, Hd, s);
    if (!inCar && !dead && state === 'play') { hctx.fillStyle = '#ffffff'; hctx.fillRect(Wd / 2 - 1, Hd / 2 - 9, 2, 6); hctx.fillRect(Wd / 2 - 1, Hd / 2 + 3, 2, 6); hctx.fillRect(Wd / 2 - 9, Hd / 2 - 1, 6, 2); hctx.fillRect(Wd / 2 + 3, Hd / 2 - 1, 6, 2); }
    // top-right: stars, clock, cash, health, weapon, kills, round timer
    const rx = Wd - 16; let y = 14;
    for (let k = 0; k < 5; k++) { const on = k < me.wanted; const blink = on && wantedFlash > 0 && Math.floor(t * 8) % 2 === 0; ptext(hctx, '*', rx - (4 - k) * s * 8, y, s * 1.3, on ? (blink ? '#ffffff' : '#ffe14d') : 'rgba(255,255,255,0.18)', 'right'); }
    y += s * 12;
    const hh = Math.floor(clock), mm = Math.floor((clock - hh) * 60);
    ptext(hctx, String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'), rx, y, s * 1.3, '#ffffff', 'right'); y += s * 12;
    ptext(hctx, '$' + String(Math.max(0, me.cash)).padStart(6, '0'), rx, y, s * 1.3, '#3dff7a', 'right'); y += s * 12;
    bar(rx - s * 52, y, s * 52, s * 4, me.health / 100, me.health > 30 ? '#38c84a' : '#e03030'); y += s * 8;
    const w = WEAPONS[me.curW]; const icon = ICONS[w.key];
    hctx.fillStyle = 'rgba(0,0,0,0.55)'; hctx.fillRect(rx - s * 52, y, s * 52, s * 12);
    drawIcon(hctx, icon, rx - s * 50, y + s * 2, s * 1, '#ffffff');
    ptext(hctx, me.reloadT > 0 ? 'RELOAD' : me.ammo + '/' + me.reserve, rx - s * 2, y + s * 3, s, me.reloadT > 0 ? '#ffe14d' : '#ffffff', 'right'); y += s * 14;
    ptext(hctx, w.name, rx, y, s * 0.8, '#bbbbbb', 'right'); y += s * 9;
    ptext(hctx, 'KILLS ' + me.kills, rx, y, s * 1.1, '#ff6060', 'right'); y += s * 10;
    if (V.timeLeft >= 0) ptext(hctx, 'ROUND ' + fmtClock(V.timeLeft), rx, y, s * 1.1, V.timeLeft < 30 ? '#ff4d4d' : '#7fe0ff', 'right');
    // top-left: mission briefing
    { const px = 14; let py = 14; const tw = Math.min(Wd * 0.42, s * 150); const ms = MISSION_STATES[V.ms] || 'intro';
      hctx.fillStyle = 'rgba(0,0,0,0.5)';
      const brief = wrapText(BRIEF, Math.floor(tw / (6 * s * 0.8)));
      const objLines = wrapText('> ' + OBJECTIVES[ms], Math.floor(tw / (6 * s * 0.9)));
      hctx.fillRect(px - 6, py - 6, tw + 12, s * 12 + brief.length * s * 7.5 + objLines.length * s * 8.5 + s * 10);
      ptext(hctx, 'THE DOWNTOWN HIT', px, py, s * 1.2, '#ffe14d'); py += s * 12;
      for (const l of brief) { ptext(hctx, l, px, py, s * 0.8, '#dddddd'); py += s * 7.5; }
      py += s * 3; for (const l of objLines) { ptext(hctx, l, px, py, s * 0.9, ms === 'done' ? '#3dff7a' : '#7fe0ff'); py += s * 8.5; } }
    // bottom-left: minimap + area name
    const msz = Math.min(230, Math.round(Wd * 0.2)); drawMinimap(16, Hd - msz - 16, msz);
    if (areaT > 0) { const a = clamp(areaT, 0, 1); hctx.globalAlpha = a; ptext(hctx, curDistrict, 16 + msz + 18, Hd - 16 - s * 20, s * 1.6, '#ffe14d'); ptext(hctx, curStreet, 16 + msz + 18, Hd - 16 - s * 8, s, '#ffffff'); hctx.globalAlpha = 1; }
    const hint = HINT[me.hint] || '';
    if (hint && !dead && state === 'play') ptext(hctx, hint, Wd / 2, Hd - s * 12, s, '#ffffff', 'center');
    // centre messages
    if (MISSION_STATES[V.ms] === 'intro' && roundT < INTRO_T) { const a = roundT < 0.5 ? roundT * 2 : roundT > 4.5 ? (INTRO_T - roundT) : 1; hctx.globalAlpha = clamp(a, 0, 1);
      hctx.fillStyle = 'rgba(0,0,0,0.6)'; hctx.fillRect(0, Hd * 0.32, Wd, Hd * 0.28);
      ptext(hctx, 'THE DOWNTOWN HIT', Wd / 2, Hd * 0.38, s * 3, '#ffe14d', 'center'); ptext(hctx, 'WHACK THE SNITCH', Wd / 2, Hd * 0.38 + s * 30, s * 1.2, '#ffffff', 'center'); hctx.globalAlpha = 1; }
    if (wantedFlash > 0 && Math.floor(t * 5) % 2 === 0 && !dead) ptext(hctx, 'WANTED LEVEL ' + '*'.repeat(me.wanted), Wd / 2, Hd * 0.22, s * 2.2, '#ffe14d', 'center');
    if (dead) { hctx.fillStyle = `rgba(0,0,0,${clamp(deadT * 0.3, 0, 0.55)})`; hctx.fillRect(0, 0, Wd, Hd); const sc = s * (4 + Math.min(1, deadT) * 2); ptext(hctx, 'WASTED', Wd / 2, Hd / 2 - sc * 4, sc, '#d01010', 'center'); }
    if (MISSION_STATES[V.ms] === 'passed') { hctx.fillStyle = 'rgba(0,0,0,0.5)'; hctx.fillRect(0, Hd * 0.3, Wd, Hd * 0.3);
      ptext(hctx, 'MISSION PASSED', Wd / 2, Hd * 0.36, s * 3, '#ffe14d', 'center'); ptext(hctx, '+$5000', Wd / 2, Hd * 0.36 + s * 30, s * 2, '#3dff7a', 'center'); ptext(hctx, 'RESPECT +', Wd / 2, Hd * 0.36 + s * 48, s, '#ffffff', 'center'); }
    floats.forEach((f, i) => { const a = clamp(2.5 - f.t, 0, 1); hctx.globalAlpha = a; ptext(hctx, f.text, Wd / 2, Hd * 0.62 - f.t * 30 - i * s * 10, s * 1.1, hex(f.color), 'center'); hctx.globalAlpha = 1; });
    let line = 'FPS ' + Math.round(fps); if (online) line += isHost ? '  HOST' : `  LAG ${Math.round(pred ? pred.lag : 0)} MS  HOST ${net.hostFps} FPS`;
    ptext(hctx, line, Wd - 16, Hd - 16 - s * 7, s * 0.7, 'rgba(255,255,255,0.45)', 'right', false);
    if (showStats) drawStats(Wd, Hd, s);
  }
  function drawStats(Wd, Hd, s) {
    const sc = s * 0.8, lines = [
      `FRAME ${timing.frame.toFixed(1)} MS (${Math.round(fps)} FPS)   SIM ${timing.sim.toFixed(1)}   RENDER ${timing.render.toFixed(1)}   HUD ${timing.hud.toFixed(1)}`,
      `DETAIL ${QUALITY[quality].name}${autoQuality ? ' (AUTO)' : ''}   PIXEL RATIO ${renderer.getPixelRatio().toFixed(2)}   ${innerWidth}X${innerHeight}`,
    ];
    if (!online) lines.push(`SOLO   ENTITIES ${sim.peds.length} PEDS  ${sim.cars.length} CARS  ${sim.pickups.length} PICKUPS`);
    else if (isHost) lines.push(`HOST   SNAPSHOTS OUT ${net.rateOut.toFixed(0)}/S  ${net.kbOut.toFixed(1)} KB/S TO ${clients.filter(c => !c.pl.gone).length} PLAYER(S)   ENTITIES ${sim.peds.length} PEDS  ${sim.cars.length} CARS`);
    else lines.push(`CLIENT   SNAPSHOTS IN ${net.rateIn.toFixed(0)}/S  ${net.kbIn.toFixed(1)} KB/S   INPUT OUT ${net.rateOut.toFixed(0)}/S   HOST ${net.hostFps} FPS`,
      `INPUT LAG ${Math.round(pred ? pred.lag : 0)} MS   OTHERS SHOWN ${Math.round(INTERP * 1000)} MS BACK   CORRECTIONS ${pred ? pred.corrections : 0}   ENTITIES ${remote ? remote.ents.size : 0}`);
    const w = Math.max(...lines.map(l => textW(l, sc))) + s * 8, x = Wd / 2 - w / 2, y = s * 26;
    hctx.fillStyle = 'rgba(0,0,0,0.6)'; hctx.fillRect(x, y - s * 3, w, lines.length * sc * 9 + s * 4);
    lines.forEach((l, i) => ptext(hctx, l, x + s * 4, y + i * sc * 9, sc, i === 0 ? '#ffe14d' : '#dddddd'));
  }

  /* ---- main loop */
  const loop = createLoop((real, now) => {
    const raw = Math.min(0.1, real); t += raw; roundT += raw; fps = lerp(fps, 1 / Math.max(raw, 1e-3), 0.05);
    const t0 = performance.now(), inp = readInput();
    if (isHost) {
      if (online || state === 'play' || state === 'over') { sim.setInput(me, inp); const steps = raw > 0.034 ? 2 : 1, dt = raw / steps; for (let k = 0; k < steps; k++) sim.update(dt); }
      if (online) hostNetTick(raw); else sim.clearEvents();
      hostView();
    } else {
      if (remote.R.got) inp.q = pred.step(inp.m, camYaw, localArm > 0, raw, remote.R.P[myIdx], remote, t0);
      clientSendInput(inp, raw);
      if (remote.R.got) { clock += raw / 45; remote.update(raw, t, myIdx, camPitch, pred.local()); }
      clientView();
      if (state === 'play' && fireHeld) localShot(true);
    }
    const t1 = performance.now();
    localFrame(raw);
    renderer.render(scene, camera);
    const t2 = performance.now();
    drawHUD();
    const t3 = performance.now();
    timing.sim = lerp(timing.sim, t1 - t0, 0.1); timing.render = lerp(timing.render, t2 - t1, 0.1); timing.hud = lerp(timing.hud, t3 - t2, 0.1); timing.frame = lerp(timing.frame, raw * 1000, 0.1);
    if (now - net.at > 1000) { const secs = (now - net.at) / 1000; net.rateIn = net.inMsgs / secs; net.kbIn = net.inBytes / 1024 / secs; net.rateOut = net.outMsgs / secs; net.kbOut = net.outBytes / 1024 / secs; net.inMsgs = net.inBytes = net.outMsgs = net.outBytes = 0; net.at = now; }
  });

  /* ---- session API */
  function stopRound() { if (sim) { sim.dispose(); sim = null; } if (remote) { remote.clear(); remote = null; } pred = null; me = null; clients = []; }
  function start(s) {
    stopRound();
    session = s; isHost = !!s.isHost; online = !!s.online; hostId = s.hostId; myId = s.myId; myIdx = Math.max(0, s.players.findIndex(p => p.id === myId));
    camYaw = 0; camPitch = 0.22; mouseIdle = 10; t = 0; roundT = 0; clicks = 0; fireHeld = false; dmgFlash = 0; wantedFlash = 0; floats.length = 0; areaT = 0; curDistrict = ''; curStreet = ''; route = []; routeT = 0; lastIn = null; sinceIn = 1; netAcc = 0; lockPending = 0;
    clock = START_CLOCK[(s.opts || {}).time] ?? START_CLOCK.morning;
    fx.reset();
    if (isHost) {
      sim = createSim({ W, session: s, opts: s.opts || {}, onEvent }); me = sim.players[myIdx];
      clients = s.players.filter(p => p.id !== myId).map(p => ({ id: p.id, known: new Set(), pl: sim.playerOf(p.id) }));
      hostView();
    } else { remote = createRemote({ W }); pred = createPredictor({ W }); clientView(); }
    localFireT = 0; localArm = 0; lowFpsT = 0; net.at = performance.now(); net.inMsgs = net.inBytes = net.outMsgs = net.outBytes = 0;
    state = 'grab'; showOverlay('grab'); kb.attach(); sizeHud(); audio.init(); loop.start();
  }
  function stop() { stopRound(); fx.reset(); state = 'idle'; ov.el.hidden = true; fireHeld = false; kb.detach(); loop.stop(); if (document.pointerLockElement === root) document.exitPointerLock(); }
  function destroy() {
    stop(); unsubAudio(); if (eng) { try { eng.osc.stop(); eng.siren.stop(); eng.gain.disconnect(); eng.sirenGain.disconnect(); } catch {} eng = null; }
    removeEventListener('resize', onResize); removeEventListener('mouseup', onMouseUp); removeEventListener('mousemove', onMouseMove); removeEventListener('wheel', onWheel);
    document.removeEventListener('pointerlockchange', onLockChange); document.removeEventListener('pointerlockerror', onLockError);
    disposeScene(scene); renderer.dispose(); root.remove(); mount.innerHTML = ''; unloadCss();
  }
  function playerLeft(id) { if (sim) sim.playerLeft(id); clients = clients.filter(c => c.id !== id); }
  const netStats = { in: {}, out: {} };
  const count = (tab, t) => { tab[t] = (tab[t] || 0) + 1; };
  function onNetMessage(msg) {
    count(netStats.in, msg.t);
    if (msg.t === 's') { if (!isHost && remote && msg.from === hostId) { net.inMsgs++; net.inBytes += JSON.stringify(msg).length; if (msg.hf !== undefined) net.hostFps = msg.hf;
      const evs = remote.apply(msg); pred.reconcile(msg, remote.R.P[myIdx], performance.now()); for (const ev of evs) onEvent(ev); } }
    else if (msg.t === 'in') { if (isHost && sim) sim.setInput(sim.playerOf(msg.from), msg); }
    else if (msg.t === 'a') { if (isHost && sim) sim.action(sim.playerOf(msg.from), msg.a, msg.n); }
  }
  const debug = { get sim() { return sim; }, get remote() { return remote; }, get state() { return state; }, get session() { return session; }, V, W, get camYaw() { return camYaw; }, get fps() { return fps; }, grab, get clients() { return clients; }, netStats, net, timing, get pred() { return pred; }, get quality() { return quality; }, setQuality, get held() { return held; }, get fallbackMouse() { return fallbackMouse; } };
  window.__gta = debug;
  return { start, stop, destroy, onNetMessage, playerLeft, debug };
}
