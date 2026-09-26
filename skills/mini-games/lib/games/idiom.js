// 成语接龙：上一句的最后一个字，作为下一句的第一个字；不能重复。
//
// 只校验「首字接上 + 够长 + 没重复」，**不查词典** —— 理由：
//   · 内置词典要么太小（接不上就判定失败，扫兴），要么几十万条塞进插件（体积与维护都不值）；
//   · 群聊里"这算不算成语"群友自己会管，插件把规则执行到位（不能改口、不能重复）就有得玩。
// 配置 idiomMinLen 可以放水到 2 字，减少"这不是成语"的争执。
//
// ── 2026-09-22 在群里修过的坑（别再退回去）──
//   候选词以前是把「连续汉字串」整段拿来接：「马到成功吧兄弟」会整体成为上一句，
//   于是下一个要接的字变成「弟」—— 接龙当场跑偏，谁都接不上，整局卡死。
//   现在：① 先掐掉句尾语气词（吧/啊/呢/了/哈/呀…）；② 整段太长的只取**前 4 个字**
//   （成语绝大多数是四字，而群友多说的话都在后面）；③ 优先挑"首字对得上且没被用过"的候选。
//   注意 ② 只是**追加**一个候选，原词照留 —— 否则「一二三…」这类长接龙会被砍掉。
//
// ── v3 契约要点 ──
//   say      = 群友看得到的（谁接了什么 + 下一个要接哪个字）
//   hint     = 一行状态：上一句 + 要接的字 + 已用几个（不写"该你接了"）
//   secretOf = 空数组：起手词在开场白里就公开了，这局没有隐藏值
const clip = (s, n = 52) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);
const firstChar = (w) => [...String(w || '')][0] || '';
const lastChar = (w) => { const a = [...String(w || '')]; return a[a.length - 1] || ''; };

/** 句尾语气/缀词：接龙要停在真正的最后一个字上，不能被「…吧」「…了」带偏。 */
const TAIL_RE = /[吧啊呢了哈呀嘛哦诶嗯咧咯啦哟哇嘿的]+$/u;
/** 整段连续汉字（2~12 个）：够长的才可能是接龙的词。 */
const RUN_RE = /[\u4e00-\u9fa5]{2,12}/g;

/**
 * 从群友原话里抠候选词。
 *   「我接：马到成功。」 → 马到成功
 *   「马到成功吧」       → 马到成功（掐语气词）
 *   「马到成功吧兄弟」   → 马到成功（掐不动"弟"，但超过 6 字 → 取前 4 个字）
 * 返回按长度升序去重 —— 短候选优先，更像成语。
 */
function candidatesOf(text, min) {
  const out = [];
  for (const raw of String(text || '').match(RUN_RE) || []) {
    const trimmed = raw.replace(TAIL_RE, '');
    if (trimmed.length >= min) out.push(trimmed);
    else if (raw.length >= min) out.push(raw);
    if (trimmed.length > 6) out.push([...trimmed].slice(0, 4).join(''));
  }
  return [...new Set(out)].sort((a, b) => a.length - b.length || a.localeCompare(b));
}

export default {
  id: 'idiom',
  name: '成语接龙',
  aliases: ['接龙', '成语', '词语接龙'],
  desc: '上一句最后一个字当下一句第一个字，不能重复',

  start(cfg) {
    const min = Math.max(2, Math.min(8, Number(cfg?.idiomMinLen) || 4));
    const first = SEEDS[Math.floor(Math.random() * SEEDS.length)];   // 随机只在这里发生，起手词写进 board
    return {
      board: { min, last: first, used: [first], by: '我' },
      say: `成语接龙，我先来：${first}（下一个接「${lastChar(first)}」开头，至少 ${min} 个字，不能重复）`
    };
  },

  move(cfg, state, { text, player }) {
    const b = state.board || {};
    const last = String(b.last || '');
    const need = lastChar(last);
    const min = Number(b.min) || 4;
    const cands = candidatesOf(text, min);

    if (!cands.length) {
      return { reject: true, forModel: `这句话里没看到 ≥${min} 个字的词。上一句是「${last}」，要接「${need}」开头。` };
    }
    const right = cands.filter((w) => firstChar(w) === need);
    if (!right.length) {
      return { reject: true, forModel: `「${cands[0]}」不是「${need}」开头，接不上。上一句是「${last}」。` };
    }
    const used = new Set(b.used || []);
    const hit = right.find((w) => !used.has(w));
    if (!hit) {
      return { reject: true, forModel: `「${right[0]}」这一局已经用过了，换一个「${need}」开头的。` };
    }
    const usedNext = [...(b.used || []), hit];
    const next = lastChar(hit);
    return {
      board: { ...b, last: hit, used: usedNext, by: String(player?.name || '').trim() || '群友' },
      say: `${String(player?.name || '').trim() || '群友'} 接「${hit}」，下一个要接「${next}」开头。`
    };
  },

  // 只报"上一句是什么 + 接下来要接哪个字"。不写"该谁接"（祈使句会让模型自己替群友接）
  hint(cfg, state) {
    const b = state.board || {};
    const last = String(b.last || '');
    return clip(`上一句「${last}」，要接「${lastChar(last)}」开头、≥${Number(b.min) || 4} 字，已用 ${(b.used || []).length} 个`);
  },

  // 起手词开局就公开了；接过的词也都在群里，这局没有隐藏值
  secretOf() { return []; }
};

/** 起手词：只用来开第一句，接龙本身不查词典。 */
const SEEDS = [
  '一心一意', '马到成功', '功成名就', '一举两得', '得心应手',
  '手到擒来', '来日方长', '长驱直入', '入木三分', '分秒必争',
  '争先恐后', '后来居上', '上行下效', '效死疆场', '场场爆满',
  '满腹经纶', '纶音佛语', '语重心长', '长生不老', '老当益壮',
  '壮志凌云', '云开见日', '日新月异', '异想天开', '开卷有益',
  '益寿延年', '年富力强', '强词夺理', '理直气壮', '壮志满怀',
  '怀才不遇', '遇人不淑', '淑质英才', '才华横溢', '溢于言表',
  '表里如一', '一鸣惊人', '人山人海', '海阔天空', '空前绝后'
];
