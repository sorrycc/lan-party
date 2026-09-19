/* The street race: a course of checkpoints drawn from the round's seed, so every machine lays out the same one and it
   never travels over the network (like the city). Pure functions over the road graph, testable in node.

   The course is a loop of intersections: index 0 is the start / finish line at the top of Ender Ave, where the grid
   forms, and the rest are spread around the city at least a few blocks apart, visited in the order they sit around
   their centre so the loop does not cross itself much. A lap is every checkpoint in order and back through the line.

   The lap is planned once (planLap): every leg is the shortest road path that never reverses at an intersection and
   prefers to go straight, leaves each checkpoint the way the previous leg arrived, and comes back across the line
   heading +z, the way the grid faces, so the three laps drive the same roads. The sat-nav (raceRoute + raceGuide) shows
   the rest of the current leg and the whole of the next one, so the way out of a checkpoint is on the road and on the
   HUD before the checkpoint is reached; a driver who has left the route is planned back onto it from the intersection
   ahead of the bonnet, so the instruction is never a U-turn inside the city. */
import { makeRng } from '../../core/math.js';
import { X, NB, HALF, PITCH, streetAt, streetRef } from './world.js';

export const LAPS = 3, CHECKPOINTS = 6; // LAPS is the default; the lobby's RACE LAPS option overrides it (lapsOf in sim.js)
export const START_NODE = [3, 8]; // the intersection the grid faces (Ender Ave, heading +z)
export const CP_RADIUS = 9;        // within this of an intersection's centre counts as through it
const MIN_GAP = 3;                 // blocks between any two checkpoints (Manhattan), and from the start
const HAIRPIN = -0.3;              // the cosine between consecutive legs below which a course is a hairpin and is drawn again

/* the four ways out of an intersection, indexed so that d ^ 1 is the way back */
export const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
export const DIR_PZ = 2;
export const dirOf = (hx, hz) => Math.abs(hx) >= Math.abs(hz) ? (hx >= 0 ? 0 : 1) : (hz >= 0 ? 2 : 3);
const TURN_COST = 0.35;

/* the checkpoints as road nodes [i, j]; index 0 is the start / finish */
export function raceCourse(seed = 1, n = CHECKPOINTS) {
  const { rnd } = makeRng((seed >>> 0) * 2654435761 + 97);
  const far = (a, b, gap) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) >= gap;
  let best = null;
  for (let attempt = 0; attempt < 60; attempt++) {
    let picked = [];
    for (let gap = MIN_GAP; gap >= 1 && picked.length < n; gap--) { // relax the spacing only if the city runs out of room
      picked = [];
      for (let tries = 0; tries < 400 && picked.length < n; tries++) {
        const p = [1 + Math.floor(rnd() * (NB - 1)), 1 + Math.floor(rnd() * (NB - 1))]; // inner intersections only, never the rim
        if (!far(p, START_NODE, gap) || picked.some(q => !far(p, q, gap))) continue;
        picked.push(p);
      }
    }
    // visit them around their centre, and run the loop the way that keeps the first checkpoint ahead of the grid (+z)
    const cx = picked.reduce((s, p) => s + p[0], START_NODE[0]) / (picked.length + 1), cz = picked.reduce((s, p) => s + p[1], START_NODE[1]) / (picked.length + 1);
    const ang = p => Math.atan2(p[1] - cz, p[0] - cx);
    const all = [START_NODE, ...picked].sort((a, b) => ang(a) - ang(b));
    const k = all.findIndex(p => p === START_NODE); const loop = [...all.slice(k), ...all.slice(0, k)];
    const rev = [loop[0], ...loop.slice(1).reverse()];
    const course = rev[1][1] > loop[1][1] ? rev : loop;
    const h = hairpins(course);
    if (!best || h < best.h) best = { course, h };
    if (h === 0) break;
  }
  return best.course;
}
/* how many consecutive legs of a course double back (the line's leg in counts against the way the grid leaves it, +z) */
export function hairpins(course) {
  const n = course.length; let bad = 0;
  for (let k = 0; k < n; k++) {
    const a = course[(k + n - 1) % n], b = course[k], c = course[(k + 1) % n];
    let ax = b[0] - a[0], az = b[1] - a[1]; const bx = c[0] - b[0], bz = c[1] - b[1];
    if (k === 0) { ax = 0; az = 1; } // the line is always left heading +z
    const dot = (ax * bx + az * bz) / ((Math.hypot(ax, az) || 1) * (Math.hypot(bx, bz) || 1));
    if (dot < HAIRPIN) bad++;
  }
  return bad;
}

/* the shortest road path from one intersection to another that never reverses at an intersection and prefers to go
   straight: from `from`, having arrived there heading DIRS[fromDir] (-1: any way), to `to`, arriving heading DIRS[toDir]
   (-1: any way). `to` is only ever entered as the last node, so a leg never crosses its own checkpoint early. Returns
   the nodes from `from` to `to` inclusive (a path that has to come round a block may visit `from` again). */
