import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isPluginWatchPath, pluginSourceSignature } from '../src/plugin-loader.js';
import {
  buildSystemPrompt,
  buildStaticPersonaBlock,
  isAtMe,
  isHotMemeQuestion,
  isNameMention,
  isPokeAtBot,
  memeSearchQuery,
  resolveContextTier
} from '../src/prompt.js';
import {
  buildLeanSystemRules,
  compactPromptSections
} from '../src/prompt-cleaned.js';
import {
  collapseConsecutiveDuplicates,
  hasRichHistoryContent
} from '../src/prompt.js';
import { syncRoleToolsSection, toolGuideDrift } from '../src/tool-role-sync.js';
import { PERSONAS } from '../src/personas.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { localReplyPolicy } from '../src/local-reply-policy.js';
import { resolveOutputMaxTokens } from '../src/llm.js';
import {
  filteredToolResult,
  selectSafeToolCalls,
  toolCallSignature
} from '../src/orchestrator.js';

test('插件热重载忽略运行数据、日志、媒体和备份', () => {
  const ignored = [
    'health-system/health-data.json',
    'health-system/data/state.json',
    'health-system/logs/health.log',
    'health-system/cache/frame.tmp',
    'health-system/assets/sticker.png',
    'health-system/health-report-123.png',
    'health-system/index.js.bak',
    'node_modules/pkg/index.js'
  ];
  for (const file of ignored) assert.equal(isPluginWatchPath(file), false, file);
  assert.equal(isPluginWatchPath('health-system/index.js'), true);
  assert.equal(isPluginWatchPath('health-system/skill.json'), true);
});

