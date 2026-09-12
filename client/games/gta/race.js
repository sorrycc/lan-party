/* The street race: a course of checkpoints drawn from the round's seed, so every machine lays out the same one and it
   never travels over the network (like the city). Pure functions over the road graph, testable in node.

   The course is a loop of intersections: index 0 is the start / finish line at the top of Ender Ave, where the grid
   forms, and the rest are spread around the city at least a few blocks apart, visited in the order they sit around
   their centre so the loop does not cross itself much. A lap is every checkpoint in order and back through the line. */
import { makeRng } from '../../core/math.js';
import { X, NB } from './world.js';

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
