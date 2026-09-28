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

// ── web_fetch 正文提纯 + 三档闸迁移（2026-09-28 · 工具结果 token 优化②③）──

test('web_fetch：正文提纯为纯文本 + links/images，不再直塞原始 HTML', async () => {
  const pageHtml = '<html><head><title>标题</title><style>.x{color:red}</style></head><body>'
    + '<script>var noisy = "脚本噪声";</script>'
    + '<h1>文章标题</h1>'
    + '<p>这是正文第一段，讲清楚了事情的全貌。' + '正文内容持续输出，讲得足够长以覆盖多个句子。'.repeat(20) + '</p>'
    + '<a href="/related/1">相关阅读一</a> <a href="/related/2">相关阅读二</a>'
    + '<img src="/pic/a.jpg" alt="插图">'
    + '</body></html>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    updateConfig({
      security: { allowPrivateFetchHosts: true, browseLock: { enabled: false, domains: [], searchUrl: '' } },
      webSearch: { fetchMaxChars: 1500 }
    });
    const defs = buildToolDefs();
    const ctx = { chatKey: 'group:100', kind: 'group', chatId: 100, session: { id: 's-wf-1' } };
    const out = await executeTool(defs, ctx, 'web_fetch', { url: `http://127.0.0.1:${port}/page` });
    assert.equal(out.isError, undefined);
    const payload = JSON.parse(out.content);
    // 正文是提纯后的纯文本：有正文、没有标签与脚本噪声
    assert.ok(payload.content.includes('这是正文第一段'), '正文应保留');
    assert.doesNotMatch(payload.content, /<script|<\/p>|<h1>/, '正文不应再带 HTML 标签');
    assert.ok(payload.content.length <= 1500, '正文长度受 fetchMaxChars 钳制');
    // 页面链接（相对路径补全为绝对）与图片直链
    assert.ok(payload.links.some((l) => String(l.url).endsWith('/related/1') && l.text.includes('相关阅读一')), '应解出页面链接');
    assert.ok(payload.images.some((i) => String(i.url).endsWith('/pic/a.jpg')), '应解出图片直链');
    // 序列化顺序：content 在 links 之前（结果超长被硬截断时先砍链接保正文）
    assert.ok(out.content.indexOf('"content"') < out.content.indexOf('"links"'), 'content 应排在 links 之前');
    // 同页重抓：走 memo 短路，不重复返回正文
    const again = JSON.parse((await executeTool(defs, ctx, 'web_fetch', { url: `http://127.0.0.1:${port}/page` })).content);
    assert.match(again.note, /已经抓过/);
    assert.equal(again.content, undefined, '重复抓取不应再返回正文');
  } finally {
    server.close();
  }
});

test('web_fetch：提纯为空的 JS 渲染页兜底退回原始 HTML 并给可执行提示', async () => {
  const jsPage = '<html><body><div id="root"></div>'
    + '<script>window.__INITIAL__={"data":"rendered-by-js"};</script>'
    + '</body></html>';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(jsPage);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    updateConfig({
      security: { allowPrivateFetchHosts: true, browseLock: { enabled: false, domains: [], searchUrl: '' } },
      webSearch: { fetchMaxChars: 2000 }
    });
    const defs = buildToolDefs();
    const ctx = { chatKey: 'group:100', kind: 'group', chatId: 100, session: { id: 's-wf-2' } };
    const out = await executeTool(defs, ctx, 'web_fetch', { url: `http://127.0.0.1:${port}/js` });
    assert.equal(out.isError, undefined);
    const payload = JSON.parse(out.content);
    // 提纯为空 → 兜底退回旧行为：原始 HTML 截断
    assert.ok(payload.content.includes('<script'), '提纯为空应兜底退回原始 HTML');
    // 空正文提示（可执行的下一步）
    assert.ok(payload.hint && payload.hint.includes('JS 渲染'), '应给出 JS 渲染页的下一步提示');
  } finally {
    server.close();
  }
});

