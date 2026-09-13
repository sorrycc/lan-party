/* Fable Theft Auto's CPU players (bots.js): the roster every machine draws from the seed, and the brain run headless
   through the host simulation (a stub world with nothing to bump into and a clear line of sight everywhere). */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createSim } from '../client/games/gta/sim.js';
import { rosterOf, withBots, isBot, skillOf, BOT_FILL, BOT_SKILLS, BOT_NAMES, botThink, makeBrain } from '../client/games/gta/bots.js';
import { inArena } from '../client/games/gta/arena.js';
import { GAMES } from '../client/games/registry.js';

const pool = () => ({ alloc() { return 0; }, release() {}, color() {}, hide() {}, set() {}, dirty() {} });
const stubWorld = () => ({ THREE, aabbs: [], nearAabbs: () => [], hasLOS: () => true, pickPool: pool(), pedPools: Array.from({ length: 7 }, pool), gunPool: pool(), carBody: pool(), carCabin: pool(), carWheel: pool(), carLight: pool(), dirtyDynamic() {} });
const humans = n => Array.from({ length: n }, (_, i) => ({ id: 'p' + i, name: 'P' + i, avatar: i }));
const make = (n, opts = {}, seed = 7) => createSim({ W: stubWorld(), session: { players: humans(n), seed }, opts: { minutes: 10, mode: 'deathmatch', ...opts } });
const DT = 1 / 30;
const run = (sim, secs) => { for (let t = 0; t < secs; t += DT) sim.update(DT); };
const snapshot = (sim, i) => { sim.prepareNet(); const m = sim.snapshotFor({ id: 'p' + i, known: new Set(), pl: sim.players[i] }); sim.endNet(); return m; };

test('the roster: humans first, then bots up to four, drawn from the seed the same way twice, with names and colours of their own', () => {
  const dm = { mode: 'deathmatch' };
  const r = rosterOf(humans(1), dm, 42);
  assert.equal(r.length, BOT_FILL); assert.equal(r[0].id, 'p0'); assert.ok(r.slice(1).every(p => p.bot && isBot(p.id)), 'the rest are bots');
  assert.deepEqual(rosterOf(humans(1), dm, 42), r, 'the same seed draws the same bots');
  assert.notDeepEqual(rosterOf(humans(1), dm, 43).map(p => p.name), r.map(p => p.name), 'another seed draws other names');
  const names = new Set(r.map(p => p.name)), avatars = new Set(r.map(p => p.avatar));
  assert.equal(names.size, r.length, 'no two names alike'); assert.equal(avatars.size, r.length, 'no two colours alike'); assert.ok(r.slice(1).every(p => BOT_NAMES.includes(p.name)));
  assert.equal(rosterOf(humans(2), dm, 42).length, BOT_FILL); assert.equal(rosterOf(humans(4), dm, 42).length, 4, 'a full room gets no bots'); assert.equal(rosterOf(humans(6), dm, 42).length, 6);
  assert.equal(rosterOf(humans(1), { mode: 'deathmatch', fillAI: false }, 42).length, 1, 'the fill can be turned off');
  assert.equal(rosterOf(humans(1), { mode: 'sandbox' }, 42).length, 1, 'no bots outside the deathmatch'); assert.equal(rosterOf(humans(1), { mode: 'race' }, 42).length, 1);
  const s = { players: humans(2), opts: dm, seed: 9 }, once = withBots(s), twice = withBots(once);
  assert.deepEqual(twice.players, once.players, 'idempotent: a session that already carries bots draws the same ones again');
  assert.equal(s.players.length, 2, 'the room\'s own list is untouched');
});

test('the lobby: the fill is on by default and the skill is normal; each skill is a real one, and hard aims tighter and sooner than easy', () => {
  const keys = Object.fromEntries(GAMES.find(g => g.id === 'gta').options.map(o => [o.key, o]));
  assert.equal(keys.fillAI.type, 'bool'); assert.equal(keys.fillAI.default, true); assert.equal(keys.botSkill.default, 'normal');
  for (const c of keys.botSkill.choices) assert.ok(BOT_SKILLS[c.value], c.value);
  assert.equal(skillOf({}), BOT_SKILLS.normal); assert.equal(skillOf({ botSkill: 'hard' }), BOT_SKILLS.hard); assert.equal(skillOf({ botSkill: 'nope' }), BOT_SKILLS.normal);
  assert.ok(BOT_SKILLS.hard.aim < BOT_SKILLS.normal.aim && BOT_SKILLS.normal.aim < BOT_SKILLS.easy.aim);
  assert.ok(BOT_SKILLS.hard.react < BOT_SKILLS.easy.react && BOT_SKILLS.hard.cadence < BOT_SKILLS.easy.cadence);
});

