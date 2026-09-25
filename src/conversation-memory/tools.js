// 模型工具定义：只在调用时才查长时（平常零成本）。
// 不自动塞进主工程 tools.js —— 接线时再 register。
//
// ⚠️ 2026-09-21 删掉两层记忆：`SensoryBuffer`（30s 感知缓冲）与 `WorkingMemory`（运行内工作集）
//   原来是**只写不读**的 —— 每条入站消息都塞进去，但 `sensory.recent/alive`、`working.render`、
//   `beginRun/endRun` 一个调用者都没有；它们的预期用途（"刚刚发生了什么"、"这次检索到什么"）
//   已经分别被消息存档与 tool result 覆盖。而且 `working` 是**跨会话单例**，真注进提示词会串会话。
//   留着只会让人以为"记忆系统有这几层"，其实是空转。
import { Consolidator } from './consolidator.js';
import { ArchiveReader } from './archive.js';

/**
 * @param {{ messagesDir: string, memoryRoot: string }} paths
 */
export function createConversationMemory(paths) {
  const consolidator = new Consolidator(paths);
  const archive = new ArchiveReader({ messagesDir: paths.messagesDir });

  return {
    consolidator,
    archive,

    /** 模型调用 memory_search。 */
    search(query, opts = {}) {
      return consolidator.search(query, opts);
    },

    /** 后台巩固（可定时）。 */
    consolidate(opts) {
      return consolidator.consolidateAll(opts);
    },

    /** 给主工程 tools.js 用的定义数组（薄封装）。 */
    buildToolDefs() {
      return [
        {
          name: 'memory_search',
          description:
            '在长期对话记忆里按关键词检索很久以前的聊天碎片（日块索引）。平常不要调用；只有当前上下文不够、需要回忆很久以前的事时才调。返回的是压缩碎片不是完整录像。',
          parameters: {
            type: 'object',
            properties: {
              query: { type: 'string', description: '关键词，中文即可，例如「生日 聚餐」' },
              chatKey: {
                type: 'string',
                description: '可选，限定 group:xxx / private:xxx；不填则全库'
              },
              limit: { type: 'integer', description: '返回块数，默认 5' }
            },
            required: ['query']
          },
          async execute(ctx, args) {
            try {
              const hits = consolidator.search(String(args.query ?? ''), {
                chatKey: args.chatKey || ctx.chatKey || null,
                limit: Math.min(12, Math.max(1, Number(args.limit) || 5)),
                maxSnippets: 5
              });
              if (!hits.length) {
                return {
                  content: [{ type: 'text', text: '没有命中长期记忆。可换关键词，或承认想不起来（不要编造）。' }]
                };
              }
              return {
                content: [{
                  type: 'text',
                  text: JSON.stringify({ ok: true, hits }, null, 1)
                }]
              };
            } catch (error) {
              return {
                isError: true,
                content: [{ type: 'text', text: String(error?.message ?? error) }]
              };
            }
          }
        },
        {
          name: 'memory_archive',
          description:
            '按天/时段打开完整聊天归档（原始存档切片，支持分页）。先 memory_search 命中后可用 day 调这一天；或 mode=list 看有哪些天。一次最多约 40 条，用 offset/nextOffset 往前翻。',
          parameters: {
            type: 'object',
            properties: {
              mode: { type: 'string', enum: ['list', 'day', 'range', 'count'], description: 'list=列天；day=某天；range=区间；count=统计词频' },
              chatKey: { type: 'string', description: 'group:xxx / private:xxx；不填用当前会话' },
              day: { type: 'string', description: 'YYYY-MM-DD，mode=day 必填' },
              dayFrom: { type: 'string', description: 'YYYY-MM-DD，mode=range' },
              dayTo: { type: 'string', description: 'YYYY-MM-DD，mode=range' },
              offset: { type: 'integer', description: '分页偏移，默认 0' },
              limit: { type: 'integer', description: '本页条数，默认 40' },
              query: { type: 'string', description: '可选：只保留含该词的行' }
            },
            required: ['mode']
          },
          async execute(ctx, args) {
            try {
              const chatKey = args.chatKey || ctx.chatKey;
              const mode = String(args.mode || 'list');
              if (mode === 'list') {
                const days = archive.listDays(chatKey, { limit: 30 });
                return {
                  content: [{
                    type: 'text',
                    text: JSON.stringify({
                      ok: true,
                      chatKey,
                      note: '按 day 调 memory_archive(mode=day, day=...) 读完整一天；用 offset 翻页。',
                      days
                    }, null, 1)
                  }]
                };
              }
              if (mode === 'count') {
                const counted = archive.count({
                  chatKey,
                  query: args.query,
                  day: args.day || null,
                  dayFrom: args.dayFrom || null,
                  dayTo: args.dayTo || null,
                  maxSamples: 8
                });
                return { content: [{ type: 'text', text: JSON.stringify(counted, null, 1) }] };
              }
              const result = archive.load({
                chatKey,
                day: args.day,
                dayFrom: args.dayFrom,
                dayTo: args.dayTo,
                offset: args.offset,
                limit: args.limit,
                query: args.query
              });
              return { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }] };
            } catch (error) {
              return {
                isError: true,
                content: [{ type: 'text', text: String(error?.message ?? error) }]
              };
            }
          }
        },
        {
          name: 'memory_status',
          description: '查看长期记忆索引状态（块数/词项数）。很少用。',
          parameters: { type: 'object', properties: {} },
          async execute() {
            const st = consolidator.stats();
            return {
              content: [{ type: 'text', text: JSON.stringify(st, null, 1) }]
            };
          }
        }
      ];
    }
  };
}
