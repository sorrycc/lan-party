/* Crossy Farm Car's DOM-free rules: lobby options with their defaults, the difficulty ramp, the standings (finish line first),
   who may revive, where a revive lands, and which way a swipe points. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readOpts, diffAt, rank, finished, canRevive, reviveSpot, swipeDir, REVIVE_COST } from '../client/games/crossy/rules.js';

test('options: defaults when missing, unknown values fall back', () => {
  assert.deepEqual(readOpts(), { target: 0, ramp: 'normal', coins: true });
  assert.deepEqual(readOpts({ target: 200, ramp: 'hard', coins: false }), { target: 200, ramp: 'hard', coins: false });
  assert.deepEqual(readOpts({ target: 150, ramp: 'nightmare' }), { target: 0, ramp: 'normal', coins: true });
  assert.equal(readOpts({ target: '300' }).target, 300);
});

test('ramp: normal keeps the old curve, easy is slower, hard is faster, all clamp to 0..1', () => {
  assert.equal(diffAt(100, 200), 0.5);
  assert.ok(diffAt(100, 200, 'easy') < 0.5 && diffAt(100, 200, 'hard') > 0.5);
  assert.equal(diffAt(1000, 200, 'easy'), 1); assert.equal(diffAt(-5, 200), 0);
});

test('standings: the first to cross the line, then furthest row, then coins; left players drop out', () => {
  const cars = [
    { id: 'a', maxRow: 50, coins: 9 }, { id: 'b', maxRow: 120, coins: 0 }, { id: 'c', maxRow: 100, coins: 1, ft: 40.2 },
    { id: 'd', maxRow: 101, coins: 0, ft: 39.9 }, { id: 'e', maxRow: 50, coins: 2 }, { id: 'f', maxRow: 999, coins: 0, left: true },
  ];
  assert.deepEqual(rank(cars).map(c => c.id), ['d', 'c', 'b', 'a', 'e']);
  assert.equal(finished(cars, 0), false); assert.equal(finished(cars, 100), true); assert.equal(finished(cars, 200), false);
});

test('revive: coins on, enough coins, once, only while the round is on and the car is down', () => {
  const rules = { coins: true }, car = { coins: REVIVE_COST, revived: false, state: 'dying' };
  assert.equal(canRevive(car, rules, 'play'), true);
  assert.equal(canRevive({ ...car, coins: REVIVE_COST - 1 }, rules, 'play'), false);
  assert.equal(canRevive({ ...car, revived: true }, rules, 'play'), false);
  assert.equal(canRevive({ ...car, state: 'playing' }, rules, 'play'), false);
  assert.equal(canRevive(car, rules, 'over'), false);
  assert.equal(canRevive(car, { coins: false }, 'play'), false);
});

test('revive spot: the furthest grass row at or below the best, on the nearest free reachable column', () => {
  const S = (type, blocked = [], reach = [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6]) => ({ type, blocked: new Set(blocked), reach: new Set(reach) });
  const specs = new Map([[10, S('road')], [9, S('river')], [8, S('grass', [2, 3], [0, 1, 4, 5])], [7, S('grass')]]);
  assert.deepEqual(reviveSpot(specs, 10, 3), { row: 8, col: 4 });
  assert.deepEqual(reviveSpot(specs, 10, -9), { row: 8, col: 0 });
  assert.deepEqual(reviveSpot(new Map([[5, S('road')]]), 5, 2.4), { row: 5, col: 2 }); // nothing safe in reach: the best row
});

test('swipe: a short drag is a tap, else the dominant axis; screen up is forward', () => {
  assert.equal(swipeDir(5, -10), null);
  assert.deepEqual(swipeDir(0, -40), [0, 1]); assert.deepEqual(swipeDir(3, 30), [0, -1]);
  assert.deepEqual(swipeDir(40, 10), [1, 0]); assert.deepEqual(swipeDir(-40, 30), [-1, 0]);
});
