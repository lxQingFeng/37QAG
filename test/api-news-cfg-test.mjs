// 设置项补齐回归：免费 API 情报模块的配置读取路径。
// 背景（2026-09-27 修复）：impl.collectFreeApiCandidates 原先读顶层 getConfig().apiNews
// （该段不存在，默认配置播种在 webSearch.apiNews），用户自定义的抓取源/订阅完全无效。
// 本测试用桩 fetch 证明：webSearch.apiNews.feeds 确实被读取并用于抓取。
// 另如实记录：collectSearchSeeds 的 import('./web-search.js') 路径错误 → 定向搜索补充
// 恒为空（保持原样未修：修复会激活搜索网络调用，改变默认行为与成本）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qag-apinews-'));
process.env.QAG_DATA_HOME = TMP;

const config = await import('../src/config.js');
const { DEFAULT_CONFIG, updateConfig, getConfig } = config;
const impl = await import('../modules/api-news/impl.js');

// ── 配置层 ─────────────────────────────────────────────────────────────
test('默认配置：webSearch.apiNews 三键齐全（enabled/sources/feeds）', () => {
  assert.equal(DEFAULT_CONFIG.webSearch.apiNews.enabled, true);
  assert.deepEqual(DEFAULT_CONFIG.webSearch.apiNews.sources, []);
  assert.deepEqual(DEFAULT_CONFIG.webSearch.apiNews.feeds, []);
});

test('webSearch.apiNews.feeds 被读取：自定义 RSS 源会真被抓取（失效键回归）', async () => {
  const STUB_URL = 'http://stub.test/custom-rss';
  const ITEM_URL = 'https://example.com/deepseek-free';
  const rss = `<?xml version="1.0"?><rss><channel>
    <item><title>DeepSeek API 免费额度 长期免费</title><link>${ITEM_URL}</link>
    <description>免费额度领取，长期免费开放</description>
    <pubDate>Sun, 27 Sep 2026 00:00:00 GMT</pubDate></item>
  </channel></rss>`;
  const hits = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    hits.push(String(url));
    if (String(url) === STUB_URL) return { ok: true, status: 200, text: async () => rss };
    return { ok: false, status: 500, text: async () => '' };
  };
  try {
    updateConfig({ webSearch: { apiNews: { feeds: [{ name: '桩源', url: STUB_URL }] } } });
    const out = await impl.collectFreeApiCandidates({ max: 10 });
    assert.ok(hits.includes(STUB_URL), `桩源应被抓取；实际请求：${hits.join(' , ')}`);
    assert.ok(Array.isArray(out) && out.some((x) => x.url === ITEM_URL), '桩源条目应进入候选清单');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('调度开关与抓取配置同段：读 webSearch.apiNews.enabled（不误读顶层 apiNews）', () => {
  updateConfig({ webSearch: { apiNews: { enabled: false } } });
  // 调度器的闸：enabled === false 时不跑凌晨刷新（impl.startApiNewsScheduler 的 tick 判定）
  assert.equal(getConfig().webSearch?.apiNews?.enabled, false);
  assert.equal(getConfig().apiNews, undefined, '顶层 apiNews 段不应被播种（旧误读路径已修复）');
});
