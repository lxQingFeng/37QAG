// 运行期表情库管理：同步 QQ 收藏表情 + 本地认知层（备注/笔记/使用计数）。
// 纯函数在 stickers.js；这里管缓存、TTL 和 OneBot 交互。
import { OneBotClient } from './onebot.js';
import { getConfig, DATA_DIR } from './config.js';
import { safeFetchBinary } from './safe-fetch.js';
import { isLocalHostUrl } from './util.js';
import fs from 'node:fs';
import path from 'node:path';
import {
  loadStickerStore, saveStickerStore, mergeStickerLibrary,
  findSticker, formatStickerList, applyStickerNote, markStickerUsed,
  normalizeStickerEntry, nowIso
} from './stickers.js';

const MAX_STICKER_BYTES = 20 * 1024 * 1024; // 单个表情源上限（base64 后本地直传，远小于 QQ 上限）
/** 表情字节磁盘缓存上限（超过就按最久没用删掉）。 */
const STICKER_CACHE_MAX = 500;
/** 缓存文件名可能带的扩展名（落盘时按字节魔数选，找回来时按这个顺序试）。 */
const CACHE_EXTS = ['.gif', '.png', '.jpg', '.webp', '.img'];

/** 字节魔数 → 扩展名（协议端大多按内容识别，扩展名只是让它更省心）。 */
function stickerExt(buf) {
  if (!buf || buf.length < 12) return '.img';
  if (buf[0] === 0x89 && buf[1] === 0x50) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
  if (buf.toString('ascii', 0, 3) === 'GIF') return '.gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return '.webp';
  return '.img';
}

/** 表情 id → 安全文件名（id 本身是 `collected_123` / `352…_0_0` 这类，sanitize 只是兜底）。 */
function cacheSafeId(id) {
  return String(id || '').replace(/[^\w.-]/g, '_').slice(0, 80) || 'sticker';
}

/** 校验下载内容确实是常见图片格式（防 QQ 返回"过期占位图/HTML 错误页"也被当成图发出去）。 */
function looksLikeImage(buf) {
  if (!buf || buf.length < 12) return false;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return true; // PNG
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return true; // JPEG
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return true; // GIF
  // ⚠️ WEBP 的判定必须取 8..12（4 个字符）再和 'WEBP' 比。
  //    曾经写成 toString('ascii', 8, 4) —— end 比 start 还小，Node 直接返回空字符串，
  //    于是所有 webp 表情都被当成"不是图片"拒发（QQ 收藏表情里 webp 占相当一部分）。
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return true; // WEBP
  return false;
}

function errText(err) {
  return String(err?.message ?? err).slice(0, 160);
}

/**
 * 本地表情图片目录：只允许这里的 file:// 地址被读成文件。
 * （2026-09-22：为了跑 0.4 的 reverse-image 技能 —— 它要拿本地文件转 dataURL 去反查图片。）
 */
export function stickerImagesDir() {
  return path.join(DATA_DIR, 'sticker-images');
}

/**
 * 表情**字节**缓存目录（和表情图源目录分开，不会被 localStickerPath 当成"用户图"）。
 *
 * 为什么要缓存字节（2026-09-22 用户反馈「有的表情能发出来，有的发不出来」）：
 *   · QQ 收藏表情给的是一小时就过期的 rkey 链接 —— 同一批表情里，
 *     刚同步过的能发，前几天同步下来的就发不出（403/占位图），表现就是"有的行有的不行"；
 *   · 每次发送都要重新下载几 MB，网络一抖这张就失败；
 *   · 同机协议端可以直接读文件当载荷，请求体几百字节，多大都不会被 RESET。
 * 存过一次之后，① 链接过期也照发；② 发出去的是同一份字节，群里看到的就是库里的那张。
 */
export function stickerCacheDir() {
  return path.join(stickerImagesDir(), 'cache');
}

/**
 * `file:///…` → 绝对路径，**只允许**落在 stickerImagesDir 内的真实文件，其余一律 null。
 *
 * 为什么必须校验目录：这个函数会被技能拿到的"用户可控字符串"调用（收藏表情的 url 字段
 * 理论上可以被配置/存档改写），不校验就等于给了一个"任意本地文件读取 → 转成 dataURL 发到
 * 第三方反查站"的通道。规则与 0.4 版一致：不在目录内、不是文件、解析失败都返回 null。
 */
