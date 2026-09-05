/* The QR encoder: the symbol's fixed patterns, a readable and self-consistent format block, and codewords that pass
   a Reed-Solomon syndrome check after being read back out of the matrix (so the bit placement and the masking agree). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeQr } from '../client/core/qr.js';

const at = (q, x, y) => q.modules[y * q.size + x];

test('picks the smallest version that fits and sizes the symbol accordingly', () => {
  assert.equal(encodeQr('hi').size, 21);                                  // version 1
  assert.equal(encodeQr('http://192.168.8.112:3000/#ABCD').size, 29);    // 32 bytes: version 3
  assert.equal(encodeQr('x'.repeat(213)).size, 57);                       // version 10 holds 213 bytes at level M
  assert.throws(() => encodeQr('x'.repeat(214)), /too long/);
});

test('finder patterns, timing pattern and the dark module are in place', () => {
  const q = encodeQr('LAN party'); const n = q.size;
  const finder = (cx, cy) => { for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) { const d = Math.max(Math.abs(dx), Math.abs(dy)); assert.equal(at(q, cx + dx, cy + dy), d === 2 ? 0 : 1, `finder ${cx},${cy} at ${dx},${dy}`); } };
  finder(3, 3); finder(n - 4, 3); finder(3, n - 4);
  for (let i = 8; i < n - 8; i++) { assert.equal(at(q, i, 6), i % 2 === 0 ? 1 : 0); assert.equal(at(q, 6, i), i % 2 === 0 ? 1 : 0); }
  assert.equal(at(q, 8, n - 8), 1);
});

test('the format block is valid BCH for level M and names the mask that was applied', () => {
  const q = encodeQr('scan me'); const n = q.size;
  const bits1 = []; for (let i = 0; i <= 5; i++) bits1.push(at(q, 8, i)); bits1.push(at(q, 8, 7), at(q, 8, 8), at(q, 7, 8)); for (let i = 9; i < 15; i++) bits1.push(at(q, 14 - i, 8));
  const bits2 = []; for (let i = 0; i < 8; i++) bits2.push(at(q, n - 1 - i, 8)); for (let i = 8; i < 15; i++) bits2.push(at(q, 8, n - 15 + i));
  assert.deepEqual(bits1, bits2, 'both copies of the format block agree');
  let v = 0; for (let i = 14; i >= 0; i--) v = (v << 1) | bits1[i];
  const raw = v ^ 0x5412; let rem = raw; for (let i = 14; i >= 10; i--) if (rem & (1 << i)) rem ^= 0x537 << (i - 10);
  assert.equal(rem, 0, 'BCH remainder is zero');
  assert.equal(raw >> 13, 0, 'error-correction level M');
  assert.equal((raw >> 10) & 7, q.mask);
});

/* GF(256) for the syndrome check, written independently of the encoder */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{ let x = 1; for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; } for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]; }
const mul = (a, b) => (a && b) ? EXP[LOG[a] + LOG[b]] : 0;
const evalPoly = (cw, alphaPow) => { let y = 0, xp = EXP[alphaPow]; for (const c of cw) y = mul(y, xp) ^ c; return y; };
/* level M block layouts for the versions the encoder supports: [ec per block, [[blocks, data codewords], ...]] */
const EC = [null, [10, [[1, 16]]], [16, [[1, 28]]], [26, [[1, 44]]], [18, [[2, 32]]], [24, [[2, 43]]], [16, [[4, 27]]], [18, [[4, 31]]], [22, [[2, 38], [2, 39]]], [22, [[3, 36], [2, 37]]], [26, [[4, 43], [1, 44]]]];
const MASKS = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0, (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => (x * y) % 2 + (x * y) % 3 === 0, (x, y) => ((x * y) % 2 + (x * y) % 3) % 2 === 0, (x, y) => ((x + y) % 2 + (x * y) % 3) % 2 === 0];

