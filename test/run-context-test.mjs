import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunContext } from '../src/run-context.js';

test('前置决策到预算后冻结，迟到结果不能覆盖', () => {
  let now = 1000;
  const run = createRunContext({ preDecisionBudgetMs: 100, deadlineMs: 1000, now: () => now });
  assert.equal(run.acceptDecision('gate', 'early', { at: 1050 }).accepted, true);
  assert.equal(run.acceptDecision('gate', 'late', { at: 1100 }).accepted, false);
  assert.equal(run.decision('gate'), 'early');

  now = 1101;
  assert.equal(run.isPreDecisionExpired(), true);
  assert.equal(run.acceptDecision('other', 'late', { at: 1101 }).accepted, false);
});

test('整轮到截止时间后拒绝新动作', () => {
  let now = 0;
  const run = createRunContext({ preDecisionBudgetMs: 10, deadlineMs: 50, now: () => now });
  assert.equal(run.guardAction('send', { at: 49 }).ok, true);
  now = 50;
  const guard = run.guardAction('send2', { at: 50 });
  assert.equal(guard.ok, false);
  assert.equal(guard.reason, 'deadline');
  assert.equal(run.frozenReason, 'deadline');
});

test('外部取消会冻结结果', () => {
  const controller = new AbortController();
  const run = createRunContext({ signal: controller.signal, deadlineMs: 1000 });
  controller.abort('superseded');
  const r = run.acceptDecision('gate', 'late');
  assert.equal(r.accepted, false);
  assert.equal(r.reason, 'run-frozen');
});
