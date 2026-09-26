// 阶段二回归：双端适配。
// 1) start.mjs 参数分支与启动日志路径（源码断言）；
// 2) local-jev 平台默认二进制名（win: .exe / posix: 无后缀）；
// 3) command-gateway 补丁引擎 builtin 检测（0.6.0+ 核心全部原生内置 → 无需打补丁）；
// 4) openPath/openInBrowser 在当前平台返回布尔且不抛错；
// 5) Linux 启动脚本存在且可执行。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

test('start.mjs：参数分支与日志路径（源码断言）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'start.mjs'), 'utf8');
  assert.ok(src.includes('--headless'), '应有 --headless 分支');
  assert.ok(src.includes('--desktop'), '应有 --desktop 分支');
  assert.ok(src.includes('--profile'), '应有 --profile 分支');
  assert.ok(src.includes('QQ_AGENT_PROFILE'), '应传递 profile 环境变量');
  assert.ok(src.includes('data/logs'), '启动日志应写入 data/logs/');
  assert.ok(!src.includes("path.join(ROOT, 'launch-log.txt')"), '不应再写根目录 launch-log.txt');
});

test('start.mjs 语法检查（node --check）', () => {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'scripts', 'start.mjs')], { stdio: 'pipe' });
});

test('local-jev：平台默认二进制名 + 备用名探测', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'local-jev.js'), 'utf8');
  assert.ok(src.includes("process.platform === 'win32' ? 'runtime/llama/llama-server.exe' : 'runtime/llama/llama-server'"),
    '默认 exe 应按平台分支');
  assert.ok(src.includes("'runtime/llama/llama-server' : 'runtime/llama/llama-server.exe'"), '找不到默认名时应探测另一平台名');
});

test('command-gateway patch.mjs：0.6.0 核心全部 builtin（无需打补丁）', async () => {
  const { status } = await import(pathToFileURL(path.join(ROOT, 'plugins', 'command-gateway', 'patch.mjs')).href);
  const st = status({ root: ROOT });
  assert.ok(st.state === 'builtin' || st.state === 'patched', `状态应为 builtin/patched，实际 ${st.state}`);
  assert.equal(st.files.length, 18, '18 个块');
  for (const f of st.files) {
    assert.ok(f.state === 'builtin' || f.state === 'patched', `块 ${f.id} 状态异常：${f.state} ${f.detail || ''}`);
  }
});

test('openPath/openInBrowser：跨平台布尔返回、不抛错', async () => {
  const { openPath, openInBrowser } = await import('../src/util.js');
  assert.equal(typeof openPath('/tmp'), 'boolean');
  assert.equal(typeof openInBrowser('http://127.0.0.1:1'), 'boolean');
});

test('Linux 启动脚本存在且可执行', () => {
  for (const name of ['启动-单号.sh', '启动-双号.sh', '启动-单号-调试模式.sh']) {
    const p = path.join(ROOT, name);
    assert.ok(fs.existsSync(p), `${name} 应存在`);
    assert.ok(fs.statSync(p).mode & 0o111, `${name} 应有执行位`);
  }
});
