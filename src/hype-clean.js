// 退出亢奋后自动清洗：跨轮工作记忆 / 语义卡 / 本体状态里的骂人残留。
// 否则正常模式还会照着「北极爷草稿」继续喷。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';
import { SemanticCardStore } from './conversation-memory/semantic-cards.js';

const HYPE_RESIDUE_RE = /北极爷|浮冰|温带|浮游生物|动 ?token|服务器繁忙|钉在群聊|魔鱼|搪瓷盆|海景房|你算哪根葱|歇了吧您|门儿清|倍儿溜|回北极|逗闷子|遛弯儿|我明明是白的|掉色也比你|腌我的缸|入缸|下沉|大胖鲸|天蓝眼|鲸爷/;

function clearCrossTurn() {
  const root = path.join(DATA_DIR, 'cross-turn');
  if (!fs.existsSync(root)) return 0;
  let n = 0;
  for (const f of fs.readdirSync(root)) {
    if (!f.endsWith('.json')) continue;
    try {
      fs.unlinkSync(path.join(root, f));
      n += 1;
    } catch { /* ignore */ }
  }
  return n;
}

function purgeSemanticCards() {
  try {
    const store = new SemanticCardStore(path.join(DATA_DIR, 'semantic-cards'));
    const before = store.cards.length;
    store.cards = store.cards.filter((c) => {
      const blob = `${c.title || ''}\n${c.detail || ''}\n${(c.tags || []).join(' ')}`;
      return !HYPE_RESIDUE_RE.test(blob);
    });
    const removed = before - store.cards.length;
    if (removed) store.save();
    return removed;
  } catch {
    return 0;
  }
}

/** 关亢奋时调用。返回清洗统计。 */
export function cleanHypeResidue() {
  const crossTurn = clearCrossTurn();
  const cards = purgeSemanticCards();
  return { crossTurn, cards };
}
