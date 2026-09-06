/* Dodgeball 3v3 - a top-down gym dodgeball match. Game module for the LAN party shell; the contract is
   documented at the top of games/kart/index.js.

   Teams: the shell's lobby puts every player on BLUE or RED (session.players[i].team). Empty slots are filled
   with CPU bodies when the "fill with CPU" option is on; a side with nobody on it always gets at least one CPU.

   Netcode: host-authoritative. The host simulates every body, every ball and the round clock. The other
   players send their input to the host (`in` / `th`, addressed with `to`) and render the host's 30 Hz `s`
   snapshots interpolated a little in the past. Effects (hits, throws, bounces, banners) ride inside the
   snapshot as events, so every screen sees and hears the same match. The roster is derived from the session
   identically on every machine, which is what lets snapshots refer to players by index.

   Touch screens (core/touch.js): the left part of the screen is a thumb stick, SPRINT and THROW sit under the right thumb
   (THROW fires when the finger lifts, so dragging it first aims the throw instead of taking the nearest enemy), ☰ opens a
   menu card, a phone held upright is asked to rotate, and on a phone in landscape the score and the status float over the
   crowd so the court is as big as the screen allows. An online host keeps simulating from a worker timer while its tab is
   hidden, so the match goes on for the others.

   Physics note: hand-rolled circle physics with fixed 240 Hz substeps, swept circle-vs-circle hit tests for
   thrown balls, exact reflection off the axis-aligned walls and a hard clamp so no ball ends a step outside. */
import { clamp, lerp, wrapAngle } from '../../core/math.js';
import { hex, loadStylesheet } from '../../core/ui.js';
import { createInput } from '../../core/input.js';
import { createTouch, isCoarse } from '../../core/touch.js';
import { createLoop } from '../../core/loop.js';
import { createTicker } from '../../core/ticker.js';
import { nowSec, pushSnap, sampleSnaps } from '../../core/interp.js';
import { AVATARS } from '../../core/avatars.js';

/* ============================================================ config */
const CFG = {
  W: 1040, H: 640,
  court: { left: 70, right: 970, top: 72, bottom: 568 },
  teamSize: 3,
  player: { r: 16, speed: 265, sprintMul: 1.6, accel: 2400, damp: 9,
            staminaDrain: 0.38, staminaRegen: 0.36, regenDelay: 0.4, sprintMin: 0.06 },
  ball: { r: 10, wallRest: 0.62, ballRest: 0.72, rollDecel: 170, damp: 0.32, liveMin: 300, count: 5 },
  throwSpeed: 1000, aiThrowSpeed: [880, 1000],
  armTime: 0.55,
  physHz: 240,
  drain: { start: 12, every: 9, keep: 2 },
  lineCountdownAt: 41, lineDownAt: 45, timeCap: 120,
  winScore: 2,
  intro: 1.6, banner: 2.6,
  netHz: 30, interp: 0.08,
};
const TEAMS = ['blue', 'red'];
const TEAM = { blue: { name: 'BLUE', code: 0, color: '#3d8bff', deep: '#1f4fa3', glow: 'rgba(61,139,255,', dir: 1 },
               red:  { name: 'RED',  code: 1, color: '#ff4d5a', deep: '#a8202c', glow: 'rgba(255,77,90,', dir: -1 } };
const AI_NAMES = { blue: ['AXEL', 'NOOR', 'KIRA'], red: ['RUBY', 'CASH', 'ORION'] };
const PHASES = ['intro', 'play', 'roundEnd'];
const PSTATES = ['GRAB', 'ARMING', 'READY'];
const BSTATES = ['idle', 'live', 'held', 'drain'];

/* ============================================================ utils */
const rand = (a = 1, b) => b === undefined ? Math.random() * a : a + Math.random() * (b - a);
const pick = arr => arr[Math.floor(Math.random() * arr.length)];
const hyp = (x, y) => Math.sqrt(x * x + y * y);
const easeOut = t => 1 - Math.pow(1 - t, 3);
const easeOutBack = t => { const c = 1.70158; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };
function gauss() { let u = 0, v = 0; while (u === 0) u = Math.random(); while (v === 0) v = Math.random(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
const fmtClock = t => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100;
const FONT = '"Avenir Next", "Segoe UI", system-ui, sans-serif';

/* ============================================================ sound - a small synth on the shell's shared AudioContext */
function createSfx(audio) {
  let noise = null, noiseCtx = null;
  const ctxOf = () => {
    const ctx = audio.ctx; if (!ctx || audio.muted) return null;
    if (noiseCtx !== ctx) { const len = ctx.sampleRate * 0.5, buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0); for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; noise = buf; noiseCtx = ctx; }
    return ctx;
  };
  const VOL = 0.7; // the shell's master gain is a little hotter than the original's
  const tone = (f0, f1, dur, type = 'sine', vol = 1, delay = 0) => {
    const ctx = ctxOf(); if (!ctx) return; const t = ctx.currentTime + delay;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol * VOL, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(audio.master); o.start(t); o.stop(t + dur + 0.02);
  };
  const hiss = (dur, vol = 0.5, f = 1800, q = 0.7, delay = 0) => {
    const ctx = ctxOf(); if (!ctx) return; const t = ctx.currentTime + delay;
    const s = ctx.createBufferSource(); s.buffer = noise;
    const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = f; bp.Q.value = q;
    const g = ctx.createGain(); g.gain.setValueAtTime(vol * VOL, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    s.connect(bp); bp.connect(g); g.connect(audio.master); s.start(t); s.stop(t + dur + 0.02);
  };
  return {
    throw() { hiss(0.22, 0.6, 2400, 0.9); tone(420, 180, 0.12, 'triangle', 0.25); },
    hit() { tone(160, 40, 0.28, 'square', 0.6); hiss(0.12, 0.7, 900, 0.5); },
    bounce(v) { const k = clamp(v / 900, 0.15, 1); tone(220 * k + 90, 60, 0.09, 'triangle', 0.3 * k); },
    pickup() { tone(520, 780, 0.08, 'sine', 0.3); },
    ready() { tone(660, 990, 0.1, 'sine', 0.3); tone(990, 1320, 0.12, 'sine', 0.22, 0.07); },
    tick(n) { tone(n <= 1 ? 1100 : 760, n <= 1 ? 1100 : 760, 0.09, 'square', 0.25); },
    lineDown() { tone(900, 120, 0.7, 'sawtooth', 0.35); hiss(0.6, 0.5, 500, 0.4); },
    whistle() { tone(2200, 2400, 0.35, 'sine', 0.35); tone(2200, 2300, 0.18, 'sine', 0.35, 0.42); },
    win() { [523, 659, 784, 1046].forEach((f, i) => tone(f, f, 0.22, 'triangle', 0.35, i * 0.11)); },
    drain() { tone(300, 90, 0.35, 'sine', 0.25); },
  };
}

/* ============================================================ entities */
class Ball {
  constructor(id, x, y) {
    this.id = id; this.x = x; this.y = y; this.vx = 0; this.vy = 0; this.r = CFG.ball.r;
    this.state = 'idle'; // idle | live | held | drain
    this.team = null; this.thrower = null; this.holder = null;
    this.trail = []; this.roll = rand(Math.PI * 2); this.idleT = 0; this.drainT = 0; this.scale = 1;
    this.claimedBy = null; this.liveT = 0; this.spawnT = 0; this.wobble = rand(Math.PI * 2);
    this.buf = []; // remote snapshots (clients only)
  }
  get speed() { return hyp(this.vx, this.vy); }
}

class Player {
  /* slot: { team, idx, pid, name, avatar } - pid null means a CPU body */
  constructor(slot) {
    this.team = slot.team; this.idx = slot.idx; this.pid = slot.pid; this.isHuman = slot.pid !== null; this.name = slot.name; this.avatar = slot.avatar;
    this.pi = 0; this.x = 0; this.y = 0; this.vx = 0; this.vy = 0; this.r = CFG.player.r;
    this.alive = true; this.stamina = 1; this.sprinting = false; this.regenT = 0;
    this.ball = null; this.state = 'GRAB'; this.armT = 0; this.readyT = 0; this.throwQueued = false; this.throwDir = null;
    this.face = this.team === 'blue' ? 0 : Math.PI;
    this.input = { x: 0, y: 0, sprint: false };  // what the simulation uses this frame
    this.want = { x: 0, y: 0, sprint: false };   // latest wish of the human driving this body (local keys or the network)
    this.knocked = null; this.bob = 0; this.moving = 0; this.dustT = 0; this.benchSlot = -1; this.stillT = 0;
    this.buf = []; // remote snapshots (clients only)
    this.brain = this.isHuman ? null : Player.newBrain();
  }
  static newBrain() {
    return { reaction: rand(0.10, 0.24), accuracy: rand(0.62, 0.86), aggression: rand(0.4, 1),
      throwDelay: rand(0.25, 0.9), thinkT: rand(0.1), target: null, ballTarget: null,
      dodgeUntil: -1, dodgeX: 0, dodgeY: 0, threatSeenAt: -1, threatBall: null,
      wanderA: rand(Math.PI * 2), wanderT: 0, goalX: 0, goalY: 0, sprintWish: false, rush: true,
      jitter: rand(0.5, 1.5), lastThrowAt: -9, settleUntil: -1, strafePhase: rand(Math.PI * 2) };
  }
  get active() { return this.alive && !this.knocked; }
}

/* Build the same roster on every machine: humans by side (sorted by id), then CPU fill. */
function buildRoster(session) {
  const opts = session.opts || {}, fill = opts.fillAI !== false;
  const humans = { blue: [], red: [] };
  const sorted = [...session.players].sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0));
  let alt = 1; // players without a side (solo, or an older server): me on blue, the rest alternate
  for (const p of sorted) {
    let team = TEAM[p.team] ? p.team : (p.id === session.myId ? 'blue' : TEAMS[alt++ % 2]);
    if (humans[team].length >= CFG.teamSize) team = team === 'blue' ? 'red' : 'blue';
    if (humans[team].length >= CFG.teamSize) continue;
    humans[team].push(p);
  }
  const roster = [];
  for (const team of TEAMS) {
    const slots = humans[team].map((h, idx) => ({ team, idx, pid: h.id, name: h.name, avatar: h.avatar }));
    const want = fill ? CFG.teamSize : Math.max(slots.length, 1);
    for (let i = slots.length; i < want; i++) slots.push({ team, idx: i, pid: null, name: AI_NAMES[team][i], avatar: -1 });
    roster.push(...slots);
  }
  return roster;
}

/* ============================================================ physics - hand-rolled circles, swept hits, exact wall reflect */
function sweepHit(px, py, qx, qy, cx, cy, R) {
  const dx = qx - px, dy = qy - py, fx = px - cx, fy = py - cy;
  const c = fx * fx + fy * fy - R * R;
  if (c <= 0) return 0;
  const a = dx * dx + dy * dy; if (a < 1e-9) return -1;
  const b = 2 * (fx * dx + fy * dy);
  const disc = b * b - 4 * a * c; if (disc < 0) return -1;
  const t = (-b - Math.sqrt(disc)) / (2 * a);
  return (t >= 0 && t <= 1) ? t : -1;
}

