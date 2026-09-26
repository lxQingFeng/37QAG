// 控制台自定义主题：内置预设 + themes/ 目录导入
// 规范见 themes/THEME_FORMAT.txt
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../src/config.js';
import { userThemesDir } from '../../src/paths.js';

export const THEMES_DIR = path.join(ROOT, 'themes');        // 内置主题（随程序走，只读资产）
export const USER_THEMES_DIR = userThemesDir();   // 用户导入主题（data/ 单根，随备份走）

/** 内置预设（机甲风等），始终可用，不依赖磁盘。 */
export const BUILTIN_THEMES = [
  {
    id: 'mech-orange',
    name: '机甲 · 黑橙',
    builtin: true,
    description: '近黑机甲底 + 琥珀橙强调（参考 Armoury Crate）',
    colors: {
      bg: '#0c0c0e',
      bg2: '#151517',
      bg3: '#222224',
      accent: '#f5a623',
      toolAccent: '#ff7a00',
      text: '#f4f4f5',
      muted: '#a8a8ad',
      faint: '#6e6e73'
    }
  },
  {
    id: 'deepseek-maid',
    name: 'DeepSeek 娘',
    builtin: true,
    description: '深蓝 + 鎏金 + 宫廷壁纸',
    colors: {
      bg: '#101c2e',
      bg2: '#16243a',
      bg3: '#1e3048',
      accent: '#4d8fc9',
      toolAccent: '#d4b56a',
      text: '#e8eef6',
      muted: '#9aafc4',
      faint: '#6d8199'
    }
  },
  {
    id: 'bijingyu-pixel',
    name: '白京玉 · 像素夜',
    builtin: true,
    description: '精致像素雨夜咖啡馆：暖夜蓝 + 灯火琥珀 + 奶油字（壁纸 bijingyu-bg.png）',
    colors: {
      bg: '#1a2438',
      bg2: '#24344f',
      bg3: '#2e4260',
      accent: '#e0a85c',
      toolAccent: '#9bb8d4',
      text: '#f0ebe2',
      muted: '#a8b4c4',
      faint: '#6e7c90'
    }
  },
  {
    id: 'classic-purple',
    name: '经典 · 紫',
    builtin: true,
    description: '原自定义起点：暗紫底 + 紫强调',
    colors: {
      bg: '#12101a',
      bg2: '#1c1930',
      bg3: '#262244',
      accent: '#8b5cf6',
      toolAccent: '#f59e0b',
      text: '#f3f0ff'
    }
  }
];

const HEX_RE = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const COLOR_KEYS = ['bg', 'bg2', 'bg3', 'accent', 'toolAccent', 'text', 'muted', 'faint'];

function normKey(k) {
  return String(k || '').trim().toLowerCase().replace(/[_\s]+/g, '-');
}
function toCamel(key) {
  const k = normKey(key);
  if (k === 'tool-accent' || k === 'toolaccent') return 'toolAccent';
  return k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}
function pickColor(val) {
  const s = String(val || '').trim();
  return HEX_RE.test(s) ? s : '';
}

