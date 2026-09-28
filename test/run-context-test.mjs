import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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

test('缺陷3修复：主循环每轮检查 runDeadlineMs，到点即 break 并记 finishReason', () => {
  // run-context 的 guardAction 只拦「迟到的 send_」；noreply 三连诊断（2026-09-28）
  // 实测会话 1 在 deadline 后还空转 5 轮。修复 = 主循环开头查剩余时间。
  // 行为级验证需要完整编排器 harness（仓库测试均为纯函数级），这里按仓库先例
  // （tool-gate-test「防文档漂移：直接读源码断言」）锚定接线存在。
  const src = fs.readFileSync(new URL('../src/orchestrator.js', import.meta.url), 'utf8');
  assert.match(src, /runContext\.remainingMs\(\) <= 0/, '主循环应每轮检查剩余时间');
  assert.match(src, /session\.finishReason = `运行时间到/, '到点应记 finishReason');
  // 检查必须位于工具主循环（for round）之内，而不是只在运行前后。
  const loopHead = src.indexOf('for (let round = 0;');
  const checkAt = src.indexOf('runContext.remainingMs() <= 0');
  assert.ok(loopHead >= 0 && checkAt > loopHead, 'deadline 检查应在主循环内');
});
