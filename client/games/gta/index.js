/* Fable Theft Auto 5.1 - a voxel crime sandbox. Game module for the LAN party shell; the contract is documented
   at the top of games/kart/index.js.

   Netcode: host-authoritative. The host's browser runs the whole city (sim.js) for every player. The other
   players send their input bits, camera angles and one-shot actions to the host (`in` / `a`, addressed with
   `to`) and render the host's 30 Hz delta snapshots (`s`) a little in the past (remote.js). One-shot events
   ride inside the snapshots and every machine plays its own particles and sounds from them; the camera, the
   HUD, the minimap route and the scenery animation are local. Solo play is the host path without a network.

   Touch screens (core/touch.js): the left part of the screen is a thumb stick that walks, runs or drives, the rest is
   a look surface, and FIRE, JUMP / HANDBRAKE, USE, WEAPON and RELOAD sit under the right thumb. The stick travels to
   the host as an analog pair next to the key bits (motion.js), a touch player's shots get a wider soft lock, ☰ opens
   the pause card, the canvas HUD keeps clear of the notch and a phone held upright is asked to rotate.

   Files: world.js (the city + pools), entities.js (how peds/cars draw), sim.js (the host's simulation),
   remote.js (a client's copy), fx.js (particles/decals/tracers), font.js (the bitmap font). */
import * as THREE from 'three';
import { clamp, lerp } from '../../core/math.js';
import { esc, hex, loadStylesheet } from '../../core/ui.js';
import { createInput } from '../../core/input.js';
import { createTouch, isCoarse } from '../../core/touch.js';
import { createLoop } from '../../core/loop.js';
import { AVATARS } from '../../core/avatars.js';
import { buildWorld, computeCamera, districtAt, streetAt, nearestNode, bfsRoute, PLAZA, HOSPITAL, POLICE_DOOR, SPRAY, TAXI_RANK, X, MAP, dist2, angDiff, PI, TAU } from './world.js';
import { seatOffset, WEAPONS, CAUSES, EVENT_KINDS } from './entities.js';
import { createFx } from './fx.js';
import { createSim, IN, HINT, MISSION_STATES, OBJECTIVES, INTRO_T, START_CLOCK, aimTol, MODES, MARK_CASH_PER_S, MARK_BOUNTY, AIRDROP_T, AIRDROP_FALL, RACE_END_T, KILL_CAP, lapsOf, killCapOf, gunsOn, modeOf, wastedTimeOf } from './sim.js';
import { arenaOf, OUT_WARN_T } from './arena.js';
import { raceCourse, planLap, raceRoute, raceGuide, nodeXZ, LAPS, ordinal } from './race.js';
import { createRemote, parseBlock, parseMode, INTERP } from './remote.js';
import { createPredictor } from './predict.js';
import { createReplay, REPLAY_DELAY } from './replay.js';
import { ptext, textW, wrapText, ICONS, drawIcon } from './font.js';

