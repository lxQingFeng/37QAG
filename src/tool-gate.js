// 工具按需注入（阶段三·目标 1：会话调度省 token）。
//
// 问题：orchestrator 每轮把 20+ 个工具的全量 schema + 工具说明塞进请求。
// 纯闲聊轮次里这些 token 全是白花 —— 小模型面对 20+ 工具还会乱选（见 orchestrator
// 2160 行注释）。参考 AstrBot/RiyaBot 评估报告的「插件级工具不进 prompt」机制，
// 结合 37QAG 自己的 localJev 小模型，做三层门控：
//
//   1. 规则层（零成本，默认开启）：文本信号直接分类
//        - 明显纯闲聊（短、无问句、无信息类关键词）→ 只留核心工具（省 search/media/memory 三类 schema）
//        - 明显要查/要看/要翻 → 全量
//   2. Jev 层（可选，api.toolGate='jev'）：规则判 unknown 时问本地 0.8B「这轮要不要查资料/看图/翻记忆」
//   3. 保底：规则判 unknown 且没开 Jev → 全量（宁可多花 token 不可漏工具）
//
// 发言类工具（send_*）与群聊辅助（get_recent_messages 等）**永远保留**：
// 模型只要开口就必须用 send_message —— 门控只砍「信息获取」面，不砍「表达」面。
//
// 纯函数模块：规则与分类可独立测试；Jev 调用由 orchestrator 侧接入（本模块只给 prompt 规格）。

// ── 工具分类表（未列出的工具一律 'core' = 常驻）─────────────────────────────
export const TOOL_CATEGORIES = Object.freeze({
  // 联网信息：命中"要查外部世界"才注入
  search: new Set(['web_search', 'web_fetch', 'search_images', 'search_bilibili', 'list_bili_fav', 'external_lookup']),
  // 图片/媒体理解：命中"要看图/识图"才注入
  media: new Set(['get_message_images', 'get_sticker_image', 'identify_image', 'parse_video']),
  // 记忆存取：命中"聊旧事/人设资料"才注入
  memory: new Set([
    'memory_append', 'memory_favor', 'memory_query', 'memory_remove',
    'memory_meme_save', 'memory_meme_search', 'memory_search', 'memory_archive',
    'memory_evidence_add', 'memory_evidence_query', 'memory_evidence_correct', 'memory_evidence_remove',
    'memory_todo_save', 'memory_todo_done'
  ])
});

// 信息类信号词（规则层）。命中的词直接归到对应类别。
// ext-* 三类（jev 三级级联 PR1·技能路由规则层）：命中技能信号词 → 注入对应技能类别
//（工具与技能提示词同源过滤，见 skill-bridge.js filterPromptSectionsByCats）。
const SIGNALS = Object.freeze([
  { re: /[?？]$|问[一下个]|帮[我忙].*(查|搜|找|看)|查[一下看个]|搜[一下索个]|搜罗|检索|查查/, cats: ['search'] },
  { re: /天气|气温|下雨|新闻|热点|时事|热搜|百科|是什么|是啥|啥意思|什么意思|解释[一下下]|翻译|算[一下下个]|计算|汇率|股价|比分/, cats: ['search'] },
  { re: /看看?这?[张张图]|图里|图上|认[一下认个]|识图|什么图|识别|这[图张]|看下图|长什么样/, cats: ['media'] },
  { re: /视频|番剧|B站|bilibili|BV[0-9A-Za-z]{8,}/, cats: ['search', 'media'] },
  { re: /以前|上次|之前|上周|上个月|去年|当初|那[时回候]|记得|想[一起下]来|翻[一下翻个]|历史|旧[事账]|那会/, cats: ['memory'] },
  { re: /头像|自拍|照片|发[的过]?.*图|谁[的]?.*图/, cats: ['media', 'memory'] },
  // ── 技能信号词（与上面并集，宁多勿少）──────────────────────────────
  // 精确模式防误伤（方案 §4 风险3：「算了」不命中「算[一下下个]」——正则要求跟字）。
  { re: /天气|气温/, cats: ['ext-info'] },                                     // weather-query
  { re: /算[一下下个]|计算/, cats: ['ext-info'] },                             // calculator
  { re: /什么梗|啥梗|梗的?意思|梗百科|热梗/, cats: ['ext-info'] },              // knowledge-memes
  { re: /画[一张个幅点]|生成[一]?[张个幅]?[图张]|P[一张个图]|来一张图|整一张图/, cats: ['ext-fun'] }, // image-generate / random-image
  { re: /倒序|翻转[一]?[下个]?文[字本]|字数[统计有多少]|统计字数/, cats: ['ext-text'] }            // text-tools
]);

