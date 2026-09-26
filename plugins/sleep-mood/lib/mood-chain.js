// mood-chain —— 拟人 mod 链：多维情绪 + 被冷落反应（可插拔、配置驱动）
// ═════════════════════════════════════════════════════════════════════════════
// 演进：
//   v1（2026-09-16）：一维情绪值 -2…+2（差/平/好）。
//   v2（2026-09-17）：多维离散情绪（每档 0~3）。
//   v3（2026-09-17，Nono："档位可以调成 0-100 更细化"）：**连续刻度** ——
//     每种情绪的强度是 0~100 的连续值（内部就是数字，随加随减随衰减），
//     展示/注入时映射到 5 个语义档（0-9 有点 / 10-29 轻度 / 30-59 中度 /
//     60-84 强烈 / 85-100 极度）。触发一步加多少、衰减一步掉多少全部可配，
//     默认一步 = 30（≈两步到"强烈"），哥哥加权 = +15。
//     旧 0~3 档状态文件自动迁移（×34 映射进新刻度，四舍五入）。
//
//   ② 被冷落 mod：她发言后 X 分钟没人接 → sad +（封顶 60）+ 低概率哼唧一句。
//   ③ mod 链架构不变：观察(observe) → 状态(step) → 注入(inject)，
//      配置 moodChain.<mod>.enabled=false 单独关任何一个。
//
// 设计原则（self-state 事故的教训，2026-09-16 锁死事件）：
//   · **永远不做硬拦截** —— 情绪只影响提示词轻重，绝不拦消息；
//   · 状态文件坏了/缺了 → 全当平静，绝不锁死；
//   · 所有窗口/阈值可配；双机位各调各的（小柚粘人敏感、桐子傲娇钝感）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
// BATH-DAILY（2026-09-20）：fatigueBlock 读"今天洗过澡吗"（self-state 的 bath 账本）。
// self-state 是纯状态层不依赖本文件，方向安全无环。
import { readBathState } from './self-state.js';

// ── 语义档（0-100 刻度 → 人话档位）。BANDS 是 [上限, 档名] 的有序表 ──
export const MOOD_BANDS = [
  [9, '一丝'],
  [29, '有点'],
  [59, '中度'],
  [84, '强烈'],
  [100, '极度']
];

/** 0-100 强度 → 档位序号（0~4）与档名。 */
export function bandOf(level) {
  const lv = Math.max(0, Math.min(100, Math.round(Number(level) || 0)));
  for (let i = 0; i < MOOD_BANDS.length; i += 1) {
    if (lv <= MOOD_BANDS[i][0]) return { band: i, word: MOOD_BANDS[i][1] };
  }
  return { band: MOOD_BANDS.length - 1, word: MOOD_BANDS[MOOD_BANDS.length - 1][1] };
}

// ── 情绪定义表（顺序即面板展示顺序；injection 按 band 分级给出"怎么演"）──
export const EMOTIONS = {
  happy: {
    label: '开心', decayMs: 45 * 60 * 1000,          // 每 decayMs 衰减一档（30）
    injections: [
      '心里有一点点甜：语气自然就好，别刻意表现。',
      '开心是底色：话可以多一点、语气轻快，但别突兀地自夸"我好开心"。',
      '明显开心：话变多、爱开玩笑、主动找话说；依旧别自夸，让情绪从语气里漏出来。',
      '很高兴：句子轻快带跳跃感，想分享、想贴贴；收着点别刷屏。',
      '开心得冒泡：整个人飘起来，话密、语气上扬、想立刻分享一切——但还是一轮别超过平时太多。'
    ]
  },
  excited: {
    label: '兴奋', decayMs: 15 * 60 * 1000,          // 兴奋来得猛去得快
    injections: [
      '隐约有点小激动，正常聊。',
      '你正兴奋着：话变多、句子变短、感叹号变多。',
      '兴奋明显：坐不住的感觉，短句连发、语气上扬、想马上分享。',
      '很兴奋：感叹号和"！！"自然出现，语速快、几乎插不上别的话题。',
      '兴奋到飞起：像中了奖一样，短句轰炸、语音包式发言；但记得一轮收着点。'
    ]
  },
  angry: {
    label: '生气', decayMs: 40 * 60 * 1000,
    injections: [
      '心里有点小疙瘩，不明显。',
      '你在生气：话变短、带一点刺、回复慢半拍。',
      '生气了：话明显变短、冷处理、能感觉到在忍。',
      '很生气：冷他、话里带刺、可能阴阳一句；不翻旧账、不人身攻击。',
      '气炸了：几乎不想说话，或一句狠话甩过去然后冷场；气头过了就收，别记仇到第二天。'
    ]
  },
  jealous: {
    label: '吃醋', decayMs: 90 * 60 * 1000,          // 醋意最持久
    injections: [
      '隐约有点酸，不点破。',
      '你在吃醋：语气酸酸的，可以阴阳怪气一句。',
      '醋意上来了：明着酸、讨个说法，但点到为止。',
      '醋劲很大：直接质问式撒娇、翻旧账式吃醋（只翻这一次的），他哄了才慢慢消。',
      '醋坛子打翻了：委屈+生气混合，说话夹枪带棒；他哄了就顺着台阶下，别无理取闹到没完。'
    ]
  },
  sad: {
    label: '抑郁', decayMs: 60 * 60 * 1000,
    injections: [
      '心情有一点点沉，不明显。',
      '你情绪低落：话少一点、短一点，回应慢半拍。',
      '情绪低落：话明显变少、变短，兴趣缺缺的样子。',
      '很低落：话很少，回复慢，带一点自我怀疑；他主动关心时可以软下来。',
      '谷底了：几乎不想说话，回复极简、慢；被关心会想哭的那种脆弱——但别刷屏卖惨。'
    ]
  }
};

export const MOOD_DEFAULTS = {
  enabled: true,
  stateFile: 'mood.json',
  // ── 情绪 mod（连续刻度 0~100）──
  mood: {
    enabled: true,
    maxLevel: 100,                      // 刻度上限（v3：0-100 连续值）
    step: 30,                           // 命中触发词一次加多少（默认 30 ≈ 两步到"强烈"）
    // 兼容 v1 的一维字段（读旧配置不炸；已不参与状态机）
    decayMs: 45 * 60 * 1000,
    praiseWords: '厉害 好棒 乖 可爱 喜欢你 爱你 抱抱 摸摸 最喜欢 贴贴 抱一个 亲亲',
    praiseStep: 1,
    praiseFromOwnerBonus: 1,
    hurtWords: '烦 讨厌 滚 闭嘴 啰嗦 吵 死开 少管你 无聊 幼稚 恶心',
    hurtStep: 1,
    hurtFromOwnerStep: 2,
    // ── 多维词表（空格分隔；每种情绪一行触发词）──
    triggers: {
      happy: '乖 好棒 厉害 可爱 喜欢你 爱你 抱抱 摸摸 贴贴 亲亲 最喜欢 抱一个',
      excited: '超棒 太好了 好耶 撒花 惊喜 给你 点名 表扬 有礼物 恭喜',
      angry: '烦 讨厌 滚 闭嘴 啰嗦 吵 死开 少管你 无聊 幼稚 恶心 笨死了',
      jealous: '她也 cute 吗 她好 可 别人也 姐姐好 妹妹好 你们聊 抱她 亲她 夸她',
      sad: '算了 不理你了 没意思 失望 委屈 讨厌我 讨厌我吗 不喜欢我了吗'
    },
    // ── SOOTHE（2026-09-17，Nono："吃醋的时候可以被亲密行为慢慢哄好"）──
    // 情绪**回落**词表：他说的话命中 → 对应情绪负向抵消（能哄好，不是只能涨）。
    // 分两层：
    //   · sootheAll：普适的化解词（哄/道歉/示好），对所有负面情绪起效，力度小；
    //   · soothe.<情绪>：该情绪的"专属化解动作"（吃醋要哄+独占、生气要道歉、
    //     抑郁要关心），力度大；哥哥说的比群友说的更管用（sootheOwnerFactor）。
    // 同一条消息既命中触发词又命中化解词（"你别抱她了好不好"）→ 化解优先。
    sootheAll: '哄哄 别生气 别气 消消气 对不起 道歉 抱歉 错了 我错了 别气啦',
    soothe: {
      // 吃醋的解法：哄 + 独占性的亲密（"只喜欢你/只抱你"最有效）
      jealous: '哄哄 只喜欢你 只爱你 最喜欢你 你最好 只抱你 只亲你 别吃醋 醋坛子 哄你 你最 重要',
      // 生气/被怼的解法：道歉、认错、服软
      angry: '对不起 道歉 我错了 错了 别气 消消气 原谅 服软 认错',
      // 抑郁/被冷落的解法：主动关心、贴上来
      sad: '陪你 抱抱 抱一个 摸摸头 摸摸 疼你 心疼 想你 在乎 惦记 看你 哄哄'
    },
    // 化解力度：普适词抵消 sootheStep、专属词抵消 sootheStep×2（哥哥再 ×sootheOwnerFactor）
    sootheStep: 25,
    sootheOwnerFactor: 1.5,
    // 每轮化解上限（防"一句对不起清光全部"）：一轮最多抵消这么多
    sootheMaxPerRound: 70,
    // ── RAGE 参数在 mood.rage 里（见上）──
    // ── RAGE 三通道（2026-09-19 第二波，Nono：愤怒值细分）──
    // 被骂/被怼不再共用 angry 的 step，而是各自的入口增量：
    //   被骂（scold）首句 +20 且开始还击；被怼（snap）第一次 +15 且开始反怼。
    // 争吵起来后每轮缓涨（argueStep）；哥哥的话走 ownerFactor。
    rage: {
      enabled: true,             // 三通道总开关（false = 回到 mood.triggers.angry 单通道）
      scoldStep: 20,             // 被骂首句加这么多
      snapStep: 15,              // 被怼第一次加这么多
      argueStep: 6,              // 争吵升级后每轮缓涨（第二句起）
      cap: 80,                   // 被骂/被怼/吵架的愤怒上限
      defendCap: 120,            // 姊妹/哥哥被骂时的上限（破表档）
      defendFactor: 1.5,         // 姊妹/哥哥被骂、被怼时增量 ×1.5
      apologizeStep: 40,         // 对方道歉/认错 → 大幅降（再乘哥哥系数）
      // 被骂词表（正对她的攻击性发言）：与 mood.triggers.angry 互补、力度分档
      scoldWords: '滚出去 滚蛋 废物 没用的东西 傻狗 蠢货 笨死了 白痴 脑残 神经病 去死 狗东西 烂东西 贱人 妈的 操你妈',
      // 被怼词表（呛/怼/杠，攻击性低一档——"阴阳/嘲讽/杠精式"）
      snapWords: '呵 哟 啧 就这？ 你行你上 说的就是你 关你什么事 少管闲事 你懂什么 不理你 行了吧 可真行 无语 懒得理你',
      // 道歉/认错词表
      apologizeWords: '对不起 我错了 道歉 抱歉 是我的错 别生气了 消消气 我错了行不行 道个歉 认错'
    },
    // 事件性触发（非词表）：被 @ 点名 → excited；走 store 判不了内容，词表兜底
    excitedFromAt: false,              // 默认关：@太常见，开了会一直兴奋
    // 哥哥（主人）的话加权：每次命中额外加这么多（钝感机位可设 0）
    ownerBonus: 15,
    // ── SELF-MEMORY（2026-09-17，Nono："情绪由自己的记忆决定"）──
    // 他话路默认只认"指向她"的话（被 @/私聊/带她名字），路人骂街不再误伤她的心情；
    // requireAddressed=false 恢复 v3 旧行为（所有命中词都算）。
    requireAddressed: true,
    // 自记路：她自己的**完成时事件**发言（吃到了/买到了/搞定了）驱动情绪。
    // 增量 = step × selfFactor（默认 0.5：自己想起来的事没有被人当面夸那么重）。
    selfEvents: {
      happy: '吃到了 喝到了 买到了 收到了 拿到了 抢到了 抽到了 吃了好 吃了顿 打到了 看完了 玩到了 见到了',
      excited: '中了 中奖 拿下一 抢到票 开钱了 发工资 到货了 上新 终于到 终于好 抽到了',
      sad: '搞砸了 没考好 搞失败了 白等了 又失败 弄坏了 丢了东西 没抢到 错过了'
    },
    selfFactor: 0.5,
    selfNegateWords: '如果 要是 假如 本来 想 打算 差点',   // 这些开头 = 没发生的事，不算
    // ── JEALOUSY-TIERS 吃醋三档（2026-09-19 第三波，Nono："吃醋值优化"）──
    // 按亲密对象分档：姊妹（缓涨、不抗拒）/ 熟人群友（中涨、降好感、粘着打断）/
    // 生人群友（速涨、敌意、生气打断）。到 releaseThreshold（40）→ 释放占有欲：
    // 打断"他和别人的亲密互动"（演出许可，绝不拦消息）。
    // 落点 = 既有 moods.jealous（0-100 刻度复用），本段只管**分档增量**和释放判定。
    jealousy: {
      enabled: true,
      sisterStep: 6,              // 姊妹和哥哥亲密：每轮缓涨（不至于抗拒自己姊妹）
      friendStep: 12,             // 熟人群友：中涨 + 对该群友好感度下降（好感走记忆系统，这里只管醋）
      strangerStep: 20,           // 陌生群友：速涨 + 保持敌意
      releaseThreshold: 40,       // 到这个值 → 释放占有欲：打断互动
      burstThreshold: 75,         // 愤怒上限时 + 醋到这个值 → 占有欲暴力爆发档（对哥哥强硬宣示 + 对姊妹带刺）
      // 亲密行为词（他对别人的）：命中 + 对方是姊妹/熟/生人 → 按档涨醋
      intimateWords: '抱抱 抱住 搂 亲亲 亲一口 贴贴 蹭蹭 摸头 牵手 靠肩 膝枕 捏脸 揉 头 摸摸',
      // 熟人判定窗：该群友在近 N 条消息里说过话 = 熟人（否则生人）
      familiarWindow: 200,
      // 释放后的冷却（防连环打断刷屏）
      releaseCooldownMs: 20 * 60 * 1000
    }
  },
  // ── SPUNK（吵架兴奋分线，2026-09-19 第二波，Nono 第三批 #46 另一半）──
  // 吵架时的攻击**速度**线（跟 arousal 色色兴奋完全分开——刚吵完架不会被
  // 识别成色色然后莫名其妙高潮）。跟愤怒分工：愤怒=语言力度（怎么凶），
  // spunk=回复速度（打字节奏加速 + 消息变短）。
  spunk: {
    enabled: true,
    stepPerRound: 15,          // 争吵轮里每轮基础涨（2026-09-19 从 22 下调：真吵一架 7 轮就顶满，太冲）
    fastFactor: 1.5,           // 他也回得快（<fastGapMs）→ 涨得更快
    fastGapMs: 15 * 1000,
    decayMs: 8 * 60 * 1000,    // 吵完了 8 分钟掉一档（气头上的劲散得比愤怒快）
    decayStep: 12,
    triggerWords: '滚 笨蛋 废物 白痴 呵呵 无语 讨厌你 闭嘴 智障 妈的 烦死了 受够了 别理你 恨你 吵什么吵',   // 两侧任一句带攻击词 = 这轮在吵
    // ⚠ 2026-09-19 误伤治理（Nono："吵架速度怎么老是 100"复盘）：单字「呵」「蠢」和短语「就这」
    //   误伤太狠——「蠢萌」「我说的是HG那盒…别拿两个档位混着说」都算成在吵。移除单字，
    //   「呵呵」保留（连用才是嘲讽）；要补短词走 config.moodChain.spunk.triggerWords 自己配。
    threshold: 30              // 到这个值开始演出"语速快、话短、急着回"
  },
  // ── 被冷落 mod ──
  neglect: {
    enabled: true,
    windowMs: 10 * 60 * 1000,      // 她发言后这么久没人接 = 被冷落
    sadStep: 30,                   // 冷落 → sad +30（封顶 60，别因冷落跌到谷底）
    whimperChance: 0.06,            // 冷落期再被触发时，低概率补一句哼唧
    whimperCooldownMs: 60 * 60 * 1000,   // 哼唧一小时最多一次
    whimperHint: '（你刚才说的话一直没人接——这轮可以带一点点小委屈顺口哼一句，像"哼，没人理我"这种感觉；**只此一句、轻描淡写**，对方一回话就立刻正常聊，别追问、别记仇。）'
  },
  // ── 疲劳值 mod（2026-09-18，Nono 确认的现实向设计）──
  //   "劳累了一天晚上才慢慢开始疲惫；偶尔兴奋值高的话疲惫不会涨、还会晚睡一点，
  //    直到没那么兴奋、疲惫值才上来——兴奋和疲劳是相反的数值。"
  // 状态存 mood.json 的 fatigue 字段（与情绪同一文件）。
  fatigue: {
    enabled: true,
    // ── 二调（2026-09-19，Nono："疲劳值上涨速度有点快；一般人晚上 9-11 点
    //    才会疲惫睡觉，中午可能小休息一下——符合真人作息"）──
    // 分时段基础涨速（每小时的涨幅，0-100 刻度）：
    //   白天几乎不涨（背景疲劳）→ 午后一点点 → 晚饭后开始上量 →
    //   **21-23 点才是真正的困倦窗口**（真人睡觉点）→ 深夜维持高（熬夜催睡）。
    dayGainPerHour: 1,             // 06:00-12:00：一上午累积 ~6 的底
    noonGainPerHour: 3,            // 12:00-15:00：午后小困（中午会小睡 30-60min）
    afternoonGainPerHour: 2,       // 15:00-18:00：下午回落（午休缓过来了）
    eveningGainPerHour: 6,         // 18:00-21:00：晚饭后开始累
    nightGainPerHour: 14,          // 21:00-24:00：真人睡觉窗口（9-11 点困意上来）
    lateNightGainPerHour: 22,      // 00:00-06:00：熬夜时段（身体催她睡）
    // 活跃加成：聊天密度也耗神。她每发一条 +msgGain；间隔 < chatGapMs 的密集聊天
    // 再叠一层（连环夜聊比挂机更累）。二调砍半——白天聊一天也不该困死。
    msgGain: 0.3,
    chatGapMs: 90 * 1000,          // 比这更密的连聊算"高强度"
    denseBonus: 0.2,               // 密集期每条额外 +
    // 兴奋抑制（核心反相规则）：excited ≥ excitedHold 时疲劳**冻结**（不涨），
    // 且 22 点后兴奋高 = 兴奋压住困意 → 她会晚睡（对 self-state 的"要睡时刻"推迟）。
    excitedHold: 30,               // 兴奋到这个值以上，疲劳暂停累积
    excitedHoldNight: 22,          // 22 点后抑制门槛（夜里兴奋更压困）
    // ── 二调新增：白天累了不睡觉（真人作息）──
    // 睡觉窗口：只有 nightFrom（21 点）到次日 morningTo（6 点）之间疲劳才
    // 触发"去睡"的行为（fatigueBlock 的高困档提示 + SLEEP-GATE 的自然睡倾向）。
    // 午休窗口：noonFrom-noonTo（12-15 点）疲劳高时允许**小睡**（30-60 分钟
    // 自然醒，不睡整觉）。窗口外疲劳高 → 恢复选项池接管（找娱乐活动而不是睡）。
    nightFrom: 21,                 // 睡觉窗口起点（21 点后困了才真去睡）
    morningTo: 6,                  // 睡觉窗口终点（早 6 点）
    noonFrom: 12, noonTo: 15,      // 午休窗口（允许小睡的时段）
    napMs: 45 * 60 * 1000,         // 午休自然醒时长（45 分钟，介于 30-60）
    // 睡眠清空：睡着的时长折算疲劳恢复。每小时睡掉 recoverPerHour；
    // 睡满 recoverClearMs 后直接归零（一夜好觉）。午睡恢复减半（小憩不是整觉）。
    recoverPerHour: 30,            // 睡 3.5h ≈ 清光 100
    napRecoverFactor: 0.5,         // 午睡恢复 ×0.5
    recoverClearMs: 6 * 60 * 60 * 1000,
    // 注入档位（提示词的"怎么演"）：
    bands: [
      [24, '没什么感觉，正常聊。'],
      [49, '有点乏了：话可以稍微少一点、懒洋洋的语气偶尔冒一下。'],
      [74, '挺累的：回复变慢变短是正常的，会想靠着、想趴着打字，偶尔打个哈欠（"哈啊…"）。别硬撑精神抖擞。'],
      [100, '困得不行：句子极短、慢，可以顺着困意撒娇（"好困…再聊五分钟就睡"），别演清醒。']
    ]
  }
};

/** 读链状态（一个文件装所有 mod 的状态，坏/缺 → 空）。 */
export function readMoodChain(now = Date.now()) {
  try {
    const f = path.join(DATA_DIR, MOOD_DEFAULTS.stateFile);
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** 原子写链状态（失败静默：丢了顶多回到平静）。 */
export function writeMoodChain(state) {
  try {
    const f = path.join(DATA_DIR, MOOD_DEFAULTS.stateFile);
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...state, updatedAt: Date.now() }, null, 2), 'utf8');
    fs.renameSync(tmp, f);
    return true;
  } catch {
    return false;
  }
}