function physicsStep(g, dt) {
  const C = CFG.court, B = CFG.ball, P = CFG.player;
  const players = g.players, balls = g.balls;

  // ---- players: velocity toward desired, integrate, confine
  for (const p of players) {
    if (!p.alive && !p.knocked) continue;
    if (p.knocked) {
      const k = p.knocked; k.t += dt;
      p.x += k.vx * dt; p.y += k.vy * dt; k.vx *= (1 - 4 * dt); k.vy *= (1 - 4 * dt); k.spin += k.spinV * dt;
      p.x = clamp(p.x, C.left + p.r, C.right - p.r); p.y = clamp(p.y, C.top + p.r, C.bottom - p.r);
      continue;
    }
    let ix = p.input.x, iy = p.input.y; const il = hyp(ix, iy);
    if (il > 1) { ix /= il; iy /= il; }
    const wantSprint = p.input.sprint && il > 0.05;
    if (wantSprint && (p.sprinting ? p.stamina > 0 : p.stamina > P.sprintMin)) {
      p.sprinting = true; p.stamina = Math.max(0, p.stamina - P.staminaDrain * dt); p.regenT = P.regenDelay;
      if (p.stamina <= 0) p.sprinting = false;
    } else {
      p.sprinting = false; p.regenT -= dt;
      if (p.regenT <= 0) p.stamina = Math.min(1, p.stamina + P.staminaRegen * dt);
    }
    const max = P.speed * (p.sprinting ? P.sprintMul : 1);
    const tx = ix * max, ty = iy * max;
    const ax = tx - p.vx, ay = ty - p.vy, al = hyp(ax, ay), step = P.accel * dt;
    if (al <= step) { p.vx = tx; p.vy = ty; } else { p.vx += ax / al * step; p.vy += ay / al * step; }
    if (il < 0.05) { const f = Math.max(0, 1 - P.damp * dt); p.vx *= f; p.vy *= f; }
    p.x += p.vx * dt; p.y += p.vy * dt;
    const spd = hyp(p.vx, p.vy); p.moving = spd / P.speed; p.stillT = spd < 30 ? p.stillT + dt : 0;
    if (spd > 20) { p.face = Math.atan2(p.vy, p.vx); p.bob += dt * (p.sprinting ? 22 : 15); }
    // confine: own half while the line is up, whole court after
    const cx = (C.left + C.right) / 2, gap = p.r + 3;
    let minX = C.left + p.r, maxX = C.right - p.r;
    if (!g.lineDown) { if (p.team === 'blue') maxX = cx - gap; else minX = cx + gap; }
    if (p.x < minX) { p.x = minX; if (p.vx < 0) p.vx = 0; }
    if (p.x > maxX) { p.x = maxX; if (p.vx > 0) p.vx = 0; }
    if (p.y < C.top + p.r) { p.y = C.top + p.r; if (p.vy < 0) p.vy = 0; }
    if (p.y > C.bottom - p.r) { p.y = C.bottom - p.r; if (p.vy > 0) p.vy = 0; }
  }
  // player-player separation (soft)
  for (let i = 0; i < players.length; i++) for (let j = i + 1; j < players.length; j++) {
    const a = players[i], b = players[j]; if (!a.active || !b.active) continue;
    const dx = b.x - a.x, dy = b.y - a.y, d = hyp(dx, dy), min = a.r + b.r + 2;
    if (d < min && d > 1e-6) { const push = (min - d) * 0.5, nx = dx / d, ny = dy / d;
      a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push; }
  }

  // ---- balls
  for (const ball of balls) {
    if (ball.state === 'held' || ball.state === 'drain') continue;
    let s = hyp(ball.vx, ball.vy);
    if (s > 0) {
      let ns = Math.max(0, s - B.rollDecel * dt) * Math.max(0, 1 - B.damp * dt);
      if (ns < 4) ns = 0; const k = ns / s; ball.vx *= k; ball.vy *= k; s = ns;
    }
    ball.roll += s * dt / ball.r;
    if (ball.state === 'live') { ball.liveT += dt; if (s < B.liveMin) g.ballDies(ball, 'slow'); }
    if (ball.state === 'idle') ball.idleT += dt; else ball.idleT = 0;
    const px = ball.x, py = ball.y;
    ball.x += ball.vx * dt; ball.y += ball.vy * dt;

    // swept collision against players (earliest first)
    let best = null, bestT = 2;
    for (const p of players) {
      if (!p.active) continue;
      if (ball.state === 'live' && p === ball.thrower && ball.liveT < 0.2) continue;
      const t = sweepHit(px, py, ball.x, ball.y, p.x, p.y, p.r + ball.r);
      if (t >= 0 && t < bestT) { bestT = t; best = p; }
    }
    if (best) {
      const p = best;
      ball.x = px + (ball.x - px) * bestT; ball.y = py + (ball.y - py) * bestT;
      let nx = ball.x - p.x, ny = ball.y - p.y, nl = hyp(nx, ny);
      if (nl < 1e-6) { nx = Math.cos(p.face + Math.PI); ny = Math.sin(p.face + Math.PI); nl = 1; }
      nx /= nl; ny /= nl;
      if (ball.state === 'live' && p.team !== ball.team) {
        g.onHit(ball, p, nx, ny);
      } else if (ball.state === 'idle' && !p.ball && !p.knocked) {
        g.pickUp(p, ball);
        continue;
      } else {
        const vn = ball.vx * nx + ball.vy * ny;
        if (vn < 0) { ball.vx -= (1 + 0.5) * vn * nx; ball.vy -= (1 + 0.5) * vn * ny; }
        ball.vx += p.vx * 0.5; ball.vy += p.vy * 0.5;
        ball.x = p.x + nx * (p.r + ball.r + 0.5); ball.y = p.y + ny * (p.r + ball.r + 0.5);
        if (ball.state === 'live') g.ballDies(ball, 'body');
      }
    }
    if (ball.state === 'held') continue;

    // walls: exact reflection, then a hard clamp (never outside the court)
    let bounced = false, impact = 0;
    if (ball.x - ball.r < C.left) { ball.x = 2 * (C.left + ball.r) - ball.x; impact = Math.abs(ball.vx); ball.vx = -ball.vx * B.wallRest; bounced = true; }
    else if (ball.x + ball.r > C.right) { ball.x = 2 * (C.right - ball.r) - ball.x; impact = Math.abs(ball.vx); ball.vx = -ball.vx * B.wallRest; bounced = true; }
    if (ball.y - ball.r < C.top) { ball.y = 2 * (C.top + ball.r) - ball.y; impact = Math.max(impact, Math.abs(ball.vy)); ball.vy = -ball.vy * B.wallRest; bounced = true; }
    else if (ball.y + ball.r > C.bottom) { ball.y = 2 * (C.bottom - ball.r) - ball.y; impact = Math.max(impact, Math.abs(ball.vy)); ball.vy = -ball.vy * B.wallRest; bounced = true; }
    ball.x = clamp(ball.x, C.left + ball.r, C.right - ball.r); ball.y = clamp(ball.y, C.top + ball.r, C.bottom - ball.r);
    if (bounced) { g.onBounce(ball, impact); if (ball.state === 'live') g.ballDies(ball, 'wall'); }

    g.trailPoint(ball, s);
  }
  // ball-ball
  for (let i = 0; i < balls.length; i++) for (let j = i + 1; j < balls.length; j++) {
    const a = balls[i], b = balls[j];
    if (a.state === 'held' || b.state === 'held' || a.state === 'drain' || b.state === 'drain') continue;
    const dx = b.x - a.x, dy = b.y - a.y, d = hyp(dx, dy), min = a.r + b.r;
    if (d < min && d > 1e-6) {
      const nx = dx / d, ny = dy / d, push = (min - d) * 0.5;
      a.x -= nx * push; a.y -= ny * push; b.x += nx * push; b.y += ny * push;
      const rvx = b.vx - a.vx, rvy = b.vy - a.vy, vn = rvx * nx + rvy * ny;
      if (vn < 0) { const jI = -(1 + B.ballRest) * vn * 0.5; a.vx -= jI * nx; a.vy -= jI * ny; b.vx += jI * nx; b.vy += jI * ny; g.onBounce(a, Math.abs(vn) * 0.6); }
      a.x = clamp(a.x, C.left + a.r, C.right - a.r); a.y = clamp(a.y, C.top + a.r, C.bottom - a.r);
      b.x = clamp(b.x, C.left + b.r, C.right - b.r); b.y = clamp(b.y, C.top + b.r, C.bottom - b.r);
    }
  }
}

/* ============================================================ AI - every CPU body: grab, arm, throw, dodge */
function aiUpdate(p, g, dt) {
  const b = p.brain, C = CFG.court, cx = (C.left + C.right) / 2, t = g.time;
  const side = TEAM[p.team].dir, home = side > 0 ? C.left : C.right;
  const onMySide = x => side > 0 ? x < cx : x > cx;
  const enemies = [], mates = [];
  for (const e of g.players) { if (!e.active || e === p) continue; (e.team === p.team ? mates : enemies).push(e); }

  // ---- 1. threat scan: any live enemy ball on a course that passes near me
  let threat = null, threatT = 9, tdx = 0, tdy = 0;
  for (const ball of g.balls) {
    if (ball.state !== 'live' || ball.team === p.team) continue;
    const rx = p.x - ball.x, ry = p.y - ball.y, vx = ball.vx, vy = ball.vy, v2 = vx * vx + vy * vy;
    if (v2 < 1) continue;
    const tc = (rx * vx + ry * vy) / v2;
    if (tc < -0.02 || tc > 1.1) continue;
    const ox = p.x - (ball.x + vx * tc), oy = p.y - (ball.y + vy * tc), d = hyp(ox, oy);
    if (d < p.r + ball.r + 44 && tc < threatT) {
      threat = ball; threatT = tc;
      if (d > 2) { tdx = ox / d; tdy = oy / d; }
      else { const vl = Math.sqrt(v2); tdx = -vy / vl; tdy = vx / vl; if (Math.random() < 0.5) { tdx = -tdx; tdy = -tdy; } }
    }
  }
  if (threat) {
    if (b.threatBall !== threat) { b.threatBall = threat; b.threatSeenAt = t + (Math.random() < 0.25 ? rand(0.1, 0.2) : 0); }
    if (t - b.threatSeenAt >= b.reaction && t > b.dodgeUntil) {
      const ex = p.x + tdx * 70, ey = p.y + tdy * 70;
      if (ex < C.left + p.r + 6 || ex > C.right - p.r - 6 || ey < C.top + p.r + 6 || ey > C.bottom - p.r - 6) { tdx = -tdx; tdy = -tdy; }
      b.dodgeX = tdx; b.dodgeY = tdy; b.dodgeUntil = t + threatT + 0.12;
    }
  } else b.threatBall = null;

  // ---- 2. periodic thinking: pick targets and a goal position
  b.thinkT -= dt;
  if (b.thinkT <= 0) {
    b.thinkT = rand(0.07, 0.15);
    b.sprintWish = false;
    if (p.ball) {
      let best = null, bs = 1e9;
      for (const e of enemies) {
        const s = hyp(e.x - p.x, e.y - p.y) + (e.ball ? 50 : 0) + hyp(e.vx, e.vy) * 0.12 + (e === b.target ? -60 : 0);
        if (s < bs) { bs = s; best = e; }
      }
      b.target = best;
      if (best) {
        if (!g.lineDown) {
          const depth = lerp(250, 130, b.aggression);
          b.goalX = cx - side * (depth + Math.sin(t * b.jitter + p.idx) * 25);
          b.goalY = clamp(best.y + Math.sin(t * 0.9 * b.jitter + p.idx * 2) * 60, C.top + 40, C.bottom - 40);
          b.sprintWish = Math.abs(p.x - cx) < 150 && p.stamina > 0.45;
        } else {
          const dx = best.x - p.x, dy = best.y - p.y, d = Math.max(1, hyp(dx, dy)), keep = lerp(230, 150, b.aggression);
          b.goalX = best.x - dx / d * keep; b.goalY = best.y - dy / d * keep;
          b.sprintWish = d > 320 && b.aggression > 0.5;
        }
      }
    } else {
      let best = null, bs = 1e9;
      for (const ball of g.balls) {
        if (ball.state !== 'idle') continue;
        const onLine = Math.abs(ball.x - cx) <= ball.r + 1;
        if (!g.lineDown && !onMySide(ball.x) && !onLine) continue;
        let s = hyp(ball.x - p.x, ball.y - p.y);
        if (ball.claimedBy && ball.claimedBy !== p && ball.claimedBy.active && !ball.claimedBy.ball && ball.claimedBy.team === p.team) s += 260;
        if (g.lineDown) for (const e of enemies) if (hyp(ball.x - e.x, ball.y - e.y) + 60 < hyp(ball.x - p.x, ball.y - p.y)) { s += 180; break; }
        if (ball === b.ballTarget) s -= 40;
        if (s < bs) { bs = s; best = ball; }
      }
      b.ballTarget = best;
      if (best) {
        best.claimedBy = p;
        b.goalX = best.x; b.goalY = best.y;
        const d = hyp(best.x - p.x, best.y - p.y);
        b.sprintWish = (b.rush && p.stamina > 0.35) || (d > 150 && p.stamina > 0.5) || (g.lineDown && p.stamina > 0.3);
      } else {
        const armed = enemies.filter(e => e.ball);
        const cands = [];
        const lo = g.lineDown ? C.left : (side > 0 ? C.left : cx), hi = g.lineDown ? C.right : (side > 0 ? cx : C.right);
        for (let i = 0; i < 7; i++) cands.push({ x: rand(lo + 50, hi - 50), y: rand(C.top + 50, C.bottom - 50) });
        cands.push({ x: home + side * rand(50, 120), y: p.y + rand(-160, 160) });
        let bc = null, bv = -1e9;
        for (const c of cands) {
          let minD = 1e9; for (const e of armed) minD = Math.min(minD, hyp(c.x - e.x, c.y - e.y));
          if (!armed.length) minD = 300;
          const v = Math.min(minD, 420) - hyp(c.x - p.x, c.y - p.y) * 0.35;
          if (v > bv) { bv = v; bc = c; }
        }
        b.goalX = clamp(bc.x, lo + 30, hi - 30); b.goalY = clamp(bc.y, C.top + 30, C.bottom - 30);
        b.sprintWish = armed.length > 0 && p.stamina > 0.6;
      }
    }
    if (b.rush && (p.ball || t > 3.5)) b.rush = false;
  }

  // ---- 3. steering toward goal, spacing from teammates, dodge override
  let ix = 0, iy = 0;
  const gx = b.goalX - p.x, gy = b.goalY - p.y, gd = hyp(gx, gy);
  if (gd > 10) { ix = gx / gd; iy = gy / gd; if (gd < 40) { ix *= gd / 40; iy *= gd / 40; } }
  for (const m of mates) { const dx = p.x - m.x, dy = p.y - m.y, d = hyp(dx, dy); if (d < 56 && d > 0.1) { ix += dx / d * 0.7; iy += dy / d * 0.7; } }
  if (p.ball && p.state === 'READY' && !g.lineDown) { ix += Math.cos(t * 2.1 + p.idx) * 0.25; iy += Math.sin(t * 1.7 + p.idx * 3) * 0.35; }
  let menace = null, md = 500;
  for (const e of enemies) if (e.ball && e.state === 'READY') { const d = hyp(e.x - p.x, e.y - p.y); if (d < md) { md = d; menace = e; } }
  if (menace) { const dx = menace.x - p.x, dy = menace.y - p.y, d = Math.max(1, hyp(dx, dy)); const s = Math.sin(t * 2.6 + b.strafePhase) * (0.9 - 0.4 * (1 - md / 500));
    ix += -dy / d * s; iy += dx / d * s; }
  let sprint = b.sprintWish;
  if (t < b.dodgeUntil) { ix = b.dodgeX; iy = b.dodgeY; sprint = p.stamina > 0.12; }
  const il = hyp(ix, iy); if (il > 1) { ix /= il; iy /= il; }
  p.input.x = ix; p.input.y = iy; p.input.sprint = sprint;

  // ---- 4. throwing
  if (p.ball && b.target && b.target.active) {
    const e = b.target; p.face = Math.atan2(e.y - p.y, e.x - p.x);
    if (p.state === 'READY') {
      const d = hyp(e.x - p.x, e.y - p.y), range = g.lineDown ? 260 : 390;
      const still = e.stillT > 0.6, exposed = !g.lineDown && Math.abs(p.x - cx) < 130;
      const settled = t >= b.settleUntil && !exposed && (d > 170 || p.readyT > 0.7 || g.lineDown);
      const late = g.time > CFG.lineDownAt + 20 && p.readyT > 0.4;
      if (((d < range && p.readyT > b.throwDelay) || (still && d < 360 && p.readyT > 0.25)) && settled || p.readyT > 2.4 || late) {
        const aim = aiAim(p, e); g.throwBall(p, aim.x, aim.y, aim.speed);
        b.throwDelay = rand(0.2, 0.9); b.lastThrowAt = t;
      }
    }
  }
}

