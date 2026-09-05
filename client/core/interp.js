/* Snapshot buffers for things simulated on another machine, and the per-sender clock that keeps their timeline honest. */
import { clamp } from './math.js';
export const nowSec = () => performance.now() / 1000;

/* Append a snapshot stamped with time `t` (by default the local receive time). */
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

/* Per-sender clock. A sender stamps each snapshot with its own performance.now() (ms); `map` turns that into this
   machine's nowSec() base, so snapshots keep the sender's spacing however unevenly the network delivered them (three at
   once after a slow frame, Wi-Fi jitter). Stamping on arrival instead would collapse a burst into one instant and make the
   interpolation jump.
   The mapping is `sender time + offset`, where offset is the smallest (receive - send) seen in a sliding window, i.e. the
   fastest recent packet; `jitter` is how much later than that the others came. `delay` is how far behind the present
   remote objects should be shown to stay inside the data on this link: zero on a clean LAN (dead reckoning covers the
   last few milliseconds), more when arrivals jitter; `tick(dt)` eases the applied `D` toward it so the timeline never
   lurches. `offset` may creep up by `drift` per window when the fastest packets stop being that fast. The constant part of
   the one-way latency hides inside `offset`, so the game feeds `ping(rtt)` and reads `transit` to place the sender's present. */
export function createSnapClock({ window = 4, drift = 0.005, rate = 0.05 } = {}) {
  let offMin = Infinity, nextMin = Infinity, winEnd = 0, jitMax = 0, nextMax = 0, jitter = 0, lastTs = -Infinity, interval = 1 / 30, n = 0, D = 0, rtt = 0, transit = 0;
  const rtts = [];
  const reset = () => { offMin = nextMin = Infinity; winEnd = 0; jitMax = nextMax = 0; jitter = 0; lastTs = -Infinity; n = 0; };
  return {
    map(ts, recv = nowSec()) {
      const t = ts / 1000, off = recv - t;
      if (n && (off < offMin - 1 || off > offMin + 5)) reset(); // the sender's clock jumped (a reload) or the link was dead for seconds: start over
      if (recv >= winEnd) { if (n) { offMin = Math.min(nextMin, offMin + drift); jitMax = nextMax; } winEnd = recv + window; nextMin = Infinity; nextMax = 0; }
      if (off < offMin) offMin = off; if (off < nextMin) nextMin = off;
      const ex = off - offMin; if (ex > nextMax) nextMax = ex; if (ex > jitMax) jitMax = ex; jitter += (ex - jitter) * 0.1;
      if (t > lastTs) { if (lastTs > -Infinity) interval += (Math.min(t - lastTs, 0.5) - interval) * 0.1; lastTs = t; }
      n++;
      return t + offMin;
    },
    tick(dt) { const want = this.delay; D += clamp(want - D, -rate * dt, rate * dt); },
    /* a measured round trip to this sender (seconds). The constant part of the one-way latency is invisible to the stamp mapping
       (it lives inside `offset`), so `transit`, half the best of the last few round trips, is how far past the mapped stamps the
       sender's present really is; remote objects are carried forward by it. */
    ping(rttSec) { rtt = rttSec; rtts.push(rttSec); if (rtts.length > 10) rtts.shift(); transit = Math.min(...rtts) / 2; },
    get rtt() { return rtt; }, get transit() { return transit; },
    get delay() { return n ? clamp((jitMax - 0.05) * 0.5, 0, 0.1) : 0; }, // extrapolating through a late packet costs a centimetre-scale glide; every ms of backoff is positional lag, so back off gently
    get D() { return D; }, get jitter() { return jitter; }, get jitterMax() { return jitMax; }, get interval() { return interval; }, get offset() { return offMin; }, get count() { return n; },
    reset,
  };
}
