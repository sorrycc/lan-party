/* Every word table (the shell's client/strings.js and each game's strings.js) holds the same keys in Chinese and English, and each
   pair of strings uses the same {vars}. Every registry label is a { zh, en } pair. And the i18n helpers fill and fall back. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMES } from '../client/games/registry.js';
import { makeT, pick, fill, lang, LANGS } from '../client/core/i18n.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tables = ['client/strings.js', ...fs.readdirSync(path.join(ROOT, 'client/games')).map(d => `client/games/${d}/strings.js`)]
  .filter(f => fs.existsSync(path.join(ROOT, f)));
const vars = s => [...String(s).matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort().join(',');

for (const f of tables) {
  test(`${f}: zh and en hold the same keys and the same {vars}`, async () => {
    const { STR } = await import(path.join(ROOT, f));
    assert.deepEqual(Object.keys(STR).sort(), [...LANGS].sort());
    const zk = Object.keys(STR.zh).sort(), ek = Object.keys(STR.en).sort();
    assert.deepEqual(zk.filter(k => !ek.includes(k)), [], 'keys only in zh');
    assert.deepEqual(ek.filter(k => !zk.includes(k)), [], 'keys only in en');
    for (const k of ek) {
      assert.equal(typeof STR.zh[k], typeof STR.en[k], k);
      if (typeof STR.en[k] === 'string') assert.equal(vars(STR.zh[k]), vars(STR.en[k]), `{vars} of ${k}`);
      if (typeof STR.en[k] === 'string') assert.ok(STR.zh[k].length > 0, `${k} is empty in zh`);
    }
  });
}

test('every registry word is a { zh, en } pair', () => {
  const pair = (v, where) => { assert.ok(v && typeof v.zh === 'string' && typeof v.en === 'string' && v.zh && v.en, where); };
  for (const g of GAMES) {
    pair(g.title, `${g.id} title`); pair(g.tagline, `${g.id} tagline`);
    for (const t of g.teams || []) pair(t.label, `${g.id} team ${t.id}`);
    for (const o of g.options || []) { pair(o.label, `${g.id}.${o.key}`); for (const c of o.choices || []) pair(c.label, `${g.id}.${o.key}=${c.value}`); }
  }
});

test('i18n: Chinese by default, English then the key as fallbacks, vars filled', () => {
  assert.equal(lang(), 'zh'); // node has no localStorage, so nothing overrides the default
  const T = makeT({ zh: { a: '你好 {n}' }, en: { a: 'hi {n}', b: 'only english' } });
  assert.equal(T('a', { n: 3 }), '你好 3');
  assert.equal(T('b'), 'only english');
  assert.equal(T('missing'), 'missing');
  assert.equal(pick({ zh: '中', en: 'en' }), '中');
  assert.equal(pick(5), 5);
  assert.equal(fill('{a}-{a}', { a: 1 }), '1-1');
});
