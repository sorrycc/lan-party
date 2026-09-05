/* Draws the home-screen icons (client/icons/icon-*.png) with plain pixel math and writes them as PNGs with node's zlib.
   No dependencies; run `npm run icons` after changing the picture. The picture: a red kart on snow under the aurora. */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'client', 'icons');
const SIZES = [180, 192, 512];

/* ---- the picture, in unit coordinates (u right, v down); returns [r, g, b] for a point */
const mix = (a, b, t) => a.map((c, i) => c + (b[i] - c) * t);
const inRect = (u, v, x0, y0, x1, y1) => u >= x0 && u <= x1 && v >= y0 && v <= y1;
const inCircle = (u, v, cx, cy, r) => (u - cx) ** 2 + (v - cy) ** 2 <= r * r;
const inRound = (u, v, x0, y0, x1, y1, r) => { const cx = Math.max(x0 + r, Math.min(x1 - r, u)), cy = Math.max(y0 + r, Math.min(y1 - r, v)); return (u - cx) ** 2 + (v - cy) ** 2 <= r * r; };
const STARS = [[0.12, 0.10, 0.008], [0.30, 0.06, 0.006], [0.55, 0.12, 0.007], [0.88, 0.08, 0.006], [0.72, 0.30, 0.005], [0.18, 0.34, 0.005], [0.94, 0.42, 0.006], [0.42, 0.24, 0.005]];
function shade(u, v) {
  let c = mix([28, 38, 87], [10, 14, 36], Math.min(1, v * 1.4)); // night sky
  const a1 = 1 - Math.min(1, Math.abs(v - (0.30 + 0.06 * Math.sin(u * 7))) / 0.08); c = mix(c, [60, 255, 160], a1 * a1 * 0.55); // aurora
  const a2 = 1 - Math.min(1, Math.abs(v - (0.21 + 0.05 * Math.sin(u * 5 + 1))) / 0.07); c = mix(c, [90, 120, 255], a2 * a2 * 0.4);
  for (const [x, y, r] of STARS) if (inCircle(u, v, x, y, r)) c = [255, 255, 255];
  if (inCircle(u, v, 0.80, 0.19, 0.075)) c = [255, 246, 216]; // moon
  const snowLine = 0.70 + 0.025 * Math.sin(u * 9) + 0.015 * Math.sin(u * 23);
  if (v > snowLine) c = mix([232, 240, 255], [200, 214, 240], Math.min(1, (v - snowLine) * 3)); // snow
  if (v > snowLine && v < snowLine + 0.012) c = [255, 255, 255];
  // the kart, facing right
  if (inCircle(u, v, 0.36, 0.70, 0.085) || inCircle(u, v, 0.64, 0.70, 0.085)) c = [26, 29, 38]; // tyres
  if (inRound(u, v, 0.26, 0.55, 0.74, 0.68, 0.04)) c = [255, 59, 59]; // body
  if (inRound(u, v, 0.66, 0.575, 0.80, 0.645, 0.03)) c = [255, 59, 59]; // nose
  if (inRect(u, v, 0.22, 0.50, 0.30, 0.53)) c = [255, 59, 59]; // spoiler
  if (inRect(u, v, 0.235, 0.53, 0.25, 0.56) || inRect(u, v, 0.28, 0.53, 0.295, 0.56)) c = [30, 34, 48];
  if (inRound(u, v, 0.42, 0.455, 0.58, 0.56, 0.03)) c = [30, 34, 48]; // cockpit
  if (inCircle(u, v, 0.50, 0.455, 0.062)) c = [255, 213, 74]; // helmet
  if (inRect(u, v, 0.48, 0.44, 0.565, 0.465)) c = [24, 28, 40]; // visor
  if (inCircle(u, v, 0.36, 0.70, 0.032) || inCircle(u, v, 0.64, 0.70, 0.032)) c = [200, 208, 224]; // hubs
  if (inRect(u, v, 0.775, 0.59, 0.80, 0.63)) c = [255, 246, 192]; // headlight
  return c;
}

/* ---- rasterise with 3x3 supersampling */
function render(size) {
  const out = Buffer.alloc(size * size * 4), ss = 3;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    let r = 0, g = 0, b = 0;
    for (let j = 0; j < ss; j++) for (let i = 0; i < ss; i++) { const [cr, cg, cb] = shade((x + (i + 0.5) / ss) / size, (y + (j + 0.5) / ss) / size); r += cr; g += cg; b += cb; }
    const o = (y * size + x) * 4, n = ss * ss; out[o] = Math.round(r / n); out[o + 1] = Math.round(g / n); out[o + 2] = Math.round(b / n); out[o + 3] = 255;
  }
  return out;
}

/* ---- PNG writer */
const CRC = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC[n] = c; }
const crc32 = buf => { let c = -1; for (const b of buf) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type, 'ascii'), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body)); return Buffer.concat([len, body, crc]); }
function png(size, rgba) {
  const stride = size * 4, raw = Buffer.alloc((stride + 1) * size);
  for (let y = 0; y < size; y++) { raw[y * (stride + 1)] = 0; rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const s of SIZES) { const file = path.join(OUT, `icon-${s}.png`); fs.writeFileSync(file, png(s, render(s))); console.log('wrote', path.relative(process.cwd(), file)); }
