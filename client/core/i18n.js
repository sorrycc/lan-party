/* Language, shared by the shell and every game: Chinese by default, English from the 中/EN toggle (and each game's own menu).
   One remembered pref (`lan_lang`); Loaded Dice's old `loadedDiceLang` is read once so nobody's choice is lost.

   A module keeps its words in a `strings.js` that exports `STR = { zh, en }` (tests check the two tables hold the same keys and
   the same `{var}`s), and draws them through `makeT(STR)`: `T(key, vars)` fills `{name}` from vars, falls back to English, then
   to the key itself. Anything that crosses the network is a key plus vars, never a finished sentence, so each screen shows it in
   its own language. Registry labels are `{ zh, en }` pairs, read with `pick()`. Node-safe: no DOM or storage is touched at import
   time without a guard, since the server imports the registry and the tests import the games' rules. */
export const LANGS = ['zh', 'en'];
const KEY = 'lan_lang', OLD = 'loadedDiceLang';

function stored() {
  try { for (const k of [KEY, OLD]) { const v = globalThis.localStorage?.getItem(k); if (LANGS.includes(v)) return v; } } catch {}
  return 'zh';
}
let cur = stored();
const subs = new Set();

export const lang = () => cur;
export const isZh = () => cur === 'zh';
/* switch language; every subscriber (the shell, the running game) redraws its words */
export function setLang(l) {
  if (!LANGS.includes(l)) return;
  cur = l;
  try { globalThis.localStorage?.setItem(KEY, l); } catch {}
  applyDoc();
  for (const fn of [...subs]) { try { fn(l); } catch (e) { console.error(e); } }
}
export const nextLang = () => setLang(LANGS[(LANGS.indexOf(cur) + 1) % LANGS.length]);
/* subscribe to a language change; returns the unsubscribe */
export function onLang(fn) { subs.add(fn); return () => subs.delete(fn); }
/* <html lang> drives the CJK font pick and the `.zh` spacing rules in style.css */
export function applyDoc() {
  const d = globalThis.document; if (!d) return;
  d.documentElement.lang = cur === 'zh' ? 'zh-CN' : 'en';
  d.documentElement.classList.toggle('zh', cur === 'zh');
}

export const fill = (s, vars) => { if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]); return s; };
/* a lookup over one module's tables, always in the current language */
export const makeT = str => (key, vars) => fill(str[cur]?.[key] ?? str.en?.[key] ?? key, vars);
/* a registry label: `{ zh, en }` in the current language, anything else as it is */
export const pick = v => (v && typeof v === 'object' && ('zh' in v || 'en' in v)) ? (v[cur] ?? v.en ?? v.zh) : v;
export const pickEn = v => (v && typeof v === 'object' && ('zh' in v || 'en' in v)) ? (v.en ?? v.zh) : v;
