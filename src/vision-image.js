// 识图输入归一化：把各种图片格式变成视觉接口更稳的 data URL（优先 png/jpeg）。
//
// 为什么需要：
//   1. 动图 GIF：不少视觉接口只吃首帧/静态图，或直接 400；整轮被拒后 llm.js 会剥掉
//      全部图片 → 用户看到的就是"看不了 gif"。这里在送模型前抽出若干帧转成 PNG。
//   2. webp/avif/bmp：本地 LM Studio 等接口收到会 400 打挂整轮（见 llm.visionUnsupported）。
//      有 ffmpeg 就转；没有则按原策略跳过/直发。
//   3. png/jpg：原样透传，不做无谓转码。
//
// GIF 解码是纯 JS（不依赖 ffmpeg / sharp），多帧按时间均匀抽最多 maxFrames 张，
// 并在调用方拼一段"这是动图抽出的 N 帧"说明，让模型知道在看连续画面。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { visionUnsupported } from './llm.js';

// ── 魔数识别 ─────────────────────────────────────────────────────────────

export function detectImageMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  const gifHead = buf.toString('ascii', 0, 6);
  if (gifHead === 'GIF87a' || gifHead === 'GIF89a') return 'image/gif';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
  // AVIF/HEIC：ISOBMFF，bytes 4..8 = 'ftyp'
  if (buf.length >= 12 && buf.toString('ascii', 4, 8) === 'ftyp') {
    const brand = buf.toString('ascii', 8, 12);
    if (brand === 'avif' || brand === 'avis' || brand === 'mif1' || brand === 'msf1') return 'image/avif';
    return 'image/heic';
  }
  return null;
}

