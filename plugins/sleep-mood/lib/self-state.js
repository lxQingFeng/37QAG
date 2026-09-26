// self-state —— 全局自身状态：她"现在在干什么"（睡觉/在忙/刚醒）
// ═════════════════════════════════════════════════════════════════════════════
// 需求（2026-09-16，Nono 原话精炼）：
//   "私信里说趴在我这睡着了，群里就不该再聊 —— 除非像私信里那样被喊醒
//    （@她 别睡了快起床）才给出被吵醒的反应。反过来群里在干什么，
//    私信里也要接着，不再自相矛盾。像一个真正的人：记忆跨所有群聊和私信，
//    行为跟着记忆走。"
//
// 现状：跨会话【记忆】已经互通（cross-chat-memory），但那只是"知道"——
// 模型照样在群里兴致勃勃接话，因为它没有任何"我现在在睡觉，不该说话"
// 的硬约束。缺的不是记忆，是**行为执行**层。
//
// 本模块就是那层。三个部分：
//
//   ① 状态存档 <DATA_DIR>/self-state.json（跨会话、跨群、全局唯一）：
//        { status: 'sleeping' | 'busy' | 'awake', what: '趴在哥哥肩上睡觉',
//          at, chatKeyOf, wakeKey? }
//      · 谁写：观察她自己的发言（sender.js 出口）—— 她说了睡觉的话就标 sleeping，
//        说了"在干某事"就标 busy；状态带自然衰减（sleeping 8h / busy 2h 后视为醒着，
//        防止一次误判把她锁死）。
//   ② 睡眠闸（orchestrator.wake 入口，省 token 的关键）：
//        sleeping 时普通消息**直接不响应**（不调模型，像真人睡着了听不到）；
//        只有被 @/被引用/被戳 + 喊醒词（醒/起/别睡/叫醒…）才放行，
//        并带上"被喊醒"的标记，让她用睡迷糊的口吻回。
//   ③ 提示词注入（prompt.js【此刻状态】）：
//        awake 但 40 分钟内说过睡觉 → 提醒"你刚说过要睡，别再兴奋聊天"；
//        busy → 告知"你正在干某事"，回话要贴合（可以被打断但不该忘）；
//        刚被喊醒 → "你刚被叫醒，迷迷糊糊"。
//
// 设计原则：
//   · **确定性规则 + 轻量词表**，不额外调模型判睡不睡（那是每次消息都花 token）；
//   · 状态文件坏了/缺了 → 一律当 awake，绝不锁死正常聊天；
//   · 所有时间窗口可配（config.selfState）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

