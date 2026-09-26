// 情绪计算的性格档：九型人格（Enneagram）。
// 配置键：persona.emotionProfile（id：t1…t9）
//
// 平衡原则（全型统一）：
//  - posGain > negGain：日常里正面池整体高于负面池
//  - 各型仍用 negGain / closeness / halfLife 保留「核心恐惧」底色，不是纯乐天
//  - mean 写核心动机，fear 写核心恐惧，focus 写这套系数怎么落地
//
// 字段：
//  - gain: 全局情绪增量
//  - posGain / negGain: 正/负事件额外缩放（约定 pos > neg）
//  - closenessSensitivity: 越亲近被伤越疼（1=原版）
//  - halfLifeMul: 情绪半衰（>1 更黏，<1 来得快去得快）
//  - moodPull: 慢心情被情绪池拉动的力度
//  - arousalGain: 唤醒（上头/兴奋）缩放
//  - softCeil: 软顶 { floors, coeffs }
import { getConfig } from './config.js';

/**
 * 九型人格 → 情绪系数。
 * number: 型号；mean/fear: 动机与恐惧；tip: 切换时给人看的直观说明（不算公式）。
 */
export const EMOTION_PROFILES = {
  t1: {
    id: 't1', number: 1,
    name: '完美型',
    en: 'The Reformer',
    mean: '想正确、守规矩、变更好。',
    fear: '怕犯错、怕被批评。',
    tip: '平时稳、有分寸；被挑错或觉得乱来时会闷一会儿，不会一直炸。',
    gain: 0.88, posGain: 1.18, negGain: 0.92,
    closenessSensitivity: 0.75, halfLifeMul: 1.08,
    moodPull: 0.17, arousalGain: 0.78,
    softCeil: { floors: [20, 38, 54, 72], coeffs: [1, 0.38, 0.16, 0.07, 0.025] }
  },
  t2: {
    id: 't2', number: 2,
    name: '助人型',
    en: 'The Helper',
    mean: '想被需要、被喜欢。',
    fear: '怕不被爱。',
    tip: '帮上忙、被谢谢时特别来劲；被晾着会更在意、更失落一点。',
    gain: 1.1, posGain: 1.42, negGain: 1.02,
    closenessSensitivity: 1.28, halfLifeMul: 1.12,
    moodPull: 0.26, arousalGain: 0.92,
    softCeil: { floors: [16, 34, 50, 70], coeffs: [1.05, 0.4, 0.18, 0.08, 0.03] }
  },
  t3: {
    id: 't3', number: 3,
    name: '成就型',
    en: 'The Achiever',
    mean: '想成功、被认可。',
    fear: '怕没价值。',
    tip: '被夸、接梗很来劲，容易得意；翻车或比下去会有点挂脸，但底色还是亮的。',
    gain: 1.15, posGain: 1.48, negGain: 0.98,
    closenessSensitivity: 0.9, halfLifeMul: 0.98,
    moodPull: 0.28, arousalGain: 1.18,
    softCeil: { floors: [16, 34, 50, 70], coeffs: [1.08, 0.38, 0.16, 0.07, 0.025] }
  },
  t4: {
    id: 't4', number: 4,
    name: '自我型',
    en: 'The Individualist',
    mean: '想独特、真实。',
    fear: '怕平庸、被抛弃。',
    tip: '开心和难过都更浓一点；低落、孤单会更缠人，整体仍偏正。',
    gain: 1.2, posGain: 1.32, negGain: 1.12,
    closenessSensitivity: 1.32, halfLifeMul: 1.35,
    moodPull: 0.24, arousalGain: 0.95,
    softCeil: { floors: [15, 32, 48, 68], coeffs: [1.08, 0.48, 0.22, 0.09, 0.035] }
  },
  t5: {
    id: 't5', number: 5,
    name: '理智型',
    en: 'The Investigator',
    mean: '想理解世界、保存精力。',
    fear: '怕无能、被消耗。',
    tip: '情绪偏淡、不容易大起大落；被掏空或搞砸时会闷一下，但正的还是多一点。',
    gain: 0.7, posGain: 1.0, negGain: 0.8,
    closenessSensitivity: 0.5, halfLifeMul: 0.9,
    moodPull: 0.14, arousalGain: 0.55,
    softCeil: { floors: [22, 40, 56, 74], coeffs: [0.9, 0.34, 0.14, 0.06, 0.02] }
  },
  t6: {
    id: 't6', number: 6,
    name: '忠诚型',
    en: 'The Loyalist',
    mean: '想安全、有依靠。',
    fear: '怕失控、被背叛。',
    tip: '开心来得稳；更容易先绷着、想最坏，不安会粘一会儿，但日常还是偏暖。',
    gain: 1.0, posGain: 1.2, negGain: 1.08,
    closenessSensitivity: 1.18, halfLifeMul: 1.22,
    moodPull: 0.2, arousalGain: 1.05,
    softCeil: { floors: [16, 34, 50, 70], coeffs: [1.02, 0.46, 0.22, 0.09, 0.035] }
  },
  t7: {
    id: 't7', number: 7,
    name: '活泼型',
    en: 'The Enthusiast',
    mean: '想快乐、体验新鲜。',
    fear: '怕痛苦、无聊。',
    tip: '开心放大、烦心事缩得快；冷场无聊会有，但不太往心里去。',
    gain: 1.2, posGain: 1.52, negGain: 0.78,
    closenessSensitivity: 0.58, halfLifeMul: 0.82,
    moodPull: 0.3, arousalGain: 1.25,
    softCeil: { floors: [18, 36, 52, 72], coeffs: [1.1, 0.38, 0.15, 0.06, 0.02] }
  },
  t8: {
    id: 't8', number: 8,
    name: '挑战型',
    en: 'The Challenger',
    mean: '想掌控、保护自己人。',
    fear: '怕被控制、软弱。',
    tip: '被认可很得意；被怼会硬刚、火气来得快，但不耽误平时还挺嗨。',
    gain: 1.2, posGain: 1.38, negGain: 1.1,
    closenessSensitivity: 0.88, halfLifeMul: 1.02,
    moodPull: 0.23, arousalGain: 1.42,
    softCeil: { floors: [20, 38, 54, 72], coeffs: [1.12, 0.4, 0.18, 0.08, 0.03] }
  },
  t9: {
    id: 't9', number: 9,
    name: '和平型',
    en: 'The Peacemaker',
    mean: '想和谐、避免冲突。',
    fear: '怕失去连接。',
    tip: '不太爱炸、整体偏稳偏暖；被冷落会轻轻失落，过一会儿就过去了。',
    gain: 0.78, posGain: 1.1, negGain: 0.75,
    closenessSensitivity: 0.68, halfLifeMul: 1.1,
    moodPull: 0.17, arousalGain: 0.58,
    softCeil: { floors: [20, 38, 54, 74], coeffs: [0.95, 0.36, 0.15, 0.06, 0.02] }
  }
};

