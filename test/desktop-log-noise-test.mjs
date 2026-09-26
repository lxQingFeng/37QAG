import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

test('未启用的系统标题栏按钮不再报错，正常退出不记成故障', () => {
  const source = fs.readFileSync(new URL('../electron/main.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /console\.error\('\[titlebar\] setTitleBarOverlay/);
  assert.doesNotMatch(source, /crashLog\(`主动退出/);
  assert.match(source, /console\.log\(`\[quit\] 主动退出/);
  assert.match(source, /console\.log\(`\[quit\] 进程退出/);
});

test('界面声明了安全策略，消除无策略警告', () => {
  const html = fs.readFileSync(new URL('../ui/index.html', import.meta.url), 'utf8');
  assert.match(html, /http-equiv="Content-Security-Policy"/);
  assert.match(html, /default-src 'self'/);
  assert.match(html, /connect-src 'self' ws: wss: http: https:/);
});
