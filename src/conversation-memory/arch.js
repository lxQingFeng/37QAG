// 架构层门面：语义卡片 + 跨轮工作记忆 + 短时跨群感知。
// 本地为主，注入文本极短；可用配置整体关闭。
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { SemanticCardStore } from './semantic-cards.js';
import { CrossTurnWorking } from './cross-turn.js';
import { buildCrossChatAwareness } from './cross-chat.js';
import { renderTodosForPrompt } from './pending.js';
import { shouldReduceOptionalInjects } from './cost-guard.js';

let facade = null;

export function getArchMemory() {
  if (facade) return facade;
  const cardsRoot = path.join(DATA_DIR, 'semantic-cards');
  const workRoot = path.join(DATA_DIR, 'cross-turn');
  const messagesDir = path.join(DATA_DIR, 'messages');
  facade = {
    cards: new SemanticCardStore(cardsRoot),
    working: null, // 随配置重建
    messagesDir,
    workRoot
  };
  return facade;
}

/** 按当前配置取工作记忆实例（TTL/淡忘/长度可热更）。 */
export function getWorking(cfg) {
  const a = getArchMemory();
  const arch = cfg?.api?.architecture || {};
  const ttl = Number(arch.workingTtlMin) || 90;
  const maxChars = Number(arch.workingMaxChars) || 280;
  const decayMin = arch.workingDecayMin === undefined ? 30 : Number(arch.workingDecayMin);
  const decay = Number.isFinite(decayMin) ? Math.max(0, decayMin) : 30;
  const sig = `${Math.max(5, ttl)}|${maxChars}|${decay}`;
  if (!a.working || a.working.sig !== sig) {
    a.working = new CrossTurnWorking(a.workRoot, { ttlMin: ttl, maxChars, decayMin: decay });
    a.working.sig = sig;
  }
  return a.working;
}

/** 是否启用某架构开关（默认开，除非显式 false）。 */
export function archOn(cfg, key) {
  const arch = cfg?.api?.architecture;
  if (!arch || typeof arch !== 'object') return true; // 默认开
  return arch[key] !== false;
}

const nowMs = () => Date.now();
/** chatKey -> Map(卡标题 -> 上次注入时间)。 */
const cardInjectedAt = new Map();
const CARD_REPEAT_WINDOW_MS = 20 * 60 * 1000;

/** 把 20 分钟内已经给过这个会话的卡滤掉，并记下这次给了哪些。 */
export function filterFreshCards(chatKey, hits = [], now = Date.now()) {
  const key = String(chatKey || '');
  let seen = cardInjectedAt.get(key);
  if (!seen) { seen = new Map(); cardInjectedAt.set(key, seen); }
  for (const [k, ts] of seen) if (now - ts > CARD_REPEAT_WINDOW_MS) seen.delete(k);
  const out = [];
  for (const h of hits) {
    const k = String(h?.title || '').slice(0, 40);
    if (!k || seen.has(k)) continue;
    seen.set(k, now);
    out.push(h);
  }
  return out;
}

/**
 * 组装架构注入片段（跨轮 + 语义卡片 + 跨群）。返回短字符串。
 */
export function buildArchitectureInject(cfg, { chatKey, kind, triggerText, botName = '', personIds = [] }) {
  if (!cfg?.api?.conversationMemory?.enabled) return '';
  const parts = [];
  const budgetCut = shouldReduceOptionalInjects(cfg);
  try {
    // 1) 待办（本地状态机；绑人的只在对方出现时注入）
    if (archOn(cfg, 'pendingTodos')) {
      const t = renderTodosForPrompt(chatKey, {
        max: budgetCut.reduce ? 1 : 3,
        personIds
      });
      if (t) parts.push(t);
    }
    // 2) 跨轮工作记忆（只注入进展摘要；消息原文不在此重复）
    if (archOn(cfg, 'crossTurnWorking')) {
      const w = getWorking(cfg).render(chatKey, { botName });
      if (w) parts.push(w);
    }
    // 3) 语义卡片（预算紧时跳过）
    if (archOn(cfg, 'semanticCards') && triggerText && !budgetCut.reduce) {
      const hits = getArchMemory().cards.match(triggerText, {
        chatKey: null,
        limit: Math.min(4, Number(cfg?.api?.architecture?.semanticTopN) || 2)
      });
      // ⚠️ 2026-09-21：同一条卡会在连续几轮里反复被匹配上（实测「去b站搜搜有没」在 5 条
      //   注入样本里出现 3 次）。20 分钟内已经给过这个会话的卡不再重复给 —— 否则它每轮都
      //   看到同一句，要么当噪音，要么当成"还没做完的事"去硬接。
      const fresh = filterFreshCards(chatKey, hits, nowMs());
      if (fresh.length) {
        const lines = fresh.map((h) => `- [${h.type}] ${h.title}`);
        parts.push(`【语义卡】${lines.join('；')}（当常识，别念时间戳）`);
      }
    }
    // 4) 短时跨会话旁听（预算紧时跳过）
    if (archOn(cfg, 'crossChatAwareness') && !budgetCut.reduce) {
      const arch = cfg?.api?.architecture || {};
      const s = buildCrossChatAwareness(
        getArchMemory().messagesDir,
        chatKey,
        {
          minutes: Number(arch.crossChatMinutes) || 12,
          maxChats: Math.min(2, Number(arch.crossChatMaxChats) || 2),
          maxChars: Math.min(200, Number(arch.crossChatMaxChars) || 180)
        }
      );
      if (s) parts.push(s);
    }
  } catch {
    /* 架构注入失败不影响主流程 */
  }
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

/** 运行结束后写入跨轮状态；若上一份已隔开较久，顺带落一张主题卡。 */
export function saveCrossTurn(cfg, chatKey, payload) {
  if (!archOn(cfg, 'crossTurnWorking')) return;
  try {
    const w = getWorking(cfg);
    const prev = w.peekRaw?.(chatKey) || null;
    w.saveAfterRun(chatKey, payload);
    // 上一轮话题已隔开 → 当「刚聊过的事」记进语义卡，避免下次只能考古
    if (prev && archOn(cfg, 'semanticCards')) {
      const gapMs = Date.now() - (Number(prev.at) || 0);
      if (gapMs > 30 * 60 * 1000) {
        const title = String(prev.lastQuery || prev.draft || (prev.sent || [])[0] || '').trim();
        if (title.length >= 8) {
          const detail = [prev.lastQuery, ...(prev.sent || [])].filter(Boolean).join(' / ').slice(0, 160)
            || String(prev.draft || '').slice(0, 160);
          getArchMemory().cards.upsert({
            type: prev.lastQuery ? 'topic' : 'fact',
            chatKey,
            title: title.slice(0, 60),
            detail,
            tags: ['跨轮'],
            source: 'cross-turn',
            ts: Number(prev.at) || Date.now()
          });
        }
      }
    }
  } catch { /* ignore */ }
}

/** 巩固小时块时顺带抽语义卡片。 */
export function ingestSemanticFromHour(chatKey, snippets) {
  try {
    return getArchMemory().cards.ingestHour(chatKey, snippets);
  } catch {
    return 0;
  }
}

export function archStats() {
  return getArchMemory().cards.stats();
}
