// 阶段四回归：语音模块（STT/TTS/audio）。
// 沙箱限制（如实说明）：无真实 QQ 语音、无硅基流动 key、未装 msedge-tts/silk-wasm/
// sherpa-onnx。因此云端调用与编解码用 mock/纯函数覆盖；真实联调列入「未覆盖事项」。
import { test } from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'qag-voice-'));
process.env.QAG_DATA_HOME = TMP;

const config = await import('../src/config.js');
const { DEFAULT_CONFIG, updateConfig, getConfig } = config;

const sttMod = await import('../modules/voice/stt.js');
const { sttCfg, sttPrimaryChannel, sttCloudReady, sttLocalReady, sttCloud, transcribeWav } = sttMod;
const ttsMod = await import('../modules/voice/tts.js');
const { ttsCfg, synthesize, edgeTtsAvailable, ttsLocalReady } = ttsMod;
const audioMod = await import('../modules/voice/audio.js');
const { pcmToWav, wavSampleRate, toSendableRecord, silkAvailable, fetchRecordBytes } = audioMod;

// ── 配置层 ─────────────────────────────────────────────────────────────
test('默认配置：STT/TTS 均关（语音是增强功能，不默认开启）', () => {
  assert.equal(DEFAULT_CONFIG.voice.stt.enabled, false);
  assert.equal(DEFAULT_CONFIG.voice.tts.enabled, false);
});

test('默认配置：云端 STT 指向硅基流动 SenseVoiceSmall，TTS 音色小晓', () => {
  assert.equal(DEFAULT_CONFIG.voice.stt.cloud.baseUrl, 'https://api.siliconflow.cn/v1');
  assert.equal(DEFAULT_CONFIG.voice.stt.cloud.model, 'FunAudioLLM/SenseVoiceSmall');
  assert.equal(DEFAULT_CONFIG.voice.tts.cloud.voice, 'zh-CN-XiaoxiaoNeural');
  assert.equal(DEFAULT_CONFIG.voice.tts.mode, 'manual');
});

test('sttCfg：未知 channel 归一到 cloud；timeout 下限保护', () => {
  updateConfig({ voice: { stt: { channel: 'weird', cloud: { timeoutMs: 1 } } } });
  const cfg = sttCfg(getConfig);
  assert.equal(cfg.channel, 'cloud');
  assert.ok(cfg.cloud.timeoutMs >= 5000);
});

// ── 设置项补齐回归（2026-09-27）：local.tokens 原先被 sttCfg 归一层丢弃，
//    tokensPathOf 永远拿到空串 → modelPath 指向单个模型文件时 sherpa-onnx 必失败。
test('sttCfg：local.tokens 透传（modelPath 指模型文件时 tokens.txt 单独指定）', () => {
  const cfg = sttCfg(() => ({ voice: { stt: { local: { modelPath: '/m/model.onnx', tokens: '/m/tokens.txt' } } } }));
  assert.equal(cfg.local.tokens, '/m/tokens.txt');
});

test('sttCfg：local.tokens 未配置 → 空串（默认行为不变）', () => {
  assert.equal(DEFAULT_CONFIG.voice.stt.local.tokens, '');
  const cfg = sttCfg(() => ({}));
  assert.equal(cfg.local.tokens, '');
});

test('sttPrimaryChannel：auto 语义（有 key→cloud，无 key→local）', () => {
  updateConfig({ voice: { stt: { channel: 'auto', cloud: { apiKey: 'sk-x' } } } });
  assert.equal(sttPrimaryChannel(sttCfg(getConfig)), 'cloud');
  updateConfig({ voice: { stt: { channel: 'auto', cloud: { apiKey: '' } } } });
  assert.equal(sttPrimaryChannel(sttCfg(getConfig)), 'local');
});

// ── STT 云端（mock fetch）───────────────────────────────────────────────
test('sttCloud：multipart 请求构造 + 成功解析（mock）', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    assert.ok(init.body instanceof FormData, 'body 应为 FormData');
    assert.equal(init.headers.authorization, 'Bearer sk-test');
    return { ok: true, status: 200, json: async () => ({ text: '今天天气不错' }) };
  };
  updateConfig({ voice: { stt: { cloud: { apiKey: 'sk-test' } } } });
  const cfg = sttCfg(getConfig);
  const text = await sttCloud(Buffer.from('fake-wav'), cfg, { fetchImpl });
  assert.equal(text, '今天天气不错');
  assert.ok(calls[0].url.includes('/audio/transcriptions'), '应打 OpenAI 兼容 transcriptions 端点');
});

test('sttCloud：500 标记 retryable、401 标记不可重试（mock）', async () => {
  const mk = (status) => async () => ({ ok: false, status, json: async () => ({}) });
  updateConfig({ voice: { stt: { cloud: { apiKey: 'sk-test' } } } });
  const cfg = sttCfg(getConfig);
  await assert.rejects(sttCloud(Buffer.alloc(4), cfg, { fetchImpl: mk(500) }), (e) => e.retryable === true);
  await assert.rejects(sttCloud(Buffer.alloc(4), cfg, { fetchImpl: mk(401) }), (e) => e.retryable !== true);
});

