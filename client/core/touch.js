/* Touch controls shared by the games, built on Pointer Events so several fingers work at once.
   Each control owns the pointer that touched it (pointer capture), so a thumb sliding off a button keeps it held;
   everything is released on pointercancel, on window blur and when the page is hidden.
   Give every control element `touch-action: none` in CSS, or the browser cancels the pointer to scroll. */
export const isCoarse = () => !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);

export function createTouch() {
  const controls = []; let on = false;
  const releaseAll = () => { for (const c of controls) c.release(); };
  const onHide = () => { if (document.hidden) releaseAll(); };
  const capture = (el, id) => { try { el.setPointerCapture(id); } catch {} };
  const listen = (el, on, handlers) => { for (const [type, fn] of Object.entries(handlers)) el[on ? 'addEventListener' : 'removeEventListener'](type, fn); };
  function register(c) { controls.push(c); if (on) c.attach(); }

  /* A hold button. `state.held` is true while a pointer is down on it; `state.dx` / `state.dy` are how far it was
     dragged in CSS pixels, so a release can carry a gesture (drag down to throw backward). */
  function button(el, { onDown, onUp } = {}) {
    const state = { held: false, dx: 0, dy: 0 }; let pid = null, sx = 0, sy = 0;
    const release = e => { if (pid === null) return; pid = null; state.held = false; el.classList.remove('on'); onUp?.(state, e); state.dx = state.dy = 0; };
    const h = {
      pointerdown: e => { if (pid !== null) return; pid = e.pointerId; sx = e.clientX; sy = e.clientY; state.dx = state.dy = 0; state.held = true; capture(el, pid); e.preventDefault(); el.classList.add('on'); onDown?.(state, e); },
      pointermove: e => { if (e.pointerId !== pid) return; state.dx = e.clientX - sx; state.dy = e.clientY - sy; },
      pointerup: e => { if (e.pointerId !== pid) return; state.dx = e.clientX - sx; state.dy = e.clientY - sy; release(e); },
      pointercancel: e => { if (e.pointerId === pid) release(e); },
      contextmenu: e => e.preventDefault(),
    };
    register({ release: () => release(null), attach: () => listen(el, true, h), detach: () => { release(null); listen(el, false, h); } });
    return state;
  }

  /* A steering pad: touch anywhere in `el` and drag sideways. `state.x` runs -1..1 relative to where the finger
     landed (full lock after `range` CSS pixels) and snaps back to 0 on release. The element gets the CSS variables
     --ox / --oy (touch origin, px) and --px (drag offset, px) so a stylesheet can draw a ring and a knob. */
  function pad(el, { range = 80, onDown, onUp } = {}) {
    const state = { held: false, x: 0 }; let pid = null, sx = 0;
    const setX = x => { state.x = Math.max(-1, Math.min(1, x)); el.style.setProperty('--px', (state.x * range).toFixed(1) + 'px'); };
    const release = e => { if (pid === null) return; pid = null; state.held = false; setX(0); el.classList.remove('on'); onUp?.(state, e); };
    const h = {
      pointerdown: e => {
        if (pid !== null) return; pid = e.pointerId; sx = e.clientX; state.held = true; capture(el, pid); e.preventDefault();
        const r = el.getBoundingClientRect(); el.style.setProperty('--ox', (e.clientX - r.left).toFixed(1) + 'px'); el.style.setProperty('--oy', (e.clientY - r.top).toFixed(1) + 'px');
        setX(0); el.classList.add('on'); onDown?.(state, e);
      },
      pointermove: e => { if (e.pointerId === pid) setX((e.clientX - sx) / range); },
      pointerup: e => { if (e.pointerId === pid) release(e); },
      pointercancel: e => { if (e.pointerId === pid) release(e); },
      contextmenu: e => e.preventDefault(),
    };
    register({ release: () => release(null), attach: () => listen(el, true, h), detach: () => { release(null); listen(el, false, h); } });
    return state;
  }

  return {
    button, pad, releaseAll,
    attach() { if (on) return; on = true; for (const c of controls) c.attach(); addEventListener('blur', releaseAll); document.addEventListener('visibilitychange', onHide); },
    detach() { if (!on) return; on = false; for (const c of controls) c.detach(); removeEventListener('blur', releaseAll); document.removeEventListener('visibilitychange', onHide); },
  };
}
