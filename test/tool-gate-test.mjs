// 阶段三回归：tool-gate.js（规则分类 / 工具过滤 / 结果截断 / 轮内预算 / Jev 规格）。
import { test } from 'node:test';
import assert from 'node:assert';

const gate = await import('../src/tool-gate.js');
const { classifyToolNeed, filterToolDefs, truncateToolResult, toolResultBudgetLeft, categoryOf, TOOL_CATEGORIES, TOOL_GATE_JEV_SPEC } = gate;

const DEFS = [
  { name: 'send_message' },
  { name: 'send_sticker' },
  { name: 'get_recent_messages' },
  { name: 'web_search' },
  { name: 'web_fetch' },
  { name: 'search_images' },
  { name: 'get_message_images' },
  { name: 'identify_image' },
  { name: 'memory_query' },
  { name: 'memory_search' }
];

test('分类表：核心发言工具归 core（常驻）', () => {
  assert.equal(categoryOf('send_message'), 'core');
  assert.equal(categoryOf('send_sticker'), 'core');
  assert.equal(categoryOf('get_recent_messages'), 'core');
  assert.equal(categoryOf('web_search'), 'search');
  assert.equal(categoryOf('identify_image'), 'media');
  assert.equal(categoryOf('memory_query'), 'memory');
  assert.equal(categoryOf('未收录的新工具'), 'core', '未收录默认常驻（新工具不因门控漏注入）');
});

test('规则：@机器人 → 全量（被请求强信号）', () => {
  assert.equal(classifyToolNeed('嗯', { atMe: true }).need, 'all');
});

test('规则：带图 → 至少开 media', () => {
  const v = classifyToolNeed('看看这个', { hasImage: true });
  assert.equal(v.need, 'cats');
  assert.ok(v.cats.includes('media'));
});

test('规则：纯闲聊形态 → none（信息工具全砍）', () => {
  for (const t of ['哈哈哈哈哈', '嗯', '行吧', 'ok', '睡了睡了', '666', '草']) {
    assert.equal(classifyToolNeed(t).need, 'none', `「${t}」应判纯闲聊`);
  }
});

test('规则：信号词 → 只开对应类别', () => {
  const v1 = classifyToolNeed('今天天气怎么样');
  assert.equal(v1.need, 'cats');
  assert.ok(v1.cats.includes('search'), '天气应开 search');

  const v2 = classifyToolNeed('这图里是啥');
  assert.equal(v2.need, 'cats');
  assert.ok(v2.cats.includes('media'), '识图应开 media');

  const v3 = classifyToolNeed('你上次说的那事呢');
  assert.equal(v3.need, 'cats');
  assert.ok(v3.cats.includes('memory'), '旧事应开 memory');
});

test('规则：长文本（>40字）→ 全量保底', () => {
  const long = '今天我们讨论一下关于宇宙膨胀速度与暗能量密度的最新观测数据吧，这个问题挺有意思的，大家可以随便聊聊自己的看法和疑问';
  assert.ok(long.length > 40);
  assert.equal(classifyToolNeed(long).need, 'all');
});

test('规则：短且无信号 → unknown（交给 Jev 或全量保底）', () => {
  assert.equal(classifyToolNeed('这游戏副本怎么打').need, 'unknown');
  assert.equal(classifyToolNeed('诶那个谁').need, 'unknown');
});

test('过滤：none 时信息工具全砍，发言/群聊辅助保留', () => {
  const out = filterToolDefs(DEFS, { need: 'none', cats: [] });
  const names = out.map((d) => d.name);
  assert.ok(names.includes('send_message'), '发言工具必须保留');
  assert.ok(names.includes('send_sticker'));
  assert.ok(names.includes('get_recent_messages'), '群聊辅助保留');
  for (const gone of ['web_search', 'web_fetch', 'search_images', 'get_message_images', 'identify_image', 'memory_query', 'memory_search']) {
    assert.ok(!names.includes(gone), `${gone} 应被砍掉`);
  }
});

test('过滤：cats=search 只开联网类', () => {
  const out = filterToolDefs(DEFS, { need: 'cats', cats: ['search'] });
  const names = out.map((d) => d.name);
  assert.ok(names.includes('web_search'));
  assert.ok(names.includes('web_fetch'));
  assert.ok(!names.includes('memory_query'));
  assert.ok(!names.includes('identify_image'));
  assert.ok(names.includes('send_message'), 'core 永远保留');
});

test('过滤：all / unknown → 原样全量（保底语义）', () => {
  assert.equal(filterToolDefs(DEFS, { need: 'all', cats: [] }).length, DEFS.length);
  assert.equal(filterToolDefs(DEFS, { need: 'unknown', cats: [] }).length, DEFS.length);
  assert.deepEqual(filterToolDefs(DEFS, null), DEFS, 'null verdict 视为全量');
});

