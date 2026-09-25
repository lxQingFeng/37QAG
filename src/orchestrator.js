// 编排器：事件驱动的"无状态运行"核心。
//
// 流程（对应需求）：
//   机器人空闲 → 用户发言 → 防抖聚批(wakeDelayMs) → 新开会话（一次独立的 agent 处理）
//   → 开始时把所有消息标记为已读（触发批作为【本次唤醒】）→ agent 用工具发言/决定不发言
//   → 会话弃置（不留 LLM 历史）→ 发现 JSON 里有未读 → drainDelayMs 后再新开会话 → …
//   → 直到没有未读 → 回到空闲。
//
// 同一会话（群/私聊）同时最多一个运行；运行期间新消息只写 JSON（未读），不叠加触发。
// 不同会话之间并行，受 maxConcurrentRuns 全局限流。
import path from 'node:path';
import { createHash } from 'node:crypto';
import { getConfig, DATA_DIR } from './config.js';
import { localReplyPolicy, nextTruncationBudget, canEndReplyBatch } from './local-reply-policy.js';
import { vendorOfConfig } from './model-prices.js';
import { sleep, randInt, createEventBus, todayKey, stripLeadingReplyPrefix } from './util.js';
import { buildSystemPrompt, buildUserPromptParts, buildStaticPersonaBlock, resolveContextTier, scopedStoreConfig, isAtMe, hitKeyword, wantsMemoryRecall, wantsImage, memoryRecallQuery, relevantSpeakerIds, isHotMemeQuestion, memeSearchQuery } from './prompt.js';
import { webSearch } from './web-search.js';
import { applyRunToBotState, botStatePromptLine, detectIncomingHint, getBotState, cueGateMisses, favorDeltaForKinds, mergeEmotionSignals, looksPlayfulOccasion } from './bot-state.js';
import { isHypeMode, HYPE_TOOLS } from './hype-mode.js';
import { getConversationMemory } from './conversation-memory/runtime.js';
import { buildRecent24hDigest } from './conversation-memory/archive.js';
import { hourKeyOf } from './conversation-memory/longterm.js';
import { buildArchitectureInject, saveCrossTurn, getArchMemory } from './conversation-memory/arch.js';
import { conversationTurnPayload, cleanThought } from './conversation-memory/cross-turn.js';
import { reportRunCost } from './conversation-memory/cost-guard.js';
import { cueMemories, markMemeAdopted } from './memes.js';
import { shouldCueImageLib, searchImageLib } from './image-lib.js';
import { chatCompletion, chatCompletionWithRetry, addUsage, isRetryableError, supportsCacheMarkers, isAutoCacheEndpoint, apiWith, resolveApiKey } from './llm.js';
import { CacheKeeper, nextKeepAliveStep, keepAliveMessages, keepAliveOptionsFor, shouldMarkPrefix, readUsageNumbers, DEFAULT_KEEP_ALIVE, appendKeepAliveLedger, keepAliveLedgerPath, summarizeKeepAliveLedger } from './cache-keepalive.js';
import { buildToolDefs, toOpenAiTools, executeTool, downloadImagesAsDataUrls } from './tools.js';
import { hookBeforeContext, hookBeforeLlmMessages, hookAfterResponse, hookBeforeTool, hookAfterTool } from './skill-bridge.js';
// 内联调用解析拆到独立模块（tools.js 也要用同一个解析器，放这里会形成循环 import）。
// 这里再导出一次，保持既有 import 路径（含测试）不变。
import { parseInlineToolCalls, parseInlineLooseCalls } from './inline-calls.js';
export { parseInlineToolCalls, parseInlineLooseCalls };
import { modelImageVerdict } from './vision-scan.js';
import { buildStickerContext } from './stickers.js';
import { judgeTextOnly, judgeUnsentLines } from './salvage.js';
import { localJevHasRole, jevEmotionHint, jevGateBundle, jevGate, jevCueKind, jevStickerPick, jevReplyChance, jevBurstDone, computeGroupHeat, resolveReplyChanceParams, checkInterjectQuota } from './local-jev.js';
import { isQuietProtocolText, isReplyPlanningText, rememberReplyDraft, selectGroundedReplies, fitReplyBubbles } from './reply-recovery.js';
import { currentProviders } from './providers.js';
import { decideMemoryRecall, decideParticipation, detectParticipationRoute, looksLikeExplicitRequest } from './decision-policy.js';
import { createRunContext } from './run-context.js';

function normalizeToolArgs(value) {
  if (typeof value !== 'string') return value ?? {};
  try { return JSON.parse(value); } catch { return value; }
}

