// OneBot v11 客户端：WebSocket 只收事件，HTTP API 负责发送与查询。
// （原版经 @snowluma/sdk 收事件；这里直接实现标准 OneBot v11，去掉 SDK 补丁依赖。）
import http from 'node:http';
import https from 'node:https';
import WebSocket from 'ws';
import { sanitizeUserText, escapeCqText } from './util.js';

/** 本机 OneBot 直连 POST：不走系统代理（fetch 会被 Clash/代理劫持 127.0.0.1 → fetch failed）。 */
function onebotPost(urlStr, bodyBuf, headers, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch { reject(new Error('OneBot 地址不合法')); return; }
    const isHttps = u.protocol === 'https:';
    const mod = isHttps ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (isHttps ? 443 : 80),
      path: `${u.pathname}${u.search}`.replace(/\/+$/, '') || '/',
      method: 'POST',
      headers: {
        ...headers,
        'content-length': String(bodyBuf.length),
        // 明确不走代理
        host: u.host
      },
      // Node http 不会读 HTTP_PROXY 除非显式 agent；默认 agent 已绕过 env proxy
      timeout: timeoutMs,
      agent: false
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(new Error('OneBot 请求超时')); });
    req.on('error', (err) => reject(new Error(`OneBot 网络错误: ${err?.message ?? err}`)));
    req.write(bodyBuf);
    req.end();
  });
}

/**
 * 带一次重试的 POST。
 *
 * ⚠️ 2026-09-22：加了这层是因为用户实测「发表情包」时出现
 *   `错误: OneBot 网络错误：read ECONNRESET`，而且连着三张都是同一个错。
 *   这种"读响应时被对端 RST"多数是**一次性的**（协议端当时忙/正在重启/请求体让它难受），
 *   重试一次通常就过了；原来一次失败就直接把错误抛给模型，模型再对群友说"网断了"。
 *   只重试连接类错误（ECONNRESET / EPIPE / socket hang up / 超时），
 *   业务错误（HTTP 4xx/5xx、retcode 非 0）**不重试**，避免重复发送。
 */
async function onebotPostWithRetry(urlStr, bodyBuf, headers, timeoutMs) {
  try {
    return await onebotPost(urlStr, bodyBuf, headers, timeoutMs);
  } catch (error) {
    const msg = String(error?.message ?? error);
    const transient = /ECONNRESET|EPIPE|socket hang up|ECONNREFUSED|请求超时|ETIMEDOUT/i.test(msg);
    if (!transient) throw error;
    await new Promise((r) => setTimeout(r, 300));
    try {
      return await onebotPost(urlStr, bodyBuf, headers, timeoutMs);
    } catch (second) {
      const sizeMb = (bodyBuf.length / 1048576).toFixed(2);
      const hint = /ECONNRESET/i.test(String(second?.message ?? second))
        ? `（重试后仍被重置；本次请求体 ${sizeMb} MB —— 图片越大越容易被协议端断开，详见下方说明）`
        : '';
      throw new Error(`${second?.message ?? second}${hint}`);
    }
  }
}

class OneBotCallError extends Error {
  constructor(message, { statusCode = 0, retcode = null, fallbackSafe = false } = {}) {
    super(message);
    this.name = 'OneBotCallError';
    this.statusCode = statusCode;
    this.retcode = retcode;
    this.fallbackSafe = fallbackSafe;
  }
}

/** SnowLuma / OneBot 的错误字段不完全统一：把 message/msg/wording/error 合并成人能看懂的一句话。 */
export function onebotErrorDetail(body) {
  const candidates = [
    body?.message,
    body?.msg,
    body?.wording,
    body?.error,
    body?.data?.message,
    body?.data?.msg,
    body?.data?.wording
  ];
  const detail = [...new Set(candidates
    .map((v) => String(v ?? '').trim())
    .filter(Boolean))].join(' / ');
  return detail || '未知错误';
}

/** SnowLuma v1.14.19：get_forward_msg 的 id / message_id 都必须是字符串。 */
export function normalizeGetForwardParams(value) {
  const id = value == null ? '' : String(value).trim();
  return id || null;
}

