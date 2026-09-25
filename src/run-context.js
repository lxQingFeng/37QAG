import { randomUUID } from 'node:crypto';

/**
 * 一轮 Agent 的统一时间/取消上下文。
 * 前置小决策与整轮动作共享 runId、deadline、signal；迟到结果只能被冻结丢弃。
 */
export function createRunContext({
  runId = randomUUID(),
  preDecisionBudgetMs = 1500,
  deadlineMs = 120000,
  signal = null,
  now = () => Date.now()
} = {}) {
  const createdAt = now();
  const preDecisionDeadlineAt = createdAt + Math.max(0, Number(preDecisionBudgetMs) || 0);
  const deadlineAt = createdAt + Math.max(0, Number(deadlineMs) || 0);
  const controller = new AbortController();
  const decisions = new Map();
  let frozenReason = '';

  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }

  const context = Object.freeze({
    runId,
    createdAt,
    preDecisionDeadlineAt,
    deadlineAt,
    signal: controller.signal,

    remainingPreDecisionMs(at = now()) {
      return Math.max(0, preDecisionDeadlineAt - at);
    },

    remainingMs(at = now()) {
      return Math.max(0, deadlineAt - at);
    },

    isPreDecisionExpired(at = now()) {
      return controller.signal.aborted || at >= preDecisionDeadlineAt;
    },

    isExpired(at = now()) {
      return controller.signal.aborted || at >= deadlineAt;
    },

    abort(reason = 'run-cancelled') {
      if (!controller.signal.aborted) controller.abort(reason);
      if (!frozenReason) frozenReason = String(reason || 'run-cancelled');
    },

    freeze(reason = 'run-finished') {
      if (!frozenReason) frozenReason = String(reason || 'run-finished');
      if (!controller.signal.aborted) controller.abort(frozenReason);
    },

    get frozenReason() {
      return frozenReason;
    },

    /**
     * 只接受仍在本轮且未过前置截止时间的决策。
     * 同 key 首个有效结果胜出，迟到/超时结果不能覆盖已冻结结果。
     */
    acceptDecision(key, value, { at = now(), phase = 'pre' } = {}) {
      const id = String(key || '');
      if (!id) return { accepted: false, reason: 'missing-key', value: null };
      if (frozenReason || controller.signal.aborted) {
        return { accepted: false, reason: 'run-frozen', value: decisions.get(id) ?? null };
      }
      const deadline = phase === 'run' ? deadlineAt : preDecisionDeadlineAt;
      if (at >= deadline) return { accepted: false, reason: 'late-result', value: decisions.get(id) ?? null };
      if (decisions.has(id)) return { accepted: false, reason: 'already-decided', value: decisions.get(id) };
      decisions.set(id, value);
      return { accepted: true, reason: 'accepted', value };
    },

    decision(key) {
      return decisions.get(String(key || '')) ?? null;
    },

    decisions() {
      return Object.fromEntries(decisions);
    },

    /** 到期动作统一拒绝；动作执行前应再调用一次。 */
    guardAction(actionId, { at = now() } = {}) {
      const id = String(actionId || `action:${decisions.size}`);
      if (frozenReason || controller.signal.aborted) {
        return { ok: false, reason: frozenReason || 'run-aborted', actionId: id };
      }
      if (at >= deadlineAt) {
        context.freeze('deadline');
        return { ok: false, reason: 'deadline', actionId: id };
      }
      return { ok: true, reason: '', actionId: id };
    }
  });

  return context;
}

export async function withRunDeadline(runContext, promise, fallback = null) {
  if (!runContext) return promise;
  const timeout = new Promise((resolve) => {
    const delay = runContext.remainingMs();
    const timer = setTimeout(() => resolve({ timeout: true, value: fallback }), Math.max(1, delay));
    timer.unref?.();
    runContext.signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve({ timeout: true, value: fallback });
    }, { once: true });
  });
  const result = await Promise.race([Promise.resolve(promise).then((value) => ({ timeout: false, value })), timeout]);
  return result.value;
}
