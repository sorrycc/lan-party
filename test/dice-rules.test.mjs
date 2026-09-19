/* Loaded Dice's duel rules: the bars the host deals, how a press is graded, how two rolled actions meet, and a whole match played
   headless from a seed, the way the host plays it. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanPick } from '../client/games/dice/bar.js';
import { ACTS, DIE_STEPS, TO_HIT, MAX_SPEED, dieForRound, genSlots, gradePress, mkDuelist, playRound, resolveDuel, rollFor, speedOf } from '../client/games/dice/rules.js';
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
  assert.deepEqual(cleanPick({ n: 4, u: 7 }), { n: 4, u: 2, u2: -1 }); assert.deepEqual(cleanPick({ n: 4, u: -9, u2: 1.5 }), { n: 4, u: -1, u2: 1.5 }); assert.deepEqual(cleanPick({ n: 4, u: 0.5, u2: 'x' }), { n: 4, u: 0.5, u2: -1 }); assert.equal(cleanPick({ n: 4, u: 'x' }), null); assert.equal(cleanPick({ n: 1.5, u: 0.2 }), null); assert.equal(cleanPick(null), null);
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
  assert.equal(b.dmg, 0); assert.equal(a.dmg, 0); assert.deepEqual(said(b), ['block']); assert.equal(b.fx, 'block');
  [a, b] = resolveDuel(roll('skull', 4), roll('shield', 5)); // the skull breaks it and dazes
  assert.equal(b.dmg, 1); assert.equal(b.daze, true); assert.deepEqual(said(b), ['break']);
  [a, b] = resolveDuel(roll('sword', 4), roll('skull', 5)); // the sword lands on the skull, who still dazes
  assert.equal(b.dmg, 1); assert.equal(a.daze, true); assert.equal(a.dmg, 0);
});

test('a roll under the bar to hit does nothing, a 6 hits harder, a top face crits, breaks a block and is parried by another', () => {
  let [a, b] = resolveDuel(roll('sword', TO_HIT - 1), roll('heart', TO_HIT - 1));
  assert.equal(b.dmg, 0); assert.equal(b.heal, 0); assert.deepEqual(said(a), ['whiff']); assert.deepEqual(said(b), ['fizzle']);
  [a, b] = resolveDuel(roll('sword', 6), roll('heart', 3)); assert.equal(b.dmg, 2); assert.equal(b.heal, 1);
  [a, b] = resolveDuel(roll('sword', 8, { crit: true }), roll('shield', 4)); assert.equal(b.dmg, 3); assert.equal(b.hitCrit, true); assert.deepEqual(said(b), ['break']);
  [a, b] = resolveDuel(roll('sword', 8, { crit: true }), roll('shield', 8, { crit: true })); assert.equal(b.dmg, 0); assert.equal(a.dmg, 1); assert.deepEqual(said(b), ['parry']);
});

test('two attacks clash: the higher roll lands, a top face beats any roll, a tie cancels both', () => {
  let [a, b] = resolveDuel(roll('sword', 5), roll('plain', 4)); assert.equal(b.dmg, 1); assert.equal(a.dmg, 0);
  [a, b] = resolveDuel(roll('sword', 4, { crit: true }), roll('sword', 5)); assert.equal(b.dmg, 2); assert.equal(a.dmg, 0);
  [a, b] = resolveDuel(roll('sword', 5), roll('sword', 5)); assert.equal(a.dmg + b.dmg, 0); assert.equal(a.fx, 'clash'); assert.equal(b.fx, 'clash');
  [a, b] = resolveDuel(roll('miss', 1), roll('miss', 1)); assert.equal(a.dmg + b.dmg, 0); assert.deepEqual(said(a), ['missed']);
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

/* ---- the spice: jackpot and bomb, the fever ---- */
import { FEVER_MAX, JACKPOT_RIG, SPICES, featsFor, isHot, perfOf } from '../client/games/dice/rules.js';

