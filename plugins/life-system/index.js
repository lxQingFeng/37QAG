// 生活系统 v0.4 —— 世界观 + 日历 + 事件账本。不再模拟作息数值。
//
// 为什么推倒重来（2026-09-19 复盘）：
//   原先把作息算成饱腹/困倦/精力数值再喂给模型，两头都输：
//   · 注入里带「接下来 18:20 吃晚饭」这种绝对钟点 + 未来动作，模型一定念出口；
//   · 数值长期为负（按公式一天清醒时间近一半在扣分），规则又写着"困饿就少说话"，
//     于是接上生活系统反而把灵气压掉。
//   一致性也不该靠数值模拟 —— 真人不会自相矛盾，是因为他记得自己刚说过什么。
//
// 现在只做三件事，全部零额外 LLM 调用：
//   1) 世界观：一段用户自定义的静态文本进 system（逐字节不变 → 命中显式缓存）。
//   2) 日历：只有节假日/调休/假期前后补一行，普通日子什么都不注入。
//   3) 事件账本：它自己说过的话（"我吃饱了"）+ 按世界观抽的随机事件，
//      同分组只留最新 → 结构上不可能出现"上一句说吃完、下一句喊饿"。
//
// 时间感知本来就有：prompt.js 每轮注入【当前时间】2026-09-19 17:17:05（周六），这里绝不重复报时。

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import { jevGate } from '../../src/local-jev.js';
import { noteEntry, decayInfo, ageLabel, FLOOR, DEAD } from '../../src/half-life.js';
import { dayInfo, dayModifiers } from './calendar.js';

const CAL_FILE = path.join(DATA_DIR, 'life-calendar.json');
const EVENTS_FILE = path.join(DATA_DIR, 'life-events.json');
const MIN = 60 * 1000;
const HOURMS = 60 * MIN;
// 世界 ≠ 人设。这段开场白就是要把它钉死，否则模型会把世界当性格演。
const WORLD_RULE = '【世界】下面是你所处世界的设定（城市、天气、规矩、周围会发生什么），**不是你的性格**：你是谁看【角色设定】。'
  + '只把它当背景板：被问到、或话题正好挨着的时候才体现，别主动播报，也别编这套设定里没有的细节。';

let cfg = () => ({});
let log = () => {};
let calCache = { mtime: 0, table: null, loaded: false };

export function setup(api) {
  cfg = typeof api?.config === 'function' ? api.config : () => ({});
  log = typeof api?.log === 'function' ? api.log : () => {};
}

const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function localDayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 1) 日历 ────────────────────────────────────────────────────────────
function loadCalendar(force = false) {
  if (cfg().calendarEnabled === false) return null;
  let st = null;
  try { st = fs.statSync(CAL_FILE); } catch { calCache = { mtime: 0, table: null, loaded: false }; return null; }
  if (!force && calCache.loaded && calCache.mtime === st.mtimeMs) return calCache.table;
  let table = null;
  try { table = JSON.parse(fs.readFileSync(CAL_FILE, 'utf8')); } catch { table = null; }
  calCache = { mtime: st.mtimeMs, table, loaded: true };
  return table;
}

/** 今天是什么日子。日历关掉或表不可读时返回 null。 */
export function today(date = new Date()) {
  if (cfg().calendarEnabled === false) return null;
  const table = loadCalendar();
  if (!table) return null;
  const info = dayInfo(date, table);
  return {
    dayKey: localDayKey(date),
    weekLabel: info.weekLabel,
    kind: info.kind,
    name: String(info.name || ''),
    // note 只在"不平凡"的日子有内容：假期第几天 / 调休上班 / 明天就放假 / 假期刚结束。
    // 普通工作日与普通周末是空串 —— 那正是要的省 token 行为。
    note: String(info.note || ''),
    expired: !!info.expired,
    holidays: Object.keys(table.holidays || {}).length,
    makeup: Object.keys(table.makeupWorkdays || {}).length,
    year: Number(table.year) || 0
  };
}

export function calendarLine(t = today()) {
  if (!t || !t.note) return '';
  return `（日历）${t.note}。被问到就说这个，别自己排日程。`;
}

