/* Crossy Farm Car - hop a car across roads, rivers and stampede tracks. Game module for the LAN party shell;
   the contract is documented at the top of games/kart/index.js.

   Netcode: each machine simulates its own car - hops, log rides, collisions, death and the UFO - and
   broadcasts a small 20 Hz snapshot (`s`); the other cars are interpolated from those a little in the past.
   The farm itself never travels. It is generated from the round's seed (session.seed) with the shared rng,
   and everything that moves on it (herds, logs, stampede schedules) is a pure function of the world clock,
   which the host carries in its snapshots so every screen agrees on where the cows are. Coins go to whoever
   lands first (`coin`). Everyone plays until they die; the round ends when every car is dead and the
   standings are furthest row, then coins. Cars are ghosts to each other.

   Rows are split in two: a *spec* (the deterministic data - what is where, which way the herd runs) exists
   for every row the room spans, and a *mesh* is only built for the rows near this machine's camera. */
import * as THREE from 'three';
import { clamp, lerp, makeRng, ordinal } from '../../core/math.js';
import { esc, hex, loadStylesheet } from '../../core/ui.js';
import { createInput } from '../../core/input.js';
import { createLoop } from '../../core/loop.js';
import { nowSec, pushSnap, sampleSnaps } from '../../core/interp.js';
import { AVATARS } from '../../core/avatars.js';

/* ============================================================ config */
const CH = 6;                    // playable columns -CH..CH
const GH = 16;                   // ground extends -GH..GH
const GW = GH * 2 + 1;
const LOOP = 36;                 // a lane's traffic repeats every LOOP units
const AHEAD = 30, BEHIND = 14;   // rows kept built around the camera
const MIN_ROW = -4;
const HOP_DUR = 0.17, HOP_H = 0.5, DIE_T = 1.05, COUNT_T = 2.4, HOLD_REPEAT = 0.3;
const IDLE_WARN = 3, IDLE_LIMIT = 5.2, PROG_WARN = 8, PROG_LIMIT = 10.5, UFO_Y = 3.4;
const NET_HZ = 20, NET_HZ_DEAD = 4, INTERP_DELAY = 0.12;
const SKY = 0x8fd3ff, PI = Math.PI;
/* which vehicle each shell avatar drives (core/avatars.js order: Frost, Yeti, Blizzard, Glacier, Aurora, Flurry, Penguin, Frostbite) */
const AVATAR_VEHICLE = ['sports', 'pickup', 'taxi', 'tractor', 'monster', 'hatch', 'cop', 'icecream'];
const r2 = v => Math.round(v * 100) / 100;
const r3 = v => Math.round(v * 1000) / 1000;
const wrap = v => { v = (v + LOOP / 2) % LOOP; if (v < 0) v += LOOP; return v - LOOP / 2; };
const allCols = () => { const s = new Set(); for (let c = -CH; c <= CH; c++) s.add(c); return s; };
const pickR = (R, a) => a[Math.floor(R.rnd() * a.length)];
const randiR = (R, a, b) => Math.floor(R.rr(a, b + 1));

/* ============================================================ palette + voxel models
   A part is a box { x, y, z, w, h, d, c, rx, ry, rz }; a model is a list of parts merged into one geometry. */
const C = {
  grassA: 0xaee35f, grassB: 0xa0d654, grassOutA: 0x74b24a, grassOutB: 0x6aa643,
  road: 0x4d4d5a, dash: 0xf2f2f2, water: 0x41a6ff, dirt: 0xb58b53, dirtOut: 0x9f7847,
  trunk: 0x7a4a28, leaf: [0x2f9e4f, 0x3cb35e, 0x2a8f47, 0x4cc067],
  rock: 0x9aa3ab, rock2: 0x7f8891, hay: 0xe9c450, hay2: 0xd2ad3c,
  log: 0x8b5a2b, logEnd: 0xc59a6b, coin: 0xffcf33, coin2: 0xfff0a0,
  white: 0xf7f7f7, black: 0x262626, pink: 0xf5a3b8, dpink: 0xe07d98, orange: 0xff9f1c, red: 0xe63946, wool: 0xf3efe4, gray: 0xcfd4d8, brownCow: 0x8a5a3c,
  barn: 0xc8372d, roof: 0x5a3a2a, silo: 0xd9dde2, fence: 0xc9a978,
  flower: [0xff6b9a, 0xfff275, 0xffffff, 0xff9f1c, 0xb388ff],
};
const B = (x, y, z, w, h, d, c, rot) => ({ x, y, z, w, h, d, c, ...(rot || {}) });
const addParts = (list, parts, ox, oy, oz) => { for (const p of parts) list.push({ ...p, x: p.x + ox, y: p.y + oy, z: p.z + oz }); };

function treeParts(R) {
  const p = [], h = R.rr(0.45, 0.85), leaf = pickR(R, C.leaf), leaf2 = pickR(R, C.leaf);
  p.push(B(0, h / 2, 0, 0.3, h, 0.3, C.trunk));
  const levels = randiR(R, 2, 3); let y = h, s = R.rr(0.8, 0.98);
  for (let i = 0; i < levels; i++) { const lh = R.rr(0.35, 0.5); p.push(B(0, y + lh / 2, 0, s, lh, s, i % 2 ? leaf2 : leaf)); y += lh; s *= 0.72; }
  return p;
}
const rockParts = R => [B(0, 0.17, 0, 0.7, 0.34, 0.6, C.rock, { ry: R.rr(-0.4, 0.4) }), B(0.12, 0.3, 0.08, 0.32, 0.28, 0.34, C.rock2, { ry: R.rr(-0.4, 0.4) })];
const HAY = [B(0, 0.3, 0, 0.8, 0.6, 0.7, C.hay), B(0, 0.3, 0, 0.82, 0.1, 0.72, C.hay2), B(0, 0.15, 0, 0.82, 0.06, 0.72, C.hay2), B(0, 0.45, 0, 0.82, 0.06, 0.72, C.hay2)];
const STUMP = [B(0, 0.15, 0, 0.45, 0.3, 0.45, C.trunk), B(0, 0.31, 0, 0.36, 0.02, 0.36, 0xb98a5e)];
const flowerParts = c => [B(0, 0.09, 0, 0.04, 0.18, 0.04, 0x3cb35e), B(0, 0.2, 0, 0.14, 0.08, 0.14, c), B(0, 0.2, 0, 0.08, 0.1, 0.08, c)];
const COIN = [B(0, 0, 0, 0.42, 0.42, 0.1, C.coin), B(0, 0, 0, 0.26, 0.26, 0.13, C.coin2)];
const logParts = len => [B(0, 0, 0, len, 0.32, 0.72, C.log), B(0, 0.02, 0, len - 0.3, 0.34, 0.5, 0x9a6533), B(-len / 2, 0, 0, 0.02, 0.24, 0.5, C.logEnd), B(len / 2, 0, 0, 0.02, 0.24, 0.5, C.logEnd)];
const BARN = [
  B(0, 0.6, 0, 1.8, 1.2, 1.5, C.barn), B(0, 1.05, 0.76, 1.2, 0.12, 0.03, C.white),
  B(-0.5, 1.46, 0, 1.16, 0.1, 1.72, C.roof, { rz: 0.62 }), B(0.5, 1.46, 0, 1.16, 0.1, 1.72, C.roof, { rz: -0.62 }), B(0, 1.72, 0, 0.18, 0.12, 1.74, C.roof),
  B(0, 0.4, 0.76, 0.6, 0.8, 0.03, 0x3a1f14), B(0, 0.4, 0.78, 0.06, 0.9, 0.02, C.white, { rz: 0.62 }), B(0, 0.4, 0.78, 0.06, 0.9, 0.02, C.white, { rz: -0.62 }),
  B(0.55, 0.8, 0.76, 0.22, 0.22, 0.02, 0x9fd8ff), B(-0.55, 0.8, 0.76, 0.22, 0.22, 0.02, 0x9fd8ff),
  B(1.5, 0.9, 0.3, 0.7, 1.8, 0.7, C.silo), B(1.5, 1.9, 0.3, 0.78, 0.2, 0.78, 0x8e969e), B(1.5, 2.05, 0.3, 0.5, 0.12, 0.5, 0x8e969e),
];
const fenceParts = () => { const p = []; for (let c = -7; c <= 7; c++) p.push(B(c, 0.28, 0, 0.12, 0.56, 0.12, C.fence)); p.push(B(0, 0.42, 0, 15, 0.07, 0.06, C.fence), B(0, 0.2, 0, 15, 0.07, 0.06, C.fence)); return p; };
const CLOUD = () => [B(0, 0, 0, 1.6, 0.5, 1.0, 0xffffff), B(-0.7, 0.15, 0.2, 1.0, 0.7, 0.8, 0xffffff), B(0.6, 0.2, -0.1, 1.1, 0.8, 0.9, 0xffffff), B(0.1, 0.35, 0.1, 0.8, 0.6, 0.7, 0xffffff)];
const SIGN = [B(0, 0.5, 0, 0.1, 1.0, 0.1, C.trunk), B(0, 1.05, 0, 0.5, 0.45, 0.08, 0xfff275), B(0, 1.05, 0.045, 0.34, 0.3, 0.02, C.black), B(0, 1.05, 0.06, 0.2, 0.2, 0.02, 0xfff275)];
const UFO = [B(0, 0, 0, 1.3, 0.14, 1.3, 0xb8c0cc), B(0, 0, 0, 1.3, 0.14, 1.3, 0xb8c0cc, { ry: PI / 4 }), B(0, 0.12, 0, 0.95, 0.16, 0.95, 0x9aa3b0, { ry: PI / 8 }), B(0, 0.3, 0, 0.5, 0.3, 0.5, 0x7fe3ff),
  B(0.5, -0.1, 0, 0.14, 0.06, 0.14, 0xffe45c), B(-0.5, -0.1, 0, 0.14, 0.06, 0.14, 0xffe45c), B(0, -0.1, 0.5, 0.14, 0.06, 0.14, 0xffe45c), B(0, -0.1, -0.5, 0.14, 0.06, 0.14, 0xffe45c)];

