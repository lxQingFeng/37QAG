import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildForwardCallAttempts,
  buildForwardSendCalls,
  fetchForwardNodes,
  forwardIdsFromMessage,
  normalizeGetMsgParams,
  onebotErrorDetail
} from '../src/onebot.js';

test('合并转发优先使用 forward 段 ID，并保留负 message_id 兜底', () => {
  const segments = [{ type: 'forward', data: { res_id: 'forward-77' } }];
  assert.deepEqual(forwardIdsFromMessage({ message: segments }), ['forward-77']);
  assert.deepEqual(
    buildForwardCallAttempts({ messageId: -1000000001, segments }),
    [
      { action: 'get_forward_msg', params: { id: 'forward-77' } },
      { action: 'get_forward_msg', params: { message_id: 'forward-77' } },
      { action: 'get_forward_msg', params: { id: '-1000000001' } },
      { action: 'get_forward_msg', params: { message_id: '-1000000001' } }
    ]
  );
});

test('空 payload 会尝试下一种参数', async () => {
  const calls = [];
  const onebot = {
    async call(action, params) {
      calls.push({ action, params });
      return calls.length === 1 ? { messages: [] } : { messages: [{ message: [] }] };
    },
    async getMsg() { throw new Error('不应在拿到节点后继续查询'); }
  };
  const result = await fetchForwardNodes(onebot, {
    messageId: -123,
    segments: [{ type: 'forward', data: { id: 'abc' } }]
  });
  assert.equal(result.nodes.length, 1);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].params, { id: 'abc' });
  assert.deepEqual(calls[1].params, { message_id: 'abc' });
});

test('首轮失败后从 get_msg 找回 forward 段再展开', async () => {
  const calls = [];
  const onebot = {
    async call(action, params) {
      calls.push({ action, params });
      if (action === 'get_msg') return {
        message: [{ type: 'forward', data: { forward_id: 'recovered' } }]
      };
      return params.id === 'recovered'
        ? { messages: [{ sender: { nickname: 'A' }, message: [] }] }
        : { messages: [] };
    }
  };
  const result = await fetchForwardNodes(onebot, { messageId: -456 });
  assert.equal(result.nodes.length, 1);
  assert.ok(calls.some((call) => call.action === 'get_msg' && call.params.message_id === -456));
  assert.ok(calls.some((call) => call.action === 'get_forward_msg' && call.params.id === 'recovered'));
});

test('SnowLuma v1.14.19 的合并转发读取参数一律使用字符串', () => {
  const attempts = buildForwardCallAttempts({ messageId: 12345 });
  assert.deepEqual(attempts, [
    { action: 'get_forward_msg', params: { id: '12345' } },
    { action: 'get_forward_msg', params: { message_id: '12345' } }
  ]);
  assert.ok(attempts.every((call) => typeof call.params.id === 'string' || typeof call.params.message_id === 'string'));
});

test('get_msg 严格保留合法负数，并拒绝空值、零和小数', () => {
  assert.deepEqual(normalizeGetMsgParams(-1000000001), { message_id: -1000000001 });
  assert.throws(() => normalizeGetMsgParams(''), /非零整数/);
  assert.throws(() => normalizeGetMsgParams(0), /非零整数/);
  assert.throws(() => normalizeGetMsgParams('12.5'), /非零整数/);
});

test('合并转发发送优先使用 v1.14.19 统一接口并保留专用接口回退', () => {
  const messages = [{ type: 'node', data: { name: 'A', uin: '1', content: 'hi' } }];
  assert.deepEqual(buildForwardSendCalls('group', 123, messages), [
    {
      action: 'send_forward_msg',
      params: { message_type: 'group', group_id: 123, messages }
    },
    { action: 'send_group_forward_msg', params: { group_id: 123, messages } }
  ]);
  assert.deepEqual(buildForwardSendCalls('private', 456, messages), [
    {
      action: 'send_forward_msg',
      params: { message_type: 'private', user_id: 456, messages }
    },
    { action: 'send_private_forward_msg', params: { user_id: 456, messages } }
  ]);
});

test('OneBot 错误会合并展示 SnowLuma 的 message/wording 字段', () => {
  assert.equal(
    onebotErrorDetail({ message: 'params.message_id must be string', wording: '参数不合法', data: {} }),
    'params.message_id must be string / 参数不合法'
  );
  assert.equal(onebotErrorDetail({ data: { msg: 'forward payload is empty' } }), 'forward payload is empty');
});