/* read the codewords back out of a symbol: mark the function modules, unmask, walk the zigzag */
function readCodewords(q) {
  const n = q.size, v = q.version, fn = new Uint8Array(n * n), mark = (x, y) => { fn[y * n + x] = 1; };
  for (const [cx, cy] of [[3, 3], [n - 4, 3], [3, n - 4]]) for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) { const x = cx + dx, y = cy + dy; if (x >= 0 && y >= 0 && x < n && y < n) mark(x, y); }
  const al = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34], [6, 22, 38], [6, 24, 42], [6, 26, 46], [6, 28, 50]][v];
  for (const cy of al) for (const cx of al) { if ((cx === 6 && cy === 6) || (cx === 6 && cy === n - 7) || (cx === n - 7 && cy === 6)) continue; for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) mark(cx + dx, cy + dy); }
  for (let i = 0; i < n; i++) { mark(6, i); mark(i, 6); }
  for (let i = 0; i < 9; i++) { mark(8, i); mark(i, 8); } for (let i = 0; i < 8; i++) { mark(n - 1 - i, 8); mark(8, n - 8 + i); }
  if (v >= 7) for (let i = 0; i < 18; i++) { const a = n - 11 + (i % 3), b = Math.floor(i / 3); mark(a, b); mark(b, a); }
  const bits = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; const up = ((right + 1) & 2) === 0;
    for (let k = 0; k < n; k++) for (let j = 0; j < 2; j++) { const x = right - j, y = up ? n - 1 - k : k; if (fn[y * n + x]) continue; bits.push(at(q, x, y) ^ (MASKS[q.mask](x, y) ? 1 : 0)); }
  }
  const cw = []; for (let i = 0; i + 8 <= bits.length; i += 8) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j]; cw.push(b); }
  return cw;
}
/* de-interleave into blocks and check every block's syndromes are zero, then check the payload header and bytes */
function checkSymbol(text) {
  const q = encodeQr(text), [ecN, groups] = EC[q.version], cw = readCodewords(q);
  const blocks = []; for (const [count, len] of groups) for (let i = 0; i < count; i++) blocks.push({ d: [], e: [] });
  const lens = []; for (const [count, len] of groups) for (let i = 0; i < count; i++) lens.push(len);
  const totalData = lens.reduce((a, b) => a + b, 0); let p = 0;
  for (let i = 0; i < Math.max(...lens); i++) for (let b = 0; b < blocks.length; b++) if (i < lens[b]) blocks[b].d.push(cw[p++]);
  assert.equal(p, totalData);
  for (let i = 0; i < ecN; i++) for (let b = 0; b < blocks.length; b++) blocks[b].e.push(cw[p++]);
  for (const b of blocks) { const full = b.d.concat(b.e); for (let s = 0; s < ecN; s++) assert.equal(evalPoly(full, s), 0, `syndrome ${s} of a block is zero`); }
  const data = blocks.flatMap(b => b.d), bytes = new TextEncoder().encode(text);
  assert.equal(data[0] >> 4, 4, 'byte mode');
  const len = q.version < 10 ? ((data[0] & 15) << 4) | (data[1] >> 4) : ((data[0] & 15) << 12) | (data[1] << 4) | (data[2] >> 4);
  assert.equal(len, bytes.length);
  const head = q.version < 10 ? 12 : 20; const bitAt = i => (data[i >> 3] >> (7 - (i & 7))) & 1;
  for (let i = 0; i < bytes.length; i++) { let b = 0; for (let j = 0; j < 8; j++) b = (b << 1) | bitAt(head + i * 8 + j); assert.equal(b, bytes[i], `payload byte ${i}`); }
}
test('codewords read back from the symbol pass the Reed-Solomon check and carry the text', () => {
  for (const text of ['A', 'http://192.168.8.112:3000/#ABCD', 'http://10.0.0.1:3000/#ZZZZ', 'snow ❄ and karts '.repeat(4), 'v'.repeat(120), 'w'.repeat(200)]) checkSymbol(text);
});