const NET_HZ = 30;
const BRIEF = "Vinny 'Snitch' Voxel sold out the crew to the LPPD. He's hiding at Diamond Plaza downtown with hired muscle. Make him disappear.";
const BRIEF_MW = `Someone in Los Pixeles carries the mark. It pays $${MARK_CASH_PER_S} a second to whoever holds it, and whoever kills them takes it, plus a $${MARK_BOUNTY} bounty.`;
const briefDm = (cap, guns) => `Everyone is fair game and nobody gets a star for it, inside the red fence. Leave it and you have ${OUT_WARN_T} seconds to get back. First to ${cap} kills wins, or the most when the clock runs out. ${guns ? 'Guns, cars, whatever works.' : 'No guns: cars and your fists.'}`;
const briefRace = (laps, guns) => `${laps} lap${laps === 1 ? '' : 's'} through the checkpoints and back across the line. ${guns ? 'Anything goes: guns, traffic, cops.' : 'No guns: traffic, cops and your bumper.'} The first one home gives the rest ${RACE_END_T} seconds.`;
/* what the death card says for each CAUSES entry; a name is filled in when a player did it */
const CAUSE_TEXT = { pistol: 'PISTOL', shotgun: 'SHOTGUN', smg: 'SMG', sniper: 'SNIPER RIFLE', rpg: 'ROCKET', runover: 'RUN OVER', explosion: 'BLOWN UP', cop: 'SHOT BY THE LPPD', guard: 'SHOT BY THE BODYGUARDS', swat: 'SHOT BY SWAT', fence: 'LEFT THE ARENA' };
const PICK_TEXT = { sniper: 'SNIPER RIFLE', rpg: 'ROCKET LAUNCHER', pistol: 'PISTOL', shotgun: 'SHOTGUN', smg: 'SMG' };
/* the feed's line for a kill: a gun draws its icon between the two names, anything else is a verb; without a killer the victim's fate */
const KILL_VERB = { runover: 'RAN OVER', explosion: 'BLEW UP', crash: 'KNOCKED OFF THE BIKE' };
const DIED_TEXT = { cop: 'SHOT BY THE LPPD', swat: 'SHOT BY SWAT', guard: 'SHOT BY THE BODYGUARDS', runover: 'RUN OVER', explosion: 'BLOWN UP', crash: 'CAME OFF THE BIKE', fence: 'LEFT THE ARENA' };
/* the feed: how long a line stays, how long it takes to fade, how many show (fewer on a phone) */
const FEED_T = 8, FEED_FADE = 1.5, FEED_LINES = 5, FEED_LINES_PHONE = 3;
/* the letter a weapon lying in the street shows on the minimap, and its square's colour */
const PICK_MAP = { sniper: ['S', '#f4f4ff'], rpg: ['R', '#ff7a20'], pistol: ['P', '#c8c8d8'], shotgun: ['G', '#c8c8d8'], smg: ['M', '#c8c8d8'] };
/* the control hints that mean nothing in a round without guns */
const GUN_KEYS = new Set(['CLICK', '1-5 / Q', 'R', 'FIRE', 'WEAPON', 'RELOAD']);
/* the driving jobs on the HUD, by JOB_KINDS index: the title, what rides along, the colour of its marker */
const JOB_TEXT = [null, { title: 'TAXI DRIVER', who: 'FARE', color: 0xf2c014 }, { title: 'PARAMEDIC', who: 'PATIENT', color: 0xff4d4d }];
const EVENT_TEXT = ['ARMORED TRUCK', 'AIRDROP'];
/* players further than this (or off screen) get an arrow at the edge of the screen; nearer ones have their name over their head */
const ARROW_FROM = 120;
/* how fast a touch player's camera is pulled onto the soft-locked target while FIRE is held (per second) */
const MAGNET = 5;
const CONTROLS = [['WASD', 'move / drive'], ['MOUSE', 'look / aim'], ['CLICK', 'shoot (from the passenger seat too)'], ['1-5 / Q', 'switch weapon (or the wheel)'], ['R', 'reload'], ['F', 'enter / exit a car, ride along in a friend\'s, turn yourself in'], ['SHIFT', 'sprint'], ['SPACE', 'jump / handbrake'], ['M', 'sound on / off'], ['F3 / I', 'stats panel'], ['L', 'graphics detail'], ['ESC', 'pause']];
const CONTROLS_TOUCH = [['LEFT SIDE', 'drag to move or drive · push all the way to run'], ['RIGHT SIDE', 'drag to look and aim'], ['FIRE', 'hold to shoot (from the passenger seat too) · drag on it to aim while shooting'], ['JUMP', 'jump on foot, handbrake in a car'], ['USE', 'enter or exit a car, ride along in a friend\'s, turn yourself in'], ['WEAPON', 'next weapon · RELOAD reloads'], ['☰', 'pause, sound, detail, look sensitivity']];
/* the on-screen hints on a touch screen: the USE and JUMP buttons already say what they do, so only the two with no button stay */
const HINT_TOUCH = ['', '', '', '', HINT[4], 'TURN YOURSELF IN   $100 A STAR', '', ''];
/* graphics detail levels; the auto mode steps down when the frame rate stays low */
const QUALITY = [{ name: 'HIGH', pr: 1.5, shadow: 2048 }, { name: 'MEDIUM', pr: 1, shadow: 1024 }, { name: 'LOW', pr: 1, shadow: 0 }];
/* how far a thumb's drag turns the camera (radians per CSS pixel); the pitch moves a little less than the yaw */
const LOOK = [{ name: 'LOW', k: 0.0045 }, { name: 'NORMAL', k: 0.0065 }, { name: 'HIGH', k: 0.0095 }];
const HTML = `<canvas class="gl"></canvas><canvas class="hud"></canvas><div class="sa"></div>
<div class="pad ctl" data-pad><div class="ring"><div class="knob"></div></div><div class="lbl">DRAG HERE TO MOVE</div></div>
<div class="look ctl" data-look><div class="lbl">DRAG HERE TO LOOK</div></div>
<div class="tbtn ctl fire" data-fire><b>FIRE</b><small data-ammo></small></div>
<div class="tbtn ctl jump" data-jump>JUMP</div>
<div class="tbtn ctl use" data-use>USE</div>
<div class="pill ctl weapon" data-weapon><canvas width="48" height="24"></canvas><b data-wname>PISTOL</b></div>
<div class="pill ctl reload" data-reload>RELOAD</div>
<div class="menu-btn ctl" data-menu>☰</div>
<div class="overlay" hidden><div class="card"><h1 data-title></h1><div class="sub" data-sub></div><div class="controls" data-controls></div><table class="score" data-score hidden></table><table class="score awards" data-awards hidden></table><div class="foot" data-foot></div></div></div>
<div class="rotate"><div><div class="phone">📱</div>ROTATE YOUR DEVICE<small>FABLE THEFT AUTO PLAYS IN LANDSCAPE</small></div></div>`;
const rr = (a, b) => a + Math.random() * (b - a);
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
const fmtClock = s => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
/* the results card's awards: what the host's key is called and how its value reads (the extra is the nemesis's victim or the driver's distance) */
const AWARDS = {
  lap: ['FASTEST LAP', v => `${fmtClock(v)}.${Math.floor((v % 1) * 10)}`], killer: ['MOST KILLS', v => `${v} KILL${v === 1 ? '' : 'S'}`],
  nemesis: ['NEMESIS', (v, x, nameOf) => `WASTED ${nameOf(x).toUpperCase()} ${v} TIMES`], victim: ['MOST WASTED', v => `${v} DEATHS`],
  fugitive: ['LONGEST CHASE', v => `${fmtClock(v)} ON THE RUN`], cabbie: ['BEST CABBIE', v => `${v} FARES IN A ROW`],
  speed: ['SPEED DEMON', v => `${Math.round(v)} KM/H`], driver: ['SAFEST DRIVER', (v, km) => `${v === 0 ? 'NO' : v} CRASH${v === 1 ? '' : 'ES'} IN ${km} KM`],
  loot: ['BIGGEST LOOTER', v => `$${v} PICKED UP`],
};

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
      else if (kind === 'sniper') { hiss(0.4, 1100, 1.0 * vol, 1.2); tone(320, 40, 0.35, 0.6 * vol, 'square'); }
      else if (kind === 'rpg') { hiss(0.6, 350, 0.8 * vol, 0.9); tone(120, 420, 0.45, 0.4 * vol, 'sawtooth'); }
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
    cleared() { tone(660, 660, 0.09, 0.25, 'square'); tone(880, 880, 0.09, 0.25, 'square', 0.1); tone(1320, 1320, 0.2, 0.25, 'square', 0.2); },
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
  const touch = isCoarse(); // phones and tablets: the thumb stick, the look surface, the buttons and ☰ appear and the mouse is ignored
  const root = document.createElement('div'); root.className = 'gta' + (touch ? ' touch' : ''); root.innerHTML = HTML; mount.appendChild(root);
  const $ = sel => root.querySelector(sel);
  const glCanvas = $('canvas.gl'), hudCanvas = $('canvas.hud'), hctx = hudCanvas.getContext('2d');
  const ov = { el: $('.overlay'), title: $('[data-title]'), sub: $('[data-sub]'), controls: $('[data-controls]'), score: $('[data-score]'), awards: $('[data-awards]'), foot: $('[data-foot]') };
  /* the safe-area insets (notch, home indicator) as numbers, read off an element the stylesheet pads with them, so the canvas HUD keeps clear */
  const saEl = $('.sa'), sa = { t: 0, r: 0, b: 0, l: 0 }; let saStale = true; // the probe has no size while the shell still hides the stage: measured again until it has
  const measureSafeArea = () => { const r = saEl.getBoundingClientRect(); if (!(r.width > 0 && r.height > 0)) return; saStale = false; sa.t = Math.max(0, r.top); sa.l = Math.max(0, r.left); sa.r = Math.max(0, innerWidth - r.right); sa.b = Math.max(0, innerHeight - r.bottom); };

  /* ---- renderer, scene, the city */
  const renderer = new THREE.WebGLRenderer({ canvas: glCanvas, antialias: false, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); renderer.setSize(innerWidth, innerHeight);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.BasicShadowMap;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(66, innerWidth / innerHeight, 0.3, 1600);
  const W = buildWorld({ THREE, scene });
  /* the deathmatch's fence: four tall translucent red walls on the arena's edge, hidden until a deathmatch places them */
  const fence = new THREE.Group(); fence.visible = false; scene.add(fence);
  const fenceMat = new THREE.MeshBasicMaterial({ color: 0xff3a3a, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide });
  for (let k = 0; k < 4; k++) fence.add(new THREE.Mesh(new THREE.PlaneGeometry(1, 1), fenceMat));
  function placeFence(A) {
    fence.visible = !!A; if (!A) return;
    const H = 60, w = A.x1 - A.x0, d = A.z1 - A.z0, walls = fence.children;
    walls[0].position.set(A.cx, H / 2, A.z0); walls[0].rotation.set(0, 0, 0); walls[0].scale.set(w, H, 1);
    walls[1].position.set(A.cx, H / 2, A.z1); walls[1].rotation.set(0, 0, 0); walls[1].scale.set(w, H, 1);
    walls[2].position.set(A.x0, H / 2, A.cz); walls[2].rotation.set(0, PI / 2, 0); walls[2].scale.set(d, H, 1);
    walls[3].position.set(A.x1, H / 2, A.cz); walls[3].rotation.set(0, PI / 2, 0); walls[3].scale.set(d, H, 1);
  }
  const fx = createFx({ W });
  const sfx = createSfx(audio);
  const V3 = new THREE.Vector3();
  function sizeHud() { const dpr = Math.min(window.devicePixelRatio || 1, 2); hudCanvas.width = Math.round(innerWidth * dpr); hudCanvas.height = Math.round(innerHeight * dpr); hctx.setTransform(dpr, 0, 0, dpr, 0, 0); hctx.imageSmoothingEnabled = false; saStale = true; measureSafeArea(); }
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
  let laps = LAPS, killCap = KILL_CAP, guns = true; // the round's lobby options that the HUD needs (RACE LAPS, KILLS TO WIN, GUNS)
  let awards = []; // the round's awards, from the host's `over` event: [key, player index, value, extra?]
  let sim = null, remote = null, session = null, isHost = false, online = false, hostId = null, myId = null, myIdx = 0, me = null, clients = [];
  let state = 'idle'; // idle | grab (click to play) | play | paused | over
  let camYaw = 0, camPitch = 0.22, mouseIdle = 10, fallbackMouse = touch, lockPending = 0, lastMX = null, lastMY = null; // no pointer lock on a touch screen
  let t = 0, roundT = 0, fps = 60, clock = START_CLOCK.morning;
  let dmgFlash = 0, wantedFlash = 0, areaT = 0, curDistrict = '', curStreet = '', routeT = 0, route = [], routeTarget = null, wasDead = false;
  const floats = [], feed = [];
  let clicks = 0, fireHeld = false, netAcc = 0, lastIn = null, sinceIn = 0, pred = null, localFireT = 0, localArm = 0;
  let arena = null; // the deathmatch's arena (from the seed), or null
  let course = null, legs = null, routeCp = -1, goT = 0, lastCount = -1, finishT = 0; // the race: the checkpoints and the planned lap (from the seed), where the checkpoint sits in the shown route, the GO! flash, the last countdown number heard, the "you finished" flash
  const timing = { frame: 0, sim: 0, render: 0, hud: 0 };
  const net = { inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0, rateIn: 0, kbIn: 0, rateOut: 0, kbOut: 0, at: 0, hostFps: 0 };
  let showStats = false, quality = 0, autoQuality = true, lowFpsT = 0;
  function setQuality(i, manual) {
    quality = clamp(i | 0, 0, QUALITY.length - 1); if (manual) { autoQuality = false; try { localStorage.setItem('lan_gta_quality', String(quality)); } catch {} }
    const q = QUALITY[quality]; renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, q.pr)); renderer.setSize(innerWidth, innerHeight);
    W.sun.castShadow = q.shadow > 0;
    if (q.shadow > 0 && W.sun.shadow.mapSize.x !== q.shadow) { W.sun.shadow.mapSize.set(q.shadow, q.shadow); if (W.sun.shadow.map) { W.sun.shadow.map.dispose(); W.sun.shadow.map = null; } }
  }
  { let saved = null; try { saved = localStorage.getItem('lan_gta_quality'); } catch {} if (saved !== null && QUALITY[+saved]) setQuality(+saved, true); else if (touch) setQuality(1); } // phones and tablets start a tier down, still in auto mode
  function cycleQuality() { // HIGH -> MEDIUM -> LOW -> AUTO
    if (autoQuality) setQuality(0, true); else if (quality < QUALITY.length - 1) setQuality(quality + 1, true); else { autoQuality = true; setQuality(touch ? 1 : 0); try { localStorage.removeItem('lan_gta_quality'); } catch {} }
    floatText((autoQuality ? 'AUTO' : QUALITY[quality].name) + ' DETAIL', 0x9fb4dc);
  }
  const qualityLabel = () => 'DETAIL: ' + (autoQuality ? 'AUTO (' + QUALITY[quality].name + ')' : QUALITY[quality].name);
  const cam = { x: 0, y: 5, z: 0, dx: 0, dy: 0, dz: 1, lx: 0, ly: 0, lz: 1 };
  /* the view model the camera, HUD and audio read; filled from the sim (host) or the snapshot store (client) */
  const V = { me: null, subj: { x: 0, y: 0, z: 0, inCar: null, dead: false }, car: null, timeLeft: -1, phase: 0, ms: 0, vin: null, cops: [], players: [], blocks: [], md: parseMode(null) };
  const modeName = () => MODES[V.md.mode] || 'sandbox';
  const onGrid = () => !!(V.md.race && V.md.race.state === 0); // the race countdown: nobody moves, so the client does not predict a move either
  const playerColor = i => (AVATARS[(session.players[i] || {}).avatar] || AVATARS[0]).color;
  function hostView() {
    const P = me.ped;
    V.blocks = sim.players.map(p => parseBlock(sim.block(p))); V.me = V.blocks[myIdx];
    V.subj.x = P ? P.x : 0; V.subj.y = P ? P.y : 0; V.subj.z = P ? P.z : 0; V.subj.inCar = P ? P.inCar : null; V.subj.dead = !P || P.dead; V.car = P ? P.inCar : null;
    V.timeLeft = sim.S.unlimited ? -1 : sim.S.timeLeft; V.phase = sim.S.phase === 'over' ? 1 : 0; V.ms = MISSION_STATES.indexOf(sim.mission.state);
    const v = sim.mission.vinny; V.vin = v && !v.released ? { x: v.x, z: v.z, dead: v.dead } : null; V.md = parseMode(sim.modeState());
    V.cops.length = 0; for (const c of sim.cops) if (!c.dead && !c.released) V.cops.push({ x: c.x, z: c.z, car: false }); for (const c of sim.cars) if (c.ai === 'cop' && !c.dead) V.cops.push({ x: c.x, z: c.z, car: true });
    V.players.length = 0; sim.players.forEach((p, i) => V.players.push({ name: p.name, color: playerColor(i), x: p.ped ? p.ped.x : 0, y: p.ped ? p.ped.y : 0, z: p.ped ? p.ped.z : 0, gone: p.gone, dead: p.dead, me: i === myIdx }));
    clock = sim.S.clockH;
  }
  function clientView() {
    const R = remote.R; V.blocks = R.P; V.me = R.P[myIdx] || null;
    const e = V.me ? remote.get(V.me.pedId) : null, car = V.me && V.me.carId >= 0 ? remote.get(V.me.carId) : null;
    V.subj.x = e ? e.x : 0; V.subj.y = e ? e.y : 0; V.subj.z = e ? e.z : 0; V.subj.inCar = car || null; V.subj.dead = !e || e.dead; V.car = car || null;
    V.timeLeft = R.timeLeft; V.phase = R.phase; V.ms = R.ms; V.vin = R.vin ? { x: R.vin[0], z: R.vin[1], dead: !!R.vin[2] } : null; V.md = R.md;
    V.cops.length = 0; for (const en of R.ents.values()) { if (en.cls === 'ped' && en.kind === 'cop' && !en.dead) V.cops.push({ x: en.x, z: en.z, car: false }); else if (en.cls === 'car' && en.type.cop && en.lights && !en.dead) V.cops.push({ x: en.x, z: en.z, car: true }); }
    V.players.length = 0; session.players.forEach((p, i) => { const b = R.P[i], pe = b ? remote.get(b.pedId) : null; V.players.push({ name: p.name, color: playerColor(i), x: pe ? pe.x : 0, y: pe ? pe.y : 0, z: pe ? pe.z : 0, gone: !!(b && b.gone), dead: !!(b && b.dead), me: i === myIdx }); });
    if (R.got) clock = R.clock;
  }

  /* ---- events from the simulation (host: as they happen; client: from the snapshots) -> local effects and sounds */
  const floatText = (text, color) => floats.push({ text, color, t: 0 });
  const mine = idx => idx === myIdx;
  const nameOf = idx => ((session && session.players[idx]) || {}).name || '?';
  /* the feed in the top-left corner: a line is a few parts, each a coloured word or a gun icon; the newest line is on top */
  const feedLine = (...parts) => { feed.unshift({ parts, t: 0 }); if (feed.length > 12) feed.length = 12; };
  const pname = idx => ({ t: nameOf(idx), c: idx === myIdx ? '#ffffff' : hex(playerColor(idx)) });
  const said = (t, c = '#dddddd') => ({ t, c });
  const NEWS_LINE = { // what a `news` event puts in the feed
    gun: (idx, key) => [pname(idx), said('FOUND A ' + (PICK_TEXT[key] || key), '#ffe14d'), { icon: key }],
    stars: idx => [pname(idx), said('IS WANTED  *****', '#ffe14d')],
    escape: (idx, bonus) => [pname(idx), said('ESCAPED A 5-STAR CHASE  +$' + bonus, '#7fe0ff')],
    busted: idx => [pname(idx), said('WENT TO THE PRECINCT', '#4d8bff')],
    truck: (idx, street) => idx >= 0 ? [pname(idx), said('BLEW THE TRUCK OPEN ON ' + street, '#3dff7a')] : [said('THE ARMORED TRUCK IS OPEN ON ' + street, '#3dff7a')],
    drop: (idx, district) => [said('AIRDROP DOWN IN ' + district, '#3dff7a')],
    streak: (idx, n) => [pname(idx), said(n + ' FARES IN A ROW', '#f2c014')],
    left: idx => [pname(idx), said('LEFT THE CITY', '#9fb4dc')],
  };
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
      case 'pickup': if (mine(ev[1])) { if (ev[2] === 'cash') { sfx.cash(); floatText('+$' + ev[3], 0x3dff7a); } else if (ev[2] === 'ammo') { sfx.pickup(); floatText('AMMO', 0xffe14d); }
        else if (ev[2] === 'bribe') { sfx.cleared(); floatText(ev[3] > 0 ? 'BRIBE ACCEPTED  -1 STAR' : 'BRIBE ACCEPTED  YOU LOST THE COPS', 0x4d8bff); }
        else if (PICK_TEXT[ev[2]]) { sfx.cleared(); floatText(PICK_TEXT[ev[2]] + '  ' + ev[3] + ' ROUNDS', 0xffe14d); } else { sfx.pickup(); floatText('+HEALTH', 0xff4d4d); } } break;
      case 'cleared': if (mine(ev[1])) { sfx.cleared(); wantedFlash = 0; } break;
      case 'click': if (mine(ev[1])) sfx.click(); break;
      case 'enter': if (mine(ev[1])) sfx.enter(); break;
      case 'reload': if (mine(ev[1])) sfx.reload(); break;
      case 'passed': sfx.passed(); if (ev[1] >= 0) feedLine(pname(ev[1]), said('WHACKED THE SNITCH  +$5000', '#ffe14d')); break;
      case 'over': awards = Array.isArray(ev[1]) ? ev[1] : []; showOver(); break;
      case 'kill': { const [, killer, whom, ci] = ev, cause = CAUSES[ci] || '';
        if (killer >= 0) feedLine(pname(killer), ICONS[cause] ? { icon: cause } : said(KILL_VERB[cause] || 'WASTED'), pname(whom));
        else feedLine(pname(whom), said(DIED_TEXT[cause] || 'WASTED')); break; }
      case 'news': { const line = NEWS_LINE[ev[1]]; if (line) feedLine(...line(ev[2], ev[3])); if (ev[1] === 'left') floatText(nameOf(ev[2]).toUpperCase() + ' LEFT THE CITY', 0x9fb4dc); break; }
      case 'mark': { const [, who, why] = ev; if (mine(who)) { floatText(why === 'start' ? 'YOU ARE THE MOST WANTED. STAY ALIVE.' : 'YOU TOOK THE MARK. STAY ALIVE.', 0xffe14d); sfx.wanted(); }
        else { floatText(nameOf(who) + ' IS THE MOST WANTED', 0xffe14d); sfx.cleared(); } feedLine(pname(who), said('IS THE MOST WANTED', '#ffe14d')); break; }
      case 'wevent': { floatText(ev[4], 0x3dff7a); sfx.cleared(); feedLine(said(ev[4], '#3dff7a')); break; }
      case 'job': if (mine(ev[1])) { const w = ev[2]; if (w === 'paid') sfx.cash(); else if (w === 'fail') sfx.wanted(); else if (w === 'pickup') sfx.enter(); else if (w === 'start' || w === 'fare') sfx.pickup(); } break;
      case 'wland': { const [, x, z] = ev; if (near(x, z)) { fx.burst.dust(x, 0.5, z); fx.burst.crash(x, 1, z, 10); } sfx.crash(vol(x, z, 200)); break; }
      case 'go': { goT = 1.2; sfx.passed(); break; }
      case 'cp': if (mine(ev[1])) { const [, , passed, lap] = ev, n = course ? course.length : 1, k = passed % n; sfx.pickup();
        floatText(k === 0 ? (lap >= laps - 1 ? 'FINAL LAP' : 'LAP ' + (lap + 1) + ' OF ' + laps) : 'CHECKPOINT ' + k + ' OF ' + (n - 1), 0x2fd0ff); } break;
      case 'finish': { const [, who, place] = ev; if (mine(who)) { finishT = 4; sfx.passed(); floatText('YOU FINISHED ' + ordinal(place), 0xffe14d); }
        else { floatText(nameOf(who) + ' FINISHED ' + ordinal(place), 0xffe14d); if (place === 1) { floatText('THE RACE ENDS IN ' + RACE_END_T + ' SECONDS', 0xff6060); sfx.wanted(); } }
        feedLine(pname(who), said('FINISHED ' + ordinal(place), '#ffe14d')); break; }
    }
  }

  /* ---- input */
  const act = (a, n) => { if (state !== 'play') return; if (isHost) { if (sim) sim.action(me, a, n); } else send({ t: 'a', to: hostId, a, n }); };
  /* whether I can shoot right now: on foot, or in a car on a passenger seat (the driver drives) */
  const canShoot = me => guns && !!me && !me.dead && (me.carId < 0 || me.seat > 0);
  const kb = createInput({ KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', ShiftLeft: 'sprint', ShiftRight: 'sprint', Space: 'space' }, {
    onKey: e => {
      if (e.code === 'Escape') { if (state === 'play' && fallbackMouse) pause(); else if (state === 'paused') grab(); return; }
      if (e.code === 'KeyM') { audio.toggle(); return; }
      if (e.code === 'F3' || e.code === 'KeyI') { e.preventDefault(); showStats = !showStats; return; }
      if (e.code === 'KeyL') { cycleQuality(); return; }
      if (state !== 'play') return;
      if (e.code === 'KeyF' || e.code === 'KeyE') act('use');
      else if (e.code === 'KeyR') act('reload');
      else if (/^Digit[1-5]$/.test(e.code)) act('weapon', +e.code[5] - 1);
      else if (e.code === 'KeyQ') act('wnext', 1);
    },
  });
  const held = kb.held;

  /* touch (core/touch.js): the left part of the screen is a thumb stick that walks, runs (pushed all the way) or drives;
     the rest is a look surface. FIRE, JUMP / HANDBRAKE, USE, WEAPON and RELOAD sit under the right thumb, and a drag on
     FIRE aims while shooting. The stick goes to the host as an analog pair next to the key bits (motion.js) and the
     input carries `a` so the host widens the soft lock for a thumb. */
  const tc = createTouch();
  const tb = touch ? { pad: $('[data-pad]'), look: $('[data-look]'), fire: $('[data-fire]'), ammo: $('[data-ammo]'), jump: $('[data-jump]'), use: $('[data-use]'), wname: $('[data-wname]'), wicon: $('[data-weapon] canvas').getContext('2d'), reload: $('[data-reload]'), menu: $('[data-menu]') } : null;
  let lookLevel = 1;
  { let saved = null; try { saved = localStorage.getItem('lan_gta_look'); } catch {} if (saved !== null && LOOK[+saved]) lookLevel = +saved; }
  function cycleLook() { lookLevel = (lookLevel + 1) % LOOK.length; try { localStorage.setItem('lan_gta_look', String(lookLevel)); } catch {} floatText('LOOK: ' + LOOK[lookLevel].name, 0x9fb4dc); }
  const lookLabel = () => 'LOOK: ' + LOOK[lookLevel].name;
  /* a look surface reports the whole drag since the finger landed; the camera takes the part it has not seen yet (touchLook) */
  const dragStart = st => { st.px = 0; st.py = 0; };
  const stickS = touch ? tc.pad(tb.pad, { range: 60, dead: 6, axes: 2, onDown: () => audio.init() }) : null;
  const lookS = touch ? tc.button(tb.look, { onDown: st => { audio.init(); dragStart(st); root.classList.add('looked'); } }) : null;
  const fireS = touch ? tc.button(tb.fire, { onDown: st => { audio.init(); dragStart(st); if (state !== 'play') return; fireHeld = true; clicks++; localShot(false); }, onUp: () => { fireHeld = false; } }) : null;
  const jumpS = touch ? tc.button(tb.jump, { onDown: () => audio.init() }) : null;
  if (touch) {
    tc.button(tb.use, { onDown: () => { audio.init(); act('use'); } });
    tc.button($('[data-weapon]'), { onDown: () => { audio.init(); act('wnext', 1); } });
    tc.button(tb.reload, { onDown: () => { audio.init(); act('reload'); } });
    tb.menu.addEventListener('click', () => { audio.init(); if (state === 'play') pause(); else if (state === 'paused') grab(); });
  }
  /* the stick as the analog pair the movement code takes (right, forward; -1..1), rounded the way it goes on the wire so
     the prediction matches the host. In a car a light forward push is already full gas, so a thumb steering hard keeps
     the speed and a sideways push does not brake; on foot a push past 0.9 is a run. */
  const axes = { x: 0, z: 0, sprint: false };
  function stickAxes(out) {
    out.x = 0; out.z = 0; out.sprint = false;
    if (!stickS || !stickS.held) return out;
    const x = stickS.x, y = -stickS.y; // screen-down is backward
    if (V.car) { out.x = r2(x); out.z = Math.abs(y) < 0.15 ? 0 : r2(clamp(y * 1.4, -1, 1)); }
    else { const l = Math.hypot(x, y); if (l > 0.9) { out.x = r2(x / l); out.z = r2(y / l); out.sprint = true; } else { out.x = r2(x); out.z = r2(y); } }
    return out;
  }
  function readInput() {
    let m = 0, x = 0, z = 0;
    if (state === 'play' && !onGrid()) {
      if (held.up) m |= IN.UP; if (held.down) m |= IN.DOWN; if (held.left) m |= IN.LEFT; if (held.right) m |= IN.RIGHT; if (held.sprint) m |= IN.SPRINT; if (held.space || (jumpS && jumpS.held)) m |= IN.SPACE; if (fireHeld) m |= IN.FIRE;
      if (touch) { stickAxes(axes); x = axes.x; z = axes.z; if (axes.sprint) m |= IN.SPRINT; }
    }
    return { m, y: camYaw, p: camPitch, c: clicks, x, z, a: touch ? 1 : 0 };
  }
  /* the camera follows a thumb dragged on the look surface or on FIRE */
  function touchLook() {
    if (!touch || state !== 'play') return;
    const k = LOOK[lookLevel].k;
    for (const st of [lookS, fireS]) { if (!st.held) continue; const dx = st.dx - st.px, dy = st.dy - st.py; st.px = st.dx; st.py = st.dy; if (!dx && !dy) continue;
      camYaw -= dx * k; camPitch = clamp(camPitch + dy * k * 0.8, -0.45, 1.1); mouseIdle = 0; }
  }
  /* the mouse: ignored on a touch screen, where iOS synthesises mouse events from taps */
  const onMouseDown = e => {
    if (touch) return;
    if (e.target && e.target.closest && e.target.closest('button')) return;
    if (state === 'grab' || state === 'paused') { if (e.button === 0) grab(); return; }
    if (state !== 'play') return;
    if (e.button === 0) { fireHeld = true; clicks++; localShot(false); }
  };
  /* a client plays its own shot the moment it clicks; the host's 'shot' event for it then only adds the tracer and the impact */
  function localShot(auto) {
    const me = V.me; if (isHost || state !== 'play' || !canShoot(me) || me.reloadT > 0 || localFireT > 0) return;
    const w = WEAPONS[me.curW]; if (w.auto !== auto || me.ammo <= 0) return;
    localFireT = w.rate; localArm = 1.6; sfx.shot(w.key, 1); camPitch -= w.recoil;
    const c = V.car;
    if (c) { const { side, back } = seatOffset(c.type, me.seat), out = side * (c.type.w / 2 + 0.2), fx0 = Math.sin(c.yaw), fz0 = Math.cos(c.yaw); fx.burst.flash(c.x - fz0 * out + fx0 * back, c.y + c.type.bh + (c.type.bike ? 1.25 : 0.7), c.z + fx0 * out + fz0 * back); } // out of my window (over the rider's shoulder on a bike)
    else { const fx0 = Math.sin(camYaw), fz0 = Math.cos(camYaw), sj = V.subj; fx.burst.flash(sj.x - fz0 * 0.39 + fx0 * 0.75, sj.y + 1.32 - camPitch * 0.5, sj.z + fx0 * 0.39 + fz0 * 0.75); }
  }
  const onMouseUp = e => { if (e.button === 0) fireHeld = false; };
  const onMouseMove = e => {
    if (touch) return;
    let dx = e.movementX || 0, dy = e.movementY || 0;
    if (!document.pointerLockElement) { if (lastMX !== null && !dx && !dy) { dx = e.clientX - lastMX; dy = e.clientY - lastMY; } lastMX = e.clientX; lastMY = e.clientY; }
    if (state !== 'play') return;
    if (!document.pointerLockElement && !fallbackMouse) return;
    camYaw -= dx * 0.0022; camPitch = clamp(camPitch + dy * 0.0018, -0.45, 1.1); mouseIdle = 0;
  };
  const onWheel = e => { if (state === 'play') act('wnext', e.deltaY > 0 ? 1 : -1); };
  const onContext = e => e.preventDefault();
  /* a lock request can fail (Chrome refuses one right after an Esc exit): go back to the card so the next click retries;
     only a browser that never grants the lock at all drops into the mouse-delta fallback */
  let lockFails = 0;
  const onLockChange = () => { if (document.pointerLockElement === root) { lockFails = 0; lockPending = 0; } else if (state === 'play' && !fallbackMouse && lockPending <= 0) pause(); };
  const onLockError = () => { lockPending = 0; if (++lockFails >= 3) fallbackMouse = true; else pause(); };
  root.addEventListener('mousedown', onMouseDown); root.addEventListener('contextmenu', onContext);
  /* a click (or, on a touch screen, the tap itself: Safari only synthesises a click for what it deems clickable) on the card or its backdrop plays / resumes */
  const onOverlayTap = e => { if (e.target.closest('button') || e.target.closest('table')) return; if (state === 'grab' || state === 'paused') grab(); };
  ov.el.addEventListener('click', onOverlayTap); if (touch) ov.el.addEventListener('touchend', onOverlayTap);
  addEventListener('mouseup', onMouseUp); addEventListener('mousemove', onMouseMove); addEventListener('wheel', onWheel, { passive: true });
  document.addEventListener('pointerlockchange', onLockChange); document.addEventListener('pointerlockerror', onLockError);

  /* ---- pointer lock: "click to play" at the start of a round, pause when the lock is lost */
  function grab() {
    if (state !== 'grab' && state !== 'paused') return;
    state = 'play'; ov.el.hidden = true; audio.init(); kb.reset(); tc.releaseAll();
    if (!fallbackMouse && !document.pointerLockElement) {
      lockPending = 0.8;
      try { const p = root.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch { fallbackMouse = true; }
    }
  }
  function pause() { if (state !== 'play') return; state = 'paused'; fireHeld = false; kb.reset(); tc.releaseAll(); showOverlay('paused'); }
  function showOver() { if (state === 'over' || state === 'idle') return; state = 'over'; fireHeld = false; kb.reset(); tc.releaseAll(); root.classList.add('over'); if (document.pointerLockElement === root) document.exitPointerLock(); showOverlay('over'); }

  /* ---- overlays: click to play / paused / time's up */
  function button(label, cls, fn) { const b = document.createElement('button'); b.className = 'btn small ' + cls; b.textContent = label; b.onclick = fn; ov.foot.appendChild(b); return b; }
  function showOverlay(kind) {
    ov.el.hidden = false; ov.foot.innerHTML = ''; ov.score.hidden = kind !== 'over'; ov.awards.hidden = kind !== 'over' || !awards.length; ov.controls.hidden = kind === 'over' || (kind === 'paused' && touch); // the touch pause card is short: HOW TO PLAY unfolds the list
    ov.controls.innerHTML = (touch ? CONTROLS_TOUCH : CONTROLS).filter(([k]) => guns || !GUN_KEYS.has(k)).map(([k, v]) => `<kbd>${esc(k)}</kbd><span>${esc(v)}</span>`).join('');
    const restart = !online || isHost, exitLabel = !online ? 'MENU' : 'BACK TO LOBBY', tap = touch ? 'TAP' : 'CLICK';
    if (kind === 'grab') {
      ov.title.innerHTML = 'FABLE THEFT AUTO <b>5.1</b>'; ov.sub.textContent = `LOS PIXELES  ·  ${tap} TO PLAY`;
      const f = document.createElement('div'); f.textContent = modeName() === 'mostWanted' ? 'MOST WANTED: CARRY THE MARK, HUNT THE MARK' : modeName() === 'deathmatch' ? `DEATHMATCH: FIRST TO ${killCap} KILLS` : modeName() === 'race' ? `STREET RACE: ${laps} LAP${laps === 1 ? '' : 'S'}, ${guns ? 'ANYTHING GOES' : 'NO GUNS'}` : 'MISSION: THE DOWNTOWN HIT'; f.style.color = '#ffe14d'; ov.foot.appendChild(f);
    } else if (kind === 'paused') {
      ov.title.textContent = 'PAUSED'; ov.sub.textContent = (online ? 'THE CITY KEEPS RUNNING WITHOUT YOU  ·  ' : '') + `${tap} TO RESUME`;
      button('RESUME', 'good', grab);
      button(audio.muted ? 'SOUND: OFF' : 'SOUND: ON', '', () => { audio.toggle(); showOverlay('paused'); });
      button(qualityLabel(), '', () => { cycleQuality(); showOverlay('paused'); });
      if (touch) { button(lookLabel(), '', () => { cycleLook(); showOverlay('paused'); }); button('HOW TO PLAY', '', () => { ov.controls.hidden = !ov.controls.hidden; }); }
      button(showStats ? 'STATS: ON' : 'STATS: OFF', '', () => { showStats = !showStats; showOverlay('paused'); });
      if (restart) { button(!online ? 'RESTART' : 'RESTART FOR EVERYONE', '', () => hooks.onRestart?.()); button(exitLabel, '', () => hooks.onExit?.()); }
    } else {
      const mw = modeName() === 'mostWanted', race = modeName() === 'race', dm = modeName() === 'deathmatch', n = course ? course.length : 1;
      const capped = dm && V.blocks.some(b => b.kills >= killCap); // ended on the cap, not the clock
      ov.title.textContent = race ? 'RACE OVER' : capped ? 'DEATHMATCH OVER' : "TIME'S UP"; ov.sub.textContent = race ? 'FINAL STANDINGS  ·  FIRST ACROSS THE LINE WINS' : dm ? 'FINAL STANDINGS  ·  MOST KILLS WINS' : 'FINAL STANDINGS  ·  MOST CASH WINS';
      const rows = V.blocks.map((b, i) => ({ b, i, name: (session.players[i] || {}).name || '?', color: playerColor(i) }))
        .sort((a, c) => race ? ((a.b.rank || 99) - (c.b.rank || 99)) : dm ? (c.b.kills - a.b.kills) || (c.b.cash - a.b.cash) : (c.b.cash - a.b.cash) || (c.b.kills - a.b.kills));
      const raceCell = b => b.place ? `<td class="n mark">FINISHED ${ordinal(b.place)}</td>` : `<td class="n">LAP ${Math.min(laps, b.lap + 1)}/${laps}  ·  CP ${b.next === 0 ? n - 1 : b.next - 1}/${n - 1}</td>`;
      ov.score.innerHTML = rows.map((r, k) => `<tr class="${r.i === myIdx ? 'me' : ''}"><td>${k + 1}</td><td><span class="sw" style="background:${hex(r.color)}"></span>${esc(r.name)}${r.b.gone ? '<span class="left">LEFT</span>' : ''}</td>${race ? raceCell(r.b) : `<td class="n cash">$${r.b.cash}</td>`}<td class="n kills">${r.b.kills} kills</td>${mw ? `<td class="n mark">${fmtClock(r.b.markT)} marked</td>` : ''}</tr>`).join('');
      ov.awards.innerHTML = awards.map(([key, idx, v, x]) => { const a = AWARDS[key]; return a ? `<tr class="${idx === myIdx ? 'me' : ''}"><td class="aw">${a[0]}</td><td><span class="sw" style="background:${hex(playerColor(idx))}"></span>${esc(nameOf(idx))}</td><td class="n mark">${esc(a[1](v, x, nameOf))}</td></tr>` : ''; }).join('');
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
    const changed = !lastIn || lastIn.m !== inp.m || lastIn.c !== inp.c || lastIn.x !== inp.x || lastIn.z !== inp.z || Math.abs(lastIn.y - inp.y) > 0.002 || Math.abs(lastIn.p - inp.p) > 0.002;
    const due = state === 'play' ? sinceIn >= 1 / 65 : (changed && sinceIn >= 1 / 60) || sinceIn >= 0.25;
    if (due) { lastIn = { ...inp }; sinceIn = 0; const msg = { t: 'in', to: hostId, m: inp.m, y: r3(inp.y), p: r3(inp.p), c: inp.c, q: inp.q || 0 }; if (inp.x) msg.x = inp.x; if (inp.z) msg.z = inp.z; if (inp.a) msg.a = 1;
      send(msg); count(netStats.out, 'in'); net.outMsgs++; net.outBytes += 64; }
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
    const thr = c && V.me && V.me.seat === 0 ? ((held.up || held.down) && state === 'play' ? 1 : 0) : 0;
    eng.gain.gain.setTargetAtTime(playing && c && !c.dead ? 0.045 + thr * 0.03 : 0, ctx.currentTime, 0.1);
    if (c) eng.osc.frequency.setTargetAtTime((45 + c.speed * 5.5 + thr * 20) * (c.type.bike ? 1.9 : c.type.bus ? 0.7 : 1), ctx.currentTime, 0.05); // a bike whines, a bus rumbles
    let near = 0; for (const cp of V.cops) if (cp.car) near = Math.max(near, 1 - Math.hypot(cp.x - V.subj.x, cp.z - V.subj.z) / 160);
    eng.sirenGain.gain.setTargetAtTime(playing ? clamp(near, 0, 1) * 0.035 : 0, ctx.currentTime, 0.1);
    eng.siren.frequency.setTargetAtTime(Math.floor(t * 2.5) % 2 ? 620 : 900, ctx.currentTime, 0.05);
  }
  /* whether a shot now would soft-lock a pedestrian (the host's rule, aimTol): the crosshair and the FIRE button turn red */
  let aimLock = false; const aimAt = { x: 0, y: 0, z: 0 }; // the soft-locked pedestrian's chest, while aimLock
  function findAimLock() {
    const me = V.me; aimLock = false;
    if (!canShoot(me) || state !== 'play' || !(isHost ? sim : remote)) return;
    const w = WEAPONS[me.curW], list = isHost ? sim.peds : remote.ents.values(), ox = cam.x, oy = cam.y, oz = cam.z, vx = cam.dx, vy = cam.dy, vz = cam.dz;
    const friendly = modeName() !== 'sandbox' || !session || !session.opts || session.opts.friendlyFire !== false; // the mark is hunted, and a race is anything goes
    let best = 1e9;
    for (const p of list) { if (p.cls !== 'ped' || p.id === me.pedId || p.dead || p.inCar || p.released || (!friendly && p.kind === 'player')) continue;
      const ddx = p.x - ox, ddz = p.z - oz; if (ddx * ddx + ddz * ddz > w.range * w.range) continue;
      for (const hy of [0.3, 1.0, 1.6]) { const dy = p.y + hy - oy, d = Math.hypot(ddx, dy, ddz); if (d < 1.5) continue;
        const ang = Math.acos(clamp((ddx * vx + dy * vy + ddz * vz) / d, -1, 1));
        if (ang < aimTol(d, touch) && ang < best && W.hasLOS(V.subj.x, V.subj.z, p.x, p.z)) { best = ang; aimLock = true; aimAt.x = p.x; aimAt.y = p.y + 1.0; aimAt.z = p.z; break; } } }
  }
  /* a thumb is a blunt aiming tool: while FIRE is held the camera is pulled onto the locked target, on top of the drag */
  function magnetise(dt) {
    if (!touch || !fireHeld || !aimLock || state !== 'play') return;
    const dx = aimAt.x - cam.x, dz = aimAt.z - cam.z, k = Math.min(1, MAGNET * dt);
    camYaw += angDiff(Math.atan2(dx, dz), camYaw) * k;
    camPitch = clamp(lerp(camPitch, Math.atan2(cam.y - aimAt.y, Math.hypot(dx, dz)), k), -0.45, 1.1);
  }
  /* who got me and how, read off my block the moment I die: the camera follows a player killer, the card names the cause */
  let death = null; const deathSubj = { x: 0, y: 0, z: 0, inCar: null, dead: false };
  /* the killcam (replay.js): the last seconds before a death by another player's hand, played back from behind the killer once the fall has been seen */
  const replay = createReplay(); let killcamT = -1;
  function noteDeath() {
    const me = V.me; if (!me) { death = { killer: -1, line1: 'WASTED', line2: '', t: 0 }; return; }
    const k = me.killer, cause = CAUSES[me.cause] || '', P = k >= 0 ? V.players[k] : null;
    const dist = P ? Math.round(Math.hypot(P.x - V.subj.x, P.z - V.subj.z)) : 0;
    let line1 = 'WASTED', line2 = CAUSE_TEXT[cause] || '';
    if (P) { line1 = (cause === 'runover' ? 'RUN OVER BY ' : cause === 'explosion' ? 'BLOWN UP BY ' : 'WASTED BY ') + P.name.toUpperCase(); line2 = (CAUSE_TEXT[cause] && cause !== 'runover' && cause !== 'explosion' ? CAUSE_TEXT[cause] + '  ·  ' : '') + dist + ' M'; }
    death = { killer: P ? k : -1, line1, line2, t: 0 };
  }
  /* where the route on the minimap, the yellow square and the marker column point: the race's next checkpoint, else my job's
     fare or destination, else the mission's target. { x, z, color, label, marker } or null (`marker`: a column and an edge arrow too). */
  const goalMarker = W.makeMarker(0xf2c014);
  /* the race's sat-nav: a trail of arrows on the road along the route (race.js raceGuide) and the next turn for the HUD */
  const guideArrows = Array.from({ length: 40 }, () => W.makeArrow()); let guide = null; // { turn, cp } from raceGuide, or null
  function layGuide() {
    let n = 0; guide = null;
    if (course && V.me && !V.me.place && !V.subj.dead && V.md.race && V.md.race.state > 0 && route.length && state !== 'over') {
      const yaw = V.car ? V.car.yaw : camYaw, g = raceGuide(route, V.subj.x, V.subj.z, Math.sin(yaw), Math.cos(yaw), 4, 14, routeCp); guide = g.turn || g.cp ? g : null;
      guideArrows[0].material.opacity = 0.55 + Math.sin(roundT * 6) * 0.2;
      for (const a of g.arrows) { if (n >= guideArrows.length) break; const m = guideArrows[n++]; m.visible = true; m.position.x = a.x; m.position.z = a.z; m.rotation.y = a.yaw; const sc = a.big ? 1.7 : 1; m.scale.set(sc, sc, sc); }
    }
    for (; n < guideArrows.length; n++) guideArrows[n].visible = false;
  }
  function goalOf() {
    const me = V.me, j = me && me.job, jt = j && JOB_TEXT[j.kind];
    if (course && me && !me.place) { const cp = nodeXZ(course[me.next]); return { x: cp.x, z: cp.z, color: 0x2fd0ff, label: me.next === 0 ? 'FINISH' : 'CP ' + me.next, marker: true }; }
    if (j && jt && j.stage > 0) return { x: j.x, z: j.z, color: jt.color, label: j.stage === 1 ? jt.who : 'DROP OFF', marker: true };
    const ms = MISSION_STATES[V.ms]; const tgt = ms === 'goto' || ms === 'intro' ? PLAZA : ms === 'hit' && V.vin ? V.vin : null;
    return tgt ? { x: tgt.x, z: tgt.z, color: 0xffe14d, label: 'TARGET', marker: false } : null;
  }
  function localFrame(dt) {
    if (lockPending > 0) { lockPending -= dt; if (lockPending <= 0 && !document.pointerLockElement && state === 'play') fallbackMouse = true; }
    touchLook(); magnetise(dt);
    if (V.subj.dead && !wasDead) { noteDeath(); killcamT = death && death.killer >= 0 ? REPLAY_DELAY : -1; } wasDead = V.subj.dead; if (!V.subj.dead) { death = null; killcamT = -1; replay.stop(); }
    let subj = V.subj, rf = null;
    if (V.subj.dead) { if (death) death.t += dt;
      if (killcamT > 0) { killcamT -= dt; if (killcamT <= 0) replay.start(death.killer, t); } // the fall is seen live, then the last seconds again from behind the killer
      if (replay.active) { rf = replay.frame(dt); if (!rf || !rf.cam) { replay.stop(); rf = null; } }
      if (rf) { for (const st of rf.states) st.view.draw(st, dt, t); W.dirtyDynamic(); subj = rf.cam.subj; camYaw = rf.cam.yaw; camPitch = rf.cam.pitch; if (rf.done) replay.stop(); }
      else { camYaw += dt * 0.35; camPitch = lerp(camPitch, 0.55, dt);
        const K = death && death.killer >= 0 ? V.players[death.killer] : null; if (K && !K.gone) { deathSubj.x = K.x; deathSubj.y = K.y; deathSubj.z = K.z; subj = deathSubj; } } } // the camera circles whoever did it
    else if (V.car && mouseIdle > 1.0) { const c = V.car; const target = c.vF < -1 ? c.yaw + PI : c.yaw; camYaw += angDiff(target, camYaw) * Math.min(1, 2.2 * dt); camPitch = lerp(camPitch, 0.22, dt); }
    computeCamera(W, subj, camYaw, camPitch, cam); camera.position.set(cam.x, cam.y, cam.z); camera.lookAt(cam.lx, cam.ly, cam.lz);
    findAimLock();
    W.dayNight(clock, subj.x, subj.z, camera); W.animate(dt, t, camera); fx.update(dt); carAmbient(dt); updateAudio();
    W.plazaMarker.visible = V.ms < 2; W.plazaMarker.rotation.y += dt; W.plazaMarker.material.opacity = 0.3 + Math.sin(roundT * 4) * 0.15;
    { const we = V.md.we, m = W.eventMarker; m.visible = !!we; if (we) { const fall = we.kind === 1 && !we.landed ? clamp((we.t - (AIRDROP_T - AIRDROP_FALL)) / AIRDROP_FALL, 0, 1) : 0; m.position.set(we.x, 20 + fall * 60, we.z); m.rotation.y += dt * 1.5; m.material.opacity = 0.3 + Math.sin(roundT * 5) * 0.15; } }
    W.sprayMarker.rotation.y -= dt; W.sprayMarker.material.opacity = (V.me && V.me.wanted > 0 ? 0.4 : 0.18) + Math.sin(roundT * 3) * 0.1;
    if (arena) fenceMat.opacity = V.me && V.me.outT > 0 ? 0.35 + Math.sin(roundT * 12) * 0.2 : 0.22;
    const d = districtAt(V.subj.x, V.subj.z), s = streetAt(V.subj.x, V.subj.z);
    if (d !== curDistrict) { curDistrict = d; curStreet = s; areaT = 5; } else if (s !== curStreet) { curStreet = s; areaT = Math.max(areaT, 3.5); }
    routeT -= dt;
    if (routeT <= 0) { const g = goalOf(); routeTarget = g; routeCp = -1;
      if (course && legs && V.me && !V.me.place) { routeT = 0.25; const yaw = V.car ? V.car.yaw : camYaw, r = raceRoute(course, legs, V.me.next, V.subj.x, V.subj.z, Math.sin(yaw), Math.cos(yaw)); route = r.nodes; routeCp = r.cp; } // the planned lap: this leg from the intersection ahead, then the next
      else { routeT = 0.6; route = g ? bfsRoute(nearestNode(V.subj.x, V.subj.z), nearestNode(g.x, g.z)) : []; } }
    layGuide();
    { const g = routeTarget, m = goalMarker; m.visible = !!(g && g.marker); if (m.visible) { m.position.set(g.x, 20, g.z); m.material.color.setHex(g.color); m.rotation.y += dt * 1.2; m.material.opacity = 0.35 + Math.sin(roundT * 4) * 0.15; } }
    areaT -= dt; wantedFlash -= dt; dmgFlash = Math.max(0, dmgFlash - dt * 1.4); mouseIdle += dt; localFireT -= dt; localArm -= dt; goT -= dt; finishT -= dt;
    if (onGrid()) { const c = Math.ceil(V.md.race.t); if (c !== lastCount && c > 0 && c <= 3) sfx.click(); lastCount = c; } // the countdown beeps
    if (autoQuality && state === 'play' && roundT > 4) { if (fps < 40) { lowFpsT += dt; if (lowFpsT > 2 && quality < QUALITY.length - 1) { setQuality(quality + 1); lowFpsT = 0; floatText('LOW FRAME RATE: ' + QUALITY[quality].name + ' DETAIL', 0x9fb4dc); } } else lowFpsT = 0; }
    for (let k = floats.length - 1; k >= 0; k--) { floats[k].t += dt; if (floats[k].t > 2.5) floats.splice(k, 1); }
    for (let k = feed.length - 1; k >= 0; k--) { feed[k].t += dt; if (feed[k].t > FEED_T) feed.splice(k, 1); }
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
    if (arena) { const A = arena, big = (MAP.MOFF * 2 + 200) * MAP.MS; hctx.fillStyle = 'rgba(0,0,0,0.55)'; hctx.beginPath(); hctx.rect(-big, -big, big * 3, big * 3); hctx.rect(wx(A.x0), wx(A.z0), wx(A.x1) - wx(A.x0), wx(A.z1) - wx(A.z0)); hctx.fill('evenodd'); // the city outside the arena, dimmed
      hctx.strokeStyle = V.me && V.me.outT > 0 && Math.floor(t * 6) % 2 ? '#ffffff' : '#ff3a3a'; hctx.lineWidth = 4; hctx.strokeRect(wx(A.x0), wx(A.z0), wx(A.x1) - wx(A.x0), wx(A.z1) - wx(A.z0)); }
    if (route.length > 1) { hctx.strokeStyle = '#d64fd6'; hctx.lineWidth = 4; hctx.beginPath(); hctx.moveTo(wx(me.x), wx(me.z));
      for (const [i, j] of route) hctx.lineTo(wx(X(i)), wx(X(j))); if (routeTarget && !course) hctx.lineTo(wx(routeTarget.x), wx(routeTarget.z)); hctx.stroke(); }
    if (routeTarget) { hctx.fillStyle = hex(routeTarget.color); hctx.fillRect(wx(routeTarget.x) - 6, wx(routeTarget.z) - 6, 12, 12); }
    if (course) { const next = V.me ? V.me.next : 1; // the course: numbered rings, the next one filled and blinking, the line a flag
      course.forEach((node, k) => { const p = nodeXZ(node), px = wx(p.x), pz = wx(p.z), isNext = k === next && V.me && !V.me.place;
        hctx.beginPath(); hctx.arc(px, pz, 8, 0, TAU); hctx.fillStyle = isNext ? (Math.floor(t * 4) % 2 ? '#2fd0ff' : '#ffffff') : 'rgba(0,0,0,0.5)'; hctx.fill(); hctx.strokeStyle = '#2fd0ff'; hctx.lineWidth = 2; hctx.stroke();
        ptext(hctx, k === 0 ? 'F' : String(k), px, pz - 3.5, 1.5, isNext ? '#000000' : '#ffffff', 'center', false); }); }
    { const tx = wx(TAXI_RANK.x + 3), tz = wx(TAXI_RANK.z); hctx.fillStyle = '#f2c014'; hctx.fillRect(tx - 6, tz - 6, 12, 12); ptext(hctx, 'T', tx, tz - 3.5, 1.5, '#000000', 'center', false); } // the taxi rank
    hctx.fillStyle = '#ffffff'; hctx.fillRect(wx(HOSPITAL.x) - 6, wx(HOSPITAL.z - 10) - 6, 12, 12); hctx.fillStyle = '#e02020'; hctx.fillRect(wx(HOSPITAL.x) - 4, wx(HOSPITAL.z - 10) - 1.5, 8, 3); hctx.fillRect(wx(HOSPITAL.x) - 1.5, wx(HOSPITAL.z - 10) - 4, 3, 8);
    // the Pay 'n' Spray (cyan, a spray can) and the precinct door (blue, a badge)
    { const sx = wx(SPRAY.x), sz = wx(SPRAY.z); hctx.fillStyle = '#2fd0ff'; hctx.fillRect(sx - 6, sz - 6, 12, 12); hctx.fillStyle = '#ffffff'; hctx.fillRect(sx - 2, sz - 2, 4, 6); hctx.fillRect(sx - 1, sz - 4.5, 2, 2); hctx.fillRect(sx + 1, sz - 4, 2.5, 1.5); }
    { const px = wx(POLICE_DOOR.x), pz = wx(POLICE_DOOR.z - 4); hctx.fillStyle = '#4d7fff'; hctx.fillRect(px - 6, pz - 6, 12, 12); hctx.fillStyle = '#ffffff'; hctx.beginPath(); hctx.moveTo(px, pz - 4); hctx.lineTo(px + 3.5, pz - 2.5); hctx.lineTo(px + 2.5, pz + 2); hctx.lineTo(px, pz + 4); hctx.lineTo(px - 2.5, pz + 2); hctx.lineTo(px - 3.5, pz - 2.5); hctx.closePath(); hctx.fill(); }
    for (const c of V.cops) { if (c.car) { hctx.fillStyle = Math.floor(t * 6) % 2 ? '#4d7fff' : '#ff4d4d'; hctx.fillRect(wx(c.x) - 5, wx(c.z) - 5, 10, 10); } else { hctx.fillStyle = '#4d7fff'; hctx.beginPath(); hctx.arc(wx(c.x), wx(c.z), 4, 0, TAU); hctx.fill(); } }
    if (V.vin && !V.vin.dead && MISSION_STATES[V.ms] === 'hit') { hctx.fillStyle = '#ff4d4d'; hctx.beginPath(); hctx.arc(wx(V.vin.x), wx(V.vin.z), 5, 0, TAU); hctx.fill(); }
    for (const p of V.players) if (!p.me && !p.gone) { hctx.fillStyle = hex(p.color); hctx.fillRect(wx(p.x) - 5, wx(p.z) - 5, 10, 10); hctx.strokeStyle = '#fff'; hctx.lineWidth = 1.5; hctx.strokeRect(wx(p.x) - 5, wx(p.z) - 5, 10, 10); }
    { const mk = V.md.mark, P = mk >= 0 ? V.players[mk] : null; // the mark: a pulsing yellow ring, on me too
      if (P && !P.gone) { hctx.strokeStyle = '#ffe14d'; hctx.lineWidth = 3; hctx.beginPath(); hctx.arc(wx(P.x), wx(P.z), 9 + Math.sin(t * 6) * 2, 0, TAU); hctx.stroke(); } }
    { const list = isHost ? sim.pickups : remote.ents.values(); // the weapon crates lying around (a letter on a square)
      for (const p of list) { const pm = p.cls === 'pick' && PICK_MAP[p.kind]; if (!pm) continue; const px = wx(p.x), pz = wx(p.z); hctx.fillStyle = pm[1]; hctx.fillRect(px - 6, pz - 6, 12, 12); ptext(hctx, pm[0], px, pz - 3.5, 1.5, '#000000', 'center', false); } }
    if (V.md.we) { const e = V.md.we, ex = wx(e.x), ez = wx(e.z); hctx.fillStyle = '#3dff7a'; hctx.beginPath(); hctx.moveTo(ex, ez - 9); hctx.lineTo(ex + 9, ez); hctx.lineTo(ex, ez + 9); hctx.lineTo(ex - 9, ez); hctx.closePath(); hctx.fill(); }
    hctx.restore();
    hctx.save(); hctx.translate(cx, cy); hctx.fillStyle = '#ffffff'; hctx.beginPath(); hctx.moveTo(0, -9); hctx.lineTo(6, 7); hctx.lineTo(0, 4); hctx.lineTo(-6, 7); hctx.closePath(); hctx.fill(); hctx.restore();
    const th = camYaw + PI, nx = Math.sin(th), ny = -Math.cos(th);
    const ax = cx + nx * (size / 2 - 14), ay = cy + ny * (size / 2 - 14);
    hctx.fillStyle = '#ff3333'; hctx.beginPath(); hctx.arc(ax, ay, 9, 0, TAU); hctx.fill(); ptext(hctx, 'N', ax, ay - 5, 2, '#ffffff', 'center', false);
    hctx.strokeStyle = '#ffffff'; hctx.lineWidth = 2; hctx.strokeRect(x, y, size, size);
  }
  /* the next turn: a chunky arrow (straight, left, right or a U) and the distance, with the road it turns onto under it */
  function drawTurnArrow(cx, cy, r, kind) {
    hctx.save(); hctx.translate(cx, cy); hctx.lineCap = 'square'; hctx.lineJoin = 'miter';
    const head = (px, py, dx, dy) => { const bx = px - dx * r * 0.6, by = py - dy * r * 0.6, sx = -dy * r * 0.6, sy = dx * r * 0.6; hctx.moveTo(bx + sx, by + sy); hctx.lineTo(px, py); hctx.lineTo(bx - sx, by - sy); };
    const path = () => { hctx.beginPath();
      if (kind === 'LEFT' || kind === 'RIGHT') { const m = kind === 'LEFT' ? -1 : 1; hctx.moveTo(0, r); hctx.lineTo(0, -r * 0.3); hctx.lineTo(m * r, -r * 0.3); head(m * r, -r * 0.3, m, 0); }
      else if (kind === 'U-TURN') { hctx.moveTo(r * 0.5, r); hctx.lineTo(r * 0.5, -r * 0.7); hctx.lineTo(-r * 0.5, -r * 0.7); hctx.lineTo(-r * 0.5, r * 0.5); head(-r * 0.5, r * 0.5, 0, 1); }
      else { hctx.moveTo(0, r); hctx.lineTo(0, -r); head(0, -r, 0, -1); } };
    path(); hctx.strokeStyle = '#000000'; hctx.lineWidth = r * 0.55; hctx.stroke();
    path(); hctx.strokeStyle = kind === 'U-TURN' ? '#ff6060' : '#2fd0ff'; hctx.lineWidth = r * 0.28; hctx.stroke();
    hctx.restore();
  }
  function drawGuide(rx, y, s) {
    const { turn, cp } = guide, r = s * 6, w = s * 86, label = routeTarget ? routeTarget.label : 'GOAL';
    hctx.fillStyle = 'rgba(0,0,0,0.55)'; hctx.fillRect(rx - w, y, w, r * 2 + s * 4);
    if (cp && (!turn || turn.kind === 'ARRIVE' || cp.d <= turn.d)) { // the checkpoint is next: name it, and under it the way out of it
      const after = turn && turn.kind !== 'ARRIVE' ? turn : null;
      drawTurnArrow(rx - w + r + s * 3, y + r + s * 2, r, after ? after.kind : 'STRAIGHT');
      ptext(hctx, `${label}  ${Math.round(cp.d)} M`, rx - s * 2, y + s * 3, s * 1.1, '#ffffff', 'right');
      ptext(hctx, after ? `THEN ${after.kind}  ·  ${after.street.toUpperCase()}` : 'THEN STRAIGHT ON', rx - s * 2, y + s * 13, s * 0.75, after && after.kind === 'U-TURN' ? '#ff6060' : '#2fd0ff', 'right');
      return; }
    drawTurnArrow(rx - w + r + s * 3, y + r + s * 2, r, turn.kind);
    const word = turn.kind === 'ARRIVE' ? label : turn.kind;
    ptext(hctx, `${word}  ${Math.round(turn.d)} M`, rx - s * 2, y + s * 3, s * 1.1, turn.kind === 'U-TURN' ? '#ff6060' : '#ffffff', 'right');
    ptext(hctx, turn.kind === 'ARRIVE' ? 'STRAIGHT ON' : turn.street.toUpperCase(), rx - s * 2, y + s * 13, s * 0.75, '#2fd0ff', 'right');
  }
  function bar(x, y, w, h, f, color) { hctx.fillStyle = 'rgba(0,0,0,0.7)'; hctx.fillRect(x - 2, y - 2, w + 4, h + 4); hctx.fillStyle = '#333'; hctx.fillRect(x, y, w, h); hctx.fillStyle = color; hctx.fillRect(x, y, w * clamp(f, 0, 1), h); }
  function drawNames(Wd, Hd, s) {
    for (const p of V.players) { if (p.me || p.gone) continue; const d = Math.hypot(p.x - V.subj.x, p.z - V.subj.z); if (d > 120) continue;
      V3.set(p.x, p.y + 2.15, p.z).project(camera); if (V3.z > 1 || V3.x < -1.2 || V3.x > 1.2 || V3.y < -1.2 || V3.y > 1.2) continue;
      const sx = (V3.x + 1) / 2 * Wd, sy = (1 - V3.y) / 2 * Hd, sc = s * clamp(1.4 - d / 60, 0.55, 1.1);
      ptext(hctx, p.name, sx, sy - 7 * sc, sc, p.dead ? '#888888' : hex(p.color), 'center'); }
  }
  /* arrows at the edge of the screen (or a tag over a far target) for the other players, the mark and the world event */
  function drawEdgeArrows(Wd, Hd, s, L, R, T, B) {
    if (V.subj.dead) return;
    const mk = V.md.mark, we = V.md.we, cx = Wd / 2, cy = Hd / 2, sc = s * 0.8;
    const one = (x, y, z, color, label, always) => {
      const d = Math.hypot(x - V.subj.x, z - V.subj.z); if (d < 3) return;
      V3.set(x, y + 2.2, z).project(camera);
      const behind = V3.z > 1, on = !behind && V3.x > -1 && V3.x < 1 && V3.y > -1 && V3.y < 1;
      const text = label + ' ' + Math.round(d) + 'M';
      if (on && d < ARROW_FROM && !always) return; // its name is over its head already
      if (on) { const sx = (V3.x + 1) / 2 * Wd, sy = (1 - V3.y) / 2 * Hd; hctx.fillStyle = hex(color); hctx.beginPath(); hctx.moveTo(sx, sy + 6); hctx.lineTo(sx - 5, sy - 3); hctx.lineTo(sx + 5, sy - 3); hctx.closePath(); hctx.fill(); ptext(hctx, text, sx, sy - 12 * sc, sc, hex(color), 'center'); return; }
      let dx = (V3.x + 1) / 2 * Wd - cx, dy = (1 - V3.y) / 2 * Hd - cy; if (behind) { dx = -dx; dy = -dy; }
      const l = Math.hypot(dx, dy) || 1; dx /= l; dy /= l;
      const k = Math.min((cx - (L + 44)) / Math.abs(dx || 1e-6), (cy - (T + s * 34)) / Math.abs(dy || 1e-6), (cx - (Wd - R + 44 + s * 52)) / Math.abs(dx || 1e-6), (cy - (Hd - B + 60)) / Math.abs(dy || 1e-6));
      const px = cx + dx * k, py = cy + dy * k, a = Math.atan2(dy, dx);
      hctx.save(); hctx.translate(px, py); hctx.rotate(a); hctx.fillStyle = hex(color); hctx.beginPath(); hctx.moveTo(10, 0); hctx.lineTo(-6, -7); hctx.lineTo(-6, 7); hctx.closePath(); hctx.fill(); hctx.restore();
      ptext(hctx, text, px - dx * 16, py - dy * 16 - 3 * sc, sc, hex(color), 'center');
    };
    for (let i = 0; i < V.players.length; i++) { const p = V.players[i]; if (p.me || p.gone || p.dead) continue; const isMark = i === mk; one(p.x, p.y, p.z, isMark ? 0xffe14d : p.color, isMark ? 'MARK ' + p.name : p.name, isMark); }
    if (we) one(we.x, 0, we.z, 0x3dff7a, EVENT_TEXT[we.kind] || 'EVENT', true);
    if (routeTarget && routeTarget.marker) one(routeTarget.x, 0, routeTarget.z, routeTarget.color, routeTarget.label, true);
  }
  function drawHUD() {
    const Wd = innerWidth, Hd = innerHeight; hctx.clearRect(0, 0, Wd, Hd); if (saStale) measureSafeArea();
    const s = Math.max(2, Math.round(Wd / 640)), me = V.me, short = Hd < 560; // short: a phone in landscape
    const L = 16 + sa.l, R = Wd - 16 - sa.r, T = 14 + sa.t, B = Hd - 16 - sa.b; // the HUD's edges, inside the notch and the home indicator
    if (!me) { ptext(hctx, 'WAITING FOR THE HOST…', Wd / 2, Hd / 2, s, '#ffffff', 'center'); return; }
    const dead = me.dead, inCar = me.carId >= 0, deadT = dead ? Math.max(0, wastedTimeOf(modeName()) - me.wastedT) : 0;
    if (dead && replay.active) { // the killcam: letterboxed, nothing else of the HUD (the names, arrows, briefing and feed all describe the live world, not the clip)
      const bar = Math.round(Hd * 0.09); hctx.fillStyle = '#000000'; hctx.fillRect(0, 0, Wd, bar); hctx.fillRect(0, Hd - bar, Wd, bar);
      ptext(hctx, 'KILLCAM', Wd / 2, bar + s * 6, s * 1.6, '#ff6060', 'center'); ptext(hctx, 'THROUGH THE EYES OF ' + nameOf(replay.killer).toUpperCase(), Wd / 2, bar + s * 22, s, hex(playerColor(replay.killer)), 'center');
      hctx.fillStyle = '#ff6060'; hctx.fillRect(0, Hd - bar, Math.round(Wd * replay.progress), 3); return; }
    const lowHp = me.health < 30 && !dead ? 0.12 + 0.08 * Math.sin(t * 6) : 0;
    if (dmgFlash > 0 || lowHp) { const a = clamp(dmgFlash * 0.65 + lowHp, 0, 0.85); const g = hctx.createRadialGradient(Wd / 2, Hd / 2, Hd * 0.2, Wd / 2, Hd / 2, Hd * 0.8); g.addColorStop(0, `rgba(190,0,0,${a * 0.35})`); g.addColorStop(1, `rgba(190,0,0,${a})`); hctx.fillStyle = g; hctx.fillRect(0, 0, Wd, Hd); }
    drawNames(Wd, Hd, s); drawEdgeArrows(Wd, Hd, s, L, R, T, B);
    if (canShoot(me) && state === 'play') { // the crosshair: red and a little wider while a shot would lock onto someone
      const g = aimLock ? 4 : 3, l = aimLock ? 7 : 6; hctx.fillStyle = aimLock ? '#ff4040' : '#ffffff';
      hctx.fillRect(Wd / 2 - 1, Hd / 2 - g - l, 2, l); hctx.fillRect(Wd / 2 - 1, Hd / 2 + g, 2, l); hctx.fillRect(Wd / 2 - g - l, Hd / 2 - 1, l, 2); hctx.fillRect(Wd / 2 + g, Hd / 2 - 1, l, 2); }
    // top-right: stars, clock, cash, health, weapon, kills, round timer
    const rx = R; let y = T;
    if (modeName() !== 'deathmatch') { // no stars in the arena: the police stay out of a deathmatch
      for (let k = 0; k < 5; k++) { const on = k < me.wanted; const blink = on && wantedFlash > 0 && Math.floor(t * 8) % 2 === 0; ptext(hctx, '*', rx - (4 - k) * s * 8, y, s * 1.3, on ? (blink ? '#ffffff' : '#ffe14d') : 'rgba(255,255,255,0.18)', 'right'); }
      y += s * 12; }
    const hh = Math.floor(clock), mm = Math.floor((clock - hh) * 60);
    ptext(hctx, String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0'), rx, y, s * 1.3, '#ffffff', 'right'); y += s * 12;
    ptext(hctx, '$' + String(Math.max(0, me.cash)).padStart(6, '0'), rx, y, s * 1.3, '#3dff7a', 'right'); y += s * 12;
    bar(rx - s * 52, y, s * 52, s * 4, me.health / 100, me.health > 30 ? '#38c84a' : '#e03030'); y += s * 8;
    if (guns) { // the gun in hand, its magazine, and the five slots
      const w = WEAPONS[me.curW]; const icon = ICONS[w.key];
      hctx.fillStyle = 'rgba(0,0,0,0.55)'; hctx.fillRect(rx - s * 52, y, s * 52, s * 12);
      drawIcon(hctx, icon, rx - s * 50, y + s * 2, s * 1, '#ffffff');
      ptext(hctx, me.reloadT > 0 ? 'RELOAD' : me.ammo + '/' + me.reserve, rx - s * 2, y + s * 3, s, me.reloadT > 0 ? '#ffe14d' : '#ffffff', 'right'); y += s * 14;
      ptext(hctx, w.name, rx, y, s * 0.8, '#bbbbbb', 'right'); y += s * 9;
      for (let k = 0; k < WEAPONS.length; k++) { const owned = me.owned & (1 << k); ptext(hctx, String(k + 1), rx - (WEAPONS.length - 1 - k) * s * 8, y, s * 0.9, k === me.curW ? '#ffe14d' : owned ? '#ffffff' : 'rgba(255,255,255,0.2)', 'right'); } y += s * 9; } // the weapons I carry, by their key
    ptext(hctx, 'KILLS ' + me.kills + (V.md.dm ? '/' + V.md.dm.cap : ''), rx, y, s * 1.1, '#ff6060', 'right'); y += s * 10;
    if (V.timeLeft >= 0) { ptext(hctx, 'ROUND ' + fmtClock(V.timeLeft), rx, y, s * 1.1, V.timeLeft < 30 ? '#ff4d4d' : '#7fe0ff', 'right'); y += s * 10; }
    const race = course && V.md.race, racers = V.players.filter(p => !p.gone).length, cpN = course ? course.length - 1 : 0;
    if (race) { // my standing, big, and the lap under it
      ptext(hctx, me.place ? ordinal(me.place) : ordinal(me.rank || racers), rx, y, s * 2.4, me.place || me.rank === 1 ? '#ffe14d' : '#ffffff', 'right'); y += s * 20;
      ptext(hctx, me.place ? 'FINISHED' : `LAP ${Math.min(laps, me.lap + 1)}/${laps}  ·  CP ${me.next === 0 ? cpN : me.next - 1}/${cpN}`, rx, y, s * 0.9, '#2fd0ff', 'right'); y += s * 9;
      if (race.state === 2) { ptext(hctx, 'RACE ENDS ' + fmtClock(Math.max(0, race.t)), rx, y, s * 0.9, '#ff6060', 'right'); y += s * 9; }
      if (guide && !dead) { drawGuide(rx, y, s); y += s * 20; } }
    // top-left: mission briefing (on a phone the paragraph folds away once the intro is over, leaving the objective)
    { const px = L; let py = T; const tw = Math.min(Wd * 0.42, s * 150); const ms = MISSION_STATES[V.ms] || 'intro', mw = modeName() === 'mostWanted', mk = V.md.mark, dm = V.md.dm;
      hctx.fillStyle = 'rgba(0,0,0,0.5)';
      const brief = short && roundT > INTRO_T + 6 ? [] : wrapText(race ? briefRace(laps, guns) : dm ? briefDm(dm.cap, guns) : mw ? BRIEF_MW : BRIEF, Math.floor(tw / (6 * s * 0.8)));
      const job = me.job, jt = job && JOB_TEXT[job.kind];
      const objective = race ? (race.state === 0 ? 'On the grid. Wait for the green.' : me.place ? `You finished ${ordinal(me.place).toLowerCase()}. ${race.finishers < racers ? 'The rest have ' + Math.ceil(Math.max(0, race.t)) + ' s.' : ''}`
          : `${me.next === 0 ? 'Back across the line' : 'Checkpoint ' + me.next + ' of ' + cpN}, ${streetAt(routeTarget ? routeTarget.x : 0, routeTarget ? routeTarget.z : 0)}.  ${ordinal(me.rank || racers)} of ${racers}.`)
        : jt ? (job.stage === 0 ? `A ${jt.who.toLowerCase()} is on the way.` : job.stage === 1 ? `Pick up the ${jt.who.toLowerCase()} on ${streetAt(job.x, job.z)}.` : `Take the ${jt.who.toLowerCase()} to ${job.kind === 2 ? 'the hospital' : streetAt(job.x, job.z)}.`) + (job.stage > 0 ? '  ' + fmtClock(job.t) : '') + (job.n ? `  ·  ${job.n} in a row` : '')
        : dm ? `${me.kills} of ${dm.cap} kills.  ${dm.leader < 0 ? 'Nobody has scored yet.' : dm.leader === myIdx ? 'You lead.' : `${nameOf(dm.leader)} leads with ${dm.kills}.`}`
        : !mw ? OBJECTIVES[ms] : mk < 0 ? 'The mark is drawn in a moment. Find a car.' : mk === myIdx ? `You are the mark. Stay alive: +$${MARK_CASH_PER_S} a second.` : `Hunt ${nameOf(mk)}. The kill pays $${MARK_BOUNTY} and the mark.`;
      const objLines = wrapText('> ' + objective, Math.floor(tw / (6 * s * 0.9)));
      hctx.fillRect(px - 6, py - 6, tw + 12, s * 12 + brief.length * s * 7.5 + objLines.length * s * 8.5 + s * 10);
      ptext(hctx, race ? 'STREET RACE' : jt ? jt.title : dm ? 'DEATHMATCH' : mw ? 'MOST WANTED' : 'THE DOWNTOWN HIT', px, py, s * 1.2, '#ffe14d'); py += s * 12;
      for (const l of brief) { ptext(hctx, l, px, py, s * 0.8, '#dddddd'); py += s * 7.5; }
      py += s * 3; for (const l of objLines) { ptext(hctx, l, px, py, s * 0.9, race ? (me.place ? '#ffe14d' : '#2fd0ff') : jt ? (job.stage > 0 && job.t < 10 ? '#ff6060' : hex(jt.color)) : dm ? (dm.leader === myIdx ? '#ffe14d' : '#ff6060') : mw ? (mk === myIdx ? '#ffe14d' : '#ff6060') : ms === 'done' ? '#3dff7a' : '#7fe0ff'); py += s * 8.5; }
      drawFeed(px, py + s * 6, s, short || touch ? FEED_LINES_PHONE : FEED_LINES); }
    // the race: the countdown on the grid, GO!, and the finish flash
    if (race && race.state === 0) { const c = Math.ceil(race.t); hctx.fillStyle = 'rgba(0,0,0,0.35)'; hctx.fillRect(0, Hd * 0.3, Wd, Hd * 0.3);
      ptext(hctx, c > 3 ? 'ON THE GRID' : String(c), Wd / 2, Hd * 0.36, c > 3 ? s * 2.5 : s * 6, c > 3 ? '#ffe14d' : c === 1 ? '#ff6060' : '#ffffff', 'center'); ptext(hctx, `${laps} LAP${laps === 1 ? '' : 'S'}  ·  ${cpN} CHECKPOINTS  ·  ${guns ? 'ANYTHING GOES' : 'NO GUNS'}`, Wd / 2, Hd * 0.36 + s * (c > 3 ? 26 : 50), s * 1.1, '#ffffff', 'center'); }
    if (arena && me.outT > 0 && !dead) { const left = OUT_WARN_T - me.outT; hctx.fillStyle = 'rgba(120,0,0,0.45)'; hctx.fillRect(0, Hd * 0.3, Wd, Hd * 0.22);
      ptext(hctx, left > 0 ? 'GET BACK IN THE ARENA' : 'YOU ARE TAKING DAMAGE', Wd / 2, Hd * 0.34, s * 2.2, Math.floor(t * 6) % 2 ? '#ffffff' : '#ff6060', 'center');
      ptext(hctx, left > 0 ? String(Math.ceil(left)) : 'GET BACK', Wd / 2, Hd * 0.34 + s * 24, s * 4, '#ffffff', 'center'); }
    else if (goT > 0) { hctx.globalAlpha = clamp(goT, 0, 1); ptext(hctx, 'GO!', Wd / 2, Hd * 0.34, s * 6, '#3dff7a', 'center'); hctx.globalAlpha = 1; }
    if (finishT > 0 && me.place) { hctx.globalAlpha = clamp(finishT, 0, 1); hctx.fillStyle = 'rgba(0,0,0,0.5)'; hctx.fillRect(0, Hd * 0.3, Wd, Hd * 0.3); ptext(hctx, ordinal(me.place), Wd / 2, Hd * 0.36, s * 5, '#ffe14d', 'center'); ptext(hctx, me.place === 1 ? 'FIRST ACROSS THE LINE' : 'ACROSS THE LINE', Wd / 2, Hd * 0.36 + s * 44, s * 1.2, '#ffffff', 'center'); hctx.globalAlpha = 1; }
    // the world event banner, under the wanted flash
    if (V.md.we) { const e = V.md.we, left = fmtClock(Math.max(0, e.t)), txt = e.kind === 1 ? (e.landed ? 'AIRDROP DOWN  ·  ' + left : 'AIRDROP LANDS IN ' + Math.ceil(Math.max(0, e.t - (AIRDROP_T - AIRDROP_FALL)))) : (e.landed ? 'TRUCK OPEN  ·  ' + left : 'ARMORED TRUCK  ·  ' + left);
      ptext(hctx, txt, Wd / 2, T + s * 2, s * 0.9, '#3dff7a', 'center'); }
    // bottom-left: minimap + area name
    const msz = Math.min(short ? 140 : 230, Math.round(Wd * 0.2)); drawMinimap(L, B - msz, msz);
    if (areaT > 0) { const a = clamp(areaT, 0, 1); hctx.globalAlpha = a; ptext(hctx, curDistrict, L + msz + 18, B - s * 20, s * 1.6, '#ffe14d'); ptext(hctx, curStreet, L + msz + 18, B - s * 8, s, '#ffffff'); hctx.globalAlpha = 1; }
    const hint = (touch ? HINT_TOUCH : HINT)[me.hint] || '';
    if (hint && !dead && state === 'play') ptext(hctx, hint, Wd / 2, B - s * 12 + 4, s, '#ffffff', 'center');
    // centre messages
    if ((MISSION_STATES[V.ms] === 'intro' || modeName() === 'mostWanted' || modeName() === 'deathmatch') && !course && roundT < INTRO_T) { const a = roundT < 0.5 ? roundT * 2 : roundT > 4.5 ? (INTRO_T - roundT) : 1; hctx.globalAlpha = clamp(a, 0, 1); const mw = modeName() === 'mostWanted', dm = modeName() === 'deathmatch';
      hctx.fillStyle = 'rgba(0,0,0,0.6)'; hctx.fillRect(0, Hd * 0.32, Wd, Hd * 0.28);
      ptext(hctx, dm ? 'DEATHMATCH' : mw ? 'MOST WANTED' : 'THE DOWNTOWN HIT', Wd / 2, Hd * 0.38, s * 3, '#ffe14d', 'center'); ptext(hctx, dm ? `FIRST TO ${killCap} KILLS. NO STARS FOR IT.` : mw ? 'CARRY THE MARK. HUNT THE MARK.' : 'WHACK THE SNITCH', Wd / 2, Hd * 0.38 + s * 30, s * 1.2, '#ffffff', 'center'); hctx.globalAlpha = 1; }
    if (wantedFlash > 0 && Math.floor(t * 5) % 2 === 0 && !dead) ptext(hctx, 'WANTED LEVEL ' + '*'.repeat(me.wanted), Wd / 2, Hd * 0.22, s * 2.2, '#ffe14d', 'center');
    if (dead) { hctx.fillStyle = `rgba(0,0,0,${clamp(deadT * 0.3, 0, 0.55)})`; hctx.fillRect(0, 0, Wd, Hd); const sc = s * (4 + Math.min(1, deadT) * 2); ptext(hctx, 'WASTED', Wd / 2, Hd / 2 - sc * 4, sc, '#d01010', 'center');
      if (death && deadT > 0.8) { ptext(hctx, death.line1, Wd / 2, Hd / 2 + sc * 4, s * 1.2, '#ffffff', 'center'); if (death.line2) ptext(hctx, death.line2, Wd / 2, Hd / 2 + sc * 4 + s * 12, s * 0.9, '#bbbbbb', 'center'); } }
    if (MISSION_STATES[V.ms] === 'passed') { hctx.fillStyle = 'rgba(0,0,0,0.5)'; hctx.fillRect(0, Hd * 0.3, Wd, Hd * 0.3);
      ptext(hctx, 'MISSION PASSED', Wd / 2, Hd * 0.36, s * 3, '#ffe14d', 'center'); ptext(hctx, '+$5000', Wd / 2, Hd * 0.36 + s * 30, s * 2, '#3dff7a', 'center'); ptext(hctx, 'RESPECT +', Wd / 2, Hd * 0.36 + s * 48, s, '#ffffff', 'center'); }
    floats.forEach((f, i) => { const a = clamp(2.5 - f.t, 0, 1); hctx.globalAlpha = a; ptext(hctx, f.text, Wd / 2, Hd * 0.62 - f.t * 30 - i * s * 10, s * 1.1, hex(f.color), 'center'); hctx.globalAlpha = 1; });
    let line = 'FPS ' + Math.round(fps); if (online) line += isHost ? '  HOST' : `  LAG ${Math.round(pred ? pred.lag : 0)} MS  HOST ${net.hostFps} FPS`;
    if (touch) ptext(hctx, line, Wd / 2 + 34, sa.t + 16, s * 0.7, 'rgba(255,255,255,0.45)', 'left', false); // beside the ☰; the corner is under the FIRE button
    else ptext(hctx, line, R, B - s * 7, s * 0.7, 'rgba(255,255,255,0.45)', 'right', false);
    if (showStats) drawStats(Wd, Hd, s);
  }
  /* the feed: the newest `max` lines, each on its own dark strip, fading out over the last moment of its life */
  function drawFeed(x, y, s, max) {
    const sc = s * 0.85, is = s * 0.75, h = sc * 7, gap = s * 3, iconW = p => ICONS[p.icon][0].length * is;
    for (let i = 0; i < Math.min(max, feed.length); i++) { const f = feed[i], a = clamp((FEED_T - f.t) / FEED_FADE, 0, 1); if (a <= 0) continue;
      hctx.globalAlpha = a; let w = -gap; for (const p of f.parts) w += (p.icon ? iconW(p) : textW(String(p.t), sc)) + gap;
      hctx.fillStyle = 'rgba(0,0,0,0.5)'; hctx.fillRect(x - 6, y - 4, w + 12, h + 8);
      let px = x; for (const p of f.parts) { if (p.icon) { drawIcon(hctx, ICONS[p.icon], px + is, y + is, is, 'rgba(0,0,0,0.85)'); drawIcon(hctx, ICONS[p.icon], px, y, is, '#ffffff'); px += iconW(p) + gap; } else px += ptext(hctx, p.t, px, y, sc, p.c) + gap; }
      y += h + s * 5; }
    hctx.globalAlpha = 1;
  }
  function drawStats(Wd, Hd, s) {
    const sc = Hd < 560 ? s * 0.55 : s * 0.8, lines = [ // a phone gets a smaller face so the lines fit its width
      `FRAME ${timing.frame.toFixed(1)} MS (${Math.round(fps)} FPS)   SIM ${timing.sim.toFixed(1)}   RENDER ${timing.render.toFixed(1)}   HUD ${timing.hud.toFixed(1)}`,
      `DETAIL ${QUALITY[quality].name}${autoQuality ? ' (AUTO)' : ''}   PIXEL RATIO ${renderer.getPixelRatio().toFixed(2)}   ${innerWidth}X${innerHeight}`,
    ];
    if (touch) { // a control that stays HELD after the finger left is the bug these lines are for
      const ctlWord = c => (c.held ? 'HELD #' + c.pid : 'FREE') + (c.last ? ' (' + c.last.toUpperCase() + ')' : '');
      lines.push(`TOUCH   STICK ${ctlWord(stickS)}   LOOK ${ctlWord(lookS)}   FIRE ${ctlWord(fireS)}   JUMP ${ctlWord(jumpS)}`);
      lines.push(`STICK   ${stickS.x.toFixed(2)} ${stickS.y.toFixed(2)} -> ${axes.x.toFixed(2)} / ${axes.z.toFixed(2)}${axes.sprint ? ' RUN' : ''}   LOOK ${LOOK[lookLevel].name}   SAFE AREA ${Math.round(sa.t)} ${Math.round(sa.r)} ${Math.round(sa.b)} ${Math.round(sa.l)}`);
    }
    if (!online) lines.push(`SOLO   ENTITIES ${sim.peds.length} PEDS  ${sim.cars.length} CARS  ${sim.pickups.length} PICKUPS`);
    else if (isHost) lines.push(`HOST   SNAPSHOTS OUT ${net.rateOut.toFixed(0)}/S  ${net.kbOut.toFixed(1)} KB/S TO ${clients.filter(c => !c.pl.gone).length} PLAYER(S)   ENTITIES ${sim.peds.length} PEDS  ${sim.cars.length} CARS`);
    else lines.push(`CLIENT   SNAPSHOTS IN ${net.rateIn.toFixed(0)}/S  ${net.kbIn.toFixed(1)} KB/S   INPUT OUT ${net.rateOut.toFixed(0)}/S   HOST ${net.hostFps} FPS`,
      `INPUT LAG ${Math.round(pred ? pred.lag : 0)} MS   OTHERS SHOWN ${Math.round(INTERP * 1000)} MS BACK   CORRECTIONS ${pred ? pred.corrections : 0}   ENTITIES ${remote ? remote.ents.size : 0}`);
    const w = Math.max(...lines.map(l => textW(l, sc))) + s * 8, x = Wd / 2 - w / 2, y = s * 26 + sa.t;
    hctx.fillStyle = 'rgba(0,0,0,0.6)'; hctx.fillRect(x, y - s * 3, w, lines.length * sc * 9 + s * 4);
    lines.forEach((l, i) => ptext(hctx, l, x + s * 4, y + i * sc * 9, sc, i === 0 ? '#ffe14d' : '#dddddd'));
  }

  /* ---- the touch buttons follow the game: USE says what F would do, JUMP becomes the handbrake in a car, FIRE dims
     in a car and shows the magazine, WEAPON shows the gun, RELOAD lights up when there is something to reload */
  let touchKey = '';
  function syncTouch() {
    if (!touch) return;
    const me = V.me, inCar = !!(me && me.carId >= 0), driving = inCar && me.seat === 0, hint = me ? me.hint : 0, w = WEAPONS[me ? me.curW : 0];
    const useLabel = hint === 1 || hint === 6 ? 'EXIT' : hint === 2 ? 'JACK' : hint === 3 ? 'ENTER' : hint === 7 ? 'GET IN' : hint === 5 ? 'TURN IN' : 'USE';
    const reloading = !!(me && me.reloadT > 0), canReload = !!(me && !reloading && me.ammo < w.mag && me.reserve > 0), ammo = !me ? '' : reloading ? '…' : String(me.ammo);
    const key = `${driving}|${useLabel}|${w.key}|${canReload}|${ammo}|${aimLock}`;
    if (key === touchKey) return; touchKey = key;
    tb.use.textContent = useLabel; tb.use.classList.toggle('hot', useLabel !== 'USE');
    tb.jump.textContent = driving ? 'HANDBRAKE' : 'JUMP'; tb.jump.classList.toggle('car', driving);
    tb.fire.classList.toggle('dim', driving); tb.fire.classList.toggle('lock', aimLock); tb.ammo.textContent = ammo;
    tb.wname.textContent = w.name; tb.wicon.clearRect(0, 0, 48, 24); drawIcon(tb.wicon, ICONS[w.key], 0, 0, 3, '#ffffff');
    tb.reload.classList.toggle('hot', canReload);
  }

  /* ---- main loop */
  const loop = createLoop((real, now) => {
    const raw = Math.min(0.1, real); t += raw; roundT += raw; fps = lerp(fps, 1 / Math.max(raw, 1e-3), 0.05);
    const t0 = performance.now(), inp = readInput();
    if (isHost) {
      sim.S.draw = !replay.active; // the killcam draws the views from its own frames
      if (online || state === 'play' || state === 'over') { sim.setInput(me, inp); const steps = raw > 0.034 ? 2 : 1, dt = raw / steps; for (let k = 0; k < steps; k++) sim.update(dt); }
      if (online) hostNetTick(raw); else sim.clearEvents();
      hostView();
    } else {
      if (remote.R.got) inp.q = pred.step(inp.m, camYaw, localArm > 0, raw, remote.R.P[myIdx], remote, t0, inp.x, inp.z);
      clientSendInput(inp, raw);
      if (remote.R.got) { clock += raw / 45; remote.update(raw, t, myIdx, camPitch, pred.local(), !replay.active); }
      clientView();
      if (state === 'play' && fireHeld) localShot(true);
    }
    if (V.me) replay.record(t, (isHost ? sim : remote).ents.values(), V.blocks);
    const t1 = performance.now();
    localFrame(raw); syncTouch();
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
    camYaw = 0; camPitch = 0.22; mouseIdle = 10; t = 0; roundT = 0; clicks = 0; fireHeld = false; dmgFlash = 0; wantedFlash = 0; floats.length = 0; feed.length = 0; awards = []; areaT = 0; curDistrict = ''; curStreet = ''; route = []; routeT = 0; lastIn = null; sinceIn = 1; netAcc = 0; lockPending = 0;
    clock = START_CLOCK[(s.opts || {}).time] ?? START_CLOCK.morning;
    fx.reset();
    if (isHost) {
      sim = createSim({ W, session: s, opts: s.opts || {}, onEvent }); me = sim.players[myIdx];
      clients = s.players.filter(p => p.id !== myId).map(p => ({ id: p.id, known: new Set(), pl: sim.playerOf(p.id) }));
      hostView();
      if ((s.opts || {}).mode === 'mostWanted' && sim.mode !== 'mostWanted') floatText('MOST WANTED NEEDS TWO PLAYERS: SANDBOX INSTEAD', 0x9fb4dc);
      if ((s.opts || {}).mode === 'deathmatch' && sim.mode !== 'deathmatch') floatText('A DEATHMATCH NEEDS TWO PLAYERS: SANDBOX INSTEAD', 0x9fb4dc);
    } else { remote = createRemote({ W }); pred = createPredictor({ W }); clientView(); }
    localFireT = 0; localArm = 0; lowFpsT = 0; net.at = performance.now(); net.inMsgs = net.inBytes = net.outMsgs = net.outBytes = 0;
    laps = lapsOf(s.opts || {}); killCap = killCapOf(s.opts || {}); guns = gunsOn(s.opts || {}); root.classList.toggle('noguns', !guns); // the HUD's copy of the lobby's knobs; the touch FIRE, WEAPON and RELOAD buttons go with the guns
    arena = modeOf(s.opts || {}, s.players.length) === 'deathmatch' ? arenaOf(s.seed) : null; placeFence(arena);
    course = (s.opts || {}).mode === 'race' ? raceCourse(s.seed) : null; legs = course ? planLap(course) : null; routeCp = -1; goT = 0; lastCount = -1; finishT = 0; // the course and the lap plan come from the seed on every machine
    root.classList.remove('over'); touchKey = ''; aimLock = false; wasDead = false; death = null; killcamT = -1; replay.reset(); W.eventMarker.visible = false; goalMarker.visible = false; routeTarget = null;
    state = 'grab'; showOverlay('grab'); kb.attach(); if (touch) tc.attach(); sizeHud(); audio.init(); loop.start();
  }
  function stop() { stopRound(); fx.reset(); state = 'idle'; ov.el.hidden = true; fireHeld = false; kb.detach(); tc.detach(); loop.stop(); if (document.pointerLockElement === root) document.exitPointerLock(); }
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
  const debug = { get sim() { return sim; }, get remote() { return remote; }, get state() { return state; }, get session() { return session; }, V, W, get camYaw() { return camYaw; }, get fps() { return fps; }, grab, pause, get clients() { return clients; }, netStats, net, timing, get pred() { return pred; }, get quality() { return quality; }, setQuality, get held() { return held; }, get fallbackMouse() { return fallbackMouse; },
    get aimLock() { return aimLock; }, sa, touch: { on: touch, stick: stickS, lookPad: lookS, fire: fireS, jump: jumpS, axes, readInput, get sensitivity() { return LOOK[lookLevel]; }, cycleLook } };
  debug.replay = replay; window.__gta = debug;
  return { start, stop, destroy, onNetMessage, playerLeft, debug };
}
