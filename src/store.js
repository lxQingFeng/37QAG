// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"过去状态"。
//
// ── 落盘分层（2026-09-22）───────────────────────────────────────────────
// 背景：单群存档无上限增长（号A 主群已 172,998 条 / 42.8MB），而每次收发消息都
// 全量 JSON.stringify + writeFileSync。实测 20,000 条 ≈ 34ms，线性外推 42.8MB
// ≈ 290ms **同步阻塞事件循环**；该群平均 9 条/分钟、峰值 416 条/10 分钟
// ⇒ 光"收消息"每天就触发约 13,000 次全量写 ≈ 63 分钟纯阻塞。
//
// 做法：**内存仍然全量，只在落盘上分层** —— 所以所有读路径（store.recent /
// findByMid / activeMembers / 存档页 API / 翻页工具 / 模型上下文）一行都不用改：
//
//   data/messages/<safe>.<slot>.json      热段：最近 hotPerChat 条，每次落盘（≈2ms）
//   data/messages-cold/<safe>.NNNNN.json  冷分片：更老的原文，写满 COLD_CHUNK 条就冻结
//
// 读取时按「冷分片序号 + 热段」拼回全量数组，顺序仍是 id 升序。
// 绕过 store 直接读文件的模块（conversation-memory 的几个）改用 readAllMessages()。
//
// ── 热段为什么用「双缓冲直接覆盖」而不是 tmp+rename ──
// 实测（2026-09-22，D 盘与 E 盘一致）：
//   renameSync 单次          ≈ 23ms   ← 与数据量、目标是否存在都无关
//   writeFileSync 覆盖同文件  ≈ 1.0ms
//   appendFileSync          ≈ 0.9ms
//   JSON.stringify(3000 条) ≈ 2.2ms、(20000 条) ≈ 14.6ms
// 也就是说，writeJsonAtomic 的 tmp+rename 让每次落盘白付 23ms —— 它比序列化本身
// 还贵一个量级，是系统级重命名开销（杀毒/文件系统过滤驱动）。
// 改成两个槽轮换：每次只**覆盖**非当前槽（1ms），另一槽留着上一版完整内容。
// 崩溃时最坏只有"正在写的那个槽"半截，另一槽仍能完整解析 —— 原子性与原
// tmp+rename 等价（都只丢最后一次写），加载时取 nextLocalId 大的那个。
// 冷分片仍走 writeJsonAtomic：它低频（攒够半片才写一次），安全性更值得。
//
// 两个细节：
//   · 归档水位：热段涨到 hotPerChat*2 才一次性降回 hotPerChat。不这么做的话
//     每来一条消息都溢出 1 条、都要重写一次冷分片，白付 I/O。
//   · 冷段消息一律视为已读（归档时强制 read=true）。所以 markAllRead /
//     drainUnread 只需写热段，冷段不会出现"加载后又变成未读"的鬼故事。
//
// `maxMessagesPerChat > 0`（用户在 UI 里设了上限）时语义是"磁盘上也别留"：
// 裁剪会连同冷分片一起清掉。默认 0（不限），只用 hotPerChat 控制热段大小。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位**和模型引用**）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text, ref? }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
//
// ── 为什么给模型看的是"短编号"而不是 QQ 消息 id（2026-09-22 实测后改的）──
// QQ 消息 id 是 9~10 位、常带负号的整数（实测 #-1000000001 / #1000000001）。
// 刷屏时提示词里一屏十几个这种数字，模型**抄不动**，它就直接现编一个"长得像"的：
// 对 data*/sessions 的 7763 份会话存档做对账，模型带过 replyToMessageId 的调用 2756 次，
// 其中 **2089 次（76%）的 id 在本会话消息库里不存在**（连冷分片一起查过），
// 1951 个还是各不相同的值 —— 是编的，不是抄错。而当时我们一句不校验就发给了 OneBot，
// 于是就有了"引用错"（引用到无关消息 / 引用失效）。
// 现在给模型看 `id`（本地递增序号：从 1 开始、稠密、短、跨重启稳定、永不复用），
// 原始 mid 仍然接受（旧会话的上下文和记忆文件里存的是它）—— 两者由 findByRef 统一解析。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { writeJsonAtomic } from './util.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');
export const COLD_DIR = path.join(DATA_DIR, 'messages-cold');

