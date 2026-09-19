/* Loaded Dice - the rules, with no DOM and no clock in them, so the host can run them and node can test them. The duel between two
   players and the solo run against the CPU ladder are the same rules: a solo foe is a duelist whose move comes from foes.js instead
   of a bar, and a perk is a change to the hero's `mods`.

   A round: each player has a rig bar with one to three slots on it and a cursor sweeping across. One press picks the slot under the
   cursor (GOOD, or PERFECT near its middle), a press on bare bar is MISSED, and a bar left to run out is a plain attack with no rig.
   Then both dice are rolled, the rig is added, and `resolveDuel` sets the two actions against each other:

     sword   attack: a roll of `toHit` or more hits. Two attacks clash and the higher roll goes through (a max roll beats any other, the gold beats a max roll).
     shield  block: a roll of `toHit` or more stops an attack, unless the attack is a max roll and the block is not. A max-roll block parries for 1.
     skull   threaten: a roll of `toHit` or more dazes the other side for the next round (narrow slots; a CPU foe loses its turn) and breaks a shield for 1.
     heart   heal half a heart (a whole one on a max roll)
     fast    rush: the OTHER side's bar sweeps faster from now on (the solo hero's own: `fastSelf`)          slow    my own bar sweeps slower (offered only while it is sped up)
     mystery one of the above, drawn from the round's `rnd`
     dodge   a CPU foe's hop: an attack that does not roll over the dodge, and is not a max roll, goes past          stun   a dazed CPU foe's lost turn
     smoke   ink: a roll of `toHit` or more puts a stretch of the other side's next bar under fog (bar.js)
     leech   an attack that hits for 1 less (never under 1) and heals its owner half a heart when it lands
     counter a roll of `toHit` or more turns an attack that would have landed back on its owner; one that does not roll its number leaves its owner dazed next round
     poison  a roll of `toHit` or more: half a heart off the other side at the top of each of the next POISON_T rounds (it does not stack, it starts over). No shield stops it.
     jackpot a sliver of gold: an attack rigged +3 that lands on the top face          bomb   usually right beside it: half a heart off whoever presses it, and their combo

   A max roll is a crit (+1 damage), a landed roll of 6 or more hits for +1, a combo of rigged presses speeds the owner's bar and gives
   a landed roll a chance to jump to the max (`luckOf`). Damage is in half hearts. Every random draw comes from the `rnd` handed in.
   What a fighter shouts is a key ('hit', 'crit', ...) for strings.js, so two screens may read the same round in two languages.

   FEVER: rigged presses and crits fill a meter (a fumble or a bomb drains it); the round after it fills is hot: two dice and the higher
   one counts, the sweet spots are twice as wide, a landed attack hits for +1, and the meter starts over. CPU foes have none.

   LOADED FACES: `mods.faces` carves a kind onto a number of the die ({ 3: 'vamp' }), three at most, never the 1. When the die stops on
   it (and it is not the top face, which is a crit already) and the move came off: `vamp` heals half a heart, `double` doubles the
   damage or the heal, `venom` poisons, `lucky` is +3 fever; `guard` takes 1 off whatever is taken this round, move or no move.
   A solo level up may offer one; in a duel the loser of each duel picks first from three, the winner from the two left (`dealFaces`).

   A DOUBLE ROUND (bar.js: `presses: 2`): the cursor crosses the bar twice and each crossing takes one press, never the same slot
   twice. Each move rolls its own die; the first moves meet, then the second ones (a side with only one move stands still for the
   second meeting), and the round's outcome is the two added up.

   What is in play is the lobby's `spice` (`featsFor`): 'classic' is the seven slots above and nothing else, 'std' brings the rest in
   duel by duel (stage by stage in a solo run), 'wild' has all of it from the first round and more often. */
import { gradeAt, pressOf } from './bar.js';