test('三档闸迁移：旧默认 8000/6000/12000 跟随新默认，用户自定义值不动', async () => {
  // 模拟「线上老档」：三键显式写死旧默认（deepMerge 存档值优先，只改 DEFAULT_CONFIG 对它无效）
  updateConfig({
    api: { toolResultMaxChars: 6000, toolResultBudgetChars: 12000 },
    webSearch: { fetchMaxChars: 8000 },
    security: { browseLock: { enabled: false, domains: [], searchUrl: '' } }
  });
  reloadConfig();
  let cfg = getConfig();
  assert.equal(cfg.api.toolResultMaxChars, 3000, '旧默认 6000 应迁移到 3000');
  assert.equal(cfg.api.toolResultBudgetChars, 8000, '旧默认 12000 应迁移到 8000');
  assert.equal(cfg.webSearch.fetchMaxChars, 4000, '旧默认 8000 应迁移到 4000');
  assert.equal(cfg.api.toolGatesMigrated, '2026-09-28', '迁移标记应打上且只跑一次');
  // 用户自定义值（≠旧默认）一律不动
  updateConfig({ api: { toolResultMaxChars: 5000, toolResultBudgetChars: 9000 }, webSearch: { fetchMaxChars: 6000 } });
  reloadConfig();
  cfg = getConfig();
  assert.equal(cfg.api.toolResultMaxChars, 5000, '自定义值不应被迁移改写');
  assert.equal(cfg.api.toolResultBudgetChars, 9000, '自定义值不应被迁移改写');
  assert.equal(cfg.webSearch.fetchMaxChars, 6000, '自定义值不应被迁移改写');
});

// ── 工具提示语 gate-aware（2026-09-28 · noreply 三连诊断·缺陷4 纠偏）──
// 三连 noreply 实况：search_images/web_fetch 被门控裁掉后，工具报错/无命中文案
// 仍在引导模型去用这些不存在的工具 → 模型对着空图库编 URL、反复撞 404。
// 修复：orchestrator 把门控后的 availableTools 注入 ctx，文案按它自适应。

test('image_lib_search 空库无命中：search_images 被裁时不再推荐它（缺陷4）', async () => {
  const defs = buildToolDefs();
  // 图库为空（tmp 数据目录）→ 必走无命中分支
  const base = { chatKey: 'group:100', kind: 'group', chatId: 100, session: { id: 's-gate-1' } };
  // ① ctx 未带 availableTools（旧调用方/未门控）→ 保守沿用旧文案
  const legacy = await executeTool(defs, base, 'image_lib_search', { query: '菲比' });
  assert.match(legacy.content, /search_images/);
  // ② 本轮工具集里没有 search_images（被门控裁掉）→ 引导直接文字收尾
  const gated = await executeTool(defs, { ...base, availableTools: new Set(['send_message', 'image_lib_search']) },
    'image_lib_search', { query: '菲比' });
  assert.doesNotMatch(gated.content, /search_images/, '被裁的工具不应再出现在提示里');
  assert.match(gated.content, /本轮没有联网搜图工具/);
  assert.match(gated.content, /send_message/);
  // ③ search_images 在本轮工具集里 → 旧文案
  const full = await executeTool(defs, { ...base, availableTools: new Set(['send_message', 'search_images', 'image_lib_search']) },
    'image_lib_search', { query: '菲比' });
  assert.match(full.content, /search_images/);
});

test('send_image 404 提示：web_fetch 被裁时不再引导复制其 images（缺陷4）', async () => {
  const server = http.createServer((req, res) => { res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found'); });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    updateConfig({
      security: {
        allowPrivateFetchHosts: true,
        allowPrivateImageHosts: true,
        browseLock: { enabled: false, domains: [], searchUrl: '' },
        imageSend: { enabled: true, requirePreview: false, maxPerRun: 2, maxPreviewsPerRun: 3 }
      }
    });
    const defs = buildToolDefs();
    const url = `http://127.0.0.1:${port}/gone.jpg`;
    const base = { chatKey: 'group:100', kind: 'group', chatId: 100,
      session: { id: 's-gate-2', sent: [], imagePreviewed: [] }, emit() {} };
    // ① web_fetch 不可见：不再提「从 web_fetch 返回的 images 里复制」
    const gated = await executeTool(defs, { ...base, availableTools: new Set(['send_message', 'send_image']) },
      'send_image', { url });
    assert.equal(gated.isError, true);
    assert.match(gated.content, /图片下载失败/);
    assert.doesNotMatch(gated.content, /web_fetch/, '被裁的工具不应再被引导');
    assert.match(gated.content, /别再重试这个地址/);
    // ② web_fetch 可见：沿用旧提示（教它原样复制 images 里的直链）
    const legacy = await executeTool(defs, { ...base, availableTools: new Set(['send_message', 'send_image', 'web_fetch']) },
      'send_image', { url });
    assert.equal(legacy.isError, true);
    assert.match(legacy.content, /web_fetch/);
  } finally {
    server.close();
  }
});
