// 群内小游戏 · 引擎 v3
//
// ══ 这一版为什么推倒重来 ══
// v2 在群里真跑了两天，暴露的四类问题都不是"某个游戏写错了"，而是**契约本身缺了约束**：
//
//   ① **机器人替玩家出牌**：注入里写"轮到 1（该报数）"，模型当成"该我报 1 了"，
//      自己调 game_move 把 1、3 都报了；插件再把这份"没人说过的动作"算到最后一个说话的人头上
//      （群里就成了"机器人自己跟自己玩，玩家的 2/4/6 全被忽略"）。
//      → v3：**动作必须能在本次唤醒的群友消息里找到出处**（数字/词能对上），对不上就拒。
//   ② **隐藏信息漏进群**：猜拳第一个人出的拳被公布（"阿狸 出 石头"），后面的人直接克制即可。
//      → v3：游戏用 `secretOf(state)` 声明本局隐藏值，引擎的测试**逐个游戏断言**
//        say/hint 里不出现它（隐藏信息只在结算/揭晓时才允许出现）。
//   ③ **工具返回 undefined**：宿主把工具结果塞进下一条请求，undefined 会让整个请求 400
//      → 那一轮直接死掉，群里表现就是"玩着玩着突然不回复"。
//      → v3：index.js 把每个工具都包了一层，**任何路径都返回 {content: string}**。
//   ④ **注入像命令**：'轮到 X（该报数）'、'要牌或停牌' 这类祈使句会诱导模型动手。
//      → v3：`hint()` 只描述**状态**，不写"该谁做什么"；怎么用工具统一在静态提示词里说。
//
// ══ 游戏模块契约（default 导出）══
//   id / name / aliases / desc                    标识与展示
//   start(cfg, { player, ctx, ...extra })  -> { board, say?, forModel?, reject? }
//   move(cfg, state, { text, player, ctx })-> { board?, say?, forModel?, over?, winner?, reject? }
//   hint(cfg, state)                       -> 一行局面状态（≤60 字；有隐藏答案的 ≤150）
//   secretOf(state)  [可选]                -> 本局**不能提前出现在群里的值**（数组，供测试与守卫用）
//   reveal(cfg, state) [可选]              -> { over: true, say }  收摊/猜通时由插件原样公布
//
//   say      = 群友看得到的（绝不能出现给模型的话；留空 = 这一步插件不发）
//   forModel = 只给模型看的（工具返回值）
//   reject   = 这一步不算：局面不变，理由只给模型
import fs from 'node:fs';
import path from 'node:path';
import { readGame, writeGame, clearGame } from './store.js';

const GAMES_DIR = new URL('./games/', import.meta.url);

/** 注入块的包裹标记（单行，便于整行替换）。 */
export const MARK = '⟦小游戏⟧';

const gamesCache = new Map();
let loading = null;

export function loadGames() {
  loading ||= (async () => {
    let files = [];
    try { files = fs.readdirSync(GAMES_DIR).filter((f) => f.endsWith('.js')); } catch { /* 目录缺失 */ }
    for (const f of files.sort()) {
      try {
        const mod = await import(new URL(f, GAMES_DIR));
        const g = mod?.default;
        if (g?.id && typeof g.start === 'function' && typeof g.move === 'function' && typeof g.hint === 'function') {
          gamesCache.set(String(g.id), g);
        }
      } catch { /* 单个游戏坏了不影响其它 */ }
    }
    return gamesCache;
  })();
  return loading;
}

export function gameSync(id) { return gamesCache.get(String(id || '')); }
export function listGames() {
  return [...gamesCache.values()].map((g) => ({ id: g.id, name: g.name, desc: g.desc, aliases: g.aliases || [] }));
}

export function resolveGame(name) {
  const raw = String(name || '').trim();
  const all = [...gamesCache.values()];
  if (!all.length) return null;
  if (!raw || /^(随机|随便|任意|random)$/i.test(raw)) return all[Math.floor(Math.random() * all.length)];
  const low = raw.toLowerCase();
  for (const g of all) {
    if (g.id === low || String(g.name) === raw) return g;
    if ((g.aliases || []).some((a) => String(a) === raw || String(a).toLowerCase() === low)) return g;
  }
  for (const g of all) {
    if (String(g.name) && raw.includes(String(g.name))) return g;
    if ((g.aliases || []).some((a) => a && raw.includes(String(a)))) return g;
  }
  return null;
}

/**
 * 这一行是不是**机器人自己发出去的播报**（不是群友说的话）。
 * 用途：同群多实例时，别把对方实例的播报当成"群友的动作"喂进判定。
 */
