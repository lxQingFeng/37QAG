// 阶段四回归：三套 UI 风格集成（素笺/深空控制台/暖房）。
// 覆盖：theme.json 内置收录、跨文件一致性（app.js 预设 ↔ theme.json ↔ 原型 :root）、
// data-ui-style 机制扩展完整度、CSS 形态段落、双端同一份 UI 资源。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

// ── 2. 主题色值单源（P1-c，2026-09-27）───────────────────────────────────
test('app.js 不再硬编码主题色值副本：色值唯一来源 = /api/themes（运行时等价由冒烟 --bg 断言守护）', () => {
  const appJs = read('ui/app.js');
  // 6 份 THEME_PRESET_* 副本应全部删除
  assert.ok(!/const THEME_PRESET_[A-Z]+ = \{/.test(appJs), '不应再有 THEME_PRESET_* 色值硬编码（单源化后）');
  // 单源设施齐全
  assert.ok(appJs.includes('async function ensureServerThemeColors()'), '应有启动拉取函数 ensureServerThemeColors');
  assert.ok(appJs.includes('function themeColorsOf('), '应有同步查色函数 themeColorsOf');
  // 六个形态分支都改为查缓存（锁色来源 = 服务端清单）
  for (const id of ['mech-orange', 'deepseek-maid', 'bijingyu-pixel', 'sujian-paper', 'deep-space-console', 'warm-room']) {
    assert.ok(appJs.includes(`themeColorsOf('${id}')`), `锁色应查服务端缓存 ${id}`);
  }
  // boot 应在首次 applyTheme 前拉取主题清单
  assert.ok(/Promise\.all\(\[api\('\/api\/config'\), ensureServerThemeColors\(\)\]\)/.test(appJs), 'boot 应并行拉取配置与主题清单');
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
  assert.ok(s.includes('themeColorsOf(id) ? { id, colors: themeColorsOf(id) } : null'), '离线 fallback 应查启动缓存（单源）');
});

// ── 4. CSS 形态段 ────────────────────────────────────────────────────────
// 2026-09-27 P1-a 拆分：形态段整体移入 ui/ui-forms.css（纯移动，规则零改动），
// 「？」彩蛋移入 ui/chaos.css；本测试随文件搬移改读取路径，校验意图不变。
test('ui-forms.css：三段形态 + 各自签名特征（衬线/等宽扫描线/角括号/药丸渐变）', () => {
  const css = read('ui/ui-forms.css');
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
  // P1-a 拆分后的两个新表单：顺序必须保持 style → chaos → forms（级联顺序已论证零冲突）
  assert.ok(/chaos\.css/.test(html), 'index.html 应引用 chaos.css');
  assert.ok(/ui-forms\.css/.test(html), 'index.html 应引用 ui-forms.css');
  const linkOrder = ['style.css', 'chaos.css', 'ui-forms.css']
    .map((f) => html.indexOf(f)).reduce((a, b) => a >= 0 && b > a ? b : -1, 0);
  assert.ok(linkOrder > 0, '三个样式表的引用顺序应为 style → chaos → ui-forms');
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
