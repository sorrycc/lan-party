/* DOM odds and ends shared by the shell and the games. */
export const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const hex = c => '#' + c.toString(16).padStart(6, '0');
export const fmtTime = t => { const m = Math.floor(t / 60), s = t - m * 60; return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2); };

/* Short-lived stacked messages inside `el` (a game's HUD provides the container and the .toast styles). */
export function createToasts(el, { max = 4, ttl = 1650 } = {}) {
  return {
    toast(text, cls = '') { const d = document.createElement('div'); d.className = 'toast ' + cls; d.textContent = text; el.appendChild(d); while (el.children.length > max) el.firstChild.remove(); setTimeout(() => d.remove(), ttl); },
    clear() { el.innerHTML = ''; },
  };
}

/* Load a stylesheet once and resolve when it is applied; returns a function that removes it again. */
export function loadStylesheet(href) {
  return new Promise(resolve => {
    const existing = document.querySelector(`link[data-game-css="${href}"]`);
    if (existing) return resolve(() => existing.remove());
    const link = document.createElement('link'); link.rel = 'stylesheet'; link.href = href; link.dataset.gameCss = href;
    const done = () => resolve(() => link.remove());
    link.onload = done; link.onerror = done; setTimeout(done, 2000);
    document.head.appendChild(link);
  });
}
