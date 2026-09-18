# Loaded Dice:更好玩、更花哨

日期 2026-09-18。范围:`client/games/dice/`、`client/games/registry.js` 里的 dice 条目、`test/dice-*.test.mjs`、README 的 Loaded Dice 部分。

## 状态

五个阶段都已实现(未 commit)。和下文设计的出入:

- 刻面卡在发牌时就带着面号(「吸血面 · 3 点」),没有做第二步的面号轮选;对战里赢家拿到的卡如果面号已被自己刻过,自动换成下一个空面。
- 反击需要掷出命中点数才成立(掷不到算失手,同样眩晕),不是无条件。
- 双按回合固定用静止的 bar,两趟都是从左到右;对战里双方同时进入双按回合,某一方的 bar 只有一个可按的格子时那一方退回单按。
- 假格子宽 0.11,只放在够宽的空白里,实际出现率比 25% 低(约一成多)。
- 提示条不含「手气」:手气回合的横幅副标题已经说明了效果。
- 敌人招数在「标准」档从第 1 关就有(不然第一圈的格拉布和南瓜杰克永远用不上),经典档没有。
- 头彩在拼刀中必胜(否则 D4 上两个顶面打平,头彩被抵消)。

## 决定

- 方向:bar 玩法 + 深度/构筑(不是纯特效,也不做 3 人以上)。
- 界面默认中文,☰ 菜单里可切英文,记在 `localStorage.loadedDiceLang`;只管 Loaded Dice,不碰 shell 和其他游戏。大厅里的标题保留 `Loaded Dice`,tagline 和选项标签用固定中文。
- 单人和对战共用一套规则:先把单人的判定并进 `rules.js`,之后每个机制只写一遍、可在 node 里测。
- 新机制逐步解锁,大厅加一个「花样」选项:经典(现在的规则)/ 标准(按局解锁)/ 疯狂(全开)。
- 路线:规则内核数据化,新内容放新文件,`index.js` 不拆。分 5 阶段,每阶段可玩、`npm test` 通过。

## 阶段

| 阶段 | 内容 | 主要改动 |
|---|---|---|
| 0 | 统一规则 + 中文/语言开关(玩法不变) | `rules.js`、`foes.js`、`strings.js`、`index.js`、`registry.js`、测试 |
| 1 | JACKPOT、炸弹、FEVER 槽 | `rules.js`、骰子/bar 绘制、双骰 |
| 2 | 动态 bar(u 判定)、雾、假格子、「花样」选项和逐步解锁 | `bar.js`、线上 `pos`→`u`、`registry.js` |
| 3 | 新动作(偷血/反击/毒)、灌铅刻面、对战局间选面 | `rules.js`、`faces.js`、骰面绘制、`draft` 消息 |
| 4 | 敌人专属招、Boss 二阶段、双按回合 | `foes.js`、`resolveDuel` 每边多动作 |

## 1. 规则内核(阶段 0)

```js
mkMods()                          // { perfW, slotW, minRoll, rigPlus, critCh, comboLuck, cool, maxSpeed, thorns, vamp, heavy, big6, toHit, fastSelf }
mkDuelist(hearts, mods?)          // 决斗者 = 血、combo、速度、眩晕 + 一组修饰参数
genSlots(rnd, f, round, hint?)    // hint: 权重覆盖(单人按敌人意图调盾/骷髅的权重)
gradePress(slots, pos, perfW?)
rollFor(rnd, f, die, slots, pick) // pick 可以直接带 { act, bonus }:AI 出招不经过 bar
resolveDuel(A, B)                 // say: [[key, tone]],key 由各屏幕翻译
playRound(rnd, fs, die, slots, picks)
```

- 单人的 12 个 perk 改成对英雄 `mods` 的修改;THORNS / VAMPIRE / HEAVY HAND / WEIGHTED / SHAVED EDGES 的效果由 `rollFor` 和 `resolveDuel` 从 `mods` 读。
- 敌人是一个 `ai: true` 的决斗者,`foes.js` 的 `foeIntent` / `foePick` 决定它出什么:attack→`sword`、block→`shield`、dodge→`dodge`(新动作:掷点不低于对方的攻击则闪开,暴击闪不掉,只在敌人出招池里)、眩晕→`stun`(空过一回合)。敌人的 combo 每 3 点给掷点 +1,成功(命中、格挡、闪避)+1,挨打清零。
- 单人保留的差异都写成 mods:敌人 `big6: false`(6+ 不加伤)、`heavy: tier ? 1 : 0`、各自的 `toHit`;英雄 `fastSelf: true`(>> 加速自己的 bar 换分数)、`maxSpeed: 3.6`、`comboLuck: 0`。
- 一处行为变化:敌人的顶面格挡现在也会招架(和对战一致),以前玩家的暴击必定破防。
- 分数和 XP 留在 `index.js`,从 `playRound` 的结果算。单人的随机数换成带种子的 `makeRng`,特效抖动仍用 `Math.random`。

