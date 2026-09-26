// 内置功能模块加载器（阶段二改造）：modules/ 目录扫描 + setup(api) + dispose + 热重载。
//
// 与 plugin-loader（skills/plugins 双轨）的关系：
//   · plugin-loader 面向**用户可装卸的扩展**（skills = LLM 型，plugins = 确定型）；
//   · 本加载器面向**随程序分发的内置功能模块**（crazy-thursday / api-news / themes …），
//     生命周期跟随 app（start → setup，stop → dispose），同样具备热重载。
//   两套加载器共享：module-registry 的组件注册表、paths 层、event-bus。
//   长期方向（阶段三）：插件与模块进一步收敛到同一注册面，见 docs/阶段二改造说明.md。
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getConfig } from './config.js';
import { modulesDir, createModuleApi, disposeModuleComponents } from './module-registry.js';
import { emit as emitBus } from './event-bus.js';

const loaded = new Map();    // moduleId → { mod, manifest, dir, api, dispose }
let watcher = null;
let reloadTimer = null;
const signatures = new Map();  // moduleId → 源码签名（热重载去抖：签名不变不重载）

function log(...args) { console.log('[modules]', ...args); }

function readManifest(dir) {
  const p = path.join(dir, 'module.json');
  if (!fs.existsSync(p)) return null;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const text = raw.charCodeAt(0) === 0xFEFF ? raw.slice(1) : raw;
    const m = JSON.parse(text);
    if (!m || typeof m.id !== 'string' || !m.id) return null;
    return m;
  } catch { return null; }
}

function isEnabled(manifest) {
  // 关闭开关：config.modules.<id>.enabled === false 或 manifest.enabled === false
  if (manifest.enabled === false) return false;
  const cfg = getConfig().modules?.[manifest.id];
  return !(cfg && cfg.enabled === false);
}

async function signatureOf(dir) {
  try {
    let acc = '';
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js') && !f.endsWith('.json')) continue;
      acc += f + ':' + fs.statSync(path.join(dir, f)).size + ':' + fs.statSync(path.join(dir, f)).mtimeMs + ';';
    }
    return acc;
  } catch { return String(Math.random()); }
}

/** 加载一个模块目录（幂等：已加载的先卸再装 = 热重载）。 */
async function loadModule(dir, context) {
  const manifest = readManifest(dir);
  if (!manifest) { log(`跳过 ${path.basename(dir)}：缺 module.json 或清单不合法`); return null; }
  const id = manifest.id;

  // 幂等卸载
  if (loaded.has(id)) await unloadModule(id, { silent: true });

  const entryPoint = manifest.entry || 'index.js';
  const entryPath = path.join(dir, entryPoint);
  if (!fs.existsSync(entryPath)) { log(`跳过 ${id}：入口 ${entryPoint} 不存在`); return null; }

  try {
    const mod = await import(pathToFileURL(entryPath).href);
    if (typeof mod.setup !== 'function') { log(`跳过 ${id}：入口未导出 setup(api)`); return null; }
    const api = createModuleApi(id, context);
    await mod.setup(api);
    loaded.set(id, { mod, manifest, dir, api, dispose: typeof mod.dispose === 'function' ? mod.dispose : null });
    signatures.set(id, await signatureOf(dir));
    emitBus('module.loaded', { id, name: manifest.name || id, version: manifest.version || '0.0.0' });
    return id;
  } catch (error) {
    log(`加载 ${id} 失败：${error?.stack || error}`);
    return null;
  }
}

async function unloadModule(id, { silent = false } = {}) {
  const entry = loaded.get(id);
  if (!entry) return false;
  try {
    if (entry.dispose) await entry.dispose(entry.api);
  } catch (error) {
    if (!silent) log(`dispose ${id} 失败：${error?.message ?? error}`);
  }
  disposeModuleComponents(id);   // 路由/事件/工具批量回收
  loaded.delete(id);
  signatures.delete(id);
  emitBus('module.unloaded', { id });
  return true;
}

/**
 * 扫描并加载 modules/ 下全部模块。
 * @param {{ log?: Function, context?: object }} opts
 * @returns {{ loaded: string[], failed: string[] }}
 */
export async function loadModules({ log: extLog = null, context = {} } = {}) {
  const out = { loaded: [], failed: [] };
  const root = modulesDir();
  if (typeof extLog === 'function') log = extLog;   // app.js 传自己的 log
  let dirs = [];
  try { dirs = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(root, d.name)); } catch { return out; }
  for (const dir of dirs.sort()) {
    const manifest = readManifest(dir);
    if (!manifest) { out.failed.push(path.basename(dir)); continue; }
    if (!isEnabled(manifest)) { log(`模块 ${manifest.id} 已按配置停用`); continue; }
    const id = await loadModule(dir, context);
    if (id) out.loaded.push(id); else out.failed.push(manifest.id);
  }
  return out;
}

/** 卸载全部模块（app.stop 用）。 */
export async function disposeModules({ log: extLog = null } = {}) {
  for (const id of [...loaded.keys()]) await unloadModule(id);
}

/** 模块状态（/api/status 用）。 */
export function moduleStatus() {
  return [...loaded.values()].map(({ manifest, dir }) => ({
    id: manifest.id,
    name: manifest.name || manifest.id,
    version: manifest.version || '0.0.0',
    description: manifest.description || '',
    dir: path.relative(process.cwd(), dir),
    loaded: true,
    ok: true
  }));
}

/** 热重载：watch modules/，改动去抖 500ms，签名变化才重载。 */
export function watchModules({ log: extLog = null, onReload = null } = {}) {
  if (watcher) return watcher;
  const root = modulesDir();
  if (typeof extLog === 'function') log = extLog;
  try {
    watcher = fs.watch(root, { recursive: true }, (_e, filename) => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => {
        reloadTimer = null;
        (async () => {
          let dir = path.dirname(path.join(root, String(filename || '')));
          // 找到包含 module.json 的祖先（modules/<id>/ 或更深子目录改动）
          let guard = 0;
          while (dir && dir.startsWith(root) && !fs.existsSync(path.join(dir, 'module.json')) && guard++ < 5) {
            dir = path.dirname(dir);
          }
          if (!dir || !fs.existsSync(path.join(dir, 'module.json'))) return;
          const manifest = readManifest(dir);
          if (!manifest) return;
          const nextSig = await signatureOf(dir);
          if (signatures.get(manifest.id) === nextSig) return;   // 签名没变（编辑器触碰）
          log(`热重载模块 ${manifest.id}…`);
          const ctx = loaded.get(manifest.id)?.api?.context || {};
          await loadModule(dir, ctx);
          if (typeof onReload === 'function') onReload(manifest.id);
        })().catch((e) => log(`热重载失败：${e?.message ?? e}`));
      }, 500);
    });
    log('模块热重载已启用（modules/）');
  } catch (error) {
    log(`无法监听 modules/：${error?.message ?? error}`);
  }
  return { close: () => { try { watcher?.close(); } catch { /* ignore */ } watcher = null; } };
}

// 测试钩子：直接暴露内部函数（不进稳定 API 面）
export const __internals = { loadModule, unloadModule, readManifest, isEnabled, signatures };
