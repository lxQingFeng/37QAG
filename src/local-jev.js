// 本地 Jev 式决策旁路：包内 llama-server + 小 Qwen GGUF，只吐 Choice / Noul / Score 风格答案。
// 对齐 TypeSafe「Jev」的形状：不生成文本，只做一次一个的高频窄域判定（真 Jev 走云端 $0.042/M、70-500ms；
// 这里用本地模型替它，省钱但能力差一档，所以加了「标签概率 + 前二名间隔」两道闸）。
// 主聊天模型不受影响，仍走 OpenAI 兼容主链路；本模块任何失败都必须让调用方回退旧逻辑。
//
// 关键约定（调参前先看这里）：
// ① 输出用 grammar 硬约束成标签，前缀 token 归属唯一，标签概率才可靠。
// ② 概率按「标签前缀分组求和」还原分布，并回传前二名对数间隔 margin（别只取首 token）。
// ③ 弃权：概率与 margin 双闸（默认 p≥0.6 且 margin≥1.0），不够就当没判出来。
// ④ narrationGate 净有害，默认不接管；正文该不该发交给 textOnlyJudge 更稳。
// ⑤ cueVerifyGate 三分类用中文单字「梗/怼/无」，小模型更果断。
// ⑥ 时延（CPU + 0.8B Q6_K）：前缀未命中约 500ms/问，命中后约 100ms/问。
// ⑦ 「该不该插嘴」的闸门随群活跃度浮动（computeGroupHeat → resolveReplyChanceParams）：
//    群里刷屏时更克制、只剩一两人说话时更愿意接。默认只是把阈值挪一挪，
//    不动 instruction —— 该角色的提示词实测「加条件 = 净有害」（见 JEV_GATE_SPECS 里的实测记录）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
// ⚠️ 这份清单引用 config.js 的 DEFAULT_CONFIG.localJev.roles（唯一权威来源），
//    别在这里再抄一份 —— 之前两份不一致，stickerPickGate/replyChanceGate 就漏掉过。
import { getConfig, ROOT, DEFAULT_CONFIG } from './config.js';

const DEFAULT_PORT = 18080;
const DEFAULT_MODEL_REL = 'models/Qwen3.5-0.8B-Q6_K.gguf';
// 跨平台（阶段二）：Windows 便携包带 llama-server.exe；Linux/macOS 发行包带无后缀
// llama-server。默认值按平台选；用户 cfg.exePath 仍可覆盖。找不到默认名时还会
// 自动试另一个名字（发行包只带了对应平台二进制时不至于误报缺失）。
const DEFAULT_EXE_REL = process.platform === 'win32' ? 'runtime/llama/llama-server.exe' : 'runtime/llama/llama-server';
const DEFAULT_MAX_INFLIGHT = 2;
const DEFAULT_MAX_QUEUE = 6;

// 角色目录：id → 中文名 + 干什么 + 判错后果。UI 直接渲染这张表。
export const JEV_ROLES = {
  textOnlyJudge: {
    cn: '正文该不该发（say/skip）',
    desc: '协议失败时判断这段正文能不能直接发进群，还是只是内心戏。⚠️ 2026-09-22 起默认不接管（见 config.js）；'
      + '另外这条旁路受 api.textOnlyJudgeLocal 管辖（默认 false），光在这里勾上不会生效。',
    risk: '⚠️ 实测不低（旧文案写"不会误发"是错的）：15 条真实存档样本判错 7 条 —— 6 条旁白被判 say、'
      + '会原样发进群（「先正经回示例用户的UI问题，顺手损一句」「他刚醒，回了"醒了"…短句回。」这类），'
      + '连 orchestrator 的 20 条旁白正则都拦不住；云端裁判同批 0 错。'
  },
  unsentLinesJudge: {
    cn: '逐行草稿筛选（say/skip）',
    desc: '模型写了一堆行却没调工具时，逐行挑出真正该发的那几句。⚠️ 2026-09-22 起默认不接管，'
      + '开了也是拿 0.8B 逐行判，代价见 risk。',
    risk: '⚠️ 双向都会错：判成 say 会真发出去（旁白泄漏），判成 skip 会把写好的话丢掉。'
      + '实测号A 存档里它判 skip 163 次，而编排层旁白正则只拦下 2 条 → 159 次是它独自否决的；'
      + '连它自己 few-shot 里标着 say 的「草 没上农你发这干嘛」都会被判 skip。'
      + '弃权时会被调用方整批退回云端裁判重判（判得准，但这次本地推理等于白跑）。'
  },
  toolNeedGate: {
    cn: '这轮要不要查资料/看图（工具门控）',
    desc: '规则分不清的短消息，问一次「这轮要不要查资料、看图或翻记录」。判 CHAT 就只给发言类工具'
      + '（省三类信息工具的 schema token，也降低小模型乱选工具的概率）。需要 api.toolGate=jev 才生效。',
    risk: '低：判错顶多多带或少带几个工具 schema，不影响能否发言'
  },
  replyChanceGate: {
    cn: '这轮该不该插一句（插嘴/接话）',
    desc: '档位 3 原本靠掷骰子决定回不回。现在改成：没人叫它时问一次「这轮值不值得凑上去接一句」，YES 才算响应。还会按群活跃度自适应——群里正刷屏时门槛抬高少插嘴，只剩一两个人说话时门槛放低多接话。',
    risk: '中：判 YES 会主动发言，所以另有冷却 + 每小时次数上限兜底（这两条也随活跃度一起调）'
  },
  memoryRecallGate: {
    cn: '要不要翻长期记忆',
    desc: '词表没命中时，再问一次「这是在问很久以前的旧事吗」。',
    risk: '低：只会多查一次记忆，不会漏查'
  },
  imageCueGate: {
    cn: '要不要 cue 自己的形象照',
    desc: '判断对方是不是在要机器人「长什么样 / 自拍」。',
    risk: '低：只会多注入一条图库提示'
  },
  imageWantsGate: {
    cn: '要不要真去找图',
    desc: '正则 wantsImage 没抓到时的补漏：对方是不是在催机器人发图。',
    risk: '中：判 YES 会硬要求模型搜图，可能多发表情之外的图。⚠️ 实测误判方向是「评价被当成索取」：「这张壁纸挺好看的」判 YES（p=0.92）。'
  },
  stickerAskGate: {
    cn: '是不是在要表情包',
    desc: '对方明确要表情时把自动配表情概率拉满，不等随机数。',
    risk: '低：还有冷却和库存兜底'
  },
  emotionGate: {
    cn: '情绪判定（每轮）',
    desc: '每轮结束都问本地小模型：群友这句话属于哪类情绪/意图。不依赖大模型 finish 自评。夸赞类另有兜底：词表命中 + 这句喊了它名字（没 @ 也算），且模型判「praise 过半」时单独放行（0.8B 对夸赞普遍没把握，实测占比 0.69 却被概率闸压到弃权）。',
    risk: '低：只影响情绪/好感漂移，不发消息。阈值也最低（0.45，其他角色 0.6）'
  },
  cueVerifyGate: {
    cn: '接梗/玩闹标签校验',
    desc: '模型自己标了「接梗/玩闹」但原文词表不认时，让 Jev 复核一次（梗/怼/无）。',
    risk: '低：只影响情绪/好感漂移，不发消息'
  },
  narrationGate: {
    cn: '内心独白否决（实测不准，默认不接管）',
    desc: '裁判说「发」之后再问一句「这是说给自己听的话吗」，是就否决。',
    risk: '高：小模型会把该发的话误判成独白 → 默认关，要开自己勾'
  },
  stickerPickGate: {
    cn: '自动配表情挑哪张',
    desc: '从候选表情里选序号。原来这一步是花云端 600 token 只为了挑一个数字。',
    risk: '低：判错只是配错一张表情，且有序号范围校验。⚠️ 实测它倾向回 0（=这次不配表情），两次场景测试都弃权 —— 宁可不发，所以它的价值主要是「省下云端那 600 token」，不是「总能配上」。'
  },
  impressionTypeGate: {
    cn: '印象 6 类分类（只补空）',
    desc: 'finish 没给 type、正则也猜不出时，问一次 identity/preference/edge/style/event/attitude。',
    risk: '低：只影响印象的归档分组，不改内容；学 emotionGate 只补空不覆盖'
  },
  impressionDupeGate: {
    cn: '印象语义去重',
    desc: '一键清理时，两条印象字面不同但意思接近，问一次「是不是同一件事」再合并。',
    risk: '⚠️ 判 NO 只是少合并一条（保守方向，不丢内容）；但判 YES 就是真丢信息 —— 实测「甲：喜欢猫 ｜ 乙：喜欢狗」被判成同一件事（p=0.69，同句式不同对象），合并会吃掉其中一条。只在字面已相近时才问，但「同句式」正是字面相近，所以这个方向要留意。'
  },
  selfStateGate: {
    cn: '这句在说它自己吗（吃/睡/累/忙）',
    desc: '生活账本从它自己嘴里抓"我吃了/我困了"这类状态。正则分不清"我更饿了"和"你这刚醒就问我吃啥，不先关心自己饿不饿"——后者是在说对方。只在主语含糊时才问这一次。',
    risk: '低：判错只会多记或少记一条近况（下一次说话就覆盖了），不会发任何消息出去；弃权就回退到正则。'
  },
  memeGate: {
    cn: '脑内闪过的梗该不该用',
    desc: '梗库按字面/标签捞出候选梗后，再问一次「这条梗现在接得上吗」，明确说 NO 就不闪，避免硬套梗。',
    risk: '低：弃权或超时最多是照旧多闪一条梗，不会多发话；只有明确 NO 才丢'
  },
  memeSceneGate: {
    cn: '现在这个场合适不适合玩梗',
    desc: '召回一放宽（字面/标签/备注/常用轮换四通道，见 memes.js#cueMemesWide），捞上来的就不再是"字面撞上"而是"可能沾边"。注入前先问一次「这个场合能不能玩梗」：闲聊/接梗/互相调侃 = YES；说正事、求助排查、情绪低落、吵架 = NO。判 NO 就这一轮一条都不闪，省掉逐条复核那几次调用。',
    risk: '中低：判 NO 只是这一轮不闪梗（回到没有梗库时的行为），不会少发话也不会多说话；判 YES 之后每条梗还要过 memeGate 逐条复核。弃权一律按"照旧"处理。'
  },
  memeFitGate: {
    cn: '这条梗投出去会不会尬',
    desc: '放宽召回配套的**严格**逐条门：问的不是"话题沾不沾边"，而是"这句现在发出去会被当成什么"。顺势能接、像熟人随口补一句 = YES；只是话题沾边但用出去莫名/答非所问/像背台词/群友自己刚说的就是这句 = NO。',
    risk: '中低：判 NO 只是这轮不闪这一条，模型照常回话，不会少发消息。⚠️ 这道门跟 memeGate 的取向相反（memeGate 是"宁可多闪不可错杀"，因为老召回只给字面命中的候选）——放宽召回后候选里大半是垃圾，实测老门放行 81%，等于没判，所以这道门取"拿不准就 NO"。'
  },
  imageRelevanceGate: {
    cn: '这张表情包跟当前话题有关吗',
    desc: '自动附图之前先判一眼「群友刚发的图跟刚才在聊的事关系大不大」。判 UNRELATED 就不把图挂给主模型，并明说"别去认图"，免得它以为表情包在说自己、把话题扯到认图上。',
    risk: '中低：判错（该认的图没认）只是少看一张图，主模型仍能看到"[图片]"占位和文字；有人明确说"看看/这是啥/分析下"时**不问闸**、直接附图。弃权按"附图"处理。'
  },
  cardGate: {
    cn: '这条值不值得记成长期记忆',
    desc: '巩固时抽出的语义卡（计划/事实）入库前，问一次「值不值得长期记」。判 SKIP 就不入库；判 PLAN/FACT 用它的类型覆盖模型的判断。正则只会看"有没有明天/要去"，把「睡吧 明天还得早起」也当计划。',
    risk: '低：跑在后台巩固流程里（不占回复链路）；弃权或本地不可用时按原判入库，只会回到旧行为。'
  },
  impressionPickGate: {
    cn: '这条印象跟当前话题有关吗（实测不准，默认不接管）',
    desc: '【印象】每人是按新鲜度取前 2 条注入的，结果常有"学历/职业"顶掉"推歌只推古典摇滚OST"这种事（实测：群友点名要歌，机器人内心独白写着"印象里只写了态度，没具体记音乐口味"，于是随便推了一首）。落榜的那条在丢弃前问一次本地 Jev：跟对方现在这句话有关吗，有关就换进去。'
      + '⚠️ 实测（30 条真数据 + 人工期望）只有 **20/30**，错的方向是过度 YES —— 把「音乐推荐口味」「喜欢高达拼装」判成跟「今天好累啊」「睡了 明天见」有关。'
      + '所以默认不勾：字面重合的部分已经由 memory.js 的 rankImpressions/topicOverlap 做掉（"推歌"那条就是这么捞回来的，零延迟零成本）；勾上它只是为了补"字面不重合但语义相关"（「今天好累」↔「深夜易焦虑」），代价是偶尔换错一条。',
    risk: '低：只影响注入哪几条印象（名额不变、条数不变、不发消息）；弃权/超时保持原样。'
  },
  memeSaveGate: {
    cn: '这条值不值得存进梗库',
    desc: '模型调 memory_meme_save 时先问一次「这是以后还能复用的群内梗/结论吗」，明确 NO 就不入库，保住梗库质量。',
    risk: '低：弃权照存；明确 NO 只是这一条不存，模型以后还能再存'
  },
  wikiGate: {
    cn: '是不是在问外部设定（补触发词漏网）',
    desc: '触发词表没命中时补问一次「这句是不是在问作品/角色/设定的外部知识」，是就补一条 external_lookup 提示。只加不减。',
    risk: '低：只会多一条查百科的提示，不会拦住别的；判错最多白查一次'
  }
};

// 默认只开低风险 + 已验证的形状；高风险的留给用户手动勾。
// narrationGate 实测净有害（见文件头 ④），从默认表摘掉但保留可手动开。
// 单一来源：config.js 的 DEFAULT_CONFIG.localJev.roles（见上方说明）
export const DEFAULT_JEV_ROLES = [...DEFAULT_CONFIG.localJev.roles];

export function localJevRoleCatalog() {
  const configured = getConfig().localJev?.roles;
  const active = new Set(Array.isArray(configured) && configured.length ? configured : DEFAULT_JEV_ROLES);
  return Object.entries(JEV_ROLES).map(([id, m]) => ({ id, ...m, onByDefault: DEFAULT_JEV_ROLES.includes(id), active: active.has(id) }));
}

function absUnderRoot(p) {
  if (!p) return '';
  const s = String(p);
  return path.isAbsolute(s) ? s : path.join(ROOT, s);
}

// ── 模型实例：primary（默认 0.8B）/ secondary（已下线，空路径即不启用）/ vision（看图）──
// vision = 同一个 0.8B + mmproj，离线批量看图（表情包备注），用完就关。
const INSTANCES = new Map();
const INSTANCE_KEYS = ['primary', 'secondary', 'vision'];
function inst(key = 'primary') {
  const k = INSTANCE_KEYS.includes(key) ? key : 'primary';
  if (!INSTANCES.has(k)) INSTANCES.set(k, { proc: null, starting: null, lastError: '', ready: false });
  return INSTANCES.get(k);
}

/** 备用模型是否配置且可用（已下线；modelPath 为空则永远 false）。 */
export function secondaryJevEnabled() {
  const s = getConfig().localJev?.secondary || {};
  if (s.enabled !== true) return false;
  return !!s.modelPath;
}

/** 该角色是否交给备用模型。 */
export function roleUsesSecondary(role) {
  if (!secondaryJevEnabled()) return false;
  const roles = getConfig().localJev?.secondary?.roles;
  const list = Array.isArray(roles) && roles.length ? roles : [];
  return list.includes(String(role || ''));
}

