// 安全抓取层（完整移植自原版 safe-fetch + mcp-web-search-safe 的 SSRF 防护）。
//
// - 仅 http/https；禁止 URL 内嵌凭据；
// - 禁止 localhost / .local / 私有 IP / 环回 / 链路本地 / CGNAT 等内网地址；
// - 域名先做 DNS 解析并检查全部解析结果；解析后固定到已校验的 IP 发请求（防 DNS rebinding）；
// - 手动跟随重定向，每一跳重新校验；
// - 响应体限量读取，避免超大响应拖垮进程。
//
// 例外开关：security.allowPrivateImageHosts = true 时，图片下载跳过内网检查
// （仅供本地测试/自建图床使用，默认关闭）。
import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import { getConfig } from './config.js';

const dnsLookup = dns.promises.lookup;

// ── IP 判定 ─────────────────────────────────────────────────────────────

// 解析 IPv6 中内嵌的 IPv4（::ffff:a.b.c.d、::ffff:7f00:1 等）。
function ipv4FromLast32(lower) {
  const parts = String(lower || '').split(':');
  if (parts.length < 2) return null;
  const last = parts[parts.length - 1];
  const secondLast = parts[parts.length - 2];
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) return last;
  if (/^[0-9a-f]{1,4}$/.test(secondLast) && /^[0-9a-f]{1,4}$/.test(last)) {
    const num = (parseInt(secondLast, 16) << 16) + parseInt(last, 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

function parseEmbeddedIpv4(h) {
  const lower = String(h || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!lower.includes(':')) return null;
  const dotted = lower.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted) return dotted[1];
  const m = lower.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (m) {
    const num = (parseInt(m[1], 16) << 16) + parseInt(m[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  if (lower.startsWith('::ffff:') || lower.startsWith('::')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  if (lower.startsWith('64:ff9b')) {
    const embedded = ipv4FromLast32(lower);
    if (embedded) return embedded;
  }
  const nat64 = lower.match(/^64:ff9b:(?:::)?(?:([0-9a-f]{1,4}):([0-9a-f]{1,4})|(\d+\.\d+\.\d+\.\d+))$/i);
  if (nat64) {
    if (nat64[3]) return nat64[3];
    const num = (parseInt(nat64[1], 16) << 16) + parseInt(nat64[2], 16);
    return `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
  }
  return null;
}

export function isPrivateIp(ip) {
  const h = String(ip || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  const embedded = h.includes(':') ? parseEmbeddedIpv4(h) : null;
  if (embedded) return isPrivateIp(embedded);

  if (net.isIP(h) === 4) {
    const parts = h.split('.').map(Number);
    if (parts[0] === 10 || parts[0] === 127 || parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;
    if (parts[0] === 192 && parts[1] === 0 && parts[2] === 0) return true;
    if (parts[0] >= 224) return true;
    return false;
  }

  if (net.isIP(h) === 6) {
    if (h === '::' || h === '::1') return true;
    if (h.startsWith('fc') || h.startsWith('fd')) return true;
    if (/^fe[89ab]/.test(h)) return true;
    if (h.startsWith('fec') || h.startsWith('fed') || h.startsWith('fee') || h.startsWith('fef')) return true;
    if (h.startsWith('2001:db8')) return true;
    if (h.startsWith('2001:2:') || h.startsWith('2001:10:') || h.startsWith('2001:20:')) return true;
    const sixth4 = h.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i);
    if (sixth4) {
      const num = (parseInt(sixth4[1], 16) << 16) + parseInt(sixth4[2], 16);
      const ipv4 = `${(num >>> 24) & 255}.${(num >>> 16) & 255}.${(num >>> 8) & 255}.${num & 255}`;
      if (isPrivateIp(ipv4)) return true;
    }
    if (h.startsWith('ff')) return true;
    return false;
  }
  return false;
}

// ── 主机名校验（含 DNS） ────────────────────────────────────────────────

async function lookupWithTimeout(hostname) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('DNS 解析超时')), 5000);
  });
  return Promise.race([dnsLookup(hostname, { all: true, verbatim: true }), timeout]).finally(() => clearTimeout(timer));
}

async function resolveSafeHost(hostname, { allowPrivate = false } = {}) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) throw new Error('主机名为空');
  if (!allowPrivate && (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local'))) {
    throw new Error('禁止访问内网/本机地址');
  }
  if (net.isIP(h)) {
    if (!allowPrivate && isPrivateIp(h)) throw new Error('禁止访问内网/本机地址');
    return h;
  }
  let addresses;
  try {
    addresses = await lookupWithTimeout(h);
  } catch (error) {
    throw new Error(`域名解析失败：${error?.message ?? error}`);
  }
  if (!addresses.length) throw new Error('域名没有解析结果');
  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isPrivateIp(address)) throw new Error('域名解析到内网/本机地址，已阻止');
    }
  }
  return addresses[0].address;
}

/** 校验 URL 的 scheme 与主机（DNS 级）。返回 { url, ip }。 */
export async function validateFetchUrl(raw, { allowPrivate = false } = {}) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('URL 无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不能包含凭据');
  const ip = await resolveSafeHost(url.hostname, { allowPrivate });
  return { url, ip };
}

// ── 受限请求 ────────────────────────────────────────────────────────────

function sliceByCodePoints(s, max) {
  if (s.length <= max) return s;
  return Array.from(s).slice(0, max).join('');
}

function readBounded(res, maxBytes, asText) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    const chunks = [];
    let total = 0;
    let text = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      fn(val);
    };
    res.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (asText) text += decoder.write(chunk);
      else chunks.push(chunk);
      // 只用字节数判断是否超限。原实现还额外判断了 text.length >= maxBytes，
      // 但 text.length 是字符数而 maxBytes 是字节数（UTF-8 下中文 1 字符 = 3 字节），
      // 单位不一致，会让刚好读满的响应被误标成 truncated。
      if (total >= maxBytes) {
        try { res.destroy(); } catch { /* ignore */ }
        finish(resolve, asText ? sliceByCodePoints(text, maxBytes) : Buffer.concat(chunks).subarray(0, maxBytes));
      }
    });
    res.on('end', () => {
      if (!settled) {
        if (asText) {
          text += decoder.end();
          finish(resolve, sliceByCodePoints(text, maxBytes));
        } else {
          finish(resolve, Buffer.concat(chunks));
        }
      }
    });
    res.on('error', (err) => finish(reject, err));
  });
}

// 使用已校验的 IP 发起请求（保留 Host/SNI），从根上消除 DNS rebinding。
function requestOnce(url, ip, { asBinary = false, maxBytes = 50000, toFile = '', timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const port = url.port || (url.protocol === 'https:' ? 443 : 80);
    const req = mod.request({
      hostname: ip,
      port,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        host: url.host,
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) qq-agent/1.0',
        // ⚠️ 绝对不要在这里写 image/webp（或 avif）。
        // 图站（百度 CDN 等）会按 Accept 做内容协商：只要看到 webp 就回 webp，
        // 而 webp 会连累两处 —— 本地视觉接口（LM Studio）直接 400
        // （"'url' field must be a base64 encoded image."，整轮运行报错、图和话都发不出去）。
        // 不主动索要，图站就会按原始格式（jpeg/png/gif）返回，全链路都用得顺。
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/jpeg,image/png,image/gif,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9'
      },
      servername: url.protocol === 'https:' ? url.hostname : undefined,
      rejectUnauthorized: url.protocol === 'https:',
      timeout: timeoutMs
    }, (res) => {
      const statusCode = res.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        res.resume();
        resolve({ statusCode, redirect: String(res.headers.location || '') });
        return;
      }
      // 流式落盘：视频动辄几十 MB，不能整个读进内存（safeFetchBinaryToFile 用）
      if (toFile) {
        const contentType = String(res.headers['content-type'] || '');
        let written = 0;
        let settled = false;
        const fail = (error) => {
          if (settled) return;
          settled = true;
          try { res.destroy(); } catch { /* ignore */ }
          try { out.destroy(); } catch { /* ignore */ }
          try { fs.rmSync(toFile, { force: true }); } catch { /* ignore */ }
          reject(error);
        };
        const out = fs.createWriteStream(toFile);
        out.on('error', fail);
        res.on('error', fail);
        res.on('data', (chunk) => {
          written += chunk.length;
          // 超限立刻中止并删掉半截文件：留着一个残缺视频比没有更糟
          if (written > maxBytes) fail(new Error(`文件超过大小上限（${Math.round(maxBytes / 1024 / 1024)}MB）`));
        });
        res.pipe(out);
        out.on('finish', () => {
          if (settled) return;
          settled = true;
          resolve({ statusCode, bytes: written, contentType });
        });
        return;
      }
      readBounded(res, maxBytes, !asBinary)
        .then((body) => resolve({ statusCode, body, contentType: String(res.headers['content-type'] || '') }))
        .catch(reject);
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时：${url.hostname}`)));
    req.on('error', reject);
    req.end();
  });
}

const MAX_REDIRECTS = 5;

/**
 * 图片地址校验（供 send_sticker / 图片下载使用）。
 * 默认内网地址一律拒绝；security.allowPrivateImageHosts=true 时放行（仅本地测试/自建图床）。
 */
export async function validateImageUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new Error('图片地址不合法');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只允许 http(s) 图片地址');
  if (getConfig().security?.allowPrivateImageHosts === true) return url.toString();
  const { url: safeUrl } = await validateFetchUrl(url.toString());
  return safeUrl.toString();
}

