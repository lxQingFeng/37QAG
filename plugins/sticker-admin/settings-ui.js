// 表情包管理 · 控制台界面
//
// 这个文件**不是核心代码**。核心按 plugin.json 里的 settingsUi 声明，用只读路由
//   /plugin-assets/sticker-admin/settings-ui.js
// 把本模块取回控制台，在「设置」左栏占一个分区「表情包库」
// （走核心的插件设置页机制：pluginSections() → mountPluginSection()，落点是 #plugin-section-root）。
// 本项目**没有**为它改过任何核心文件 —— 界面完全靠清单声明 + 上面这条只读路由挂载。
//
// 模块契约（见核心 ui/app/06-settings-render.js 的插件设置页机制）：
//   render(ctx) -> string        返回这块界面的 HTML
//   bind(root, ctx) -> cleanup?  绑定事件；返回卸载函数
//   read(ctx) -> object|null     把界面输入读成"要保存的补丁"。本界面**返回 null**：
//                                所有改动都走显式按钮，不走核心的"输入停 600ms 自动保存"——
//                                否则在卡片里打字会被一次次自动保存与重绘打断。
//
// ── 数据怎么走 ───────────────────────────────────────────────────────────
// 两个方向都走本插件自己的配置段 config.skills['sticker-admin']：
//
//   读（列表）：插件服务端把表情库快照（含预览缩略图）写在 .snapshot 上，本模块
//               轮询 GET /api/config 取回渲染。**为什么不读文件**：控制台虽然能用
//               /plugin-assets/ 读插件目录，但插件目录一有文件变化就会触发核心的
//               热重载重扫（fs.watch recursive），插件会被反复重建 —— 详见 index.js 顶部注释。
//   写（改动）：本模块 ctx.save({ pending }) 写 .pending，服务端每 1.5 秒取走执行，
//               把结果回填到同一个对象上。所以操作是"提交 → 最多 1.5 秒后生效"的异步模型。
//
// ── 图片怎么传（本地文件选择器）─────────────────────────────────────────
// 控制台是 Electron 渲染进程（electron/preload.cjs 只暴露窗口控制，nodeIntegration=false），
// 所以**拿不到本地文件路径**（File.path 从 Electron 32 起已移除，webUtils 也要 preload 才用得上，
// 而 preload 属于核心文件，本项目约定不动）。于是：
//   <input type="file" multiple> 选文件 → FileReader 读成 data URL → 走上面那条配置通道发给插件
//   → 插件自己落地成 data/sticker-images/xxx.png 并入库。
// 约束：核心的请求体上限是 2MB（src/app.js MAX_BODY_BYTES），所以这里按体积分批：
//   小图（≤1MB）原样传；大图先在本机用 canvas 压到 720px 长边再传（PNG 保透明）；
//   动图不压（会丢动画），超大动图会明确报错并提示改用「更多 → 本机路径」。

let PLUGIN_ID = 'sticker-admin';
const STYLE_ID = 'sticker-admin-style';
const POLL_MS = 5000;            // 闲着的时候慢慢轮询（快照带缩略图，别刷太勤）
const WAIT_MS = 600;             // 等操作结果时的轮询间隔
const QUEUE_POLL_MS = 1500;      // 有操作在排队等回执时的轮询间隔（要盯着它，得勤一点）

// 单次请求体预算。核心上限 2MB，留出 JSON 外壳与其它字段的余量。
const BODY_BUDGET = 1_400_000;
// 原图小于它就原样传（data URL 会放大到 4/3）。
const RAW_LIMIT = 1_000_000;
const COMPRESS_MAX_EDGE = 720;

// ── 跨重绘保留的界面状态 ─────────────────────────────────────────────────
// 核心在配置变化时会整页重绘（换分区、SSE 推来 configUpdated 等），本模块会被重新挂载。
// 这几份状态放在模块作用域里，重挂载后仍在，正在编辑的提示词不会被吹掉。
const draft = new Map();        // 表情 id → 正在编辑的提示词
let query = '';                 // 搜索词
let tagFilter = '';             // 标签筛选（'' = 全部；'__none__' = 只看未打标）
let openPicker = '';            // 哪个表情的「＋标签」面板是展开的（存 id）
let dragId = '';                // 正在被拖动的表情 id（拖动期间暂停轮询，免得重绘把卡片吹掉）
let seg = null;                 // 最近一次读到的本插件配置段
let lastListSig = '';           // 列表渲染签名：内容没变就不重画，避免打字被打断
let busy = false;               // 有操作在跑：挡掉并发提交（pending 只有一个槽位）
/**
 * 已经提交、但还在等执行的操作用来"收尾"的凭据：{ opId, kind, at }。
 *
 * ⚠️ 这是之前漏掉的一环：判定"排队"之后 submit 就直接收工了，**之后再没人回头看那条
 *    pending** —— 于是状态栏永远挂在「已排队」，哪怕操作后来已经执行成功，用户也收不到
 *    任何回执，只能自己反复点、或者以为坏了。
 *    现在每轮轮询都会拿它对一次账：完成了就报结果，被别的操作顶掉了就说清楚。
 */
let queued = null;

/** 操作类型 → 人话。排队/回执的文案要用它，不然用户看到的是 setRank 这种内部名。 */
const KIND_LABEL = {
  add: '添加表情',
  addBatch: '批量添加',
  delete: '删除表情',
  setNote: '保存提示词',
  annotate: 'AI 识图重写',
  sync: '同步 QQ 收藏',
  setTags: '改标签',
  retagAll: '批量重打标签',
  setRank: '拖动排序'
};

const GRAB_ICON = '<svg width="10" height="16" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">'
  + '<circle cx="2" cy="3" r="1.2"/><circle cx="8" cy="3" r="1.2"/>'
  + '<circle cx="2" cy="8" r="1.2"/><circle cx="8" cy="8" r="1.2"/>'
  + '<circle cx="2" cy="13" r="1.2"/><circle cx="8" cy="13" r="1.2"/></svg>';

const SOURCE_LABEL = { qq: 'QQ 收藏', manual: '手动添加', ai: '机器人收藏' };