test('classic is the seven slots and nothing else; std brings the rest in by level; wild has it all at once', () => {
  assert.deepEqual(featsFor('classic', 9), { jackpot: false, fever: false, bars: false, acts: false, faces: false, fog: false, fake: false, double: false, tricks: false, odds: 1 }); assert.equal(featsFor('std', 1).bars, false); assert.equal(featsFor('std', 2).bars, true); assert.equal(featsFor('std', 2).fog, false); assert.equal(featsFor('std', 3).fake, true); assert.deepEqual(featsFor('junk', 9), featsFor('classic'));
  assert.equal(featsFor('std', 1).jackpot, true); assert.equal(featsFor('wild', 1).odds, 1.6);
  const R = makeRng(21).rnd, f = mkDuelist(5); f.hp = 3;
  for (let i = 0; i < 500; i++) for (const s of genSlots(R, f, 1 + i % 5)) assert.ok(ACTS.slice(0, 7).includes(s.k), s.k);
  let ink = 0; for (let i = 0; i < 300; i++) if (genSlots(R, f, 5, null, featsFor('std', 3)).some(s => s.k === 'smoke')) ink++; assert.ok(ink > 10);
  assert.deepEqual(defaultOpts(GAMES.find(g => g.id === 'dice')).spice, 'std'); for (const c of GAMES.find(g => g.id === 'dice').options.find(o => o.key === 'spice').choices) assert.ok(SPICES.includes(c.value));
});

test('a sliver of gold turns up now and then, often with a bomb hard against it, and the bar still fits', () => {
  const R = makeRng(4).rnd, f = mkDuelist(5, { slotW: 1.5 }), feat = featsFor('wild'); let gold = 0, beside = 0, alone = 0;
  for (let i = 0; i < 2000; i++) {
    const slots = genSlots(R, f, 1 + i % 5, null, feat), ks = slots.map(s => s.k), j = ks.indexOf('jackpot'), b = ks.indexOf('bomb');
    assert.ok(slots.length >= 1 && slots.length <= 4); assert.equal(new Set(ks).size, ks.length);
    let edge = 0.3 - 1e-9; for (const s of slots) { assert.ok(s.x >= edge - 1e-4, 'no overlap'); edge = s.x + s.w; } assert.ok(edge <= 0.9852, 'fits: ' + edge);
    if (j >= 0) { gold++; assert.ok(slots[j].w < 0.11 && slots.every(q => q.k === 'jackpot' || q.w > slots[j].w), 'the narrowest thing on the bar'); if (b >= 0) { beside++; assert.equal(Math.abs(j - b), 1); const [l, r] = j < b ? [slots[j], slots[b]] : [slots[b], slots[j]]; assert.ok(Math.abs(r.x - l.x - l.w - 0.01) < 2e-4); } } else if (b >= 0) alone++;
    assert.ok(ks.some(k => k !== 'jackpot' && k !== 'bomb'), 'always a plain move to take');
  }
  assert.ok(gold > 400 && gold < 750, 'gold ' + gold); assert.ok(beside > gold * 0.55 && beside < gold * 0.85); assert.ok(alone > 80);
});

test('the gold is an attack rigged +3 on the top face; a bomb is half a heart, the combo and no move', () => {
  const f = mkDuelist(5), bar = [{ k: 'jackpot', x: 0.5, w: 0.05 }, { k: 'bomb', x: 0.56, w: 0.1 }];
  for (let seed = 1; seed < 50; seed++) { const r = rollFor(makeRng(seed).rnd, f, 12, bar, { slot: 0, grade: 'GOOD' }); assert.equal(r.act, 'sword'); assert.equal(r.jackpot, true); assert.equal(r.bonus, JACKPOT_RIG); assert.equal(r.roll, 12); assert.equal(r.crit, true); }
  let [a, b] = resolveDuel(rollFor(() => 0, f, 6, bar, { slot: 0, grade: 'GOOD' }), roll('shield', 4)); assert.equal(b.dmg, 3); assert.deepEqual(said(a), ['jackpot']);
  [a, b] = resolveDuel(rollFor(() => 0, f, 4, bar, { slot: 0, grade: 'GOOD' }), roll('sword', 4, { crit: true })); assert.equal(b.dmg, 2, 'the gold wins a clash of top faces'); assert.equal(a.dmg, 0);
  const fs = [mkDuelist(5), mkDuelist(5)]; fs[0].combo = 6; fs[0].fever = 4;
  const res = playRound(makeRng(3).rnd, fs, 6, [bar, [{ k: 'heart', x: 0.4, w: 0.2 }]], [0.6, 0.5], featsFor('std'));
  assert.equal(res.r[0].act, 'bomb'); assert.equal(res.r[0].ok, false); assert.equal(fs[0].hp, 9); assert.equal(fs[0].combo, 0); assert.equal(fs[0].fever, 2); assert.equal(fs[1].hp, 10); assert.deepEqual(said(res.out[0]), ['boom']); assert.equal(res.out[0].fx, 'boom');
});

