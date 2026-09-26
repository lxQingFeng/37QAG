// 阶段二回归：module-registry + module-loader + modules/ 真实装载。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const registry = await import('../src/module-registry.js');
const { registerRoute, matchRoute, unregisterRoutesByModule, listRoutes, disposeModuleComponents } = registry;

test('HTTP 路由注册与精确匹配', () => {
  registerRoute('test-mod', { method: 'GET', pattern: '/api/hello', handler: async () => 'hi' });
  const hit = matchRoute('GET', '/api/hello');
  assert.ok(hit && hit.moduleId === 'test-mod');
  assert.equal(typeof hit.handler, 'function');
  assert.equal(matchRoute('POST', '/api/hello'), null, '方法不匹配');
  assert.equal(matchRoute('GET', '/api/hello/extra'), null, '段数不匹配');
});

test('HTTP 路由参数段匹配（:id 形式）', () => {
  registerRoute('test-mod', { method: 'POST', pattern: '/api/items/:id/tag', handler: async () => 'ok' });
  const hit = matchRoute('POST', '/api/items/42/tag');
  assert.ok(hit);
  assert.deepEqual(hit.params, { id: '42' });
});

test('unregisterRoutesByModule 批量回收', () => {
  const before = listRoutes().length;
  unregisterRoutesByModule('test-mod');
  assert.equal(listRoutes().length, before - 2);
  assert.equal(matchRoute('GET', '/api/hello'), null);
});

test('disposeModuleComponents：路由+事件+工具全回收（无残余）', async () => {
  const bus = await import('../src/event-bus.js');
  bus.clearAll();
  registerRoute('disp-mod', { method: 'GET', pattern: '/api/disp', handler: async () => {} });
  bus.on('x.y', () => {}, { owner: 'disp-mod' });
  bus.on('x.y', () => {});   // 无 owner，不应被回收
  const result = disposeModuleComponents('disp-mod');
  assert.ok(result.routes >= 1);
  assert.equal(result.events, 1);
  assert.equal(matchRoute('GET', '/api/disp'), null);
  assert.equal(bus.listenerStats()['x.y'], 1, '核心订阅仍在');
});

test('modules/ 真实目录装载：四个模块 setup 成功并注册路由', async () => {
  const loader = await import('../src/module-loader.js');
  const { loadModules, moduleStatus, disposeModules } = loader;
  // themes 模块 setup 会迁移用户主题（对真实目录是 no-op）+ 注册三条路由 —— 安全
  // voice 模块默认关（voice.stt/tts.enabled=false）→ 只注册 status/test 路由 —— 安全
  await loadModules({ log: () => {}, context: {} });
  const status = moduleStatus();
  const ids = status.map((m) => m.id).sort();
  assert.deepEqual(ids, ['api-news', 'crazy-thursday', 'themes', 'voice'], `应装载四个内置模块，实际：${ids}`);

  // 模块路由已入表
  assert.ok(matchRoute('GET', '/api/themes'));
  assert.ok(matchRoute('GET', '/api/api-news'));
  assert.ok(matchRoute('POST', '/api/themes/import'));
  assert.ok(matchRoute('POST', '/api/themes/apply'));
  assert.ok(matchRoute('POST', '/api/api-news'));

  await disposeModules({ log: () => {} });
  // 卸载后路由回收
  assert.equal(matchRoute('GET', '/api/themes'), null);
  assert.equal(matchRoute('GET', '/api/api-news'), null);
});
