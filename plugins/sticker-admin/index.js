// 表情包管理 · 插件服务端（确定性型）
//
// ── 这个插件做什么 ───────────────────────────────────────────────────────
// 给「设置 → 表情包库」那块面板当后端：列出表情库里全部表情与提示词（带预览图），
// 支持新增（可一次多张）/删除/改提示词，新增时可以让模型看图自动写一句提示词。
//
// ── 它靠什么拿到表情库 ───────────────────────────────────────────────────
// 表情库（运行期 StickerManager + data/stickers.json）**没有 HTTP 接口**，也没有
// 任何"给插件用的写入口"。本插件用三个既有机制把它接到控制台：
//
//   ① 拦截声明（intercept）—— 拿到核心句柄（改库要用它）
//      清单里声明 intercept.capability = 'sticker.host-tap' 之后，「指令前置」插件会在
//      每条消息进入会话前**同步**问一次本插件（见 command-gateway/index.js 的
//      interceptChain / askInterceptor），payload.ctx.host 里带着核心句柄：
//      stickers / onebot / getConfig / updateConfig …
//      ⚠️ 句柄里有哪几项**看核心与「指令前置」的版本**：「指令前置」1.4.x 起 host 里不再带
//         chat（见 askModel 的分层说明），所以这里只记引用、用的时候逐项判断，别假定某一项一定在。
//         所以这里只记引用、用的时候逐项判断，别假定某一项一定在。
//      我们只把引用记下来，**永不认领消息**（返回 { handled: false }），对聊天零影响。
//
//   ② 插件自己的配置段 —— 双向数据通道（不碰插件目录里的文件）
//      界面 → 插件：设置页 ctx.save({ pending }) 写 config.skills['sticker-admin'].pending
//      插件 → 界面：把 snapshot 写回同一段；界面轮询 GET /api/config 读它渲染。
//
//   ③ 直接 import 核心的 config 模块（只在 ② 写不出去时兜底）
//      插件和核心跑在同一个进程、同一套 ESM 模块图里，所以
//      `import('../../src/config.js')` 拿到的是**同一份模块实例**（同一份 currentConfig），
//      updateConfig / getConfig / DATA_DIR 都是核心那套真家伙。
//      ⚠️ 只用在两处：写快照、判断插件是否被关闭。
//        · 写快照：核心句柄要等第一条消息才有，而"只是想看看库里有啥"不该等消息；
//        · 判断开关：热重载后 setup 一定会跑，但被关掉的插件不该继续轮询写盘。
//      两条路都写不出去时静默放弃（界面会显示"还没读到快照"），绝不抛错。
//      ⚠️ 用动态 import 而不是顶层 import：核心万一把文件挪了，这里只是降级，不会加载失败。
//
// ── 为什么不用"往插件目录写 state.json / 缩略图"那条路（踩过的坑，别改回去）──
// 控制台确实有只读静态路由 /plugin-assets/<插件id>/<文件>，看起来正合适。但核心的
// 热重载 watcher 是 fs.watch(plugins/, { recursive: true }) —— **插件目录里任何文件
// 变化都会触发一次全量重扫**，重扫会先 deactivate 旧实例、再跑新 setup。
// 结果是：写文件 → 触发重扫 → 定时器被拆掉重建 → 1.5 秒的 tick 永远等不到 → 什么都写不出去。
// 而且它会自我维持（新实例又写一次）。日志里的表现是每秒一次的
// "检测到变化：…，重新扫描…"，插件实例被反复重建。
// 结论：**插件绝不能往自己目录里写任何东西**。缩略图同理 —— 所以预览图是
// "在内存里生成 data URL、跟着快照进配置"（见 thumbOf），而不是落成文件。
//
// ── 缩略图（预览）是怎么来的 ─────────────────────────────────────────────
// 控制台没有任何路由能读到 data/ 下的图片（/plugin-assets/ 只服务插件目录，而插件目录
// 不能写；/api/media-data 只认协议端缓存和公网地址），所以预览只能由插件自己解码：
//   · 首选 electron 的 nativeImage（插件跑在主进程里，能 require 到）：
//     createFromBuffer → resize(高 112) → 按真实 alpha 选 toPNG/toJPEG(68) → data URL，约 2KB/张；
//   · GIF 和个别伪装扩展名的文件 nativeImage 解不了 → 退回
//     nativeImage.createThumbnailFromPath（Windows/macOS 的系统缩略图，能出 GIF 首帧）；
//   · 还不行就只留占位（界面显示文件名）。非 Electron 环境（纯 node 跑）全部走占位。
// 代价：缩略图会随快照写进 config.json（21 张实测 ≈116KB），所以有 MAX_THUMBS 上限。
//
// ── 代价（界面上有明说）──────────────────────────────────────────────────
//   · 增删改是"提交 → 最多 1.5 秒后生效"的异步模型（核心没给写接口）；
//   · 核心句柄要等**第一条消息**经过会话入口才有（分发上下文只在消息入口产生），
//     在那之前面板是只读的：列表能看（读盘上的 stickers.json），按钮改不了。
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PLUGIN_DIR = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ID = path.basename(PLUGIN_DIR);      // 目录名就是插件 id，不硬编码
const APP_ROOT = path.resolve(PLUGIN_DIR, '..', '..');

const TICK_MS = 1500;                 // 轮询间隔：够快（体感即时）又不至于空转太多
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const NOTE_MAX = 400;                 // 提示词长度上限（写进 stickers.json，别无限膨胀）
const DESC_MAX = 24;                  // desc 是提示词摘要里显示的那行（buildStickerContext 用）
const MAX_ITEMS = 300;                // 快照里最多列这么多条（快照最终落在 config.json 里）
const MAX_THUMBS = 150;               // 最多给前 N 条生成预览图（config.json 体积上限）
const THUMB_HEIGHT = 112;             // 预览图高度（宽按比例）；112px 配 190px 的格子够用
const THUMB_QUALITY = 68;             // JPEG 质量。21 张实测合计 ≈116KB
// 快照结构版本号：改了 items 的字段语义就 +1，强制界面在升级后重读一次旧快照
// （否则"新字段在旧快照里恒为默认值"会让签名撞车，界面一直用着升级前的渲染）。
// v3：快照顶层新增 tagDefs / tagGroups（界面靠它给标签分组上色，表只此一份）。
const SNAP_VERSION = 3;

// ── 标签（Tag）体系 ───────────────────────────────────────────────────────
//
// 存进 stickers.json 的是**中文标签本身**（entry.tags），不是英文 id —— 因为核心
// buildStickerContext 会把 `tags.join('/')` 原样拼进模型每轮看到的摘要行，核心的
// list_stickers 搜索也拿 tags 当 haystack：存中文，模型读着直观、中文 query 也能命中。
//
// 分组信息只活在这张表里（界面通过快照里的 tagDefs 拿到），所以改中文名只要跑一次
// 「批量重打标签」就能整体迁移，不用碰历史数据。
//
// 匹配：对提示词做**包含匹配**（中文不分词），命中词的字数之和当权重 —— 长词更有
// 代表性（"笑死"比"笑"更能说明是爆笑）。组内按权重取前 N，组间互不挤占。

const TAG_GROUPS = [
  { id: 'emotion', label: '情绪', max: 2 },
  { id: 'usage', label: '用法', max: 2 },
  { id: 'subject', label: '题材', max: 2 },
  { id: 'scope', label: '适配', max: 1 }
];

/** 组 → 序号。标签一律按这个顺序摆（存储、提示词、界面都用它），跟着上面 TAG_GROUPS 的先后走。 */
const TAG_GROUP_ORDER = new Map(TAG_GROUPS.map((g, i) => [g.id, i]));

