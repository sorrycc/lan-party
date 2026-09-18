/* Loaded Dice - every word the game shows, in Chinese (the default) and English. The rules and the wire carry keys, each screen
   reads them in its own language. `{n}` in a string is filled from the vars. A key missing from a table falls back to English, then
   to the key itself. No DOM: the two tables are checked against each other in node. */
const en = {
  // what a fighter shouts (rules.js's `say`)
  hit: 'HIT', crit: 'CRIT!', whiff: 'WHIFF', clash: 'CLASH', attack: 'ATTACK', break: 'BREAK', parry: 'PARRY!', block: 'BLOCK', fumble: 'FUMBLE', guard: 'GUARD',
  dodge: 'DODGE', hop: 'HOP', meh: 'MEH', roar: 'ROAR!', threat: 'THREAT', spooked: 'SPOOKED', heal: 'HEAL', bigheal: 'BIG HEAL', fizzle: 'FIZZLE',
  speedup: 'SPEED UP', rush: 'RUSH!', rushed: 'RUSHED', slowdown: 'SLOW DOWN', dazed: 'DAZED', missed: 'MISSED', jackpot: 'JACKPOT!', boom: 'BOOM', smoke: 'INK!', smoked: 'INKED', leech: 'LEECH', counter: 'COUNTER!', opening: 'WIDE OPEN', poison: 'POISON', poisoned: 'POISONED', fever: 'FEVER!', feverSub: 'TWO DICE, THE HIGHER COUNTS  ·  WIDE SWEET SPOTS  ·  +½ ♥ DAMAGE', feverCap: 'FEVER', ko: 'K.O.!', lucky: 'LUCKY!', rigged: '{base} +{bonus} RIG',
  // the press
  'grade.PERFECT': 'PERFECT', 'grade.GOOD': 'GOOD', 'grade.MISSED': 'MISSED', 'grade.plain': 'PLAIN ROLL', 'grade.late': 'TOO LATE', 'grade.jackpot': 'JACKPOT', 'grade.bomb': 'BOMB!', 'sub.bomb': 'HALF A HEART · NO MOVE',
  'sub.lost': '{n} COMBO LOST', 'sub.fumble': 'FUMBLE · ROLLS A 1', 'sub.rig': '{act} · RIG +{n}', 'sub.rigCombo': '{act} · RIG +{n} · {c} COMBO', 'sub.plain': 'NO RIG · ATTACK', 'sub.late': 'PLAIN ROLL',
  'act.sword': 'ATTACK', 'act.shield': 'BLOCK', 'act.skull': 'THREATEN', 'act.heart': 'HEAL', 'act.fast': 'RUSH THEM', 'act.fastSelf': 'SPEED UP', 'act.slow': 'SLOW DOWN', 'act.mystery': 'MYSTERY', 'act.plain': 'PLAIN ROLL', 'act.miss': 'MISSED', 'act.dodge': 'DODGE', 'act.stun': 'DAZED', 'act.jackpot': 'JACKPOT', 'act.bomb': 'BOMB', 'act.double': 'TWO PRESSES', 'tip.double': 'THE CURSOR CROSSES TWICE · ONE MOVE A CROSSING, NEVER THE SAME SLOT', 'act.none': '…',
  'intent.charge': 'WINDING UP', 'trick.flurry': 'FLURRY!', 'trick.ink': 'INK!', 'trick.steal': 'YOINK!', 'trick.charge': 'WINDING UP…', 'trick.smash': 'SMASH!', 'trick.jam': 'STRINGS PULLED!', 'trick.blank': 'FACELESS!', 'trick.freeze': 'FROZEN OVER!', 'trick.swallow': 'HEXED! YOUR DIE', 'trick.angry': 'THE BARON IS NOT AMUSED', 'trick.angry.d': 'A BIGGER DIE: D{die}  ·  HE WILL HEX YOURS',
  'act.smoke': 'INK', 'act.leech': 'LEECH', 'act.counter': 'COUNTER', 'act.poison': 'POISON',
  'tip.leech': 'AN ATTACK FOR 1 LESS THAT HEALS YOU HALF A HEART', 'tip.counter': 'TURNS THEIR ATTACK BACK ON THEM · NOTHING TO TURN AND YOU ARE DAZED', 'tip.poison': 'HALF A HEART A ROUND FOR THREE ROUNDS · NO SHIELD STOPS IT',
  'face.vamp': 'VAMPIRE FACE · THE {n}', 'face.vamp.d': 'A move that lands on it heals half a heart', 'face.double': 'DOUBLE FACE · THE {n}', 'face.double.d': 'Damage or healing on it is doubled', 'face.guard': 'GUARD FACE · THE {n}', 'face.guard.d': 'On it you take half a heart less',
  'face.venom': 'VENOM FACE · THE {n}', 'face.venom.d': 'A move that lands on it poisons them', 'face.lucky': 'LUCKY FACE · THE {n}', 'face.lucky.d': 'A move that lands on it is +3 fever',
  draftPress: 'LOAD A FACE OF YOUR DIE  ·  PRESS WHEN IT LIGHTS UP  ·  {s}', draftTap: 'LOAD A FACE OF YOUR DIE  ·  TAP A CARD  ·  {s}', draftTheirs: '{name} IS PICKING A FACE  ·  {s}', draftDone: 'LOADED', 'act.bounce': 'THERE AND BACK', 'act.slide': 'SLIDING', 'act.shrink': 'SHRINKING', 'act.fog': 'INK ON YOUR BAR',
  'tip.jackpot': 'THE SLIVER OF GOLD: RIG +3 AND A SURE CRIT', 'tip.bomb': 'DO NOT PRESS IT: HALF A HEART AND YOUR COMBO', 'tip.smoke': 'LAND IT AND PART OF THEIR NEXT BAR IS UNDER INK',
  'tip.bounce': 'THE CURSOR COMES BACK · THE SLOTS ARE NARROWER ON THE WAY', 'tip.slide': 'THE SLOTS SWAY · PRESS WHERE THEY ARE, NOT WHERE THEY WERE', 'tip.shrink': 'THE SLOTS CLOSE IN · THE LATE ONES ARE THE SMALL ONES', 'tip.fog': 'WHAT IS UNDER IT SHOWS AS THE CURSOR GETS NEAR',
  'intent.attack': 'ATTACK', 'intent.block': 'BLOCK', 'intent.dodge': 'DODGE', 'intent.stun': 'DAZED', 'intent.hidden': '???', 'opp.locked': 'LOCKED IN', 'opp.aiming': 'AIMING',
  // HUD
  score: 'SCORE', combo: 'COMBO', die: 'DIE', speed: 'SPEED', wins: 'WINS', toHit: '{n}+ TO HIT', rolled: '{r} ROLLED · {n}+ HITS', lv: 'LV {n}', stageOf: '{name}  ·  STAGE {n}', you: 'YOU  ·  {name}', isDazed: '{name}  ·  DAZED',
  barRig: 'GOOD +{g} · PERFECT +{p}', barSweep: '{x}× SWEEP',
  'hint.solo': 'SWORDS ATTACK · SHIELDS BLOCK · SKULLS THREATEN · HEARTS HEAL · << SLOW · >> FAST · MAX ROLL CRITS',
  'hint.duel1': 'SWORDS ATTACK · SHIELDS BLOCK SWORDS · SKULLS BREAK SHIELDS AND DAZE', 'hint.duel2': 'HEARTS HEAL · >> RUSHES THEIR BAR · << SLOWS YOURS · THE TOP FACE CRITS',
  'foot.touch': 'TAP ANYWHERE = THE ONLY BUTTON   ·   ☰ = MENU', 'foot.keys': 'SPACE / CLICK = THE ONLY BUTTON   ·   M = {mute}', 'foot.mute': 'MUTE', 'foot.muted': 'MUTED', 'foot.host': '   ·   R = {again}   ·   ESC = {exit}',
  'foot.again': 'PLAY AGAIN', 'foot.restart': 'RESTART', 'foot.lobby': 'LOBBY', 'foot.quit': 'QUIT',
  // banners
  stage: 'STAGE {n}', stageSub: '{name}  ·  D{die}  ·  {hit}+ TO HIT', levelUp: 'LEVEL UP!', getReady: 'GET READY', vs: '{a}  VS  {b}  ·  FIRST TO {n}', duelN: 'DUEL {n}', duelSub: 'D{die}  ·  {hit}+ TO HIT  ·  FIRST TO {n}',
  bigger: 'BIGGER DICE', biggerSub: 'D{a} → D{b}  ·  6+ ROLLS HIT HARDER', doubleKo: 'DOUBLE K.O.', youTake: 'YOU TAKE THE DUEL', theyTake: '{name} TAKES THE DUEL', tally: '{a} {x}  ·  {y} {b}',
  // perks
  perkTap: 'LEVEL UP!  TAP A PERK', perkPress: 'LEVEL UP!  PRESS WHEN YOUR PERK LIGHTS UP',
  'perk.crit': '+5% CRIT CHANCE', 'perk.crit.d': 'Landed rolls may jump to max', 'perk.maxhp': 'BIG HEART', 'perk.maxhp.d': '+1 max heart, heal 1', 'perk.heal': 'PATCH UP', 'perk.heal.d': 'Heal 2 hearts now',
  'perk.wide': 'FAT SLOTS', 'perk.wide.d': 'Slots are 15% wider', 'perk.perf': 'SWEET SPOT', 'perk.perf.d': 'Perfect zone 25% wider', 'perk.cool': 'COOL HEAD', 'perk.cool.d': 'Combo speeds the bar 20% less',
  'perk.thorn': 'THORNS', 'perk.thorn.d': 'Every block bites back', 'perk.vamp': 'VAMPIRE', 'perk.vamp.d': 'Crits heal half a heart', 'perk.wt': 'WEIGHTED', 'perk.wt.d': 'You never roll a 1',
  'perk.xp': 'SCHOLAR', 'perk.xp.d': '+30% XP', 'perk.heavy': 'HEAVY HAND', 'perk.heavy.d': 'Crits deal +half heart', 'perk.rig': 'SHAVED EDGES', 'perk.rig.d': 'GOOD rigs +2, PERFECT +3',
  'perk.big': 'BIGGER DIE: D{n}', 'perk.big.d': 'D{a} → D{b}, 6+ rolls hit harder',
  // title and the end of a run
  title: 'LOADED DICE', tagline: 'A ONE-BUTTON DICE DUEL · RIG THE ROLL', startTap: 'TAP ANYWHERE TO START', startPress: 'PRESS SPACE · CLICK · TAP', demo: 'DEMO PLAYING', best: 'BEST {n}',
  snakeEyes: 'SNAKE EYES', wentDown: '{name} WENT DOWN ON STAGE {n}', bestCap: 'BEST', level: 'LEVEL', kills: 'KILLS', maxCombo: 'MAX COMBO', newBest: 'NEW BEST!', againTap: 'TAP TO ROLL AGAIN', againPress: 'PRESS TO ROLL AGAIN',
  // names
  'name.hero': 'SIR ROLLO', 'name.daisy': 'DAISY GRINS', 'name.blot': 'BLOT', 'name.caw': 'CAWDELIA', 'name.moss': 'MOSSBACK', 'name.puppet': 'KNOCKWOOD', 'name.grin': 'THE GRINNER', 'name.frost': 'RIME THE HOODED', 'name.ram': 'BARON RAMSEY', player: 'PLAYER',
  // cards
  menu: 'MENU', resume: 'RESUME', soundOn: 'SOUND: ON', soundOff: 'SOUND: OFF', lang: 'LANGUAGE: EN', howto: 'HOW TO PLAY', gotIt: 'GOT IT', restart: 'RESTART', playAgain: 'PLAY AGAIN', playSolo: 'PLAY SOLO', quit: 'QUIT TO MENU', toLobby: 'BACK TO LOBBY',
  rotate: 'ROTATE YOUR DEVICE', rotateSub: 'LOADED DICE PLAYS IN LANDSCAPE',
  resKick: 'LOADED DICE  ·  FIRST TO {n}', walkedOff: 'THEY WALKED OFF', youWin: 'YOU WIN', youLose: 'SNAKE EYES', thDuels: 'DUELS', thPerfects: 'PERFECTS', thCrits: 'CRITS', thDealt: 'HEARTS TAKEN OFF',
  leftRoom: 'The other player left the room.', hostKeys: 'R = play again  ·  Esc = lobby', waitHost: 'Waiting for the host…',
  'help.press': 'Press Space or click', 'help.tap': 'Tap anywhere',
  'help.solo': `<p><b>One button.</b> {press} while the cursor is over a slot: that is your move, and it rigs your die (+1, or +2 on the bright middle). Bare bar is a fumble; letting the bar run out is a plain attack.</p>
    <ul><li><i class="g"></i><b>Sword</b> attack &nbsp; <b>Shield</b> block &nbsp; <b>Heart</b> heal</li><li><i class="r"></i><b>Skull</b> threaten: dazes them for a round and breaks a block</li><li><b>&gt;&gt;</b> faster bar, more score &nbsp; <b>&lt;&lt;</b> slower bar &nbsp; <b>?</b> a surprise</li><li><b>Gold sliver</b> rig +3, a sure crit; the <b>bomb</b> beside it costs half a heart</li><li><b>FEVER</b> fills with good presses: then two dice, the higher counts</li><li>Later on: bars that move, <b>leech</b>, <b>counter</b>, <b>poison</b>, <b>ink</b>, rounds of two presses, and faces of your die loaded with a mark. A line under the bar says what each is the first time.</li></ul>
    <p>The bubble over the enemy shows what it is about to do. Roll the number on the die or more to land a move; the top face is a crit. Every rigged press builds the combo, and the combo speeds the bar.</p>`,
  'help.duel': `<p><b>One button.</b> {press} while the cursor is over a slot: that is your move, and it rigs your die (+1, or +2 on the bright middle). Bare bar is a fumble; letting the bar run out is a plain attack. Both dice are thrown when both of you have pressed.</p>
    <ul><li><i class="g"></i><b>Sword</b> attacks. Two attacks clash and the higher roll lands.</li><li><i class="g"></i><b>Shield</b> blocks a sword. A top-face block parries.</li><li><i class="r"></i><b>Skull</b> breaks a shield and dazes them: narrow slots next round.</li><li><i class="g"></i><b>Heart</b> heals &nbsp; <b>&gt;&gt;</b> speeds THEIR bar &nbsp; <b>&lt;&lt;</b> slows yours</li><li><b>Gold sliver</b> rig +3, a sure crit; the <b>bomb</b> beside it costs half a heart</li><li><b>FEVER</b> fills with good presses: then two dice, the higher counts</li><li>Later on: bars that move, <b>leech</b>, <b>counter</b>, <b>poison</b>, <b>ink</b>, rounds of two presses, and faces of your die loaded with a mark. A line under the bar says what each is the first time.</li></ul>
    <p>Their bar is the small one under their hearts: you see what they could pick, not what they picked. Roll {hit} or more to land a move, the top face is a crit, and 6 or more hits harder. A combo speeds your bar and makes lucky crits.</p>`,
};

