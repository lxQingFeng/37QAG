// 控制台自定义主题：内置预设 + themes/ 目录导入
// 规范见 themes/THEME_FORMAT.txt
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';

export const THEMES_DIR = path.join(ROOT, 'themes');

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
  try {
    if (!fs.existsSync(THEMES_DIR)) fs.mkdirSync(THEMES_DIR, { recursive: true });
    for (const f of fs.readdirSync(THEMES_DIR)) {
      if (!/\.(json|txt)$/i.test(f)) continue;
      if (/THEME_FORMAT/i.test(f)) continue;
      try {
        const raw = fs.readFileSync(path.join(THEMES_DIR, f), 'utf8');
        const th = parseThemeText(raw, path.parse(f).name);
        byId.set(th.id, { ...th, file: f, builtin: !!byId.get(th.id)?.builtin });
      } catch { /* 跳过坏文件 */ }
    }
  } catch { /* 目录不可读时只返回内置 */ }
  return [...byId.values()];
}

/** 导入主题文本，写入 themes/，返回主题对象。 */
export function importTheme(raw, { filename = '' } = {}) {
  const base = filename ? path.parse(filename).name : '';
  const th = parseThemeText(raw, base);
  const file = safeThemeName(th.id || base) + '.json';
  const abs = path.join(THEMES_DIR, file);
  fs.mkdirSync(THEMES_DIR, { recursive: true });
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