export const DIE_STEPS = [4, 5, 6, 8, 10, 12, 20];
export const TO_HIT = 3, SWEEP_T = 1.75, PERF_W = 0.4, MAX_SPEED = 3.2, DAZE_W = 0.6, GROW_EVERY = 3;
export const FEVER_MAX = 6, JACKPOT_P = 0.18, BOMB_BESIDE_P = 0.7, BOMB_ALONE_P = 0.08, JACKPOT_RIG = 3;
export const POISON_T = 3, MAX_FACES = 3, FACES = ['vamp', 'double', 'guard', 'venom', 'lucky'];
export const ACTS = ['sword', 'shield', 'skull', 'heart', 'fast', 'slow', 'mystery', 'jackpot', 'bomb', 'smoke', 'leech', 'counter', 'poison'];
export const SPICES = ['classic', 'std', 'wild'];
/* what is in play at `level` (the duel's number, or 1 / 2 / 3 as a solo run goes on). 1: the gold, the bomb, the fever, a solo foe's tricks (foes.js). 2: bars that
   move (bar.js), the leech, the counter and the poison, loaded faces. 3: ink, a fake slot on the other player's bar, double rounds. */
export function featsFor(spice, level = 1) {
  const wild = spice === 'wild', on = n => spice !== 'classic' && SPICES.includes(spice) && (wild || level >= n);
  return { jackpot: on(1), fever: on(1), bars: on(2), acts: on(2), faces: on(2), fog: on(3), fake: on(3), double: on(3), tricks: on(1), odds: wild ? 1.6 : 1 };
}
export const NO_FEATS = featsFor('classic');
const MYSTERY = ['sword', 'shield', 'heart', 'skull', 'fast'];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* What a perk, a foe's tier or a mode may change about a duelist. perfW / slotW: the sweet spot and the slots' width. minRoll: the die
   never shows less. rigPlus: added to every rig. critCh: a landed roll's flat chance to jump to the top face, comboLuck: the same per
   combo. cool: how much of the combo reaches the bar's speed. thorns: a block bites back. vamp: a crit that lands heals. heavy: more
   damage on a crit. big6: a landed 6 or more hits harder. fastSelf: >> speeds my own bar instead of theirs. */
export const mkMods = () => ({ perfW: PERF_W, slotW: 1, minRoll: 1, rigPlus: 0, critCh: 0, comboLuck: 0.03, cool: 1, maxSpeed: MAX_SPEED, thorns: 0, vamp: 0, heavy: 0, big6: true, toHit: TO_HIT, fastSelf: false, faces: {} });
export const mkDuelist = (hearts, mods) => ({ hp: hearts * 2, maxHp: hearts * 2, combo: 0, speedMod: 0, dazed: false, fogged: false, poison: 0, fever: 0, wins: 0, perfects: 0, crits: 0, dealt: 0, ai: false, mods: { ...mkMods(), ...mods, faces: { ...(mods && mods.faces) } } });
export const speedOf = f => clamp(1 + f.combo * 0.07 * f.mods.cool + f.speedMod, 1, f.mods.maxSpeed);
export const isHot = f => !f.ai && f.fever >= FEVER_MAX; // this round is the fever's
export const perfOf = f => Math.min(1, f.mods.perfW * (isHot(f) ? 2 : 1));
export const luckOf = f => Math.min(0.3, f.combo * f.mods.comboLuck) + f.mods.critCh;
/* the lobby's `dice`: 'grow' starts on a D4 and steps up every GROW_EVERY rounds of a duel, 'd6' / 'd12' / 'd20' never change */
export function dieForRound(n, mode) {
  if (mode === 'grow') return DIE_STEPS[Math.min(DIE_STEPS.length - 1, Math.floor((Math.max(1, n) - 1) / GROW_EVERY))];
  const d = Number(String(mode).slice(1)); return DIE_STEPS.includes(d) ? d : 6;
}

export function wpick(rnd, weights) {
  let sum = 0; for (const k in weights) sum += weights[k];
  let r = rnd() * sum; for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
  return Object.keys(weights)[0];
}
/* `slow` is on a bar only when it can do something: the bar was rushed (speedMod above 0), or the combo has it well over its base
   speed. Either way a slow-down takes a real bite out of the speed, since speedMod may fall as far as cancelling the combo. */
