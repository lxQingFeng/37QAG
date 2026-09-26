import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveReplyTargetSelf, isReplyTargetedToSelf } from '../src/util.js';

test('识别引用的是机器人自己的消息', () => {
  assert.equal(resolveReplyTargetSelf({ known: { self: true }, senderId: '10001', selfId: '10001' }), true);
  assert.equal(resolveReplyTargetSelf({ known: { self: false }, senderId: '10001', selfId: '10001' }), false);
  assert.equal(resolveReplyTargetSelf({ known: null, senderId: '10001', selfId: '10001' }), true);
  assert.equal(resolveReplyTargetSelf({ known: null, senderId: '20002', selfId: '10001' }), false);
  assert.equal(resolveReplyTargetSelf({ known: {}, senderId: '10001', selfId: '10001' }), true);
  assert.equal(isReplyTargetedToSelf({ reply: { targetSelf: true }, selfId: '10001' }), true);
  assert.equal(isReplyTargetedToSelf({ reply: { targetSelf: false }, selfId: '10001' }), false);
  assert.equal(isReplyTargetedToSelf({ reply: { senderId: '10001' }, selfId: '10001' }), true);
});

test('入站引用信息会存进消息记录，供明确响应路线使用', () => {
  const source = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');
  assert.match(source, /targetSelf: resolveReplyTargetSelf/);
  assert.match(source, /let replyMeta = null;/);
  assert.match(source, /reply: replyMeta/);
  const orchestrator = fs.readFileSync(new URL('../src/orchestrator.js', import.meta.url), 'utf8');
  assert.match(orchestrator, /isReplyTargetedToSelf/);
});