/* animals face +x, feet at y = 0 */
const W = C.white, K = C.black;
const ANIMAL_PARTS = {
  cow(v) { const body = v ? C.brownCow : W, patch = v ? 0x5a3622 : K; return [
    B(0, 0.55, 0, 0.95, 0.5, 0.5, body), B(-0.2, 0.6, 0.26, 0.3, 0.25, 0.02, patch), B(0.15, 0.5, -0.26, 0.28, 0.22, 0.02, patch), B(0.05, 0.81, 0, 0.3, 0.02, 0.3, patch),
    B(0.6, 0.62, 0, 0.35, 0.34, 0.34, body), B(0.8, 0.55, 0, 0.1, 0.16, 0.26, C.pink), B(0.55, 0.85, 0.14, 0.08, 0.1, 0.06, 0xe6d5b0), B(0.55, 0.85, -0.14, 0.08, 0.1, 0.06, 0xe6d5b0),
    B(0.5, 0.72, 0.22, 0.1, 0.06, 0.12, body), B(0.5, 0.72, -0.22, 0.1, 0.06, 0.12, body), B(0.78, 0.7, 0.12, 0.02, 0.06, 0.06, K), B(0.78, 0.7, -0.12, 0.02, 0.06, 0.06, K),
    B(0.33, 0.15, 0.17, 0.14, 0.3, 0.14, K), B(0.33, 0.15, -0.17, 0.14, 0.3, 0.14, K), B(-0.33, 0.15, 0.17, 0.14, 0.3, 0.14, K), B(-0.33, 0.15, -0.17, 0.14, 0.3, 0.14, K),
    B(0.05, 0.28, 0, 0.3, 0.1, 0.3, C.pink), B(-0.5, 0.6, 0, 0.06, 0.3, 0.06, patch)]; },
  pig() { const P = C.pink, D = C.dpink; return [
    B(0, 0.4, 0, 0.8, 0.42, 0.48, P), B(0.5, 0.45, 0, 0.3, 0.3, 0.3, P), B(0.68, 0.42, 0, 0.08, 0.14, 0.18, D), B(0.73, 0.42, 0.04, 0.02, 0.04, 0.03, K), B(0.73, 0.42, -0.04, 0.02, 0.04, 0.03, K),
    B(0.45, 0.63, 0.1, 0.1, 0.08, 0.06, D), B(0.45, 0.63, -0.1, 0.1, 0.08, 0.06, D), B(0.62, 0.52, 0.1, 0.02, 0.05, 0.05, K), B(0.62, 0.52, -0.1, 0.02, 0.05, 0.05, K),
    B(0.28, 0.1, 0.16, 0.12, 0.2, 0.12, D), B(0.28, 0.1, -0.16, 0.12, 0.2, 0.12, D), B(-0.28, 0.1, 0.16, 0.12, 0.2, 0.12, D), B(-0.28, 0.1, -0.16, 0.12, 0.2, 0.12, D),
    B(-0.42, 0.5, 0, 0.06, 0.1, 0.06, D), B(-0.45, 0.56, 0, 0.06, 0.06, 0.06, D)]; },
  chicken() { const O = C.orange; return [
    B(0, 0.3, 0, 0.36, 0.28, 0.3, W), B(0.2, 0.55, 0, 0.18, 0.2, 0.18, W), B(0.32, 0.53, 0, 0.08, 0.06, 0.06, O), B(0.2, 0.68, 0, 0.12, 0.08, 0.06, C.red), B(0.28, 0.45, 0, 0.04, 0.08, 0.05, C.red),
    B(0.27, 0.58, 0.07, 0.02, 0.04, 0.04, K), B(0.27, 0.58, -0.07, 0.02, 0.04, 0.04, K), B(0, 0.32, 0.16, 0.2, 0.14, 0.03, C.gray), B(0, 0.32, -0.16, 0.2, 0.14, 0.03, C.gray),
    B(-0.2, 0.42, 0, 0.1, 0.16, 0.14, W, { rz: 0.5 }), B(0.06, 0.08, 0.06, 0.04, 0.16, 0.04, O), B(0.06, 0.08, -0.06, 0.04, 0.16, 0.04, O)]; },
  sheep() { const S = C.wool; return [
    B(0, 0.45, 0, 0.8, 0.5, 0.55, S), B(-0.25, 0.7, 0.1, 0.25, 0.15, 0.25, S), B(0.15, 0.72, -0.12, 0.3, 0.14, 0.28, S), B(-0.05, 0.5, 0.3, 0.3, 0.3, 0.06, S),
    B(0.48, 0.5, 0, 0.3, 0.28, 0.28, K), B(0.42, 0.6, 0.17, 0.08, 0.06, 0.1, K), B(0.42, 0.6, -0.17, 0.08, 0.06, 0.1, K), B(0.62, 0.55, 0.09, 0.02, 0.05, 0.05, W), B(0.62, 0.55, -0.09, 0.02, 0.05, 0.05, W),
    B(0.26, 0.1, 0.17, 0.12, 0.2, 0.12, K), B(0.26, 0.1, -0.17, 0.12, 0.2, 0.12, K), B(-0.26, 0.1, 0.17, 0.12, 0.2, 0.12, K), B(-0.26, 0.1, -0.17, 0.12, 0.2, 0.12, K)]; },
  goose() { const O = C.orange; return [
    B(0, 0.32, 0, 0.6, 0.32, 0.36, W), B(0.24, 0.6, 0, 0.14, 0.36, 0.14, W), B(0.3, 0.82, 0, 0.22, 0.16, 0.16, W), B(0.45, 0.8, 0, 0.12, 0.06, 0.08, O),
    B(0.36, 0.86, 0.07, 0.02, 0.04, 0.04, K), B(0.36, 0.86, -0.07, 0.02, 0.04, 0.04, K), B(-0.32, 0.4, 0, 0.14, 0.08, 0.2, W), B(0, 0.36, 0.18, 0.3, 0.14, 0.03, C.gray), B(0, 0.36, -0.18, 0.3, 0.14, 0.03, C.gray),
    B(0.06, 0.08, 0.06, 0.05, 0.16, 0.05, O), B(0.06, 0.08, -0.06, 0.05, 0.16, 0.05, O), B(0.08, 0.01, 0.06, 0.12, 0.02, 0.1, O), B(0.08, 0.01, -0.06, 0.12, 0.02, 0.1, O)]; },
};
const ANIMALS = {
  cow: { half: 0.6, speed: [1.3, 1.9], group: [1, 3], bobA: 0.03, bobF: 6, sway: 0.03, variants: 2 },
  pig: { half: 0.45, speed: [2.0, 2.7], group: [2, 4], bobA: 0.05, bobF: 9, sway: 0.05, variants: 1 },
  sheep: { half: 0.45, speed: [2.2, 3.0], group: [2, 5], bobA: 0.06, bobF: 8, sway: 0.05, variants: 1 },
  chicken: { half: 0.26, speed: [3.0, 4.2], group: [2, 5], bobA: 0.12, bobF: 12, sway: 0.12, variants: 1 },
  goose: { half: 0.33, speed: [3.4, 4.6], group: [1, 3], bobA: 0.05, bobF: 10, sway: 0.1, variants: 1 },
};
const STAMPEDE = { half: 0.5, gap: 1.15, bobA: 0.12, bobF: 16, sway: 0.08 };

