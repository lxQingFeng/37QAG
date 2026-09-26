// 路径集中层（阶段二改造）：数据目录单根 + 路径 getter 集中 + 环境变量搬根 + 旧布局迁移。
//
// 设计（参考 AstrBot astrbot_path.py 的「getter 集中」模式，仅借鉴模式不抄代码）：
//   · 所有运行时数据路径都从这一层拿，业务模块不再自己拼 path.join(DATA_DIR, …)；
//   · 根目录由 config.js 决定（QQ_AGENT_DATA_DIR / QAG_DATA_HOME 环境变量 → data[/-N]）；
//   · 每类数据一个 getter 函数（惰性求值，测试可用 QAG_DATA_HOME 重定向到临时目录）；
//   · 迁移函数一次性把旧布局（command_data / 根目录日志）搬进新布局，幂等可重跑。
//
// 目录总则：用户产生的、需要备份的全部在 data/ 单根下；程序自带的只读资产
// （themes/ 内置主题、skills/、plugins/ 源码）留在程序根，不属于备份范围。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, DATA_DIR } from './config.js';

export { ROOT, DATA_DIR };

/** 数据根（data/ 或 data-N/ 或环境变量指定）。 */
export function dataRoot() { return DATA_DIR; }

/** 旧消息冷归档（history-cold.js，独立于 store 的 messages-cold 分层）。 */
export function historyColdDir() { return path.join(DATA_DIR, 'history-cold'); }

/** 核心日志目录（logger.js 与启动脚本共用）。 */
export function logsDir() { return path.join(DATA_DIR, 'logs'); }

/** 人设文件层（内置播种 + 用户可改，见 src/persona-files.js）。 */
export function personasDir() { return path.join(DATA_DIR, 'personas'); }

/** 插件/模块数据隔离根：每个插件一格，互相看不见。 */
export function pluginDataRoot() { return path.join(DATA_DIR, 'plugin-data'); }

/** 某个插件/模块的数据目录（id 会被消毒成文件系统安全的形式）。 */
export function pluginDataDir(skillId) {
  return path.join(pluginDataRoot(), String(skillId).replace(/[^a-z0-9._-]/gi, '_'));
}

/** 旧版插件数据根（迁移源，读取兼容用）。 */
export function legacyPluginDataRoot() { return path.join(DATA_DIR, 'command_data'); }

/** 聊天消息热段目录。 */
export function messagesDir() { return path.join(DATA_DIR, 'messages'); }

/** 聊天消息冷段目录（history-cold 归档）。 */
export function messagesColdDir() { return path.join(DATA_DIR, 'messages-cold'); }

/** store.js 冷分片目录的短别名（与热段 messages/ 对应）。 */
export function coldDir() { return messagesColdDir(); }

/** 机器人状态快照（bot-state.js）。 */
export function botStateFile() { return path.join(DATA_DIR, 'bot-state.json'); }

/** 表情包认知库（memes.js）。 */
export function memesFile() { return path.join(DATA_DIR, 'memes.json'); }

/** API 资讯缓存（api-news.js）。 */
export function apiNewsFile() { return path.join(DATA_DIR, 'api-news.json'); }

/** 模型价格表远程缓存（price-feed.js）。 */
export function priceFeedCacheFile() { return path.join(DATA_DIR, 'price-feed-cache.json'); }

/** 会话注册表目录。 */
export function sessionsDir() { return path.join(DATA_DIR, 'sessions'); }

/** 记忆根目录（分 chat 的来源化记忆）。 */
export function memoryDir() { return path.join(DATA_DIR, 'memory'); }

/** 人物印象目录。 */
export function memoryPeopleDir() { return path.join(memoryDir(), 'people'); }

/** 表情包图片目录。 */
export function stickerImagesDir() { return path.join(DATA_DIR, 'sticker-images'); }

/** 图库目录（image-lib）。 */
export function imagesLibDir() { return path.join(DATA_DIR, 'images-lib'); }

