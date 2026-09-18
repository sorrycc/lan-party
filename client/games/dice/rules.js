/* Loaded Dice - the rules of the two-player duel, with no DOM and no clock in them, so the host can run them and node can test them.

   A round: each player has a rig bar with one to three slots on it and a cursor sweeping across. One press picks the slot under the
   cursor (GOOD, or PERFECT near its middle), a press on bare bar is MISSED, and a bar left to run out is a plain attack with no rig.
   Then both dice are rolled, the rig is added, and `resolveDuel` sets the two actions against each other:

     sword   attack: a roll of TO_HIT or more hits. Two attacks clash and the higher roll goes through (a max roll beats any other).
     shield  block: a roll of TO_HIT or more stops an attack, unless the attack is a max roll and the block is not. A max-roll block parries for 1.
     skull   threaten: a roll of TO_HIT or more dazes the other side for the next round (narrow slots) and breaks a shield for 1.
     heart   heal half a heart (a whole one on a max roll)
     fast    rush: the OTHER side's bar sweeps faster from now on          slow    my own bar sweeps slower
     mystery one of the above, drawn by the host

   A max roll is a crit (+1 damage), a landed roll of 6 or more hits for +1, a combo of rigged presses speeds the owner's bar and gives
   a landed roll a chance to jump to the max (`luckOf`). Damage is in half hearts. Every random draw comes from the `rnd` handed in. */
export const DIE_STEPS = [4, 5, 6, 8, 10, 12, 20];
export const TO_HIT = 3, SWEEP_T = 1.75, PERF_W = 0.4, MAX_SPEED = 3.2, DAZE_W = 0.6, GROW_EVERY = 3;
export const ACTS = ['sword', 'shield', 'skull', 'heart', 'fast', 'slow', 'mystery'];
const MYSTERY = ['sword', 'shield', 'heart', 'skull', 'fast'];
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

export const mkDuelist = hearts => ({ hp: hearts * 2, maxHp: hearts * 2, combo: 0, speedMod: 0, dazed: false, wins: 0, perfects: 0, crits: 0, dealt: 0 });
export const speedOf = f => clamp(1 + f.combo * 0.07 + f.speedMod, 1, MAX_SPEED);
export const luckOf = f => Math.min(0.3, f.combo * 0.03);
/* the lobby's `dice`: 'grow' starts on a D4 and steps up every GROW_EVERY rounds of a duel, 'd6' / 'd12' / 'd20' never change */
export function dieForRound(n, mode) {
  if (mode === 'grow') return DIE_STEPS[Math.min(DIE_STEPS.length - 1, Math.floor((Math.max(1, n) - 1) / GROW_EVERY))];
  const d = Number(String(mode).slice(1)); return DIE_STEPS.includes(d) ? d : 6;
}

function wpick(rnd, weights) {
  let sum = 0; for (const k in weights) sum += weights[k];
  let r = rnd() * sum; for (const k in weights) { r -= weights[k]; if (r <= 0) return k; }
  return Object.keys(weights)[0];
}
/* A fighter's bar for one round: [{ k, x, w }] with x and w as fractions of the bar, left to right, never overlapping.
   The first 30% of the bar is always bare, so there is time to read it. */
export function genSlots(rnd, f, round = 9) {
  const n = +wpick(rnd, { 1: round <= 1 ? 5 : 3, 2: 4, 3: round <= 1 ? 1 : 3 }), hurt = f.hp < f.maxHp;
  const weights = { sword: 10, shield: 6, skull: 3, heart: hurt ? (f.hp <= 2 ? 5 : 3) : 0, fast: 2.5, slow: speedOf(f) > 1.6 ? 3 : 0, mystery: 1.5 };
  const kinds = []; while (kinds.length < n) { const k = wpick(rnd, weights); if (!kinds.includes(k)) kinds.push(k); }
  if (!kinds.includes('sword') && !kinds.includes('shield') && rnd() < 0.6) kinds[0] = 'sword';
  for (let i = kinds.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [kinds[i], kinds[j]] = [kinds[j], kinds[i]]; }
  const bw = [0.2, 0.16, 0.135][n - 1] * (f.dazed ? DAZE_W : 1), gap = 0.035, lo = 0.3, hi = 0.985, wOf = k => bw * (k === 'skull' ? 0.8 : 1);
  const free = Math.max(0, hi - lo - kinds.reduce((a, k) => a + wOf(k), 0) - gap * (n - 1));
  const cuts = []; for (let i = 0; i <= n; i++) cuts.push(rnd()); const cs = cuts.reduce((a, b) => a + b, 0) || 1;
  const out = []; let x = lo;
  kinds.forEach((k, i) => { x += free * cuts[i] / cs; const w = wOf(k); out.push({ k, x: +x.toFixed(4), w: +w.toFixed(4) }); x += w + gap; });
  return out;
}

