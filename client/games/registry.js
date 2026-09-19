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
   keeps a `team` per player (auto-balanced on join, switchable in the lobby) and it arrives in `session.players`.

   Every word here (title, tagline, labels) is a `{ zh, en }` pair, written `L(zh, en)` and read in the viewer's language with
   core/i18n.js's pick(). The server only reads ids and values. */
const L = (zh, en) => ({ zh, en });
const SKILL = [{ value: 'easy', label: L('简单', 'Easy') }, { value: 'normal', label: L('普通', 'Normal') }, { value: 'hard', label: L('困难', 'Hard') }];
const FILL_AI = L('空位由电脑补上', 'FILL EMPTY SLOTS WITH CPU');
export const GAMES = [
  {
    id: 'kart', title: L('霜线卡丁车', 'Frostline Kart'), tagline: L('雪地赛道 · 道具 · 大奖赛 · 最多 8 辆车', 'SNOWY CIRCUIT · ITEMS · GRAND PRIX · UP TO 8 KARTS'),
    minPlayers: 1, maxPlayers: 8,
    options: [
      { key: 'mode', type: 'select', label: L('模式', 'MODE'), default: 'single', choices: [{ value: 'single', label: L('单场比赛', 'Single race') }, { value: 'cup', label: L('大奖赛(4 场)', 'Grand Prix (4 races)') }] },
      { key: 'cc', type: 'select', label: L('排量', 'ENGINE CLASS'), default: 100, choices: [{ value: 50, label: L('50cc', '50cc') }, { value: 100, label: L('100cc', '100cc') }, { value: 150, label: L('150cc', '150cc') }] },
      { key: 'laps', type: 'select', label: L('圈数', 'LAPS'), default: 3, choices: [1, 2, 3, 4, 5].map(n => ({ value: n, label: L(n + ' 圈', n + (n === 1 ? ' lap' : ' laps')) })) },
      { key: 'cpu', type: 'select', label: L('电脑难度', 'CPU DIFFICULTY'), default: 'normal', choices: SKILL },
      { key: 'fillAI', type: 'bool', label: FILL_AI, default: true },
    ],
    load: () => import('./kart/index.js'),
  },
  {
    id: 'dodgeball', title: L('躲避球 3v3', 'Dodgeball 3v3'), tagline: L('体育馆躲避球 · 蓝队对红队 · 先赢 2 局', 'GYM DODGEBALL · BLUE VS RED · FIRST TO 2'),
    minPlayers: 1, maxPlayers: 6,
    teams: [{ id: 'blue', label: L('蓝队', 'BLUE'), color: 0x3d8bff }, { id: 'red', label: L('红队', 'RED'), color: 0xff4d5a }], teamSize: 3,
    options: [
      { key: 'fillAI', type: 'bool', label: FILL_AI, default: true },
      { key: 'winScore', type: 'select', label: L('先赢', 'FIRST TO'), default: 2, choices: [{ value: 2, label: L('2 局', '2 rounds') }, { value: 3, label: L('3 局', '3 rounds') }] },
    ],
    load: () => import('./dodgeball/index.js'),
  },
  {
    id: 'gta', title: L('寓言盗车手 5.1', 'Fable Theft Auto 5.1'), tagline: L('像素圣城 · 体素犯罪沙盒 · 最多 8 人', 'LOS PIXELES · VOXEL CRIME SANDBOX · UP TO 8'),
    minPlayers: 1, maxPlayers: 8,
    options: [
      { key: 'mode', type: 'select', label: L('模式', 'MODE'), default: 'sandbox', choices: [{ value: 'sandbox', label: L('沙盒 · 钱最多者胜', 'Sandbox · most cash wins') }, { value: 'mostWanted', label: L('头号通缉 · 背上标记,追杀标记', 'Most Wanted · carry the mark, hunt the mark') }, { value: 'race', label: L('街头赛车 · 3 圈,不择手段', 'Street Race · 3 laps, anything goes') }, { value: 'deathmatch', label: L('死斗 · 先杀够 N 人,不涨通缉', 'Deathmatch · first to N kills, no stars for it') }] },
      { key: 'killCap', type: 'select', label: L('获胜击杀数(死斗)', 'KILLS TO WIN (DEATHMATCH)'), default: 20, choices: [{ value: 10, label: L('10 杀', '10 kills') }, { value: 20, label: L('20 杀', '20 kills') }, { value: 30, label: L('30 杀', '30 kills') }] },
      { key: 'fillAI', type: 'bool', label: L('死斗由电脑补到 4 人', 'CPU PLAYERS FILL THE DEATHMATCH TO 4'), default: true },
      { key: 'botSkill', type: 'select', label: L('电脑水平(死斗)', 'CPU SKILL (DEATHMATCH)'), default: 'normal', choices: SKILL },
      { key: 'minutes', type: 'select', label: L('每局时长', 'ROUND'), default: 10, choices: [{ value: 5, label: L('5 分钟', '5 minutes') }, { value: 10, label: L('10 分钟', '10 minutes') }, { value: 15, label: L('15 分钟', '15 minutes') }, { value: 0, label: L('不限时', 'Unlimited') }] },
      { key: 'friendlyFire', type: 'bool', label: L('玩家之间可以互相伤害', 'PLAYERS CAN HURT EACH OTHER'), default: true },
      { key: 'guns', type: 'bool', label: L('枪械(关掉后只会死于车祸和警察)', 'GUNS (OFF: CARS AND THE COPS ARE THE ONLY WAYS TO DIE)'), default: true },
      { key: 'loadout', type: 'select', label: L('初始武器', 'STARTING GUNS'), default: 'basic', choices: [{ value: 'pistol', label: L('只有手枪', 'Pistol only') }, { value: 'basic', label: L('手枪、霰弹枪、冲锋枪', 'Pistol, shotgun, SMG') }, { value: 'all', label: L('全套,连火箭筒', 'Everything, rockets included') }] },
      { key: 'traffic', type: 'select', label: L('车流', 'TRAFFIC'), default: 'normal', choices: [{ value: 'light', label: L('稀少', 'Light') }, { value: 'normal', label: L('普通', 'Normal') }, { value: 'heavy', label: L('拥堵', 'Heavy') }] },
      { key: 'cops', type: 'select', label: L('警察', 'POLICE'), default: 'normal', choices: [{ value: 'soft', label: L('温和', 'Soft') }, { value: 'normal', label: L('普通', 'Normal') }, { value: 'hard', label: L('凶狠', 'Hard') }] },
      { key: 'laps', type: 'select', label: L('赛车圈数', 'RACE LAPS'), default: 3, choices: [{ value: 1, label: L('1 圈', '1 lap') }, { value: 2, label: L('2 圈', '2 laps') }, { value: 3, label: L('3 圈', '3 laps') }, { value: 5, label: L('5 圈', '5 laps') }] },
      { key: 'time', type: 'select', label: L('时段', 'TIME OF DAY'), default: 'morning', choices: [{ value: 'morning', label: L('清晨', 'Morning') }, { value: 'sunset', label: L('黄昏', 'Sunset') }, { value: 'night', label: L('夜晚', 'Night') }] },
    ],
    load: () => import('./gta/index.js'),
  },
  {
    id: 'crossy', title: L('农场过马路', 'Crossy Farm Car'), tagline: L('跳过马路 · 躲开牛群 · 活到最后', 'HOP THE ROADS · DODGE THE HERDS · LAST CAR STANDING'),
    minPlayers: 1, maxPlayers: 8,
    options: [],
    load: () => import('./crossy/index.js'),
  },
  {
    id: 'hog', title: L('猪抢王座', 'Hog the Throne'), tagline: L('小猪派对 · 小游戏 · 一个王座 · 最多 4 头猪', 'PIG PARTY · MINIGAMES · ONE THRONE · UP TO 4 HOGS'),
    minPlayers: 1, maxPlayers: 4,
    options: [
      { key: 'rounds', type: 'select', label: L('抢王座前的小游戏', 'MINIGAMES BEFORE THE THRONE'), default: 3, choices: [{ value: 2, label: L('2 轮', '2 rounds') }, { value: 3, label: L('3 轮', '3 rounds') }, { value: 4, label: L('4 轮', '4 rounds') }] },
      { key: 'fillAI', type: 'bool', label: FILL_AI, default: true },
    ],
    load: () => import('./hog/index.js'),
  },
  {
    id: 'showdown', title: L('日落大乱斗', 'Sundown Showdown'), tagline: L('沙漠乱斗 · 4 位英雄 · 能量块 · 毒圈 · 活到最后 · 最多 8 人', 'DESERT BRAWL · 4 BRAWLERS · POWER CUBES · POISON GAS · LAST ONE STANDING · UP TO 8'),
    minPlayers: 1, maxPlayers: 8,
    options: [
      { key: 'fillAI', type: 'bool', label: L('电脑补满到 10 人', 'CPU BRAWLERS FILL THE SHOWDOWN TO 10'), default: true },
      { key: 'botSkill', type: 'select', label: L('电脑水平', 'CPU SKILL'), default: 'normal', choices: SKILL },
    ],
    load: () => import('./showdown/index.js'),
  },
  {
    id: 'dice', title: L('灌铅骰子', 'Loaded Dice'), tagline: L('一个按钮的骰子对决 · 1 对 1,或单人闯关', 'A ONE-BUTTON DICE DUEL · 1 ON 1, OR A SOLO RUN'),
    minPlayers: 1, maxPlayers: 2,
    options: [
      { key: 'wins', type: 'select', label: L('先赢几局(对战)', 'FIRST TO (DUEL)'), default: 2, choices: [{ value: 1, label: L('1 局', '1 duel') }, { value: 2, label: L('2 局', '2 duels') }, { value: 3, label: L('3 局', '3 duels') }] },
      { key: 'hearts', type: 'select', label: L('红心(对战)', 'HEARTS (DUEL)'), default: 5, choices: [{ value: 3, label: L('3 颗心', '3 hearts') }, { value: 5, label: L('5 颗心', '5 hearts') }, { value: 7, label: L('7 颗心', '7 hearts') }] },
      { key: 'spice', type: 'select', label: L('花样', 'SPICE'), default: 'std', choices: [{ value: 'classic', label: L('经典:只有基本格子', 'Classic: the basic slots only') }, { value: 'std', label: L('标准:新花样一局局加进来', 'Standard: new tricks join round by round') }, { value: 'wild', label: L('疯狂:一上来全都有', 'Wild: everything from the start') }] },
      { key: 'dice', type: 'select', label: L('骰子(对战)', 'DICE (DUEL)'), default: 'grow', choices: [{ value: 'grow', label: L('D4 起,每 3 回合变大', 'D4, bigger every 3 rounds') }, { value: 'd6', label: L('D6', 'D6') }, { value: 'd12', label: L('D12', 'D12') }, { value: 'd20', label: L('D20', 'D20') }] },
    ],
    load: () => import('./dice/index.js'),
  },
];

/* Message types owned by the lobby protocol. Games must not use these as their own `t` values;
   everything else sent from inside a game is relayed verbatim to the rest of the room. */
export const RESERVED_MESSAGES = new Set(['create', 'join', 'joined', 'lobby', 'opt', 'start', 'end', 'leave', 'left', 'closed', 'error', 'notice', 'rematch']);

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
