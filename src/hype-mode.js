import { getConfig, updateConfig } from './config.js';
import { cleanHypeResidue } from './hype-clean.js';
import { PERSONAS } from './personas.js';

/** 这段人设是不是亢奋卡（防止把亢奋卡当成原卡存进去/还原回去）。 */
function looksLikeHypeRole(text) {
  return /##\s*亢奋模式/.test(String(text || ''));
}

/** 正常形态默认卡：优先当前正常存档，再试异色鱼，最后退回内置小鲸鱼。 */
function defaultNormalRoleText() {
  try {
    const list = getConfig().customPersonas || [];
    const keys = ['当前正常', '异色版·整理后精简', '整理后精简'];
    for (const key of keys) {
      const hit = list.find((p) => p && String(p.name || '').includes(key));
      const t = String(hit?.roleText || hit?.text || '').trim();
      if (t && !looksLikeHypeRole(t)) return t;
    }
  } catch { /* ignore */ }
  return PERSONAS.xiaojingyu.text;
}

/**
 * 关亢奋时要还原的正常人设。
 *
 * ⚠️ 2026-09-22：以前兜底会返回 `defaultNormalRoleText()`（目录里的"正常卡"，实测 4484 字），
 *   而用户在用的卡是 6575 字 —— 只要 saved 是空的（开亢奋时当前卡已被认成亢奋卡、
 *   或者干脆是旧版留下的空存档），关一次亢奋就会把用户手写的整张卡换成目录卡，静默无提示。
 *   现在顺序是：saved（且不是亢奋卡）→ 当前卡（且不是亢奋卡）→ **保持当前卡原样**。
 *   目录卡只在"两处都空"这种极端情况下才用，且会打日志说明。
 */
