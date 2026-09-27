// 原生工具集（OpenAI function calling 格式）。
// 与原版 MCP 工具的关键区别：每个工具自动绑定本次运行对应的会话（chatKey），
// 不再需要 key/token 参数 —— 模型物理上无法把消息发到别的群/私聊，安全性反而更强。
//
// 工具命名去掉了 qq_ 前缀（更短，省 token）。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig, DATA_DIR, ROOT } from './config.js';
import { msgRef } from './store.js';
import { isHypeMode, isHypeProtectedTarget, sanitizeHypeProtectedArgs, getHypeProtectedQQ } from './hype-mode.js';
import { normalizeMessageList, unquoteJsonString, stripEmoji, tidyBrackets, stripLeadingReplyPrefix } from './util.js';
import { sanitizeSelfImageClaim, humanizeAt } from './prompt.js';
import { formatStickerList } from './stickers.js';
import { localJevHasRole, jevGate } from './local-jev.js';
import { validateImageUrl, safeFetchBinary, browseLockState, hostAllowed } from './safe-fetch.js';
import { webSearch, webFetch, extractImageUrls, extractPageDigest, buildSiteSearchUrl, searchImages } from './web-search.js';
import { expandForwardNodes, fetchForwardNodes } from './onebot.js';
import { recoverLooseSend, extractStickerAnnotation } from './inline-calls.js';
import { chatCompletion, resolveApiKey, apiWith } from './llm.js';
import { toVisionDataUrls, detectImageMime } from './vision-image.js';
import { reverseImageSearch } from './reverse-image.js';
import { getConversationMemory } from './conversation-memory/runtime.js';
import { ArchiveReader } from './conversation-memory/archive.js';
import { saveMeme, searchMeme, memeCount } from './memes.js';
import { saveTodo, completeTodo } from './conversation-memory/pending.js';
import { getEvidenceLedger, EVIDENCE_STATUS } from './memory-evidence.js';
import { TaskLedger, TASK_STATUS } from './task-ledger.js';
import {
  parseBilibiliVideo, extractVideoFrames, parseBilibiliIds, looksLikeBilibili,
  searchBilibiliVideos, listBiliFavFolders, listBiliFavVideos, resolveBiliFavFolder
} from './bilibili.js';
import { wikiLookup } from './wiki.js';
import { mergeSkillTools } from './skill-bridge.js';
// 扩展底座：merge 在 loadedOnce 前是透传；plugin-loader 由 skill-bridge 懒加载
import {
  searchImageLib, getImageLibEntry, markImageUsed, addImageLib,
  removeImageLib, listImageLib, imageLibCount, resolveImagePath
} from './image-lib.js';

let evidenceLedger = null;
let taskLedger = null;

function evidenceStore() {
  if (!evidenceLedger) evidenceLedger = getEvidenceLedger(path.join(DATA_DIR, 'evidence-ledger.json'));
  return evidenceLedger;
}

function taskStore() {
  if (!taskLedger) taskLedger = new TaskLedger({ file: path.join(DATA_DIR, 'task-ledger.json') });
  return taskLedger;
}

function currentEvidenceScope(ctx) {
  const chatKey = String(ctx?.chatKey || '').trim();
  return chatKey ? `chat:${chatKey}` : '';
}

/**
 * 把"引用结果"翻译成给模型看的一句话（发送类工具都带上它）。
 *
 * 闭环的意义：模型**编**一个编号时必须当场知道"这次没引用上"。实测 2756 次引用里
 * 2089 次是编的（76%），而当时工具只回一句"已发送"，模型以为引用成功了，
 * 下一轮继续编 —— 于是群里就时不时冒出一个引用到无关消息的回复。
 */
function replyNote(reply) {
  if (!reply) return '';
  if (reply.target && !reply.target.unverified) {
    const who = reply.target.sender || '某条消息';
    return `已引用 ${reply.target.ref}（${who}：${String(reply.target.text || '').slice(0, 20)}）。`;
  }
  if (reply.unverified) {
    return `引用 id ${reply.unverified} 本地记录里没有，已按原始 id 发出（可能引用失效）。要稳妥就用聊天记录里的 #短编号（如 #318）。`;
  }
  if (reply.dropped) {
    const why = reply.reason === 'no-mid'
      ? '那条消息没有可用的 QQ 消息 id（发送回执丢了），引用不了'
      : '这个编号在本会话里找不到';
    return `⚠️ ${why}，**这次没有引用**（免得引用到无关消息）。`
      + '引用要照抄聊天记录里每条前面的 #短编号（如 #318）；不确定就先 get_recent_messages 看一眼，别自己编数字。';
  }
  return '';
}

/**
 * 把"发表情失败"的原始报错翻译成一句人能看懂、模型能照实说、管理员能照着查的话。
 *
 * ⚠️ 关键：**不能把锅甩给网络**。用户实测反馈里，模型把这类错误解释成「网断了」，
 * 群里的人于是以为是自己家网络坏了（其实是图源/协议端的问题）。
 */
function describeStickerSendError(primary, secondary = null) {
  const p = String(primary || '');
  const s = secondary ? String(secondary?.message ?? secondary) : '';
  const both = `${p} ${s}`;
  if (/ECONNRESET|EPIPE|socket hang up|重置/i.test(both)) {
    const size = /请求体\s*([\d.]+)\s*MB/.exec(both);
    return '图片字节已经取到了，但协议端在"发送"这一步把连接重置了（本地文件/内联字节两种方式都试过）'
      + (size ? `，这次请求体 ${size[1]}MB` : '')
      + '。这多半是协议端当时正忙或这张图太大，不是群里谁的网络问题；过一会儿再发一次通常就好了。';
  }
  if (/请求超时|ETIMEDOUT|timeout/i.test(both)) {
    return '协议端 30 秒内没有回应（它当时可能正忙）。稍等一会儿再发。';
  }
  if (/ECONNREFUSED/i.test(both)) {
    return '连不上协议端（OneBot 端口没开，或设置里的 snowluma 地址/令牌填错了）。';
  }
  return p + (s && s !== p ? `（换一种发送方式后：${s}）` : '');
}

/**
 * 发表情的公共实现：send_sticker 工具和 send_message 的兜底都走这里。
 * @returns {{content: string, isError?: boolean}}
 */
async function sendStickerById(ctx, rawId, opts = {}) {
  const id = String(unquoteJsonString(String(rawId ?? '').trim()) ?? '').trim();
  if (!id) return err('stickerId 不能为空。');
  if (/^https?:\/\//i.test(id)) return err('stickerId 要填 list_stickers 返回的 id，不是图片地址。想发网图用 send_image(url)。');

  // ⚠️ 2026-09-22：这里原来把所有失败都吞成 null（校验失败、取图失败、发送异常一律 same），
  //   调用方于是只有一句"图源失效或网络失败"，而且**任何**失败都会 markBroken 删库 ——
  //   一次网络抖动就能永久删掉一张好表情。现在：
  //     · trySend 把失败原因带出来（failReason）
  //     · 只有"图确实没了"（404/410/400、非图片）才删库；网络类错误只报错、不删
  async function trySend(sticker, isFallback = false) {
    if (!sticker?.url) return null;
    let localFile = null;
    try {
      // 本地表情（file:///）走 localStickerPath；它返回 null 表示"不在表情目录里/不是本地图"
      localFile = ctx.stickers.localStickerPath?.(sticker.url) || null;
    } catch { localFile = null; }
    if (!localFile) {
      try {
        await validateImageUrl(sticker.url);
      } catch (error) {
        return { failed: true, reason: `图源不可用：${error?.message ?? error}`, gone: /404|410|400|不是图片|非图片/.test(String(error?.message ?? error)) };
      }
    }
    let payload;
    try {
      payload = await ctx.stickers.stickerPayload(sticker);
    } catch (error) {
      const msg = String(error?.message ?? error);
      return { failed: true, reason: `取图失败：${msg}`, gone: /404|410|400|HTTP 4\d\d|不是图片|非图片/.test(msg) };
    }
    const sendOnce = (data) => ctx.sender.sendSticker(ctx.chatKey, sticker, {
      replyToMessageId: opts.replyToMessageId ?? null,
      atUserId: opts.atUserId ?? null
    }, data);
    let result;
    try {
      result = await sendOnce(payload);
    } catch (error) {
      const msg = String(error?.message ?? error);
      // ⚠️ 2026-09-22：用户实测「有的表情能发出来、有的发不出来」，日志是
      //   `send_sticker {stickerId:"123456789_0_0_0_…"} → OneBot 网络错误：read ECONNRESET`。
      //   字节已经取到了，卡的只是"发给协议端"这一跳 —— 而这跳有两条独立的路：
      //   ① 本地文件路径（协议端自己读文件）  ② 内联 base64。
      //   一条被 RESET 就换另一条再试一次；两条都失败才如实报错。
      //   业务错误（图源 404/retcode 非 0）不重试 —— 重试只会失败第二遍。
      let second = null;
      if (/ECONNRESET|EPIPE|socket hang up|请求超时|ETIMEDOUT|重置/i.test(msg)) {
        try {
          const alt = /^base64:\/\//i.test(String(payload || '')) ? 'file' : 'base64';
          const payload2 = await ctx.stickers.stickerPayload(sticker, { form: alt });
          if (payload2 && payload2 !== payload) second = await sendOnce(payload2);
        } catch (error2) {
          return { failed: true, reason: `发送失败：${describeStickerSendError(msg, error2)}`, gone: false };
        }
      }
      if (!second) return { failed: true, reason: `发送失败：${describeStickerSendError(msg)}`, gone: false };
      result = second;
    }
    ctx.stickers.markUsed(sticker.id, String(ctx.session.triggerText || '').slice(0, 100));
    ctx.session.sent.push({
      type: 'sticker',
      text: `[表情包:${sticker.desc || sticker.localNote || sticker.id}]`,
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    });
    ctx.emit('session-update', ctx.session.id);
    return {
      sent: true,
      messageId: result?.message_id ?? null,
      stickerId: sticker.id,
      title: sticker.desc || sticker.localNote || sticker.id,
      note: (isFallback
        ? `原图源已失效，已自动换成「${sticker.desc || sticker.localNote || sticker.id}」。以后优先用 list_stickers 里没坏的。`
        // 说清"实际发出去的是哪一张"：用户实测反馈过「分不清哪个是哪个」——
        // 模型自己不知道发的是哪张，就没法在发错时纠正，也没法回答"你刚发的是哪个"。
        : `已发送表情「${sticker.desc || sticker.localNote || sticker.id}」。`) + replyNote(result?.reply)
    };
  }

  try {
    const sticker = await ctx.stickers.find(id);
    if (!sticker) {
      const fb = ctx.stickers.pickFallback?.();
      if (fb) {
        const r = await trySend(fb, true);
        if (r && r.sent) return ok(r);
      }
      return err(`找不到表情「${id}」。${stickerIdHint(ctx)}`);
    }

    // 已失效条目：find 还能捞到就删掉，换备胎
    if (sticker.broken) {
      try { ctx.stickers.markBroken?.(sticker.id, 'already broken'); } catch { /* ignore */ }
      const fb = ctx.stickers.pickFallback?.(sticker.id);
      if (fb) {
        const r = await trySend(fb, true);
        if (r && r.sent) return ok(r);
      }
      return err(`表情「${sticker.desc || sticker.id}」已失效且没有备胎。用 list_stickers 换一张。`);
    }

    const first = await trySend(sticker, false);
    if (first?.sent) return ok(first);

    // 只有"图真的没了"才删库；网络抖动只报错（下次还能用）
    if (first?.gone) {
      try {
        ctx.stickers.markBroken?.(sticker.id, `send failed / gone: ${String(first.reason || '').slice(0, 60)}`);
      } catch { /* ignore */ }
    }
    const fb = ctx.stickers.pickFallback?.(sticker.id);
    if (fb) {
      const r = await trySend(fb, true);
      if (r && r.sent) return ok(r);
    }
    const why = first?.reason ? `（${first.reason}）` : '';
    return err(`表情「${sticker.desc || sticker.localNote || sticker.id}」发不出去${why}。库里暂时没有可用备胎；可 list_stickers 换一张，或让群友重发图后再收藏。`);
  } catch (error) {
    return err(error?.message ?? error);
  }
}

async function downloadImageAsDataUrl(url, timeoutMs = 30000) {
  const safeUrl = await validateImageUrl(url);
  const { buffer, contentType } = await safeFetchBinary(safeUrl);
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  const mime = detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0];
  return `data:${mime};base64,${buffer.toString('base64')}`;
}

/**
 * 下载图片并归一成视觉接口能吃的 data URL（GIF 抽帧转 PNG 等）。
 * 返回 { dataUrls, failed, skipped, notes }。
 */
async function downloadImageForVision(url) {
  const safeUrl = await validateImageUrl(url);
  const { buffer, contentType } = await safeFetchBinary(safeUrl);
  if (!buffer || !buffer.length) throw new Error('图片内容为空');
  const mime = detectMime(buffer) || String(contentType || 'image/jpeg').split(';')[0];
  const prepared = await toVisionDataUrls(buffer, { mime });
  return prepared;
}

/** 供 orchestrator 自动看图：下载触发消息里的图片。 */
export async function downloadImagesAsDataUrls(urls, { limit = 3, maxFrames = 6 } = {}) {
  const out = [];
  const failed = [];
  const notes = [];
  let skipped = 0;
  for (const url of (urls || []).slice(0, Math.max(1, limit))) {
    if (!url) continue;
    try {
      const prepared = await downloadImageForVision(url);
      // 每张 GIF 最多占 maxFrames 帧，整体也别把上下文撑爆
      const room = Math.max(0, maxFrames - out.length);
      if (!room) break;
      const take = prepared.dataUrls.slice(0, room);
      out.push(...take);
      skipped += prepared.skipped ? 1 : 0;
      if (prepared.note) notes.push(prepared.note);
      if (take.length < prepared.dataUrls.length) notes.push('（帧数已达上限，后面截断）');
    } catch (e) {
      failed.push(String(e?.message ?? e));
    }
  }
  return { dataUrls: out, failed, skipped, notes };
}

function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
  // ⚠️ 这里必须取 0..4（4 个字符）再和 'RIFF' 比。
  //    曾经写成 toString('ascii', 0, 8) === 'RIFF' —— 取出来的是 8 个字符，永远不相等，
  //    于是所有 webp 都被判成"不是图片"（百度 CDN 看到 Accept 里有 webp 就回 webp，
  //    表现就是"后台明明下载到了却发不出去"）。
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  // BMP：少数图站直链是这样的
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  return null;
}

// 找不到表情时给出"正确的 id 长什么样"，避免模型继续拿备注文字/QQ 面板数字瞎猜。
function stickerIdHint(ctx) {
  const all = Array.isArray(ctx.stickers?.entries) ? ctx.stickers.entries : [];
  const picks = [...all]
    .sort((a, b) => (b.useCount || 0) - (a.useCount || 0) || Number(Boolean(b.localNote || b.desc)) - Number(Boolean(a.localNote || a.desc)))
    .slice(0, 3);
  if (!picks.length) return '库是空的，先把表情收藏进来。';
  const lines = picks.map((e) => {
    const label = e.localNote || e.desc || '';
    return `- ${e.id}${label ? `（${String(label).slice(0, 14)}）` : '（无备注）'}`;
  });
  return `库内 stickerId 是一长串字符（形如 collected_123 或 1927…_0_0），不是 QQ 面板小数字、也不是备注文字。可用示例：\n${lines.join('\n')}\n要发哪张就用 list_stickers 查到它的 id 再 send_sticker。`;
}

/** 只出现类型/风格、没有具体歌名的 query（如「古典 提神」） */
function isVagueMusicQuery(q) {
  const t = String(q || '').trim();
  if (!t) return true;
  if (/^(随机|随便|来点歌|来首歌|放点音乐|随便来|随机歌)$/i.test(t)) return false;
  const genreOnly = /^(古典|摇滚|ost|原声|交响|钢琴曲|金属|朋克|民谣|电子|说唱|爵士|轻音乐?)(音乐)?$/i;
  if (genreOnly.test(t)) return true;
  const genres = ['古典', '摇滚', 'OST', '原声', '交响', '金属', '民谣', '电子', '钢琴', '提神', '治愈', '燃'];
  let stripped = t;
  for (const g of genres) stripped = stripped.replace(new RegExp(g, 'ig'), ' ');
  stripped = stripped.replace(/\s+/g, ' ').trim();
  return stripped.length < 2;
}

function isRandomMusicQuery(q) {
  return /^(随机|随便|来点歌|来首歌|放点音乐|随便来|随机歌|random)$/i.test(String(q || '').trim());
}

/** 按 songId 拉网易云详情，补全歌名/歌手（给卡片回退用）。 */
async function fetchNeteaseSongDetail(songId) {
  const id = String(songId || '').trim();
  if (!/^\d+$/.test(id)) return null;
  const headers = {
    'user-agent': 'Mozilla/5.0 (compatible; qq-agent/1.1)',
    referer: 'https://music.163.com/',
    cookie: 'appver=2.0.2;'
  };
  const res = await fetch(
    `https://music.163.com/api/song/detail?ids=[${encodeURIComponent(id)}]`,
    { headers, signal: AbortSignal.timeout(8000) }
  );
  if (!res.ok) return null;
  const j = await res.json();
  const s = j?.songs?.[0];
  if (!s) return null;
  const artist = (Array.isArray(s.artists) ? s.artists : s.ar || [])
    .map((a) => String(a?.name || '')).filter(Boolean).join('/');
  return {
    id: String(s.id ?? id),
    name: String(s.name || '').slice(0, 80),
    artist: artist.slice(0, 40)
  };
}

/** 模糊类型词 → 可搜的具体关键词（每次随机挑几组，避免总推同一首） */
const MUSIC_GENRE_POOL = {
  古典: [
    '贝多芬 致爱丽丝', '贝多芬 月光奏鸣曲', '德彪西 月光', '肖邦 夜曲',
    '黄河钢琴协奏曲', '梁祝 小提琴协奏曲', '四季 维瓦尔第', '卡农 帕赫贝尔',
    '柴可夫斯基 胡桃夹子', '德沃夏克 自新世界'
  ],
  摇滚: [
    '海阔天空 Beyond', '光辉岁月 Beyond', 'Hotel California Eagles',
    'Don\'t Stop Me Now Queen', '晴天 周杰伦', '告白气球 周杰伦',
    '平凡之路 朴树', '蓝莲花 许巍', '海浪 胡彦斌'
  ],
  OST: [
    '天空之城 久石让', 'Summer 久石让', 'Naruto 主题曲',
    '鬼灭之刃 红莲华', '你的名字 前前前世', '星际穿越 主题曲',
    '权游 主题曲', '进击的巨人 红莲弓矢'
  ],
  电子: ['Faded Alan Walker', 'Animals Martin Garrix', 'Unity TheFatRat', 'On My Way'],
  民谣: ['成都 赵雷', '南山南 马頔', '斑马斑马 宋冬野', '董小姐 宋冬野'],
  爵士: ['Fly Me to the Moon', 'Take Five', 'My Funny Valentine'],
  提神: ['We Will Rock You', '海阔天空 Beyond', 'My Heart Will Go On', 'Victory Two Steps From Hell'],
  治愈: ['晴天 周杰伦', '稻香 周杰伦', '夜空中最亮的星 逃跑计划', '遇见 孙燕姿'],
  燃: ['Victory Two Steps From Hell', 'Star Sky', '海阔天空 Beyond', 'In The End']
};

