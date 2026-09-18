/* Loaded Dice - the solo run's perks. A perk is a change to the hero (a rules.js duelist: its hearts and its `mods`) or to the run
   (`run.xpMul`; `run.die` is the hero's die). `ok` says whether it may still be offered. Names and blurbs are strings.js's
   'perk.<id>' and 'perk.<id>.d'. No DOM: testable in node. */
export const PERKS = [
  { id: 'crit', icon: 'star', f: h => h.mods.critCh += 0.05 },
  { id: 'maxhp', icon: 'heart', f: h => { h.maxHp += 2; h.hp = Math.min(h.maxHp, h.hp + 2); }, ok: h => h.maxHp < 12 },
  { id: 'heal', icon: 'heart', f: h => { h.hp = Math.min(h.maxHp, h.hp + 4); }, ok: h => h.hp < h.maxHp - 1 },
  { id: 'wide', icon: 'shield', f: h => h.mods.slotW *= 1.15, ok: h => h.mods.slotW < 1.5 },
  { id: 'perf', icon: 'star', f: h => h.mods.perfW = Math.min(0.75, h.mods.perfW * 1.25), ok: h => h.mods.perfW < 0.74 },
  { id: 'cool', icon: 'slow', f: h => h.mods.cool *= 0.8, ok: h => h.mods.cool > 0.5 },
  { id: 'thorn', icon: 'shield', f: h => h.mods.thorns++, ok: h => h.mods.thorns < 2 },
  { id: 'vamp', icon: 'skull', f: h => h.mods.vamp = 1, ok: h => !h.mods.vamp },
  { id: 'wt', icon: 'die', f: h => h.mods.minRoll = 2, ok: h => h.mods.minRoll < 2 },
  { id: 'xp', icon: 'book', f: (h, run) => run.xpMul += 0.3 },
  { id: 'heavy', icon: 'sword', f: h => h.mods.heavy++, ok: h => h.mods.heavy < 3 },
  { id: 'rig', icon: 'die', f: h => h.mods.rigPlus = 1, ok: (h, run) => !h.mods.rigPlus && run.die >= 6 },
];
/* three perks for a level up, drawn from what may still be offered */
export function dealPerks(rnd, h, run, n = 3) {
  const pool = PERKS.filter(p => !p.ok || p.ok(h, run));
  for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
  return pool.slice(0, n);
}
