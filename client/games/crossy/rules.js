/* Crossy Farm Car - the rules that need no DOM or GL: lobby options, the difficulty ramp, the standings, the coin revive and
   where it puts you back, and which way a swipe points. index.js draws them; test/crossy-rules.test.mjs checks them in node. */
import { clamp } from '../../core/math.js';

export const CH = 6;                 // playable columns -CH..CH
export const REVIVE_COST = 5;        // coins for the one revive a round
export const REVIVE_WINDOW = 5;      // seconds the offer stays open after the crash animation
export const SWIPE_MIN = 18;         // px before a touch counts as a swipe rather than a tap

/* lobby options (registry: crossy.target / .ramp / .coins); anything missing or unknown falls back to the default */
export const TARGETS = [0, 100, 200, 300];               // 0 = endless: last car standing
export const RAMP = { easy: 1.6, normal: 1, hard: 0.6 }; // how many rows the farm takes to reach full difficulty, relative to normal
export function readOpts(o = {}) {
  const t = Number(o.target ?? 0);
  return { target: TARGETS.includes(t) ? t : 0, ramp: o.ramp in RAMP ? o.ramp : 'normal', coins: o.coins ?? true };
}
/* 0..1 over the first `span` rows (the farm's own spans: 160 for the mix of lanes, 200 for herd and log speed), stretched or squeezed by the ramp */
export const diffAt = (i, span, ramp = 'normal') => clamp(i / (span * (RAMP[ramp] ?? 1)), 0, 1);

/* the standings: whoever crossed the finish line first (world clock `ft`), then furthest row, then coins, then id */
export const byStanding = (a, b) => ((a.ft ?? Infinity) - (b.ft ?? Infinity)) || b.maxRow - a.maxRow || b.coins - a.coins || String(a.id).localeCompare(String(b.id));
export const rank = cars => cars.filter(c => !c.left).sort(byStanding);
export const finished = (cars, target) => !!target && cars.some(c => !c.left && c.maxRow >= target);

/* one revive a round, bought with coins, only while the round is on */
export const canRevive = (car, rules, phase) => !!(rules.coins && car && !car.revived && car.coins >= REVIVE_COST && car.state !== 'playing' && phase === 'play');

/* where a revive puts you: the furthest grass row at or below your best (a road or a river would kill you again), on the free
   reachable column nearest where you were. `specs` is the row map (type, blocked, reach). Nothing found: your best row, same column. */
export function reviveSpot(specs, maxRow, x, look = 10) {
  const want = clamp(Math.round(x), -CH, CH);
  for (let i = maxRow; i >= maxRow - look; i--) {
    const s = specs.get(i); if (!s || s.type !== 'grass') continue;
    let best = null;
    for (const c of s.reach) if (c >= -CH && c <= CH && !s.blocked.has(c) && (best === null || Math.abs(c - want) < Math.abs(best - want))) best = c;
    if (best !== null) return { row: i, col: best };
  }
  return { row: maxRow, col: want };
}

/* a touch drag: null while it is still a tap, else the hop it points to ([dx, drow]; screen up is forward) */
export function swipeDir(dx, dy, min = SWIPE_MIN) {
  const ax = Math.abs(dx), ay = Math.abs(dy);
  if (Math.max(ax, ay) < min) return null;
  return ax > ay ? [dx > 0 ? 1 : -1, 0] : [0, dy < 0 ? 1 : -1];
}
