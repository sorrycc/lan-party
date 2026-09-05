/* Player preferences remembered across visits. Falls back to the keys the kart-only build used. */
const KEYS = { name: ['lan_name', 'fk_name'], avatar: ['lan_avatar', 'fk_skin'], game: ['lan_game'] };
const read = list => { for (const k of list) { try { const v = localStorage.getItem(k); if (v !== null) return v; } catch {} } return null; };
export function loadPrefs() { return { name: read(KEYS.name) || '', avatar: Number(read(KEYS.avatar)) || 0, game: read(KEYS.game) || '' }; }
export function savePrefs({ name, avatar, game }) { try { localStorage.setItem(KEYS.name[0], name); localStorage.setItem(KEYS.avatar[0], String(avatar)); if (game) localStorage.setItem(KEYS.game[0], game); } catch {} }