function aiAim(p, e) {
  const acc = p.brain.accuracy, speed = lerp(CFG.aiThrowSpeed[0], CFG.aiThrowSpeed[1], acc);
  const d = hyp(e.x - p.x, e.y - p.y), tf = d / speed, lead = lerp(0.35, 0.95, acc) * rand(0.7, 1.2);
  let ax = e.x + e.vx * tf * lead, ay = e.y + e.vy * tf * lead;
  const dx = ax - p.x, dy = ay - p.y, dl = Math.max(1, hyp(dx, dy)), px = -dy / dl, py = dx / dl;
  const err = gauss() * (1 - acc) * 95;
  ax += px * err; ay += py * err;
  return { x: ax, y: ay, speed };
}

/* ============================================================ game - rounds, rules, events, effects
   The host runs update(); everyone else runs applySnapshot() + updateClient(). Anything visible or audible
   goes through emit() -> applyEvent(), so both paths produce the same effects. */
class Game {
  constructor(roster, { opts, sfx, isHost, online, myId }) {
    this.sfx = sfx; this.isHost = isHost; this.online = online; this.myId = myId;
    this.winScore = Number(opts && opts.winScore) || CFG.winScore;
    this.players = roster.map((slot, i) => { const p = new Player(slot); p.pi = i; return p; });
    this.me = this.players.find(p => p.pid === myId) || null;
    this.count = { blue: this.players.filter(p => p.team === 'blue').length, red: this.players.filter(p => p.team === 'red').length };
    this.balls = []; this.ballById = new Map(); this.particles = []; this.floats = []; this.time = 0;
    this.banner = null; this.subBanner = null; this.shake = 0; this.flash = 0; this.excite = { blue: 0, red: 0 };
    this.lastBounceSfx = -1; this.countBump = 0; this.bench = { blue: [], red: [] };
    this.stats = { hits: 0, throws: 0 }; this.events = []; this.seq = 0; this.lastSeq = -1;
    this.score = { blue: 0, red: 0 }; this.round = 0; this.matchWinner = null; this.roundWinner = null;
    this.phase = 'intro'; this.phaseT = 0; this.lineDown = false; this.lineCount = null;
    this.aim = null; // a touch player's drag on THROW (unit vector), drawn as an arrow from their body
    if (this.isHost) this.startRound(); else { this.round = 1; this.resetRound(); }
  }

  /* ---------- round setup (deterministic: every machine lays the court out the same way) */
  startRound() { this.round++; this.resetRound(); this.emit('rstart', this.round, this.score.blue, this.score.red); }
  resetRound() {
    const C = CFG.court, cx = (C.left + C.right) / 2;
    this.time = 0; this.phase = 'intro'; this.phaseT = 0; this.lineDown = false; this.lineCount = null;
    this.drainNextAt = CFG.drain.start; this.roundWinner = null; this.bench = { blue: [], red: [] }; this.lastCountdownN = null;
    this.balls = []; this.ballById.clear();
    for (let i = 0; i < CFG.ball.count; i++) {
      const y = C.top + (C.bottom - C.top) * (i + 1) / (CFG.ball.count + 1);
      const b = new Ball(this.round * 100 + i, cx, y); b.spawnT = i * 0.05; this.balls.push(b); this.ballById.set(b.id, b);
    }
    for (const p of this.players) {
      const side = TEAM[p.team].dir, home = side > 0 ? C.left : C.right;
      p.x = home + side * 46; p.y = C.top + (C.bottom - C.top) * (p.idx + 1) / (this.count[p.team] + 1);
      p.vx = p.vy = 0; p.alive = true; p.knocked = null; p.ball = null; p.state = 'GRAB'; p.armT = 0; p.readyT = 0;
      p.stamina = 1; p.sprinting = false; p.throwQueued = false; p.throwDir = null; p.face = side > 0 ? 0 : Math.PI; p.benchSlot = -1; p.stillT = 0; p.buf = [];
      p.input = { x: 0, y: 0, sprint: false };
      if (p.brain) Object.assign(p.brain, { target: null, ballTarget: null, dodgeUntil: -1, threatBall: null, rush: true, thinkT: rand(0.05, 0.2), goalX: p.x, goalY: p.y, sprintWish: false });
    }
  }
  aliveCount(team) { let n = 0; for (const p of this.players) if (p.team === team && p.alive) n++; return n; }
  ballsInPlay() { let n = 0; for (const b of this.balls) if (b.state !== 'drain') n++; return n; }
  playerOf(pid) { return this.players.find(p => p.pid === pid) || null; }
  /* a human dropped out: their body plays on as a CPU */
  toAI(p) { if (!p.isHuman) return; p.isHuman = false; p.pid = null; p.avatar = -1; p.name = AI_NAMES[p.team][p.idx] || p.name; p.brain = Player.newBrain(); Object.assign(p.brain, { goalX: p.x, goalY: p.y, rush: false }); p.throwQueued = false; p.throwDir = null; if (p === this.me) this.me = null; }