// ── 3) 事件账本 ────────────────────────────────────────────────────────
// facts 按分组存、同组覆盖：这就是"一致性底线"的实现 —— 每类状态任何时刻只有一个说法。
// 分组 = 一致性作用的单位（同组覆盖）。世界类分组（sea/city/home/user）是"外面发生了什么"，
// 生理类（meal/rest）是"她身上发生了什么"，各自独立覆盖，互不干扰。
//
// ⚠️ 2026-09-21 改成**随时间半衰**（原来是 `until = at + ttl` 硬过期，到点整条消失）：
//   见 src/half-life.js 的说明。换算关系刻意选成 hl = ttl / 2 —— 这样"权重掉到 0.25"
//   正好等于原来那个到期时刻，下面这些调过的数值一个都不用重调，只是中间多了渐变：
//   刚说过时是满的、一个半衰期后剩一半、两个半衰期后不再主动提。
const GROUP_TTL_MIN = {
  meal: 150, rest: 240, work: 120, play: 180, social: 240,
  sea: 300, city: 360, home: 360, net: 120, misc: 300
};
const halfLifeOf = (group) => Math.max(5, (GROUP_TTL_MIN[group] ?? 180) / 2);

// 状态类（meal/rest）：她随时可以被问"吃了吗"，所以要留着 —— 但**不能每轮都塞**。
// 2026-09-21 实测（号A 私聊）：一条「还没吃，肚子空着」在 109 分钟里被注入 17 次、
// 「刚睡过一觉起来」121 分钟里被注入 37 次。后果是她会反复念叨同一件事（"我更饿了"…），
// 而且这句话又会被 SAY_RULES 抓回去续期，形成自我强化。
// 现在的规则：状态类只在**还够浓**（weight ≥ STATE_MIN_WEIGHT）时主动递、且最多递
// STATE_MAX_SHOWN 次；淡下去之后仍留在账本里维持一致性，只在**话题正好问到这件事时**才递。
const STATE_GROUPS = new Set(['meal', 'rest']);
const STATE_MIN_WEIGHT = 0.45;   // 主动递的浓度门槛（≈ 1.15 个半衰期）
const STATE_ASK_WEIGHT = 0.25;   // 被问到时还愿意答的浓度门槛（= 2 个半衰期，与旧的"到期"对齐）
const STATE_MAX_SHOWN = 3;       // 同一条状态最多主动递几次
// 素材类（随机事件/世界近况）：只在还没递过、且没淡太多时出现一次
const MATERIAL_MIN_WEIGHT = 0.35;
// "话题正好挨着"的判定：对方在问吃/睡，就把对应状态递过去（这样"吃了吗"永远答得上）
const STATE_TOPIC = {
  meal: /吃|饭|饿|外卖|食堂|宵夜|夜宵|奶茶|零食|喝点|点单|下厨|做饭/,
  rest: /睡|困|醒|熬夜|起床|歇|累|失眠|午觉|打盹/
};
const USED_KEEP = 80;           // 最近用过的素材文本，滚动保留