const CSS = `
.sa-head { display: flex; align-items: center; gap: 10px; margin-top: 22px; margin-bottom: 6px; }
.sa-head h3 { margin: 0; }
.sa-head .sa-right { margin-left: auto; display: flex; align-items: center; gap: 8px; }
.sa-ok { color: var(--green); }
.sa-warn { color: var(--orange); }
.sa-err { color: var(--red); }
.sa-banner {
  display: flex; gap: 10px; align-items: flex-start;
  border: 1px solid var(--border); border-left: 3px solid var(--orange);
  border-radius: 10px; padding: 9px 12px; margin: 8px 0 12px;
  font-size: 12.5px; line-height: 1.6; color: var(--muted); background: var(--inset-bg);
}
.sa-banner[hidden] { display: none; }
.sa-banner .sa-banner-main { flex: 1; min-width: 0; }
.sa-banner b { color: var(--fg, inherit); }
.sa-bar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin: 10px 0 12px; }
.sa-bar input[type="text"] { width: 230px; }
.sa-chk { display: inline-flex; align-items: center; gap: 5px; font-size: 12.5px; color: var(--muted); }
.sa-chk input { margin: 0; }
.sa-count { margin-left: auto; color: var(--muted); font-size: 12.5px; }
.sa-more { position: relative; }
.sa-more > summary {
  cursor: pointer; font-size: 12.5px; color: var(--muted);
  border: 1px solid var(--border); border-radius: 8px; padding: 4px 9px; list-style: none;
}
.sa-more > summary::-webkit-details-marker { display: none; }
.sa-more[open] > summary { color: var(--accent); border-color: var(--accent); }
.sa-more-body {
  position: absolute; z-index: 30; right: 0; top: calc(100% + 6px); width: min(460px, 78vw);
  border: 1px solid var(--border); border-radius: 10px; padding: 12px 13px;
  background: var(--layer-1); box-shadow: var(--lift, 0 8px 24px rgba(0,0,0,.28));
}
.sa-more-row { display: flex; gap: 8px; align-items: center; margin-top: 8px; }
.sa-more-row:first-child { margin-top: 0; }
.sa-more-row input[type="text"] { flex: 1; min-width: 0; }
.sa-more textarea { width: 100%; box-sizing: border-box; min-height: 52px; resize: vertical; }
.sa-lbl { color: var(--muted); font-size: 12.5px; white-space: nowrap; }
.sa-progress {
  border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; margin: 0 0 12px;
  font-size: 12.5px; color: var(--muted); background: var(--inset-bg); line-height: 1.6;
}
.sa-progress[hidden] { display: none; }
.sa-detail { margin: 4px 0 0; padding-left: 18px; }
.sa-detail li { margin: 1px 0; }

/* ⚠️ 这套网格的对齐规则（踩过四次坑，改之前先读完）：
   · 列宽用 auto-fill + 1fr，不写死；行高不设，**高度统一由"同一行最高的那张"决定**。
   · 卡片必须是 stretch（默认值），不能收高。收高有两种写法，都会坏事：
     - align-self:start / height:fit-content → 每张按自己内容收高，同行参差不齐
       （标签多的矮、没标签的高，用户实测反馈过）；
     - 只写网格的 align-items:start → 卡片仍被拉伸到行高，想改的都改不动，
       而整行高度又由展开的那张决定，展开卡就被拉成一长条、面板中间空一片。
   · 展开的卡片**不要**给它 align-self: start —— 它比同行普通卡高（多了标签面板），
     不参与行高就会溢出到下一行、盖住下面的卡片。让它照常 stretch，
     行高就等于它自己，同行邻居跟着等高（这是用户明确要的"按最高的那个来"）。
   · 等高后卡片底部会多出空间：由 .sa-acts 的 margin-top:auto 吃掉，按钮贴底，
     不会在图和标签中间留一段突兀的空白。 */
.sa-grid {
  --sa-min: 196px;                    /* 单列最小宽度，与下面 auto-fill 保持一致 */
  --sa-gap: 12px;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(var(--sa-min), 1fr));
  gap: var(--sa-gap); align-items: stretch;
}
.sa-card {
  border: 1px solid var(--border); border-radius: 12px; padding: 10px;
  display: flex; flex-direction: column; gap: 8px; min-width: 0;
  position: relative;                 /* 序号角标 / 拖动手柄要叠在卡片上 */
  align-self: stretch;                /* 显式写死：别改回 start / fit-content，见上面 */
}
/* 打开「＋标签」面板：卡片横跨两个格子 —— 宽度**精确等于两张卡 + 中间那道 gap**
   （不要用 calc(2 * --sa-min + gap) 去估：1fr 会把剩余空间摊平，实际列宽比 --sa-min 大，
   估出来的宽度会明显窄于两张卡）。高度照旧交给 stretch，靠 max-height 别让图翻倍。 */
.sa-card.sa-open { grid-column: span 2; }
/* 面板行在放大后的卡片里横着排：分组名 + 计数 + 标签，一行一组，比竖着堆好读 */
.sa-card.sa-open .sa-pick { padding: 6px 8px; gap: 4px; }
.sa-card.sa-open .sa-pickrow { flex-wrap: wrap; align-items: center; gap: 5px; }
.sa-card.sa-open .sa-picklbl { width: auto; min-width: 30px; padding-top: 0; }
.sa-card.sa-open .sa-picks { gap: 3px; }
/* 展开时给图片区封个顶：它没有 flex-grow，不封顶的话展开后宽度翻倍、
   按 1:1 把高度也带着翻倍，卡片会高出一大截（用户要的只是"高一点点"）。 */
.sa-card.sa-open .sa-shot { max-height: 168px; }
.sa-card.sa-open .sa-shot img { max-height: 168px; }
/* 窗口窄到铺不出两列时退回单格，免得 span 2 撑出横向滚动条 */
@media (max-width: 460px) {
  .sa-card.sa-open { grid-column: span 1; }
}
.sa-card.busy { opacity: .55; pointer-events: none; }
/* 拖动排序：整张卡片可拖（手柄只是个提示），拖起来的那张半透明，落点描边高亮 */
.sa-card.sa-drag { opacity: .5; }
.sa-card.sa-drop { border-color: var(--accent); border-style: dashed; }
/* 卡片顶部一行：左边是「常用表情 N」的位次角标，右边是拖动手柄 */
.sa-cardhead { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 14px; }
.sa-grab { cursor: grab; color: var(--faint); line-height: 0; padding: 2px; }
.sa-grab:active { cursor: grabbing; }
.sa-ord {
  font-size: 10.5px; color: var(--on-accent); background: var(--accent);
  border: 1px solid var(--accent); border-radius: 6px; padding: 0 5px; white-space: nowrap;
}
.sa-ord.plain { color: var(--muted); background: var(--layer-1); border-color: var(--border); }
/* 标签筛选行（顶部）与卡片上的标签行 */
.sa-tfilter { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; margin: 0 0 12px; }
.sa-tfilter .sa-fl { font-size: 12.5px; color: var(--muted); margin-right: 2px; }
.sa-chip {
  font-size: 12px; padding: 2px 9px; border-radius: 999px; cursor: pointer;
  border: 1px solid var(--border); background: var(--layer-1); color: var(--muted);
}
/* 分类分组：竖分隔线 + 组名（带该组的颜色），组内的 chip 用同色淡描边 —— 一眼看出归属。
   ⚠️ 这几条必须排在下面的 hover / .on 之前：特异性和它们相同，靠"后写的赢"才能
   让选中的实心蓝不被组色盖掉。 */
.sa-fsep { width: 1px; height: 16px; background: var(--border); margin: 0 3px; }
.sa-fl2 { font-size: 11px; font-weight: 600; color: var(--muted); padding: 0 2px; }
.sa-fl2.g-emotion, .sa-chip.g-emotion { color: #4A4295; border-color: #C9C4F0; }
.sa-fl2.g-usage, .sa-chip.g-usage { color: #3B6D11; border-color: #C0DDA0; }
.sa-fl2.g-subject, .sa-chip.g-subject { color: #5F5E5A; border-color: #DCD9D0; }
.sa-fl2.g-scope, .sa-chip.g-scope { color: #A32D2D; border-color: #F0C2C2; }
.sa-chip:hover { border-color: var(--accent); color: var(--accent); }
.sa-chip.on { border-color: var(--accent); background: var(--accent); color: var(--on-accent); }
.sa-tagrow { display: flex; gap: 4px; flex-wrap: wrap; align-items: center; min-height: 20px; }
.sa-tag {
  font-size: 10.5px; padding: 1px 6px; border-radius: 999px; border: 1px solid var(--border);
  display: inline-flex; gap: 3px; align-items: center; cursor: pointer; color: var(--muted);
  background: var(--layer-1);
}
.sa-tag b { font-weight: 400; }
.sa-tag .x { opacity: .45; font-size: 11px; }
.sa-tag:hover .x { opacity: .9; }
.sa-tag.on, .sa-pick .sa-tag.on { box-shadow: inset 0 0 0 1.5px currentColor; }
/* 「＋标签」是入口，给个淡蓝底提示可点 */
.sa-tag.sa-addtag { color: var(--accent); border-color: var(--accent); }
.sa-tag.sa-addtag:hover { background: var(--accent); color: var(--on-accent); }
/* 「收起」是展开态才有的：实心蓝底 + 亮一点，和周围的中性标签区分开 */
.sa-tag.sa-collapse {
  color: var(--on-accent); background: var(--accent); border-color: var(--accent);
  font-weight: 500; padding-right: 7px;
}
.sa-tag.sa-collapse:hover { filter: brightness(1.12); }
.sa-none { font-size: 10.5px; color: var(--faint); }
/* 四组各一个色系：chip 自带底色与字色，深浅主题下都读得清 */
.sa-tag.g-emotion { color: #3C3489; border-color: #534AB7; background: #EEEDFE; }
.sa-tag.g-usage { color: #27500A; border-color: #3B6D11; background: #EAF3DE; }
.sa-tag.g-subject { color: #444441; border-color: #5F5E5A; background: #F1EFE8; }
.sa-tag.g-scope { color: #791F1F; border-color: #A32D2D; background: #FCEBEB; }
.sa-pick {
  border: 1px solid var(--border); border-radius: 10px; padding: 8px;
  background: var(--inset-bg); display: flex; flex-direction: column; gap: 5px;
}
.sa-pickrow { display: flex; gap: 6px; align-items: flex-start; }
.sa-picklbl { font-size: 11px; color: var(--muted); width: 28px; flex: none; padding-top: 2px; }
/* 组内已选满时把计数标红，省得用户点了没反应还不知道为什么 */
.sa-pickcnt { font-size: 10.5px; color: var(--faint); flex: none; }
.sa-pickcnt.sa-full { color: var(--orange); }
.sa-picks { display: flex; gap: 4px; flex-wrap: wrap; }
/* 等高后多出来的高度全给提示词框：卡片不会在底部空一大片，而且长提示词能一眼看全。
   （flex:1 只会吸收"被拉伸出来的"空间，不会被内容反过来撑高卡片。） */
.sa-note {
  width: 100%; box-sizing: border-box; resize: vertical;
  min-height: 52px; max-height: 200px; font-size: 12.5px; line-height: 1.5;
  border: 1px solid var(--edge); border-radius: 8px; padding: 6px 8px;
  flex: 1 1 auto;
}
.sa-shot {
  position: relative; width: 100%; aspect-ratio: 1 / 1;
  border: 1px solid var(--edge); border-radius: 10px; background: var(--inset-bg);
  display: flex; align-items: center; justify-content: center; overflow: hidden;
}
/* 让表情撑满整个图框：只用 max-width/max-height 的话缩略图多大就显示多大、
   居中留一圈深色底。改成宽高都拉满 + contain —— 在不变形、不裁切的前提下
   取最大尺寸（contain 而不是 cover：表情被裁掉一块就没法认了）。
   图框是正方形，非正方形的图仍会留上下/左右两条窄边，属正常。 */
.sa-shot img { width: 100%; height: 100%; object-fit: contain; display: block; }
.sa-shot .sa-ph { padding: 6px; text-align: center; color: var(--faint); font-size: 11px; line-height: 1.5; word-break: break-all; }
.sa-chips { position: absolute; top: 6px; left: 6px; display: flex; gap: 4px; flex-wrap: wrap; max-width: calc(100% - 12px); }
.sa-badge {
  font-size: 10.5px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--border); color: var(--muted); background: var(--layer-1);
}
.sa-badge.is-local { color: var(--green); border-color: var(--green); }
.sa-badge.is-qq { color: var(--orange); border-color: var(--orange); }
/* 常用表情：核心每轮都会把这几张写进提示词，所以给一层淡蓝底 + 蓝描边标记出来。
   用 --accent 而不是写死 #5b8cff：深浅两套主题下都能自适应。 */
.sa-card.sa-top {
  border-color: var(--accent);
  background: rgba(91, 140, 255, .07);
  background: color-mix(in srgb, var(--accent) 9%, transparent);
}
.sa-badge.is-top {
  color: var(--on-accent); border-color: var(--accent); background: var(--accent);
}
.sa-idchip {
  position: absolute; bottom: 5px; right: 6px; font-size: 10.5px; color: var(--faint);
  background: var(--layer-1); border: 1px solid var(--border); border-radius: 6px; padding: 0 5px;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; max-width: calc(100% - 12px);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
/* 提示词框吸不完的零头由这里吃掉：按钮永远贴卡片底部，不会悬在中间。 */
.sa-acts { display: grid; grid-template-columns: 1fr 1fr auto; gap: 6px; margin-top: auto; }
.sa-acts .btn { padding: 3px 6px; font-size: 11.5px; min-width: 0; }
.sa-cell-add {
  border: 1px dashed var(--border); border-radius: 12px; background: none; color: var(--muted);
  cursor: pointer; display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; font-size: 12.5px; padding: 10px; text-align: center;
  /* 跟卡片一样撑满所在行：写死 min-height 的话，卡片一高它就矮一截（用户实测反馈）。
     这个 min-height 只是"整行只有它一个格子"时的兜底下限。 */
  align-self: stretch; min-height: 240px;
}
.sa-cell-add:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
.sa-cell-add:disabled { opacity: .5; cursor: not-allowed; }
.sa-cell-add .plus { font-size: 34px; line-height: 1; }
.sa-cell-add small { color: var(--faint); font-size: 11px; }
.sa-empty { color: var(--muted); padding: 10px 0; line-height: 1.7; grid-column: 1 / -1; }
.sa-empty code { background: var(--inset-bg); border-radius: 4px; padding: 1px 4px; }
/* 标题下面那段"提示词是干什么用的 + 挑表情的规则"说明。留一倍行距，读起来别糊成一团。 */
.sa-rule { margin-bottom: 6px; line-height: 1.85; }
.sa-rule b { color: var(--text); }
.sa-rule code { background: var(--inset-bg); border-radius: 4px; padding: 1px 4px; }
.sa-rule .sa-k { color: var(--accent); font-weight: 600; }
`;

