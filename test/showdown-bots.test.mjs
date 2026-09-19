/* Sundown Showdown: CPU brawlers step out of a telegraphed bomb (as often as their skill says), out-of-combat healing is slow and
   ramps up the same for everyone, and the pick card's speed and reload bars are spread over the four brawlers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeMap, blocksMove } from '../client/games/showdown/map.js';
import { buildRoster } from '../client/games/showdown/net.js';
import { createSim, CLASSES, STEP, GO_AT, HEAL_RATE, HEAL_RAMP, statBars } from '../client/games/showdown/sim.js';

const lcg = (s = 1) => () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const run = (S, seconds) => { for (let k = 0; k < seconds / STEP; k++) S.step(STEP); };
function newSim(botSkill, seed) {
  const s = { players: [{ id: 1, name: 'P1', avatar: 0 }], opts: { botSkill }, seed }, map = makeMap(seed);
  const S = createSim({ map, roster: buildRoster(s), opts: s.opts, rand: lcg(seed) }); S.pick(0, 2, true); run(S, GO_AT + .1); S.events.length = 0; return S;
}
/* one bot alone on open ground (every other brawler out of the way), a bomb about to land on its feet: is it hit? */
function bombOnBot(botSkill, seed) {
  const S = newSim(botSkill, seed), [me, bot] = S.brawlers; me.hp = me.maxhp = 1e9;
  for (const o of S.brawlers.slice(2)) o.alive = false;
  const open = S.map.spawns.find(p => [[2.5, 0], [-2.5, 0], [0, 2.5], [0, -2.5]].every(([dx, dz]) => !blocksMove(S.map.tileAt(p.x + dx, p.z + dz))) && Math.hypot(p.x, p.z) < 40) || S.map.spawns[0];
  bot.x = open.x; bot.z = open.z; me.x = open.x + 30; me.z = open.z; bot.ai.target = null; bot.ai.think = 1;
  S.bombs.push({ id: 9999, o: me, x1: bot.x + .3, z1: bot.z, t: 0, dur: 1.2, dmg: 700, radius: 2.5 }); const hp = bot.hp;
  run(S, 1.25); return bot.hp < hp;
}

test('a hard CPU always walks out of a bomb landing on it, an easy one mostly does not', () => {
  const seeds = Array.from({ length: 12 }, (_, k) => 100 + k * 37);
  const hard = seeds.filter(s => bombOnBot('hard', s)).length, easy = seeds.filter(s => bombOnBot('easy', s)).length;
  assert.equal(hard, 0, 'hard bots got hit ' + hard + ' times');
  assert.ok(easy > hard + 3, `easy bots dodge less (hit ${easy} of ${seeds.length})`);
});

test('out of the fight a brawler heals slowly, ramping up, the same for a person and a CPU', () => {
  for (const who of [0, 1]) {
    const S = newSim('normal', 7), b = S.brawlers[who]; for (const o of S.brawlers) if (o !== b) o.alive = false;
    b.x = 0; b.z = 0; b.ai.think = 99; b.ai.wp = null; b.hp = b.maxhp / 2; b.lastHurt = b.lastAct = S.time; // just hurt: nothing yet
    run(S, 2.9); assert.equal(b.hp, b.maxhp / 2, 'no healing in the fight');
    run(S, .3 + HEAL_RAMP); const early = b.hp - b.maxhp / 2; assert.ok(early > 0 && early < b.maxhp * HEAL_RATE * (HEAL_RAMP + .2) * .7, 'ramps in'); // 1.7 s past the delay, the first 1.5 of them ramping
    const h = b.hp; run(S, 1); assert.ok(Math.abs(b.hp - h - b.maxhp * HEAL_RATE) < b.maxhp * .005, `full rate is ${HEAL_RATE} of max health a second`);
    assert.ok(HEAL_RATE <= .07);
  }
});

test('the pick card shows speed and reload, spread over the four brawlers', () => {
  const bars = CLASSES.map(statBars); assert.ok(bars.every(v => v.length === 5 && v.every(x => x > 0 && x <= 1) && v[3] >= .25 && v[4] >= .25));
  const brick = CLASSES.findIndex(c => c.id === 'brick'), boomer = CLASSES.findIndex(c => c.id === 'boomer');
  assert.equal(bars[brick][3], 1, 'the fastest'); assert.equal(bars[boomer][3], .25, 'the slowest'); assert.equal(bars[brick][4], 1, 'the quickest reload');
});