/* What a press at `pos` (0..1 along the bar; below 0 means the bar ran out) picked: { slot, grade }, grade '' for a plain roll */
export function gradePress(slots, pos, perfW = PERF_W) {
  if (!(pos >= 0)) return { slot: -1, grade: '' };
  let slot = -1; slots.forEach((s, i) => { if (Math.abs(pos - (s.x + s.w / 2)) <= s.w / 2 + 0.004) slot = i; });
  if (slot < 0) return { slot, grade: 'MISSED' };
  const s = slots[slot]; return { slot, grade: Math.abs(pos - (s.x + s.w / 2)) <= s.w / 2 * perfW + 0.003 ? 'PERFECT' : 'GOOD' };
}
/* a pick off the wire: the round it answers and where the cursor was */
export function cleanPick(m) { return m && Number.isInteger(m.n) && typeof m.pos === 'number' && Number.isFinite(m.pos) ? { n: m.n, pos: clamp(m.pos, -1, 1) } : null; }

const usesRoll = act => act === 'sword' || act === 'plain' || act === 'shield' || act === 'skull' || act === 'heart';
/* the die for one fighter: { act, grade, slot, bonus, base, roll, crit, lucky } */
export function rollFor(rnd, f, die, slots, pick) {
  let act = pick.grade === '' ? 'plain' : pick.grade === 'MISSED' ? 'miss' : slots[pick.slot].k;
  if (act === 'mystery') act = MYSTERY[Math.floor(rnd() * MYSTERY.length)];
  const bonus = pick.grade === 'PERFECT' ? 2 : pick.grade === 'GOOD' ? 1 : 0, base = 1 + Math.floor(rnd() * die);
  let roll = act === 'miss' ? 1 : Math.min(die, base + bonus), lucky = false;
  if (usesRoll(act) && roll >= TO_HIT && roll < die && rnd() < luckOf(f)) { roll = die; lucky = true; }
  return { act, grade: pick.grade, slot: pick.slot, bonus, base, roll, crit: usesRoll(act) && roll === die, lucky };
}

/* Two rolled actions against each other. Returns one outcome per side:
   { say: [[text, tone]], pose, fx, dmg, hitCrit, heal, daze, speed } - what that fighter shouts and does, what it takes (dmg, a crit or
   not), heals, whether it is dazed next round and what is added to its sweep speed. */
