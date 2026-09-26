import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sanitizeLogText,
  parseLogLine,
  filterLogEntries,
  logModules
} from '../src/logger.js';

test('日志会脱敏密钥、令牌与 Cookie', () => {
  const text = sanitizeLogText('apiKey=abc123 authorization: Bearer token-456 cookie="sid=secret"');
  assert.match(text, /apiKey=\[已脱敏\]/);
  assert.doesNotMatch(text, /abc123|token-456|secret/);
});

test('解析并按模块、最低级别和关键词过滤日志', () => {
  const entries = [
    parseLogLine('10:00:01 [INFO ] [onebot] connected'),
    parseLogLine('10:00:02 [WARN ] [ingest] forward empty'),
    parseLogLine('10:00:03 [ERROR] [http] failed')
  ];
  assert.deepEqual(logModules(entries), ['http', 'ingest', 'onebot']);
  assert.equal(filterLogEntries(entries, { module: 'ingest' }).length, 1);
  assert.equal(filterLogEntries(entries, { level: 'warn' }).length, 2);
  assert.equal(filterLogEntries(entries, { q: 'FORWARD' }).length, 1);
});