/** SnowLuma v1.14.19：get_msg.message_id 必须是非零整数，负数也合法。 */
export function normalizeGetMsgParams(value) {
  const raw = value == null ? '' : String(value).trim();
  if (!/^-?\d+$/.test(raw)) throw new Error('message_id 必须是非零整数（可以为负数）');
  const message_id = Number(raw);
  if (!Number.isSafeInteger(message_id) || message_id === 0) {
    throw new Error('message_id 必须是非零整数（可以为负数）');
  }
  return { message_id };
}

/** v1.14.19 的统一发送接口优先，专用接口只在“接口不存在”时回退，避免失败后重复发送。 */
export function buildForwardSendCalls(kind, targetId, messages) {
  const target = Number(targetId);
  if (!Number.isSafeInteger(target) || target <= 0) throw new Error('合并转发目标必须是正整数 QQ 号/群号');
  const route = kind === 'private'
    ? { message_type: 'private', user_id: target }
    : { message_type: 'group', group_id: target };
  return [
    { action: 'send_forward_msg', params: { ...route, messages } },
    {
      action: kind === 'private' ? 'send_private_forward_msg' : 'send_group_forward_msg',
      params: { ...(kind === 'private' ? { user_id: target } : { group_id: target }), messages }
    }
  ];
}

const RECONNECT_MIN_MS = 3000;
const RECONNECT_MAX_MS = 30000;

export class OneBotClient {
  constructor({ wsUrl, httpUrl, accessToken, httpToken, onEvent }) {
    this.wsUrl = String(wsUrl || 'ws://127.0.0.1:3001');
    this.httpUrl = String(httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.accessToken = String(accessToken || '');
    // SnowLuma 允许给 WS 与 HTTP 配不同令牌；httpToken 缺省沿用 accessToken
    this.httpToken = String(httpToken || accessToken || '');
    this.onEvent = onEvent || (() => {});
    this.socket = null;
    this.connected = false;
    this.everConnected = false;
    this.lastConnectError = '';
    this.selfInfo = null;      // { user_id, nickname }
    this.#closedByUs = false;
    this.statusListeners = new Set();
  }

  #closedByUs;

  onStatus(fn) {
    this.statusListeners.add(fn);
    return () => this.statusListeners.delete(fn);
  }

  #setStatus(connected) {
    this.connected = connected;
    if (connected) this.everConnected = true;
    for (const fn of this.statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch { /* ignore */ }
    }
  }

  async connect() {
    this.#closedByUs = false;
    this.#connectLoop();
  }

  /** 连接配置可能变了（比如从 SnowLuma 配置同步到了新令牌），重连一次。 */
  async reconnect() {
    // 关键：先作废旧 socket，再启新连接。否则旧 socket 的 close 事件稍后到达时
    // 会误以为需要再次重连，造成两个 WebSocket 同时连着 SnowLuma，所有事件收到两份。
    const old = this.socket;
    this.socket = null;
    this.#closedByUs = false;
    try { old?.close(); } catch { /* ignore */ }
    this.#connectLoop();
  }

  #connectLoop() {
    if (this.#closedByUs) return;
    let url = this.wsUrl;
    if (this.accessToken) url += (url.includes('?') ? '&' : '?') + `access_token=${encodeURIComponent(this.accessToken)}`;
    let socket;
    try {
      socket = new WebSocket(url, {
        headers: this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}
      });
    } catch (error) {
      this.lastConnectError = String(error?.message ?? error);
      this.#setStatus(false);
      setTimeout(() => this.#connectLoop(), RECONNECT_MIN_MS);
      return;
    }
    this.socket = socket;
    // 每个 socket 的事件处理器都先验证“我还是不是当前 socket”，
    // 旧连接被作废后其迟到事件直接忽略，避免重复重连/状态错乱。
    const isCurrent = (s) => this.socket === s;

    socket.on('open', async () => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = '';
      this.#setStatus(true);
      try {
        this.selfInfo = await this.call('get_login_info');
      } catch (error) {
        console.error('[onebot] 获取登录信息失败:', error?.message ?? error);
      }
    });
    socket.on('message', (data) => {
      if (!isCurrent(socket)) return;
      let event = null;
      try { event = JSON.parse(String(data)); } catch { return; }
      if (!event || typeof event !== 'object') return;
      try { this.onEvent(event); } catch (error) { console.error('[onebot] 事件处理出错:', error); }
    });
    socket.on('close', () => {
      if (!isCurrent(socket)) return; // 旧连接的迟到 close：新连接已在处理
      this.#setStatus(false);
      if (!this.#closedByUs) setTimeout(() => this.#connectLoop(), RECONNECT_MIN_MS);
    });
    socket.on('error', (error) => {
      if (!isCurrent(socket)) return;
      this.lastConnectError = String(error?.message ?? error);
      if (!this.everConnected) {
        // 首连失败退避得久一点，避免刷屏
        this.#setStatus(false);
      }
    });
  }