function dataUrl(mime, buf) {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

function isPassThrough(mime) {
  return /^image\/(png|jpe?g)$/i.test(String(mime || ''));
}

// ── PNG 编码（RGBA → PNG，Node zlib）────────────────────────────────────

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** RGBA（每像素 4 字节）→ PNG buffer。 */
export function encodePng(rgba, width, height) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const src = y * stride;
    const dst = y * (stride + 1);
    raw[dst] = 0; // filter: None
    rgba.copy(raw, dst + 1, src, src + stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type RGBA
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

// ── GIF 解码（多帧，返回均匀抽出的 RGBA 帧）────────────────────────────

function lzwDecode(minCodeSize, data, out, outOffset, pixelCount) {
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let nextCode = eoiCode + 1;
  /** @type {(number[]|undefined)[]} */
  let dict = [];
  const resetDict = () => {
    dict = new Array(4096);
    for (let i = 0; i < clearCode; i++) dict[i] = [i];
    codeSize = minCodeSize + 1;
    nextCode = eoiCode + 1;
  };
  resetDict();

  let bitPos = 0;
  const bitLen = data.length * 8;
  const readCode = () => {
    if (bitPos + codeSize > bitLen) return eoiCode;
    let code = 0;
    for (let i = 0; i < codeSize; i++) {
      const byte = data[(bitPos + i) >> 3];
      const bit = (byte >> ((bitPos + i) & 7)) & 1;
      code |= bit << i;
    }
    bitPos += codeSize;
    return code;
  };

  let prev = null;
  let written = 0;
  while (written < pixelCount) {
    const code = readCode();
    if (code === clearCode) { resetDict(); prev = null; continue; }
    if (code === eoiCode) break;
    let entry;
    if (code < nextCode && dict[code]) entry = dict[code];
    else if (prev) entry = prev.concat(prev[0]); // KwKwK
    else break;
    for (let i = 0; i < entry.length && written < pixelCount; i++) {
      out[outOffset + written++] = entry[i];
    }
    if (prev && nextCode < 4096) {
      dict[nextCode] = prev.concat(entry[0]);
      nextCode += 1;
      if (nextCode === (1 << codeSize) && codeSize < 12) codeSize += 1;
    }
    prev = entry;
  }
  return written;
}

/**
 * 解出 GIF 全部帧的合成 RGBA（每帧 width*height*4）。
 * 支持：全局/局部色表、透明色、interlace、disposal 0/1/2/3。
 * 失败返回 null（不抛异常）。
 */
function decodeGifRaw(buf) {
  try {
    if (!buf || buf.length < 13) return null;
    const head = buf.toString('ascii', 0, 6);
    if (head !== 'GIF87a' && head !== 'GIF89a') return null;

    let p = 6;
    const width = buf.readUInt16LE(p);
    const height = buf.readUInt16LE(p + 2);
    const packed = buf[p + 4];
    const hasGct = (packed & 0x80) !== 0;
    const gctSize = 2 << (packed & 0x07);
    p += 7;
    let gct = null;
    if (hasGct) {
      gct = buf.subarray(p, p + gctSize * 3);
      p += gctSize * 3;
    }

    const canvas = Buffer.alloc(width * height * 4);
    const prevCanvas = Buffer.alloc(width * height * 4);
    const frames = [];
    let gce = { delay: 0, transparent: -1, disposal: 0 };

    const colorAt = (table, index, out, o) => {
      if (!table || index * 3 + 2 >= table.length) {
        out[o] = out[o + 1] = out[o + 2] = 0;
        out[o + 3] = 255;
        return;
      }
      out[o] = table[index * 3];
      out[o + 1] = table[index * 3 + 1];
      out[o + 2] = table[index * 3 + 2];
      out[o + 3] = 255;
    };

    while (p < buf.length) {
      const block = buf[p];
      if (block === 0x3b) break; // trailer
      if (block === 0x21) { // extension
        const label = buf[p + 1];
        p += 2;
        if (label === 0xf9) { // Graphic Control Extension
          const size = buf[p];
          const flags = buf[p + 1];
          gce = {
            delay: buf.readUInt16LE(p + 2),
            transparent: (flags & 0x01) ? buf[p + 4] : -1,
            disposal: (flags >> 2) & 0x07
          };
          p += 1 + size;
          // sub-blocks
          while (p < buf.length && buf[p] !== 0) p += 1 + buf[p];
          p += 1;
        } else if (label === 0xff) {
          const size = buf[p];
          p += 1 + size;
          while (p < buf.length && buf[p] !== 0) p += 1 + buf[p];
          p += 1;
        } else {
          while (p < buf.length && buf[p] !== 0) p += 1 + buf[p];
          p += 1;
        }
        continue;
      }
      if (block === 0x2c) { // image descriptor
        const left = buf.readUInt16LE(p + 1);
        const top = buf.readUInt16LE(p + 3);
        const fw = buf.readUInt16LE(p + 5);
        const fh = buf.readUInt16LE(p + 7);
        const ipacked = buf[p + 9];
        p += 10;
        let lct = null;
        if (ipacked & 0x80) {
          const lctSize = 2 << (ipacked & 0x07);
          lct = buf.subarray(p, p + lctSize * 3);
          p += lctSize * 3;
        }
        const interlace = (ipacked & 0x40) !== 0;
        const minCode = buf[p];
        p += 1;
        // collect image data sub-blocks
        const chunks = [];
        let dataLen = 0;
        while (p < buf.length && buf[p] !== 0) {
          const n = buf[p];
          chunks.push(buf.subarray(p + 1, p + 1 + n));
          dataLen += n;
          p += 1 + n;
        }
        p += 1; // block terminator
        const imageData = Buffer.concat(chunks, dataLen);
        const indices = Buffer.alloc(fw * fh);
        lzwDecode(minCode, imageData, indices, 0, fw * fh);

        // disposal：disposal=3 需要先备份当前画布
        if (gce.disposal === 3) prevCanvas.set(canvas);

        const table = lct || gct;
        const rowsOrder = interlace
          ? (() => {
              const order = [];
              for (let y = 0; y < fh; y += 8) order.push(y);
              for (let y = 4; y < fh; y += 8) order.push(y);
              for (let y = 2; y < fh; y += 4) order.push(y);
              for (let y = 1; y < fh; y += 2) order.push(y);
              return order;
            })()
          : Array.from({ length: fh }, (_, i) => i);

        for (let row = 0; row < fh; row++) {
          const sy = rowsOrder[row];
          const dy = top + sy;
          if (dy < 0 || dy >= height) continue;
          for (let x = 0; x < fw; x++) {
            const dx = left + x;
            if (dx < 0 || dx >= width) continue;
            const idx = indices[row * fw + x];
            const o = (dy * width + dx) * 4;
            if (gce.transparent >= 0 && idx === gce.transparent) continue;
            colorAt(table, idx, canvas, o);
          }
        }

        frames.push({ rgba: Buffer.from(canvas), delay: Math.max(20, gce.delay * 10) });

        if (gce.disposal === 2) {
          for (let y = top; y < top + fh && y < height; y++) {
            for (let x = left; x < left + fw && x < width; x++) {
              const o = (y * width + x) * 4;
              canvas[o] = canvas[o + 1] = canvas[o + 2] = canvas[o + 3] = 0;
            }
          }
        } else if (gce.disposal === 3) {
          canvas.set(prevCanvas);
        }
        gce = { delay: 0, transparent: -1, disposal: 0 };
        continue;
      }
      // 未知块：跳过一字节，避免死循环
      p += 1;
    }

    if (!frames.length || !width || !height) return null;
    return { frames: frames.map((f) => ({ ...f, width, height })), width, height };
  } catch {
    return null;
  }
}

/**
 * 解出 GIF 的**全部**帧（带每帧显示时长），不做任何挑选。给测试和选帧逻辑用。
 * @returns {{rgba:Buffer, delay:number, width:number, height:number}[]|null}
 */
export function decodeAllGifFrames(buffer, opts = {}) {
  const r = decodeGifRaw(buffer);
  return r ? r.frames : null;
}

/** 解码 + 选帧（对外主入口）：返回抽好的帧，每项带 delayMs / sceneCount。 */
export function decodeGifFrames(buffer, { maxFrames = 6 } = {}) {
  const r = decodeGifRaw(buffer);
  if (!r) return [];
  const want = Math.max(1, Math.min(r.frames.length, Number(maxFrames) || 1));
  return selectGifFrames(r.frames, r.width, r.height, want);
}

// ── 抽帧策略：按"显示时长"加权 + 场景去重 ─────────────────────────────
// 老做法是按帧号均匀取 3 张：表情包动辄十几到几十帧、每帧时长差好几倍，
// 结果常见两种失败 —— 三张全是同一个画面（白抽），或者正好错过"抖机灵"的那一下。
// 这里改成：先把几乎不变化的相邻帧并成一个"场景"，再按每个场景**在屏幕上停了多久**来分配名额，
// 并且一定保留最后一个场景（表情包的落点/反转基本都在结尾）。

/**
 * 8x8 灰度指纹：每格取**不透明像素**的平均亮度；整格全透明记 -1。
 * ⚠️ 透明像素不能当 0 参与均值 —— 表情包大片是透明的，那样差异会被摊薄十倍
 *    （实测两个明显不同的画面只差 1.1），不同帧就被去重合掉了，等于把动图抽成一张。
 */
function frameSignature(rgba, width, height) {
  const sig = new Array(64).fill(-1);
  if (!rgba || !width || !height) return sig;
  const bw = Math.max(1, Math.floor(width / 8));
  const bh = Math.max(1, Math.floor(height / 8));
  for (let by = 0; by < 8; by++) {
    for (let bx = 0; bx < 8; bx++) {
      let sum = 0;
      let n = 0;
      const yMax = Math.min(height, (by + 1) * bh);
      const xMax = Math.min(width, (bx + 1) * bw);
      for (let y = by * bh; y < yMax; y++) {
        for (let x = bx * bw; x < xMax; x++) {
          const o = (y * width + x) * 4;
          if (rgba[o + 3] <= 8) continue;   // 全透明：不算进这一格
          sum += (rgba[o] * 299 + rgba[o + 1] * 587 + rgba[o + 2] * 114) / 1000;
          n += 1;
        }
      }
      if (n) sig[by * 8 + bx] = sum / n;
    }
  }
  return sig;
}

/**
 * 格子差异聚合：取**变化最大的 8 格**的平均值，而不是 64 格的平均值。
 * 表情包常常只动一小块（嘴、手、跳一下），按全图平均会被大片静止区域摊平 ——
 * 实测一处 11.5 的局部变化按均值只剩 1.08，就漏帧了。
 * 一帧有内容、一帧空 → 记满差异（内容出现/消失本身就是变化）。
 */
function sigDiff(a, b) {
  const cells = [];
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x < 0 && y < 0) continue;
    cells.push(x < 0 || y < 0 ? 255 : Math.abs(x - y));
  }
  if (!cells.length) return 0;
  cells.sort((p, q) => q - p);
  const top = cells.slice(0, Math.min(8, cells.length));
  return top.reduce((s, v) => s + v, 0) / top.length;
}