const TAGS = [
  // 情绪
  { id: 'happy', label: '开心', group: 'emotion', words: ['开心', '高兴', '快乐', '美滋滋', '窃喜', '满足', '愉快', '治愈', '暖'] },
  { id: 'laugh', label: '爆笑', group: 'emotion', words: ['爆笑', '笑死', '笑喷', '大笑', '哈哈哈', '笑疯', '笑抽', '笑崩'] },
  { id: 'cry', label: '哭/委屈', group: 'emotion', words: ['哭', '流泪', '呜呜', '委屈', '伤心', '难过', '破防', '感动'] },
  { id: 'sad', label: '丧/低落', group: 'emotion', words: ['丧', '低落', '空虚', '抑郁', 'emo', '没劲', '颓'] },
  { id: 'angry', label: '生气', group: 'emotion', words: ['生气', '愤怒', '暴怒', '发火', '气炸', '暴躁', '骂人', '发怒'] },
  { id: 'speechless', label: '无语', group: 'emotion', words: ['无语', '白眼', '服了', '扶额', '懒得说', '沉默'] },
  { id: 'awkward', label: '尴尬', group: 'emotion', words: ['尴尬', '社死', '尬', '抠脚', '脚趾'] },
  { id: 'shock', label: '震惊', group: 'emotion', words: ['震惊', '惊讶', '离谱', '目瞪口呆', '啊这', '惊呆'] },
  { id: 'panic', label: '慌张', group: 'emotion', words: ['慌', '紧张', '害怕', '恐惧', '手忙脚乱', '瑟瑟发抖', '着急'] },
  { id: 'disgust', label: '嫌弃', group: 'emotion', words: ['嫌弃', '呕', '恶心', 'yue', '退退退', '嫌'] },
  { id: 'proud', label: '得意', group: 'emotion', words: ['得意', '嚣张', '嘚瑟', '骄傲', '拿捏', '自信'] },
  { id: 'calm', label: '淡定', group: 'emotion', words: ['淡定', '佛系', '平静', '无所谓', '看破'] },
  { id: 'doubt', label: '疑惑', group: 'emotion', words: ['疑惑', '问号', '不解', '纳闷'] },
  { id: 'love', label: '喜欢', group: 'emotion', words: ['喜欢', '心动', '亲亲', '抱抱', '贴贴', '害羞', '脸红'] },
  { id: 'tired', label: '困累', group: 'emotion', words: ['困', '累', '疲惫', '想睡', '打哈欠', '熬', '没精神'] },
  // 用法
  { id: 'greet', label: '打招呼', group: 'usage', words: ['打招呼', '问好', '你好', '早安', '报到', '报道'] },
  { id: 'thanks', label: '道谢', group: 'usage', words: ['谢谢', '感谢', '多谢', '感激'] },
  { id: 'apologize', label: '道歉', group: 'usage', words: ['道歉', '对不起', '抱歉', '认错', 'sorry'] },
  { id: 'refuse', label: '拒绝', group: 'usage', words: ['拒绝', '不行', '不干', '不约'] },
  { id: 'agree', label: '认同', group: 'usage', words: ['认同', '同意', '点赞', '没错', '确实', '赞成', '收到'] },
  { id: 'mock', label: '嘲讽', group: 'usage', words: ['嘲讽', '阴阳', '讽刺', '挖苦', '内涵', '反讽', '怼', '调侃', '吐槽'] },
  { id: 'tease', label: '逗乐', group: 'usage', words: ['逗乐', '逗', '撩', '皮一下', '整活', '搞怪', '玩梗'] },
  { id: 'urge', label: '催促', group: 'usage', words: ['催', '快点', '赶紧', '催更', '在吗'] },
  { id: 'comfort', label: '安慰/打气', group: 'usage', words: ['安慰', '别难过', '摸摸头', '稳住', '加油', '打气', '奥利给'] },
  { id: 'farewell', label: '告别', group: 'usage', words: ['拜拜', '再见', '溜了', '走了', '下班', '睡了', '告别'] },
  { id: 'askhelp', label: '求助', group: 'usage', words: ['求助', '帮帮', '带带', '救命', '救救'] },
  { id: 'flex', label: '炫耀', group: 'usage', words: ['炫耀', '凡尔赛', '厉害吧', '晒一晒'] },
  { id: 'slack', label: '摸鱼', group: 'usage', words: ['摸鱼', '摆烂', '划水', '偷懒', '躺平'] },
  // 题材
  { id: 'animal', label: '动物', group: 'subject', words: ['猫', '狗', '狗头', '柴犬', '熊猫', '兔', '仓鼠', '动物'] },
  { id: 'anime', label: '动漫', group: 'subject', words: ['动漫', '二次元', '卡通', '动画', '番剧', 'cos'] },
  { id: 'realperson', label: '真人', group: 'subject', words: ['真人', '明星', '影视', '演员', '剧照', '爱豆'] },
  { id: 'textmeme', label: '文字梗', group: 'subject', words: ['文字', '梗图', '配文', '弹幕'] },
  { id: 'baby', label: '萌娃', group: 'subject', words: ['小孩', '萌娃', '宝宝', '婴儿'] },
  { id: 'food', label: '美食', group: 'subject', words: ['吃', '美食', '吃货', '零食', '奶茶', '宵夜'] },
  { id: 'game', label: '游戏', group: 'subject', words: ['游戏', '原神', '王者', '开黑', '上分'] },
  { id: 'holiday', label: '节日', group: 'subject', words: ['节日', '春节', '新年', '圣诞', '生日', '中秋'] },
  // 适配（只在命中时写入，"通用"不占地方）
  { id: 'risky', label: '慎发', group: 'scope', words: ['骂人', '脏话', '擦边', '重口', '血腥', '惊悚', '恐怖', '不适'] }
];

// 撞车时的压制关系：[赢家, 输家]。两者都命中时只留赢家，避免"又哭又丧""既嘲讽又逗乐"。
const TAG_SUPPRESS = [
  ['laugh', 'happy'],
  ['cry', 'sad'],
  ['panic', 'shock'],
  ['disgust', 'speechless'],
  ['mock', 'tease']
];

const TAG_MAX_TOTAL = 5;          // 单个表情最多挂几个标签（提示词里那行别太长）

/** 界面渲染用的标签表（不含关键词，省快照体积）。 */
function tagDefs() {
  return {
    groups: TAG_GROUPS.map((g) => ({ id: g.id, label: g.label, max: g.max })),
    defs: TAGS.map((t) => ({ id: t.id, label: t.label, group: t.group }))
  };
}

/** 标签 → 所属组（按中文名查，因为库里存的就是中文名）。 */
const TAG_GROUP_OF = new Map(TAGS.map((t) => [String(t.label), String(t.group)]));

/**
 * 把一串标签按分类排好：情绪 → 用法 → 题材 → 适配，组内保持原先后。
 *
 * 为什么在服务端也要排：标签是**要落盘、并且模型每一轮都会看到**的东西
 * （核心 src/stickers.js 会把 tags 拼进提示词那一行）。早先写入顺序跟着"匹配得分"
 * 走，同一张卡这次存成「无语/嘲讽」、下次可能变成「嘲讽/无语」—— 内容一样、
 * 顺序在抖，看着像两份数据，模型读到的也前后不一致。
 * 不在表里的标签（改过标签表之后残留的旧标签）排最后，不会被丢掉。
 */
function sortTags(labels) {
  return labels
    .map((label, i) => ({
      label,
      i,
      k: TAG_GROUP_ORDER.has(TAG_GROUP_OF.get(String(label)))
        ? TAG_GROUP_ORDER.get(TAG_GROUP_OF.get(String(label)))
        : 99
    }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.label);
}

/**
 * 按提示词算出标签（中文数组）。
 *
 * 一个都没命中就返回空数组 —— 界面标「未打标」，可以手点，也可以「批量重打标签」。
 * 这里**不再调用模型**：识图那一次请求的原文里就已经有情绪和场合了，本地匹配既免费
 * 又不受模型返回格式影响。
 */
function tagsFromText(text) {
  const s = String(text || '').toLowerCase();
  if (!s) return [];
  const hits = [];
  for (const t of TAGS) {
    let score = 0;
    for (const w of t.words) if (s.includes(w)) score += w.length;
    if (score > 0) hits.push({ t, score });
  }
  if (!hits.length) return [];

  const alive = new Set(hits.map((h) => h.t.id));
  for (const [winner, loser] of TAG_SUPPRESS) {
    if (alive.has(winner) && alive.has(loser)) alive.delete(loser);
  }

  const order = new Map(TAGS.map((t, i) => [t.id, i]));
  const ranked = hits
    .filter((h) => alive.has(h.t.id))
    .sort((a, b) => (b.score - a.score) || ((order.get(a.t.id) || 0) - (order.get(b.t.id) || 0)));

  const usedByGroup = {};
  const out = [];
  for (const h of ranked) {
    if (out.length >= TAG_MAX_TOTAL) break;
    const g = h.t.group;
    const max = (TAG_GROUPS.find((x) => x.id === g) || {}).max || 1;
    usedByGroup[g] = usedByGroup[g] || 0;
    if (usedByGroup[g] >= max) continue;
    usedByGroup[g] += 1;
    out.push(h.t.label);
  }
  // 出库前统一按分类排。组内仍是"命中得分高的在前"（sortTags 是稳定排序，见它自己的注释）。
  return sortTags(out);
}

// 识图（AI 写提示词）的输出额度。**别往小里调** ——
// 本机在用的模型是"先思考、再作答"的推理模型：额度给小了，思考会把预算吃光，
// 响应变成 finish_reason=length + content 为空（正文一个字都没有）。
// 实测（sensenova-6.8-flash-lite + 一张 27KB 表情）：
//   max_tokens=300  → completion_tokens 300 全是 reasoning_tokens，content 为空；
//   max_tokens=1200 → 思考 519 + 正文 25，正常返回一句提示词。
// 核心主链路（src/orchestrator.js）用的也是 1200，这里与它对齐。
const VISION_MAX_TOKENS = 1200;
// 万一 1200 仍不够（换个更能思考的模型），再给一次更大的额度重试一次。
const VISION_RETRY_TOKENS = 2400;

const MIME_BY_EXT = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp'
};

let api = null;
let host = null;
let ctxChat = null;            // 与 host 并列的 chat（个别版本的 ctx 只给这一份，见 askModel）
let timer = null;
let ticking = false;
let alive = false;
let lastSig = '';
let dataDir = '';
let coreMgr = null;            // 懒加载的核心 skills/manager 模块（拿本插件在注册表里的那条记录）
let coreMgrTried = false;
let savedSettingsUi = null;    // 清单里原本的 settingsUi：置空前先存一份，启用时要原样放回去

// ── 生命周期 ─────────────────────────────────────────────────────────────

