import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMessageList } from '../src/util.js';

test('普通 JSON 数组和字符串数组正常解析', () => {
  assert.deepEqual(normalizeMessageList('["第一句","第二句"]'), ['第一句', '第二句']);
  assert.deepEqual(normalizeMessageList(['第一句', { type: 'text', text: '第二句' }]), ['第一句', '第二句']);
});

test('坏掉的数组尾巴不会把正文当成工具碎片丢掉', () => {
  assert.deepEqual(
    normalizeMessageList('["那不行 名字磨没了我找谁吵架去"}'),
    ['那不行 名字磨没了我找谁吵架去']
  );
  assert.deepEqual(
    normalizeMessageList('["那不行 名字磨没了我找谁吵架去"]]}'),
    ['那不行 名字磨没了我找谁吵架去']
  );
});

test('messages 字符串外壳可恢复嵌套正文', () => {
  assert.deepEqual(
    normalizeMessageList('{"messages":"[\\"那不行 名字磨没了我找谁吵架去\\"}"}'),
    ['那不行 名字磨没了我找谁吵架去']
  );
  assert.deepEqual(
    normalizeMessageList('{"messages":"[\\"今天天气不错\\"}"}'),
    ['今天天气不错']
  );
});

test('内容块抽正文，工具参数不当正文', () => {
  assert.deepEqual(
    normalizeMessageList('[{"type":"text","text":"你好"},{"type":"text","text":"世界"}]'),
    ['你好', '世界']
  );
  const toolish = normalizeMessageList('{"messages":"[\\"真正要说的话\\"}", "replyToMessageId": "12345", "tool": "send_message"}');
  assert.deepEqual(toolish, ['真正要说的话']);
  assert.equal(normalizeMessageList('{"messages":"[]"}').length, 0);
});
