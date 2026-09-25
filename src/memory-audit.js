// 记忆变更审计：好感/印象写了什么，随时能翻。
// 追加写 data/memory/audit.jsonl，不进提示词，默认只给 UI。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const FILE = path.join(DATA_DIR, 'memory', 'audit.jsonl');
const MAX_TAIL = 200;

function ensure() {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
}

/** 追加一条审计。source: manual | favor_tool | consolidator | append | remove | import */
export function logMemoryChange(entry) {
  try {
    ensure();
    const row = {
      ts: Date.now(),
      at: new Date().toISOString(),
      ...entry
    };
    fs.appendFileSync(FILE, `${JSON.stringify(row)}\n`, 'utf8');
  } catch { /* 审计失败不影响主流程 */ }
}

/** 读最近 N 条。 */
export function readAuditLog({ userId = '', limit = 50 } = {}) {
  try {
    if (!fs.existsSync(FILE)) return [];
    const lines = fs.readFileSync(FILE, 'utf8').split('\n').filter(Boolean);
    const rows = [];
    for (let i = lines.length - 1; i >= 0 && rows.length < Math.min(200, limit * 3); i -= 1) {
      try {
        const r = JSON.parse(lines[i]);
        if (userId && String(r.userId || '') !== String(userId)) continue;
        rows.push(r);
      } catch { /* skip bad line */ }
    }
    return rows.slice(0, limit);
  } catch {
    return [];
  }
}
