#!/usr/bin/env node
// 统一启动器（阶段二：Windows/Linux 双端统一入口）。
//
// 用法：
//   node scripts/start.mjs                     # 自动模式：有 Electron 显示环境→桌面；否则 headless
//   node scripts/start.mjs --headless          # 服务器模式：node src/server.js（浏览器访问控制台）
//   node scripts/start.mjs --desktop           # 桌面模式：electron .（Windows/macOS/Linux 桌面）
//   node scripts/start.mjs --profile 2         # 第二实例（数据目录/端口自动错开）
//   node scripts/start.mjs --debug             # 前台运行、控制台可见（排错用）
//   node scripts/start.mjs --status            # 查看实例锁状态
//
// 与传统入口的关系（全部保留）：
//   Windows:  启动-单号.bat / 启动-双号.bat / 启动-单号-调试模式.bat（powershell 链不变）
//   Linux/macOS: 启动-单号.sh / 启动-双号.sh（本启动器的 bash 薄包装）
//   通用：     npm start / npm run start:headless / npm run start:desktop
//
// 启动日志统一写 data/logs/launch.log（阶段二数据单根；旧根目录 launch-log.txt 由
// paths.migrateLegacyLayout() 自动迁移）。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = process.env.QQ_AGENT_DATA_DIR || process.env.QAG_DATA_HOME
  || path.join(ROOT, process.env.QQ_AGENT_PROFILE ? `data-${process.env.QQ_AGENT_PROFILE}` : 'data');
const LOGS_DIR = path.join(DATA_DIR, 'logs');
const LAUNCH_LOG = path.join(LOGS_DIR, 'launch.log');

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, fallback = '') => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const mode = flag('headless') ? 'headless' : flag('desktop') ? 'desktop' : 'auto';
const profile = opt('profile', process.env.QQ_AGENT_PROFILE || '');
const debug = flag('debug') || flag('keep');
const quiet = flag('quiet');

function log(...a) {
  const line = `[start ${new Date().toISOString()}] ${a.join(' ')}`;
  if (!quiet) console.log(line);
  try {
    fs.mkdirSync(LOGS_DIR, { recursive: true });
    fs.appendFileSync(LAUNCH_LOG, line + '\n', 'utf8');
  } catch { /* 日志写不进不致命 */ }
}

function haveElectron() {
  // Electron 42+ 安装 npm 包时不再自动下载 dist；先认 CLI 包，首次启动时由 electron 自行按需下载二进制。
  try { return fs.existsSync(path.join(ROOT, 'node_modules', 'electron', 'cli.js')); } catch { return false; }
}

function haveDisplay() {
  if (process.platform === 'win32' || process.platform === 'darwin') return true;
  return !!process.env.DISPLAY || !!process.env.WAYLAND_DISPLAY;
}

function assertDeps() {
  if (!fs.existsSync(path.join(ROOT, 'node_modules'))) {
    console.error('[start] 缺少依赖：请先在项目目录执行  npm install');
    process.exit(1);
  }
}

function run(command, argv, { env = {} }) {
  const child = spawn(command, argv, {
    cwd: ROOT,
    stdio: debug ? 'inherit' : 'ignore',
    detached: false,
    env: { ...process.env, ...env }
  });
  child.on('exit', (code) => process.exit(code ?? 0));
  child.on('error', (error) => {
    console.error(`[start] 启动失败：${error?.message ?? error}（command=${command}）`);
    process.exit(1);
  });
  if (!debug) {
    log(`已在后台启动：${command} ${argv.join(' ')}（日志：${path.relative(ROOT, LAUNCH_LOG)}）`);
    setTimeout(() => process.exit(0), 800);
  }
}

// ── main ──
if (flag('help') || flag('h')) {
  const text = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const m = text.match(/\/\/ 用法：([\s\S]*?)\/\/\n\/\/ 与传统入口/);
  console.log(m ? `用法：${m[1].trim()}` : 'node scripts/start.mjs [--headless|--desktop] [--profile N] [--debug]');
  process.exit(0);
}

assertDeps();

const profileEnv = profile ? { QQ_AGENT_PROFILE: String(profile) } : {};
const finalMode = mode === 'auto'
  ? (haveElectron() && haveDisplay() ? 'desktop' : 'headless')
  : mode;

if (finalMode === 'desktop') {
  if (!haveElectron()) {
    console.error('[start] 未安装 electron（npm install），改走 headless 模式');
    log('自动回退 headless（无 electron）');
    run(process.execPath, ['src/server.js'], { env: profileEnv });
  } else {
    run('npm', ['start'], { env: profileEnv });
  }
} else {
  run(process.execPath, ['src/server.js'], { env: profileEnv });
}
