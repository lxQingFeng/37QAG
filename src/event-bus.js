// 生命周期事件总线（阶段二改造）。
//
// 与 util.js 里 createEventBus（UI 刷新信号，SSE 推给前端）是**两条线**：
//   · util.createEventBus  → 面向前端界面的状态信号（chat-update / skills-updated …）
//   · 本模块              → 面向插件/模块的**核心生命周期**（LLM 调用前后、工具调用前后、
//                            消息发送前后、模块装卸）—— 让扩展能观察/审计/装饰核心行为，
//                            而不需要改核心源码（这正是「指令前置补丁」曾被迫改核心的根因）。
//
// 设计（借鉴 AstrBot EventType / RiyaBot events_manager 的注册表+权重模式，仅模式移植）：
//   · 事件名带点分层："llm.request.before"、"tool.call.after"、"message.sent"…
//   · 订阅者可带 weight（小→先执行，同权按注册顺序）；默认 100。
//   · 所有订阅者异常隔离：一个崩了不影响其他订阅者与核心主流程。
//   · emit 不等待（fire-and-forget）：热路径（收发消息、调模型）不为插件观察者买单。
//     需要同步结果的场景用 emitSync（它会等所有订阅者，且任何异常都吞掉只记日志）。
//   · once / off 支持完整；卸载模块时按 owner 批量退订（module-loader 用）。
//
// 事件目录（v1，对齐 AstrBot 事件最小集 + 37QAG 实际链路）：
//   llm.request.before   { provider, model, messageCount, toolsCount }
//   llm.request.after    { provider, model, ok, durationMs, usage?, error? }
//   tool.call.before     { name, chatKey, argsRaw }
//   tool.call.after      { name, chatKey, ok, durationMs, summary, error? }
//   message.before-send  { chatKey, segments, via }
//   message.sent         { chatKey, messageId, ok, error? }
//   module.loaded        { id, kind, version }
//   module.unloaded      { id, reason }
//   data.migrated        { moves }        // paths.migrateLegacyLayout 完成时
const consoleBridge = { log: (...a) => console.log('[events]', ...a) };

/** @type {Map<string, Array<{fn: Function, weight: number, owner: string|null, seq: number}>>} */
const listeners = new Map();
let seq = 0;

/** 规范事件名：小写、点分、每段非空。不合法的名字直接拒收（返回 false）。 */
function validName(name) {
  const n = String(name || '');
  return /^[a-z0-9]+(\.[a-z0-9-]+)+$/.test(n);
}

function listenersOf(name) {
  let list = listeners.get(name);
  if (!list) { list = []; listeners.set(name, list); }
  return list;
}

/**
 * 订阅一个生命周期事件。
 * @param {string} name 事件名（点分小写，如 "llm.request.after"）
 * @param {Function} fn 订阅者（同步或异步皆可）
 * @param {{ weight?: number, owner?: string, once?: boolean }} [opts]
 * @returns {Function} 退订函数（幂等）
 */
export function on(name, fn, opts = {}) {
  if (!validName(name)) throw new Error(`事件名不合法：${name}（应为小写点分，如 llm.request.after）`);
  if (typeof fn !== 'function') throw new Error('on() 的第二个参数必须是函数');
  const entry = { fn, weight: Number.isFinite(opts.weight) ? opts.weight : 100, owner: opts.owner || null, once: !!opts.once, seq: seq++ };
  const list = listenersOf(name);
  list.push(entry);
  list.sort((a, b) => (a.weight - b.weight) || (a.seq - b.seq));
  return () => off(name, fn);
}

/** 一次性订阅（触发一次后自动退订）。 */
export function once(name, fn, opts = {}) {
  return on(name, fn, { ...opts, once: true });
}

/** 退订（按函数引用精确匹配；同函数订阅多次则全部退订）。 */
export function off(name, fn) {
  const list = listeners.get(name);
  if (!list) return;
  for (let i = list.length - 1; i >= 0; i--) if (list[i].fn === fn) list.splice(i, 1);
  if (!list.length) listeners.delete(name);
}

/** 按 owner 批量退订（模块卸载时用；owner 为 null 的订阅者不动 —— 那是核心自己）。 */
export function offByOwner(owner) {
  let removed = 0;
  for (const [name, list] of listeners) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].owner === owner) { list.splice(i, 1); removed++; }
    }
    if (!list.length) listeners.delete(name);
  }
  return removed;
}

/** 事件总线已就绪（永远 true；导出是为了让测试与文档引用同一形状）。 */
export const LIFE_CYCLE_EVENTS = Object.freeze([
  'llm.request.before', 'llm.request.after',
  'tool.call.before', 'tool.call.after',
  'message.before-send', 'message.sent',
  'module.loaded', 'module.unloaded',
  'data.migrated'
]);

/**
 * 发布事件（不等待订阅者）。返回触发数量。
 * 所有订阅者异常被吞掉并打一行日志 —— 观察者绝不能把核心搞挂。
 */
export function emit(name, payload = {}) {
  const list = listeners.get(name);
  if (!list || !list.length) return 0;
  const snapshot = [...list];
  for (const entry of snapshot) {
    if (entry.once) off(name, entry.fn);
    Promise.resolve()
      .then(() => entry.fn(payload, { name, owner: entry.owner }))
      .catch((error) => consoleBridge.log(`[订阅者异常] ${name}: ${error?.message ?? error}`));
  }
  return snapshot.length;
}

/**
 * 发布事件并**等待**全部订阅者完成（同步收集结果）。返回触发数量。
 * 任何订阅者异常只记日志不中断 —— 与 emit 一致，只是等待。
 */
export async function emitSync(name, payload = {}) {
  const list = listeners.get(name);
  if (!list || !list.length) return 0;
  const snapshot = [...list];
  for (const entry of snapshot) {
    if (entry.once) off(name, entry.fn);
    try {
      await entry.fn(payload, { name, owner: entry.owner });
    } catch (error) {
      consoleBridge.log(`[订阅者异常] ${name}: ${error?.message ?? error}`);
    }
  }
  return snapshot.length;
}

/** 订阅者统计（测试/诊断）。 */
export function listenerStats() {
  const out = {};
  for (const [name, list] of listeners) out[name] = list.length;
  return out;
}

/** 清空（仅测试用）。 */
export function clearAll() {
  listeners.clear();
}
