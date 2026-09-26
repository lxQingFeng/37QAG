// 疯狂星期四模块入口（阶段二模块化）。
// impl.js 是从 src/crazy-thursday.js 平移的实现（逻辑零改动，仅 import 路径改写）；
// 这一层负责把「启动/停止」接进模块生命周期，并暴露状态给控制台。
import { startCrazyThursday, stopCrazyThursday } from './impl.js';

let running = false;

/** @param {import('../../src/module-registry.js').ModuleApi} api */
export async function setup(api) {
  const sender = api.context?.sender || null;
  if (!sender) {
    api.warn('拿不到 sender 句柄（app 未注入 context.sender）—— 模块空转，不会发消息');
  }
  startCrazyThursday({ sender, log: api.log });
  running = true;
  api.log('已启动（每周四 07:00/13:00/19:00，可 crazyThursday.times 配置）');
}

export async function dispose(api) {
  stopCrazyThursday();
  running = false;
}

export function status() {
  return { running };
}
