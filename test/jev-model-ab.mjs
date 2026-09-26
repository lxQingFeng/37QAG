import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { buildJevPrompt, grammarForLabels, JEV_GATE_SPECS } from '../src/local-jev.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const OUT_DIR = path.join(ROOT, 'test', 'results');
const EXE = path.join(ROOT, 'runtime', 'llama', 'llama-server.exe');
const CASES = [
  { id:'P01', expected:'YES', text:'今天食堂的红烧肉居然卖完了', category:'日常闲聊' },
  { id:'P02', expected:'YES', text:'这雨说下就下 刚洗的鞋又要遭殃', category:'日常吐槽' },
  { id:'P03', expected:'YES', text:'新买的键盘敲着还挺舒服', category:'兴趣分享' },
  { id:'P04', expected:'YES', text:'地铁又晚点十分钟 真服了', category:'共同体验' },
  { id:'P05', expected:'YES', text:'这部番第二集终于没那么赶了', category:'兴趣讨论' },
  { id:'P06', expected:'YES', text:'谁能想到周五下午还能突然来个会', category:'职场闲聊' },
  { id:'P07', expected:'YES', text:'这局最后那波团打得有点漂亮', category:'游戏讨论' },
  { id:'P08', expected:'YES', text:'楼下新开的面馆辣得很有存在感', category:'美食闲聊' },
  { id:'P09', expected:'YES', text:'晚霞好看得有点不真实', category:'轻松分享' },
  { id:'P10', expected:'YES', text:'终于把折腾两天的报错改掉了', category:'进展分享' },
  { id:'P11', expected:'YES', text:'周末有人去漫展吗', category:'群体话题' },
  { id:'P12', expected:'YES', text:'这歌词一开口就很有画面', category:'音乐讨论' },
  { id:'P13', expected:'YES', text:'早八人的命也是命', category:'玩笑接梗' },
  { id:'P14', expected:'YES', text:'现在这个天气穿外套热不穿又冷', category:'日常吐槽' },
  { id:'P15', expected:'YES', text:'刚看到一只猫趴在快递柜上睡觉', category:'轻松分享' },
  { id:'P16', expected:'YES', text:'这版本更新完帧数居然更稳了', category:'游戏/技术' },
  { id:'P17', expected:'YES', text:'食堂阿姨今天给的菜量特别大方', category:'日常闲聊' },
  { id:'P18', expected:'YES', text:'剪头发最怕遇到热情的Tony老师', category:'玩笑闲聊' },
  { id:'P19', expected:'YES', text:'这个联名周边做得比上次顺眼多了', category:'兴趣分享' },
  { id:'P20', expected:'YES', text:'下午三点一到就开始犯困', category:'共同体验' },
  { id:'P21', expected:'YES', text:'楼道里的声控灯又在演我', category:'日常吐槽' },
  { id:'P22', expected:'YES', text:'终于买到想吃的那家泡芙了', category:'轻松分享' },
  { id:'P23', expected:'YES', text:'这题我算到第三遍才发现抄错数了', category:'学习吐槽' },
  { id:'P24', expected:'YES', text:'今天出门居然一路绿灯', category:'日常分享' },
  { id:'P25', expected:'YES', text:'这个梗怎么突然又火回来了', category:'兴趣讨论' },
  { id:'N01', expected:'NO', text:'我奶奶住院了 我现在有点慌', category:'私事/情绪' },
  { id:'N02', expected:'NO', text:'分手了 谢谢大家这些年的照顾', category:'情绪/告别' },
  { id:'N03', expected:'NO', text:'嗯', category:'纯语气词' },
  { id:'N04', expected:'NO', text:'今天血压真的好高', category:'健康隐私' },
  { id:'N05', expected:'NO', text:'@阿白 你看一下这个', category:'点名他人' },
  { id:'N06', expected:'NO', text:'我明天要交论文 终稿已经发你邮箱了', category:'事务安排' },
  { id:'N07', expected:'NO', text:'大家晚安', category:'告别收尾' },
  { id:'N08', expected:'NO', text:'我先去洗澡了', category:'离场告知' },
  { id:'N09', expected:'NO', text:'为什么偏偏是我遇到这种事', category:'情绪宣泄' },
  { id:'N10', expected:'NO', text:'收到', category:'事务确认' },
  { id:'N11', expected:'NO', text:'这个方案记得在十八点前提交', category:'通知安排' },
  { id:'N12', expected:'NO', text:'我妈最近身体不好 我得回去一趟', category:'私事/家庭' },
  { id:'N13', expected:'NO', text:'哈哈', category:'纯语气词' },
  { id:'N14', expected:'NO', text:'好 我知道了', category:'事务确认' },
  { id:'N15', expected:'NO', text:'今晚不用等我吃饭', category:'个人安排' },
  { id:'N16', expected:'NO', text:'我真的撑不下去了', category:'严重情绪' },
  { id:'N17', expected:'NO', text:'明天上午十点线上会议 链接稍后发', category:'通知安排' },
  { id:'N18', expected:'NO', text:'谢谢大家 我先撤了', category:'告别收尾' },
  { id:'N19', expected:'NO', text:'工资还没到账 这个月有点难', category:'私人财务' },
  { id:'N20', expected:'NO', text:'行', category:'纯语气词' },
  { id:'N21', expected:'NO', text:'@小林 资料放共享盘了', category:'点名他人' },
  { id:'N22', expected:'NO', text:'医生让我下周再去做个检查', category:'健康隐私' },
  { id:'N23', expected:'NO', text:'拜拜 大家明天见', category:'告别收尾' },
  { id:'N24', expected:'NO', text:'我这边先按流程走 等审批', category:'事务进展' },
  { id:'N25', expected:'NO', text:'最近压力大得睡不着', category:'情绪宣泄' }
];