export function localStickerPath(raw) {
  const value = String(raw ?? '').trim();
  if (!value.toLowerCase().startsWith('file:///')) return null;
  let pathname;
  try { pathname = decodeURIComponent(new URL(value).pathname); } catch { return null; }
  // file:///C:/... 在 Windows 上 pathname 前面会多一个斜杠
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);
  const root = path.resolve(stickerImagesDir()) + path.sep;
  const full = path.resolve(pathname);
  if (!full.toLowerCase().startsWith(root.toLowerCase())) return null;
  try {
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  } catch { return null; }
  return full;
}

export class StickerManager {
  constructor(onebot) {
    this.onebot = onebot;
    this.entries = loadStickerStore();
    this.syncedAt = 0;
    this.syncing = null;
    this.collectTimes = [];
    this.cachePrunedAt = 0;
  }

  // ── 表情字节磁盘缓存（见 stickerCacheDir 的说明）──────────────────────

  /** 命中缓存则返回 {file, buf}；没有/读坏了返回 null。 */
  #cacheHit(entry) {
    if (!entry?.id) return null;
    const base = path.join(stickerCacheDir(), cacheSafeId(entry.id));
    for (const ext of CACHE_EXTS) {
      const file = `${base}${ext}`;
      try {
        if (!fs.existsSync(file)) continue;
        const buf = fs.readFileSync(file);
        if (looksLikeImage(buf)) return { file, buf };
      } catch { /* 读不了就当下没有 */ }
    }
    return null;
  }

  /** 把字节写进缓存，返回文件绝对路径（失败返回 null，调用方退回 base64）。 */
  #cachePut(entry, buf) {
    if (!entry?.id || !buf?.length || !looksLikeImage(buf)) return null;
    try {
      const dir = stickerCacheDir();
      const file = path.join(dir, cacheSafeId(entry.id) + stickerExt(buf));
      // 已经在缓存里（且大小一致）就别重写：这是发送热路径，一张动图好几 MB，
      // 每次都覆写等于白烧磁盘 IO。
      try {
        if (fs.statSync(file).size === buf.length) return file;
      } catch { /* 不存在 → 下面写 */ }
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(file, buf);
      this.#pruneCache();
      return file;
    } catch {
      return null;
    }
  }

  /** 缓存超过上限时按"最久没动过"删除（每小时最多算一次，别在发送路径上反复扫目录）。 */
  #pruneCache() {
    const now = Date.now();
    if (this.cachePrunedAt && now - this.cachePrunedAt < 3600000) return;
    this.cachePrunedAt = now;
    try {
      const dir = stickerCacheDir();
      const files = [];
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        try { files.push({ full, mtime: fs.statSync(full).mtimeMs }); } catch { /* ignore */ }
      }
      if (files.length <= STICKER_CACHE_MAX) return;
      files.sort((a, b) => b.mtime - a.mtime);
      for (const f of files.slice(STICKER_CACHE_MAX)) {
        try { fs.unlinkSync(f.full); } catch { /* ignore */ }
      }
    } catch { /* 清理失败不影响发送 */ }
  }

  get enabled() {
    return getConfig().sticker?.enabled !== false;
  }

  /** 同步 QQ 收藏表情（带 TTL 缓存；force 立即刷新）。失败时退回本地缓存。 */
  async sync(force = false) {
    if (!this.enabled) return { entries: this.entries, fromCache: true, disabled: true };
    const ttl = 60000;
    const now = Date.now();
    if (!force && this.syncedAt && now - this.syncedAt < ttl) {
      return { entries: this.entries, fromCache: true };
    }
    if (this.syncing) return this.syncing;
    this.syncing = (async () => {
      try {
        const count = Math.min(500, Math.max(1, Number(getConfig().sticker?.promptMaxStickers) * 10 || 100));
        const data = await this.onebot.call('fetch_custom_face_detail', { count });
        const fetched = Array.isArray(data) ? data : (Array.isArray(data?.data) ? data.data : null);
        if (!fetched) throw new Error('fetch_custom_face_detail 返回 data 不是数组');
        // 只有拿到合法数组才合并，避免异常响应清空本地库
        this.entries = mergeStickerLibrary(this.entries, fetched);
        this.syncedAt = Date.now();
        saveStickerStore(this.entries);
        return { entries: this.entries, fromCache: false };
      } catch (error) {
        // 同步失败不致命：本地缓存继续用
        return { entries: this.entries, fromCache: true, error: String(error?.message ?? error) };
      } finally {
        this.syncing = null;
      }
    })();
    return this.syncing;
  }

  async list(query = '', limit = 48, force = false) {
    const synced = await this.sync(force);
    return formatStickerList(synced.entries, query, limit, { includeBroken: false });
  }

  async find(ref) {
    const synced = await this.sync(false);
    return findSticker(synced.entries, ref);
  }

  note(id, patch) {
    const result = applyStickerNote(this.entries, id, patch);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  markUsed(id, context = '') {
    const result = markStickerUsed(this.entries, id, context);
    this.entries = result.entries;
    if (result.entry) saveStickerStore(this.entries);
    return result.entry;
  }

  /**
   * 图源失效（404/过期/发送失败）：直接从库里删除。
   * 返回被删条目，找不到则 null。
   */
  markBroken(id, reason = '') {
    const idx = this.entries.findIndex((e) => e && e.id === id);
    if (idx < 0) return null;
    const cur = this.entries[idx];
    this.entries.splice(idx, 1);
    saveStickerStore(this.entries);
    try {
      console.log(`[sticker] 已删除失效表情 ${id}（${String(reason || 'expired').slice(0, 60)}）`);
    } catch { /* ignore */ }
    return cur;
  }

  /** 刷新到新图源后清除失效标记。 */
  markAlive(id) {
    const idx = this.entries.findIndex((e) => e && e.id === id);
    if (idx < 0) return null;
    const cur = this.entries[idx];
    if (!cur.broken && !cur.brokenAt && !cur.brokenReason) return cur;
    const entry = normalizeStickerEntry({
      ...cur,
      broken: false,
      brokenAt: 0,
      brokenReason: '',
      updatedAt: nowIso()
    });
    this.entries[idx] = entry;
    saveStickerStore(this.entries);
    return entry;
  }

  /** 没有备注/描述的表情（这些在提示词里没法被判断，等于永远用不上）。 */
  unlabeled() {
    return this.entries.filter((e) => e && !String(e.localNote || '').trim() && !String(e.desc || '').trim());
  }

  /** 发送失败时挑一张还活着的备胎：优先有备注、近期少用。 */
  pickFallback(excludeId = '') {
    const live = this.entries.filter((e) => e && !e.broken && e.url && e.id !== excludeId);
    if (!live.length) return null;
    const labeled = live.filter((e) => e.desc || e.localNote || (e.tags || []).length);
    const pool = labeled.length ? labeled : live;
    pool.sort((a, b) => (Number(a.lastUsedAt) || 0) - (Number(b.lastUsedAt) || 0)
      || (Number(a.useCount) || 0) - (Number(b.useCount) || 0));
    // 在最久未用的前 12 张里随机一张
    const top = pool.slice(0, Math.min(12, pool.length));
    return top[Math.floor(Math.random() * top.length)] || pool[0];
  }

  /**
   * 给"没备注"的表情批量补一句描述（用当前聊天模型看图写）。
   *
   * 为什么要批量做：表情库里实测有 56/125 张既没有 QQ 描述也没有本地笔记，
   * 提示词里它们连一行都占不到（无从判断该不该发），于是永远是那几张熟脸在轮。
   * 交给模型在聊天里顺手补是不现实的（它很少主动调 sticker_note），
   * 所以给管理员一个按钮，一次性补齐（一张图约 ¥0.001，几十张也就几分钱）。
   */
  async annotateMissing({ limit = 60, onlyMissing = true, emit = () => {}, onProgress = null } = {}) {
    const { chatCompletion } = await import('./llm.js');
    // 优先本地视觉（同一个 0.8B + mmproj）：这是离线批量活，CPU 上慢点无所谓，
    // 换来的是不烧云端 vision。没配好/文件缺失就退回云端，行为不变。
    const { localVisionAvailable, localVisionChat, stopLocalVision } = await import('./local-jev.js');
    const useLocal = localVisionAvailable();
    if (useLocal) emit('sticker-annotate', { phase: 'start', engine: 'local' });
    const targets = (onlyMissing ? this.unlabeled() : [...this.entries])
      .slice(0, Math.max(1, Math.min(200, Number(limit) || 60)));
    const done = [];
    const failed = [];
    for (const entry of targets) {
      try {
        const buffer = await this.resolveStickerBytes(entry);
        const { toVisionDataUrls, detectImageMime } = await import('./vision-image.js');
        const mime = detectImageMime(buffer)
          || (buffer[0] === 0x89 ? 'image/png'
            : (buffer[0] === 0xff ? 'image/jpeg'
              : (buffer.toString('ascii', 0, 3) === 'GIF' ? 'image/gif' : 'image/webp')));
        // 归一成接口能吃的格式（GIF 抽帧转 PNG、webp 尽量转 JPEG）。
        // 转不动就跳过：硬发会触发降级剥图，模型凭空"描述"没看到的图更糟。
        const prepared = await toVisionDataUrls(buffer, { mime, maxFrames: 1 });
        if (prepared.skipped || !prepared.dataUrls.length) {
          failed.push(`${entry.id}（${mime} 当前模型看不了，已跳过）`);
          continue;
        }
        const askVision = { messages: [
          {
            role: 'system',
            content: '你在给聊天机器人的 QQ 表情包写一句话备注。只输出一行、不超过 30 个字：画面是什么 + 适合什么情绪/场合用（例如"蓝毛小人趴地装死，累了/不想理人时用"）。不要引号、不要客套、不要解释。'
          },
          {
            role: 'user',
            content: [
              { type: 'text', text: '这张表情：' },
              { type: 'image_url', image_url: { url: prepared.dataUrls[0] } }
            ]
          }
        ], temperature: 0.2 };
        // 本地优先；本地没配好 / 中途起不来 → 云端兜底。绝不能因为本地挂了就让备注失败。
        // 本地 0.8B 写 30 个字很勉强，放宽 max_tokens 让它把话说完（后处理会截断）。
        let res = null;
        if (useLocal) {
          try { res = await localVisionChat({ ...askVision, maxTokens: 128 }); }
          catch { /* 本地失败 → 走云端 */ }
        }
        if (!res) res = await chatCompletion(askVision);
        const note = String(res?.message?.content ?? '')
          .replace(/[\r\n]+/g, ' ')
          .replace(/^["'「『]+|["'」』]+$/g, '')
          .trim()
          .slice(0, 60);
        if (!note) throw new Error('模型没写出描述');
        this.note(entry.id, { note });
        done.push({ id: entry.id, note });
        emit('sticker-annotate', { phase: 'progress', done: done.length, total: targets.length, id: entry.id, note });
      } catch (error) {
        failed.push({ id: entry.id, error: errText(error) });
        emit('sticker-annotate', { phase: 'progress', done: done.length, failed: failed.length, total: targets.length, id: entry.id, error: errText(error) });
      }
      if (typeof onProgress === 'function') onProgress(done.length + failed.length, targets.length);
    }
    // 本地视觉实例用完就关，别让那 800MB 一直挂着
    if (useLocal) { try { await stopLocalVision(); } catch { /* ignore */ } }
    return { total: targets.length, done, failed, engine: useLocal ? 'local' : 'cloud' };
  }

  /** 收藏一条消息里的图片（本地新增条目，不入 QQ 收藏）。 */
  collect(messageId, { url, note = '' } = {}) {
    if (!getConfig().sticker?.collectEnabled) throw new Error('收藏表情功能未开启');
    // 限频
    const now = Date.now();
    this.collectTimes = this.collectTimes.filter((t) => now - t < 3600000);
    if (this.collectTimes.length >= Math.max(1, Number(getConfig().sticker?.maxCollectPerHour) || 10)) {
      throw new Error('收藏太频繁了，一小时后再试');
    }
    url = String(url || '');
    if (!url) throw new Error('该消息没有可收藏的图片地址');
    const id = `collected_${messageId}`;
    const existing = this.entries.find((e) => e.id === id);
    if (existing) {
      return this.note(id, { note: String(note || '') });
    }
    const entry = {
      id,
      resId: id,
      url,
      md5: '',
      desc: String(note || '').slice(0, 20),
      localNote: String(note || ''),
      tags: [],
      usage: '',
      source: 'ai',
      useCount: 0,
      lastUsedAt: 0,
      lastContext: '',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    this.entries.push(entry);
    this.collectTimes.push(now);
    saveStickerStore(this.entries);
    return entry;
  }

  // ── 表情图片字节：下载 → 校验 →（链接失效时）刷新 → 重试 ──────────────
  //
  // 背景：直接让 OneBot 端按 image URL 下载再上传不可靠 —— QQ 给的表情/图片
  // 链接（multimedia.nt.qq.com.cn 的 rkey 链接、p.qpic.cn 表情图）对匿名
  // HTTP 请求经常 400/过期/返回占位图，OneBot 端取不到就报 "HTTP download
  // failed: 400"，取到占位图就发成"白图"。改成由本进程先下载并校验字节，
  // 再以 base64:// 直传给 OneBot 本地上传：字节是真的，就一定能正常显示。

  /** 下载一张图并校验是有效图片；失败抛中文错误。 */
  async fetchImageBytes(url, maxBytes = MAX_STICKER_BYTES) {
    const u = String(url || '').trim();
    if (!u) throw new Error('该表情没有图片地址');
    let lastErr = null;
    // 网络抖动重试 2 次
    for (let i = 0; i < 3; i++) {
      try {
        const { buffer } = await safeFetchBinary(u, maxBytes);
        if (!buffer || !buffer.length) throw new Error('图片内容为空');
        if (!looksLikeImage(buffer)) throw new Error('下载内容不是有效图片（可能是过期/占位图）');
        return buffer;
      } catch (error) {
        lastErr = error;
        if (i < 2) await new Promise((r) => setTimeout(r, 400 * (i + 1)));
      }
    }
    throw lastErr || new Error('图片下载失败');
  }

  /** collected_xxx 的 id 里藏着来源消息 id（QQ 消息 id，可能是负数）。 */
  srcMessageId(entry) {
    const m = /^collected_(-?\d+)$/.exec(String(entry?.id || ''));
    return m ? Number(m[1]) : null;
  }

  #replaceEntry(entry) {
    const idx = this.entries.findIndex((e) => e && e.id === entry?.id);
    if (idx < 0) return entry;
    this.entries[idx] = entry;
    saveStickerStore(this.entries);
    return entry;
  }

  /**
   * 链接失效时尝试换一张"新鲜"的图源地址并落库：
   *   1. collected_*（收藏自聊天里的图）：QQ 媒体 rkey 链接会过期，但 OneBot
   *      端 get_msg 能基于本地媒体库把该消息重新解析出带新 rkey 的可用链接。
   *      （SnowLuma 偶发返回旧链接，隔一小段时间重试一次能拿到新链接。）
   *   2. qq 收藏表情：强制重新拉取收藏列表，用服务端返回的最新 url 覆盖。
   * 返回可能更新过的 entry（拿不到新地址则原样返回）。
   */
  async refreshEntryImage(entry) {
    if (!entry || !entry.id) return entry;
    const apply = (url) => {
      const u = String(url || '').trim();
      if (!u || u === entry.url) return entry;
      return this.#replaceEntry(normalizeStickerEntry({ ...entry, url: u, updatedAt: nowIso() }));
    };
    // 1) 收藏图：用来源消息 id 重新解析（消息 id 找不到/无图则跳过）
    const mid = this.srcMessageId(entry);
    if (mid !== null) {
      for (let attempt = 0; attempt < 3; attempt++) {
        let applied = null;
        try {
          const msg = await this.onebot.getMsg(mid);
          const segs = Array.isArray(msg?.message) ? msg.message : [];
          const img = segs.find((s) => s?.type === 'image');
          const fresh = String(img?.data?.url || img?.data?.file || '').trim();
          if (fresh && fresh !== entry.url) applied = apply(fresh);
        } catch { /* 消息不存在/已过期 → 继续尝试 */ }
        if (applied && applied.url !== entry.url) return applied;
        // SnowLuma 偶发仍返回旧链接：稍等再试一次，往往能拿到新 rkey 的链接
        if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
    // 2) 收藏表情/兜底：强制同步一次收藏列表，用服务端新地址覆盖
    try {
      const synced = await this.sync(true);
      const freshEntry = findSticker(synced.entries, entry.id, { fuzzy: false });
      if (freshEntry?.url && freshEntry.url !== entry.url) return apply(freshEntry.url);
    } catch { /* 同步失败不致命 */ }
    return entry;
  }

  /**
   * 拿到一个表情的真实图片字节（发送/看图前调用）。
   * 优先用本地存的 url；失败（过期/400/占位图）就 refreshEntryImage 换新地址重试一次。
   */
  async resolveStickerBytes(sticker) {
    const entry = sticker?.id ? this.entries.find((e) => e && e.id === sticker.id) || sticker : sticker;
    // ① 先看字节缓存：存过一次的表情，链接过期 / 图源被删都照样能发（也是"有的能发有的不能"的根治）
    const cached = this.#cacheHit(entry);
    if (cached) return cached.buf;
    let lastErr = null;
    // 图源"确实没了"的判据：QQ 的临时链接过期后会回 400/401/403/404，或者干脆给一张占位图。
    // ⚠️ 2026-09-22：原来只认 404/400 —— 过期 rkey 常回 403，于是它既不被标失效、
    //   也不会被当成"图源过期"，用户看到的就是"反复发不出去"。
    const isGone = (err) => /40[0134]|403|forbidden|expired|rkey|not\s*found|过期|占位|不是有效图片/i.test(String(err?.message ?? err ?? ''));
    if (entry?.url) {
      try {
        const buf = await this.fetchImageBytes(entry.url);
        if (entry?.id) {
          this.markAlive(entry.id);
          this.#cachePut(entry, buf);   // 存下来：下次链接过期也不影响发送
        }
        return buf;
      } catch (error) {
        lastErr = error;
      }
    }
    try {
      const refreshed = await this.refreshEntryImage(entry);
      if (refreshed?.url && refreshed.url !== entry?.url) {
        const buf = await this.fetchImageBytes(refreshed.url);
        if (refreshed?.id) {
          this.markAlive(refreshed.id);
          this.#cachePut(refreshed, buf);
        }
        return buf;
      }
      lastErr = lastErr || new Error('刷新后仍无新图源');
    } catch (error) {
      lastErr = error;
    }
    // 网络抖动不标记；明确 401/403/404/过期/非图片 → 记失效，避免反复推荐
    const gone = isGone(lastErr) || !entry?.url;
    if (entry?.id && gone) {
      this.markBroken(entry.id, errText(lastErr) || 'no url');
    }
    // ⚠️ 2026-09-22：错误文案要**说清是哪一类问题**，并且**不能把锅甩给"网络"**。
    //   上一版写的是"多半是网络/代理抓 QQ 图源失败" —— 模型照着念，群里就变成
    //   "她说网断了发不出来"，用户以为是自己家网络坏了（实测反馈正是这句）。
    //   现在按具体原因分类，并明确告诉模型：这是图源问题，不是网络问题，别这么对外解释。
    const label = String(entry?.localNote || entry?.desc || entry?.id || '该表情').slice(0, 24);
    const whyRaw = errText(lastErr) || '无可用图片地址';
    let kind = '图源不可用';
    if (!entry?.url) kind = '这张表情没有图片地址（记录里是空的）';
    else if (/40[13]|forbidden|expired|rkey|过期/i.test(whyRaw)) kind = 'QQ 的临时图片链接已过期（rkey 约 1 小时有效）';
    else if (/404|not\s*found/i.test(whyRaw)) kind = '图源已被删除或链接失效';
    else if (/不是有效图片|占位/i.test(whyRaw)) kind = '图源返回的不是图片（多半是过期占位图）';
    else if (/timeout|超时|abort/i.test(whyRaw)) kind = '取图超时（图片服务器没在 25 秒内返回）';
    else if (/ECONN|fetch failed|ENOTFOUND|socket/i.test(whyRaw)) kind = '连接图片服务器失败';
    const marked = entry?.id && gone ? '已自动标为失效，不会再被推荐。' : '这次没标记失效（可能只是临时故障），下次还会重试。';
    throw new Error(
      `表情「${label}」发不出去：${kind}（原始错误：${whyRaw}）。${marked}`
      + ' 换一张：list_stickers 换个词搜，或让群友重发这张图后再收藏。'
      + '【给模型的提醒】这是**表情图源**的问题，不是网络/程序故障；不要跟群友说"网断了"。'
    );
  }

  /**
   * 表情字节 → 发给协议端的载荷。
   *
   * 同机协议端（httpUrl 是 127.0.0.1/localhost）：返回**本地文件路径** ——
   *   协议端自己读文件，HTTP 请求体只有几百字节，图多大都不会被 RESET，
   *   而且用的就是缓存里那份字节（跟群里看到的完全一致）。
   * 跨机协议端：只能内联 base64（路径对端读不到），由 sender 那边按大小兜底。
   *
   * @param {object} sticker 表情条目
   * @param {{form?: 'auto'|'file'|'base64'}} [opts] form 用于"换个形态再试一次"
   */
  async stickerPayload(sticker, { form = 'auto' } = {}) {
    const buffer = await this.resolveStickerBytes(sticker);
    const entry = sticker?.id ? this.entries.find((e) => e && e.id === sticker.id) || sticker : sticker;
    if (form !== 'base64' && isLocalHostUrl(this.onebot?.httpUrl)) {
      const file = this.#cachePut(entry, buffer) || this.#cacheHit(entry)?.file;
      if (file) return file;
    }
    return `base64://${buffer.toString('base64')}`;
  }
}
