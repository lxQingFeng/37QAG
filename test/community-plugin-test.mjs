import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizeManifest } from '../src/skills/manifest.js';
import { filterSkillSettings, skillIdFromLegacySettingsPath } from '../src/skills/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PLUGINS = [
  {
    id: 'command-gateway-1.5.0',
    dir: 'command-gateway',
    entry: 'index.js',
    version: '1.5.0',
    commands: 8,
    exposes: 7
  },
  {
    id: 'sticker-admin',
    dir: 'sticker-admin',
    entry: 'index.js',
    version: '1.2.0',
    intercept: 'sticker.host-tap',
    settingsUi: 'settings-ui.js'
  },
  {
    id: 'health-system',
    dir: 'health-system',
    entry: 'index.js',
    version: '14.0.1',
    hooks: ['before-context', 'before-llm-messages']
  },
  {
    id: 'sleep-mood',
    dir: 'sleep-mood',
    entry: 'index.js',
    version: '1.0.1',
    hooks: ['before-context', 'before-llm-messages', 'before-tool', 'after-tool']
  }
];

function pluginPath(plugin, rel = '') {
  return path.join(ROOT, 'plugins', plugin.dir, rel);
}

function readManifest(plugin) {
  return JSON.parse(fs.readFileSync(pluginPath(plugin, 'plugin.json'), 'utf8'));
}

test('社区插件清单能被 37QAG 统一规范化', () => {
  for (const plugin of PLUGINS) {
    const raw = readManifest(plugin);
    const { manifest, problems } = normalizeManifest(raw, { fallbackId: plugin.dir });

    assert.deepEqual(problems, [], `${plugin.id} 清单不应有规范化问题`);
    assert.equal(manifest.id, plugin.id);
    assert.equal(manifest.version, plugin.version);
    assert.equal(manifest.apiVersion, 1);
    assert.ok(Array.isArray(manifest.commands));
    assert.ok(Object.hasOwn(manifest, 'intercept'));
    assert.ok(Object.hasOwn(manifest, 'settingsUi'));

    if (plugin.commands !== undefined) {
      assert.equal(manifest.commands.length, plugin.commands);
    }
    if (plugin.exposes !== undefined) {
      assert.equal(manifest.exposes.length, plugin.exposes);
    }
    if (plugin.intercept) {
      assert.equal(manifest.intercept.capability, plugin.intercept);
    }
    if (plugin.settingsUi) {
      assert.equal(manifest.settingsUi.file, plugin.settingsUi);
      assert.ok(fs.existsSync(pluginPath(plugin, plugin.settingsUi)));
    }
  }
});

test('社区插件入口和宿主钩子兼容 37QAG', async () => {
  for (const plugin of PLUGINS) {
    const entry = pluginPath(plugin, plugin.entry);
    assert.ok(fs.existsSync(entry), `${plugin.id} 缺少入口文件`);
    const mod = await import(pathToFileURL(entry).href);
    assert.equal(typeof mod.setup, 'function', `${plugin.id} 缺少 setup(api)`);

    for (const hook of plugin.hooks || []) {
      assert.equal(typeof mod.hooks?.[hook], 'function', `${plugin.id} 缺少 ${hook} 钩子`);
    }
  }

  for (const rel of ['lib/config.js', 'lib/mood-chain.js', 'lib/self-state.js']) {
    assert.ok(fs.existsSync(pluginPath(PLUGINS[3], rel)), `sleep-mood 缺少 ${rel}`);
  }
});

test('指令前置 v6 兼容补丁完整落在 37QAG 核心上', async () => {
  const patch = await import(pathToFileURL(pluginPath(PLUGINS[0], 'patch.mjs')).href);
  assert.equal(patch.PATCH_VERSION, 6);

  const status = patch.status({ root: ROOT });
  assert.equal(status.state, 'patched');
  assert.equal(status.files.length, 18);
  assert.ok(status.files.every((file) => file.state === 'patched'));
});

test('社区插件旧版设置接口与 37QAG 正式接口兼容', () => {
  assert.equal(skillIdFromLegacySettingsPath('/api/skills/sticker-admin'), 'sticker-admin');
  assert.equal(skillIdFromLegacySettingsPath('/api/skills/sticker-admin', 'GET'), '');
  assert.equal(skillIdFromLegacySettingsPath('/api/skills/settings'), 'settings');

  const skill = {
    manifest: {
      configSchema: {
        annotatePrompt: { type: 'string' },
        apiKey: { type: 'string', secret: true },
        pending: { type: 'internal' }
      }
    }
  };
  assert.deepEqual(
    filterSkillSettings(skill, {
      annotatePrompt: '只写含义',
      apiKey: '******',
      pending: { __replace__: { kind: 'sync' } },
      unknown: 'drop-me'
    }),
    {
      annotatePrompt: '只写含义',
      pending: { __replace__: { kind: 'sync' } }
    }
  );
});