/* vehicles face -z, wheels on y = 0 */
function carParts(o) {
  const { len = 0.95, wid = 0.62, bodyY = 0.16, bodyH = 0.26, body, cabin, cabinLen = 0.42, cabinZ = 0.02, cabinH = 0.22, win = 0xbfe8ff, wheel = 0.28, wheelW = 0.14, wheelIn = 0.03, extras = [], lights = true } = o;
  const p = [], wr = wheel / 2;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) { p.push(B(sx * (wid / 2 - wheelW / 2 + wheelIn), wr, sz * (len / 2 - 0.2), wheelW, wheel, wheel, 0x24242a)); p.push(B(sx * (wid / 2 - wheelW / 2 + wheelIn + sx * 0.005), wr, sz * (len / 2 - 0.2), wheelW + 0.01, wheel * 0.45, wheel * 0.45, 0xa0a4ad)); }
  p.push(B(0, bodyY + bodyH / 2, 0, wid, bodyH, len, body));
  if (cabin !== null) { const cy = bodyY + bodyH; p.push(B(0, cy + cabinH / 2, cabinZ, wid - 0.1, cabinH, cabinLen, cabin ?? body)); p.push(B(0, cy + cabinH * 0.56, cabinZ, wid - 0.06, cabinH * 0.5, cabinLen + 0.03, win)); }
  if (lights) { p.push(B(-wid / 2 + 0.1, bodyY + bodyH * 0.65, -len / 2 - 0.005, 0.12, 0.08, 0.03, 0xfff3b0), B(wid / 2 - 0.1, bodyY + bodyH * 0.65, -len / 2 - 0.005, 0.12, 0.08, 0.03, 0xfff3b0));
    p.push(B(-wid / 2 + 0.1, bodyY + bodyH * 0.65, len / 2 + 0.005, 0.12, 0.06, 0.03, 0xff3b3b), B(wid / 2 - 0.1, bodyY + bodyH * 0.65, len / 2 + 0.005, 0.12, 0.06, 0.03, 0xff3b3b)); }
  return p.concat(extras);
}
const VEHICLES = [
  { id: 'hatch', name: 'Rusty Hatch', build: () => carParts({ body: 0xd2691e, cabin: 0xc45e17, extras: [B(-0.3, 0.25, -0.2, 0.03, 0.1, 0.2, 0x8b4513), B(0.31, 0.3, 0.22, 0.02, 0.08, 0.18, 0x8b4513), B(0.1, 0.43, -0.3, 0.15, 0.01, 0.12, 0x8b4513)] }) },
  { id: 'golf', name: 'Golf Cart', build: () => carParts({ len: 0.8, wid: 0.55, body: 0xf5f5f5, cabin: null, wheel: 0.2, bodyH: 0.2, extras: [B(0, 0.8, 0, 0.58, 0.05, 0.78, 0xf5f5f5), B(-0.24, 0.58, -0.3, 0.04, 0.42, 0.04, 0xd0d0d0), B(0.24, 0.58, -0.3, 0.04, 0.42, 0.04, 0xd0d0d0), B(-0.24, 0.58, 0.3, 0.04, 0.42, 0.04, 0xd0d0d0), B(0.24, 0.58, 0.3, 0.04, 0.42, 0.04, 0xd0d0d0), B(0, 0.42, 0.12, 0.45, 0.1, 0.3, 0x7a4a2a), B(0, 0.55, 0.26, 0.45, 0.22, 0.06, 0x7a4a2a), B(0, 0.5, -0.15, 0.16, 0.03, 0.16, 0x333333), B(0, 0.43, -0.15, 0.03, 0.12, 0.03, 0x333333)] }) },
  { id: 'pickup', name: 'Farm Pickup', build: () => carParts({ len: 1.05, body: 0x3d6fd1, cabin: 0x3d6fd1, cabinLen: 0.34, cabinZ: -0.13, extras: [B(-0.28, 0.5, 0.28, 0.06, 0.16, 0.44, 0x2f58a8), B(0.28, 0.5, 0.28, 0.06, 0.16, 0.44, 0x2f58a8), B(0, 0.5, 0.5, 0.62, 0.16, 0.05, 0x2f58a8), B(0, 0.5, 0.28, 0.36, 0.2, 0.3, C.hay), B(0, 0.5, 0.28, 0.38, 0.05, 0.32, C.hay2)] }) },
  { id: 'tractor', name: 'Old Tractor', build: () => [
    B(-0.3, 0.22, 0.22, 0.16, 0.44, 0.44, 0x24242a), B(0.3, 0.22, 0.22, 0.16, 0.44, 0.44, 0x24242a), B(-0.39, 0.22, 0.22, 0.02, 0.2, 0.2, 0xd9d9d9), B(0.39, 0.22, 0.22, 0.02, 0.2, 0.2, 0xd9d9d9),
    B(-0.24, 0.12, -0.32, 0.12, 0.24, 0.24, 0x24242a), B(0.24, 0.12, -0.32, 0.12, 0.24, 0.24, 0x24242a),
    B(0, 0.42, -0.18, 0.4, 0.3, 0.55, 0x2f9e44), B(0, 0.5, 0.18, 0.44, 0.2, 0.36, 0x2f9e44), B(0, 0.28, 0, 0.3, 0.14, 0.8, 0x333333),
    B(0, 0.66, 0.24, 0.26, 0.1, 0.2, 0x333333), B(0, 0.8, 0.24, 0.26, 0.2, 0.05, 0x333333), B(0, 0.66, 0.02, 0.2, 0.04, 0.03, 0x333333),
    B(0.12, 0.78, -0.3, 0.06, 0.4, 0.06, 0x333333), B(0, 0.6, -0.46, 0.36, 0.14, 0.03, 0xfff3b0),
    B(0, 1.02, 0.14, 0.52, 0.05, 0.56, 0xffb703), B(-0.22, 0.85, 0.38, 0.04, 0.32, 0.04, 0x333333), B(0.22, 0.85, 0.38, 0.04, 0.32, 0.04, 0x333333), B(-0.22, 0.85, -0.1, 0.04, 0.32, 0.04, 0x333333), B(0.22, 0.85, -0.1, 0.04, 0.32, 0.04, 0x333333)] },
  { id: 'taxi', name: 'Yellow Cab', build: () => carParts({ body: 0xf6c626, cabin: 0xf6c626, extras: [B(0, 0.72, 0, 0.26, 0.08, 0.14, 0x222222), B(-0.31, 0.3, 0, 0.01, 0.08, 0.7, 0x222222), B(0.31, 0.3, 0, 0.01, 0.08, 0.7, 0x222222)] }) },
  { id: 'cop', name: 'Sheriff Cruiser', build: () => carParts({ body: 0xf4f4f4, cabin: 0x2b2b2b, extras: [B(-0.09, 0.72, 0, 0.14, 0.07, 0.14, C.red), B(0.09, 0.72, 0, 0.14, 0.07, 0.14, 0x2f7de1), B(-0.31, 0.3, 0, 0.01, 0.1, 0.5, 0x222222), B(0.31, 0.3, 0, 0.01, 0.1, 0.5, 0x222222), B(0, 0.3, -0.48, 0.62, 0.1, 0.01, 0x222222)] }) },
  { id: 'icecream', name: 'Cone Van', build: () => carParts({ len: 1.0, wid: 0.66, bodyH: 0.42, body: 0xfff0c9, cabin: 0xfff0c9, cabinH: 0.22, cabinLen: 0.82, cabinZ: 0.04, extras: [B(0, 0.86, 0.04, 0.72, 0.06, 0.92, 0xf7a1c4), B(0, 1.0, 0.1, 0.14, 0.2, 0.14, 0xd2a06d), B(0, 1.15, 0.1, 0.22, 0.16, 0.22, 0xf7a1c4), B(0, 1.28, 0.1, 0.17, 0.12, 0.17, 0xfff0c9), B(-0.335, 0.35, 0, 0.01, 0.06, 0.9, 0xf7a1c4), B(0.335, 0.35, 0, 0.01, 0.06, 0.9, 0xf7a1c4), B(0.335, 0.5, 0.15, 0.01, 0.2, 0.4, 0xbfe8ff)] }) },
  { id: 'sports', name: 'Red Rocket', build: () => carParts({ len: 1.0, wid: 0.6, bodyH: 0.2, bodyY: 0.13, body: C.red, cabin: 0x2b2b2b, cabinH: 0.16, cabinLen: 0.4, cabinZ: 0.06, wheel: 0.24, extras: [B(0, 0.5, 0.46, 0.6, 0.04, 0.12, 0x2b2b2b), B(-0.2, 0.42, 0.46, 0.04, 0.12, 0.04, 0x2b2b2b), B(0.2, 0.42, 0.46, 0.04, 0.12, 0.04, 0x2b2b2b), B(0, 0.335, -0.22, 0.14, 0.005, 0.5, 0xffffff), B(0, 0.2, -0.5, 0.5, 0.06, 0.02, 0x2b2b2b)] }) },
  { id: 'ambulance', name: 'Farm Medic', build: () => carParts({ len: 1.05, wid: 0.66, bodyH: 0.44, body: 0xf8f8f8, cabin: null, extras: [B(0, 0.5, -0.3, 0.68, 0.14, 0.3, 0xbfe8ff), B(-0.335, 0.42, 0.15, 0.01, 0.22, 0.08, C.red), B(-0.335, 0.42, 0.15, 0.01, 0.08, 0.22, C.red), B(0.335, 0.42, 0.15, 0.01, 0.22, 0.08, C.red), B(0.335, 0.42, 0.15, 0.01, 0.08, 0.22, C.red), B(0, 0.64, -0.2, 0.3, 0.07, 0.1, C.red), B(0, 0.25, 0, 0.68, 0.06, 1.07, C.red), B(0, 0.64, 0.2, 0.4, 0.03, 0.4, 0xe0e0e0)] }) },
  { id: 'bus', name: 'School Bus', build: () => carParts({ len: 1.25, wid: 0.66, bodyH: 0.5, body: 0xffb703, cabin: null, extras: [B(0, 0.5, 0, 0.68, 0.16, 1.1, 0xbfe8ff), B(0, 0.68, 0, 0.6, 0.05, 1.2, 0xe0a000), B(0, 0.27, 0, 0.68, 0.05, 1.26, 0x222222), B(-0.36, 0.45, -0.1, 0.02, 0.12, 0.12, C.red), B(0, 0.55, -0.63, 0.5, 0.1, 0.02, 0xbfe8ff)] }) },
  { id: 'monster', name: 'Mud Monster', build: () => carParts({ bodyY: 0.42, bodyH: 0.24, body: 0x8338ec, cabin: 0x6a2bc9, wheel: 0.5, wheelW: 0.22, wheelIn: -0.06, extras: [B(-0.15, 0.3, -0.25, 0.06, 0.24, 0.06, 0x333333), B(0.15, 0.3, -0.25, 0.06, 0.24, 0.06, 0x333333), B(-0.15, 0.3, 0.25, 0.06, 0.24, 0.06, 0x333333), B(0.15, 0.3, 0.25, 0.06, 0.24, 0.06, 0x333333), B(0, 0.32, 0, 0.3, 0.08, 0.7, 0x333333), B(0, 0.55, -0.2, 0.2, 0.04, 0.3, 0xff9f1c), B(-0.28, 0.58, 0, 0.02, 0.08, 0.4, 0xff9f1c), B(0.28, 0.58, 0, 0.02, 0.08, 0.4, 0xff9f1c)] }) },
  { id: 'milk', name: 'Milk Tanker', build: () => carParts({ len: 1.15, wid: 0.64, bodyH: 0.2, body: 0x4a4a55, cabin: 0x3d6fd1, cabinH: 0.34, cabinLen: 0.34, cabinZ: -0.38, extras: [B(0, 0.58, 0.15, 0.58, 0.42, 0.7, 0xf4f4f4), B(0, 0.8, 0.15, 0.42, 0.08, 0.56, 0xdcdcdc), B(0, 0.86, 0.05, 0.14, 0.08, 0.14, 0x3d6fd1), B(0.3, 0.6, 0.25, 0.01, 0.14, 0.14, 0x222222), B(-0.3, 0.55, 0.05, 0.01, 0.12, 0.16, 0x222222), B(0, 0.8, 0.42, 0.3, 0.06, 0.02, 0x222222)] }) },
];
const vehicleById = id => VEHICLES.find(v => v.id === id) || VEHICLES[0];

/* ============================================================ copy */
const DEATHS = {
  cow: { title: 'Mooved down', jokes: ['Flattened by a cow. She did not even slow down.', 'A cow hit you. Insurance is calling it an act of cud.', 'Cow 1, car 0. The cow was not keeping score.'] },
  pig: { title: 'Hogged', jokes: ['Run over by a pig. Somehow this is your fault.', 'A pig got you. It felt nothing.', 'Trampled by bacon. Circle of life.'] },
  chicken: { title: 'Plucked', jokes: ['Hit by a chicken. It was crossing the road. Obviously.', 'Beaten by a chicken. Do not tell the pickup.', 'A chicken won. It will never let you forget it.'] },
  sheep: { title: 'Fleeced', jokes: ['Trampled by sheep. Counting them did not help.', 'Sheep. Fluffy outside, forklift inside.', 'Ewe should have waited.'] },
  goose: { title: 'Honked', jokes: ['A goose got you. A goose always gets you.', 'Ended by a goose. It is still angry about it.', 'The goose has no regrets. It has never had one.'] },
  stampede: { title: 'Stampeded', jokes: ['Sheep stampede. The sign was blinking for a reason.', 'Flattened by the flock. The lights were on. You were not.', 'Fourteen sheep. One car. Math happened.'] },
  sink: { title: 'Sunk', jokes: ['Sunk. Cars famously cannot swim.', 'Glug. That was not a log.', 'Straight into the river. Bold, but no.'] },
  drift: { title: 'Drifted', jokes: ['Floated off the map. Logs do not have a steering wheel.', 'Drifted away. Lovely log, terrible parking.', 'Off to sea. Send a postcard.'] },
  abduct: { title: 'Abducted', jokes: ['You idled. The UFO was not here for the cows after all.', 'Beamed up. Never park on a farm at night.', 'Abducted. The tagline said do not idle. It was not a suggestion.'] },
};
const deathCopy = car => DEATHS[car.cause === 'hit' ? car.kind : car.cause] || DEATHS.sink;

const HTML = `<canvas class="gl"></canvas>
<div class="hud">
  <div class="hud-top"><div class="score" data-score>0</div><div class="coins"><i class="coin-ico"></i><span data-coins>0</span></div></div>
  <div class="hud-mid"><div class="tag" data-count hidden></div><div class="warn" data-warn hidden>the UFO is watching</div><div class="spect" data-spect hidden></div><div class="hint-play" data-hint></div></div>
  <div class="hud-bot"><span data-role></span><span data-keys></span><button class="snd" data-snd type="button"></button></div>
</div>
<div class="overlay" data-overlay hidden><div class="card">
  <div class="pill" data-pill></div><h1 data-title></h1><p class="joke" data-joke></p>
  <div class="stats" data-stats></div><table class="standings" data-table hidden></table><div class="foot" data-foot></div>
</div></div>`;

