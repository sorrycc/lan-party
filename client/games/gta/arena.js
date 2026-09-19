/* The deathmatch's arena: a square of city blocks drawn from the round's seed, so every machine fences off the same one
   and nothing about it travels over the network (like the city and the race course). Pure functions over the block
   grid, testable in node.

   The arena is ARENA_BLOCKS blocks a side plus the roads around them, so there is a loop road to drive along its edge.
   Its eight spawn points are sidewalk corners: the outer corner of each corner block and the four corners of the
   middle block, all reachable on foot, each facing the centre. A player who leaves it has OUT_WARN_T seconds to get
   back before the fence starts to hurt (the sim applies it). */
import { makeRng } from '../../core/math.js';
import { X, NB, ROAD, cornerXZ } from './world.js';

export const ARENA_BLOCKS = 3;
export const OUT_WARN_T = 3;      // seconds outside before it hurts
export const OUT_DMG_PER_S = 15;  // and then this much a second: about seven more seconds to live

/* the arena for a seed: { i0, j0, n, x0, z0, x1, z1, cx, cz } (block cells i0..i0+n-1, world bounds at the outer edge of the bounding roads) */
export function arenaOf(seed = 1, n = ARENA_BLOCKS) {
  const { rnd } = makeRng((seed >>> 0) * 2246822519 + 31);
  const i0 = Math.floor(rnd() * (NB - n + 1)), j0 = Math.floor(rnd() * (NB - n + 1));
  const x0 = X(i0) - ROAD / 2, z0 = X(j0) - ROAD / 2, x1 = X(i0 + n) + ROAD / 2, z1 = X(j0 + n) + ROAD / 2;
  return { i0, j0, n, x0, z0, x1, z1, cx: (x0 + x1) / 2, cz: (z0 + z1) / 2 };
}
export const inArena = (A, x, z, margin = 0) => x >= A.x0 - margin && x <= A.x1 + margin && z >= A.z0 - margin && z <= A.z1 + margin;
/* the block cell (i, j) lies in the arena */
export const arenaCell = (A, i, j) => i >= A.i0 && i < A.i0 + A.n && j >= A.j0 && j < A.j0 + A.n;
/* the road node [i, j] is one of the arena's intersections (the bounding roads included) */
export const arenaNode = (A, i, j) => i >= A.i0 && i <= A.i0 + A.n && j >= A.j0 && j <= A.j0 + A.n;

/* the eight spawn points: [{ x, z, face }], each facing the arena's centre */
export function arenaSpawns(A) {
  const last = A.i0 + A.n - 1, lastJ = A.j0 + A.n - 1, mid = A.i0 + (A.n >> 1), midJ = A.j0 + (A.n >> 1);
  const corners = [cornerXZ(A.i0, A.j0, 0), cornerXZ(last, lastJ, 2), cornerXZ(last, A.j0, 1), cornerXZ(A.i0, lastJ, 3), // the outer corners of the corner blocks, opposite pairs first
    cornerXZ(mid, midJ, 0), cornerXZ(mid, midJ, 2), cornerXZ(mid, midJ, 1), cornerXZ(mid, midJ, 3)];      // the middle block's corners
  return corners.map(([x, z]) => ({ x, z, face: Math.atan2(A.cx - x, A.cz - z) }));
}
/* the spawn point farthest from the nearest of `enemies` ([{ x, z }]); the first one when there is nobody to keep away from.
   `claimed` (spawn points someone appeared on a moment ago, maybe this very tick and so not yet among the enemies) are left out
   while any other is free */
export function farthestSpawn(spawns, enemies, claimed = []) {
  const free = spawns.filter(s => !claimed.includes(s)), list = free.length ? free : spawns;
  let best = list[0], bd = -1;
  for (const s of list) { let d = Infinity; for (const e of enemies) { const dx = e.x - s.x, dz = e.z - s.z; d = Math.min(d, dx * dx + dz * dz); } if (d > bd) { bd = d; best = s; } }
  return best;
}