test('a deathmatch alone is a deathmatch with the fill on: three bots join, start in the arena on foot, and ride the wire like players', () => {
  const sim = make(1);
  assert.equal(sim.mode, 'deathmatch'); assert.equal(sim.players.length, BOT_FILL); assert.equal(sim.players[0].bot, false); assert.ok(sim.players.slice(1).every(p => p.bot));
  for (const p of sim.players) { assert.ok(inArena(sim.arena, p.ped.x, p.ped.z), 'in the arena'); assert.equal(p.ped.inCar, null, 'on foot'); }
  assert.equal(snapshot(sim, 0).P.length, BOT_FILL, 'a block for every bot');
  assert.equal(sim.players[1].killsOf.length, BOT_FILL, 'the tally knows the bots');
  const off = createSim({ W: stubWorld(), session: { players: humans(1), seed: 7 }, opts: { minutes: 10, mode: 'deathmatch', fillAI: false } });
  assert.equal(off.mode, 'sandbox', 'with the fill off a deathmatch alone is still the sandbox');
});

test('the brain: a bot hunts the nearest player, faces it, shoots once it has reacted, walks when it cannot see, and goes for health when hurt', () => {
  const sim = make(1); const [me, bot] = sim.players; const skill = sim.botSkill;
  me.ped.x = bot.ped.x + 15; me.ped.z = bot.ped.z; // in the open, in range
  let seen = null, shots = 0;
  const ctx = { players: sim.players, pickups: sim.pickups, hasLOS: () => seen !== false, skill, alive: p => p && !p.gone && p.ped && !p.ped.dead, rnd: () => 0.5 };
  bot.brain = makeBrain();
  botThink(bot, ctx, DT); assert.equal(bot.brain.target, me, 'the nearest player is the target'); assert.equal(bot.assist, true);
  assert.ok(Math.abs(bot.camYaw - Math.atan2(me.ped.x - bot.ped.x, me.ped.z - bot.ped.z)) <= skill.aim + 1e-9, 'facing the target, aim error included');
  assert.equal(bot.clicks, 0, 'not before the reaction time');
  for (let t = 0; t < skill.react + 0.1; t += DT) { botThink(bot, ctx, DT); } assert.ok(bot.clicks >= 1, 'then a pistol click');
  const c0 = bot.clicks; for (let t = 0; t < 2; t += DT) botThink(bot, ctx, DT); shots = bot.clicks - c0; assert.ok(shots >= 3 && shots <= 2 / (0.2 * skill.cadence) + 1, 'and a steady cadence: ' + shots);
  seen = false; me.ped.x = bot.ped.x + 120; bot.brain.thinkT = 0; botThink(bot, ctx, DT); // out of sight and far: walk the road grid toward it
  assert.ok(bot.sz > 0 && bot.brain.wps.length >= 1, 'walking a route'); assert.ok(bot.bits & 16, 'sprinting');
  seen = null; bot.ped.health = 30; const hp = sim.debug.spawnPickup(bot.ped.x - 20, bot.ped.z, 'health', 40, 60); bot.brain.thinkT = 0; botThink(bot, ctx, DT);
  assert.deepEqual(bot.brain.goal, { x: hp.x, z: hp.z }, 'hurt: the health crate is the goal'); assert.equal(bot.clicks, bot.brain.clicks, 'and no shooting on the way');
});

test('run headless, the bots fight: they shoot, they kill and get killed, a dry gun is swapped, nobody takes a car, and the round reaches the cap', () => {
  const sim = make(1, { killCap: 10, minutes: 0 }); const bots = sim.players.filter(p => p.bot);
  let shots = 0, kills = 0, botDeaths = 0; const ev = [];
  const onEv = m => { for (const e of m.ev) { if (e[0] === 'shot' && e[1] >= 1) shots++; if (e[0] === 'wasted') ev.push(e); } };
  let secs = 0; while (sim.S.phase === 'play' && secs < 600) { run(sim, 1); secs++; onEv(snapshot(sim, 0)); for (const b of bots) assert.equal(b.ped.inCar, null, 'a bot never takes a car'); }
  for (const b of bots) { kills += b.kills; botDeaths += b.deaths; }
  assert.ok(shots > 20, 'the bots fired: ' + shots); assert.ok(kills > 0, 'the bots killed'); assert.ok(botDeaths > 0, 'and died');
  assert.equal(sim.S.phase, 'over', 'the round ended at the cap after ' + secs + 's'); assert.ok(sim.players.some(p => p.kills >= 10));
  const b = bots[0]; for (const w of b.weapons) { w.ammo = 0; w.reserve = 0; } b.weapons[2].owned = true; b.weapons[2].ammo = 5; b.curW = 0; b.reloadT = 0; b.ped.dead = false; sim.S.phase = 'play';
  run(sim, 0.1); assert.equal(b.curW, 2, 'a gun with nothing left is swapped for one that has');
});