export function resolveDuel(A, B) {
  const S = [A, B], isAtk = s => s.act === 'sword' || s.act === 'plain';
  const ok = S.map(s => s.act !== 'miss' && s.roll >= TO_HIT), atk = S.map((s, i) => isAtk(s) && ok[i]);
  let clash = -2; // -2 no clash, -1 a tie that cancels both, otherwise the side whose attack goes through
  if (atk[0] && atk[1]) { clash = A.crit !== B.crit ? (A.crit ? 0 : 1) : A.roll > B.roll ? 0 : B.roll > A.roll ? 1 : -1; if (clash === -1) atk[0] = atk[1] = false; else atk[1 - clash] = false; }
  const guards = i => S[i].act === 'shield' && ok[i];
  const hits = [0, 1].map(i => atk[i] && !(guards(1 - i) && !(S[i].crit && !S[1 - i].crit)));
  const out = [0, 1].map(() => ({ say: [], pose: '', fx: '', dmg: 0, hitCrit: false, heal: 0, daze: false, speed: 0 }));
  const told = [[], []]; // what the other side makes a fighter shout comes after its own line, whichever chair it sits in
  for (let i = 0; i < 2; i++) {
    const me = S[i], foe = S[1 - i], o = out[i], fo = out[1 - i], j = 1 - i;
    if (isAtk(me)) {
      if (!ok[i]) { o.say.push(['WHIFF', 'dim']); o.pose = 'miss'; o.fx = 'whiff'; }
      else if (clash === -1) { o.say.push(['CLASH', 'ink']); o.pose = 'attack'; o.fx = 'clash'; }
      else if (clash === j) { o.say.push(['CLASH', 'dim']); o.pose = 'attack'; }
      else if (!hits[i]) { o.say.push(['ATTACK', 'ink']); o.pose = 'attack'; if (foe.crit) o.dmg += 1; }
      else { const d = 1 + (me.crit ? 1 : 0) + (me.roll >= 6 ? 1 : 0); fo.dmg += d; fo.hitCrit = fo.hitCrit || me.crit; o.say.push(me.crit ? ['CRIT!', 'hot'] : ['HIT', 'ink']); o.pose = 'attack'; if (guards(j)) told[j].push(['BREAK', 'red']); }
    } else if (me.act === 'shield') {
      o.pose = 'block';
      if (atk[j] && !hits[j]) { o.say.push(me.crit ? ['PARRY!', 'hot'] : ['BLOCK', 'ink']); o.fx = 'block'; }
      else if (!ok[i]) o.say.push(['FUMBLE', 'dim']);
      else if (!atk[j] && !(foe.act === 'skull' && ok[j])) o.say.push(['GUARD', 'dim']);
    } else if (me.act === 'skull') {
      if (!ok[i]) { o.say.push(['MEH', 'dim']); o.pose = 'slow'; }
      else { o.say.push(me.crit ? ['ROAR!', 'hot'] : ['THREAT', 'ink']); o.pose = 'threat'; o.fx = 'spook'; fo.daze = true;
        if (foe.act === 'shield') { fo.dmg += 1 + (me.crit ? 1 : 0); told[j].push(['BREAK', 'red']); } else if (!hits[j]) told[j].push(['SPOOKED', 'purple']); }
    } else if (me.act === 'heart') {
      if (ok[i]) { o.heal = me.crit ? 2 : 1; o.say.push([me.crit ? 'BIG HEAL' : 'HEAL', 'red']); o.pose = 'heal'; o.fx = 'heal'; } else { o.say.push(['FIZZLE', 'dim']); o.pose = 'slow'; }
    } else if (me.act === 'fast') { fo.speed += me.grade === 'PERFECT' ? 0.5 : 0.35; o.say.push(['RUSH!', 'gold']); o.pose = 'zoom'; o.fx = 'up'; told[j].push(['RUSHED', 'dim']); }
    else if (me.act === 'slow') { o.speed -= me.grade === 'PERFECT' ? 0.8 : 0.5; o.say.push(['SLOW DOWN', 'blue']); o.pose = 'slow'; o.fx = 'down'; }
    else { o.say.push(['MISSED', 'red']); o.pose = 'miss'; }
  }
  out.forEach((o, i) => o.say.push(...told[i]));
  return out;
}

/* One whole round on the host: grade both presses, roll, resolve, and write the outcome into the two duelists.
   `fs` are the two duelists (mutated), `slots` their bars, `pos` where each cursor was pressed (below 0: the bar ran out).
   Returns { r, out, win } with win null while both stand, -1 for a double K.O., otherwise the winner's index. */
export function playRound(rnd, fs, die, slots, pos) {
  const r = fs.map((f, i) => {
    const pick = gradePress(slots[i], pos[i]);
    if (pick.grade === 'MISSED') { f.combo = 0; f.speedMod = Math.max(0, f.speedMod * 0.5); } else if (pick.grade) { f.combo++; if (pick.grade === 'PERFECT') f.perfects++; }
    return rollFor(rnd, f, die, slots[i], pick);
  });
  const out = resolveDuel(r[0], r[1]);
  fs.forEach((f, i) => {
    const o = out[i]; if (r[i].crit) f.crits++; fs[1 - i].dealt += o.dmg;
    f.hp = Math.min(f.maxHp, f.hp + o.heal); f.hp = Math.max(0, f.hp - o.dmg);
    if (o.dmg) { f.combo = Math.floor(f.combo / 2); f.speedMod *= 0.5; }
    f.speedMod = Math.max(f.speedMod + o.speed, -f.combo * 0.07); f.dazed = o.daze;
  });
  const down = fs.map(f => f.hp <= 0), win = down[0] && down[1] ? -1 : down[0] ? 1 : down[1] ? 0 : null;
  if (win !== null && win >= 0) fs[win].wins++;
  return { r, out, win };
}