function instanceCfg(key = 'primary') {
  const cfg = getConfig().localJev || {};
  // 视觉实例：文本模型与 primary 同一个，只是多挂一个 mmproj 投影文件
  if (key === 'vision') {
    const v = cfg.vision || {};
    return {
      ...cfg,
      mmprojPath: v.mmprojPath,
      port: v.port ?? 18085,
      ctxSize: v.ctxSize || cfg.ctxSize,
      gpuLayers: v.gpuLayers ?? cfg.gpuLayers,
      maxTokens: v.maxTokens || 64
    };
  }
  if (key !== 'secondary') return cfg;
  const s = cfg.secondary || {};
  return {
    ...cfg,
    modelPath: s.modelPath,
    modelId: s.modelId,
    port: s.port ?? (Number(cfg.port) || DEFAULT_PORT) + 1,
    ctxSize: s.ctxSize || cfg.ctxSize,
    gpuLayers: s.gpuLayers ?? cfg.gpuLayers
  };
}

export function localJevPaths(key = 'primary') {
  const cfg = instanceCfg(key);
  const exe = absUnderRoot(cfg.exePath || DEFAULT_EXE_REL) || (() => {
    // 默认名不存在时试另一个平台的默认名（发行包常见形态）
    const alt = absUnderRoot(process.platform === 'win32' ? 'runtime/llama/llama-server' : 'runtime/llama/llama-server.exe');
    return fs.existsSync(alt) ? alt : absUnderRoot(cfg.exePath || DEFAULT_EXE_REL);
  })();
  const model = absUnderRoot(cfg.modelPath || DEFAULT_MODEL_REL);
  const port = Number(cfg.port) || DEFAULT_PORT;
  const mmproj = key === 'vision' && cfg.mmprojPath ? absUnderRoot(cfg.mmprojPath) : '';

  return { exe, model, port, mmproj, baseUrl: `http://127.0.0.1:${port}/v1` };
}

export function localJevAvailable(key = 'primary') {
  const { exe, model } = localJevPaths(key);
  return fs.existsSync(exe) && fs.existsSync(model);
}

export function localJevEnabled() {
  const cfg = getConfig().localJev || {};
  // 自测/CI 一律不走本地模型（config.json 也应写 enabled:false，这里双保险）
  if (process.env.QQ_AGENT_DISABLE_LOCAL_JEV === '1') return false;
  return cfg.enabled === true && localJevAvailable();
}

function activeRoles() {
  const roles = getConfig().localJev?.roles;
  return Array.isArray(roles) && roles.length ? roles : DEFAULT_JEV_ROLES;
}

export function localJevStatus() {
  const { exe, model, port, baseUrl } = localJevPaths();
  const p = inst('primary');
  const s = inst('secondary');
  const sPaths = localJevPaths('secondary');
  const j = getConfig().localJev || {};
  return {
    enabled: cfgEnabled(),
    available: localJevAvailable(),
    running: !!p.proc && !p.proc.killed,
    ready: p.ready,
    port,
    baseUrl,
    exe,
    model,
    modelFile: path.basename(model),
    exeExists: fs.existsSync(exe),
    modelExists: fs.existsSync(model),
    pid: p.proc?.pid ?? null,
    lastError: p.lastError,
    minConfidence: Number(j.minConfidence ?? 0.6),
    minMargin: Number(j.minMargin ?? 1.0),
    useGrammar: j.useGrammar !== false,
    replyChance: { ...(j.replyChance || {}) },
    cloud: cloudJevStatus(),
    // 备用模型（已下线）：仅在手动配了 modelPath 时才会显示状态
    secondary: {
      enabled: j.secondary?.enabled === true,
      modelPath: j.secondary?.modelPath || '',
      modelId: j.secondary?.modelId || '',
      port: sPaths.port,
      baseUrl: sPaths.baseUrl,
      roles: Array.isArray(j.secondary?.roles) ? j.secondary.roles : [],
      available: localJevAvailable('secondary'),
      running: !!s.proc && !s.proc.killed,
      ready: s.ready,
      pid: s.proc?.pid ?? null,
      lastError: s.lastError
    },
    roles: activeRoles(),
    rolesCatalog: localJevRoleCatalog(),
    modelsFound: findLocalModels(),
    stats: localJevStats()
  };
}