/* ============================================================ sound - the original synth on the shell's shared AudioContext */
function createSfx(audio) {
  let noise = null, noiseCtx = null;
  const ctxOf = () => {
    const ctx = audio.ctx; if (!ctx || audio.muted) return null;
    if (noiseCtx !== ctx) { const n = Math.floor(ctx.sampleRate * 0.6), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; noise = b; noiseCtx = ctx; }
    return ctx;
  };
  const tone = ({ f = 440, f2 = null, t = 0.1, type = 'square', v = 0.2, delay = 0, attack = 0.005 }) => {
    const ctx = ctxOf(); if (!ctx) return; const now = ctx.currentTime + delay; const o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(f, now); if (f2) o.frequency.exponentialRampToValueAtTime(f2, now + t);
    g.gain.setValueAtTime(0.0001, now); g.gain.linearRampToValueAtTime(v, now + attack); g.gain.exponentialRampToValueAtTime(0.0001, now + t);
    o.connect(g); g.connect(audio.master); o.start(now); o.stop(now + t + 0.03);
  };
  const hiss = ({ t = 0.3, v = 0.3, f = 1200, f2 = 200, delay = 0, type = 'lowpass' }) => {
    const ctx = ctxOf(); if (!ctx) return; const now = ctx.currentTime + delay; const s = ctx.createBufferSource(); s.buffer = noise;
    const fl = ctx.createBiquadFilter(); fl.type = type; fl.frequency.setValueAtTime(f, now); fl.frequency.exponentialRampToValueAtTime(f2, now + t);
    const g = ctx.createGain(); g.gain.setValueAtTime(v, now); g.gain.exponentialRampToValueAtTime(0.0001, now + t);
    s.connect(fl); fl.connect(g); g.connect(audio.master); s.start(now); s.stop(now + t + 0.03);
  };
  return {
    hop() { tone({ f: 300, f2: 540, t: 0.08, type: 'square', v: 0.07 }); },
    bump() { tone({ f: 170, f2: 90, t: 0.1, type: 'square', v: 0.1 }); },
    coin() { tone({ f: 988, t: 0.07, type: 'sine', v: 0.18 }); tone({ f: 1319, t: 0.16, type: 'sine', v: 0.18, delay: 0.07 }); },
    crash() { hiss({ t: 0.35, v: 0.5, f: 1600, f2: 150 }); tone({ f: 130, f2: 40, t: 0.3, type: 'sawtooth', v: 0.25 }); },
    splash() { hiss({ t: 0.5, v: 0.4, f: 900, f2: 120 }); tone({ f: 420, f2: 70, t: 0.4, type: 'sine', v: 0.2 }); },
    ufo() { for (let i = 0; i < 6; i++) tone({ f: 520 + i * 80, f2: 640 + i * 80, t: 0.12, type: 'sawtooth', v: 0.045, delay: i * 0.1 }); },
    beam() { tone({ f: 900, f2: 180, t: 1.0, type: 'sawtooth', v: 0.12 }); tone({ f: 1200, f2: 300, t: 1.0, type: 'sine', v: 0.08 }); },
    click() { tone({ f: 700, t: 0.04, type: 'square', v: 0.05 }); },
    honk() { tone({ f: 440, t: 0.15, type: 'square', v: 0.11 }); tone({ f: 554, t: 0.24, type: 'square', v: 0.11, delay: 0.04 }); },
    count() { tone({ f: 660, t: 0.1, type: 'square', v: 0.08 }); },
    warn() { tone({ f: 660, t: 0.12, type: 'square', v: 0.07 }); tone({ f: 660, t: 0.12, type: 'square', v: 0.07, delay: 0.22 }); },
    moo() { tone({ f: 190, f2: 140, t: 0.45, type: 'sawtooth', v: 0.04 }); },
    cluck() { tone({ f: 900, f2: 1300, t: 0.05, type: 'square', v: 0.03 }); tone({ f: 800, f2: 1100, t: 0.05, type: 'square', v: 0.03, delay: 0.08 }); },
    drift() { tone({ f: 520, f2: 260, t: 0.6, type: 'triangle', v: 0.1 }); },
    fanfare() { [523, 659, 784, 1047].forEach((f, i) => tone({ f, t: 0.2, type: 'square', v: 0.11, delay: i * 0.09 })); },
  };
}