  close() {
    this.#closedByUs = true;
    const old = this.socket;
    this.socket = null;
    try { old?.close(); } catch { /* ignore */ }
    this.#setStatus(false);
  }

  /** OneBot HTTP API（发送与查询都走这里）。直连，不经系统代理。 */
  async call(action, params = {}, timeoutMs = 15000) {
    const url = `${this.httpUrl}/${action}`;
    const payload = Buffer.from(JSON.stringify(params), 'utf8');
    const headers = {
      'content-type': 'application/json',
      ...(this.httpToken ? { authorization: `Bearer ${this.httpToken}` } : {})
    };
    // 大图 base64 可能很大：给图片类调用更长超时
    const t = /image|send_.*msg/.test(action) ? Math.max(timeoutMs, 30000) : timeoutMs;
    // 连接类错误自动重试一次（见 onebotPostWithRetry 的说明）
    const res = await onebotPostWithRetry(url, payload, headers, t);
    let body = {};
    try { body = JSON.parse(res.body || '{}'); } catch {
      body = res.body?.trim() ? { message: res.body.trim() } : {};
    }
    if (res.statusCode < 200 || res.statusCode >= 300) {
      const hint = res.statusCode === 426
        ? '（HTTP 426：httpUrl 可能指向了 WebSocket 端口，请检查 snowluma.httpUrl 是否为 OneBot HTTP API 地址）'
        : '';
      const detail = onebotErrorDetail(body);
      throw new OneBotCallError(
        `OneBot ${action} HTTP ${res.statusCode}: ${detail}${hint}`,
        {
          statusCode: res.statusCode,
          retcode: body?.retcode ?? null,
          fallbackSafe: res.statusCode === 404 || /unknown|not found|unsupported|不存在|未知/i.test(detail)
        }
      );
    }
    const retcode = body?.retcode == null ? 0 : Number(body.retcode);
    const failed = (Number.isFinite(retcode) && retcode !== 0) || (body.status && body.status !== 'ok');
    if (failed) {
      const detail = onebotErrorDetail(body);
      throw new OneBotCallError(
        `OneBot ${action} 失败: retcode=${body.retcode ?? body.status} ${detail}`,
        {
          retcode: body?.retcode ?? body?.status ?? null,
          fallbackSafe: retcode === 100 || /unknown|not found|unsupported|不存在|未知/i.test(detail)
        }
      );
    }
    return body.data;
  }

  get selfId() {
    return this.selfInfo?.user_id != null ? String(this.selfInfo.user_id) : '';
  }

  get selfNickname() {
    return this.selfInfo?.nickname ? String(this.selfInfo.nickname) : '';
  }