export function setup(a) {
  api = a;
  alive = true;
  dataDir = resolveDataDir();
  startTimer();
  api?.log?.(`表情包管理已就绪（数据目录：${dataDir || '未知'}）；改库要等机器人收到第一条消息后生效`);
  // 核心 config 模块是异步 import：拿到之后数据目录的推导口径会与核心完全一致。
  void coreConfig().then(() => {
    const next = resolveDataDir();
    if (next && next !== dataDir) dataDir = next;
  });
  // 对齐"设置左栏该不该有本插件入口"。必须用**宏任务**延后：
  // setup 返回后核心还要 await 一次才 register()，此刻注册表里还是旧实例（首次加载时干脆没有），
  // 改错了对象等于白改；宏任务一定跑在 register 之后。
  setTimeout(() => { syncSettingsEntryBest(); }, 0);
}

// 切开关时用同步版：配置已先写好（routes.js:989 先 setSkillEnabled 再跑生命周期），
// 所以这里读到的 enabled 一定是新值，能当场改对，接口那次响应就是对的。
export function activate() { alive = true; startTimer(); syncSettingsEntryBest(); }
export function deactivate() { alive = false; stopTimer(); syncSettingsEntryBest(); }
export function dispose() { alive = false; stopTimer(); }

function startTimer() {
  if (timer) return;
  timer = setInterval(() => { void tick(); }, TICK_MS);
  timer.unref?.();          // 不拦进程退出
}

