/* Sundown Showdown: the arena and how bodies and shots meet it. Free of three.js and the DOM so node can test it.

   The arena is a square of N x N tiles, T metres each, centred on the origin, drawn from the round's seed so every
   machine builds the same one and it never travels over the network. Everything is placed twice, point-mirrored
   through the centre, so no spawn is luckier than the one opposite. A map is kept only if every spawn reaches every
   other and nearly all open ground is reachable.

   `tiles` changes during a round (crates and power boxes break); whoever owns the map writes the change into it. */
export const T = 2, N = 36, HALF = N * T / 2;
export const E = 0, STONE = 1, CRATE = 2, WATER = 3, GRASS = 4, BOX = 5, WALL = 6;
export const SPAWNS = 10, BOX_HP = 2800;
export const blocksMove = t => t === STONE || t === CRATE || t === WATER || t === BOX || t === WALL;
export const blocksShot = t => t === STONE || t === CRATE || t === BOX || t === WALL; // a shot flies over water
export const ti = (i, j) => j * N + i;
export const tx = x => Math.floor((x + HALF) / T), wx = i => (i + .5) * T - HALF;

const clamp = (v, a, b) => v < a ? a : v > b ? b : v, lerp = (a, b, t) => a + (b - a) * t;
/* mulberry32: the arena's own generator, so the map a seed gives never changes under the rest of the game */
function mulberry(seed) {
  let s = seed >>> 0;
  return () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}

function generate(tiles, rnd) {
  const rr = (a, b) => a + rnd() * (b - a), ri = (a, b) => Math.floor(rr(a, b + 1));
  tiles.fill(E);
  for (let k = 0; k < N; k++) tiles[ti(k, 0)] = tiles[ti(k, N - 1)] = tiles[ti(0, k)] = tiles[ti(N - 1, k)] = WALL;
  const put = (i, j, t) => { for (const [a, b] of [[i, j], [N - 1 - i, N - 1 - j]]) { if (a < 1 || b < 1 || a > N - 2 || b > N - 2) continue; if (tiles[ti(a, b)] === E) tiles[ti(a, b)] = t; } };
  const blob = (ci, cj, r, t) => { for (let j = -4; j <= 4; j++) for (let i = -4; i <= 4; i++) { const d = Math.hypot(i, j) + rr(-.6, .6); if (d < r) put(ci + i, cj + j, t); } };
  for (let k = ri(1, 2); k--;) blob(ri(5, N - 6), ri(5, N / 2), rr(1.3, 2.4), WATER); // ponds
  for (let k = ri(9, 12); k--;) { // stone structures: a row, a column, an L or a block, with a crate in them now and then
    const i = ri(3, N - 4), j = ri(3, N / 2 + 1), shape = ri(0, 3), len = ri(2, 5);
    if (shape === 0) for (let a = 0; a < len; a++) put(i + a, j, rnd() < .22 ? CRATE : STONE);
    else if (shape === 1) for (let a = 0; a < len; a++) put(i, j + a, rnd() < .22 ? CRATE : STONE);
    else if (shape === 2) { const s = rnd() < .5 ? 1 : -1; for (let a = 0; a < len; a++) put(i + a, j, STONE); for (let a = 1; a < len - 1; a++) put(i, j + a * s, rnd() < .3 ? CRATE : STONE); }
    else { put(i, j, STONE); put(i + 1, j, STONE); put(i, j + 1, STONE); put(i + 1, j + 1, rnd() < .5 ? CRATE : STONE); }
  }
  for (let k = ri(7, 10); k--;) { const i = ri(2, N - 3), j = ri(2, N / 2); put(i, j, CRATE); if (rnd() < .5) put(i + (rnd() < .5 ? 1 : 0), j + 1, CRATE); } // loose crates
  for (let k = ri(8, 11); k--;) blob(ri(2, N - 3), ri(2, N / 2 + 1), rr(1.4, 3.2), GRASS); // tall grass
  /* a ring of spawns, each with a cleared 3 x 3 around it (grass may stay: a hidden start is fair game) */
  const spawns = [], a0 = rnd() * 6.28;
  for (let k = 0; k < SPAWNS; k++) {
    const a = a0 + k / SPAWNS * Math.PI * 2 + rr(-.12, .12), rad = rr(12.5, 14.5);
    const i = clamp(Math.round(N / 2 - .5 + Math.cos(a) * rad), 2, N - 3), j = clamp(Math.round(N / 2 - .5 + Math.sin(a) * rad), 2, N - 3);
    for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) { const t = tiles[ti(i + c, j + b)]; if (t !== GRASS && t !== WALL) tiles[ti(i + c, j + b)] = E; }
    spawns.push({ x: wx(i), z: wx(j), i, j });
  }
  /* a clearing in the middle with two power boxes, and more boxes scattered away from the spawns */
  for (let b = -2; b <= 1; b++) for (let c = -2; c <= 1; c++) tiles[ti(N / 2 + c, N / 2 + b)] = E;
  tiles[ti(N / 2 - 1, N / 2 - 1)] = BOX; tiles[ti(N / 2, N / 2)] = BOX;
  let boxes = 2, guard = 0;
  while (boxes < 16 && guard++ < 400) {
    const i = ri(2, N - 3), j = ri(2, N - 3); if (tiles[ti(i, j)] !== E || tiles[ti(N - 1 - i, N - 1 - j)] !== E) continue;
    if (spawns.some(s => Math.hypot(s.i - i, s.j - j) < 3 || Math.hypot(s.i - (N - 1 - i), s.j - (N - 1 - j)) < 3)) continue;
    put(i, j, BOX); boxes += 2;
  }
  return spawns;
}
function connected(tiles, spawns) {
  const seen = new Uint8Array(N * N), q = [ti(spawns[0].i, spawns[0].j)]; seen[q[0]] = 1; let reach = 0, open = 0;
  while (q.length) {
    const c = q.pop(); reach++; const ci = c % N, cj = (c / N) | 0;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const n = ti(ci + di, cj + dj); if (!seen[n] && !blocksMove(tiles[n])) { seen[n] = 1; q.push(n); } }
  }
  for (let k = 0; k < N * N; k++) if (!blocksMove(tiles[k])) open++;
  return spawns.every(s => seen[ti(s.i, s.j)]) && reach > open * .93;
}