let root = null;      // 当前挂载的容器
let ctxRef = null;    // 当前上下文
let pollTimer = null;

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function injectStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

// ── 渲染 ─────────────────────────────────────────────────────────────────

export function render(ctx) {
  if (ctx?.pluginId) PLUGIN_ID = String(ctx.pluginId);
  return `
    <div class="sa-head">
      <h3>表情包库</h3>
      <span class="hint" id="sa-status"></span>
      <div class="sa-right">
        <span class="hint" id="sa-count">正在读取…</span>
        <button class="btn btn-small" type="button" id="sa-refresh" title="重新读取表情库">刷新</button>
      </div>
    </div>
    <div class="hint sa-rule" id="sa-rule">
      <b>提示词</b>是模型挑表情时看到的那句话 —— 它只凭这句判断这张图适不适合当前对话，
      所以写清「什么场合用、表达什么情绪」，模型才选得准；<b>标签</b>由 AI 识图后按提示词
      自动匹配，也会一起写进模型看到的那行摘要。<br />
      列表按<b>权重从高到低</b>排列；带<b>淡蓝描边</b>的前几张是<b>常用表情</b>，
      每一轮都会出现在模型眼前，数量 = 聊天 → 表情包 →「提示词里列举的表情包数量」÷ 2
      <span class="sa-k">（默认 10 张 → 前 5 张）</span>，其余从整个表情包里<b>随机抽</b>
      （按小时轮换，同一小时内稳定）。<br />
      <b>拖动卡片</b>可以调整常用表情的顺序和成员：把下面的拖进前几张，被挤出去的那张
      自动退回轮换池（拖动会改写这几张的<b>权重</b>）。
    </div>

    <div class="sa-banner" id="sa-banner" hidden></div>
    <div class="sa-progress" id="sa-progress" hidden></div>

    <div class="sa-bar">
      <input id="sa-search" type="text" value="${esc(query)}" placeholder="搜索提示词 / 标签 / id" />
      <label class="sa-chk" title="关闭则只入库、不写提示词">
        <input type="checkbox" id="sa-auto" /> 新增时 AI 识图写提示词
      </label>
      <button class="btn btn-small" type="button" id="sa-sync"
        title="把 QQ「收藏表情」面板里的表情拉进本地库：新增的会补进来，你在 QQ 里取消收藏的会从本地移除。本地手动添加的条目不受影响。">同步 QQ 收藏</button>
      <button class="btn btn-small" type="button" id="sa-retag"
        title="按每张现有的提示词重算一遍标签：升级后给历史表情补标签，或改过标签表之后整体迁移">批量重打标签</button>
      <details class="sa-more" id="sa-more">
        <summary>更多</summary>
        <div class="sa-more-body">
          <div class="sa-more-row">
            <span class="sa-lbl">识图口径</span>
            <input id="sa-annotate-prompt" type="text" placeholder="留空 = 默认（一句话说明含义与使用场合，40 字内）" />
            <button class="btn btn-small" type="button" id="sa-save-ask">保存</button>
            <span class="hint sa-ok" id="sa-ask-flash"></span>
          </div>
          <div class="sa-more-row">
            <span class="sa-lbl">从链接/路径</span>
            <input id="sa-add-input" type="text" placeholder="https://… 或 D:\\图片\\x.png" />
            <button class="btn btn-small" type="button" id="sa-add-btn">加入</button>
          </div>
          <div class="hint" style="margin-top:8px">
            大图（&gt;1MB）走「链接/路径」最稳：本机路径由插件直接读取，不受上传体积限制。
            图片会存到 <code>data/sticker-images/</code>。
          </div>
        </div>
      </details>
    </div>

    <div class="sa-tfilter" id="sa-tagfilter"></div>

    <input type="file" id="sa-file" accept="image/*" multiple hidden />
    <div class="sa-grid" id="sa-grid"><div class="sa-empty">正在读取表情库…</div></div>`;
}

// ── 事件绑定 ─────────────────────────────────────────────────────────────