/**
 * 场景合并：连续几帧几乎一样 → 当成一个场景，时长累加。
 * @returns {{index:number, delay:number, sig:number[]}[]} index 是该场景里最有代表性的一帧（首帧）
 */
function toScenes(frames, { diffMin = 6 } = {}) {
  const scenes = [];
  let prevSig = null;
  for (let i = 0; i < frames.length; i++) {
    const sig = frameSignature(frames[i].rgba, frames[i].width || 0, frames[i].height || 0);
    if (prevSig && sigDiff(prevSig, sig) < diffMin) {
      scenes[scenes.length - 1].delay += frames[i].delay || 0;
      continue;
    }
    scenes.push({ index: i, delay: frames[i].delay || 0, sig });
    prevSig = sig;
  }
  return scenes;
}

/** 按时长累计均匀取 want 个点 → 落在哪个场景就取哪个场景；首末场景必留。 */
function pickScenes(scenes, want) {
  const n = scenes.length;
  if (n <= want) return scenes;
  if (want <= 1) return [scenes[0]];
  const total = scenes.reduce((a, s) => a + Math.max(s.delay, 1), 0);
  const acc = [];
  let run = 0;
  for (const s of scenes) { acc.push((run += Math.max(s.delay, 1))); }
  const chosen = new Set();
  for (let i = 0; i < want; i++) {
    const target = ((i + 0.5) * total) / want;
    let idx = acc.findIndex((v) => v >= target);
    if (idx < 0) idx = n - 1;
    chosen.add(idx);
  }
  chosen.add(0);
  chosen.add(n - 1);
  let list = [...chosen].sort((a, b) => a - b);
  while (list.length > want) {
    const mids = list.slice(1, -1);
    if (!mids.length) break;   // 只剩首末两个，丢谁都不行 → 就交这两个，别死循环
    // 名额不够就先丢中间那些"只占一瞬间"的场景，长场景留在名额里
    const mid = mids.sort((a, b) => scenes[a].delay - scenes[b].delay)[0];
    list = list.filter((v) => v !== mid);
  }
  return list.map((i) => scenes[i]);
}