### 中文

- `strings.js`:`STR = { zh: {...}, en: {...} }`,`mkT(lang)` 返回 `t(key, vars)`,支持 `{n}` 插值;缺 key 时退回英文再退回 key 本身。
- 线上只传 key,两台机器可以一中一英。
- `txt()` 在中文下:字距归零,小于 12px 的字放大 1.25 倍(封顶 13px);字体栈追加 PingFang SC / Hiragino Sans GB / Noto Sans SC / Microsoft YaHei。perk 卡的描述按宽度断行。
- 名字:罗洛爵士、哥布林格拉布、南瓜杰克、乌鸦柯黛莉亚、独眼奥尔加、波兹二型、蛤蟆王。

## 2. 机制(阶段 1–4)

数值是初值,都是 `rules.js` 顶部的常量。

**JACKPOT / 炸弹**:`jackpot` 宽度 ×0.35,按中算攻击、rig +3、必暴击;`bomb` 宽度 ×0.7,按中自损半心、combo 清零、本回合不出招。每回合 18% 出 JACKPOT,其中 70% 一侧紧贴一个炸弹(间距 0.01);无 JACKPOT 时 8% 单出炸弹。每条 bar 最多 4 格。

**FEVER**:槽 6。PERFECT +2、GOOD +1、暴击 +1、MISSED −2。满槽的下一回合:掷两颗取高、PERFECT 区加倍、造成的伤害 +1,回合后清零。演出:暖色背景、金边 bar、火星、音效升八度、横幅「手气爆棚」。

**动态 bar**:进度 `u ∈ [0, U]`,光标和格子都是 u 的纯函数。`still`;`bounce`(U=2,光标 `1-|1-u|`,回程格宽 ×0.8);`slide`(`x + a·sin(2πu+φ)`,a ≤ 0.06,生成时保证不重叠不越界);`shrink`(`w·(1-0.45u)`,中心不变)。`gradePress(bar, u, f)` 先 `slotsAt(bar, u)` 再判定;`pick` 消息 `{n, pos}` → `{n, u}`;主机超时 `SWEEP_T·U/speed + 2500ms`。

**雾 / 假格子**:新动作 `smoke`,掷点 ≥3 则对方下回合 `bar.fog = [x0, x1]`(宽 0.35),雾里的格子只在光标距离 < 0.07 时显形。假格子只在对战:主机写进发给对手的 `round` 里(两人房的 `send` 只到对方一台;服务器也支持 `msg.to`),主机自己看到的对手小 bar 在本地混入,25% 概率,只影响读牌。

**新动作**:`leech`(攻击,伤害 −1 最少 1,命中回 1);`counter`(对方攻击命中则无视并反弹其伤害,否则空转且自己下回合眩晕);`poison`(掷点 ≥3,3 回合每回合开始掉 1,不叠层只刷新)。克制:剑 > 毒/偷血/骷髅;盾 > 剑/偷血;骷髅 > 盾/反击;反击 > 剑/偷血;毒和雾无视盾。

**灌铅刻面**:`mods.faces = { [面号]: kind }`,停在该面且动作落地时触发:`vamp` 回 1、`double` 伤害或治疗 ×2、`guard` 本回合受伤 −1、`venom` 附带施毒、`lucky` FEVER +3。最多 3 面,不能刻 1 和顶面,骰子变大时保留。`drawDie` 在刻面上画小图标和彩色描边。单人:升级三选一里混入刻面卡,再一键轮选面号。对战:每局后输家先 3 选 1、赢家从剩下 2 选 1,消息 `draft` / `drafted`,每人 8 秒,超时随机。