export const SELF_STATE_DEFAULTS = {
  enabled: true,                      // 总开关（false = 完全回到旧行为）
  sleepAutoMs: 8 * 60 * 60 * 1000,    // 睡着状态最多持续 8 小时（之后当她自己醒了）
  busyAutoMs: 2 * 60 * 60 * 1000,     // "在忙某事"最多持续 2 小时（**未识别事项**的兜底；识别到的事项用 activityDurations）
  awakeGraceMs: 40 * 60 * 1000,       // 说过睡觉后的提醒窗口（这段时间里她不该表现得精神抖擞）
  wakeMentionMs: 30 * 60 * 1000,      // 被喊醒后"迷糊"状态保持多久
  blockGroupRandom: true,             // 睡着时：群里的普通消息（没点名她的）一律不响应
  // ── RECOVERY-PICK（2026-09-18 第一波，Nono："疲惫时不应该只有睡觉这一个选项；
  //    根据人设喜好选恢复行为——看风景/撸猫/玩游戏/洗澡/贴贴/吃好吃的"）──
  // 疲劳 ≥ threshold 且她闲着（awake 且没在忙）→ 每个判定间隔掷一次骰子，
  // 命中就自主选一个恢复行为进 busy（人设权重），做完按数值表结算。
  recovery: {
    enabled: true,
    threshold: 50,                  // 疲劳到这个值才开始想找事做
    chancePerCheck: 0.3,            // 每次判定的选中概率（缓入：不是一累就马上弹）
    checkEveryMs: 10 * 60 * 1000,   // 判定节奏（心跳里做，10 分钟看一次）
    cooldownMs: 90 * 60 * 1000,     // 一件事做完后至少歇这么久再选下一件
    // 人设权重（每机位 config.selfState.recovery.weights 可覆盖；key = 事项词）
    // 权重决定选择概率，不是硬规则。
    weights: {
      '看风景': 1.0, '撸猫': 0.8, '玩游戏': 0.8, '洗澡': 0.9,
      '吃好吃的': 1.0, '和哥哥贴贴': 1.2, '逛街': 0.5
    },
    // 数值结算表（做完一件事后）：疲劳/开心/兴奋的变化量。
    // 「窗边吹风一下午」= 看风景的典型演出（selfStateBlock 的 busy 演化照常跑）。
    effects: {
      '看风景': { fatigue: -20, happy: 3, note: '在窗边/阳台吹风看外面' },
      '撸猫': { fatigue: -10, happy: 6, note: 'rua 猫，被猫踩来踩去' },
      '玩游戏': { fatigue: 5, happy: 8, excited: 8, note: '打两把游戏（越打越精神）' },
      '洗澡': { fatigue: -25, happy: 2, note: '洗个热水澡' },
      '吃好吃的': { fatigue: -10, happy: 8, note: '翻出好吃的边吃边瘫' },
      '和哥哥贴贴': { fatigue: -12, happy: 8, excited: 3, note: '凑到哥哥身边贴着（像被顺毛的猫）' },
      '逛街': { fatigue: -8, happy: 4, note: '自己出去转转' }
    }
  },
  // ── SCHEDULE 作息表（2026-09-19 第二波，Nono：「根据人设制定一份作息表，
  //    不严格执行、作为参考——玩腻了可能突然去洗个澡或睡一小会」）──
  // 人设参考日程：时段 → 候选事项 + 权重。**不是硬规则**：
  //   · 挂在每个触发轮（orchestrator）：她闲着（awake 没在忙）+ 概率命中 →
  //     按当前时段的权重选一件事进 busy（ACTIVITY-CLOCK 接管演化）；
  //   · 「玩腻了突然换事」：已经在忙时，小概率（boredChance）**换一件事做**——
  //     时间对不对得上日程都行（这就是"不严格按作息表"）；
  //   · 和恢复选项池（recovery）共用一套写 busy + activityOf 演化的机制，
  //     只是入口不同：恢复池=疲劳驱动，作息表=时段驱动。
  // 词表可配（config.selfState.schedule 可整体覆盖时段表和权重）。
  schedule: {
    enabled: true,
    chancePerCheck: 0.18,          // 每次判定的选中概率（作息表比疲劳恢复更日常、更密）
    checkEveryMs: 8 * 60 * 1000,   // 判定节奏
    cooldownMs: 50 * 60 * 1000,    // 一件事之后至少歇这么久（比恢复池短：日常事的节奏）
    boredChance: 0.12,             // 已经在忙时"玩腻了换事"的概率
    boredAfterMs: 30 * 60 * 1000,  // 忙了至少这么久才算"玩腻"（刚做 5 分钟就换是抖动）
    // 时段表：[from, to) 小时 → 候选事项 + 权重（key 与 recovery/activities 的事项词对齐，
    // activityOf 靠词表匹配拿到自然时长/收尾/接续）
    // BATH-DAILY（2026-09-20，Nono："作息表里每天都要洗一下澡，刚好就在下午"）：
    // 下午档必含「洗澡」候选；pickScheduled 读 bath 记账——今天没洗 → 洗澡权重
    // ×boost（必选倾向），洗过 → 权重清零（一天一次）。晚上档保留低权重兜底
    //（下午没机会洗的补洗），深夜档不再重复。
    slots: [
      { from: 7, to: 9, what: { '吃好吃的': 1.4, '煮面': 1.6, '刷牙': 1.2 }, note: '刚起来，吃早饭' },
      { from: 9, to: 12, what: { '拼装': 1.2, '撸猫': 1.0, '看风景': 0.8, '收拾': 1.0 }, note: '上午，做点自己喜欢的事' },
      { from: 12, to: 14, what: { '煮面': 1.6, '吃好吃的': 1.3, '午睡': 1.4 }, note: '午饭 + 午休' },
      { from: 14, to: 18, what: { '玩游戏': 1.3, '拼装': 1.1, '逛街': 0.9, '撸猫': 0.9, '洗澡': 1.0 }, note: '下午，玩或出门；到了该洗澡的份就去洗' },
      { from: 18, to: 20, what: { '做饭': 1.5, '吃好吃的': 1.3 }, note: '晚饭时段' },
      { from: 20, to: 23, what: { '玩游戏': 1.2, '洗澡': 0.7, '拼装': 1.0, '看风景': 0.9 }, note: '晚上，休闲（白天没洗到澡的话补一下）' },
      { from: 23, to: 24, what: { '看风景': 1.0, '睡觉': 1.5 }, note: '深夜，准备睡' },
      { from: 0, to: 7, what: { '睡觉': 3.0, '看风景': 0.4 }, note: '该睡了（大概率已在睡）' }
    ],
    // BATH-DAILY：每天一澡的账（self-state.json 的 bath 字段 { lastAt, dayKey }）
    bath: {
      hourFrom: 14,               // 14 点起才算"该洗澡了"（下午澡）
      unwashedBoost: 3.0,         // 今天没洗时洗澡权重的加成倍率（必选倾向）
      washedZero: true            // 洗过 → 权重归零（一天一次）
    }
  },
  // ── ACTIVITY-CLOCK（2026-09-18，Nono："不用我说这干那——我说我先走了，
  //    她们还泡在水里半天"。独立自主的时间感：每件事有自己的自然时长，
  //    提示词按**经过时间**演化（进行中 → 快好了 → 做完了在干下一件），
  //    busyAutoMs 只兜没识别到的事项。词表可配（config.selfState.activities）。
  //    ── 二调（同日，Nono）："30 分钟太短，最好是一整天内提到的现在还在进行
  //    的行为。如：早上喊了逛街带出去了，一直没回来 = 还在外面逛街，
  //    而且会想着怎么还没回去。"→
  //    · 普通事项的窗口拉长到**当天**（早上说煮面，中午还该记得做过这事，
  //      只是早就完了；翻篇=第二天）；
  //    · **出门类事项单列**：outdoor:true，没有"自然时长"——从出门到她说了
  //      回家的话为止都算"在外面"，越久注入越偏向"惦记着该回去了"。
  activities: [
    { words: '看风景 吹风 窗边 阳台 望着外面', typicalMin: 90, finish: '看累了收回视线', next: '在窗边发呆够了，起身活动一下，想到什么就去做' },
    { words: '撸猫 猫 猫咪 rua猫', typicalMin: 40, finish: '猫跑走了', next: '目送猫走，手还留着揉毛的感觉' },
    { words: '玩游戏 游戏 打两把 上号 排位', typicalMin: 60, finish: '这把打完', next: '退出游戏瘫一会儿，回味刚才的操作' },
    { words: '出门 逛街 买菜 取快递 遛 超市 散步 转转 玩 出去', outdoor: true, next: '在外面走着，看看街上/店里的东西', returnWords: '回来了 回家 到家 进门 回去啦 落地' },
    { words: '洗澡 洗头 泡澡 吹头发 淋浴', typicalMin: 25, finish: '擦头发/擦身体', next: '回房间擦头发，可能顺手敷个面膜或者瘫一会儿' },
    { words: '吃 吃好吃的 零食 宵夜 下午茶 奶茶', typicalMin: 25, finish: '吃得差不多了', next: '舔舔嘴角，心满意足地瘫着消化' },
    { words: '贴贴 贴着 蹭 挨着 靠着 窝在怀里', typicalMin: 30, finish: '贴够了（才怪）', next: '赖着不想动，贴人比干什么都恢复' },
    { words: '煮面 煮饭 做饭 烧水 泡面 炖 炒菜', typicalMin: 30, finish: '关火盛出来', next: '端着吃的找地方坐下，边吃边看手机' },
    { words: '拼 组装 素组 渗线 打磨 喷漆 水贴', typicalMin: 90, finish: '收尾整理桌面', next: '把零件摆好拍照欣赏，或者歇会儿揉揉眼睛' },
    { words: '洗衣服 晾衣服 收衣服', typicalMin: 20, finish: '晾完/叠好', next: '洗完手倒杯水，歇口气' },
    { words: '收拾 整理 打扫 拖地 扫地', typicalMin: 30, finish: '收拾完洗手', next: '看着干净的地方满意一下，坐下歇' },
    { words: '刷牙 洗脸 卸妆 敷面膜', typicalMin: 15, finish: '洗完脸', next: '对着镜子看看自己，然后该干嘛干嘛' },
    { words: '写 画 剪 赶稿 做视频 学习 看资料', typicalMin: 60, finish: '告一段落保存', next: '伸个懒腰揉揉手腕，奖励自己刷会儿手机' }
  ]
};

const STATE_FILE = 'self-state.json';

export function selfStatePath() {
  return path.join(DATA_DIR, STATE_FILE);
}

/** 读状态（坏文件/没文件 → awake 兜底）。带自动衰减。 */
export function readSelfState(now = Date.now()) {
  const c = SELF_STATE_DEFAULTS;
  try {
    const j = JSON.parse(fs.readFileSync(selfStatePath(), 'utf8').replace(/^\uFEFF/, ''));
    const s = j?.self || j;
    if (!s || typeof s !== 'object' || !s.status) return { status: 'awake', what: '', at: 0 };
    const at = Number(s.at) || 0;
    // ACTIVITY-CLOCK：已识别事项的 busy 不按 busyAutoMs 过期——
    // 当天内保留（普通事项的做完态/出门类的在外态），隔天翻篇。
    // 出门类（outdoor）当天永不过期（人还在外面）；普通事项上限 = max(busyAutoMs, 时长×3)。
    let autoMs = s.status === 'sleeping' ? c.sleepAutoMs : (s.status === 'busy' ? c.busyAutoMs : 0);
    if (s.status === 'busy') {
      const ac = activityOf(String(s.what || ''), c);
      if (ac?.outdoor) {
        autoMs = 24 * 60 * 60 * 1000;   // 出门：当天之内都算在外
      } else if (ac) {
        // 普通事项：做完态保留到当天结束（≥ 一整天），隔天翻篇
        autoMs = Math.max(c.busyAutoMs, 20 * 60 * 60 * 1000);
      }
    }
    if (autoMs && at && now - at > autoMs) return { status: 'awake', what: '', at: 0 };   // 自然醒
    // NAP-AUTO-WAKE（2026-09-19 二调）：午睡带 wakeAt（now + napMs）——
    // 到点自动醒（readSelfState 现算，不靠外部定时器）：醒后保留"刚醒"痕迹。
    const wakeAt = Number(s.wakeAt) || 0;
    if (s.status === 'sleeping' && wakeAt && now >= wakeAt) {
      return { status: 'awake', what: '午睡醒了', at: wakeAt, wakeAt: 0 };
    }
    const out = { status: String(s.status), what: String(s.what || ''), at };
    if (s.chatKeyOf) out.chatKeyOf = String(s.chatKeyOf);
    if (s.wakeAt) out.wakeAt = Number(s.wakeAt) || 0;
    return out;
  } catch {
    return { status: 'awake', what: '', at: 0 };
  }
}

