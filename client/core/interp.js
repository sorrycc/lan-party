/* Snapshot buffers for things simulated on another machine. Remote objects are rendered `delay` seconds in
   the past so there is normally a snapshot on either side of the render time to interpolate between. */
export const nowSec = () => performance.now() / 1000;

/* Append a snapshot stamped with the local receive time. */
export function pushSnap(buf, snap, t = nowSec(), max = 24) { snap.t = t; buf.push(snap); if (buf.length > max) buf.shift(); return buf; }

/* Find the snapshots around render time `rt`. Returns null for an empty buffer, else
   { a, b, f, prev }: `a` is the latest snapshot at or before rt, `b` the one after it (or null when we have
   run out and must extrapolate from `a`), `f` the blend factor between them, `prev` the snapshot before `a`. */
export function sampleSnaps(buf, rt) {
  if (!buf.length) return null;
  let i = buf.length - 1; while (i > 0 && buf[i].t > rt) i--;
  const a = buf[i], b = buf[i].t <= rt ? (buf[i + 1] || null) : null, prev = buf[i - 1] || null;
  const f = b ? Math.min(1, Math.max(0, (rt - a.t) / Math.max(b.t - a.t, 1e-3))) : 0;
  return { a, b, f, prev };
}
