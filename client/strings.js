/* The shell's words (menu, lobby, the server's error and notice codes), in Chinese (the default) and English. index.html marks
   its static text with data-t="key" (data-tph for a placeholder); app.js calls T(). No DOM here: tests check the two tables. */
const en = {
  subtitle: 'PICK A GAME · CREATE A ROOM · FRIENDS JOIN WITH THE CODE · TYPE A CODE FIRST TO PICK YOUR OWN',
  player: 'PLAYER', namePh: 'Your name', game: 'GAME', soloOpts: 'SOLO OPTIONS', create: 'CREATE ROOM', codePh: 'CODE', join: 'JOIN ROOM', solo: 'PLAY SOLO',
  roomCode: 'ROOM CODE', scan: 'SCAN WITH A PHONE TO JOIN', friendTeam: "JOIN HOST'S TEAM", enemyTeam: 'JOIN OTHER TEAM',
  ready: 'READY', notReady: 'NOT READY', readyTag: 'READY', waitTag: 'NOT READY', start: 'START GAME', leave: 'LEAVE', host: 'HOST', you: ' (you)', nobody: 'NOBODY YET', langBtn: '中文',
  players: '{n} players', soloOk: ' · solo ok', lobbyGame: '{title} · {n}/{max} PLAYERS',
  roomAddr: 'friends on this network open <b>{addr}</b> and enter the code',
  sideLocked: 'Press NOT READY to switch sides', sideFull: '{team} is full', sideJoin: 'Join {team}',
  needPlayersLobby: '{title} needs at least {n} players.', aloneOk: 'Waiting for players to join… you can also start alone.', sideEmpty: '{team} has no players yet. ',
  allReady: 'Everyone is ready. Start when you like!', waitReady: 'Waiting for everyone to press READY…', waitHost: 'Waiting for the host to start…',
  pickSide: 'Pick your side, then press READY.', pressReady: 'Press READY when you are set.', rematchVotes: '{n} of {m} want a rematch',
  loadFail: 'Could not load {title}: {err}', loading: 'Loading…', connecting: 'Connecting…', unreachable: 'Could not reach the server', lost: 'Lost the connection to the server',
  closed: 'The room was closed', badCodeLocal: 'Room codes use 4 letters and digits, never I, O, 0 or 1', enterCode: 'Enter the 4-letter room code',
  codeFromLink: 'Room code filled in from the link. Press JOIN ROOM.', codeStripped: 'Room codes never use I, O, 0 or 1',
  defaultName: 'Player',
  // the server's codes (server/rooms.js)
  'err.unknownGame': 'Unknown game', 'err.badCode': 'Room codes use 4 letters and digits, never I, O, 0 or 1', 'err.roomExists': 'Room {code} already exists - press JOIN ROOM or pick another code',
  'err.noRoom': 'Room {code} not found', 'err.running': 'That game is already running - wait for it to finish', 'err.full': 'Room is full', 'err.teamFull': '{team} is full',
  'err.needPlayers': 'Needs at least {n} players', 'notice.newHost': 'The host left. {name} is the host now.',
};

const zh = {
  subtitle: '选个游戏 · 开个房间 · 朋友输入房间号加入 · 先填房间号就能自己定号',
  player: '玩家', namePh: '你的名字', game: '游戏', soloOpts: '单人选项', create: '创建房间', codePh: '房间号', join: '加入房间', solo: '单人游戏',
  roomCode: '房间号', scan: '用手机扫码加入', friendTeam: '加入房主的队', enemyTeam: '加入另一队',
  ready: '准备', notReady: '取消准备', readyTag: '已准备', waitTag: '未准备', start: '开始游戏', leave: '离开', host: '房主', you: '(你)', nobody: '还没有人', langBtn: 'EN',
  players: '{n} 人', soloOk: ' · 可单人', lobbyGame: '{title} · {n}/{max} 人',
  roomAddr: '同一网络的朋友打开 <b>{addr}</b>,输入房间号',
  sideLocked: '先取消准备才能换边', sideFull: '{team}满了', sideJoin: '加入{team}',
  needPlayersLobby: '{title}至少要 {n} 人。', aloneOk: '等人加入中……也可以自己先开。', sideEmpty: '{team}还没有人。',
  allReady: '大家都准备好了,随时开始!', waitReady: '等大家按准备……', waitHost: '等房主开始……',
  pickSide: '选好一边,再按准备。', pressReady: '好了就按准备。', rematchVotes: '{m} 人里有 {n} 人想再来一局',
  loadFail: '{title}加载失败:{err}', loading: '加载中……', connecting: '连接中……', unreachable: '连不上服务器', lost: '和服务器断开了',
  closed: '房间已关闭', badCodeLocal: '房间号是 4 位字母或数字,没有 I、O、0、1', enterCode: '请输入 4 位房间号',
  codeFromLink: '已从链接填好房间号,按加入房间。', codeStripped: '房间号里没有 I、O、0、1',
  defaultName: '玩家',
  'err.unknownGame': '未知的游戏', 'err.badCode': '房间号是 4 位字母或数字,没有 I、O、0、1', 'err.roomExists': '房间 {code} 已经存在:按加入房间,或换一个房间号',
  'err.noRoom': '找不到房间 {code}', 'err.running': '这局已经开始了,等它结束再加入', 'err.full': '房间满了', 'err.teamFull': '{team}满了',
  'err.needPlayers': '至少要 {n} 人', 'notice.newHost': '房主离开了,现在由 {name} 当房主。',
};

export const STR = { zh, en };
