// 群内小游戏 · 技能入口 v3（工具 + 三个钩子）
//
// ══ 底座：0.4 版 ══
// 这个包只用到 0.4（`E:\QQ\QQ-Agent 0.4 preview`，逐项核对过）就有的东西：
//   · `../../src/config.js` 的 DATA_DIR（与 0.4 逐字节相同的文件）
//   · `api.registerTool` / `api.config` / `api.log`，以及 `activate()` 生命周期
//   · 三个钩子：before-llm-messages / before-tool / after-response（0.4 都会调，入参带 chatKey）
//   · 工具 ctx 里的 chatKey / session / store / sender（0.4 的 ctx 都有）
// 不引用 `src/local-jev.js`（0.4 没这个文件）、不用任何 0.5 专属 API。
// 引擎与泄漏检测**懒加载**：lib 缺文件或新旧混装时只降级，不让整个技能加载失败
// （群里那次"灰的点不开"就是这么来的）。
//
// ══ v3 相比 v2 的四条硬约束 ══
//   ① 工具返回**永不为空**：宿主会把工具结果放进下一条请求，undefined 会让整个请求 400
//      → 那一轮直接死掉，群里就是"玩着玩着突然不回复"。这里每个 execute 都过一层包装，
//      任何路径（含抛错）都返回 { content: string }。
//   ② 不替群友出牌：判定交给引擎，引擎会校验"这一步在本次唤醒的群友消息里找得到出处"。
//   ③ 群里只说群友该看的：say / forModel 分开，内部说明绝不进群。
//   ④ 隐藏信息（暗牌、手牌、谜底…）由游戏的 secretOf 声明，测试逐个断言它不出现在 say/hint 里。
//
// ══ 省 token ══
//   工具只留 3 个（开局 / 出牌 / 收摊），描述只说"什么时候用"；玩法在 skill.json 的静态片段里
//   （跨运行缓存）。每轮只注入一行局面，且每轮先删旧的再追加 —— 上下文里永远只有一份。
import { DATA_DIR } from '../../src/config.js';

// ── 懒加载引擎（半截复制也能装上，只降级）──
let engine = {};
let leakMod = {};
let engineReady = null;
let engineError = '';

async function ensureEngine() {
  engineReady ||= (async () => {
    try { engine = await import('./lib/engine.js'); } catch (e) { engineError = String(e?.message ?? e); }
    try { leakMod = await import('./lib/leak.js'); } catch (e) { engineError ||= String(e?.message ?? e); }
    const missing = REQUIRED_EXPORTS.filter((k) => typeof engine[k] !== 'function');
    if (missing.length) engineError ||= `引擎导出不全，缺 ${missing.join('、')}`;
    if (engineError) log(`⚠️ 群内小游戏：${engineError} —— 多半是 skills/mini-games/ 没复制全，请把整个目录重新复制一遍。`);
    return engine;
  })();
  return engineReady;
}

