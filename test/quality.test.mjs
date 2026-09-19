/* The render quality controller: long frames step the picture down, full-rate ones bring it back, and it does not flap. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createQuality } from '../client/core/quality.js';

const run = (q, ms, seconds) => { for (let t = 0; t < seconds * 1000; t += ms) q.sample(ms / 1000); return q.level; };

test('a steady 60 Hz stays at the best level, and one hitch does not change it', () => {
  const q = createQuality(); assert.equal(run(q, 16.7, 30), 0);
  q.sample(.12); assert.equal(run(q, 16.7, 5), 0);
});

test('long frames step down one level at a time, and not past the last', () => {
  const seen = [], q = createQuality({ onChange: (l, from) => seen.push([from, l]) });
  assert.equal(run(q, 24, 1.5), 0); assert.equal(run(q, 24, 1.5), 1); assert.equal(run(q, 24, 30), 2);
  assert.deepEqual(seen, [[0, 1], [1, 2]]);
});

test('full-rate frames bring the level back after the wait, and no sooner', () => {
  const q = createQuality(); run(q, 24, 3); assert.equal(q.level, 1);
  assert.equal(run(q, 16.7, 8), 1); assert.equal(run(q, 16.7, 4), 0);
});

test('a step up that has to be taken back doubles the wait, and the second one is the last', () => {
  const q = createQuality(); let ups = 0, t = 0; const heavy = () => q.level === 0 ? 24 : 16.7; // level 0 is too much for this machine
  for (let prev = 0; t < 600000;) { const ms = heavy(); q.sample(ms / 1000); t += ms; if (q.level < prev) ups++; prev = q.level; }
  assert.equal(ups, 2); assert.equal(q.level, 1);
});

test('a 120 Hz display is measured against its own interval', () => {
  const q = createQuality(); run(q, 8.3, 5); assert.ok(q.refreshMs < 9);
  run(q, 24, 3); assert.equal(q.level, 1);
  assert.equal(run(q, 16.7, 30), 1); // 60 fps on a 120 Hz screen is playable, but it is not headroom
  assert.equal(run(q, 8.3, 12), 0);
});

test('a frame after a pause is skipped', () => { const q = createQuality(); for (let i = 0; i < 200; i++) q.sample(.25); assert.equal(q.level, 0); });