function pickNormalRoleText(savedRole, currentRole) {
  const candidates = [savedRole, currentRole];
  for (const t of candidates) {
    const s = String(t || '').trim();
    if (s && !looksLikeHypeRole(s) && !/##\s*亢奋/.test(s)) return s;
  }
  const current = String(currentRole || '').trim();
  if (current) {
    // 当前卡看起来像亢奋卡又没有正常存档：宁可留着它（用户能自己改回来），
    // 也不要用目录卡覆盖 —— 覆盖是不可逆的数据丢失。
    console.warn('[hype] 关闭亢奋：没有可用的正常存档，角色卡保持原样（不替换成目录卡）');
    return current;
  }
  console.warn('[hype] 关闭亢奋：没有存档也没有当前卡，回落到内置默认卡');
  return defaultNormalRoleText();
}

/** 当前是否处于亢奋模式（只能手动切，不会自动触发）。 */
export function isHypeMode() {
  return getConfig().hypeMode?.enabled === true;
}

/**
 * 亢奋模式硬保护 QQ。发行版默认空 = 不锁任何人。
 * 可在 config.hypeMode.protectedQQ 配置。
 */
export function getHypeProtectedQQ() {
  try {
    const v = getConfig().hypeMode?.protectedQQ;
    const s = String(v ?? '').trim();
    return /^\d{5,15}$/.test(s) ? s : '';
  } catch {
    return '';
  }
}

/** @deprecated 兼容旧引用；请用 getHypeProtectedQQ() */
export const HYPE_PROTECTED_QQ = '';

/** 亢奋模式只保留的工具：会发言就行。 */
export const HYPE_TOOLS = ['send_message', 'finish'];

/** 仅亢奋模式下判断目标是否受保护；关掉亢奋后不拦。 */
export function isHypeProtectedTarget(id) {
  if (!isHypeMode()) return false;
  const lock = getHypeProtectedQQ();
  if (!lock) return false;
  const s = String(id ?? '').trim();
  return s === lock || s === `qq_${lock}`;
}

/** 亢奋模式下净化 @/拍一拍目标：受保护账号直接剥掉。 */
export function sanitizeHypeProtectedArgs(args = {}) {
  if (!isHypeMode()) return { args, strippedAt: false, blockedPoke: false };
  const next = { ...args };
  let strippedAt = false;
  let blockedPoke = false;
  if (isHypeProtectedTarget(next.atUserId)) {
    next.atUserId = null;
    strippedAt = true;
  }
  if (isHypeProtectedTarget(next.targetUserId)) {
    next.targetUserId = null;
    blockedPoke = true;
  }
  return { args: next, strippedAt, blockedPoke };
}

/**
 * 开/关亢奋模式。
 * 开：模型换到 hypeMode.model、systemMode=hype、人设换 roleText、工具砍到 HYPE_TOOLS；
 *     原值临时存进 hypeMode.saved。
 * 关：人设/协议/工具还原 saved；模型优先 hypeMode.restoreModel（默认 qwen3.8-flash）。
 */
export async function setHypeMode(on) {
  const cfg = getConfig();
  const hm = { ...(cfg.hypeMode || {}) };
  const persona = { ...(cfg.persona || {}) };
  const api = { ...(cfg.api || {}) };
  const wants = !!on;

  if (wants === !!hm.enabled) {
    // 已经开着：强制锁回亢奋极简状态（系统 + 工具）
    if (wants) {
      const patch = {};
      if (persona.systemMode !== 'hype' || persona.compactSystemPrompt !== false) {
        patch.persona = { ...persona, systemMode: 'hype', compactSystemPrompt: false };
      }
      if (JSON.stringify(api.tools) !== JSON.stringify(HYPE_TOOLS)) {
        patch.api = { ...api, tools: [...HYPE_TOOLS] };
      }
      if (Object.keys(patch).length) updateConfig(patch);
      return { ok: true, already: true, enabled: true };
    }
    // 已经关着：若人设还卡在亢奋卡上，把 systemMode 修回来。
    // ⚠️ 2026-09-22：这里以前会把 roleText **整份替换**成 defaultNormalRoleText()，
    //   而那张"目录里的正常卡"通常比用户手写的卡短得多（实测：目录卡 4484 字 vs
    //   用户在用的 6575 字）—— 一触发就静默丢掉全部自定义内容（含「## 自我印象」区）。
    //   现在只认「这次开亢奋时真的存下来的那张卡」；没有存档就**一个字都不动**
    //   roleText，只把协议模式修回来 —— 宁可留着一张可疑的卡，也不能删用户的东西。
    if (looksLikeHypeRole(persona.roleText)) {
      const savedRole = (hm.saved && !looksLikeHypeRole(hm.saved.roleText)) ? String(hm.saved.roleText || '') : '';
      const repaired = {
        ...persona,
        systemMode: persona.systemMode === 'hype' ? 'lean' : persona.systemMode,
        compactSystemPrompt: persona.compactSystemPrompt === true ? false : persona.compactSystemPrompt
      };
      if (savedRole) repaired.roleText = savedRole;
      updateConfig({
        persona: repaired,
        api: { ...api, tools: Array.isArray(hm.saved?.tools) && hm.saved.tools.length ? hm.saved.tools : [] }
      });
      return { ok: true, already: true, enabled: false, repaired: true, roleRestored: !!savedRole };
    }
    return { ok: true, already: true, enabled: false };
  }

  if (wants) {
    hm.enabled = true;
    // 只存「非亢奋」的正常人设；若当前已经是亢奋卡，别把它当原卡存
    const normalRole = looksLikeHypeRole(persona.roleText)
      ? (looksLikeHypeRole(hm.saved?.roleText) ? '' : (hm.saved?.roleText || ''))
      : (persona.roleText || '');
    hm.saved = {
      model: api.model || '',
      systemMode: persona.systemMode && persona.systemMode !== 'hype' ? persona.systemMode : (hm.saved?.systemMode || 'lean'),
      // ⚠️ 2026-09-22：以前这里是 `normalRole || defaultNormalRoleText()` ——
      //   当前卡认不出是"正常卡"时（例如用户手改过、或卡里有亢奋残留词），
      //   会把**目录里的默认卡**当成"原卡"存进 saved，关亢奋时再拿它覆盖用户的卡。
      //   改成存空字符串：关的时候 pickNormalRoleText 会自己兜底，绝不拿目录卡冒充用户的卡。
      roleText: normalRole || '',
      compactSystemPrompt: persona.compactSystemPrompt === true,
      tools: Array.isArray(api.tools) && api.tools.length && JSON.stringify(api.tools) !== JSON.stringify(HYPE_TOOLS)
        ? [...api.tools]
        : (Array.isArray(hm.saved?.tools) && hm.saved.tools.length ? [...hm.saved.tools] : null)
    };
    const nextPersona = { ...persona };
    nextPersona.systemMode = 'hype';
    if (hm.roleText) nextPersona.roleText = hm.roleText;
    nextPersona.compactSystemPrompt = false;
    updateConfig({
      hypeMode: hm,
      api: {
        ...api,
        ...(hm.model ? { model: hm.model } : {}),
        tools: [...HYPE_TOOLS]
      },
      persona: nextPersona
    });
    return {
      ok: true, enabled: true,
      model: hm.model || api.model,
      systemMode: nextPersona.systemMode,
      roleSwapped: !!hm.roleText,
      tools: [...HYPE_TOOLS]
    };
  }

  const saved = hm.saved || {};
  hm.enabled = false;
  hm.saved = null;
  const restored = { ...persona };
  const normalMode = saved.systemMode && saved.systemMode !== 'hype' ? saved.systemMode : 'lean';
  restored.systemMode = normalMode;
  restored.roleText = pickNormalRoleText(saved.roleText, persona.roleText);
  if (saved.compactSystemPrompt != null) restored.compactSystemPrompt = saved.compactSystemPrompt;
  else restored.compactSystemPrompt = false;
  const offModel = hm.restoreModel || 'qwen3.8-flash';
  const nextApi = { ...api, model: offModel };
  if (Array.isArray(saved.tools) && saved.tools.length) {
    nextApi.tools = saved.tools;
  } else {
    // 没存过完整工具表（旧版关过一次）→ 还原成空名单=全开
    nextApi.tools = [];
  }
  updateConfig({
    hypeMode: hm,
    api: nextApi,
    persona: restored
  });
  // 自动清洗：跨轮草稿/语义卡/本体状态里的骂人残留，避免正常模式继续喷
  let cleaned = { crossTurn: 0, cards: 0, botState: false };
  try {
    cleaned = cleanHypeResidue();
  } catch { /* 清洗失败不影响关闭 */ }
  try {
    const { setBotState } = await import('./bot-state.js');
    setBotState({
      reset: true,
      acuteStress: 0,
      chronicStress: 0,
      mood: 55,
      intent: ''
    });
    cleaned.botState = true;
  } catch { /* ignore */ }
  return { ok: true, enabled: false, model: offModel, cleaned };
}

/** 给 UI 用的状态快照。 */
export function hypeStatus() {
  const c = getConfig();
  const hm = c.hypeMode || {};
  return {
    enabled: hm.enabled === true,
    model: hm.model || '',
    restoreModel: hm.restoreModel || 'qwen3.8-flash',
    systemMode: hm.systemMode || 'full',
    hasRoleText: !!String(hm.roleText || '').trim(),
    currentModel: c.api?.model || '',
    currentSystemMode: c.persona?.systemMode || '',
    tools: c.api?.tools || []
  };
}
