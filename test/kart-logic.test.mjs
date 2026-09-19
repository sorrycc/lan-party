/* Frostline Kart race logic: the grid every machine agrees on, the capped rubber band, the CPU's dodge and the music clock. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { gridOrder, rubberBand, dodgeLat, resyncNext, RUBBER_TOP, RUBBER_CATCHUP } from '../client/games/kart/logic.js';

const ids = [0, 1, 2, 3, 4, 5, 6, 7];

test('grid: the same seed gives the same grid whatever order the ids arrive in', () => {
  const a = gridOrder(ids, 12345), b = gridOrder(ids.slice().reverse(), 12345);
  assert.deepEqual(a, b); assert.deepEqual(a.slice().sort(), ids);
  assert.notDeepEqual(gridOrder(ids, 12345), gridOrder(ids, 999)); // a new round, a new grid
});

test('grid: humans are not parked at the back - over many seeds every kart starts on pole sometimes', () => {
  const pole = new Set(); for (let s = 1; s < 200; s++) pole.add(gridOrder(ids, s)[0]);
  assert.equal(pole.size, ids.length);
});

test('grid: in a cup the leader starts last, ties keep the seeded order', () => {
  const points = { 0: 30, 1: 12, 2: 12, 3: 5, 4: 0 };
  const g = gridOrder([0, 1, 2, 3, 4], 7, points);
  assert.equal(g[g.length - 1], 0); assert.equal(g[0], 4); assert.equal(g[1], 3);
  const seeded = gridOrder([0, 1, 2, 3, 4], 7); assert.equal(g.indexOf(1) < g.indexOf(2), seeded.indexOf(1) < seeded.indexOf(2));
  assert.deepEqual(gridOrder([0, 1, 2], 7, {}), gridOrder([0, 1, 2], 7)); // no standings yet: the shuffle
});

test('rubber band: catch-up is capped, and a CPU is never boosted past RUBBER_TOP', () => {
  const hard = { rubber: [-0.03, 0.14], pull: 0.4 };
  assert.ok(rubberBand(5, 5, hard, 0.9) <= 1 + RUBBER_CATCHUP + 1e-9);
  assert.ok(rubberBand(5, 5, hard, 0.99) * 0.99 <= RUBBER_TOP + 1e-9);
  assert.equal(rubberBand(5, 5, hard, 1.05), 1);                // already past the cap on skill alone: no boost, and never a brake
  assert.equal(rubberBand(0, 0, hard, 1), 1);
  assert.equal(rubberBand(-1, -1, hard, 1), 0.97); // ahead of the humans: eases off down to the floor
  assert.ok(rubberBand(-0.1, 0.2, hard, 1) === 1); // ahead of the last human: no catch-up even if behind the average
});

test('dodge: a hazard on the line pushes the lane aside, toward the room', () => {
  assert.equal(dodgeLat(0, [], 2.4, 6), 0);
  assert.equal(dodgeLat(0, [5], 2.4, 6), 0);                    // far enough away already
  assert.equal(dodgeLat(0.5, [0], 2.4, 6), 2.4);                // just right of it: go right
  assert.equal(dodgeLat(-0.5, [0], 2.4, 6), -2.4);              // just left: go left
  assert.equal(dodgeLat(5, [5], 2.4, 6), 2.6);                  // against the right edge: the only way is left
  const x = dodgeLat(0, [0.5, 3], 2.4, 6); assert.ok(Math.abs(x - 0.5) >= 2.4 - 1e-9 && Math.abs(x) <= 6);
});

test('music clock: muted or stalled, it resumes from now instead of catching up', () => {
  assert.equal(resyncNext(10.2, 10, false), 10.2);              // running normally: untouched
  assert.equal(resyncNext(5, 70, false), 70.05);                // a minute behind: skip it
  assert.equal(resyncNext(10.2, 10, true), 10.05);              // muted: keep the clock at now
});
