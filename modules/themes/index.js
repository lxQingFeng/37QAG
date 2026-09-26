// 自定义主题模块入口（阶段二模块化）。
// impl.js 是 src/themes.js 平移实现（升级为双层目录：内置 themes/ + 用户 data/themes/）；
// 这一层把原 app.js 的三条 /api/themes* 路由接管为模块路由（行为逐字段对齐）。
import { listThemes, importTheme, getThemeById, migrateUserThemesOut } from './impl.js';
import { getConfig as globalGetConfig, updateConfig as globalUpdateConfig } from '../../src/config.js';

/** @param {import('../../src/module-registry.js').ModuleApi} api */
export async function setup(api) {
  // 阶段二迁移：历史用户主题从内置 themes/ 搬到 data/themes/（幂等）
  const moves = migrateUserThemesOut();
  if (moves.length) api.log(`用户主题已迁移：${moves.join('、')}`);

  api.registerRoute({
    method: 'GET',
    pattern: '/api/themes',
    handler: async (req, res, { json }) => json(res, 200, {
      ok: true,
      dir: 'data/themes（用户）+ themes（内置）',
      current: globalGetConfig().ui?.customThemeId || '',
      formatDoc: 'themes/THEME_FORMAT.txt',
      themes: listThemes()
    })
  });

  api.registerRoute({
    method: 'POST',
    pattern: '/api/themes/import',
    handler: async (req, res, { json, readBody }) => {
      const body = await readBody(req).catch(() => ({}));
      try {
        const th = importTheme(String(body?.content || ''), { filename: String(body?.filename || '') });
        // 导入即应用：写全局 ui 配色 + custom 主题 + 主题 id
        // （⚠️ 不能用 api.config——那是模块私有段 config.modules.themes；这里必须写全局 ui）
        globalUpdateConfig({
          ui: {
            ...(globalGetConfig().ui || {}),
            theme: 'custom',
            customThemeId: th.id,
            customBg: th.colors.bg || '',
            customBg2: th.colors.bg2 || '',
            customAccent: th.colors.accent || '',
            customText: th.colors.text || '',
            customToolAccent: th.colors.toolAccent || th.colors.accent || ''
          }
        });
        return json(res, 200, { ok: true, theme: th });
      } catch (error) {
        return json(res, 400, { ok: false, error: String(error?.message || error) });
      }
    }
  });

  api.registerRoute({
    method: 'POST',
    pattern: '/api/themes/apply',
    handler: async (req, res, { json, readBody }) => {
      const body = await readBody(req).catch(() => ({}));
      const id = String(body?.id || '').trim();
      const th = getThemeById(id);
      if (!th) return json(res, 404, { ok: false, error: '找不到主题：' + id });
      globalUpdateConfig({
        ui: {
          ...(globalGetConfig().ui || {}),
          theme: 'custom',
          customThemeId: th.id,
          customBg: th.colors.bg || '',
          customBg2: th.colors.bg2 || '',
          customAccent: th.colors.accent || '',
          customText: th.colors.text || '',
          customToolAccent: th.colors.toolAccent || th.colors.accent || ''
        }
      });
      return json(res, 200, { ok: true, theme: th });
    }
  });

  api.log('已就绪（双层主题目录；路由 GET /api/themes、POST /api/themes/import|apply）');
}

export async function dispose(api) {
  // 主题模块无后台任务，路由与事件由注册表统一回收
}

export function status() {
  return { themes: listThemes().length };
}