// 纯闲聊排除信号：出现这些**文本形态**时即使短也仍可能是闲聊轮（无信息需求）。
// 语气词/接梗/附和/纯表情描述。
const CHAT_ONLY_RE = Object.freeze([
  /^(哈+|嘿+|呵+|嗯+|哦+|噢+|啊+|呃+|草|艹|卧槽|牛逼|666+|(?:溜了|睡了|来了|走了|散了){1,3}|在的|好的?[叭吧呗呀哦]?|行[吧呗哦呀]?|对[吧呀]?|是[吧呀的]?|ok|OK|ojbk|dddd)[~!！。.……]*$/,
  /^(谢谢|多谢|感谢|辛苦|拜拜|晚安|早安|再见|回见|走了|溜了)[~!！。.…]*$/
]);

/**
 * 规则层分类（纯函数，零成本）。
 * @param {string} text 本轮用户侧聚合文本
 * @param {{ atMe?: boolean, kind?: 'private'|'group', hasImage?: boolean, tier?: number }} [ctx]
 * @returns {{ need: 'none'|'all'|'cats', cats: string[], reason: string }}
 *   need='none'  → 只保留常驻（省 search/media/memory）
 *   need='cats'  → 常驻 + cats 里列的类别
 *   need='all'   → 全量
 */
export function classifyToolNeed(text = '', ctx = {}) {
  const raw = String(text || '').trim();
  // @机器人 / 被点名：宁可全量（这是"被请求"的强信号）
  if (ctx.atMe) return { need: 'all', cats: [], reason: 'at-me' };
  // 私聊（缺陷1修复，noreply 三连诊断 2026-09-28）：私聊每条消息都等效点名，
  // 却曾走了最激进的「闲」级裁剪——jev2 把「你怎么不发！/666/那你快点」判成闲聊、
  // 裁掉 search 类工具，是三连 noreply 的第一环。私聊不做闲级裁剪，直接全量。
  if (ctx.kind === 'private') return { need: 'all', cats: [], reason: 'private-chat' };
  // 消息里带图：媒体工具常驻（识图是高频需求）
  if (ctx.hasImage) return { need: 'cats', cats: ['media'], reason: 'has-image' };
  if (!raw) return { need: 'all', cats: [], reason: 'empty-input' };
  // 长文本（>40 字）：长篇大论大概率有信息需求，全量保底
  if (raw.length > 40) return { need: 'all', cats: [], reason: 'long-text' };
  // 纯闲聊形态（短 + 语气/接梗/告别）→ 信息工具全砍
  if (CHAT_ONLY_RE.some((re) => re.test(raw))) return { need: 'none', cats: [], reason: 'chat-only' };
  // 信号词命中 → 只开对应类别
  const hit = new Set();
  for (const s of SIGNALS) if (s.re.test(raw)) s.cats.forEach((c) => hit.add(c));
  if (hit.size) return { need: 'cats', cats: [...hit], reason: 'signal-words' };
  // 短且无信号：介于闲聊与提问之间 → unknown（由调用方决定：Jev 判或全量保底）
  return { need: 'unknown', cats: [], reason: 'short-ambiguous' };
}

/**
 * 工具名 → 类别（未列出 = 'core' 常驻）。
 * @param {string} toolName 工具名
 * @param {{skillId?: string|null}} [def] 工具定义（技能工具含 skillId；use_xxx 包装工具同样带）
 * @param {Record<string, string>} [skillCats] skillId → 门控类别映射（来自技能清单的 gateCategory，
 *   由 skill-bridge.js 的 skillGateCategories() 提供）。未传 / 未收录的技能 → 'core' 常驻。
 *   ⚠️ 修复（jev 级联 PR1）：此前只按工具名查表，use_xxx 包装技能工具与技能单工具
 *   一律落到 'core' → 技能工具永远保留，门控对技能生态完全失效（方案 §3.2 缺陷②）。
 */
export function categoryOf(toolName, def = null, skillCats = null) {
  const n = String(toolName || '');
  for (const [cat, set] of Object.entries(TOOL_CATEGORIES)) if (set.has(n)) return cat;
  const sid = String(def?.skillId || '').trim();
  if (sid && skillCats && Object.prototype.hasOwnProperty.call(skillCats, sid)) {
    return skillCats[sid];
  }
  return 'core';
}

/**
 * 技能门控类别合法值（manifest.gateCategory 取值域；'core' = 常驻不进门控）。
 */
export const SKILL_GATE_CATEGORIES = Object.freeze(['core', 'search', 'media', 'memory', 'ext-info', 'ext-fun', 'ext-text']);

/**
 * 按门控结果过滤工具定义。
 * @param {Array<{name: string, skillId?: string}>} defs
 * @param {{ need: string, cats: string[] }} verdict
 * @param {Record<string, string>} [skillCats] skillId → gateCategory 映射（categoryOf 用）
 * @returns {Array} 过滤后的 defs（need=all/unknown → 原样全量）
 */
export function filterToolDefs(defs = [], verdict = { need: 'all' }, skillCats = null) {
  if (!Array.isArray(defs)) return [];
  if (!verdict || verdict.need === 'all' || verdict.need === 'unknown') return defs;
  const allow = new Set(Array.isArray(verdict.cats) ? verdict.cats : []);
  return defs.filter((d) => {
    const cat = categoryOf(d?.name, d, skillCats);
    return cat === 'core' || allow.has(cat);
  });
}

