/* Hog the Throne: the roster and the wire format, kept free of three.js and cannon-es so node can test them.

   The host simulates every pig (cannon-es) and sends 30 Hz `s` snapshots; clients send their wishes (`in`, `da`).
   A snapshot: { t: 's', mid, q, st, rd, pl, tm, cd, w, p: [pig...], m: {mode state}, ev: [[name, ...args]...] }
     mid  the round's shared id (the shell's seed) so a straggler from the last match is ignored after PLAY AGAIN
     q    sequence number, st index into STATES, rd round index into pl (the shuffled plan, indices into MODES)
     tm   seconds into the current round, cd the card timer, w the winner's pig index (result and title) or -1
     p    one packed pig per roster slot (packPig / unpackPig), m whatever the current mode packs
     ev   the effects that happened since the last snapshot; every machine turns them into the same sounds and particles */
import { AVATARS } from '../../core/avatars.js';

export const MAX_PIGS = 4;
export const STATES = ['intro', 'play', 'result', 'title'];
export const MODES = ['spin', 'balloon', 'crumble', 'truffle', 'throne']; // index.js builds its Mode classes in this order; 'throne' is always the finale
export const HATS = [
  { id: 'tophat', emoji: '🎩' }, { id: 'cone', emoji: '🥳' }, { id: 'viking', emoji: '🪖' }, { id: 'beanie', emoji: '🧢' },
];
export const CPU_NAMES = ['HAMLET', 'PORKY', 'BACON', 'CHOPS'];

const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000;
const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

/* Build the same roster on every machine: humans sorted by id take the first slots, CPU pigs fill the rest when the
   host left "fill with CPU" on (a lone player always gets at least one CPU to bump). Every pig wears its slot's hat and
   the colour of the player's avatar; a CPU takes the first avatar colour nobody picked. */
export function buildRoster(session) {
  const opts = session.opts || {}, fill = opts.fillAI !== false;
  const sorted = [...session.players].sort((a, b) => (a.id > b.id ? 1 : a.id < b.id ? -1 : 0)).slice(0, MAX_PIGS);
  const used = new Set(), roster = [];
  for (const p of sorted) {
    const av = AVATARS[p.avatar] ? p.avatar : 0; used.add(av);
    roster.push({ i: roster.length, pid: p.id, name: p.name || AVATARS[av].name, avatar: av, color: AVATARS[av].color, hat: HATS[roster.length].id, emoji: HATS[roster.length].emoji, human: true });
  }
  const want = fill ? MAX_PIGS : Math.max(roster.length, 2);
  for (let k = 0; roster.length < want; k++) {
    let av = 0; while (used.has(av) && av < AVATARS.length - 1) av++; used.add(av);
    roster.push({ i: roster.length, pid: null, name: CPU_NAMES[k], avatar: av, color: AVATARS[av].color, hat: HATS[roster.length].id, emoji: HATS[roster.length].emoji, human: false });
  }
  return roster;
}

/* ---- pigs. Flags: 1 out, 2 in the world (visible), 4 dashing, 8 grounded, 16 human, 32 stunned. */
export function packPig(p) {
  const b = p.body, q = b.quaternion, v = b.velocity;
  const flags = (p.out ? 1 : 0) | (p.inWorld ? 2 : 0) | (p.dash > 0 ? 4 : 0) | (p.grounded > 0 ? 8 : 0) | (p.human ? 16 : 0) | (p.stun > 0 ? 32 : 0);
  return [r3(b.position.x), r3(b.position.y), r3(b.position.z), r3(q.x), r3(q.y), r3(q.z), r3(q.w), r2(v.x), r2(v.y), r2(v.z),
    flags, p.balloons | 0, p.truffles | 0, r2(p.throne), p.bank | 0, p.hits | 0, r2(p.respawn)];
}
export function unpackPig(a) {
  if (!Array.isArray(a)) return null;
  const flags = num(a[10]);
  return { x: num(a[0]), y: num(a[1]), z: num(a[2]), qx: num(a[3]), qy: num(a[4]), qz: num(a[5]), qw: num(a[6], 1), vx: num(a[7]), vy: num(a[8]), vz: num(a[9]),
    out: !!(flags & 1), inWorld: !!(flags & 2), dash: !!(flags & 4), grounded: !!(flags & 8), human: !!(flags & 16), stun: !!(flags & 32),
    balloons: num(a[11]), truffles: num(a[12]), throne: num(a[13]), bank: num(a[14]), hits: num(a[15]), respawn: num(a[16], -1) };
}

/* ---- the snapshot guard: only the current match's snapshots, and only in order. PLAY AGAIN restarts the host's numbering
   at 1 while the last snapshots of the old match may still be on the wire; one of those would put the old title screen
   back up and, being far ahead, poison the sequence check for the whole new match. */
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

/* ---- a client's wish for its pig: a direction, whether HOP is held; DASH travels separately as a one-off `da` message */
export const cleanWish = m => ({ mx: Math.max(-1, Math.min(1, num(m.x))), mz: Math.max(-1, Math.min(1, num(m.y))), jump: !!m.j });