/** models/ 下可用的 GGUF（换模型时给 UI 直接选，不用手敲路径）。 */
function findLocalModels() {
  const dir = absUnderRoot('models');
  try {
    return fs.readdirSync(dir)
      .filter((f) => /\.gguf$/i.test(f))
      .map((f) => {
        let size = 0;
        try { size = fs.statSync(path.join(dir, f)).size; } catch { /* ignore */ }
        return { file: `models/${f}`, name: f, bytes: size, active: f === path.basename(localJevPaths().model) };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

function cfgEnabled() {
  return getConfig().localJev?.enabled === true;
}

async function probeReady(baseUrl, timeoutMs = 1500) {
  try {
    const res = await fetch(`${baseUrl}/models`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return false;
    const data = await res.json().catch(() => ({}));
    return Array.isArray(data?.data) && data.data.length > 0;
  } catch {
    return false;
  }
}

/** 启动包内 llama-server（幂等）。失败不抛，返回 { ok, reason }。 */
export async function ensureLocalJev({ log = () => {}, key = 'primary' } = {}) {
  const cfg = getConfig().localJev || {};
  if (process.env.QQ_AGENT_DISABLE_LOCAL_JEV === '1') return { ok: false, reason: 'disabled-by-env' };
  if (cfg.enabled !== true) return { ok: false, reason: 'disabled' };
  const st = inst(key);
  const icfg = instanceCfg(key);
  const { exe, model, port, mmproj, baseUrl } = localJevPaths(key);
  if (!fs.existsSync(exe)) return { ok: false, reason: `缺少 ${exe}` };
  if (!fs.existsSync(model)) return { ok: false, reason: `缺少 ${model}` };
  if (key === 'vision' && (!mmproj || !fs.existsSync(mmproj))) {
    return { ok: false, reason: `缺少 mmproj：${mmproj || '(未配置 localJev.vision.mmprojPath)'}` };
  }

  if (await probeReady(baseUrl)) {
    st.ready = true;
    st.lastError = '';
    return { ok: true, reused: true, baseUrl };
  }
  if (st.starting) return st.starting;

  st.starting = (async () => {
    try {
      if (st.proc && st.proc.exitCode == null) {
        try { st.proc.kill(); } catch { /* ignore */ }
        st.proc = null;
      }
      const parallel = Math.max(1, Math.min(4, Number(icfg.maxInflight) || DEFAULT_MAX_INFLIGHT));
      // 视觉实例要写一句话备注（≤30 字 + 收尾），8 个 token 根本不够
      const nPredict = key === 'vision'
        ? Math.max(32, Number(icfg.maxTokens) || 64)
        : Math.max(8, Number(icfg.maxTokens) || 16);
      const args = [
        '--model', model,
        '--host', '127.0.0.1',
        '--port', String(port),
        '--ctx-size', String(Number(icfg.ctxSize) || 4096),
        '--parallel', String(parallel),
        '--n-predict', String(nPredict),
        '--no-warmup'
      ];
      if (Number(icfg.gpuLayers) > 0) args.push('-ngl', String(Number(icfg.gpuLayers)));
      if (key === 'vision' && mmproj) args.push('--mmproj', mmproj);
      log(`[localJev] 启动 llama-server :${port} ← ${path.basename(model)}${key === 'vision' ? ' +mmproj' : ''} (parallel=${parallel}${key === 'primary' ? '' : key === 'vision' ? ', 视觉' : ', 备用'})`);
      st.proc = spawn(exe, args, {
        cwd: path.dirname(exe),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      st.lastError = '';
      st.ready = false;
      st.proc.stdout?.on('data', () => { /* quiet */ });
      st.proc.stderr?.on('data', (buf) => {
        const s = String(buf || '');
        if (/error|failed|exception/i.test(s)) st.lastError = s.trim().slice(0, 300);
      });
      st.proc.on('exit', (code, signal) => {
        st.proc = null;
        st.ready = false;
        if (code != null && code !== 0) st.lastError = `llama-server exit ${code}`;
        else if (signal) st.lastError = `llama-server signal ${signal}`;
        log(`[localJev] llama-server 退出 code=${code} signal=${signal}`);
      });
      st.proc.on('error', (error) => {
        st.proc = null;
        st.ready = false;
        st.lastError = String(error?.message ?? error);
        log(`[localJev] 启动失败: ${st.lastError}`);
      });

      for (let i = 0; i < 40; i++) {
        if (await probeReady(baseUrl, 1200)) {
          st.ready = true;
          st.lastError = '';
          // /v1/models 通了不等于模型进了内存：CPU 上第一批真实请求会踩冷启动（实测 4B 前 4 问全超时）。
          // 打一发极小的补全把权重页进来，第一次判定才不会拖到主流程超时。
          await fetch(`${baseUrl}/completion`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: String(icfg.modelId || ''), prompt: 'OK', max_tokens: 2, temperature: 0 }),
            signal: AbortSignal.timeout(60000)
          }).catch(() => {});
          log(`[localJev] 就绪 ${baseUrl}`);
          return { ok: true, baseUrl };
        }
        if (!st.proc) break;
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!st.ready) {
        st.lastError = st.lastError || 'llama-server 启动超时';
        log(`[localJev] 未就绪: ${st.lastError}`);
        return { ok: false, reason: st.lastError };
      }
      return { ok: true, baseUrl };
    } finally {
      st.starting = null;
    }
  })();
  return st.starting;
}

/** 停掉一台（不传 key = 两台都停）。 */
export async function stopLocalJev(key = null) {
  const keys = key ? [key] : ['primary', 'secondary', 'vision'];
  for (const k of keys) {
    const st = inst(k);
    st.ready = false;
    if (st.proc) {
      try { st.proc.kill(); } catch { /* ignore */ }
      st.proc = null;
    }
  }
}

// ── 视觉实例：离线批量看图（目前只有「表情包备注」）──────────────────────
// 为什么不走云端：这是批处理，一次几十张，慢点无所谓；省的是一整批 vision 调用。
// 为什么单独开实例：不把 mmproj 挂到常驻的 primary 上 —— 多 200MB 常驻内存，
// 还会拖慢每个判定请求的启动，而看图一天用不了几次。

/** 配置了视觉实例且文件都在。 */
export function localVisionEnabled() {
  // 和 localJevEnabled 同一道总闸：自测/CI 一律禁用本地模型
  if (process.env.QQ_AGENT_DISABLE_LOCAL_JEV === '1') return false;
  const v = getConfig().localJev?.vision || {};
  return v.enabled === true && !!v.mmprojPath;
}

/** 真正可用（exe / 模型 / mmproj 三个文件都在）。annotateMissing 用这个决定走本地还是云端。 */
export function localVisionAvailable() {
  if (!localVisionEnabled()) return false;
  const { exe, model, mmproj } = localJevPaths('vision');
  return fs.existsSync(exe) && fs.existsSync(model) && !!mmproj && fs.existsSync(mmproj);
}

export async function ensureLocalVision() {
  if (!localVisionEnabled()) return { ok: false, reason: 'vision-disabled-or-missing' };
  return ensureLocalJev({ key: 'vision' });
}

/** 发一次多模态请求。返回结构与 llm.js 的 chatCompletion 对齐（res.message.content）。 */
export async function localVisionChat({
  messages, temperature = 0.2, maxTokens = 64, timeoutMs = 120000
} = {}) {
  const ready = await ensureLocalVision();
  if (!ready || ready.ok === false) throw new Error(`本地视觉起不来：${ready?.reason || 'unknown'}`);
  const { baseUrl } = localJevPaths('vision');
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages, temperature, max_tokens: maxTokens, stream: false }),
    signal: AbortSignal.timeout(timeoutMs)
  });
  if (!res.ok) throw new Error(`本地视觉 HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  return { message: { content: String(data?.choices?.[0]?.message?.content ?? '') } };
}

/** 批量任务结束后关掉视觉实例，释放那 800MB 常驻内存。 */
export async function stopLocalVision() {
  return stopLocalJev('vision');
}

// ── 并发闸 + 统计 ─────────────────────────────────────────────
// 本地小模型最贵的是 prefill（CPU 实测 ~1600 token 要 7.8s），所以：
//   1) 提示词一律压到 ~100 token 内（few-shot 只留 5-6 条例子、正文截断）；
//   2) 在途请求限流（跟 --parallel 对齐），排队超预算直接弃权，绝不把主流程拖慢。

const stats = new Map();   // role → { n, ms, abstain, err, yes }
let inflight = 0;
const waiters = [];

function noteStat(role, { ms = 0, abstain = false, error = false, hit = false } = {}) {
  const k = String(role || 'anon');
  const s = stats.get(k) || { n: 0, ms: 0, abstain: 0, err: 0, yes: 0 };
  s.n += 1;
  s.ms += Number(ms) || 0;
  if (abstain) s.abstain += 1;
  if (error) s.err += 1;
  if (hit) s.yes += 1;
  stats.set(k, s);
}

export function localJevStats() {
  const out = {};
  for (const [k, s] of stats.entries()) {
    out[k] = { n: s.n, avgMs: s.n ? Math.round(s.ms / s.n) : 0, abstain: s.abstain, error: s.err, positive: s.yes };
  }
  return out;
}

export function resetLocalJevStats() {
  stats.clear();
}

function abortReason(signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason.message || 'cancelled';
  return String(reason || 'cancelled');
}

function requestSignal(timeoutMs, signal = null) {
  const timeout = AbortSignal.timeout(Math.max(1, Number(timeoutMs) || 4000));
  if (!signal) return timeout;
  return AbortSignal.any([timeout, signal]);
}

async function acquireSlot(signal = null) {
  const cfg = getConfig().localJev || {};
  const cap = Math.max(1, Number(cfg.maxInflight) || DEFAULT_MAX_INFLIGHT);
  const maxQueue = Math.max(cap, Number(cfg.maxQueue) || DEFAULT_MAX_QUEUE);
  if (inflight + waiters.length >= maxQueue) return null;   // 太挤：直接弃权，别排队
  if (inflight >= cap) {
    await new Promise((resolve) => {
      const waiter = { resolve };
      waiter.release = () => {
        const i = waiters.indexOf(waiter);
        if (i >= 0) waiters.splice(i, 1);
        if (signal) signal.removeEventListener('abort', waiter.cancel);
        resolve();
      };
      waiter.cancel = () => waiter.release();
      waiters.push(waiter);
      if (signal) signal.addEventListener('abort', waiter.cancel, { once: true });
    });
  }
  if (signal?.aborted) return null;
  inflight += 1;
  let done = false;
  return () => {
    if (done) return;
    done = true;
    inflight -= 1;
    const next = waiters.shift();
    if (next) next.release();
  };
}

// ── 决策底座：一次一个原子问句，返回标签分布 + 前二名间隔 ───────────

function normLabel(s) {
  return String(s ?? '').trim().toUpperCase().replace(/[。.!！:：\s]+/g, ' ').trim();
}

function matchLabel(raw, labels) {
  const t = normLabel(raw);
  if (!t) return null;
  for (const l of labels) {
    if (t === normLabel(l)) return l;
  }
  for (const l of labels) {
    const L = normLabel(l);
    if (t === L || t.startsWith(`${L} `) || t.includes(L)) return l;
  }
  return null;
}

/**
 * 标签同义词表：小模型经常回中文、或大小写/单复数变体。
 * 以前这些一律落进「无法解析 → 弃权」，白花一次本地推理；现在归一化后照用。
 * 注意只放**不会跟别的标签混淆**的说法（比如 NO 里不放「别」）。
 */
const LABEL_SYNONYMS = {
  YES: ['YES', 'Yes', 'yes', 'Y', '是', '是的', '对', '对的', '嗯', '要', '有'],
  NO: ['NO', 'No', 'no', 'N', '否', '不是', '不', '没有', '没', '不用'],
  say: ['say', 'Say', 'SAY', '发', '说'],
  skip: ['skip', 'Skip', 'SKIP', '跳过', '不发', '别发'],
  none: ['none', 'None', 'NONE'],
  meme: ['meme', 'Meme'],
  tease: ['tease', 'Tease'],
  reply: ['reply', 'Reply'],
  join: ['join', 'Join'],
  skip_reply: ['skip', 'Skip']
};

function synonymsOf(label) {
  const key = String(label);
  const list = LABEL_SYNONYMS[key];
  return list ? [...new Set([key, ...list])] : [key];
}

/**
 * 一个 token 归哪个标签。
 *
 * 规则（按优先级）：
 *   1. 与某个标签/同义词完全相同（忽略大小写）→ full
 *   2. 是某个标签的严格前缀 → prefix，但**只有归属唯一时**才算
 *      （'m' 在 {meme, tease, none} 里只可能是 meme 的开头；'s' 在 {say, skip} 里
 *       谁都可能是 → 直接丢掉这一票，不硬塞给任何一个）
 * 归不到 → null。
 *
 * 这条「唯一归属」规则是修 bug 修出来的：旧代码只取首 token 做软最大，
 * 遇到 meme 被切成 'm'+'eme' 时会把票投给同为单 token 的 'none'，
 * 实测出现过「内容是 meme、概率算出 none=0.99」的完全颠倒。
 */
function classifyToken(token, labels) {
  const raw = String(token ?? '').trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  const owned = [];
  for (const label of labels) {
    for (const syn of synonymsOf(label)) {
      const s = String(syn).toLowerCase();
      if (!s) continue;
      if (s === low) { owned.push({ label, kind: 'full' }); break; }
      if (s.startsWith(low)) owned.push({ label, kind: 'prefix' });
    }
  }
  if (!owned.length) return null;
  const full = owned.find((h) => h.kind === 'full');
  if (full) return full;
  const uniq = [...new Set(owned.map((h) => h.label))];
  if (uniq.length === 1) return { label: uniq[0], kind: 'prefix' };
  return null;
}

/**
 * 从 logprobs 还原**标签分布**。
 *
 * 为什么不能只取首 token 的软最大：
 *   ① 'meme' 被切成 'm'+'eme'，首 token 是共享前缀，跟 'none'（整词一个 token）
 *      放在一起比大小是错的；
 *   ② 生成完标签后模型还会吐一个几乎确定的 EOS（logprob ≈ -0.003），它会把
 *      几何平均抬上去，让「其实很犹豫」的判定看起来很有把握。
 * 所以做法是：**按标签分组求和**（把属于同一标签的所有 token/前缀概率加起来），
 * 得到真正的标签分布；找不到任何标签 token 的位置直接跳过（不猜）。
 *
 * @returns {{probs:object, p:number, label:string|null, margin:number, pos:number}|null}
 */
export function labelDistribution(lp, labels) {
  const positions = Array.isArray(lp) ? lp.slice(0, 3) : [];
  for (let i = 0; i < positions.length; i++) {
    const cands = [positions[i], ...(Array.isArray(positions[i]?.top_logprobs) ? positions[i].top_logprobs : [])];
    const groups = new Map(labels.map((l) => [l, 0]));
    let emittedMapped = null;
    for (const t of cands) {
      const cls = classifyToken(t?.token, labels);
      if (!cls) continue;
      const v = Number(t?.logprob);
      if (!Number.isFinite(v)) continue;
      // 前缀命中的票按 grammar 的可信度打折：没有 grammar 时前缀可能属于别的词
      const weight = cls.kind === 'full' ? 1 : 0.85;
      groups.set(cls.label, groups.get(cls.label) + Math.exp(v) * weight);
      if (t === positions[i]) emittedMapped = cls.label;
    }
    const total = [...groups.values()].reduce((a, b) => a + b, 0);
    if (total <= 0) continue;
    const probs = Object.fromEntries(labels.map((l) => [l, groups.get(l) / total]));
    const ranked = Object.entries(probs).sort((a, b) => b[1] - a[1]);
    const top = ranked[0];
    const second = ranked[1];
    const margin = second && second[1] > 0 ? Math.log(top[1] / second[1]) : 6;
    return { probs, p: top[1], label: top[0], margin, pos: i, emitted: emittedMapped };
  }
  return null;
}

/**
 * 模型「说得多果断」：标签自己那几个 token 的似然。
 *
 * 只丢**尾巴上**那个几乎确定的收尾 token（生成完标签后模型必然吐 EOS/换行，
 * logprob ≈ -0.003，留着会把平均值抬上去，让犹豫的判定看起来很有把握）。
 * ⚠️ 不能把所有接近 1 的 token 都丢掉：标签本身也很可能就是一个 ~1.0 的 token
 * （实测中文单字标签 怼/无 就是这样），全丢掉会让「非常确定」变成「弃权」。
 */
function emittedLikelihood(lp) {
  const all = (Array.isArray(lp) ? lp : []).map((t) => Number(t?.logprob)).filter((v) => Number.isFinite(v) && v <= 0);
  const keep = all.filter((v, i) => !(i > 0 && v > -0.05));
  const use = keep.length ? keep : all;
  if (!use.length) return 0;
  return Math.exp(use.reduce((a, b) => a + b, 0) / use.length);
}

// ── 云端 Jev 通道 ─────────────────────────────────────────────
// 本地判不出来（弃权）或本地概率明显不够时，把这一题升级给云端小模型。
// 真 Jev 的价值本来就是「有真概率 + 快」，这里给的是一个 OpenAI 兼容的通用口子，
// 所以顺带能接任何便宜的小模型（$0.0x/M 那一档）。默认关，开了也只接弃权的那部分。
const cloudUsage = { calls: 0, promptTokens: 0, completionTokens: 0, costYuan: 0, errors: 0, lastError: '', lastAt: 0, refused: 0 };
let cloudWindowStart = 0;
let cloudWindowCount = 0;
// 端点回了一次「接受了 logprobs 参数却没给概率」（中转站常见）→ 本次运行不再要，省一次 400/空概率
let cloudNoLogprobs = false;

export function localJevCloudUsage() { return { ...cloudUsage }; }
export function resetLocalJevCloudUsage() {
  cloudUsage.calls = 0; cloudUsage.promptTokens = 0; cloudUsage.completionTokens = 0;
  cloudUsage.costYuan = 0; cloudUsage.errors = 0; cloudUsage.lastError = ''; cloudUsage.refused = 0;
}

function cloudJevCfg() {
  const c = getConfig().localJev?.cloud || {};
  return {
    enabled: c.enabled === true,
    baseUrl: String(c.baseUrl || '').replace(/\/+$/, ''),
    apiKey: String(c.apiKey || ''),
    model: String(c.model || ''),
    timeoutMs: Math.max(500, Number(c.timeoutMs) || 6000),
    upgradeBelow: Number(c.upgradeBelow ?? 0.6),
    minConfidence: Number(c.minConfidence ?? 0.6),
    // 端点不给 logprobs 时的兜底采信概率（0 = 保持"一律弃权"的旧行为）
    assumeP: Math.max(0, Math.min(1, Number(c.assumeP) || 0)),
    // 云端只接管这些角色（留空 = 全部）
    roles: Array.isArray(c.roles) ? c.roles.map(String).filter(Boolean) : [],
    priceInPerM: Number(c.priceInPerM) || 0,
    priceOutPerM: Number(c.priceOutPerM) || 0,
    maxPerMinute: Math.max(0, Number(c.maxPerMinute ?? 60))
  };
}

export function cloudJevAvailable() {
  const c = cloudJevCfg();
  return c.enabled && !!c.baseUrl && !!c.model;
}

export function cloudJevAllowed(role = '') {
  const c = cloudJevCfg();
  return cloudJevAvailable() && (!c.roles.length || c.roles.includes(String(role || '')));
}

export function cloudJevAvailableFor(role = '') {
  return cloudJevAllowed(role);
}

export function cloudJevStatus() {
  const c = cloudJevCfg();
  return {
    ...c,
    apiKey: c.apiKey ? '••••' : '',
    available: cloudJevAvailable(),
    allowedRoles: c.roles.length ? [...c.roles] : ['*'],
    usage: localJevCloudUsage()
  };
}

/** 云端限流：一分钟内最多 maxPerMinute 次，超了直接放弃（不排队、不报错）。 */
function cloudBudgetOk() {
  const c = cloudJevCfg();
  if (!c.maxPerMinute) return true;
  const now = Date.now();
  if (now - cloudWindowStart > 60000) { cloudWindowStart = now; cloudWindowCount = 0; }
  if (cloudWindowCount >= c.maxPerMinute) { cloudUsage.refused += 1; return false; }
  cloudWindowCount += 1;
  return true;
}

/**
 * 走一个 OpenAI 兼容端点问一次。
 *
 * ⚠️ 2026-09-22 重写：以前这里只有一种发法（temperature + max_tokens + logprobs 一把梭），
 *   于是"官方/第三方端点不好使"几乎全落在这三处：
 *     ① 不认 temperature / 只认 max_completion_tokens（推理模型）→ 400；
 *     ② 不支持 logprobs（或中转站把它吃掉）→ 拿不到概率 → verdict 一律弃权；
 *     ③ 端点根本不是 /chat/completions 形状 → 404。
 *   现在按「先按标准发 → 400/404/422 就逐项降级重试」的顺序来，并把"这个端点不吃
 *   logprobs"记在实例上（下一次直接不带，省一次 400）。降级只影响**参数**，
 *   判定口径（采信/弃权）不变 —— 没有概率时怎么办见 verdict 里的 assumeP。
 */
async function cloudJevRequest({ system, user, labels, timeoutMs, runContext = null, signal = null, role = '' }) {
  const c = cloudJevCfg();
  if (!cloudJevAllowed(role)) return { error: cloudJevAvailable() ? 'cloud-role-denied' : 'cloud-unavailable' };
  if (!cloudBudgetOk()) return { error: 'cloud-ratelimited' };
  const headers = { 'content-type': 'application/json' };
  if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`;
  const base = {
    model: c.model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    temperature: 0,
    stream: false
  };
  // 降级阶梯：从"最标准"到"最保守"
  const attempts = [];
  if (!cloudNoLogprobs) attempts.push({ label: 'full', body: { ...base, max_tokens: 4, logprobs: true, top_logprobs: 20 } });
  attempts.push({ label: 'no-logprobs', body: { ...base, max_tokens: 4 } });
  attempts.push({ label: 'no-temperature', body: { model: c.model, messages: base.messages, stream: false, max_completion_tokens: 4 } });
  attempts.push({ label: 'bare', body: { model: c.model, messages: base.messages } });

  let lastErr = '';
  for (const attempt of attempts) {
    try {
      const res = await fetch(`${c.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(attempt.body),
        signal: requestSignal(
          Number(timeoutMs) || c.timeoutMs,
          runContext?.signal || signal
        )
      });
      if (!res.ok) {
        const t = await res.text().catch(() => '');
        lastErr = `HTTP ${res.status}: ${t.slice(0, 160)}`;
        // 400/404/422 基本都是"参数/路径不被接受"，继续往下试；其它（401/403/429/5xx）直接抛
        if ([400, 404, 422].includes(res.status)) continue;
        cloudUsage.errors += 1;
        cloudUsage.lastError = lastErr;
        return { error: lastErr };
      }
      const data = await res.json();
      const usage = data?.usage || {};
      const lp = data?.choices?.[0]?.logprobs?.content || null;
      if (!lp && attempt.label === 'full') {
        // 端点接受了参数却没回 logprobs（中转站常见）→ 记住，下次别再要
        cloudNoLogprobs = true;
        cloudUsage.lastError = 'endpoint returned no logprobs (cached for this session)';
      }
      cloudUsage.calls += 1;
      cloudUsage.lastAt = Date.now();
      cloudUsage.promptTokens += Number(usage.prompt_tokens) || 0;
      cloudUsage.completionTokens += Number(usage.completion_tokens) || 0;
      cloudUsage.costYuan += (Number(usage.prompt_tokens) || 0) / 1e6 * c.priceInPerM
        + (Number(usage.completion_tokens) || 0) / 1e6 * c.priceOutPerM;
      return {
        raw: String(data?.choices?.[0]?.message?.content ?? '').trim(),
        lp,
        usage,
        via: attempt.label
      };
    } catch (error) {
      lastErr = String(error?.message ?? error);
      // 网络/超时：换参数也没用，直接结束
      cloudUsage.errors += 1;
      cloudUsage.lastError = lastErr;
      return { error: lastErr };
    }
  }
  cloudUsage.errors += 1;
  cloudUsage.lastError = lastErr || 'cloud-failed';
  return { error: cloudUsage.lastError };
}

/** 把标签表编成 GBNF：硬约束模型只能吐这几个词（含同义词变体）。 */
export function grammarForLabels(labels) {
  const alts = [];
  for (const l of labels) {
    for (const s of synonymsOf(l)) {
      const t = String(s).replace(/["\\]/g, '');
      if (t && !alts.includes(t)) alts.push(t);
    }
  }
  if (!alts.length) return null;
  return `root ::= ${alts.map((a) => `"${a}"`).join(' | ')}`;
}

/**
 * 原子问句。形状固定为「一句指令 + 几条 few-shot + 待判文本 + 答案:」——
 * 实测 0.8B 对多段【状态】【问题】结构会一律答 NO，只有这种形状才出有效判定。
 *
 * channel：'local'（默认，走包内 llama-server）| 'cloud'（只走云端）| 'auto'
 *          （本地先判；弃权/失败且云端可用时升级给云端）
 * @returns {{ label, p, margin, probabilities, raw, ms, abstain, channel, error? }}
 */
/**
 * 拼「角色定义 + 一条输入」→ system/user 两条消息。
 *
 * ⚠️ 这是**唯一**的拼装入口，线上推理（jevAsk）和蒸馏训练数据都用它。
 *    训练数据必须和线上提示词**逐字相同**，否则微调出来的模型会遇到
 *    "没见过的提示词形状"，线上分数直接掉 —— 所以这段逻辑绝不能有第二份实现。
 */
export function buildJevPrompt({ instruction, examples = [], labels = [], input = '', inputMaxChars } = {}) {
  const cfg = getConfig().localJev || {};
  const allowed = labels.map(String).filter(Boolean);
  const system = `只输出一个词，必须是：${allowed.join(' / ')}。不许有别的内容。`;
  const user = [
    String(instruction || '').trim(),
    ...examples.map((e) => `例: ${e[0]} → ${e[1]}`),
    `这句话: ${String(input ?? '').replace(/\s+/g, ' ').trim().slice(0, Number(inputMaxChars ?? cfg.inputMaxChars) || 160)}`,
    '答案:'
  ].filter(Boolean).join('\n');
  return { system, user, labels: allowed };
}

/** 按角色取线上那一套提示词（给蒸馏脚本用，保证和推理时一致）。 */
export function jevPromptForRole(role, input) {
  const spec = JEV_GATE_SPECS[role];
  if (!spec) return null;
  return {
    ...buildJevPrompt({ instruction: spec.instruction, examples: spec.examples, labels: spec.labels, input }),
    positive: spec.positive || '',
    roleInstruction: spec.instruction,
    roleExamples: spec.examples
  };
}

export async function jevAsk({
  role = '',
  instruction,
  labels = ['YES', 'NO'],
  examples = [],
  input = '',
  timeoutMs,
  maxTokens,
  minConfidence,
  minMargin,
  channel = 'local',
  runContext = null,
  decisionKey = '',
  signal = null
} = {}) {
  const built = buildJevPrompt({ instruction, labels, examples, input });
  const allowed = built.labels;
  if (!allowed.length) return { label: null, p: 0, margin: 0, probabilities: {}, raw: '', ms: 0, abstain: true, channel, error: 'no-labels' };
  const cfg = getConfig().localJev || {};
  const { system, user } = built;
  const sharedSignal = runContext?.signal || signal || null;

  const thr = Number(minConfidence ?? cfg.minConfidence ?? 0.5);
  const mThr = Number(minMargin ?? cfg.minMargin ?? 0.6);

  // 判定一次标签分布 → 统一出「采信 / 弃权」结论
  const verdict = (raw, lp, ms, via, usage, limits = {}) => {
    const dist = labelDistribution(lp, allowed);
    const rawLabel = matchLabel(raw, allowed);
    const distributionTopLabel = dist?.label || null;
    const mismatch = !!rawLabel && !!distributionTopLabel && rawLabel !== distributionTopLabel;
    const confidenceThreshold = Number(limits.confidence ?? thr);
    const marginThreshold = Number(limits.margin ?? mThr);
    if (!dist) {
      // 拿不到 logprobs（端点不支持 / 中转站吃掉）或没有任何标签 token。
      // ⚠️ 2026-09-22：以前这里**一律弃权**，于是「云端 Jev 通道」在只给文本、
      //   不给概率的官方端点上永远拿不到结论（用户看到的"单独用云端不通"）。
      //   现在：云端通道 + 答案命中标签 + 配了 assumeP（默认 0=保持旧行为）时按固定
      //   概率采信。这样"端点没有 logprobs"也能用，代价是失去弃权能力 —— 所以要显式打开。
      const assumeP = Number(cloudJevCfg().assumeP) || 0;
      if (via === 'cloud' && rawLabel && assumeP > 0 && assumeP >= confidenceThreshold) {
        return {
          label: rawLabel,
          rawLabel,
          distributionTopLabel,
          mismatch,
          confidenceSource: 'assumed',
          p: assumeP,
          margin: 0,
          probabilities: {},
          raw,
          ms,
          abstain: false,
          assumed: true,
          channel: via,
          usage,
          threshold: confidenceThreshold,
          marginThreshold
        };
      }
      return {
        label: rawLabel || null,
        rawLabel,
        distributionTopLabel,
        mismatch,
        confidenceSource: 'none',
        p: 0,
        margin: 0,
        probabilities: {},
        raw,
        ms,
        abstain: true,
        channel: via,
        usage,
        threshold: confidenceThreshold,
        marginThreshold,
        error: rawLabel ? '无概率' : `无法解析: ${JSON.stringify(String(raw).slice(0, 40))}`
      };
    }
    // p 取自标签分布第一名；**不再**跟 emittedLikelihood 取 min（2026-09-21 改）。
    //   · label 仍以 raw（模型实际说的那个词）为准，p 表示「这次判定的整体把握」——
    //     两者允许不同源：raw 定答案、分布定信心。实测 20 条情绪用例，raw 命中 15、
    //     分布第一名命中 13（memeOk 这类多 token 标签的前缀会被相邻标签共享，
    //     分布容易把 'm' 丢掉、把 memeOk 算低），所以答案仍该听 raw 的。
    //   · 去掉 min 的理由：grammar 会把首 token 的概率分散到各标签的首字母上，
    //     逐-token 似然天然偏低（实测 say 被从 0.93 压到 0.82，多 token 的
    //     praise/mention/sadness 更明显），取 min 等于给它们系统性加罚、按到 0.35
    //     地板弃权。更隐蔽的代价：textOnlyJudge 拿「p < 0.9 才二次问一遍旁白」当否决闸，
    //     p 被压低会让本该发出去的话白白多挨一道否决（实测「好 我记下了 周四之前给你」）。
    //   · 是不是「在瞎猜」交给 margin（前二名间隔）判；逐-token 似然降级为观测量
    //     （返回值里的 emitted 字段），只用于排查问题。
    const label = rawLabel || dist.label || null;
    const p = dist.p;
    const abstain = p < confidenceThreshold || dist.margin < marginThreshold;
    return {
      label,
      rawLabel,
      distributionTopLabel,
      mismatch,
      confidenceSource: 'distribution',
      p,
      margin: dist.margin,
      probabilities: dist.probs,
      emitted: emittedLikelihood(lp),
      raw,
      ms,
      abstain,
      channel: via,
      usage,
      threshold: confidenceThreshold,
      marginThreshold
    };
  };

  const localCall = async () => {
    // 备用模型（已下线）：只有手动配了 modelPath 才会走第二台 llama-server。
    // 没配 / 文件缺失 / 起不来 → 一律回落主模型，不让一个可选功能把判定打断。
    let key = 'primary';
    if (roleUsesSecondary(role)) {
      if (localJevAvailable('secondary')) {
        const up = await ensureLocalJev({ key: 'secondary' }).catch(() => null);
        if (up?.ok) key = 'secondary';
      }
    }
    const { baseUrl } = localJevPaths(key);
    const model = String(instanceCfg(key).modelId || 'qwen3.5-0.8b');
    const body = {
      model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      temperature: 0,
      max_tokens: Math.min(6, Number(maxTokens ?? cfg.maxTokens) || 6),
      stream: false,
      // Qwen3.5 混合思考模型：不关思考时 completion 全进 reasoning_content，content 为空。
      enable_thinking: false,
      chat_template_kwargs: { enable_thinking: false },
      thinking: { type: 'disabled' },
      logprobs: true,
      top_logprobs: Math.max(12, allowed.length + 8)
    };
    // grammar 硬约束：输出必然是标签本身，解析失败这一类彻底消失。
    // 例外：纯数字标签（挑表情序号 0..12）里 "1" 是 "12" 的前缀，约束会让它倾向于
    // 停在最短的合法串上，所以数字标签一律不套 grammar，靠序号范围校验兜底。
    const numericOnly = allowed.every((l) => /^\d+$/.test(l));
    if (cfg.useGrammar !== false && !numericOnly) {
      const g = grammarForLabels(allowed);
      if (g) body.grammar = g;
    }
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: requestSignal(Number(timeoutMs ?? cfg.judgeTimeoutMs) || 4000, sharedSignal)
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status}: ${errText.slice(0, 140)}`);
    }
    const data = await res.json();
    return {
      raw: String(data?.choices?.[0]?.message?.content ?? '').trim(),
      lp: data?.choices?.[0]?.logprobs?.content || null,
      usage: data?.usage,
      key
    };
  };

  const t0 = Date.now();
  let out = null;
  if (channel === 'cloud') {
    const r = await cloudJevRequest({ system, user, labels: allowed, timeoutMs, runContext, signal, role });
    out = r?.error
      ? { label: null, rawLabel: null, distributionTopLabel: null, mismatch: false, confidenceSource: 'none', p: 0, margin: 0, probabilities: {}, raw: '', ms: Date.now() - t0, abstain: true, channel: 'cloud', error: r.error }
      : verdict(r.raw, r.lp, Date.now() - t0, 'cloud', r.usage, {
        confidence: cloudJevCfg().minConfidence,
        margin: 0
      });
  } else {
    // 本地要占并发位；云端不用（云端并发交给端点自己）
    const release = await acquireSlot(sharedSignal);
    if (!release) {
      noteStat(role, { ms: 0, abstain: true });
      out = {
        label: null,
        rawLabel: null,
        distributionTopLabel: null,
        mismatch: false,
        confidenceSource: 'none',
        p: 0,
        margin: 0,
        probabilities: {},
        raw: '',
        ms: 0,
        abstain: true,
        channel: 'local',
        error: sharedSignal?.aborted ? abortReason(sharedSignal) : 'busy'
      };
    } else {
      try {
        const r = await localCall();
        out = verdict(r.raw, r.lp, Date.now() - t0, r.key === 'secondary' ? 'secondary' : 'local', r.usage);
      } catch (error) {
        out = { label: null, rawLabel: null, distributionTopLabel: null, mismatch: false, confidenceSource: 'none', p: 0, margin: 0, probabilities: {}, raw: '', ms: Date.now() - t0, abstain: true, channel: 'local', error: String(error?.message ?? error) };
      } finally {
        release();
      }
    }
    // auto：本地弃权（或本地直接失败）且云端可用 → 升级给云端再判一次
    if (channel === 'auto' && cloudJevAllowed(role) && !sharedSignal?.aborted) {
      const worthUpgrade = out.error === 'busy' || !out.label || (out.abstain && (out.p || 0) < cloudJevCfg().upgradeBelow);
      if (worthUpgrade) {
        const r = await cloudJevRequest({ system, user, labels: allowed, timeoutMs, runContext, signal, role });
        if (r && !r.error) {
          const up = verdict(r.raw, r.lp, Date.now() - t0, 'cloud', r.usage, {
            confidence: cloudJevCfg().minConfidence,
            margin: 0
          });
          up.upgradedFrom = { p: out.p || 0, margin: out.margin || 0, error: out.error || '' };
          out = up;
        }
      }
    }
  }
  noteStat(role, { ms: out.ms, abstain: !!out.abstain, error: !!out.error, hit: !out.abstain });
  const result = {
    ...out,
    role,
    runId: runContext?.runId || '',
    decisionKey: decisionKey || role
  };
  if (!runContext || !decisionKey) return result;
  const accepted = runContext.acceptDecision(decisionKey, result, { phase: 'pre' });
  if (accepted.accepted) return { ...result, runDecisionAccepted: true };
  return {
    ...(accepted.value || result),
    lateResult: true,
    lateReason: accepted.reason,
    runDecisionAccepted: false
  };
}

/** 角色问句表：prompt 只在这里定义一次，调用方只传待判文本。 */
export const JEV_GATE_SPECS = {
  toolNeedGate: {
    cn: '这轮要不要查资料/看图（工具门控）',
    desc: '规则分不清的短消息，问一次「这轮要不要查资料、看图或翻记录」。判 CHAT 就只给发言类工具'
      + '（省三类信息工具的 schema token，也降低小模型乱选工具的概率）。需要 api.toolGate=jev 才生效。',
    risk: '低：判错顶多多带或少带几个工具 schema，不影响能否发言'
  },
  replyChanceGate: {
    labels: ['YES', 'NO'],
    // 2026-09-19 实测（2168 个「没人点名」的真实会话 + 11 题 A/B 复跑 3 遍）：
    //   · 模型在这种批次里 92.2% 都会接话 —— 它自己几乎不克制，gate 的价值在替它克制。
    //   · 有区分度的负信号：「@ 别人」→ 80%（其中「@+没内容」→ 69%）、「有引用」→ 87%、
    //     「多人同时在说」→ 86%（基线 92%）。
    //   · ⚠️ 但把这些负信号写进下面的 instruction 实测**净有害**：
    //     0.8B 会开始乱弃权，把该接的题（「他妈的这bug查了两小时结果是拼写错」）
    //     也判成不接 —— 按"弃权=维持不插嘴原状"的行为口径算，9/11 → 7/11。
    //     所以这里**保持原来的朴素说法**，不要往里加条件（改之前先跑
    //     test/jev-replychance-lab.mjs 做 A/B）。
    //   · 【2026-09-19 已过时，别再照这段做决定】下面这句"0.8B 基本没有判断力"
    //     是微调**之前**的结论。对 0.8B 做 LoRA 微调（rank16，1885 条教师标注，
    //     只动 6 个全注意力层 + MLP，没碰 GDN 层）之后：
    //       同一套 30 题：replyChanceGate 7/11 → 9/11
    //       真实分布 400 条干净留出集：行为正确 46.8% → 76.8%（常量基线 59.8%）
    //     微调后的权重已经替换线上 models/Qwen3.5-0.8B-Q6_K.gguf，modelPath 不用改。
    //     跨角色回归无回退（imageWants/stickerAsk/cueVerify/textOnly 全持平）。
    //     改 instruction 前仍建议先跑 test/jev-replychance-lab.mjs 做 A/B。
    instruction: '群里没人在跟机器人说话。判断现在值不值得主动插一句（顺着大家的话题聊、接个梗、捧个场、补充一句）。别人的私事、情绪宣泄、告别收尾、纯语气词都不该插。',
    // ⚠️ 这几条与 test/jev-accuracy-bench.mjs 的题库**必须保持不重合**，
    //    否则就是答案泄漏（旧题库有 4 道题跟提示词逐字相同，分数虚高，已剔除）。
    examples: [
      ['今天食堂的鱼香肉丝居然不甜', 'YES'],
      ['这天气说降就降 冻手', 'YES'],
      ['新出的那个手柄手感还行', 'YES'],
      ['家里有点事 先不聊了', 'NO'],
      ['嗯', 'NO'],
      ['下周的报表记得交', 'NO']
    ],
    positive: 'YES'
  },
  // ── 工具门控（阶段三·省 token）：「这轮要不要查资料/看图/翻记忆」──────────
  // 用途：api.toolGate='jev' 时，规则层判 unknown 的短消息问这一题。
  // 判 TOOL → 工具全量；判 CHAT → 只留常驻工具（省 search/media/memory 三类 schema）。
  // 弃权/失败 → 全量保底（宁可多花 token 不可漏工具）。
  toolNeedGate: {
    labels: ['TOOL', 'CHAT'],
    instruction: '群里有人说话了。判断这轮机器人要不要查资料、看图或翻聊天记录才能接上话，还是直接凭现在聊的内容就能回。',
    examples: [
      ['这游戏副本怎么打 根本过不去', 'TOOL'],
      ['今天A股又绿了 唉', 'TOOL'],
      ['你上次说的那个链接发我看看', 'TOOL'],
      ['哈哈哈哈笑死', 'CHAT'],
      ['行吧 那先这样', 'CHAT'],
      ['睡了睡了 明天还要早起', 'CHAT']
    ],
    positive: 'TOOL'
  },
  // ── 连发合并（自适应防抖）：「他这句说完了没有」────────────────────────
  // 用途见 orchestrator#burstDelayMs：原来纯靠死计时（等 settle 秒看还有没有下句），
  // 现在先问这一句，判「说完了」就把等待缩回 wakeDelayMs。
  //
  // ⚠️ 这个角色**不进 JEV_ROLES / localJev.roles 白名单**，由 localJev.burstJudge.enabled
  //    单独开关（见 jevBurstDone）。原因是老配置里的 roles 是用户写死的显式数组，
  //    deepMerge 不会补新角色 —— 把它挂进角色表就等于多出一个"勾了也不生效"的开关，
  //    属于本项目反复踩过的静默失效。这里的 labels/instruction/examples 仍是**唯一出处**。
  //
  // 实测底稿见 test/burst-dataset.mjs + test/jev-burst-lab.mjs（两批真实消息时间线各 250/224 条）：
  //   「总是等」在串内只有 40%~47% 的时候是对的（一半以上是白等）；
  //   本角色判「完」且 p≥0.8 时，两批合计 25 次里 22 次真说完了（88%）——
  //   有信号、但只够支撑"高置信才动手"，所以只做「缩短等待」，不做「延长」。
  burstSettleGate: {
    labels: ['完', '没'],
    instruction: '这是同一个人刚发的消息，判断他说完了没有：说完、在等你回，选「完」；还会接着发下一条，选「没」。',
    examples: [
      ['在吗', '没'],
      ['在吗 问你个事', '没'],
      ['我刚想说', '没'],
      ['还有一件事', '没'],
      ['这个报错是啥意思啊', '完'],
      ['明天下午三点开会 别迟到', '完'],
      ['那行', '完'],
      ['你推荐的歌我听了 挺好', '完']
    ],
    positive: '完'
  },
  memoryRecallGate: {
    labels: ['YES', 'NO'],
    instruction: '判断这句话是不是在问一件以前发生过的事（需要去搜长期记忆）：提到"上次/之前/那天/上周/以前/还记得吗"这类，或在问从前聊过的人、店、书、事，都算 YES。问刚才/这一轮里的事不算旧事，选 NO。',
    examples: [
      ['你还记得我上次说要去日本吗', 'YES'],
      ['之前你给我推荐的那首歌', 'YES'],
      ['前阵子说的那家店还在吗', 'YES'],
      ['这条消息是谁发的', 'NO'],
      ['今天上班好累', 'NO']
    ],
    positive: 'YES'
  },
  imageCueGate: {
    labels: ['YES', 'NO'],
    instruction: '判断对方是不是在向机器人要它自己的形象照/自拍（想看它长什么样）。',
    examples: [
      ['发张你自己的照片看看', 'YES'],
      ['你长啥样啊', 'YES'],
      ['这图谁画的', 'NO'],
      ['把我刚才发的图再发一遍', 'NO']
    ],
    positive: 'YES'
  },
  imageWantsGate: {
    labels: ['YES', 'NO'],
    instruction: '判断对方是不是在要机器人去找一张图片并发出来。',
    examples: [
      ['来个灵梦图片', 'YES'],
      ['发张爱音的壁纸', 'YES'],
      ['图呢 图呢', 'YES'],
      ['这图好看吗', 'NO'],
      ['我上次发的那个图你还在吗', 'NO'],
      ['东方project里灵梦是谁', 'NO']
    ],
    positive: 'YES'
  },
  stickerAskGate: {
    labels: ['YES', 'NO'],
    instruction: '判断对方是不是在要表情包/贴图（不是要普通图片）。',
    examples: [
      ['发个表情包', 'YES'],
      ['整个抽象的图来', 'YES'],
      ['这个表情包是哪来的', 'NO'],
      ['帮我搜张壁纸', 'NO']
    ],
    positive: 'YES'
  },
  // 三分类换中文单字（梗/怼/无）：小模型更果断。
  // 小模型对「梗/怼/无」这种单字标签比 meme/tease/none 果断得多，且都是单 token。
  cueVerifyGate: {
    labels: ['梗', '怼', '无'],
    instruction: '判断这句话的调性：在玩梗/复读/接老梗选「梗」；在损人、玩闹互怼、阴阳怪气选「怼」；就是普通说话、没这两样选「无」。',
    examples: [
      ['草 这梗我复读过了', '梗'],
      ['就你这水平还出来丢人', '怼'],
      ['大胖鲸你又来了', '怼'],
      ['明天下雨记得带伞', '无']
    ],
    positive: null
  },
  impressionTypeGate: {
    labels: ['identity', 'preference', 'edge', 'style', 'attitude', 'event'],
    instruction: '这是记住的、关于某个群友的一条印象，判断属于哪一类：identity=身份背景（学生/职业/年龄/城市/感情状况）；preference=喜好（爱吃爱玩/常用常去）；edge=雷点禁忌（提到就会不高兴、明确不要做的事）；style=说话风格（口头禅/语气/爱不爱玩梗）；attitude=对机器人的相处态度（该宠着/少怼/顺着说）；event=具体发生过的事（以上都不是就选这个）。',
    examples: [
      ['在读大二 常驻杭州', 'identity'],
      ['最爱吃学校南门的麻辣烫', 'preference'],
      ['别在他面前提他前女友', 'edge'],
      ['说话爱带「懂了懂了」', 'style'],
      ['对他要多顺着说 别老拆台', 'attitude'],
      ['上周帮我把落食堂的伞捎回来了', 'event']
    ],
    positive: null
  },
  // ⚠️ 输入用「甲：… ｜ 乙：…」拼接，因为 jevAsk 会把连续空白压成一个空格，
  //    别指望靠换行分段。examples 与 test/jev-accuracy-bench.mjs 的题库必须不重合。
  impressionDupeGate: {
    labels: ['YES', 'NO'],
    instruction: '甲和乙是记住的关于同一个人的两条印象，判断是否在说同一件事（能合并成一条）。措辞不同没关系，核心信息一样就算 YES；多出任何新信息（不同对象/不同时间/不同内容）都算 NO。',
    examples: [
      ['甲：最喜欢吃鱼了 ｜ 乙：爱吃鱼', 'YES'],
      ['甲：在读大二 ｜ 乙：大二学生', 'YES'],
      ['甲：爱吃鱼 ｜ 乙：爱吃麻辣烫', 'NO'],
      ['甲：上周帮我带过伞 ｜ 乙：上个月借过我充电宝', 'NO'],
      ['甲：说话很损 ｜ 乙：嘴上不饶人 爱怼人', 'YES']
    ],
    positive: 'YES'
  },
  memeGate: {
    labels: ['YES', 'NO'],
    // 梗库的字面/标签检索会把「沾字不沾事」的梗捞上来（对着报错闪「吃什么」），
    // 注入后模型要么硬套要么整段复读。这里让 Jev 在注入前复核一次「接不接得上」。
    instruction: '群里刚有人说话，机器人脑内闪过一条群内熟梗。判断这条梗现在用不用得上：话题沾边、气氛轻松、能自然接一句就算 YES。话题无关、对方在说正事或情绪低落、硬套会很尬，都选 NO。',
    examples: [
      ['群里刚说：今天又加班到十点\n脑内闪过的梗：资本家的福报又来了', 'YES'],
      ['群里刚说：这新番第一集就刀我\n脑内闪过的梗：寄，寄寄寄', 'YES'],
      ['群里刚说：帮我看看这段报错什么意思\n脑内闪过的梗：吃什么吃什么', 'NO'],
      ['群里刚说：我奶奶住院了 好担心\n脑内闪过的梗：寄，寄寄寄', 'NO']
    ],
    positive: 'YES'
  },
  // 场景门（2026-09-22）：放宽召回之后，先判"这个场合能不能玩梗"，再逐条判梗。
  // 为什么要分成两道：实测老路径 192 轮注入、模型 0 次使用 —— 大半时间场合根本不对
  // （在讨论版本号/内存价格/报错，却闪「电子榨菜」「都做对的可以称帝了」）。
  // 场景门一次调用就能挡掉整轮，比逐条复核便宜；只有场合对了才值得为每条梗花一次判定。
  memeSceneGate: {
    labels: ['YES', 'NO'],
    instruction: '群里正在聊天。判断现在这个场合适不适合玩梗、接梗、顺着话茬调侃：大家在闲聊、开玩笑、互相损、接梗、凑热闹 → YES；在说正事、求助排查、报错、情绪低落或生气、吵架、通知安排 → NO。只判断气氛，不要判断某一条具体的梗。',
    examples: [
      ['群里刚说：这新番第一集就刀我 我不活了\n旁边两个人跟着起哄', 'YES'],
      ['群里刚说：大胖鲸又摸鱼 一会儿说要发歌一会儿说要去吃饭', 'YES'],
      ['群里刚说：帮我看看这段报错什么意思 一直起不来', 'NO'],
      ['群里刚说：我奶奶住院了 好担心', 'NO'],
      ['群里刚说：明天九点集合 别忘了带身份证', 'NO']
    ],
    positive: 'YES'
  },
  // 严格逐条门（2026-09-22）：放宽召回配套。
  // 老 memeGate 的问法是"这条梗现在用不用得上：话题沾边…就算 YES" —— 那是为"字面已命中"的
  // 窄召回设计的。放宽到标签/备注/轮换通道后，实测它对 97 对候选放行 79 对（81%），等于没判。
  // 这道门把问题换成"发出去会被当成什么"，并明确"拿不准就 NO"（硬套比不用更伤）。
  memeFitGate: {
    labels: ['YES', 'NO'],
    instruction: '群里刚聊了几句，机器人手上有一条群内老梗。判断这条梗现在发出去投不投得出去：群友顺势能接、像熟人随口补一句 → YES；只是话题沾边、但用出去会莫名/答非所问/像在背台词，或者群友自己刚说的就是这句 → NO。拿不准就 NO（硬套比不用更伤）。',
    examples: [
      ['群里刚说：帮我看看这段报错 一直起不来\n脑内闪过的梗：吃什么吃什么', 'NO'],
      ['群里刚说：今天开会开到七点 累死了\n脑内闪过的梗：收到请回复', 'NO'],
      ['群里刚说：我外卖到了 你们先聊\n脑内闪过的梗：我外卖到了', 'NO'],
      ['群里刚说：明天九点集合 别迟到了\n脑内闪过的梗：主打一个XX', 'NO'],
      ['群里刚说：这新番第一集就刀我 我不活了\n脑内闪过的梗：寄，寄寄寄', 'YES'],
      ['群里刚说：又加班到十点 资本家真行\n脑内闪过的梗：资本家的福报又来了', 'YES'],
      ['群里刚说：抽到想要的角色了 我直接原地起飞\n脑内闪过的梗：这波不亏', 'YES']
    ],
    positive: 'YES'
  },
  memeSaveGate: {
    labels: ['YES', 'NO'],
    instruction: '判断这句话是不是一条以后还能复用的群内梗/口头禅/内部笑话/可复用结论。一次性事件、临时话题、普通闲聊、流水账都选 NO。',
    examples: [
      ['鲸门开宗立派', 'YES'],
      ['大胖鲸批发商（已就寝）', 'YES'],
      ['我今天吃了麻辣烫', 'NO'],
      ['帮我看看这段报错', 'NO']
    ],
    positive: 'YES'
  },
  // 表情包/图片与当前话题的相关性（2026-09-21 管理员要求）：
  // 以前"只要有图就自动挂上去"，模型看到图就以为在说它，把话题扯到认图上。
  // 先让 Jev 判一眼"这张图跟刚才在聊的事有没有关系"，无关就不附图、并明说别理。
  imageRelevanceGate: {
    labels: ['RELATED', 'UNRELATED'],
    // ⚠️ 2026-09-21 20 例盲测：第一版指令下 0.8B 有"默认往相关猜"的偏置，
    //   5 个错例全是"无关 → 判相关"（周末去哪玩+猫图、服务器维护+动漫图、聊重构+狗照片…），
    //   而主模型盲标同一套题 20/20 全对。病根是"关系大不大"这种主观问法 0.8B 拿不住，
    //   改成**可操作的两步检查**：① 图里有没有在接那句话（回应/补充/就是话题本身）；
    //   ② 话题里的名词/情绪跟图对得上吗。都对不上就是 UNRELATED。
    instruction: '群里刚有人发了图。按两步判断它跟刚才在聊的事有没有关系：\n'
      + '第一步，这张图是不是在接上面那句话（回应某句、补充说明、或者这张图本身就是话题）？\n'
      + '第二步，图里的东西跟话题里的东西对得上吗（聊吃什么发吃的＝对得上；聊爬山发猫图＝对不上）？\n'
      + '两步都对得上才 RELATED。只是"群里在聊天、图也发在群里"不算关系 —— 顺手指带发的、从别处存来的、'
      + '跟话题不搭的内容，一律 UNRELATED。拿不准也选 UNRELATED。',
    examples: [
      ['刚才在聊：今天加班到十点 好累\n刚发来的图：一张瘫在椅子上的猫', 'RELATED'],
      ['刚才在聊：帮我看看这段报错\n刚发来的图：一张无语扶额的表情', 'RELATED'],
      ['刚才在聊：十连又沉了 心态崩了\n刚发来的图：一张非酋表情包', 'RELATED'],
      ['刚才在聊：这周末去哪玩 爬山还是看展\n刚发来的图：一张网上存的搞笑猫咪图', 'UNRELATED'],
      ['刚才在聊：服务器今晚维护到八点\n刚发来的图：一张动漫角色截图', 'UNRELATED'],
      ['刚才在聊：这段代码我重构了一晚上\n刚发来的图：一张狗的照片', 'UNRELATED'],
      ['刚才在聊：明天几点集合 十点老地方\n刚发来的图：一张风景照', 'UNRELATED'],
      ['刚才在聊：这模型跑得好慢 缓存也低\n刚发来的图：一张跟话题无关的搞笑截图', 'UNRELATED']
    ],
    positive: 'RELATED'
  },
  // 语义卡准入（2026-09-21）：这条消息/摘要值不值得当长期记忆，是"计划/事实/废话"。
  // 为什么要 Jev：正则只能看"有没有明天/要去"，把「睡吧 明天还得早起」也当计划；
  // 而抽卡在巩固流程里（后台，10 分钟一次），本地判一百毫秒完全不占回复链路。
  cardGate: {
    labels: ['PLAN', 'FACT', 'SKIP'],
    instruction: '判断这句话值不值得记成"以后还用得上的长期记忆"。'
      + 'PLAN＝有人约好/答应了某件以后要做的事（带上谁、做什么、什么时候）；'
      + 'FACT＝关于某人的稳定事实或偏好（身份、习惯、雷点、口味）；'
      + 'SKIP＝闲聊、吐槽、告别、感慨、复读、半截话，或者只是"明天见"这种客套。'
      + '拿不准就 SKIP —— 记错一条会一直带在后面的对话里，比少记一条糟。',
    examples: [
      ['明天我陪你去医院复查', 'PLAN'],
      ['示例用户喜欢古典、摇滚和OST，推歌按这三类来', 'FACT'],
      ['睡吧 明天还得早起', 'SKIP'],
      ['兄弟们明天见我不行了', 'SKIP'],
      ['我以为得等到明天呢', 'SKIP'],
      ['@某某 去b站搜搜有没', 'SKIP'],
      ['哈哈 这也太典了', 'SKIP']
    ],
    positive: 'PLAN'
  },
  // 印象补选：注入提示词的印象每条都有名额，落榜那条在丢之前问一次"跟现在这句话有关吗"。
  // 输入是单行：`A: <群友刚说的话> ｜ B: <关于这个人的一条记录>`。
  // ⚠️ 这道题 0.8B 只有 20/30（见 JEV_ROLES.impressionPickGate 的说明）→ 默认不勾。
  impressionPickGate: {
    labels: ['YES', 'NO'],
    instruction: '输入格式是「A: 群里刚说的话 ｜ B: 机器人脑子里关于说话这个人的一条记录」。'
      + '判断 B 这条记录对"现在该怎么回 A / 该怎么满足 A 的要求"有没有用。'
      + 'A 在提要求（让机器人推歌、发图、查东西、陪着聊）时，能直接指导怎么做的 B 算 YES；'
      + '跟 A 的当前话题或情绪无关的背景资料（学历、职业、单位、纯性格描述）算 NO。'
      + 'A 只是打招呼、道别、吐槽一句时，B 多半都不相关，选 NO。',
    examples: [
      ['A: 京玉，给我推首歌 ｜ B: 音乐推荐口味固定三类：古典、摇滚、OST，推歌请严格遵循此三类', 'YES'],
      ['A: 京玉，给我推首歌 ｜ B: 某高校在读，想进游戏行业并自制demo，硬件党，深夜易焦虑', 'NO'],
      ['A: 京玉，给我推首歌 ｜ B: 群里的机器人管理员，部署了两个机器人，热衷调试机器人，吃软不吃硬', 'NO'],
      ['A: 你还记得我上次说的那个游戏吗 ｜ B: 想进游戏行业，自制过demo，主机游戏玩得多', 'YES'],
      ['A: 今天好累啊 ｜ B: 深夜容易焦虑学业前途，需要人陪着说话', 'YES'],
      ['A: 哈哈这图笑死 ｜ B: 喜欢猫，头像一直是猫', 'NO'],
      ['A: 明天上线吗 ｜ B: 约好周六晚八点一起开黑打排位', 'YES'],
      ['A: 京玉，出来 ｜ B: 群里的机器人管理员，热衷测试调试机器人', 'NO']
    ],
    positive: 'YES'
  },
  // 生活账本的主语判定：正则只能看字面，分不清"谁饿了/谁困了"。
  // 只在"既提到我、又提到你/他"的含糊句子上问，清晰句子不问（省钱也省时间）。
  selfStateGate: {
    labels: ['SELF', 'OTHER'],
    instruction: '机器人（它是群友，会说自己吃饭、睡觉、累、在忙）刚说了一句话。判断这句话里的"吃/睡/累/忙"是在说机器人自己，还是在说对方/别人。说自己选 SELF；说对方、问对方、劝对方吃/睡，都选 OTHER。',
    examples: [
      ['我更饿了', 'SELF'],
      ['刚睡醒 脑子还没开机', 'SELF'],
      ['在忙 等我会儿', 'SELF'],
      ['你这刚醒就问我吃啥 不先关心自己饿不饿', 'OTHER'],
      ['你饿不饿 要不要点外卖', 'OTHER'],
      ['他昨晚又熬夜了吧', 'OTHER']
    ],
    positive: 'SELF'
  },
  wikiGate: {
    labels: ['YES', 'NO'],
    instruction: '判断这句话是不是在问某个作品/角色/设定的外部知识（出处、是谁、什么背景、哪个世界观），需要去查百科。问群内自己的事、问机器人本人、纯闲聊、问以前聊过的事都选 NO。',
    examples: [
      ['阿米娅的种族是什么来着', 'YES'],
      ['终末地那个新干员出自哪', 'YES'],
      ['你今天吃了啥', 'NO'],
      ['上次我说的那家店还在吗', 'NO']
    ],
    positive: 'YES'
  },
  narrationGate: {
    labels: ['YES', 'NO'],
    instruction: '判断下面这段是不是机器人说给自己听的话（分析、计划、复述、决定要不要回），而不是要发给群友的那句话。',
    examples: [
      ['他这句在说我，我得回一下', 'YES'],
      ['根据设定，被问到是不是AI可以大方承认', 'YES'],
      ['我先去搜一下有没有原图', 'YES'],
      ['草 没上农你发这干嘛', 'NO'],
      ['在的，你说', 'NO']
    ],
    positive: 'YES'
  },
  textOnlyJudge: {
    labels: ['say', 'skip'],
    instruction: '把正文标成 say 或 skip。say=能直接发进群的一句话；skip=内心戏/计划/复述/安静结束。',
    examples: [
      ['草 没上农你发这干嘛', 'say'],
      ['在的，你说', 'say'],
      ['他在说我，我得回一下', 'skip'],
      ['安静结束，处理结束', 'skip'],
      ['我先去查一下', 'skip']
    ],
    positive: 'say'
  },
  unsentLinesJudge: {
    labels: ['say', 'skip'],
    instruction: '这是一行还没发出去的草稿。say=可以直接发给群友的原句；skip=内心分析/计划/选词改稿/已经发过的话。',
    examples: [
      ['有空，你说', 'say'],
      ['你有什么事？', 'say'],
      ['他这句在说我，得回一下', 'skip'],
      ['根据设定可以大方承认', 'skip'],
      ['我先去查一下', 'skip']
    ],
    positive: 'say'
  }
};

/**
 * 按角色问一次。返回 { on:boolean, label, p, margin, abstain, error? }；
 * 任何失败/低置信都 on:false —— 调用方保持原逻辑（只会更保守，不会更激进）。
 * channel 见 jevAsk（'local' | 'cloud' | 'auto'）。
 */
export async function jevGate(role, input, {
  timeoutMs, minConfidence, minMargin, channel, runContext = null, decisionKey = '', signal = null
} = {}) {
  const spec = JEV_GATE_SPECS[role];
  if (!spec) return { on: false, label: null, p: 0, margin: 0, abstain: true, error: `未知角色 ${role}` };
  if (!localJevHasRole(role)) return { on: false, label: null, p: 0, margin: 0, abstain: true, error: 'role-off' };
  const text = String(input ?? '').trim();
  if (!text) return { on: false, label: null, p: 0, margin: 0, abstain: true, error: 'empty' };
  // 默认走 auto：本地先判，本地弃权而云端配好了就顺手升级（云端没配等于 local）
  const ch = channel || (localJevEnabled() ? (cloudJevAvailable() ? 'auto' : 'local') : (cloudJevAvailable() ? 'cloud' : 'local'));
  const r = await jevAsk({
    role,
    instruction: spec.instruction,
    labels: spec.labels,
    examples: spec.examples,
    input: text,
    timeoutMs: timeoutMs || 2500,
    maxTokens: 4,
    minConfidence,
    minMargin,
    channel: ch,
    runContext,
    decisionKey,
    signal
  });
  const on = !r.error && !r.abstain && !!spec.positive && r.label === spec.positive;
  return {
    on, label: r.label, rawLabel: r.rawLabel, distributionTopLabel: r.distributionTopLabel,
    mismatch: r.mismatch, confidenceSource: r.confidenceSource, p: r.p, margin: r.margin,
    probabilities: r.probabilities, abstain: r.abstain, ms: r.ms, raw: r.raw, error: r.error,
    channel: r.channel, upgradedFrom: r.upgradedFrom, lateResult: r.lateResult,
    lateReason: r.lateReason, runDecisionAccepted: r.runDecisionAccepted
  };
}

// ── 两种输出类型：Noul（走 jevGate）与 Choice ──────────────────

/** Choice：固定枚举 + 每项概率（真 Jev 的 Choice 就是这个形状）。 */
export async function jevChoice({ state, question, options, timeoutMs, minConfidence } = {}) {
  const allowed = (Array.isArray(options) ? options : []).map(String).filter(Boolean);
  if (!allowed.length) return { choice: null, raw: '', error: 'no-options', source: 'localJev' };
  const r = await jevAsk({
    role: 'choice',
    instruction: `${String(question ?? '').slice(0, 400)}\n可选答案：${allowed.join(' / ')}`,
    labels: allowed,
    examples: [],
    input: String(state ?? ''),
    timeoutMs,
    maxTokens: 4,
    minConfidence
  });
  if (r.error) return { choice: null, raw: r.raw, error: r.error, source: 'localJev' };
  return {
    choice: r.abstain ? null : r.label,
    probabilities: r.probabilities,
    p: r.p,
    margin: r.margin,
    emitted: r.emitted,
    raw: r.raw,
    abstain: r.abstain,
    confidence: r.p,
    source: 'localJev'
  };
}

/**
 * 自动配表情：从候选里挑一张（Choice over 序号，0=都不合适）。
 * 这一步原来是走云端工具调用 + 600 输出预算，只为拿回一个数字 —— 典型 Jev 活。
 * 返回 index（1 起）或 0；失败/低置信/越界一律 0（=不发，跟原逻辑一致）。
 */
export async function jevStickerPick({ candidates = [], recent = '', timeoutMs = 3000 } = {}) {
  const list = (Array.isArray(candidates) ? candidates : [])
    .map((s) => String(s ?? '').trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!list.length || !localJevHasRole('stickerPickGate')) {
    return { index: 0, p: 0, skipped: true };
  }
  const labels = ['0', ...list.map((_, i) => String(i + 1))];
  const r = await jevAsk({
    role: 'stickerPickGate',
    instruction: [
      '给下面的对话配一张收藏表情，从候选里挑最贴切的一张，只回它的序号。',
      '候选里没有合适的就回 0。',
      '【候选】',
      list.map((s, i) => `${i + 1}. ${s.slice(0, 40)}`).join('\n'),
      '【刚才的对话】',
      String(recent ?? '').slice(0, 400)
    ].join('\n'),
    labels,
    examples: [],
    input: '答案',
    timeoutMs,
    maxTokens: 2
  });
  if (r.error || r.abstain || !r.label || r.label === '0') {
    return { index: 0, p: r.p || 0, raw: r.raw, abstain: !!r.abstain, error: r.error };
  }
  const index = Number(r.label);
  if (!Number.isInteger(index) || index < 1 || index > list.length) {
    return { index: 0, p: 0, raw: r.raw, error: `序号越界 ${r.label}` };
  }
  return { index, p: r.p, raw: r.raw, probabilities: r.probabilities, ms: r.ms };
}

/**
 * 一次问多个原子题（并发受限，失败各自弃权）。
 * budgetMs 是**整轮硬预算**：到点就把手上已经判出来的结果交回去、剩下的当弃权 ——
 * 否则换个慢模型（CPU 上 4B 单次 3.5s）会把每条消息的响应拖成十几秒。
 */
export async function jevGateBundle(inputs, { timeoutMs = 2500, budgetMs, runContext = null, signal = null } = {}) {
  const cfg = getConfig().localJev || {};
  const budget = Math.max(300, Number(budgetMs ?? cfg.gateBudgetMs) || 1500);
  const out = {};
  const controller = new AbortController();
  const baseSignal = signal || runContext?.signal;
  if (baseSignal?.aborted) controller.abort(baseSignal.reason);
  else if (baseSignal) {
    baseSignal.addEventListener('abort', () => controller.abort(baseSignal.reason), { once: true });
  }
  let frozen = false;
  const jobs = Object.entries(inputs || {})
    .filter(([role, text]) => JEV_GATE_SPECS[role] && String(text || '').trim() && localJevHasRole(role))
    .map(async ([role, text]) => {
      const value = await jevGate(role, text, {
        timeoutMs,
        runContext,
        decisionKey: `pre-gate:${runContext?.runId || 'bundle'}:${role}`,
        signal: controller.signal
      });
      if (!frozen) out[role] = value;
    }).map((job) => job.catch(() => {}));
  if (!jobs.length) return out;
  let timer = null;
  await Promise.race([
    Promise.allSettled(jobs),
    new Promise((r) => { timer = setTimeout(r, budget); })
  ]);
  if (timer) clearTimeout(timer);
  frozen = true;
  if (!controller.signal.aborted) controller.abort('gate-budget');
  return { ...out };
}

/**
 * Jev 风格一次决策（批量入口，保留给脚本/测试用）。
 * questions: { [id]: { type: 'noul'|'choice', instructions, criteria?: Record<string,string>|string[] } }
 */
export async function localJevDecide({ state, questions, timeoutMs = 4000, overrides = null } = {}) {
  if (!localJevEnabled()) throw new Error('localJev 未启用');
  const ensured = await ensureLocalJev();
  if (!ensured?.ok) throw new Error(ensured?.reason || 'localJev 未就绪');
  const cfg = getConfig().localJev || {};
  const answers = {};
  const raws = {};
  const usage = { prompt_tokens: 0, completion_tokens: 0 };

  // 小模型：一问一请求（separate），避免 packed 干扰。
  const jobs = Object.entries(questions || {}).map(async ([id, q]) => {
    const type = q?.type === 'choice' ? 'choice' : 'noul';
    const criteriaList = type === 'choice'
      ? (Array.isArray(q.criteria) ? q.criteria : Object.keys(q.criteria || {}))
      : ['YES', 'NO'];
    if (type === 'choice' && criteriaList.length < 2) {
      throw new Error(`question ${id}: choice 至少需要 2 个选项`);
    }
    const hint = type === 'choice'
      ? Object.entries(q.criteria || {})
        .map(([k, v]) => (typeof v === 'string' && v && v !== k ? `${k}: ${v}` : k))
        .join('；')
      : 'YES=成立，NO=不成立';
    const r = await jevAsk({
      role: `decide:${id}`,
      instruction: `${String(q.instructions || id).slice(0, 400)}\n${hint}`,
      labels: criteriaList,
      examples: [],
      input: String(state ?? ''),
      timeoutMs,
      maxTokens: Number(cfg.maxTokens) || 6,
      ...(overrides || {})
    });
    raws[id] = r.raw;
    if (r.usage) {
      usage.prompt_tokens += Number(r.usage.prompt_tokens) || 0;
      usage.completion_tokens += Number(r.usage.completion_tokens) || 0;
    }
    if (type === 'noul') {
      if (r.error && !r.raw) { answers[id] = { type, noul: 0, confidence: 0, parseFailed: true, raw: '' }; return; }
      const yes = !r.error && !r.abstain && r.label === 'YES';
      answers[id] = { type, noul: yes ? 1 : 0, confidence: r.p || 0, raw: r.raw, abstain: r.abstain };
    } else {
      if (r.error || r.abstain) throw new Error(`localJev 无法解析 ${id}: ${JSON.stringify(r.raw || r.error)}`);
      answers[id] = {
        type,
        choice: r.label,
        probabilities: r.probabilities,
        confidence: r.p,
        raw: r.raw
      };
    }
  });
  await Promise.all(jobs);
  return { answers, usage, raws, model: String(cfg.modelId || 'qwen3.5-0.8b'), baseUrl: localJevPaths().baseUrl };
}

/** 该角色是否交给本地 Jev（enabled + 角色白名单）。 */
export function localJevHasRole(role) {
  // ⚠️ 2026-09-22：这里以前是「本地没开 → 一律说没有这个角色」，
  //   于是把「启用本地 Jev」取消勾选之后，所有闸门在**选通道之前**就早退了
  //   （jevGate 第一行 if (!localJevHasRole(role)) return { error: 'role-off' }），
  //   云端 Jev 通道配得再好也一次都不会被调用 —— 用户看到的就是"单独用云端完全不通"。
  //   现在：本地关但云端配好了 → 也算接管（走 cloud 通道）。
  if (!localJevEnabled() && !cloudJevAvailable()) return false;
  return activeRoles().includes(String(role || ''));
}

/** 这个角色能不能只在本地跑（云端接管没意义的那些判定用它把关）。 */
export function localJevRoleLocalOnly(role) {
  return localJevEnabled() && activeRoles().includes(String(role || ''));
}

/** 正文裁判：say / skip。返回与 salvage.judgeTextOnly 兼容的形状。 */
export async function jevJudgeTextOnly({ text, trigger = '' } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { action: 'skip', say: false, messages: [], raw: '', error: 'empty' };

  const ready = await ensureLocalJev();
  if (ready && ready.ok === false) {
    return { action: 'skip', say: false, messages: [], raw: '', error: ready.reason || 'not-ready', source: 'localJev' };
  }
  const probe = body.length > 420 ? `${body.slice(0, 200)} … ${body.slice(-200)}` : body;
  const g = await jevGate('textOnlyJudge', probe, { timeoutMs: 3000 });
  if (g.error) return { action: 'skip', say: false, messages: [], raw: g.raw || '', error: g.error, source: 'localJev' };
  // 判不出来（概率太低）≠ 该沉默：把 error 带回去，让上层回退云端裁判（云端准得多，且这条路径本来稀有）。
  if (g.abstain) return { action: 'skip', say: false, messages: [], raw: g.raw, margin: g.margin, error: `弃权：概率 ${(g.p || 0).toFixed(2)} / 间隔 ${(g.margin || 0).toFixed(2)} 未达阈值`, source: 'localJev' };
  if (!g.on) return { action: 'skip', say: false, messages: [], raw: g.raw, margin: g.margin, source: 'localJev', p: g.p };
  // 裁判说 say 之后仍过两道否决：0.8B 误判率高，安全侧优先
  if (localLooksLikeNarration(body)) {
    return { action: 'skip', say: false, messages: [], raw: `${g.raw}|veto:regex-narration`, source: 'localJev', p: g.p };
  }
  // 第二道否决只在第一道裁判自己就没把握时才有意义：实测 0.8B 会把
  // 「行 那我下班顺路帮你带一杯」这种该发的话问成内心戏，两个都不准的判断叠在一起不会更准。
  if (localJevHasRole('narrationGate') && g.p < 0.9) {
    const v = await jevGate('narrationGate', probe, { timeoutMs: 2500, minConfidence: 0.85 });
    if (v.on) {
      return { action: 'skip', say: false, messages: [], raw: `${g.raw}|veto:jev-narration`, source: 'localJev', p: g.p };
    }
  }
  const messages = draftFromLocal(body);
  if (!messages.length) {
    return { action: 'skip', say: false, messages: [], raw: g.raw, error: 'empty-messages', source: 'localJev' };
  }
  return { action: 'say', say: true, messages, raw: g.raw, margin: g.margin, source: 'localJev', p: g.p };
}

/**
 * 单行「该不该发」：say / skip。用于协议恢复多行筛选。
 * mode: 'unsentLine' 用协议恢复规则；'textOnly' 复用正文裁判 few-shot。
 */
export async function jevSaySkipLine({ line, trigger = '', mode = 'unsentLine', alreadySent = [] } = {}) {
  const body = String(line ?? '').trim();
  if (!body) return { action: 'skip', say: false, raw: '', error: 'empty' };
  const ready = await ensureLocalJev();
  if (ready && ready.ok === false) {
    return { action: 'skip', say: false, raw: '', error: ready.reason || 'not-ready', source: 'localJev' };
  }
  const role = mode === 'textOnly' ? 'textOnlyJudge' : 'unsentLinesJudge';
  const sentBlob = (alreadySent || []).slice(-8)
    .map((s) => String(s?.text || '').slice(0, 40)).filter(Boolean).join(' | ');
  const probe = sentBlob
    ? `${body.slice(0, 200)}\n（已发过：${sentBlob.slice(0, 120)}）`
    : body.slice(0, 200);
  const g = await jevGate(role, `${trigger ? `对方刚说：${String(trigger).slice(0, 80)}\n` : ''}草稿：${probe}`, { timeoutMs: 2500 });
  if (g.error) return { action: 'skip', say: false, raw: g.raw || '', error: g.error, source: 'localJev' };
  if (g.abstain) return { action: 'skip', say: false, raw: g.raw, margin: g.margin, error: `弃权：概率 ${(g.p || 0).toFixed(2)} / 间隔 ${(g.margin || 0).toFixed(2)} 未达阈值`, source: 'localJev' };
  if (!g.on) return { action: 'skip', say: false, raw: g.raw, margin: g.margin, source: 'localJev', p: g.p };
  if (mode === 'textOnly' && localLooksLikeNarration(body)) {
    return { action: 'skip', say: false, raw: `${g.raw}|veto:narration`, source: 'localJev' };
  }
  return { action: 'say', say: true, raw: g.raw, margin: g.margin, source: 'localJev', p: g.p };
}

/**
 * 情绪判定：每轮由本地小模型出标签（大模型 finish 自评已废除）。
 *
 * 只判 7 种高频社交向 + none。其余（求助/好奇/出丑/分享/吐槽/期待…）
 * 不进模型枚举：环境事件走规则，词表只保留仍能触发的少数 kind。
 * 不要再往这里加选项 —— 0.8B 选项越多越容易弃权/乱标。
 */
export const EMOTION_GATE_KINDS = [
  'praise', 'roast', 'tease', 'memeOk', 'chat', 'mention', 'sadness'
];

export const EMOTION_GATE_OPTIONS = [...EMOTION_GATE_KINDS, 'none'];

/** kind → 给 0.8B 的短说明（先讲 tease vs roast，这是最常见的误判）。
 *  ⚠️ 值里不要再自带 `xxx=` 前缀：拼接时已经有 `${k}=`，而旧代码用 `/^[a-z]+=/` 去前缀，
 *  匹配不到驼峰的 memeOk，实测提示词里出现过 `memeOk=memeOk=接梗玩梗`。 */
const EMOTION_GATE_HINT = {
  praise: '夸机器人',
  roast: '真骂人（脏字/人身攻击），不是玩笑',
  tease: '损友玩闹（叫胖鲸/蓝毛/好菜、哈哈哈、不许叫XX），不是真骂',
  memeOk: '接梗玩梗',
  chat: '普通闲聊',
  mention: '点名找机器人',
  sadness: '难过委屈',
  none: '无明显情绪'
};

export async function jevEmotionHint({ text } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { kind: null, error: 'empty' };
  const labels = EMOTION_GATE_OPTIONS.map((k) => `${k}=${(EMOTION_GATE_HINT[k] || k)}`).join('；');
  const r = await jevChoice({
    state: body.slice(0, 200),
    question: `给这句话分类。重点：朋友间玩笑互损/叫外号/哈哈哈 → tease；带脏字真骂 → roast；普通聊天 → chat。\n${labels}`,
    options: EMOTION_GATE_OPTIONS,
    timeoutMs: 2500,
    minConfidence: 0.45
  });
  if (r.error) return { kind: null, error: r.error };
  if (r.abstain || !r.choice || r.choice === 'none') {
    // praise 单类放宽（2026-09-21）：
    // 0.8B 对「夸它」系统性没把握 —— 实测「小鲸鱼你眼睛真好看」的标签分布里
    // praise 是第一名（0.51），但 margin 只有 0.57，达不到间隔闸（1.0）而弃权。
    // 而 praise 只影响好感漂移（本文件里风险最低的一类），所以这里补一道：
    // **praise 是分布第一名且过半**就当它判出来了。
    // 门槛取 0.45（与 emotionGate 自己的 minConfidence 一致）是有意的：
    // 实测「被夸」这类 praise 占比常落在 0.49~0.9 之间（逐-token 似然低，模型嘴上没底），
    // 门槛卡 0.5 会让「小鲸鱼你眼睛真好看」这种在 0.49/0.51 之间来回抖；
    // 而模型真判成别的（如「这回答真厉害 服了」→ tease 领先）时第一名不是 praise，不会被误认。
    const ranked = Object.entries(r.probabilities || {}).sort((a, b) => b[1] - a[1]);
    if (ranked[0] && ranked[0][0] === 'praise' && ranked[0][1] >= 0.45) {
      return { kind: 'praise', raw: r.raw, p: r.p, margin: r.margin, emitted: r.emitted, relaxed: 'praise', source: 'localJev' };
    }
    return { kind: null, raw: r.raw, p: r.p, margin: r.margin, emitted: r.emitted };
  }
  if (!EMOTION_GATE_KINDS.includes(r.choice)) return { kind: null, raw: r.raw, p: r.p, margin: r.margin, emitted: r.emitted };
  let kind = r.choice;
  // 0.8B 极爱把玩闹标成 roast：无脏字、带玩笑词时强制降级 tease
  const hard = /(傻逼|智障|脑瘫|弱智|去死|贱人|滚出去|垃圾玩意|废物点心|你他妈|你妈的|去你妈|滚|滚开|闭嘴|去死吧)/i.test(body);
  const playful = /(哈哈哈|哈哈|笑死|胖鲸|蓝毛|白毛|掉色|贴贴|好菜|菜鸟|才不|明明是|不许叫|鲸鱼|逆天|离谱|草|乐|典)/i.test(body);
  if (kind === 'roast' && !hard && playful) kind = 'tease';
  return { kind, raw: r.raw, p: r.p, margin: r.margin, emitted: r.emitted, source: 'localJev' };
}

/** 接梗 / 玩闹标签复核：只在词表不认时问一次，命中才放行（原逻辑不变）。 */
export async function jevCueKind({ text } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { kind: null, error: 'empty' };
  const g = await jevGate('cueVerifyGate', body.slice(0, 300), { timeoutMs: 2500 });
  if (g.error) return { kind: null, error: g.error };
  if (g.abstain) return { kind: null, raw: g.raw, p: g.p, margin: g.margin, abstain: true };
  if (g.label === '无') return { kind: null, raw: g.raw, p: g.p };
  if (g.label === '梗') return { kind: 'memeOk', raw: g.raw, p: g.p, margin: g.margin, source: 'localJev' };
  if (g.label === '怼') return { kind: 'tease', raw: g.raw, p: g.p, margin: g.margin, source: 'localJev' };
  // 兼容老标签（万一用户手里是旧配置/旧模型）
  if (g.label === 'meme') return { kind: 'memeOk', raw: g.raw, p: g.p, source: 'localJev' };
  if (g.label === 'tease') return { kind: 'tease', raw: g.raw, p: g.p, source: 'localJev' };
  return { kind: null, raw: g.raw, p: g.p };
}

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : (n > 1 ? 1 : n);
}

