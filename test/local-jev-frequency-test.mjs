import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplyChanceParams, checkInterjectQuota } from '../src/local-jev.js';

const rc = {
  minConfidence: 0.6,
  minMargin: 1,
  cooldownMs: 90000,
  maxPerHour: 8,
  adaptive: {
    enabled: true,
    quiet: { minConfidence: 0.45, minMargin: 0.4, cooldownMs: 30000, maxPerHour: 30 },
    busy: { minConfidence: 0.99, minMargin: 6, cooldownMs: 900000, maxPerHour: 1 }
  }
};

test('插话意愿 60% 换成更宽松的每小时上限和冷却', () => {
  const p = resolveReplyChanceParams(rc, null, 60);
  assert.equal(p.wantCap, 12);
  assert.equal(p.wantCd, 78000);
  assert.equal(p.maxPerHour, 12);
  assert.equal(p.cooldownMs, 78000);
});

test('自适应可以放宽，但不能比用户意愿更严格', () => {
  const busy = resolveReplyChanceParams(rc, 1, 60);
  assert.equal(busy.maxPerHour, 12);
  assert.equal(busy.cooldownMs, 78000);
  assert.ok(busy.minConfidence <= 0.7);
  assert.ok(busy.minMargin <= 3.2);

  const quiet = resolveReplyChanceParams(rc, 0, 60);
  assert.ok(quiet.maxPerHour >= 12 && quiet.maxPerHour <= 16);
  assert.ok(quiet.cooldownMs <= 78000);
});

test('同一份冷却和每小时配额拒绝超频', () => {
  const now = 1_000_000;
  const blockedCooldown = checkInterjectQuota({
    now,
    lastAt: now - 10000,
    times: [],
    cooldownMs: 78000,
    maxPerHour: 12
  });
  assert.equal(blockedCooldown.ok, false);
  assert.match(blockedCooldown.reason, /冷却中/);

  const times = Array.from({ length: 12 }, (_, i) => now - 60000 * (i + 1));
  const blockedQuota = checkInterjectQuota({
    now,
    lastAt: 0,
    times: times.slice(0, 6),
    cooldownMs: 0,
    maxPerHour: 6
  });
  assert.equal(blockedQuota.ok, false);
  assert.match(blockedQuota.reason, /上限 6 次/);
});
