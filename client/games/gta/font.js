/* 5x7 bitmap font shared by the shop signs (world.js) and the canvas HUD (index.js). Bit 4 is the leftmost column. */
export const FONT = {
  A:[14,17,17,31,17,17,17],B:[30,17,17,30,17,17,30],C:[14,17,16,16,16,17,14],D:[30,17,17,17,17,17,30],
  E:[31,16,16,30,16,16,31],F:[31,16,16,30,16,16,16],G:[14,17,16,23,17,17,15],H:[17,17,17,31,17,17,17],
  I:[14,4,4,4,4,4,14],J:[7,2,2,2,2,18,12],K:[17,18,20,24,20,18,17],L:[16,16,16,16,16,16,31],
  M:[17,27,21,21,17,17,17],N:[17,17,25,21,19,17,17],O:[14,17,17,17,17,17,14],P:[30,17,17,30,16,16,16],
  Q:[14,17,17,17,21,18,13],R:[30,17,17,30,20,18,17],S:[15,16,16,14,1,1,30],T:[31,4,4,4,4,4,4],
  U:[17,17,17,17,17,17,14],V:[17,17,17,17,17,10,4],W:[17,17,17,21,21,21,10],X:[17,17,10,4,10,17,17],
  Y:[17,17,10,4,4,4,4],Z:[31,1,2,4,8,16,31],
  '0':[14,17,19,21,25,17,14],'1':[4,12,4,4,4,4,14],'2':[14,17,1,2,4,8,31],'3':[31,2,4,2,1,17,14],
  '4':[2,6,10,18,31,2,2],'5':[31,16,30,1,1,17,14],'6':[6,8,16,30,17,17,14],'7':[31,1,2,4,8,8,8],
  '8':[14,17,17,14,17,17,14],'9':[14,17,17,15,1,2,12],'·':[0,0,0,4,0,0,0],
  ' ':[0,0,0,0,0,0,0],'.':[0,0,0,0,0,12,12],',':[0,0,0,0,12,4,8],"'":[12,4,8,0,0,0,0],'!':[4,4,4,4,4,0,4],
  '?':[14,17,1,2,4,0,4],':':[0,12,12,0,12,12,0],'-':[0,0,0,31,0,0,0],'$':[4,15,20,14,5,30,4],'/':[1,2,4,4,8,16,0],
  '&':[12,18,20,8,21,18,13],'*':[4,14,31,14,10,17,0],'+':[0,4,4,31,4,4,0],'(':[2,4,8,8,8,4,2],')':[8,4,2,2,2,4,8],
  '%':[25,26,2,4,8,19,19],'"':[10,10,0,0,0,0,0],'>':[16,8,4,2,4,8,16],'<':[1,2,4,8,4,2,1],'=':[0,0,31,0,31,0,0],
  '_':[0,0,0,0,0,0,31],'#':[10,31,10,10,10,31,10],'|':[4,4,4,4,4,4,4],
};
/* Chinese on the HUD: the 5x7 face has no hanzi, so a run of CJK characters (full-width punctuation included) is drawn with
   fillText in a bold CJK face sized so a hanzi stands as tall as the pixel capitals (7 * s: the glyph fills ~0.9 of the em),
   with the same one-pixel drop shadow, at whole-pixel positions. Everything else in the string (digits, $, the Latin
   words) stays in the pixel face, so a mixed line like "击杀 3" keeps the HUD's digits. Widths come from a shared measuring
   canvas (node has none: an em per character is close enough for the tests). */
