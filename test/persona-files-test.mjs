// 阶段四回归：人设文件层（播种/解析/覆盖/合并）+ sanitizeRoleText（工具漂移兜底）。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qag-persona-'));
process.env.QAG_DATA_HOME = TMP;

const files = await import('../src/persona-files.js');
const { parsePersonaFile, listFilePersonas, seedBuiltinPersonas, mergedPersonaTemplates } = files;
const personas = await import('../src/personas.js');
const { PERSONAS } = personas;

test('内置人设清单：5 个且 id 唯一', () => {
  const ids = Object.keys(PERSONAS);
  assert.equal(ids.length, 5);
  assert.deepEqual([...ids].sort(), ['aluo', 'laobai', 'moshu', 'qag37', 'xiaojingyu']);
});

test('三个新人设：性格关键词互不重叠（差异明显）', () => {
  const t = {
    laobai: PERSONAS.laobai.text,
    aluo: PERSONAS.aluo.text,
    moshu: PERSONAS.moshu.text
  };
  // 各自的招牌性格词出现在自己卡里、不在另两张卡里（差异性的最小验证）
  assert.ok(t.laobai.includes('直球') && !t.aluo.includes('直球') && !t.moshu.includes('直球'));
  assert.ok(t.aluo.includes('元气') && !t.laobai.includes('元气') && !t.moshu.includes('元气'));
  assert.ok(t.moshu.includes('淡然') && !t.laobai.includes('淡然') && !t.aluo.includes('淡然'));
});

test('三个新人设：说话长度档位差异明显', () => {
  // 默认字数区间声明：老白 2~12 / 阿洛 1~15 / 墨叔 1~8 —— 墨叔最短是核心差异
  assert.ok(PERSONAS.moshu.text.includes('1～8 字'));
  assert.ok(PERSONAS.laobai.text.includes('2～12 字'));
  assert.ok(PERSONAS.aluo.text.includes('1～15字'));
});

test('三个新人设：来源化记忆 + 任务闭环工具指引齐备', () => {
  for (const id of ['laobai', 'aluo', 'moshu']) {
    const text = PERSONAS[id].text;
    assert.ok(text.includes('memory_search') || text.includes('memory_append'), `${id} 应有记忆工具指引`);
    assert.ok(text.includes('memory_todo_save'), `${id} 应有任务闭环指引`);
    assert.ok(text.includes('send_message'), `${id} 应有发言工具协议`);
  }
});

test('三个新人设：self-impressions 标记段（与 self-impressions.js 兼容）', () => {
  for (const id of ['laobai', 'aluo', 'moshu']) {
    const text = PERSONAS[id].text;
    assert.ok(text.includes('<!--self-impressions:start-->'), `${id} 缺 start 标记`);
    assert.ok(text.includes('<!--self-impressions:end-->'), `${id} 缺 end 标记`);
  }
});

test('播种：首次写入 5 个文件，幂等（第二次不再覆盖用户修改）', () => {
  const seeded1 = seedBuiltinPersonas({ log: () => {} });
  assert.equal(seeded1.length, 5);
  // 用户魔改 aluo
  const f = path.join(TMP, 'personas', 'aluo.md');
  fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('元气 6', '元气 9（魔改）'), 'utf8');
  // 再播种：不覆盖
  const seeded2 = seedBuiltinPersonas({ log: () => {} });
  assert.equal(seeded2.length, 0);
  assert.ok(fs.readFileSync(f, 'utf8').includes('魔改'), '用户版本应保留');
});

test('文件解析：meta 头 + 正文', () => {
  const dir = path.join(TMP, 'personas');
  const parsed = parsePersonaFile(path.join(dir, 'laobai.md'));
  assert.equal(parsed.id, 'laobai');
  assert.equal(parsed.name, '老白（直男技术宅）');
  assert.ok(parsed.text.startsWith('# 角色卡：老白'));
  assert.ok(!parsed.text.includes('qag-persona'), 'meta 头不应混入正文');
});

test('合并语义：文件层覆盖内置，自定义文件新增，坏文件跳过', () => {
  const dir = path.join(TMP, 'personas');
  // 新增自定义
  fs.writeFileSync(path.join(dir, 'zidingyi.md'),
    '<!--\nqag-persona: v1\nid: zidingyi\nname: 自定义测试\n-->\n# 角色卡：自定义\n测试正文', 'utf8');
  // 坏文件：2026-09-26 起纯文本 .md（无 meta 头）是合法导入格式，
  // 真正跳过的坏文件换成了空文件（解析层对空内容/坏 JSON 返回 null）。
  fs.writeFileSync(path.join(dir, 'bad.md'), '', 'utf8');
  const t = mergedPersonaTemplates({ log: () => {} });
  const ids = t.map((x) => x.id);
  assert.ok(ids.includes('zidingyi'), '自定义人设应出现');
  assert.ok(!ids.includes('bad'), '坏文件应被跳过');
  const aluo = t.find((x) => x.id === 'aluo');
  assert.ok(aluo.text.includes('魔改'), '文件层用户版应覆盖内置');
  assert.equal(aluo.builtin, 'file');
  const zdy = t.find((x) => x.id === 'zidingyi');
  assert.equal(zdy.builtin, false, '纯用户自定义不是内置');
});

test('sanitizeRoleText：白名单排除的工具指引被裁掉（防文字假装发事故）', async () => {
  const { sanitizeRoleText } = await import('../src/prompt.js');
  const { updateConfig, getConfig } = await import('../src/config.js');
  // stripUnavailableToolRules 的防御语义：裁掉 api.tools 白名单里排除的工具指引
  //（真实事故形态：send_sticker 被白名单撤掉 → 人设卡还教它用 → 模型文字假装发表情）
  const before = getConfig().api?.tools;
  try {
    updateConfig({ api: { tools: ['send_message', 'web_search'] } });   // 白名单只留两个
    const card = '# 角色卡\n- 想发表情必须调用 send_sticker，别文字假装发\n- 发言必须 send_message\n- 查资料用 web_search';
    const out = sanitizeRoleText(card);
    assert.ok(!out.includes('send_sticker'), '被排除工具 send_sticker 的指引应被裁掉');
    assert.ok(out.includes('send_message'), '白名单内 send_message 指引应保留');
    assert.ok(out.includes('web_search'), '白名单内 web_search 指引应保留');
  } finally {
    updateConfig({ api: { tools: Array.isArray(before) ? before : [] } });
  }
});

test('sanitizeRoleText：确定性（同输入同输出，缓存前缀稳定）', async () => {
  const { sanitizeRoleText } = await import('../src/prompt.js');
  const card = PERSONAS.moshu.text;
  assert.equal(sanitizeRoleText(card), sanitizeRoleText(card));
});