/** 写状态（原子写，失败静默——状态丢了顶多回到旧行为）。 */
export function writeSelfState(next) {
  try {
    const file = selfStatePath();
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ self: next, updatedAt: Date.now() }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// ── 词表（观察她自己的发言 → 判状态）────────────────────────────────────
// 判"去睡觉"：要出现睡的**意图**词，且不是在说别人/过去的事。
//
// ⚠ 误判事故（2026-09-16 实锤，双机位全锁死）：
//   「昨晚说好抱着睡的，结果我靠着靠着自己睡着了」——早安寒暄，提的是**昨晚**的事
//   「魂还在被窝里没爬出来」——被窝当比喻，人明明在说话
//   旧词表只看"出现没出现"，这两句都被判成 sleeping → sleepGate 拦掉所有消息，
//   表现成"机器人完全不回消息了"。教训：**提到睡觉 ≠ 现在要去睡**。
//
// 修法（三层收紧）：
//   ① 过去时排除：带"昨晚/昨天/前天/刚/早上醒来时/之前"等时间状语的句子，
//      说的是回忆，不是现在的意图；
//   ② "自己睡着了"句式排除：叙述"（当时/结果）睡着了"是回顾，前面必有上文；
//   ③ 只认**现在时的宣告**：晚安 / 我先睡了 / 困了想去睡 / 去被窝了 这类，
//      句子里不能出现"吗/吧/呢"的疑问/反问（"昨晚睡得好吗"不是宣告）。
const SLEEP_PAST_RE = /(昨晚|昨夜|昨天|前天|大前天|早[上晨]?醒来|刚才|之前|上次|那(时|次)|真舒服|真香|好舒服)/;
const SLEEP_STORY_RE = /(自己?睡着了|就睡着了|居然睡着|不知不觉.*睡)/;   // 叙述过去发生的睡着
// 现在时宣告必须在**第一分句**（她自己那半句）：拿第一个逗号/句号前的部分判 sleep，
// 后半句是"劝对方"的客套（"你也早点休息"），不该反过来否掉她自己的睡意。
const firstClause = (t) => String(t).split(/[,，。！？!?\n]/)[0] || '';
// STRONG：明确的**自身**睡意宣告（我先睡了 / 要去睡觉 / 晚安 / 困死了 / 钻进被窝）—— 命中即算。
const SLEEP_STRONG_RE = /(我[^，。！？,!?\s]{0,4}睡|去睡|想睡|要睡|得睡|该睡|晚安|困(?:死了|得不行|到不行)|(?:钻|爬|缩|躲)进?被窝|睡去|呼呼)/;
// WEAK：只提到"睡觉"这件事，主语不明确 —— 可能是说**别人**。
//   ⚠️ 误判事故（2026-09-16 第二起，桐子 data-2 整个上午消失）：
//   她 10:19 在群里说了句「一大早就排队睡觉，这群是宿舍吗」= 吐槽**别人**睡觉，
//   旧 SLEEP_RE 直接命中"睡觉" → 全局状态写成 sleeping → sleepGate 拦掉她所有消息，
//   连"吃醋插一脚"的主动唤醒也被静默吞掉（orchestrator：主动机会跳过）。
//   表现：另一个号（小柚）聊得热火朝天，桐子一个字都没有，日志里只留一行误判。
//   → WEAK 必须再过一道"主语是不是别人"的排除。
const SLEEP_WEAK_RE = /睡(?:一?会|个?觉|一觉)/;
// 全句里出现这些 = 说的是别人/群体在睡（宿舍、这群、排队睡、哄睡…），不是她自己要睡。
const SLEEP_OTHER_RE = /(你们|他俩|他们|她们|大家|这群|群里|宿舍|别人|一个个|排队睡|都在睡|都去睡|哄睡|催(?:人)?睡|劝睡|谁(?:都|也)?睡|睡(?:什么|啥)睡)/;
const SLEEP_NEG_RE = /(别睡|不睡|快起|叫醒|喊醒|吵醒|醒了|没睡|睡(?:得好|得好吗|得咋样|了没有|了么|\?)|你的睡|你睡|你先|快去睡|早点睡|你也(?:早点)?(?:休息|睡))/;
// 判"正在忙某事"：她说出自己在干什么（我去X/我在X/我打算X），
// 动作部分到标点或句尾为止（lookahead，不吞标点）
const BUSY_RE = /(?:我在|我要去|我打算|我来|我去)([^，。！？,!?~～\s]{1,20}?)(?=了\b|啦\b|咯\b|~|～|，|。|！|？|,|!|\?|$)/;
const BUSY_ACTION_RE = /^[\s]*[（(]/;   // 以括号动作开头 = 正在做某事

/**
 * 观察她**自己发出**的一条消息，返回要写的新状态（null = 不变）。
 * 只看明示的意图：说"睡觉/困了"→ sleeping；说"我在干X"→ busy（仅当当前 awake，
 * 免得睡觉中随口一句"我去倒杯水"就把睡覆盖成忙）。
 */
export function stateFromSelfText(text, now = Date.now(), cfg = null) {
  const t = String(text ?? '').trim();
  if (!t) return null;
  // 三层排除都过了、且命中现在时宣告 → 才是真·要睡了。
  // NEG/PAST/STORY 只看**第一分句**：后半句是客套或回忆补充，
  // 不该否掉她前半句的睡意，也不该把客套误判成她的意图。
  const c0 = firstClause(t);
  const strong = SLEEP_STRONG_RE.test(c0);
  const weak = SLEEP_WEAK_RE.test(c0) && !SLEEP_OTHER_RE.test(c0);
  const isSleep = (strong || weak)
    && !SLEEP_NEG_RE.test(c0)
    && !SLEEP_PAST_RE.test(c0)
    && !SLEEP_STORY_RE.test(t);
  if (isSleep) {
    // ── DAY-SLEEP-GATE（2026-09-19 二调，Nono："白天累了不会睡觉，顶多中午
    //    小睡一会"）：白天的睡意宣告不进 sleeping——
    //      · 夜窗（21:00-次日 06:00）→ 正常睡（整觉）；
    //      · 午休窗（12:00-15:00）→ 小睡（nap=true，self-state 带 wakeAt 自动醒）；
    //      · 其余时段 → 不睡：改判"困但找事做"——不写 sleeping（她还会回消息），
    //        状态回落为 null（保留原有 what 痕迹），提示词层由 fatigueBlock
    //        注入"累了找点事缓一缓，别去睡觉"。
    const hour = new Date(now).getHours();
    const fc = (cfg?.selfState?.fatigue) || (cfg?.moodChain?.fatigue) || {};
    const nightFrom = Number(fc.nightFrom ?? 21);
    const morningTo = Number(fc.morningTo ?? 6);
    const noonFrom = Number(fc.noonFrom ?? 12);
    const noonTo = Number(fc.noonTo ?? 15);
    const inNight = hour >= nightFrom || hour < morningTo;
    const inNoon = hour >= noonFrom && hour < noonTo;
    if (inNight) return { status: 'sleeping', what: t.slice(0, 60), at: now };
    if (inNoon) {
      // 午睡：45 分钟后自动醒（wakeAt = now + napMs）
      const napMs = Number(fc.napMs ?? 45 * 60000);
      return { status: 'sleeping', what: '午后小睡', at: now, wakeAt: now + napMs };
    }
    // 白天的睡意 → 不判睡（话照说、事照做，fatigueBlock 教她"别去睡觉"）
    return null;
  }
  // 提到睡但被排除 → 不判 busy，也绝不判睡（原文的两层语义保留，只是"被排除"现在还包括"说的是别人"）
  if (SLEEP_STRONG_RE.test(t) || SLEEP_WEAK_RE.test(t)) return null;
  // BATH-COMMAND（2026-09-20，Nono："用户指定去洗澡等娱乐项目的时候可以去执行"）：
  // 她说「（哥哥叫我去洗澡，）我去洗澡/去泡澡」这类宣告照常走 BUSY_RE；
  // 哥哥的直接指令由 orchestrator 入口观察（见 bathCommandFromText）。
  const m = BUSY_RE.exec(t);
  if (m) {
    const act = m[1].trim();
    if (act && act.length >= 2 && !/睡/.test(act)) {
      return { status: 'busy', what: act.slice(0, 40), at: now };
    }
  }
  return null;
}

// ═══ BATH-DAILY 每日一澡（2026-09-20，Nono："作息表每天都要洗澡，刚好在下午；
//       下午累了可以去洗个澡（减中高部分疲惫）；哥哥指定也可以执行；
//       两位一起泡澡减得更多还加很多亲密值"）═══
// 账本：self-state.json 的 bath 字段 { lastAt, dayKey, withSister }（一天一次）。
const BATH_START_RE = /(去洗(?:个)?(?:澡|头)|去泡(?:个)?澡|洗(?:个)?澡去|泡(?:个)?澡去|我(?:去|要)(?:洗|泡)(?:澡|头|个澡)|沐浴)/;
const BATH_DONE_RE = /(洗完|洗好了|泡完|泡好了|擦(?:头发|身体|干)|吹(?:头发|干)|出来了|(?:洗|泡)得(?:差不多|舒(?:服|坦)))/;
const BATH_SISTER_RE = /(和|跟|陪|约)[^，。！？,!?]{0,8}(一起)?(?:泡澡|洗澡|搓澡)|(一起)(?:泡澡|洗澡)|姐妹澡|两个人?泡/;

/** 读洗澡账本（坏档 = 没洗过）。 */
export function readBathState(now = Date.now()) {
  try {
    const j = JSON.parse(fs.readFileSync(selfStatePath(), 'utf8').replace(/^\uFEFF/, ''));
    const b = j?.bath || {};
    const dayKey = new Date(now).toISOString().slice(0, 10);
    const washedToday = String(b.dayKey || '') === dayKey && Number(b.lastAt) > 0;
    return { washedToday, lastAt: Number(b.lastAt) || 0, withSister: b.withSister === true };
  } catch { return { washedToday: false, lastAt: 0, withSister: false }; }
}

/** 记一笔澡（一天一次的账本；withSister = 双人泡澡）。 */
export function writeBathState({ withSister = false, now = Date.now() } = {}) {
  try {
    const f = selfStatePath();
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    j.bath = { lastAt: now, dayKey: new Date(now).toISOString().slice(0, 10), withSister: withSister === true };
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
    fs.renameSync(tmp, f);
    return true;
  } catch { return false; }
}

/** 她的发言命中「去洗澡」宣告吗（进行时）。 */
export function bathStartFromSelfText(text) {
  const t = String(text ?? '');
  if (!t) return false;
  if (!BATH_START_RE.test(t)) return false;
  return !BATH_DONE_RE.test(t);   // 「洗完了」是完成时不是开始
}

/** 她的发言命中「洗完了」吗（完成时 → 结算）。 */
export function bathDoneFromSelfText(text) {
  return BATH_DONE_RE.test(String(text ?? ''));
}

/** 双人泡澡吗（她的话里带了和姊妹一起泡）。 */
export function bathWithSisterFromSelfText(text) {
  return BATH_SISTER_RE.test(String(text ?? ''));
}

/**
 * 哥哥的指令命中吗（「去洗澡/去泡个澡/洗个澡再睡」这类对他说的祈使句）。
 * 给 orchestrator 触发轮用：他说了 → prompt 注入"听他的话去洗澡（写 busy）"，
 * 她下一轮自己宣告去洗 → bathStart 落账（软接线：他指令不是直接控制她）。
 */
const BATH_CMD_RE = /(去洗(?:个)?(?:澡|头|热水澡)|去泡(?:个)?澡|洗(?:个)?澡(?:去|吧|再睡|放松下|解解乏)|(?:先|快)去(?:洗|泡)|(?:洗|泡)完(?:再睡|再说))/;
export function bathCommandFromText(texts) {
  const joined = (Array.isArray(texts) ? texts : [texts]).map((t) => String(t ?? '')).join(' ');
  return BATH_CMD_RE.test(joined);
}

/** 洗澡结算数值（BATH-UPGRADE）：独浴 -25 疲劳；双人泡澡 -40 + 姊妹亲密 +12。 */
export const BATH_EFFECTS = {
  solo: { fatigue: -25, happy: 2, sister: 0, note: '洗个热水澡，洗去一身乏' },
  together: { fatigue: -40, happy: 6, sister: 12, note: '和她一起泡澡，泡得脸红心跳，感情升温' }
};

/** settleRecovery 的洗澡特化结算（把 effects 真正接线——之前 settleRecovery 零调用方，
 *  恢复数值从未生效，这次一并接上）。返回给调用方写 mood.json + sister。 */
export function settleBath({ withSister = false } = {}) {
  const e = withSister ? BATH_EFFECTS.together : BATH_EFFECTS.solo;
  return { ...e, satisfied: true, source: withSister ? '双人泡澡' : '洗澡' };
}

/**
 * 喊醒判定：这批触发消息里有没有"在叫她起来"。
 * 要求：有人 @ 她/叫她名字（addressed），且正文带唤醒词。
 * 只在 sleeping 状态下被调用。
 */
const WAKE_RE = /(别睡|快起|起床|起来|叫醒|喊醒|吵醒|醒醒|不许睡|起来嗨|别装睡)/;

/**
 * 接触类唤醒词（2026-09-17 哥哥要求：「触发接触行为的关键词后也要能回复」）。
 *
 * 保守词表：不写裸"亲"（亲爱的/亲戚/亲测会误伤）、不写裸"咬"这类歧义字。
 * 只在**她睡着**时判定，且群里仍然要求"被 @/被叫名字"才算（见 isWakeCall）。
 */
const TOUCH_RE = /(摸+一下|摸+一把|摸摸|摸头|抱抱|抱一下|抱住|抱|亲亲|亲一口|亲一下|贴贴|蹭|揉|搂|捏|舔|牵|挠|背我|钻被窝|坐腿上)/;

export function isWakeCall(entries = [], { selfNickname = '', botName = '', selfId = '', isPrivate = false } = {}) {
  const nick = String(selfNickname || '').trim();
  const bot = String(botName || '').trim();
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.self) continue;
    const t = String(e?.text ?? '');
    if (!WAKE_RE.test(t) && !TOUCH_RE.test(t)) continue;
    // 私聊里"她本来就是被单独找的" → 不再要求 @ 或喊名字。
    // （2026-09-17 实锤：原来 addressed 只认「@你 / 名字 / isAtMe」，而私聊消息里既没有
    //   at 段、正文也常常不带名字 → 私聊说「摸摸」永远醒不了，这条需求根本落不了地。）
    const addressed = isPrivate
      || t.includes('@你')
      || (nick && t.includes(nick))
      || (bot && t.includes(bot))
      || !!e?.isAtMe;
    if (addressed) return true;
  }
  return false;
}