const REQUIRED_EXPORTS = [
  'loadGames', 'listGames', 'startGame', 'moveGame', 'stopGame', 'hintLine', 'spoilerOf', 'looksLikeOwnOutput'
];
const BROKEN = '小游戏引擎没加载成功（lib/ 缺文件或版本不匹配）：请把 skills/mini-games/ **整个目录**重新复制一遍。';
const MARK = '⟦小游戏⟧';
const INJECT_RE = new RegExp(`${MARK}[^\\n]*${MARK}`, 'g');

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log || (() => {});

  const guard = () => (cfg().enabled === false ? '小游戏被管理员关掉了（设置 → 技能 → 群内小游戏）。' : '');
  /** 一局当前的局面行（给工具返回补一行，模型就知道现在什么状态）。 */
  const boardLine = (ctx) => {
    try { const l = engine.hintLine?.(cfg(), ctx?.chatKey) || ''; return l ? `\n${l}` : ''; } catch { return ''; }
  };
  /**
   * 所有工具的统一外壳：**保证返回 { content: string }**。
   * 这是 v3 的第一条硬约束 —— undefined 会污染下一条请求（宿主把它塞进 tool 消息），
   * 模型 API 直接 400，那一轮就静默死掉（群里表现＝"玩着玩着突然不回复"）。
   */
  const tool = (def) => api.registerTool({
    ...def,
    execute: async (ctx, args) => {
      try {
        const r = await def.execute(ctx, args);
        if (r && typeof r.content === 'string' && r.content) return r;
        const text = r && typeof r.content !== 'undefined' ? String(r.content) : '';
        return { content: text || '（这一步没有可说的内容，局面没变。）', isError: !!r?.isError };
      } catch (error) {
        return { content: `小游戏这一步出错了：${error?.message ?? error}`, isError: true };
      }
    }
  });

  // ── 1/3 开一局 ──
  tool({
    id: 'game_start',
    name: '开小游戏',
    description: '在群里开一局小游戏。game 填游戏名（清单见系统提示）或「随机」；已经有别的一局时会拒绝。',
    category: 'utility',
    icon: '🎮',
    parameters: {
      type: 'object',
      properties: {
        game: { type: 'string', description: '游戏名，或「随机」' },
        force: { type: 'boolean', description: '已有牌局时是否顶掉重开' },
        puzzle: { type: 'string', description: '仅海龟汤自定义题：汤面' },
        solution: { type: 'string', description: '仅海龟汤自定义题：汤底（绝不能说出去）' },
        title: { type: 'string', description: '仅海龟汤自定义题：小标题' }
      },
      required: ['game']
    },
    async execute(ctx, args) {
      const bad = guard();
      if (bad) return { content: bad, isError: true };
      await ensureEngine(); await engine.loadGames?.();
      const r = engine.startGame?.(cfg(), ctx.chatKey, {
        game: args?.game,
        player: playerOf(ctx, String(args?.game || '')),
        force: args?.force === true,
        ctx,
        ...({ puzzle: args?.puzzle, solution: args?.solution, title: args?.title })
      }) || { ok: false, say: BROKEN };
      if (!r.ok) return { content: r.say || BROKEN, isError: true };
      const sent = await say(ctx, r.say);
      const head = sent ? `开场白已经发出去了（「${String(r.say).slice(0, 40)}」）。` : `要说的话：${r.say}`;
      return { content: `${head}${r.forModel ? `\n${r.forModel}` : ''}${boardLine(ctx)}` };
    }
  });

  // ── 2/3 群友出牌 ──
  tool({
    id: 'game_move',
    name: '把群友这一步交给插件判定',
    description: '群友本人出了一步时调用（猜数、掷、接龙、出拳、落子、提问…）：把他的原话传进 text，'
      + '判定由插件给出。别自己判、也别替群友出牌。',
    category: 'utility',
    icon: '🎯',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: '群友这一步的原话，例如「我猜 50」' } },
      required: ['text']
    },
    async execute(ctx, args) {
      const bad = guard();
      if (bad) return { content: bad, isError: true };
      await ensureEngine(); await engine.loadGames?.();
      const text = String(args?.text || '').trim();
      const r = engine.moveGame?.(cfg(), ctx.chatKey, { text, player: playerOf(ctx, text), ctx }) || { ok: false, forModel: BROKEN };
      if (!r.ok) return { content: r.forModel || BROKEN, isError: true };
      const sent = await say(ctx, r.say);
      const tail = r.over
        ? '（这局结束了，结果已经发出去；要补一句话由你决定，但别复述结果。）'
        : (sent ? '（结果已经发出去了。没别的话就结束这一轮，别再复述。）' : '');
      return { content: `${r.forModel}${tail ? `\n${tail}` : ''}${boardLine(ctx)}` };
    }
  });

  // ── 3/3 收摊（reveal=true 时先公布答案）──
  tool({
    id: 'game_stop',
    name: '结束小游戏',
    description: '结束当前这局（群友说「不玩了」，或已经分出结果时）。reveal=true 时先把答案原样公布出来。',
    category: 'utility',
    icon: '🛑',
    parameters: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: '为什么结束（可省）' },
        reveal: { type: 'boolean', description: '收摊前先公布答案' }
      }
    },
    async execute(ctx, args) {
      await ensureEngine(); await engine.loadGames?.();
      const r = engine.stopGame?.(cfg(), ctx.chatKey, {
        reason: String(args?.reason || ''), reveal: args?.reveal === true
      }) || { ok: false, say: BROKEN };
      if (!r.ok) return { content: r.say || BROKEN };
      const sent = await say(ctx, r.say);
      return { content: sent ? '收摊的话已经发出去了。' : `要说的话（原样发出去）：${r.say}` };
    }
  });
}

