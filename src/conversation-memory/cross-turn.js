// 跨轮工作记忆：最近若干轮的短档案，按新→旧注入，越近权重越高。
//
// 随时间淡忘（2026-09）：
//   · 每静默满 decayMin（默认 30 分钟，相对最新一轮的空窗），丢掉**最早**一轮；
//   · 活跃聊天时 gap 小 → 不丢；停 30 分钟丢 1 条、停 60 分钟丢 2 条……
//   · 另有整体 ttlMs（相对最新一轮的硬上限，旧 workingTtlMin）兜底。
//   · 注入时给每轮标「约 N 分钟前」，避免模型把隔了很久的事当成刚发生。
import fs from 'node:fs';
import path from 'node:path';
import { comparableReply, isQuietProtocolText, isReplyPlanningText } from '../reply-recovery.js';

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

function safeName(chatKey) {
  return String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
}

const RUN_FAILURE = /^\s*\[Error\]|模型请求(?:次数)?(?:异常|失败)|网络(?:错误|连不上|不通)|无法发送|发不出去|发送失败|已强制结束|防止刷屏|自动收尾|ECONN|ETIMEDOUT|fetch failed|HTTP\s*[45]\d\d|请求超时|输出被截断/i;
const PROMPT_ECHO = /^\s*【(?:过去状态|本次唤醒|语义卡|记忆|会话标识|当前时间|此刻状态|引导说明|最后一步)/;

/** 只让真正的模型想法进入下一轮，拦掉错误文本和提示词回显。 */
export function cleanThought(text, sent = []) {
  if (isQuietProtocolText(text) || isReplyPlanningText(text)) return '';
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (!value || RUN_FAILURE.test(value) || PROMPT_ECHO.test(value)) return '';
  if (/^#-?\d+$|<\/?(?:think|tool_call)>|^\s*[\[{].*"(?:messages|tool_calls)"/i.test(value)) return '';
  const key = comparableReply(value);
  const delivered = sent.filter(s => s?.type === 'text').map(s => comparableReply(s.text)).filter(Boolean);
  if (key && (delivered.some(k => k === key || k.includes(key)) || delivered.join('').includes(key))) return '';
  return value.slice(0, 200);
}

/**
 * finish 的 summary 缺席时，用「谁说了什么 + 我回了什么」拼一份「进展」。
 *
 * 为什么会缺席（2026-09-19）：
 *   ① 通用自动收尾：模型一轮里把话发完就结束，系统不再多跑一轮催它调 finish
 *      → 没有 finish 调用，也就没有 summary；
 *   ② 模型调了 finish 却没填 summary（本来就没兜底）。
 * 两种情况都会让跨轮工作记忆只剩「发过「xxx」」而丢掉「进展」——
 * 下一轮它就读不到"上一轮我在想什么、聊到哪儿了"。
 *
 * 为什么用模板拼而不是再调一次模型：
 *   自动收尾本来就是为了省掉一整轮，为了补 draft 再调一次模型等于白省。
 *   而真实 draft 长这样：「示例用户问我在干嘛，我接还在剪片子，顺便调侃他鲸门开宗立派」——
 *   本身就是对「触发 + 已发」的压缩，模板拼一份足够顶用，且零成本零延迟。
 *
 * 注意：只在**确实发出过文字**时生成；纯表情 / 没回话的轮次保持原样（draft 为空）。
 */
/**
 * 这条「没发出去的想法」值得注入下一轮吗？
 *
 * ⚠️ 2026-09-21 实测：跨轮记忆里存的是模型的**内心盘算原文**，例如——
 *   「群里正热闹聊「性欲值系统实装」…没人叫我，但我可以凑一句…藏头诗那张图：草原有子弹／
 *     草原怎会有子弹…不对，第一字连读是 草、草、我……不深究了，别编。比较稳的切入点是接…」
 * 把它喂回下一轮有三个坏处：
 *   ① 教模型用「盘算腔」说话（当晚真的泄漏过一条同款腔调：让它"顺着…接梗、不用查记忆"）；
 *   ② 让它去接早已翻篇的旧计划（「接"几只大胖鲸"这句」是 37 分钟前的了）；
 *   ③ 自我强化 —— 它看到自己上轮在盘算什么，就接着盘算，盘算又被存下来。
 * 只保留"短、且像状态/待办"的那种，例如「还在限流，等下一波再怼示例用户那句"我的token"」。
 * 被过滤掉的不删除，仍留在它自己的内心记录里（UI 可看）。
 */
export function isInjectableDraft(text) {
  const v = String(text || '').replace(/\s+/g, ' ').trim();
  if (!v) return false;
  if (v.length > 40) return false;                                     // 长句基本是盘算
  const clauses = v.split(/[，,。；;]/).filter((x) => x.trim().length >= 2);
  if (clauses.length > 2) return false;                                // 三个以上分句 = 在分析
  if (/(不深究|别编|再看|不对|可能|也许|大概|值得注意|问题是|所以|因为|如果|或者|要不|算了)/.test(v)) return false;
  if (/^\[[^\]]*\]/.test(v)) return false;
  return true;
}