test('the fever fills on good presses and crits, drains on a fumble, and the round after it fills throws two dice', () => {
  const feat = featsFor('std'), bar = [{ k: 'heart', x: 0.4, w: 0.2 }], fs = [mkDuelist(5), mkDuelist(5)], R = makeRng(8).rnd;
  let r1 = playRound(R, fs, 20, [bar, bar], [0.5, 0.41], feat); assert.equal(fs[0].fever, 2 + r1.r[0].crit); assert.equal(fs[1].fever, 1 + r1.r[1].crit);
  fs[0].fever = 1; fs[1].fever = 1; r1 = playRound(R, fs, 20, [bar, bar], [0.1, -1], feat); assert.equal(fs[0].fever, 0, 'a fumble is -2, never under 0'); assert.equal(fs[1].fever, 1 + r1.r[1].crit, 'a plain roll is nothing');
  fs[0].fever = FEVER_MAX; assert.ok(isHot(fs[0])); assert.equal(perfOf(fs[0]), 0.8); assert.equal(perfOf(fs[1]), 0.4);
  const res = playRound(R, fs, 20, [bar, bar], [0.43, 0.43], feat); assert.equal(res.r[0].grade, 'PERFECT', 'the sweet spot is twice as wide'); assert.equal(res.r[1].grade, 'GOOD');
  assert.equal(res.r[0].hot, true); assert.ok(res.r[0].other >= 1 && res.r[0].other <= res.r[0].base); assert.equal(res.r[1].other, 0); assert.equal(fs[0].fever, 0, 'and it starts over');
  let higher = 0; const hot = mkDuelist(5), cold = mkDuelist(5); hot.fever = FEVER_MAX; for (let s = 1; s < 400; s++) higher += rollFor(makeRng(s).rnd, hot, 6, bar, { slot: 0, grade: 'GOOD' }).base - rollFor(makeRng(s).rnd, cold, 6, bar, { slot: 0, grade: 'GOOD' }).base;
  assert.ok(higher > 200, 'two dice roll higher: ' + higher);
  const [, b] = resolveDuel(roll('sword', 4, { hot: true }), roll('heart', 3)); assert.equal(b.dmg, 2, 'a hot hit is +1');
  const ai = mkDuelist(5); ai.ai = true; ai.fever = FEVER_MAX; assert.equal(isHot(ai), false);
  fs[0].fever = 3; playRound(R, fs, 20, [bar, bar], [0.5, 0.5]); assert.equal(fs[0].fever, 0, 'classic has no fever');
});

test('a match of every spice, played headless, ends', () => {
  for (const spice of SPICES) { const R = makeRng(77).rnd, aim = makeRng(78).rnd, fs = [mkDuelist(5), mkDuelist(5)]; let rounds = 0, d = 1;
    while (Math.max(fs[0].wins, fs[1].wins) < 2) { for (const f of fs) { f.hp = f.maxHp; f.combo = 0; f.speedMod = 0; f.dazed = false; f.fever = 0; } const feat = featsFor(spice, d++);
      for (let rn = 1; ; rn++) { assert.ok(++rounds < 3000); const slots = fs.map(f => genSlots(R, f, rn, null, feat)), pos = slots.map(s => { const k = s[Math.floor(aim() * s.length)]; return aim() < 0.15 ? 0.05 : k.x + k.w * aim(); });
        const res = playRound(R, fs, dieForRound(rn, 'grow'), slots, pos, feat); for (const f of fs) assert.ok(f.fever >= 0 && f.fever <= FEVER_MAX && f.hp >= 0); if (res.win !== null) break; } } }
});

/* ---- the leech, the counter, the poison; loaded faces ---- */
import { FACES, MAX_FACES, POISON_T, carve, dealFaces, freeFaces } from '../client/games/dice/rules.js';

