/* Dodgeball: a guest's own body is predicted with the host's movement code and reconciled against the host's snapshots, so a
   step shows at once instead of a round trip and the interpolation delay later, and ends up where the host has it. Plus the
   round rules that replaced the old coin flip: sudden death, and a level round settled by players left, then hits. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game, buildRoster, movePlayer } from '../client/games/dodgeball/index.js';

const sfx = new Proxy({}, { get: () => () => {} });
const SESSION = { players: [{ id: 1, name: 'HOST', avatar: 0, team: 'blue' }, { id: 2, name: 'PAL', avatar: 1, team: 'red' }], myId: 2, opts: { fillAI: false } };
const roster = () => buildRoster(SESSION);
const wire = msg => JSON.parse(JSON.stringify(msg));

test('movePlayer runs without a game: accelerates, sprints on stamina, and keeps its own half while the line is up', () => {
  const p = { x: 900, y: 320, vx: 0, vy: 0, r: 16, team: 'red', stamina: 1, sprinting: false, regenT: 0, moving: 0, stillT: 0, face: 0, bob: 0 };
  for (let i = 0; i < 120; i++) movePlayer(p, { x: -1, y: 0, sprint: true }, 1 / 240, false);
  assert.ok(p.vx < -265 * 1.5, 'sprinting speed after half a second');
  assert.ok(p.stamina < 0.85 && p.sprinting);
  for (let i = 0; i < 1200; i++) movePlayer(p, { x: -1, y: 0, sprint: false }, 1 / 240, false);
  assert.equal(p.x, 520 + 19, 'stopped at the centre line');
  for (let i = 0; i < 240; i++) movePlayer(p, { x: -1, y: 0, sprint: false }, 1 / 240, true);
  assert.ok(p.x < 520, 'the line is down: across it');
});

/* a 1v1 over a link with `L` seconds each way: the guest's inputs reach the host L later, the host's snapshots reach the guest L later */
function link(L) {
  const host = new Game(roster(), { opts: SESSION.opts, sfx, isHost: true, online: true, myId: 1, matchId: 9 });
  const pal = new Game(roster(), { opts: SESSION.opts, sfx, isHost: false, online: true, myId: 2, matchId: 9 });
  const hp = host.players.find(p => p.pid === 2), toHost = [], toPal = [], dt = 1 / 60;
  let t = 0, since = 0, frame = 0, want = { x: 0, y: 0, sprint: false }, last = null;
  const hostX = [];
  const tick = () => {
    t += dt; frame++;
    while (toHost.length && toHost[0].at <= t) { const m = toHost.shift(); hp.want = { x: m.x, y: m.y, sprint: !!m.s }; hp.ack = m.q; }
    host.update(dt); hostX.push(hp.x);
    if (frame % 2 === 0) toPal.push({ at: t + L, m: wire(host.packSnapshot()) });
    while (toPal.length && toPal[0].at <= t) pal.applySnapshot(toPal.shift().m, t);
    since += dt; // like the module: on a change, and every 0.4 s besides
    if (!last || last.x !== want.x || last.y !== want.y || since >= 0.4) { last = { ...want }; since = 0; toHost.push({ at: t + L, q: pal.noteSent(t), ...want, s: want.sprint ? 1 : 0 }); }
    pal.predict(want, dt, t); pal.updateClient(dt, t);
  };
  return { host, pal, hp, hostX, run: (n, w) => { if (w) want = w; for (let i = 0; i < n; i++) tick(); }, get frame() { return frame; } };
}

