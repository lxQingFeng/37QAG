// 配置管理：data/config.json，UI 可写。所有字段都有默认值。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PERSONAS } from './personas.js';
import { sliderToTier } from './tier-slider.js';   // 零依赖模块，避免循环依赖

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// ── 多实例（同一份程序目录同时跑两个机器人）──
// 设置 QQ_AGENT_PROFILE=2 启动时（见 启动-双号.bat / scripts/setup-second-instance.mjs），
// 本实例的数据目录与控制台端口自动和主实例错开，两边的人设/白名单/存档/记忆互不影响。
export const PROFILE_ID = String(process.env.QQ_AGENT_PROFILE || '').trim();
const PROFILE_INDEX = /^\d+$/.test(PROFILE_ID) ? Number(PROFILE_ID) : 0;

// 测试/便携/多实例场景可用 QQ_AGENT_DATA_DIR（或别名 QAG_DATA_HOME）重定向数据目录。
// 优先级：QQ_AGENT_DATA_DIR > QAG_DATA_HOME > 默认（ROOT/data[/-N]）。
export const DATA_DIR = process.env.QQ_AGENT_DATA_DIR
  || process.env.QAG_DATA_HOME
  || path.join(ROOT, PROFILE_ID ? `data-${PROFILE_ID}` : 'data');
export const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

// ── 桌面端 UI 设置两号互通 ──
// 主题/工具栏/开机自启/关窗进托盘这类「桌面壳」偏好放在程序根目录的共享文件里，
// 号A、号B（data / data-2）读写同一份 —— 设一次两边都生效。
// 端口、令牌、账号名、人设等业务配置仍按数据目录隔离。
export const DESKTOP_PREFS_FILE = path.join(ROOT, 'desktop-prefs.json');
const DESKTOP_UI_KEYS = [
  'theme', 'customBg', 'customBg2', 'customAccent', 'customText', 'customToolAccent',
  'customThemeId', 'mechFx',
  'brightness',
  'uiScale',
  'showVision', 'refreshMs', 'hideApiNews', 'instanceTabs', 'hideInstanceTabs', 'navOrder', 'navHidden', 'topOrder', 'topHidden'
];
const DESKTOP_SERVER_KEYS = ['autoStart', 'closeToTray'];

function pickKeys(obj, keys) {
  const out = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const k of keys) {
    if (obj[k] !== undefined) out[k] = structuredClone(obj[k]);
  }
  return out;
}

