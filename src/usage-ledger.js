// 用量台账：把「会话级提取结果」持久化成一份小文件，用量页只读它。
//
// 为什么不继续扫 data/sessions/*.json：
//   留档目录有 4700+ 文件 / 280MB+。全量 JSON.parse 会把主进程 UI 卡死；
//   再怎么加缓存 / 预热 / yield，冷路径仍然是「进页面 → 扫盘」，会反复踩坑。
//
// 新思路（增量台账，不走缓存失效）：
//   1) 会话每次落盘（#persist）把 extract 写进 data/usage-ledger.ndjson（同步追加一行）
//   2) 用量 API 只读内存 Map（启动时从 ndjson 加载），O(会话数) 过滤，零扫盘
//   3) 历史数据只在后台 reconcile：扫一遍目录更新 Map，**写完盘再标 reconciledOnce**
//   4) 对账未完成时 API 立刻返回已建好的部分 + building=true，绝不阻塞请求
//   5) meta.entries 与内存条数对不上（上次没写完就退出）→ 自动重新对账
import fs from 'node:fs';
import path from 'node:path';
import { dataRoot, sessionsDir } from './paths.js';
import { modelLabel, UNKNOWN_VENDOR } from './model-prices.js';

const LEDGER_FILE = path.join(dataRoot(), 'usage-ledger.ndjson');
const META_FILE = path.join(dataRoot(), 'usage-ledger.meta.json');
const SESSIONS_DIR = sessionsDir();

/** 从会话对象提取与时间窗无关的用量信息。 */
export function extractUsageFromSession(s) {
  if (!s || !(Number(s.startedAt) || 0)) return null;
  const started = Number(s.startedAt) || 0;
  const calls = [];
  const toolNames = [];
  for (const m of (s.messages || [])) {
    const name = m && m.toolCall && m.toolCall.name;
    if (name) toolNames.push(String(name));
    const raw = m?.raw;
    if (!raw || typeof raw !== 'object') continue;
    const ru = raw.usage || {};
    const rp = Number(ru.prompt_tokens) || 0;
    const rc = Number(ru.completion_tokens) || 0;
    if (!rp && !rc) continue;
    const at = Number(raw.created) ? Number(raw.created) * 1000 : started;
    calls.push({
      promptTokens: rp,
      completionTokens: rc,
      cachedTokens: Number(ru.prompt_tokens_details?.cached_tokens) || 0,
      cacheCreationTokens: Number(ru.prompt_tokens_details?.cache_creation_input_tokens) || 0,
      at,
      model: String(raw.model || s.model || '') || '(未知)'
    });
  }
  const u = s.usage || {};
  const p = Number(u.promptTokens) || 0;
  const c = Number(u.completionTokens) || 0;
  return {
    id: String(s.id || ''),
    started,
    model: String(s.model || ''),
    vendor: String(s.vendor || ''),
    chatKey: String(s.chatKey || '(未知)'),
    webSearchCount: Number(s.webSearchCount) || 0,
    toolNames,
    calls,
    fallback: (p || c) ? {
      promptTokens: p,
      completionTokens: c,
      cachedTokens: Number(u.cachedTokens) || 0,
      cacheCreationTokens: Number(u.cacheCreationTokens) || 0
    } : null
  };
}

function extractFromSessionFile(full) {
  let rawText;
  try { rawText = fs.readFileSync(full, 'utf8'); } catch { return null; }
  let s;
  try { s = JSON.parse(rawText); } catch { return null; }
  return extractUsageFromSession(s);
}

function yieldTick() {
  return new Promise((resolve) => setImmediate(resolve));
}

function lineOf(id, v) {
  return JSON.stringify({
    id,
    mtimeMs: v.mtimeMs,
    size: v.size,
    upsertedAt: v.upsertedAt,
    extract: v.extract
  });
}

export class UsageLedger {
  constructor() {
    /** id → { extract, mtimeMs, size, upsertedAt } */
    this.map = new Map();
    this.loaded = false;
    this.reconciling = false;
    this.reconciledOnce = false;
    this.reconcileProgress = { done: 0, total: 0 };
    this._dirtySinceCompact = 0;
    this._reconcileWait = null;
  }