  /* ---------- visual helpers */
  showBanner(text, color, dur, opts = {}) { this.banner = { text, color, t: 0, dur, sub: opts.sub || null, size: opts.size || 64 }; }
  addFloat(x, y, text, color, size = 18, life = 1.1) { this.floats.push({ x, y, text, color, size, life, max: life }); }
  burst(x, y, n, color, speed, life = 0.6, size = 3, type = 'dot', grav = 0) {
    for (let i = 0; i < n; i++) { const a = rand(Math.PI * 2), s = rand(0.3, 1) * speed;
      this.particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: life * rand(0.6, 1.2), max: life, size: size * rand(0.6, 1.4), color, type, rot: a, rotV: rand(-8, 8), grav }); }
  }
  ring(x, y, color, size = 40, life = 0.45) { this.particles.push({ x, y, vx: 0, vy: 0, life, max: life, size, color, type: 'ring' }); }
  trailPoint(ball, speed) {
    if (ball.state === 'live' || speed > 240) { ball.trail.push({ x: ball.x, y: ball.y, t: this.time, live: ball.state === 'live', team: ball.team }); if (ball.trail.length > 48) ball.trail.shift(); }
  }

  /* ---------- events: the host emits, everyone applies */
  emit(...ev) { this.applyEvent(ev); if (this.online && this.isHost) this.events.push(ev); }
  applyEvent(ev) {
    const sfx = this.sfx;
    switch (ev[0]) {
      case 'rstart': { const [, round, sb, sr] = ev; this.round = round; this.score.blue = sb; this.score.red = sr; this.bench = { blue: [], red: [] }; this.subBanner = null;
        for (const b of this.balls) b.trail = [];
        this.showBanner(`ROUND ${round}`, '#ffffff', CFG.intro, { sub: round === 1 ? `first to ${this.winScore} · balls on the line · GO on the whistle` : `${sb}–${sr} · balls back on the line` }); break; }
      case 'go': this.showBanner('GO!', '#47e07a', 0.7, { size: 80 }); sfx.whistle(); break;
      case 'pick': { const p = this.players[ev[1]]; if (!p) break; this.ring(p.x, p.y, TEAM[p.team].color, 26, 0.35); if (p === this.me || Math.random() < 0.5) sfx.pickup(); break; }
      case 'ready': { const p = this.players[ev[1]]; if (p && p === this.me) { sfx.ready(); this.ring(p.x, p.y, '#47e07a', 30, 0.4); } break; }
      case 'throw': { const [, x, y, tc] = ev; this.burst(x, y, 6, TEAM[TEAMS[tc]].color, 120, 0.3, 2); sfx.throw(); break; }
      case 'hit': {
        const [, pi, tc, x, y, ti] = ev; const p = this.players[pi]; if (!p) break; const team = TEAMS[tc], tcol = TEAM[team].color, thrower = this.players[ti] || null;
        this.burst(x, y, 26, tcol, 320, 0.7, 3, 'spark'); this.burst(x, y, 14, '#ffffff', 180, 0.5, 2.5);
        this.ring(x, y, tcol, 70, 0.5); this.ring(x, y, '#ffffff', 40, 0.35);
        this.addFloat(x, y - 30, 'OUT!', '#ffffff', 26, 1.3);
        this.shake = Math.min(1, this.shake + 0.7); this.flash = 0.35; this.countBump = 0.3;
        this.excite[team] = 1.4; this.excite[p.team] = 0.5;
        sfx.hit();
        if (p === this.me) this.addFloat(x, y + 30, `${thrower ? thrower.name : TEAM[team].name} got you`, tcol, 14, 1.6);
        else if (thrower && thrower === this.me) this.addFloat(x, y + 30, 'nice shot!', '#47e07a', 14, 1.4);
        break;
      }
      case 'bounce': { const [, x, y, impact] = ev;
        this.burst(x, y, Math.min(8, 2 + impact / 150), 'rgba(255,255,255,0.7)', 60 + impact * 0.15, 0.3, 1.8);
        if (this.time - this.lastBounceSfx > 0.05) { this.lastBounceSfx = this.time; sfx.bounce(impact); } break; }
      case 'drain': { const [, x, y] = ev; this.addFloat(x, y - 18, 'OUT OF PLAY', '#ffd23f', 12, 1.4); sfx.drain(); break; }
      case 'tick': { const n = ev[1]; this.lineCount = n; sfx.tick(n); this.subBanner = { text: `Center line drops in ${n}…`, t: 0 }; break; }
      case 'line': {
        const C = CFG.court, cx = (C.left + C.right) / 2; this.lineDown = true; this.lineCount = null;
        for (let y = C.top + 6; y < C.bottom - 6; y += 22) this.particles.push({ x: cx, y: y + 7, vx: rand(-90, 90), vy: rand(-40, 40), life: rand(0.8, 1.5), max: 1.5, size: 14, color: '#ffffff', type: 'dash', rot: Math.PI / 2, rotV: rand(-6, 6), grav: 60 });
        this.burst(cx, (C.top + C.bottom) / 2, 40, '#ffffff', 260, 0.9, 2, 'spark');
        this.showBanner('THE LINE IS DOWN', '#ff4d5a', 2.2, { sub: 'either team can cross now' });
        this.subBanner = null; this.shake = Math.min(1, this.shake + 0.5); this.excite.blue = this.excite.red = 1.2;
        sfx.lineDown(); break;
      }
      case 'time': this.showBanner('TIME!', '#ffd23f', 1); break;
      case 'round': {
        const [, wc, over, sb, sr] = ev; const winner = TEAMS[wc], T = TEAM[winner], col = T.color;
        this.score.blue = sb; this.score.red = sr; this.roundWinner = winner; this.excite[winner] = 2; this.subBanner = null;
        if (over) { this.matchWinner = winner; this.showBanner(`${T.name} WINS THE MATCH`, col, 1e9, { sub: `${sb} – ${sr}`, size: 58 }); }
        else this.showBanner(`${T.name} takes the round!`, col, CFG.banner, { sub: `${sb} – ${sr}  ·  first to ${this.winScore}` });
        sfx.win();
        for (const p of this.players) if (p.alive && p.team === winner) this.burst(p.x, p.y, 16, col, 200, 0.9, 3, 'spark');
        break;
      }
    }
  }

  /* ---------- rule events called from the physics (host only) */
  pickUp(p, ball) {
    ball.state = 'held'; ball.holder = p; ball.vx = ball.vy = 0; ball.trail = []; ball.claimedBy = null; ball.team = null; ball.thrower = null;
    p.ball = ball; p.state = 'ARMING'; p.armT = 0; p.readyT = 0; p.throwQueued = false;
    if (p.brain) { const nearLine = Math.abs(p.x - (CFG.court.left + CFG.court.right) / 2) < 110; p.brain.settleUntil = this.time + (nearLine && !this.lineDown ? rand(0.5, 1.3) : rand(0.1, 0.4)); }
    this.emit('pick', p.pi);
  }
  throwBall(p, ax, ay, speed) {
    const ball = p.ball; if (!ball) return;
    speed = speed || CFG.throwSpeed;
    let dx = ax - p.x, dy = ay - p.y, dl = hyp(dx, dy); if (dl < 1) { dx = Math.cos(p.face); dy = Math.sin(p.face); dl = 1; }
    dx /= dl; dy /= dl;
    const C = CFG.court;
    ball.x = clamp(p.x + dx * (p.r + ball.r + 2), C.left + ball.r, C.right - ball.r);
    ball.y = clamp(p.y + dy * (p.r + ball.r + 2), C.top + ball.r, C.bottom - ball.r);
    ball.vx = dx * speed; ball.vy = dy * speed; ball.state = 'live'; ball.team = p.team; ball.thrower = p; ball.holder = null; ball.liveT = 0; ball.trail = [];
    p.ball = null; p.state = 'GRAB'; p.armT = 0; p.readyT = 0; p.throwQueued = false; p.throwDir = null; p.face = Math.atan2(dy, dx);
    p.vx += -dx * 40; p.vy += -dy * 40;
    this.stats.throws++;
    this.emit('throw', r1(ball.x), r1(ball.y), TEAM[p.team].code);
  }
  nearestEnemy(p) { let best = null, bd = 1e9; for (const e of this.players) if (e.team !== p.team && e.active) { const d = hyp(e.x - p.x, e.y - p.y); if (d < bd) { bd = d; best = e; } } return best ? { e: best, d: bd } : null; }
  /* a human pressed throw: fires at once when armed, otherwise as soon as the arm is ready. `dir` is a unit vector to throw
     along (a touch player who dragged THROW to aim); without one the throw leads the nearest enemy. */
  requestThrow(p, dir = null) {
    if (!p || !p.active || !p.ball || this.phase !== 'play') return;
    if (p.state !== 'READY') { p.throwQueued = true; p.throwDir = dir; return; }
    if (dir) { this.throwBall(p, p.x + dir.x * 100, p.y + dir.y * 100, CFG.throwSpeed); return; }
    const n = this.nearestEnemy(p); if (!n) return;
    const tf = n.d / CFG.throwSpeed;
    this.throwBall(p, n.e.x + n.e.vx * tf * 0.6, n.e.y + n.e.vy * tf * 0.6, CFG.throwSpeed);
  }
  onHit(ball, p, nx, ny) {
    const thrower = ball.thrower, team = ball.team; // ballDies() clears both, so remember them for the event
    p.alive = false; p.knocked = { t: 0, vx: ball.vx * 0.22, vy: ball.vy * 0.22, spin: 0, spinV: (Math.random() < 0.5 ? -1 : 1) * rand(9, 14) };
    if (p.ball) { const b = p.ball; b.state = 'idle'; b.holder = null; b.x = p.x - nx * 4; b.y = p.y - ny * 4; b.vx = ball.vx * 0.15 + rand(-60, 60); b.vy = ball.vy * 0.15 + rand(-60, 60); p.ball = null; p.state = 'GRAB'; }
    const vn = ball.vx * nx + ball.vy * ny;
    ball.vx = (ball.vx - 1.35 * vn * nx) * 0.35 + p.vx * 0.4; ball.vy = (ball.vy - 1.35 * vn * ny) * 0.35 + p.vy * 0.4;
    ball.x = p.x + nx * (p.r + ball.r + 1); ball.y = p.y + ny * (p.r + ball.r + 1);
    this.ballDies(ball, 'hit');
    this.stats.hits++;
    this.emit('hit', p.pi, TEAM[team].code, r1(p.x), r1(p.y), thrower ? thrower.pi : -1);
  }
  ballDies(ball) { if (ball.state !== 'live') return; ball.state = 'idle'; ball.team = null; ball.thrower = null; }
  onBounce(ball, impact) { if (impact < 100) return; this.emit('bounce', r1(ball.x), r1(ball.y), Math.round(impact)); }
  drainBall(ball) { ball.state = 'drain'; ball.drainT = 0; ball.claimedBy = null; this.emit('drain', r1(ball.x), r1(ball.y)); }
  dropLine() { this.emit('line'); }
  endRound(winner) {
    this.phase = 'roundEnd'; this.phaseT = 0; this.score[winner]++;
    const over = this.score[winner] >= this.winScore;
    this.emit('round', TEAM[winner].code, over ? 1 : 0, this.score.blue, this.score.red);
  }

  /* ---------- host simulation */
  update(dt) {
    this.phaseT += dt;
    const playing = this.phase === 'play';
    if (this.phase === 'intro' && this.phaseT >= CFG.intro) { this.phase = 'play'; this.phaseT = 0; this.emit('go'); }
    if (this.phase === 'roundEnd' && !this.matchWinner && this.phaseT >= CFG.banner) this.startRound(); // a won match waits for the host to restart
    if (playing) this.time += dt;

    // inputs: humans from their latest wish, CPUs from their brain
    for (const p of this.players) {
      if (!p.active || !playing) { p.input.x = p.input.y = 0; p.input.sprint = false; if (p.brain && !playing) p.brain.rush = true; continue; }
      if (p.brain) aiUpdate(p, this, dt);
      else { p.input.x = p.want.x; p.input.y = p.want.y; p.input.sprint = p.want.sprint; }
      if (p.ball) {
        if (p.state === 'ARMING') { p.armT += dt; if (p.armT >= CFG.armTime) { p.state = 'READY'; p.readyT = 0; this.emit('ready', p.pi); } }
        else if (p.state === 'READY') { p.readyT += dt; if (p.isHuman && p.throwQueued) this.requestThrow(p, p.throwDir); }
      }
      // an armed human standing still squares up to the nearest enemy
      if (p.isHuman && p.ball && p.state === 'READY' && hyp(p.vx, p.vy) < 30) { const n = this.nearestEnemy(p); if (n) p.face = Math.atan2(n.e.y - p.y, n.e.x - p.x); }
    }

    // physics substeps
    if (this.phase !== 'intro') {
      const h = 1 / CFG.physHz; let n = Math.max(1, Math.round(dt / h)); n = Math.min(n, 12); const sdt = dt / n;
      for (let i = 0; i < n; i++) physicsStep(this, sdt);
    }
    this.followHolders(dt);
    for (const p of this.players) if (p.knocked && p.knocked.t > 0.85) { p.knocked = null; p.benchSlot = this.bench[p.team].length; this.bench[p.team].push(p); }

    if (playing) {
      // balls slowly leave play
      if (this.time >= this.drainNextAt) {
        if (this.ballsInPlay() > CFG.drain.keep) {
          let pickB = null, bi = -1; for (const b of this.balls) if (b.state === 'idle' && b.idleT > bi) { bi = b.idleT; pickB = b; }
          if (pickB) { this.drainBall(pickB); this.drainNextAt = this.time + CFG.drain.every; } else this.drainNextAt = this.time + 2;
        } else this.drainNextAt = this.time + 5;
      }
      // center line countdown + drop
      if (!this.lineDown) {
        if (this.time >= CFG.lineDownAt) this.dropLine();
        else if (this.time >= CFG.lineCountdownAt) { const n = Math.ceil(CFG.lineDownAt - this.time); if (n !== this.lastCountdownN) { this.lastCountdownN = n; this.emit('tick', n); } }
      }
      // round resolution
      const ab = this.aliveCount('blue'), ar = this.aliveCount('red');
      if (ab === 0 || ar === 0) this.endRound(ab === ar ? pick(TEAMS) : (ab > 0 ? 'blue' : 'red'));
      else if (this.time >= CFG.timeCap) { this.emit('time'); this.endRound(ab === ar ? pick(TEAMS) : (ab > ar ? 'blue' : 'red')); }
    }

    for (const b of this.balls) if (b.state === 'drain') { b.drainT += dt; b.scale = Math.max(0, 1 - b.drainT / 0.7); }
    const gone = this.balls.filter(b => b.state === 'drain' && b.drainT > 0.75); for (const b of gone) this.ballById.delete(b.id);
    if (gone.length) this.balls = this.balls.filter(b => !gone.includes(b));
    this.updateFx(dt);
  }
  followHolders(dt) {
    for (const b of this.balls) if (b.state === 'held' && b.holder) { const p = b.holder; const a = p.face + 0.75 * (p.team === 'blue' ? -1 : 1); b.x = p.x + Math.cos(a) * (p.r + 4); b.y = p.y + Math.sin(a) * (p.r + 4); b.roll += dt * 2; }
  }
  /* cosmetic state shared by host and clients */
  updateFx(dt) {
    for (const b of this.balls) while (b.trail.length && this.time - b.trail[0].t > 0.45) b.trail.shift();
    for (const q of this.particles) { q.life -= dt; q.x += q.vx * dt; q.y += q.vy * dt; q.vx *= (1 - 3 * dt); q.vy *= (1 - 3 * dt); if (q.grav) q.vy += q.grav * dt; if (q.rotV) q.rot += q.rotV * dt; }
    this.particles = this.particles.filter(q => q.life > 0);
    for (const f of this.floats) { f.life -= dt; f.y -= 28 * dt; }
    this.floats = this.floats.filter(f => f.life > 0);
    if (this.banner) { this.banner.t += dt; if (this.banner.t > this.banner.dur) this.banner = null; }
    if (this.subBanner) this.subBanner.t += dt;
    this.shake = Math.max(0, this.shake - dt * 2.4); this.flash = Math.max(0, this.flash - dt * 2); this.countBump = Math.max(0, this.countBump - dt);
    this.excite.blue = Math.max(0, this.excite.blue - dt * 0.6); this.excite.red = Math.max(0, this.excite.red - dt * 0.6);
  }

  /* ---------- networking: host packs, clients apply + interpolate */
  packSnapshot() {
    const msg = {
      t: 's', q: ++this.seq, ph: PHASES.indexOf(this.phase), pt: r2(this.phaseT), tm: r2(this.time), rd: this.round, sb: this.score.blue, sr: this.score.red,
      ld: this.lineDown ? 1 : 0, lc: this.lineCount === null ? -1 : this.lineCount, rw: this.roundWinner ? TEAM[this.roundWinner].code : -1, mw: this.matchWinner ? TEAM[this.matchWinner].code : -1,
      p: this.players.map(p => [r1(p.x), r1(p.y), r1(p.vx), r1(p.vy), r2(p.face), p.alive ? 1 : 0, p.knocked ? r2(p.knocked.t) : -1, p.knocked ? r2(p.knocked.spin) : 0,
        PSTATES.indexOf(p.state), r2(p.armT), r2(p.stamina), p.sprinting ? 1 : 0, p.ball ? p.ball.id : -1, p.isHuman ? 1 : 0]),
      b: this.balls.map(b => [b.id, r1(b.x), r1(b.y), r1(b.vx), r1(b.vy), BSTATES.indexOf(b.state), b.team ? TEAM[b.team].code : -1, b.holder ? b.holder.pi : -1, r2(b.scale)]),
      ev: this.events,
    };
    this.events = [];
    return msg;
  }
  applySnapshot(m) {
    if (typeof m.q !== 'number' || m.q <= this.lastSeq) return; this.lastSeq = m.q;
    const now = nowSec();
    this.phase = PHASES[m.ph] || 'intro'; this.phaseT = m.pt; this.time = m.tm; this.round = m.rd; this.score.blue = m.sb; this.score.red = m.sr;
    this.lineDown = !!m.ld; this.lineCount = m.lc >= 0 ? m.lc : null; this.roundWinner = m.rw >= 0 ? TEAMS[m.rw] : null; this.matchWinner = m.mw >= 0 ? TEAMS[m.mw] : null;
    // balls first so the holders below can resolve their ball
    const seen = new Set();
    for (const e of m.b || []) {
      const [id, x, y, vx, vy, st, tc, hi, sc] = e; seen.add(id);
      let b = this.ballById.get(id); if (!b) { b = new Ball(id, x, y); this.ballById.set(id, b); this.balls.push(b); }
      pushSnap(b.buf, { x, y, vx, vy }, now); b.vx = vx; b.vy = vy;
      const state = BSTATES[st] || 'idle'; if (state !== 'idle') b.idleT = 0; if (state !== b.state && state === 'live') b.trail = [];
      b.state = state; b.team = tc >= 0 ? TEAMS[tc] : null; b.holder = hi >= 0 ? this.players[hi] || null : null; b.scale = sc;
    }
    if (seen.size !== this.balls.length) { this.balls = this.balls.filter(b => seen.has(b.id)); for (const id of [...this.ballById.keys()]) if (!seen.has(id)) this.ballById.delete(id); }
    (m.p || []).forEach((e, i) => {
      const p = this.players[i]; if (!p) return;
      const [x, y, vx, vy, f, al, kt, ks, st, at, sta, sp, bid, hu] = e;
      pushSnap(p.buf, { x, y, vx, vy, f }, now);
      p.alive = !!al; p.state = PSTATES[st] || 'GRAB'; p.armT = at; p.stamina = sta; p.sprinting = !!sp; p.ball = bid >= 0 ? this.ballById.get(bid) || null : null;
      if (kt >= 0) { if (!p.knocked) p.knocked = { t: kt, vx: 0, vy: 0, spin: ks, spinV: 0 }; else { p.knocked.t = kt; p.knocked.spin = ks; } } else p.knocked = null;
      if (p.isHuman && !hu) this.toAI(p);
      if (!p.alive && !p.knocked && !this.bench[p.team].includes(p)) { p.benchSlot = this.bench[p.team].length; this.bench[p.team].push(p); }
    });
    for (const ev of m.ev || []) this.applyEvent(ev);
  }
  updateClient(dt) {
    this.phaseT += dt; if (this.phase === 'play') this.time += dt;
    const rt = nowSec() - CFG.interp;
    for (const p of this.players) {
      const s = sampleSnaps(p.buf, rt); if (!s) continue; const { a, b, f } = s;
      if (b) { p.x = lerp(a.x, b.x, f); p.y = lerp(a.y, b.y, f); p.face = a.f + wrapAngle(b.f - a.f) * f; }
      else { const ex = clamp(rt - a.t, 0, 0.2); p.x = a.x + a.vx * ex; p.y = a.y + a.vy * ex; p.face = a.f; }
      p.vx = a.vx; p.vy = a.vy; const spd = hyp(p.vx, p.vy); p.moving = spd / CFG.player.speed; if (spd > 20) p.bob += dt * (p.sprinting ? 22 : 15);
      if (p.knocked) p.knocked.t += dt;
    }
    for (const b of this.balls) {
      if (b.state === 'held') continue;
      const s = sampleSnaps(b.buf, rt);
      if (s) { const { a, b: nb, f } = s; if (nb) { b.x = lerp(a.x, nb.x, f); b.y = lerp(a.y, nb.y, f); } else { const ex = clamp(rt - a.t, 0, 0.2); b.x = a.x + a.vx * ex; b.y = a.y + a.vy * ex; } }
      const spd = hyp(b.vx, b.vy); b.roll += spd * dt / b.r; if (b.state === 'idle') b.idleT += dt;
      this.trailPoint(b, spd);
    }
    this.followHolders(dt);
    this.updateFx(dt);
  }

  /* ---------- status bar text */
  status(canRestart, touch) {
    const me = this.me, sc = `${this.score.blue}–${this.score.red}`;
    if (this.matchWinner) return { cls: 'info', text: `${TEAM[this.matchWinner].name} wins the match ${sc}`, hint: canRestart ? (touch ? 'play again or leave from the ☰ menu' : 'R to play again · Esc to leave') : 'waiting for the host to play again' };
    if (this.phase === 'roundEnd') return { cls: 'info', text: this.roundWinner ? `${TEAM[this.roundWinner].name} takes the round` : 'Round over', hint: `${sc} · next round in a moment` };
    if (this.phase === 'intro') return { cls: 'info', text: `Round ${this.round} — get ready…`, hint: me ? `you are on ${TEAM[me.team].name} · ${touch ? 'drag the left side to move · rush a ball at the whistle' : 'rush a ball on the line at the whistle'}` : 'spectating' };
    if (!me) return { cls: 'info', text: 'SPECTATING', hint: '' };
    if (!me.alive) return { cls: 'out', text: 'OUT!', hint: 'watching the round finish' };
    if (!me.ball) return { cls: 'grab', text: 'GRAB A BALL', hint: 'run over a loose ball to pick it up' };
    if (me.state === 'ARMING') return { cls: 'arming', text: 'ARMING…', charge: me.armT / CFG.armTime, hint: '' };
    return { cls: 'ready', text: 'THROW READY', hint: touch ? 'THROW takes the nearest enemy · drag it to aim' : 'Space throws at the nearest enemy' };
  }
}

