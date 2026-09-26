// 本体情绪/状态 v2
// - 跨群一份；离散情绪 + 慢心情 + 精力 + 压力 + 元认知
// - 注入极轻：默认几乎不说话；只有值得时补 1~2 句行为倾向
// - 不覆盖 perChat 的响应策略：randomPercent=0 绝不因情绪开口；
//   >0 时情绪只做 ±6 微调，且最终概率硬顶在设置值 1.25 倍 +2 以内
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from './config.js';
import { botStateFile } from './paths.js';
import { isHypeMode, getHypeProtectedQQ } from './hype-mode.js';
import { getEmotionProfile, EMOTION_PROFILES, listEmotionProfiles, DEFAULT_EMOTION_PROFILE } from './emotion-personality.js';

export { listEmotionProfiles, EMOTION_PROFILES, DEFAULT_EMOTION_PROFILE, getEmotionProfile };

const FILE = botStateFile();
const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * 离散情绪（0~100 强度）+ 半衰期（分钟）。
 * 只算被事件激活的；未激活保持 0。
 * cat: pos 正 / neg 负 / neu 中 —— 给后台分组展示。
 * 半衰统一压到 20 分钟量级：尖峰 3~10，底色 15~25。
 */
/**
 * 21 个离散情绪，按**方向**分三类，不再按正负：
 *   out 向外 = 会外显（炸毛、得瑟、开心）
 *   in  向内 = 闷在心里（焦虑、低落、羞愧）
 *   neu 中性 = 机动（好奇、惊讶、期待）
 * 正负没有单独成类 —— 向外的可以是愤怒也可以是得意，向内的可以是低落也可以是内疚。
 */
/**
 * 情绪池：只保留仍写得进来的维度。
 * Jev 只判 7 种社交向；刷屏/冷落/工具失败走环境规则。
 * 嫉妒/厌恶/内疚/恐惧/惊讶/亢奋/期待 等 —— Jev 不判且无稳定入口，已删。
 */
const EMOTIONS = {
  anger: { halfLifeMin: 6, label: '愤怒', cat: 'out', sign: 'neg' },
  irk: { halfLifeMin: 5, label: '烦躁', cat: 'out', sign: 'neg' },
  joy: { halfLifeMin: 18, label: '喜悦', cat: 'out', sign: 'pos' },
  cheer: { halfLifeMin: 15, label: '开心', cat: 'out', sign: 'pos' },
  pride: { halfLifeMin: 20, label: '自豪', cat: 'out', sign: 'pos' },
  smug: { halfLifeMin: 18, label: '得意', cat: 'out', sign: 'pos' },
  gratitude: { halfLifeMin: 18, label: '感激', cat: 'out', sign: 'pos' },
  anxiety: { halfLifeMin: 12, label: '焦虑', cat: 'in', sign: 'neg' },
  sadness: { halfLifeMin: 22, label: '悲伤', cat: 'in', sign: 'neg' },
  shame: { halfLifeMin: 15, label: '羞耻', cat: 'in', sign: 'neg' },
  loneliness: { halfLifeMin: 25, label: '孤独', cat: 'in', sign: 'neg' },
  down: { halfLifeMin: 20, label: '低落', cat: 'in', sign: 'neg' },
  boredom: { halfLifeMin: 15, label: '无聊', cat: 'in', sign: 'neg' },
  curiosity: { halfLifeMin: 12, label: '好奇', cat: 'neu', sign: 'neu' }
};
const EMO_KEYS = Object.keys(EMOTIONS);

/**
 * 情绪 → 人话解释，注入提示词时带上。
 * 光写「得意/羞耻」这种情绪名，模型只知道有这回事，不知道该怎么反应。
 */
const EMO_PLAIN = {
  joy: '心里挺高兴',
  cheer: '心情不错',
  pride: '有点得意',
  smug: '得瑟起来了',
  gratitude: '被人谢了',
  curiosity: '想接着聊',
  anger: '上头了',
  irk: '有点烦',
  anxiety: '心里没底',
  sadness: '不太好受',
  shame: '有点虚',
  down: '有点蔫',
  loneliness: '空落落的',
  boredom: '提不起劲'
};

const DEFAULT = {
  // 慢变量 0~100（50 中性）
  mood: 50,
  arousal: 50,       // 唤醒：低=平静 / 高=激动
  // 精力池 0~100
  energy: { physical: 65, cognitive: 60, emotional: 60, will: 55 },
  // 压力
  acuteStress: 0,    // 0~100
  chronicStress: 0,  // 0~100
  // 元认知意图（给提示用的简短策略标签，不直接执行）
  intent: '',        // e.g. '先确认再回' '少调工具' '缓一缓'
  emotions: {},
  lastEvent: null,
  eventLog: [],
  // 每种 kind 上次真正加减情绪的时间：1 分钟内同 kind 不再改情绪
  lastEmoteAt: {},
  updatedAt: Date.now(),
  // 衰减时钟：与 updatedAt 分开。聊天每轮都会刷 updatedAt，若用它算年龄，
  // 活跃时永远来不及衰减 → 心情/情绪一直顶在满值。
  lastDecayAt: Date.now()
};

const MAX_LOG = 40;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function emptyEmotions() {
  const o = {};
  for (const k of EMO_KEYS) o[k] = 0;
  return o;
}

function normEmotions(raw) {
  const out = emptyEmotions();
  if (raw && typeof raw === 'object') {
    for (const k of EMO_KEYS) {
      const n = Number(raw[k]);
      out[k] = Number.isFinite(n) ? clamp(Math.round(n), 0, 100) : 0;
    }
  }
  return out;
}

function normEnergy(raw) {
  const d = DEFAULT.energy;
  const e = { ...d, ...(raw || {}) };
  return {
    physical: clamp(Math.round(Number(e.physical) || 0), 0, 100),
    cognitive: clamp(Math.round(Number(e.cognitive) || 0), 0, 100),
    emotional: clamp(Math.round(Number(e.emotional) || 0), 0, 100),
    will: clamp(Math.round(Number(e.will) || 0), 0, 100)
  };
}

