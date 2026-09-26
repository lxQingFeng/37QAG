import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { EvidenceLedger, isScopeAllowed, EVIDENCE_STATUS } from '../src/memory-evidence.js';

function tempFile(name) {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), '37qag-evidence-')), name);
}

test('明确自述确认，推断只进候选', () => {
  const ledger = new EvidenceLedger();
  const direct = ledger.add({
    text: '我生日是十月三日',
    subject: '10001',
    evidenceType: 'self_report',
    source: { type: 'message', chatKey: 'group:100', actor: '10001', messageId: 'm1' }
  });
  assert.equal(direct.evidence.status, EVIDENCE_STATUS.CONFIRMED);
  assert.ok(direct.evidence.lastConfirmedAt);

  const inferred = ledger.add({
    text: '他可能喜欢吃辣',
    subject: '10001',
    evidenceType: 'inference',
    source: { type: 'model', chatKey: 'group:100' }
  });
  assert.equal(inferred.evidence.status, EVIDENCE_STATUS.CANDIDATE);
});

test('纠正产生新版本，删除保留墓碑且不能自动写回', () => {
  const ledger = new EvidenceLedger();
  const first = ledger.add({
    text: '住在上海',
    subject: '10001',
    evidenceType: 'self_report',
    source: { chatKey: 'group:100', actor: '10001' }
  });
  const fixed = ledger.correct(first.evidence.id, {
    text: '住在杭州',
    source: { chatKey: 'group:100', actor: '10001' }
  });
  assert.equal(fixed.evidence.version, 1);
  assert.equal(ledger.get(first.evidence.id, ['global']).status, EVIDENCE_STATUS.SUPERSEDED);
  assert.equal(fixed.evidence.supersedes, first.evidence.id);

  const removed = ledger.remove(fixed.evidence.id, { actor: 'admin', reason: '要求删除' });
  assert.equal(removed.ok, true);
  assert.equal(removed.tombstone, true);
  const replay = ledger.add({
    text: '住在杭州',
    subject: '10001',
    evidenceType: 'self_report',
    source: { chatKey: 'group:100', actor: '10001' }
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.tombstoned, true);
});

test('scope 先行，工具参数不能扩大访问范围', () => {
  const ledger = new EvidenceLedger();
  ledger.add({
    text: '只对本群有效',
    source: { chatKey: 'group:100' },
    evidenceType: 'self_report'
  });
  assert.equal(isScopeAllowed('chat:group:100', ['chat:group:100']), true);
  assert.equal(isScopeAllowed('global', ['chat:group:100']), false);
  assert.equal(ledger.query({ text: '本群', allowedScopes: ['chat:group:200'] }).length, 0);
  assert.equal(ledger.query({ text: '本群', allowedScopes: ['chat:group:100'] }).length, 1);
});

test('lastRetrievedAt 与 lastConfirmedAt 分离，读取不刷新事实确认时间', () => {
  let now = 1000;
  const ledger = new EvidenceLedger({ now: () => now });
  const added = ledger.add({
    text: '喜欢古典乐',
    subject: '10001',
    evidenceType: 'self_report',
    source: { chatKey: 'group:100' }
  });
  const confirmedAt = added.evidence.lastConfirmedAt;
  now = 5000;
  ledger.query({ allowedScopes: ['global'] });
  const live = ledger.get(added.evidence.id, ['global']);
  assert.equal(live.lastConfirmedAt, confirmedAt);
  assert.equal(live.lastRetrievedAt, 5000);
});