function pickGenreQueries(raw) {
  const s = String(raw || '');
  const out = [];
  for (const [k, list] of Object.entries(MUSIC_GENRE_POOL)) {
    if (s.includes(k) || s.toLowerCase().includes(k.toLowerCase())) {
      out.push(...list);
    }
  }
  // 打乱后取 3 条，降低复读概率
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out.slice(0, 3);
}

/**
 * 歌名括号内容是否像「劣质版本标记」而不是官方副标题。
 * 官方副标题示例：晴天（Silence）、Something (feat. XXX) 里少数正常用法
 * 劣质标记：翻唱 / Live / 钢琴版 / 伴奏 / TV size / Demo / Cover xxx …
 */
const MUSIC_JUNK_PAREN_RE = new RegExp(
  [
    '翻唱', 'cover', '翻调', '钢琴', '吉他', '纯音乐', '伴奏', 'k歌', '卡拉ok', 'karaoke',
    'live', '现场', '演唱会', 'acoustic', 'instrumental', 'demo', 'remix', 'edit',
    'tv\\s*size', 'op\\b', 'ed\\b', '插入歌', '角色歌', '同人', '鬼畜', '调音', '翻唱版',
    '双人翻唱', '原神', '崩坏', '音mad', 'vocaloid翻调', 'cover\\s*by', '弹唱', 'unplugged',
    'remastered\\s*版', '加速', '降调', 'DJ版', '广场舞', '车载', '铃声', '片段', '15秒',
    '动态歌词', '歌词版', '音频版', '视频版', '竖屏', '高音质', '超清'
  ].join('|'),
  'i'
);

/** 整名里的明显劣质标记（不靠括号也要扣）。 */
const MUSIC_JUNK_NAME_RE = new RegExp(
  [
    '\\bcover\\b', '翻唱', '翻调', '钢琴独奏', '钢琴版', '吉他版', '纯音乐版',
    '\\blive\\b', '现场版', '演唱会版', '伴奏', 'k歌', '卡拉ok', 'karaoke',
    '\\bdemo\\b', '\\bremix\\b', '\\btv\\s*size\\b', '广场舞', '车载版', '铃声版'
  ].join('|'),
  'i'
);

/** 提取歌名里所有括号内容（中英文括号）。 */
function extractParenChunks(name) {
  const t = String(name || '');
  const out = [];
  const re = /[（(【\[]([^）)】\]]{1,40})[）)】\]]/g;
  let m;
  while ((m = re.exec(t))) {
    const chunk = String(m[1] || '').trim();
    if (chunk) out.push(chunk);
  }
  return out;
}

/**
 * 标题质量：随机/类型推荐时用来滤垃圾。
 * @returns {{ junk: boolean, softParen: boolean, penalty: number }}
 *  - junk：硬滤（翻唱/现场/钢琴版…）
 *  - softParen：有括号但不像硬垃圾（可能是官方副标题 / feat）
 *  - penalty：扣分（越大越差）
 */
function musicTitleQuality(name) {
  const n = String(name || '');
  if (MUSIC_JUNK_NAME_RE.test(n)) {
    return { junk: true, softParen: false, penalty: 8 };
  }
  const chunks = extractParenChunks(n);
  let junk = false;
  let softParen = false;
  let penalty = 0;
  for (const c of chunks) {
    if (MUSIC_JUNK_PAREN_RE.test(c) || MUSIC_JUNK_NAME_RE.test(c)) {
      junk = true;
      penalty += 8;
    } else if (/feat\.?|ft\.?/i.test(c)) {
      // 官方合作曲常见，不拦
      penalty += 0;
    } else {
      // 括号有内容但不是明显垃圾：可能是官方副标题，随机模式轻扣
      softParen = true;
      penalty += 0.4;
    }
  }
  // 全角括号空/极短（「歌名()」「歌名（）」）
  if (!chunks.length && /[（(]\s*[)）]/.test(n)) {
    junk = true;
    penalty += 4;
  }
  return { junk, softParen, penalty };
}

/**
 * 随机/类型模式下是否该丢掉这首。
 * - 硬垃圾直接丢
 * - 有括号（非 feat）在随机池里降权保留——官方副标题不该全灭，但不再优先
 */
function shouldDropForCasualPlay(hit) {
  const q = musicTitleQuality(hit?.name);
  if (q.junk) return true;
  return false;
}

/** 最近发出的歌 id（防随机复读）；按会话无关，全局短名单 */
const MUSIC_PLAYED_FILE = path.join(DATA_DIR, 'music-played.json');
function loadMusicPlayed() {
  try {
    let t = fs.readFileSync(MUSIC_PLAYED_FILE, 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const j = JSON.parse(t);
    return Array.isArray(j.ids) ? j.ids.map(String) : [];
  } catch {
    return [];
  }
}
function rememberMusicPlayed(songId) {
  try {
    const list = loadMusicPlayed().filter((id) => id !== String(songId));
    list.unshift(String(songId));
    fs.mkdirSync(path.dirname(MUSIC_PLAYED_FILE), { recursive: true });
    fs.writeFileSync(MUSIC_PLAYED_FILE, JSON.stringify({ ids: list.slice(0, 80) }, null, 1), 'utf8');
  } catch { /* ignore */ }
}

/**
 * 网易云搜索。支持 offset 分页（随机用），多关键词重试，按标题/歌手打分。
 */
async function searchNeteaseSong(query, { limit = 8, offset = 0 } = {}) {
  const q = String(query || '').trim().slice(0, 80);
  if (!q) return [];
  const n = Math.max(1, Math.min(20, Number(limit) || 8));
  const off = Math.max(0, Math.min(200, Number(offset) || 0));
  const headers = {
    'user-agent': 'Mozilla/5.0 (compatible; qq-agent/1.1; +netease)',
    referer: 'https://music.163.com/',
    cookie: 'appver=2.0.2;'
  };
  async function tryFetch(url) {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }
  async function searchOnce(term, lim, offs) {
    try {
      const data = await tryFetch(
        'https://music.163.com/api/cloudsearch/pc?s=' + encodeURIComponent(term)
        + '&type=1&limit=' + lim + '&offset=' + offs + '&total=true'
      );
      const list = data?.result?.songs;
      if (Array.isArray(list) && list.length) return list;
    } catch { /* fallthrough */ }
    const data = await tryFetch(
      'https://music.163.com/api/search/get/web?s=' + encodeURIComponent(term)
      + '&type=1&limit=' + lim + '&offset=' + offs
    );
    return data?.result?.songs || [];
  }

  let songs = [];
  try {
    songs = await searchOnce(q, n, off);
  } catch (e) {
    // 整词失败：拆词重试一次
    const parts = q.split(/[\s,，、/]+/).filter(Boolean);
    if (parts.length > 1) {
      try {
        songs = await searchOnce(parts.slice(0, 2).join(' '), n, off);
      } catch (e2) {
        throw new Error('网易云搜索失败：' + (e2?.message ?? e?.message ?? e));
      }
    } else {
      throw new Error('网易云搜索失败：' + (e?.message ?? e));
    }
  }

  const qt = q.toLowerCase().split(/[\s,，、/]+/).filter(Boolean);
  const played = new Set(loadMusicPlayed());
  const scored = songs.map((s) => {
    const name = String(s.name ?? '').slice(0, 80);
    const artist = (Array.isArray(s.artists) ? s.artists : s.ar || [])
      .map((a) => String(a?.name || '')).filter(Boolean).join('/').slice(0, 40);
    const album = String(s.al?.name || s.album?.name || '');
    const hay = (name + ' ' + artist + ' ' + album).toLowerCase();
    let score = 0;
    for (const w of qt) {
      if (!w) continue;
      if (name.toLowerCase().includes(w)) score += 5;
      else if (artist.toLowerCase().includes(w)) score += 4;
      else if (hay.includes(w)) score += 2;
    }
    const quality = musicTitleQuality(name);
    score -= quality.penalty;
    if (played.has(String(s.id ?? ''))) score -= 3;
    // 偏好有歌手信息的结果
    if (artist) score += 0.3;
    // 干净主标题（无括号、无垃圾）小幅加成
    if (!quality.junk && !quality.softParen && extractParenChunks(name).length === 0) {
      score += 0.6;
    }
    return {
      id: String(s.id ?? ''),
      name,
      artist,
      album: album.slice(0, 40),
      score,
      junk: quality.junk
    };
  }).filter((x) => /^\d+$/.test(x.id));
  scored.sort((a, b) => b.score - a.score || Math.random() - 0.5);
  return scored.slice(0, n);
}

/** 从候选里挑一首：随机/类型模式优先没播过的高分项，并滤掉翻唱/现场垃圾。 */
function pickSongFromHits(hits, { random = false, exclude = null } = {}) {
  if (!hits?.length) return null;
  const played = new Set(loadMusicPlayed());
  if (exclude) played.add(String(exclude));

  let list = hits;
  if (random) {
    // 随机/类型：硬垃圾直接扔；再优先干净标题 + 高分
    list = list.filter((h) => !h.junk && !shouldDropForCasualPlay(h));
    if (!list.length) {
      // 全被滤了：退回原列表（避免误伤特殊曲库），但不再随机
      list = hits.filter((h) => !h.junk);
      if (!list.length) list = hits;
    }
    const fresh = list.filter((h) => !played.has(h.id));
    if (fresh.length) list = fresh;
    // 只在高分带里随机：过低分直接排除
    const minScore = Math.min(...list.map((h) => h.score || 0));
    const top = list.filter((h) => (h.score || 0) >= Math.max(minScore, (list[0]?.score || 0) - 2.5));
    list = top.length ? top : list;
    // 权重：分数越高越容易中；带括号官方副标题仍可中但偏弱
    const weighted = [];
    for (const h of list.slice(0, Math.min(10, list.length))) {
      const paren = musicTitleQuality(h.name).softParen ? 0.55 : 1;
      const w = Math.max(1, Math.round(((h.score || 0) + 3) * paren));
      for (let i = 0; i < w; i++) weighted.push(h);
    }
    return weighted[Math.floor(Math.random() * weighted.length)] || list[0];
  }

  // 精确搜索：不硬滤括号（用户点名的歌可能就带副标题）
  const fresh = list.filter((h) => !played.has(h.id));
  if (fresh.length) list = fresh;
  return list.slice(0, Math.min(8, list.length))[0];
}

function ok(payload) {
  return { content: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 1) };
}

function err(message) {
  return { content: `错误：${message}`, isError: true };
}

/**
 * 把用户说的「目标」解析成 group:/private: chatKey。
 * 支持：群号 / group:123 / 群名（模糊匹配 get_group_list）。
 * 多个匹配时报错让模型改口，不猜。
 */
async function resolveForwardTarget(ctx, raw) {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  // 纯数字：先当群号；若机器人根本不在这个群，再尝试当群名片糊匹配（防模型编造数字）
  if (/^\d+$/.test(s)) {
    let groupsNum = [];
    try { groupsNum = await ctx.onebot.getGroupList(); } catch { groupsNum = []; }
    const hit = groupsNum.find((g) => g.id === s);
    if (hit) return `group:${hit.id}`;
    // 不在列表：当名字搜
    const qn = s.toLowerCase();
    const byName = groupsNum.filter((g) => String(g.name || '').toLowerCase().includes(qn));
    if (byName.length === 1) return `group:${byName[0].id}`;
    if (byName.length > 1) {
      throw new Error(`数字「${s}」不是机器人所在群，按名字也匹配到多个：${byName.slice(0, 4).map((g) => `${g.name}(${g.id})`).join('、')}。请改用正确群号或完整群名。`);
    }
    const sample = groupsNum.slice(0, 8).map((g) => `${g.name}(${g.id})`).join('、');
    throw new Error(`群号 ${s} 不在机器人所在群列表。请用群名或正确群号。附近有：${sample}`);
  }
  if (/^(group|private):\d+$/.test(s)) return s;

  // 群名模糊匹配
  let groups = [];
  try {
    groups = await ctx.onebot.getGroupList();
  } catch {
    groups = [];
  }
  const q = s.toLowerCase().replace(/\s+/g, '');
  const scored = [];
  for (const g of groups) {
    const name = String(g.name || '').toLowerCase().replace(/\s+/g, '');
    if (!name) continue;
    if (name === q) scored.push({ score: 100, g });
    else if (name.includes(q) || q.includes(name)) scored.push({ score: 80, g });
    else if (q.length >= 2 && name.includes(q.slice(0, 2))) scored.push({ score: 40, g });
  }
  scored.sort((a, b) => b.score - a.score);
  if (!scored.length) {
    throw new Error(`找不到群「${s}」。请改用群号，或检查群名是否在机器人所在列表里。`);
  }
  if (scored.length > 1 && scored[0].score === scored[1].score) {
    const names = scored.slice(0, 4).map((x) => `${x.g.name}(${x.g.id})`).join('、');
    throw new Error(`群名「${s}」匹配到多个：${names}。请直接用群号。`);
  }
  return `group:${scored[0].g.id}`;
}

/**
 * 单次运行内记忆检索预算：memory_search / memory_archive 共用。
 * 超限直接拒绝，避免「搜不到就一直搜」。
 */
function takeMemorySearchBudget(ctx) {
  const max = Number(ctx?.memorySearchBudget);
  if (!Number.isFinite(max) || max <= 0) return { ok: true, left: Infinity };
  if (!Number.isFinite(ctx.memorySearchUsed)) ctx.memorySearchUsed = 0;
  if (ctx.memorySearchUsed >= max) {
    return {
      ok: false,
      left: 0,
      error: `本次运行记忆检索已达上限（${max} 次）。搜不到就承认想不起来，不要继续搜。`
    };
  }
  ctx.memorySearchUsed += 1;
  return { ok: true, left: max - ctx.memorySearchUsed };
}

function trackTaskSubmission(ctx, taskId, result = {}, payloadSummary = '') {
  if (!taskId) return null;
  const ledger = taskStore();
  const task = ledger.find(taskId, { chatKey: ctx.chatKey });
  if (!task) return { ok: false, error: 'taskId 不属于当前会话或不存在' };
  if (task.status === TASK_STATUS.PROPOSED) ledger.transition(task.id, TASK_STATUS.PENDING, { reason: 'send-started' });
  const submitted = ledger.markSubmitted(task.id, {
    clientRequestId: ctx.runContext?.runId || '',
    payloadSummary,
    reason: 'send-tool-success'
  });
  const messageIds = (Array.isArray(result?.sent) ? result.sent : [])
    .map((item) => item?.messageId)
    .filter(Boolean);
  const confirmed = messageIds.length
    ? ledger.confirmPlatform(task.id, { provider: 'onebot', receiptId: messageIds.join(','), raw: messageIds })
    : submitted;
  return { ok: true, taskId: task.id, submitted: true, platformConfirmed: !!confirmed.platformConfirmed };
}

/** 会话来源标签：当前 / 私聊 / 群。 */
function classifyChatKey(chatKey, current) {
  const k = String(chatKey || '');
  if (k && current && k === current) return '当前会话';
  if (k.startsWith('private:')) return '私聊';
  if (k.startsWith('group:')) return '群';
  return k || '未知';
}

/**
 * 记忆碎片洗成人话（2026-09-21）。
 * 存档里存的是**原始消息**，检索出来直接喂模型时带着一堆机器码 —— 实测模型收到的是
 * 「[引用 愿：[at] 卡的看不了]@愿[CQ:at,qq=123456789] 设置里不能改吗」，既费 token 又难看懂。
 * 现在：@ 渲染成 @你/@名字（复用 humanizeAt），引用压成 ↩摘句，其余标记统一成中文短标记。
 */
