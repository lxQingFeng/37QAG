// 语音模块·STT 引擎：QQ 语音 → 文本。channel 化（云端硅基流动 / 本地 sherpa / 降级链）。
//
// 云端默认（调研报告推荐档）：硅基流动 FunAudioLLM/SenseVoiceSmall
//   · OpenAI 兼容 POST {baseUrl}/audio/transcriptions（multipart: file + model）
//   · 平台永久免费模型（需免费注册 apiKey）；中文强、标点恢复好
// 本地档：sherpa-onnx（CLI 或 sherpa-onnx-node 绑定，模型目录自备）；whisper-cli 兼容路线
// 降级链：主通道失败（可重试错误，如 429/5xx/超时）→ 换另一通道一次 → 仍失败 → 抛错
//（调用方 onebot.js 会降级为 [语音] 占位，聊天主流程绝不断）。
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 读 voice.stt 配置（带默认值归一）。 */
export function sttCfg(getConfig) {
  const v = getConfig().voice?.stt || {};
  const cloud = v.cloud || {};
  const local = v.local || {};
  return {
    enabled: v.enabled === true,
    channel: ['cloud', 'local', 'auto'].includes(v.channel) ? v.channel : 'cloud',
    cloud: {
      baseUrl: String(cloud.baseUrl || 'https://api.siliconflow.cn/v1').replace(/\/$/, ''),
      apiKey: String(cloud.apiKey || ''),
      model: String(cloud.model || 'FunAudioLLM/SenseVoiceSmall'),
      timeoutMs: Math.max(5000, Number(cloud.timeoutMs) || 30000)
    },
    local: {
      engine: ['sherpa-onnx', 'whisper-cli'].includes(local.engine) ? local.engine : 'sherpa-onnx',
      modelPath: String(local.modelPath || ''),
      cliPath: String(local.cliPath || ''),
      language: String(local.language || 'zh')
    },
    fallback: v.fallback === 'none' ? 'none' : 'cloud-to-local'
  };
}

/** 主通道（'cloud' | 'local'；auto：云端配了 key→cloud，否则 local）。 */
export function sttPrimaryChannel(cfg) {
  if (cfg.channel === 'local') return 'local';
  if (cfg.channel === 'auto') return cfg.cloud.apiKey ? 'cloud' : 'local';
  return 'cloud';
}

/** 云端可用性（status 探测用）。 */
export function sttCloudReady(cfg) { return !!(cfg.cloud.baseUrl && cfg.cloud.apiKey); }

/** 本地可用性。 */
export function sttLocalReady(cfg) { return !!cfg.local.modelPath; }

/**
 * 云端 STT：OpenAI 兼容 /audio/transcriptions。
 * 独立 fetch 注入点（测试可 mock）。
 */
export async function sttCloud(wavBuffer, cfg, { fetchImpl = null } = {}) {
  const f = fetchImpl || ((...a) => fetch(...a));
  const form = new FormData();
  form.append('file', new Blob([wavBuffer], { type: 'audio/wav' }), 'audio.wav');
  form.append('model', cfg.cloud.model);
  const res = await f(`${cfg.cloud.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${cfg.cloud.apiKey}` },
    body: form,
    signal: AbortSignal.timeout(cfg.cloud.timeoutMs)
  });
  if (!res.ok) {
    const err = new Error(`STT 云端 HTTP ${res.status}`);
    err.status = res.status;
    err.retryable = res.status === 429 || res.status >= 500;
    throw err;
  }
  const data = await res.json();
  const text = String(data?.text || '').trim();
  if (!text) throw new Error('STT 云端返回空文本');
  return text;
}

/** whisper-cli 兼容路线（复用 speech-to-text 插件的成熟参数集）。 */
export async function sttWhisperCli(wavPath, cfg) {
  const outBase = wavPath.replace(/\.wav$/i, '');
  const r = await execFileAsync(cfg.local.cliPath || 'whisper-cli',
    ['-m', cfg.local.modelPath, '-f', wavPath, '-l', cfg.local.language, '-nt', '-otxt', '-of', outBase],
    { timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  let text = '';
  const txtPath = `${outBase}.txt`;
  if (fs.existsSync(txtPath)) text = fs.readFileSync(txtPath, 'utf8').trim();
  if (!text) text = cleanCliText(r.stdout);
  return text;
}

/** sherpa-onnx CLI 路线（本地默认档）。 */
export async function sttSherpaCli(wavPath, cfg) {
  const r = await execFileAsync(cfg.local.cliPath || 'sherpa-onnx-offline-recognizer',
    ['--model', cfg.local.modelPath, '--wav', wavPath, '--tokens', tokensPathOf(cfg)],
    { timeout: 60000, maxBuffer: 2 * 1024 * 1024, windowsHide: true });
  return cleanCliText(r.stdout);
}

function tokensPathOf(cfg) {
  // sherpa 的 tokens.txt 通常在模型目录里；modelPath 可以直接指到文件或目录
  const p = cfg.local.modelPath;
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) {
    return path_join(p, 'tokens.txt');
  }
  return String(cfg.local.tokens || '');
}

function path_join(a, b) { return a.replace(/[\\/]$/, '') + '/' + b; }

function cleanCliText(stdout) {
  return String(stdout || '')
    .split('\n')
    .map((l) => l.replace(/^\[?\d{2}:\d{2}:\d{2}[\.\d\]]*\s*/, '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();
}

/**
 * 主入口：wav → 文本（channel 化 + 一次性降级）。
 * @param {Buffer} wavBuffer
 * @param {object} cfg sttCfg 结果
 * @param {object} opts { fetchImpl（测试 mock）、tmpFileMaker }
 */
export async function transcribeWav(wavBuffer, cfg, opts = {}) {
  const primary = sttPrimaryChannel(cfg);
  const tryChannel = async (mode) => {
    if (mode === 'cloud') return sttCloud(wavBuffer, cfg, opts);
    // local
    const tmp = (opts.tmpFileMaker || ((ext) => `/tmp/qag-stt-${Date.now()}${ext}`))('.wav');
    try {
      fs.writeFileSync(tmp, wavBuffer);
      if (cfg.local.engine === 'whisper-cli') return sttWhisperCli(tmp, cfg);
      return await sttSherpaCli(tmp, cfg);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  };
  let lastError = null;
  try {
    return await tryChannel(primary);
  } catch (error) {
    lastError = error;
  }
  // 一次性降级（fallback 允许 且 主通道不是被明确禁用的那种失败）
  const other = primary === 'cloud' ? 'local' : 'cloud';
  const allowFallback = cfg.fallback !== 'none' && !(lastError?.retryable === false && lastError?.status && lastError.status < 500 && lastError.status !== 429 && primary === 'cloud' && other === 'local' && !sttLocalReady(cfg));
  if (allowFallback) {
    // 云端→本地需要本地就绪；本地→云端需要云端就绪
    const ready = other === 'cloud' ? sttCloudReady(cfg) : sttLocalReady(cfg);
    if (ready) {
      try { return await tryChannel(other); } catch (error) { lastError = error; }
    }
  }
  throw lastError || new Error('STT 全通道失败');
}
