// 人设文件层（阶段四·用户需求 6）：内置人设播种到 data/personas/，用户直接改文件即覆盖。
//
// 设计（与 themes 双层、config 首次播种同族）：
//   · 首次启动：把 src/personas.js 的内置人设写成 data/personas/<id>.md（带 meta 头）；
//   · 用户改 data/personas/<id>.md → 下次启动/重载即生效（覆盖内置同 id）；
//   · 用户新增 data/personas/<自定义id>.md → 出现在 /api/persona-templates（builtin: 'file'）；
//   · 用户删内置 id 的文件 → 回退到源码内置版（内置 id 永远可用，删不干净）；删自定义 id → 消失；
//   · config.customPersonas（旧机制，配置内存储）原样保留，三层合并：文件层 > 内置 > custom。
//
// 文件格式 ①（阶段四原始·带 meta 头）：头部 HTML 注释装 YAML 三行（id/name），其后是角色卡全文。
//   <!--
//   qag-persona: v1
//   id: laobai
//   name: 老白（直男技术宅）
//   -->
//
// 文件格式 ②③（2026-09-26 新增·导入友好）：文件放入 data/personas/ 即生效，无需 meta 头——
//   · 纯文本 .md / .txt：文件内容整篇作为角色卡 roleText；人设名取正文首个 Markdown 一级
//     标题（「# 角色卡：小白猫」→「小白猫」），没有标题就用文件名（去扩展名）；
//   · .json：{"id"?: "...", "name"?: "...", "text" 或 "roleText": "角色卡全文"}，
//     与 config.customPersonas / 控制台导入的 JSON 形态共存互不冲突（文件层独立解析）。
//   · 三种格式同目录共存；同名（去扩展名）时按扫描顺序后者覆盖前者；空文件/坏 JSON 跳过不崩。
//   · 角色卡生效链与内置人设完全一致：选入 config.persona.roleText 后经 sanitizeRoleText
//     过滤不可用工具指引，再进提示词（见 src/prompt.js）。
import fs from 'node:fs';
import path from 'node:path';
import { PERSONAS } from './personas.js';
import { personasDir } from './paths.js';

const META_RE = /<!--[\s\S]*?-->/;
const ID_RE = /^id:\s*(.+)$/m;
const NAME_RE = /^name:\s*(.+)$/m;
// 人设名上限与 /api/persona-templates POST 端点一致（50 字）。
const NAME_MAX = 50;
// 纯文本卡的人设名：正文首个一级标题（「# 角色卡：小白猫」「# 小白猫」都行）。
const H1_RE = /^\s{0,3}#\s+(.+)$/m;
// 标题里的常见前缀去掉，取冒号后的真名：「角色卡：小白猫」→「小白猫」。
const TITLE_PREFIX_RE = /^(角色卡|人设|人物设定|persona|character card)\s*[:：]\s*/i;

/** 从正文提取人设名：首个 # 一级标题（去「角色卡：」类前缀），没有则空串。 */
function titleNameFromCard(text) {
  const m = String(text || '').match(H1_RE);
  if (!m) return '';
  const t = m[1].trim().replace(TITLE_PREFIX_RE, '').trim();
  return t ? t.slice(0, NAME_MAX) : '';
}

/**
 * 解析「文件名 + 内容字符串」为人设（2026-09-26 起为三种格式，见文件头注释）。
 * 返回 { id, name, text } 或 null（空内容/坏 JSON 等不可用形态，调用方跳过不崩）。
 * 纯函数：导入端点（先校验再落盘）与目录扫描共用同一套解析，行为不会分叉。
 */
