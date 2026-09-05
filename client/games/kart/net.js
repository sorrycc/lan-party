/* Frostline Kart wire format. Two streams per machine, both plain arrays so they stay small and cheap to parse:
   - motion (`s`, NET_HZ): where each kart this machine drives is and how it is being driven, plus flags for the effects
     that change how it moves. Remote machines dead-reckon it forward from this.
   - status (`u`, STATUS_HZ, or at once when something discrete changes): laps, items, coins and the effect timers.
   The host's motion message also carries the race clock and every hazard, its status message the item box and coin state.
   Every message is stamped with the sender's clock (`ts`, its performance.now() at the simulated state).
   No browser or three.js dependency, so `node --test` can exercise it. */
export const NET_HZ = 30, STATUS_HZ = 5;
export const F = { BOOST: 1, SPIN: 2, STAR: 4, BULLET: 8, SHRINK: 16, INK: 32, OFFROAD: 64, FINISHED: 128 };
export const HAZ_TYPES = ['green', 'red', 'banana', 'bomb', 'fire', 'blue'];
const r2 = v => Math.round(v * 100) / 100, r3 = v => Math.round(v * 1000) / 1000, tm = v => v > 0 ? r2(v) : 0;

export const kartFlags = k => (k.boost > 0 ? F.BOOST : 0) | (k.spin > 0 ? F.SPIN : 0) | (k.star > 0 ? F.STAR : 0) | (k.bullet > 0 ? F.BULLET : 0) | (k.shrink > 0 ? F.SHRINK : 0) | (k.ink > 0 ? F.INK : 0) | (k.offroad ? F.OFFROAD : 0) | (k.finished ? F.FINISHED : 0);
export const packMotion = k => [k.id, r2(k.x), r2(k.z), r3(k.h), r2(k.vx), r2(k.vz), r2(k.vf), r2(k.steer), k.throttle, kartFlags(k)];
export const unpackMotion = a => ({ i: a[0] | 0, x: +a[1] || 0, z: +a[2] || 0, h: +a[3] || 0, vx: +a[4] || 0, vz: +a[5] || 0, vf: +a[6] || 0, st: +a[7] || 0, th: +a[8] || 0, fl: a[9] | 0 });

export const packStatus = k => [k.id, k.lap, k.cpNext, tm(k.boost), tm(k.spin), r2(k.spinAng), tm(k.star), tm(k.shrink), tm(k.bullet), tm(k.ink), k.item || 0, k.itemN, k.held ? 1 : 0, k.coins, tm(k.roulette), k.finished ? 1 : 0, r2(k.finishTime)];
export const unpackStatus = a => ({ i: a[0] | 0, lp: a[1] | 0, cp: a[2] | 0, bo: +a[3] || 0, sp: +a[4] || 0, sa: +a[5] || 0, sr: +a[6] || 0, sh: +a[7] || 0, bu: +a[8] || 0, ik: +a[9] || 0, it: typeof a[10] === 'string' ? a[10] : null, ic: a[11] | 0, he: !!a[12], co: a[13] | 0, ro: +a[14] || 0, fi: !!a[15], ft: +a[16] || 0 });
/* the discrete part of a kart's status; when it changes the status goes out at once instead of waiting for the next slot */
export const statusKey = k => `${k.lap}|${k.cpNext}|${k.item}|${k.itemN}|${k.held ? 1 : 0}|${k.coins}|${k.finished ? 1 : 0}|${k.boost > 0 ? 1 : 0}${k.spin > 0 ? 1 : 0}${k.star > 0 ? 1 : 0}${k.bullet > 0 ? 1 : 0}${k.shrink > 0 ? 1 : 0}${k.ink > 0 ? 1 : 0}`;

/* hazards: id, type, owner kart, pose, velocity, height above the road and (while flying) vertical speed, heading (homing shells), target (blue) and fuse (bomb) */
export const packHaz = h => [h.id, HAZ_TYPES.indexOf(h.type), h.owner, r2(h.x), r2(h.z), r2(h.vx), r2(h.vz), h.air > 0 ? r2(h.air) : 0, h.fly ? r2(h.vy) : 0, h.type === 'red' || h.type === 'blue' ? r3(h.h) : 0, h.type === 'blue' ? h.target : -1, h.type === 'bomb' ? r2(h.fuse) : 0];
export const unpackHaz = a => ({ id: a[0] | 0, ty: HAZ_TYPES[a[1] | 0] || 'green', o: a[2] | 0, x: +a[3] || 0, z: +a[4] || 0, vx: +a[5] || 0, vz: +a[6] || 0, a: +a[7] || 0, vy: +a[8] || 0, h: +a[9] || 0, tg: a[10] === undefined ? -1 : a[10] | 0, f: +a[11] || 0 });
