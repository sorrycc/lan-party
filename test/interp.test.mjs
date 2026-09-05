/* The per-sender snapshot clock: sender stamps survive bursts and jitter, and the buffer samples sanely around them. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createSnapClock, pushSnap, sampleSnaps } from '../client/core/interp.js';

const rng = seed => () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

test('mapped stamps keep the sender spacing through jitter and bursts', () => {
  const clock = createSnapClock(), rnd = rng(7), base = 500; // sender clock (ms) and our clock (s) are unrelated
  const stamps = [];
  let pending = []; // arrivals held back to form a burst
  for (let i = 0; i < 600; i++) {
    const ts = 1000 + i * 1000 / 30, sent = base + i / 30;
    let arrive = sent + 0.004 + rnd() * 0.04; // 4 ms transit + up to 40 ms jitter
    if (i > 10 && i % 20 < 3) { pending.push({ ts, arrive }); if (i % 20 < 2) continue; arrive = pending[pending.length - 1].arrive; for (const p of pending) stamps.push(clock.map(p.ts, arrive)); pending = []; continue; } // after the warm-up, three arrive at once
    stamps.push(clock.map(ts, arrive));
  }
  let bad = 0;
  for (let i = 1; i < stamps.length; i++) { const gap = stamps[i] - stamps[i - 1]; assert.ok(gap > 0.02, `stamp ${i} gap ${gap}`); if (Math.abs(gap - 1 / 30) > 0.002) bad++; }
  assert.ok(bad <= 3, `${bad} gaps off the 33 ms spacing (only the first offset adoptions may be)`);
  assert.ok(clock.jitter > 0.005 && clock.jitter < 0.045, `jitter ${clock.jitter}`);
  assert.ok(clock.jitterMax <= 0.115 && clock.jitterMax > 0.06, `jitterMax ${clock.jitterMax} (the first packet of a burst really is two intervals late)`);
  assert.ok(clock.delay >= 0.02 && clock.delay <= 0.04, `delay ${clock.delay}: bursts of three call for a little backoff`);
  assert.ok(Math.abs(clock.interval - 1 / 30) < 0.003, `interval ${clock.interval}`);
});

test('a clean link asks for no delay, a jittery one for some, and D eases toward it', () => {
  const clean = createSnapClock(); for (let i = 0; i < 100; i++) clean.map(i * 33, 10 + i * 0.033 + 0.003);
  assert.equal(clean.delay, 0);
  const rough = createSnapClock(), rnd = rng(3); for (let i = 0; i < 300; i++) rough.map(i * 33, 10 + i * 0.033 + 0.005 + rnd() * 0.12);
  assert.ok(rough.delay > 0.02 && rough.delay <= 0.1, `delay ${rough.delay}`);
  for (let i = 0; i < 30; i++) rough.tick(1 / 60);
  assert.ok(rough.D > 0.02 && rough.D <= 0.026, `D eased ${rough.D}`);
  for (let i = 0; i < 600; i++) rough.tick(1 / 60);
  assert.ok(Math.abs(rough.D - rough.delay) < 1e-6, 'D reaches the target');
});

test('transit is half the best recent round trip', () => {
  const c = createSnapClock(); c.ping(0.1); c.ping(0.062); c.ping(0.3);
  assert.equal(c.rtt, 0.3); assert.ok(Math.abs(c.transit - 0.031) < 1e-9);
  for (let i = 0; i < 10; i++) c.ping(0.08); assert.ok(Math.abs(c.transit - 0.04) < 1e-9, 'old lows fall out of the window');
});

test('a sender that reloaded (clock jumps back) is re-synced instead of mapped years away', () => {
  const clock = createSnapClock(); let t = 100;
  for (let i = 0; i < 50; i++) clock.map(90000 + i * 33, (t += 0.033));
  const before = clock.map(90000 + 50 * 33, (t += 0.033));
  const after = clock.map(120, (t += 0.033)); // performance.now() restarted
  assert.ok(Math.abs(after - t) < 0.001, `remapped near now: ${after} vs ${t}`);
  assert.ok(after > before - 1, 'timeline continues');
});

test('sampleSnaps interpolates between neighbours and extrapolates past the end', () => {
  const buf = []; pushSnap(buf, { x: 0 }, 1); pushSnap(buf, { x: 10 }, 2); pushSnap(buf, { x: 20 }, 3);
  let s = sampleSnaps(buf, 1.5); assert.equal(s.a.x, 0); assert.equal(s.b.x, 10); assert.ok(Math.abs(s.f - 0.5) < 1e-9);
  s = sampleSnaps(buf, 3.2); assert.equal(s.a.x, 20); assert.equal(s.b, null);
  s = sampleSnaps(buf, 0.5); assert.equal(s.a.x, 0); assert.equal(s.b, null); // before the first: hold it
  assert.equal(sampleSnaps([], 1), null);
});
