/* A small QR code encoder: byte mode, error correction level M, versions 1 to 10 (up to 213 bytes of UTF-8).
   No dependencies, so the lobby can show a scannable join link on a LAN with no internet.
     encodeQr(text) -> { size, modules: Uint8Array }   modules[y * size + x] is 1 for a dark module
     drawQr(canvas, text, { scale, margin })            paints it with a quiet zone, canvas resized to fit */

/* per version, level M: error-correction codewords per block, then the blocks as [count, data codewords] */
const EC = [null,
  [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]],
  [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]],
];
const ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]];
const MAX_VERSION = EC.length - 1;
const dataCodewords = v => EC[v][1].reduce((a, [n, len]) => a + n * len, 0);
const capacity = v => dataCodewords(v) - (v < 10 ? 2 : 3); // mode + length header takes 12 or 20 bits

/* GF(256) arithmetic for Reed-Solomon, primitive polynomial 0x11d */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) { const ng = new Array(g.length + 1).fill(0); for (let j = 0; j < g.length; j++) { ng[j] ^= g[j]; ng[j + 1] ^= mul(g[j], EXP[i]); } g = ng; }
  return g;
}
function rsEncode(data, n) {
  const gen = rsGenerator(n), out = new Uint8Array(n);
  for (const d of data) { const f = d ^ out[0]; out.copyWithin(0, 1); out[n - 1] = 0; if (f) for (let j = 0; j < n; j++) out[j] ^= mul(gen[j + 1], f); }
  return out;
}

/* the final codeword sequence: data blocks interleaved, then their error-correction blocks interleaved */
function codewords(bytes, version) {
  const [ecN, groups] = EC[version], total = dataCodewords(version);
  const bits = []; const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >> i) & 1); };
  put(4, 4); put(bytes.length, version < 10 ? 8 : 16); for (const b of bytes) put(b, 8);
  for (let i = 0; i < 4 && bits.length < total * 8; i++) bits.push(0); // terminator
  while (bits.length % 8) bits.push(0);
  const data = []; for (let i = 0; i < bits.length; i += 8) { let v = 0; for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]; data.push(v); }
  for (let p = 0; data.length < total; p ^= 1) data.push(p ? 0x11 : 0xec);
  const blocks = []; let off = 0;
  for (const [n, len] of groups) for (let i = 0; i < n; i++) { const d = data.slice(off, off + len); off += len; blocks.push({ d, e: rsEncode(d, ecN) }); }
  const out = []; const maxD = Math.max(...blocks.map(b => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecN; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => (x * y) % 2 + (x * y) % 3 === 0,
  (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0,
];

export function encodeQr(text) {
  const bytes = new TextEncoder().encode(String(text));
  let version = 1; while (version <= MAX_VERSION && capacity(version) < bytes.length) version++;
  if (version > MAX_VERSION) throw new Error('QR: text too long');
  const size = version * 4 + 17, mod = new Uint8Array(size * size), fn = new Uint8Array(size * size);
  const at = (x, y) => mod[y * size + x];
  const set = (x, y, v) => { mod[y * size + x] = v ? 1 : 0; fn[y * size + x] = 1; };

  /* function patterns: finders with separators, alignment, timing, the dark module */
  const finder = (cx, cy) => { for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x < 0 || y < 0 || x >= size || y >= size) continue; const d = Math.max(Math.abs(dx), Math.abs(dy)); set(x, y, d <= 3 && d !== 2); } };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  const al = ALIGN[version];
  for (const cy of al) for (const cx of al) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  set(8, size - 8, 1);
  /* reserve the format areas (filled after masking) and write the version block */
  for (let i = 0; i < 9; i++) { if (!fn[i * size + 8]) set(8, i, 0); if (!fn[8 * size + i]) set(i, 8, 0); }
  for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, 0); if (!fn[(size - 8 + i) * size + 8]) set(8, size - 8 + i, 0); }
  if (version >= 7) {
    let rem = version; for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) { const b = (bits >>> i) & 1, a = size - 11 + (i % 3), c = Math.floor(i / 3); set(a, c, b); set(c, a, b); }
  }

  /* data: zigzag upward and downward through column pairs, skipping the vertical timing column */
  const cw = codewords(bytes, version); let bi = 0; const nbits = cw.length * 8;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    const upward = ((right + 1) & 2) === 0;
    for (let v = 0; v < size; v++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = upward ? size - 1 - v : v;
      if (fn[y * size + x]) continue;
      mod[y * size + x] = bi < nbits ? (cw[bi >> 3] >> (7 - (bi & 7))) & 1 : 0; bi++;
    }
  }

  /* try every mask, keep the one with the lowest penalty score */
  const applyMask = m => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y * size + x] && MASKS[m](x, y)) mod[y * size + x] ^= 1; };
  const writeFormat = m => {
    const data = m; let rem = data; for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537); // level M is 00
    const bits = ((data << 10) | rem) ^ 0x5412, b = i => (bits >>> i) & 1;
    for (let i = 0; i <= 5; i++) set(8, i, b(i)); set(8, 7, b(6)); set(8, 8, b(7)); set(7, 8, b(8)); for (let i = 9; i < 15; i++) set(14 - i, 8, b(i));
    for (let i = 0; i < 8; i++) set(size - 1 - i, 8, b(i)); for (let i = 8; i < 15; i++) set(8, size - 15 + i, b(i)); set(8, size - 8, 1);
  };
  let best = 0, bestScore = Infinity;
  for (let m = 0; m < 8; m++) { applyMask(m); writeFormat(m); const s = penalty(mod, size); if (s < bestScore) { bestScore = s; best = m; } applyMask(m); }
  applyMask(best); writeFormat(best);
  return { size, modules: mod, version, mask: best };
}

