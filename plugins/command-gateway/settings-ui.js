// 指令前置 · 控制台设置页（插件自带的分区）
//
// 这个文件**不是核心代码**：控制台按 plugin.json 里的 settingsUi 声明，
// 用 /plugin-assets/command-gateway/settings-ui.js 动态加载它，挂在设置页的一个分区里。
// 契约（见本目录 README.md）：
//   render(ctx) -> string        返回这块分区的 HTML
//   bind(root, ctx) -> cleanup?  绑定事件；可返回卸载函数
//   read(ctx) -> object|null     把界面上的输入读成"要保存的补丁"（核心的自动保存会调它）
//
// 为什么界面在插件里而不是核心的 ui/app.js 里：界面属于插件。
// 核心只需要知道"插件可以有自己的设置页"这一件事，之后再加指令插件就不用碰核心。

// 自己的插件 id 不写死：设置页的 ctx 里带着（核心按当前清单 id 传进来）
let PLUGIN_ID = 'command-gateway-1.5.0';
const STYLE_ID = 'command-gateway-settings-style';

/** 人的权限下限是 -1（-1 = 一律禁止使用指令）；指令等级一律 ≥ 0。 */
const PERM_MIN_LEVEL = -1;
const MAX_LEVEL = 100000;
/** 指令静默的默认值与上限（和 index.js 里的常量保持一致）。 */
const SILENCE_DEFAULT_SECONDS = 10;
const SILENCE_DEFAULT_HITS = 3;
const SILENCE_MAX_SECONDS = 2592000;   // 一个月
const SILENCE_MAX_HITS = 1000;
const ROUTE_DEFAULT_LEVEL = 1;   // 新接入项的默认权限等级
const NEW_ROW_LEVEL = 1;         // 手动加一行 / 选好友加进来的默认等级
const PERM_HEAD_H = 30;          // 权限表表头高度
const PERM_ROW_H = 40;           // 每行占位（行高 + 行距）
const PERM_PAD = 12;             // 权限表上下内边距
const PERM_MAX_H = 900;
const PERM_HEIGHT_KEY = 'cg-perm-height';

/* 元指令：前置自带、不占接入列表。指令词与默认等级必须和插件里的 META_DEFS 一致
   （index.js）—— 改这里就要一起改那里，反之亦然。 */
const META_DEFS = [
  { id: 'help', name: '帮助', words: '帮助、help、指令', fallback: 0 },
  { id: 'permission', name: '权限查询', words: '权限查询、查询权限、perm', fallback: 1 }
];
/** 元指令与前置自带指令的指令词都是保留词：别的插件撞上来会让"谁先命中"变得不可预测。 */
const RESERVED_WORDS = new Set([
  '帮助', 'help', '指令', '权限查询', '查询权限', 'perm',
  '禁言', '解禁', '全体禁言', '全体解禁', '暂停', '继续', '抛骰子', '猜拳'
]);

/* 样式跟着界面走：核心的 style.css 里不再有 .cg-* 规则。
   只用到核心已有的 CSS 变量（--border/--muted/--accent…），两套主题自动跟着变。 */
const CSS = `
.cg-section-head {
  display: flex; align-items: center; gap: 12px;
  margin-top: 22px; margin-bottom: 10px;
}
.cg-section-head h3 { margin: 0; }
.cg-section-head .btn { margin-left: auto; }
.cg-ok { color: var(--green); min-height: 16px; }
.cg-warn { color: #e6a23c; min-height: 16px; }
.cg-err { color: #e06666; }
.cg-row {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 14px;
  margin-bottom: 12px;
}
.cg-row-head {
  display: flex; align-items: center; gap: 10px;
  margin-bottom: 8px; flex-wrap: wrap;
}
.cg-row-actions { margin-left: auto; display: flex; gap: 6px; }
.cg-calls { display: flex; flex-direction: column; gap: 4px; }
.cg-call {
  display: flex; gap: 10px; align-items: baseline; flex-wrap: wrap;
  padding: 4px 6px; border-radius: 6px; font-size: 12px;
}
.cg-call.is-error { background: rgba(224, 102, 102, .08); }
.cg-call-cmd { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }

/* 权限表：第一列是行名（默认权限 = 固定文本，其它行 = 可编辑的 QQ 号），
   表头 sticky：表格滚动时列名不跟着跑。 */
.cg-perm-wrap {
  min-height: 70px;
  overflow-y: auto; overflow-x: hidden;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--inset-bg);
  box-shadow: var(--inset-edge);
}
.cg-perm-head, .cg-perm-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 96px 132px 76px;
  gap: 10px; align-items: center;
  padding: 0 10px;
}
.cg-perm-head {
  position: sticky; top: 0; z-index: 2;
  height: 30px;
  font-size: 12px; color: var(--muted);
  background: var(--layer-2, var(--inset-bg));
  border-bottom: 1px solid var(--edge);
}
.cg-perm-rows { display: flex; flex-direction: column; gap: 6px; padding: 6px 0; }
.cg-perm-row { height: 34px; }
.cg-perm-row input { width: 100%; }
.cg-perm-name { color: var(--muted); font-size: 13px; }
.cg-perm-hold { color: var(--faint); text-align: center; }

/* 拖拽把手：视觉上是一条短横线，hover 时亮起来告诉用户"这里能拖" */
.cg-perm-grip {
  height: 12px; display: flex; align-items: center; justify-content: center;
  cursor: ns-resize; user-select: none;
}
.cg-perm-grip span {
  width: 46px; height: 4px; border-radius: 2px;
  background: var(--border); transition: background .15s;
}
.cg-perm-grip:hover span { background: var(--accent); }
body.cg-resizing { cursor: ns-resize; user-select: none; }
.cg-perm-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }

/* 指令列表：每行默认折叠（只占一行），展开后才露出指令词/别名/超时。
   权限等级与启用勾选框放在标题栏里 —— 它们是最常改的两个东西。 */
.cg-row.cg-compact { padding: 9px 12px; margin-bottom: 8px; }
.cg-row.cg-compact .cg-row-head { margin-bottom: 0; }
.cg-row.cg-compact.is-open { padding-bottom: 12px; }
.cg-toggle {
  width: 18px; height: 18px; padding: 0;
  display: inline-flex; align-items: center; justify-content: center;
  background: none; border: none; cursor: pointer;
  color: var(--muted); font-size: 11px; line-height: 1;
}
.cg-toggle:hover { color: var(--accent); }
.cg-toggle-ghost { cursor: default; visibility: hidden; }
.cg-inline {
  display: inline-flex; align-items: center; gap: 5px;
  font-size: 12.5px; color: var(--muted); white-space: nowrap;
}
.cg-inline input[type="number"] { width: 82px; padding: 3px 6px; }
.cg-inline input[type="checkbox"] { margin: 0; }
.cg-row-body { margin-top: 8px; padding-top: 8px; border-top: 1px dashed var(--edge); }
.cg-row-body[hidden] { display: none; }
.cg-fields { display: flex; gap: 10px; flex-wrap: wrap; }
.cg-fields > label {
  flex: 1 1 150px; display: flex; flex-direction: column; gap: 4px;
  font-size: 12.5px; color: var(--muted);
}
.cg-fields input { width: 100%; }
.cg-meta-row { background: color-mix(in srgb, var(--inset-bg) 60%, transparent); }

/* 批量修改弹窗 */
.cg-batch-head { display: flex; align-items: center; gap: 8px; }
.cg-batch-list {
  max-height: 320px; overflow-y: auto;
  border: 1px solid var(--edge); border-radius: 10px;
  padding: 4px;
}
.cg-batch-ops { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.cg-batch-ops label { color: var(--muted); font-size: 13px; }
.cg-batch-ops input { width: 110px; }
.pick-item.is-dim { opacity: .5; }

/* 目录 + 两栏：页面越来越长，左窄栏目录点一下平滑滚到对应段落。 */
.cg-layout { display: flex; gap: 18px; align-items: flex-start; }
.cg-toc {
  flex: 0 0 172px; position: sticky; top: 0; align-self: flex-start;
  display: flex; flex-direction: column; gap: 2px;
  padding: 10px 8px; border: 1px solid var(--border); border-radius: 10px;
  background: color-mix(in srgb, var(--bg-2) 60%, transparent);
}
.cg-toc-title { font-size: 11.5px; color: var(--muted); margin: 0 6px 6px; letter-spacing: .04em; }
.cg-toc-item {
  text-align: left; border: 0; background: none; color: var(--text);
  font: inherit; font-size: 12.5px; padding: 5px 8px; border-radius: 7px; cursor: pointer;
}
.cg-toc-item:hover { background: color-mix(in srgb, var(--accent) 12%, transparent); }
.cg-toc-item.is-active { background: color-mix(in srgb, var(--accent) 20%, transparent); color: var(--accent); font-weight: 600; }
.cg-main { flex: 1; min-width: 0; }
.cg-about {
  margin-top: 22px; padding: 12px 14px; border: 1px dashed var(--border); border-radius: 10px;
  color: var(--muted); font-size: 12.5px; line-height: 1.7;
}
@media (max-width: 900px) {
  .cg-layout { flex-direction: column; }
  .cg-toc { position: static; flex-direction: row; flex-wrap: wrap; }
}
`;

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