test('插件源码签名不受运行数据影响，但会响应源码变化', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), '37qag-watch-'));
  try {
    const plugin = path.join(root, 'sample');
    fs.mkdirSync(plugin, { recursive: true });
    fs.writeFileSync(path.join(plugin, 'index.js'), 'export const value = 1;\n');
    const before = pluginSourceSignature([root]);

    fs.mkdirSync(path.join(plugin, 'data'), { recursive: true });
    fs.writeFileSync(path.join(plugin, 'health-data.json'), '{"runs":2}');
    fs.writeFileSync(path.join(plugin, 'data', 'state.json'), '{"runs":3}');
    fs.writeFileSync(path.join(plugin, 'debug.log'), 'changed\n');
    assert.equal(pluginSourceSignature([root]), before);

    fs.writeFileSync(path.join(plugin, 'index.js'), 'export const value = 2;\n');
    assert.notEqual(pluginSourceSignature([root]), before);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('机器人名、群内展示名和 QQ 号都算明确召唤，并有数字边界保护', () => {
  assert.equal(isAtMe('37 在吗', { botName: '37（选手）' }), true);
  assert.equal(isAtMe('小鲸鱼看看这个', { selfNickname: '小鲸鱼' }), true);
  assert.equal(isAtMe('137', { botName: '37' }), false);
  assert.equal(isAtMe('37.5 度', { botName: '37' }), false);
  assert.equal(isAtMe('[引用 张三：37 看这个]\n今晚继续', { botName: '37' }), false);
  assert.equal(isNameMention('hello', {}), false);
});

test('拍机器人是明确响应，热梗问题会生成联网查询', () => {
  assert.equal(isPokeAtBot('[拍一拍] 你被示例用户拍了拍'), true);
  assert.equal(isPokeAtBot('[拍一拍] 示例用户拍了拍你（机器人）'), true);
  assert.equal(isPokeAtBot('[拍一拍] 示例用户拍了拍小明'), false);
  assert.equal(isHotMemeQuestion('这是什么梗'), true);
  assert.equal(isHotMemeQuestion('这个词哪里火的'), true);
  assert.equal(isHotMemeQuestion('今晚吃什么'), false);
  assert.match(memeSearchQuery('这个词是什么梗'), /网络热梗 含义 出处/);
});

test('名字和拍一拍会绕过 Jev 插话否决', () => {
  const cfg = { contextTier: 3, randomPercent: 0, atCount: 8 };
  const named = resolveContextTier({
    triggerEntries: [{ text: '37 来看看' }],
    botName: '37',
    cfg,
    deferRandom: true
  });
  assert.equal(named.shouldRespond, true);
  assert.equal(named.reason, '被叫名字');

  const poked = resolveContextTier({
    triggerEntries: [{ text: '[拍一拍] 你被示例用户拍了拍' }],
    cfg,
    deferRandom: true
  });
  assert.equal(poked.shouldRespond, true);
  assert.equal(poked.reason, '拍到我');
});

// 2026-09-26 收官冒烟发现的缺口：4 档（默认）捷径曾把 atMe/explicitResponse 丢掉，
// orchestrator 的参与判定因此把 @ 当成"主动插话"——本地 Jev 关闭时整批跳过（@ 了也沉默）。
// 修复后 4 档必须携带显式召唤标记（reason/atMe/explicitResponse），普通消息仍是"全部响应"。
test('4 档全读不丢显式召唤标记：@/拍一拍仍走不可否决通道', () => {
  const cfg = { contextTier: 4, randomPercent: 0, atCount: 8, allCount: 80 };

  const at = resolveContextTier({
    triggerEntries: [{ text: '[CQ:at,qq=88888] 报数' }],
    selfId: '88888', botName: '37',
    cfg, deferRandom: true
  });
  assert.equal(at.shouldRespond, true);
  assert.equal(at.reason, '被艾特');
  assert.equal(at.atMe, true);
  assert.equal(at.explicitResponse, true);
  assert.equal(at.count, 80);                       // 4 档上下文仍按 allCount 读

  const poked = resolveContextTier({
    triggerEntries: [{ text: '[拍一拍] 你被示例用户拍了拍' }],
    cfg, deferRandom: true
  });
  assert.equal(poked.reason, '拍到我');
  assert.equal(poked.explicitResponse, true);

  const plain = resolveContextTier({
    triggerEntries: [{ text: '今天天气不错' }],
    cfg, deferRandom: true
  });
  assert.equal(plain.shouldRespond, true);          // 4 档兜底：普通消息照常全部响应
  assert.equal(plain.reason, '全部响应');
  assert.equal(plain.explicitResponse, false);
  assert.equal(plain.atMe, false);
});

test('系统规则以角色卡为准，精简版不再塞入冲突腔调词', () => {
  const lean = buildLeanSystemRules({ botName: '37' });
  for (const phrase of ['已读乱回', '装唐', '装傻', '反问呛人', '阴阳怪气']) {
    assert.doesNotMatch(lean, new RegExp(phrase));
  }
  const full = buildSystemPrompt({
    persona: { botName: '37', roleText: '', customRules: '', systemMode: 'full' }
  });
  assert.match(full, /规则优先级·固定/);
  assert.match(full, /安全规则.*工具协议.*管理员设置的角色卡/s);
});

test('健康系统把状态迁移到插件数据目录，并保留旧文件兜底', () => {
  const source = fs.readFileSync(
    new URL('../plugins/health-system/index.js', import.meta.url),
    'utf8'
  );
  assert.match(source, /storage = api\.storage\?\.writeJson \? api\.storage : null/);
  assert.match(source, /storage\.writeJson\('health-data\.json', data\)/);
  assert.match(source, /旧文件保留作备份/);
});


test('插件提示词逐字、逐行去重并限制总规模', () => {
  const sections = [
    '安全规则\n保持自然，不要复读。',
    '安全规则\n保持自然，不要复读。',
    '另一插件规则\n保持自然，不要复读。\n只保留这条独有规则。',
    `长规则：${'唯一内容'.repeat(800)}`
  ];
  const compact = compactPromptSections(sections, 3000);
  const all = compact.join('\n');
  assert.equal(compact[0], '安全规则\n保持自然，不要复读。');
  assert.doesNotMatch(compact[1], /保持自然，不要复读/);
  assert.match(all, /只保留这条独有规则/);
  assert.ok(all.length <= 3001);
});

test('精简系统只保留一套身份、工作方式和记忆入口', () => {
  const lean = buildLeanSystemRules({ botName: '37' });
  assert.equal((lean.match(/【工作方式·正文≠发言】/g) || []).length, 1);
  assert.equal((lean.match(/【像群友】/g) || []).length, 1);
  assert.equal((lean.match(/每次处理全新/g) || []).length, 1);
  assert.doesNotMatch(lean, /（协议重复一遍/);
  assert.doesNotMatch(lean, /小鲸鱼|鲸系|不是鲸/);
  assert.match(lean, /对啊 37 怎么/);
  assert.match(lean, /你的名字是「37」/);
  assert.match(lean, /普通人类群友/);
  assert.doesNotMatch(lean, /你是「37」|你就是「37」/);
});

test('系统提示把 37 表述为人类，并把 37 当作名字', () => {
  const roleText = PERSONAS.qag37.text;
  const full = buildSystemPrompt({
    persona: { botName: '37', roleText, customRules: '', systemMode: 'full' }
  });
  assert.match(full, /你在角色卡中的名字是「37」/);
  assert.match(full, /普通人类群友/);
  assert.doesNotMatch(full, /你是「37」|你就是「37」/);

  const staticPersona = buildStaticPersonaBlock({
    ...DEFAULT_CONFIG.persona,
    botName: '37',
    roleText: PERSONAS.qag37.text,
    compactSystemPrompt: false
  });
  assert.match(staticPersona, /你的名字是 37/);
  assert.doesNotMatch(staticPersona, /你是 37|你就是 37|你是「37」|你就是「37」/);

  for (const source of ['../src/prompt.js', '../src/prompt-cleaned.js']) {
    const text = fs.readFileSync(new URL(source, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /你是「\$\{|你就是「\$\{|你是角色卡上的「/);
  }
});

test('37 人设融合温柔软糯优点，固定女 18 岁人类并保留低权重自我印象', () => {
  const role = PERSONAS.qag37.text;
  assert.match(role, /女，18岁，人类，温柔体贴可爱/);
  assert.match(role, /你的名字是 37/);
  assert.match(role, /温柔是底色/);
  assert.match(role, /体贴是习惯/);
  assert.match(role, /可爱是自然流露/);
  assert.match(role, /软傲娇是小点缀/);
  assert.match(role, /目标是让对方觉得“有你这个朋友真好”/);
  assert.match(role, /话里绝不能带刺/);
  assert.match(role, /默认常用 1～15 字/);
  assert.match(role, /命令改邀请/);
  assert.match(role, /不想接的话题温柔绕过/);
  assert.match(role, /希望这个回答对你有帮助/);
  assert.match(role, /发言前三问/);
  assert.match(role, /喜欢收集各种表情包/);
  assert.doesNotMatch(role, /你是 37|你就是 37|你是「37」|你就是「37」/);
  assert.doesNotMatch(role, /被问是不是 AI\/程序时可以承认网络身份/);
  assert.ok(role.length < 6000);
});

test('角色卡不再携带工具长附录，但保留后续自我印象', () => {
  const role = `# 角色卡\n\n## 核心\n像朋友一样聊天。\n\n## 可用工具\n<!--tools:start-->\n旧的几十行工具说明\n<!--tools:end-->\n\n## 自我印象（低权重参考·可灵活违背）\n- 喜欢收集各种表情包`;
  const cleaned = syncRoleToolsSection(role);
  assert.doesNotMatch(cleaned, /可用工具|旧的几十行工具说明/);
  assert.match(cleaned, /自我印象/);
  assert.match(cleaned, /喜欢收集各种表情包/);
  assert.deepEqual(toolGuideDrift(), []);
});

test('历史只折叠连续同人的纯文本重复，富消息保持原样', () => {
  const messages = [
    { id: 1, senderId: '1001', self: false, text: '哈哈哈' },
    { id: 2, senderId: '1001', self: false, text: '哈哈哈' },
    { id: 3, senderId: '1001', self: false, text: '哈哈哈', reply: { id: 9 } },
    { id: 4, senderId: '1002', self: false, text: '哈哈哈' }
  ];
  assert.equal(hasRichHistoryContent(messages[2]), true);
  const collapsed = collapseConsecutiveDuplicates(messages);
  assert.equal(collapsed.length, 3);
  assert.equal(collapsed[0].id, 2);
  assert.equal(collapsed[0]._historyRepeatCount, 2);
  assert.deepEqual(collapsed[0]._historySourceIds, [1, 2]);
  assert.equal(collapsed[1].reply.id, 9);
  assert.equal(collapsed[2].senderId, '1002');
});

test('工具调用按规范化参数去重，并限制每轮、每运行和发送次数', () => {
  assert.equal(
    toolCallSignature('web_search', '{"q":"热梗","limit":3}'),
    toolCallSignature('web_search', '{ "limit": 3, "q": "热梗" }')
  );

  const call = (id, name, args) => ({ id, function: { name, arguments: JSON.stringify(args) } });
  const roundState = { seen: new Set(), runCount: 0, totalSends: 0, sendsByName: {} };
  const searchCalls = Array.from({ length: 10 }, (_, i) => call(`s${i}`, 'web_search', { q: `热梗${i}` }));
  const first = selectSafeToolCalls(searchCalls, roundState, { perRound: 8, perRun: 24, totalSends: 4 });
  assert.equal(first.accepted.length, 8);
  assert.equal(first.rejected.length, 2);

  const sends = [
    call('m1', 'send_message', { messages: '一' }),
    call('m2', 'send_message', { messages: '二' }),
    call('m3', 'send_message', { messages: '三' }),
    call('e1', 'send_sticker', { stickerId: 'a' }),
    call('e2', 'send_sticker', { stickerId: 'b' }),
    call('i1', 'send_image', { url: 'https://example.test/a.jpg' }),
    call('i2', 'send_image', { url: 'https://example.test/b.jpg' })
  ];
  const second = selectSafeToolCalls(sends, roundState, {
    perRound: 8, perRun: 12, totalSends: 4, send_message: 2, send_sticker: 1
  });
  assert.deepEqual(second.accepted.map((x) => x.id), ['m1', 'm2', 'e1', 'i1']);
  assert.deepEqual(second.rejected.map((x) => x.id), ['m3', 'e2', 'i2']);
  for (const skipped of second.rejected) {
    const result = filteredToolResult(skipped.call, skipped.reason);
    assert.equal(result.role, 'tool');
    assert.equal(result.tool_call_id, skipped.call.id);
    assert.equal(result.isError, false);
  }

  const duplicateState = { seen: new Set(), runCount: 0, totalSends: 0, sendsByName: {} };
  const duplicate = selectSafeToolCalls([
    call('d1', 'web_search', { q: 'x', limit: 3 }),
    call('d2', 'web_search', { limit: 3, q: 'x' })
  ], duplicateState, {});
  assert.equal(duplicate.accepted.length, 1);
  assert.equal(duplicate.rejected.length, 1);
});

test('模型输出预算为空时回落到 4096，小预算仍可保留', () => {
  assert.equal(resolveOutputMaxTokens(0), 4096);
  assert.equal(resolveOutputMaxTokens(''), 4096);
  assert.equal(resolveOutputMaxTokens('bad'), 4096);
  assert.equal(resolveOutputMaxTokens(-10), 4096);
  assert.equal(resolveOutputMaxTokens(1), 1);
  assert.equal(resolveOutputMaxTokens(8), 8);
  assert.equal(localReplyPolicy({ baseUrl: 'https://example.test', maxTokens: 0 }, []).budget, 4096);
  assert.equal(DEFAULT_CONFIG.api.maxTokens, 4096);
  assert.equal(DEFAULT_CONFIG.api.timeoutMs, 90000);
  assert.equal(DEFAULT_CONFIG.persona.systemMode, 'lean');
  // 2026-09-26：出厂默认人设 37 → 小鲸鱼（与源头项目对齐；37 保留为可选人设）
  assert.equal(DEFAULT_CONFIG.persona.botName, '小鲸鱼');
  assert.equal(DEFAULT_CONFIG.persona.selfNickname, '小鲸鱼');
  assert.equal(DEFAULT_CONFIG.persona.roleText, PERSONAS.xiaojingyu.text);
});

test('工具说明不再把所有动作替换成同一个占位工具', () => {
  const source = fs.readFileSync(new URL('../src/tools.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\(send_message\|send_sticker\|send_image\|search_images\|web_search\)/);
  assert.match(source, /想发网图用 send_image\(url\)/);
  assert.match(source, /每张表情分别调用 send_sticker\(stickerId\)/);
  assert.match(source, /实时新闻\/新梗仍用 web_search/);
  assert.match(source, /images 是这页的图片直链（可直接喂给 send_image 发图）/);
});
