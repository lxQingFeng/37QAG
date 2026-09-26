// 阶段三回归：tool-gate.js（规则分类 / 工具过滤 / 结果截断 / 轮内预算 / Jev 规格）。
import { test } from 'node:test';
import assert from 'node:assert';

const gate = await import('../src/tool-gate.js');
const { classifyToolNeed, filterToolDefs, truncateToolResult, toolResultBudgetLeft, categoryOf, TOOL_CATEGORIES, TOOL_GATE_JEV_SPEC } = gate;

const DEFS = [
  { name: 'send_message' },
  { name: 'send_sticker' },
  { name: 'get_recent_messages' },
  { name: 'web_search' },
  { name: 'web_fetch' },
  { name: 'search_images' },
  { name: 'get_message_images' },
  { name: 'identify_image' },
  { name: 'memory_query' },
  { name: 'memory_search' }
];

test('分类表：核心发言工具归 core（常驻）', () => {
  assert.equal(categoryOf('send_message'), 'core');
  assert.equal(categoryOf('send_sticker'), 'core');
  assert.equal(categoryOf('get_recent_messages'), 'core');
  assert.equal(categoryOf('web_search'), 'search');
  assert.equal(categoryOf('identify_image'), 'media');
  assert.equal(categoryOf('memory_query'), 'memory');
  assert.equal(categoryOf('未收录的新工具'), 'core', '未收录默认常驻（新工具不因门控漏注入）');
});

test('规则：@机器人 → 全量（被请求强信号）', () => {
  assert.equal(classifyToolNeed('嗯', { atMe: true }).need, 'all');
});

test('规则：带图 → 至少开 media', () => {
  const v = classifyToolNeed('看看这个', { hasImage: true });
  assert.equal(v.need, 'cats');
  assert.ok(v.cats.includes('media'));
});

test('规则：纯闲聊形态 → none（信息工具全砍）', () => {
  for (const t of ['哈哈哈哈哈', '嗯', '行吧', 'ok', '睡了睡了', '666', '草']) {
    assert.equal(classifyToolNeed(t).need, 'none', `「${t}」应判纯闲聊`);
  }
});

test('规则：信号词 → 只开对应类别', () => {
  const v1 = classifyToolNeed('今天天气怎么样');
  assert.equal(v1.need, 'cats');
  assert.ok(v1.cats.includes('search'), '天气应开 search');

  const v2 = classifyToolNeed('这图里是啥');
  assert.equal(v2.need, 'cats');
  assert.ok(v2.cats.includes('media'), '识图应开 media');

  const v3 = classifyToolNeed('你上次说的那事呢');
  assert.equal(v3.need, 'cats');
  assert.ok(v3.cats.includes('memory'), '旧事应开 memory');
});

test('规则：长文本（>40字）→ 全量保底', () => {
  const long = '今天我们讨论一下关于宇宙膨胀速度与暗能量密度的最新观测数据吧，这个问题挺有意思的，大家可以随便聊聊自己的看法和疑问';
  assert.ok(long.length > 40);
  assert.equal(classifyToolNeed(long).need, 'all');
});

test('规则：短且无信号 → unknown（交给 Jev 或全量保底）', () => {
  assert.equal(classifyToolNeed('这游戏副本怎么打').need, 'unknown');
  assert.equal(classifyToolNeed('诶那个谁').need, 'unknown');
});

test('过滤：none 时信息工具全砍，发言/群聊辅助保留', () => {
  const out = filterToolDefs(DEFS, { need: 'none', cats: [] });
  const names = out.map((d) => d.name);
  assert.ok(names.includes('send_message'), '发言工具必须保留');
  assert.ok(names.includes('send_sticker'));
  assert.ok(names.includes('get_recent_messages'), '群聊辅助保留');
  for (const gone of ['web_search', 'web_fetch', 'search_images', 'get_message_images', 'identify_image', 'memory_query', 'memory_search']) {
    assert.ok(!names.includes(gone), `${gone} 应被砍掉`);
  }
});

test('过滤：cats=search 只开联网类', () => {
  const out = filterToolDefs(DEFS, { need: 'cats', cats: ['search'] });
  const names = out.map((d) => d.name);
  assert.ok(names.includes('web_search'));
  assert.ok(names.includes('web_fetch'));
  assert.ok(!names.includes('memory_query'));
  assert.ok(!names.includes('identify_image'));
  assert.ok(names.includes('send_message'), 'core 永远保留');
});

test('过滤：all / unknown → 原样全量（保底语义）', () => {
  assert.equal(filterToolDefs(DEFS, { need: 'all', cats: [] }).length, DEFS.length);
  assert.equal(filterToolDefs(DEFS, { need: 'unknown', cats: [] }).length, DEFS.length);
  assert.deepEqual(filterToolDefs(DEFS, null), DEFS, 'null verdict 视为全量');
});

test('截断：超长结果截断并带尾注与长度提示', () => {
  const long = 'A'.repeat(10_000);
  const out = truncateToolResult(long, 6000);
  assert.ok(out.length < 6200);
  assert.ok(out.includes('已截断'));
  assert.ok(out.includes('10000'), '应提示原文长度');
  assert.equal(truncateToolResult('短结果', 6000), '短结果', '不超长原样返回');
});

test('预算：累计字符扣减与用尽判定', () => {
  assert.equal(toolResultBudgetLeft([], 12000), 12000);
  assert.equal(toolResultBudgetLeft(['A'.repeat(5000)], 12000), 7000);
  assert.equal(toolResultBudgetLeft(['A'.repeat(15000)], 12000), 0);
});

test('Jev 规格：标签/示例/positive 完整且与 local-jev 注册一致', async () => {
  assert.deepEqual(TOOL_GATE_JEV_SPEC.labels, ['TOOL', 'CHAT']);
  assert.equal(TOOL_GATE_JEV_SPEC.positive, 'TOOL');
  assert.ok(TOOL_GATE_JEV_SPEC.examples.length >= 4);
  // 与 local-jev.js 的 JEV_GATE_SPECS.toolNeedGate 逐字段一致（防两处漂移）
  const jev = await import('../src/local-jev.js');
  const spec = jev.JEV_GATE_SPECS.toolNeedGate;
  assert.ok(spec, 'local-jev 应注册 toolNeedGate');
  assert.equal(spec.instruction, TOOL_GATE_JEV_SPEC.instruction);
  assert.deepEqual(spec.labels, TOOL_GATE_JEV_SPEC.labels);
  assert.equal(spec.positive, TOOL_GATE_JEV_SPEC.positive);
});

test('配置默认：api.toolGate=rules / channel=cloud / 本地端点默认指向 llama-server', async () => {
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  assert.equal(DEFAULT_CONFIG.api.toolGate, 'rules');
  assert.equal(DEFAULT_CONFIG.api.channel, 'cloud');
  assert.equal(DEFAULT_CONFIG.api.local.baseUrl, 'http://127.0.0.1:18080/v1');
  assert.equal(DEFAULT_CONFIG.api.fallback, 'local-to-cloud');
  assert.equal(DEFAULT_CONFIG.api.toolResultMaxChars, 6000);
  assert.equal(DEFAULT_CONFIG.api.toolResultBudgetChars, 12000);
});