export function bind(container, ctx) {
  root = container;
  ctxRef = ctx;
  // 这是一次全新的挂载：DOM 是空的，列表渲染签名必须一起清掉。
  // （签名留在模块作用域是为了"内容没变就不重画"，但重挂载后不清就会误判成
  //   "已经画过了"，列表停在"正在读取…"上。）
  lastListSig = '';
  injectStyle();

  const $ = (sel) => root.querySelector(sel);

  // ＋ 添加：唤起本机文件管理器（可多选）
  $('#sa-file')?.addEventListener('change', (e) => {
    const files = [...(e.target.files || [])];
    e.target.value = '';                   // 允许重复选同一个文件
    void addFiles(files);
  });

  // 加入表情库（链接 / 本机路径）
  $('#sa-add-btn')?.addEventListener('click', () => {
    const input = $('#sa-add-input');
    const value = String(input?.value || '').trim();
    if (!value) { setStatus('先填一个图片链接或本机路径', 'err'); return; }
    const source = /^https?:/i.test(value) ? { kind: 'url', url: value } : { kind: 'path', path: value };
    void submit({ kind: 'add', source, autoAnnotate: autoAnnotateOn() }).then(() => { if (input) input.value = ''; });
  });
  $('#sa-add-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#sa-add-btn')?.click(); }
  });

  // 识别开关 / 识图口径：这两项是普通配置，直接存
  $('#sa-auto')?.addEventListener('change', () => { void saveCfg({ autoAnnotate: $('#sa-auto')?.checked !== false }); });
  $('#sa-save-ask')?.addEventListener('click', async () => {
    await saveCfg({ annotatePrompt: String($('#sa-annotate-prompt')?.value || '').trim() });
    flashAsk('已保存');
  });

  // 搜索
  $('#sa-search')?.addEventListener('input', () => {
    query = String($('#sa-search')?.value || '');
    paint(true);
  });

  // 同步 QQ 收藏
  $('#sa-sync')?.addEventListener('click', () => { void submit({ kind: 'sync' }); });

  // 批量重打标签：升级后给历史表情补标签 / 改过标签表之后整体迁移
  $('#sa-retag')?.addEventListener('click', () => {
    const n = Array.isArray(seg?.snapshot?.items) ? seg.snapshot.items.length : 0;
    if (!n) { setStatus('表情库还是空的，没东西可打', 'warn'); return; }
    if (!window.confirm(`按现有提示词给这 ${n} 张表情重算一遍标签？\n\n`
      + '（手动改过的标签会被覆盖成自动匹配的结果；没匹配到的一律留空，可以再手点）')) return;
    void submit({ kind: 'retagAll' });
  });

  // 顶部标签筛选行
  $('#sa-tagfilter')?.addEventListener('click', (e) => {
    const chip = e.target?.closest?.('[data-sa-tag]');
    if (!chip) return;
    tagFilter = String(chip.dataset.saTag || '');
    paint(true);
  });

  // 手动刷新（立刻重读一次配置，不等轮询）
  $('#sa-refresh')?.addEventListener('click', () => {
    void refresh(true).then((ok) => { if (ok) setStatus('已刷新', 'ok'); });
  });

  // 网格内的事件委托：加号方格 / 标签 / 保存提示词 / 重新识图 / 删除
  $('#sa-grid')?.addEventListener('click', (e) => {
    if (e.target?.closest?.('#sa-add-cell')) { $('#sa-file')?.click(); return; }
    const card = e.target?.closest?.('.sa-card');
    const id = card?.dataset?.id || '';

    // 标签：卡片上的 chip 点一下就去掉；「＋标签」展开分组面板；面板里的 chip 是切换
    const tagEl = e.target?.closest?.('[data-sa-tagact],[data-sa-pick]');
    if (tagEl && id) { void onTagClick(id, tagEl); return; }

    const btn = e.target?.closest?.('[data-sa-act]');
    if (!btn) return;
    if (!id) return;
    const act = btn.dataset.saAct;
    if (act === 'save') {
      const text = String(card.querySelector('.sa-note')?.value || '').trim();
      draft.delete(id);        // 已提交：交给快照里的值接管
      return void submit({ kind: 'setNote', id, note: text });
    }
    if (act === 'annotate') return void submit({ kind: 'annotate', id });
    if (act === 'delete') {
      const label = String(card.querySelector('.sa-note')?.value || id).slice(0, 30);
      if (!window.confirm(`把「${label}」从表情库移除？\n\n（只影响本地库；QQ 收藏的表情删不掉）`)) return;
      return void submit({ kind: 'delete', id });
    }
  });

  // 卡片内在打字：记进 draft，避免轮询重画时被快照里的旧值覆盖
  $('#sa-grid')?.addEventListener('input', (e) => {
    const el = e.target;
    if (el?.classList?.contains('sa-note')) draft.set(el.dataset.id, el.value);
  });

  // ── 拖动排序 ──────────────────────────────────────────────────────────
  // 只有手柄 draggable（整卡可拖会和 textarea 里选字打架）。落点取卡片上的
  // data-idx（全库位次），由插件那一侧去改写 useCount（见 index.js opSetRank）。
  const gridEl = $('#sa-grid');
  const clearMarks = () => {
    for (const el of gridEl?.querySelectorAll('.sa-card.sa-drop') || []) el.classList.remove('sa-drop');
  };
  // 拖起来的那张保持半透明：clearMarks 清掉落点描边后要把它补回来
  const remarkDrag = () => {
    const el = gridEl?.querySelector(`.sa-card[data-id="${CSS_ESC(dragId)}"]`);
    if (el) el.classList.add('sa-drag');
    return el;
  };

  gridEl?.addEventListener('dragstart', (e) => {
    const handle = e.target?.closest?.('.sa-grab');
    // 不是手柄发起的（比如在 textarea 里拖选中的字）—— 直接掐掉
    if (!handle) { e.preventDefault(); return; }
    const card = handle.closest('.sa-card');
    if (!card) { e.preventDefault(); return; }
    dragId = String(card.dataset.id || '');
    card.classList.add('sa-drag');
    try {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
      e.dataTransfer.setDragImage(card, 14, 14);
    } catch { /* 有的浏览器不给 setDragImage，忽略即可 */ }
  });

  gridEl?.addEventListener('dragover', (e) => {
    if (!dragId) return;
    const card = e.target?.closest?.('.sa-card');
    if (!card) return;
    e.preventDefault();                       // 不 preventDefault 就不会触发 drop
    try { e.dataTransfer.dropEffect = 'move'; } catch { /* 忽略 */ }
    clearMarks();
    if (card.dataset.id !== dragId) card.classList.add('sa-drop');
    remarkDrag();
  });

  gridEl?.addEventListener('dragleave', (e) => {
    const card = e.target?.closest?.('.sa-card');
    if (card && !card.contains(e.relatedTarget)) card.classList.remove('sa-drop');
  });

  gridEl?.addEventListener('drop', (e) => {
    if (!dragId) return;
    e.preventDefault();
    const card = e.target?.closest?.('.sa-card');
    const moved = dragId;
    dragId = '';                               // 先清掉，让后面的重绘能正常进行
    clearMarks();
    for (const el of gridEl?.querySelectorAll('.sa-card.sa-drag') || []) el.classList.remove('sa-drag');
    if (!card || card.dataset.id === moved) return;
    const idx = Number(card.dataset.idx);
    if (!Number.isFinite(idx)) return;
    void submit({ kind: 'setRank', id: moved, index: idx });
  });

  gridEl?.addEventListener('dragend', () => {
    dragId = '';
    clearMarks();
    for (const el of gridEl?.querySelectorAll('.sa-card.sa-drag') || []) el.classList.remove('sa-drag');
  });

  void refresh(false);
  // 轮询用递归 setTimeout 而不是 setInterval —— 间隔要能变：
  // 有操作排队等回执时收紧到 QUEUE_POLL_MS，用户给机器人发完消息一两秒内
  // 就能看到「已执行」，而不是对着「已排队」干等满 5 秒。
  const loop = async () => {
    if (!root?.isConnected || pollTimer === null) return;    // 已卸载，链条断在这儿
    // 页签在后台、或有操作正在等结果（waitResult 自己按 WAIT_MS 轮），就跳过这一轮
    if (document.visibilityState !== 'hidden' && !busy) await refresh(false);
    if (root?.isConnected && pollTimer !== null) {
      // 排队且**句柄已经回来了** = 马上要出结果，收紧间隔盯着；
      // 还在等句柄（要用户去发条消息）就按闲时节奏走 —— 催也催不出来，
      // 犯不上每 1.5 秒拉一份带缩略图的快照。
      pollTimer = setTimeout(loop, (queued && seg?.snapshot?.hostReady) ? QUEUE_POLL_MS : POLL_MS);
    }
  };
  pollTimer = setTimeout(loop, POLL_MS);

  return () => {
    if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; }
    // 卸载时把这两个"界面态"归零：
    //   · busy 留在 true 的话，切走再切回来所有按钮都会被"上一个操作还在跑"挡死；
    //   · queued 留着倒无害（重挂载后 adoptPending 会重新接手），但它是和下一次挂载
    //     无关的旧凭据，交给 adoptPending 按配置重建更准。
    // 真有操作在跑也不会丢：那条 pending 还在配置里，下一轮 refresh 就会接管。
    busy = false;
    queued = null;
    root = null;
    ctxRef = null;
  };
}

/** 本界面不参与核心的自动保存（全部走显式按钮）——返回 null 表示"这次不写"。 */
export function read() {
  return null;
}

// ── 标签点选 ─────────────────────────────────────────────────────────────

const TAG_MAX_TOTAL = 5;    // 与 index.js 对齐：一张表情最多挂几个标签

function findItem(id) {
  const items = seg?.snapshot?.items;
  if (!Array.isArray(items)) return null;
  return items.find((i) => String(i.id) === String(id)) || null;
}

/**
 * 卡片上的标签交互。
 *
 * 加减之后由界面算好**整份**标签数组，再走 setTags 整组替换 —— 服务端只认最终名单，
 * 不做增量，免得并发时算错。手改的标签会被下一次「AI 识图重写」按新提示词覆盖，
 * 这是刻意的设计（不提供锁定开关）。
 */
async function onTagClick(id, el) {
  const item = findItem(id);
  if (!item) return;

  if (el.dataset.saTagact === 'pick') {          // 展开 / 收起分组面板
    openPicker = openPicker === id ? '' : id;
    paint(true);
    return;
  }

  const { groupOf, maxOf, labelOf } = tagMeta(seg?.snapshot || {});
  const tags = Array.isArray(item.tags) ? item.tags.slice() : [];
  const fromPicker = el.dataset.saPick !== undefined;
  const label = String(fromPicker ? el.dataset.saPick : (el.dataset.saTag || '')).trim();
  if (!label) return;

  const at = tags.indexOf(label);
  if (fromPicker && at >= 0) tags.splice(at, 1);
  else if (!fromPicker && at >= 0) tags.splice(at, 1);
  else {
    // 新增：先过总数上限，再过组内上限（和 index.js 自动打标的口径一致）
    if (tags.length >= TAG_MAX_TOTAL) { setStatus(`一张最多 ${TAG_MAX_TOTAL} 个标签，先点掉一个`, 'warn'); return; }
    const g = groupOf.get(label) || '';
    const max = maxOf.get(g) || 1;
    const n = tags.filter((t) => (groupOf.get(t) || '') === g).length;
    if (n >= max) { setStatus(`「${labelOf.get(g) || g}」最多 ${max} 个，先点掉一个`, 'warn'); return; }
    tags.push(label);
  }
  await submit({ kind: 'setTags', id, tags });
}

// ── 与核心交互 ───────────────────────────────────────────────────────────

/**
 * 界面上"新增时自动识图"开关的当前意图。
 *
 * 优先看复选框本身：用户刚点的那一下就是他的意图。核心保存配置后只会更新它自己的
 * state.config，不会重绘本分区，所以我们本地这份 seg 会短暂过期（最长一轮轮询）。
 * saveCfg 会顺手把本地那份补上，双保险。
 */
function autoAnnotateOn() {
  const el = root?.querySelector('#sa-auto');
  if (el) return el.checked !== false;
  return seg?.autoAnnotate !== false;
}

function pluginOff() {
  return seg?.enabled === false;
}