function numOr(v, dflt) {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/**
 * 群活跃度 heat ∈ [0,1]：0 = 冷清（人少/安静），1 = 热闹（刷屏）。
 *
 * 为什么要它：固定阈值下，小模型在**任何**热闹程度下都用同一把尺子，
 * 结果就是群里正刷屏时它照样频繁插嘴（显得抢戏），群里只剩一个人在自言自语时
 * 它又缩着不动（本该由它接一句）。
 *
 * 用两个和「热闹」直觉一致的指标，各占一半：
 *   · perMin（消息密度）→ rateScore：单位时间有多少条。「火」的直接含义。
 *   · speakers（发言人多样性）→ speakerScore：几个人在说。一个人刷屏 ≠ 群聊热闹，
 *     独白式刷屏时机器人插进去只是多了个自言自语的人，主观上并不需要它。
 * 两个指标分别按 fullRate / fullSpeakers 归一（发言人数那项按平方压缩，见下），
 * 再取加权平均。
 *
 * 注意：
 *   · 排除机器人自己的消息（self:true）—— 否则它插一句抬高热度、热度又压低它插话，
 *     会形成自我强化的振荡。
 *   · 时间跨度按**至少 1 分钟**算，免得「3 条消息挤在 5 秒内」被算成 36 条/分。
 *   · 只读传入的消息数组，不碰全局状态，便于单测和离线复算。
 *
 * @param {Array<{ts:number,self?:boolean,senderId?:string,senderName?:string}>} messages 按时间正序的群消息
 * @returns {{heat:number,n:number,speakers:number,perMin:number,span:number,rateScore:number,speakerScore:number}}
 */
export function computeGroupHeat(messages, { now = Date.now(), windowMinutes = 15, fullRate = 3, fullSpeakers = 5 } = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const winMs = Math.max(1, numOr(windowMinutes, 15)) * 60000;
  const since = now - winMs;
  const inWin = [];
  for (const m of list) {
    if (!m || m.self === true) continue;
    const ts = Number(m.ts);
    if (!Number.isFinite(ts) || ts < since || ts > now) continue;
    inWin.push({ ts, who: String(m.senderId ?? m.senderName ?? m.mid ?? '') || `#${inWin.length}` });
  }
  const n = inWin.length;
  // 窗口内不足 2 条 = 群里基本没人说话，直接算最冷清（不靠 1 条消息外推速率）
  if (n < 2) {
    return { heat: 0, n, speakers: n, perMin: 0, span: 0, rateScore: 0, speakerScore: 0 };
  }
  let minTs = Infinity;
  let maxTs = -Infinity;
  const who = new Set();
  for (const x of inWin) {
    if (x.ts < minTs) minTs = x.ts;
    if (x.ts > maxTs) maxTs = x.ts;
    who.add(x.who);
  }
  const span = Math.max(1, (maxTs - minTs) / 60000);
  const perMin = (n - 1) / span;
  const rateScore = clamp01(perMin / Math.max(0.05, numOr(fullRate, 3)));
  // 发言人项用**平方**而不是线性：(s-1)/(full-1) 后平方。
  // 线性的话「2 人 / 参考 5 人」直接得 0.4，一个只有两三个人慢聊的小群会被算成
  // 中高活跃度 —— 那恰恰是用户最希望机器人多接话的场面（实测：2 人 15 分钟 3 条
  // 线性得 heat 0.22，平方后 0.05，才真的落进"冷清"）。平方把中间段压下去、
  // 只在接近参考人数时才给高分，与"人越多才算越热闹"的直觉一致。
  // 减 1 是让 s=1 归零：只有一个人在说话时，机器人插进去只是多个自言自语的人。
  const speakerSpan = Math.max(1, numOr(fullSpeakers, 5) - 1);
  const speakerScore = Math.pow(clamp01((who.size - 1) / speakerSpan), 2);
  return {
    heat: clamp01(0.5 * rateScore + 0.5 * speakerScore),
    n,
    speakers: who.size,
    perMin,
    span,
    rateScore,
    speakerScore
  };
}

/**
 * 把 heat 折算成这一轮实际使用的插话闸门参数。
 *
 * heat=0 → 完全用 adaptive.quiet 那一套；heat=1 → 完全用 adaptive.busy 那一套；
 * 中间线性插值。**方向对着用户的直觉**：热闹（heat 高）→ 阈值更高、冷却更长、
 * 每小时上限更低 = 更克制；冷清（heat 低）→ 反过来 = 更愿意接话。
 *
 * heat 传 null（或 adaptive 关掉）→ 原样返回顶部那组基准值，
 * 即行为完全回到「没有自适应」之前，方便一键回退与 A/B。
 *
 * dicePercent（可选）= 会话里设的「响应概率」。**骰子退场后它的语义变了**：
 * 从「掷中这个概率就发话」变成「用户希望它整体多主动」。这里把它折算成一个门槛，
 * 与按活跃度算出的门槛各占一半混合 —— 于是两个维度都还起作用：
 * 概率定基调，活跃度在同一基调上下浮动。
 * 不传（null）= 不折算，行为与引入意愿之前完全一致（可一键 A/B）。
 *
 * state（可选）= { favorUsed, emotionBonus }，好感与情绪的原始值。
 * 它们**只作用在 minMargin（间隔门槛）上**，不碰 minConfidence。实测依据：
 *   · 低意愿区（用户设 5% 这类）概率门槛是**死的** —— 从 0.90 一路降到 0.60，
 *     48 条真实插话的通过数恒定 13，一条不动。因为间隔门槛先把高分那批筛掉了。
 *   · 间隔门槛才是唯一有效杠杆（3.46 → 3.20 就多 5 条通过）。
 * 把状态放在概率门槛上等于白给，这是换通道的原因。
 */
// ── 好感 / 情绪对「间隔门槛」的作用幅度 ──
// 为什么作用在间隔门槛而不是概率门槛、为什么改由这里承担（而不是继续乘 randomPercent），
// 见 resolveReplyChanceParams 的 JSDoc 与 prompt.js 里 favorUsed 那段注释。
// 当前是「温和」档：好感从 50 满偏到 0/100 → ±0.18；情绪满值 ±6 → ±0.12；叠加限幅 ±0.30。
// 实测（5% 档 / 48 条真实插话）：约 喜欢 17 条、中性 13 条、厌恶 10 条。
// 想更明显就把这三个数一起等比放大。
const STATE_FAVOR_MARGIN_SPAN = 0.18;
const STATE_EMOTION_MARGIN_SPAN = 0.12;
const STATE_MARGIN_SPAN_CAP = 0.30;

export function resolveReplyChanceParams(rc = {}, heat = null, dicePercent = null, state = null) {
  const base = {
    minConfidence: numOr(rc.minConfidence, 0.6),
    minMargin: numOr(rc.minMargin, 1.0),
    cooldownMs: numOr(rc.cooldownMs, 90000),
    maxPerHour: numOr(rc.maxPerHour, 8)
  };
  const ad = rc.adaptive && typeof rc.adaptive === 'object' ? rc.adaptive : {};
  let out;
  if (heat == null || ad.enabled === false) {
    out = { ...base, heat: null, adaptive: false };
  } else {
    const h = clamp01(heat);
    // ⚠️ 2026-09-22：热度做一次 h^1.6 折算再用。原因是"中等活跃"其实很常见
    //   （heat 0.5 是默认日常工作状态），线性插值会让一半的群长期停在中点附近、
    //   等于平白收紧。取幂后只有**真刷屏**（h→1）才收紧，中等活跃仍偏向用户设定的意愿。
    const hEff = Math.pow(h, 1.6);
    const q = ad.quiet && typeof ad.quiet === 'object' ? ad.quiet : {};
    const b = ad.busy && typeof ad.busy === 'object' ? ad.busy : {};
    const lerp = (k) => {
      const qv = numOr(q[k], base[k]);
      const bv = numOr(b[k], base[k]);
      return qv + (bv - qv) * hEff;
    };
    out = {
      heat: h,
      heatEff: hEff,
      adaptive: true,
      minConfidence: clamp01(lerp('minConfidence')),
      minMargin: Math.max(0, lerp('minMargin')),
      cooldownMs: Math.max(0, Math.round(lerp('cooldownMs'))),
      maxPerHour: Math.max(0, Math.round(lerp('maxPerHour')))
    };
  }

  // ── 「插话意愿」折算（2026-09-22 第三版：**单边联动 / 有界调制**）──────────
  // 响应概率原本是「掷中这个概率就发话」；骰子退场后，它变成用户对「整体该多主动」
  // 的表达。这里把它折成一组门槛与频率，再让群活跃度**只在它附近的有界范围内**微调。
  //
  // 为什么最终定成这样：前两版都是"加权/取严"的合成法，结果用户的显式设置被环境吃掉：
  //   · 第一版 `min(活跃度上限, 意愿上限)` / `max(活跃度间隔, 意愿间隔)` —— 永远取更严的一边；
  //   · 第二版改成加权（高意愿 0.9 意愿 + 0.1 活跃度），仍然会在热闹群里把门槛抬高。
  //   用户实测反馈原话：「90 的回应率都很低」「响应概率和自适应联动冲突了」。
  // 现在一句话能说清：**意愿是主，自适应只能在窄带里调制**（见下面的 band）——
  //   · 门槛最多向低 0.08 概率 / 0.40 间隔（只会更愿意接话）；
  //   · 频率只放宽到最多 1.3 倍上限、最短 0.7 倍冷却，不会压回意愿值；
  //   · 热度先做 h^1.6 折算：中等活跃仍按用户意愿走，热闹时也只保持意愿底线。
  // 于是「意愿 90%」在任何群里都至少有九成该有的机会，低意愿（5%）也照样很挑。
  //
  // 实现上就是四个 min/max：自适应那组值只在"比意愿更宽松"时才被采用
  //   · 概率/间隔门槛：取两者中**更小**的（小 = 更容易开口）
  //   · 每小时上限：取两者中**更大**的
  //   · 冷却：取两者中**更短**的
  if (dicePercent != null) {
    const pct = Math.max(0, Math.min(100, numOr(dicePercent, 0)));
    const s = 1 - pct / 100;              // 严格度：0 = 最主动，1 = 最挑
    const wantConf = 0.5 + s * 0.5;       // 100% → 0.50；5% → 0.975；1% → 0.995
    const wantMargin = 0.8 + s * 4.0;     // 100% → 0.80；5% → 4.60
    const wantCap = Math.max(1, Math.round(pct / 5));       // 100% → 20 次/时；60% → 12
    const wantCd = Math.round(30000 + s * 120000);          // 100% → 30s；60% → 78s

    // ── 单边联动：意愿是主，自适应只能在**有界的范围内**调制 ──
    // 自适应那组值（界面上的冷清端/热闹端）仍然参与计算方向与力度，但每一项都被夹进
    // 意愿值附近的一条带子里 —— 于是"热闹了更克制、冷清了更主动"还在，
    // 却再也不可能把用户显式设的意愿整个吃掉（这正是"90 的回应率都很低"的根因）。
    //   只允许放宽：概率门槛最多低 0.08、间隔门槛最多低 0.40、
    //   每小时上限最多 1.3 倍、冷却最多缩到 0.7 倍；绝不能比用户意愿更严。
    const band = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    out.minConfidence = clamp01(band(numOr(out.minConfidence, wantConf), wantConf - 0.08, wantConf));
    out.minMargin = Math.max(0, band(numOr(out.minMargin, wantMargin), wantMargin - 0.40, wantMargin));
    out.maxPerHour = Math.max(1, Math.round(band(numOr(out.maxPerHour, wantCap), wantCap, wantCap * 1.3)));
    out.cooldownMs = Math.max(30000, Math.round(band(numOr(out.cooldownMs, wantCd), wantCd * 0.7, wantCd)));

    out.intent = pct;
    out.wantCap = wantCap;
    out.wantCd = wantCd;
    // 留痕：自适应这次有没有放宽、有没有被带子夹住，排查时一眼能看到
    const looser = out.maxPerHour > wantCap || out.cooldownMs < wantCd || out.minMargin < wantMargin;
    out.capSource = looser ? 'willingness+adaptive(looser)' : 'willingness';
  }

  // ── 好感 / 情绪的偏移量 ──
  // 只动 minMargin（间隔门槛），**不动 minConfidence**：后者在低意愿区是死的
  // （0.90→0.60 通过数恒定），放上去等于白放，还让「为什么没效果」更难查。
  // 方向：好感高 / 情绪好 → 门槛降低 → 更愿意接话。
  if (state && typeof state === 'object') {
    const fav = Math.max(0, Math.min(100, numOr(state.favorUsed, 50)));
    const emo = Math.max(-6, Math.min(6, numOr(state.emotionBonus, 0)));
    const favOff = -((fav - 50) / 50) * STATE_FAVOR_MARGIN_SPAN;
    const emoOff = -(emo / 6) * STATE_EMOTION_MARGIN_SPAN;
    const off = Math.max(-STATE_MARGIN_SPAN_CAP, Math.min(STATE_MARGIN_SPAN_CAP, favOff + emoOff));
    if (off) {
      out.minMargin = Math.max(0, out.minMargin + off);
      // 留痕用：调用方把这两个值写进 contextReason，以后能复核「当时好感多少」。
      out.stateOffset = off;
      out.favorUsed = fav;
      out.emotionBonus = emo;
    }
  }
  return out;
}

/**
 * 主动插话的「配额闸门」：冷却 + 每小时上限。
 *
 * 抽成纯函数的原因：这套闸门有**两条**进入路径 ——
 *   ① Jev 判 YES 之后（mode='jev'，现在的主路径）
 *   ② 概率骰子直接命中档位 3 时（mode='probability'）
 * 两条路径必须用同一套逻辑与同一份计数 —— 以前骰子那条只在 replyChance.gateDice
 * 打开时才受约束，等于骰子命中的插话可以无限连着发；现在两条一律过闸。
 *
 * 返回 { ok, reason, times }。times 是**已清理过期项**的时间戳数组，由调用方存回
 * （这里不写回状态，保证纯函数可反复调用、可测试）。
 */
export function checkInterjectQuota({ now = Date.now(), lastAt = 0, times = [], cooldownMs = 0, maxPerHour = 0 } = {}) {
  const cd = Math.max(0, numOr(cooldownMs, 0));
  const cap = Math.max(0, numOr(maxPerHour, 0));
  const hourAgo = now - 3600000;
  const alive = (Array.isArray(times) ? times : []).filter((t) => numOr(t, 0) > hourAgo);
  if (cd && now - numOr(lastAt, 0) < cd) {
    return { ok: false, reason: `冷却中（还剩 ${Math.ceil((cd - (now - numOr(lastAt, 0))) / 1000)}s）`, times: alive };
  }
  if (cap && alive.length >= cap) {
    return { ok: false, reason: `本小时插话已达上限 ${cap} 次`, times: alive };
  }
  return { ok: true, reason: '', times: alive };
}

/**
 * 「这轮该不该主动插一句」—— 替代档位 3 的掷骰子。
 *
 * 语义边界（重要）：这里只在**没人叫机器人**（没 @、没命中关键词）的场合问，
 * 所以不需要再区分「被点名回复」和「插嘴」；YES 就意味着「凑上去接一句」。
 *
 * limits：由 resolveReplyChanceParams(heat) 算出的本轮动态阈值（调用方负责算热度）。
 *         不传则用配置里的基准值 —— 两条路径都走这里，保证阈值只有一个出口。
 * 返回 { speak, p, margin, abstain, reason }；任何失败都 speak:false（安静）。
 */
/**
 * 「要不要插嘴」的机械预过滤：这些情况根本不用问模型。
 *
 * 9-19 用 2154 个真实决策点量化过（docs/Jev-蒸馏管道.txt 第三节）：
 *   「@别人 且 几乎没别的内容」→ 模型仍 69% 判该接（基线 92%），是最大错误源；
 *   「纯 @/纯表情/纯标点」→ 没有可接的内容。
 * 这类信号正则就能抓，且只往「不插嘴」方向短路 —— 判错也只是少说一句（保守方向），可逆。
 *
 * @returns {string|null} null = 放行交给模型；字符串 = 短路理由（speak:false）
 */
export function replyChancePrefilter(text) {
  const raw = String(text ?? '');
  const body = raw.trim();
  if (!body) return '预过滤：空内容';

  // 剥掉 CQ 码和 @ 片段后看还剩多少「人话」
  const stripped = body
    .replace(/\[CQ:[^\]]*\]/g, '')            // CQ 码（at/reply/face/image…）
    .replace(/@\S{1,20}/g, '')                // 已人话化的 @xxx
    .replace(/[\s\p{P}\p{S}\p{C}]/gu, '');    // 标点/符号/emoji/控制符

  // 整条只剩 @某人 / 表情 / 标点，没有可接的内容
  if (!stripped) return '预过滤：只有 @/表情/符号，没有内容';

  // @ 定向 且 几乎没别的内容 → 在跟特定的人说话（历史最大错误源）
  const directed = /\[CQ:(at|reply)[^\]]*\]/.test(raw) || /@\S{1,20}/.test(raw);
  if (directed && stripped.length <= 12) return '预过滤：@定向且几乎没内容';

  return null;
}