export function makeMap(seed) {
  const tiles = new Uint8Array(N * N), rnd = mulberry(seed); let spawns = [];
  for (let attempt = 0; attempt < 30; attempt++) { spawns = generate(tiles, rnd); if (connected(tiles, spawns)) break; }
  const boxes = []; // in tile order, so a box has the same index on every machine
  for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) if (tiles[ti(i, j)] === BOX) boxes.push({ k: boxes.length, i, j, x: wx(i), z: wx(j), hp: BOX_HP, maxhp: BOX_HP, dead: false, isBox: true, r: 1.1 });

  const tileIJ = (i, j) => (i < 0 || j < 0 || i >= N || j >= N) ? WALL : tiles[ti(i, j)];
  const tileAt = (x, z) => tileIJ(tx(x), tx(z));
  /* a straight shot from one point to another, and a body's width of clear ground between two points */
  function losShot(x0, z0, x1, z1) { const d = Math.hypot(x1 - x0, z1 - z0), n = Math.ceil(d / .6); for (let k = 1; k < n; k++) { const t = k / n; if (blocksShot(tileAt(lerp(x0, x1, t), lerp(z0, z1, t)))) return false; } return true; }
  function clearWalk(x0, z0, x1, z1) {
    const d = Math.hypot(x1 - x0, z1 - z0); if (d < .01) return true; const n = Math.ceil(d / .7), px = -(z1 - z0) / d * .7, pz = (x1 - x0) / d * .7;
    for (let k = 0; k <= n; k++) { const t = k / n, x = lerp(x0, x1, t), z = lerp(z0, z1, t); if (blocksMove(tileAt(x, z)) || blocksMove(tileAt(x + px, z + pz)) || blocksMove(tileAt(x - px, z - pz))) return false; }
    return true;
  }
  function rayWall(x, z, a, range) { const dx = Math.sin(a), dz = Math.cos(a); for (let d = .4; d < range; d += .3) if (blocksShot(tileAt(x + dx * d, z + dz * d))) return d; return range; }
  /* push the circle `b` (x, z, r) out of every blocking tile it overlaps. `smash(i, j)` is asked about each crate first:
     a bull rush breaks them instead of stopping. */
  function collide(b, smash) {
    const r = b.r, i0 = tx(b.x - r), i1 = tx(b.x + r), j0 = tx(b.z - r), j1 = tx(b.z + r); let hit = false;
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const t = tileIJ(i, j); if (!blocksMove(t)) continue;
      if (smash && t === CRATE) { smash(i, j); continue; }
      const cx = clamp(b.x, wx(i) - 1, wx(i) + 1), cz = clamp(b.z, wx(j) - 1, wx(j) + 1), dx = b.x - cx, dz = b.z - cz, d2 = dx * dx + dz * dz;
      if (d2 >= r * r) continue; hit = true;
      if (d2 > 1e-6) { const d = Math.sqrt(d2); b.x += dx / d * (r - d); b.z += dz / d * (r - d); }
      else { const ox = b.x - wx(i), oz = b.z - wx(j); if (Math.abs(ox) > Math.abs(oz)) b.x = wx(i) + Math.sign(ox || 1) * (1 + r); else b.z = wx(j) + Math.sign(oz || 1) * (1 + r); }
    }
    return hit;
  }
  /* a shot that ricochets: `q` (x, z, vx, vz) has just stepped from (px, pz) into a tile that stops shots. Put it back and turn it off
     the face it met (both, in a corner). The host and every client run this same code, so the shot flies the same way everywhere. */
  function bounce(q, px, pz) {
    const i0 = tx(px), j0 = tx(pz), i1 = tx(q.x), j1 = tx(q.z); let fx = i1 !== i0 && blocksShot(tileIJ(i1, j0)), fz = j1 !== j0 && blocksShot(tileIJ(i0, j1));
    if (!fx && !fz) fx = fz = true; if (fx) q.vx = -q.vx; if (fz) q.vz = -q.vz; q.x = px; q.z = pz;
  }
  function moveBy(b, dx, dz, smash) { const steps = Math.max(1, Math.ceil(Math.hypot(dx, dz) / .4)); let hit = false; for (let s = 0; s < steps; s++) { b.x += dx / steps; b.z += dz / steps; if (collide(b, smash)) hit = true; } return hit; }

  return { seed: seed >>> 0, tiles, spawns, boxes, tileIJ, tileAt, losShot, clearWalk, rayWall, collide, moveBy, bounce };
}