/** 上一次为哪一次"进入分区"刷过数据（ctx.entrySeq 每次点侧栏 +1）。 */
let lastEntrySeq = -1;
/** 哪些指令行是展开的（默认全部折叠）。键是 `插件id:指令id`，只活在本次页面里。 */
const expandedKeys = new Set();

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function clampLevel(raw, fallback = 0) {
  if (raw === '' || raw === null || raw === undefined) return fallback;
  const n = Math.round(Number(raw));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(MAX_LEVEL, Math.max(PERM_MIN_LEVEL, n));
}

/** 展示用的权限表：保证「默认权限」行存在（插件那边也会兜这一层）。 */
function permRows(gw) {
  const list = Array.isArray(gw.permissions) ? gw.permissions : [];
  const rows = list.map((r) => ({
    qq: String(r?.qq ?? ''),
    level: clampLevel(r?.level, 0),
    unlimited: r?.unlimited === true          // 不受触发次数限制（指令静默的白名单）
  }));
  if (!rows.some((r) => r.qq === 'default')) rows.unshift({ qq: 'default', level: 0 });
  return rows;
}

/** 元指令权限表：缺行/脏值一律回落到 META_DEFS 的默认等级。 */
function metaRows(gw) {
  const list = Array.isArray(gw.metaCommands) ? gw.metaCommands : [];
  return META_DEFS.map((d) => {
    const row = list.find((r) => String(r?.id ?? '') === d.id);
    return {
      id: d.id,
      permission: clampLevel(row?.permission, d.fallback),
      enabled: row ? row.enabled !== false : true,
      noCount: row?.noCount === true          // 不计入触发次数
    };
  });
}

/**
 * 有效指令表 = 插件清单声明 + 覆盖表。
 *
 * ⚠️ 这里和插件运行时（index.js 的 effectiveRoutes）是同一套合并规则，改一处要改两处。
 * 设置页自己算一份，是为了不必为了渲染一张表再向核心要一个接口。
 */
function effectiveRows(gw, skills) {
  const overrides = Array.isArray(gw.overrides) ? gw.overrides : [];
  const stats = (gw.stats && typeof gw.stats === 'object') ? gw.stats : {};
  const out = [];
  for (const s of skills || []) {
    if (s?.loaded === false || !Array.isArray(s?.commands) || !s.commands.length) continue;
    for (const decl of s.commands) {
      const ov = overrides.find((o) => String(o?.pluginId) === String(s.id) && String(o?.id) === String(decl.id)) || null;
      const declared = {
        word: decl.word || '',
        aliases: Array.isArray(decl.aliases) ? decl.aliases : [],
        permission: decl.permission == null ? ROUTE_DEFAULT_LEVEL : decl.permission,
        timeoutMs: decl.timeoutMs || 0
      };
      out.push({
        id: decl.id,
        pluginId: s.id,
        capability: decl.capability,
        word: ov?.word || declared.word,
        aliases: ov?.aliases === undefined ? declared.aliases : ov.aliases,
        permission: ov?.permission === undefined ? declared.permission : ov.permission,
        timeoutMs: ov?.timeoutMs === undefined ? declared.timeoutMs : ov.timeoutMs,
        enabled: ov ? ov.enabled !== false : true,
        noCount: ov?.noCount === undefined ? decl.noCount === true : ov.noCount === true,
        customized: !!ov,
        calls: Number(stats[`${s.id}:${decl.id}`]?.calls) || 0,
        description: decl.description,
        argsHint: decl.argsHint,
        examples: decl.examples,
        declared
      });
    }
  }
  return out;
}

/** 原样读界面上的表（含还没填 QQ 的空行），保证下标和用户看到的一致。 */
function readPermDom() {
  return $$('#cg-perm-rows .cg-perm-row').map((row) => {
    const isDefault = row.dataset.default === '1';
    return {
      qq: isDefault ? 'default' : String($('.cg-perm-qq', row)?.value || '').trim(),
      level: clampLevel($('.cg-perm-level', row)?.value, 0),
      unlimited: $('.cg-perm-unlimited', row)?.checked === true
    };
  });
}