/** 解析 JSON 或 key=value / key: value 文本 → 统一主题对象。 */
export function parseThemeText(raw, fallbackName = '') {
  const text = String(raw || '').replace(/^﻿/, '');
  if (!text.trim()) throw new Error('主题文件是空的');
  let colors = {};
  let id = '';
  let name = fallbackName || '';
  const extra = {};

  const t = text.trim();
  if (t.startsWith('{')) {
    let obj;
    try { obj = JSON.parse(t); } catch (e) { throw new Error('JSON 解析失败：' + (e?.message || e)); }
    const src = (obj.colors && typeof obj.colors === 'object') ? obj.colors : obj;
    for (const k of Object.keys(src)) {
      const ck = toCamel(k);
      if (!COLOR_KEYS.includes(ck)) continue;
      const c = pickColor(src[k]);
      if (c) colors[ck] = c;
    }
    id = String(obj.id || '').trim();
    name = String(obj.name || '').trim() || name;
    // 保留 UI 形态 / 壁纸线索（前端按 id 匹配也能工作，这两项便于预览）
    if (obj.uiStyle) extra.uiStyle = String(obj.uiStyle).trim();
    if (obj.image) extra.image = String(obj.image).trim();
    if (obj.description) extra.description = String(obj.description).trim();
  } else {
    for (const line of text.split(/\r?\n/)) {
      const s = line.trim();
      if (!s || s.startsWith('#') || s.startsWith('//')) continue;
      const m = /^([a-zA-Z0-9_\- ]+)\s*[=:：]\s*(.+)$/.exec(s);
      if (!m) continue;
      const key = normKey(m[1]);
      const val = String(m[2] || '').trim().replace(/^["']|["']$/g, '');
      if (key === 'id') id = val;
      else if (key === 'name' || key === 'title') name = val;
      else {
        const ck = toCamel(key);
        if (!COLOR_KEYS.includes(ck)) continue;
        const c = pickColor(val);
        if (c) colors[ck] = c;
      }
    }
  }

  if (!colors.bg || !colors.bg2 || !colors.accent || !colors.text) {
    throw new Error('缺少必填颜色：至少要有 bg / bg2 / accent / text（#RRGGBB）');
  }
  const themeId = (id || fallbackName || 'imported-theme').replace(/[^\w\-]+/g, '-').slice(0, 48) || 'imported-theme';
  return {
    id: themeId,
    name: name || themeId,
    colors,
    builtin: false,
    ...extra
  };
}

function safeThemeName(name) {
  return String(name || 'theme').replace(/[^\w\-.]+/g, '-').replace(/^[-.]+/, '').slice(0, 48) || 'theme';
}

export function listThemes() {
  const byId = new Map();
  for (const t of BUILTIN_THEMES) byId.set(t.id, { ...t });
  // 双层目录（阶段二）：先读用户层 data/themes/（导入的主题，随备份走），
  // 再读内置层 themes/（随程序走的只读资产）。同 id 时用户层覆盖内置层。
  for (const dir of [THEMES_DIR, USER_THEMES_DIR]) {
    try {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!/\.(json|txt)$/i.test(f)) continue;
        if (/THEME_FORMAT/i.test(f)) continue;
        try {
          const raw = fs.readFileSync(path.join(dir, f), 'utf8');
          const th = parseThemeText(raw, path.parse(f).name);
          byId.set(th.id, { ...th, file: f, builtin: dir === THEMES_DIR ? !!byId.get(th.id)?.builtin : false, user: dir === USER_THEMES_DIR });
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录不可读时跳过这一层 */ }
  }
  return [...byId.values()];
}

/** 导入主题文本，写入 data/themes/（用户层），返回主题对象。 */
export function importTheme(raw, { filename = '' } = {}) {
  const base = filename ? path.parse(filename).name : '';
  const th = parseThemeText(raw, base);
  const file = safeThemeName(th.id || base) + '.json';
  const abs = path.join(USER_THEMES_DIR, file);
  fs.mkdirSync(USER_THEMES_DIR, { recursive: true });
  const payload = {
    format: 'qq-agent-theme',
    version: 1,
    id: th.id,
    name: th.name,
    colors: th.colors
  };
  fs.writeFileSync(abs, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return { ...th, file };
}

export function getThemeById(id) {
  const sid = String(id || '').trim();
  return listThemes().find((t) => t.id === sid) || null;
}

/**
 * 磁盘内置主题 id 清单：这些文件随程序分发（内存 BUILTIN_THEMES 之外的磁盘内置层），
 * migrateUserThemesOut 绝不能把它们当用户文件搬走（阶段四踩过：新加的三个风格主题
 * 被当成"用户放错位置的主题"搬进 data/themes/，测试环境里表现为内置文件凭空消失）。
 */
export const FILE_BUILTIN_IDS = Object.freeze([
  'mech-orange', 'deepseek-maid', 'bijingyu-pixel',
  'sujian-paper', 'deep-space-console', 'warm-room'
]);

/**
 * 阶段二迁移：把历史上直接放进内置 themes/ 的**用户主题**搬到 data/themes/。
 * 判定标准：主题 id 不在内存 BUILTIN_THEMES 且不在 FILE_BUILTIN_IDS（磁盘内置清单）里。
 * 幂等：搬过（内置目录里已没有）就不会再动。返回迁移明细。
 */
export function migrateUserThemesOut() {
  const moves = [];
  const builtinIds = new Set([...BUILTIN_THEMES.map((t) => String(t.id)), ...FILE_BUILTIN_IDS]);
  try {
    if (!fs.existsSync(THEMES_DIR)) return moves;
    for (const f of fs.readdirSync(THEMES_DIR)) {
      if (!/\.json$/i.test(f) || /THEME_FORMAT/i.test(f)) continue;
      const th = (() => { try { return parseThemeText(fs.readFileSync(path.join(THEMES_DIR, f), 'utf8'), path.parse(f).name); } catch { return null; } })();
      if (!th) continue;
      if (builtinIds.has(String(th.id))) continue;    // 内置预设本体，留原地
      const dest = path.join(USER_THEMES_DIR, f);
      try {
        fs.mkdirSync(USER_THEMES_DIR, { recursive: true });
        if (!fs.existsSync(dest)) fs.renameSync(path.join(THEMES_DIR, f), dest);
        moves.push(`${f} → data/themes/`);
      } catch { /* 搬不动就留着，双层读取仍能读到 */ }
    }
  } catch { /* ignore */ }
  return moves;
}