/**
 * 睡着时"要不要私聊告诉他一声"（纯函数，便于回归）。
 *
 * SLEEP-NOTICE（2026-09-17 哥哥要求）：「在群里说过要睡觉之后，私信和我说一声，
 * 而且不需要我的回复；只要我把他们喊醒、或者触发接触行为的关键词之后再回复」。
 *
 * 只在**群里**刚睡着的那一次通知；私聊里说睡不用通知（那本来就是对他说的）。
 */
export function shouldNotifySleepNotice({ prevStatus = '', nextStatus = '', chatKey = '', cfg = null } = {}) {
  const c = { sleepNotice: true, ...((cfg && cfg.selfState) || {}) };
  if (c.sleepNotice === false) return false;
  if (String(nextStatus) !== 'sleeping') return false;
  if (String(prevStatus) === 'sleeping') return false;     // 已经睡着 → 不重复通知
  return String(chatKey).startsWith('group:');             // 只在群里说了才通知
}

/** 标记"刚被喊醒"（醒来时刻 + 原来在干嘛，供提示词演迷糊）。 */
export function markWoken(now = Date.now()) {
  const cur = readSelfState(now);
  const next = { status: 'awake', what: cur.what, at: cur.at, wakeAt: now };
  writeSelfState(next);
  return next;
}

