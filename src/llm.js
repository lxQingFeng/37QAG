// OpenAI 兼容 Chat Completions 客户端（非流式）。
// 支持工具调用、usage 统计、可自选模型 —— 这是与 DSH 解耦后的"大脑"接口。
import { getConfig } from './config.js';
import { resolveOfficialPrice, resolveModelPrice, priceAt } from './model-prices.js';
import { isHypeMode } from './hype-mode.js';
// 缓存用量字段的**唯一**读取口径（保温链也用它）。llm.js ← cache-keepalive.js 是单向依赖，
// 不会成环：cache-keepalive 只 import config.js。
import { readUsageNumbers } from './cache-keepalive.js';

function joinUrl(base, path) {
  const b = String(base ?? '').trim();
  if (!b || !/^https?:\/\//i.test(b)) {
    throw new Error(`模型 baseUrl 无效（当前「${b || '空'}」）。请在设置里重新保存模型/供应商。`);
  }
  return `${b.replace(/\/+$/, '')}${path}`;
}

function authHeaders(apiKey) {
  return apiKey ? { authorization: `Bearer ${apiKey}` } : {};
}

/**
 * 解析当前 api 配置里真正该用的 API Key。
 *
 * 优先级：**当前选中的目录提供商的 Key > 顶层 api.apiKey**。
 *
 * 注意顺序很重要：api.apiKey 是手动模式遗留字段，一旦用户在 UI 里选了某个
 * 目录提供商，就该用它对应的 Key。否则会出现「选了 openrouter，却拿着 a6api 的
 * Key 去请求 openrouter.ai」的情况 —— 表现为全部会话 401 Missing Authentication。
 *
 * 兼容历史数据：providers[].apiKey 也可能存有明文（老配置），也认。
 */
export function resolveApiKey(cfg) {
  const pid = String(cfg?.api?.provider ?? '').trim();
  if (pid) {
    const fromDsh = String(cfg?.dshProviderKeys?.[pid] ?? '').trim();
    if (fromDsh && fromDsh !== '******') return fromDsh;
    const p = (cfg?.providers || []).find((x) => x.id === pid);
    const legacy = String(p?.apiKey ?? '').trim();
    if (legacy && legacy !== '******') return legacy;
  }
  const direct = String(cfg?.api?.apiKey ?? '').trim();
  return direct === '******' ? '' : direct;
}

export function resolveOutputMaxTokens(raw) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : 4096;
}

/** 返回一个 key 已解析好的 api 配置（不影响配置本体）。 */
function effectiveApi() {
  const cfg = getConfig();
  return { ...cfg.api, apiKey: resolveApiKey(cfg) };
}

/** 在"当前生效的 api 配置"上临时覆盖几个字段（例如被截断时加大输出预算）。 */
export function apiWith(overrides = {}) {
  return { ...effectiveApi(), ...overrides };
}

// ── 阶段三·模型通道（本地/云端二选一）────────────────────────────────────────
// 设计：通道信息以 overrides 形式注入（复用 chatCompletion 现有的 overrides 机制，
// 对记忆整理等既有调用方零影响）。回退发生在 chatCompletionWithRetry 的重试循环里。

/** 读取本地端点配置（api.local），补全默认值。 */
export function localEndpointCfg() {
  const local = getConfig().api?.local || {};
  return {
    baseUrl: String(local.baseUrl || 'http://127.0.0.1:18080/v1').replace(/\/$/, ''),
    apiKey: String(local.apiKey || ''),
    model: String(local.model || '')
  };
}

/** 主通道（'cloud' | 'local'；'auto' 视云端配置解析为主云端）。 */
export function primaryChannel() {
  const ch = String(getConfig().api?.channel || 'cloud').trim().toLowerCase();
  if (ch === 'local') return 'local';
  if (ch === 'auto') {
    const a = effectiveApi();
    return a.baseUrl && a.apiKey ? 'cloud' : 'local';   // 云端没配全 → 本地为主
  }
  return 'cloud';
}

/** 允许本地→云端回退吗（channel=local 且 fallback 允许 且 云端已配置）。 */
export function canFallbackToCloud() {
  const fb = String(getConfig().api?.fallback || 'local-to-cloud');
  if (fb === 'none') return false;
  const a = effectiveApi();
  return !!(a.baseUrl && a.apiKey);
}

/** 允许云端→本地回退吗（channel=cloud/auto）。 */
export function canFallbackToLocal() {
  const local = localEndpointCfg();
  return !!local.baseUrl;    // 端点配了就允许试（连通与否由请求本身暴露）
}

/** 生成某通道的 overrides（cloud 通道 = null，走默认 api）。 */
export function channelOverrides(mode) {
  if (mode === 'local') {
    const local = localEndpointCfg();
    return { baseUrl: local.baseUrl, apiKey: local.apiKey || undefined, model: local.model || undefined };
  }
  return null;
}

