// 群友印象：全局按 QQ 号（人），不再按群分裂。
// 目录：data/memory/people/<QQ>.json 或 _n_<名字>.json
// 文件：{ userId, name, chats:[], impressions:[{content,createdAt}], favor, attitude, updatedAt }
// 提示词用极短格式注入，控制 token。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, updateConfig } from './config.js';
import { memoryDir, memoryPeopleDir } from './paths.js';
import { logMemoryChange } from './memory-audit.js';
import { tokenize } from './conversation-memory/tokenize.js';
import { jevGate, localJevHasRole } from './local-jev.js';
import { noteEntry, decayInfo, liveEntries, pruneEntries, ageLabel } from './half-life.js';

const MEMORY_DIR = memoryDir();
const PEOPLE_DIR = memoryPeopleDir();

// ── 表层记忆（2026-09-21）────────────────────────────────────────────────
// 长期印象回答的是"这个人是谁"（学历、口味、雷点，几个月不变）；但真聊天里还要知道
// "他这会儿怎么了"——刚说外卖丢了、在改插件、困得不行。原来这些只活在上下文窗口里，
// 窗口一滑就没了，于是它下次开口就像没见过这个人。
// 所以仿世界系统的近况账本做一层**表层记忆**，存在每个人档案里（surface），规则：
//   · 只从**他自己发的话**里抓（说话人就是他，不存在世界账本那种"主语是谁"的歧义）；
//   · 按槽位覆盖（body/mood/doing/wait/plan），每个槽位任何时刻只有一个说法；
//   · **随时间半衰**（见 half-life.js）：权重 0.5^(age/半衰期)，掉到 0.25 以下不再注入，
//     注入时带上"几分钟前"这种粗年龄，让模型自己知道这条还有多新。
// 零模型调用、零额外延迟：就是几条正则 + 一次文件写（同一人同一分钟只写一次）。
const SURFACE_KINDS = {
  body: { hl: 120, cn: '身体' },     // 累/困/疼/病
  mood: { hl: 45, cn: '情绪' },      // 气/乐/破防/无语
  doing: { hl: 90, cn: '在忙' },     // 上班/赶稿/写代码/复习
  wait: { hl: 120, cn: '在等' },     // 等外卖/等审核/等结果
  plan: { hl: 240, cn: '打算' }      // 明天/周末要去做的事
};

/** 抓取规则：命中即把**整句（洗过的）**记进对应槽位，不合成"标签句"（合成容易变成档案腔）。 */
const SURFACE_RULES = [
  ['body', /(?:好累|累了|太累|累死|累成狗|累瘫|累趴|困死|困得|好困|困了|想睡|去睡|熬夜|没睡好|失眠|头疼|胃疼|肚子疼|感冒|发烧|不舒服|生病|阳了|腰疼)/],
  ['mood', /(?:气死|生气|好气|气到|破防|难受|emo|委屈|烦死|烦人|崩了|寄了|麻了|无语|开心|好爽|笑死|乐死|爽到|蚌埠|绷不住)/],
  ['doing', /(?:在忙|加班|赶稿|赶工|写作业|写代码|改bug|改插件|做视频|剪片|上课|上班|开会|复习|刷题|面试|健身|搬家)/],
  ['wait', /(?:等外卖|等快递|等审核|等通知|等结果|等发货|等回复|排队|挂号|还在等|等了[^。！？]{0,4}(?:小时|分钟|天))|(?:外卖|快递)[^。！？]{0,4}(?:丢|没到|迟|慢)/],
  ['plan', /(?:明天|后天|下周|周末|晚点|待会|一会儿)[^。！？]{0,10}(?:去|要|得|准备|约|做|打|看|见)/]
];

function chatDirName(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

function chatDir(chatKey) {
  return path.join(MEMORY_DIR, chatDirName(chatKey));
}

function metaFile(chatKey) {
  return path.join(chatDir(chatKey), '_meta.json');
}

function personFileName(userId, name = '') {
  if (String(userId ?? '').trim()) {
    const id = String(userId).trim();
    return /^\d+$/.test(id) ? `${id}.json` : `u_${id.replace(/[^a-z0-9_]/gi, '_')}.json`;
  }
  const safe = String(name || 'unknown').trim().replace(/[^a-z0-9_一-鿿]/gi, '_').slice(0, 40);
  return `_n_${safe || 'unknown'}.json`;
}

function personFile(userId, name = '') {
  return path.join(PEOPLE_DIR, personFileName(userId, name));
}

/** 印象类型：身份/喜好/雷点/风格/事件/态度。注入时优先 pin + 近的。 */
const IMP_TYPES = ['identity', 'preference', 'edge', 'style', 'event', 'attitude'];
const IMP_TYPE_LABEL = {
  identity: '身份',
  preference: '喜好',
  edge: '雷点',
  style: '风格',
  event: '事件',
  attitude: '态度'
};

function guessImpressionType(content) {
  const t = String(content || '');
  if (/(态度|对他要|对他该|对他用|对他：|宠着|少怼|顺着说|站他)/.test(t)) return 'attitude';
  if (/(别|不要|讨厌|烦死|雷点|忌|禁止|一提就|不想听)/.test(t)) return 'edge';
  if (/(喜欢|爱吃|爱玩|爱好|常用|常去|最爱)/.test(t)) return 'preference';
  if (/(学生|打工|程序员|上班|住|老家|女朋友|男朋友|在读|岁|xx岁)/.test(t)) return 'identity';
  if (/(说话|口头禅|风格|社牛|社恐|话痨|爱玩梗|昵称)/.test(t)) return 'style';
  return 'event';
}

function normImpression(raw, now = Date.now()) {
  if (raw == null) return null;
  if (typeof raw === 'string') {
    const content = String(raw).trim().slice(0, 160);
    if (!content) return null;
    return {
      content,
      type: guessImpressionType(content),
      // type 是正则猜出来的（不是模型/人工给的）→ 标记，供 refineImpressionTypes 升级
      typeGuess: true,
      pin: false,
      lastSeen: null,
      personLastActiveAt: null,
      lastConfirmedAt: null,
      lastRetrievedAt: null,
      createdAt: now
    };
  }
  const content = String(raw.content ?? '').trim().slice(0, 160);
  if (!content) return null;
  let type = String(raw.type || '').trim().toLowerCase();
  let typeGuess = false;
  if (!IMP_TYPES.includes(type)) {
    type = guessImpressionType(content);
    typeGuess = true;
  }
  const createdAt = Number(raw.createdAt) || now;
  return {
    content,
    type,
    typeGuess,
    pin: !!raw.pin,
    lastSeen: Number(raw.lastSeen) || null,
    personLastActiveAt: Number(raw.personLastActiveAt) || null,
    lastConfirmedAt: raw.lastConfirmedAt == null ? null : Number(raw.lastConfirmedAt) || null,
    lastRetrievedAt: Number(raw.lastRetrievedAt) || null,
    createdAt
  };
}

function impressionFactTime(e) {
  return Number(e?.lastConfirmedAt) || Number(e?.createdAt) || 0;
}

function mergeImpressionTimestamps(keep, gone) {
  keep.lastConfirmedAt = Math.max(Number(keep.lastConfirmedAt) || 0, Number(gone.lastConfirmedAt) || 0) || null;
  keep.lastSeen = Math.max(Number(keep.lastSeen) || 0, Number(gone.lastSeen) || 0) || null;
  keep.lastRetrievedAt = Math.max(Number(keep.lastRetrievedAt) || 0, Number(gone.lastRetrievedAt) || 0) || null;
  const createdAt = [Number(keep.createdAt), Number(gone.createdAt)].filter((n) => Number.isFinite(n) && n > 0);
  if (createdAt.length) keep.createdAt = Math.min(...createdAt);
}

/** 好感七档标签（写进提示词 / UI） */
export function favorTierInfo(favor) {
  const v = Math.min(100, Math.max(0, Math.round(Number(favor) || 50)));
  if (v <= 13) return { key: 'hostile', label: '敌意', tag: '敌意', color: 'red' };
  if (v <= 27) return { key: 'cold', label: '冷淡', tag: '好感低', color: 'red' };
  if (v <= 41) return { key: 'distant', label: '疏远', tag: '稍冷', color: 'orange' };
  if (v <= 57) return { key: 'neutral', label: '中性', tag: '', color: 'accent' };
  if (v <= 71) return { key: 'friendly', label: '友好', tag: '稍友好', color: 'green' };
  if (v <= 85) return { key: 'close', label: '亲近', tag: '好感高', color: 'green' };
  return { key: 'protect', label: '贴心/护短', tag: '死党', color: 'green' };
}

function favorFavTag(favor) {
  return favorTierInfo(favor).tag;
}

/** 高好感：顺着说、帮腔、护着；低好感：冷淡、少理。 */
function favorToneHint(who, favor) {
  const t = favorTierInfo(favor);
  switch (t.key) {
    case 'hostile': return `对${who}：明显敌意，能避就避；被粘着可短句怼完就走，别耐心解释`;
    case 'cold': return `对${who}：冷淡敷衍，少接话；别热情贴上去`;
    case 'distant': return `对${who}：稍冷、话少；不主动帮腔`;
    case 'neutral': return '';
    case 'friendly': return `对${who}：友好，愿意接话、语气松一点`;
    case 'close': return `对${who}：亲近。顺着对方说、帮腔护着点；对方被怼可站他/替他说话；别为了正确硬顶`;
    case 'protect': return `对${who}：死党/贴心。明显偏袒护短，主动站对方、顺着说、替他挡话；别人怼他可回怼回去（仍别过火）`;
    default: return '';
  }
}

/**
 * 归一化表层记忆：只认已知槽位，字段不全会补默认值。
 * （老档案没有 surface 字段 → 空对象，不做迁移：这层本来就是新的、会自己长出来。）
 */
function normSurface(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [kind, entry] of Object.entries(raw)) {
    if (!SURFACE_KINDS[kind]) continue;
    const text = String(entry?.text || '').trim().slice(0, 40);
    if (!text) continue;
    const at = Number(entry?.at) || 0;
    if (!at) continue;
    out[kind] = {
      text,
      at,
      bornAt: Number(entry?.bornAt) || at,
      hl: Number(entry?.hl) || SURFACE_KINDS[kind].hl,
      shown: Number(entry?.shown) || 0,
      renewed: Number(entry?.renewed) || 0
    };
  }
  return out;
}