/**
 * 提交一个操作给服务端，并等它落地。
 *
 * 走的是本插件自己的配置段：清单里 configSchema 声明过的键才写得进（核心会按声明过滤），
 * 服务端每 1.5 秒看一次，执行完把结果回填在同一个对象上（applied: true）。
 * pending 只有一个槽位，所以这里串行化（busy 期间挡掉新提交）。
 */
async function submit(op, { wait = true } = {}) {
  if (busy) { setStatus('上一个操作还在跑，等它完事', 'warn'); return { ok: false, message: '忙' }; }
  if (pluginOff()) {
    setStatus('插件当前是关闭的，操作不会执行', 'err');
    return { ok: false, message: '插件已关闭' };
  }
  const opId = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // 槽位只有一个：这次提交会覆盖掉先前排队的那条，旧的跟踪凭据作废。
  // （checkQueued 里还有一层"opId 对不上"的兜底，防的是别处改了配置的情况。）
  if (queued) queued = null;
  busy = true;
  markBusy(true);
  setStatus('已提交，等一下下…', 'warn');
  try {
    // 整块替换 pending（核心的 `{ __replace__ }` 约定）：不然 deepMerge 会把上一次操作
    // 留下的 result 合并进来，界面读到的 added / details 可能是上一批的。
    await ctxRef.save({
      pending: {
        __replace__: { ...op, opId, at: new Date().toISOString(), applied: false }
      }
    });
  } catch (error) {
    busy = false;
    markBusy(false);
    const msg = `提交失败：${String(error?.message ?? error)}`;
    setStatus(msg, 'err');
    return { ok: false, message: msg };
  }
  if (!wait) { busy = false; markBusy(false); return { ok: true }; }

  // 提交前就知道句柄没就绪：不必进等待循环了，直接说清"排队中"。
  // 记下来 —— 退出等待不等于不管了，后面的轮询会回来验收这条。
  if (seg?.snapshot?.hostReady === false) {
    busy = false;
    markBusy(false);
    trackQueued(opId, op.kind);
    setStatus(QUEUE_MSG, 'warn');
    return { ok: false, queued: true, message: QUEUE_MSG };
  }

  const expect = op.kind === 'addBatch'
    ? 20000 + 40000 * (op.sources?.length || 1)     // 每张都可能要一次识图（模型调用）
    : (op.kind === 'sync' ? 60000 : 90000);
  const result = await waitResult(opId, expect, op.kind);
  busy = false;
  markBusy(false);
  if (!result) return { ok: false, message: '界面已关闭' };
  // 排队不是失败 —— 别染成红色报错。但要记下来，后面回来验收（见 checkQueued）。
  if (result.queued) { trackQueued(opId, op.kind); setStatus(result.message, 'warn'); }
  else showResult(result);
  return result;
}

async function saveCfg(patch) {
  try {
    const r = await ctxRef.save(patch);
    // 核心保存成功只更新它自己的 state.config，**不会重绘本分区**，本地这份 seg 会一直
    // 停留在上一次轮询的样子。不补这一下的话：刚关掉"自动识图"就立刻加图，
    // 提交出去的操作可能带着过期的值（最长一轮轮询的窗口）。
    seg = { ...(seg || {}), ...patch };
    return r;
  } catch (error) {
    setStatus(`保存失败：${String(error?.message ?? error)}`, 'err');
    return null;
  }
}

/**
 * 操作慢的时候，给一句"为什么慢"的解释 —— 必须**按操作分开措辞**。
 *
 * 早先所有操作共用一句「识图调用模型可能比较慢」，结果拖动排序（纯本地改几个数字，
 * 一个模型请求都不发）也顶着这句，看着像在偷偷调模型。按 kind 分开后，
 * 只有真正会调模型/联网的操作才提模型。
 */
const SLOW_HINT = {
  add: '，识图要调模型，可能比较慢',
  addBatch: '，每张都要识图调模型，可能比较慢',
  annotate: '，识图要调模型，可能比较慢',
  sync: '，要去 QQ 拉一次收藏列表，可能比较慢',
  retagAll: '，要按提示词给全库重算一遍，张数多时慢一点'
};

/**
 * 句柄没就绪时的那句话 —— 必须说清"这事不会自己好"。
 *
 * host 是插件改库的唯一入口，而它**只有机器人收到消息时才会递过来**；
 * 软件重启 / 插件热重载都会把它清掉。这时提交的操作会老实排在配置里，
 * 等句柄到手后自动执行 —— 关键是别让用户以为"正在跑，再等等"。
 */
const QUEUE_MSG = '已排队：插件还没拿到表情库的句柄（软件重启或插件重载后会丢，要等机器人收到一条消息）。'
  + '给机器人随便发一句，这个操作会自动执行 —— 别重复点，重复点会把排队的这条挤掉。';

/** 记下"这条在排队"，后面每轮轮询回来验收它。 */
function trackQueued(opId, kind) {
  queued = { opId: String(opId || ''), kind: String(kind || ''), at: Date.now() };
}

/**
 * 重挂载后，把配置里"还没执行完"的那条接回来。
 *
 * 核心在换分区 / 配置变化时会整页重绘，本模块被重新挂载 —— 模块作用域里的 queued 还在，
 * 但如果插件是在界面之外被重载的（比如我同步文件触发热重载），queued 就无从得知了。
 * 这时直接看配置：pending 里 applied 不是 true，就说明有条操作还没落地，接管它。
 * 不然用户在这次挂载里永远收不到那条操作的回执。
 */
function adoptPending() {
  if (queued || busy) return;                  // 自己正在管的那条，别抢
  const p = seg?.pending;
  if (!p || !p.opId || p.applied === true) return;
  queued = { opId: String(p.opId), kind: String(p.kind || ''), at: Date.parse(p.at) || Date.now() };
}

/**
 * 排队之后的"回执"。每轮轮询都会调一次。
 *
 * 三种结局都要说清楚，不能留一个悬着的「已排队」：
 *   · 执行完了 → 报结果（成功/失败都报）；
 *   · 句柄到手、正在跑 → 说明已经在执行了（用户知道发消息起作用了）；
 *   · 被顶掉了 → 明说是新操作占了槽位（pending 只有一个），别让他以为还在等。
 */
function checkQueued() {
  if (!queued) return;
  const p = seg?.pending;
  const label = KIND_LABEL[queued.kind] || '排队的操作';

  if (!p || !p.opId) { queued = null; return; }        // 配置被重置了，没什么可等的

  if (p.opId !== queued.opId) {
    queued = null;
    setStatus(`排队的那条被新的操作顶掉了（pending 只有一个槽位），以新的为准`, 'warn');
    return;
  }

  if (p.applied === true) {
    queued = null;
    const r = p.result || { ok: false, message: '完成，但没有返回结果' };
    const tail = r.message || (r.ok ? '完成' : '失败');
    showResult({ ...r, message: `「${label}」排队后已执行 —— ${tail}` });
    return;
  }

  // 还没落地：区分"在等句柄"和"已经拿到句柄、正在跑"，这两种用户要做的事完全不同。
  const secs = Math.round((Date.now() - queued.at) / 1000);
  if (seg?.snapshot?.hostReady) {
    setStatus(`「${label}」已拿到句柄，正在执行…（已排队 ${secs} 秒）`, 'warn');
  } else {
    setStatus(`「${label}」已排队 ${secs} 秒 —— 给机器人发一条消息就会自动执行`, 'warn');
  }
}

/** 等某个操作被服务端执行完（回填 applied: true）。超时返回一条可读的解释。 */
async function waitResult(opId, timeoutMs, kind = '') {
  const t0 = Date.now();
  let noHost = 0;                 // 连续读到"句柄没就绪"的轮数
  while (Date.now() - t0 < timeoutMs) {
    await sleep(WAIT_MS);
    if (!root?.isConnected) return null;
    await readSegment();
    paint(false);
    if (seg?.pending?.opId === opId && seg.pending.applied === true) {
      return seg.pending.result || { ok: false, message: '完成，但没有返回结果' };
    }
    if (pluginOff()) return { ok: false, message: '插件在这期间被关掉了，操作没有执行' };

    // 句柄没就绪 —— 这不是"卡住"，也不是"慢"：插件还没拿到表情库引用
    // （软件重启 / 插件热重载后 host 归零，要等机器人收到一条消息才会回来）。
    // 操作已经排在配置里了，句柄一到就会自动跑（services 那侧 host-tap 会立刻踢一次）。
    // 所以**别在这儿干等到超时** —— 什么都等不出来，只是让用户对着假进度发呆。
    // 连续两轮都读不到才判定，避开刚提交那一两轮快照还没刷新的窗口期。
    if (!seg?.snapshot?.hostReady) {
      noHost += 1;
      if (noHost >= 2) return { ok: false, queued: true, message: QUEUE_MSG };
      setStatus('已提交，正在确认…', 'warn');
      continue;
    }
    noHost = 0;

    const secs = Math.round((Date.now() - t0) / 1000);
    if (secs > 6) {
      // 没写进表里的操作（setNote / setTags / setRank / delete）都是纯本地改数据，
      // 慢只可能是"排在别的操作后面"—— pending 只有一个槽位，得等前一个做完。
      const hint = SLOW_HINT[kind] || '，可能排在别的操作后面（一次只处理一个）';
      setStatus(`正在处理…（已 ${secs} 秒${hint}）`, 'warn');
    }
  }
  return { ok: false, message: '等超时了：操作可能没执行 —— 确认插件是开着的，并且机器人收到过消息。' };
}

