/* Sundown Showdown - every word the game shows, in Chinese (the default) and English. The wire carries codes and numbers only;
   each screen reads them here in its own language. `{n}` in a string is filled from the vars; a key missing from a table falls
   back to English, then to the key itself. Player and CPU names are names and stay as they are. No DOM: node checks the two
   tables against each other (test/strings.test.mjs). */
const en = {
  // the brawlers: name, role, attack, super, passive (keyed by the class id in sim.js)
  'n.buck': 'BUCK', 'role.buck': 'Shotgunner', 'atk.buck': 'Buckshot: a cone of 5 pellets. Brutal up close.', 'sup.buck': 'SUPER: Mega Blast, 9 pellets that shove foes back and smash crates.', 'pas.buck': 'Point Blank: +15% damage within 3 metres.',
  'n.viper': 'VIPER', 'role.viper': 'Sharpshooter', 'atk.viper': 'Long Shot: one fast, long-range slug.', 'sup.viper': 'SUPER: Railshot, a huge slug through every foe and crate in its way.', 'pas.viper': 'Steady Aim: stand still a second and the next shot hits 20% harder.',
  'n.boomer': 'BOOMER', 'role.boomer': 'Bomb Lobber', 'atk.boomer': 'Lob Bomb: arcs over walls, explodes in an area.', 'sup.boomer': 'SUPER: Carpet Bomb, a cluster of 6 bombs rains down.', 'pas.boomer': 'Aftershock: bombs shove foes half as far again.',
  'n.brick': 'BRICK', 'role.brick': 'Melee Tank', 'atk.brick': 'Hammer Swing: a wide melee arc. Fast reload.', 'sup.brick': 'SUPER: Bull Rush, charge through crates, slamming everyone in the way.', 'pas.brick': 'Thick Skull: takes 25% less damage below 40% health.',
  'n.frost': 'FROST', 'role.frost': 'Ice Mage', 'atk.frost': 'Ice Shard: one shard that slows whoever it hits.', 'sup.frost': 'SUPER: Deep Freeze, a lobbed blast that freezes everyone in it solid.', 'pas.frost': 'Chill: +15% damage to slowed foes.',
  'n.shade': 'SHADE', 'role.shade': 'Assassin', 'atk.shade': 'Knives: three fast blades at short range.', 'sup.shade': 'SUPER: Vanish, 4 seconds unseen and quick. Attacking or being hurt gives you away.', 'pas.shade': 'Backstab: the first strike from out of sight (vanished or in grass) hits 40% harder.',
  'n.blaze': 'BLAZE', 'role.blaze': 'Flamethrower', 'atk.blaze': 'Flames: a short cone of fire that leaves foes burning.', 'sup.blaze': 'SUPER: Ring of Fire, 5 seconds of burning ground where you aim.', 'pas.blaze': 'Fireproof: never burns, and the gas hurts 20% less.',
  'n.hook': 'HOOK', 'role.hook': 'Grappler', 'atk.hook': 'Chain Lash: a chain through everyone in its way.', 'sup.hook': 'SUPER: Grapple, a hook that drags its catch to your feet, stunned.', 'pas.hook': 'Anchor: shoved only half as far.',
  'n.dash': 'DASH', 'role.dash': 'Gunslinger', 'atk.dash': 'Twin Pistols: two quick rounds side by side.', 'sup.dash': 'SUPER: Tumble, a roll past anyone that reloads every shot.', 'pas.dash': 'Adrenaline: a kill makes you quick for 3 seconds.',
  'n.sparky': 'SPARKY', 'role.sparky': 'Engineer', 'atk.sparky': 'Bolt Gun: one steady bolt.', 'sup.sparky': 'SUPER: Turret, set down a gun that shoots for you for 15 seconds, or until it is shot down.', 'pas.sparky': 'Scrap: every power cube charges a quarter of the super.',
  'n.rico': 'RICO', 'role.rico': 'Trick Shooter', 'atk.rico': 'Ricochet: a shot that comes off a wall once.', 'sup.rico': 'SUPER: Barrage, 7 shots that come off the walls three times.', 'pas.rico': 'Trick Shot: every bounce adds 25% damage.',
  passive: 'PASSIVE', turret: 'TURRET',
  'st.hp': 'Health', 'st.range': 'Range', 'st.dmg': 'Damage', 'st.speed': 'Speed', 'st.reload': 'Reload',
  // the pick screen
  title: 'SUNDOWN SHOWDOWN', pickYours: 'PICK YOUR BRAWLER', lockIn: 'LOCK IN', lockedIn: 'LOCKED IN', play: 'PLAY', pstat: '{ok}/{n} LOCKED IN', pstatT: '{ok}/{n} LOCKED IN · STARTS IN {s}',
  // HUD
  left: 'LEFT', day: '☀ DAY', sunset: '🌇 SUNSET', dusk: '🌆 DUSK', night: '🌙 NIGHT', gasBanner: '☣ POISON GAS IS CLOSING IN! ☣',
  gasIn: '☣ GAS MOVES IN {s}s', gasClosing: '☣ GAS CLOSING IN', gasFinal: '☣ FINAL ZONE', safeDist: 'SAFE ZONE {d}m', safeEdge: 'GAS EDGE',
  brawl: 'BRAWL!', super: 'SUPER!', supRelease: 'RELEASE<br>TO FIRE', supReady: 'SUPER!<br><small>hold SPACE</small>', supPct: 'SUPER<br><small>{n}%</small>',
  gasKill: '☣ Poison gas', watching: '☠ RANK #{r} · WATCHING {name}', watchKeys: '◀ A · D ▶', dragMove: 'DRAG TO MOVE', fire: 'FIRE', superBtn: 'SUPER',
  keys: '<kbd>WASD</kbd> move <kbd>MOUSE</kbd> aim <kbd>CLICK</kbd> shoot <kbd>SPACE</kbd> hold to aim the super, let go to fire <kbd>M</kbd> sound <kbd>ESC</kbd> {esc}', kMenu: 'menu', kLobby: 'lobby',
  // the result card
  victory: 'VICTORY!', defeated: 'DEFEATED', over: 'SHOWDOWN OVER', rankOf: 'RANK #{r} of {n}', wins: '{name} WINS', thBrawler: 'BRAWLER', thDamage: 'DAMAGE',
  playAgain: 'PLAY AGAIN', menuBtn: 'MENU', toLobby: 'BACK TO LOBBY', leave: 'LEAVE ROOM', rematch: 'REMATCH?', rematchOn: '✓ REMATCH ASKED', waitHost: 'WAITING FOR THE HOST TO PLAY AGAIN OR RETURN TO THE LOBBY…',
  votes: '{n} WANT A REMATCH', votes1: '1 WANTS A REMATCH',
  // the ☰ menu and the rotate prompt
  menu: 'MENU', resume: 'RESUME', soundOn: 'SOUND: ON', soundOff: 'SOUND: OFF', lang: 'LANGUAGE: EN', restart: 'RESTART', quit: 'QUIT TO MENU',
  rotate: 'ROTATE YOUR DEVICE', rotateSub: 'SUNDOWN SHOWDOWN PLAYS IN LANDSCAPE',
};

