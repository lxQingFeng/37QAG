#!/usr/bin/env node
/**
 * 只读探测：把一份「指令前置」的补丁表（patch.mjs）拿到某个 QQ Agent 核心上试一遍，
 * 看 18 个补丁块**能不能落下**。一个字都不写盘 —— 它调的是 patch.mjs 的 status()，
 * 那个函数只读文件、比对锚点、报状态。
 *
 * 为什么要有它：光看版本号判不出"这份前置在**这台**核心上能不能用"。
 * 1.3.1 在 0.4.0 上好好的，在 0.4.4 / 京玉版上锚点全废；1.4.3 在 0.4.4 上好、在京玉版上挂 2 块。
 * 唯一的硬证据就是拿表去核心里点一遍。
 *
 * 用法：
 *   node probe.mjs --root "<核心根目录>" [--table <patch.mjs 路径>] [--json] [--list] [--out <结果文件>]
 *
 *   核心根目录 = 就是含 src/ ui/ electron/ plugins/ skills/ 的那一层
 *                （打包版是 <安装目录>\resources\app，源码版就是项目根）
 *   --table 省略时用与本文件同目录的 patch.mjs
 *   --list    只把补丁表的锚点清单打出来，不做探测
 *   --out     把结果 JSON 写成 UTF-8 文件（**给 PowerShell 调用时用这个**）
 *
 * 出口约定：
 *   · 人类可读的走在 stdout；最后一行是 `@@PROBE@@` + 一行 JSON。
 *   · 但 PowerShell 读原生命令的 stdout 会按控制台代码页解码（中文机器上是 GBK），
 *     UTF-8 的中文会变乱码、连行都可能粘在一起 —— 所以 install.ps1 走 --out 拿结果，
 *     不去解析 stdout。stdout 保留是给人直接在终端里看。
 *   退出码：0 = 探测完成（不管结果好坏）；2 = 用法/环境错；3 = 补丁表加载失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const out = { root: '', table: path.join(HERE, 'patch.mjs'), json: false, list: false, out: '' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--root') out.root = argv[++i] || '';
    else if (a === '--table') out.table = argv[++i] || '';
    else if (a === '--out') out.out = argv[++i] || '';
    else if (a === '--json') out.json = true;
    else if (a === '--list') out.list = true;
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

function emit(payload) {
  const line = '@@PROBE@@' + JSON.stringify(payload);
  if (args.out) {
    try {
      fs.writeFileSync(args.out, JSON.stringify(payload, null, 2), { encoding: 'utf8' });
    } catch (e) {
      console.error('写结果文件失败：' + (e?.message || e));
    }
  }
  console.log(line);
}

if (args.help) {
  console.log('用法: node probe.mjs --root "<核心根目录>" [--table <patch.mjs>] [--out <结果文件>] [--json] [--list]');
  process.exit(0);
}

const GOOD = new Set(['clean', 'patched']);
const ZH = {
  clean: '可打', patched: '已打', stale: '待升级', conflict: '冲突',
  incompatible: '缺符号', missing: '文件没了', partial: '部分可用'
};

function loadTable(tablePath) {
  const abs = path.resolve(tablePath);
  if (!fs.existsSync(abs)) throw new Error(`补丁表不存在：${abs}`);
  return import(pathToFileURL(abs).href + '?t=' + Date.now());
}

if (args.list) {
  let mod;
  try { mod = await loadTable(args.table); } catch (e) { console.error(String(e.message || e)); process.exit(3); }
  console.log(`PATCH_VERSION=${mod.PATCH_VERSION}  块数=${mod.PATCHES.length}`);
  for (const e of mod.PATCHES) {
    console.log(`\n[${e.id}]  patches/${e.key}__${e.id}.js`);
    for (const p of e.places || []) {
      console.log(`   → ${p.file}  ${p.mode}${p.scope ? '  [scope]' : ''}`);
      console.log(`     anchor: ${JSON.stringify(String(p.anchor).slice(0, 100))}`);
      if (p.needs?.length) console.log(`     needs : ${p.needs.join('、')}`);
    }
  }
  process.exit(0);
}

if (!args.root) { console.error('缺少 --root'); process.exit(2); }
const root = path.resolve(args.root);
if (!fs.existsSync(root)) { console.error(`核心根目录不存在：${root}`); process.exit(2); }

let mod;
try { mod = await loadTable(args.table); } catch (e) {
  console.error(String(e.message || e));
  if (args.out) {
    try {
      fs.writeFileSync(args.out, JSON.stringify({ ok: false, root: args.root, error: '补丁表加载失败：' + String(e.message || e), table: args.table, total: 0, good: 0, bad: [] }, null, 2), { encoding: 'utf8' });
    } catch { /* 写不进去就算了 */ }
  }
  process.exit(3);
}

let res;
try {
  res = mod.status({ root });
} catch (e) {
  emit({ ok: false, root, error: String(e?.message || e), patchVersion: mod.PATCH_VERSION, total: 0, good: 0, bad: [], tally: {} });
  process.exit(0);
}

const files = Array.isArray(res?.files) ? res.files : [];
const tally = {};
for (const f of files) tally[f.state] = (tally[f.state] || 0) + 1;
const bad = files.filter((f) => !GOOD.has(f.state));

if (!args.json) {
  console.log(`补丁表 PATCH_VERSION=${mod.PATCH_VERSION}，共 ${files.length} 块`);
  console.log(`整体：${ZH[res.state] || res.state}`);
  const parts = Object.entries(tally).map(([k, v]) => `${ZH[k] || k}×${v}`);
  if (parts.length) console.log('明细：' + parts.join('  '));
  for (const f of bad) console.log(`  [${ZH[f.state] || f.state}] ${f.id} @ ${f.file}  ${f.detail || ''}`);
}

const payload = {
  ok: bad.length === 0,
  root,
  state: res.state,
  stateZh: ZH[res.state] || res.state,
  patchVersion: mod.PATCH_VERSION,
  total: files.length,
  good: files.length - bad.length,
  tally,
  bad: bad.map((f) => ({ id: f.id, file: f.file, state: f.state, detail: f.detail || '' }))
};
emit(payload);
