// 语音模块·音频处理层：QQ 语音的获取、解码（silk/amr→wav）与编码（wav→silk）。
//
// QQ 语音格式事实（OneBot v11 生态）：
//   · 收到的 record 段 data.file 可能是：http(s) URL、file:// 路径、base64://、裸 base64
//   · QQ 原始编码是 silk v3（变长头）或 amr；多数 OneBot 实现（SnowLuma/NapCat）提供
//     get_record API 做 silk→wav/mp3 转码（各自内置 ffmpeg/转码器）
//   · 发语音时，多数实现接受 wav/mp3 的 base64/路径并自行转 silk（NapCat/Lagrange 都做）
//
// 因此本模块的三级策略：
//   ① 优先 get_record（协议端转码，零依赖最稳——现有 speech-to-text 插件同路线）
//   ② get_record 不可用 → 尝试可选依赖 silk-wasm 解码（用户 npm i silk-wasm 启用）
//   ③ 都没有 → 抛错（调用方降级到 [语音] 占位，行为与未启用一致）
//
// 发送侧：encode='auto' 时 silk-wasm 可用则 wav→silk（QQ 兼容度最高），
// 不可用则直发 wav base64（交给协议端转码，NapCat/SnowLuma 均支持）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 临时文件（用完即删）。 */
export function tmpFile(ext) {
  return path.join(os.tmpdir(), `qag-voice-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
}

/** silk-wasm 是否可用（可选依赖，装了才启用本地编解码）。 */
let _silkWasm = null;
let _silkProbed = false;
async function silkWasm() {
  if (_silkProbed) return _silkWasm;
  _silkProbed = true;
  try { _silkWasm = await import('silk-wasm'); } catch { _silkWasm = null; }
  return _silkWasm;
}

/** 是否具备本地 silk 编解码能力（status 探测用）。 */
export async function silkAvailable() { return !!(await silkWasm()); }

/**
 * 从 record 段拿音频字节。按 file 字段形态分派：
 * http(s) → fetch；file:// → 读盘；base64://|裸 base64 → 解码。
 * 返回 { bytes: Buffer, format: 'silk'|'amr'|'unknown' } 或 null（拿不到）。
 */
export async function fetchRecordBytes(record = {}) {
  const file = String(record.file || record.url || '').trim();
  if (!file) return null;
  try {
    if (/^https?:\/\//i.test(file)) {
      const res = await fetch(file, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) return null;
      return { bytes: Buffer.from(await res.arrayBuffer()), format: sniffFormat(file) };
    }
    if (file.startsWith('base64://')) {
      return { bytes: Buffer.from(file.slice('base64://'.length), 'base64'), format: 'silk' };
    }
    if (/^[A-Za-z0-9+/=]{64,}$/.test(file)) {
      return { bytes: Buffer.from(file, 'base64'), format: 'silk' };
    }
    const local = file.startsWith('file://') ? file.slice('file://'.length).replace(/\\/g, '/') : file;
    if (fs.existsSync(local)) return { bytes: fs.readFileSync(local), format: sniffFormat(local) };
  } catch { /* 网络失败等，返回 null 走下一级 */ }
  return null;
}

function sniffFormat(nameOrHeader) {
  const s = String(nameOrHeader);
  if (/\.(amr|silk)$/i.test(s)) return s.toLowerCase().split('.').pop();
  // silk v3 魔数：#!SILK 或 \x02#!SILK（QQ 变体）
  if (/SILK/i.test(s.slice(0, 10))) return 'silk';
  return 'unknown';
}

/**
 * 取 WAV 字节（用于 STT）。三级策略见文件头。
 * @param {object} record OneBot record 段 data
 * @param {object} onebot OneBotClient（调用 get_record）
 * @returns {Promise<Buffer|null>}
 */
export async function fetchRecordAsWav(record = {}, onebot = null) {
  // ① get_record（协议端转码；SnowLuma/NapCat 均支持 out_format）
  if (onebot?.call) {
    for (const fmt of ['wav', 'mp3']) {
      try {
        const r = await onebot.call('get_record', { file: record.file || record.url || '', out_format: fmt });
        const file = String(r?.file || r?.data?.file || '').trim();
        if (file) {
          const local = file.startsWith('file://') ? file.slice('file://'.length).replace(/\\/g, '/') : file;
          if (fs.existsSync(local)) return fs.readFileSync(local);
          if (file.startsWith('base64://')) return Buffer.from(file.slice('base64://'.length), 'base64');
          if (/^https?:\/\//.test(file)) {
            const res = await fetch(file, { signal: AbortSignal.timeout(15000) });
            if (res.ok) return Buffer.from(await res.arrayBuffer());
          }
        }
      } catch { /* 试下一个格式 */ }
    }
  }
  // ② silk-wasm 本地解码
  const got = await fetchRecordBytes(record);
  if (got?.bytes?.length) {
    const silk = await silkWasm();
    if (silk?.decode) {
      try {
        const sampleRate = 24000;   // QQ 语音采样率（silk 编码常用 24k）
        const pcm = silk.decode(got.bytes, sampleRate);
        return pcmToWav(Buffer.from(pcm), sampleRate, 1);
      } catch { /* 解码失败（amr 或头损坏）→ null */ }
    }
  }
  return null;
}

/** PCM → WAV（加 44 字节头）。STT 上传用。 */
export function pcmToWav(pcm, sampleRate = 24000, channels = 1, bitsPerSample = 16) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                      // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bitsPerSample / 8, 28);
  header.writeUInt16LE(channels * bitsPerSample / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * 合成结果 → 可发送的 record 文件字段值。
 * encode='auto'：silk-wasm 可用 → wav→silk（QQ 兼容最好）；否则 wav base64 直发
 * （NapCat/SnowLuma 收到 wav 会自行转码；若端不支持会发送失败，调用方降级文字）。
 * @returns {Promise<{file: string, note: string}>}  file 为 base64:// 形态
 */
export async function toSendableRecord(wavBuffer, encode = 'auto') {
  if (encode === 'raw') return { file: `base64://${wavBuffer.toString('base64')}`, note: 'wav直发' };
  const silk = encode === 'silk' ? await silkWasm() : (await silkWasm() || null);
  if (silk?.encode) {
    try {
      const sampleRate = wavSampleRate(wavBuffer) || 24000;
      const pcm = wavBuffer.subarray(44);
      const encoded = silk.encode(pcm, sampleRate);
      const out = Buffer.from(encoded);
      return { file: `base64://${out.toString('base64')}`, note: 'silk' };
    } catch { /* 编码失败走直发 */ }
  }
  return { file: `base64://${wavBuffer.toString('base64')}`, note: 'wav直发' };
}

/** 读 WAV 头采样率（解析失败返回 0）。 */
export function wavSampleRate(wav) {
  try {
    if (String(wav.subarray(0, 4)) !== 'RIFF') return 0;
    return wav.readUInt32LE(24);
  } catch { return 0; }
}
