/* Dodgeball 3v3 - every word the game shows, in Chinese (the default) and English. The host's events carry codes and numbers,
   each screen turns them into words here in its own language. `{n}` in a string is filled from the vars. No DOM: the two tables
   are checked against each other in node (test/strings.test.mjs). Player and CPU names are names, not words, and stay as they are. */
const en = {
  // teams
  'team.blue': 'BLUE', 'team.red': 'RED', 'floor.blue': 'BLUE', 'floor.red': 'RED', 'bench.blue': 'BLUE BENCH', 'bench.red': 'RED BENCH',
  // banners and floating words
  round: 'ROUND {n}', roundSub1: 'first to {n} · balls on the line · GO on the whistle', roundSubN: '{a}–{b} · balls back on the line', go: 'GO!',
  out: 'OUT!', gotYou: '{name} got you', niceShot: 'nice shot!', outOfPlay: 'OUT OF PLAY', lineIn: 'CENTER LINE DROPS IN {n}…',
  lineDown: 'THE LINE IS DOWN', lineDownSub: 'either team can cross now', time: 'TIME!',
  sudden: 'SUDDEN DEATH', suddenSub: 'every ball back on the line · the clock stops at {t}',
  matchWin: '{team} WINS THE MATCH', roundWin: '{team} takes the round!', score: '{a} – {b}', scoreTo: '{a} – {b}  ·  first to {n}', scoreWhy: '{a} – {b}  ·  {why}',
  'why.left': 'more players left', 'why.hits': 'more hits this round', 'why.coin': 'dead level · a coin flip decided it',
  // status bar
  stMatch: '{team} wins the match {sc}', hAgainTouch: 'play again or leave from the ☰ menu', hAgainKeys: 'R to play again · Esc to leave',
  hGuestTouch: 'vote for a rematch or leave from the ☰ menu', hGuestKeys: 'R votes for a rematch · or leave from the card', hWaitHost: 'waiting for the host to play again',
  stRound: '{team} takes the round', stRoundOver: 'Round over', hNext: '{sc} · next round in a moment',
  stIntro: 'Round {n} — get ready…', hIntro: 'you are on {team} · {tip}', tipTouch: 'drag the left side to move · rush a ball at the whistle', tipKeys: 'rush a ball on the line at the whistle',
  spectating: 'spectating', stSpectating: 'SPECTATING', stOut: 'OUT!', hOut: 'watching the round finish', stGrab: 'GRAB A BALL', hGrab: 'run over a loose ball to pick it up',
  stArming: 'ARMING…', stReady: 'THROW READY', hReadyTouch: 'THROW takes the nearest enemy · drag it to aim', hReadyKeys: 'Space throws at the nearest enemy',
  // header
  sub: 'Round {n} · {clock} · {b} balls', subDown: 'LINE DOWN', subDrop: 'LINE DROPS IN {n}', subSudden: 'SUDDEN DEATH', vs: 'v',
  // footer and touch controls
  kMove: 'move', kSprint: 'sprint', kThrow: 'throw at nearest enemy', kSound: 'sound', kRestart: 'restart', kMenu: 'menu', kAgain: 'again', kLobby: 'lobby', kRematch: 'rematch',
  sndOn: '🔊 sound on', sndOff: '🔇 sound off', roleSolo: 'solo', roleHost: 'hosting', rolePlayers: '{n} players',
  drag: 'DRAG HERE TO MOVE', tSprint: 'SPRINT', tThrow: 'THROW', rotate: 'ROTATE YOUR DEVICE', rotateSub: 'DODGEBALL PLAYS IN LANDSCAPE',
  // menu card
  menu: 'MENU', resume: 'RESUME', soundOn: 'SOUND: ON', soundOff: 'SOUND: OFF', lang: 'LANGUAGE: EN', restart: 'RESTART', playAgain: 'PLAY AGAIN', quit: 'QUIT TO MENU', toLobby: 'BACK TO LOBBY',
  leaveRoom: 'LEAVE ROOM', rematch: 'REMATCH?', rematchOn: 'REMATCH ✓',
  // result card
  resWin: '{team} WINS', mvp: 'MVP · {name} · {n} hits', thHits: 'HITS', thOuts: 'OUTS', resMenu: 'MENU', votes: '{n} want a rematch', waitHost: 'Waiting for the host…',
};