function penalty(mod, size) {
  let p = 0; const at = (x, y) => mod[y * size + x];
  const runs = get => { let run = 1; for (let i = 1; i < size; i++) { if (get(i) === get(i - 1)) { run++; if (run === 5) p += 3; else if (run > 5) p++; } else run = 1; } };
  for (let y = 0; y < size; y++) runs(x => at(x, y)); for (let x = 0; x < size; x++) runs(y => at(x, y));
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) { const c = at(x, y); if (c === at(x + 1, y) && c === at(x, y + 1) && c === at(x + 1, y + 1)) p += 3; }
  const PAT = [1, 0, 1, 1, 1, 0, 1];
  const finderLike = get => {
    for (let i = 0; i + 7 <= size; i++) {
      let ok = true; for (let j = 0; j < 7 && ok; j++) if (get(i + j) !== PAT[j]) ok = false; if (!ok) continue;
      let before = i >= 4, after = i + 11 <= size;
      for (let j = 1; j <= 4 && before; j++) if (get(i - j)) before = false;
      for (let j = 7; j < 11 && after; j++) if (get(i + j)) after = false;
      if (before || after) p += 40;
    }
  };
  for (let y = 0; y < size; y++) finderLike(x => at(x, y)); for (let x = 0; x < size; x++) finderLike(y => at(x, y));
  let dark = 0; for (let i = 0; i < mod.length; i++) dark += mod[i];
  const total = size * size, k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1; p += Math.max(0, k) * 10;
  return p;
}

export function drawQr(canvas, text, { scale = 4, margin = 4, dark = '#0a0e24', light = '#ffffff' } = {}) {
  const { size, modules } = encodeQr(text); const px = (size + margin * 2) * scale;
  canvas.width = px; canvas.height = px; const c = canvas.getContext('2d');
  c.fillStyle = light; c.fillRect(0, 0, px, px); c.fillStyle = dark;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (modules[y * size + x]) c.fillRect((x + margin) * scale, (y + margin) * scale, scale, scale);
  return { size };
}
