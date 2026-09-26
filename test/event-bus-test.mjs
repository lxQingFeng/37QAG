// 阶段二回归：event-bus.js 生命周期事件总线（订阅/权重/once/off/owner 批量退订/异常隔离）。
import { test } from 'node:test';
import assert from 'node:assert';

const bus = await import('../src/event-bus.js');
const { on, once, off, offByOwner, emit, emitSync, clearAll, listenerStats } = bus;

test('基础订阅与 fire-and-forget emit', async () => {
  clearAll();
  let got = null;
  on('llm.request.before', (p) => { got = p; });
  const n = emit('llm.request.before', { messageCount: 3 });
  assert.equal(n, 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(got, { messageCount: 3 });
});

test('weight 排序：小权重先执行', async () => {
  clearAll();
  const order = [];
  on('tool.call.before', () => { order.push('late'); }, { weight: 200 });
  on('tool.call.before', () => { order.push('early'); }, { weight: 10 });
  await emitSync('tool.call.before', {});
  assert.deepEqual(order, ['early', 'late']);
});

test('once 只触发一次；off 手动退订', async () => {
  clearAll();
  let count = 0;
  once('message.sent', () => { count++; });
  const fn = () => { count += 100; };
  on('message.sent', fn);
  await emitSync('message.sent', {});
  await emitSync('message.sent', {});
  assert.equal(count, 201, 'once 一次(+1) + on 两次(+200)');
  off('message.sent', fn);
  await emitSync('message.sent', {});
  assert.equal(count, 201, 'off 后不再触发');
});

test('offByOwner 批量退订（模块卸载语义）', async () => {
  clearAll();
  let hits = 0;
  on('module.loaded', () => { hits++; }, { owner: 'mod-a' });
  on('module.loaded', () => { hits++; }, { owner: 'mod-a' });
  on('module.loaded', () => { hits++; });   // 无 owner = 核心自己，不该被批量退订
  await emitSync('module.loaded', {});
  assert.equal(hits, 3);
  const removed = offByOwner('mod-a');
  assert.equal(removed, 2);
  await emitSync('module.loaded', {});
  assert.equal(hits, 4, '只剩下的核心订阅触发一次');
});

test('订阅者异常隔离：一个崩不影响其他订阅者与返回计数', async () => {
  clearAll();
  let ok = false;
  on('llm.request.after', () => { throw new Error('boom'); });
  on('llm.request.after', () => { ok = true; });
  const n = await emitSync('llm.request.after', {});
  assert.equal(n, 2);
  assert.ok(ok, '第二个订阅者应正常执行');
});

test('emitSync 对零订阅者返回 0（热路径零开销）', async () => {
  clearAll();
  assert.equal(await emitSync('nobody.listens', {}), 0);
});

test('listenerStats 反映注册面', async () => {
  clearAll();
  on('a.b', () => {});
  on('a.b', () => {});
  assert.equal(listenerStats()['a.b'], 2);
});