/** 过滤出可写入配置的权限表；problems 非空时调用方**不要写**，保留上一次的有效表。 */
function validatePermRows(rows) {
  const out = [];
  const problems = [];
  const seen = new Set();
  for (const r of rows) {
    if (!r.qq) continue;                       // 还没填 QQ 的临时行
    if (r.qq !== 'default' && !/^\d{1,15}$/.test(r.qq)) { problems.push(`「${r.qq}」不是纯数字的 QQ 号`); continue; }
    if (seen.has(r.qq)) { problems.push(`QQ ${r.qq} 重复`); continue; }
    seen.add(r.qq);
    // unlimited = 这个人不参与指令静默（怎么用都不会被静默）
    out.push({ qq: r.qq, level: r.level, ...(r.unlimited === true ? { unlimited: true } : {}) });
  }
  if (!seen.has('default')) out.unshift({ qq: 'default', level: 0 });
  return { rows: out, problems };
}

/** 默认高度正好显示 5 行。 */
function permDefaultHeight() {
  return PERM_HEAD_H + PERM_ROW_H * 5 + PERM_PAD;
}

/** 高度是浏览器本地偏好，不进配置：换台机器回默认值就行。 */
function permStoredHeight() {
  try {
    const n = Number(localStorage.getItem(PERM_HEIGHT_KEY));
    const min = PERM_HEAD_H + PERM_ROW_H + PERM_PAD;
    if (Number.isFinite(n) && n >= min) return Math.min(PERM_MAX_H, Math.round(n));
  } catch { /* 隐私模式/测试沙箱里没有 localStorage */ }
  return permDefaultHeight();
}

/** 刷新按钮旁边的一行反馈；2.5 秒后自己消失（只改文本，不重绘，免得打断输入）。 */
function flash(text, isError = false) {
  const el = $('#cg-flash');
  if (!el) return;
  el.textContent = text;
  el.className = isError ? 'hint cg-warn' : 'hint cg-ok';
  setTimeout(() => {
    const now = $('#cg-flash');
    if (now) now.textContent = '';
  }, 2500);
}

/**
 * 顶部那行"核心补丁状态"。
 *
 * 为什么必须有它：补丁改的是**已经加载进内存**的核心文件，打完要重启才生效。
 * 界面上不写清楚，用户打完补丁发现指令没反应，只会以为插件坏了。
 */
function describePatch(info) {
  if (!info || !info.state) return '核心补丁：还没有检查过（插件启用后会自动检查一次）。';
  const when = String(info.checkedAt || '').replace('T', ' ').slice(0, 16);
  const version = `v${info.version ?? '?'}`;
  if (info.state === 'conflict' || info.applyFailed) {
    const files = (info.conflicts || []).map((c) => `${c.file}（${c.detail || '有冲突'}）`).join('；') || '见日志';
    return `核心补丁：<span class="cg-warn">有冲突，没有自动改动文件</span> —— ${escText(files)}`;
  }
  if (info.state === 'patched') {
    const restart = info.needsRestart ? ' <span class="cg-warn">需要重启软件才生效</span>' : '';
    const changed = (info.changed || []).length ? `，本次改动了 ${escText(info.changed.join('、'))}` : '';
    return `核心补丁：<span class="cg-ok">已打（${version}）</span>${restart}${changed}${when ? ` · 检查于 ${escText(when)}` : ''}`;
  }
  if (info.state === 'clean') {
    return `核心补丁：<span class="cg-ok">已摘除（${version}）</span>，核心文件是干净状态${when ? ` · 检查于 ${escText(when)}` : ''}`;
  }
  return `核心补丁：状态 ${escText(info.state)}${when ? ` · 检查于 ${escText(when)}` : ''}`;
}

