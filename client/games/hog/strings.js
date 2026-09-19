/* Hog the Throne - every word the game shows, in Chinese (the default) and English. The wire carries keys (toasts are
   ['toast', key, pig index, n], see net.js toastText), each screen words them in its own language. `{name}` / `{n}` are filled
   from the vars; player names are never translated. No DOM: the two tables are checked against each other in node. */
const en = {
  // the minigames: a name and a one-line rule for the round card and the HUD
  'mode.spin': 'WHIRLY BACON', 'mode.spin.sub': 'Hop the spinning bar. Last pig standing wins.',
  'mode.balloon': 'BALLOON BUTT', 'mode.balloon.sub': 'Butt-dash pigs to pop their balloons. Keep yours.',
  'mode.crumble': 'CRUMBLE CAKE', 'mode.crumble.sub': 'The floor is cake. Cake falls. Do not.',
  'mode.truffle': 'TRUFFLE RUSH', 'mode.truffle.sub': 'Snort up the most truffles. Butt-dash to make pigs drop theirs.',
  'mode.throne': 'THE THRONE', 'mode.throne.sub': 'King of the hill. Sit longest. Shove the rest off.',
  // HUD and round cards
  round: 'ROUND {n}', finale: 'FINALE', roundLine: 'ROUND {n} · {name}', finaleLine: 'FINALE · {name}', getReady: 'GET READY', waitHost: 'waiting for the host…',
  'card.winner': 'WINNER', 'card.bonus': '+3s throne bonus · 2nd +2s · 3rd +1s', 'card.wins': '{name} wins!',
  'card.headStart': 'YOU START WITH +{n}s ON THE THRONE', 'card.headZero': 'NO HEAD START · GO TAKE IT',
  go: 'GO!',
  'chip.you': '(you)', 'chip.bank': '+{n}s', 'stat.out': 'OUT', 'stat.sec': '{n}s',
  // toasts
  'toast.out': '{name} OUT!', 'toast.reverse': 'REVERSE!', 'toast.popped': '{name} POPPED!', 'toast.balloon': '{name} -1 🎈', 'toast.drops': '{name} DROPS {n}!',
  'toast.king': '{name} TAKES THE THRONE!', 'toast.contested': 'CONTESTED!', 'toast.muted': 'MUTED', 'toast.sound': 'SOUND ON',
  // the title card
  'title.kick': 'THE HOG WHO SAT LONGEST', 'title.name': 'HOG THE THRONE', 'title.hogged': '{name} HOGGED IT', 'title.cpu': '(CPU)', 'title.secs': '{n}s on the throne',
  // buttons, the ☰ menu and the result footer
  'btn.again': 'PLAY AGAIN', 'btn.menu': 'MENU', 'btn.lobby': 'BACK TO LOBBY', 'btn.leave': 'LEAVE ROOM', 'btn.rematch': 'REMATCH?', 'btn.rematchOn': 'REMATCH ✓',
  'btn.restart': 'RESTART', 'btn.quit': 'QUIT TO MENU', 'btn.resume': 'RESUME', 'btn.soundOn': 'SOUND: ON', 'btn.soundOff': 'SOUND: OFF', 'btn.lang': 'LANGUAGE: ENGLISH',
  'foot.wait': 'WAITING FOR THE HOST TO PLAY AGAIN OR RETURN TO THE LOBBY…', 'foot.voted': 'THE HOST CAN SEE YOU WANT A REMATCH',
  rematch1: '1 PLAYER WANTS A REMATCH', rematchN: '{n} PLAYERS WANT A REMATCH', 'menu.title': 'MENU',
  'snd.on': '🔊 sound on', 'snd.off': '🔇 sound off',
  // the keyboard footer
  'k.move': 'move', 'k.hop': 'hop', 'k.dash': 'butt-dash', 'k.sound': 'sound', 'k.restart': 'restart', 'k.menu': 'menu', 'k.again': 'again', 'k.lobby': 'lobby',
  // touch controls and the rotate prompt
  pad: 'DRAG HERE TO MOVE', hop: 'HOP', dash: 'DASH', rotate: 'ROTATE YOUR DEVICE', rotateSub: 'HOG THE THRONE PLAYS IN LANDSCAPE',
};

const zh = {
  'mode.spin': '旋转培根', 'mode.spin.sub': '跳过旋转的横杆,站到最后的猪赢!',
  'mode.balloon': '屁屁气球', 'mode.balloon.sub': '用屁股撞爆别人的气球,护好自己的!',
  'mode.crumble': '崩塌蛋糕', 'mode.crumble.sub': '地板是蛋糕,蛋糕会塌。你可别掉下去!',
  'mode.truffle': '松露狂拱', 'mode.truffle.sub': '拱到最多的松露!屁股冲撞能撞掉别人的松露。',
  'mode.throne': '王座', 'mode.throne.sub': '抢山头!坐得最久的赢,把其他猪统统撞下去!',
  round: '第 {n} 轮', finale: '决赛', roundLine: '第 {n} 轮 · {name}', finaleLine: '决赛 · {name}', getReady: '准备', waitHost: '等待房主开局…',
  'card.winner': '本轮胜者', 'card.bonus': '王座奖励:第一 +3 秒 · 第二 +2 秒 · 第三 +1 秒', 'card.wins': '{name} 赢了!',
  'card.headStart': '你开局就在王座上领先 +{n} 秒', 'card.headZero': '没有领先时间 · 冲上去抢!',
  go: '开冲!',
  'chip.you': '(你)', 'chip.bank': '+{n}秒', 'stat.out': '出局', 'stat.sec': '{n}秒',
  'toast.out': '{name} 出局!', 'toast.reverse': '反转!', 'toast.popped': '{name} 气球全爆!', 'toast.balloon': '{name} -1 🎈', 'toast.drops': '{name} 掉了 {n} 颗!',
  'toast.king': '{name} 登上王座!', 'toast.contested': '王座争夺中!', 'toast.muted': '已静音', 'toast.sound': '声音已开',
  'title.kick': '坐得最久的猪才是王', 'title.name': '猪抢王座', 'title.hogged': '{name} 霸占了王座', 'title.cpu': '(电脑)', 'title.secs': '在王座上坐了 {n} 秒',
  'btn.again': '再来一局', 'btn.menu': '主菜单', 'btn.lobby': '回到大厅', 'btn.leave': '离开房间', 'btn.rematch': '想再来一局?', 'btn.rematchOn': '想再来一局 ✓',
  'btn.restart': '重新开始', 'btn.quit': '退出到主菜单', 'btn.resume': '继续', 'btn.soundOn': '声音:开', 'btn.soundOff': '声音:关', 'btn.lang': '语言:中文',
  'foot.wait': '等房主再开一局或回到大厅…', 'foot.voted': '房主能看到你想再来一局',
  rematch1: '1 位玩家想再来一局', rematchN: '{n} 位玩家想再来一局', 'menu.title': '菜单',
  'snd.on': '🔊 声音开', 'snd.off': '🔇 声音关',
  'k.move': '移动', 'k.hop': '跳', 'k.dash': '屁股冲撞', 'k.sound': '声音', 'k.restart': '重来', 'k.menu': '菜单', 'k.again': '再来', 'k.lobby': '大厅',
  pad: '按住这里拖动来移动', hop: '跳', dash: '冲撞', rotate: '请把设备横过来', rotateSub: '猪抢王座需要横屏玩',
};

export const STR = { zh, en };