export async function jevReplyChance({ text, recent = '', limits = null } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return { speak: false, p: 0, margin: 0, abstain: true, reason: 'empty' };
  const rc = getConfig().localJev?.replyChance || {};
  // ① 规则预过滤：机器能判的不花推理（只短路「不插嘴」，永不凭规则放行）
  if (rc.prefilter !== false) {
    const blocked = replyChancePrefilter(body);
    if (blocked) return { speak: false, p: 0, margin: 0, abstain: true, reason: blocked };
  }
  const ready = await ensureLocalJev();
  if (ready && ready.ok === false) {
    return { speak: false, p: 0, margin: 0, abstain: true, reason: ready.reason || 'not-ready' };
  }
  const probe = recent
    ? `${body.slice(0, 160)}\n（刚聊的：${String(recent).slice(0, 120)}）`
    : body.slice(0, 200);
  const g = await jevGate('replyChanceGate', probe, {
    timeoutMs: 3000,
    minConfidence: limits?.minConfidence ?? rc.minConfidence,
    minMargin: limits?.minMargin ?? rc.minMargin
  });
  const heat = limits?.heat ?? null;
  if (g.error) return { speak: false, p: g.p || 0, margin: g.margin || 0, abstain: true, reason: g.error, heat };
  if (g.abstain) {
    return {
      speak: false, label: g.label, p: g.p, margin: g.margin, abstain: true, heat,
      reason: `弃权：概率 ${(g.p || 0).toFixed(2)} / 间隔 ${(g.margin || 0).toFixed(2)}`
    };
  }
  // ② 双问一致性（可选）：本地 YES 再问一遍，两遍都 YES 才算数（热态 ~100ms/问）
  if (g.on && rc.doubleAsk === true) {
    const g2 = await jevGate('replyChanceGate', probe, {
      timeoutMs: 3000,
      minConfidence: limits?.minConfidence ?? rc.minConfidence,
      minMargin: limits?.minMargin ?? rc.minMargin
    });
    if (!g2.on) {
      return {
        speak: false, label: g.label, p: g.p, margin: g.margin, abstain: g2.abstain, heat,
        reason: `双问不一致（第二遍 ${g2.abstain ? '弃权' : g2.label}），视为弃权`
      };
    }
  }
  // ③ 云端二审（可选）：本地 YES → 云端同题复核，双 YES 才真插嘴。
  //    复核挂了按本地结果放行 —— 复核是提精度，不能变成单点故障。
  if (g.on && rc.cloudVerify !== false && cloudJevAvailable()) {
    const spec = JEV_GATE_SPECS.replyChanceGate;
    const labels = spec.labels.map(String);
    const system = `只输出一个词，必须是：${labels.join(' / ')}。不许有别的内容。`;
    const user = [
      String(spec.instruction || '').trim(),
      ...(spec.examples || []).map((e) => `例: ${e[0]} → ${e[1]}`),
      `这句话: ${probe}`,
      '答案:'
    ].filter(Boolean).join('\n');
    const cr = await cloudJevRequest({ system, user, labels, timeoutMs: 6000 });
    if (cr && !cr.error) {
      // 云端判 NO → 听云端的（它 bench 36/38，是更好的裁判）
      if (!labels.includes(cr.raw) || cr.raw !== spec.positive) {
        return {
          speak: false, label: g.label, p: g.p, margin: g.margin, heat,
          reason: `云端二审否决（云端=${cr.raw || '无标签'} 本地=${g.label}）`, cloudVeto: true
        };
      }
    }
    // cr 为 null（云端没配好/限流）或报错 → 按本地结果放行
  }
  return {
    speak: g.on, label: g.label, p: g.p, margin: g.margin, heat,
    probabilities: g.probabilities, channel: g.channel, ms: g.ms, raw: g.raw
  };
}

