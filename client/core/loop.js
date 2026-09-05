/* requestAnimationFrame loop with a clamped real-time delta. `frame(real, now)` runs once per rendered frame. */
export function createLoop(frame, { maxFrame = 0.25 } = {}) {
  let raf = 0, last = 0;
  const tick = now => { raf = requestAnimationFrame(tick); const real = Math.min((now - last) / 1000, maxFrame); last = now; frame(real, now); };
  return {
    start() { if (raf) return; last = performance.now(); raf = requestAnimationFrame(tick); },
    stop() { if (raf) cancelAnimationFrame(raf); raf = 0; },
    get running() { return raf !== 0; },
  };
}

/* Run `step(dt)` in fixed-size sub-steps covering `real` seconds, so game time keeps up even on a slow machine. */
export function fixedStep(real, sub, step) { const n = Math.max(1, Math.ceil(real / sub)); const dt = real / n; for (let i = 0; i < n; i++) step(dt); }