/* ============================================================ renderer */
class Renderer {
  constructor(canvas) {
    this.cv = canvas; this.ctx = canvas.getContext('2d'); this.scale = 0; this.ui = 1; this.floor = null; this.crowd = [];
    const C = CFG.court, cx = (C.left + C.right) / 2;
    const bluish = ['#3d8bff', '#5aa0ff', '#2f6fd6', '#7fb4ff', '#e8ecf1', '#c7d2e0', '#9aa7b8'];
    const reddish = ['#ff4d5a', '#ff7a84', '#d63a45', '#ffb3b8', '#e8ecf1', '#c7d2e0', '#9aa7b8'];
    for (const row of [{ y: 26, r: 0 }, { y: 52, r: 1 }, { y: 592, r: 2 }, { y: 618, r: 3 }]) {
      for (let x = C.left + 14 + (row.r % 2) * 10; x < C.right - 10; x += 21) {
        const left = x < cx; this.crowd.push({ x: x + rand(-3, 3), y: row.y, side: left ? 'blue' : 'red', color: pick(left ? bluish : reddish),
          phase: rand(Math.PI * 2), freq: rand(3, 6), size: rand(5.5, 7.5), row: row.r });
      }
    }
    this.resize(0);
  }
  /* `cssW` is the width the canvas is shown at (0: not known yet). The backing store is that size times the pixel ratio
     (capped at 2), so a phone showing the court 580 pixels wide is not asked to fill 2080; the floor is repainted when the
     scale changes. `ui` scales the labels drawn on the court, so names stay readable when the court is small. */
  resize(cssW) {
    const dpr = Math.min(2, window.devicePixelRatio || 1), view = cssW > 0 ? clamp(cssW / CFG.W, 0.35, 1) : 1;
    this.ui = clamp(1 / view, 1, 1.7);
    const s = Math.round(dpr * view * 100) / 100;
    if (this.floor && s === this.scale) return;
    this.scale = s; this.cv.width = Math.round(CFG.W * s); this.cv.height = Math.round(CFG.H * s);
    this.floor = this.makeFloor(s);
  }
  makeFloor(dpr) {
    const W = CFG.W, H = CFG.H, C = CFG.court, cx = (C.left + C.right) / 2;
    const oc = document.createElement('canvas'); oc.width = W * dpr; oc.height = H * dpr;
    const x = oc.getContext('2d'); x.scale(dpr, dpr);
    x.fillStyle = '#171b23'; x.fillRect(0, 0, W, H);
    for (let i = 0; i < 4; i++) { x.fillStyle = i % 2 ? '#1a1f28' : '#151920'; x.fillRect(0, (i < 2 ? 12 : 578) + (i % 2) * 26, W, 26); }
    x.fillStyle = '#10131a'; x.fillRect(C.left - 6, C.top - 6, C.right - C.left + 12, C.bottom - C.top + 12);
    // wood planks
    x.save(); x.beginPath(); x.rect(C.left, C.top, C.right - C.left, C.bottom - C.top); x.clip();
    const ph = 24; let row = 0;
    for (let y = C.top; y < C.bottom; y += ph, row++) {
      const l = 58 + (row % 3) * 4 + rand(-3, 3);
      x.fillStyle = `hsl(28, 48%, ${l}%)`; x.fillRect(C.left, y, C.right - C.left, ph);
      x.fillStyle = 'rgba(0,0,0,0.10)'; x.fillRect(C.left, y + ph - 1, C.right - C.left, 1);
      let px = C.left + ((row * 137) % 200) - 200;
      while (px < C.right) { const len = rand(120, 260); x.fillStyle = 'rgba(0,0,0,0.13)'; x.fillRect(px + len, y, 1.5, ph); px += len; }
      for (let k = 0; k < 6; k++) { x.fillStyle = `rgba(90,50,20,${rand(0.03, 0.09)})`; x.fillRect(rand(C.left, C.right), y + rand(2, ph - 4), rand(30, 140), 1); }
    }
    x.fillStyle = 'rgba(61,139,255,0.09)'; x.fillRect(C.left, C.top, cx - C.left, C.bottom - C.top);
    x.fillStyle = 'rgba(255,77,90,0.09)'; x.fillRect(cx, C.top, C.right - cx, C.bottom - C.top);
    const gl = x.createRadialGradient(cx - 120, C.top + 60, 20, cx, (C.top + C.bottom) / 2, 700);
    gl.addColorStop(0, 'rgba(255,255,255,0.18)'); gl.addColorStop(0.5, 'rgba(255,255,255,0.03)'); gl.addColorStop(1, 'rgba(0,0,0,0.12)');
    x.fillStyle = gl; x.fillRect(C.left, C.top, C.right - C.left, C.bottom - C.top);
    // markings
    x.strokeStyle = 'rgba(255,255,255,0.85)'; x.lineWidth = 3; x.strokeRect(C.left + 1.5, C.top + 1.5, C.right - C.left - 3, C.bottom - C.top - 3);
    x.lineWidth = 2; x.beginPath(); x.arc(cx, (C.top + C.bottom) / 2, 56, 0, Math.PI * 2); x.stroke();
    x.setLineDash([6, 8]); x.strokeStyle = 'rgba(255,255,255,0.3)'; x.lineWidth = 2;
    for (const ax of [cx - 150, cx + 150]) { x.beginPath(); x.moveTo(ax, C.top); x.lineTo(ax, C.bottom); x.stroke(); }
    x.setLineDash([]);
    x.font = `900 46px ${FONT}`; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = 'rgba(61,139,255,0.18)'; x.save(); x.translate(C.left + 130, (C.top + C.bottom) / 2); x.rotate(-Math.PI / 2); x.fillText('BLUE', 0, 0); x.restore();
    x.fillStyle = 'rgba(255,77,90,0.18)'; x.save(); x.translate(C.right - 130, (C.top + C.bottom) / 2); x.rotate(Math.PI / 2); x.fillText('RED', 0, 0); x.restore();
    x.restore();
    x.fillStyle = 'rgba(255,255,255,0.05)'; x.fillRect(C.left, 62, C.right - C.left, 2); x.fillRect(C.left, 576, C.right - C.left, 2);
    x.font = '700 10px system-ui, sans-serif'; x.fillStyle = 'rgba(255,255,255,0.28)'; x.textAlign = 'center';
    x.save(); x.translate(20, (C.top + C.bottom) / 2); x.rotate(-Math.PI / 2); x.fillText('BLUE BENCH', 0, 0); x.restore();
    x.save(); x.translate(CFG.W - 20, (C.top + C.bottom) / 2); x.rotate(Math.PI / 2); x.fillText('RED BENCH', 0, 0); x.restore();
    return oc;
  }

