// B 站视频解析：元信息 + 字幕/弹幕/官方AI总结/热评/可选抽帧。
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function bilibiliGet(url, { cookie = '', timeoutMs = 15000 } = {}) {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      origin: 'https://www.bilibili.com',
      referer: 'https://www.bilibili.com/',
      ...(cookie ? { cookie } : {})
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`B站 HTTP ${res.status}`);
  return res.json();
}

/** 从各种 B 站链接里抠 BV / avid（容忍全角、空格、QQ 贴链污染） */
export function parseBilibiliIds(rawUrl) {
  let u = String(rawUrl || '')
    .replace(/[　 ]/g, ' ')
    .replace(/[（）]/g, () => '')
    .trim();
  // 全角斜杠/字母常见于粘贴
  u = u.replace(/／/g, '/').replace(/[\uFF21-\uFF3A\uFF41-\uFF5A]/g, (ch) => {
    const c = ch.charCodeAt(0);
    const base = c <= 0xFF3A ? c - 0xFEE0 : c - 0xFEE0;
    return String.fromCharCode(base);
  });
  if (!u) return null;
  const bv = /(BV[0-9A-Za-z]{10})/i.exec(u);
  const av = /(?:av|AV)(\d+)/.exec(u);
  return {
    bvid: bv ? bv[1] : '',
    aid: av ? av[1] : ''
  };
}

async function resolveShortUrl(url) {
  if (!/b23\.tv/i.test(url)) return url;
  try {
    const res = await fetch(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'user-agent': UA },
      signal: AbortSignal.timeout(8000)
    });
    return res.url || url;
  } catch {
    return url;
  }
}

function absSubUrl(subUrl) {
  let u = String(subUrl || '').trim();
  if (!u) return '';
  if (u.startsWith('//')) return `https:${u}`;
  if (u.startsWith('/')) return `https:${u}`;
  if (!/^https?:/i.test(u)) return `https://${u.replace(/^\/+/, '')}`;
  return u;
}

async function fetchSubtitleBody(subUrl, cookie = '') {
  const url = absSubUrl(subUrl);
  if (!url) return [];
  const subRes = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      ...(cookie ? { cookie } : {})
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!subRes.ok) throw new Error(`字幕下载 HTTP ${subRes.status}`);
  const subJson = await subRes.json();
  return Array.isArray(subJson?.body) ? subJson.body : [];
}

function bodyToTranscript(body, maxChars) {
  return body
    .map((line) => String(line?.content || '').trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, Math.max(500, Number(maxChars) || 4000));
}

/** 多路拉字幕列表：v2 / wbi/v2。 */
async function loadSubtitles({ bvid, aid, cid, cookie }) {
  const idQs = bvid ? `bvid=${encodeURIComponent(bvid)}` : `aid=${encodeURIComponent(aid)}`;
  const endpoints = [
    `https://api.bilibili.com/x/player/wbi/v2?${idQs}&cid=${cid}`,
    `https://api.bilibili.com/x/player/v2?${idQs}&cid=${cid}`,
    `https://api.bilibili.com/x/player/v2?bvid=${encodeURIComponent(bvid)}&aid=${aid}&cid=${cid}`
  ];
  let lastErr = null;
  let lastPlayer = null;
  for (const ep of endpoints) {
    try {
      const player = await bilibiliGet(ep, { cookie });
      lastPlayer = player;
      const subs = player?.data?.subtitle?.subtitles || [];
      if (subs.length) return { subs, player };
    } catch (e) {
      lastErr = e;
    }
  }
  if (lastPlayer) return { subs: [], player: lastPlayer };
  if (lastErr) throw lastErr;
  return { subs: [], player: null };
}