function fallbackDraft(session) {
  const sentText = (session.sent || [])
    .filter((s) => s?.type === 'text')
    .map((s) => String(s.text || '').trim())
    .filter(Boolean);
  if (!sentText.length) return '';
  const trig = (session.trigger || [])
    .filter((m) => m && !m.self)
    .slice(0, 3)
    .map((m) => {
      const what = String(m.text || '').trim().slice(0, 30);
      if (!what) return '';
      return `${String(m.senderName || m.senderId || '对方')}：${what}`;
    })
    .filter(Boolean)
    .join('、');
  const bits = [];
  if (trig) bits.push(trig);
  bits.push(`我回：${sentText.slice(0, 3).map((t) => t.slice(0, 30)).join(' / ')}`);
  return bits.join('；');
}

// Operational failures belong in session logs, not in the character's thoughts.
export function conversationTurnPayload(session) {
  const sent = session.sent || [];
  const outcome = session.error ? 'error' : sent.length ? 'done' : 'noreply';
  const finish = [...(session.messages || [])].reverse().find(m =>
    m.toolCall?.name === 'finish' && !m.toolCall.isError);
  const summary = String(finish?.toolCall?.args?.summary || '').trim();
  const usable = !session.error && !session.repeatBlocks && !RUN_FAILURE.test(summary);
  // 心声：模型自己写的收尾独白（「（心声：…）」行，或被丢弃的内心戏）。
  // 优先级 finish.summary > 心声 > 模板兜底 —— 前两者是模型自己的话，模板只是最后保险。
  // 明确心声优先，候选各自清洗，不能让无效旧旁白遮住有效心声。
  const voice = cleanThought(session.innerVoice, sent) || cleanThought(session.unsentThought, sent);
  const fromTemplate = usable && !summary && !voice;
  return { outcome, sent,
    // summary 优先（是模型自己写的想法）；缺席时用心声；再缺席用模板兜底，别让"进展"整条空掉
    draft: usable ? (summary || voice || fallbackDraft(session)) : '',
    voice: !!(usable && !summary && voice),
    // 模板 draft 只是「谁说了啥+我回了啥」的压缩，与【过去状态】重复 → 渲染时跳过
    templateDraft: fromTemplate,
    lastQuery: '', unfinished: false, note: '' };
}

function cleanStoredTurn(turn) {
  const failed = turn.outcome === 'error' || RUN_FAILURE.test(String(turn.draft || ''));
  const draft = failed ? '' : (turn.voice ? cleanThought(turn.draft) : turn.draft);
  return { ...turn, draft,
    voice: !!(turn.voice && draft),
    templateDraft: failed ? false : !!turn.templateDraft,
    lastQuery: failed ? '' : turn.lastQuery,
    unfinished: !failed && turn.outcome !== 'noreply' && !!turn.unfinished };
}

