// jev 级联 PR1 回归：技能门控路由（gateCategory 归一化 / 提示词段同源过滤 / 双端确定性）。
import { test } from 'node:test';
import assert from 'node:assert';

// ── 纯函数层（不依赖运行态配置）──────────────────────────────────────────────
const { normalizeManifest } = await import('../src/skills/manifest.js');
const { skillSectionGatedIn } = await import('../src/skills/manager.js');

test('manifest.gateCategory：合法值透传 / 非法回退 core / 缺省 core', () => {
  const ok = normalizeManifest({ id: 'a', name: 'A', gateCategory: 'ext-fun' });
  assert.equal(ok.manifest.gateCategory, 'ext-fun');
  assert.equal(ok.problems.length, 0);

  const bad = normalizeManifest({ id: 'b', name: 'B', gateCategory: 'nonsense' });
  assert.equal(bad.manifest.gateCategory, 'core', '非法值回退常驻');
  assert.ok(bad.problems.some((p) => p.includes('gateCategory 非法')));

  const none = normalizeManifest({ id: 'c', name: 'C' });
  assert.equal(none.manifest.gateCategory, 'core', '缺省 = 常驻（向后兼容所有旧 manifest）');
  assert.equal(none.problems.length, 0, '缺省不算问题');
});

test('skillSectionGatedIn：插件恒常驻 / 未标注恒常驻 / 技能按类别判定', () => {
  const plugin = { kind: 'plugin', manifest: { gateCategory: 'ext-fun' } };
  const unmarked = { kind: 'skill', manifest: {} };
  const core = { kind: 'skill', manifest: { gateCategory: 'core' } };
  const fun = { kind: 'skill', manifest: { gateCategory: 'ext-fun' } };
  const info = { kind: 'skill', manifest: { gateCategory: 'ext-info' } };

  assert.equal(skillSectionGatedIn(plugin, []), true, '确定性插件不进门控（恒注入）');
  assert.equal(skillSectionGatedIn(unmarked, []), true, '未标注技能常驻');
  assert.equal(skillSectionGatedIn(core, []), true, '显式 core 常驻');
  assert.equal(skillSectionGatedIn(fun, []), false, '闲聊轮（cats 空）砍技能段');
  assert.equal(skillSectionGatedIn(fun, ['ext-fun']), true, '类别命中注入');
  assert.equal(skillSectionGatedIn(info, ['ext-fun']), false, '类别不命中不注入');
  assert.equal(skillSectionGatedIn(fun, null), true, 'null cats = 不过滤（全量，向后兼容）');
});

// ── 注册表集成层：真实 SkillManager 过滤路径 ─────────────────────────────────
const { skillManager } = await import('../src/skills/manager.js');

function fakeSkill(id, gateCategory, kind = 'skill') {
  return {
    manifest: normalizeManifest({ id, name: id, gateCategory, prompt: { sections: [{ id: `${id}-s1`, title: '', content: `${id} 的提示词段`, priority: 50 }] } }).manifest,
    kind,
    api: null, toolIds: [], providers: {}, hooks: {},
    promptSections: null,
    activate: null, deactivate: null, dispose: null
  };
}

test('SkillManager.getPromptSections：按 context.cats 同源过滤（含动态段与去重）', () => {
  skillManager.register(fakeSkill('sg-fun', 'ext-fun'));
  skillManager.register(fakeSkill('sg-info', 'ext-info'));
  skillManager.register(fakeSkill('sg-core', 'core'));
  skillManager.register(fakeSkill('sg-plugin', 'ext-text', 'plugin'));

  try {
    const all = skillManager.getPromptSections();
    assert.equal(all.length, 4, '全量（不传 cats）四个技能段都在');

    const chatOnly = skillManager.getPromptSections({ cats: [] });
    const chatIds = chatOnly.map((s) => s.skillId).sort();
    assert.deepEqual(chatIds, ['sg-core', 'sg-plugin'], '闲聊轮：只留常驻 + 插件段');

    const fun = skillManager.getPromptSections({ cats: ['ext-fun'] });
    assert.deepEqual(fun.map((s) => s.skillId).sort(), ['sg-core', 'sg-fun', 'sg-plugin'], 'ext-fun 轮：常驻+插件+命中的技能');

    // 确定性（前缀缓存纪律）：同一 cats 两次调用 → 逐字节相同
    const a = JSON.stringify(skillManager.getPromptSections({ cats: ['ext-fun'] }));
    const b = JSON.stringify(skillManager.getPromptSections({ cats: ['ext-fun'] }));
    assert.equal(a, b, '同一 cats 输出确定性（缓存友好）');
  } finally {
    for (const id of ['sg-fun', 'sg-info', 'sg-core', 'sg-plugin']) skillManager.unregister(id);
  }
});

// ── prompt.js 注入层：buildSystemPrompt({ gateCats }) 同源生效 ─────────────────
test('buildSystemPrompt：gateCats 传递到技能段过滤 + 确定性', async () => {
  process.env.QAG_DATA_HOME = process.env.QAG_DATA_HOME || `/tmp/qag-skill-gate-${Date.now()}`;
  const { buildSystemPrompt } = await import('../src/prompt.js');

  // 不传 gateCats = 旧行为（全量注入）
  const full = buildSystemPrompt();
  // 空数组 = 闲聊轮（常驻段）
  const chat = buildSystemPrompt({ gateCats: [] });
  assert.ok(typeof full === 'string' && full.length > 100);
  assert.ok(typeof chat === 'string' && chat.length > 100);
  // 确定性：同一 gateCats 两次构建逐字节一致（三段式稳定前缀纪律）
  assert.equal(buildSystemPrompt({ gateCats: [] }), chat, '同一 gateCats 确定性输出');
  assert.equal(buildSystemPrompt({ gateCats: ['search', 'ext-fun'] }), buildSystemPrompt({ gateCats: ['search', 'ext-fun'] }));
});

// ── skill-bridge 映射层：skillGateCategories() 只收 LLM 型非 core ─────────────
test('skillGateCategories：skillId→类别映射（只收 kind=skill 且非 core）', async () => {
  const { skillGateCategories } = await import('../src/skill-bridge.js');
  skillManager.register(fakeSkill('sg-fun', 'ext-fun'));
  skillManager.register(fakeSkill('sg-plugin', 'ext-text', 'plugin'));
  skillManager.register(fakeSkill('sg-core', 'core'));
  try {
    const map = skillGateCategories();
    assert.equal(map['sg-fun'], 'ext-fun');
    assert.equal(map['sg-plugin'], undefined, '插件不进映射（其工具恒常驻）');
    assert.equal(map['sg-core'], undefined, 'core 不进映射（恒常驻）');
  } finally {
    for (const id of ['sg-fun', 'sg-plugin', 'sg-core']) skillManager.unregister(id);
  }
});
