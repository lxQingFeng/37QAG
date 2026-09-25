// 会话（运行）记录：每次 agent 处理 = 一个会话，完整留档供 UI 查看。
// 文件：data/sessions/<id>.json；索引在内存里维护（最近优先）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';
import { getUsageLedger } from './usage-ledger.js';

const SESSIONS_DIR = path.join(DATA_DIR, 'sessions');

export function newSessionId() {
  return `${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

export function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

/**
 * 读一个 JSON 文件，容忍 BOM。
 *
 * ⚠️ 2026-09-22：这里原来直接 JSON.parse(readFileSync(...)) —— 而 Windows 记事本 /
 *   PowerShell 的 `Set-Content -Encoding UTF8` 写出来的文件**带 BOM**，
 *   JSON.parse('\uFEFF{…}') 会抛错，于是 `#loadIndex` 的 catch 把整个会话静默跳过：
 *   文件明明在 data/sessions/ 里，列表里却一条都没有（用户看到的就是"存档不见了/删不掉"）。
 *   config.js / store.js 早就做了 BOM 兼容，这里补上。
 */
function readJsonLoose(file) {
  const text = fs.readFileSync(file, 'utf8');
  return JSON.parse(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);
}

export class SessionRegistry {
  /**
   * @param {number} keepFiles 保留最近多少个会话记录文件；**0 = 不限制**。
   *   注意：不能用 `x || 300` 兜底 —— 0 是 falsy 会被误当成"未设置"变回 300，
   *   用户想"取消上限"就永远改不掉。也不能 Math.max(20,…) 强制下限。
   */
  constructor(keepFiles = 0) {
    this.keepFiles = Math.max(0, Number.isFinite(Number(keepFiles)) ? Math.round(Number(keepFiles)) : 0);
    this.index = [];   // [{ id, chatKey, startedAt, endedAt, status, outcome, usage, trigger, model, promptChars }]
    this.current = new Map(); // id -> session object（运行中的在内存里）
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.#loadIndex();
  }

  #loadIndex() {
    try {
      const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort().reverse();
      // keepFiles=0 表示不限制，全部加载
      const pick = this.keepFiles > 0 ? files.slice(0, this.keepFiles) : files;
      // 启动时把「还停在 running/waiting、但早就该结束」的磁盘会话标成 error，
      // 避免重启后列表里一排假「运行中」（0 tok / 0 轮）。
      const now = Date.now();
      const STALE_MS = 15 * 60 * 1000;
      for (const f of pick) {
        try {
          const full = path.join(SESSIONS_DIR, f);
          let data = readJsonLoose(full);
          if (data?.id && (data.status === 'running' || data.status === 'waiting')) {
            const started = Number(data.startedAt || 0);
            const wait = Number(data.waitUntil || 0);
            if (data.status === 'waiting' && wait && now - wait > 90 * 1000) {
              // 等待窗早已过去却还没开跑：定时器丢了 / 并发路径漏接，别再挂着「启动…」
              data.status = 'aborted';
              data.error = data.error || '等待启动超时（疑似定时器丢失），已自动收尾';
              data.endedAt = data.endedAt || now;
              data.waitUntil = null;
              fs.writeFileSync(full, JSON.stringify(data), 'utf8');
            } else if (!wait && started && now - started > STALE_MS) {
              data.status = 'error';
              data.error = data.error || '进程重启后仍停在运行中，已标为异常（疑似中断未收尾）';
              data.endedAt = data.endedAt || now;
              fs.writeFileSync(full, JSON.stringify(data), 'utf8');
            }
          }
          if (data?.id) this.index.push(this.#summary(data));
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录还没建 */ }
  }

  #summary(s) {
    return {
      id: s.id,
      chatKey: s.chatKey,
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      status: s.status,                      // waiting | running | done | noreply | error | aborted
      waitUntil: s.waitUntil ?? null,
      activity: s.activity ?? '',
      activityAt: s.activityAt ?? null,        // UI 用它显示"已等 N 秒"（区分慢和卡死）
      webSearchCount: s.webSearchCount ?? 0,
      outcome: s.outcome ?? null,            // { sent: n, finishReason }
      usage: s.usage ?? null,
      model: s.model ?? '',
      trigger: s.triggerSummary ?? '',
      promptChars: s.promptChars ?? 0,
      rounds: s.rounds ?? 0
    };
  }

  create({ chatKey, trigger, triggerSummary, status = 'running', waitUntil = null }) {
    const session = {
      id: newSessionId(),
      chatKey,
      startedAt: Date.now(),
      endedAt: null,
      status,
      waitUntil,
      trigger,                                 // 'message' | 'proactive'
      triggerSummary: String(triggerSummary ?? '').slice(0, 120),
      triggerText: String(triggerEntriesToText(trigger) ?? ''),
      systemPrompt: '',
      userPrompt: '',
      promptChars: 0,
      model: '',
      rounds: 0,
      messages: [],                            // OpenAI 消息序列（含工具调用与结果）
      sent: [],                                // 实际发出的每一条
      feedbacks: [],
      finishReason: null,
      error: null,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, calls: 0 }
    };
    this.current.set(session.id, session);
    this.#persist(session);
    this.index.unshift(this.#summary(session));
    if (this.keepFiles > 0) this.index = this.index.slice(0, this.keepFiles);
    return session;
  }

  get(id) {
    if (this.current.has(id)) {
      const s = this.current.get(id);
      return structuredClone(s);
    }
    try {
      const data = readJsonLoose(sessionFile(id));
      return data;
    } catch {
      return null;
    }
  }

  /**
   * 不克隆的读取：**只用于"读出来马上序列化"的热路径**（如 SSE 广播）。
   * 运行中的会话每次 session-update 都要走一次，get() 的 structuredClone
   * 会把整个会话（含每轮 raw 响应）全量复制一遍 —— 纯序列化用不到这份拷贝。
   * ⚠️ 返回的是活对象，调用方绝对不能改它；要改请用 get()。
   */
  peek(id) {
    if (this.current.has(id)) return this.current.get(id);
    try {
      return readJsonLoose(sessionFile(id));
    } catch {
      return null;
    }
  }

  update(id) {
    const s = this.current.get(id);
    if (s) {
      this.#persistThrottled(s);
      const idx = this.index.findIndex((e) => e.id === id);
      if (idx >= 0) this.index[idx] = this.#summary(s);
    }
    return s ?? null;
  }

  /** 设置运行中的活动状态（思考/调用工具）并广播。 */
  setActivity(id, activity) {
    const s = this.current.get(id);
    if (!s) return null;
    s.activity = String(activity ?? '');
    this.update(id);
    return s;
  }

  finish(id, status) {
    const s = this.current.get(id);
    if (!s) return null;
    s.status = status;
    s.endedAt = Date.now();
    this.current.delete(id);
    this._lastPersistAt?.delete(id);   // 节流时间戳随会话结束清理，防止 map 无限增长
    this.#persist(s);
    const idx = this.index.findIndex((e) => e.id === id);
    if (idx >= 0) this.index[idx] = this.#summary(s);
    // 清理超出保留数的旧文件
    try {
      if (this.keepFiles > 0) {
        const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json')).sort();
        if (files.length > this.keepFiles) {
          for (const f of files.slice(0, files.length - this.keepFiles)) {
            try {
              fs.unlinkSync(path.join(SESSIONS_DIR, f));
              if (f.endsWith('.json')) getUsageLedger().remove(f.slice(0, -5));
            } catch { /* ignore */ }
          }
        }
      }
    } catch { /* ignore */ }
    return s;
  }

  /**
   * 彻底丢弃一个会话：从内存索引移除 + 删掉磁盘文件，**不留"中止"记录**。
   *
   * 用途：档位判定"这次不响应"时，连"等待中"会话都不该出现在会话页
   * （否则用户会看到一堆等半天最后变"中止"的条目，还以为出错了）。
   * 与 finish(id,'aborted') 的区别：finish 是"开始了但没成"，会留下痕迹；
   * 这个是"压根没开始"，干净消失。
   *
   * ⚠️ 只用于从未真正运行过的会话（status='waiting'）。
   *    已经跑过并消耗了 token 的会话要走 finish，别用这个抹掉用量记录。
   */
  discard(id) {
    if (!id) return false;
    const s = this.current.get(id);
    // 已运行过的不允许丢弃（会抹掉用量/成本记录，导致对不上账）
    if (s && s.status !== 'waiting') return false;
    this.current.delete(id);
    const before = this.index.length;
    this.index = this.index.filter((e) => e.id !== id);
    try {
      const f = path.join(SESSIONS_DIR, `${id}.json`);
      if (fs.existsSync(f)) fs.unlinkSync(f);
    } catch { /* ignore */ }
    try { getUsageLedger().remove(id); } catch { /* ignore */ }
    return this.index.length < before;
  }

  listSummaries(limit = 100) {
    // 幽灵条目自愈：文件被手动删掉（或在文件管理器里清了存档目录）之后，
    // 内存索引里还留着条目，列表照旧显示 —— 用户看到的就是「删了还有记录」。
    // 这里顺手核对一次文件的存亡（节流 30 秒，避免每次刷新都 stat 上百个文件）。
    this.pruneMissingFiles();
    return this.index.slice(0, limit);
  }

  /** 丢掉"磁盘文件已经不在"的索引条目（幽灵记录）。返回清掉的条数。 */
  pruneMissingFiles() {
    const now = Date.now();
    if (this._prunedAt && now - this._prunedAt < 30000) return 0;
    this._prunedAt = now;
    const before = this.index.length;
    this.index = this.index.filter((e) => {
      // 正在跑的会话文件可能还没落盘，别误删
      if (this.current.has(e.id)) return true;
      try { return fs.existsSync(path.join(SESSIONS_DIR, `${e.id}.json`)); } catch { return false; }
    });
    return before - this.index.length;
  }

  /**
   * 清空消息/会话记录。
   *
   * ⚠️ 这是**破坏性**操作，只由 UI 的「一键清洗」调用（见 app.js 的 /api/purge-records）。
   *    正在运行的会话不会被删（先让它跑完，避免半路把上下文抽掉）。
   *
   * @param {{chatKey?: string|null, all?: boolean}} opts chatKey=null 且 all=false 时等于只清索引外的？
   * @returns {{removedFiles:number, removedSessions:number, keptRunning:number}}
   */
  purge({ chatKey = null, all = false } = {}) {
    let removedFiles = 0;
    let removedSessions = 0;
    let keptRunning = 0;
    const keep = [];
    for (const e of this.index) {
      const match = all || (chatKey && e.chatKey === chatKey);
      if (!match) { keep.push(e); continue; }
      if (this.current.has(e.id)) { keep.push(e); keptRunning += 1; continue; }
      try {
        const f = path.join(SESSIONS_DIR, `${e.id}.json`);
        if (fs.existsSync(f)) { fs.unlinkSync(f); removedFiles += 1; }
      } catch { /* ignore */ }
      try { getUsageLedger().remove(e.id); } catch { /* ignore */ }
      removedSessions += 1;
    }
    this.index = keep;
    return { removedFiles, removedSessions, keptRunning };
  }

  /** 今日 token 统计（含运行中的）。 */
  todayUsage(dayKey) {
    let promptTokens = 0;
    let completionTokens = 0;
    let totalTokens = 0;
    let cachedTokens = 0;
    let runs = 0;
    let webSearchCount = 0;
    // 结束的会话记在汇总文件里
    try {
      const data = readJsonLoose(path.join(DATA_DIR, 'usage-today.json'));
      if (data?.dayKey === dayKey) {
        promptTokens = data.promptTokens || 0;
        completionTokens = data.completionTokens || 0;
        totalTokens = data.totalTokens || 0;
        cachedTokens = data.cachedTokens || 0;
        runs = data.runs || 0;
        webSearchCount = data.webSearchCount || 0;
      }
    } catch { /* 无记录 */ }
    // 加上运行中的
    for (const s of this.current.values()) {
      promptTokens += s.usage.promptTokens;
      completionTokens += s.usage.completionTokens;
      totalTokens += s.usage.totalTokens;
      cachedTokens += Number(s.usage.cachedTokens) || 0;
      webSearchCount += Number(s.webSearchCount) || 0;
    }
    return { dayKey, promptTokens, completionTokens, totalTokens, cachedTokens, runs, webSearchCount };
  }

  /** 在会话结束时累加今日用量。 */
  #bumpTodayUsage(s) {
    const dayKey = localDayKey(s.startedAt);
    let data = { dayKey, promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, runs: 0, webSearchCount: 0 };
    try {
      const parsed = readJsonLoose(path.join(DATA_DIR, 'usage-today.json'));
      if (parsed?.dayKey === dayKey) data = parsed;
    } catch { /* 新的一天 */ }
    data.promptTokens += s.usage.promptTokens;
    data.completionTokens += s.usage.completionTokens;
    data.totalTokens += s.usage.totalTokens;
    data.cachedTokens = (data.cachedTokens || 0) + (Number(s.usage.cachedTokens) || 0);
    data.runs += 1;
    data.webSearchCount = (data.webSearchCount || 0) + (Number(s.webSearchCount) || 0);
    const tmp = path.join(DATA_DIR, 'usage-today.json.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf8');
    fs.renameSync(tmp, path.join(DATA_DIR, 'usage-today.json'));
  }

  /**
   * 运行中会话的落盘节流：每个会话 2 秒内最多写一次盘。
   *
   * 曾经 update() 每次都 #persist —— activity 翻转（每轮 2 次）、每个工具调用
   * 都会同步 writeFileSync 整个会话 JSON（含提示词与所有消息，越跑越大）。
   * 同步写盘阻塞 event loop，排在后面的 SSE 广播/HTTP 响应全被拖慢。
   *
   * 可靠性：finish() 仍走 #persist 直接落最终态，所以留档完整性不变；
   * 代价是进程崩溃时最多丢 2 秒的运行中进度（索引摘要不受影响，在内存里）。
   */
  #persistThrottled(s) {
    const now = Date.now();
    this._lastPersistAt ||= new Map();
    const last = this._lastPersistAt.get(s.id) || 0;
    if (now - last < 2000) return;
    this._lastPersistAt.set(s.id, now);
    this.#persist(s);
  }

  /**
   * ⚠️ 2026-09-22：从「tmp + renameSync 原子替换」改为**直接覆写**，并去掉 JSON 缩进。
   *
   * 实测（本机 Windows，206KB 会话）：JSON.stringify 紧凑 0~1ms、writeFileSync 1~2ms，
   * 而 **renameSync 固定 43ms**（与文件大小、目标是否存在都无关）。这个开销每次落盘都要付，
   * 而且全是同步阻塞 —— 一次会话 create 一次、finish 一次、运行中还有 `#persistThrottled`
   * 每 2s 一次，5~8 次就是 0.25~0.36s 的纯事件循环卡顿（活跃群里多会话并发时更明显）。
   * 同 `store.js` 的处理思路。
   *
   * 为什么敢不要原子替换：
   *   ① 写入是**同步**的（writeFileSync 内部不 await），同进程内不存在"读到写了一半的文件"
   *      的读者 —— 读者要么在写之前读、要么在写之后读；
   *   ② 会话目录只有本进程写（instance.lock 保证单实例）；
   *   ③ 索引加载与 get()/peek() 本来就 try/catch 跳过坏文件；
   *   ④ 关键用量数据同时写进用量台账（下面的 upsertFromSession），
   *      真在写的那 1~2ms 里被强杀导致文件半截，也只损失这一个会话的审计副本。
   *
   * 缩进 `null, 1` 也一并去掉：这是给人和 diff 看的，而这里是热路径，
   * 大会话 125KB → 114KB、且少一次格式化成百上千行的开销。
   */
  #persist(s) {
    try {
      fs.mkdirSync(SESSIONS_DIR, { recursive: true });
      fs.writeFileSync(sessionFile(s.id), JSON.stringify(s), 'utf8');
      // 落盘即写入用量台账：用量页只读台账，不再扫 4000+ 会话文件。
      try { getUsageLedger().upsertFromSession(s); } catch { /* 台账失败不影响会话 */ }
      if (s.status !== 'running' && s.status !== 'waiting') this.#bumpTodayUsage(s);
    } catch (error) {
      console.error('[sessions] 持久化失败:', error?.message ?? error);
    }
  }
}

function localDayKey(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function triggerEntriesToText(trigger) {
  // trigger 在创建时是数组（触发条目），这里只做摘要展示用
  if (Array.isArray(trigger)) {
    return trigger.map((m) => `${m.senderName || m.senderId || '?'}: ${String(m.text ?? '').slice(0, 80)}`).join(' | ');
  }
  return '';
}
