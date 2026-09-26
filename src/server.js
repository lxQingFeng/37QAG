// headless 入口：node src/server.js（不带 Electron 窗口，浏览器访问控制台）
// 多实例：QQ_AGENT_PROFILE=2 node src/server.js —— 数据目录/端口自动错开，可与主实例同时跑。
import { createApp } from './app.js';
import { acquireInstanceLock, releaseInstanceLock, describeInstance } from './instance-lock.js';
import { logger, installConsoleBridge } from './logger.js';
installConsoleBridge('server');

process.on('unhandledRejection', (error) => logger.error('server', '未处理异常', error?.stack || error));
process.on('uncaughtException', (error) => logger.error('server', '未捕获异常', error?.stack || error));

const lock = await acquireInstanceLock();
if (!lock.ok) {
  logger.error('server', `[启动失败] ${lock.profile} 已在运行（pid=${lock.pid}，控制台 http://127.0.0.1:${lock.port} 有响应）。若确认没有其它实例，删除 ${lock.lockFile} 后重试。`);
  process.exit(1);
}
if (lock.tookOver) {
  logger.warn('server', `[instance] 接管了残留锁：pid=${lock.tookOver.pid} 还在但不响应控制台（${lock.tookOver.reason}）`);
}

const app = createApp({
  log: (...args) => logger.info('app', args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
});
logger.info('server', `${describeInstance()}，数据目录：${lock.dir}`);
logger.prune?.();
app.start().catch((error) => {
  logger.error('server', '启动失败', error?.stack || error);
  releaseInstanceLock();
  process.exit(1);
});

process.on('SIGINT', async () => {
  logger.info('server', '退出中…');
  await app.stop();
  releaseInstanceLock();
  process.exit(0);
});

process.on('exit', releaseInstanceLock);
