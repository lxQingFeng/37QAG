// 睡眠与心情系统（融合版）· v0.4.1 插件
//
// ══ 这个插件是什么 ══════════════════════════════════════════════════════════
// 把原来两个互相独立、且对「睡」各有一套理解的插件合成一个：
//
//   · mood-chain（心情与生活系统）—— 自然睡眠：她自己在对话里说要睡、或作息表
//     到点掷中睡觉 → 写 self-state.json 的 sleeping。拦住的是**发送类工具**
//     （before-tool），模型照跑 —— 省的是"她半夜乱说话"，不是 token。
//   · sleep-mode（睡眠模式）—— 命令睡眠：主人 @我 + /睡觉 → orchestrator
//     suspendAll()，消息只存档不调度、**模型根本不跑**，零 token。
//
// ══ 为什么必须融合（而不是两个插件并存）════════════════════════════════════
// 1. **`message.inbound-gate` 是单提供者能力**。app.js:910 取的是
//    `getCapabilityProviders('message.inbound-gate')[0]?.fn` —— **只有第一个**。
//    两个插件都提供这个能力名时，另一个的闸门**永远不会被调用**（审计也会报
//    "能力名冲突"，见 plugin-development §11）。所以想同时拥有两条闸门，
//    只能是一个插件、一个 provider 函数，在里面合并两套判定。
//
// 2. **「谁在睡」必须只有一个真相源**。原来两套状态各自为政：
//      · mood-chain 的 sleeping 写在 self-state.json（跨群、跨重启）；
//      · sleep-mode 的 sleeping 是**模块内存态**（重启即解除）。
//    两者会打架：命令睡眠期间 mood-chain 仍会在 before-context 里判出
//    「她在睡」并缓存闸门，/起床 之后 resumeAll 补处理的消息**又被 before-tool
//    拦一次**；反过来她自然睡着时主人发 /睡觉，会得到一个"我已经在睡了"的
//    重复状态。融合后：**命令睡眠是外层（更强），自然睡眠是内层**，
//    两级共用一个查询函数 `currentSleep()`，任何决定都先问它。
//
// 3. **起床必须走同一条路**。原来 /起床 只做 resumeAll，**不改 self-state** ——
//    如果她同时是自然 sleeping，补处理的消息会被 before-tool 拦掉，表现成
//    "我叫她起床了，她还是不说话"。融合后 /起床 与主人的口令、以及
//    引擎的 markWoken 共用 `wakeUp()` 一个出口：改状态 + 清闸门缓存 + 清命令睡眠。
//
// ══ 两级拦截怎么选（核心设计）══════════════════════════════════════════════
//
//   命令睡眠（sleepCommand / /睡觉）  →  入站闸门 blocked → **模型不跑**（零 token）
//   自然睡眠（她自己说要睡/作息表）  →  睡眠闸 before-tool → 模型跑了但发不出去
//
//   为什么命令睡眠不也去写 self-state？—— 因为语义不同：
//     · 命令睡眠是**主人对机器人下的开关**（"你先别说话"），跟"她困了"无关，
//       写进 self-state 会让她之后按"刚睡醒"演，还会被作息表/疲劳逻辑读到；
//     · 自然睡眠是**她自己的状态**，要跨重启、要影响演出。
//   两者独立存储，但**查询时统一**（命令睡眠优先），避免任何一方被绕过。
//
// ══ 从 mood-chain 完整继承的东西 ═══════════════════════════════════════════
//   情绪五维 / 疲劳五段 / 愤怒三通道 / 吃醋 / 抑郁 / 满足、作息表、恢复池、
//   洗澡、活动时钟（ACTIVITY-CLOCK）、出门（OUTDOOR）、主人起床口令、
//   提示词注入、三个手调工具。
//   —— 全部原样保留，逻辑一行没改（见下方「与上游的关系」）。
//   ⚠️ 唯一被**删掉**的是 mood.snapshot 能力与 13 个 live 面板字段：
//      那个机制在 v0.4.1 已被核心整体移除，留着就是孤儿能力（见 providers 上方注释）。
//
// ══ 与上游（C2 的「心情系统插件树 v4.0」）的关系 ════════════════════════════
// 上游自述：数值核心在**宿主内核 src/** 里（每轮对话被编排器调用），
// plugins/mood-chain/ 只是管理面板 → 移植需要动 app.js/orchestrator.js/prompt.js/
// sender.js/config.js 五处接线。本插件沿用 v0.4 的 hooks 等价替换，**没有改一行核心**。
//
//   上游接线                              →  本插件
//   ─────────────────────────────────────────────────────────────────
//   orchestrator.observeTrigger()          →  hooks['before-context']
//   prompt.js 里 13 个注入块                →  hooks['before-llm-messages']
//   sender.js 出口观察她自己的话            →  hooks['after-tool']
//   orchestrator.wake 入口的 sleepGate      →  hooks['before-context'] 记录 +
//                                              hooks['before-tool'] 拦截
//   后台衰减钟 / 作息表推进                 →  activate() 的定时器
//   panel.html 15 格面板                    →  plugin.json 的 configSchema +
//                                              本文件注册的 3 个工具
//   src/config.js 的 DATA_DIR               →  lib/config.js 转发核心导出
//
// ══ 已按需求移除的模块（2026-09-22，沿用 mood-chain）════════════════════════
// 情爱 / 性欲 / 色色兴奋 / 想要 / 姊妹亲密，连同**依赖它们供数**的
// 贤者时间（refractory）/ 自慰心声（solo、soloVoice）/ 哥哥健康（ownerHealth）。
// 移除方式：不改引擎代码，全部走引擎自己的开关（engineCfg 里 enabled:false）。
//
// ══ 主人起床口令 ════════════════════════════════════════════════════════════
// 睡眠闸是"睡着就不许发言"；但主人半夜叫她起床时，若要等她自然醒或先喊对名字
// 就不像命令了。于是给主人一条**口令硬通道**：主人在消息里带上配置的口令词 → 立刻起床。
//   · 引擎的 isWakeCall：喊醒词/接触词 + **必须被称呼**（谁喊都行）→ 只放行这一轮，
//     **不改状态**。语义是"睡着了被吵到，迷糊回一句"。
//   · 本口令：**只认主人**、不必点名她 → 真的把状态改成 awake 并留 wakeAt，
//     于是接下来按"刚被叫醒、迷迷糊糊"演 30 分钟（注入块引擎自带）。
// 融合新增：口令命中时**同时解除命令睡眠**（否则状态醒了、闸门还拦着，
// 主人喊了没反应 —— 这正是原来两个插件并存时最容易踩的坑）。
//
// ‼️ 遗留缺口（沿用 mood-chain 的记录，未改）：引擎导出了 markWoken()（真正把
//    "被喊醒"落成 awake + wakeAt），但通用喊醒路径从没调用过。要不要接上
//    （会让夜里被任何人喊一声就真醒，token 消耗上升）是另一个决定，故未擅自改动。
//    本插件在 debugGates() / mood_status 里暴露了内部状态，便于排查。
//
// ══ 已知的功能降级（诚实声明）═══════════════════════════════════════════════
// 1. **SOLO-VOICE 心声直发私聊**：上游绕过 LLM 直接发消息。v0.4 的插件在
//    activate/hook 里**拿不到 sender**（hook 只有 5 秒超时且明令禁止发消息），
//    故降级为「心声状态照常推进 + 由她自己在对话里说出来」。
//    ⚠️ 该功能已于 2026-09-22 随自慰模块一并移除，此条仅作历史记录。
// 2. **作息表/恢复池的推进时机**：上游在每轮对话里推进，这里改到后台心跳。
//    数值语义一致，但"正好在她说话那一刻切状态"的精度会略降。
// 3. **命令睡眠是内存态**：与上游 sleep-mode 一致，重启机器人自动解除
//    （安全默认——防止"忘了关导致机器人永远沉默"）。
// 4. **面板**：v0.4 的 injectApi/panel.html 机制本来就不存在；曾经退而求其次用
//    configSchema 的 `type:'live'` 只读字段（核心 liveValuesOf 按能力取数），
//    但 **v0.4.1 把这个机制也移除了** —— 现在数值只能通过 mood_status 工具查。
//
// 设计红线（沿用上游第 5 节）：**永远不做硬拦截**（除了睡眠这两道既定的闸）、
// 状态文件坏了/缺了就全当平静（绝不锁死）、所有失败都静默吞掉不影响正常回复。

import * as M from './lib/mood-chain.js';
import * as S from './lib/self-state.js';
import { DATA_DIR, ROOT } from './lib/config.js';
import nodeFs from 'node:fs';
import nodePath from 'node:path';
// 核心文件日志器。相对路径与 lib/config.js 取 DATA_DIR 是同一套路
// （plugins/<id>/index.js → ../../src/）。取到的是同一个单例。
import { logger as coreLogger } from '../../src/logger.js';

let api = null;
let timer = null;
let ticking = false;

