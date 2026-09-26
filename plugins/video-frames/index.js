// 视频抽帧 Skill 入口。
//
// 只提供一个能力：`video.frames`
//   输入  { filePath, count?, maxWidth?, quality?, durationSec?, ffmpegPath? }
//   输出  { frames: string[], times: number[], error? }
//
// 核心模块（video-reader / tools）通过能力名取用它，**不 import 本文件**：
// 这样关掉这个 Skill 就退回"只给元信息"，换实现也不用改核心代码。
//
// 为什么抽帧要单独做成 Skill 而不是写死在核心：
//   · ffmpeg 是**外部可执行文件**，装没装、装在哪、能不能用都是环境相关的
//   · 抽几帧、多大尺寸、什么质量是**口味问题**，不同机器/不同模型差别很大
//   · 有些模型（Gemini、Qwen-VL 等）能原生读视频，那就完全不需要抽帧 ——
//     这时把 Skill 关掉即可，核心会走"原生视频输入"那条路
//   这三件事都符合"可插拔能力"的定位，而"决定走哪条路"是核心的职责。

import { extractFrames, findFfmpeg, probeDuration } from './frames.js';

let cfg = () => ({});
let log = () => {};

export function setup(api) {
  cfg = api.config;
  log = api.log;
}

export const providers = {
  // 抽帧：参数优先级 调用方传入 > 用户在设置页配的 > 默认值
  'video.frames': async ({ filePath, count, maxWidth, quality, durationSec, ffmpegPath } = {}) => {
    const c = cfg();
    const want = Math.max(1, Math.min(12, Math.round(Number(count) || Number(c.count) || 4)));
    const result = await extractFrames({
      filePath,
      count: want,
      maxWidth: Number(maxWidth) || Number(c.maxWidth) || 768,
      quality: Number(quality) || Number(c.quality) || 4,
      durationSec,
      ffmpegPath: ffmpegPath || null
    });
    if (result.error) log(`抽帧未成功：${result.error}`);
    return result;
  },

  // 让核心能问"现在这条路走得通吗"，用于 auto 模式的降级判断
  'video.frames.available': async ({ ffmpegPath } = {}) => {
    const ff = ffmpegPath || await findFfmpeg();
    return { ok: Boolean(ff), reason: ff ? '' : '未找到 ffmpeg（抽帧需要它）' };
  }
};

/**
 * 自检：没有 ffmpeg 时标为"依赖不满足"，UI 会直接显示原因。
 *
 * ⚠️ 这个函数**必须是同步的** —— SkillManager 的可用性判定（以及工具可用性判定）
 * 是同步调用链，`available()` 返回 Promise 会被当成"可用"（Promise 是 truthy）。
 * 但探测 ffmpeg 要 spawn 进程，只能异步。
 * 折中：首次调用先乐观返回"可用"并在后台探测，探测结果缓存下来，
 * 之后每次判定都读到真实状态（UI 下一次刷新就能看到原因）。
 * 不这么做的话表现是：明明没装 ffmpeg，设置页却显示"生效中"，
 * 而真正抽帧时又失败 —— 正是要消灭的那种"界面与实际不一致"。
 */
/**
 * ⚠️⚠️ 2026-09-22：**重探期间绝不许回退到"乐观可用"**（这里踩过一次真事故）。
 *
 * 旧写法是"失败结论满 60 秒就把 ffmpegKnown 清回 null"，而 null 分支返回 {ok:true}。
 * 结果只要 ffmpeg 不在 PATH 里，就形成 60 秒一轮的抖动：
 *   某次调用 → 清空 → 报"可用"（提示词里多出 128 字的视频段）→ 后台探测失败 → 又报"不可用"
 * 而 system 提示词是按 available() 拼的（SkillManager.isActive → getPromptSections），
 * 于是**两次运行只要落在 60 秒内，后一次的 system 就少一段 → 整个缓存块作废、按 125% 重建**。
 *
 * 线上留档里的原样证据（group:100000001，相邻运行间隔 22~47 秒）：
 *   11:50:54 视频段=有 → 11:51:16 无 → 11:51:49 无 → 12:00:08 有
 *   03:09:18 有 → 03:10:05 无（隔 47 秒）→ 03:34:21 有
 * 单次代价 ≈ 15,000 token 的显式缓存全量重建（约 18,750 计费单位）。
 *
 * 现在：一旦有结论就保持不变，后台重探只更新结论、绝不先清空。
 * 进程刚起来还没结论时仍乐观放行一次 —— 那是可接受的：每次启动最多变一次。
 */
let ffmpegKnown = null;   // null = 还没探测出来；'' = 确定没有；其它 = 找到的路径
let probing = false;
let probeAt = 0;          // 上次探测时间（失败后每 60 秒后台重探一次，但对外结论保持稳定）
const PROBE_RETRY_MS = 60000;
function probeFfmpegInBackground() {
  if (probing) return;
  if (ffmpegKnown) return;                                      // 成功结论长期有效
  if (probeAt && Date.now() - probeAt < PROBE_RETRY_MS) return;  // 失败结论 60 秒内不重复探
  probing = true;
  findFfmpeg()
    .then((p) => { ffmpegKnown = p || ''; probeAt = Date.now(); })
    .catch(() => { ffmpegKnown = ''; probeAt = Date.now(); })
    .finally(() => { probing = false; });
}

export function available() {
  if (ffmpegKnown === null) {
    probeFfmpegInBackground();
    return { ok: true };   // 首次乐观放行，探测结果会补上
  }
  // 已知不可用：后台每 60 秒重探一次（装好 ffmpeg 不用重启就能恢复），
  // 但对外结论保持"不可用"不变 —— 变了就会让 system 提示词变、缓存整块作废。
  if (ffmpegKnown === '') probeFfmpegInBackground();
  if (!ffmpegKnown) return { ok: false, reason: '未找到 ffmpeg，无法抽帧（装好 ffmpeg 后约 1 分钟内自动恢复）' };
  return { ok: true };
}

export function promptSections() {
  const c = cfg();
  return [{
    id: 'video-frames-active',
    title: '视频理解',
    priority: 35,
    content: `你看到的视频画面是从视频里抽出的 ${Number(c.count) || 4} 张截图，不是连续视频。帧与帧之间发生的事你看不到，描述时不要断言中间的连续过程。`
  }];
}

export const internals = {
  extractFrames, findFfmpeg, probeDuration,
  // 测试用：重置 ffmpeg 探测缓存
  __resetFfmpegCache: () => { ffmpegKnown = null; probing = false; probeAt = 0; },
  // 测试用：把"已知结论 + 上次探测时间"摆成指定值 —— 用来复现"已过 60 秒重探窗口"那一刻。
  // 见 test/extensions-load-test.mjs：那一刻必须继续报原结论，不许回退到乐观的 {ok:true}。
  __setProbeState: ({ known = null, at = 0 } = {}) => { ffmpegKnown = known; probeAt = at; }
};