/**
 * 是否处在"刚被叫醒"的保护窗内（主人起床口令命中后由 tick 用来挡住"自己睡回去"）。
 *
 * 为什么需要：被叫醒后若立刻又被作息表掷中睡觉，表现就是"叫她起床、十分钟后又睡了"，
 * 功能等于没生效。窗口直接复用 wakeMentionMs（默认 30 分钟）—— 跟"演迷糊"同一个窗口，
 * 迷糊着的时候本来就不该倒回被窝。
 *
 * @param {object} selfState readSelfState 的返回值
 * @param {object} cfg 引擎配置
 * @returns {boolean} true = 还在保护窗内
 */
export function inWakeGrace(selfState, cfg = null, now = Date.now()) {
  const wakeAt = Number(selfState?.wakeAt) || 0;
  // ⚠️ 未来时间不算：那是**午睡自动醒的预约标记**（wakeAt = now + napMs），
  //    不是"刚被叫醒"。不排除的话，午睡期间会被当成"刚醒"而挡掉别的事项。
  if (!wakeAt || wakeAt > now) return false;
  const c = { ...SELF_STATE_DEFAULTS, ...((cfg && cfg.selfState) || {}) };
  const win = Number(c.wakeMentionMs) || 30 * 60 * 1000;
  return (now - wakeAt) < win;
}

/**
 * 睡眠闸主判定（orchestrator.wake 入口用）：
 * @returns {{block: boolean, reason: string, woken: boolean}}
 *   block=true → 这轮直接静默（不建会话、不调模型）
 *   woken=true → 放行且是"被喊醒"那轮
 */
export function sleepGate({ entries = [], selfNickname = '', botName = '', selfId = '', cfg = {}, now = Date.now(), isPrivate = false } = {}) {
  const c = { ...SELF_STATE_DEFAULTS, ...(cfg?.selfState || {}) };
  if (c.enabled === false) return { block: false, reason: 'disabled', woken: false };
  const s = readSelfState(now);
  if (s.status !== 'sleeping') return { block: false, reason: `status=${s.status}`, woken: false };
  // 睡着中：有人喊醒（喊醒词 / 接触词）→ 放行并标记
  if (isWakeCall(entries, { selfNickname, botName, selfId, isPrivate })) {
    return { block: false, reason: 'sleeping→被喊醒', woken: true };
  }
  // 睡着中：被 @/被引用/被戳也不响应吗？——是的，真人睡着了 @ 她也听不到；
  // 只有"喊醒式"的内容才吵得起来。普通 @ 当没听见（这就是行为一致性）。
  return { block: true, reason: 'sleeping（未被喊醒）', woken: false };
}/**
 * 事项识别（ACTIVITY-CLOCK 的核心）：what 文本 → 命中的事项档（时长+收尾+接续）。
 * 未识别 → null（走 busyAutoMs 兜底）。config.selfState.activities 可整体覆盖词表。
 * outdoor 事项没有自然时长——「从出门到说回家」都算在外面。
 */
export function activityOf(what, cfg) {
  const w = String(what ?? '');
  if (!w) return null;
  let list = SELF_STATE_DEFAULTS.activities;
  const custom = cfg?.activities;
  if (Array.isArray(custom) && custom.length) {
    list = custom.map((a) => ({
      words: String(a?.words || ''),
      typicalMin: Math.max(3, Number(a?.typicalMin) || 0),
      finish: String(a?.finish || '收尾'),
      next: String(a?.next || '歇一会儿'),
      outdoor: a?.outdoor === true,
      returnWords: String(a?.returnWords || '回来了 回家 到家 进门')
    }));
  }
  for (const a of list) {
    for (const word of String(a.words).split(/[\s,，、]+/).filter(Boolean)) {
      if (w.includes(word)) {
        return {
          typicalMin: Number(a.typicalMin) || 0,
          finish: a.finish,
          next: a.next,
          word,
          outdoor: a.outdoor === true,
          returnWords: String(a.returnWords || '回来了 回家 到家 进门')
        };
      }
    }
  }
  return null;
}

/**
 * 出门是否已结束：她说的话里带回家信号（回来了/到家/进门…）→ true。
 * OUTDOOR-CLOSE 挂在 sender 出口（stateFromSelfText 同位置）——她说了回家的
 * 话就把 outdoor 的 busy 收掉；没说过 = 一直还在外面（当天有效）。
 */
export function outdoorReturnHit(text, cfg) {
  const t = String(text ?? '');
  if (!t) return false;
  let list = SELF_STATE_DEFAULTS.activities;
  const custom = cfg?.selfState?.activities;
  if (Array.isArray(custom) && custom.length) {
    return custom.some((a) => a?.outdoor === true
      && String(a?.returnWords || '回来了 回家 到家 进门').split(/[\s,，、]+/).some((w) => w && t.includes(w)));
  }
  for (const a of list) {
    if (a.outdoor !== true) continue;
    for (const w of String(a.returnWords).split(/[\s,，、]+/).filter(Boolean)) {
      if (t.includes(w)) return true;
    }
  }
  return false;
}