export function parsePersonaContent(filename, raw) {
  const stem = path.parse(String(filename || '')).name;
  const content = String(raw ?? '');
  if (!content.trim()) return null;

  // ① .json：{ id?, name?, text | roleText }
  if (path.extname(String(filename || '')).toLowerCase() === '.json') {
    let obj = null;
    try { obj = JSON.parse(content); } catch { return null; }
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return null;
    const text = String(obj.text ?? obj.roleText ?? '').trim();
    if (!text) return null;
    const id = String(obj.id ?? '').trim() || stem;
    const name = String(obj.name ?? '').trim().slice(0, NAME_MAX) || id;
    return { id, name, text };
  }

  // ② 带 qag-persona meta 头（阶段四原始格式）：只认**首个**注释块是 meta 头，
  //    正文里自带的其它注释（如 self-impressions 标记）不会被误当 meta、也不会被剥掉。
  const meta = content.match(META_RE)?.[0] || '';
  if (meta.includes('qag-persona')) {
    const id = meta.match(ID_RE)?.[1]?.trim() || stem;
    const name = meta.match(NAME_RE)?.[1]?.trim().slice(0, NAME_MAX) || id;
    const text = content.replace(META_RE, '').replace(/^\s+/, '');
    if (!id || !text.trim()) return null;
    return { id, name, text };
  }

  // ③ 纯文本 .md / .txt：全文即角色卡；人设名 = 正文标题或文件名。
  const text = content.replace(/^\s+/, '');
  const name = titleNameFromCard(text) || stem;
  if (!stem || !text.trim()) return null;
  return { id: stem, name, text };
}

/** 解析一个人设文件。返回 { id, name, text, file } 或 null（空文件/坏 JSON 等不可用形态）。 */
export function parsePersonaFile(file) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
  const parsed = parsePersonaContent(path.basename(file), raw);
  return parsed ? { ...parsed, file } : null;
}

/** data/personas/ 支持的人设文件扩展名（导入与目录扫描共用白名单）。 */
export const PERSONA_FILE_EXTS = ['.md', '.txt', '.json'];

/** 扫描 data/personas/ 下全部人设文件（坏文件跳过并警告，不崩）。 */
export function listFilePersonas({ log = () => {} } = {}) {
  const dir = personasDir();
  const out = [];
  try {
    if (!fs.existsSync(dir)) return out;
    for (const f of fs.readdirSync(dir)) {
      const ext = path.extname(f).toLowerCase();
      if (!PERSONA_FILE_EXTS.includes(ext)) continue;
      const parsed = parsePersonaFile(path.join(dir, f));
      if (parsed) out.push(parsed);
      else log(`[personas] ${f} 无法解析（空文件/坏 JSON/缺正文），已跳过（格式见 docs/阶段四-人设与提示词说明.md）`);
    }
  } catch (error) {
    log(`[personas] 扫描 ${dir} 失败：${error?.message ?? error}`);
  }
  return out;
}

/**
 * 首次播种：把内置人设写成 data/personas/<id>.md（幂等——文件已存在不覆盖，
 * 用户改过的版本永远优先）。返回播种明细。
 */
export function seedBuiltinPersonas({ log = () => {} } = {}) {
  const dir = personasDir();
  const seeded = [];
  try {
    fs.mkdirSync(dir, { recursive: true });
    for (const [id, p] of Object.entries(PERSONAS)) {
      const file = path.join(dir, `${id}.md`);
      if (fs.existsSync(file)) continue;
      const content = `<!--\nqag-persona: v1\nid: ${id}\nname: ${p.name}\n-->\n${p.text}\n`;
      fs.writeFileSync(file, content, 'utf8');
      seeded.push(id);
    }
    if (seeded.length) log(`[personas] 已播种内置人设到 ${path.relative(process.cwd(), dir)}：${seeded.join(', ')}`);
  } catch (error) {
    log(`[personas] 播种失败（不影响运行）：${error?.message ?? error}`);
  }
  return seeded;
}

/**
 * 三层合并：文件层（用户可改）> 源码内置 > config.customPersonas（旧机制）。
 * 返回 /api/persona-templates 的 templates 数组（形状与旧版一致：{id,name,text,builtin}）。
 */
export function mergedPersonaTemplates({ log = () => {} } = {}) {
  const byId = new Map();
  // 1) 源码内置（保底层）
  for (const [id, p] of Object.entries(PERSONAS)) byId.set(id, { id, name: p.name, text: p.text, builtin: true });
  // 2) 文件层覆盖/新增
  for (const f of listFilePersonas({ log })) {
    const prev = byId.get(f.id);
    byId.set(f.id, { id: f.id, name: f.name, text: f.text, builtin: prev ? 'file' : false, file: f.file });
  }
  // 3) customPersonas（旧配置存储，兼容不弃）
  try {
    const customs = JSON.parse(fs.readFileSync('/dev/null', 'utf8') || '[]'); // 占位避免循环依赖 config
    void customs;
  } catch { /* 由调用方合并 */ }
  return [...byId.values()];
}