function isUsefulTurn(turn) {
  if (!turn) return false;
  // 模板摘要来自本来就会注入的聊天记录，而且 render 明确不展示它。
  // 让它占 maxTurns 只会把真正的“未发送想法”挤出队列。
  if (turn.templateDraft && !turn.lastQuery && !turn.unfinished) return false;
  return !!(turn.sent?.length || turn.draft || turn.lastQuery || turn.unfinished);
}

function emptyPayload({
  outcome = '',
  draft = '',
  sent = [],
  voice = false,
  templateDraft = false,
  lastQuery = '',
  unfinished = false,
  note = ''
} = {}) {
  // 不把整段 sent 塞进跨轮渲染源：消息本体已在存档/【过去状态】里，
  // 跨轮只留进展摘要，避免「接线消息记录」重复灌 token。
  const sentText = (Array.isArray(sent) ? sent : [])
    .filter((s) => s?.type === 'text')
    .map((s) => String(s.text || '').slice(0, 40))
    .slice(0, 1);
  return {
    at: Date.now(),
    outcome: String(outcome || '').slice(0, 40),
    draft: String(draft || '').slice(0, 200),
    voice: !!voice,
    templateDraft: !!templateDraft,
    sent: templateDraft ? [] : sentText,
    lastQuery: String(lastQuery || '').slice(0, 60),
    unfinished: !!unfinished,
    note: String(note || '').slice(0, 80)
  };
}

