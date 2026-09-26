// 阶段四回归：三套 UI 风格集成（素笺/深空控制台/暖房）。
// 覆盖：theme.json 内置收录、跨文件一致性（app.js 预设 ↔ theme.json ↔ 原型 :root）、
// data-ui-style 机制扩展完整度、CSS 形态段落、双端同一份 UI 资源。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ── 1. 主题层 ───────────────────────────────────────────────────────────
test('三份 theme.json 落在 themes/ 内置层，listThemes 收录且颜色完整', async () => {
  for (const id of ['sujian-paper', 'deep-space-console', 'warm-room']) {
    const file = path.join(ROOT, 'themes', `${id}.json`);
    assert.ok(fs.existsSync(file), `${id}.json 应在 themes/ 内置层`);
    const data = JSON.parse(read(`themes/${id}.json`));
    assert.equal(data.format, 'qq-agent-theme');
    for (const k of ['bg', 'bg2', 'bg3', 'accent', 'tool-accent', 'text', 'muted', 'faint']) {
      assert.ok(data.colors[k], `${id} 缺颜色 ${k}`);
    }
  }
  const { listThemes, getThemeById } = await import('../modules/themes/impl.js');
  assert.ok(listThemes().length >= 7, '内置主题应达 7 个（原 4 + 新 3）');
  for (const id of ['sujian-paper', 'deep-space-console', 'warm-room']) {
    const t = getThemeById(id);
    assert.ok(t, `${id} 应可被 getThemeById 找到`);
    assert.ok(!t.user, `${id} 应在内置层（非用户层）`);
  }
});

// ── 2. 跨文件一致性：app.js 预设 ↔ theme.json ─────────────────────────────
test('ui/app.js 三个预设常量与 theme.json 逐色一致（防两处漂移）', () => {
  const appJs = read('ui/app.js');
  for (const [id, preset] of [
    ['sujian-paper', 'THEME_PRESET_SUJIAN'],
    ['deep-space-console', 'THEME_PRESET_DEEPSPACE'],
    ['warm-room', 'THEME_PRESET_WARMROOM']
  ]) {
    const theme = JSON.parse(read(`themes/${id}.json`)).colors;
    const m = appJs.match(new RegExp(`const ${preset} = \\{[\\s\\S]*?\\n\\};`));
    assert.ok(m, `${preset} 常量应存在于 app.js`);
    const block = m[0];
    for (const [k, v] of Object.entries(theme)) {
      const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      assert.ok(block.includes(`${key}: '${v}'`), `${preset}.${key} 应等于 ${v}`);
    }
  }
});

// ── 3. data-ui-style 机制扩展完整度（app.js 五处）────────────────────────
test('app.js：三个 UI_IDS 集合 + data-ui-style 三分支 + 预设 fallback 链齐全', () => {
  const s = read('ui/app.js');
  assert.ok(s.includes("SUJIAN_UI_IDS = new Set(['sujian-paper'"));
  assert.ok(s.includes("DEEPSPACE_UI_IDS = new Set(['deep-space-console'"));
  assert.ok(s.includes("WARMROOM_UI_IDS = new Set(['warm-room'"));
  for (const style of ['sujian', 'deepspace', 'warmroom']) {
    assert.ok(s.includes(`data-ui-style', '${style}'`), `应设置 data-ui-style=${style}`);
  }
  assert.ok(s.includes('THEME_PRESET_SUJIAN, THEME_PRESET_DEEPSPACE, THEME_PRESET_WARMROOM'), '离线 fallback 应含三新预设');
});

// ── 4. CSS 形态段 ────────────────────────────────────────────────────────
test('style.css：三段形态 + 各自签名特征（衬线/等宽扫描线/角括号/药丸渐变）', () => {
  const css = read('ui/style.css');
  for (const style of ['sujian', 'deepspace', 'warmroom']) {
    assert.ok(css.includes(`[data-ui-style='${style}']`), `缺 ${style} 形态段`);
  }
  // 素笺签名：衬线字体
  assert.ok(css.includes("--sj-serif: \"Songti SC\""));
  // 深空签名：等宽 + 扫描线 + 角括号
  assert.ok(css.includes('--ds-mono: "SF Mono"'));
  assert.ok(css.includes('repeating-linear-gradient'));
  assert.ok(css.includes('border-top: 1.5px solid var(--accent)'));
  // 暖房签名：药丸圆角 + 渐变主按钮
  assert.ok(css.includes('border-radius: 999px'));
  assert.ok(css.includes('linear-gradient(145deg, #e98b6d, #d56b4e)'));
});

// ── 5. 双端同一份 UI（Electron 与 Web UI 都加载 ui/）──────────────────────
test('ui/index.html 引用 style.css 与 app.js（Electron/Web 同源生效）', () => {
  const html = read('ui/index.html');
  assert.ok(/style\.css/.test(html), 'index.html 应引用 style.css');
  assert.ok(/app\.js/.test(html), 'index.html 应引用 app.js');
  const main = read('electron/main.js');
  assert.ok(main.includes('ui') || main.includes('index.html'), 'Electron 应加载 ui/ 目录');
});

// ── 6. 原型视觉一致性自查（token 级）────────────────────────────────────
test('视觉一致性：三份原型 :root 的 8 色 token 与 theme.json 逐一相等（独立复核设计匠人声明）', () => {
  for (const [dir, id] of [
    ['A-sujian', 'sujian-paper'],
    ['B-deep-space', 'deep-space-console'],
    ['C-warm-room', 'warm-room']
  ]) {
    const proto = read(`ui/designs/${dir}/prototype.html`);
    const theme = JSON.parse(read(`themes/${id}.json`)).colors;
    for (const [k, v] of Object.entries(theme)) {
      const cssVar = k.replace(/_/g, '-').replace(/([a-z])(\d)/g, '$1-$2');   // bg2 → bg-2
      const re = new RegExp(`--${cssVar}:\\s*${v.replace('#', '#?')}`, 'i');
      assert.ok(re.test(proto), `${dir} 原型 :root 缺 --${cssVar}: ${v}`);
    }
  }
});

// ── 7. 主题 apply 落全局配置（阶段二遗留 bug 的回归：误写模块私有段）────────
test('apply 主题写入全局 ui 段（非 config.modules.themes 私有段）', async () => {
  // 模拟路由行为：themes/index.js 的 apply 现在直接用全局 updateConfig
  const { updateConfig, getConfig } = await import('../src/config.js');
  const { globalThis: gt } = globalThis;
  updateConfig({ ui: { theme: 'custom', customThemeId: 'warm-room', customBg: '#f6eadb', customAccent: '#e07a5f' } });
  const ui = getConfig().ui || {};
  assert.equal(ui.customThemeId, 'warm-room', '应写入全局 ui.customThemeId');
  assert.equal(ui.customBg, '#f6eadb');
  // 模块私有段不应被污染（阶段二 bug 的形态：themes 模块私有段里长出 ui）
  assert.equal(getConfig().modules?.themes?.ui, undefined, 'modules.themes 不应包含 ui（私有段污染回归）');
  // 源码静态断言：themes 路由必须用全局 config（防再犯）
  const themesIndex = read('modules/themes/index.js');
  assert.ok(themesIndex.includes("globalUpdateConfig"), 'themes/index.js 应使用 globalUpdateConfig');
  assert.ok(!themesIndex.includes('api.config.update('), 'themes 路由不应再用模块私有 api.config.update');
});
