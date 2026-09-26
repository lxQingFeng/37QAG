// 语音模块入口（阶段四·用户需求 4）：STT 收语音 + TTS 发语音。
//
// 模块体系挂载（见 docs/阶段二改造说明.md）：
//   · providers：media.transcribe 能力（与 speech-to-text 插件同名 —— onebot.js 的
//     语音转写链遍历 providers，先到先得；本模块 enabled 时注册，即优先接管）
//   · registerTool：send_voice（模型自主决定何时用语音回复 —— mode='manual'）
//   · 事件订阅：message.sent（mode='auto'：每条文字回复后自动跟发语音，带冷却防双发）
//   · 路由：GET /api/voice/status（两端可用性探测）、POST /api/voice/test（试听合成）
//
// 遵循项目铁律：语音是「增强」不是「必需」—— 任何失败都降级（STT→[语音] 占位、
// TTS→纯文字），绝不阻塞聊天主链路。
import { sttCfg, sttPrimaryChannel, sttCloudReady, sttLocalReady, transcribeWav } from './stt.js';
import { ttsCfg, synthesize, edgeTtsAvailable, ttsLocalReady } from './tts.js';
import { fetchRecordAsWav, toSendableRecord, silkAvailable } from './audio.js';

let _api = null;

/** 转写一条 QQ 语音（media.transcribe 能力函数体）。 */
async function transcribe({ record, onebot }) {
  const cfg = sttCfg(_api.globalConfig);
  if (!cfg.enabled) return { ok: false, error: 'voice.stt 未启用' };
  const wav = await fetchRecordAsWav(record, onebot);
  if (!wav?.length) return { ok: false, error: '取不到语音音频（get_record 与本地解码均失败）' };
  const text = await transcribeWav(wav, cfg);
  return { ok: true, text };
}

/** TTS 合成并发送语音到会话。返回 { ok, note?, error? }。 */
async function sendVoiceToChat(chatKey, text) {
  const cfg = ttsCfg(_api.globalConfig);
  if (!cfg.enabled) return { ok: false, error: 'voice.tts 未启用' };
  const audio = await synthesize(text, cfg);
  if (!audio?.length) return { ok: false, error: '合成失败（已降级文字）' };
  const onebot = _api.context?.onebot;
  if (!onebot?.call) return { ok: false, error: '无 OneBot 连接' };
  const record = await toSendableRecord(audio, cfg.encode);
  const [kind, id] = String(chatKey).split(':');
  const action = kind === 'group' ? 'send_group_msg' : 'send_private_msg';
  const payload = kind === 'group'
    ? { group_id: Number(id), message: [{ type: 'record', data: { file: record.file } }] }
    : { user_id: Number(id), message: [{ type: 'record', data: { file: record.file } }] };
  await onebot.call(action, payload, 30000);
  return { ok: true, note: record.note };
}

// auto 模式冷却（chatKey → 上次语音时间）：防 send_voice 工具发的文本又触发 auto 双发
const lastVoiceAt = new Map();

/** @param {import('../../src/module-registry.js').ModuleApi} api */
export async function setup(api) {
  _api = api;
  const stt = sttCfg(api.globalConfig);

  // ── STT：enabled 时注册转写能力（接管 speech-to-text 插件的角色）──
  if (stt.enabled) {
    api.provide('media.transcribe', transcribe);
    api.log(`STT 已启用（通道 ${sttPrimaryChannel(stt)}，云端${sttCloudReady(stt) ? '✓' : '未配 key'} / 本地${sttLocalReady(stt) ? '✓' : '未配'}）`);
  }

  // ── TTS：注册工具（manual 模式）+ 事件（auto 模式）──
  const tts = ttsCfg(api.globalConfig);
  if (tts.enabled) {
    api.registerTool({
      name: 'send_voice',
      description: '用语音（说话）发送这段文字内容。适合口语化内容、闲聊、语气重要的回复；技术细节/代码/链接多的内容用普通 send_message。文本会被朗读出来，不要包含表情id、@语法或链接。',
      parameters: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '要朗读并发送的文本（纯文字，200 字内）' }
        },
        required: ['text']
      },
      async execute(args) {
        const text = String(args?.text || '').trim();
        if (!text) return { isError: true, content: 'text 不能为空' };
        // 标记冷却起点：紧接着的 auto 模式会因冷却跳过同一段文本
        lastVoiceAt.set(api.context?.session?.chatKey || '', Date.now());
        const chatKey = currentChatKey(api);
        lastVoiceAt.set(chatKey, Date.now());
        const r = await sendVoiceToChat(chatKey, text);
        if (!r.ok) return { content: `语音发送失败（${r.error}），请改用 send_message 发文字` };
        return { content: `语音已发送（${r.note}）` };
      }
    });

    if (tts.mode === 'auto') {
      api.on('message.sent', async (payload) => {
        try {
          const chatKey = String(payload?.chatKey || '');
          if (!chatKey) return;
          const now = Date.now();
          const last = Number(lastVoiceAt.get(chatKey)) || 0;
          if (now - last < tts.autoCooldownMs) return;   // 刚发过语音（工具或 auto），冷却
          const text = String(payload?.text || '').trim();
          if (!text || text.length > tts.maxLength) return;
          const r = await sendVoiceToChat(chatKey, text);
          if (r.ok) lastVoiceAt.set(chatKey, now);
        } catch { /* auto TTS 失败静默 */ }
      });
      api.log(`TTS auto 模式已启用（冷却 ${tts.autoCooldownMs}ms，音色 ${tts.cloud.voice}）`);
    } else {
      api.log(`TTS manual 模式已启用（模型经 send_voice 工具自主决定）`);
    }
  }

  // ── 路由：状态探测 + 试听 ──
  api.registerRoute({
    method: 'GET',
    pattern: '/api/voice/status',
    handler: async (req, res, { json }) => {
      const c1 = sttCfg(api.globalConfig);
      const c2 = ttsCfg(api.globalConfig);
      json(res, 200, {
        ok: true,
        stt: {
          enabled: c1.enabled, channel: sttPrimaryChannel(c1),
          cloud: { ready: sttCloudReady(c1), model: c1.cloud.model },
          local: { ready: sttLocalReady(c1), engine: c1.local.engine }
        },
        tts: {
          enabled: c2.enabled, mode: c2.mode, channel: c2.channel,
          cloud: { edgeTts: await edgeTtsAvailable(), voice: c2.cloud.voice },
          local: { ready: ttsLocalReady(c2), engine: c2.local.engine }
        },
        codec: { silkWasm: await silkAvailable() }
      });
    }
  });

  api.registerRoute({
    method: 'POST',
    pattern: '/api/voice/test',
    handler: async (req, res, { json, readBody }) => {
      const body = await readBody(req).catch(() => ({}));
      const text = String(body?.text || '语音模块工作正常，这是一条测试。').slice(0, 200);
      const cfg = ttsCfg(api.globalConfig);
      const audio = await synthesize(text, cfg);
      if (!audio?.length) return json(res, 503, { ok: false, error: '合成失败：云端 edge-tts 未装/失败且本地未配置。npm i msedge-tts 或配置 voice.tts.local' });
      return json(res, 200, { ok: true, bytes: audio.length, text });
    }
  });

  api.log('语音模块已挂载（STT/TTS 各自独立开关，见 voice 配置段）');
}

export async function dispose(api) {
  _api = null;
  lastVoiceAt.clear();
}

function currentChatKey(api) {
  // 工具执行上下文里拿会话 key：ctx 由 orchestrator 注入（session.chatKey）
  const s = api.context?.session;
  return String(s?.chatKey || api.context?.chatKey || '');
}
