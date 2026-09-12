/* Game manifest. One source of truth for both sides:
   - the server imports it for capacity limits and option validation,
   - the shell imports it for titles and to lazy-load the chosen game's module.
   `load` is only ever called in the browser.

   A game module exports `create(ctx)`; see games/kart/index.js for the contract.

   Option types the lobby can render:
     { key, type: 'bool',   label, default }
     { key, type: 'number', label, default, min, max, step }
     { key, type: 'select', label, default, choices: [{ value, label }] }

   Team games declare `teams: [{ id, label, color }]` and `teamSize` (max humans per side). The server then
   keeps a `team` per player (auto-balanced on join, switchable in the lobby) and it arrives in `session.players`. */
export const GAMES = [
  {
    id: 'kart', title: 'Frostline Kart', tagline: 'SNOWY CIRCUIT · ITEMS · GRAND PRIX · UP TO 8 KARTS',
    minPlayers: 1, maxPlayers: 8,
    options: [
      { key: 'mode', type: 'select', label: 'MODE', default: 'single', choices: [{ value: 'single', label: 'Single race' }, { value: 'cup', label: 'Grand Prix (4 races)' }] },
      { key: 'cc', type: 'select', label: 'ENGINE CLASS', default: 100, choices: [{ value: 50, label: '50cc' }, { value: 100, label: '100cc' }, { value: 150, label: '150cc' }] },
      { key: 'laps', type: 'select', label: 'LAPS', default: 3, choices: [1, 2, 3, 4, 5].map(n => ({ value: n, label: n + (n === 1 ? ' lap' : ' laps') })) },
      { key: 'cpu', type: 'select', label: 'CPU DIFFICULTY', default: 'normal', choices: [{ value: 'easy', label: 'Easy' }, { value: 'normal', label: 'Normal' }, { value: 'hard', label: 'Hard' }] },
      { key: 'fillAI', type: 'bool', label: 'FILL EMPTY SLOTS WITH CPU', default: true },
    ],
    load: () => import('./kart/index.js'),
  },
  {
    id: 'dodgeball', title: 'Dodgeball 3v3', tagline: 'GYM DODGEBALL · BLUE VS RED · FIRST TO 2',
    minPlayers: 1, maxPlayers: 6,
    teams: [{ id: 'blue', label: 'BLUE', color: 0x3d8bff }, { id: 'red', label: 'RED', color: 0xff4d5a }], teamSize: 3,
    options: [
      { key: 'fillAI', type: 'bool', label: 'FILL EMPTY SLOTS WITH CPU', default: true },
      { key: 'winScore', type: 'select', label: 'FIRST TO', default: 2, choices: [{ value: 2, label: '2 rounds' }, { value: 3, label: '3 rounds' }] },
    ],
    load: () => import('./dodgeball/index.js'),
  },
  {
    id: 'gta', title: 'Fable Theft Auto 5.1', tagline: 'LOS PIXELES · VOXEL CRIME SANDBOX · UP TO 8',
    minPlayers: 1, maxPlayers: 8,
    options: [
      { key: 'minutes', type: 'select', label: 'ROUND', default: 10, choices: [{ value: 5, label: '5 minutes' }, { value: 10, label: '10 minutes' }, { value: 15, label: '15 minutes' }, { value: 0, label: 'Unlimited' }] },
      { key: 'friendlyFire', type: 'bool', label: 'PLAYERS CAN HURT EACH OTHER', default: true },
      { key: 'time', type: 'select', label: 'TIME OF DAY', default: 'morning', choices: [{ value: 'morning', label: 'Morning' }, { value: 'sunset', label: 'Sunset' }, { value: 'night', label: 'Night' }] },
    ],
    load: () => import('./gta/index.js'),
  },
  {
    id: 'crossy', title: 'Crossy Farm Car', tagline: 'HOP THE ROADS · DODGE THE HERDS · LAST CAR STANDING',
    minPlayers: 1, maxPlayers: 8,
    options: [],
    load: () => import('./crossy/index.js'),
  },
  {
    id: 'hog', title: 'Hog the Throne', tagline: 'PIG PARTY · MINIGAMES · ONE THRONE · UP TO 4 HOGS',
    minPlayers: 1, maxPlayers: 4,
    options: [
      { key: 'rounds', type: 'select', label: 'MINIGAMES BEFORE THE THRONE', default: 3, choices: [{ value: 2, label: '2 rounds' }, { value: 3, label: '3 rounds' }, { value: 4, label: '4 rounds' }] },
      { key: 'fillAI', type: 'bool', label: 'FILL EMPTY SLOTS WITH CPU', default: true },
    ],
    load: () => import('./hog/index.js'),
  },
];

/* Message types owned by the lobby protocol. Games must not use these as their own `t` values;
   everything else sent from inside a game is relayed verbatim to the rest of the room. */
export const RESERVED_MESSAGES = new Set(['create', 'join', 'joined', 'lobby', 'opt', 'start', 'end', 'leave', 'left', 'closed', 'error']);

export const gameById = id => GAMES.find(g => g.id === id) || null;
export const defaultOpts = game => Object.fromEntries((game.options || []).map(o => [o.key, o.default]));
export const teamById = (game, id) => (game.teams || []).find(t => t.id === id) || null;

/* Merge `raw` (untrusted, from the host) over `base`, keeping only declared keys with valid values. */
export function cleanOpts(game, raw, base) {
  const out = { ...(base || defaultOpts(game)) };
  if (!raw || typeof raw !== 'object') return out;
  for (const o of game.options || []) {
    if (!(o.key in raw)) continue; const v = raw[o.key];
    if (o.type === 'bool') out[o.key] = !!v;
    else if (o.type === 'number') { const n = Number(v); if (Number.isFinite(n)) out[o.key] = Math.min(o.max ?? Infinity, Math.max(o.min ?? -Infinity, n)); }
    else if (o.type === 'select') { if (o.choices.some(c => c.value === v)) out[o.key] = v; }
  }
  return out;
}
