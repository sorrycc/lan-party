/* The deathmatch's CPU players. Two parts, both pure enough to test in node:

   - the roster: `rosterOf(session, opts)` appends bots to the room's humans until there are BOT_FILL players, when the
     lobby's `fillAI` is on and the mode is the deathmatch. Names and colours come from the round's seed, so the host
     and every client lay out the same list (the bots' bodies travel in the snapshot like anyone's; only their names
     and colours have to agree in advance). Bot ids start with 'bot:' so nobody mistakes one for a network client.
   - the brain: `botThink(pl, ctx, dt)` writes a bot's input where a human's would arrive from the network (the stick,
     the bits, the camera yaw and the click counter), so the sim runs a bot through exactly the movement, the guns,
     the damage, the feed, the killcam and the awards a human gets. A bot walks (it never takes a car), hunts the
     nearest live player, keeps a fighting distance and strafes, routes along the road grid when it cannot see its
     target, goes for a health crate when hurt, and shoots with an aim error, a reaction delay and a cadence set by
     the lobby's `botSkill`. */
import { makeRng } from '../../core/math.js';
import { X, nearestNode, bfsRoute, dist2 } from './world.js';
import { IN } from './motion.js';

export const BOT_FILL = 4; // bots fill the room up to this many players
export const BOT_PREFIX = 'bot:';
export const isBot = id => typeof id === 'string' && id.startsWith(BOT_PREFIX);
export const BOT_NAMES = ['Vinny', 'Rocco', 'Lupe', 'Sal', 'Trixie', 'Duke', 'Marla', 'Ziggy', 'Bruno', 'Cleo', 'Rex', 'Nadia'];
/* what the lobby's skill means: aim error (radians, each side), seconds from seeing a target to shooting at it,
   the pause between shots (a factor on the weapon's own rate), how far away a bot will engage, and how long an SMG burst runs */
export const BOT_SKILLS = {
  easy:   { aim: 0.24, react: 0.9, cadence: 2.2, engage: 34, burst: 0.25 },
  normal: { aim: 0.13, react: 0.5, cadence: 1.4, engage: 44, burst: 0.4 },
  hard:   { aim: 0.05, react: 0.25, cadence: 1.0, engage: 56, burst: 0.6 },
};
export const skillOf = opts => BOT_SKILLS[opts && opts.botSkill] || BOT_SKILLS.normal;
export const fillOn = opts => !opts || opts.fillAI !== false;

/* the round's players: the humans in the room's order, then the bots (only in a deathmatch with the fill on).
   Idempotent: bots already in `players` are dropped and drawn again, so a session that has been through it once is the same the second time. */
export function rosterOf(players, opts, seed = 1) {
  const humans = (players || []).filter(p => !isBot(p.id) && !p.bot);
  if (!opts || opts.mode !== 'deathmatch' || !fillOn(opts)) return humans;
  const n = Math.max(0, BOT_FILL - humans.length); if (!n) return humans;
  const { rnd } = makeRng((seed >>> 0) * 1181783497 + 7);
  const names = [...BOT_NAMES], used = new Set(humans.map(h => h.avatar | 0)), bots = [];
  for (let k = 0; k < n; k++) {
    const name = names.splice(Math.floor(rnd() * names.length), 1)[0];
    let avatar = Math.floor(rnd() * 8), tries = 0; while (used.has(avatar) && tries++ < 8) avatar = (avatar + 1) % 8; used.add(avatar);
    bots.push({ id: BOT_PREFIX + k, name, avatar, bot: true });
  }
  return humans.concat(bots);
}
/* the session as the game sees it: the same object with the roster in place of the room's players */
export const withBots = session => ({ ...session, players: rosterOf(session.players, session.opts || {}, session.seed) });

/* ---------------------------------------------------------------- the brain */
const THINK = 0.25, WANT_D = 11, TOO_CLOSE = 5, HEALTH_SEEK = 45, HEALTH_RANGE2 = 70 * 70, WP_REACH = 3, ROUTE_EVERY = 1.5, STUCK_T = 1, STUCK_D2 = 1, UNSTICK_T = 0.7;
export const makeBrain = () => ({ target: null, goal: null, thinkT: 0, routeT: 0, wps: [], seenT: 0, aimErr: 0, fireT: 0, burstT: 0, strafe: 1, strafeT: 0, clicks: 0, stuckT: 0, sx: 0, sz: 0, unstickT: 0, unstickYaw: 0 });
/* a fresh route along the road grid from where I stand to the goal, without the node behind me: the first node is dropped while I am already nearer the one after it than it is */
function routeTo(P, goal) {
  const wps = bfsRoute(nearestNode(P.x, P.z), nearestNode(goal.x, goal.z)).map(([i, j]) => ({ x: X(i), z: X(j) }));
  while (wps.length > 1 && dist2(P.x, P.z, wps[1].x, wps[1].z) <= dist2(wps[0].x, wps[0].z, wps[1].x, wps[1].z)) wps.shift();
  return wps;
}