export function planPath(from, fromDir, to, toDir = -1) {
  const N = NB + 1, key = (i, j, d) => (j * N + i) * 4 + d, cost = new Float64Array(N * N * 4).fill(Infinity), prev = new Int32Array(N * N * 4).fill(-1), done = new Uint8Array(N * N * 4);
  const open = [];
  for (let d = 0; d < 4; d++) if (fromDir < 0 || d === fromDir) { const k = key(from[0], from[1], d); cost[k] = 0; open.push(k); }
  let goal = -1;
  while (open.length) {
    let bi = 0; for (let k = 1; k < open.length; k++) if (cost[open[k]] < cost[open[bi]]) bi = k;
    const k = open[bi]; open[bi] = open[open.length - 1]; open.pop(); if (done[k]) continue; done[k] = 1;
    const d = k % 4, n = (k - d) / 4, i = n % N, j = (n - i) / N;
    if (i === to[0] && j === to[1] && (toDir < 0 || d === toDir)) { goal = k; break; } // (the start itself, when it is already there facing the right way)
    for (let nd = 0; nd < 4; nd++) { if (nd === (d ^ 1)) continue; // no reversing
      const ni = i + DIRS[nd][0], nj = j + DIRS[nd][1]; if (ni < 0 || ni > NB || nj < 0 || nj > NB) continue;
      if (ni === to[0] && nj === to[1] && toDir >= 0 && nd !== toDir) continue; // the goal is only entered the right way
      const nk = key(ni, nj, nd), c = cost[k] + 1 + (nd === d ? 0 : TURN_COST);
      if (c < cost[nk]) { cost[nk] = c; prev[nk] = k; if (!done[nk]) open.push(nk); } }
  }
  if (goal < 0) return [from, to];
  const out = []; for (let k = goal; k >= 0; k = prev[k]) { const d = k % 4, n = (k - d) / 4, i = n % N; out.push([i, (n - i) / N]); }
  return out.reverse();
}
/* the direction of the last move of a path (DIRS index), or `fallback` for a path of one node */
export const exitDir = (path, fallback = DIR_PZ) => { if (path.length < 2) return fallback; const a = path[path.length - 2], b = path[path.length - 1]; return dirOf(b[0] - a[0], b[1] - a[1]); };
/* the whole lap: legs[k] runs from course[k] to course[k + 1] (the last back to the line, arriving +z), each leaving its
   checkpoint the way the previous leg arrived, so nothing ever reverses, not even through a checkpoint */
export function planLap(course) {
  const n = course.length, legs = []; let dir = DIR_PZ;
  for (let k = 0; k < n; k++) { const to = course[(k + 1) % n], leg = planPath(course[k], dir, to, (k + 1) % n === 0 ? DIR_PZ : -1); legs.push(leg); dir = exitDir(leg, dir); }
  return legs;
}

/* world coordinates of a course node */
export const nodeXZ = node => ({ x: X(node[0]), z: X(node[1]) });
const sameNode = (a, b) => a[0] === b[0] && a[1] === b[1];
/* the intersection a car at (x, z) heading (hx, hz) reaches next (the one it is at, when it is at one) */
export function nodeAhead(x, z, hx, hz) {
  const kx = (x + HALF) / PITCH, kz = (z + HALF) / PITCH, clampN = v => Math.max(0, Math.min(NB, v));
  if (Math.abs(hx) >= Math.abs(hz)) return [clampN(hx >= 0 ? Math.ceil(kx - 0.04) : Math.floor(kx + 0.04)), clampN(Math.round(kz))];
  return [clampN(Math.round(kx)), clampN(hz >= 0 ? Math.ceil(kz - 0.04) : Math.floor(kz + 0.04))];
}

/* The route to show a racer heading for checkpoint `next` from (x, z) along (hx, hz): the rest of the planned leg from the
   intersection ahead, then the whole next leg. Off the planned roads (or driving them backwards) the driver is planned
   back to the checkpoint from the intersection ahead, arriving the planned way, so the next leg still follows. Returns
   { nodes, cp } with cp the index in `nodes` of the checkpoint (-1 when the route does not reach it). */
export function raceRoute(course, legs, next, x, z, hx, hz) {
  const n = course.length, leg = legs[(next + n - 1) % n], after = legs[next], at = nodeAhead(x, z, hx, hz), d = dirOf(hx, hz);
  let head = null;
  const p = leg.findIndex(q => sameNode(q, at));
  if (p >= 0 && p < leg.length - 1) { const q = leg[p + 1]; if (dirOf(q[0] - at[0], q[1] - at[1]) !== (d ^ 1)) head = leg.slice(p); }
  if (!head && p === leg.length - 1 && exitDir(leg) !== (d ^ 1)) head = [leg[p]];
  if (!head) head = planPath(at, d, course[next], exitDir(leg));
  const cp = head.length - 1;
  return { nodes: head.concat(after.slice(1)), cp };
}

/* how far along the race a player is, in checkpoints, for the standings: laps done, checkpoints passed this lap, and
   the fraction of the leg to the next one. `next` is the index the player is heading for (0 = the line). */