const zh = {
  'team.blue': '蓝队', 'team.red': '红队', 'floor.blue': '蓝', 'floor.red': '红', 'bench.blue': '蓝队替补席', 'bench.red': '红队替补席',
  round: '第 {n} 局', roundSub1: '先赢 {n} 局 · 球在中线上 · 哨响开抢', roundSubN: '{a}–{b} · 球回到中线', go: '开抢!',
  out: '出局!', gotYou: '被 {name} 砸中了', niceShot: '好球!', outOfPlay: '球出场了', lineIn: '中线 {n} 秒后撤掉…',
  lineDown: '中线撤了', lineDownSub: '两边都能过线了', time: '时间到!',
  sudden: '决胜时刻', suddenSub: '所有球回到中线 · {t} 结束',
  matchWin: '{team}赢下比赛', roundWin: '{team}拿下这局!', score: '{a} – {b}', scoreTo: '{a} – {b}  ·  先赢 {n} 局', scoreWhy: '{a} – {b}  ·  {why}',
  'why.left': '场上剩的人多', 'why.hits': '这局砸中的多', 'why.coin': '完全打平 · 抛硬币定的',
  stMatch: '{team}赢下比赛 {sc}', hAgainTouch: '从 ☰ 菜单再来一场或离开', hAgainKeys: 'R 再来一场 · Esc 离开',
  hGuestTouch: '从 ☰ 菜单投票再来或离开', hGuestKeys: 'R 投票再来一场 · 或在结果卡上离开', hWaitHost: '等房主再开一场',
  stRound: '{team}拿下这局', stRoundOver: '本局结束', hNext: '{sc} · 下一局马上开始',
  stIntro: '第 {n} 局 — 准备…', hIntro: '你在{team} · {tip}', tipTouch: '拖左半边移动 · 哨响去抢球', tipKeys: '哨响冲去中线抢球',
  spectating: '观战中', stSpectating: '观战中', stOut: '出局!', hOut: '等这局打完', stGrab: '去捡球', hGrab: '跑到散落的球上就能捡起',
  stArming: '蓄力中…', stReady: '可以扔了', hReadyTouch: '投掷键自动瞄最近的对手 · 拖动可手动瞄准', hReadyKeys: '空格砸向最近的对手',
  sub: '第 {n} 局 · {clock} · {b} 个球', subDown: '中线已撤', subDrop: '中线 {n} 秒后撤', subSudden: '决胜时刻', vs: '对',
  kMove: '移动', kSprint: '冲刺', kThrow: '砸最近的对手', kSound: '声音', kRestart: '重来', kMenu: '菜单', kAgain: '再来', kLobby: '大厅', kRematch: '想再来',
  sndOn: '🔊 声音开', sndOff: '🔇 声音关', roleSolo: '单人', roleHost: '房主', rolePlayers: '{n} 名玩家',
  drag: '在这里拖动移动', tSprint: '冲刺', tThrow: '投掷', rotate: '请把设备横过来', rotateSub: '躲避球要横屏玩',
  menu: '菜单', resume: '继续', soundOn: '声音:开', soundOff: '声音:关', lang: '语言:中文', restart: '重来', playAgain: '再来一场', quit: '退出到菜单', toLobby: '回大厅',
  leaveRoom: '离开房间', rematch: '再来一场?', rematchOn: '想再来 ✓',
  resWin: '{team}获胜', mvp: 'MVP · {name} · 砸中 {n} 次', thHits: '砸中', thOuts: '出局', resMenu: '菜单', votes: '{n} 人想再来一局', waitHost: '等房主操作…',
};

export const STR = { zh, en };