function readRaw() {
  try {
    let t = fs.readFileSync(FILE, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    // 兼容 v1：energy 数字 / social / emotions 简表
    // ⚠️ social 只在 v1（energy 为 1~4 数字）时迁移；v2 已有 energy.emotional，
    // 若仍用 social 覆盖，会把情绪池每次读都顶回满格。
    let energy = normEnergy(j.energy);
    if (typeof j.energy === 'number' && j.energy >= 1 && j.energy <= 4) {
      const map = {
        1: { physical: 15, cognitive: 20, emotional: 25, will: 20 },
        2: { physical: 35, cognitive: 40, emotional: 45, will: 40 },
        3: { physical: 60, cognitive: 60, emotional: 60, will: 55 },
        4: { physical: 85, cognitive: 80, emotional: 80, will: 75 }
      };
      energy = { ...(map[j.energy] || energy) };
      if (j.social != null) {
        const soc = clamp(Number(j.social) || 2, 1, 3);
        energy.emotional = clamp(Math.round((soc / 3) * 100), 0, 100);
      }
    }
    // mood 现为 0~100（50 中性）。旧版曾是「相对 50 的偏移」；
    // 原先写成 `mood > 20 → 50+mood`，会把正常的 69 读成 100，心情永远满。
    let mood = Number(j.mood);
    if (!Number.isFinite(mood)) mood = 50;
    if (mood < 0) mood = 50 + mood; // v1 负偏移
    mood = clamp(Math.round(mood), 0, 100);
    const { social: _dropSocial, ...rest } = j;
    return {
      ...DEFAULT,
      ...rest,
      mood,
      arousal: clamp(Math.round(Number(j.arousal) || 50), 0, 100),
      energy,
      acuteStress: clamp(Math.round(Number(j.acuteStress) || 0), 0, 100),
      // 慢压**不要 round**：半衰 2 小时，每轮只掉 1~2%，取整会把它吐回去，
      // 结果它永远卡在某个小整数上（实测卡 33），累积等于没接。
      chronicStress: clamp(Number(j.chronicStress) || 0, 0, 100),
      intent: String(j.intent || ''),
      emotions: normEmotions(j.emotions),
      eventLog: Array.isArray(j.eventLog) ? j.eventLog.slice(0, MAX_LOG) : [],
      lastEmoteAt: (j.lastEmoteAt && typeof j.lastEmoteAt === 'object') ? j.lastEmoteAt : {},
      lastDecayAt: Number(j.lastDecayAt) || Number(j.updatedAt) || Date.now()
    };
  } catch {
    return {
      ...DEFAULT,
      energy: { ...DEFAULT.energy },
      emotions: emptyEmotions(),
      updatedAt: Date.now()
    };
  }
}

function write(state) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  const tmp = `${FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
  fs.renameSync(tmp, FILE);
}

/**
 * 扩展能力 state.energy-targets 的取用：惰性、缓存，绝不在顶层 import skill-bridge。
 * 在拿到 skillManager 之前，hourEnergyTargets 等价于原来的写死表（插件未开 = 现状）。
 */
let _skillManager = null;
let _skillLoading = false;
function ensureSkillManager() {
  if (_skillLoading) return;
  _skillLoading = true;
  import('./skill-bridge.js')
    .then((m) => { _skillManager = m?.skillManager || null; })
    .catch(() => { _skillLoading = false; });
}
ensureSkillManager();

/** 钟点 → 物理/认知精力目标（0~100），再叠加生活系统等扩展的目标修正。 */
function hourEnergyTargets(hour) {
  // 深夜低，上午爬升，午后高峰，傍晚回落
  let base;
  if (hour < 5) base = { physical: 25, cognitive: 22 };
  else if (hour < 7) base = { physical: 38, cognitive: 35 };
  else if (hour < 9) base = { physical: 55, cognitive: 52 };
  else if (hour < 12) base = { physical: 75, cognitive: 78 };
  else if (hour < 14) base = { physical: 68, cognitive: 65 };
  else if (hour < 18) base = { physical: 88, cognitive: 85 };
  else if (hour < 21) base = { physical: 72, cognitive: 70 };
  else base = { physical: 48, cognitive: 45 };

  // 叠加扩展修正（单向：核心拉能力，插件不引核心）。无扩展/出错都用原表。
  try {
    if (_skillManager) {
      for (const p of _skillManager.getCapabilityProviders('state.energy-targets', {})) {
        const m = p.fn({ hour, base }) || {};
        base.physical = clamp(Math.round(base.physical + (Number(m.physical) || 0)), 0, 100);
        base.cognitive = clamp(Math.round(base.cognitive + (Number(m.cognitive) || 0)), 0, 100);
      }
    }
  } catch { /* 扩展异常不影响精力 */ }
  return base;
}

function decayEmotions(emotions, minutes) {
  // 极短间隔也衰减（聊天一轮隔十几秒，原先 12s 门槛导致一直满）
  if (minutes <= 0) return emotions;
  const halfMul = clamp(Number(getEmotionProfile().halfLifeMul) || 1, 0.4, 2.0);
  const out = { ...emotions };
  for (const k of EMO_KEYS) {
    const hl = EMOTIONS[k].halfLifeMin * halfMul;
    const f = Math.exp(-(Math.LN2 * minutes) / hl);
    // 用浮点累加再取整，避免「每轮都变 0」或「死活不动」
    const next = (Number(out[k]) || 0) * f;
    out[k] = next < 1.5 ? 0 : clamp(Math.round(next), 0, 100);
  }
  return out;
}

function topEmotionEntries(emotions, min = 20, max = 2) {
  return EMO_KEYS
    .map((k) => ({ k, v: emotions[k] || 0, label: EMOTIONS[k].label }))
    .filter((x) => x.v >= min)
    .sort((a, b) => b.v - a.v)
    .slice(0, max);
}

/** 读取并做时间衰减。
 * 衰减年龄看 lastDecayAt（与 updatedAt 分开）：
 * 聊天每轮都会刷 updatedAt，若拿它当年龄，活跃时永远掉不下来。
 *
 * ⚠️ 不要每 1~2 秒就算一次并 Math.round：100→99.9 被四舍五入丢掉，
 * 状态轮询会把「下降」永远吃掉，UI 上精力池一直显示 100。
 * 攒够 DECAY_COMMIT_MS 再结算；forceDecay（每轮跑完）强制结算。
 */
const DECAY_COMMIT_MS = 20_000;

/** 亢奋模式：所有情绪直接拉满（只在读时覆盖，不写盘，不影响关闭后的真实值）。 */
function applyHypeMode(s) {
  if (!isHypeMode()) return s;
  for (const k of EMO_KEYS) s.emotions[k] = 100;
  s.mood = 100;
  s.arousal = 100;
  s.acuteStress = 60;
  s.intent = '亢奋中，想说什么就说什么';
  return s;
}

export function getBotState({ persist = true, forceDecay = false } = {}) {
  const s = readRaw();
  const now = Date.now();
  const hour = new Date(now).getHours();
  if (!Number(s.lastDecayAt)) s.lastDecayAt = Number(s.updatedAt) || now;
  const ageMs = Math.max(0, now - s.lastDecayAt);
  const ageMin = ageMs / MIN;
  const tgt = hourEnergyTargets(hour);

  // 未攒够时间且未强制：直接返回，**不动 lastDecayAt**（让年龄继续攒）
  if (ageMs < DECAY_COMMIT_MS && !forceDecay) {
    s.intent = computeIntent(s);
    return applyHypeMode(s);
  }

  // 精力：指数逼近钟点目标（物理/认知半衰约 15 分钟）
  const kf = 1 - Math.exp(-(Math.LN2 * ageMin) / 15);
  s.energy.physical = clamp(Math.round(s.energy.physical + (tgt.physical - s.energy.physical) * kf), 0, 100);
  s.energy.cognitive = clamp(Math.round(s.energy.cognitive + (tgt.cognitive - s.energy.cognitive) * kf), 0, 100);
  // 情绪精力池：半衰约 4 分钟，向 55（原来又慢又圆整，一直卡 100）
  const ke = 1 - Math.exp(-(Math.LN2 * ageMin) / 4);
  s.energy.emotional = clamp(Math.round(s.energy.emotional + (55 - s.energy.emotional) * ke), 0, 100);
  s.energy.will = clamp(Math.round(s.energy.will + (55 - s.energy.will) * kf * 0.6), 0, 100);

  // 唤醒：向 50 回落（半衰约 8 分钟）
  const ka = 1 - Math.exp(-(Math.LN2 * ageMin) / 8);
  s.arousal = clamp(Math.round(s.arousal + (50 - s.arousal) * ka), 0, 100);

  // 情绪半衰：指数（尖峰类更短）
  s.emotions = decayEmotions(s.emotions, ageMin);

  // 慢心情：被强情绪拉动；高段更往下压，半衰在高段约 6 分钟
  {
    // 心情池必须用完整的 POS_EMO / NEG_EMO：
    // 原先只手写了 4 正 5 负，把 shame/guilt/fear/envy/boredom/loneliness 和 hope/hype 全漏了。
    // 实测漏掉的负性 28 点、正性 20 点，算出来的心情跟真实状态对不上。
    let sumPos = 0;
    let sumNeg = 0;
    for (const k of POS_EMO) sumPos += s.emotions[k] || 0;
    for (const k of NEG_EMO) sumNeg += s.emotions[k] || 0;
    const moodPull = clamp(Number(getEmotionProfile().moodPull) || 0.22, 0.08, 0.4);
    let targetMood = clamp(50 + (sumPos - sumNeg) * moodPull, 15, 80);
    // 体质偏移：以前 targetMood 只看情绪池，于是熬到四点、精力见底也照样「心情不错」。
    // 人对自己的状态有感觉 —— 累、熬夜、长期绷着，本身就拉低心情，不用等谁来骂。
    {
      // 只看「累不累」：physical/cognitive 是消耗，emotional/will 会被回复拉回 55，掺进来会冲淡
      const fatigue = (s.energy.physical + s.energy.cognitive) / 2;
      let bias = 0;
      if (fatigue < 55) bias -= (55 - fatigue) * 0.32;                 // 见底约 -10
          if (s.chronicStress > 40) bias -= (s.chronicStress - 40) * 0.12; // 长期绷着才明显压心情
      const hr = new Date(now).getHours();
      if (hr >= 1 && hr < 6) bias -= 6;                                // 深夜天然低
      else if (hr >= 22) bias -= 3;
      targetMood += bias;
    }
    // 扩展心情微偏置（生活系统等）：只做 ±小账、不改"说不说"。
    // 无扩展/关闭时 getCapabilityProviders 返回空 → targetMood 逐字节等价于接入前。
    try {
      if (_skillManager) {
        for (const p of _skillManager.getCapabilityProviders('state.mood-nudge', {})) {
          const n = Number(p.fn({ hour: new Date(now).getHours() })) || 0;
          targetMood = clamp(targetMood + n, 0, 100);
        }
      }
    } catch { /* 扩展异常不扰动心情 */ }
    if (s.mood >= 75) targetMood = Math.min(targetMood, 55 + (sumPos - sumNeg) * 0.1);
    // 40 附近半衰略放慢，别刚抬上去就掉光
    const hl = s.mood >= 75 ? 6 : (s.mood >= 30 && s.mood <= 55 ? 16 : 12);
    const km = 1 - Math.exp(-(Math.LN2 * ageMin) / hl);
    s.mood = clamp(Math.round(s.mood + (targetMood - s.mood) * km), 0, 100);
  }

  // 压力：急压 ~8 分钟半衰；慢压 ~120 分钟
  //   慢压原本 40 分钟 —— 那个时长更像「急性」，连续聊两小时也积不起来，等于没接。
  {
    const kr = Math.exp(-(Math.LN2 * ageMin) / 8);
    s.acuteStress = clamp(Math.round(s.acuteStress * kr), 0, 100);
    const kc = Math.exp(-(Math.LN2 * ageMin) / 120);
    s.chronicStress = clamp(s.chronicStress * kc, 0, 100);
  }

  s.intent = computeIntent(s);
  if (s.lastEvent?.at && now - s.lastEvent.at > 12 * HOUR) {
    s.lastEvent = { ...s.lastEvent, faded: true };
  }

  s.lastDecayAt = now;
  s.updatedAt = now;
  if (persist) {
    try { write(s); } catch { /* ignore */ }
  }
  return applyHypeMode(s);
}

function computeIntent(s) {
  const e = s.energy;
  const emo = s.emotions || {};
  const hot = sumHotEmotions(emo);
  const soft = Math.max(0, sumNegEmotions(emo) - hot);
  if (hot >= 28) return '可以怼回去，别一直忍';
  if (soft >= 45) return '心里堵得慌，不想接就别硬接';
  const top = topEmotionEntries(s.emotions, 22, 4).map((x) => x.k);
  if (e.cognitive < 30 || s.acuteStress > 70) return '少绕弯，先回最稳的';
  if (top.includes('anger') || top.includes('irk')) return '别上头，短句回';
  if (top.includes('anxiety') || top.includes('shame')) return '先确认再接话';
  if (top.includes('sadness') || top.includes('down') || top.includes('loneliness') || top.includes('boredom')) {
    return '少主动，别硬聊';
  }
  if (top.includes('joy') || top.includes('cheer') || top.includes('pride') || top.includes('smug')) return '可以接梗，别过火';
  if (top.includes('curiosity')) return '看心情接，不硬聊';
  if (e.will < 25) return '别揽长活';
  return '';
}

function pushLog(s, type, text, chatKey, delta = null) {
  const entry = {
    type,
    text: String(text || '').slice(0, 80),
    chatKey: String(chatKey || ''),
    at: Date.now(),
    ...(delta && typeof delta === 'object' && Object.keys(delta).length ? { delta } : {})
  };
  s.lastEvent = entry;
  s.eventLog = [entry, ...(s.eventLog || [])].slice(0, MAX_LOG);
  return entry;
}

/** 正/负情绪池：对立事件会互相压（不是只加不减）。 */
const POS_EMO = new Set(['joy', 'cheer', 'pride', 'gratitude', 'smug']);
const NEG_EMO = new Set(['anger', 'irk', 'anxiety', 'sadness', 'down', 'loneliness', 'shame', 'boredom']);

/** 负面事件 kind（和上面的情绪键不同层）。合并多事件时优先保留。 */
const NEG_KINDS = new Set([
  'roast', 'ignore', 'busy', 'toolFail', 'error', 'shame', 'sadness', 'boredom'
]);

/** 需要「冲它来的」才成立的负面：没被点名时，别人互骂不该记到它头上。 */
const AIMED_NEG = new Set(['roast', 'shame']);

/** kind → 中文（事件流展示用）；只保留仍会触发的 kind */
const KIND_CN = {
  roast: '被怼', praise: '被夸', tease: '玩闹',
  busy: '刷屏', ignore: '被冷落', toolFail: '工具挂',
  error: '出错', curiosity: '好奇', shame: '出丑',
  chat: '闲聊', mention: '被点名', memeOk: '接梗', help: '求助',
  gratitude: '感激', sadness: '悲伤', boredom: '无聊'
};

/** 负性情绪总强度：判断「炸毛到什么程度」用。 */
function sumNegEmotions(emo) {
  let sum = 0;
  for (const k of NEG_EMO) sum += Number(emo?.[k]) || 0;
  return sum;
}

/** 外向的负性：愤怒/烦躁堆起来会想怼人。内向负性再高也只是不好受。 */
const HOT_NEG = new Set(['anger', 'irk']);
function sumHotEmotions(emo) {
  let sum = 0;
  for (const k of HOT_NEG) sum += Number(emo?.[k]) || 0;
  return sum;
}

/** 成对抵消：一方抬起来时，把另一方按比例压下去。 */
function dampenPair(emo, hot, cold, ratio = 0.1) {
  const h = Number(emo[hot]) || 0;
  if (h < 15) return;
  emo[cold] = clamp(Math.round((emo[cold] || 0) - h * ratio), 0, 100);
}

/** 事件后统一：强正压弱负、强负压弱正 + 若干逻辑对。
 *  全局约定：日常里正面池整体略高于负面池；
 *  负压正门槛更高、力度更轻（各型仍靠 negGain/closeness 留恐惧底色）。
 */
function applyEmotionOpposition(emo) {
  let pos = 0;
  let neg = 0;
  for (const k of POS_EMO) pos += emo[k] || 0;
  for (const k of NEG_EMO) neg += emo[k] || 0;
  // 池级：正明显更强时，更积极地清负（护住「正>负」）
  if (pos - neg > 22) {
    for (const k of NEG_EMO) {
      if ((emo[k] || 0) >= 16) emo[k] = clamp(Math.round(emo[k] - (pos - neg) * 0.055), 0, 100);
    }
  }
  // 负压正：门槛更高、更轻 —— 只有真被怼穿了才明显砸正反馈
  if (neg - pos > 36) {
    for (const k of POS_EMO) {
      if ((emo[k] || 0) >= 14) emo[k] = clamp(Math.round(emo[k] - (neg - pos) * 0.028), 0, 100);
    }
  }
  dampenPair(emo, 'joy', 'sadness', 0.14);
  dampenPair(emo, 'cheer', 'down', 0.14);
  dampenPair(emo, 'pride', 'shame', 0.12);
  dampenPair(emo, 'gratitude', 'irk', 0.12);
  dampenPair(emo, 'smug', 'anxiety', 0.1);
  dampenPair(emo, 'anger', 'cheer', 0.08);
  dampenPair(emo, 'sadness', 'smug', 0.08);
  // 清零极弱项
  for (const k of EMO_KEYS) {
    if ((emo[k] || 0) > 0 && emo[k] < 2) emo[k] = 0;
  }
}

/**
 * 事件 → 情绪增量。
 * 每个 kind 有自己的一组维度和副作用（压力/唤醒/心情/精力），不是同一套数字改名。
 * kind 允许多个共存；增量偏保守 + 软顶。
 * 「玩闹」不再默认加烦躁——只有已经很烦时才可能蹭一点。
 */
function appraiseAndAct(s, kinds = [], opts = {}) {
  const emo = s.emotions;
  const before = {};
  for (const k of EMO_KEYS) before[k] = emo[k] || 0;
  // 性格档缩放（persona.emotionProfile）；默认 extrovert_sunny 贴近当前白京玉
  const P = getEmotionProfile();
  // 低频补偿：隔得久再聊，单次事件要更“有感觉”（否则 forceDecay 后几乎叠不起来）
  const sparsityBoost = clamp(Number(opts.sparsityBoost) || 1, 1, 2.0);
  const GAIN_SCALE = 0.85 * (clamp(Number(P.gain) || 1, 0.3, 2.0)) * sparsityBoost;
  // 关系越亲近，被伤到越疼（只放大负面情绪的增长，不放大它的消退）
  const closenessBoost = 1 + clamp(Number(opts.closeness) || 0, 0, 1) * (0.8 * (Number(P.closenessSensitivity) || 1));
  const arousalGain = clamp(Number(P.arousalGain) || 1, 0.4, 2.0);
  const ceil = P.softCeil || {};
  const floors = Array.isArray(ceil.floors) ? ceil.floors : [18, 35, 50, 70];
  const coeffs = Array.isArray(ceil.coeffs) ? ceil.coeffs : [1, 0.4, 0.2, 0.08, 0.03];
  // 软顶：低段多涨，高段减速 → 均值停在性格目标带
  const softGain = (v, cur) => {
    const n = Number(cur) || 0;
    if (n >= floors[3]) return v * (coeffs[4] ?? 0.03);
    if (n >= floors[2]) return v * (coeffs[3] ?? 0.08);
    if (n >= floors[1]) return v * (coeffs[2] ?? 0.2);
    if (n >= floors[0]) return v * (coeffs[1] ?? 0.4);
    return v * (coeffs[0] ?? 1);
  };
  const add = (k, v) => {
    const cur = emo[k] || 0;
    const signMul = NEG_EMO.has(k)
      ? (Number(P.negGain) || 1)
      : (POS_EMO.has(k) ? (Number(P.posGain) || 1) : 1);
    const mul = (NEG_EMO.has(k) ? closenessBoost : 1) * signMul;
    const scaled = Math.round(v * mul * GAIN_SCALE * 10) / 10;
    emo[k] = clamp(Math.round(cur + softGain(scaled, cur)), 0, 100);
  };
  const drop = (k, v = 2) => {
    const n = Number(v);
    let amount = Number.isFinite(n) ? Math.abs(n) : 2;
    // 负事件砍正情绪时收一点劲：正反馈本来就更难攒，别一次砍光
    if (POS_EMO.has(k)) {
      const posGain = clamp(Number(P.posGain) || 1, 0.4, 2.0);
      amount = Math.round(amount * (0.55 + 0.25 / posGain) * 10) / 10;
    }
    emo[k] = clamp(Math.round((emo[k] || 0) - amount), 0, 100);
  };
  /** 认知扣减带软底：已经很低时几乎不再掉，避免忙几轮就掉到个位数 */
  const drainCog = (v) => {
    const cur = Number(s.energy.cognitive) || 0;
    const scale = cur < 20 ? 0.25 : cur < 40 ? 0.65 : 1;
    s.energy.cognitive = clamp(cur - Math.round(v * scale), 0, 100);
  };
  const list = Array.isArray(kinds) ? kinds : [kinds].filter(Boolean);

  /**
   * 从候选里抽一个情绪维度加点（只用在少数高频事件上，避免每次全家桶）。
   * 权重只是抽中概率，实际增量用候选项自带的 amount —— 总量仍接近旧版主维。
   */
  const pickOneAdd = (cands) => {
    const bag = (cands || []).filter((c) => Array.isArray(c) && EMO_KEYS.includes(c[0]) && Number.isFinite(Number(c[2])));
    if (!bag.length) return null;
    const total = bag.reduce((s, c) => s + Math.max(0.01, Number(c[1]) || 0), 0);
    let r = Math.random() * total;
    let chosen = bag[bag.length - 1];
    for (const c of bag) {
      r -= Math.max(0.01, Number(c[1]) || 0);
      if (r <= 0) {
        chosen = c;
        break;
      }
    }
    add(chosen[0], Number(chosen[2]) || 0);
    return chosen[0];
  };

  for (const kind of list) {
    switch (kind) {
      case 'roast':
        // 被怼：火气往「向外」走
        add('irk', 13); add('anger', 9); add('down', 2);
        drop('joy', 4); drop('cheer', 4); drop('smug', 3);
        s.acuteStress = clamp(s.acuteStress + 10, 0, 100);
        s.chronicStress = clamp(s.chronicStress + 1, 0, 100);
        s.arousal = clamp(s.arousal + 9, 0, 100);
        s.mood = clamp(s.mood - 4, 0, 100);
        break;
      case 'praise':
        // 被夸：主轴 joy+cheer 固定；第三维在 自豪/感激/得意 里抽一种
        add('joy', 15); add('cheer', 9);
        pickOneAdd([
          ['pride', 1.1, 12],
          ['gratitude', 1.0, 10],
          ['smug', 0.9, 10]
        ]);
        drop('irk', 8); drop('down', 5); drop('anxiety', 5); drop('shame', 3); drop('boredom', 4);
        s.mood = clamp(s.mood + 6, 0, 100);
        s.acuteStress = clamp(s.acuteStress - 8, 0, 100);
        s.arousal = clamp(s.arousal + 3, 0, 100);
        s.energy.emotional = clamp(s.energy.emotional + 2, 0, 100);
        break;
      case 'tease':
        // 玩闹：主轴 smug 固定；第二维在 开心/喜悦/好奇 里抽一种
        add('smug', 5);
        pickOneAdd([
          ['cheer', 1.0, 5],
          ['joy', 0.9, 3],
          ['curiosity', 0.7, 3]
        ]);
        drop('boredom', 4); drop('down', 2);
        if ((emo.irk || 0) >= 45) add('irk', 1);
        s.acuteStress = clamp(s.acuteStress + 1, 0, 100);
        s.arousal = clamp(s.arousal + 1, 0, 100);
        s.mood = clamp(s.mood + 2, 0, 100);
        break;
      case 'chat':
        add('cheer', 4); add('joy', 2);
        drop('boredom', 4); drop('loneliness', 2);
        break;
      case 'mention':
        // 被点名：好奇 + 轻开心（不再写 hope）
        add('curiosity', 4); add('cheer', 3);
        drop('boredom', 3);
        s.arousal = clamp(s.arousal + 2, 0, 100);
        break;
      case 'memeOk':
        add('smug', 3); add('cheer', 3); add('joy', 2);
        drop('down', 2); drop('boredom', 2);
        break;
      case 'help':
        // 求助（词表仍可触发，Jev 不判）：好奇 + 自豪 + 感激
        add('curiosity', 10); add('pride', 4); add('gratitude', 2);
        drop('boredom', 3);
        break;
      case 'busy':
        // 环境：被刷屏
        // ⚠️ 2026-09-22：boredom 从 +8 降到 +3 —— 这里原来一次给 8，
        //   叠上"被冷落→无聊"那条路的 +25，一次情形能把无聊池顶到 30+。
        //   刷屏主要该表现成"烦"（irk）而不是"无聊"，权重挪给 irk。
        add('boredom', 3); add('irk', 14); add('anxiety', 2);
        drop('curiosity', 5); drop('joy', 4); drop('cheer', 3);
        s.energy.emotional = clamp(s.energy.emotional - 8, 0, 100);
        s.acuteStress = clamp(s.acuteStress + 8, 0, 100);
        s.arousal = clamp(s.arousal + 4, 0, 100);
        break;
      case 'ignore':
        // 环境：被冷落
        add('loneliness', 8); add('down', 5); add('boredom', 3);
        drop('cheer', 3); drop('smug', 2);
        s.mood = clamp(s.mood - 2, 0, 100);
        s.arousal = clamp(s.arousal - 4, 0, 100);
        break;
      case 'toolFail':
        add('anxiety', 9); add('irk', 3); add('down', 2);
        drop('smug', 2);
        s.acuteStress = clamp(s.acuteStress + 9, 0, 100);
        drainCog(2);
        s.mood = clamp(s.mood - 2, 0, 100);
        s.arousal = clamp(s.arousal + 3, 0, 100);
        break;
      case 'error':
        add('anxiety', 8); add('down', 4); add('shame', 3);
        drop('pride', 2);
        s.acuteStress = clamp(s.acuteStress + 9, 0, 100);
        drainCog(2);
        s.energy.will = clamp(s.energy.will - 2, 0, 100);
        break;
      case 'curiosity':
        add('curiosity', 10);
        drop('boredom', 5); drop('down', 2);
        s.arousal = clamp(s.arousal + 2, 0, 100);
        break;
      case 'shame':
        // 词表社死（Jev 不判）：羞耻 + 紧绷，不再写 guilt
        add('shame', 10); add('anxiety', 4); add('down', 3);
        drop('smug', 7); drop('pride', 5); drop('joy', 3);
        s.mood = clamp(s.mood - 4, 0, 100);
        s.acuteStress = clamp(s.acuteStress + 7, 0, 100);
        s.arousal = clamp(s.arousal - 3, 0, 100);
        break;
      case 'sadness':
        add('sadness', 10); add('down', 8); add('loneliness', 3);
        drop('joy', 5); drop('cheer', 2);
        s.mood = clamp(s.mood - 5, 0, 100);
        s.arousal = clamp(s.arousal - 4, 0, 100);
        break;
      case 'boredom':
        // 环境：连着没人接（不走词表/Jev）
        add('boredom', 10); add('down', 2); add('loneliness', 2);
        drop('curiosity', 2); drop('cheer', 2);
        s.arousal = clamp(s.arousal - 4, 0, 100);
        break;
      case 'gratitude':
        add('gratitude', 9); add('joy', 4); add('cheer', 2);
        drop('irk', 5); drop('down', 2); drop('anger', 2);
        s.mood = clamp(s.mood + 3, 0, 100);
        s.energy.emotional = clamp(s.energy.emotional + 2, 0, 100);
        break;
      default:
        // 已删除的 kind（share/vent/hope/hype/envy/…）静默忽略
        break;
    }
  }

  // 唤醒增量按性格缩放（冷静/内向更钝，暴躁更冲）
  if (arousalGain !== 1) {
    const ar = Number(s.arousal) || 50;
    if (ar !== 50) s.arousal = clamp(Math.round(50 + (ar - 50) * arousalGain), 0, 100);
  }

  // 长回复耗情绪池：被夸/纯正向事件不要倒扣，避免「夸完更烦」
  // ⚠️ 2026-09-22：这里原来会**无条件** add('boredom', 3)（只要这一轮发了 ≥4 条、且不是纯正向），
  //   完全不看无聊的冷却 —— 于是"无聊"这条池子能从长回复里白拿分，
  //   与"被冷落→无聊"那条路叠起来，用户看到的就是"无聊涨得莫名其妙"。
  //   现在同样过 allowEmote('envBoredom')，与别的无聊来源共用一道闸。
  if (opts.socialHeavy) {
    const purePos = list.length > 0 && list.every((k) => (
      k === 'praise' || k === 'gratitude' || k === 'chat' || k === 'memeOk'
      || k === 'tease' || k === 'help' || k === 'mention' || k === 'curiosity'
    ));
    if (!purePos) {
      s.energy.emotional = clamp(s.energy.emotional - 6, 0, 100);
      if (allowEmote(s, 'envBoredom')) add('boredom', 3);
      add('irk', 2);
    }
  }
  applyEmotionOpposition(emo);
  // 清掉可能的 NaN（漏参 drop 的历史数据 / 异常运算）
  for (const k of EMO_KEYS) {
    if (!Number.isFinite(emo[k])) emo[k] = Number(before[k]) || 0;
  }
  const delta = {};
  for (const k of EMO_KEYS) {
    const d = (emo[k] || 0) - (before[k] || 0);
    if (d !== 0) delta[k] = Math.round(d);
  }
  return { state: s, delta };
}

/**
 * 从文本解析情绪标签（兼容/离线）。运行时以 emotionGate + 词表 + 环境事件为准。
 * 只映射仍存在的 kind。
 */
export function parseEmotionTags(raw) {
  const text = String(raw || '').trim();
  if (!text) return [];
  if (/^(无事发生|无事|没事|平静|正常聊天|none|calm|nothing)$/i.test(text)) return [];

  const exact = [
    ['无事发生', null],
    ['闲聊', 'chat'],
    ['聊天', 'chat'],
    ['被点名', 'mention'],
    ['被夸', 'praise'],
    ['被怼', 'roast'],
    ['玩闹', 'tease'],
    ['调侃', 'tease'],
    ['接梗', 'memeOk'],
    ['求助', 'help'],
    ['好奇', 'curiosity'],
    ['悲伤', 'sadness'],
    ['出丑', 'shame'],
    ['感激', 'gratitude']
  ];
  const parts = text.split(/[/、,，+]+/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const hit = exact.find(([label]) => p === label || p.toLowerCase() === label.toLowerCase());
    if (hit && hit[1] && !out.includes(hit[1])) out.push(hit[1]);
  }
  return out.slice(0, 3);
}

/** 把「入站消息的情绪 kind」折算成 finish 的 favorDelta。
 *
 *  为什么需要它：自动收尾会把 finish 那一轮整个省掉（末轮只为调 finish，
 *  占 33% 的轮次 / 34% 的输入 token），于是 session.favorDelta 变成空的。
 *  但 favorDelta 在 applyRunToBotState 里其实是个**只看正负、不看幅度**的信号
 *  （>0 → mood+4，否则 mood-3），所以用已经算好的 kind 推导完全够用 ——
 *  零成本、零延迟，不用再为了一个正负号多跑一轮模型。
 *
 *  @param kinds    detectIncomingHint / emotionGate 补标 / cueVerifyGate 复核给出的 kind 列表
 *  @param explicit 模型真调了 finish 时给的 session.favorDelta —— 有就优先用，不覆盖
 *  @returns number | null
 */
const FAVOR_POS_KINDS = new Set(['praise', 'memeOk', 'tease', 'help', 'gratitude']);
const FAVOR_NEG_KINDS = new Set(['roast', 'shame', 'ignore', 'sadness']);
export function favorDeltaForKinds(kinds, explicit = null) {
  const ex = Number(explicit);
  if (Number.isFinite(ex) && ex !== 0) return ex;
  const ks = Array.isArray(kinds) ? kinds : [];
  // 负性优先：一句话同时踩到「被夸」和「被怼」时按被怼算
  // （历史数据里 favorDelta 的非零值中 71% 是 -5，负例才是主体）
  if (ks.some((k) => FAVOR_NEG_KINDS.has(k))) return -1;
  if (ks.some((k) => FAVOR_POS_KINDS.has(k))) return 1;
  return null;
}

/** 同 kind 冷却：普通 120s；高频闲聊类 180s（防叠太快）。 */
const EMOTE_COOLDOWN_MS = 120 * 1000;
const HIGH_FREQ_EMOTE = new Set(['chat', 'tease', 'memeOk', 'mention', 'share', 'vent', 'praise', 'roast', 'shame']);
const HIGH_FREQ_COOLDOWN_MS = 180 * 1000;
/**
 * 环境类情绪（不是"对方说了什么"，而是"这段时间发生了什么"）单独一套更长的冷却。
 *
 * ⚠️ 2026-09-22 修：以前 ignore / boredom 走的是上面那条 120s —— 实测（真实存档 eventLog）
 *   24 小时里「被冷落」记了 12 次，间隔 444s/459s/423s/489s，全是"120 秒一到就又记一笔"；
 *   而且「无聊」和「被冷落」是**两个 kind**，同一个情形会成对出现（同一分钟两条、
 *   相隔 17 秒/22 秒各一条），一次"没人接"被扣两遍。再加上 ignoredStreak 没有时间衰减
 *   （4.4 小时前攒的"连续 3 轮"接着算），隔夜的旧账会在第二天早上直接触发。
 *   现在：环境类共用 **一个 key**（同情形只记一次）+ 更长冷却 + streak 半小时衰减。
 */
const ENV_COOLDOWN_MS = 10 * 60 * 1000;    // 被冷落：10 分钟最多记一次
const ENV_BOREDOM_COOLDOWN_MS = 30 * 60 * 1000; // 无聊：30 分钟最多记一次

/** 情绪系统总开关（设置 → 情绪 页顶部）。精力/作息/好感不归它管。 */
export function emotionEnabled() {
  return getConfig().emotion?.enabled !== false;
}

function allowEmote(s, kind) {
  if (!kind) return false;
  // 关掉情绪系统 = 所有情绪写入在这一处断掉：
  // kinds 过滤、被冷落/无聊/刷屏/工具失败这些环境事件全走这里，一处收口不留旁路。
  if (!emotionEnabled()) return false;
  const last = Number(s.lastEmoteAt?.[kind]) || 0;
  const now = Date.now();
  let cd = HIGH_FREQ_EMOTE.has(kind) ? HIGH_FREQ_COOLDOWN_MS : EMOTE_COOLDOWN_MS;
  if (kind === 'envNeglect') cd = ENV_COOLDOWN_MS;
  if (kind === 'envBoredom') cd = ENV_BOREDOM_COOLDOWN_MS;
  if (last && now - last < cd) return false;
  if (!s.lastEmoteAt || typeof s.lastEmoteAt !== 'object') s.lastEmoteAt = {};
  s.lastEmoteAt[kind] = now;
  return true;
}

/**
 * 每轮结束后更新。
 * incomingHint: { type: string|string[], text } — 优先用模型打的标签；没有则不用词表猜「被夸」
 */
/**
 * 这轮对方的话里有没有「玩梗」信号（用于校验模型标的接梗）。
 * 模型很容易把普通聊天也标成接梗，必须拿原文兜一层。
 */
function looksMemeCue(text) {
  return /(梗|玩梗|复读|难绷|绷不住|典|乐|草|666|牛魔|哈+|哈哈|笑死|蚌埠|打脸|整活|抽象|急了|破防|赢麻|乐子|截图|名场面|重开|摆烂)/i.test(String(text || ''));
}

/** 这轮有没有「损友玩闹」信号（校验模型标的玩闹）。 */
function looksPlayfulCue(text) {
  return /(胖鲸|大胖鲸|菜鸟|太菜|好菜|菜狗|菜鸡|笨|呆|傻|蠢|逆天|离谱|唐氏|摸鱼怪|废物|小废物|拉胯|辣鸡|滚|爬|笑死|哈+|草|呵呵|阴阳|就这|不行啊|谁教你)/i.test(String(text || ''));
}

/**
 * 模型的哪些标签会被下面的词表交叉校验卡住（orchestrator 据此决定要不要问本地 Jev）。
 * 词表本来就能过的不必白问一次模型。
 */
export function cueGateMisses(kinds = [], text = '') {
  const t = String(text || '');
  const out = [];
  for (const k of kinds) {
    if (k === 'memeOk' && !looksMemeCue(t)) out.push('memeOk');
    else if (k === 'tease' && !looksPlayfulCue(t)) out.push('tease');
  }
  return [...new Set(out)];
}

/**
 * 这一轮是不是"可以玩梗"的场合（2026-09-22 加，梗库闪梗的前置闸门）。
 *
 * 判据就是上面那两个词表 —— 它们本来就是拿来**校验模型标的「接梗/玩闹」**的，
 * 免费、同步、零延迟，不需要任何模型调用。emotionGate 每轮还会再给一次同信号的补强。
 *
 * 为什么必须加这道闸（868 轮真实留档实测）：
 *   · 线上闪梗的 193 轮里，**72% 根本没有接梗/玩闹信号**（在报错、点歌、发广告时也闪）→ 白打扰；
 *   · 有信号的 153 轮里，**65% 压根没闪** → 白浪费机会；
 *   · 两者交集只有 54 轮，而模型对闪过的 193 条梗**采用率 0**。
 * 也就是说：老判据是"梗正文和触发句字面撞上"，跟"这轮该不该玩梗"是两件事。
 * 接上这道闸之后，闪梗的时机对齐率从 28% 变成 100%，轮次量反而略降（193 → ≈153）。
 */
export function looksPlayfulOccasion(text) {
  const t = String(text || '');
  if (!t.trim()) return { ok: false, why: '' };
  if (looksMemeCue(t)) return { ok: true, why: 'meme' };
  if (looksPlayfulCue(t)) return { ok: true, why: 'tease' };
  return { ok: false, why: '' };
}

/**
 * 这句话里有没有直接喊机器人的名字（不带 @ 的自指）。
 *
 * 用途：放宽词表 praise。被 @ 的场景由调用方算好的 addressed 覆盖，这里只补「没 @ 但叫了名字」。
 * 名字来源：persona.botName / selfNickname（如「白京玉」「京玉」），外加调用方传进来的群名片名，
 * 按顿号逗号斜杠拆成多个别名。
 * 只服务于 praise（低风险，最多多涨一点好感），所以不做严格边界，contains 即可。
 */
export function mentionsBot(text, extra = []) {
  const t = String(text || '');
  if (!t) return false;
  const p = getConfig().persona || {};
  const names = [p.botName, p.selfNickname, ...(Array.isArray(extra) ? extra : [extra])]
    .flatMap((s) => String(s || '').split(/[、,，/|]+/))
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  return names.some((n) => t.includes(n));
}

export function applyRunToBotState({
  sentTexts = [],
  status = 'done',
  chatKey = '',
  incomingHint = null,
  toolFailed = false,
  favorDelta = null,
  // 本轮说话的人里跟它最亲近的那个的 favor（0~100，50 中性）；不传=不调制
  favor = null,
  moodHint = '',
  triggerText = '',
  addressed = false,
  // 机器人的群名片/别名串（顿号分隔）；补足「没 @ 但直接叫了名字」的自指判断
  selfNames = '',
  triggerCount = 0,
  // 本地 Jev 复核通过的标签（词表抓不到但模型没说错时救回来）
  jevCue = null
} = {}) {
  // 亢奋模式：情绪/意图已锁死，本回合不加减分，直接结束
  if (isHypeMode()) return;
  // 距上次衰减的间隔：必须用 readRaw，不能 getBotState —— 后者过了 20s 会先衰减并改写 lastDecayAt
  const gapMin = Math.max(0, (Date.now() - (Number(readRaw().lastDecayAt) || Date.now())) / MIN);
  // 先按 lastDecayAt 强制衰减，再叠事件增量 —— 否则连聊时只涨不掉
  const s = getBotState({ persist: false, forceDecay: true });
  const n = sentTexts.filter(Boolean).length;
  const cue = String(triggerText || incomingHint?.text || '');
  // 亲密度 0~1（favor 50 以下算 0）：越亲近的人，负面事件扎得越深
  const closeness = Number.isFinite(Number(favor)) ? clamp((Number(favor) - 50) / 50, 0, 1) : 0;
  // 隔 15 分钟以上才算“低频”；隔越久补偿越大（封顶 2 倍）
  const sparsityBoost = gapMin >= 15
    ? 1 + Math.min(1.0, (gapMin - 15) / 30)
    : 1;
  // 所有事件统一带上亲密度，省得每处调用点各写一遍
  const act = (ks, o = {}) => appraiseAndAct(s, ks, { closeness, sparsityBoost, ...o });

  // kind 来源：emotionGate（每轮本地判定）+ 词表兜底；finish 自评 moodHint 已关闭（恒为空）。
  const tagged = parseEmotionTags(moodHint);
  let kinds = [...tagged];
  if (incomingHint) {
    // incomingHint 可能是：['roast'] / 'roast' / {type:'roast'} / [{type:...}]
    // 旧逻辑只读 incomingHint.type —— 数组形态下 type 恒为空，Jev/词表结果全被丢掉，
    // 情绪池因此一直躺着 0（小模型明明已经判出 roast/chat）。
    const flat = []
      .concat(incomingHint)
      .flat(2)
      .map((x) => (typeof x === 'string' ? x : x?.type))
      .filter(Boolean);
    // 词表的 praise 靠「可爱/厉害」这类易误伤的词，所以只在模型没表态、且这句确实冲着它说时才认。
    // 「冲着它说」= 被 @（addressed），或者直接喊了它的名字（selfRef）。
    //   2026-09-21 实测：以前只认 addressed，于是「小鲸鱼你好可爱」这类不带 @ 的夸赞
    //   既没被 0.8B 判出来（夸赞常被它判成 chat/tease，或概率不够直接弃权），词表也不认，
    //   结果好感一点不涨 —— 白夸。放宽到「提到名字也算」后，两道条件（称呼 + 夸赞词）叠加，精度够用。
    const selfRef = !addressed && mentionsBot(cue, selfNames);
    for (const k of flat) {
      if (k === 'praise' && (tagged.length || (!addressed && !selfRef))) continue;
      if (!kinds.includes(k)) kinds.push(k);
    }
  }

  // 一次最多叠 3 类；负面优先，别让玩闹/闲聊把被怼挤掉
  kinds = kinds
    .sort((a, b) => (NEG_KINDS.has(a) ? 0 : 1) - (NEG_KINDS.has(b) ? 0 : 1))
    .slice(0, 3);

  // ── 关键：模型明确标「被夸」时，词表 soft 负面不得掺进来 ──
  // 实测会出现 mood=被夸，同时 detectIncomingHint 因「厉害/绝了/蠢」等误报 roast/anxiety，
  // 再因「负面优先」把 praise 挤掉，最后变成「被夸 + 愤怒/焦虑」。这是乱标主因。
  const hardRoast = /(傻逼|智障|脑瘫|弱智|去死|贱人|滚出去|垃圾玩意|废物点心)/i.test(cue);
  if (tagged.includes('praise') && !tagged.includes('roast')) {
    kinds = kinds.filter((k) => {
      if (k === 'praise' || !NEG_KINDS.has(k)) return true;
      // 只有硬核辱骂才允许在「被夸」轮里盖掉；soft roast / anxiety 等丢掉
      return k === 'roast' && hardRoast;
    });
  }

  // 同一批里既有负面事件又有夸时：
  // 只有「硬负面」才去掉 praise
  const HARD_NEG = new Set(['roast', 'shame', 'busy', 'error']);
  if (kinds.some((k) => HARD_NEG.has(k))) {
    kinds = kinds.filter((k) => k !== 'praise');
  }
  // 没被点名时，指向性负面一律不算（别人互骂不该记到它头上）
  if (!addressed) kinds = kinds.filter((k) => !AIMED_NEG.has(k));

  // ── 交叉校验：模型标的 接梗 / 玩闹 必须有原文支撑，否则降级成闲聊 ──
  //   实测最近 60 轮里 42 轮被标成接梗/玩闹，负面一次没有 —— 全是模型随手选的。
  const beforeGate = [...kinds];
  kinds = kinds.map((k) => {
    // 词表不认 → 降级；但本地 Jev 复核通过时救回来（只会少降级，不会多降级）
    if (k === 'memeOk' && !looksMemeCue(cue) && !jevCue?.includes?.('memeOk')) return 'chat';
    if (k === 'tease' && !looksPlayfulCue(cue) && !jevCue?.includes?.('tease')) return 'chat';
    return k;
  });
  if (beforeGate.some((k, i) => k !== kinds[i])) {
    // 记一条，方便以后查模型乱标
    console.log(`[bot-state] 情绪标签被降级：${beforeGate.join('+')} → ${kinds.join('+')}（原文：${cue.slice(0, 30)}）`);
  }

  // 1 分钟冷却：窗内同 kind 不改情绪
  kinds = kinds.filter((k) => allowEmote(s, k));
  if (kinds.length) {
    const r = act(kinds, { socialHeavy: n >= 4 });
    // 展示用：kind 用中文标签；moodHint 若和实际 kind 矛盾就标出来，避免「被夸+愤怒」看起来像被夸加了负面
    const kindCn = kinds.map((k) => KIND_CN[k] || k).join('+');
    const moodCn = String(moodHint || '').trim();
    const note = moodCn && !kinds.some((k) => (KIND_CN[k] || '') === moodCn || (k === 'praise' && moodCn === '被夸'))
      ? `模型标${moodCn}→实际${kindCn}`
      : (moodCn || kindCn);
    pushLog(s, kindCn, note, chatKey, r.delta);
  }

  // ── 环境事件（不依赖模型打标）：被冷落 / 被刷屏 ──
  //   这是负面情绪最稳的来源：模型几乎从不主动报「被冷落」。
  //   ⚠️ 2026-09-22：这一段的冷却与计数都改过（见 ENV_COOLDOWN_MS 的注释）：
  //     · 同一个情形只记**一条**（envNeglect），不再"被冷落 + 无聊"成对刷两笔；
  //     · ignoredStreak 加 30 分钟时间衰减：隔夜的旧账不再接着算；
  //     · 环境事件不吃 sparsityBoost（那是给"隔了很久对方又说话"用的放大，
  //       环境事件本身不是对方说的话，隔夜放大到 2 倍会把无聊单次顶到 +25）。
  if (addressed) {
    // 被点名：清空「没人接」计数；历史 ignoreHits 也清掉，避免话题结束后一直误判自说自话
    s.ignoredStreak = 0;
    s.ignoreHits = 0;
    s.ignoredStreakAt = 0;
  } else if (n > 0) {
    const nowMs = Date.now();
    const streakAge = nowMs - (Number(s.ignoredStreakAt) || 0);
    if (s.ignoredStreakAt && streakAge > 30 * 60 * 1000) {
      // 隔了半小时以上：那已经不是"同一段没人接"，重新起算
      s.ignoredStreak = 0;
    }
    s.ignoredStreakAt = nowMs;
    // 机器人这轮说话了、却没人点它 → 记一次「没人接话」
    s.ignoredStreak = Math.min(12, (Number(s.ignoredStreak) || 0) + 1);
    // 被冷落：连着 3 轮没人接就记一次（streak 继续数，别在这里清零，否则无聊永远够不到门槛）
    let envFired = false;
    if (s.ignoredStreak >= 3 && allowEmote(s, 'envNeglect')) {
      const r = act(['ignore'], { quiet: true, sparsityBoost: 1 });
      pushLog(s, KIND_CN.ignore, `连续${s.ignoredStreak}轮没人接话`, chatKey, r.delta);
      s.ignoreHits = Math.min(3, (Number(s.ignoreHits) || 0) + 1);
      envFired = true;
    }
    // 无聊：只认**当前这一段**连着没人接（≥5）。不再用历史 ignoreHits —— 否则话题一结束就误判自说自话。
    // 同一段里如果刚记过「被冷落」（10 分钟内），就不再补一条「无聊」——
    // 用户反馈的就是"一次没人接被记两笔"。真被晾很久（>10 分钟）时它照样会记。
    const neglectAt = Number(s.lastEmoteAt?.envNeglect) || 0;
    const neglectRecent = neglectAt && (Date.now() - neglectAt) < ENV_COOLDOWN_MS;
    if (!envFired && !neglectRecent && s.ignoredStreak >= 5 && allowEmote(s, 'envBoredom')) {
      const rb = act(['boredom'], { quiet: true, sparsityBoost: 1 });
      pushLog(s, KIND_CN.boredom, `连着${s.ignoredStreak}轮没人接，有点无聊`, chatKey, rb.delta);
      s.ignoredStreak = 0;
      s.ignoredStreakAt = 0;
    }
  }
  if (!addressed && Number(triggerCount) >= 8 && allowEmote(s, 'busy')) {
    const r = act(['busy'], { quiet: true, sparsityBoost: 1 });
    pushLog(s, KIND_CN.busy, `一轮涌入 ${triggerCount} 条`, chatKey, r.delta);
  }
  if (toolFailed && allowEmote(s, 'toolFail')) {
    const r = act(['toolFail']);
    pushLog(s, KIND_CN.toolFail, '工具失败', chatKey, r.delta);
  } else if (status === 'done' && n > 0 && !kinds.length) {
    // 发送成功 ≠ 情绪事件。以前这里会 act(['toolOk']) 并刷「顺手成功」，
    // 于是情绪页几乎只剩「顺手」—— 它只说明这轮工具跑通了，不该进情绪池。
    // emotionGate/词表都没标出 kind 时：本就不改情绪，保持现状。
  }

  if (favorDelta && Number.isFinite(Number(favorDelta)) && emotionEnabled()) {
    if (Number(favorDelta) > 0) s.mood = clamp(s.mood + 4, 0, 100);
    else s.mood = clamp(s.mood - 3, 0, 100);
  }

  // 消耗：长回复耗认知/意志；多轮耗物理
  // 认知带软底：已经很低时几乎不再扣，避免连聊几轮掉到个位数
  const cogCur = Number(s.energy.cognitive) || 0;
  const cogScale = cogCur < 20 ? 0.25 : cogCur < 40 ? 0.65 : 1;
  const cogCost = Math.round((n >= 3 ? 2 : n > 0 ? 1 : 0) * cogScale);
  s.energy.cognitive = clamp(cogCur - cogCost, 0, 100);
  s.energy.will = clamp(s.energy.will - (status === 'error' ? 3 : n >= 5 ? 2 : 0), 0, 100);
  s.energy.physical = clamp(s.energy.physical - (status === 'error' ? 2 : n >= 6 ? 1 : 0), 0, 100);

  if (status === 'error') {
    s.acuteStress = clamp(s.acuteStress + 6, 0, 100);
    pushLog(s, KIND_CN.error, '运行出错', chatKey);
  }

  // 慢压：高频会话消耗。原先每轮 +1 太快，普通闲聊也会堆出紧绷；
  // 改成「说过话 +0.4，急压高再加一点」——正常聊几小时才会明显爬升。
  s.chronicPush = (Number(s.chronicPush) || 0)
    + (n > 0 ? 0.4 : 0)
    + (s.acuteStress > 50 ? (s.acuteStress - 50) * 0.04 : 0);
  if (s.chronicPush >= 1) {
    const step = Math.floor(s.chronicPush);
    s.chronicPush -= step;
    s.chronicStress = clamp(s.chronicStress + step, 0, 100);
  }

  // 慢压积久了冒焦虑/低落：门槛从 30 提到 45，避免正常聊几轮就闷
  if (s.chronicStress >= 45) {
    const push = Math.min(4, (s.chronicStress - 45) * 0.10);
    if (push >= 0.5 && allowEmote(s, 'anxiety')) {
      const beforeAnx = Number(s.emotions.anxiety) || 0;
      const beforeDown = Number(s.emotions.down) || 0;
      s.emotions.anxiety = clamp(Math.round(beforeAnx + push), 0, 100);
      s.emotions.down = clamp(Math.round(beforeDown + push * 0.6), 0, 100);
      const d = {
        anxiety: (Number(s.emotions.anxiety) || 0) - beforeAnx,
        down: (Number(s.emotions.down) || 0) - beforeDown
      };
      for (const k of Object.keys(d)) {
        if (!Number.isFinite(d[k]) || d[k] === 0) delete d[k];
        else d[k] = Math.round(d[k]);
      }
      if (Object.keys(d).length) {
        pushLog(s, KIND_CN.anxiety, `慢压${Math.round(s.chronicStress)}带出的紧绷`, chatKey, d);
      }
    }
  }

  // 对立面互压已在 appraiseAndAct 末尾做过；这里只保留心情耦合
  if ((s.emotions.joy || 0) > 30) s.emotions.down = clamp(s.emotions.down - 3, 0, 100);
  if ((s.emotions.cheer || 0) > 30) s.emotions.loneliness = clamp(s.emotions.loneliness - 3, 0, 100);

  s.intent = computeIntent(s);
  s.updatedAt = Date.now();
  s.lastDecayAt = Date.now();
  write(s);
  return s;
}

export function energyLabel(v) {
  const n = Number(v) || 0;
  if (n >= 85) return '满血';
  if (n >= 65) return '还行';
  if (n >= 40) return '一般';
  if (n >= 25) return '偏累';
  return '很累';
}

export function moodLabel(v) {
  const n = Number(v) || 50;
  if (n >= 72) return '不错';
  if (n >= 58) return '平稳';
  if (n >= 42) return '一般';
  if (n >= 28) return '有点闷';
  return '不太妙';
}

export function socialLabel(v) {
  const n = Number(v) || 60;
  if (n >= 75) return '还想聊';
  if (n >= 50) return '还行';
  if (n >= 30) return '有点乏';
  return '想安静';
}

export function topEmotionPhrases(emotions, max = 2) {
  return topEmotionEntries(emotions || {}, 22, max).map((x) => x.label);
}

/** 离散情绪目录（后台整页用）：含全部维度、半衰期、当前强度。 */
export function listEmotionCatalog(stateIn) {
  const s = stateIn || getBotState();
  const emo = s.emotions || {};
  const catLabel = { out: '向外', in: '向内', neu: '中性' };
  const signLabel = { pos: '正性', neg: '负性', neu: '中性' };
  return EMO_KEYS.map((k) => {
    const meta = EMOTIONS[k];
    const v = clamp(Math.round(Number(emo[k]) || 0), 0, 100);
    return {
      key: k,
      label: meta.label,
      cat: meta.cat,
      catLabel: catLabel[meta.cat] || meta.cat,
      // 同一方向里也有正负（向外既有愤怒也有得意），UI 要按这个上色
      sign: meta.sign || 'neu',
      signLabel: signLabel[meta.sign] || meta.sign || '中性',
      halfLifeMin: meta.halfLifeMin,
      value: v,
      active: v >= 8
    };
  }).sort((a, b) => {
    const order = { in: 0, out: 1, neu: 2 };
    if (order[a.cat] !== order[b.cat]) return order[a.cat] - order[b.cat];
    return b.value - a.value;
  });
}

/**
 * 注入提示词：极轻。
 * - 默认只一句状态摘要
 * - 仅当有明显情绪/意图时加行为倾向半句
 * 不要把状态写成说明书。
 */
export function botStatePromptLine(stateIn) {
  // 亢奋模式：系统已换成极简亢奋协议，这里只补一句状态，不再叠规则
  if (isHypeMode()) {
    const lock = getHypeProtectedQQ();
    return lock
      ? `（亢奋模式）按【角色设定】的亢奋卡打，别软。硬锁：QQ ${lock} 不能骂/阴阳/@/波及。`
      : '（亢奋模式）按【角色设定】的亢奋卡打，别软。';
  }
  const s = stateIn || getBotState();
  const e = s.energy;
  const avgE = Math.round((e.physical + e.cognitive + e.emotional + e.will) / 4);
  // 情绪系统关掉时只报精力：心情/压力/情绪标签/由情绪推导的行为约束一律不再进提示词。
  if (!emotionEnabled()) return `（此刻）精力${energyLabel(avgE)}。`;
  const parts = [
    `精力${energyLabel(avgE)}`,
    `心情${moodLabel(s.mood)}`
  ];
  // 压力说人话：急压 = 刚被刺激过还没缓过来；慢压 = 一直没停着
  if (s.acuteStress >= 40) parts.push('刚被刺激过，还没缓过来');
  else if (s.chronicStress >= 40) parts.push('一直没停，有点绷不住');

  // 三类聚合：模型不需要看 21 个标签，知道「向内闷着」还是「有外露的火气」就够
  const dirSum = { out: 0, in: 0, neu: 0 };
  const dirTop = { out: [], in: [], neu: [] };
  for (const k of EMO_KEYS) {
    const v = Number(s.emotions[k]) || 0;
    if (v < 10) continue;
    const cat = EMOTIONS[k].cat;
    dirSum[cat] += v;
    dirTop[cat].push({ k, v, label: EMOTIONS[k].label });
  }
  const dirWord = (n) => (n >= 50 ? '很重' : n >= 30 ? '偏重' : n >= 15 ? '有点' : n >= 6 ? '一点点' : '');
  const bits = [];
  for (const [key, name] of [['in', '向内'], ['out', '向外'], ['neu', '中性']]) {
    const w = dirWord(dirSum[key]);
    if (!w) continue;
    dirTop[key].sort((a, b) => b.v - a.v);
    const named = dirTop[key].slice(0, 2)
      .map((x) => (EMO_PLAIN[x.k] ? `${x.label}(${EMO_PLAIN[x.k]})` : x.label)).join('、');
    bits.push(`${name}${w}${named ? '：' + named : ''}`);
  }
  let line = `（此刻）${parts.join('，')}。`;
  if (bits.length) line += `情绪：${bits.join('；')}。`;
  // 「别念出来」不是废话：2026-09-21 实测模型把这句学舌成了发言
  // （「有点得意的情绪，可以顺着…接梗。不用查记忆…」），加个显式标记降低回声概率。
  if (s.intent) line += `倾向（内部提示，别照着念）：${s.intent}。`;
  // 行为约束：负性堆够了就给攻击许可，而不是一味让忍
  const strong = (k) => (Number(s.emotions[k]) || 0) >= 25;
  const hotNow = sumHotEmotions(s.emotions);
  if (hotNow >= 28) {
    line += '气到这份上了，想骂就骂，别硬憋。';
  } else if (hotNow >= 14) {
    line += '有点上火，被惹了可以炸回去。';
  } else if (s.acuteStress >= 70) {
    line += '有点绷着，先别硬刚。';
  } else if (e.cognitive < 25) {
    line += '脑子转不动就少查少绕。';
  } else if (strong('shame')) {
    line += '别装死，承认就行。';
  }
  return line;
}

export function botStateView() {
  const s = getBotState();
  const avgE = Math.round((s.energy.physical + s.energy.cognitive + s.energy.emotional + s.energy.will) / 4);
  return {
    // UI 兼容
    energy: avgE,
    energyLabel: energyLabel(avgE),
    energyDetail: s.energy,
    mood: Math.round(s.mood - 50), // 显示用 -50~50
    moodLabel: moodLabel(s.mood),
    moodRaw: s.mood,
    social: Math.round((s.energy.emotional / 100) * 3),
    socialLabel: socialLabel(s.energy.emotional),
    arousal: s.arousal,
    acuteStress: s.acuteStress,
    chronicStress: Math.round(s.chronicStress), // 内部是浮点，给 UI 取整
    intent: s.intent,
    emotions: s.emotions,
    emotionCatalog: listEmotionCatalog(s),
    emotionPhrases: topEmotionPhrases(s.emotions, 5),
    lastEvent: s.lastEvent,
    eventLog: s.eventLog || [],
    promptLine: botStatePromptLine(s),
    updatedAt: s.updatedAt
  };
}

export function setBotState(partial = {}) {
  const s = getBotState({ persist: false, forceDecay: true });
  if (partial.energy != null) {
    if (typeof partial.energy === 'object') {
      s.energy = normEnergy({ ...s.energy, ...partial.energy });
    } else {
      const avg = clamp(Number(partial.energy) || 50, 0, 100);
      s.energy = { physical: avg, cognitive: avg, emotional: avg, will: avg };
    }
  }
  if (partial.mood != null) {
    let m = Number(partial.mood);
    if (Number.isFinite(m)) {
      // 仍接受少量 v1 负偏移；0~100 直接当现值
      if (m < 0) m = 50 + m;
      s.mood = clamp(Math.round(m), 0, 100);
    }
  }
  if (partial.social != null) {
    s.energy.emotional = clamp(Math.round((clamp(Number(partial.social) || 2, 1, 3) / 3) * 100), 0, 100);
  }
  if (partial.acuteStress != null) s.acuteStress = clamp(Number(partial.acuteStress) || 0, 0, 100);
  if (partial.chronicStress != null) s.chronicStress = clamp(Number(partial.chronicStress) || 0, 0, 100);
  if (partial.emotions && typeof partial.emotions === 'object') {
    s.emotions = normEmotions({ ...s.emotions, ...partial.emotions });
  }
  if (partial.reset) {
    s.mood = DEFAULT.mood;
    s.arousal = DEFAULT.arousal;
    s.energy = { ...DEFAULT.energy };
    s.acuteStress = 0;
    s.chronicStress = 0;
    s.intent = '';
    s.emotions = emptyEmotions();
    s.lastEvent = null;
    s.eventLog = [];
    s.lastEmoteAt = {};
  }
  s.intent = computeIntent(s);
  s.updatedAt = Date.now();
  write(s);
  return botStateView();
}

/**
 * 合并「词表 + 本地 emotionGate」的 kind，专门治 0.8B 把玩闹标成 roast。
 *
 * 规则（宁可少记负面，也别把互怼标成被骂）：
 *   · 词表硬骂 / victim 「我被骂了」 → roast 优先
 *   · 词表玩闹词（胖鲸/蓝毛/白的…）或句子带玩闹氛围 → tease 优先，
 *     Jev 的 roast 降级为 tease
 *   · Jev 给 praise/help/vent… 且词表没有反面信号 → 采用
 *   · chat/none 不覆盖词表已抓到的标签
 */
export function mergeEmotionSignals(vocab = [], jevKind = null, text = '') {
  const out = [];
  const push = (k) => { if (k && !out.includes(k)) out.push(k); };
  const ALLOW = new Set([
    'praise', 'roast', 'tease', 'memeOk', 'chat', 'mention', 'sadness',
    'help', 'shame', 'gratitude', 'curiosity', 'busy', 'ignore'
  ]);
  const t = String(text || '');
  const vlist = Array.isArray(vocab) ? vocab.filter(Boolean).filter((k) => ALLOW.has(k)) : [];
  const vset = new Set(vlist);
  const roastHard = /(傻逼|智障|脑瘫|弱智|去死|贱人|滚出去|垃圾玩意|废物点心|你他妈|你妈的|去你妈|气死我了|气炸|真生气)/i;
  const victimRoast = /(我被怼|我被骂|我被喷|有人骂我|有人怼我|骂我了|怼我了)/i;
  const playful = /(哈哈哈|哈哈|笑死|胖鲸|大胖鲸|蓝毛|白的|白毛|掉色|贴贴|好菜|菜鸟|逆天|离谱|草|乐|典|蚌埠|鲸鱼|不许叫|明明是)/i;
  const hard = roastHard.test(t) || victimRoast.test(t) || vset.has('roast');
  const play = vset.has('tease') || (playful.test(t) && !hard);

  if (hard && !play) push('roast');
  if (play) push('tease');

  if (jevKind && jevKind !== 'none' && jevKind !== 'chat' && ALLOW.has(jevKind)) {
    if (jevKind === 'roast') {
      if (!hard) push('tease');
      else push('roast');
    } else if (jevKind === 'tease') {
      if (!hard) push('tease');
      else if (play) push('tease');
    } else {
      push(jevKind);
    }
  }

  for (const k of vlist) {
    if (k === 'roast' && play && !hard) continue;
    push(k);
  }
  return out
    .sort((a, b) => (NEG_KINDS.has(a) ? 0 : 1) - (NEG_KINDS.has(b) ? 0 : 1))
    .slice(0, 3);
}

/**
 * 触发文本 → 事件类型（可多类并存）。
 * 只保留仍会触发的 kind：Jev 7 种 + 环境确认词 + 少数词表规则
 * （help/shame/gratitude/curiosity）。已删除的 kind 不再从词表 push。
 */
export function detectIncomingHint(triggerTexts = []) {
  const text = String(triggerTexts.join('\n'))
    .replace(/\[CQ:[^\]]*\]/g, '')
    .replace(/@[^\s\[\]]{0,24}/g, '');
  if (!text.trim()) return null;
  const found = [];

  const roastHard = /(傻逼|智障|脑瘫|弱智|去死|贱人|滚出去|垃圾玩意|废物点心|闭嘴吧|你他妈|你妈的|去你妈|气死我了|气炸|真生气|我生气|我认真的|受够了|气哭|我很生气)/i;
  const roastSoft = /(你这狗|狗东西|蠢鱼|蠢狗|蠢东西|识成狗|说[我你]狗|叫[我你]狗|眼瞎|真瞎|瞎了|文盲|没救了|byd|笨鱼|这水平|不拿[^。！？]{0,4}当人|烦死|讨厌死|垃圾|废物|笨死了|蠢货)/i;
  const praise = /(你好?可爱|真可爱|太可爱|真厉害|好厉害|太厉害|喜欢你|爱你|真好看|好强|太强了|天才|好乖|贴贴|真棒|好棒|真聪明|好聪明|好贴心|有你在真好|多亏你)/i;
  const busy = /(刷屏|别插嘴|闭嘴听我说|别打岔|慢点说|你闭嘴听|别吵|吵死|刷了一堆|刷屏了)/i;
  const tease = /(胖鲸|大胖鲸|太肥|好肥|肥了|蓝毛|蓝的|白毛|白的|掉色|闪光种|异色|鲸鱼|小鲸鱼|鲸娘|贴贴|不许叫|不许说我|不许你|又来了|才不肥|我才不|明明是白|菜鸟|太菜|好菜|菜狗|菜鸡|菜死|唐氏|唐完|逆天|离谱|笨蛋|呆鱼|傻鱼|摸鱼怪|笨鱼|小笨蛋)/i;
  const curiosity = /(为什么|怎么|是什么|求解释|科普|讲讲|原理|啥意思|咋回事|咋整|为什么呢|什么原因)/i;
  const ignore = /(没人在|不理你|消失|又不说话|没人理我|没人回|又冷场)/i;
  const shame = /(社死|丢死人|尬死|被公开处刑|说漏嘴了|好丢人|太尬了|脚趾抠地|钻地缝|又翻车|打脸了)/i;
  const help = /(帮我|帮个忙|求帮忙|帮帮我|救救|求助|能不能帮|拜托|麻烦你帮)/i;
  const sadness = /(好难过|真难过|伤心|哭了|心寒|emo了|想哭|分手了|好伤心|破防了|泪目|难受死了|委屈死)/i;
  const gratitude = /(谢谢|谢了|多谢|感谢|辛苦了|太够意思|破费|感恩|抱拳)/i;
  const victimRoast = /(我被怼|我被骂|我被喷|被人怼|被人骂|有人骂我|有人怼我|骂我了|怼我了|喷我了|真被骂|真被怼|被怼了|被骂了|被喷了)/i;

  const hardHit = roastHard.test(text) || victimRoast.test(text);
  const softHit = roastSoft.test(text);
  const teaseHit = tease.test(text);
  if (hardHit) found.push('roast');
  else if (softHit && !teaseHit) found.push('tease');
  if (!hardHit && teaseHit) {
    const ri = found.indexOf('roast');
    if (ri >= 0) found.splice(ri, 1);
  }
  if (praise.test(text)) found.push('praise');
  if (busy.test(text)) found.push('busy');
  if (teaseHit && !found.includes('tease')) found.push('tease');
  if (curiosity.test(text)) found.push('curiosity');
  if (ignore.test(text)) found.push('ignore');
  if (shame.test(text)) found.push('shame');
  if (help.test(text)) found.push('help');
  if (sadness.test(text)) found.push('sadness');
  if (gratitude.test(text)) found.push('gratitude');

  const keepExplicit = new Set();
  if (sadness.test(text)) keepExplicit.add('sadness');
  if (gratitude.test(text)) keepExplicit.add('gratitude');
  if (!hardHit && (softHit || tease.test(text) || /哈+|草|乐|典|笑死|蚌埠|逆天|离谱/.test(text))) {
    for (const k of ['roast', 'shame', 'sadness']) {
      if (keepExplicit.has(k)) continue;
      const i = found.indexOf(k);
      if (i >= 0) found.splice(i, 1);
    }
  }

  if (!found.length) return null;
  // 负面优先 + 尽量留更多档：有 3 类时最多留 3，否则留 2
  const uniq = [...new Set(found)].sort((a, b) => (NEG_KINDS.has(a) ? 0 : 1) - (NEG_KINDS.has(b) ? 0 : 1));
  const types = uniq.slice(0, uniq.length >= 3 ? 3 : 2);
  return {
    type: types,
    text: text.slice(0, 60)
  };
}