function loadDesktopPrefsFile() {
  try {
    let text = fs.readFileSync(DESKTOP_PREFS_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function writeDesktopPrefsFile(cfg) {
  try {
    const prefs = {
      ui: pickKeys(cfg?.ui, DESKTOP_UI_KEYS),
      server: pickKeys(cfg?.server, DESKTOP_SERVER_KEYS),
      savedAt: Date.now()
    };
    fs.mkdirSync(ROOT, { recursive: true });
    const tmp = `${DESKTOP_PREFS_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2), 'utf8');
    fs.renameSync(tmp, DESKTOP_PREFS_FILE);
    return prefs;
  } catch (error) {
    console.error('[config] 写入 desktop-prefs 失败:', error?.message ?? error);
    return null;
  }
}

/** 把共享桌面偏好盖到当前配置上（只覆盖互通键，不动端口/账号名等）。 */
function applyDesktopPrefs(cfg) {
  const prefs = loadDesktopPrefsFile();
  if (!prefs) return cfg;
  if (prefs.ui && typeof prefs.ui === 'object') {
    cfg.ui = { ...(cfg.ui || {}), ...prefs.ui };
  }
  if (prefs.server && typeof prefs.server === 'object') {
    cfg.server = { ...(cfg.server || {}), ...prefs.server };
  }
  return cfg;
}

/** 首次运行：还没有共享文件时，用当前这份配置播种（主实例优先带完整工具栏）。 */
function seedDesktopPrefsIfNeeded(cfg) {
  try {
    if (fs.existsSync(DESKTOP_PREFS_FILE)) return;
    writeDesktopPrefsFile(cfg);
  } catch { /* ignore */ }
}

// 默认控制台端口：无 profile = 3210（保持原行为）；profile 2/3… 依次 +1。
// 端口被占用时仍会自动往后找空位（见 app.js start()），也可用 QQ_AGENT_PORT 直接指定。
const DEFAULT_CONSOLE_PORT = Number(process.env.QQ_AGENT_PORT)
  || (3210 + Math.max(0, PROFILE_INDEX - 1));

export const DEFAULT_CONFIG = {
  // OpenAI 兼容 API（必填才能跑）
  api: {
    // 出厂留空：这是作者本机的网关地址，对其他人毫无意义，
    // 留空能让「就绪度体检」正确提示"还没填 Base URL"。
    baseUrl: '',                             // 例如 https://api.deepseek.com/v1 或自建网关
    apiKey: '',
    model: '',                              // UI 里选择/填写
    provider: '',                           // 当前模型所属提供商（多提供商目录的选中项）
    vision: true,                           // 模型是否支持图片输入（关掉则移除看图工具）
    // 自动看图（默认开）：触发消息里自带的图，直接下成 data URL 挂进本轮 user 消息，
    // 不再要求模型主动调 get_message_images（小模型经常想不起来）。
    // 设 false 退回旧行为（只在模型显式调工具时才看到图）。主动插话轮不看图。
    autoVision: true,
    // 认图闸：自动附图之前先判「这张图跟当前话题关系大不大」，无关就不附图、并明说别认图 ——
    // 否则模型看到图就以为在说自己，把话题扯到认图上（2026-09-21 管理员反馈）。
    //   档位（20 例留出集盲测）：
    //     hybrid = 本地 Jev 先判，判 RELATED 时再由主模型复核一句 → 19/20（95%）·默认
    //     cloud  = 直接问主模型 → 20/20（提示词极短且有缓存，每次约 0.0001 元）
    //     local  = 只问本地 Jev → 14/20（70%，错在"无关→相关"5 例）
    //     off    = 不判，有图就附（旧行为）
    //   对方明确说"看看/这是啥/分析下/图里"时不问闸，直接附图。
    imageGate: 'hybrid',
    // ── 阶段三·模型通道（本地/云端二选一）────────────────────────────────
    // channel = 'cloud'（默认，行为与 0.5 完全一致）
    //         | 'local'（主对话走本地 OpenAI 兼容端点，如 llama-server /v1、Ollama、LM Studio）
    //         | 'auto' （云端优先；云端没配 Key 或请求失败 → 回退本地）
    channel: 'cloud',
    // 本地端点（OpenAI 兼容 /chat/completions）。默认指向 localJev 拉起的 llama-server
    // —— 也就是说「勾了本地 Jev」的包已经具备本地主对话的全部前提，channel 一切就切过去。
    local: {
      baseUrl: 'http://127.0.0.1:18080/v1',
      model: '',                // 留空 = 启动/首用时自动 GET /models 探测
      apiKey: ''                // 本地服务一般不需要；llama-server 默认免鉴权
    },
    // 回退策略：channel='local' 时本地端点挂了怎么办
    //   'local-to-cloud'（默认）→ 本地失败自动改走云端（云端已配置时）
    //   'none'                → 不回退，本地挂就报错（纯离线场景用它，避免误花钱）
    fallback: 'local-to-cloud',
    // ── 阶段三·工具按需注入（会话调度省 token）───────────────────────────
    // toolGate = 'off'    → 每轮全量注入（0.5 行为）
    //           | 'rules'（默认）→ 规则分类：纯闲聊轮只注入常驻工具（省 search/media/memory
    //                                三类 schema token），判不准则全量保底。零成本、零延迟。
    //                                jev 级联 PR1 起：技能工具与技能提示词段同源参与门控。
    //           | 'jev'  → 规则判不准时再问本地 Jev「这轮要不要查资料/看图」（+≤1 次本地推理，
    //                        换更准的裁剪；本地没起时自动退回 rules 行为）
    //           | 'jev2' → jev 级联 PR2：规则判不准时问本地 Jev 五分类「接这句要 查/图/忆/技/闲」，
    //                        label 直接映射该开的类别（工具+技能提示词同源裁剪，比 jev 档更细）。
    //                        弃权/失败/超时→全量保底；五分类 0.8B 未实测，不达标退回 jev 档即可
    //                        （同一开关换值，无额外清理）。
    toolGate: 'rules',
    // 工具结果硬上限（防单轮 token 爆炸）：单工具结果截断 / 每轮累计预算（字符）
    toolResultMaxChars: 6000,
    toolResultBudgetChars: 12000,
    // 关闭模型"思考模式"。按端点自动选参数（常见国内均适配）：
    //   阿里百炼 enable_thinking:false · 火山/智谱/Kimi/DeepSeek thinking.type=disabled
    //   硅基流动 chat_template_kwargs · 未知中转试 enable_thinking，400 自动去掉重试
    //   OpenAI 官方/本地推理不发该字段。
    //
    // ⚠️ 2026-09-11 重测结论（号A = qwen3.7-flash，6 个真实会话 × 2 次，另一个模型盲评）：
    //   关思考 输 8 : 赢 4 —— 会出现"不是""对"这种一个词的回复，约 1/3 还把回复写成
    //   内心独白（正文不发送 → 群里静默），用户感受就是"这模型好蠢"。
    //   所以对混合推理模型**不建议**直接关思考；更好的做法是关掉这个开关、
    //   改用下面的 thinkingBudget 限长思考（128~320 就能兼顾脑子和速度）。
    disableThinking: false,
    // 思考长度上限（开思考且端点支持时生效；0 = 不限制，用端点默认）。
    // 百炼 thinking_budget / 方舟·智谱·Kimi thinking.budget_tokens。
    // 实测 qwen3.7-flash：不限制 → 8~37 秒；128 → 约 2.3 秒；320 → 约 5.0 秒。
    // 号A 目标配 64：目标把思考压到约 2 秒内，同时仍保留一点脑子（好过关思考）。
    thinkingBudget: 64,
    // 上下文缓存模式：
    //   adaptive = 自适应（推荐）：保温开着 → 始终打 cache_control + 自动保温续 TTL；
    //              保温关掉 → 退回纯隐式（不打标记）。见 src/cache-keepalive.js。
    //   implicit = 只稳定前缀，不发 cache_control（无 5 分钟硬过期/创建溢价）；
    //   explicit = 稳定 system 末尾始终打一个 cache_control（不打保温）；
    //   off      = 旧布局，不为缓存搬运静态块。
    // null 用于兼容旧配置：未迁移时仍读取下面的 explicitCache。
    //
    // ⚠️ 2026-09-21 实测（qwen3.8-flash，真实提示词）：可缓存前缀（工具 5,457 + system 8,760
    //   = 14,217 tok）占整个提示词的 86.8%，但因为百炼显式缓存只有 5 分钟 TTL 且"命中才续期"，
    //   而 QQ 聊天常常十几分钟才两句 → **每次运行的首次调用命中率只有 33~38%**，等于每轮都把
    //   这 14,217 tok 按原价重算。所以新增 adaptive：保温开着就始终打标记 + 保温续期。
    //
    // ⚠️ 2026-09-22 实测（同一提示词，冷/热互相打标记）：**隐式创建的缓存块对显式请求不可见** ——
    //   不带标记的那次调用建好的块，带标记的调用完全命中不到（0% + 按 125% 重建）。
    //   所以"冷着就不打标记"是错的：那样只会让热起来之后的第一枪白废一次创建费。
    //   现在只要保温开着就一律打标记，第一枪付 125%，之后每一枪都命中 10%。
    // ⚠️ 2026-09-22：默认值从 null 改成 'adaptive' —— 与线上实例保持一致。
    //   null 会被 resolveCacheMode 判成 'off'（既不搬静态块也不打标记），
    //   于是"新装/未迁移的实例"和"跑了一阵的实例"行为完全不同，
    //   同一个包里两份配置两种命中率。老配置里有显式值的不会被覆盖（见 migrateCacheMode）。
    cacheMode: 'adaptive',
    // 缓存保温（仅 adaptive/explicit + 百炼类端点生效）：
    //   命中一次之后，按 intervalMs 发一次 1-token 的极小请求，把 5 分钟 TTL 一次次续上，
    //   下一轮消息来时首调用就能命中。实测 T0 建缓存 → T+3.5min 保温 → T+6.6min 仍命中。
    //   一次保温约 0.0001 元，省下的是首调用里 14,217 tok 的原价 → 净赚约 7 倍。
    //   quietAfterMs 内没有新消息就自动停，不白烧；maxPerChat 限制每次运行后最多续几棒。
    // ⚠️ 2026-09-22：maxPerChat 3 → 6、quietAfterMs 10min → 30min，与线上实例对齐
    //   （3 棒 × 4 分钟 = 12 分钟覆盖，只够聊两句；6 棒 = 24 分钟，才盖得住"群里隔一会儿说一句"）。
    cacheKeepAlive: {
      enabled: true,
      intervalMs: 240000,
      maxPerChat: 6,
      quietAfterMs: 1800000,
      privateMaxPerChat: 8,          // 私聊更长：本来就来一句停一会儿
      privateQuietAfterMs: 1800000,
      minPrefixTokens: 4096
    },
    // 旧字段只作迁移兼容；新设置页会同步写入。不要直接用它判断布局。
    explicitCache: false,
    temperature: 0.8,
    // 采样参数（可选，0/空 = 用端点默认）。本地小模型建议：
    //   topP 0.9、frequencyPenalty 0.4、presencePenalty 0.3、maxTokens 220
    // 这组能明显压掉"复读同一句"和"长篇大论"。
    topP: 0,
    frequencyPenalty: 0,
    presencePenalty: 0,
    maxTokens: 4096,
    // 可选：本地端点预算放大试验（仅 localhost 且 enabled=true 时生效）。
    localReplyTrial: { enabled: false, autoFinish: false, complexTokens: 3072, maxTokens: 4096 },
    // 通用自动收尾（任意模型，含云端）：一轮里只发了消息、没有待办、也没报错时，
    // 直接结束本轮，不再为让模型说一句「我讲完了」多跑一整轮。
    // 护栏见 local-reply-policy.js 的 canEndReplyBatch（发图/搜索未完成、疑似半截话一律不收尾）。
    autoFinish: { enabled: true, multiOnly: true },
    // 工具子集（小模型建议开）：只列名字就只暴露这几个工具。
    // 例：['send_message','send_image','search_images','web_search','web_fetch','list_stickers','send_sticker','finish']
    // 留空 = 全部工具都给。
    tools: [],
    // send_message 的 messages 参数只给「数组」一种写法（默认 false = 数组/字符串两种都教）。
    // 实测本地小模型经常生成 {"messages":"[\"第一条\"]"}（把数组塞进字符串），
    // 两种可选写法等于多一个出错机会。后台仍兼容字符串，只是不再告诉它。
    sendMessagesArrayOnly: false,
    // 单次运行工具动作安全上限：避免小模型重复/发散拖慢或刷屏。
    toolLimits: {
      perRound: 8,
      perRun: 24,
      totalSends: 4,
      send_message: 2,
      send_sticker: 1
    },
    maxRounds: 12,                          // 单次运行的最多工具轮数
    // 模型只输出正文、不调工具时，是否提醒它一次（默认开）。
    // 有些模型（实测 qwen3.7-flash 约 25% 的会话）会把要发的话写成正文而不是调用
    // send_message，于是群里一条都没收到、后台显示"未回复"。开启后会在这种
    // "本轮无工具调用 + 正文像一条消息 + 本次运行还没发过话"的情况下补一轮提醒；
    // 只提醒一次，不会无限循环。想完全关掉就设为 false。
    nudgeTextOnly: true,
    // 定向@的追问提醒（默认开）：有人 @ 机器人且内容像提问、模型却只输出正文没调
    // send_message 时，补一轮「必须回复」的硬提醒（与 nudgeTextOnly 同一次数限制）。
    // 设 false 关掉这条定向提醒（nudgeTextOnly 的通用提醒不受影响）。
    pointedNudge: true,
    // 协议提醒（默认开，2026-09-11 实测有效）：在用户提示词**最末尾**追加一句
    // "要发言就立刻调用 send_message，不打算说话就调用 finish"。
    // 实测号A（qwen3.7-flash）同一批真实会话 ×3：不加 22% 的运行整轮不调工具
    // （群里静默），加了降到 6%。成本约 60 token/次。
    replyReminder: true,
    // 会话考古（memory_search）：按需检索很久以前的聊天碎片。
    // 号A（远程、能力够）开着；号B（本地/弱模型）建议 false，避免瞎调/乱编。
    // maxSearchPerRun：单次运行内 memory_search/archive 合计最多几次（0=不限，不建议）
    conversationMemory: { enabled: true, maxSearchPerRun: 5 },
    // 热梗预查（默认开）：触发消息像在问热梗时，先用 web_search 预查一次再回答，
    // 避免凭旧印象硬猜"一本正经说错"。设 false 关闭预查。
    hotMemeAutoPrefetch: true,
    // 要图提醒（默认开）：触发词/本地 Jev 判定对方在要图、而模型一轮都没搜图时，
    // 在提示词最末尾点一句硬要求。设 false 关闭。
    imageRequestReminder: true,
    // 问旧事时：句式命中则注入硬要求，并本地预检索塞进提示词（仍不常驻每条消息）。
    memoryRecallReminder: true,
    memoryAutoPrefetch: true,
    // 梗库联想：弱相关也可「突然想起」1~2 条梗名（不灌全文）；false 关闭
    memeAutoCue: true,
    // 触发联想的最低分（越低越容易闪；2.5≈沾边就闪，5≈强命中）
    memeCueMinScore: 2.5,
    // 场合闸（2026-09-22 默认开）：只有这轮真有"接梗/玩闹"信号才查梗库。
    // 868 轮实测：不开闸时 72% 的闪梗落在不需要玩梗的轮次（报错/点歌/广告），
    // 而有信号的轮次 65% 没闪，模型采用率 0/193。判据是现成的词表，零成本零延迟。
    // 设 false 退回老行为（每轮都可能闪）。
    memeCuePlayfulOnly: true,
    // 架构增强（本地为主，短注入）：待办默认保留；跨轮摘要/语义卡默认关闭，
    // 需要时可单独开启。原始最近聊天与 memory_search 不受影响。
    architecture: {
      crossTurnWorking: false,
      semanticCards: false,
      semanticTopN: 2,
      // 跨群旁听默认关：要读其它会话消息文件，和【过去状态】职责重叠、又砸缓存前缀
      crossChatAwareness: false,
      crossChatMinutes: 10,
      crossChatMaxChats: 2,
      crossChatMaxChars: 120,
      workingTtlMin: 90,
      // 静默淡忘：空窗每满 N 分钟丢掉最早一轮跨轮记忆；0=关闭逐条淡忘（只留整体 TTL）
      workingDecayMin: 30,
      workingMaxChars: 160,
      // 待办状态机：LLM 自定过期分钟数；到点自动不注入
      pendingTodos: true
    },
    // 成本护栏：今日/本会话 prompt 累计上限后砍可选注入（本地计，不调模型）
    costGuard: {
      enabled: true,
      dayPromptMax: 800000,
      chatPromptMax: 200000
    },
    // 正文裁判（默认开）：模型整轮没调工具、只写了正文时，用一次极小提示词的调用
    // 判断这段正文是"成品消息"还是"内心思考"——前者补发出去（否则群里静默），
    // 后者丢弃（防止把"没人叫我…安静结束"发进群）。
    // 判定失败一律按"内心思考"处理（安全侧）。关掉设为 false，则退回旧的盲发兜底。
    textOnlyJudge: true,
    // 号 A 可选：用一次短上下文裁判补回漏发正文（含已发消息后的补充），
    // 校验原文来源并去重。失败时不盲发；保留 finish 的安静结束语义。
    protocolRecovery: false,
    // 裁判调用的输出预算。会思考的本地小模型容易把 300 token 全花在 reasoning 上，
    // 这里默认给 1200；本地小模型裁判也不准，建议保持 textOnlyJudgeLocal=false。
    textOnlyJudgeTokens: 1200,
    // 是否允许"本地端点"当裁判（默认 false = 跳过）。
    // 本地小模型（≤4B 级）长提示词下不可靠，本地跑得动 9B+ 再打开。
    textOnlyJudgeLocal: false,
    // 兜底：裁判不可用时，直接把它的正文当作消息发出去。
    // ⚠️ 只在 textOnlyJudge=false 或裁判接口报错时才生效；盲发有泄漏内心独白的风险。
    textOnlyFallback: true,
    timeoutMs: 90000,
    // 单次运行的总时限（毫秒，默认 2 分钟）：超时后不再发起新的工具轮，
    // 已发出的消息不受影响。想跑长任务（大批量整理）就调大。
    runDeadlineMs: 120000,
    // 成本核算（仅本地估算展示，不参与任何请求）
    priceInputPerM: 0,      // 输入单价（元 / 百万 token）—— 兜底默认值
    priceOutputPerM: 0,     // 输出单价
    priceCachedPerM: 0,     // 输入且命中缓存的单价；留 0 时按 priceInputPerM 计
    useOfficialPrice: true, // true = 优先用内置官方价格表（按模型 id 匹配）
    // 远程价格表 URL（可选）：指向一个自托管的 JSON（格式见 scripts/export-prices.mjs 产物）。
    // 启动时拉取一次，之后每 24 小时自动刷新（失败过 3 小时重试）；
    // 拉取全程异步、失败不清表 —— 对正常使用零影响。
    // 远程条目按模型 id 覆盖内置表，内置表其余条目仍是兜底。
    priceRemoteUrl: '',
    // 按模型单独设定的价格：{ [模型 id]: { in, out, cached } }
    // 优先级最高 —— 一旦这里有记录，就不再用内置官方表，也不受全局默认单价影响。
    // 改动只存在这里，不会回写内置价格表（src/model-prices.js）。
    modelPrices: {}
  },
  // 多提供商模型目录（设置页手动维护）
  providers: [],
  dshProviderKeys: {},   // providerId -> 真实 API Key（providers[] 里不再存明文 Key）
  providersSourceYaml: '',
  providersImported: true,
  // 情绪系统总开关（控制台「情绪」页顶部也有一键）。
  // 关掉 = 不再因群友发言调整情绪/心情，提示词里也不再注入心情与情绪标签。
  // 精力仍按钟点目标 + 聊天消耗运转；世界系统开启时还会叠加日历/账本修正。
  emotion: {
    enabled: true
  },
  // 本地 Jev 式决策旁路：包内 llama-server + 小 Qwen，只做结构化小决策，不当聊天主脑。
  // roles 能填哪些、各自管什么、判错后果 —— 以 local-jev.js 的 JEV_ROLES 目录为唯一出处
  // （控制台「设置 → 本地 Jev」按那份渲染，这里不再抄一遍清单，抄了就会对不上）。
  // ── 语音能力（阶段四·modules/voice；STT/TTS 各自独立开关，默认全关）──────
  voice: {
    stt: {
      enabled: false,               // 语音→文字（关=收语音只显示 [语音] 占位）
      channel: 'cloud',             // 'cloud' | 'local' | 'auto'（云端配了 key→云，否则本地）
      cloud: {                      // 云端默认：硅基流动 SenseVoiceSmall（平台永久免费模型，注册即得 key）
        baseUrl: 'https://api.siliconflow.cn/v1',
        apiKey: '',                 // 免费注册：https://cloud.siliconflow.cn
        model: 'FunAudioLLM/SenseVoiceSmall',
        timeoutMs: 30000
      },
      local: {                      // 本地档：sherpa-onnx + SenseVoice ONNX（模型自备）
        engine: 'sherpa-onnx',      // 'sherpa-onnx' | 'whisper-cli'（兼容 speech-to-text 插件路线）
        modelPath: '',              // 模型目录/文件（目录里要含 tokens.txt）；whisper-cli 时填 ggml
        cliPath: '',                // CLI 路径，留空 PATH 探测
        language: 'zh',
        tokens: ''                  // sherpa-onnx tokens.txt 路径；留空 = modelPath 指目录时自动取目录里的 tokens.txt
      },
      fallback: 'cloud-to-local'    // 云端失败回本地一次；'none' 不回退
    },
    tts: {
      enabled: false,               // 文字→语音回复
      mode: 'manual',               // 'manual'=模型经 send_voice 工具自主决定 | 'auto'=每条回复自动跟发
      channel: 'cloud',             // 'cloud'=edge-tts（免费无 key）| 'local'=Kokoro | 'auto'
      cloud: {                      // edge-tts：需 npm i msedge-tts（可选依赖，装了即用）
        voice: 'zh-CN-XiaoxiaoNeural',   // 中文音色：Xiaoxiao/Yunxi/Yunjian/Xiaoyi…
        rate: 0, volume: 0, pitch: 0,    // 百分比调节（-50 ~ +50）
        timeoutMs: 20000
      },
      local: {                      // 本地档：Kokoro-82M v1.1-zh via sherpa-onnx（模型自备）
        engine: 'kokoro',
        modelPath: '',
        cliPath: '',
        voice: 'zf_xiaoxiao'
      },
      encode: 'auto',               // 'auto'=silk-wasm 可用则 wav→silk，否则直发 | 'silk' | 'raw'
      autoCooldownMs: 30000,        // auto 模式冷却（防工具+自动双发）
      maxLength: 200,               // 单条朗读上限（字）
      fallback: 'cloud-to-local'
    }
  },
  localJev: {
    enabled: true,
    // 打开软件时就把本地模型拉起来（默认开）。关掉 = 回到「懒启动」：
    // 一直等到第一次真要用它才起进程，省内存，但第一问要多等几百毫秒。
    // ⚠️ 它只在 enabled=true 时有意义 —— enabled=false 时任何情况都不会起。
    startOnLaunch: true,
    // 例：不带 profile = 18080；profile 2 = 18090（每份实例错开 10 个端口）。
    // ⚠️ 2026-09-22：以前这里写死 18080，于是「复制一份目录再开第二个号」
    //   会两个实例抢同一个端口：第二份的 llama-server 起来就 EADDRINUSE 退出，
    //   UI 上只显示「未启动 / llama-server exit 1」，用户完全看不出是端口撞了。
    //   现在默认按实例号错开；而且 local-jev.js 起不来时还会**自动往后找空位**
    //   （18080→18081→…），所以就算配置里存着老值也不会两个人抢一个口。
    port: 18080 + Math.max(0, PROFILE_INDEX - 1) * 10,
    modelPath: 'models/Qwen3.5-0.8B-Q6_K.gguf',
    exePath: 'runtime/llama/llama-server.exe',
    modelId: 'qwen3.5-0.8b',
    ctxSize: 4096,
    maxTokens: 16,
    gpuLayers: 0,
    // 弃权阈值（标签分布概率）。实测扫出来的操作点（见 docs/Jev-优化记录.txt）：
    //   p≥0.6 且 margin≥1.0 → 0.8B 采信 74%、采信部分正确率 86%；
    //   旧规则（p≥0.75 一刀切、p 还是几何均值）是采信 33%、正确率 87% —— 同样准，覆盖面翻倍多。
    // 调高=更保守（更少采信），调低=更激进。两个阈值要一起看。
    minConfidence: 0.6,
    // 前二名标签的对数间隔下限。0.8B 的概率绝对值不太可靠，但「和次选差多少」更可靠：
    // margin 小的题几乎都是它自己也在犹豫的题。调 0 = 只按概率弃权。
    minMargin: 1.0,
    // 用 grammar 把输出**硬约束**成标签本身（YES|NO|是|否…）：
    // ① 再不会有「答了句废话 → 解析失败」的浪费；② 前缀 token 归属唯一，概率才算得准。
    useGrammar: true,
    // 在途请求上限（跟 llama-server --parallel 一致）；排队超过 maxQueue 直接弃权不拖主流程
    maxInflight: 2,
    maxQueue: 6,
    inputMaxChars: 160,
    judgeTimeoutMs: 2500,
    // 每条消息「前置门控」的总时间预算：到点就用手上判完的结果，没判完的当弃权
    gateBudgetMs: 1500,
    // 云端 Jev 通道：本地判不出来（弃权/失败）时，把这一题升级给云端小模型再判一次。
    // 真 Jev 的价值就在「有真概率」，所以云端通道默认关，开了也只接本地弃权的那部分。
    cloud: {
      enabled: false,
      baseUrl: '',            // OpenAI 兼容端点（不含 /chat/completions）
      apiKey: '',
      model: '',              // 例如 javis / gpt-4.1-nano / qwen-flash …
      timeoutMs: 6000,
      // 只在本地弃权、且本地标签概率低于这个值时升级（高于它说明本地只是差一点，不必花钱）
      upgradeBelow: 0.6,
      // 云端也必须过阈值；云端概率是真概率，通常可以比本地低一档
      minConfidence: 0.6,
      // ⚠️ 2026-09-22 新增：端点**不给 logprobs** 时的兜底采信概率。
      //   官方端点和不少中转不带概率，以前一律弃权 → 云端通道等于没用（用户报的"单独用云端不通"）。
      //   设成 0（默认）保持旧行为；设成 0.7 之类，则"答案命中标签"就按这个固定概率采信。
      //   代价：失去弃权能力（模型瞎猜时也会被当成结论），所以默认关，需要自己开。
      assumeP: 0,
      // 只让云端接管这几个角色（留空 = 全部角色都能升级到云端）。
      //   本地关掉后每一次窄域判定都会变成一次网络请求，建议收窄到真正需要的几个。
      roles: [],
      // 成本记账用（元 / 百万 token），只用于统计展示，不参与任何决策
      priceInPerM: 0,
      priceOutPerM: 0,
      maxPerMinute: 60        // 每分钟最多问几次，防手滑把云端判成烧钱机器
    },
    // 备用模型：2B 实验已下线。保留空结构兼容旧配置；modelPath 为空就不会起第二台。
    secondary: {
      enabled: false,
      modelPath: '',
      modelId: '',
      port: 18081,
      ctxSize: 4096,
      gpuLayers: 0,
      roles: []
    },
    // ── 视觉实例：同一个 0.8B + mmproj 投影文件，让包内 llama-server 能看图 ──
    // 用途：离线批量任务（目前只有「表情包备注」）。按需拉起、用完就关 ——
    //       CPU 上编码一张图约 1~3 秒，批量可接受，换来的是不烧云端 vision。
    // 注意：这只服务「看图写备注」这类离线活；实时回复链路不碰它。
    vision: {
      enabled: true,
      mmprojPath: 'models/mmproj-Qwen3.5-0.8B-BF16.gguf',
      // 与主实例一样按实例号错开（复制目录再开第二个号时不再撞 18085）
      port: 18085 + Math.max(0, PROFILE_INDEX - 1) * 10,
      ctxSize: 4096,
      gpuLayers: 0,
      maxTokens: 64
    },
    // 「概率响应」的新归属：档位 3（随机档）原本靠 Math.random 掷骰子决定回不回，
    // 现在改成让 Jev 读一眼这批消息再决定（可以插嘴/接话/不回），骰子只当兜底。
    //
    // 上面四条（minConfidence/minMargin/cooldownMs/maxPerHour）是**基准值**：
    // adaptive 关掉、或热度过低取不到时用它，也是「一键回到没有自适应」的开关点。
    replyChance: {
      // 档位 3（随机档）的「要不要响应」由谁判。两条路**互斥**，不再串联：
      // 'jev'         = 骰子退场。这批消息直接交给本地 Jev 读一眼，判「值不值得接一句」。
      //                 响应概率在新语义下 = 「插话意愿」：折算成 Jev 的判定门槛
      //                 **以及频率**（100% → 0.50 / 每小时 20 次；5% → 0.88 / 每小时 1 次）。
      //                 ⚠️ 2026-09-21 实测：只折算门槛是不够的 —— 0.8B 的 Jev 对明显该接的话
      //                 一律给 p≈0.99，门槛再高也照样通过，于是"意愿 2.9%"和"30%"没差别。
      //                 现在意愿同时决定 cooldownMs 与 maxPerHour（自适应只能放宽，不会压回意愿值）。
      // 'probability' = 保留纯骰子、不看内容。命中的那次插话同样要过下面的冷却/配额。
      mode: 'jev',
      enabled: true,
      // 这两条是「该不该插话」专用的，比全局那对更严：判 YES 是要真发话的。
      // minConfidence 是**基准值**：实际用的门槛还会被「插话意愿」与群活跃度各拉扯一次。
      minConfidence: 0.6,
      minMargin: 1.0,
      // 同会话两次「插话」之间的最小间隔（毫秒）：再想插也不能连着插，
      // 这一条比模型判定更能防止刷屏。两种 mode 都生效。
      cooldownMs: 90000,
      maxPerHour: 8,          // 每小时最多主动插话几次（0 = 不限。全局计数，不分群）
      // ── 不花钱的调优三件套（2026-09-21）──
      // prefilter：模型之前先过规则。「@某人/回复某条 且几乎没别的内容」「纯符号/表情」
      //   这两类在 9-19 的 2154 条真实决策点里是最大的错误源（@+没内容 → 接话率 69% vs 基线 92%），
      //   机器就能判定，不值得花一次推理。只往「不插嘴」方向短路，永远不会因为预过滤多说话。
      prefilter: true,
      // cloudVerify：本地判 YES 之后，云端再用同一道题复核一遍，双 YES 才真插嘴。
      //   现任老师（flash）bench 36/38，远高于 0.8B —— 让它当「二审」比换老师便宜得多。
      //   只在 cloud.enabled=true 时生效；云端挂了/超时按本地结果放行（不让复核卡死主链路）。
      cloudVerify: true,
      // doubleAsk：本地同题问两遍，两遍都 YES 才插嘴（不一致视为弃权）。
      //   热态 ~100ms/问，买一份自一致性。默认关：开了 cloudVerify 后通常用不着。
      doubleAsk: false,
      // ── 按群活跃度自适应 ──
      // 每天群里热度不一样：正刷屏时它频繁接话显得抢戏，只剩一两人说话时它又缩着不动。
      // 这里用「最近 windowMinutes 分钟的群消息」算出 heat∈[0,1]（见 local-jev.js
      // computeGroupHeat），再在 quiet↔busy 之间插值出本轮实际用的四条闸门参数。
      // 方向：heat 越高（越热闹）越克制，heat 越低（越冷清）越愿意接。
      // 整块可关：adaptive.enabled=false 立刻回到上面的基准值。
      //
      // ⚠️ 2026-09-21 调整冷清端：原来 quiet = {0.55 / 0.9 / 75s / 每小时 10 次}，
      //   等于"群里没人说话时它每 75 秒就能接一句、一小时二十句"，实测把冷清群变成它的独角戏：
      //   群 100000001 近 12 小时群友只发了 9 条，机器人自己发了 20 条（占全群 69%）。
      //   现在只比热闹端**略**愿意一点（0.72 < 0.88、180s < 300s、6 > 3），不再放飞。
      adaptive: {
        enabled: true,
        windowMinutes: 15,    // 用最近多久的群消息算热度
        // ⚠️ 2026-09-22：3 条/分太容易达到 —— 普通"有几个人在聊"的群 perMin 就能到 2~3，
        //   rateScore≈0.7~1.0 → heat 长期贴着热闹端 → 用户把接话意愿调到 90% 也被这层压住
        //   （表现为"设 90 回应率还是很低"）。放宽到 5 条/分，让普通群落在中间段。
        fullRate: 5,          // 达到这个「条/分钟」就算非常热闹（rateScore 记满）
        fullSpeakers: 5,      // 达到这个发言人数量就算非常热闹（speakerScore 记满）
        // 冷清端：群基本静默 / 只有一两个人在说 → 门槛略降、冷却略短
        quiet: { minConfidence: 0.72, minMargin: 1.8, cooldownMs: 180000, maxPerHour: 6 },
        // 热闹端：群里刷屏 → 建议门槛抬高、冷却拉长、每小时上限降低；
        // 最终仍不得比用户意愿更严，只在用户意愿之上多安静一些
        busy: { minConfidence: 0.88, minMargin: 2.6, cooldownMs: 300000, maxPerHour: 3 }
      }
    },
    // ── 连发合并（自适应防抖）交给本地 Jev 判 ──
    // 原来纯靠计时：一串话静默 burstSettleMs 就开跑。计时器看不出「这句说完了没有」。
    // 实测（test/burst-dataset.mjs 抽 448 个真实决策点，再用 test/jev-burst-lab.mjs 跑两批）：
    //   · 串内「总是等」只有 40%/47% 的时候是对的 —— 一半以上的等待是白等；
    //   · 小模型**确实**有信号但不是万能：它判「说完了」且概率 ≥0.8 时，
    //     两批合起来 25 次里 22 次真的是说完了（88%）；
    //     概率放到 ≥0.7 就掉到 75%（79 次里 59 次），更激进就别用了。
    //   · 「还在说 → 把等待拉长」这条路**实测不比瞎猜强**（命中 17%~32%，而"不拉长"本身
    //     就有 16%~46% 的底），所以只做缩短，不做延长 —— 见 orchestrator#refineBurstDelay。
    // 打开后：连发时（本来要干等 settle 那一下）先问一句「他这句说完了没」，
    //   说完了且够自信 → 等待缩回 wakeDelayMs；其它一律维持原计时。
    // 默认关 = 老行为。本地模型没启用/起不来/判不出来/超时 → 完全退回纯计时。
    // ⚠️ 判「说完了」而对方其实还有下句 = 抢话 + 多跑一次运行，所以这两个阈值故意偏保守。
    burstJudge: {
      enabled: false,
      // 越大越保守。0.8/1.0 = 实测 88% 准（两批合计 25 次里 3 次抢话）；
      // 0.7/0.8 = 75% 准但覆盖翻三倍。想更省事就往下调，想更稳就往上调。
      minConfidence: 0.8,
      minMargin: 1.0,
      timeoutMs: 2000        // 判不出来就退回计时，绝不拖主链路
    },
    // 默认启用的 Jev 角色。⚠️ 这是**唯一权威来源**：local-jev.js 的
    // DEFAULT_JEV_ROLES 引用这里，别再各自维护一份清单（之前两份不一致，
    // stickerPickGate/replyChanceGate 就这么漏掉过）。
    // 新增角色时改这里即可 —— migrateLocalJev 会把它补进老配置的 roles。
    roles: [
      // ⚠️ 2026-09-22：textOnlyJudge / unsentLinesJudge **都不进默认表**了。
      //   它们判的是同一类问题 ——「这段写在正文里的话，到底该不该发到群里」——
      //   而这是道**语义理解题**，不是窄域标签题，0.8B 干不了。
      //   · 09-21 只从默认表删了 unsentLinesJudge（理由见下），textOnlyJudge 留着；
      //   · 09-22 用 15 条真实存档样本做 A/B：本地 0.8B 判错 7 条（6 条旁白被放行 →
      //     会原样发进群，另 3 条该发的弃权），同一批云端裁判 0 错。
      //     实测漏出的旁白长这样：「先正经回示例用户的UI问题（他是管理员+死党），顺手损一句
      //     群里那个"扩展包"」「他刚醒，回了"醒了""你这鱼"，正好接上昨晚的夜猫子梗。」
      //     —— 这两条连 orchestrator 的 20 条旁白正则都拦不住。
      //   · 反向也错：模型写好的「草 这配置」「这张猫好欠，牙还漏出来了」被判 skip 丢掉，
      //     群里表现就是"叫他他不理"（号A 存档里 163 次 localJev 判 skip，正则只拦下 2 条）。
      //   · 去掉后两条兜底路径都自动回退云端裁判（salvage.js，提示词里有 7 条明确规则+示例）。
      //   · 角色仍留在 catalog 里，想开可以去设置页勾 —— 但正文裁判另受
      //     api.textOnlyJudgeLocal 管辖（默认 false，见上面那段注释）。
      // unsentLinesJudge 的原始理由（2026-09-21）：它和 textOnlyJudge 判的是同一件事，
      //   而 textOnlyJudgeLocal 早就因为"本地小模型裁判不准"默认关掉了 —— 这条却还在用
      //   0.8B 逐行判。实测代价（22:20 前后）：模型写好的「草 这猫的表情跟我看抽卡结果时
      //   一模一样」「dsh是谁 我不认识 别乱点兵」被判 NO 丢掉。
      'replyChanceGate',
      'memoryRecallGate',
      'imageCueGate',
      'imageWantsGate',
      'stickerAskGate',
      'emotionGate',
      'cueVerifyGate',
      'stickerPickGate',
      'impressionTypeGate',
      'impressionDupeGate',
      'memeGate',
      // 认图前置闸：自动附图前先判「这张图跟当前话题关系大不大」（2026-09-21 管理员要求）。
      // 不相关就不把图挂给主模型，免得它以为表情包在说自己、把话题扯到认图上。
      'imageRelevanceGate',
      // 语义卡准入：抽出来的卡入库前问一次「值不值得长期记」（后台巩固里跑，零延迟成本）。
      'cardGate',
      'memeSaveGate',
      'wikiGate',
      // 生活账本的主语判定（"我更饿了" vs "你饿不饿"）。低风险：判错只是多记/少记一条近况。
      'selfStateGate',
      // jev 级联 PR2·技能路由五分类（toolGate=jev2 时被调用；仅 rules/jev 档不受影响）。
      // 进默认表是为了 migrateLocalJev 能把它补进老配置的 roles（避免"勾了也不生效"的
      // 静默失效坑）；真正激活靠 api.toolGate='jev2'。
      'skillRouteGate'
      // ⚠️ 2026-09-21 实测后**不进默认表**：impressionPickGate（"落榜的那条印象跟现在这句话
      //   有关吗"）在 30 条真数据上只有 20/30，且错的方向是过度 YES（把"音乐口味""高达模型"
      //   判成跟"今天好累""睡了明天见"有关）。字面重合那部分已由 memory.js 的
      //   rankImpressions + topicOverlap 免费做掉（"推歌"那条就是这么捞回来的），
      //   语义那一档要开自己去勾 —— 角色仍留在 catalog 里可手动启用。
    ]
  },
  // 联网搜索（默认 Wikipedia MediaWiki；可选 Bing/DeepSeek/智谱/博查/百度/秘塔）
  webSearch: {
    enabled: true,
    searchUrl: 'https://cn.bing.com/search',
    // 搜图入口（search_images 工具 → 拿到能直接发的图片直链）
    imageSearchUrl: 'https://cn.bing.com/images/search',       // Bing 图搜（兜底）
    imageSearchUrlBaidu: 'https://image.baidu.com/search/acjson', // 百度图搜（默认主用：返回 JSON、中文相关度好）
    maxResults: 6,
    // web_fetch 每次返回的正文上限（字符）。中文 1 字符 ≈ 1 token，抓一页 2 万字
    // 就是一次 ¥0.01+ 的输入，比一次正常运行还贵——所以默认压到 8000。
    fetchMaxChars: 8000,
    // 搜索结果补读正文时每条网页截取的长度（字符，下限 200）。
    // 只对 Bing/自定义结果补读（原生搜索已带正文）。补读条数 autoReadPages 不在此设——
    // 它的默认值随 provider 变化（原生 0 / 其它 1），保持未配置时的自适应语义。
    autoReadChars: 600,
    // 热梗预查（api.hotMemeAutoPrefetch）的超时（毫秒，1500~15000 钳制；超时直接跳过预查不阻塞回复）。
    hotMemePrefetchTimeoutMs: 6000,
    // 外部知识源（MediaWiki）。模型用 external_lookup 查；实时新闻仍走 web_search。
    // sources 行格式：id | 显示名 | https://根地址
    wiki: {
      enabled: true,
      default: '',
      wikiSearchSource: '',
      sources: []
    },
    // 可选：'native' | 'bing' | 'deepseek' | 'zhipu' | 'bocha' | 'baidu' | 'metaso'
    // native = 用当前聊天模型的 enable_search（Qwen/DashScope 等），失败自动退回 Bing
    provider: 'native',
    // native 搜索：用聊天模型 enable_search；model 留空跟聊天模型，可填更轻的
    native: {
      model: '',
      timeoutMs: 18000,
      maxTokens: 350,
      // 百炼只认 standard/pro_ultra/pro/lite/pro_max/turbo/max（'fast' 会 400）
      strategy: 'standard'
    },
    deepseek: {
      apiKey: '',                     // 留空时回退环境变量 DEEPSEEK_API_KEY
      baseUrl: 'https://api.deepseek.com/responses',
      model: 'deepseek-v4-flash',     // Responses API 模型名：deepseek-v4-flash / deepseek-v4-pro
      timeoutMs: 60000
    },
    zhipu: {
      apiKey: '',                     // 留空时回退环境变量 ZHIPU_API_KEY
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4/web_search',
      engine: 'search_std',           // search_std(¥0.01) | search_pro(¥0.03) | search_pro_sogou | search_pro_quark
      count: 10,
      timeoutMs: 20000
    },
    bocha: {
      apiKey: '',                     // 留空时回退环境变量 BOCHA_API_KEY
      baseUrl: 'https://api.bochaai.com/v1/web-search',
      count: 10,
      timeoutMs: 20000
    },
    baidu: {
      apiKey: '',                     // 留空时回退环境变量 BAIDU_SEARCH_API_KEY
      baseUrl: 'https://qianfan.baidubce.com/v2/ai_search/web_search',
      count: 6,
      timeoutMs: 20000
    },
    metaso: {
      apiKey: '',                     // 留空时回退环境变量 METASO_API_KEY（无 key 也尝试官方免费额度）
      baseUrl: 'https://metaso.cn/api/open/v1/search',
      count: 6,
      timeoutMs: 20000
    },
    // 自定义搜索提供商列表（设置页可像添加模型提供商一样自行添加，可多个）。
    // 每项：{ id, name, type, baseUrl, apiKey, model, count, timeoutMs }
    // type: 'openai' = POST JSON 搜索接口；'bing' = GET 页面并按 b_algo 解析
    // 在「搜索提供方」下拉框里以 custom:<id> 的形式出现
    providers: [],
    // 自定义搜索服务（旧的单槽位，保留以兼容；新添加的建议用上面的 providers 数组）
    custom: {
      name: '',                       // 展示名，如"我的 SearXNG"
      type: 'openai',                 // 'openai' = OpenAI 风格的 JSON 搜索 API；'bing' = 抓 HTML 解析 b_algo
      baseUrl: '',                    // openai: 搜索端点；bing: 搜索页地址
      apiKey: '',                     // openai 类型需要（可选，视服务而定）
      model: '',                      // openai 类型可选： Responses API 风格的模型名
      count: 6,
      timeoutMs: 20000
    },
    // 免费 API 页：每天凌晨 4 点抓一次「免费额度 / 限时免费 / 即将开放」情报
    apiNews: {
      enabled: true,
      // 抓取源（留空 = 用内置：yangmao.ai / AI Pulse / linux.do）
      // 每项：{ id, name, type, url }；type: yangmao | xphub | discourse | rss
      sources: [],
      // 额外 RSS（默认空；综合资讯源会带进大量开源项目，按需再加）
      feeds: []
    },
    // web_search 的新闻头条源（默认空 = 用内置 RSS 列表）。每项 { name, url }。
    // 5 分钟缓存；任一条失败不影响其它条。
    newsFeeds: [],
    // B 站：只允许从指定收藏夹转发（AI 专用池）
    bilibiliCookie: '',
    // 收藏夹显示名：list_bili_fav 只认这个夹；空 = 不限制
    biliFavFolderName: 'B站收藏夹',
    // 可选：固定 mediaId（数字）。留空则按名字在收藏夹列表里搜
    biliFavMediaId: ''
  },
  // 安全例外（默认全部关闭）
  security: {
    allowPrivateImageHosts: false,          // true 时图片下载允许内网地址（仅本地测试/自建图床）
    allowPrivateFetchHosts: false,          // true 时 web_fetch / 站内搜索允许内网地址（自建站点用，风险自负）
    // 从网页下载图片再发到群里的开关（send_image 工具）
    imageSend: {
      enabled: true,                        // 总开关
      requirePreview: true,                 // true = 必须先"看一眼"（preview）才能发；关掉可省一轮调用
      maxPerRun: 2,                         // 一次运行最多发几张（防刷屏）
      maxPreviewsPerRun: 3,                 // 一次运行最多预览几张（视觉 token 也不便宜）
      maxBytesMB: 5,                        // 单张大小上限（QQ 侧太大容易被拒）
      // 锁定站点里的图视为可信来源，不再要求先"看一眼"（省一轮视觉 token）
      skipPreviewForLockedHosts: true
    },
    // 浏览锁定：把机器人的"上网范围"限制在指定站点内。
    // 生效后 web_fetch（抓网页）、send_image（下网图）、web_search（过滤站外结果）都只认这些域名；
    // 表情包和群聊图片（QQ 自己的图源）不受影响。
    browseLock: {
      enabled: false,
      domains: [],                          // 例：['zh.wikipedia.org', 'bilibili.com']（不带协议、可含子域）
      includeSubdomains: true,              // true = 连带 *.域名 一起放行
      // 站内搜索地址模板（含 {query} 占位符）。填了之后 web_search 直接抓这个地址，
      // 而不是去全网搜完再过滤。例：
      //   https://zh.wikipedia.org/w/index.php?search={query}
      //   https://www.someacg.top/search?keyword={query}
      // 留空则退回"给关键词自动加 site: 限定"。
      searchUrl: ''
    },
  },
  // SnowLuma / OneBot v11
  snowluma: {
    dir: '',                   // SnowLuma 程序目录；留空 = 自动探测项目内 ./snowluma
    autoLaunch: false,         // 应用启动时自动拉起 SnowLuma（未运行时）
    // ⚠️ 2026-09-22：默认地址按实例号错开（3001/3000 → 3011/3010 …）。
    //   以前写死 3001/3000，于是"复制一份目录开第二个号"会静默连上**第一个实例的**
    //   SnowLuma：两个机器人绑同一个 QQ 号，同一条消息被回两遍，而且不给任何告警。
    wsUrl: `ws://127.0.0.1:${3001 + Math.max(0, PROFILE_INDEX - 1) * 10}`,
    httpUrl: `http://127.0.0.1:${3000 + Math.max(0, PROFILE_INDEX - 1) * 10}`,
    accessToken: '',           // WebSocket 令牌
    httpAccessToken: '',       // HTTP API 令牌（SnowLuma 可与 WS 不同；留空沿用 accessToken）
    // ── 账号白名单：只允许这些 QQ 号挂在本机 SnowLuma 上 ──
    // 背景：SnowLuma 的"自动注入"（hookAutoLoad / SNOWLUMA_HOOK_AUTOLOAD）是
    // "发现一个 QQ 进程就注入一个"，很容易把管理员自己的号也挂上桥。
    // 填上允许的机器人号，程序会定时检查，发现白名单外的号就报警（默认并自动卸载）。
    // 留空 = 不检查（保持老行为）。
    accountWhitelist: [],
    autoUnhookStrangers: true, // true = 自动卸载白名单外的号；false = 只报警不动手
    webuiPassword: ''          // SnowLuma 网页密码（自动卸载要用它的 API；留空则只报警）
  },
  // ── 亢奋模式 ──
  // 只能手动切（情绪页那个按钮），**不会自动触发**。
  // 切过去后：模型/协议/人设卡一并换掉，情绪全部拉满，
  // 行为约束（说话风格、沉默规则、嘴软原则…）全部放开 —— 只有工具调用协议还照常生效。
  hypeMode: {
    enabled: false,
    model: '',                // 亢奋模式用的模型；空 = 跟随当前聊天模型
    restoreModel: '',         // 关亢奋后切回的模型；空 = 不切
    systemMode: 'hype',
    roleText: '',
    minMessages: 5,
    // 受保护 QQ（骂人/拍一拍硬锁）；发行版默认空 = 不锁
    protectedQQ: '',
    avatarOn: '',
    avatarOff: '',
    saved: null
  },
  // 人设与行为
  persona: {
    // 出厂默认人设 = 小鲸鱼（2026-09-26 起与源头项目 qq-bridge 的默认对齐：botName/展示名
    // 都叫小鲸鱼，角色卡用原版「DeepSeek 小鲸鱼」）。37（qag37）仍是内置可选人设，
    // 控制台「人设模板」里随时可切。⚠️ 已存在的用户配置不受影响：data/config.json 里
    // 显式写过的 persona 字段在 deepMerge 中永远优先于这里的出厂默认 —— 本默认值只影响
    // 全新初始化（首次启动落盘的那份默认配置）。
    botName: '小鲸鱼',
    selfNickname: '小鲸鱼',                 // 在群里的展示名（留空用 QQ 昵称）
    roleText: PERSONAS.xiaojingyu.text,     // 默认人设：小鲸鱼（DeepSeek 娘，混群 AI 群友）
    // true = 系统提示只发"精简版规则"（安全边界 + 工具协议 + 说话要点，约 800 字），
    // 通用长规则（反 AI 味/主体性/表情策略/QQ 场景…几千字）不再每轮重复发。
    // 小模型 / 短上下文（约 8k 窗口）建议打开；人格细节由角色设定卡承担。
    compactSystemPrompt: false,
    // system 组装风格：'full' = 原版分节约 6000 字；'cleaned' = 合并后约 1700 字（盲测接近）。
    // 角色卡仍在用户提示里，两种风格都不把 roleText 塞进 system（compactSystemPrompt 另说）。
    systemMode: 'lean',
    participation: 'medium',                // low | medium | high —— 参与度参考
    // 这些人的发言不参与情绪判定（填 QQ 号，例如群里别的 AI bot）。
    // 别的 bot 的旁白不该影响本体情绪。留空 = 全部参与。
    ignoreSenderIds: [],
    // 情绪计算性格档（九型人格，见 emotion-personality.js）：
    // t1…t9（完美/助人/成就/自我/理智/忠诚/活泼/挑战/和平）
    // 旧 id（extrovert_sunny 等）会自动映射，不用手工改
    emotionProfile: 't7',
    customRules: ''                         // 追加自定义规则（可选）
  },
  // 用户自定义人设库（保存在配置里，可在设置页添加/选择）
  customPersonas: [],
  // 接入白名单
  allow: { groups: [], private: [] },
  deny: { groups: [], private: [] },
  allowAllWhenEmpty: false,
  // 运行节奏
  wakeDelayMs: 2000,        // 空闲时收到消息到发起运行的防抖窗口（等连发聚成一批）
  // 连发合并：同一个会话里消息一条接一条时，把窗口拉长到 burstSettleMs（等这串话说完），
  // 但整串最多只等到 burstMaxWaitMs，避免有人一直刷屏导致机器人一直不说话。
  // 两者都为 0 = 关闭自适应，行为退回"固定 wakeDelayMs"。
  burstSettleMs: 15000,     // 连发时"最后一条之后再等多久"（要盖过常见的人手连发间隔 10~30s）
  burstMaxWaitMs: 30000,    // 一串连发从第一条算起最多等多久
  // ── 连发窗口按「这个人自己爱不爱连发」自适应（2026-09-20）──
  // 原来只有两个死值：新串首条 = wakeDelayMs、串内 = burstSettleMs，对所有人都一样。
  // 实测（test/burst-scope-lab.mjs，15.4 万条真实入站消息，剔除了自测夹具）：
  //   · 「他还会接着发吗」按人差得非常远：p10=10.6% / p50=29.6% / p90=51.0%，
  //     而且稳定（前半段估的值预测后半段 r=0.85）→ 可以照人给窗口。
  //   · 私聊首条最容易被低估：47.9% 会被接着说，而群里只有 25.8%。
  //   · 参数扫描（规则：平均等待不许增加，在此前提下打断率最低）选中下面的公式：
  //       窗口 = wakeDelayMs + (burstSettleMs − wakeDelayMs) × min(1, 连发倾向 / k)
  //     平均等待 9.40s ≤ 老行为 9.69s，打断率 11.7% < 11.8%；
  //     "说完就闭嘴"的人窗口从 9.1s 降到 5.6s，而打断率 8.4%→8.6%（几乎没变）。
  //   · 「按人算串」（换个说话的人就开新串）实测**不成立**：换了个人说之后
  //     "他还会接着说"是 38.0%，比同一人接着说（34.2%）还略高 —— 群里热闹时人人都连发。
  // 关掉它 = 完全回到老行为（首条短窗口 / 串内长窗口）。
  burstAdaptive: {
    enabled: true,
    k: 0.3,           // 连发倾向达到它就给满 burstSettleMs（越小越偏"多等一会"）
    minSamples: 6,    // 这个人的消息对数不够就用下面的类型先验
    priorPrivate: 0.45,
    priorGroup: 0.28
  },
  drainDelayMs: 1200,       // 一次运行结束后发现还有未读，到下一次运行的间隔
  maxConcurrentRuns: 2,     // 全局同时进行的 agent 运行数
  // 发送保护
  send: {
    splitLongAt: 0,         // 单条超过这么多字就按标点自动拆成几条（0 = 不拆；小模型建议 30~40）
    maxPerRun: 4,           // 单次运行最多发几条文字（防小模型一口气刷屏；0/空 = 不限制）
    minGapMs: 500,          // 相邻两条消息最小间隔
    maxGapMs: 1200,         // 最大间隔
    byLengthMs: 30,         // 按字数附加的间隔（毫秒/字）
    maxPerMinute: 80,
    maxPerHour: 500,
    // 拦下整段英文（无中文且 ≥3 个英文词）；允许夹在中文里的英文词
    blockPureEnglish: true,
    // 拦下「我是AI/我只是程序」式的自我暴露声明（默认开）。
    // 角色卡要求入戏，但小模型偶尔会把内心 OS 当正文发出去。
    blockAiSelfClaim: true,
    // 拦下残缺的 JSON/工具参数碎片（默认开）：模型把 {"messages": …} 这类
    // 本该当参数的东西当正文发出来时丢弃并提示它重发。
    blockJsonFragments: true,
    hardSplitAt: 4000,      // QQ 硬限制切分（0 = 不限制）
    biliJsonCard: false,    // B站视频 json 卡；true 时用 video 卡。仍「过期/升级后使用」就保持 false（只发封面+链接）
    // 发送前删掉词两边的【】「」[]方块装饰与句尾挂的方块（默认关）。
    // 本地小模型学舌时爱挂这些；提示词里也会同步加一条硬要求。
    tidyBrackets: false,
    // 发送前剥掉 emoji（默认关）。
    stripEmoji: false
  },
  // 疯狂星期四：每周四固定点直发文案（不走 LLM、不带人设）
  // groupIds 留空 = 不向任何群发送（不会回落到 allow.groups）
  crazyThursday: {
    enabled: true,
    times: ['07:00', '13:00', '19:00'], // 一天三次，间隔 6 小时
    groupIds: []                       // 必须显式填群号；空 = 本轮不发
  },
  // 主动开话题（可选）
  proactive: {
    enabled: false,
    checkIntervalMinMs: 1800000,
    checkIntervalMaxMs: 5400000,
    idleThresholdMs: 1800000,   // 群里静默多久才算"冷场"
    probability: 0.25,
    // ── 私聊主动 ──
    // 冷场：和群聊共用检查循环；阈值/概率可单独覆盖
    privateIdleEnabled: false,
    privateIdleThresholdMs: 3600000,
    privateIdleProbability: 0.25,
    // 定时：独立轻量循环（约每 30s 对一次钟），到点唤醒对应私聊
    privateScheduleEnabled: false,
    // [{ chatId: "10000003", time: "21:00", days: [1,2,3,4,5] }]
    // days: 0=周日…6=周六；省略或空数组 = 每天
    privateSchedules: []
  },
  // 表情包
  sticker: {
    enabled: true,
    // 提示词里列几张表情（一半常用、一半轮换）。列得多选择多，但也多花 token：
    // 每张约 45 token，12 张 ≈ 540 token。
    promptMaxStickers: 12,
    // 轮换批次的更换周期（分钟）。库越大越该短一点，否则没露过脸的表情永远轮不到。
    rotatePeriodMin: 60,
    collectEnabled: true,
    maxCollectPerHour: 10,
    // 发表情包的积极程度（0=不鼓励 1=偶尔 2=较积极 3=很积极）。
    // 这是在提示词层面引导模型"更愿意用表情回应"，不是强制每次都发 ——
    // 强制会显得机械，引导才能让它在合适的时候自然用上。
    encourage: 1,
    // 运行结束后按概率自动挑一张表情补发（默认关：这是"额外一次模型调用"，
    // 模型只答"挑哪张"，max_tokens 24，小模型也扛得住）。
    // probability：命中概率（0=等于关）；cooldownMs：同一会话两连发的最小间隔。
    autoPick: { enabled: false, probability: 0.35, cooldownMs: 120000 },
    // 刚发过的表情先冷却（分钟，0=不冷却）：避免老是那几张反复出现。
    cooldownMin: 0,
    // 提示词「常用区」钉住几张（null=自动按库大小取约 3/4；调小=更多表情有机会轮到，0=纯轮换）。
    keepFamiliar: null
  },
  // 存储
  store: {
    // 单群 JSON 最大保留条数。**0 = 不限制**。
    // 用户明确要求取消上限（原为 2000）。配套措施：
    //   - 前端存档页已分页（首屏 500 条、滚动追加 200 条），不会因数据多而卡
    //   - store 的 #trim 在 maxPerChat<=0 时直接跳过
    // 注意：单群文件会随时间增长，磁盘占用请自行留意。
    maxMessagesPerChat: 0,
    // ── 落盘热段条数（2026-09-22）──
    // 最近这么多条留在 messages/<key>.json（每次收发消息都要重写它，所以越小越快）；
    // 更老的原文归档到 messages-cold/<key>.NNNNN.json（每片 5000 条，写满即冻结）。
    // 内存里以及所有读取路径（模型上下文 / 翻页 / 存档页 / 记忆巩固）始终是全量，
    // 这个值只决定"哪一段走慢写"——所以调它不会改变任何功能行为。
    // 实测依据：20,000 条 ≈ 34ms，线性外推 172,998 条约 290ms；3000 条约 5ms。
    // 0 = 不分层（退回单文件全量写，仅用于排障对照）。
    hotMessagesPerChat: 3000,
    // ── 上下文读取档位（决定本次唤醒读多少条历史）──
    // 档位是"累积生效"的：选 4 档时 1/2/3 档也都生效，按 4→3→2→1 顺序检查，
    // 第一个命中的决定读取条数。这个设置替代了原来的 pastStateLimit 固定值。
    contextTier: 4,             // 1=仅艾特 2=+关键词 3=+随机 4=全读
    atCount: 20,                // 档1：机器人被艾特时读 w 条
    keywordCount: 15,           // 档2：命中关键词时读 x 条
    keywords: [],               // 档2 的关键词表
    randomPercent: 10,          // 档3：y% 概率
    randomCount: 8,             // 档3：命中时读 z 条
    allCount: 80,               // 档4：读全部（上限）
    // ── 私聊单独设置 ──
    // 上面这一套 = 群聊参数。privateOverride=false 时私聊沿用群聊（老行为，向后兼容）；
    // 打开后私聊改读 private 里的同名字段（缺哪个字段就回落到群聊那份）。
    // 为什么需要：私聊一般不会 @ 机器人、也未必命中关键词，若和群聊共用
    // "3 档 + 随机概率"，1v1 的消息会被概率性地标记已读、直接不回。
    privateOverride: false,
    private: {
      contextSliderPos: 100,
      contextTier: 4,
      atCount: 20,
      keywordCount: 15,
      keywords: [],
      randomPercent: 100,
      randomCount: 8,
      allCount: 80
    },
    keepSessionFiles: 0,        // 保留最近多少个会话记录文件；**0 = 不限制**（原为 300）
    // 近 24h 本地摘要（可选，可按 群聊默认 / 私聊 / 单群 覆盖）：
    // 本地扫存档压成短文本；注入长度被 maxChars 封顶，大群不会因消息多而多花 token。
    // 默认关。字段也可出现在 store.private 与 store.perChat[chatKey] 里。
    recent24hDigest: {
      enabled: false,
      hours: 24,
      maxChars: 240,
      maxItems: 8
    },
    // ── 历史冷藏（缓存友好）──
    // 过去状态拆成「冷藏段（粘住切点，少变）+ 热段（新消息追加）」。
    // 显式缓存时冷藏进 user stable，热段进 volatile → system+冷藏跨运行可命中。
    historyCold: {
      enabled: true,
      warmCount: 12
    },
    // ── 单个群/好友单独设置响应档位 ──
    // key = chatKey（"group:群号" / "private:QQ号"），value = 与群聊同名的参数块
    // （contextSliderPos/contextTier/randomPercent/atCount/keywordCount/keywords/randomCount/allCount）。
    // 优先级：perChat[chatKey] > 私聊单独设置（privateOverride）> 群聊默认。
    // 没配的会话完全跟随默认，老配置不受影响。
    perChat: {}
  },
  // 记忆自动整理：条数超阈值且距上次超过冷却时间时，在运行结束后后台合并/去重/删过时
  memory: {
    consolidateEnabled: true,
    // 默认一周一次：一天一次删太多，用户明确嫌狠
    consolidateMinIntervalMs: 7 * 24 * 60 * 60 * 1000,
    // 全群印象总数超过多少条才触发自动整理（默认 4，与 Orchestrator 类常量一致）。
    // 人少的群建议调低，否则印象攒不起来、自动整理一直不触发。
    consolidateMinImpressions: 4,
    // ⚠️ 2026-09-22：8 → 12，而且它的含义是"超过这么多条才触发整理"，
    //   **不是"每人最多只能有这么多条"**（印象本身不设上限，只有 60 条安全阀）。
    //   原来整理提示词写"最多保留 5/8 条"，用户手动记到十几条就被自动压回去，
    //   看起来就是"印象到一定条数就加不进去了"。
    maxImpressionsPerMember: 12,
    useChatModel: true,                   // true = 整理模型跟随聊天模型；false = 使用下方专用模型
    provider: '',                         // 专用模型所属提供商 id（useChatModel=false 时生效）
    model: '',                            // 专用模型 id（useChatModel=false 时生效）
    semanticCardsViaLlm: true             // 巩固时用模型抽 1~2 张语义卡（弱模型可关）
  },
  // 扩展底座（skills/ + plugins/）：开关唯一来源 config.skills[id].enabled
  // 这里放的是 0.3.1 官方、你魔改版核心没有的扩展；与已内建功能同名的未装
  skills: {
    'ban-state': { enabled: true },
    'image-compat': { enabled: true },
    'speaker-identity': { enabled: true },
    'thinking-adapters': { enabled: true },
    // ── 2026-09-22 从 0.4 移植过来的扩展（默认开关按"是否与核心重复"定）──
    // 重复的关掉：核心已经有同样功能，开着只会双份注入/双份工具
    //   conversation-memory：它的 before-llm-messages 钩子会再调一次 buildArchitectureInject
    //     （语义卡/跨轮/待办/跨群），而核心本来就注入了一遍 → 提示词里会出现两份
    //   memory-recall / knowledge-memes / sticker-annotate / reverse-image：核心已有
    //     memory_search/archive、memory_meme_*、表情备注、identify_image 反向搜图
    'conversation-memory': { enabled: false },
    'memory-recall': { enabled: false },
    'knowledge-memes': { enabled: false },
    'sticker-annotate': { enabled: false },
    'reverse-image': { enabled: false },
    // 不重复、按需开的（依赖外部东西，默认关着，用户自己填好再开）
    'account-pool': { enabled: false },   // 多账号轮询：核心 llm.js 已接 llm.endpoint-pick
    'media-download': { enabled: false }, // 下载 B站/抖音，需要 yt-dlp/ffmpeg
    'speech-to-text': { enabled: false }, // 语音转文字，需要 whisper-cli + 模型
    'owner-identity': { enabled: false }, // 主人识别：填了主人 QQ 才有效
    'reply-safety': { enabled: false },   // 核心已内建 reply-recovery/inline-calls/salvage
    // 自包含、装上就能用的工具类（默认开）
    'video-frames': { enabled: true },
    calculator: { enabled: true },
    'text-tools': { enabled: true },
    'weather-query': { enabled: true },
    'random-image': { enabled: false },
    'image-generate': { enabled: false }
  },
  extensions: {
    // 监听 skills/ plugins/ 变化自动重载（等价于落地 JS 会被执行；共享机建议关）
    hotReload: true
  },
  // 知识库三件套：内部（梗库）/ 外部（wiki）/ 图库（与表情分开）
  knowledge: {
    internal: { enabled: true },          // 群内梗/结论，模型 memory_meme_*
    external: {
      enabled: true,                      // 触发词命中时 external_lookup 查 wiki
      triggerWords: [
        '百科', '设定', 'wiki', '萌娘', '维基',
        '角色是谁', '是什么设定', '背景故事', '出自哪里'
      ]
    },
    images: {
      enabled: true,                      // 独立图库（可发图/形象）
      autoCueSelf: true                   // 「你长什么样」等触发时提示去图库
    }
  },
  // 桌面端/控制台
  server: {
    port: DEFAULT_CONSOLE_PORT,
    instanceName: '',         // 界面账号标签页上显示的名字；留空 = 主账号 / 账号 N
    token: '',                // 留空 = 只监听 127.0.0.1
    autoStart: false,         // 开机自启（仅 Electron 桌面端生效）
    autoStartPeer: true,      // 存在 data-2/ 时，桌面端一起拉起第二个账号的实例（界面顶部出现账号标签页）
    closeToTray: true         // 点关闭 = 最小化到托盘
  },
  ui: {
    // 主题：'dark' | 'light' | 'system'（system = 跟随系统偏好）。
    // 前端以 localStorage 为准做到即时生效，这里只是跨设备/重装后保留用。
    theme: 'dark',
    // 自定义配色（覆盖 --bg / --accent 等；空字符串 = 用主题默认）
    customBg: '',
    customBg2: '',
    customAccent: '',
    customText: '',
    customToolAccent: '',
    customThemeId: '',        // 当前使用的自定义/预设主题 id（themes/ 或内置 mech-orange）
    mechFx: true,             // 机甲主题是否启用特效（发光/角标）；可关
    brightness: 100,          // 界面亮度 70~130，100=默认；两号桌面互通
    uiScale: 100,             // 界面缩放 % 80~200，100=默认；卡牌/字体/间距整页等比
    showVision: true,         // 模型目录显示图片输入能力徽标
    refreshMs: 15000,         // 界面轮询间隔
    hideApiNews: false,       // 隐藏顶部「免费API」页签（不影响后台抓取）
    // 顶栏"账号标签"（本机多实例一键切换）。
    // 2026-09-22 的来回与最终形态：
    //   · 先出过"莫名多按钮/点了黑屏" → 我一度把开关默认**关**掉并落盘成 `ui.instanceTabs: false`；
    //   · 用户随后要"两个号合并在一个窗口里切" → 恢复默认开，但**只列同版本的实例**；
    //   · 问题来了：旧配置里已经存着 `instanceTabs: false`，默认值再改也盖不过它 ——
    //     用户那边"还是合并不了"。所以这个开关**改名**：老键当没看见，新键语义是"隐藏"。
    hideInstanceTabs: false,
    // ── 顶部工具栏自定义（设置 → 桌面端 → 界面）──
    // navOrder / topOrder：显示顺序（id 数组）；空 = 用出厂默认顺序
    // navHidden / topHidden：要隐藏的 id；隐藏后仍可通过设置恢复
    navOrder: [],
    navHidden: [],
    topOrder: [],
    topHidden: []
  }
};

function deepMerge(base, override) {
  if (override === null || override === undefined) return structuredClone(base);
  if (typeof base !== 'object' || base === null || Array.isArray(base)) return structuredClone(override);
  const out = Array.isArray(base) ? [...base] : { ...base };
  for (const [key, value] of Object.entries(override)) {
    // 整体替换约定：{ __replace__: X } → 该键直接用 X，不做递归合并。
    // 用于映射型字段（如 api.modelPrices）需要"删掉旧键"的场景 ——
    // 普通深合并传 {} 是删不掉已有键的。
    if (value && typeof value === 'object' && !Array.isArray(value) && '__replace__' in value) {
      out[key] = structuredClone(value.__replace__);
      continue;
    }
    if (value && typeof value === 'object' && !Array.isArray(value) && base[key] && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else if (value !== undefined) {
      out[key] = structuredClone(value);
    }
  }
  return out;
}

/**
 * 本地 Jev 的一次性迁移（2026-09-19）。
 *
 * 为什么需要：老配置把「概率 ≥0.75 一刀切」写死在 data/config.json 里，
 * 而实测那样 0.8B 会弃权 16/24（六成题白问），并且把 narrationGate 开着
 * 小模型会把该发的话误判成独白。默认值改了不等于用户会变，
 * 所以这里对**落盘过的**老配置做一次原地升级；迁移完打标记，只跑一次。
 *
 * 迁移内容：
 *   minConfidence 0.75 → 0.5，补上 minMargin 0.6，打开 useGrammar
 *   接管表里摘掉 narrationGate、补上 replyChanceGate（替代档位 3 的掷骰子）
 *   补 replyChance / cloud 两个新配置块
 * 用户之后在设置页怎么改都不会再被覆盖（有标记）。
 */
function migrateLocalJev(cfg) {
  const j = cfg?.localJev;
  if (!j || typeof j !== 'object') return cfg;
  // 新角色要能自动出现在已有配置里：用 rolesKnown 记录「用户见过的角色集」。
  // 没见过的新角色 → 补进 roles（跟随默认开启）并记入 rolesKnown；
  // 用户后来手动关掉的（在 rolesKnown 里但不在 roles 里）→ 尊重其选择，不再自动打开。
  // ⚠️ 这段必须在下面的 migrated 早退**之前**跑：每次加载都要执行，
  //    否则以后每加一个角色都得再发一次一次性迁移（本次就栽过 ——
  //    impressionTypeGate 加了却全是 role-off）。
  if (Array.isArray(j.roles)) {
    const known = new Set(Array.isArray(j.rolesKnown) && j.rolesKnown.length ? j.rolesKnown : j.roles);
    let rolesChanged = false;
    for (const r of DEFAULT_CONFIG.localJev.roles) {
      if (known.has(r)) continue;
      known.add(r);
      if (!j.roles.includes(r)) { j.roles.push(r); rolesChanged = true; }
    }
    if (rolesChanged || j.rolesKnown === undefined) j.rolesKnown = [...known];
  }
  // ── 2026-09-22：把本地 0.8B 从「正文该不该发」这道题上真正摘下来 ──
  // 上面那段只**补**新角色、从不删旧角色，所以 09-21 把 unsentLinesJudge 从默认表删掉
  // 对老配置**毫无作用**：老配置的 roles 是显式数组（deepMerge 不合并数组），
  // 两个号上它一直还在跑 —— 这正是"改了默认值却没生效"的典型坑。
  // 这里用一次性标记真删；两个角色仍写进 rolesKnown（= 用户见过），
  // 于是不会被自动补回来，UI 角色表（localJevRoleCatalog 基于 JEV_ROLES 全表）照旧列出，
  // 想恢复去设置页勾一下即可 —— 标记一旦随任意一次保存落盘，这段就不再拦，
  // 用户勾回来的选择会被尊重（只有手动改 config.json / 还原旧备份才会被再摘一次）。
  // 实测依据见 DEFAULT_CONFIG.localJev.roles 上面那段注释。
  if (j.jevTextJudge !== '2026-09-22') {
    const dropped = ['textOnlyJudge', 'unsentLinesJudge'];
    if (Array.isArray(j.roles)) j.roles = j.roles.filter((r) => !dropped.includes(r));
    const knownSet = new Set(Array.isArray(j.rolesKnown) ? j.rolesKnown : []);
    for (const r of dropped) knownSet.add(r);
    j.rolesKnown = [...knownSet];
    j.jevTextJudge = '2026-09-22';
  }
  if (j.migrated === '2026-09-19') return cfg;
  if (Number(j.minConfidence) === 0.75) j.minConfidence = DEFAULT_CONFIG.localJev.minConfidence;
  if (j.minMargin === undefined) j.minMargin = DEFAULT_CONFIG.localJev.minMargin;
  if (j.useGrammar === undefined) j.useGrammar = true;
  if (Array.isArray(j.roles)) {
    const set = new Set(j.roles.filter((r) => r !== 'narrationGate'));
    set.add('replyChanceGate');
    j.roles = [...set];
  }
  j.replyChance = { ...DEFAULT_CONFIG.localJev.replyChance, ...(j.replyChance || {}) };
  j.cloud = { ...DEFAULT_CONFIG.localJev.cloud, ...(j.cloud || {}) };
  j.migrated = '2026-09-19';
  return cfg;
}

/**
 * 分条发送节奏的一次性迁移（2026-09-22）。
 *
 * 为什么必须写成迁移、而不是只改 DEFAULT_CONFIG.send 里的三个数字：
 *   `loadConfig()` 是 `deepMerge(DEFAULT_CONFIG, 存档配置)`，**存档值优先**。
 *   两个号的 config.json 里 send 是显式的 minGapMs:1800 / maxGapMs:4500 / byLengthMs:100，
 *   只改默认值对它们是**零作用** —— 和上面 unsentLinesJudge「改了默认值却没生效」是同一个坑。
 *
 * 实测依据（号A 09-22 当天 n=129 会话）：
 *   模型返回到全部发完还要 4.5s（p50），其中主要就是这里的每条气泡间隔
 *   （`#gap` 算出来约 1.8~3.8s/条）；`send.maxPerMinute=10` 满了还要再 sleep ≤6s。
 *   用户反馈"开始之后很久不说话"。新值 500/1200/30 → 每条约 0.5~1.1s，
 *   仍然看得出是分条发的，但不再把一轮回复拖成半分钟。
 *
 * 只动这三个数：限流（maxPerMinute/maxPerHour）、切段（splitLongAt/hardSplitAt）、
 * 过滤（blockPureEnglish）一个都不碰。
 * 标记落盘后（任意一次设置页保存）不再执行，用户之后在设置页改多少就是多少。
 */
function migrateSendPacing(cfg) {
  const s = cfg?.send;
  if (!s || typeof s !== 'object') return cfg;
  if (s.pacingMigrated === '2026-09-22') return cfg;
  s.minGapMs = DEFAULT_CONFIG.send.minGapMs;
  s.maxGapMs = DEFAULT_CONFIG.send.maxGapMs;
  s.byLengthMs = DEFAULT_CONFIG.send.byLengthMs;
  s.pacingMigrated = '2026-09-22';
  return cfg;
}

/**
 * 缓存相关的一次性对齐（2026-09-22）。
 *
 * 背景：默认值 vs 线上实例长期不一致 —— 线上跑着 `cacheMode:'adaptive'` +
 * 保温 6 棒/30 分钟，而代码默认是 `null`（被 resolveCacheMode 判成 off）+
 * 3 棒/10 分钟。结果是"同一个包，新装的实例和用了两周的实例命中率差一大截"，
 * 而且新装实例根本不打标记、也没有第二道静态块。
 *
 * 规则（只动"从没被显式设置过"的字段）：
 *   · cacheMode 缺失/null 且没开旧开关 explicitCache → 补 'adaptive'
 *   · 保温参数逐个缺失才补默认（**不覆盖**用户自己调过的值）
 * 迁移标记写在 api.cacheMigrated 上，只跑一次。
 */
function migrateCacheDefaults(cfg) {
  const api = cfg?.api;
  if (!api || typeof api !== 'object') return cfg;
  if (api.cacheMigrated === '2026-09-22') return cfg;
  const d = DEFAULT_CONFIG.api;
  if (api.cacheMode === undefined || api.cacheMode === null) {
    api.cacheMode = api.explicitCache === true ? 'explicit' : d.cacheMode;
  }
  const ka = api.cacheKeepAlive;
  if (!ka || typeof ka !== 'object') {
    api.cacheKeepAlive = { ...d.cacheKeepAlive };
  } else {
    for (const [k, v] of Object.entries(d.cacheKeepAlive)) {
      if (ka[k] === undefined || ka[k] === null) ka[k] = v;
    }
  }
  api.cacheMigrated = '2026-09-22';
  return cfg;
}

export function loadConfig() {
  try {
    let text = fs.readFileSync(CONFIG_FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    const cfg = migrateCacheDefaults(migrateSendPacing(migrateLocalJev(deepMerge(DEFAULT_CONFIG, parsed))));
    seedDesktopPrefsIfNeeded(cfg);
    return applyDesktopPrefs(cfg);
  } catch (error) {
    // 读不到 / 解析失败：内存里用默认值继续跑（行为跟以前一样），
    // 但**首次运行**顺手把默认配置落盘一份 —— 见下面的注释。
    const cfg = structuredClone(DEFAULT_CONFIG);
    try {
      if (!fs.existsSync(CONFIG_FILE)) {
        // ⚠️ 2026-09-22：以前"没配置"时只在内存里用默认值，`data/config.json` 要等用户
        //   改过第一个设置才出现。后果有三个：
        //     ① 新用户找不到"数据在哪、配置在哪"，文档说"首次启动生成"却看不见；
        //     ② 想手改配置（比如直接改端口/加白名单）得先猜文件名和字段名；
        //     ③ 第二个实例的自动拉起要求 `data-2/config.json` 已存在 → 永远拉不起来。
        //   现在首次启动就写一份完整的默认配置（带注释字段名，JSON 不支持注释就靠字段名自解释）。
        fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
        fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, 'utf8');
        console.log(`[config] 首次运行：已生成默认配置 ${CONFIG_FILE}（直接编辑这个文件也能改设置）`);
      } else {
        console.warn(`[config] 配置读取失败，本次用默认值运行（原文件未改动）：${error?.message ?? error}`);
      }
    } catch { /* 落盘失败不影响运行 */ }
    seedDesktopPrefsIfNeeded(cfg);
    return applyDesktopPrefs(cfg);
  }
}

let currentConfig = null;
let runtimeMode = false;
let saveTimers = new Map();

/**
 * 取当前生效配置（未初始化时从磁盘读）。
 * 桌面端互通键从 desktop-prefs.json 盖一层：号A 改了主题/工具栏，号B 能读到同一份。
 * setRuntimeConfig 注入的 mock 不盖，避免自测被磁盘偏好污染。
 */
export function getConfig() {
  if (!currentConfig) {
    currentConfig = loadConfig();
    runtimeMode = false;
  } else if (!runtimeMode) {
    applyDesktopPrefs(currentConfig);
  }
  return currentConfig;
}

/** 更新并持久化配置（浅合并到当前值；patch 里传对象字段则整体替换该字段）。 */
export function updateConfig(patch) {
  currentConfig = deepMerge(getConfig(), patch);

  // ── 响应档位：以滑条位置为唯一真相，派生 tier 与随机概率 ──
  // 前端只负责上报滑条位置（contextSliderPos），档位和概率一律由这里换算。
  // 这样即使前端算错、或者有人直接调接口只传位置，配置也不会自相矛盾。
  // 群聊与私聊各有一份（私聊那份只在 privateOverride=true 时生效），
  // 两份都按各自滑条位置派生，互不干扰。
  const deriveTier = (block) => {
    if (!block || typeof block !== 'object') return;
    const posRaw = block.contextSliderPos;
    if (posRaw === undefined || posRaw === null) return;
    const { tier, randomPercent } = sliderToTier(posRaw);
    block.contextTier = tier;
    block.randomPercent = randomPercent;
  };
  deriveTier(currentConfig?.store);
  deriveTier(currentConfig?.store?.private);
  // 单个会话的覆盖参数（store.perChat[chatKey]）同样按各自的滑条位置派生，
  // 与群聊/私聊那两份互不干扰。
  for (const block of Object.values(currentConfig?.store?.perChat || {})) deriveTier(block);

  // 桌面端互通：patch 动到 ui 或 autoStart/closeToTray 时同步写共享文件
  const touchedDesktop =
    (patch.ui && typeof patch.ui === 'object') ||
    (patch.server && DESKTOP_SERVER_KEYS.some((k) => k in patch.server));
  if (touchedDesktop) writeDesktopPrefsFile(currentConfig);

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${CONFIG_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(currentConfig, null, 2), 'utf8');
  fs.renameSync(tmp, CONFIG_FILE);
  return currentConfig;
}

/** 从磁盘强制重读配置（热重启用）。失败则保留当前内存态。 */
export function reloadConfig() {
  try {
    currentConfig = loadConfig();
    runtimeMode = false;
  } catch (error) {
    console.error('[config] 重载失败，保留当前配置:', error?.message ?? error);
  }
  return currentConfig;
}

/** 内存态改动（不落盘）——用于运行期覆盖（如自测注入 mock）。 */
export function setRuntimeConfig(cfg) {
  currentConfig = cfg;
  runtimeMode = true;
}

/** 防抖保存：高频小改动合并写盘。 */
export function scheduleConfigSave() {
  clearTimeout(saveTimers.get('cfg'));
  saveTimers.set('cfg', setTimeout(() => {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${CONFIG_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(getConfig(), null, 2), 'utf8');
      fs.renameSync(tmp, CONFIG_FILE);
    } catch (error) {
      console.error('[config] 保存失败:', error);
    }
  }, 400));
}
