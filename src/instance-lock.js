// 运行标记：同一个数据目录（= 同一个 QQ 号 + 同一份配置）只允许一个 QQ Agent 进程在跑。
// 为什么需要：两个进程同时连同一个 OneBot，群消息会被处理两次、回复也会发两遍。
// 多实例的正确姿势是每个实例独立数据目录（QQ_AGENT_PROFILE / QQ_AGENT_DATA_DIR），
// 那样各自的 instance.lock 互不干扰，可以同时运行。
//
// ⚠️ 2026-09-22：加了**心跳**，因为"进程还在"并不等于"实例还在跑"。
//   踩过的坑：一夜里重启几次后，号B 连续 5 次启动失败（data-2/logs 里刷着
//   「[启动失败] 2 已在运行（pid=…）」），但那个 pid 是上一次被 taskkill 掉的残留
//   （或 pid 被复用），锁却早没人管了 —— 表现就是"双击了 .bat，只有号A起来了"。
//   现在锁里记 `beatAt`，运行中的实例每 45 秒续一次；冲突时只有
//   「pid 活着 **且** 心跳不超过 90 秒」才算真占用，否则接管并在日志里说明。
//   （刻意不用"探测控制台端口"那招：控制台端口是启动时才定的，锁写在前头，
//     猜错了就会把真在跑的实例判成残留 —— 反而更危险。）
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PROFILE_ID } from './config.js';

const LOCK_FILE = path.join(DATA_DIR, 'instance.lock');
const BEAT_MS = 45_000;        // 心跳间隔
const STALE_MS = 90_000;       // 超过这个没心跳 = 残留锁（是心跳间隔的 2 倍，容忍一次丢拍）

/**
 * 读锁。兼容两种格式：
 *   · 新：`{"pid":123,"port":3220,"profile":"","at":169…,"beatAt":169…}`
 *   · 旧：纯 pid 字符串 `123`
 */
function readLock() {
  try {
    const raw = String(fs.readFileSync(LOCK_FILE, 'utf8')).trim();
    if (!raw) return { pid: 0, port: 0, profile: '', at: 0, beatAt: 0, legacy: false };
    if (raw.startsWith('{')) {
      const j = JSON.parse(raw);
      return {
        pid: Number(j?.pid) || 0,
        port: Number(j?.port) || 0,
        profile: String(j?.profile ?? ''),
        at: Number(j?.at) || 0,
        beatAt: Number(j?.beatAt) || 0,
        legacy: false
      };
    }
    return { pid: Number(raw) || 0, port: 0, profile: '', at: 0, beatAt: 0, legacy: true };
  } catch {
    return { pid: 0, port: 0, profile: '', at: 0, beatAt: 0, legacy: false };
  }
}

/** 进程是否还活着（signal 0 只做存在性探测；EPERM 表示存在但不属于我们）。 */
function isAlive(pid) {
  if (!pid || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function writeLock(port = 0) {
  const now = Date.now();
  fs.writeFileSync(LOCK_FILE, JSON.stringify({
    pid: process.pid,
    port: Number(port) || 0,
    profile: PROFILE_ID || '',
    at: now,
    beatAt: now
  }), 'utf8');
}

/**
 * 占住当前数据目录。返回 { ok:true } 表示可以继续启动；
 * { ok:false, pid } 表示已有同数据目录的实例**确实在跑**，调用方应当退出。
 */
export async function acquireInstanceLock() {
  const info = { lockFile: LOCK_FILE, profile: PROFILE_ID || '默认', dir: DATA_DIR };
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const lock = readLock();
    if (isAlive(lock.pid)) {
      // 老格式锁没有任何时间信息 → 保守挡住（宁可让人手动删锁，也不冒险双开）；
      // 新格式看心跳：超时没续命就是残留锁，接管。
      const beat = lock.beatAt || lock.at || 0;
      const fresh = lock.legacy || (beat > 0 && Date.now() - beat < STALE_MS);
      if (fresh) return { ...info, ok: false, pid: lock.pid };
      info.tookOver = {
        pid: lock.pid,
        reason: `进程还在但 ${Math.round((Date.now() - beat) / 1000)}s 没心跳`
      };
    }
    writeLock(0);
    return { ...info, ok: true, pid: process.pid };
  } catch (error) {
    // 锁只是保险丝：数据目录写不进去时不要拦住启动
    return { ...info, ok: true, degraded: true, error: error?.message ?? String(error) };
  }
}

/**
 * 续心跳（运行中的实例定时调用；顺便把真实控制台端口写进锁里，方便排查）。
 * 只有锁还是自己的才写，免得把别人的锁覆盖掉。
 */
export function touchInstanceLock(port = 0) {
  try {
    const lock = readLock();
    if (lock.pid !== process.pid) return false;
    writeLock(Number(port) || lock.port || 0);
    return true;
  } catch {
    return false;
  }
}

/** 心跳定时器（unref，不挡住退出）。 */
export function startInstanceHeartbeat(getPort = () => 0) {
  const t = setInterval(() => { touchInstanceLock(typeof getPort === 'function' ? getPort() : 0); }, BEAT_MS);
  t.unref?.();
  return t;
}

/** 退出时释放（只删自己写的那份，避免误删别的实例的标记）。 */
export function releaseInstanceLock() {
  try {
    if (readLock().pid === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* ignore */ }
}

/** 给日志/界面用的一句话说明。 */
export function describeInstance() {
  return PROFILE_ID ? `实例 ${PROFILE_ID}` : '主实例';
}