export const canSlow = f => f.speedMod > 0.001 || speedOf(f) > 1.6;
/* A fighter's bar for one round: [{ k, x, w }] with x and w as fractions of the bar, left to right, never overlapping.
   The first 30% of the bar is always bare, so there is time to read it. `hint` overrides a kind's weight (the solo run reads the
   foe's intent: more shields against an attack, fewer skulls against a foe already dazed). With `feat.jackpot` a bar may carry a
   sliver of gold, usually with a bomb hard against one side of it, or a bomb on its own: four slots at most. */
export function genSlots(rnd, f, round = 9, hint = null, feat = NO_FEATS) {
  let n = +wpick(rnd, { 1: round <= 1 ? 5 : 3, 2: 4, 3: round <= 1 ? 1 : 3 }); const hurt = f.hp < f.maxHp;
  const weights = { sword: 10, shield: 6, skull: 3, heart: hurt ? (f.hp <= 2 ? 5 : 3) : 0, fast: 2.5, slow: canSlow(f) ? 3 : 0, mystery: 1.5, smoke: feat.fog ? 2 : 0, leech: feat.acts ? 3 : 0, counter: feat.acts ? 2.5 : 0, poison: feat.acts ? 2.5 : 0, ...hint };
  let extra = null; // the gold and its bomb, laid out as one group
  if (feat.jackpot) { if (rnd() < JACKPOT_P * feat.odds) { extra = ['jackpot']; if (rnd() < BOMB_BESIDE_P) rnd() < 0.5 ? extra.push('bomb') : extra.unshift('bomb'); } else if (rnd() < BOMB_ALONE_P * feat.odds) extra = ['bomb']; }
  if (extra) n = Math.min(n, 4 - extra.length);
  const kinds = []; while (kinds.length < n) { const k = wpick(rnd, weights); if (!kinds.includes(k)) kinds.push(k); }
  if (!kinds.includes('sword') && !kinds.includes('shield') && rnd() < 0.6) kinds[0] = 'sword';
  const groups = kinds.map(k => [k]); if (extra) groups.push(extra);
  for (let i = groups.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [groups[i], groups[j]] = [groups[j], groups[i]]; }
  const bw = [0.2, 0.16, 0.135][n - 1] * (f.dazed ? DAZE_W : 1) * f.mods.slotW, gap = 0.035, tight = 0.01, lo = 0.3, hi = 0.985;
  const wOf = k => bw * (k === 'skull' ? 0.8 : k === 'jackpot' ? 0.35 : k === 'bomb' ? 0.7 : 1), all = groups.flat();
  const gaps = gap * (groups.length - 1) + tight * (all.length - groups.length), sumW = all.reduce((a, k) => a + wOf(k), 0), fit = Math.min(1, (hi - lo - gaps) / sumW); // fat slots and a full bar: everything a little narrower
  const free = Math.max(0, hi - lo - sumW * fit - gaps);
  const cuts = []; for (let i = 0; i <= groups.length; i++) cuts.push(rnd()); const cs = cuts.reduce((a, b) => a + b, 0) || 1;
  const out = []; let x = lo;
  groups.forEach((g, i) => { x += free * cuts[i] / cs; g.forEach((k, j) => { const w = wOf(k) * fit; out.push({ k, x: +x.toFixed(4), w: +w.toFixed(4) }); x += w + (j < g.length - 1 ? tight : gap); }); });
  return out;
}

