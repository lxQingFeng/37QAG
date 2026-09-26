
// ── [[command-gateway:manifest-normalizers]] 「指令前置」插件自动维护，不要手改这一段 ──
/**
 * 指令声明：告诉「指令前置」本插件提供哪些指令。
 *
 *   commands: [{
 *     id: 'weather',                   // 稳定标识（缺省 = word）；用户在设置页改词不影响它
 *     word: '天气',                     // 默认指令词（不含前缀）
 *     aliases: ['tq'],                 // 默认别名（可省略）
 *     capability: 'command.weather',   // 执行能力名；缺省 = command.<本插件 id>
 *     description: '查询城市天气',       // 帮助列表里的一句话
 *     argsHint: '[城市名]',             // 参数格式提示
 *     examples: ['/天气 珠海'],         // 示例（给人/AI 看）
 *     permission: 100,                 // 默认权限等级；缺省由前置用 1
 *     timeoutMs: 120000,               // 最长执行时间；缺省由前置用 30s
 *     passthrough: 'args'              // 执行后放行：original/prefix/args（缺省不放行，详见 8.3）
 *   }]
 *
 * 旧写法 `command: {…}`（单条）继续兼容，会被归一成只有一条的数组。
 * 能力名必须符合「小写点分」格式；写法不合法的**那一条**作废（不返回），
 * 而不是让整份清单失效 —— 一个插件多声明几条时，坏一条不该拖垮其它条。
 */
function normalizeCommands(raw, id) {
  const list = Array.isArray(raw?.commands)
    ? raw.commands
    : (raw?.command && typeof raw.command === 'object' && !Array.isArray(raw.command) ? [raw.command] : []);
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const one = normalizeCommand(item, id);
    if (!one) continue;
    if (seen.has(one.id)) continue;      // 同 id 只留第一条
    seen.add(one.id);
    out.push(one);
  }
  return out;
}

const CAPABILITY_RE = /^[a-z][a-z0-9]*(\.[a-z][a-z0-9-]*)+$/;

function normalizeCommand(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const capability = cleanString(raw.capability, id ? `command.${id}` : '');
  if (!capability || !CAPABILITY_RE.test(capability)) return null;
  const word = cleanString(raw.word, '');
  const timeoutMs = Number(raw.timeoutMs);
  const permission = Number(raw.permission);
  return {
    id: cleanString(raw.id, word) || capability,
    word,
    aliases: [...new Set(asArray(raw.aliases).map((x) => String(x).trim()).filter(Boolean))],
    capability,
    description: cleanString(raw.description, ''),
    argsHint: cleanString(raw.argsHint, ''),
    examples: asArray(raw.examples).map((x) => String(x).trim()).filter(Boolean).slice(0, 5),
    // 「执行后放行」声明（v4）：original/prefix/args 或 { mode, onFail } → 归一化；脏值 → null = 不放行
    passthrough: normalizePassthrough(raw.passthrough),
    // 0 = 没声明，由「指令前置」用自己的默认值（30 秒）
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000
      ? Math.min(600000, Math.round(timeoutMs))
      : 0,
    // 默认权限等级；null = 没声明，由「指令前置」用 1（0 是有效等级：所有人可用）
    permission: Number.isFinite(permission) && permission >= 0
      ? Math.min(100000, Math.round(permission))
      : null
  };
}

/**
 * 「执行后放行」声明（README 8.3 节）：指令执行完后把这条消息放回正常聊天流程。
 *   passthrough: "original" | "prefix" | "args" 或 { mode, onFail }
 * original = 按原文放行；prefix = 去前缀（模型看到「天气 珠海」）；args = 去指令词（模型看到「珠海」）。
 * onFail: "release" = 执行失败也放行；缺省 "skip" = 失败不放行。整体缺省 = null = 不放行。
 */
function normalizePassthrough(raw) {
  const obj = typeof raw === 'string'
    ? { mode: raw }
    : (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : null);
  const mode = String(obj?.mode ?? '').trim().toLowerCase();
  if (!['original', 'prefix', 'args'].includes(mode)) return null;
  const onFail = String(obj?.onFail ?? '').trim().toLowerCase() === 'release' ? 'release' : 'skip';
  return { mode, onFail };
}

/**
 * 消息入口拦截声明：本插件想在「消息进入会话之前」先看一眼（可以认领这条消息）。
 *
 *   intercept: { capability: 'message.privacy-mode', order: 10 }
 *
 * 由「指令前置」按 order 从小到大依次询问；谁先返回 { handled: true } 谁就独占这条消息，
 * 后面的拦截者不再被调用。order 缺省 100（指令前置自己是 50）。
 */
function normalizeIntercept(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const capability = cleanString(raw.capability, id ? `intercept.${id}` : '');
  if (!capability || !CAPABILITY_RE.test(capability)) return null;
  const order = Number(raw.order);
  return {
    capability,
    order: Number.isFinite(order) ? Math.round(order) : 100
  };
}

/**
 * 设置页分区声明：插件自带一块设置界面，由控制台挂载。
 *
 *   settingsUi: {
 *     id: 'command',              // 分区 id（分区键 = plugin:<插件id>:<id>）
 *     label: '指令前置',           // 侧栏上的名字；缺省用插件名
 *     file: 'settings-ui.js'      // 插件目录内的 ES 模块（缺省就是这个名字）
 *   }
 *
 * 模块由 `ui/app.js` 用 `import('/plugin-assets/<插件id>/<file>')` 加载，
 * 只允许该插件目录内的相对路径：带 `..`、绝对路径、盘符一律作废（返回 null），
 * 让插件在 UI 上表现为"没有自带设置页"，而不是加载一个来路不明的文件。
 */
function normalizeSettingsUi(raw, id) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const sectionId = cleanString(raw.id, 'main');
  if (!sectionId || !/^[a-z][a-z0-9-]*$/.test(sectionId)) return null;
  const file = cleanString(raw.file, 'settings-ui.js');
  if (!file || file.startsWith('/') || file.startsWith('\\') || /^[a-zA-Z]:/.test(file) || file.includes('..')) return null;
  return {
    id: sectionId,
    label: cleanString(raw.label, ''),
    file
  };
}

// ── [[/command-gateway:manifest-normalizers]] ──