  draw(g, now) {
    const x = this.ctx, C = CFG.court, cx = (C.left + C.right) / 2, tm = now / 1000, ui = this.ui;
    x.setTransform(this.scale, 0, 0, this.scale, 0, 0);
    if (g.shake > 0) { const s = g.shake * g.shake * 9; x.translate(rand(-s, s), rand(-s, s)); }
    x.drawImage(this.floor, 0, 0, CFG.W, CFG.H);

    // crowd
    for (const c of this.crowd) {
      const ex = g.excite[c.side]; const bob = Math.sin(tm * c.freq + c.phase) * (1 + ex * 5) - (ex > 0.8 ? Math.abs(Math.sin(tm * 9 + c.phase)) * 6 : 0);
      x.fillStyle = c.color; x.globalAlpha = 0.55 + 0.25 * (c.row % 2);
      x.beginPath(); x.arc(c.x, c.y + bob, c.size, 0, Math.PI * 2); x.fill();
      x.fillStyle = 'rgba(0,0,0,0.35)'; x.beginPath(); x.arc(c.x, c.y + bob + c.size * 1.3, c.size * 0.9, 0, Math.PI); x.fill();
    }
    x.globalAlpha = 1;

    // center line
    if (!g.lineDown) {
      const cd = g.lineCount !== null; const pulse = cd ? 0.5 + 0.5 * Math.abs(Math.sin(tm * 8)) : 1;
      x.save(); x.setLineDash([14, 10]); x.lineDashOffset = -tm * 14 * (cd ? 4 : 1);
      x.lineWidth = cd ? 4 : 3; x.strokeStyle = cd ? `rgba(255,77,90,${0.55 + 0.45 * pulse})` : 'rgba(255,255,255,0.9)';
      if (cd) { x.shadowColor = '#ff4d5a'; x.shadowBlur = 16 * pulse; }
      x.beginPath(); x.moveTo(cx, C.top + 2); x.lineTo(cx, C.bottom - 2); x.stroke(); x.restore();
    }

    // benches
    for (const team of TEAMS) {
      const bx = team === 'blue' ? 36 : CFG.W - 36;
      g.bench[team].forEach((p, i) => {
        const by = C.top + 40 + i * 44;
        x.globalAlpha = 0.75; x.fillStyle = TEAM[team].deep; x.beginPath(); x.arc(bx, by, 12, 0, Math.PI * 2); x.fill();
        x.strokeStyle = 'rgba(255,255,255,0.5)'; x.lineWidth = 2; x.beginPath(); x.moveTo(bx - 5, by - 5); x.lineTo(bx + 5, by + 5); x.moveTo(bx + 5, by - 5); x.lineTo(bx - 5, by + 5); x.stroke();
        x.globalAlpha = 0.6; x.fillStyle = '#fff'; x.font = `700 ${9 * ui}px system-ui, sans-serif`; x.textAlign = 'center'; x.textBaseline = 'top'; x.fillText(p.name, bx, by + 15);
        x.globalAlpha = 1;
      });
    }

    // shadows
    x.fillStyle = 'rgba(0,0,0,0.28)';
    for (const p of g.players) if (p.alive || p.knocked) { x.beginPath(); x.ellipse(p.x + 3, p.y + 6, p.r * 1.05, p.r * 0.7, 0, 0, Math.PI * 2); x.fill(); }
    for (const b of g.balls) if (b.state !== 'held') { x.beginPath(); x.ellipse(b.x + 2, b.y + 4, b.r * b.scale, b.r * 0.65 * b.scale, 0, 0, Math.PI * 2); x.fill(); }

    // trails
    x.lineCap = 'round'; x.lineJoin = 'round';
    for (const b of g.balls) {
      const tr = b.trail; if (tr.length < 2) continue;
      for (let i = 1; i < tr.length; i++) {
        const a = tr[i - 1], q = tr[i]; const age = g.time - q.t; if (age > 0.45 || age < 0) continue;
        const k = i / tr.length, glow = q.team ? TEAM[q.team].glow : 'rgba(255,200,120,';
        x.strokeStyle = glow + (0.85 * (1 - age / 0.45) * k) + ')'; x.lineWidth = 1 + 9 * k;
        x.beginPath(); x.moveTo(a.x, a.y); x.lineTo(q.x, q.y); x.stroke();
      }
    }

    // aim guide for my armed body: the arrow a touch player is dragging out, else the enemy the throw will take
    const h = g.me;
    if (h && g.phase === 'play' && h.active && h.ball && h.state === 'READY') {
      x.save(); x.setLineDash([4, 8]); x.lineDashOffset = -tm * 40; x.lineWidth = 2 * ui;
      if (g.aim) {
        const L = 150, ex = h.x + g.aim.x * L, ey = h.y + g.aim.y * L, a = Math.atan2(g.aim.y, g.aim.x), s = 11 * ui;
        x.strokeStyle = 'rgba(255,210,63,0.8)'; x.beginPath(); x.moveTo(h.x, h.y); x.lineTo(ex, ey); x.stroke(); x.setLineDash([]);
        x.fillStyle = '#ffd23f'; x.beginPath(); x.moveTo(ex + Math.cos(a) * s, ey + Math.sin(a) * s);
        x.lineTo(ex + Math.cos(a + 2.4) * s, ey + Math.sin(a + 2.4) * s); x.lineTo(ex + Math.cos(a - 2.4) * s, ey + Math.sin(a - 2.4) * s); x.closePath(); x.fill();
      } else {
        const n = g.nearestEnemy(h);
        if (n) { const best = n.e; x.strokeStyle = 'rgba(71,224,122,0.45)';
          x.beginPath(); x.moveTo(h.x, h.y); x.lineTo(best.x, best.y); x.stroke(); x.setLineDash([]);
          x.strokeStyle = 'rgba(71,224,122,0.8)'; x.beginPath(); x.arc(best.x, best.y, best.r + 9 + Math.sin(tm * 6) * 2, 0, Math.PI * 2); x.stroke(); }
      }
      x.restore();
    }

    // loose balls, then players, then held balls on top (in the hand)
    for (const b of g.balls) if (b.state !== 'held') this.drawBall(b, g);
    for (const p of g.players) if (p.alive) this.drawPlayer(p, g, tm);
    for (const b of g.balls) if (b.state === 'held') this.drawBall(b, g);
    for (const p of g.players) if (p.knocked) this.drawPlayer(p, g, tm);

    // particles
    for (const q of g.particles) {
      const k = clamp(q.life / q.max, 0, 1); x.globalAlpha = k;
      if (q.type === 'ring') { x.strokeStyle = q.color; x.lineWidth = 3 * k + 0.5; x.beginPath(); x.arc(q.x, q.y, q.size * (1.3 - k), 0, Math.PI * 2); x.stroke(); }
      else if (q.type === 'dash') { x.save(); x.translate(q.x, q.y); x.rotate(q.rot); x.fillStyle = q.color; x.fillRect(-q.size / 2, -1.5, q.size * k, 3); x.restore(); }
      else if (q.type === 'spark') { x.strokeStyle = q.color; x.lineWidth = q.size * k; x.beginPath(); x.moveTo(q.x, q.y); x.lineTo(q.x - q.vx * 0.04, q.y - q.vy * 0.04); x.stroke(); }
      else { x.fillStyle = q.color; x.beginPath(); x.arc(q.x, q.y, q.size * (0.4 + 0.6 * k), 0, Math.PI * 2); x.fill(); }
    }
    x.globalAlpha = 1;

    // floating text
    x.textAlign = 'center'; x.textBaseline = 'middle';
    for (const f of g.floats) { const k = clamp(f.life / f.max, 0, 1); x.globalAlpha = Math.min(1, k * 2); x.font = `900 ${f.size * ui}px ${FONT}`;
      x.lineWidth = 4; x.strokeStyle = 'rgba(0,0,0,0.6)'; x.strokeText(f.text, f.x, f.y); x.fillStyle = f.color; x.fillText(f.text, f.x, f.y); }
    x.globalAlpha = 1;

    // vignette + flash
    const vg = x.createRadialGradient(cx, CFG.H / 2, 260, cx, CFG.H / 2, 720); vg.addColorStop(0, 'rgba(0,0,0,0)'); vg.addColorStop(1, 'rgba(0,0,0,0.42)');
    x.fillStyle = vg; x.fillRect(0, 0, CFG.W, CFG.H);
    if (g.flash > 0) { x.fillStyle = `rgba(255,255,255,${g.flash * 0.22})`; x.fillRect(0, 0, CFG.W, CFG.H); }

    // line countdown: big number centered
    if (g.lineCount !== null && !g.lineDown) {
      const frac = (CFG.lineDownAt - g.time) % 1, sc = 1 + 0.5 * easeOut(clamp(frac, 0, 1)); x.save(); x.translate(cx, (C.top + C.bottom) / 2); x.scale(sc, sc);
      x.font = `900 120px ${FONT}`; x.globalAlpha = 0.85; x.lineWidth = 8; x.strokeStyle = 'rgba(0,0,0,0.55)'; x.strokeText(g.lineCount, 0, 0);
      x.fillStyle = '#ffd23f'; x.fillText(g.lineCount, 0, 0); x.restore();
    }
    if (g.subBanner) { const w = 360 * ui, hh = 36 * ui; x.font = `800 ${20 * ui}px ${FONT}`; x.fillStyle = 'rgba(0,0,0,0.55)'; x.beginPath(); x.roundRect(cx - w / 2, C.top + 12, w, hh, 8); x.fill();
      x.fillStyle = '#ffd23f'; x.fillText(g.subBanner.text.toUpperCase(), cx, C.top + 12 + hh / 2); }

    // banner
    const bn = g.banner;
    if (bn) {
      const tin = clamp(bn.t / 0.28, 0, 1), tout = clamp((bn.dur - bn.t) / 0.3, 0, 1), a = Math.min(tin, tout), sc = easeOutBack(tin), bs = 1 + (ui - 1) * 0.5;
      const y = (C.top + C.bottom) / 2 - (bn.sub ? 12 : 0) * bs;
      x.save(); x.globalAlpha = a * 0.75; x.fillStyle = 'rgba(8,10,14,0.9)'; x.fillRect(C.left, y - 62 * bs, C.right - C.left, (bn.sub ? 130 : 110) * bs);
      x.globalAlpha = a; x.fillStyle = bn.color; x.fillRect(C.left, y - 62 * bs, C.right - C.left, 3); x.fillRect(C.left, y + (bn.sub ? 66 : 46) * bs, C.right - C.left, 3);
      x.translate(cx, y); x.scale(sc, sc);
      x.font = `900 ${bn.size * bs}px ${FONT}`; x.textAlign = 'center'; x.textBaseline = 'middle';
      x.shadowColor = bn.color; x.shadowBlur = 24; x.fillStyle = bn.color; x.fillText(bn.text, 0, 0); x.shadowBlur = 0;
      if (bn.sub) { x.font = `600 ${18 * bs}px ${FONT}`; x.fillStyle = 'rgba(255,255,255,0.85)'; x.fillText(bn.sub, 0, 50 * bs); }
      x.restore();
    }
  }

