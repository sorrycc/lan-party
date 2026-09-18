/* Loaded Dice - the solo run's CPU ladder, the part of it that is rules: who stands on each stage, what they roll, and how a foe
   picks its move. A foe has no bar: its intent is drawn at the top of the round (the player sees it in a bubble) and becomes a pick
   for rules.js's rollFor. How a foe looks is index.js's business, keyed by `id`. No DOM, no clock: testable in node.

   Every foe has a trick of its own (`foeTurn`, unless the run's spice is classic), told as data so the rules never name a foe:
     daisy     every third round a flurry: two attacks      blot      ink on the hero's bar      caw       steals the widest slot off it
     moss      winds up for a round (a skull breaks it off), then hits twice as hard      puppet    makes the bar move
     grin      has no face, and now and then neither have the slots: what they are shows only once one is pressed      frost     the slots freeze over: they close in as the sweep goes on
     ram       at half his hearts his die goes up a step, and from then every fourth round he swallows the hero's die: a plain D4 roll is all there is */
import { DIE_STEPS, mkDuelist, wpick } from './rules.js';

export const FOES = [
  { id: 'daisy', hp: 3, die: 4, toHit: 3, ai: { attack: 6, block: 2, dodge: 2 }, hide: 0 },
  { id: 'blot', hp: 4, die: 5, toHit: 3, ai: { attack: 4, block: 5, dodge: 1 }, hide: 0 },
  { id: 'caw', hp: 4, die: 6, toHit: 4, ai: { attack: 4, block: 1, dodge: 5 }, hide: 0.3 },
  { id: 'moss', hp: 6, die: 6, toHit: 3, ai: { attack: 6, block: 3, dodge: 1 }, hide: 0 },
  { id: 'puppet', hp: 6, die: 8, toHit: 4, ai: { attack: 4, block: 4, dodge: 2 }, hide: 0.2 },
  { id: 'grin', hp: 6, die: 8, toHit: 3, ai: { attack: 5, block: 2, dodge: 3 }, hide: 0.5 },
  { id: 'frost', hp: 7, die: 10, toHit: 4, ai: { attack: 4, block: 4, dodge: 2 }, hide: 0.3 },
  { id: 'ram', hp: 8, die: 10, toHit: 4, ai: { attack: 5, block: 3, dodge: 2 }, hide: 0.4, boss: true },
];
const INTENT_ACT = { attack: 'sword', block: 'shield', dodge: 'dodge', stun: 'stun' };

/* the hero: >> speeds his own bar (more score for more risk), and his luck is the perks', not the combo's */
export const mkHero = () => mkDuelist(3, { fastSelf: true, maxSpeed: 3.6, comboLuck: 0 });
/* the foe on a stage: the ladder repeats, and every lap (`tier`) adds hearts, a bigger die and a heavier crit. A 6 is not a harder hit from a foe. */
export function mkFoe(stage) {
  const cfg = FOES[stage % FOES.length], tier = Math.floor(stage / FOES.length), hp = cfg.hp + tier * 3;
  const f = mkDuelist(1, { toHit: cfg.toHit, big6: false, heavy: tier ? 1 : 0, comboLuck: 0 }); f.hp = f.maxHp = hp; f.ai = true;
  return { f, cfg, tier, round: 0, charged: false, angry: false, die: DIE_STEPS[Math.min(DIE_STEPS.length - 1, DIE_STEPS.indexOf(cfg.die) + tier)] };
}
/* what the foe means to do this round: a dazed foe loses its turn */
export const foeIntent = (rnd, f, cfg) => f.dazed ? 'stun' : wpick(rnd, cfg.ai);
/* the intent as a pick: every three of a foe's combo is +1 on its die */
export const foePick = (f, intent) => ({ act: INTENT_ACT[intent] || 'sword', bonus: Math.floor(f.combo / 3) });
/* what the hero's bar should lean towards against that intent */
export const slotHint = (f, cfg, intent) => ({ shield: intent === 'attack' ? 8 : 4, skull: f.dazed || intent === 'stun' || (cfg.boss && intent !== 'block') ? 1 : 3 });

const TRICK_P = { blot: 0.3, caw: 0.3, puppet: 0.45, grin: 0.35, frost: 0.4 };
/* The top of a round: the foe's intent and its trick. Returns { intent, picks, trick, bar, steal, fog, blank, swallow, angry }: `picks` for playRound
   (one, or two in a flurry), `bar` a variant forced on the hero's bar, `steal` / `fog` / `blank` / `swallow` what happens to it, `angry` true the
   round the boss turns. `F` (mkFoe's) carries the foe's own state from round to round. */
export function foeTurn(rnd, F, tricks = true) {
  const f = F.f, id = F.cfg.id, T = { intent: foeIntent(rnd, f, F.cfg), picks: null, trick: '', bar: null, steal: false, fog: false, blank: false, swallow: false, angry: false }; F.round++;
  const stunned = T.intent === 'stun'; if (stunned) F.charged = false;
  if (tricks && !stunned) {
    if (id === 'daisy' && F.round % 3 === 0) { T.intent = 'attack'; T.trick = 'flurry'; T.picks = [foePick(f, 'attack'), foePick(f, 'attack')]; }
    else if (id === 'moss' && F.charged) { F.charged = false; T.intent = 'attack'; T.trick = 'smash'; T.picks = { ...foePick(f, 'attack'), mul: 2 }; }
    else if (id === 'moss' && T.intent === 'attack' && rnd() < 0.4) { F.charged = true; T.intent = 'charge'; T.trick = 'charge'; T.picks = { act: 'none', bonus: 0 }; }
    else if (id === 'ram') { if (!F.angry && f.hp * 2 <= f.maxHp) { F.angry = T.angry = true; F.round = 1; F.die = DIE_STEPS[Math.min(DIE_STEPS.length - 1, DIE_STEPS.indexOf(F.die) + 1)]; T.trick = 'angry'; } else if (F.angry && F.round % 4 === 0) { T.swallow = true; T.trick = 'swallow'; } }
    else if (TRICK_P[id] && rnd() < TRICK_P[id]) { if (id === 'blot') { T.fog = true; T.trick = 'ink'; } else if (id === 'caw') { T.steal = true; T.trick = 'steal'; } else if (id === 'grin') { T.blank = true; T.trick = 'blank'; } else if (id === 'frost') { T.bar = { v: 'shrink' }; T.trick = 'freeze'; } else { T.bar = { v: rnd() < 0.5 ? 'slide' : 'bounce' }; T.trick = 'jam'; } }
  }
  if (!T.picks) T.picks = foePick(f, T.intent);
  return T;
}
/* the widest slot gone (never the last one that is not a bomb) */
export function stealSlot(slots) { const real = slots.filter(s => s.k !== 'bomb' && s.k !== 'jackpot'); if (real.length < 2) return slots; const w = real.reduce((a, b) => b.w > a.w ? b : a); return slots.filter(s => s !== w); }
