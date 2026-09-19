/* Picks a render quality level from the frame times it is fed: level 0 is the best picture, `levels - 1` the cheapest.
   A frame loop only ever sees whole display intervals, so "fast enough" is measured against the display and not a number:
   the shortest smoothed interval seen (60 Hz until a shorter one shows) is taken for the display's own, and a level may go back up only while frames hold it.
   It steps down after `downAfter` seconds of long frames, up after `upAfter` seconds of full-rate ones, and every step up
   that had to be taken back doubles the wait, until after `maxFails` of them it stays where it is. */
export function createQuality({ levels = 3, slowMs = 18, slowRatio = 1.15, fastRatio = 1.05, downAfter = 2, upAfter = 10, maxFails = 2, onChange } = {}) {
  let level = 0, avg = 0, quick = 0, refresh = 1000 / 60, slowT = 0, fastT = 0, wait = upAfter, fails = 0, cameUp = false;
  const set = l => { const from = level; level = l; avg = 0; slowT = fastT = 0; onChange?.(level, from); };
  return {
    get level() { return level; }, get frameMs() { return avg; }, get refreshMs() { return refresh; },
    /* one rendered frame that took `dt` seconds; a frame after a pause (a hidden tab, a breakpoint) says nothing and is skipped */
    sample(dt) {
      const ms = dt * 1000; if (!(ms > 0) || ms > 200) return level;
      quick = quick ? quick + (ms - quick) * .2 : ms; if (quick > 4 && quick < refresh) refresh = quick;
      avg = avg ? avg + (ms - avg) * (1 - Math.exp(-dt / .5)) : ms;
      const slow = avg > Math.max(slowMs, refresh * slowRatio), fast = avg < refresh * fastRatio;
      slowT = slow ? slowT + dt : 0; fastT = fast ? fastT + dt : 0;
      if (slowT >= downAfter && level < levels - 1) { if (cameUp) { fails++; wait *= 2; } cameUp = false; set(level + 1); }
      else if (fastT >= wait && level > 0 && fails < maxFails) { cameUp = true; set(level - 1); }
      else if (cameUp && fastT >= downAfter * 2) cameUp = false; // the step up held
      return level;
    },
  };
}
