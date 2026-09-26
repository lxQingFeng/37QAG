// 统一组件注册表（阶段二改造）—— 模块/插件向核心注册组件的唯一入口。
//
// 参考 AstrBot「star 注册表 + filter」与 RiyaBot「统一组件注册表（四类组件）」的模式
//（仅模式移植，零代码复制），收敛到 37QAG 的轻量形态：
//
//   组件类型        注册方法                     分发方
//   ─────────────   ─────────────────────────   ─────────────────────────────
//   HTTP 路由       registerRoute()              app.js handleHttp（先查表后走核心 if 链）
//   生命周期事件    on() → event-bus.js          llm / tools / sender / module 装卸
//   LLM 工具        registerTool() → tool-registry.js   模型 function 列表
//   插件存储        storage() → createPluginStorage     data/plugin-data/<id>/
//   配置读写        config.get / config.update  config.js（UI 可见可改）
//
// 既有双轨（skills/ 的 registerTool + capabilities、plugins/ 的 providers/hooks）
// **继续原样工作**：这条注册表是给 modules/（内置功能模块）与下一代插件用的统一面，
// 不强行迁移旧资产 —— 迁移命令类插件时用 registerCommand（见下）接入会话前拦截链。
//
// 卸载语义：module-loader 在热重载/停用时按 moduleId 批量回收路由与事件订阅，
// 模块自己只需要（最好）提供 dispose()。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfig, updateConfig } from './config.js';
import { pluginDataDir, userThemesDir, builtinThemesDir, logsDir, dataRoot, ROOT } from './paths.js';
import { on as busOn, offByOwner as busOffByOwner } from './event-bus.js';
import { registerTool, unregisterToolsBySkill } from './tool-registry.js';
import { createPluginStorage } from './plugin-loader.js';

const MODULES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'modules');

// ── HTTP 路由表 ───────────────────────────────────────────────────────────
// key = `${method} ${pattern}`；pattern 支持冒号参数段（/api/x/:id）。
// 查表在 app.js 的核心 if 链之前 → 模块路由优先；未命中回落核心链（零破坏）。
const routes = new Map();          // key → { moduleId, method, pattern, segments, handler }
const routesByModule = new Map();  // moduleId → Set<key>

function compilePattern(pattern) {
  const segs = String(pattern || '').split('/').filter((s) => s !== '');
  return {
    segs,
    params: segs.map((s) => (s.startsWith(':') ? s.slice(1) : null))
  };
}

/** 注册一条 HTTP 路由（模块侧 API，一般不直接调，走 createModuleApi）。 */
export function registerRoute(moduleId, { method = 'GET', pattern, handler }) {
  if (typeof handler !== 'function') throw new Error('registerRoute: handler 必须是函数');
  const m = String(method || 'GET').toUpperCase();
  const p = String(pattern || '');
  if (!p.startsWith('/')) throw new Error('registerRoute: pattern 必须以 / 开头');
  const key = `${m} ${p}`;
  const compiled = compilePattern(p);
  routes.set(key, { moduleId, method: m, pattern: p, ...compiled, handler });
  if (!routesByModule.has(moduleId)) routesByModule.set(moduleId, new Set());
  routesByModule.get(moduleId).add(key);
  return key;
}

/** 匹配一条路由。返回 { handler, params, moduleId } 或 null。 */
export function matchRoute(method, pathname) {
  const m = String(method || 'GET').toUpperCase();
  const pathSegs = String(pathname || '').split('/').filter((s) => s !== '');
  for (const route of routes.values()) {
    if (route.method !== m) continue;
    if (route.segs.length !== pathSegs.length) continue;
    // 无参数段的快速路径：整串相等
    if (!route.params.some(Boolean)) {
      if (route.pattern === pathname) return { handler: route.handler, params: {}, moduleId: route.moduleId };
      continue;
    }
    const params = {};
    let ok = true;
    for (let i = 0; i < route.segs.length; i++) {
      if (route.params[i]) params[route.params[i]] = decodeURIComponent(pathSegs[i] || '');
      else if (route.segs[i] !== pathSegs[i]) { ok = false; break; }
    }
    if (ok) return { handler: route.handler, params, moduleId: route.moduleId };
  }
  return null;
}

/** 按模块批量注销路由。 */
export function unregisterRoutesByModule(moduleId) {
  const keys = routesByModule.get(moduleId);
  if (!keys) return 0;
  for (const k of keys) routes.delete(k);
  routesByModule.delete(moduleId);
  return keys.size;
}

/** 路由表快照（诊断/测试）。 */
export function listRoutes() {
  return [...routes.values()].map(({ moduleId, method, pattern }) => ({ moduleId, method, pattern }));
}

// ── 模块 API 工厂 ─────────────────────────────────────────────────────────

/**
 * 给一个模块造它自己的 api 对象（module-loader 调用；插件将来也走这里）。
 * context 由 app.js 注入核心句柄：{ sender, onebot, emit, log, ... }。
 */
export function createModuleApi(moduleId, context = {}) {
  const log = (...args) => console.log(`[module:${moduleId}]`, ...args);
  const warn = (...args) => console.warn(`[module:${moduleId}]`, ...args);
  const error = (...args) => console.error(`[module:${moduleId}]`, ...args);

  const api = {
    id: moduleId,

    // 日志
    log, warn, error,

    // HTTP 路由
    registerRoute: (def) => registerRoute(moduleId, def),

    // 生命周期事件（owner 登记为模块 id，卸载时批量退订）
    on: (event, fn, opts = {}) => busOn(event, fn, { ...opts, owner: moduleId }),
    once: (event, fn) => busOn(event, fn, { once: true, owner: moduleId }),

    // LLM 工具（转发 tool-registry；命名空间与 skills 一致由 def.id 决定）
    registerTool: (def) => registerTool({ ...def, skillId: moduleId, _plugin: moduleId }),
    unregisterTools: () => unregisterToolsBySkill(moduleId),

    // 插件存储：data/plugin-data/<moduleId>/
    storage: () => createPluginStorage(moduleId),

    // 配置代理（走核心 config，UI 设置页可见）
    config: {
      get: () => getConfig().modules?.[moduleId] || {},
      update: (patch) => updateConfig({ modules: { ...(getConfig().modules || {}), [moduleId]: { ...(getConfig().modules?.[moduleId] || {}), ...patch } } })
    },

    // 核心配置全文（只读）与数据路径
    globalConfig: () => getConfig(),
    paths: {
      dataRoot, logsDir, storageDir: () => pluginDataDir(moduleId),
      userThemesDir, builtinThemesDir, themeDirs: () => [userThemesDir(), builtinThemesDir()], root: () => ROOT
    },

    // 核心句柄（app.js 注入；模块按需取用，全部 ?. 软引用）
    context
  };
  return api;
}

/** 卸载一个模块注册过的全部组件（路由 + 事件 + 工具）。 */
export function disposeModuleComponents(moduleId) {
  const nRoutes = unregisterRoutesByModule(moduleId);
  const nEvents = busOffByOwner(moduleId);
  const nTools = (() => { try { return unregisterToolsBySkill(moduleId); } catch { return 0; } })();
  return { routes: nRoutes, events: nEvents, tools: nTools };
}

/** 模块目录（内置功能模块的根）。 */
export function modulesDir() { return MODULES_DIR; }