/* one tick of a bot's mind. ctx: { players, pickups, hasLOS(ax, az, bx, bz), skill, alive(pl), rnd() } */
export function botThink(pl, ctx, dt) {
  const B = pl.brain || (pl.brain = makeBrain()), P = pl.ped, sk = ctx.skill, rnd = ctx.rnd || Math.random;
  B.thinkT -= dt; B.routeT -= dt; B.fireT -= dt; B.strafeT -= dt;
  if (B.thinkT <= 0) { B.thinkT = THINK;
    // the target: the nearest live player (bot or human) I am not
    let best = null, bd = Infinity;
    for (const o of ctx.players) { if (o === pl || !ctx.alive(o)) continue; const d = dist2(o.ped.x, o.ped.z, P.x, P.z); if (d < bd) { bd = d; best = o; } }
    if (best !== B.target) { B.target = best; B.seenT = 0; }
    // hurt and a health crate near: go for it instead
    B.goal = null;
    if (P.health < HEALTH_SEEK) { let hb = null, hd = HEALTH_RANGE2; for (const p of ctx.pickups) { if (p.kind !== 'health' || p.released) continue; const d = dist2(p.x, p.z, P.x, P.z); if (d < hd) { hd = d; hb = p; } } if (hb) B.goal = { x: hb.x, z: hb.z }; }
    B.aimErr = (rnd() * 2 - 1) * sk.aim;
    if (B.strafeT <= 0) { B.strafe = rnd() < 0.5 ? -1 : 1; B.strafeT = 0.8 + rnd() * 1.2; }
  }
  const T = B.target, TP = T ? T.ped : null;
  const goal = B.goal || (TP ? { x: TP.x, z: TP.z } : null);
  let bits = 0, mx = 0, mz = 0, yaw = P.yaw;
  if (!goal) { pl.bits = 0; pl.sx = pl.sz = 0; return; }
  const gd = Math.hypot(goal.x - P.x, goal.z - P.z), seeGoal = ctx.hasLOS(P.x, P.z, goal.x, goal.z);
  const fighting = !B.goal && TP && seeGoal && gd < sk.engage;
  // where to walk: straight at the goal when I can see it and it is near, else along the road grid
  let wx = goal.x, wz = goal.z;
  if (!(seeGoal && gd < sk.engage * 1.5)) {
    if (B.routeT <= 0 || !B.wps.length) { B.routeT = ROUTE_EVERY; B.wps = routeTo(P, goal); }
    while (B.wps.length && dist2(B.wps[0].x, B.wps[0].z, P.x, P.z) < WP_REACH * WP_REACH) B.wps.shift();
    if (B.wps.length) { wx = B.wps[0].x; wz = B.wps[0].z; }
  } else B.wps.length = 0;
  let dx = wx - P.x, dz = wz - P.z, dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;
  if (fighting) { // face the target, keep the distance, strafe
    yaw = Math.atan2(TP.x - P.x, TP.z - P.z) + B.aimErr; // the stick is relative to the camera yaw, so forward is at the target
    mz = gd > WANT_D ? 1 : gd < TOO_CLOSE ? -1 : 0; mx = B.strafe * 0.8;
    B.seenT += dt;
    const w = pl.weapons[pl.curW], inRange = gd < (w.key === 'shotgun' ? 22 : sk.engage);
    if (B.seenT >= sk.react && inRange && w.ammo > 0 && pl.reloadT <= 0) {
      if (w.auto) { B.burstT -= dt; if (B.burstT <= -sk.burst * 0.6) B.burstT = sk.burst; if (B.burstT > 0) bits |= IN.FIRE; }
      else if (B.fireT <= 0) { B.fireT = w.rate * sk.cadence; B.clicks++; }
    }
  } else { // walking: face the way I go, sprint
    yaw = Math.atan2(dx, dz); mz = 1; bits |= IN.SPRINT; B.seenT = 0;
  }
  // stuck on something while trying to move: sidestep for a moment
  B.unstickT -= dt;
  if (mx || mz) { B.stuckT += dt; if (B.stuckT >= STUCK_T) { if (dist2(P.x, P.z, B.sx, B.sz) < STUCK_D2 && B.unstickT <= 0) { B.unstickT = UNSTICK_T; B.unstickYaw = yaw + (rnd() < 0.5 ? 1 : -1) * Math.PI / 2; B.wps.length = 0; B.routeT = 0; } B.stuckT = 0; B.sx = P.x; B.sz = P.z; } }
  else { B.stuckT = 0; B.sx = P.x; B.sz = P.z; }
  if (B.unstickT > 0) { yaw = B.unstickYaw; mx = 0; mz = 1; bits = IN.SPRINT; }
  pl.camYaw = yaw; pl.camPitch = 0; pl.assist = true; pl.bits = bits; pl.sx = mx; pl.sz = mz; pl.clicks = B.clicks;
}