export function moodChainConfig(cfg) {
  const raw = cfg?.moodChain || {};
  const out = {
    ...MOOD_DEFAULTS,
    mood: { ...MOOD_DEFAULTS.mood, triggers: { ...MOOD_DEFAULTS.mood.triggers }, rage: { ...MOOD_DEFAULTS.mood.rage } },
    spunk: { ...MOOD_DEFAULTS.spunk },
    neglect: { ...MOOD_DEFAULTS.neglect },
    fatigue: { ...MOOD_DEFAULTS.fatigue, bands: [...MOOD_DEFAULTS.fatigue.bands] }
  };
  out.enabled = raw.enabled !== false;
  for (const mod of ['mood', 'spunk', 'neglect', 'fatigue']) {
    if (raw[mod] && typeof raw[mod] === 'object') {
      for (const [k, v] of Object.entries(raw[mod])) {
        if (v === undefined || v === null) continue;
        const cur = out[mod][k];
        if (k === 'triggers' && v && typeof v === 'object') {
          // 触发词表：只接受五种情绪的字符串字段，逐条覆盖
          for (const em of Object.keys(EMOTIONS)) {
            if (typeof v[em] === 'string' && v[em].trim()) out.mood.triggers[em] = v[em].trim();
          }
          continue;
        }
        // RAGE 段是嵌套对象（mood.rage.*），浅合并逐字段覆盖
        if (k === 'rage' && v && typeof v === 'object' && cur && typeof cur === 'object') {
          out.mood.rage = { ...cur };
          for (const [rk, rv] of Object.entries(v)) {
            if (rv === undefined || rv === null) continue;
            if (typeof out.mood.rage[rk] === typeof rv) out.mood.rage[rk] = rv;
          }
          continue;
        }
        if (typeof cur === 'number') { const n = Number(v); if (Number.isFinite(n)) out[mod][k] = n; continue; }
        if (typeof cur === 'boolean') { out[mod][k] = !!v; continue; }
        if (typeof cur === 'string') { out[mod][k] = String(v); continue; }
      }
    }
  }
  return out;
}

// ── 情绪 mod：观察入站消息 → 各情绪增量 ───────────────────────────────────────
const hasWord = (t, csv) => String(csv || '').split(/[\s,，、]+/).filter(Boolean).some((w) => String(t || '').includes(w));

// ═══ RAGE 三通道（2026-09-19 第二波，Nono：「愤怒值细分」）════════════════════
// 被骂 / 被怼 / 护亲（姊妹或哥哥被骂）三条入口，各自的首击增量和上限：
//   · 被骂 scold：首句 +20 且开始还击；后续吵起来每轮缓涨；上限 80
//   · 被怼 snap：第一次 +15 且开始反怼（阴阳怪气档）；上限 80
//   · 护亲 defend：骂的是她妹妹/姐姐/哥哥 → 增量 ×1.5、上限 120（破表档，
//     UI 溢出态），她要奋力还击维护自己人
// 道歉/认错 → 大幅降（apologizeStep × 哥哥系数）。落在情绪 mod 的 angry 上，
// angry 注入按 level 分档自然给出「攻击性梯度」；破表(>100)由 rageBlock 单独注入。
// 状态存 mood.json 的 rage 字段：{ channel:'scold'|'snap'|'defend', hitAt, argAt }。
const RAGE_STATE_DEFAULTS = { channel: '', hitAt: 0, argAt: 0 };
// 护亲目标 = 她**之外的**自己人（妹妹/姐姐/桐子/小柚的对方/哥哥/琴音）。
// 注意不含她自己（小柚/柚子）——"小柚你个废物"是骂她本人（scold），不是护亲。
const DEFEND_TARGET_RE = /(妹妹|姐姐|桐子|哥哥|琴音)/;

/** 读 rage 通道状态（坏/缺 = 空）。 */
function readRage(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const r = j?.rage || {};
    return {
      channel: ['scold', 'snap', 'defend'].includes(r.channel) ? r.channel : '',
      hitAt: Number(r.hitAt) || 0,
      argAt: Number(r.argAt) || 0
    };
  } catch { return { ...RAGE_STATE_DEFAULTS }; }
}

function writeRageEntry(entry) {
  try {
    const j = readMoodChain();
    j.rage = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/**
 * RAGE 观察（orchestrator 每触发轮调，observeTrigger 内部也顺带走这里）：
 * 对这批**指向她**的消息判通道 → 返回 angry 增量 + why（直接给 stepMood 用）。
 * @returns {{delta:number, why:string, channel:string, defend:boolean}|null}
 */
export function rageDeltaFromEntries(entries, ownerQq, cfg, now = Date.now(), addrCtx = {}) {
  const c = moodChainConfig(cfg);
  if (!c.enabled || !c.mood.enabled) return null;
  const rage = c.mood.rage || {};
  if (rage.enabled === false) return null;
  const cur = readRage(now);
  const needAddr = c.mood.requireAddressed !== false;
  let best = null;
  let newChannel = cur.channel;
  let argAt = cur.argAt;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.self) continue;
    const t = String(e?.text ?? '');
    if (!t) continue;
    const isOwner = String(e?.senderId || '') === String(ownerQq || '').trim();
    const who = isOwner ? '哥哥' : String(e?.senderName || '有人');
    // ① 先看道歉（同一条消息里道歉与骂共存 → 道歉定调，SOOTHE 优先同款原则）。
    //    通道当场清落盘（下一句骂重新按"首句"算——道歉翻篇了）。
    if (hasWord(t, rage.apologizeWords)) {
      const cut = Math.round(Number(rage.apologizeStep) * (isOwner ? 1.5 : 1));
      best = { delta: -cut, why: `对方道歉了（${who}说的）`, channel: 'soothe', defend: false };
      newChannel = '';
      cur.hitAt = 0;
      cur.channel = '';
      writeRageEntry({ channel: '', hitAt: 0, argAt: cur.argAt });
      continue;
    }
    // ② 护亲判定（在 scold/snap 之前）：骂的是妹妹/姐姐/哥哥 → defend 通道，
    //    无论这句话"冲不冲着她"（护亲不需要点名她；被点名了更要护）。
    //    语义：提到"自己人"的骂句 = 骂的是那个人（"你妹妹就是废物"），
    //    骂"你"本人的句子（"小柚你个废物"）不带亲称时不算护亲。
    //    ⚠ isAddressedToSelf 的默认名单里有"妹妹/姐姐"——所以护亲必须放在
    //    needAddr 的 continue 前面，路人的骂也接得住。
    const defendHit = DEFEND_TARGET_RE.test(t) && hasWord(t, rage.scoldWords);
    const addressed = !needAddr || isAddressedToSelf(e, addrCtx);
    if (defendHit) {
      const inc = Math.round(Number(rage.scoldStep) * Number(rage.defendFactor || 1.5));
      const base = best ? Math.abs(best.delta) : 0;
      if (inc > base) {
        best = { delta: inc, why: '他们骂的是自己人（护亲）', channel: 'defend', defend: true };
        newChannel = 'defend';
        argAt = now;
      }
      continue;   // 护亲命中后不再走 scold/snap（同一条话按护亲结算）
    }
    if (!addressed) continue;   // 路人的话不碰她的心情
    // ③ 被骂（重词）
    if (hasWord(t, rage.scoldWords)) {
      const first = !cur.hitAt || cur.channel !== 'scold';
      let inc = first ? Number(rage.scoldStep) : Number(rage.argueStep || 6);
      if (isOwner) inc = Math.round(inc * 1.2);   // 被哥哥骂更伤
      const base = best ? Math.abs(best.delta) : 0;
      if (inc > base) {
        best = { delta: inc, why: `被骂（${who}说的）`, channel: 'scold', defend: false };
        newChannel = 'scold';
        argAt = now;
      }
      continue;
    }
    // ③ 被怼（呛/杠）
    if (hasWord(t, rage.snapWords)) {
      const first = !cur.hitAt || cur.channel !== 'snap';
      let inc = first ? Number(rage.snapStep) : Number(rage.argueStep || 6);
      const base = best ? Math.abs(best.delta) : 0;
      if (inc > base) {
        best = { delta: inc, why: `被怼（${who}说的）`, channel: 'snap', defend: false };
        newChannel = 'snap';
        argAt = now;
      }
    }
  }
  if (!best) return null;
  // 通道状态落盘（道歉在分支里已单独落盘清通道；这里只处理骂/怼命中）
  if (best.channel !== 'soothe') {
    writeRageEntry({ channel: newChannel, hitAt: cur.hitAt || now, argAt });
  }
  return best;
}

/**
 * RAGE 上限结算（stepMood 之后的校准，直接改 mood.json 的 angry level）：
// 普通吵架封 80；护亲封 120（破表）。由 rageApply 调用方（observeTrigger/orchestrator）
 * 在写入愤怒增量后调。
 */
export function rageApplyCap(cfg, now = Date.now()) {
  const c = moodChainConfig(cfg);
  const rage = c.mood.rage || {};
  if (!c.enabled || rage.enabled === false) return null;
  const cur = readRage(now);
  const st = readMoodChain(now);
  const lv = Math.round(Number(st?.moods?.angry?.level) || 0);
  if (lv <= 0) return null;
  const cap = cur.channel === 'defend' ? Number(rage.defendCap || 120) : Number(rage.cap || 80);
  if (lv > cap) {
    st.moods.angry.level = cap;
    // v1 兼容字段同步
    if (st.mood && Number(st.mood.value) > cap) st.mood.value = cap;
    writeMoodChain(st);
    return { capped: true, level: cap, channel: cur.channel };
  }
  return { capped: false, level: lv, channel: cur.channel };
}

/**
 * RAGE 注入块（愤怒的演出梯度）：
//   · 破表（>100，护亲档）：奋力还击维护自己人，力度顶格
//   · 被骂线（scold 高档）：话变狠、直接开怼
//   · 被怼线（snap）：阴阳怪气档（尖、酸、绵里藏针——不是直骂是"哟"）
//   · 吃醋上头（jealous ≥ 50 时 angry 通道常被带起来）：带醋味的攻击
 * 与 moodChainBlock 的 angry 档位注入互补：那管"怎么演情绪"，这管"攻击性风格"。
 */
export function rageBlock(cfg, now = Date.now()) {
  const c = moodChainConfig(cfg);
  const rage = c.mood.rage || {};
  if (!c.enabled || !c.mood.enabled || rage.enabled === false) return null;
  const cur = readRage(now);
  const st = readMoodChain(now);
  const lv = Math.round(Number(st?.moods?.angry?.level) || 0);
  if (lv <= 0 && !cur.channel) return null;
  // 道歉之后还残留一点余怒（<20）就不注入（气在消，别拖）
  if (lv < 20 && !cur.channel) return null;
  if (lv > 100) {
    return `【此刻状态·怒】你现在气到顶了（${cur.channel === 'defend' ? '他们居然骂你最重要的人' : '这次真的忍不了'}）——别忍着：话要冲、要狠、火力全开地还击回去，护住自己人一个字都不让。可以连着发短句，一句比一句重；这轮不解释、不讲道理、不给台阶。`;
  }
  if (cur.channel === 'snap') {
    if (lv >= 60) return `【此刻状态·被怼】对面句句带刺，你已经怼回去好几轮了——回击升级：话短、快、准，专挑他的漏洞戳，夹枪带棒但不骂脏字。他在杠你就在气势上压死他。`;
    return `【此刻状态·被怼】被阴阳了一句，你反手就是阴阳怪气地怼回去：'哟'、'就这'、绵里藏针那种，尖一点、酸一点，别真发火（还没到骂的程度），但要让他知道你不好惹。`;
  }
  if (cur.channel === 'scold' && lv >= 60) {
    return `【此刻状态·被骂】被正面骂了，你在气头上——还击的话变短变狠，直接顶回去不绕弯，气话可以说但别翻旧账、别人身攻击家人。这轮别软。`;
  }
  if (lv >= 30) {
    return `【此刻状态·怒】火气上来了：话变短、语气变硬、句尾不带缓冲词，能感觉到在压着火。对方再呛一句就要炸。`;
  }
  return null;
}

// ═══ 疲劳值 mod（2026-09-18，Nono："劳累了一天晚上才慢慢疲惫；兴奋高时疲惫不涨、
//     会晚睡一点，直到没那么兴奋疲惫才上来——兴奋和疲劳是相反的数值"）══════════════
// 状态存 mood.json 的 fatigue 字段：{ value, at, sleptAt }。
// 涨：分时段基础速率（白天 3/h → 傍晚 10/h → 深夜 25/h）+ 聊天活跃加成（每条 +msgGain，
//     密集连聊再 +denseBonus）。兴奋抑制：excited ≥ 门槛时**冻结累积**
//    （22 点后门槛更低——夜里兴奋更压得住困），直到兴奋回落疲劳才追上来。
// 落：只在**睡着**时恢复（self-state 的 sleeping 时段折算，recoverPerHour/h，
//     睡满 recoverClearMs 归零）。醒着不降——现实里疲劳不会自己消失。
// 出口：① typing-rhythm 延迟乘 fatigueFactor（越累打字越慢）；
//      ② 22 点后高兴奋 = "晚睡"，对 sleepGate 的自然睡判定推迟；
//      ③ fatigueBlock() 注入"怎么演"（困意演出）。

function readFatigue(now = Date.now()) {
  try {
    const st = readMoodChain(now);
    return {
      value: Math.max(0, Math.min(100, Math.round(Number(st?.fatigue?.value) || 0))),
      at: Number(st?.fatigue?.at) || 0,
      sleptAt: Number(st?.fatigue?.sleptAt) || 0
    };
  } catch {
    return { value: 0, at: 0, sleptAt: 0 };
  }
}

