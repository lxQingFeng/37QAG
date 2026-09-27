import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('Electron 升级基线：44.4.5、Node 22.12+、锁文件一致', () => {
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  const spec = pkg.devDependencies?.electron || '';
  assert.match(spec, /^\^44\./, `electron 版本应升级到 44.x，实际 ${spec}`);
  assert.equal(lock.packages['node_modules/electron']?.version, '44.4.5');
  assert.match(pkg.engines?.node || '', /^>=22\.12\.0$/, 'Electron 44 安装链要求 Node >=22.12.0');
});

test('Electron 42+ 安装检测认 CLI 包，不误依赖首次启动前的 dist', () => {
  const src = read('scripts/start.mjs');
  assert.match(src, /node_modules', 'electron', 'cli\.js'/);
  assert.doesNotMatch(src, /function haveElectron\(\)[\s\S]{0,220}node_modules', 'electron', 'dist'/);
});

test('console-message 同时兼容 Electron 44 事件对象与旧位置参数', () => {
  const src = read('electron/main.js');
  const start = src.indexOf('function logRendererConsole');
  const end = src.indexOf('\n}\n\nfunction createWindow', start);
  assert.ok(start >= 0 && end > start, '应存在 logRendererConsole 纯处理函数');
  const factory = new Function(`${src.slice(start, end + 2)}\nreturn logRendererConsole;`);
  const handler = factory();
  const oldLog = console.log;
  const lines = [];
  console.log = (line) => lines.push(line);
  try {
    handler({ level: 'warning', message: 'new-warning', lineNumber: 7, sourceId: 'new.js' });
    handler({ level: 'info', message: 'new-info', lineNumber: 8, sourceId: 'new.js' });
    handler({}, 3, 'legacy-error', 9, 'legacy.js');
    handler({}, 1, 'legacy-info', 10, 'legacy.js');
  } finally {
    console.log = oldLog;
  }
  assert.deepEqual(lines, [
    '[renderer] new-warning (new.js:7)',
    '[renderer] legacy-error (legacy.js:9)'
  ]);
});

test('CalculateNativeWinOcclusion 以真实命令行传递并保留大小写', () => {
  const flag = '--disable-features=CalculateNativeWinOcclusion,HighTouchLatency';
  const pkg = JSON.parse(read('package.json'));
  assert.match(pkg.scripts.start, new RegExp(flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  const launcher = read('launch.ps1');
  assert.equal(launcher.split(flag).length - 1, 2, '单号/双号两处 Electron 启动都应携带开关');
  assert.doesNotMatch(read('electron/main.js'), /appendSwitch\('disable-features'/);
});

test('Electron 44 包提供按需安装入口且语法检查覆盖主进程', () => {
  const electronPkg = JSON.parse(read('node_modules/electron/package.json'));
  assert.equal(electronPkg.bin?.['install-electron'], 'install.js');
  assert.match(read('package.json'), /node --check electron\/main\.js/);
});