**敌人招数**(`foes.js` 的 `trick(state) → { barMod?, extraAct?, dmgMul? }`,引擎里不出现敌人的名字):(2026-09-19 起梯子换成 8 个立绘角色)咧嘴雏菊每 3 回合连出两次攻击;墨团放雾;柯黛莉亚偷走最宽的格子;叶熊莫斯蓄力一回合后伤害 ×2,被骷髅吓到会打断;木偶诺克把 bar 变成 slide/bounce;无脸笑客让格子没脸(`blank`:按下前看不出是什么,金格和炸弹除外,只改显示不改判定);霜兜帽莱姆把 bar 变成 shrink;公羊男爵半血二阶段骰子升一档,之后每 4 回合吞掉你的骰子一回合(只能 D4 PLAIN ROLL)。

**双按回合**:第 3 局 / 第 7 关起 12% 概率,`bar.presses = 2`,U=2,每趟按一次,第一趟按过的格子第二趟变灰。`resolveDuel(A[], B[])` 按顺序配对(A1↔B1、A2↔B2,对方只有一个动作时 A2 对 B1 的残余状态),每个动作各掷一颗。`pick` → `{n, us: [u1, u2]}`。

**解锁**:`registry.js` 加 `{ key: 'spice', label: '花样', default: 'std' }`。经典 = 现在的 7 种格子、`still`、无 FEVER 无刻面;标准 = 第 1 局 JACKPOT/炸弹/FEVER,第 2 局 动态 bar/新动作/刻面,第 3 局 雾/假格子/双按;疯狂 = 全开且变体概率 ×1.6。单人用「标准」,按关卡 1/3/5 解锁。每样第一次出现时横幅一句话说明。

## 3. 协议、容错、测试、演出

**协议**
- 每条消息继续带 `m`(本场种子),旧场的迟到消息照旧被丢掉。新增的 `draft` / `drafted` 也带。
- `round` 增加 `bar`(变体、fog、presses)、`fever`、`poison`、`faces`;`result` 增加每边的动作数组和触发的刻面。对战双方版本不一致不考虑(同一台服务器发同一份代码)。
- 客户端发来的 `u` / `us` 一律过 `cleanPick`:非有限数、越界、数组长度不对、回合号不对都丢弃,按超时处理(plain roll)。第二次按在同一格 → 第二个动作算 MISSED。
- `draft` 阶段一方掉线:`playerLeft` 照旧判对方弃权。标签页隐藏时主机的 worker ticker 继续推进 draft 的超时。

**容错**
- `localStorage` 读写都包 try/catch(隐私模式);读不到语言就是中文。
- `strings.js` 缺 key 不抛错,显示英文或 key。
- `slide` 生成失败(塞不下)退回 `still`。

**测试**(`node --test`)
- `dice-rules`:现有用例改成断言 key;`spice: 'classic'` 下 500 条 bar 只含原来的 7 种格子;每种新格子/动作的克制表正反两个座位对称;FEVER 槽的加减和两骰取高;毒的回合数;刻面触发条件。
- `dice-bar`:四种变体下 `slotsAt` 对所有 u 不重叠不越界;`gradePress` 在 u 和 2−u(bounce 回程)的一致性;fog 不影响判定只影响显示。
- `dice-solo`:固定种子的一整局单人(AI 瞄准)能结束、同种子同结果;每个 perk 改到了它该改的 mod;敌人招数按回合触发。
- `dice-strings`:zh 和 en 的 key 集合一致,`rules.js` 能喊出的每个 key 两张表里都有。
- 整场对战的无头测试保留,三个「花样」档各跑一遍。

**演出**(跟着各阶段一起做,不单列阶段)
- JACKPOT:金格闪烁,命中时全屏金色闪一下、骰子落地冲击波加大、`SFX.jackpot`(上行琶音)。炸弹:引线火花粒子,按中时黑烟 burst + 屏震 + `SFX.boom`。
- FEVER:见上;两颗骰子同时落地,取高的那颗放大、另一颗淡出。
- 动态 bar:bounce 到头时光标回弹的挤压;shrink 的格子边缘虚线。雾:墨迹遮罩,光标靠近时晕开。
- 刻面:触发时该面图标飞向目标(回血飞向红心,毒飞向对方)。中毒的人头顶冒绿泡、红心发绿。
- PERFECT 连击音高逐级上升(每连一个 +1 个半音,封顶一个八度)。
