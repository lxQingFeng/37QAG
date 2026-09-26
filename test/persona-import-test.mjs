// 2026-09-26 新增需求回归：① 出厂默认人设 37 → 小鲸鱼（botName/selfNickname/roleText 与
// 源头项目对齐，37 保留为可选；已存在的用户配置不被出厂默认覆盖）；
// ② data/personas/ 文件层新增 .txt / .md 纯文本导入 + .json 形态，与 meta 头 .md 共存；
// ③ 导入的人设走 sanitizeRoleText 安全链（与内置人设一致，不可用工具指引被裁掉）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qag-persona-import-'));
process.env.QAG_DATA_HOME = TMP;   // 必须在 import 之前设好（数据目录在模块加载时定根）

const { PERSONAS } = await import('../src/personas.js');
const { DEFAULT_CONFIG, loadConfig } = await import('../src/config.js');
const {
  parsePersonaContent,
  parsePersonaFile,
  listFilePersonas,
  mergedPersonaTemplates,
  PERSONA_FILE_EXTS
} = await import('../src/persona-files.js');
const { sanitizeRoleText } = await import('../src/prompt.js');
const { personasDir } = await import('../src/paths.js');

// ── ① 出厂默认人设 = 小鲸鱼 ─────────────────────────────────────────────

test('出厂默认人设 = 小鲸鱼（botName / selfNickname / roleText 与源头项目对齐）', () => {
  assert.equal(DEFAULT_CONFIG.persona.botName, '小鲸鱼');
  assert.equal(DEFAULT_CONFIG.persona.selfNickname, '小鲸鱼');
  assert.equal(DEFAULT_CONFIG.persona.roleText, PERSONAS.xiaojingyu.text);
});

