/**
 * 37QAG 统一参与决策策略。
 *
 * 原则：Jev 只给“可弃权的小建议”。明确请求永远不能被 Jev 的 NO 否决；
 * Jev 关闭/超时/出错时，明确请求、必要回忆和可靠记忆照常工作。
 */
export const PARTICIPATION_ROUTES = Object.freeze({
  EXPLICIT: 'explicit_request',
  NATURAL: 'natural_reply',
  PROACTIVE: 'proactive_interject'
});

export const JEV_DECISION_STATUS = Object.freeze({
  ACCEPTED: 'accepted',
  ABSTAIN: 'abstain',
  TIMEOUT: 'timeout',
  ERROR: 'error',
  DISABLED: 'disabled'
});

const REQUEST_RE = /(?:请|帮我|麻烦|能不能|可不可以|发我|告诉我|查一下|查下|搜索|搜一下|提醒|记住|保存|删除|修改|纠正|回复|回答|解释|总结|翻译|生成|画一?张|要一?张|来一?张)[^。！？\n]{0,24}/i;

export function looksLikeExplicitRequest(text = '') {
  return REQUEST_RE.test(String(text || ''));
}

export function detectParticipationRoute({
  text = '',
  explicitRequest = false,
  addressed = false,
  replyTargeted = false,
  keywordHit = false,
  privateChat = false
} = {}) {
  if (privateChat || explicitRequest || addressed || replyTargeted || looksLikeExplicitRequest(text)) {
    return PARTICIPATION_ROUTES.EXPLICIT;
  }
  if (keywordHit) return PARTICIPATION_ROUTES.NATURAL;
  return PARTICIPATION_ROUTES.PROACTIVE;
}

export function normalizeJevDecision(result = null, positiveLabel = 'YES') {
  if (!result || result.disabled === true || result.error === 'role-off') {
    return { status: JEV_DECISION_STATUS.DISABLED, label: null, positive: false };
  }
  const rawError = String(result.error || '').toLowerCase();
  if (/timeout|timed.?out|abort/.test(rawError)) {
    return { status: JEV_DECISION_STATUS.TIMEOUT, label: result.label ?? null, positive: false };
  }
  if (result.error) {
    return { status: JEV_DECISION_STATUS.ERROR, label: result.label ?? null, positive: false, error: result.error };
  }
  if (result.abstain === true || !result.label) {
    return { status: JEV_DECISION_STATUS.ABSTAIN, label: result.label ?? null, positive: false };
  }
  return {
    status: JEV_DECISION_STATUS.ACCEPTED,
    label: result.label,
    positive: String(result.label).toUpperCase() === String(positiveLabel).toUpperCase(),
    p: Number(result.p) || 0,
    margin: Number(result.margin) || 0
  };
}

/**
 * @param {object} input
 * @param {'low'|'high'} input.failureImpact 失败后果。低后果可在自然接话路线降级继续，
 *   高后果（发图、写记忆、外部动作等）一律保守跳过。
 */
export function decideParticipation({
  text = '',
  route = null,
  explicitRequest = false,
  addressed = false,
  replyTargeted = false,
  keywordHit = false,
  privateChat = false,
  jev = null,
  positiveLabel = 'YES',
  failureImpact = 'high',
  allowNaturalFallback = true
} = {}) {
  const resolvedRoute = route || detectParticipationRoute({
    text, explicitRequest, addressed, replyTargeted, keywordHit, privateChat
  });
  const decision = normalizeJevDecision(jev, positiveLabel);

  if (resolvedRoute === PARTICIPATION_ROUTES.EXPLICIT) {
    return {
      action: 'continue',
      route: resolvedRoute,
      jev: decision,
      reason: 'explicit-request-cannot-be-vetoed',
      jevCanVeto: false
    };
  }

  if (decision.status === JEV_DECISION_STATUS.ACCEPTED) {
    return {
      action: decision.positive ? 'continue' : 'skip',
      route: resolvedRoute,
      jev: decision,
      reason: decision.positive ? 'jev-positive' : 'jev-negative',
      jevCanVeto: true
    };
  }

  const mayFallback = failureImpact === 'low'
    && allowNaturalFallback
    && resolvedRoute === PARTICIPATION_ROUTES.NATURAL
    && keywordHit;

  return {
    action: mayFallback ? 'continue' : 'skip',
    route: resolvedRoute,
    jev: decision,
    reason: mayFallback ? 'low-risk-natural-fallback' : `jev-${decision.status}`,
    jevCanVeto: false
  };
}

/** 必需的记忆检索不受 Jev 否决；Jev 只能把“不明显的回忆需求”补成 true。 */
export function decideMemoryRecall({ explicitRequest = false, keywordHit = false, jev = null } = {}) {
  const decision = normalizeJevDecision(jev);
  const required = explicitRequest || keywordHit;
  return {
    required,
    active: required || decision.positive,
    jev: decision,
    reason: required ? 'required-recall' : (decision.positive ? 'jev-recall-hint' : `jev-${decision.status}`)
  };
}