/* ============================================================ geometry: a list of boxes merged into one vertex-coloured mesh */
const UNIT = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
const UP = UNIT.attributes.position.array, UN = UNIT.attributes.normal.array;
const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _e = new THREE.Euler(), _s = new THREE.Vector3(), _p = new THREE.Vector3(), _nm = new THREE.Matrix3(), _v = new THREE.Vector3(), _c = new THREE.Color();
function buildGeo(parts) {
  const n = parts.length * 36, pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3); let k = 0;
  for (const b of parts) {
    _e.set(b.rx || 0, b.ry || 0, b.rz || 0); _q.setFromEuler(_e); _s.set(b.w, b.h, b.d); _p.set(b.x, b.y, b.z); _m.compose(_p, _q, _s); _nm.getNormalMatrix(_m); _c.set(b.c);
    for (let i = 0; i < 36; i++) {
      _v.set(UP[i * 3], UP[i * 3 + 1], UP[i * 3 + 2]).applyMatrix4(_m); pos[k] = _v.x; pos[k + 1] = _v.y; pos[k + 2] = _v.z;
      _v.set(UN[i * 3], UN[i * 3 + 1], UN[i * 3 + 2]).applyMatrix3(_nm).normalize(); nor[k] = _v.x; nor[k + 1] = _v.y; nor[k + 2] = _v.z;
      col[k] = _c.r; col[k + 1] = _c.g; col[k + 2] = _c.b; k += 3;
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere(); return g;
}
function groundParts(type, parity) {
  const p = [];
  if (type === 'grass') { for (let c = -GH; c <= GH; c++) { const out = Math.abs(c) > CH; p.push(B(c, -0.25, 0, 1, 0.5, 1, out ? (parity ? C.grassOutA : C.grassOutB) : (parity ? C.grassA : C.grassB))); } }
  else if (type === 'road') p.push(B(0, -0.25, 0, GW, 0.5, 1, C.road));
  else if (type === 'river') p.push(B(0, -0.4, 0, GW, 0.3, 1, C.water));
  else if (type === 'track') { p.push(B(0, -0.25, 0, GW, 0.5, 1, C.dirt)); for (let c = -GH; c <= GH; c += 2) { p.push(B(c, -0.005, 0.4, 0.8, 0.02, 0.1, C.dirtOut)); p.push(B(c + 1, -0.005, -0.4, 0.8, 0.02, 0.1, C.dirtOut)); } }
  return p;
}
const roadDashParts = () => { const p = []; for (let c = -GH; c <= GH; c++) p.push(B(c, 0.004, 0.5, 0.5, 0.02, 0.08, C.dash)); return p; };
/* which columns of this row can be reached from the reachable columns of the row before it */
function computeReach(prevReach, blocked) {
  const free = c => c >= -CH && c <= CH && !blocked.has(c), reach = new Set();
  for (const c of prevReach) { if (!free(c) || reach.has(c)) continue; for (let k = c; free(k) && !reach.has(k); k++) reach.add(k); for (let k = c - 1; free(k) && !reach.has(k); k--) reach.add(k); }
  return reach;
}

/* ============================================================ the game */
export async function create({ mount, audio, send, hooks }) {
  const unloadCss = await loadStylesheet('/games/crossy/crossy.css');
  const root = document.createElement('div'); root.className = 'cf'; root.innerHTML = HTML; mount.appendChild(root);
  const $ = sel => root.querySelector(sel);
  const dom = { score: $('[data-score]'), coins: $('[data-coins]'), count: $('[data-count]'), warn: $('[data-warn]'), spect: $('[data-spect]'), hint: $('[data-hint]'), role: $('[data-role]'), keys: $('[data-keys]'), snd: $('[data-snd]'),
    overlay: $('[data-overlay]'), pill: $('[data-pill]'), title: $('[data-title]'), joke: $('[data-joke]'), stats: $('[data-stats]'), table: $('[data-table]'), foot: $('[data-foot]') };
  const sfx = createSfx(audio);
  const isTouch = matchMedia('(pointer:coarse)').matches;
  const crand = (a, b) => a + Math.random() * (b - a); // cosmetic randomness only - never for anything the farm depends on
  const cpick = a => a[Math.floor(Math.random() * a.length)];
  const buzz = ms => { if (navigator.vibrate) { try { navigator.vibrate(ms); } catch {} } };

  /* ---- renderer / scene */
  const canvas = $('.gl');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFShadowMap;
  const scene = new THREE.Scene(); scene.background = new THREE.Color(SKY); scene.fog = new THREE.Fog(SKY, 50, 78);
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 200);
  const CAM_DIR = new THREE.Vector3(10, 13, 10).normalize(), CAM_DIST = 40;
  scene.add(new THREE.HemisphereLight(0xeaf6ff, 0x8fc45a, 1.5));
  const sun = new THREE.DirectionalLight(0xfff5e0, 2.7); sun.castShadow = true; sun.shadow.mapSize.set(isTouch ? 1024 : 2048, isTouch ? 1024 : 2048);
  Object.assign(sun.shadow.camera, { left: -20, right: 20, top: 20, bottom: -20, near: 1, far: 70 }); sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0005; sun.shadow.normalBias = 0.03; scene.add(sun); scene.add(sun.target);
  const SUN_OFF = new THREE.Vector3(-7, 15, 6);
  const MAT = new THREE.MeshLambertMaterial({ vertexColors: true });
  const geoCache = new Map();
  const cachedGeo = (key, fn) => { let g = geoCache.get(key); if (!g) { g = buildGeo(fn()); geoCache.set(key, g); } return g; };
  const meshOf = (geo, cast = true, recv = false) => { const m = new THREE.Mesh(geo, MAT); m.castShadow = cast; m.receiveShadow = recv; return m; };
  /* the model library is built with a fixed seed so the ten tree shapes are the same on every machine */
  const LIB = makeRng(4242);
  const TREES = Array.from({ length: 10 }, () => treeParts(LIB)), ROCKS = Array.from({ length: 4 }, () => rockParts(LIB)), FENCE = fenceParts();
  const animalGeo = (kind, v) => cachedGeo('an_' + kind + v, () => ANIMAL_PARTS[kind](v));
  const vehicleGeo = id => cachedGeo('veh_' + id, () => vehicleById(id).build());
  const LIGHT_GEO = new THREE.BoxGeometry(0.2, 0.2, 0.05);
  const LIGHT_OFF = new THREE.MeshLambertMaterial({ color: 0x6e1a1a }), LIGHT_ON = new THREE.MeshLambertMaterial({ color: 0xff2b2b, emissive: 0xff2b2b, emissiveIntensity: 0.9 });

  /* ============================================================ world: row specs (deterministic data) */
  const world = { seed: 0, R: makeRng(1), time: 0, specs: new Map(), nextRow: -6, section: null, meshes: new Map(), claimed: new Set() };
  const rand = (a, b) => world.R.rr(a, b), randi = (a, b) => Math.floor(rand(a, b + 1)), chance = p => world.R.rnd() < p, pick = a => a[Math.floor(world.R.rnd() * a.length)];
  function weightedPick(w) { let s = 0; for (const k in w) s += w[k]; let r = world.R.rnd() * s; for (const k in w) { r -= w[k]; if (r <= 0) return k; } return Object.keys(w)[0]; }
  const coinKey = (i, c) => i + ',' + c;

  function nextSection(i) {
    const prev = world.section ? world.section.type : 'grass', diff = clamp(i / 160, 0, 1);
    const w = { grass: 3, road: 5, river: 2.5 + diff, track: i > 14 ? 1.3 : 0 };
    if (prev === 'grass') w.grass = 0.5; if (prev === 'river') w.river *= 0.4; if (prev === 'track') w.track = 0;
    const type = weightedPick(w); let left = 1;
    if (type === 'grass') left = randi(1, 2); else if (type === 'road') left = randi(1, 2 + Math.round(diff * 3)); else if (type === 'river') left = randi(1, 1 + Math.round(diff * 2));
    return { type, left };
  }
  function specRow(i) {
    let type = 'grass';
    if (i > 2) { if (!world.section || world.section.left <= 0) world.section = nextSection(i); world.section.left--; type = world.section.type; }
    const spec = { i, type, blocked: new Set(), reach: allCols(), coins: new Set(), taken: new Set(), movers: [], parts: null, dir: 1, speed: 0, kind: null, half: 0, dashes: false, cycles: null, cR: null, cycleEnd: 0, cur: 0 };
    ({ grass: specGrass, road: specRoad, river: specRiver, track: specTrack })[type](spec, i);
    for (const c of spec.coins) if (world.claimed.has(coinKey(i, c))) spec.taken.add(c); // a claim that arrived before we built the row
    world.specs.set(i, spec); return spec;
  }
  function specGrass(spec, i) {
    const parity = i & 1, parts = groundParts('grass', parity), prev = world.specs.get(i - 1);
    for (let c = -GH; c <= GH; c++) { const a = Math.abs(c); if (a <= CH) continue; const pr = a <= CH + 2 ? 0.8 : (a <= CH + 5 ? 0.45 : 0.25); if (chance(pr)) addParts(parts, chance(0.9) ? pick(TREES) : pick(ROCKS), c, 0, 0); }
    if (i <= 2) {
      if (i === -6) { spec.blocked = allCols(); for (let c = -CH; c <= CH; c++) if (chance(0.85)) addParts(parts, pick(TREES), c, 0, 0); }
      if (i === -5) { spec.blocked = allCols(); addParts(parts, FENCE, 0, 0, 0); }
      if (i === -4 || i === -3) { spec.blocked = new Set([-6, -5, -4, -3]); if (i === -4) addParts(parts, BARN, -4.6, 0, -0.5); if (i === -3) { addParts(parts, HAY, 5, 0, 0); spec.blocked.add(5); } }
      if (i >= 1 && chance(0.6)) spec.coins.add(randi(-CH, CH));
      for (let c = -CH; c <= CH; c++) if (!spec.blocked.has(c) && !spec.coins.has(c) && chance(0.14)) addParts(parts, flowerParts(pick(C.flower)), c + rand(-0.3, 0.3), 0, rand(-0.3, 0.3));
      spec.reach = computeReach(i <= -4 ? allCols() : (prev ? prev.reach : allCols()), spec.blocked);
    } else {
      const density = 0.15 + clamp((i - 3) / 500, 0, 0.13), prevReach = prev ? prev.reach : allCols(); let best = null;
      for (let attempt = 0; attempt < 12; attempt++) {
        const blocked = new Set(); for (let c = -CH; c <= CH; c++) if (chance(density)) blocked.add(c);
        const reach = computeReach(prevReach, blocked);
        if (reach.size >= 3) { best = { blocked, reach }; break; }
        if (!best || reach.size > best.reach.size) best = { blocked, reach };
      }
      if (best.reach.size === 0) best = { blocked: new Set(), reach: computeReach(prevReach, new Set()) };
      spec.blocked = best.blocked; spec.reach = best.reach;
      for (const c of spec.blocked) { const r = world.R.rnd(); addParts(parts, r < 0.7 ? pick(TREES) : r < 0.85 ? pick(ROCKS) : r < 0.95 ? HAY : STUMP, c, 0, 0); }
      for (let c = -CH; c <= CH; c++) if (!spec.blocked.has(c)) { if (chance(0.11)) spec.coins.add(c); else if (chance(0.07)) addParts(parts, flowerParts(pick(C.flower)), c + rand(-0.3, 0.3), 0, rand(-0.3, 0.3)); }
    }
    spec.parts = parts;
  }
  function specRoad(spec, i) {
    const prev = world.specs.get(i - 1), diff = clamp(i / 200, 0, 1);
    spec.dashes = !!(prev && prev.type === 'road');
    spec.kind = weightedPick({ cow: 3, pig: 3, sheep: 2, chicken: 2.5, goose: 1.5 }); const a = ANIMALS[spec.kind]; spec.half = a.half;
    spec.dir = spec.dashes ? -prev.dir : (chance(0.5) ? 1 : -1); if (chance(0.25)) spec.dir *= -1;
    spec.speed = rand(a.speed[0], a.speed[1]) * (1 + diff * 0.7);
    let x = rand(0, 4); const maxX = LOOP - 3.5, gapMin = 3.2 - diff;
    while (x < maxX) {
      const g = randi(a.group[0], a.group[1]);
      for (let k = 0; k < g && x < maxX; k++) { spec.movers.push({ off: x, half: a.half, v: randi(0, a.variants - 1), phase: rand(0, 6) }); x += a.half * 2 + rand(0.35, 0.7); }
      x += rand(gapMin, gapMin + 4);
    }
  }
  function specRiver(spec, i) {
    const prev = world.specs.get(i - 1), diff = clamp(i / 200, 0, 1);
    spec.dir = (prev && prev.type === 'river') ? -prev.dir : (chance(0.5) ? 1 : -1);
    spec.speed = rand(1.0, 1.7) * (1 + diff * 0.6);
    let x = rand(0, 3);
    for (;;) {
      const len = pick(diff > 0.5 ? [2, 2, 3, 3, 4] : [2, 3, 3, 4, 4]); if (x + len > LOOP - 1.6) break;
      spec.movers.push({ off: x + len / 2, len, half: len / 2, phase: rand(0, 6) }); x += len + rand(1.4, 3.0) + diff * 0.6;
    }
  }
  /* a track's stampedes run on a schedule that is a pure function of the world clock (idle, 1.7 s of blinking
     lights, then a run until the last sheep is off the far side), generated lazily from the row's own rng */
  function specTrack(spec) { spec.cycles = []; spec.cR = makeRng(Math.floor(world.R.rnd() * 4294967296)); spec.cycleEnd = 0; spec.cur = 0; }
  function ensureCycles(spec, T) {
    while (!spec.cycles.length || spec.cycles[spec.cycles.length - 1].endAt <= T) {
      const R = spec.cR, first = !spec.cycles.length;
      const warnAt = spec.cycleEnd + (first ? R.rr(2.5, 7) : R.rr(4, 10)), runAt = warnAt + 1.7;
      const dir = R.rnd() < 0.5 ? 1 : -1, n = randiR(R, 8, 14), speed = R.rr(10, 13);
      const endAt = runAt + (2 * GH + 5 + (n - 1) * STAMPEDE.gap) / speed;
      spec.cycles.push({ warnAt, runAt, endAt, dir, n, speed, start: -dir * (GH + 2) }); spec.cycleEnd = endAt;
    }
  }
  function trackPhase(spec, T) {
    ensureCycles(spec, T); let k = spec.cur;
    while (k > 0 && spec.cycles[k - 1].endAt > T) k--;
    while (spec.cycles[k].endAt <= T) { k++; ensureCycles(spec, T); }
    spec.cur = k; const c = spec.cycles[k];
    return { cycle: c, phase: T < c.warnAt ? 'idle' : T < c.runAt ? 'warn' : 'run', t: T - c.runAt };
  }
  const sheepX = (c, k, t) => c.start - c.dir * k * STAMPEDE.gap + c.dir * c.speed * t;
  /* where things are right now - from the spec alone, so collisions never depend on a mesh existing */
  const moverX = (spec, m) => wrap(m.off + spec.dir * spec.speed * world.time);
  function laneHit(spec, x) { for (const m of spec.movers) if (Math.abs(moverX(spec, m) - x) < m.half + 0.3) return spec.kind; return null; }
  function stampedeHit(spec, x) { const p = trackPhase(spec, world.time); if (p.phase !== 'run') return false; for (let k = 0; k < p.cycle.n; k++) if (Math.abs(sheepX(p.cycle, k, p.t) - x) < STAMPEDE.half + 0.3) return true; return false; }
  function logAt(spec, x) { for (const m of spec.movers) if (Math.abs(moverX(spec, m) - x) <= m.half + 0.3) return m; return null; }

  function ensureSpecs(upTo) { while (world.nextRow <= upTo) specRow(world.nextRow++); }
  function dropSpecs(below) { for (const [i, s] of world.specs) if (i < below) { world.specs.delete(i); for (const c of s.taken) world.claimed.delete(coinKey(i, c)); } }
  function takeCoin(spec, c) {
    if (!spec.coins.has(c) || spec.taken.has(c)) return false;
    spec.taken.add(c); world.claimed.add(coinKey(spec.i, c));
    const rm = world.meshes.get(spec.i); if (rm) { const m = rm.coins.get(c); if (m) { rm.group.remove(m); rm.coins.delete(c); } }
    return true;
  }

  /* ============================================================ world: row meshes (only near the camera) */
  function buildRowMesh(spec) {
    const group = new THREE.Group(); group.position.z = -spec.i;
    const rm = { i: spec.i, spec, group, coins: new Map(), movers: [], lights: null, sheep: [], sheepCycle: null, phase: 'idle', owned: [] };
    if (spec.type === 'grass') {
      const geo = buildGeo(spec.parts); group.add(meshOf(geo, true, true)); rm.owned.push(geo);
      for (const c of spec.coins) if (!spec.taken.has(c)) { const m = meshOf(cachedGeo('coin', () => COIN), true, false); m.position.set(c, 0.36, 0); m.rotation.y = crand(0, 6); group.add(m); rm.coins.set(c, m); }
    } else if (spec.type === 'road') {
      group.add(meshOf(cachedGeo('road' + (spec.dashes ? 1 : 0), () => groundParts('road').concat(spec.dashes ? roadDashParts() : [])), false, true));
      const a = ANIMALS[spec.kind];
      for (const m of spec.movers) { const mesh = meshOf(animalGeo(spec.kind, m.v)); mesh.rotation.y = spec.dir > 0 ? 0 : PI; group.add(mesh); rm.movers.push({ m, mesh, baseY: 0, bobA: a.bobA, bobF: a.bobF, sway: a.sway }); }
    } else if (spec.type === 'river') {
      group.add(meshOf(cachedGeo('river', () => groundParts('river')), false, true));
      for (const m of spec.movers) { const mesh = meshOf(cachedGeo('log' + m.len, () => logParts(m.len)), true, false); group.add(mesh); rm.movers.push({ m, mesh, baseY: -0.1, bobA: 0.02, bobF: 1.5, sway: 0 }); }
    } else {
      group.add(meshOf(cachedGeo('track', () => { const p = groundParts('track'); addParts(p, SIGN, CH + 1.3, 0, -0.15); addParts(p, SIGN, -CH - 1.3, 0, -0.15); return p; }), true, true));
      rm.lights = [];
      for (const sx of [1, -1]) { const l = new THREE.Mesh(LIGHT_GEO, LIGHT_OFF); l.position.set(sx * (CH + 1.3), 1.05, -0.15 + 0.06); group.add(l); rm.lights.push(l); }
    }
    scene.add(group); world.meshes.set(spec.i, rm); return rm;
  }
  function removeRowMesh(rm) { scene.remove(rm.group); for (const g of rm.owned) g.dispose(); world.meshes.delete(rm.i); }
  function ensureMeshes(camRow) {
    const lo = camRow - BEHIND, hi = camRow + AHEAD;
    for (const rm of [...world.meshes.values()]) if (rm.i < lo || rm.i > hi) removeRowMesh(rm);
    for (let i = Math.max(lo, -6); i <= hi; i++) if (!world.meshes.has(i)) { const s = world.specs.get(i); if (s) buildRowMesh(s); }
  }
  function updateTrack(rm, dt) {
    const spec = rm.spec, p = trackPhase(spec, world.time), c = p.cycle;
    if (p.phase !== rm.phase) { if (p.phase === 'warn' && me && Math.abs(spec.i - me.row) < 10) sfx.warn(); rm.phase = p.phase; }
    const on = p.phase === 'run' || (p.phase === 'warn' && (Math.floor((world.time - c.warnAt) * 8) % 2) === 0);
    for (const l of rm.lights) l.material = on ? LIGHT_ON : LIGHT_OFF;
    if (p.phase === 'run') {
      if (rm.sheepCycle !== c) { for (const s of rm.sheep) rm.group.remove(s.mesh); rm.sheep = []; rm.sheepCycle = c;
        for (let k = 0; k < c.n; k++) { const mesh = meshOf(animalGeo('sheep', 0)); mesh.rotation.y = c.dir > 0 ? 0 : PI; rm.group.add(mesh); rm.sheep.push({ mesh, k, phase: crand(0, 6) }); } }
      for (const s of rm.sheep) { const x = sheepX(c, s.k, p.t), ph = world.time * STAMPEDE.bobF + s.phase; s.mesh.position.set(x, Math.abs(Math.sin(ph)) * STAMPEDE.bobA, 0); s.mesh.rotation.z = Math.sin(ph) * STAMPEDE.sway; s.mesh.visible = Math.abs(x) < GH + 1.5; }
    } else if (rm.sheep.length) { for (const s of rm.sheep) rm.group.remove(s.mesh); rm.sheep = []; rm.sheepCycle = null; }
  }
  function updateRowMeshes(dt) {
    for (const rm of world.meshes.values()) {
      const spec = rm.spec;
      for (const mv of rm.movers) {
        const x = moverX(spec, mv.m); mv.mesh.position.x = x; mv.mesh.visible = Math.abs(x) < GH + 1.5;
        if (mv.bobA) { const ph = world.time * mv.bobF + mv.m.phase; mv.mesh.position.y = mv.baseY + Math.abs(Math.sin(ph)) * mv.bobA; mv.mesh.rotation.z = Math.sin(ph) * mv.sway; }
      }
      if (spec.type === 'track') updateTrack(rm, dt);
      for (const [c, coin] of rm.coins) { coin.rotation.y += dt * 2.5; coin.position.y = 0.36 + Math.sin(world.time * 3 + c) * 0.05; }
    }
  }
  function resetWorld(seed) {
    for (const rm of [...world.meshes.values()]) removeRowMesh(rm);
    world.specs.clear(); world.claimed.clear(); world.seed = seed; world.R = makeRng(seed); world.time = 0; world.nextRow = -6; world.section = null;
  }

  /* clouds drift over the field */
  const clouds = [], CLOUD_MAT = new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, opacity: 0.78, depthWrite: false });
  for (let k = 0; k < 5; k++) { const m = new THREE.Mesh(cachedGeo('cloud' + k, CLOUD), CLOUD_MAT); const sc = crand(0.45, 0.8); m.scale.set(sc, sc * 0.6, sc); m.rotation.y = crand(0, 6); scene.add(m); clouds.push({ m, ox: crand(-16, 16), oz: crand(-22, 8), sp: crand(0.25, 0.6), y: crand(7, 9) }); }
  const updateClouds = dt => { for (const c of clouds) { c.ox += c.sp * dt; if (c.ox > 18) c.ox = -18; c.m.position.set(camTarget.x + c.ox, c.y, camTarget.z + c.oz); } };

  /* ============================================================ cars */
  let cars = [], me = null;
  let session = null, isHost = false, online = false, hostId = null, myId = null;
  let phase = 'count', phaseT = 0, overT = 0, cardT = 0, countStage = -1;
  const carOf = pid => cars.find(c => c.id === pid) || null;
  function makeLabel(text, color) {
    const cv = document.createElement('canvas'); cv.width = 256; cv.height = 64; const c = cv.getContext('2d');
    c.font = 'bold 34px Trebuchet MS, Arial'; c.textAlign = 'center'; c.textBaseline = 'middle';
    const w = Math.min(244, c.measureText(text).width + 30);
    c.fillStyle = 'rgba(59,36,19,.78)'; c.beginPath(); c.roundRect(128 - w / 2, 8, w, 48, 12); c.fill();
    c.strokeStyle = hex(color); c.lineWidth = 4; c.stroke(); c.fillStyle = '#fff3dc'; c.fillText(text, 128, 33);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false })); sp.scale.set(2.6, 0.65, 1); sp.renderOrder = 5; scene.add(sp); return sp;
  }
  function newCar(p, local) {
    const av = AVATARS[p.avatar] || AVATARS[0];
    const car = { id: p.id, name: p.name || av.name, avatar: p.avatar, color: av.color, vehicle: AVATAR_VEHICLE[(p.avatar | 0) % AVATAR_VEHICLE.length], local, left: false,
      x: 0, y: 0, row: 0, rowF: 0, maxRow: 0, facing: 0, state: 'playing', cause: null, kind: null, dieT: 0, coins: 0,
      hop: null, queued: null, riding: null, rideOff: 0, idle: 0, noProgress: 0, land: 1, bumpT: 1, bumpDir: [0, 0], hops: 0,
      buf: [], g: new THREE.Group(), label: null };
    car.g.add(meshOf(vehicleGeo(car.vehicle))); scene.add(car.g);
    if (!local) car.label = makeLabel(car.name, car.color);
    return car;
  }
  function removeCar(car) { scene.remove(car.g); if (car.label) { scene.remove(car.label); car.label.material.map.dispose(); car.label.material.dispose(); car.label = null; } }
  function clearCars() { for (const c of cars) removeCar(c); cars = []; me = null; }
  const facingFor = (dx, dz) => dz > 0 ? 0 : dz < 0 ? PI : dx > 0 ? -PI / 2 : PI / 2;

  /* ---- my car */
  function tryHop(dx, dz) {
    if (phase !== 'play' || !me || me.state !== 'playing') return;
    if (me.hop) { me.queued = [dx, dz]; return; }
    me.facing = facingFor(dx, dz);
    const fromX = me.x, fromRow = me.row, toCol = Math.round(fromX) + dx, toRow = fromRow + dz, spec = world.specs.get(toRow);
    const blocked = Math.abs(toCol) > CH || toRow < MIN_ROW || !spec || (spec.type === 'grass' && spec.blocked.has(toCol));
    if (blocked) { me.bumpT = 0; me.bumpDir = [dx, dz]; sfx.bump(); return; }
    me.hop = { fromX, fromRow, toX: toCol, toRow, t: 0 }; me.riding = null; me.idle = 0; me.hops++; sfx.hop();
    if (me.hops === 1) dom.hint.style.opacity = 0;
  }
  function land() {
    const h = me.hop; me.hop = null; me.row = h.toRow; me.rowF = h.toRow; me.x = h.toX; me.y = 0; me.land = 0;
    if (me.row > me.maxRow) { me.maxRow = me.row; me.noProgress = 0; }
    const spec = world.specs.get(me.row);
    if (spec.type === 'river') {
      const log = logAt(spec, me.x);
      if (log) { me.riding = { spec, m: log }; me.rideOff = me.x - moverX(spec, log); me.y = 0.06; } else { die('sink'); return; }
    } else if (spec.type === 'grass' && takeCoin(spec, me.x)) {
      me.coins++; sfx.coin(); burst(me.x, 0.4, -me.row, C.coin, 8, 2.5); buzz(15); send({ t: 'coin', i: spec.i, c: me.x });
    }
    if (me.queued) { const q = me.queued; me.queued = null; tryHop(q[0], q[1]); }
  }
  function deathFx(car, cause) {
    const px = car.x, pz = -car.rowF;
    if (cause === 'hit' || cause === 'stampede') { sfx.crash(); burst(px, 0.3, pz, 0x555555, 10, 3); burst(px, 0.3, pz, 0xffffff, 6, 2); }
    else if (cause === 'sink') { sfx.splash(); burst(px, 0, pz, 0x8fd3ff, 12, 2.5); burst(px, 0, pz, 0xffffff, 6, 2); }
    else if (cause === 'drift') sfx.drift();
    else if (cause === 'abduct') sfx.beam();
  }
  function die(cause, kind) {
    if (!me || me.state !== 'playing') return;
    me.state = 'dying'; me.cause = cause; me.kind = kind || null; me.dieT = 0; me.hop = null; me.queued = null;
    deathFx(me, cause);
    if (cause === 'hit' || cause === 'stampede') { shake = 0.6; buzz([60, 40, 80]); } else if (cause === 'abduct') buzz([30, 30, 30, 30, 30]); else buzz(40);
    if (cause !== 'abduct' && (ufoState === 'hover' || ufoState === 'enter')) ufoRetreat();
  }
  function updateMe(dt) {
    const p = me;
    if (p.state === 'playing') {
      if (phase === 'play') { p.idle += dt; p.noProgress += dt; }
      if (p.hop) { const h = p.hop; h.t += dt; const k = Math.min(1, h.t / HOP_DUR); p.x = lerp(h.fromX, h.toX, k); p.rowF = lerp(h.fromRow, h.toRow, k); p.y = Math.sin(k * PI) * HOP_H; if (k >= 1) land(); }
      else if (p.riding) { p.x = moverX(p.riding.spec, p.riding.m) + p.rideOff; if (Math.abs(p.x) > CH + 0.6) die('drift'); }
      if (p.state === 'playing') {
        const spec = world.specs.get(Math.round(p.rowF));
        if (spec && spec.type === 'road') { const kind = laneHit(spec, p.x); if (kind) die('hit', kind); }
        else if (spec && spec.type === 'track' && stampedeHit(spec, p.x)) die('stampede');
      }
      p.land = Math.min(1, p.land + dt / 0.16); p.bumpT = Math.min(1, p.bumpT + dt / 0.14);
      if (!p.hop && p.state === 'playing' && phase === 'play') { const d = heldDir(); if (d && holdT > HOLD_REPEAT) tryHop(d[0], d[1]); } // hold a key to keep hopping
    } else {
      p.dieT += dt;
      if (p.riding && p.cause === 'drift') p.x = moverX(p.riding.spec, p.riding.m) + p.rideOff;
      if (p.state === 'dying' && p.dieT > DIE_T) { p.state = 'dead'; onMyDeath(); }
    }
  }

  /* ---- the other cars: interpolated from their snapshots */
  function updateRemote(car, dt) {
    if (car.left) return;
    const latest = car.buf[car.buf.length - 1]; if (!latest) return;
    const s = sampleSnaps(car.buf, nowSec() - INTERP_DELAY);
    if (s) { const a = s.a, b = s.b; if (b) { car.x = lerp(a.x, b.x, s.f); car.rowF = lerp(a.z, b.z, s.f); car.y = lerp(a.y, b.y, s.f); } else { car.x = a.x; car.rowF = a.z; car.y = a.y; } car.facing = (b || a).f; }
    car.maxRow = Math.max(car.maxRow, latest.mr); car.coins = latest.co; car.row = latest.r;
    if (latest.st > 0 && car.state === 'playing') { car.state = 'dying'; car.dieT = 0; car.cause = latest.c || 'hit'; car.kind = latest.k || null; car.x = latest.x; car.rowF = latest.z; if (Math.abs(car.rowF - camRow()) < 12) deathFx(car, car.cause); }
    if (car.state !== 'playing') { car.dieT += dt; if (car.state === 'dying' && (latest.st === 2 || car.dieT > DIE_T + 1)) car.state = 'dead'; } // the owner declares the death; the timer is only a fallback
  }
  function updateCarVisual(car, dt) {
    const g = car.g; let y = car.y, sy = 1, sxz = 1, rx = 0, bx = 0, bz = 0;
    if (car.local) {
      if (car.hop) { const k = car.hop.t / HOP_DUR; sy = 1 + 0.18 * Math.sin(k * PI); sxz = 1 - 0.08 * Math.sin(k * PI); }
      else if (car.land < 1) { const s = Math.sin(car.land * PI); sy = 1 - 0.3 * s; sxz = 1 + 0.16 * s; }
      else if (car.state === 'playing') sy = 1 + 0.012 * Math.sin(world.time * 28);
      if (car.bumpT < 1) { const s = Math.sin(car.bumpT * PI); bx = car.bumpDir[0] * s * 0.18; bz = -car.bumpDir[1] * s * 0.18; sy = 1 - 0.12 * s; }
    } else if (car.state === 'playing') { const k = clamp(car.y / HOP_H, 0, 1); sy = 1 + 0.18 * k; sxz = 1 - 0.08 * k; }
    if (car.state !== 'playing') {
      const t = car.dieT, c = car.cause;
      if (c === 'hit' || c === 'stampede') { const k = Math.min(1, t / 0.25); sy = lerp(1, 0.15, k); sxz = lerp(1, 1.5, k); g.rotation.y += dt * (1 - k) * 10; }
      else if (c === 'sink') { const k = Math.min(1, t / 0.7); y = -k * 1.1; rx = k * 0.7; g.rotation.y += dt * 1.5; }
      else if (c === 'abduct') { const k = Math.min(1, t / 1.0); y = car.y + k * 3.0; g.rotation.y += dt * 9; sy = sxz = lerp(1, 0.25, k); }
      else if (c === 'drift') g.rotation.y += dt * 2;
      g.visible = !((c === 'abduct' && t > 1.3) || (c === 'sink' && t > 1.2));
    } else { g.visible = true; let d = car.facing - g.rotation.y; d = Math.atan2(Math.sin(d), Math.cos(d)); g.rotation.y += d * Math.min(1, dt * 18); }
    g.position.set(car.x + bx, y, -car.rowF + bz); g.scale.set(sxz, sy, sxz); g.rotation.x = rx;
    if (car.label) { car.label.visible = g.visible; car.label.position.set(car.x, 1.45 + Math.max(0, y), -car.rowF); }
  }
  const alive = () => cars.filter(c => !c.left && c.state !== 'dead');
  const standings = () => cars.filter(c => !c.left).sort((a, b) => b.maxRow - a.maxRow || b.coins - a.coins || String(a.id).localeCompare(String(b.id)));
  /* whose farm the camera shows: me while I am in it, then whoever is furthest along */
  let followId = null;
  function follow() { if (me && me.state !== 'dead') return me; const a = alive(); if (!a.length) return me; return a.reduce((p, c) => c.rowF > p.rowF ? c : p); }
  const camRow = () => Math.round(-camTarget.z);

  /* ============================================================ UFO (idle punishment, mine only) */
  const ufo = new THREE.Group(); scene.add(ufo); ufo.visible = false; ufo.add(meshOf(cachedGeo('ufo', () => UFO)));
  const beam = new THREE.Mesh(new THREE.BoxGeometry(0.9, 3.3, 0.9), new THREE.MeshBasicMaterial({ color: 0xc4ff7a, transparent: true, opacity: 0.35, depthWrite: false }));
  beam.position.y = -1.7; beam.visible = false; ufo.add(beam);
  let ufoState = 'hidden', ufoT = 0;
  function ufoSummon() { ufoState = 'enter'; ufoT = 0; ufo.visible = true; ufo.position.set(me.x + 3, 10, -me.rowF - 2); sfx.ufo(); dom.warn.hidden = false; }
  function ufoRetreat() { ufoState = 'leave'; ufoT = 0; beam.visible = false; dom.warn.hidden = true; }
  function ufoAbduct() { ufoState = 'beam'; ufoT = 0; beam.visible = true; dom.warn.hidden = true; die('abduct'); }
  function ufoReset() { ufoState = 'hidden'; ufo.visible = false; beam.visible = false; dom.warn.hidden = true; }
  function updateUfo(dt) {
    if (me && me.state === 'playing' && phase === 'play') {
      const behind = me.row < me.maxRow - 6, threat = me.idle > IDLE_WARN || me.noProgress > PROG_WARN || behind;
      if (threat && ufoState === 'hidden') ufoSummon();
      if (!threat && (ufoState === 'hover' || ufoState === 'enter')) ufoRetreat();
      if (ufoState === 'hover' && (me.idle > IDLE_LIMIT || me.noProgress > PROG_LIMIT || (behind && ufoT > 1.5))) ufoAbduct();
    } else if ((!me || me.state === 'playing') && (ufoState === 'hover' || ufoState === 'enter')) ufoRetreat();
    if (ufoState === 'hidden') return;
    ufoT += dt; ufo.rotation.y += dt * 2.2;
    const tx = me ? me.x : 0, tz = me ? -me.rowF : 0, k = 1 - Math.exp(-8 * dt);
    if (ufoState === 'enter') { ufo.position.x = lerp(ufo.position.x, tx, k); ufo.position.z = lerp(ufo.position.z, tz, k); ufo.position.y = lerp(ufo.position.y, UFO_Y, 1 - Math.exp(-6 * dt)); if (ufoT > 0.7) { ufoState = 'hover'; ufoT = 0; } }
    else if (ufoState === 'hover') { ufo.position.x = lerp(ufo.position.x, tx, k); ufo.position.z = lerp(ufo.position.z, tz, k); ufo.position.y = UFO_Y + Math.sin(ufoT * 4) * 0.15; }
    else if (ufoState === 'beam') { ufo.position.y = UFO_Y + Math.sin(ufoT * 12) * 0.05; beam.material.opacity = 0.3 + Math.sin(ufoT * 20) * 0.1; if (ufoT > 1.3) { ufoState = 'leave'; ufoT = 0; beam.visible = false; } }
    else if (ufoState === 'leave') { ufo.position.y += dt * (6 + ufoT * 10); ufo.position.x += dt * 4; if (ufoT > 1.2) ufoReset(); }
  }

  /* ============================================================ particles + camera */
  const particles = [], PGEO = new THREE.BoxGeometry(0.13, 0.13, 0.13), pmats = {};
  function burst(x, y, z, color, n, power) {
    const mat = pmats[color] || (pmats[color] = new THREE.MeshLambertMaterial({ color }));
    for (let i = 0; i < n; i++) { const m = new THREE.Mesh(PGEO, mat); m.position.set(x + crand(-0.2, 0.2), y, z + crand(-0.2, 0.2)); scene.add(m); particles.push({ m, vx: crand(-1, 1) * power, vy: crand(1, 2) * power, vz: crand(-1, 1) * power, life: crand(0.5, 0.9) }); }
  }
  function updateParticles(dt) {
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]; p.vy -= 12 * dt; p.m.position.x += p.vx * dt; p.m.position.y += p.vy * dt; p.m.position.z += p.vz * dt;
      if (p.m.position.y < 0.06) { p.m.position.y = 0.06; p.vy *= -0.4; p.vx *= 0.7; p.vz *= 0.7; }
      p.m.rotation.x += dt * 5; p.m.rotation.z += dt * 4; p.life -= dt; p.m.scale.setScalar(clamp(p.life * 2, 0.01, 1));
      if (p.life <= 0) { scene.remove(p.m); particles.splice(i, 1); }
    }
  }
  const clearParticles = () => { for (const p of particles) scene.remove(p.m); particles.length = 0; };
  const camTarget = new THREE.Vector3(0, 0, -1.5); let shake = 0;
  function updateCamera(dt) {
    const f = follow(); if (!f) return;
    const ahead = root.clientHeight > root.clientWidth ? 2.4 : 1.4;
    if (f.id !== followId) { followId = f.id; if (f !== me) { camTarget.x = f.x * 0.5; camTarget.z = -f.rowF - ahead; } } // snap when the camera changes cars
    const k = 1 - Math.exp(-5 * dt);
    camTarget.x = lerp(camTarget.x, f.x * 0.5, k); camTarget.z = lerp(camTarget.z, -f.rowF - ahead, k);
    shake = Math.max(0, shake - dt * 1.6);
    camera.position.copy(camTarget).addScaledVector(CAM_DIR, CAM_DIST); camera.lookAt(camTarget);
    if (shake > 0) { camera.position.x += crand(-1, 1) * shake * 0.3; camera.position.y += crand(-1, 1) * shake * 0.3; }
    sun.position.copy(camTarget).add(SUN_OFF); sun.target.position.copy(camTarget);
  }
  function resize() {
    const w = root.clientWidth || innerWidth, h = root.clientHeight || innerHeight; renderer.setSize(w, h, false); const aspect = w / h; let hw, hh;
    if (aspect >= 1) { hh = 7.2; hw = hh * aspect; } else { hw = 5.6; hh = hw / aspect; }
    camera.left = -hw; camera.right = hw; camera.top = hh; camera.bottom = -hh; camera.updateProjectionMatrix();
  }
  addEventListener('resize', resize);

  /* ============================================================ input */
  let holdT = 0;
  const DIRS = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
  const kb = createInput({ ArrowUp: 'up', KeyW: 'up', Space: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' }, {
    onDown: name => { holdT = 0; audio.init(); const d = DIRS[name]; if (d) tryHop(d[0], d[1]); },
    onKey: e => {
      if (e.code === 'KeyM') { audio.toggle(); setSnd(); }
      else if (e.code === 'KeyR') hooks.onRestart?.();
      else if (e.code === 'Escape') hooks.onExit?.();
    },
  });
  const held = kb.held;
  const heldDir = () => held.up ? DIRS.up : held.left ? DIRS.left : held.right ? DIRS.right : held.down ? DIRS.down : null;
  let pStart = null;
  const onPointerDown = e => { pStart = { x: e.clientX, y: e.clientY }; audio.init(); };
  const onPointerUp = e => {
    if (!pStart) return; const dx = e.clientX - pStart.x, dy = e.clientY - pStart.y; pStart = null;
    const ax = Math.abs(dx), ay = Math.abs(dy);
    if (Math.max(ax, ay) < 18) tryHop(0, 1); else if (ax > ay) tryHop(dx > 0 ? 1 : -1, 0); else tryHop(0, dy < 0 ? 1 : -1);
  };
  const onPointerCancel = () => { pStart = null; };
  canvas.addEventListener('pointerdown', onPointerDown); canvas.addEventListener('pointerup', onPointerUp); canvas.addEventListener('pointercancel', onPointerCancel);
  const setSnd = () => { dom.snd.textContent = audio.muted ? '🔇 sound off' : '🔊 sound on'; };
  dom.snd.addEventListener('click', () => { audio.toggle(); setSnd(); });

  /* ============================================================ networking glue */
  let netAcc = 0;
  function netTick(dt) {
    if (!online || !me) return; netAcc += dt; if (netAcc < 1 / (me.state === 'dead' ? NET_HZ_DEAD : NET_HZ)) return; netAcc = 0;
    const m = { t: 's', x: r2(me.x), z: r2(me.rowF), y: r2(me.y), f: r2(me.facing), st: me.state === 'playing' ? 0 : me.state === 'dying' ? 1 : 2, c: me.cause, k: me.kind, mr: me.maxRow, co: me.coins, r: me.row };
    if (isHost) m.tm = r3(world.time);
    send(m);
  }
  function syncClock(tm) { const d = tm - world.time; world.time += Math.abs(d) > 0.5 ? d : d * 0.2; }

  /* ============================================================ HUD + cards */
  const cache = {};
  const setText = (key, node, text) => { if (cache[key] !== text) { cache[key] = text; node.textContent = text; } };
  const bump = (el, cls, ms) => { el.classList.add(cls); setTimeout(() => el.classList.remove(cls), ms); };
  function syncHud() {
    if (!me) return;
    if (cache.score !== me.maxRow) { cache.score = me.maxRow; dom.score.textContent = me.maxRow; bump(dom.score, 'bump', 100); }
    if (cache.coins !== me.coins) { cache.coins = me.coins; dom.coins.textContent = me.coins; bump(dom.coins.parentElement, 'bump', 140); }
    const spect = online && me.state === 'dead' && phase === 'play' && dom.overlay.hidden;
    if (spect) { const f = follow(), n = alive().length; setText('spect', dom.spect, f && f !== me ? `SPECTATING ${f.name.toUpperCase()} · ${n} STILL DRIVING` : `${n} STILL DRIVING`); }
    dom.spect.hidden = !spect;
  }
  const statBox = (k, v) => `<div class="stat"><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div></div>`;
  function footButtons(again) {
    const f = dom.foot; f.innerHTML = '';
    const btn = (label, cls, fn) => { const b = document.createElement('button'); b.className = 'btn ' + cls; b.textContent = label; b.onclick = () => { sfx.click(); fn(); }; f.appendChild(b); };
    if (!online) { btn(`${again}  (R)`, 'primary', () => hooks.onRestart?.()); btn('MENU  (ESC)', '', () => hooks.onExit?.()); }
    else if (isHost) { btn(`${again}  (R)`, 'primary', () => hooks.onRestart?.()); btn('BACK TO LOBBY  (ESC)', '', () => hooks.onExit?.()); }
    else f.textContent = 'WAITING FOR THE HOST TO PLAY AGAIN OR RETURN TO THE LOBBY…';
  }
  /* my death, while the others are still driving: a short card, then spectate */
  function onMyDeath() {
    if (!online || !alive().length) return; // solo, or I was the last one: the round-over card covers it
    const d = deathCopy(me), rank = standings().indexOf(me) + 1;
    dom.pill.textContent = 'cause of death'; dom.pill.className = 'pill red'; dom.title.textContent = d.title; dom.title.className = ''; dom.joke.textContent = cpick(d.jokes);
    dom.stats.innerHTML = statBox('score', me.maxRow) + statBox('coins', me.coins) + statBox('place so far', '#' + rank);
    dom.table.hidden = true; dom.foot.textContent = `watching the others finish… (${alive().length} still driving)`;
    dom.overlay.hidden = false; cardT = 3.2;
  }
  function showResults() {
    const ranked = standings(), winner = ranked[0], mine = ranked.indexOf(me) + 1, d = me ? deathCopy(me) : null;
    if (online) { dom.pill.textContent = 'round over'; dom.pill.className = 'pill dark'; dom.title.textContent = winner === me ? 'You win!' : `${winner ? winner.name : '?'} wins!`; dom.title.className = 'win'; if (winner === me) sfx.fanfare(); }
    else { dom.pill.textContent = 'cause of death'; dom.pill.className = 'pill red'; dom.title.textContent = d ? d.title : 'Done'; dom.title.className = ''; }
    dom.joke.textContent = d ? cpick(d.jokes) : '';
    dom.stats.innerHTML = statBox('score', me ? me.maxRow : 0) + statBox('coins', me ? me.coins : 0) + (online ? statBox('place', `${ordinal(mine)} of ${ranked.length}`) : statBox('hops', me ? me.hops : 0));
    if (online) {
      dom.table.innerHTML = ranked.map((c, i) => `<tr class="${i === 0 ? 'top' : ''}${c === me ? ' me' : ''}"><td>#${i + 1}</td><td><span class="sw" style="background:${hex(c.color)}"></span>${esc(c.name)}${c === me ? ' (you)' : ''}</td><td>${esc(vehicleById(c.vehicle).name)}</td><td class="s">${c.maxRow}</td><td>${c.coins} <i class="coin-ico"></i></td></tr>`).join('');
      dom.table.hidden = false;
    } else dom.table.hidden = true;
    footButtons('DRIVE AGAIN'); dom.overlay.hidden = false; cardT = 0;
    const card = dom.overlay.firstElementChild; card.style.animation = 'none'; void card.offsetWidth; card.style.animation = ''; // replay the pop
  }
  function updatePhase(dt) {
    phaseT += dt;
    if (phase === 'count') {
      const stage = Math.min(3, Math.floor(phaseT / (COUNT_T / 3)));
      if (stage !== countStage) { countStage = stage; dom.count.hidden = false; if (stage < 3) { dom.count.textContent = String(3 - stage); sfx.count(); } else { dom.count.textContent = 'GO!'; sfx.honk(); phase = 'play'; phaseT = 0; if (me) { me.idle = 0; me.noProgress = 0; } } }
    } else if (phase === 'play') {
      if (phaseT > 0.7 && !dom.count.hidden) dom.count.hidden = true;
      if (cardT > 0) { cardT -= dt; if (cardT <= 0) dom.overlay.hidden = true; }
      if (!alive().length) { phase = 'over'; phaseT = 0; overT = 0; }
    } else if (phase === 'over') {
      if (!cache.results && phaseT > 0.6) { cache.results = true; showResults(); }
    }
  }

  /* ============================================================ main loop */
  let mooT = 4;
  function ambient() { if (!me) return; const r = world.specs.get(me.row + 1 + Math.floor(Math.random() * 6)); if (!r || r.type !== 'road') return; if (r.kind === 'cow') sfx.moo(); else if (r.kind === 'chicken') sfx.cluck(); }
  const loop = createLoop(real => {
    if (!session) return;
    const dt = Math.min(0.05, real); world.time += dt;
    if (heldDir()) holdT += dt;
    updatePhase(dt);
    /* specs cover every row the room spans; meshes only the rows this camera can see */
    let maxRow = me ? me.maxRow : 0, minRow = me ? me.row : 0;
    for (const c of cars) if (!c.left) { maxRow = Math.max(maxRow, c.maxRow, c.row); if (c.state !== 'dead' || c === me) minRow = Math.min(minRow, c.row); }
    ensureSpecs(Math.max(maxRow, camRow()) + AHEAD + 2); dropSpecs(minRow - BEHIND - 2);
    if (me) updateMe(dt);
    for (const c of cars) if (!c.local) updateRemote(c, dt);
    updateRowMeshes(dt); updateUfo(dt); updateParticles(dt); updateCamera(dt); updateClouds(dt);
    ensureMeshes(Math.round(follow() ? follow().rowF : 0));
    for (const c of cars) if (!c.left) updateCarVisual(c, dt);
    netTick(dt);
    mooT -= dt; if (mooT <= 0) { mooT = crand(4, 9); ambient(); }
    renderer.render(scene, camera); syncHud();
  });

  /* ============================================================ session API */
  function start(s) {
    session = s; isHost = !!s.isHost; online = !!s.online; hostId = s.hostId; myId = s.myId;
    resetWorld((s.seed >>> 0) || 1337); clearCars(); clearParticles(); ufoReset(); shake = 0;
    const players = [...s.players].sort((a, b) => String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
    for (const p of players) cars.push(newCar(p, p.id === myId));
    me = cars.find(c => c.local) || null;
    phase = 'count'; phaseT = 0; overT = 0; cardT = 0; countStage = -1; followId = null; netAcc = 0; holdT = 0; mooT = 4;
    for (const k of Object.keys(cache)) delete cache[k];
    camTarget.set(0, 0, -1.5); ensureSpecs(AHEAD + 2); ensureMeshes(0);
    dom.score.textContent = '0'; dom.coins.textContent = '0'; dom.overlay.hidden = true; dom.spect.hidden = true; dom.warn.hidden = true; dom.count.hidden = true;
    dom.hint.textContent = isTouch ? 'tap or swipe to hop' : '↑ / W / space to hop · arrows to steer'; dom.hint.style.opacity = 1;
    dom.keys.innerHTML = !online ? '<kbd>R</kbd> restart <kbd>Esc</kbd> menu <kbd>M</kbd> sound' : isHost ? '<kbd>R</kbd> again <kbd>Esc</kbd> lobby <kbd>M</kbd> sound' : '<kbd>M</kbd> sound';
    dom.role.textContent = !online ? 'solo' : isHost ? 'hosting' : `${s.players.length} players`;
    setSnd(); audio.init(); kb.attach(); resize(); loop.start();
  }
  function stop() {
    session = null; kb.detach(); loop.stop(); pStart = null;
    clearCars(); clearParticles(); ufoReset(); resetWorld(0); dom.overlay.hidden = true; dom.spect.hidden = true; dom.count.hidden = true;
  }
  function destroy() {
    stop(); removeEventListener('resize', resize);
    canvas.removeEventListener('pointerdown', onPointerDown); canvas.removeEventListener('pointerup', onPointerUp); canvas.removeEventListener('pointercancel', onPointerCancel);
    for (const g of geoCache.values()) g.dispose(); geoCache.clear();
    MAT.dispose(); CLOUD_MAT.dispose(); LIGHT_GEO.dispose(); LIGHT_OFF.dispose(); LIGHT_ON.dispose(); PGEO.dispose(); for (const m of Object.values(pmats)) m.dispose(); beam.geometry.dispose(); beam.material.dispose();
    renderer.dispose(); renderer.forceContextLoss?.(); root.remove(); mount.innerHTML = ''; unloadCss();
    if (window.__crossy === debug) delete window.__crossy;
  }
  function playerLeft(pid) { const c = carOf(pid); if (!c || c.local) return; c.left = true; c.g.visible = false; if (c.label) c.label.visible = false; }
  function onNetMessage(msg) {
    if (!session) return;
    switch (msg.t) {
      case 's': {
        const car = carOf(msg.from); if (!car || car.local) break;
        pushSnap(car.buf, { x: +msg.x || 0, z: +msg.z || 0, y: +msg.y || 0, f: +msg.f || 0, st: msg.st | 0, c: typeof msg.c === 'string' ? msg.c : null, k: typeof msg.k === 'string' ? msg.k : null, mr: msg.mr | 0, co: msg.co | 0, r: msg.r | 0 });
        if (!isHost && msg.from === hostId && typeof msg.tm === 'number') syncClock(msg.tm);
        break;
      }
      case 'coin': { const i = msg.i | 0, c = msg.c | 0; world.claimed.add(coinKey(i, c)); const spec = world.specs.get(i); if (spec) takeCoin(spec, c); break; }
    }
  }
  const debug = { world, get cars() { return cars; }, get me() { return me; }, get phase() { return phase; }, get phaseT() { return phaseT; }, get ufo() { return ufoState; }, get session() { return session; }, trackPhase, moverX };
  window.__crossy = debug;
  return { start, stop, destroy, onNetMessage, playerLeft, debug };
}