/**
 * 把框架给的 `api.log / api.warn` 接到**核心文件日志器**上。
 *
 * ⚠️ 为什么必须接：plugin-loader.js:116-118 里，插件的日志是
 *      `log: (...args) => console.log('[skill:'+skillId+']', ...args)`
 *    —— **不走文件日志器**。而 logger.js 只做单向镜像（落盘 + console），
 *    console 的输出**不会**被反收进文件。Electron GUI 下 stdout 没人接，
 *    于是插件的日志等于丢了（实测：日志文件里零条 `[skill:sleep-mood]`）。
 *
 *    这对本插件是硬伤：入站被拦 = **不建会话 = GUI 会话列表里没有任何痕迹**，
 *    "她怎么不回消息"完全看不出来。走 coreLogger 还额外白赚两件事：
 *      · 进 logger 的内存环形缓冲 → GUI「日志」页签实时可见（SSE 推送）；
 *      · 与其他模块的日志同格式落盘，排查时一条时间线。
 *
 * 安全性：框架的 api 方法**全是箭头函数**（不依赖 `this`），所以浅拷贝后覆盖
 * log/warn 不会丢绑定。落盘失败时退回原来的 console 实现，不影响功能。
 */
function wrapApiLogging(a) {
  if (!a || typeof a !== 'object') return a;
  return {
    ...a,
    log: (...args) => {
      try { coreLogger.info('sleep-mood', ...args); } catch { try { a.log?.(...args); } catch { /* 忽略 */ } }
    },
    warn: (...args) => {
      try { coreLogger.warn('sleep-mood', ...args); } catch { try { a.warn?.(...args); } catch { /* 忽略 */ } }
    }
  };
}

/** 本轮各会话的睡眠闸判定结果（before-context 记，before-tool 用）。 */
const gateByChat = new Map();
/** 诊断：最近一次 before-context 的输入与决策（只给 debugGates 看）。 */
let lastDiag = null;
/** 她自己的发言时间戳（疲劳五段速率要用），只留最近 200 条。 */
let selfMsgTs = [];

/**
 * 【融合核心 ①】命令睡眠（原 sleep-mode 的模块级内存态）。
 *
 * 这是**外层闸**：开启后 orchestrator.suspendAll()，消息只存档不调度，
 * 模型根本不跑 —— 零 token。与 self-state.json 里的 sleeping **不是一回事**：
 *   · 命令睡眠 = 主人对机器人下的开关（"你先别说话"）；
 *   · 自然睡眠 = 她自己困了（写盘、跨重启、影响演出）。
 *
 * 存内存不存盘是**有意的**：防止"忘了关导致机器人永远沉默"（重启即自愈）。
 */
let commandSleep = false;

const on = (v) => v !== false;

function settings() {
  try { return (api && typeof api.config === 'function' ? api.config() : null) || {}; } catch { return {}; }
}

/**
 * 【融合核心 ②】统一睡眠查询 —— 全插件唯一的"她现在算不算睡着"出口。
 *
 * 任何拦截判定都必须先问它，不允许各自去读 self-state.json 或 commandSleep，
 * 否则两套状态又会长出各自的判断分支（这正是融合要消灭的东西）。
 *
 * @returns {{sleeping:boolean, kind:'command'|'natural'|'none', status:string, what:string, reason:string}}
 */
function currentSleep(now = Date.now()) {
  if (commandSleep) {
    return { sleeping: true, kind: 'command', status: 'sleeping', what: '', reason: '命令睡眠（/睡觉）' };
  }
  let st = { status: 'awake', what: '' };
  try { st = S.readSelfState(now) || st; } catch { /* 状态坏了当醒着 */ }
  const status = String(st.status || 'awake');
  if (status === 'sleeping') {
    return { sleeping: true, kind: 'natural', status, what: String(st.what || ''), reason: '自然睡眠（她自己困了）' };
  }
  return { sleeping: false, kind: 'none', status, what: String(st.what || ''), reason: '' };
}

/**
 * 引擎期望的 cfg 形状是 `{ moodChain:{...}, selfState:{...} }`，
 * 未提供的键由引擎自己的 *_DEFAULTS 兜底 —— 所以这里只翻译插件级开关，
 * 不重复声明引擎那几百个默认值（重复声明反而会在上游改默认值时失同步）。
 *
 * ⚠️ REMOVED 里的模块一律显式 `enabled:false` 钉死。理由：引擎里绝大多数
 * Block / step 都有 `if (c.enabled === false) return`，但**不是全部**都有
 * （sisterFightDelta / sisterHelpGain / sisterMicroGain 原来就漏了守卫，已补）。
 * 显式关掉 + 补齐守卫 = 双保险，任一环漏了也不会偷偷写盘。
 */
const REMOVED_MODULES = ['love', 'lust', 'arousal', 'want', 'sister', 'solo', 'soloVoice', 'ownerHealth'];

function engineCfg() {
  const s = settings();
  if (!on(s.enabled)) return { moodChain: { enabled: false }, selfState: { enabled: false } };
  const moodChain = { enabled: true };
  for (const mod of REMOVED_MODULES) moodChain[mod] = { enabled: false };
  return {
    moodChain,
    selfState: { enabled: on(s.selfState) }
  };
}

/** 主人 QQ：优先用插件设置，其次软依赖 owner-identity 能力。取不到返回 ''。 */
function resolveOwnerQq() {
  const explicit = String(settings().ownerQq || '').trim();
  if (/^\d{5,12}$/.test(explicit)) return explicit;
  try {
    const r = api.capability('message.owner-check', {});
    if (r && Array.isArray(r.owners) && r.owners.length) return String(r.owners[0]);
    if (r && r.ownerId) return String(r.ownerId);
  } catch { /* 软依赖，没有就算了 */ }
  return '';
}

/** 口令串 → 词数组（空格 / 逗号 / 顿号 / 分号 / 换行分隔，与引擎其它词表同款写法）。 */
export function parseWakeWords(raw) {
  return String(raw || '')
    .split(/[\s,，、;；\n\r]+/)
    .map((w) => w.trim())
    .filter(Boolean);
}

/**
 * 指令关键词解析（COMMAND-KEYWORDS，2026-09-22 主人要求）。
 *
 * 原来是**单条精确指令**（`text.includes('/睡觉')`）—— 必须一字不差、还得带斜杠，
 * 手机上手打很不稳（漏个斜杠、多个空格就废）。改成**关键词组**：
 *   · 多个关键词用 空格/逗号/顿号/分号/换行 分隔（与 parseWakeWords 同款写法）；
 *   · 命中**任意一个**即触发 → 越短越容易命中（主人原话："比如提取 睡觉二字"）；
 *   · 兼容旧配置：解析结果为空时回退到老的 sleepCommand/wakeCommand 单条，
 *     所以老配置文件不改也能照跑（也能识别斜杠写法，因为 `睡觉` 是 `/睡觉` 的子串）。
 *
 * ⚠️ 与普通唤醒词（wakeWords）的区别，别混：
 *   · **本关键词 = 真的切换命令睡眠状态**（suspendAll/resumeAll），是"开关"；
 *   · wakeWords = 主人专项的"叫她起床"口令，改的是 self-state（自然睡眠）。
 *   两者都要求群内 **@机器人**（本关键词额外要求），避免路人随口两个字把机器人关掉。
 *
 * ⚠️ 误触发的代价不对称：关键词越短越容易中。
 *   「睡觉」在"我去睡觉了""你该睡觉了"里都会命中 ——
 *   所以 `sleepKeywords` 命中要求 **@机器人**；若还嫌敏感，就把它配长一点
 *   （如「睡觉吧 小柚睡觉」），或直接用 `lockWakeToOwner` 限定唤醒只能主人触发。
 */
export function parseKeywords(raw) {
  return parseWakeWords(raw);
}

/**
 * 关键词是否命中本批消息。
 * @param {string} text 消息文本
 * @param {string[]} words 关键词组（空数组 = 不命中）
 * @returns {string} 命中的那个词（'' = 未命中）—— 返回词本身便于日志写明"因何触发"
 */
export function keywordHit(text, words) {
  const t = String(text || '');
  if (!t || !Array.isArray(words) || !words.length) return '';
  for (const w of words) {
    if (w && t.includes(w)) return w;
  }
  return '';
}

/** 取关键词组：优先用户配置，配置为空则回退到旧的单条指令（兼容老配置）。 */
function keywordsOf(rawList, legacyCmd, fallback) {
  const parsed = parseKeywords(rawList);
  if (parsed.length) return parsed;
  const legacy = String(legacyCmd || '').trim();
  if (legacy) return [legacy];
  return fallback ? [fallback] : [];
}

/**
 * 主人起床口令匹配。
 *
 * 为什么不直接用引擎现成的 `isWakeCall`：
 *   · `isWakeCall` 认的是「喊醒词/接触词 **+ 被称呼**」—— 谁喊都行，但必须点名她。
 *     主人这条通道要的是**主人特权**：说了口令就算，不必 @ 她、不必带名字。
 *   · `isWakeCall` 只买到「这一轮不被拦住」，**并不改变状态**，所以喊完只是回一句，
 *     下一轮照样被拦。口令命中要的是**真的起床**：状态改 awake 并留下 wakeAt，
 *     于是接下来 30 分钟按"刚被叫醒、迷迷糊糊"演（这套注入引擎里本来就有）。
 *
 * 只认主人：群里别人喊口令不算，免得被人拿去当"叫醒开关"。
 *
 * @param {Array} entries 触发批消息
 * @param {string} ownerQq 主人 QQ（空 = 无法判定主人 → 直接不生效）
 * @param {string[]} words 口令词
 * @returns {{hit:string, text:string}|null} 命中的口令与那条原文
 */
