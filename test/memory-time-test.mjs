import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), '37qag-memory-time-'));
process.env.QQ_AGENT_DATA_DIR = dataRoot;
const { MemoryStore } = await import('../src/memory.js');

after(() => {
  const resolved = path.resolve(dataRoot);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

function entry(member) {
  return member.impressions.find((e) => e.content.includes('古典乐'));
}

test('读取、整理和人物活跃时间不互相刷新', () => {
  const memory = new MemoryStore();
  memory.append('group:100', 'memberImpression', '喜欢古典乐', {
    userId: '10001',
    target: '甲',
    type: 'preference'
  });

  const added = entry(memory.getMember('group:100', '10001'));
  assert.ok(added.lastConfirmedAt);
  assert.equal(added.lastRetrievedAt, null);
  const confirmedAt = added.lastConfirmedAt;

  memory.query('group:100', 'memberImpression', '古典乐');
  let live = entry(memory.getMember('group:100', '10001'));
  assert.equal(live.lastConfirmedAt, confirmedAt);
  assert.ok(live.lastRetrievedAt >= confirmedAt);
  const retrievedAt = live.lastRetrievedAt;

  memory.setImpressionMeta('10001', '喜欢古典乐', { pin: true });
  live = entry(memory.getMember('group:100', '10001'));
  assert.equal(live.lastConfirmedAt, confirmedAt);
  assert.equal(live.lastRetrievedAt, retrievedAt);

  memory.replaceMember('group:100', '10001', '甲', ['喜欢古典乐']);
  live = entry(memory.getMember('group:100', '10001'));
  assert.equal(live.lastConfirmedAt, confirmedAt);
  assert.equal(live.lastRetrievedAt, retrievedAt);

  memory.replaceMember('group:100', '10001', '甲', ['整理时推断喜欢民谣']);
  live = memory.getMember('group:100', '10001').impressions[0];
  assert.equal(live.lastConfirmedAt, null);

  memory.bumpSeen(['10001']);
  const member = memory.getMember('group:100', '10001');
  assert.ok(member.personLastActiveAt >= confirmedAt);
});
