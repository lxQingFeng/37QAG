// 扩展底座桥接：在 0.2 架构上接 skills/plugins，不换核心。
// plugin-loader 懒加载：tools.js 引本文件时不会立刻拖进 500 行加载器。

import { skillManager } from './skills/manager.js';
import { listTools as listSkillTools } from './tool-registry.js';
import { setSkillConfig, isSkillEnabledInConfig } from './skills/config.js';

export { skillManager };

let loadedOnce = false;
let pluginLoader = null;
const WRAP_THRESHOLD = 4;
const WRAPPED_BY_SKILL = new Map();

async function ensureLoader() {
  if (!pluginLoader) {
    pluginLoader = await import('./plugin-loader.js');
  }
  return pluginLoader;
}

/**
 * 启动时扫 skills/ + plugins/。幂等。
 */
export async function initExtensions({ log = console.log, context = null } = {}) {
  try {
    const { loadPlugins } = await ensureLoader();
    const result = await loadPlugins({ log });
    const ctx = typeof context === 'function' ? (context() || {}) : (context || {});
    for (const s of skillManager.registry.list()) {
      const id = s.manifest?.id;
      if (!id) continue;
      if (isSkillEnabledInConfig(id, s.manifest?.enabledByDefault !== false)) {
        try { skillManager.activate(id, ctx); } catch (e) {
          log(`[skill] activate ${id} 失败:`, e?.message ?? e);
        }
      }
    }
    loadedOnce = true;
    return result;
  } catch (e) {
    log('[skill] 加载扩展底座失败（主流程继续）:', e?.message ?? e);
    return { loaded: [], failed: [] };
  }
}

export async function startExtensionWatch({ log = console.log } = {}) {
  try {
    const { watchPlugins } = await ensureLoader();
    return watchPlugins({ log });
  } catch {
    return null;
  }
}

export function setExtensionEnabled(id, enabled, context = {}) {
  setSkillConfig(id, { enabled: !!enabled });
  try {
    if (enabled) skillManager.activate(id, context);
    else skillManager.deactivate(id, context);
  } catch { /* 生命周期失败不阻塞开关 */ }
  return skillManager.status(id, context);
}

/** 递归删除 schema 里的长说明，保留类型、结构、枚举和必填信息。 */
export function stripSchemaDescriptions(schema) {
  if (Array.isArray(schema)) return schema.map(stripSchemaDescriptions);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [key, value] of Object.entries(schema)) {
    if (key === 'description') continue;
    out[key] = stripSchemaDescriptions(value);
  }
  return out;
}

function compactText(value, max = 80) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

function parameterSignature(schema) {
  const props = schema?.properties && typeof schema.properties === 'object'
    ? Object.keys(schema.properties)
    : [];
  const required = new Set(Array.isArray(schema?.required) ? schema.required : []);
  if (!props.length) return '()';
  return `(${props.map((name) => `${required.has(name) ? '' : '?'}${name}`).join(', ')})`;
}

/**
 * 纯函数：按 Skill 分组。超过 3 个工具的组返回需合并组。
 * 输入的工具项至少要有 { id, skillId, description, parameters, execute }。
 */
export function groupSkillToolDefs(tools = [], threshold = WRAP_THRESHOLD) {
  const groups = new Map();
  for (const tool of tools) {
    const skillId = String(tool?.skillId || '').trim();
    if (!skillId) continue;
    if (!groups.has(skillId)) groups.set(skillId, []);
    groups.get(skillId).push(tool);
  }
  return [...groups]
    .map(([skillId, items]) => ({
      skillId,
      tools: items,
      wrapped: items.length >= Math.max(2, Number(threshold) || WRAP_THRESHOLD)
    }))
    .sort((a, b) => a.skillId.localeCompare(b.skillId));
}

function wrapperName(skillId) {
  const clean = String(skillId).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
  return `use_${clean || 'skill'}`.slice(0, 64);
}

/**
 * 纯函数：把一个 Skill 的多个工具合并成 action+args 包装工具。
 * 执行时按 action 映射回原工具。
 */
