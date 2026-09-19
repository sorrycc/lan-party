/* Loaded Dice: a press graded over the frame it was made in (a fast bar cannot jump the gold between two frames), the slow-down
   offered when it can do something, and a counter that rolled its number and was not swung at costing nothing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { SWEPT_MAX, cleanPick, gradeAt, mkBar } from '../client/games/dice/bar.js';
import { MAX_SPEED, SWEEP_T, canSlow, featsFor, genSlots, mkDuelist, playRound, resolveDuel, speedOf } from '../client/games/dice/rules.js';
import { makeRng } from '../client/core/math.js';

const still = slots => mkBar(() => 0.99, slots, featsFor('classic'));

test('a press counts a slot the cursor crossed in the frame before it, and only that frame', () => {
  const bar = still([{ k: 'sword', x: 0.3, w: 0.2 }, { k: 'jackpot', x: 0.6, w: 0.03 }]), step = MAX_SPEED / SWEEP_T / 30; // the top speed on a 30 fps screen
  assert.ok(step > 0.03 + 0.008, 'at the top speed a frame is wider than the gold');
  assert.equal(gradeAt(bar, 0.6 + 0.03 + 0.03, 0.4).grade, 'MISSED', 'one point past the gold misses');
  assert.deepEqual(gradeAt(bar, 0.66, 0.4, step), { slot: 1, grade: 'PERFECT' }, 'the frame crossed its middle');
  assert.deepEqual(gradeAt(bar, 0.66, 0.4, 0.032), { slot: 1, grade: 'GOOD' }, 'reached its edge only');
  assert.equal(gradeAt(bar, 0.66, 0.4, 0.02).slot, -1, 'a frame that stopped short of it does not reach it');
  assert.equal(gradeAt(bar, 0.55, 0.4, 0.06).slot, 0, 'the nearest slot crossed, the sword');
  assert.equal(gradeAt(bar, 0.9, 0.4, 1).slot, -1, 'no reaching back further than one long frame');
  assert.deepEqual(gradeAt(bar, 0.4, 0.4, 0.05), gradeAt(bar, 0.4, 0.4), 'a press on a slot is graded where it is');
  const two = mkBar(() => 0.99, [{ k: 'sword', x: 0.4, w: 0.15 }, { k: 'heart', x: 0.9, w: 0.08 }], featsFor('classic'), false, { presses: 2 });
  assert.equal(gradeAt(two, 1.01, 0.4, 0.06).slot, -1, 'a double round does not reach back into the first crossing');
  assert.deepEqual(cleanPick({ n: 2, u: 0.66, w: 0.9, u2: -1, w2: -3 }), { n: 2, u: 0.66, u2: -1, w: SWEPT_MAX, w2: 0 });
  const fs = [mkDuelist(5), mkDuelist(5)], res = playRound(() => 0.5, fs, 6, [bar, [{ k: 'shield', x: 0.4, w: 0.2 }]], [{ u: 0.66, w: step }, 0.5]);
  assert.equal(res.r[0].jackpot, true); assert.equal(res.r[0].roll, 6);
  assert.equal(playRound(() => 0.5, [mkDuelist(5), mkDuelist(5)], 6, [bar, [{ k: 'shield', x: 0.4, w: 0.2 }]], [0.66, 0.5]).r[0].act, 'miss', 'a bare number is graded at its point');
});

test('the slow-down is offered while a bar is sped up and always takes speed off it', () => {
  const offered = f => { const R = makeRng(9).rnd; for (let i = 0; i < 400; i++) if (genSlots(R, f, 5).some(s => s.k === 'slow')) return true; return false; };
  const calm = mkDuelist(5); assert.equal(canSlow(calm), false); assert.equal(offered(calm), false, 'nothing to slow');
  const rushed = mkDuelist(5); rushed.speedMod = 0.35; assert.ok(speedOf(rushed) < 1.6); assert.equal(offered(rushed), true, 'one rush is enough');
  const combo = mkDuelist(5); combo.combo = 10; assert.equal(offered(combo), true);
  for (const [combo, mod] of [[0, 0.35], [0, 0.5], [3, 0.35], [10, 0], [9, -0.2], [0, 0.002]]) {
    const fs = [mkDuelist(5), mkDuelist(5)]; fs[0].combo = combo; fs[0].speedMod = mod; if (!canSlow(fs[0])) continue;
    const before = speedOf(fs[0]); playRound(() => 0.5, fs, 6, [[{ k: 'slow', x: 0.4, w: 0.2 }], [{ k: 'heart', x: 0.4, w: 0.2 }]], [0.45, 0.5]);
    assert.ok(speedOf(fs[0]) < before - 1e-6, `combo ${combo}, speedMod ${mod}: ${before} -> ${speedOf(fs[0])}`); assert.ok(speedOf(fs[0]) >= 1);
  }
});

test('a counter that rolled its number and was not swung at is no trap', () => {
  const r = (act, n) => ({ act, grade: 'GOOD', slot: 0, bonus: 1, base: n, roll: n, crit: false });
  for (const other of ['heart', 'shield', 'fast', 'slow', 'poison', 'miss']) { const [, b] = resolveDuel(r(other, other === 'miss' ? 1 : 4), r('counter', 4)); assert.equal(b.daze, false, other); assert.equal(b.dmg, 0, other); }
  assert.equal(resolveDuel(r('heart', 4), r('counter', 2))[1].daze, true, 'a fumble is still a fumble');
  const [a, b] = resolveDuel(r('sword', 5), r('counter', 4)); assert.equal(a.dmg, 1, 'its own attack comes back'); assert.equal(b.dmg, 0);
});
