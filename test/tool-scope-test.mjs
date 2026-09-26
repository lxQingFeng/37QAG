import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), '37qag-tools-'));
process.env.QQ_AGENT_DATA_DIR = dataRoot;

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const { getConversationMemory } = await import('../src/conversation-memory/runtime.js');
const { TaskLedger, TASK_STATUS } = await import('../src/task-ledger.js');

function writeChat(chatKey, messages) {
  const file = path.join(dataRoot, 'messages', `${chatKey.replace(/[^a-z0-9_]/gi, '_')}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ messages }, null, 1), 'utf8');
}

function parsePayload(result) {
  assert.equal(result.isError, undefined);
  return JSON.parse(result.content);
}

test('memory_search 与 memory_archive 只能读当前会话', async () => {
  const now = Date.now();
  writeChat('group:100', [
    { id: 1, ts: now - 2000, senderId: '10001', senderName: '甲', text: '本群机密 secret100' },
    { id: 2, ts: now - 1000, senderId: '10002', senderName: '乙', text: '普通讨论' }
  ]);
  writeChat('group:200', [
    { id: 1, ts: now - 2000, senderId: '20001', senderName: '丙', text: '别群机密 secret200' }
  ]);

  const memory = getConversationMemory();
  memory.consolidate({ force: true });
  const defs = buildToolDefs();
  const ctx = {
    chatKey: 'group:100',
    kind: 'group',
    chatId: 100,
    memory,
    memorySearchBudget: 20,
    memorySearchUsed: 0
  };

  const own = await executeTool(defs, ctx, 'memory_search', { query: 'secret100' });
  assert.match(own.content, /secret100/);
  assert.doesNotMatch(own.content, /secret200/);

  const foreign = await executeTool(defs, ctx, 'memory_search', { query: 'secret200' });
  assert.doesNotMatch(foreign.content, /secret200/);
  assert.doesNotMatch(foreign.content, /group:200/);
  assert.match(foreign.content, /chat=group:100/);

  const archive = await executeTool(defs, ctx, 'memory_archive', { mode: 'count', query: 'secret200' });
  assert.match(archive.content, /消息0次/);
  assert.match(archive.content, /^group:100/);
  assert.doesNotMatch(archive.content, /group:200/);
});

after(() => {
  const resolved = path.resolve(dataRoot);
  if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) {
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('send_message 的 taskId 会推进任务并记录平台回执', async () => {
  const defs = buildToolDefs();
  const session = { id: 'session-1', sent: [] };
  const ctx = {
    chatKey: 'group:100',
    kind: 'group',
    chatId: 100,
    session,
    emit() {},
    store: { recent: () => [] },
    sender: {
      async sendTextBatch() {
        return {
          sent: [{ text: '任务消息', messageId: 'receipt-1', at: new Date().toISOString() }],
          failed: []
        };
      }
    },
    triggerUserIds: ['10001'],
    runContext: { runId: 'run-1' }
  };

  const saved = parsePayload(await executeTool(defs, ctx, 'memory_todo_save', {
    text: '发送测试通知',
    expireInMinutes: 10
  }));
  assert.ok(saved.taskId);

  const sent = parsePayload(await executeTool(defs, ctx, 'send_message', {
    messages: ['任务消息'],
    taskId: saved.taskId
  }));
  assert.equal(sent.taskTracking.ok, true);
  assert.equal(sent.taskTracking.platformConfirmed, true);

  const ledger = new TaskLedger({ file: path.join(dataRoot, 'task-ledger.json') });
  const task = ledger.find(saved.taskId, { chatKey: 'group:100' });
  assert.equal(task.status, TASK_STATUS.IN_PROGRESS);
  assert.equal(task.platformReceipt.receiptId, 'receipt-1');
});