export function progressOf(course, lap, next, x, z) {
  const n = course.length, passed = lap * n + (next === 0 ? n - 1 : next - 1);
  const prev = course[(next + n - 1) % n], to = course[next], a = nodeXZ(prev), b = nodeXZ(to);
  const leg = Math.hypot(b.x - a.x, b.z - a.z) || 1, left = Math.hypot(b.x - x, b.z - z);
  return passed + Math.max(0, Math.min(1, 1 - left / leg));
}

/* where the grid forms: two columns astride the centre line of Ender Ave below the start intersection, all facing it */
export function gridSlot(i) {
  const col = i % 2, row = Math.floor(i / 2), s = nodeXZ(START_NODE);
  return { x: s.x + (col ? 2.9 : -2.9), z: s.z - 14 - row * 7.5, yaw: 0 };
}

export const ordinal = n => n + (n % 100 >= 11 && n % 100 <= 13 ? 'TH' : n % 10 === 1 ? 'ST' : n % 10 === 2 ? 'ND' : n % 10 === 3 ? 'RD' : 'TH');

/* The sat-nav for a route of road nodes, for a driver at (mx, mz) heading along the unit vector (hx, hz): the arrows to
   lay on the road ahead (breadcrumbs down each leg and a bigger one at each intersection pointing the way out) and the
   next instruction. `cpAt` is the index in `route` of the checkpoint, when the route runs through one.
   Returns { arrows, turn, cp }: arrows is [{ x, z, yaw, big }]; turn is null or { kind, d, street }, kind 'LEFT' |
   'RIGHT' | 'U-TURN' at the first intersection that is not straight through (a checkpoint included), d metres away,
   onto `street` (English; `ref` is its streetRef, for the HUD's language), or 'ARRIVE' when the end of the route is straight ahead; cp is null or { d } for the checkpoint ahead. */
export function raceGuide(route, mx, mz, hx, hz, legs = 4, step = 14, cpAt = -1) {
  const pts = route.map(([i, j]) => ({ x: X(i), z: X(j) }));
  const ahead = (x, z, slack) => (x - mx) * hx + (z - mz) * hz > slack;
  const arrows = []; let turn = null, cp = null;
  let k0 = 0; while (k0 < pts.length && !ahead(pts[k0].x, pts[k0].z, -3)) k0++;
  if (!pts.length) return { arrows, turn, cp };
  if (k0 >= pts.length) { const p = pts[pts.length - 1]; return { arrows, turn: { kind: 'U-TURN', d: Math.hypot(p.x - mx, p.z - mz), street: streetAt(p.x, p.z), ref: streetRef(p.x, p.z) }, cp }; }
  if (cpAt >= k0 && cpAt < pts.length) cp = { d: Math.hypot(pts[cpAt].x - mx, pts[cpAt].z - mz) };
  let prev = k0 > 0 ? pts[k0 - 1] : null;
  for (let k = k0, n = 0; k < pts.length && n < legs; k++, n++) {
    const to = pts[k];
    if (prev) { const dx = to.x - prev.x, dz = to.z - prev.z, len = Math.hypot(dx, dz) || 1, ux = dx / len, uz = dz / len, yaw = Math.atan2(ux, uz);
      for (let d = step; d < len - 8; d += step) { const x = prev.x + ux * d, z = prev.z + uz * d; if (ahead(x, z, 2)) arrows.push({ x, z, yaw, big: false }); } }
    const nxt = pts[k + 1];
    if (nxt) arrows.push({ x: to.x, z: to.z, yaw: Math.atan2(nxt.x - to.x, nxt.z - to.z), big: true });
    prev = to;
  }
  let ix = hx, iz = hz; // the direction we arrive at each intersection from: the heading for the first, the leg before it after that
  for (let k = k0; k < pts.length; k++) {
    const p = pts[k];
    if (k > k0) { const q = pts[k - 1], l = Math.hypot(p.x - q.x, p.z - q.z) || 1; ix = (p.x - q.x) / l; iz = (p.z - q.z) / l; }
    const d = Math.hypot(p.x - mx, p.z - mz), nxt = pts[k + 1];
    if (!nxt) { turn = { kind: 'ARRIVE', d, street: streetAt(p.x, p.z), ref: streetRef(p.x, p.z) }; break; }
    const l = Math.hypot(nxt.x - p.x, nxt.z - p.z) || 1, ox = (nxt.x - p.x) / l, oz = (nxt.z - p.z) / l;
    const dot = ox * ix + oz * iz; if (dot > 0.5) continue; // straight through
    turn = { kind: dot < -0.5 ? 'U-TURN' : ox * iz - oz * ix > 0 ? 'LEFT' : 'RIGHT', d, street: streetAt((p.x + nxt.x) / 2, (p.z + nxt.z) / 2), ref: streetRef((p.x + nxt.x) / 2, (p.z + nxt.z) / 2) };
    break;
  }
  return { arrows, turn, cp };
}
