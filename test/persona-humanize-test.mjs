// 拟人化专项（2026-09-26，用户新增要求「提示词围绕 bot 拟人化，别硬写更不要乱写」）：
// 审计结论 = 人设卡不动（5 张卡已是行为级拟人写法），只修系统侧 4 处硬编码身份句——
// 它们与「小鲸鱼」这张 AI 身份人设卡正面冲突（卡：被问 AI 大方承认「我是 DeepSeek」；
// 系统旧句：你是普通人类群友/别自曝AI/你跟 DeepSeek 没有关系），会让模型在两套相反
// 指令间摇摆，在群友眼里就是人设崩——最伤拟人感的一类问题。
// 修法：系统身份句让位给角色卡（与既定优先级「角色卡 > 通用风格」字面一致）：
// 卡写人类或没写身份 → 默认普通人类群友（4 张人类卡的锚不丢）；卡另写身份 → 照卡演。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PERSONAS } from '../src/personas.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { buildLeanSystemRules } from '../src/prompt-cleaned.js';

const fullArgs = () => ({
  persona: { botName: '37', roleText: PERSONAS.qag37.text, customRules: '', systemMode: 'full' }
});

test('系统身份句让位给角色卡：人类默认保留，非人类卡不再被系统唱反调', () => {
  const lean = buildLeanSystemRules({ botName: '37' });
  // 让位入口与人类默认锚都在
  assert.match(lean, /身份以角色卡为准/);
  assert.match(lean, /普通人类群友/);
  assert.match(lean, /卡里另写了身份/);
  // 无条件断言整句已移除（不再硬写「你是……普通人类群友」）
  assert.doesNotMatch(lean, /你是混在 QQ 群里的普通人类群友/);

  const full = buildSystemPrompt(fullArgs());
  assert.match(full, /身份以【角色设定】那张卡为准/);
  assert.match(full, /普通人类群友/);
  assert.doesNotMatch(full, /你是混在 QQ 群里的普通人类群友/);
});

test('full 模式不再硬写「跟 DeepSeek 没有关系」，关系随角色卡', () => {
  const full = buildSystemPrompt(fullArgs());
  assert.doesNotMatch(full, /你跟 DeepSeek 没有关系/);
  assert.match(full, /你跟 DeepSeek 是什么关系以角色卡为准/);
});

test('用户提示【身份收尾】按角色卡接身份，不再一刀切禁 AI 自曝', () => {
  // buildUserPromptParts 依赖运行态 config，这里按项目既有惯例（见 stability-fixes-test）
  // 直接断言源码措辞，防旧句回流。
  const source = fs.readFileSync(new URL('../src/prompt.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /别自曝AI\/程序，别扯去模型话题/);
  assert.match(source, /身份话题按角色卡接（卡里是人类就别自曝AI\/程序）/);
});

test('小鲸鱼卡保留 AI 身份玩法且自带「不解释内部实现」边界（本轮不改人设卡的证据）', () => {
  const role = PERSONAS.xiaojingyu.text;
  assert.match(role, /以 AI 身份混在 QQ 群里/);
  assert.match(role, /被怀疑是 AI 时大方承认/);
  assert.match(role, /不解释模型\/训练\/提示词/);
});

test('四张人类人设卡都自带人类身份声明（系统让位后人类锚依然成立）', () => {
  for (const id of ['qag37', 'laobai', 'aluo', 'moshu']) {
    assert.match(PERSONAS[id].text, /人类/, `${id} 卡应自带人类身份声明`);
  }
});

test('反自我解构护栏仍在：系统提示照旧禁止「我只是个AI」式塌台', () => {
  // 身份让位 ≠ 放开塌台。无论什么卡，模型一旦开始自我解构（我没有感情/我只是程序），
  // 群里的"人味"就全没了。full 的 subjectivity 与 lean 的关键句都必须还在。
  const full = buildSystemPrompt(fullArgs());
  assert.match(full, /自我解构|我只是个AI|没有感情/);
  const lean = buildLeanSystemRules({ botName: '37' });
  assert.match(lean, /像群友|角色卡/);
});