// ── 浏览锁定（security.browseLock）────────────────────────────────────────
// 把"机器人能上哪些网站"收窄到一份域名清单。只作用于"主动上网"的工具
// （web_fetch / send_image / web_search），不碰 QQ 自己的图源（表情包、群聊图片）。

/** 把用户填的域名/网址清洗成纯主机名：去协议、去路径、去通配符前缀、去 www.、小写。 */
export function normalizeDomain(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, '')
    .replace(/^[^/@]*@/, '')
    .replace(/[/?#].*$/, '')
    .replace(/^\*\./, '')
    .replace(/:\d+$/, '')
    .replace(/\.$/, '')
    // www. 是约定俗成的主机前缀：用户粘贴 www.xxx.com 时，本意是整个站。
    // 去掉它之后，includeSubdomains 才能同时覆盖 xxx.com 和 www.xxx.com。
    .replace(/^www\./, '');
}

/** 当前浏览锁定状态：是否生效 + 清洗后的域名清单。 */
export function browseLockState() {
  const lock = getConfig().security?.browseLock || {};
  const domains = [...new Set((Array.isArray(lock.domains) ? lock.domains : [])
    .map(normalizeDomain)
    .filter(Boolean))];
  return {
    enabled: lock.enabled === true && domains.length > 0,
    domains,
    includeSubdomains: lock.includeSubdomains !== false
  };
}

/** 某个主机名是否被允许（未启用锁定时一律允许）。 */
export function hostAllowed(host, state = browseLockState()) {
  if (!state.enabled) return true;
  const h = normalizeDomain(host);
  if (!h) return false;
  return state.domains.some((d) => h === d || (state.includeSubdomains && h.endsWith(`.${d}`)));
}

/** 锁定生效时抛出人话错误；由 web_fetch / send_image 在每一跳调用。 */
function assertBrowseAllowed(url, state) {
  if (!state.enabled) return;
  if (!hostAllowed(url.hostname, state)) {
    // 错误信息要顺手给出"接下来该怎么办"：模型看到"不能访问"往往会继续换站外地址硬试，
    // 实测一次图片请求能这样白烧 4~6 轮。
    throw new Error(
      `浏览已锁定在 ${state.domains.join('、')}，不能访问 ${url.hostname}。` +
      '只能用锁定站点内的内容；站内确实找不到就如实告诉对方（或者改用收藏表情），不要再去站外找。'
    );
  }
}

export async function safeFetch(urlString, { browseLocked = false, allowPrivate = false } = {}) {
  const lock = browseLocked ? browseLockState() : { enabled: false };
  // 先按域名锁判一次：不合格就别做 DNS（也避免把不该访问的域名交给解析器）
  if (lock.enabled) {
    let raw;
    try { raw = new URL(String(urlString ?? '').trim()); } catch { throw new Error('网址不合法'); }
    assertBrowseAllowed(raw, lock);
  }
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  assertBrowseAllowed(url, lock);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { asBinary: false, maxBytes: 50000 });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      assertBrowseAllowed(url, lock);
      continue;
    }
    const body = result.body || '';
    return { url: url.toString(), statusCode: result.statusCode, truncated: Buffer.byteLength(body, 'utf8') >= 50000, body };
  }
  throw new Error('重定向次数过多，已停止');
}

