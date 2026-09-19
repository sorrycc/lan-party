/* The touch controls' pointer bookkeeping: a tap, a stale pointer replaced by a new press, and the iOS fallbacks. */
import test from 'node:test';
import assert from 'node:assert/strict';

/* the module touches window / document only inside attach(); give it just enough of a DOM */
const noop = () => {};
globalThis.window = globalThis; globalThis.addEventListener = noop; globalThis.removeEventListener = noop;
globalThis.document = { hidden: false, addEventListener: noop, removeEventListener: noop };
const { createTouch } = await import('../client/core/touch.js');

function fakeEl() {
  const listeners = {}, classes = new Set();
  const el = {
    addEventListener(t, f) { (listeners[t] ||= []).push(f); }, removeEventListener(t, f) { listeners[t] = (listeners[t] || []).filter(g => g !== f); },
    setPointerCapture: noop, contains: t => t === el, style: { setProperty: noop }, getBoundingClientRect: () => ({ left: 0, top: 0 }),
    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
    fire(type, e = {}) { for (const f of listeners[type] || []) f({ pointerId: 0, clientX: 0, clientY: 0, touches: [], preventDefault: noop, ...e }); },
    listening: () => Object.values(listeners).reduce((n, l) => n + l.length, 0),
  };
  return el;
}
function setup(kind = 'button', opts = {}) {
  const tc = createTouch(), el = fakeEl(), log = [];
  const s = tc[kind](el, { onDown: () => log.push('down'), onUp: st => log.push(kind === 'button' ? 'up:' + st.dy : 'up'), ...opts });
  tc.attach(); return { tc, el, s, log };
}

test('a tap holds the button from pointerdown to pointerup and the release carries the drag', () => {
  const { el, s, log } = setup();
  el.fire('pointerdown', { pointerId: 3, clientX: 10, clientY: 10 });
  assert.equal(s.held, true); assert.equal(s.pid, 3); assert.equal(s.last, 'down'); assert.ok(el.classList.contains('on'));
  el.fire('pointermove', { pointerId: 3, clientX: 10, clientY: 30 }); assert.equal(s.dy, 20);
  el.fire('pointerup', { pointerId: 3, clientX: 10, clientY: 50 });
  assert.equal(s.held, false); assert.equal(s.pid, null); assert.equal(s.last, 'up'); assert.ok(!el.classList.contains('on'));
  assert.deepEqual(log, ['down', 'up:40']); assert.equal(s.dy, 0, 'the drag is cleared once the release has been reported');
});

test('another pointer\'s move, up and cancel do not touch a held button', () => {
  const { el, s, log } = setup();
  el.fire('pointerdown', { pointerId: 1, clientY: 0 });
  el.fire('pointermove', { pointerId: 2, clientY: 90 }); el.fire('pointerup', { pointerId: 2 }); el.fire('pointercancel', { pointerId: 2 }); el.fire('lostpointercapture', { pointerId: 2 });
  assert.equal(s.held, true); assert.equal(s.dy, 0); assert.deepEqual(log, ['down']);
});

test('a new press replaces a pointer the button never saw released, instead of being ignored', () => {
  const { el, s, log } = setup();
  el.fire('pointerdown', { pointerId: 1 });
  el.fire('pointerdown', { pointerId: 2 });
  assert.equal(s.held, true); assert.equal(s.pid, 2); assert.deepEqual(log, ['down', 'up:0', 'down']);
  el.fire('pointerup', { pointerId: 1 }); assert.equal(s.held, true, 'a late up for the stale pointer changes nothing');
  el.fire('pointerdown', { pointerId: 2 }); assert.deepEqual(log, ['down', 'up:0', 'down'], 'a repeated down for the held pointer is ignored');
  el.fire('pointerup', { pointerId: 2 }); assert.equal(s.held, false); assert.deepEqual(log, ['down', 'up:0', 'down', 'up:0']);
});

test('touchend releases only once no finger is left on the control', () => {
  const { el, s } = setup();
  el.fire('pointerdown', { pointerId: 1 });
  el.fire('touchend', { touches: [{ target: el }] }); assert.equal(s.held, true, 'a finger still on the control keeps it held');
  el.fire('touchend', { touches: [{ target: {} }] }); assert.equal(s.held, false); assert.equal(s.last, 'touchend');
  el.fire('pointerdown', { pointerId: 4 }); el.fire('touchcancel', { touches: [] }); assert.equal(s.held, false); assert.equal(s.last, 'touchcancel');
});

test('lostpointercapture and pointercancel release', () => {
  const { el, s } = setup();
  el.fire('pointerdown', { pointerId: 1 }); el.fire('lostpointercapture', { pointerId: 1 }); assert.equal(s.held, false); assert.equal(s.last, 'lost');
  el.fire('pointerdown', { pointerId: 2 }); el.fire('pointercancel', { pointerId: 2 }); assert.equal(s.held, false); assert.equal(s.last, 'cancel');
});