// 本地端点模型名探测缓存（30s 内不重复探测）
let _localModelCache = { at: 0, model: '' };

/**
 * 探测本地端点可用性 + 模型名（GET /models，1.5s 超时）。
 * 返回 { ok, model, error? }。缓存 30 秒。
 */
export async function probeLocalEndpoint({ force = false } = {}) {
  const now = Date.now();
  if (!force && _localModelCache.model && now - _localModelCache.at < 30_000) {
    return { ok: true, model: _localModelCache.model, cached: true };
  }
  const local = localEndpointCfg();
  if (!local.baseUrl) return { ok: false, error: 'no-base-url' };
  try {
    const res = await fetch(`${local.baseUrl.replace(/\/$/, '')}/models`, {
      signal: AbortSignal.timeout(1500),
      headers: local.apiKey ? { authorization: `Bearer ${local.apiKey}` } : {}
    });
    if (!res.ok) return { ok: false, error: `http-${res.status}` };
    const data = await res.json().catch(() => null);
    const model = String(data?.data?.[0]?.id || '') || '';
    if (model) _localModelCache = { at: now, model };
    return { ok: true, model };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

/**
 * 判断一个错误是否值得重试。
 *
 * 可重试（多半是暂时性的，再试一次可能就好）：
 *   - 网络层失败 / 超时 / 连接被重置
 *   - HTTP 5xx（服务端出问题）
 *   - HTTP 429（限流，等一会儿再来）
 *   - 响应解析失败（偶发的空响应/截断）
 *
 * 不重试（重试也不会变好，只会浪费额度）：
 *   - HTTP 4xx：401 密钥错、400 请求体错、403 无权限、404 模型不存在
 *   - 主动中止（abort）
 */
export function isRetryableError(error) {
  const msg = String(error?.message ?? error ?? '');

  // 主动中止（用户/系统取消）：重试没有意义
  if (/aborted|中止|已取消|cancel/i.test(msg)) return false;

  // 明确的客户端错误：重试也不会变好，只会白烧额度
  if (/HTTP\s*(401|400|403|404|405|409|413|422)/i.test(msg)) return false;
  if (/unauthorized|forbidden|invalid api.?key|incorrect api.?key/i.test(msg)) return false;

  // 明确的暂时性故障
  if (/HTTP\s*5\d\d/i.test(msg)) return true;                        // 5xx
  if (/429|rate.?limit|限流|too many requests|quota/i.test(msg)) return true;
  if (/超时|timeout|timed out/i.test(msg)) return true;

  // 网络层：错误码太多列不全（bad port、EHOSTUNREACH、证书、DNS…），
  // 凡是带 "模型请求失败" 前缀的都是 fetch 抛的，统一视为可重试
  if (/模型请求失败/.test(msg)) return true;
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ECONNABORTED|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|socket hang up|fetch failed|network/i.test(msg)) return true;

  // 响应解析失败（偶发空响应/截断）
  if (/无法解析的 JSON|Unexpected end|unexpected token|JSON/i.test(msg)) return true;

  // 兜底：模型 API 类错误默认不重试（避免未知错误疯狂重试）
  return false;
}

/**
 * 带重试的单次对话请求。
 *
 * 只在**可重试**的错误上重试（网络抖动、5xx、429），
 * 4xx（密钥错、参数错）直接抛出 —— 重试不会让它变好。
 * 退避策略：1s → 2s（指数退避，避免雪崩）。
 *
 * 注意：这里重试的是**同一轮**请求，messages 不变，所以是幂等的，
 * 不会造成重复发言。会话级的整体重试在 orchestrator 里做。
 *
 * @param {object} args 同 chatCompletion
 * @param {number} [retries=2] 最多额外重试几次（默认 2，即总共最多 3 次尝试）
 */
export async function chatCompletionWithRetry(args, retries = 2) {
  const { emit: emitLifecycle } = await import('./event-bus.js');
  // ── 阶段三·通道回退状态 ──
  // channel='cloud'（默认）时 fallbackUsed 恒为 true → 行为与 0.5 完全一致。
  // channel='local'/'auto' 时失败一次换另一通道再试（只换一次，不反复横跳）。
  let mode = primaryChannel();
  // 本地端点没填模型名 → 探测一次（GET /models，1.5s 超时，30s 缓存）。
  // 探测失败不阻塞：留空交给服务端默认行为（llama-server 单模型时多数容忍空 model）。
  if (mode === 'local' && !localEndpointCfg().model) {
    try {
      const probe = await probeLocalEndpoint();
      if (probe?.ok && probe.model) _localModelCache.model = probe.model;
    } catch { /* ignore */ }
  }
  let fallbackUsed = mode === 'cloud';
  let lastError = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    // ── 账号池（account-pool 插件的能力）──
    // 有插件提供 llm.endpoint-pick 时，每次尝试前问它"这轮用哪个端点"（多账号轮询/
    // 限流分摊/按延迟挑），并在成功/失败后回报延迟与错误，让它更新统计。
    // 没装这个插件 → 两个调用都返回 undefined，行为与从前完全一致。
    const pick = await pickPoolEndpoint(args?.poolKey || '');
    // 通道 overrides（cloud=null 走默认 api；local=api.local 端点）
    const chOver = channelOverrides(mode);
    const overrides = { ...(chOver || {}), ...(args?.overrides || {}), ...(pick || {}) };
    const started = Date.now();
    if (attempt === 0) {
      try {
        emitLifecycle('llm.request.before', {
          messageCount: Array.isArray(args?.messages) ? args.messages.length : 0,
          toolsCount: Array.isArray(args?.tools) ? args.tools.length : 0,
          retries,
          channel: mode
        });
      } catch { /* ignore */ }
    }
    try {
      const res = await chatCompletion(Object.keys(overrides).length ? { ...args, overrides } : args);
      reportPoolEndpoint(pick, { ok: true, ms: Date.now() - started });
      try {
        emitLifecycle('llm.request.after', {
          attempt, ok: true, durationMs: Date.now() - started,
          model: res?.model || effectiveApi()?.model || '',
          messageCount: Array.isArray(args?.messages) ? args.messages.length : 0,
          toolsCount: Array.isArray(args?.tools) ? args.tools.length : 0,
          usage: res?.usage ? { prompt: res.usage.prompt_tokens, completion: res.usage.completion_tokens } : null
        });
      } catch { /* 观察者不得影响主链路 */ }
      return res;
    } catch (error) {
      lastError = error;
      reportPoolEndpoint(pick, {
        ok: false,
        ms: Date.now() - started,
        error: String(error?.message ?? error),
        status: Number(error?.status ?? error?.statusCode) || 0
      });
      // ── 阶段三·通道回退：失败后换另一通道再试（一次性）──
      if (!fallbackUsed) {
        const other = mode === 'local' ? 'cloud' : 'local';
        const allowed = other === 'cloud' ? canFallbackToCloud() : canFallbackToLocal();
        if (allowed) {
          fallbackUsed = true;
          mode = other;
          reportPoolEndpoint(pick, { ok: false, ms: Date.now() - started, error: `通道回退 → ${other}`, status: 0 });
          continue;    // 不消耗 attempt 预算：换通道重试不等同于同通道重试
        }
      }
      if (attempt >= retries || !isRetryableError(error)) {
        try {
          emitLifecycle('llm.request.after', {
            attempt, ok: false, durationMs: Date.now() - started,
            messageCount: Array.isArray(args?.messages) ? args.messages.length : 0,
            toolsCount: Array.isArray(args?.tools) ? args.tools.length : 0,
            error: String(error?.message ?? error),
            channel: mode
          });
        } catch { /* ignore */ }
        throw error;
      }
      const wait = 1000 * Math.pow(2, attempt);   // 1s, 2s
      console.warn(`[llm] 请求失败（第 ${attempt + 1} 次尝试），${wait}ms 后重试：${error?.message ?? error}`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  throw lastError;
}

/** 问账号池要一个端点（没装插件 / 没开 / 池子空 → undefined）。 */
async function pickPoolEndpoint(key) {
  try {
    const { skillManager } = await import('./skill-bridge.js');
    for (const p of skillManager.getCapabilityProviders('llm.endpoint-pick', {})) {
      const r = p.fn({ key });
      if (r && (r.baseUrl || r.apiKey)) return r;
    }
  } catch { /* 插件坏了不影响主链路 */ }
  return undefined;
}

/** 回报本轮结果（延迟/错误），供账号池调权重。永不抛错。 */
function reportPoolEndpoint(pick, result) {
  if (!pick) return;
  import('./skill-bridge.js').then(({ skillManager }) => {
    for (const p of skillManager.getCapabilityProviders('llm.endpoint-feedback', {})) {
      try {
        // 字段名对齐 account-pool 的签名：{ accountId, ok, latencyMs, error, status }
        p.fn({ accountId: pick.id || pick.accountId || '', ok: !!result.ok, latencyMs: Number(result.ms) || 0, error: result.error || '', status: Number(result.status) || 0 });
      } catch { /* ignore */ }
    }
  }).catch(() => { /* ignore */ });
}

/**
 * 是否阿里云百炼（DashScope）端点 —— 认 enable_thinking / thinking_budget /
 * cache_control（显式缓存）。其它端点按域名另配参数，见 thinkingStyleFor。
 */
function isDashScopeEndpoint(baseUrl) {
  try { return /(^|\.)aliyuncs\.com$/i.test(new URL(String(baseUrl || '')).hostname); } catch { return false; }
}
export { isDashScopeEndpoint };

/** 取 baseUrl 的 hostname（失败返回 ''）。 */
export function hostOf(baseUrl) {
  try { return new URL(String(baseUrl || '')).hostname.toLowerCase(); } catch { return ''; }
}

/**
 * 思考控制参数风格（常见国内 OpenAI 兼容端点）。
 * 返回：
 *   dashscope  — enable_thinking / thinking_budget（阿里百炼）
 *   ark        — thinking:{type:disabled|enabled,budget_tokens}（火山方舟 / 豆包）
 *   zhipu      — 同上（智谱 GLM-4.5+）
 *   moonshot   — thinking:{type:...}（Kimi k2.6；k3/k2.7 不认 disabled 时 400 回退）
 *   deepseek   — thinking:{type:disabled} + reasoning_effort（2026 官方 OpenAI 格式）
 *   siliconflow— chat_template_kwargs.enable_thinking（硅基流动）
 *   generic    — 尝试 enable_thinking:false（未知端点；400 会自动去掉重试）
 *   none       — 不发思考相关字段（OpenAI 官方 / 本地 LM Studio 等）
 */
export function thinkingStyleFor(baseUrl) {
  const h = hostOf(baseUrl);
  if (!h) return 'none';
  if (isDashScopeEndpoint(baseUrl)) return 'dashscope';
  if (/(^|\.)volces\.com$|volcengine|ark\.cn-beijing/i.test(h)) return 'ark';
  if (/(^|\.)bigmodel\.cn$|zhipuai|zhipu/i.test(h)) return 'zhipu';
  if (/moonshot|(^|\.)kimi/i.test(h)) return 'moonshot';
  if (/(^|\.)siliconflow\.(cn|com)$/i.test(h)) return 'siliconflow';
  if (/minimax|minimaxi/i.test(h)) return 'generic';
  // DeepSeek 官方：OpenAI 格式 thinking.type + reasoning_effort（非 token 预算）
  if (/(^|\.)deepseek\.com$/i.test(h)) return 'deepseek';
  if (/(^|\.)openai\.com$|localhost|127\.0\.0\.1|\[::1\]/i.test(h)) return 'none';
  if (/baidubce|qianfan|baidu/i.test(h)) return 'generic';
  // 中转站 / 未知域名：关思考时试一把 enable_thinking，400 自动回退
  return 'generic';
}

/**
 * 是否给消息块打 cache_control（显式缓存标记）。
 * 只有认 Anthropic 风格 cache_control 的端点才打；自动前缀缓存端点
 * （DeepSeek / Kimi / 智谱 / 硅基 / OpenAI）打标记反而可能 400，
 * 靠「三段式稳定 system 前缀 + 保温」就够了。
 *
 * ⚠️ 2026-09-22 修正（对着各家官方文档核过一遍）：
 *   · 智谱 GLM / Z.AI：官方明确写「隐式缓存，无需任何配置」→ 以前这里返回 true，
 *     等于每次都往 bigmodel.cn 发一个它不认的字段，靠 400 兜底才发现（还会污染被记住的工具引用）。
 *   · 火山方舟 Ark：文档没有 cache_control，按"不认"处理（以前是"打上试试"）。
 *   · OpenRouter：它自己会透传 cache_control，但它更关键的是 **sticky routing**
 *     （不给 session_id / prompt_cache_key 时按首条 system + 首条非 system 哈希分会话，
 *      首条非 system 每轮都变 → 分会话键一直变 → 可能换 provider → 必冷）。
 *     所以这里仍然算"支持"，但必须配合 sendCacheAffinity() 发 affinity 字段。
 */
export function supportsCacheMarkers(baseUrl) {
  if (isDashScopeEndpoint(baseUrl)) return true;
  const h = hostOf(baseUrl);
  if (!h) return false;
  if (/(^|\.)openai\.com$|localhost|127\.0\.0\.1|\[::1\]/i.test(h)) return false;
  // 自动前缀/KV 缓存阵营：不需要也不常认标记
  if (/(^|\.)deepseek\.com$|moonshot|(^|\.)kimi|siliconflow|minimax/i.test(h)) return false;
  // 智谱（bigmodel.cn / z.ai）：纯自动隐式缓存
  if (/bigmodel\.cn|(^|\.)z\.ai$|zhipu/i.test(h)) return false;
  // 火山方舟：文档未提供 cache_control
  if (/volces\.com|volcengine|ark\.cn-/i.test(h)) return false;
  // OpenRouter 及未知中转：认（OpenRouter 会透传；中转大都不至于因此 400，真 400 会剥）
  return true;
}

/**
 * 已知的「自动前缀缓存」端点：不能用 cache_control 打标记，但它们**确实有缓存**
 * （命中打折、5 分钟~1 小时 TTL、停一会儿就冷），所以保温链对它们同样有意义。
 * 2026-09-22 从 supportsCacheMarkers 里拆出来，供"要不要保温"单独判断。
 */
export function isAutoCacheEndpoint(baseUrl) {
  const h = hostOf(baseUrl);
  if (!h) return false;
  return /(^|\.)deepseek\.com$|moonshot|(^|\.)kimi|siliconflow|minimax|bigmodel\.cn|(^|\.)z\.ai$|zhipu|(^|\.)openai\.com$|volces\.com|volcengine/i.test(h);
}

/**
 * 该端点要不要在 body 里带"会话粘性"字段（OpenRouter 的 sticky routing 需要它）。
 * 不带的后果：命中的缓存块分散在不同 provider 上，下一轮路由过去就冷了。
 */
export function cacheAffinityField(baseUrl, api) {
  const h = hostOf(baseUrl);
  if (!h) return {};
  if (/openrouter\.ai$/i.test(h)) {
    const key = String(api?.chatKey || api?.affinityKey || '').trim();
    return { session_id: key || 'qq-agent', prompt_cache_key: key || 'qq-agent' };
  }
  return {};
}

/** 按风格拼思考相关 body 字段。off=关思考；budget=开思考时的长度上限。 */
function thinkingFields(style, { off, budget }) {
  const b = Number(budget) > 0 ? Math.max(1, Math.min(32768, Math.round(Number(budget)))) : 0;
  if (off) {
    switch (style) {
      case 'dashscope': return { enable_thinking: false };
      case 'ark':
      case 'zhipu':
      case 'moonshot':
      case 'deepseek': return { thinking: { type: 'disabled' } };
      case 'siliconflow': return { chat_template_kwargs: { enable_thinking: false } };
      case 'generic': return { enable_thinking: false };
      default: return {};
    }
  }
  if (!b) return {};
  switch (style) {
    case 'dashscope': return { thinking_budget: b };
    case 'ark':
    case 'zhipu':
    case 'moonshot': return { thinking: { type: 'enabled', budget_tokens: b } };
    // DeepSeek 用 reasoning_effort（low/high/max），不是 token 预算；
    // 预算映射到 effort：小预算→low，大预算→high（max 需显式要求，不默认发）
    case 'deepseek': return { reasoning_effort: b <= 128 ? 'low' : 'high' };
    default: return {};   // 未知端点不乱发预算（易 400）
  }
}

/** body 里是否带着思考相关字段（用于 400 回退判断）。 */
function bodyHasThinkingFields(body) {
  if (!body || typeof body !== 'object') return false;
  for (const k of ['enable_thinking', 'disable_thinking', 'thinking_budget', 'thinking', 'chat_template_kwargs']) {
    if (k in body) return true;
  }
  return false;
}

function stripThinkingFields(body) {
  const next = { ...body };
  for (const k of ['enable_thinking', 'disable_thinking', 'thinking_budget', 'thinking', 'chat_template_kwargs']) {
    delete next[k];
  }
  return next;
}

/** 去掉 messages 里的 cache_control 标记（端点不认时回退用）。 */

/**
 * 去掉 tools 上的 cache_control（400 兜底：有些端点只对 tools 字段报错）。
 *
 * ⚠️ 2026-09-22：以前是**原地** delete —— 而 cacheKeeper.remember() 存的是同一个数组的引用，
 *   所以一次 400 回退之后，"记住的前缀"里 tools 已经被悄悄改过，与真实发出的请求永久不一致
 *   （保温调用复用它就再也命不中）。现在改成返回**副本**，不动调用方手里那份。
 */
export function stripToolsCacheControl(tools) {
  if (!Array.isArray(tools)) return tools;
  return tools.map((t) => {
    if (!t || typeof t !== 'object') return t;
    const { cache_control: _drop, ...rest } = t;
    if (rest.function && typeof rest.function === 'object' && 'cache_control' in rest.function) {
      const { cache_control: _dropFn, ...fnRest } = rest.function;
      return { ...rest, function: fnRest };
    }
    return rest;
  });
}

export function stripCacheMarkers(messages) {
  if (!Array.isArray(messages)) return messages;
  return messages.map((m) => {
    if (!m || !Array.isArray(m.content)) return m;
    let touched = false;
    const content = m.content.map((part) => {
      if (part && typeof part === 'object' && 'cache_control' in part) {
        const { cache_control, ...rest } = part;
        touched = true;
        return rest;
      }
      return part;
    });
    if (!touched) return m;
    // 单块纯文本可退回 string，保持和非显式缓存路径一致
    if (content.length === 1 && content[0]?.type === 'text' && typeof content[0].text === 'string') {
      return { ...m, content: content[0].text };
    }
    return { ...m, content };
  });
}

/**
 * 当前视觉接口能不能吃这种图片格式。
 *
 * 实测（2026-09-11 00:14）：本地 LM Studio 收到 data:image/webp 直接回
 * 400 "'url' field must be a base64 encoded image."，整轮运行报 error ——
 * 图没发出去、话也没说出来（用户看到的就是"图片发不出来了"）。
 * 百炼的 qwen-vl 支持 webp，所以只对非百炼端点降级。
 */
export function visionUnsupported(mime) {
  if (!/^image\/(webp|avif)$/i.test(String(mime || ''))) return false;
  try {
    return !isDashScopeEndpoint(getConfig().api?.baseUrl);
  } catch {
    return true;   // 判断不了就当不支持：宁可少看一张图，也不能把整轮打挂
  }
}

/** 接口是因为"图片格式/编码"拒绝的这次请求吗（LM Studio 实测 400 "'url' field must be a base64 encoded image."）。 */
export function isImageRejection(status, text) {
  if (![400, 415, 422].includes(Number(status))) return false;
  return /base64 encoded image|image_url|invalid image|unsupported (image|media)|must be a base64/i.test(String(text || ''));
}

/**
 * 把所有图片段换成一句文字说明，返回新 messages；没有图片则返回 null。
 * 用于"接口不认这种图"时的降级重试：宁可这轮看不见图，也不能整轮报错什么都不发。
 */
export function stripImageParts(messages) {
  let touched = false;
  const out = (messages || []).map((m) => {
    if (!Array.isArray(m?.content)) return m;
    const kept = [];
    let dropped = 0;
    for (const part of m.content) {
      if (part?.type === 'image_url') { dropped += 1; continue; }
      kept.push(part);
    }
    if (!dropped) return m;
    touched = true;
    kept.push({ type: 'text', text: `（有 ${dropped} 张图片无法传给当前模型：接口不支持这种图片格式，已省略）` });
    return { ...m, content: kept };
  });
  return touched ? out : null;
}

/**
 * 单次对话请求。messages 为 OpenAI 格式；tools 为 OpenAI function 格式（可为空）。
 * 返回 { message, usage, raw }；usage 形如 { prompt_tokens, completion_tokens, total_tokens }。
 * overrides: { baseUrl, apiKey, model, timeoutMs } 可选，用于记忆整理专用模型等场景。
 */
export async function chatCompletion({ messages, tools = null, toolChoice = 'auto', temperature = null, signal = null, overrides = null, affinityKey = '' }) {
  // ⚠️ overrides 必须叠在 effectiveApi 上，不能整份顶掉：
  // 否则 { disableThinking } 会丢掉 baseUrl/model/key → fetch "Invalid URL"
  const api = { ...effectiveApi(), ...(overrides || {}) };
  const body = {
    model: api.model,
    messages,
    stream: false
  };
  // 会话粘性（OpenRouter 的 sticky routing 靠它把同一会话钉在同一 provider 上，
  // 否则"首条非 system 消息每轮都变"→ 分会话键一直变 → 缓存永远冷）。其它端点忽略这两个字段。
  Object.assign(body, cacheAffinityField(api.baseUrl, { chatKey: affinityKey }));
  if (tools && tools.length > 0) {
    body.tools = tools;
    body.tool_choice = toolChoice;
  }
  // 思考模式：按端点风格下发（百炼 enable_thinking / 方舟·智谱·Kimi thinking.type /
  // 硅基流动 chat_template_kwargs / 未知端点试 enable_thinking，400 自动去掉重试）。
  //
  // ⚠️ 2026-09-11 实测（号A = qwen3.7-flash，真实会话盲评 12 局）：
  //   关思考输了 8 局：出现"不是""对"这种一个词的回复，还有约 1/3 把回复写成内心独白
  //   （正文不发送 → 群里静默），用户感受就是"这模型好蠢"。
  //   开思考质量明显更好，但不限长时要思考 300~3300 token、单次 8~37 秒，群聊等不了。
  //   折中：thinking_budget 限制思考长度 —— budget=128 实测 2.3s、budget=320 时 5.0s。
  // 优先级：亢奋强制关思考 > overrides.disableThinking > 全局 disableThinking
  let thinkOff = (overrides && Object.prototype.hasOwnProperty.call(overrides, 'disableThinking'))
    ? overrides.disableThinking === true
    : getConfig().api?.disableThinking === true;
  if (isHypeMode()) thinkOff = true;
  const thinkStyle = thinkingStyleFor(api.baseUrl);
  const thinkBudget = Number(api.thinkingBudget ?? getConfig().api?.thinkingBudget) || 0;
  Object.assign(body, thinkingFields(thinkStyle, { off: thinkOff, budget: thinkBudget }));
  const temp = temperature === null ? (api.temperature ?? 0.8) : temperature;
  if (temp !== null && temp !== undefined && Number.isFinite(Number(temp))) body.temperature = Number(temp);

  // 采样参数（治小模型的复读与啰嗦）：本地小模型/小上下文尤其需要
  //   - frequency_penalty：按出现次数惩罚重复 token（直接压复读）
  //   - presence_penalty：出现过就惩罚（鼓励换话题）
  //   - top_p / max_tokens：收窄采样面、掐掉长篇大论
  // 全部可选：配成 0 / 空就不发这些字段（保持各家端点的默认行为）。
  const extras = {
    top_p: api.topP,
    frequency_penalty: api.frequencyPenalty,
    presence_penalty: api.presencePenalty,
    max_tokens: resolveOutputMaxTokens(api.maxTokens)
  };
  for (const [key, raw] of Object.entries(extras)) {
    const n = Number(raw);
    if (raw === null || raw === undefined || raw === '' || !Number.isFinite(n) || n === 0) continue;
    body[key] = n;
  }

  const controller = new AbortController();
  const timeoutMs = Math.max(5000, Number(api.timeoutMs) || 90000);
  const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason ?? new Error('aborted'));
    else signal.addEventListener('abort', () => controller.abort(signal.reason ?? new Error('aborted')), { once: true });
  }

  let res;
  try {
  const send = async (payload) => {
    try {
      return await fetch(joinUrl(api.baseUrl, '/chat/completions'), {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(api.apiKey) },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (error) {
      if (error?.name === 'AbortError') throw new Error(`模型请求超时（${timeoutMs}ms）`);
      throw new Error(`模型请求失败：${error?.cause?.message ?? error?.message ?? error}`);
    }
  };

  res = await send(body);
  if (!res.ok) {
    let text = await res.text().catch(() => '');
    let payload = body;
    // ── 图片格式被接口拒绝时的降级 ──
    if (isImageRejection(res.status, text)) {
      const stripped = stripImageParts(body.messages);
      if (stripped) {
        console.warn(`[llm] 接口不接受请求里的图片（HTTP ${res.status}），已省略图片重试一次：${text.slice(0, 160)}`);
        payload = { ...payload, messages: stripped };
        res = await send(payload);
        if (!res.ok) text = await res.text().catch(() => '');
      }
    }
    // ── 400：可能是思考参数 / cache_control 不被认 —— 各剥一层再试一次 ──
    if (!res.ok && res.status === 400) {
      let degraded = false;
      let next = payload;
      if (bodyHasThinkingFields(next)) {
        next = stripThinkingFields(next);
        degraded = true;
      }
      if ((next.messages && JSON.stringify(next.messages).includes('cache_control')) || (next.tools && JSON.stringify(next.tools).includes('cache_control'))) {
        const cleanedMessages = stripCacheMarkers(next.messages);
        const cleanedTools = stripToolsCacheControl(next.tools);
        next = { ...next, messages: cleanedMessages, tools: cleanedTools };
        degraded = true;
      }
      if (degraded && next !== payload) {
        console.warn(`[llm] HTTP 400，已去掉思考/缓存标记重试：${text.slice(0, 200)}`);
        res = await send(next);
        if (!res.ok) text = await res.text().catch(() => '');
        payload = next;
      }
    }
    if (!res.ok) {
      throw new Error(`模型 API HTTP ${res.status}：${text.slice(0, 500)}`);
    }
  }
  const data = await res.json().catch(() => { throw new Error('模型 API 返回了无法解析的 JSON'); });
  const choice = data?.choices?.[0];
  if (!choice) throw new Error(`模型 API 响应缺少 choices：${JSON.stringify(data).slice(0, 300)}`);
  return {
    message: choice.message ?? {},
    finishReason: choice.finish_reason ?? null,
    usage: data.usage ?? null,
    model: data.model ?? api.model,
    raw: data
  };
  } finally {
    clearTimeout(timer);
  }
}

/** 获取模型列表（GET /models）。返回 [{ id }]；失败抛错。 */
export async function listModels() {
  const cfg = effectiveApi();
  const res = await fetch(joinUrl(cfg.baseUrl, '/models'), {
    headers: authHeaders(cfg.apiKey),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) throw new Error(`获取模型列表失败：HTTP ${res.status}`);
  const data = await res.json();
  const list = Array.isArray(data?.data) ? data.data : (Array.isArray(data) ? data : []);
  return list.map((m) => ({ id: String(m.id ?? m.model ?? m) })).filter((m) => m.id);
}

/**
 * 累加 usage。
 * 同时累计 cachedTokens（命中前缀缓存的 prompt 部分）与 cacheCreationTokens（显式缓存写入）。
 *
 * ⚠️ 2026-09-22：以前这里只认 3 个字段（prompt_tokens_details.cached_tokens /
 *   prompt_cache_hit_tokens / cached_tokens），于是走 Anthropic 协议或部分中转时
 *   `cache_read_input_tokens` 读不到 → 命中率恒为 0、成本页把命中的 token 全按原价算；
 *   `cache_write_tokens`（OpenRouter 的写法）也漏了，写入量记成 0。
 *   现在统一走 cache-keepalive 里那份"能认多种形态"的读取器（readUsageNumbers），
 *   一个项目只有一套口径 —— 保温链那边早就读得更全，两边一致才不会互相打脸。
 */
export function addUsage(target, usage) {
  if (!usage) return target;
  const nums = readUsageNumbers(usage);
  const prompt = nums.prompt || 0;
  const completion = Number(usage.completion_tokens) || Number(usage.completionTokens) || 0;
  target.promptTokens += prompt;
  target.completionTokens += completion;
  target.totalTokens += Number(usage.total_tokens) || (prompt + completion);
  target.cachedTokens = (Number(target.cachedTokens) || 0) + (nums.cached || 0);
  // 显式缓存创建量：百炼按输入单价 125% 计费；Kimi / OpenRouter 叫 cache_write_tokens
  target.cacheCreationTokens = (Number(target.cacheCreationTokens) || 0) + (nums.created || 0);
  return target;
}

export function emptyUsage() {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, calls: 0 };
}

/** 缓存命中率（0~1）。没有 prompt 数据时返回 0。 */
export function cacheHitRate(usage) {
  const p = Number(usage?.promptTokens) || 0;
  if (!p) return 0;
  return Math.min(1, Math.max(0, (Number(usage?.cachedTokens) || 0) / p));
}

/**
 * 按配置单价折算成本（元）。
 *
 * 三种单价来源：
 *   1. useOfficialPrice=true 且模型 id 在内置价格表里 → 用官方价（缓存部分单独计价）
 *   2. 否则用用户手填的 priceInputPerM / priceOutputPerM / priceCachedPerM
 *   3. 都没有 → 0（不估算）
 *
 * 缓存命中部分优先走 cached 单价；官方价里 cached 为 null 时（该模型无缓存优惠）
 * 退回按普通输入价计算。
 *
 * 峰谷分时：opts.at 传调用时刻（毫秒时间戳）时，对支持分时的厂商（DeepSeek）
 * 按该时刻自动取高峰价或闲时价。不传 at 则按闲时计价（保守估值，会偏低）。
 * 历史统计请看 sumCostByTime() —— 它按每条记录的时刻分别计价后汇总，更准。
 */
export function estimateCost(usage, opts = {}) {
  const cfg = effectiveApi();
  // 成本只与"实际调用的模型"有关。opts.model 优先（统计时逐条传入各自的模型），
  // 不传才回退到当前选中的模型。
  const model = String(opts.model ?? cfg.model ?? '');

  const promptTokens = Number(usage?.promptTokens) || 0;
  const completionTokens = Number(usage?.completionTokens) || 0;
  const cachedTokens = Math.min(Number(usage?.cachedTokens) || 0, promptTokens);
  // 显式缓存创建量已含在 prompt 里；优先使用模型单列的创建价。
  const creationTokens = Math.min(Number(usage?.cacheCreationTokens) || 0, Math.max(0, promptTokens - cachedTokens));
  // 未命中缓存的普通输入 = 总输入 - 命中部分 - 缓存创建部分
  const freshTokens = Math.max(0, promptTokens - cachedTokens - creationTokens);

  // 统一走 resolveModelPrice：自定义 > 内置官方表 > 全局兜底
  // 注意：第二个参数要传完整配置对象（内部读 cfg.api.*），
  // 传 effectiveApi() 的返回值（它就是 api 本身）会导致取不到字段。
  const p = resolveModelPrice(model, getConfig());

  // 峰谷：传了 at（调用时刻）且该模型有 peak 档位就取对应档
  const tier = p.peak && opts.at ? priceAt(p, opts.at) : null;
  const inPrice = tier ? tier.in : p.in;
  const outPrice = tier ? tier.out : p.out;
  const cachedPrice = tier ? tier.cached : p.cached;
  const creationPrice = Number(tier?.created ?? p.created ?? (inPrice * 1.25)) || 0;

  const source = p.source;
  const matched = p.matched;
  const peak = Boolean(tier?.peak);
  const hasPeakTiers = Boolean(p.peak);

  const cost =
    (freshTokens / 1_000_000) * inPrice +
    (creationTokens / 1_000_000) * creationPrice +
    (cachedTokens / 1_000_000) * cachedPrice +
    (completionTokens / 1_000_000) * outPrice;

  return {
    cost,
    source,
    breakdown: {
      fresh: (freshTokens / 1_000_000) * inPrice,
      creation: (creationTokens / 1_000_000) * creationPrice,
      cached: (cachedTokens / 1_000_000) * cachedPrice,
      output: (completionTokens / 1_000_000) * outPrice
    },
    prices: { in: inPrice, out: outPrice, cached: cachedPrice, created: creationPrice },
    matched,
    // 峰谷信息：hasPeakTiers 表示这个模型是否分时段计价
    peak,
    hasPeakTiers
  };
}
