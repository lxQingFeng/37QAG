// 详尽日志系统：分级 + 落盘 + 内存环形缓冲（供 UI 查看）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const MAX_MEMORY = 500;
const KEEP_DAYS = 7;

export function sanitizeLogText(value) {
  let text = typeof value === 'string' ? value : String(value ?? '');
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [已脱敏]');
  text = text.replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization|cookie|password|secret)["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&}]+)/gi, '$1[已脱敏]');
  text = text.replace(/([?&](?:key|token|secret|password|authorization)=)[^&\s]+/gi, '$1[已脱敏]');
  return text;
}

export function parseLogLine(line, fallbackTs = Date.now()) {
  const raw = String(line ?? '').replace(/\r?\n$/, '');
  if (!raw.trim()) return null;
  const match = /^(\d{2}:\d{2}:\d{2})\s+\[([A-Z]+)\s*\]\s+\[([^\]]+)\]\s?([\s\S]*)$/.exec(raw);
  if (!match) {
    return { ts: fallbackTs, level: 'info', module: 'file', text: sanitizeLogText(raw) };
  }
  const [, time, level, module, text] = match;
  const d = new Date(fallbackTs);
  const [hour, minute, second] = time.split(':').map(Number);
  d.setHours(hour, minute, second, 0);
  return {
    ts: d.getTime(),
    level: String(level || 'info').toLowerCase(),
    module: String(module || 'app'),
    text: sanitizeLogText(text)
  };
}

export function filterLogEntries(entries, { module = '', level = '', q = '', limit = 500 } = {}) {
  const minLevel = LEVELS[String(level || '').toLowerCase()] || 0;
  const needle = String(q || '').trim().toLowerCase();
  const wantedModule = String(module || '').trim();
  return (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && (!wantedModule || entry.module === wantedModule))
    .filter((entry) => !minLevel || (LEVELS[entry.level] || LEVELS.info) >= minLevel)
    .filter((entry) => !needle || `${entry.module} ${entry.text}`.toLowerCase().includes(needle))
    .slice(-Math.max(1, Math.min(2000, Number(limit) || 500)));
}

export function logModules(entries) {
  return [...new Set((Array.isArray(entries) ? entries : []).map((entry) => String(entry.module || 'app')))]
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
}

function logsDir() {
  return path.join(DATA_DIR, 'logs');
}

function todayFile() {
  const d = new Date();
  const name = `37qag-${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}.log`;
  return path.join(logsDir(), name);
}

export function readLogTail(file = todayFile(), { maxBytes = 512 * 1024 } = {}) {
  try {
    const stat = fs.statSync(file);
    const size = Math.max(0, Number(maxBytes) || 512 * 1024);
    const start = Math.max(0, stat.size - size);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(Math.min(size, stat.size - start));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    let text = buffer.toString('utf8');
    if (start > 0) text = text.slice(text.indexOf('\n') + 1);
    const fallback = stat.mtimeMs;
    return text.split(/\r?\n/).map((line) => parseLogLine(line, fallback)).filter(Boolean);
  } catch {
    return [];
  }
}

class Logger {
  constructor() {
    this.level = LEVELS.info;
    this.memory = [];
    this.listeners = new Set();
    this.mirrorConsole = true;
    this.writing = false;
    this.consoleBridgeInstalled = false;
    this.originalConsole = {
      debug: console.debug.bind(console),
      log: console.log.bind(console),
      info: console.info.bind(console),
      warn: console.warn.bind(console),
      error: console.error.bind(console)
    };
  }

  setLevel(level) {
    if (LEVELS[level] != null) this.level = LEVELS[level];
  }

  getLevel() {
    return Object.keys(LEVELS).find((k) => LEVELS[k] === this.level) || 'info';
  }

