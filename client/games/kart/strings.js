/* Frostline Kart - every word the game shows, in Chinese (the default) and English. `{n}` in a string is filled from the vars.
   A key missing from a table falls back to English, then to the key itself. No DOM: test/strings.test.mjs checks the two tables
   against each other in node. Player and CPU names are names and stay as they are. */
const en = {
  // HUD
  lap: 'LAP <b>{n}</b>/{of}', wrongWay: '⟲ WRONG WAY', netwait: 'WAITING FOR THE HOST…', boost: 'BOOST', kmh: 'km/h', cpu: 'CPU',
  padLbl: '◀ DRAG TO STEER ▶', brake: 'BRAKE', item: 'ITEM', look: 'LOOK', menu: 'MENU',
  rotate: 'ROTATE YOUR DEVICE', rotateSub: 'FROSTLINE KART PLAYS IN LANDSCAPE',
  'kc.speed': 'SPEED', 'kc.accel': 'ACCEL', 'kc.handling': 'HANDLING', 'w.light': 'LIGHT', 'w.medium': 'MEDIUM', 'w.heavy': 'HEAVY',
  'track.0': 'FROSTLINE', 'track.1': 'FROSTLINE REVERSE', 'track.2': 'FROSTLINE MIRROR', 'track.3': 'FROSTLINE MIRROR REVERSE',
  cupline: 'RACE {n}/{of} · {track}', raceOf: 'RACE {n} OF {of}',
  'hint.touch': '☰  MENU · HOW TO PLAY', 'hint.keys': 'ARROWS / WASD · SPACE item (↓ throws back) · C look back · {r}ESC menu · M sound · L detail',
  'hint.solo': 'R restart · ', 'hint.host': 'R again · ', 'hint.guest': 'R rematch · ',
  // the countdown and the rocket start
  go: 'GO!', rocket: 'ROCKET START!', boostReady: 'BOOST READY', tooEarly: 'TOO EARLY · LIFT AND HOLD AGAIN', holdTouch: 'HOLD ANYWHERE TO BOOST', holdKey: 'HOLD ↑ TO BOOST',
  // toasts
  finalLap: 'FINAL LAP!', lapToast: 'LAP {n}  ·  {t}', finish: 'FINISH!', finishFirst: 'FINISH THE RACE FIRST',
  inked: 'INKED!', blocked: 'BLOCKED!', niceShot: 'NICE SHOT!', coins2: '+2 COINS', starPower: '★ STAR POWER!', zap: '⚡ LIGHTNING!', got: '{item}!',
  'hit.lightning': 'ZAPPED!', 'hit.banana': 'SLIPPED!', 'hit.star': 'BOWLED OVER!', 'hit.bullet': 'RUN DOWN!', 'hit.blue': 'BLUE SHELLED!', 'hit.bomb': 'KABOOM!', 'hit.fire': 'BURNED!', 'hit.shell': 'HIT!',
  soundOnToast: 'SOUND ON', soundOffToast: 'SOUND OFF', detailToast: '{q} DETAIL', lowFps: 'LOW FRAME RATE · {q} DETAIL', votes1: '1 PLAYER WANTS A REMATCH', votesN: '{n} PLAYERS WANT A REMATCH',
  // incoming threats
  warnRed: 'RED SHELL BEHIND!', warnBlue: 'BLUE SHELL OUT!', warnBlueMe: 'BLUE SHELL · COMING FOR YOU!',
  // items
  'item.mushroom': 'MUSHROOM', 'item.green': 'GREEN SHELL', 'item.red': 'RED SHELL', 'item.banana': 'BANANA', 'item.tgreen': 'TRIPLE GREEN SHELLS', 'item.tred': 'TRIPLE RED SHELLS',
  'item.tbanana': 'TRIPLE BANANAS', 'item.star': 'STAR', 'item.lightning': 'LIGHTNING', 'item.coin': 'COIN', 'item.blue': 'BLUE SHELL', 'item.bomb': 'BOB-OMB', 'item.blooper': 'BLOOPER',
  'item.bullet': 'BULLET BILL', 'item.golden': 'GOLDEN MUSHROOM', 'item.fire': 'FIRE FLOWER',
  // the finish banner and the results
  finBanner: 'FINISHED {place} · {time}', watching: 'WATCHING {name}', skipKeys: 'SPACE · RESULTS', skipTap: 'TAP · RESULTS',
  youFinished: 'YOU FINISHED {place} · {time}', bestLap: ' · BEST LAP {t}', laps: 'LAPS  {list}', racing: 'racing…',
  grandPrix: '🏆 GRAND PRIX', finalStandings: 'FINAL STANDINGS', cupStandings: 'CUP STANDINGS', cupAfter: 'CUP STANDINGS · AFTER RACE {n} OF {of}',
  nextRaceIn: 'NEXT RACE IN {n}', newRaceIn: 'NEW RACE IN {n}', waitHostRacing: 'THE HOST IS STILL RACING…', waitCup: 'THE NEXT RACE STARTS WHEN EVERYONE HAS FINISHED…', waitHost: 'WAITING FOR THE HOST TO RESTART OR RETURN TO THE LOBBY…',
  newCup: 'NEW CUP', nextRace: 'NEXT RACE', raceAgain: 'RACE AGAIN', restart: 'RESTART', quit: 'QUIT TO MENU', toLobby: 'BACK TO LOBBY', leave: 'LEAVE ROOM', rematch: 'REMATCH?', rematchOn: '✓ REMATCH ASKED',
  // the menu
  resume: 'RESUME', soundOn: 'SOUND: ON', soundOff: 'SOUND: OFF', detail: 'DETAIL: {q}', 'q.auto': 'AUTO', 'q.0': 'HIGH', 'q.1': 'MEDIUM', 'q.2': 'LOW',
  steering: 'STEERING: {s}', 'steer.0': 'LOW', 'steer.1': 'NORMAL', 'steer.2': 'HIGH', statsOn: 'STATS: ON', statsOff: 'STATS: OFF', lang: 'LANGUAGE: EN',
  // the how-to-play card
  howto: 'HOW TO PLAY', gotIt: 'GOT IT',
  'ht.steer': 'STEER', 'ht.brake': 'BRAKE', 'ht.item': 'ITEM', 'ht.rocket': 'ROCKET START', 'ht.drive': 'DRIVE', 'ht.look': 'LOOK BACK', 'ht.menu': 'MENU',
  'hd.steer': 'Drag the left half of the screen. The gas is automatic.', 'hd.brake': 'The BRAKE button. Held, it also flips a throw.',
  'hd.item': 'Touch to carry, lift to throw, drag down to throw back.', 'hd.rocket': 'Hold anywhere while the 1 shows, through GO.', 'hd.lookTouch': 'Hold the LOOK button.',
  'hk.drive': '↑ / W gas, ↓ / S brake, ← → / A D steer.', 'hk.item': 'Hold SPACE to carry, release to throw; hold ↓ to throw back.',
  'hk.rocket': 'Hold ↑ while the 1 shows, through GO.', 'hk.look': 'Hold C.', 'hk.menu': 'ESC: sound, detail, restart, leave.',
};