export const CJK_FONT = '"PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Noto Sans CJK SC", "Microsoft YaHei", sans-serif';
const CJK = /[\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]/;
const CJK_RUNS = /[\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]+|[^\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]+/g;
export const hasCJK = str => CJK.test(str);
const cjkPx = s => Math.max(9, Math.round(s * 8));
const cjkFont = s => `bold ${cjkPx(s)}px ${CJK_FONT}`;
let mctx; const widths = new Map();
function measure(str, s) {
  const key = cjkPx(s) + '|' + str; let w = widths.get(key); if (w !== undefined) return w;
  if (mctx === undefined) { try { const c = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : typeof document !== 'undefined' ? document.createElement('canvas') : null; mctx = c ? c.getContext('2d') : null; } catch { mctx = null; } }
  if (mctx) { mctx.font = cjkFont(s); w = Math.ceil(mctx.measureText(str).width); } else w = [...str].length * cjkPx(s);
  if (widths.size > 800) widths.clear(); widths.set(key, w); return w;
}
const runs = str => hasCJK(str) ? str.match(CJK_RUNS) : [str];
const runW = (r, s) => hasCJK(r) ? measure(r, s) + s : r.length * 6 * s; // a hanzi run keeps the one-pixel gap a glyph has after it
export const textW = (str, s) => { let w = 0; for (const r of runs(str)) w += runW(r, s); return w - s; };
export function drawGlyphs(ctx, str, x, y, s, color) {
  ctx.fillStyle = color;
  for (const ch of str) {
    const g = FONT[ch];
    if (g) for (let r = 0; r < 7; r++) { const bits = g[r]; if (!bits) continue;
      for (let c = 0; c < 5; c++) if (bits & (16 >> c)) ctx.fillRect(x + c * s, y + r * s, s, s); }
    x += 6 * s;
  }
}
/* a CJK run, its middle on the pixel capitals' middle */
function drawHan(ctx, str, x, y, s, color) {
  ctx.font = cjkFont(s); ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = color;
  ctx.fillText(str, x, Math.round(y + 3.5 * s + s * 0.15));
}
function drawRuns(ctx, list, x, y, s, color) { for (const r of list) { if (hasCJK(r)) drawHan(ctx, r, x, y, s, color); else drawGlyphs(ctx, r, x, y, s, color); x += runW(r, s); } }
/* Draw `str` in the pixel font (a CJK run in the CJK face); returns its width. */
export function ptext(ctx, str, x, y, s, color, align = 'left', shadow = true) {
  str = String(str).toUpperCase();
  const w = textW(str, s);
  if (align === 'center') x -= w / 2; else if (align === 'right') x -= w;
  x = Math.round(x); y = Math.round(y);
  if (!hasCJK(str)) { if (shadow) drawGlyphs(ctx, str, x + s, y + s, s, 'rgba(0,0,0,0.85)'); drawGlyphs(ctx, str, x, y, s, color); return w; }
  const list = runs(str);
  if (shadow) drawRuns(ctx, list, x + s, y + s, s, 'rgba(0,0,0,0.85)');
  drawRuns(ctx, list, x, y, s, color);
  return w;
}
/* break `str` into lines no wider than `maxW` at scale `s`: at the spaces between words, and anywhere between two hanzi
   (never before a closing mark like ,。!) */
const CLOSERS = /^[,。、!?:;)」』》…·,.!?:;)]/;
export function wrapText(str, maxW, s) {
  const toks = String(str).match(/[\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]|[^\s\u2e80-\u9fff\u3000-\u303f\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef]+|\s+/g) || [];
  const out = []; let line = '';
  for (const tok of toks) {
    const next = line + tok;
    if (line.trim() && !/^\s+$/.test(tok) && !CLOSERS.test(tok) && textW(next.trim().toUpperCase(), s) > maxW) { out.push(line.trim()); line = tok; }
    else line = next;
  }
  if (line.trim()) out.push(line.trim());
  return out;
}
export const ICONS = {
  pistol: ['..........', '.#######..', '.########.', '...##..##.', '...##.....', '..####....', '..####....', '..........'],
  shotgun: ['................', '...........###..', '.#############..', '.##########.#...', '.####..####.....', '.###...##.......', '.##.............', '................'],
  smg: ['..............', '..#########...', '.###########..', '.####.....###.', '..##..##..#...', '......##......', '......##......', '..............'],
  sniper: ['................', '......###.......', '.##############.', '.############.#.', '...##..##.......', '...##..#........', '................', '................'],
  rpg: ['................', '.############.#.', '.##############.', '.############.#.', '.....##..##.....', '.....##..#......', '................', '................'],
};
export function drawIcon(ctx, rows, x, y, s, color) { ctx.fillStyle = color; rows.forEach((r, j) => { for (let i = 0; i < r.length; i++) if (r[i] === '#') ctx.fillRect(x + i * s, y + j * s, s, s); }); }
