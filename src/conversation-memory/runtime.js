// 运行时单例：消息巩固游标 + 工具共用一份索引。
// 数据目录跟随 QQ_AGENT_DATA_DIR / config.DATA_DIR（多实例隔离）。
import path from 'node:path';
import { DATA_DIR } from '../config.js';
import { createConversationMemory } from './tools.js';

let inst = null;
let maintTimer = null;

export function getConversationMemory() {
  if (inst) return inst;
  const messagesDir = path.join(DATA_DIR, 'messages');
  const memoryRoot = path.join(DATA_DIR, 'memory-v2');
  inst = createConversationMemory({ messagesDir, memoryRoot });
  return inst;
}

export function stopConversationMemoryMaintenance() {
  if (maintTimer) {
    clearInterval(maintTimer);
    maintTimer = null;
  }
}

/** 启动后台巩固：立刻一次 + 每 intervalMs 增量。失败只打日志，绝不影响主流程。 */
export function startConversationMemoryMaintenance({ log = console.log, intervalMs = 10 * 60 * 1000, onPruneSurface = null } = {}) {
  stopConversationMemoryMaintenance();
  const cm = getConversationMemory();
  const run = (why) => {
    try {
      const results = cm.consolidate({ force: false });
      const added = results.reduce((s, r) => s + (r.added || 0), 0);
      if (added > 0) log(`[memory-v2] 巩固(${why})：+${added} 条，索引 ${JSON.stringify(cm.consolidator.hippo.stats())}`);
    } catch (error) {
      log('[memory-v2] 巩固失败:', error?.message ?? error);
    }
    // 顺带清一遍语义卡垃圾。
    // ⚠️ 2026-09-21：`purgeJunk()` 写好了但**从来没有调用者** —— 所以卡库一路攒到 400 张，
    //   里面全是「睡吧 明天还得早起」和带 [CQ:at,qq=…] 机器码的残渣，注进提示词的就是这些。
    //   现在每次巩固（默认 10 分钟一次）都过一遍准入规则，规则变严时存量也会自己收敛。
    try {
      const removed = cm.cards?.purgeJunk?.() || 0;
      if (removed > 0) log(`[memory-v2] 语义卡清理：-${removed} 张，剩 ${cm.cards.stats().cards} 张`);
    } catch (error) {
      log('[memory-v2] 语义卡清理失败:', error?.message ?? error);
    }
    // 人物表层记忆（近况）跟着半衰：淡透的槽位删掉，只剩空壳的人档也删掉。
    // 不这么做的话，刷屏群里谁说了句"我好累"就会留一个空档案，people/ 会越读越慢。
    try {
      // ⚠️ 2026-09-22：这里原本写的是 `opts.onPruneSurface`，而 onPruneSurface 是**解构出来的参数**，
      //   函数里根本没有 `opts` 这个名字 → 每次巩固都抛 ReferenceError 被下面的 catch 吃掉，
      //   表面看只是日志里一行"清理失败"，实际是**表层记忆半衰清理从来没跑过**（people/ 越攒越多）。
      //   教训：只在 catch 里打日志的错误，等于没错误 —— 这条路径得有测试盯着（见 test/surface-memory-test.mjs）。
      const onPrune = typeof onPruneSurface === 'function' ? onPruneSurface : null;
      const r = onPrune ? onPrune() : null;
      if (r && (r.entriesRemoved > 0 || r.filesRemoved > 0)) {
        log(`[memory] 表层记忆清理：-${r.entriesRemoved} 条近况，-${r.filesRemoved} 个空档案`);
      }
    } catch (error) {
      log('[memory] 表层记忆清理失败:', error?.message ?? error);
    }
  };
  run('boot');
  maintTimer = setInterval(() => run('tick'), Math.max(60_000, intervalMs));
  maintTimer.unref?.();
  return maintTimer;
}