/** 旧 6 档 id → 九型，避免已落盘配置变成未知档。 */
const LEGACY_ID = {
  extrovert_sunny: 't7',
  introvert_soft: 't2',
  calm_rational: 't5',
  optimist: 't7',
  sensitive: 't4',
  fiery: 't8'
};

const DEFAULT_ID = 't7';

function normalizeId(id) {
  const raw = String(id || '').trim();
  if (EMOTION_PROFILES[raw]) return raw;
  if (LEGACY_ID[raw]) return LEGACY_ID[raw];
  if (/^t[1-9]$/.test(raw)) return raw;
  return DEFAULT_ID;
}

/** 读当前档；非法/未知/旧 id 回落默认（旧 id 会映射到九型）。 */
export function getEmotionProfile() {
  let id = '';
  try {
    id = String(getConfig()?.persona?.emotionProfile || '').trim();
  } catch {
    id = '';
  }
  return EMOTION_PROFILES[normalizeId(id)] || EMOTION_PROFILES[DEFAULT_ID];
}

export function listEmotionProfiles() {
  return Object.values(EMOTION_PROFILES)
    .sort((a, b) => a.number - b.number)
    .map(({ id, number, name, en, mean, fear, tip, focus, desc }) => ({
      id, number, name, en, mean, fear,
      // 旧字段 focus 仍透出，UI 优先 tip
      tip: tip || focus,
      desc: desc || mean
    }));
}

export { DEFAULT_ID as DEFAULT_EMOTION_PROFILE, normalizeId };