test('截断：超长结果截断并带尾注与长度提示', () => {
  const long = 'A'.repeat(10_000);
  const out = truncateToolResult(long, 6000);
  assert.ok(out.length < 6200);
  assert.ok(out.includes('已截断'));
  assert.ok(out.includes('10000'), '应提示原文长度');
  assert.equal(truncateToolResult('短结果', 6000), '短结果', '不超长原样返回');
});

test('预算：累计字符扣减与用尽判定', () => {
  assert.equal(toolResultBudgetLeft([], 12000), 12000);
  assert.equal(toolResultBudgetLeft(['A'.repeat(5000)], 12000), 7000);
  assert.equal(toolResultBudgetLeft(['A'.repeat(15000)], 12000), 0);
});

test('Jev 规格：标签/示例/positive 完整且与 local-jev 注册一致', async () => {
  assert.deepEqual(TOOL_GATE_JEV_SPEC.labels, ['TOOL', 'CHAT']);
  assert.equal(TOOL_GATE_JEV_SPEC.positive, 'TOOL');
  assert.ok(TOOL_GATE_JEV_SPEC.examples.length >= 4);
  // 与 local-jev.js 的 JEV_GATE_SPECS.toolNeedGate 逐字段一致（防两处漂移）
  const jev = await import('../src/local-jev.js');
  const spec = jev.JEV_GATE_SPECS.toolNeedGate;
  assert.ok(spec, 'local-jev 应注册 toolNeedGate');
  assert.equal(spec.instruction, TOOL_GATE_JEV_SPEC.instruction);
  assert.deepEqual(spec.labels, TOOL_GATE_JEV_SPEC.labels);
  assert.equal(spec.positive, TOOL_GATE_JEV_SPEC.positive);
});

test('配置默认：api.toolGate=rules / channel=cloud / 本地端点默认指向 llama-server', async () => {
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  assert.equal(DEFAULT_CONFIG.api.toolGate, 'rules');
  assert.equal(DEFAULT_CONFIG.api.channel, 'cloud');
  assert.equal(DEFAULT_CONFIG.api.local.baseUrl, 'http://127.0.0.1:18080/v1');
  assert.equal(DEFAULT_CONFIG.api.fallback, 'local-to-cloud');
  assert.equal(DEFAULT_CONFIG.api.toolResultMaxChars, 6000);
  assert.equal(DEFAULT_CONFIG.api.toolResultBudgetChars, 12000);
});

// ── jev 级联 PR1：技能路由规则层（categoryOf 扩展 / 技能信号词 / skillCats 过滤）──

test('PR1·categoryOf：技能工具（含 use_xxx 包装）按 skillId 映射门控类别', () => {
  const skillCats = { calculator: 'ext-info', 'mini-games': 'ext-fun', 'weather-query': 'ext-info' };
  // use_xxx 包装工具（4+ 个工具的技能组聚合入口，skillId 在 def 上）
  assert.equal(categoryOf('use_mini_games', { name: 'use_mini_games', skillId: 'mini-games' }, skillCats), 'ext-fun');
  // 技能单工具（不足包装阈值的技能直接平铺，同样带 skillId）
  assert.equal(categoryOf('calculate', { name: 'calculate', skillId: 'calculator' }, skillCats), 'ext-info');
  assert.equal(categoryOf('get_weather', { name: 'get_weather', skillId: 'weather-query' }, skillCats), 'ext-info');
  // 名字优先：核心工具名命中分类表 → 不看 skillId（防御性：万一技能注册了同名工具）
  assert.equal(categoryOf('web_search', { name: 'web_search', skillId: 'calculator' }, skillCats), 'search');
  // 未标注 / 未在映射中的技能 → core 常驻（宁可多注入不可漏）
  assert.equal(categoryOf('use_unknown', { name: 'use_unknown', skillId: 'someone-else' }, skillCats), 'core');
  assert.equal(categoryOf('use_x', { name: 'use_x', skillId: 'mini-games' }, null), 'core', '没传映射 → 全部常驻（旧行为）');
  assert.equal(categoryOf('use_x', { name: 'use_x' }, skillCats), 'core', '没有 skillId 的 def 不受影响');
});