test('37（qag37）保留为可选人设，未删除', () => {
  assert.ok(PERSONAS.qag37?.text);
  assert.match(PERSONAS.qag37.name, /37/);
  assert.match(PERSONAS.qag37.text, /# 角色卡：37/);
});

test('小鲸鱼人设名「小鲸鱼（默认）」名实相符（出厂默认就是它）', () => {
  assert.equal(PERSONAS.xiaojingyu.name, '小鲸鱼（默认）');
  assert.equal(DEFAULT_CONFIG.persona.roleText, PERSONAS.xiaojingyu.text);
});

test('已存在的用户配置不被出厂默认覆盖（37 老配置升级后仍是 37）', () => {
  // data/config.json 显式写过的 persona 字段在 deepMerge 中优先于出厂默认。
  // 本仓库 data/config.json 当前生效人设正是 37 —— 这里用临时目录复刻该形态。
  const legacy = {
    persona: {
      botName: '37',
      selfNickname: '37',
      roleText: PERSONAS.qag37.text,
      systemMode: 'lean'
    }
  };
  fs.writeFileSync(path.join(TMP, 'config.json'), JSON.stringify(legacy), 'utf8');
  const cfg = loadConfig();
  assert.equal(cfg.persona.botName, '37');
  assert.equal(cfg.persona.selfNickname, '37');
  assert.equal(cfg.persona.roleText, PERSONAS.qag37.text);
});

// ── ② txt / md / json 人设导入 ─────────────────────────────────────────

test('纯文本 .md：正文标题「# 角色卡：xxx」作为人设名，全文作为角色卡', () => {
  const p = parsePersonaContent('小白猫.md', '# 角色卡：小白猫\n\n你是小白猫，群里的猫娘。');
  assert.equal(p.id, '小白猫');
  assert.equal(p.name, '小白猫');
  assert.match(p.text, /^# 角色卡：小白猫/);
  assert.match(p.text, /猫娘/);
});

test('纯文本 .txt：无标题 → 人设名用文件名（去扩展名）', () => {
  const p = parsePersonaContent('laomao.txt', '你是老猫，潜水十年的群友。');
  assert.equal(p.id, 'laomao');
  assert.equal(p.name, 'laomao');
  assert.match(p.text, /老猫/);
});

test('纯文本卡：正文里的普通 HTML 注释不会被当 meta 头剥掉（self-impressions 标记完好）', () => {
  const card = '# 角色卡：老白\n\n性格：直男技术宅。\n<!--self-impressions:start-->\n- 潜水\n<!--self-impressions:end-->\n';
  const p = parsePersonaContent('laobai.md', card);
  assert.equal(p.name, '老白');
  assert.match(p.text, /self-impressions:start/);
});

test('.json 人设：{name,text} 解析，兼容 roleText 字段（与 customPersonas 形态共存）', () => {
  const p = parsePersonaContent('zidingyi.json', JSON.stringify({ name: '自定义猫', text: '# 角色卡：自定义猫\n你是猫。' }));
  assert.equal(p.id, 'zidingyi');
  assert.equal(p.name, '自定义猫');
  assert.match(p.text, /你是猫/);
  const p2 = parsePersonaContent('old.json', JSON.stringify({ name: '旧格式', roleText: '旧字段卡' }));
  assert.equal(p2.text, '旧字段卡');
});

test('坏文件全部跳过不崩：空文件 / 坏 JSON / 缺正文的 JSON / 乱后缀', () => {
  assert.equal(parsePersonaContent('empty.txt', '   \n\t '), null);
  assert.equal(parsePersonaContent('bad.json', '{oops'), null);
  assert.equal(parsePersonaContent('no-text.json', JSON.stringify({ name: 'x' })), null);
  assert.equal(parsePersonaContent('array.json', JSON.stringify([{ name: 'x' }])), null);
  assert.deepEqual([...PERSONA_FILE_EXTS].sort(), ['.json', '.md', '.txt']);
});

test('带 qag-persona meta 头的 .md（阶段四原始格式）解析行为不变', () => {
  const raw = '<!--\nqag-persona: v1\nid: laobai\nname: 老白（直男技术宅）\n-->\n# 角色卡：老白\n\n正文';
  const p = parsePersonaContent('laobai.md', raw);
  assert.equal(p.id, 'laobai');
  assert.equal(p.name, '老白（直男技术宅）');
  assert.match(p.text, /^# 角色卡：老白/);
  assert.ok(!p.text.includes('qag-persona'));
});

test('listFilePersonas：.txt/.md/.json 混合目录全部收录，坏文件跳过、非白名单后缀忽略', () => {
  fs.mkdirSync(personasDir(), { recursive: true });
  fs.writeFileSync(path.join(personasDir(), '小白猫.txt'), '# 角色卡：小白猫\n\n你是小白猫。', 'utf8');
  fs.writeFileSync(path.join(personasDir(), 'laomao.md'), '# 角色卡：老猫\n\n你是老猫。', 'utf8');
  fs.writeFileSync(path.join(personasDir(), 'wang.json'), JSON.stringify({ name: '网管', text: '你是网管。' }), 'utf8');
  fs.writeFileSync(path.join(personasDir(), 'broken.json'), '{bad', 'utf8');
  fs.writeFileSync(path.join(personasDir(), 'empty.txt'), '', 'utf8');
  fs.writeFileSync(path.join(personasDir(), 'ignore-me.docx'), '不是人设', 'utf8');
  const list = listFilePersonas({ log: () => {} });
  const ids = list.map((p) => p.id);
  assert.ok(ids.includes('小白猫'), 'txt 导入人设应被收录');
  assert.ok(ids.includes('laomao'), '纯 md 导入人设应被收录');
  assert.ok(ids.includes('wang'), 'json 导入人设应被收录');
  assert.ok(!ids.includes('broken') && !ids.includes('empty') && !ids.includes('ignore-me'));
  // parsePersonaFile（磁盘入口）与 parsePersonaContent（纯函数）行为一致
  const fromDisk = parsePersonaFile(path.join(personasDir(), '小白猫.txt'));
  assert.equal(fromDisk.id, '小白猫');
  assert.equal(fromDisk.name, '小白猫');
  assert.ok(fromDisk.file.endsWith('小白猫.txt'));
});

test('mergedPersonaTemplates：导入人设进入模板列表（自定义 = builtin:false），内置 5 人设不受影响', () => {
  const tpls = mergedPersonaTemplates({ log: () => {} });
  const byId = new Map(tpls.map((t) => [t.id, t]));
  assert.equal(byId.get('小白猫').builtin, false);
  assert.equal(byId.get('laomao').builtin, false);
  assert.equal(byId.get('wang').builtin, false);
  for (const id of Object.keys(PERSONAS)) {
    assert.ok(byId.get(id), `内置人设 ${id} 应仍在模板列表`);
  }
});

// ── ③ 导入人设走 sanitizeRoleText 安全链 ───────────────────────────────

test('导入的人设走 sanitizeRoleText 安全链：白名单外的工具指引被裁掉', async () => {
  const { updateConfig, getConfig } = await import('../src/config.js');
  const before = getConfig().api?.tools;
  try {
    updateConfig({ api: { tools: ['send_message', 'web_search'] } });
    const card = '# 角色卡：小白猫\n- 想发表情必须调用 send_sticker，别文字假装发\n- 发言必须 send_message\n- 查资料用 web_search';
    const imported = parsePersonaContent('小白猫.txt', card);
    const safe = sanitizeRoleText(imported.text);
    assert.ok(!safe.includes('send_sticker'), '被排除工具 send_sticker 的指引应被裁掉');
    assert.ok(safe.includes('send_message'), '白名单内 send_message 指引应保留');
    assert.ok(safe.includes('web_search'), '白名单内 web_search 指引应保留');
  } finally {
    updateConfig({ api: { tools: Array.isArray(before) ? before : [] } });
  }
});

test('导入人设与 .json 机制共存不冲突：文件层人设 + config.customPersonas 同屏共存', async () => {
  const { getConfig, updateConfig } = await import('../src/config.js');
  // 模拟旧机制里已存在的 customPersonas（config.json 内存储）
  const before = getConfig().customPersonas;
  try {
    updateConfig({ customPersonas: [{ name: '旧自定义人设', text: '旧卡' }] });
    const tpls = mergedPersonaTemplates({ log: () => {} });
    const byId = new Map(tpls.map((t) => [t.id, t]));
    assert.equal(byId.get('小白猫').text, '# 角色卡：小白猫\n\n你是小白猫。');
    assert.ok(byId.get('qag37'), '内置 37 仍在');
    // customPersonas 由 app.js 的调用方合并（三层），文件层不越俎代庖——这里验证文件层没被 custom 污染
    assert.ok(!tpls.some((t) => t.name === '旧自定义人设'));
  } finally {
    updateConfig({ customPersonas: Array.isArray(before) ? before : [] });
  }
});