/* What a press at `pos` (0..1 along the bar; below 0 means the bar ran out) picked: { slot, grade }, grade '' for a plain roll */
export function gradePress(slots, pos, perfW = PERF_W) {
  if (!(pos >= 0)) return { slot: -1, grade: '' };
  let slot = -1; slots.forEach((s, i) => { if (Math.abs(pos - (s.x + s.w / 2)) <= s.w / 2 + 0.004) slot = i; });
  if (slot < 0) return { slot, grade: 'MISSED' };
  const s = slots[slot]; return { slot, grade: Math.abs(pos - (s.x + s.w / 2)) <= s.w / 2 * perfW + 0.003 ? 'PERFECT' : 'GOOD' };
}
const usesRoll = act => act === 'sword' || act === 'plain' || act === 'shield' || act === 'skull' || act === 'heart' || act === 'dodge' || act === 'smoke' || act === 'leech' || act === 'counter' || act === 'poison';
/* The die for one fighter: { act, grade, slot, bonus, base, roll, ok, crit, lucky } and the mods the outcome reads. A `pick` is what
   gradePress returned, or a CPU foe's { act, bonus } with no bar behind it. */
export function rollFor(rnd, f, die, slots, pick) {
  const m = f.mods, grade = pick.grade || '', slot = pick.slot ?? -1, hot = isHot(f);
  let act = pick.act || (grade === '' ? 'plain' : grade === 'MISSED' ? 'miss' : slots[slot].k);
  if (act === 'mystery') act = MYSTERY[Math.floor(rnd() * MYSTERY.length)];
  const jackpot = act === 'jackpot'; if (jackpot) act = 'sword';
  const rig = jackpot ? JACKPOT_RIG : grade === 'PERFECT' ? 2 : grade === 'GOOD' ? 1 : 0, bonus = pick.bonus ?? (rig ? rig + m.rigPlus : 0), lowest = Math.min(die, m.minRoll);
  let base = Math.max(lowest, 1 + Math.floor(rnd() * die)), other = 0; // a hot round throws two and keeps the higher
  if (hot) { other = Math.max(lowest, 1 + Math.floor(rnd() * die)); if (other > base) [base, other] = [other, base]; }
  let roll = act === 'miss' ? 1 : act === 'stun' || act === 'bomb' ? 0 : jackpot ? die : Math.min(die, base + bonus), lucky = false;
  if (usesRoll(act) && act !== 'dodge' && roll >= m.toHit && roll < die && rnd() < luckOf(f)) { roll = die; lucky = true; }
  return { act, grade, slot, bonus, base, roll, ok: usesRoll(act) && roll >= m.toHit, crit: usesRoll(act) && roll === die, lucky, jackpot, hot, other, face: usesRoll(act) && roll < die && m.faces[roll] || '',
    mul: pick.mul || 1, heavy: m.heavy, thorns: m.thorns, vamp: m.vamp, big6: m.big6, fastSelf: m.fastSelf };
}

/* Two rolled actions against each other. Returns one outcome per side:
   { say: [[key, tone]], pose, fx, dmg, hitCrit, heal, daze, speed, won } - what that fighter shouts and does, what it takes (dmg, a crit
   or not), heals, whether it is dazed (or its bar fogged) next round, what is added to its sweep speed, and whether its move came off (a CPU foe's combo). */
