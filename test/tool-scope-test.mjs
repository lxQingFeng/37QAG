import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), '37qag-tools-'));
process.env.QQ_AGENT_DATA_DIR = dataRoot;

const { buildToolDefs, executeTool } = await import('../src/tools.js');
const { updateConfig, getConfig, reloadConfig } = await import('../src/config.js');
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

// ── web_search 每次运行 3 次熔断（2026-09-28 · 工具结果 token 优化①）──

test('web_search：第 4 次搜索直接拒绝，拿不到新结果自然收口', async () => {
  const defs = buildToolDefs();
  const ctx = {
    chatKey: 'group:100',
    kind: 'group',
    chatId: 100,
    session: { id: 's-ws-1', webSearchRunCount: 3 }
  };
  const fourth = await executeTool(defs, ctx, 'web_search', { query: '第四次搜索' });
  assert.equal(fourth.isError, true, '第 4 次应被拒');
  assert.match(fourth.content, /上限 3/);
  assert.match(fourth.content, /已有搜索结果/);
  assert.equal(ctx.session.webSearchRunCount, 3, '被拒的调用不消耗搜索次数');
  // 空 query 直接打回（不占搜索次数）
  const empty = await executeTool(defs, ctx, 'web_search', { query: '   ' });
  assert.equal(empty.isError, true);
  assert.match(empty.content, /query 不能为空/);
  assert.equal(ctx.session.webSearchRunCount, 3, '空 query 也不应消耗搜索次数');
});

test('web_search：站内搜索正常计数，3 次后熔断不再发请求', async () => {
  const hits = [];
  const server = http.createServer((req, res) => {
    hits.push(req.url);
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<html><body><ul>'
      + '<li><a href="/doc/1">结果一 标题</a></li>'
      + '<li><a href="/doc/2">结果二 标题</a></li>'
      + '</ul><p>页面正文 mock。</p></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    updateConfig({
      security: {
        allowPrivateFetchHosts: true,
        browseLock: { enabled: true, domains: ['127.0.0.1'], searchUrl: `http://127.0.0.1:${port}/search?q={query}` }
      },
      webSearch: { fetchMaxChars: 2000 }
    });
    const defs = buildToolDefs();
    const ctx = {
      chatKey: 'group:100',
      kind: 'group',
      chatId: 100,
      session: { id: 's-ws-2' }
    };
    for (let i = 1; i <= 3; i++) {
      const out = await executeTool(defs, ctx, 'web_search', { query: `关键词${i}` });
      assert.equal(out.isError, undefined, `第 ${i} 次搜索应成功`);
      const payload = JSON.parse(out.content);
      assert.ok(payload.links.length >= 2, `第 ${i} 次站内搜索应解析出链接`);
    }
    assert.equal(ctx.session.webSearchRunCount, 3, '计数器应随成功搜索递增');
    assert.equal(hits.length, 3, '本地 mock 应被命中 3 次');
    const fourth = await executeTool(defs, ctx, 'web_search', { query: '第四次' });
    assert.equal(fourth.isError, true, '第 4 次应被拒');
    assert.match(fourth.content, /上限 3/);
    assert.equal(hits.length, 3, '被拒的搜索不应再发新请求');
  } finally {
    server.close();
  }
});