// ── OUTDOOR-AUTO-HOME（2026-09-18 三调，Nono："一直没回来很可能是用户忘记了，
//    bot 应该根据自主行动思维决定：用户很久没提过逛街相关 → 想他应该是忘了，
//    我自己先回去吧，然后私聊单独和用户说一声，不用回复。"）──
// 判定（谁在什么时候判）：orchestrator 每个触发轮——
//   出门状态 ≥ forgetAfterMs（默认 3h），且近 windowMs 内**他的入站消息**不再提
//   出门话题（逛街/买/逛/店…），也没有她的回家声明 → 判「他忘了」；
//   收掉出门状态 + 写一条 pending 通知（回家文案，复用 SLEEP-NOTICE 的
//   「单向私聊、不需要他回」通道）。
export const OUTDOOR_HOME_DEFAULTS = {
  enabled: true,
  forgetAfterMs: 3 * 60 * 60 * 1000,   // 出门多久后开始判「他是不是忘了」
  topicWindowMs: 60 * 60 * 1000,       // 往回看多久的入站消息算「他还在提吗」
  topicWords: '逛街 逛 街 买 买东西 店 超市 便利店 快递 散步 走 那边 外面 排队 试 衣服',
  // 通知文案（{out} = 出门时说的事）。口吻：她自己决定先回去，不是抱怨被丢下。
  noticeText: '哥哥，我先自己回去啦——你那边好像忙忘了，我逛得也差不多了。到家了我跟你说。'
};

/** 近窗内他的消息里还提不提出门话题（在提 = 他没忘，继续陪）。 */
export function outdoorTopicRecent(ownerTexts = [], cfg = {}, now = Date.now()) {
  const c = { ...OUTDOOR_HOME_DEFAULTS, ...((cfg?.selfState?.outdoorHome) || {}) };
  const win = Number(c.topicWindowMs) || 3600000;
  const words = String(c.topicWords).split(/[\s,，、]+/).filter(Boolean);
  for (const e of (Array.isArray(ownerTexts) ? ownerTexts : [])) {
    const ts = Number(e?.ts) || 0;
    if (ts && now - ts > win) continue;
    const t = String(e?.text ?? '');
    if (!t) continue;
    if (words.some((w) => w && t.includes(w))) return true;
  }
  return false;
}

/**
 * 出门自主回家判定（orchestrator 每轮调；纯判定，动作由调用方做）。
 * @param {object} st self-state 现状（readSelfState 的返回值）
 * @param {Array} ownerRecent 他的近期入站消息 [{text, ts}]
 * @param {object} cfg
 * @returns {boolean} true = 判定「他忘了」，该自己回家了
 */
export function shouldAutoReturnHome(st, ownerRecent = [], cfg = {}, now = Date.now()) {
  const c = { ...OUTDOOR_HOME_DEFAULTS, ...((cfg?.selfState?.outdoorHome) || {}) };
  if (c.enabled === false) return false;
  if (!st || String(st.status) !== 'busy') return false;
  const ac = activityOf(String(st.what || ''), cfg?.selfState || cfg);
  if (!ac?.outdoor) return false;
  const at = Number(st.at) || 0;
  if (!at || now - at < (Number(c.forgetAfterMs) || 3 * 3600000)) return false;
  // 他还在提出门的事 → 没忘，不判
  if (outdoorTopicRecent(ownerRecent, cfg, now)) return false;
  return true;
}

/** 回家通知文案（{out} 占位替换）。 */
export function outdoorHomeNoticeText(what, cfg = {}) {
  const c = { ...OUTDOOR_HOME_DEFAULTS, ...((cfg?.selfState?.outdoorHome) || {}) };
  return String(c.noticeText || OUTDOOR_HOME_DEFAULTS.noticeText)
    .replace(/\{out\}/g, String(what || '').slice(0, 24));
}

// ── RECOVERY-PICK（2026-09-18 第一波）：疲惫时自主选恢复行为 ──────────────────
// 入口 pickRecovery(cfg)：疲劳 ≥ 阈值 + 她闲着（awake 且最近没有别的 busy）+
// 概率命中 → 按人设权重选一个事项返回（调用方写进 self-state 的 busy，自然走
// ACTIVITY-CLOCK 的演化 + effects 结算）。返回 null = 这次不选。
// 状态（冷却）存 self-state.json 的 recovery 字段：{ lastPickAt }。
export function pickRecovery(cfg = {}, fatigueValue = 0, now = Date.now(), rnd = Math.random) {
  const base = SELF_STATE_DEFAULTS.recovery || {};
  const c = { ...base, ...((cfg?.selfState?.recovery) || {}) };
  if (c.enabled === false) return null;
  const st = readSelfState(now);
  if (String(st.status) !== 'awake') return null;   // 忙着/睡着都不选
  if (Number(fatigueValue) < Number(c.threshold)) return null;
  // 冷却：上一件恢复事项还没歇够
  let lastPickAt = 0;
  try {
    const j = JSON.parse(fs.readFileSync(selfStatePath(), 'utf8').replace(/^\uFEFF/, ''));
    lastPickAt = Number(j?.recovery?.lastPickAt) || 0;
  } catch { /* 读不到 = 没冷却 */ }
  if (lastPickAt && now - lastPickAt < (Number(c.cooldownMs) || 5400000)) return null;
  // 概率门（不是一累就立刻弹——人拖着的时候多的是）
  if ((typeof rnd === 'function' ? rnd() : Math.random()) > (Number(c.chancePerCheck) || 0.3)) return null;
  // 权重选择
  const weights = (c.weights && typeof c.weights === 'object') ? c.weights : base.weights;
  const entries = Object.entries(weights).filter(([k]) => k && (c.effects?.[k]));
  if (!entries.length) return null;
  const total = entries.reduce((n, [, w]) => n + Math.max(0, Number(w) || 0), 0);
  let roll = (typeof rnd === 'function' ? rnd() : Math.random()) * total;
  let pick = entries[0][0];
  for (const [k, w] of entries) {
    roll -= Math.max(0, Number(w) || 0);
    if (roll <= 0) { pick = k; break; }
  }
  // 记冷却
  try {
    const f = selfStatePath();
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, ''));
    j.recovery = { lastPickAt: now };
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  } catch { /* 记不了就算了 */ }
  const effect = c.effects?.[pick] || base.effects?.[pick] || {};
  return { pick, note: effect.note || pick };
}

/** 恢复事项做完后的数值结算（ACTIVITY-CLOCK 翻篇时由调用方调；写 mood.json）。
 *  SATISFACTION/DEPRESS（2026-09-19 第三波）：结算同时返回 satisfied/depressSide
 *  两个信号——调用方据此调 stepSatisfaction('recovery') / stepDepress(-recoveryBonus)。
 *  这里的 depress 特别项：「看风景」是抑郁的指定出口（减得更狠，见 mood-chain
 *  的 DEPRESS_DEFAULTS.recoveryBonus），所有恢复事项都带一点抑郁缓解。 */
export function settleRecovery(pick, cfg = {}) {
  const base = SELF_STATE_DEFAULTS.recovery || {};
  const c = { ...base, ...((cfg?.selfState?.recovery) || {}) };
  const effects = (c.effects && typeof c.effects === 'object') ? c.effects : base.effects;
  const e = effects?.[String(pick)];
  if (!e) return null;
  return {
    fatigue: Number(e.fatigue) || 0,
    happy: Number(e.happy) || 0,
    excited: Number(e.excited) || 0,
    satisfied: true,                       // 恢复事项一律攒满足感（source 表按事项名给分）
    source: String(pick)
  };
}