  drawBall(b, g) {
    const x = this.ctx; x.save(); x.translate(b.x, b.y); x.scale(b.scale, b.scale);
    if (b.state === 'drain') x.globalAlpha = 0.5 + 0.5 * b.scale;
    if (b.state === 'live' && b.team) { x.shadowColor = TEAM[b.team].color; x.shadowBlur = 22; }
    const gr = x.createRadialGradient(-b.r * 0.35, -b.r * 0.4, 1, 0, 0, b.r * 1.1);
    gr.addColorStop(0, '#ffb070'); gr.addColorStop(0.5, '#ff7a30'); gr.addColorStop(1, '#b8420e');
    x.fillStyle = gr; x.beginPath(); x.arc(0, 0, b.r, 0, Math.PI * 2); x.fill(); x.shadowBlur = 0;
    x.save(); x.beginPath(); x.arc(0, 0, b.r - 0.5, 0, Math.PI * 2); x.clip(); x.rotate(b.roll); x.strokeStyle = 'rgba(90,30,0,0.45)'; x.lineWidth = 1.6;
    x.beginPath(); x.ellipse(0, 0, b.r, b.r * 0.42, 0, 0, Math.PI * 2); x.stroke(); x.beginPath(); x.ellipse(0, 0, b.r * 0.42, b.r, 0, 0, Math.PI * 2); x.stroke(); x.restore();
    x.strokeStyle = 'rgba(60,20,0,0.55)'; x.lineWidth = 1.2; x.beginPath(); x.arc(0, 0, b.r - 0.6, 0, Math.PI * 2); x.stroke();
    x.fillStyle = 'rgba(255,255,255,0.55)'; x.beginPath(); x.ellipse(-b.r * 0.35, -b.r * 0.4, b.r * 0.28, b.r * 0.18, -0.6, 0, Math.PI * 2); x.fill();
    if (b.state === 'idle' && b.idleT > 0.4 && g.phase === 'play') { // soft "grab me" pulse
      const k = (Math.sin(g.time * 4 + b.wobble) + 1) / 2; x.strokeStyle = `rgba(255,255,255,${0.12 + 0.2 * k})`; x.lineWidth = 1.5; x.beginPath(); x.arc(0, 0, b.r + 5 + k * 3, 0, Math.PI * 2); x.stroke(); }
    x.restore();
  }

  drawPlayer(p, g, tm) {
    const x = this.ctx, T = TEAM[p.team], k = p.knocked, isMe = p === g.me, accent = p.isHuman && AVATARS[p.avatar] ? hex(AVATARS[p.avatar].color) : null, ui = this.ui;
    x.save(); x.translate(p.x, p.y);
    if (k) { x.globalAlpha = clamp(1 - (k.t - 0.35) / 0.5, 0, 1); x.rotate(k.spin); }
    // feet
    const fx = Math.cos(p.face), fy = Math.sin(p.face), sx = -fy, sy = fx, step = Math.sin(p.bob) * 6 * Math.min(1, p.moving * 1.5);
    x.fillStyle = T.deep;
    x.beginPath(); x.ellipse(sx * 7 + fx * step, sy * 7 + fy * step, 6, 4.5, p.face, 0, Math.PI * 2); x.fill();
    x.beginPath(); x.ellipse(-sx * 7 - fx * step, -sy * 7 - fy * step, 6, 4.5, p.face, 0, Math.PI * 2); x.fill();
    // body
    const gr = x.createRadialGradient(-5, -6, 2, 0, 0, p.r + 2);
    gr.addColorStop(0, isMe ? '#ffffff' : (p.team === 'blue' ? '#74acff' : '#ff8f98')); gr.addColorStop(0.65, T.color); gr.addColorStop(1, T.deep);
    x.fillStyle = gr; x.beginPath(); x.arc(0, 0, p.r, 0, Math.PI * 2); x.fill();
    x.lineWidth = 2.5; x.strokeStyle = 'rgba(0,0,0,0.5)'; x.stroke();
    // jersey stripe (a human's own avatar colour, so team-mates can tell each other apart) + eyes toward facing
    x.save(); x.rotate(p.face); x.fillStyle = accent || 'rgba(255,255,255,0.22)'; x.globalAlpha *= accent ? 0.9 : 1; x.fillRect(-p.r + 3, -3, p.r * 2 - 6, 6); x.globalAlpha = k ? x.globalAlpha : 1;
    x.fillStyle = '#fff'; x.beginPath(); x.arc(p.r * 0.45, -5, 3.2, 0, Math.PI * 2); x.arc(p.r * 0.45, 5, 3.2, 0, Math.PI * 2); x.fill();
    x.fillStyle = '#111'; x.beginPath(); x.arc(p.r * 0.55, -5, 1.7, 0, Math.PI * 2); x.arc(p.r * 0.55, 5, 1.7, 0, Math.PI * 2); x.fill(); x.restore();
    // arm holding the ball
    if (p.ball) { const a = p.face + 0.75 * (p.team === 'blue' ? -1 : 1); x.strokeStyle = T.deep; x.lineWidth = 5; x.lineCap = 'round'; x.beginPath(); x.moveTo(Math.cos(a) * 8, Math.sin(a) * 8); x.lineTo(Math.cos(a) * (p.r + 2), Math.sin(a) * (p.r + 2)); x.stroke(); }
    x.restore();
    if (k) return;

    // state ring
    const R = p.r + 7, thick = isMe ? 4.5 : 2.5;
    x.save(); x.lineWidth = thick; x.lineCap = 'round';
    if (!p.ball) { x.strokeStyle = isMe ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.22)'; x.setLineDash(isMe ? [6, 6] : [3, 6]); x.lineDashOffset = -tm * 20;
      x.beginPath(); x.arc(p.x, p.y, R, 0, Math.PI * 2); x.stroke(); x.setLineDash([]); }
    else if (p.state === 'ARMING') { const c = clamp(p.armT / CFG.armTime, 0, 1);
      x.strokeStyle = 'rgba(255,210,63,0.25)'; x.beginPath(); x.arc(p.x, p.y, R, 0, Math.PI * 2); x.stroke();
      x.strokeStyle = '#ffd23f'; x.shadowColor = '#ffd23f'; x.shadowBlur = 10; x.beginPath(); x.arc(p.x, p.y, R, -Math.PI / 2, -Math.PI / 2 + c * Math.PI * 2); x.stroke(); }
    else { const pulse = 0.75 + 0.25 * Math.sin(tm * 10); x.strokeStyle = `rgba(71,224,122,${pulse})`; x.shadowColor = '#47e07a'; x.shadowBlur = isMe ? 16 : 8;
      x.beginPath(); x.arc(p.x, p.y, R + (isMe ? Math.sin(tm * 10) * 1.2 : 0), 0, Math.PI * 2); x.stroke(); }
    x.restore();

    // stamina bar
    const bw = 32 * ui, bh = 4 * ui, by = p.y + p.r + 12;
    x.fillStyle = 'rgba(0,0,0,0.55)'; x.beginPath(); x.roundRect(p.x - bw / 2 - 1, by - 1, bw + 2, bh + 2, 2); x.fill();
    const st = p.stamina; x.fillStyle = st > 0.5 ? '#47e07a' : st > 0.2 ? '#ffd23f' : '#ff4d5a'; if (p.sprinting) x.fillStyle = '#9dffbd';
    x.fillRect(p.x - bw / 2, by, bw * st, bh);
    // name (humans a little bolder than CPUs, mine white with a marker)
    const ny = p.y - p.r - 6 - 3 * ui;
    x.font = `${isMe ? 800 : p.isHuman ? 700 : 600} ${Math.round(11 * ui)}px ${FONT}`; x.textAlign = 'center'; x.textBaseline = 'bottom';
    x.fillStyle = 'rgba(0,0,0,0.6)'; x.fillText(p.name, p.x + 1, ny + 1); x.fillStyle = isMe ? '#fff' : p.isHuman ? 'rgba(255,255,255,0.92)' : 'rgba(255,255,255,0.75)'; x.fillText(p.name, p.x, ny);
    if (isMe) { const yy = ny - 15 * ui + Math.sin(tm * 5) * 2, m = 5 * ui; x.fillStyle = '#fff'; x.beginPath(); x.moveTo(p.x - m, yy - m * 1.2); x.lineTo(p.x + m, yy - m * 1.2); x.lineTo(p.x, yy); x.closePath(); x.fill(); }
    // sprint dust
    if (p.sprinting && p.moving > 0.5) { p.dustT -= 1 / 60; if (p.dustT <= 0) { p.dustT = 0.06; g.particles.push({ x: p.x - Math.cos(p.face) * 10 + rand(-4, 4), y: p.y + 8 + rand(-3, 3), vx: -Math.cos(p.face) * 30 + rand(-20, 20), vy: rand(-25, -5), life: 0.45, max: 0.45, size: 4, color: 'rgba(230,210,180,0.5)', type: 'dot' }); } }
  }
}

/* ============================================================ module: DOM, input, loop, session API */
const HUD = `
<div class="app">
  <header>
    <div class="team blue"><span class="name">BLUE</span><span class="pips" data-pips="blue"></span><span class="score" data-score="blue">0</span></div>
    <div class="mid"><div class="count" data-count><span class="b">3</span><span class="v">v</span><span class="r">3</span></div><div class="sub" data-sub>Round 1 · 0:00</div></div>
    <div class="team red"><span class="score" data-score="red">0</span><span class="pips" data-pips="red"></span><span class="name">RED</span></div>
    <div class="menu-btn ctl" data-menu>☰</div>
  </header>
  <div class="court">
    <canvas width="1040" height="640"></canvas>
    <div class="result" hidden><h1 data-res-title></h1><h2 data-res-sub></h2><div class="foot" data-res-foot></div></div>
  </div>
  <div class="status info"><span data-stext>ROUND 1 — get ready…</span><span class="charge"><i></i></span><span class="hint" data-shint></span></div>
  <footer>
    <div><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd> move &nbsp; <kbd>Shift</kbd> sprint &nbsp; <kbd>Space</kbd> throw at nearest enemy &nbsp; <kbd>M</kbd> sound <span data-keys></span></div>
    <div class="right"><span class="snd" data-snd>🔊 sound on</span><span data-role></span><span class="fps" data-fps>— fps</span></div>
  </footer>
</div>
<div class="pad ctl" data-pad><div class="ring"><div class="knob"></div></div><div class="lbl">DRAG HERE TO MOVE</div></div>
<div class="tbtn ctl sprint" data-sprint>SPRINT</div>
<div class="tbtn ctl throw" data-throw><b>THROW</b><small>➜</small></div>
<div class="overlay pause" data-pause><div class="card"><h1>MENU</h1><div data-pause-btns></div></div></div>
<div class="overlay rotate"><div><div class="phone">📱</div>ROTATE YOUR DEVICE<small>DODGEBALL PLAYS IN LANDSCAPE</small></div></div>`;