// 它自己发出去的话 → 事实。这是账本的主来源：说到过就算发生过。
// 事件池默认关闭后，这套正则是账本的主入口；宁可稍宽，也不要「说了吃了却没记上」。
// 同组只留最新；命中多条规则时按数组顺序，后写覆盖前写（更具体的放后面）。
const SAY_RULES = [
  // ── 吃 ──
  ['meal', /吃饭(?:了|啦|咯|完|中)?|吃(?:了)?(?:早|午|晚|宵夜|点心|零食)饭/, '刚吃过东西', 90],
  ['meal', /(?:刚|已经|才|早上|中午|晚上)?(?:吃了|吃完|吃过|吃过了|扒了|炫了|搓了|整了)(?:饭|面|粉|火锅|烧烤|外卖|食堂|早餐|午饭|晚饭|宵夜|点心|蛋糕|零食)?/, '刚吃过东西', 90],
  ['meal', /吃饱(?:了|啦|咯|嗝)|吃撑(?:了|啦)|肚子(?:饱|好饱)|干饭(?:完|了|中)/, '刚吃过东西', 90],
  ['meal', /下(?:午)?饭|点(?:了)?外卖|吃(?:了)?外卖|去(?:了)?食堂|开饭|干饭/, '正在吃 / 刚安排上吃的', 75],
  ['meal', /(?:好|超|快|要|有点)?饿(?:死|了|得不行|扁|晕)?|还没吃|没吃饭|没吃呢|肚子(?:叫|空|咕咕)|空着肚子/, '还没吃，肚子空着', 90],
  ['meal', /想(?:吃|喝)(?:点|些|什么|啥)?|吃点什么|喝点啥|晚饭吃啥|中午吃啥/, '在想吃什么', 60],

  // ── 睡 / 累 ──
  ['rest', /(?:去|先|准备)?睡(?:了|觉|会儿|一会儿)|先躺(?:了|会)|眯(?:一会儿|个|了)|刚醒|起床(?:了|啦)?|醒过来|睡醒/, '刚睡过一觉起来', 180],
  ['rest', /困(?:死|得|了|了不行)|想睡|犯困|眼皮(?:重|打架)|熬(?:夜|到|通宵)|没睡(?:好|够|着)|失眠|补觉/, '没睡好，犯困', 180],
  ['rest', /好累|累(?:死|了|成狗|瘫)|精疲力尽|瘫(?:了|在)/, '挺累的，想歇', 120],

  // ── 正事 ──
  ['work', /在忙|忙(?:着|完|死|晕)|加班|赶(?:稿|工|ddl|DDL|进度)|剪(?:片|视频)|开播|下播|上课|写(?:作业|代码|文档|报告)|搬砖|上班(?:了|中)?|打工/, '手上有事在忙', 120],
  ['work', /会(?:议|开完)|开会|对接|需求|改(?:稿|需求|bug|BUG)|debug|排(?:查|错)|写(?:周)?报/, '在弄工作上的事', 120],

  // ── 玩 ──
  ['play', /(?:打|开)(?:了)?(?:几把|一把|两把|游戏|排位|本|团)|上分|掉分|看(?:了)?(?:番|剧|完|视频)|刷(?:了)?(?:b站|B站|视频|手机|动态)|摸(?:了)?鱼|开黑/, '玩了一会儿没管别的', 150],
  ['play', /追(?:剧|番)|听(?:歌|音乐)|看(?:小说|漫画|直播)|刷(?:手机|视频)/, '在休闲摸鱼', 120],

  // ── 出门 / 社交 ──
  ['social', /(?:跟|和)(?:朋友|同学|同事|她|他|谁)(?:出去|吃饭|玩|连麦|逛街)|约(?:了|出去|饭|玩)|出门(?:了|一趟|办事)?|回来了|到家了|在外面/, '在外面跑了趟', 180],
  ['social', /逛街|超市|快递|拿外卖|下楼|散步|溜达/, '出门办了点小事', 150]
];

function emptyLedger() {
  return { version: 2, dayKey: '', facts: {}, rolled: 0, lastRollAt: 0, used: {} };
}

function loadLedger() {
  try {
    const raw = JSON.parse(fs.readFileSync(EVENTS_FILE, 'utf8'));
    if (!raw || typeof raw !== 'object') return emptyLedger();
    return {
      version: 2,
      dayKey: String(raw.dayKey || ''),
      facts: raw.facts && typeof raw.facts === 'object' ? raw.facts : {},
      rolled: Number(raw.rolled) || 0,
      lastRollAt: Number(raw.lastRollAt) || 0,
      used: raw.used && typeof raw.used === 'object' ? raw.used : {}
    };
  } catch {
    return emptyLedger();
  }
}

/** 记下"这条素材什么时候用过"，rollEvent 与注入都靠它避免重播。 */
function markUsed(l, text, now = Date.now()) {
  const t = String(text || '').trim();
  if (!t) return;
  l.used = { ...(l.used || {}), [t]: now };
  const keys = Object.keys(l.used);
  if (keys.length > USED_KEEP) {
    for (const k of keys.sort((a, b) => (Number(l.used[a]) || 0) - (Number(l.used[b]) || 0)).slice(0, keys.length - USED_KEEP)) {
      delete l.used[k];
    }
  }
}