test('a guest sees its own step at once and lands where the host has it', () => {
  const L = 0.1, k = link(L);
  k.run(130);                                              // through the countdown: the whistle has gone on both
  assert.equal(k.pal.phase, 'play');
  const x0 = k.pal.me.x;
  k.run(3, { x: -1, y: 0, sprint: false });
  assert.ok(k.pal.me.x < x0 - 1, 'the body moves in the very frames the key goes down');
  assert.equal(k.hp.x, x0, 'while the host has not heard of it yet');
  k.run(60);
  // steady running: the guest shows where the host will have the body one link-delay from now (interpolating the host would trail
  // it by a whole round trip plus the 80 ms delay, some 75 pixels at running speed)
  const ahead = Math.round(L * 60), f = k.frame, shown = k.pal.me.x;
  k.run(ahead);
  const future = k.hostX[f - 1 + ahead];
  assert.ok(Math.abs(shown - future) < 8, `predicted body tracks the host (${shown} vs ${future})`);
  k.run(60, { x: 0, y: 0, sprint: false });                  // let go, and give the link time to settle
  assert.ok(Math.abs(k.pal.me.x - k.hp.x) < 1, `settles on the host's position (${k.pal.me.x} vs ${k.hp.x})`);
  assert.ok(Math.abs(k.pal.me.y - k.hp.y) < 1);
  assert.ok(Math.abs(k.pal.pred.lag - 2 * L) < 0.06, `the round trip is measured (${k.pal.pred.lag})`);
});

test('a guest knocked out is not predicted: it shows the host', () => {
  const k = link(0.05);
  k.run(130);
  k.hp.alive = false; k.hp.knocked = { t: 0, vx: 0, vy: 0, spin: 0, spinV: 0 };
  k.run(30, { x: -1, y: 0, sprint: false });
  assert.equal(k.pal.me.alive, false);
  assert.ok(Math.abs(k.pal.me.x - k.hp.x) < 1, 'follows the host, not the keys');
});

const host = () => new Game(buildRoster({ ...SESSION, opts: {} }), { opts: {}, sfx, isHost: true, online: true, myId: 1, matchId: 3 });

test('sudden death brings every ball back to the centre line and stops the drain', () => {
  const g = host(); g.phase = 'play'; g.time = 89.99;
  for (const b of g.balls.slice(0, 3)) { g.drainBall(b); b.drainT = 1; }
  g.update(1 / 60);
  assert.equal(g.sudden, true);
  const loose = g.balls.filter(b => b.state !== 'held' && b.state !== 'live');
  assert.ok(g.balls.length === 5 && loose.every(b => b.x === 520), 'five balls, the loose ones on the line');
  const ev = g.events.find(e => e[0] === 'sudden'); assert.ok(ev, 'the sudden event is on the wire');
  const pal = new Game(buildRoster({ ...SESSION, opts: {} }), { opts: {}, sfx, isHost: false, online: true, myId: 2, matchId: 3 });
  pal.applySnapshot(wire(g.packSnapshot()));
  assert.equal(pal.sudden, true);
});

test('a level round goes to more players left, then more hits, and says so', () => {
  const g = host(); g.phase = 'play'; g.time = 119.99;
  g.players.filter(p => p.team === 'red')[0].alive = false;
  g.update(1 / 60);
  const r = g.events.find(e => e[0] === 'round');
  assert.deepEqual([r[1], r[5]], [0, 1], 'blue has more left');

  const h = host(); h.phase = 'play'; h.time = 119.99; h.roundHits.red = 2;
  h.update(1 / 60);
  const r2 = h.events.find(e => e[0] === 'round');
  assert.deepEqual([r2[1], r2[5]], [1, 2], 'red hit more');
  for (const e of [...g.events, ...h.events]) for (const v of e.slice(1)) assert.equal(typeof v, 'number', `event ${e[0]} carries numbers, not words`);
});

test('CPU skill scales aim and reaction; normal is the old range', () => {
  const brains = skill => new Game(buildRoster({ ...SESSION, opts: { botSkill: skill } }), { opts: { botSkill: skill }, sfx, isHost: true, online: false, myId: 1, matchId: 1 }).players.filter(p => p.brain).map(p => p.brain);
  for (const b of brains('normal')) assert.ok(b.accuracy >= 0.62 && b.accuracy <= 0.86 && b.reaction >= 0.1 && b.reaction <= 0.24);
  for (const b of brains('hard')) assert.ok(b.accuracy >= 0.82 && b.reaction <= 0.12);
  for (const b of brains('easy')) assert.ok(b.accuracy <= 0.66 && b.reaction >= 0.2);
  for (const b of brains(undefined)) assert.ok(b.accuracy >= 0.62 && b.accuracy <= 0.86);
});