  /** 发送消息段。返回 OneBot 响应 data（含 message_id）。 */
  async sendSegments(kind, id, segments) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params);
  }

  /**
   * 发送合并转发（把多条消息打成一条转发记录）。
   * @param {'group'|'private'} kind
   * @param {string|number} id 群号 / QQ 号
   * @param {Array<{name?:string,uin?:string|number,content:string}>} nodes
   * @param {{ replyToMessageId?: any }} opts
   */
  async sendForward(kind, id, nodes, { replyToMessageId = null } = {}) {
    const list = (Array.isArray(nodes) ? nodes : []).filter((n) => n && String(n.content ?? '').trim());
    if (!list.length) throw new Error('合并转发内容为空');
    if (list.length > 40) throw new Error('合并转发最多 40 条节点');
    const messages = list.map((n) => ({
      type: 'node',
      data: {
        name: String(n.name || n.senderName || '消息记录').slice(0, 20),
        uin: String(n.uin || n.senderId || this.selfId || '0'),
        content: String(n.content ?? '')
      }
    }));
    // 部分实现支持在 forward 消息前挂 reply；不支持时忽略
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      // 标准 send_*_forward_msg 通常不带 reply；留接口以后扩展
    }
    const calls = buildForwardSendCalls(kind, id, messages);
    try {
      return await this.call(calls[0].action, calls[0].params, 20000);
    } catch (error) {
      // 只有“新接口不存在/不支持”才回退旧接口。参数错误、网络错误等不能回退，
      // 否则第一条可能已经发出去了，却因响应异常再发一次。
      if (!error?.fallbackSafe) throw error;
      return this.call(calls[1].action, calls[1].params, 20000);
    }
  }

  async sendText(kind, id, text, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      // 私聊没有"@"这回事。模型还常把"消息 id"当 QQ 号塞进来（实测 1000000001 是唤醒条前的
      // #数字），拼成 at 段只会让这条消息被 QQ 拒发 —— 私聊里直接忽略。
      if (kind === 'group') segments.push({ type: 'at', data: { qq: at } });
    }
    segments.push({ type: 'text', data: { text: escapeCqText(String(text ?? '')) } });
    return this.sendSegments(kind, id, segments);
  }

  /**
   * 发一条图片消息。
   * file 可以是 `base64://…`（推荐：字节由本进程下载并校验过）或 URL/本地路径。
   *
   * SnowLuma v1.14.19 的 image 段原生支持 sub_type / summary；sub_type=1 会让 QQ
   * 按动画表情展示，而不是把收藏表情当成普通大图。width / height 是兼容字段，
   * 当前 SnowLuma 会按图片真实像素补全，后续协议端支持显示尺寸时也能直接生效。
   */
  async sendImage(kind, id, file, {
    replyToMessageId = null,
    atUserId = null,
    subType = null,
    summary = '',
    width = null,
    height = null
  } = {}) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      // 同 sendText：私聊不拼 at 段（模型常把消息 id 当成 QQ 号传进来，会导致整条发送失败）
      if (kind === 'group') segments.push({ type: 'at', data: { qq: at } });
    }
    const imageData = { file: String(file) };
    if (subType !== undefined && subType !== null && String(subType).trim() !== '') {
      const value = Number(subType);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('subType 必须是非负整数');
      imageData.sub_type = value;
    }
    if (summary !== undefined && summary !== null && String(summary) !== '') {
      imageData.summary = String(summary);
    }
    for (const [key, value] of [['width', width], ['height', height]]) {
      if (value === undefined || value === null || String(value).trim() === '') continue;
      const size = Number(value);
      if (!Number.isSafeInteger(size) || size <= 0) throw new Error(`${key} 必须是正整数`);
      imageData[key] = size;
    }
    segments.push({ type: 'image', data: imageData });
    return this.sendSegments(kind, id, segments);
  }

  /**
   * 发送表情包。它仍使用 SnowLuma 原生 image 段，但明确标记为动画表情，
   * 并附带 300×300 显示尺寸建议；普通 sendImage 不会带这些表情元数据。
   */
  async sendSticker(kind, id, file, options = {}) {
    return this.sendImage(kind, id, file, {
      ...options,
      subType: 1,
      summary: '[动画表情]',
      width: 300,
      height: 300
    });
  }

  /**
   * 发网易云音乐。
   * 用 OneBot 标准 music 段：SnowLuma 负责调用签名服务转成可展示的 json 卡。
   * ⚠️ 不要事后改签名结果里的 ver/token —— 改了签名就废，QQ 会空白。
   * ⚠️ **不要和 reply（引用）同发**：引用 + 音乐/json 卡在部分 QQ/协议端会被整条吞掉。
   * 引用意图改用「文字说明」；本方法忽略 replyToMessageId。
   * 同时附带「歌名+链接」文字：卡片被吞时群里仍看得到。
   */
  async sendMusic(kind, id, music = {}) {
    const segments = [];
    // 刻意不拼 reply 段：引用会吞掉音乐卡
    if (kind === 'group' && music.atUserId != null && String(music.atUserId).trim()) {
      const at = String(music.atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号');
      segments.push({ type: 'at', data: { qq: at } });
    }

    const platform = String(music.platform || '163').toLowerCase();
    const songId = String(music.songId || music.id || '').trim().replace(/[^0-9]/g, '');
    const title = String(music.title || '').trim().slice(0, 80) || '音乐分享';
    const artist = String(music.artist || music.content || '').trim().slice(0, 40);
    let jumpUrl = String(music.url || '').trim();
    let audio = String(music.audio || '').trim();

    if (platform === '163' || (!music.url && songId)) {
      if (!songId && !jumpUrl) throw new Error('需要网易云 songId 或 url');
      if (!jumpUrl) jumpUrl = `https://music.163.com/#/song?id=${songId}`;
      if (!audio) audio = `https://music.163.com/song/media/outer/url?id=${songId || '0'}.mp3`;
    }

    // 文字链接：一定可见
    const textLine = artist ? `${title} - ${artist}` : title;
    segments.push({ type: 'text', data: { text: `🎵 ${textLine}\n${jumpUrl}` } });

    // 标准 music 段交给 SnowLuma 签名（不要再自拼/改签名 JSON）
    if (songId || (music.url && music.audio)) {
      const musicData = songId && platform !== 'custom'
        ? {
          type: platform === 'qq' ? 'qq' : '163',
          id: songId,
          // 以下字段 SnowLuma 签名路径主要用 id；title 留给失败回退
          title,
          content: artist
        }
        : {
          type: 'custom',
          url: jumpUrl,
          audio,
          title,
          content: artist,
          image: String(music.image || '')
        };
      segments.push({ type: 'music', data: musicData });
    }

    return this.sendSegments(kind, id, segments);
  }

  /**
   * 发 B 站视频分享卡片（json 段）。
   * 优先视频卡（com.tencent.video）；网页卡容易在部分 QQ 上显示「升级后使用」。
   */
  async sendBiliCard(kind, id, { url, title = '', desc = '', cover = '', replyToMessageId = null, style = 'video' } = {}) {
    const u = String(url || '').trim();
    if (!/^https?:\/\//i.test(u)) throw new Error('B站卡片需要视频链接');
    const coverHttps = String(cover || '').trim().replace(/^http:/i, 'https:');
    const t = String(title || 'B站视频').slice(0, 80);
    const d = String(desc || '').slice(0, 80);
    const prompt = `[分享]${t}`;

    // 视频卡：duration 给个非 0 值；部分端 duration=0 会显示「消息已过期」
    const videoJson = {
      app: 'com.tencent.video',
      desc: '视频',
      view: 'video',
      ver: '1.0.0.1',
      prompt,
      meta: {
        video: {
          duration: 60,
          preview: coverHttps,
          title: t,
          url: u,
          jumpUrl: u,
          desc: d || 'bilibili.com',
          source: '哔哩哔哩',
          source_icon: 'https://www.bilibili.com/favicon.ico'
        }
      }
    };

    // 网页卡（备用）
    const pageJson = {
      app: 'com.tencent.webpage',
      desc: '网页',
      jumpUrl: u,
      meta: {
        title: t,
        desc: d || 'bilibili',
        preview: coverHttps,
        source_icon: 'https://www.bilibili.com/favicon.ico',
        sourceName: '哔哩哔哩'
      },
      prompt,
      ver: '0.0.0.1',
      view: 'modelv2'
    };

    const payload = style === 'page' ? pageJson : videoJson;

    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (/^-?[1-9]\d*$/.test(rid)) segments.push({ type: 'reply', data: { id: rid } });
    }
    segments.push({ type: 'json', data: { data: JSON.stringify(payload) } });
    return this.sendSegments(kind, id, segments);
  }

  async sendPoke(kind, id, targetUserId) {
    if (kind === 'private') {
      return this.call('friend_poke', { user_id: Number(id) }).catch(() =>
        this.call('send_poke', { user_id: Number(id) }));
    }
    return this.call('group_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }).catch(() =>
      this.call('send_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }));
  }

  async getMsg(messageId) {
    return this.call('get_msg', normalizeGetMsgParams(messageId));
  }

  async getGroupList() {
    const r = await this.call('get_group_list');
    const list = Array.isArray(r) ? r : (Array.isArray(r?.data) ? r.data : []);
    return list.map((g) => ({
      id: String(g.group_id ?? g.id ?? ''),
      name: String(g.group_name ?? g.name ?? g.group_id ?? '')
    })).filter((g) => g.id);
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }
}

// ── 入站事件 → 文本（移植自原版 segmentsToText） ─────────────────────────

export function forwardIdFromData(d) {
  const raw = d?.id ?? d?.res_id ?? d?.forward_id ?? d?.data_id;
  if (raw == null || String(raw).trim() === '') return null;
  return String(raw);
}

/** 从消息或 forward 段收集可能的合并转发标识。QQ/SnowLuma 的字段并不统一。 */
export function forwardIdsFromMessage(message) {
  const out = [];
  const add = (raw) => {
    if (raw == null || String(raw).trim() === '') return;
    const value = String(raw);
    if (!out.includes(value)) out.push(value);
  };
  const segments = Array.isArray(message?.message) ? message.message
    : Array.isArray(message?.segments) ? message.segments
    : Array.isArray(message) ? message
    : [];
  for (const segment of segments) {
    if (segment?.type === 'forward') add(forwardIdFromData(segment?.data));
  }
  for (const key of ['forward_id', 'res_id', 'data_id']) add(message?.[key]);
  return out;
}

/**
 * 生成 get_forward_msg 的兼容尝试顺序。
 * SnowLuma 只正式接受 id，NapCat 系实现常只接受 message_id；QQ 的 message_id 还可能是负数。
 */
export function buildForwardCallAttempts({ messageId, segments = null, message = null } = {}) {
  const ids = forwardIdsFromMessage(message || segments || []);
  const original = messageId == null || String(messageId).trim() === '' ? null : String(messageId);
  if (original && !ids.includes(original)) ids.push(original);

  const attempts = [];
  const seen = new Set();
  const push = (params) => {
    const key = JSON.stringify(params);
    if (seen.has(key)) return;
    seen.add(key);
    attempts.push({ action: 'get_forward_msg', params });
  };
  for (const raw of ids) {
    const id = normalizeGetForwardParams(raw);
    if (!id) continue;
    // SnowLuma v1.14.19 两个字段都声明为 string；数字会被严格校验直接拒绝。
    push({ id });
    push({ message_id: id });
  }
  return attempts;
}

function forwardNodesFromResponse(response) {
  const candidates = [response, response?.data, response?.data?.data, response?.result];
  for (const value of candidates) {
    if (Array.isArray(value)) return value;
    for (const key of ['messages', 'nodes', 'forward_messages']) {
      if (Array.isArray(value?.[key])) return value[key];
    }
  }
  return [];
}

/**
 * 统一抓取合并转发节点。
 * 先用事件里的 forward 段 ID，再退回原 message_id；两种参数名都尝试。
 * 首轮为空时通过 get_msg 找回 forward 段，再重试一轮，兼容负 message_id。
 */
export async function fetchForwardNodes(onebot, {
  messageId,
  segments = null,
  message = null
} = {}) {
  const runAttempts = async (attempts) => {
    const errors = [];
    for (const attempt of attempts) {
      try {
        const response = await onebot.call(attempt.action, attempt.params);
        const nodes = forwardNodesFromResponse(response);
        if (nodes.length) return { nodes, errors };
        errors.push(`${JSON.stringify(attempt.params)}: payload is empty`);
      } catch (error) {
        errors.push(`${JSON.stringify(attempt.params)}: ${error?.message ?? error}`);
      }
    }
    return { nodes: [], errors };
  };

  const first = await runAttempts(buildForwardCallAttempts({ messageId, segments, message }));
  if (first.nodes.length) return { nodes: first.nodes, attempts: first.errors.length + 1, errors: first.errors };

  let recovered = null;
  try {
    recovered = typeof onebot.getMsg === 'function'
      ? await onebot.getMsg(messageId)
      : await onebot.call('get_msg', normalizeGetMsgParams(messageId));
  } catch { /* 原消息也找不回时保留首轮错误 */ }

  const retry = recovered
    ? await runAttempts(buildForwardCallAttempts({ messageId, segments: recovered?.message, message: recovered }))
    : { nodes: [], errors: [] };
  return {
    nodes: retry.nodes,
    attempts: first.errors.length + Math.max(1, retry.errors.length),
    errors: [...first.errors, ...retry.errors]
  };
}

/**
 * 从 OneBot json 卡段里抠可打开的链接（优先 B 站）。
 * data 可能是字符串 JSON，也可能是对象。
 */
export function extractShareCardJson(segData) {
  let obj = null;
  const raw = segData?.data ?? segData?.json ?? segData ?? '';
  try {
    obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    // 有时是 HTML 转义或嵌套字符串
    try { obj = JSON.parse(String(raw).replace(/&quot;/g, '"').replace(/&amp;/g, '&')); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;

  const pickUrl = () => {
    const cands = [
      obj?.jumpUrl,
      obj?.meta?.detail_1?.url,
      obj?.meta?.detail_1?.qqdocurl,
      obj?.meta?.detail_1?.preview,
      obj?.meta?.web?.url,
      obj?.meta?.web?.jumpUrl,
      obj?.meta?.detail_2?.url,
      obj?.url,
      obj?.prompt
    ];
    for (const c of cands) {
      const u = String(c || '').trim();
      if (/^https?:\/\/(www\.)?bilibili\.com\//i.test(u) || /^https?:\/\/b23\.tv\//i.test(u)) return u.replace(/[),。，]+$/, '');
      if (/^https?:\/\/(www\.)?bilibili\.com\/video\//i.test(u) || /BV[0-9A-Za-z]{10}/.test(u)) return u;
    }
    // 再扫整份 JSON
    const m = String(JSON.stringify(obj)).match(/https?:\/\/(?:www\.)?bilibili\.com\/video\/[A-Za-z0-9]+/);
    if (m) return m[0];
    const bv = String(JSON.stringify(obj)).match(/BV[0-9A-Za-z]{10}/);
    if (bv) return `https://www.bilibili.com/video/${bv[0]}`;
    // 非 B 站但有网页链接
    for (const c of [obj?.jumpUrl, obj?.meta?.web?.url, obj?.meta?.detail_1?.url]) {
      const u = String(c || '').trim();
      if (/^https?:\/\//i.test(u)) return u;
    }
    return null;
  };

  const url = pickUrl();
  if (!url) return null;
  const title = String(
    obj?.meta?.detail_1?.title
    || obj?.meta?.web?.title
    || obj?.meta?.title
    || obj?.prompt
    || ''
  ).replace(/^\[分享\]\s*/, '').slice(0, 80);
  const kind = /bilibili\.com|b23\.tv|BV[0-9A-Za-z]{10}/i.test(url + title) ? 'bili' : 'web';
  return { url, title, kind };
}

/**
 * 语音段 → 文字。走 speech-to-text 插件的能力 `media.transcribe`。
 *
 * 为什么做成"软依赖"：转写需要 whisper-cli + 模型文件，多数人没装。
 * 没装（能力不存在）/ 没配 / 转写失败 / 超时，都退回 `[语音]` 占位 —— 行为与从前一致。
 * 超时上限 25 秒（转写本身是本地小模型，太长会把收消息链路堵住）。
 */
async function transcribeRecordSegment(data, onebotClient) {
  try {
    const { skillManager } = await import('./skill-bridge.js');
    const provider = skillManager.getCapabilityProviders('media.transcribe', {})[0];
    if (!provider?.fn || !onebotClient?.call) return '[语音]';
    const record = { ...(data || {}) };
    const out = await Promise.race([
      Promise.resolve(provider.fn({ record, onebot: onebotClient })),
      new Promise((r) => { const t = setTimeout(() => r(null), 25000); t.unref?.(); })
    ]);
    const text = String(out?.text || '').trim();
    if (out?.ok !== false && text) return `[语音]${text}`;
  } catch { /* 转写失败不影响收消息 */ }
  return '[语音]';
}

/**
 * 把 OneBot 消息段数组转成 AI 可读的纯文本。
 * resolveReply: async (mid) => { sender, text } | null —— 解析引用原文。
 * resolveAtName: async (qq) => string | null —— 把 @ 的 QQ 号解析成群名片。
 */
export async function segmentsToText(segments, { resolveReply = null, resolveAtName = null, includeReply = true, onebot = null } = {}) {
  if (typeof segments === 'string') return sanitizeUserText(segments.trim());
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          const qq = String(d.qq ?? '').replace(/[^\d]/g, '');
          // 展示用名片 + 一律保留 CQ 号：触发/艾特判定靠 QQ，不靠会改的群名片
          out.push(name ? `@${name}` : (qq ? `@${qq}` : '@'));
          if (qq) out.push(`[CQ:at,qq=${qq}]`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      case 'image': out.push('[图片]'); break;
      // 语音：装了 speech-to-text 插件（提供 media.transcribe 能力）就把内容转成文字，
      // 模型才能真正"听懂"语音而不是只看到一个 [语音] 占位符。
      // 没装 / 没配 whisper / 识别失败 / 超时 → 原样退回 [语音]，绝不打断收消息。
      case 'record': out.push(await transcribeRecordSegment(d, onebot)); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            // 短编号放最前（`[引用 #318 A：原话]`）：模型要靠它引用**被引用的那条原话**，
            // 而不是带着这个引用块的那条消息（那正是"引用错"的一种来源）。
            const head = info?.ref ? `${info.ref} ` : '';
            const body = [info?.sender, info?.text].filter(Boolean).join('：');
            if (head || body) replyText = `[引用 ${head}${body}]`;
          } catch { /* 解析失败降级 */ }
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      case 'json': {
        // 抠 B 站分享卡里的链接/标题，模型才能 parse_video / send_bilibili
        const card = extractShareCardJson(d);
        if (card) {
          out.push(card.kind === 'bili' ? `[B站视频 ${card.title || '分享'}](${card.url})` : `[网页分享 ${card.title || ''}](${card.url})`);
        } else {
          out.push('[卡片消息]');
        }
        break;
      }
      case 'forward': {
        // 不带 res_id：那个 id 会过期（payload is empty），打出来只会误导模型拿它当参数。
        // 模型要看内容用 read_forward 工具 + 消息前的 #数字。
        out.push('[合并转发聊天记录]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return sanitizeUserText(out.join('').trim());
}

/** 从消息段提取媒体定位信息（不下载）。 */
export function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    if (seg.type === 'image') {
      media.push({ kind: 'image', file: String(d.file ?? ''), url: String(d.url ?? ''), summary: String(d.summary ?? '') });
    } else if (seg.type === 'face') {
      media.push({ kind: 'face', faceId: String(d.id ?? '') });
    }
  }
  return media;
}

/**
 * 展开合并转发节点为可读文本（纯函数，便于测试）。
 *
 * 背景：OneBot 事件里的 forward 段只有一个 res_id 占位符，
 * 需要 get_forward_msg 拿回节点数组（本函数处理的就是这个数组）。
 * 实测 NapCat：{ message_id } 可用；res_id 会过期（payload is empty），别依赖。
 *
 * 规则：
 *   - 每个节点一行「昵称: 内容」，内容复用 segmentsToText（@/图片/表情等占位一致）
 *   - 嵌套转发不再展开（深度 1 封顶，套娃截断）
 *   - 封顶：maxNodes 条 / maxChars 字符，超出注明"还有 N 条未展开"
 *   - 节点里的图片段同时提取到 media（url 新鲜，可用于取图/金句）
 *
 * @param {Array} nodes get_forward_msg 返回的 messages 数组
 * @returns {{ text: string, media: Array } | null} 无可用节点返回 null
 */
export async function expandForwardNodes(nodes, { maxNodes = 30, maxChars = 3000 } = {}) {
  if (!Array.isArray(nodes) || !nodes.length) return null;
  const lines = [];
  const media = [];
  let truncated = 0;

  for (let i = 0; i < nodes.length; i++) {
    if (lines.length >= maxNodes) { truncated = nodes.length - i; break; }
    const n = nodes[i] || {};
    const name = String(n.sender?.card || n.sender?.nickname || n.user_id || '?');
    const nm = n.message ?? n.content;
    let body = '';
    if (typeof nm === 'string') {
      // 字符串形态一般是 CQ 码原文，剥掉 [CQ:xxx] 段保留纯文本
      body = nm.replace(/\[CQ:[^\]]*\]/g, '').trim();
    } else if (Array.isArray(nm)) {
      // 嵌套 forward 段清空 data → segmentsToText 输出 [转发消息] 占位（深度 1 封顶）
      const segs = nm.map((s) => (s?.type === 'forward' ? { type: 'forward', data: {} } : s));
      body = await segmentsToText(segs, {});
      media.push(...extractMediaFromSegments(segs));
    }
    body = body.replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!body) continue;
    lines.push(`${name}: ${body}`);
    if (lines.join('\n').length > maxChars) { truncated = nodes.length - i - 1; break; }
  }

  const head = `[合并转发 共${nodes.length}条]`;
  if (!lines.length) return { text: head, media };
  const tail = truncated > 0 ? `\n…（还有 ${truncated} 条未展开）` : '';
  return { text: `${head}\n${lines.join('\n')}${tail}`, media };
}
