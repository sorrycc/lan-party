/* Loaded Dice - a bar that moves. A round's bar is { v, slots, amp, ph, fog, presses } and everything about it is a pure function of the
   sweep's progress `u`, which runs from 0 to `spanOf(bar)` at the owner's speed: where the cursor is, where each slot is and how wide.
   A press travels as `u`, so the host grades exactly what the player saw, whatever the link did in between.

     still    the bar as genSlots laid it out
     bounce   the cursor comes back: u runs to 2, and on the way back the slots are narrower
     slide    every slot sways about its place, never further than half the gap to its neighbour (so a bomb hard against the gold stays put)
     shrink   the slots close in on their middles as the sweep goes on

   `presses: 2` is a double round: the bar stands still, the cursor crosses it twice (u runs to 2) and each crossing takes one press.

   `fog` is a stretch of the bar under ink ([x0, x1]): what is under it shows only when the cursor is near. It changes what is
   seen, never what is graded. `fakeSlot` is a slot that is not there, for the other player's view of a bar. No DOM: testable in node. */
import { gradePress } from './rules.js';

export const VARIANTS = ['bounce', 'slide', 'shrink'], VARIANT_P = 0.35, SLIDE_AMP = 0.06, SHRINK = 0.45, BACK_W = 0.8, FOG_W = 0.35, FOG_NEAR = 0.07, FAKE_P = 0.25, DOUBLE_P = 0.12;
const LO = 0.24, HI = 0.997;

export function mkBar(rnd, slots, feat, fogged = false, force = null) { // force: { v } or { presses }, a foe's trick or the host's double round
  const two = force && force.presses === 2 && slots.filter(s => s.k !== 'bomb').length > 1;
  const v = two ? 'still' : force && force.v ? force.v : feat.bars && rnd() < VARIANT_P * feat.odds ? VARIANTS[Math.floor(rnd() * VARIANTS.length)] : 'still', bar = { v, slots, amp: null, ph: null, fog: null, presses: two ? 2 : 1 };
  if (v === 'slide') { bar.amp = slots.map((s, i) => { const l = i ? slots[i - 1].x + slots[i - 1].w : LO, r = i < slots.length - 1 ? slots[i + 1].x : HI; return +Math.max(0, Math.min(SLIDE_AMP, (s.x - l) / 2, (r - s.x - s.w) / 2)).toFixed(4); }); bar.ph = slots.map(() => +(rnd() * Math.PI * 2).toFixed(3)); }
  if (fogged) { const x0 = 0.3 + rnd() * (0.985 - FOG_W - 0.3); bar.fog = [+x0.toFixed(3), +(x0 + FOG_W).toFixed(3)]; }
  return bar;
}
export const spanOf = bar => bar.v === 'bounce' || bar.presses === 2 ? 2 : 1;
export const isDouble = (rnd, feat) => !!feat.double && rnd() < DOUBLE_P * feat.odds;
export const cursorAt = (bar, u) => bar.presses === 2 ? (u < 1 ? Math.max(0, u) : Math.min(1, u - 1)) : bar.v === 'bounce' ? 1 - Math.abs(1 - Math.min(2, Math.max(0, u))) : Math.min(1, Math.max(0, u));
/* the slots as they are at `u`: [{ k, x, w }] */
export function slotsAt(bar, u) {
  if (bar.v === 'slide') return bar.slots.map((s, i) => ({ k: s.k, x: s.x + bar.amp[i] * Math.sin(Math.PI * 2 * u + bar.ph[i]), w: s.w }));
  const k = bar.v === 'shrink' ? 1 - SHRINK * Math.min(1, Math.max(0, u)) : bar.v === 'bounce' && u > 1 ? BACK_W : 1;
  return k === 1 ? bar.slots : bar.slots.map(s => ({ k: s.k, x: s.x + s.w * (1 - k) / 2, w: s.w * k }));
}
/* what a press at `u` picked (below 0: the bar ran out) */
export const gradeAt = (bar, u, perfW) => u >= 0 ? gradePress(slotsAt(bar, u), cursorAt(bar, u), perfW) : { slot: -1, grade: '' };
/* is slot `s` (as it is now) hidden by the fog, with the cursor at `c`? */
export const fogged = (bar, s, c) => !!bar.fog && s.x + s.w / 2 > bar.fog[0] && s.x + s.w / 2 < bar.fog[1] && Math.abs(c - (s.x + s.w / 2)) > s.w / 2 + FOG_NEAR;
/* a press off the wire: the round it answers and the sweep's progress */
export function cleanPick(m) { const ok = v => typeof v === 'number' && Number.isFinite(v), fit = v => Math.min(2, Math.max(-1, v)); return m && Number.isInteger(m.n) && ok(m.u) ? { n: m.n, u: fit(m.u), u2: ok(m.u2) ? fit(m.u2) : -1 } : null; }

/* a slot that is not there, in the widest bare stretch of the bar, of a kind the bar does not already hold; null when there is no room */
export function fakeSlot(rnd, slots, kinds = ['sword', 'shield', 'skull', 'heart']) {
  let best = null, edge = 0.3; for (const s of [...slots, { x: 0.985, w: 0 }]) { if (!best || s.x - edge > best[1] - best[0]) best = [edge, s.x]; edge = s.x + s.w; }
  const w = 0.11, room = best[1] - best[0] - 0.06 - w, pool = kinds.filter(k => !slots.some(s => s.k === k)); if (room < 0 || !pool.length) return null;
  return { k: pool[Math.floor(rnd() * pool.length)], x: +(best[0] + 0.03 + rnd() * room).toFixed(4), w };
}
/* the other player's bar as this player is to see it: now and then with a fake in it, in its place from left to right */
export function shownSlots(rnd, slots, feat) {
  const fake = feat.fake && rnd() < FAKE_P * feat.odds ? fakeSlot(rnd, slots) : null;
  return fake ? [...slots, fake].sort((a, b) => a.x - b.x) : slots;
}