/** describePatch 在 render 之前跑，拿不到 ctx.esc —— 这里做一次最小的转义。 */
function escText(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── 渲染 ─────────────────────────────────────────────────────────────────

export function render(ctx) {
  if (ctx?.pluginId) PLUGIN_ID = String(ctx.pluginId);
  const gw = ctx.pluginConfig() || {};
  const skills = ctx.skills() || [];
  const skill = skills.find((s) => s.id === PLUGIN_ID);
  const installed = !!skill;
  const enabled = installed && skill.enabled !== false && skill.loaded !== false;
  const routes = effectiveRows(gw, skills);
  const recent = Array.isArray(gw.recentCalls) ? gw.recentCalls : [];
  const prefix = String(gw.prefix ?? '/') || '/';
  const patchLine = describePatch(gw.patch);
  // 指令静默：默认值 / 上限与 index.js 里的常量保持一致
  const silenceSeconds = Math.min(SILENCE_MAX_SECONDS,
    Math.max(1, Math.round(Number(gw.silenceSeconds ?? SILENCE_DEFAULT_SECONDS)) || SILENCE_DEFAULT_SECONDS));
  const silenceHits = (() => {
    const n = Math.round(Number(gw.silenceHits ?? SILENCE_DEFAULT_HITS));
    return Number.isFinite(n) ? Math.min(SILENCE_MAX_HITS, Math.max(0, n)) : SILENCE_DEFAULT_HITS;
  })();
  // 当前静默中的成员：插件运行时写回一份快照到配置里，这里按"还没到点"过滤一遍
  const silenceLiveHtml = (() => {
    const now = Date.now();
    const live = (Array.isArray(gw.silenceLive) ? gw.silenceLive : []).filter((x) => Number(x?.until) > now);
    if (!live.length) return '当前静默中：暂无';
    return '当前静默中：' + live
      .map((x) => `${ctx.esc(String(x.qq ?? ''))}（剩 ${Math.max(1, Math.ceil((Number(x.until) - now) / 1000))} 秒）`)
      .join('、');
  })();
  /** 本页目录：只列这一页真正有的段落 */
  const TOC_ITEMS = [
    ['sec-basic', '基础设置'],
    ['sec-perm', '权限'],
    ['sec-silence', '指令静默'],
    ['sec-routes', '指令'],
    ['sec-mod', '内容检查'],
    ['sec-about', '关于'],
    ['sec-recent', '最近调用']
  ];

  const nameOf = (id) => skills.find((s) => s.id === id)?.name || id;
  const statusOf = (id) => {
    const s = skills.find((x) => x.id === id);
    if (!s) return '插件未安装';
    if (s.loaded === false) return '插件加载失败';
    if (s.enabled === false) return '插件未启用';
    return '';
  };

  // 权限表：默认权限行固定在第一行、行名不可改、不给删除按钮
  const permHtml = permRows(gw).map((r) => {
    const isDefault = r.qq === 'default';
    return `
      <div class="cg-perm-row" data-default="${isDefault ? '1' : '0'}">
        ${isDefault
          ? '<span class="cg-perm-name" title="不在表里的 QQ 都用这一行的等级">默认权限</span>'
          : `<input class="cg-perm-qq" value="${ctx.esc(r.qq)}" placeholder="QQ 号" inputmode="numeric" />`}
        <input type="number" class="cg-perm-level" value="${r.level}" min="-1" max="100000" step="1" title="-1 = 不能用任何指令" />
        <label class="cg-inline" title="勾上后这个人不参与指令静默：怎么用都不会被静默">
          <input type="checkbox" class="cg-perm-unlimited" ${r.unlimited ? 'checked' : ''} /> 不受次数限制</label>
        ${isDefault
          ? '<span class="cg-perm-hold" aria-hidden="true">—</span>'
          : '<button class="btn btn-small btn-danger" type="button" data-perm-act="del">删除</button>'}
      </div>`;
  }).join('');

  // 指令行：标题栏放"权限等级 + 启用 + 恢复声明值"，展开后才露出指令词/别名/超时。
  // 默认全部折叠 —— 一个插件声明 8 条指令时，一屏就能看完。
  // 元指令：和普通指令同处一张表，但只有"权限 + 启用"两个可改项（指令词是内置的保留词）
  const metaRowHtml = metaRows(gw).map((m) => {
    const d = META_DEFS.find((x) => x.id === m.id);
    const words = String(d.words || '').split('、').filter(Boolean).map((w) => prefix + w).join(' / ');
    return `
      <div class="cg-row cg-compact cg-meta-row" data-kind="meta" data-id="${ctx.esc(m.id)}" data-plugin-id="${PLUGIN_ID}">
        <div class="cg-row-head">
          <span class="cg-toggle cg-toggle-ghost" aria-hidden="true"></span>
          <span class="tool-name-flow">${ctx.esc(d.name)}</span>
          <span class="muted">${ctx.esc(words)} · 元指令（前置自带，指令词固定）</span>
          <span class="cg-row-actions">
            <label class="cg-inline" title="权限不够的人发出来会被当普通消息放行">权限
              <input type="number" class="cg-meta-level" data-meta-id="${ctx.esc(m.id)}" value="${m.permission}" min="0" max="100000" step="1" /></label>
            <label class="cg-inline" title="关掉后它不再响应，消息按普通消息放行"><input type="checkbox" class="cg-meta-enabled" data-meta-id="${ctx.esc(m.id)}" ${m.enabled !== false ? 'checked' : ''} /> 启用</label>
            <label class="cg-inline" title="用它不增加指令静默的计数（静默期内照样会被拦）"><input type="checkbox" class="cg-meta-nocount" data-meta-id="${ctx.esc(m.id)}" ${m.noCount ? 'checked' : ''} /> 不计入次数</label>
          </span>
        </div>
      </div>`;
  }).join('');

  const routeRows = routes.map((r, i) => `
    <div class="cg-row cg-compact ${expandedKeys.has(`${r.pluginId}:${r.id}`) ? 'is-open' : ''}"
      data-kind="plugin" data-index="${i}" data-id="${ctx.esc(r.id)}" data-plugin-id="${ctx.esc(r.pluginId || '')}"
      data-capability="${ctx.esc(r.capability || '')}" data-calls="${Number(r.calls) || 0}"
      data-declared="${ctx.esc(JSON.stringify(r.declared))}">
      <div class="cg-row-head">
        <button class="cg-toggle" type="button" data-cg-act="toggle" title="展开 / 折叠">${expandedKeys.has(`${r.pluginId}:${r.id}`) ? '▾' : '▸'}</button>
        <span class="tool-name-flow">${ctx.esc(nameOf(r.pluginId))}</span>
        <span class="muted">${ctx.esc(prefix + (r.word || ''))} · ${ctx.esc(String(r.pluginId || ''))} / ${ctx.esc(r.id)} · 已调用 ${Number(r.calls) || 0} 次${statusOf(r.pluginId) ? ` · ${ctx.esc(statusOf(r.pluginId))}` : ''}${r.customized ? ' · <span class="cg-ok">已自定义</span>' : ''}</span>
        <span class="cg-row-actions">
          <label class="cg-inline" title="触发者权限 ≥ 这个值才会执行；0 = 所有人可用">权限
            <input type="number" class="cg-permission" value="${clampLevel(r.permission, ROUTE_DEFAULT_LEVEL)}" min="0" max="100000" step="1" /></label>
          <label class="cg-inline" title="关掉这条指令：消息按普通消息放行"><input type="checkbox" class="cg-enabled" ${r.enabled !== false ? 'checked' : ''} /> 启用</label>
          <button class="btn btn-small" type="button" data-cg-act="reset" title="丢弃本地改动，回到插件清单里声明的值"${r.customized ? '' : ' disabled'}>恢复声明值</button>
        </span>
      </div>
      <div class="cg-row-body"${expandedKeys.has(`${r.pluginId}:${r.id}`) ? '' : ' hidden'}>
        ${(r.description || r.argsHint) ? `<div class="hint">${r.argsHint ? `<code>${ctx.esc(prefix + (r.word || '') + ' ' + r.argsHint)}</code> ` : ''}${ctx.esc(r.description || '')}${Array.isArray(r.examples) && r.examples.length ? ` · 例：${ctx.esc(r.examples[0])}` : ''}</div>` : ''}
        <div class="cg-fields">
          <label>指令词（不含前缀）<input class="cg-word" value="${ctx.esc(r.word || '')}" placeholder="如 天气" /></label>
          <label>别名（逗号分隔）<input class="cg-aliases" value="${ctx.esc((Array.isArray(r.aliases) ? r.aliases : []).join(', '))}" placeholder="如 tq, weather" /></label>
          <label title="0 = 用插件声明的超时；没声明就用上面的默认超时">超时（毫秒）<input type="number" class="cg-timeout" value="${Number(r.timeoutMs) || 0}" /></label>
          <label title="用它不增加指令静默的计数（静默期内照样会被拦）">
            <span class="cg-inline"><input type="checkbox" class="cg-nocount" ${r.noCount ? 'checked' : ''} /> 不计入触发次数</span></label>
        </div>
      </div>
    </div>`).join('');

  const recentRows = recent.map((r) => `
    <div class="cg-call ${r.ok ? '' : 'is-error'}">
      <span class="muted">${ctx.esc(String(r.at || '').replace('T', ' ').slice(0, 19))}</span>
      <span class="cg-call-cmd">${ctx.esc(prefix + String(r.command || ''))}</span>
      <span>${ctx.esc(String(r.sender || ''))}</span>
      <span class="muted">${ctx.esc(String(r.chatKey || ''))}</span>
      <span class="${r.ok ? 'muted' : 'cg-err'}">${r.ok ? `成功 · ${Number(r.ms) || 0}ms` : `失败：${ctx.esc(String(r.error || ''))}`}</span>
    </div>`).join('');

  return `
    <div class="cg-layout">
    <nav class="cg-toc" id="cg-toc">
      <div class="cg-toc-title">本页目录</div>
      ${TOC_ITEMS.map(([id, label]) => `<button type="button" class="cg-toc-item" data-target="${id}">${ctx.esc(label)}</button>`).join('')}
    </nav>
    <div class="cg-main">
    <div class="cg-section-head" id="sec-basic">
      <h3>指令前置</h3>
      <span class="hint cg-ok" id="cg-flash"></span>
      <button class="btn btn-small" type="button" id="cg-refresh-btn"
        title="重新拉取设置与插件状态（调用记录由插件运行时写回，页面开着时会过期）">刷新</button>
    </div>
    <div class="hint" style="margin-bottom:10px">
      消息进入会话之前先看这里：命中指令就直接执行，不存档、不产生会话记录；没命中的消息照常进入聊天流程。
      指令格式：<code>${ctx.esc(prefix)}指令名 [参数]</code>，例如 <code>${ctx.esc(prefix)}天气 珠海</code>。
      <b>首次启用（或换了新版本）后要重启一次软件</b>：前置需要在核心文件里接一个调用点，运行中的进程改不动已经加载的代码。
    </div>
    <div class="hint" id="cg-patch-line">${patchLine}</div>
    <div class="field"><label>插件开关</label>
      <label class="skill-toggle-row">
        <input type="checkbox" id="cg-enabled" ${enabled ? 'checked' : ''} ${installed ? '' : 'disabled'} />
        <span class="st-text">${installed ? (enabled ? '已启用' : '已关闭') : '未安装或加载失败'}</span>
      </label>
      <div class="hint">关闭后所有指令失效，消息照常进入聊天流程。</div>
    </div>

    <div class="cg-section-head" style="margin-top:22px"><h3 id="sec-perm">权限</h3></div>
    <div class="hint" style="margin-bottom:8px">
      不在表里的 QQ 用「默认权限」那一行的等级。<b>-1 = 不能用任何指令</b>；0~100000 数字越大权限越高。
      「不受次数限制」= 这个人不参与<b>指令静默</b>（怎么用都不会被静默）。
    </div>
    <div class="cg-perm-wrap" id="cg-perm-wrap" style="height:${permStoredHeight()}px">
      <div class="cg-perm-head"><span>QQ号</span><span>权限等级</span><span>不受次数限制</span><span></span></div>
      <div class="cg-perm-rows" id="cg-perm-rows">${permHtml}</div>
    </div>
    <div class="cg-perm-grip" id="cg-perm-grip" title="拖动调整高度（双击恢复默认）"><span></span></div>
    <div class="cg-perm-actions">
      <button class="btn btn-small" type="button" id="cg-perm-add">➕ 添加一行</button>
      <button class="btn btn-small" type="button" id="cg-perm-pick">选择好友</button>
      <span class="hint cg-warn" id="cg-perm-hint"></span>
    </div>

    <div class="field"><label>指令前缀</label>
      <input id="cg-prefix" value="${ctx.esc(prefix)}" maxlength="4" />
      <div class="hint">默认 /。改掉后要用新前缀发指令。</div>
    </div>
    <div class="field"><label>冷却（毫秒）</label>
      <input type="number" id="cg-cooldown" value="${Number(gw.cooldownMs ?? 3000) || 0}" />
      <div class="hint">同一会话同一指令的最小间隔，0 = 关闭。默认 3000（3 秒）；冷却中的连点会被静默忽略。</div>
    </div>
    <div class="field"><label>默认超时（毫秒）</label>
      <input type="number" id="cg-timeout" value="${Number(gw.defaultTimeoutMs ?? 30000) || 30000}" />
      <div class="hint">指令插件没声明超时时用它，默认 30000。超过就回执失败，不让长任务被误判。</div>
    </div>
    <label class="checkbox-row"><input type="checkbox" id="cg-private" ${gw.privateEnabled !== false ? 'checked' : ''} />
      私聊也响应指令</label>

    <div class="cg-section-head" style="margin-top:22px"><h3 id="sec-silence">指令静默</h3></div>
    <div class="hint" style="margin-bottom:8px">
      同一个 QQ 在一个静默期内用掉 <b>触发次数</b> 条指令（元指令也算）就静默一个静默期：
      这段时间他用不了任何指令，<b>正常聊天不受影响</b>；静默时间既是统计窗口、也是封锁时长。
      计数只算<b>真正执行了</b>的指令（权限不足、被冷却吞掉的不算）；触发时清空窗口，解封后从 0 开始。
    </div>
    <div class="field"><label>静默时间（秒）</label>
      <input type="number" id="cg-silence-seconds" value="${silenceSeconds}" min="1" max="${SILENCE_MAX_SECONDS}" step="1" />
      <div class="hint">默认 ${SILENCE_DEFAULT_SECONDS}。最大 ${SILENCE_MAX_SECONDS}（一个月）—— 填满就是"一个月内用满 N 条 → 封一个月"。</div>
    </div>
    <div class="field"><label>触发次数</label>
      <input type="number" id="cg-silence-hits" value="${silenceHits}" min="0" max="${SILENCE_MAX_HITS}" step="1" />
      <div class="hint">默认 ${SILENCE_DEFAULT_HITS}。<b>0 = 关闭这个功能</b>。第 N 次照常执行，从那一刻起封一个静默期。</div>
    </div>
    <div class="hint" id="cg-silence-live">${silenceLiveHtml}</div>

    <div class="cg-section-head">
      <h3 id="sec-routes">指令</h3>
      <button class="btn btn-small" type="button" id="cg-batch-btn">批量修改权限</button>
    </div>
    <div class="hint" style="margin-bottom:8px">
      元指令是前置自带的；其余来自各插件清单里的 <code>commands</code> 声明 —— <b>装了就生效</b>，不需要"接入"。
      在这里改动只记差异（覆盖表），插件升级新增指令时你会自动拿到；点左边的 <b>▸</b> 展开改指令词 / 别名 / 超时。
    </div>
    <div id="cg-routes">${metaRowHtml}${routeRows || '<div class="hint">还没有任何插件声明指令。</div>'}</div>
    <div class="hint">用户权限要大于等于该指令权限等级才能使用该指令。</div>
    <div id="cg-dup-hint" class="hint cg-warn"></div>

    <div class="cg-section-head" style="margin-top:22px"><h3 id="sec-mod">内容检查</h3></div>
    <div class="hint" style="margin-bottom:8px">
      给 <code>moderation.check</code> 能力用的规则：别的插件（比如审核类指令）可以直接调它，
      不用自己维护一份词表。每行一条。
    </div>
    <div class="field"><label>关键词（每行一个）</label>
      <textarea id="cg-mod-words" rows="3" style="width:100%">${ctx.esc((gw.moderation?.words || []).join('\n'))}</textarea></div>
    <div class="field"><label>正则（每行一个）</label>
      <textarea id="cg-mod-patterns" rows="3" style="width:100%">${ctx.esc((gw.moderation?.patterns || []).join('\n'))}</textarea>
      <div class="hint">写坏的正则会被跳过，不影响其它规则。</div></div>

    <div class="cg-about" id="sec-about">
      <b>关于</b><br />
      如有 bug 或建议，请来官方群找 <b>Command Gateway contributors</b>（联系信息已脱敏）说明。
    </div>

    <div class="cg-section-head" style="margin-top:22px"><h3 id="sec-recent">最近调用</h3></div>
    <div class="hint" style="margin-bottom:6px">最多保留 20 条，由插件运行时写回配置。</div>
    <div class="cg-calls">${recentRows || '<div class="hint">暂无记录。</div>'}</div>
    </div>
    </div>`;
}

// ── 自动保存：把界面上的输入读成补丁 ─────────────────────────────────────

/**
 * 核心的自动保存（输入停止 600ms）会调它。返回 null = 这次不写
 * （比如分区已经切走、界面不在了）。
 *
 * 每张表各自校验：有问题的表这一轮不写入，保留上一次的有效值，只把原因写进提示行 ——
 * 别让一个手滑把整页设置都卡住。
 */
export function read(ctx) {
  if (ctx?.pluginId) PLUGIN_ID = String(ctx.pluginId);
  if (!$('#cg-perm-rows') && !$('#cg-routes')) return null;
  const gw = ctx.pluginConfig() || {};
  const patch = {};
  const linesOf = (lines) => `插件设置本次未保存：${[...new Set(lines)].join('；')}`;

  patch.cooldownMs = Math.max(0, Number($('#cg-cooldown')?.value ?? gw.cooldownMs ?? 3000) || 0);
  patch.privateEnabled = $('#cg-private') ? $('#cg-private').checked : gw.privateEnabled !== false;
  patch.defaultTimeoutMs = Math.max(1000, Number($('#cg-timeout')?.value ?? gw.defaultTimeoutMs ?? 30000) || 30000);
  // 指令静默：静默时间（1 秒 ~ 一个月）、触发次数（0 = 关闭）
  patch.silenceSeconds = Math.min(SILENCE_MAX_SECONDS,
    Math.max(1, Math.round(Number($('#cg-silence-seconds')?.value ?? gw.silenceSeconds ?? SILENCE_DEFAULT_SECONDS)) || SILENCE_DEFAULT_SECONDS));
  patch.silenceHits = (() => {
    const n = Math.round(Number($('#cg-silence-hits')?.value ?? gw.silenceHits ?? SILENCE_DEFAULT_HITS));
    return Number.isFinite(n) ? Math.min(SILENCE_MAX_HITS, Math.max(0, n)) : SILENCE_DEFAULT_HITS;
  })();

  // 权限表
  const permRead = validatePermRows(readPermDom());
  const permHint = $('#cg-perm-hint');
  if (permRead.problems.length) {
    if (permHint) permHint.textContent = linesOf(permRead.problems);
  } else if ($('#cg-perm-rows')) {
    if (permHint) permHint.textContent = '';
    patch.permissions = permRead.rows;
  }

  // 元指令（和普通指令同处一张表）：权限等级 + 是否启用
  const metas = $$('.cg-meta-level')
    .map((el) => {
      const id = String(el.dataset.metaId || '');
      const fallback = META_DEFS.find((d) => d.id === id)?.fallback ?? 0;
      const enabled = $(`.cg-meta-enabled[data-meta-id="${id}"]`)?.checked !== false;
      const noCount = $(`.cg-meta-nocount[data-meta-id="${id}"]`)?.checked === true;
      return { id, permission: clampLevel(el.value, fallback), enabled, ...(noCount ? { noCount: true } : {}) };
    })
    .filter((r) => r.id);
  if (metas.length) patch.metaCommands = metas;

  // 内容检查规则
  const lines = (sel) => String($(sel)?.value || '').split('\n').map((x) => x.trim()).filter(Boolean);
  if ($('#cg-mod-words') || $('#cg-mod-patterns')) {
    patch.moderation = { words: lines('#cg-mod-words'), patterns: lines('#cg-mod-patterns') };
  }

  // 指令覆盖表：**只写差异** —— 与清单声明一致的行走不产生覆盖记录，
  // 这样插件升级改了默认值，没动过这一行的用户会自动跟着变。
  const rows = $$('#cg-routes .cg-row[data-kind="plugin"]').map((row) => ({
    pluginId: String(row.dataset.pluginId || ''),
    id: String(row.dataset.id || ''),
    capability: String(row.dataset.capability || ''),
    word: String($('.cg-word', row)?.value || '').trim(),
    aliases: String($('.cg-aliases', row)?.value || '')
      .split(/[,，]/).map((x) => x.trim()).filter(Boolean),
    enabled: $('.cg-enabled', row)?.checked !== false,
    permission: clampLevel($('.cg-permission', row)?.value, ROUTE_DEFAULT_LEVEL),
    timeoutMs: Math.max(0, Number($('.cg-timeout', row)?.value) || 0),
    noCount: $('.cg-nocount', row)?.checked === true,
    declared: safeJson(row.dataset.declared)
  })).filter((r) => r.pluginId && r.id);

  const prefixRaw = String($('#cg-prefix')?.value ?? gw.prefix ?? '/').trim();
  const problems = [];
  const seenWords = new Set();
  for (const r of rows) {
    if (!r.word && r.aliases.length) problems.push(`${r.pluginId || '未命名'}：填了别名却没填主指令词`);
    for (const w of [r.word, ...r.aliases].filter(Boolean)) {
      const key = w.toLowerCase();
      if (/\s/.test(w)) problems.push(`「${w}」含空格`);
      // 前置自带指令的那几行不受限：用户随时可以给它们改名
      if (r.pluginId !== PLUGIN_ID && RESERVED_WORDS.has(key)) problems.push(`「${w}」是内置指令词`);
      if (seenWords.has(key)) problems.push(`指令词「${w}」重复`);
      seenWords.add(key);
    }
  }
  if (!prefixRaw || /\s/.test(prefixRaw)) problems.push('前缀不能为空或含空格');
  else patch.prefix = prefixRaw;

  const routeHint = $('#cg-dup-hint');
  if (problems.length) {
    if (routeHint) routeHint.textContent = linesOf(problems);
  } else if ($('#cg-routes')) {
    if (routeHint) routeHint.textContent = '';
    patch.overrides = rows.filter((r) => isCustomized(r)).map((r) => ({
      pluginId: r.pluginId,
      id: r.id,
      word: r.word,
      aliases: r.aliases,
      permission: r.permission,
      timeoutMs: r.timeoutMs,
      // 指令静默白名单：只记差异 —— 勾了才写这个键
      ...(r.noCount === true ? { noCount: true } : {}),
      ...(r.enabled === false ? { enabled: false } : {})
    }));
  }
  return patch;
}

/** 这一行和清单声明比，用户改过什么没有？ */
function isCustomized(row) {
  const d = row.declared || {};
  if (row.enabled === false) return true;
  if ((row.word || '') !== String(d.word || '')) return true;
  if (JSON.stringify(row.aliases || []) !== JSON.stringify(d.aliases || [])) return true;
  if (Number(row.permission) !== Number(d.permission ?? ROUTE_DEFAULT_LEVEL)) return true;
  if (Number(row.timeoutMs || 0) !== Number(d.timeoutMs || 0)) return true;
  if ((row.noCount === true) !== (d.noCount === true)) return true;
  return false;
}

function safeJson(text) {
  try { return JSON.parse(String(text || '{}')) || {}; } catch { return {}; }
}

// ── 交互 ─────────────────────────────────────────────────────────────────

export function bind(root, ctx) {
  injectStyle();

  // 本页目录：点一下平滑滚到对应段落（顺手把"当前点的那一项"标出来）。
  // 目录项是页面里的一排按钮，逐个挂监听；root 卸载时它们跟着一起走。
  for (const btn of root?.querySelectorAll?.('.cg-toc-item') || []) {
    btn.addEventListener('click', () => {
      const target = document.getElementById(String(btn.dataset?.target || ''));
      target?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      for (const b of root.querySelectorAll('.cg-toc-item')) b.classList.remove('is-active');
      btn.classList.add('is-active');
    });
  }

  // 用户每次重新点进这个分区：静默重拉一次（调用记录、累计次数是插件运行时写回配置的）
  if (lastEntrySeq !== ctx.entrySeq) {
    lastEntrySeq = ctx.entrySeq;
    refresh(ctx, { silent: true });
  }

  $('#cg-refresh-btn')?.addEventListener('click', () => refresh(ctx));

  const toggle = $('#cg-enabled');
  toggle?.addEventListener('change', async () => {
    const label = toggle.parentElement?.querySelector('.st-text');
    if (label) label.textContent = toggle.checked ? '已启用' : '已关闭';
    toggle.disabled = true;
    try {
      await ctx.setEnabled(toggle.checked);
    } catch (error) {
      console.error('切换指令前置失败:', error);
      flash('切换失败，详情见控制台', true);
    } finally {
      toggle.disabled = false;
      await ctx.rerender();
    }
  });

  $$('#cg-routes [data-cg-act]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.cg-row');
      if (!row) return;
      const act = btn.dataset.cgAct;

      // 展开/折叠：只动 DOM 与一份内存状态，不重绘 —— 重绘会把没保存的输入吃掉
      if (act === 'toggle') {
        const body = $('.cg-row-body', row);
        if (!body) return;
        const open = body.hidden;
        body.hidden = !open;
        row.classList.toggle('is-open', open);
        btn.textContent = open ? '▾' : '▸';
        const key = `${row.dataset.pluginId}:${row.dataset.id}`;
        if (open) expandedKeys.add(key); else expandedKeys.delete(key);
        return;
      }
      if (act !== 'reset') return;
      // 「恢复声明值」= 丢掉这一条的覆盖记录（不是删掉指令本身）
      saveOverrides(ctx, (list) => {
        const at = list.findIndex((o) => String(o?.pluginId) === String(row.dataset.pluginId)
          && String(o?.id) === String(row.dataset.id));
        if (at >= 0) list.splice(at, 1);
      });
    });
  });

  $('#cg-perm-add')?.addEventListener('click', () => {
    savePerm(ctx, (rows) => rows.push({ qq: '', level: NEW_ROW_LEVEL }));
  });
  $$('#cg-perm-rows [data-perm-act="del"]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const row = btn.closest('.cg-perm-row');
      const idx = $$('#cg-perm-rows .cg-perm-row').indexOf(row);
      if (idx < 0) return;
      savePerm(ctx, (rows) => rows.splice(idx, 1));
    });
  });
  $('#cg-perm-pick')?.addEventListener('click', () => { openFriendPicker(ctx); });
  $('#cg-batch-btn')?.addEventListener('click', () => { openBatchModal(ctx); });
  bindPermResize();

  return () => { /* 目前没有需要清理的全局监听：拖拽的监听只在按下时临时挂 */ };
}

