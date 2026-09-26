// 语义卡片：比「群友印象」更像人的长期常识/事件记忆。
// 本地从小时块/消息启发式抽取，不调模型；注入时按关键词匹配，短文本。
import fs from 'node:fs';
import path from 'node:path';
import { hourKeyOf } from './longterm.js';
import { jevGate, localJevHasRole } from '../local-jev.js';

function ensure(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function readJson(file, fb) {
  try {
    let t = fs.readFileSync(file, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    return JSON.parse(t);
  } catch {
    return fb;
  }
}

function atomicWrite(file, data) {
  ensure(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

// 更严：避免把闲聊感叹句刷成垃圾卡
const PLAN_RE = /(明天|后天|下周|周末|约好|说好|定了|要去|要来|一起吃|聚餐|考试|比赛|生日|开黑|上线|发布会)/i;
const FACT_RE = /(记住这点|记得我|我是.{0,6}(学生|打工|程序员)|我喜欢.{0,12}|别骂我|雷点是|口头禅)/i;
// 计划还得**有动作**才算计划（2026-09-21 补）：老规则只要句子里出现「明天/上线/发布会」
// 就判成 plan，于是「睡吧 明天还得早起」「@某某 去b站搜搜有没」全成了"卡片"——
// 实测 400 张卡里 297 张是这种消息残渣，注进提示词的就是这些。
const ACTION_RE = /(去|来|要|得|准备|开始|约|定|上线|开黑|吃|聚|考试|比赛|发|做|见|聊|打|写|学|问|查|陪|帮)/;

/**
 * 洗掉机器码/占位符/提及，只留"人话"。
 * ⚠️ 2026-09-21：老代码只拦了「[引用/[图片/[表情」，漏了 `[CQ:at,qq=…]` ——
 * 于是提示词里出现过「[plan] @最聪明最可爱的白京玉[CQ:at,qq=10000001] 去b站搜搜有没」这种卡。
 */
function stripNoise(text) {
  return String(text || '')
    .replace(/\[CQ:[^\]]*\]/gi, ' ')
    .replace(/\[[^\]]{0,14}\]/g, ' ')
    .replace(/@\S{1,24}/g, ' ')
    .replace(/[（(【\[][^）)】\]]{0,10}(引用|图片|表情|拍一拍)[^）)】\]]{0,10}[）)】\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 这条消息配不配当一张语义卡？返回 { clean, type } 或 null。
 * @param {string} rawText 原始消息
 * @param {{self?: boolean}} opts self = 机器人自己说的话
 */
export function cardWorthy(rawText, { self = false } = {}) {
  const t = stripNoise(rawText);
  if (t.length < 8 || t.length > 140) return null;
  if (/^(我|咱)[喜欢爱是想要]{1}[^，。]{0,6}$/.test(t)) return null;   // 「我喜欢」这种没主语的碎片
  if ((t.match(/[?？！!]/g) || []).length >= 2) return null;
  const plan = PLAN_RE.test(t) && ACTION_RE.test(t);
  const fact = FACT_RE.test(t);
  if (!plan && !fact) return null;
  // 机器人自己的话：只留「我/咱 + 动作」的承诺或打算。否则它每一句回话
  // （「睡吧 明天还得早起」）都会被当成"计划"存下来。
  if (self && !/(我|咱)[^。！？]{0,10}(去|来|要|得|准备|开始|约|定|帮|带|发|做|打|见|陪|问|查|写|学)/.test(t)) return null;
  return { clean: t, type: plan ? 'plan' : 'fact' };
}

export class SemanticCardStore {
  constructor(root) {
    this.root = path.resolve(root);
    this.file = path.join(this.root, 'cards.json');
    ensure(this.root);
    const raw = readJson(this.file, { version: 1, cards: [] });
    this.cards = Array.isArray(raw.cards) ? raw.cards : [];
  }

  save() {
    if (this.cards.length > 400) {
      this.cards.sort((a, b) => (b.lastTs || 0) - (a.lastTs || 0));
      this.cards = this.cards.slice(0, 400);
    }
    atomicWrite(this.file, { version: 1, cards: this.cards });
  }

  #key(type, chatKey, title) {
    return `${type}|${chatKey}|${String(title).toLowerCase().slice(0, 60)}`;
  }

  upsert({ type, chatKey, title, detail, tags = [], source = 'local', ts = Date.now() }) {
    const t = String(title || '').trim().slice(0, 80);
    if (!t || !chatKey) return null;
    const k = this.#key(type, chatKey, t);
    const existing = this.cards.find((c) => c.key === k);
    if (existing) {
      existing.hits = (existing.hits || 1) + 1;
      existing.lastTs = Math.max(existing.lastTs || 0, ts);
      if (detail) existing.detail = String(detail).slice(0, 200);
      if (tags?.length) existing.tags = [...new Set([...(existing.tags || []), ...tags])].slice(0, 8);
      this.save();
      return existing;
    }
    const card = {
      key: k,
      type: type === 'plan' ? 'plan' : (type === 'fact' ? 'fact' : 'topic'),
      chatKey,
      title: t,
      detail: String(detail || '').slice(0, 200),
      tags: (tags || []).map(String).slice(0, 8),
      hits: 1,
      lastTs: ts,
      source
    };
    this.cards.unshift(card);
    this.save();
    return card;
  }

  /** 从该小时的消息行里抽卡片（本地启发式）。 */
  ingestHour(chatKey, snippets = []) {
    if (!Array.isArray(snippets) || !snippets.length) return 0;
    let n = 0;
    for (const s of snippets) {
      const worth = cardWorthy(String(s?.text || ''), { self: !!s?.self });
      if (!worth) continue;
      const { clean, type } = worth;
      const who = s.self ? '我' : String(s.who || '');
      this.upsert({
        type,
        chatKey,
        title: clean.slice(0, 40),
        detail: `${who ? `${who}: ` : ''}${clean.slice(0, 100)}`,
        tags: type === 'plan' ? ['计划'] : ['事实'],
        ts: Number(s.ts) || Date.now()
      });
      n += 1;
    }
    return n;
  }

  /** 清掉明显垃圾卡（过短/感叹/图片/机器码/残渣）。返回清掉几张。 */
  purgeJunk() {
    const before = this.cards.length;
    this.cards = this.cards.filter((c) => {
      const t = String(c.title || '');
      // 用同一套准入规则复核（title 是洗过的文本，这里再洗一次防止老卡带机器码）
      const worth = cardWorthy(t, { self: /^我[:：]/.test(String(c.detail || '')) || false });
      if (!worth) return false;
      if (/\[CQ:|\[图片|【图片|\[表情|@\S{1,20}/i.test(t)) return false;
      if (/^(哈哈|草|乐|典|6+|嗯|哦|啊哈|诶嘿)/.test(t)) return false;
      if (/我在的|慢慢聊|旁边看着/.test(t)) return false;
      return true;
    });
    if (this.cards.length !== before) this.save();
    return before - this.cards.length;
  }

  /** 按触发文本匹配相关卡片（最多 max 条，短渲染）。 */
  match(query, { chatKey = null, limit = 4, now = Date.now() } = {}) {
    const q = String(query || '').toLowerCase();
    if (!q) return [];
    const scored = [];
    for (const c of this.cards) {
      if (chatKey && c.chatKey !== chatKey) continue;
      const hay = `${c.title} ${c.detail} ${(c.tags || []).join(' ')}`.toLowerCase();
      let score = 0;
      // 关键词粗匹配
      const words = q.match(/[一-鿿]{2,}|[a-z0-9_]{3,}/g) || [];
      for (const w of words) if (hay.includes(w)) score += 3;
      if (hay.includes(q.slice(0, 12))) score += 4;
      // 新鲜度 + 命中次数
      const ageH = Math.max(1, (now - (c.lastTs || 0)) / 3600000);
      score += Math.min(3, (c.hits || 1) / 2) / Math.log2(ageH + 1);
      if (score > 1.2) scored.push({ score, card: c });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, limit)).map(({ card, score }) => ({
      type: card.type,
      title: card.title,
      detail: card.detail,
      when: new Date(card.lastTs || now).toISOString().slice(0, 16).replace('T', ' '),
      score: Math.round(score * 10) / 10,
      chatKey: card.chatKey
    }));
  }

  stats() {
    const byType = {};
    for (const c of this.cards) byType[c.type] = (byType[c.type] || 0) + 1;
    return { cards: this.cards.length, byType };
  }

  /**
   * 模型抽卡结果写入（type/title/detail）。
   *
   * ⚠️ 2026-09-21：这条路以前只做长度检查，于是模型把消息片段原样交上来也照收 ——
   * 400 张卡里 228 张是「睡吧 明天还得早起」「@某某[CQ:at,qq=…] 去b站搜搜有没」。
   * 现在两道关：① 正则洗字 + 准入（cardWorthy）；② **本地 Jev 判一眼值不值得长期记**
   * （PLAN/FACT/SKIP），判 SKIP 直接丢，判 PLAN/FACT 就用它的类型。
   * 这条路跑在巩固流程里（后台），Jev 那一百毫秒不占回复链路。
   */
  async ingestLlmCards(chatKey, cards = [], { ts = Date.now(), useJev = true } = {}) {
    if (!Array.isArray(cards) || !cards.length) return 0;
    const jevOn = useJev && localJevHasRole('cardGate');
    let n = 0;
    for (const c of cards) {
      if (!c || typeof c !== 'object') continue;
      const raw = String(c.title || '').trim();
      const cleaned = stripNoise(raw);
      let type = c.type === 'plan' ? 'plan' : (c.type === 'fact' ? 'fact' : 'topic');
      // ① 正则关：洗掉机器码/提及，并且不能是"睡吧 明天再堆"这类残渣。
      //    topic 由模型显式给出，只洗字不套计划规则。
      let title = cleaned.slice(0, 80);
      if (type !== 'topic') {
        const worth = cardWorthy(raw, { self: /^我[:：]/.test(String(c.detail || '')) });
        if (!worth) continue;
        title = worth.clean.slice(0, 80);
      }
      if (title.length < 6) continue;
      // ② Jev 关：值不值得长期记（弃权/出错 = 维持原判，不丢卡）
      if (jevOn) {
        const g = await jevGate('cardGate', title).catch(() => null);
        if (g && !g.error && g.abstain !== true) {
          if (g.label === 'SKIP') continue;
          if (g.label === 'PLAN' || g.label === 'FACT') type = g.label.toLowerCase();
        }
      }
      const r = this.upsert({
        type,
        chatKey,
        title,
        detail: String(c.detail || '').slice(0, 200),
        tags: Array.isArray(c.tags) ? c.tags : [type === 'plan' ? '计划' : type === 'fact' ? '事实' : '话题'],
        source: 'llm',
        ts: Number(ts) || Date.now()
      });
      if (r) n += 1;
    }
    return n;
  }
}
