import test from 'node:test';
import assert from 'node:assert/strict';
import { OneBotClient } from '../src/onebot.js';

function captureClient() {
  const client = new OneBotClient({
    wsUrl: 'ws://127.0.0.1:3001',
    httpUrl: 'http://127.0.0.1:3000'
  });
  const calls = [];
  client.sendSegments = async (kind, id, segments) => {
    calls.push({ kind, id, segments });
    return { message_id: 42 };
  };
  return { client, calls };
}

test('表情按 SnowLuma 动画表情发送，并带 300×300 显示尺寸建议', async () => {
  const { client, calls } = captureClient();
  await client.sendSticker('group', 123, 'base64://sticker', {
    replyToMessageId: '-77',
    atUserId: '456'
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    kind: 'group',
    id: 123,
    segments: [
      { type: 'reply', data: { id: '-77' } },
      { type: 'at', data: { qq: '456' } },
      {
        type: 'image',
        data: {
          file: 'base64://sticker',
          sub_type: 1,
          summary: '[动画表情]',
          width: 300,
          height: 300
        }
      }
    ]
  });
});

test('普通图片不带表情标记，引用和群聊 @ 逻辑保持不变', async () => {
  const { client, calls } = captureClient();
  await client.sendImage('group', 123, 'https://example.test/a.png', {
    replyToMessageId: '88',
    atUserId: '456'
  });

  assert.deepEqual(calls[0].segments, [
    { type: 'reply', data: { id: '88' } },
    { type: 'at', data: { qq: '456' } },
    { type: 'image', data: { file: 'https://example.test/a.png' } }
  ]);
});

test('私聊图片不生成 @ 段，显式尺寸元数据可由普通图片按需携带', async () => {
  const { client, calls } = captureClient();
  await client.sendImage('private', 456, 'C:\\cache\\image.png', {
    atUserId: '789',
    subType: 0,
    summary: '[图片]',
    width: 640,
    height: 480
  });

  assert.deepEqual(calls[0].segments, [
    {
      type: 'image',
      data: {
        file: 'C:\\cache\\image.png',
        sub_type: 0,
        summary: '[图片]',
        width: 640,
        height: 480
      }
    }
  ]);
});