// ── 动作 ─────────────────────────────────────────────────────────────────

/** 重新拉配置与插件状态 → 重绘。手动点刷新时先把界面上没落盘的输入存一次。 */
async function refresh(ctx, { silent = false } = {}) {
  try {
    const draft = read(ctx);
    if (draft) await ctx.save(draft);
  } catch { /* 保存失败也要继续刷新 */ }
  try {
    await ctx.reload();
    if (!silent) flash('已刷新');
  } catch (error) {
    console.error('刷新指令前置失败:', error);
    if (!silent) flash('刷新失败，详情见控制台', true);
  }
}

/** 改覆盖表：改配置 → 立即保存 → 重绘（列表操作没有"输入后再保存"的概念）。 */
async function saveOverrides(ctx, mutator) {
  const gw = ctx.pluginConfig() || {};
  const list = Array.isArray(gw.overrides) ? JSON.parse(JSON.stringify(gw.overrides)) : [];
  mutator(list);
  try {
    await ctx.save({ overrides: list });
  } catch (error) {
    console.error('保存覆盖表失败:', error);
    flash('保存失败，详情见控制台', true);
  }
  await ctx.rerender();
}

/** 给某条指令写一条覆盖记录（没有就新建）。 */
function upsertOverride(list, row, patch) {
  const at = list.findIndex((o) => String(o?.pluginId) === String(row.pluginId) && String(o?.id) === String(row.id));
  const next = {
    pluginId: row.pluginId,
    id: row.id,
    word: row.word,
    aliases: row.aliases,
    permission: row.permission,
    timeoutMs: row.timeoutMs,
    ...(row.enabled === false ? { enabled: false } : {}),
    ...patch
  };
  if (at >= 0) list[at] = next;
  else list.push(next);
}

