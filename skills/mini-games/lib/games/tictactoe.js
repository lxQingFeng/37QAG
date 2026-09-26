// 井字棋 3x3：发起人执 X 先落子，第二个人执 O，第三人插手 reject。三连结束、九格满平局。
//
// ── 为什么只让两个人玩 ──
// 三个人必然抢 X/O 两个记号，判定会自相矛盾（"谁赢了"没法回答）。第三个人插手直接 reject：
// 局面不动、群里不发消息，理由只进 forModel。
//
// ── 为什么 say 里不写"该你了 / 传 game_move" ──
// say 是插件**直接发到群里**的，会永久留在聊天记录里、每轮重新计费，还会把模型教坏
// （实测它照着抄）。所以：给模型的话一律放 forModel；群里只说"谁落了哪一格"。
//
// ── 平局 ──
// 契约里 over 必须给 winner，所以平局用 winner:'平局' 占位；判"谁赢了"时必须先排除它。
//
// ── 没有隐藏信息 ──
// 棋盘是公开的，secretOf 明确返回 []（不是"忘了写"）。
const WIN_LINES = [
  [1, 2, 3], [4, 5, 6], [7, 8, 9],
  [1, 4, 7], [2, 5, 8], [3, 6, 9],
  [1, 5, 9], [3, 5, 7]
];

const clip = (s, n) => {
  const t = String(s || '');
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
};

/**
 * 方位词 → 格号。横竖都认：先在小窗口里找"行词+列词"，找不到再退化成"只说了上/左"。
 * 有意不搜"上"：它会命中"马上""晚上"这类词。窗口限定成两字组合，噪音进不来。
 */
function parsePos(text) {
  const t = String(text || '');
  const num = t.match(/[1-9]/);
  if (num) return Number(num[0]);
  const rows = ['上', '中', '下'];
  const cols = ['左', '中', '右'];
  for (let i = 0; i < t.length; i += 1) {
    const w = t.slice(i, i + 2);
    const r = rows.findIndex((c) => w.includes(c));
    const c = cols.findIndex((x) => w.includes(x));
    if (r >= 0 && c >= 0) return r * 3 + c + 1;
  }
  if (/左上|上左/.test(t)) return 1;
  if (/右上|上右/.test(t)) return 3;
  if (/左下|下左/.test(t)) return 7;
  if (/右下|下右/.test(t)) return 9;
  for (const [word, pos] of [['左上', 1], ['中上', 2], ['右上', 3], ['左中', 4], ['中间', 5],
    ['右中', 6], ['左下', 7], ['中下', 8], ['右下', 9], ['中心', 5]]) {
    if (t.includes(word)) return pos;
  }
  const row = rows.findIndex((x) => t.includes(x));
  const col = cols.findIndex((x) => t.includes(x));
  if (row >= 0) return row * 3 + 2;      // 只说「上排」= 上排中间
  if (col >= 0) return 4 + col;          // 只说「左边」= 左列中间
  return 0;
}

/** 记号 → 玩家名：优先查 board 里记的，再退回引擎的开局人 */
function nameOf(state, mark) {
  const b = state?.board || {};
  const n = mark === 'X' ? b.xName : b.oName;
  if (n) return String(n);
  const host = state?.host || null;
  if (mark === 'X' && host?.name) return String(host.name);
  return '这位';
}