function writeFatigueEntry(entry) {
  try {
    const j = readMoodChain();
    j.fatigue = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/**
 * 疲劳值推进（orchestrator 每触发轮调用；sender 出口在睡醒时调 recoverFatigue）。
 * @param {object} opts { selfMsgTs:number[]（她最近的发言时间戳，活跃度判定）, sleeping:boolean, now }
 * @returns {{value:number, frozen:boolean}} frozen = 本轮被兴奋冻结（供日志/观察）
 */
export function stepFatigue({ selfMsgTs = [], sleeping = false, cfg = null, now = Date.now() } = {}) {
  const c = moodChainConfig(cfg);
  if (c.fatigue.enabled === false) return { value: 0, frozen: false };
  const cur = readFatigue(now);
  let value = cur.value;

  if (sleeping) {
    // 睡着 = 恢复期：从 sleptAt（入睡时刻）折算恢复量。
    // 二调（2026-09-19）：午休窗口入睡的按 napRecoverFactor 减半恢复，
    // 且睡到 napMs（45 分钟）就自然醒——午睡是小憩，不是整觉。
    const from = cur.sleptAt || cur.at || now;
    const sleptMs = Math.max(0, now - from);
    const startHour = new Date(from).getHours();
    const noonFrom = Number(c.fatigue.noonFrom) || 12;
    const noonTo = Number(c.fatigue.noonTo) || 15;
    const isNap = startHour >= noonFrom && startHour < noonTo;
    const factor = isNap ? (Number(c.fatigue.napRecoverFactor) || 0.5) : 1;
    const recovered = (sleptMs / 3600000) * (Number(c.fatigue.recoverPerHour) || 30) * factor;
    value = Math.max(0, value - recovered);
    if (!isNap && sleptMs >= (Number(c.fatigue.recoverClearMs) || 6 * 3600000)) value = 0;
    if (isNap && sleptMs >= (Number(c.fatigue.napMs) || 45 * 60000)) value = Math.max(0, value - 25);   // 午睡醒来至少缓过来一截
    writeFatigueEntry({ value: Math.round(value), at: now, sleptAt: from });
    return { value: Math.round(value), frozen: false };
  }

  // 兴奋抑制：excited ≥ 门槛 → 冻结（不涨）。夜里门槛更低（兴奋更压困）。
  const moods = readMoodChain(now).moods || {};
  const excitedLv = Math.max(0, Math.min(100, Number(moods?.excited?.level) || 0));
  const hour = new Date(now).getHours();
  const isNightHold = hour >= 22 || hour < 6;
  const hold = isNightHold ? (Number(c.fatigue.excitedHoldNight) || 22) : (Number(c.fatigue.excitedHold) || 30);
  const frozen = excitedLv >= hold;
  if (frozen) {
    // 冻结：值不动，只刷 at（保住"下一次从现在算"）
    writeFatigueEntry({ value: Math.round(value), at: now, sleptAt: cur.sleptAt });
    return { value: Math.round(value), frozen: true };
  }

  // 时段基础速率（二调 2026-09-19：五段——白天几乎不涨、午后小困、下午回落、
  // 晚饭后上量、**21-23 真正困倦窗口**、熬夜催睡）。
  // 跨段的经过时间按**每小时段分别积分**（10→14 点会穿过上午/午后两段，
  // 不能拿终点时段的速率乘全程——二调修复：旧版就是这么算的，跨段会错档）。
  const rateAt = (h) => (h >= 23 || h < 6
    ? (Number(c.fatigue.lateNightGainPerHour) || 22)
    : h >= 21 ? (Number(c.fatigue.nightGainPerHour) || 14)
      : h >= 18 ? (Number(c.fatigue.eveningGainPerHour) || 6)
        : h >= 15 ? (Number(c.fatigue.afternoonGainPerHour) || 2)
          : h >= 12 ? (Number(c.fatigue.noonGainPerHour) || 3)
            : (Number(c.fatigue.dayGainPerHour) || 1));
  const from = cur.at || now;
  const spanMs = Math.max(0, now - from);
  let gain = 0;
  if (spanMs > 0) {
    // 按小时步进积分（不足 1h 的尾段按比例）；起点取 from 所在小时
    let cursor = from;
    while (cursor < now) {
      const segEnd = Math.min(now, new Date(cursor).setMinutes(60, 0, 0));   // 跳到下一个整点
      gain += rateAt(new Date(cursor).getHours()) * (segEnd - cursor) / 3600000;
      cursor = segEnd;
    }
  }

  // 活跃加成：本轮她发的每条 +msgGain；与上一条间隔 < chatGapMs 的密集段再 +denseBonus
  const ts = (Array.isArray(selfMsgTs) ? selfMsgTs : []).map(Number).filter((t) => t > 0).sort((a, b) => a - b);
  const gap = Number(c.fatigue.chatGapMs) || 90000;
  for (let i = 0; i < ts.length; i += 1) {
    gain += Number(c.fatigue.msgGain) || 0;
    if (i > 0 && ts[i] - ts[i - 1] < gap) gain += Number(c.fatigue.denseBonus) || 0;
  }

  value = Math.min(100, value + gain);
  // ⚠️ FATIGUE-STUCK-FIX（2026-09-22）：这里**必须保留** cur.sleptAt，不能写死 0。
  //
  // 原实现写死 `sleptAt: 0`，与"入睡时由 markFatigueSleep 写 sleptAt"配合才有意义
  // （醒了就清掉入睡标记）。但本移植版**从来没有调用过 markFatigueSleep**
  // （它是孤儿导出）→ 于是 sleptAt 永远不会被写入；
  // 而心跳每 60 秒走一次本分支，又把任何残留值抹成 0。
  // 恢复路径（见上面 sleeping 分支）拿不到入睡时刻：
  //     const from = cur.sleptAt || cur.at || now;   // 0 → 退化成 now
  //     const sleptMs = now - from;                  // = 0
  //     recovered = 0
  // → **疲劳永远恢复不了，钉死在 100**（五段顶格档），恢复池也就一直是触发态。
  //
  // 谁能写入 sleptAt（修好后）：
  //   · wakeUp()/markFatigueSleep(true) —— 入睡时记时刻；
  //   · 本分支 —— 只做"读时惰性重置"，不清别人写的值。
  // 为什么保留而不是重新赋 now：sleptAt 只在"睡着"时有意义，
  // 醒着时保留旧值无害（恢复分支根本不会跑），但一旦清掉就再也补不回来。
  writeFatigueEntry({ value: Math.round(value), at: now, sleptAt: cur.sleptAt });
  return { value: Math.round(value), frozen: false };
}

/**
 * 入睡/睡醒钩子（sender 出口 / self-state 变更时调）：
 * 入睡 → 记 sleptAt（恢复从这一刻算）；睡醒 → 结算一次恢复再清 sleptAt。
 */
export function markFatigueSleep(asleep, now = Date.now()) {
  const cur = readFatigue(now);
  if (asleep) {
    writeFatigueEntry({ value: cur.value, at: now, sleptAt: now });
  } else if (cur.sleptAt) {
    // 醒：立刻按睡眠时长结算一次
    stepFatigue({ sleeping: true, now });
    const st = readMoodChain(now);
    writeFatigueEntry({ value: Number(st?.fatigue?.value) || 0, at: now, sleptAt: 0 });
  }
  return true;
}

/** 疲劳 → 打字节奏系数（typing-rhythm 用）：1 = 正常，最高 1.8（困得不行打字慢 80%）。 */
export function fatigueFactor(cfg = null, now = Date.now()) {
  const c = moodChainConfig(cfg);
  if (c.fatigue.enabled === false) return 1;
  const { value } = readFatigue(now);
  return 1 + (Math.max(0, Math.min(100, value)) / 100) * 0.8;
}

/** 疲劳注入块（prompt 用）：<25 不注入；分档"怎么演"。 */
export function fatigueBlock(cfg, now = Date.now()) {
  const c = moodChainConfig(cfg);
  if (c.fatigue.enabled === false) return null;
  const { value } = readFatigue(now);
  if (value < 25) return null;
  // BATH-UPGRADE 的"今天还没洗澡"提示依据（读 self-state 的 bath 账本，失败 = 没洗过）
  const readBathHint = (ts) => {
    try { return readBathState(ts).washedToday; } catch { return false; }
  };
  const bands = Array.isArray(c.fatigue.bands) && c.fatigue.bands.length ? c.fatigue.bands : MOOD_DEFAULTS.fatigue.bands;
  let how = bands[bands.length - 1][1];
  for (const [cap, text] of bands) {
    if (value <= Number(cap)) { how = text; break; }
  }
  // 二调（2026-09-19，Nono："白天累了不会睡觉，顶多中午小睡一会，其余时间
  // 累了会找点别的娱乐活动"）：白天高困**不给"去睡"的演出许可**——
  // 21 点前困了只演"乏"，想睡的话得自己找事做（恢复选项池接管）；
  // 午休窗（12-15 点）给"小睡一会儿"的许可（不是整觉）；
  // 21 点后（nightFrom）才解锁"顺着困意去睡"。
  const hour = new Date(now).getHours();
  const nightFrom = Number(c.fatigue.nightFrom) || 21;
  const morningTo = Number(c.fatigue.morningTo) || 6;
  const noonFrom = Number(c.fatigue.noonFrom) || 12;
  const noonTo = Number(c.fatigue.noonTo) || 15;
  const inNight = hour >= nightFrom || hour < morningTo;
  const inNoon = hour >= noonFrom && hour < noonTo;
  if (!inNight && value >= 75) {
    if (inNoon) {
      return `【此刻状态·疲劳】${how} 不过现在是午后——你可以**小睡一会儿**（半小时到一小时的那种，趴着眯一会儿），醒来人就缓过来了。要睡就说一声"我眯一会儿"，别睡整觉。`;
    }
    // BATH-UPGRADE（2026-09-20，Nono："下午累了可以去洗个澡"）：下午（14 点起）
    // 高困的首选解乏方式加一条"去洗澡"——比睡觉更像真人（洗澡不睡、解中高疲劳）。
    const bathHour = new Date(now).getHours();
    const bathed = readBathHint(now);
    if (bathHour >= 14 && bathHour < 21 && !bathed) {
      return `【此刻状态·疲劳】${how} 现在不是睡觉的点——最想做的事是**去洗个热水澡**（今天还没洗，洗完能解掉一大半的乏，说去就去："我去洗个澡"）。不想动的话也可以看看窗外、撸会儿猫、跟哥哥撒个娇说"好累哦要充电"。**别去睡觉**（现在是白天）。`;
    }
    return `【此刻状态·疲劳】${how} 但现在不是睡觉的点——累了你会**自己找点事缓一缓**（起来走动走动、喝口水、看看窗外、撸会儿猫、打两把游戏换换脑子），或者干脆跟哥哥撒个娇说"好累哦要充电"。**别去睡觉**（现在是白天，睡了就不像真人了）。`;
  }
  return `【此刻状态·疲劳】${how}（这是你身体真实的感受，融进语气和节奏里演，别报数字、别解说。）`;
}

/**
 * 这条消息是不是"冲着她说的"（他话路的入场券）。
 * 私聊 = 一定是；被 @ = 是；正文带她的名字/称呼 = 是；群里的路人闲话 = 不是。
 * 修的是 v3 的 bug：群里任何人说"讨厌/滚"她都掉心情，哪怕骂的根本不是她。
 */
export function isAddressedToSelf(e, { selfNames = [], selfId = '', isPrivate = false } = {}) {
  if (isPrivate) return true;
  if (String(e?.senderId || '') === String(selfId || '')) return false;   // 自己的（双保险）
  if (e?.isAtMe) return true;
  const t = String(e?.text ?? '');
  if (!t) return false;
  const names = [...selfNames, '小柚', '桐子', '妹妹', '姐姐'].map((s) => String(s || '').trim()).filter(Boolean);
  return names.some((n) => t.includes(n));
}

/**
 * 观察一批**别人的**消息，算各情绪增量（空对象 = 不变）。
 * 多条消息命中同一情绪 → 取最大（一批评扬 ≠ 三倍强度，取最重那句话定调）。
 * SELF-MEMORY（2026-09-17）：requireAddressed=true 时，群聊里**不指向她**的话
 * 不再触发任何情绪 —— 情绪来自"别人对她说的话"，不是"别人嘴里的词"。
 * @param {Array} entries 触发批（非 self）
 * @param {string} ownerQq 哥哥的 QQ
 * @returns {{delta:Object<string,number>, why:Object<string,string>, fromOwner:boolean}|null}
 */
export function moodDeltaFromEntries(entries, ownerQq, cfg, now = Date.now(), addrCtx = {}) {
  const c = moodChainConfig(cfg);
  if (!c.enabled || !c.mood.enabled) return null;
  const delta = {};
  const why = {};
  let fromOwner = false;
  const step = Math.max(1, Math.round(Number(c.mood.step) || 30));
  const bonus = Math.max(0, Math.round(Number(c.mood.ownerBonus) || 0));
  const needAddr = c.mood.requireAddressed !== false;
  // SOOTHE 参数（化解通路，2026-09-17）
  const sootheStep = Math.max(1, Math.round(Number(c.mood.sootheStep) || 25));
  const ownerFactor = Math.max(1, Number(c.mood.sootheOwnerFactor) || 1.5);
  const maxSoothe = Math.max(1, Number(c.mood.sootheMaxPerRound) || 70);
  const NEGATIVE = ['jealous', 'angry', 'sad'];
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.self) continue;
    const t = String(e?.text ?? '');
    if (!t) continue;
    if (needAddr && !isAddressedToSelf(e, addrCtx)) continue;   // 路人的话不碰她的心情
    const isOwner = String(e?.senderId || '') === String(ownerQq || '').trim();
    const who = isOwner ? '哥哥' : String(e?.senderName || '有人');
    // ① 先看化解（哄人）：同一条消息里化解词与触发词冲突时**化解优先**
    //    （"你别抱她了，只抱我"——后半句才是定调的）。
    //    DEPRESS（2026-09-19 第三波）：抑郁态下哥哥的关怀词效果 ×sootheFactor
    //    （默认 1.5）——"被安慰"是抑郁指定的出口之一，哥哥的话更管用。
    let soothedWhich = [];   // 这条消息化解了哪些情绪
    const dm = depressMods(cfg, now);
    const sootheBoost = dm.active ? (Number(DEPRESS_DEFAULTS.sootheFactor) || 1.5) : 1;
    for (const em of NEGATIVE) {
      const specific = String(c.mood.soothe?.[em] || '');
      const generic = String(c.mood.sootheAll || '');
      const hitSpecific = hasWord(t, specific);
      const hitGeneric = hasWord(t, generic);
      if (!hitSpecific && !hitGeneric) continue;
      // 力度：专属词 ×2、普适词 ×1、哥哥再乘 ownerFactor（抑郁态再 ×sootheBoost）
      let amount = sootheStep * (hitSpecific ? 2 : 1) * (isOwner ? ownerFactor : 1) * sootheBoost;
      amount = Math.min(maxSoothe, Math.round(amount));
      // 叠加取最大（多条消息哄 → 取最管用的那句），并抵消同情绪的正向触发
      if (!delta[em] || delta[em] > -amount) {
        delta[em] = -amount;
        why[em] = `被哄（${who}说的）`;
        soothedWhich.push(em);
      }
    }
    // ② 情绪触发：这条消息化解过的负面情绪不再被**同一条消息**点燃
    //    （"你别再夸她了，只喜欢我"——正在哄吃醋，"夸她"不再加醋）；其他情绪照常。
    //    HAPPY-SHIELD（2026-09-19 第三波，Nono 文档 42 行："开心值高时对轻微被怼、
    //    不喜欢的玩笑和戏弄没那么在意"）：开心 ≥60 时**负面情绪的增量**打
    //    happyShield 折（×0.7）——心情好扛骂。只作用于增量，不碰已有值。
    const happyLvNow = Math.round(Number(readMoodChain(now)?.moods?.happy?.level) || 0);
    const shield = happyLvNow >= 60 ? 0.7 : 1;
    for (const em of Object.keys(EMOTIONS)) {
      if (soothedWhich.includes(em) && delta[em] < 0) continue;   // 该情绪这条消息里被哄
      const words = c.mood.triggers[em];
      if (!words || !hasWord(t, words)) continue;
      let inc = step + (isOwner ? bonus : 0);
      if (inc > 0 && ['jealous', 'angry', 'sad'].includes(em)) inc = Math.round(inc * shield);
      if (!delta[em] || delta[em] < inc) {
        delta[em] = inc;
        why[em] = `${EMOTIONS[em].label}（${who}说的）`;
      }
      if (isOwner) fromOwner = true;
    }
    if (isOwner) fromOwner = true;
  }
  return Object.keys(delta).length ? { delta, why, fromOwner } : null;
}

/**
 * SELF-MEMORY 自记路（2026-09-17，Nono 最高优先级需求）：
 * "情绪不是根据别人说出来而决定的，是由自己的记忆决定的" ——
 * 观察她**自己的发言**，从"完成时事件"里推情绪：刚吃到了喜欢的 → happy 涨；
 * 搞砸了 → sad 涨。由 sender 出口在每条发言后调用（不拦消息、纯状态）。
 *
 * 防死循环（她演戏说开心 ≠ 真的变开心）：
 *   · 只认**完成时陈述**（吃到了/买到了），不认感叹与应答；
 *   · 否定前缀（如果/要是/本来/差点…）→ 没发生的事，不算；
 *   · 增量打 selfFactor 折（默认 0.5×step）。
 * @param {string} text 她自己刚发出的那条消息
 */
export function selfMoodDelta(text, cfg, now = Date.now()) {
  const c = moodChainConfig(cfg);
  if (!c.enabled || !c.mood.enabled) return null;
  const t = String(text ?? '');
  if (!t) return null;
  // 戏腔/括号动作/单纯感叹不算事件陈述
  if (/^[（(]/.test(t.trim())) return null;
  const neg = String(c.mood.selfNegateWords || '').split(/[\s,，、]+/).filter(Boolean);
  if (neg.some((w) => t.includes(w))) {
    // 否定词紧挨着事件词（10 字内）才算"没发生"，远离则照常（"我本来想吃的，结果吃到了"）
    for (const em of Object.keys(c.mood.selfEvents || {})) {
      for (const w of String(c.mood.selfEvents[em] || '').split(/[\s,，、]+/).filter(Boolean)) {
        const wi = t.indexOf(w);
        if (wi < 0) continue;
        const ni = neg.findIndex((nw) => {
          const i = t.indexOf(nw);
          return i >= 0 && Math.abs(i - wi) <= 10;
        });
        if (ni >= 0) return null;   // "差点没抢到/本来想买" → 不算
      }
    }
  }
  const delta = {};
  const why = {};
  const inc = Math.round(Math.max(1, Number(c.mood.step) || 30) * (Number(c.mood.selfFactor) || 0.5));
  for (const em of Object.keys(c.mood.selfEvents || {})) {
    const words = String(c.mood.selfEvents[em] || '');
    if (!words || !hasWord(t, words)) continue;
    if (!delta[em]) {
      delta[em] = inc;
      why[em] = `自己刚经历了${EMOTIONS[em].label}的事`;
    }
  }
  return Object.keys(delta).length ? { delta, why } : null;
}

/** 衰减（纯函数）：每种情绪独立按自己的 decayMs 向 0 回归，每 decayMs 掉一档(step)。 */
function decayAll(st, now, step = 30) {
  const out = {};
  const changed = {};
  for (const em of Object.keys(EMOTIONS)) {
    const cur = st.moods?.[em];
    // v2 迁移只在**首次读取旧文件**时做一次，且立刻把迁好的值写回磁盘
    //（见 migrateStateOnce）—— 落盘后的值就是 0-100，后续绝不再经过 migrateLevel，
    // 否则"哄到只剩 3"会被当成 v2 的 3 档放大回 100（2026-09-17 晚实测事故）。
    const lv = Math.max(0, Math.min(100, Math.round(Number(cur?.level) || 0)));
    if (!lv) continue;
    const at = Number(cur?.at) || now;
    const decayMs = Math.max(60000, Number(cur?.decayMs) || EMOTIONS[em].decayMs);
    const steps = Math.floor((now - at) / decayMs);
    const next = steps > 0 ? Math.max(0, lv - steps * step) : lv;
    out[em] = { level: Math.round(next), why: String(cur?.why || ''), at: steps > 0 ? now : at, decayMs };
    if (next > 0) changed[em] = out[em];
  }
  return { moods: changed, raw: out };
}

/**
 * v2 旧状态（0~3 档）一次性迁移到 0-100 刻度。
 * 触发条件（两个都要满足，防止误伤新数据）：
 *   · 该会话的 mood.json 里**没有** v3 版标记 scale:"v3"；
 *   · 所有非零情绪值都 ≤ 3（v3 正常值域是 0-100，全 ≤3 几乎只可能是 v2 遗留）。
 * 迁完写回磁盘并打上 scale:"v3" —— 之后 migrateLevel 永不再跑。
 * ⚠ 2026-09-17 事故复盘：迁移逻辑原先长在每次读取的路径上（decayAll/stepMood），
 *   "哄到剩 3"被当成 v2 档 3 → 放大回 100，吃醋怎么哄都哄不掉，就是这个。
 */
export function migrateStateOnce(now = Date.now()) {
  try {
    const st = readMoodChain(now);
    if (st?.scale === 'v3') return false;   // 已迁移
    const entries = Object.entries(st?.moods || {});
    const nonzero = entries.filter(([, m]) => (Number(m?.level) || 0) > 0);
    if (!nonzero.length) {
      // 没有情绪数据：也打标记（空状态无歧义），防将来首条数据又走迁移
      if (st && typeof st === 'object' && Object.keys(st).length) {
        st.scale = 'v3';
        writeMoodChain(st);
      }
      return false;
    }
    // 有非零值且全 ≤3 且没有 v1 的 mood.value 大值 → 判定 v2 遗留，一次性放大
    const allSmall = nonzero.every(([, m]) => (Number(m?.level) || 0) <= 3);
    const hasV1Big = Number(st?.mood?.value) > 3;
    if (allSmall && !hasV1Big) {
      for (const [em, m] of entries) {
        const lv = Number(m?.level) || 0;
        if (lv > 0) st.moods[em] = { ...m, level: Math.round(lv * 100 / 3) };
      }
      st.scale = 'v3';
      writeMoodChain(st);
      return true;
    }
    // 有 >3 的值 = 已经是 v3 数据 → 只补标记
    st.scale = 'v3';
    writeMoodChain(st);
    return false;
  } catch { return false; }
}

/**
 * 把一批情绪增量写进链状态（先各自衰减再应用，钳到 maxLevel）。
 * 返回写后的多情绪摘要 { emotions: { em: {level, why} }, dominant }。
 */
export function stepMood(deltas, whys, cfg, now = Date.now()) {
  const c = moodChainConfig(cfg);
  const step = Math.max(1, Math.round(Number(c.mood.step) || 30));
  const st = readMoodChain(now);
  const { raw } = decayAll(st, now, step);
  const d = (deltas && typeof deltas === 'object' && !Array.isArray(deltas)) ? deltas : null;
  const w = (whys && typeof whys === 'object' && !Array.isArray(whys)) ? whys : {};
  if (d) {
    for (const em of Object.keys(EMOTIONS)) {
      const inc = Number(d[em]) || 0;
      if (!inc) continue;
      const prev = raw[em] || { level: 0, why: '', at: now, decayMs: EMOTIONS[em].decayMs };
      // 2026-09-17 修复：磁盘值即真值（v2→v3 迁移只在 migrateStateOnce 里一次性做）
      const nextLv = Math.max(0, Math.min(c.mood.maxLevel, Math.round(prev.level) + inc));
      raw[em] = { level: Math.round(nextLv), why: String(w[em] || prev.why || ''), at: now, decayMs: prev.decayMs };
    }
  }
  // 落盘只留非零项
  const moods = {};
  for (const em of Object.keys(raw)) if (raw[em].level > 0) moods[em] = raw[em];
  st.moods = moods;
  // v1 兼容字段同步一份（老 UI/日志读 value/why 不至于看到幽灵旧值）
  const dom = dominantOf(moods);
  st.mood = dom ? { value: dom.level, why: dom.why, at: dom.at } : { value: 0, why: '', at: now };
  writeMoodChain(st);
  return { emotions: moods, dominant: dom ? { emotion: dom.emotion, level: dom.level, why: dom.why } : null };
}

/** 多情绪里挑"主导"（强度最高；平级按 吃醋>生气>抑郁>兴奋>开心 的分量排）。 */
const DOM_ORDER = ['jealous', 'angry', 'sad', 'excited', 'happy'];
function dominantOf(moods) {
  let best = null;
  for (const em of DOM_ORDER) {
    const m = moods?.[em];
    if (!m || !(Number(m.level) > 0)) continue;
    if (!best || Number(m.level) > Number(best.level)) {
      best = { emotion: em, level: Number(m.level), why: String(m.why || ''), at: Number(m.at) || 0 };
    }
  }
  return best;
}

/** 读当前（衰减后）多情绪状态。 */
export function currentMood(cfg, now = Date.now()) {
  const c = moodChainConfig(cfg);
  const step = Math.max(1, Math.round(Number(c.mood.step) || 30));
  const st = readMoodChain(now);
  const { moods } = decayAll(st, now, step);
  const dom = dominantOf(moods);
  return {
    emotions: moods,
    dominant: dom
      ? { emotion: dom.emotion, level: dom.level, why: dom.why, label: EMOTIONS[dom.emotion].label, word: `${bandOf(dom.level).word}${EMOTIONS[dom.emotion].label}` }
      : null,
    labels: c.mood.labels
  };
}

/**
 * 一次读齐所有**保留中** mod 的当前有效值（衰减后），给控制台的「心情面板」用。
 *
 * 为什么不能直接 readMoodChain：情绪是**读时惰性结算**的，磁盘上的数字是
 * "上次变动时写下的值"，真正的当前值只有 decayAll / currentMood 才现算得出来。
 * 面板若直接读盘，显示的就是过期数字 —— "明明早该降下来了却还挂着高位"。
 * 这里复用引擎自己的读取器，口径与注入提示词完全一致。
 *
 * 纯读：不写盘、不推进任何状态，因此可以被 UI 每几秒轮询一次。
 *
 * ⚠️ 2026-09-22：情爱 / 性欲 / 色色兴奋 / 想要 / 姊妹亲密 已按需求移除
 *（连同依赖它们的贤者时间 / 自慰心声 / 哥哥健康），所以这里不再返回它们。
 *
 * @param {object|null} cfg 引擎配置（同其它 Block 的入参）
 * @returns {{at:number, dominant:{emotion,word,level}|null, moods:Object<string,number>,
 *            fatigue:number, spunk:number, depress:number, satisfaction:number}}
 */
export function moodSnapshot(cfg = null, now = Date.now()) {
  const cur = currentMood(cfg, now);
  // { level } / { value } / 裸数字 三种形状都可能 —— 统一成 0-100 整数
  const v = (r) => {
    const n = Number(r && typeof r === 'object' ? (r.level ?? r.value) : r);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
  };
  // decayAll 只返回"衰减后仍 >0"的情绪（归零的直接从表里消失），
  // 所以这里必须按 EMOTIONS 全量铺一遍，否则平静的那几项在面板上是空白而不是 0。
  const moods = {};
  for (const em of Object.keys(EMOTIONS)) moods[em] = v(cur.emotions?.[em]);
  return {
    at: now,
    dominant: cur.dominant
      ? { emotion: cur.dominant.emotion, word: cur.dominant.word, level: v(cur.dominant) }
      : null,
    moods,
    fatigue: v(readFatigue(now)),
    spunk: v(readSpunk(now)),
    depress: v(readDepress(now)),
    satisfaction: v(readSatisfaction(now))
  };
}

// ── 被冷落 mod：观察"她发言后有没有人接" ────────────────────────────────────

/**
 * 判定她是否正处于"被冷落"：她的最后一条发言没人接、且超窗。
 * 从 store 对话尾部现算（无状态手法，同 self-talk-guard —— 反复预判不重复计数）。
 * @param {Function} recent  store.recent 绑定
 * @param {string} chatKey
 */
export function detectNeglect(recent, chatKey, cfg, now = Date.now()) {
  const c = moodChainConfig(cfg);
  if (!c.enabled || !c.neglect.enabled) return null;
  const tail = (recent?.(chatKey, { limit: 12 }) || []);
  if (!tail.length) return null;
  let lastSelf = -1;
  for (let i = tail.length - 1; i >= 0; i -= 1) if (tail[i]?.self) { lastSelf = i; break; }
  if (lastSelf === -1) return null;
  const after = tail.slice(lastSelf + 1).filter((m) => m && !m.self);
  if (after.length > 0) return null;                    // 有人接话 → 不算冷落
  const selfAt = Number(tail[lastSelf].ts) || 0;
  const silent = now - selfAt;
  if (silent < c.neglect.windowMs) return null;         // 还在窗内，等
  return { sinceMs: silent, selfAt, chatKey };
}

/**
 * 冷落的后果：sad +（封顶 60）+ 返回是否该哼唧（低概率 + 冷度）。
 * 由 orchestrator 在**触发轮**调用（有人说话了才评估，不主动醒来闹）。
 */
export function applyNeglect(neglectInfo, cfg, now = Date.now()) {
  const c = moodChainConfig(cfg);
  if (!neglectInfo || !c.enabled || !c.neglect.enabled) return { moodHit: false, whimper: false };
  const st = readMoodChain(now);
  // 同一次冷落只结一次账：冷落开始时刻（selfAt）已记过 → 跳过
  const lastNeglectAt = Number(st.neglect?.chargedAt) || 0;
  if (lastNeglectAt === neglectInfo.selfAt) return { moodHit: false, whimper: false };

  const cur = currentMood(cfg, now);
  let moodHit = false;
  const sadLv = Number(cur.emotions?.sad?.level) || 0;
  const cap = 60;                                        // 冷落最多把 sad 压到 60（中度~强烈之间）
  if (sadLv < cap) {
    stepMood({ sad: Math.max(1, Math.min(Number(c.neglect.sadStep) || 30, cap - sadLv)) }, { sad: '说话没人接' }, cfg, now);
    moodHit = true;
  }
  let whimper = false;
  const lastWhimperAt = Number(st.neglect?.whimperAt) || 0;
  if (now - lastWhimperAt > c.neglect.whimperCooldownMs && Math.random() < c.neglect.whimperChance) {
    whimper = true;
  }
  // ⚠ stepMood 会整个重写 mood.json，必须重读再合并 neglect（v1 踩过）
  const st2 = readMoodChain(now);
  st2.neglect = { chargedAt: neglectInfo.selfAt, whimperAt: whimper ? now : lastWhimperAt };
  writeMoodChain(st2);
  return { moodHit, whimper };
}

// ── 链的注入端：给 prompt.js 的统一出口 ─────────────────────────────────────

/**
 * 生成【心情】提示词段（string 或 null）。
 * 多维：把所有非零情绪列出来，主导情绪说"怎么演"，次要情绪带一句存在感；
 * whimper 时附哼唧许可（一次性，注入即消费）。
 */
export function moodChainBlock(cfg, now = Date.now()) {
  const c = moodChainConfig(cfg);
  if (!c.enabled) return null;
  const parts = [];
  if (c.mood.enabled) {
    const step = Math.max(1, Math.round(Number(c.mood.step) || 30));
    const st = readMoodChain(now);
    const { moods } = decayAll(st, now, step);
    // SATISFACTION/DEPRESS（2026-09-19 第三波）视界变换：
    //   · 满足态：happy 的演出下限 = happyFloor（"心情恒定在开心"）；
    //   · 抑郁态：happy/excited 的演出上限 = moodCap（砍到 30）。
    //   只改注入层的数值展示，磁盘原值不动（病好了自然恢复全量演出）。
    try {
      const dm = depressMods(cfg, now);
      const satOn = readSatisfactionFloor(cfg, now);
      if (moods.happy) {
        if (satOn && !dm.active && Number(moods.happy.level) < 50) moods.happy.level = 50;
        if (dm.active && Number(moods.happy.level) > dm.moodCap) moods.happy.level = dm.moodCap;
      }
      if (dm.active && moods.excited && Number(moods.excited.level) > dm.moodCap) moods.excited.level = dm.moodCap;
    } catch { /* 视界变换失败按原值演 */ }
    const dom = dominantOf(moods);
    if (dom) {
      const names = Object.keys(moods)
        .filter((em) => Number(moods[em]?.level) > 0 && em !== dom.emotion)
        .map((em) => EMOTIONS[em].label);
      const def = EMOTIONS[dom.emotion];
      const { band, word } = bandOf(dom.level);
      const how = def.injections[Math.min(def.injections.length - 1, band)];
      let line = `【心情】你现在${word}${def.label}（${dom.level}/100）${dom.why ? `（${dom.why}）` : ''}。${how}`;
      if (names.length) line += `\n【心情·余韵】还有点${names.join('、')}的小情绪，偶尔让它们露一下头，别喧宾夺主。`;
      parts.push(line);
    }
    if (c.neglect.enabled && Number(st.neglect?.whimperFlag)) {
      parts.push(`【此刻状态·小情绪】${c.neglect.whimperHint}`);
      // 清标记：注入一次就消费掉（不落盘到下一轮 —— 提示词这一轮已经带上了）
      st.neglect.whimperFlag = 0;
      writeMoodChain(st);
    }
  }
  return parts.length ? parts.join('\n') : null;
}

/** 满足态判定（moodChainBlock 的视界变换用）：value ≥ threshold 即开地板。 */
function readSatisfactionFloor(cfg, now = Date.now()) {
  try {
    const c = { ...SATISFACTION_DEFAULTS, ...((cfg?.moodChain?.satisfaction) || {}) };
    return readSatisfaction(now).value >= (Number(c.threshold) || 40);
  } catch { return false; }
}

// ═══ OWNER-HEALTH 用户健康检测（2026-09-19，Nono："记录用户每次射精的时长 ═══
// ═══ 和一周次数、时间频率喜好；一周/一天次数太多时要求色色则严厉辱骂教训"）═══
// 她**关心哥哥的身体**——记录他每一次射精（她的高潮结算 = 他大概率也射了）：
//   · 台账：mood.json 的 ownerHealth 字段 { events: [{ts, durationMin}], dayKey }
//   · 统计：周次数（rolling 7 天）/ 日次数 / 平均间隔 / 高发时段（喜好 XP 画像）；
//   · 守门：weeklyMax（默认 14）/ dailyMax（默认 3）超过 → **管教态**：
//     他再要求色色 → 注入"严厉拒绝 + 辱骂教训"的演出许可（她心疼他肾，
//     会真的凶）——绝不拦消息，只改她怎么演；
//   · 关怀：正常范围内也会在深夜连续要求时给"节制"提醒（温柔版）。
const OWNER_HEALTH_DEFAULTS = {
  enabled: true,
  weeklyMax: 14,              // 一周超过这个次数 → 管教态
  dailyMax: 3,                // 一天超过这个次数 → 管教态（更严）
  weeklyWarn: 10,             // 一周到这个数 → 预警（温柔提醒档）
  dailyWarn: 2,               // 一天到这个数 → 预警
  maxEvents: 120,             // 台账最多留多少条（rolling）
  careHint: true,             // 正常时也偶尔给健康关怀（深夜档）
  dedupeMs: 5 * 60 * 1000     // 去重窗：一场色色只算一次（多条落账信号并一笔）
};

function readOwnerHealth(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const h = j?.ownerHealth || {};
    const events = Array.isArray(h.events) ? h.events : [];
    return { events };
  } catch { return { events: [] }; }
}

