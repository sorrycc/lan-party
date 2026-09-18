/* Loaded Dice's duel rules: the bars the host deals, how a press is graded, how two rolled actions meet, and a whole match played
   headless from a seed, the way the host plays it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ACTS, DIE_STEPS, TO_HIT, MAX_SPEED, cleanPick, dieForRound, genSlots, gradePress, mkDuelist, playRound, resolveDuel, rollFor, speedOf } from '../client/games/dice/rules.js';
import { GAMES, defaultOpts } from '../client/games/registry.js';
import { makeRng } from '../client/core/math.js';

const roll = (act, n, extra = {}) => ({ act, grade: 'GOOD', slot: 0, bonus: 1, base: n, roll: n, crit: false, lucky: false, ...extra });
const said = o => o.say.map(s => s[0]);

test('a bar is one to three slots that never overlap, start after the bare 30% and fit on the bar', () => {
  const R = makeRng(7).rnd, f = mkDuelist(5); f.hp = 3; f.combo = 12;
  for (let i = 0; i < 500; i++) {
    f.dazed = i % 2 === 1; const slots = genSlots(R, f, 1 + i % 5);
    assert.ok(slots.length >= 1 && slots.length <= 3);
    assert.equal(new Set(slots.map(s => s.k)).size, slots.length, 'no kind twice on one bar');
    let edge = 0.3 - 1e-9; for (const s of slots) { assert.ok(ACTS.includes(s.k)); assert.ok(s.x >= edge, 'left to right, no overlap'); edge = s.x + s.w; }
    assert.ok(edge <= 0.9851);
  }
});

test('a dazed fighter gets narrower slots and nobody at full health is offered a heart', () => {
  const widest = dazed => { const R = makeRng(3).rnd, f = mkDuelist(5); f.dazed = dazed; let w = 0; for (let i = 0; i < 200; i++) for (const s of genSlots(R, f)) w = Math.max(w, s.w); return w; };
  assert.ok(widest(true) < widest(false) * 0.7);
  const R = makeRng(11).rnd, f = mkDuelist(5); for (let i = 0; i < 300; i++) assert.ok(!genSlots(R, f).some(s => s.k === 'heart'));
});

test('a press is graded by where the cursor was', () => {
  const slots = [{ k: 'sword', x: 0.4, w: 0.2 }, { k: 'heart', x: 0.7, w: 0.1 }];
  assert.deepEqual(gradePress(slots, 0.5), { slot: 0, grade: 'PERFECT' });
  assert.deepEqual(gradePress(slots, 0.41), { slot: 0, grade: 'GOOD' });
  assert.deepEqual(gradePress(slots, 0.78), { slot: 1, grade: 'GOOD' });
  assert.deepEqual(gradePress(slots, 0.2), { slot: -1, grade: 'MISSED' });
  assert.deepEqual(gradePress(slots, -1), { slot: -1, grade: '' }, 'the bar ran out: a plain roll');
  assert.deepEqual(cleanPick({ n: 4, pos: 7 }), { n: 4, pos: 1 }); assert.equal(cleanPick({ n: 4, pos: 'x' }), null); assert.equal(cleanPick({ n: 1.5, pos: 0.2 }), null); assert.equal(cleanPick(null), null);
});

test('the rig is added to the die and capped at its top face, a fumble rolls a 1, a plain roll attacks', () => {
  const f = mkDuelist(5), slots = [{ k: 'shield', x: 0.4, w: 0.2 }];
  for (let seed = 1; seed < 200; seed++) {
    const r = rollFor(makeRng(seed).rnd, f, 6, slots, { slot: 0, grade: 'PERFECT' });
    assert.equal(r.act, 'shield'); assert.equal(r.bonus, 2); assert.equal(r.roll, Math.min(6, r.base + 2)); assert.equal(r.crit, r.roll === 6);
  }
  const miss = rollFor(makeRng(1).rnd, f, 6, slots, { slot: -1, grade: 'MISSED' }); assert.equal(miss.act, 'miss'); assert.equal(miss.roll, 1); assert.equal(miss.crit, false);
  assert.equal(rollFor(makeRng(1).rnd, f, 6, slots, { slot: -1, grade: '' }).act, 'plain');
  f.combo = 10; let lucky = 0; for (let seed = 1; seed < 400; seed++) if (rollFor(makeRng(seed).rnd, f, 20, slots, { slot: 0, grade: 'GOOD' }).lucky) lucky++;
  assert.ok(lucky > 40 && lucky < 200, 'a combo makes lucky crits, some of the time: ' + lucky);
});

test('sword, shield, skull: each beats one and loses to one', () => {
  let [a, b] = resolveDuel(roll('sword', 4), roll('shield', 3)); // the shield holds
  assert.equal(b.dmg, 0); assert.equal(a.dmg, 0); assert.deepEqual(said(b), ['BLOCK']); assert.equal(b.fx, 'block');
  [a, b] = resolveDuel(roll('skull', 4), roll('shield', 5)); // the skull breaks it and dazes
  assert.equal(b.dmg, 1); assert.equal(b.daze, true); assert.deepEqual(said(b), ['BREAK']);
  [a, b] = resolveDuel(roll('sword', 4), roll('skull', 5)); // the sword lands on the skull, who still dazes
  assert.equal(b.dmg, 1); assert.equal(a.daze, true); assert.equal(a.dmg, 0);
});

test('a roll under the bar to hit does nothing, a 6 hits harder, a top face crits, breaks a block and is parried by another', () => {
  let [a, b] = resolveDuel(roll('sword', TO_HIT - 1), roll('heart', TO_HIT - 1));
  assert.equal(b.dmg, 0); assert.equal(b.heal, 0); assert.deepEqual(said(a), ['WHIFF']); assert.deepEqual(said(b), ['FIZZLE']);
  [a, b] = resolveDuel(roll('sword', 6), roll('heart', 3)); assert.equal(b.dmg, 2); assert.equal(b.heal, 1);
  [a, b] = resolveDuel(roll('sword', 8, { crit: true }), roll('shield', 4)); assert.equal(b.dmg, 3); assert.equal(b.hitCrit, true); assert.deepEqual(said(b), ['BREAK']);
  [a, b] = resolveDuel(roll('sword', 8, { crit: true }), roll('shield', 8, { crit: true })); assert.equal(b.dmg, 0); assert.equal(a.dmg, 1); assert.deepEqual(said(b), ['PARRY!']);
});

test('two attacks clash: the higher roll lands, a top face beats any roll, a tie cancels both', () => {
  let [a, b] = resolveDuel(roll('sword', 5), roll('plain', 4)); assert.equal(b.dmg, 1); assert.equal(a.dmg, 0);
  [a, b] = resolveDuel(roll('sword', 4, { crit: true }), roll('sword', 5)); assert.equal(b.dmg, 2); assert.equal(a.dmg, 0);
  [a, b] = resolveDuel(roll('sword', 5), roll('sword', 5)); assert.equal(a.dmg + b.dmg, 0); assert.equal(a.fx, 'clash'); assert.equal(b.fx, 'clash');
  [a, b] = resolveDuel(roll('miss', 1), roll('miss', 1)); assert.equal(a.dmg + b.dmg, 0); assert.deepEqual(said(a), ['MISSED']);
});

test('a rush speeds the other bar, a slow-down never takes a bar under its base speed, the rules are the same from both chairs', () => {
  const [a, b] = resolveDuel(roll('fast', 2, { grade: 'PERFECT' }), roll('slow', 2)); assert.equal(b.speed, 0.5 - 0.5); assert.equal(a.speed, 0);
  const fs = [mkDuelist(5), mkDuelist(5)], R = makeRng(5).rnd, slots = [[{ k: 'slow', x: 0.4, w: 0.2 }], [{ k: 'fast', x: 0.4, w: 0.2 }]];
  playRound(R, fs, 6, slots, [0.5, 0.5]); assert.equal(fs[0].combo, 1); assert.ok(speedOf(fs[0]) >= 1); assert.ok(fs[0].speedMod >= -fs[0].combo * 0.07 - 1e-9);
  for (const [x, y] of [['sword', 'shield'], ['skull', 'shield'], ['sword', 'skull'], ['heart', 'sword'], ['fast', 'slow']]) {
    const A = roll(x, 5), B = roll(y, 4), [p, q] = resolveDuel(A, B), [q2, p2] = resolveDuel(B, A); assert.deepEqual(p, p2); assert.deepEqual(q, q2);
  }
});

test('the dice grow through a duel, or stay what the lobby picked', () => {
  assert.deepEqual([1, 3, 4, 7, 10, 19, 99].map(n => dieForRound(n, 'grow')), [4, 4, 5, 6, 8, 20, 20]);
  assert.equal(dieForRound(5, 'd12'), 12); assert.equal(dieForRound(1, 'junk'), 6);
  const opt = GAMES.find(g => g.id === 'dice').options.find(o => o.key === 'dice');
  for (const c of opt.choices) assert.ok(DIE_STEPS.includes(dieForRound(1, c.value)), c.value);
});

test('a match played headless from a seed ends, and the same seed plays the same match', () => {
  const game = GAMES.find(g => g.id === 'dice'), opts = defaultOpts(game);
  const play = seed => {
    const R = makeRng(seed).rnd, aim = makeRng(seed + 1).rnd, fs = [mkDuelist(opts.hearts), mkDuelist(opts.hearts)], log = []; let rounds = 0;
    while (Math.max(fs[0].wins, fs[1].wins) < opts.wins) {
      for (const f of fs) { f.hp = f.maxHp; f.combo = 0; f.speedMod = 0; f.dazed = false; }
      for (let rn = 1; ; rn++) {
        assert.ok(++rounds < 2000, 'the match ends');
        const slots = fs.map(f => genSlots(R, f, rn)), pos = slots.map(s => { const k = s[Math.floor(aim() * s.length)], r = aim(); return r < 0.1 ? -1 : r < 0.2 ? 0.05 : k.x + k.w * aim(); });
        const res = playRound(R, fs, dieForRound(rn, opts.dice), slots, pos); log.push(res.r.map(r => r.roll).join('/') + ':' + fs.map(f => f.hp).join('/'));
        for (const f of fs) { assert.ok(f.hp >= 0 && f.hp <= f.maxHp); assert.ok(speedOf(f) >= 1 && speedOf(f) <= MAX_SPEED); }
        if (res.win !== null) { assert.equal(res.win === -1 ? fs[0].hp + fs[1].hp : fs[1 - res.win].hp, 0); break; }
      }
    }
    return log.join(' ');
  };
  assert.equal(play(42), play(42)); assert.notEqual(play(42), play(43));
});
