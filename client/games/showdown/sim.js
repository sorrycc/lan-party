/* Sundown Showdown: the host's simulation. Free of three.js and the DOM so node can test it.

   One match: everybody picks a brawler, a countdown, then the showdown until one brawler is left (or no human is),
   a second of slow motion, and the standings. The simulation never draws or plays anything: whatever should be seen or
   heard is pushed to `S.events` as a short array, and the game module turns the same events into particles, numbers
   and sounds on the host and, carried by the snapshots, on every client.

   Events: ['c', n] countdown number · ['go'] · ['a', i, angle, super] brawler i attacks
     ['b', id, i, x, z, angle, speed, range, kind] a bullet (BULLETS[kind]) · ['bx', id, x, z] it is gone
     ['o', i, x0, z0, x1, z1, dur, height, radius, delay] a lobbed bomb · ['de', i] a bull rush ends
     ['d', i, amount, by, x, z, silent] damage · ['k', i, by, rank] a death (by -1: the gas)
     ['bd', box, amount, hp, by] a power box is hit (hp 0: it breaks) · ['cr', ti, tj] a crate breaks
     ['q', id, x0, z0, x1, z1] a power cube drops · ['p', id, i] brawler i picks it up · ['g', stage] the gas closes in */
import { E, CRATE, GRASS, BOX, N, ti, tx, wx, blocksMove, blocksShot } from './map.js';

export const STEP = 1 / 60, PICK_TIME = 20, COUNT_AT = [.2, 1.05, 1.9], GO_AT = 2.75, END_TIME = 1.3, CUBE_HP = 400, CUBE_FLY = .45;
export const GAS_R = [52, 31, 23, 16, 10, 5, 1.5];
/* the four brawlers. `bars` are the pick card's health, range and damage; speed and reload are measured across the four
   (statBars). Their names and words are in strings.js under the class id. */
export const CLASSES = [
  { id: 'buck', color: 0xe8503a, hat: 0x7a3b12, hp: 3800, speed: 7.3, range: 8.5, dmg: 220, pellets: 5, spread: .46, reload: 1.45, cd: .42, bspeed: 26, need: 2200,
    bars: [.58, .42, .78] },
  { id: 'viper', color: 0x3d7bff, hat: 0x1d2c5e, hp: 2600, speed: 7.3, range: 17, dmg: 760, pellets: 1, spread: 0, reload: 1.9, cd: .5, bspeed: 42, need: 2300,
    bars: [.38, 1, .7] },
  { id: 'boomer', color: 0x9b4dff, hat: 0x2b2b2b, hp: 3000, speed: 6.9, range: 12, dmg: 700, radius: 2.5, reload: 1.85, cd: .55, need: 2400, lob: true,
    bars: [.45, .7, .85] },
  { id: 'brick', color: 0x2fbf71, hat: 0xd9d9d9, hp: 6400, speed: 8.1, range: 3.8, dmg: 600, arc: 1.9, reload: .85, cd: .34, need: 2700, melee: true,
    bars: [1, .2, .65] },
];
/* how a bullet looks and what it goes through: buckshot, a slug, and the two supers */
export const BULLETS = [
  { color: 0xffb347, r: .2, len: 2 }, { color: 0x6fd0ff, r: .24, len: 4 },
  { color: 0xffe14d, r: .3, len: 2, breaks: true, kb: 9, bright: 3.2 }, { color: 0xff4fd8, r: .55, len: 5, pierce: true, breaks: true, kb: 5, bright: 3.5 },
];
/* how far in front of a brawler its weapon ends, per class: where a bullet starts and a muzzle flashes */
export const MUZZLE = [1.6, 2.3, .9, 1.4];
/* the pick card's five bars, 0..1: health, range, damage as set above, then speed and reload speed spread over the four brawlers
   (the slowest a quarter full, the fastest full) */
const spread = (v, vs) => { const lo = Math.min(...vs), hi = Math.max(...vs); return hi > lo ? .25 + .75 * (v - lo) / (hi - lo) : 1; };
export const statBars = c => [...c.bars, spread(c.speed, CLASSES.map(k => k.speed)), spread(-c.reload, CLASSES.map(k => -k.reload))];
/* CPU skill: seconds before the first shot at a new target, aim error, the pause between shots, how well it leads, and bombs:
   how long before one lands it is noticed (`see`) and the odds it is dodged at all (`dodge`) */
export const SKILL = { easy: { react: .95, err: 1.7, cad: 1.45, lead: .3, see: .4, dodge: .35 }, normal: { react: .55, err: 1, cad: 1, lead: 1, see: .7, dodge: .8 }, hard: { react: .3, err: .5, cad: .7, lead: 1.2, see: 1.1, dodge: 1 } };
/* out of the fight (not hurt for HEAL_DELAY s, not attacking for HEAL_IDLE s) a brawler heals HEAL_RATE of its max health a
   second, ramping up to it over HEAL_RAMP s. The same for CPU brawlers and people. */
