// 角色卡「可用工具」区与 api.tools 白名单联动。
// 2026-09-24：工具说明改由工具 schema 提供，角色卡不再重复写几十行长附录。
import { getConfig } from './config.js';

export const ROLE_TOOLS_START = '<!--tools:start-->';
export const ROLE_TOOLS_END = '<!--tools:end-->';

/** 兼容旧数据：以前写入角色卡的工具指南不再回填，启动/保存时统一清掉。 */
export const TOOL_ROLE_GUIDES = {};

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function stripToolSection(text) {
  let out = String(text ?? '');
  const marked = new RegExp(
    `^[ \t]*(?:##[^\n]*可用工具[^\n]*\n)?[ \t]*${escapeRe(ROLE_TOOLS_START)}[\\s\\S]*?${escapeRe(ROLE_TOOLS_END)}[ \t]*\n?`,
    'm'
  );
  out = out.replace(marked, '');
  // 标记丢失时只删除「可用工具」这一节，绝不越过下一个同级标题。
  const heading = /^##[ \t]*可用工具[^\n]*\n[\s\S]*?(?=^##[ \t]|$(?![\s\S]))/m;
  out = out.replace(heading, '');
  return out.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
}

/**
 * 清理旧工具区，不再向角色卡追加工具说明。
 * @param {string} roleText 现有角色卡
 * @returns {string} 新的角色卡
 */
export function syncRoleToolsSection(roleText) {
  return stripToolSection(roleText);
}

/** 工具说明由 tool schema 承担，角色卡不再参与对账。 */
export function toolGuideDrift() {
  return [];
}

/**
 * 保存配置时若带了旧工具区，顺手清理。
 * @returns {{ roleText?: string, changed: boolean }}
 */
export function syncRoleToolsFromConfig(patch, opts = {}) {
  if (!patch || typeof patch !== 'object') return { changed: false };
  const base = String(
    opts.currentRoleText
    ?? patch.persona?.roleText
    ?? getConfig().persona?.roleText
    ?? ''
  );
  const nextRole = syncRoleToolsSection(base);
  if (nextRole === base) return { changed: false };
  return { roleText: nextRole, changed: true };
}
