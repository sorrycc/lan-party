/* Tiny WebAudio synth shared by the shell and the games. Browsers only allow audio after a user gesture,
   so `init()` is called from click/key handlers; it is a no-op once the context exists.
   Games add their own continuous voices via `whenReady`, which fires now if the context already exists. */
export function createAudio({ volume = 0.5 } = {}) {
  let ctx = null, master = null, muted = false; const ready = new Set();
  const init = () => {
    if (ctx) { if (ctx.state !== 'running') ctx.resume().catch(() => {}); return true; } // iOS also reports a non-standard 'interrupted' state after a call or app switch
    try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return false; }
    master = ctx.createGain(); master.gain.value = muted ? 0 : volume; master.connect(ctx.destination);
    for (const fn of ready) fn(ctx, master); return true;
  };
  const beep = (freq, dur, type = 'square', vol = 0.22, delay = 0) => { if (!ctx || muted) return; const t = ctx.currentTime + delay; const o = ctx.createOscillator(), g = ctx.createGain(); o.type = type; o.frequency.value = freq; g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.001, t + dur); o.connect(g).connect(master); o.start(t); o.stop(t + dur); };
  const noise = (dur, vol = 0.3, freq = 800, q = 1) => { if (!ctx || muted) return; const n = Math.floor(ctx.sampleRate * dur), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0); for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n); const s = ctx.createBufferSource(); s.buffer = b; const f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = freq; f.Q.value = q; const g = ctx.createGain(); g.gain.value = vol; s.connect(f).connect(g).connect(master); s.start(); };
  return {
    init, beep, noise,
    get on() { return !!ctx; }, get ctx() { return ctx; }, get master() { return master; }, get muted() { return muted; },
    whenReady(fn) { ready.add(fn); if (ctx) fn(ctx, master); return () => ready.delete(fn); },
    toggle() { muted = !muted; if (master) master.gain.value = muted ? 0 : volume; return muted; },
  };
}