export const HEAL_DELAY = 3, HEAL_IDLE = 2.5, HEAL_RATE = .07, HEAL_RAMP = 1.5;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v, lerp = (a, b, t) => a + (b - a) * t;
const r2 = v => Math.round(v * 100) / 100;
export const angDiff = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
export const dmgMul = b => 1 + b.cubes * .1;
/* tall grass hides a brawler from anyone farther than this, until it shoots or is hit */
export const GRASS_SIGHT = 4.6;
export const hiddenFrom = (e, d) => e.inGrass && d >= GRASS_SIGHT && !(e.reveal > 0 || e.revealed);

export function createSim({ map, roster, opts = {}, online = false, rand = Math.random }) {
  const R = rand, RR = (a, b) => a + R() * (b - a), tiles = map.tiles, boxes = map.boxes, sk = SKILL[opts.botSkill] || SKILL.normal;
  const S = { map, roster, state: 'pick', time: 0, pickT: online ? PICK_TIME : Infinity, picks: roster.map(r => ({ cls: r.cls >= 0 ? r.cls : 0, ok: !r.human })),
    brawlers: [], bullets: [], bombs: [], cubes: [], boxes, gas: { r: GAS_R[0], stage: 0, timer: 16, phase: 'wait', from: GAS_R[0], dur: 1 }, events: [], slow: 1, countT: 0, countN: 0, endT: 0, result: null };
  const emit = (...e) => S.events.push(e);
  let nextId = 1;

  /* ---------------------------------------------------------------- the match's stages */
  function pick(i, cls, ok) { const p = S.picks[i]; if (S.state !== 'pick' || !p || p.ok) return; p.cls = clamp(cls | 0, 0, CLASSES.length - 1); p.ok = !!ok; }
  function begin() {
    const sp = [...map.spawns]; for (let i = sp.length - 1; i > 0; i--) { const j = Math.floor(R() * (i + 1)); [sp[i], sp[j]] = [sp[j], sp[i]]; }
    S.brawlers = roster.map((slot, i) => {
      const cls = S.picks[i].cls, c = CLASSES[cls], s = sp[i % sp.length], a = Math.atan2(-s.x, -s.z);
      return { i, pid: slot.pid, human: slot.human, name: slot.name, cls, c, x: s.x, z: s.z, kx: 0, kz: 0, dir: a, mvx: 0, mvz: 0, hp: c.hp, maxhp: c.hp, cubes: 0, ammo: 3, cd: 0, sup: 0, alive: true,
        inGrass: false, reveal: 0, lastHurt: -9, lastAct: -9, kills: 0, r: .78, dash: null, gasTick: 0, dealt: 0, rank: 0, ack: 0, in: { mx: 0, mz: 0, a, d: 6, fire: false, q: 0 }, fireQ: null, supQ: null,
        ai: { think: R() * .3, target: null, strafe: R() < .5 ? 1 : -1, strafeT: 0, aimErr: 0, mode: 'roam', wander: null, wp: null, box: null, react: 0, fireT: 0, stuck: 0, lx: s.x, lz: s.z, bombs: new Map() } };
    });
    S.state = 'countdown'; S.countT = 0; S.countN = 0; S.time = 0;
  }
  function finish() { if (S.state !== 'play') return; S.state = 'end'; S.endT = END_TIME; S.slow = .3; }
  function conclude() {
    /* whoever is still standing shares the top of the table, healthiest first */
    const left = S.brawlers.filter(b => b.alive).sort((a, b) => b.hp / b.maxhp - a.hp / a.maxhp); left.forEach((b, k) => { b.rank = k + 1; });
    S.result = [...S.brawlers].sort((a, b) => a.rank - b.rank).map(b => [b.i, b.rank, b.kills, b.cubes, Math.round(b.dealt)]);
    S.state = 'result'; S.slow = 1;
  }

  /* ---------------------------------------------------------------- damage, deaths, power cubes */
  function destroyCrate(i, j) { const k = ti(i, j); if (tiles[k] !== CRATE) return; tiles[k] = E; emit('cr', i, j); }
  function damage(t, amount, src, hx, hz, silent) {
    if (S.state !== 'play') return; amount = Math.round(amount);
    if (t.isBox) {
      if (t.dead) return; t.hp = Math.max(0, t.hp - amount); emit('bd', t.k, amount, t.hp, src ? src.i : -1);
      if (t.hp <= 0) { t.dead = true; tiles[ti(t.i, t.j)] = E; spawnCube(t.x, t.z, t.x + RR(-.5, .5), t.z + RR(-.5, .5)); }
      return;
    }
    if (!t.alive) return;
    t.hp -= amount; t.lastHurt = S.time; t.reveal = Math.max(t.reveal, 1.2);
    emit('d', t.i, amount, src ? src.i : -1, r2(hx ?? t.x), r2(hz ?? t.z), silent ? 1 : 0);
    if (src && src !== t && src.alive) { src.sup = Math.min(1, src.sup + amount / dmgMul(src) / src.c.need); src.dealt += amount; }
    if (!t.human && src && src !== t && src.alive) { t.ai.target = src; t.ai.react = 0; }
    if (t.hp <= 0) kill(t, src);
  }
  function kill(b, src) {
    b.alive = false; b.hp = 0; b.dash = null; const alive = S.brawlers.filter(o => o.alive); b.rank = alive.length + 1;
    const n = Math.min(5, Math.max(1, b.cubes)); for (let k = 0; k < n; k++) { const a = R() * 6.28, d = RR(.6, 1.8); spawnCube(b.x, b.z, b.x + Math.cos(a) * d, b.z + Math.sin(a) * d); }
    const by = src && src !== b ? src : null; if (by && by.alive) by.kills++;
    emit('k', b.i, by ? by.i : -1, b.rank);
    if (alive.length <= 1 || !alive.some(o => o.human)) finish(); // a showdown nobody is playing any more is over
  }
  function spawnCube(x0, z0, x1, z1) {
    for (let k = 0; k < 12 && blocksMove(map.tileAt(x1, z1)); k++) { const a = R() * 6.28; x1 = x0 + Math.cos(a) * RR(1.6, 2.6); z1 = z0 + Math.sin(a) * RR(1.6, 2.6); } // land on walkable ground
    if (blocksMove(map.tileAt(x1, z1))) { x1 = x0; z1 = z0; }
    const c = { id: nextId++, x0, z0, x1, z1, t: 0 }; S.cubes.push(c); emit('q', c.id, r2(x0), r2(z0), r2(x1), r2(z1));
  }
  function updateCubes(dt) {
    for (let i = S.cubes.length - 1; i >= 0; i--) {
      const c = S.cubes[i]; c.t += dt; if (c.t < CUBE_FLY) continue;
      for (const b of S.brawlers) {
        if (!b.alive || Math.hypot(b.x - c.x1, b.z - c.z1) > 1.35) continue;
        b.cubes++; b.maxhp += CUBE_HP; b.hp += CUBE_HP; S.cubes.splice(i, 1); emit('p', c.id, b.i); break;
      }
    }
  }

  /* ---------------------------------------------------------------- projectiles */
  function spawnBullet(o, a, kind, speed, range, dmg) {
    const k = BULLETS[kind], mz = MUZZLE[o.cls] * .7, x = o.x + Math.sin(a) * mz, z = o.z + Math.cos(a) * mz, left = range - mz;
    S.bullets.push({ id: nextId, x, z, a, vx: Math.sin(a) * speed, vz: Math.cos(a) * speed, left, dmg, o, r: k.r + .15, pierce: !!k.pierce, breaks: !!k.breaks, kb: k.kb || 0, hit: new Set() });
    emit('b', nextId++, o.i, r2(x), r2(z), r2(a), r2(speed), r2(left), kind);
  }
  function updateBullets(dt) {
    for (let i = S.bullets.length - 1; i >= 0; i--) {
      const b = S.bullets[i]; let dead = false; const step = Math.hypot(b.vx, b.vz) * dt, n = Math.ceil(step / .45);
      for (let s = 0; s < n && !dead; s++) {
        b.x += b.vx * dt / n; b.z += b.vz * dt / n; b.left -= step / n;
        const ii = tx(b.x), jj = tx(b.z), t = map.tileIJ(ii, jj);
        if (blocksShot(t)) {
          if (t === BOX) { const bx = boxes.find(q => q.i === ii && q.j === jj && !q.dead); if (bx && !b.hit.has(bx)) { b.hit.add(bx); damage(bx, b.dmg, b.o); } if (!b.pierce) dead = true; }
          else if (t === CRATE && b.breaks) destroyCrate(ii, jj);
          else dead = true;
        }
        if (dead) break;
        for (const e of S.brawlers) {
          if (!e.alive || e === b.o || b.hit.has(e)) continue;
          if ((e.x - b.x) ** 2 + (e.z - b.z) ** 2 < (e.r + b.r) ** 2) { b.hit.add(e); damage(e, b.dmg, b.o, b.x, b.z); if (b.kb) { e.kx += Math.sin(b.a) * b.kb; e.kz += Math.cos(b.a) * b.kb; } if (!b.pierce) { dead = true; break; } }
        }
        if (b.left <= 0) dead = true;
      }
      if (dead) { S.bullets.splice(i, 1); emit('bx', b.id, r2(b.x), r2(b.z)); }
    }
  }
  function spawnBomb(o, x1, z1, dmg, radius, delay = 0) {
    const d = Math.hypot(x1 - o.x, z1 - o.z), dur = .55 + d * .035;
    S.bombs.push({ id: nextId++, o, x1, z1, t: -delay, dur, dmg, radius }); emit('o', o.i, r2(o.x), r2(o.z), r2(x1), r2(z1), r2(dur), r2(3.5 + d * .3), radius, r2(delay));
  }
  function updateBombs(dt) {
    for (let i = S.bombs.length - 1; i >= 0; i--) {
      const b = S.bombs[i]; b.t += dt; if (b.t < b.dur) continue; S.bombs.splice(i, 1);
      for (const e of S.brawlers) { if (!e.alive || e === b.o) continue; const d = Math.hypot(e.x - b.x1, e.z - b.z1); if (d < b.radius + e.r * .6) { damage(e, b.dmg, b.o); const k = 7 / (d + .5); e.kx += (e.x - b.x1) * k; e.kz += (e.z - b.z1) * k; } }
      for (const q of boxes) if (!q.dead && Math.hypot(q.x - b.x1, q.z - b.z1) < b.radius + .9) damage(q, b.dmg, b.o);
    }
  }

  /* ---------------------------------------------------------------- attacks. `d` is how far away the aim point is: a lobbed bomb lands there. */
  const canFire = b => b.alive && b.ammo >= 1 && b.cd <= 0 && !b.dash;
  const lobAt = (b, a, d) => { const r = Math.min(b.c.range, Math.max(2, d)); return [b.x + Math.sin(a) * r, b.z + Math.cos(a) * r]; };
  function attack(b, a, d) {
    if (S.state !== 'play' || !canFire(b)) return false; const c = b.c, mul = dmgMul(b);
    b.ammo -= 1; b.cd = c.cd; b.lastAct = S.time; b.reveal = Math.max(b.reveal, .9); b.dir = a; emit('a', b.i, r2(a), 0);
    if (c.melee) meleeHit(b, a, c.range, c.arc, c.dmg * mul, 4);
    else if (c.lob) { const [x, z] = lobAt(b, a, d); spawnBomb(b, x, z, c.dmg * mul, c.radius); }
    else {
      for (let k = 0; k < c.pellets; k++) { const off = c.pellets > 1 ? (k / (c.pellets - 1) - .5) * c.spread + RR(-.03, .03) : 0; spawnBullet(b, a + off, b.cls, c.bspeed * RR(.95, 1.05), c.range, c.dmg * mul); }
      b.kx -= Math.sin(a) * 1.5; b.kz -= Math.cos(a) * 1.5;
    }
    return true;
  }
  function meleeHit(b, a, range, arc, dmg, kb) {
    for (const e of S.brawlers) {
      if (!e.alive || e === b) continue; const dx = e.x - b.x, dz = e.z - b.z, d = Math.hypot(dx, dz);
      if (d < range + e.r && Math.abs(angDiff(Math.atan2(dx, dz), a)) < arc / 2 && map.losShot(b.x, b.z, e.x, e.z)) { damage(e, dmg, b); e.kx += dx / (d || 1) * kb; e.kz += dz / (d || 1) * kb; }
    }
    for (const q of boxes) { if (q.dead) continue; const dx = q.x - b.x, dz = q.z - b.z, d = Math.hypot(dx, dz); if (d < range + 1 && Math.abs(angDiff(Math.atan2(dx, dz), a)) < arc / 2 + .3) damage(q, dmg, b); }
  }
  function superAttack(b, a, d) {
    if (S.state !== 'play' || !b.alive || b.sup < 1 || b.dash) return false; const c = b.c, mul = dmgMul(b);
    b.sup = 0; b.lastAct = S.time; b.reveal = 1.5; b.dir = a; emit('a', b.i, r2(a), 1);
    if (c.id === 'buck') { for (let k = 0; k < 9; k++) spawnBullet(b, a + (k / 8 - .5) * .75, 2, 30, c.range * 1.25, c.dmg * 1.15 * mul); b.kx -= Math.sin(a) * 6; b.kz -= Math.cos(a) * 6; }
    else if (c.id === 'viper') spawnBullet(b, a, 3, 52, c.range * 1.35, c.dmg * 2.1 * mul);
    else if (c.id === 'boomer') { const [cx, cz] = lobAt(b, a, d); for (let k = 0; k < 6; k++) { const an = k / 6 * 6.28, r = k ? 2.6 : 0; spawnBomb(b, cx + Math.cos(an) * r, cz + Math.sin(an) * r, c.dmg * .9 * mul, c.radius, k * .09); } }
    else b.dash = { t: .6, a, hit: new Set() };
    return true;
  }
  function updateDash(b, dt) {
    const d = b.dash; d.t -= dt; const hit = map.moveBy(b, Math.sin(d.a) * 27 * dt, Math.cos(d.a) * 27 * dt, destroyCrate); b.dir = d.a;
    for (const e of S.brawlers) {
      if (!e.alive || e === b || d.hit.has(e)) continue; const dx = e.x - b.x, dz = e.z - b.z, dd = Math.hypot(dx, dz);
      if (dd < 2.2) { d.hit.add(e); damage(e, 1000 * dmgMul(b), b); e.kx += Math.sin(d.a) * 14 + dx / (dd || 1) * 5; e.kz += Math.cos(d.a) * 14 + dz / (dd || 1) * 5; }
    }
    for (const q of boxes) if (!q.dead && !d.hit.has(q) && Math.hypot(q.x - b.x, q.z - b.z) < 2.4) { d.hit.add(q); damage(q, 1300 * dmgMul(b), b); }
    if (b.dash && (d.t <= 0 || (hit && d.t < .5 && blocksMove(map.tileAt(b.x + Math.sin(d.a) * 1.2, b.z + Math.cos(d.a) * 1.2))))) { b.dash = null; emit('de', b.i); }
  }

  /* ---------------------------------------------------------------- CPU brawlers */
  const bfsPar = new Int16Array(N * N), bfsQ = new Int16Array(N * N);
  function pathStep(b, gx, gz) { // the farthest tile along the shortest path that can be walked to in a straight line
    if (map.clearWalk(b.x, b.z, gx, gz)) return { x: gx, z: gz };
    const s = ti(clamp(tx(b.x), 0, N - 1), clamp(tx(b.z), 0, N - 1)), g = ti(clamp(tx(gx), 0, N - 1), clamp(tx(gz), 0, N - 1));
    if (s === g) return { x: gx, z: gz };
    bfsPar.fill(-1); let h = 0, t = 0; bfsQ[t++] = g; bfsPar[g] = g;
    while (h < t) {
      const c = bfsQ[h++]; if (c === s) break; const ci = c % N, cj = (c / N) | 0;
      for (let k = 0; k < 4; k++) { const ni = ci + (k === 0) - (k === 1), nj = cj + (k === 2) - (k === 3); if (ni < 0 || nj < 0 || ni >= N || nj >= N) continue; const n = ti(ni, nj); if (bfsPar[n] !== -1 || (blocksMove(tiles[n]) && n !== s)) continue; bfsPar[n] = c; bfsQ[t++] = n; }
    }
    if (bfsPar[s] === -1) return { x: gx, z: gz };
    let c = bfsPar[s], best = c; for (let k = 0; k < 7 && c !== g; k++) { c = bfsPar[c]; if (map.clearWalk(b.x, b.z, wx(c % N), wx((c / N) | 0))) best = c; }
    return { x: wx(best % N), z: wx((best / N) | 0) };
  }
  function findCover(b, e) {
    let best = null, bs = 1e9;
    for (let k = 0; k < 16; k++) {
      const a = R() * 6.28, d = RR(2.5, 9), x = b.x + Math.cos(a) * d, z = b.z + Math.sin(a) * d; if (blocksMove(map.tileAt(x, z)) || Math.hypot(x, z) > S.gas.r - 3) continue;
      const grass = map.tileAt(x, z) === GRASS, hidden = !map.losShot(x, z, e.x, e.z); if (!grass && !hidden) continue;
      const sc = d - Math.hypot(x - e.x, z - e.z) * .6 + (hidden ? 0 : 2); if (sc < bs) { bs = sc; best = { x, z }; }
    }
    return best;
  }
  function think(b) {
    const ai = b.ai, c = b.c, gasR = S.gas.r; let tgt = null, bs = 1e9;
    for (const e of S.brawlers) {
      if (!e.alive || e === b) continue; const d = Math.hypot(e.x - b.x, e.z - b.z); if (d > (e === ai.target ? 20 : S.time < 14 ? 9 : 14) || hiddenFrom(e, d)) continue;
      const sc = d - (1 - e.hp / e.maxhp) * 6 - (e === ai.target ? 4 : 0) + (e.human && S.time < 25 ? 5 : 0); if (sc < bs) { bs = sc; tgt = e; } // the first seconds belong to the people
    }
    if (tgt !== ai.target) { ai.target = tgt; ai.react = 0; ai.aimErr = RR(-.2, .2) * sk.err; }
    const dc = Math.hypot(b.x, b.z), hpf = b.hp / b.maxhp, td = tgt ? Math.hypot(tgt.x - b.x, tgt.z - b.z) : 99;
    let goal = null, direct = false; ai.mode = 'roam';
    let cube = null, cd = 13; for (const q of S.cubes) { if (q.t < CUBE_FLY) continue; const d = Math.hypot(q.x1 - b.x, q.z1 - b.z); if (d < cd && Math.hypot(q.x1, q.z1) < gasR - 1) { cd = d; cube = q; } }
    if (dc > gasR - 3.5) { ai.mode = 'gas'; const k = Math.max(0, gasR - 9) / Math.max(dc, .1); goal = { x: b.x * k, z: b.z * k }; }
    else if (tgt && (hpf < .34 || (b.ammo < 1 && !c.melee)) && td < tgt.c.range + 5) { ai.mode = 'flee'; goal = findCover(b, tgt); if (!goal) { const dx = b.x - tgt.x, dz = b.z - tgt.z; goal = { x: b.x + dx / td * 6, z: b.z + dz / td * 6 }; } }
    else if (cube && (cd < td * .8 || cd < 4)) { ai.mode = 'cube'; goal = { x: cube.x1, z: cube.z1 }; }
    else if (tgt) {
      ai.mode = 'fight'; const want = c.melee ? 1.2 : c.range * (c.lob ? .75 : .68), see = c.lob || map.losShot(b.x, b.z, tgt.x, tgt.z);
      if (!see || td > want + 1.5) goal = { x: tgt.x, z: tgt.z };
      else { // in range with a clear shot: circle, backing off when too close
        ai.strafeT -= .2; if (ai.strafeT <= 0) { ai.strafeT = RR(.6, 1.6); ai.strafe *= R() < .6 ? -1 : 1; }
        const dx = (tgt.x - b.x) / td, dz = (tgt.z - b.z) / td, back = td < want - 1.5 ? -1 : 0;
        let gx = b.x + (-dz * ai.strafe + dx * back * 1.2) * 3, gz = b.z + (dx * ai.strafe + dz * back * 1.2) * 3;
        if (blocksMove(map.tileAt(gx, gz)) || Math.hypot(gx, gz) > gasR - 2) { ai.strafe *= -1; gx = b.x - dz * ai.strafe * 3; gz = b.z + dx * ai.strafe * 3; }
        goal = { x: gx, z: gz }; direct = true;
      }
    } else {
      let box = null, bd = 20; for (const q of boxes) { if (q.dead || Math.hypot(q.x, q.z) > gasR - 2) continue; const d = Math.hypot(q.x - b.x, q.z - b.z); if (d < bd) { bd = d; box = q; } }
      if (box) { ai.mode = 'box'; ai.box = box; const reach = c.melee ? c.range * .7 : Math.min(c.range * .7, 6); if (bd > reach || !(c.lob || map.losShot(b.x, b.z, box.x - (box.x - b.x) / bd * 1.5, box.z - (box.z - b.z) / bd * 1.5))) goal = { x: box.x, z: box.z }; }
      else {
        const w = ai.wander;
        if (!w || Math.hypot(w.x - b.x, w.z - b.z) < 2 || Math.hypot(w.x, w.z) > gasR - 4 || ai.stuck > 2) { ai.stuck = 0; for (let k = 0; k < 12; k++) { const a = R() * 6.28, d = R() * Math.max(2, gasR - 6), x = Math.cos(a) * d, z = Math.sin(a) * d, t = map.tileAt(x, z); if (blocksMove(t)) continue; ai.wander = { x, z }; if (t === GRASS) break; } }
        goal = ai.wander;
      }
    }
    if (goal) { const lim = gasR - 1.5, gd = Math.hypot(goal.x, goal.z); if (gd > lim && ai.mode !== 'gas') { goal = { x: goal.x * lim / gd, z: goal.z * lim / gd }; } }
    ai.wp = goal ? (direct ? goal : pathStep(b, goal.x, goal.z)) : null;
    if (ai.wp && Math.hypot(b.x - ai.lx, b.z - ai.lz) < .25) { ai.stuck++; if (ai.stuck > 3) { ai.strafe *= -1; ai.wander = null; } } else ai.stuck = 0; ai.lx = b.x; ai.lz = b.z;
  }
  /* a telegraphed bomb: the red ring on the ground. A bomb about to land within reach of this bot (`see` seconds or less, which is
     how early the skill notices) is dodged or not once, by the skill's odds; a dodge runs straight out of the blast, or the
     nearest free way round a wall. Returns the way to run, or null. */
  function dodgeBomb(b) {
    const ai = b.ai; let best = null, bt = 1e9;
    for (const q of S.bombs) {
      if (q.o === b) continue; const left = q.dur - q.t, d = Math.hypot(b.x - q.x1, b.z - q.z1); if (left > sk.see || d > q.radius + b.r + 1) continue;
      if (!ai.bombs.has(q.id)) ai.bombs.set(q.id, R() < sk.dodge); if (ai.bombs.get(q.id) && left < bt) { bt = left; best = { q, d }; }
    }
    if (ai.bombs.size > 24) for (const k of ai.bombs.keys()) { if (!S.bombs.some(q => q.id === k)) ai.bombs.delete(k); }
    if (!best) return null;
    const { q, d } = best, base = d > .05 ? Math.atan2(b.x - q.x1, b.z - q.z1) : Math.atan2(-b.x, -b.z) + ai.strafe, gasR = S.gas.r;
    for (const off of [0, .6, -.6, 1.2, -1.2, 1.8, -1.8]) {
      const a = base + off * ai.strafe, x = b.x + Math.sin(a) * 1.6, z = b.z + Math.cos(a) * 1.6;
      if (!blocksMove(map.tileAt(x, z)) && (Math.hypot(x, z) < gasR || off === 1.8)) return { x: Math.sin(a), z: Math.cos(a) };
    }
    return { x: Math.sin(base), z: Math.cos(base) };
  }
  function updateBot(b, dt) {
    const ai = b.ai, c = b.c; ai.think -= dt; if (ai.think <= 0) { ai.think = .2; think(b); }
    if (b.dash) return;
    let mx = 0, mz = 0; if (ai.wp) { const dx = ai.wp.x - b.x, dz = ai.wp.z - b.z, d = Math.hypot(dx, dz); if (d > .3) { mx = dx / d; mz = dz / d; } }
    const run = S.bombs.length ? dodgeBomb(b) : null; if (run) { mx = run.x; mz = run.z; }
    const sp = c.speed * (run || !(ai.mode === 'roam' || ai.mode === 'box') ? 1 : .85), ox = b.x, oz = b.z; map.moveBy(b, mx * sp * dt, mz * sp * dt); b.mvx = (b.x - ox) / dt; b.mvz = (b.z - oz) / dt;
    const e = ai.target; ai.fireT -= dt;
    if (e && e.alive) {
      ai.react += dt; const dx = e.x - b.x, dz = e.z - b.z, d = Math.hypot(dx, dz), lead = (c.melee ? 0 : c.lob ? (.55 + d * .035) * .8 : d / c.bspeed * .75) * sk.lead;
      const ax = e.x + e.mvx * lead, az = e.z + e.mvz * lead, a = Math.atan2(ax - b.x, az - b.z) + ai.aimErr * (c.melee ? 0 : .6), ad = Math.hypot(ax - b.x, az - b.z);
      b.dir += angDiff(a, b.dir) * Math.min(1, dt * 12);
      const inR = d < (c.melee ? c.range + .2 : c.range * .95), see = c.lob || map.losShot(b.x, b.z, e.x, e.z);
      if (ai.react > sk.react && inR && see && !hiddenFrom(e, d)) {
        if (b.sup >= 1 && ai.fireT <= 0 && (c.id !== 'brick' || d < 10) && (c.id !== 'buck' || d < 6)) { superAttack(b, a, ad); ai.fireT = .5; }
        else if (ai.fireT <= 0 && canFire(b) && (b.ammo >= 2 || d < c.range * .7 || e.hp < c.dmg * 2)) { attack(b, a, ad + RR(-1, 1)); ai.fireT = RR(.55, 1.25) * sk.cad; ai.aimErr = RR(-.34, .34) * sk.err; }
      } else if (b.sup >= 1 && c.id === 'brick' && d < 11 && d > 4 && see && ai.fireT <= 0) { superAttack(b, a, ad); ai.fireT = .5; }
    } else if (ai.mode === 'box' && ai.box && !ai.box.dead) {
      const q = ai.box, dx = q.x - b.x, dz = q.z - b.z, d = Math.hypot(dx, dz), a = Math.atan2(dx, dz); b.dir += angDiff(a, b.dir) * Math.min(1, dt * 10);
      const reach = c.melee ? c.range + .6 : Math.min(c.range * .8, 7.5);
      if (d < reach && ai.fireT <= 0 && canFire(b) && (c.lob || map.losShot(b.x, b.z, q.x - dx / d * 1.5, q.z - dz / d * 1.5))) { attack(b, a, d); ai.fireT = RR(.3, .6) * sk.cad; }
    } else if (mx || mz) b.dir += angDiff(Math.atan2(mx, mz), b.dir) * Math.min(1, dt * 8);
  }

  /* ---------------------------------------------------------------- a human's brawler: the last input it sent, and the shots it queued.
     A shot released a moment too early (still cooling down) waits out the cooldown (the longest is .55 s) instead of being lost. */
  function updateHuman(b, dt) {
    const inp = b.in;
    if (!b.dash) {
      const ox = b.x, oz = b.z; map.moveBy(b, inp.mx * b.c.speed * dt, inp.mz * b.c.speed * dt); b.mvx = (b.x - ox) / dt; b.mvz = (b.z - oz) / dt; b.dir = inp.a;
      if (b.supQ && superAttack(b, b.supQ.a, b.supQ.d)) { b.supQ = null; b.fireQ = null; }
      else if (b.fireQ) { if (attack(b, b.fireQ.a, b.fireQ.d)) b.fireQ = null; }
      else if (inp.fire) attack(b, inp.a, inp.d);
    }
    for (const k of ['supQ', 'fireQ']) if (b[k] && (b[k].t -= dt) <= 0) b[k] = null;
  }
  const bySlot = i => S.brawlers[i] && S.brawlers[i].alive ? S.brawlers[i] : null;
  function setInput(i, inp) { const b = S.brawlers[i]; if (b && b.human) { b.in = inp; b.ack = inp.q; } }
  function queueFire(i, s) { const b = bySlot(i); if (b && b.human) b.fireQ = { a: s.a, d: s.d, t: .6 }; }
  function queueSuper(i, s) { const b = bySlot(i); if (b && b.human && b.sup >= 1) b.supQ = { a: s.a, d: s.d, t: .6 }; }
  /* a player who drops out: their brawler fights on as a CPU, and a pick they never locked in no longer holds the room up */
  function toAI(i) { const slot = roster[i]; if (slot) { slot.human = false; slot.pid = null; } if (S.picks[i]) S.picks[i].ok = true; const b = S.brawlers[i]; if (b) { b.human = false; b.pid = null; } if (S.state === 'play' && !S.brawlers.some(o => o.alive && o.human)) finish(); }

  /* ---------------------------------------------------------------- what every brawler goes through each step */
  function updateBrawler(b, dt) {
    if (b.dash) updateDash(b, dt);
    if (b.kx || b.kz) { map.moveBy(b, b.kx * dt, b.kz * dt); const f = Math.exp(-7 * dt); b.kx *= f; b.kz *= f; if (Math.abs(b.kx) + Math.abs(b.kz) < .05) b.kx = b.kz = 0; }
    for (const o of S.brawlers) { if (o === b || !o.alive) continue; const dx = b.x - o.x, dz = b.z - o.z, d = Math.hypot(dx, dz); if (d < 1.5 && d > .001) { const k = (1.5 - d) * .5; b.x += dx / d * k; b.z += dz / d * k; map.collide(b); } } // bodies shoulder each other apart
    b.cd -= dt; if (b.ammo < 3) b.ammo = Math.min(3, b.ammo + dt / b.c.reload); b.reveal -= dt; b.inGrass = map.tileAt(b.x, b.z) === GRASS;
    const calm = Math.min(S.time - b.lastHurt - HEAL_DELAY, S.time - b.lastAct - HEAL_IDLE); // out of the fight for a moment: heal, slowly at first
    if (calm > 0 && b.hp < b.maxhp) b.hp = Math.min(b.maxhp, b.hp + b.maxhp * HEAL_RATE * Math.min(1, calm / HEAL_RAMP) * dt);
    if (Math.hypot(b.x, b.z) > S.gas.r) { b.gasTick -= dt; if (b.gasTick <= 0) { b.gasTick = .6; damage(b, (260 + S.gas.stage * 110) * (1 + b.cubes * .05), null, b.x, b.z, true); } }
  }
  function updateGas(dt) {
    const g = S.gas; g.timer -= dt;
    if (g.phase === 'wait' && g.timer <= 0 && g.stage < GAS_R.length - 1) { g.phase = 'shrink'; g.from = g.r; g.stage++; g.timer = g.dur = g.stage === 1 ? 14 : 11; emit('g', g.stage); }
    else if (g.phase === 'shrink') { const f = 1 - Math.max(0, g.timer) / g.dur; g.r = lerp(g.from, GAS_R[g.stage], f); if (g.timer <= 0) { g.phase = 'wait'; g.timer = 8; } }
  }

  /* one fixed step of `real` seconds; the end of a match runs in slow motion */
  function step(real) {
    if (S.state === 'pick') { S.pickT -= real; if (S.picks.every(p => p.ok) || S.pickT <= 0) begin(); return; }
    if (S.state === 'result') return;
    if (S.state === 'countdown') {
      S.countT += real; for (const b of S.brawlers) if (b.human) b.dir = b.in.a;
      if (S.countN < COUNT_AT.length && S.countT >= COUNT_AT[S.countN]) { emit('c', 3 - S.countN); S.countN++; }
      if (S.countT >= GO_AT) { S.state = 'play'; S.time = 0; emit('go'); }
      return;
    }
    const dt = real * S.slow; S.time += dt;
    for (const b of S.brawlers) if (b.alive) { if (S.state !== 'play') b.mvx = b.mvz = 0; else if (b.human) updateHuman(b, dt); else updateBot(b, dt); }
    for (const b of S.brawlers) if (b.alive) updateBrawler(b, dt);
    updateBullets(dt); updateBombs(dt); updateCubes(dt); updateGas(dt);
    if (S.state === 'end') { S.endT -= real; if (S.endT <= 0) conclude(); }
  }

  return Object.assign(S, { step, pick, setInput, queueFire, queueSuper, toAI, damage, attack, superAttack, begin });
}
