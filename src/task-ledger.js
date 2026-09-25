import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const TASK_STATUS = Object.freeze({
  PROPOSED: 'proposed',
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  CANCELLED: 'cancelled',
  EXPIRED: 'expired',
  FAILED: 'failed',
  RESULT_UNKNOWN: 'result_unknown'
});

const TRANSITIONS = Object.freeze({
  proposed: new Set(['pending', 'cancelled', 'expired']),
  pending: new Set(['in_progress', 'cancelled', 'expired', 'failed', 'result_unknown']),
  in_progress: new Set(['completed', 'cancelled', 'failed', 'result_unknown']),
  completed: new Set(),
  cancelled: new Set(),
  expired: new Set(),
  failed: new Set(['in_progress']),
  result_unknown: new Set(['in_progress', 'completed', 'failed'])
});

/**
 * 承诺/待办账本：严格区分“想做、已提交、平台确认、实际结果”。
 * 只有平台回执或实际结果确认后才能标 completed；否则只能 failed / result_unknown。
 */
export class TaskLedger {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.now = now;
    this.tasks = new Map();
    if (this.file) this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const task of data.tasks || []) if (task?.id) this.tasks.set(task.id, task);
    } catch { /* 空账本或旧文件损坏：下次 save 原子修复 */ }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: 1, tasks: [...this.tasks.values()] }, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  create({
    text,
    chatKey = '',
    userId = '',
    dueAt = null,
    expiresAt = null,
    source = {},
    status = TASK_STATUS.PROPOSED,
    note = ''
  }) {
    const body = String(text || '').trim().slice(0, 200);
    if (!body) return { ok: false, error: '任务内容不能为空' };
    const initial = Object.values(TASK_STATUS).includes(status) ? status : TASK_STATUS.PROPOSED;
    if (!['proposed', 'pending'].includes(initial)) return { ok: false, error: '新建任务只能是 proposed 或 pending' };
    const at = this.now();
    const id = randomUUID();
    const task = {
      id,
      version: 1,
      text: body,
      chatKey: String(chatKey || ''),
      userId: String(userId || ''),
      status: initial,
      note: String(note || '').slice(0, 300),
      source: { ...source },
      createdAt: at,
      updatedAt: at,
      dueAt: dueAt == null ? null : Number(dueAt),
      expiresAt: expiresAt == null ? null : Number(expiresAt),
      plan: null,
      submissions: [],
      platformReceipt: null,
      result: null,
      history: [{ at, status: initial, from: null, reason: 'created' }]
    };
    this.tasks.set(id, task);
    this.save();
    return { ok: true, task: { ...task } };
  }

  #transition(id, next, { reason = '', force = false } = {}) {
    const task = this.tasks.get(String(id || ''));
    if (!task) return { ok: false, error: '任务不存在' };
    if (!Object.values(TASK_STATUS).includes(next)) return { ok: false, error: `未知状态 ${next}` };
    if (!force && !TRANSITIONS[task.status]?.has(next)) {
      return { ok: false, error: `不能从 ${task.status} 变为 ${next}`, task: { ...task } };
    }
    const at = this.now();
    task.history.push({ at, from: task.status, to: next, reason: String(reason || '').slice(0, 200) });
    task.status = next;
    task.version += 1;
    task.updatedAt = at;
    this.save();
    return { ok: true, task: { ...task } };
  }

  transition(id, next, opts = {}) {
    return this.#transition(id, next, opts);
  }

  setPlan(id, plan) {
    const task = this.tasks.get(String(id || ''));
    if (!task) return { ok: false, error: '任务不存在' };
    task.plan = String(plan || '').slice(0, 2000);
    task.version += 1;
    task.updatedAt = this.now();
    this.save();
    return { ok: true, task: { ...task } };
  }

  markSubmitted(id, { clientRequestId = '', payloadSummary = '', reason = 'submitted' } = {}) {
    const task = this.tasks.get(String(id || ''));
    if (!task) return { ok: false, error: '任务不存在' };
    const at = this.now();
    task.submissions.push({
      at,
      clientRequestId: String(clientRequestId || ''),
      payloadSummary: String(payloadSummary || '').slice(0, 500),
      reason: String(reason || '').slice(0, 200)
    });
    task.version += 1;
    task.updatedAt = at;
    this.save();
    return { ok: true, task: { ...task }, submitted: true, platformConfirmed: !!task.platformReceipt };
  }

  confirmPlatform(id, receipt = {}) {
    const task = this.tasks.get(String(id || ''));
    if (!task) return { ok: false, error: '任务不存在' };
    const at = this.now();
    task.platformReceipt = {
      at,
      provider: String(receipt.provider || receipt.source || 'platform').slice(0, 80),
      receiptId: String(receipt.receiptId || receipt.messageId || receipt.id || '').slice(0, 200),
      raw: receipt.raw ?? null
    };
    const moved = task.status === TASK_STATUS.PROPOSED || task.status === TASK_STATUS.PENDING
      ? this.#transition(id, TASK_STATUS.IN_PROGRESS, { reason: 'platform-confirmed' })
      : { ok: true };
    return { ...moved, platformConfirmed: true, task: this.tasks.get(id) };
  }

  complete(id, result = {}) {
    const task = this.tasks.get(String(id || ''));
    if (!task) return { ok: false, error: '任务不存在' };
    if (!task.platformReceipt && result.confirmed !== true) {
      return { ok: false, error: '没有平台回执或实际结果，不能标 completed；请记 failed/result_unknown', task: { ...task } };
    }
    task.result = {
      at: this.now(),
      status: 'completed',
      confirmed: true,
      detail: String(result.detail || '').slice(0, 1000),
      raw: result.raw ?? null
    };
    return this.#transition(id, TASK_STATUS.COMPLETED, { reason: result.detail || 'result-confirmed' });
  }

  resolveUnknown(id, detail = '') {
    const task = this.tasks.get(String(id || ''));
    if (!task) return { ok: false, error: '任务不存在' };
    task.result = {
      at: this.now(),
      status: TASK_STATUS.RESULT_UNKNOWN,
      confirmed: false,
      detail: String(detail || '').slice(0, 1000)
    };
    return this.#transition(id, TASK_STATUS.RESULT_UNKNOWN, { reason: detail || 'result-unknown' });
  }

  expireDue({ at = this.now() } = {}) {
    let changed = 0;
    for (const task of this.tasks.values()) {
      if (task.expiresAt && task.expiresAt <= at && TRANSITIONS[task.status]?.has(TASK_STATUS.EXPIRED)) {
        this.#transition(task.id, TASK_STATUS.EXPIRED, { reason: 'expired' });
        changed += 1;
      }
    }
    return changed;
  }

  list({ chatKey = '', status = '', includeTerminal = true, limit = 50 } = {}) {
    return [...this.tasks.values()]
      .filter((t) => !chatKey || t.chatKey === chatKey)
      .filter((t) => !status || t.status === status)
      .filter((t) => includeTerminal || !['completed', 'cancelled', 'expired'].includes(t.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(1, Number(limit) || 50))
      .map((t) => ({ ...t }));
  }

  find(idOrText, { chatKey = '' } = {}) {
    const key = String(idOrText || '').trim().toLowerCase();
    return [...this.tasks.values()].find((t) =>
      (!chatKey || t.chatKey === chatKey)
      && (t.id === idOrText || String(t.text).toLowerCase().includes(key))
    ) || null;
  }
}
