// 收官冒烟（2026-09-26）发现的缺口回归：sessions.js 的 usage-today.json 读写
// 曾引用未导入的 DATA_DIR（阶段二路径集中化的漏网之鱼）。症状：每个会话 finish
// 都在 #persist 的 catch 里误报「持久化失败: DATA_DIR is not defined」，
// 且当日用量统计（todayUsage 读回）永远为 0。
// 修复：从 paths.js 导入 DATA_DIR。本测试走完 create→finish 全路径验证落盘与读回。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qag-session-usage-'));
process.env.QAG_DATA_HOME = TMP;            // 必须在 import config 之前设置

const { SessionRegistry } = await import('../src/sessions.js');

test('会话结束后今日用量写入 usage-today.json 且 todayUsage 读回一致', () => {
  const reg = new SessionRegistry();
  const s = reg.create({ chatKey: 'group:99001', trigger: [{ text: '报数' }] });
  s.usage.promptTokens = 100;
  s.usage.completionTokens = 20;
  s.usage.totalTokens = 120;
  reg.finish(s.id, 'completed');

  // 1) 当日用量汇总文件已写出（修复前这一步抛 ReferenceError）
  const file = path.join(TMP, 'usage-today.json');
  assert.ok(fs.existsSync(file), 'usage-today.json 应已写入');
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(data.runs, 1);
  assert.equal(data.totalTokens, 120);

  // 2) 读回口径：已结束会话的量计入 todayUsage（修复前恒为 0）
  const today = reg.todayUsage(data.dayKey);
  assert.equal(today.runs, 1);
  assert.equal(today.totalTokens, 120);

  // 3) 会话留档本体不受影响（本就写在报错之前）
  assert.ok(fs.existsSync(path.join(TMP, 'sessions', `${s.id}.json`)), '会话 JSON 应存在');
});
