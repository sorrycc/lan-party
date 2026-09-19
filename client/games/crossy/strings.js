/* Crossy Farm Car - every word the game shows, in Chinese (the default) and English. `{n}` in a string is filled from the vars.
   Nothing here crosses the network: snapshots carry numbers and cause codes, each screen reads them in its own language. No DOM. */
const en = {
  // hud
  warn: 'the UFO is watching', go: 'GO!', revivedTag: 'BACK ON THE ROAD!', goal: 'finish: row {n}',
  spectating: 'SPECTATING {name} · {n} STILL DRIVING', stillDriving: '{n} STILL DRIVING',
  hintTouch: 'tap or swipe to hop · hold to keep hopping', hintKeys: '↑ / W / space to hop · arrows to steer',
  'key.restart': 'restart', 'key.menu': 'menu', 'key.again': 'again', 'key.lobby': 'lobby', 'key.sound': 'sound', 'key.revive': 'revive',
  'role.solo': 'solo', 'role.host': 'hosting', 'role.players': '{n} players',
  sndOn: '🔊 sound on', sndOff: '🔇 sound off',
  reviveReady: 'REVIVE READY', reviveProg: 'REVIVE {n}/{cost}', ladder: 'LIVE', you: 'YOU',
  // cards
  'pill.death': 'cause of death', 'pill.over': 'round over', 'pill.finish': 'finish line',
  youWin: 'You win!', wins: '{name} wins!', done: 'Done', madeIt: 'You made it!', crossedFirst: '{name} crossed the line first.', finishJoke: 'Row {n}. The farm is behind you. The cows are still mad.',
  'stat.score': 'score', 'stat.coins': 'coins', 'stat.placeSoFar': 'place so far', 'stat.place': 'place', 'stat.hops': 'hops', 'stat.time': 'time',
  placeOf: '#{n} of {total}', youTag: '(you)', seconds: '{n}s',
  watching: 'watching the others finish… ({n} still driving)',
  revive: 'REVIVE · {cost} COINS · {s}', giveUp: 'GIVE UP', reviveOffer: 'Spend {cost} coins to jump back in at row {row}. Once a round.',
  again: 'DRIVE AGAIN', menu: 'MENU', lobby: 'BACK TO LOBBY', leave: 'LEAVE ROOM', rematch: 'REMATCH?', rematchOn: 'REMATCH ✓',
  waitHost: 'WAITING FOR THE HOST TO PLAY AGAIN OR RETURN TO THE LOBBY…', votes1: '1 player wants a rematch', votesN: '{n} players want a rematch',
  // deaths: a title and three jokes each
  'death.cow': 'Mooved down', 'death.cow.0': 'Flattened by a cow. She did not even slow down.', 'death.cow.1': 'A cow hit you. Insurance is calling it an act of cud.', 'death.cow.2': 'Cow 1, car 0. The cow was not keeping score.',
  'death.pig': 'Hogged', 'death.pig.0': 'Run over by a pig. Somehow this is your fault.', 'death.pig.1': 'A pig got you. It felt nothing.', 'death.pig.2': 'Trampled by bacon. Circle of life.',
  'death.chicken': 'Plucked', 'death.chicken.0': 'Hit by a chicken. It was crossing the road. Obviously.', 'death.chicken.1': 'Beaten by a chicken. Do not tell the pickup.', 'death.chicken.2': 'A chicken won. It will never let you forget it.',
  'death.sheep': 'Fleeced', 'death.sheep.0': 'Trampled by sheep. Counting them did not help.', 'death.sheep.1': 'Sheep. Fluffy outside, forklift inside.', 'death.sheep.2': 'Ewe should have waited.',
  'death.goose': 'Honked', 'death.goose.0': 'A goose got you. A goose always gets you.', 'death.goose.1': 'Ended by a goose. It is still angry about it.', 'death.goose.2': 'The goose has no regrets. It has never had one.',
  'death.stampede': 'Stampeded', 'death.stampede.0': 'Sheep stampede. The sign was blinking for a reason.', 'death.stampede.1': 'Flattened by the flock. The lights were on. You were not.', 'death.stampede.2': 'Fourteen sheep. One car. Math happened.',
  'death.sink': 'Sunk', 'death.sink.0': 'Sunk. Cars famously cannot swim.', 'death.sink.1': 'Glug. That was not a log.', 'death.sink.2': 'Straight into the river. Bold, but no.',
  'death.drift': 'Drifted', 'death.drift.0': 'Floated off the map. Logs do not have a steering wheel.', 'death.drift.1': 'Drifted away. Lovely log, terrible parking.', 'death.drift.2': 'Off to sea. Send a postcard.',
  'death.abduct': 'Abducted', 'death.abduct.0': 'You idled. The UFO was not here for the cows after all.', 'death.abduct.1': 'Beamed up. Never park on a farm at night.', 'death.abduct.2': 'Abducted. Idle cars are the UFO\'s favourite snack.',
  // vehicles
  'veh.hatch': 'Rusty Hatch', 'veh.golf': 'Golf Cart', 'veh.pickup': 'Farm Pickup', 'veh.tractor': 'Old Tractor', 'veh.taxi': 'Yellow Cab', 'veh.cop': 'Sheriff Cruiser',
  'veh.icecream': 'Cone Van', 'veh.sports': 'Red Rocket', 'veh.ambulance': 'Farm Medic', 'veh.bus': 'School Bus', 'veh.monster': 'Mud Monster', 'veh.milk': 'Milk Tanker',
};