function saveLedger(l) {
  const tmp = `${EVENTS_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(l, null, 2), 'utf8');
    fs.renameSync(tmp, EVENTS_FILE);
    return true;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
    log('life-system 写事件账本失败：', e?.message ?? e);
    return false;
  }
}

// 事件池：设置里每行一条，形如 `分组: 文案`；不写分组算 misc，# 开头是注释。
// 仅「启用事件池」打开时才会被 rollEvent 使用。
export function eventPool(c = cfg()) {
  const out = [];
  for (const r of String(c.eventPool || '').split('\n').map((x) => x.trim())) {
    if (!r || r.startsWith('#')) continue;
    const m = /^([a-z]+)\s*[:：|]\s*(.+)$/i.exec(r);
    if (m) out.push({ group: m[1].toLowerCase(), text: m[2].trim().slice(0, 60) });
    else out.push({ group: 'misc', text: r.slice(0, 60) });
  }
  return out;
}

function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** 种子含当天与"第几条"，同一天抽到同一批事件，重启不跳戏。 */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t ^= t + Math.imul(t ^ (t >>> 7), 61 | t);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 只留还够浓的事实（半衰），浓的在前。shown>0 表示这条已经当话题递给过模型。 */
function liveFacts(l, now = Date.now()) {
  return Object.entries(l.facts || {})
    .map(([g, f]) => {
      // 老数据只有 ttl/until（硬过期）：迁移成 hl = ttl/2，语义与原来完全对齐
      const hl = Number(f?.hl) || (Number(f?.ttl) ? Number(f.ttl) / 2 : halfLifeOf(g));
      const info = decayInfo({ ...f, hl }, now, hl);
      return {
        group: g,
        text: String(f?.text || ''),
        at: Number(f?.at) || 0,
        shown: Number(f?.shown) || 0,
        ttl: Math.round(hl * 2),          // 兼容老字段（控制台在用）：等价半衰期对应的硬 TTL
        hl,
        weight: info.weight,
        ageMin: Math.round(info.ageMin || 0),
        // minsLeft 给控制台显示"这条还能站多久"，一致性的可见化
        minsLeft: info.minsLeft
      };
    })
    .filter((f) => f.text && f.weight > FLOOR)
    .sort((a, b) => b.weight - a.weight);
}

/** 顺手清理：淡到没意义的（≈4 个半衰期）没必要留在文件里。 */
function pruneFacts(l, now = Date.now()) {
  let removed = 0;
  for (const [g, f] of Object.entries(l.facts || {})) {
    const hl = Number(f?.hl) || (Number(f?.ttl) ? Number(f.ttl) / 2 : halfLifeOf(g));
    const ageMin = Number(f?.at) ? (now - Number(f.at)) / MIN : Infinity;
    if (ageMin === Infinity || Math.pow(0.5, ageMin / hl) < DEAD) { delete l.facts[g]; removed += 1; }
  }
  if (removed) saveLedger(l);
  return removed;
}

/** 记一条事实（同组覆盖 = 一致性）。被换掉的旧文本进 used，避免它过几小时又被抽回来。 */
export function noteFact(group, text, ttlMin, { now = Date.now() } = {}) {
  const g = String(group || 'misc').toLowerCase();
  const t = String(text || '').trim().slice(0, 60);
  if (!t) return null;
  const l = loadLedger();
  // 半衰期 = 旧 TTL 的一半（这样"权重掉到 0.25"= 原来那个到期时刻）
  const hl = ttlMin == null ? halfLifeOf(g) : clamp(num(ttlMin, halfLifeOf(g) * 2) / 2, 3, 360);
  const prev = l.facts?.[g];
  const old = String(prev?.text || '');
  const entry = noteEntry(l.facts || (l.facts = {}), g, t, {
    halfLifeMin: hl,
    now,
    // 续期上限按**总寿命**对齐老规则：老代码把 until 夹在 bornAt+1.5×TTL，也就是
    // "同文本最多活 1.5×TTL"。换成半衰后总寿命 = (at 被推到的最晚点) + 2×hl，
    // 所以 at 最多推到 bornAt + 1.5×TTL − 2×hl = bornAt + 0.5×TTL = bornAt + hl → capFactor 1。
    capFactor: 1,
    maxKeys: 8,
    onEvict: (k, e) => markUsed(l, e?.text, now)
  });
  if (old && old !== t && entry) markUsed(l, old, now);
  saveLedger(l);
  return entry;
}

/**
 * 这句话该不该记成"我自己的状态"？
 *
 * 实测漏网（2026-09-21）：她说「你这刚醒就问我吃啥 不先关心自己饿不饿」——
 * 那是**在说对方**，却被记成「还没吃，肚子空着」挂在自己头上两小时。
 * 注意只看整句里有没有"我"是不够的（这句里就有"问我"），得看**匹配到的那个词附近**的主语。
 *
 * 规则：
 *   ① 整句有第二/三人称、且完全没有第一人称 → 不是她的状态；
 *   ② 有第二/三人称时，匹配词前 8 个字里必须出现"我/咱"，否则算在说别人；
 *   ③ 疑问句（她在问别人）不算。
 */
function speaksAboutSelf(s, matchIndex = 0) {
  const t = String(s || '');
  const other = /你|您|你们|他|她|他们|她们|别人|大家|对方/.test(t);
  const firstAnywhere = /我|咱|本鲸|本鱼/.test(t);
  if (other && !firstAnywhere) return false;
  if (other) {
    const before = t.slice(Math.max(0, matchIndex - 8), matchIndex);
    if (!/我|咱/.test(before)) return false;
  }
  if (/[？?]\s*$/.test(t) || /(吗|呢|么)[。！!？?]?\s*$/.test(t)) return false;
  return true;
}

/** 扫它自己要发出去的文本：说到什么就记什么。 */
export function captureFromText(text, { now = Date.now() } = {}) {
  const s = String(text || '');
  if (!s.trim()) return 0;
  let hits = 0;
  for (const [group, re, fact, ttl] of SAY_RULES) {
    const m = re.exec(s);
    if (!m) continue;
    if (!speaksAboutSelf(s, m.index)) continue;   // 主语/语气不对：不记成自己的状态
    noteFact(group, fact, ttl, { now });
    hits += 1;
  }
  return hits;
}

/** 这句是不是"主语含糊"：既提到我、又提到你/他 —— 正则判不准，值得问一次 Jev。 */
export function isAmbiguousSubject(s) {
  const t = String(s || '');
  const mine = /我|咱|本鲸|本鱼/.test(t);
  const other = /你|您|你们|他|她|他们|她们|别人|大家|对方/.test(t);
  return mine && other;
}

/**
 * 带 Jev 复核的捕获（钩子里用这个）。
 *
 * 为什么需要：正则只能看字面。实测 2026-09-21 漏网的那句
 * 「你这刚醒就问我吃啥 不先关心自己饿不饿」——里面有"我"（问我），正则以为是在说自己，
 * 于是把"还没吃"挂在她头上两小时。这种**主语含糊**的句子交给 Jev 判一次最省事：
 *   · 只在含糊句子上问（清晰句子直接走正则，零成本、零延迟）
 *   · Jev 弃权/不可用/超时 → 回退正则，行为不变
 *   · 判成 OTHER → 这一句不记任何状态
 */
export async function captureFromTextSmart(text, { now = Date.now() } = {}) {
  const s = String(text || '');
  if (!s.trim()) return 0;
  const matched = SAY_RULES.filter(([, re]) => re.test(s));
  if (!matched.length) return 0;

  let selfVerdict = null;   // null = 没问/问不出，回退正则
  if (isAmbiguousSubject(s)) {
    try {
      // jevGate 自带：角色开关检查 + spec 提示词 + 弃权语义（on=true 表示"在说它自己"）
      const g = await jevGate('selfStateGate', s.slice(0, 160), { timeoutMs: 1200 });
      if (g && !g.error && !g.abstain) selfVerdict = !!g.on;
    } catch { /* Jev 不可用就走正则 */ }
  }

  let hits = 0;
  for (const [group, re, fact, ttl] of matched) {
    const m = re.exec(s);
    const ok = selfVerdict === null ? speaksAboutSelf(s, m.index) : selfVerdict;
    if (!ok) continue;
    noteFact(group, fact, ttl, { now });
    hits += 1;
  }
  return hits;
}

/** 某条素材是否"最近用过"（同一条趣闻在 eventRepeatH 小时内不该再演一遍）。 */
function usedRecently(l, text, now, repeatMs) {
  if (!repeatMs) return false;
  const at = Number(l.used?.[String(text || '').trim()]) || 0;
  return !!at && now - at < repeatMs;
}

/** 按世界设定抽一条随机事件。跳过：池关 / 当天已够 / 间隔未到 / 同组已有活跃事实 / 近期用过。 */
function rollEvent({ now = Date.now(), force = false } = {}) {
  const c = cfg();
  // 开关关 = 只走台词正则；打开才从池子抽（手动「抽一条」可 force）
  if (!force && c.eventPoolEnabled !== true) return false;
  const poolOn = c.eventPoolEnabled === true || force;
  if (!poolOn) return false;
  const perDay = clamp(num(c.eventsPerDay, c.eventPoolEnabled === true ? 4 : 0), 0, 8);
  if (perDay <= 0) return false;
  const pool = eventPool(c);
  if (!pool.length) return false;
  const gap = clamp(num(c.eventGapMin, 75), 15, 720) * MIN;
  const repeatMs = clamp(num(c.eventRepeatH, 72), 0, 720) * HOURMS;
  const l = loadLedger();
  const dk = localDayKey(new Date(now));
  const rolled = l.dayKey === dk ? num(l.rolled, 0) : 0;
  if (rolled >= perDay) return false;
  if (l.dayKey === dk && now - num(l.lastRollAt, 0) < gap) return false;
  const alive = new Set(liveFacts(l, now).map((f) => f.group));
  // 同组已有未过期事实就跳过：不然"刚说过吃过了"会被抽到的一条饿顶掉。
  // 再用"近期用过"过滤掉重复素材；两者都空时宁可这条不抽（宁缺勿重）。
  const fresh = pool.filter((e) => !alive.has(e.group) && !usedRecently(l, e.text, now, repeatMs));
  if (!fresh.length) return false;
  const pick = fresh[Math.floor(mulberry32(hashStr(`${dk}|${rolled}|${c.eventSeed || ''}`))() * fresh.length)];
  if (!pick) return false;
  l.dayKey = dk;
  l.rolled = rolled + 1;
  l.lastRollAt = now;
  markUsed(l, pick.text, now);
  saveLedger(l);
  noteFact(pick.group, pick.text, undefined, { now });
  return true;
}

/**
 * 注入用的一行近况（最多 2 条、过去/现在时、不含钟点）。
 *
 * 递法（2026-09-21 改半衰）：
 *   · 状态类（吃/睡）：还够浓（weight ≥ STATE_MIN_WEIGHT）时最多主动递 STATE_MAX_SHOWN 次；
 *     淡下去之后只在她**被问到这件事**（contextText 里出现吃/睡相关词）、且没淡透
 *     （weight ≥ STATE_ASK_WEIGHT）时才递。这样"吃了吗"永远答得上，又不会 2 小时念叨 37 次。
 *   · 素材类：只在还没被递过、且没淡太多时出现一次，之后留在账本里维持一致性但不再当话题。
 *   · 两种情况都带上**人话年龄**（"半小时左右"）—— 半衰的意义就在这儿：模型能看出这是
 *     "刚发生"还是"几小时前"，而不是被一条同等新鲜度的陈述骗着当现状说。
 */
export function factLine({ now = Date.now(), roll = true, contextText = '' } = {}) {
  // 自动补事件仅在事件池开启时；关着时只读账本（正则已写入的事实）
  if (roll) { try { rollEvent({ now }); } catch { /* 抽不到不影响本轮 */ } }
  const l = loadLedger();
  try { pruneFacts(l, now); } catch { /* 清理失败不影响注入 */ }
  const facts = liveFacts(l, now);
  const ctx = String(contextText || '');
  const pick = facts.filter((f) => {
    if (!STATE_GROUPS.has(f.group)) return !f.shown && f.weight >= MATERIAL_MIN_WEIGHT;
    if (f.shown < STATE_MAX_SHOWN && f.weight >= STATE_MIN_WEIGHT) return true;
    const re = STATE_TOPIC[f.group];
    return !!re && re.test(ctx) && f.weight >= STATE_ASK_WEIGHT;
  }).slice(0, 2);
  if (!pick.length) return '';
  for (const f of pick) {
    if (l.facts[f.group]) l.facts[f.group].shown = (Number(l.facts[f.group].shown) || 0) + 1;
  }
  saveLedger(l);
  const body = pick.map((f) => {
    const age = ageLabel(f.ageMin);
    return age ? `${f.text}（${age}）` : f.text;
  }).join('；');
  return `（近况）${body}。这是你自己之前的状况，只在相关时顺口提一句，别主动播报、别说反、别拿它排接下来的日程。`;
}

// ── 注入 ───────────────────────────────────────────────────────────────
/** system 侧只放静态世界设定（跨运行逐字节不变，缓存友好）。 */
export function promptSections() {
  const out = [];
  const book = String(cfg().worldbook || '').trim();
  if (book) out.push({ id: 'life-worldbook', title: '世界设定', priority: 60, content: `${WORLD_RULE}\n${book}` });
  return out;
}

/** 取最后一条 user 消息的纯文本（判断"对方是不是在问吃/睡"用）。 */
function lastUserText(messages) {
  const last = [...(Array.isArray(messages) ? messages : [])].reverse().find((m) => m && m.role === 'user');
  if (!last) return '';
  if (typeof last.content === 'string') return last.content.slice(-2000);
  if (Array.isArray(last.content)) {
    return last.content.filter((p) => p && p.type === 'text').map((p) => String(p.text || '')).join('\n').slice(-2000);
  }
  return '';
}

function appendToLastUser(messages, line) {  const arr = Array.isArray(messages) ? messages : [];
  const last = [...arr].reverse().find((m) => m && m.role === 'user');
  if (!last) return false;
  const seen = (s) => /（日历）|（近况）/.test(String(s || ''));
  if (Array.isArray(last.content)) {
    if (last.content.some((p) => p && typeof p === 'object' && seen(p.text))) return false;
    const texts = last.content.filter((p) => p && p.type === 'text');
    if (!texts.length) return false;
    const t = texts[texts.length - 1];
    t.text = `${t.text}\n${line}`;
    return true;
  }
  if (typeof last.content !== 'string' || seen(last.content)) return false;
  last.content = `${last.content}\n${line}`;
  return true;
}

let lastVoice = '';

export const hooks = {
  // user 尾部最多两小行（日历 + 近况）：本来就在不缓存的那段，合计约 30 字。
  'before-llm-messages': ({ messages } = {}) => {
    const bits = [];
    try {
      const cal = calendarLine();
      if (cal) bits.push(cal);
      const fact = factLine({ contextText: lastUserText(messages) });
      if (fact) bits.push(fact);
    } catch { return; }
    if (bits.length) appendToLastUser(messages, bits.join('\n'));
  },

  // 心声也是发生过的事：她没发群里的内心独白（「（心声：刚吃完就开工）」）
  // 同样进账本，世界和她"想过的"保持一致，而不只和"说出口的"一致。零额外调用。
  'after-response': async ({ session } = {}) => {
    const v = String(session?.innerVoice || '').trim();
    if (!v || v === lastVoice) return;
    lastVoice = v;
    try { await captureFromTextSmart(v); } catch { /* 记不上不影响本轮 */ }
  },

  // 它要发出去的话 = 事实来源。只读参数，不拦工具。
  // 主语含糊的句子会问一次本地 Jev（~100-500ms），判不出来就回退正则。
  'before-tool': async ({ toolName, argsRaw } = {}) => {
    if (String(toolName || '') !== 'send_message') return;
    try {
      const a = JSON.parse(String(argsRaw || '{}'));
      const list = Array.isArray(a?.messages) ? a.messages : [a?.messages ?? a?.text];
      await captureFromTextSmart(list.filter(Boolean).map(String).join('\n'));
    } catch { /* 参数不规整就不记 */ }
  }
};

// ── 能力（控制台读 + 核心拉取） ────────────────────────────────────────
/**
 * 精力目标修正：只在「日历日子类型 + 账本状态」上做轻量偏移，
 * 不再模拟饱腹/困倦数值，也不改「要不要开口」。
 * 核心 bot-state.hourEnergyTargets 会夹逼到 0~100。
 */
function energyTargets({ hour = new Date().getHours() } = {}) {
  try {
    if (cfg().energyFromWorld === false) return {};
    let physical = 0;
    let cognitive = 0;
    const table = loadCalendar();
    if (table) {
      const mod = dayModifiers(new Date(), table);
      physical += Number(mod.physical) || 0;
      cognitive += Number(mod.cognitive) || 0;
      // 工作日上午不额外压；周末/假期的修正已经够用
      if (hour >= 22 || hour < 6) {
        // 深夜：若账本说没睡好，再多压一点（有据可依时才压）
        const facts = liveFacts(loadLedger());
        if (facts.some((f) => f.group === 'rest' && /没睡好|犯困|熬夜|眼皮/.test(String(f.text || '')))) {
          physical -= 6;
          cognitive -= 8;
        }
      }
    }
    const facts = liveFacts(loadLedger());
    for (const f of facts) {
      const t = String(f.text || '');
      if (f.group === 'rest') {
        if (/没睡好|犯困|熬夜/.test(t)) { physical -= 8; cognitive -= 6; }
        else if (/刚睡过|起床|醒过来/.test(t)) { physical += 4; cognitive += 3; }
      } else if (f.group === 'meal' && /还没吃|肚子空|饿/.test(t)) {
        physical -= 5;
        cognitive -= 3;
      } else if (f.group === 'work' && /在忙|加班|赶/.test(t)) {
        cognitive -= 4;
      }
    }
    return { physical, cognitive };
  } catch {
    return {};
  }
}

export const providers = {
  'life.today': () => today(),
  'life.worldbook': () => String(cfg().worldbook || ''),
  'life.facts': () => {
    try { return liveFacts(loadLedger()); } catch { return []; }
  },
  // 控制台「抽一条」：立刻按当前世界与事件池产一条新近况（返回 rolled=false 表示被上限/冷却挡住了）
  'life.roll': ({ now = Date.now() } = {}) => {
    const on = cfg().eventPoolEnabled === true;
    if (!on) return { rolled: false, poolEnabled: false, facts: liveFacts(loadLedger(), now).slice(0, 3) };
    const ok = rollEvent({ now, force: true });
    return { rolled: !!ok, poolEnabled: true, facts: liveFacts(loadLedger(), now).slice(0, 3) };
  },
  // 控制台「清掉这一组」：调试时用，不影响世界设定
  'life.clear': (args = {}) => {
    const l = loadLedger();
    const g = String(args?.group || '');
    if (g && l.facts[g]) delete l.facts[g];
    else if (!g) l.facts = {};
    saveLedger(l);
    return { ok: true, facts: liveFacts(l) };
  },
  // 世界/日历 → 精力目标修正（核心 bot-state 拉取）
  'state.energy-targets': energyTargets
};

export function activate() { return { ok: true }; }
export function deactivate() { /* 无定时器 */ }
export function available() { return { ok: true }; }

export const internals = {
  today, calendarLine, factLine, rollEvent, captureFromText, captureFromTextSmart, isAmbiguousSubject,
  speaksAboutSelfForTest: speaksAboutSelf,
  noteFact, eventPool, loadLedger, saveLedger, liveFacts, pruneFacts, SAY_RULES, GROUP_TTL_MIN,
  STATE_GROUPS, STATE_TOPIC, STATE_MAX_SHOWN, STATE_MIN_WEIGHT, STATE_ASK_WEIGHT, MATERIAL_MIN_WEIGHT,
  halfLifeOf, markUsed,
  energyTargets,
  WORLD_RULE, CAL_FILE, EVENTS_FILE
};
