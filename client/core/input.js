/* Keyboard state. `map` is { KeyCode: 'name' }; `held[name]` is true while any mapped key is down.
   Key presses in text inputs are ignored, key repeats are swallowed, and window blur releases everything.
   Handlers: onDown(name, e, wasHeld), onUp(name, e), onKey(e) for unmapped non-repeat keydowns. */
export function createInput(map, { onDown, onUp, onKey } = {}) {
  const held = {}; for (const name of Object.values(map)) held[name] = false;
  const typing = e => e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable);
  const reset = () => { for (const name of Object.keys(held)) held[name] = false; };
  const keydown = e => {
    if (typing(e)) return;
    if (e.repeat) { if (map[e.code] || e.code === 'Space') e.preventDefault(); return; }
    const name = map[e.code];
    if (name) { const was = held[name]; held[name] = true; e.preventDefault(); onDown?.(name, e, was); }
    else onKey?.(e);
  };
  const keyup = e => { const name = map[e.code]; if (name) { held[name] = false; onUp?.(name, e); } };
  let on = false;
  return {
    held, reset,
    attach() { if (on) return; on = true; addEventListener('keydown', keydown); addEventListener('keyup', keyup); addEventListener('blur', reset); },
    detach() { if (!on) return; on = false; removeEventListener('keydown', keydown); removeEventListener('keyup', keyup); removeEventListener('blur', reset); reset(); },
  };
}