function stopTimer() {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

// ── 与核心的桥 ───────────────────────────────────────────────────────────
//
// 拿到核心能力只有"读现成的"这一条思路，不改核心任何文件：
//   ① host（分发上下文给的句柄）：能改库（stickers 是运行期单例）
//   ② 直接 import 核心模块：config 读写配置、llm 走模型链路 —— 都是同一份实例

let coreMod;          // 懒加载的核心 config 模块
let coreTried = false;

async function coreConfig() {
  if (!coreTried) {
    coreTried = true;
    try {
      coreMod = await import('../../src/config.js');
    } catch {
      coreMod = null;             // 核心改结构了 / 不是 Electron 环境：降级，不抛错
    }
  }
  return coreMod;
}

// 模型链路（识图要用）。与上面 config 同理：同一进程、同一套 ESM 模块图，
// 直接 import 拿到的是核心正在跑的那一份（同一份 key / 模型 / 重试与计费链路）。
let coreLlm;          // 懒加载的核心模型模块
let coreLlmTried = false;

async function coreModel() {
  if (!coreLlmTried) {
    coreLlmTried = true;
    try {
      coreLlm = await import('../../src/llm.js');
    } catch {
      coreLlm = null;             // 核心改结构了 / 不是本仓库布局：降级，由调用方报原因
    }
  }
  return coreLlm;
}

/**
 * 让模型回答一次（识图走这条路）。返回核心那份原始回包（{ message, usage, … }）。
 *
 * ── 为什么分三层退，不能只写 host.chat（踩过的坑，别改回去）────────────────
 * 核心在分发上下文里给插件的那个句柄，**各版本给的东西不一样**：
 *   · 1.3.1：核心 src/app.js 里内联那个 host 对象，里面有 chat（见该文件那段注释）
 *   · 1.4.x：换成 makePluginHost() 造的对象，**字段里没有 chat** —— 在 1.4.3 的
 *            patches/src__app.js__dispatch.js 里能直接看到：列到 updateConfig 就结束了。
 *            于是只写 host.chat 的老代码一调就抛 `host.chat is not a function`，
 *            用户看到的就是"识图失败：host.chat is not a function"。
 * 好在 1.4.x 仍在 ctx 上单独留了一份 chat（同一处 `chat: (messages, options) => …`），
 * 所以②层能顶上；万一哪天连这份都没了，③层还能直接走核心的 src/llm.js。
 * 所以按可靠性依次退，能用哪层用哪层：
 *   ① host.chat   新版本句柄上带的口子（首选：就是核心自己那条链路）
 *   ② ctx.chat    与 host 并列的那一份（个别版本只有这个）
 *   ③ 直接 import 核心的 src/llm.js → chatCompletionWithRetry
 *                 前两条都没有时仍然可用；与读写配置走的是同一条既有路子
 * 三层都拿不到才抛错，而且**说清是版本太老**，不把 TypeError 甩给用户。
 *
 * @param {Array} messages OpenAI 形态的消息数组（识图那条里带 image_url 分片）
 * @param {{ maxTokens?: number }} options
 */
async function askModel(messages, options = {}) {
  const maxTokens = Number(options.maxTokens) || 0;
  if (typeof host?.chat === 'function') {
    return await host.chat(messages, { maxTokens });
  }
  if (typeof ctxChat === 'function') {
    return await ctxChat(messages, { maxTokens });
  }
  const m = await coreModel();
  if (typeof m?.chatCompletionWithRetry === 'function') {
    return await m.chatCompletionWithRetry({ messages, temperature: null, maxTokens });
  }
  throw new Error('这个版本的 QQ Agent 没把「模型调用」交给插件（ctx.host.chat 与核心 src/llm.js 都拿不到），识图用不了；可以先手动填提示词');
}

/**
 * 数据根目录。来源按权威性排序：
 *   1. 核心 config 模块的 DATA_DIR —— 与核心自己用的完全一致（含 QQ_AGENT_DATA_DIR/PROFILE）
 *   2. api.storage.dir（<数据根>/command_data/<插件id>/ → 往上两级）
 *      —— 这个字段来自 command-gateway 给核心打的 [[command-gateway:loader-api]] 补丁
 *   3. 自己按核心同一套规则推导（src/config.js：QQ_AGENT_DATA_DIR > PROFILE > <仓库>/data）
 */
function resolveDataDir() {
  try {
    if (coreMod?.DATA_DIR) return path.resolve(coreMod.DATA_DIR);
  } catch { /* 继续往下试 */ }
  try {
    const dir = api?.storage?.dir;
    if (dir) return path.resolve(dir, '..', '..');
  } catch { /* 没有就走下面 */ }
  const env = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (env) return path.resolve(env);
  const profile = String(process.env.QQ_AGENT_PROFILE || '').trim();
  const suffix = /^\d+$/.test(profile) ? `-${profile}` : '';
  return path.resolve(APP_ROOT, `data${suffix}`);
}

/** 插件当前是不是被关着（关着的插件不该继续轮询写盘）。 */
function pluginEnabled() {
  try {
    const seg = coreMod?.getConfig?.()?.skills?.[PLUGIN_ID];
    if (seg && typeof seg === 'object') return seg.enabled !== false;
  } catch { /* 读不到就当启用 */ }
  try {
    const own = api?.config?.();
    if (own && typeof own === 'object') return own.enabled !== false;
  } catch { /* 同上 */ }
  return true;
}

// ── 让设置左栏的「表情包库」入口跟随启用状态 ─────────────────────────────
//
// 问题：控制台设置页左栏的分区清单由 ui/app/06-settings-render.js 的 pluginSections() 拼出，
// 它的过滤条件是 `s.settingsUi && s.loaded !== false`。而 loaded 的语义是"清单/入口能不能
// 正常加载"（src/skills/manager.js：loaded = !skill.loadError），**跟启用与否无关** ——
// 实测停用的插件 loaded 依然是 true。于是插件被关掉之后，设置左栏仍然留着「表情包库」，
// 点进去是个不能操作的死面板；用户找了一圈也看不出"它已经关了"。
//
// 做法：不改核心文件，改**内存里的清单对象**。可行是因为三点，都在源码里核对过：
//   ① status() 返回的 settingsUi 直接读 skill.manifest.settingsUi，而注册表里存的就是
//      加载器 new 出来的那个活对象 —— 改它，/api/skills 立刻跟着变；
//   ② 切开关（src/routes.js 的 POST /api/skills/:id）只调 activate/deactivate，
//      **不会重新读 plugin.json**，所以内存里的改动不会被立刻读盘覆盖；
//   ③ 切开关的顺序是"先写配置、再跑生命周期"，所以 activate/deactivate 里读到的
//      enabled 一定是**新值**，判断不会差一拍。
// 重新启用时会走 activate()，把存下来的 settingsUi 原样放回去；软件重启/热重载则重新读盘，
// setup() 里那次宏任务再按当时的启用状态对齐一遍。
//
// 为什么这样是安全的：任何一步拿不到（核心改了结构、manager 模块 import 失败、注册表里
// 没有本插件）都直接 return —— 结果是"入口照旧显示"，也就是退回今天的行为；
// 绝不会出现"入口被误删、用户再也找不到面板"。
// 另外：扩展页那张卡片上的齿轮按钮只依赖 configSchema 的字段数，不受这里影响。
async function coreManager() {
  if (!coreMgrTried) {
    coreMgrTried = true;
    try {
      coreMgr = await import('../../src/skills/manager.js');
    } catch {
      coreMgr = null;             // 核心改结构了 / 不是本仓库布局：降级，不抛错
    }
  }
  return coreMgr;
}

/**
 * 同步版：核心 manager 模块已经在手时，**立刻**对齐，一个微任务都不让。
 *
 * 为什么强调"同步"：切开关的接口（src/routes.js:1014）是「跑完生命周期 → 同步取状态 → 立刻回响应」，
 * 中间不留 await。这里若退化成异步（哪怕只差一个微任务），那次响应带出去的就是**旧值** ——
 * 界面把响应写进本地列表，就会出现"开关关了、左栏入口还在"的一拍不一致。
 * （实测过：异步版下 POST 响应里仍带着旧清单，靠界面紧接着重拉一次列表才修正。别依赖那个补救。）
 * 返回 false = 核心模块还没 import 完，调用方退回异步版。
 */
function syncSettingsEntryNow() {
  try {
    const manifest = coreMgr?.skillManager?.registry?.get(PLUGIN_ID)?.manifest;
    if (!manifest) return false;
    if (manifest.settingsUi) savedSettingsUi = manifest.settingsUi;   // 先留底，才敢置空
    if (pluginEnabled()) {
      if (!manifest.settingsUi && savedSettingsUi) manifest.settingsUi = savedSettingsUi;
    } else if (manifest.settingsUi) {
      manifest.settingsUi = null;      // null 是 pluginSections() 的判定口径：falsy → 不进侧栏
    }
    return true;
  } catch {
    return false;   // 拿不到就保持原样：宁可多一个入口，也不能把入口弄丢
  }
}

/** 异步版：核心模块还没就绪时用（软件刚启动、首次加载那一刻）。幂等，随便调。 */
async function syncSettingsEntry() {
  try {
    await coreManager();
    syncSettingsEntryNow();
  } catch { /* 同上：保持原样 */ }
}

/** 优先同步对齐，核心模块确实还没就绪才退异步。 */
function syncSettingsEntryBest() {
  if (!syncSettingsEntryNow()) void syncSettingsEntry();
}

/** 把插件自己这一段配置写回去。两条路，都不需要额外权限。 */
function writePluginConfig(segment) {
  const patch = { skills: { [PLUGIN_ID]: segment } };
  try {
    if (host?.updateConfig) { host.updateConfig(patch); return true; }
  } catch (error) {
    api?.warn?.('经核心句柄写配置失败：', error?.message ?? error);
  }
  try {
    if (typeof coreMod?.updateConfig === 'function') { coreMod.updateConfig(patch); return true; }
  } catch (error) {
    api?.warn?.('经核心 config 模块写配置失败：', error?.message ?? error);
  }
  return false;
}

// ── 扩展点：拦截链上的一员，只做一件事 —— 把核心句柄记下来 ───────────────
//
// 硬约束：拦截者必须**同步**返回 { handled }（核心要立刻决定这条消息要不要诞生会话）。
// 我们这里只做一次引用赋值 + 顺手踢一次异步刷新，然后立刻放行。

export const providers = {
  'sticker.host-tap': (payload = {}) => {
    const ctx = payload?.ctx || null;
    const h = ctx?.host || null;
    // 与 host 并列的那份 chat：有的版本只在 ctx 这一层给（见 askModel 的分层说明）
    const c = typeof ctx?.chat === 'function' ? ctx.chat : null;
    let changed = false;
    if (h && h !== host) { host = h; changed = true; }
    if (c && c !== ctxChat) { ctxChat = c; changed = true; }
    if (changed) {
      // 句柄刚到手：立刻把积压的操作跑掉、把快照发出去，不用等下一个 tick。
      queueMicrotask(() => { void tick(); });
    }
    return { handled: false };
  }
};

// ── 主循环 ───────────────────────────────────────────────────────────────

async function tick() {
  if (ticking || !api || !alive) return;
  ticking = true;
  try {
    // 插件被关掉了：停表（用户再打开时会走 activate() 重新起表）。
    // setup() 一定会跑（加载即 setup），所以这里必须自己判断一次，
    // 否则"关着的插件"也会一直轮询、一直写配置。
    if (!pluginEnabled()) { stopTimer(); return; }
    // 操作要写库，依赖核心句柄；句柄没来就先攒着（界面会显示"只读"）。
    if (host?.stickers) await applyPending();
    await publishSnapshot();
  } catch (error) {
    api.warn?.('轮询失败：', error?.message ?? error);
  } finally {
    ticking = false;
  }
}

/** 表情库当前条目：优先运行期单例（权威）；句柄还没来就退回读盘（只读）。 */
function liveEntries() {
  const list = host?.stickers?.entries;
  if (Array.isArray(list)) return list;
  return readStoreFile();
}

function readStoreFile() {
  if (!dataDir) dataDir = resolveDataDir();
  if (!dataDir) return [];
  try {
    const text = fs.readFileSync(path.join(dataDir, 'stickers.json'), 'utf8').replace(/^\uFEFF/, '');
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * 落盘表情库。
 *
 * 这里**不是**"绕过单例改文件"——写进去的正是单例内存里那份 entries（我们是在同一个
 * 数组引用上做增删的），与核心 saveStickerStore 做的事一致，只是自己做了原子写。
 * 反过来（外部另造一份数据写进 json）才会被下一次同步整份覆盖。
 */
function persistStore(entries) {
  if (!dataDir) dataDir = resolveDataDir();
  if (!dataDir) throw new Error('数据目录未知，无法落盘');
  const file = path.join(dataDir, 'stickers.json');
  fs.mkdirSync(dataDir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entries, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

// ── 处理界面提交的操作 ───────────────────────────────────────────────────

/**
 * 读操作槽位。
 *
 * 正常情况下 `api.config().pending` 就是一个普通对象。
 * 但核心的深合并是**按层级**解包 `{__replace__: X}` 的：只有"被替换的那个键在旧配置里
 * 已经存在"时才会解包。所以如果本插件的配置段还不存在（全新安装、段被清掉），
 * 界面第一次提交的 pending 会**原样带着 __replace__ 外壳**存下来 —— 那样 `opId` 读不到，
 * 操作会**永远不执行**，用户只看到按钮点了没反应。
 * 这里顺手拆一层壳，保证操作一定能跑起来（实测这个坑真的存在）。
 */
function pendingSlot() {
  const p = api.config()?.pending;
  if (p && typeof p === 'object' && !p.opId && p.__replace__ && typeof p.__replace__ === 'object') {
    return p.__replace__;
  }
  return p;
}

async function applyPending() {
  const pending = pendingSlot();
  if (!pending || typeof pending !== 'object' || !pending.opId) return;
  if (pending.applied === true) return;                 // 已经处理过（重启后也不会重复执行）
  if (!host?.stickers) return;                          // 句柄没就绪：留着，等第一条消息

  let result;
  try {
    result = await runOp(pending);
  } catch (error) {
    result = { ok: false, message: String(error?.message ?? error) };
  }

  // 结果回填到同一个 pending 上：界面据此显示成败，也保证不会重复执行。
  //
  // ⚠️ 必须用核心的"整体替换"约定 `{ __replace__: X }`，不能让 deepMerge 去递归合并：
  //    配置合并是深合并，不整块替换的话 ——
  //      · 上一次操作的结果里那些键（added / failed / details）会**留在 result 里**，
  //        界面读 result.details 就会把上一批的失败清单又列一遍；
  //      · 这次操作的载荷键（source / sources，装着图片 base64）也没人删，永久留在 config.json。
  //    整块替换一次性解决这两件事。
  // ⚠️ 回填前先确认"槽位里还是我这一条"。中间隔着 await（批量加图 / AI 识图可能好几秒），
  //    期间界面若提交了新操作（另一个窗口、或上一次超时后用户又点了一次），
  //    直接回填就会把新操作**标记成已完成**——它再也不会被执行，用户只看到一直等待。
  //    opId 不同 = 来了新活，这次不回填，留给下一轮 tick 处理。
  const still = pendingSlot();
  if (still && typeof still === 'object' && still.opId && still.opId !== pending.opId) {
    api.log?.(`操作 ${pending.kind || '?'} 完成，但槽位已被新操作占用，跳过回填（新操作会在下一轮处理）`);
    return;
  }

  writePluginConfig({
    pending: {
      __replace__: {
        opId: pending.opId,                             // opId 只用来去重，不参与业务
        kind: pending.kind || '',
        at: pending.at || '',
        applied: true,
        result,
        finishedAt: new Date().toISOString()
      }
    }
  });
  api.log?.(`操作 ${pending.kind || '?'} → ${result.ok ? '成功' : '失败'}：${result.message || ''}`);
}

async function runOp(op) {
  const kind = String(op.kind || '');
  if (kind === 'add') return opAdd(op);
  if (kind === 'addBatch') return opAddBatch(op);
  if (kind === 'delete') return opDelete(op);
  if (kind === 'setNote') return opSetNote(op);
  if (kind === 'annotate') return opAnnotate(op);
  if (kind === 'sync') return opSync();
  if (kind === 'setTags') return opSetTags(op);
  if (kind === 'retagAll') return opRetagAll();
  if (kind === 'setRank') return opSetRank(op);
  return { ok: false, message: `不认识的操作「${kind}」` };
}

// ── 操作：改提示词 ───────────────────────────────────────────────────────
//
// 走核心自己的写备注路径（StickerManager.note → applyStickerNote → saveStickerStore），
// 归一化/落盘/内存同步都由核心负责，我们只额外把 desc 对齐。
// desc 为什么要写：提示词摘要里显示的是 `desc || localNote`（src/stickers.js 的
// buildStickerContext），只写 localNote 的话，模型看到的那一行可能还是旧的 QQ 名称。

function opSetNote(op) {
  const id = String(op.id || '');
  const note = String(op.note ?? '').slice(0, NOTE_MAX).trim();
  if (!id) return { ok: false, message: '缺少表情 id' };
  const entries = host.stickers.entries;
  const at = entries.findIndex((e) => String(e?.id) === id);
  if (at < 0) return { ok: false, message: `表情库里找不到 ${id}` };

  entries[at] = { ...entries[at], desc: note.slice(0, DESC_MAX) };
  // 手改提示词也重算标签：标签是提示词的衍生物，跟着一起变才不会自相矛盾。
  const saved = host.stickers.note(id, { note, tags: tagsFromText(note) });
  if (!saved) return { ok: false, message: '写入失败（表情可能已被删除）' };
  return { ok: true, message: note ? '提示词已保存（标签已按新提示词重算）' : '提示词已清空' };
}

// ── 操作：删除 ───────────────────────────────────────────────────────────

function opDelete(op) {
  const id = String(op.id || '');
  if (!id) return { ok: false, message: '缺少表情 id' };
  const entries = host.stickers.entries;
  if (!Array.isArray(entries)) return { ok: false, message: '表情库数据异常，本次没有改动任何数据' };
  const at = entries.findIndex((e) => String(e?.id) === id);
  if (at < 0) return { ok: false, message: `表情库里找不到 ${id}` };

  const target = entries[at];
  // QQ 收藏的表情删不掉：它们是"源"，下一次同步（mergeStickerLibrary）会把不在收藏
  // 列表里的 qq 条目清掉、把收藏列表里的补回来 —— 本地删了下次还会回来。
  if (String(target?.source || '') === 'qq') {
    return { ok: false, message: '这是 QQ 收藏的表情，本地删不掉（同步时会回来）；请到 QQ 里取消收藏。' };
  }

  // ⚠️ 顺序不能反：**先落盘，成功了再改内存**。
  //    先 splice 再落盘的话，一旦落盘失败就留下"内存已删、磁盘还在"的错位状态：
  //    界面回的是"删除失败"，可之后核心任意一次 saveStickerStore（发一张表情就会触发
  //    markUsed → saveStickerStore）都会拿内存去覆盖磁盘，把这次删除**静默固化**——
  //    用户以为没删成，其实已经删了，且再也回不来（这正是"被内存覆盖"的真实版本）。
  //    先落盘就能保证：界面说成功 = 磁盘已生效；界面说失败 = 一个字节都没动。
  const next = entries.filter((e) => String(e?.id) !== id);
  try {
    persistStore(next);
  } catch (error) {
    return { ok: false, message: `删除失败，本次没有改动任何数据：${String(error?.message ?? error)}` };
  }
  entries.splice(at, 1);        // 与核心共用同一个数组引用，原地改才能让内存与磁盘一致
  dropLocalImage(target);       // 条目已移除；图片删不掉只记日志，不让整个删除报失败
  return { ok: true, message: '已从表情库移除' };
}

/**
 * 顺手清掉条目对应的本地图片，避免 data/sticker-images/ 里攒孤儿文件。
 * 边界交给 localPathOf（只认受控目录内的 file:/// 路径）；失败绝不抛。
 */
function dropLocalImage(entry) {
  try {
    const file = localPathOf(entry?.localFile || entry?.url || '');
    if (!file) return;
    fs.unlinkSync(file);
  } catch (error) {
    api?.warn?.(`本地图片删除失败（条目已移除，不影响）：${error?.message ?? error}`);
  }
}

// ── 操作：同步 QQ 收藏 ───────────────────────────────────────────────────

async function opSync() {
  // 记下同步前的 QQ 来源条目，用来算"新增/移除"——只报总数的话，
  // 用户看到数字没变会以为没生效（本地手动添加的条目本来就不会被同步影响）。
  const qqIdsBefore = new Set(
    (host.stickers.entries || [])
      .filter((e) => String(e?.source) === 'qq')
      .map((e) => String(e.id))
  );
  const r = await host.stickers.sync(true);
  if (r?.error) return { ok: false, message: `同步失败：${r.error}（协议端没返回收藏列表，本地库没动）` };

  const entries = Array.isArray(r?.entries) ? r.entries : [];
  const qqIdsAfter = new Set(entries.filter((e) => String(e?.source) === 'qq').map((e) => String(e.id)));
  const added = [...qqIdsAfter].filter((id) => !qqIdsBefore.has(id)).length;
  const removed = [...qqIdsBefore].filter((id) => !qqIdsAfter.has(id)).length;

  const bits = [`QQ 收藏里读到 ${qqIdsAfter.size} 张`];
  if (added) bits.push(`新增 ${added} 张`);
  if (removed) bits.push(`移除 ${removed} 张（已在 QQ 里取消收藏）`);
  const tip = qqIdsAfter.size
    ? ''
    : '。你的 QQ 收藏面板里没有表情，所以没东西可同步 —— 本地这些是手动添加的，不受同步影响';
  return { ok: true, message: `已同步：${bits.join('，')}；本地库共 ${entries.length} 张${tip}` };
}

// ── 操作：新增 ───────────────────────────────────────────────────────────
//
// 新增条目的 source 用 'manual'：mergeStickerLibrary 结尾会把"source=qq 但不在收藏
// 列表里"的条目过滤掉，用 qq 之外的值才能长期留在本地库里（核心自己的收藏功能同理）。

async function opAdd(op) {
  const buf = await resolveBytes(op.source || {});
  const ext = sniffImageExt(buf);
  if (!ext) return { ok: false, message: '拿到的不是图片（可能是防盗链页/错误页），已放弃' };

  const md5 = createHash('md5').update(buf).digest('hex');
  const entries = host.stickers.entries;
  const dup = entries.find((e) => String(e?.md5 || '').toUpperCase() === md5.toUpperCase());
  if (dup) return { ok: false, message: `这张图已经在库里了（${dup.id}）` };

  if (!dataDir) dataDir = resolveDataDir();
  const id = `manual_${md5.slice(0, 12)}`;
  const imgDir = path.join(dataDir, 'sticker-images');
  fs.mkdirSync(imgDir, { recursive: true });
  const dest = path.join(imgDir, `${id}${ext}`);
  fs.writeFileSync(dest, buf);
  const local = `file:///${dest.replace(/\\/g, '/')}`;
  const now = new Date().toISOString();

  const note = String(op.note ?? '').slice(0, NOTE_MAX).trim();
  const entry = {
    id,
    resId: id,
    url: local,
    sourceUrl: String(op.source?.url || ''),
    sourceName: String(op.source?.name || ''),      // 界面显示用（来自文件选择器的文件名）
    localFile: local,
    md5: md5.toUpperCase(),
    desc: note.slice(0, DESC_MAX),
    localNote: note,
    tags: tagsFromText(note),
    usage: '',
    source: 'manual',
    useCount: 0,
    lastUsedAt: 0,
    lastContext: '',
    createdAt: now,
    updatedAt: now
  };
  entries.push(entry);
  persistStore(entries);

  // 自动识图：把图交给模型写一句提示词，再走核心的 note 落盘。
  const wantAnnotate = op.autoAnnotate === undefined
    ? api.config()?.autoAnnotate !== false
    : op.autoAnnotate !== false;
  if (!wantAnnotate) return { ok: true, message: '已加入表情库（未识图）', id };

  try {
    const text = await visionNote(buf, ext);
    if (!text) return { ok: true, message: '已加入表情库；识图没有返回内容', id };
    applyNote(id, text);
    return { ok: true, message: `已加入并写好提示词：${text.slice(0, 40)}`, id };
  } catch (error) {
    return { ok: true, message: `已加入表情库；识图失败（${String(error?.message ?? error)}）`, id };
  }
}

/**
 * 一次加多张（界面上"＋ 添加"选了一批文件时用）。
 *
 * 逐张串行处理：识图是模型调用，并发一起打出去容易撞限流，而且失败时也说不清是哪张。
 * 每张的结果都进 details，界面据此列出"哪张没成功、为什么"。
 */
async function opAddBatch(op) {
  const list = Array.isArray(op.sources) ? op.sources.slice(0, 30) : [];
  if (!list.length) return { ok: false, message: '没有要加入的图片' };
  const autoAnnotate = op.autoAnnotate !== false;
  const details = [];
  for (const item of list) {
    const name = String(item?.name || '');
    try {
      const r = await opAdd({ autoAnnotate, note: item?.note ?? op.note, source: item?.source });
      details.push({ name, ok: !!r.ok, message: String(r.message || '') });
    } catch (error) {
      details.push({ name, ok: false, message: String(error?.message ?? error) });
    }
  }
  const added = details.filter((d) => d.ok).length;
  const failed = details.length - added;
  return {
    ok: added > 0,
    added,
    failed,
    details,
    message: `加入 ${added} 张${failed ? `，${failed} 张没成功` : ''}`
  };
}

// ── 操作：给已有表情重新识图 ─────────────────────────────────────────────

async function opAnnotate(op) {
  const id = String(op.id || '');
  const entry = host.stickers.entries.find((e) => String(e?.id) === id);
  if (!entry) return { ok: false, message: `表情库里找不到 ${id}` };
  let buf;
  try {
    buf = await resolveBytes({ kind: 'entry', id });
  } catch (error) {
    return { ok: false, message: `取图失败：${String(error?.message ?? error)}` };
  }
  const ext = sniffImageExt(buf) || '.jpg';
  let text;
  try {
    text = await visionNote(buf, ext);
  } catch (error) {
    // 失败原因直接带给界面（"额度全花在思考上" / "模型没返回正文" 都出自这里）
    return { ok: false, message: `识图失败：${String(error?.message ?? error)}` };
  }
  if (!text) return { ok: false, message: '识图没有返回内容' };
  applyNote(id, text);
  return { ok: true, message: text.slice(0, 60) };
}

/**
 * 写提示词：desc、localNote 与 tags 一起对齐，再让核心落盘。
 *
 * 标签跟着提示词走 —— 提示词变了就重算（所以「AI 识图重写」会把手改过的标签一起覆盖，
 * 这是刻意的：标签本来就是提示词的衍生物，两处各说一套才会让模型看懵）。
 */
function applyNote(id, text) {
  const entries = host.stickers.entries;
  const at = entries.findIndex((e) => String(e?.id) === id);
  if (at < 0) return;
  entries[at] = { ...entries[at], desc: text.slice(0, DESC_MAX) };
  host.stickers.note(id, { note: text, tags: tagsFromText(text) });
}

/**
 * 只写标签，不动提示词（界面上点标签时用）。
 *
 * 仍然走核心 StickerManager.note —— 它内部是 applyStickerNote → saveStickerStore，
 * 内存与磁盘一起更新。直接改 json 是无效的：核心启动后就不再读盘，下一次 save 还会
 * 拿内存里的旧数据把改动覆盖掉。
 */
function writeTags(id, tags) {
  const list = Array.isArray(tags) ? tags.map((t) => String(t ?? '').trim()).filter(Boolean) : [];
  // 落盘前统一按分类排 —— 这里是**所有标签写入的必经之路**（识图、手点、重打都走它），
  // 放在这一层就不可能漏。见 sortTags 的注释：顺序要稳，不然同一份内容会时存时变。
  return host.stickers.note(id, { tags: sortTags(list).slice(0, TAG_MAX_TOTAL) });
}

/** 从模型回包里取正文：content 可能是字符串，也可能是一段段的分片数组。 */
function pickReplyText(r) {
  const c = r?.message?.content;
  if (typeof c === 'string') return c.trim();
  if (Array.isArray(c)) {
    return c.map((p) => (typeof p === 'string' ? p : String(p?.text ?? ''))).join('').trim();
  }
  return '';
}

/** 这条回包是不是"只思考、没作答"（推理模型额度不够时的典型特征）。 */
function isReasoningOnly(r) {
  const m = r?.message || {};
  return !pickReplyText(r) && Boolean(String(m.reasoning || m.reasoning_content || '').trim());
}

/**
 * 让模型看图写提示词（走核心的模型链路，用用户自己配的 key/模型）。
 *
 * 返回一句提示词；**拿不到正文就抛错**，由调用方把原因显示到界面上 ——
 * 以前这里返回空串，界面只会说"识图没有返回内容"，看不出到底是
 * 额度不够、模型不支持图片，还是网络问题。
 */
async function visionNote(buf, ext) {
  const extra = String(api.config()?.annotatePrompt || '').trim();
  const ask = extra || [
    '这是我要收进 QQ 机器人表情库的一张表情包。',
    '请用一句中文说明它表达的情绪/含义，以及适合在什么场合发（例如"接梗、吐槽、被怼时用"）。',
    '要求：40 字以内，直接给这一句话，不要任何前缀、引号或解释。'
  ].join('');
  const dataUrl = `data:${MIME_BY_EXT[ext] || 'image/jpeg'};base64,${buf.toString('base64')}`;
  const messages = [
    { role: 'user', content: [{ type: 'text', text: ask }, { type: 'image_url', image_url: { url: dataUrl } }] }
  ];

  const r = await askModel(messages, { maxTokens: VISION_MAX_TOKENS });
  let text = pickReplyText(r);

  // 正文为空：多半是推理模型把额度全花在思考上（见 VISION_MAX_TOKENS 的说明）。
  // 加大额度再来一次 —— 实测这是唯一能救回来的办法，而且代价只是一次请求。
  if (!text) {
    const retry = await askModel(messages, { maxTokens: VISION_RETRY_TOKENS });
    text = pickReplyText(retry);
    if (!text) {
      throw new Error(isReasoningOnly(retry)
        ? `模型把 ${VISION_RETRY_TOKENS} token 全用在思考上了、没写正文（可给「图片输入专用模型」指定一个直接作答的多模态模型）`
        : '模型没有返回正文（可能不支持图片输入，或请求被网关拦下）');
    }
  }

  const clean = String(text)
    .replace(/^["'「『]|["'」』]$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, NOTE_MAX);
  if (!clean) throw new Error('模型只返回了空白内容');
  return clean;
}

// ── 操作：标签 ───────────────────────────────────────────────────────────

/** 界面上点标签：整组替换（加减之后的结果由界面算好再提交）。 */
function opSetTags(op) {
  const id = String(op.id || '');
  if (!id) return { ok: false, message: '缺少表情 id' };
  const entry = host.stickers.entries.find((e) => String(e?.id) === id);
  if (!entry) return { ok: false, message: `表情库里找不到 ${id}` };
  const tags = (Array.isArray(op.tags) ? op.tags : [])
    .map((t) => String(t ?? '').trim()).filter(Boolean);
  // 消息里按排好序的样子回显，和卡片上看到的一致（顺序由 writeTags 落盘时定，这里只是同一套）
  const shown = sortTags(tags).slice(0, TAG_MAX_TOTAL);
  if (!writeTags(id, tags)) return { ok: false, message: '写入失败（表情可能已被删除）' };
  return { ok: true, message: shown.length ? `标签已更新：${shown.join('、')}` : '已清空标签' };
}

/**
 * 全库重打标签：按每张现有的提示词（localNote 优先，其次 desc）重算一遍。
 *
 * 用途有两个：① 升级到 1.2.0 之后给历史表情补标签；② 以后改了标签表，
 * 跑一次就能整体迁移（这也是"存中文"唯一的代价）。
 */
async function opRetagAll() {
  const entries = host.stickers.entries;
  if (!Array.isArray(entries) || !entries.length) return { ok: false, message: '表情库是空的' };
  let changed = 0;
  let tagged = 0;
  for (const e of entries) {
    if (!e || !String(e?.id || '')) continue;
    const next = tagsFromText(String(e?.localNote || e?.desc || ''));
    const before = Array.isArray(e.tags) ? e.tags : [];
    if (before.join('|') !== next.join('|')) {
      e.tags = next;                       // 先只改内存，最后统一落一次盘
      e.updatedAt = new Date().toISOString();
      changed += 1;
    }
    if (next.length) tagged += 1;
  }
  if (changed && !(await persistEntries(entries))) {
    return { ok: false, message: '标签算好了，但写盘失败 —— 改动可能在下次同步时丢失，再点一次试试' };
  }
  const untagged = entries.length - tagged;
  return {
    ok: true,
    message: `重打完成：共 ${entries.length} 张，改动 ${changed} 张，仍有 ${untagged} 张没匹配到（提示词里没有可识别的情绪/场合词，可以手点）`
  };
}

/**
 * 把内存里的改动落盘。
 *
 * 优先借核心 stickers.js 的 saveStickerStore **整体写一次** —— 批量改标签时逐条 note()
 * 会把整份 json 重写 N 遍（几百张就是几百次写盘）。拿不到核心模块（结构变了 / 不是
 * Electron 环境）就退回逐条 note()，行为不变，只是慢一点。
 * ⚠️ 这里是**只读地 import** 核心模块，没有改核心文件。
 */
async function persistEntries(entries) {
  const mod = await coreStickers();
  if (mod?.saveStickerStore) {
    try { mod.saveStickerStore(entries); return true; } catch { /* 掉到下面逐条写 */ }
  }
  let ok = true;
  for (const e of entries) {
    const id = String(e?.id || '');
    if (!id) continue;
    // 提示词原样带回去：内容不变，只为借它触发一次 saveStickerStore
    if (!host.stickers.note(id, { note: String(e?.localNote ?? ''), tags: Array.isArray(e?.tags) ? e.tags : [] })) ok = false;
  }
  return ok;
}

let coreStickersMod;
let coreStickersTried = false;
async function coreStickers() {
  if (!coreStickersTried) {
    coreStickersTried = true;
    try { coreStickersMod = await import('../../src/stickers.js'); } catch { coreStickersMod = null; }
  }
  return coreStickersMod;
}

// ── 操作：拖动排序（常用表情的顺序和成员）───────────────────────────────

/**
 * 把某张表情排到第 index 位（0 起）。
 *
 * 核心没有"手动置顶"这种字段 —— 常用表情是每轮按 useCount 降序**现算**的前
 * floor(promptMaxStickers/2) 张（见 stableTopCount），所以唯一的抓手就是 useCount。
 *
 * 做法是**整段重排**：排完后把前 topN 张的 useCount 重赋成一组严格递减的连续整数，
 * 且末位严格大于池内最大值。这样既不会并列（并列时核心靠"有没有备注 / id 字典序"决胜，
 * 落点不可控），也不会把池子里那些真实次数搞乱。
 * 代价：这几张的"用过 N 次"不再等于真实次数，界面上把它们显示成「权重 N」。
 *
 * ⚠️ 只改内存里的条目再借 note() 落盘 —— 直接写 stickers.json 是无效的：核心启动后
 *    不再读盘，下一次 saveStickerStore 会拿内存里的旧数据把改动覆盖掉。
 */
async function opSetRank(op) {
  const id = String(op.id || '');
  if (!id) return { ok: false, message: '缺少表情 id' };
  const entries = host.stickers.entries;
  if (!Array.isArray(entries) || !entries.length) return { ok: false, message: '表情库数据异常，本次没改动' };
  const topN = await stableTopCount();
  const raw = Number(op.index);
  const want = Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0;

  const sorted = entries.slice().sort(usageCompare);
  const from = sorted.findIndex((e) => String(e?.id) === id);
  if (from < 0) return { ok: false, message: `表情库里找不到 ${id}` };

  // 拖到第 topN 位及以后 = 拖出常用表情：落到池里第一位就行（池内本来就是随机轮换）
  const dropped = want >= topN;
  const target = dropped ? topN : want;
  if (!dropped && from === target) return { ok: true, message: '位置没变' };

  const moved = sorted.splice(from, 1)[0];
  sorted.splice(target, 0, moved);

  const byId = new Map(entries.map((e) => [String(e?.id), e]));
  const rest = sorted.filter((e) => String(e?.id) !== id);
  // 池内最大值：新常用表情块之外的那些（被拖走的这张不算进去，免得 base 被自己抬高）
  const pool = dropped ? rest.slice(topN) : rest.slice(topN - 1);
  const poolMax = pool.reduce((m, e) => Math.max(m, Number(e?.useCount) || 0), 0);
  const base = Math.max(1, poolMax + 1);

  if (dropped) {
    const real = byId.get(String(moved.id));
    if (real) real.useCount = Math.max(0, base - 1);
  }
  for (let i = 0; i < topN; i += 1) {
    const e = sorted[i];
    if (!e) break;
    const real = byId.get(String(e.id));
    if (real) real.useCount = base + (topN - 1 - i);
  }

  // 借核心的 note 触发落盘。⚠️ note 必须**回传现有值**，不能不带、更不能给空串：
  // applyStickerNote 里 patch.note !== undefined 就会把它写进去，所以
  // `note(id, { note: '' })` 会把这张图本来写好的提示词**清空**，
  // `note(id, {})` 则会把内存里的 localNote 冲掉（applyStickerNote 会 normalize 一遍，
  // 落盘的仍是内存那份）—— 两种都会静默毁数据。这里是"只改 useCount"的写入，提示词原样带回去。
  const saved = host.stickers.note(id, { note: String(moved?.localNote ?? '') });
  if (!saved) return { ok: false, message: '写入失败（表情可能已被删除）' };
  return {
    ok: true,
    message: dropped ? '已移出常用表情，退回每小时轮换的池子' : `已排到常用表情第 ${target + 1} 位`
  };
}

// ── 图片取字节 ───────────────────────────────────────────────────────────

async function resolveBytes(src) {
  const kind = String(src?.kind || '');

  if (kind === 'path') {
    const p = String(src.path || '').trim();
    if (!p) throw new Error('没有填路径');
    const st = fs.statSync(p);                       // 不存在会抛错，交给上层显示
    if (!st.isFile()) throw new Error('这不是一个文件');
    if (st.size > MAX_IMAGE_BYTES) throw new Error('图片超过 15MB');
    return fs.readFileSync(p);
  }

  if (kind === 'url') return fetchBytes(String(src.url || ''));

  if (kind === 'dataUrl') {
    const m = /^data:([^;,]+)?;base64,(.*)$/is.exec(String(src.dataUrl || ''));
    if (!m) throw new Error('图片数据格式不对');
    const buf = Buffer.from(m[2], 'base64');
    if (!buf.length) throw new Error('图片数据是空的');
    if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片超过 15MB');
    return buf;
  }

  // 协议端（OneBot）缓存里的图：给了 file id 就让协议端自己找
  if (kind === 'chat') {
    const ret = await host.onebot.call('get_image', { file: String(src.file || '') });
    const p = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
    if (p) return fs.readFileSync(p);
    if (ret?.url) return fetchBytes(String(ret.url));
    throw new Error('协议端没有这张图（可能已经过期）');
  }

  // 已有条目：本地文件直接读，http 直链兜底去下载
  if (kind === 'entry') {
    const entry = host.stickers.entries.find((e) => String(e?.id) === String(src.id || ''));
    if (!entry) throw new Error('表情库里找不到这张表情');
    const local = localPathOf(entry.url);
    if (local) return fs.readFileSync(local);
    if (/^https?:/i.test(String(entry.url || ''))) return fetchBytes(String(entry.url));
    throw new Error('这张表情没有可读取的图片');
  }

  throw new Error('不认识的图片来源');
}

/**
 * 下载图片。
 * 只允许 http/https，且拒绝内网/本机地址 —— 这是用户手填的链接，不能变成
 * "让本机去抓内网"的通道（核心在 safe-fetch.js 里对同一个威胁是同样的态度）。
 */
async function fetchBytes(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl).trim()); } catch { throw new Error('不是合法的链接'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('只支持 http/https 链接');
  if (isPrivateHost(u.hostname)) throw new Error('拒绝下载本机/内网地址');
  const res = await api.fetch(u.toString(), { redirect: 'follow' });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (!buf.length) throw new Error('下载到空内容');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片超过 15MB');
  return buf;
}

function isPrivateHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
  if (h.includes(':')) return true;                    // IPv6：够用就好，一律拒绝
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b] = [Number(m[1]), Number(m[2])];
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

/** 由魔数判断图片类型；不是图片返回 ''（核心的 detectImageExt 对识别不出的内容会
 *  回落成 .jpg，那个行为在这里是危险的 —— 会把"防盗链页"当成图片收进库）。 */
function sniffImageExt(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return '';
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return '.jpg';
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return '.bmp';
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
    && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return '.webp';
  return '';
}

/** file:/// 路径 → 本机绝对路径（只认收藏功能自己那个目录，避免点到别处去）。 */
function localPathOf(raw) {
  const value = String(raw || '').trim();
  if (!value.toLowerCase().startsWith('file:///')) return '';
  let pathname;
  try { pathname = decodeURIComponent(new URL(value).pathname); } catch { return ''; }
  if (!dataDir) dataDir = resolveDataDir();
  if (/^\/[A-Za-z]:[\\/]/.test(pathname)) pathname = pathname.slice(1);   // file:///C:/… 多一个斜杠
  const full = path.resolve(pathname);
  const root = path.resolve(path.join(dataDir || APP_ROOT, 'sticker-images')) + path.sep;
  if (!full.toLowerCase().startsWith(root.toLowerCase())) return '';
  try { return fs.statSync(full).isFile() ? full : ''; } catch { return ''; }
}

// ── 预览图（缩略图）─────────────────────────────────────────────────────
//
// 生成的是 data URL，随快照进 config.json —— 因为控制台没有别的办法读到 data/ 下的图。
// 缓存按"文件路径 + 修改时间 + 大小"做键：文件被换掉会自动重算，没换就一次算好。

let nativeImage;               // electron.nativeImage（懒加载；拿不到就全走占位）
let nativeTried = false;
const thumbCache = new Map();

function getNativeImage() {
  if (nativeTried) return nativeImage;
  nativeTried = true;
  try {
    const require = createRequire(import.meta.url);
    nativeImage = require('electron')?.nativeImage || null;
  } catch {
    nativeImage = null;        // 纯 node 跑（比如离线自测）：没有缩略图，界面给占位
  }
  return nativeImage;
}

/** 缩略图是不是需要保留透明通道（扫描 alpha 字节）。 */
function needsAlpha(img) {
  try {
    const bmp = img.toBitmap();                 // BGRA 排列：每 4 字节的第 4 个是 alpha
    if (!bmp?.length) return false;
    for (let i = 3; i < bmp.length; i += 4) if (bmp[i] < 250) return true;
    return false;
  } catch {
    return true;                                // 探不出来就保守用 PNG（宁可大一点也别丢透明）
  }
}

/** 本机图片文件 → data URL 缩略图；算不出来返回 ''（界面会退回占位）。 */
async function thumbOf(absPath) {
  if (!absPath) return '';
  let st;
  try { st = fs.statSync(absPath); } catch { return ''; }
  if (!st.isFile() || st.size <= 0) return '';
  const key = `${absPath}|${st.mtimeMs}|${st.size}`;
  if (thumbCache.has(key)) return thumbCache.get(key);

  const ni = getNativeImage();
  let out = '';
  if (ni) {
    try {
      const direct = ni.createFromBuffer(fs.readFileSync(absPath));
      let img = direct;
      if (img.isEmpty() && typeof ni.createThumbnailFromPath === 'function') {
        // GIF、以及扩展名与真实格式不符的图，Chromium 那套解码器给不出结果，
        // 退回系统缩略图（Windows Shell / macOS QuickLook）—— GIF 能出首帧。
        img = await ni.createThumbnailFromPath(absPath, { width: THUMB_HEIGHT, height: THUMB_HEIGHT });
      }
      if (img && !img.isEmpty()) {
        const resized = img.resize({ height: THUMB_HEIGHT, quality: 'good' });
        // 按**真实**的 alpha 选编码，而不是看扩展名：表情库里 .png 的图大多没有透明
        // （实测那几张按 JPEG 编每张能省 8~10KB），而有透明的必须留 PNG。
        const usePng = needsAlpha(resized);
        const bytes = usePng ? resized.toPNG() : resized.toJPEG(THUMB_QUALITY);
        if (bytes?.length) out = `data:${usePng ? 'image/png' : 'image/jpeg'};base64,${bytes.toString('base64')}`;
      }
    } catch {
      out = '';                // 解不了就占位，不影响其余条目
    }
  }

  if (thumbCache.size > 400) thumbCache.clear();       // 库很大时别把内存攒住
  thumbCache.set(key, out);
  return out;
}

// ── 快照：发给界面（走插件自己的配置段，不写文件）────────────────────────

/** 预览图来源：http 直链直接用；本地文件给内存里生成的缩略图；都不行给文件名占位。 */
async function imgOf(entry, allowThumb) {
  const url = String(entry?.url || '');
  if (/^https?:/i.test(url)) return { kind: 'url', src: url };
  const local = localPathOf(url);
  if (local) {
    const thumb = allowThumb ? await thumbOf(local) : '';
    return { kind: 'local', name: path.basename(local), thumb };
  }
  const original = String(entry?.sourceUrl || '');
  if (/^https?:/i.test(original)) return { kind: 'url', src: original };
  const named = String(entry?.sourceName || '');
  if (named) return { kind: 'local', name: named, thumb: '' };
  return null;
}

/**
 * 复刻核心 src/stickers.js buildStickerContext() 的排序口径（useCount 降序 →
 * 有备注的优先 → id 升序）。为的是让面板里"排在前面的那几张"与模型每轮真正
 * 看到的"常用表情"完全对上 —— 两处若各排各的，高亮就会骗人。
 */
function usageCompare(a, b) {
  return (Number(b?.useCount) || 0) - (Number(a?.useCount) || 0)
    || ((b?.desc || b?.localNote) ? 1 : 0) - ((a?.desc || a?.localNote) ? 1 : 0)
    || String(a?.id ?? '').localeCompare(String(b?.id ?? ''));
}

/**
 * 核心在提示词里"每轮固定出现"的表情条数。
 * 出处：buildStickerContext(total=clamp(promptMaxStickers,1,30)) 里
 * stableCount = floor(total/2)，total 默认 10 → 常用表情 5 张，其余轮换。
 * 这里跟着核心配置走：用户把 promptMaxStickers 调成 20，常用表情就变成 10 张。
 */
async function stableTopCount() {
  let max = 10;
  try {
    await coreConfig();
    max = Number(coreMod?.getConfig()?.sticker?.promptMaxStickers) || 10;
  } catch { /* 取不到就用默认 10 */ }
  const total = Math.max(1, Math.min(30, max));
  return Math.max(1, Math.floor(total / 2));
}

async function snapshotItems(entries) {
  const items = [];
  let thumbCount = 0;
  const topN = await stableTopCount();
  // 先排序再截断：库超过 MAX_ITEMS 时，被截掉的应该是用得最少的那批，
  // 而不是"刚好排在存档末尾"的那批（否则固定位可能根本进不了快照）。
  const ordered = [...entries].sort(usageCompare);
  for (const e of ordered.slice(0, MAX_ITEMS)) {
    const id = String(e?.id || '');
    if (!id) continue;
    const img = await imgOf(e, thumbCount < MAX_THUMBS);
    if (img?.thumb) thumbCount += 1;
    items.push({
      id,
      desc: String(e?.desc || ''),
      note: String(e?.localNote || ''),
      tags: Array.isArray(e?.tags) ? e.tags : [],
      source: String(e?.source || 'qq'),
      useCount: Number(e?.useCount) || 0,
      // 常用表情：界面据此加淡蓝描边 + 「常用表情」角标 + 序号
      top: items.length < topN,
      canDelete: String(e?.source || 'qq') !== 'qq',
      img
    });
  }
  // "有图但没有预览"的数量：只数本地文件出不了缩略图的情况（http 直链的预览直接由界面
  // 加载 URL，本来就不需要缩略图）。界面据此提示"有些表情没有预览"。
  const noThumb = items.filter((i) => i.img?.kind === 'local' && !i.img.thumb).length;
  return { items, thumbCount, noThumb };
}

/**
 * 快照签名 = items 内容 + **句柄就绪态**。
 *
 * ⚠️ hostReady 必须编进来。它不在 items 里，但它是**会自己变的**：
 *    软件重启 / 插件热重载后 host 归零（false），机器人收到下一条消息才回来（true）。
 *    早先只比 items 签名，"内容一模一样、只是句柄没了"会被判成没变化 → 快照不重写 →
 *    界面一直读到旧快照里的 hostReady:true，把"还没拿到句柄、操作根本没法执行"
 *    误报成"正在处理…"，用户对着一个永远不动的进度干等到超时。
 *    这是实测踩到的：插件被热重载 + 之后没有新消息 = 界面永久卡在"正在处理"。
 *
 * 快照版本号 v 兜的是另一件事（结构变了、字段语义变了），比不了 hostReady 这种
 * **运行期状态**，两者各管各的，缺一不可。
 */
function snapshotSig(items, hostReady) {
  return `${hostReady ? 'H1' : 'H0'}|${sigOfItems(items)}`;
}

/**
 * 只比"会影响界面显示"的 items 字段。
 * ⚠️ useCount 与 top 必须算进来：卡片上显示「用过 N 次」，且**排序与淡蓝高亮**
 * 都取决于它们 —— 不比就会漏掉"用的次数变了、前 5 名换人了"这种变化，
 * 界面会停留在旧顺序上（正是这个高亮功能最容易踩的坑）。
 * ⚠️ 顶层字段走 snapshotSig 和 v，这里不管。
 */
function sigOfItems(items) {
  return JSON.stringify([
    items.length,
    items.map((i) => [
      i.id, i.desc, i.note, i.tags.join(','), i.source, i.canDelete,
      i.useCount || 0, i.top ? 1 : 0,
      i.img?.src || i.img?.name || '',
      // 缩略图只比长度 + 尾部一小段：够判断"换图了"，不必把几十 KB 的字符串拼进签名
      i.img?.thumb ? `${i.img.thumb.length}:${i.img.thumb.slice(-24)}` : ''
    ])
  ]);
}

async function publishSnapshot() {
  const entries = liveEntries();
  const { items, noThumb } = await snapshotItems(entries);
  const hostReady = !!host?.stickers;      // false = 只读（改库要等机器人收到第一条消息）
  const sig = snapshotSig(items, hostReady);
  if (sig === lastSig) return;

  // 进程刚起来（热重载后也一样）：先拿配置里上一份快照比一次。一样就什么都不写 ——
  // 否则每次热重载都会白写一次 config.json。
  //
  // ⚠️ 必须先比版本号：快照签名只看 items + hostReady，**看不见其它快照级字段的变化**
  // （顶层的 topN / thumbsOmitted 等）。早先只比 items 时，热重载途中先落了一份
  // "有 top 但没 topN"的快照，之后代码补齐 topN，items 签名却完全一致 → 判定"没变化"
  // → 新字段永远写不进去。把版本写进快照里比对，才能保证改结构后强制重发一次。
  // ⚠️ hostReady 不再依赖版本号兜底 —— 它每次 tick 都可能变（设备重启/热重载/来消息），
  //    已经编进 snapshotSig（见那里的说明）。这里比对时也要带上它，否则重启后
  //    "items 一样、句柄却没了"依然会被判成没变化。
  if (lastSig === '') {
    const prev = api.config()?.snapshot;
    if (prev?.v === SNAP_VERSION && Array.isArray(prev.items)
      && snapshotSig(prev.items, !!prev.hostReady) === sig) {
      lastSig = sig;
      return;
    }
  }

  // 标签表跟着快照走：表只此一份（index.js 里），界面不再自己抄一遍，
  // 改了中文名只要跑一次「批量重打标签」就能整体迁移。
  const defs = tagDefs();
  const snapshot = {
    v: SNAP_VERSION,                                // 快照结构版本（改了顶层字段就 +1）
    at: new Date().toISOString(),
    hostReady,                                      // false = 只读（改库要等第一条消息）
    total: items.length,
    truncated: entries.length > MAX_ITEMS,
    thumbsOmitted: noThumb,                         // >0 表示有 N 张出不了预览图
    topN: items.filter((i) => i.top).length,        // 排在前面、被淡蓝高亮的「常用表情」条数
    tagDefs: defs.defs,
    tagGroups: defs.groups,
    items
  };
  if (!writePluginConfig({ snapshot })) return;      // 两条路都写不出去：下次 tick 再试
  lastSig = sig;
}