export function buildWrappedSkillTool(group) {
  const items = Array.isArray(group?.tools) ? group.tools : [];
  const byAction = new Map(items.map((tool) => [String(tool.id), tool]));
  const actionLines = items.map((tool) =>
    `- ${tool.id}${parameterSignature(tool.parameters)}：${compactText(tool.description)}`
  );
  const name = wrapperName(group?.skillId || 'skill');
  return {
    name,
    description: [
      `「${group?.skillId || 'skill'}」插件动作入口。先选 action，再把该动作的参数放进 args。`,
      '动作：',
      ...actionLines
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: items.map((tool) => String(tool.id)),
          description: '要执行的插件动作'
        },
        args: {
          type: 'object',
          additionalProperties: true,
          description: '该 action 的参数对象；没有参数就传 {}'
        }
      },
      required: ['action'],
      additionalProperties: false
    },
    category: 'system',
    skillId: group?.skillId || null,
    wrappedSkill: true,
    execute: async (ctx, args = {}) => {
      const action = String(args?.action ?? '');
      const tool = byAction.get(action);
      if (!tool) {
        return {
          content: `未知的 ${group?.skillId || 'skill'} 动作：${action || '空'}。可选：${items.map((x) => x.id).join('、')}`,
          isError: true
        };
      }
      const top = { ...args };
      delete top.action;
      delete top.args;
      const nested = args?.args && typeof args.args === 'object' && !Array.isArray(args.args) ? args.args : {};
      return tool.execute(ctx, { ...top, ...nested });
    }
  };
}

/** 把 Skill 注册的工具并进核心 toolDefs；大工具组自动压缩成一个包装工具。 */
export function mergeSkillTools(coreDefs = []) {
  if (!loadedOnce) return coreDefs;
  const list = listSkillTools();
  if (!list.length) return coreDefs;
  const out = [...coreDefs];
  const have = new Set(coreDefs.map((d) => d.name));
  const active = list.filter((tool) => skillManager.isActive(tool.skillId, {}).active);
  for (const group of groupSkillToolDefs(active)) {
    if (group.wrapped) {
      const wrapped = buildWrappedSkillTool(group);
      if (!have.has(wrapped.name)) {
        out.push(wrapped);
        have.add(wrapped.name);
        WRAPPED_BY_SKILL.set(group.skillId, wrapped.name);
      }
      continue;
    }
    for (const tool of group.tools) {
      if (have.has(tool.id)) continue;
      out.push({
        name: tool.id,
        description: tool.description,
        parameters: stripSchemaDescriptions(tool.parameters || { type: 'object', properties: {} }),
        category: tool.category || 'system',
        skillId: tool.skillId || null,
        execute: async (ctx, args) => tool.execute(ctx, args)
      });
      have.add(tool.id);
    }
  }
  return out;
}

async function safeHook(name, payload) {
  if (!loadedOnce) return [];
  try {
    return await skillManager.runHook(name, payload);
  } catch (e) {
    try { skillManager.recordError(name, e); } catch { /* ignore */ }
    return [];
  }
}

export async function hookBeforeContext(payload) {
  await safeHook('before-context', payload);
}

export async function hookBeforeLlmMessages(payload) {
  await safeHook('before-llm-messages', payload);
}

export async function hookAfterResponse(payload) {
  await safeHook('after-response', payload);
}

export async function hookBeforeTool(payload) {
  const results = await safeHook('before-tool', payload);
  for (const r of results) {
    const v = r?.value;
    if (v && typeof v === 'object' && v.block) return v;
  }
  return undefined;
}

export async function hookAfterTool(payload) {
  await safeHook('after-tool', payload);
}

export function listExtensionStatus(context = {}) {
  return skillManager.list(context);
}

/** 扩展提示词片段（system 尾部可选注入）。 */
export function getExtensionPromptSections(context = {}) {
  try {
    return skillManager.getPromptSections(context);
  } catch {
    return [];
  }
}
