/* A steady timer that keeps going in a background tab. Page timers slow to about once a second when the tab is hidden and
   requestAnimationFrame stops altogether, but a worker's timers do not, so the worker keeps time and posts a message per
   tick. Falls back to setInterval where workers or blob URLs are unavailable. */
export function createTicker(hz, fn) {
  const ms = Math.max(1, Math.round(1000 / hz)); let worker = null, url = null, timer = 0, on = false;
  try {
    url = URL.createObjectURL(new Blob(['let id=0;onmessage=e=>{clearInterval(id);id=0;if(e.data>0)id=setInterval(()=>postMessage(0),e.data)}'], { type: 'text/javascript' }));
    worker = new Worker(url); worker.onmessage = () => { if (on) fn(); };
  } catch { worker = null; }
  return {
    start() { if (on) return; on = true; if (worker) worker.postMessage(ms); else timer = setInterval(fn, ms); },
    stop() { if (!on) return; on = false; if (worker) worker.postMessage(0); else { clearInterval(timer); timer = 0; } },
    dispose() { this.stop(); if (worker) { worker.terminate(); worker = null; } if (url) { URL.revokeObjectURL(url); url = null; } },
    get running() { return on; },
  };
}