test('a leech hits for less and heals, a counter turns an attack back or leaves its owner open, poison bites for three rounds', () => {
  let [a, b] = resolveDuel(roll('leech', 4), roll('heart', 2)); assert.equal(b.dmg, 1); assert.equal(a.heal, 1); assert.deepEqual(said(a), ['leech']);
  [a, b] = resolveDuel(roll('leech', 6), roll('heart', 2)); assert.equal(b.dmg, 1, '2 for the 6, less 1');
  [a, b] = resolveDuel(roll('leech', 4), roll('shield', 4)); assert.equal(b.dmg, 0); assert.equal(a.heal, 0, 'a shield stops it');
  [a, b] = resolveDuel(roll('sword', 6), roll('counter', 4)); assert.equal(b.dmg, 0); assert.equal(a.dmg, 2, 'its own 6 comes back'); assert.deepEqual(said(b), ['counter']); assert.equal(b.daze, false);
  [a, b] = resolveDuel(roll('heart', 4), roll('counter', 4)); assert.equal(b.daze, false, 'a counter that rolled its number and was not swung at costs nothing'); assert.deepEqual(said(b), ['braced']);
  [a, b] = resolveDuel(roll('heart', 4), roll('counter', 2)); assert.equal(b.daze, true, 'a fumbled counter still leaves its owner open'); assert.deepEqual(said(b), ['fumble']);
  [a, b] = resolveDuel(roll('sword', 4), roll('counter', 2)); assert.equal(b.dmg, 1); assert.equal(b.daze, true, 'a counter that does not roll its number is a fumble');
  [a, b] = resolveDuel(roll('skull', 4), roll('counter', 4)); assert.equal(b.daze, true);
  [a, b] = resolveDuel(roll('poison', 4), roll('shield', 5)); assert.equal(b.poison, true); assert.deepEqual(said(b), ['guard', 'poisoned']);
  [a, b] = resolveDuel(roll('sword', 5), roll('poison', 4)); assert.equal(b.dmg, 1); assert.equal(a.poison, true);
  const fs = [mkDuelist(5), mkDuelist(5)], bars = [[{ k: 'poison', x: 0.4, w: 0.2 }], [{ k: 'slow', x: 0.4, w: 0.2 }]], R = () => 0.6; const hp = [];
  playRound(R, fs, 6, bars, [0.5, 0.5]); assert.equal(fs[1].poison, POISON_T); assert.equal(fs[1].hp, 10);
  bars[0] = [{ k: 'slow', x: 0.4, w: 0.2 }]; for (let i = 0; i < 5; i++) { const res = playRound(R, fs, 6, bars, [0.5, 0.5]); hp.push(fs[1].hp); assert.equal(res.out[1].tick, i < POISON_T ? 1 : 0); }
  assert.deepEqual(hp, [9, 8, 7, 7, 7]);
  for (const [x, y] of [['leech', 'counter'], ['poison', 'shield'], ['counter', 'skull'], ['leech', 'sword']]) { const A = roll(x, 5), B = roll(y, 4), [p, q] = resolveDuel(A, B), [q2, p2] = resolveDuel(B, A); assert.deepEqual(p, p2); assert.deepEqual(q, q2); }
});

test('a loaded face fires when the die stops on it and the move came off; the guard face fires on anything taken', () => {
  const f = mkDuelist(5, { faces: { 4: 'vamp' } }), g = mkDuelist(5); assert.deepEqual(g.mods.faces, {}); assert.notEqual(f.mods.faces, mkDuelist(5, { faces: f.mods.faces }).mods.faces, 'never shared');
  const at = (kind, act, n, die = 8) => { const d = mkDuelist(5, { faces: { [n]: kind } }); return rollFor(() => (n - 1.5) / die, d, die, [{ k: act, x: 0.4, w: 0.2 }], { slot: 0, grade: 'GOOD' }); };
  assert.equal(at('vamp', 'sword', 4).roll, 4); assert.equal(at('vamp', 'sword', 4).face, 'vamp'); assert.equal(at('vamp', 'sword', 8).face, '', 'the top face is a crit and nothing else'); assert.equal(at('vamp', 'fast', 4).face, '', 'a move with no die in it');
  let [a, b] = resolveDuel(at('vamp', 'sword', 4), roll('heart', 2)); assert.equal(a.heal, 1); assert.equal(a.face, 'vamp');
  [a, b] = resolveDuel(at('vamp', 'sword', 4), roll('shield', 4)); assert.equal(a.heal, 0); assert.equal(a.face, '', 'blocked: nothing came off');
  [a, b] = resolveDuel(at('double', 'sword', 6), roll('heart', 2)); assert.equal(b.dmg, 4); [a, b] = resolveDuel(at('double', 'heart', 4), roll('slow', 2)); assert.equal(a.heal, 2);
  [a, b] = resolveDuel(at('venom', 'sword', 4), roll('slow', 2)); assert.equal(b.poison, true); [a, b] = resolveDuel(at('lucky', 'sword', 4), roll('slow', 2)); assert.equal(a.fever, 3);
  [a, b] = resolveDuel(at('guard', 'heart', 4), roll('sword', 6)); assert.equal(a.dmg, 1); assert.equal(a.face, 'guard'); [a, b] = resolveDuel(at('guard', 'heart', 4), roll('slow', 6)); assert.equal(a.face, '');
  const fs = [mkDuelist(5, { faces: { 4: 'lucky' } }), mkDuelist(5)]; playRound(() => 2.5 / 8, fs, 8, [[{ k: 'sword', x: 0.4, w: 0.2 }], [{ k: 'slow', x: 0.4, w: 0.2 }]], [0.41, 0.5], featsFor('std', 2)); assert.equal(fs[0].fever, 4, 'a GOOD press and the lucky face');
});