// ── 多选添加 ─────────────────────────────────────────────────────────────

/**
 * 一次加多张。
 *
 * 体积决定怎么传（核心请求体上限 2MB）：
 *   · 小图：原样 data URL；
 *   · 大图：本机 canvas 压到 720px 长边（PNG 保透明，其余转 JPEG）；
 *   · 压缩后仍超预算 / 动图太大：跳过并说明，提示改用「更多 → 从链接/路径」。
 * 然后按预算分批提交（每批一次 addBatch），串行等结果，进度实时显示。
 */
async function addFiles(files) {
  const picked = (files || []).filter((f) => /^image\//i.test(f.type || '') || /\.(png|jpe?g|gif|webp|bmp)$/i.test(f.name || ''));
  if (!picked.length) { setStatus('没有可用的图片文件（支持 png / jpg / gif / webp / bmp）', 'err'); return; }
  if (pluginOff()) { setStatus('插件当前是关闭的，先在下面把它打开', 'err'); return; }
  if (busy) { setStatus('上一个操作还在跑，等它完事', 'warn'); return; }

  const ready = [];
  const skipped = [];
  for (let i = 0; i < picked.length; i += 1) {
    const f = picked[i];
    showProgress(`正在读取 ${i + 1}/${picked.length}：${f.name}`);
    try {
      ready.push({ name: f.name, ...(await prepareFile(f)) });
    } catch (error) {
      skipped.push(`${f.name}：${String(error?.message ?? error)}`);
    }
  }

  if (!ready.length) {
    showProgress('', { details: skipped });
    setStatus('这批都没能加入', 'err');
    return;
  }

  // 按预算分批
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const item of ready) {
    if (cur.length && curBytes + item.bytes > BODY_BUDGET) { chunks.push(cur); cur = []; curBytes = 0; }
    cur.push(item);
    curBytes += item.bytes + 400;                    // 400 是每条 JSON 外壳的余量
  }
  if (cur.length) chunks.push(cur);

  let done = 0;
  let added = 0;
  const failed = [];
  const doneLines = [];
  for (let ci = 0; ci < chunks.length; ci += 1) {
    const chunk = chunks[ci];
    showProgress(`正在加入第 ${ci + 1}/${chunks.length} 批（${chunk.length} 张）`
      + `：${chunk.map((c) => c.name).join('、')}`
      + (autoAnnotateOn() ? '；正在让 AI 识图…' : ''));
    const op = chunk.length > 1
      ? {
        kind: 'addBatch',
        autoAnnotate: autoAnnotateOn(),
        sources: chunk.map((c) => ({ name: c.name, source: { kind: 'dataUrl', dataUrl: c.dataUrl, name: c.name } }))
      }
      : {
        kind: 'add',
        autoAnnotate: autoAnnotateOn(),
        source: { kind: 'dataUrl', dataUrl: chunk[0].dataUrl, name: chunk[0].name }
      };
    const r = await submit(op);
    done += chunk.length;
    if (r?.added) added += r.added;
    else if (r?.ok) added += 1;
    if (Array.isArray(r?.details)) {
      for (const d of r.details) if (!d.ok) failed.push(`${d.name}：${d.message}`);
    } else if (r && !r.ok && r.message) {
      failed.push(r.message);
    }
    // 单张时把服务端的原话留一条（里面常有 AI 刚写好的提示词，值得看一眼）
    if (r?.ok && chunk.length === 1 && r.message) doneLines.push(`✓ ${chunk[0].name} · ${r.message}`);
  }

  const lines = [];
  lines.push(`已处理 ${done} 张`);
  lines.push(...doneLines);
  if (skipped.length) lines.push(...skipped.map((s) => `读图失败 · ${s}`));
  if (failed.length) lines.push(...failed.map((s) => `没成功 · ${s}`));
  showProgress(`这次加了 ${added} 张${(skipped.length + failed.length) ? `，${skipped.length + failed.length} 张没成功` : ''}`, { details: lines });
  setStatus(added ? `已加入 ${added} 张` : '没有新增', added ? 'ok' : 'err');
}

/** 单个文件 → 可上传的 data URL（必要时先压）。 */
async function prepareFile(file) {
  const dataUrl = await readAsDataURL(file);
  let bytes = dataUrl.length + 400;
  if (bytes <= BODY_BUDGET) return { dataUrl, bytes, compressed: false };

  const isGif = /gif/i.test(file.type || '') || /\.gif$/i.test(file.name || '');
  if (isGif) {
    throw new Error(`动图 ${Math.round(file.size / 1024)}KB 太大（压缩会丢动画）——`
      + '请改用「更多 → 从链接/路径」填本机完整路径');
  }
  const small = await compressToFit(dataUrl, file.type || '');
  if (small.bytes > BODY_BUDGET) {
    throw new Error(`压缩后仍有 ${Math.round(small.bytes / 1024)}KB，太大 ——`
      + '请改用「更多 → 从链接/路径」填本机完整路径');
  }
  return { dataUrl: small.dataUrl, bytes: small.bytes, compressed: true };
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('读文件失败'));
    reader.readAsDataURL(file);
  });
}

