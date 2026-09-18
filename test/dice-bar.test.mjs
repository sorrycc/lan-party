/* Loaded Dice's moving bars: every variant is a pure function of the sweep's progress, so what the player saw is what the host grades. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { VARIANTS, cursorAt, fakeSlot, fogged, gradeAt, mkBar, shownSlots, slotsAt, spanOf } from '../client/games/dice/bar.js';
import { featsFor, genSlots, mkDuelist, playRound, resolveDuel } from '../client/games/dice/rules.js';
import { makeRng } from '../client/core/math.js';

const wild = featsFor('wild');
test('a bar stands still unless the spice says otherwise, and every variant turns up', () => {
  const R = makeRng(5).rnd, f = mkDuelist(5), seen = new Set();
  for (let i = 0; i < 200; i++) assert.equal(mkBar(R, genSlots(R, f, 5), featsFor('std', 1)).v, 'still');
  for (let i = 0; i < 600; i++) seen.add(mkBar(R, genSlots(R, f, 5, null, wild), wild).v);
  assert.deepEqual([...seen].sort(), ['still', ...VARIANTS].sort());
});

test('at every moment of every sweep the slots are in order, apart, and on the bar', () => {
  const R = makeRng(11).rnd, f = mkDuelist(5, { slotW: 1.5 });
  for (let i = 0; i < 1500; i++) { const bar = mkBar(R, genSlots(R, f, 1 + i % 5, null, wild), wild);
    for (let u = 0; u <= spanOf(bar); u += 0.05) { let edge = 0.24 - 1e-6; for (const s of slotsAt(bar, u)) { assert.ok(s.x >= edge - 1e-6, bar.v + ' overlaps at ' + u); assert.ok(s.w > 0.01); edge = s.x + s.w; } assert.ok(edge <= 0.9971, bar.v + ' runs off at ' + u); } }
});

test('the cursor comes back on a bounce, where the slots are narrower; a shrinking slot closes on its middle; a sliding one sways', () => {
  const slots = [{ k: 'sword', x: 0.4, w: 0.2 }, { k: 'heart', x: 0.8, w: 0.1 }];
  const bounce = { v: 'bounce', slots }; assert.equal(spanOf(bounce), 2); assert.equal(cursorAt(bounce, 0.5), 0.5); assert.ok(Math.abs(cursorAt(bounce, 1.5) - 0.5) < 1e-12); assert.equal(cursorAt(bounce, 2), 0);
  assert.deepEqual(gradeAt(bounce, 0.59, 0.4), { slot: 0, grade: 'GOOD' }); assert.deepEqual(gradeAt(bounce, 2 - 0.59, 0.4), { slot: -1, grade: 'MISSED' }, 'narrower on the way back'); assert.deepEqual(gradeAt(bounce, 1.5, 0.4), { slot: 0, grade: 'PERFECT' });
  const shrink = { v: 'shrink', slots }; assert.deepEqual(gradeAt(shrink, 0.43, 0.4), { slot: 0, grade: 'GOOD' }); assert.deepEqual(gradeAt(shrink, 0.405, 0.4), { slot: -1, grade: 'MISSED' }, 'its edge has already moved in'); assert.ok(Math.abs(slotsAt(shrink, 1)[1].w - 0.055) < 1e-9); assert.ok(Math.abs(slotsAt(shrink, 1)[1].x + 0.0275 - 0.85) < 1e-9);
  assert.deepEqual(gradeAt(shrink, 0.81, 0.4), { slot: -1, grade: 'MISSED' }, 'the heart has closed in by the time the cursor is there');
  const slide = mkBar(() => 0.4, slots, { bars: true, odds: 9 }); slide.v === 'slide' || assert.fail(slide.v); assert.ok(slide.amp[0] > 0.05); const xs = [0, 0.25, 0.5, 0.75].map(u => slotsAt(slide, u)[0].x); assert.ok(Math.max(...xs) - Math.min(...xs) > 0.05);
  assert.deepEqual(gradeAt(slide, -1, 0.4), { slot: -1, grade: '' }, 'the bar ran out');
});

test('a press is graded on the bar as it was at that moment, by the host as by the player', () => {
  const R = makeRng(2).rnd, fs = [mkDuelist(5), mkDuelist(5)], slots = [{ k: 'heart', x: 0.4, w: 0.2 }], bars = [{ v: 'bounce', slots }, { v: 'shrink', slots }];
  const res = playRound(R, fs, 6, bars, [1.5, 0.43]); assert.equal(res.r[0].grade, 'PERFECT'); assert.equal(res.r[1].grade, 'GOOD'); assert.equal(res.r[0].sx, 0.4);
  assert.equal(playRound(R, fs, 6, bars, [1.41, 0.59]).r[1].grade, 'MISSED');
});

test('ink fogs the other side\'s next bar, and the fog changes what is seen, not what is graded', () => {
  const roll = (act, n) => ({ act, grade: 'GOOD', slot: 0, bonus: 1, base: n, roll: n, crit: false });
  let [a, b] = resolveDuel(roll('smoke', 4), roll('shield', 4)); assert.equal(b.fog, true); assert.deepEqual(a.say.map(s => s[0]), ['smoke']); assert.deepEqual(b.say.map(s => s[0]), ['guard', 'smoked']);
  [a, b] = resolveDuel(roll('smoke', 2), roll('heart', 4)); assert.equal(b.fog, false);
  const fs = [mkDuelist(5), mkDuelist(5)]; playRound(() => 0.6, fs, 6, [[{ k: 'smoke', x: 0.4, w: 0.2 }], [{ k: 'heart', x: 0.4, w: 0.2 }]], [0.5, 0.5]); assert.equal(fs[1].fogged, true); assert.equal(fs[0].fogged, false);
  const bar = mkBar(makeRng(1).rnd, [{ k: 'sword', x: 0.5, w: 0.15 }], featsFor('classic'), true); assert.ok(bar.fog[1] - bar.fog[0] > 0.3 && bar.fog[0] >= 0.3 && bar.fog[1] <= 0.986);
  const foggy = { v: 'still', slots: [{ k: 'sword', x: 0.5, w: 0.1 }, { k: 'heart', x: 0.85, w: 0.1 }], fog: [0.4, 0.75] };
  assert.equal(fogged(foggy, foggy.slots[0], 0.1), true); assert.equal(fogged(foggy, foggy.slots[0], 0.45), false, 'it shows as the cursor nears'); assert.equal(fogged(foggy, foggy.slots[1], 0.1), false, 'outside the ink');
  assert.deepEqual(gradeAt(foggy, 0.55, 0.4), { slot: 0, grade: 'PERFECT' });
});

test('a fake slot stands in a bare stretch, is a kind the bar does not hold, and only turns up when the spice has it', () => {
  const R = makeRng(6).rnd, f = mkDuelist(5); f.hp = 4; let fakes = 0;
  for (let i = 0; i < 800; i++) { const slots = genSlots(R, f, 5, null, wild), shown = shownSlots(R, slots, wild); assert.deepEqual(shownSlots(R, slots, featsFor('std', 2)), slots);
    if (shown.length > slots.length) { fakes++; const fake = shown.find(s => !slots.includes(s)); assert.ok(!slots.some(s => s.k === fake.k)); const at = shown.indexOf(fake), l = at ? shown[at - 1].x + shown[at - 1].w : 0.3, r = at < shown.length - 1 ? shown[at + 1].x : 0.985; assert.ok(fake.x >= l + 0.0299 && fake.x + fake.w <= r - 0.0299, 'clear of its neighbours'); } }
  assert.ok(fakes > 60 && fakes < 450, 'now and then, where there is room: ' + fakes); assert.equal(fakeSlot(R, [{ k: 'sword', x: 0.3, w: 0.3 }, { k: 'heart', x: 0.65, w: 0.33 }]), null, 'no room');
});
