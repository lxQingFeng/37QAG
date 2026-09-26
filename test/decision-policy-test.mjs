import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARTICIPATION_ROUTES,
  decideParticipation,
  decideMemoryRecall,
  detectParticipationRoute
} from '../src/decision-policy.js';

test('明确请求不能被 Jev 的 NO 否决', () => {
  const r = decideParticipation({
    text: '请帮我查一下昨天的聊天记录',
    jev: { on: false, label: 'NO', abstain: false }
  });
  assert.equal(r.route, PARTICIPATION_ROUTES.EXPLICIT);
  assert.equal(r.action, 'continue');
  assert.equal(r.jevCanVeto, false);
});

test('自然接话由可靠的 Jev 正结论放行，低风险可降级', () => {
  const positive = decideParticipation({
    route: PARTICIPATION_ROUTES.NATURAL,
    keywordHit: true,
    jev: { label: 'YES', abstain: false, p: 0.9 },
    failureImpact: 'low'
  });
  assert.equal(positive.action, 'continue');

  const failed = decideParticipation({
    route: PARTICIPATION_ROUTES.NATURAL,
    keywordHit: true,
    jev: { error: 'timeout' },
    failureImpact: 'low'
  });
  assert.equal(failed.action, 'continue');
  assert.equal(failed.reason, 'low-risk-natural-fallback');
});

test('主动插话在 Jev 弃权/故障时保持沉默', () => {
  const r = decideParticipation({
    route: PARTICIPATION_ROUTES.PROACTIVE,
    jev: { abstain: true, label: null },
    failureImpact: 'low'
  });
  assert.equal(r.action, 'skip');
});

test('必需回忆不受 Jev 否决', () => {
  const r = decideMemoryRecall({
    explicitRequest: true,
    jev: { label: 'NO', abstain: false }
  });
  assert.equal(r.required, true);
  assert.equal(r.active, true);
});

test('参与路线识别', () => {
  assert.equal(detectParticipationRoute({ text: '麻烦发我一张图' }), PARTICIPATION_ROUTES.EXPLICIT);
  assert.equal(detectParticipationRoute({ keywordHit: true }), PARTICIPATION_ROUTES.NATURAL);
  assert.equal(detectParticipationRoute({}), PARTICIPATION_ROUTES.PROACTIVE);
});

test('QQ 私聊普通消息属于明确参与路线，Jev 不能否决', () => {
  assert.equal(
    detectParticipationRoute({ text: '111', privateChat: true }),
    PARTICIPATION_ROUTES.EXPLICIT
  );
  const r = decideParticipation({
    text: '111',
    privateChat: true,
    jev: { on: true, label: 'NO', abstain: false }
  });
  assert.equal(r.route, PARTICIPATION_ROUTES.EXPLICIT);
  assert.equal(r.action, 'continue');
  assert.equal(r.jevCanVeto, false);
});