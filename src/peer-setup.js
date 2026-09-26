// 第二个账号的配置引导：没有 data-2/config.json 时，从 data/config.json 里
// 复制"可以共用"的那部分，生成一份属于号B 的配置。
//
// 谁在用：
//   · 「启动-双号.bat」在拉起来之前会先跑一次这个脚本（见 scripts/make-clean-pack.mjs）；
//   · 也可以手动跑：ELECTRON_RUN_AS_NODE=1 electron.exe src/peer-setup.js
//     （包里没有 node.exe，用 Electron 以纯 Node 身份执行）
//
// 为什么不让桌面壳自己生成：桌面壳只在 `data-2/config.json` **已存在**时才会拉起账号2
//   （它没办法判断用户到底想不想要第二个号）。所以"要不要两个号"这件事由启动脚本表达，
//   脚本负责把配置准备好，壳只负责拉起。
//
// 复制策略（和 scripts/setup-second-instance.mjs 一致）：
//   · 复制 → 模型/搜索/内存/表情/发送节奏这些"两个号可以一样"的设置；
//   · **不复制** → 端口、OneBot 地址、登录令牌、白名单（这些必须各是各的）；
//     端口与 OneBot 地址缺省时会按 profile 自动偏移（控制台 +1、本地模型 +10、OneBot +10）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAIN_CFG = path.join(ROOT, 'data', 'config.json');
const PEER_DIR = path.join(ROOT, 'data-2');
const PEER_CFG = path.join(PEER_DIR, 'config.json');

/** 可以照抄给第二个号的顶层键。 */
const COPY_KEYS = [
  'api', 'providers', 'providersSourceYaml', 'providersImported', 'dshProviderKeys',
  'webSearch', 'security', 'modelVision', 'emotion', 'memory', 'knowledge',
  'sticker', 'send', 'store', 'budget', 'hypeMode', 'persona', 'customPersonas',
  'crazyThursday', 'proactive', 'memberNotes'
];

function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function ensurePeerConfig({ silent = false } = {}) {
  const say = (m) => { if (!silent) console.log(`[peer-setup] ${m}`); };
  if (fs.existsSync(PEER_CFG)) {
    say(`第二个号的配置已存在，原样保留：${PEER_CFG}`);
    return { ok: true, created: false, file: PEER_CFG };
  }
  const main = readJson(MAIN_CFG);
  if (!main) {
    say(`找不到主配置 ${MAIN_CFG}（先正常启动一次号A 再开双号）`);
    return { ok: false, created: false, error: '主配置不存在' };
  }

  const peer = {};
  for (const k of COPY_KEYS) {
    if (main[k] !== undefined) peer[k] = structuredClone(main[k]);
  }
  // 这些**必须**是各是各的：不复制，交给 profile 缺省值 / 用户自己填
  peer.server = {
    token: '',
    autoStart: false,          // 第二份由主实例拉起，不需要开机自启
    autoStartPeer: false,      // 号B 不再拉起号C
    closeToTray: true
  };
  peer.snowluma = { autoLaunch: false };            // 桥只有一份，由号A 那边管
  peer.allow = { groups: [], private: [] };         // 号B 的白名单留空：不填就不理任何人
  peer.deny = { groups: [], private: [] };
  peer.localJev = { ...(peer.localJev && typeof peer.localJev === 'object' ? peer.localJev : {}), port: undefined };
  delete peer.localJev.port;                        // 交给 profile 偏移（18080 → 18090）

  try {
    fs.mkdirSync(PEER_DIR, { recursive: true });
    fs.writeFileSync(PEER_CFG, JSON.stringify(peer, null, 2), 'utf8');
    say(`已生成第二个号的配置：${PEER_CFG}`);
    say('它用的是空白名单（谁都不理）—— 想让它干活，去它的控制台把群/好友加进白名单。');
    return { ok: true, created: true, file: PEER_CFG };
  } catch (error) {
    say(`写入失败：${error?.message ?? error}`);
    return { ok: false, created: false, error: String(error?.message ?? error) };
  }
}

// 直接执行时（ELECTRON_RUN_AS_NODE=1 electron.exe src/peer-setup.js）跑一次就退出
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const r = ensurePeerConfig();
  process.exit(r.ok ? 0 : 1);
}