const OWN_OUTPUT = [
  /^【海龟汤/, /^【汤底/, /^【小游戏/, /^⟦小游戏/, /^「.+」收摊了/,
  /^第 ?\d+ ?问（/, /掷出 \d+/, /猜 \d+[:：]/, /^🎉/, /^结算[:：]/, /出 ?(了)?(石头|剪刀|布|拳)/
];
export function looksLikeOwnOutput(text) {
  const t = String(text || '').trim();
  return !!t && OWN_OUTPUT.some((re) => re.test(t));
}

/** 从一段话里抽"能对号入座"的 token：数字，以及 ≥2 字的连续汉字（去掉 @/CQ/括号内容）。 */
export function tokensOf(text) {
  const t = String(text || '')
    .replace(/\[CQ:[^\]]*\]/g, ' ')
    .replace(/@[^\s@]{0,20}/g, ' ')
    .replace(/[（(][^）)]*[）)]/g, ' ');
  return [...new Set([...(t.match(/\d+/g) || []), ...(t.match(/[\u4e00-\u9fa5]{2,}/g) || [])])];
}

/** 本次唤醒里"像人说的"消息（排掉机器人自己的播报）。 */
function humanMessages(ctx) {
  const out = [];
  const push = (m) => {
    if (!m || m.self) return;
    if (!m.senderId && !m.senderName) return;
    if (looksLikeOwnOutput(m.text)) return;
    out.push(m);
  };
  try { (ctx?.session?.trigger || []).forEach(push); } catch { /* ignore */ }
  try { (ctx?.store?.recent?.(ctx.chatKey, { limit: 12, includeSelf: false }) || []).forEach(push); } catch { /* ignore */ }
  return out;
}

const whoOf = (m) => (m ? { id: String(m.senderId || ''), name: String(m.senderName || m.senderId || '') } : null);

/**
 * 这一步是谁做的 + **它到底有没有发生过**。
 *
 * 这是 v3 最重要的一条约束：模型很爱"替群友把该走的一步走掉"——
 * 注入里写着"轮到 1"，它就自己调 game_move("1")，插件再把这份没人说过的动作
 * 算到最后说话的人头上（群里就成了机器人自己跟自己玩）。
 *   · 动作里有可对号的 token（数字/词）→ 必须在本次唤醒/最近的群友消息里找到出处，否则拒；
 *   · 动作里没有 token（「掷」「开」「过」「要」「停」）→ 认人只能靠"最后一个说话的人"，
 *     这时不做出处校验（否则正常出牌会被误拒）。
 */
function groundMove(text, ctx) {
  const humans = humanMessages(ctx);
  if (!humans.length) return { ok: true, player: null, why: 'no-human-context' };
  const tokens = tokensOf(text);
  if (!tokens.length) return { ok: true, player: whoOf(humans[humans.length - 1]), why: 'no-token' };
  for (let i = humans.length - 1; i >= 0; i -= 1) {
    const t = String(humans[i].text || '');
    if (tokens.some((k) => t.includes(k))) return { ok: true, player: whoOf(humans[i]), why: 'matched' };
  }
  return { ok: false, player: null, tokens };
}

function newState(game, player) {
  return { game: game.id, at: Date.now(), host: player || null, over: false, winner: null, turns: 0, board: {}, log: [] };
}

/** 开一局。除引擎自己的字段外，其余参数原样透传给游戏（海龟汤的 puzzle/solution 就这么进来的）。 */
export function startGame(cfg, chatKey, { game, player, force = false, ctx = null, ...extra } = {}) {
  const existing = readGame(chatKey, { ttlMinutes: cfg.idleTtlMinutes });
  if (existing && !force) {
    const g = gameSync(existing.game);
    return { ok: false, say: `这个会话已经有一局「${g?.name || existing.game}」在进行中（第 ${existing.turns} 步）。想重开就先 game_stop 结束它。` };
  }
  const g = resolveGame(game);
  if (!g) return { ok: false, say: `没有叫「${game}」的游戏。现在有：${listGames().map((x) => x.name).join('、')}。` };
  const state = newState(g, player);
  const r = g.start(cfg, { ...extra, player, ctx }) || {};
  if (r.reject) return { ok: false, say: r.say || '这个开局参数不合法。' };
  state.board = r.board || {};
  writeGame(chatKey, state);
  return { ok: true, state, say: String(r.say || `「${g.name}」开始了。`), forModel: String(r.forModel || '') };
}