export async function create({ mount, audio, send, hooks }) {
  const unloadCss = await loadStylesheet('/games/dodgeball/dodgeball.css');
  const touch = isCoarse(); // phones and tablets: the thumb stick, SPRINT, THROW and ☰ appear and the keyboard footer goes
  const root = document.createElement('div'); root.className = 'db' + (touch ? ' touch' : ''); root.innerHTML = HUD; mount.appendChild(root);
  const $ = sel => root.querySelector(sel);
  const dom = { count: $('[data-count]'), sub: $('[data-sub]'), score: { blue: $('[data-score="blue"]'), red: $('[data-score="red"]') }, pips: { blue: $('[data-pips="blue"]'), red: $('[data-pips="red"]') },
    status: $('.status'), stext: $('[data-stext]'), shint: $('[data-shint]'), charge: $('.charge > i'), fps: $('[data-fps]'), snd: $('[data-snd]'), keys: $('[data-keys]'), role: $('[data-role]'),
    result: $('.result'), resTitle: $('[data-res-title]'), resSub: $('[data-res-sub]'), resFoot: $('[data-res-foot]'),
    throwBtn: $('[data-throw]'), menuBtn: $('[data-menu]'), pause: $('[data-pause]'), pauseBtns: $('[data-pause-btns]') };
  const sfx = createSfx(audio);
  const canvas = $('canvas'), R = new Renderer(canvas);
  /* the backing store follows the size the canvas is shown at, and the court's labels grow when it is small */
  const fit = () => R.resize(canvas.clientWidth);
  addEventListener('resize', fit);
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null; ro?.observe(canvas);

  let game = null, session = null, isHost = false, online = false, hostId = null, myId = null;
  const canRestart = () => !online || isHost;

  /* ---- input: the keyboard, plus the touch controls on a coarse-pointer screen */
  const setSnd = () => { dom.snd.textContent = audio.muted ? '🔇 sound off' : '🔊 sound on'; };
  /* `dir` is a unit vector to throw along (a touch player who dragged THROW to aim); without one the host takes the nearest enemy */
  const throwPressed = dir => {
    if (!game || game.phase !== 'play') return;
    if (isHost) game.requestThrow(game.me, dir);
    else if (game.me) send(dir ? { t: 'th', to: hostId, dx: r2(dir.x), dy: r2(dir.y) } : { t: 'th', to: hostId });
  };
  const kb = createInput({ KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down', KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right', ShiftLeft: 'sprint', ShiftRight: 'sprint' }, {
    onKey: e => {
      if (e.code === 'Space') { e.preventDefault(); throwPressed(null); }
      else if (e.code === 'KeyM') { audio.toggle(); setSnd(); }
      else if (e.code === 'KeyR') hooks.onRestart?.();
      else if (e.code === 'Escape') hooks.onExit?.();
    },
  });
  const held = kb.held;
  dom.snd.addEventListener('click', () => { audio.toggle(); setSnd(); });

  /* touch: the left part of the screen is a thumb stick; SPRINT (hold) and THROW sit under the right thumb. THROW fires
     when the finger lifts so that a drag can aim it: past AIM_PX the throw goes the way the finger went instead of at the
     nearest enemy, and an arrow from the body shows where. A press with nothing to throw shakes the button, so a tap is
     never silent. */
  const tc = createTouch();
  const AIM_PX = 28;
  const shake = el => { el.classList.remove('nope'); void el.offsetWidth; el.classList.add('nope'); };
  dom.throwBtn.addEventListener('animationend', () => dom.throwBtn.classList.remove('nope'));
  const aimOf = st => { const d = hyp(st.dx, st.dy); return d > AIM_PX ? { x: st.dx / d, y: st.dy / d } : null; };
  const canThrow = () => !!(game && game.phase === 'play' && game.me && game.me.active && game.me.ball);
  const stickS = touch ? tc.pad($('[data-pad]'), { range: 60, dead: 6, axes: 2, onDown: () => audio.init() }) : null;
  const sprintS = touch ? tc.button($('[data-sprint]'), { onDown: () => audio.init() }) : null;
  const throwS = touch ? tc.button(dom.throwBtn, {
    onDown: () => { audio.init(); if (!canThrow()) shake(dom.throwBtn); },
    onUp: st => throwPressed(aimOf(st)), // the host decides whether there is a ball to throw: a client's own view can lag a pickup
  }) : null;
  /* what my body is told to do this frame: the keys, or the stick and the buttons */
  function readWant() {
    let x = (held.right ? 1 : 0) - (held.left ? 1 : 0), y = (held.down ? 1 : 0) - (held.up ? 1 : 0), sprint = !!held.sprint;
    if (touch) { if (!x && !y && stickS.held) { x = r1(stickS.x); y = r1(stickS.y); } sprint = sprint || sprintS.held; }
    return { x, y, sprint };
  }
  let aimShown = false;
  function syncTouch() {
    if (!touch) return;
    const aim = throwS.held && canThrow() ? aimOf(throwS) : null; game.aim = aim;
    if (!!aim !== aimShown) { aimShown = !!aim; dom.throwBtn.classList.toggle('aim', aimShown); }
    if (aim) dom.throwBtn.style.setProperty('--aim', `${Math.round(Math.atan2(aim.y, aim.x) * 180 / Math.PI)}deg`);
    const me = game.me, armed = !!(me && me.active && me.ball && game.phase === 'play');
    dom.throwBtn.classList.toggle('has', armed); dom.throwBtn.classList.toggle('ready', armed && me.state === 'READY');
  }

  /* ☰: a card with what M, R and Esc do on a keyboard; the match keeps running underneath */
  function renderMenu() {
    const f = dom.pauseBtns; f.innerHTML = '';
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = fn; f.appendChild(b); };
    btn('RESUME', 'primary', () => showMenu(false));
    btn(audio.muted ? 'SOUND: OFF' : 'SOUND: ON', '', () => { audio.toggle(); setSnd(); renderMenu(); });
    if (canRestart()) { btn(!online ? 'RESTART' : 'PLAY AGAIN', '', () => { showMenu(false); hooks.onRestart?.(); }); btn(!online ? 'QUIT TO MENU' : 'BACK TO LOBBY', '', () => { showMenu(false); hooks.onExit?.(); }); }
  }
  function showMenu(on) { dom.pause.classList.toggle('show', on); if (on) { tc.releaseAll(); renderMenu(); } }
  if (touch) { dom.menuBtn.addEventListener('click', () => { audio.init(); showMenu(!dom.pause.classList.contains('show')); }); dom.pause.addEventListener('click', e => { if (e.target === dom.pause) showMenu(false); }); }

  /* ---- networking glue */
  let netAcc = 0, lastSent = null, sinceSent = 0;
  function hostNetTick(dt) {
    if (!online) { game.events.length = 0; return; }
    netAcc += dt; if (netAcc < 1 / CFG.netHz - 0.002) return; netAcc = Math.max(0, netAcc - 1 / CFG.netHz); // carry the remainder: a 30 Hz ticker's 33 ms steps must not skip every other send
    send(game.packSnapshot());
  }
  function clientSendInput(want, dt) {
    sinceSent += dt;
    const changed = !lastSent || lastSent.x !== want.x || lastSent.y !== want.y || lastSent.sprint !== want.sprint;
    if ((changed && sinceSent >= 1 / 60) || sinceSent >= 0.4) { lastSent = { ...want }; sinceSent = 0; send({ t: 'in', to: hostId, x: want.x, y: want.y, s: want.sprint ? 1 : 0 }); }
  }

  /* ---- HUD sync */
  const cache = {};
  const setText = (key, node, text) => { if (cache[key] !== text) { cache[key] = text; node.textContent = text; } };
  function buildPips() { for (const team of TEAMS) dom.pips[team].innerHTML = '<i class="pip on"></i>'.repeat(game.count[team]); }
  function renderResult() {
    const w = game.matchWinner; if (!w) return;
    dom.resTitle.textContent = `${TEAM[w].name} WINS`; dom.resTitle.style.color = TEAM[w].color; dom.resSub.textContent = `${game.score.blue} – ${game.score.red}`;
    const f = dom.resFoot; f.innerHTML = '';
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn small ' + cls; b.textContent = label; b.onclick = fn; f.appendChild(b); };
    const key = k => touch ? '' : `  (${k})`;
    if (!online) { btn('PLAY AGAIN' + key('R'), 'primary', () => hooks.onRestart?.()); btn('MENU' + key('ESC'), '', () => hooks.onExit?.()); }
    else if (isHost) { btn('PLAY AGAIN' + key('R'), 'primary', () => hooks.onRestart?.()); btn('BACK TO LOBBY' + key('ESC'), '', () => hooks.onExit?.()); }
    else f.textContent = 'WAITING FOR THE HOST TO PLAY AGAIN OR RETURN TO THE LOBBY…';
  }
  function syncDom() {
    const ab = game.aliveCount('blue'), ar = game.aliveCount('red');
    const countHtml = `<span class="b">${ab}</span><span class="v">v</span><span class="r">${ar}</span>`;
    if (cache.countHtml !== countHtml) { cache.countHtml = countHtml; dom.count.innerHTML = countHtml; }
    dom.count.classList.toggle('bump', game.countBump > 0);
    for (const team of TEAMS) { const alive = team === 'blue' ? ab : ar; const pips = dom.pips[team].children; for (let i = 0; i < pips.length; i++) pips[i].className = 'pip ' + (i < alive ? 'on' : 'off'); }
    setText('sb', dom.score.blue, String(game.score.blue)); setText('sr', dom.score.red, String(game.score.red));
    let sub = `Round ${game.round} · ${fmtClock(game.time)} · ${game.ballsInPlay()} balls`;
    if (game.lineDown) sub += ' · <span class="down">LINE DOWN</span>'; else if (game.lineCount !== null) sub += ` · <span class="warn">LINE DROPS IN ${game.lineCount}</span>`;
    if (cache.sub !== sub) { cache.sub = sub; dom.sub.innerHTML = sub; }
    const st = game.status(canRestart(), touch);
    if (cache.cls !== st.cls) { cache.cls = st.cls; dom.status.className = 'status ' + st.cls; }
    setText('stext', dom.stext, st.text); setText('shint', dom.shint, st.hint || '');
    if (st.charge !== undefined) dom.charge.style.width = `${Math.round(st.charge * 100)}%`;
    const over = !!game.matchWinner; if (cache.over !== over) { cache.over = over; root.classList.toggle('over', over); } // hides the touch controls
    const showRes = over && game.phaseT > 1.2;
    if (showRes !== !dom.result.hidden) { dom.result.hidden = !showRes; if (showRes) renderResult(); }
  }

  /* ---- main loop. The simulation advances by the wall clock (`simAt`): from the frame loop while the tab is visible and,
     for an online host, from a worker timer while it is hidden (requestAnimationFrame stops there), so the match goes on
     for everyone else while the host glances at another app. */
  let simAt = 0, fpsAcc = 0, fpsN = 0, fpsAt = 0;
  function step(now) {
    const dt = clamp((now - simAt) / 1000, 0, 0.05); simAt = now;
    const me = game.me, want = readWant();
    if (isHost) { if (me) me.want = want; game.update(dt); hostNetTick(dt); }
    else { if (me) clientSendInput(want, dt); game.updateClient(dt); }
    return dt;
  }
  const ticker = createTicker(CFG.netHz, () => { if (game && online && isHost && document.hidden) step(performance.now()); });
  const loop = createLoop((real, now) => {
    if (!game) return;
    const dt = step(now);
    syncTouch(); R.draw(game, now); syncDom();
    fpsAcc += dt; fpsN++;
    if (now - fpsAt > 500) { dom.fps.textContent = `${Math.round(fpsN / Math.max(fpsAcc, 1e-3))} fps`; fpsAcc = 0; fpsN = 0; fpsAt = now; }
  });

  /* ---- session API */
  function start(s) {
    session = s; isHost = !!s.isHost; online = !!s.online; hostId = s.hostId; myId = s.myId;
    game = new Game(buildRoster(s), { opts: s.opts || {}, sfx, isHost, online, myId });
    for (const k of Object.keys(cache)) delete cache[k]; netAcc = 0; lastSent = null; sinceSent = 1; simAt = performance.now();
    buildPips(); dom.result.hidden = true; root.classList.remove('over'); setSnd(); showMenu(false);
    dom.keys.innerHTML = !online ? '&nbsp; <kbd>R</kbd> restart &nbsp; <kbd>Esc</kbd> menu' : isHost ? '&nbsp; <kbd>R</kbd> again &nbsp; <kbd>Esc</kbd> lobby' : '';
    dom.role.textContent = !online ? 'solo' : isHost ? 'hosting' : `${session.players.length} players`;
    audio.init(); kb.attach(); if (touch) tc.attach(); loop.start(); if (online && isHost) ticker.start(); else ticker.stop(); fit();
  }
  function stop() { session = null; game = null; kb.detach(); tc.detach(); ticker.stop(); loop.stop(); showMenu(false); dom.result.hidden = true; }
  function destroy() { stop(); ticker.dispose(); ro?.disconnect(); removeEventListener('resize', fit); root.remove(); mount.innerHTML = ''; unloadCss(); if (window.__dodgeball === debug) delete window.__dodgeball; }
  function playerLeft(pid) { if (game && isHost) { const p = game.playerOf(pid); if (p) game.toAI(p); } } // clients learn it from the next snapshot
  function onNetMessage(msg) {
    if (!game) return;
    switch (msg.t) {
      case 's': if (!isHost && msg.from === hostId) game.applySnapshot(msg); break;
      case 'in': if (isHost) { const p = game.playerOf(msg.from); if (p) p.want = { x: clamp(Number(msg.x) || 0, -1, 1), y: clamp(Number(msg.y) || 0, -1, 1), sprint: !!msg.s }; } break;
      case 'th': if (isHost) { const dx = Number(msg.dx), dy = Number(msg.dy), d = hyp(dx, dy); game.requestThrow(game.playerOf(msg.from), d > 0.5 && d < 2 ? { x: dx / d, y: dy / d } : null); } break;
    }
  }
  const debug = { get game() { return game; }, get session() { return session; }, CFG, renderer: R, loop, touch: { on: touch, stick: stickS, sprint: sprintS, throw: throwS, showMenu } };
  window.__dodgeball = debug;
  return { start, stop, destroy, onNetMessage, playerLeft, debug };
}
