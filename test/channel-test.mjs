// 阶段三回归：模型通道（本地/云端二选一 + 回退策略）。
// QAG_DATA_HOME 重定向到临时目录，改配置后验证解析纯函数；本地端点探测用 mock 服务器。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qag-channel-'));
process.env.QAG_DATA_HOME = TMP;

const config = await import('../src/config.js');
const { updateConfig, getConfig } = config;
const llm = await import('../src/llm.js');
const { primaryChannel, channelOverrides, canFallbackToCloud, canFallbackToLocal, localEndpointCfg, probeLocalEndpoint } = llm;

function resetApi(patch = {}) {
  updateConfig({ api: { baseUrl: '', apiKey: '', model: '', channel: 'cloud', local: { baseUrl: 'http://127.0.0.1:18080/v1', model: '', apiKey: '' }, fallback: 'local-to-cloud', ...patch } });
}

test('默认（0.5 兼容）：channel=cloud，主通道云端、无本地 overrides', () => {
  resetApi();
  assert.equal(primaryChannel(), 'cloud');
  assert.equal(channelOverrides('cloud'), null);
  assert.equal(canFallbackToCloud(), false, '云端没配全时不可回退');
});

test('channel=local：主通道本地，overrides 指向本地端点', () => {
  resetApi({ channel: 'local', local: { baseUrl: 'http://127.0.0.1:19000/v1', model: 'my-local-model', apiKey: '' } });
  assert.equal(primaryChannel(), 'local');
  const ov = channelOverrides('local');
  assert.equal(ov.baseUrl, 'http://127.0.0.1:19000/v1');
  assert.equal(ov.model, 'my-local-model');
});

test('channel=local + 云端配全 → 允许 local-to-cloud 回退；fallback=none → 不允许', () => {
  resetApi({ channel: 'local', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test' });
  assert.equal(canFallbackToCloud(), true);
  updateConfig({ api: { fallback: 'none' } });
  assert.equal(canFallbackToCloud(), false);
  updateConfig({ api: { fallback: 'local-to-cloud' } });
});

test('channel=auto：云端配全 → 主云端；云端缺失 → 主本地（离线可用）', () => {
  resetApi({ channel: 'auto', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-test' });
  assert.equal(primaryChannel(), 'cloud');
  resetApi({ channel: 'auto', baseUrl: '', apiKey: '' });
  assert.equal(primaryChannel(), 'local');
});

test('localEndpointCfg：默认端点指向 localJev 的 llama-server', () => {
  resetApi({ local: { baseUrl: 'http://127.0.0.1:18080/v1/' } });
  const cfg = localEndpointCfg();
  assert.equal(cfg.baseUrl, 'http://127.0.0.1:18080/v1', '尾斜杠应去掉');
});

test('probeLocalEndpoint：可达端点返回模型名（30s 缓存生效）', async () => {
  const server = http.createServer((req, res) => {
    if (req.url.includes('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'test-model-a' }] }));
    } else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const r1 = await probeLocalEndpoint({ force: true });
    // 注意：probe 读的是 getConfig().api.local —— 先指向 mock 端口
    const r = await (async () => {
      updateConfig({ api: { local: { baseUrl: `http://127.0.0.1:${port}/v1`, model: '', apiKey: '' } } });
      return probeLocalEndpoint({ force: true });
    })();
    assert.ok(r.ok);
    assert.equal(r.model, 'test-model-a');
    // 缓存命中（不再发请求也能拿）
    const r2 = await probeLocalEndpoint();
    assert.ok(r2.ok && r2.cached);
  } finally {
    server.close();
  }
});

test('probeLocalEndpoint：不可达端点快速失败（1.5s 超时）', async () => {
  updateConfig({ api: { local: { baseUrl: 'http://127.0.0.1:1/v1', model: '', apiKey: '' } } });
  const t0 = Date.now();
  const r = await probeLocalEndpoint({ force: true });
  assert.equal(r.ok, false);
  assert.ok(Date.now() - t0 < 4000, '应快速失败');
});

test('配置迁移：0.5 旧配置（无 channel/toolGate 字段）自动获得默认值', () => {
  // deepMerge 语义：旧存档缺 key → DEFAULT_CONFIG 补齐（loadConfig 已测，这里验证 DEFAULT 存在）
  resetApi();
  const cfg = getConfig();
  assert.ok('channel' in cfg.api);
  assert.ok('local' in cfg.api);
  assert.ok('fallback' in cfg.api);
  assert.ok('toolGate' in cfg.api);
  assert.ok('toolResultMaxChars' in cfg.api);
  assert.ok('toolResultBudgetChars' in cfg.api);
});