/** 弹幕列表（list.so）：无字幕时的补充信号。protobuf/xml 混出，只抽可读中文片段。 */
async function fetchDanmakuSnippets({ cid, cookie, maxChars = 1200 }) {
  const url = `https://api.bilibili.com/x/v1/dm/list.so?oid=${cid}&type=1`;
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer: `https://www.bilibili.com/`,
      ...(cookie ? { cookie } : {})
    },
    signal: AbortSignal.timeout(10000)
  });
  if (!res.ok) throw new Error(`弹幕 HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  // XML 弹幕
  if (text.includes('<d ')) {
    const lines = [...text.matchAll(/<d[^>]*>([\s\S]*?)<\/d>/g)]
      .map((m) => String(m[1] || '').replace(/<[^>]+>/g, '').trim())
      .filter((s) => s && /[一-鿿]/.test(s))
      .slice(0, 80);
    if (lines.length) return lines.join(' ').replace(/\s+/g, ' ').slice(0, maxChars);
  }
  // protobuf 二进制：抠出连续可读中文串
  const cn = buf.toString('binary').match(/(?:[\x20-\x7e][\u4e00-\u9fff]?){4,}/g) || [];
  const parts = cn
    .map((s) => s.replace(/[^\u4e00-\u9fffA-Za-z0-9，。！？…~～\s]/g, '').trim())
    .filter((s) => /[一-鿿]/.test(s) && s.length >= 2)
    .slice(0, 60);
  if (parts.length) return parts.join(' ').replace(/\s+/g, ' ').slice(0, maxChars);
  return '';
}

/** 官方 AI 总结（多数要登录 cookie）。返回 { text, note } */
async function fetchVideoConclusion({ bvid, aid, cid, mid, cookie }) {
  if (!cid) return { text: '', note: '无 cid，跳过官方总结' };
  const endpoints = [
    `https://api.bilibili.com/x/web-interface/view/conclusion/get?bvid=${encodeURIComponent(bvid)}&cid=${cid}&up_mid=${mid || ''}`,
    `https://api.bilibili.com/x/web-interface/view/conclusion/get?bvid=${encodeURIComponent(bvid)}&cid=${cid}`,
    `https://api.bilibili.com/x/web-interface/view/conclusion/get?aid=${aid}&cid=${cid}`
  ];
  let lastNote = '未取到官方总结';
  for (const ep of endpoints) {
    try {
      const j = await bilibiliGet(ep, { cookie });
      if (j.code !== 0) {
        lastNote = `官方总结 code=${j.code} ${j.message || ''}`;
        continue;
      }
      const model = j.data?.model_result || j.data?.conclusion || j.data || {};
      const parts = [
        model.summary || model.title || '',
        Array.isArray(model.topic_summary)
          ? model.topic_summary.map((t) => t.topic_name || t.topic || '').filter(Boolean).join('；')
          : '',
        Array.isArray(model.outline)
          ? model.outline.map((o) => o.outline || o.title || '').filter(Boolean).join('；')
          : '',
        Array.isArray(model.revision)
          ? model.revision.map((x) => x.outline || x.title || '').filter(Boolean).join('；')
          : ''
      ].filter(Boolean).join('\n');
      if (parts.trim()) return { text: parts.trim().slice(0, 2500), note: '已取 B 站官方 AI 总结' };
    } catch (e) {
      lastNote = `官方总结失败：${e?.message ?? e}`;
    }
  }
  return { text: '', note: lastNote };
}

/** 热评：无字幕时的内容信号（不是台词，但能看出主题/反应）。 */
async function fetchHotComments({ aid, cookie, limit = 12 }) {
  if (!aid) return { text: '', note: '' };
  const tries = [
    `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&pn=1&ps=20&sort=1`,
    `https://api.bilibili.com/x/v2/reply?type=1&oid=${aid}&pn=1&ps=20&sort=2`
  ];
  let last = '热评为空';
  for (const ep of tries) {
    try {
      const j = await bilibiliGet(ep, { cookie });
      const list = Array.isArray(j?.data?.replies) ? j.data.replies : [];
      const lines = list
        .map((x) => String(x?.content?.message || '').replace(/\s+/g, ' ').trim())
        .filter((s) => s && s.length >= 3)
        .slice(0, limit);
      if (lines.length) return { text: lines.join(' / ').slice(0, 1200), note: `热评 ${lines.length} 条` };
      last = `热评空（code=${j.code} n=${list.length}）`;
    } catch (e) {
      last = `热评失败：${e?.message ?? e}`;
    }
  }
  return { text: '', note: last };
}