export default {
  id: 'tictactoe',
  name: '井字棋',
  aliases: ['井字', '井字棋', 'tic-tac-toe', 'tictactoe', '三连', '圈叉'],
  desc: '3x3 井字棋：两人轮流落子，先把三个连成一线的人赢',

  start(cfg, { player } = {}) {
    const id = player?.id != null ? String(player.id) : '';
    const name = String(player?.name || '') || '这位';
    const host = player ? { id, name } : null;
    return {
      // board 必须能 JSON 序列化：格子数组 + 两个玩家 + 轮次，不存函数不存 Map
      board: {
        cells: [], px: id, nx: '', xName: name, oName: '',
        turn: 'X', over: false, winner: '', starter: 'X'
      },
      say: `井字棋开局：格子编号 1 2 3 / 4 5 6 / 7 8 9，报数字或「左上/中/右下」都行。`
        + `${name} 执 X 先走，第二个人进来执 O。`,
      forModel: `这局井字棋由 ${name} 执 X 先落子，第二个人进来执 O。`
        + '玩家报数字或方位词后，把他的话原样交给 game_move，输赢由插件判。'
    };
  },

  move(cfg, state, { text, player } = {}) {
    const b = state?.board || {};
    const cells = Array.isArray(b.cells) ? b.cells : [];
    if (b.over) return { reject: true, forModel: '这局已经结束了，别再把这一步算进去。' };
    if (!player) return { reject: true, forModel: '没认出这一步是谁说的。' };
    const pos = parsePos(text);
    if (!pos) return { reject: true, forModel: '没听到格子。让玩家报 1~9 的数字，或「左上/中/右下」这种方位词。' };
    if (cells.some((c) => Number(c.i) === pos)) {
      return { reject: true, forModel: `${pos} 号格已经有 ${cells.find((c) => Number(c.i) === pos)?.n || '子'} 了，换一个空格。` };
    }

    const id = player?.id != null ? String(player.id) : '';
    const name = String(player?.name || '') || '这位';
    const px = String(b.px ?? '');
    const mineX = !!id && id === px;
    // X/O 由"是不是发起人"定，名字只在引擎查不到 id 时兜底
    let mark = '';
    if (mineX || (!id && name && name === String(b.xName || ''))) mark = 'X';
    else if (b.nx && id && id === String(b.nx)) mark = 'O';
    else if (!b.nx) mark = 'O';
    else return { reject: true, forModel: `这局是 ${nameOf(state, 'X')} 和 ${nameOf(state, 'O')} 在下，第三个人先别插手，等这局结束再开一局。` };

    if ((b.turn || 'X') !== mark) {
      return { reject: true, forModel: `现在轮到 ${nameOf(state, b.turn || 'X')}（${b.turn || 'X'}），${name} 是 ${mark}，这一步先别记进局面。` };
    }

    const place = [...cells, { i: pos, n: mark, id, name }];
    const win = WIN_LINES.find((L) => L.every((i) => place.some((c) => Number(c.i) === i && c.n === mark)));
    const board = {
      ...b, cells: place, px, nx: mark === 'O' ? id : (b.nx || ''),
      xName: b.xName || (mark === 'X' ? name : ''), oName: b.oName || (mark === 'O' ? name : ''),
      turn: mark === 'X' ? 'O' : 'X'
    };
    if (win) {
      return {
        board: { ...board, over: true, winner: name }, over: true, winner: name,
        say: `🎉 ${name}（${mark}）落 ${pos} 号，${win.join('-')} 三连，赢了！`
      };
    }
    if (place.length >= 9) {
      return {
        board: { ...board, over: true, winner: '平局' }, over: true, winner: '平局',
        say: `九格满了，${name}（${mark}）落 ${pos} 号，这局平局。`
      };
    }
    const nt = board.turn;
    const nName = nt === 'X' ? board.xName : board.oName;
    return {
      board,
      say: `${name}（${mark}）落 ${pos} 号。${nName ? `轮到 ${nName}（${nt}）。` : `还差一个人来执 ${nt}。`}`,
      forModel: nName ? `现在轮到「${nName}」（${nt}）。` : `还没有第二个人，${name} 可以接着用 ${nt} 走。`
    };
  },

  /** 一行状态：棋盘压成「1:X 5:O」这种，再写轮到谁。不写祈使句。 */
  hint(cfg, state) {
    const b = state?.board || {};
    const marks = (Array.isArray(b.cells) ? b.cells : [])
      .filter((c) => c && c.n)
      .map((c) => `${c.i}:${c.n}`)
      .join(' ');
    const t = (b.turn || 'X') === 'O' ? 'O' : 'X';
    return clip(`棋盘 ${marks || '空盘'}｜轮到 ${t} ${clip(nameOf(state, t), 6)}`, 60);
  },

  /** 井字棋没有隐藏信息（棋盘是公开的） */
  secretOf() { return []; }
};