/** 下载二进制（图片，≤maxBytes 字节），返回 { buffer, contentType }。 */
export async function safeFetchBinary(urlString, maxBytes = 12 * 1024 * 1024, { browseLocked = false } = {}) {
  const allowPrivate = getConfig().security?.allowPrivateImageHosts === true;
  const lock = browseLocked ? browseLockState() : { enabled: false };
  if (lock.enabled) {
    let raw;
    try { raw = new URL(String(urlString ?? '').trim()); } catch { throw new Error('图片地址不合法'); }
    assertBrowseAllowed(raw, lock);
  }
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  assertBrowseAllowed(url, lock);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { asBinary: true, maxBytes });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      assertBrowseAllowed(url, lock);
      continue;
    }
    if (result.statusCode !== 200) throw new Error(`HTTP ${result.statusCode}`);
    return { buffer: result.body, contentType: result.contentType };
  }
  throw new Error('重定向次数过多，已停止');
}

/**
 * 下载二进制**直接落盘**，返回 { path, bytes, contentType }。
 *
 * 为什么单独一个（2026-09-22，为了跑 0.4 的 media-download 插件）：
 * 视频/音频动辄几十 MB，`safeFetchBinary` 那种"整个读进内存"的做法会把进程撑爆。
 * 校验步骤与 safeFetchBinary **完全一致**（浏览锁 → DNS/私网校验 → 逐跳重定向校验 →
 * 大小上限），区别只在响应体走 `createWriteStream` 流式写盘，超限立即中止并删掉半截文件。
 */
