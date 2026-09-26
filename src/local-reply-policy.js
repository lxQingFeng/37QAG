// 回复策略：本地预算试验（可选）+ 通用「自动收尾」。
//
// ── 为什么要加「自动收尾」（2026-09-19 实测）──
// 用 6710 份会话存档 + 用量台账量化（2466 个会话、1576 个决策点）：
//   普通模式下 send_message 成功后，代码会追加一句「必须再调用 finish 收尾」，
//   于是模型仅仅为了说一句「我讲完了」就要再跑一整轮 —— 平均 12,279 输入 token。
//   而其中 **92.4% 的会话它一个字都没再补**（样本内白烧 1789 万输入 token）。
//   台账里更大的口径：近 1200 个会话 2507 轮、3331 万输入 token，
//   其中「末轮仅 finish」占 27% 的轮次 / 32.7% 的输入 token。
//
// 关键：这跟「判定准不准」无关 —— 那一轮不产出任何内容，唯一作用是让模型表态"结束"。
// 所以分两层处理：
//   ① 提示词引导它**在同一轮里** send + finish（零风险、默认生效；见 tools.js / prompt.js）；
//   ② 它仍分两轮时，策略层直接收尾（本文件 canEndReplyBatch），不再为一句「讲完了」多跑一轮。
//
// 「续」的真实代价（同一批样本）：决策点之后云端那一轮确实又发了内容的只有 7.6%，
// 而这 7.6% 里又有 51% 只是把刚发过的话换个说法重写一遍（会被去重挡掉，等于也是空转）。
// 所以自动收尾的净损失 = 真的少说一句 ≈ 3%。
export function localReplyPolicy(api, entries = []) {
  let local = false;
  try { local = ['localhost', '127.0.0.1', '[::1]'].includes(new URL(api.baseUrl).hostname); } catch {}
  const options = api.localReplyTrial || {};
  // 本地预算试验：只控制预算放大与截断恢复；仅 localhost + enabled 生效
  const enabled = options.enabled === true && local;
  // 通用自动收尾：任意模型都可用（含云端）
  const af = api.autoFinish && typeof api.autoFinish === 'object' ? api.autoFinish : {};
  // finish 工具已移除：发送类工具成功后 orchestrator 直接结束；
  // multiOnly/autoFinish 仅作历史兼容，不再依赖 finish 往返。
  const autoFinish = true;
  const text = entries.map(e => String(e.text || '')).join('\n');
  const complex = /分析|推理|推导|计算|算一下|解题|证明|比较|对比|区别|解释|为什么|怎么实现|如何实现|排查|报错|代码|方案|步骤|详细|总结|梳理|利弊|优缺点|\d\s*[+*/×÷=]\s*\d/i.test(text);
  const configuredBase = Number(api.maxTokens);
  const base = Number.isFinite(configuredBase) && configuredBase > 0 ? configuredBase : 4096;
  const cap = Math.max(base, Math.min(8192, Math.max(2048, Number(options.maxTokens) || 4096)));
  return {
    enabled, complex,
    autoFinish,
    // 默认仍要求「本会话已发出 ≥2 条文本（或发过图）」才自动收尾 ——
    // 实测决策点里 81.9% 本来就发了 ≥2 条，这条护栏几乎不損失覆盖面，
    // 却把「只发了一句开场白、后面还有话」这类情况整个挡在外面。
    // 想要更激进（单条也收尾）就设 api.autoFinish.multiOnly = false。
    multiOnly: af.multiOnly !== false,
    budget: enabled && complex ? Math.min(cap, Math.max(base, Number(options.complexTokens) || 3072)) : base,
    cap,
    needsImage: /(?:发|来|找|搜|给).{0,16}(?:图片|照片|壁纸|张.{0,8}图)|(?:图片|照片|壁纸).{0,8}(?:发|给)/.test(text),
    needsSearch: /查一下|查一查|查查|搜索|搜一下|真新闻|最新.{0,8}(?:新闻|消息|价格)/.test(text),
    // ── 点歌（2026-09-22 加，别再删）──
    // 实测：09-21/09-22 共 4 次「search_music → send_message →（自动收尾）」——
    //   模型歌都搜到了、也说了一句"给你来首…"，然后本轮被自动收尾，**send_music 永远没机会调用**。
    //   （老版本 finish 是工具，模型可以"发字 → 发卡 → finish"跨三轮，所以那时没暴露；
    //     send_music 的工具说明至今还写着"要引用请先 send_message 再发本工具"，正是这个两步流程。）
    // 正则是拿 811 条真实触发文本（9/19 起）调出来的：命中 3.1%，其中 14/25 确实发了音乐卡，
    //   剩下的是"群友点了歌但机器人没理"——宁可白给一轮，也别再把卡吞掉。
    // `首(?![先次])` 是防"重点首先 / 未来首次"这种字面误伤。
    needsMusic: /(?:(?:点|来|放|整|推|给|送|换|要|听|求)[^，。！？\n]{0,6}?(?:歌|曲|音乐|BGM|bgm|唱片))|(?:(?:歌|曲|音乐|BGM|bgm)[^，。！？\n]{0,4}?(?:来|放|点|推|听)(?:一|两|几|再)?(?:首|曲|个|支)?)|(?:(?:来|点|放|整|推|换|要|听)(?:一|两|几|再)?首(?![先次]))/.test(text)
  };
}