/** 用 canvas 压到 720px 长边（不放大）。PNG 保留透明，其余转 JPEG。 */
async function compressToFit(dataUrl, mime) {
  const img = await new Promise((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = () => reject(new Error('这张图浏览器解不开（可能是不支持的格式）'));
    el.src = dataUrl;
  });
  const w0 = img.naturalWidth || img.width;
  const h0 = img.naturalHeight || img.height;
  if (!w0 || !h0) throw new Error('读不到图片尺寸');
  const scale = Math.min(1, COMPRESS_MAX_EDGE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ictx = canvas.getContext('2d');
  ictx.drawImage(img, 0, 0, w, h);
  const type = /png/i.test(mime) ? 'image/png' : 'image/jpeg';
  const out = canvas.toDataURL(type, 0.9);
  return { dataUrl: out, bytes: out.length + 400 };
}

// ── 读配置 / 画界面 ──────────────────────────────────────────────────────

/** 读一次配置（快照 + 操作状态 + 开关都在里面）。返回是否读到。 */
async function readSegment() {
  let cfg = null;
  try {
    cfg = ctxRef?.api
      ? await ctxRef.api('/api/config')
      : await (await fetch('/api/config', { cache: 'no-store' })).json();
  } catch { return false; }
  seg = (cfg?.skills || {})[PLUGIN_ID] || {};
  return true;
}

/** 重读并重画。manual=true 时刷新按钮会给出反馈。 */
async function refresh(manual) {
  if (!root?.isConnected) return false;     // 已经切走了，别再轮询
  const ok = await readSegment();
  if (!ok && manual) { setStatus('读取失败：控制台接口没响应', 'err'); return false; }
  // 顺序不能反：先接管（重挂载/插件重载后可能有个孤儿 pending），再验收。
  adoptPending();
  checkQueued();
  paint(false);
  return ok;
}

/**
 * 画界面。
 *
 * force=true（搜索框打字）必须重画；其余情况**内容没变就不重画** ——
 * 每 5 秒重建一次 innerHTML 会把正在编辑的 textarea 焦点和光标位置一起吹掉。
 */
function paint(force) {
  if (!root) return;
  // 正在拖卡片：这一下重绘会把拖到一半的 DOM 换掉，drag 手势直接断掉。
  // 拖动很短，跳过这一两轮轮询没有代价。
  if (dragId) return;
  paintBanner();

  const autoEl = root.querySelector('#sa-auto');
  if (autoEl && document.activeElement !== autoEl) autoEl.checked = autoAnnotateOn();
  const askEl = root.querySelector('#sa-annotate-prompt');
  if (askEl && document.activeElement !== askEl) askEl.value = String(seg?.annotatePrompt || '');

  const grid = root.querySelector('#sa-grid');
  const count = root.querySelector('#sa-count');
  const filterBox = root.querySelector('#sa-tagfilter');
  if (!grid) return;

  const snap = seg?.snapshot && typeof seg.snapshot === 'object' ? seg.snapshot : null;
  const all = Array.isArray(snap?.items) ? snap.items : [];
  const q = query.trim().toLowerCase();

  // 先在全库上留下"绝对位次"：拖动排序要的是全库里的第几位，不是筛选之后的第几位。
  const rows = [];
  for (let i = 0; i < all.length; i += 1) {
    const it = all[i];
    const tags = Array.isArray(it.tags) ? it.tags : [];
    if (q && ![it.id, it.desc, it.note, ...tags].join(' ').toLowerCase().includes(q)) continue;
    if (tagFilter === NONE_TAG) { if (tags.length) continue; }
    else if (tagFilter && !tags.includes(tagFilter)) continue;
    rows.push({ it, idx: i });
  }
  const items = rows.map((r) => r.it);

  if (count) {
    // 优先用快照里的 topN；万一旧快照还没这个字段，就从 items 的 top 标记数出来。
    // 注意数的是 all（全库）而不是 items（搜索后的子集），否则一搜索数字就变小了。
    const topN = Number(snap?.topN) || all.filter((i) => i.top).length;
    const top = topN > 0 ? ` · 常用表情 ${topN} 张` : '';
    const untagged = all.filter((i) => !(i.tags || []).length).length;
    const noTag = snap && untagged ? ` · 未打标 ${untagged}` : '';
    if (!snap) count.textContent = '还没读到表情库';
    else count.textContent = (q || tagFilter)
      ? `匹配 ${items.length} / 共 ${all.length}`
      : `共 ${all.length} 个表情${top}${noTag}${snap.truncated ? '（已截断显示）' : ''}`;
  }

  if (filterBox) filterBox.innerHTML = tagFilterHtml(all, snap);

  const sig = JSON.stringify([
    // 顶层字段也要算进来：快照升级后 items 可能没变、但 topN/版本变了，
    // 不比就会漏掉「常用表情 5 张」这类文案更新。
    Number(snap?.v) || 0,
    Number(snap?.topN) || 0,
    items.map((i) => [
      i.id, i.note, i.desc, i.source, i.canDelete, i.useCount, i.top ? 1 : 0,
      (i.tags || []).join(','),
      i.img?.src || i.img?.name || '',
      i.img?.thumb ? i.img.thumb.slice(-24) : ''
    ]),
    q,
    tagFilter,
    openPicker,
    !!snap?.hostReady,
    !!snap?.truncated,
    pluginOff()
  ]);
  if (!force && sig === lastListSig) return;
  lastListSig = sig;

  // 重画会丢掉焦点：记住正在编辑的那个输入框，画完再放回去。
  const focus = captureFocus(grid);
  grid.innerHTML = listHtml(rows, snap) + addCellHtml();
  restoreFocus(grid, focus);
}

/** 「未打标」是个筛选条件，不是标签名 —— 用一个不可能和标签重名的哨兵值。 */
const NONE_TAG = '__untagged__';

/** 顶部标签筛选行：全部 / 未打标 / 用得最多的几个标签 / 慎发。 */
/**
 * 顶部标签筛选行。
 *
 * 按**分类**成组排（情绪 → 用法 → 题材 → 适配），不再把标签按热度混在一起 ——
 * 热度排序看着"智能"，真到要用的时候并不好使：你心里想的是"找个情绪向的标签"，
 * 却得在一排混排里逐个认。分组之后先定位类别、再挑标签，扫的范围小一个数量级。
 * 组内仍按数量降序（用得多的靠前）。组顺序和标签归属全部来自标签表
 * （index.js 的 TAG_GROUPS / TAGS），这边不写死，以后加组自动跟上。
 */
function tagFilterHtml(all, snap) {
  if (!all.length) return '';
  const counts = new Map();
  let untagged = 0;
  for (const it of all) {
    const tags = Array.isArray(it.tags) ? it.tags : [];
    if (!tags.length) { untagged += 1; continue; }
    for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  const { defs, groups } = tagMeta(snap);
  const chip = (value, label, n, on, g = '') =>
    `<span class="sa-chip${g ? ` g-${esc(g)}` : ''}${on ? ' on' : ''}"`
    + ` data-sa-tag="${esc(value)}">${esc(label)} ${n}</span>`;

  const parts = [chip('', '全部', all.length, !tagFilter)];
  if (untagged) parts.push(chip(NONE_TAG, '未打标', untagged, tagFilter === NONE_TAG));

  const known = new Set();
  for (const g of groups) {
    const inGroup = defs
      .filter((d) => String(d.group) === String(g.id))
      .map((d) => String(d.label))
      .filter((label) => (counts.get(label) || 0) > 0)
      .sort((a, b) => (counts.get(b) || 0) - (counts.get(a) || 0));
    if (!inGroup.length) continue;            // 这一类一个都没用上：整组不出现，不占地方
    for (const label of inGroup) known.add(label);
    parts.push('<span class="sa-fsep"></span>');
    parts.push(`<span class="sa-fl2 g-${esc(g.id)}">${esc(g.label || g.id)}</span>`);
    for (const label of inGroup) {
      parts.push(chip(label, label, counts.get(label) || 0, tagFilter === label, g.id));
    }
  }

  // 标签表之外的残留标签（改过标签表、库里还存着旧名）：兜一个「其它」，
  // 不然它们只能在卡片上看得见、却筛不出来。
  const others = [...counts.entries()].filter(([t]) => !known.has(t)).sort((a, b) => b[1] - a[1]);
  if (others.length) {
    parts.push('<span class="sa-fsep"></span>');
    parts.push('<span class="sa-fl2">其它</span>');
    for (const [t, n] of others) parts.push(chip(t, t, n, tagFilter === t));
  }
  return `<span class="sa-fl">标签筛选</span>${parts.join('')}`;
}

function listHtml(rows, snap) {
  if (!snap) {
    if (pluginOff()) {
      return `<div class="sa-empty">插件现在是关闭的，面板不会读取表情库。<br />
        用上面的「开启插件」按钮打开它（打开后列表会自动出现）。</div>`;
    }
    return `<div class="sa-empty">
      还没读到表情库快照。<br />
      插件已加载，正在等它第一次写快照 —— 通常一两秒内就会出来。
      如果一直这样：给机器人发一条消息（群里 @ 一下或私聊一句）。<br />
      还不行的话，去「插件」页看 sticker-admin 是不是加载失败了。
    </div>`;
  }
  if (!rows.length) {
    return `<div class="sa-empty">${(query.trim() || tagFilter) ? '没有匹配的表情。' : '表情库还是空的：点右边的「＋」加一张试试。'}</div>`;
  }
  return rows.map(({ it, idx }) => cardHtml(it, idx, snap)).join('');
}

/** 标签表：快照里只给 {id,label,group} 和分组定义，界面据此上色 + 管组内上限。 */
function tagMeta(snap) {
  const defs = Array.isArray(snap?.tagDefs) ? snap.tagDefs : [];
  const groups = Array.isArray(snap?.tagGroups) ? snap.tagGroups : [];
  const groupOf = new Map(defs.map((d) => [String(d.label), String(d.group || '')]));
  const maxOf = new Map(groups.map((g) => [String(g.id), Number(g.max) || 1]));
  const labelOf = new Map(groups.map((g) => [String(g.id), String(g.label || g.id)]));
  // 分类排序用的两个表：组本身的先后（情绪 0 → 用法 1 → 题材 2 → 适配 3），
  // 以及每个标签落在第几组。顺序全部取自服务端送来的数组，这边不另抄一份常量 ——
  // 以后加组、调顺序只改 index.js 的 TAG_GROUPS，界面自动跟上。
  const gOrder = new Map(groups.map((g, i) => [String(g.id), i]));
  const orderOf = new Map(defs.map((d) => [
    String(d.label),
    gOrder.has(String(d.group)) ? gOrder.get(String(d.group)) : 99
  ]));
  return { defs, groups, groupOf, maxOf, labelOf, gOrder, orderOf };
}

/**
 * 把一串标签按分类排好：情绪 → 用法 → 题材 → 适配，组内保持原先后。
 *
 * 只作用于**显示**（卡片上的标签行），存储顺序由服务端 sortTags 定 —— 两边用的是
 * 同一套组顺序（都来自标签表），所以看起来始终一致。不认识的标签排最后，不丢。
 */
function orderTags(tags, snap) {
  const { orderOf } = tagMeta(snap);
  return tags
    .map((t, i) => ({ t, i, k: orderOf.has(String(t)) ? orderOf.get(String(t)) : 99 }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.t);
}

/** 卡片上的标签行：每个标签一个 chip（点一下去掉），末尾是「＋标签」。 */
function tagRowHtml(id, tags, snap) {
  const { groupOf } = tagMeta(snap);
  const chips = orderTags(tags, snap).map((t) => {
    const g = groupOf.get(t) || '';
    return `<span class="sa-tag${g ? ` g-${esc(g)}` : ''}" data-sa-tagact="del" data-sa-tag="${esc(t)}"`
      + ' title="点一下去掉这个标签">'
      + `<b>${esc(t)}</b><span class="x">×</span></span>`;
  }).join('');
  const none = tags.length ? '' : '<span class="sa-none">未打标</span>';
  // 展开时「收起」用实心蓝底：它是个动作、也是个状态提示 —— 一眼看出
  // "这张卡正被展开着"，不用去比对卡片哪儿不一样。
  const open = openPicker === id;
  const btn = open
    ? '<span class="sa-tag sa-collapse" data-sa-tagact="pick" title="收起标签面板，卡片恢复原大小">收起 ▴</span>'
    : '<span class="sa-tag sa-addtag" data-sa-tagact="pick" title="手动挑标签（AI 识图时会自动重算）">＋标签</span>';
  return `<div class="sa-tagrow">${chips}${none}${btn}</div>`;
}

/** 「＋标签」展开后的分组选择面板：已选中的描边高亮，点一下切换。 */
function pickerHtml(id, tags, snap) {
  const { defs, groups, groupOf, labelOf } = tagMeta(snap);
  if (!defs.length) return '<div class="sa-pick"><span class="sa-none">标签表还没读到，刷新一下</span></div>';
  const body = groups.map((g) => {
    const picks = defs.filter((d) => String(d.group) === String(g.id)).map((d) => {
      const on = tags.includes(String(d.label));
      return `<span class="sa-tag g-${esc(g.id)}${on ? ' on' : ''}" data-sa-pick="${esc(d.label)}">`
        + `${esc(d.label)}</span>`;
    }).join('');
    const n = tags.filter((t) => (groupOf.get(t) || '') === String(g.id)).length;
    // 计数跟在分组名后面（不占单独一列）：面板窄的时候能省下一整行的宽度
    const full = n >= Number(g.max || 1);
    return `<div class="sa-pickrow">`
      + `<span class="sa-picklbl">${esc(labelOf.get(String(g.id)) || g.label || g.id)}</span>`
      + `<span class="sa-pickcnt${full ? ' sa-full' : ''}">${n}/${g.max}</span>`
      + `<span class="sa-picks">${picks}</span></div>`;
  }).join('');
  return `<div class="sa-pick" data-sa-for="${esc(id)}">${body}</div>`;
}

function cardHtml(it, idx, snap) {
  const id = String(it.id || '');
  const editing = draft.has(id);
  // 库里可能只有 desc（QQ 自带备注 / 早期识图结果），没有 localNote；
  // 这时把 desc 填进输入框 —— 它就是模型眼前正在看的那句话。
  const value = editing ? draft.get(id) : (it.note || it.desc || '');
  const src = String(it.source || 'qq');
  const badge = src === 'qq'
    ? '<span class="sa-badge is-qq">QQ 收藏</span>'
    : `<span class="sa-badge is-local">${esc(SOURCE_LABEL[src] || src)}</span>`;
  // 常用表情那几张的 useCount 可能被拖动排序改写过（见 index.js opSetRank），
  // 不再等于真实使用次数 —— 所以它们显示成「权重」，池子里的照旧显示「用过 N 次」。
  const useN = Number(it.useCount) || 0;
  const use = useN ? `<span class="sa-badge">${it.top ? `权重 ${useN}` : `用过 ${useN} 次`}</span>` : '';
  const tags = Array.isArray(it.tags) ? it.tags : [];

  const img = it.img || {};
  let shot;
  if (img.kind === 'url' && img.src) {
    shot = `<img src="${esc(img.src)}" alt="" loading="lazy" referrerpolicy="no-referrer" />`;
  } else if (img.thumb) {
    shot = `<img src="${esc(img.thumb)}" alt="" loading="lazy" />`;
  } else {
    const name = String(img.name || '');
    shot = `<div class="sa-ph">${name ? `没有可显示的预览<br />${esc(name)}` : '没有可显示的预览'}</div>`;
  }

  // 插件关着的时候按钮直接禁用（横幅上写了为什么、怎么开），别让人点了没反应
  const off = pluginOff();
  const offTitle = off ? '插件当前是关闭的，先在上面把它打开' : '';
  const dis = off ? ' disabled' : '';
  const saveBtn = `<button class="btn btn-small" type="button" data-sa-act="save"${dis}`
    + `${off ? ` title="${offTitle}"` : ''}>保存提示词</button>`;
  const anBtn = `<button class="btn btn-small" type="button" data-sa-act="annotate"${dis}`
    + ` title="${off ? offTitle : '让 AI 再看一次图，重写提示词'}">AI 识图重写</button>`;
  const delBtn = it.canDelete
    ? `<button class="btn btn-small btn-danger" type="button" data-sa-act="delete"${dis}`
      + `${off ? ` title="${offTitle}"` : ''}>删除</button>`
    : '<button class="btn btn-small" type="button" data-sa-act="delete" disabled'
      + ' title="QQ 收藏的表情本地删不掉，请到 QQ 里取消收藏">删除</button>';

  // 拖动排序：只有右上角那个手柄是 draggable（整卡可拖会和 textarea 里选字打架），
  // 落点用 data-idx —— 它是**全库**里的位次，不是筛选后的，所以搜索时拖也不会排错位。
  const tip = it.top
    ? '常用表情：模型每一轮都会在提示词里看到这几张。拖手柄可以改位次'
    : '拖手柄可以把它排进常用表情（被挤出去的那张会退回轮换池）';

  const cls = `sa-card${it.top ? ' sa-top' : ''}${openPicker === id ? ' sa-open' : ''}`;

  return `
    <div class="${cls}" data-id="${esc(id)}" data-idx="${idx}" title="${esc(tip)}">
      <div class="sa-cardhead">
        ${it.top
          ? `<span class="sa-ord">常用表情 ${idx + 1}</span>`
          : `<span class="sa-ord plain">第 ${idx + 1} 位</span>`}
        <span class="sa-grab" draggable="true" title="按住拖到想放的位次">${GRAB_ICON}</span>
      </div>
      <textarea class="sa-note" data-id="${esc(id)}" rows="2"
        placeholder="给这张表情写一句提示词，例：假装无语，适合被怼时用">${esc(value)}</textarea>
      <div class="sa-shot" title="${esc(img.name || img.src || '')}">
        ${shot}
        <div class="sa-chips">${badge}${use}</div>
        <span class="sa-idchip" title="${esc(id)}">${esc(id.length > 16 ? `…${id.slice(-14)}` : id)}</span>
      </div>
      ${tagRowHtml(id, tags, snap)}
      ${openPicker === id ? pickerHtml(id, tags, snap) : ''}
      <div class="sa-acts">
        ${saveBtn}
        ${anBtn}
        ${delBtn}
      </div>
    </div>`;
}

function addCellHtml() {
  return `
    <button class="sa-cell-add" type="button" id="sa-add-cell" ${pluginOff() ? 'disabled' : ''}
      title="打开本机文件选择器，可一次选多张">
      <span class="plus">＋</span>
      <span>添加表情</span>
      <small>可一次选多张图片</small>
    </button>`;
}

/** 记住重画前正在编辑的输入框（id + 光标位置）。 */
function captureFocus(grid) {
  const el = document.activeElement;
  if (!el || !grid.contains(el) || !el.dataset?.id) return null;
  return {
    id: el.dataset.id,
    role: el.classList.contains('sa-note') ? 'note' : 'other',
    start: el.selectionStart ?? null,
    end: el.selectionEnd ?? null
  };
}

function restoreFocus(grid, focus) {
  if (!focus || focus.role !== 'note') return;
  const el = grid.querySelector(`.sa-card[data-id="${CSS_ESC(focus.id)}"] .sa-note`);
  if (!el) return;
  el.focus();
  try { el.setSelectionRange(focus.start ?? 0, focus.end ?? 0); } catch { /* 类型不支持就算了 */ }
}

function CSS_ESC(v) {
  return String(v ?? '').replace(/["\\]/g, '\\$&');
}

// ── 小工具：横幅 / 进度 / 状态 ───────────────────────────────────────────

function paintBanner() {
  const el = root?.querySelector('#sa-banner');
  if (!el) return;
  const snap = seg?.snapshot;
  const off = pluginOff();

  if (off) {
    el.hidden = false;
    el.innerHTML = `
      <div class="sa-banner-main">
        <b>这个插件现在是关闭的。</b><br />
        关闭后它仍然留在设置左栏里 —— 这是核心的刻意设计：不然你在里面关掉之后，
        就再没有地方把它打开了。关闭期间只看旧数据，按钮点了也不会执行。
      </div>
      <button class="btn btn-small btn-primary" type="button" id="sa-enable">开启插件</button>`;
    el.querySelector('#sa-enable')?.addEventListener('click', async () => {
      setStatus('正在开启…', 'warn');
      try {
        await ctxRef.setEnabled(true);
        await ctxRef.reload();
        setStatus('插件已开启', 'ok');
      } catch (error) {
        setStatus(`开启失败：${String(error?.message ?? error)}`, 'err');
      }
    });
    return;
  }

  if (snap && snap.hostReady === false) {
    el.hidden = false;
    el.innerHTML = `<div class="sa-banner-main">
      <b>只读模式。</b>面板已经能列出表情库，但改不了 —— 核心只在「机器人收到消息」这一刻
      交出表情库句柄。给机器人发一条消息（群里 @ 一下或私聊一句），上面的按钮就会生效。
    </div>`;
    return;
  }

  el.hidden = true;
  el.innerHTML = '';
}

function showProgress(text, { details = [] } = {}) {
  const el = root?.querySelector('#sa-progress');
  if (!el) return;
  if (!text && !details.length) { el.hidden = true; el.innerHTML = ''; return; }
  el.hidden = false;
  el.innerHTML = `${esc(text)}${details.length
    ? `<ul class="sa-detail">${details.map((d) => `<li>${esc(d)}</li>`).join('')}</ul>`
    : ''}`;
}

function showResult(result) {
  setStatus(result?.message || (result?.ok ? '完成' : '失败'), result?.ok ? 'ok' : 'err');
  if (Array.isArray(result?.details) && result.details.length) {
    showProgress(result.message || '', { details: result.details.map((d) => `${d.ok ? '✓' : '✗'} ${d.name || ''} ${d.message || ''}`) });
  }
}

function flashAsk(text) {
  const el = root?.querySelector('#sa-ask-flash');
  if (!el) return;
  el.textContent = text;
  setTimeout(() => { if (el.isConnected) el.textContent = ''; }, 2500);
}

function setStatus(text, kind = '') {
  const el = root?.querySelector('#sa-status');
  if (!el) return;
  el.textContent = text;
  el.className = `hint ${kind === 'err' ? 'sa-err' : kind === 'warn' ? 'sa-warn' : 'sa-ok'}`;
}

/** 操作进行中：把卡片按钮压灰，避免点出并发提交（pending 只有一个槽位）。 */
function markBusy(on) {
  const grid = root?.querySelector('#sa-grid');
  if (!grid) return;
  for (const card of grid.querySelectorAll('.sa-card')) card.classList.toggle('busy', on);
  const add = grid.querySelector('#sa-add-cell');
  if (add) add.disabled = on || pluginOff();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