export function ownerWakeHit(entries, ownerQq, words) {
  const owner = String(ownerQq || '').trim();
  if (!owner || !Array.isArray(words) || !words.length) return null;
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || e.self) continue;                        // 她自己的话不算
    if (String(e.senderId || '') !== owner) continue;  // 只认主人
    const text = String(e.text ?? '');
    if (!text) continue;
    const hit = words.find((w) => text.includes(w));
    if (hit) return { hit, text };
  }
  return null;
}

/**
 * 判定本条消息是否 @了机器人（与核心指令禁言同口径）：
 * 文本里带 @昵称 / @botName，或带 CQ:at qq=自己 的段。
 */
function atBot(text, { botName = '', selfNickname = '', selfId = '' } = {}) {
  const src = String(text ?? '');
  if (!src) return false;
  if (selfNickname && src.includes(`@${selfNickname}`)) return true;
  if (botName && src.includes(`@${botName}`)) return true;
  if (selfId) {
    const esc = String(selfId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\[CQ:at(?:,[^\\]]*?)?qq=${esc}[^\\]]*\\]`);
    if (re.test(src)) return true;
  }
  return false;
}

/**
 * 【融合核心 ③】统一起床出口 —— 口令 / /起床 / 工具 全走这里。
 *
 * 为什么必须收口：原来两条起床路径各做各的（口令只改 self-state、
 * /起床 只做 resumeAll），于是"状态醒了但闸门还拦着"或"闸门开了但状态还在睡"
 * 必然出现其中一种。这里把三件事绑成一次原子操作：
 *   ① 清命令睡眠（外层闸）
 *   ② 把自然状态写 awake + wakeAt（内层闸 + 迷糊演出）
 *   ③ 清空**所有**已算好的闸门缓存
 *
 * @param {{byCommand?:boolean, reason?:string}} opts
 * @returns {{woke:boolean, wasCommand:boolean, wasNatural:boolean}}
 */
function wakeUp({ reason = '' } = {}) {
  const before = currentSleep();
  const wasCommand = commandSleep;
  let wasNatural = false;

  // ① 外层：命令睡眠解除
  commandSleep = false;

  // ② 内层：自然睡眠 → awake（保留原 at，清 what，写 wakeAt）
  try {
    const st = S.readSelfState();
    if (st.status === 'sleeping') {
      wasNatural = true;
      // ⚠️ 三个字段各有原因，别随手改：
      //   · at 保留**她原来那个**（与引擎自己的 markWoken 写法一致）：awake 下
      //     at 不参与过期计算，但"这个状态从何时开始"的语义要留住；
      //   · what 必须**清空**：睡前写进去的是"到点该睡了"这类 **note**，不是她
      //     在干的事。留着有两处害处 —— 唤醒演出会念成「（睡前在：到点该睡了）」，
      //     而且 awakeGraceMs 那条"你刚说过「X」"的提醒会把 note 当成她说的话；
      //   · wakeAt 必须写：演出靠它判"刚被叫醒"，30 分钟内按迷糊口吻说话。
      S.writeSelfState({ status: 'awake', what: '', at: st.at, wakeAt: Date.now() });
      // FATIGUE-STUCK-FIX：醒来时立刻按睡眠时长结算一次恢复，并清掉 sleptAt。
      // 引擎的 markFatigueSleep(false) 就是干这个的（内部调 stepFatigue{sleeping:true}）。
      // 不结算的话：她整夜睡着期间心跳的 sleeping 分支本会持续恢复，
      // 但"醒来"这一刻的状态切换就没人收尾，sleptAt 会一直留着旧值 ——
      // 下一次她再睡时又从头算，等于白睡。
      try { M.markFatigueSleep(false, Date.now()); } catch { /* 结算失败不致命 */ }
    }
  } catch { /* 状态写失败不致命：闸门仍会被清掉，她至少能说话 */ }

  // ③ ⚠️ 必须清掉**所有**已算好的闸门缓存。
  //    原因：before-tool 判的是「**任意**会话的闸门」（for...of gateByChat.values()），
  //    不是当前会话 —— 于是"A 群那轮把她判成睡着"留下的 {block:true}，
  //    会在主人于 B 私聊喊起床后**继续拦掉这一轮发送**：状态都改清醒了却发不出话，
  //    表现成"口令没生效"。这些闸门的前提（她在睡）此刻已经不成立，清掉即可，
  //    每轮 before-context 都会重新算。
  gateByChat.clear();

  return { woke: wasCommand || wasNatural, wasCommand, wasNatural, before, reason };
}

/** 上游 observeTrigger 要的是「取最近消息」的函数，不是数组。 */
function recentFn(ctx) {
  const store = ctx && ctx.store;
  if (!store || typeof store.recent !== 'function') return null;
  return (chatKey, opts) => store.recent(chatKey, opts);
}

function selfNamesOf(ctx) {
  return [ctx && ctx.selfNickname, ctx && ctx.botName]
    .map((v) => String(v || '').trim())
    .filter(Boolean);
}

/** 安全调用引擎的注入块生成器；返回非空字符串才收。 */
function block(out, fn, ...args) {
  try {
    const t = fn(...args);
    if (t && String(t).trim()) out.push(String(t).trim());
  } catch { /* 单个注入块失败不影响其它块 */ }
}

// ══════════════════════════════════════════════════════════════════════════
// 生命周期
// ══════════════════════════════════════════════════════════════════════════


function dashboardFile() {
  return nodePath.join(ROOT, 'ui', 'mood-dashboard.json');
}

function seedMoodIfEmpty(now = Date.now()) {
  try {
    const st = M.readMoodChain(now) || {};
    const moods = st.moods || {};
    const hasMood = Object.keys(moods).some((key) => {
      const raw = moods[key];
      const value = raw && typeof raw === 'object' ? (raw.level ?? raw.value) : raw;
      return Number(value) > 0;
    });
    if (hasMood || st.moodSeededAt) return false;
    const hour = new Date(now).getHours();
    const base = { happy: 50, excited: 30, angry: 0, jealous: 0, sad: 0 };
    if (hour >= 6 && hour < 12) {
      base.happy = 58; base.excited = 38;
    } else if (hour >= 12 && hour < 18) {
      base.happy = 55; base.excited = 42;
    } else if (hour >= 18 && hour < 23) {
      base.happy = 50; base.excited = 30;
    } else {
      base.happy = 42; base.excited = 18; base.sad = 8;
    }
    st.moods = moods;
    for (const [key, value] of Object.entries(base)) {
      if (!st.moods[key]) st.moods[key] = { level: value, why: '启用心情系统时自动设定', at: now };
    }
    st.moodSeededAt = now;
    return M.writeMoodChain(st);
  } catch {
    return false;
  }
}

export function dashboardSnapshot() {
  const now = Date.now();
  const cfg = engineCfg();
  const snap = M.moodSnapshot(cfg, now);
  let self = { status: 'awake', what: '', at: 0 };
  try { self = S.readSelfState(now) || self; } catch { /* 忽略 */ }
  const sleep = currentSleep(now);
  const clamp = (value) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : 0;
  };
  const moods = snap.moods || {};
  const happy = clamp(moods.happy);
  const excited = clamp(moods.excited);
  const angry = clamp(moods.angry);
  const jealous = clamp(moods.jealous);
  const sad = clamp(moods.sad);
  const fatigue = clamp(snap.fatigue);
  const spunk = clamp(snap.spunk);
  const depress = clamp(snap.depress);
  const satisfaction = clamp(snap.satisfaction);
  const derived = {
    energy: 100 - fatigue,
    stress: Math.round((angry + sad + fatigue) / 3),
    stability: 100 - Math.round((angry + jealous + sad + depress) / 4),
    focus: 100 - Math.round((fatigue + spunk) / 2),
    health: 100 - Math.round((fatigue + depress + spunk) / 3),
    comfort: Math.round((happy + satisfaction + (100 - depress)) / 3),
    loneliness: Math.round((sad + (100 - satisfaction)) / 2),
    security: 100 - Math.round((jealous + sad + depress) / 3),
    social: Math.round((happy + excited + satisfaction) / 3)
  };
  const item = (key, label, icon, value, tone, derivedItem) => ({
    key, label, icon, value: clamp(value), tone: tone || 'neutral', derived: !!derivedItem
  });
  const items = [
    item('happy', '心情值', '💗', happy, 'good'),
    item('energy', '精力值', '⚡', derived.energy, 'good', true),
    item('fatigue', '疲劳度', '😴', fatigue, 'bad'),
    item('stress', '压力值', '😰', derived.stress, 'bad', true),
    item('stability', '情绪稳定', '🧘', derived.stability, 'good', true),
    item('focus', '专注力', '🎯', derived.focus, 'good', true),
    item('satisfaction', '满足感', '🫶', satisfaction, 'good'),
    item('depress', '抑郁度', '🌧️', depress, 'bad'),
    item('excited', '兴奋度', '✨', excited, 'good'),
    item('angry', '生气值', '😤', angry, 'bad'),
    item('jealous', '吃醋值', '💔', jealous, 'bad'),
    item('sad', '难过值', '😢', sad, 'bad'),
    item('spunk', '吵架速度', '🔥', spunk, 'bad'),
    item('health', '健康值', '❤️', derived.health, 'good', true),
    item('comfort', '舒适度', '🛋️', derived.comfort, 'good', true),
    item('loneliness', '孤独感', '🫂', derived.loneliness, 'bad', true),
    item('security', '安全感', '🛡️', derived.security, 'good', true),
    item('social', '社交需求', '💬', derived.social, 'neutral', true)
  ];
  return {
    ok: true,
    at: now,
    enabled: !!api && on(settings().enabled),
    commandSleep,
    sleep,
    self: { status: String(self.status || 'awake'), what: String(self.what || ''), at: Number(self.at) || 0 },
    dominant: snap.dominant
      ? { emotion: snap.dominant.emotion, word: snap.dominant.word, level: clamp(snap.dominant.level) }
      : { emotion: 'calm', word: '平静', level: 0 },
    moods: { happy, excited, angry, jealous, sad },
    meters: { fatigue, spunk, depress, satisfaction },
    items
  };
}

function publishDashboard(extra = {}) {
  try {
    const payload = { ...dashboardSnapshot(), ...extra, publishedAt: Date.now() };
    const file = dashboardFile();
    const tmp = file + '.tmp';
    nodeFs.mkdirSync(nodePath.dirname(file), { recursive: true });
    nodeFs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8');
    nodeFs.renameSync(tmp, file);
  } catch (e) {
    try { api?.warn?.('心情面板快照写入失败', e?.message ?? e); } catch { /* 忽略 */ }
  }
}

export function setup(a) {
  // 接管日志：让本插件的 log/warn 真正落盘并进 GUI 日志页（见 wrapApiLogging）
  api = wrapApiLogging(a);
  try {
    M.migrateStateOnce();
  } catch (e) {
    api.warn('状态迁移失败（不影响使用）', e?.message ?? e);
  }
  registerMoodTools(a);
}

/** 同步返回：异步探测会在可用性链上被当成 truthy 而误报"生效中"。 */
export function available() {
  if (!on(settings().enabled)) return { ok: false, reason: '插件已关闭' };
  return { ok: true };
}

/** 起后台心跳。热重载会先 deactivate 再 setup，所以这里必须可重复起停。 */
export function activate() {
  if (timer) return;
  try { seedMoodIfEmpty(); } catch { /* 初始化失败不影响主流程 */ }
  const s = settings();
  if (!on(s.enabled)) return;
  const everySec = Math.min(600, Math.max(15, Number(s.tickSeconds) || 60));
  timer = setInterval(() => { tick().catch(() => {}); }, everySec * 1000);
  timer.unref?.();
  api.log(`睡眠与心情系统（融合版）已启用：心跳 ${everySec}s，数据根 ${DATA_DIR}`);
  publishDashboard();
  // 起床口令配了、但主人 QQ 认不出来 → 口令永远不会命中。这种"静默不生效"
  // 最难排查（人会以为是口令写错了），所以启动时就明确喊一声。
  if (parseWakeWords(s.wakeWords).length && !resolveOwnerQq()) {
    api.warn('配了「主人起床口令」但没能确定主人 QQ —— 口令不会生效。请在设置里填「主人 QQ 号」，'
      + '或安装 owner-identity 插件。');
  }
}

/**
 * 停心跳并**放弃命令睡眠**。
 *
 * ⚠️ 热重载/卸载时必须把 suspendAll 的后果交代清楚：命令睡眠是内存态，
 * 插件卸载后没有任何代码会去 resumeAll，机器人会**永久沉默**。
 * 所以这里主动恢复调度（若还挂着）。这是融合版特有的收尾 —— 原 sleep-mode
 * 是模块级 `sleeping` 变量，卸载时随模块一起消失且无人恢复调度。
 */
export function deactivate() {
  try { publishDashboard({ enabled: false }); } catch { /* 忽略 */ }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (commandSleep) {
    try { api?.warn?.('插件被停用/重载，但命令睡眠还开着 —— 已自动恢复调度，避免机器人永久沉默'); } catch { /* 忽略 */ }
    try { resumeOrchestrator(); } catch { /* 忽略 */ }
  }
  commandSleep = false;
  gateByChat.clear();
}

export function dispose() {
  deactivate();
}

/**
 * 诊断出口：插件内部状态快照。
 *
 * 存在的理由：插件加载器用 `import(url + '?t=' + Date.now())` 动态导入（见
 * plugin-loader.js:301），**每次热重载都是一个全新的模块实例**。所以测试脚本
 * 里 `import()` 到的是另一个实例、拿不到这里的内部状态；工具也只是同一实例内的视图。
 * 这个函数让"到底拦没拦、为什么没拦"可以被外部直接问出来。
 */
export function debugGates() {
  const sleep = currentSleep();
  return {
    apiSet: !!api,
    settings: settings(),
    sleep: { ...sleep, commandSleep, cachedGates: gateByChat.size },
    gates: [...gateByChat.entries()].map(([chatKey, g]) => ({ chatKey, ...(g || {}) })),
    lastContext: lastDiag
  };
}

/**
 * 后台心跳。做三件事：
 *   ① 疲劳 —— 按五段速率推进（睡着才恢复）
 *   ② 愤怒速度线 —— 非战斗轮让它自然衰减
 *   ③ 全局自身状态机 —— 作息表推进 / 恢复池 / 户外自动回家
 * 情绪五维的衰减不在这里：引擎是**读时惰性结算**的
 * （decayAll 在 currentMood/stepMood/各 Block 内部跑），多算一次反而会重复扣。
 */
async function tick() {
  if (ticking) return;
  ticking = true;
  try {
    const cfg = engineCfg();
    if (!on(settings().enabled)) return;
    const now = Date.now();

    // 【融合】她现在是不是睡着（疲劳恢复的前提）—— 统一走 currentSleep()。
    // 原来这里单独读 S.readSelfState，命令睡眠期间 fatigue 不会恢复
    //（因为命令睡眠不写 self-state）。融合后命令睡眠也算"睡着"，
    // 于是被主人关掉的这段时间她的疲劳照常恢复，语义更合理。
    const sleep = currentSleep(now);
    const sleeping = sleep.sleeping;

    try { M.stepFatigue({ selfMsgTs, sleeping, cfg, now }); } catch { /* 疲劳推进失败无所谓 */ }
    try { M.stepSpunk({ fighting: false, hisGapMs: 0, cfg, now }); } catch { /* 同上 */ }

    // 【融合】命令睡眠期间不推进作息表 —— 否则她在"被关掉"的这段时间里
    // 自己掷中睡觉/做事，/起床 之后表现成"刚醒却又在忙着洗澡"，状态错乱。
    if (on(settings().selfState) && !commandSleep) {
      try {
        // 作息表：到点且掷中才换事项（引擎内部自带概率与冷却）。
        // ⚠️ 返回形状是 { pick, note, sleep? }，pick==='__sleep__' 表示"该睡了" ——
        //    不能整个展开写进状态，否则状态文件里会多出 pick/note 这些野字段。
        const pick = S.pickScheduled(cfg, now);
        if (pick && pick.sleep) {
          // 主人刚喊过起床 → 迷糊窗（默认 30 分钟）内不许按作息表自己睡回去。
          // 为什么必须挡：writeSelfState 是**整文件覆盖**，会把作息冷却字段
          //（recovery.lastPickAt）一起抹掉，于是"刚起床"紧接着就可能被掷中睡觉 ——
          // 表现成"我叫她起床，十分钟后她又睡了"，功能等于没生效。
          // 只挡"自己睡回去"这一条；她**自己说**要去睡（stateFromSelfText）照旧尊重。
          const st = S.readSelfState(now);
          if (!S.inWakeGrace(st, cfg, now)) {
            S.writeSelfState({ status: 'sleeping', what: String(pick.note || ''), at: now });
            // FATIGUE-STUCK-FIX：记入睡时刻到 mood.json 的 fatigue.sleptAt。
            // 不记的话疲劳恢复路径 `cur.sleptAt || cur.at || now` 会退化成 sleptMs=0，
            // 疲劳只增不减、永远钉在 100（详见 lib/mood-chain.js stepFatigue 的注释）。
            try { M.markFatigueSleep(true, now); } catch { /* 记不上不影响睡觉 */ }
          } else {
            lastDiag = { ...(lastDiag || {}), sleepSuppressed: 'wakeGrace' };
          }
        } else if (pick && pick.pick) {
          S.writeSelfState({ status: 'busy', what: String(pick.pick), at: now });
        }
      } catch { /* 忽略 */ }
      try {
        // 疲劳到阈值且闲着 → 掷一次恢复行为
        const st = S.readSelfState(now);
        const pick = S.pickRecovery(cfg, Number(st?.fatigue) || 0, now);
        if (pick) S.settleRecovery(pick, cfg);
      } catch { /* 忽略 */ }
      try {
        // 出门太久没人理 → 自己回家
        const st = S.readSelfState(now);
        if (S.shouldAutoReturnHome(st, [], cfg, now)) {
          S.writeSelfState({ status: 'awake', what: '', at: now });
        }
      } catch { /* 忽略 */ }
    }
    publishDashboard();
  } catch (e) {
    try { api?.warn?.('心跳出错', e?.message ?? e); } catch { /* 连日志都失败就算了 */ }
  } finally {
    ticking = false;
  }
}

/** 拿到 orchestrator（能力 provider 里随入参传入；工具路径用缓存的最近一次）。 */
let lastOrchestrator = null;

function resumeOrchestrator() {
  try {
    return lastOrchestrator?.resumeAll?.({ limit: Math.max(1, Number(settings().resumeCount) || 20) }) ?? 0;
  } catch { return 0; }
}

/** 向触发群发一条确认消息（失败只记日志，不阻塞主流程）。 */
function confirmText(sender, chatKey, text) {
  if (!chatKey || !sender || !text) return;
  Promise.resolve()
    .then(() => sender.sendTextBatch(chatKey, [text]))
    .catch((e) => { try { api?.log?.(`确认消息发送失败：${e?.message ?? e}`); } catch { /* 忽略 */ } });
}

// ══════════════════════════════════════════════════════════════════════════
// 能力（给核心消费）
// ══════════════════════════════════════════════════════════════════════════

/**
 * 入站闸门（融合版）：把「命令睡眠」与「自然睡眠」两套判定合到一个函数里。
 *
 * 返回 { blocked } 的语义：blocked=true → 本批消息不送模型。
 *
 * 判定顺序：
 *   ① 命令睡眠中：
 *        · 命中 /起床（且鉴权通过）→ 真正起床 + resumeAll 补处理 → 放行本轮；
 *        · 命中主人起床口令 → 同上；
 *        · 否则 → blocked（除非 commandSleepHard=false 且这是"被喊醒"的消息）。
 *   ② 命令睡眠未开：
 *        · 命中 /睡觉（且 @了机器人）→ suspendAll + 标记命令睡眠 → blocked；
 *        · 她在自然睡眠且**没被喊醒** → blocked + 标记已读（SLEEP-IGNORE-FIX）；
 *        · 否则 → 放行。
 *
 * ⚠️ SLEEP-IGNORE-FIX（2026-09-22）：自然睡眠**也在这道闸拦**。
 *
 * 原设计把自然睡眠放在**内层闸**（before-tool 拦发送），理由是"让模型跑起来，
 * 才能演'被吵醒后迷糊回一句'"。但那意味着**每条消息都要先烧一遍 token**
 * 才会被拦下 —— 实测一次触发 23.3k tok / 2 次调用（模型被拦后还会换个工具
 * 再试一次，白烧两轮），而她睡 8 小时可能收到几十上百条。
 * 主人明确要求"完全底层的忽略"→ 改成入口就拦，模型**根本不跑**。
 *
 * 唤醒演出并没有丢：**喊醒词/接触词 + 被称呼**的消息仍然放行（见下面 (c)），
 * 她照样能用迷糊口吻回一句 —— 只是"普通消息"不再触发模型。
 * （喊醒词/接触词是主人 2026-09-17 明确要求保留的行为，不能砍。）
 *
 * ⚠️ SLEEP-UNREAD（2026-09-22，主人要求）：blocked 的同时**不标已读**，
 *   消息原样**保持未读**，她醒来后统一补看（详见下面 (d) 分支的注释）。
 *
 *   · 好处：睡着只是"听不到"，不是"没发生过" —— 她醒了能看到这段时间说了什么；
 *   · 代价：醒来那一刻会一次性 drainUnread 补处理积压，睡越久积压越多。
 *     所以忽略日志里会报出当前积压条数（`当前积压 N 条`），
 *     积压过多时可以考虑用命令睡眠（/睡觉 + /起床，带 resumeCount 上限）代替自然睡眠。
 *   · 注：一度改成 blocked 时就 markAllRead（防积压），后来又按主人要求改回保持未读。
 *
 * ‼️ 这是本插件**唯一**的能力名（单提供者）。原 mood-chain 还声明过
 *    `mood.snapshot`（给控制台"心情面板"的 live 字段供数），但那个机制在
 *    v0.4.1 里已经被整体移除了（manager.liveValuesOf 不存在、UI 无渲染器、
 *    routes.js 无引用）→ 声明它只会被审计判为"孤儿能力"。
 *    所以融合版不再声明该能力，数值改由 mood_status 工具暴露（见下）。
 */
export const providers = {
  'message.inbound-gate': ({
    kind, chatKey, text = '', senderId = '', store, orchestrator, sender, onebot, botName = ''
  } = {}) => {
    const c = settings();
    const resumeCount = Math.max(1, Number(c.resumeCount) || 20);
    const confirm = c.confirm !== false;
    const hard = c.commandSleepHard !== false;
    const selfNickname = onebot?.selfNickname || '';
    const selfId = onebot?.selfId || '';

    // ── 关键词组（COMMAND-KEYWORDS）：多个关键词任一命中即触发 ──
    //    旧配置（单条 sleepCommand/wakeCommand）由 keywordsOf 自动回退兼容。
    const sleepWords = keywordsOf(c.sleepKeywords, c.sleepCommand, '/睡觉');
    const wakeWords = keywordsOf(c.wakeKeywords, c.wakeCommand, '/起床');

    // 记住 orchestrator：工具（mood_reset 等）路径拿不到它，
    // 而唤醒之后要用它 resumeAll。能力 provider 每次入站都会被调用，足够新。
    if (orchestrator) lastOrchestrator = orchestrator;

    const atMe = atBot(text, { botName, selfNickname, selfId });
    const ownerQq = resolveOwnerQq();
    const isOwner = !!ownerQq && String(senderId) === ownerQq;

    // ── ① 命令睡眠中 ───────────────────────────────────────────────────
    if (commandSleep) {
      // 唤醒关键词：群里 @我 + 命中任一唤醒词（可选仅主人）
      const wakeHit = kind === 'group' && atMe ? keywordHit(text, wakeWords) : '';
      const ownerLocked = c.lockWakeToOwner === true;
      if (wakeHit && (!ownerLocked || isOwner)) {
        const r = wakeUp({ reason: '命令唤醒关键词' });
        let touched = 0;
        try { touched = orchestrator?.resumeAll?.({ limit: resumeCount }) ?? 0; } catch (e) {
          try { api?.log?.(`唤醒失败：${e?.message ?? e}`); } catch { /* 忽略 */ }
        }
        try {
          api?.log?.(`命令睡眠解除（关键词「${wakeHit}」）：${touched} 个会话安排补处理（每群最新 ${resumeCount} 条）`);
        } catch { /* 忽略 */ }
        if (confirm) {
          confirmText(sender, chatKey, touched > 0
            ? `好的，我醒啦～正在补看 ${touched} 个群的最近消息。`
            : '好的，我醒啦～（刚才好像没人找我）');
        }
        return { blocked: false };   // 本轮唤醒指令本身放行（让她能立刻应一声）
      }

      // 主人起床口令：优先于一切（**融合新增** —— 原来两个插件并存时，
      // 口令能改 self-state 却解不开 suspendAll，主人喊了没反应）。
      if (kind === 'group' || kind === 'private') {
        const w = ownerWakeHit(
          [{ senderId, text, self: false }],
          ownerQq,
          parseWakeWords(c.wakeWords)
        );
        if (w) {
          wakeUp({ reason: '主人起床口令' });
          let touched = 0;
          try { touched = orchestrator?.resumeAll?.({ limit: resumeCount }) ?? 0; } catch { /* 忽略 */ }
          try { api?.log?.(`命令睡眠期间主人口令命中「${w.hit}」→ 已起床，补处理 ${touched} 个会话`); } catch { /* 忽略 */ }
          return { blocked: false };
        }
      }

      // 被喊醒式消息：默认仍然拦（省 token 是命令睡眠的全部意义）。
      // commandSleepHard=false 时放行，让模型按"被吵到"演一句。
      if (!hard && kind === 'group' && atMe) {
        // 判定交给引擎的 isWakeCall（要求被称呼 + 喊醒词/接触词）
        try {
          const wake = S.isWakeCall([{ senderId, text, isAtMe: true }], {
            selfNickname, botName, selfId, isPrivate: kind === 'private'
          });
          if (wake) {
            // 放行但**不解除**命令睡眠：只让她迷糊应一句，下一条还是静默。
            return { blocked: false };
          }
        } catch { /* 判定失败按拦住处理 */ }
      }

      return { blocked: true };
    }

    // ── ② 命令睡眠未开：检测开启关键词 ──────────────────────────────────
    // 必须 @机器人，防止陌生人随手两个字把机器人关掉（关键词越短越需要这道保险）。
    const sleepHit = kind === 'group' && atMe ? keywordHit(text, sleepWords) : '';
    if (sleepHit) {
      let ok = false;
      try { ok = orchestrator?.suspendAll?.() === true; } catch (e) {
        try { api?.log?.(`进入睡眠失败：${e?.message ?? e}`); } catch { /* 忽略 */ }
      }
      commandSleep = true;
      // 进入命令睡眠时清掉自然睡眠的闸门缓存：否则命令睡眠解除后，
      // 那些"她在睡"的旧判定会继续拦发送（陈旧缓存的经典坑）。
      gateByChat.clear();
      try {
        api?.log?.(`进入命令睡眠（关键词「${sleepHit}」）：消息照常存档但不处理；`
          + `@我并发送「${wakeWords[0] || '/起床'}」即可唤醒`);
      } catch { /* 忽略 */ }
      if (confirm) {
        confirmText(sender, chatKey, ok
          ? `收到，我先睡一会儿～期间的消息我会存档但不回复。想叫醒我：@我 并发送「${wakeWords[0] || '/起床'}」。`
          : '（睡眠模式已生效，但部分调度未暂停，可稍后重试）');
      }
      return { blocked: true };
    }

    // ── ③ 自然睡眠（她自己困了）：睡着且没被喊醒 → **底层拦掉，模型根本不跑** ──
    //    这是主人明确要求的"完全底层的忽略"（SLEEP-IGNORE-FIX，见 provider 上方注释）。
    //    开关 ignoreWhileSleeping=false 可退回旧行为（只在内层闸拦发送）。
    const sleep = currentSleep();
    if (sleep.sleeping && sleep.kind === 'natural' && c.ignoreWhileSleeping !== false) {
      // (a) 唤醒关键词：@我 + 命中任一唤醒词（可选仅主人）→ 真的起床（写 awake + wakeAt + 清闸门）
      const wHit = kind === 'group' && atMe ? keywordHit(text, wakeWords) : '';
      if (wHit && (c.lockWakeToOwner !== true || isOwner)) {
        wakeUp({ reason: '自然睡眠中收到唤醒关键词' });
        try { api?.log?.(`自然睡眠中收到唤醒关键词「${wHit}」→ 已起床`); } catch { /* 忽略 */ }
        return { blocked: false };
      }

      // (b) 主人起床口令 → 真的起床（只认主人、不必 @她、不必带名字）
      const words = parseWakeWords(c.wakeWords);
      if (words.length) {
        const w = ownerWakeHit([{ senderId, text, self: false }], ownerQq, words);
        if (w) {
          wakeUp({ reason: '自然睡眠中主人起床口令' });
          try { api?.log?.(`自然睡眠中主人口令命中「${w.hit}」→ 已起床`); } catch { /* 忽略 */ }
          return { blocked: false };
        }
      }

      // (c) 被喊醒（喊醒词 / 接触词 **+ 被称呼**）→ 放行**这一轮**，让她迷糊回一句。
      //     状态**不改**（下一轮还是睡）—— 与引擎 isWakeCall 的原语义一致：
      //     "睡着了被吵到，迷糊回一句"。
      let woken = false;
      try {
        woken = S.isWakeCall([{ senderId, text, isAtMe: atMe }], {
          selfNickname, botName, selfId, isPrivate: kind === 'private'
        });
      } catch { /* 判定失败按"没喊醒"处理：宁可漏放一轮，也不要白烧 token */ }
      if (woken) return { blocked: false };

      // (d) 其余一律**忽略**：不建会话、不调模型、零 token。
      //
      // ⚠️ SLEEP-UNREAD（2026-09-22，主人要求）：这里**不标已读**，消息原样保持未读。
      //    语义：她睡着的这段时间只是"听不到"，不是"没发生过" —— 等她醒来
      //    （喊醒 / 口令 / 午睡到点 / 睡满 sleepAutoMs 自然醒），这些未读会被
      //    下一次触发一次性 drainUnread 取走，她**统一补看**这段时间说了什么。
      //
      //    为什么上一版标了已读：怕她睡 8 小时堆几百条未读、醒来一次全灌给模型。
      //    权衡后主人要"别把我的话吞掉"→ 保留未读。代价是醒来那一下会补处理积压，
      //    所以唤醒日志里会报出积压条数，方便判断要不要收（见 SKILL.md §9.5）。
      //
      //    顺带：不标已读也就**没有**"唤醒批被后来的普通消息标掉"这个竞态了，
      //    所以上一版的 wakeAllowUntil 保护窗已删除（不再需要）。
      //
      // 记一行日志：blocked 意味着**不建会话**，GUI 会话列表里不会留下任何痕迹 ——
      // 不记的话"她怎么不回消息"完全看不出来，容易误判成插件没生效。
      let backlog = 0;
      try { backlog = Number(store?.unreadCount?.(chatKey)) || 0; } catch { /* 数不到就不报条数 */ }
      try {
        api?.log?.(`睡眠忽略：${chatKey} 已拦（模型未调用，省一次 API）`
          + `，消息保持未读${backlog ? `（当前积压 ${backlog} 条，醒来补看）` : ''}`);
      } catch { /* 忽略 */ }
      return { blocked: true };
    }

    // ── ④ 一切正常：放行 ──
    return { blocked: false };
  },

  // 控制台「心情」页的数据源；由插件写入静态 JSON，前端不经过 LLM。
  'mood.dashboard': () => dashboardSnapshot()
};

// ══════════════════════════════════════════════════════════════════════════
// 钩子
// ══════════════════════════════════════════════════════════════════════════

export const hooks = {
  /**
   * 时机：组装提示词之前 —— 对应上游 orchestrator 每触发轮的动作。
   * 做三件事：① 记录情绪/愤怒/吃醋增量 ② 处理主人起床口令 ③ 判定睡眠闸并存给 before-tool。
   *
   * ⚠️ 钩子有 5 秒超时且禁止网络/副作用；这里全部是本地正则与文件读写，安全。
   */
  'before-context'(ctx = {}) {
    const s0 = settings();
    lastDiag = {
      apiSet: !!api,
      enabled: s0.enabled,
      blockWhileSleeping: s0.blockWhileSleeping,
      chatKey: ctx.chatKey,
      kind: ctx.kind,
      entries: Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries.length : -1,
      commandSleep
    };
    if (!on(s0.enabled)) { lastDiag.earlyReturn = 'enabled=false'; return; }
    const cfg = engineCfg();
    const chatKey = String(ctx.chatKey || '');
    const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
    const selfNames = selfNamesOf(ctx);
    const selfId = String(ctx.selfId || '');
    // 主人 QQ 只解析一次：口令匹配与 observeTrigger 的护亲判定用的是同一个值，
    // 解析两次会在软依赖（owner-identity 能力）上白跑一次。
    const ownerQq = resolveOwnerQq();

    // ① 观察（冷落结算 → 情绪增量 → RAGE 三通道 → 吃醋）
    try {
      M.observeTrigger(entries, {
        recent: recentFn(ctx),
        chatKey,
        cfg,
        ownerQq,
        selfNames,
        selfId
      });
    } catch (e) {
      try { api?.warn?.('observeTrigger 失败', e?.message ?? e); } catch { /* 忽略 */ }
    }
    publishDashboard();

    // ② 主人起床口令：命中就**真的起床**（写状态 + 清命令睡眠 + 清闸门缓存）。
    //    必须排在睡眠闸之前 —— 状态改成 awake 后，下面 sleepGate 读到的就是清醒的，
    //    闸门自然放行；否则就得在闸门里再加一处特判，而那正是将来会对不上的分支。
    //    【融合】这段现在走统一的 wakeUp()，因此命令睡眠也一并解除。
    try {
      const words = parseWakeWords(s0.wakeWords);
      if (words.length) {
        const w = ownerWakeHit(entries, ownerQq, words);
        if (w) {
          const before = currentSleep();
          if (before.sleeping) {
            const r = wakeUp({ reason: '主人起床口令' });
            lastDiag.wokeByOwner = w.hit;
            lastDiag.wokeKind = before.kind;
            // 命令睡眠期间口令命中 → 也要补处理积压（否则消息一直挂着未读）
            if (r.wasCommand) {
              try {
                const n = lastOrchestrator?.resumeAll?.({ limit: Math.max(1, Number(s0.resumeCount) || 20) }) ?? 0;
                lastDiag.wokeResumed = n;
              } catch { /* 忽略 */ }
            }
            // 日志单独 try：起床已经落盘了，不能因为写日志抛错而让调用方以为失败
            try { api?.log?.(`主人起床口令命中「${w.hit}」→ ${chatKey} 已起床（${before.kind}）`); } catch { /* 忽略 */ }
          } else {
            // 没在睡：口令什么都不做（否则会把"在忙某件事"之类的状态误清掉）
            lastDiag.wakeNoop = `status=${before.status}`;
          }
        }
      }
    } catch (e) {
      try { api?.warn?.('起床口令处理失败', e?.message ?? e); } catch { /* 忽略 */ }
    }

    // ③ 睡眠闸：上游是在 wake 入口拦，v0.4 的钩子在 wake 之后触发，
    //    所以这里只做判定，真正的拦截交给 before-tool（见下）。
    //    【融合】命令睡眠已经在入站闸门拦掉了（模型根本不跑），走到这里说明
    //    是"放行"的情况（比如 hard=false 时被喊醒的那轮）——此时不缓存闸门，
    //    让她能正常回一句。
    if (on(settings().blockWhileSleeping) && !commandSleep) {
      try {
        const g = S.sleepGate({
          entries,
          selfNickname: String(ctx.selfNickname || ''),
          botName: String(ctx.botName || ''),
          selfId,
          cfg,
          isPrivate: ctx.kind === 'private'
        });
        gateByChat.set(chatKey, g);
        // ⚠️ 日志单独 try：曾经这里写成 `api.log(...)`，一旦日志层面抛错就会落到下面的
        //    catch，而 catch 里的 delete 会把**刚刚 set 好的、算得完全正确的闸门删掉** ——
        //    结果是"睡眠闸莫名其妙不生效"。set 之后不容许任何可能抛错的东西裸奔。
        if (g?.block) { try { api?.log?.(`睡眠闸：${chatKey} 已拦（${g.reason}）`); } catch { /* 日志失败不影响闸门 */ } }
      } catch (e) {
        // 只有 sleepGate 本身失败才该丢弃闸门；判定不出来时选择"不拦"（宁可让她说话，
        // 也不要因为一个判定错误把她永久禁言）。
        gateByChat.delete(chatKey);
        if (lastDiag) lastDiag.gateError = String(e?.stack ?? e?.message ?? e);
        try { api?.warn?.('睡眠闸判定失败（本次不拦）', e?.message ?? e); } catch { /* 忽略 */ }
      }
    } else {
      gateByChat.delete(chatKey);
    }
  },

  /**
   * 时机：发给模型之前 —— 对应上游 prompt.js 里那 13 个注入块。
   *
   * 注入位置选在**消息数组末尾**（追加到最后一条 user 消息上）：
   * 这样前面那一大段静态前缀的缓存不受影响，只有尾巴变 —— 成本最优。
   */
  'before-llm-messages'(ctx = {}) {
    const s = settings();
    if (!on(s.enabled) || !on(s.inject)) return;
    const messages = ctx.messages;
    if (!Array.isArray(messages) || !messages.length) return;

    const cfg = engineCfg();
    const out = [];

    // 注意：引擎里没有 soloVoiceBlock / jealousBlock，
    // 「醋」的注入块真名是 jealousyTierBlock（醋意分档）。
    // 已移除的模块（情爱/性欲/色色兴奋/贤者/自慰/想要/姊妹/哥哥健康）不再注入 ——
    // 它们的 Block 在 enabled:false 下也只会返回 null，这里直接不调用更省一层。
    block(out, M.moodChainBlock, cfg);
    block(out, M.fatigueBlock, cfg);
    block(out, M.jealousyTierBlock, cfg);
    block(out, M.depressBlock, cfg);
    block(out, M.satisfactionBlock, cfg);
    if (on(s.selfState)) {
      block(out, S.selfStateBlock, cfg);
      block(out, S.scheduleBlock, cfg);
    }
    if (!out.length) return;

    const text = ['【心情与当前状态】（本地数值演算，按它调整语气与节奏，不要直接复述数值）',
      '如果这一轮对话明显改变了你的心情，可以调用「调整心情数值」工具，只调整 1-3 个最相关的项（0-100）；没有明显变化不要调用，也不要为了报数而调用。',
      ...out].join('\n\n');

    try {
      for (let i = messages.length - 1; i >= 0; i -= 1) {
        const m = messages[i];
        if (!m || m.role !== 'user') continue;
        if (typeof m.content === 'string') {
          m.content = `${m.content}\n\n${text}`;
          return;
        }
        if (Array.isArray(m.content)) {
          m.content.push({ type: 'text', text });
          return;
        }
      }
      // 没有 user 消息（少见）→ 单独补一条
      messages.push({ role: 'user', content: text });
    } catch (e) {
      try { api?.warn?.('注入失败', e?.message ?? e); } catch { /* 忽略 */ }
    }
  },

  /**
   * 时机：每次工具调用之前 —— 承担上游 wake 入口 sleepGate 的**拦截**职责。
   *
   * 为什么能在这里拦：上游是"睡着就不调模型"（省 token），v0.4 的钩子触发在
   * wake 之后，已经没有"不跑"这个选项了；但 `before-tool` 是唯一能返回
   * `{block:true}` 的地方，所以改成"睡着时发不出去"—— 效果等价，
   * 而且这正是官方文档 §12 quiet-hours 示例的做法。
   *
   * 【融合】命令睡眠不在这里判（它在入站闸门就拦了，模型压根没跑）；
   * 这里只负责自然睡眠的内层闸。两道闸各管一段，互不重复。
   */
  'before-tool'({ toolName } = {}) {
    const s = settings();
    if (!on(s.enabled) || !on(s.blockWhileSleeping)) return;
    // 工具 id 是 `<skillId>__<工具名>`，取最后一段
    const bare = String(toolName || '').split('__').pop();
    if (!['send_message', 'send_sticker', 'send_poke', 'send_image'].includes(bare)) return;

    for (const g of gateByChat.values()) {
      if (g && g.block) {
        return { block: true, reason: '她睡着了（没被喊醒）。安静是正常的，不要改用别的工具绕过去。' };
      }
    }
  },

  /**
   * 时机：每次工具调用之后 —— 对应上游 sender.js 出口那组「观察她自己的话」。
   * 拿到的文本喂给：自身状态机（睡/busy）、情绪自增、洗澡结算、疲劳时间戳。
   */
  'after-tool'({ toolName, argsRaw, result } = {}) {
    if (!on(settings().enabled)) return;
    const bare = String(toolName || '').split('__').pop();
    if (bare !== 'send_message') return;
    if (result && result.isError) return;

    const text = extractSentText(argsRaw);
    if (!text) return;
    const cfg = engineCfg();
    const now = Date.now();

    try {
      selfMsgTs.push(now);
      if (selfMsgTs.length > 200) selfMsgTs = selfMsgTs.slice(-200);
    } catch { /* 忽略 */ }

    // ⚠️ 引擎里有一类函数是「只计算、不落盘」，调用方必须自己写回去。
    //    这里踩过两次坑，逐个标注清楚：
    //    · stateFromSelfText(text, now, cfg) → 返回新状态 | null（**不写盘**）
    //    · selfMoodDelta(text, cfg, now)     → 返回 {delta, why} | null（**不写盘**）
    //    对照组：stepMood / settleBath / writeBathState 都是直接落盘的。

    // 自身状态机（说"我睡了"→sleeping；说"我在干X"→busy）
    try {
      const prev = S.readSelfState(now);
      const next = S.stateFromSelfText(text, now, cfg);
      if (next) {
        S.writeSelfState(next);
        // FATIGUE-STUCK-FIX：只在**真正发生 awake→sleeping 跃迁**时记入睡时刻。
        //   · 不判跃迁的话，她睡着后又说了句"我去倒杯水"之类被忽略、
        //     或重复宣告，会不断把 sleptAt 推后 → 睡了一整夜也恢复不了；
        //   · 午睡（nap）也走这条路 —— stateFromSelfText 会带 wakeAt，
        //     恢复量在 stepFatigue 里按 napRecoverFactor 减半，语义已在引擎里。
        if (next.status === 'sleeping' && prev.status !== 'sleeping') {
          try { M.markFatigueSleep(true, now); } catch { /* 记不上不影响睡觉 */ }
        }
      }
    } catch { /* 忽略 */ }

    // 洗澡：开始 / 结束（双人标记两条路都要带）
    try {
      const withSister = S.bathWithSisterFromSelfText(text);
      if (S.bathStartFromSelfText(text)) S.writeBathState({ withSister, now });
      else if (S.bathDoneFromSelfText(text)) S.settleBath({ withSister });
    } catch { /* 忽略 */ }

    // 她自己的话也会改变情绪（增量打 selfFactor 折，也要自己 step）
    try {
      const d = M.selfMoodDelta(text, cfg, now);
      if (d) { M.stepMood(d.delta, d.why, cfg, now); publishDashboard(); }
    } catch { /* 忽略 */ }
  }
};

/** 从 send_message 的 argsRaw 里抠出她实际发出去的文本。argsRaw 可能是字符串或对象。 */
function extractSentText(argsRaw) {
  let args = argsRaw;
  if (typeof args === 'string') {
    try { args = JSON.parse(argsRaw); } catch { return String(argsRaw || '').trim(); }
  }
  if (!args || typeof args !== 'object') return '';
  const m = args.messages ?? args.message;
  if (Array.isArray(m)) return m.map((x) => String(x ?? '')).filter(Boolean).join('\n').trim();
  return String(m ?? '').trim();
}

// ══════════════════════════════════════════════════════════════════════════
// 工具（替代上游的 panel.html；融合版新增 sleep_control）
// ══════════════════════════════════════════════════════════════════════════

/** 可手调的 mod 白名单 → 该 mod 在 mood.json 里的字段名。
 *  已移除的模块（love/lust/arousal/want/sister）不在白名单里 ——
 *  它们已停用，手调了也不会被任何注入块读到，留着只会误导模型。 */
const ADJUSTABLE = {
  happy: 'moods.happy', excited: 'moods.excited', angry: 'moods.angry',
  jealous: 'moods.jealous', sad: 'moods.sad',
  fatigue: 'fatigue',
  spunk: 'spunk', depress: 'depress', satisfaction: 'satisfaction'
};

const num = (v, d) => { const n = Number(v); return Number.isFinite(n) ? n : d; };

function registerMoodTools(a) {
  a.registerTool({
    id: 'mood_status',
    name: '查看心情与状态',
    description: '读出她此刻的心情数值和生活状态（情绪五维 / 疲劳 / 吵架速度 / 抑郁 / 满足 / 睡眠与在做的事 / 命令睡眠开关）。当主人问"她现在什么心情""状态怎么样"，或你想确认某个数值再决定怎么说话时使用。',
    category: 'query',
    icon: '🌡️',
    defaultEnabled: true,
    // 无参数的工具省略 required —— 空数组是冗余声明，审计会判为不合法
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const now = Date.now();
        // 用 moodSnapshot 而不是直接读盘：拿到的是**衰减后**的当前值。
        // 直接读盘只能得到"上次变动时的值"，跟提示词注入里用的现值对不上 ——
        // 她会说"我很累"，而工具报 fatigue=0。
        const snap = M.moodSnapshot(engineCfg(), now);
        const sleep = currentSleep(now);
        const self = S.readSelfState(now);
        const lines = [];
        const moods = snap.moods || {};
        const parts = Object.keys(moods)
          .map((k) => `${k}=${Math.round(num(moods[k], 0))}`)
          .join(' ');
        lines.push(`情绪五维：${parts || '（都很平静）'}`);
        if (snap.dominant) lines.push(`主导情绪：${snap.dominant.word}`);
        const one = (label, v) => `${label}=${Math.round(num(v, 0))}`;
        lines.push([
          one('疲劳', snap.fatigue),
          one('吵架速度', snap.spunk), one('抑郁', snap.depress),
          one('满足', snap.satisfaction)
        ].join(' '));
        // 【融合】睡眠状态分两级说清楚，方便判断是哪道闸在生效
        lines.push(`命令睡眠：${commandSleep ? '开（不送模型，零 token）' : '关'}`);
        lines.push(`当前状态：${self?.status || 'awake'}${self?.what ? ` —— ${self.what}` : ''}`);
        if (sleep.sleeping) lines.push(`睡眠判定：睡着（${sleep.reason}）`);
        const g = [...gateByChat.values()].find((x) => x && x.block);
        if (g) lines.push(`睡眠闸：已拦（${g.reason}）`);
        return { content: lines.join('\n') };
      } catch (e) {
        return { content: `读取失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  a.registerTool({
    id: 'mood_adjust',
    name: '调整心情数值',
    description: '把某一项心情数值直接设成指定值（0-100）。当主人明确要求调整，或这一轮对话明显改变了你的心情时使用；自己判断时只调 1-3 个最相关的项，不要每轮调用。可用项：happy/excited/angry/jealous/sad/fatigue/spunk/depress/satisfaction。这个操作直接改磁盘数值，不可撤销（但会被自然衰减拉回）。',
    category: 'system',
    icon: '🎚️',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        mod: { type: 'string', description: '要调整的项，例如 happy / fatigue / depress / jealous' },
        value: { type: 'number', description: '目标数值，0-100（超出会夹到范围内）' },
        reason: { type: 'string', description: '简短原因，例如被夸了、被冷落、吵架了（可选）' }
      },
      required: ['mod', 'value']
    },
    async execute(_ctx, args) {
      try {
        const key = String(args?.mod ?? '').trim();
        if (!ADJUSTABLE[key]) {
          return { content: `没有 ${key} 这一项。可用：${Object.keys(ADJUSTABLE).join('/')}`, isError: true };
        }
        const v = Math.max(0, Math.min(100, Math.round(num(args?.value, NaN))));
        if (!Number.isFinite(v)) return { content: 'value 必须是数字', isError: true };

        const now = Date.now();
        const st = M.readMoodChain(now) || {};
        const path = ADJUSTABLE[key];
        if (path.startsWith('moods.')) {
          const em = path.split('.')[1];
          st.moods = st.moods || {};
          const prev = st.moods[em] || {};
          st.moods[em] = { level: v, why: String(args?.reason || '自己判断').slice(0, 80), at: now, decayMs: prev.decayMs };
        } else {
          const prev = st[path] || {};
          st[path] = { ...prev, value: v, at: now };
        }
        const okWrite = M.writeMoodChain(st);
        if (okWrite) publishDashboard();
        return okWrite
          ? { content: `已把 ${key} 设为 ${v}。不要输出汇报式总结，自然回应主人即可。` }
          : { content: '写入状态文件失败（磁盘权限或路径问题）', isError: true };
      } catch (e) {
        return { content: `调整失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  a.registerTool({
    id: 'mood_reset',
    name: '重置心情到平静',
    description: '把所有心情数值清零、并让她回到清醒状态（同时解除命令睡眠）。当主人说"把她心情重置一下""忘掉刚才的不愉快""恢复到默认"时使用。这个操作会丢掉当前所有累积数值，不可撤销。',
    category: 'system',
    icon: '↩️',
    defaultEnabled: true,
    // 无参数的工具省略 required —— 空数组是冗余声明，审计会判为不合法
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const okWrite = M.writeMoodChain({});
        if (okWrite) publishDashboard();
        try { S.writeSelfState({ status: 'awake', what: '', at: Date.now() }); } catch { /* 自身状态重置失败不致命 */ }
        // 【融合】重置也要管命令睡眠 —— 否则"重置了但还是不说话"。
        // 若之前开着命令睡眠，把调度恢复回来（否则机器人永久沉默）。
        const wasCommand = commandSleep;
        if (wasCommand) {
          try { lastOrchestrator?.resumeAll?.({ limit: Math.max(1, Number(settings().resumeCount) || 20) }); } catch { /* 忽略 */ }
          commandSleep = false;
        }
        gateByChat.clear();
        return okWrite
          ? { content: `已重置为平静状态${wasCommand ? '（并解除了命令睡眠）' : ''}。不用汇报，正常说话。` }
          : { content: '写入状态文件失败', isError: true };
      } catch (e) {
        return { content: `重置失败：${e?.message ?? e}`, isError: true };
      }
    }
  });

  /**
   * 【融合新增】睡眠总开关工具 —— 让模型/主人用自然语言控制命令睡眠，
   * 不用非得在群里 @ 机器人发 /睡觉。
   *
   * 为什么值得加：/睡觉 是"确定性触发"（必须 @ + 精确指令），适合主人自己按键；
   * 但主人也可能说"你先睡一会儿""别说话了" —— 那是**自然语言**，
   * 只有注册成工具模型才会去调。两者最终都落到同一对 suspendAll/resumeAll 上。
   */
  a.registerTool({
    id: 'sleep_control',
    name: '控制命令睡眠',
    description: '开关【命令睡眠】：开启后机器人只存档消息、完全不送大模型（零 token 消耗），直到解除。当主人说"你先睡一会儿""别说话了""安静一下"或"醒醒""可以说话了"时使用。注意：这与她自己困了去睡（自然睡眠）不是一回事，命令睡眠是主人对机器人下的停机开关。',
    category: 'system',
    icon: '😴',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['sleep', 'wake', 'status'],
          description: 'sleep=开启命令睡眠（不回复）；wake=解除并补处理积压消息；status=只查询当前状态'
        }
      },
      required: ['action']
    },
    async execute(_c, args) {
      try {
        const action = String(args?.action ?? '').trim();
        const resumeCount = Math.max(1, Number(settings().resumeCount) || 20);

        if (action === 'status') {
          return {
            content: `命令睡眠：${commandSleep ? '开启中（消息只存档不回复）' : '未开启'}；`
              + `自然睡眠状态：${currentSleep().status}`
          };
        }

        if (action === 'sleep') {
          if (commandSleep) return { content: '命令睡眠已经是开启状态。' };
          let ok = false;
          try { ok = lastOrchestrator?.suspendAll?.() === true; } catch { /* 忽略 */ }
          commandSleep = true;
          gateByChat.clear();
          publishDashboard();
          return {
            content: ok
              ? '已进入命令睡眠：消息照常存档但不再送模型。主人说"醒醒"或 @我 /起床 即可解除。'
              : '已标记命令睡眠，但调度暂停未确认成功（可能机器人未运行或 orchestrator 不可用）。'
          };
        }

        if (action === 'wake') {
          if (!commandSleep) {
            return { content: `命令睡眠本来就没开（自然睡眠状态：${currentSleep().status}）。如果她不说话，可能是自然睡眠的睡眠闸拦着，需要用起床口令或等她自然醒。` };
          }
          wakeUp({ reason: '工具唤醒' });
          publishDashboard();
          let touched = 0;
          try { touched = lastOrchestrator?.resumeAll?.({ limit: resumeCount }) ?? 0; } catch { /* 忽略 */ }
          return { content: `已解除命令睡眠${touched > 0 ? `，正在补看 ${touched} 个群的最近消息` : ''}。` };
        }

        return { content: `不认识的 action：${action}。可用：sleep / wake / status`, isError: true };
      } catch (e) {
        return { content: `操作失败：${e?.message ?? e}`, isError: true };
      }
    }
  });
}