export async function safeFetchBinaryToFile(urlString, destPath, maxBytes = 64 * 1024 * 1024, { browseLocked = false, timeoutMs = 120000 } = {}) {
  const dest = String(destPath || '');
  if (!dest) throw new Error('缺少目标文件路径');
  const limit = Math.max(1, Number(maxBytes) || 1);
  const allowPrivate = getConfig().security?.allowPrivateImageHosts === true;
  const lock = browseLocked ? browseLockState() : { enabled: false };
  if (lock.enabled) {
    let raw;
    try { raw = new URL(String(urlString ?? '').trim()); } catch { throw new Error('地址不合法'); }
    assertBrowseAllowed(raw, lock);
  }
  let { url, ip } = await validateFetchUrl(urlString, { allowPrivate });
  assertBrowseAllowed(url, lock);
  fs.mkdirSync(pathDirname(dest), { recursive: true });
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const result = await requestOnce(url, ip, { toFile: dest, maxBytes: limit, timeoutMs });
    if ([301, 302, 303, 307, 308].includes(result.statusCode)) {
      if (!result.redirect) throw new Error(`重定向缺少 Location: ${result.statusCode}`);
      const next = new URL(result.redirect, url).toString();
      ({ url, ip } = await validateFetchUrl(next, { allowPrivate }));
      assertBrowseAllowed(url, lock);
      continue;
    }
    if (result.statusCode !== 200) {
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
      throw new Error(`HTTP ${result.statusCode}`);
    }
    return { path: dest, bytes: Number(result.bytes) || 0, contentType: String(result.contentType || '') };
  }
  try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }
  throw new Error('重定向次数过多，已停止');
}

/** 只为避免在模块顶层再拉一个 path 依赖：取目录名。 */
function pathDirname(p) {
  const s = String(p);
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i > 0 ? s.slice(0, i) : '.';
}