const dmgOf = s => Math.max(1, 1 + (s.crit ? 1 + (s.heavy | 0) : 0) + (s.roll >= 6 && s.big6 !== false ? 1 : 0) + (s.hot ? 1 : 0) - (s.act === 'leech' ? 1 : 0)) * (s.mul || 1); // what a landed attack takes off
export function resolveDuel(A, B) {
  const S = [A, B], isAtk = s => s.act === 'sword' || s.act === 'plain' || s.act === 'leech';
  const ok = S.map(s => s.ok ?? (s.act !== 'miss' && s.act !== 'bomb' && s.roll >= TO_HIT)), atk = S.map((s, i) => isAtk(s) && ok[i]);
  let clash = -2; // -2 no clash, -1 a tie that cancels both, otherwise the side whose attack goes through
  if (atk[0] && atk[1]) { clash = !A.jackpot !== !B.jackpot ? (A.jackpot ? 0 : 1) : A.crit !== B.crit ? (A.crit ? 0 : 1) : A.roll > B.roll ? 0 : B.roll > A.roll ? 1 : -1; if (clash === -1) atk[0] = atk[1] = false; else atk[1 - clash] = false; }
  const guards = i => S[i].act === 'shield' && ok[i] && !(S[1 - i].crit && !S[i].crit); // holds against the other side's attack
  const hops = i => S[i].act === 'dodge' && S[i].roll >= S[1 - i].roll && !S[1 - i].crit;
  const turns = i => S[i].act === 'counter' && ok[i]; // turns the other side's attack back
  const hits = [0, 1].map(i => atk[i] && !guards(1 - i) && !hops(1 - i) && !turns(1 - i));
  const out = [0, 1].map(() => ({ say: [], pose: '', fx: '', dmg: 0, hitCrit: false, heal: 0, daze: false, fog: false, poison: false, fever: 0, face: '', speed: 0, won: false }));
  const told = [[], []]; // what the other side makes a fighter shout comes after its own line, whichever chair it sits in
  for (let i = 0; i < 2; i++) {
    const me = S[i], foe = S[1 - i], o = out[i], fo = out[1 - i], j = 1 - i;
    if (isAtk(me)) {
      if (!ok[i]) { o.say.push(['whiff', 'dim']); o.pose = 'miss'; o.fx = 'whiff'; }
      else if (clash === -1) { o.say.push(['clash', 'ink']); o.pose = 'attack'; o.fx = 'clash'; }
      else if (clash === j) { o.say.push(['clash', 'dim']); o.pose = 'attack'; }
      else if (!hits[i]) { o.say.push(['attack', 'ink']); o.pose = 'attack'; if (turns(j)) o.dmg += dmgOf(me); else if (guards(j)) o.dmg += (foe.crit ? 1 : 0) + (foe.thorns | 0); }
      else { const d = dmgOf(me); if (me.act === 'leech') o.heal += 1; fo.dmg += d; fo.hitCrit = fo.hitCrit || me.crit; o.won = true; if (me.crit && me.vamp) o.heal += 1;
        o.say.push(me.jackpot ? ['jackpot', 'hot'] : me.crit ? ['crit', 'hot'] : me.act === 'leech' ? ['leech', 'red'] : ['hit', 'ink']); o.pose = 'attack'; if (foe.act === 'shield' && ok[j]) told[j].push(['break', 'red']); }
    } else if (me.act === 'shield') {
      o.pose = 'block';
      if (atk[j] && !hits[j]) { o.say.push(me.crit ? ['parry', 'hot'] : ['block', 'ink']); o.fx = 'block'; o.won = true; }
      else if (!ok[i]) o.say.push(['fumble', 'dim']);
      else if (!atk[j] && !(foe.act === 'skull' && ok[j])) o.say.push(['guard', 'dim']);
    } else if (me.act === 'dodge') {
      if (atk[j] && !hits[j]) { o.say.push(['dodge', 'ink']); o.pose = 'dodge'; o.fx = 'whiff'; o.won = true; }
      else if (!atk[j] && !(foe.act === 'skull' && ok[j])) { o.say.push(['hop', 'dim']); o.pose = 'dodge'; }
    } else if (me.act === 'skull') {
      if (!ok[i]) { o.say.push(['meh', 'dim']); o.pose = 'slow'; }
      else { o.say.push(me.crit ? ['roar', 'hot'] : ['threat', 'ink']); o.pose = 'threat'; o.fx = 'spook'; fo.daze = true; o.won = true;
        if (foe.act === 'shield') { fo.dmg += 1 + (me.crit ? 1 : 0); told[j].push(['break', 'red']); } else if (!hits[j]) told[j].push(['spooked', 'purple']); }
    } else if (me.act === 'counter') {
      if (atk[j] && turns(i)) { o.say.push(['counter', 'hot']); o.pose = 'block'; o.fx = 'block'; o.won = true; }
      else if (ok[i]) { o.say.push(['braced', 'dim']); o.pose = 'block'; } // rolled its number and nobody swung: no harm done
      else { o.say.push(['fumble', 'dim']); o.pose = 'miss'; o.daze = true; }
    } else if (me.act === 'poison') {
      if (ok[i]) { fo.poison = true; o.won = true; o.say.push(['poison', 'green']); o.pose = 'threat'; o.fx = 'venom'; told[j].push(['poisoned', 'green']); } else { o.say.push(['fizzle', 'dim']); o.pose = 'slow'; }
    } else if (me.act === 'smoke') {
      if (ok[i]) { fo.fog = true; o.won = true; o.say.push(['smoke', 'purple']); o.pose = 'zoom'; o.fx = 'ink'; told[j].push(['smoked', 'dim']); } else { o.say.push(['fizzle', 'dim']); o.pose = 'slow'; }
    } else if (me.act === 'heart') {
      if (ok[i]) { o.won = true; o.heal += me.crit ? 2 : 1; o.say.push([me.crit ? 'bigheal' : 'heal', 'red']); o.pose = 'heal'; o.fx = 'heal'; } else { o.say.push(['fizzle', 'dim']); o.pose = 'slow'; }
    } else if (me.act === 'fast') {
      const v = me.grade === 'PERFECT' ? 0.5 : 0.35; o.pose = 'zoom'; o.fx = 'up';
      if (me.fastSelf) { o.speed += v; o.say.push(['speedup', 'gold']); } else { fo.speed += v; o.say.push(['rush', 'gold']); told[j].push(['rushed', 'dim']); }
    } else if (me.act === 'slow') { o.speed -= me.grade === 'PERFECT' ? 0.8 : 0.5; o.say.push(['slowdown', 'blue']); o.pose = 'slow'; o.fx = 'down'; }
    else if (me.act === 'stun') told[i].push(['dazed', 'purple']);
    else if (me.act === 'none') { /* stands still: a charge being wound up, or no second move in a double round */ }
    else if (me.act === 'bomb') { o.dmg += 1; o.say.push(['boom', 'red']); o.fx = 'boom'; }
    else { o.say.push(['missed', 'red']); o.pose = 'miss'; }
  }
  for (let i = 0; i < 2; i++) { // a loaded face, when the die stopped on it
    const k = S[i].face, o = out[i], fo = out[1 - i]; if (!k) continue;
    if (k === 'guard') { if (o.dmg) { o.dmg--; o.face = k; } continue; }
    if (!o.won) continue; o.face = k;
    if (k === 'double') { if (isAtk(S[i])) fo.dmg *= 2; o.heal *= 2; } else if (k === 'vamp') o.heal += 1; else if (k === 'venom') fo.poison = true; else if (k === 'lucky') o.fever += 3;
  }
  out.forEach((o, i) => { if (S[i].act === 'stun' && o.dmg) told[i].length = 0; o.say.push(...told[i]); });
  return out;
}