/** frames（含 rgba/delay）→ 抽好的帧列表。 */
function selectGifFrames(frames, width, height, want) {
  const scenes = toScenes(frames.map((f) => ({ ...f, width, height })));
  const picked = pickScenes(scenes, Math.max(1, Math.min(scenes.length, want || 1)));
  return picked.map((s) => ({
    rgba: frames[s.index].rgba,
    width,
    height,
    delayMs: s.delay,
    sceneCount: scenes.length
  }));
}

/**
 * 把多帧拼成一张图（时间顺序：从左到右、从上到下）。
 * 抽 6 帧不再是 6 张图 = 6 份视觉 token，而还是一张，这样"多抽"不额外花钱。
 */
export function tileFrames(frames, { cols = 0, maxSide = 1024 } = {}) {
  const list = Array.isArray(frames) ? frames : [];
  if (list.length < 2) return list[0] ? { rgba: list[0].rgba, width: list[0].width, height: list[0].height } : null;
  const w0 = Math.max(...list.map((f) => f.width || 0));
  const h0 = Math.max(...list.map((f) => f.height || 0));
  if (!w0 || !h0) return null;
  const n = list.length;
  const nc = Math.max(1, cols || Math.ceil(Math.sqrt(n)));
  const nr = Math.ceil(n / nc);
  // 整张拼图不超过 maxSide：等比缩小每一格（取整，避免半像素错位）
  let cw = w0;
  let ch = h0;
  const fit = Math.min(1, maxSide / (cw * nc), maxSide / (ch * nr));
  if (fit < 1) {
    cw = Math.max(24, Math.floor(w0 * fit));
    ch = Math.max(24, Math.floor(h0 * fit));
  }
  const ow = cw * nc;
  const oh = ch * nr;
  const out = Buffer.alloc(ow * oh * 4);
  for (let i = 0; i < n; i++) {
    const f = list[i];
    if (!f?.rgba || !f.width || !f.height) continue;
    const gx = (i % nc) * cw;
    const gy = Math.floor(i / nc) * ch;
    for (let y = 0; y < ch; y++) {
      const sy = Math.min(f.height - 1, Math.floor((y * f.height) / ch));
      for (let x = 0; x < cw; x++) {
        const sx = Math.min(f.width - 1, Math.floor((x * f.width) / cw));
        const so = (sy * f.width + sx) * 4;
        const o = ((gy + y) * ow + gx + x) * 4;
        out[o] = f.rgba[so];
        out[o + 1] = f.rgba[so + 1];
        out[o + 2] = f.rgba[so + 2];
        out[o + 3] = f.rgba[so + 3] > 8 ? 255 : 0;   // 透明 → 填黑底，否则模型看到的是一整块透明
      }
    }
  }
  return { rgba: out, width: ow, height: oh };
}