  onLog(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  recent(limit = 200) {
    return this.memory.slice(-Math.max(1, Number(limit) || 200)).map((entry) => ({
      ...entry,
      module: sanitizeLogText(entry.module),
      text: sanitizeLogText(entry.text)
    }));
  }

  write(level, module, args) {
    if (this.writing) return;
    this.writing = true;
    try {
      this.#writeInner(level, module, args);
    } finally {
      this.writing = false;
    }
  }

  #writeInner(level, module, args) {
    const lv = LEVELS[level] ?? LEVELS.info;
    const text = sanitizeLogText(args.map((a) => {
      if (a instanceof Error) return `${a.message}\n${a.stack || ''}`;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch { return String(a); }
      }
      return String(a);
    }).join(' '));
    const entry = {
      ts: Date.now(),
      level,
      module: sanitizeLogText(String(module || 'app')),
      text
    };

    this.memory.push(entry);
    if (this.memory.length > MAX_MEMORY) this.memory.splice(0, this.memory.length - MAX_MEMORY);
    for (const fn of [...this.listeners]) {
      try { fn(entry); } catch { /* ignore */ }
    }

    if (this.mirrorConsole) {
      const line = `[${entry.module}] ${text}`;
      if (level === 'error') this.originalConsole.error(line);
      else if (level === 'warn') this.originalConsole.warn(line);
      else if (level === 'debug') this.originalConsole.debug(line);
      else this.originalConsole.log(line);
    }

    if (lv >= this.level) {
      try {
        fs.mkdirSync(logsDir(), { recursive: true });
        const time = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false });
        const line = `${time} [${level.toUpperCase().padEnd(5)}] [${entry.module}] ${text}\n`;
        const capped = line.length > 64 * 1024 ? `${line.slice(0, 64 * 1024)}…（过长已截断）\n` : line;
        fs.appendFileSync(todayFile(), capped, 'utf8');
      } catch { /* 写盘失败不影响运行 */ }
    }
  }

  debug(module, ...args) { this.write('debug', module, args); }
  info(module, ...args) { this.write('info', module, args); }
  warn(module, ...args) { this.write('warn', module, args); }
  error(module, ...args) { this.write('error', module, args); }

  prune() {
    try {
      const dir = logsDir();
      if (!fs.existsSync(dir)) return;
      const cutoff = Date.now() - KEEP_DAYS * 86400000;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith('.log')) continue;
        try {
          const fp = path.join(dir, f);
          const st = fs.statSync(fp);
          if (st.mtimeMs < cutoff) { fs.unlinkSync(fp); continue; }
          if (st.size > 256 * 1024 * 1024) {
            const keep = 16 * 1024 * 1024;
            const fd = fs.openSync(fp, 'r');
            const buf = Buffer.alloc(keep);
            fs.readSync(fd, buf, 0, keep, st.size - keep);
            fs.closeSync(fd);
            const head = `（日志异常膨胀，已截断：原 ${(st.size / 1024 / 1024 / 1024).toFixed(2)}GB，保留尾部 16MB）\n`;
            fs.writeFileSync(fp, head + buf.toString('utf8'), 'utf8');
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }
}

export const logger = new Logger();

/** 把 console.log/warn/error 等接入 logger；logger 仍写回原始 console，不会递归。 */
export function installConsoleBridge(defaultModule = 'console') {
  if (logger.consoleBridgeInstalled) return false;
  logger.consoleBridgeInstalled = true;
  const routes = {
    debug: 'debug',
    log: 'info',
    info: 'info',
    warn: 'warn',
    error: 'error'
  };
  for (const [name, level] of Object.entries(routes)) {
    console[name] = (...args) => {
      let module = defaultModule;
      let rest = args;
      const first = typeof args[0] === 'string' ? args[0] : '';
      const match = /^\[([^\]]+)\]\s*/.exec(first);
      if (match) {
        module = match[1];
        rest = [first.slice(match[0].length), ...args.slice(1)];
      }
      logger.write(level, module, rest);
    };
  }
  return true;
}