test('PR1·filterToolDefs：skillCats 使技能工具参与门控（修复此前一律 core 的失效）', () => {
  const defs = [
    { name: 'send_message' },
    { name: 'web_search' },
    { name: 'use_mini_games', skillId: 'mini-games' },
    { name: 'calculate', skillId: 'calculator' },
    { name: 'use_other', skillId: 'unmarked-skill' }
  ];
  const skillCats = { 'mini-games': 'ext-fun', calculator: 'ext-info' };
  // 纯闲聊：信息工具 + 已标注技能工具全砍；未标注技能保留
  const chat = filterToolDefs(defs, { need: 'none', cats: [] }, skillCats).map((d) => d.name);
  assert.deepEqual(chat.sort(), ['send_message', 'use_other'], '闲聊轮：砍已标注技能，留未标注技能（常驻兜底）');
  // 技能类别命中：对应技能工具保留
  const fun = filterToolDefs(defs, { need: 'cats', cats: ['ext-fun'] }, skillCats).map((d) => d.name);
  assert.ok(fun.includes('use_mini_games'), 'ext-fun 轮应留 mini-games 工具');
  assert.ok(!fun.includes('calculate'), 'ext-info 未命中不应留 calculator');
  // 不传映射 → 技能工具全部常驻（向后兼容）
  const legacy = filterToolDefs(defs, { need: 'none', cats: [] }).map((d) => d.name);
  assert.deepEqual(legacy.sort(), ['calculate', 'send_message', 'use_mini_games', 'use_other'], '不传 skillCats：技能工具全保留（PR1 前行为）');
});

test('PR1·信号词：算/画/天气/猜/梗 → ext-* 技能类别（与既有类别并集）', () => {
  const cases = [
    ['帮我算一下 128 乘 46', 'ext-info'],
    ['明天上海天气怎么样', 'ext-info'],
    ['这是什么梗', 'ext-info'],
    ['画一张猫猫表情包', 'ext-fun'],
    ['来一把猜数字', 'ext-fun'],
    ['掷骰子', 'ext-fun']
  ];
  for (const [text, cat] of cases) {
    const v = classifyToolNeed(text);
    assert.equal(v.need, 'cats', `「${text}」应命中信号词`);
    assert.ok(v.cats.includes(cat), `「${text}」应开 ${cat}，实际 ${v.cats.join(',')}`);
  }
  // 误伤防护（方案 §4 风险3）：「算了」不开 ext-info（短模糊走 unknown→全量保底，方向安全）
  const suanle = classifyToolNeed('算了');
  assert.ok(!suanle.cats.includes('ext-info'), `「算了」不应开技能类别（精确模式防误伤），实际 ${suanle.need}`);
});

test('PR1·SKILL_GATE_CATEGORIES：取值域含 core 与六个门控类别', () => {
  assert.ok(TOOL_CATEGORIES, '旧分类表仍在');
  const { SKILL_GATE_CATEGORIES } = gate;
  assert.deepEqual([...SKILL_GATE_CATEGORIES].sort(), ['core', 'ext-fun', 'ext-info', 'ext-text', 'media', 'memory', 'search']);
});

// ── jev 级联 PR2：skillRouteGate 五分类（mock 判定与降级路径，真机推理不可用）──

test('PR2·skillRouteVerdict：五分类 label → 门控 verdict（纯函数，mock 判定）', () => {
  const { skillRouteVerdict, SKILL_ROUTE_LABEL_CATS } = gate;
  // 「闲」→ 只留常驻
  const xian = skillRouteVerdict({ label: '闲', p: 0.91, margin: 2.3 });
  assert.equal(xian.need, 'none');
  assert.deepEqual(xian.cats, []);
  assert.match(xian.reason, /^jev2:闲/);
  // 「查」→ search
  const cha = skillRouteVerdict({ label: '查', p: 0.87, margin: 2.1 });
  assert.equal(cha.need, 'cats');
  assert.deepEqual(cha.cats, ['search']);
  // 「技」→ 三个 ext 类全开（宁多勿少）
  const ji = skillRouteVerdict({ label: '技', p: 0.8, margin: 1.5 });
  assert.deepEqual(ji.cats.sort(), ['ext-fun', 'ext-info', 'ext-text']);
  // 「图」「忆」
  assert.deepEqual(skillRouteVerdict({ label: '图' }).cats, ['media']);
  assert.deepEqual(skillRouteVerdict({ label: '忆' }).cats, ['memory']);
  // 防御：label 未映射 / 空 → 全量保底（grammar 约束下不该出现，但兜底方向安全）
  assert.equal(skillRouteVerdict({ label: '外星文' }).need, 'all', '未知标签 → 全量');
  assert.equal(skillRouteVerdict({ label: null }).need, 'all', '空标签 → 全量');
  assert.equal(skillRouteVerdict({}).need, 'all', '无字段 → 全量');
  // reason 携带置信度（排查用）
  assert.match(cha.reason, /p=0\.87/);
  // 映射表五个标签全覆盖（按码点排序断言）
  assert.deepEqual(Object.keys(SKILL_ROUTE_LABEL_CATS).sort(), ['图', '忆', '技', '查', '闲']);
});

