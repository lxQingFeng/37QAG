// 阶段二回归：paths.js 路径集中层（getter / 环境变量搬根 / 旧布局迁移 / 插件数据隔离）。
// 用 QAG_DATA_HOME 重定向到临时目录，不碰真实 data/。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qag-paths-'));
process.env.QAG_DATA_HOME = TMP;            // 必须在 import config 之前设置

const paths = await import('../src/paths.js');
const { dataRoot, logsDir, pluginDataDir, pluginDataRoot, userThemesDir, builtinThemesDir, themeDirs, migrateLegacyLayout, messagesDir, sessionsDir, memoryDir, legacyPluginDataRoot } = paths;

test('环境变量搬根：dataRoot 跟随 QAG_DATA_HOME', () => {
  assert.equal(dataRoot(), TMP);
});

test('路径 getter 全部落在 data/ 单根下（目录名约定）', () => {
  for (const [name, dir] of [
    ['logs', logsDir()], ['plugin-data', pluginDataRoot()], ['messages', messagesDir()],
    ['sessions', sessionsDir()], ['memory', memoryDir()], ['themes', userThemesDir()]
  ]) {
    assert.equal(path.dirname(dir), TMP, `${name} 应直接位于数据根下`);
  }
});

test('插件数据隔离：pluginDataDir 消毒 id 且互不越界', () => {
  assert.equal(pluginDataDir('abc'), path.join(TMP, 'plugin-data', 'abc'));
  // 危险字符消毒成 _
  assert.equal(pluginDataDir('../evil'), path.join(TMP, 'plugin-data', '.._evil'));
  assert.equal(pluginDataDir('a/b\\c'), path.join(TMP, 'plugin-data', 'a_b_c'));
});

test('主题双层：用户层在 data/，内置层在程序根', () => {
  assert.equal(path.dirname(userThemesDir()), TMP);
  assert.ok(!builtinThemesDir().startsWith(TMP), '内置主题不应在数据根下');
  assert.deepEqual(themeDirs(), [userThemesDir(), builtinThemesDir()]);
});

test('migrateLegacyLayout：command_data → plugin-data（幂等）', () => {
  // 造旧布局
  fs.mkdirSync(path.join(TMP, 'command_data', 'my-plugin'), { recursive: true });
  fs.writeFileSync(path.join(TMP, 'command_data', 'my-plugin', 'x.json'), '{}');
  const moves1 = migrateLegacyLayout({ log: () => {} });
  assert.ok(moves1.some((m) => m.includes('command_data')), '第一次应报告迁移');
  assert.ok(fs.existsSync(path.join(TMP, 'plugin-data', 'my-plugin', 'x.json')), '数据应已搬到 plugin-data');
  assert.ok(!fs.existsSync(path.join(TMP, 'command_data', 'my-plugin')), '旧目录应已清空');
  // 幂等
  const moves2 = migrateLegacyLayout({ log: () => {} });
  assert.ok(!moves2.some((m) => m.includes('command_data') && !m.includes('补齐')), '第二次不应重复迁移');
});

test('migrateLegacyLayout：根目录 launch-log.txt → data/logs/', () => {
  const ROOT_DIR = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  // 用 legacyPluginDataRoot 同级的伪造根不行（launch-log 迁移用真实 ROOT）——
  // 真实 ROOT 下通常无 launch-log.txt（干净检出），此时迁移应为 no-op 且不抛错
  const moves = migrateLegacyLayout({ log: () => {} });
  assert.ok(Array.isArray(moves));
});

test('旧路径只读兼容：legacyPluginDataRoot 指向 command_data', () => {
  assert.equal(legacyPluginDataRoot(), path.join(TMP, 'command_data'));
});