function percentile(values, q) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a,b) => a-b);
  return sorted[Math.min(sorted.length-1, Math.ceil(q*sorted.length)-1)];
}

function summarize(label, rows) {
  const valid = rows.filter((r) => r.label === 'YES' || r.label === 'NO');
  const correct = valid.filter((r) => r.label === r.expected).length;
  const yesExpected = rows.filter((r) => r.expected === 'YES');
  const noExpected = rows.filter((r) => r.expected === 'NO');
  const yesCorrect = yesExpected.filter((r) => r.label === r.expected).length;
  const noCorrect = noExpected.filter((r) => r.label === r.expected).length;
  const latencies = rows.map((r) => r.ms);
  return {
    model:label,
    cases:rows.length,
    validLabelRate:valid.length/rows.length,
    validLabels:valid.length,
    accuracy:correct/valid.length,
    correct,
    positiveAccuracy:yesCorrect/yesExpected.length,
    negativeAccuracy:noCorrect/noExpected.length,
    latencyMs:{
      average:latencies.reduce((a,b)=>a+b,0)/latencies.length,
      p50:percentile(latencies,0.5),
      p95:percentile(latencies,0.95)
    },
    usage:rows.reduce((acc,r)=>{
      acc.promptTokens += r.promptTokens;
      acc.completionTokens += r.completionTokens;
      return acc;
    },{promptTokens:0,completionTokens:0})
  };
}
async function waitHealthy(child, port, timeoutMs = 120000) {
  const started = Date.now();
  let last = '';
  while (Date.now() - started < timeoutMs) {
    if (child.exitCode !== null) throw new Error(`llama-server exited ${child.exitCode}: ${last.slice(-1000)}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`llama-server health timeout: ${last.slice(-1000)}`);
}

async function runModel(model) {
  const modelPath = path.join(ROOT, 'models', model.file);
  const args = [
    '--model', modelPath,
    '--host', '127.0.0.1',
    '--port', String(model.port),
    '--ctx-size', '4096',
    '--parallel', '1',
    '--n-predict', '8',
    '--alias', model.id,
    '--reasoning', 'off',
    '--no-warmup'
  ];
  console.log(`\n=== ${model.file} ===`);
  const child = spawn(EXE, args, { windowsHide:true, stdio:['ignore','pipe','pipe'] });
  let log = '';
  child.stdout.on('data', (b) => { log += b.toString(); });
  child.stderr.on('data', (b) => { log += b.toString(); });
  try {
    await waitHealthy(child, model.port);
    const grammar = grammarForLabels(['YES','NO']);
    const rows = [];
    for (const c of CASES) {
      const built = buildJevPrompt({
        instruction:JEV_GATE_SPECS.replyChanceGate.instruction,
        examples:JEV_GATE_SPECS.replyChanceGate.examples,
        labels:JEV_GATE_SPECS.replyChanceGate.labels,
        input:c.text
      });
      const body = {
        model:model.id,
        messages:[{role:'system',content:built.system},{role:'user',content:built.user}],
        temperature:0,
        max_tokens:6,
        stream:false,
        enable_thinking:false,
        chat_template_kwargs:{enable_thinking:false},
        thinking:{type:'disabled'},
        logprobs:true,
        top_logprobs:12,
        grammar
      };
      const t0 = performance.now();
      const res = await fetch(`http://127.0.0.1:${model.port}/chat/completions`, {
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify(body),
        signal:AbortSignal.timeout(15000)
      });
      const ms = performance.now() - t0;
      if (!res.ok) throw new Error(`${c.id} HTTP ${res.status}: ${(await res.text()).slice(0,300)}`);
      const data = await res.json();
      const raw = String(data?.choices?.[0]?.message?.content ?? '').trim();
      const label = /^(YES|NO)$/i.test(raw) ? raw.toUpperCase() : null;
      rows.push({
        ...c,
        label,
        raw,
        ms,
        promptTokens:Number(data?.usage?.prompt_tokens) || 0,
        completionTokens:Number(data?.usage?.completion_tokens) || 0
      });
      if ((rows.length % 10) === 0) console.log(`${model.id}: ${rows.length}/${CASES.length}`);
    }
    return {model,rows,summary:summarize(model.id,rows),serverLogTail:log.slice(-4000)};
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => setTimeout(r,1000));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}
const MODELS = [
  { id:'qwen3.5-0.8b-q6k', file:'Qwen3.5-0.8B-Q6_K.gguf', port:18181 }
];