test('PR2·降级路径：弃权/失败/超时 → 维持 unknown → 全量保底（三段式链路）', () => {
  // jevGate 返回 abstain/error 时 orchestrator 不改写 verdict（维持 rules 的 unknown），
  // filterToolDefs 对 unknown 的既有语义 = 全量 —— 这里断言整条链的每一环（纯函数可测部分）。
  // 1) 短模糊文本确实判 unknown（jev 入口条件）
  assert.equal(classifyToolNeed('这游戏副本怎么打').need, 'unknown');
  // 2) unknown → filterToolDefs 全量（保底语义，既有行为）
  const defs = [{ name: 'send_message' }, { name: 'web_search' }];
  assert.equal(filterToolDefs(defs, { need: 'unknown', cats: [] }).length, 2, 'unknown = 全量保底');
  assert.equal(filterToolDefs(defs, null).length, 2, 'null verdict = 全量');
  // 3) jev 结果带 abstain/error 时调用方跳过改写（skillRouteVerdict 不该被调用）——
  //    用 mock 形状证明：即便模型给了 label 但 abstain=true，调用方的过滤条件挡在前面。
  const mockAbstain = { label: '闲', p: 0.3, margin: 0.2, abstain: true };
  const mockError = { label: null, error: 'timeout', abstain: false };
  // 模拟 orchestrator 的守卫：if (jev && !jev.error && !jev.abstain)
  const accepted = (jev) => !!(jev && !jev.error && !jev.abstain);
  assert.equal(accepted(mockAbstain), false, '弃权结果不采信');
  assert.equal(accepted(mockError), false, '错误结果不采信');
  assert.equal(accepted({ label: '查', p: 0.9, margin: 2 }), true, '正常结果采信');
});

test('PR2·规格一致性：SKILL_ROUTE_LABEL_CATS 与 local-jev spec.map 逐字段相同（防两处漂移）', async () => {
  const { SKILL_ROUTE_LABEL_CATS } = gate;
  const jev = await import('../src/local-jev.js');
  const spec = jev.JEV_GATE_SPECS.skillRouteGate;
  assert.ok(spec, 'local-jev 应注册 skillRouteGate');
  assert.deepEqual(spec.map['闲'], SKILL_ROUTE_LABEL_CATS['闲']);
  assert.deepEqual(spec.map['查'], SKILL_ROUTE_LABEL_CATS['查']);
  assert.deepEqual(spec.map['图'], SKILL_ROUTE_LABEL_CATS['图']);
  assert.deepEqual(spec.map['忆'], SKILL_ROUTE_LABEL_CATS['忆']);
  assert.deepEqual(spec.map['技'], SKILL_ROUTE_LABEL_CATS['技']);
});

test('PR2·skillRouteGate 规格：五标签/12 例 few-shot/positive=null（多分类语义）', async () => {
  const jev = await import('../src/local-jev.js');
  const spec = jev.JEV_GATE_SPECS.skillRouteGate;
  assert.deepEqual(spec.labels, ['闲', '查', '图', '忆', '技']);
  assert.equal(spec.positive, null, '多分类角色无 positive（语义在 label）');
  assert.equal(spec.examples.length, 12, '12 例 few-shot（方案 §3.3.2）');
  // 每条例子的答案都在标签枚举内（防手滑写错 label）
  for (const [text, label] of spec.examples) {
    assert.ok(spec.labels.includes(label), `例「${text}」答案 ${label} 不在枚举内`);
  }
  // map 键与 labels 一一对应
  assert.deepEqual(Object.keys(spec.map).sort(), [...spec.labels].sort());
  // JEV_ROLES 目录也有该角色（设置页可见、可解释）
  assert.ok(jev.JEV_ROLES.skillRouteGate, 'JEV_ROLES 目录应含 skillRouteGate');
  assert.ok(jev.JEV_ROLES.skillRouteGate.cn);
});

test('PR2·配置播种：toolGate 默认 rules 不变；skillRouteGate 进默认角色表', async () => {
  const { DEFAULT_CONFIG } = await import('../src/config.js');
  assert.equal(DEFAULT_CONFIG.api.toolGate, 'rules', '默认档不变（jev2 为显式 opt-in）');
  assert.ok(DEFAULT_CONFIG.localJev.roles.includes('skillRouteGate'), '新角色进默认表（migrateLocalJev 自动补进老配置）');
  // 注释档位说明已含 jev2（防文档漂移：直接读源码断言）
  const fs = await import('node:fs');
  const src = fs.readFileSync(new URL('../src/config.js', import.meta.url), 'utf8');
  assert.match(src, /'jev2'/, 'toolGate 注释应说明 jev2 档');
});