function stableJsonValue(value) {
  if (Array.isArray(value)) return `[${value.map(stableJsonValue).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJsonValue(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 规范化“工具名 + 参数”指纹；参数键顺序和空白变化视为同一调用。 */
export function toolCallSignature(name, argsRaw = '{}') {
  return `${String(name || '')}|${stableJsonValue(normalizeToolArgs(argsRaw))}`;
}

export function filteredToolResult(call, reason) {
  const name = String(call?.function?.name ?? '');
  return {
    role: 'tool',
    tool_call_id: call?.id ?? '',
    name,
    content: JSON.stringify({ note: String(reason || '本次调用已被安全策略跳过') }),
    isError: false
  };
}

function safePositiveLimit(raw, fallback) {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * 为一次运行选择安全的工具调用。
 * 拒绝项必须由调用方补成 tool result，避免 assistant.tool_calls 悬空。
 */
export function selectSafeToolCalls(toolCalls = [], state = {}, limits = {}) {
  const seen = state.seen instanceof Set ? state.seen : (state.seen = new Set());
  state.runCount = Number.isFinite(Number(state.runCount)) ? Number(state.runCount) : 0;
  state.totalSends = Number.isFinite(Number(state.totalSends)) ? Number(state.totalSends) : 0;
  state.sendsByName = state.sendsByName && typeof state.sendsByName === 'object' ? state.sendsByName : {};
  const perRound = safePositiveLimit(limits.perRound, 8);
  const perRun = safePositiveLimit(limits.perRun, 24);
  const totalSends = safePositiveLimit(limits.totalSends, 4);
  const accepted = [];
  const rejected = [];
  for (const call of Array.isArray(toolCalls) ? toolCalls : []) {
    const name = String(call?.function?.name ?? '');
    const argsRaw = call?.function?.arguments ?? '{}';
    const signature = toolCallSignature(name, argsRaw);
    let reason = '';
    if (accepted.length >= perRound) reason = `本轮工具动作已达上限（${perRound} 个），请直接利用已有结果回复或结束。`;
    else if (state.runCount >= perRun) reason = `本次运行工具动作已达上限（${perRun} 个），请停止继续调用工具。`;
    else if (seen.has(signature)) reason = '相同工具和参数已经执行过，请直接使用已有结果，不要重复调用。';
    else if (name.startsWith('send_') && state.totalSends >= totalSends) reason = `本次运行发送动作已达上限（${totalSends} 次），不要再发送。`;
    else {
      const namedLimit = Number(limits[name]);
      if (Number.isFinite(namedLimit) && namedLimit >= 0) {
        const used = Number(state.sendsByName[name]) || 0;
        if (used >= safePositiveLimit(namedLimit, 1)) reason = `${name} 本次运行已达上限（${Math.floor(namedLimit)} 次）。`;
      }
    }
    if (reason) {
      rejected.push({ id: call?.id ?? '', call, reason, signature });
      continue;
    }
    seen.add(signature);
    state.runCount += 1;
    if (name.startsWith('send_')) {
      state.totalSends += 1;
      state.sendsByName[name] = (Number(state.sendsByName[name]) || 0) + 1;
    }
    accepted.push(call);
  }
  return { accepted, rejected };
}

async function executeToolGuarded(toolDefs, ctx, name, argsRaw) {
  if (/^send_/.test(String(name || ''))) {
    const gate = ctx.guardAction?.(`send:${name}`);
    if (gate && !gate.ok) return { isError: true, content: `发送已取消：${gate.reason}` };
  }
  return executeTool(toolDefs, ctx, name, argsRaw);
}

/**
 * 把正文里的「（心声：…）」行摘出来。
 *
 * 心声是模型写给自己看的收尾独白：系统收进跨轮记忆当「上轮我在想什么」，
 * 绝不发进群。摘掉之后剩下的才是可能被补发的正文 —— 否则裁判判 say 时
 * 会把这行内心话一起发到群里。
 */
function splitInnerVoice(text) {
  const lines = String(text || '').split(/\n+/);
  const voice = [];
  const rest = [];
  for (const ln of lines) {
    const m = /^(?:[（(]\s*)?心声[:：]\s*(.+?)\s*[)）]?$/.exec(String(ln || '').trim());
    if (m && m[1]) voice.push(m[1]);
    else rest.push(ln);
  }
  return { clean: rest.join('\n').trim(), voice: voice.join('；').replace(/\s+/g, ' ').slice(0, 200) };
}

/**
 * 缓存模式迁移兼容：新配置明确用 cacheMode；旧配置仍认 explicitCache。
 * 这样 data-2 等尚未打开过新设置页的实例不会被默认值悄悄改行为。
 */
export function resolveCacheMode(api = {}) {
  const mode = String(api?.cacheMode || '').trim().toLowerCase();
  if (mode === 'implicit' || mode === 'explicit' || mode === 'off' || mode === 'adaptive') return mode;
  return api?.explicitCache === true ? 'explicit' : 'off';
}

/** 构造唯一的初始前缀；导出便于回归测试真实消息形状。 */
export function buildInitialMessages({ systemText = '', userText = '', cacheMode = 'off', baseUrl = '', markPrefix = null } = {}) {
  // markPrefix 显式传入时优先（自适应模式要按"前缀还热不热"动态决定）；
  // 否则退回老规则：只有 explicit 才打。
  const withMarker = markPrefix === null
    ? (cacheMode === 'explicit' && supportsCacheMarkers(baseUrl))
    : (markPrefix === true && supportsCacheMarkers(baseUrl));
  const systemContent = withMarker
    ? [{ type: 'text', text: systemText, cache_control: { type: 'ephemeral' } }]
    : systemText;
  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userText }
  ];
}

export class Orchestrator {
  constructor({ store, memory, stickers, sender, sessions, onebot, emit = null }) {
    this.store = store;
    this.cacheRequestTimes = new Map();
    this.memory = memory;
    this.stickers = stickers;
    this.sender = sender;
    this.sessions = sessions;
    this.onebot = onebot;
    this.emit = typeof emit === 'function' ? emit : ((b) => b.emit.bind(b))(createEventBus());
        this.toolDefs = buildToolDefs();

    this.chatNameCache = new Map();    // groupId -> name
    this.muteCache = new Map();        // chatKey -> { muted, checkedAt }（禁言判定缓存，60 秒）
    // 上下文缓存状态机 + 保温链（自适应模式用；见 src/cache-keepalive.js）
    this.cacheKeeper = new CacheKeeper();
    this.keepAliveTimers = new Map();  // chatKey -> timer
    this.keepAliveFired = new Map();   // chatKey -> 已续棒次数
    this.keepAliveStats = { calls: 0, promptTokens: 0, cachedTokens: 0, hits: 0, stopped: 0 };
    this.keepAliveLog = [];            // 保温链诊断环形日志（见 #kaLog）
    this.keepAliveStopReasons = new Map();  // why → 次数（"为什么停"的唯一出口）
    this.keepAliveLedgerMark = new Map();   // 台账去重：`phase|chatKey|why` → 上次写入时间
    this.wakeTimers = new Map();       // chatKey -> timer
    this.pendingWake = new Set();      // 防抖中等待聚批的 chatKey
    this.autoStickerAt = new Map();    // chatKey -> 上次自动配表情的时间（冷却用）
    this.pendingSessions = new Map();  // chatKey -> waiting sessionId（防抖期可见的“等待中”会话）
    this.consolidating = new Set();    // 正在整理记忆的 chatKey
    this.runningChats = new Set();     // 正在运行的 chatKey（至少有一路在跑）
    this.chatRunCount = new Map();     // chatKey -> 当前并行路数（亢奋同群多开）
    this.activeRuns = new Map();       // chatKey -> sessionId 或 sessionId[]
    this.runSeq = new Map();           // chatKey -> 第几次处理（跨重启清零即可）
    this.burstStart = new Map();       // chatKey -> 当前这一串连发的起始时间（自适应防抖用）
    this.lastMsgAt = new Map();        // chatKey -> 上一条入站消息的时间（判断这一串有没有断）
    // 连发防抖交给本地 Jev 判（localJev.burstJudge）：窗口是异步精修的，这四样是它的护栏。
    this.wakeMs = new Map();           // chatKey -> 当前定时器按多少毫秒布的防（精修时要对比）
    this.burstRateCache = new Map();   // `${chatKey}|${senderId}` -> { rate, at }（"他爱不爱连发"）
    this.burstJudgeGen = new Map();    // chatKey -> 代次：回来时对不上 = 窗口已被新消息重排，作废
    this.burstJudgeBusy = new Set();   // chatKey -> 有一次判定在飞（单飞，别把本地模型队列打满）
    this.burstJudgeAgain = new Set();  // chatKey -> 飞行期间又被折叠过一次，落地后补判一次
    this.memeCueAt = new Map();        // chatKey -> 上次脑内闪过时间（跨轮冷却）
    // 主动插话的频率闸：两条进入路径（Jev 判 YES / 骰子直接命中）共用。
    this.interjectAt = new Map();      // chatKey -> 上次主动插话的时间（冷却）
    this.interjectTimes = [];          // 全局最近一小时插话的时间戳（次数上限）
    this.paused = false;
    this.pauseReason = null;
    this.proactiveTimer = null;
    this.scheduleTimer = null;      // 私聊定时：约每 30s 对一次钟
    this.lastScheduleFired = new Map(); // `${chatId}|${HH:MM}|${dateKey}` -> true，防同分钟重复
    this.aborted = false;
    /** 近24h摘要按小时钉死：同一小时内文本不变 → 更容易吃前缀缓存 */
    this.digestCache = new Map(); // chatKey -> { hourKey, params, text }
  }

  /** 小时桶摘要：同一小时只重算一次，保证缓存前缀稳定。 */
  #hourDigest(chatKey, d) {
    const hour = hourKeyOf(Date.now());
    const params = {
      hours: Number(d.hours) || 24,
      maxChars: Math.min(600, Math.max(80, Number(d.maxChars) || 240)),
      maxItems: Math.min(16, Math.max(2, Number(d.maxItems) || 8))
    };
    const key = `${chatKey}`;
    const hit = this.digestCache.get(key);
    if (
      hit
      && hit.hourKey === hour
      && hit.params.hours === params.hours
      && hit.params.maxChars === params.maxChars
      && hit.params.maxItems === params.maxItems
    ) {
      return hit.text;
    }
    let text = '';
    try {
      text = buildRecent24hDigest(path.join(DATA_DIR, 'messages'), chatKey, params) || '';
    } catch {
      text = '';
    }
    this.digestCache.set(key, { hourKey: hour, params, text });
    return text;
  }

  /** 热重载：按当前配置重建工具定义，清掉依赖配置的缓存。 */
  refreshAfterConfigChange() {
    this.toolDefs = buildToolDefs();
    this.chatNameCache.clear();
    this.autoStickerAt.clear();
    return {
      tools: this.toolDefs.map((d) => d.name),
      toolCount: this.toolDefs.length
    };
  }

  /**
   * 恢复后处理：所有当前有未读消息的会话都安排一次唤醒，把积压消息补处理掉。
   * 如果模型未配置，wake 会自然跳过（消息保留未读，不丢失）。
   */
  drainBacklogAfterResume() {
    for (const chatKey of this.store.listChats()) {
      if (this.store.unreadCount(chatKey) > 0) this.scheduleWake(chatKey, 0);
    }
    // 重启后孤儿「等待中」会话：定时器已丢，主动续跑或收掉
    try {
      const waiting = this.sessions.listSummaries?.(200) || [];
      const now = Date.now();
      for (const s of waiting) {
        if (s.status !== 'waiting') continue;
        const waitUntil = Number(s.waitUntil) || 0;
        if (now - waitUntil > 60 * 1000) {
          // 等太久：直接收掉，避免 UI 一直挂「启动…」
          this.#discardWaiting(s.id);
          this.pendingSessions.delete(s.chatKey);
          continue;
        }
        if (this.store.unreadCount(s.chatKey) > 0 || this.pendingSessions.has(s.chatKey)) {
          this.pendingSessions.set(s.chatKey, s.id);
          this.scheduleWake(s.chatKey, 200);
        }
      }
    } catch { /* ignore */ }
  }

  // ── 入站接口 ───────────────────────────────────────────────────────────

  /** 收到新消息（已通过白名单校验并写入 store）。 */
  onIncoming(chatKey) {
    if (this.paused || this.aborted) return;
    // 亢奋：同群已有会话在跑时，若有新未读，仍可再开一路（多线程怼同一个群）
    if (this.runningChats.has(chatKey)) {
      if (!isHypeMode()) return;
      const n = this.chatRunCount.get(chatKey) || 0;
      if (n >= 3) return;
      if (this.store.unreadCount(chatKey) <= 0) return;
      this.scheduleWake(chatKey);
      return;
    }
    this.scheduleWake(chatKey);
  }

  #bumpRun(chatKey) {
    const n = (this.chatRunCount.get(chatKey) || 0) + 1;
    this.chatRunCount.set(chatKey, n);
    this.runningChats.add(chatKey);
  }

  #dropRun(chatKey) {
    const n = Math.max(0, (this.chatRunCount.get(chatKey) || 1) - 1);
    if (n <= 0) {
      this.chatRunCount.delete(chatKey);
      this.runningChats.delete(chatKey);
    } else {
      this.chatRunCount.set(chatKey, n);
    }
  }

  #trackRun(chatKey, sessionId) {
    const cur = this.activeRuns.get(chatKey);
    if (Array.isArray(cur)) cur.push(sessionId);
    else if (cur) this.activeRuns.set(chatKey, [cur, sessionId]);
    else this.activeRuns.set(chatKey, sessionId);
  }

  #untrackRun(chatKey, sessionId) {
    const cur = this.activeRuns.get(chatKey);
    if (Array.isArray(cur)) {
      const next = cur.filter((id) => id !== sessionId);
      if (next.length) this.activeRuns.set(chatKey, next);
      else this.activeRuns.delete(chatKey);
    } else if (cur === sessionId) {
      this.activeRuns.delete(chatKey);
    }
  }

  /** 防抖聚批：等待 wakeDelayMs，期间每来一条消息重置计时。 */
  /**
   * 对"当前这批未读"做档位预判：这批消息值不值得机器人响应？
   *
   * scheduleWake（建等待会话前）与 wake（真正运行前）共用这一个函数，
   * 避免两处各写一份判定、日后逻辑漂移。
   *
   * 注意：这里**不消费**未读（用 peekUnread 只看不取），
   * 所以防抖窗口期间每次来新消息都可以重新预判 ——
   * 先来一句闲聊（不命中、不显示），接着有人 @ 机器人（命中、立刻显示）。
   *
   * @returns {{shouldRespond:boolean, tier:number, count:number, reason:string}}
   */
  /**
   * 档位 3 的骰子是否退场（= 这批交给 Jev 判定）。三个条件都要满足：
   *   · mode == 'jev'      —— 用户明确选了「Jev 判定」而不是纯骰子
   *   · 本地 Jev 总开关没关 —— 关了就没人可问
   *   · replyChanceGate 被接管 —— 角色没启用时问了也白问
   * 任一不满足就**退回骰子**：宁可回到老行为，也不能让档位 3 变成"永远沉默"
   * （不然用户一关本地模型，整个随机档就静静地死了，还找不到原因）。
   * 预判（#predictTier）与实际判定必须用同一个判断，所以抽出来共用。
   */
  #jevReplacesDice(cfgNow) {
    const rc = cfgNow?.localJev?.replyChance || {};
    if (rc.enabled === false) return false;
    if (String(rc.mode || 'jev') !== 'jev') return false;
    if (cfgNow?.localJev?.enabled === false) return false;
    return localJevHasRole('replyChanceGate');
  }

  #predictTier(chatKey) {
    const cfg = getConfig();
    const entries = this.store.peekUnread(chatKey, 200) || [];
    const kind = String(chatKey).split(':')[0] === 'private' ? 'private' : 'group';
    const selfNickname = cfg.persona?.selfNickname || this.onebot.selfNickname || '';
    const rcPre = cfg.localJev?.replyChance || {};
    const r = resolveContextTier({
      triggerEntries: entries,
      selfNickname,
      botName: cfg.persona?.botName || '',
      selfId: cfg.onebot?.selfId || this.onebot.selfId || '',
      // 群聊/私聊各有一套档位参数；单个群/好友还可以在 store.perChat 里单独覆盖
      kind,
      chatKey,
      // 预判跟最终判定同一个口径：mode='jev' 时档位 3 不掷骰子，预判就返回
      // shouldRespond=false（"还没问过 Jev，不算确定要响应"）。这样既不会因为
      // 预判掷中骰子而提前唤醒，也不会多挂一条最后变"中止"的等待条目。
      deferRandom: rcPre.enabled !== false && String(rcPre.mode || 'jev') === 'jev'
    });
    // 没有未读就不算"需要响应"（防抖窗口刚建立时的空转）
    if (entries.length === 0) return { ...r, shouldRespond: false, reason: '无未读', pointed: false };
    // "被点名" = 有人 @ 机器人或说到了关键词。
    // 单独算一遍是因为档位结果看不出来：4 档配置下 @ 也会返回"全部响应"，
    // 但连发合并窗口必须给 @ 让路（点名找它就该秒回）。
    const texts = entries.map((e) => String(e?.text ?? ''));
    const sc = scopedStoreConfig(cfg.store, { kind, chatKey });
    const privateChat = kind === 'private';
    const pointed = privateChat || texts.some((t) => isAtMe(t, {
      selfNickname, botName: cfg.persona?.botName || '', selfId: cfg.onebot?.selfId || this.onebot.selfId || ''
    })) || Boolean(hitKeyword(texts.join('\n'), sc.keywords));
    // 私聊普通消息也必须响应：不能被 Jev 的弃权或主动插话路线吞掉。
    return { ...r, shouldRespond: privateChat || r.shouldRespond, pointed, reason: privateChat ? '私聊必须响应' : r.reason };
  }

  /**
   * 这个人在这个会话里"爱不爱连发"：他发过的消息里有多少条在 burstSettleMs 之内被自己接了一句。
   *
   * 为什么要它：连发窗口原来是两个死值（新串首条 wakeDelayMs / 串内 burstSettleMs），
   * 但"他还会接着说吗"按人差得非常远。实测（test/burst-scope-lab.mjs，15.4 万条入站消息）：
   *   p10=10.6% / p50=29.6% / p90=51.0%，而且**稳定** —— 用前半段估的值预测后半段 r=0.85。
   * 给所有人等一样久，对"说完就闭嘴"的人就是纯白等：那批人窗口从 9.1s 降到 5.6s，
   * 打断率（跑完 8 秒内他又接着说）8.4%→8.6%，几乎没变 —— 白等的那 3.5 秒是白送的。
   *
   * 只用**已经发生过的**消息算（第 i 条看第 i+1 条），不引入未来信息。
   * 样本不足（< minSamples 对）就用会话类型先验（私聊 0.45 / 群聊 0.28，都是实测量出来的；
   * 私聊首条尤其容易被低估：47.9% 会被接着说，而群里只有 25.8%）。
   * 结果缓存 2 分钟：连发时每条消息都要问一次，不能每次都重扫一遍历史。
   */
  #senderBurstRate(chatKey, senderId, settle) {
    if (!senderId) return null;
    const key = `${chatKey}|${senderId}`;
    const now = Date.now();
    const hit = this.burstRateCache.get(key);
    if (hit && now - hit.at < 120000) return hit.rate;
    const ad = getConfig().burstAdaptive || {};
    let rate = null;
    try {
      const win = this.store.recent(chatKey, { limit: 240, includeSelf: false }) || [];
      const mine = win.filter((m) => String(m.senderId) === String(senderId));
      let pairs = 0, cont = 0;
      for (let i = 0; i + 1 < mine.length; i++) {
        pairs++;
        if (Number(mine[i + 1].ts) - Number(mine[i].ts) <= settle) cont++;
      }
      const need = Math.max(1, Number(ad.minSamples) || 6);
      if (pairs >= need) rate = cont / pairs;
    } catch { /* 拿不到历史就退回先验 */ }
    if (rate == null) {
      rate = String(chatKey).startsWith('private')
        ? Number(ad.priorPrivate ?? 0.45)
        : Number(ad.priorGroup ?? 0.28);
    }
    rate = Math.min(1, Math.max(0, Number(rate) || 0));
    this.burstRateCache.set(key, { rate, at: now });
    return rate;
  }

  /** 这批未读里最后一条是谁发的（自适应窗口要用它查"这个人爱不爱连发"）。 */
  #lastInboundSender(chatKey) {
    try {
      const e = this.store.peekUnread(chatKey, 3) || [];
      return String(e[e.length - 1]?.senderId || '');
    } catch { return ''; }
  }

  /**
   * 自适应防抖窗口：同一个人连发几条时，别每条都单独跑一遍完整流程。
   *
   * 关键：一串的边界是"安静下来"，不是"跑过一次"。
   * 之前把状态在每次运行开始时清掉，结果窗口只在两条消息间隔小于 wakeDelayMs 时才生效 ——
   * 而真人连发的间隔是 10~30 秒，于是几乎永远不合并，只偶尔把快速两连击拖成 15 秒才回。
   *
   * 现在的规则：
   *   - 被点名（@ 或命中关键词）→ wakeDelayMs，秒回；
   *   - 距上一条消息超过 idle（默认 30s）→ 新的一串；
   *   - 同一串里 → 等「这个人自己的连发窗口」看还有没有下文，
   *     整串最多等 burstMaxWaitMs，到点就开跑并重新开一串；
   *     ⚠️ 一轮跑完时也会**重新起算**整串预算（见 wake() 的 finally），
   *        否则聊了 7 秒才跑完的那一轮会把后续消息的窗口压到几百毫秒；
   *   - burstSettleMs / burstMaxWaitMs 任一为 0 = 关闭，退回固定 wakeDelayMs。
   *
   * 窗口本身（burstAdaptive.enabled=true 时）按"这个人爱不爱连发"在
   * wakeDelayMs → burstSettleMs 之间插值，见 #senderBurstRate 的实测依据；
   * 关掉它就是老行为：新串首条短窗口、串内长窗口。
   */
  #burstDelayMs(chatKey, pointed) {
    const cfg = getConfig();
    // 亢奋：关掉防抖，约 100ms 后立刻开跑；允许多群同时处理
    if (isHypeMode()) {
      this.lastMsgAt.set(chatKey, Date.now());
      return 100;
    }
    // 普通：完整防抖/连发等待（像真人聊天）
    const base = Math.max(0, Number(cfg.wakeDelayMs) || 2000);
    const settle = Math.max(0, Number(cfg.burstSettleMs) || 0);
    const maxWait = Math.max(settle, Number(cfg.burstMaxWaitMs) || 0);
    const now = Date.now();
    const idle = Math.max(30000, settle * 2);
    const prev = this.lastMsgAt.get(chatKey) || 0;
    this.lastMsgAt.set(chatKey, now);

    if (pointed || settle === 0 || maxWait === 0) return base;
    const newBurst = !prev || now - prev > idle;

    // 目标窗口：自适应 = 按人插值；否则 = 老行为（首条 base / 串内 settle）
    const ad = cfg.burstAdaptive || {};
    let target = settle;
    if (ad.enabled !== false) {
      const senderId = this.#lastInboundSender(chatKey);
      const rate = this.#senderBurstRate(chatKey, senderId, settle);
      if (rate != null) {
        // k = "连发倾向到多少就给满 settle"。扫描选点见 config.js burstAdaptive 的注释。
        const k = Math.max(0.05, Number(ad.k ?? 0.3));
        target = base + (settle - base) * Math.min(1, rate / k);
      }
      target = Math.max(base, Math.min(settle, Math.round(target)));
    } else if (newBurst) {
      target = base;
    }

    if (newBurst) {
      this.burstStart.set(chatKey, now);
      return Math.max(base, Math.round(target));
    }
    let started = this.burstStart.get(chatKey) || prev;
    // 连续刷屏超过整串上限：立刻开跑，别再重置窗口（否则永远等不完）
    if (now - started >= maxWait) {
      this.burstStart.set(chatKey, now);
      return 0;
    }
    this.burstStart.set(chatKey, started);
    return Math.max(base, Math.min(Math.round(target), started + maxWait - now));
  }

  scheduleWake(chatKey, delay = null) {
    // 先预判：既用于"要不要显示等待中会话"，也用于判断这条消息是不是在点名找机器人。
    // 预判用**与最终判定相同的口径**（含 deferRandom），所以随机档下它不再掷骰子。
    // 预判只影响等待窗口的长短与"等待中"条目，不决定最终响应与否。
    const predicted = this.#predictTier(chatKey);
    const ms = delay === null
      ? this.#burstDelayMs(chatKey, predicted.pointed === true)
      : Math.max(0, Number(delay) || 0);
    this.#armWake(chatKey, ms, predicted, false);
    // 本地 Jev 精修等待窗口（说完了就秒回 / 还在说就继续等）。
    // 刻意**不 await**：0.8B 在 CPU 上一问 200~700ms，同步等它等于把每条消息的
    // 入队时间都推后；先按计时规则布防、判完再改窗口，最坏情况只是没赶上（= 老行为）。
    // delay 显式传入的路径（forceWake / 错误重试）不掺和。
    if (delay === null) this.#refineBurstDelay(chatKey, predicted).catch(() => {});
  }

  /**
   * 布防/重排某会话的等待定时器，并维护"等待中"会话。
   *
   * 单独抽出来是因为窗口**会在布防之后被改**（连发防抖的 Jev 精修）：
   * 原来这段和 scheduleWake 焊在一起，改窗口只能 clearTimeout 再整套重来，
   * 容易漏掉"等待中"会话的 waitUntil 同步。
   *
   * @param exactUntil 重排时把 waitUntil **直接覆盖**成新的到点时间。
   *        默认 false = 取更晚的那个（聚批语义：新消息只会把窗口推后）。
   *        Jev 把窗口改**短**时必须是 true，否则界面上那个倒计时还停在旧的更晚时间。
   */
  #armWake(chatKey, ms, predicted, exactUntil = true) {
    if (this.pendingWake.has(chatKey)) clearTimeout(this.wakeTimers.get(chatKey));
    this.pendingWake.add(chatKey);
    this.wakeMs.set(chatKey, ms);

    // 等待窗口 > 0：在会话页立刻创建“等待中”会话，并随新消息重置倒计时
    //
    // ⚠️ 先预判再创建：档位非 4 时，若这批消息确定不会响应，
    //    就**不创建**"等待中"会话 —— 否则用户会在会话页看到一堆
    //    等半天最后变成"中止"的条目，既干扰又让人以为出了错。
    //    窗口结束前若来了新消息且命中，届时再创建（见下面 pendingSessions 分支）。
    if (ms > 0 && !this.runningChats.has(chatKey)) {
      if (predicted.shouldRespond === false) {
        // 不响应：把已存在的等待会话撤掉（例如刚被艾特、随后判定又不成立的情况）
        const stale = this.pendingSessions.get(chatKey);
        if (stale) {
          this.#discardWaiting(stale);   // 干净消失，不留"中止"
          this.pendingSessions.delete(chatKey);
        }
        this.emit('chat-update', chatKey);
        // 定时器仍然保留：窗口内可能来新消息，届时重新预判
      } else {
      const unread = this.store.peekUnread(chatKey, 5);
      const first = unread[0];
      const summary = first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '等待新消息聚批';
      const waitUntil = Date.now() + ms;
      const existing = this.pendingSessions.get(chatKey);
      if (existing) {
        const s = this.sessions.get(existing);
        if (s && s.status === 'waiting') {
          // 聚批：窗口内新消息一律把等待结束时间**推后**到新的 waitUntil（取更晚的）。
          // Jev 精修要把窗口改**短**时（exactUntil）就直接覆盖，否则倒计时还停在旧时间。
          const prevUntil = Number(s.waitUntil) || 0;
          s.waitUntil = exactUntil ? waitUntil : Math.max(prevUntil, waitUntil);
          s.triggerSummary = summary;
          s.trigger = unread;
          s.triggerText = unread.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
          this.sessions.update(s.id);
          this.emit('session-update', s.id);
        } else {
          this.pendingSessions.delete(chatKey);
        }
      }
      if (!this.pendingSessions.has(chatKey)) {
        const session = this.sessions.create({
          chatKey,
          trigger: unread,
          triggerSummary: summary,
          status: 'waiting',
          waitUntil
        });
        this.pendingSessions.set(chatKey, session.id);
        this.emit('session-start', { sessionId: session.id, chatKey, status: 'waiting', triggerSummary: summary });
      }
      this.emit('chat-update', chatKey);
      }
    }

    const timer = setTimeout(() => {
      this.pendingWake.delete(chatKey);
      this.wakeMs.delete(chatKey);   // 窗口已经到点，Jev 精修不该再动它
      const waitingId = this.pendingSessions.get(chatKey);
      // ⚠️ 这里先不删 pendingSessions：wake 若因「并发满/模型未设」提前返回，
      // 还要靠它把等待会话接回去；真正开跑时再删。
      // 亢奋：同群已在跑也允许再开一路（wake 内部还有每群上限）
      if (this.paused || this.aborted) {
        this.pendingSessions.delete(chatKey);
        if (waitingId) this.#finishWaiting(waitingId, 'aborted');
        return;
      }
      if (this.runningChats.has(chatKey) && !isHypeMode()) {
        this.pendingSessions.delete(chatKey);
        if (waitingId) this.#finishWaiting(waitingId, 'aborted');
        return;
      }
      this.wake(chatKey, { waitingSessionId: waitingId ?? null })
        .catch((error) => {
          console.error(`[orchestrator] wake ${chatKey} 出错:`, error);
          // 异常时也别把 waiting 会话丢在「启动…」
          if (waitingId) {
            const s = this.sessions.get(waitingId);
            if (s && s.status === 'waiting') {
              this.sessions.current.get(waitingId).waitUntil = Date.now() + 5000;
              this.sessions.update(waitingId);
              this.emit('session-update', waitingId);
              this.pendingSessions.set(chatKey, waitingId);
              setTimeout(() => {
                if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
                  this.scheduleWake(chatKey, 2000);
                }
              }, 5000);
            }
          }
        });
    }, ms);
    this.wakeTimers.set(chatKey, timer);
  }

  /**
   * 连发防抖的「精修」：问一句本地 Jev —— 他这句说完了没有？
   *   说完了（高置信）→ 窗口从 burstSettleMs 缩回 wakeDelayMs，立刻回
   *   其它（还在说 / 判不出来）→ 什么都不做 = 纯计时（老行为）
   *
   * ⚠️ 只做「缩短」，**不做「延长」**。实测（test/burst-lab.mjs，250 条真实决策点）：
   *   延长那一侧（把串头的短等待拉长到 settle）判「还在说」的命中率只有 17%~32%，
   *   而"不延长"本身就有 32% 的底 —— 也就是说延长这条路**不比瞎猜强**，
   *   纯属把时延往上加，而时延正是这次要治的东西。缩等那一侧才有真信号。
   *
   * 只在这条消息真的会等长窗口（cur > base）时才问：机械规则给短窗口时，
   * 判定结果既用不上，也白白占本地模型的并发位。
   *
   * 为什么是异步的：0.8B 在 CPU 上一问 200~700ms。这条判定只影响"回早一点还是晚一点"，
   * 不值得让每条入站消息都等它 —— 所以先按计时规则布防，判完再改窗口。
   *
   * 三道护栏（少一个都会变成事故）：
   *   ① 被点名 → 一律不动。@ 或命中关键词就是明确召唤，不能被判成"他还没说完"而拖后。
   *   ② 单飞：同一会话同时只放一次判定在飞，否则连发时会把本地模型的并发队列打满，
   *      把其它门控（情绪、记忆）挤成 busy 弃权。飞行期间来的再折叠成"补判一次"。
   *   ③ 代次：判完回来时若窗口已被新消息重排过（gen 变了）或已经开跑，本次结论**作废** ——
   *      防止拿"3 秒前那批消息"的结论去改"现在这批"的窗口。
   */
  async #refineBurstDelay(chatKey, predicted) {
    const cfg = getConfig();
    const bj = cfg.localJev?.burstJudge || {};
    if (bj.enabled !== true) return;
    if (predicted?.pointed) return;                 // ① 点名不动
    if (isHypeMode()) return;                       // 亢奋模式故意秒回，别插一脚
    // 连发窗口被显式关掉（两个 0）时也不该"用 Jev 把它按开"
    const settle = Math.max(0, Number(cfg.burstSettleMs) || 0);
    const maxWait = Math.max(settle, Number(cfg.burstMaxWaitMs) || 0);
    if (!settle || !maxWait) return;
    if (!this.pendingWake.has(chatKey)) return;
    const cur = Number(this.wakeMs.get(chatKey));
    if (!Number.isFinite(cur)) return;
    const base = Math.max(0, Number(cfg.wakeDelayMs) || 2000);
    if (cur <= base) return;      // 本来就没在等长窗口 → 判出来也用不上

    if (this.burstJudgeBusy.has(chatKey)) {         // ② 单飞 + 补判
      this.burstJudgeAgain.add(chatKey);
      return;
    }

    // 判据 = 这批未读里、最后一个人连着发的那几条（最多 3 条）
    const entries = this.store.peekUnread(chatKey, 6) || [];
    const last = entries[entries.length - 1];
    if (!last) return;
    const same = [];
    for (let i = entries.length - 1; i >= 0 && same.length < 3; i--) {
      const e = entries[i];
      if (String(e?.senderId) !== String(last.senderId)) break;
      const t = String(e?.text ?? '').replace(/\s+/g, ' ').trim();
      same.unshift(t || (Array.isArray(e?.media) && e.media.length ? '[图片]' : ''));
    }
    const text = same.filter(Boolean).join(' / ').slice(0, 120);
    if (!text) return;

    const gen = (this.burstJudgeGen.get(chatKey) || 0) + 1;
    this.burstJudgeGen.set(chatKey, gen);
    this.burstJudgeBusy.add(chatKey);
    let r = null;
    try {
      r = await jevBurstDone({ text });
    } catch {
      r = null;   // 本地模型的事不能带崩主链路
    } finally {
      this.burstJudgeBusy.delete(chatKey);
      if (this.burstJudgeAgain.delete(chatKey) && this.pendingWake.has(chatKey)) {
        // 折叠期间又来过新消息：拿最新的那批补判一次（只追一次，不无限套娃）
        this.#refineBurstDelay(chatKey, this.#predictTier(chatKey)).catch(() => {});
      }
    }
    if (!r || r.done !== true) return;                     // 判不出来 / 还在说 → 保持计时
    if (gen !== this.burstJudgeGen.get(chatKey)) return;   // ③ 期间来了新消息 → 作废
    if (!this.pendingWake.has(chatKey)) return;            // 已经开跑了
    if (this.wakeMs.get(chatKey) !== cur) return;          // 窗口已被重排

    this.#armWake(chatKey, base, predicted, true);
    console.log(`[orchestrator] ${chatKey} 连发防抖：本地 Jev 判「${r.label}」(p=${Number(r.p || 0).toFixed(2)} m=${Number(r.margin || 0).toFixed(2)}) → 等待 ${cur}ms 缩到 ${base}ms`);
  }

  /**
   * 丢弃一个"等待中"会话：让它从会话页**干净消失**，而不是变成"中止"。
   *
   * 用于档位判定"这次不响应"的场景 —— 用户看到的应该是"什么都没发生"，
   * 而不是一条等了半天最后标着"中止"的条目（那会让人以为机器人坏了）。
   * 只有真正运行过（消耗了 token）的会话才走 #finishWaiting 留痕。
   */
  #discardWaiting(sessionId) {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    this.sessions.discard(sessionId);
    this.emit('session-end', {
      sessionId,
      chatKey: s?.chatKey || '',
      status: 'discarded',
      discarded: true
    });
  }

  #finishWaiting(sessionId, status, error = '') {
    if (!sessionId) return;
    const s = this.sessions.current.get(sessionId);
    if (!s || s.status !== 'waiting') return;
    if (error) s.error = error;
    this.sessions.finish(sessionId, status);
    this.emit('session-end', { sessionId, chatKey: s.chatKey, status, error: s.error || null });
  }

  /** 手动触发一次处理（UI 按钮）。 */
  forceWake(chatKey) {
    if (this.runningChats.has(chatKey)) return false;
    this.scheduleWake(chatKey, 0);
    return true;
  }

  // ── 核心循环 ───────────────────────────────────────────────────────────

  /**
   * 本群是不是把机器人禁言了？两路互补（与 0.4 同源）：
   *   ① ban-state 插件的能力 `chat.ban-state`：记的是 OneBot group_ban 通知与"发送被拒"
   *      这两条真实事件，有记录就是确定的，省一次查询；
   *   ② 查询兜底：get_group_member_info 的 shut_up_timestamp 是**到期时刻**（epoch 秒），
   *      必须判"到期时刻在未来" —— 写成 `> 0` 会把早就解禁的群永久当成禁言中。
   * 查询失败一律放行（真被禁言时发送会报错，那时再处理），60 秒内不重复查。
   */
  async #selfMuted(chatKey) {
    try {
      const { skillManager } = await import('./skill-bridge.js');
      for (const p of skillManager.getCapabilityProviders('chat.ban-state', { chatKey, kind: 'group' })) {
        const r = p.fn({ chatKey, action: 'check' });
        if (r?.known && r.muted) return true;
      }
    } catch { /* 插件坏了不影响禁言判断 */ }

    const now = Date.now();
    const cached = this.muteCache.get(chatKey);
    if (cached && now - cached.checkedAt < 60000) return cached.muted;
    let muted = false;
    try {
      const groupId = String(chatKey).split(':')[1];
      const selfId = this.onebot?.selfId;
      if (groupId && selfId) {
        const info = await this.onebot.call('get_group_member_info', {
          group_id: Number(groupId), user_id: Number(selfId), no_cache: false
        });
        const shutUp = Number(info?.shut_up_timestamp ?? info?.shutUpTimestamp ?? 0);
        muted = shutUp > 0 && shutUp * 1000 > now;
      }
    } catch {
      muted = false;
    }
    this.muteCache.set(chatKey, { muted, checkedAt: now });
    if (this.muteCache.size > 200) {
      for (const [k, v] of this.muteCache) if (now - v.checkedAt > 600000) this.muteCache.delete(k);
    }
    return muted;
  }

  async wake(chatKey, { proactive = false, proactiveReason = '', waitingSessionId = null } = {}) {    if (this.aborted) {
      this.pendingSessions.delete(chatKey);
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
      return;
    }
    if (this.paused && !proactive) {
      this.pendingSessions.delete(chatKey);
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
      return;
    }
    if (this.runningChats.has(chatKey)) {
      // 亢奋：同群最多 3 路并行；未到上限且有新未读就继续开
      if (isHypeMode()) {
        const n = this.chatRunCount.get(chatKey) || 0;
        if (n < 3 && this.store.unreadCount(chatKey) > 0) {
          // 放行走下面流程
        } else {
          if (waitingSessionId) {
            const s = this.sessions.get(waitingSessionId);
            if (s && s.status === 'waiting') {
              this.pendingSessions.set(chatKey, waitingSessionId);
              this.sessions.current.get(waitingSessionId).waitUntil = Date.now() + 300;
              this.sessions.update(waitingSessionId);
              this.emit('session-update', waitingSessionId);
              setTimeout(() => {
                if (!this.paused && !this.aborted && this.store.unreadCount(chatKey) > 0) {
                  this.scheduleWake(chatKey, 100);
                }
              }, 300);
            }
          }
          return;
        }
      } else {
        // 同会话已在跑：别把 waiting 会话丢成孤儿；稍后再试
        if (waitingSessionId) {
          const s = this.sessions.get(waitingSessionId);
          if (s && s.status === 'waiting') {
            this.pendingSessions.set(chatKey, waitingSessionId);
            this.sessions.current.get(waitingSessionId).waitUntil = Date.now() + 3000;
            this.sessions.update(waitingSessionId);
            this.emit('session-update', waitingSessionId);
            setTimeout(() => {
              if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
                this.scheduleWake(chatKey, 1500);
              }
            }, 3000);
          }
        }
        return;
      }
    }

    // 模型未设置：不产生报错会话，消息保留为未读；设置模型后（下一条消息或手动唤醒）自动补处理
    if (!String(getConfig().api.model || '').trim()) {
      this.pendingSessions.delete(chatKey);
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '模型未设置');
      return;
    }

    // 自己被禁言：**别白跑一轮**（一轮 = 一万多 token 的 prompt + 一次注定失败的发送）。
    // 判据来自 ban-state 插件的能力 `chat.ban-state`（它记的是真实事件）＋ 60 秒缓存的
    // get_group_member_info 兜底 —— 与 0.4 的实现同源；私聊不查。
    if (String(chatKey).startsWith('group:') && await this.#selfMuted(chatKey)) {
      this.pendingSessions.delete(chatKey);
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted', '本群禁言中');
      console.log(`[orchestrator] ${chatKey} 自己被禁言，跳过本轮（消息保留为未读）`);
      return;
    }

    // 全局并发限制：满了就稍后重试（**必须把 waiting 会话放回 pending**，
    // 否则定时器已把它从 pending 摘掉后，UI 会永远停在「等待中·启动…」）
    // 亢奋：多线程并行处理多个会话（上限拉高），普通仍按配置
    const maxRuns = isHypeMode()
      ? 8
      : Math.max(1, Number(getConfig().maxConcurrentRuns) || 2);
    if (this.runningChats.size >= maxRuns) {
      if (waitingSessionId) {
        const s = this.sessions.get(waitingSessionId);
        if (s && s.status === 'waiting') {
          this.sessions.current.get(waitingSessionId).waitUntil = Date.now() + 3000;
          this.sessions.update(waitingSessionId);
          this.emit('session-update', waitingSessionId);
          this.pendingSessions.set(chatKey, waitingSessionId);
          this.pendingWake.add(chatKey);
        }
      }
      setTimeout(() => {
        if (!this.runningChats.has(chatKey) && !this.paused && !this.aborted) {
          // 用短延迟（>0），让 scheduleWake 能沿用/刷新已有 waiting 会话
          this.scheduleWake(chatKey, 1500);
        }
      }, 3000);
      return;
    }

    // ── 档位：先判断"这批消息值不值得回应"，再决定要不要取走未读 ──
    //
    // 关键顺序：判定必须发生在 drainUnread() 之前。
    // drainUnread 会把未读取走并全部置为已读（作为触发批），
    // 如果先取走再判定，未命中时就拿不到"该标记已读"的对象了。
    //
    // 未命中时：标记已读、不创建会话、不调模型 —— 这才是省 token 的关键
    // （消息内容仍留在存档里，日后被艾特时会作为"已读历史"带进提示词）。
    const cfgNow = getConfig();
    // 群聊/私聊各有一套参数；单个群/好友还能在 store.perChat[chatKey] 里单独覆盖。
    // kind 与 chatKey 都要传下去，否则覆盖永远读不到。
    const [kind, chatId] = String(chatKey).split(':');
    const tierScope = {
      selfNickname: cfgNow.persona?.selfNickname || this.onebot.selfNickname || '',
      botName: cfgNow.persona?.botName || '',
      selfId: cfgNow.onebot?.selfId || this.onebot.selfId || '',
      kind: kind === 'private' ? 'private' : 'group',
      chatKey
    };

    // ⚠️ 骰子只能掷一次。
    // 这里曾经掷了两次（一次判定要不要响应、一次决定带多少条历史），
    // 随机档下就会出现"判定命中、记录未命中"：会话带着 tier 0 / 0 条历史
    // 跑完整流程，提示词里还写着"暂无历史记录，这是你第一次参与这个会话"，
    // 而用户看到的是一条标着"未触发"却真的回复了的会话记录。
    // 现在一次结果既用于判定，也用于本次会话的历史条数。
    let tierResult = null;
    let pendingEntries = [];
    if (!proactive) {
      // peekUnread 只看不取，limit 给足以免漏判（判定用的是这批的文本）
      pendingEntries = this.store.peekUnread(chatKey, 200) || [];
      if (pendingEntries.length === 0) {
        if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
        return; // 没有未读就不空跑
      }

      // 档位 3 的骰子要不要退场，取决于「插话判定方式」：Jev 模式下把这批直接交给
      // Jev（resolveContextTier 会返回 randomDeferred），否则照掷。
      // 判断条件见 #jevReplacesDice —— Jev 不可用时会自动退回骰子，不会变成永远沉默。
      const deferRandom = this.#jevReplacesDice(cfgNow);

      tierResult = resolveContextTier({
        triggerEntries: pendingEntries,
        ...tierScope,
        favorMap: this.memory?.favorMap?.() || null,
        botState: (() => { try { return getBotState({ persist: false }); } catch { return null; } })(),
        deferRandom
      });

      const triggerText = pendingEntries.map((entry) => String(entry?.text ?? '')).join('\n');
      const participationExplicit = kind === 'private' || looksLikeExplicitRequest(triggerText);
      const participationAddressed = tierResult?.explicitResponse === true
        || tierResult?.atMe === true
        || ['被艾特', '被叫名字', '拍到我'].includes(tierResult?.reason);
      const participationReplyTargeted = pendingEntries.some((entry) => entry?.reply);
      const participationKeywordHit = tierResult?.keyword === true
        || tierResult?.reason === '关键词命中'
        || hitKeyword(triggerText, scopedStoreConfig(cfgNow.store, tierScope).keywords);
      let participationJev = null;

      // ── 档位 3「要不要响应」：两条路**互斥**，由 replyChance.mode 决定 ──
      //
      // 这里以前是串联的：骰子先掷，没命中再问 Jev 兜底。结果是实际插话率
      // ≈ 概率 + (1−概率)×Jev通过率，比用户设的概率高出一截
      // （实测：会话设 5%、实际约 33%；设 80%、实际约 86%）。
      // 现在改成单选，用户设的那个数才当真：
      //   · mode='jev'（默认）→ resolveContextTier 已返回 randomDeferred，
      //     **骰子一次都没掷**。这批直接交给本地 Jev 判「值不值得接一句」。
      //   · mode='probability'  → 保留纯骰子。
      const jevReady = localJevHasRole('replyChanceGate');

      if (tierResult.randomDeferred === true) {
        // 走到这里时角色理应可用（#jevReplacesDice 已经把"角色被接管"算进条件），
        // 留一道防御：万一运行中角色被关掉，安静跳过总比抛错好。
        if (participationExplicit) {
          tierResult = {
            ...tierResult,
            count: Math.max(1, Number(tierResult.count)
              || Number(scopedStoreConfig(cfgNow.store, tierScope).keywordCount)
              || Number(scopedStoreConfig(cfgNow.store, tierScope).atCount)
              || 8),
            shouldRespond: true,
            reason: `${tierResult.reason || '明确请求'}；明确请求不接受随机/Jev 否决`
          };
        } else if (!jevReady) {
          console.log(`[orchestrator] ${chatKey} 档位 3 已让位给 Jev，但该角色未启用 → 本轮不响应`);
        } else {
          const gate = await this.#tryJevInterject(chatKey, pendingEntries, cfgNow, tierResult.randomPercent, {
            favorUsed: tierResult.favorUsed,
            emotionBonus: tierResult.emotionBonus
          });
          participationJev = gate.jevResult || null;
          if (gate.ok) {
            // 留痕带上意愿/热度/阈值/状态：以后想复核「是不是插多了」，直接从
            // 会话存档的 contextReason 里挖，不用翻日志。
            const it = gate.limits?.intent == null ? '' : `,意愿${Math.round(gate.limits.intent)}%`;
            const h = gate.heat == null ? '' : `,热度${gate.heat.toFixed(2)}`;
            const th = gate.limits?.adaptive ? `/阈值${(gate.limits.minConfidence || 0).toFixed(2)}·上限${gate.limits.maxPerHour}` : '';
            // 好感的「增强响应」不再乘概率，而是压间隔门槛 —— 留痕要看得出这一点，
            // 否则以后排查「为什么同样好感、有时接有时不接」会少一条线索。
            const so = gate.limits?.stateOffset == null
              ? ''
              : `,好感${gate.limits.favorUsed}情绪${gate.limits.emotionBonus >= 0 ? '+' : ''}${gate.limits.emotionBonus}(间隔${gate.limits.stateOffset > 0 ? '+' : ''}${gate.limits.stateOffset.toFixed(2)})`;
            console.log(`[orchestrator] ${chatKey} Jev 判定插嘴 → 出声（p=${(gate.p || 0).toFixed(2)}${it}${h}${th}${so}）`);
            tierResult = {
              tier: 3,
              count: Math.max(1, Number(scopedStoreConfig(cfgNow.store, { kind: tierScope.kind, chatKey }).randomCount) || 8),
              reason: `Jev 判定插嘴(p=${(gate.p || 0).toFixed(2)},间隔=${(gate.margin || 0).toFixed(2)}${it}${h}${so}${gate.channel === 'secondary' ? ',备用' : ''})`,
              shouldRespond: true,
              replyMode: 'interject'
            };
          } else if (gate.reason) {
            console.log(`[orchestrator] ${chatKey} Jev 插嘴判定 → 不出声（${gate.reason}）`);
          }
        }
      } else if (tierResult.tier === 3 && participationExplicit) {
        tierResult = {
          ...tierResult,
          count: Math.max(1, Number(tierResult.count)
            || Number(scopedStoreConfig(cfgNow.store, tierScope).keywordCount)
            || Number(scopedStoreConfig(cfgNow.store, tierScope).atCount)
            || 8),
          shouldRespond: true,
          reason: `${tierResult.reason || '明确请求'}；明确请求不接受随机否决`
        };
      } else if (tierResult.tier === 3 && tierResult.shouldRespond === true) {
        participationJev = { label: 'YES', source: 'probability', p: Number(tierResult.randomPercent) || 0, abstain: false };
        // mode='probability'：骰子命中。**一律过频率闸** ——
        // 老代码只在 gateDice=true 时才管，等于设置页写着「两种方式都生效」、
        // 实际只挡了一半（骰子命中的插话不受任何冷却/上限约束，调高概率就刷屏）。
        // 现在管死：防刷屏优先于概率。
        const { dyn } = this.#interjectLimits(chatKey, cfgNow, null);
        const quota = this.#passInterjectQuota(chatKey, dyn, { stamp: true });
        if (!quota.ok) {
          console.log(`[orchestrator] ${chatKey} 概率档命中但${quota.reason} → 不响应`);
          tierResult = {
            ...tierResult,
            shouldRespond: false,
            randomEligible: false,   // 配额超限 = 本轮到此为止
            reason: `概率档命中但${quota.reason}`
          };
        } else {
          console.log(`[orchestrator] ${chatKey} 概率档命中 → 响应（已占一次插话配额${dyn.adaptive ? `，热度${(dyn.heat ?? 0).toFixed(2)}/上限${dyn.maxPerHour}` : ''}）`);
        }
      }

      // （原来这里是「骰子没命中 → 再问 Jev 兜底」的串联分支，已删除：
      //  Jev 现在是档位 3 的唯一判定方，见上面的 randomDeferred 分支。）

      const participationDecision = decideParticipation({
        text: triggerText,
        explicitRequest: participationExplicit,
        addressed: participationAddressed,
        replyTargeted: participationReplyTargeted,
        keywordHit: participationKeywordHit,
        privateChat: kind === 'private',
        jev: participationJev,
        failureImpact: 'low',
        allowNaturalFallback: true
      });
      tierResult.participationDecision = participationDecision;

      if (participationDecision.action !== 'continue') {
        const marked = this.store.markAllRead(chatKey);
        if (waitingSessionId) this.#discardWaiting(waitingSessionId);
        this.emit('chat-update', chatKey);
        if (marked) {
          console.log(`[orchestrator] ${chatKey} 参与决策为不插话（${participationDecision.reason}），${marked} 条已标记已读`);
        }
        return;
      }

      if (tierResult.shouldRespond === false && participationDecision.route === 'explicit_request') {
        tierResult = {
          ...tierResult,
          count: Math.max(1, Number(tierResult.count)
            || Number(scopedStoreConfig(cfgNow.store, tierScope).keywordCount)
            || Number(scopedStoreConfig(cfgNow.store, tierScope).atCount)
            || 8),
          shouldRespond: true,
          reason: `${tierResult.reason || ''}；参与决策要求继续`
        };
      }

      if (tierResult.shouldRespond === false) {
        // 不响应：沉入历史（已读），不产生会话、不消耗 token。
        // 防抖窗口内后续到达的消息同样是"未读"状态，会在下一次唤醒时
        // 被一起判定 —— 若期间有人艾特机器人，它们会作为已读上下文带上。
        const marked = this.store.markAllRead(chatKey);
        // 关键：让等待会话**干净消失**，而不是标成"中止"留在列表里
        if (waitingSessionId) this.#discardWaiting(waitingSessionId);
        this.emit('chat-update', chatKey);
        if (marked) {
          console.log(`[orchestrator] ${chatKey} ${marked} 条未命中触发条件（档位 ${tierResult.tier}），已标记已读、不响应`);
        }
        return;
      }
    }

    // 触发批：当前所有未读（含之前积压的）—— 到这说明确定要响应了
    let triggerEntries = proactive ? [] : this.store.drainUnread(chatKey);
    if (proactive) {
      // 主动机会：不打扰、无触发批，只带状态
      this.store.drainUnread(chatKey); // 把可能的零星未读一并处理掉
      // 主动开话题没有触发消息，走随机档会掷出"未触发"→ 0 条历史，
      // 等于让机器人对着空白历史硬开场（还会被告知"这是你第一次参与"）。
      // 这里直接按 4 档的条数给，和"自己决定要说话"这件事匹配。
      const sc = scopedStoreConfig(cfgNow.store, { kind: tierScope.kind, chatKey });
      tierResult = { tier: 4, count: Math.max(1, Number(sc.allCount) || 80), reason: '主动机会', shouldRespond: true };
    }
    if (!proactive && triggerEntries.length === 0) {
      this.pendingSessions.delete(chatKey);
      if (waitingSessionId) this.#finishWaiting(waitingSessionId, 'aborted');
      return; // 没有未读就不空跑
    }

    this.#bumpRun(chatKey);
    const seq = (this.runSeq.get(chatKey) || 0) + 1;
    this.runSeq.set(chatKey, seq);

    // 触发摘要
    const first = triggerEntries[0];
    const triggerSummary = proactive
      ? (proactiveReason === 'schedule'
        ? '主动机会（定时私聊）'
        : (String(chatKey).startsWith('private:') ? '主动机会（私聊冷场）' : '主动机会（冷场开话题）'))
      : (first ? `${first.senderName || first.senderId}：${String(first.text || '').slice(0, 40)}` : '');

    // 把“等待中”会话原地转成运行中；没有等待会话（主动/手动唤醒）才新建
    // 真正开跑：从 pending 摘掉
    this.pendingSessions.delete(chatKey);
    let session = waitingSessionId ? this.sessions.get(waitingSessionId) : null;
    if (session && session.status === 'waiting') {
      this.sessions.current.get(waitingSessionId).status = 'running';
      this.sessions.current.get(waitingSessionId).waitUntil = null;
      this.sessions.current.get(waitingSessionId).trigger = triggerEntries;
      this.sessions.current.get(waitingSessionId).triggerSummary = triggerSummary;
      this.sessions.current.get(waitingSessionId).triggerText = triggerEntries.map((m) => `${m.senderName || m.senderId}: ${String(m.text || '').slice(0, 80)}`).join(' | ').slice(0, 500);
      this.sessions.update(waitingSessionId);
      this.emit('session-update', waitingSessionId);
      session = this.sessions.current.get(waitingSessionId);
    } else {
      session = this.sessions.create({ chatKey, trigger: triggerEntries, triggerSummary });
      this.emit('session-start', { sessionId: session.id, chatKey, triggerSummary });
    }
    this.#trackRun(chatKey, session.id);
    this.emit('chat-update', chatKey);

    // ── 会话级重试 ──
    // 单次 API 请求内部已经会重试（见 chatCompletionWithRetry），
    // 这里处理的是"整轮都救不回来"的情况：清干净上下文从头再来一次。
    //
    // ⚠️ 只在**一次都没发出过消息**时才重试 —— 否则重试会导致重复发言。
    // 已经说过话的会话宁可记为 error，也不能让群里看到两遍同样的话。
    const MAX_SESSION_ATTEMPTS = 3;   // 用户要求：自行重试两次，两次都失败才停
    let lastError = null;
    try {
      for (let attempt = 1; attempt <= MAX_SESSION_ATTEMPTS; attempt++) {
        try {
          await this.#runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, proactiveReason, seq, contextLimit: tierResult.count, tierInfo: tierResult });
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          const sentCount = (session.sent || []).length;
          const canRetry = attempt < MAX_SESSION_ATTEMPTS
            && isRetryableError(error)
            && sentCount === 0
            && !this.aborted;
          if (!canRetry) break;

          // 为重试准备干净的上下文：清掉本轮残留，避免脏状态影响下一次
          const wait = 1000 * Math.pow(2, attempt - 1);   // 1s, 2s
          console.warn(`[orchestrator] 会话 ${session.id} 第 ${attempt} 次失败（未发出任何消息），${wait}ms 后重试：${error?.message ?? error}`);
          this.#resetSessionForRetry(session);
          session.activity = `出错重试 ${attempt}/${MAX_SESSION_ATTEMPTS - 1}…`;
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
          await new Promise((r) => setTimeout(r, wait));
        }
      }

      if (lastError) {
        session.error = String(lastError?.message ?? lastError);
        this.sessions.finish(session.id, 'error');
        this.emit('session-end', { sessionId: session.id, chatKey, status: 'error', error: session.error });
        console.error(`[orchestrator] 运行 ${session.id} 出错:`, lastError);
      }
    } finally {
      this.#untrackRun(chatKey, session.id);
      this.#dropRun(chatKey);
      // ── 一轮说完话了：这一串的「整串预算」重新起算 ──
      //
      // 为什么必须在**运行结束时**（而不是开始时）重置 burstStart：
      // 预算是从"这一串第一条消息"起算的（见 #burstDelayMs）。如果一口气聊了 7 秒
      // 还没跑完一轮，那轮跑完时预算只剩不到 1 秒 —— 紧接着来的消息只分到几百毫秒
      // 窗口，等于刚回完话就立刻又开一轮，还是"每条各跑一遍"。
      //
      // 语义上也该如此：机器人回过话之后，这一轮交流已经被处理掉了，
      // 接着来的消息是新的一段 —— 该重新拿到完整的 settle 窗口。
      // ⚠️ 只重置 burstStart，**不要动 lastMsgAt**：它记的是真·入站消息时间，
      // 用来判断"这一串有没有真的断掉（间隔 > idle）"，动了会让断串判断失真。
      this.burstStart.set(chatKey, Date.now());
      this.emit('chat-update', chatKey);
    }

    // drain：运行期间来的新消息 → 再次新开会话处理（这是"确保看到所有发言"的关键）
    if (!this.aborted && !this.paused) {
      const unread = this.store.unreadCount(chatKey);
      if (unread > 0) {
        const drainDelay = isHypeMode()
          ? 100
          : Math.max(200, Number(getConfig().drainDelayMs) || 1200);
        this.scheduleWake(chatKey, drainDelay);
      }
    }

    // 记忆自动整理（后台静默，绝不阻塞/影响聊天主流程）
    this.#maybeConsolidateMemory(chatKey);
  }

  /**
   * 为会话重试清理累积状态。
   *
   * 调用前必须确保 session.sent 为空（没发出过任何消息），否则重试会重复发言。
   * #runAgent 本身会重建 messages / 提示词，所以这里只需清掉上一轮留下的痕迹，
   * 避免脏状态（半截的 messages、重复累加的 usage/error）带进下一次尝试。
   */
  #resetSessionForRetry(session) {
    const live = this.sessions.current.get(session.id) || session;
    live.messages = [];
    live.sent = [];
    live.feedbacks = [];
    live.rounds = 0;
    live.error = null;
    live.finishReason = null;
    live.activity = '';
    live.inputMessages = [];
    live.usage = { promptTokens: 0, completionTokens: 0, cachedTokens: 0, cacheCreationTokens: 0, totalTokens: 0, calls: 0 };
    this.sessions.update(session.id);
    this.emit('session-update', session.id);
  }

  /**
   * 算这一轮插话该用的闸门参数（含群活跃度自适应 + 插话意愿折算），
   * 并顺带返回最近窗口的消息。
   *
   * 抽出来是因为**两条路径**都要用：Jev 判定那条（mode='jev'），
   * 以及概率骰子命中那条（mode='probability'）。两边各算一份的话，
   * 热度口径会漂，配额也会各记各的。
   *
   * dicePercent = 当前会话设的响应概率。传 null 表示不折算意愿
   * —— 概率骰子那条路径用不上它（骰子本身就是概率）。
   *
   * state = { favorUsed, emotionBonus }，由 resolveContextTier 透传过来。
   * 注意它只在 Jev 模式下有值（prompt.js 里 favor/情绪不再改 randomPercent 了），
   * 骰子模式传 null —— 那条路径的好感仍按老办法乘在概率上。
   */
  #interjectLimits(chatKey, cfgNow, dicePercent = null, state = null) {
    const rc = cfgNow.localJev?.replyChance || {};
    const ad = rc.adaptive || {};
    const windowSize = Math.max(10, Math.min(200, Number(ad.windowSize) || 40));
    const win = this.store.recent(chatKey, { limit: windowSize });
    // adaptive 关掉时 heat 传 null → resolveReplyChanceParams 原样回退基准值，
    // 行为与引入自适应之前完全一致（可一键 A/B）。
    const heat = ad.enabled === false ? null : computeGroupHeat(win, {
      now: Date.now(),
      windowMinutes: ad.windowMinutes,
      fullRate: ad.fullRate,
      fullSpeakers: ad.fullSpeakers
    }).heat;
    return { win, dyn: resolveReplyChanceParams(rc, heat, dicePercent, state) };
  }

  /**
   * 过一遍频率闸（冷却 + 每小时上限），并把记账写回。
   * `stamp` 为真时表示「这一轮确定要插话」，顺手占用一次配额。
   */
  #passInterjectQuota(chatKey, dyn, { stamp = false } = {}) {
    const now = Date.now();
    const q = checkInterjectQuota({
      now,
      lastAt: this.interjectAt.get(chatKey) || 0,
      times: this.interjectTimes,
      cooldownMs: dyn.cooldownMs,
      maxPerHour: dyn.maxPerHour
    });
    this.interjectTimes = q.times;   // 顺手清掉过期项
    if (!q.ok) return q;
    if (stamp) {
      this.interjectAt.set(chatKey, now);
      this.interjectTimes.push(now);
    }
    return q;
  }

  /**
   * 「这轮该不该主动接一句」—— 档位 3 的判定方（骰子已退场）。
   *
   * 只做四件事：算群活跃度 + 意愿 → 冷却/次数闸 → 问一次 Jev → 记时间。
   * 任何失败都返回 ok:false（=不响应），绝不让可选功能把判定搞崩。
   *
   * 门槛由两层合成：
   *   · 群活跃度（heat 越高越克制）：抬 minConfidence / minMargin，拉长冷却、压低上限
   *   · 插话意愿（dicePercent，即会话里设的响应概率）：概率越低门槛越高，越挑
   * 再叠一层状态偏移：
   *   · 好感 / 情绪（state）：**只压 minMargin**，好感高或心情好就更愿意接一句。
   *     它们不再乘 randomPercent（那样在低意愿区几乎无效，见 local-jev.js 的常量注释）。
   */
  async #tryJevInterject(chatKey, entries, cfgNow, dicePercent = null, state = null) {
    const { win, dyn } = this.#interjectLimits(chatKey, cfgNow, dicePercent, state);

    const quota = this.#passInterjectQuota(chatKey, dyn, { stamp: false });
    if (!quota.ok) return { ok: false, reason: quota.reason, jevResult: null };
    const text = (entries || []).map((e) => String(e?.text ?? '')).join('\n').trim();
    if (!text) return { ok: false, reason: '无文本内容（纯图片/表情）', jevResult: null };
    // 带上最后几句作为背景，帮它判断「是不是在接着刚才的话题」
    const recent = win.slice(-4)
      .map((m) => `${m.self ? '我' : m.senderName || '对方'}：${String(m.text || '').slice(0, 40)}`)
      .join(' | ');
    const r = await jevReplyChance({ text, recent, limits: dyn })
      .catch((error) => ({ speak: false, reason: String(error?.message ?? error), error: String(error?.message ?? error) }));
    if (!r?.speak) {
      return { ok: false, reason: r?.reason || (r?.error ? 'Jev 故障' : r?.abstain ? '弃权' : '判 NO'), jevResult: r || null };
    }
    this.interjectAt.set(chatKey, Date.now());
    this.interjectTimes.push(Date.now());
    return { ok: true, p: r.p, margin: r.margin, channel: r.channel, label: r.label, ms: r.ms, heat: dyn.heat, limits: dyn, jevResult: r };
  }

  /**
   * 运行结束后按概率挑一张表情发出去（把"要不要配表情"从主循环里拿出来）。
   *
   * 设计要点：
   *   - 概率控制（sticker.autoPick.probability），不是每次都发；不喜欢就调成 0 关掉。
   *   - 只问"挑哪张"，不问"要不要说话" —— 一次极小的调用（max_tokens 24），小模型也扛得住。
   *   - 模型回 none 或回了个库里没有的 id 就什么都不发（宁可不发，也不发错）。
   *   - 每个会话有冷却（autoPick.cooldownMs），免得连着几轮都挂表情。
   */
  async #maybeAutoSticker(session, chatKey, kind, chatId) {
    const cfg = getConfig();
    const ap = cfg.sticker?.autoPick || {};
    // ⚠️ 必须显式开启：这是"额外一次模型调用"，默认关。
    //    写成 `!== false` 会把没配过的账号也带上一个随机调用（测试里立刻炸出偶发失败）。
    if (ap.enabled !== true) return;
    if (cfg.sticker?.enabled === false) return;
    const prob = Math.max(0, Math.min(1, Number(ap.probability ?? 0.35)));
    // 别人**明确要表情**时，概率直接拉满（不然"来张表情包"只能回一句干话）。
    // 词表没写全的说法（"整个抽象的来"）由本地 Jev stickerAskGate 在唤醒阶段补判。
    const asked = /(发|来|给|换|整个|甩|贴)[^。！？\n]{0,6}(表情|表情包|贴图)|表情包?(来|呢|吧)|要个?表情/.test(String(session.triggerText || ''))
      || session.jevGates?.stickerAsk === true;
    if (!asked && !(prob > 0)) return;
    if (!asked && Math.random() >= prob) return;
    const cooldown = Math.max(0, Number(ap.cooldownMs ?? 120000));
    const last = this.autoStickerAt.get(chatKey) || 0;
    if (cooldown && Date.now() - last < cooldown) return;

    const entries = this.stickers.entries || [];
    if (!entries.length) return;
    const shortlist = Math.max(3, Math.min(12, Number(ap.shortlist) || 8));
    const table = buildStickerContext(entries, shortlist, {
      rotatePeriodMs: Math.max(60000, Number(cfg.sticker?.rotatePeriodMin) || 60) * 60000,
      cooldownMs: Math.max(0, Number(cfg.sticker?.cooldownMin) || 0) * 60000,
      keepFamiliar: cfg.sticker?.keepFamiliar
    });
    if (!table) return;

    // ⚠️ 必须让模型回**序号**，不能让回 id：
    // QQ 收藏的 id 是 90 个字符（10000002_0_0_1_858C…_247224_6948…），
    // 弱模型背不出表情清单；回个数字再校验序号更稳。
    const ids = [...table.matchAll(/id=(\S+)/g)].map((m) => m[1]);
    if (!ids.length) return;
    const labels = [...table.matchAll(/^[-–•]?\s*(.+?)\s+id=(\S+)$/gm)].map((m) => m[1]);
    const numbered = ids.map((id, i) => `${i + 1}. ${labels[i] || id.slice(0, 24)}`).join('\n');

    // 刚才那几句：用户说了什么 + 自己回了什么
    const recent = this.store.recent(chatKey, { limit: 6 })
      .map((m) => `${m.self ? '我' : m.senderName || '对方'}：${String(m.text || '').slice(0, 80)}`)
      .join('\n');

    // 「从候选里挑一个序号」是 Jev 的教科书活：固定枚举、超高频、不需要生成一个字。
    // 原来这一步走云端工具调用 + 600 输出预算，只为拿回一个数字。
    let num = null;
    if (localJevHasRole('stickerPickGate')) {
      const pick = await jevStickerPick({
        candidates: ids.map((id, i) => labels[i] || id.slice(0, 24)),
        recent
      });
      // 判得出来（含明确的 0=都不合适）就用它；弃权/失败再回云端
      if (!pick.error && !pick.abstain) num = pick.index;
    }
    if (num === null) {
      const res = await chatCompletion({
        messages: [
          {
            role: 'system',
            content: '你在给 QQ 群聊配一张收藏表情。看最后几句对话，从候选里挑最贴切的一张。'
              + '用 pick_sticker 工具回答，index 填候选序号；都不合适就填 0。不要输出别的。'
          },
          { role: 'user', content: `【候选表情】\n${numbered}\n\n【刚才的对话】\n${recent}` }
        ],
        // ⚠️ 必须走**工具调用**而不是让它回正文：弱模型的纯文本回答常被"思考"
        //    吃光输出预算，回回来是空串（15/15 全废）；换成工具调用就稳了。
        tools: [{
          type: 'function',
          function: {
            name: 'pick_sticker',
            description: '从候选表情里挑一张最贴切的',
            parameters: {
              type: 'object',
              properties: { index: { type: 'integer', description: '候选序号（1 开始）；都不合适填 0' } },
              required: ['index']
            }
          }
        }],
        toolChoice: 'auto',
        temperature: 0.3,
        // 只是从候选里挑一张，不需要思考：显式关掉思考（远程模型开着 thinking_budget 时
        // 免得把 600 的预算烧在思考上变成空回复）。
        overrides: apiWith({ maxTokens: 600, disableThinking: true })
      });
      const call = (res?.message?.tool_calls || [])[0];
      try { num = Number(JSON.parse(call?.function?.arguments || '{}').index); } catch { num = NaN; }
    }
    if (!Number.isInteger(num) || num < 1 || num > ids.length) return;
    const sticker = await this.stickers.find(ids[num - 1]);
    if (!sticker?.url) return;

    // ⚠️ 2026-09-22（用户反馈"表情包发不出去"）：这一段原来失败是**彻底静默**的 ——
    //   取 payload 抛错就 `catch { return; }`，发送结果也不看。
    //   而表情库里很大一部分是 QQ 的临时链接（rkey 约 1 小时过期），"挑好了却没发出去"
    //   多半就是这里：链接过期 → 拉取失败 → 直接 return，日志没有、会话页看不到、
    //   用户只能看到"它像是不想发表情"。现在：失败记日志 + 换一张备胎重试一次。
    let payload = null;
    let usedSticker = sticker;
    try {
      payload = await this.stickers.stickerPayload(sticker);
    } catch (error) {
      console.warn(`[orchestrator] 自动表情取图失败（${sticker.id}）：${error?.message ?? error}，尝试换一张`);
    }
    if (!payload) {
      // 备胎：随便换一张还能用的（tools.js 里工具链同一套思路）
      const altId = ids.map((id) => id).find((id) => id !== sticker.id);
      if (altId) {
        const alt = await this.stickers.find(altId).catch(() => null);
        if (alt?.url) {
          try {
            payload = await this.stickers.stickerPayload(alt);
            usedSticker = alt;
          } catch (error) {
            console.warn(`[orchestrator] 自动表情备胎也失败（${alt.id}）：${error?.message ?? error}`);
          }
        }
      }
    }
    if (!payload) {
      this.autoStickerAt.set(chatKey, Date.now());   // 记冷却，别在同一条坏表情上反复试
      this.emit('session-update', session.id);
      return;
    }
    const result = await this.sender.sendSticker(chatKey, usedSticker, {}, payload);
    if (result?.ok === false || result?.error) {
      console.warn(`[orchestrator] 自动表情发送失败（${usedSticker.id}）：${result?.error ?? result?.message ?? '未知'}`);
    }
    this.autoStickerAt.set(chatKey, Date.now());
    session.sent.push({
      type: 'sticker',
      text: `[表情包:${usedSticker.desc || usedSticker.localNote || usedSticker.id}]`,
      at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
    });
    this.stickers.markUsed(usedSticker.id, String(session.triggerText || '').slice(0, 100));
    this.sessions.update(session.id);
    this.emit('session-update', session.id);
    console.log(`[orchestrator] ${chatKey} 自动配了一张表情（${usedSticker.id}）msgId=${result?.message_id ?? '-'}`);
  }

  async #runAgent(session, { kind, chatId, chatKey, triggerEntries, proactive, proactiveReason = '', seq, contextLimit = null, tierInfo = null }) {
    const cfg = getConfig();
    const runContext = createRunContext({
      preDecisionBudgetMs: Number(cfg.localJev?.gateBudgetMs) || 1500,
      deadlineMs: Number(cfg.api?.runDeadlineMs) || 120000
    });
    const trace = process.env.QQ_AGENT_TRACE === '1' ? (m) => console.log(`[trace ${chatKey}] ${m}`) : () => {};
    trace('run start');
    // 扩展：组提示词前加工触发内容（原地）
    await hookBeforeContext({ triggerEntries, session, chatKey, kind, chatId, store: this.store, memory: this.memory });
    trace('hookBeforeContext done');
    const chatName = kind === 'group' ? await this.#chatName(chatId) : '';
    trace('chatName done');
    const selfNickname = kind === 'group' ? (cfg.persona.selfNickname || this.onebot.selfNickname || cfg.persona.botName) : cfg.persona.botName;

    // 上下文统计
    const tenMinAgo = Date.now() - 600000;
    const recentCount = this.store.recent(chatKey, { limit: 200 }).filter((m) => m.ts >= tenMinAgo).length;
    const myMessages = this.store.recent(chatKey, { limit: 100 }).filter((m) => m.self);
    const selfLastMessageAt = myMessages.length ? myMessages[myMessages.length - 1].ts : 0;
    const lastMessageAt = (() => {
      const all = this.store.recent(chatKey, { limit: 10 });
      return all.length ? all[all.length - 1].ts : Date.now();
    })();

    // 表情库：优先吃内存缓存，不阻塞思考；后台再同步
    let stickerEntries = [];
    if (cfg.sticker?.enabled !== false) {
      stickerEntries = this.stickers?.entries || [];
      // 不 await：同步失败/慢也不拖本轮；TTL 内 sync 会直接返回缓存
      this.stickers?.sync(false)?.catch?.(() => {});
    }

    // 组装提示词（无 LLM 历史）。缓存只保留一个真正稳定的断点：
    //   system = 系统规则 + 角色卡/静态规则；user = 会话、历史、时间、本次唤醒。
    // 旧版还给“冷历史”打第二个显式标记，但 QQ 聊天往往隔过百炼固定的 5 分钟 TTL，
    // 下一次只会按 125% 重新创建，实测第二层创建费大于命中收益，故彻底移除。
    // implicit 不发标记，交给服务端自动前缀缓存；explicit 只标 system 一处。
    const cacheMode = resolveCacheMode(cfg.api);
    const cacheFriendlyLayout = cacheMode !== 'off';
    const staticBlock = cacheFriendlyLayout ? buildStaticPersonaBlock() : '';
    const systemPrompt = buildSystemPrompt();
    // 千问显式缓存：前缀差一个字节就不命中 → 去掉首尾空白/多余换行
    let systemText = (staticBlock ? `${systemPrompt}\n\n${staticBlock}` : systemPrompt).replace(/\s+$/, '');
    if (!systemText.endsWith('\n')) systemText += '\n';

    // 近24h摘要是会话动态信息，绝不能拼进全局 system 缓存前缀。
    const digestSc0 = scopedStoreConfig(cfg.store, { kind, chatKey });
    let recentDigest = '';
    if (digestSc0?.recent24hDigest?.enabled === true && cfg.api?.conversationMemory?.enabled !== false) {
      recentDigest = this.#hourDigest(chatKey, digestSc0.recent24hDigest) || '';
    }
    // 跨轮触发文本（记忆/图库等门控共用）
    const triggerJoined = (triggerEntries || []).map((m) => String(m?.text ?? '')).join('\n');

    // 工具白名单（null = 没配白名单 = 全开）：图库/记忆类门控都要看它
    const memWl = Array.isArray(cfg.api?.tools) && cfg.api.tools.length
      ? new Set(cfg.api.tools.map(String))
      : null;

    // ── 本地 Jev 前置门控 ──    // 词表先判；只有词表**没命中**的题才丢给 Jev 补问（OR 语义：只加强、绝不削弱词表结果）。
    // 补问并发跑（本地模型 CPU 上每问 ~250-500ms，串行四个就把主流程拖两秒）。
    // 概率低于阈值 → abstain → 保持词表结果。
    const participationExplicit = kind === 'private' || looksLikeExplicitRequest(triggerJoined);
    const participationDecision = tierInfo?.participationDecision || decideParticipation({
      text: triggerJoined,
      explicitRequest: participationExplicit,
      addressed: tierInfo?.explicitResponse === true
        || tierInfo?.atMe === true
        || ['被艾特', '被叫名字', '拍到我'].includes(tierInfo?.reason),
      replyTargeted: triggerEntries?.some((m) => m?.reply) === true,
      keywordHit: tierInfo?.keyword === true
        || tierInfo?.reason === '关键词命中'
        || hitKeyword(triggerJoined, scopedStoreConfig(cfg.store, { kind, chatKey }).keywords),
      privateChat: kind === 'private',
      failureImpact: 'low',
      allowNaturalFallback: true
    });
    const participationRoute = participationDecision.route;
    session.participationDecision = participationDecision;
    const memoryKeywordHit = wantsMemoryRecall(triggerJoined);
    const memoryExplicitRequest = participationExplicit
      && /(记|忘|消息|聊天|提醒|记忆|搜|查|找)/i.test(triggerJoined);
    let memoryRecallDecision = decideMemoryRecall({
      explicitRequest: memoryExplicitRequest,
      keywordHit: memoryKeywordHit
    });
    let memoryRecallWant = memoryRecallDecision.active;
    let cueImageLib = false;
    const imageLibAllowed = cfg.knowledge?.images?.autoCueSelf !== false
      && (!memWl || memWl.has('image_lib_search') || memWl.has('image_lib_send'));
    if (imageLibAllowed) cueImageLib = shouldCueImageLib(triggerJoined);
    let imageWantsWant = wantsImage(triggerJoined);
    let stickerAskWant = false;   // 交给 #maybeAutoSticker 自己的正则先判，这里只补漏
    let imageWantsVeto = false;   // Jev 明确说"不是要图" → 压掉词表命中

    // ⚠️ 2026-09-22（用户反馈"判定要搜图的次数太多"）：
    //   原来这里是"只加不减"—— 词表命中就**跳过** Jev，Jev 只能把 false 补成 true，
    //   永远不能否决。而 wantsImage 的正则其实挺松（"帮我查下图片格式""截图发我看看"
    //   都可能命中），一旦命中，prompt 里会注入一条【本轮有人要图·硬要求】
    //   "必须真的去找图并发出，不允许只用文字回答" → 每命中一次就强制走一遍搜索+发送。
    //   现在：词表命中时也问一次 Jev，它明确说 NO 就把这次命中压掉（弃权/超时=维持词表结论，
    //   所以对"真在要图"的轮次没有副作用）。
    //   另外加一层 per-chat 冷却：同一个会话 10 分钟内只允许一次"主动找图"，
    //   免得连着几轮都在搜图。
    const IMAGE_WANTS_COOLDOWN_MS = 10 * 60 * 1000;
    const lastImageWantsAt = Number(this.imageWantsAt?.get(chatKey)) || 0;
    const imageWantsCooling = Date.now() - lastImageWantsAt < IMAGE_WANTS_COOLDOWN_MS;

    if (triggerJoined.trim()) {
      const probe = triggerJoined.slice(0, 300);
      trace('jev gates start');
      const gates = await jevGateBundle({
        ...(memoryRecallDecision.required ? {} : { memoryRecallGate: probe }),
        ...(!imageLibAllowed || cueImageLib ? {} : { imageCueGate: probe }),
        // 词表命中时也要问（要的就是它能否决）；没命中时问它是为了补漏
        ...(imageWantsCooling ? {} : { imageWantsGate: probe }),
        // 自动配表情没开的话，问「他在要表情吗」判 YES 也没人用 —— 别白花时间
        ...(cfg.sticker?.autoPick?.enabled === true ? { stickerAskGate: probe } : {})
      }, { runContext, budgetMs: Number(cfg.localJev?.gateBudgetMs) || 1500 }).catch(() => ({}));
      const on = (r) => !!r && r.on === true;
      memoryRecallDecision = decideMemoryRecall({
        explicitRequest: memoryExplicitRequest,
        keywordHit: memoryKeywordHit,
        jev: gates.memoryRecallGate
      });
      memoryRecallWant = memoryRecallDecision.active;
      if (on(gates.memoryRecallGate)) console.log(`[orchestrator] localJev 记忆门控 YES（p=${gates.memoryRecallGate.p?.toFixed(2)}）`);
      if (imageLibAllowed && !cueImageLib && on(gates.imageCueGate)) cueImageLib = true;
      const wantsGate = gates.imageWantsGate;
      const imageJevCanVeto = participationRoute !== 'explicit_request';
      if (imageJevCanVeto && wantsGate && wantsGate.on === false && wantsGate.abstain !== true && wantsGate.label === 'NO' && imageWantsWant) {
        // Jev 与词表矛盾，且它是明确表态（不是弃权）→ 以 Jev 为准，压掉这次"要图"
        imageWantsWant = false;
        imageWantsVeto = true;
        console.log('[orchestrator] 要图门控 NO：词表命中但 Jev 判不是要图，已压掉硬要求');
      } else if (!imageWantsWant && on(wantsGate)) {
        imageWantsWant = true;
        console.log(`[orchestrator] localJev 要图门控 YES（词表未命中，p=${wantsGate.p?.toFixed(2)}）`);
      }
      if (on(gates.stickerAskGate)) stickerAskWant = true;
      session.jevGates = { imageWants: imageWantsWant, stickerAsk: stickerAskWant, imageWantsVeto, participationRoute };
      trace('jev gates done');
    }
    if (imageWantsWant) {
      // 记下"这一会话刚找过图"，接下来 10 分钟不再主动触发
      if (!this.imageWantsAt) this.imageWantsAt = new Map();
      this.imageWantsAt.set(chatKey, Date.now());
    }

    // 印象补选（本地 Jev）：每人只注入 2 条，落榜的那条在丢之前问一次"跟现在这句话有关吗"。
    // 为什么不在 memory.js 里直接问：formatForPrompt 是同步函数，主链路里已经有一堆 await。
    // 实测价值：群友点名要歌时，被挤掉的正是「推歌只推古典、摇滚、OST」那条。
    // 失败/超时/没开角色 = 什么都不补，保持原样（prompt 里 picks 为 null）。
    let memoryPicks = null;
    try {
      const pickIds = relevantSpeakerIds(triggerEntries, []);
      if (pickIds.length) {
        memoryPicks = await this.memory.topicPicks(chatKey, {
          userIds: pickIds,
          topic: (triggerEntries || []).map((m) => String(m?.text ?? '')).filter(Boolean),
          maxEach: 2,
          maxCalls: 3,
          timeoutMs: 1500
        });
        if (!memoryPicks?.size) memoryPicks = null;
      }
    } catch { /* 本地判定失败不影响主流程 */ }

    const promptParts = buildUserPromptParts({
      chatKey, kind, chatId, chatName,
      triggerEntries,
      store: this.store,
      memory: this.memory,
      stickerEntries,
      selfNickname,
      // 自己的 QQ 号必须显式传：config.onebot.selfId 从来不落盘（一直 undefined），
      // 只靠配置的话提示词里会写成「你是 QQ ?」，而规则又要求"被@以 QQ 号为准"
      // —— 模型只能靠会改的名片猜自己是谁，"是不是在跟我说话"基本靠蒙。
      selfId: cfg.onebot?.selfId || this.onebot.selfId || '',
      selfLastMessageAt,
      lastMessageAt,
      recentCount,
      runSeq: seq,
      moreUnreadDuringRun: this.store.unreadCount(chatKey) > 0,
      proactive,
      contextLimit,
      tierInfo,
      hoistStatic: cacheFriendlyLayout,
      // Jev/词表增强结果（prompt 内同步读取）
      memoryRecallWant,
      imageWantsWant,
      cueImageLib,
      memoryPicks
    });
    const replyPolicy = localReplyPolicy(cfg.api, triggerEntries);
    trace('prompt built');
    // 自动收尾的引导语：对 autoFinish 生效
    // ⚠️ 静态那段（分条格式说明）在缓存布局下已经进了 system 静态块
    //    （见 prompt.js buildStaticPersonaBlock），这里只补动态的"复杂任务"那句；
    //    不这么切的话，同一段话每轮都在标记之后按原价重算一遍。
    const replyGuideDynamic = replyPolicy.enabled && replyPolicy.complex
      ? '\n【本次分析任务】允许把必要的答案和理由讲完整，分几条发；增加的是内部生成预算，不要求写长文。'
      : '';
    const replyGuide = cacheFriendlyLayout
      ? (replyGuideDynamic ? `\n${replyGuideDynamic.trimStart()}` : '')
      : `\n\n【本次回复方式】要说的话请**一次**放进 send_message 的 messages 数组；可以同时调其它发送/查询工具。`
        + `先查完再一起发；发完系统自动结束本轮（**没有 finish 工具**）。`
        + `不想说话就什么都不调。`
        + `要分两条时参数直接写 {"messages":["第一条完整内容","第二条完整内容"]}。`
        + (replyGuideDynamic ? `\n${replyGuideDynamic.trimStart()}` : '');
    promptParts.all += replyGuide;
    promptParts.volatile += replyGuide;

    // 全局本体状态：精力/心情/社交电池（跨群一份）
    try {
      const stateLine = botStatePromptLine(getBotState({ persist: false }));
      if (stateLine) {
        promptParts.all += `\n${stateLine}`;
        promptParts.volatile += `\n${stateLine}`;
      }
    } catch { /* ignore */ }

    // 被动预检索：句式像在问旧事时，本地先搜一把，把碎片塞进提示词。
    // 这样即使模型「想不起来要用工具」，也已经看到线索；它仍可再 memory_search 深挖。
    const memSearchOn = cfg.api?.conversationMemory?.enabled !== false
      && (!memWl || memWl.has('memory_search'));
    if (
      memSearchOn
      && cfg.api?.memoryAutoPrefetch !== false
      && memoryRecallWant
    ) {
      try {
        const triggerText = triggerJoined;
        const query = memoryRecallQuery(triggerText);
        if (query) {
          const cm = getConversationMemory();
          // 用完整触发句搜：便于识别「昨天/中午/晚上」做时间偏好
          const hits = cm.search(triggerText, {
            chatKey: null, // 跨群：旧事可能发生在别的会话
            limit: 2,
            maxSnippets: 1
          });
          if (hits?.length) {
            const brief = hits.slice(0, 2).map((h) => {
              const sn = (h.snippets || []).slice(0, 1)
                .map((s) => `${s.self ? '我' : s.who}: ${s.text.slice(0, 40)}`)
                .join('');
              const from = h.chatKey && h.chatKey !== chatKey ? `@${h.chatKey} ` : '';
              return `${from}${h.hourKey || h.dayKey}: ${sn}`;
            }).join(' | ');
            const inject = `\n【预检索】「${query}」→ ${brief}（线索；不够再 memory_search，别编旧事）`;
            promptParts.all += inject;
            promptParts.volatile += inject;
          } else {
            const inject = `\n【预检索】「${query}」无命中。可再 memory_search；没有就承认想不起来。`;
            promptParts.all += inject;
            promptParts.volatile += inject;
          }
        }
      } catch (error) {
        console.log(`[orchestrator] ${chatKey} 预检索失败（忽略）: ${error?.message ?? error}`);
      }
    }

    // 网络热梗预查：用户明确问“这是什么梗/什么意思/哪里火的”时，先查一次现网。
    // 旧知识里的梗会过期，凭印象硬猜最容易“一本正经说错”；预查结果只是来源材料，
    // 模型仍按角色卡组织回答。稳定的解释再让模型用 memory_meme_save 沉淀。
    const webSearchOn = cfg.webSearch?.enabled !== false
      && (!memWl || memWl.has('web_search'));
    if (webSearchOn && cfg.api?.hotMemeAutoPrefetch !== false && isHotMemeQuestion(triggerJoined)) {
      const query = memeSearchQuery(triggerJoined);
      if (query) {
        try {
          const timeoutMs = Math.max(1500, Math.min(15000, Number(cfg.webSearch?.hotMemePrefetchTimeoutMs) || 6000));
          let timer = null;
          const searched = await Promise.race([
            webSearch(query),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); })
          ]);
          if (timer) clearTimeout(timer);
          const results = Array.isArray(searched?.results) ? searched.results.slice(0, 3) : [];
          const nativeAnswer = String(searched?.answer || searched?.content || '').trim().slice(0, 600);
          const brief = results.map((r, i) => `${i + 1}. ${String(r?.title || '').slice(0, 80)}：${String(r?.snippet || '').replace(/\s+/g, ' ').slice(0, 180)}${r?.url ? `（${r.url}）` : ''}`).join('\n');
          if (nativeAnswer || brief) {
            const inject = `\n【网络热梗预查】问题：${triggerJoined.slice(0, 120)}\n`
              + `${nativeAnswer ? `联网摘要：${nativeAnswer}\n` : ''}${brief ? `来源摘录：\n${brief}\n` : ''}`
              + '请以联网材料为准解释含义/出处/传播过程，不确定就明说；禁止拿旧知识覆盖新来源。'
              + '若这是以后还会复用的稳定热梗，调用 memory_meme_save(text=短原文, note=一句含义/出处)。';
            promptParts.all += inject;
            promptParts.volatile += inject;
            session.hotMemePrefetched = 1;
          } else {
            session.hotMemePrefetched = 0;
          }
        } catch (error) {
          session.hotMemePrefetchError = String(error?.message ?? error).slice(0, 200);
          console.log(`[orchestrator] ${chatKey} 网络热梗预查失败（忽略）: ${error?.message ?? error}`);
        }
      }
    }

    // 梗库：先过「场合闸」，再查库，最后**只给一条**（2026-09-22 重做）
    //
    // 为什么先过场合闸：868 轮真实留档实测 —— 线上闪梗的 193 轮里 **72% 根本没有接梗/玩闹信号**
    // （在报错、点歌、发广告时也闪），而有信号的 153 轮里 **65% 压根没闪**，交集只有 54 轮；
    // 模型对闪过的梗采用率 **0/193**。老判据是"梗正文和触发句字面撞上"，跟"这轮该不该玩梗"
    // 是两件事 —— 梗在不需要的时机到达，模型当然不用。
    // 场合判据就是既有的词表（looksMemeCue/looksPlayfulCue，本来用于校验模型标的接梗/玩闹），
    // 免费、同步、零延迟。接上之后时机对齐率 28% → 100%，闪梗轮次反而略降（193 → ≈153）。
    if (
      cfg.api?.memeAutoCue !== false
      && (!memWl || memWl.has('memory_meme_search') || memWl.has('memory_meme_save'))
    ) {
      try {
        // 只用触发批（别人的新消息）检索，避免把自己刚说的梗再闪回来
        const triggerText = (triggerEntries || []).map((m) => String(m?.text ?? '')).join('\n');
        const nearText = triggerText;
        const occasion = cfg.api?.memeCuePlayfulOnly === false
          ? { ok: true, why: 'gate-off' }        // 配置里关掉闸门（默认开）
          : looksPlayfulOccasion(nearText);
        // 同一会话近 3 分钟内闪过的梗：冷却，防止同一梗反复注入
        const memeCds = this.memeCueAt || (this.memeCueAt = new Map());
        const lastCue = memeCds.get(chatKey) || 0;
        if (!occasion.ok) {
          // 场合不对：这一轮不查库（记一笔，供时机统计/诊断）
          session.memeCueSkip = 'not-playful';
        } else if (Date.now() - lastCue < 3 * 60 * 1000) {
          session.memeCueSkip = 'cooldown';
        } else {
        const cues = cueMemories(nearText, {
          limit: 3,
          minScore: Number.isFinite(Number(cfg.api?.memeCueMinScore))
            ? Number(cfg.api.memeCueMinScore)
            : 2.2
        });
        // 只保留「值得当梗用」的：有标签 或 正文够长；纯「吃什么」这种碎片丢掉
        // 若梗文案几乎就是触发原话（短），闪了也没用——跳过
        const usable = (cues || []).filter((c) => {
          const text = String(c.text || '').trim();
          if (!text) return false;
          const hasTag = (c.tags || []).length > 0;
          if (text.length >= 12) return true;
          // 梗文案就是触发原话 → 闪了也没用（避免「吃什么」对着「吃什么」）
          if (nearText.includes(text)) return false;
          if (text.length >= 8) return hasTag;
          // ⚠️ 2026-09-21 修：原来这里是一句 `if (text.length < 8) return false;` 一刀切，
          // 等于「躺平」「切城」「蚌埠住了」这类短梗在库里躺一辈子也闪不出来 ——
          // 管理员反馈「梗还是有点少」有一半是这个原因。现在只要求：没被触发句原样包含、
          // 且有标签（有标签=语境明确），短到 3 个字也允许闪一次；后面还有 Jev 复核接不接得上。
          return hasTag && text.length >= 3;
        });
        // ⚠️ 2026-09-21：同一条梗短期内不重复闪。
        // 实测「示例用户给小鲸鱼画了第二形态写真…」这类长条目会在连续几轮里反复霸榜，
        // 模型连着看到同一条 → 要么当噪音忽略，要么硬套。20 分钟内闪过的先排除。
        const cueSeen = this.memeCueSeen || (this.memeCueSeen = new Map());
        const seenMap = cueSeen.get(chatKey) || new Map();
        const nowCue = Date.now();
        for (const [k, ts] of seenMap) if (nowCue - ts > 20 * 60 * 1000) seenMap.delete(k);
        const pool0 = usable.filter((c) => !seenMap.has(String(c.text || '')));
        // Jev 复核：字面/标签捞出来的梗不一定接得上（对着报错闪「吃什么」），
        // 注入后模型要么硬套要么整段复读。这里在注入前问一次「接不接得上」。
        // 只在 Jev 明确说 NO 时丢；没开角色 / 弃权 / 超预算 = 维持原样，宁可多闪不可错杀。
        let pool = pool0;
        if (pool.length && localJevHasRole('memeGate')) {
          const budget = Math.max(300, Number(cfg.localJev?.gateBudgetMs) || 1500);
          let timer = null;
          const judged = await Promise.race([
            Promise.allSettled(pool.map((c) => jevGate('memeGate',
              `群里刚说：${nearText.slice(0, 120)}\n脑内闪过的梗：${String(c.text || '').slice(0, 60)}`,
              { timeoutMs: 1800 }))),
            new Promise((r) => { timer = setTimeout(r, budget); })
          ]);
          if (timer) clearTimeout(timer);
          if (Array.isArray(judged)) {
            pool = pool.filter((_c, i) => {
              const r = judged[i];
              if (!r || r.status !== 'fulfilled' || !r.value) return true;
              if (r.value.abstain || r.value.error) return true;
              return !!r.value.on;
            });
          }
        }
        // ── 只给一条（2026-09-22 改）──
        // 原来给「2 条强 + 1 条弱」，措辞还是"这一段不是要说的话 / 用不上就当没看见"，
        // 实测 193 轮注入 0 采用：候选一多，模型就把它当背景资料；措辞再一软，等于明说"忽略我"。
        // 现在：场合已经对了（上面那道闸），就只递一条、并且明说"能自然带上就用出去"。
        const pick = pool
          .filter((c) => !c.soft)
          .sort((a, b) => (Number(b.score) || 0) - (Number(a.score) || 0))[0] || pool[0];
        if (pick) {
          const tags = (pick.tags || []).filter(Boolean).slice(0, 5).join('、');
          const note = pick.note ? '；' + pick.note : '';
          const inject = '\n【脑内闪过】这轮有人在接梗/玩闹，手边正好有一条群里的熟梗：'
            + `「${pick.text}」${tags ? `（${tags}${note}）` : ''}。`
            + '能自然带上就用出去（直接说，别解释出处、别说"我想起一个梗"、别把这条说明念出来）；'
            + '确实不合适就正常回话，不用勉强。';
          promptParts.all += inject;
          promptParts.volatile += inject;
          memeCds.set(chatKey, Date.now());
          // 记下这轮闪了哪条，20 分钟内不再重复（见上面的 seenMap）
          seenMap.set(String(pick.text || ''), Date.now());
          cueSeen.set(chatKey, seenMap);
          // 记账：这轮给了哪一条、场合依据是什么 —— 跑完在收尾处核"模型到底用没用"（session.memeAdopted）
          session.memeCue = { text: pick.text, score: pick.score, why: occasion.why, at: Date.now() };
          session.memeCued = 1;
        } else {
          session.memeCueSkip = 'no-candidate';
        }
        }
      } catch {
        /* 忽略 */
      }
    }

    // 外部知识：触发词命中 wiki 关键词 → 提示去 external_lookup
    if (cfg.knowledge?.external?.enabled !== false) {
      try {
        const trig = (triggerEntries || []).map((m) => String(m?.text ?? '')).join('\n');
        const words = Array.isArray(cfg.knowledge?.external?.triggerWords)
          ? cfg.knowledge.external.triggerWords
          : [];
        const hit = words.find((w) => w && trig.includes(String(w)));
        // 触发词表是死的，说法是活的（「阿米娅的种族是什么来着」一个词都不沾）。
        // 词表没命中时让 Jev 补问一次；只加提示、不拦别的，符合"只增强不削弱"。
        let viaJev = false;
        if (!hit && trig && localJevHasRole('wikiGate')) {
          const g = await jevGate('wikiGate', trig.slice(0, 200), { timeoutMs: 1500 });
          if (g.on) viaJev = true;
        }
        if ((hit || viaJev) && (!memWl || memWl.has('external_lookup') || memWl.has('web_search'))) {
          const inject = viaJev
            ? `\n【外部知识】这句像在问作品/角色/设定 → 先 external_lookup 查设定；查不到再 web_search。别编百科内容。`
            : `\n【外部知识】提到「${hit}」→ 先 external_lookup("${hit}…关键词") 查设定；查不到再 web_search。别编百科内容。`;
          promptParts.all += inject;
          promptParts.volatile += inject;
        }
      } catch { /* ignore */ }
    }

    // 图库：问自己长什么样 → 提示 image_lib_search(self)
    if (cfg.knowledge?.images?.autoCueSelf !== false && (!memWl || memWl.has('image_lib_search') || memWl.has('image_lib_send'))) {
      try {
        if (cueImageLib) {
          const hits = searchImageLib('形象 自拍', { category: 'self', limit: 2 });
          if (hits.length) {
            const inject = `\n【图库】问到你长什么样 → image_lib_search(category=self) 再 image_lib_send；别拿表情包冒充自己的照片。`;
            promptParts.all += inject;
            promptParts.volatile += inject;
          }
        }
      } catch { /* ignore */ }
    }

    // 24h 摘要即使开启也只进 volatile：它按会话/小时变化，不能污染共享 system 前缀。
    if (recentDigest) {
      const inject = `\n【近24h本地摘要】\n${recentDigest}\n（碎片线索，细节用 memory_search/archive）`;
      promptParts.all += inject;
      promptParts.volatile += inject;
    }

    // 架构注入：待办/跨轮/语义卡/短时跨群（本地、有长度上限）
    const triggerPersonIds = [...new Set(
      (triggerEntries || [])
        .filter((m) => !m.self && m.senderId)
        .map((m) => String(m.senderId).replace(/^-/, ''))
    )];
    {
      const archInject = buildArchitectureInject(cfg, {
        chatKey, kind,
        triggerText: (triggerEntries || []).map((m) => String(m?.text ?? '')).join('\n'),
        botName: cfg.persona?.botName || '',
        personIds: triggerPersonIds
      });
      if (archInject) {
        promptParts.all += archInject;
        promptParts.volatile += archInject;
      }
    }

    // ── 缓存布局：把「永不变化」的段落从 user 挪进 system 的标记之前 ──
    // prompt.js 早就把提示词切成 stable / volatile，但**一直没人用 stable** ——
    // 于是「会话标识／会话身份／冻结冷历史」这些内容每轮都排在缓存断点之后，按原价重算。
    //
    // ⚠️⚠️ 2026-09-21 实测踩到的坑（务必先读懂再改）：百炼的显式缓存块是**全有或全无**。
    //   我一开始把整段 stable（含"冻结冷历史"）都搬进了标记块，结果：
    //     21:34 命中=0 创建=15,195； 21:41 命中=0 创建=15,273
    //   两次运行的 system 前 14,153 字**完全一致**，只在冷历史处开始不同 —— 命中照样报 0，
    //   而且整块按 125% 重建（≈19,000 单位），比原来付那 550 token 原价贵 4 倍。
    //   根因：冷历史名字叫"冻结"，实际每轮都随上下文窗口滑动。
    //   所以现在只搬 identity（chatKey/群号/机器人 QQ，跨运行一字不变）；
    //   冷历史回到 user 段（它本来就在标记之后）。
    const identityForCache = cacheFriendlyLayout ? String(promptParts.identity || '').trim() : '';
    if (identityForCache) {
      systemText = `${systemText.replace(/\s+$/, '')}\n\n${identityForCache}\n`;
    }
    // 非缓存布局下 stable 里含【当前时间】等每轮都变的字段，绝不能搬进 system ——
    // 这里直接沿用 all；缓存布局下 = 冷历史 + 动态段。
    const userPrompt = identityForCache
      ? [String(promptParts.coldStable || '').trim(), String(promptParts.volatile || '').trim()].filter(Boolean).join('\n\n')
      : promptParts.all;

    session.systemPrompt = systemText;
    session.userPrompt = userPrompt;
    session.cacheMode = cacheMode;
    session.promptChars = systemText.length + userPrompt.length;
    session.model = cfg.api.model;
    // 记录本次调用走的是哪个渠道（A6API / openrouter / 本地中转…）。
    // 同名模型在不同渠道是不同商品，用量与价格要分开统计。
    session.vendor = vendorOfConfig(cfg);
    session.chatName = chatName;
    // 记录本次读了多长的上下文（排查提示词长度时很有用）
    if (tierInfo) {
      session.contextTier = tierInfo.tier;
      session.contextLimit = tierInfo.count;
      session.contextReason = tierInfo.reason || '';
    }
    session.participationDecision = tierInfo?.participationDecision || session.participationDecision || null;
    this.sessions.update(session.id);
    this.emit('session-update', session.id);

    let proactiveTail = '';
    if (proactive) {
      if (proactiveReason === 'schedule') {
        proactiveTail = '\n\n【本次唤醒】（定时主动）到你约好的时间了，主动找对方自然聊两句；也可以判断现在不合适就什么都不调，系统自动结束。';
      } else if (kind === 'private') {
        proactiveTail = '\n\n【本次唤醒】（主动机会）私聊已经安静了一会儿。你可以主动关心一下、开个轻松话题，也可以判断没必要就什么都不调，系统自动结束。别像客服，像真人随手找人说话。';
      } else {
        proactiveTail = '\n\n【本次唤醒】（主动机会）群里已经安静了一会儿。你可以主动抛一个自然的话题（像随口说的，不要像播报），也可以判断没必要说话就什么都不调，系统自动结束。';
      }
    }
    // 插嘴模式：这次不是被点名，是本地 Jev 判定「话头正好能接」才醒的。
    // 必须告诉模型这件事 —— 否则它会以为有人在问它，回出「有什么事吗？」这种客服腔。
    let modeTail = '';
    if (tierInfo?.replyMode === 'interject') {
      modeTail = '\n\n【本次唤醒】（插嘴）没人在叫你，是你自己凑上去接一句。所以：短、口语、像群里随口一句；不要称呼对方、不要解释自己为什么说话、不要"有什么可以帮你的"；接得上就接，接不上就什么都不调，系统自动结束。';
      session.replyMode = 'interject';
    } else if (tierInfo?.replyMode === 'reply') {
      session.replyMode = 'reply';
    } else if (tierInfo) {
      session.replyMode = 'auto';
    }
    // 两段尾注合并成一个变量，四个拼接点共用（显式缓存 / 普通 / 附图两条路径）
    const tailText = `${proactiveTail}${modeTail}`;
    // 始终只发两条初始消息。implicit 靠逐字一致的 system 自动命中；explicit
    // 只在 system 末尾放一个断点。动态 user 永远不打标记。
    const messages = buildInitialMessages({
      systemText,
      userText: `${userPrompt}${tailText}`,
      cacheMode,
      // 自适应模式：保温开着就始终打标记（隐式块对显式请求不可见，混用只会白废缓存块；
      // 详见 cache-keepalive.js 的 shouldMarkPrefix 注释 + 2026-09-21 的实验数据）
      markPrefix: cacheMode === 'adaptive'
        ? shouldMarkPrefix(cacheMode, { keepAliveEnabled: keepAliveOptionsFor(chatKey, cfg.api?.cacheKeepAlive).enabled === true })
        : null,
      baseUrl: cfg.api?.baseUrl
    });
    session.cacheMarked = cacheMode === 'explicit'
      || (cacheMode === 'adaptive' && shouldMarkPrefix(cacheMode, { keepAliveEnabled: keepAliveOptionsFor(chatKey, cfg.api?.cacheKeepAlive).enabled === true }));
    // JSON 模式需要看到输入给模型的完整 messages（去工具之前）
    session.inputMessages = structuredClone(messages.map((m) => ({ role: m.role, content: m.content })));
    this.sessions.update(session.id);

    // 工具集按配置过滤：无视觉模型 → 移除看图工具；搜索关闭 → 移除联网工具
    // 视觉判定 = 全局开关 && 选中模型未被探测为"明确不支持图片"（未探测/unknown 时保持开关行为）
    const visionEnabled = cfg.api.vision !== false
      && modelImageVerdict(cfg.api.provider, cfg.api.model) !== 'no-vision';
    const searchEnabled = cfg.webSearch?.enabled !== false;

    // 自动看图：触发消息里带的图，直接下成 data URL 挂进本轮 user 消息，
    // 不要求模型再调 get_message_images（小模型经常想不起来/协议失败）。
    // 关闭：api.autoVision === false
    if (visionEnabled && cfg.api?.autoVision !== false && !proactive) {
      try {
        const urls = [];
        for (const e of triggerEntries) {
          for (const m of e.media || []) {
            if (m?.kind === 'image' && m.url) urls.push(m.url);
          }
        }
        if (urls.length) {
          // ── 认图前置闸（2026-09-21 管理员要求）──
          // 以前"只要有图就自动挂上去"，主模型看到图就以为在说自己，把话题扯到认图上。
          // 现在先问本地 Jev 一次「这张图跟刚才在聊的事关系大不大」：
          //   · 有人明确说"看看 / 这是啥 / 分析下" → 不问，直接附图（那是明确请求）
          //   · Jev 明确判 UNRELATED → **不附图**，并明说"别去认图、接着聊文字"
          //   · 其余（RELATED / 弃权 / Jev 没开 / 出错）→ 照旧附图，行为不退化
          const wantsLook = /看看|看下|瞧|这是(啥|什么|谁)|这图|图里|认一下|认认|分析(下|一下)?|啥角色|哪来的图|什么图/.test(triggerJoined);
          // 认图闸的档位（2026-09-21 盲测数据）：
          //   local  = 只问本地 Jev：20 例留出集 70%（错在"无关→相关"5 例、"相关→无关"1 例）
          //   hybrid = 本地先判，判 RELATED 时再由主模型复核一句：19/20（95%）；默认
          //   cloud  = 直接问主模型：20/20，提示词极短（~150 tok，且可缓存），每次约 0.0001 元
          //   off    = 不判，有图就附（旧行为）
          const gateMode = String(cfg.api?.imageGate || 'hybrid').toLowerCase();
          let gateOn = true, gateWhy = '';
          if (!wantsLook && gateMode !== 'off' && (localJevHasRole('imageRelevanceGate') || gateMode === 'cloud')) {
            try {
              const descs = urls.map((u) => this.#stickerDescByUrl(u)).filter(Boolean);
              const gateInput = `刚才在聊：${triggerJoined.slice(0, 200)}\n刚发来的图：${urls.length} 张${descs.length ? `（${descs.join('；')}）` : ''}`;
              let p = null;
              if (gateMode !== 'cloud') {
                const g = await jevGate('imageRelevanceGate', gateInput);
                p = g?.p ?? null;
                if (g && !g.error && g.abstain !== true && g.on === false) {
                  gateOn = false;
                  gateWhy = 'Jev 判与话题无关';
                }
              }
              // 需要主模型复核的两种情况：
              //   cloud  = 一律复核
              //   hybrid = 只在本地判 RELATED（=要附图、也是 0.8B 出错的那一半）时复核
              const needCloud = gateMode === 'cloud' || (gateMode === 'hybrid' && gateOn);
              if (needCloud && gateOn) {
                const cloud = await this.#confirmImageRelevance(gateInput, session).catch(() => null);
                if (cloud === 'UNRELATED') {
                  gateOn = false;
                  gateWhy = gateMode === 'cloud' ? '主模型判与话题无关' : '主模型复核：与话题无关';
                } else if (cloud) {
                  gateWhy = `主模型复核：${cloud}`;
                }
              }
              session.imageGate = { mode: gateMode, on: gateOn, why: gateWhy, p };
            } catch { /* 闸挂了就当没闸，照旧附图 */ }
          } else if (wantsLook) {
            session.imageGate = { on: true, why: '对方明确要看图' };
          }
          if (!gateOn) {
            const note = `【本次唤醒里的图】有 ${urls.length} 张群友发的图/表情，但跟当前在聊的事关系不大（系统已判过）。别去认图、别评论图片内容，接着聊文字里在说的事就行。\n`;
            messages[1] = { role: 'user', content: `${note}${userPrompt}${tailText}` };
            session.promptChars += note.length;
            console.log(`[orchestrator] ${chatKey} 认图闸拦下 ${urls.length} 张（${gateWhy}）`);
          } else {
          const { dataUrls, skipped, notes } = await downloadImagesAsDataUrls(urls, { limit: 3, maxFrames: 6 });
          if (dataUrls.length) {
            const extraNote = notes?.length ? notes.join(' ') : '';
            const note = `【触发消息附图】系统已自动带上本次唤醒里的 ${dataUrls.length} 张图片${skipped ? `（另有 ${skipped} 张格式本机不支持已跳过）` : ''}${extraNote}。这些就是群友刚发进群的那几张图：像群里人一样**随口反应一句**就行（吐槽/接梗/共情），别写图片描述、别逐条列画面细节。`;
            // 图只挂在动态 user 末尾，不进入稳定 system 前缀。
            messages[1] = {
              role: 'user',
              content: [
                { type: 'text', text: `${note}${userPrompt}${tailText}` },
                ...dataUrls.map((u) => ({ type: 'image_url', image_url: { url: u } })),
              ],
            };
            session.promptChars += note.length;
            console.log(`[orchestrator] ${chatKey} 自动附上 ${dataUrls.length} 张触发图（跳过 ${skipped}${notes?.length ? `；${notes.join(' ')}` : ''}）`);
          } else if (skipped || urls.length) {
            console.log(`[orchestrator] ${chatKey} 触发图未能自动附上（下载失败或格式不支持，skip=${skipped}）`);
          }
          }
        }
      } catch (e) {
        console.log(`[orchestrator] ${chatKey} 自动看图失败（忽略）: ${e?.message ?? e}`);
      }
    }

    // 工具集按配置过滤：无视觉模型 → 移除看图工具；搜索关闭 → 移除联网工具
    // 小模型面对 20+ 个工具容易乱选（该发消息时去翻记忆、该搜图时发表情），
    // 砍到 6~8 个能明显提升工具选择的准确率。留空 = 全部给。
    // 亢奋模式：只留发言 + 结束，其它工具一律不下发。
    const hypeModeNow = isHypeMode();
    const HYPE_TOOL_ALLOW = new Set(HYPE_TOOLS);
    const toolWhitelist = Array.isArray(cfg.api?.tools) && cfg.api.tools.length ? new Set(cfg.api.tools.map(String)) : null;
    // 每次运行重建：扩展热重载后才能看到新工具（不重建会一直用启动时的快照）
    const allToolDefs = buildToolDefs();
    const toolDefs = allToolDefs.filter((d) => {
      if (hypeModeNow && !HYPE_TOOL_ALLOW.has(d.name)) return false;
      // 扩展工具：不走核心白名单（由 config.skills[id].enabled 控制）
      if (!d.skillId && toolWhitelist && !toolWhitelist.has(d.name)) return false;
      if (!visionEnabled && (d.name === 'get_message_images' || d.name === 'get_sticker_image' || d.name === 'identify_image')) return false;
      if (!searchEnabled && (d.name === 'web_search' || d.name === 'web_fetch' || d.name === 'search_images')) return false;
      return true;
    });
    const openAiTools = toOpenAiTools(toolDefs);
    const protocolRecovery = cfg.api?.protocolRecovery === true && cfg.api?.textOnlyJudge !== false
      && toolDefs.some(d => d.name === 'send_message');
    const replyDrafts = [];

    const ctx = {
      chatKey, kind, chatId,
      selfId: this.onebot.selfId,
      selfNickname,
      botName: cfg.persona.botName,
      onebot: this.onebot,
      store: this.store,
      memory: this.memory,
      stickers: this.stickers,
      sender: this.sender,
      session,
      runContext,
      participationRoute,
      emit: (type, payload) => this.emit(type, payload),
      guardAction: (actionId) => runContext.guardAction(actionId),
      // 记忆检索预算：搜不到就停，防狂搜（0 = 不限）
      memorySearchBudget: (() => {
        const raw = Number(cfg.api?.conversationMemory?.maxSearchPerRun);
        const n = Number.isFinite(raw) ? raw : 3;
        return n <= 0 ? 0 : Math.min(8, Math.round(n));
      })(),
      memorySearchUsed: 0,
      triggerUserIds: triggerPersonIds
    };

    const maxRounds = Math.max(1, Number(cfg.api.maxRounds) || 12);
    let finish = false;
    // 纠偏：有些模型会把"要说的话"直接写成正文，而不是调用 send_message，
    // 于是群里一条都没收到、后台只显示"未回复"（实测 qwen3.7-flash 约 25% 的会话如此）。
    // 最多提醒两次；两次都不听就兜底把它的正文发出去（api.textOnlyFallback，默认开）。
    let nudgeCount = 0;
    let lastTextOnly = '';      // 最后一段"只写了正文、没调工具"的文字（兜底发送用）
    const toolCallBudgetState = {
      seen: new Set(), runCount: 0, totalSends: 0, sendsByName: {}
    };
    // 本地"会思考"的模型常见的隐形故障：思考把 max_tokens 吃光，于是正文为空、
    // 也没有工具调用（finish_reason=length）→ 群里什么都不会发生。
    // 遇到就自动加大预算重试，最多两次。
    let tokenBudget = replyPolicy.budget;
    session.replyPolicy = (replyPolicy.enabled || replyPolicy.autoFinish)
      ? { complex: replyPolicy.complex, autoFinish: replyPolicy.autoFinish, multiOnly: replyPolicy.multiOnly, initialBudget: tokenBudget, cap: replyPolicy.cap }
      : null;
    let searchedSuccessfully = false;
    let truncationRetries = 0;
    let webSearchCount = 0;
    session.activity = '';
    session.webSearchCount = 0;
    const markActivity = (activity) => {
      session.activity = String(activity ?? '');
      // 记时间戳：UI 要靠它显示"已等 N 秒"。2026-09-21 实测有一次接口偶发慢到 72 秒
      // （正常 ~2 秒），卡片上只写"正在思考…"完全看不出是慢还是死，管理员会以为卡住了。
      session.activityAt = Date.now();
      this.sessions.update(session.id);
      this.emit('session-update', session.id);
    };
    for (let round = 0; round < maxRounds && !finish; round++) {
      if (this.aborted) { this.sessions.finish(session.id, 'aborted'); return; }
      // ── 退化断路器 ──
      // 弱模型可能连着多轮把同一句话越裹越长；只靠"工具返回报错"它是不收手的
      // （它接着换一种裹法继续发）。所以在**运行层**直接掐断：重复被拦到 3 条就结束这一轮，
      // 让它没法继续在原地打转 —— 群里最多看到 2~3 条重复，而不是刷一屏。
      if ((session.repeatBlocks || 0) >= 3) {
        session.finishReason = `重复自己 ${session.repeatBlocks} 次，已强制结束这一轮（防止刷屏）`;
        session.activity = '重复过多，已收手…';
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
        break;
      }
      markActivity('正在思考…');
      // 扩展钩子：改 messages（原地）
      await hookBeforeLlmMessages({ messages, session, chatKey, kind, chatId, store: this.store, memory: this.memory });
      // 情绪微调 temperature：幅度很小，别把语气带跑
      let emotionTemp = null;
      try {
        const bs = getBotState({ persist: false });
        const emo = bs?.emotions || {};
        let dt = 0;
        dt += ((Number(emo.hype) || 0) + (Number(emo.cheer) || 0)) / 800;
        dt -= ((Number(emo.down) || 0) + (Number(emo.sadness) || 0)) / 900;
        dt = Math.max(-0.08, Math.min(0.12, dt));
        if (Math.abs(dt) >= 0.03) {
          const baseT = Number(cfg.api?.temperature ?? 0.8);
          emotionTemp = Math.max(0.2, Math.min(1.4, baseT + dt));
        }
      } catch { /* ignore */ }
      // 网络抖动/5xx/429 会自动重试（同一轮请求，messages 不变，幂等不重复发言）
      // 仅记哈希和间隔，不把诊断字段塞进模型请求。进程重启后首个间隔未知。
      const requestAt = Date.now();
      const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 20);
      // ⚠️ system 指纹必须**忽略 cache_control**：自适应/显式模式下标记会随冷热开关，
      //    把标记算进去就会让"同一个前缀"看起来每次都变了（诊断字段会误导排查）。
      const fingerprintPrefix = value => createHash('sha256')
        .update(JSON.stringify(value, (k, v) => (k === 'cache_control' ? undefined : v)))
        .digest('hex').slice(0, 20);
      const scope = fingerprint([cfg.api?.baseUrl, cfg.api?.provider, cfg.api?.model]);
      const systemFingerprint = fingerprintPrefix(messages.filter(m => m.role === 'system'));
      const toolsFingerprint = fingerprint(openAiTools);
      const prefixKey = `${scope}:${systemFingerprint}:${toolsFingerprint}`;
      const chatScope = `${scope}:${chatKey}`;
      const elapsed = key => this.cacheRequestTimes.has(key) ? requestAt - this.cacheRequestTimes.get(key) : null;
      const diagnostic = { requestAt, round, systemFingerprint, toolsFingerprint,
        samePrefixGapMs: elapsed(prefixKey), sameChatGapMs: elapsed(chatScope) };
      this.cacheRequestTimes.set(prefixKey, requestAt);
      this.cacheRequestTimes.set(chatScope, requestAt);
      while (this.cacheRequestTimes.size > 512) this.cacheRequestTimes.delete(this.cacheRequestTimes.keys().next().value);
      // 记住这次的稳定前缀（system + 工具）：保温调用必须一字不差地复用它才可能命中
      try {
        this.cacheKeeper.remember(cfg.api, { systemText, tools: openAiTools, chatKey });
      } catch { /* ignore */ }
      const response = await chatCompletionWithRetry(
        tokenBudget
          ? {
            messages,
            tools: openAiTools,
            temperature: emotionTemp,
            affinityKey: chatKey,
            overrides: apiWith({ maxTokens: tokenBudget, ...(hypeModeNow ? { disableThinking: true } : {}) })
          }
          : {
            messages,
            tools: openAiTools,
            temperature: emotionTemp,
            affinityKey: chatKey,
            ...(hypeModeNow ? { overrides: apiWith({ disableThinking: true }) } : {})
          }
      );
      trace(`llm round ${round} done`);
      session.model = response.model || session.model;
      addUsage(session.usage, response.usage);
      // 缓存状态机：命中 ≥1024 token 就说明前缀还热着 → 续 5 分钟。
      // 另外**任何一次成功调用都算"前缀刚被写进缓存"**（官方：请求结束即创建，有效期 5 分钟），
      // 所以即使这次没命中，也要标记为热 —— 否则私聊这种"很少 5 分钟内连聊"的场景，
      // 保温链永远起不来（2026-09-21 管理员反馈的正是这个）。
      try {
        const hit = this.cacheKeeper.noteUsage(cfg.api, response.usage, chatKey);
        if (!hit) this.cacheKeeper.markSent(cfg.api, chatKey);
      } catch { /* 记不上不影响主流程 */ }
      const callUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
      addUsage(callUsage, response.usage);
      diagnostic.usage = callUsage;
      diagnostic.hitRate = callUsage.promptTokens > 0 ? callUsage.cachedTokens / callUsage.promptTokens : null;
      // 这一枪花了多久：实测有偶发 72 秒的（正常 ~2 秒），留下耗时才好判断"卡住"还是"接口慢"。
      diagnostic.ms = Date.now() - requestAt;
      session.cacheDiagnostics ||= { mode: cacheMode, calls: [] };
      session.cacheDiagnostics.calls.push(diagnostic);
      session.cacheDiagnostics.firstCall ||= diagnostic;
      session.usage.calls += 1;
      await hookAfterResponse({ response, session, chatKey, kind, chatId });

      // 截断输出仅留审计记录，绝不执行或进入后续 API 历史，避免半截工具调用。
      if (replyPolicy.enabled && response.finishReason === 'length') {
        session.messages.push({ role: 'assistant', content: response.message?.content ?? null,
          raw: response.raw ?? null, discardedTruncated: true });
        session.rounds = round + 1;
        lastTextOnly = '';
        const nextBudget = nextTruncationBudget(tokenBudget, replyPolicy.cap);
        if (truncationRetries < 2 && nextBudget > tokenBudget && round + 1 < maxRounds) {
          truncationRetries += 1;
          tokenBudget = nextBudget;
          session.replyPolicy.truncationRetries = truncationRetries;
          session.replyPolicy.finalBudget = tokenBudget;
          messages.push({ role: 'user', content: '【系统提示】刚才的生成被长度限制截断，整份输出已丢弃，其中的工具没有执行。请重新生成完整工具调用；可以用 messages 数组分多条回复。更早轮次已成功发送的内容不要重发。' });
          markActivity(`输出截断，重新生成（预算 ${tokenBudget}）…`);
          continue;
        }
        session.error = '模型输出持续截断，已停止；截断内容未发送。';
        session.finishReason = session.error;
        break;
      }
      const msg = response.message;
      const finalContent = typeof msg.content === 'string' ? msg.content : (msg.content ?? null);
      const finalToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length ? msg.tool_calls : undefined;
      const assistantEntry = {
        role: 'assistant',
        content: finalContent,
        tool_calls: finalToolCalls,
        raw: response.raw ?? null
      };
      messages.push(assistantEntry);
      session.messages.push(structuredClone(assistantEntry));
      session.rounds = round + 1;
      markActivity('');

      let toolCalls = msg.tool_calls ?? [];
      // 兼容：少数模型把工具调用写成文本而不是原生 tool_calls。解析成功后需要把
      // 该 assistant 消息改成 tool_calls 形态回填 messages，并追加真正的 tool 结果。
      const rawContent = typeof msg.content === 'string' ? msg.content : '';
      let inlineCalls = [];
      if (!toolCalls.length && rawContent) {
        inlineCalls = parseInlineToolCalls(rawContent);
        // 小模型常把 send_message 的参数数组直接写成正文 → 再兜一层宽松解析
        if (!inlineCalls.length) inlineCalls = parseInlineLooseCalls(rawContent) || [];
        if (inlineCalls.length) {
          console.log(`[orchestrator] ${chatKey} 文本形式的工具调用已补成真调用：${inlineCalls.map((c) => c.name).join('、')}`);
        }
      }
      if (inlineCalls.length) {
        toolCalls = inlineCalls.map((c, i) => ({
          id: `inline_${round}_${i}`,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) }
        }));
        // 替换最后一条 assistant 消息：文本清空、附加 tool_calls，避免后续请求报错
        const last = messages[messages.length - 1];
        if (last?.role === 'assistant') {
          last.content = null;
          last.tool_calls = toolCalls;
        }
        const live2 = this.sessions.current.get(session.id);
        const uiLast = live2?.messages?.[live2.messages.length - 1];
        if (uiLast?.role === 'assistant') {
          uiLast.content = null;
          uiLast.tool_calls = structuredClone(toolCalls);
          uiLast.inlineParsed = true;
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      // “心声”不只会出现在纯文本收尾里；有些模型会一边调 send_message，
      // 一边在 content 里留「（心声：…）」。旧逻辑只在无工具分支解析，
      // 这类想法既没接进跨轮记忆，还可能被回复裁判误发。现在所有响应统一先拆。
      const voicedResponse = splitInnerVoice(stripLeadingReplyPrefix(rawContent.trim()));
      const unsentContent = voicedResponse.clean;
      if (response.finishReason !== 'length' && !inlineCalls.length) {
        if (voicedResponse.voice) session.innerVoice = cleanThought(voicedResponse.voice, session.sent);
        if (unsentContent && Orchestrator.looksLikeNarration(unsentContent)) {
          session.unsentThought = cleanThought(unsentContent, session.sent);
        }
      }
      if (protocolRecovery) {
        // Cloud length-truncated outputs must not become drafts or half-executed
        // tool batches. The original response is already retained in the audit.
        if (response.finishReason === 'length') {
          replyDrafts.length = 0;
          session.protocolRecovery = { action: 'skipped-truncated' };
          break;
        }
        if (!toolCalls.length && isQuietProtocolText(unsentContent)) {
          finish = true;
          replyDrafts.length = 0;
          break;
        }
        // A native send_message already carries the intended text. Other tools
        // (e.g. collecting a sticker) do not deliver accompanying prose to QQ.
        //
        // ⚠️ 2026-09-12 修正：**调了 send_message 也要记草稿**。
        // 实测 00:15 私聊：用户问"百事和可口选啥"，模型正文写了「草 这都什么灵魂测试」，
        // 却只用 send_message 发了「百事」—— 那句口语就这么丢了（用户明确说"这句该发出来"）。
        // 记下来不会重复发：末尾的 selectGroundedReplies 会按已发送内容去重，
        // 裁判也只挑"能直接对群友说的原句"，分析句照样不发。
        // ⚠️ 整段明显是思考独白时，直接不进草稿 —— 免得裁判误选一行分析句。
        if (!Orchestrator.looksLikeNarration(unsentContent)) {
          rememberReplyDraft(replyDrafts, unsentContent);
        }
      }
      if (!toolCalls.length) {
        // 没有工具调用 = 模型结束思考（文本不会发给 QQ）
        //
        // 但这里有个常见的模型失误：它把"要说的话"直接写成正文，而不是调用
        // send_message —— 结果群里一条都没收到，会话状态成了"未回复"。
        // 实测 qwen3.7-flash 有约 25% 的会话如此（正文就是它想发的群聊消息）。
        //
        // 判定条件刻意收窄，只在"几乎确定是失误"时才打扰模型一次：
        //   1. 本轮没有任何工具调用、本次运行一条都还没发（发过话就不打扰）；
        //   2. 正文是**普通文本**，不是括号内心戏 —— 按本项目的约定，
        //      "（不关我事，潜水）"这类括号/方括号开头的内容属于思考旁白，
        //      而人设里也明确要求"想潜水就直接安静结束"，所以这类不纠偏；
        //   3. 长度 ≤ 300 字（超长的更可能是推理过程，而不是一条群聊消息）。
        // 心声已在上面从每一种响应里统一摘掉；这里只处理尚未发送的正文。
        const text = unsentContent;
        lastTextOnly = text;

        // ── 最高优先级：被点名（群聊 @ / 私聊直呼）就必须回话 ──
        // 实测（09-11 23:18 某个群、09-12 00:05 私聊）：模型写了一整段"他叫我蠢东西…
        // 策略：不用太客气…"的分析，然后**一个工具都没调**。此时：
        //   · 开了 protocolRecovery 时，旧代码在这里直接 break，后面的提醒/裁判补发全跳过；
        //   · 没开时，独白判定也会把提醒吞掉。
        // 结果就是"@它都不回""私聊直接消失"。所以这里先无条件催一次（每次运行最多一次），
        // 让它把要说的话用 send_message 发出来；它要是还想安静，再走 finish。
        const mustAnswer = !proactive && (kind === 'private' || triggerEntries.some((e) => isAtMe(String(e?.text ?? ''), {
          selfNickname: `${cfg.persona?.selfNickname || ''}、${this.onebot.selfNickname || ''}`,
          botName: cfg.persona?.botName || '',
          selfId: this.onebot.selfId || cfg.onebot?.selfId || ''
        })));
        // 旁白判定只认「整段就是旁白」：开头括号，或整句就是"不回了/潜水"。
        // 正文里顺嘴提到"潜水"不能免 nudge —— 3.8 常在分析里写"不是叫我，潜水"，
        // 结果被当成旁白跳过提醒，直接 noreply（实测 09-12 多起）。
        const looksLikeAsideNow = (/^[（(【\[]/.test(text) && text.length < 80)
          || /^(不回了?|潜水|不用回)\s*[。.!！]?\s*$/.test(text);
        // 被点名：宁可多催一次，也不要因正文像分析就静默。空正文也要催。
        const pointedNudge = mustAnswer
          && nudgeCount < 2 && session.sent.length === 0
          && text.length <= 2500
          && cfg.api?.nudgeTextOnly !== false && cfg.api?.pointedNudge !== false;
        if (pointedNudge) {
          nudgeCount += 1;
          messages.push({
            role: 'user',
            content: nudgeCount === 1
              ? '【系统提示】对方直接点名找你了，你刚才写的只是思考、群里一个字都没收到。被点名就必须回话：请立刻调用 send_message 把你要说的那句发出去（想分条就传数组）。确实不想说，就什么都不调，系统会结束本轮。'
              : '【系统提示·最后一次】对方点名找你，群里还是一个字都没收到。现在只做一件事：调用 send_message 发一句最简短的话（哪怕就是"？""干嘛"）。不要再写分析。'
          });
          markActivity('被点名了，提醒它必须回话');
          continue;
        }

        if (protocolRecovery) {
          if (isReplyPlanningText(text)) {
            replyDrafts.length = 0;
            if (cfg.api?.nudgeTextOnly !== false && nudgeCount < 1) {
              nudgeCount += 1;
              messages.push({ role: 'user', content: '【回复协议纠正】刚才是选词、备选句或改稿过程，不能发给群友。请只把最后确定的回复通过 send_message 发出，分条用数组；不要发送备选项、自我点评、历史记录或已经发过的话。不想回复就什么都不调。' });
              markActivity('纠正回复协议，丢弃改稿过程');
              continue;
            }
            session.protocolRecovery = { action: 'skipped-planning' };
          }
          break;
        }
        // ① 被 max_tokens 掐断（本地"会思考"的模型高发：思考吃光预算，正文空、工具调用也没有，
        //    finish_reason=length）→ 加大预算重试，别让群里静悄悄什么都没发生。
        if (String(response.finishReason || '') === 'length' && !text && truncationRetries < 2) {
          truncationRetries += 1;
          const base = tokenBudget || Number(cfg.api?.maxTokens) || 300;
          tokenBudget = Math.min(2400, Math.max(700, base * 2));
          messages.push({
            role: 'user',
            content: `【系统提示】你上一次的"思考"把输出长度用完了（被截断），所以既没说话也没有调用工具。这次请直接下结论：立刻调用 send_message／send_sticker 把话发出去；不想说就什么都不调。思考别超过两三句。`
          });
          markActivity(`被截断，加大输出预算重试（${tokenBudget}）…`);
          continue;
        }
        // 括号内心戏的判定要用**剥掉前缀之后**的文本：
        // 模型爱写 "[引用 示例用户：…] 我明明是白的！"，那是要说的话，不是旁白（实测被误吞过）。
        const looksLikeAside = looksLikeAsideNow;
        // 上限从 300 放宽到 1200：查完资料的长回复也是"要说的话"，不该被当成推理丢掉
        const looksLikeReply = text.length > 0 && text.length <= 1200 && !looksLikeAside && !Orchestrator.looksLikeNarration(text);
        const nudgeEnabled = cfg.api?.nudgeTextOnly !== false;
        // 通用提醒（没人点名、但正文像一句要说的话）。"被点名必回"那条已经在上面处理过了。
        if (nudgeEnabled && looksLikeReply && nudgeCount < 2 && session.sent.length === 0) {
          nudgeCount += 1;
          messages.push({
            role: 'user',
            content: nudgeCount === 1
              ? '【系统提示】你刚才的文本只是思考，不会发到 QQ。要发言必须调用 send_message（想分条就传数组）；不想说话就什么都不调，系统会结束本轮。'
              : '【系统提示·最后一次】你又只写了正文，群里依然一条都没收到。现在：用 send_message 把要说的话发出去。不要再输出正文。'
          });
          markActivity('提醒模型：文本不会发出去');
          continue;
        }
        break;
      }

      const sentBeforeBatch = session.sent.length;
      const toolResults = [];
      const acceptedToolResults = [];
      const imageUserMessages = [];
      // 流式响应结束后，把 assistant 条目的 tool_calls 也同步到会话消息流（一次）
      const liveTool = this.sessions.current.get(session.id);
      const lastAssistantUi = liveTool?.messages?.[liveTool.messages.length - 1];
      if (lastAssistantUi?.role === 'assistant' && Array.isArray(toolCalls) && toolCalls.length) {
        if (!lastAssistantUi.tool_calls) lastAssistantUi.tool_calls = structuredClone(toolCalls);
      }
      // 全工具去重 + 单轮/单次运行/发送次数护栏。被过滤的调用也要补 tool result。
      const safeSelection = selectSafeToolCalls(toolCalls, toolCallBudgetState, cfg.api?.toolLimits || {});
      const acceptedToolCalls = safeSelection.accepted;
      for (const skipped of safeSelection.rejected) {
        const call = skipped.call;
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        toolResults.push(filteredToolResult(call, skipped.reason));
        session.messages.push({
          toolCall: { name, args: safeParse(argsRaw), result: skipped.reason, isError: false }
        });
      }
      if (safeSelection.rejected.length) {
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      for (const call of acceptedToolCalls) {
        const name = call?.function?.name ?? '';
        const argsRaw = call?.function?.arguments ?? '{}';
        if (name === 'web_search' || name === 'web_fetch') webSearchCount += 1;
        session.webSearchCount = webSearchCount;
        markActivity(`正在调用 ${name}…`);
        const blocked = await hookBeforeTool({
          toolName: name,
          argsRaw,
          session,
          chatKey,
          kind,
          chatId
        });
        if (blocked?.block) {
          const blockedResult = {
            role: 'tool',
            tool_call_id: call.id,
            name,
            content: String(blocked.reason || '本次调用被扩展否决'),
            isError: true
          };
          toolResults.push(blockedResult);
          acceptedToolResults.push(blockedResult);
          session.messages.push({
            toolCall: { name, args: safeParse(argsRaw), result: String(blocked.reason || 'blocked'), isError: true }
          });
          this.sessions.update(session.id);
          this.emit('session-update', session.id);
          continue;
        }
        trace(`tool ${name} start`);
const result = await executeToolGuarded(toolDefs, ctx, name, argsRaw);
        trace(`tool ${name} done`);
        await hookAfterTool({ toolName: name, argsRaw, result, session });
        if (name === 'web_search' && !result.isError) searchedSuccessfully = true;
        // 工具结果：文本走 tool 消息；图片（parts 数组）不能塞进 tool 消息——
        // 很多 OpenAI 兼容端点不接受。做法：tool 消息只带文本，图片随后以 user 消息补发
        // （[{type:'text'},{type:'image_url'}]），这是兼容面最广的视觉输入方式。
        let contentStr = '';
        let images = [];
        if (Array.isArray(result.content)) {
          contentStr = result.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
          images = result.content.filter((p) => p.type === 'image_url');
        } else {
          contentStr = String(result.content);
        }
        const executedResult = { role: 'tool', tool_call_id: call.id, name, content: contentStr, isError: !!result.isError };
        toolResults.push(executedResult);
        acceptedToolResults.push(executedResult);
        session.messages.push({ toolCall: { name, args: safeParse(argsRaw), result: contentStr.slice(0, 2000), isError: !!result.isError } });
        if (images.length) {
          imageUserMessages.push({
            role: 'user',
            content: [
              { type: 'text', text: `[系统：以下是工具 ${name} 返回的 ${images.length} 张图片，请直接"看图"回应]` },
              ...images
            ]
          });
          session.messages.push({ toolImages: { tool: name, count: images.length } });
        }
        this.sessions.update(session.id);
        this.emit('session-update', session.id);
      }
      // ── finish 工具已移除：发送类工具成功后自动结束本轮 ──
      const SEND_TOOLS = new Set(['send_message', 'send_sticker', 'send_image', 'send_music', 'send_bilibili', 'send_forward', 'send_poke']);
      // 图片/卡片类和"表情、拍一拍"不一样：图片通常是"配着话说"的，只发了图就收尾
      // 会把后面那半句砍掉。实测 2026-09-19~21：**13 次"只发了图、一个字没说"就被自动收尾**，
      // 而图文一起发的只有 8 次 —— 管理员原话：「发了一张图片后会自动 finish，我觉得大概率后面还有话」。
      const IMAGEISH_TOOLS = new Set(['send_image', 'send_forward', 'send_bilibili', 'send_music']);
      const newSentThisRound = session.sent.slice(sentBeforeBatch);
      const sentThisRound = newSentThisRound.length > 0
        && acceptedToolCalls.some((c) => SEND_TOOLS.has(c.function?.name))
        && !acceptedToolResults.some((r) => r.isError);
      // ── 点歌半途被收尾（2026-09-22 修）──
      // 模型发音乐卡习惯分两步：先 send_message 说"给你来首…"，下一轮再 send_music 发卡
      // （send_music 的工具说明就是"要引用请先 send_message 再发本工具"）。而自动收尾在
      // send_message 之后立刻结束本轮 → 第二步永远走不到。实测（9/21–9/22 共 4 次）：
      //   search_music → send_message →（自动收尾），音乐卡一张没发出来；
      //   而同一批成功的会话都是"send_message + send_music 挤在同一轮"才侥幸躲过。
      // 判据两条，任一成立就算这轮没说完：触发文本在点歌（needsMusic），
      // 或本会话查过歌（search_music）却始终没发卡。只宽限一轮，套路同 imageOnlyGrace。
      const musicSearched = (session.messages || []).some((m) => m?.toolCall?.name === 'search_music');
      const musicWanted = replyPolicy.needsMusic === true || musicSearched;
      let musicStillPending = false;
      let musicNudge = '';
      if (!finish && sentThisRound) {
        const hasImg = session.sent.some((s) => s.type === 'image');
        const hasText = session.sent.some((s) => s.type === 'text');
        // 宽限过一次之后就不再算"待完成"，否则会永远不收尾
        const musicPending = musicWanted && !session.sent.some((s) => s.type === 'music') && !session.musicGrace;
        musicStillPending = musicPending;
        const pendingNeed = (replyPolicy.needsImage && !hasImg)
          || (replyPolicy.needsSearch && !searchedSuccessfully)
          || musicPending;
        // 只发了图/卡片、本轮一个字都没说 → 先别收尾，让它再跑一轮把话补上。
        // 只宽限一次（session.imageOnlyGrace），避免它一直发图一直不收尾。
        const imageOnlyNeedsChance = !pendingNeed && !hasText
          && toolCalls.some((c) => IMAGEISH_TOOLS.has(c.function?.name))
          && !session.imageOnlyGrace;
        if (imageOnlyNeedsChance) {
          session.imageOnlyGrace = true;
          markActivity('只发了图，再给它一轮把话补上…');
        } else if (musicPending) {
          session.musicGrace = true;
          musicNudge = '【提醒】你刚说了要放歌/推歌，但还没调用 send_music —— 现在直接调 send_music（query="歌名 歌手"，或 songId）。不用再发文字。';
          markActivity('说了要放歌、卡还没发，再给它一轮…');
        } else if (!pendingNeed) {
          finish = true;
          if (!session.finishReason) session.finishReason = '发送完成，自动收尾（无 finish 工具）';
          session.autoFinishedReply = true;
          if (!session.moodTag) session.moodTag = '';
        }
      }
      messages.push(...toolResults.map(({ role, tool_call_id, name, content }) => ({ role, tool_call_id, content, name })));
      messages.push(...imageUserMessages);
      // 点歌宽限那一轮：明说"还没发卡"，别让它再写一遍文字就收工
      if (!finish && musicNudge) messages.push({ role: 'user', content: musicNudge });
      if (!finish && acceptedToolCalls.length && protocolRecovery && !sentThisRound) {
        messages.push({ role: 'user', content: '【回复协议】工具结果已返回。要让群友看到文字必须用 send_message，分条可传数组。发完即可，系统自动结束本轮（没有 finish 工具）。普通正文不会发送。' });
      }
      if (!finish && canEndReplyBatch(
        musicStillPending ? { ...replyPolicy, needsMusic: true } : replyPolicy,
        acceptedToolCalls, acceptedToolResults,
        newSentThisRound, session.sent, searchedSuccessfully)) {
        finish = true;
        session.finishReason = '本批回复已发送，自动结束';
        if (!session.moodTag) session.moodTag = '';
        session.autoFinishedReply = true;
      }
      // 给 UI 的简化消息流（跳过纯 tool 结果的重复展示）
    }

    // 兜底：提醒过之后模型还是不调工具，但它最后写的可能确实是一句"要说给群里听的话"。
    // 与其让群里什么都收不到（用户看到的就是"机器人不回我了"），不如救回来；
    // 但历史教训是**不能盲发**：它写的常常是内心思考（"没人叫我…安静结束"），
    // 一发就泄漏。所以这里交给裁判（极小提示词的二次判定）：
    //   判"成品消息" → 用 send_message 发出去；判"内心思考" → 丢弃。
    // 拿不准、裁判故障或参与决策不允许时一律沉默，不再按换行盲发。
    //
    // ⚠️ 2026-09-12：条件里的 `!finish` 去掉了。实测 00:15 私聊：模型发完「百事」就调了
    // finish 收尾，于是"检查尚未发送的正文"整段被跳过，正文里那句「草 这都什么灵魂测试」
    // 白写了。finish 只是它自己的收尾动作，不代表正文里那些话是故意不要的 —— 该由裁判判。
    if (protocolRecovery && !session.error && replyDrafts.length && !this.aborted) {
      markActivity('检查尚未发送的正文…');
      const verdict = await judgeUnsentLines({ text: replyDrafts.join('\n\n'),
        trigger: session.triggerText || '', alreadySent: session.sent });
      if (verdict.usage) {
        addUsage(session.usage, verdict.usage);
        session.usage.calls += 1;
      }
      // ⚠️ 2026-09-21 补：这条路径原来**没有**独白否决，而判定常常由 localJev（0.8B）来做，
      // 它会把"内心戏/计划"判成 say。线上实测 20:41 群发出去的是：
      //   「有点得意的情绪，可以顺着"我神游鬼没"接梗。不用查记忆，这是玩笑话不是旧事细节。」
      // 这是把提示词里的情绪提示（"倾向：可以接梗，别过火"）学舌回来了。
      // 另一条兜底路径早就有这层否决（见下面 looksLikeNarration 的用法），这里补上。
      const participationAllowed = tierInfo?.participationDecision?.action === 'continue';
      const selected = verdict.action === 'say' && !verdict.error && participationAllowed
        ? selectGroundedReplies(verdict.messages, replyDrafts, session.sent)
          .filter((line) => !Orchestrator.looksLikeNarration(line))
        : [];
      const slots = Math.max(1, Number(cfg.send?.maxPerRun) || 4) - session.sent.length;
      const list = fitReplyBubbles(selected, slots);
      session.protocolRecovery = { drafts: replyDrafts.length, action: verdict.error ? 'judge-error'
        : list.length ? 'send' : 'skip', error: verdict.error || null, model: verdict.model || null,
        usage: verdict.usage || null };
      // skip 只表示不能补发，不证明它是想法。心声/旁白已在响应入口独立回收。
      // Keep auxiliary token usage in the same per-call audit structure used by
      // the usage page, without presenting judge text as a main-model reply.
      if (verdict.usage) session.messages.push({ role: 'assistant', content: null,
        auxiliary: 'protocol-recovery', raw: { model: verdict.model, usage: verdict.usage } });
      if (list.length && !this.aborted) {
        const result = await executeToolGuarded(toolDefs, ctx, 'send_message', JSON.stringify({ messages: list }));
        session.messages.push({ toolCall: { name: 'send_message', args: { messages: list },
          result: String(result.content).slice(0, 2000), isError: !!result.isError }, protocolRecovered: true });
        if (result.isError) session.protocolRecovery.action = 'send-error';
        else session.textOnlySalvage = true;
      }
      markActivity('');
    }
    if (!protocolRecovery && !session.error && session.sent.length === 0 && lastTextOnly) {
      const aside = /^[（(【\[]/.test(lastTextOnly) || /不回了?|潜水|不用回/.test(lastTextOnly);
      if (!aside && lastTextOnly.length > 0 && lastTextOnly.length <= 1200) {
        const judgeOn = cfg.api?.textOnlyJudge !== false;
        let verdict = null;
        if (judgeOn) {
          verdict = await judgeTextOnly({ text: lastTextOnly, trigger: session.triggerText || '' });
          if (verdict.error) {
            console.log(`[orchestrator] ${chatKey} 正文裁判失败，退回旧兜底：${verdict.error}`);
          }
        }
        // 只有裁判明确 say、非独白且本轮参与决策允许时才补发。
        const participationAllowed = tierInfo?.participationDecision?.action === 'continue';
        const jevSay = Boolean(verdict && !verdict.error && verdict.action === 'say' && participationAllowed)
          && !Orchestrator.looksLikeNarration(lastTextOnly);
        const shouldSend = jevSay;
        const list = jevSay ? verdict.messages : [];
        if (shouldSend && list.length) {
          try {
            await executeToolGuarded(toolDefs, ctx, 'send_message',
              JSON.stringify({ messages: list.length > 1 ? list : list[0] }));
            session.textOnlySalvage = true;
            const how = verdict.source === 'localJev' ? '本地Jev裁判' : '裁判判定为成品消息';
            console.log(`[orchestrator] ${chatKey} 模型未按协议调用工具，已补发它的正文（${how}，${list.length} 条）`);
          } catch (error) {
            console.log(`[orchestrator] ${chatKey} 兜底发送失败: ${error?.message ?? error}`);
          }
        } else if (verdict && !verdict.error) {
          console.log(`[orchestrator] ${chatKey} 正文被裁判判为内心思考，已丢弃：${String(lastTextOnly).replace(/\s+/g, ' ').slice(0, 60)}`);
        }
      }
    }

    // ── 表情包：主循环之外单独挑一次 ──
    // 为什么从这里下手：别让小模型在"想说什么"的同时还要决定"要不要配表情、配哪张"，
    // 它两件事都做不好（实测要表情包时 0/3、纯被夸时 0/3）。
    // 现在拆成两步：主循环专心说话（工具里已经没有 send_sticker），
    // 说完之后按概率触发一次**只挑一张**的小决策（挑不出来就 output none）。
    // 亢奋模式：只发言，不自动挑表情。
    if (!hypeModeNow && !session.error && session.sent.some((s) => s.type === 'text') && !session.sent.some((s) => s.type === 'sticker')) {
      await this.#maybeAutoSticker(session, chatKey, kind, chatId).catch((e) => {
        console.log(`[orchestrator] 自动挑表情失败（忽略）: ${e?.message ?? e}`);
      });
    }

    // 收尾：发过话 = done；没发 = noreply（这是正常选项）
    const status = session.error ? 'error' : (session.sent.length > 0 ? 'done' : 'noreply');

    // 跨轮工作记忆：把「刚想说什么/搜过什么」留给下一轮（短 TTL）
    try {
      // 未发送想法兜底回收：这轮没发出去的内心戏（括号旁白 / 被判为独白的正文）
      // 收进跨轮工作记忆，下一轮显示成「未发送想法」。
      // 已经补发出去的正文不算心声（那是说给群里听的）。
      if (!session.error && !session.textOnlySalvage && !session.innerVoice && !session.unsentThought
        && lastTextOnly && Orchestrator.looksLikeNarration(lastTextOnly)) {
        session.unsentThought = cleanThought(lastTextOnly, session.sent);
      }
      saveCrossTurn(cfg, chatKey, conversationTurnPayload(session));
    } catch { /* ignore */ }

    try {
      reportRunCost(chatKey, {
        promptTokens: session.usage?.promptTokens || 0,
        cachedTokens: session.usage?.cachedTokens || 0
      }, cfg);
    } catch { /* ignore */ }

    // 更新全局本体状态（精力/心情），供下一轮注入
    try {
      const sentTexts = (session.sent || []).filter((s) => s.type === 'text').map((s) => String(s.text || ''));
      const triggerTexts = (triggerEntries || []).map((m) => String(m?.text || ''));
      // 情绪用的原文要更干净：别的 AI bot 的旁白、被拉黑的发言人不该影响本体情绪。
      const muteIds = new Set((cfg.persona?.ignoreSenderIds || []).map(String));
      const emoTexts = muteIds.size
        ? (triggerEntries || []).filter((m) => !muteIds.has(String(m?.senderId ?? ''))).map((m) => String(m?.text || ''))
        : triggerTexts;
      const triggerText = emoTexts.join('\n');
      // ── 情绪：词表 + 每轮 emotionGate 合并（0.8B 常把玩闹标 roast，以词表/合并规则纠偏）──
      let hint = [];
      let jevCue = null;
      let jevEmotion = null;
      const vocabRaw = detectIncomingHint(emoTexts);
      const vocabHint = Array.isArray(vocabRaw) ? vocabRaw : (vocabRaw?.type || []);
      if (triggerText.trim() && localJevHasRole('emotionGate')) {
        try {
          const eh = await jevEmotionHint({ text: triggerText });
          jevEmotion = eh;
          session.emotionGate = { kind: eh.kind || null, p: eh.p, error: eh.error || '' };
          if (eh.error) console.log(`[orchestrator] emotionGate 失败: ${eh.error}`);
          else if (!eh.kind) console.log('[orchestrator] emotionGate → none/弃权');
          if (eh.kind) {
            if (eh.kind === 'tease' || eh.kind === 'memeOk') jevCue = [eh.kind];
            console.log(`[orchestrator] localJev 情绪判定: ${eh.kind} (p=${Number(eh.p||0).toFixed(2)}) 词表:[${vocabHint.join(',')||'-'}]`);
          }
        } catch { /* ignore */ }
      }
      hint = mergeEmotionSignals(vocabHint, jevEmotion?.kind || null, triggerText || emoTexts.join('\n'));
      if (!hint.length && vocabHint.length) hint = vocabHint.slice();
      // 「有人点它」= 被 @ / 被点名 / 私聊。不给的话每连续 3 轮说话都会被误判成「没人接话」
      const selfNicknameStr = `${cfg.persona?.selfNickname || ''}、${this.onebot.selfNickname || ''}`;
      const addressed = kind === 'private' || (triggerEntries || []).some((e) => isAtMe(String(e?.text ?? ''), {
        selfNickname: selfNicknameStr,
        botName: cfg.persona?.botName || '',
        selfId: this.onebot.selfId || cfg.onebot?.selfId || ''
      }));
      // 这轮说话的人里跟它最亲近的 favor：用来放大「被在意的人伤到」的痛感
      let topFavor = null;
      try {
        const fm = this.memory?.favorMap?.();
        if (fm) {
          for (const e of (triggerEntries || [])) {
            if (!e || e.self || !e.senderId) continue;
            const v = Number(fm.get(String(e.senderId)));
            if (!Number.isFinite(v)) continue;
            topFavor = topFavor == null ? v : Math.max(topFavor, v);
          }
        }
      } catch { /* ignore */ }
      // 词表接梗/玩闹但 emotionGate 没表态时，仍可走 cueVerifyGate（只加强不削弱）
      try {
        const misses = cueGateMisses(Array.isArray(hint) ? hint : [], triggerText);
        if (misses.length && !jevCue && localJevHasRole('cueVerifyGate')) {
          const ck = await jevCueKind({ text: triggerText });
          if (ck.kind && misses.includes(ck.kind)) {
            jevCue = [ck.kind];
            console.log(`[orchestrator] localJev 复核放行: ${ck.kind}`);
          }
        }
      } catch { /* ignore */ }
      applyRunToBotState({
        sentTexts,
        status,
        chatKey,
        incomingHint: hint,
        // 自评通道已关：情绪只吃 Jev / 词表，不吃 finish.mood
        moodHint: '',
        triggerText,
        addressed,
        selfNames: selfNicknameStr,
        triggerCount: triggerTexts.length,
        favor: topFavor,
        favorDelta: favorDeltaForKinds([...(Array.isArray(hint) ? hint : []), ...(jevCue || [])], session.favorDelta),
        jevCue,
        jevEmotion,
        emotionKinds: Array.isArray(hint) ? hint : [],
        toolFailed: !!(session.error || (session.toolErrors || 0) > 0)
      });
      // 会话里留下「这轮到底怎么判的」，方便情绪页/排查
      session.emotionKinds = Array.isArray(hint) ? hint : [];
      session.emotionApplied = true;
      // 强情绪/出现过的群友：抬印象 lastSeen，注入排序更靠前（不自动写长事件，防噪音）
      try {
        const uids = (triggerEntries || [])
          .filter((m) => m && !m.self && m.senderId)
          .map((m) => String(m.senderId));
        if (uids.length) this.memory?.bumpSeen?.(uids);
      } catch { /* ignore */ }
    } catch { /* ignore */ }

    // 梗的采用记账（2026-09-22）：这轮给了哪条梗，模型到底说出去没有。
    // 为什么必须记：`uses` 只统计"保存去重/搜索命中"，闪梗只 touch lastUsedAt ——
    // 于是"给了到底用没用"根本量不出来（线上只能看到"193 轮闪梗"，看不到采用率）。
    try {
      const cueText = String(session.memeCue?.text || '').trim();
      if (cueText) {
        // 严格口径：要求发言里出现梗的**前 8 个字**（短梗就是全文）。宁可少算（模型换个说法就算没采用），
        // 也不要多算 —— 这个数的用途是判断"改动有没有效果"，虚高比偏低更坏。
        const probe = cueText.slice(0, Math.min(8, cueText.length));
        const said = (session.sent || []).map((s) => String(s.text || '')).join('\n');
        if (probe && said.includes(probe)) {
          session.memeAdopted = 1;
          markMemeAdopted(cueText);
        } else {
          session.memeAdopted = 0;
        }
      }
    } catch { /* 记账失败不影响主流程 */ }

    this.sessions.finish(session.id, status);
    this.emit('session-end', {
      sessionId: session.id,
      chatKey,
      status,
      sent: session.sent.length,
      finishReason: session.finishReason,
      usage: session.usage
    });
    // 运行结束后安排"缓存保温"：前缀刚命中过，趁 5 分钟 TTL 还没到，用几次 1-token 的
    // 极小请求把它续住 —— 下一轮消息来时首调用就能命中（这是省钱的唯一地方，见
    // src/cache-keepalive.js 的实测数据）。群安静下来会自动停，不白烧。
    try { this.#scheduleKeepAlive(cfg, chatKey); } catch { /* 保温是尽力而为 */ }
    runContext.freeze('run-finished');
  }

  /** 取群/会话最近活动时间（保温链判断"群还剩不热闹"用）。 */
  #lastActivityAt(chatKey) {
    try {
      const recent = this.store.recent(chatKey, { limit: 1 });
      return Number(recent?.[0]?.ts) || 0;
    } catch {
      return 0;
    }
  }

  /**
   * 安排保温链。每次运行结束后调用：
   *   · 清掉这一会话上一次的定时器与计数（新的一轮重新起链）
   *   · 若缓存模式不是 adaptive/explicit、或开关关了、或当前没命中过 → 什么都不做
   *   · 否则按 intervalMs 续棒，最多 maxPerChat 次；每次执行前重新检查"群是否还热闹"
   */
  #scheduleKeepAlive(cfg, chatKey) {
    const mode = resolveCacheMode(cfg.api);
    if (mode !== 'adaptive' && mode !== 'explicit') return this.#kaLog({ phase: 'skip', chatKey, why: `模式=${mode}` });
    // ⚠️ 2026-09-22：以前这里要求「端点支持 cache_control 标记」才保温 —— 但**自动前缀缓存**
    //   的厂商（DeepSeek / Kimi / 硅基…）同样有 5 分钟 TTL、同样会冷，只是不能用标记续。
    //   把"能不能打标记"和"要不要保温"解耦：只要这个端点有缓存（即 supportsCacheMarkers
    //   为真，或者它是已知的自动缓存厂商），就允许保温；标记与否由 shouldMarkPrefix 决定。
    if (!supportsCacheMarkers(cfg.api?.baseUrl) && !isAutoCacheEndpoint(cfg.api?.baseUrl)) {
      return this.#kaLog({ phase: 'skip', chatKey, why: '端点没有缓存可用（既不打标记也不是自动缓存）' });
    }
    // 私聊用更长的一套参数（见 cache-keepalive.js：管理员的主要场景就是私聊）
    const opts = keepAliveOptionsFor(chatKey, cfg.api?.cacheKeepAlive);
    if (opts.enabled !== true) return this.#kaLog({ phase: 'skip', chatKey, why: '保温开关关着' });
    const prev = this.keepAliveTimers.get(chatKey);
    if (prev) clearTimeout(prev);
    this.keepAliveFired.set(chatKey, 0);
    // 注意：这里**不要求**已经命中过。刚刚这次运行本身就把前缀写进缓存了，
    // 第一次保温（4 分钟后）会命中并续期；要是没命中，链会在那次之后自己停。
    if (!this.cacheKeeper.prefixFor(cfg.api, chatKey)) {
      return this.#kaLog({ phase: 'skip', chatKey, why: '没有登记过前缀（这一轮没发过请求？）' });
    }

    const tick = () => {
      const api = getConfig().api;
      const activityAgoMs = Date.now() - this.#lastActivityAt(chatKey);
      // 暂停/中止（比如手动暂停机器人）时不再接力，避免后台静默花钱
      if (this.paused || this.aborted) {
        this.keepAliveStats.stopped += 1;
        this.keepAliveTimers.delete(chatKey);
        return this.#kaLog({ phase: 'stop', chatKey, why: this.paused ? '已暂停' : '已中止' });
      }
      const step = nextKeepAliveStep({
        chainFired: this.keepAliveFired.get(chatKey) || 0,
        options: keepAliveOptionsFor(chatKey, api?.cacheKeepAlive),
        lastActivityAt: Date.now() - activityAgoMs,
        now: Date.now(),
        warm: this.cacheKeeper.isWarm(api, undefined, chatKey)
      });
      if (step.action !== 'keep') {
        this.keepAliveStats.stopped += 1;
        this.keepAliveTimers.delete(chatKey);
        return this.#kaLog({ phase: 'stop', chatKey, why: step.reason || 'step≠keep', activityAgoMs });
      }
      this.#kaLog({ phase: 'arm', chatKey, delayMs: step.delayMs, activityAgoMs, warm: true });
      this.keepAliveTimers.set(chatKey, setTimeout(() => {
        this.#keepAliveOnce(api, chatKey).finally(() => {
          if (this.keepAliveTimers.has(chatKey)) tick();
        });
      }, step.delayMs));
    };
    tick();
  }

  /** 发一次保温请求（同一份 system 前缀 + 1 token 输出），并把命中情况记回状态机。 */
  async #keepAliveOnce(api, chatKey) {
    const key = `${api?.baseUrl}|${api?.model}`;
    const prefix = this.cacheKeeper.prefixFor(api, chatKey);
    if (!prefix?.systemText) return this.#kaLog({ phase: 'skip-fire', chatKey, why: '取不到前缀' });
    if (this.paused || this.aborted) return this.#kaLog({ phase: 'skip-fire', chatKey, why: '已暂停/中止' });
    const t0 = Date.now();
    try {
      const res = await chatCompletion({
        messages: keepAliveMessages(prefix.systemText),
        tools: prefix.tools || null,
        temperature: 0,
        overrides: apiWith({ maxTokens: 1, disableThinking: true })
      });
      const usage = res?.usage || {};
      const nums = readUsageNumbers(usage);
      this.keepAliveStats.calls += 1;
      this.keepAliveStats.promptTokens += nums.prompt;
      this.keepAliveStats.cachedTokens += nums.cached;
      const hit = this.cacheKeeper.noteUsage(api, usage, chatKey);
      if (hit) this.keepAliveStats.hits += 1;
      this.keepAliveFired.set(chatKey, (this.keepAliveFired.get(chatKey) || 0) + 1);
      // 台账：这一棒的实际花费与命中（保温请求不进会话留档，不记就永远查不到）
      appendKeepAliveLedger({
        kind: 'warm', chatKey, model: String(api?.model || ''),
        fired: this.keepAliveFired.get(chatKey) || 1,
        prompt: nums.prompt, cached: nums.cached, created: nums.created,
        hit, ms: Date.now() - t0
      });
      if (!hit) {
        // 没命中说明接力断了（超过 TTL 或有别的前缀变化）→ 停止，别继续花钱
        const t = this.keepAliveTimers.get(chatKey);
        if (t) clearTimeout(t);
        this.keepAliveTimers.delete(chatKey);
        this.cacheKeeper.cool(api, chatKey);
      }
      console.log(`[cache] ${key} 保温第 ${this.keepAliveFired.get(chatKey)} 棒 · 输入 ${nums.prompt} · 命中 ${nums.cached}${hit ? '' : '（未命中，已停止接力）'}`);
      this.#kaLog({ phase: 'ok', chatKey, ms: Date.now() - t0, prompt: nums.prompt, cached: nums.cached, hit });
    } catch (error) {
      console.log(`[cache] 保温失败（忽略）：${error?.message ?? error}`);
      this.#kaLog({ phase: 'error', chatKey, ms: Date.now() - t0, why: String(error?.message ?? error).slice(0, 200) });
      const t = this.keepAliveTimers.get(chatKey);
      if (t) clearTimeout(t);
      this.keepAliveTimers.delete(chatKey);
    }
  }

  /** 保温链诊断日志（内存环形缓冲，给 /api/status 看；出问题时不用再靠猜）。 */
  #kaLog(row) {
    try {
      const entry = { at: Date.now(), ...row };
      this.keepAliveLog.push(entry);
      if (this.keepAliveLog.length > 60) this.keepAliveLog.shift();
      const phase = String(row?.phase || '');
      const why = String(row?.why || '');
      if (phase === 'stop' || phase === 'skip') {
        if (why) this.keepAliveStopReasons.set(why, (this.keepAliveStopReasons.get(why) || 0) + 1);
        // 落台账：同一个 (阶段, 会话, 原因) 10 分钟内只写一行，避免刷屏（skip 是每轮都会发生的）
        const key = `${phase}|${row?.chatKey || ''}|${why}`;
        if (entry.at - (this.keepAliveLedgerMark.get(key) || 0) > 600000) {
          this.keepAliveLedgerMark.set(key, entry.at);
          if (this.keepAliveLedgerMark.size > 200) this.keepAliveLedgerMark.clear();
          appendKeepAliveLedger({
            kind: phase, at: entry.at, chatKey: row?.chatKey, why,
            fired: this.keepAliveFired.get(row?.chatKey) || 0
          });
        }
      } else if (phase === 'error') {
        appendKeepAliveLedger({ kind: 'error', at: entry.at, chatKey: row?.chatKey, why, ms: row?.ms });
      }
    } catch { /* ignore */ }
  }

  /**
   * 插话闸门实况（给 /api/status 看）。
   *
   * 为什么需要：管理员反馈「响应好像还是有点高」，但配置上写的是"每小时最多 3 次"——
   * 而这两个数之间的链路（意愿%→阈值→配额）在界面上完全不可见，
   * 只能靠猜或者翻 logger。这里直接把「最近一小时实际插了几次、各会话的冷却/上限」
   * 摊开，和会话存档里的 contextReason 一对，就能判断闸门到底有没有生效。
   */
  replyGateStats() {
    const now = Date.now();
    const hourAgo = now - 3600000;
    const alive = (this.interjectTimes || []).filter((t) => Number(t) > hourAgo);
    const cfgNow = getConfig();
    const chats = [];
    for (const [chatKey, lastAt] of (this.interjectAt || new Map())) {
      let dyn = null;
      let intent = null;
      try {
        // ⚠️ 必须带上该会话的"意愿"（randomPercent）再算 —— 否则显示的是纯活跃度那套
        // 参数（300s/3 次），跟实际判定用的（意愿 2.9% → 584s/1 次）对不上，
        // 而那正是这个面板存在的意义。直接读会话设置值，和判定时的意图口径一致。
        const kind = String(chatKey).startsWith('private:') ? 'private' : 'group';
        const sc = scopedStoreConfig(cfgNow.store || {}, { kind, chatKey });
        intent = Math.max(0, Math.min(100, Number(sc?.randomPercent) || 0));
        dyn = this.#interjectLimits(chatKey, cfgNow, intent, null).dyn;
      } catch { /* 算不出来就留 null */ }
      chats.push({
        chatKey,
        lastAt,
        agoSec: Math.round((now - Number(lastAt || 0)) / 1000),
        intent: intent == null ? null : Math.round(intent),
        cooldownSec: dyn ? Math.round(Number(dyn.cooldownMs || 0) / 1000) : null,
        maxPerHour: dyn ? Number(dyn.maxPerHour || 0) : null,
        heat: dyn && dyn.heat != null ? Number(dyn.heat.toFixed(2)) : null
      });
    }
    return { lastHourInterjects: alive.length, times: alive.map((t) => ({ at: t })), chats };
  }

  /**
   * 认图闸的二次确认（主模型，极小提示词）。
   *
   * 只在本地 Jev 已判 RELATED 时调用 —— 0.8B 的错都集中在"无关 → 判相关"，
   * 而"相关"正是要附图的那一半，所以复核只花在这边；判 UNRELATED 的方向不花钱。
   * 返回 'RELATED' / 'UNRELATED' / null（失败或解析不出来 → 调用方维持本地结论）。
   */
  async #confirmImageRelevance(input, session) {
    try {
      const res = await chatCompletion({
        messages: [
          { role: 'system', content: '判断这张群友刚发的图跟刚才在聊的事有没有关系。像拿它接话/玩梗/表达情绪/回应某人 → RELATED；跟话题不搭、只是顺手发的、看不出跟谁说 → UNRELATED。只回一个词：RELATED 或 UNRELATED。' },
          { role: 'user', content: input }
        ],
        tools: null,
        temperature: 0,
        overrides: apiWith({ maxTokens: 8, disableThinking: true })
      });
      try { addUsage(session.usage, res?.usage); session.usage.calls += 1; } catch { /* ignore */ }
      const t = String(res?.message?.content || '').toUpperCase();
      if (t.includes('UNRELATED')) return 'UNRELATED';
      if (t.includes('RELATED')) return 'RELATED';
      return null;
    } catch { return null; }
  }

  /** 按 URL 在表情库里找备注 —— 认图闸的解释性输入（找不到就返回空串）。 */
  #stickerDescByUrl(url) {    try {
      const list = this.stickers?.entries || [];
      const u = String(url || '');
      if (!u) return '';
      const hit = list.find((e) => e?.url && String(e.url) === u);
      return hit?.desc ? String(hit.desc).slice(0, 30) : '';
    } catch { return ''; }
  }

  /** 保温统计（给 UI / 诊断用）。 */  cacheKeepAliveStats() {
    const dump = this.cacheKeeper.dump();
    return {
      ...this.keepAliveStats,
      // 「为什么没保温 / 为什么停了」——以前这些信息只散在内存环形日志里，重启就没了
      stopReasons: Object.fromEntries(this.keepAliveStopReasons),
      ledger: keepAliveLedgerPath(),
      ledgerTail: summarizeKeepAliveLedger(),
      chatTimers: this.keepAliveTimers.size,
      warm: dump.warm.length,
      prefixes: dump.prefixes,
      recent: dump.recent,
      log: this.keepAliveLog,
      // 每个还在接力/接力过的会话：续了几棒、定时器还在不在
      chats: [...this.keepAliveFired.entries()].map(([chatKey, fired]) => ({
        chatKey,
        fired,
        timer: this.keepAliveTimers.has(chatKey)
      }))
    };
  }

  /**
   * 取群名（公开版）。复用 #chatName 的缓存，供 HTTP 接口给 UI 显示用。
   * 与私有版的区别：这个不会因异常抛错，拿不到就返回空串（UI 自行退回显示群号）。
   */
  async getChatName(groupId) {
    try {
      return (await this.#chatName(groupId)) || '';
    } catch {
      return '';
    }
  }

  async #chatName(groupId) {
    if (this.chatNameCache.has(groupId)) return this.chatNameCache.get(groupId);
    try {
      const info = await this.onebot.getGroupInfo(groupId);
      if (info?.group_name) {
        this.chatNameCache.set(groupId, String(info.group_name));
        return String(info.group_name);
      }
    } catch { /* 拿不到就用群号 */ }
    return '';
  }

  // ── 主动开话题 ─────────────────────────────────────────────────────────

  startProactiveLoop() {
    this.stopProactiveLoop();
    const tick = async () => {
      const cfg = getConfig();
      const next = randInt(
        Math.max(60000, Number(cfg.proactive?.checkIntervalMinMs) || 1800000),
        Math.max(120000, Number(cfg.proactive?.checkIntervalMaxMs) || 5400000)
      );
      this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, next);
      if (this.aborted || this.paused) return;
      if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;
      const groupOn = cfg.proactive?.enabled === true;
      const privateIdleOn = cfg.proactive?.privateIdleEnabled === true;
      if (!groupOn && !privateIdleOn) return;
      // 挑一个"安静且允许"的会话（群按群开关，私聊按私聊开关）
      const candidates = this.#proactiveCandidates(cfg);
      if (!candidates.length) return;
      const chatKey = candidates[Math.floor(Math.random() * candidates.length)];
      const isPrivate = String(chatKey).startsWith('private:');
      const prob = isPrivate
        ? Number(cfg.proactive?.privateIdleProbability ?? cfg.proactive?.probability) || 0.25
        : Number(cfg.proactive?.probability) || 0.25;
      if (Math.random() > prob) return;
      this.wake(chatKey, { proactive: true, proactiveReason: 'idle' })
        .catch((error) => console.error('[orchestrator] proactive 出错:', error));
    };
    this.proactiveTimer = setTimeout(() => { tick().catch(() => {}); }, 15000);
    this.#startScheduleLoop();
  }

  /** 私聊定时：约每 30s 对一次钟，到点唤醒（比冷场循环密，否则分钟级定时会漂）。 */
  #startScheduleLoop() {
    const tick = async () => {
      this.scheduleTimer = setTimeout(() => { tick().catch(() => {}); }, 30000);
      try { this.#checkPrivateSchedules(); } catch { /* ignore */ }
    };
    this.scheduleTimer = setTimeout(() => { tick().catch(() => {}); }, 12000);
  }

  #checkPrivateSchedules() {
    const cfg = getConfig();
    if (cfg.proactive?.privateScheduleEnabled !== true) return;
    if (this.aborted || this.paused) return;
    const list = Array.isArray(cfg.proactive?.privateSchedules) ? cfg.proactive.privateSchedules : [];
    if (!list.length) return;
    if (this.runningChats.size >= Math.max(1, Number(cfg.maxConcurrentRuns) || 2)) return;

    const allowPrivate = (cfg.allow?.private ?? []).map(String);
    const now = new Date();
    const hh = String(now.getHours()).padStart(2, '0');
    const mm = String(now.getMinutes()).padStart(2, '0');
    const time = `${hh}:${mm}`;
    const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
    const dow = now.getDay(); // 0=Sun

    for (const item of list) {
      if (!item || item.enabled === false) continue;
      const chatId = String(item.chatId || item.userId || item.id || '').trim();
      if (!/^\d{5,15}$/.test(chatId)) continue;
      if (allowPrivate.length && !allowPrivate.includes(chatId)) continue;
      const t = String(item.time || '').trim();
      if (!/^\d{1,2}:\d{2}$/.test(t)) continue;
      const [th, tm] = t.split(':').map((x) => Number(x));
      if (Number.isNaN(th) || Number.isNaN(tm)) continue;
      const target = `${String(th).padStart(2, '0')}:${String(tm).padStart(2, '0')}`;
      if (target !== time) continue;
      const days = Array.isArray(item.days) ? item.days.map(Number).filter((n) => n >= 0 && n <= 6) : [];
      if (days.length && !days.includes(dow)) continue;

      const fireKey = `${chatId}|${target}|${dateKey}`;
      if (this.lastScheduleFired.has(fireKey)) continue;
      this.lastScheduleFired.set(fireKey, Date.now());
      // 防泄漏：只留最近 200 条标记
      if (this.lastScheduleFired.size > 200) {
        const keys = [...this.lastScheduleFired.keys()];
        for (const k of keys.slice(0, keys.length - 100)) this.lastScheduleFired.delete(k);
      }
      const chatKey = `private:${chatId}`;
      if (this.runningChats.has(chatKey)) continue;
      console.log(`[orchestrator] 私聊定时触发 ${chatKey} @${target}`);
      this.wake(chatKey, { proactive: true, proactiveReason: 'schedule' })
        .catch((error) => console.error('[orchestrator] schedule proactive 出错:', error));
      break; // 一次循环只打一个，避免并发
    }
  }

  #proactiveCandidates(cfg) {
    const groupOn = cfg.proactive?.enabled === true;
    const privateIdleOn = cfg.proactive?.privateIdleEnabled === true;
    if (!groupOn && !privateIdleOn) return [];
    const groupIdleMs = Math.max(300000, Number(cfg.proactive?.idleThresholdMs) || 1800000);
    const privateIdleMs = Math.max(60000, Number(cfg.proactive?.privateIdleThresholdMs) || groupIdleMs);
    const allowGroups = (cfg.allow?.groups ?? []).map(String);
    const allowPrivate = (cfg.allow?.private ?? []).map(String);
    const out = [];
    for (const chatKey of this.store.listChats()) {
      const [kind, id] = chatKey.split(':');
      if (kind === 'group') {
        if (!groupOn) continue;
        if (allowGroups.length > 0 ? !allowGroups.includes(id) : !cfg.allowAllWhenEmpty) continue;
      } else if (kind === 'private') {
        if (!privateIdleOn) continue;
        // 私聊白名单：空列表时不主动私聊（防骚扰陌生人）
        if (!allowPrivate.includes(id)) continue;
      } else {
        continue;
      }
      const meta = this.store.getChatMeta(chatKey);
      if (meta.unread > 0) continue;
      const idleMs = kind === 'private' ? privateIdleMs : groupIdleMs;
      if (Date.now() - meta.lastTs < idleMs) continue;
      if (this.runningChats.has(chatKey)) continue;
      out.push(chatKey);
    }
    return out;
  }

  // ── 群友印象自动整理 ──
  // 触发条件（二者同时满足）：印象条数超过阈值，且距上次整理超过冷却时间。
  //
  // 阈值原为硬编码 8，实测用户群里 5 位成员各 1 条印象（合计 5），5 > 8 恒 false
  // → 自动整理永远不触发。改为可配置（config.memory.consolidateMinImpressions），
  // 且默认值下调，避免在"人不多、印象还没攒起来"的群里彻底失灵。
  static MEMORY_THRESHOLDS = { memberImpression: 4 };
  static MEMBER_MIN_MESSAGES = 3;         // 整理条件：该群友在聊天记录里至少出现 3 条
  static MEMBER_MIN_IMPRESSIONS = 1;      // 整理条件：至少有 1 条印象（旧数据也可整理）
  // "发现新人"：批量整理时，聊天记录里发言够多但完全没有印象的人，也纳入整理（新建印象）。
  // 否则记忆为空的群点整理会得到"没有可整理的群友"，功能对新群完全无效。
  static DISCOVER_MIN_MESSAGES = 20;      // 至少发过这么多条才值得分析
  static DISCOVER_MAX_MEMBERS = 3;        // 单次最多发现几个人（控制成本）

  #maybeConsolidateMemory(chatKey) {
    try {
      const cfg = getConfig();
      if (cfg.memory?.consolidateEnabled === false) return;
      if (this.paused || this.aborted) return;
      if (!cfg.api?.model || !cfg.api?.baseUrl) return;   // 没选模型就不整理
      if (this.consolidating.has(chatKey)) return;
      const st = this.memory.consolidationState(chatKey);
      // 阈值可配置：config.memory.consolidateMinImpressions（默认取类常量）
      // 注意：这里原先误写成裸标识符 T，运行时会抛 ReferenceError 导致自动整理彻底失效。
      const minImpressions = Math.max(1,
        Number(cfg.memory?.consolidateMinImpressions) || Orchestrator.MEMORY_THRESHOLDS.memberImpression);
      // 触发条件二选一：
      //   A. 全群印象总数超过阈值
      //   B. 任一成员的印象条数超过上限
      // 只看总数会在"人少"的群里彻底失灵 —— 比如 3 位成员各 1 条，
      // 总数 3 永远够不到阈值，自动整理形同虚设。
      //
      // ⚠️ 2026-09-22：这个上限从 5 提到 12（config 里默认也是 12）。
      //   用户反馈"印象到一定条数就加不进去了"：原来超过 5 条就触发整理，
      //   而整理提示词又写着"最多保留 5/8 条"，等于刚记满就被压回去。
      //   现在整理是"去重与合并"，不是"裁员"：条数多不是问题（注入端只挑 2 条）。
      const maxPerMember = Math.max(4, Number(cfg.memory?.maxImpressionsPerMember) || 12);
      const anyMemberOverloaded = st.members.some((m) => m.count > maxPerMember);
      if (!(st.counts.memberImpression > minImpressions) && !anyMemberOverloaded) return;
      // 默认 7 天（config）；最小不低于 1 小时
      const minInterval = Math.max(60 * 60 * 1000, Number(cfg.memory?.consolidateMinIntervalMs) || 7 * 24 * 60 * 60 * 1000);
      if (Date.now() - (st.lastConsolidatedAt || 0) < minInterval) return;
      this.consolidating.add(chatKey);
      this.consolidateMemoryForChat(chatKey)
        .catch((error) => console.error(`[memory] 整理 ${chatKey} 失败:`, error?.message ?? error))
        .finally(() => this.consolidating.delete(chatKey));
    } catch { /* 整理是锦上添花，绝不影响聊天主流程 */ }
  }

  /**
   * 这段正文看着像"内心独白/计划"，而不是"要说给群里听的话"吗？
   *
   * 背景（09-11 晚，号A 换成 3.7-flash 之后）：那个模型经常**不调工具**、只写一段思考，
   * 而应用有条兜底会把"像话的正文"替它发出去 —— 于是群里收到的是：
   *   「#830001 江边月下柳 @我了，得回一下。」
   *   「这突如其来的表扬让我有点措手不及…被夸了还是要回应一下的」
   *   「回复他：？我真是鲸鱼娘」
   * 缩角色卡治不了它（实测长卡 7384 字、短卡 5205 字**都漏**），因为问题不在卡，
   * 在于兜底太信任正文。这里做确定性拦截：命中就这一轮安静结束，不发。
   */
  static looksLikeNarration(text) {
    return Orchestrator.narrationHit(text) >= 0;
  }

  /**
   * 返回命中的规则序号（-1 = 没命中）。抽出来是为了两件事：
   *   ① 误伤审计：拿真实发出的发言跑一遍，看究竟是哪条规则在拦好话；
   *   ② selftest 里能断言"是被哪条拦的"，而不是只测 true/false。
   */
  static narrationHit(text) {
    const t = String(text ?? '').trim();
    if (!t) return -1;
    const signals = Orchestrator.narrationSignals();
    for (let i = 0; i < signals.length; i++) {
      if (signals[i].test(t)) return i;
    }
    // 整段几乎没有中文、又提到对话本身 → 当成思考（群友聊天不会用英文写这种句子）
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk === 0 && t.length > 24 && /\b(conversation|message|respond|reply|user|observe|contribut|situation|context)\b/i.test(t)) {
      return signals.length;
    }
    return -1;
  }

  /** 独白/计划判定用到的全部规则（顺序即编号，见 narrationHit）。 */
  static narrationSignals() {
    return [
      /#\d{4,}/,                                                      // 把消息 id 抄进正文
      /【(本次唤醒|过去状态|当前时间|可用表情包|角色设定|引导说明)】/,      // 把提示词段落抄出来
      /(回复他|回复她|回复#|回他|回一下|得回一下|要回应一下|该不该回|这轮(该|要|应))/,
      /(本次唤醒是|过去状态里|最后一条消息是|不是本次唤醒)/,
      // ⚠️ 2026-09-21 误伤审计：`我看看` 太宽 —— 实测拦掉了
      //   「搓完记得给我看看」「你牛一个我看看」「什么视频？给我看看」「…文件名截图我看看」
      // 这些是"要看东西"的正常聊天。真正的独白形态是**行首**的「让我看看这张图片，这是…」。
      /^(?:让我?看看|我瞅瞅)[，,：:\s]*(?:情况|上下文|这|那|图|图片|消息|该怎么|怎么回|要不要)/m,
      /(我注意到|我意识到|让我(有点)?措手不及|看起来(之前|这)|应该是被)/,
      /(没人叫|没人在找|话题.{0,4}翻篇|安静结束|安静看|不用插话)/,
      /(用数|用 send_|调用 send_|要调工具|需要调用)/i,
      /^\s*[-•*]\s*(引用|顺便|回复|接一下)/m,                            // 计划式项目符号
      // 英文独白（实测 09-11 23:0x，免费云模型 agnes-3.0-flash 会在中文群里突然用英文思考）：
      //   "I'm just going to observe the conversation without contributing, as it…"
      //   "Looking at the current situation:\n- No new messages in 【本次唤醒】…"
      // 中文规则抓不住这些，只能加英文特征词 + "英文占比高"这条。
      /\b(I'?m (just |going to|not going to)|I (will|should|need to|am going to)|Let me|Looking at (the|this)|The user|No new messages|as an AI|I think I)\b/i,
      // Markdown 项目符号列表（群里不会这么说话；要求至少两条，免得把"—— 好"这种误伤）
      /^\s*[-•*]\s*\S[\s\S]*\n\s*[-•*]\s*\S/m,
      // 思考过程常见句式（09-12 号A 实测泄漏）：
      //   「被直接问到了…根据设定，被问到是不是AI可以大方承认…」
      //   「他这句有点…我应该…」
      /(根据|按照)(角色卡|人设|设定|规则|铁律|提示)/,
      /(我(应该|得|要|打算|准备|考虑)(怎么|如何|先|先去|先回|先顶|先损|先发|先接|先嘴硬))/,
      /(他(这句|那句|这话)|她(这句|那句)).{0,12}(没头没尾|有点|有点怪|在说我|是在说)/,
      /(先判断|先决定|要不要(接|回|顶|损|回应)|接不接|回不回|损不损)/,
      /(这轮|这次|这一条|这条消息).{0,8}(该不该|要不要|先|直接)/,
      /(打算发|准备发|我先发|要发的话|发出去的话)/,
      /(选(一个|一句|个)(最|更|跟上|合适)|备选|候选句|更自然的)/,
      // 多行"分析 + 计划"腔：至少两行都在讲怎么处理
      /^(?:[^。\n]{0,24}(?:分析|判断|决定|准备|打算|应该|根据)[^。\n]{0,40}[。\n]?){2,}/m,
      // 提示词口吻回声（实测 2026-09-21 20:41 群发，判定方是 localJev）：
      //   「有点得意的情绪，可以顺着"我神出鬼没"接梗。不用查记忆，这是玩笑话不是旧事细节。」
      // 特征：句子在**描述该怎么回**（情绪/倾向/接梗建议），而不是在回话。
      /(倾向[:：]|可以接梗|顺着.{0,8}接梗|别过火|沾一点|用得上就|用不上就|当没看见|别硬套)/,
      /(不用查记忆|不是旧事|这是玩笑话|别念时间戳|当常识|不用翻记忆)/,
      // ⚠️ 必须带"引用/句子结尾"形态，否则会误伤正常台词 ——
      //   实测「记 **得回** 来告诉我啥毛病」「明早还 **得接** 着跟各家agent斗智斗勇」被拦。
      /(?:得回|该回|得接|该接|要回一下)(?:一下|他|她|这条|那条|这句|那句|了)?(?=[。！？，、\s]|$)/,
    ];
  }

  /**
   * 整理群友印象 —— 唯一入口。
   * 手动按钮、自动整理、针对特定群友，三种用法都走这里，避免逻辑分叉走样。
   *
   * @param {string} chatKey  会话 key
   * @param {object} [opts]
   * @param {string[]} [opts.userIds]  只整理这些人（指定群友时用）；不传 = 按规则筛选全部
   * @param {boolean} [opts.force]     跳过冷却/门槛检查（手动触发时用）
   * @returns {Promise<{ok, note, changed, results, skipped, failed}>}
   *
   * 身份识别（"同一个人"的判定）：
   *   1) 优先用记忆里的 userId（QQ 号）匹配聊天记录 senderId；
   *   2) 匹配不到时，用备注名/记忆名反查 senderName，命中后把 QQ 号回写进记忆；
   *   3) 仍匹配不到但有名字 → 允许整理（历史遗留的"按名字存"条目不能永远排队）；
   *   4) 既无名也无号 → 跳过。
   */
  async consolidateMemoryForChat(chatKey, { userIds = null, force = false } = {}) {
    const cfg = getConfig();
    if (!cfg.api?.model || !cfg.api?.baseUrl) throw new Error('模型未配置，无法整理记忆');
    const notes = cfg.memberNotes || {};
    const only = Array.isArray(userIds) && userIds.length
      ? new Set(userIds.map((u) => String(u ?? '').trim()).filter(Boolean))
      : null;

    const stats = this.#scanChatActivity(chatKey);
    const existing = this.memory.members(chatKey);

    // ── 选出要整理的人 ──
    const targets = [];
    const skipped = [];

    // 指定群友但记忆里还没有 → 也要能"新建"印象（这是本功能的关键价值：
    // 聊了 200 条却零印象的人，可以手动让他被分析一次）
    if (only) {
      for (const uid of only) {
        const found = existing.find((m) => String(m.userId || '') === uid);
        if (found) {
          const resolved = this.#resolveIdentity(chatKey, found, stats, notes);
          targets.push({ ...resolved, isNew: false });
          continue;
        }
        // 记忆里没有这个人：用聊天记录里的名字兜底，允许新建
        const name = stats.uidToName.get(uid) || notes[uid] || '';
        if (!name && !stats.memberMsgCount.get(uid)) {
          skipped.push({ userId: uid, name: '', reason: '聊天记录里没有此人发言' });
          continue;
        }
        targets.push({
          userId: uid,
          name: name || `QQ ${uid}`,
          impressions: [],
          isNew: true
        });
      }
    } else {
      // 先整理记忆里已有的人
      const knownUserIds = new Set();
      for (const mem of existing) {
        const resolved = this.#resolveIdentity(chatKey, mem, stats, notes);
        if (String(resolved.userId || '')) knownUserIds.add(String(resolved.userId));
        if (this.#shouldSkip(resolved, force)) {
          skipped.push({
            userId: resolved.userId,
            name: resolved.name,
            reason: this.#skipReason(resolved)
          });
          continue;
        }
        targets.push({ ...resolved, isNew: false });
      }

      // 再"发现"聊天记录里的活跃群友：他们发言很多却没有任何印象。
      // 没有这一步，记忆为空的群（如刚启用记忆的群）点整理只会得到
      // "没有可整理的群友"，功能形同虚设。
      const discoverMin = Math.max(1,
        Number(cfg.memory?.discoverMinMessages) || Orchestrator.DISCOVER_MIN_MESSAGES);
      const discoverMax = Math.max(1,
        Number(cfg.memory?.discoverMaxMembers) || Orchestrator.DISCOVER_MAX_MEMBERS);
      const discovered = [...stats.memberMsgCount.entries()]
        .filter(([uid, n]) => n >= discoverMin && !knownUserIds.has(uid))
        .sort((a, b) => b[1] - a[1])
        .slice(0, discoverMax);
      for (const [uid, n] of discovered) {
        // 手动清空过的人：不要再从聊天里「新建印象」挖回来
        if (this.memory?.isManuallyEdited?.(uid)) {
          skipped.push({
            userId: uid,
            name: stats.uidToName.get(uid) || notes[uid] || '',
            reason: '刚手动清空/改过，跳过新建'
          });
          continue;
        }
        targets.push({
          userId: uid,
          name: stats.uidToName.get(uid) || notes[uid] || `QQ ${uid}`,
          impressions: [],
          isNew: true,
          discoveredFrom: n
        });
      }
    }

    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';

    if (!targets.length) {
      return {
        ok: true,
        note: `没有可整理的群友${skippedNote || (only ? '（未指定有效群友）' : '（该群还没有任何群友印象，且聊天记录里没有发言足够多的活跃成员）')}`,
        changed: 0,
        results: [],
        skipped,
        failed: []
      };
    }

    // ── 逐个整理 ──
    const results = [];
    const failed = [];
    let changed = 0;

    for (const mem of targets) {
      if (this.aborted) break;
      // 手动刚改过的（含删印象）不要被整理覆盖 —— 否则「删完又写回」
      if (mem.userId && this.memory?.isManuallyEdited?.(mem.userId)) {
        skipped.push({ userId: mem.userId, name: mem.name, reason: '刚手动改过，跳过整理' });
        continue;
      }
      // 手动清空过印象的人：一键整理不要当「新人」从聊天里再挖一遍
      if (mem.isNew && mem.userId && this.memory?.isManuallyEdited?.(mem.userId)) {
        skipped.push({ userId: mem.userId, name: mem.name, reason: '刚手动清空过，跳过新建' });
        continue;
      }
      const before = mem.impressions.map((e) => e.content);
      try {
        const next = await this.#consolidateOneMember(chatKey, mem, { force, stats });
        if (!next) {
          if (mem.userId && this.memory?.isManuallyEdited?.(mem.userId)) {
            skipped.push({ userId: mem.userId, name: mem.name, reason: '整理期间被手动修改，已放弃写入' });
          } else {
            failed.push({ userId: mem.userId, name: mem.name, reason: '模型返回无法解析' });
          }
          continue;
        }
        const after = next.impressions.map((e) => e.content);
        const isChanged = after.length !== before.length || after.some((c, i) => c !== before[i]);
        if (isChanged) changed += 1;
        results.push({
          userId: mem.userId,
          name: mem.name,
          before: before.length,
          after: after.length,
          changed: isChanged,
          isNew: !!mem.isNew
        });
      } catch (error) {
        failed.push({ userId: mem.userId, name: mem.name, reason: String(error?.message ?? error) });
      }
    }

    const discoveredCount = targets.filter((t) => t.isNew).length;
    const note = this.#buildConsolidateNote({
      total: targets.length, changed, failed, skipped, only, discoveredCount
    });
    // 只标记「真正跑过整理」的人；跳过/失败的不要写 lastConsolidatedAt
    const doneIds = results.map((r) => r.userId).filter(Boolean);
    this.#markConsolidated(chatKey, doneIds);
    // 顺带用模型抽 1~2 张语义卡（弱模型/号B 可关）
    try {
      await this.extractSemanticCardsForChat(chatKey);
    } catch (e) {
      console.log(`[memory] 语义卡抽取失败（忽略）: ${e?.message ?? e}`);
    }
    return { ok: true, note, changed, results, skipped, failed };
  }

  /**
   * 从最近群聊抽 1~2 张长期语义卡（plan/fact/topic）。
   * 正则卡太死；这里用一次小模型，失败不写。
   */
  async extractSemanticCardsForChat(chatKey) {
    const cfg = getConfig();
    if (cfg.api?.architecture?.semanticCards === false) return 0;
    if (cfg.memory?.semanticCardsViaLlm === false) return 0;
    if (!cfg.api?.model || !cfg.api?.baseUrl) return 0;
    const msgs = (this.store.recent(chatKey, { limit: 120 }) || [])
      .filter((m) => !m.self && String(m.text || '').trim().length >= 10
        && !/^\[(图片|表情|语音|视频)\]/.test(String(m.text || '')))
      .slice(-16);
    if (msgs.length < 8) return 0;
    const stripNoise = (t) => String(t || '')
      .replace(/\[CQ:[^\]]*\]/gi, ' ')
      .replace(/\[[^\]]{0,12}\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const sample = msgs
      .map((m) => `${String(m.senderName || m.senderId || '?')}: ${stripNoise(m.text).slice(0, 100)}`)
      .join('\n');
    const res = await this.#memoryChat([
      {
        role: 'system',
        content: [
          // ⚠️ 2026-09-21：老提示词写着"只基于原文"，模型就**照抄原句**交上来 ——
          //   实测 400 张卡里 228 张是消息片段（「睡吧 明天还得早起」）。
          //   现在要求写成"能独立看懂的一句话"，并明确列出不要的类型。
          '从群聊记录里抽最多 2 张「以后还用得上」的长期卡片。',
          '必须写成**能独立看懂的一句话**（谁 + 什么事），像人记事情那样；',
          '不要照抄原句、不要半截话、不要带 @某人 / [CQ:] / 表情占位。',
          'type：plan=有人约好或答应了以后要做的事；fact=关于某人的稳定事实或偏好；topic=值得记住的话题结论。',
          'title ≤ 40 字，detail ≤ 120 字；只依据原文，不要发明没出现的信息。',
          '闲聊、吐槽、告别（「明天见」「睡吧」）、感慨、复读，一律不要 —— 宁可不抽。',
          '只输出 JSON：{"cards":[{"type":"fact","title":"…","detail":"…"}]}，没有则 {"cards":[]}'
        ].join('\n')
      },
      { role: 'user', content: sample }
    ]);
    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    const cards = Array.isArray(parsed?.cards) ? parsed.cards : [];
    return await getArchMemory().cards.ingestLlmCards(chatKey, cards.slice(0, 2));
  }

  /** 统计会话里各成员的出现次数与名字（用于身份识别与"新建印象"）。 */
  #scanChatActivity(chatKey) {
    const memberMsgCount = new Map();
    const nameMsgCount = new Map();
    const nameToUserId = new Map();
    const uidToName = new Map();
    for (const m of this.store.recent(chatKey, { limit: 2000 })) {
      if (m.self || !m.senderId) continue;
      const uid = String(m.senderId);
      memberMsgCount.set(uid, (memberMsgCount.get(uid) || 0) + 1);
      const nm = String(m.senderName || '').trim();
      // 跳过占位名（历史脏数据：拍一拍事件曾把 senderName 写成"（拍一拍事件）"）
      if (nm && !PLACEHOLDER_NAMES.has(nm)) {
        nameMsgCount.set(nm, (nameMsgCount.get(nm) || 0) + 1);
        if (!nameToUserId.has(nm)) nameToUserId.set(nm, uid);
        if (!uidToName.has(uid)) uidToName.set(uid, nm);
      }
    }
    return { memberMsgCount, nameMsgCount, nameToUserId, uidToName };
  }

  /** 确定一个记忆条目的 QQ 号。只改内存里的 userId，绝不回写印象文件。 */
  #resolveIdentity(chatKey, mem, stats, notes) {
    let userId = String(mem.userId || '').trim();
    let msgCount = userId ? (stats.memberMsgCount.get(userId) || 0) : 0;

    if (msgCount < Orchestrator.MEMBER_MIN_MESSAGES) {
      const candidates = [notes[userId], mem.name, userId].filter(Boolean);
      for (const name of candidates) {
        const byName = stats.nameMsgCount.get(name) || 0;
        if (byName >= Orchestrator.MEMBER_MIN_MESSAGES) {
          const matched = stats.nameToUserId.get(name) || '';
          if (matched) {
            userId = matched;
            msgCount = byName;
            // ⚠️ 以前这里 replaceMember(旧印象快照)：整理过程中用户一删，
            // 快照会把刚删的内容原样写回。现在只改内存字段，不动磁盘。
          }
          break;
        }
      }
    }
    return { ...mem, userId, name: mem.name || stats.uidToName.get(userId) || '', msgCount };
  }

  /** 批量整理时是否跳过某人（指定群友 / 强制模式不跳过）。 */
  #shouldSkip(resolved, force) {
    if (force) return false;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !String(resolved.name || '').trim()) return true;
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES && !resolved.impressions.length) return true;
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return true;
    return false;
  }

  #skipReason(resolved) {
    if (resolved.impressions.length < Orchestrator.MEMBER_MIN_IMPRESSIONS) return '没有印象';
    if (resolved.msgCount < Orchestrator.MEMBER_MIN_MESSAGES) return '聊天记录出现不足 3 条';
    return '无法确认身份';
  }

  /** 生成人话总结：区分"整理过但没变化"与"真的失败了"。 */
  #buildConsolidateNote({ total, changed, failed, skipped, only, discoveredCount = 0 }) {
    const skippedNote = skipped.length
      ? `（跳过 ${skipped.length} 位：${skipped.slice(0, 3).map((s) => `${s.name || s.userId} ${s.reason}`).join('；')}${skipped.length > 3 ? ' 等' : ''}）`
      : '';
    const head = only ? '已整理指定群友' : '已整理';
    const discoverNote = discoveredCount > 0 ? `（其中 ${discoveredCount} 位是新建印象）` : '';
    const body = changed > 0
      ? `${head} ${total} 位${discoverNote}，其中 ${changed} 位印象有更新`
      : `${head} ${total} 位${discoverNote}，内容无需改动（印象已足够精简）`;
    const failNote = failed.length
      ? `；${failed.length} 位失败（已保留原印象）`
      : '';
    return body + failNote + skippedNote;
  }

  /** 记录整理时间，供冷却判断使用。 */
  #markConsolidated(chatKey, userIds) {
    const now = Date.now();
    try {
      this.memory.markConsolidated(chatKey, now, userIds);
    } catch (error) {
      console.warn('[memory] 记录整理时间失败:', error?.message ?? error);
    }
  }

  /**
   * 整理单个群友的印象。
   *
   * 两种模式：
   *   - 整理模式（已有印象）：合并重复、删过时，只减不增，绝不发明新事实
   *   - 新建模式（isNew，针对零印象的活跃群友）：读他最近的发言，提炼长期印象
   *
   * 新建模式是本功能的关键补充：实测有群友聊了 200+ 条却零印象，
   * 而模型日常几乎不主动调 memory_append —— 没有这个入口就永远补不上。
   */
  async #consolidateOneMember(chatKey, mem, { force = false, stats = null } = {}) {
    const existing = mem.impressions || [];
    const isNew = !!mem.isNew || (!existing.length && !!force);

    const { system, user } = isNew
      ? this.#buildNewImpressionPrompt(chatKey, mem, stats)
      : this.#buildConsolidatePrompt(mem);

    const res = await this.#memoryChat([
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]);

    const parsed = extractJsonObject(String(res?.message?.content ?? ''));
    if (!parsed) {
      console.warn(`[memory] ${isNew ? '新建' : '整理'} ${chatKey}/${mem.userId || mem.name} 结果无法解析为 JSON，本轮放弃`);
      if (process.env.QQ_AGENT_DEBUG_MEMORY) {
        console.warn('[memory][debug] 原始返回 =', JSON.stringify(String(res?.message?.content ?? '')).slice(0, 1500));
      }
      return null;
    }

    const raw = Array.isArray(parsed.impressions) ? parsed.impressions : [];
    // ⚠️ 2026-09-22：这里原来是 `|| 5`，于是"整理"变成了"裁员"——
    //   用户手动记了 12 条，一次自动整理就被 `slice(0, 5)` 砍回 5 条（看起来就是"加不进去"）。
    //   现在：上限取配置（默认 12），而且**整理模式不允许低于现有条数**——
    //   整理只负责合并重复/改写啰嗦，不负责压条数；真要删也得模型自己判断该删哪条。
    const cfgMax = Math.max(4, Number(getConfig().memory?.maxImpressionsPerMember) || 12);
    const maxKeep = isNew ? cfgMax : Math.max(cfgMax, existing.length);

    // 模型返回期间用户可能刚删过 —— 再查一次，宁可丢弃整理结果也不写回废数据
    if (mem.userId && this.memory?.isManuallyEdited?.(mem.userId)) {
      console.warn(`[memory] ${chatKey}/${mem.userId} 整理期间被手动修改，放弃写入`);
      return null;
    }

    // 整理模式：条数**小幅**变多允许（把一条啰嗦的拆成两条是合理整理），
    // 但明显暴涨（> +2 条）仍按幻觉拦掉 —— 原来是一律不许变多，
    // 于是"整理"永远只能减不能增，跟用户想"多记点"的诉求正好相反。
    if (!isNew && raw.length > existing.length + 2) {
      console.warn(`[memory] 整理 ${chatKey}/${mem.userId} 结果条数暴涨（${existing.length}→${raw.length}），疑似幻觉，放弃`);
      return null;
    }

    const clean = raw
      .map((s) => String(s ?? '').trim())
      .filter(Boolean)
      .slice(0, maxKeep)
      .map((content) => content.slice(0, 120));

    return this.memory.replaceMember(chatKey, mem.userId, mem.name, clean, { markManual: false });
  }

  /** 整理模式：合并/删减已有印象（偏保守，少删）。 */
  #buildConsolidatePrompt(mem) {
    const fmtTs = (t) => new Date(t).toISOString().slice(0, 16).replace('T', ' ');
    const lines = [`群友 QQ：${mem.userId}`, `当前名字：${mem.name}`];
    for (const e of mem.impressions) lines.push(`- ${e.content} (${fmtTs(e.createdAt)})`);
    // 上限不低于现有条数：整理不是裁员（见 #consolidateOneMember 里的说明）
    const maxKeep = Math.max(
      Math.max(4, Number(getConfig().memory?.maxImpressionsPerMember) || 12),
      (mem.impressions || []).length
    );
    return {
      system: '你是聊天机器人的记忆整理模块，负责整理对某一位群友的长期印象。只做合并与改写；**尽量保留**，不要轻易删。绝不发明任何新事实。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        '下面是机器人对一位群友的全部印象，请整理：',
        '1. 同义/几乎相同的合并成一条，保留更完整、更新的表述。',
        '2. **只有**整条是无意义垃圾、或明显写错且无法改写时才删；一般过时但仍有参考价值的**改写保留**（如去掉具体日期）。',
        '3. 喜好/雷点/身份/长期风格 **优先保留**；一次性闲聊可删。',
        `4. 条数不用刻意压：**合并掉重复的**就行，有用的信息一条都别丢（上限 ${maxKeep} 条，是别超，不是要凑到；每条不超过 120 字）。`,
        '原则：信息只能来自原文，语义不变；没有可保留时才输出空数组。',
        '',
        ...lines
      ].join('\n')
    };
  }

  /** 新建模式：从聊天记录里提炼对某人的长期印象。 */
  #buildNewImpressionPrompt(chatKey, mem, stats) {
    const maxKeep = Math.max(4, Number(getConfig().memory?.maxImpressionsPerMember) || 12);
    const uid = String(mem.userId || '');
    const sample = (this.store.recent(chatKey, { limit: 2000 }) || [])
      .filter((m) => !m.self && String(m.senderId) === uid)
      .slice(-40)
      .map((m) => String(m.text || '').slice(0, 200))
      .filter(Boolean);

    return {
      system: '你是聊天机器人的记忆模块，负责从聊天记录里提炼对某一位群友的长期印象。只提炼"以后跟这个人打交道用得上"的稳定特征，严格依据给定的发言，不要编造。输出必须是严格的 JSON 对象，不要 Markdown 代码块，不要任何解释文字。格式：{"impressions":["…"]}',
      user: [
        `下面是群友（QQ ${uid}${(mem.name && `，名字 ${mem.name}`) || ''}）最近的部分发言，请提炼对他的长期印象：`,
        '1. 只保留稳定特征：说话风格、爱玩的梗、常聊话题、雷点、身份关系。',
        '2. 不要记一次性事件、临时话题，也不要记录流水账。',
        `3. 最多 ${maxKeep} 条，每条不超过 120 字，用第一人称视角（"他/她…"）。宁可分细一点：不同方面各记一条，别硬压成一条大杂烩。`,
        '4. 宁少勿错：信息不足就少写，不要脑补。',
        '5. 若实在提炼不出任何稳定特征，输出空数组。',
        '',
        sample.length ? sample.join('\n') : '（没有抓到该群友的发言）'
      ].join('\n')
    };
  }

  /**
   * 记忆整理专用模型调用。
   * useChatModel=true 时跟随聊天模型（cfg.api.*）；
   * false 时使用 cfg.memory.provider/model 指向的目录模型（端点/密钥取自 providers）。
   */
  async #memoryChat(messages) {
    const cfg = getConfig();
    const mem = cfg.memory || {};
    if (mem.useChatModel !== false) {
      // 记忆整理是后台任务，不需要"思考"：显式关掉。
      // ⚠️ 必须走 apiWith()：它会 resolveApiKey（号B 的密钥在 dshProviderKeys，
      // cfg.api.apiKey 常为空）。若直接 {...getConfig().api}，请求会 401/无效令牌，
      // 控制台点「自动整理」就会报错（号A 误打误撞 api.apiKey 有值所以没炸）。
      return chatCompletion({ messages, temperature: 0.2, overrides: apiWith({ disableThinking: true }) });
    }
    const providers = currentProviders();
    const p = providers.find((x) => x.id === mem.provider);
    const key = String(p?.apiKey || '').trim() === '******'
      ? ''
      : String(p?.apiKey || '').trim();
    const resolved = key || (p ? resolveApiKey({ api: { provider: p.id }, dshProviderKeys: cfg.dshProviderKeys, providers: cfg.providers }) : '');
    if (!p?.baseURL || !resolved || !mem.model) {
      throw new Error('记忆整理专用模型未配置：请在设置 → 记忆里选择提供商与模型');
    }
    return chatCompletion({
      messages,
      temperature: 0.2,
      overrides: { baseUrl: p.baseURL, apiKey: resolved, model: mem.model, timeoutMs: 180000, disableThinking: true }
    });
  }

  stopProactiveLoop() {
    clearTimeout(this.proactiveTimer);
    this.proactiveTimer = null;
    clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
  }

  // ── 控制接口 ───────────────────────────────────────────────────────────

  setPaused(paused, reason = 'manual') {
    this.paused = !!paused;
    this.pauseReason = this.paused ? reason : null;
    this.emit('status', { paused: this.paused, pauseReason: this.pauseReason });
  }

  async abortAll() {
    this.aborted = true;
    for (const timer of this.wakeTimers.values()) clearTimeout(timer);
    this.wakeTimers.clear();
    this.pendingWake.clear();

    for (const sessionId of this.pendingSessions.values()) this.#finishWaiting(sessionId, 'aborted');
    this.pendingSessions.clear();
    this.stopProactiveLoop();
  }

  statusSummary() {
    const cfg = getConfig();
    return {
      paused: this.paused,
      pauseReason: this.pauseReason ?? null,
      running: [...this.runningChats],
      activeSessions: [...this.activeRuns.entries()].flatMap(([chatKey, v]) =>
        (Array.isArray(v) ? v : [v]).map((sessionId) => ({ chatKey, sessionId }))
      ),
      consolidating: [...this.consolidating],
      onebotConnected: this.onebot.connected,
      model: cfg.api.model,
      maxConcurrentRuns: cfg.maxConcurrentRuns
    };
  }
}

function safeParse(text) {
  try { return typeof text === 'string' ? JSON.parse(text) : text; } catch { return { raw: String(text).slice(0, 500) }; }
}

/**
 * 聊天记录里可能出现的占位名（非真实昵称）。
 * 来源：历史版本的拍一拍事件把 senderName 硬编码成"（拍一拍事件）"。
 * 取名字时必须跳过，否则记忆里会出现"某人的名字叫（拍一拍事件）"。
 */
const PLACEHOLDER_NAMES = new Set([
  '（拍一拍事件）',
  '(拍一拍事件)',
  '未知',
  '某人'
]);

/**
 * 从模型输出里稳健提取 JSON 对象。
 *
 * 模型并不总会乖乖只吐 JSON，常见变体：
 *   1) ```json\n{...}\n```            —— Markdown 代码块
 *   2) "好的，这是整理结果：\n{...}"   —— 前后带解释文字
 *   3) '{"impressions":[...]}'        —— 用了单引号
 *   4) 结尾多了个逗号                  —— 尾随逗号
 * 原实现只会剥掉"整段被 ``` 包裹"这一种，其余全部解析失败 → 整理静默放弃。
 */
function extractJsonObject(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;

  // 1) 先尝试直接解析
  try { return JSON.parse(text); } catch { /* 继续尝试 */ }

  // 2) 剥掉 ``` 代码块（可能在中间任意位置）
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidates = [];
  if (fence) candidates.push(fence[1].trim());

  // 3) 取第一个 { 到最后一个 } 之间的内容
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first >= 0 && last > first) candidates.push(text.slice(first, last + 1));

  for (const cand of candidates) {
    try { return JSON.parse(cand); } catch { /* 继续 */ }
    // 修正常见瑕疵后重试：尾随逗号、单引号
    try {
      const fixed = cand
        .replace(/,\s*([}\]])/g, '$1')          // 尾随逗号
        .replace(/'/g, '"');                     // 单引号 → 双引号
      const parsed = JSON.parse(fixed);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch { /* 继续 */ }
    // 兜底：只抽 impressions 数组
    const arrMatch = cand.match(/"impressions"\s*:\s*\[([\s\S]*?)\]\s*[,}]?/);
    if (arrMatch) {
      try {
        const items = JSON.parse('[' + arrMatch[1].replace(/,\s*$/, '') + ']');
        return { impressions: items };
      } catch { /* 继续 */ }
    }
  }
  return null;
}