/** 单个冷分片的条数上限。写满即冻结（不再重写），只有最后一片可追加。 */
export const COLD_CHUNK = 5000;

// 热段默认条数。3000 条 ≈ 0.8MB ≈ 5ms 落盘；同时远大于读侧上限
// （store.allCount 默认 80、翻页工具单次最多 100、记忆里的 recent(limit:2000)），
// 所以分层不会让任何读取路径"读不到它原本能读到的东西"。
export const DEFAULT_HOT_PER_CHAT = 3000;

function safeKey(chatKey) {
  return String(chatKey).replace(/[^a-z0-9_]/gi, '_');
}

/**
 * 把模型给的编号归一化：去井号（`#` / 全角 `＃`）、去空白、去掉多余的 `.0`
 * （模型偶尔把整数写成 `318.0`）。**只能有这一处实现** —— 解析规则散落两处必然改漏一处。
 */
export function normalizeRef(ref) {
  return String(ref ?? '').trim().replace(/^[#＃]+/, '').replace(/\.0+$/, '').trim();
}

/**
 * 一条消息"给模型看的短编号"（写作 `#318`）。
 * 一律用本地的递增序号 `id`；只有拿不到 id 的历史条目才退回 QQ mid（保证老存档也能显示个东西）。
 * prompt.js 渲染聊天记录、tools.js 返回 messageId 都用它，**只能有这一处实现**：
 * 之前踩过"同一个判定散落两处、改了一处漏一处"的坑（海龟汤汤底门槛）。
 */
export function msgRef(m) {
  const n = Number(m?.id);
  if (Number.isFinite(n) && n > 0) return `#${n}`;
  const mid = m?.mid;
  if (mid === null || mid === undefined || String(mid) === '') return '';
  return `#${mid}`;
}

function chatFile(chatKey, messagesDir = MESSAGES_DIR) {
  return path.join(messagesDir, `${safeKey(chatKey)}.json`);
}

function coldChunkFile(chatKey, seq, coldDir = COLD_DIR) {
  return path.join(coldDir, `${safeKey(chatKey)}.${String(seq).padStart(5, '0')}.json`);
}

function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;   // 不存在 / 半截文件都当空
  }
}

/** 按序号列出某会话已有的冷分片序号（升序）。 */
function listColdSeqs(chatKey, coldDir) {
  const prefix = `${safeKey(chatKey)}.`;
  try {
    return fs.readdirSync(coldDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith('.json'))
      .map((f) => Number(f.slice(prefix.length, -'.json'.length)))
      .filter((n) => Number.isInteger(n) && n >= 0)
      .sort((a, b) => a - b);
  } catch {
    return [];   // 目录不存在 = 还没有冷段
  }
}

/**
 * 加载一个会话的完整状态：冷分片（按序号）+ 热段，拼成全量消息数组。
 * @returns {{ chatKey, nextLocalId, coldMessages, hotMessages, chunks }}
 *          chunks: [{ seq, start, len }]，start 是相对全量数组的下标
 */
function loadChatState(chatKey, messagesDir, coldDir) {
  const chunks = [];
  let coldMessages = [];
  for (const seq of listColdSeqs(chatKey, coldDir)) {
    const j = readJson(coldChunkFile(chatKey, seq, coldDir));
    const arr = j && Array.isArray(j.messages) ? j.messages : [];
    if (!arr.length) continue;
    chunks.push({ seq, start: coldMessages.length, len: arr.length });
    coldMessages = coldMessages.concat(arr);
  }
  const hot = readJson(chatFile(chatKey, messagesDir));
  const hotMessages = hot && Array.isArray(hot.messages) ? hot.messages : [];
  return { chatKey, nextLocalId: hot?.nextLocalId, coldMessages, hotMessages, chunks };
}