// ── 钩子 ──
//   ① before-llm-messages：把局面注入到最后一条 user 消息（一行；先删旧的再加新的）
//   ② before-tool：泄漏守卫 L1 —— 模型把"不能提前说的东西"（海龟汤汤底）抄进 send_* 参数就拦下
//   ③ after-response：泄漏守卫 L2 —— 模型把它写进**正文**时在源头抹掉
//      （正文补发那条路径不经过 before-tool，所以必须有 L2）
export const hooks = {
  'before-llm-messages': async ({ messages, chatKey }) => {
    if (cfg().enabled === false) return;
    await ensureEngine();
    stripInjection(messages);
    const line = engine.hintLine?.(cfg(), chatKey) || '';
    if (line) appendToLastUser(messages, line);
  },

  'before-tool': async ({ toolName, argsRaw, chatKey }) => {
    if (cfg().enabled === false) return;
    await ensureEngine();
    // 小游戏自己的工具不查：game_start 带 solution 是合法开局参数，
    // game_move 的 text 是群友原话（他自己猜中答案正是游戏的目的）。
    if (String(toolName || '').startsWith('mini-games__')) return;
    const secret = engine.spoilerOf?.(cfg(), chatKey) || '';
    if (!secret) return;
    const chunk = leakMod.leakedChunk?.(String(argsRaw || ''), secret) || '';
    if (!chunk) return;
    return {
      block: true,
      reason: `【泄漏拦截】这次 ${toolName} 里有 ${chunk.length} 个字是这一局**不能提前说出去**的答案，不能发。`
        + '按游戏规则回话（海龟汤只回「是/不是/无关/部分是」），要公布就走 game_stop（reveal=true）。'
    };
  },

  'after-response': async ({ response, chatKey }) => {
    if (cfg().enabled === false) return;
    await ensureEngine();
    const secret = engine.spoilerOf?.(cfg(), chatKey) || '';
    if (!secret) return;
    const hits = redactSecret(response, secret);
    if (hits) log(`小游戏：模型正文里抄了不能说的答案，已在发送前抹掉（${hits} 处）`);
  }
};

/** 加载时预热（游戏注册表是异步扫描的；工具与钩子都依赖它）。 */
export async function activate() {
  try { await ensureEngine(); await engine.loadGames?.(); } catch { /* 单个游戏坏了不影响别的 */ }
  try { log(`群内小游戏已加载：${engine.listGames?.().length ?? 0} 个游戏`); } catch { /* 日志无所谓 */ }
}

// ── 内部工具 ──

/**
 * 这一步是谁做的。
 * 优先用"本次唤醒的群友消息"（带真实发送者），拿模型传来的文本里的数字/词对号入座；
 * 对不上就退回最后一个说话的人。**真正的"这一步存不存在"由引擎 groundMove 判定**，
 * 这里只负责认人。
 */
