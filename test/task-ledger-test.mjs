import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskLedger, TASK_STATUS } from '../src/task-ledger.js';

test('计划、提交、平台确认和完成是不同状态', () => {
  const ledger = new TaskLedger();
  const made = ledger.create({ text: '发一条通知', chatKey: 'group:100' });
  assert.equal(made.task.status, TASK_STATUS.PROPOSED);
  assert.equal(ledger.transition(made.task.id, TASK_STATUS.PENDING).ok, true);
  const submitted = ledger.markSubmitted(made.task.id, { clientRequestId: 'req-1' });
  assert.equal(submitted.platformConfirmed, false);
  assert.equal(ledger.complete(made.task.id, { detail: '以为发了' }).ok, false);

  const confirmed = ledger.confirmPlatform(made.task.id, { receiptId: 'msg-1' });
  assert.equal(confirmed.task.status, TASK_STATUS.IN_PROGRESS);
  assert.equal(ledger.complete(made.task.id, { detail: '平台已收' }).task.status, TASK_STATUS.COMPLETED);
});

test('没有结果证据只能标结果不明', () => {
  const ledger = new TaskLedger();
  const made = ledger.create({ text: '发文件', status: TASK_STATUS.PENDING });
  ledger.transition(made.task.id, TASK_STATUS.IN_PROGRESS);
  ledger.markSubmitted(made.task.id, { payloadSummary: 'file.zip' });
  const unknown = ledger.resolveUnknown(made.task.id, '发送回执丢失');
  assert.equal(unknown.task.status, TASK_STATUS.RESULT_UNKNOWN);
  assert.equal(unknown.task.result.confirmed, false);
});

test('非法状态跳转被拒绝', () => {
  const ledger = new TaskLedger();
  const made = ledger.create({ text: '待办' });
  const r = ledger.transition(made.task.id, TASK_STATUS.COMPLETED);
  assert.equal(r.ok, false);
  assert.match(r.error, /不能从/);
});