test('releaseAll lets go, detach lets go and stops listening, attach listens again', () => {
  const { tc, el, s, log } = setup();
  el.fire('pointerdown', { pointerId: 1 }); tc.releaseAll(); assert.equal(s.held, false); assert.equal(s.last, 'reset'); assert.deepEqual(log, ['down', 'up:0']);
  el.fire('pointerdown', { pointerId: 2 }); tc.detach(); assert.equal(s.held, false); assert.equal(el.listening(), 0);
  el.fire('pointerdown', { pointerId: 3 }); assert.equal(s.held, false, 'a detached control ignores events');
  tc.attach(); el.fire('pointerdown', { pointerId: 3 }); assert.equal(s.held, true);
});

test('the pad tracks a sideways drag against where the finger landed and centres on release', () => {
  const { el, s, log } = setup('pad', { range: 100 });
  el.fire('pointerdown', { pointerId: 5, clientX: 200, clientY: 100 }); assert.equal(s.held, true); assert.equal(s.x, 0);
  el.fire('pointermove', { pointerId: 5, clientX: 250, clientY: 100 }); assert.equal(s.x, 0.5);
  el.fire('pointermove', { pointerId: 5, clientX: 0, clientY: 100 }); assert.equal(s.x, -1, 'clamped at full lock');
  assert.equal(s.raw, -200, 'the raw drag is kept for a stats readout');
  el.fire('pointerup', { pointerId: 5, clientX: 0, clientY: 100 }); assert.equal(s.x, 0); assert.equal(s.held, false); assert.deepEqual(log, ['down', 'up']);
  el.fire('pointerdown', { pointerId: 6, clientX: 0 }); el.fire('touchend', { touches: [] }); assert.equal(s.held, false, 'the pad has the same iOS fallback');
});

test('the pad ignores the dead zone and shapes the rest by the curve, full lock still at range', () => {
  const { el, s } = setup('pad', { range: 100, dead: 10, curve: 2 });
  el.fire('pointerdown', { pointerId: 1, clientX: 100, clientY: 0 });
  el.fire('pointermove', { pointerId: 1, clientX: 110 }); assert.equal(s.x, 0, 'a thumb settling does not steer');
  el.fire('pointermove', { pointerId: 1, clientX: 90 }); assert.equal(s.x, 0, 'the dead zone is symmetric');
  el.fire('pointermove', { pointerId: 1, clientX: 155 }); assert.equal(s.x.toFixed(4), '0.2500', 'half the live travel is a quarter lock');
  el.fire('pointermove', { pointerId: 1, clientX: 45 }); assert.equal(s.x.toFixed(4), '-0.2500');
  el.fire('pointermove', { pointerId: 1, clientX: 200 }); assert.equal(s.x, 1, 'full lock is still reached at range');
  el.fire('pointermove', { pointerId: 1, clientX: 400 }); assert.equal(s.x, 1, 'and clamped past it');
});

test('writing the pad range changes the sensitivity from the next move on', () => {
  const { el, s } = setup('pad', { range: 100 });
  el.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 });
  el.fire('pointermove', { pointerId: 1, clientX: 50 }); assert.equal(s.x, 0.5);
  s.range = 50;
  el.fire('pointermove', { pointerId: 1, clientX: 25 }); assert.equal(s.x, 0.5, 'the same steering now takes half the travel');
  el.fire('pointermove', { pointerId: 1, clientX: 50 }); assert.equal(s.x, 1);
});

test('a two-axis stick shapes the distance by dead zone, curve and range and keeps the direction', () => {
  const { el, s, log } = setup('pad', { range: 100, dead: 10, axes: 2 });
  el.fire('pointerdown', { pointerId: 7, clientX: 100, clientY: 100 }); assert.equal(s.held, true);
  el.fire('pointermove', { pointerId: 7, clientX: 105, clientY: 104 }); assert.equal(s.x, 0); assert.equal(s.y, 0, 'inside the dead zone nothing moves');
  el.fire('pointermove', { pointerId: 7, clientX: 100, clientY: 155 }); assert.equal(s.x, 0); assert.ok(Math.abs(s.y - 0.5) < 1e-9, 'half the live travel, straight down'); assert.equal(s.rawY, 55);
  el.fire('pointermove', { pointerId: 7, clientX: 400, clientY: 400 }); assert.ok(Math.abs(Math.hypot(s.x, s.y) - 1) < 1e-9, 'a diagonal is clamped to the unit circle'); assert.ok(s.x > 0.7 && s.y > 0.7);
  el.fire('pointermove', { pointerId: 7, clientX: 40, clientY: 100 }); assert.ok(Math.abs(s.x + 5 / 9) < 1e-9); assert.equal(s.y, 0);
  el.fire('pointerup', { pointerId: 7 }); assert.equal(s.x, 0); assert.equal(s.y, 0); assert.deepEqual(log, ['down', 'up']);
  assert.ok(s.ux < -0.7 && s.uy < -0.7, 'the release keeps where the stick pointed (the pointerup was at 0, 0: up and to the left), for an aim stick to fire along'); assert.equal(s.last, 'up');
  const one = setup('pad', { range: 100 });
  one.el.fire('pointerdown', { pointerId: 1, clientX: 0, clientY: 0 }); one.el.fire('pointermove', { pointerId: 1, clientX: 50, clientY: 300 });
  assert.equal(one.s.x, 0.5); assert.equal(one.s.y, 0, 'a one-axis pad ignores the vertical drag');
});
