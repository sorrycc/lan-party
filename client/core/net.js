/* Thin WebSocket client: JSON messages in, JSON messages out, handlers keyed by message type. */
export class Net {
  constructor() { this.ws = null; this.handlers = new Map(); this.id = null; }
  connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url); this.ws = ws;
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error('Could not reach the server'));
      ws.onclose = () => { this.ws = null; this.emit('_close', {}); };
      ws.onmessage = ev => { let msg; try { msg = JSON.parse(ev.data); } catch { return; } if (msg && msg.t) this.emit(msg.t, msg); };
    });
  }
  get open() { return !!this.ws && this.ws.readyState === WebSocket.OPEN; }
  send(msg) { if (this.open) this.ws.send(JSON.stringify(msg)); }
  on(type, fn) { this.handlers.set(type, fn); return this; }
  emit(type, msg) { const fn = this.handlers.get(type); if (fn) fn(msg); else { const any = this.handlers.get('*'); if (any) any(msg); } }
  close() { if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; } }
}
export const wsUrl = () => (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host;