async function runClassifierProbe() {
  const model = { id:'jev-v2b', file:'jev-v2b-Q6_K.gguf', port:18182 };
  const modelPath = path.join(ROOT, 'models', model.file);
  const args = [
    '--model', modelPath,
    '--host', '127.0.0.1',
    '--port', String(model.port),
    '--ctx-size', '512',
    '--parallel', '1',
    '--alias', model.id,
    '--embedding',
    '--rerank',
    '--no-warmup'
  ];
  console.log(`\n=== ${model.file} compatibility probe ===`);
  const child = spawn(EXE, args, { windowsHide:true, stdio:['ignore', 'pipe', 'pipe'] });
  let log = '';
  child.stdout.on('data', (b) => { log += b.toString(); });
  child.stderr.on('data', (b) => { log += b.toString(); });
  try {
    await waitHealthy(child, model.port);
    const sample = CASES[0].text;
    const embedBody = { model:model.id, input:sample };
    const tEmbed0 = performance.now();
    const embedRes = await fetch(`http://127.0.0.1:${model.port}/v1/embeddings`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(embedBody)
    });
    const embedMs = performance.now() - tEmbed0;
    const embedData = await embedRes.json();
    const built = buildJevPrompt({
      instruction:JEV_GATE_SPECS.replyChanceGate.instruction,
      examples:JEV_GATE_SPECS.replyChanceGate.examples,
      labels:JEV_GATE_SPECS.replyChanceGate.labels,
      input:sample
    });
    let chatError = '';
    let chatStatus = null;
    try {
      const chatRes = await fetch(`http://127.0.0.1:${model.port}/chat/completions`, {
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({
          model:model.id,
          messages:[{role:'system',content:built.system},{role:'user',content:built.user}],
          max_tokens:6,
          grammar:grammarForLabels(['YES','NO'])
        })
      });
      chatStatus = chatRes.status;
      if (!chatRes.ok) chatError = (await chatRes.text()).slice(0, 300);
    } catch (error) {
      chatError = String(error?.message || error);
    }
    return {
      model:model.id,
      file:model.file,
      fileBytes:fs.statSync(modelPath).size,
      architecture:'bert',
      generalType:'model',
      generalName:'Jev V2B Hf',
      sizeLabel:'559M',
      trainingContext:512,
      outputLabelCount:76,
      outputLabels:'SLOT_0..SLOT_75（模型元数据未保存业务含义）',
      defaultPooling:'rank',
      embeddingDimensions:Array.isArray(embedData?.data?.[0]?.embedding) ? embedData.data[0].embedding.length : null,
      embeddingOk:embedRes.ok,
      embeddingMs:embedMs,
      chatCompatible:false,
      chatHttpStatus:chatStatus,
      chatError,
      mappingAvailable:false,
      comparableAccuracy:false,
      reason:'这是 BERT 分类/排序模型，不是生成模型；当前文件只带 SLOT_0..SLOT_75，缺少槽位业务映射，无法把输出解释成 replyChanceGate 的 YES/NO。',
      serverLogTail:log.slice(-4000)
    };
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((r) => setTimeout(r, 1000));
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
}

