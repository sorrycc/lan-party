/* Touch controls shared by the games (a steering pad or thumb stick, hold buttons), built on Pointer Events so several fingers work at once.
   Each control owns the pointer that touched it (pointer capture), so a thumb sliding off a button keeps it held;
   everything is released on pointercancel, on window blur and when the page is hidden.
   iOS Safari can end a touch without ever sending the pointerup (the element under the finger changed mid-press, a
   system gesture took the touch over), which would leave a control held for good. So a control also lets go on
   lostpointercapture and when the raw touch list no longer has a finger on it, and a new press always wins over a
   pointer the control still thinks it holds. `state.pid` / `state.last` say what happened last, for a stats readout.
   Give every control element `touch-action: none` in CSS, or the browser cancels the pointer to scroll. */
export const isCoarse = () => !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);

export function createTouch() {
  const controls = []; let on = false;
  const releaseAll = () => { for (const c of controls) c.release(); };
  const onHide = () => { if (document.hidden) releaseAll(); };
  const capture = (el, id) => { try { el.setPointerCapture(id); } catch {} };
  const listen = (el, on, handlers) => { for (const [type, fn] of Object.entries(handlers)) el[on ? 'addEventListener' : 'removeEventListener'](type, fn); };
  const noTouchOn = (el, e) => { for (const t of e.touches || []) if (t.target === el || (el.contains && el.contains(t.target))) return false; return true; };
  function register(c) { controls.push(c); if (on) c.attach(); }

  /* The pointer bookkeeping every control shares: which pointer it holds and all the ways it lets go.
     `down(e)` / `move(e)` / `up(e)` are the control's own reactions; `e` is null when the release is not an event. */
  function track(el, state, { down, move, up }) {
    let pid = null;
    const drop = (e, why) => { if (pid === null) return; pid = null; state.pid = null; state.last = why; el.classList.remove('on'); up(e); };
    const h = {
      pointerdown: e => {
        if (e.pointerId === pid) return;
        if (pid !== null) drop(e, 'replaced'); // a stale pointer, or a second finger: the newest press wins
        pid = e.pointerId; state.pid = pid; state.last = 'down'; capture(el, pid); e.preventDefault(); el.classList.add('on'); down(e);
      },
      pointermove: e => { if (e.pointerId === pid) move(e); },
      pointerup: e => { if (e.pointerId === pid) { move(e); drop(e, 'up'); } },
      pointercancel: e => { if (e.pointerId === pid) drop(e, 'cancel'); },
      lostpointercapture: e => { if (e.pointerId === pid) drop(e, 'lost'); },
      touchend: e => { if (pid !== null && noTouchOn(el, e)) drop(e, 'touchend'); },
      touchcancel: e => { if (pid !== null && noTouchOn(el, e)) drop(e, 'touchcancel'); },
      contextmenu: e => e.preventDefault(),
    };
    register({ release: () => drop(null, 'reset'), attach: () => listen(el, true, h), detach: () => { drop(null, 'reset'); listen(el, false, h); } });
  }

  /* A hold button. `state.held` is true while a pointer is down on it; `state.dx` / `state.dy` are how far it was
     dragged in CSS pixels, so a release can carry a gesture (drag down to throw backward). */
  function button(el, { onDown, onUp } = {}) {
    const state = { held: false, dx: 0, dy: 0, pid: null, last: '' }; let sx = 0, sy = 0;
    track(el, state, {
      down: e => { sx = e.clientX; sy = e.clientY; state.dx = state.dy = 0; state.held = true; onDown?.(state, e); },
      move: e => { state.dx = e.clientX - sx; state.dy = e.clientY - sy; },
      up: e => { state.held = false; onUp?.(state, e); state.dx = state.dy = 0; },
    });
    return state;
  }

  /* A steering pad, or with `axes: 2` a thumb stick: touch anywhere in `el` and drag. `state.x` runs -1..1 relative to
     where the finger landed and snaps back to 0 on release; `state.raw` is the raw drag in CSS pixels. A stick adds
     `state.y` (and `state.rawY`) on the same terms, with the pair clamped to the unit circle so a diagonal push is no
     faster than a straight one.
     `dead` is the slack around the touch origin that does not steer at all, because a thumb never lands still;
     past it the drag is shaped by `curve` (above 1: fine near the centre, full lock still at `range` pixels), so
     small corrections are easy without putting full lock out of reach. `state.range`, `state.dead` and `state.curve`
     are read on every move, so writing them changes the sensitivity mid-race.
     The element gets the CSS variables --ox / --oy (touch origin, px) and --sx / --sy (the steering, -1..1, unitless)
     so a stylesheet can draw a ring and a knob. */
  function pad(el, { range = 80, dead = 0, curve = 1, axes = 1, onDown, onUp } = {}) {
    const state = { held: false, x: 0, y: 0, raw: 0, rawY: 0, range, dead, curve, pid: null, last: '' }; let sx = 0, sy = 0;
    const shape = px => {
      const a = Math.abs(px) - state.dead; if (a <= 0) return 0;
      const t = Math.min(1, a / Math.max(1, state.range - state.dead));
      return Math.sign(px) * (state.curve === 1 ? t : Math.pow(t, state.curve));
    };
    const set = (px, py) => {
      state.raw = px; state.rawY = py;
      if (axes < 2) { state.x = shape(px); state.y = 0; }
      else { const m = Math.hypot(px, py), k = m > 0 ? shape(m) / m : 0; state.x = px * k; state.y = py * k; } // shape the distance, keep the direction
      el.style.setProperty('--sx', state.x.toFixed(3)); el.style.setProperty('--sy', state.y.toFixed(3));
    };
    track(el, state, {
      down: e => {
        sx = e.clientX; sy = e.clientY; state.held = true;
        const r = el.getBoundingClientRect(); el.style.setProperty('--ox', (e.clientX - r.left).toFixed(1) + 'px'); el.style.setProperty('--oy', (e.clientY - r.top).toFixed(1) + 'px');
        set(0, 0); onDown?.(state, e);
      },
      move: e => set(e.clientX - sx, e.clientY - sy),
      up: e => { state.held = false; set(0, 0); onUp?.(state, e); },
    });
    return state;
  }

  return {
    button, pad, releaseAll,
    attach() { if (on) return; on = true; for (const c of controls) c.attach(); addEventListener('blur', releaseAll); document.addEventListener('visibilitychange', onHide); },
    detach() { if (!on) return; on = false; for (const c of controls) c.detach(); removeEventListener('blur', releaseAll); document.removeEventListener('visibilitychange', onHide); },
  };
}
