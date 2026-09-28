import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWrappedSkillTool,
  groupSkillToolDefs,
  stripSchemaDescriptions
} from '../src/skill-bridge.js';

function makeSkillTools(count, skillId) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${skillId}_action_${String(index + 1).padStart(3, '0')}`,
    skillId,
    name: `动作 ${index + 1}`,
    description: `${skillId} 的第 ${index + 1} 个动作。这里保留足够长的社区插件说明，用来验证合并后不会把 114 份参数说明原样塞给模型。`,
    category: 'system',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '这个字段的说明非常长：请输入要处理的查询内容，并确保符合插件当前版本定义的完整业务语义与边界。'
        },
        options: {
          type: 'object',
          description: '可选配置对象说明也会递归清理。',
          properties: {
            strict: {
              type: 'boolean',
              description: '严格模式说明同样不需要出现在最终工具参数结构里。'
            }
          }
        }
      },
      required: ['query']
    },
    execute: async (ctx, args) => ({ content: JSON.stringify({ action: `${skillId}_action_${String(index + 1).padStart(3, '0')}`, args }) })
  }));
}

test('114 个工具合并成一个 action+args 包装工具', () => {
  const tools = makeSkillTools(114, 'tool-suite');
  const groups = groupSkillToolDefs(tools);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].wrapped, true);

  const wrapped = buildWrappedSkillTool(groups[0]);
  assert.equal(wrapped.name, 'use_tool_suite');
  assert.equal(wrapped.parameters.properties.action.enum.length, 114);
  assert.equal(wrapped.parameters.required[0], 'action');

  const rawSchemaSize = JSON.stringify(tools.map((tool) => ({
    name: tool.id,
    description: tool.description,
    parameters: tool.parameters
  }))).length;
  const wrappedSize = JSON.stringify({
    name: wrapped.name,
    description: wrapped.description,
    parameters: wrapped.parameters
  }).length;
  assert.ok(wrappedSize < rawSchemaSize * 0.45, `${wrappedSize} should be much smaller than ${rawSchemaSize}`);
});

test('包装动作能正确展开并映射回原工具', async () => {
  const tools = makeSkillTools(4, 'sleep-mood');
  const wrapped = buildWrappedSkillTool(groupSkillToolDefs(tools)[0]);
  const result = await wrapped.execute({}, {
    action: 'sleep-mood_action_003',
    args: { query: '昨晚睡得怎么样', options: { strict: true } }
  });
  assert.equal(result.isError, undefined);
  assert.deepEqual(JSON.parse(result.content), {
    action: 'sleep-mood_action_003',
    args: { query: '昨晚睡得怎么样', options: { strict: true } }
  });

  const unknown = await wrapped.execute({}, { action: 'missing', args: {} });
  assert.equal(unknown.isError, true);
});

test('非包装插件参数递归清理说明但保留结构和枚举', () => {
  const schema = {
    type: 'object',
    description: '顶层说明',
    properties: {
      mode: { type: 'string', enum: ['a', 'b'], description: '模式说明' },
      nested: {
        type: 'object',
        description: '嵌套说明',
        properties: { enabled: { type: 'boolean', description: '开关说明' } }
      }
    },
    required: ['mode']
  };
  const cleaned = stripSchemaDescriptions(schema);
  assert.equal(JSON.stringify(cleaned).includes('说明'), false);
  assert.deepEqual(cleaned.properties.mode.enum, ['a', 'b']);
  assert.equal(cleaned.properties.nested.properties.enabled.type, 'boolean');
  assert.deepEqual(cleaned.required, ['mode']);
});