/** 用户主题目录（导入的主题落这里；内置主题在 ROOT/themes 只读）。 */
export function userThemesDir() { return path.join(DATA_DIR, 'themes'); }

/** 内置主题目录（程序资产，只读）。 */
export function builtinThemesDir() { return path.join(ROOT, 'themes'); }

/** 主题查找（用户优先，内置兜底）——迁移 themes.js 的双层语义。 */
export function themeDirs() { return [userThemesDir(), builtinThemesDir()]; }

/**
 * 旧布局迁移（幂等，进程启动时跑一次即可）：
 *   1. data/command_data/* → data/plugin-data/*（目录名更换，旧名留软兼容不留文件）；
 *   2. 根目录 launch-log.txt → data/logs/launch-log.txt（启动脚本遗留的旧位置）。
 * 已迁移 / 不存在的情况全部静默跳过；目录 rename 失败（跨设备等罕见情况）降级为
 * 「不迁移、读取时兼容旧路径」，绝不让启动失败。
 */
export function migrateLegacyLayout({ log = () => {} } = {}) {
  const moves = [];
  try {
    // 1) command_data → plugin-data（目录级 rename，原子且保留全部内容）
    const legacy = legacyPluginDataRoot();
    const next = pluginDataRoot();
    if (fs.existsSync(legacy) && !fs.existsSync(next)) {
      fs.mkdirSync(path.dirname(next), { recursive: true });
      try {
        fs.renameSync(legacy, next);
        moves.push(`command_data → plugin-data（${legacy} → ${next}）`);
      } catch (error) {
        // rename 失败（如跨设备）：逐个子目录搬，搬不动的留给读取兼容
        let moved = 0;
        try {
          fs.mkdirSync(next, { recursive: true });
          for (const name of fs.readdirSync(legacy)) {
            try {
              fs.renameSync(path.join(legacy, name), path.join(next, name));
              moved += 1;
            } catch { /* 单个搬不动就算了 */ }
          }
        } catch { /* next 建不出来就算了 */ }
        if (moved) moves.push(`command_data 部分迁移（${moved} 个插件目录）`);
        log(`[paths] command_data 整体迁移失败（${error?.message ?? error}），已按子目录尽力迁移`);
      }
    } else if (fs.existsSync(legacy) && fs.existsSync(next)) {
      // 两个都在（比如迁移到一半）：把旧目录里「新目录还没有的」子目录搬过去
      let moved = 0;
      for (const name of fs.readdirSync(legacy)) {
        const from = path.join(legacy, name);
        const to = path.join(next, name);
        if (!fs.existsSync(to)) {
          try { fs.renameSync(from, to); moved += 1; } catch { /* ignore */ }
        }
      }
      if (moved) moves.push(`command_data 补齐迁移（${moved} 个插件目录）`);
    }
  } catch (error) {
    log(`[paths] 迁移 command_data 失败：${error?.message ?? error}`);
  }

  try {
    // 2) 根目录 launch-log.txt → data/logs/
    const legacyLog = path.join(ROOT, 'launch-log.txt');
    const nextLog = path.join(logsDir(), 'launch-log.txt');
    if (fs.existsSync(legacyLog)) {
      fs.mkdirSync(logsDir(), { recursive: true });
      if (!fs.existsSync(nextLog)) {
        fs.renameSync(legacyLog, nextLog);
        moves.push('launch-log.txt → data/logs/launch-log.txt');
      } else {
        // 新位置已有（多实例写过）：旧文件追加时间戳归档名再搬，不覆盖
        let archived = nextLog;
        let n = 1;
        while (fs.existsSync(archived)) archived = path.join(logsDir(), `launch-log-${n++}.txt`);
        fs.renameSync(legacyLog, archived);
        moves.push(`launch-log.txt → data/logs/${path.basename(archived)}`);
      }
    }
  } catch (error) {
    log(`[paths] 迁移 launch-log.txt 失败：${error?.message ?? error}`);
  }

  return moves;
}