/** 封面 → dataURL（有视觉模型时当辅助画面）。 */
async function downloadCoverDataUrl(coverUrl, cookie = '') {
  const u0 = String(coverUrl || '').trim();
  if (!u0) return '';
  const u = u0.startsWith('//') ? `https:${u0}` : u0.replace(/^http:/, 'https:');
  try {
    const res = await fetch(u, {
      headers: {
        'user-agent': UA,
        referer: 'https://www.bilibili.com/',
        ...(cookie ? { cookie } : {})
      },
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return '';
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length < 100 || buf.length > 4 * 1024 * 1024) return '';
    const mime = (res.headers.get('content-type') || 'image/jpeg').split(';')[0];
    return `data:${mime.startsWith('image/') ? mime : 'image/jpeg'};base64,${buf.toString('base64')}`;
  } catch {
    return '';
  }
}

/** 找 ffmpeg；没有则返回 ''。 */
export function findFfmpeg() {
  const env = String(process.env.FFMPEG_PATH || process.env.FFMPEG || '').trim();
  if (env && fs.existsSync(env)) return env;
  const candidates = [
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'D:\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch { /* ignore */ }
  }
  // PATH 上的 ffmpeg
  try {
    const r = spawnSync('ffmpeg', ['-version'], { windowsHide: true, timeout: 4000 });
    if (!r.error && r.status === 0) return 'ffmpeg';
  } catch { /* ignore */ }
  return '';
}

/** 抽帧：优先 ffmpeg；最多 N 张均匀时刻的 JPEG dataURL。无 ffmpeg / 失败返回 []。 */
export async function extractVideoFrames({ bvid, cid, durationSec, cookie = '', maxFrames = 4 }) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg || !cid) return [];
  const qn = Number(process.env.BILI_PLAY_QN) || 16;
  const play = await bilibiliGet(
    `https://api.bilibili.com/x/player/playurl?bvid=${encodeURIComponent(bvid)}&cid=${cid}&qn=${qn}&fnval=1&platform=html5&high_quality=1`,
    { cookie }
  );
  const durl = play?.data?.durl?.[0]?.url || play?.data?.durl?.[0]?.backup_url?.[0] || '';
  if (!durl) return [];
  const dur = Math.max(5, Number(durationSec) || 60);
  const n = Math.max(1, Math.min(6, Number(maxFrames) || 4));
  const out = [];
  const { spawn } = await import('node:child_process');
  for (let i = 0; i < n; i++) {
    const ss = Math.max(1, Math.round((dur * (i + 0.5)) / n));
    const buf = await new Promise((resolve) => {
      let chunks = [];
      let err = '';
      const p = spawn(ffmpeg, [
        '-ss', String(ss),
        '-i', durl,
        '-frames:v', '1',
        '-f', 'image2pipe',
        '-vcodec', 'mjpeg',
        '-q:v', '5',
        '-'
      ], { windowsHide: true });
      p.stdout.on('data', (c) => chunks.push(c));
      p.stderr.on('data', (c) => { err += String(c).slice(0, 400); });
      p.on('error', () => resolve(null));
      p.on('close', (code) => resolve(code === 0 && chunks.length ? Buffer.concat(chunks) : null));
      setTimeout(() => { try { p.kill(); } catch { /* ignore */ } resolve(null); }, 25000);
    });
    if (buf && buf.length > 500) {
      out.push(`data:image/jpeg;base64,${buf.toString('base64')}`);
    }
    void err;
  }
  return out;
}

/** 从视频页 HTML 里抠 title/desc/tag（API 缺字段时的底层兜底）。 */
async function scrapeVideoPage(bvid, cookie = '') {
  const url = `https://www.bilibili.com/video/${bvid}/`;
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      referer: 'https://www.bilibili.com/',
      ...(cookie ? { cookie } : {})
    },
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) throw new Error(`页面 HTTP ${res.status}`);
  const html = await res.text();
  const out = { title: '', desc: '', tags: [] };
  const t1 = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const t2 = html.match(/"title"\s*:\s*"([^"]{4,160})"/);
  out.title = String(t1?.[1] || t2?.[1] || '').replace(/_哔哩哔哩.*$/, '').trim();
  const d1 = html.match(/"desc"\s*:\s*"([^"]{0,800})"/);
  out.desc = String(d1?.[1] || '').replace(/\\n/g, ' ').replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).trim();
  const tagBlock = html.match(/"tags"\s*:\s*\[([^\]]{0,2000})\]/);
  if (tagBlock) {
    out.tags = [...tagBlock[1].matchAll(/"tag_name"\s*:\s*"([^"]+)"/g)].map((m) => m[1]).filter(Boolean).slice(0, 10);
  }
  if (!out.tags.length) {
    out.tags = [...html.matchAll(/"keyword"\s*:\s*"([^"]{1,20})"/g)].map((m) => m[1]).filter(Boolean).slice(0, 10);
  }
  return out;
}