test('three faces at most, never the 1 or one carved already; the cards dealt are three kinds on faces that are free', () => {
  const f = mkDuelist(5), R = makeRng(12).rnd; assert.deepEqual(freeFaces(f, 4), [2, 3, 4, 5, 6]); assert.equal(freeFaces(f, 20).length, 18);
  for (let i = 0; i < 50; i++) { const cards = dealFaces(R, f, 8); assert.equal(cards.length, 3); assert.equal(new Set(cards.map(c => c.kind)).size, 3); for (const c of cards) { assert.ok(FACES.includes(c.kind)); assert.ok(c.face >= 2 && c.face <= 7); } }
  assert.equal(carve(f, { kind: 'vamp', face: 3 }), true); assert.equal(carve(f, { kind: 'double', face: 3 }), false, 'taken'); assert.equal(carve(f, { kind: 'nope', face: 4 }), false); assert.equal(carve(f, { kind: 'vamp', face: 1 }), false); assert.equal(carve(f, null), false);
  carve(f, { kind: 'double', face: 4 }); carve(f, { kind: 'guard', face: 5 }); assert.equal(Object.keys(f.mods.faces).length, MAX_FACES); assert.equal(carve(f, { kind: 'lucky', face: 6 }), false); assert.deepEqual(dealFaces(R, f, 8), []);
});

/* ---- double rounds ---- */
import { cursorAt, gradeAt, isDouble, mkBar, spanOf } from '../client/games/dice/bar.js';

test('a double round crosses the bar twice, takes one press a crossing, never the same slot twice, and adds the two meetings up', () => {
  const slots = [{ k: 'sword', x: 0.4, w: 0.15 }, { k: 'heart', x: 0.7, w: 0.15 }], bar = mkBar(() => 0.99, slots, featsFor('classic'), false, { presses: 2 });
  assert.equal(bar.presses, 2); assert.equal(spanOf(bar), 2); assert.equal(cursorAt(bar, 0.5), 0.5); assert.equal(cursorAt(bar, 1.5), 0.5); assert.equal(gradeAt(bar, 1.475, 0.4).slot, 0);
  assert.equal(mkBar(() => 0.99, [slots[0]], featsFor('classic'), false, { presses: 2 }).presses, 1, 'one slot is no double round');
  let n = 0; const R = makeRng(3).rnd; for (let i = 0; i < 2000; i++) if (isDouble(R, featsFor('std', 3))) n++; assert.ok(n > 160 && n < 330); assert.equal(isDouble(() => 0, featsFor('std', 2)), false);
  const fs = [mkDuelist(5), mkDuelist(5)]; fs[0].hp = 6; const still = [{ k: 'slow', x: 0.4, w: 0.2 }];
  const res = playRound(() => 0.6, fs, 6, [bar, still], [[0.475, 1.775], 0.5]); // a D6 rolls 4: sword 4+2, then heart 4+2
  assert.equal(res.r[0].act, 'sword'); assert.equal(res.r2[0].act, 'heart'); assert.equal(res.r2[1], null); assert.equal(fs[1].hp, 10 - 3); assert.equal(fs[0].hp, 6 + 2); assert.equal(fs[0].combo, 2); assert.deepEqual(said(res.out[0]), ['crit', 'bigheal']); assert.equal(res.out[0].fx2, 'heal');
  const again = playRound(() => 0.6, [mkDuelist(5), mkDuelist(5)], 6, [bar, still], [[0.475, 1.475], 0.5]); assert.equal(again.r2[0].act, 'miss', 'the same slot twice is a fumble');
  const two = playRound(() => 0.6, [mkDuelist(5), mkDuelist(5)], 6, [bar, bar], [[0.475, 1.775], [0.775, 1.475]]); assert.deepEqual(said(two.out[0]), ['crit', 'bigheal']); assert.deepEqual(said(two.out[1]), ['bigheal', 'crit']);
  const late = playRound(() => 0.6, [mkDuelist(5), mkDuelist(5)], 6, [bar, still], [[-1, -1], 0.5]); assert.equal(late.r[0].act, 'plain'); assert.equal(late.r2[0].act, 'plain');
});