/**
 * 表层记忆的清洗：只留人话。
 * 存档里的原文带着 @某人[CQ:at,qq=…]、[引用 …]、[图片]、链接 —— 这些当"近况"读起来是噪音。
 */
function stripSurfaceNoise(raw) {
  return String(raw || '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/\[引用[^\]]{0,80}\]/g, ' ')
    .replace(/\[(?:图片|表情\d*|合并转发[^\]]*|转发消息[^\]]*|拍一拍|语音|视频|文件)\]/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/@\S{1,24}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 印象条数的**安全阀**（不是业务上限）。
 *
 * 为什么是 60 而不是 12（2026-09-22 用户反馈"印象加到一定条数就加不进去"）：
 * 原来各处硬编码 `slice(0, 12)`，加第 13 条时最老的一条会被**默默**丢掉 ——
 * 界面里看起来就是"存不进去"。实际上注入端（formatForPrompt）每轮只挑 2 条、
 * 还有 380 字预算，库里有几十条也不会让提示词变长，所以条数根本不该由存储层限制。
 * 现在只在极端情况（>60 条）兜底，并且**钉住的永不丢**，丢的是最旧且没钉的，返回被丢条数
 * 供调用方记日志。
 */
export const MAX_IMPRESSIONS = 60;

function trimImpressions(person) {
  const list = Array.isArray(person?.impressions) ? person.impressions : [];
  if (list.length <= MAX_IMPRESSIONS) return 0;
  const pinned = list.filter((e) => e?.pin);
  const rest = list.filter((e) => !e?.pin)
    .sort((a, b) => impressionFactTime(b) - impressionFactTime(a));
  const keepRest = rest.slice(0, Math.max(0, MAX_IMPRESSIONS - pinned.length));
  const dropped = rest.length - keepRest.length;
  person.impressions = [...pinned, ...keepRest]
    .sort((a, b) => impressionFactTime(b) - impressionFactTime(a));
  return dropped;
}

function normImpressions(list) {
  const now = Date.now();
  const out = [];
  const seen = new Set();
  for (const raw of (Array.isArray(list) ? list : [])) {
    const e = normImpression(raw, now);
    if (!e || seen.has(e.content)) continue;
    seen.add(e.content);
    out.push(e);
  }
  return out;
}

/** 单条印象的新鲜度（0~1）。pin 一直 1；60 天外非 pin 接近 0。 */
function impressionRecency(e, now = Date.now()) {
  const t = impressionFactTime(e);
  if (!t) return 0.2;
  const days = Math.max(0, (now - t) / 86400000);
  if (e?.pin) return 1;
  if (days <= 7) return 1;
  if (days <= 30) return 0.75;
  if (days <= 60) return 0.45;
  return 0.15;
}

// ── 话题相关的印象挑选（2026-09-21）──
// 起因（有据可查）：每人只注入 maxEach=2 条，按「pin > 新鲜 > 类型」取前二。示例用户那 4 条
// 印象新鲜度全是 1、类型全是 event，排序退化成插入顺序 —— 「音乐推荐口味固定三类：古典、
// 摇滚、OST…推歌请严格遵循此三类」正好被挤到第 3 条，永远进不了提示词。
// 后果实测：群里点名「京玉，给我推首歌」，机器人内心独白写着
// 「印象里只写了态度是死党护短，没具体记音乐口味」，然后 search_music("随机") 随便推了一首。
// 所以：**先按当前这句话算一遍相关性**，相关的那条优先占名额；字面不重合但语义相关的
// （「今天好累」↔「深夜易焦虑」）留给本地 Jev 补（见 topicPicks）。
let topicFilterCache = new Map();

/**
 * 单句话题 → 检索用的小结构 { set, pos }。
 * 把机器人自己的名字切掉（"京玉，给我推首歌"里"京玉"会误命中含"白京玉"的档案）；
 * 同时记下每个字在句中的位置，供"跳字 bigram"匹配用（见 topicOverlap）。
 */
function tokensForLine(line) {
  const raw = String(line || '').replace(/\s+/g, ' ').trim().slice(0, 160);
  if (!raw) return null;
  const cached = topicFilterCache.get(raw);
  if (cached) return cached;
  const botName = String(getConfig().persona?.botName || '').replace(/\s+/g, '');
  const selfId = String(getConfig().onebot?.selfId || '');
  const set = new Set();
  for (const t of tokenize(raw)) {
    if (!t || t.length > 8) continue;
    if (selfId && t === selfId) continue;
    // 名字的任意切片都不算话题词（「京」「玉」「京玉」都会被"白京玉"吃掉）
    if (botName && (botName.includes(t) || t.includes(botName)) && t.length <= botName.length) continue;
    set.add(t);
  }
  // 汉字位置：用来判"跳字 bigram"（推首歌 → 推…歌 窗口内相邻）
  const pos = new Map();
  const chars = [...raw];
  for (let i = 0; i < chars.length; i += 1) {
    const c = chars[i];
    if (!/[\u4e00-\u9fff]/.test(c)) continue;
    let arr = pos.get(c);
    if (!arr) { arr = []; pos.set(c, arr); }
    arr.push(i);
  }
  const info = { set, pos };
  if (topicFilterCache.size > 400) topicFilterCache = new Map();
  topicFilterCache.set(raw, info);
  return info;
}

/**
 * 触发文本 → 若干「单句」结构。
 * 为什么按句拆：刷屏群里一次唤醒可能带好几条消息，拼成一坨算重合的话，
 * 「给我推首歌」会被旁边聊猫聊模型的句子稀释掉。逐句算、取最大值，语义才对得上
 * （"这批消息里有一条提到跟这条印象相关的事"）。
 */
function topicTokenSets(topic) {
  const lines = Array.isArray(topic) ? topic : [topic];
  const out = [];
  for (const line of lines) {
    if (out.length >= 6) break;
    const info = tokensForLine(line);
    if (info && info.set.size) out.push(info);
  }
  return out;
}

/** 印象里的两字词，能不能在触发句里「跳着」对上（推首歌 ↔ 推歌）。窗口 ≤3 字。 */
function skipBigramHit(info, tok) {
  if (tok.length !== 2) return false;
  const [a, b] = tok;
  if (a === b) return false;
  const pa = info.pos.get(a);
  const pb = info.pos.get(b);
  if (!pa || !pb) return false;
  for (const i of pa) {
    for (const j of pb) {
      if (j > i && j - i <= 3) return true;
    }
  }
  return false;
}

/**
 * 这条印象跟当前话题重合多少（逐句取最大，封顶 2）。
 *
 * 计分（实测调出来的，别随手改成"每个字都算 0.3"）：
 *   · 印象里的 **两字词**在话题句里出现 = +1；允许跳字（推首歌 ↔ 推歌，窗口 ≤3 字）
 *   · 只对上**单个汉字** = 最多 +0.2（不管对上几个字）
 * 为什么单字必须压到 0.2：刷屏群的触发批里"不/人/大/件/推/定"这类字到处都是。
 * 按字累加时「群里的机器人管理员…」能靠 部/人/不 攒到 0.9，压过真正沾边的「推歌口味」；
 * 就算改成每字 0.2、封顶 0.4，「音乐推荐口味」仍会靠 推/定 两个字（0.4）把
 * 「某高校…」挤下去 —— 实测那一轮根本没人提音乐。压到 0.2 之后：
 * 三个候选都只有单字巧合 → 同分 → 顺序不变（等于没插手）；只有真词命中（1.0 起）才换人。
 */
export function topicOverlap(content, topicSets) {
  // 允许传「文本」「文本数组」「结构数组」三种：调用方容易记混，这里统一收口
  const sets = Array.isArray(topicSets) && topicSets[0] && topicSets[0].set instanceof Set
    ? topicSets
    : topicTokenSets(topicSets);
  if (!sets.length) return 0;
  const text = String(content || '');
  if (!text) return 0;
  const toks = tokenize(text);
  if (!toks.length) return 0;
  let best = 0;
  for (const info of sets) {
    let bigrams = 0;
    const chars = new Set();
    for (const t of toks) {
      if (info.set.has(t)) {
        if (t.length >= 2) bigrams += 1;
        else chars.add(t);
        continue;
      }
      if (skipBigramHit(info, t)) bigrams += 1;
    }
    const sum = Math.min(2, bigrams + Math.min(0.2, chars.size * 0.2));
    if (sum > best) best = sum;
    if (best >= 2) break;
  }
  return Math.round(best * 100) / 100;
}

/** 按「pin + 新鲜 + 类型 + 话题重合」排序某人的印象（style 类不参与注入）。 */
function rankImpressions(m, topicSets, now = Date.now()) {
  return (m?.impressions || [])
    // ⚠️ 2026-09-21：`type: 'style'` 的条目（"说话风格随性损友式，爱用网络口语…"）是
    //    consolidate 出来的通用画像 —— 对"该怎么回他"几乎没有指导价值，却占着名额，
    //    而且这种档案腔最容易被模型原样念出来。留在库里，但不注入提示词。
    .filter((e) => String(e?.type || '') !== 'style')
    .map((e) => {
      const rec = impressionRecency(e, now);
      const typeW = e.type === 'attitude' ? 0.4
        : e.type === 'edge' ? 0.35
        : e.type === 'preference' ? 0.3
        : e.type === 'identity' ? 0.15
        : 0;
      const rel = topicOverlap(e.content, topicSets);
      return { e, rec, rel, score: (e.pin ? 10 : 0) + rec + typeW + rel };
    })
    .filter((x) => x.e.pin || x.rec >= 0.2)
    .sort((a, b) => b.score - a.score);
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

function loadPerson(userId, name = '') {
  const raw = readJson(personFile(userId, name), null);
  return {
    userId: String(raw?.userId ?? userId ?? ''),
    name: String(raw?.name ?? name ?? ''),
    chats: Array.isArray(raw?.chats) ? raw.chats.map(String) : [],
    impressions: normImpressions(raw?.impressions),
    surface: normSurface(raw?.surface),
    // 好感度 0~100，50=中性。旧 replyBias(100中性) 一次性映射过来。
    favor: Number.isFinite(Number(raw?.favor))
      ? Math.min(100, Math.max(0, Math.round(Number(raw.favor))))
      : (Number.isFinite(Number(raw?.replyBias))
        ? Math.min(100, Math.max(0, Math.round(Number(raw.replyBias) / 2)))
        : 50),
    // 管理员指定的「对他该用什么态度」自由文本；优先于好感档位提示注入
    attitude: String(raw?.attitude || '').trim().slice(0, 120),
    manuallyEditedAt: Number(raw?.manuallyEditedAt) || 0,
    personLastActiveAt: Number(raw?.personLastActiveAt) || 0,
    updatedAt: Number(raw?.updatedAt) || 0,
    lastConsolidatedAt: Number(raw?.lastConsolidatedAt) || 0
  };
}

function personKey(userId, name = '') {
  return userId ? String(userId) : `_n_${personFileName('', name)}`;
}

export class MemoryStore {
  constructor() {
    this.cache = new Map(); // key -> person (global)
    this.migrated = false;
  }

  #ensureMigrated() {
    if (this.migrated) return;
    this.migrated = true;
    try { fs.mkdirSync(PEOPLE_DIR, { recursive: true }); } catch { /* ignore */ }
    // people/ 已有正式数据 → 不再从旧按会话目录合并，避免重启把删掉的印象加回来
    let hasPeople = false;
    try {
      hasPeople = fs.readdirSync(PEOPLE_DIR).some((f) => f.endsWith('.json'));
    } catch { /* ignore */ }
    if (hasPeople) return;
    // 仅首次从旧目录并入
    try {
      const dirs = fs.readdirSync(MEMORY_DIR).filter((f) => {
        const p = path.join(MEMORY_DIR, f);
        try { return fs.statSync(p).isDirectory() && f !== 'people' && f !== 'backups'; } catch { return false; }
      });
      for (const d of dirs) {
        const m = /^(group|private)_(\d+)$/.exec(d);
        const chatKey = m ? `${m[1]}:${m[2]}` : null;
        const files = fs.readdirSync(path.join(MEMORY_DIR, d)).filter((f) => f.endsWith('.json') && f !== '_meta.json');
        for (const f of files) {
          const raw = readJson(path.join(MEMORY_DIR, d, f), null);
          if (!raw) continue;
          this.#appendRaw(chatKey || '', String(raw.userId ?? ''), String(raw.name ?? ''), {
            skipChatWrite: true
          }, (raw.impressions || []).map((e) => e.content).filter(Boolean), raw.updatedAt);
          const uid = String(raw.userId ?? '').trim();
          const key = uid || `_n_${f}`;
          const cached = this.cache.get(key);
          if (cached && raw.favor != null && Number.isFinite(Number(raw.favor))) {
            cached.favor = Math.min(100, Math.max(0, Math.round(Number(raw.favor))));
          }
        }
      }
    } catch { /* 目录不存在 */ }
  }

  #loadAll() {
    this.#ensureMigrated();
    try {
      const next = new Map();
      for (const f of fs.readdirSync(PEOPLE_DIR)) {
        if (!f.endsWith('.json')) continue;
        const raw = readJson(path.join(PEOPLE_DIR, f), null);
        if (!raw) continue;
        const userId = String(raw.userId || '');
        const key = userId || `_n_${f}`;
        next.set(key, {
          userId,
          name: String(raw.name || ''),
          chats: Array.isArray(raw.chats) ? raw.chats.map(String) : [],
          impressions: normImpressions(raw.impressions),
          surface: normSurface(raw.surface),
          favor: Number.isFinite(Number(raw.favor))
            ? Math.min(100, Math.max(0, Math.round(Number(raw.favor))))
            : 50,
          attitude: String(raw.attitude || '').trim().slice(0, 120),
          manuallyEditedAt: Number(raw.manuallyEditedAt) || 0,
          personLastActiveAt: Number(raw.personLastActiveAt) || 0,
          updatedAt: Number(raw.updatedAt) || 0,
          lastConsolidatedAt: Number(raw.lastConsolidatedAt) || 0
        });
      }
      // 同名双文件：有 QQ 号的为准。无号壳只删掉，绝不把壳里的旧印象并回来
      // （并回去 = 用户刚删的内容又复活）。
      const byName = new Map();
      for (const m of next.values()) {
        if (m.userId && /^\d{5,15}$/.test(m.userId) && m.name) {
          byName.set(String(m.name).trim(), m);
        }
      }
      for (const [key, m] of [...next.entries()]) {
        if (m.userId) continue;
        const target = byName.get(String(m.name || '').trim());
        if (!target) continue;
        // 正式文件更新更晚 → 壳是旧副本，直接丢弃
        // 正式文件更早或壳更新 → 仍以正式文件为准（用户 UI 编辑的是正式文件）
        next.delete(key);
        try { fs.rmSync(personFile('', m.name), { force: true }); } catch { /* ignore */ }
      }
      this.cache = next;
    } catch { /* 无目录 */ }
  }

  listChats() {
    this.#loadAll();
    const out = new Set();
    for (const p of this.cache.values()) {
      for (const c of p.chats || []) if (c) out.add(c);
    }
    // 兼容：旧会话目录还在也列出来
    try {
      for (const f of fs.readdirSync(MEMORY_DIR)) {
        if (fs.statSync(path.join(MEMORY_DIR, f)).isDirectory() && f !== 'people' && f !== 'backups') {
          const m = /^(group|private)_(\d+)$/.exec(f);
          if (m) out.add(`${m[1]}:${m[2]}`);
        }
      }
    } catch { /* ignore */ }
    return [...out];
  }

  #appendRaw(chatKey, userId, name, { skipChatWrite = false, type = '', pin = false } = {}, contents = [], updatedAt = 0) {
    this.#ensureMigrated();
    const key = personKey(userId, name);
    const person = this.cache.get(key) || loadPerson(userId, name);
    const now = Date.now();
    for (const content of contents) {
      const entry = normImpression(
        { content, type, pin, lastSeen: now, lastConfirmedAt: now, createdAt: now },
        now
      );
      if (!entry) continue;
      const existing = person.impressions.find((e) => e.content === entry.content);
      if (existing) {
        existing.lastSeen = now;
        existing.lastConfirmedAt = now;
        if (entry.pin) existing.pin = true;
        if (type && IMP_TYPES.includes(entry.type)) existing.type = entry.type;
      } else {
        person.impressions.push(entry);
      }
    }
    // ⚠️ 2026-09-22：这里原来是"只保留最近 12 条"—— 用户加了第 13 条，最老那条（可能正是
    //    他最在意的）就被默默丢掉，表现就是"印象加到一定条数就加不进去了"。
    //    现在**不设业务上限**：想记多少条就记多少条（注入端本来就只挑 2 条进提示词，
    //    条数多不会让提示词变长）。只留一道 60 条的**安全阀**防失控，且只丢"最旧且没钉住"的。
    trimImpressions(person);
    person.userId = String(userId || person.userId || '');
    person.name = String(name || person.name || '');
    if (person.favor == null) person.favor = 50;
    if (person.attitude == null) person.attitude = '';
    if (!person.surface || typeof person.surface !== 'object') person.surface = {};
    else pruneEntries(person.surface, now);
    if (chatKey) {
      person.chats = [...new Set([...(person.chats || []), String(chatKey)])].slice(-8);
    }
    person.updatedAt = Number(updatedAt) || now;
    writeJson(personFile(person.userId, person.name), person);
    this.cache.set(key, person);
    // ⚠️ 2026-09-22：印象写入以前**不写审计** —— 出"怎么不记印象了"这种问题时，
    //   查 data/memory-audit.jsonl 只能看到整理（consolidator）和手动编辑，
    //   看不到模型到底有没有调 memory_append，排查全靠扫会话文件。
    //   现在每次真正落盘的印象都记一笔（谁、哪条、什么类型、从哪来）。
    if (contents.length) {
      try {
        logMemoryChange({
          type: 'append',
          chatKey,
          userId: person.userId,
          name: person.name,
          source: 'append',
          added: contents.slice(0, 5).map((c) => normImpression({ content: c, type, pin, lastSeen: now, createdAt: now }, now)?.content).filter(Boolean)
        });
      } catch { /* 审计失败绝不影响记忆本身 */ }
    }
    return person;
  }

  /**
   * 表层记忆：从**这个人自己发的消息**里抓一条近况（零模型调用）。
   *
   * 只抓短句（3~60 字），洗掉 CQ 码/@/引用/链接后整句存；命中哪条规则就进哪个槽位，
   * 同槽位覆盖（body/mood/doing/wait/plan）。同一条文本重复出现只会"续期"，
   * 且续期有总寿命上限（见 half-life.js），所以不会因为反复刷同一句话而永久挂住。
   *
   * @returns {boolean} 是否记下了
   */
  captureSurface({ userId, name = '', text = '', now = Date.now(), chatKey = '' } = {}) {
    const uid = String(userId || '').trim().replace(/^-/, '');
    if (!/^\d{5,15}$/.test(uid)) return false;
    const clean = stripSurfaceNoise(text);
    // 2~60 字：短到「好累」「困了」也算近况（这正是要抓的），长文不是近况是讨论
    if (clean.length < 2 || clean.length > 60) return false;
    let hit = null;
    for (const [kind, re] of SURFACE_RULES) {
      if (re.test(clean)) { hit = kind; break; }
    }
    if (!hit) return false;
    this.#ensureMigrated();
    const key = personKey(uid, name);
    const person = this.cache.get(key) || loadPerson(uid, name);
    const surface = person.surface && typeof person.surface === 'object' ? person.surface : (person.surface = {});
    const entry = noteEntry(surface, hit, clean.slice(0, 40), {
      halfLifeMin: SURFACE_KINDS[hit].hl,
      now,
      capFactor: 1,       // 同文本最多活 3 个半衰期（≈1.5× 名义寿命）
      maxKeys: Object.keys(SURFACE_KINDS).length
    });
    if (!entry) return false;
    person.userId = uid;
    person.name = String(name || person.name || '');
    if (person.favor == null) person.favor = 50;
    if (person.attitude == null) person.attitude = '';
    if (chatKey) person.chats = [...new Set([...(person.chats || []), String(chatKey)])].slice(-8);
    person.updatedAt = Math.max(Number(person.updatedAt) || 0, now);
    try {
      writeJson(personFile(person.userId, person.name), person);
      this.cache.set(key, person);
    } catch { return false; }
    return true;
  }

  /** 某人当前还活着的表层记忆（按浓度排序，带粗年龄）。 */
  liveSurface(userId, now = Date.now()) {
    this.#loadAll();
    const m = this.cache.get(String(userId)) || null;
    if (!m?.surface) return [];
    return liveEntries(m.surface, now).map((e) => ({
      kind: e.key,
      cn: SURFACE_KINDS[e.key]?.cn || e.key,
      text: e.text,
      weight: e.weight,
      ageMin: Math.round(e.ageMin || 0),
      age: ageLabel(e.ageMin),
      at: e.at
    }));
  }

  /** 清掉某人的表层记忆（UI/调试用）；kind 省略则全清。 */
  clearSurface(userId, kind = '') {
    this.#loadAll();
    const key = String(userId);
    const m = this.cache.get(key);
    if (!m?.surface) return 0;
    const k = String(kind || '');
    if (k && m.surface[k]) { delete m.surface[k]; }
    else if (!k) { m.surface = {}; }
    else return 0;
    try { writeJson(personFile(m.userId, m.name), m); } catch { /* ignore */ }
    return 1;
  }

  /**
   * 墓碑：刚被手动删掉/改掉的**具体内容**，10 分钟内不许再写回来。
   *
   * 为什么改成这个（2026-09-22 用户反馈"要能随时增加印象"）：
   * 原来 append() 里是「这个人 10 分钟内被手动改过 → 一律拒写」——
   * 本意只是防"刚删完又写回"，代价却是**管理员在界面上补了一条印象之后，
   * 模型十分钟内一条新印象都记不进去**（看起来就是"印象满了/加不进去"）。
   * 现在只拦"刚被删掉的那条原文"，新内容随时可加。
   */
  #tombstones = new Map();   // userId -> Map(content -> at)

  #tombstone(uid, contents = []) {
    const key = String(uid || '').trim();
    if (!key) return;
    let m = this.#tombstones.get(key);
    if (!m) { m = new Map(); this.#tombstones.set(key, m); }
    const now = Date.now();
    for (const c of contents) {
      const t = String(c ?? '').trim().slice(0, 160);
      if (t) m.set(t, now);
    }
    // 顺手清理过期墓碑（同一个人最多留几十条，不占地方）
    for (const [t, at] of m) if (now - at > 10 * 60 * 1000) m.delete(t);
    if (this.#tombstones.size > 500) {
      for (const [k, v] of this.#tombstones) if (!v.size) this.#tombstones.delete(k);
    }
  }

  #tombstoned(uid, content) {
    const m = this.#tombstones.get(String(uid || '').trim());
    if (!m) return false;
    const t = String(content ?? '').trim().slice(0, 160);
    const at = m.get(t);
    if (!at) return false;
    if (Date.now() - at > 10 * 60 * 1000) { m.delete(t); return false; }
    return true;
  }

  /** 记一条全局印象（跨群共用）。chatKey 仅用于 UI 关联，不隔离存储。 */
  append(chatKey, category, content, extra = {}) {    if (category !== 'memberImpression') return null;
    let userId = String(extra.userId ?? '').trim().replace(/^-/, '');
    if (userId && !/^\d{5,15}$/.test(userId)) userId = '';
    // 长句不当名字（防止「今天吃什么？明天…」变成一个人）
    let target = String(extra.target ?? '').trim().slice(0, 40);
    if (!userId && target.length > 24) return null;
    if (!userId && !target) return null;
    // 只拦"刚被手动删掉的那一条"（10 分钟墓碑）—— 见 #tombstones 的说明。
    // 以前这里是"这个人 10 分钟内被手动改过就一律拒写"，等于管理员补一条印象后，
    // 模型十分钟内再想记什么都记不进去（用户反馈的"加不了印象"就有这一半）。
    if (userId && this.#tombstoned(userId, content)) {
      return { rejected: 'just-deleted', content: String(content ?? '').trim().slice(0, 160) };
    }
    const type = String(extra.type || '').trim().toLowerCase();
    const pin = !!extra.pin;
    const person = this.#appendRaw(chatKey, userId, target || userId, { type, pin }, [content]);
    const last = person.impressions.find((e) => e.content === String(content ?? '').trim().slice(0, 160))
      || person.impressions[person.impressions.length - 1];
    return last ? { ...last } : null;
  }

  /** 出现过这个人：抬 lastSeen，注入时更靠前。不改 content。 */
  bumpSeen(userIds = []) {
    const list = (Array.isArray(userIds) ? userIds : [userIds])
      .map((x) => String(x ?? '').trim())
      .filter((x) => /^\d{5,15}$/.test(x));
    if (!list.length) return 0;
    this.#loadAll();
    const now = Date.now();
    let n = 0;
    for (const uid of list) {
      const m = this.cache.get(uid);
      if (!m?.impressions?.length) continue;
      const before = Number(m.personLastActiveAt) || 0;
      if (now - before > 60 * 60 * 1000) {
        m.personLastActiveAt = now;
        m.updatedAt = now;
        try { writeJson(personFile(m.userId, m.name), m); } catch { /* ignore */ }
        n += 1;
      }
    }
    return n;
  }

  /** 单条设 pin / 类型 / 文本（后台小改，不整份覆盖）。 */
  setImpressionMeta(userId, content, { pin, type, nextContent } = {}) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    this.#loadAll();
    const m = this.cache.get(uid);
    if (!m) return null;
    const key = String(content ?? '');
    const e = m.impressions.find((x) => x.content === key);
    if (!e) return null;
    if (pin !== undefined) e.pin = !!pin;
    if (type && IMP_TYPES.includes(String(type))) e.type = String(type);
    if (nextContent != null) {
      const c = String(nextContent).trim().slice(0, 160);
      if (c && c !== e.content) {
        e.content = c;
        if (!type) e.type = guessImpressionType(c);
        e.lastConfirmedAt = Date.now();
      }
    }
    e.lastSeen = Date.now();
    m.updatedAt = Date.now();
    writeJson(personFile(m.userId, m.name), m);
    this.cache.set(uid, m);
    return { ...e };
  }

  /** 把「只有名字」的人并进同名有 QQ 的人；合并后删空壳。 */
  mergeNameOnlyIntoUserIds() {
    this.#loadAll();
    const byName = new Map();
    const byUid = new Map();
    for (const [key, m] of this.cache.entries()) {
      if (m.userId && /^\d{5,15}$/.test(String(m.userId)) && m.name) {
        byName.set(String(m.name).trim(), m);
        byUid.set(String(m.userId), m);
      }
    }
    // 壳的名字里常塞着 QQ 号（「示例昵称(QQ123456789)」是模型把号填进名字造成的）。
    // 取名字里最后一段 5~15 位数字，用它去认领真身；只有号确有正式记录时才并，不凭空派号。
    const extractUid = (name) => {
      const hits = String(name || '').match(/\d{5,15}/g);
      return hits ? String(hits[hits.length - 1]) : '';
    };
    let merged = 0;
    for (const [key, m] of [...this.cache.entries()]) {
      if (m.userId) continue;
      const target = byName.get(String(m.name || '').trim())
        || byUid.get(extractUid(m.name))
        || null;
      if (!target) continue;
      const seen = new Set(target.impressions.map((e) => e.content));
      for (const e of m.impressions) {
        if (seen.has(e.content)) continue;
        target.impressions.push({ ...e });
        seen.add(e.content);
      }
      trimImpressions(target);
      target.updatedAt = Math.max(Number(target.updatedAt) || 0, Number(m.updatedAt) || 0);
      if (m.chats?.length) {
        target.chats = [...new Set([...(target.chats || []), ...m.chats])].slice(-8);
      }
      writeJson(personFile(target.userId, target.name), target);
      this.cache.set(target.userId, target);
      this.cache.delete(key);
      try { fs.rmSync(personFile('', m.name), { force: true }); } catch { /* ignore */ }
      merged += 1;
    }
    return merged;
  }

  /**
   * 同一 QQ 号落在多个文件时，合并进规范文件 `<QQ>.json` 并删掉多余副本。
   * people/ 里一人一文件是常态；异常副本（手拷/旧迁移/同 userId 不同文件名）会在这里收敛。
   */
  mergeSameUserIds() {
    this.#ensureMigrated();
    let merged = 0;
    try {
      const files = fs.readdirSync(PEOPLE_DIR).filter((f) => f.endsWith('.json'));
      const byUid = new Map();
      for (const f of files) {
        const raw = readJson(path.join(PEOPLE_DIR, f), null);
        if (!raw) continue;
        const uid = String(raw.userId || '').trim();
        if (!/^\d{5,15}$/.test(uid)) continue;
        if (!byUid.has(uid)) byUid.set(uid, []);
        byUid.get(uid).push({ file: f, raw });
      }
      for (const [uid, list] of byUid.entries()) {
        const canonicalName = `${uid}.json`;
        if (list.length === 1 && list[0].file === canonicalName) continue;
        // 以 updatedAt 最新的那份为底，再把其它文件并进来
        const sorted = list.slice().sort((a, b) => (Number(b.raw.updatedAt) || 0) - (Number(a.raw.updatedAt) || 0));
        const baseRaw = sorted[0].raw;
        const person = {
          userId: uid,
          name: String(baseRaw.name || sorted.find((x) => x.raw.name)?.raw?.name || ''),
          chats: [],
          impressions: normImpressions(baseRaw.impressions),
          favor: Number.isFinite(Number(baseRaw.favor))
            ? Math.min(100, Math.max(0, Math.round(Number(baseRaw.favor))))
            : 50,
          attitude: String(baseRaw.attitude || '').trim().slice(0, 120),
          manuallyEditedAt: Number(baseRaw.manuallyEditedAt) || 0,
          personLastActiveAt: Number(baseRaw.personLastActiveAt) || 0,
          updatedAt: Number(baseRaw.updatedAt) || 0,
          lastConsolidatedAt: Number(baseRaw.lastConsolidatedAt) || 0
        };
        for (const { raw } of sorted.slice(1)) {
          if (!person.name && raw.name) person.name = String(raw.name);
          for (const c of (Array.isArray(raw.chats) ? raw.chats.map(String) : [])) {
            if (c) person.chats.push(c);
          }
          for (const e of normImpressions(raw.impressions)) {
            const hit = person.impressions.find((x) => x.content === e.content);
            if (hit) {
              hit.pin = hit.pin || e.pin;
              mergeImpressionTimestamps(hit, e);
              if (IMP_TYPES.includes(e.type)) hit.type = e.type;
            } else {
              person.impressions.push(e);
            }
          }
          if (Number.isFinite(Number(raw.favor))) {
            const fav = Math.min(100, Math.max(0, Math.round(Number(raw.favor))));
            // 有手动编辑过的一份优先；否则取离 50 更远的（更有信息量）
            if (Number(raw.manuallyEditedAt) || Math.abs(fav - 50) > Math.abs(person.favor - 50)) person.favor = fav;
            if (Number(raw.manuallyEditedAt) > person.manuallyEditedAt) person.manuallyEditedAt = Number(raw.manuallyEditedAt);
          }
          const att = String(raw.attitude || '').trim();
          if (att && (!person.attitude || Number(raw.manuallyEditedAt) > Number(person.manuallyEditedAt || 0))) {
            person.attitude = att.slice(0, 120);
          }
          person.updatedAt = Math.max(person.updatedAt, Number(raw.updatedAt) || 0);
          person.lastConsolidatedAt = Math.max(person.lastConsolidatedAt, Number(raw.lastConsolidatedAt) || 0);
        }
        person.impressions = normImpressions(person.impressions);
        trimImpressions(person);
        person.chats = [...new Set(person.chats)].slice(-8);
        writeJson(personFile(uid, person.name), person);
        for (const { file } of list) {
          if (file === canonicalName) continue;
          try { fs.rmSync(path.join(PEOPLE_DIR, file), { force: true }); } catch { /* ignore */ }
        }
        this.cache.set(uid, person);
        merged += 1;
      }
    } catch { /* 目录不存在 */ }
    return merged;
  }

  /** 清掉无有效身份且名字像句子的垃圾人。 */
  purgeBadPeople() {
    this.#loadAll();
    let removed = 0;
    for (const [key, m] of [...this.cache.entries()]) {
      const uid = String(m.userId || '');
      const name = String(m.name || '');
      const looksLikeSentence = name.length >= 14 && /[？?。！!，,、]/.test(name);
      const looksLikeJunk = !uid && (looksLikeSentence || name.length > 40);
      if (looksLikeJunk) {
        this.cache.delete(key);
        try { fs.rmSync(personFile('', name), { force: true }); } catch { /* ignore */ }
        removed += 1;
      }
    }
    return removed;
  }

  /** 合并同一人里几乎重复的印象句（去标点空白后相同或互为包含且够长）。 */
  dedupeImpressions() {
    this.#loadAll();
    let removed = 0;
    const norm = (s) => String(s || '').toLowerCase()
      .replace(/[\s\p{P}\p{S}]+/gu, '');
    for (const [key, m] of this.cache.entries()) {
      const seen = new Map();
      const next = [];
      for (const e of m.impressions) {
        const n = norm(e.content);
        if (!n) continue;
        const dupKey = [...seen.keys()].find((x) => x === n
          || (n.length >= 8 && x.includes(n))
          || (x.length >= 8 && n.includes(x)));
        if (dupKey) {
          mergeImpressionTimestamps(seen.get(dupKey), e);
          removed += 1;
          continue;
        }
        seen.set(n, e);
        next.push(e);
      }
      if (next.length !== m.impressions.length) {
        m.impressions = next;
        m.updatedAt = Date.now();
        writeJson(personFile(m.userId, m.name), m);
        this.cache.set(key, m);
      }
    }
    return removed;
  }

  /** 语义去重：字面相近但没被字符串规则合并的印象，交给本地 Jev 判「是不是同一件事」。
   *  只在二字组 Jaccard 落在中间带才问（几乎相同早被 dedupeImpressions 收掉、
   *  完全无关问了也白问），把 O(n²) 的问询压到个位数。
   *  判错只是少合并一条（保守方向），不会丢已有内容。 */
  async dedupeImpressionsSemantic({ maxAsk = 120 } = {}) {
    const { localJevHasRole, jevGate } = await import('./local-jev.js');
    if (!localJevHasRole('impressionDupeGate')) return 0;
    this.#loadAll();
    let removed = 0, asked = 0;
    const bigrams = (s) => {
      const t = String(s || '').replace(/[\s\p{P}\p{S}]+/gu, '');
      const g = new Set();
      for (let i = 0; i < t.length - 1; i++) g.add(t.slice(i, i + 2));
      return g;
    };
    for (const [key, m] of this.cache.entries()) {
      if (asked >= maxAsk) break;
      const list = m.impressions || [];
      if (list.length < 2) continue;
      const grams = list.map((e) => bigrams(e.content));
      const drop = new Set();
      for (let i = 0; i < list.length && asked < maxAsk; i++) {
        if (drop.has(i)) continue;
        for (let j = i + 1; j < list.length && asked < maxAsk; j++) {
          if (drop.has(j)) continue;
          const a = grams[i], b = grams[j];
          if (!a.size || !b.size) continue;
          let inter = 0;
          for (const x of a) if (b.has(x)) inter++;
          const sim = inter / (a.size + b.size - inter);
          if (sim < 0.22 || sim >= 0.8) continue;
          asked++;
          const r = await jevGate('impressionDupeGate',
            `甲：${String(list[i].content).slice(0, 70)} ｜ 乙：${String(list[j].content).slice(0, 70)}`,
            { timeoutMs: 2500 }).catch(() => null);
          if (!r || r.error || r.abstain || r.label !== 'YES') continue;
          // 保留更老的那条（信息更完整），只继承已有时间，不凭空刷新确认时间
          const keep = (Number(list[i].createdAt) || 0) <= (Number(list[j].createdAt) || 0) ? i : j;
          const gone = keep === i ? j : i;
          mergeImpressionTimestamps(list[keep], list[gone]);
          drop.add(gone);
          removed++;
          logMemoryChange({ type: 'impression-dupe', chatKey: key, userId: m.userId, kept: list[keep].content, dropped: list[gone].content });
        }
      }
      if (drop.size) {
        m.impressions = list.filter((_, idx) => !drop.has(idx));
        m.updatedAt = Date.now();
        writeJson(personFile(m.userId, m.name), m);
        this.cache.set(key, m);
      }
    }
    return removed;
  }

  /** 把「正则猜出来」的印象类型升级成真分类（本地 Jev 6 选 1，只补不覆盖）。
   *  模型/人工给过 type 的不动；Jev 弃权也不动 —— 宁可保持正则结果。 */
  async refineImpressionTypes({ maxAsk = 200 } = {}) {
    const { localJevHasRole, jevGate } = await import('./local-jev.js');
    if (!localJevHasRole('impressionTypeGate')) return 0;
    this.#loadAll();
    let refined = 0, asked = 0;
    for (const [key, m] of this.cache.entries()) {
      if (asked >= maxAsk) break;
      let changed = false;
      for (const e of m.impressions || []) {
        if (asked >= maxAsk) break;
        if (!e || e.typeGuess !== true) continue;
        asked++;
        const r = await jevGate('impressionTypeGate', String(e.content).slice(0, 160), { timeoutMs: 2500 }).catch(() => null);
        if (!r || r.error || r.abstain || !r.label) continue;
        if (!IMP_TYPES.includes(r.label) || r.label === e.type) { e.typeGuess = false; changed = true; continue; }
        e.type = r.label;
        e.typeGuess = false;
        changed = true;
        refined++;
        logMemoryChange({ type: 'impression-type', chatKey: key, userId: m.userId, content: e.content, type: e.type });
      }
      if (changed) {
        m.updatedAt = Date.now();
        writeJson(personFile(m.userId, m.name), m);
        this.cache.set(key, m);
      }
    }
    return refined;
  }

  /**
   * 清掉烂掉的表层记忆（半衰到没意义的槽位）。
   * 顺手删"只剩空壳"的人：没有印象、没有态度、好感中性、近况也空 —— 这种文件是
   * 表层记忆抓取顺手创建的（刷屏群里谁说了句"我好累"就会建一个），不清会越积越多，
   * 而 #loadAll 每次都要把 people/ 全读一遍。
   */
  pruneSurface(now = Date.now()) {
    this.#loadAll();
    let entriesRemoved = 0;
    let filesRemoved = 0;
    for (const [key, m] of [...this.cache.entries()]) {
      if (!m.surface || typeof m.surface !== 'object') continue;
      const removed = pruneEntries(m.surface, now);
      entriesRemoved += removed;
      const emptyShell = !m.impressions.length
        && !String(m.attitude || '').trim()
        && Number(m.favor ?? 50) === 50
        && !Object.keys(m.surface).length;
      try {
        if (emptyShell) {
          this.cache.delete(key);
          fs.rmSync(personFile(m.userId, m.name), { force: true });
          filesRemoved += 1;
        } else if (removed) {
          writeJson(personFile(m.userId, m.name), m);
        }
      } catch { /* ignore */ }
    }
    return { entriesRemoved, filesRemoved };
  }

  /** 一键清理：同 QQ 合并 + 同名合并 + 垃圾人 + 近重复印象 + 本地模型收尾。 */
  async cleanupAll() {
    const mergedQq = this.mergeSameUserIds();
    const merged = this.mergeNameOnlyIntoUserIds() + mergedQq;
    const purged = this.purgeBadPeople();
    const deduped = this.dedupeImpressions();
    const surface = this.pruneSurface();
    // 本地 0.8B 能搭把手的两件事：语义去重 + 升级正则猜的类型。
    // 全包在 try 里 —— Jev 没开/起不来时清理照样完成，只是少做这两步。
    let semanticMerged = 0, typesRefined = 0;
    try { semanticMerged = await this.dedupeImpressionsSemantic(); } catch { /* ignore */ }
    try { typesRefined = await this.refineImpressionTypes(); } catch { /* ignore */ }
    return { merged, mergedQq, purged, deduped, semanticMerged, typesRefined, surfacePruned: surface.entriesRemoved, surfaceFiles: surface.filesRemoved };
  }

  /**
   * 读印象（全局按人）。
   * @param {string} [chatKey] 会话键（当前实现里不过滤：印象库是全局按人的）
   * @param {string} [category] 只支持 memberImpression
   * @param {string|string[]} [topic] 传了就按话题挑：只回跟这个词沾边的条目，
   *   按相关度排序 —— 「想知道他推歌口味」时比把全库倒出来有用得多（实测模型查不到
   *   音乐口味时只能 memory_search 翻旧聊天，捞回一堆"我喜欢你"）。
   */
  #markImpressionsRetrieved(rows, now = Date.now()) {
    const dirty = new Set();
    for (const { person, entry } of rows) {
      if (!person || !entry) continue;
      entry.lastRetrievedAt = now;
      dirty.add(person);
    }
    for (const person of dirty) {
      try { writeJson(personFile(person.userId, person.name), person); } catch { /* 读取标记失败不影响返回 */ }
    }
  }

  query(chatKey, category = '', topic = '', { userId = '' } = {}) {
    if (category && category !== 'memberImpression') return { [category]: [] };
    this.#loadAll();
    const topicSets = topic ? topicTokenSets(topic) : [];
    const uid = String(userId || '').trim();
    const rows = [];
    for (const m of this.cache.values()) {
      if (uid && String(m.userId || '') !== uid) continue;
      // 全局库：当前会话相关 + 曾在本会话出现过的人都算
      const inChat = !chatKey || (m.chats || []).includes(String(chatKey)) || true;
      if (!inChat) continue;
      for (const e of m.impressions) {
        const rel = topicSets.length ? topicOverlap(e.content, topicSets) : 0;
        // 0.5 的地板：一个字撞上不算沾边（「量子力学」不该把"…大学毕业生"捞出来）
        if (topicSets.length && rel < 0.5) continue;
        rows.push({
          person: m,
          entry: e,
          row: {
            userId: String(m.userId || ''),
            target: String(m.name || m.userId || '某人'),
            content: e.content,
            createdAt: e.createdAt,
            ...(topicSets.length ? { rel } : {})
          }
        });
      }
    }
    if (topicSets.length) {
      rows.sort((a, b) => (b.row.rel || 0) - (a.row.rel || 0)
        || impressionFactTime(b.entry) - impressionFactTime(a.entry));
      // 有"真沾边"的就别掺只有单字巧合的（rel 0.3 = 一个字撞上，纯噪音）
      if (rows.some((x) => (x.row.rel || 0) >= 1)) {
        const picked = rows.filter((x) => (x.row.rel || 0) >= 1);
        this.#markImpressionsRetrieved(picked);
        return { memberImpression: picked.map((x) => x.row) };
      }
    } else {
      rows.sort((a, b) => impressionFactTime(b.entry) - impressionFactTime(a.entry));
    }
    this.#markImpressionsRetrieved(rows);
    return { memberImpression: rows.map((x) => x.row) };
  }

  /** 全局成员（记忆管理页可按会话过滤 chats）。 */
  members(chatKey) {
    this.#loadAll();
    const now = Date.now();
    const list = [];
    for (const m of this.cache.values()) {
      // 没印象但有近况的人也列出来（刚开口的陌生人正是表层记忆的用武之地）
      if (!m.impressions.length && !liveEntries(m.surface || {}, now).length) continue;
      if (chatKey && Array.isArray(m.chats) && m.chats.length && !m.chats.includes(String(chatKey))) {
        // 有 chats 标记且不含当前会话时跳过；无标记的全局人仍显示
        continue;
      }
      list.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || '某人'),
        impressions: m.impressions.map((e) => ({ ...e })),
        surface: liveEntries(m.surface || {}, now).map((e) => ({
          kind: e.key, cn: SURFACE_KINDS[e.key]?.cn || e.key, text: e.text,
          weight: e.weight, ageMin: Math.round(e.ageMin || 0), age: ageLabel(e.ageMin)
        })),
        favor: Number(m.favor ?? 50),
        attitude: String(m.attitude || ''),
        personLastActiveAt: Number(m.personLastActiveAt) || 0,
        updatedAt: m.updatedAt,
        lastConsolidatedAt: m.lastConsolidatedAt
      });
    }
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    return list;
  }

  /** 所有人（跨群列表，供管理/工具）。 */
  allMembers() {
    this.#loadAll();
    const now = Date.now();
    return [...this.cache.values()]
      .filter((m) => m.impressions.length)
      .map((m) => {
        const freshest = Number(m.personLastActiveAt) || Number(m.updatedAt) || 0;
        const ageDays = freshest ? Math.round((now - freshest) / 86400000 * 10) / 10 : 99;
        return {
          userId: String(m.userId || ''),
          name: String(m.name || m.userId || '某人'),
          impressions: m.impressions.map((e) => ({ ...e })),
          // chats：这个人出现在哪些会话（UI 的「整理此人印象」要靠它挑一个会话去读聊天记录）
          chats: (m.chats || []).map(String),
          favor: Number(m.favor ?? 50),
          attitude: String(m.attitude || ''),
          personLastActiveAt: Number(m.personLastActiveAt) || 0,
          updatedAt: m.updatedAt,
          lastConsolidatedAt: m.lastConsolidatedAt,
          ageDays,
          stale: ageDays > 30
        };
      })
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  getMember(chatKey, userId) {
    this.#loadAll();
    const m = this.cache.get(String(userId)) || loadPerson(String(userId));
    const now = Date.now();
    return {
      userId: String(m.userId || userId || ''),
      name: String(m.name || ''),
      impressions: (m.impressions || []).map((e) => ({ ...e })),
      surface: liveEntries(m.surface || {}, now).map((e) => ({
        kind: e.key, cn: SURFACE_KINDS[e.key]?.cn || e.key, text: e.text,
        weight: e.weight, ageMin: Math.round(e.ageMin || 0), age: ageLabel(e.ageMin)
      })),
      favor: Number(m.favor ?? 50),
      attitude: String(m.attitude || ''),
      personLastActiveAt: Number(m.personLastActiveAt) || 0,
      updatedAt: Number(m.updatedAt) || 0
    };
  }

  /** 设置好感度 0~100（50=中性）。影响群聊随机档与语气提示。 */
  setFavor(userId, favor, { source = 'manual', reason = '' } = {}) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    this.#loadAll();
    const person = this.cache.get(uid) || loadPerson(uid);
    let v = Number(favor);
    if (!Number.isFinite(v)) v = 50;
    v = Math.min(100, Math.max(0, Math.round(v)));
    const from = Number(person.favor ?? 50);
    person.favor = v;
    person.updatedAt = Date.now();
    person.userId = uid;
    writeJson(personFile(person.userId, person.name), person);
    this.cache.set(uid, person);
    if (from !== v) {
      logMemoryChange({
        type: 'favor',
        userId: uid,
        from,
        to: v,
        delta: v - from,
        source,
        reason: String(reason || '').slice(0, 60)
      });
    }
    return { userId: uid, favor: v };
  }

  /** userId → favor（默认 50）。 */
  favorMap() {
    this.#loadAll();
    const map = new Map();
    for (const m of this.cache.values()) {
      if (m.userId && /^\d{1,15}$/.test(String(m.userId))) {
        map.set(String(m.userId), Number(m.favor ?? 50));
      }
    }
    return map;
  }

  /** 手动编辑后窗口内返回 true，自动整理应跳过（含刚清空印象的人）。 */
  isManuallyEdited(userId, windowMs = 24 * 3600 * 1000) {
    this.#loadAll();
    const m = this.cache.get(String(userId ?? '').trim());
    const t = Number(m?.manuallyEditedAt || 0);
    return t > 0 && Date.now() - t < windowMs;
  }

  editMemberImpression(chatKey, { userId, name = '', note = '', impressions = [], favor = null, attitude = undefined }) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    this.#loadAll();
    const old = this.cache.get(uid) || loadPerson(uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const list = Array.isArray(impressions) ? impressions : [impressions];
    const now = Date.now();
    const entries = normImpressions(
      list
        .map((s) => (s && typeof s === 'object'
          ? { ...s, createdAt: Number(s.createdAt) || now }
          : { content: String(s ?? '').trim(), createdAt: now, lastSeen: now, lastConfirmedAt: now }))
        .slice(0, MAX_IMPRESSIONS)
    );
    // 被这次编辑删掉的内容进墓碑：模型 10 分钟内别把管理员刚删的那条又写回来
    // （但仍然可以记**别的**新内容 —— 这正是"随时能加印象"要的效果）
    {
      const keptSet = new Set(entries.map((e) => String(e.content || '')));
      this.#tombstone(uid, (old.impressions || []).map((e) => e.content).filter((c) => !keptSet.has(String(c || ''))));
    }
    const person = {
      userId: uid,
      name: finalName,
      chats: old.chats || (chatKey ? [String(chatKey)] : []),
      impressions: entries,
      favor: Number.isFinite(Number(favor)) ? Math.min(100, Math.max(0, Math.round(Number(favor)))) : Number(old.favor ?? 50),
      attitude: attitude === undefined
        ? String(old.attitude || '')
        : String(attitude ?? '').trim().slice(0, 120),
      personLastActiveAt: Number(old.personLastActiveAt) || 0,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0,
      // 手动改过的：24h 内自动整理不要覆盖，否则「删了又写回」
      manuallyEditedAt: now
    };
    writeJson(personFile(uid, finalName), person);
    this.cache.set(uid, person);
    // 同名无 QQ 壳文件一并删掉，防止列表里还挂着旧印象
    this.#dropNameOnlyShell(finalName);
    logMemoryChange({
      type: 'edit',
      userId: uid,
      source: 'manual',
      impressions: entries.length,
      favor: person.favor,
      note: String(note ?? '').trim().slice(0, 40)
    });
    if (note !== undefined && note !== null) {
      const notes = { ...(getConfig().memberNotes || {}) };
      const n = String(note ?? '').trim();
      if (n) notes[uid] = n;
      else delete notes[uid];
      updateConfig({ memberNotes: notes });
    }
    return {
      userId: person.userId,
      name: person.name,
      impressions: person.impressions.map((e) => ({ ...e })),
      favor: person.favor,
      attitude: person.attitude || '',
      updatedAt: person.updatedAt,
      note: String(note ?? '').trim()
    };
  }

  /** 删掉「只有名字、没有 QQ 号」的同名壳文件（保留 uid 指向的正式文件）。 */
  #dropNameOnlyShell(name) {
    const target = String(name || '').trim();
    if (!target) return;
    for (const [key, m] of [...this.cache.entries()]) {
      if (m.userId) continue;
      if (String(m.name || '').trim() !== target) continue;
      this.cache.delete(key);
      try { fs.rmSync(personFile('', m.name), { force: true }); } catch { /* ignore */ }
    }
    try {
      const p = path.join(PEOPLE_DIR, personFileName('', target));
      if (fs.existsSync(p)) fs.rmSync(p, { force: true });
    } catch { /* ignore */ }
  }

  replaceMember(chatKey, userId, name, contents, { markManual = false } = {}) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) throw new Error('userId 必须是数字 QQ 号');
    this.#loadAll();
    // 手动改过的人：整理路径禁止整份覆盖（防「删完又写回」）
    if (this.isManuallyEdited(uid)) {
      return this.cache.get(uid) || loadPerson(uid, name);
    }
    const old = this.cache.get(uid) || loadPerson(uid, name);
    const finalName = String(name ?? '').trim().slice(0, 60) || String(old.name || '').trim() || uid;
    const now = Date.now();
    const prev = new Map((old.impressions || []).map((e) => [e.content, e]));
    const entries = normImpressions(
      (Array.isArray(contents) ? contents : [contents])
        .map((s) => String(s ?? '').trim())
        .filter(Boolean)
        .slice(0, MAX_IMPRESSIONS)
        .map((content) => {
          const keep = prev.get(content.slice(0, 160));
          return keep ? { ...keep } : { content, createdAt: now };
        })
    );
    const person = {
      userId: uid,
      name: finalName,
      chats: old.chats || (chatKey ? [String(chatKey)] : []),
      impressions: entries,
      favor: Number.isFinite(Number(old.favor)) ? old.favor : 50,
      attitude: String(old.attitude || '').trim().slice(0, 120),
      personLastActiveAt: Number(old.personLastActiveAt) || 0,
      updatedAt: now,
      lastConsolidatedAt: old.lastConsolidatedAt || 0,
      // 整理结果默认不标「手动编辑」，否则一次自动整理会锁住后续 24h
      manuallyEditedAt: markManual ? now : Number(old.manuallyEditedAt || 0)
    };
    // 整理写回前备份原文件（data/memory/backups/<会话>/<QQ>.json）；失败不阻塞整理
    if (chatKey) {
      try {
        const src = personFile(uid, finalName);
        if (fs.existsSync(src)) {
          const backupDir = path.join(MEMORY_DIR, 'backups', chatDirName(chatKey));
          fs.mkdirSync(backupDir, { recursive: true });
          fs.copyFileSync(src, path.join(backupDir, path.basename(src)));
        }
      } catch { /* 备份失败不阻塞整理 */ }
    }
    writeJson(personFile(uid, finalName), person);
    this.cache.set(uid, person);
    this.#dropNameOnlyShell(finalName);
    logMemoryChange({
      type: 'replace',
      userId: uid,
      source: markManual ? 'manual' : 'consolidator',
      impressions: entries.length
    });
    return person;
  }

  removeMember(chatKey, userId) {
    const uid = String(userId ?? '').trim();
    if (!/^\d{1,15}$/.test(uid)) return false;
    this.#loadAll();
    const m = this.cache.get(uid);
    this.cache.delete(uid);
    try { fs.rmSync(personFile(uid, m?.name || ''), { force: true }); } catch { /* ignore */ }
    if (m?.name) this.#dropNameOnlyShell(m.name);
    return true;
  }

  /** 删除「只有名字、没有 QQ 号」的壳记录（管理页里没 QQ 号、数字路由删不掉的那些）。
   *  只动 userId 为空的人，精确匹配名字，绝不碰有 QQ 号的正式记录。 */
  removeNameOnlyMember(name) {
    const target = String(name || '').trim();
    if (!target) return false;
    this.#loadAll();
    let removed = false;
    for (const [key, m] of [...this.cache.entries()]) {
      if (m.userId) continue;
      if (String(m.name || '').trim() !== target) continue;
      this.cache.delete(key);
      try { fs.rmSync(personFile('', m.name), { force: true }); } catch { /* ignore */ }
      logMemoryChange({ type: 'remove', userId: '', source: 'manual', name: target });
      removed = true;
    }
    return removed;
  }

  remove(chatKey, category, { userId = '', target = '', content = '' } = {}) {
    if (category !== 'memberImpression') return false;
    this.#loadAll();
    let removed = false;
    for (const [key, m] of [...this.cache.entries()]) {
      const matchUser = userId && String(m.userId) === String(userId);
      const matchName = target && String(m.name || m.userId) === String(target).trim();
      if (!matchUser && !matchName) continue;
      if (content) {
        const before = m.impressions.length;
        m.impressions = m.impressions.filter((e) => e.content !== content);
        if (m.impressions.length !== before) this.#tombstone(m.userId, [content]);
        removed = removed || m.impressions.length !== before;
      } else {
        removed = true;
        // 整份清空：全部进墓碑，免得模型马上又把这些写回来
        this.#tombstone(m.userId, m.impressions.map((e) => e.content));
        m.impressions = [];
      }
      if (!m.impressions.length) {
        this.cache.delete(key);
        try { fs.rmSync(personFile(m.userId, m.name), { force: true }); } catch { /* ignore */ }
      } else {
        m.updatedAt = Date.now();
        writeJson(personFile(m.userId, m.name), m);
      }
    }
    return removed;
  }

  clear(chatKey) {
    // 全局库：clear 不再按群清空，避免误删跨群记忆。
    // 管理端请用 removeMember / remove。
    return false;
  }

  /**
   * 【对群友的印象】+ 好感度语气提示。
   * 只注入当前上下文相关的人；偏好/雷点尽量完整（歌单口味这类别截半句）。
   * @param {{topic?: string, picks?: Map<string,string[]>}} [opts]
   *   topic = 这轮触发文本（按话题相关度挑条目）；
   *   picks = topicPicks() 的 Jev 补选结果（userId → 必须占名额的条目内容）。
   */
  formatForPrompt(chatKey, { userIds = null, topic = '', picks = null, maxPeople = 4, maxEach = 2, maxChars = 380, maxSurface = 2, now = Date.now() } = {}) {
    const notes = getConfig().memberNotes || {};
    this.#loadAll();
    const retrieved = [];
    const filter = userIds ? new Set([...userIds].map(String)) : null;
    // 候选 = 有长期印象的人 **或** 有还活着的表层记忆的人。
    // ⚠️ 不能只用 allMembers()：它过滤掉"没有印象"的人，而刚说过「今天好累」的陌生人
    //    通常还没攒下印象 —— 那正是表层记忆最该起作用的时候。
    let people = [...this.cache.values()]
      .filter((m) => (m.impressions?.length || liveEntries(m.surface || {}, now).length))
      .sort((a, b) => (Number(b.updatedAt) || 0) - (Number(a.updatedAt) || 0));
    if (filter) {
      people = people.filter((m) => m.userId && filter.has(String(m.userId)));
    }
    if (!people.length) return '';
    people = people.slice(0, Math.max(1, maxPeople));
    const topicSets = topicTokenSets(topic);
    const parts = [];
    const favorHints = [];
    const surfaceWrites = [];
    for (const m of people) {
      // 认人以 QQ 为准：显示「名字(QQ号)」或裸 QQ，别光给可改昵称
      const uid = String(m.userId || '').trim();
      const nm = notes[uid] || m.name || '';
      const who = uid
        ? (nm && nm !== uid ? `${nm}(QQ${uid})` : `QQ${uid}`)
        : (nm || '未知');
      // pin > 话题相关 > 新鲜 > 类型；preference/edge 优先（推歌、雷点不能被挤掉）
      const ranked = rankImpressions(m, topicSets, now);
      // Jev 捞上来的落榜条目（字面不重合但语义相关）先占名额，其余按名次补
      const forced = new Set((picks && typeof picks.get === 'function' ? picks.get(uid) : null) || []);
      const ordered = forced.size
        ? [...ranked.filter((x) => forced.has(String(x.e.content))), ...ranked.filter((x) => !forced.has(String(x.e.content)))]
        : ranked;
      const chosen = ordered.slice(0, Math.max(1, maxEach));
      retrieved.push(...chosen.map((x) => ({ person: m, entry: x.e })));
      const lines = chosen.map((x) => {
        const tag = x.e.pin ? '★' : (IMP_TYPE_LABEL[x.e.type] ? `[${IMP_TYPE_LABEL[x.e.type]}]` : '');
        // 偏好/身份给更长；事件默认 90 字，别把「推歌三类」砍半
        const limit = (x.e.type === 'preference' || x.e.type === 'identity' || x.e.pin) ? 140 : 90;
        const body = String(x.e.content).slice(0, limit);
        return tag ? `${tag}${body}` : body;
      });
      // ── 表层记忆（近况）：按浓度取最新的几条，带粗年龄 ──
      // 已经递过 3 次以上且淡到一半以下的就不再重复（否则它每轮都拿同一句"你还在改插件啊"）
      const surface = liveEntries(m.surface || {}, now)
        .filter((e) => !(e.shown >= 3 && e.weight < 0.5))
        .slice(0, Math.max(0, maxSurface));
      let surfaceText = '';
      if (surface.length) {
        surfaceText = surface
          .map((e) => {
            const age = ageLabel(e.ageMin);
            return age ? `${e.text}（${age}）` : e.text;
          })
          .join('、');
        surfaceWrites.push({ m, kinds: surface.map((e) => e.key) });
      }
      const favor = Number(m.favor ?? 50);
      const attitude = String(m.attitude || '').trim();
      const favTag = favorFavTag(favor);
      const tail = surfaceText ? `${lines.length ? ' ' : ''}近况：${surfaceText}` : '';
      if (lines.length) {
        const freshest = Math.max(0, ...m.impressions.map((e) => impressionFactTime(e)));
        const ageDays = freshest ? Math.max(0, (now - freshest) / 86400000) : 30;
        const oldMark = ageDays > 30 ? '[旧]' : '';
        parts.push(`${who}${oldMark}${favTag ? `[${favTag}]` : ''}: ${lines.join(' / ')}${tail}`);
      } else if (surfaceText) {
        // 只有近况、还没攒下印象的人（新面孔/刚开口的）
        parts.push(`${who}${favTag ? `[${favTag}]` : ''}: 近况：${surfaceText}`);
      } else if (favTag) {
        parts.push(`${who}[${favTag}]`);
      }
      // 管理员写的「态度」优先；没写再按好感档位提示
      if (attitude) {
        favorHints.push(`对${who}：${attitude}`);
      } else {
        const hint = favorToneHint(who, favor);
        if (hint) favorHints.push(hint);
      }
    }
    if (!parts.length && !favorHints.length) return '';
    // 递过的近况记一笔（下次不再重复同一句）；失败不影响注入
    for (const { m, kinds } of surfaceWrites) {
      try {
        for (const k of kinds) {
          if (m.surface?.[k]) m.surface[k].shown = (Number(m.surface[k].shown) || 0) + 1;
        }
        writeJson(personFile(m.userId, m.name), m);
      } catch { /* ignore */ }
    }
    this.#markImpressionsRetrieved(retrieved, now);
    let text = parts.join('; ');
    const hintLine = favorHints.length ? `（态度）${favorHints.join('；')}` : '';
    // ⚠️ 2026-09-21：态度行原来挂在 maxChars **之外**，于是"520 字上限"实测能到 600+，
    // 而这整块排在缓存断点之后 = 每轮按原价重算。现在把态度行算进同一个预算。
    const budget = Math.max(80, Number(maxChars) - (hintLine ? hintLine.length + 1 : 0));
    if (text.length > budget) text = text.slice(0, Math.max(0, budget - 1)) + '…';
    return `【印象】${text}${hintLine ? `\n${hintLine}` : ''}`;
  }

  /**
   * 话题相关的印象补选（本地 Jev，异步；**默认关闭**）。
   *
   * 只做一件小事：某人有超过名额的印象时，把**排在下一位、马上要被丢掉**的那条，
   * 拿当前这句话问一次本地小模型"有关吗" —— 有关就让 formatForPrompt 把它换进名额。
   * 逐个候选人一次调用、并发跑、有上限（默认最多 3 个），弃权/超时/没开角色都保持原样。
   *
   * ⚠️ 2026-09-21 实测（30 条真数据 + 人工期望，见下方数字）：0.8B 在这道题上只有 **20/30**，
   *    而且错的方向是"过度 YES"（把音乐口味、高达模型判成跟"今天好累""睡了明天见"有关）。
   *    所以它**不进默认角色表**：字面重合的部分由 rankImpressions 免费做掉（推歌那条就是这么
   *    捞回来的），语义那一档要开自己去设置里勾 impressionPickGate，代价是偶尔换错一条
   *    （条数不变、只影响注入哪条印象，不发消息）。
   *
   * @returns {Promise<Map<string, string[]>>} userId → 必须占名额的条目内容
   */
  async topicPicks(chatKey, { userIds = [], topic = '', maxEach = 2, maxCalls = 3, timeoutMs = 1500 } = {}) {
    const picks = new Map();
    if (!localJevHasRole('impressionPickGate')) return picks;
    const lines = (Array.isArray(topic) ? topic : [topic]).map((s) => String(s || '').replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (!lines.length) return picks;
    const trig = lines[lines.length - 1].slice(0, 60);
    const filter = new Set((userIds || []).map(String).filter(Boolean));
    if (!filter.size) return picks;
    this.#loadAll();
    const now = Date.now();
    const jobs = [];
    for (const m of this.allMembers()) {
      const uid = String(m.userId || '').trim();
      if (!uid || !filter.has(uid)) continue;
      const ranked = rankImpressions(m, topicTokenSets(lines), now);
      if (ranked.length <= maxEach) continue;      // 没有落榜的，不用问
      const outsider = ranked[maxEach];
      if (!outsider) continue;
      jobs.push({ uid, line: outsider.e });
      if (jobs.length >= Math.max(1, maxCalls)) break;
    }
    if (!jobs.length) return picks;
    await Promise.all(jobs.map(async (j) => {
      try {
        // 输入压在 inputMaxChars(160) 内：触发语 60 字 + 印象 90 字
        const input = `A: ${trig.slice(0, 60)} ｜ B: ${String(j.line.content || '').slice(0, 90)}`;
        const g = await jevGate('impressionPickGate', input, { timeoutMs });
        if (g.on && g.label) {
          picks.set(j.uid, [String(j.line.content || '')]);
          console.log(`[memory] 印象补选命中：${j.uid} ← ${String(j.line.content || '').slice(0, 40)}（p=${Number(g.p || 0).toFixed(2)}）`);
        }
      } catch { /* 本地判定失败 = 保持原选择 */ }
    }));
    return picks;
  }

  consolidationState(chatKey) {
    this.#loadAll();
    let total = 0;
    let lastConsolidatedAt = 0;
    const members = [];
    for (const m of this.cache.values()) {
      if (chatKey && m.chats?.length && !m.chats.includes(String(chatKey))) continue;
      total += m.impressions.length;
      lastConsolidatedAt = Math.max(lastConsolidatedAt, m.lastConsolidatedAt || 0);
      members.push({
        userId: String(m.userId || ''),
        name: String(m.name || m.userId || ''),
        count: m.impressions.length,
        lastConsolidatedAt: m.lastConsolidatedAt || 0
      });
    }
    return {
      lastConsolidatedAt,
      counts: { memberImpression: total },
      members
    };
  }

  markConsolidated(chatKey, at = Date.now(), userIds = []) {
    this.#loadAll();
    for (const uid of userIds || []) {
      const m = this.cache.get(String(uid ?? '').trim());
      if (!m) continue;
      m.lastConsolidatedAt = Number(at) || Date.now();
      try { writeJson(personFile(m.userId, m.name), m); } catch { /* ignore */ }
    }
  }

  replaceConsolidated(chatKey, next) {
    const cut = (s, n) => String(s ?? '').trim().slice(0, n);
    const now = Date.now();
    const groups = new Map();
    for (const item of Array.isArray(next?.memberImpression) ? next.memberImpression.slice(0, MAX_IMPRESSIONS) : []) {
      const content = cut(item?.content, 160);
      if (!content) continue;
      const userId = cut(item?.userId, 40) || '';
      const name = cut(item?.target, 60) || userId;
      const key = userId || `_n_${personFileName('', name)}`;
      if (!groups.has(key)) groups.set(key, { userId, name, contents: [] });
      groups.get(key).contents.push(content);
    }
    this.#loadAll();
    for (const g of groups.values()) {
      // 整理结果：替换该人印象（而非追加）；同内容保留 pin/type
      const key = personKey(g.userId, g.name);
      const person = this.cache.get(key) || loadPerson(g.userId, g.name);
      person.userId = g.userId || person.userId;
      person.name = g.name || person.name;
      if (chatKey) person.chats = [...new Set([...(person.chats || []), String(chatKey)])];
      const prev = new Map((person.impressions || []).map((e) => [e.content, e]));
      person.impressions = normImpressions(g.contents.map((content) => {
        const keep = prev.get(content);
        return keep ? { ...keep } : { content, createdAt: now };
      }));
      person.updatedAt = now;
      person.lastConsolidatedAt = now;
      writeJson(personFile(person.userId, person.name), person);
      this.cache.set(key, person);
    }
    return { memberImpression: this.query(chatKey).memberImpression, count: groups.size };
  }
}