/* One whole round: grade both presses, roll, resolve, and write the outcome into the two duelists.
   `fs` are the two duelists (mutated), `bars` their bars (bar.js's, or just the slots of one that stands still), `picks` the sweep's
   progress `u` at each press (a number; below 0: the bar ran out; or { u, w } with the stretch swept in the frame before it) or a CPU foe's { act, bonus }, `die` one die or one each. Returns { r, out, win } with win null while both stand, -1 for a double
   K.O., otherwise the winner's index. */
export function playRound(rnd, fs, die, bars, picks, feat = NO_FEATS) {
  const dice = Array.isArray(die) ? die : [die, die], hot = fs.map(isHot), tick = fs.map(f => f.poison > 0 ? 1 : 0), B = bars.map(b => Array.isArray(b) ? { v: 'still', slots: b } : b);
  const rolls = fs.map((f, i) => (Array.isArray(picks[i]) ? picks[i].slice(0, 2) : [picks[i]]).map((p, k, all) => {
    const q = pressOf(p), q0 = pressOf(all[0]); let pick = q ? gradeAt(B[i], q.u, perfOf(f), q.w) : p;
    if (k && pick.slot >= 0 && q0 && gradeAt(B[i], q0.u, 1, q0.w).slot === pick.slot) pick = { slot: -1, grade: 'MISSED' }; // the same slot twice
    if (pick.grade === 'MISSED') { f.combo = 0; f.speedMod = Math.max(0, f.speedMod * 0.5); } else if (pick.grade) { f.combo++; if (pick.grade === 'PERFECT') f.perfects++; }
    const roll = rollFor(rnd, f, dice[i], B[i].slots, pick); roll.sx = roll.slot >= 0 ? B[i].slots[roll.slot].x : -1; return roll; // sx: which slot, for a screen that was shown a fake among them
  }));
  const r = rolls.map(x => x[0]), r2 = rolls.map(x => x[1] || null), out = resolveDuel(r[0], r[1]);
  if (r2[0] || r2[1]) { // the second moves meet, and the round is the two added up
    const still = { act: 'none', roll: 0, ok: false, crit: false }, o2 = resolveDuel(r2[0] || still, r2[1] || still);
    out.forEach((o, i) => { const p = o2[i]; o.say.push(...p.say); o.pose = p.pose || o.pose; o.fx2 = p.fx; o.dmg += p.dmg; o.heal += p.heal; o.speed += p.speed; o.fever += p.fever; o.hitCrit = o.hitCrit || p.hitCrit; o.daze = o.daze || p.daze; o.fog = o.fog || p.fog; o.poison = o.poison || p.poison; o.won = o.won || p.won; o.face = o.face || p.face; });
  }
  fs.forEach((f, i) => {
    const o = out[i], mine = rolls[i]; fs[1 - i].dealt += o.dmg; for (const x of mine) if (x.crit) f.crits++;
    o.tick = tick[i]; if (tick[i]) f.poison--; if (o.poison) f.poison = POISON_T; // the poison bites at the top of a round, a fresh dose starts the count over
    f.hp = Math.min(f.maxHp, f.hp + o.heal); f.hp = Math.max(0, f.hp - o.dmg - o.tick);
    if (mine.some(x => x.act === 'bomb')) f.combo = 0;
    if (f.ai) { if (o.won) f.combo++; if (o.dmg) f.combo = 0; }
    else if (o.dmg) { f.combo = Math.floor(f.combo / 2); f.speedMod *= 0.5; }
    f.speedMod = Math.max(f.speedMod + o.speed, -f.combo * 0.07 * f.mods.cool); f.dazed = o.daze; f.fogged = o.fog;
    if (!feat.fever || f.ai) f.fever = 0;
    else if (hot[i]) f.fever = 0;
    else f.fever = clamp(f.fever + mine.reduce((a, x) => a + (x.grade === 'MISSED' || x.act === 'bomb' ? -2 : (x.grade === 'PERFECT' ? 2 : x.grade === 'GOOD' ? 1 : 0) + (x.crit ? 1 : 0)), 0) + o.fever, 0, FEVER_MAX);
  });
  const down = fs.map(f => f.hp <= 0), win = down[0] && down[1] ? -1 : down[0] ? 1 : down[1] ? 0 : null;
  if (win !== null && win >= 0) fs[win].wins++;
  return { r, r2, out, win };
}

/* Which numbers of a `die` may still be carved on `f`: never the 1, never one carved already, up to MAX_FACES in all. The numbers run
   to 6 at least, so a face carved on a small die comes into play as the dice grow. */
export function freeFaces(f, die) {
  const taken = Object.keys(f.mods.faces); if (taken.length >= MAX_FACES) return [];
  const out = []; for (let n = 2; n <= Math.max(6, die - 1); n++) if (!f.mods.faces[n]) out.push(n); return out;
}
/* `n` cards to pick a loaded face from: [{ kind, face }], no kind twice; none when `f` has no room for one */
export function dealFaces(rnd, f, die, n = 3) {
  const free = freeFaces(f, die), kinds = FACES.slice(); if (!free.length) return [];
  for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
  return kinds.slice(0, n).map(kind => ({ kind, face: free[Math.floor(rnd() * free.length)] }));
}
export function carve(f, card) { if (card && FACES.includes(card.kind) && Number.isInteger(card.face) && card.face >= 2 && !f.mods.faces[card.face] && Object.keys(f.mods.faces).length < MAX_FACES) { f.mods.faces[card.face] = card.kind; return true; } return false; }