const zh = {
  hit: '命中', crit: '暴击!', whiff: '挥空', clash: '拼刀', attack: '进攻', break: '破防', parry: '弹反!', block: '格挡', fumble: '失手', guard: '架盾',
  dodge: '闪开', hop: '蹦跶', meh: '没吓住', roar: '怒吼!', threat: '恐吓', spooked: '吓懵了', heal: '回血', bigheal: '大回血', fizzle: '哑火',
  speedup: '加速', rush: '催命!', rushed: '被催了', slowdown: '减速', dazed: '眩晕', missed: '按空了', jackpot: '头彩!', boom: '炸了', smoke: '泼墨!', smoked: '被泼了', leech: '偷血', counter: '反击!', opening: '露了破绽', poison: '下毒', poisoned: '中毒了', fever: '手气爆棚!', feverSub: '掷两颗取高的  ·  完美区加宽  ·  伤害 +半颗心', feverCap: '手气', ko: '倒地!', lucky: '走运!', rigged: '{base} +{bonus} 灌铅',
  'grade.PERFECT': '完美', 'grade.GOOD': '不错', 'grade.MISSED': '按空了', 'grade.plain': '白掷', 'grade.late': '太慢了', 'grade.jackpot': '头彩', 'grade.bomb': '踩雷!', 'sub.bomb': '掉半颗心 · 这回合没动作',
  'sub.lost': '断了 {n} 连击', 'sub.fumble': '失手 · 只掷出 1', 'sub.rig': '{act} · 灌铅 +{n}', 'sub.rigCombo': '{act} · 灌铅 +{n} · {c} 连击', 'sub.plain': '没灌铅 · 普通攻击', 'sub.late': '白掷',
  'act.sword': '攻击', 'act.shield': '格挡', 'act.skull': '恐吓', 'act.heart': '回血', 'act.fast': '催对手', 'act.fastSelf': '加速', 'act.slow': '减速', 'act.mystery': '未知', 'act.plain': '白掷', 'act.miss': '按空了', 'act.dodge': '闪避', 'act.stun': '眩晕', 'act.jackpot': '头彩', 'act.bomb': '炸弹', 'act.double': '两连按', 'tip.double': '光标会扫两趟 · 每趟按一个动作,不能按同一格', 'act.none': '…',
  'intent.charge': '蓄力中', 'trick.flurry': '乱挥!', 'trick.ink': '泼墨!', 'trick.steal': '顺走一格!', 'trick.charge': '蓄力…', 'trick.smash': '重锤!', 'trick.jam': '扯线!', 'trick.blank': '没脸了!', 'trick.freeze': '结冰了!', 'trick.swallow': '下咒!封了你的骰子', 'trick.angry': '男爵生气了', 'trick.angry.d': '换大骰子:D{die}  ·  还会封你的骰子',
  'act.smoke': '泼墨', 'act.leech': '偷血', 'act.counter': '反击', 'act.poison': '下毒',
  'tip.leech': '少打半颗心的攻击,命中给自己回半颗', 'tip.counter': '把对手的攻击弹回去 · 对手没攻击,你下回合眩晕', 'tip.poison': '三回合,每回合掉半颗心 · 盾挡不住',
  'face.vamp': '吸血面 · {n} 点', 'face.vamp.d': '掷到它且动作成了,回半颗心', 'face.double': '双倍面 · {n} 点', 'face.double.d': '掷到它,伤害或回血翻倍', 'face.guard': '护盾面 · {n} 点', 'face.guard.d': '掷到它,这回合少掉半颗心',
  'face.venom': '毒面 · {n} 点', 'face.venom.d': '掷到它且动作成了,对手中毒', 'face.lucky': '幸运面 · {n} 点', 'face.lucky.d': '掷到它且动作成了,手气 +3',
  draftPress: '给你的骰子灌一面  ·  想要的亮起时按下  ·  {s}', draftTap: '给你的骰子灌一面  ·  点一张  ·  {s}', draftTheirs: '{name} 正在选  ·  {s}', draftDone: '灌好了', 'act.bounce': '来回扫', 'act.slide': '格子在滑', 'act.shrink': '格子在缩', 'act.fog': '你的条被泼了墨',
  'tip.jackpot': '那一丝金色:灌铅 +3,必定暴击', 'tip.bomb': '别按它:掉半颗心,连击清零', 'tip.smoke': '成了的话,对手下一条有一段被墨盖住',
  'tip.bounce': '光标到头会折回来 · 回程的格子更窄', 'tip.slide': '格子在晃 · 按它现在的位置,不是刚才的', 'tip.shrink': '格子越来越小 · 越靠后的越难按', 'tip.fog': '墨下面的格子,光标靠近了才显形',
  'intent.attack': '要攻击', 'intent.block': '要格挡', 'intent.dodge': '要闪避', 'intent.stun': '眩晕中', 'intent.hidden': '???', 'opp.locked': '已出手', 'opp.aiming': '瞄准中',
  score: '分数', combo: '连击', die: '骰子', speed: '速度', wins: '胜局', toHit: '{n} 以上命中', rolled: '掷出 {r} · {n} 以上命中', lv: '{n} 级', stageOf: '{name}  ·  第 {n} 关', you: '你  ·  {name}', isDazed: '{name}  ·  眩晕',
  barRig: '不错 +{g} · 完美 +{p}', barSweep: '{x}× 扫速',
  'hint.solo': '剑攻击 · 盾格挡 · 骷髅恐吓 · 心回血 · << 减速 · >> 加速 · 掷出顶面暴击',
  'hint.duel1': '剑攻击 · 盾挡剑 · 骷髅破盾并让对手眩晕', 'hint.duel2': '心回血 · >> 催快对手的条 · << 放慢自己的条 · 顶面暴击',
  'foot.touch': '点屏幕任意处 = 唯一的按钮   ·   ☰ = 菜单', 'foot.keys': '空格 / 点击 = 唯一的按钮   ·   M = {mute}', 'foot.mute': '静音', 'foot.muted': '已静音', 'foot.host': '   ·   R = {again}   ·   ESC = {exit}',
  'foot.again': '再来一场', 'foot.restart': '重来', 'foot.lobby': '回大厅', 'foot.quit': '退出',
  stage: '第 {n} 关', stageSub: '{name}  ·  D{die}  ·  {hit} 以上命中', levelUp: '升级!', getReady: '准备', vs: '{a}  对  {b}  ·  先赢 {n} 局', duelN: '第 {n} 局', duelSub: 'D{die}  ·  {hit} 以上命中  ·  先赢 {n} 局',
  bigger: '骰子变大', biggerSub: 'D{a} → D{b}  ·  6 以上打得更狠', doubleKo: '同归于尽', youTake: '这局归你', theyTake: '这局归 {name}', tally: '{a} {x}  ·  {y} {b}',
  perkTap: '升级!  点一张强化', perkPress: '升级!  想要的那张亮起时按下',
  'perk.crit': '暴击率 +5%', 'perk.crit.d': '命中的骰子可能跳到顶面', 'perk.maxhp': '大心脏', 'perk.maxhp.d': '红心上限 +1,回 1 颗心', 'perk.heal': '包扎', 'perk.heal.d': '立刻回 2 颗心',
  'perk.wide': '胖格子', 'perk.wide.d': '格子加宽 15%', 'perk.perf': '甜区', 'perk.perf.d': '完美区加宽 25%', 'perk.cool': '冷静', 'perk.cool.d': '连击对扫速的影响少 20%',
  'perk.thorn': '荆棘', 'perk.thorn.d': '每次格挡都反咬一口', 'perk.vamp': '吸血鬼', 'perk.vamp.d': '暴击回半颗心', 'perk.wt': '加重', 'perk.wt.d': '再也掷不出 1',
  'perk.xp': '学者', 'perk.xp.d': '经验 +30%', 'perk.heavy': '重手', 'perk.heavy.d': '暴击多打半颗心', 'perk.rig': '磨边', 'perk.rig.d': '不错 +2,完美 +3',
  'perk.big': '更大的骰子:D{n}', 'perk.big.d': 'D{a} → D{b},6 以上打得更狠',
  title: '灌铅骰子', tagline: '一个按钮的骰子对决 · 出千灌铅', startTap: '点任意处开始', startPress: '按空格 · 点击 · 轻点', demo: '演示中', best: '最高 {n}',
  snakeEyes: '蛇眼出局', wentDown: '{name}倒在了第 {n} 关', bestCap: '最高', level: '等级', kills: '击倒', maxCombo: '最高连击', newBest: '新纪录!', againTap: '点一下再来', againPress: '按一下再来',
  'name.hero': '罗洛爵士', 'name.daisy': '咧嘴雏菊', 'name.blot': '墨团', 'name.caw': '鹿骨鸦柯黛莉亚', 'name.moss': '叶熊莫斯', 'name.puppet': '木偶诺克', 'name.grin': '无脸笑客', 'name.frost': '霜兜帽莱姆', 'name.ram': '公羊男爵', player: '玩家',
  menu: '菜单', resume: '继续', soundOn: '声音:开', soundOff: '声音:关', lang: '语言:中文', howto: '玩法', gotIt: '知道了', restart: '重来', playAgain: '再来一场', playSolo: '单人闯关', quit: '退出', toLobby: '回大厅',
  rotate: '请把设备横过来', rotateSub: '灌铅骰子要横屏玩',
  resKick: '灌铅骰子  ·  先赢 {n} 局', walkedOff: '对手跑了', youWin: '你赢了', youLose: '蛇眼出局', thDuels: '胜局', thPerfects: '完美', thCrits: '暴击', thDealt: '打掉的心',
  leftRoom: '对方离开了房间。', hostKeys: 'R = 再来一场  ·  Esc = 回大厅', waitHost: '等房主操作…',
  'help.press': '按空格或点击', 'help.tap': '点屏幕任意处',
  'help.solo': `<p><b>只有一个按钮。</b>光标扫到格子上时{press}:那就是你这回合的动作,同时给骰子灌铅(+1,压中亮色的正中 +2)。按在空白处是失手;放着不按,就是一次普通攻击。</p>
    <ul><li><i class="g"></i><b>剑</b>攻击 &nbsp; <b>盾</b>格挡 &nbsp; <b>心</b>回血</li><li><i class="r"></i><b>骷髅</b>恐吓:让对手眩晕一回合,还能破盾</li><li><b>&gt;&gt;</b> 条变快、分更多 &nbsp; <b>&lt;&lt;</b> 条变慢 &nbsp; <b>?</b> 开出什么算什么</li><li><b>金色细格</b>灌铅 +3、必定暴击;紧挨着的<b>炸弹</b>按中掉半颗心</li><li><b>手气</b>靠压中格子攒满:下一回合掷两颗取高的</li><li>往后还有:会动的条、<b>偷血</b>、<b>反击</b>、<b>下毒</b>、<b>泼墨</b>、两连按的回合,以及给骰子的某一面灌上记号。每样第一次出现时,条下面会有一行说明。</li></ul>
    <p>敌人头上的气泡是它这回合要做的事。掷出骰子上标的点数或以上,动作才算成;掷出顶面是暴击。每次压中格子连击 +1,连击越高条扫得越快。</p>`,
  'help.duel': `<p><b>只有一个按钮。</b>光标扫到格子上时{press}:那就是你这回合的动作,同时给骰子灌铅(+1,压中亮色的正中 +2)。按在空白处是失手;放着不按,就是一次普通攻击。两边都按了,骰子才一起掷。</p>
    <ul><li><i class="g"></i><b>剑</b>攻击。两边都攻击就拼刀,点数大的砍中。</li><li><i class="g"></i><b>盾</b>挡剑。顶面的格挡是弹反。</li><li><i class="r"></i><b>骷髅</b>破盾,并让对手眩晕:下回合格子变窄。</li><li><i class="g"></i><b>心</b>回血 &nbsp; <b>&gt;&gt;</b> 催快对手的条 &nbsp; <b>&lt;&lt;</b> 放慢自己的条</li><li><b>金色细格</b>灌铅 +3、必定暴击;紧挨着的<b>炸弹</b>按中掉半颗心</li><li><b>手气</b>靠压中格子攒满:下一回合掷两颗取高的</li><li>往后还有:会动的条、<b>偷血</b>、<b>反击</b>、<b>下毒</b>、<b>泼墨</b>、两连按的回合,以及给骰子的某一面灌上记号。每样第一次出现时,条下面会有一行说明。</li></ul>
    <p>对手红心下面的小条是他的:看得到他能选什么,看不到他选了什么。掷出 {hit} 或以上动作才算成,顶面是暴击,6 以上打得更狠。连击让你的条变快,也让你更容易走运暴击。</p>`,
};

export const STR = { zh, en }, LANGS = ['zh', 'en'];
export const mkT = lang => (key, vars) => {
  let s = STR[lang]?.[key] ?? en[key] ?? key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
};