export function cleanMemoryText(raw, selfId = '') {
  let s = humanizeAt(raw, selfId || getConfig()?.onebot?.selfId || '');
  s = s
    .replace(/\[引用\s*([^\]]{0,80})\]/g, (m, inner) => `↩${String(inner).replace(/\[(at|reply)\]/g, '').trim().slice(0, 20)}`)
    .replace(/\[合并转发[^\]]*\]/g, '[转发]')
    .replace(/\[图片\]/g, '[图]')
    .replace(/\[表情\d*\]/g, '[表情]')
    .replace(/\[拍一拍\]/g, '（拍一拍）')
    .replace(/\[(at|reply)\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return s;
}

/** memory_search 命中后：分层标注 + 当前优先 + 自动前后文。 */
export function formatSearchHits(hits, ctx, budget, { loose = '' } = {}) {
  const archive = new ArchiveReader({ messagesDir: path.join(DATA_DIR, 'messages') });
  const head = loose
    ? `【粗匹配命中】原词没中，已改用短词：${loose}`
    : '【命中】';
  const parts = [head];

  // 按来源排序：当前会话 > 私聊 > 群
  const rank = (h) => {
    const tag = classifyChatKey(h.chatKey, ctx.chatKey);
    if (tag === '当前会话') return 0;
    if (tag === '私聊') return 1;
    return 2;
  };
  const sorted = [...hits].sort((a, b) => rank(a) - rank(b) || (b.score || 0) - (a.score || 0));

  sorted.slice(0, 3).forEach((h, i) => {
    const tag = classifyChatKey(h.chatKey, ctx.chatKey);
    const sn = (h.snippets || []).slice(0, 3)
      .map((s) => `  ${s.when} ${s.self ? '我' : s.who}: ${cleanMemoryText(s.text, ctx.selfId)}`)
      .join('\n');
    const place = h.hourKey || h.dayKey;
    // 命中词写出来：模型才知道这块是靠"推歌/音乐"命中的，还是只靠"喜欢"这种泛词蹭上的
    const why = Array.isArray(h.matched) && h.matched.length ? ` 命中词:${h.matched.join('/')}` : ' 命中词:（无实词）';
    parts.push(`#${i + 1} [${tag}] ${place}${h.chatKey ? ` chat=${h.chatKey}` : ''}${why}\n${sn}`);

    // 当前会话或第一条：自动带前后文
    if ((i === 0 || tag === '当前会话') && h.chatKey) {
      try {
        const around = archive.loadContextAround({
          chatKey: h.chatKey,
          hour: h.hourKey || undefined,
          day: h.dayKey || undefined,
          anchor: h.snippets?.[0]?.text || '',
          before: 6,
          after: 6,
          maxChars: 900
        });
        if (around?.ok && around.lines?.length) {
          parts.push(`【前后文·${tag}】`);
          parts.push(around.lines.map((l) => cleanMemoryText(l, ctx.selfId)).join('\n'));
        }
      } catch { /* ignore */ }
    }
  });

  const hasCurrent = sorted.some((h) => classifyChatKey(h.chatKey, ctx.chatKey) === '当前会话');
  if (!hasCurrent) {
    parts.push('（没搜到当前会话里的记录，以下是私聊/其它群的）');
  }
  // 全是"靠泛词蹭上的块"时明说 —— 比让模型拿一堆不相干的碎片硬编强。
  // 判据：前三条里没有一块是靠实词（≥2 字的命中词）命中的。
  const weak = !loose && sorted.slice(0, 3).every((h) => !(Array.isArray(h.matched) && h.matched.length));
  if (weak) {
    parts.push('⚠️ 这几块都没命中你要的实词，八成只是字面沾边：**别据此编**，换更具体的词（人名/时间/关键名词）再搜，或直接说想不起来。');
  }
  const h0 = sorted[0];
  if (h0?.hourKey) {
    parts.push(`再挖整天：memory_archive(mode=day, chatKey=${h0.chatKey}, day=${h0.dayKey}, hour=${h0.hourKey})`);
  }
  parts.push('可据此回答；没有把握就说想不起来。');
  parts.push(`剩余检索:${budget.left}`);
  return parts.join('\n');
}

// 找不到消息时，把当前会话真实可用的**短编号**列给模型，避免它继续瞎猜。
// ⚠️ 2026-09-22：这里以前列的是原始 QQ message_id（9~10 位带符号数）。
// 那份清单反而成了"编造模板"——实测模型 76% 的引用目标是编的。现在一律给 #短编号。
function midHint(ctx) {
  const refs = ctx.store.recent(ctx.chatKey, { limit: 60 })
    .map((m) => msgRef(m))
    .filter(Boolean);
  const uniq = [...new Set(refs)].slice(-8);
  return uniq.length
    ? `引用/看图只能填聊天记录里每条消息前的 #短编号（最近可见：${uniq.join(' ')}），照抄，不要自己编数字`
    : '聊天记录里还没有带 #编号 的消息';
}

// 需要数字 QQ 号但模型传了名字时，把当前会话真实可见的成员列出来，让它选一个。
function memberHint(ctx) {
  const members = ctx.store.activeMembers(ctx.chatKey, 8);
  if (!members.length) return '当前没有可用的成员列表，请先等有群友发言后再试';
  const lines = members.map((m) => `- ${m.name}：${m.userId}`).join('\n');
  return `请从当前会话成员里选一个 QQ 号填进去：\n${lines}`;
}

function imageParts(text, dataUrls) {
  const parts = [{ type: 'text', text }];
  for (const url of dataUrls) parts.push({ type: 'image_url', image_url: { url } });
  return parts;
}

/**
 * 预览要求是配置项决定的，工具描述必须跟着变 —— 否则模型会白预览一轮然后停下（实测就是如此）。
 */
function previewRuleText() {
  const opt = getConfig().security?.imageSend || {};
  return opt.requirePreview === false
    ? '选好一张就直接 send_image(url) 发出去（本机已关掉"必须先看一眼"，不要先预览）。'
    : '默认要求先看一眼（先 send_image(url, preview=true) 再发），但浏览锁定站点内的图可以直接发。';
}

/** 当前这台实例有没有开某个工具（按 api.tools 白名单判断；空名单=全开）。 */
function hasTool(name) {
  const list = getConfig().api?.tools;
  if (!Array.isArray(list) || !list.length) return true;
  return list.map(String).includes(name);
}

/**
 * send_message 的 messages 参数 schema。
 *
 * ⚠️ 对本地小模型只给**数组**一种写法（api.sendMessagesArrayOnly）：
 * 实测它经常生成 `{"messages":"[\"第一条\",\"第二条\"]"}`（把数组塞进字符串），
 * 两种可选写法等于多一个出错机会。后台仍然兼容字符串（只是不再告诉它）。
 */
function messagesParamSchema() {
  const arrayOnly = getConfig().api?.sendMessagesArrayOnly === true;
  if (arrayOnly) {
    return {
      type: 'array',
      items: { type: 'string' },
      description: '要发送的内容，字符串数组，每个元素是一条消息。就算只说一句也要写成 ["你好"] 这种数组。',
      minItems: 1
    };
  }
  return {
    description: '要发送的内容：字符串=一条；数组=分多条',
    oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }]
  };
}

/**
 * 构建绑定一次运行的工具集。
 * ctx: {
 *   chatKey, kind, chatId, selfId, selfNickname, botName,
 *   onebot, store, memory, stickers, sender, session,
 *   emit  (事件上报给 UI/日志)
 * }
 */
