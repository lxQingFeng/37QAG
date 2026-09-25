// 历史冷藏：把「过去状态」拆成 冷藏段 + 热段，给显式缓存一个跨运行稳定的前缀。
//
// 为什么要冷藏（2026-09-20 缓存命中率）：
//   过去状态若每次都是「最近 N 条滑动窗口」，新消息一来整段前缀就变，
//   system 之外的 user stable 整块 miss。autoFinish 之后多轮调用变少，
//   账面命中率被冷首调用拉低（80%+ → 60%+）。
//
// 做法：
//   · 冷藏段按消息 id 粘住（sticky cut），只有 compact 时才重写；
//   · 热段接在后面，新消息是**追加**，不挤掉冷藏前缀；
//   · compact 触发：热段超过 warmMax，或冷藏切点已掉出本次可读窗口。
//
// 显式缓存路径应把冷藏段放在可 cache 的 user 前缀里，热段/唤醒放 volatile。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './config.js';

const COLD_DIR = path.join(DATA_DIR, 'history-cold');

function ensureDir() {
  try { fs.mkdirSync(COLD_DIR, { recursive: true }); } catch { /* ignore */ }
}

function safeName(chatKey) {
  return String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
}

function fileOf(chatKey) {
  return path.join(COLD_DIR, `${safeName(chatKey)}.json`);
}

/** 消息指纹：id + 时间 + 文本；冷藏内容是否真变了只看这个。 */
export function hashMessages(messages) {
  const h = crypto.createHash('sha1');
  for (const m of messages || []) {
    h.update(String(m.id ?? ''));
    h.update('|');
    h.update(String(m.ts ?? ''));
    h.update('|');
    h.update(String(m.text ?? ''));
    h.update('\n');
  }
  return h.digest('hex').slice(0, 16);
}

export function loadColdBlock(chatKey) {
  try {
    let t = fs.readFileSync(fileOf(chatKey), 'utf8');
    if (t.charCodeAt(0) === 0xFEFF) t = t.slice(1);
    const o = JSON.parse(t);
    if (o && o.lastColdId != null && typeof o.text === 'string') return o;
  } catch { /* 无冷藏 */ }
  return null;
}

export function saveColdBlock(chatKey, block) {
  ensureDir();
  const file = fileOf(chatKey);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(block, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

export function clearColdBlock(chatKey) {
  try { fs.unlinkSync(fileOf(chatKey)); } catch { /* ignore */ }
}

/**
 * 把候选历史（已排除触发批、已按档位截断）拆成 cold + warm。
 *
 * @param {string} chatKey
 * @param {Array} candidates  本次允许进提示词的历史消息（旧→新）
 * @param {object} opts
 * @param {(msgs:Array)=>string} renderLine 统一渲染单条/批量的回调（prompt 侧 formatEntry）
 * @param {number} opts.warmMax 热段最多保留几条
 * @returns {{ coldText:string, warmText:string, coldCount:number, warmCount:number,
 *            messages:Array, compacted:boolean }}
 */
export function splitHistoryCold(chatKey, candidates, renderLine, opts = {}) {
  const msgs = Array.isArray(candidates) ? candidates : [];
  const warmMax = Math.max(4, Math.min(40, Number(opts.warmMax) || 12));
  if (!msgs.length) {
    return { coldText: '', warmText: '', coldCount: 0, warmCount: 0, messages: [], compacted: false };
  }

  const cached = loadColdBlock(chatKey);
  const lastId = Number(msgs[msgs.length - 1]?.id ?? 0);
  const firstId = Number(msgs[0]?.id ?? 0);

  let coldMsgs = [];
  let warmMsgs = [];
  let compacted = false;
  let reuseText = '';
  let reuseCount = 0;

  const useCache = cached
    && cached.chatKey === chatKey
    && Number(cached.lastColdId) >= firstId
    && Number(cached.lastColdId) < lastId;

  if (useCache) {
    const cut = msgs.findIndex((m) => Number(m.id) === Number(cached.lastColdId));
    if (cut >= 0) {
      coldMsgs = msgs.slice(0, cut + 1);
      warmMsgs = msgs.slice(cut + 1);
      if (warmMsgs.length > warmMax) {
        // compact 后只保留约一半热段，给后续追加留出头寸；
        // 否则一上来就顶满 warmMax，下一条新消息立刻再 compact，冷藏前缀白做。
        const keep = Math.max(4, Math.floor(warmMax / 2));
        const drop = warmMsgs.length - keep;
        coldMsgs = coldMsgs.concat(warmMsgs.slice(0, drop));
        warmMsgs = warmMsgs.slice(drop);
        compacted = true;
      } else {
        // 未 compact：只有**当前候选里的冷藏消息指纹**与缓存一致时才复用文本。
        // exclude 触发批/窗口变化会改变冷藏组成，复用旧文本会把「本应排除的消息」
        // 又塞回提示词（实测 test-prompt：过去状态里出现了触发批）。
        const curHash = hashMessages(coldMsgs);
        if (cached.hash === curHash && typeof cached.text === 'string' && cached.text) {
          reuseText = String(cached.text || '');
          reuseCount = Number(cached.count) || coldMsgs.length;
        }
        // 冷藏过短（几乎没历史可冻）时不算稳定前缀：不必强求字节不变
        if (reuseText && reuseText.length < 80 && warmMsgs.length >= 2) {
          reuseText = '';
          reuseCount = 0;
          compacted = true;
        }
      }
    } else {
      compacted = true;
    }
  } else {
    compacted = true;
  }

  if (compacted || (!coldMsgs.length && !useCache && msgs.length > warmMax)) {
    // 重建/compact：热段只留 keepWarm（约 warmMax 一半），其余冻进冷藏
    const keepWarm = Math.min(warmMax, Math.max(4, Math.floor(warmMax / 2)));
    if (msgs.length <= keepWarm) {
      coldMsgs = [];
      warmMsgs = msgs;
    } else {
      coldMsgs = msgs.slice(0, msgs.length - keepWarm);
      warmMsgs = msgs.slice(msgs.length - keepWarm);
    }
  }

  const hash = hashMessages(coldMsgs);
  let coldText = '';
  let coldCount = 0;
  if (reuseText) {
    coldText = reuseText;
    coldCount = reuseCount;
  } else if (coldMsgs.length) {
    const lastColdId = Number(coldMsgs[coldMsgs.length - 1].id);
    if (!compacted && cached && cached.lastColdId === lastColdId && cached.hash === hash && typeof cached.text === 'string') {
      coldText = cached.text;
      coldCount = Number(cached.count) || coldMsgs.length;
    } else {
      const lines = [];
      for (const m of coldMsgs) {
        const line = renderLine(m);
        if (line) lines.push(line);
      }
      coldText = lines.join('\n');
      coldCount = lines.length;
      saveColdBlock(chatKey, {
        chatKey,
        lastColdId,
        hash,
        text: coldText,
        count: coldCount,
        updatedAt: Date.now()
      });
    }
  } else if (cached) {
    clearColdBlock(chatKey);
  }

  const warmLines = [];
  for (const m of warmMsgs) {
    const line = renderLine(m);
    if (line) warmLines.push(line);
  }

  return {
    coldText,
    warmText: warmLines.join('\n'),
    coldCount,
    warmCount: warmLines.length,
    messages: msgs,
    compacted,
    warmMessages: warmMsgs,
    coldMessages: coldMsgs
  };
}