/** 改权限表：先把界面上的表读回内存（别丢掉刚输入的值）→ 改 → 立即保存 → 重绘。 */
async function savePerm(ctx, mutator) {
  const list = readPermDom();
  if (!list.length) list.push({ qq: 'default', level: 0 });
  if (!list.some((r) => r.qq === 'default')) list.unshift({ qq: 'default', level: 0 });
  mutator(list);
  try {
    await ctx.save({ permissions: list });
  } catch (error) {
    console.error('保存权限表失败:', error);
    flash('保存失败，详情见控制台', true);
  }
  await ctx.rerender();
}

/** 表格高度拖拽（把手在表格下方），双击恢复默认。 */
function bindPermResize() {
  const wrap = $('#cg-perm-wrap');
  const grip = $('#cg-perm-grip');
  if (!wrap || !grip) return;
  const minH = PERM_HEAD_H + PERM_ROW_H + PERM_PAD;
  const remember = (h) => {
    try { localStorage.setItem(PERM_HEIGHT_KEY, String(Math.round(h))); } catch { /* 存不下就只在本次会话生效 */ }
  };
  grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = wrap.getBoundingClientRect().height;
    document.body.classList.add('cg-resizing');
    const onMove = (ev) => {
      wrap.style.height = `${Math.round(Math.min(PERM_MAX_H, Math.max(minH, startH + (ev.clientY - startY))))}px`;
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.classList.remove('cg-resizing');
      remember(wrap.getBoundingClientRect().height);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
  grip.addEventListener('dblclick', () => {
    wrap.style.height = `${permDefaultHeight()}px`;
    remember(permDefaultHeight());
  });
}

/** 「选择好友」：拉 OneBot 好友列表 → 勾选 → 追加成权限行（已有的跳过，不覆盖已设等级）。 */
async function openFriendPicker(ctx) {
  const existing = new Set(permRows(ctx.pluginConfig() || {}).map((r) => r.qq).filter((qq) => qq && qq !== 'default'));
  let list;
  try {
    const data = await ctx.api('/api/onebot/friends');
    list = data.friends || [];
  } catch (e) {
    ctx.noticeModal('拉取好友失败', `${e.message}（OneBot 没连上？）`);
    return;
  }
  if (!list.length) {
    ctx.noticeModal('没有拉到好友', '没拉到好友列表，检查 SnowLuma 是否在运行。');
    return;
  }
  const overlay = ctx.modal({
    head: `选择好友（${list.length} 个）`,
    body: `<div class="modal-list">${list.map((f) => {
      const id = String(f.id);
      const dup = existing.has(id);
      return `
        <label class="pick-item${dup ? ' is-dim' : ''}">
          <input type="checkbox" class="cg-friend-item" value="${ctx.esc(id)}" ${dup ? 'disabled' : ''} />
          <span>${ctx.esc(f.name)}</span>
          <span class="muted">${ctx.esc(id)}${dup ? ' · 已在表里' : ''}</span>
        </label>`;
    }).join('')}</div>`,
    foot: '<button class="btn btn-primary" type="button" id="cg-friend-apply">添加所选</button>'
  });
  overlay.querySelector('#cg-friend-apply')?.addEventListener('click', () => {
    const picked = $$('.cg-friend-item:checked', overlay).map((el) => el.value);
    ctx.closeModal(overlay);
    if (!picked.length) return;
    savePerm(ctx, (rows) => {
      for (const id of picked) {
        if (rows.some((r) => r.qq === id)) continue;
        rows.push({ qq: id, level: NEW_ROW_LEVEL });
      }
    });
  });
}

/** 批量修改：多选指令 → 统一改权限等级，或统一启用/停用（写进覆盖表）。 */
function openBatchModal(ctx) {
  const gw = ctx.pluginConfig() || {};
  const skills = ctx.skills() || [];
  const routes = effectiveRows(gw, skills);
  if (!routes.length) {
    ctx.noticeModal('还没有任何指令', '等有插件在清单里声明 commands 之后，再来批量改权限。');
    return;
  }
  const nameOf = (id) => skills.find((s) => s.id === id)?.name || id;
  const prefix = String(gw.prefix || '/') || '/';
  const overlay = ctx.modal({
    head: `批量修改（${routes.length} 条指令）`,
    body: `
      <div class="cg-batch-head">
        <button class="btn btn-small" type="button" id="cg-batch-all">全选</button>
        <button class="btn btn-small" type="button" id="cg-batch-none">清空</button>
        <span class="hint" id="cg-batch-count"></span>
      </div>
      <div class="cg-batch-list">
        ${routes.map((r, i) => `
          <label class="pick-item">
            <input type="checkbox" class="cg-batch-item" value="${i}" />
            <span>${ctx.esc(nameOf(r.pluginId))} · ${ctx.esc(prefix + String(r.word || ''))}</span>
            <span class="muted">等级 ${clampLevel(r.permission, ROUTE_DEFAULT_LEVEL)}${r.enabled === false ? ' · 已停用' : ''}</span>
          </label>`).join('')}
      </div>
      <div class="cg-batch-ops">
        <label for="cg-batch-level">统一设为</label>
        <input type="number" id="cg-batch-level" value="${ROUTE_DEFAULT_LEVEL}" min="0" max="100000" step="1" />
        <button class="btn btn-primary btn-small" type="button" id="cg-batch-apply">应用权限</button>
        <button class="btn btn-small" type="button" id="cg-batch-enable">启用所选</button>
        <button class="btn btn-small" type="button" id="cg-batch-disable">停用所选</button>
      </div>
      <div class="hint">只影响勾选的指令；权限等级 0~100000。改动会记进覆盖表。</div>`,
    foot: '<button class="btn" type="button" id="cg-batch-close">关闭</button>'
  });
  const countEl = overlay.querySelector('#cg-batch-count');
  const picked = () => $$('.cg-batch-item:checked', overlay)
    .map((el) => Number(el.value))
    .filter((n) => Number.isFinite(n));
  const refreshCount = () => { if (countEl) countEl.textContent = `已选 ${picked().length} 条`; };
  overlay.addEventListener('change', (e) => {
    if (e.target.classList?.contains('cg-batch-item')) refreshCount();
  });
  overlay.querySelector('#cg-batch-all')?.addEventListener('click', () => {
    $$('.cg-batch-item', overlay).forEach((el) => { el.checked = true; });
    refreshCount();
  });
  overlay.querySelector('#cg-batch-none')?.addEventListener('click', () => {
    $$('.cg-batch-item', overlay).forEach((el) => { el.checked = false; });
    refreshCount();
  });
  // 一个都没勾时只提示、不关弹窗：否则用户得重新打开一遍
  const applyToPicked = (mutator) => {
    const list = picked();
    if (!list.length) { if (countEl) countEl.textContent = '先勾选要修改的指令'; return; }
    ctx.closeModal(overlay);
    saveOverrides(ctx, (overrides) => {
      for (const i of list) {
        const row = routes[i];
        if (!row) continue;
        const patch = mutator({ ...row });
        upsertOverride(overrides, row, patch);
      }
    });
  };
  overlay.querySelector('#cg-batch-apply')?.addEventListener('click', () => {
    const level = clampLevel(overlay.querySelector('#cg-batch-level')?.value, ROUTE_DEFAULT_LEVEL);
    applyToPicked(() => ({ permission: level }));
  });
  overlay.querySelector('#cg-batch-enable')?.addEventListener('click', () => applyToPicked(() => ({ enabled: true })));
  overlay.querySelector('#cg-batch-disable')?.addEventListener('click', () => applyToPicked(() => ({ enabled: false })));
  overlay.querySelector('#cg-batch-close')?.addEventListener('click', () => ctx.closeModal(overlay));
  refreshCount();
}
