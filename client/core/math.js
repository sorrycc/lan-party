/* Small numeric helpers shared by every game. */
export const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
export const lerp = (a, b, t) => a + (b - a) * t;
export const wrapAngle = a => { a = a % (Math.PI * 2); if (a > Math.PI) a -= Math.PI * 2; if (a < -Math.PI) a += Math.PI * 2; return a; };
export const ordinal = n => n + (n === 1 ? 'st' : n === 2 ? 'nd' : n === 3 ? 'rd' : 'th');

/* Seeded LCG so procedurally placed scenery is identical on every machine in the room.
   `rnd()` is [0,1), `rr(a,b)` is [a,b). */
export function makeRng(seed = 1337) {
  let s = seed >>> 0;
  const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const rr = (a, b) => a + rnd() * (b - a);
  return { rnd, rr };
}
