// 指令前置对外提供的**服务能力**（其它插件调用它们，而不是自己重造轮子或改核心）。
//
// 调用方写法：
//   api.capability('ai.ask', { prompt: '你好' })      软依赖：没有就降级
//   manifest.requires: ['ai.ask']                     硬依赖：没有就显示"依赖未就绪"
//
// 底层用的是核心已经实现好的东西：模型调用、搜索、存档、定时、表情库、群管理…
// 插件自己不用去 import src/，也不用各自打补丁。
//
// 契约：
//   · 全是 async，返回结构化对象；
//   · "参数不对/做不到"抛错（调用方自己决定怎么回执）；
//   · "这个能力现在用不了"返回 { ok:false, error }（例如表情库是空的）。

/** 核心句柄由 src/app.js 的消息入口调用点提供（见 patch.mjs 的 dispatch 块）。 */
function need(host, what) {
  if (!host) throw new Error(`${what}：核心句柄尚未就绪（等一条消息进来之后再用）`);
  return host;
}

const str = (v) => String(v ?? '').trim();
const int = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : fallback;
};

function requireChatKey(args) {
  const chatKey = str(args.chatKey);
  if (!chatKey) throw new Error('chatKey 不能为空（形如 group:123 / private:456）');
  return chatKey;
}

/**
 * 造出这一组能力。
 * @param {object} deps
 * @param {() => object|null} deps.getHost  取核心句柄（由 index.js 在每次消息分发时刷新）
 * @param {() => object} deps.getSettings   取本插件自己的配置（moderation 规则在它里面）
 * @param {(msg: string) => void} [deps.log]
 */