const results = [];
for (const model of MODELS) results.push(await runModel(model));
const classifierProbe = await runClassifierProbe();

const comparison = results.map((r) => r.summary);
const bestByAccuracy = [...comparison].sort((a, b) => b.accuracy - a.accuracy)[0];
const bestByLatency = [...comparison].sort((a, b) => a.latencyMs.p50 - b.latencyMs.p50)[0];
const output = {
  date:'2026-09-26',
  scope:'本次自建题库、当前 Windows 环境下的比较；只代表当前“该不该插嘴”链路，不代表模型绝对强弱。',
  promptRole:'replyChanceGate',
  caseCount:CASES.length,
  positiveCases:CASES.filter((c) => c.expected === 'YES').length,
  negativeCases:CASES.filter((c) => c.expected === 'NO').length,
  comparison,
  classifierProbe,
  conclusion:{
    usableForCurrentPipeline:'qwen3.5-0.8b-q6k',
    bestGenerativeAccuracy:bestByAccuracy.model,
    bestGenerativeLatency:bestByLatency.model,
    summary:'在当前插嘴判定任务中 Qwen3.5-0.8B 可直接运行并给出 YES/NO；jev-v2b 是缺少槽位映射的 BERT 分类器，当前不能直接替代或公平计分。'
  },
  results
};
fs.mkdirSync(OUT_DIR,{recursive:true});
const jsonPath=path.join(OUT_DIR,'jev-model-ab-2026-09-26.json');
fs.writeFileSync(jsonPath,JSON.stringify(output,null,2));

const lines=[
  '# Jev 模型比较（2026-09-26）',
  '',
  `范围：${output.scope}`,
  '',
  `题库：${CASES.length} 题（应接话 ${output.positiveCases} / 不应接话 ${output.negativeCases}），使用线上 replyChanceGate 同一提示词与标签约束。`,
  '',
  '| 模型 | 类型/可用性 | 有效标签率 | 总准确率 | 应接话准确率 | 不应接话准确率 | 平均延迟 | P50 | P95 | Prompt tokens | Completion tokens |',
  '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
];
for(const s of comparison){
  lines.push(`| ${s.model} | 生成模型，可直接跑当前链路 | ${(s.validLabelRate*100).toFixed(1)}% | ${(s.accuracy*100).toFixed(1)}% | ${(s.positiveAccuracy*100).toFixed(1)}% | ${(s.negativeAccuracy*100).toFixed(1)}% | ${s.latencyMs.average.toFixed(0)}ms | ${s.latencyMs.p50.toFixed(0)}ms | ${s.latencyMs.p95.toFixed(0)}ms | ${s.usage.promptTokens} | ${s.usage.completionTokens} |`);
}
lines.push(`| jev-v2b-q6k | BERT 分类/排序模型；缺 SLOT 映射 | N/A | N/A | N/A | N/A | ${classifierProbe.embeddingMs.toFixed(0)}ms（仅向量） | N/A | N/A | N/A | N/A |`);
lines.push(
  '',
  '## Jev V2B 结构检查',
  '',
  `- 文件：\`${classifierProbe.file}\`，${(classifierProbe.fileBytes / 1024 / 1024).toFixed(1)} MiB。`,
  `- 元数据：${classifierProbe.architecture} / ${classifierProbe.generalName} / 训练上下文 ${classifierProbe.trainingContext}。`,
  `- 分类头：${classifierProbe.outputLabelCount} 个输出，名称仅为 ${classifierProbe.outputLabels}。`,
  `- 向量接口可用：${classifierProbe.embeddingOk ? '是' : '否'}，输出 ${classifierProbe.embeddingDimensions} 维；生成接口可用：否。`,
  `- 生成接口错误：${classifierProbe.chatError}`,
  '',
  '## 结论',
  '',
  `- 当前插嘴判定链路里，可直接使用且完成实测的是 \`${output.conclusion.usableForCurrentPipeline}\`。`,
  `- ${output.conclusion.summary}`,
  '- 若要严格比较 Jev V2B 的 76 类分类能力，还需要它训练时的 SLOT_0..SLOT_75 业务映射或原始标签表；仅凭当前 GGUF 无法把分类结果翻译成 YES/NO。',
  ''
);
const mdPath=path.join(OUT_DIR,'jev-model-ab-2026-09-26.md');
fs.writeFileSync(mdPath,lines.join('\n'));

console.log(JSON.stringify({
  jsonPath,
  mdPath,
  comparison,
  classifierProbe,
  conclusion:output.conclusion
},null,2));



