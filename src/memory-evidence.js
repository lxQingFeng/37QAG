import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const EVIDENCE_STATUS = Object.freeze({
  CANDIDATE: 'candidate',
  CONFIRMED: 'confirmed',
  SUPERSEDED: 'superseded',
  DELETED: 'deleted'
});

const DIRECT_EVIDENCE = new Set(['self_report', 'explicit_statement', 'platform_receipt', 'manual']);

function cleanText(value, max = 500) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeScope(scope, fallback = '') {
  if (scope && typeof scope === 'object' && scope.key) return normalizeScope(scope.key, fallback);
  const raw = cleanText(scope || fallback, 120);
  if (!raw) return { type: 'chat', chatKey: '', key: 'chat:' };
  if (raw === 'global') return { type: 'global', key: 'global' };
  if (raw.startsWith('chat:')) return { type: 'chat', chatKey: raw.slice(5), key: raw };
  if (raw.startsWith('group:') || raw.startsWith('private:')) return { type: 'chat', chatKey: raw, key: `chat:${raw}` };
  if (raw.startsWith('person:')) return { type: 'person', personId: raw.slice(7), key: raw };
  return { type: 'chat', chatKey: raw, key: `chat:${raw}` };
}

export function isScopeAllowed(requested, allowedScopes = []) {
  const req = normalizeScope(requested);
  const allowed = (Array.isArray(allowedScopes) ? allowedScopes : [allowedScopes])
    .filter(Boolean)
    .map((s) => normalizeScope(s));
  return allowed.some((a) => {
    if (a.type === 'global') return true;
    return a.key === req.key
      || (req.type === 'person' && a.type === 'person' && a.personId === req.personId);
  });
}

function sourceScope(source = {}, fallbackScope = '') {
  return normalizeScope(source.scope || fallbackScope || source.chatKey || '', source.chatKey || '');
}

/**
 * 来源化证据记忆。读写都先过 scope；工具参数不能把权限从当前会话扩大到全库。
 * 明确自述/人工/平台回执直接确认；模型推断只进 candidate，不能伪装成事实。
 */
export class EvidenceLedger {
  constructor({ file = null, now = () => Date.now() } = {}) {
    this.file = file ? path.resolve(file) : null;
    this.now = now;
    this.entries = new Map();
    this.tombstones = new Map();
    if (this.file) this.load();
  }

  load() {
    if (!this.file) return;
    try {
      const data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      for (const item of data.entries || []) if (item?.id) this.entries.set(item.id, item);
      for (const item of data.tombstones || []) if (item?.contentHash) this.tombstones.set(item.contentHash, item);
    } catch { /* 第一次运行或损坏时从空库开始；写入会原子替换 */ }
  }

