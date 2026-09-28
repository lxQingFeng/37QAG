// P0 UI 冒烟安全网（2026-09-27 UI 轻量改造 · 第一步）
//
// 目标：给 UI 关键路径建立可自动化校验，作为后续任何 UI 改动的回归底座。
// 覆盖：控制台加载（无 JS 错误）、12 个页签逐个切换、7 张主题预设应用、
//       6 种形态（data-ui-style 机制 + 机甲特效开关）、顶栏主题循环、
//       设置页自动保存读写（POST /api/config 全链路）、主题导入通道。
//
// 运行：npm run test:ui（独立于 npm test —— 主测试链不依赖浏览器环境）
// 依赖：全局 playwright + chromium（npm i -g playwright && npx playwright install chromium）
//
// ⚠️ 已知坑（与 ui-styles-test 同源）：主题应用/配置写入会改程序根的
//    desktop-prefs.json（锚定 ROOT，QAG_DATA_HOME 隔离不到）。
//    本测试自动备份并在结束后恢复。
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.UI_SMOKE_PORT || 3987);
const BASE = `http://127.0.0.1:${PORT}`;
const PREFS_FILE = path.join(ROOT, 'desktop-prefs.json');
const PREFS_BACKUP = path.join(os.tmpdir(), `qag-ui-smoke-prefs-${process.pid}.bak`);

let pw = null;
let browser = null;
let page = null;
let server = null;
let serverExit = null;
let prefsExisted = false;

/** 按 phase 收集页面 JS 错误（pageerror / console.error），最后统一断言。 */
const jsErrors = [];
function watchErrors(phase) {
  page.on('pageerror', (e) => jsErrors.push(`[${phase}] pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') jsErrors.push(`[${phase}] console.error: ${m.text()}`);
  });
}

async function httpOk(url, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch { /* 尚未监听 */ }
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}

/** 等前端启动完成（state.config 拉到即视为 boot 完成）。 */
function booted() {
  return page.waitForFunction(() => {
    try { return !!(state?.config?.api && state?.status); } catch { return false; }
  }, { timeout: 15000 });
}

/** 轮询服务端配置直到条件满足（设置自动保存的落盘判定）。 */
async function pollConfig(pred, timeoutMs, what) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    try {
      const config = await (await fetch(`${BASE}/api/config`)).json();
      last = config;
      if (pred(config)) return config;
    } catch { /* 服务未就绪 */ }
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.fail(`${what}（超时 ${timeoutMs}ms，最后读到 persona.botName=${last?.persona?.botName}）`);
}

before(async () => {
  // playwright 解析（全局安装即可，主测试链不依赖它）
  try { pw = await import('playwright'); } catch {
    throw new Error('playwright 未安装：npm i -g playwright && npx playwright install chromium');
  }
  // 隔离数据目录、禁用本地 Jev + 指定端口启动控制台
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qag-ui-smoke-'));
  prefsExisted = fs.existsSync(PREFS_FILE);
  if (prefsExisted) fs.copyFileSync(PREFS_FILE, PREFS_BACKUP);
  server = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, QAG_DATA_HOME: dataDir, QQ_AGENT_PORT: String(PORT), QQ_AGENT_NO_PEER: '1', QQ_AGENT_DISABLE_LOCAL_JEV: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  serverExit = new Promise((r) => server.on('exit', r));
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });
  server.getSmLog = () => serverLog;
  const ok = await httpOk(`${BASE}/`);
  if (!ok) {
    server.kill('SIGKILL');
    throw new Error(`控制台 ${PORT} 端口 30s 内未就绪。服务日志：\n${serverLog.slice(-1500)}`);
  }
  browser = await pw.chromium.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  watchErrors('boot');
});

after(async () => {
  try { await page?.close(); } catch { /* ignore */ }
  try { await browser?.close(); } catch { /* ignore */ }
  if (server) {
    server.kill('SIGTERM');
    await Promise.race([serverExit, new Promise((r) => setTimeout(r, 3000))]);
    if (!server.killed) server.kill('SIGKILL');
  }
  // 恢复 desktop-prefs.json（主题应用路径必然触碰它）
  if (prefsExisted && fs.existsSync(PREFS_BACKUP)) fs.copyFileSync(PREFS_BACKUP, PREFS_FILE);
  else if (!prefsExisted && fs.existsSync(PREFS_FILE)) fs.rmSync(PREFS_FILE);
  if (fs.existsSync(PREFS_BACKUP)) fs.rmSync(PREFS_BACKUP);
});

// ── 1. 控制台加载 ─────────────────────────────────────────────────────
test('加载：页面可访问、boot 完成、视图挂载', async () => {
  await page.goto(`${BASE}/`, { waitUntil: 'domcontentloaded' });
  await booted();
  assert.equal(await page.title(), '37QAG');
  // 首启未配置模型时控制台会引导跳到设置页：只断言「恰好一个激活视图」
  assert.equal(await page.locator('.view.active').count(), 1, '应有且仅有一个激活视图');
  const visibleTabs = await page.locator('.tab:not([hidden])').count();
  assert.ok(visibleTabs >= 11, `页签应 ≥11 个（免费API 可被隐藏），实际 ${visibleTabs}`);
});

// ── 2. 12 个页签逐个切换 ─────────────────────────────────────────────
test('页签：12 个视图逐个切换均激活且不抛错', async () => {
  const tabs = await page.$$eval('.tab', (els) => els.map((e) => e.dataset.tab));
  assert.equal(tabs.length, 12, `应有 12 个页签，实际 ${tabs.length}`);
  for (const name of tabs) {
    await page.locator(`.tab[data-tab="${name}"]`).click();
    await page.waitForTimeout(250);   // 视图加载是异步的
    const active = await page.evaluate((n) => ({
      tab: document.querySelector(`.tab[data-tab="${n}"]`)?.classList.contains('active'),
      view: document.querySelector(`#view-${n}`)?.classList.contains('active')
    }), name);
    assert.ok(active.tab, `页签 ${name} 应有 active 态`);
    assert.ok(active.view, `视图 view-${name} 应有 active 态`);
  }
});