// ── ffmpeg（可选，处理 webp/avif/bmp 等）────────────────────────────────

let ffmpegPathCache = null;
function findFfmpeg() {
  if (ffmpegPathCache !== null) return ffmpegPathCache;
  const candidates = [
    'ffmpeg',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    'C:\\Program Files\\ffmpeg\\bin\\ffmpeg.exe',
    'D:\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg'
  ];
  for (const bin of candidates) {
    try {
      const r = spawnSync(bin, ['-version'], { windowsHide: true, timeout: 4000 });
      if (!r.error && r.status === 0) {
        ffmpegPathCache = bin;
        return bin;
      }
    } catch { /* ignore */ }
  }
  ffmpegPathCache = '';
  return '';
}

/** 用 ffmpeg 把 buffer 转成 jpeg（首帧）。失败返回 null。 */
function convertWithFfmpeg(buf, mime) {
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return null;
  let tmpDir = '';
  try {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-vision-'));
    const ext = /png/i.test(mime) ? 'png'
      : /gif/i.test(mime) ? 'gif'
        : /webp/i.test(mime) ? 'webp'
          : /avif/i.test(mime) ? 'avif'
            : /bmp/i.test(mime) ? 'bmp'
              : 'img';
    const inFile = path.join(tmpDir, `in.${ext}`);
    const outFile = path.join(tmpDir, 'out.jpg');
    fs.writeFileSync(inFile, buf);
    const r = spawnSync(ffmpeg, [
      '-y', '-i', inFile,
      '-frames:v', '1',
      '-q:v', '3',
      outFile
    ], { windowsHide: true, timeout: 15000 });
    if (r.status === 0 && fs.existsSync(outFile)) {
      const out = fs.readFileSync(outFile);
      if (out.length > 100) return out;
    }
  } catch { /* ignore */ }
  finally {
    if (tmpDir) {
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }
  return null;
}

// ── 对外：buffer → 视觉 dataURL 列表 ────────────────────────────────────

/**
 * 把一张图变成可喂给视觉模型的 data URL 列表。
 *
 * @param {Buffer} buffer 原始字节
 * @param {object} opts
 * @param {string} [opts.mime] 已知 mime（可省略，自动魔数识别）
 * @param {number} [opts.maxFrames] GIF 最多抽几帧（默认 6）
 * @param {boolean} [opts.tile] 多帧拼成一张图（默认 true：抽得多但不多花视觉 token）
 * @returns {Promise<{ dataUrls: string[], skipped: boolean, note: string, converted: boolean, frameCount: number }>}
 *
 * - png/jpeg：原样
 * - gif：按场景去重 + 时长加权抽帧转 PNG（失败则回退原 gif 直发）
 * - 其它：有 ffmpeg 则转 jpeg；否则按 visionUnsupported 决定跳过或直发
 */
export async function toVisionDataUrls(buffer, { mime = null, maxFrames = 6, tile = true } = {}) {
  const m = String(mime || detectImageMime(buffer) || '').split(';')[0].toLowerCase();
  const fallback = () => ({
    dataUrls: m && buffer?.length ? [dataUrl(m, buffer)] : [],
    skipped: false,
    note: '',
    converted: false,
    frameCount: buffer?.length ? 1 : 0
  });

  if (!buffer || !buffer.length) {
    return { dataUrls: [], skipped: true, note: '空图片', converted: false, frameCount: 0 };
  }

  if (isPassThrough(m) || !m) {
    // 未知 mime 仍尝试当 jpeg 发（有 visionUnsupported/isImageRejection 兜底）
    const useMime = m || 'image/jpeg';
    return {
      dataUrls: [dataUrl(useMime, buffer)],
      skipped: false,
      note: '',
      converted: false,
      frameCount: 1
    };
  }

  // GIF → 多帧 PNG（默认拼成一张，避免"多抽=多花钱"）
  if (m === 'image/gif') {
    const frames = decodeGifFrames(buffer, { maxFrames: Math.max(1, Math.min(12, Number(maxFrames) || 6)) });
    if (frames.length) {
      if (frames.length > 1 && tile !== false) {
        const one = tileFrames(frames);
        if (one?.rgba) {
          return {
            dataUrls: [dataUrl('image/png', encodePng(one.rgba, one.width, one.height))],
            skipped: false,
            note: `（GIF 动图已按时间顺序把 ${frames.length} 个关键画面拼成一张：从左到右、从上到下。请据此判断动作的先后与笑点，别当成好几张不同的图）`,
            converted: true,
            frameCount: frames.length
          };
        }
      }
      const dataUrls = frames.map((f) => dataUrl('image/png', encodePng(f.rgba, f.width, f.height)));
      const note = frames.length > 1
        ? `（GIF 动图已抽出 ${frames.length} 帧，按时间顺序，可据此判断画面变化）`
        : '（GIF 已转为首帧 PNG）';
      return { dataUrls, skipped: false, note, converted: true, frameCount: frames.length };
    }
    // 解码失败：仍直发原 gif（部分接口能吃）
    return { ...fallback(), note: '（GIF 解码失败，按原图发送）' };
  }

  // webp / avif / bmp / heic …
  if (visionUnsupported(m)) {
    const jpeg = convertWithFfmpeg(buffer, m);
    if (jpeg) {
      return {
        dataUrls: [dataUrl('image/jpeg', jpeg)],
        skipped: false,
        note: '（原图格式当前接口不支持，已转成 JPEG）',
        converted: true,
        frameCount: 1
      };
    }
    return { dataUrls: [], skipped: true, note: `${m} 当前接口不支持且无法转换，已跳过`, converted: false, frameCount: 0 };
  }

  // 接口可能支持（如百炼收 webp）：优先 ffmpeg 转稳，失败则直发
  const jpeg = convertWithFfmpeg(buffer, m);
  if (jpeg) {
    return {
      dataUrls: [dataUrl('image/jpeg', jpeg)],
      skipped: false,
      note: '（已转成 JPEG 以提高兼容性）',
      converted: true,
      frameCount: 1
    };
  }
  return { ...fallback(), note: `（${m} 直发）` };
}

/** 同步便捷版：只要一个 data URL（GIF 也至少给首帧/原图）。 */
export function toVisionDataUrlSync(buffer, { mime = null, maxFrames = 1, tile = true } = {}) {
  const m = String(mime || detectImageMime(buffer) || 'image/jpeg').split(';')[0].toLowerCase();
  if (m === 'image/gif') {
    const frames = decodeGifFrames(buffer, { maxFrames: Math.max(1, Math.min(12, Number(maxFrames) || 1)) });
    if (frames.length) {
      const one = (frames.length > 1 && tile !== false) ? (tileFrames(frames) || frames[0]) : frames[0];
      return dataUrl('image/png', encodePng(one.rgba, one.width, one.height));
    }
  }
  if (m === 'image/webp' || m === 'image/avif' || m === 'image/bmp') {
    const jpeg = convertWithFfmpeg(buffer, m);
    if (jpeg) return dataUrl('image/jpeg', jpeg);
    if (visionUnsupported(m)) return null;
  }
  return dataUrl(m, buffer);
}
