// 免费 API 情报模块入口（阶段二模块化）。
// impl.js 是 src/api-news.js 平移实现（零逻辑改动）；
// 这一层负责生命周期 + 把原 app.js 的两条 /api/api-news 路由接管为模块路由。
// 路由行为与原核心实现逐字段对齐（含 ?force=1 与 500 语义）。
import { startApiNewsScheduler, stopApiNewsScheduler, getApiNews, refreshApiNews, apiNewsStatus } from './impl.js';

/** @param {import('../../src/module-registry.js').ModuleApi} api */
export async function setup(api) {
  startApiNewsScheduler();

  api.registerRoute({
    method: 'GET',
    pattern: '/api/api-news',
    handler: async (req, res, { json, url }) => {
      try {
        const force = url.searchParams.get('force') === '1';
        const data = await getApiNews({ force });
        return json(res, 200, { ...data, status: apiNewsStatus() });
      } catch (error) {
        return json(res, 200, { ok: false, error: String(error?.message ?? error), items: [] });
      }
    }
  });

  api.registerRoute({
    method: 'POST',
    pattern: '/api/api-news',
    handler: async (req, res, { json }) => {
      try {
        const data = await refreshApiNews();
        return json(res, data.ok === false ? 500 : 200, { ...data, status: apiNewsStatus() });
      } catch (error) {
        return json(res, 500, { ok: false, error: String(error?.message ?? error), items: [] });
      }
    }
  });

  api.log('已启动（每天 04:00 自动刷新；路由 GET/POST /api/api-news）');
}

export async function dispose(api) {
  stopApiNewsScheduler();
}

export function status() {
  return apiNewsStatus();
}
