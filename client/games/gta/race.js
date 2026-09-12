/* The street race: a course of checkpoints drawn from the round's seed, so every machine lays out the same one and it
   never travels over the network (like the city). Pure functions over the road graph, testable in node.

   The course is a loop of intersections: index 0 is the start / finish line at the top of Ender Ave, where the grid
   forms, and the rest are spread around the city at least a few blocks apart, visited in the order they sit around
   their centre so the loop does not cross itself much. A lap is every checkpoint in order and back through the line. */
import { makeRng } from '../../core/math.js';
import { X, NB, streetAt } from './world.js';

export const LAPS = 3, CHECKPOINTS = 6;
export const START_NODE = [3, 8]; // the intersection the grid faces (Ender Ave, heading +z)
export const CP_RADIUS = 9;        // within this of an intersection's centre counts as through it
const MIN_GAP = 3;                 // blocks between any two checkpoints (Manhattan), and from the start

/* the checkpoints as road nodes [i, j]; index 0 is the start / finish */
export function raceCourse(seed = 1, n = CHECKPOINTS) {
  const { rnd } = makeRng((seed >>> 0) * 2654435761 + 97);
  const far = (a, b, gap) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) >= gap;
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
  return rev[1][1] > loop[1][1] ? rev : loop;
}

/* world coordinates of a course node */
export const nodeXZ = node => ({ x: X(node[0]), z: X(node[1]) });

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

/* The sat-nav for the route the minimap draws (road nodes from the nearest intersection to the goal), for a driver at
   (mx, mz) heading along the unit vector (hx, hz): the arrows to lay on the road ahead (breadcrumbs down each leg and a
   bigger one at each intersection pointing the way out) and the next instruction. Returns { arrows, turn } where
   arrows is [{ x, z, yaw, big }] and turn is null or { kind, d, street }: kind 'LEFT' | 'RIGHT' | 'U-TURN' at the first
   intersection that is not straight through, d metres away, onto `street`; or 'ARRIVE' when the goal is straight ahead. */
export function raceGuide(route, mx, mz, hx, hz, legs = 4, step = 14) {
  const pts = route.map(([i, j]) => ({ x: X(i), z: X(j) }));
  const ahead = (x, z, slack) => (x - mx) * hx + (z - mz) * hz > slack;
  const arrows = []; let turn = null;
  let k0 = 0; while (k0 < pts.length && !ahead(pts[k0].x, pts[k0].z, -3)) k0++;
  if (!pts.length) return { arrows, turn };
  if (k0 >= pts.length) { const p = pts[pts.length - 1]; return { arrows, turn: { kind: 'U-TURN', d: Math.hypot(p.x - mx, p.z - mz), street: streetAt(p.x, p.z) } }; }
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
    if (!nxt) { turn = { kind: 'ARRIVE', d, street: streetAt(p.x, p.z) }; break; }
    const l = Math.hypot(nxt.x - p.x, nxt.z - p.z) || 1, ox = (nxt.x - p.x) / l, oz = (nxt.z - p.z) / l;
    const dot = ox * ix + oz * iz; if (dot > 0.5) continue; // straight through
    turn = { kind: dot < -0.5 ? 'U-TURN' : ox * iz - oz * ix > 0 ? 'LEFT' : 'RIGHT', d, street: streetAt((p.x + nxt.x) / 2, (p.z + nxt.z) / 2) };
    break;
  }
  return { arrows, turn };
}