function playerOf(ctx, hint = '') {
  const cands = [];
  const push = (m) => {
    if (!m || m.self) return;
    if (!m.senderId && !m.senderName) return;
    if (engine.looksLikeOwnOutput?.(m.text)) return;
    cands.push(m);
  };
  try { (ctx?.session?.trigger || []).forEach(push); } catch { /* ignore */ }
  try { (ctx?.store?.recent?.(ctx.chatKey, { limit: 12, includeSelf: false }) || []).forEach(push); } catch { /* ignore */ }
  if (!cands.length) return null;
  const make = (m) => ({ id: String(m.senderId || ''), name: String(m.senderName || m.senderId || '') });
  const tokens = engine.tokensOf?.(hint) || [];
  if (tokens.length) {
    for (let i = cands.length - 1; i >= 0; i -= 1) {
      const t = String(cands[i].text || '');
      if (tokens.some((k) => t.includes(k))) return make(cands[i]);
    }
  }
  return make(cands[cands.length - 1]);
}

/**
 * 由插件直接把这句话发到群里（走 ctx.sender 的发送队列：串行/限频/去重/留档）。
 * @returns {boolean} 是否真的发出去了
 */
async function say(ctx, text) {
  const body = String(text || '').trim();
  if (!body) return false;                       // 空 = 这一步插件不发（由模型自己说）
  if (cfg().announceInGroup === false) return false;
  try {
    await ctx.sender.sendTextBatch(ctx.chatKey, [body]);
    try {
      ctx.session?.sent?.push({
        type: 'text', text: body,
        at: new Date().toLocaleTimeString('zh-CN', { hour12: false })
      });
    } catch { /* 留档失败不影响已发出的消息 */ }
    return true;
  } catch {
    return false;                                // 发失败也别吞结果：交给模型说
  }
}

/** 删掉历史里所有旧的注入行（只认我们自己那种单行标记）。 */
function stripInjection(messages) {
  const arr = Array.isArray(messages) ? messages : [];
  for (const m of arr) {
    if (!m || m.role !== 'user') continue;
    if (typeof m.content === 'string') {
      if (m.content.includes(MARK)) m.content = m.content.replace(INJECT_RE, '').replace(/\n+$/, '');
      continue;
    }
    if (Array.isArray(m.content)) {
      for (const part of m.content) {
        if (part && typeof part.text === 'string' && part.text.includes(MARK)) {
          part.text = part.text.replace(INJECT_RE, '').replace(/\n+$/, '');
        }
      }
    }
  }
}

/** 把一行局面追加到最后一条 user 消息末尾（原地改，不改结构）。 */
function appendToLastUser(messages, lineText) {
  const arr = Array.isArray(messages) ? messages : [];
  const last = [...arr].reverse().find((m) => m && m.role === 'user');
  if (!last) return false;
  const suffix = `\n${lineText}`;
  if (Array.isArray(last.content)) {
    const texts = last.content.filter((p) => p && p.type === 'text');
    if (!texts.length) return false;
    const cur = String(texts[texts.length - 1].text || '');
    if (cur.includes(MARK)) return false;
    texts[texts.length - 1].text = `${cur}${suffix}`;
    return true;
  }
  if (typeof last.content !== 'string') return false;
  if (last.content.includes(MARK)) return false;
  last.content = `${last.content}${suffix}`;
  return true;
}

/** L2：把模型正文里的答案抹掉（整段都是答案就干脆不发）。 */
function redactSecret(response, secret) {
  const msg = response?.message;
  if (!msg) return 0;
  let hits = 0;
  if (typeof msg.content === 'string') {
    const r = leakMod.stripSecret?.(msg.content, secret) || { hits: 0 };
    if (r.hits) {
      msg.content = (String(r.text).replace(/（略）/g, '').trim().length < 4) ? null : r.text;
      hits += r.hits;
    }
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (part && typeof part.text === 'string') {
        const r = leakMod.stripSecret?.(part.text, secret) || { hits: 0 };
        if (r.hits) { part.text = r.text; hits += r.hits; }
      }
    }
  }
  return hits;
}

// 测试出口（不参与运行时逻辑）
export const internals = {
  playerOf, stripInjection, appendToLastUser, redactSecret, DATA_DIR,
  REQUIRED_EXPORTS
};