/**
 * 读一个会话的**全量**消息（冷分片 + 热段，id 升序）。
 *
 * 给「绕过 store 直接读 messages 文件」的模块用：conversation-memory 的
 * archive / consolidator / cross-chat 原先各自 readFileSync(<messagesDir>/<safe>.json)，
 * 分层后那样只能读到热段、会静默丢掉更早的历史。签名与原 loadMessages 一致，
 * 所以调用方只换函数名、其余一行不用改。
 *
 * @param {string} messagesDir 热段目录（形如 <DATA_DIR>/messages）
 * @param {string} chatKey     group:123 / private:456
 * @returns {object[]} 全量消息数组
 */
export function readAllMessages(messagesDir, chatKey) {
  const dir = messagesDir || MESSAGES_DIR;
  const coldDir = path.join(path.dirname(dir), 'messages-cold');
  const st = loadChatState(chatKey, dir, coldDir);
  return st.coldMessages.concat(st.hotMessages);
}

function loadChat(chatKey) {
  const { nextLocalId, coldMessages, hotMessages, chunks } = loadChatState(chatKey, MESSAGES_DIR, COLD_DIR);
  const total = coldMessages.length;
  const last = chunks.length ? chunks[chunks.length - 1] : null;
  return {
    chatKey,
    nextLocalId: nextLocalId ?? (total + hotMessages.length + 1),
    messages: coldMessages.concat(hotMessages),
    // 冷段运行状态（下划线开头 = 存储层自用，读路径不要碰）
    _cold: {
      total,                                   // 已归档条数 == 热段在全量数组里的起始下标
      chunks,                                  // [{ seq, start, len }]
      seq: last ? last.seq : -1,               // 当前可追加的分片序号（-1 = 还没有冷段）
      lastLen: last ? last.len : 0,
      last: last ? coldMessages.slice(last.start, last.start + last.len) : null
    }
  };
}

function saveColdChunk(chatKey, seq, messages) {
  writeJsonAtomic(coldChunkFile(chatKey, seq), { chatKey, seq, messages });
}

export class ChatStore {
  constructor(maxPerChat = 0, hotPerChat = DEFAULT_HOT_PER_CHAT) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.hotPerChat = Math.max(0, Number(hotPerChat) || 0);
    this.chats = new Map(); // chatKey -> state
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  /** 热段条数；0 = 不分层（退回单文件全量写，仅用于排障对照）。 */
  setHotPerChat(n) {
    this.hotPerChat = Math.max(0, Number(n) || 0);
  }

