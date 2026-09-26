// 语音模块·TTS 引擎：文本 → 语音。channel 化（云端 edge-tts / 本地 Kokoro）+ 降级链。
//
// 云端默认（调研报告推荐档）：edge-tts
//   · 微软 Edge 朗读接口的社区封装（npm `msedge-tts`，可选依赖——运行时探测，装了即用）
//   · 免费、无 key、无额度上限；中文 13+ 音色（zh-CN-XiaoxiaoNeural 等）
//   · ⚠️ 非官方接口：历史有间歇 403（调研报告已明示）。降级链：edge 失败 2 次 →
//     本地 Kokoro（配了的话）→ 返回 null（调用方降级为纯文字回复，绝不断聊天）
// 本地档：Kokoro-82M v1.1-zh（ONNX，经 sherpa-onnx CLI/绑定推理；模型自备）
//
// 语音服务遵循项目「本地/云端二选一」设计（voice.tts.channel，与 api.channel 同理念）。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 读 voice.tts 配置（带默认值归一）。 */
export function ttsCfg(getConfig) {
  const v = getConfig().voice?.tts || {};
  const cloud = v.cloud || {};
  const local = v.local || {};
  return {
    enabled: v.enabled === true,
    mode: ['manual', 'auto'].includes(v.mode) ? v.mode : 'manual',
    channel: ['cloud', 'local', 'auto'].includes(v.channel) ? v.channel : 'cloud',
    cloud: {
      voice: String(cloud.voice || 'zh-CN-XiaoxiaoNeural'),
      rate: Number(cloud.rate) || 0,
      volume: Number(cloud.volume) || 0,
      pitch: Number(cloud.pitch) || 0,
      timeoutMs: Math.max(5000, Number(cloud.timeoutMs) || 20000)
    },
    local: {
      engine: String(local.engine || 'kokoro'),
      modelPath: String(local.modelPath || ''),
      cliPath: String(local.cliPath || ''),
      voice: String(local.voice || 'zf_xiaoxiao')
    },
    encode: ['auto', 'silk', 'raw'].includes(v.encode) ? v.encode : 'auto',
    autoCooldownMs: Math.max(5000, Number(v.autoCooldownMs) || 30000),
    maxLength: Math.max(20, Number(v.maxLength) || 200),
    fallback: v.fallback === 'none' ? 'none' : 'cloud-to-local'
  };
}

/** msedge-tts 可用性（可选依赖探测，缓存结果）。 */
let _edgeTts = null;
let _edgeProbed = false;
async function edgeTtsModule() {
  if (_edgeProbed) return _edgeTts;
  _edgeProbed = true;
  try { _edgeTts = await import('msedge-tts'); } catch { _edgeTts = null; }
  return _edgeTts;
}

export async function edgeTtsAvailable() { return !!(await edgeTtsModule()); }

/** 本地 TTS 可用性。 */
export function ttsLocalReady(cfg) { return !!cfg.local.modelPath; }

/**
 * 云端 TTS：edge-tts → wav Buffer。
 * rate/volume/pitch 用 msedge-tts 的百分比字符串约定（如 "+10%"）。
 */
export async function ttsCloud(text, cfg, { edgeModule = null } = {}) {
  const mod = edgeModule || await edgeTtsModule();
  if (!mod?.MsEdgeTTS) throw new Error('msedge-tts 未安装（npm i msedge-tts 启用云端 TTS）');
  const tts = new mod.MsEdgeTTS();
  try {
    await tts.setVoice(cfg.cloud.voice);
  } catch (error) {
    const err = new Error(`edge-tts 语音连接失败：${error?.message ?? error}`);
    err.retryable = true;
    throw err;
  }
  const pct = (v) => (v > 0 ? `+${v}%` : (v < 0 ? `${v}%` : '+0%'));
  const chunks = [];
  const { audioStream } = await tts.toStream(text, {
    rate: pct(cfg.cloud.rate),
    volume: pct(cfg.cloud.volume),
    pitch: pct(cfg.cloud.pitch)
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('edge-tts 超时')), cfg.cloud.timeoutMs);
    audioStream.on('data', (c) => chunks.push(c));
    audioStream.on('end', () => { clearTimeout(timer); resolve(); });
    audioStream.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  if (!chunks.length) throw new Error('edge-tts 返回空音频');
  return Buffer.concat(chunks);   // mp3 数据流（edge-tts 输出 mp3）
}

/** 本地 TTS：Kokoro via sherpa-onnx CLI（模型自备）。 */
export async function ttsLocal(text, cfg) {
  const out = `/tmp/qag-tts-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`;
  const r = await execFileAsync(cfg.local.cliPath || 'sherpa-onnx-offline-tts',
    ['--model', cfg.local.modelPath, '--output-filename', out, '--text', text,
      '--sid', cfg.local.voice, '--num-threads', '2'],
    { timeout: 60000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
  const wav = await (await import('node:fs')).promises.readFile(out).catch(() => null);
  try { (await import('node:fs')).unlinkSync(out); } catch { /* ignore */ }
  if (wav?.length) return wav;
  throw new Error(`本地 TTS 失败：${clean(r.stderr || r.stdout)}`);
}

function clean(s) { return String(s || '').slice(0, 200); }

/**
 * 主入口：文本 → 合成音频 Buffer（channel 化 + 一次性降级）。失败返回 null（调用方降级文字）。
 * 超长文本先截断（cfg.maxLength，默认 200 字）。
 */
export async function synthesize(text, cfg, opts = {}) {
  const input = String(text || '').trim().slice(0, cfg.maxLength);
  if (!input) return null;
  const primary = cfg.channel === 'local' ? 'local' : (cfg.channel === 'auto' ? 'auto' : 'cloud');
  let mode = primary === 'auto'
    ? ((await edgeTtsAvailable()) ? 'cloud' : (ttsLocalReady(cfg) ? 'local' : 'cloud'))
    : primary;
  const tryChannel = async (m) => (m === 'cloud' ? ttsCloud(input, cfg, opts) : ttsLocal(input, cfg));
  let lastError = null;
  try {
    return await tryChannel(mode);
  } catch (error) { lastError = error; }
  const other = mode === 'cloud' ? 'local' : 'cloud';
  if (cfg.fallback !== 'none') {
    const ready = other === 'cloud' ? (await edgeTtsAvailable()) : ttsLocalReady(cfg);
    if (ready) {
      try { return await tryChannel(other); } catch (error) { lastError = error; }
    }
  }
  console.warn(`[voice/tts] 合成失败（全通道）：${lastError?.message ?? lastError} —— 降级为文字`);
  return null;
}