  #ensureLoaded() {
    if (this.loaded) return;
    this.loaded = true;
    let metaEntries = 0;
    try {
      const text = fs.readFileSync(LEDGER_FILE, 'utf8');
      for (const line of text.split('\n')) {
        const t = line.trim();
        if (!t) continue;
        try {
          const rec = JSON.parse(t);
          if (rec?.removed) {
            this.map.delete(rec.id);
          } else if (rec?.id && rec.extract) {
            this.map.set(rec.id, {
              extract: rec.extract,
              mtimeMs: Number(rec.mtimeMs) || 0,
              size: Number(rec.size) || 0,
              upsertedAt: Number(rec.upsertedAt) || 0
            });
          }
        } catch { /* 坏行跳过 */ }
      }
    } catch { /* 还没有台账 */ }
    try {
      const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      this.reconciledOnce = !!meta.reconciledOnce;
      metaEntries = Number(meta.entries) || 0;
    } catch { /* 无 meta */ }

    // 上次对账标了完成但文件没写全（进程在 compact 前退出）→ 必须重做
    if (this.reconciledOnce && metaEntries > 0 && this.map.size + 5 < metaEntries) {
      this.reconciledOnce = false;
    }
    // 空台账且不是「调试清零」标记 → 视为未对账，后台从 sessions 重建
    try {
      const meta2 = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
      const allowEmpty = meta2.allowEmpty === true || Number(meta2.resetAt) > 0;
      if (this.reconciledOnce && this.map.size === 0 && !allowEmpty) {
        this.reconciledOnce = false;
      }
    } catch {
      if (this.reconciledOnce && this.map.size === 0) this.reconciledOnce = false;
    }
  }

  /**
   * 调试用：清空用量台账（内存 + 磁盘），并标记 allowEmpty，
   * 避免 kickReconcile 马上从 sessions 把历史又扫回来。
   * 不会删会话文件本身。
   */
  resetForDebug() {
    this.#ensureLoaded();
    this.map.clear();
    this._dirtySinceCompact = 0;
    this.reconciledOnce = true;
    this.reconciling = false;
    this.reconcileProgress = { done: 0, total: 0 };
    this.compactSync();
    this.#saveMeta({ entries: 0, allowEmpty: true, resetAt: Date.now() });
    return { cleared: true, at: Date.now() };
  }

  /** 会话落盘时同步写入：内存立刻可见，磁盘同步追加一行（单行很小）。 */
  upsertFromSession(session, stat = null) {
    const ex = extractUsageFromSession(session);
    if (!ex?.id) return false;
    this.#ensureLoaded();
    let mtimeMs = Number(stat?.mtimeMs) || Date.now();
    let size = Number(stat?.size) || 0;
    if (!stat) {
      try {
        const st = fs.statSync(path.join(SESSIONS_DIR, `${ex.id}.json`));
        mtimeMs = st.mtimeMs;
        size = st.size;
      } catch { /* 文件可能还没写完 */ }
    }
    const rec = { extract: ex, mtimeMs, size, upsertedAt: Date.now() };
    this.map.set(ex.id, rec);
    try {
      fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
      fs.appendFileSync(LEDGER_FILE, lineOf(ex.id, rec) + '\n', 'utf8');
      this._dirtySinceCompact += 1;
      if (this._dirtySinceCompact >= 300) {
        this._dirtySinceCompact = 0;
        this.compactSync();
      }
    } catch { /* 磁盘失败不影响内存查询 */ }
    return true;
  }

  remove(id) {
    if (!id) return;
    this.#ensureLoaded();
    if (!this.map.delete(id)) return;
    try {
      fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
      fs.appendFileSync(LEDGER_FILE, JSON.stringify({ id, removed: true, upsertedAt: Date.now() }) + '\n', 'utf8');
    } catch { /* ignore */ }
  }

  /** 同步重写台账（去掉墓碑与重复 id）。对账结束时必须走这个，先落盘再标完成。 */
  compactSync() {
    this.#ensureLoaded();
    try {
      const tmp = `${LEDGER_FILE}.${process.pid}.tmp`;
      const lines = [];
      for (const [id, v] of this.map) lines.push(lineOf(id, v));
      fs.mkdirSync(path.dirname(LEDGER_FILE), { recursive: true });
      fs.writeFileSync(tmp, lines.length ? lines.join('\n') + '\n' : '', 'utf8');
      fs.renameSync(tmp, LEDGER_FILE);
      this._dirtySinceCompact = 0;
      return true;
    } catch {
      return false;
    }
  }

  #saveMeta(extra = {}) {
    try {
      const prev = (() => { try { return JSON.parse(fs.readFileSync(META_FILE, 'utf8')); } catch { return {}; } })();
      const next = { ...prev, reconciledOnce: this.reconciledOnce, at: Date.now(), ...extra };
      fs.writeFileSync(META_FILE, JSON.stringify(next), 'utf8');
    } catch { /* ignore */ }
  }

  /**
   * 后台对账：只更新「台账没有 / mtime 或 size 变了」的会话到内存 Map，
   * 结束时 **sync 写完 ndjson → 再写 meta**。绝不 await 在 API 请求路径上。
   */
  async reconcile() {
    this.#ensureLoaded();
    if (this.reconciling) return this._reconcileWait || Promise.resolve();
    this.reconciling = true;
    let files = [];
    try {
      files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'));
    } catch {
      this.reconciling = false;
      this.reconciledOnce = true;
      this.#saveMeta({ entries: this.map.size });
      return;
    }
    this.reconcileProgress = { done: 0, total: files.length };

    const run = (async () => {
      const keep = new Set();
      let n = 0;
      let changed = 0;
      for (const f of files) {
        if ((++n % 32) === 0) {
          this.reconcileProgress.done = n;
          await yieldTick();
        }
        const full = path.join(SESSIONS_DIR, f);
        keep.add(full);
        let st;
        try { st = fs.statSync(full); } catch { continue; }
        const id = f.slice(0, -5);
        const hit = this.map.get(id);
        if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) continue;
        const ex = extractFromSessionFile(full);
        if (!ex?.id) continue;
        this.map.set(ex.id, {
          extract: ex, mtimeMs: st.mtimeMs, size: st.size, upsertedAt: Date.now()
        });
        changed += 1;
      }
      // 清掉已删除会话
      for (const id of [...this.map.keys()]) {
        if (!keep.has(path.join(SESSIONS_DIR, `${id}.json`))) {
          this.map.delete(id);
          changed += 1;
        }
      }
      this.reconcileProgress = { done: files.length, total: files.length };

      // 关键顺序：先整文件写完，再标 reconciledOnce / 写 meta
      const ok = this.compactSync();
      if (ok) {
        this.reconciledOnce = true;
        this.#saveMeta({ entries: this.map.size, files: files.length, changed });
      } else {
        this.reconciledOnce = false;
        this.#saveMeta({ entries: 0, failed: true });
      }
    })();

    this._reconcileWait = run;
    try {
      await run;
    } finally {
      this.reconciling = false;
      this._reconcileWait = null;
    }
  }

  /**
   * 启动/首次访问时触发对账。
   * 仅在「从未完成」或「完成过但 meta/条数对不上已判定 needsRebuild」时跑；
   * 已完成则直接返回，避免每次 API 都 stat 4000+ 文件。
   */
  kickReconcile() {
    this.#ensureLoaded();
    if (this.reconciling) return Promise.resolve();
    if (this.reconciledOnce) return Promise.resolve();
    return this.reconcile().catch(() => {});
  }

  /**
   * 按时间窗收集调用行。纯内存过滤。
   * @returns {{ rows: any[], searchCount: number, toolCounts: Record<string, number>, building: boolean, progress: object }}
   */
  query(win) {
    this.#ensureLoaded();
    const rows = [];
    let searchCount = 0;
    const toolCounts = Object.create(null);

    for (const { extract: ex } of this.map.values()) {
      if (!ex) continue;
      if (ex.started >= win.start && ex.started <= win.end) {
        searchCount += ex.webSearchCount || 0;
        for (const name of (ex.toolNames || [])) {
          toolCounts[name] = (toolCounts[name] || 0) + 1;
        }
      }
      if (ex.calls?.length) {
        for (const c of ex.calls) {
          if (c.at < win.start || c.at > win.end) continue;
          rows.push({
            ...c,
            vendor: ex.vendor,
            chatKey: ex.chatKey,
            sessionId: ex.id,
            exact: true
          });
        }
      } else if (ex.fallback) {
        if (ex.started < win.start || ex.started > win.end) continue;
        rows.push({
          ...ex.fallback,
          at: ex.started,
          model: ex.model || '(未知)',
          chatKey: ex.chatKey,
          vendor: ex.vendor,
          sessionId: ex.id,
          exact: false
        });
      }
    }

    for (const r of rows) {
      r.vendor = String(r.vendor || '').trim() || UNKNOWN_VENDOR;
      r.modelKey = modelLabel(r.vendor, r.model);
    }

    const building = this.reconciling || !this.reconciledOnce;
    return { rows, searchCount, toolCounts, building, progress: { ...this.reconcileProgress } };
  }
}

/** 进程内单例（同一 DATA_DIR）。 */
let singleton = null;
export function getUsageLedger() {
  if (!singleton) singleton = new UsageLedger();
  return singleton;
}