export function buildToolDefs() {
  const defs = [
    {
      name: 'send_message',
      description: '发送消息。messages 传字符串数组=分多条发送（推荐）。数组里每个字符串是一条完整消息，不要把调用语法/表情id写进去。需要引用时才传 replyToMessageId；需要 @ 人时才传 atUserId。',
      parameters: {
        type: 'object',
        properties: {
          messages: messagesParamSchema(),
          replyToMessageId: { type: ['integer', 'string'], description: '要引用/回复哪条消息：填聊天记录里那条前面的 #短编号（如 #318，照抄）。不填=不引用。填错编号会被丢掉（不会引用到别的消息）' },
          atUserId: { type: ['integer', 'string'], description: '要 @ 的群成员 QQ 号（可选）' },
          taskId: { type: 'string', description: '本次发送对应的任务账本 id（可选）' }
        },
        required: ['messages']
      },
      async execute(ctx, args) {
        try {
          // 亢奋模式硬锁：不许 @ 受保护账号
          const hypeSan = sanitizeHypeProtectedArgs(args);
          if (hypeSan.strippedAt) {
            args = hypeSan.args;
          }
          let messages = normalizeMessageList(args.messages);
          let looseSticker = '';
          // 亢奋：见人就骂，按配置强制最低条数
          const hypeMin = Math.max(0, Number(getConfig().hypeMode?.minMessages) || 0);
          if (isHypeMode() && hypeMin > 0 && messages.length > 0 && messages.length < hypeMin) {
            const sample = Array.from({ length: hypeMin }, (_, i) => `"${i + 1}"`).join(',');
            return err(`亢奋模式至少发 ${hypeMin} 条（当前 ${messages.length} 条）。把连击补满再 send_message，例如 [${sample}]。`);
          }
          // 流式内容块被切碎后当成 messages 数组发出去（实测 09-12 17:56 某个群：
          // 群里连刷 `{'type': 'text` / `text': 'The'}` 十几条英文碎词）。
          // normalize 里已尝试拼回；拼不回就空数组 → 下面报错，绝不刷屏。
          if (!messages.length && Array.isArray(args.messages) && args.messages.length >= 3) {
            return err('你把内容块（{"type":"text","text":…}）切碎塞进了 messages。要发的话只写纯文本字符串数组，例如 ["完整的一句话"]，不要发 JSON/对象/半截字段名。重发一次。');
          }
          // ── 参数兜底：模型把"数组文本"整段塞进 messages 参数 ──
          // 实测（本地小模型）：send_message 容易把数组/标签学舌塞进参数
          // 正文解析在这里永远不触发（本轮确实调了工具），若不救就会把一串方括号原样发到群里。
          const recoverInput = messages.length === 1 ? messages[0] : messages.join(' ');
          const recovered = recoverLooseSend(recoverInput);
          if (recovered) {
            messages = recovered.messages;
            looseSticker = recovered.stickerId;
            // 草稿纸倾倒（实测 02:05）：整段是"内心思考 + XML 调用块 + 回忆的历史"，
            // 里面没有一句要说给群里听的话 —— 宁可报错让它重发，也绝不把自言自语倒进群。
            if (recovered.scratchpad && !messages.length && !looseSticker) {
              return err('你这次的 messages 是草稿纸（内心思考 + 调用语法 + 回忆的历史），没有一句是说要给群里听的。参数里只写要说的话，别的一律别写，重发一次。');
            }
          }

          // 表情库说明被抄进文字时，先核实 id，再交给真正的表情发送路径。
          // 保留原消息数组的分条；未知/多个 id 在发送任何文字之前退回纠正。
          const annotations = messages.map(extractStickerAnnotation);
          if (annotations.some(Boolean)) {
            const ids = [...new Set([looseSticker, ...annotations.flatMap(a => a?.ids || [])].filter(Boolean))];
            if (ids.length !== 1) return err('messages 里混入了多个表情 id。文字只放正文，每张表情分别调用 send_sticker(stickerId)。');
            if (!await ctx.stickers.find(ids[0])) return err(`找不到表情「${ids[0]}」。请用 list_stickers 查有效 id，再调用 send_sticker；不要把表情描述和 id 发成文字。`);
            looseSticker = ids[0];
            messages = messages.map((message, i) => annotations[i]?.message ?? message).filter(Boolean);
          }

          // ── 清掉"方块装饰"（send.tidyBrackets，按号配置）──
          // 本地小模型学舌：每条消息结尾可能挂着 ～】]（详见 util.tidyBrackets 注释）
          let bracketTidied = 0;
          if (getConfig().send?.tidyBrackets === true && messages.length) {
            const cleaned = [];
            for (const text of messages) {
              const t = tidyBrackets(text);
              if (t !== String(text).trim()) bracketTidied += 1;
              if (t) cleaned.push(t);
            }
            messages = cleaned;
            if (!messages.length && !looseSticker) return err('这条消息清掉方块标记之后是空的，重新说一句正常的话。');
          }

          // ── 不许发 emoji（send.stripEmoji，按号配置）──
          // 小模型爱在句尾挂个 😅，看着敷衍；这里在发出前统一剥掉，中文标点原样保留。
          let emojiStripped = 0;
          if (getConfig().send?.stripEmoji === true && messages.length) {
            const cleaned = [];
            for (const text of messages) {
              const s = stripEmoji(text);
              if (s !== String(text)) emojiStripped += 1;
              if (s) cleaned.push(s);
            }
            messages = cleaned;
            if (!messages.length && !looseSticker) {
              return err('这条消息去掉 emoji 之后是空的（本机设置不许发 emoji）。换句话再说一遍，别拿 emoji 顶字数。');
            }
          }
          if (!messages.length && !looseSticker) return err('消息内容为空');

          // ── 中文优先：拦下整段英文（允许夹中文里的一两个英文词）──
          // 实测 qwen 偶尔把思考/英文独白直接 send_message 发出去。
          if (getConfig().send?.blockPureEnglish !== false) {
            const bad = [];
            for (const text of messages) {
              const t = String(text || '');
              const cjk = (t.match(/[一-鿿]/g) || []).length;
              if (cjk > 0) continue;
              // 无中文：允许极短感叹/缩写；拦「像句子」的整段英文
              const words = t.match(/[A-Za-z][A-Za-z']*/g) || [];
              if (t.trim().length >= 8 && words.length >= 3) bad.push(t.slice(0, 40));
            }
            if (bad.length) {
              return err(`这几句是纯英文，群里默认说中文。改成中文再说：「${bad[0]}」。允许夹一两个英文词，但主体要是中文。`);
            }
          }

          // ── 身份兜底：不许把「我是 AI/大模型」发进群 ──
          // lean/full 都可能嘴漏；宁可拦下让模型按角色卡重说。
          if (getConfig().send?.blockAiSelfClaim !== false) {
            const hit = messages.find((t) => looksLikeAiSelfClaim(t));
            if (hit) {
              return err(`禁止发「自称 AI/模型/程序」的话：「${String(hit).slice(0, 40)}」。你是角色卡里那只鲸，按人设装傻/反讽/转移话题，重新 send_message。`);
            }
          }

          // ── 结构碎片兜底：模型偶尔把"工具参数"当正文发出来 ──
          // 实测 2026-09-21 20:34 私聊，群里收到的是：
          //   ["哭这么大声 我在隔壁湾都听见了"], "replyToMessageId":
          // 这不是话，是它写歪的 send_message 参数。命中就拦回去，让它把真正要说的话写进 messages。
          if (getConfig().send?.blockJsonFragments !== false) {
            const fragHit = messages.find((t) => looksLikeToolArgFragment(t));
            if (fragHit) {
              return err(`这条不是要发的话，是工具参数的碎片：「${String(fragHit).slice(0, 60)}」。把真正要说的话（纯文字）放进 messages 数组重发。`);
            }
          }

          // ── 图片标注腔兜底：模型偶尔把"看图标注"当发言发出来 ──
          // 实测 2026-09-21 22:43（触发里有两张群友发的图，没人让它分析）：
          //   一口气发了 7 条 ——「图片 #1 描述：一只黑白猫站在地上」「歪着头瞪大眼睛看镜头」
          //   「表情惊恐又呆滞」「眼神涣散」「旁边散落着拖鞋。」…
          // 这不是群友说话的方式，而且这种腔调会进历史、下一轮被它自己当范文抄。
          {
            const capHit = messages.find((t) => /图片\s*#?\d*\s*描述/.test(String(t || '')));
            if (capHit) {
              return err(`别发图片标注：「${String(capHit).slice(0, 40)}」。群里怎么看图就怎么说人话 —— 一两句随口的反应就行（「这猫吓得耳朵都贴后脑勺了」），不要「图片 #N 描述：…」这种格式，也别把一句话拆成好几条。`);
            }
          }

          // ── 长消息自动分条（可配 send.splitLongAt，0 = 关）──
          // 小模型爱把一段新闻/一段解释塞进一个气泡（实测 109 字一条），
          // 而真人是一句一条。这里按中文标点切成几条，更像打字。
          const splitAt = Math.max(0, Number(getConfig().send?.splitLongAt) || 0);
          if (splitAt) {
            const split = [];
            for (const text of messages) {
              const t = String(text);
              if (t.length <= splitAt) { split.push(t); continue; }
              const parts = t.split(/(?<=[。！？；!?;])/).map((s) => s.trim()).filter(Boolean);
              let buf = '';
              for (const p of parts) {
                if (buf && (buf + p).length > splitAt) { split.push(buf); buf = ''; }
                buf = buf ? buf + p : p;
                while (buf.length > splitAt) { split.push(buf.slice(0, splitAt)); buf = buf.slice(splitAt); }
              }
              if (buf) split.push(buf);
            }
            messages = split.slice(0, 4);
          }

          // 占位符不算消息：小模型会把 "[图片]" 当成"我发了一张图"直接发出去
          const placeholder = messages.find((t) => /^\s*[\[【]\s*(图片|表情|表情包|语音|视频|文件|卡片消息|合并转发)\s*[\]】]\s*$/.test(String(t)));
          if (placeholder) {
            return err(`「${String(placeholder).trim()}」是占位符，不是你发的图/表情。想发网图：search_images("关键词") 找直链再 send_image(url)；想发表情：list_stickers 查 id 再 send_sticker(id)。`);
          }

          // ── 存档标记不许当话发出去 ──
          // 实测（09-11 16:51 私聊）：模型把存档里记表情的写法照抄进了正文，
          // 群里收到的是「收到啦 这张啥来着？好看就行哈哈 [表情包:换的表情试试]」。
          // 这些标记（[表情包:名字] / [表情夹:…] / 行内的 [图片]）只可能是抄来的，统一剥掉。
          {
            let stripped = 0;
            const cleaned = [];
            for (const text of messages) {
              const before = String(text);
              // 先剥掉开头的装饰前缀（[引用 …] / #消息id / [09-11 22:40] / "回复某某："），
              // 再走后面的存档标记清理：这些前缀是模型照抄提示词格式写出来的，发出去很怪。
              let after = stripLeadingReplyPrefix(before)
                .replace(/[\[【]\s*表情包?\s*[:：][^\]】]*[\]】]/g, ' ')
                .replace(/\s*[\[【]\s*(图片|表情|表情包)\s*[\]】]\s*$/g, ' ')
                // QQ 表情的内部 id 漏出来（实测 19:20 号A 在群里发了「em_jb_微笑」）
                .replace(/\bem_[a-z]+_[^\s，。！？、,.!?]{1,20}/g, ' ')
                // 收藏表情 id / 长哈希（collected_xxx / 1927…_0_0_0_XXX_0_0）
                .replace(/\bcollected_-?\d+/g, ' ')
                .replace(/\b\d{8,}_[0-9A-Fa-f_]{8,}\b/g, ' ')
                // 系统/框架错误串（实测 09-14 依绫群发出「System: Empty message content sanitized」）
                .replace(/^\s*System:\s*.+/i, ' ')
                .replace(/\bEmpty message content sanitized\b/gi, ' ')
                .replace(/\b(Response ID|Request ID|trace[_ ]?id|correlation[_ ]?id)\s*[:：]?\s*\S+/gi, ' ')
                // 用文字"假装发了表情"：实测 09-11 17:17 它发了
                // 「（发了个绿发小恶魔抱紧你的表情）」，而系统实际配的是另一张 —— 纯属误导。
                .replace(/[（(【\[]\s*(我)?\s*(给你)?\s*(发了?|来|扔|甩|贴|塞)(了|个|一张|张)?\s*[^）)】\]]{0,24}?(表情包?|贴图)\s*[）)】\]]/g, ' ')
                // 还有一类：把内部调用写法当话发出去
                .replace(/^[\s「『"']*调用[：:]\s*/, '')
                .replace(/^(send_message|send_sticker|send_image|search_images|web_search|finish)\s*\([^)]*\)\s*$/, '')
                .replace(/[ \t]{2,}/g, ' ')
                .trim();
              if (after !== before.trim()) stripped += 1;
              if (after) cleaned.push(after);
            }
            if (stripped) {
              messages = cleaned;
              if (!messages.length && !looseSticker) {
                return err('你这条消息里只有存档标记（像 [表情包:xxx] 那种），没有真的话。要说就说人话；想发表情直接用工具。');
              }
            }
          }

          // 整段清理后仍是空 → 拒发
          // 只压水平空白，保留换行：fitReplyBubbles 会把多行合并进一个气泡（\n 分隔），
          // 这里若用 /\s+/ 会把换行也吃掉，限额合并就变成一坨空格连排。
          messages = messages.map((t) => String(t || '')
            .split('\n')
            .map((line) => line.replace(/[ \t ]+/g, ' ').trim())
            .join('\n')
            .trim()).filter(Boolean);
          if (!messages.length && !looseSticker) {
            return err('消息清洗后为空（可能是系统错误串/表情 id）。重新说一句人话，别把内部 id 或 System: 错误信息发出去。');
          }

          // ── 复读拦截 ──
          // ① 同一轮里把同一句话发两遍（实测 02:35「欸嘿～ | 欸嘿～」）—— 无论多短都拦，
          //    因为一轮之内重复自己没有任何正当理由。
          // ② 20 分钟内跟历史重复（只拦有点长度的，"6""草""？"这类语气词允许重复）。
          // 归一化要吃掉标点、引号、括号、emoji：实测它会把同一段话去掉标点再发一遍（02:44）。
          const norm = (s) => String(s ?? '')
            .replace(/[\s，。！？、~～…,.!?；;：:、"'"'「」『』【】\[\]（）()]/g, '')
            .replace(/[\u{1F1E6}-\u{1F1FF}\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0E}\u{FE0F}\u{200D}\u{20E3}]/gu, '')
            .toLowerCase();
          const sentThisRun = new Set((ctx.session.sent || []).filter((s) => s.type === 'text').map((s) => norm(s.text)));
          // 本轮已发过的整句（用来抓"退化复读"：把上一条又裹进新句里）
          const sentThisRunList = [...sentThisRun].filter((s) => s.length >= 4);
          const repeatInRun = [];
          let selfRecent = [];
          try {
            selfRecent = (ctx.store.recent(ctx.chatKey, { limit: 40 }) || []).filter((m) => m.self);
          } catch { /* 存档拿不到就不拦 */ }
          const fresh = selfRecent.filter((m) => Date.now() - Number(m.ts || 0) < 20 * 60 * 1000);
          const dupes = [];
          const keep = [];
          const batchSeen = new Set();
          const batchList = [];
          let degenerateCount = 0;
          for (const text of messages) {
            const n = norm(text);
            // ① 本轮已发过的 + 同一次调用里重复出现的，都算"一轮内重复自己"
            if (n && (sentThisRun.has(n) || batchSeen.has(n))) { repeatInRun.push(text); continue; }
            // ② 退化复读：这条把本轮（或本次调用）刚说过的整句**裹进了自己里面**
            //    （实测 03:03 连发 8 条，一条比一条长：`【我哪敢…】怕被举报` → `…那眼神多无辜～】怕被举报…` → …）。
            //    这不是"又说了一遍"，是模型在原地打转，必须掐掉。
            if (n.length >= 4 && [...sentThisRunList, ...batchList].some((p) => n.includes(p))) {
              degenerateCount += 1;
              repeatInRun.push(text);
              continue;
            }
            if (n) { batchSeen.add(n); batchList.push(n); }
            if (n.length >= 6 && fresh.some((m) => norm(m.text) === n)) dupes.push(text);
            else keep.push(text);
          }
          // 连续退化到第 3 条就升级措辞：让它立刻收手，而不是换个说法继续绕。
          const blocked = repeatInRun.length + dupes.length;
          ctx.session.repeatBlocks = Math.max(0, Number(ctx.session.repeatBlocks) || 0) + blocked;
          if (repeatInRun.length && !keep.length) {
            const heat = degenerateCount >= 2 || ctx.session.repeatBlocks >= 3;
            return err(heat
              ? `停 —— 你这一轮已经绕了 ${ctx.session.repeatBlocks} 条重复内容了（刚那条还在把前面说过的话往里裹）。别再发消息了，这轮已经说够了，别再发言。`
              : `这一轮你已经发过「${String(repeatInRun[0]).slice(0, 30)}」了，同一句话不许发两遍（换个标点也算）。要么补点新信息，要么直接结束。`);
          }
          if (dupes.length && !keep.length) {
            if (!looseSticker) {
              return err(`复读拦截：这句你 20 分钟内已经发过了（「${String(dupes[0]).slice(0, 30)}」）。别重复自己 —— 换个说法、说点新的，或者这轮就到此为止。`);
            }
            // 文字全是复读，但参数兜底还捞出一个表情：表情照发，文字不重复
            const stickerOnly = await sendStickerById(ctx, looseSticker, {
              replyToMessageId: args.replyToMessageId ?? null,
              atUserId: args.atUserId ?? null
            });
            if (stickerOnly.isError) return stickerOnly;
            return ok({ sent: 1, note: `${dupes.length} 条文字和 20 分钟内说过的重复，已自动跳过；只发了表情。别复读。` });
          }
          if (dupes.length) {
            // 部分重复：只发新的那些，并把被拦的告诉模型
            const result = await ctx.sender.sendTextBatch(ctx.chatKey, keep, {
              replyToMessageId: args.replyToMessageId ?? null,
              atUserId: args.atUserId ?? null
            });
            ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
            ctx.emit('session-update', ctx.session.id);
            const taskTracking = trackTaskSubmission(ctx, args.taskId, result, keep.join('\n'));
            return ok({
              sent: result.sent.length,
              skipped: dupes.length,
              taskTracking,
              note: `有 ${dupes.length} 条和 20 分钟内说过的重复，已自动跳过：${dupes.map((d) => `「${String(d).slice(0, 20)}」`).join('、')}。别复读。`
            });
          }
          if (repeatInRun.length) {
            // 一轮内重复自己：只发新的那部分
            const result = await ctx.sender.sendTextBatch(ctx.chatKey, keep, {
              replyToMessageId: args.replyToMessageId ?? null,
              atUserId: args.atUserId ?? null
            });
            ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
            ctx.emit('session-update', ctx.session.id);
            const taskTracking = trackTaskSubmission(ctx, args.taskId, result, keep.join('\n'));
            return ok({
              sent: result.sent.length,
              skipped: repeatInRun.length,
              taskTracking,
              note: `有 ${repeatInRun.length} 条是你这一轮已经发过的（${repeatInRun.map((d) => `「${String(d).slice(0, 20)}」`).join('、')}），已跳过 —— 同一句话不许发两遍。`
            });
          }

          // ── 单次运行条数上限（防小模型一口气刷屏）──
          const maxPerRun = Math.max(1, Number(getConfig().send?.maxPerRun) || 4);
          const already = (ctx.session.sent || []).length;
          if (already >= maxPerRun) {
            return err(`这次处理已经发过 ${already} 条了（上限 ${maxPerRun}），不要再发了 —— 直接结束这一轮。`);
          }
          const capped = messages.slice(0, Math.max(1, maxPerRun - already));

          let result = { sent: [], failed: [] };
          if (capped.length) {
            result = await ctx.sender.sendTextBatch(ctx.chatKey, capped, {
              replyToMessageId: args.replyToMessageId ?? null,
              atUserId: args.atUserId ?? null
            });
            ctx.session.sent.push(...result.sent.map((s) => ({ type: 'text', text: s.text, at: s.at })));
            ctx.emit('session-update', ctx.session.id);
          }
          // 参数兜底捞出来的表情一起发掉，别让它白解析一场
          let stickerNote = '';
          if (looseSticker) {
            const stickerRes = await sendStickerById(ctx, looseSticker, {
              replyToMessageId: args.replyToMessageId ?? null,
              atUserId: args.atUserId ?? null
            });
            stickerNote = stickerRes.isError ? `（顺带要发的表情没发成：${stickerRes.content}）` : '（表情也发了）';
          }
          const note = ['已发送。不要输出"已发送"类汇报，继续思考下一步或直接结束。'];
          if (recovered) note.push('注意：这次 messages 参数里塞的是数组文本/表情 id，已按你的意思拆开处理。下次直接把要说的话写进 messages（数组=分多条发送），表情用 send_sticker(id)。');
          if (emojiStripped) note.push(`（本机设置不许发 emoji，已自动去掉 ${emojiStripped} 条里的 emoji）`);
          if (bracketTidied) note.push(`（有 ${bracketTidied} 条结尾挂着多余的方块括号，已清掉。别用【】「」这类方块包词，直接说人话）`);
          if (stickerNote) note.push(stickerNote);
          if (capped.length < messages.length) note.push(`（一次最多发 ${maxPerRun} 条，超出的没发）`);
          if (result.failed.length) note.push(`（另有 ${result.failed.length} 条发送失败：${result.failed.map((f) => f.error).join('；')}——成功的不需要重发，失败的请稍后再试或减少条数）`);
          const rn = replyNote(result.reply);
          if (rn) note.push(rn);
          const taskTracking = trackTaskSubmission(ctx, args.taskId, result, capped.join('\n'));
          return ok({ sent: result.sent.length, messageIds: result.sent.map((s) => s.messageId), taskTracking, note: note.join('') });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_sticker',
      description: '发送一个 QQ 收藏表情（一条消息只能一张表情，不能附带文字；想说的话先用 send_message 单独发）。stickerId 必须是 list_stickers 返回的 id（一长串字符，形如 collected_123 或 1927…_0_0；不是备注文字，也不是 QQ 面板小数字）。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string', description: '表情 id（list_stickers 返回的 id 字段，照抄不要改）' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用哪条消息（聊天记录里那条前面的 #短编号，如 #318）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        const hypeSan = sanitizeHypeProtectedArgs(args);
        if (hypeSan.strippedAt) args = hypeSan.args;
        return sendStickerById(ctx, args.stickerId, {
          replyToMessageId: args.replyToMessageId ?? null,
          atUserId: args.atUserId ?? null
        });
      }
    },
    {
      name: 'send_image',
      description: `把一张网图发到当前会话（独立气泡）。url 必须是图片直链（http/https，png/jpg/gif/webp）——网页地址不行：先 web_fetch 抓那页，再从返回的 images 里挑一条直链。${previewRuleText()}一次处理最多发 2 张。`,
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '图片直链（http/https，png/jpg/gif/webp）' },
          preview: { type: 'boolean', description: 'true = 只下载给自己看一眼，不发送（发图前默认要先看一眼）' },
          note: { type: 'string', description: '可选：一句话说明这张图是什么（只进存档）' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：要引用哪条消息（聊天记录里那条前面的 #短编号，如 #318）' },
          atUserId: { type: ['integer', 'string'], description: '可选：要 @ 的 QQ 号' }
        },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const opt = getConfig().security?.imageSend || {};
          if (opt.enabled === false) return err('发图功能已在设置里关闭（设置 → 聊天设置 → 发图）。');
          const url = String(args.url ?? '').trim();
          if (!/^https?:\/\//i.test(url)) {
            return err('url 必须是 http(s) 图片直链。手上若是网页地址，先用 web_fetch 抓那页，再从返回的 images 里挑直链。');
          }
          const isPreview = args.preview === true;
          if (!Array.isArray(ctx.session.imagePreviewed)) ctx.session.imagePreviewed = [];
          const previewed = ctx.session.imagePreviewed;
          const sentImages = (ctx.session.sent || []).filter((s) => s.type === 'image').length;
          const maxSend = Math.max(1, Number(opt.maxPerRun) || 2);
          const maxPrev = Math.max(1, Number(opt.maxPreviewsPerRun) || 3);
          if (isPreview && previewed.length >= maxPrev) {
            return err(`这次处理已经看过 ${maxPrev} 张图了，别再挑了：直接发其中一张，或者先说话。`);
          }
          if (!isPreview && sentImages >= maxSend) {
            return err(`一次处理最多发 ${maxSend} 张图，这次已经发够了。`);
          }
          // 锁定站点里的图 = 管理员已经声明"这些站可信"，不必再花视觉 token 看一遍
          let trusted = false;
          if (opt.skipPreviewForLockedHosts !== false) {
            const lock = browseLockState();
            if (lock.enabled) {
              try { trusted = hostAllowed(new URL(url).hostname, lock); } catch { trusted = false; }
            }
          }
          if (!isPreview && opt.requirePreview !== false && !trusted && !previewed.includes(url)) {
            return err(`发图前要先看一眼：先调 send_image(url, preview=true) 确认这张图合适，再调 send_image(url) 发送。`);
          }
          // 下载走 safe-fetch 的全套 SSRF 防护（DNS 固定、逐跳校验、限长）
          const maxBytes = Math.max(1, Number(opt.maxBytesMB) || 5) * 1024 * 1024;
          let buffer; let contentType;
          try {
            // browseLocked：开了浏览锁定时，网图也只能来自锁定的站点
            ({ buffer, contentType } = await safeFetchBinary(url, maxBytes, { browseLocked: true }));
          } catch (error) {
            const msg = String(error?.message ?? error);
            // 404 多半是模型抄 URL 时手抖（实测把 /2026/04/xx.jpg 抄成 /2026-04-xx.jpg），
            // 顺手提醒它原样复制，别自己"修正"路径。
            const hint = /HTTP 404/.test(msg)
              ? '（地址可能抄错了：请从 web_fetch 返回的 images 里原样复制，别改动路径字符；也可能是图已删除）'
              : '';
            return err(`图片下载失败：${msg}${hint}`);
          }
          if (!buffer || !buffer.length) return err('图片内容为空');
          // 只认魔数：很多"图片链接"其实返回 HTML 或防盗链提示页
          const mime = detectMime(buffer);
          if (!mime) {
            const head = buffer.subarray(0, 200).toString('utf8').trim().toLowerCase();
            if (head.startsWith('<!doctype html') || head.startsWith('<html')) {
              return err('这个地址返回的是网页（HTML），不是图片直链。先用 web_fetch 抓那页，再从它返回的 images 里挑一条直链。');
            }
            return err(`这个地址返回的不是图片（Content-Type: ${contentType || '未知'}）。只支持 png/jpg/gif/webp 直链。`);
          }
          const b64 = buffer.toString('base64');
          if (isPreview) {
            if (!previewed.includes(url)) previewed.push(url);
            // 预览走归一化：GIF 抽帧转 PNG；webp/avif 转不动且接口不吃就退回文字说明
            // （url 仍记进 previewed，模型接着 send_image(url) 能直接发原图）。
            const prepared = await toVisionDataUrls(buffer, { mime, maxFrames: 6 });
            if (prepared.skipped || !prepared.dataUrls.length) {
              return ok(`这张图是 ${mime}（约 ${Math.round(buffer.length / 1024)}KB）。${prepared.note || `本机视觉接口不支持 ${mime}`}，看不到画面内容，但字节已校验过是真图、QQ 里能正常显示。你觉得合适就直接调 send_image(url) 发出去（URL 照抄：${url}）。`);
            }
            const frameNote = prepared.note ? `${prepared.note} ` : '';
            return { content: imageParts(`这张图（${mime}，约 ${Math.round(buffer.length / 1024)}KB）${frameNote}——觉得合适就立刻调 send_image(url) 发出去：`, prepared.dataUrls) };
          }
          const result = await ctx.sender.sendImage(ctx.chatKey, { dataUrl: `base64://${b64}`, note: args.note }, {
            replyToMessageId: args.replyToMessageId ?? null,
            atUserId: args.atUserId ?? null
          });
          // 记下 URL，后面 send_image 会避开已发过的图
          if (!Array.isArray(ctx.session.imageUrlsSeen)) ctx.session.imageUrlsSeen = [];
          if (!ctx.session.imageUrlsSeen.includes(url)) ctx.session.imageUrlsSeen.push(url);
          ctx.session.sent.push({
            type: 'image',
            url,
            text: `[图片${args.note ? `:${String(args.note).slice(0, 40)}` : ''}]`,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: `图片已发送。${replyNote(result?.reply)}` });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_music',
      // ⚠️ 2026-09-22：这句结尾以前写的是"要引用请先 send_message 再发本工具"，
      // 教模型分两轮走 —— 而"发完文字就自动收尾"，第二步根本走不到（实测 4 次音乐卡没发出来）。
      // 现在明确要求挤在同一轮里；分两轮也不再会被收尾（见 orchestrator 的 musicGrace 宽限）。
      description: '发网易云音乐卡片。query=具体歌名（可加歌手）自动搜出卡；query=随机/古典/摇滚/OST 会自动扩写挑选并避开最近发过的；或 musicUrl / songId。多首分多次调用。注意：音乐卡不能带引用（reply），带了会被 QQ 吞；想配一句话就在**同一次调用里**一起调 send_message（引用加在它身上）+ send_music，别分两轮。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '歌名或「歌名 歌手」；也可填「随机」或「古典/摇滚/OST…」让系统扩写挑选并避重。' },
          musicUrl: { type: 'string', description: '已有网易云链接时用，如 https://music.163.com/#/song?id=186016' },
          songId: { type: ['integer', 'string'], description: '歌曲数字 id' },
          title: { type: 'string', description: '可选：覆盖卡片标题' },
          artist: { type: 'string', description: '可选：覆盖歌手名' }
        },
        required: []
      },
      async execute(ctx, args) {
        try {
          let songId = String(args.songId ?? '').trim().replace(/^["']|["']$/g, '');
          let title = String(args.title ?? '').trim().slice(0, 80);
          let artist = String(args.artist ?? '').trim().slice(0, 40);
          const url = String(args.musicUrl ?? '').trim();
          if (!songId && url) {
            const m = /(?:id=|song\/)(\d+)/i.exec(url);
            if (m) songId = m[1];
            else if (/^\d+$/.test(url.replace(/\D/g, '')) && url.includes('163')) songId = url.replace(/\D/g, '');
          }
          if (!songId && /^\d+$/.test(String(args.musicUrl ?? '').trim())) {
            songId = String(args.musicUrl).trim();
          }
          // 歌名 / 类型 / 随机 → 搜索并挑歌
          if (!songId) {
            const q = String(args.query ?? '').trim();
            if (!q) return err('需要 query=歌名、随机、古典/摇滚等类型、网易云链接，或 songId。');

            const randomMode = isRandomMusicQuery(q) || args.random === true;
            let searchQ = q;
            let hits = [];

            if (randomMode) {
              // 随机：常见歌池 + 小 offset（大 offset 翻唱/现场占比高）
              const seedPool = [
                '周杰伦 晴天', '周杰伦 稻香', 'Beyond 海阔天空', '五月天 突然好想你',
                '陈奕迅 富士山下', '林俊杰 江南', '薛之谦 演员',
                '邓紫棋 光年之外', '李荣浩 年少有为', '毛不易 消愁',
                '夜空中最亮的星', '成都 赵雷', '孙燕姿 遇见', '朴树 平凡之路'
              ];
              for (let attempt = 0; attempt < 3 && !hits.length; attempt++) {
                const term = seedPool[Math.floor(Math.random() * seedPool.length)];
                const offset = Math.floor(Math.random() * 12);
                const batch = await searchNeteaseSong(term, { limit: 14, offset });
                const clean = batch.filter((h) => !h.junk && !shouldDropForCasualPlay(h));
                hits = clean.length >= 2 ? clean : batch;
              }
            } else if (isVagueMusicQuery(q)) {
              // 类型词：扩写成具体曲目池再搜
              const expanded = pickGenreQueries(q);
              if (!expanded.length) {
                return err(`「${q}」太笼统。可填「随机」，或给具体歌名/歌手，或先 search_music。`);
              }
              const term = expanded[Math.floor(Math.random() * expanded.length)];
              searchQ = term;
              hits = await searchNeteaseSong(term, { limit: 12, offset: Math.floor(Math.random() * 6) });
              const clean = hits.filter((h) => !h.junk && !shouldDropForCasualPlay(h));
              if (clean.length) hits = clean;
            } else {
              hits = await searchNeteaseSong(q, { limit: 10, offset: 0 });
            }

            if (!hits.length) return err(`网易云没搜到「${searchQ}」。换更具体歌名/歌手，或给 musicUrl。`);

            const best = pickSongFromHits(hits, { random: randomMode || isVagueMusicQuery(q) });
            if (!best) return err('没挑到可用歌曲，换关键词再试。');

            // 具体歌名但相关度太低：列候选让模型改口
            if (!randomMode && !isVagueMusicQuery(q) && best.score < 1 && hits.length > 1) {
              const list = hits.slice(0, 5).map((h, i) => `${i + 1}. ${h.name} - ${h.artist} (id=${h.id})`).join('\n');
              return err(`没搜准「${q}」。候选：\n${list}\n请改成「歌名 歌手」再 send_music，或用 songId 选一首。`);
            }

            songId = best.id;
            if (!title) title = best.name;
            if (!artist) artist = best.artist;
          }
          if (!/^\d{1,16}$/.test(songId)) return err(`歌曲 id 不合法：${songId}`);
          // 只有 songId 时也补全标题/歌手，避免签名失败后空白卡
          if (!title || !artist) {
            try {
              const detail = await fetchNeteaseSongDetail(songId);
              if (detail) {
                if (!title) title = detail.name;
                if (!artist) artist = detail.artist;
              }
            } catch { /* 详情失败不挡发送 */ }
          }
          // 引用会吞掉音乐卡：若模型还传了 replyToMessageId，先单独发一条带引用的文字，再发无引用卡
          if (args.replyToMessageId != null && String(args.replyToMessageId).trim() && String(args.replyToMessageId).trim() !== 'null') {
            try {
              await ctx.sender.sendTextBatch(ctx.chatKey, [`🎵 ${title || songId}${artist ? ' - ' + artist : ''}`], {
                replyToMessageId: args.replyToMessageId
              });
            } catch { /* 引用文字失败不挡发卡 */ }
          }
          const result = await ctx.sender.sendMusic(ctx.chatKey, {
            platform: '163',
            songId,
            title: title || `歌曲 ${songId}`,
            artist,
            url: `https://music.163.com/#/song?id=${songId}`,
            audio: `https://music.163.com/song/media/outer/url?id=${songId}.mp3`
          });
          ctx.session.sent.push({
            type: 'music',
            text: `[音乐:${title || songId}]`,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          ctx.emit('session-update', ctx.session.id);
          rememberMusicPlayed(songId);
          return ok({ sent: true, messageId: result?.message_id ?? null, songId, title, artist, note: `音乐卡片已发送。${replyNote(result?.reply)}` });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'search_music',
      description: '搜网易云候选（不发送）。类型词（古典/摇滚/OST）会自动扩写成具体曲目；「随机」返回一组不同候选。拿到 id 后 send_music(songId=…)。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '歌名/歌手，或类型词，或「随机」' },
          limit: { type: 'integer', description: '默认 6' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const q = String(args.query ?? '').trim();
          if (!q) return err('query 不能为空');
          const lim = Math.min(12, Math.max(3, Number(args.limit) || 6));
          let searchQ = q;
          let hits = [];
          if (isRandomMusicQuery(q)) {
            const seedPool = ['周杰伦 晴天', 'Beyond 海阔天空', '陈奕迅 富士山下', '五月天 温柔', '林俊杰 修炼爱情'];
            searchQ = seedPool[Math.floor(Math.random() * seedPool.length)];
            hits = await searchNeteaseSong(searchQ, { limit: lim + 4, offset: Math.floor(Math.random() * 30) });
          } else if (isVagueMusicQuery(q)) {
            const expanded = pickGenreQueries(q);
            if (!expanded.length) {
              return { content: `「${q}」太笼统。可改「随机」，或给「歌名 歌手」。示例候选见 send_music 直接传类型词。` };
            }
            searchQ = expanded.join(' / ');
            const merged = [];
            for (const term of expanded.slice(0, 2)) {
              try {
                merged.push(...await searchNeteaseSong(term, { limit: 5, offset: Math.floor(Math.random() * 8) }));
              } catch { /* skip */ }
            }
            const seen = new Set();
            hits = merged.filter((h) => {
              if (seen.has(h.id)) return false;
              seen.add(h.id);
              return true;
            }).sort((a, b) => b.score - a.score).slice(0, lim + 4);
          } else {
            hits = await searchNeteaseSong(q, { limit: lim + 2, offset: 0 });
          }
          if (!hits.length) return { content: `网易云无结果：${q}。换更具体歌名/歌手。` };
          const lines = hits.slice(0, lim).map((h, i) =>
            `${i + 1}. ${h.name}${h.artist ? ' - ' + h.artist : ''}${h.album ? `（${h.album}）` : ''} · id=${h.id}`
          );
          return ok({
            query: q,
            searched: searchQ,
            hint: '挑一首最贴的，用 send_music(songId=其id) 发卡。也可直接 send_music(query="随机") 自动避重挑一首。',
            results: lines
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'list_stickers',
      description: '查看/搜索你的 QQ 收藏表情（含备注和你的本地笔记）。返回的 id 就是要填给 send_sticker / get_sticker_image 的 stickerId（照抄，别改别编）。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选搜索词，匹配备注/笔记/标签' },
          limit: { type: 'integer', description: '最多返回条数，默认 24' }
        }
      },
      async execute(ctx, args) {
        try {
          const result = await ctx.stickers.list(String(args.query ?? ''), Math.min(100, Math.max(1, Number(args.limit) || 24)));
          return ok(result);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_sticker_image',
      description: '查看一个没有备注/不确定含义的表情的图片（视觉模型可直接"看懂"）。',
      parameters: {
        type: 'object',
        properties: { stickerId: { type: 'string', description: '表情 id' } },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const sticker = await ctx.stickers.find(args.stickerId);
          if (!sticker) return err(`找不到表情「${args.stickerId}」。${stickerIdHint(ctx)}`);
          if (!sticker.url) return err('该表情没有图片地址');
          // 与 send_sticker 同一套取图逻辑：链接失效自动换新地址，确保看到的是真图
          let buffer;
          try {
            buffer = await ctx.stickers.resolveStickerBytes(sticker);
          } catch (error) {
            return err(String(error?.message ?? error));
          }
          const rawMime = detectMime(buffer) || 'image/jpeg';
          const prepared = await toVisionDataUrls(buffer, { mime: rawMime, maxFrames: 6 });
          if (prepared.skipped || !prepared.dataUrls.length) {
            return ok(`表情 ${sticker.id} 是 ${rawMime}，${prepared.note || '当前视觉接口看不了内容'}（QQ 里能正常显示）。本地备注：${sticker.desc || sticker.localNote || '无'}。`);
          }
          const frameNote = prepared.note ? `${prepared.note} ` : '';
          return { content: imageParts(`表情 ${sticker.id}（备注：${sticker.desc || '无'}）。${frameNote}这是群友发的表情——也就是他此刻的情绪或梗。顺着气氛接一句，或回一张贴切的；别点评画风。`, prepared.dataUrls) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'sticker_note',
      description: '给一个表情记下你的理解（含义/用法/标签），下次能更准地选用。',
      parameters: {
        type: 'object',
        properties: {
          stickerId: { type: 'string' },
          note: { type: 'string', description: '你的理解/含义' },
          tags: { type: 'array', items: { type: 'string' }, description: '标签列表（可选）' },
          usage: { type: 'string', description: '适用场景（可选）' }
        },
        required: ['stickerId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.stickers.note(String(args.stickerId), { note: args.note, tags: args.tags, usage: args.usage });
          if (!entry) return err(`找不到表情 ${args.stickerId}`);
          return ok({ updated: true, id: entry.id, localNote: entry.localNote, tags: entry.tags });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'collect_sticker',
      description: '收藏别人刚发的表情/图片到你的表情库（偶尔用，收藏前先 get_message_images 看图确认）。需要备注一句简短说明。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '那条消息的 QQ 消息 id（聊天记录里的 #数字）' },
          note: { type: 'string', description: '一句简短备注（帮未来的你识别）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`在当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const imageMedia = (entry.media || []).find((m) => m.kind === 'image' && m.url);
          if (!imageMedia) return err('该消息没有可收藏的图片');
          const saved = ctx.stickers.collect(args.messageId, { url: imageMedia.url, note: String(args.note ?? '') });
          return ok({ collected: true, id: saved.id, note: saved.localNote });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_forward',
      description: '把聊天记录打成合并转发发出。默认发当前会话。用户说群名时 targetChatKey 填群名（如「大胖鲸」），不要编造群号；只有数字群号可直接填。最多 20 条。',
      parameters: {
        type: 'object',
        properties: {
          nodes: {
            type: 'array',
            description: '节点列表；与 fromArchive 二选一',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string' },
                uin: { type: ['string', 'integer'] },
                content: { type: 'string' }
              },
              required: ['content']
            }
          },
          fromArchive: { type: 'boolean', description: 'true=从存档打包' },
          sourceChatKey: { type: 'string', description: '从哪个会话取存档，默认当前；发到别的群时可填源群' },
          query: { type: 'string', description: 'fromArchive 时可选过滤关键词' },
          limit: { type: 'integer', description: 'fromArchive 时取最近多少条，默认 10，最大 20' },
          targetChatKey: { type: 'string', description: '目标：群号、group:123，或用户说的群名（会模糊匹配群列表）。仅当用户明确要求发到某群时使用' },
          replyToMessageId: { type: ['integer', 'string'] }
        }
      },
      async execute(ctx, args) {
        try {
          if (!ctx.chatKey) return err('缺少当前会话');
          const cfg = getConfig();
          // 解析目标：默认当前；用户指定才跨会话
          let target = ctx.chatKey;
          const rawTarget = String(args.targetChatKey ?? '').trim();
          if (rawTarget) {
            try {
              target = await resolveForwardTarget(ctx, rawTarget) || target;
            } catch (error) {
              return err(String(error?.message ?? error));
            }
            // 白名单：空名单=全开；非空必须包含目标
            const allow = cfg.allow || {};
            const [kind, id] = target.split(':');
            const list = (kind === 'private' ? (allow.private || allow.privates || []) : (allow.groups || []));
            if (Array.isArray(list) && list.length && !list.map(String).includes(String(id))) {
              // 带上白名单里的真实群，方便模型/人改口
              const names = await (async () => {
                try {
                  const gs = await ctx.onebot.getGroupList();
                  return list.map((gid) => {
                    const g = gs.find((x) => x.id === String(gid));
                    return g ? `${g.name}(${g.id})` : String(gid);
                  }).join('、');
                } catch {
                  return list.join('、');
                }
              })();
              return err(`目标 ${target} 不在白名单里，不能转发过去。白名单有：${names}`);
            }
          }
          const [tKind, tId] = target.split(':');
          if (tKind !== 'group' && tKind !== 'private') return err('目标会话非法');

          const sourceKey = String(args.sourceChatKey || '').trim() || ctx.chatKey;
          let list = [];
          if (args.fromArchive === true) {
            const lim = Math.min(20, Math.max(1, Number(args.limit) || 10));
            const q = String(args.query || '').trim().toLowerCase();
            const recent = ctx.store.recent(sourceKey, { limit: Math.min(200, lim * 8) }) || [];
            list = recent
              .filter((m) => {
                const t = String(m.text || '').trim();
                if (!t || /^\[合并转发聊天记录\]$/.test(t)) return false;
                if (!q) return true;
                return t.toLowerCase().includes(q);
              })
              .slice(-lim)
              .map((m) => ({
                name: m.self ? (ctx.botName || '我') : (m.senderName || String(m.senderId || '群友')),
                uin: m.self ? (ctx.selfId || '0') : String(m.senderId || '0'),
                content: String(m.text || '').slice(0, 500)
              }));
          } else if (Array.isArray(args.nodes)) {
            list = args.nodes.slice(0, 20).map((n) => ({
              name: String(n?.name || '消息').slice(0, 20),
              uin: String(n?.uin || ctx.selfId || '0'),
              content: String(n?.content ?? '').slice(0, 500)
            }));
          }
          list = list.filter((n) => n.content && n.content.trim());
          if (!list.length) return err('没有可转发的内容');
          if (list.length > 20) list = list.slice(-20);

          const result = await ctx.sender.sendForward(target, list, {
            replyToMessageId: target === ctx.chatKey ? (args.replyToMessageId ?? null) : null
          });
          // 若发到别的会话，也在那边留一条 self 记录（sender 已 appendSelf 到 target）
          if (target === ctx.chatKey) {
            ctx.session.sent.push({
              type: 'forward',
              text: `[合并转发 共${result.count}条]`,
              at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
            });
          }
          ctx.emit('session-update', ctx.session.id);
          ctx.emit('chat-update', target);
          return ok({
            sent: true,
            target,
            messageId: result.messageId,
            count: result.count,
            note: target === ctx.chatKey ? '已发合并转发到当前会话' : `已转发到 ${target}（用户指定）`
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_poke',
      description: '拍一拍（群聊传 targetUserId；私聊默认拍对方）。targetUserId 必须是数字 QQ 号：不知道对方 QQ 号时，先调 get_active_members 或 get_recent_messages 查到再拍，绝对不要传名字、昵称或"未知"。适合用"戳一下"代替一句废话、回应别人的拍一拍，或偶尔逗一下正在聊的人。别频繁。',
      parameters: {
        type: 'object',
        properties: { targetUserId: { type: ['integer', 'string'], description: '要拍的群友 QQ 号（数字，群聊必填；不知道就先查 get_active_members）' } }
      },
      async execute(ctx, args) {
        try {
          if (isHypeMode() && isHypeProtectedTarget(args.targetUserId)) {
            return err(`亢奋模式硬锁：不能拍 ${getHypeProtectedQQ()}。换个人，或直接结束。`);
          }
          if (ctx.kind === 'group' && (args.targetUserId === undefined || args.targetUserId === null || String(args.targetUserId).trim() === '')) {
            return err(`群聊拍一拍必须传 targetUserId（数字 QQ 号）。${memberHint(ctx)}`);
          }
          let target = args.targetUserId;
          if (target !== undefined && target !== null && String(target).trim() !== '') {
            target = Number(target);
            if (!Number.isInteger(target) || target <= 0) {
              return err(`targetUserId 必须是正整数的 QQ 号（收到：${JSON.stringify(args.targetUserId)}）。${memberHint(ctx)}`);
            }
            await ctx.sender.poke(ctx.chatKey, target);
          } else {
            await ctx.sender.poke(ctx.chatKey, null);
          }
          return ok({ poked: true });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'get_recent_messages',
      description: '往前翻当前会话的更多历史消息（提示词里只带了最近一段；需要更早的上下文时用）。返回带 messageId（就是聊天记录里的 #数字），可用于引用或看图。消息文本出现 [合并转发聊天记录] 时，用 read_forward 展开看内容。',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '最多返回条数，默认 30，最大 100' },
          offset: { type: 'integer', description: '跳过最近 N 条，用于翻更早的消息' }
        }
      },
      async execute(ctx, args) {
        const limit = Math.min(100, Math.max(1, Number(args.limit) || 30));
        const offset = Math.max(0, Number(args.offset) || 0);
        const messages = ctx.store.recent(ctx.chatKey, { limit, offset: offset + (ctx.session.pastStateCount || 0) });
        // 自己发言同样洗掉「把图认成自己」的旧腔，避免翻旧账时又被带回去
        const sanitize = getConfig().store?.sanitizeSelfStyle !== false;
        return ok({
          count: messages.length,
          messages: messages.map((m) => {
            let text = m.text;
            if (sanitize && m.self && typeof text === 'string') {
              text = sanitizeSelfImageClaim(text);
            }
            return {
              messageId: msgRef(m) || undefined,
              time: new Date(m.ts).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
              sender: m.self ? '我' : m.senderName,
              // @ 也渲染成人话（@你 / @别人）：翻历史时不该再看到 [CQ:at,qq=…] 裸标记
              text: humanizeAt(text, ctx?.onebot?.selfId)
            };
          })
        });
      }
    },
    {
      name: 'read_forward',
      description: '展开合并转发聊天记录。文本是 [合并转发聊天记录] 占位时用；已是 [合并转发 共N条] 则直接读存档。展开会写回存档，也会进长期记忆索引。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '转发消息自己的 QQ 消息 id（聊天记录里的 #数字，可能为负数）' }
        },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          // 存档里已是展开文本（收消息时已展开/之前展开过）→ 直接给，不再请求 QQ
          if (String(entry.text || '').startsWith('[合并转发 共')) {
            return ok({
              messageId: msgRef(entry),
              text: entry.text,
              note: '已展开（存档）。内容也会在巩固后进入 memory_search。'
            });
          }
          const fetched = await fetchForwardNodes(ctx.onebot, { messageId: entry.mid });
          const ex = await expandForwardNodes(fetched.nodes);
          if (!ex || !ex.text) return err('转发内容为空或已被 QQ 服务端丢弃（发送时间太久）');
          // 写回存档：一次展开，永久升级这条记录（模型/存档页/金句墙都受益）
          ctx.store.updateByMid(ctx.chatKey, entry.mid, { text: ex.text, appendMedia: ex.media || [] });
          return ok({ messageId: msgRef(entry), text: ex.text, images: (ex.media || []).length });
        } catch (error) {
          return err(`展开失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'get_active_members',
      description: '查看当前会话最近活跃的成员（QQ 号、名字、最近发言时间、发言数），用于 @ 或拍一拍时找人。',
      parameters: {
        type: 'object',
        properties: { limit: { type: 'integer', description: '默认 10，最大 20' } }
      },
      async execute(ctx, args) {
        const members = ctx.store.activeMembers(ctx.chatKey, Math.min(20, Math.max(1, Number(args.limit) || 10)));
        return ok({
          members: members.map((m) => ({
            userId: m.userId,
            name: m.name,
            lastSeen: new Date(m.lastTs).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }),
            recentCount: m.count
          }))
        });
      }
    },
    {
      name: 'get_message_detail',
      description: '按 QQ 消息 id 查看单条消息详情（完整文本、发送者、时间）。id 用聊天记录里每条消息前的 #数字，不要自己编。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: '消息编号（聊天记录里每条前面的 #短编号，如 #318）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
        if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
        return ok({
          messageId: msgRef(entry),
          time: new Date(entry.ts).toLocaleString('zh-CN', { hour12: false }),
          sender: entry.self ? '我' : entry.senderName,
          senderId: entry.senderId,
          text: humanizeAt(entry.text, ctx?.onebot?.selfId),
          reply: entry.reply
        });
      }
    },
    {
      name: 'get_message_images',
      description: '查看某条消息里的图片/表情（视觉模型可以直接看懂）。消息文本出现 [图片] 时可用。id 用聊天记录里每条消息前的 #数字。',
      parameters: {
        type: 'object',
        properties: { messageId: { type: ['integer', 'string'], description: 'QQ 消息 id（聊天记录里的 #数字，可能为负数）' } },
        required: ['messageId']
      },
      async execute(ctx, args) {
        try {
          const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
          if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
          const urls = (entry.media || []).filter((m) => m.kind === 'image' && m.url).map((m) => m.url);
          if (!urls.length) return ok(`消息 ${args.messageId} 没有可查看的图片`);
          const dataUrls = [];
          const failed = [];
          let skipped = 0;
          const notes = [];
          for (const url of urls) {
            try {
              const prepared = await downloadImageForVision(url);
              if (prepared.skipped || !prepared.dataUrls.length) {
                skipped += 1;
                if (prepared.note) notes.push(prepared.note);
                continue;
              }
              dataUrls.push(...prepared.dataUrls);
              if (prepared.note) notes.push(prepared.note);
            } catch (e) { failed.push(String(e?.message ?? e)); }
          }
          if (!dataUrls.length) {
            if (skipped) return ok(`消息 ${args.messageId} 的 ${skipped} 张图当前接口看不了（${notes.join('；') || '格式不支持'}），跳过。`);
            return err(`图片获取失败：${failed.join('；')}`);
          }
          const noteBits = [
            failed.length ? `（另有 ${failed.length} 张获取失败）` : '',
            skipped ? `（另有 ${skipped} 张已跳过）` : '',
            notes.join(' ')
          ].filter(Boolean).join(' ');
          return { content: imageParts(`消息 ${args.messageId} 的图片：${noteBits}这些是群友发的图，多半在表达他此刻的情绪或玩梗。按画面自然接话就行；要发你自己的形象图时再走 image_lib（category=self）。`, dataUrls) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_append',
      description: '记对某人（全局按 **QQ 号**，跨群共用）的长期印象。只记身份/风格/雷点/喜好等，≤80字。**userId（对方 QQ 号）必填**——聊天行「名字(QQ数字)」里的数字；只写名字会认不出人。target 仅作备注昵称。type：identity/preference/edge/style/event/attitude（attitude=你该用什么态度对他，如「宠着少怼」）。一个人的印象**可以有很多条**（不同方面各记一条，别硬凑成一条），条数不设上限，放心记；只避免和已有条目重复。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'], description: '固定填 memberImpression' },
          userId: { type: ['integer', 'string'], description: '**必填**：对方 QQ 号（聊天行 名字(QQ数字) 里的数字）。不要只传名字' },
          target: { type: 'string', description: '可选：备注昵称（有 userId 可省）' },
          content: { type: 'string', description: '印象内容，必填，≤80字。例如：推歌要古典/摇滚/OST' },
          type: { type: 'string', enum: ['identity', 'preference', 'edge', 'style', 'event', 'attitude'], description: '可选；不传自动猜。attitude=对他该用的态度' }
        },
        required: ['category', 'userId', 'content']
      },
      async execute(ctx, args) {
        try {
        // 兼容小模型把参数写成字符串 / 多余空格 / 负号 QQ 号（Snowflake 有时是 int32 负值）
        const norm = (v) => String(args?.[v] ?? '').trim().replace(/^["']|["']$/g, '');
        let userId = norm('userId');
        const target = norm('target');
        let content = norm('content');
        // content 偶尔会带引号或换行包装
        content = content.replace(/^["'“”]|["'“”]$/g, '').trim();
        if (!content) {
          return err('content 不能为空。示例：{"category":"memberImpression","userId":123456789,"content":"推歌要古典/摇滚"}');
        }
        // 负号 QQ 号转正（-123456789 → 123456789）
        if (/^-?\d{5,15}$/.test(userId)) {
          userId = String(Math.abs(Number(userId)));
        }
        if (userId && !/^\d{5,15}$/.test(userId)) {
          userId = '';
        }
        // 无 QQ 号时：若 target 像裸数字，当 QQ 用；否则拒绝——避免只按可改昵称存档导致认不出
        if (!userId && /^\d{5,15}$/.test(target)) {
          userId = target;
        }
        if (!userId) {
          return err('缺 userId（对方 QQ 号）。从聊天行「名字(QQ数字)」里抄数字填 userId；只有名字以后会对不上人。示例：{"category":"memberImpression","userId":123456789,"content":"…"}');
        }
        const entry = ctx.memory.append(ctx.chatKey, 'memberImpression', content, {
          userId,
          target: target && target !== userId ? target : userId,
          type: norm('type')
        });
        if (!entry) {
          return err('没写入：内容为空或认不出人。检查 userId（QQ 号）和 content 再试。');
        }
        if (entry.rejected === 'just-deleted') {
          return err(`没写入：这条「${String(entry.content || '').slice(0, 30)}」刚被手动删掉（10 分钟内不写回，避免删了又冒出来）。**换一条别的**内容照样可以记；确实要恢复这条，请管理员在记忆页手动加。`);
        }
        return ok({ saved: true, byName: false, entry });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_favor',
      description: '查看或微调对某人的好感度（0~100，50中性）。被夸/被帮可 +；被怼/被烦可 −。单次最多 ±10。不传 delta 只查。必须填 userId。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: ['integer', 'string'], description: '对方 QQ 号' },
          delta: { type: 'integer', description: '变化量 -10~10；不传=只查看' },
          reason: { type: 'string', description: '简短原因，≤30字，便于以后查' }
        },
        required: ['userId']
      },
      async execute(ctx, args) {
        try {
          let uid = String(args.userId ?? '').trim().replace(/^-/, '');
          if (/^-?\d{5,15}$/.test(String(args.userId ?? ''))) uid = String(Math.abs(Number(args.userId)));
          if (!/^\d{1,15}$/.test(uid)) return err('userId 必须是对方 QQ 号');
          const member = ctx.memory.getMember(ctx.chatKey, uid);
          const current = Number(member.favor ?? 50);
          if (args.delta === undefined || args.delta === null || args.delta === '') {
            return ok({ userId: uid, favor: current, viewed: true });
          }
          let d = Math.round(Number(args.delta));
          if (!Number.isFinite(d)) return err('delta 必须是数字（-10~10）');
          d = Math.max(-10, Math.min(10, d));
          const next = Math.max(0, Math.min(100, current + d));
          const r = ctx.memory.setFavor(uid, next, {
            source: 'favor_tool',
            reason: String(args.reason || '')
          });
          // 记本轮好感变化，收尾时喂给情绪系统（多调几次就累加）
          if (ctx.session) {
            ctx.session.favorDelta = (Number(ctx.session.favorDelta) || 0) + (Number(r.favor) - current);
          }
          const reason = String(args.reason || '').slice(0, 30);
          return ok({
            userId: uid,
            favor: r.favor,
            delta: d,
            from: current,
            reason
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_query',
      description: '查群友印象（按人不按群）。**想知道某人某方面的偏好/雷点/习惯时，传 query 按话题查**（例如 query="推歌"、query="口味"、query="作息"）——比把整库倒出来准。不传 userId 返回近期；传 userId 只看某人。',
      parameters: {
        type: 'object',
        properties: {
          userId: { type: ['integer', 'string'], description: '可选：只看这个 QQ 号的印象' },
          query: { type: 'string', description: '可选：话题词，只回沾边的条目（如「推歌」「外卖」「作息」）' }
        }
      },
      async execute(ctx, args) {
        const topic = String(args.query ?? '').trim();
        const userId = String(args.userId ?? '').trim();
        const mem = ctx.memory.query(ctx.chatKey, '', topic, { userId });
        let list = mem.memberImpression;
        // 按话题查时把库里倒出来的东西压到 12 条内，别一次灌几百字
        if (topic) list = list.slice(0, 12);
        if (topic && !list.length) {
          return ok({ memberImpression: [], note: `印象库里没有跟「${topic}」沾边的条目（不等于此人没这习惯，只是没记过）。可以再 memory_search 翻聊天，或直接问对方。` });
        }
        return ok({ memberImpression: list });
      }
    },
    {
      name: 'memory_remove',
      description: '删除过时/错误的群友印象（全局按人）。优先传 userId+content 删一条；不传 content 删该人全部。发现记错时立刻删，别留着误导自己。',
      parameters: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['memberImpression'] },
          userId: { type: ['integer', 'string'], description: '对方 QQ 号（优先）' },
          target: { type: 'string', description: '对方名字（没有 QQ 号时用）' },
          content: { type: 'string', description: '可选：只删这条内容' }
        },
        required: ['category']
      },
      async execute(ctx, args) {
        const removed = ctx.memory.remove(ctx.chatKey, 'memberImpression', {
          userId: String(args.userId ?? '').trim(),
          target: String(args.target ?? '').trim(),
          content: String(args.content ?? '').trim()
        });
        return ok({ removed });
      }
    },
    {
      name: 'memory_meme_save',
      description: '存一条梗/口头禅/内部笑话/可复用结论到本地知识库（≤60字）。群里形成的新梗、反复玩笑、值得以后复用的结论才存；普通闲聊别存。约30天没再触发会自动清掉。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '梗/结论原文，≤60字' },
          tags: { type: 'array', items: { type: 'string' }, description: '可选标签' },
          note: { type: 'string', description: '可选：怎么用/出处' }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        try {
          // 入库前让 Jev 看一眼：一次性闲聊存进去只会污染检索（以后对着无关话题闪这条梗）。
          // 弃权 / 没开角色 / 超时 = 照存，保持原行为；只有明确 NO 才拒。
          if (localJevHasRole('memeSaveGate')) {
            const g = await jevGate('memeSaveGate', String(args.text || '').slice(0, 80), { timeoutMs: 1800 });
            if (!g.abstain && !g.error && !g.on) {
              return ok({ saved: false, rejected: true, reason: '本地判定：这条不像以后还能复用的群内梗，没存。确实是梗的话换个更完整的说法再存。' });
            }
          }
          const r = saveMeme({
            text: args.text,
            tags: args.tags,
            note: args.note,
            source: 'model'
          });
          if (!r.ok) return err(r.error || '保存失败');
          return ok({ saved: true, deduped: !!r.deduped, meme: r.meme });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_meme_search',
      description: '在梗库里搜梗（按需，平常别调）。聊到可能相关的梗、别人玩老梗时用。有 memes 才用，没有就说没有。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词或梗片段' },
          limit: { type: 'integer', description: '默认 4' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const hits = searchMeme(String(args.query ?? ''), { limit: Math.min(8, Math.max(1, Number(args.limit) || 4)) });
          if (!hits.length) return { content: `梗库无命中（共${memeCount()}条）。可以说不知道，或用 memory_meme_save 新梗。` };
          return ok({ memes: hits, total: memeCount() });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'external_lookup',
      description: '查外部百科/设定（萌娘、维基等管理员配置的 wiki 源）。角色/作品/出处不确定时用。实时新闻/新梗仍用 web_search。别把百科原文当群梗存进内部库。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '页面名或关键词，如「博丽灵梦」「东方Project」' },
          source: { type: 'string', description: '可选：moegirl / wikipedia / all / 自定义 id' },
          limit: { type: 'integer', description: '默认 2' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const q = String(args.query ?? '').trim();
          const r = await wikiLookup(q, {
            limit: Math.min(5, Math.max(1, Number(args.limit) || 2)),
            source: String(args.source ?? '').trim()
          });
          if (r.ok && r.results.length) {
            return ok({ label: r.label, query: r.query, results: r.results });
          }
          // 百科源没有这个条目（或源没配）：退回联网搜索，至少给答案 + 链接
          try {
            const ws = await webSearch(`${q} wiki 设定`, { limit: 5 });
            const results = (ws?.results || []).slice(0, 5).map((x) => ({
              title: x.title,
              url: x.url,
              snippet: String(x.snippet || x.content || '').slice(0, 300)
            }));
            if (results.length) {
              return ok({
                query: q,
                label: `联网搜索（百科源无命中：${r.error || '没这个条目'}）`,
                results,
                note: '这些是网页搜索结果，不是百科原文；引用时说清来源链接。'
              });
            }
          } catch { /* 搜索也失败就按无命中 */ }
          return { content: `外部库无命中：${q}。可说不知道，或换关键词。` };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'image_lib_search',
      description: '搜本地图库（和表情包库分开）。category=self 是自己的形象/人设图；也可按标签/备注搜。命中后用 image_lib_send 或 send_image 发。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词：形象/自拍/梗图名等' },
          category: { type: 'string', enum: ['self', 'meme', 'art', 'other'], description: '可选分类过滤' },
          limit: { type: 'integer', description: '默认 6' }
        },
        required: []
      },
      async execute(ctx, args) {
        try {
          const hits = searchImageLib(String(args.query ?? ''), {
            category: String(args.category ?? ''),
            limit: Math.min(20, Math.max(1, Number(args.limit) || 6))
          });
          if (!hits.length) {
            return { content: `图库无命中（共${imageLibCount()}张）。可换词，或用 search_images 搜网图。` };
          }
          return ok({ images: hits, total: imageLibCount() });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'image_lib_send',
      description: '把图库里的图发到当前会话。传 imageId（来自 image_lib_search）。要「发我的图/形象照」先 image_lib_search(category=self) 再 send。',
      parameters: {
        type: 'object',
        properties: {
          imageId: { type: 'string', description: '图库 id' },
          replyToMessageId: { type: ['integer', 'string'] }
        },
        required: ['imageId']
      },
      async execute(ctx, args) {
        try {
          const entry = getImageLibEntry(String(args.imageId ?? ''));
          if (!entry) return err(`图库没有这张图：${args.imageId}。先用 image_lib_search。`);
          const pathOrUrl = resolveImagePath(entry);
          let source = '';
          if (/^https?:\/\//i.test(pathOrUrl)) {
            // 网图：下成 base64 再发（和 send_image 一致）
            const { buffer } = await safeFetchBinary(pathOrUrl, 8 * 1024 * 1024, { browseLocked: true });
            const mime = detectMime(buffer) || 'image/jpeg';
            source = `base64://${buffer.toString('base64')}`;
            void mime;
          } else {
            // 本地文件直接给 OneBot 路径
            source = pathOrUrl;
          }
          const result = await ctx.sender.sendImage(ctx.chatKey, {
            dataUrl: source,
            note: entry.note || entry.category
          }, {
            replyToMessageId: args.replyToMessageId ?? null
          });
          markImageUsed(entry.id);
          ctx.session.sent.push({
            type: 'image',
            text: `[图库:${entry.note || entry.category}]`,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          ctx.emit('session-update', ctx.session.id);
          return ok({ sent: true, messageId: result?.message_id ?? null, note: `图库图片已发送。${replyNote(result?.reply)}` });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_todo_save',
      description: '存一条未完待办（proposed），expireInMinutes 由你定。发送动作拿到平台回执前不算完成。只记「接下来要办的事」，别存闲聊。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '待办，≤80字' },
          expireInMinutes: { type: 'integer', description: '多久后忘掉，默认 120' },
          userId: { type: ['integer', 'string'], description: '绑定谁的 QQ 号；对方下次出现时才会提醒' },
          note: { type: 'string', description: '可选备注' }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        try {
          let uid = String(args.userId ?? '').trim();
          if (/^-?\d{5,15}$/.test(uid)) uid = String(Math.abs(Number(uid)));
          // 没填时：若本轮只有一个人在说话，自动绑上
          if (!uid && Array.isArray(ctx.triggerUserIds) && ctx.triggerUserIds.length === 1) {
            uid = String(ctx.triggerUserIds[0]);
          }
          const r = saveTodo({
            chatKey: ctx.chatKey,
            text: args.text,
            expireInMinutes: args.expireInMinutes,
            userId: uid,
            note: args.note
          });
          if (!r.ok) return err(r.error || '保存失败');
          const ledgerTask = taskStore().create({
            text: args.text,
            chatKey: ctx.chatKey,
            userId: uid,
            expiresAt: r.todo.expiresAt,
            source: { type: 'model_plan', runId: ctx.runContext?.runId || '' },
            status: TASK_STATUS.PROPOSED,
            note: args.note
          });
          return ok({ saved: true, taskId: ledgerTask.task?.id || null, expiresAt: r.todo.expiresAt, inMinutes: r.todo.expireInMinutes });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'memory_todo_done',
      description: '结束一条待办。只有 confirmed=true 且有实际结果证据才标 completed；否则标 result_unknown。按 text 关键句匹配。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '待办原文或其中一段' },
          confirmed: { type: 'boolean', description: '是否有实际结果证据' },
          detail: { type: 'string', description: '结果证据说明' }
        },
        required: ['text']
      },
      async execute(ctx, args) {
        const done = completeTodo({ chatKey: ctx.chatKey, text: String(args.text ?? '') });
        const task = taskStore().find(args.text, { chatKey: ctx.chatKey });
        if (!task) return ok({ done, task: null });
        const r = args.confirmed === true
          ? taskStore().complete(task.id, { confirmed: true, detail: args.detail })
          : taskStore().resolveUnknown(task.id, args.detail || '没有实际结果证据');
        return ok({ done, task: r.task || task, taskStatus: r.task?.status || task.status });
      }
    },
    {
      name: 'report_feedback',
      description: '向管理员（控制台）反馈你遇到的问题、困惑或需要人工介入的情况。不要用于聊天。',
      parameters: {
        type: 'object',
        properties: {
          level: { type: 'string', enum: ['info', 'warning', 'error'] },
          message: { type: 'string' }
        },
        required: ['message']
      },
      async execute(ctx, args) {
        const level = ['info', 'warning', 'error'].includes(args.level) ? args.level : 'info';
        ctx.session.feedbacks.push({ level, message: String(args.message ?? '').slice(0, 500), at: Date.now() });
        ctx.emit('feedback', { sessionId: ctx.session.id, chatKey: ctx.chatKey, level, message: String(args.message ?? '') });
        return ok({ reported: true });
      }
    },
    {
      name: 'web_search',
      // ⚠️ 说明里**不能**再让它"用 web_fetch 读正文"：弱模型子集工具里可能没有 web_fetch，
      //    它照着说明去找一个不存在的工具，只能永远只看摘要。现在正文由搜索工具自己补读。
      description: `联网搜索（默认走聊天模型原生联网，已带简短结论）。适用：实时、新闻、梗、角色设定、不确定的事实。**通常搜 1 次就够**；不够再换 1 次词。别连搜三遍、别每条都 web_fetch。${hasTool('web_fetch') ? '（仅结果很空或要原文时才用 web_fetch。）' : ''}`,
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: '搜索词' } },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const query = String(args.query ?? '');
          if (!query.trim()) return err('query 不能为空');
          // 每次运行最多搜 3 次（2026-09-28）：真实档日志审计里「搜索循环」是
          // 工具 token 浪费 Top1（换词重搜 + 拖满 deadline）。第 4 次直接拒——
          // 模型拿不到新结果自然收口。写法同 search_images 的 imageSearchCount。
          const used = Number(ctx.session.webSearchRunCount) || 0;
          if (used >= 3) {
            return err(`这次处理已经搜过 ${used} 次了（上限 3）。请直接用已有搜索结果作答，不要换词再搜了。`);
          }
          ctx.session.webSearchRunCount = used + 1;
          const cfg = getConfig();
          const lock = browseLockState();
          const maxChars = Math.max(1000, Number(cfg.webSearch?.fetchMaxChars) || 4000);
          // ① 站内搜索：配了模板就直接抓站点自己的搜索页。
          //    比"全网搜完再把站外结果过滤掉"准得多，也省掉一整轮无用调用。
          const template = String(cfg.security?.browseLock?.searchUrl || '').trim();
          if (lock.enabled && template) {
            const searchUrl = buildSiteSearchUrl(template, query);
            const page = await webFetch(searchUrl);
            const digest = extractPageDigest(page.body, page.url, { maxChars });
            const empty = !digest.links.length && !digest.images.length;
            const hint = empty
              ? '站内搜索页没解析出结果（多半是 JS 动态渲染，HTML 里没有列表）。可以改抓这些常见入口：站点的 RSS（如 /feed、/search/关键词/feed/rss2/）、站点的 API（WordPress 站可试 /wp-json/wp/v2/posts?search=关键词），或直接给具体的文章页 URL。'
              : '';
            return ok({
              siteSearch: page.url,
              note: `已在锁定站点内搜索（${lock.domains.join('、')}）：links 是站内结果，images 是这页的图片直链（可直接喂给 send_image 发图）。${hint}`,
              links: digest.links,
              images: digest.images,
              content: digest.text
            });
          }
          // ② 没配模板但锁定了站点：给关键词自动加 site: 限定，避免搜出一堆站外结果再被滤光
          const siteLimited = lock.enabled && String(cfg.webSearch?.provider || 'bing') === 'bing';
          const effectiveQuery = siteLimited
            ? `${query} ${lock.domains.length > 1 ? `(${lock.domains.map((d) => `site:${d}`).join(' OR ')})` : `site:${lock.domains[0]}`}`
            : query;
          const result = await webSearch(effectiveQuery);
          if (!result.results.length) {
            return ok({ query, results: [], note: '没有搜到结果，试试换关键词或更具体的说法。' });
          }
          // ③ 兜底：无论走哪个搜索服务，站外结果一律滤掉（抓不了，留着只会让模型白试）
          if (!lock.enabled) return ok({ ...result, query });
          const kept = result.results.filter((r) => {
            try { return hostAllowed(new URL(String(r.url || '')).hostname, lock); } catch { return false; }
          });
          const dropped = result.results.length - kept.length;
          const note = dropped
            ? `已按浏览锁定（只允许 ${lock.domains.join('、')}）过滤掉 ${dropped} 条站外结果。`
            : undefined;
          return ok({ query, results: kept, ...(note ? { note } : {}) });
        } catch (error) {
          return err(`搜索失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'search_images',
      description: '搜网图，直接拿到"能发的图片直链"。用法：先 search_images("关键词") 看列表，再挑标题最贴切的一条用 send_image(url) 发出去（一张图一条气泡）。被要求"发张图 / 来点表情 / 发个自拍 / 给我看看"时就用它 —— 不要只说"我没有图"。不要默认总挑第 1 条。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '想搜的画面，用具体名词更好搜（例如"猫 表情包 gif""Q版 蓝发 女孩 插画""摸鱼 表情包"）。别塞整句寒暄。' },
          limit: { type: 'integer', description: '可选：最多返回几条（默认 8，上限 12）' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const query = String(args.query ?? '').trim();
          if (!query) return err('query 不能为空');
          // 一次运行最多搜 3 次：小模型爱换着词反复搜（实测一口气搜 5 次），既慢又容易被源限流
          const used = Number(ctx.session.imageSearchCount) || 0;
          if (used >= 3) {
            return err(`这次处理已经搜过 ${used} 次图了（上限 3）。请从上面的结果里挑一条发，或者换个思路，不要再搜了。`);
          }
          ctx.session.imageSearchCount = used + 1;
          const limit = Math.max(1, Math.min(12, Number(args.limit) || 8));
          // 本轮已看过的、已发过的图，下一次搜索直接剔除，避免来回同一张
          if (!Array.isArray(ctx.session.imageUrlsSeen)) ctx.session.imageUrlsSeen = [];
          const excludeUrls = [
            ...ctx.session.imageUrlsSeen,
            ...(Array.isArray(ctx.session.imagePreviewed) ? ctx.session.imagePreviewed : []),
            ...(ctx.session.sent || []).filter((s) => s?.type === 'image' && s.url).map((s) => s.url)
          ];
          const lock = browseLockState();
          const { images, provider, cleanedQuery } = await searchImages(query, {
            limit: lock.enabled ? 12 : limit,
            excludeUrls
          });
          // 开了浏览锁定就只保留锁定站点里的图（下不动就不要给模型）
          const kept = lock.enabled
            ? images.filter((im) => { try { return hostAllowed(new URL(im.url).hostname, lock); } catch { return false; } })
            : images;
          if (!kept.length) {
            return ok({
              query,
              images: [],
              note: lock.enabled
                ? '锁定站点内没搜到图（或都已发过），换关键词或者别发图。'
                : '没搜到新图（可能都发过/不相关）。换个更具体的名词，或改用 image_lib_search。'
            });
          }
          for (const im of kept) {
            if (!ctx.session.imageUrlsSeen.includes(im.url)) ctx.session.imageUrlsSeen.push(im.url);
          }
          return ok({
            query,
            cleanedQuery: cleanedQuery || query,
            provider,
            count: kept.length,
            images: kept.slice(0, limit).map((im) => ({
              index: im.index,
              url: im.url,
              title: im.title,
              source: im.source,
              score: im.score
            })),
            note: '按标题挑最贴切的一条，用 send_image(url) 发；url 整条照抄。别默认总选第 1 条。列表都不贴切就换个更具体的名词再搜一次（最多 3 次；本轮已自动避开发过的图）。'
          });
        } catch (error) {
          return err(`搜图失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'identify_image',
      description: '以图搜图认人/认角色：把图丢给反查（IQDB等）找出处和标题。认不出就说不确定，别硬编；搜到可以接话，不要对着图做长篇点评。',
      parameters: {
        type: 'object',
        properties: {
          messageId: { type: ['integer', 'string'], description: '聊天记录 #数字' },
          stickerId: { type: ['string'], description: '表情库 id' },
          url: { type: 'string', description: '图片直链（有则优先，省上传）' },
          webSearch: { type: 'boolean', description: '反查后再 web_search 核实标题（默认 true）' }
        }
      },
      async execute(ctx, args) {
        try {
          if (getConfig().api?.vision === false && !args.url) {
            // 仍可反查（不依赖本机视觉）
          }
          let dataUrl = '';
          let httpUrl = '';
          let source = '';
          if (args.url) {
            httpUrl = String(args.url);
            source = 'url';
          } else if (args.stickerId) {
            const sticker = await ctx.stickers.find(String(args.stickerId));
            if (!sticker) return err(`找不到表情 ${args.stickerId}。用 list_stickers 查有效 id。`);
            const u = sticker.url || '';
            if (String(u).startsWith('http')) {
              httpUrl = u;
              source = `sticker:${sticker.id}`;
            } else if (sticker.base64 || String(u).startsWith('data:')) {
              dataUrl = sticker.base64 || u;
              source = `sticker:${sticker.id}`;
            } else {
              return err('这个表情没有可用图片数据。');
            }
          } else if (args.messageId != null) {
            const entry = ctx.store.findByMid(ctx.chatKey, args.messageId);
            if (!entry) return err(`当前会话找不到消息 ${args.messageId}。${midHint(ctx)}`);
            const urls = (entry.media || []).filter((m) => m.kind === 'image' && m.url).map((m) => m.url);
            if (!urls.length) return err(`消息 ${args.messageId} 没有可识别的图片`);
            if (String(urls[0]).startsWith('http')) {
              httpUrl = urls[0];
              source = `message:${args.messageId}`;
            } else {
              dataUrl = await downloadImageAsDataUrl(urls[0]);
              source = `message:${args.messageId}`;
            }
          } else {
            return err('需要 messageId、stickerId 或 url 之一。');
          }

          // ── 1) 真·以图搜图（反查）──
          let reverse = null;
          let reverseErr = '';
          try {
            reverse = await reverseImageSearch({ dataUrl: dataUrl || undefined, url: httpUrl || undefined });
          } catch (e) {
            reverseErr = String(e?.message ?? e);
          }

          // ── 2) 视觉强识别：先认角色名（主路径）──
          let vision = '';
          try {
            if (!dataUrl && httpUrl) {
              try { dataUrl = await downloadImageAsDataUrl(httpUrl); } catch { /* 网图下不动就不视觉 */ }
            }
            if (dataUrl && getConfig().api?.vision !== false) {
              const raw = /^data:([^;]+);base64,(.+)$/i.exec(dataUrl);
              const mime = raw?.[1] || '';
              const prepared = raw
                ? await toVisionDataUrls(Buffer.from(raw[2], 'base64'), { mime })
                : { dataUrls: [], skipped: true };
              if (!prepared.skipped && prepared.dataUrls.length) {
                const frameNote = prepared.note ? `\n${prepared.note}` : '';
                const res = await chatCompletion({
                  messages: [{
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: `识别这张图里的角色。${frameNote}\n第一行：角色名（不确定就写最像的）。\n第二行：类型（插画/二创/AI/照片/梗图）。\n不要长篇分析，不要点评画风。`
                      },
                      ...prepared.dataUrls.map((u) => ({ type: 'image_url', image_url: { url: u } }))
                    ]
                  }],
                  temperature: 0.2,
                  overrides: { ...apiWith({ disableThinking: true }), timeoutMs: 60000 }
                });
                vision = String(res?.message?.content ?? '').trim().slice(0, 300);
              }
            }
          } catch { vision = ''; }

          // 从视觉结果抠角色名再 web_search 核实
          let webNote = '';
          const roleM = /角色名[:：]\s*(.+)/.exec(vision) || /像(.{2,12}(娘|少女|角色|IP|图))/.exec(vision);
          const roleName = roleM ? roleM[1].trim().split(/[\s，,。]/)[0].slice(0, 16) : '';
          const topTitles = (reverse?.matches || []).map((m) => m.title).filter(Boolean).slice(0, 2);
          const searchQ = topTitles[0] || roleName;
          if (args.webSearch !== false && searchQ) {
            try {
              const s = await webSearch(searchQ.slice(0, 40));
              const items = (s.results || s.items || []).slice(0, 2).map((r) => r.title || '').filter(Boolean);
              if (items.length) webNote = `【核实「${searchQ}」】${items.join(' / ')}`;
            } catch { /* ignore */ }
          }

          const matchLines = (reverse?.matches || []).slice(0, 5)
            .map((m, i) => `${i + 1}. ${m.title || '（无标题）'}${m.similarity ? ` 相似度${m.similarity}%` : ''}${m.url ? ` → ${String(m.url).slice(0, 80)}` : ''}`);

          const parts = [];
          parts.push(`来源 ${source}`);
          if (reverse?.publicUrl) parts.push(`反查用链接 ${reverse.publicUrl}${reverse.uploaded ? '（已上传临时图床）' : ''}`);
          if (matchLines.length) {
            parts.push('【以图搜图结果】');
            parts.push(matchLines.join('\n'));
            parts.push(`来源: ${(reverse.providers || []).map((p) => `${p.name}:${p.count}${p.error ? '(err)' : ''}`).join(', ')}`);
          } else {
            parts.push('【以图搜图】没有可靠出处。' + (reverseErr ? `（${reverseErr}）` : ''));
          }
          if (vision) {
            parts.push('【视觉识别】');
            parts.push(vision);
          }
          if (webNote) parts.push(webNote);
          parts.push('优先信【视觉识别】的角色名 + 搜图标题；不确定就说「像XX」，禁止说这是我。');

          return ok(parts.join('\n'));
        } catch (error) {
          return err(`识图失败：${error?.message ?? error}`);
        }
      }
    },
    {
      name: 'web_fetch',
      description: '只读抓取网页正文（默认 ≤4000 字符，设置里可调；正文是提纯后的纯文本，不带 HTML 标签；同一次处理里重复抓同一页只返回一次）。群友发来链接问"写了什么"时直接抓；配合 web_search 阅读搜索结果的详细内容。返回的 images 是这页的图片直链（可直接喂给 send_image 发图）；links 是这页里的页面链接（想深挖就继续抓）。禁止访问内网/本机地址；开了浏览锁定后只能抓锁定站点。',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const cfg = getConfig();
          const url = String(args.url ?? '').trim();
          const maxChars = Math.max(1000, Number(cfg.webSearch?.fetchMaxChars) || 4000);
          // 同一次处理里重复抓同一个页面：正文 token 很贵（中文 1 字符 ≈ 1 token），
          // 抓第二遍纯属白烧。但图片直链要照给 —— 模型常常是回来"再看一眼有哪些图"。
          if (!Array.isArray(ctx.session.fetchedPages)) ctx.session.fetchedPages = [];
          const seenKey = url.toLowerCase();
          const seen = ctx.session.fetchedPages.find((x) => x && x.url === seenKey);
          if (seen) {
            return ok({
              url,
              images: seen.images || [],
              note: '这个页面本次处理已经抓过了，正文见上一次 web_fetch 的结果（不重复返回，省 token）。'
            });
          }
          const result = await webFetch(url);
          const body = String(result.body || '');
          // 顺手把页面里的图片直链抽出来：模型想发图时不用自己啃 HTML（还常被相对路径绊住）。
          // 注意只能拿到写在 HTML 里的直链，JS 动态渲染/防盗链的图拿不到。
          const images = extractImageUrls(body, result.url, 10);
          // JSON 接口（站点的 API）也把里头的图片直链挑出来，方便直接发图
          if (!images.length) {
            const fromJson = (body.match(/https?:\/\/[^"'\\\s]+\.(?:jpe?g|png|gif|webp)(?:\?[^"'\\\s]*)?/gi) || [])
              .map((u) => u.replace(/\\\//g, '/'));
            for (const u of [...new Set(fromJson)].slice(0, 10)) images.push({ url: u, alt: '' });
          }
          ctx.session.fetchedPages.push({ url: seenKey, images });
          // 正文提纯（2026-09-28 · 工具结果 token 优化②）：改用 extractPageDigest（站内搜索同款），
          // 剥掉脚本/样式/标签只留纯正文 + 页面链接。原始 HTML 前 N 字符里一半是标签噪声，
          // 同字符数下信息量接近翻倍。提纯为空（JS 渲染页/纯脚本页）兜底退回旧行为：原始 HTML 截断。
          const digest = extractPageDigest(body, result.url, { maxChars, maxLinks: 12 });
          const content = digest.text || body.slice(0, maxChars);
          // 正文很空 = 多半是 JS 渲染的页面，直接给一句可执行的下一步，省掉几轮瞎试
          // （digest.text 是"去脚本去标签"的正文，长度同旧的 plainLen 口径，阈值不变）
          const emptyHint = (digest.text.length < 400 && !images.length)
            ? '这页 HTML 里几乎没有可读内容（可能靠 JS 渲染）。可以试站点的 RSS（/feed、/search/关键词/feed/rss2/）、站点的 API（WordPress 站可试 /wp-json/wp/v2/posts?search=关键词），或直接给具体的文章页 URL。'
            : '';
          return ok({
            url: result.url,
            statusCode: result.statusCode,
            truncated: result.truncated || body.length > maxChars,
            images,
            ...(emptyHint ? { hint: emptyHint } : {}),
            content,
            // links 放在 content 之后：结果超长被硬截断时先砍导航链接、保住正文
            ...(digest.links.length ? { links: digest.links } : {})
          });
        } catch (error) {
          return err(`抓取失败：${error?.message ?? error}`);
        }
      }
    },
    // 会话考古：仅当 api.conversationMemory.enabled !== false 时暴露
    ...(getConfig().api?.conversationMemory?.enabled === false ? [] : [{
      name: 'memory_evidence_add',
      description: '保存一条带来源的证据。只有用户明确陈述、人工录入或平台回执会自动确认；模型推断只进候选，不能当事实。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '证据内容' },
          subject: { type: 'string', description: '关于谁/什么' },
          evidenceType: { type: 'string', enum: ['inference', 'self_report', 'explicit_statement', 'platform_receipt', 'manual'] },
          confidence: { type: 'number', description: '0..1' },
          sourceMessageId: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } }
        },
        required: ['text', 'evidenceType']
      },
      async execute(ctx, args) {
        const scope = currentEvidenceScope(ctx);
        if (!scope) return err('当前运行没有绑定会话范围，拒绝写入证据');
        const r = evidenceStore().add({
          text: args.text,
          subject: args.subject,
          evidenceType: args.evidenceType,
          confidence: args.confidence,
          tags: Array.isArray(args.tags) ? args.tags : [],
          scope,
          source: {
            type: args.evidenceType,
            chatKey: ctx.chatKey,
            messageId: args.sourceMessageId,
            actor: String(ctx.triggerUserIds?.[0] || 'model'),
            runId: ctx.runContext?.runId || ''
          }
        });
        return r.ok ? ok(r.evidence) : err(r.error || '证据写入失败');
      }
    }, {
      name: 'memory_evidence_query',
      description: '查询当前会话的来源化证据。只能查当前会话；候选与已取代记录默认隐藏。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          subject: { type: 'string' },
          includeCandidates: { type: 'boolean' },
          includeSuperseded: { type: 'boolean' },
          limit: { type: 'integer' }
        }
      },
      async execute(ctx, args) {
        const scope = currentEvidenceScope(ctx);
        if (!scope) return err('当前运行没有绑定会话范围，拒绝查询');
        return ok(evidenceStore().evidencePack({
          scope,
          allowedScopes: [scope],
          text: args.text || '',
          subject: args.subject || '',
          includeCandidates: args.includeCandidates === true,
          includeSuperseded: args.includeSuperseded === true,
          limit: args.limit
        }));
      }
    }, {
      name: 'memory_evidence_correct',
      description: '以新版本纠正当前会话的一条证据；原记录会保留为 superseded。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          text: { type: 'string' },
          subject: { type: 'string' },
          evidenceType: { type: 'string', enum: ['inference', 'self_report', 'explicit_statement', 'platform_receipt', 'manual'] },
          confidence: { type: 'number' }
        },
        required: ['id', 'text']
      },
      async execute(ctx, args) {
        const scope = currentEvidenceScope(ctx);
        const ledger = evidenceStore();
        const old = scope ? ledger.get(args.id, [scope]) : null;
        if (!old) return err('证据不存在或不属于当前会话');
        const type = String(args.evidenceType || old.evidenceType || 'inference');
        const direct = ['self_report', 'explicit_statement', 'platform_receipt', 'manual'].includes(type);
        const r = ledger.correct(args.id, {
          text: args.text,
          subject: args.subject ?? old.subject,
          evidenceType: type,
          confidence: args.confidence ?? old.confidence,
          status: direct ? EVIDENCE_STATUS.CONFIRMED : EVIDENCE_STATUS.CANDIDATE,
          scope,
          source: { actor: String(ctx.triggerUserIds?.[0] || 'model'), runId: ctx.runContext?.runId || '' }
        });
        return r.ok ? ok(r.evidence) : err(r.error || '证据纠正失败');
      }
    }, {
      name: 'memory_evidence_remove',
      description: '删除当前会话的一条证据。删除后保留墓碑，同内容不能被自动写回。',
      parameters: {
        type: 'object',
        properties: { id: { type: 'string' }, reason: { type: 'string' } },
        required: ['id']
      },
      async execute(ctx, args) {
        const scope = currentEvidenceScope(ctx);
        const ledger = evidenceStore();
        const old = scope ? ledger.get(args.id, [scope]) : null;
        if (!old) return err('证据不存在或不属于当前会话');
        const r = ledger.remove(args.id, {
          actor: String(ctx.triggerUserIds?.[0] || 'model'),
          reason: args.reason
        });
        return r.ok ? ok(r) : err(r.error || '证据删除失败');
      }
    }, {
      name: 'memory_search',
      description: '只搜当前会话以前的聊天，不访问其它群或私聊。query 带时间词（昨天/中午）更好。搜不到换词，别编。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '关键词，含时间+事件更好，如「昨天中午 猪脚饭」' },
          limit: { type: 'integer', description: '最多命中块，默认 4' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const budget = takeMemorySearchBudget(ctx);
          if (!budget.ok) return err(budget.error);
          const cm = getConversationMemory();
          const q = String(args.query ?? '');
          const limit = Math.min(8, Math.max(1, Number(args.limit) || 4));
          if (!ctx.chatKey) return err('当前运行没有绑定会话范围，拒绝搜索');
          let hits = cm.search(q, { chatKey: ctx.chatKey, limit, maxSnippets: 4 });
          // 仍无 → 粗词重试，但仍严格限制当前会话
          if (!hits.length) {
            const loose = q.replace(/[，,。.！!？?、\s]+/g, '').match(/[一-鿿]{2}|[a-z0-9]{3,}/g);
            if (loose?.length >= 2) {
              hits = cm.search(loose.slice(0, 6).join(' '), {
                chatKey: ctx.chatKey,
                limit,
                maxSnippets: 4
              });
              if (hits.length) {
                return { content: formatSearchHits(hits, ctx, budget, { loose: loose.join(' ') }) };
              }
            }
            return { content: '无命中。可换更短/更泛的词再搜；仍无就承认想不起来，勿编。' };
          }
          return { content: formatSearchHits(hits, ctx, budget, {}) };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    }, {
      name: 'memory_archive',
      description: '只读当前会话的聊天归档，不访问其它群或私聊。list=日期列表；day/hours/count/range 读当前会话。',
      parameters: {
        type: 'object',
        properties: {
          mode: { type: 'string', enum: ['list', 'day', 'range', 'count', 'hours'] },
          day: { type: 'string', description: 'YYYY-MM-DD' },
          hour: { type: 'string', description: 'YYYY-MM-DD HH' },
          dayFrom: { type: 'string' },
          dayTo: { type: 'string' },
          offset: { type: 'integer' },
          limit: { type: 'integer' },
          query: { type: 'string', description: 'count 必填' }
        },
        required: ['mode']
      },
      async execute(ctx, args) {
        try {
          const budget = takeMemorySearchBudget(ctx);
          if (!budget.ok) return err(budget.error);
          const archive = new ArchiveReader({ messagesDir: path.join(DATA_DIR, 'messages') });
          const chatKey = ctx.chatKey;
          if (!chatKey) return err('当前运行没有绑定会话范围，拒绝读取归档');
          const mode = String(args.mode || 'list');

          if (mode === 'list') {
            const days = archive.listDays(chatKey, { limit: 20 });
            if (!days.length) return { content: `${chatKey || '当前'} 无归档。` };
            return {
              content: `${chatKey}\n${days.map((d) => `${d.dayKey} ×${d.count}`).join('\n')}`
                + `\n小时: mode=hours day=${days[0].dayKey} · 全天: mode=day chatKey=${chatKey} day=${days[0].dayKey}`
            };
          }

          if (mode === 'hours') {
            const hours = archive.listHours(chatKey, args.day || '', { limit: 24 });
            if (!hours.length) return { content: `${chatKey} ${args.day || ''} 无小时段。` };
            return {
              content: hours.map((h) => `${h.hourKey} ×${h.count}`).join('\n')
                + `\n读: mode=day chatKey=${chatKey} day=${args.day} hour=${hours[hours.length - 1].hourKey}`
            };
          }

          if (mode === 'count') {
            const r = archive.count({
              chatKey, query: args.query,
              day: args.day || null, dayFrom: args.dayFrom || null, dayTo: args.dayTo || null,
              maxSamples: 2
            });
            if (!r.ok) return err(r.error || '统计失败');
            const top = (r.byDay || []).slice(0, 5).map((d) => `${d.dayKey}:${d.messages}`).join(' ');
            const samp = (r.samples || []).map((s) => `- ${s.when} ${s.who}: ${s.text}`).join('\n');
            return {
              content: `${chatKey}「${r.query}」消息${r.messages}次 跨${r.daysTouched}天\n${top}${samp ? `\n${samp}` : ''}`
            };
          }

          // day / range / load
          const r = archive.load({
            chatKey,
            day: args.day,
            hour: args.hour,
            dayFrom: args.dayFrom,
            dayTo: args.dayTo,
            offset: args.offset,
            limit: Math.min(40, Math.max(5, Number(args.limit) || 20)),
            query: args.query
          });
          if (!r.ok) return err(r.error || '归档失败');
          if (!r.lines?.length) return { content: `${chatKey} ${r.day || ''} 无记录。` };
          const body = r.lines.map((l) => `${l.when.slice(5)} ${l.self ? '我' : l.who}: ${l.text}`).join('\n');
          const tail = r.hasMore ? `\n再翻: offset=${r.nextOffset}` : '\n本页结束';
          return { content: `${chatKey} ${r.day || ''} 共${r.total} [${r.offset}..${r.offset + r.returned}]\n${body}${tail}` };
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    }]),
    {
      name: 'search_bilibili',
      description: '在 B 站搜视频（不发送）。拿到 bvid/url 后用 send_bilibili 转发到群里。用户说「搜个 XX 视频发我/发群里」时先搜再转。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，如「深海 电影解说」「摸鱼 日常」' },
          limit: { type: 'integer', description: '最多返回几条，默认 8，上限 20' }
        },
        required: ['query']
      },
      async execute(ctx, args) {
        try {
          const q = String(args.query ?? '').trim();
          if (!q) return err('query 不能为空');
          const limit = Math.max(1, Math.min(20, Number(args.limit) || 8));
          const cookie = String(getConfig().webSearch?.bilibiliCookie || process.env.BILIBILI_COOKIE || '').trim();
          const r = await searchBilibiliVideos(q, { limit, cookie });
          if (!r.videos.length) {
            return ok({ query: q, videos: [], note: '没搜到。换个更具体的词，或让用户丢个链接。' });
          }
          return ok({
            query: q,
            count: r.videos.length,
            videos: r.videos.map((v, i) => ({
              index: i + 1,
              bvid: v.bvid,
              url: v.url,
              title: v.title,
              author: v.author,
              play: v.play,
              duration: v.duration,
              tag: v.tag
            })),
            note: '挑一条用 send_bilibili(url=…) 发到群里；url 整条照抄。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'list_bili_fav',
      description: '列出管理员指定的 B 站收藏夹（默认「B站收藏夹」）里的视频。只从这个夹转发，不要翻其它夹。拿到 url 后 send_bilibili。需已登录 Cookie。',
      parameters: {
        type: 'object',
        properties: {
          mediaId: { type: ['integer', 'string'], description: '可选：覆盖收藏夹 id。一般留空，自动用配置里的「B站收藏夹」' },
          page: { type: 'integer', description: '页码，默认 1' },
          limit: { type: 'integer', description: '每页条数，默认 12' }
        },
        required: []
      },
      async execute(ctx, args) {
        try {
          const cookie = String(getConfig().webSearch?.bilibiliCookie || process.env.BILIBILI_COOKIE || '').trim();
          const cfg = getConfig().webSearch || {};
          const folderName = String(cfg.biliFavFolderName || 'B站收藏夹').trim();
          let mediaId = String(args.mediaId ?? '').trim();
          let folderTitle = folderName;
          if (!mediaId) {
            const resolved = await resolveBiliFavFolder({
              cookie,
              folderName,
              mediaId: String(cfg.biliFavMediaId || '').trim()
            });
            if (!resolved.ok) return err(resolved.error || '找不到指定收藏夹');
            mediaId = resolved.mediaId;
            folderTitle = resolved.title || folderName;
          }
          const r = await listBiliFavVideos({
            mediaId,
            cookie,
            page: Math.max(1, Number(args.page) || 1),
            pageSize: Math.max(1, Math.min(20, Number(args.limit) || 12))
          });
          if (!r.ok) return err(r.error || '读收藏失败');
          return ok({
            mediaId,
            mediaId,
            folder: folderTitle,
            page: r.page,
            total: r.total,
            count: r.videos.length,
            videos: r.videos.map((v, i) => ({
              index: i + 1,
              bvid: v.bvid,
              url: v.url,
              title: v.title,
              author: v.author,
              intro: v.intro
            })),
            note: `仅限收藏夹「${folderTitle}」。转发用 send_bilibili(url=…)；要先看内容再 parse_video。不要翻其它夹。`
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'send_bilibili',
      description: '把 B 站视频转发到当前会话：封面图 + 标题链接（保证可见），并尽量补一张分享卡。传 bilibili.com/video 或 b23.tv / BV 号。要总结内容用 parse_video。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'B 站视频链接或 BV/av 号' },
          replyToMessageId: { type: ['integer', 'string'], description: '可选：引用哪条消息（聊天记录里那条前面的 #短编号，如 #318）' }
        },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const raw = String(args.url ?? '').trim().replace(/^["'“”]+|["'“”。，、）)]+$/g, '');
          if (!raw) return err('需要 B 站视频链接或 BV 号');
          let url = raw;
          if (!/^https?:\/\//i.test(raw)) {
            const ids0 = parseBilibiliIds(raw);
            if (ids0?.bvid) url = `https://www.bilibili.com/video/${ids0.bvid}`;
            else if (ids0?.aid) url = `https://www.bilibili.com/video/av${ids0.aid}`;
            else return err('需要 bilibili.com/video 链接、b23.tv 短链，或 BV/av 号');
          }
          if (!looksLikeBilibili(url) && !parseBilibiliIds(url)?.bvid && !parseBilibiliIds(url)?.aid) {
            return err('看起来不是 B 站视频地址。要用 parse_video 分析内容，或 send_message 发文字。');
          }
          // 预取标题/封面（失败也照发裸链接）
          let title = '';
          let desc = '';
          let cover = '';
          try {
            const cookie = String(getConfig().webSearch?.bilibiliCookie || process.env.BILIBILI_COOKIE || '').trim();
            const meta = await parseBilibiliVideo(url, { maxTranscriptChars: 100, cookie });
            title = meta.title || '';
            desc = (meta.desc || '').slice(0, 60);
            cover = meta.coverUrl || meta.cover || '';
            if (meta.url) url = meta.url;
          } catch { /* 允许无元信息转发 */ }

          const result = await ctx.sender.sendBilibiliCard(ctx.chatKey, {
            url,
            title: title || raw,
            desc,
            cover
          }, {
            replyToMessageId: args.replyToMessageId ?? null
          });
          ctx.session.sent.push({
            type: 'image',
            text: `[B站:${(title || url).slice(0, 40)}]`,
            at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
          });
          ctx.emit('session-update', ctx.session.id);
          return ok({
            sent: true,
            mode: result?.mode || 'card',
            title: title || url,
            url,
            note: '已发封面+链接（保证可见）；若支持也会附带分享卡。'
          });
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },
    {
      name: 'parse_video',
      description: '总结 B 站视频内容。优先字幕；其次官方AI总结/热评/简介；可选抽帧视觉。丢 bilibili.com/video 或 b23.tv、问讲了啥时用。别编台词。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'B 站视频链接（或裸 BV/av 号）' },
          includeRaw: { type: 'boolean', description: '默认 false。true 时附带截断字幕（费 token，一般不用）' },
          useFrames: { type: 'boolean', description: '默认 false。true 时若无字幕且本机有 ffmpeg+视觉模型，则抽帧看画面总结（更慢更贵）' }
        },
        required: ['url']
      },
      async execute(ctx, args) {
        try {
          const cookie = String(getConfig().webSearch?.bilibiliCookie || process.env.BILIBILI_COOKIE || '').trim();
          const r = await parseBilibiliVideo(String(args.url ?? ''), {
            maxTranscriptChars: 24000,
            cookie
          });
          const mins = r.durationSec ? `${Math.round(r.durationSec / 60)}分${r.durationSec % 60}秒` : '';
          const views = r.stat?.view ? `${r.stat.view}` : '';
          const likes = r.stat?.like ? `${r.stat.like}` : '';
          const parts = (r.pages || []).filter((p) => p.part).map((p, i) => `${i + 1}.${p.part}`).join('；');
          const head = [
            `标题：${r.title}`,
            r.owner ? `UP：${r.owner}` : '',
            r.tname ? `分区：${r.tname}` : '',
            mins ? `时长：${mins}` : '',
            views || likes ? `播放${views || '—'} · 赞${likes || '—'}` : '',
            r.keywords?.length ? `标签：${r.keywords.slice(0, 8).join('、')}` : '',
            parts ? `分P：${parts}` : '',
            r.desc ? `简介：${r.desc}` : '',
            `链接：${r.url}`
          ].filter(Boolean).join('\n');

          const sources = [];
          const notes = [];
          if (r.transcript) {
            sources.push(`【字幕】\n${r.transcript}`);
            notes.push(r.transcriptNote || '有字幕');
          }
          if (r.conclusion) {
            sources.push(`【B站官方AI总结】\n${r.conclusion}`);
            notes.push(r.conclusionNote || '官方总结');
          }
          if (r.comments) {
            sources.push(`【热评（非台词）】\n${r.comments}`);
            notes.push(r.commentsNote || '热评');
          }
          if (r.danmaku) {
            sources.push(`【弹幕片段（非台词）】\n${r.danmaku.slice(0, 400)}`);
            notes.push('弹幕');
          }
          if (!r.transcript && !r.conclusion && !r.comments) {
            sources.push(`【仅有元信息】\n标题/UP/简介/分P 已在上面`);
            notes.push(r.transcriptNote || '无字幕');
          }

          // 可选：抽帧 + 视觉
          let frames = [];
          if (!r.transcript && args.useFrames === true) {
            try {
              frames = await extractVideoFrames({
                bvid: r.bvid,
                cid: r.cid,
                durationSec: r.durationSec,
                cookie,
                maxFrames: 4
              });
              if (frames.length) notes.push(`抽帧 ${frames.length} 张`);
              else notes.push('抽帧失败或无 ffmpeg');
            } catch (e) {
              notes.push(`抽帧异常：${e?.message ?? e}`);
            }
          }

          const visionOn = getConfig().api?.vision !== false;
          const useVision = frames.length > 0 && visionOn;
          const textPrompt = [
            `把下面 B 站视频信息压成口语中文摘要，给群友看（200~350字）。`,
            `要求：说清主讲什么/关键观点或笑点/结论；禁止编造字幕或总结里没有的台词剧情；不要写「总结如下」。`,
            ``,
            `【标题】${r.title}`,
            r.owner ? `【UP】${r.owner}` : '',
            ...sources
          ].filter(Boolean).join('\n');

          let summary = '';
          try {
            const content = useVision
              ? imageParts(textPrompt + '\n下面是均匀抽帧，请结合画面内容一起总结。', frames)
              : [{ type: 'text', text: textPrompt }];
            const res = await chatCompletion({
              messages: [{ role: 'user', content }],
              tools: null,
              temperature: 0.4,
              overrides: { disableThinking: true, timeoutMs: 120000 }
            });
            summary = String(res?.message?.content || '').trim().slice(0, 800);
          } catch (e) {
            notes.push(`摘要模型失败：${e?.message ?? e}`);
          }

          if (!summary) {
            return ok(`${head}\n${notes.join(' · ')}\n【转述素材】按上面来源和标题说两句，别编台词。`);
          }
          const raw = args.includeRaw === true && r.transcript
            ? `\n\n【字幕前 1500 字】\n${r.transcript.slice(0, 1500)}`
            : '';
          return ok(`${head}\n${notes.join(' · ')}\n\n【视频内容摘要】\n${summary}${raw}`);
        } catch (error) {
          return err(error?.message ?? error);
        }
      }
    },

  ];

  // 扩展底座：并入 skills/plugins 注册的工具（skillId__xxx）
  try {
    return mergeSkillTools(defs);
  } catch {
    return defs;
  }
}

/**
 * 工具参数 description 是否保留完整说明。
 * 核心链路（收尾/发消息/表情/合并转发/写记忆/归档）保留；
 * 其余 30+ 普通工具只保留 type/required/enum，删掉与工具级说明重复的参数注释。
 * 实测：16331 → ~13869 字符，约省 15% 工具描述体积；不改角色卡/系统提示。
 */
const FULL_PARAM_DESC_TOOLS = new Set([
  'send_message',
  'send_image',
  'list_stickers',
  'send_forward',
  'memory_append',
  'memory_archive'
]);

function stripParamDescriptions(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(stripParamDescriptions);
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'description') continue;
    out[k] = stripParamDescriptions(v);
  }
  return out;
}

/**
 * 这句话在群里"自曝是 AI/模型/程序"吗？
 *
 * ⚠️ 2026-09-21 修了一个笔误：原来正则的第一个分支是**裸的 `我是`**，
 * 等于"只要消息里出现『我是』就一律拦下"。线上实测（20:33 私聊）：
 *   「好好好 我是坏鱼 你才是坏猫」→ 被拦
 *   「行吧 我是坏鱼 你才是坏猫」  → 又被拦
 * 白烧两轮，模型最后急得把参数当话发了出来。这是纯 bug：本意只想拦"我是AI"这种自曝。
 * 抽成独立函数是为了能被 selftest 直接断言（原来埋在 send_message 里没法测）。
 */
export function looksLikeAiSelfClaim(text) {
  const t = String(text ?? '');
  if (!t) return false;
  // 注意 `一个?` 的老写法其实要求必须有「一」（"我是AI"漏网）—— 这里改成"可选的数量词"。
  const aiWord = '(?:AI|人工智能|大模型|语言模型|LLM|程序|助手|机器人|bot)';
  return new RegExp(
    `我\\s*(?:是|就是|其实是|只是|只不过是?|不过是)\\s*(?:一|个|一名|一个|一只|一台|位)?\\s*${aiWord}`
    + `|作为(?:一个)?${aiWord}`
    + `|我由.{0,12}(?:训练|调优|微调)`
    + `|我是被训练出来的`
    + `|(?:AI|人工智能|大模型|语言模型)助手`, 'i').test(t);
}

/**
 * 这是"要说的话"，还是模型把工具参数/JSON 碎片当话发出来了？
 * 实测泄漏：`["哭这么大声 我在隔壁湾都听见了"], "replyToMessageId":`
 */
export function looksLikeToolArgFragment(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  if (/"replyToMessageId"|"messages"\s*:|"atUserId"|"stickerId"|"tool"\s*:/.test(t)) return true;
  // 形如 ["..."] 或 {"..."} 的整体外壳（正常聊天不会这么写）
  if (/^[[{]\s*"/.test(t)) return true;
  if (/]\s*,\s*"/.test(t) && !/[\u4e00-\u9fff]{4,}/.test(t)) return true;
  return false;
}

/** 转成 OpenAI tools 参数格式。按 name 排序，保证 tools 数组字节级稳定（千问显式缓存要求）。 */
export function toOpenAiTools(defs) {
  return [...defs]
    .sort((a, b) => String(a.name).localeCompare(String(b.name)))
    .map((d) => {
      let parameters = d.parameters;
      if (!FULL_PARAM_DESC_TOOLS.has(d.name) && parameters) {
        parameters = stripParamDescriptions(parameters);
      }
      return {
        type: 'function',
        function: {
          name: d.name,
          description: d.description,
          parameters
        }
      };
    });
}

/** 找到并执行一个工具调用。返回 { content, isError }，content 为 string 或 parts 数组。 */
export async function executeTool(defs, ctx, name, argsJson) {
  const def = defs.find((d) => d.name === name);
  if (!def) return { content: `错误：未知工具 ${name}`, isError: true };
  let args = {};
  const raw = argsJson ?? '{}';
  try {
    args = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return { content: `错误：工具 ${name} 的参数不是合法 JSON：${String(raw).slice(0, 200)}`, isError: true };
  }
  try {
    return await def.execute(ctx, args ?? {});
  } catch (error) {
    return { content: `错误：${error?.message ?? error}`, isError: true };
  }
}