const zh = {
  lap: '第 <b>{n}</b>/{of} 圈', wrongWay: '⟲ 跑反了', netwait: '等待房主…', boost: '加速', kmh: 'km/h', cpu: '电脑',
  padLbl: '◀ 拖动转向 ▶', brake: '刹车', item: '道具', look: '回看', menu: '菜单',
  rotate: '请把设备横过来', rotateSub: '霜线卡丁车要横屏玩',
  'kc.speed': '极速', 'kc.accel': '加速', 'kc.handling': '操控', 'w.light': '轻型', 'w.medium': '中型', 'w.heavy': '重型',
  'track.0': '霜线赛道', 'track.1': '霜线赛道 · 反向', 'track.2': '霜线赛道 · 镜像', 'track.3': '霜线赛道 · 镜像反向',
  cupline: '第 {n}/{of} 场 · {track}', raceOf: '第 {n} 场 · 共 {of} 场',
  'hint.touch': '☰  菜单 · 玩法', 'hint.keys': '方向键 / WASD · 空格 道具(↓ 往后扔) · C 回看 · {r}ESC 菜单 · M 声音 · L 画质',
  'hint.solo': 'R 重开 · ', 'hint.host': 'R 再来 · ', 'hint.guest': 'R 求再来 · ',
  go: '冲!', rocket: '火箭起步!', boostReady: '起步加速就绪', tooEarly: '按早了 · 松开再按住', holdTouch: '按住屏幕,起步加速', holdKey: '按住 ↑ 起步加速',
  finalLap: '最后一圈!', lapToast: '第 {n} 圈  ·  {t}', finish: '冲线!', finishFirst: '先跑完这一场',
  inked: '被喷墨了!', blocked: '挡住了!', niceShot: '打中了!', coins2: '+2 金币', starPower: '★ 无敌星!', zap: '⚡ 闪电!', got: '{item}!',
  'hit.lightning': '被电了!', 'hit.banana': '踩香蕉了!', 'hit.star': '被撞飞了!', 'hit.bullet': '被碾过去了!', 'hit.blue': '吃了蓝龟壳!', 'hit.bomb': '轰!', 'hit.fire': '着火了!', 'hit.shell': '中弹!',
  soundOnToast: '声音开', soundOffToast: '声音关', detailToast: '画质:{q}', lowFps: '帧率偏低 · 画质{q}', votes1: '1 位玩家想再来一场', votesN: '{n} 位玩家想再来一场',
  warnRed: '红龟壳追来了!', warnBlue: '蓝龟壳出动!', warnBlueMe: '蓝龟壳冲你来了!',
  'item.mushroom': '蘑菇', 'item.green': '绿龟壳', 'item.red': '红龟壳', 'item.banana': '香蕉皮', 'item.tgreen': '三连绿龟壳', 'item.tred': '三连红龟壳',
  'item.tbanana': '三连香蕉皮', 'item.star': '无敌星', 'item.lightning': '闪电', 'item.coin': '金币', 'item.blue': '蓝龟壳', 'item.bomb': '炸弹兵', 'item.blooper': '墨鱼',
  'item.bullet': '炮弹比尔', 'item.golden': '金蘑菇', 'item.fire': '火焰花',
  finBanner: '冲线!{place}名 · {time}', watching: '观战:{name}', skipKeys: '空格 · 看成绩', skipTap: '点这里 · 看成绩',
  youFinished: '你是{place}名 · {time}', bestLap: ' · 最快圈 {t}', laps: '每圈  {list}', racing: '比赛中…',
  grandPrix: '🏆 大奖赛', finalStandings: '最终排名', cupStandings: '杯赛积分', cupAfter: '杯赛积分 · 第 {n}/{of} 场后',
  nextRaceIn: '{n} 秒后下一场', newRaceIn: '{n} 秒后重开', waitHostRacing: '房主还在跑…', waitCup: '所有人冲线后开始下一场…', waitHost: '等房主重开或回大厅…',
  newCup: '新杯赛', nextRace: '下一场', raceAgain: '再跑一场', restart: '重开', quit: '退出', toLobby: '回大厅', leave: '离开房间', rematch: '想再来一场?', rematchOn: '✓ 已申请再来',
  resume: '继续', soundOn: '声音:开', soundOff: '声音:关', detail: '画质:{q}', 'q.auto': '自动', 'q.0': '高', 'q.1': '中', 'q.2': '低',
  steering: '转向灵敏度:{s}', 'steer.0': '低', 'steer.1': '标准', 'steer.2': '高', statsOn: '性能统计:开', statsOff: '性能统计:关', lang: '语言:中文',
  howto: '玩法', gotIt: '知道了',
  'ht.steer': '转向', 'ht.brake': '刹车', 'ht.item': '道具', 'ht.rocket': '火箭起步', 'ht.drive': '驾驶', 'ht.look': '回看', 'ht.menu': '菜单',
  'hd.steer': '在屏幕左半边拖动。油门是自动的。', 'hd.brake': '按住刹车键;按着它扔道具就往后扔。',
  'hd.item': '按住亮出,松手扔出,往下拖再松手往后扔。', 'hd.rocket': '倒数到 1 时按住屏幕,一直按到"冲!"。', 'hd.lookTouch': '按住"回看"键。',
  'hk.drive': '↑ / W 油门,↓ / S 刹车,← → / A D 转向。', 'hk.item': '按住空格亮出,松开扔出;按着 ↓ 往后扔。',
  'hk.rocket': '倒数到 1 时按住 ↑,一直按到"冲!"。', 'hk.look': '按住 C。', 'hk.menu': 'ESC:声音、画质、重开、离开。',
};

export const STR = { zh, en };