/**
 * 连发合并的等待窗口该开多长：问一句「他这句说完了吗」。
 *
 * @returns {Promise<{done:boolean|null, p:number, margin:number, abstain:boolean, reason:string}>}
 *   done:true  = 说完了 → 调用方可以把窗口缩到 wakeDelayMs（立刻回）
 *   done:false = 还在说 → 维持聚批窗口
 *   done:null  = **没判出来**（开关关着 / 本地模型没起 / 弃权 / 超时）→ 调用方退回死计时
 *
 * 约定：任何失败都不抛，一律 done:null。防抖判不出来只是"回到老行为"，
 *      绝不能因为本地模型的事把主链路带崩。
 * 只走本地通道（不升级云端）：这条判定的全部意义就是**减小时延**，
 *      升级给云端反而要 1 秒以上，等于把省下的时间又贴回去。
 */
export async function jevBurstDone({ text, recent = '' } = {}) {
  const bj = getConfig().localJev?.burstJudge || {};
  if (bj.enabled !== true) return { done: null, p: 0, margin: 0, abstain: true, reason: 'off' };
  if (!localJevEnabled()) return { done: null, p: 0, margin: 0, abstain: true, reason: 'jev-off' };
  const spec = JEV_GATE_SPECS.burstSettleGate;
  const body = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!body) return { done: null, p: 0, margin: 0, abstain: true, reason: 'empty' };
  const ready = await ensureLocalJev();
  if (ready && ready.ok === false) return { done: null, p: 0, margin: 0, abstain: true, reason: ready.reason || 'not-ready' };
  const input = recent
    ? `${body.slice(0, 120)}\n（他上一条：${String(recent).replace(/\s+/g, ' ').slice(0, 60)}）`
    : body.slice(0, 180);
  const r = await jevAsk({
    role: 'burstSettleGate',
    instruction: spec.instruction,
    labels: spec.labels,
    examples: spec.examples,
    input,
    timeoutMs: Number(bj.timeoutMs) || 2000,
    minConfidence: Number(bj.minConfidence ?? 0.8),
    minMargin: Number(bj.minMargin ?? 1.0),
    channel: 'local'
  });
  if (r.error || r.abstain || !r.label) {
    return { done: null, p: r.p || 0, margin: r.margin || 0, abstain: true, reason: r.error || 'abstain' };
  }
  return { done: r.label === spec.positive, label: r.label, p: r.p, margin: r.margin, abstain: false, raw: r.raw };
}

function draftFromLocal(body) {
  return String(body)
    .split(/\n+/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s.replace(/^(?:回复\s*)?@\S+\s*/u, '').replace(/^#\d{4,}\s*/u, '').trim())
    .filter(Boolean)
    .slice(0, 3);
}

/** 与 Orchestrator.looksLikeNarration 同类的保守否决（避免循环依赖，本地复制精简版）。 */
function localLooksLikeNarration(text) {
  const s = String(text || '');
  if (!s) return true;
  if (/安静结束|处理结束|不用我说话|这轮不用|我先去|我该不该|要不要回|话题翻篇|根据设定|复述历史|内心戏|不回算了|得回一下/.test(s)) return true;
  if (/^[（(【\[]/.test(s) && /表情|装死|潜水|思考|计划/.test(s)) return true;
  if (/^他(?:这句|在说|在管|有点)/.test(s) && s.length < 80) return true;
  return false;
}