// ── 3. 7 张主题预设 × 4. 6 种形态（data-ui-style 机制）───────────────
test('主题：7 张预设逐张应用（配色/形态/customThemeId 全对上）', async () => {
  // 进设置 → 桌面端分区（主题 chips 挂在那）
  await page.locator('.tab[data-tab="settings"]').click();
  await page.waitForTimeout(300);
  await page.locator('.settings-menu-item[data-section="desktop"]').click();
  await page.waitForSelector('#theme-presets .theme-preset-chip', { timeout: 5000 });

  // 服务端主题清单 = 断言的期望来源（前后端色值一致性正是双份维护风险的守护点）
  const { themes } = await (await fetch(`${BASE}/api/themes`)).json();
  assert.equal(themes.length, 7, `应内置 7 张主题，实际 ${themes.length}`);

  const FORM_OF = {
    'mech-orange': 'mech',
    'deepseek-maid': 'maid',
    'bijingyu-pixel': 'pixel',
    'sujian-paper': 'sujian',
    'deep-space-console': 'deepspace',
    'warm-room': 'warmroom',
    'classic-purple': null
  };
  // 拆分后样式表加载守卫（P1-a）：形态签名变量只有对应 CSS 文件生效才会出现
  const FORM_SIGN_VAR = {
    sujian: '--sj-serif',
    deepspace: '--ds-mono'
  };
  for (const th of themes) {
    const chip = page.locator(`#theme-presets [data-theme-id="${th.id}"]`);
    await chip.scrollIntoViewIfNeeded();
    await chip.click();
    await page.waitForTimeout(400);   // POST apply → GET themes → applyThemeColors 同步链
    const got = await page.evaluate((id) => {
      const root = document.documentElement;
      return {
        pref: getThemePref(),
        themeId: state?.config?.ui?.customThemeId || '',
        form: root.getAttribute('data-ui-style') || '',
        mechFx: root.getAttribute('data-mech-fx') || '',
        bg: root.style.getPropertyValue('--bg').trim()
      };
    }, th.id);
    assert.equal(got.pref, 'custom', `${th.id}：应进入自定义主题态`);
    assert.equal(got.themeId, th.id, `${th.id}：customThemeId 应一致`);
    assert.equal(got.form, FORM_OF[th.id] || '', `${th.id}：形态应=${FORM_OF[th.id] ?? '无'}，实际=${got.form}`);
    assert.equal(got.bg, th.colors.bg, `${th.id}：--bg 应=${th.colors.bg}，实际=${got.bg}`);
    if (th.id === 'mech-orange') assert.equal(got.mechFx, 'on', '机甲默认应带特效');
    const signVar = FORM_SIGN_VAR[FORM_OF[th.id]];
    if (signVar) {
      const val = await page.evaluate((v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim(), signVar);
      assert.ok(val.length > 0, `${th.id}：形态签名变量 ${signVar} 应非空（ui-forms.css 生效证明），实际「${val}」`);
    }
  }
});

test('主题：循环按钮 dark→light→system→?→dark', async () => {
  // 从当前态先回到 dark（custom 点循环键=退出自定义回 dark）
  for (let i = 0; i < 6 && (await page.evaluate(() => getThemePref())) !== 'dark'; i++) {
    await page.locator('#theme-btn').click();
    await page.waitForTimeout(150);
  }
  assert.equal(await page.evaluate(() => getThemePref()), 'dark');
  // 「?」彩蛋需要 confirm 放行
  const dialogHandler = (d) => d.accept().catch(() => {});
  page.on('dialog', dialogHandler);
  const seq = [];
  let chaosVar = '';
  for (let i = 0; i < 4; i++) {
    await page.locator('#theme-btn').click();
    await page.waitForTimeout(150);
    const pref = await page.evaluate(() => getThemePref());
    seq.push(pref);
    if (pref === '?') {
      chaosVar = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--ease-chaos').trim());
    }
  }
  page.off('dialog', dialogHandler);
  assert.deepEqual(seq, ['light', 'system', '?', 'dark'], `循环顺序错误：${seq.join('→')}`);
  // chaos.css 生效证明：「？」主题专属变量只有该文件加载才会出现
  // （在「？」激活的那一轮顺手读取）
  assert.ok(chaosVar && chaosVar.length > 0, `「？」主题应定义 --ease-chaos（chaos.css 生效证明），实际「${chaosVar}」`);
});

// ── 5. 设置页读写（自动保存全链路）───────────────────────────────────
test('设置：改人设名 → 600ms 防抖自动保存 → /api/config 落盘', async () => {
  await page.locator('.settings-menu-item[data-section="persona"]').click();
  await page.waitForSelector('#cfg-botname', { timeout: 5000 });
  const before = await page.locator('#cfg-botname').inputValue();
  const after = before === '冒烟测试Bot' ? '冒烟测试Bot2' : '冒烟测试Bot';
  await page.locator('#cfg-botname').fill(after);
  // 以服务端落盘为准（提示文案「已保存 ✓」存在短暂竞态，不作判定依据）
  await pollConfig((c) => c.persona?.botName === after, 8000, '自动保存未落盘（新值）');
  assert.ok(await page.evaluate(() => !state?.settingsDirty), '保存完成后 dirty 标记应复位');
  // 还原
  await page.locator('#cfg-botname').fill(before);
  await pollConfig((c) => c.persona?.botName === before, 8000, '自动保存未落盘（还原）');
});

// ── 6. 主题导入通道 ──────────────────────────────────────────────────
test('主题：导入 .json 主题文件 → 立即应用且出现在清单', async () => {
  const tmpTheme = path.join(os.tmpdir(), `qag-smoke-theme-${process.pid}.json`);
  const colors = { bg: '#101820', bg2: '#18222e', bg3: '#202c3a', accent: '#7ee0a3', toolAccent: '#9be3b5', text: '#eef5f1', muted: '#a7bcb0', faint: '#6f8478' };
  fs.writeFileSync(tmpTheme, JSON.stringify({ id: 'smoke-test-theme', name: '冒烟测试主题', colors }, null, 2));
  await page.locator('.settings-menu-item[data-section="desktop"]').click();
  // 隐藏的 file input：等挂载即可（setInputFiles 对 hidden 元素同样有效）
  await page.waitForSelector('#cfg-theme-import-file', { state: 'attached', timeout: 5000 });
  await page.setInputFiles('#cfg-theme-import-file', tmpTheme);
  await page.waitForFunction(() => {
    try { return state?.config?.ui?.customThemeId === 'smoke-test-theme'; } catch { return false; }
  }, { timeout: 8000 });
  const { themes } = await (await fetch(`${BASE}/api/themes`)).json();
  assert.ok(themes.some((t) => t.id === 'smoke-test-theme'), '导入主题应出现在 /api/themes 清单');
  const bg = await page.evaluate(() => document.documentElement.style.getPropertyValue('--bg').trim());
  assert.equal(bg, colors.bg, `导入主题应立即应用（--bg=${colors.bg}，实际=${bg}）`);
  fs.rmSync(tmpTheme, { force: true });
});

// ── 7. 知识库死键开关（2026-09-28 接线修复）───────────────────────────
test('知识库：internal/images 总开关 → /api/config 落盘且可还原（死键接线）', async () => {
  await page.locator('.tab[data-tab="memes"]').click();
  await page.waitForSelector('#kb-internal-on', { timeout: 5000 });
  // 初始默认全开（knowledge.internal.enabled / knowledge.images.enabled 均为 true）
  assert.equal(await page.locator('#kb-internal-on').isChecked(), true, 'internal 开关默认应开');
  assert.equal(await page.locator('#kb-images-on').isChecked(), true, 'images 开关默认应开');
  // 关 internal → 落盘 false
  await page.locator('#kb-internal-on').uncheck();
  await pollConfig((c) => c.knowledge?.internal?.enabled === false, 8000, 'internal 开关未落盘');
  // 还原 true
  await page.locator('#kb-internal-on').check();
  await pollConfig((c) => c.knowledge?.internal?.enabled !== false, 8000, 'internal 还原未落盘');
  // images 同样走一遍
  await page.locator('#kb-images-on').uncheck();
  await pollConfig((c) => c.knowledge?.images?.enabled === false, 8000, 'images 开关未落盘');
  await page.locator('#kb-images-on').check();
  await pollConfig((c) => c.knowledge?.images?.enabled !== false, 8000, 'images 还原未落盘');
});

// ── 8. 全程无 JS 错误 ────────────────────────────────────────────────
test('全程零 JS 错误（pageerror / console.error）', async () => {
  assert.deepEqual(jsErrors, [], 'UI 冒烟过程中不应有任何 JS 错误');
});
