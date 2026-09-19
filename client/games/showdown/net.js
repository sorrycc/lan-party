/* Sundown Showdown: the roster and the wire format, kept free of three.js so node can test them.

   The host simulates everything (sim.js) and sends 30 Hz `s` snapshots; clients send what they want to do.
   A snapshot: { t: 's', mid, q, st, tm, pt, g: [radius, stage, timer, shrinking], p: [brawler...], pk: [[cls, locked]...], ev: [[name, ...args]...], res }
     mid  the round's shared id (the shell's seed) so a straggler from the last match is ignored after PLAY AGAIN
     q    sequence number, st index into STATES, tm seconds into the match, pt seconds left to pick a brawler
     g    the poison gas: its radius, which shrink it is on, the seconds left of this phase and 1 while it is closing in
     p    one packed brawler per roster slot (packBrawler / unpackBrawler)
     pk   while picking: every slot's brawler class and whether it is locked in
     ev   what happened since the last snapshot (shots, bombs, damage, deaths, crates, cubes, turrets, burning ground); every machine turns the
          same events into its own particles, numbers and sounds
     res  with the result: the standings, best first
   A client sends `pk` (its pick), `in` (stick, aim, FIRE held; numbered so the host can acknowledge it), and one `fi` /
   `su` per shot or super released from a touch stick. */
import { AVATARS } from '../../core/avatars.js';
import { makeRng } from '../../core/math.js';
import { CLASSES } from './sim.js';

export const MAX_BRAWLERS = 10, MAX_HUMANS = 8, CLASS_COUNT = CLASSES.length;
export const STATES = ['pick', 'countdown', 'play', 'end', 'result'];
export const CPU_NAMES = ['Rusty', 'Dynamo', 'Cactus Jo', 'Nitro', 'Mags', 'El Gato', 'Pepper', 'Bolt', 'Tumble', 'Scrap', 'Vex', 'Dusty', 'Juno', 'Hex', 'Bandit', 'Marlo', 'Sprocket', 'Coyote', 'Ziggy', 'Tank Girl'];
export const CPU_SHIRTS = [0xff8c42, 0xf25f9c, 0x47c9c0, 0xd4c02a, 0xb388ff, 0xff6b6b, 0x6bd66b, 0x5aa9ff, 0xf0a35e, 0xc0c0d0];

const r2 = v => Math.round(v * 100) / 100;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

/* Build the same roster on every machine: humans sorted by id take the first slots in their avatar's colour, CPU
   brawlers fill the showdown to ten when the host left "fill with CPU" on (a lone player always gets one to fight).
   The CPU names and classes (a shuffled deal) come from the round's seed; a human's class is whatever they pick once the round is on. */
export function buildRoster(session) {
  const opts = session.opts || {}, fill = opts.fillAI !== false, R = makeRng((session.seed >>> 0) ^ 0x5eed);
  const sorted = [...session.players].sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0)).slice(0, MAX_HUMANS), roster = [];
  for (const p of sorted) { const av = AVATARS[p.avatar] ? p.avatar : 0; roster.push({ i: roster.length, pid: p.id, name: p.name || AVATARS[av].name, human: true, color: AVATARS[av].color, cls: -1 }); }
  const names = [...CPU_NAMES]; for (let i = names.length - 1; i > 0; i--) { const j = Math.floor(R.rnd() * (i + 1)); [names[i], names[j]] = [names[j], names[i]]; }
  const off = Math.floor(R.rnd() * CPU_SHIRTS.length), want = fill ? MAX_BRAWLERS : Math.max(roster.length, 2);
  const cls = CLASSES.map((_, k) => k); for (let i = cls.length - 1; i > 0; i--) { const j = Math.floor(R.rnd() * (i + 1)); [cls[i], cls[j]] = [cls[j], cls[i]]; } // no two CPUs alike while there are brawlers left to deal
  for (let k = 0; roster.length < want; k++) roster.push({ i: roster.length, pid: null, name: names[k], human: false, color: CPU_SHIRTS[(k + off) % CPU_SHIRTS.length], cls: cls[k % cls.length] });
  return roster;
}

/* ---- brawlers. Flags: 1 alive, 2 in tall grass, 4 revealed (shot or was hit a moment ago), 8 bull rush or roll, 16 human,
   32 slowed, 64 stunned (or being hooked in), 128 burning, 256 unseen, 512 quick. */
export function packBrawler(b) {
  const flags = (b.alive ? 1 : 0) | (b.inGrass ? 2 : 0) | (b.reveal > 0 ? 4 : 0) | (b.dash ? 8 : 0) | (b.human ? 16 : 0), f = b.fx || {},
    fx = (f.slow > 0 ? 32 : 0) | (f.stun > 0 || b.pull ? 64 : 0) | (f.burn > 0 ? 128 : 0) | (f.stealth > 0 ? 256 : 0) | (f.haste > 0 ? 512 : 0);
  return [r2(b.x), r2(b.z), r2(b.dir), r2(b.mvx), r2(b.mvz), Math.ceil(b.hp), b.maxhp | 0, b.cubes | 0, r2(b.ammo), r2(b.sup), flags | fx, b.kills | 0, b.cls | 0, b.ack | 0];
}
export function unpackBrawler(a) {
  if (!Array.isArray(a)) return null;
  const flags = num(a[10]);
  return { x: num(a[0]), z: num(a[1]), dir: num(a[2]), mvx: num(a[3]), mvz: num(a[4]), hp: num(a[5]), maxhp: num(a[6], 1), cubes: num(a[7]), ammo: num(a[8]), sup: num(a[9]),
    alive: !!(flags & 1), inGrass: !!(flags & 2), revealed: !!(flags & 4), dash: !!(flags & 8), human: !!(flags & 16),
    slow: !!(flags & 32), stun: !!(flags & 64), burn: !!(flags & 128), stealth: !!(flags & 256), haste: !!(flags & 512), kills: num(a[11]), cls: clamp(num(a[12]) | 0, 0, CLASS_COUNT - 1), ack: num(a[13]) };
}

/* ---- the snapshot guard: only the current match's snapshots, and only in order. PLAY AGAIN restarts the host's
   numbering at 1 while the last snapshots of the old match may still be on the wire. */
export function createSnapGuard(matchId) {
  let lastSeq = -1; const mid = matchId >>> 0;
  return {
    accept(m) {
      if (!m || (m.mid !== undefined && (m.mid >>> 0) !== mid)) return false;
      if (typeof m.q !== 'number' || m.q <= lastSeq) return false;
      lastSeq = m.q; return true;
    },
    get lastSeq() { return lastSeq; },
  };
}

/* ---- what a client asks for. The stick is clamped to the unit circle (a diagonal is no faster), `a` is the aim as a
   world angle, `d` how far away the aim point is (a lobbed bomb lands there), `f` FIRE held (mouse), `q` its number. */
export function cleanInput(m) {
  let mx = num(m.x), mz = num(m.y); const l = Math.hypot(mx, mz); if (l > 1) { mx /= l; mz /= l; }
  return { mx, mz, a: num(m.a), d: clamp(num(m.d, 6), 0, 40), fire: !!m.f, q: num(m.q) | 0 };
}
export const cleanShot = m => ({ a: num(m.a), d: clamp(num(m.d, 6), 0, 40) });
export const cleanPick = m => ({ cls: clamp(num(m.c) | 0, 0, CLASS_COUNT - 1), ok: !!m.ok });
