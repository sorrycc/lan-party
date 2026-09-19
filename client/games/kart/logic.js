/* Frostline Kart - the small pieces of race logic that do not need a browser or three.js, so `node --test` can pin them down:
   the starting grid, the CPU rubber band, the CPU's lateral dodge around hazards and the music scheduler's clock. */
import { makeRng } from '../../core/math.js';

/* The starting grid, front row first. Every machine computes it from the same inputs, so they all agree without a message:
   - a Grand Prix race after the first: reverse standings, the cup leader starts last (ties keep the seeded order);
   - otherwise (a single race, the first cup race): a shuffle seeded by the round's session seed.
   Humans and CPUs are treated alike. `points` maps kart id -> cup points (empty or null: no standings yet). */
export function gridOrder(ids, seed, points) {
  const { rnd } = makeRng((seed >>> 0) || 1);
  const out = ids.slice().sort((a, b) => a - b);
  for (let i = out.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [out[i], out[j]] = [out[j], out[i]]; }
  if (points && Object.keys(points).length) { const pos = new Map(out.map((id, i) => [id, i])); out.sort((a, b) => (points[a] || 0) - (points[b] || 0) || pos.get(a) - pos.get(b)); }
  return out;
}

/* The rubber band: a CPU ahead of the humans eases off, one behind them catches up. Catch-up is measured to the LAST human (so a
   CPU is never boosted past a trailing player), easing off to the humans' average. Whatever the CPU's skill, the band never lifts
   its top speed above RUBBER_TOP of a human kart's, and the catch-up alone is capped at RUBBER_CATCHUP.
   gapBehind / gapAhead are in laps: (last human - cpu) and (average human - cpu). Returns the factor on the CPU's top speed. */
export const RUBBER_TOP = 1.04, RUBBER_CATCHUP = 0.08;
export function rubberBand(gapBehind, gapAhead, cfg, skill) {
  if (gapBehind > 0) { const up = Math.min(gapBehind * cfg.pull, cfg.rubber[1], RUBBER_CATCHUP); return Math.max(1, Math.min(1 + up, RUBBER_TOP / Math.max(skill, 0.5))); }
  return 1 + Math.max(Math.min(gapAhead * cfg.pull, 0), cfg.rubber[0]);
}

/* A CPU's dodge: `lane` is where it means to be (lateral metres from the centre line) at the hazards' distance, `hs` the lateral
   positions of the hazards lying in its lookahead window, `width` the clearance it keeps and `lim` the edge of the drivable
   road. Each hazard too close to the line pushes it to whichever side has the room (the nearer side when both do).
   Returns the new lateral target. */
export function dodgeLat(lane, hs, width, lim) {
  let x = lane;
  for (let pass = 0; pass < 2; pass++) for (const h of hs) {
    if (Math.abs(h - x) >= width) continue;
    const left = h - width, right = h + width, canL = left >= -lim, canR = right <= lim;
    x = canL && canR ? (x <= h ? left : right) : canL ? left : canR ? right : x;
  }
  return Math.max(-lim, Math.min(lim, x));
}

/* The music scheduler's clock: the next note time to schedule from. While muted, or after a stall (a hidden tab throttles the
   timer, a long frame), the notes that fell behind are skipped rather than all scheduled at once: the tune picks up `lead`
   seconds from now. */
export const resyncNext = (nextT, now, muted, lead = 0.05) => muted || nextT < now - 0.1 ? now + lead : nextT;
