/* Sundown Showdown - every word the game shows, in Chinese (the default) and English. The wire carries codes and numbers only;
   each screen reads them here in its own language. `{n}` in a string is filled from the vars; a key missing from a table falls
   back to English, then to the key itself. Player and CPU names are names and stay as they are. No DOM: node checks the two
   tables against each other (test/strings.test.mjs). */
const en = {
  // the brawlers: name, role, attack, super (keyed by the class id in sim.js)
  'n.buck': 'BUCK', 'role.buck': 'Shotgunner', 'atk.buck': 'Buckshot: a cone of 5 pellets. Brutal up close.', 'sup.buck': 'SUPER: Mega Blast, 9 pellets that shove foes back and smash crates.',
  'n.viper': 'VIPER', 'role.viper': 'Sharpshooter', 'atk.viper': 'Long Shot: one fast, long-range slug.', 'sup.viper': 'SUPER: Railshot, a huge slug through every foe and crate in its way.',
  'n.boomer': 'BOOMER', 'role.boomer': 'Bomb Lobber', 'atk.boomer': 'Lob Bomb: arcs over walls, explodes in an area.', 'sup.boomer': 'SUPER: Carpet Bomb, a cluster of 6 bombs rains down.',
  'n.brick': 'BRICK', 'role.brick': 'Melee Tank', 'atk.brick': 'Hammer Swing: a wide melee arc. Fast reload.', 'sup.brick': 'SUPER: Bull Rush, charge through crates, slamming everyone in the way.',
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
  'n.buck': '巴克', 'role.buck': '霰弹枪手', 'atk.buck': '霰弹:一次喷出 5 颗弹丸,贴脸最狠。', 'sup.buck': '超级技:巨炮,9 颗弹丸,把人轰退、把箱子轰碎。',
  'n.viper': '毒蛇', 'role.viper': '神枪手', 'atk.viper': '远射:一发又快又远的独头弹。', 'sup.viper': '超级技:轨道炮,一发巨弹穿过路上所有敌人和箱子。',
  'n.boomer': '爆破手', 'role.boomer': '投弹手', 'atk.boomer': '抛雷:越过墙壁,落地炸一片。', 'sup.boomer': '超级技:地毯轰炸,6 颗炸弹一齐落下。',
  'n.brick': '砖头', 'role.brick': '近战坦克', 'atk.brick': '抡锤:大范围近身横扫,装弹快。', 'sup.brick': '超级技:蛮牛冲锋,撞穿箱子,一路撞飞所有人。',
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