  #state(chatKey) {
    if (!this.chats.has(chatKey)) this.chats.set(chatKey, loadChat(chatKey));
    return this.chats.get(chatKey);
  }

  /** 只写热段（+ 层时）或全量（hotPerChat=0 时）。 */
  #save(st) {
    const start = this.hotPerChat > 0 ? st._cold.total : 0;
    writeJsonAtomic(chatFile(st.chatKey), {
      chatKey: st.chatKey,
      nextLocalId: st.nextLocalId,
      messages: st.messages.slice(start)
    });
  }

  /** 热段超过水位（hotPerChat*2）时，一次性把它降回 hotPerChat。 */
  #maybeArchive(st) {
    // 设了硬上限就根本不需要冷段：上限的语义是"磁盘上也不留"，#trim 会把冷分片清掉，
    // 这里再归档就变成"每次 append 都建了又删"。hotPerChat=0 同理（不分层）。
    if (this.maxPerChat > 0 || this.hotPerChat <= 0) return;
    const hotLen = st.messages.length - st._cold.total;
    if (hotLen <= this.hotPerChat * 2) return;
    this.#archive(st, hotLen - this.hotPerChat);
  }

  /** 把全量数组里 [total, total+count) 这段搬进冷分片（写满一片就开下一片）。 */
  #archive(st, count) {
    let idx = st._cold.total;
    let remain = count;
    while (remain > 0) {
      if (!st._cold.last || st._cold.lastLen >= COLD_CHUNK) {
        st._cold.seq = st._cold.last ? st._cold.seq + 1 : 0;
        st._cold.last = [];
        st._cold.lastLen = 0;
        st._cold.chunks.push({ seq: st._cold.seq, start: idx, len: 0 });
      }
      const take = Math.min(COLD_CHUNK - st._cold.lastLen, remain);
      const slice = st.messages.slice(idx, idx + take);
      // 冷段一律视为已读：这样 markAllRead/drainUnread 只写热段也不会漏状态。
      for (const m of slice) m.read = true;
      st._cold.last.push(...slice);
      st._cold.lastLen += take;
      st._cold.total += take;
      idx += take;
      remain -= take;
      st._cold.chunks[st._cold.chunks.length - 1].len = st._cold.lastLen;
      saveColdChunk(st.chatKey, st._cold.seq, st._cold.last);
    }
  }

  /** 清空该会话全部冷分片（用户在 UI 设了硬上限时用：上限的语义是磁盘上也不留）。 */
  #clearCold(st) {
    for (const c of st._cold.chunks) {
      try { fs.rmSync(coldChunkFile(st.chatKey, c.seq), { force: true }); } catch { /* 删不掉就算了 */ }
    }
    st._cold.chunks = [];
    st._cold.seq = -1;
    st._cold.last = null;
    st._cold.lastLen = 0;
    st._cold.total = 0;
  }

  listChats() {
    // 从磁盘文件名还原（group_123.json -> group:123），已加载的直接带上
    try {
      const files = fs.readdirSync(MESSAGES_DIR).filter((f) => /^(group|private)_\d+\.json$/.test(f));
      for (const f of files) {
        const m = /^(group|private)_(\d+)\.json$/.exec(f);
        if (m) this.#state(`${m[1]}:${m[2]}`);
      }
    } catch { /* 目录不存在 */ }
    return [...this.chats.keys()];
  }

  /**
   * 把"文件已经不在磁盘上了"的会话从内存里清掉（幽灵记录）。
   *
   * 为什么需要（2026-09-22 用户反馈「存档里说的存储的地方删了之后还是会有记录」）：
   *   会话列表/存档页是从内存里的 `this.chats` 渲染的，而内存状态只在**首次访问**时从
   *   磁盘加载。用户手动删掉 data/messages/xxx.json 之后，进程里那份状态还在，
   *   列表照样显示、还能翻出消息 —— 看着就像"删了没生效"。
   *   这里在列列表时顺手核对一次"热段文件还在不在"，不在就丢掉内存状态（节流 30 秒，
   *   避免每次刷新都做一轮 stat）。
   *
   * @returns {number} 被清掉的会话数
   */
  pruneMissingFiles() {
    const now = Date.now();
    if (this._prunedAt && now - this._prunedAt < 30000) return 0;
    this._prunedAt = now;
    let dropped = 0;
    for (const key of [...this.chats.keys()]) {
      try {
        if (fs.existsSync(chatFile(key))) continue;
      } catch { /* stat 失败也当作不存在 */ }
      this.chats.delete(key);
      dropped += 1;
    }
    return dropped;
  }

  /**
   * 清空某个会话的全部消息记录（热段 + 冷分片 + 内存状态）。
   * @returns {{chatKey:string, removedFiles:number, messages:number}}
   */
  purgeChat(chatKey) {
    const key = String(chatKey || '');
    const st = this.chats.get(key);
    const messages = st ? st.messages.length : loadChat(key).messages.length;
    let removed = 0;
    const rm = (file) => { try { if (fs.existsSync(file)) { fs.rmSync(file, { force: true }); removed += 1; } } catch { /* ignore */ } };
    rm(chatFile(key));
    for (const seq of listColdSeqs(key, COLD_DIR)) rm(coldChunkFile(key, seq));
    this.chats.delete(key);
    return { chatKey: key, removedFiles: removed, messages };
  }

  /** 清空**所有**会话的消息记录（连冷分片目录一起）。 */
  purgeAll() {
    const keys = this.listChats();
    let removedFiles = 0;
    let messages = 0;
    for (const key of keys) {
      const r = this.purgeChat(key);
      removedFiles += r.removedFiles;
      messages += r.messages;
    }
    // 兜底：内存里可能有磁盘上已无文件的会话（幽灵），一并清掉
    this.chats.clear();
    return { chats: keys.length, removedFiles, messages };
  }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read).length;
    const last = st.messages[st.messages.length - 1] || null;
    return { chatKey, total: st.messages.length, unread, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  /**
   * 追加一条收到的消息（未读）。返回写入的条目。
   *
   * ⚠️ 这里**只观察、不去重**：同一条消息被上游（SnowLuma/QQ）发两遍时，
   * 两次的 QQ 消息 id 往往不同，应用从数据上分不出"同一条"；
   * 而按"同人+同文+几秒内"硬去重会误杀真实场景（连发两条"哈哈哈""？"是正常的）。
   * 所以只做标记（dupSuspect / dupGapMs / dupPrevMid / dupMediaDiff），
   * 消息照存不误 —— 以后要定位到底是哪一层重发，看这些标记就有据可查。
   */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [] }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : []
    };

    // ── 疑似重复：只打标记，不丢不合并 ──
    const DUP_WINDOW_MS = 8000;
    const textKey = entry.text.trim();
    if (textKey) {
      for (let i = st.messages.length - 1; i >= 0 && i >= st.messages.length - 30; i -= 1) {
        const prev = st.messages[i];
        if (prev.self) continue;
        if (String(prev.mid ?? '') === String(entry.mid ?? '')) continue;   // 同 id 属于"同一条被存两次"，另有其因
        if (prev.senderId !== entry.senderId) continue;
        const gap = entry.ts - Number(prev.ts || 0);
        if (gap < 0 || gap > DUP_WINDOW_MS) continue;
        if (String(prev.text || '').trim() !== textKey) continue;
        entry.dupSuspect = true;
        entry.dupGapMs = gap;
        entry.dupPrevMid = prev.mid ?? null;
        const prevUrls = (prev.media || []).map((m) => m && m.url).filter(Boolean).join('|');
        const nowUrls = (entry.media || []).map((m) => m && m.url).filter(Boolean).join('|');
        entry.dupMediaDiff = prevUrls !== nowUrls;
        break;
      }
    }

    st.messages.push(entry);
    this.#trim(st);
    this.#maybeArchive(st);
    this.#save(st);
    return entry;
  }

  /**
   * 记录机器人自己发出的消息（已读）。hype=true 时标记亢奋，摘要可过滤。
   * reply：这条消息引用了哪条（{ ref, mid, sender, text }）——
   * 以前自己发的消息**不记引用**，所以"引用错"发生时既看不到引用了谁、也无从对账。
   */
  appendSelf(chatKey, { text, ts, mid = null, hype = false, reply = null }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: reply || null,
      media: []
    };
    if (hype) entry.hype = true;
    st.messages.push(entry);
    this.#trim(st);
    this.#maybeArchive(st);
    this.#save(st);
    return entry;
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    // 没有未读 = 一次状态变化都没有，直接返回。
    // ⚠️ 原来这里无条件 saveChat：orchestrator 每轮唤醒连着调两次 drainUnread
    //   （一个取触发批、一个"把零星未读一并处理掉"），第二次基本是全量写了个寂寞。
    if (!unread.length) return unread;
    for (const m of st.messages) m.read = true;
    this.#save(st);
    return unread;
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey) {
    const st = this.#state(chatKey);
    let n = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) { m.read = true; n++; }
    }
    if (n) this.#save(st);
    return n;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /** 查看当前未读消息（不置已读），用于“等待中”会话的触发摘要。 */
  peekUnread(chatKey, limit = 3) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).slice(0, Math.max(1, Number(limit) || 3));
  }

  /**
   * 取最近的若干条。
   *
   * ⚠️ 2026-09-22 改成从尾部倒扫：原实现是 `all.filter(...)` + `slice(0,-offset)`，
   * 前者对 includeSelf=false 是 O(n) 全表遍历建新数组、后者是 O(n) 浅拷贝，
   * 而 172,998 条的群每轮要调十几次 —— 白付几十毫秒。现在只扫到取够 limit 就停。
   * 语义保持与原实现一致：offset = 在（过滤后的）序列里跳过最近 N 条。
   */
  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    const lim = Math.max(1, Number(limit) || 1);
    const off = Math.max(0, Number(offset) || 0);
    const out = [];
    let skipped = 0;
    for (let i = st.messages.length - 1; i >= 0; i -= 1) {
      const m = st.messages[i];
      if (!includeSelf && m.self) continue;
      if (skipped < off) { skipped += 1; continue; }
      out.push(m);
      if (out.length >= lim) break;
    }
    out.reverse();
    return out;
  }

  /**
   * 按"模型给的引用目标"找消息：**先当 QQ message_id，再当本地短编号**。
   *
   * 两种写法都要认：
   *   · 短编号 `#318` / `318`：现在提示词给模型看的（短、好抄、不会编）；
   *   · 原始 mid `-1000000001`：旧会话里模型自己写过的工具参数、记忆文件里存的老 id 都长这样。
   * 顺序是先 mid 后本地号：mid 要么是 9~10 位、要么带负号，几乎不可能和本地小编号撞上。
   */
  findByRef(chatKey, ref) {
    const st = this.#state(chatKey);
    const raw = normalizeRef(ref);
    if (!raw) return null;
    const byMid = st.messages.find((m) => String(m.mid) === raw);
    if (byMid) return byMid;
    if (/^\d{1,7}$/.test(raw)) {
      const n = Number(raw);
      return st.messages.find((m) => Number(m.id) === n) || null;
    }
    return null;
  }

  /** 兼容旧名字：语义等同于 findByRef（短编号也认）。 */
  findByMid(chatKey, mid) {
    return this.findByRef(chatKey, mid);
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本
   * —— 一次展开，以后谁（模型/存档页/金句）都直接读到内容。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const idx = st.messages.findIndex((x) => String(x.mid) === target);
    if (idx < 0) return false;
    const m = st.messages[idx];
    if (text != null) m.text = String(text);
    if (appendMedia.length) {
      m.media = Array.isArray(m.media) ? m.media : [];
      const seen = new Set(m.media.map((x) => x && x.url));
      for (const x of appendMedia) {
        if (x && x.url && !seen.has(x.url)) { m.media.push(x); seen.add(x.url); }
      }
    }
    if (idx >= st._cold.total) {
      this.#save(st);   // 热段：常规路径
    } else {
      // 冷段（极罕见：模型翻页翻到很老的消息再展开）。重写它所在的那一片。
      const c = st._cold.chunks.find((x) => idx >= x.start && idx < x.start + x.len);
      if (c) saveColdChunk(st.chatKey, c.seq, st.messages.slice(c.start, c.start + c.len));
    }
    return true;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  #trim(st) {
    if (this.maxPerChat <= 0 || st.messages.length <= this.maxPerChat) return;
    // 设了硬上限 = 磁盘上也别留，所以冷分片一并清掉再裁内存。
    this.#clearCold(st);
    st.messages.splice(0, st.messages.length - this.maxPerChat);
  }
}