  save() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1,
      entries: [...this.entries.values()],
      tombstones: [...this.tombstones.values()]
    }, null, 1), 'utf8');
    fs.renameSync(tmp, this.file);
  }

  #hash(scopeKey, subject, text) {
    return `${scopeKey}|${cleanText(subject, 120).toLowerCase()}|${cleanText(text).toLowerCase()}`;
  }

  add({
    text,
    subject = '',
    source = {},
    scope = '',
    evidenceType = 'inference',
    status = '',
    confidence = 0.5,
    supersedes = null,
    tags = []
  }) {
    const body = cleanText(text);
    if (!body) return { ok: false, error: '证据内容不能为空' };
    const srcScope = sourceScope(source, scope);
    const explicitScope = normalizeScope(scope, srcScope.key);
    if (scope && !isScopeAllowed(explicitScope, [srcScope.key])) {
      return { ok: false, error: '证据 scope 不能大于来源 scope' };
    }
    const hash = this.#hash(srcScope.key, subject, body);
    if (this.tombstones.has(hash)) {
      return { ok: false, error: '这条内容已删除并进入墓碑，不能自动写回', tombstoned: true };
    }

    const at = this.now();
    const direct = DIRECT_EVIDENCE.has(String(evidenceType));
    const finalStatus = status === EVIDENCE_STATUS.CANDIDATE
      ? EVIDENCE_STATUS.CANDIDATE
      : (status === EVIDENCE_STATUS.CONFIRMED || direct ? EVIDENCE_STATUS.CONFIRMED : EVIDENCE_STATUS.CANDIDATE);
    const id = randomUUID();
    const entry = {
      id,
      version: 1,
      text: body,
      subject: cleanText(subject, 120),
      contentHash: hash,
      source: {
        type: cleanText(source.type || evidenceType, 40),
        chatKey: srcScope.chatKey || '',
        messageId: cleanText(source.messageId, 80),
        actor: cleanText(source.actor, 80),
        runId: cleanText(source.runId, 80)
      },
      scope: srcScope,
      evidenceType: cleanText(evidenceType, 40),
      status: finalStatus,
      confidence: Math.max(0, Math.min(1, Number(confidence) || 0)),
      createdAt: at,
      updatedAt: at,
      lastConfirmedAt: finalStatus === EVIDENCE_STATUS.CONFIRMED ? at : null,
      lastRetrievedAt: null,
      supersedes: supersedes ? cleanText(supersedes, 80) : null,
      tags: [...new Set((tags || []).map((t) => cleanText(t, 40)).filter(Boolean))]
    };

    if (supersedes && this.entries.has(supersedes)) {
      const old = this.entries.get(supersedes);
      old.status = EVIDENCE_STATUS.SUPERSEDED;
      old.updatedAt = at;
      old.supersededBy = id;
    }
    this.entries.set(id, entry);
    this.save();
    return { ok: true, evidence: entry };
  }

  correct(id, patch = {}) {
    const old = this.entries.get(String(id || ''));
    if (!old || old.status === EVIDENCE_STATUS.DELETED) return { ok: false, error: '原证据不存在或已删除' };
    return this.add({
      ...old,
      ...patch,
      source: { ...(old.source || {}), ...(patch.source || {}) },
      scope: patch.scope || old.scope.key,
      supersedes: old.id,
      status: patch.status || EVIDENCE_STATUS.CONFIRMED
    });
  }

  remove(id, { actor = '', reason = '' } = {}) {
    const entry = this.entries.get(String(id || ''));
    if (!entry) return { ok: false, error: '证据不存在' };
    const at = this.now();
    entry.status = EVIDENCE_STATUS.DELETED;
    entry.updatedAt = at;
    entry.deletedAt = at;
    entry.deletedBy = cleanText(actor, 80);
    entry.deleteReason = cleanText(reason, 200);
    this.tombstones.set(entry.contentHash, {
      contentHash: entry.contentHash,
      originalId: entry.id,
      deletedAt: at,
      reason: entry.deleteReason
    });
    this.save();
    return { ok: true, deleted: entry.id, tombstone: true };
  }

  get(id, allowedScopes = []) {
    const entry = this.entries.get(String(id || ''));
    if (!entry || entry.status === EVIDENCE_STATUS.DELETED) return null;
    if (!isScopeAllowed(entry.scope.key, allowedScopes)) return null;
    return entry;
  }

  query({
    text = '',
    subject = '',
    scope = '',
    allowedScopes = [],
    includeCandidates = false,
    includeSuperseded = false,
    limit = 8
  } = {}) {
    const reqScope = normalizeScope(scope, '');
    const scopes = scope ? [reqScope.key] : allowedScopes;
    const q = cleanText(text).toLowerCase();
    const subj = cleanText(subject).toLowerCase();
    const now = this.now();
    const rows = [...this.entries.values()]
      .filter((e) => e.status !== EVIDENCE_STATUS.DELETED)
      .filter((e) => e.status !== EVIDENCE_STATUS.SUPERSEDED || includeSuperseded)
      .filter((e) => e.status !== EVIDENCE_STATUS.CANDIDATE || includeCandidates)
      .filter((e) => !scope || e.scope.key === reqScope.key)
      .filter((e) => !scopes.length || isScopeAllowed(e.scope.key, scopes))
      .filter((e) => !subj || String(e.subject || '').toLowerCase().includes(subj))
      .filter((e) => !q || `${e.subject} ${e.text}`.toLowerCase().includes(q))
      .map((e) => ({ ...e, lastRetrievedAt: now }))
      .sort((a, b) => (b.lastConfirmedAt || b.createdAt) - (a.lastConfirmedAt || a.createdAt));

    for (const row of rows) {
      const live = this.entries.get(row.id);
      if (live) live.lastRetrievedAt = now;
    }
    if (rows.length) this.save();
    return rows.slice(0, Math.max(1, Number(limit) || 8));
  }

  evidencePack(queryOpts = {}) {
    const rows = this.query(queryOpts);
    return {
      count: rows.length,
      scope: normalizeScope(queryOpts.scope || '').key,
      notes: rows.length ? [] : ['当前检索未命中；不代表从未发生。'],
      conflicts: rows.filter((r) => r.conflict === true),
      evidence: rows.map((r) => ({
        id: r.id,
        text: r.text,
        subject: r.subject,
        source: r.source,
        scope: r.scope.key,
        status: r.status,
        evidenceType: r.evidenceType,
        confirmedAt: r.lastConfirmedAt,
        version: r.version
      }))
    };
  }
}

let singleton = null;

export function getEvidenceLedger(file) {
  if (!singleton) singleton = new EvidenceLedger({ file });
  return singleton;
}

export function resetEvidenceLedger() {
  singleton = null;
}