test('transcribeWav：全通道失败抛错（云端 401 且本地未配 → 不降级）', async () => {
  updateConfig({ voice: { stt: { channel: 'cloud', cloud: { apiKey: 'sk-test' }, fallback: 'cloud-to-local' } } });
  const cfg = sttCfg(getConfig);
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(transcribeWav(Buffer.alloc(4), cfg, { fetchImpl }), /401|失败/);
});

test('transcribeWav：云端失败且本地就绪 → 尝试本地（whisper-cli 路线错误路径）', async () => {
  // 本地 engine=whisper-cli、modelPath 配了（就绪）但 CLI 不存在 → 本地失败 → 抛错（含两层错误信息）
  updateConfig({
    voice: { stt: { channel: 'cloud', cloud: { apiKey: 'sk-test' }, local: { engine: 'whisper-cli', modelPath: '/tmp/xx.bin', cliPath: '/nonexistent/whisper' }, fallback: 'cloud-to-local' } }
  });
  const cfg = sttCfg(getConfig);
  const fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({}) });
  await assert.rejects(transcribeWav(Buffer.alloc(4), cfg, { fetchImpl }));
});

// ── TTS ────────────────────────────────────────────────────────────────
test('ttsCfg：mode/channel/encode 归一；maxLength 下限', () => {
  updateConfig({ voice: { tts: { mode: 'weird', channel: 'x', encode: 'y', maxLength: 1 } } });
  const cfg = ttsCfg(getConfig);
  assert.equal(cfg.mode, 'manual');
  assert.equal(cfg.channel, 'cloud');
  assert.equal(cfg.encode, 'auto');
  assert.ok(cfg.maxLength >= 20);
});

test('synthesize：沙箱无 msedge-tts 且本地未配 → 返回 null（降级文字，不抛错）', async () => {
  updateConfig({ voice: { tts: { enabled: true, channel: 'cloud' } } });
  const cfg = ttsCfg(getConfig);
  const out = await synthesize('你好呀', cfg);
  assert.equal(out, null, '合成失败应静默降级为 null');
  assert.equal(await edgeTtsAvailable(), false, '沙箱未装 msedge-tts');
  assert.equal(ttsLocalReady(cfg), false);
});

// ── audio 层（纯函数）──────────────────────────────────────────────────
test('pcmToWav/wavSampleRate：WAV 头往返一致', () => {
  const pcm = Buffer.alloc(1600, 0);   // 100ms @16k mono 16bit
  const wav = pcmToWav(pcm, 16000, 1, 16);
  assert.equal(String(wav.subarray(0, 4)), 'RIFF');
  assert.equal(String(wav.subarray(8, 12)), 'WAVE');
  assert.equal(wav.length, 44 + 1600);
  assert.equal(wavSampleRate(wav), 16000);
});

test('toSendableRecord：raw 模式返回 base64:// wav', async () => {
  const wav = pcmToWav(Buffer.alloc(100), 24000);
  const r = await toSendableRecord(wav, 'raw');
  assert.ok(r.file.startsWith('base64://'));
  assert.equal(r.note, 'wav直发');
  const back = Buffer.from(r.file.slice('base64://'.length), 'base64');
  assert.equal(String(back.subarray(0, 4)), 'RIFF');
});

test('silkAvailable：沙箱未装 silk-wasm → false（降级路径生效的证据）', async () => {
  assert.equal(await silkAvailable(), false);
});

test('fetchRecordBytes：base64:// 形态解析', async () => {
  const buf = Buffer.from('hello-silk-data');
  const r = await fetchRecordBytes({ file: `base64://${buf.toString('base64')}` });
  assert.equal(String(r.bytes), 'hello-silk-data');
});

test('fetchRecordBytes：空 file 返回 null', async () => {
  assert.equal(await fetchRecordBytes({}), null);
});

// ── 模块装载（module-loader 集成）───────────────────────────────────────
test('voice 模块可被 module-loader 装载（enabled=false → setup 成功，不注册能力）', async () => {
  // 测试隔离：前面用例会把 voice.tts.enabled 改成 true（污染共享配置单例），
  // 这里先恢复默认关 —— 本用例只验证「关态装载 + 路由注册/回收」。
  updateConfig({ voice: { stt: { enabled: false }, tts: { enabled: false } } });
  const { loadModules, moduleStatus, disposeModules } = await import('../src/module-loader.js');
  await loadModules({ log: () => {}, context: {} });
  const ids = moduleStatus().map((m) => m.id).sort();
  assert.ok(ids.includes('voice'), `voice 应在模块列表：${ids}`);
  // 路由已注册（status/test 两条不依赖 enabled）
  const { matchRoute } = await import('../src/module-registry.js');
  assert.ok(matchRoute('GET', '/api/voice/status'));
  assert.ok(matchRoute('POST', '/api/voice/test'));
  await disposeModules({ log: () => {} });
  assert.equal(matchRoute('GET', '/api/voice/status'), null, '卸载后路由回收');
});