const zh = {
  warn: 'UFO 盯上你了', go: '出发!', revivedTag: '满血复活!', goal: '终点:第 {n} 行',
  spectating: '正在观战 {name} · 还剩 {n} 辆车', stillDriving: '还剩 {n} 辆车',
  hintTouch: '点击或滑动来跳 · 按住连跳', hintKeys: '↑ / W / 空格 往前跳 · 方向键转向',
  'key.restart': '重来', 'key.menu': '菜单', 'key.again': '再来', 'key.lobby': '大厅', 'key.sound': '声音', 'key.revive': '复活',
  'role.solo': '单人', 'role.host': '房主', 'role.players': '{n} 名玩家',
  sndOn: '🔊 声音开', sndOff: '🔇 声音关',
  reviveReady: '可以复活', reviveProg: '复活 {n}/{cost}', ladder: '实时', you: '你',
  'pill.death': '死因', 'pill.over': '本局结束', 'pill.finish': '到达终点',
  youWin: '你赢了!', wins: '{name} 赢了!', done: '结束', madeIt: '你冲过终点了!', crossedFirst: '{name} 第一个冲过终点。', finishJoke: '第 {n} 行。农场甩在身后,牛还在生气。',
  'stat.score': '得分', 'stat.coins': '金币', 'stat.placeSoFar': '目前名次', 'stat.place': '名次', 'stat.hops': '跳跃', 'stat.time': '用时',
  placeOf: '第 {n} / {total}', youTag: '(你)', seconds: '{n} 秒',
  watching: '看其他人跑完…(还剩 {n} 辆车)',
  revive: '复活 · {cost} 金币 · {s}', giveUp: '放弃', reviveOffer: '花 {cost} 个金币,回到第 {row} 行继续跑。每局一次。',
  again: '再跑一局', menu: '菜单', lobby: '回到大厅', leave: '离开房间', rematch: '再来一局?', rematchOn: '想再来 ✓',
  waitHost: '等房主决定再来一局还是回大厅…', votes1: '1 名玩家想再来一局', votesN: '{n} 名玩家想再来一局',
  'death.cow': '被牛撞飞', 'death.cow.0': '被一头牛撞扁了。她连速度都没减。', 'death.cow.1': '被牛撞了。保险公司说这属于"不可抗牛"。', 'death.cow.2': '牛 1 : 车 0。牛根本没在记分。',
  'death.pig': '猪突猛进', 'death.pig.0': '被一头猪碾过。不知怎么的,这还是你的错。', 'death.pig.1': '猪撞到了你。它什么感觉都没有。', 'death.pig.2': '被培根碾过。这就是自然规律。',
  'death.chicken': '栽在鸡手里', 'death.chicken.0': '被一只鸡撞了。它在过马路,当然了。', 'death.chicken.1': '输给了一只鸡。别告诉皮卡。', 'death.chicken.2': '鸡赢了。它会拿这事笑你一辈子。',
  'death.sheep': '被羊薅了', 'death.sheep.0': '被羊群踩了。数羊也没用。', 'death.sheep.1': '羊:外面毛茸茸,里面是叉车。', 'death.sheep.2': '咩。你应该等一等的。',
  'death.goose': '大鹅出击', 'death.goose.0': '大鹅逮住了你。大鹅总能逮住你。', 'death.goose.1': '被一只鹅终结了。它到现在还在生气。', 'death.goose.2': '大鹅从不后悔。它就没后悔过。',
  'death.stampede': '羊群踩踏', 'death.stampede.0': '羊群狂奔。那块牌子一直在闪是有原因的。', 'death.stampede.1': '被羊群碾平。灯亮着,你却没看。', 'death.stampede.2': '十四只羊,一辆车。结果不用算。',
  'death.sink': '沉了', 'death.sink.0': '沉了。众所周知,车不会游泳。', 'death.sink.1': '咕噜。那不是木头。', 'death.sink.2': '一头扎进河里。勇气可嘉,但不行。',
  'death.drift': '漂走了', 'death.drift.0': '漂出了地图。木头可没有方向盘。', 'death.drift.1': '漂走了。木头不错,就是停错了地方。', 'death.drift.2': '出海了。记得寄张明信片。',
  'death.abduct': '被外星人抓走', 'death.abduct.0': '你发呆了。UFO 根本不是来抓牛的。', 'death.abduct.1': '被光束吸走。晚上千万别在农场停车。', 'death.abduct.2': '被绑走了。发呆的车是 UFO 最爱的零食。',
  'veh.hatch': '破旧两厢车', 'veh.golf': '高尔夫球车', 'veh.pickup': '农场皮卡', 'veh.tractor': '老拖拉机', 'veh.taxi': '黄色出租车', 'veh.cop': '警长巡逻车',
  'veh.icecream': '冰淇淋车', 'veh.sports': '红色火箭', 'veh.ambulance': '农场救护车', 'veh.bus': '校车', 'veh.monster': '泥地怪兽', 'veh.milk': '牛奶罐车',
};

export const STR = { zh, en };