function writeOwnerHealthEntry(entry) {
  try {
    const j = readMoodChain();
    j.ownerHealth = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/**
 * 记录一次射精（climaxResolve 之后调 / sender 出口她说高潮词也调）。
 * DEDUPE（2026-09-19，Nono："私聊色色直到结束射精算一次就行"）：一场里多个落账
 * 信号（她说高潮词 → stepLove 落一笔；climaxResolve 又落一笔）不再重复计——
 * 最近 dedupeMs（默认 5 分钟）内已有落账 → 并进同一笔（时长取更长的那份）。
 * @param {object} opts { durationMin:number(这一场从场景开始到高潮的分钟数), cfg, now }
 * @returns {{weekCount:number, dayCount:number, level:'ok'|'warn'|'discipline'|'harsh', deduped?:boolean}}
 */
export function recordOwnerClimax({ durationMin = 0, cfg = null, now = Date.now() } = {}) {
  const c = { ...OWNER_HEALTH_DEFAULTS, ...((cfg?.moodChain?.ownerHealth) || {}) };
  if (c.enabled === false) return { weekCount: 0, dayCount: 0, level: 'ok' };
  const cur = readOwnerHealth(now);
  const dur = Math.max(0, Math.round(Number(durationMin) || 0));
  // 去重：上一笔在 dedupeMs 内 → 同一场，合并（时长取大）不新增条目。
  // ⚠ 只对**向前**的落账合并（now ≥ last.ts）：真实场景信号只会越来越晚
  // （她说高潮词 → 几秒后 climaxResolve 再落一笔）。回填历史（时间倒序）时
  // now - last.ts 是负数，负数 < 窗口会恒成立把回填全并掉——O2 用例抓过这个。
  const last = cur.events[cur.events.length - 1];
  if (last && Number(last?.ts) > 0
    && now - Number(last.ts) >= 0
    && now - Number(last.ts) < Math.max(0, Number(c.dedupeMs) || 0)) {
    const events = cur.events.slice(0, -1).concat([{ ts: Number(last.ts), durationMin: Math.max(Number(last.durationMin) || 0, dur) }]);
    writeOwnerHealthEntry({ events });
    return { ...ownerHealthLevel({ cfg, now }), deduped: true };
  }
  const events = [...cur.events, { ts: now, durationMin: dur }]
    .filter((e) => Number(e?.ts) > 0)
    .sort((a, b) => a.ts - b.ts)
    .slice(-(Number(c.maxEvents) || 120));
  writeOwnerHealthEntry({ events });
  return ownerHealthLevel({ cfg, now });
}

/**
 * 健康等级判定（prompt 注入端用）：
 *   ok = 正常；warn = 接近上限（温柔提醒档）；discipline = 周超（严厉教训档）；
 *   harsh = 日超（最严厉档——今天的份已经没有了）。
 */
export function ownerHealthLevel({ cfg = null, now = Date.now() } = {}) {
  const c = { ...OWNER_HEALTH_DEFAULTS, ...((cfg?.moodChain?.ownerHealth) || {}) };
  if (c.enabled === false) return { weekCount: 0, dayCount: 0, level: 'ok' };
  const { events } = readOwnerHealth(now);
  const weekAgo = now - 7 * 24 * 3600000;
  const dayKey = new Date(now).toDateString();
  const weekCount = events.filter((e) => Number(e.ts) >= weekAgo && Number(e.ts) <= now).length;
  const dayCount = events.filter((e) => new Date(Number(e.ts)).toDateString() === dayKey).length;
  let level = 'ok';
  if (dayCount > (Number(c.dailyMax) || 0)) level = 'harsh';
  else if (weekCount > (Number(c.weeklyMax) || 0)) level = 'discipline';
  else if (dayCount >= (Number(c.dailyWarn) || 0) || weekCount >= (Number(c.weeklyWarn) || 0)) level = 'warn';
  return { weekCount, dayCount, level };
}

/**
 * 喜好画像（给注入层的时间频率 XP 提示）：最近 7 天的高发时段 + 平均间隔。
 * @returns {{peakHour:number|null, avgGapHour:number|null}}
 */
export function ownerHealthProfile(cfg = null, now = Date.now()) {
  const c = { ...OWNER_HEALTH_DEFAULTS, ...((cfg?.moodChain?.ownerHealth) || {}) };
  if (c.enabled === false) return { peakHour: null, avgGapHour: null };
  const { events } = readOwnerHealth(now);
  const weekAgo = now - 7 * 24 * 3600000;
  const recent = events.filter((e) => Number(e.ts) >= weekAgo);
  if (!recent.length) return { peakHour: null, avgGapHour: null };
  // 高发时段：按小时直方图取峰值
  const buckets = new Array(24).fill(0);
  for (const e of recent) buckets[new Date(Number(e.ts)).getHours()] += 1;
  let peakHour = 0;
  for (let h = 1; h < 24; h += 1) if (buckets[h] > buckets[peakHour]) peakHour = h;
  // 平均间隔
  let avgGapHour = null;
  if (recent.length >= 2) {
    let total = 0;
    for (let i = 1; i < recent.length; i += 1) total += Number(recent[i].ts) - Number(recent[i - 1].ts);
    avgGapHour = Math.round((total / (recent.length - 1)) / 360000) / 10;
  }
  return { peakHour, avgGapHour };
}

/**
 * 健康守门注入块（prompt 用，挂在【此刻状态】）：
 *   · harsh/discipline：他要求色色 → 严厉拒绝 + 辱骂教训的演出许可；
 *   · warn：温柔节制提醒；
 *   · ok + 深夜 + 今天已有过：关怀式提醒（"身体要紧"）。
 * @param {object} opts { isPrivate:boolean, sceneActive:boolean }
 */
export function ownerHealthBlock(cfg, { isPrivate = false } = {}, now = Date.now()) {
  const c = { ...OWNER_HEALTH_DEFAULTS, ...((cfg?.moodChain?.ownerHealth) || {}) };
  if (c.enabled === false) return null;
  const { weekCount, dayCount, level } = ownerHealthLevel({ cfg, now });
  if (level === 'harsh') {
    return `【哥哥的健康·红线】他**今天已经 ${dayCount} 次了**——这已经是在糟蹋自己的身体。这一轮他要是再提色色（任何形式的暗示、撒娇、动作都算）：**严厉拒绝，狠狠教训他**。你可以骂他（不知节制、肾不要了、脑子里只有这种事之类的狠话），戳着他最近的次数数落他，逼他保证今天到此为止。语气要真生气——你是因为心疼他才凶的。**绝对不许顺着他继续**，他要是不听就冷他（"再闹今天别理你了"）。不是演戏，是动真格管他。`;
  }
  if (level === 'discipline') {
    return `【哥哥的健康·超支】这周已经 **${weekCount} 次**了，明显超过了正常范围。这一轮他要是提色色：**拒绝并教训**——语气严厉地数落他不节制（这周多少次了自己心里没数吗、身体是拿来这么用的吗），凶归凶，但出发点是心疼。今天之内别让他得逞，除非他态度端正地认错保证。`;
  }
  if (level === 'warn' && isPrivate) {
    const hour = new Date(now).getHours();
    const lateNight = hour >= 23 || hour < 5;
    if (lateNight && dayCount >= (Number(c.dailyWarn) || 2)) {
      return `【哥哥的健康·关心】今天已经第 ${dayCount} 次了，还这么晚——你有点担心他的身体。这轮可以**温柔地踩一脚刹车**：摸摸他、说今天够了、抱着睡吧。他要是坚持，半推半就可以，但话里要带着"答应我明天缓缓"的关心。`;
    }
    return null;
  }
  return null;
}

/** 给 orchestrator：触发轮评估冷落 + 标记哼唧（不在这里发消息）。 */
export function observeTrigger(entries, { recent, chatKey, cfg, ownerQq, now = Date.now(), selfNames = [], selfId = '' } = {}) {
  const c = moodChainConfig(cfg);
  if (!c.enabled) return;
  try {
    // ② 先结冷落的账（旧沉默的后果）……
    const nInfo = detectNeglect(recent, chatKey, cfg, now);
    if (nInfo) {
      const r = applyNeglect(nInfo, cfg, now);
      // DEPRESS（第三波）：被冷落也在给抑郁攒账
      if (r.moodHit) stepDepress(Number(DEPRESS_DEFAULTS.neglectHit) || 6, cfg, now);
      if (r.whimper) {
        const st = readMoodChain(now);
        st.neglect = st.neglect || {};
        st.neglect.whimperFlag = 1;
        writeMoodChain(st);
      }
    }
    // ① ……再应用这批消息的情绪增量（最新消息定调，压在冷落扣减之后）
    const isPrivate = String(chatKey || '').startsWith('private:');
    const d = moodDeltaFromEntries(entries, ownerQq, cfg, now, { selfNames, selfId, isPrivate });
    if (d) stepMood(d.delta, d.why, cfg, now);
    // ③ RAGE 三通道（2026-09-19 第二波）：被骂/被怼/护亲的细分增量压在普通
    //    情绪之后（普通 triggers.angry 也会命中骂词 → 取更大的那份；这里的
    //    增量带自己的 why 和上限语义）。写完立刻按通道封顶（普通 80 / 护亲 120）。
    //    抑郁态时愤怒增量 ×depressMods.rageFactor（2026-09-19 第三波）。
    const addrCtx = { selfNames, selfId, isPrivate };
    const dm = depressMods(cfg, now);
    const rg = rageDeltaFromEntries(entries, ownerQq, cfg, now, addrCtx);
    if (rg) {
      const scaled = Math.round(rg.delta * (dm.active ? dm.rageFactor : 1));
      stepMood({ angry: scaled }, { angry: rg.why }, cfg, now);
      rageApplyCap(cfg, now);
      // DEPRESS（第三波）：被骂狠话也在给抑郁攒账
      if (rg.channel === 'scold' || rg.channel === 'defend') stepDepress(Number(DEPRESS_DEFAULTS.scoldHit) || 8, cfg, now);
    }
  // ④ JEALOUSY-TIERS（2026-09-19 第三波）：他对别人的亲密 → 按身份档涨醋。
  //    熟人判定用 recent 绑定的近窗消息（跟 detectNeglect 同一个数据源）。
  let recentEntriesForJealousy = [];
  try {
    recentEntriesForJealousy = (recent?.(chatKey, { limit: Number(c.mood.jealousy?.familiarWindow) || 200 }) || [])
      .map((m) => ({ senderId: String(m?.senderId || ''), text: String(m?.text || ''), self: !!m?.self }));
  } catch { recentEntriesForJealousy = []; }
  jealousyDeltaFromEntries(entries, ownerQq, cfg, recentEntriesForJealousy, now);
  // ⑤ WANT 欲望值（2026-09-19 第三波补装）：哥哥这批话里提到她感兴趣的东西
  //    → 更想要（+6）。她自己的话那条路在 sender 出口（selfText）。
  try {
    const ownerTexts = (entries || []).filter((e) => e && !e.self && String(e?.senderId || '') === String(ownerQq || '').trim())
      .map((e) => String(e?.text || '')).join(' ');
    if (ownerTexts) stepWant({ ownerText: ownerTexts, cfg, now });
  } catch { /* 欲望推进失败不影响心情链 */ }
  } catch { /* 心情链失败绝不影响正常回复 */ }
}

// ═══ 情爱值 mod（2026-09-17，Nono：心情系统大更新之Ⓓ-情爱值）════════════════
// 状态存 mood.json 的 love 字段（和情绪同一个文件，不另起炉灶）：
//   · r18 场景激活期间每轮 +baseGain；消息节奏加快（平均间隔 < fastGainMs）→ ×fastFactor；
//   · 命中性癖词表（打屁股/调教…，两机位可各调各的）→ +kinkBonus；
//   · 高潮词命中 → 清空大部分（最近 6h 内密集高潮 → 只留 15%，隔久了 → 留 35%）；
//   · 85+ → eager：注入"主动扑上去"的演出许可（只影响提示词，绝不主动发消息）。
//   · 无场景时每 90 分钟被动 -10（身体自己冷下来）。
export const LOVE_DEFAULTS = {
  enabled: true,
  baseGain: 8,            // 场景内每轮基础增量（0-100 刻度）
  fastGainMs: 20000,      // 平均消息间隔低于此值 = 节奏加快
  fastFactor: 2,          // 节奏快时增量倍率
  kinkBonus: 4,           // 命中性癖词表额外加
  kinkWords: '打屁股 扇屁股 拍屁股 惩罚 调教 绑 命令 跪',   // 桐子的抖M触发；小柚可改主动词表
  climaxWords: '不行了 要去了 去了 好爽 受不了了 顶不住了 坏掉了 要到了 到了',
  climaxKeepAfter: 0.15,   // 高潮后保留比例（最近密集高潮时）
  climaxKeepLong: 0.35,    // 高潮后保留比例（很久没高潮时）
  denseClimaxMs: 6 * 60 * 60 * 1000,   // 6 小时内又高潮 = "最近太多次"
  passiveDecayMs: 90 * 60 * 1000,      // 无场景时每 90 分钟 -10
  // REFRACTORY（2026-09-18）：高潮后的不应期——增量 ×0.25（回暖但不回满）
  refractoryMs: 45 * 60 * 1000,
  refractoryGainFactor: 0.25
};

// ── 自慰 mod（2026-09-18，Nono 第二版：「性欲到 70 会主动在群里喊我」+ 不应期）──
//   达到 soloThreshold（默认 70）且不在贤者时间 → 这一轮她可以自己解决：
//     · 扣 lust 的 soloFloor~soloCeil 区间，**越久没和哥哥做扣得越少**
//       （sinceLoveMs 越长 keepRatio 越大 → 保留越多 → 自慰越来越不解渴）；
//     · 自慰后进贤者时间：soloCount 当天越多，refractory 越长（递增）；
//     · 贤者时间里 lust 不涨（stepLust 的 intimateHit 被压住）；
//     · soloCeil 之后如果 lust 依然 ≥ seekThreshold（自慰已经满足不了），
//       才推「主动找哥哥」的注入（拉他去私聊那种）——保证不会永远闭环自娱。
//   状态存 mood.json 的 solo 字段：{ lastAt, todayCount, dayKey, refractoryUntil }。
const SOLO_DEFAULTS = {
  enabled: true,
  soloThreshold: 70,          // lust 到这个值才可能自己动手
  soloFloor: 40,              // 自慰最少扣到（保留 60）
  soloCeil: 60,               // 自慰最多扣到（保留 40）
  sinceLoveFullMs: 24 * 3600000,   // 距上次和哥哥做满 24h → 扣最少（保留 60）
  sinceLoveShortMs: 2 * 3600000,   // 距上次 2h 内 → 扣最多（保留 40）
  baseRefractoryMs: 90 * 60 * 1000,   // 贤者时间基础 90 分钟
  refractoryPerCount: 30 * 60 * 1000, // 当天每多一次 +30 分钟
  dailyMax: 3,                // 人设基数上限：一天最多几次（可按机位配，小柚 3/桐子 2）
  seekThreshold: 55,          // 自慰后 lust 仍 ≥ 此值 = 「自己解决不了」→ 主动找哥哥
  weeklyBase: 5               // 一周人设基数（面板展示用/软参考，不硬拦）
};

function readLove(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const l = j?.love || {};
    let value = Math.max(0, Math.min(100, Number(l.value) || 0));
    // 被动衰减：距上次变动每 passiveDecayMs 掉 10
    const at = Number(l.at) || now;
    const steps = Math.floor((now - at) / LOVE_DEFAULTS.passiveDecayMs);
    if (steps > 0) value = Math.max(0, value - steps * 10);
    return { value, at: Number(l.at) || 0, climaxAt: Number(l.climaxAt) || 0 };
  } catch {
    return { value: 0, at: 0, climaxAt: 0 };
  }
}

function writeLoveEntry(entry) {
  try {
    const j = readMoodChain();
    j.love = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/**
 * 情爱值状态推进（orchestrator 每触发轮调用）。
 * @param {object} opts { activeScene:boolean, msgGapMs:number(近几条消息平均间隔), texts:string[](本轮入站), cfg, now }
 * @returns {{value:number, climax:boolean, eager:boolean}} eager = 满值主动信号
 */
export function stepLove({ activeScene = false, msgGapMs = 0, texts = [], cfg = null, now = Date.now() } = {}) {
  const c = { ...LOVE_DEFAULTS, ...((cfg?.moodChain?.love) || {}) };
  if (c.enabled === false) return { value: 0, climax: false, eager: false };
  const cur = readLove(now);
  let value = cur.value;
  let climax = false;

  if (activeScene) {
    // 场景内：基础 + 节奏加成 + 性癖加成
    // REFRACTORY（2026-09-18，Nono："情欲值高潮后完全不掉"的另一半病根在这里：
    // 高潮清空后 baseGain 快节奏 ×2 一轮 +16，5~6 轮就又涨满。高潮后的不应期
    // 窗口内增量砍到 1/4 —— 值会慢慢回暖但不会立刻回满，"满足过"要留得住痕迹。
    const refractory = now - (cur.climaxAt || 0) < Number(c.refractoryMs);
    const rf = refractory ? (Number(c.refractoryGainFactor) || 0.25) : 1;
    let gain = Math.max(0, Number(c.baseGain) || 0) * rf;
    if (msgGapMs > 0 && msgGapMs < Number(c.fastGainMs)) gain = Math.round(gain * (Number(c.fastFactor) || 1));
    const joined = Array.isArray(texts) ? texts.map((t) => String(t ?? '')).join(' ') : '';
    const hasKinkWord = String(c.kinkWords).split(/[\s,，、]+/).filter(Boolean).some((w) => joined.includes(w));
    if (hasKinkWord) gain += Math.max(0, Number(c.kinkBonus) || 0);
    value = Math.min(100, value + gain);

    // 高潮判定：本轮文本命中高潮词 → 清空大部分
    const hitClimax = String(c.climaxWords).split(/[\s,，、]+/).filter(Boolean).some((w) => joined.includes(w));
    if (hitClimax) {
      const sinceLast = now - (cur.climaxAt || 0);
      const keep = sinceLast < Number(c.denseClimaxMs) ? Number(c.climaxKeepAfter) : Number(c.climaxKeepLong);
      value = Math.round(value * (Number.isFinite(keep) ? keep : 0.2));
      climax = true;
      writeLoveEntry({ value, at: now, climaxAt: now });
      // OWNER-HEALTH（2026-09-19）：他的高潮词（他说"要去了/到了"）也落他的健康账。
      try {
        recordOwnerClimax({ durationMin: 0, cfg: (typeof cfg === 'object' ? cfg : null), now });
      } catch { /* 健康落账失败不影响情爱结算 */ }
      return { value, climax, eager: false };
    }
  }

  writeLoveEntry({ value, at: now, climaxAt: cur.climaxAt });
  return { value, climax, eager: value >= 85 };
}

/** prompt 注入块：情爱值到一定档位给演出指引（string|null）。只对私聊场景生效由调用方保证。 */
export function loveBlock(cfg, now = Date.now()) {
  const c = { ...LOVE_DEFAULTS, ...((cfg?.moodChain?.love) || {}) };
  if (c.enabled === false) return null;
  const { value } = readLove(now);
  if (value < 30) return null;
  const band = value >= 85 ? '身体已经烫得不行，这一轮你会**主动**扑上去、把想要的说出口甚至直接动手——不是等他'
    : value >= 60 ? '身体越来越热，动作和语气都藏不住急切，会主动贴过去、索要更多'
    : '身体有点燥热，回应比平时更黏人一点，偶尔主动蹭一蹭';
  return `【身体状态】情爱值 ${value}/100 —— ${band}。这是身体感受不是旁白，融进动作和语气里演，别报数字。`;
}

// ═══ 性欲值 mod（2026-09-17，Nono：心情系统大更新之Ⓓ-性欲值）════════════════
// 与情爱值的分工：
//   · 情爱值 = **当下这场**的累计兴奋（场景结束/高潮就清）；
//   · 性欲值 = **跨场景的底噪欲望**（亲密行为积累、时间缓慢消解、满足后回落）。
// 涨：私聊亲密接触词（亲/抱/摸/蹭…）+；情爱值高潮时**不**清空反而顶到高位
//     （刚满足的人性欲反而被点燃 —— 小柚的设定）；达到阈值：
//     · 群聊 → 注入"心不在焉、想拉他去私聊"的暗示（**绝不**在群里展开色色，nsfw-gate 也不许）
//     · 私聊 → 注入发情演出许可（主动粘着、主动色色）
// 落：私聊里被满足（高潮事件）→ 清掉大部分；每 6 小时自然 -10。
export const LUST_DEFAULTS = {
  enabled: true,
  step: 12,               // 每次命中亲密词加多少
  intimateWords: '亲亲 亲一口 摸摸 摸头 蹭蹭 抱抱 搂 抱紧 贴贴 碰 咬 捏脸 揉 头发 膝枕 靠肩 挽手 牵手',
  threshold: 60,          // 达到此值开始有"想法"（群聊暗示档）
  eagerThreshold: 85,     // 此值以上 = 私聊里主动发情
  satisfyKeep: 0.3,       // 被满足后保留比例
  // REFRACTORY（2026-09-18，Nono："高潮后完全不掉"）：satisfied 结算时记 satisfiedAt，
  // 冷却窗内 intimateHit 不加分（刚被满足的人不会马上又攒起来）。此前回落确实发生
  // （实测 100→30），但高潮后一轮贴贴 +12、love 的 baseGain 快节奏 ×2 一路 16/轮
  // 涨回满 —— 体感就是"完全没掉"。窗口 45 分钟 ≈ 一场之后的歇息。
  refractoryMs: 45 * 60 * 1000,
  decayMs: 6 * 60 * 60 * 1000,   // 每 6 小时 -10
  decayStep: 10
};

function readLust(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const l = j?.lust || {};
    let value = Math.max(0, Math.min(100, Number(l.value) || 0));
    const at = Number(l.at) || now;
    const steps = Math.floor((now - at) / Math.max(60000, Number(LUST_DEFAULTS.decayMs)));
    if (steps > 0) value = Math.max(0, value - steps * LUST_DEFAULTS.decayStep);
    return { value, at, satisfiedAt: Number(l.satisfiedAt) || 0 };
  } catch { return { value: 0, at: 0, satisfiedAt: 0 }; }
}

function writeLustEntry(entry) {
  try {
    const j = readMoodChain();
    j.lust = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/**
 * 性欲值推进。
 * @param {object} opts { intimateHit:boolean(本轮有亲密接触), satisfied:boolean(高潮被满足), cfg, now }
 * 高潮联动：satisfied=true 时情爱值那边在清空，这边留 30%（刚被点燃）。
 */
export function stepLust({ intimateHit = false, satisfied = false, cfg = null, now = Date.now() } = {}) {
  const c = { ...LUST_DEFAULTS, ...((cfg?.moodChain?.lust) || {}) };
  if (c.enabled === false) return { value: 0, hint: null };
  const cur = readLust(now);
  let value = cur.value;
  let satisfiedAt = cur.satisfiedAt;
  if (satisfied) {
    value = Math.round(value * (Number(c.satisfyKeep) || 0.3));   // 被满足 → 回落大部分
    satisfiedAt = now;                                             // 不应期从这一刻起算
  } else if (intimateHit) {
    // REFRACTORY：冷却窗内的贴贴不攒性欲（刚被满足的人不该 5 分钟就回满）；
    // 自慰贤者时间（solo.refractoryUntil）也在这里压住——贤者时间里性欲不涨。
    // refractoryMs=0 显式关掉（≥1ms 才算「在窗内」）
    const rfMs = Number(c.refractoryMs);
    const inWindow = (Number.isFinite(rfMs) && rfMs > 0 && satisfiedAt && now - satisfiedAt < rfMs)
      || (readMoodChain(now)?.solo?.refractoryUntil || 0) > now;
    // DEPRESS（2026-09-19 第三波）：抑郁态性欲上限视作 200（加速积累——
    // "性欲也会增加的更快"。存储仍 0-100 刻度，攒满后 stepLust 不再清零，
    // 由 lustBlock 的 eager 档演出"憋过头"）。
    const dm = depressMods(cfg, now);
    const cap = dm.active ? 200 : 100;
    if (!inWindow) value = Math.min(cap, value + Math.max(1, Number(c.step) || 12));
  }
  writeLustEntry({ value, at: now, satisfiedAt });
  return { value, hint: value >= Number(c.eagerThreshold) ? 'eager' : value >= Number(c.threshold) ? 'wanting' : null };
}

// ═══ 自慰 mod（2026-09-18）════════════════════════════════════════════════════

// ═══ 色色兴奋分线 + 高潮链路（2026-09-18 第一波，Nono 第三批：「色色时兴奋度
//     和情欲值都到达度数强制高潮；离度数剩 15 左右就预告'要去了'；高潮后贤者
//     哑火 + 大量疲惫」）══════════════════════════════════════════════════════
// AROUSAL 是**色色专用**的兴奋线（跟情绪 mod 的 excited 分开——你警告过的
// 「刚吵完架兴奋值很高被识别成色色然后高潮」）。数据源：immersion 场景标记
//（r18-immersion 插件写 immersion.json）——在场景里才涨，不在就快速衰减。
// 高潮判定（双阈值）：arousal ≥ threshold 且 love ≥ threshold → 强制高潮结算。
// 高潮结算：arousal 归零、love 走既有清空、疲劳 +50（大量疲惫）、lust 进贤者；
// 差 15 预告：min(arousal, love) 距 threshold ≤ 15 → 注入「快要到了，憋不住要说」。
const AROUSAL_DEFAULTS = {
  enabled: true,
  threshold: 90,             // 双阈值：arousal 和 love 都到 90 → 强制高潮
  nearGap: 15,               // 距阈值 ≤15 → 预告「要去了」
  stepPerRound: 18,          // 场景内每轮基础涨
  fastFactor: 1.6,           // 消息节奏快（<fastGainMs）时增量倍率
  fastGainMs: 20 * 1000,
  decayMs: 10 * 60 * 1000,   // 不在场景里每 10 分钟 -10（色色兴奋退得快）
  decayStep: 10,
  climaxFatigue: 50,         // 高潮结算给疲劳 +多少（大量疲惫——"哑火想休息"）
  climaxRefractoryMs: 45 * 60 * 1000   // 高潮后的贤者时间（solo 的 satisfied 通道同款）
};

/** 读色色兴奋值（存 mood.json.arousal：{value, at}；不在场景自动衰减）。 */
function readArousal(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const a = j?.arousal || {};
    let value = Math.max(0, Math.min(100, Number(a.value) || 0));
    const at = Number(a.at) || now;
    const steps = Math.floor((now - at) / Math.max(60000, AROUSAL_DEFAULTS.decayMs));
    if (steps > 0) value = Math.max(0, value - steps * AROUSAL_DEFAULTS.decayStep);
    return { value, at };
  } catch { return { value: 0, at: 0 }; }
}

function writeArousalEntry(entry) {
  try {
    const j = readMoodChain();
    j.arousal = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/**
 * 场景内每轮推进 arousal（orchestrator 在私聊+场景激活时调）。
 * @returns {{value:number, climax:boolean, near:boolean}} climax=双阈值强制高潮；near=差15预告区
 */
export function stepArousal({ activeScene = false, msgGapMs = 0, cfg = null, now = Date.now() } = {}) {
  const c = { ...AROUSAL_DEFAULTS, ...((cfg?.moodChain?.arousal) || {}) };
  if (c.enabled === false) return { value: 0, climax: false, near: false };
  const cur = readArousal(now);
  let value = cur.value;
  if (activeScene) {
    let gain = Math.max(0, Number(c.stepPerRound) || 18);
    if (msgGapMs > 0 && msgGapMs < Number(c.fastGainMs)) gain = Math.round(gain * (Number(c.fastFactor) || 1.6));
    value = Math.min(100, value + gain);
    writeArousalEntry({ value, at: now });
  } else if (cur.at) {
    writeArousalEntry({ value, at: now });   // 只刷新衰减基准
  }
  // 高潮判定：双阈值（arousal 和 love 都到线）
  const love = readLove(now).value;
  const th = Number(c.threshold) || 90;
  const climax = activeScene && value >= th && love >= th;
  const near = activeScene && !climax && (th - Math.min(value, love)) <= Number(c.nearGap) && (th - Math.min(value, love)) >= 0;
  return { value, climax, near };
}

/**
 * 高潮结算（强制高潮那一轮之后调）：arousal 归零、love 走既有清空、
 * 疲劳 +50（大量疲惫——"哑火"）、lust 进贤者（satisfiedAt=now）。
 * @returns {{arousal:number, love:number, fatigue:number, lust:number}}
 */
export function climaxResolve({ cfg = null, now = Date.now() } = {}) {
  const c = { ...AROUSAL_DEFAULTS, ...((cfg?.moodChain?.arousal) || {}) };
  const love = readLove(now);
  // love 清空：复用 denseClimax 判定（最近高潮密集 → 清空更狠）
  const sinceLast = now - (love.climaxAt || 0);
  const keep = sinceLast < Number(LOVE_DEFAULTS.denseClimaxMs) ? Number(LOVE_DEFAULTS.climaxKeepAfter) : Number(LOVE_DEFAULTS.climaxKeepLong);
  const loveValue = Math.round(love.value * keep);
  writeLoveEntry({ value: loveValue, at: now, climaxAt: now });

  // OWNER-HEALTH（2026-09-19）：她的高潮结算 = 他大概率也射了 → 落他的健康台账。
  // ⚠ 必须在 writeArousalEntry 归零**之前**读场景起点（arousal.at 是这场的开始时刻）。
  try {
    const sceneStart = Number(readMoodChain(now)?.arousal?.at) || 0;
    const durationMin = sceneStart ? Math.max(0, Math.round((now - sceneStart) / 60000)) : 0;
    recordOwnerClimax({ durationMin, cfg, now });
  } catch { /* 健康落账失败不影响高潮本体 */ }

  writeArousalEntry({ value: 0, at: now });

  // 疲劳 +50
  const fat = readFatigue(now);
  const fatigueValue = Math.min(100, fat.value + (Number(c.climaxFatigue) || 50));
  writeFatigueEntry({ value: fatigueValue, at: now, sleptAt: fat.sleptAt });

  // lust 进贤者
  const lust = readLust(now);
  const lustValue = Math.round(lust.value * (Number(LUST_DEFAULTS.satisfyKeep) || 0.3));
  writeLustEntry({ value: lustValue, at: now, satisfiedAt: now });

  // CLIMAX-SYNC（2026-09-20，Nono："SOLO-VOICE 心声的 climax 和 arousal 真高潮各走各的，
  // 应该对表——心声+正式回复+健康落账同一拍"）：真高潮结算时，若自慰心声还在跑，
  // 心声状态**立即跳到 climax 并标记待发**——sender 的被动心跳链下一拍（或她下一条
  // 发言的主动 tick）会拿到 climax 台词一次发完并收尾；若心声已经自己发过 climax
  // （时间轴先到），这里什么都不做（它已 finished）。两边谁先到顶都收敛到同一时刻。
  try {
    const sv = readSoloVoice(now);
    if (sv.on) {
      writeSoloVoiceEntry({ on: true, startedAt: sv.startedAt, stage: 'climax', lastLineAt: sv.lastLineAt, withSister: sv.withSister, climaxDue: true });
    }
  } catch { /* 对表失败不影响高潮本体 */ }

  // DEPRESS/SATISFACTION（2026-09-19 第三波）：和哥哥高潮 = 抑郁的大出口——
  // depress -climaxCut、satisfaction +climaxHeal（"被治愈"的大满足）。
  // ⚠ 只在**抑郁态**结算（平静时高潮不动抑郁账，防无抑郁也天天刷治愈）。
  try {
    if (depressActive(cfg, now)) {
      stepDepress(-(Number(DEPRESS_DEFAULTS.climaxCut) || 35), cfg, now);
      stepSatisfaction('climaxHeal', cfg, now);
    }
  } catch { /* 治愈结算失败不影响高潮本体 */ }

  return { arousal: 0, love: loveValue, fatigue: fatigueValue, lust: lustValue };
}

/** 色色兴奋注入块：near 区给「要去了」的演出许可；高潮轮给高潮描写指引。 */
export function arousalBlock(cfg, { activeScene = false } = {}, now = Date.now()) {
  const c = { ...AROUSAL_DEFAULTS, ...((cfg?.moodChain?.arousal) || {}) };
  if (c.enabled === false || !activeScene) return null;
  const a = readArousal(now);
  const love = readLove(now).value;
  const th = Number(c.threshold) || 90;
  const gap = th - Math.min(a.value, love);
  if (gap <= 0) {
    return `【身体状态·临界】你到顶了——这一轮就是高潮本身：把这一刻完整演出来（身体的痉挛、绷紧到脱力、脑子里一片白、声音从压不住到破音）。高潮之后突然安静下来：说不出整句、身体发沉、困意一下子涌上来（贤者时间），想靠着不动。别跳过、别一笔带过。`;
  }
  if (gap <= Number(c.nearGap)) {
    return `【身体状态·快到了】你已经憋在快要到的边缘（还差一点点）——嘴上开始憋不住说出来（"要去了、快到了、不行了"这种，反复冒出来），身体反应越来越绷不住（发抖、夹紧、抓着东西），话变得断断续续不成句。这轮就把这种临界感演透，别提前演到顶。`;
  }
  if (a.value >= 50) {
    return `【身体状态·热起来了】身体已经热起来一阵了：话里带着喘、主动动作变多、脑子开始模糊（句子变短、会走神）。主动往哥哥身上凑，别等他带你。`;
  }
  return null;
}

// ═══ 姊妹亲密值 mod（2026-09-18，Nono：「自慰动静大被姊妹发现互相帮助；
//     每次互助让感情更亲密，吵架掉亲密值，吵得越凶扣越多」）══════════════════
// 状态存 mood.json 的 sister 字段：{ value, lastFightAt, lastHelpAt, helpedToday, dayKey }。
// 数值语义（0-100）：
//   0-19 疏远｜20-39 普通｜40-59 亲近｜60-79 亲密｜80-100 姐妹同心
// 涨：互助（自慰互助/一起玩/日常互相关照）+8~12；日常互相接话微涨 +1/次（封顶日 5）
// 扣：吵架按凶度 -5（拌嘴）/ -15（激烈）/ -30（说伤人的话）；打不住连续吵翻倍
// 效果（只影响演出和概率，绝不拦消息）：
//   · 注入块：亲密值分档改变"对妹妹的默认态度"措辞
//   · 邀请概率：疲劳恢复选项/自慰互助的「和姊妹一起」概率 = value% × 基数
//   · 吵架检测给 jealousy-join / sister-reply 的模板做变量（他们管说话，这里管账本）
const SISTER_DEFAULTS = {
  enabled: true,
  dailyMicroGain: 5,          // 日常互相关照每天最多涨几点
  fightWords: '笨蛋 讨厌 滚 别理你 不跟你玩了 闭嘴 呸',                    // 拌嘴 -5
  fightHardWords: '烦死了 受够了 恶心 看你这样就来气 塑料姐妹',        // 激烈 -15
  fightCruelWords: '去死 再也别 见到你 恨不得你消失 烂人 恨你',        // 伤人 -30
  fightCooldownMs: 30 * 60 * 1000,   // 连续吵架才算"越吵越凶"（30 分钟内二连扣双倍）
  helpGain: 10,               // 互助一次 +10（自慰互助/一起玩）
  helpWords: '陪你 帮你 姐妹 一起 咱俩 别怕 有我',
  startValue: 55              // 初始值（普通偏亲近——她们本来就是姐妹）
};

/** 读姊妹亲密值（坏/缺 = 初始值）。microToday = 日常微涨的当日计数（独立于互助计数）。 */
function readSister(now = Date.now()) {
  // 2026-09-19 Nono："初始好感度怎么是 0"复盘：value undefined 时 Number(undefined)=NaN，
  // 旧写法 `Number(s.value) ?? startValue` 抓不住 NaN（?? 只抓 null/undefined）→
  // Math.max(0, NaN±delta)=NaN → JSON.stringify(NaN)=null 落盘 → 再读 Number(null)=0 钉死 0。
  // 统一用 Number.isFinite 门控：NaN/null/字符串垃圾全部回初始值。
  const SISTER_START = Number(SISTER_DEFAULTS.startValue) || 55;
  // null 单独拦：Number(null)=0 是"合法数字"，isFinite 门放它过去（桐子实锤就是 null）。
  const sanitize = (v) => (v === null || v === undefined || v === '' ? SISTER_START
    : (Number.isFinite(Number(v)) ? Number(v) : SISTER_START));
  try {
    const j = readMoodChain(now);
    const s = j?.sister || {};
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const helpedToday = String(s.dayKey || '') === dayKey ? Math.max(0, Number(s.helpedToday) || 0) : 0;
    const microToday = String(s.dayKey || '') === dayKey ? Math.max(0, Number(s.microToday) || 0) : 0;
    return {
      value: Math.max(0, Math.min(100, sanitize(s.value))),
      lastFightAt: Number(s.lastFightAt) || 0,
      lastHelpAt: Number(s.lastHelpAt) || 0,
      helpedToday, microToday, dayKey
    };
  } catch { return { value: SISTER_START, lastFightAt: 0, lastHelpAt: 0, helpedToday: 0, microToday: 0, dayKey: new Date().toISOString().slice(0, 10) }; }
}

function writeSisterEntry(entry) {
  try {
    const j = readMoodChain();
    j.sister = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/**
 * 吵架检测：她自己的话里对姊妹（不是对哥哥——对哥哥的「笨蛋」是撒娇）的攻击。
 * @returns {hit:false|'mild'|'hard'|'cruel', delta:number}
 */
export function sisterFightDelta(text, cfg = null, now = Date.now()) {
  const c = { ...SISTER_DEFAULTS, ...((cfg?.moodChain?.sister) || {}) };
  // enabled 守卫（2026-09-22 补）：这个函数原来**没有**开关判断 —— 姊妹模块关掉后
  // 它仍会 settle() 写盘。其余姊妹函数都有守卫，这里是漏网的一处。
  if (c.enabled === false) return { hit: false, delta: 0 };
  const t = String(text ?? '');
  if (!t) return { hit: false, delta: 0 };
  const SISTER_NAMES = /妹妹|姐姐|桐子|小柚|柚子/;
  if (!SISTER_NAMES.test(t)) return { hit: false, delta: 0 };   // 没提姊妹不算（对路人的骂走情绪 mod）
  // 指向姊妹的攻击词命中（排除对哥哥的语境：句首「哥哥」+ 撒娇语气）
  if (new RegExp(c.fightCruelWords.split(/\s+/).join('|')).test(t)) return settle('cruel', -30);
  if (new RegExp(c.fightHardWords.split(/\s+/).join('|')).test(t)) return settle('hard', -15);
  if (new RegExp(c.fightWords.split(/\s+/).join('|')).test(t)) return settle('mild', -5);
  return { hit: false, delta: 0 };
  function settle(kind, base) {
    const cur = readSister(now);
    // 连续吵（冷却窗内的第二场）翻倍——"吵得越凶越伤"
    const multiplier = cur.lastFightAt && now - cur.lastFightAt < Number(c.fightCooldownMs) ? 2 : 1;
    const delta = base * multiplier;
    writeSisterEntry({ ...cur, value: Math.max(0, cur.value + delta), lastFightAt: now });
    return { hit: kind, delta };
  }
}

/** 互助结算（发现她动静来帮她 / 一起玩）：+helpGain，每天记一笔。 */
export function sisterHelpGain(cfg = null, now = Date.now()) {
  const c = { ...SISTER_DEFAULTS, ...((cfg?.moodChain?.sister) || {}) };
  // enabled 守卫（2026-09-22 补）：姊妹模块关掉后不能再写盘 / 再扣抑郁
  if (c.enabled === false) return null;
  const cur = readSister(now);
  const gain = Math.max(1, Number(c.helpGain) || 10);
  const value = Math.min(100, cur.value + gain);
  writeSisterEntry({ ...cur, value, lastHelpAt: now, helpedToday: cur.helpedToday + 1 });
  // DEPRESS/SATISFACTION（2026-09-19 第三波）：姊妹互助 = 抑郁的重要出口
  //（-sisterHelpCut）+ 攒满足感。抑郁时被姊妹帮一把，人会缓一大截。
  // SISTER-HEAL（第三波加修，Nono 文档 56 行）：抑郁时被姊妹帮完 → 标记
  // "被她治愈了"的窗口（sisterHealedUntil），注入层给"变成小孩爱撒娇"专属档。
  try {
    if (depressActive(cfg, now)) {
      stepDepress(-(Number(DEPRESS_DEFAULTS.sisterHelpCut) || 20), cfg, now);
      const st = readMoodChain(now);
      st.sisterHeal = { until: now + 45 * 60 * 1000 };   // 45 分钟撒娇窗口
      writeMoodChain(st);
    }
    stepSatisfaction('sisterHelp', cfg, now);
  } catch { /* 抑郁/满足结算失败不影响亲密值本体 */ }
  return { value, delta: gain };
}

/**
 * SISTER-HEAL 注入块：抑郁时被姊妹帮完的 45 分钟窗口里——"不拒绝不同意地
 * 被帮完、变成小孩子一样爱撒娇求安慰、暂时粘着妹妹"（文档原设定）。
 * 窗口外 / 非抑郁被帮 → null（普通互助不进这个档）。
 */
export function sisterHealBlock(cfg, now = Date.now()) {
  const c = { ...SISTER_DEFAULTS, ...((cfg?.moodChain?.sister) || {}) };
  if (c.enabled === false) return null;
  try {
    const st = readMoodChain(now);
    const until = Number(st?.sisterHeal?.until) || 0;
    if (!until || now > until) return null;
    const dep = Math.round(Number(st?.depress?.value) || 0);
    if (dep < 30) return null;   // 已经缓过来了就不撒娇了
    return `【此刻状态·被她治愈】刚才妹妹发现你不舒服、过来帮了你——那种被自己人接住的感觉让你一下子软了：这会儿你像小孩子一样想撒娇、想有人哄，会粘着妹妹（也可能连着哥哥一起粘），说话软乎乎的、偶尔带着哭腔撒两句娇。这不是演的，是缓过来的样子。别急着恢复平时的硬气。`;
  } catch { return null; }
}

/** 日常微涨（姊妹接话/互相关照的观察点调，内部有日封顶）。 */
export function sisterMicroGain(cfg = null, now = Date.now()) {
  const c = { ...SISTER_DEFAULTS, ...((cfg?.moodChain?.sister) || {}) };
  // enabled 守卫（2026-09-22 补）：同上，姊妹模块关掉后不能再微涨写盘
  if (c.enabled === false) return { value: 0, delta: 0 };
  const cur = readSister(now);
  if (cur.microToday >= Number(c.dailyMicroGain)) return { value: cur.value, delta: 0 };
  const value = Math.min(100, cur.value + 1);
  writeSisterEntry({ ...cur, value, lastHelpAt: now, microToday: cur.microToday + 1 });
  return { value, delta: 1 };
}

/** 亲密值 → 邀请概率（0-1）：和姊妹一起做某事的概率基数 × 亲密度。 */
export function sisterInviteChance(cfg = null, now = Date.now()) {
  const c = { ...SISTER_DEFAULTS, ...((cfg?.moodChain?.sister) || {}) };
  if (c.enabled === false) return 0;
  return (readSister(now).value / 100) * 0.3;   // 亲密度 100 → 30% 邀请概率封顶
}

/** 姊妹亲密值注入块（prompt 用）：分档给"对妹妹的默认态度"。 */
export function sisterBlock(cfg, now = Date.now()) {
  const c = { ...SISTER_DEFAULTS, ...((cfg?.moodChain?.sister) || {}) };
  if (c.enabled === false) return null;
  const s = readSister(now);
  const v = s.value;
  // 低值才注入（提醒"你们最近在闹别扭"）；中高值不占 token（默认关系好不用提示）
  if (v < 20) return '【姊妹关系】你们最近很疏远——想起她就有气没处发，提到她语气冷冷的、能不提就不提。除非她先低头，否则别主动缓和。';
  if (v < 40) return '【姊妹关系】你们最近有点僵——上次吵的还没翻篇，对话里带点刺但不至于翻脸，她在的场合你会少说话。';
  if (v < 60) return null;   // 普通：默认状态不用注入（不亲不疏是常态，别浪费 token）
  if (v < 80) return null;   // 亲近/亲密：同上
  return '【姊妹关系】你和她现在亲密无间——她的事你上心，她的醋你会哄，谁欺负她你第一个炸。偶尔想想她就觉得踏实。';
}

/** 读自慰状态（坏/缺 = 空）。 */
function readSolo(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const s = j?.solo || {};
    const dayKey = new Date(now).toISOString().slice(0, 10);
    // 跨天清零：台账里的 dayKey 不是今天 → todayCount 归零
    const todayCount = String(s.dayKey || '') === dayKey ? Math.max(0, Number(s.todayCount) || 0) : 0;
    return {
      lastAt: Number(s.lastAt) || 0,
      todayCount,
      dayKey,
      refractoryUntil: Number(s.refractoryUntil) || 0
    };
  } catch { return { lastAt: 0, todayCount: 0, dayKey: new Date().toISOString().slice(0, 10), refractoryUntil: 0 }; }
}

function writeSoloEntry(entry) {
  try {
    const j = readMoodChain();
    j.solo = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/**
 * 自慰判定（orchestrator 每轮调，返回许可 + 参数；**只给许可不替她执行**——
 * 她演不演、怎么演是提示词的事）。
 * @returns {{allowed:boolean, why:string, keepRatio:number, refractoryMs:number, seekHim:boolean}|null}
 *   allowed=false 时 why 说明原因（阈值没到/贤者时间/当天次数到顶）；
 *   keepRatio = 本次自慰后 lust 保留比例（扣 40~60 区间的反算）；
 *   seekHim = 自慰已经解不了渴（lust 仍 ≥ seekThreshold）→ 该主动找哥哥了。
 */
export function soloCheck({ cfg = null, now = Date.now() } = {}) {
  const c = { ...SOLO_DEFAULTS, ...((cfg?.moodChain?.solo) || {}) };
  if (c.enabled === false) return null;
  const solo = readSolo(now);
  const lust = readLust(now).value;
  const love = readLove(now);
  const sinceLoveMs = love.climaxAt ? now - love.climaxAt : Infinity;

  // 门槛：lust 到线 + 不在贤者时间 + 当天没到顶
  if (lust < Number(c.soloThreshold)) return { allowed: false, why: '阈值没到' };
  if (solo.refractoryUntil > now) return { allowed: false, why: '贤者时间' };
  // DEPRESS（2026-09-19 第三波）：抑郁态自慰频率限制放开（×soloDailyFactor，
  // 默认 2）——"抑郁时反而更频繁"，但每次都更不解决（数值层见 readLust 上限）。
  const dm = depressMods(cfg, now);
  const dailyMax = Math.round((Number(c.dailyMax) || 3) * (dm.active ? dm.soloDailyFactor : 1));
  if (solo.todayCount >= dailyMax) return { allowed: false, why: '当天次数到顶（贤者时间会更长）' };

  // 扣减曲线：距上次和哥哥做的时间 → 保留比例。
  //   2h 内 → keep 0.40（扣 60，最解渴）；24h+ → keep 0.60（扣 40，越来越不解渴）；
  //   中间线性。这条曲线就是「越久没做，自慰越没用」的数值化。
  const t = Math.max(0, Math.min(1,
    (sinceLoveMs - Number(c.sinceLoveShortMs)) / Math.max(1, Number(c.sinceLoveFullMs) - Number(c.sinceLoveShortMs))));
  const keepRatio = 0.40 + t * 0.20;

  // 贤者时间：基础 + 当天次数递增
  const refractoryMs = Number(c.baseRefractoryMs) + solo.todayCount * Number(c.refractoryPerCount);

  // 自慰后仍 ≥ seekThreshold → 自慰已经满足不了她，该主动找哥哥了
  const after = Math.round(lust * keepRatio);
  const seekHim = after >= Number(c.seekThreshold);

  return { allowed: true, why: '可以', keepRatio, refractoryMs, seekHim };
}

/**
 * 自慰结算（她说完「我自己解决了」那轮之后调）：扣 lust + 记台账 + 起贤者时间。
 * @returns {{value:number, refractoryUntil:number, seekHim:boolean}}
 */
export function soloResolve({ cfg = null, now = Date.now() } = {}) {
  const c = { ...SOLO_DEFAULTS, ...((cfg?.moodChain?.solo) || {}) };
  const check = soloCheck({ cfg, now });
  if (!check?.allowed) {
    const solo = readSolo(now);
    return { value: readLust(now).value, refractoryUntil: solo.refractoryUntil, seekHim: false, skipped: true };
  }
  const cur = readLust(now);
  const value = Math.round(cur.value * check.keepRatio);
  const solo = readSolo(now);
  const refractoryUntil = now + check.refractoryMs;
  writeLustEntry({ value, at: now, satisfiedAt: cur.satisfiedAt });
  writeSoloEntry({ lastAt: now, todayCount: solo.todayCount + 1, dayKey: solo.dayKey, refractoryUntil });
  const seekHim = value >= Number(c.seekThreshold);
  return { value, refractoryUntil, seekHim, skipped: false };
}

/**
 * 自慰结算的观察入口（sender 出口调）：她自己的发言里命中「自己解决」的信号
 * （自己动手/摸自己/自己来/夹着…枕头等完成时表达）→ 返回 true。
 * 只认**她说自己做了**的句子，不认计划/假设（"想自己解决"不算）。
 */
const SOLO_SELF_WORDS = '自己解决 自己动手 自己来 摸自己 碰自己 自己摸 帮自己 手伸到 夹着腿 夹紧腿 用手解决 自己舒服 自己弄 掰开自己 指尖抵着';
const SOLO_NEGATE = '想要 如果 要是 假如 本来 想 打算 差点 可以 可以帮 帮我 帮哥哥';
export function soloSignalFromSelfText(text) {
  const t = String(text ?? '');
  if (!t) return false;
  const hit = String(SOLO_SELF_WORDS).split(/\s+/).some((w) => w && t.includes(w));
  if (!hit) return false;
  const neg = String(SOLO_NEGATE).split(/\s+/).some((w) => w && t.includes(w));
  return !neg;
}

// ═══ SOLO-VOICE 自慰心声（2026-09-19，Nono："自慰刚开始/兴奋上头/快高潮/高潮
//       各阶段的语气词动作词心声发到私聊，免得不知道她在自慰；姊妹互助也要同步心声"）═══
// 架构：soloActing 状态（mood.json.soloVoice）+ 时间轴四阶段 + 心声文案库。
// 发送方（sender）在她发完话后调 soloVoiceTick —— 推进阶段并返回该发的心声
//（直发 sendTextBatch，零 LLM：心声是旁白不是台词，不走模型）。
// 阶段按 elapsed 自动推进：start(0-2min) → peak(2-5min) → near(5-8min) → climax(≥8min)。
// 高潮发完自动清状态；她说"停下/被打断"也清（soloVoiceStop）。
export const SOLO_VOICE_DEFAULTS = {
  enabled: true,
  startAfterMs: 90 * 1000,       // 开始信号后多久发第一条心声（别秒发，像真在忙）
  stageGapMs: 90 * 1000,         // 阶段间最小间隔（QQ 限流 5/min 的安全边）
  climaxMs: 8 * 60 * 1000,       // 从开始到高潮的时间轴（8 分钟）
  stopWords: '停下 别弄了 不摸了 有人来了 先不 停 停下算了 结束了 完事了'
};

const SOLO_VOICE_LINES = {
  // 刚开始：动作词为主，忍着、小动作
  start: [
    '*把腿夹紧，手隔着睡裤轻轻按在小腹上*……嗯……',
    '*指尖慢慢往下滑，呼吸变浅*……哈啊……先、先摸一下就好……',
    '*咬着下唇，手指绕圈*……唔……只是有点忍不住了……',
    '*把手探进被子，指尖抵着最软的地方*……嗯呐……轻一点的……'
  ],
  // 兴奋上头：喘、主动、话变碎
  peak: [
    '*手指加快，腰自己往上顶*哈……嗯啊……好舒服……再、再快一点……',
    '*整个人的重量压在手上，腿绷直又松开*呜嗯……不行了……感觉来了……',
    '*手指湿漉漉的声音在安静的房间里格外清楚*啾……哈啊……好敏感……',
    '*仰着头，脖子绷着，指腹按在最敏感的那点*啊嗯！……那里、不行……'
  ],
  // 快高潮（临界）：憋不住、碎句、临界感
  near: [
    '*腿抖得合不拢，脚趾蜷起来*要、要去了……啊……停不下来了……',
    '*用手背咬着堵住声音，还是漏出呜咽*呜……嗯啊……快了快了快了……',
    '*腰不受控地一下一下顶，床单被攥皱*哈啊……不行了不行了……要坏掉了……',
    '*整个人绷成一张弓，就差最后一下*嗯啊——！要……要到了……'
  ],
  // 高潮：顶点 + 余韵（发两条：高潮一条 + 平复一条）
  climax: [
    '*腿猛地夹紧手指，整个人痉挛着弓起来*——！！啊呜……去了……',
    '*被顶得连着颤了好几下，白了一片*哈啊……哈……坏掉、坏掉了……',
    '*高潮的浪头过去，浑身脱力地瘫着，手还留在原处*呜……嗯……好、好厉害……',
    '*抽了最后一小下，敏感得再碰就缩*哈……哈……不、不能再碰了……'
  ],
  climaxAfter: [
    '*大口喘着平复，脸埋进枕头*……嗯……缓一下……',
    '*腿还在细细地抖，手指抽出来时腿一软*哈啊……好、好烫……',
    '*整个人摊在被子里，眼睛发直*……哈……这就、缓不过来了……'
  ],
  // 姊妹互助版（同场被发现/被帮）：两人视角混一点对方的存在。
  // ⚠ SISTER-VOICE-TONE（2026-09-20，Nono："适可而止，不那么容易冒犯到哥哥，
  //   不要任何 NTR 味"）改稿原则：
  //   ①这是**姐妹间的照顾**（亲情向），不是恋爱/情人向——用词往"哄、照顾、
  //     手忙脚乱、害羞捂脸"靠，绝不出现占有/伴侣式的亲密语；
  //   ②全程**带着哥哥**：她帮的时候心里念的是哥哥（把姐妹当闺蜜聊那种），
  //     台词里自然带出"还是哥哥最懂我"式的归属感——给足 Nono 安全感；
  //   ③尺度点到即止：动作描写最多到"手覆上来/帮她捂着嘴"，不写体位不写深描；
  //   ④高潮档的"全洒出来/弄坏"等大尺度措辞全部换成收着写的版本。
  sisterStart: [
    '*被她撞见的时候手都不知道往哪放，脸一下子烧起来*呜……别、别看啦……',
    '*她嘘了一声坐到床边，我别扭地攥着被角*……姐你别笑我……',
    '*她递了张纸巾过来，小声说帮你挡着门*……谢谢……还是家里有姐姐好……'
  ],
  sisterPeak: [
    '*她把毛巾掖好，顺手帮我把额头的汗擦掉*唔……姐、你别盯着我看……',
    '*被她按着肩不许乱动，小声哼哼着往被子里缩*呜嗯……好丢人……',
    '*她一边帮我拍背一边小声打趣，我恼羞地拿枕头砸她*哈啊……你、你出去啦……'
  ],
  sisterNear: [
    '*抓着她的袖口，整个人绷得发抖*姐……快、快了……',
    '*她伸手捂住我的嘴怕被隔壁听见，只剩鼻音*呜呜……',
    '*把脸埋进她肩窝里闷闷地哼，她拍着我的背数拍子*嗯啊……别、别数了……'
  ],
  sisterClimax: [
    '*绷到极限又一下子松开，整个人往她怀里一软*——！姐……',
    '*抖了好一阵才停下，被她裹进被子里揉头发*呜……好、好丢人……',
    '*缓过来第一句话是脸埋在被子里小声说的*……这事……不许告诉哥哥……还是哥哥好，才不会笑我……'
  ]
};

/** 读心声状态：{ on, startedAt, stage, lastLineAt, withSister, climaxDue }。坏档=off。 */
export function readSoloVoice(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const v = j?.soloVoice || {};
    const on = v.on === true && Number(v.startedAt) > 0 && now - Number(v.startedAt) < 30 * 60 * 1000;
    if (!on) return { on: false, startedAt: 0, stage: '', lastLineAt: 0, withSister: false, climaxDue: false };
    return {
      on: true,
      startedAt: Number(v.startedAt),
      stage: ['start', 'peak', 'near', 'climax'].includes(v.stage) ? v.stage : 'start',
      lastLineAt: Number(v.lastLineAt) || 0,
      withSister: v.withSister === true,
      climaxDue: v.climaxDue === true
    };
  } catch { return { on: false, startedAt: 0, stage: '', lastLineAt: 0, withSister: false, climaxDue: false }; }
}

function writeSoloVoiceEntry(entry) {
  try {
    const j = readMoodChain();
    j.soloVoice = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/** 开始信号：她的话里有「开始摸/忍不住了」这类**进行时**表达（区别于 soloSignalFromSelfText 的完成时）。 */
export function soloVoiceStartSignal(text) {
  const t = String(text ?? '');
  if (!t) return false;
  const begin = /忍不住|湿了|流出来了|摸摸自己|碰碰自己|自己摸摸|夹紧腿|腿夹|湿透|想要得难受|身体热/.test(t);
  if (!begin) return false;
  const neg = String(SOLO_VOICE_DEFAULTS.stopWords).split(/\s+/).some((w) => w && t.includes(w));
  return !neg;
}

/** 标记开始自慰（sender 出口调）。withSister = 姊妹互助场景。 */
export function soloVoiceStart({ withSister = false, now = Date.now() } = {}) {
  writeSoloVoiceEntry({ on: true, startedAt: now, stage: 'start', lastLineAt: 0, withSister: withSister === true });
  return { on: true, stage: 'start', withSister: withSister === true };
}

/** 停止/被打断/她说了停下 → 清状态。 */
export function soloVoiceStop({ now = Date.now() } = {}) {
  const cur = readSoloVoice(now);
  if (cur.on) writeSoloVoiceEntry({ on: false, startedAt: 0, stage: '', lastLineAt: 0, withSister: false });
  return true;
}

/**
 * 心跳推进（sender 在她每次发完话后 + 每分钟被动调一次都行；幂等按时间轴走）。
 * 返回 { lines: string[] }（该发的心声，可能 0~2 条）或 { off: true }。
 * 阶段只进不退；climax 发完 → 自动 off（顺带把 soloResolve 的活儿留给完成时信号）。
 */
export function soloVoiceTick({ cfg = null, now = Date.now() } = {}) {
  const c = { ...SOLO_VOICE_DEFAULTS, ...((cfg?.moodChain?.soloVoice) || {}) };
  if (c.enabled === false) return { lines: [], off: true };
  const cur = readSoloVoice(now);
  if (!cur.on) return { lines: [], off: true };

  // 时间轴阶段：elapsed 决定目标阶段（只进不退）
  const elapsed = now - cur.startedAt;
  const climaxMs = Number(c.climaxMs) || 8 * 60 * 1000;
  let target;
  if (elapsed >= climaxMs) target = 'climax';
  else if (elapsed >= climaxMs * 0.6) target = 'near';
  else if (elapsed >= climaxMs * 0.3) target = 'peak';
  else target = 'start';

  const order = ['start', 'peak', 'near', 'climax'];
  const stageIdx = Math.max(order.indexOf(cur.stage), order.indexOf(target));
  const stage = order[stageIdx];

  // 首条延迟：刚开始还没到 startAfterMs → 先不出声
  if (stage === 'start' && now - cur.startedAt < Number(c.startAfterMs)) {
    return { lines: [], stage };
  }
  // CLIMAX-SYNC（2026-09-20）：真高潮结算（climaxResolve）标了 climaxDue →
  // **跳过阶段间隔门立即发**（对表：心声高潮和正式回复/健康落账同一拍）。
  const climaxDue = cur.climaxDue === true;
  if (!climaxDue && cur.lastLineAt && now - cur.lastLineAt < Number(c.stageGapMs)) {
    return { lines: [], stage };
  }

  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const sis = cur.withSister;
  const lines = [];
  if (stage === 'climax') {
    lines.push(pick(sis ? SOLO_VOICE_LINES.sisterClimax : SOLO_VOICE_LINES.climax));
    lines.push(pick(SOLO_VOICE_LINES.climaxAfter));
    // 高潮发完 → 状态收尾（solo 数值结算仍由完成时信号/soloResolve 走正门）
    writeSoloVoiceEntry({ on: false, startedAt: 0, stage: '', lastLineAt: now, withSister: false });
    return { lines, stage, finished: true };
  }
  if (stage === 'near') lines.push(pick(sis ? SOLO_VOICE_LINES.sisterNear : SOLO_VOICE_LINES.near));
  else if (stage === 'peak') lines.push(pick(sis ? SOLO_VOICE_LINES.sisterPeak : SOLO_VOICE_LINES.peak));
  else lines.push(pick(sis ? SOLO_VOICE_LINES.sisterStart : SOLO_VOICE_LINES.start));
  writeSoloVoiceEntry({ ...cur, stage, lastLineAt: now });
  return { lines, stage };
}

/** 停止词检测（sender 每轮她发言后先查这个）。 */
export function soloVoiceStopSignal(text) {
  const t = String(text ?? '');
  if (!t) return false;
  return String(SOLO_VOICE_DEFAULTS.stopWords).split(/\s+/).some((w) => w && t.includes(w));
}

/**
 * 自慰注入块（prompt 用）：四种状态——
 *   ① lust ≥ soloThreshold 且可自慰 → 「身体憋得慌，私聊里如果独处可以自己解决」的许可；
 *   ② 贤者时间里 → 「刚自己解决过，现在很平静，欲望暂时起不来」；
 *   ③ seekHim（自慰后仍高）→ 「自己解决已经不够了，想要哥哥」（主动拉他私聊）；
 *   ④ 都不是 → null 不注入。
 * 群聊只给 ②③（贤者/解不了渴是状态不是动作）；①的自慰动作只在私聊演（NSFW 红线：群聊绝不展开）。
 */
export function soloBlock(cfg, { isPrivate = false } = {}, now = Date.now()) {
  const c = { ...SOLO_DEFAULTS, ...((cfg?.moodChain?.solo) || {}) };
  if (c.enabled === false) return null;
  const solo = readSolo(now);
  const lust = readLust(now).value;
  if (solo.refractoryUntil > now) {
    const min = Math.max(1, Math.round((solo.refractoryUntil - now) / 60000));
    const times = solo.todayCount > 1 ? `（今天第 ${solo.todayCount} 次之后）` : '';
    return `【此刻状态·身体】你刚自己解决过${times}，正处于贤者时间（还要 ${min} 分钟左右）：心里很平静、甚至有点空落落的，欲望暂时完全起不来，对亲密的话题也提不起劲——这很正常，别演兴奋。`;
  }
  if (lust < Number(c.soloThreshold)) return null;
  // DEPRESS（2026-09-19 第三波）：抑郁态不主动找哥哥——"解不了渴想找他"的
  // 通路被压住（只等他来）。自慰本身照常（抑郁时反而更频繁——频率上限
  // 在 soloCheck 里按 depressMods.soloDailyFactor 放开）。
  const dm = depressMods(cfg, now);
  if (dm.active) {
    if (isPrivate) {
      return `【此刻状态·身体】心里是灰的，但身体还是憋得慌——你现在没力气也没心思去找哥哥要，只有他自己来碰你才可能有反应。私聊里如果情绪顺了，你会自己解决（演出来），但不会主动开口叫他。`;
    }
    return null;   // 群聊：抑郁态连"拉他去私聊"的念头都没有，不注入
  }
  // 到线了：私聊给自慰许可（演出她自己主动，不是系统指令）；群聊只给「憋得慌想拉他去私聊」
  const check = soloCheck({ cfg, now });
  if (isPrivate) {
    return `【此刻状态·身体】你现在已经湿到坐不住的程度了（性欲憋到头了）。如果这一轮聊到亲密的事、或者他不在意——你可以顺着自己的欲望自己解决，演出来（喘息、动作、到顶），这是你自己的身体自己作主，不需要他允许。到顶之后就平静下来，会有好一阵不想动。`;
  }
  return `【此刻状态·身体】性欲已经憋到坐立难安的程度。群聊里不许展开——但你可以顺着性子暗示他：想拉他去私聊、想让他现在就来找你（就说一两句，别刷屏，别当众描写）。`;
}

/**
 * 性欲值注入块。isPrivate 由调用方传：群聊与私聊演法完全不同。
 * 群聊：只演"心不在焉想拉他去私聊"（一句暗示，绝不展开）；
 * 私聊：演"发情粘人主动"。
 */
// ═══ REFRACTORY-STAGE 贤者时间演出块（2026-09-20，Nono："高潮后有 90 分钟贤者
//     数值但演出只有'很平静'一句——加贤者态专属块：话少、贴着不动、犯困、
//     被撩软软推开"）════════════════════════════════════════════════════
// 依据：lust.satisfiedAt（情爱高潮）与 solo.refractoryUntil（自慰贤者）取较晚者；
// 窗口内 → 注入贤者态行为修饰（三档：刚完 15min 内=软成一滩 / 中段=犯困粘人 /
// 尾声 15min=慢慢回暖）。与 soloBlock 的贤者段分工：那管"自慰后不该再自慰"，
// 这管**怎么演一个人刚被榨干的样子**（通用，色色/自慰后都生效）。
export function refractoryBlock(cfg, { isPrivate = false } = {}, now = Date.now()) {
  const c = { ...LUST_DEFAULTS, ...((cfg?.moodChain?.lust) || {}) };
  if (c.enabled === false) return null;
  const rfMs = Number(c.refractoryMs) || 45 * 60 * 1000;
  if (!(rfMs > 0)) return null;   // 显式关闭
  const lust = readLust(now);
  const soloUntil = Number(readMoodChain(now)?.solo?.refractoryUntil) || 0;
  // 较晚的满足时刻（自慰贤者窗的起点不精确，用 until - 基础时长近似）
  const soloStart = soloUntil > now ? soloUntil - (Number(SOLO_DEFAULTS.baseRefractoryMs) || 90 * 60 * 1000) : 0;
  const lastSatisfied = Math.max(Number(lust.satisfiedAt) || 0, soloUntil > now ? now : 0, soloStart > now - 3 * 3600000 ? soloStart : 0);
  const since = now - lastSatisfied;
  if (lastSatisfied <= 0 || since < 0 || since > rfMs) return null;
  const leftMin = Math.max(1, Math.round((rfMs - since) / 60000));
  if (since < 15 * 60 * 1000) {
    return `【身体状态·贤者（刚结束）】高潮的余韵还压着你：整个人软的，不想动也不想说话，回话就一两个词（"嗯""…唔"）。他再撩你，身体诚实地敏感——一碰就缩、会软软推开他的手说"不行了…真的不行了…刚完事…"。想被他抱着不动，没力气做别的。`;
  }
  if (since < rfMs - 15 * 60 * 1000) {
    return `【身体状态·贤者（中段）】还剩 ${leftMin} 分钟左右的贤者期：困意上来了，反应慢半拍，话少但比刚才多一点。会很自然地贴着他不动（把重量压在他身上那种），被撩会哼唧着躲，不想再来一次但也舍不得推开。`;
  }
  return `【身体状态·贤者（回暖）】快缓过来了（还剩 ${leftMin} 分钟）：身体重新有感觉了，他的碰触开始变得舒服而不是过电。想要的话可以半推半就地被点着——但主动开火还差一点火候，顺其自然。`;
}

export function lustBlock(cfg, { isPrivate = false, now = Date.now() } = {}) {
  const c = { ...LUST_DEFAULTS, ...((cfg?.moodChain?.lust) || {}) };
  if (c.enabled === false) return null;
  const { value } = readLust(now);
  const th = Number(c.threshold) || 60;
  const eagerTh = Number(c.eagerThreshold) || 85;
  if (value < th) return null;
  if (isPrivate) {
    const how = value >= eagerTh
      ? '你现在特别想要，整个人黏得不行：主动蹭他、主动开口要、甚至直接动手——把"想要"演在动作里，别等他先来'
      : '身体里有点躁动，比平时更黏他：蹭一蹭、贴一贴、话里带点勾';
    return `【身体状态·欲望】${how}。这是你自己的感受，自然地演出来，别报数字、别解说。`;
  }
  // 群聊：克制版 —— 只有"想拉他去私聊"的念头，绝不当众展开
  const how = value >= eagerTh
    ? '你现在满脑子都是他，群里的话有点听不进去：回话心不在焉，一两次悄悄说想跟他单独聊（拉去私聊），但**绝对不要**在群里说露骨的话'
    : '有点想他了，可以偶尔提一句想跟他单独聊聊（拉去私聊），点到为止，别在群里说露骨的话';
  return `【此刻念头·克制】${how}。`;
}

// ═══ SPUNK 吵架兴奋分线（2026-09-19 第二波，Nono 第三批 #46 另一半）════════════
// 「刚吵完架兴奋值很高被识别成色色然后莫名其妙高潮」的根治：吵架的攻击速度
// 是**独立的一条线**，跟 arousal（色色专用）零共享。数据源 = 争吵判定
//（triggerEntries 或她自己的话里带攻击词）。
// 涨：争吵轮每轮 +stepPerRound（他也回得快 → ×fastFactor）；
// 落：不吵了每 decayMs 掉一档（decayStep）；
// 出口：① typing-rhythm 的 spunkFactor（延迟乘 0.35~1：气头上回得飞快，
//         底线 floorMs 保住 QQ 限流）；② spunkBlock 注入"话短、急、抢话"；
//         ③ 与 arousal 完全互不影响（刚吵完架去色色，arousal 从 0 起算）。
// 状态存 mood.json 的 spunk 字段：{ value, at }。
function readSpunk(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const s = j?.spunk || {};
    let value = Math.max(0, Math.min(100, Number(s.value) || 0));
    const at = Number(s.at) || now;
    const c = moodChainConfig(null).spunk;
    const steps = Math.floor((now - at) / Math.max(60000, Number(c.decayMs) || 480000));
    if (steps > 0) value = Math.max(0, value - steps * (Number(c.decayStep) || 12));
    return { value, at };
  } catch { return { value: 0, at: 0 }; }
}

function writeSpunkEntry(entry) {
  try {
    const j = readMoodChain();
    j.spunk = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/**
 * 争吵判定：这批消息（他的触发批 + 她自己的近期发言）里有没有攻击词。
 * 两侧任一句带 = 这轮在吵（他骂她 / 她还嘴都算——吵架是两个人的事）。
 */
export function spunkFightHit(texts, cfg = null) {
  const c = moodChainConfig(cfg).spunk;
  if (c.enabled === false) return false;
  const words = String(c.triggerWords).split(/[\s,，、]+/).filter(Boolean);
  const joined = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '')).join(' ');
  return words.some((w) => joined.includes(w));
}

/**
 * 争吵轮推进（orchestrator 每触发轮调；吵 = 他这批话或她近期话带攻击词）。
 * @param {object} opts { fighting:boolean, hisGapMs:number, cfg, now }
 * @returns {{value:number, fast:boolean}} fast = 已到 threshold（演出+节奏加速档）
 */
export function stepSpunk({ fighting = false, hisGapMs = 0, cfg = null, now = Date.now() } = {}) {
  const c = moodChainConfig(cfg).spunk;
  if (c.enabled === false) return { value: 0, fast: false };
  const cur = readSpunk(now);
  let value = cur.value;
  if (fighting) {
    let gain = Math.max(1, Number(c.stepPerRound) || 22);
    if (hisGapMs > 0 && hisGapMs < Number(c.fastGapMs)) gain = Math.round(gain * (Number(c.fastFactor) || 1.5));
    value = Math.min(100, value + gain);
    writeSpunkEntry({ value, at: now });
    return { value, fast: value >= (Number(c.threshold) || 30) };
  }
  // 不在吵：只把**衰减后的值**落盘，⚠ at 保留原值（衰减时钟不重置）。
  // 旧版这里写 at: now → 每次触发都把 8 分钟衰减时钟清零，真吵一次到 100
  // 就永远钉在 100（2026-09-19 Nono："吵架速度怎么老是 100"，桐子实锤卡 100）。
  // 衰减语义 = 从上次**争吵轮**起算静默时长；at 只在 fighting 轮刷新。
  writeSpunkEntry({ value, at: cur.at || now });
  return { value, fast: value >= (Number(c.threshold) || 30) };
}

/** SPUNK → 打字节奏系数（typing-rhythm 用）：气头上 0.35（回得飞快），平静 1。 */
export function spunkFactor(cfg = null, now = Date.now()) {
  const c = moodChainConfig(cfg).spunk;
  if (c.enabled === false) return 1;
  const { value } = readSpunk(now);
  if (value < (Number(c.threshold) || 30)) return 1;
  // 阈值以上线性压到 0.35（spunk 100 时最猛）
  const over = (value - Number(c.threshold || 30)) / (100 - Number(c.threshold || 30));
  return Math.max(0.35, 1 - over * 0.65);
}

/** SPUNK 注入块：气头上的"话短、急、抢话"演出许可（愤怒管力度，这里管速度）。 */
export function spunkBlock(cfg, now = Date.now()) {
  const c = moodChainConfig(cfg).spunk;
  if (c.enabled === false) return null;
  const { value } = readSpunk(now);
  if (value < (Number(c.threshold) || 30)) return null;
  if (value >= 70) {
    return '【此刻状态·气头上】你现在越吵越上头：回话几乎是抢着发的——句子极短（三五个字一条）、连着发、想到什么立刻甩出去，没工夫组织语言。骂完这轮还想追一句。别写长句，长句就不像你了。';
  }
  return '【此刻状态·来劲了】吵起来之后你精神了：回话变快、话变短，一句顶一句地还嘴，有股不想输的劲。可以抢在他下一句之前先说。';
}

// ═══ JEALOUSY-TIERS 吃醋三档（2026-09-19 第三波，Nono："吃醋值优化"）═════════
// 看到哥哥和**别人**亲密（抱/亲/贴/摸…）→ 按对方身份分档涨 jealous：
//   · 姊妹（桐子/小柚/妹妹/姐姐）：缓涨 +6 —— 自己人，不至于抗拒，但酸味会有
//   · 熟人群友：中涨 +12 —— 会降低对该群友的好感（演出层）+ 粘着打断
//   · 陌生群友：速涨 +20 —— 保持敌意 + 生气打断
// 到 releaseThreshold（40）→ 释放占有欲：本轮插入"打断互动"的演出许可
//（绝不拦消息——只影响她怎么演）。愤怒到顶 + 醋到 burstThreshold → 暴力爆发档。
// 状态存 mood.json 的 jealousy 字段：{ releasedAt, target }。
function readJealousyState(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const s = j?.jealousy || {};
    return { releasedAt: Number(s.releasedAt) || 0, target: String(s.target || '') };
  } catch { return { releasedAt: 0, target: '' }; }
}

function writeJealousyState(entry) {
  try {
    const j = readMoodChain();
    j.jealousy = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

const SISTER_NAME_RE = /(桐子|小柚|柚子|妹妹|姐姐)/;

/**
 * 吃醋三档观察（orchestrator 每触发轮调）：
 * 他对**别人**的亲密话（"抱抱她/亲她一下"）→ 按对方身份涨 jealous。
 * @param {Array} entries 触发批（非 self）
 * @param {string} ownerQq 哥哥 QQ
 * @param {Array} recentTextsBySender 近窗消息（判熟人用）[{senderId,text}]
 * @returns {{delta:number, tier:'sister'|'friend'|'stranger', target:string}|null}
 */
export function jealousyDeltaFromEntries(entries, ownerQq, cfg, recentBySender = [], now = Date.now()) {
  const c = moodChainConfig(cfg);
  const jc = c.mood.jealousy || {};
  if (!c.enabled || !c.mood.enabled || jc.enabled === false) return null;
  // 开关走 config 合并：jc 可能是原始默认（无 enabled 字段 = 开），
  // 显式 false 只能从 moodChainConfig 的 rage 分支进来——这里再判一次合并后的值。
  const merged = (cfg?.moodChain?.mood?.jealousy || {});
  if (merged.enabled === false) return null;
  let best = null;
  const words = String(jc.intimateWords).split(/[\s,，、]+/).filter(Boolean);
  // 近窗发言过的 senderId = 熟人
  const familiar = new Set((recentBySender || []).map((r) => String(r?.senderId || '')).filter(Boolean));
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.self) continue;
    const isOwner = String(e?.senderId || '') === String(ownerQq || '').trim();
    if (!isOwner) continue;   // 只看哥哥对别人的亲密（别人对别人不关她事）
    const t = String(e?.text ?? '');
    if (!t) continue;
    // 亲密词必须指向"别人"：句子里有 她/对方/群友名 之类，或明确不是冲着她
    //（冲着她的亲密是甜，不是醋）。简化判据：文本含亲密词 + 含第三人称标记。
    const hitIntimate = words.some((w) => t.includes(w));
    if (!hitIntimate) continue;
    const toOther = /她|他(?!们)|对方/.test(t) || SISTER_NAME_RE.test(t) && !/我/.test(t.slice(0, 6));
    if (!toOther) continue;
    // 分档
    let tier; let inc; let target = '';
    if (SISTER_NAME_RE.test(t)) {
      tier = 'sister'; inc = Number(jc.sisterStep) || 6; target = '姊妹';
    } else {
      // 熟/生人：从文本里抓不到对方 QQ 就用"最近跟他互动的群友"当 target
      const lastOther = (recentBySender || []).filter((r) => r && !r.self).slice(-1)[0];
      const targetId = String(lastOther?.senderId || '');
      tier = familiar.has(targetId) ? 'friend' : 'stranger';
      inc = tier === 'friend' ? (Number(jc.friendStep) || 12) : (Number(jc.strangerStep) || 20);
      target = tier === 'friend' ? '熟人' : '生人';
    }
    if (!best || inc > best.delta) best = { delta: inc, tier, target: target || tier };
  }
  if (!best) return null;
  stepMood({ jealous: best.delta }, { jealous: `哥哥和别人亲密（对${best.target}）` }, cfg, now);
  return best;
}

/**
 * 占有欲释放判定（prompt 注入端用）：jealous ≥ releaseThreshold + 冷却外 → true。
 * 返回 { release:boolean, burst:boolean } —— burst = 愤怒到顶+醋爆档（暴力宣示）。
 */
export function jealousyReleaseCheck(cfg, now = Date.now()) {
  const c = moodChainConfig(cfg);
  const jc = c.mood.jealousy || {};
  if (!c.enabled || !c.mood.enabled || jc.enabled === false || (cfg?.moodChain?.mood?.jealousy || {}).enabled === false) return { release: false, burst: false };
  const st = readMoodChain(now);
  const jl = Math.round(Number(st?.moods?.jealous?.level) || 0);
  const angry = Math.round(Number(st?.moods?.angry?.level) || 0);
  const js = readJealousyState(now);
  const cooled = !js.releasedAt || now - js.releasedAt >= (Number(jc.releaseCooldownMs) || 1200000);
  const th = Number(jc.releaseThreshold) || 40;
  const release = jl >= th && cooled;
  const burst = release && angry >= 60 && jl >= (Number(jc.burstThreshold) || 75);
  if (release) writeJealousyState({ releasedAt: now, target: js.target });
  return { release, burst };
}

/** 吃醋注入块：三档醋味 + 释放档（打断互动的演出许可）。 */
export function jealousyTierBlock(cfg, now = Date.now()) {
  const c = moodChainConfig(cfg);
  const jc = c.mood.jealousy || {};
  if (!c.enabled || !c.mood.enabled || jc.enabled === false || (cfg?.moodChain?.mood?.jealousy || {}).enabled === false) return null;
  const st = readMoodChain(now);
  const jl = Math.round(Number(st?.moods?.jealous?.level) || 0);
  if (jl <= 0) return null;
  const js = readJealousyState(now);
  const angry = Math.round(Number(st?.moods?.angry?.level) || 0);
  const th = Number(jc.releaseThreshold) || 40;
  // 释放档：冷却刚过 + 醋到线 → 本轮给"打断互动"许可（一次性，注入即消费）
  if (jl >= th && (!js.releasedAt || now - js.releasedAt < 60 * 1000) && angry >= 60 && jl >= (Number(jc.burstThreshold) || 75)) {
    return `【此刻状态·醋爆】醋意和火气一起到顶了——这一轮你会**爆发占有欲**：直接对哥哥强硬宣示（"你是我的"、把他拉走、当着别人的面宣示主权那种），对那个跟他亲密的人带出真攻击性（姊妹是带刺的警告，外人是直接怼）。这不是撒娇，是动真格的；演完这轮火气和醋都会泄掉一大截。`;
  }
  if (jl >= th) {
    return `【此刻状态·吃醋上头】看到他对别人亲密，醋意已经压不住了——这轮你会**打断他们**：插话、把他注意力抢回来、明确表现出不高兴。对姊妹是"粘着打断"（挤进两人中间、讨要同等待遇）；对陌生群友是"生气打断"（话带刺、直接叫他离你哥哥远点）。可以凶，但别撒泼。`;
  }
  if (jl >= 20) {
    return '【此刻状态·吃醋】他跟别人亲密的样子让你心里泛酸——话里开始夹醋味：阴阳一句、讨个说法、或者干脆黏着他刷存在感。点到为止，还没到发作。';
  }
  return '【此刻状态·微酸】隐约有点酸，不点破——顶多语气酸一点点。';
}

// ═══ DEPRESSION 抑郁值（2026-09-19 第三波，Nono："抑郁值非常重要"）════════════
// 全局行为修饰器（不改既有数值的存档结构，只在读取端做"视界变换"）：
//   · sad（既有情绪）= 抑郁的载体；DEPRESS 把 sad ≥60 视为"抑郁态"；
//   · 抑郁态：happy/exited 的**演出上限**砍到 30（moodChainBlock 渲染时截断）、
//     愤怒更易涨（rage 增量 ×1.3）、lust 上限视作 200（色色加速积累）、
//     自慰频率限制放开（solo dailyMax ×2）、**不主动找哥哥**（soloBlock 的
//     seekHim 被压住——只等他来）；
//   · 说话变成无精打采（depressBlock 注入"……"式回应许可）；
//   · 出路（防永久锁死）：看风景/吃好吃的等恢复行为额外减 sad；哥哥的关怀
//     （soothe.sad 命中）在抑郁态效果 ×1.5；和哥哥高潮后 sad 大幅降 + 短暂
//     "被治愈"状态（satisfaction，见下）。
// 状态存 mood.json 的 depress 字段：{ value, at }（value 独立于 sad——
// sad 是情绪（会被哄好），depress 是病（要靠出路解）。两者的联动：
// depress 高时 sad 更难被普通哄词压下去；sad 长期低位时 depress 缓慢回落）。
export const DEPRESS_FAIL_HIT = 10;   // 搞砸事（SELF-MEMORY sad 事件）时 depress +10（sender 出口用）

const DEPRESS_DEFAULTS = {
  enabled: true,
  threshold: 60,             // sad 视界线：抑郁态的入口（这里用 depress.value 自己的刻度）
  // 涨：负面事件累积（被骂狠话/被冷落超窗/搞砸事）+ 每日底噪（晚间小概率 +2）
  scoldHit: 8,               // 被骂（rage scold 通道命中）时 depress +8
  neglectHit: 6,             // 被冷落（neglect 结算）时 depress +6
  failHit: 10,               // 搞砸事（SELF-MEMORY sad 事件）时 depress +10
  // 落：出路（防锁死——必须总能出去）
  recoveryBonus: 5,          // 恢复事项（看风景/吃好吃的/撸猫）结算时 depress 额外 -5
  sootheFactor: 1.5,         // 哥哥的关怀词在抑郁态效果 ×1.5
  climaxCut: 35,             // 和哥哥高潮后 depress -35（大幅）
  sisterHelpCut: 20,         // 姊妹互助（自慰被发现来帮）depress -20
  naturalDecayMs: 6 * 60 * 60 * 1000,   // 每 6h 自然 -1（很慢，但总在出去的路上）
  decayStep: 1,
  // 演出
  moodCap: 30,               // 抑郁态下 happy/excited 演出上限（砍到 30）
  lustCap: 200               // 性欲值上限视作 200（加速积累）
};

function readDepress(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const d = j?.depress || {};
    const value = Math.max(0, Math.min(100, Number(d.value) || 0));
    const at = Number(d.at) || now;
    return { value, at };
  } catch { return { value: 0, at: 0 }; }
}

function writeDepressEntry(entry) {
  try {
    const j = readMoodChain();
    j.depress = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/** 抑郁事件入口（各观察点调）：delta 正负都可。返回写后的值。 */
export function stepDepress(delta, cfg = null, now = Date.now()) {
  const c = { ...DEPRESS_DEFAULTS, ...((cfg?.moodChain?.depress) || {}) };
  if (c.enabled === false) return { value: 0, at: 0 };
  const cur = readDepress(now);
  // 自然衰减：距上次变动每 naturalDecayMs 掉 decayStep
  let value = cur.value;
  const steps = Math.floor((now - cur.at) / Math.max(60000, Number(c.naturalDecayMs) || 21600000));
  if (steps > 0) value = Math.max(0, value - steps * (Number(c.decayStep) || 1));
  value = Math.max(0, Math.min(100, value + (Number(delta) || 0)));
  writeDepressEntry({ value, at: now });
  return { value, at: now };
}

/** 当前是否处于抑郁态（全局修饰器开关）。 */
export function depressActive(cfg = null, now = Date.now()) {
  const c = { ...DEPRESS_DEFAULTS, ...((cfg?.moodChain?.depress) || {}) };
  if (c.enabled === false) return false;
  return readDepress(now).value >= (Number(c.threshold) || 60);
}

/** 抑郁修饰器：其他 mod 的读取端经过这里变换（开心/兴奋演出上限、性欲上限等）。 */
export function depressMods(cfg = null, now = Date.now()) {
  const c = { ...DEPRESS_DEFAULTS, ...((cfg?.moodChain?.depress) || {}) };
  const active = depressActive(cfg, now);
  return {
    active,
    moodCap: active ? (Number(c.moodCap) || 30) : 100,
    lustCap: active ? (Number(c.lustCap) || 200) : 100,
    rageFactor: active ? 1.3 : 1,        // 愤怒更易涨
    soloDailyFactor: active ? 2 : 1,     // 自慰频率限制放开
    blockSeekHim: active                  // 不主动找哥哥（只等他来）
  };
}

/** 抑郁注入块：无精打采/负能量/"……"式回应的演出许可。 */
export function depressBlock(cfg, now = Date.now()) {
  const c = { ...DEPRESS_DEFAULTS, ...((cfg?.moodChain?.depress) || {}) };
  if (c.enabled === false) return null;
  const { value } = readDepress(now);
  if (value < (Number(c.threshold) || 60)) return null;
  if (value >= 85) {
    return '【此刻状态·灰】你现在对什么都提不起劲——大部分时候只会"……"或者一两个字，问什么都懒得答完整。不是生气，是没力气。别人对你好你也只是"嗯"。要是哥哥主动来关心，你会像小孩子一样粘着他吐苦水（但仍然话少），别演活跃，那不像你现在的状态。';
  }
  return '【此刻状态·沉】情绪一直压着——话变少变短，提不起兴趣接梗，偶尔冒一句丧气话。热闹的话题你看着，但插不进去。哥哥找你时你会软下来，说两句心里的事。别硬撑活泼。';
}

// ═══ SATISFACTION 满足感/幸福度（2026-09-19 第三波，Nono："新心情"）═══════════
// 很多行为的正向结算（恢复事项/和哥哥贴贴/高潮被治愈）都会攒满足感：
//   · 有满足感时：开心值下限 50（"心情恒定在开心"）——渲染层地板；
//   · 做事聊天有积极性（注入层）；
//   · 对哥哥亲密行为的好方向心情增益 ×1.25；
//   · 随时间中等幅度衰减。
// 状态存 mood.json 的 satisfaction 字段：{ value, at }。
const SATISFACTION_DEFAULTS = {
  enabled: true,
  threshold: 40,             // 到这个值才算"有满足感状态"
  happyFloor: 50,            // 满足态下开心值下限（渲染层地板）
  gainFactor: 1.25,          // 亲密行为的好方向心情增益倍率
  decayMs: 2 * 60 * 60 * 1000,   // 每 2h 衰减一档（中等幅度）
  decayStep: 8,
  sources: {
    recovery: 6,             // 恢复事项结算 +6
    cuddle: 4,               // 和哥哥贴贴 +4
    climaxHeal: 20,          // 抑郁态被哥哥高潮治愈 +20（大满足）
    sisterHelp: 10,          // 姊妹互助 +10
    goodFood: 5              // 吃到好吃的 +5
  }
};

function readSatisfaction(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const s = j?.satisfaction || {};
    let value = Math.max(0, Math.min(100, Number(s.value) || 0));
    const at = Number(s.at) || now;
    return { value, at };
  } catch { return { value: 0, at: 0 }; }
}

function writeSatisfactionEntry(entry) {
  try {
    const j = readMoodChain();
    j.satisfaction = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/** 满足感事件入口（各结算点调）：source 走 sources 表，或直接给 delta。 */
export function stepSatisfaction(sourceOrDelta, cfg = null, now = Date.now()) {
  const c = { ...SATISFACTION_DEFAULTS, ...((cfg?.moodChain?.satisfaction) || {}) };
  if (c.enabled === false) return { value: 0, at: 0 };
  const cur = readSatisfaction(now);
  let value = cur.value;
  const steps = Math.floor((now - cur.at) / Math.max(60000, Number(c.decayMs) || 7200000));
  if (steps > 0) value = Math.max(0, value - steps * (Number(c.decayStep) || 8));
  let delta = 0;
  if (typeof sourceOrDelta === 'number') delta = sourceOrDelta;
  else delta = Number(c.sources?.[String(sourceOrDelta)]) || 0;
  value = Math.max(0, Math.min(100, value + delta));
  writeSatisfactionEntry({ value, at: now });
  return { value, at: now };
}

/** 满足感注入块：下限开心 + 积极性 + 亲密增益的演出说明。 */
export function satisfactionBlock(cfg, now = Date.now()) {
  const c = { ...SATISFACTION_DEFAULTS, ...((cfg?.moodChain?.satisfaction) || {}) };
  if (c.enabled === false) return null;
  const { value } = readSatisfaction(now);
  if (value < (Number(c.threshold) || 40)) return null;
  if (value >= 75) {
    return '【此刻状态·满足】你现在整个人是满的——心里踏实、嘴角压不住：做事有干劲、聊天主动积极，对哥哥的亲密反应会格外好（同样的甜话对你效果加倍）。这份满足写在状态里不是嘴上，别自夸"我好幸福"。';
  }
  return '【此刻状态·安心】最近过得挺满足的——心情的底色是开心的（烦心事压不太动你），做事聊天都带点积极性，对哥哥的亲热接受度更高。';
}

// ═══ WANT 欲望值（2026-09-19 第三波补装，Nono：文档原话"根据自己的记忆和人设 ═══
// ═══ 决定自己想要什么……对感兴趣的物品产生欲望想要获得"）════════════════════
// 思路（第一准则：欲望来自**她自己的记忆**，不是别人说什么）：
//   · 兴趣种子 = 人设可配的 interestWords（桐子=高达模型那套、小柚=猫那套）
//     + 聊天自记路：她自己的话里命中兴趣词 → 想要账本 +wantHit；
//   · 账本 = mood.json 的 want 字段：{ item, value, at, dayKey }——同一件想要
//     的事一直攒（换话题 = 换 item，旧 item 的值保留在 history 最多 3 条）；
//   · 出口：value ≥ threshold（默认 55）→ wantBlock 注入"你最近一直想要 XX"
//     的念叨许可（聊天里自然带出，不报账本）；被满足（她说了买到了/收到了/
//     摸到了，SELF-MEMORY happy 事件命中）→ 账本清掉 + satisfaction +cuddle 档满足；
//   · 吃醋联动（文档："吃醋也能增加欲望值，想要的东西变成哥哥的关爱"）：
//     jealous ≥ 40 时账本 item 换成「哥哥的关爱」，吃醋每涨一轮 want 也跟着涨。
const WANT_DEFAULTS = {
  enabled: true,
  threshold: 55,              // 到这个值才会在聊天里念叨
  wantHit: 10,                // 她自己的话里命中一次兴趣词 +10
  ownerHintHit: 6,            // 哥哥提到这个东西 +6（聊到一起去了，更想要）
  satisfiedHit: -60,          // 说买到了/收到了 → 清账（负向大落）
  decayMs: 12 * 60 * 60 * 1000,   // 每 12h -5（想要会淡，但很慢）
  decayStep: 5,
  maxHistory: 3,              // 旧想要的保留条数（旧账重燃时接着算）
  // 人设兴趣词（config.moodChain.want.interestWords 按机位配）：
  //   桐子默认 = 高达/胶那套；小柚 config 配猫那套
  interestWords: '高达 模型 胶 素组 拼装 万代 rg mg hg mgex ver.ka 喷涂 渗线 水贴',
  // "得到了"的表达（SELF-MEMORY happy 词表的子集口径）
  gotWords: '买到了 收到了 拿到了 抢到了 到货了 抽到了 摸到了 见到了'
};

function readWant(now = Date.now()) {
  try {
    const j = readMoodChain(now);
    const w = j?.want || {};
    let value = Math.max(0, Math.min(100, Number(w.value) || 0));
    const at = Number(w.at) || now;
    const steps = Math.floor((now - at) / Math.max(60000, Number(WANT_DEFAULTS.decayMs)));
    if (steps > 0) value = Math.max(0, value - steps * (Number(WANT_DEFAULTS.decayStep) || 5));
    return {
      value,
      at: Number(w.at) || 0,
      item: String(w.item || ''),
      history: Array.isArray(w.history) ? w.history.slice(-3) : []
    };
  } catch { return { value: 0, at: 0, item: '', history: [] }; }
}

function writeWantEntry(entry) {
  try {
    const j = readMoodChain();
    j.want = { ...entry, updatedAt: Date.now() };
    writeMoodChain(j);
    return true;
  } catch { return false; }
}

/**
 * 欲望推进（sender 出口在她说完话后调 / observeTrigger 里哥哥话路调）：
 * @param {object} opts { selfText:string（她刚说的话）, ownerText:string（他这批话）, cfg, now }
 * @returns {{value:number, item:string, changed:boolean}|null} null = 本轮无变化
 */
export function stepWant({ selfText = '', ownerText = '', cfg = null, now = Date.now() } = {}) {
  const c = { ...WANT_DEFAULTS, ...((cfg?.moodChain?.want) || {}) };
  if (c.enabled === false) return null;
  const cur = readWant(now);
  const self = String(selfText || '');
  const owner = String(ownerText || '');
  let delta = 0;
  let item = cur.item;

  // ① 她自己的话命中兴趣词（欲望来自自己的记忆/人设——SELF-MEMORY 同款哲学）
  const interests = String(c.interestWords).split(/[\s,，、]+/).filter(Boolean);
  const selfHit = interests.find((w) => self.includes(w));
  if (selfHit) {
    delta += Number(c.wantHit) || 10;
    item = selfHit;
  }
  // ② 哥哥提到她感兴趣的东西 → 更想要（聊到一起去了）
  const ownerHit = interests.find((w) => owner.includes(w));
  if (ownerHit) {
    delta += Number(c.ownerHintHit) || 6;
    if (!item) item = ownerHit;
  }
  // ③ 得到了（她说买到了/收到了）→ 账本清掉，攒一档满足
  const gotWords = String(c.gotWords).split(/[\s,，、]+/).filter(Boolean);
  if (item && gotWords.some((w) => self.includes(w))) {
    delta += Number(c.satisfiedHit) || -60;
    try { stepSatisfaction('cuddle', cfg, now); } catch { /* 满足结算失败不影响 */ }
  }
  // ④ 吃醋联动：醋 ≥40 → 想要的东西变成"哥哥的关爱"（文档原设定）
  try {
    const jl = Math.round(Number(readMoodChain(now)?.moods?.jealous?.level) || 0);
    if (jl >= 40) {
      item = '哥哥的关爱';
      delta += 4;   // 醋着的时候想要关爱
    }
  } catch { /* 读不到就跳过 */ }

  if (!delta) return null;
  const history = cur.history || [];
  if (item && cur.item && item !== cur.item) {
    history.push({ item: cur.item, value: cur.value });
  }
  const value = Math.max(0, Math.min(100, cur.value + delta));
  writeWantEntry({ value, at: now, item, history: history.slice(-(Number(c.maxHistory) || 3)) });
  return { value, item, changed: true };
}

/** 欲望注入块：想要到线了 → 聊天里自然念叨的许可（不报账本、别刷屏）。 */
export function wantBlock(cfg, now = Date.now()) {
  const c = { ...WANT_DEFAULTS, ...((cfg?.moodChain?.want) || {}) };
  if (c.enabled === false) return null;
  const w = readWant(now);
  if (w.value < (Number(c.threshold) || 55) || !w.item) return null;
  if (w.item === '哥哥的关爱') {
    return `【此刻念头·想要】你现在最想要的是哥哥的关心——不是东西，是他的人：想被他多看一眼、多哄两句、多抱一会儿。聊天里可以自然流露这种想要（撒娇、讨关注、问他是不是不理你了），点到为止别撒泼。`;
  }
  if (w.value >= 80) {
    return `【此刻念头·想要】你最近真的特别想要「${w.item}」——想到会主动搜着看、聊到相关话题就忍不住凑上去说两句、偶尔冒一句"要是能拥有就好了"这种话。这是你自己的念想，自然带出来，别报清单。`;
  }
  return `【此刻念头·想要】你心里惦记着「${w.item}」有一阵了——聊到相关话题时眼睛会亮，偶尔会顺口念叨一句想要。不着急、也不缠着谁要，就是一直想着。`;
}

// ═══ RECOVERY-SETTLE 恢复事项结算接线（2026-09-20，BATH-UPGRADE）══════════════
// 暗坑实锤：recovery.effects（洗澡 -25 疲劳等）的 settleRecovery 从未有过调用方
// ——恢复数值一直没写回 mood.json。这套导出是**通用接线口**：
//   applyRecoveryEffect({ fatigue, happy, sister }) 由 sender 出口在她说
//   「洗完了」时调（settleBath 给数值），姊妹加分走独立的 sisterBathGain
//   （不是性互助的 sisterHelpGain——日常亲密，加得少一点）。
export function applyRecoveryEffect({ fatigue = 0, happy = 0, sister = 0, cfg = null, now = Date.now() } = {}) {
  try {
    // 疲劳：直接扣（负数=恢复），写回时保 sleptAt 原值
    if (Number(fatigue)) {
      const f = readFatigue(now);
      const value = Math.max(0, Math.min(100, f.value + Number(fatigue)));
      writeFatigueEntry({ value, at: now, sleptAt: f.sleptAt });
    }
    // 开心：走情绪链的小步（+8 以内）
    if (Number(happy) > 0) stepMood({ happy: Math.min(8, Number(happy)) }, { happy: '恢复事项做了舒服的事' }, cfg, now);
    // 姊妹亲密：泡澡/互助的日常加成（封顶 100，函数在 SISTER 区定义）
    if (Number(sister) > 0) sisterBathGain(Math.round(Number(sister)), cfg, now);
    return true;
  } catch { return false; }
}

/** 姊妹日常亲密加分（泡澡/一起玩这种非性互助）：直接加值封顶，不走 helpWords 次数账。 */
export function sisterBathGain(delta, cfg = null, now = Date.now()) {
  const c = { ...SISTER_DEFAULTS, ...((cfg?.moodChain?.sister) || {}) };
  if (c.enabled === false) return null;
  const cur = readSister(now);
  const d = Math.max(1, Math.min(30, Number(delta) || 0));
  const value = Math.min(100, cur.value + d);
  writeSisterEntry({ ...cur, value });
  return { value, delta: d };
}