/**
 * 工具结果硬截断（阶段三：工具结果硬上限，防单轮 token 爆炸）。
 * RiyaBot 模式（数值自定，非复制）：单工具结果默认 3000 字符（2026-09-28 随 web_fetch
 * 正文提纯从 6000 收紧），超长截断 + 尾注。
 * @param {string} content 工具返回内容
 * @param {number} maxChars 上限（默认 3000）
 */
export function truncateToolResult(content = '', maxChars = 3000) {
  const text = String(content ?? '');
  const limit = Math.max(500, Number(maxChars) || 3000);
  if (text.length <= limit) return text;
  const cut = Math.max(0, limit - 40);
  return `${text.slice(0, cut)}\n…（结果过长已截断，原文 ${text.length} 字符；需要更多细节请换更窄的查询条件）`;
}

/**
 * 一轮工具结果的累计预算（默认 8000 字符，2026-09-28 随正文提纯从 12000 收紧）。
 * 超出后把本轮后续工具结果替换为「预算用尽」提示，逼模型收口。
 * @param {Array<string>} results 本轮已收集的结果
 * @param {number} budget 默认 8000
 */
export function toolResultBudgetLeft(results = [], budget = 8000) {
  const used = (Array.isArray(results) ? results : []).reduce((n, r) => n + String(r || '').length, 0);
  return Math.max(0, (Number(budget) || 8000) - used);
}

// ── Jev 层规格（供 orchestrator 接入 jevGate；此处只声明，不实现调用）──────
// 角色 id：toolNeedGate；labels: TOOL / CHAT。
// instruction（朴素说法，不要加条件 —— 见 local-jev.js 里 replyChanceGate 的实测教训）：
//   '群里有人说话了。判断这轮机器人要不要查资料、看图或翻聊天记录才能接上话，'
//   + '还是直接凭现在聊的内容就能回。'
export const TOOL_GATE_JEV_SPEC = Object.freeze({
  labels: ['TOOL', 'CHAT'],
  instruction: '群里有人说话了。判断这轮机器人要不要查资料、看图或翻聊天记录才能接上话，还是直接凭现在聊的内容就能回。',
  examples: Object.freeze([
    ['这游戏副本怎么打 根本过不去', 'TOOL'],
    ['今天A股又绿了 唉', 'TOOL'],
    ['你上次说的那个链接发我看看', 'TOOL'],
    ['哈哈哈哈笑死', 'CHAT'],
    ['行吧 那先这样', 'CHAT'],
    ['睡了睡了 明天还要早起', 'CHAT']
  ]),
  positive: 'TOOL'
});

// ── jev 级联 PR2：skillRouteGate 五分类 label → 门控类别 ─────────────────────
// ⚠️ 与 local-jev.js JEV_GATE_SPECS.skillRouteGate.map 保持一致（防两处漂移，
//    一致性由 test/tool-gate-test.mjs 断言 —— 同 TOOL_GATE_JEV_SPEC 的做法）。
export const SKILL_ROUTE_LABEL_CATS = Object.freeze({
  '闲': Object.freeze([]),
  '查': Object.freeze(['search']),
  '图': Object.freeze(['media']),
  '忆': Object.freeze(['memory']),
  '技': Object.freeze(['ext-info', 'ext-fun', 'ext-text'])
});

/**
 * jev 级联 PR2：skillRouteGate 判定 → 门控 verdict（纯函数，沙箱可 mock 测试）。
 * @param {{label?: string|null, p?: number, margin?: number}} jev jevGate 的返回
 *   （调用方保证已过滤 error/abstain 才进来；这里只做 label 解释）
 * @param {Record<string, string[]>} [catMap] label→类别（默认 SKILL_ROUTE_LABEL_CATS）
 * @returns {{ need: 'none'|'cats'|'all', cats: string[], reason: string }}
 *   「闲」→ none（只留常驻）；查/图/忆/技 → cats；label 未映射（防御）→ all 全量保底。
 */
export function skillRouteVerdict(jev, catMap = null) {
  const map = catMap || SKILL_ROUTE_LABEL_CATS;
  const label = String(jev?.label ?? '').trim();
  const p = Number(jev?.p) || 0;
  const margin = Number(jev?.margin) || 0;
  const cats = Object.prototype.hasOwnProperty.call(map, label) ? map[label] : undefined;
  if (Array.isArray(cats)) {
    return cats.length
      ? { need: 'cats', cats: [...cats], reason: `jev2:${label}(p=${p.toFixed(2)},margin=${margin.toFixed(1)})` }
      : { need: 'none', cats: [], reason: `jev2:${label}` };
  }
  return { need: 'all', cats: [], reason: `jev2:label未映射(${label || '空'})→全量保底` };
}