const zh = {
  'n.buck': '巴克', 'role.buck': '霰弹枪手', 'atk.buck': '霰弹:一次喷出 5 颗弹丸,贴脸最狠。', 'sup.buck': '超级技:巨炮,9 颗弹丸,把人轰退、把箱子轰碎。', 'pas.buck': '贴脸:3 米之内伤害 +15%。',
  'n.viper': '毒蛇', 'role.viper': '神枪手', 'atk.viper': '远射:一发又快又远的独头弹。', 'sup.viper': '超级技:轨道炮,一发巨弹穿过路上所有敌人和箱子。', 'pas.viper': '稳瞄:站定 1 秒,下一枪伤害 +20%。',
  'n.boomer': '爆破手', 'role.boomer': '投弹手', 'atk.boomer': '抛雷:越过墙壁,落地炸一片。', 'sup.boomer': '超级技:地毯轰炸,6 颗炸弹一齐落下。', 'pas.boomer': '余震:炸弹把人炸飞得更远(+50%)。',
  'n.brick': '砖头', 'role.brick': '近战坦克', 'atk.brick': '抡锤:大范围近身横扫,装弹快。', 'sup.brick': '超级技:蛮牛冲锋,撞穿箱子,一路撞飞所有人。', 'pas.brick': '硬骨头:血量低于 40% 时少受 25% 伤害。',
  'n.frost': '冰霜', 'role.frost': '冰法师', 'atk.frost': '冰锥:一发冰锥,打中就减速。', 'sup.frost': '超级技:极寒,抛出冰爆,把范围里的人全冻住。', 'pas.frost': '寒气:打被减速的敌人伤害 +15%。',
  'n.shade': '影子', 'role.shade': '刺客', 'atk.shade': '飞刀:三把快刀,射程短。', 'sup.shade': '超级技:遁形,隐身加速 4 秒,出手或挨打就现形。', 'pas.shade': '背刺:隐身或草丛里打出的第一击伤害 +40%。',
  'n.blaze': '烈焰', 'role.blaze': '喷火兵', 'atk.blaze': '喷火:一小片火焰,烧着的人持续掉血。', 'sup.blaze': '超级技:火圈,在瞄准处烧出一片火海,持续 5 秒。', 'pas.blaze': '耐热:不会着火,毒圈伤害 -20%。',
  'n.hook': '铁钩', 'role.hook': '擒拿手', 'atk.hook': '铁链:一鞭穿过路上所有人。', 'sup.hook': '超级技:钩索,把钩中的人拖到脚下并眩晕。', 'pas.hook': '铁锚:被击退的距离减半。',
  'n.dash': '闪电', 'role.dash': '快枪手', 'atk.dash': '双枪:并排两发快弹。', 'sup.dash': '超级技:翻滚,从人身边滚过去,子弹全部装满。', 'pas.dash': '肾上腺素:击杀后加速 3 秒。',
  'n.sparky': '火花', 'role.sparky': '工程师', 'atk.sparky': '电弩:一发稳稳的电矢。', 'sup.sparky': '超级技:炮台,放下一座替你开火的炮台,撑 15 秒或被打爆为止。', 'pas.sparky': '废料:每捡一个能量块,超级技充能 25%。',
  'n.rico': '跳弹', 'role.rico': '花式枪手', 'atk.rico': '跳弹:子弹撞墙反弹一次。', 'sup.rico': '超级技:弹幕,7 发子弹,各能反弹三次。', 'pas.rico': '花式:每反弹一次伤害 +25%。',
  passive: '被动', turret: '炮台',
  'st.hp': '血量', 'st.range': '射程', 'st.dmg': '伤害', 'st.speed': '移速', 'st.reload': '装弹',
  title: '日落大乱斗', pickYours: '选你的英雄', lockIn: '锁定', lockedIn: '已锁定', play: '开打', pstat: '{ok}/{n} 已锁定', pstatT: '{ok}/{n} 已锁定 · {s} 秒后开打',
  left: '人存活', day: '☀ 白天', sunset: '🌇 日落', dusk: '🌆 黄昏', night: '🌙 夜晚', gasBanner: '☣ 毒圈正在缩小! ☣',
  gasIn: '☣ {s} 秒后缩圈', gasClosing: '☣ 正在缩圈', gasFinal: '☣ 最终圈', safeDist: '安全区 {d} 米', safeEdge: '毒圈边缘',
  brawl: '开打!', super: '超级技!', supRelease: '松开<br>发射', supReady: '超级技!<br><small>按住空格</small>', supPct: '超级技<br><small>{n}%</small>',
  gasKill: '☣ 毒圈', watching: '☠ 第 {r} 名 · 正在观战 {name}', watchKeys: '◀ A · D ▶', dragMove: '拖动移动', fire: '开火', superBtn: '超级技',
  keys: '<kbd>WASD</kbd> 移动 <kbd>鼠标</kbd> 瞄准 <kbd>点击</kbd> 射击 <kbd>空格</kbd> 按住瞄准超级技,松开发射 <kbd>M</kbd> 声音 <kbd>ESC</kbd> {esc}', kMenu: '菜单', kLobby: '回大厅',
  victory: '大获全胜!', defeated: '被淘汰', over: '乱斗结束', rankOf: '第 {r} 名 / 共 {n} 人', wins: '{name} 赢了', thBrawler: '英雄', thDamage: '伤害',
  playAgain: '再来一局', menuBtn: '菜单', toLobby: '回大厅', leave: '离开房间', rematch: '再来一局?', rematchOn: '✓ 已申请再来', waitHost: '等房主决定再来一局或回大厅…',
  votes: '{n} 人想再来一局', votes1: '1 人想再来一局',
  menu: '菜单', resume: '继续', soundOn: '声音:开', soundOff: '声音:关', lang: '语言:中文', restart: '重来', quit: '退出到菜单',
  rotate: '请把设备横过来', rotateSub: '日落大乱斗要横屏玩',
};

export const STR = { zh, en };