export function nextTruncationBudget(current, cap) {
  return Math.min(cap, Math.max(1800, (current || 900) * 2));
}

// End only after a successful delivery-only batch. Failed sends, previews and
// outstanding image/search work must retain the normal tool loop.
export function canEndReplyBatch(policy, calls, results, newSent, allSent, searched) {
  // 无 finish 后：任何成功发送即可收尾（orchestrator 另有发送后强制结束）
  if (!newSent.length || !calls.length || results.some(r => r.isError)) return false;
  if (!calls.every(c => ['send_message', 'send_image', 'send_sticker', 'send_music', 'send_bilibili', 'send_forward', 'send_poke'].includes(c.function?.name))) return false;
  // ⚠️ 图片/卡片不算"说完了"（2026-09-21）：只发图就收尾会把后面那半句砍掉。
  // 实测 13 次"只发图、一个字没说"被自动收尾。要么同轮配了文字，要么交给下一轮。
  const IMAGEISH = ['send_image', 'send_forward', 'send_bilibili', 'send_music'];
  if (calls.some(c => IMAGEISH.includes(c.function?.name)) && !allSent.some(s => s.type === 'text')) return false;
  if (policy?.needsImage && !allSent.some(s => s.type === 'image')) return false;
  if (policy?.needsSearch && !searched) return false;
  // 点歌同理：要了歌、卡还没发出去，就不算"说完了"（2026-09-22）。
  // 调用方在"已经宽限过一轮"之后会把 needsMusic 摘掉，所以不会无限拖。
  if (policy?.needsMusic && !allSent.some(s => s.type === 'music')) return false;
  // ⚠️ 2026-09-22 实测：下面这条"预告式收尾"护栏**实际上几乎跑不到** ——
  //   orchestrator 的"发送即收尾"路径排在 canEndReplyBatch 前面，一旦先 finish 就轮不到这里。
  //   那要不要把它挪到前面去、给"稍等，我找一下"这类预告也宽限一轮？
  //   量过之后**决定不挪**：581 个自动收尾会话里，最后一句含预告词的只有 13 个，
  //   逐条看过全是玩笑话（"这就对了嘛""让我也云吃两口"），没有一个真在承诺一件没做的事。
  //   而宽限一轮 ≈ 12,000 输入 token —— 为一个实测 0 次的场景花钱不值得。
  //   同类问题的真身是"先查后发"（点歌 9 次），已由上面的 needsMusic + orchestrator 的
  //   musicGrace 按**工具状态**（不发卡就不收尾）处理，不靠措辞判断。
  //   这条留着当保险：万一哪天发送路径调整了，它还能兜住"说了要发却没发"。
  if (newSent.some(s => /(?:我|先|再|马上|稍等).{0,8}(?:去查|查一下|搜一下|找一下|再查|再搜|发图|找图)/.test(s.text || ''))) return false;
  // 这条与 finish 下线无关，别跟着删： visibly 截断的话（"算式是：" / "原因是"）不该触发自动收尾，
  // 否则模型说到一半停下，整轮就带着半句话结束了（代价是再来一轮把话补完，值得）。
  if (newSent.some(s => /(?:[:：]|算式是|原因是|分别是|如下|首先|然后|接下来|还有)[\s…。.]*$/.test(s.text || ''))) return false;
  return true;
}