// ── SCHEDULE 作息表（2026-09-19 第二波）：时段驱动的自主事项选择 ──────────────
// 入口 pickScheduled(cfg, now, rnd)：
//   · 她闲着（awake）+ 当前时段有候选 + 概率命中 → 按权重选一件 → 写 busy
//    （调用方写，同 pickRecovery 的约定：返回 { pick, note }，null = 不选）；
//   · 「睡觉」是特殊候选：返回 { pick: '__sleep__' }，调用方写 sleeping 状态
//    （作息表的"该睡了"就是真的去睡，走 sleepGate 那套）。
// 入口 pickBoredSwitch(cfg, now, rnd)：
//   · 她在忙（busy）+ 忙够了 boredAfterMs + 概率命中 → 返回**另一件**当前时段的
//    候选（玩腻了换事——"今天的桐子玩游戏玩腻了，可能突然去洗个澡或者睡一小会"）。
// 冷却（lastPickAt）与恢复池**共用**一个字段：刚做完一件事，两边都不该马上再选。

/** 当前小时的时段配置（含权重候选）。 */
export function scheduleSlotOf(cfg = {}, now = Date.now()) {
  const base = SELF_STATE_DEFAULTS.schedule || {};
  const c = { ...base, ...((cfg?.selfState?.schedule) || {}) };
  const slots = Array.isArray(c.slots) && c.slots.length ? c.slots : base.slots;
  if (!Array.isArray(slots)) return null;
  const h = new Date(now).getHours();
  for (const s of slots) {
    const from = Number(s?.from) || 0;
    const to = Number(s?.to) || 0;
    const hit = from <= to ? (h >= from && h < to) : (h >= from || h < to);
    if (hit) return { slot: s, note: String(s?.note || ''), hour: h };
  }
  return null;
}

/** 按当前时段的权重表选一件事（共享 recovery 的权重掷骰写法）。 */
function pickFromWhat(what, rnd) {
  const entries = Object.entries(what || {}).filter(([k, w]) => k && Number(w) > 0);
  if (!entries.length) return null;
  const total = entries.reduce((n, [, w]) => n + Math.max(0, Number(w) || 0), 0);
  let roll = (typeof rnd === 'function' ? rnd() : Math.random()) * total;
  let pick = entries[0][0];
  for (const [k, w] of entries) {
    roll -= Math.max(0, Number(w) || 0);
    if (roll <= 0) { pick = k; break; }
  }
  return pick;
}

/** 读 self-state.json 里的 recovery.lastPickAt（与恢复池共用的冷却字段）。 */
function readLastPickAt() {
  try {
    const j = JSON.parse(fs.readFileSync(selfStatePath(), 'utf8').replace(/^\uFEFF/, ''));
    return Number(j?.recovery?.lastPickAt) || 0;
  } catch { return 0; }
}

function writeLastPickAt(now) {
  try {
    const f = selfStatePath();
    const j = JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) || {};
    j.recovery = { ...(j.recovery || {}), lastPickAt: now };
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  } catch { /* 记不了就算了 */ }
}

/**
 * 作息表选择（闲着时）：她按参考日程自己找事做。
 * @returns {{pick:string, note:string, sleep?:boolean}|null} pick='__sleep__' = 该睡了
 */
export function pickScheduled(cfg = {}, now = Date.now(), rnd = Math.random) {
  const base = SELF_STATE_DEFAULTS.schedule || {};
  const c = { ...base, ...((cfg?.selfState?.schedule) || {}) };
  if (c.enabled === false) return null;
  const st = readSelfState(now);
  if (String(st.status) !== 'awake') return null;   // 忙着/睡着都不选
  const hit = scheduleSlotOf(cfg, now);
  if (!hit) return null;
  const lastPickAt = readLastPickAt();
  if (lastPickAt && now - lastPickAt < (Number(c.cooldownMs) || 3000000)) return null;
  if ((typeof rnd === 'function' ? rnd() : Math.random()) > (Number(c.chancePerCheck) || 0.18)) return null;
  // BATH-DAILY：时段候选过一遍洗澡账本——
  //   今天没洗 + 已过 hourFrom → 洗澡权重 ×unwashedBoost（下午该洗了，必选倾向）；
  //   今天洗过 → 洗澡权重清零（一天一次）。
  const what = { ...(hit.slot.what || {}) };
  const bc = { ...(base.bath || {}), ...((cfg?.selfState?.schedule?.bath) || {}) };
  if ('洗澡' in what) {
    const bath = readBathState(now);
    const hour = new Date(now).getHours();
    if (bath.washedToday) {
      if (bc.washedZero !== false) delete what['洗澡'];
    } else if (hour >= (Number(bc.hourFrom) || 14)) {
      what['洗澡'] = (Number(what['洗澡']) || 1) * (Number(bc.unwashedBoost) || 3);
    }
  }
  const pick = pickFromWhat(what, rnd);
  if (!pick) return null;
  writeLastPickAt(now);
  if (pick === '睡觉' || pick === '午睡') {
    return { pick: '__sleep__', note: pick === '午睡' ? '午饭后犯困，小睡一会儿' : '到点该睡了', sleep: true };
  }
  const ac = activityOf(pick, cfg?.selfState || {});
  const note = ac?.next || hit.note;
  return { pick, note };
}

/**
 * 玩腻了换事（忙着时）：忙够了 boredAfterMs + 概率 → 从当前时段候选里挑
 * **另一件**事（不是现在做的这件）。返回 { pick, note } 或 null。
 * 调用方把 busy 的 what 换掉（at 重置，ACTIVITY-CLOCK 重新演化）。
 */
export function pickBoredSwitch(cfg = {}, now = Date.now(), rnd = Math.random) {
  const base = SELF_STATE_DEFAULTS.schedule || {};
  const c = { ...base, ...((cfg?.selfState?.schedule) || {}) };
  if (c.enabled === false) return null;
  const st = readSelfState(now);
  if (String(st.status) !== 'busy' || !st.what) return null;
  const busyMs = now - (Number(st.at) || now);
  if (busyMs < (Number(c.boredAfterMs) || 1800000)) return null;   // 还没玩腻
  if ((typeof rnd === 'function' ? rnd() : Math.random()) > (Number(c.boredChance) || 0.12)) return null;
  const hit = scheduleSlotOf(cfg, now);
  if (!hit) return null;
  // 候选里排除"正在做的这件"（按事项词出现在当前 what 里判重）
  const cur = String(st.what || '');
  const what = {};
  for (const [k, w] of Object.entries(hit.slot.what || {})) {
    if (k === '睡觉' || k === '午睡') continue;          // 玩腻换事不换去睡觉（睡觉走正门）
    if (cur.includes(k)) continue;                        // 别换回同一件
    what[k] = w;
  }
  const pick = pickFromWhat(what, rnd);
  if (!pick) return null;
  const ac = activityOf(pick, cfg?.selfState || {});
  return { pick, note: ac?.next || `玩腻了，换成${pick}` };
}

/**
 * 作息表注入块（prompt.js【此刻状态】用）：只在她闲着且作息表开着时给一行
 * "这个点你本来会在干什么"的参考（不是指令——日程是参考不是规则）。
 * 忙着时不注入（busy 的演化由 selfStateBlock 管，别抢戏）。
 */
export function scheduleBlock(cfg, now = Date.now()) {
  const base = SELF_STATE_DEFAULTS.schedule || {};
  const c = { ...base, ...((cfg?.selfState?.schedule) || {}) };
  if (c.enabled === false) return null;
  const st = readSelfState(now);
  if (String(st.status) !== 'awake') return null;
  const hit = scheduleSlotOf(cfg, now);
  if (!hit) return null;
  const tops = Object.entries(hit.slot.what || {})
    .filter(([k]) => k !== '睡觉')
    .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))
    .slice(0, 2)
    .map(([k]) => k);
  if (!tops.length) return null;
  return `【作息·参考】这个点（${String(hit.hour).padStart(2, '0')} 点档）你平时多半在：${tops.join(' / ')}。只是参考——现在没在做也正常，聊天里自然带出你现在的生活状态就好，别报日程。`;
}