/** 群友的一步。text 必须是**群友原话**（引擎会校验它在本次唤醒里找得到出处）。 */
export function moveGame(cfg, chatKey, { text, player = null, ctx = null } = {}) {
  const state = readGame(chatKey, { ttlMinutes: cfg.idleTtlMinutes });
  if (!state) return { ok: false, forModel: '这个会话现在没有进行中的游戏。想开一局就 game_start。' };
  const raw = String(text || '').trim();
  if (!raw) return { ok: false, forModel: '没给玩家原话。把他说的话原样传进来。' };
  if (looksLikeOwnOutput(raw)) {
    return { ok: false, forModel: '这一步看着是机器人自己的播报，不是群友说的话，已忽略。' };
  }
  const grounded = groundMove(raw, ctx);
  if (!grounded.ok) {
    return {
      ok: false,
      forModel: `这一步在群里找不到出处（没人说过含「${grounded.tokens.join('、')}」的话），所以不算数。`
        + '不要替群友出牌/报数/猜数：只有群友**自己说过**的那一步才用 game_move 传进来。'
    };
  }
  const g = gameSync(state.game);
  if (!g) return { ok: false, forModel: `游戏模块「${state.game}」没加载出来，先 game_stop 收摊吧。` };

  const r = g.move(cfg, state, { text: raw, player: player || grounded.player, ctx }) || {};
  if (r.reject) return { ok: false, forModel: String(r.forModel || r.say || '这一步不合法。'), state };
  state.turns = (Number(state.turns) || 0) + 1;
  if (r.board) state.board = r.board;
  if (r.winner) state.winner = r.winner;
  if (r.over) state.over = true;
  state.log = [...(state.log || []), { t: Date.now(), p: (player || grounded.player)?.name || '', m: raw.slice(0, 40) }].slice(-6);

  if (state.over) clearGame(chatKey);
  else writeGame(chatKey, state);
  return {
    ok: true, state, over: !!state.over, winner: state.winner || null,
    say: String(r.say || ''),
    forModel: String(r.forModel || r.say || '这一步已判定。')
  };
}

/** 收摊。reveal=true 时先由插件把答案原样公布了再清盘（海龟汤用）。 */
export function stopGame(cfg, chatKey, { reason = '', reveal = false } = {}) {
  const state = readGame(chatKey, { ttlMinutes: cfg.idleTtlMinutes });
  if (!state) return { ok: false, say: '本来就没有进行中的游戏。' };
  const g = gameSync(state.game);
  let tail = '';
  if (reveal && typeof g?.reveal === 'function') {
    try { tail = `\n${String((g.reveal(cfg, state) || {}).say || '')}`; } catch { /* 揭晓失败也得收摊 */ }
  }
  clearGame(chatKey);
  return {
    ok: true, reveal: !!tail,
    say: `「${g?.name || state.game}」收摊了${state.turns ? `（走了 ${state.turns} 步）` : ''}${reason ? `：${reason}` : '。'}${tail}`
  };
}

/**
 * 本局**不能提前出现在群里**的值（泄漏守卫 + 测试用）。
 * 游戏用 `secretOf(state)` 声明；海龟汤这种"汤底"另有 spoilerOf（按整段拦）。
 * 太短的（<6 字）不参与按原文拦截 —— 那会误伤正常发言，交给提示词约束。
 */
export function secretOf(cfg, chatKey) {
  try {
    const state = readGame(chatKey, { ttlMinutes: cfg.idleTtlMinutes });
    if (!state || state.over) return [];
    const g = gameSync(state.game);
    if (!g) return [];
    const list = typeof g.secretOf === 'function' ? (g.secretOf(state) || []) : [];
    return list.map(String).filter((v) => v.length >= 2);
  } catch { return []; }
}

/** 给泄漏守卫用的整段文本（海龟汤的汤底这种"抄了就算漏"的长文本）。 */
export function spoilerOf(cfg, chatKey) {
  try {
    const state = readGame(chatKey, { ttlMinutes: cfg.idleTtlMinutes });
    if (!state || state.over) return '';
    const g = gameSync(state.game);
    if (!g || typeof g.spoilerOf !== 'function') return '';
    const s = String(g.spoilerOf(state) || '');
    return s.length >= 6 ? s : '';
  } catch { return ''; }
}

/** 诊断/测试用。 */
export function boardOf(cfg, chatKey) {
  const state = readGame(chatKey, { ttlMinutes: cfg.idleTtlMinutes });
  if (!state) return null;
  const g = gameSync(state.game);
  return { state, game: g, line: hintLine(cfg, chatKey) };
}

/**
 * 注入提示词的**一行**局面。只报状态（不写"该谁做什么"），≤60 字（有隐藏答案的 ≤150）。
 * index.js 的钩子会先把上一轮的这一行删掉再追加，所以上下文里永远只有一份。
 */
export function hintLine(cfg, chatKey) {
  const state = readGame(chatKey, { ttlMinutes: cfg.idleTtlMinutes });
  if (!state || state.over) return '';
  const g = gameSync(state.game);
  const body = g ? String(g.hint(cfg, state) || '') : '（局面模块未加载）';
  return `${MARK}${g?.name || state.game}｜${body}${MARK}`;
}