export function createServices({ getHost, getSettings, log }) {
  return {
    /**
     * 直接问一次模型（用当前的 key / 模型 / 代理路径 / 重试与计费链路）。
     * 默认**不留痕**：不建会话、不存档、不进记忆 —— 要留痕请调用方自己写。
     * args: { prompt | messages, system?, temperature?, maxTokens? }
     */
    'ai.ask': async (args = {}) => {
      const host = need(getHost(), 'ai.ask');
      const messages = Array.isArray(args.messages) && args.messages.length
        ? args.messages.map((m) => ({ role: str(m?.role) || 'user', content: String(m?.content ?? '') }))
        : [
            ...(str(args.system) ? [{ role: 'system', content: str(args.system) }] : []),
            { role: 'user', content: str(args.prompt ?? args.text) }
          ];
      if (!messages.length || !str(messages[messages.length - 1].content)) {
        throw new Error('ai.ask：prompt（或 messages）不能为空');
      }
      const r = await host.chat(messages, {
        temperature: args.temperature === undefined || args.temperature === null ? null : Number(args.temperature),
        maxTokens: Math.max(0, int(args.maxTokens, 0))
      });
      return {
        ok: true,
        text: String(r?.message?.content ?? '').trim(),
        model: String(r?._usedModel || r?.model || ''),
        usage: r?.usage || null
      };
    },

    /** 用当前配置的搜索服务搜关键词。args: { query, count? } */
    'search.web': async (args = {}) => {
      const host = need(getHost(), 'search.web');
      const query = str(args.query ?? args.q);
      if (!query) throw new Error('search.web：query 不能为空');
      const r = await host.search(query);
      const results = Array.isArray(r?.results) ? r.results : [];
      const count = Math.max(1, Math.min(10, int(args.count, results.length || 6)));
      return { ok: true, query: String(r?.query || query), results: results.slice(0, count) };
    },

    /**
     * 会话控制。
     *   { action: 'clear', chatKey }            清掉这个会话的上下文（聊天记录）
     *   { action: 'pause' | 'resume', reason? } 暂停/恢复机器人回话（全局）
     *   { action: 'status' }                    读当前状态
     */
    'session.control': async (args = {}) => {
      const host = need(getHost(), 'session.control');
      const action = str(args.action) || 'status';
      if (action === 'clear') {
        const chatKey = requireChatKey(args);
        host.store.clearChat(chatKey);
        return { ok: true, action, chatKey };
      }
      if (action === 'pause' || action === 'resume') {
        const wasPaused = host.orchestrator.paused === true;
        host.orchestrator.setPaused(action === 'pause', str(args.reason) || '插件要求');
        // 恢复要和"控制台那个恢复按钮"一致：默认把暂停期间积压的消息接着处理。
        // 少这一步就会出现"界面恢复了、积压消息却像没发生过"的不一致（踩过）。
        if (action === 'resume' && wasPaused && args.skipBacklog !== true) {
          try { await host.orchestrator.drainBacklogAfterResume?.(); } catch { /* 积压处理失败不影响"已恢复" */ }
        }
        return { ok: true, action, paused: host.orchestrator.paused === true };
      }
      if (action === 'status') {
        return { ok: true, paused: host.orchestrator.paused === true, reason: String(host.orchestrator.pauseReason || '') };
      }
      throw new Error(`session.control：不认识的 action「${action}」`);
    },

    /**
     * 定时任务（用核心的提醒队列，插件不用自己 setInterval，重启也不会泄漏）。
     *   { action: 'add', chatKey, text, at }   at = 毫秒时间戳，必须是将来的时间
     *   { action: 'list', chatKey? }
     *   { action: 'remove', id }
     */
    'schedule.cron': async (args = {}) => {
      const host = need(getHost(), 'schedule.cron');
      const action = str(args.action) || 'add';
      if (action === 'list') {
        const chatKey = str(args.chatKey);
        return { ok: true, items: host.reminders.pending(chatKey || null) };
      }
      if (action === 'remove') {
        const id = str(args.id);
        if (!id) throw new Error('schedule.cron：remove 需要 id');
        host.reminders.cancel(id);
        return { ok: true, action, id };
      }
      if (action !== 'add') throw new Error(`schedule.cron：不认识的 action「${action}」`);
      const chatKey = requireChatKey(args);
      const text = str(args.text);
      if (!text) throw new Error('schedule.cron：add 需要 text');
      const at = int(args.at ?? args.dueAt, 0);
      if (!at || at <= Date.now()) throw new Error('schedule.cron：at 必须是未来的毫秒时间戳');
      const item = host.reminders.add({ chatKey, text, dueAt: at, createdBy: str(args.by) });
      return { ok: true, action, item };
    },

    /** 从表情库里挑一张（可给 query 过滤）。args: { query?, limit?, random? } */
    'sticker.pick': async (args = {}) => {
      const host = need(getHost(), 'sticker.pick');
      const limit = Math.max(1, Math.min(200, int(args.limit, 48)));
      const listed = await host.stickers.list(str(args.query), limit);
      const stickers = Array.isArray(listed?.stickers) ? listed.stickers : [];
      if (!stickers.length) return { ok: false, error: str(args.query) ? '没有匹配的表情' : '表情库是空的' };
      const pick = args.random === false ? stickers[0] : stickers[Math.floor(Math.random() * stickers.length)];
      const full = await host.stickers.find(pick.id);
      return {
        ok: true,
        sticker: { id: String(pick.id), url: String(full?.url || ''), desc: String(pick.desc || pick.localNote || '') }
      };
    },

    /**
     * 内容检查：拿「指令前置 → 内容检查」里配的关键词与正则过一遍。
     * args: { text }；返回 { ok, hits }（ok=false 表示命中了）。
     */
    'moderation.check': async (args = {}) => {
      const text = String(args.text ?? '');
      const rules = getSettings().moderation;
      const hits = [];
      for (const w of rules.words) if (w && text.includes(w)) hits.push({ type: 'word', pattern: w, match: w });
      for (const p of rules.patterns) {
        try {
          const m = text.match(new RegExp(p, 'i'));
          if (m) hits.push({ type: 'regex', pattern: p, match: String(m[0]).slice(0, 60) });
        } catch { /* 一条写坏的正则不该让整个检查失效 */ }
      }
      return { ok: hits.length === 0, hits, rules: { words: rules.words.length, patterns: rules.patterns.length } };
    },

    /**
     * 切换人设：按**名字精确匹配**（支持带空格的名字），在内置人设 + 用户保存的自定义人设里找。
     * args: { name }；找不到时返回 { ok:false, names }，调用方可以把可选名字回给用户。
     */
    'persona.apply': async (args = {}) => {
      const host = need(getHost(), 'persona.apply');
      const name = str(args.name);
      if (!name) throw new Error('persona.apply：name 不能为空');
      const cfg = host.getConfig() || {};
      const builtin = (await host.personas()) || {};
      const customs = Array.isArray(cfg.customPersonas) ? cfg.customPersonas : [];
      const all = [
        ...Object.entries(builtin).map(([key, p]) => ({
          id: key, name: String(p?.name || key), text: String(p?.text || ''), customRules: '', source: 'builtin'
        })),
        ...customs.map((p, i) => ({
          id: `custom_${i}`, name: String(p?.name || `自定义 ${i + 1}`), text: String(p?.text || ''),
          customRules: String(p?.customRules || ''), source: 'custom'
        }))
      ].filter((p) => p.text);
      const hit = all.find((p) => p.name === name);
      if (!hit) return { ok: false, error: `没有叫「${name}」的人设`, names: all.map((p) => p.name) };
      host.updateConfig({ persona: { roleText: hit.text, customRules: hit.customRules || '' } });
      log?.(`人设已切换为「${hit.name}」`);
      return { ok: true, name: hit.name, id: hit.id, source: hit.source };
    }
  };
}