/**
 * 提示词注入段（prompt.js【此刻状态】用）。返回 string 或 null。
 * 覆盖三种情况：刚被喊醒（演迷糊）、清醒但说过要睡（别兴奋）、正在忙（贴合着说）。
 */
export function selfStateBlock(cfg, now = Date.now()) {
  const c = { ...SELF_STATE_DEFAULTS, ...(cfg?.selfState || {}) };
  if (c.enabled === false) return null;
  const s = readSelfState(now);
  if (s.status === 'sleeping') {
    return null;   // 睡着时根本不会被唤醒（sleepGate 拦了），这段只在极少数漏网时用
  }
  if (s.wakeAt && now - s.wakeAt < c.wakeMentionMs) {
    const min = Math.max(1, Math.round((now - s.wakeAt) / 60000));
    // WAKE-SLEEPY（2026-09-20，Nono："中途叫醒时回一句带睡意的'唔…才睡X分钟'，
    // 时间真实从 sleptAt 算——加强睡觉实感"）：叫醒那一下如果距入睡不到 3 小时
    // （是"中途被叫醒"而不是"睡饱了自然醒"），注入明确提示：第一句就带睡意
    // 报出真实睡时长，之后的话音也要拖着没睡醒的调子。
    try {
      // 入睡时刻存在 **mood.json 的 fatigue.sleptAt**（stepFatigue 维护），不在 self-state 里。
      // ⚠️ 原实现写成 `path.join(path.dirname(selfStatePath()), '..', 'mood.json')` ——
      //    dirname(statePath) 已经是数据目录了，再 `..` 就跳到数据目录**外面**，
      //    那个路径永远不存在 → 这条"才睡X分钟"的演出实际上从未生效过。
      //    （2026-09-22 修：去掉多余的 `..`，并删掉上面那段读 self-state 找 fatigue.sleptAt
      //      的死代码 —— 那个键在 self-state 里根本不存在。）
      const moodF = path.join(path.dirname(selfStatePath()), 'mood.json');
      let sleptFrom = 0;
      try {
        sleptFrom = Number(JSON.parse(fs.readFileSync(moodF, 'utf8'))?.fatigue?.sleptAt) || 0;
      } catch { /* 读不到就按普通刚醒演 */ }
      if (sleptFrom > 0 && (now - sleptFrom) < 3 * 3600000) {
        const sleptMin = Math.max(1, Math.round((now - sleptFrom) / 60000));
        return `【自身状态】你 ${sleptMin} 分钟前才睡着就被叫醒了——第一句话就带着浓浓的睡意（"唔……才睡${sleptMin}分钟……干嘛啊……"这种感觉，用自己的说法），眼睛根本睁不开，说话黏糊、句子短短的${s.what ? `（睡前在：${s.what}）` : ''}。缓过来要好几条消息的时间，别立刻精神。`;
      }
    } catch { /* 读不到入睡时间就按普通刚醒演 */ }
    return `【自身状态】你 ${min} 分钟前刚被叫醒${s.what ? `（之前：${s.what}）` : ''}——还有点迷糊，眼睛没睁开全，回话短一点、带着刚醒的不耐烦或软乎乎，别立刻精神抖擞。`;
  }
  // busy 优先于"刚说过要睡"的困倦提醒：状态只有一份，busy 在 sleeping 之后
  // 写入就意味着她已经起来了、正在做事（比如被叫醒后去倒水）。
  // ACTIVITY-CLOCK（2026-09-18）：按**经过时间 × 事项自然时长**演化——
  //   进行中（<70%）→ 快好了（70%~100%）→ 做完了（>100%，注入"在干下一件"的
  //   自主接续，她有自己的生活节奏，不需要哥哥提醒她该从浴缸里出来了）。
  //   窗口 = 当天（普通事项做完态保留到当天结束，隔天翻篇——"一整天内提到
  //   的现在还在进行的行为"）；出门类（outdoor）不按时长演化，见下。
  if (s.status === 'busy' && s.what) {
    const ac = activityOf(s.what, c);
    const elapsed = now - (Number(s.at) || now);
    const sameDay = new Date(Number(s.at) || now).toDateString() === new Date(now).toDateString();
    if (ac?.outdoor) {
      // OUTDOOR（2026-09-18 二调，Nono："早上喊了逛街带出去了，一直没回来 =
      // 还在外面逛街，而且会想着怎么还没回去"）：从出门到回家声明为止都算在外面，
      // 时间越久越惦记。当天有效，隔天当她已经回过家（人总要睡觉）。
      if (!sameDay) return null;
      const h = Math.max(1, Math.round(elapsed / 3600000));
      if (h <= 1) {
        return `【自身状态】你在外面（${s.what}）——刚出去不久，街上/店里的东西正看着呢。人在外面，回话断断续续是正常的（走着看、排队、挑东西）。`;
      }
      if (h <= 4) {
        return `【自身状态】你在外面（${s.what}）已经 ${h} 个小时了——逛得有点久，腿开始酸，可能买了点东西拎着。聊天的语气带点在外面走着的松弛和分心。`;
      }
      return `【自身状态】你出门（${s.what}）已经 ${h} 个小时了还没回去——你自己也觉得逛太久了（想回去了/东西买得差不多了/有点累有点饿），嘴上可能会念叨一句"该回去了"，但回不回是你自己的节奏，不是谁安排的。`;
    }
    if (ac && ac.typicalMin > 0) {
      const durMs = ac.typicalMin * 60000;
      const pct = elapsed / durMs;
      if (pct < 0.7) {
        return `【自身状态】你正在做的事：${s.what}（还在进行中）。回话要贴合这个状态——可以被聊天打断一下，但别表现得百无聊赖，也别忘掉自己刚才在干什么。`;
      }
      if (pct < 1.15) {
        return `【自身状态】你正在做的事：${s.what}——已经差不多了（${ac.finish}），再有几分钟就完事。回话里可以带着"快弄完了"的松动感，别演成刚开始。`;
      }
      // 做完了：自主接续（她不会原地定格等指令）；做完态保留到当天结束
      if (!sameDay) return null;
      const min = Math.max(1, Math.round((elapsed - durMs) / 60000));
      const agoWord = min < 60 ? `${min} 分钟前` : `${Math.round(min / 60)} 小时前`;
      return `【自身状态】${s.what}——${agoWord}就已经做完了，你早就${ac.next}。这是你自己安排的（不用跟谁汇报），聊到现在很自然；如果聊到刚才那件事，记得用"已经弄完了"的过去时态说。`;
    }
    // 未识别事项：老逻辑（busyAutoMs 内=还在进行中）
    if (Number(s.at) && now - s.at < c.busyAutoMs) {
      return `【自身状态】你正在做的事：${s.what}（还在进行中）。回话要贴合这个状态——可以被聊天打断一下，但别表现得百无聊赖，也别忘掉自己刚才在干什么。`;
    }
  }
  if (s.at && now - s.at < c.awakeGraceMs && s.what) {
    const min = Math.max(1, Math.round((now - s.at) / 60000));
    return `【自身状态】你 ${min} 分钟前刚说过「${s.what.slice(0, 30)}」——言犹在耳：除非他找你有事，否则别兴致勃勃主动接话，回了也该是困倦、简短的。`;
  }
  return null;
}
