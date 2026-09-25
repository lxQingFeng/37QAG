// 每周四 7/13/19 点：用 LLM 编一段疯狂星期四文案后直发到指定群。
// 不走角色卡/人设提示词——系统里只有「写文案」指令。
import { getConfig } from './config.js';
import { chatCompletion, resolveApiKey } from './llm.js';

let timer = null;
const fired = new Set();

export function startCrazyThursday({ sender, log = console.log }) {
  if (timer) return;
  const tick = () => {
    timer = setTimeout(tick, 20_000);
    try { checkOnce({ sender, log }); } catch (e) {
      log('[crazy-thursday] tick error', e?.message ?? e);
    }
  };
  timer = setTimeout(tick, 12_000);
}

export function stopCrazyThursday() {
  if (timer) clearTimeout(timer);
  timer = null;
}

async function writeCopy({ log }) {
  const cfg = getConfig();
  const sys = [
    '你是一个写文案的助手，不是任何群友、角色或虚拟形象。',
    '任务：写一段「疯狂星期四」群公告/玩梗文案。',
    '要求：',
    '1. 中文，长度大于100字，小于220字。',
    '2. 狂欢、安利肯德基疯狂星期四的氛围，可以玩梗，鼓励群友 V 我 50 一起去吃。',
    '3. 不要出现鲸鱼、小鲸鱼、DeepSeek、北极爷、管理员等任何机器人人设或内部梗。',
    '4. 口语、群聊感，像真人随手发的，不要书面腔、不要分点列提纲。',
    '5. 只输出正文，不要引号包裹，不要解释，不要标题。'
  ].join('\n');
  const user = `今天是星期四。请编一段疯狂星期四文案（>100字）。`;
  // 0.31/本工程 chatCompletion 返回 { message, finishReason }，不是 OpenAI 的 choices[]
  const res = await chatCompletion({
    messages: [
      { role: 'system', content: sys },
      { role: 'user', content: user }
    ],
    temperature: 0.95
  });
  const text = String(res?.message?.content || res?.choices?.[0]?.message?.content || res?.text || '')
    .replace(/^["'“”]|["'“”]$/g, '')
    .replace(/^(文案|标题)[:：]\s*/i, '')
    .replace(/^#+\s*/, '')
    .trim();
  return text;
}

function checkOnce({ sender, log }) {
  const cfg = getConfig();
  const ct = cfg.crazyThursday || {};
  if (ct.enabled === false) return;
  const times = Array.isArray(ct.times) && ct.times.length
    ? ct.times.map(String)
    : ['07:00', '13:00', '19:00'];
  const now = new Date();
  if (now.getDay() !== 4) return;
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  if (!times.includes(hhmm)) return;

  // 只发到 crazyThursday.groupIds 里明确列出的群。
  // 留空 = 不发任何群（绝不能回落到 allow.groups 全群广播）。
  const targets = (Array.isArray(ct.groupIds) ? ct.groupIds : [])
    .map(String)
    .map((s) => s.trim())
    .filter((s) => /^\d{5,15}$/.test(s));
  if (!targets.length) return;

  const dateKey = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
  const pending = targets.filter((gid) => !fired.has(`${dateKey}|${hhmm}|${gid}`));
  if (!pending.length) return;

  // 同一分钟内只生成一次文案，发到所有指定群
  (async () => {
    let text = '';
    try {
      text = await writeCopy({ log });
    } catch (e) {
      log('[crazy-thursday] LLM 生成失败:', e?.message ?? e);
      return;
    }
    if (!text || text.length < 100) {
      log('[crazy-thursday] 文案过短/为空跳过:', text.length, JSON.stringify(text.slice(0, 80)));
      return;
    }
    for (const gid of pending) {
      const chatKey = `group:${gid}`;
      fired.add(`${dateKey}|${hhmm}|${gid}`);
      try {
        await sender.sendTextBatch(chatKey, text);
        log(`[crazy-thursday] 已发 ${chatKey} (${text.length}字)`);
      } catch (e) {
        log(`[crazy-thursday] 发送失败 ${chatKey}:`, e?.message ?? e);
      }
    }
  })().catch((e) => log('[crazy-thursday] 异常', e?.message ?? e));
}
