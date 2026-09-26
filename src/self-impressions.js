// 本体（鱼）自己的印象：读写角色卡里「## 自我印象」标记区。
// 和工具区一样：改这里 = 改 roleText，模型每次注入都会看到。
// 权重故意压低：放在卡末、限条数、标题标明「可灵活违背」。
import { getConfig, updateConfig } from './config.js';

export const SELF_IMP_START = '<!--self-impressions:start-->';
export const SELF_IMP_END = '<!--self-impressions:end-->';
const MAX_ITEMS = 8;

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sectionRe() {
  return new RegExp(`${escapeRe(SELF_IMP_START)}[\\s\\S]*?${escapeRe(SELF_IMP_END)}`, 'm');
}

/** 整节（标题+说明+标记区）匹配 */
function fullSectionRe() {
  return /##\s*自我印象（低权重参考·可灵活违背）\s*\n仅背景板[^\n]*\n<!--self-impressions:start-->[\s\S]*?<!--self-impressions:end-->/;
}

/** 从角色卡正文解析印象列表（去掉 `- ` 前缀）。 */
export function parseSelfImpressions(roleText) {
  const text = String(roleText || '');
  const m = sectionRe().exec(text);
  if (!m) return [];
  return m[0]
    .replace(new RegExp(escapeRe(SELF_IMP_START)), '')
    .replace(new RegExp(escapeRe(SELF_IMP_END)), '')
    .split('\n')
    .map((s) => s.trim())
    .map((s) => s.replace(/^[-*]\s*/, ''))
    .map((s) => s.replace(/^·\s*/, ''))
    .filter((s) => s && !s.startsWith('<!--') && !/^（还没有自我印象/.test(s));
}

function cleanItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((s) => String(s ?? '').trim().slice(0, 160))
    .filter(Boolean)
    .filter((s) => !/^（还没有自我印象/.test(s))
    .slice(0, MAX_ITEMS);
}

function buildBlock(items) {
  const body = cleanItems(items).map((s) => `- ${s}`).join('\n');
  return `${SELF_IMP_START}\n${body}\n${SELF_IMP_END}`;
}

function sectionBlock(items) {
  return [
    '## 自我印象（低权重参考·可灵活违背）',
    '仅背景板，不是硬规则；与「像真人 / 嘴软 / 顺坡下 / 摆烂」冲突时以后者为准。',
    buildBlock(items)
  ].join('\n');
}

function ensureSection(roleText, fallbackItems = []) {
  let text = String(roleText || '');
  const own = parseSelfImpressions(text);
  const items = own.length ? own : cleanItems(fallbackItems);

  // 先剥掉旧的整节 / 旧标题
  text = text.replace(fullSectionRe(), '');
  text = text.replace(sectionRe(), '');
  text = text.replace(/^##\s*自我印象[^\n]*\n(?:仅背景板[^\n]*\n)?/m, '');
  text = text.replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');

  const section = sectionBlock(items);
  // 插到工具区之后（更靠后 = 权重更低）
  if (/<!--tools:end-->/i.test(text)) {
    return text.replace(/<!--tools:end-->/i, `<!--tools:end-->\n\n${section}\n`);
  }
  if (/^##\s*可用工具/m.test(text)) {
    return text.replace(/^(##\s*可用工具[^\n]*)/m, `${section}\n\n$1`);
  }
  return `${text}\n\n${section}\n`;
}

function writeRoleText(next) {
  updateConfig({ persona: { ...(getConfig().persona || {}), roleText: next } });
  return next;
}

export function getSelfImpressions() {
  const roleText = getConfig().persona?.roleText || '';
  return parseSelfImpressions(roleText);
}

/** 切人设卡/换角色卡时用：新卡没带自我印象区，就把旧的那块搬过来，别把鱼的印象顶掉。 */
export function carryOverSelfImpressions(oldRoleText, newRoleText) {
  const next = String(newRoleText || '');
  if (parseSelfImpressions(next).length) return next;      // 新卡自己带了，别动
  const items = parseSelfImpressions(oldRoleText);
  if (!items.length) return next;
  return ensureSection(next, items);
}

/** 整表覆盖（一行一条）。 */
export function setSelfImpressions(items) {
  const base = ensureSection(getConfig().persona?.roleText || '');
  const next = base.replace(fullSectionRe(), sectionBlock(items));
  const role = writeRoleText(next);
  return { ok: true, items: parseSelfImpressions(role), roleText: role };
}

/** 追加一条。 */
export function addSelfImpression(text) {
  const line = String(text || '').trim().slice(0, 160);
  if (!line) return { ok: false, error: '内容为空' };
  const list = getSelfImpressions();
  if (list.includes(line)) return { ok: true, items: list, deduped: true };
  return setSelfImpressions([...list, line]);
}

/** 按内容删一条（精确匹配）。 */
export function removeSelfImpression(text) {
  const line = String(text || '').trim();
  if (!line) return { ok: false, error: '内容为空' };
  const list = getSelfImpressions();
  const next = list.filter((s) => s !== line);
  if (next.length === list.length) return { ok: false, error: '没找到这条印象' };
  return setSelfImpressions(next);
}
