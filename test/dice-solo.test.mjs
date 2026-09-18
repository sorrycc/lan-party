/* Loaded Dice's solo run: the CPU ladder, a foe's moves set against the hero's by the same rules a duel uses, the perks as changes
   to the hero's mods, a whole run played headless from a seed, and the two languages' tables. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { DIE_STEPS, genSlots, mkDuelist, mkMods, playRound, resolveDuel, rollFor, speedOf } from '../client/games/dice/rules.js';
import { FOES, foeIntent, foePick, foeTurn, mkFoe, mkHero, slotHint, stealSlot } from '../client/games/dice/foes.js';
import { PERKS, dealPerks } from '../client/games/dice/perks.js';
import { STR, mkT } from '../client/games/dice/strings.js';
import { makeRng } from '../client/core/math.js';

const roll = (act, n, extra = {}) => ({ act, grade: 'GOOD', slot: 0, bonus: 1, base: n, roll: n, ok: n >= 3, crit: false, lucky: false, ...extra });
const said = o => o.say.map(s => s[0]);

test('the ladder repeats with more hearts, a bigger die and a heavier crit every lap', () => {
  const a = mkFoe(0), b = mkFoe(FOES.length), boss = mkFoe(FOES.length - 1), top = mkFoe(FOES.length * 9 - 1);
  assert.equal(a.cfg.id, b.cfg.id); assert.equal(b.f.maxHp, a.f.maxHp + 3); assert.equal(b.die, DIE_STEPS[DIE_STEPS.indexOf(a.die) + 1]);
  assert.equal(a.f.mods.heavy, 0); assert.equal(b.f.mods.heavy, 1); assert.equal(a.f.ai, true); assert.equal(a.f.mods.big6, false);
  assert.ok(boss.cfg.boss); assert.equal(top.die, 20);
});

test('a foe dodges an attack it rolls at least as high as, never a top face; a dazed foe loses its turn', () => {
  let [a, b] = resolveDuel(roll('sword', 4), roll('dodge', 4)); assert.equal(b.dmg, 0); assert.deepEqual(said(b), ['dodge']); assert.equal(b.won, true);
  [a, b] = resolveDuel(roll('sword', 5), roll('dodge', 4)); assert.equal(b.dmg, 1);
  [a, b] = resolveDuel(roll('sword', 6, { crit: true }), roll('dodge', 6)); assert.equal(b.dmg, 3);
  [a, b] = resolveDuel(roll('heart', 4), roll('dodge', 2)); assert.deepEqual(said(b), ['hop']);
  const f = mkFoe(0).f; f.dazed = true; assert.equal(foeIntent(makeRng(1).rnd, f, FOES[0]), 'stun');
  const r = rollFor(makeRng(1).rnd, f, 4, [], foePick(f, 'stun')); assert.equal(r.act, 'stun'); assert.equal(r.ok, false);
  [a, b] = resolveDuel(roll('shield', 4), r); assert.deepEqual(said(b), ['dazed']); assert.equal(a.dmg, 0);
  [a, b] = resolveDuel(roll('sword', 4), r); assert.equal(b.dmg, 1); assert.deepEqual(said(b), []);
});

test('a foe keeps its own bar to hit, a 6 from it is not a harder hit, and its combo is its wins and its die', () => {
  const foe = mkFoe(2).f, hero = mkHero(); assert.equal(foe.mods.toHit, 4);
  const r = rollFor(() => 0.5, foe, 6, [], foePick(foe, 'attack')); assert.equal(r.roll, 4); assert.equal(r.ok, true);
  assert.equal(rollFor(() => 0.4, foe, 6, [], foePick(foe, 'attack')).ok, false, 'a 3 is under its 4');
  const [h] = resolveDuel(roll('heart', 1, { ok: false }), rollFor(() => 0.9, foe, 8, [], foePick(foe, 'attack'))); assert.equal(h.dmg, 2, 'an 8 on a D8 from a foe: 1 + the crit, and nothing for being 6 or more');
  foe.combo = 7; assert.equal(foePick(foe, 'block').bonus, 2); assert.equal(foePick(foe, 'block').act, 'shield');
  playRound(() => 0.99, [hero, foe], [4, 6], [[{ k: 'heart', x: 0.4, w: 0.2 }], []], [-1, foePick(foe, 'attack')]); assert.equal(foe.combo, 8, 'a hit is one more');
  playRound(() => 0.99, [hero, foe], [4, 6], [[{ k: 'sword', x: 0.4, w: 0.2 }], []], [0.5, foePick(foe, 'stun')]); assert.equal(foe.combo, 0, 'and a hit taken is none');
});

test('the hero: >> speeds his own bar, perks change his mods and the rules read them', () => {
  const h = mkHero(), by = id => PERKS.find(p => p.id === id), run = { xpMul: 1, die: 6 };
  let [a, b] = resolveDuel(rollFor(() => 0.5, h, 6, [{ k: 'fast', x: 0.4, w: 0.2 }], { slot: 0, grade: 'GOOD' }), roll('stun', 0, { ok: false }));
  assert.equal(a.speed, 0.35); assert.equal(b.speed, 0); assert.deepEqual(said(a), ['speedup']);
  by('wt').f(h, run); for (let i = 0; i < 50; i++) assert.ok(rollFor(makeRng(i).rnd, h, 6, [], { slot: -1, grade: '' }).base >= 2);
  by('rig').f(h, run); assert.equal(rollFor(() => 0, h, 6, [{ k: 'sword', x: 0.4, w: 0.2 }], { slot: 0, grade: 'PERFECT' }).bonus, 3);
  by('thorn').f(h, run); [a, b] = resolveDuel(rollFor(() => 0.2, h, 6, [{ k: 'shield', x: 0.4, w: 0.2 }], { slot: 0, grade: 'GOOD' }), roll('sword', 4)); assert.equal(b.dmg, 1, 'thorns');
  by('vamp').f(h, run); by('heavy').f(h, run); [a, b] = resolveDuel(rollFor(() => 0.99, h, 4, [{ k: 'sword', x: 0.4, w: 0.2 }], { slot: 0, grade: 'GOOD' }), roll('heart', 1, { ok: false }));
  assert.equal(b.dmg, 3, '1 + the crit + the heavy hand'); assert.equal(a.heal, 1, 'the vampire');
  by('cool').f(h, run); h.combo = 10; assert.ok(Math.abs(speedOf(h) - 1.56) < 1e-9);
  by('wide').f(h, run); const w = genSlots(makeRng(2).rnd, h, 5).reduce((m, s) => Math.max(m, s.w), 0), w0 = genSlots(makeRng(2).rnd, mkHero(), 5).reduce((m, s) => Math.max(m, s.w), 0); assert.ok(Math.abs(w / w0 - 1.15) < 0.01);
  by('xp').f(h, run); assert.equal(run.xpMul, 1.3); by('maxhp').f(h, run); assert.equal(h.maxHp, 8);
  assert.ok(!dealPerks(makeRng(1).rnd, h, run, 99).some(p => p.id === 'vamp' || p.id === 'wt' || p.id === 'rig'), 'a perk taken once is not offered again');
  assert.deepEqual(Object.keys(mkMods()).sort(), Object.keys(h.mods).sort());
});

test('the bar leans against the foe\'s intent', () => {
  const count = intent => { const R = makeRng(9).rnd, h = mkHero(), f = mkFoe(0); let n = 0; for (let i = 0; i < 400; i++) if (genSlots(R, h, 5, slotHint(f.f, f.cfg, intent)).some(s => s.k === 'shield')) n++; return n; };
  assert.ok(count('attack') > count('block') * 1.2);
});

test('a run played headless from a seed ends, and the same seed plays the same run', () => {
  const play = seed => {
    const R = makeRng(seed).rnd, aim = makeRng(seed + 1).rnd, hero = mkHero(), log = []; let die = 4, rounds = 0;
    for (let stage = 0; hero.hp > 0; stage++) {
      const F = mkFoe(stage);
      while (hero.hp > 0 && F.f.hp > 0) {
        assert.ok(++rounds < 5000, 'the run ends');
        const intent = foeIntent(R, F.f, F.cfg), slots = genSlots(R, hero, stage + 1, slotHint(F.f, F.cfg, intent)), k = slots[Math.floor(aim() * slots.length)], r = aim();
        const res = playRound(R, [hero, F.f], [die, F.die], [slots, []], [r < 0.15 ? 0.05 : k.x + k.w * aim(), foePick(F.f, intent)]);
        assert.ok(hero.hp >= 0 && hero.hp <= hero.maxHp && F.f.hp >= 0); assert.ok(speedOf(hero) >= 1 && speedOf(hero) <= 3.6);
        log.push(res.r.map(x => x.act + x.roll).join('/'));
      }
      if (hero.hp > 0 && stage % 2) { dealPerks(R, hero, { xpMul: 1, die })[0].f(hero, { xpMul: 1, die }); die = DIE_STEPS[Math.min(DIE_STEPS.length - 1, DIE_STEPS.indexOf(die) + 1)]; }
    }
    return log.join(' ');
  };
  assert.equal(play(7), play(7)); assert.notEqual(play(7), play(8));
});

test('both languages have every word, and everything the rules can shout is in them', () => {
  assert.deepEqual(Object.keys(STR.zh).sort(), Object.keys(STR.en).sort());
  for (const lang of ['zh', 'en']) for (const k in STR[lang]) { const holes = s => (s.match(/\{\w+\}/g) || []).sort().join(); assert.equal(holes(STR[lang][k]), holes(STR.en[k]), lang + ' ' + k); }
  const acts = ['sword', 'plain', 'shield', 'skull', 'heart', 'fast', 'slow', 'dodge', 'stun', 'miss'], keys = new Set();
  for (const x of acts) for (const y of acts) for (const n of [1, 4, 6]) for (const m of [1, 4, 6]) for (const c of [false, true])
    for (const o of resolveDuel(roll(x, n, { crit: c, fastSelf: n === 1, ok: n >= 3 && x !== 'miss' && x !== 'stun' }), roll(y, m, { ok: m >= 3 && y !== 'miss' && y !== 'stun' }))) for (const [k] of o.say) keys.add(k);
  assert.ok(keys.size > 20); for (const k of keys) { assert.ok(STR.zh[k], 'zh ' + k); assert.ok(STR.en[k], 'en ' + k); }
  for (const f of FOES) assert.ok(STR.zh['name.' + f.id]); for (const p of PERKS) { assert.ok(STR.zh['perk.' + p.id]); assert.ok(STR.zh['perk.' + p.id + '.d']); }
  const t = mkT('zh'); assert.equal(t('stage', { n: 3 }), '第 3 关'); assert.equal(mkT('xx')('hit'), 'HIT'); assert.equal(t('no.such.key'), 'no.such.key');
});

test('every foe has its trick, told as data: a flurry, ink, a stolen slot, a wound-up smash, a jammed bar, slots with no faces, slots that freeze over, a boss who turns and swallows the die', () => {
  const R = makeRng(5).rnd, turns = (stage, n, prep) => { const F = mkFoe(stage); prep && prep(F); const out = []; for (let i = 0; i < n; i++) out.push(foeTurn(R, F)); return { F, out }; };
  let { out } = turns(0, 6); assert.deepEqual(out.map(t => t.trick === 'flurry'), [false, false, true, false, false, true]); assert.equal(out[2].picks.length, 2); assert.equal(out[2].picks[0].act, 'sword'); assert.equal(out[2].intent, 'attack');
  assert.ok(turns(1, 200).out.filter(t => t.fog).length > 30); assert.ok(turns(2, 200).out.filter(t => t.steal).length > 30); const jam = turns(4, 200).out.filter(t => t.bar); assert.ok(jam.length > 50 && jam.every(t => t.bar.v === 'slide' || t.bar.v === 'bounce'));
  const olga = turns(3, 300).out, at = olga.findIndex(t => t.trick === 'charge'); assert.ok(at >= 0); assert.equal(olga[at].picks.act, 'none'); assert.equal(olga[at + 1].trick, 'smash'); assert.equal(olga[at + 1].picks.mul, 2);
  const F = mkFoe(3); F.charged = true; F.f.dazed = true; const t = foeTurn(R, F); assert.equal(t.intent, 'stun'); assert.equal(F.charged, false, 'a skull breaks the wind-up off');
  const hit = resolveDuel({ act: 'heart', roll: 1, ok: false, crit: false }, rollFor(() => 0.5, mkFoe(3).f, 6, [], { act: 'sword', bonus: 0, mul: 2 })); assert.equal(hit[0].dmg, 2);
  const blank = turns(5, 200).out.filter(t => t.blank); assert.ok(blank.length > 40 && blank.every(t => t.trick === 'blank' && !t.bar)); const ice = turns(6, 200).out.filter(t => t.trick === 'freeze'); assert.ok(ice.length > 50 && ice.every(t => t.bar.v === 'shrink'));
  const boss = turns(7, 9, F => { F.f.hp = 4; }); assert.equal(boss.out[0].angry, true); assert.equal(boss.F.die, 12); assert.deepEqual(boss.out.map(t => t.swallow), [false, false, false, true, false, false, false, true, false], 'the round he turns is the first of four');
  assert.ok(turns(0, 30).out.length && !(() => { const F2 = mkFoe(0); for (let i = 0; i < 30; i++) if (foeTurn(R, F2, false).trick) return true; })(), 'classic: no tricks');
  const bar = [{ k: 'sword', x: 0.3, w: 0.2 }, { k: 'bomb', x: 0.55, w: 0.3 }, { k: 'heart', x: 0.9, w: 0.05 }]; assert.deepEqual(stealSlot(bar).map(s => s.k), ['bomb', 'heart']); assert.deepEqual(stealSlot(bar.slice(1)).length, 2, 'never the last real slot');
  const fs = [mkHero(), mkFoe(0).f], res = playRound(() => 0.99, fs, [4, 4], [[{ k: 'heart', x: 0.4, w: 0.2 }], []], [0.5, [foePick(fs[1], 'attack'), foePick(fs[1], 'attack')]]); assert.equal(res.out[0].dmg, 4, 'a flurry of two top faces'); assert.equal(res.r2[1].act, 'sword');
});