/**
 * 解析 B 站视频：元信息 + 字幕/弹幕（截断）。
 */
export async function parseBilibiliVideo(inputUrl, { maxTranscriptChars = 4000, cookie = '' } = {}) {
  let url = String(inputUrl || '').trim();
  if (!url) throw new Error('需要 B 站链接');
  // QQ 粘贴常带中文引号/尖括号/尾部句号
  url = url.replace(/^["'“”]+|["'“”。，、）)]+$/g, '').trim();
  if (!/^https?:\/\//i.test(url)) {
    if (/^BV[0-9A-Za-z]{10}$/i.test(url)) url = `https://www.bilibili.com/video/${url}`;
    else if (/^av\d+$/i.test(url)) url = `https://www.bilibili.com/video/${url}`;
    else throw new Error('需要完整 B 站链接或 BV/av 号');
  }
  url = await resolveShortUrl(url);
  const ids = parseBilibiliIds(url);
  if (!ids || (!ids.bvid && !ids.aid)) throw new Error(`无法从链接识别 BV/av：${url}`);

  const qs = ids.bvid
    ? `bvid=${encodeURIComponent(ids.bvid)}`
    : `aid=${encodeURIComponent(ids.aid)}`;
  const view = await bilibiliGet(`https://api.bilibili.com/x/web-interface/view?${qs}`, { cookie });
  if (view.code !== 0) throw new Error(`视频信息失败：${view.code} ${view.message || ''}`);
  const d = view.data || {};
  let title = String(d.title || '').slice(0, 160);
  let owner = String(d.owner?.name || '');
  let desc = String(d.desc || '').replace(/\s+/g, ' ').slice(0, 800);
  let cid = Number(d.cid) || 0;
  const aid = Number(d.aid) || 0;
  const bvid = String(d.bvid || ids.bvid || '');
  let tname = String(d.tname || d.pubarea || '');
  let keywords = (Array.isArray(d.keyword) ? d.keyword : String(d.tag || '').split(/[,，\s]+/))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 12);
  const stat = {
    view: Number(d.stat?.view) || 0,
    like: Number(d.stat?.like) || 0,
    coin: Number(d.stat?.coin) || 0,
    danmaku: Number(d.stat?.danmaku) || 0
  };
  let pages = (Array.isArray(d.pages) ? d.pages : []).slice(0, 12).map((p) => ({
    part: String(p.part || '').slice(0, 80),
    duration: Number(p.duration) || 0
  }));

  // cid 缺失时走 pagelist
  if (!cid) {
    try {
      const pl = await bilibiliGet(`https://api.bilibili.com/x/player/pagelist?${qs}`, { cookie });
      cid = Number(pl?.data?.[0]?.cid) || 0;
    } catch { /* ignore */ }
  }

  // API 字段空 → 抠页面
  if (!title || !desc || !tname || !keywords.length) {
    try {
      const scraped = await scrapeVideoPage(bvid, cookie);
      if (!title && scraped.title) title = scraped.title.slice(0, 160);
      if (!desc && scraped.desc) desc = scraped.desc.slice(0, 800);
      if (!keywords.length && scraped.tags.length) keywords = scraped.tags;
    } catch { /* ignore */ }
  }

  let transcript = '';
  let transcriptNote = '';
  let pickedLan = '';
  let danmaku = '';
  try {
    if (cid) {
      const { subs } = await loadSubtitles({ bvid, aid, cid, cookie });
      if (!subs.length) {
        transcriptNote = '没有字幕（可能未开 AI 字幕，或需 B站 cookie）';
      } else {
        const pick = subs.find((s) => /zh|中/i.test(String(s.lan || s.lan_doc || ''))) || subs[0];
        pickedLan = String(pick.lan_doc || pick.lan || '字幕');
        const body = await fetchSubtitleBody(pick.subtitle_url || pick.subUrl || '', cookie);
        transcript = bodyToTranscript(body, maxTranscriptChars);
        if (!transcript) transcriptNote = '字幕存在但内容为空';
        else transcriptNote = `已取 ${pickedLan} 约 ${transcript.length} 字`;
      }
    } else {
      transcriptNote = '拿不到 cid，无法取字幕';
    }
  } catch (e) {
    transcriptNote = `字幕获取失败：${e?.message ?? e}`;
  }

  // 没字幕时试弹幕
  if (!transcript && cid) {
    try {
      danmaku = await fetchDanmakuSnippets({ cid, cookie, maxChars: 1200 });
      if (danmaku) transcriptNote = `${transcriptNote}；另取弹幕约 ${danmaku.length} 字（非台词）`;
    } catch (e) {
      transcriptNote = `${transcriptNote}；弹幕也失败：${e?.message ?? e}`;
    }
  }

  // 官方 AI 总结（多要 cookie）+ 热评
  let conclusion = '';
  let conclusionNote = '';
  let comments = '';
  let commentsNote = '';
  let cover = '';
  if (!transcript) {
    const mid = Number(d.owner?.mid) || 0;
    // 先热评（免登录），再官方总结（多要 cookie）
    const c2 = await fetchHotComments({ aid, cookie, limit: 12 });
    comments = c2.text;
    commentsNote = c2.note;
    const c1 = await fetchVideoConclusion({ bvid, aid, cid, mid, cookie });
    conclusion = c1.text;
    conclusionNote = c1.note;
    cover = await downloadCoverDataUrl(d.pic || d.cover || '', cookie);
  }

  return {
    ok: true,
    bvid,
    cid,
    aid,
    title,
    owner,
    desc,
    durationSec: Number(d.duration) || 0,
    tname,
    keywords,
    stat,
    pages,
    coverUrl: String(d.pic || d.cover || '').replace(/^http:/, 'https:'),
    cover,
    url: `https://www.bilibili.com/video/${bvid || ''}`,
    transcript,
    danmaku,
    conclusion,
    conclusionNote,
    comments,
    commentsNote,
    transcriptNote,
    pickedLan
  };
}

export function looksLikeBilibili(url) {
  const u = String(url || '');
  return /bilibili\.com\/video|b23\.tv|^BV[0-9A-Za-z]{10}$|^av\d+$/i.test(u);
}

function stripHtml(s) {
  return String(s || '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * B 站视频搜索（search/all/v2 → video 模块）。
 * 无 cookie 也能搜；有 cookie 更稳。
 * @returns {{ query, videos: [{bvid,url,title,author,play,duration,pic,desc}] }}
 */
export async function searchBilibiliVideos(query, { limit = 8, cookie = '' } = {}) {
  const q = String(query || '').trim();
  if (!q) return { query: '', videos: [] };
  const max = Math.max(1, Math.min(20, Number(limit) || 8));
  const url = `https://api.bilibili.com/x/web-interface/search/all/v2?keyword=${encodeURIComponent(q)}&page=1`;
  const j = await bilibiliGet(url, { cookie });
  if (j.code !== 0) throw new Error(`B站搜索失败：${j.code} ${j.message || ''}`);
  const modules = Array.isArray(j?.data?.result) ? j.data.result : [];
  const videoMod = modules.find((m) => m?.result_type === 'video' && Array.isArray(m.data));
  const list = videoMod?.data || [];
  const videos = [];
  for (const it of list) {
    const bvid = String(it.bvid || '').trim();
    if (!bvid) continue;
    videos.push({
      bvid,
      url: `https://www.bilibili.com/video/${bvid}`,
      title: stripHtml(it.title).slice(0, 100),
      author: stripHtml(it.author).slice(0, 40),
      play: Number(it.play) || 0,
      favorites: Number(it.favorites) || 0,
      duration: String(it.duration || '').trim(),
      pic: String(it.pic || '').replace(/^http:/, 'https:'),
      desc: stripHtml(it.description).slice(0, 80),
      tag: stripHtml(it.tag).slice(0, 40)
    });
    if (videos.length >= max) break;
  }
  return { query: q, videos };
}

/** 从 cookie 里抠登录 mid（DedeUserID）。 */
export function midFromCookie(cookie) {
  const m = /(?:^|;\s*)DedeUserID=(\d+)/i.exec(String(cookie || ''));
  return m ? m[1] : '';
}

/**
 * 列出当前登录用户的收藏夹。
 * 需要 cookie（登录后 SESSDATA + DedeUserID）。
 */
export async function listBiliFavFolders({ cookie } = {}) {
  const mid = midFromCookie(cookie);
  if (!mid) return { ok: false, error: '需要登录 Cookie（DedeUserID）才能列收藏夹。点设置里「一键登录 B 站」。', folders: [] };
  const j = await bilibiliGet(
    `https://api.bilibili.com/x/v3/fav/folder/created/list-all?up_mid=${mid}`,
    { cookie }
  );
  if (j.code !== 0) return { ok: false, error: `收藏夹失败：${j.code} ${j.message || ''}`, folders: [] };
  const list = j?.data?.list || [];
  return {
    ok: true,
    mid,
    folders: list.map((f) => ({
      mediaId: String(f.id),
      title: String(f.title || '').slice(0, 40),
      favCount: Number(f.media_count) || 0,
      updated: Number(f.ftime || f.updated_time) || 0
    }))
  };
}

/**
 * 解析「AI 专用收藏夹」：按配置的 mediaId，或按文件夹名（默认「B站收藏夹」）。
 * 找不到则返回 null。
 */
export async function resolveBiliFavFolder({ cookie = '', folderName = '', mediaId = '' } = {}) {
  const name = String(folderName || '').trim();
  const fixedId = String(mediaId || '').trim();
  if (fixedId && /^\d+$/.test(fixedId)) {
    return { ok: true, mediaId: fixedId, title: name || fixedId, from: 'config-id' };
  }
  if (!name) return { ok: false, error: '未配置 B 站收藏夹名/ID', folders: [] };
  const folders = await listBiliFavFolders({ cookie });
  if (!folders.ok) return { ok: false, error: folders.error, folders: [] };
  const hit = folders.folders.find((f) => f.title === name)
    || folders.folders.find((f) => f.title.includes(name))
    || folders.folders.find((f) => name.includes(f.title) && f.title.length >= 2);
  if (!hit) {
    return {
      ok: false,
      error: `没找到收藏夹「${name}」。请在 B 站建好该夹，或在设置里改名字/填 mediaId。可用：${folders.folders.map((f) => f.title).join('、') || '（空）'}`,
      folders: folders.folders
    };
  }
  return { ok: true, mediaId: hit.mediaId, title: hit.title, favCount: hit.favCount, from: 'name' };
}

/**
 * 列出某个收藏夹里的视频。
 * @param {{ mediaId: string, cookie: string, page?: number, pageSize?: number }} opts
 */
export async function listBiliFavVideos({ mediaId, cookie = '', page = 1, pageSize = 12 } = {}) {
  const id = String(mediaId || '').trim();
  if (!/^\d+$/.test(id)) return { ok: false, error: '需要收藏夹 mediaId（数字）', videos: [] };
  const ps = Math.max(1, Math.min(20, Number(pageSize) || 12));
  const pn = Math.max(1, Number(page) || 1);
  const j = await bilibiliGet(
    `https://api.bilibili.com/x/v3/fav/resource/list?media_id=${id}&pn=${pn}&ps=${ps}&platform=web`,
    { cookie }
  );
  if (j.code !== 0) {
    const needLogin = j.code === -101 || j.code === -403;
    return {
      ok: false,
      error: needLogin
        ? `收藏夹需要登录 Cookie（code=${j.code}）。设置里一键登录 B 站后再试。`
        : `收藏夹失败：${j.code} ${j.message || ''}`,
      videos: []
    };
  }
  const medias = j?.data?.medias || [];
  const videos = [];
  for (const m of medias) {
    // type 2 = 视频
    if (m.type !== 2 && m.type != null) continue;
    const bvid = String(m.bvid || '').trim();
    if (!bvid) continue;
    videos.push({
      bvid,
      url: `https://www.bilibili.com/video/${bvid}`,
      title: String(m.title || '').slice(0, 100),
      author: String(m.upper?.name || '').slice(0, 40),
      cover: String(m.cover || '').replace(/^http:/, 'https:'),
      duration: Number(m.duration) || 0,
      intro: String(m.intro || '').slice(0, 80)
    });
  }
  return {
    ok: true,
    page: pn,
    pageSize: ps,
    total: Number(j?.data?.info?.media_count) || videos.length,
    videos
  };
}