/** 「约 N 分钟前 / 约 2 小时前」，给模型时间感。 */
export function ageLabel(at, now = Date.now()) {
  const ms = Math.max(0, now - (Number(at) || 0));
  const min = Math.floor(ms / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `约${min}分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `约${h}小时前`;
  return `约${Math.floor(h / 24)}天前`;
}

/**
 * 按空窗丢最早轮：空窗 = now - 最新一轮.at。
 * 丢弃条数 = floor(空窗 / decayMs)，从数组尾部（最旧）丢。
 * 返回新数组（不修改入参）。
 */
export function decayTurns(turns, { now = Date.now(), decayMs = 30 * 60000, maxTurns = 3 } = {}) {
  const list = (Array.isArray(turns) ? turns : []).filter(Boolean).slice(0, maxTurns);
  if (!list.length || !(decayMs > 0)) return list;
  const gap = now - (Number(list[0].at) || 0);
  if (gap < decayMs) return list;
  const drop = Math.floor(gap / decayMs);
  if (drop <= 0) return list;
  const keep = Math.max(0, list.length - drop);
  return list.slice(0, keep);
}

export class CrossTurnWorking {
  constructor(root, { ttlMin = 90, maxChars = 280, maxTurns = 3, decayMin = 30 } = {}) {
    this.root = path.resolve(root);
    this.ttlMs = Math.max(5, Number(ttlMin) || 90) * 60000;
    const d = Number(decayMin);
    // ≤0 或非法 → 关闭逐条淡忘（只留整体 TTL）
    this.decayMs = Number.isFinite(d) && d > 0 ? d * 60000 : 0;
    this.maxChars = Math.min(2000, Math.max(40, Number(maxChars) || 280));
    this.maxTurns = Math.max(1, Math.min(5, Number(maxTurns) || 3));
    ensure(this.root);
  }

  #file(chatKey) {
    return path.join(this.root, `${safeName(chatKey)}.json`);
  }

  #normTurns(raw) {
    if (!raw) return [];
    if (Array.isArray(raw)) return raw.filter(Boolean).slice(0, this.maxTurns);
    // 旧单轮对象
    if (raw.at || raw.draft || raw.sent || raw.lastQuery) return [raw];
    // 可能包了一层 { turns: [...] }
    if (Array.isArray(raw.turns)) return raw.turns.filter(Boolean).slice(0, this.maxTurns);
    return [];
  }

  /** 读盘 → 清洗 → 按空窗淡忘。整体超过 ttlMs 仍整段丢弃。 */
  load(chatKey, { now = Date.now() } = {}) {
    const raw = readJson(this.#file(chatKey), null);
    if (!raw) return null;
    let turns = this.#normTurns(raw.turns || raw).map(cleanStoredTurn).filter(isUsefulTurn);
    if (this.decayMs > 0) turns = decayTurns(turns, { now, decayMs: this.decayMs, maxTurns: this.maxTurns });
    if (!turns.length) return null;
    const latest = turns[0];
    if (now - (Number(latest.at) || 0) > this.ttlMs) return null;
    return { turns };
  }

  peekRaw(chatKey, { now = Date.now() } = {}) {
    const raw = readJson(this.#file(chatKey), null);
    if (!raw) return null;
    let turns = this.#normTurns(raw.turns || raw).map(cleanStoredTurn).filter(isUsefulTurn);
    if (this.decayMs > 0) turns = decayTurns(turns, { now, decayMs: this.decayMs, maxTurns: this.maxTurns });
    return turns.length ? { turns } : null;
  }

  saveAfterRun(chatKey, payload) {
    const turn = cleanStoredTurn(emptyPayload(payload));
    // 空轮：跳过保存，**不要**删掉已有历史（以前 unlink 会把前几轮一起冲掉）
    if (!isUsefulTurn(turn)) {
      return null;
    }
    // 先按当前空窗淡忘旧轮，再压入新轮 —— 停 30 分钟后再聊，最早那条已被丢掉
    const prev = this.load(chatKey);
    const turns = [turn, ...(prev?.turns || [])].slice(0, this.maxTurns);
    atomicWrite(this.#file(chatKey), { turns });
    return turn;
  }

  clear(chatKey) {
    try { fs.unlinkSync(this.#file(chatKey)); } catch { /* ignore */ }
  }

  /** 渲染：只注入「消息窗里看不到的进展」，不复读聊天记录。 */
  render(chatKey, { botName = '', now = Date.now() } = {}) {
    const w = this.load(chatKey, { now });
    if (!w?.turns?.length) return '';
    const weights = ['高', '中', '较低'];
    const lines = w.turns.slice(0, this.maxTurns).map((t, i) => {
      // 与【过去状态】重复的内容不进注入：
      // · sent 正文 = 刚说过的话
      // · templateDraft = 「谁说了啥+我回了啥」模板，同样来自消息记录
      if (t.templateDraft && !t.unfinished && !t.lastQuery) return null;
      const bits = [];
      if (t.draft && !t.templateDraft && isInjectableDraft(t.draft)) {
        bits.push(`${t.voice ? '未发送想法' : '进展'}「${String(t.draft).slice(0, 60)}」`);
      } else if (!t.templateDraft && !t.draft && t.sent?.length) {
        // 仅在没有进展摘要时带一句发过什么（报错收尾等）；有 draft 就不再复读消息
        bits.push(`发过「${String(t.sent[0] || '').slice(0, 12)}」`);
      }
      if (t.lastQuery) bits.push(`查过${t.lastQuery}`);
      if (t.unfinished) bits.push('没说完');
      if (!bits.length) return null;
      const tag = i === 0 ? '最近' : i === 1 ? '上次' : '更早';
      const weight = weights[Math.min(i, weights.length - 1)];
      const when = ageLabel(t.at, now);
      return `${tag}(${when}·权重${weight})：${bits.join('；')}`;
    }).filter(Boolean);
    if (!lines.length) return '';
    // 默认最多 2 条：第 3 条往往是更旧的重复语境，收益低、又挤提示词
    const shown = lines.slice(0, 2);
    const header = '【跨轮记忆】（未发送想法仅供参考，别复读）';
    const body = shown.map(s => `- ${s}`).join('\n');
    const room = this.maxChars - header.length - 1;
    return `${header}\n${body.length > room ? body.slice(0, room - 1) + '…' : body}`;
  }
}
