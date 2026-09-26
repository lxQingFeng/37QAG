// 健康系统 Pro 插件 —— 健康状态影响对话情绪
//
// 功能：
//   - 24 种健康状态：口渴度、饱食度、精力值、健康值、心情值、睡眠需求、疲劳度、舒适度、压力值、孤独感、社交需求、满足感、归属感，
//     以及发烧度/成瘾度/求知欲/同理心/安全感/抵抗力/焦虑度/抑郁度/情绪稳定/专注力/睡眠负债
//   - 状态随时间自动衰减，支持配置衰减速率
//   - v7.0 基础需求深化：13 个基础维度五阶段具象化、维度间连锁反应、
//     深层生理亚成分（电解质/热量盈余/精神疲劳/亲密需求/情绪波动/体力储备）、非线性恢复与溢出
//   - v7.1 图片报表：/健康 与「健康图片报表」工具会渲染一张完整状态图直接发到聊天
//     （Electron 离屏渲染 HTML → PNG，零三方依赖；失败自动降级为文字报告）
//   - v8.0 生命节律与身心生态：昼夜节律（24 小时真实生理曲线 + 生物钟相位偏移）、
//     肠道菌群（六项菌群 × 营养吸收/肠脑轴/免疫，抗生素重创）、过敏系统（八种过敏原 ×
//     季节环境触发 → 过敏负荷 → 四种过敏性疾病）、社交关系网（五类关系 × 亲密度/亲密/积怨，
//     深聊与和解）、生物年龄（九类因素推算生理年龄）、医保（三档报销 + 年度额度）、
//     健康大事记（事件时间轴，供对话回忆引用）
//   - v9.0 爱好与技能树：19 种爱好 × 7 大类，学 → 练 → 熟练度（11 级阶梯）→ 作品（四档品质）
//     → 赠送给关系网；热情会随时间消退、连练同一爱好累积兴趣耗竭；练过头会累积上肢劳损与
//     视疲劳，并可能触发腱鞘炎 / 腰肌劳损 / 干眼症 / 兴趣耗竭
//   - v10.0 宠物养成：10 种宠物（猫/狗/仓鼠/兔子/鹦鹉/金鱼/乌龟/蜥蜴/刺猬/龙猫）×
//     5 个成长阶段 × 四维需求（饱食/饮水/清洁/心情，按真实时间衰减）× 寿命与寿终；
//     喂养/换水/清洁/陪玩/撸宠/遛弯/训练学技能/表演，宠物有自己的 8 种疾病（要自费看兽医）；
//     掉毛皮屑会推高主人的过敏负荷、夜行物种夜里闹腾会磨睡眠、亲密度反哺归属感与孤独感
//   - 支持互动命令（喝水、吃饭、休息、睡觉、聊天等）
//   - 状态影响对话情绪，但不直接发送数值
//   - 状态过低时自动提醒（隐藏具体数值）

let cfg = () => ({});
let log = () => {};
let storage = null;
let sender = null;
let onebot = null;
let chatKey = null;

// 健康状态（持久化存储）
let healthState = {
  thirst: 80,      // 💧 口渴度
  hunger: 80,      // 🍚 饱食度
  energy: 80,      // ⚡ 精力值
  health: 80,      // ❤️ 健康值
  mood: 80,        // 😊 心情值
  sleep: 80,       // 😴 睡眠需求
  fatigue: 80,     // 😪 疲劳度
  comfort: 80,     // 🛋️ 舒适度
  stress: 80,      // 😰 压力值
  loneliness: 80,  // 🥺 孤独感
  social: 80,      // 🤝 社交需求
  satisfaction: 80, // 🎯 满足感
  belonging: 80,   // 🏠 归属感
  // —— 拓展维度（v0.5）——
  fever: 0,        // 🤒 发烧度（越高越糟，平时 0；生病时升高后自然退烧）
  addiction: 0,    // 🎮 成瘾度（越高越糟，特定行为升高，平时缓慢缓解）
  curiosity: 80,   // 🔍 求知欲（越高越好）
  empathy: 80,     // 💗 同理心（越高越好）
  security: 80,    // 🛡️ 安全感（越高越好）
  immunity: 80,    // 🧬 抵抗力（越高越好，影响发病/恢复/治疗）
  diseaseHistory: {}, // 发病次数统计 { diseaseKey: count }
  remissions: {},  // 慢性病缓解期（当前慢性病采用"维持初期"模型，预留）
  activeSymptoms: [], // 当前症状明细（派生）
  diseases: [],    // 当前疾病列表
  diseaseStages: {}, // 疾病阶段 { diseaseKey: '初期' | '中期' | '晚期' | '危重' }
  // —— 生理深度模拟（v3.0）——
  organs: { heart: 100, lung: 100, liver: 100, stomach: 100, kidney: 100, brain: 100, skin: 100, blood: 100 }, // 器官健康度
  constitution: 'balanced', // 体质类型（见 CONSTITUTIONS）
  pathogens: {},   // 当前感染病原明细 { diseaseKey: { type, load } }
  incubating: {},  // 潜伏期 { diseaseKey: { until, type } }
  antibodies: {},  // 免疫记忆 { diseaseKey: 抗体到期时间戳 }
  diagnosed: {},   // 已确诊 { diseaseKey: true }（确诊后治疗成功率提升）
  drugResistance: {}, // 耐药性 { medicineKey: 0-100 }（越高药效越差）
  medicineBox: { fever_reducer: 2, cold_medicine: 2, antibiotic: 1, stomach_medicine: 1, antianxiety: 1, allergy_medicine: 1, painkiller: 2 }, // 药箱库存
  money: 200,      // 金钱（¥），用于就医/买药
  medicalCost: 0,  // 累计医疗花费
  lastWork: 0,     // 上次打工时间戳
  lastVaccine: 0,  // 上次接种时间戳
  // —— 临床检验指标（v4.0）——
  weight: 58,      // ⚖️ 体重（kg）
  height: 165,     // 📏 身高（cm）
  diet: 65,        // 🥗 饮食健康度（越高越好：影响血糖/血脂/尿酸）
  exercise: 60,    // 🏃 运动习惯（越高越好：影响血压/血脂/心肺）
  sleepQuality: 70,// 😴 睡眠质量（越高越好：影响血压/心率）
  lastBloodTest: 0,// 上次抽血化验时间戳
  lastDiet: 0,     // 上次清淡饮食时间戳
  vitalsHistory: [], // 检验指标历史快照 [{ date, values }]（供趋势对比）
  // —— 环境 / 医疗体系 / 遗传 / 营养（v5.0）——
  env: { weather: 'clear', tempC: 22, humidity: 55, aqi: 45, uv: 5, season: 'spring', extreme: '', updatedAt: 0 }, // 当前环境（extreme = 极端天气事件 key）
  envHistory: [],  // 环境历史快照 [{ date, weather, tempC, aqi }]
  hospital: 'general', // 当前就诊医院（见 HOSPITALS）
  lastEmergency: 0, // 上次急诊时间戳
  familyHistory: [], // 家族遗传史（遗传倾向 key 列表，见 FAMILY_HISTORY）
  familyRolled: false, // 是否已生成过家族史（避免每次启动重复随机）
  nutrients: { protein: 72, carbs: 70, fat: 62, vitamin: 70, mineral: 70, fiber: 62, sodium: 58, sugar: 45 }, // 八大营养素摄入合理度 0-100
  lastSupplement: 0, // 上次吃营养品时间戳
  // —— 心理 / 睡眠 / 内分泌 / 创伤 / 流行病 / 习惯 / 成就（v6.0）——
  anxiety: 15,       // 😟 焦虑度（越高越糟）
  depressionLevel: 10, // 🌧️ 抑郁度（越高越糟）
  stability: 80,     // 🧘 情绪稳定（越高越好）
  focus: 75,         // 🎯 专注力（越高越好）
  sleepDebt: 0,      // 😵 睡眠负债（越高越糟）
  psycHistory: [],   // 咨询/干预记录 [{ date, text }]
  lastTherapy: 0,    // 上次心理咨询时间戳
  lastMeditate: 0,   // 上次冥想时间戳
  // 睡眠深度
  sleepStage: 'awake', // 当前睡眠阶段：awake/light/deep/rem
  sleepClock: 0,     // 🕰️ 生物钟偏移（正值=晚睡型，负值=早睡型，-12~12）
  caffeine: 0,       // ☕ 咖啡因（越高越难入睡，0-100）
  sleepLog: [],      // 睡眠日志 [{ date, stage, hours }]
  lastCoffee: 0,     // 上次喝咖啡时间戳
  lastNap: 0,        // 上次小睡时间戳
  lastMelatonin: 0,  // 上次吃褪黑素时间戳
  // 内分泌
  hormones: { cortisol: 45, adrenaline: 25, serotonin: 70, dopamine: 65, thyroxine: 60, melatonin: 35 }, // 激素水平 0-100
  lastHormoneCheck: 0,
  // 创伤
  injuries: [],      // 外伤 [{ type, part, severity, at }]
  lastFirstAid: 0,   // 上次急救时间戳
  scarCount: 0,      // 累计受伤次数（统计用）
  // 流行病
  epidemic: { active: false, disease: '', since: 0, level: 0 }, // 社区疫情
  maskOn: false,     // 😷 是否戴口罩
  lastDisinfect: 0,  // 上次消毒时间戳
  lastIsolate: 0,    // 上次隔离时间戳
  // 习惯
  habits: { smoking: 0, drinking: 0, stayingUp: 0, sedentary: 0, morningRun: 0, meditation: 0, drinkingWater: 0, earlySleep: 0 }, // 习惯养成度 0-100
  // 成就
  achievements: {},  // 已解锁徽章 { badgeKey: 解锁时间戳 }
  // 影像检查
  lastImaging: 0,
  imagingHistory: [], // [{ date, type, findings }]
  // 年龄
  age: 20,           // 🎂 年龄（每年生日 +1，影响基础衰减）
  lastBirthday: 0,   // 上次生日时间戳
  // —— 基础需求深化：深层生理亚成分（v7.0）——
  electrolyte: 75,      // 🧂 电解质平衡（过低会"喝再多也不解渴"）
  calorieSurplus: 20,   // 🍔 热量盈余（越高越糟，沉积为脂肪）
  mentalFatigue: 20,    // 🧠 精神疲劳（越高越糟，靠睡眠/冥想恢复）
  intimacy: 70,         // 💞 亲密需求满足度（浅层社交补不上）
  moodVolatility: 18,   // 🎢 情绪波动（越高越糟，无端烦躁）
  physicalReserve: 70,  // 🏋️ 体力储备（运动的底子）
  lastElectrolyte: 0,   // 上次补充电解质时间戳
  needPhaseLog: {},     // 各维度上次所处阶段（阶段跃迁提示用）
  // —— 昼夜节律 / 肠道菌群 / 过敏 / 关系网 / 医保 / 大事记（v8.0）——
  circadianOffset: 0,   // 🕰️ 节律相位偏移（小时，正=夜猫子型相位后移，-3~3）
  gut: { bifido: 70, lacto: 68, bacteroides: 72, firmicutes: 70, diversity: 74, barrier: 76 }, // 🦠 肠道菌群
  lastProbiotics: 0,    // 上次补充益生菌时间戳
  lastFiber: 0,         // 上次高纤维饮食时间戳
  allergens: {},        // 🌾 过敏谱 { allergenKey: 敏感等级 1-5 }（空 = 未检测）
  allergenRolled: false,// 是否已生成过敏谱
  allergyLoad: 0,       // 🤧 过敏负荷（越高越糟，由季节/环境/进食实时计算）
  lastAntihistamine: 0, // 上次吃抗过敏药时间戳
  relationsSeed: false, // 是否已播下初始关系种子
  insurance: { plan: 'none', since: 0, expireAt: 0, usedThisYear: 0 }, // 🧾 医保
  timeline: [],         // 📜 健康大事记 [{ at, emoji, text, type }]
  bioAgeCache: 0,       // 最近一次生物年龄（报告展示用）
  // —— 爱好与技能树（v9.0）——
  hobbies: {},          // 🎨 已学爱好 { hobbyKey: { xp, passion, practiceCount, works:[], learnedAt, lastPractice, milestones } }
  hobbyStrain: 0,       // 🖐️ 上肢/重复性劳损（越高越糟，练习手工/乐器类累积）
  hobbyEyeStrain: 0,    // 👁️ 视疲劳（越高越糟，练习数码/阅读类累积）
  hobbyBurnout: 0,      // 🥵 兴趣耗竭（越高越糟，连续高强度练习同一爱好累积）
  hobbyStreakKey: '',   // 最近连续练习的爱好
  hobbyStreak: 0,       // 连续练习次数（换爱好或长时间不练清零）
  hobbyLastPractice: 0, // 上次任意练习的时间戳
  // —— 宠物养成（v10.0）——
  pets: [],             // 🐾 已养的宠物 [{ id, species, name, bornAt, adoptedAt, bond, satiety, hydration, hygiene, spirit, health, diseases:[], skillXp, tricks:[], lastFeed, lastWater, lastClean, lastPlay, lastWalk, memorial }]
  petSeq: 1,            // 宠物 id 自增序号
  petCost: 0,           // 💸 宠物累计花销（粮/用品/兽医/领养，不计入人自己的医疗支出）
  petLastTick: 0,       // 上次宠物需求衰减的时间戳（用于按小时结算）
  petShed: 0,           // 🐾 掉毛/皮屑指数（由已养宠物动态算出，供过敏负荷读取）
  petNightNoise: 0,     // 🌙 夜间吵闹指数（猫/仓鼠等夜行物种，越高越影响主人睡眠）
  // —— 日常生活（v11.0）——
  outfit: { worn: 'casual', changedAt: 0, wet: 0, sunscreen: 0 }, // 🧥 当前穿着 { 衣物key, 换衣时间, 淋湿度, 防晒剩余 }
  outfitStats: { wornCount: 0, perfectDays: 0, sunGuard: 0 },     // 🧥 穿搭统计（成就用）
  home: { tidy: 72, laundry: 70, dishes: 0, petDirt: 0, miteRelief: 0, lastTidy: 0, lastLaundry: 0, lastQuilt: 0 }, // 🏠 居家 { 整洁, 衣物洁净, 待洗碗, 宠物脏污累积, 晒被除螨余效, 各任务时间 }
  homeStats: { tidyCount: 0, laundryCount: 0, quiltCount: 0, dishCount: 0, hireCount: 0 },           // 🏠 家务统计
  bills: { dueAt: 0, unpaid: 0, overdue: 0, history: [], lastWarn: 0 }, // 💸 账单 { 下次到期, 欠费额, 逾期次数, 缴费记录, 上次提醒 }
  billStats: { paidCount: 0, totalPaid: 0 },                            // 💸 缴费统计
  livingCost: 0,        // 💸 日常生活累计开销（伙食/账单/保洁，与医疗支出分开记账）
  foodRisk: 0,          // 🦠 食物安全风险累积（吃外卖/夜宵/泡面会涨，涨满易吃坏肚子）
  sunExposure: 0,       // ☀️ 日晒累积（紫外线强又没防晒时上涨，涨满会晒伤）
  mealLog: [],          // 🍜 今日已吃（[{ key, at }]，按天清理）
  mealStats: {},        // 🍜 各菜品累计次数（成就用）
  lastMealAt: 0,        // 上次进食时间（夜宵判定 / 该吃饭了提示）
  // —— 钱币系统（v12.0）——
  wallet: { salaryAt: 0, lastPaid: 0, payCount: 0, totalSalary: 0 },   // 💼 发薪日 { 下次发薪, 上次发薪, 已发次数, 累计工资 }
  gig: { lastAt: 0, count: 0, total: 0, best: 0, flops: 0, byKey: {}, lastKey: '' }, // 🧾 接单统计
  workStats: { count: 0, total: 0, cooldown: {}, byType: {} },         // 💪 打工统计（各工种独立冷却）
  ledger: { income: [], expense: [], monthKey: '', monthIn: 0, monthOut: 0, totalIn: 0, totalOut: 0 }, // 📒 收支流水
  // —— 时间与社会（v13.0）——
  //   三个 last*Key 都是「日历日去重戳」：计数按天算，不按衰减周期算
  timeStats: { weekendDays: 0, festivalDays: 0, birthdays: 0, extremeDays: 0 }, // 🗓️ 时间统计（天/次）
  lastFestivalKey: '',  // 上次已记账的节日（日期:节日键）
  lastWeekendDay: '',   // 上次已计入「休息日」的日期
  lastExtremeDay: '',   // 上次已计入「极端天气日」的日期
  extremeStats: { count: 0, byKey: {}, lastKey: '' }, // 🌪️ 极端天气统计（按事件次数）
  chronicControl: {},   // ♻️ 慢性病控制进度 { diseaseKey: 0~3 }（攒满 3 次进入缓解期）
  initialized: false, // 是否已从文件/人设卡初始化
  lastUpdate: Date.now(),
  lastRemind: {}
};

// 状态名称到键的映射（用于解析人设卡）
const STATUS_NAME_MAP = {
  '口渴度': 'thirst',
  '饱食度': 'hunger',
  '精力值': 'energy',
  '健康值': 'health',
  '心情值': 'mood',
  '睡眠需求': 'sleep',
  '疲劳度': 'fatigue',
  '舒适度': 'comfort',
  '压力值': 'stress',
  '孤独感': 'loneliness',
  '社交需求': 'social',
  '满足感': 'satisfaction',
  '归属感': 'belonging',
  '发烧度': 'fever',
  '成瘾度': 'addiction',
  '求知欲': 'curiosity',
  '同理心': 'empathy',
  '安全感': 'security',
  '抵抗力': 'immunity',
  '焦虑度': 'anxiety',
  '抑郁度': 'depressionLevel',
  '情绪稳定': 'stability',
  '专注力': 'focus',
  '睡眠负债': 'sleepDebt'
};

// 从人设卡解析健康初始值
function parseHealthFromPersona(personaText) {
  if (!personaText || typeof personaText !== 'string') return {};

  const initialValues = {};
  const lines = personaText.split('\n');

  for (const line of lines) {
    // 匹配格式：- 状态名: 数值 或 状态名: 数值
    const match = line.match(/^[-\s]*(口渴度|饱食度|精力值|健康值|心情值|睡眠需求|疲劳度|舒适度|压力值|孤独感|社交需求|满足感|归属感|发烧度|成瘾度|求知欲|同理心|安全感|抵抗力|焦虑度|抑郁度|情绪稳定|专注力|睡眠负债)\s*[:：]\s*(\d+)/);

    if (match) {
      const name = match[1];
      const value = Math.max(0, Math.min(100, parseInt(match[2], 10)));
      const key = STATUS_NAME_MAP[name];

      if (key) {
        initialValues[key] = value;
      }
    }
  }

  // v4.0 生活方式 / 体型（独立解析：不受 0-100 状态范围限制）
  const lifeMap = {
    '体重': ['weight', 20, 200],
    '身高': ['height', 100, 220],
    '饮食健康度': ['diet', 0, 100],
    '运动习惯': ['exercise', 0, 100],
    '睡眠质量': ['sleepQuality', 0, 100]
  };
  for (const line of lines) {
    const mm = line.match(/^[-\s]*(体重|身高|饮食健康度|运动习惯|睡眠质量)\s*[:：]\s*(\d+(?:\.\d+)?)/);
    if (mm) {
      const [key, lo, hi] = lifeMap[mm[1]];
      const num = Number(mm[2]);
      if (Number.isFinite(num)) initialValues[key] = Math.max(lo, Math.min(hi, num));
    }
  }

  return initialValues;
}

// 疾病恶化/减轻配置
const DISEASE_PROGRESSION = {
  // 可自然减轻的疾病（轻微疾病）
  natural_recover: ['cold', 'cough', 'headache', 'insomnia', 'anxiety', 'subhealth', 'mouth_ulcer', 'toothache', 'hair_loss', 'eyestrain', 'spring_allergy', 'spring_rhinitis', 'autumn_dryness', 'autumn_cough', 'summer_rash', 'winter_rhinitis',
    // v9.0：干眼症只要停手少用眼就能缓过来
    'dry_eye',
    // v11.0：晒伤只要不再暴晒，几天就蜕皮好了
    'sunburn'],

  // 会自然恶化的疾病（严重疾病）
  natural_worsen: ['dehydration', 'malnutrition', 'exhaustion', 'fever', 'gastroenteritis', 'heatstroke', 'anemia', 'hypertension', 'hypoglycemia', 'flu', 'winter_flu', 'winter_pneumonia', 'winter_frostbite', 'summer_heatstroke', 'summer_diarrhea',
    // v11.0：急性肠胃炎不止泻不补液会脱水加重
    'food_poisoning'],

  // 需要治疗的疾病（不会自然变化）
  need_treatment: ['depression', 'loneliness', 'arthritis', 'backache', 'cervical_spondylosis', 'palpitation', 'neurasthenia', 'tinnitus', 'pharyngitis', 'rhinitis', 'allergy', 'constipation', 'spring_cold', 'autumn_cold', 'motion_sickness',
    // v9.0：练出来的劳损与耗竭，必须治 + 停练
    'tendonitis', 'lumbar_strain', 'hobby_burnout']
};

// 疾病阶段定义
const DISEASE_STAGES = {
  '初期': { healthDecay: 1, label: '刚有点症状' },
  '中期': { healthDecay: 2, label: '症状加重' },
  '晚期': { healthDecay: 3, label: '病情严重' },
  '危重': { healthDecay: 5, label: '病危，需要立即治疗' }
};

// 疾病配置
const DISEASES = {
  dehydration: {
    name: '脱水症',
    emoji: '🏜️',
    conditions: { thirst: { max: 30 } },
    healthDecay: 5,
    symptoms: '头晕、口干舌燥、乏力'
  },
  malnutrition: {
    name: '营养不良',
    emoji: '🥬',
    conditions: { hunger: { max: 30 }, health: { max: 50 } },
    healthDecay: 4,
    symptoms: '虚弱、免疫力下降'
  },
  exhaustion: {
    name: '过度疲劳',
    emoji: '😮‍💨',
    conditions: { energy: { max: 30 }, fatigue: { max: 30 } },
    healthDecay: 3,
    symptoms: '全身酸痛、反应迟钝'
  },
  insomnia: {
    name: '失眠症',
    emoji: '🌙',
    conditions: { sleep: { max: 30 } },
    healthDecay: 4,
    symptoms: '黑眼圈、注意力不集中'
  },
  depression: {
    name: '抑郁症',
    emoji: '😢',
    conditions: { mood: { max: 30 } },
    healthDecay: 3,
    symptoms: '情绪低落、失去兴趣'
  },
  anxiety: {
    name: '焦虑症',
    emoji: '😰',
    conditions: { stress: { max: 30 } },
    healthDecay: 3,
    symptoms: '紧张不安、心悸'
  },
  loneliness: {
    name: '孤独症',
    emoji: '🏝️',
    conditions: { loneliness: { max: 30 } },
    healthDecay: 2,
    symptoms: '社交回避、情绪低落'
  },
  subhealth: {
    name: '亚健康',
    emoji: '⚠️',
    conditions: { health: { max: 50 }, mood: { max: 50 }, energy: { max: 50 } },
    healthDecay: 2,
    symptoms: '整体状态不佳、容易疲惫'
  },
  cold: {
    name: '感冒',
    emoji: '🤧',
    conditions: { mood: { max: 40 }, energy: { max: 40 }, health: { max: 60 } },
    healthDecay: 3,
    symptoms: '打喷嚏、流鼻涕、喉咙痛'
  },
  fever: {
    name: '发烧',
    emoji: '🤒',
    conditions: { stress: { max: 30 }, health: { max: 40 } },
    healthDecay: 4,
    symptoms: '体温高、浑身无力'
  },
  cough: {
    name: '咳嗽',
    emoji: '🤑',
    conditions: { comfort: { max: 30 }, health: { max: 50 } },
    healthDecay: 2,
    symptoms: '咳嗽、喉咙痒'
  },
  headache: {
    name: '头痛',
    emoji: '🤯',
    conditions: { stress: { max: 35 }, fatigue: { max: 40 } },
    healthDecay: 2,
    symptoms: '头痛、眩晕'
  },
  gastroenteritis: {
    name: '肠胃炎',
    emoji: '🤮',
    conditions: { hunger: { max: 25 }, health: { max: 45 } },
    healthDecay: 4,
    symptoms: '腹痛、腹泻、恶心'
  },
  allergy: {
    name: '过敏',
    emoji: '🤧',
    conditions: { comfort: { max: 25 }, health: { max: 55 } },
    healthDecay: 2,
    symptoms: '打喷嚏、皮肤痒、眼睛红'
  },
  heatstroke: {
    name: '中暑',
    emoji: '☀️',
    conditions: { comfort: { max: 20 } },
    healthDecay: 5,
    symptoms: '头晕、恶心、体温升高'
  },
  motion_sickness: {
    name: '晕车',
    emoji: '🤕',
    conditions: { social: { max: 35 }, energy: { max: 40 } },
    healthDecay: 2,
    symptoms: '恶心、头晕、脸色苍白'
  },
  anemia: {
    name: '贫血',
    emoji: '🩸',
    conditions: { hunger: { max: 30 }, health: { max: 40 }, fatigue: { max: 35 } },
    healthDecay: 3,
    symptoms: '脸色苍白、头晕、乏力'
  },
  eyestrain: {
    name: '用眼过度',
    emoji: '👀',
    conditions: { energy: { max: 35 }, stress: { max: 45 } },
    healthDecay: 1,
    symptoms: '眼睛干涩、视力模糊'
  },
  constipation: {
    name: '便秘',
    emoji: '💩',
    conditions: { thirst: { max: 25 }, hunger: { max: 35 } },
    healthDecay: 2,
    symptoms: '腹痛、排便困难'
  },
  flu: {
    name: '流感',
    emoji: '🤒',
    conditions: { health: { max: 50 }, mood: { max: 40 }, energy: { max: 40 } },
    healthDecay: 5,
    symptoms: '高烧、全身酸痛、极度乏力'
  },
  rhinitis: {
    name: '鼻炎',
    emoji: '👃',
    conditions: { comfort: { max: 30 }, health: { max: 55 } },
    healthDecay: 2,
    symptoms: '鼻塞、流鼻涕、打喷嚏'
  },
  pharyngitis: {
    name: '咽炎',
    emoji: '👅',
    conditions: { comfort: { max: 25 }, thirst: { max: 35 } },
    healthDecay: 2,
    symptoms: '喉咙痛、吞咽困难'
  },
  mouth_ulcer: {
    name: '口腔溃疡',
    emoji: '🦷',
    conditions: { hunger: { max: 30 }, health: { max: 55 } },
    healthDecay: 1,
    symptoms: '口腔溃疡、疼痛'
  },
  toothache: {
    name: '牙痛',
    emoji: '🦷',
    conditions: { hunger: { max: 35 }, comfort: { max: 35 } },
    healthDecay: 1,
    symptoms: '牙疼、面部肿胀'
  },
  tinnitus: {
    name: '耳鸣',
    emoji: '👂',
    conditions: { stress: { max: 30 }, sleep: { max: 35 } },
    healthDecay: 1,
    symptoms: '耳朵嗡嗡响、听力下降'
  },
  neurasthenia: {
    name: '神经衰弱',
    emoji: '🧠',
    conditions: { stress: { max: 35 }, fatigue: { max: 35 }, mood: { max: 40 } },
    healthDecay: 3,
    symptoms: '易怒、失眠、记忆力下降'
  },
  palpitation: {
    name: '心悸',
    emoji: '💓',
    conditions: { stress: { max: 25 }, health: { max: 45 } },
    healthDecay: 3,
    symptoms: '心跳加速、胸闷'
  },
  hypertension: {
    name: '高血压',
    emoji: '💢',
    conditions: { stress: { max: 25 }, health: { max: 40 } },
    healthDecay: 4,
    symptoms: '头痛、头晕、耳鸣'
  },
  hypoglycemia: {
    name: '低血糖',
    emoji: '🍬',
    conditions: { hunger: { max: 20 }, energy: { max: 30 } },
    healthDecay: 4,
    symptoms: '手抖、出冷汗、头晕'
  },
  arthritis: {
    name: '关节炎',
    emoji: '🦴',
    conditions: { fatigue: { max: 30 }, health: { max: 45 } },
    healthDecay: 2,
    symptoms: '关节疼痛、活动受限'
  },
  backache: {
    name: '腰疼',
    emoji: '🧍',
    conditions: { fatigue: { max: 30 }, comfort: { max: 35 } },
    healthDecay: 2,
    symptoms: '腰部酸痛、僵硬'
  },
  cervical_spondylosis: {
    name: '颈椎病',
    emoji: '🤷',
    conditions: { fatigue: { max: 35 }, stress: { max: 40 } },
    healthDecay: 2,
    symptoms: '脖子僵硬、头晕、手麻'
  },
  hair_loss: {
    name: '脱发',
    emoji: '💇',
    conditions: { stress: { max: 35 }, fatigue: { max: 35 }, health: { max: 50 } },
    healthDecay: 1,
    symptoms: '头发脱落、头皮痒'
  },
  // —— 代谢 / 内分泌疾病（v4.0：由生活方式驱动，指标会明显跑偏）——
  hyperlipidemia: {
    name: '高血脂',
    emoji: '🧈',
    conditions: { diet: { max: 45 }, exercise: { max: 45 } },
    healthDecay: 2,
    symptoms: '血液黏稠、容易疲倦、无明显自觉症状'
  },
  fatty_liver: {
    name: '脂肪肝',
    emoji: '🫀',
    conditions: { diet: { max: 40 }, fatigue: { max: 45 } },
    healthDecay: 2,
    symptoms: '右上腹隐痛、乏力、转氨酶升高'
  },
  diabetes: {
    name: '糖尿病',
    emoji: '🍬',
    conditions: { diet: { max: 30 }, thirst: { max: 45 }, hunger: { min: 85 } },
    healthDecay: 3,
    symptoms: '多饮多尿、容易饿、视力模糊'
  },
  hyperuricemia: {
    name: '高尿酸血症',
    emoji: '🦶',
    conditions: { diet: { max: 38 }, hunger: { min: 80 } },
    healthDecay: 1,
    symptoms: '关节红肿、痛风发作、尿酸偏高'
  },
  atherosclerosis: {
    name: '动脉硬化',
    emoji: '🩻',
    conditions: { diet: { max: 30 }, exercise: { max: 30 } },
    healthDecay: 3,
    symptoms: '头晕、胸闷、血管弹性下降'
  },
  hypokalemia: {
    name: '低钾血症',
    emoji: '⚡',
    conditions: { thirst: { max: 35 }, hunger: { max: 35 } },
    healthDecay: 2,
    symptoms: '四肢无力、心慌、肌肉酸痛'
  },

  // —— 心理 / 内分泌 / 睡眠 / 创伤（v6.0）——
  anxiety_disorder: {
    name: '焦虑症',
    emoji: '😟',
    conditions: { anxiety: { min: 65 } },
    healthDecay: 1,
    symptoms: '心悸、坐立不安、难以放松'
  },
  depression_major: {
    name: '抑郁症',
    emoji: '🌧️',
    conditions: { depressionLevel: { min: 65 } },
    healthDecay: 1,
    symptoms: '情绪低落、兴趣减退、早醒'
  },
  panic_disorder: {
    name: '恐慌症',
    emoji: '😱',
    conditions: { anxiety: { min: 80 } },
    healthDecay: 1,
    symptoms: '突发心悸、濒死感、喘不上气'
  },
  social_phobia: {
    name: '社交恐惧症',
    emoji: '🙈',
    conditions: { anxiety: { min: 55 }, belonging: { max: 45 } },
    healthDecay: 1,
    symptoms: '回避社交、脸红出汗、不敢开口'
  },
  ocd: {
    name: '强迫症',
    emoji: '🔁',
    conditions: { anxiety: { min: 60 }, focus: { max: 40 } },
    healthDecay: 1,
    symptoms: '反复检查、强迫思维、无法自控'
  },
  ptsd: {
    name: '创伤后应激障碍',
    emoji: '💥',
    conditions: { stability: { max: 40 }, anxiety: { min: 60 } },
    healthDecay: 1,
    symptoms: '闪回、噩梦、警觉过度'
  },
  bipolar: {
    name: '双相情感障碍',
    emoji: '🎭',
    conditions: { stability: { max: 35 } },
    healthDecay: 2,
    symptoms: '情绪大起大落、时而亢奋时而低落'
  },
  sad: {
    name: '季节性情感障碍',
    emoji: '🍂',
    conditions: { depressionLevel: { min: 55 }, mood: { max: 45 } },
    healthDecay: 1,
    symptoms: '秋冬情绪低落、嗜睡、乏力、想吃甜食'
  },
  hyperthyroidism: {
    name: '甲亢',
    emoji: '🔥',
    conditions: { stress: { max: 40 }, focus: { max: 45 } },
    healthDecay: 2,
    symptoms: '心悸、手抖、消瘦、怕热多汗'
  },
  hypothyroidism: {
    name: '甲减',
    emoji: '🐢',
    conditions: { energy: { max: 35 }, focus: { max: 40 } },
    healthDecay: 2,
    symptoms: '怕冷、乏力、浮肿、反应迟钝'
  },
  hormonal_imbalance: {
    name: '内分泌失调',
    emoji: '⚖️',
    conditions: { stability: { max: 45 }, sleepQuality: { max: 45 } },
    healthDecay: 1,
    symptoms: '皮肤变差、情绪波动、睡眠紊乱'
  },
  infected_wound: {
    name: '伤口感染',
    emoji: '🩹',
    conditions: { immunity: { max: 45 }, health: { max: 55 } },
    healthDecay: 2,
    symptoms: '伤口红肿化脓、发热、疼痛'
  },
  concussion: {
    name: '脑震荡',
    emoji: '🧠',
    conditions: { focus: { max: 35 }, stability: { max: 40 } },
    healthDecay: 2,
    symptoms: '头晕、恶心、注意力涣散'
  },
  sleep_disorder: {
    name: '睡眠障碍',
    emoji: '🌙',
    conditions: { sleepDebt: { min: 60 } },
    healthDecay: 1,
    symptoms: '入睡困难、易醒、白天嗜睡'
  },
  circadian_disorder: {
    name: '作息紊乱',
    emoji: '🕰️',
    conditions: { sleepQuality: { max: 40 }, sleepDebt: { min: 40 } },
    healthDecay: 1,
    symptoms: '昼夜颠倒、白天没精神、夜间亢奋'
  },
  // —— v8.0 肠道菌群类（条件绑定派生状态 gutScore / gutBarrier）——
  dysbiosis: {
    name: '肠道菌群失调',
    emoji: '🦠',
    conditions: { gutScore: { max: 40 } },
    healthDecay: 1,
    symptoms: '腹胀、排气多、排便不规律、吃什么都胀气'
  },
  ibs: {
    name: '肠易激综合征',
    emoji: '🌀',
    conditions: { gutScore: { max: 52 }, stress: { max: 45 } },
    healthDecay: 1,
    symptoms: '腹痛、腹泻与便秘交替，一紧张就肚子疼'
  },
  leaky_gut: {
    name: '肠漏症',
    emoji: '🧱',
    conditions: { gutBarrier: { max: 38 }, immunity: { max: 62 } },
    healthDecay: 2,
    symptoms: '食物不耐受、皮肤起疹、慢性低度炎症'
  },
  // —— v8.0 过敏类（条件绑定派生状态 allergyLoad）——
  allergic_rhinitis: {
    name: '过敏性鼻炎',
    emoji: '🤧',
    conditions: { allergyLoad: { min: 45 } },
    healthDecay: 1,
    symptoms: '连续喷嚏、清水样鼻涕、鼻眼发痒'
  },
  urticaria: {
    name: '荨麻疹',
    emoji: '🔴',
    conditions: { allergyLoad: { min: 62 } },
    healthDecay: 2,
    symptoms: '皮肤风团、剧烈瘙痒、时起时消'
  },
  asthma: {
    name: '哮喘发作',
    emoji: '🫁',
    conditions: { allergyLoad: { min: 72 }, immunity: { max: 72 } },
    healthDecay: 3,
    symptoms: '喘息、胸闷、呼气困难、夜间加重'
  },
  anaphylaxis: {
    name: '过敏性休克',
    emoji: '🚨',
    conditions: { allergyLoad: { min: 88 }, health: { max: 72 } },
    healthDecay: 8,
    symptoms: '喉头水肿、血压骤降、全身风团、意识模糊——需立即抢救'
  },
  // —— v9.0 爱好劳损类（条件绑定派生状态 hobbyStrain / hobbyEyeStrain / hobbyBurnout）——
  tendonitis: {
    name: '腱鞘炎',
    emoji: '🖐️',
    conditions: { hobbyStrain: { min: 55 }, fatigue: { max: 55 } },
    healthDecay: 1,
    symptoms: '手腕/手指肿痛、活动时有弹响、握不住东西'
  },
  lumbar_strain: {
    name: '腰肌劳损',
    emoji: '🦴',
    conditions: { hobbyStrain: { min: 70 }, physicalReserve: { max: 45 } },
    healthDecay: 2,
    symptoms: '腰部酸痛僵硬、弯腰起身困难、久坐后更明显'
  },
  dry_eye: {
    name: '干眼症',
    emoji: '👁️',
    conditions: { hobbyEyeStrain: { min: 60 } },
    healthDecay: 1,
    symptoms: '眼睛干涩发痒、畏光、看久了模糊刺痛'
  },
  hobby_burnout: {
    name: '兴趣耗竭',
    emoji: '🥵',
    conditions: { hobbyBurnout: { min: 65 }, mood: { max: 60 } },
    healthDecay: 1,
    symptoms: '一碰到爱好就烦躁、找不到乐趣、越练越空虚'
  },
  // —— v11.0 日常生活 ——
  sunburn: {
    name: '晒伤',
    emoji: '🔥',
    conditions: { sunExposure: { min: 55 } },
    healthDecay: 1,
    symptoms: '皮肤发红发烫、碰一下都疼、晚上翻身都难受'
  },
  food_poisoning: {
    name: '急性肠胃炎',
    emoji: '🤢',
    conditions: { foodRisk: { min: 50 }, health: { max: 85 } },
    healthDecay: 2,
    symptoms: '肚子一阵阵绞痛、上吐下泻、浑身发冷使不上劲'
  }
};

// 疾病关联配置（某些疾病容易一起得）
const DISEASE_ASSOCIATIONS = {
  // 感冒相关
  cold: ['cough', 'fever', 'pharyngitis'],
  cough: ['cold', 'pharyngitis'],
  fever: ['cold', 'flu', 'heatstroke'],

  // 流感相关
  flu: ['fever', 'cough', 'exhaustion'],

  // 肠胃相关
  gastroenteritis: ['dehydration', 'summer_diarrhea'],
  dehydration: ['gastroenteritis', 'constipation'],
  constipation: ['dehydration'],

  // 过敏相关
  allergy: ['rhinitis', 'cough'],
  rhinitis: ['allergy', 'cold'],

  // 血压/心脏相关
  hypertension: ['headache', 'tinnitus', 'palpitation', 'atherosclerosis'],
  palpitation: ['hypertension', 'anxiety'],
  headache: ['hypertension', 'neurasthenia'],

  // 血液/营养相关
  anemia: ['exhaustion', 'headache', 'hair_loss'],
  malnutrition: ['anemia', 'exhaustion'],

  // 疲劳相关
  exhaustion: ['neurasthenia', 'headache', 'anemia'],
  neurasthenia: ['exhaustion', 'headache', 'anxiety'],

  // 环境相关
  heatstroke: ['dehydration', 'fever'],
  winter_frostbite: ['hypertension', 'headache'],

  // 心理相关
  depression: ['anxiety', 'insomnia', 'hair_loss'],
  anxiety: ['depression', 'palpitation', 'neurasthenia'],
  insomnia: ['depression', 'neurasthenia', 'exhaustion'],

  // 季节性疾病关联
  spring_allergy: ['spring_rhinitis', 'spring_cold'],
  spring_cold: ['spring_rhinitis', 'cough', 'fever'],
  summer_heatstroke: ['dehydration', 'fever'],
  summer_diarrhea: ['dehydration'],
  autumn_cough: ['cold', 'pharyngitis'],
  winter_flu: ['fever', 'cough', 'winter_pneumonia'],
  winter_pneumonia: ['fever', 'cough', 'exhaustion'],
  winter_frostbite: ['hypertension', 'headache'],

  // 代谢综合征关联（v4.0）：一份生活方式问题会连锁引出一串代谢病
  hyperlipidemia: ['fatty_liver', 'diabetes', 'atherosclerosis', 'hypertension'],
  fatty_liver: ['hyperlipidemia', 'diabetes'],
  diabetes: ['hyperlipidemia', 'fatty_liver', 'atherosclerosis', 'dehydration'],
  hyperuricemia: ['hyperlipidemia', 'hypertension'],
  atherosclerosis: ['hypertension', 'palpitation', 'headache'],
  hypokalemia: ['palpitation', 'exhaustion'],
  // 心理 / 睡眠 / 内分泌关联（v6.0）：一处失衡容易连锁失衡
  anxiety_disorder: ['depression_major', 'panic_disorder', 'sleep_disorder', 'ocd'],
  depression_major: ['anxiety_disorder', 'sleep_disorder', 'sad'],
  sleep_disorder: ['circadian_disorder', 'anxiety_disorder', 'neurasthenia'],
  circadian_disorder: ['sleep_disorder', 'neurasthenia'],
  hyperthyroidism: ['palpitation', 'anxiety_disorder'],
  hypothyroidism: ['exhaustion', 'anemia'],
  hormonal_imbalance: ['sleep_disorder', 'anxiety_disorder'],
  concussion: ['headache', 'sleep_disorder'],
  infected_wound: ['fever', 'exhaustion']
};

// 季节性疾病配置
const SEASONAL_DISEASES = {
  // 春季（3-5 月）
  spring_allergy: {
    name: '花粉过敏',
    emoji: '🌸',
    season: 'spring',
    conditions: { comfort: { max: 40 }, health: { max: 60 } },
    healthDecay: 3,
    symptoms: '打喷嚏、流鼻涕、眼睛痒'
  },
  spring_cold: {
    name: '春季感冒',
    emoji: '🤧',
    season: 'spring',
    conditions: { mood: { max: 40 }, energy: { max: 40 }, health: { max: 55 } },
    healthDecay: 3,
    symptoms: '咳嗽、喉咙痛、乏力'
  },
  spring_rhinitis: {
    name: '春季鼻炎',
    emoji: '👃',
    season: 'spring',
    conditions: { comfort: { max: 35 }, health: { max: 50 } },
    healthDecay: 2,
    symptoms: '鼻塞、流鼻涕、打喷嚏'
  },

  // 夏季（6-8 月）
  summer_heatstroke: {
    name: '热射病',
    emoji: '🥵',
    season: 'summer',
    conditions: { comfort: { max: 25 }, health: { max: 40 } },
    healthDecay: 5,
    symptoms: '高烧、昏迷、意识不清'
  },
  summer_diarrhea: {
    name: '夏季腹泻',
    emoji: '🤢',
    season: 'summer',
    conditions: { hunger: { max: 30 }, health: { max: 50 } },
    healthDecay: 4,
    symptoms: '腹痛、腹泻、脱水'
  },
  summer_rash: {
    name: '痱子',
    emoji: '🌡️',
    season: 'summer',
    conditions: { comfort: { max: 30 }, health: { max: 60 } },
    healthDecay: 2,
    symptoms: '皮肤红疹、瘙痒'
  },

  // 秋季（9-11 月）
  autumn_dryness: {
    name: '秋季干燥',
    emoji: '🍂',
    season: 'autumn',
    conditions: { thirst: { max: 35 }, comfort: { max: 40 } },
    healthDecay: 2,
    symptoms: '皮肤干、嘴唇裂、喉咙痒'
  },
  autumn_cough: {
    name: '秋季咳嗽',
    emoji: '🤑',
    season: 'autumn',
    conditions: { comfort: { max: 30 }, health: { max: 50 } },
    healthDecay: 2,
    symptoms: '干咳、喉咙痒'
  },
  autumn_cold: {
    name: '换季感冒',
    emoji: '🤧',
    season: 'autumn',
    conditions: { mood: { max: 40 }, energy: { max: 40 }, health: { max: 55 } },
    healthDecay: 3,
    symptoms: '打喷嚏、流鼻涕、发烧'
  },

  // 冬季（12-2 月）
  winter_flu: {
    name: '冬季流感',
    emoji: '🤒',
    season: 'winter',
    conditions: { health: { max: 50 }, mood: { max: 40 }, energy: { max: 40 } },
    healthDecay: 5,
    symptoms: '高烧、全身酸痛、极度乏力'
  },
  winter_pneumonia: {
    name: '肺炎',
    emoji: '🫁',
    season: 'winter',
    conditions: { health: { max: 40 }, fatigue: { max: 35 } },
    healthDecay: 4,
    symptoms: '呼吸困难、咳嗽、发烧'
  },
  winter_frostbite: {
    name: '冻伤',
    emoji: '❄️',
    season: 'winter',
    conditions: { comfort: { max: 20 }, health: { max: 40 } },
    healthDecay: 4,
    symptoms: '皮肤红肿、麻木、刺痛'
  },
  winter_rhinitis: {
    name: '冬季鼻炎',
    emoji: '👃',
    season: 'winter',
    conditions: { comfort: { max: 30 }, health: { max: 55 } },
    healthDecay: 2,
    symptoms: '鼻塞、流鼻涕、打喷嚏'
  }
};

// ── 疾病系统拓展元数据（v0.6）──
// 慢性病/传染病/并发症 标记，集中管理避免改动上面每个疾病条目
const DISEASE_FLAGS = {
  // 慢性病：一旦得上无法根治，治愈后维持在「初期」稳定态，免疫力低时可能偶发加重
  chronic: ['arthritis', 'backache', 'cervical_spondylosis', 'rhinitis', 'allergy',
    'depression', 'hypertension', 'tinnitus', 'palpitation', 'neurasthenia', 'pharyngitis',
    // v4.0 代谢类慢性病（治不断根，需长期控饮食/运动）
    'hyperlipidemia', 'fatty_liver', 'diabetes', 'hyperuricemia', 'atherosclerosis',
    // v6.0 心理 / 内分泌 / 睡眠类慢性病（需长期干预）
    'anxiety_disorder', 'depression_major', 'bipolar', 'ptsd', 'ocd',
    'sleep_disorder', 'circadian_disorder', 'hypothyroidism',
    // v8.0 菌群 / 过敏类慢性病（治不断根，需长期调理）
    'dysbiosis', 'ibs', 'leaky_gut', 'allergic_rhinitis',
    // v9.0 爱好劳损类慢性病（久练成疾，需停下休养）
    'tendonitis', 'lumbar_strain', 'dry_eye'],
  // 传染病：社交度(social)越高越容易被传染
  contagious: ['cold', 'fever', 'cough', 'flu', 'rhinitis', 'pharyngitis',
    'spring_cold', 'spring_rhinitis', 'autumn_cold', 'autumn_cough',
    'winter_flu', 'winter_pneumonia', 'winter_rhinitis'],
  // 并发症：进入晚期/危重时可能引发的关联疾病
  complications: {
    flu: ['exhaustion', 'cough', 'fever'],
    fever: ['headache', 'dehydration'],
    gastroenteritis: ['dehydration'],
    heatstroke: ['dehydration', 'fever'],
    hypertension: ['palpitation', 'headache'],
    malnutrition: ['anemia'],
    anemia: ['exhaustion'],
    winter_flu: ['winter_pneumonia', 'cough'],
    winter_pneumonia: ['exhaustion'],
    depression: ['insomnia', 'anxiety'],
    // v4.0 代谢并发症
    hyperlipidemia: ['atherosclerosis', 'fatty_liver', 'hypertension'],
    fatty_liver: ['hyperlipidemia', 'diabetes'],
    diabetes: ['fatty_liver', 'palpitation', 'dehydration'],
    atherosclerosis: ['palpitation', 'headache'],
    hyperuricemia: ['palpitation'],
    // v6.0 心理 / 内分泌 / 睡眠 / 创伤并发症
    anxiety_disorder: ['panic_disorder', 'sleep_disorder'],
    depression_major: ['anxiety_disorder', 'sleep_disorder'],
    bipolar: ['anxiety_disorder', 'sleep_disorder'],
    hyperthyroidism: ['palpitation', 'anxiety_disorder'],
    sleep_disorder: ['circadian_disorder', 'neurasthenia'],
    circadian_disorder: ['sleep_disorder', 'neurasthenia'],
    infected_wound: ['fever', 'exhaustion']
  }
};

function isChronic(key) { return DISEASE_FLAGS.chronic.includes(key); }
function isContagious(key) { return DISEASE_FLAGS.contagious.includes(key); }
function getComplications(key) { return DISEASE_FLAGS.complications[key] || []; }

// 免疫因子：-0.5(极差) ~ +0.5(极强)，用于调节发病/恢复/治疗概率
function getImmunityFactor() {
  const imm = Number(healthState.immunity);
  return Math.max(-0.5, Math.min(0.5, (imm - 50) / 100));
}

// 统一"得病"入口：维护疾病列表与阶段（发病次数在 decayHealth 统一统计，避免重复）
function addDisease(key, stage = '初期') {
  if (!getDiseaseInfo(key)) return false;
  // v13.0：缓解期是硬不变量 —— 所有加病路径（判定/关联/传染/潜伏结束）都要被挡住
  if (isInRemission(key)) return false;
  if (!healthState.diseases.includes(key)) {
    healthState.diseases.push(key);
  }
  if (!healthState.diseaseStages[key]) healthState.diseaseStages[key] = stage;
  return true;
}

// 传染暴露：社交度高时按概率被传染（仅当前季节的传染病生效）
function rollContagion() {
  const social = Number(healthState.social);
  if (social < 40) return; // 不太社交，暴露低
  const season = getCurrentSeason();
  const candidates = [];
  for (const [k, d] of Object.entries(DISEASES)) {
    if (isContagious(k)) candidates.push(k);
  }
  for (const [k, d] of Object.entries(SEASONAL_DISEASES)) {
    if (isContagious(k) && d.season === season) candidates.push(k);
  }
  for (const k of candidates) {
    if (healthState.diseases.includes(k)) continue;
    if (hasAntibody(k)) continue; // 有免疫记忆，不会被传染
    if (isInRemission(k)) continue; // v13.0：缓解期不会被传染
    const chance = (social / 100) * 0.04; // 社交满值约 4%/轮
    if (Math.random() < chance) {
      const name = getDiseaseInfo(k)?.name || k;
      // 经统一暴露入口：有潜伏期的进入潜伏期
      if (enqueueExposure(k, '接触传染')) {
        recordMedical(`传染暴露：疑似接触 ${name}`);
        log(`[健康系统] 传染暴露 ${k}`);
      }
    }
  }
}

// 预后估算（基于疾病阶段负荷与免疫力）
function generatePrognosis(diseases) {
  if (!diseases || !diseases.length) return '体质不错，保持现状即可。';
  const stageWeight = { '初期': 1, '中期': 2, '晚期': 3, '危重': 5 };
  let load = 0;
  for (const d of diseases) load += stageWeight[getDiseaseStage(d)] || 1;
  const imm = Number(healthState.immunity);
  const rate = Math.max(0.1, 0.3 + (imm - 50) / 200);
  const days = Math.max(1, Math.round(load / (rate * 2)));
  return `预计约 ${days} 天可明显好转（受当前抵抗力 ${imm} 影响）`;
}

// ── 药物注册表（靶向用药）──
const MEDICINES = {
  fever_reducer: { name: '退烧药', emoji: '🌡️', targets: ['fever', 'flu', 'heatstroke', 'summer_heatstroke', 'winter_flu', 'winter_pneumonia', 'autumn_cold', 'spring_cold'], feverRelief: 35, health: 2, mood: 2 },
  cold_medicine: { name: '感冒药', emoji: '🤧', targets: ['cold', 'cough', 'rhinitis', 'pharyngitis', 'spring_cold', 'spring_rhinitis', 'autumn_cold', 'autumn_cough', 'winter_rhinitis', 'winter_pneumonia'], feverRelief: 5, health: 2, mood: 1 },
  antibiotic: { name: '抗生素', emoji: '💉', targets: ['gastroenteritis', 'summer_diarrhea', 'winter_pneumonia', 'pharyngitis'], feverRelief: 0, health: 4, mood: 1 },
  stomach_medicine: { name: '胃药', emoji: '🤢', targets: ['gastroenteritis', 'constipation', 'dehydration'], feverRelief: 0, health: 3, mood: 1 },
  antianxiety: { name: '安神药', emoji: '😌', targets: ['anxiety', 'depression', 'insomnia', 'neurasthenia', 'palpitation', 'hypertension'], feverRelief: 0, health: 2, mood: 4 },
  allergy_medicine: { name: '抗过敏药', emoji: '🌼', targets: ['allergy', 'spring_allergy', 'rhinitis'], feverRelief: 0, health: 1, mood: 2 },
  painkiller: { name: '止痛药', emoji: '💊', targets: ['headache', 'toothache', 'arthritis', 'backache', 'cervical_spondylosis', 'tinnitus', 'mouth_ulcer'], feverRelief: 0, health: 1, mood: 3 }
};

// ══════════════════════════════════════════════════════════════════════════
//  生理深度模拟层（v3.0）
//  器官 / 病原体 / 潜伏期 / 免疫记忆 / 体质 / 用药深化 / 医疗经济
// ══════════════════════════════════════════════════════════════════════════

// ── ① 器官系统：8 个器官，0-100。疾病损伤器官，器官受损反向加重病情 ──
const ORGAN_INFO = {
  heart:   { name: '心脏', emoji: '❤️' },
  lung:    { name: '肺部', emoji: '🫁' },
  liver:   { name: '肝脏', emoji: '🫀' },
  stomach: { name: '肠胃', emoji: '🫃' },
  kidney:  { name: '肾脏', emoji: '🫘' },
  brain:   { name: '大脑', emoji: '🧠' },
  skin:    { name: '皮肤', emoji: '🩹' },
  blood:   { name: '血液', emoji: '🩸' }
};

// 疾病 → 主要受损器官（未列出的按病原体类型兜底）
const DISEASE_ORGAN = {
  dehydration: 'kidney', malnutrition: 'blood', exhaustion: 'heart', insomnia: 'brain',
  depression: 'brain', anxiety: 'heart', loneliness: 'brain', subhealth: 'blood',
  cold: 'lung', fever: 'blood', cough: 'lung', headache: 'brain',
  gastroenteritis: 'stomach', allergy: 'skin', heatstroke: 'brain', motion_sickness: 'stomach',
  anemia: 'blood', eyestrain: 'brain', constipation: 'stomach', flu: 'lung',
  rhinitis: 'lung', pharyngitis: 'lung', mouth_ulcer: 'stomach', toothache: 'brain',
  tinnitus: 'brain', neurasthenia: 'brain', palpitation: 'heart', hypertension: 'heart',
  hypoglycemia: 'liver', arthritis: 'blood', backache: 'liver', cervical_spondylosis: 'brain',
  hair_loss: 'skin',
  hyperlipidemia: 'blood', fatty_liver: 'liver', diabetes: 'kidney',
  hyperuricemia: 'kidney', atherosclerosis: 'heart', hypokalemia: 'heart',
  spring_allergy: 'skin', spring_cold: 'lung', spring_rhinitis: 'lung',
  summer_heatstroke: 'brain', summer_diarrhea: 'stomach', summer_rash: 'skin',
  autumn_dryness: 'skin', autumn_cough: 'lung', autumn_cold: 'lung',
  winter_flu: 'lung', winter_pneumonia: 'lung', winter_frostbite: 'skin', winter_rhinitis: 'lung',
  // v6.0 心理 / 内分泌 / 创伤 / 睡眠
  anxiety_disorder: 'heart', panic_disorder: 'heart', social_phobia: 'brain',
  ocd: 'brain', ptsd: 'brain', bipolar: 'brain', sad: 'brain', depression_major: 'brain',
  hyperthyroidism: 'liver', hypothyroidism: 'liver', hormonal_imbalance: 'liver',
  infected_wound: 'skin', concussion: 'brain',
  sleep_disorder: 'brain', circadian_disorder: 'brain',
  // v8.0 菌群 / 过敏类
  dysbiosis: 'stomach', ibs: 'stomach', leaky_gut: 'stomach',
  allergic_rhinitis: 'lung', urticaria: 'skin', asthma: 'lung', anaphylaxis: 'blood',
  // v9.0 爱好劳损类
  tendonitis: 'blood', lumbar_strain: 'blood', dry_eye: 'brain', hobby_burnout: 'brain',
  // v11.0
  sunburn: 'skin', food_poisoning: 'stomach'
};

// ── ② 病原体：决定潜伏期与传染性 ──
const PATHOGEN_TYPES = {
  virus:      { name: '病毒', emoji: '🦠', incubation: 3, contagious: true },
  bacteria:   { name: '细菌', emoji: '🧫', incubation: 2, contagious: true },
  fungus:     { name: '真菌', emoji: '🍄', incubation: 4, contagious: false },
  parasite:   { name: '寄生虫', emoji: '🪱', incubation: 5, contagious: false },
  chronic:    { name: '慢性病灶', emoji: '♻️', incubation: 0, contagious: false },
  functional: { name: '功能失调', emoji: '⚙️', incubation: 0, contagious: false },
  allergen:   { name: '过敏原',   emoji: '🌾', incubation: 0, contagious: false },
  physical:   { name: '物理因素', emoji: '☀️', incubation: 0, contagious: false }
};

// 疾病 → 病原体类型（未列出的：慢性病→chronic，其余→functional）
const DISEASE_PATHOGEN = {
  cold: 'virus', flu: 'virus', cough: 'virus', fever: 'virus', rhinitis: 'virus',
  spring_cold: 'virus', spring_rhinitis: 'virus', autumn_cold: 'virus',
  autumn_cough: 'virus', winter_flu: 'virus', winter_rhinitis: 'virus',
  pharyngitis: 'bacteria', gastroenteritis: 'bacteria', summer_diarrhea: 'bacteria',
  winter_pneumonia: 'bacteria', toothache: 'bacteria',
  mouth_ulcer: 'fungus', summer_rash: 'fungus',
  allergy: 'functional', spring_allergy: 'functional', heatstroke: 'functional',
  summer_heatstroke: 'functional', dehydration: 'functional', malnutrition: 'functional',
  exhaustion: 'functional', insomnia: 'functional', headache: 'functional',
  motion_sickness: 'functional', eyestrain: 'functional', constipation: 'functional',
  hypoglycemia: 'functional', hair_loss: 'functional', subhealth: 'functional',
  anemia: 'functional', autumn_dryness: 'functional', winter_frostbite: 'functional',
  // v8.0：菌群类为细菌失衡，过敏类为过敏原激惹
  dysbiosis: 'bacteria', ibs: 'functional', leaky_gut: 'bacteria',
  allergic_rhinitis: 'allergen', urticaria: 'allergen', asthma: 'allergen', anaphylaxis: 'allergen',
  // v9.0：劳损为慢性无菌性炎症，视疲劳/耗竭为功能失调
  tendonitis: 'chronic', lumbar_strain: 'chronic', dry_eye: 'functional', hobby_burnout: 'functional',
  loneliness: 'functional', anxiety: 'functional',
  depression: 'chronic', hypertension: 'chronic', arthritis: 'chronic', backache: 'chronic',
  cervical_spondylosis: 'chronic', tinnitus: 'chronic', palpitation: 'chronic', neurasthenia: 'chronic',
  // v6.0：心理/内分泌/睡眠多为慢性，创伤/部分心理为功能失调或细菌
  anxiety_disorder: 'chronic', depression_major: 'chronic', bipolar: 'chronic',
  ptsd: 'chronic', ocd: 'chronic', sleep_disorder: 'chronic', circadian_disorder: 'chronic',
  hypothyroidism: 'chronic',
  hyperthyroidism: 'functional', hormonal_imbalance: 'functional',
  panic_disorder: 'functional', social_phobia: 'functional', sad: 'functional',
  infected_wound: 'bacteria', concussion: 'functional',
  // v11.0
  sunburn: 'physical', food_poisoning: 'bacteria'
};

// ── ③ 体质：影响状态衰减速率与疾病易感度 ──
const CONSTITUTIONS = {
  balanced: { name: '平和质', emoji: '⚖️', desc: '阴阳气血调和，体质平和', decayMod: {}, riskMod: {} },
  qixu:     { name: '气虚质', emoji: '🌬️', desc: '容易疲乏气短、说话没力气', decayMod: { energy: 1.4, immunityDecay: 1.3 }, riskMod: { cold: 1.3, subhealth: 1.4, exhaustion: 1.3 } },
  yangxu:   { name: '阳虚质', emoji: '🥶', desc: '怕冷、手脚发凉', decayMod: { comfort: 1.2, securityDecay: 1.2, hungerDecay: 1.1 }, riskMod: { winter_frostbite: 2, winter_rhinitis: 1.5, spring_cold: 1.3, dehydration: 1.2 } },
  yinxu:    { name: '阴虚质', emoji: '🔥', desc: '怕热、易口干烦躁', decayMod: { thirst: 1.5, stressDecay: 1.2 }, riskMod: { autumn_dryness: 1.6, mouth_ulcer: 1.5, insomnia: 1.3 } },
  tanshi:   { name: '痰湿质', emoji: '💧', desc: '容易困倦、身体沉重', decayMod: { fatigue: 1.3, hungerDecay: 1.2 }, riskMod: { hypertension: 1.5, hypoglycemia: 1.3, constipation: 1.3 } },
  shire:    { name: '湿热质', emoji: '🌡️', desc: '易长痘、口苦', decayMod: { comfort: 1.2 }, riskMod: { summer_rash: 1.6, gastroenteritis: 1.3, summer_diarrhea: 1.3 } },
  qiyu:     { name: '气郁质', emoji: '🌧️', desc: '情绪敏感、多愁善感', decayMod: { stress: 1.5, moodDecay: 1.3 }, riskMod: { depression: 1.6, anxiety: 1.6, insomnia: 1.3, loneliness: 1.3 } },
  tebing:   { name: '特禀质', emoji: '🌸', desc: '过敏体质、易打喷嚏', decayMod: {}, riskMod: { allergy: 1.8, spring_allergy: 2, rhinitis: 1.5, spring_rhinitis: 1.5 } }
};

// ── ④ 用药深化：价格 / 副作用 ──
const MEDICINE_PRICE = {
  fever_reducer: 20, cold_medicine: 25, antibiotic: 40, stomach_medicine: 25,
  antianxiety: 35, allergy_medicine: 25, painkiller: 20
};

const MEDICINE_SIDE_EFFECTS = {
  fever_reducer:    [{ key: 'fatigue', delta: 4 }],
  cold_medicine:    [{ key: 'sleep', delta: -4 }, { organ: 'stomach', delta: -1 }],
  antibiotic:       [{ organ: 'stomach', delta: -3 }, { key: 'immunity', delta: -2, chance: 0.6 }],
  stomach_medicine: [{ key: 'hunger', delta: -2 }],
  antianxiety:      [{ key: 'addiction', delta: 5 }, { key: 'mood', delta: -2 }],
  allergy_medicine: [{ key: 'sleep', delta: -3 }],
  painkiller:       [{ key: 'addiction', delta: 3 }, { organ: 'kidney', delta: -2, chance: 0.4 }]
};

// ── ⑤ 医疗经济 ──
const MEDICAL_COST = { exam: 30, blood: 40, cure: 50, hospitalize: 200, vaccine: 60, prescribe: 0, measure: 0, diet_control: 0 };

// ══════════════════════════════════════════════════════════════════════════
//  临床检验指标层（v4.0）
//  血压/心率/呼吸/体温/血氧/血糖/糖化/血脂四项/尿酸/血常规三项/肝功三项/肾功三项/电解质三项/BMI
//  指标是「实时派生」的：基线(生活方式+体重+器官) + 疾病效应(按阶段放大) + 状态效应
//  因此疾病一好，指标自然回落；饮食运动变差，指标逐渐跑偏。
// ══════════════════════════════════════════════════════════════════════════

// 指标定义：range=正常参考范围，critical=显著异常阈值，hard=生理极值
// dir：'low' 表示只有偏低才算异常（如 HDL、血氧）；'both' 为默认双向
const VITAL_INFO = {
  // ── 循环系统 ──
  bpSys:           { name: '收缩压',       short: 'SBP',   unit: 'mmHg',   emoji: '🩸', dec: 0, group: '循环系统', range: [90, 120],    critical: [80, 160],   hard: [50, 260] },
  bpDia:           { name: '舒张压',       short: 'DBP',   unit: 'mmHg',   emoji: '🩸', dec: 0, group: '循环系统', range: [60, 80],     critical: [50, 100],   hard: [30, 160] },
  heartRate:       { name: '心率',         short: 'HR',    unit: '次/分',  emoji: '💓', dec: 0, group: '循环系统', range: [60, 100],    critical: [45, 140],   hard: [30, 220] },
  spo2:            { name: '血氧饱和度',   short: 'SpO₂',  unit: '%',      emoji: '🫁', dec: 1, group: '循环系统', range: [95, 100],    critical: [90, 100],   hard: [60, 100], dir: 'low' },
  // ── 呼吸系统 ──
  respiratoryRate: { name: '呼吸频率',     short: 'RR',    unit: '次/分',  emoji: '🌬️', dec: 0, group: '呼吸系统', range: [12, 20],     critical: [8, 30],     hard: [5, 60] },
  bodyTemp:        { name: '体温',         short: 'T',     unit: '℃',      emoji: '🌡️', dec: 1, group: '呼吸系统', range: [36.0, 37.2], critical: [35.0, 39.0], hard: [33, 43] },
  // ── 代谢 ──
  bloodSugar:      { name: '空腹血糖',     short: 'GLU',   unit: 'mmol/L', emoji: '🍬', dec: 2, group: '代谢', range: [3.9, 6.1],  critical: [3.0, 11.1], hard: [1.5, 35] },
  hba1c:           { name: '糖化血红蛋白', short: 'HbA1c', unit: '%',      emoji: '🩸', dec: 2, group: '代谢', range: [4.0, 6.0],  critical: [3.5, 8.5],  hard: [3, 18] },
  bmi:             { name: '体质指数',     short: 'BMI',   unit: 'kg/m²',  emoji: '⚖️', dec: 1, group: '代谢', range: [18.5, 24.0], critical: [14, 28],    hard: [10, 60] },
  weight:          { name: '体重',         short: 'WT',    unit: 'kg',     emoji: '🏋️', dec: 1, group: '代谢', range: [45, 68],     critical: [30, 120],   hard: [20, 200], noAlert: true },
  // ── 血脂四项 ──
  cholesterol:     { name: '总胆固醇',     short: 'TC',    unit: 'mmol/L', emoji: '🧈', dec: 2, group: '血脂', range: [2.8, 5.2],  critical: [2.0, 8.0],  hard: [1, 20] },
  triglyceride:    { name: '甘油三酯',     short: 'TG',    unit: 'mmol/L', emoji: '🧈', dec: 2, group: '血脂', range: [0.4, 1.7],  critical: [0.3, 5.6],  hard: [0.1, 30] },
  hdl:             { name: '高密度脂蛋白', short: 'HDL-C', unit: 'mmol/L', emoji: '🛡️', dec: 2, group: '血脂', range: [1.0, 2.0],  critical: [0.6, 2.6],  hard: [0.2, 4], dir: 'low' },
  ldl:             { name: '低密度脂蛋白', short: 'LDL-C', unit: 'mmol/L', emoji: '⚠️', dec: 2, group: '血脂', range: [1.5, 3.4],  critical: [1.0, 5.0],  hard: [0.3, 15] },
  // ── 血常规 ──
  hemoglobin:      { name: '血红蛋白',     short: 'HGB',   unit: 'g/L',    emoji: '🩸', dec: 0, group: '血常规', range: [115, 150],  critical: [70, 180],   hard: [30, 230] },
  wbc:             { name: '白细胞',       short: 'WBC',   unit: '×10⁹/L', emoji: '🦠', dec: 2, group: '血常规', range: [4.0, 10.0], critical: [2.0, 20.0], hard: [0.5, 60] },
  platelet:        { name: '血小板',       short: 'PLT',   unit: '×10⁹/L', emoji: '🧫', dec: 0, group: '血常规', range: [125, 350],  critical: [50, 600],   hard: [10, 900] },
  // ── 肝功能 ──
  alt:             { name: '谷丙转氨酶',   short: 'ALT',   unit: 'U/L',    emoji: '🫀', dec: 0, group: '肝功能', range: [7, 40],     critical: [5, 200],    hard: [2, 900] },
  ast:             { name: '谷草转氨酶',   short: 'AST',   unit: 'U/L',    emoji: '🫀', dec: 0, group: '肝功能', range: [13, 35],    critical: [8, 200],    hard: [2, 900] },
  albumin:         { name: '白蛋白',       short: 'ALB',   unit: 'g/L',    emoji: '🥚', dec: 1, group: '肝功能', range: [40, 55],    critical: [25, 60],    hard: [15, 70] },
  // ── 肾功能 ──
  creatinine:      { name: '肌酐',         short: 'Cr',    unit: 'μmol/L', emoji: '🫘', dec: 0, group: '肾功能', range: [44, 97],    critical: [30, 400],   hard: [20, 1200] },
  bun:             { name: '尿素氮',       short: 'BUN',   unit: 'mmol/L', emoji: '🫘', dec: 1, group: '肾功能', range: [2.9, 7.1],  critical: [1.5, 20],   hard: [1, 60] },
  uricAcid:        { name: '血尿酸',       short: 'UA',    unit: 'μmol/L', emoji: '🦶', dec: 0, group: '肾功能', range: [155, 420],  critical: [100, 700],  hard: [50, 1200] },
  // ── 电解质 ──
  potassium:       { name: '血钾',         short: 'K⁺',    unit: 'mmol/L', emoji: '⚡', dec: 2, group: '电解质', range: [3.5, 5.3],  critical: [2.8, 6.5],  hard: [1.5, 9] },
  sodium:          { name: '血钠',         short: 'Na⁺',   unit: 'mmol/L', emoji: '🧂', dec: 1, group: '电解质', range: [137, 147],  critical: [125, 155],  hard: [100, 190] },
  calcium:         { name: '血钙',         short: 'Ca²⁺',  unit: 'mmol/L', emoji: '🦴', dec: 2, group: '电解质', range: [2.11, 2.52], critical: [1.8, 3.0], hard: [1.2, 4] },
  // ── 炎症 / 免疫（v14.0）——
  crp:             { name: 'C反应蛋白',    short: 'CRP',   unit: 'mg/L',   emoji: '🔥', dec: 2, group: '炎症免疫', range: [0, 5],      critical: [0, 50],    hard: [0, 200],    dir: 'high' },
  esr:             { name: '血沉',         short: 'ESR',   unit: 'mm/h',   emoji: '📈', dec: 1, group: '炎症免疫', range: [0, 15],     critical: [0, 60],    hard: [0, 120],    dir: 'high' },
  immunoglobulin:  { name: '免疫球蛋白',   short: 'Ig',    unit: 'g/L',    emoji: '🛡️', dec: 2, group: '炎症免疫', range: [7, 16],     critical: [3, 25],    hard: [1, 40] },
  // ── 内分泌（v14.0）——
  tsh:             { name: '促甲状腺激素', short: 'TSH',   unit: 'mIU/L',  emoji: '🦋', dec: 2, group: '内分泌', range: [0.27, 4.2], critical: [0.1, 10],   hard: [0.01, 30] },
  cortisol:        { name: '皮质醇',       short: 'COR',   unit: 'nmol/L', emoji: '😰', dec: 1, group: '内分泌', range: [100, 350],  critical: [50, 700],  hard: [0, 1500] },
  insulin:         { name: '空腹胰岛素',   short: 'INS',   unit: 'μIU/mL', emoji: '💉', dec: 2, group: '内分泌', range: [2.6, 24.9], critical: [1, 50],    hard: [0, 200] },
  // ── 凝血（v14.0）——
  inr:             { name: '凝血酶原国际比值', short: 'INR', unit: '',     emoji: '🩸', dec: 2, group: '凝血', range: [0.8, 1.2],  critical: [0.6, 3.0],  hard: [0.3, 8] },
  dDimer:          { name: 'D-二聚体',     short: 'D-D',   unit: 'mg/L',   emoji: '🕸️', dec: 2, group: '凝血', range: [0, 0.5],    critical: [0, 2.0],   hard: [0, 10],     dir: 'high' },
  // ── 尿液（v14.0）——
  urineProtein:    { name: '尿蛋白',       short: 'PRO',   unit: 'mg/24h', emoji: '🚽', dec: 0, group: '尿液', range: [0, 150],    critical: [0, 1000],  hard: [0, 5000],   dir: 'high' },
  urineGlucose:    { name: '尿糖',         short: 'GLU-U', unit: 'mmol/L', emoji: '🍬', dec: 1, group: '尿液', range: [0, 0.8],    critical: [0, 5.5],   hard: [0, 50],     dir: 'high' }
};

// ── 疾病 → 指标偏移表（按疾病阶段放大：初期×1 / 中期×1.5 / 晚期×2.1 / 危重×2.8）──
const DISEASE_VITAL_EFFECTS = {
  // 感染 / 发热类
  fever:            { bodyTemp: 1.0, heartRate: 14, wbc: 2.5, respiratoryRate: 3 },
  flu:              { bodyTemp: 1.3, heartRate: 18, wbc: 3.0, respiratoryRate: 4 },
  cold:             { bodyTemp: 0.5, heartRate: 8, wbc: 2.0, respiratoryRate: 2 },
  cough:            { heartRate: 4, respiratoryRate: 3, spo2: -1 },
  winter_flu:       { bodyTemp: 1.4, heartRate: 20, wbc: 3.5, respiratoryRate: 4 },
  winter_pneumonia: { bodyTemp: 1.5, heartRate: 22, wbc: 5.5, respiratoryRate: 6, spo2: -3.5 },
  heatstroke:       { bodyTemp: 1.2, heartRate: 16, sodium: -4, potassium: -0.3 },
  summer_heatstroke:{ bodyTemp: 1.7, heartRate: 24, sodium: -6, potassium: -0.5, wbc: 2 },
  pharyngitis:      { bodyTemp: 0.4, wbc: 3.5, heartRate: 6 },
  gastroenteritis:  { bodyTemp: 0.5, wbc: 3.0, potassium: -0.5, sodium: -4, heartRate: 8 },
  summer_diarrhea:  { bodyTemp: 0.6, wbc: 3.2, potassium: -0.8, sodium: -6, creatinine: 12, heartRate: 10 },
  toothache:        { wbc: 2.5, heartRate: 5 },
  mouth_ulcer:      { wbc: 1.5 },
  summer_rash:      { wbc: 1.0 },
  allergy:          { wbc: 1.0 },
  rhinitis:         { wbc: 0.8 },
  spring_cold:      { bodyTemp: 0.6, heartRate: 9, wbc: 2.2 },
  spring_rhinitis:  { wbc: 1.2 },
  spring_allergy:   { wbc: 0.8 },
  autumn_cold:      { bodyTemp: 0.7, heartRate: 10, wbc: 2.4 },
  autumn_cough:     { heartRate: 5, respiratoryRate: 3 },
  winter_rhinitis:  { wbc: 1.2 },
  winter_frostbite: { bodyTemp: -0.6, spo2: -1, heartRate: 4 },
  // 脱水 / 电解质紊乱
  dehydration:      { sodium: -5, potassium: -0.4, creatinine: 14, bun: 1.8, hemoglobin: 6, bpSys: -8, bpDia: -5, heartRate: 12 },
  hypokalemia:      { potassium: -1.1, heartRate: 14, bpSys: -6 },
  // 血液
  anemia:           { hemoglobin: -38, heartRate: 10, spo2: -2, bpSys: -6 },
  // 代谢 / 内分泌
  hypoglycemia:     { bloodSugar: -1.6, heartRate: 12, potassium: -0.3 },
  hypertension:     { bpSys: 26, bpDia: 14, heartRate: 6, creatinine: 8 },
  hyperlipidemia:   { cholesterol: 2.2, triglyceride: 2.1, ldl: 1.6, hdl: -0.35 },
  diabetes:         { bloodSugar: 5.2, hba1c: 2.4, triglyceride: 1.2, creatinine: 8 },
  hyperuricemia:    { uricAcid: 220, creatinine: 10 },
  fatty_liver:      { alt: 45, ast: 32, triglyceride: 1.1, cholesterol: 0.7 },
  atherosclerosis:  { bpSys: 12, cholesterol: 1.0, ldl: 0.9, hdl: -0.2 },
  // 心肺 / 精神
  palpitation:      { heartRate: 18, bpSys: 5 },
  headache:         { bpSys: 6 },
  insomnia:         { bpSys: 4, heartRate: 5 },
  neurasthenia:     { bpSys: 4, heartRate: 4 },
  anxiety:          { heartRate: 12, bpSys: 6, respiratoryRate: 2 },
  depression:       { heartRate: -3 },
  exhaustion:       { heartRate: 6, bpSys: -3 },
  motion_sickness:  { heartRate: 8 },
  cervical_spondylosis: { bpSys: 5 },
  // 营养 / 肝肾
  malnutrition:     { albumin: -7, hemoglobin: -20, wbc: -1.2 },
  subhealth:        { hemoglobin: -5, wbc: -0.5 },
  arthritis:        { wbc: 0.8 },
  // v6.0 心理 / 内分泌 / 睡眠 / 创伤
  anxiety_disorder:     { heartRate: 14, bpSys: 8, respiratoryRate: 3 },
  panic_disorder:       { heartRate: 22, bpSys: 12, respiratoryRate: 5 },
  social_phobia:        { heartRate: 10, bpSys: 5 },
  ocd:                  { heartRate: 6, bpSys: 3 },
  ptsd:                 { heartRate: 10, bpSys: 6 },
  bipolar:              { heartRate: 8, bpSys: 5 },
  sad:                  { heartRate: -2, bloodSugar: 0.4 },
  depression_major:     { heartRate: -4, bpSys: -3 },
  hyperthyroidism:      { heartRate: 20, bodyTemp: 0.5, cholesterol: -0.6 },
  hypothyroidism:       { heartRate: -8, cholesterol: 1.2, hemoglobin: -8 },
  hormonal_imbalance:   { bpSys: 6, bloodSugar: 0.6, heartRate: 4 },
  infected_wound:       { wbc: 4.5, bodyTemp: 0.8, heartRate: 12 },
  concussion:           { bpSys: -4, heartRate: 4 },
  sleep_disorder:       { bpSys: 6, heartRate: 6 },
  circadian_disorder:   { bpSys: 4, bloodSugar: 0.5, heartRate: 4 },
  // v8.0 菌群类（吸收不良→白蛋白与血红蛋白下滑、低度炎症→白细胞微升）
  dysbiosis:            { albumin: -1.5, hemoglobin: -3, wbc: 0.8 },
  ibs:                  { albumin: -1.0, potassium: -0.15 },
  leaky_gut:            { albumin: -2.0, wbc: 1.2 },
  // v8.0 过敏类
  allergic_rhinitis:    { wbc: 1.5 },
  urticaria:            { wbc: 1.8 },
  asthma:               { respiratoryRate: 6, heartRate: 10, bpSys: -3 },
  anaphylaxis:          { bpSys: -25, bpDia: -15, heartRate: 35, respiratoryRate: 10, wbc: 3 },
  // v9.0 爱好劳损类（无菌性炎症 → 白细胞微升；耗竭 → 心率与血压轻度上浮）
  tendonitis:           { wbc: 0.9, bodyTemp: 0.3 },
  lumbar_strain:        { wbc: 1.0, bpSys: 3 },
  dry_eye:              { bpSys: 2 },
  hobby_burnout:        { heartRate: 5, bpSys: 4, bloodSugar: 0.3 },
  // v11.0 日常生活（晒伤 → 疼痛应激；急性肠胃炎 → 脱水致血压下滑、心率代偿上升）
  sunburn:              { heartRate: 6, bodyTemp: 0.4, wbc: 0.6 },
  food_poisoning:       { bpSys: -12, bpDia: -8, heartRate: 18, wbc: 3.2, bodyTemp: 0.7, potassium: -0.25 }
};

// v14.0：为已有疾病补上新指标效应（感染/炎症/内分泌/凝血/尿液）
(function patchDiseaseVitalEffects() {
  const patch = {
    // 感染 / 发热 → CRP / ESR
    fever: { crp: 12, esr: 8 }, flu: { crp: 18, esr: 15 }, cold: { crp: 6, esr: 5 },
    cough: { crp: 4, esr: 3 }, winter_flu: { crp: 25, esr: 20 },
    winter_pneumonia: { crp: 45, esr: 35 }, pharyngitis: { crp: 8, esr: 6 },
    gastroenteritis: { crp: 15, esr: 12 }, summer_diarrhea: { crp: 18, esr: 14 },
    toothache: { crp: 6, esr: 4 }, mouth_ulcer: { crp: 4, esr: 3 },
    summer_rash: { crp: 3, esr: 3 }, allergy: { crp: 2, esr: 2 },
    rhinitis: { crp: 2, esr: 2 }, spring_cold: { crp: 7, esr: 6 },
    spring_rhinitis: { crp: 3, esr: 3 }, spring_allergy: { crp: 2, esr: 2 },
    autumn_cold: { crp: 8, esr: 7 }, autumn_cough: { crp: 4, esr: 3 },
    winter_rhinitis: { crp: 3, esr: 3 }, winter_frostbite: { crp: 3, esr: 2 },
    // 炎症 / 创伤
    infected_wound: { crp: 28, esr: 22, dDimer: 0.35 },
    tendonitis: { crp: 5, esr: 4 }, lumbar_strain: { crp: 4, esr: 3 },
    sunburn: { crp: 3, esr: 2 }, food_poisoning: { crp: 16, esr: 12 },
    anaphylaxis: { crp: 35, esr: 25, dDimer: 0.45 },
    // 代谢 / 内分泌
    diabetes: { insulin: 18, urineGlucose: 2.5, crp: 4 },
    hyperlipidemia: { insulin: 8, crp: 3 },
    fatty_liver: { insulin: 10, crp: 4, esr: 3 },
    hypertension: { urineProtein: 80, cortisol: 45 },
    hyperuricemia: { urineProtein: 25 },
    // 心理 / 神经 → 皮质醇
    anxiety: { cortisol: 55 }, anxiety_disorder: { cortisol: 90, esr: 4 },
    panic_disorder: { cortisol: 110 }, social_phobia: { cortisol: 60 },
    ocd: { cortisol: 50 }, ptsd: { cortisol: 85, dDimer: 0.2 },
    bipolar: { cortisol: 40 }, sad: { cortisol: 25 },
    insomnia: { cortisol: 35 }, sleep_disorder: { cortisol: 55 },
    neurasthenia: { cortisol: 30 }, circadian_disorder: { cortisol: 35 },
    depression: { cortisol: -30 }, depression_major: { cortisol: -45 },
    // 肝肾 / 血液 / 凝血
    fatty_liver: { inr: 0.18 },
    anemia: { immunoglobulin: -1.5 }, malnutrition: { immunoglobulin: -2.5, inr: 0.1 },
    // 如果有关节炎等慢性炎症
    arthritis: { crp: 8, esr: 12 },
    // 甲状腺
    hyperthyroidism: { tsh: -1.8, cortisol: 20 }, hypothyroidism: { tsh: 4.5, cortisol: -15, esr: 5 }
  };
  for (const [d, vals] of Object.entries(patch)) {
    if (!DISEASE_VITAL_EFFECTS[d]) DISEASE_VITAL_EFFECTS[d] = {};
    for (const [k, v] of Object.entries(vals)) DISEASE_VITAL_EFFECTS[d][k] = v;
  }
})();

// —— 指标辅助 ——

// 指标分级（正常 / 偏低 / 显著偏低 / 偏高 / 显著偏高）
function getVitalLevel(key, value) {
  const info = VITAL_INFO[key];
  if (!info) return '正常';
  const v = Number(value);
  if (!Number.isFinite(v)) return '正常';
  const [lo, hi] = info.range;
  const [clo, chi] = info.critical;
  const dir = info.dir || 'both';
  if (dir !== 'high' && v < lo) return v < clo ? '显著偏低' : '偏低';
  if (dir !== 'low' && v > hi) return v > chi ? '显著偏高' : '偏高';
  return '正常';
}

function getVitalInfo(key) { return VITAL_INFO[key] || { name: key, short: key, unit: '', dec: 0, group: '其他' }; }

function formatVitalValue(info, value) {
  const v = Number(value);
  return Number.isFinite(v) ? v.toFixed(info.dec || 0) : '—';
}

// 派生全部检验指标
function computeVitals() {
  const num = (k, d) => { const n = Number(healthState[k]); return Number.isFinite(n) ? n : d; };
  const diet = num('diet', 65), ex = num('exercise', 60), sq = num('sleepQuality', 70);
  const dietP = Math.max(0, (75 - diet) / 75);   // 饮食不良程度 0~1
  const malP = Math.min(1, dietP * 0.7 + Math.max(0, (num('bmi', 21) - 24) / 15) * 0.3); // 营养不良/代谢不良综合指数
  const exP = Math.max(0, (70 - ex) / 70);       // 缺乏运动程度 0~1
  const sqP = Math.max(0, (70 - sq) / 70);       // 睡眠不良程度 0~1
  const weight = num('weight', 58);
  const height = num('height', 165) > 0 ? num('height', 165) : 165;
  const bmi = weight / Math.pow(height / 100, 2);
  const bmiP = Math.max(0, (bmi - 23) / 12);     // 超重程度 0~1
  const stressP = Math.max(0, (70 - num('stress', 80)) / 70);
  const fever = Math.max(0, num('fever', 0));
  const addP = Math.max(0, num('addiction', 0) - 40) / 60;
  const orgP = (k) => Math.max(0, 100 - getOrgan(k)) / 100; // 器官损伤 0~1

  const dis = Array.isArray(healthState.diseases) ? healthState.diseases : [];
  const infectCount = dis.filter(d => ['virus', 'bacteria', 'fungus', 'parasite'].includes(getPathogen(d))).length;

  // 疾病效应（按阶段放大）
  const stageMul = { '初期': 1, '中期': 1.5, '晚期': 2.1, '危重': 2.8 };
  const eff = {};
  for (const d of dis) {
    const tbl = DISEASE_VITAL_EFFECTS[d];
    if (!tbl) continue;
    const m = stageMul[getDiseaseStage(d)] || 1;
    for (const [k, delta] of Object.entries(tbl)) eff[k] = (eff[k] || 0) + delta * m;
  }
  // v5.0：环境（天气/气温/空气质量）与营养素摄入也计入效应
  for (const [k, v] of Object.entries(getEnvVitalEffects())) eff[k] = (eff[k] || 0) + v;
  for (const [k, v] of Object.entries(getNutrientVitalEffects())) eff[k] = (eff[k] || 0) + v;
  const E = (k) => eff[k] || 0;

  const out = {};
  out.bpSys = 106 + exP * 12 + dietP * 7 + bmiP * 14 + stressP * 9 + sqP * 3 + orgP('heart') * 12 + addP * 5 + E('bpSys');
  out.bpDia = 66 + exP * 7 + dietP * 4 + bmiP * 8 + stressP * 5 + orgP('heart') * 7 + addP * 3 + E('bpDia');
  out.heartRate = 66 + exP * 10 + stressP * 12 + fever * 0.25 + orgP('heart') * 14 + addP * 8 + E('heartRate');
  out.spo2 = 98.6 - orgP('lung') * 9 - orgP('heart') * 3 + E('spo2');
  out.respiratoryRate = 15 + fever * 0.06 + orgP('lung') * 7 + E('respiratoryRate');
  out.bodyTemp = 36.5 + fever / 100 * 2.5 + E('bodyTemp');
  out.bloodSugar = 4.8 + dietP * 1.1 + bmiP * 1.7 - Math.max(0, (ex - 75) / 75) * 0.5 + E('bloodSugar');
  out.hba1c = 4.6 + (out.bloodSugar - 4.9) * 0.55 + E('hba1c');
  out.cholesterol = 4.1 + dietP * 1.6 + exP * 0.7 + bmiP * 0.9 + E('cholesterol');
  out.triglyceride = 1.0 + dietP * 1.5 + bmiP * 1.2 + exP * 0.4 + E('triglyceride');
  out.hdl = 1.6 - exP * 0.6 - bmiP * 0.3 + Math.max(0, (ex - 80) / 80) * 0.25 + E('hdl');
  out.ldl = 2.3 + dietP * 1.2 + exP * 0.5 + bmiP * 0.7 + E('ldl');
  out.uricAcid = 300 + dietP * 130 + bmiP * 60 + orgP('kidney') * 70 + E('uricAcid');
  out.hemoglobin = 138 - orgP('blood') * 48 - orgP('kidney') * 14 + E('hemoglobin');
  out.wbc = 6.2 + infectCount * 1.6 + orgP('blood') * 1.5 + E('wbc');
  out.platelet = 230 - orgP('blood') * 45 + infectCount * 8 + E('platelet');
  out.alt = 21 + orgP('liver') * 95 + E('alt');
  out.ast = 19 + orgP('liver') * 85 + E('ast');
  out.albumin = 44 - orgP('liver') * 13 + E('albumin');
  out.creatinine = 72 + orgP('kidney') * 190 + E('creatinine');
  out.bun = 4.4 + orgP('kidney') * 9 + E('bun');
  out.potassium = 4.15 + E('potassium');
  out.sodium = 141 + E('sodium');
  out.calcium = 2.32 + E('calcium');

  // v14.0：炎症 / 免疫 / 内分泌 / 凝血 / 尿液指标
  const injuryCount = Array.isArray(healthState.injuries) ? healthState.injuries.length : 0;
  const inflammatoryLoad = infectCount + injuryCount + Math.max(0, num('allergyLoad', 0)) / 40;
  // CRP：基线近 0，感染/创伤/自身免疫反应时上升
  out.crp = 0.4 + inflammatoryLoad * 2.8 + orgP('liver') * 8 + E('crp');
  if (out.crp < 0.05) out.crp = 0.05;
  // ESR：女性/贫血时更高，随炎症与年龄升高
  out.esr = 2 + inflammatoryLoad * 3.5 + (100 - out.hemoglobin) / 12 + Math.max(0, (num('age', 20) - 35)) * 0.15 + E('esr');
  // 免疫球蛋白：营养不良 ↓，慢性感染/自身免疫 ↑
  out.immunoglobulin = 11.5 - malP * 3.5 + infectCount * 0.8 + orgP('liver') * (-2) + E('immunoglobulin');
  // TSH：压力大 ↑，缺觉 ↑，碘/运动/甲状腺疾病影响
  out.tsh = 2.2 + (100 - num('stress', 80)) / 55 + num('sleepDebt', 0) / 55 + bmiP * 0.6 + E('tsh');
  // 皮质醇：stress 是「高=无压力」，所以 (100 - stress) 才是压力负荷；焦虑、缺觉、咖啡因均推高
  out.cortisol = 220 + (100 - num('stress', 80)) * 1.6 + num('anxiety', 0) * 1.2 + num('sleepDebt', 0) * 0.9 + num('caffeine', 0) * 1.1 + E('cortisol');
  // 空腹胰岛素：BMI 与血糖主导；运动改善
  out.insulin = 8 + bmiP * 22 + (out.bloodSugar - 5.0) * 2.4 - Math.max(0, (ex - 70) / 70) * 4 + E('insulin');
  if (out.insulin < 1.5) out.insulin = 1.5;
  // INR：肝功能差 / 营养不良 ↑；VK 摄入（diet 高）略降
  out.inr = 1.0 + orgP('liver') * 0.55 + malP * 0.25 - (diet - 60) / 500 + E('inr');
  // D-二聚体：久坐不动、创伤、感染、手术后（用 injCount 近似）↑
  const immobileP = Math.max(0, (70 - ex) / 70);
  out.dDimer = 0.08 + immobileP * 0.35 + injuryCount * 0.22 + infectCount * 0.18 + E('dDimer');
  // 尿蛋白：肾损与高血压主导
  out.urineProtein = 30 + orgP('kidney') * 700 + (out.bpSys - 120) * 2.5 + E('urineProtein');
  // 尿糖：血糖超过肾糖阈（≈8.9）时出现
  out.urineGlucose = out.bloodSugar > 8.9 ? (out.bloodSugar - 8.9) * 1.6 + E('urineGlucose') : 0 + E('urineGlucose');

  out.bmi = bmi;
  out.weight = weight;

  // 生理极值截断 + 按精度取位
  for (const [k, info] of Object.entries(VITAL_INFO)) {
    let v = Number(out[k]);
    if (!Number.isFinite(v)) v = info.range[0];
    const [hlo, hhi] = info.hard || [-Infinity, Infinity];
    v = Math.max(hlo, Math.min(hhi, v));
    const p = Math.pow(10, info.dec || 0);
    out[k] = Math.round(v * p) / p;
  }
  return out;
}

// 异常指标列表
function getAbnormalVitals(v) {
  const vals = v || computeVitals();
  const out = [];
  for (const [k, info] of Object.entries(VITAL_INFO)) {
    if (info.noAlert) continue;
    const level = getVitalLevel(k, vals[k]);
    if (level === '正常') continue;
    out.push({ key: k, info, value: vals[k], level, severe: level.startsWith('显著') });
  }
  return out;
}

// 指标总评（0-100，扣分制）
function getVitalScore(v) {
  const vals = v || computeVitals();
  let score = 100;
  for (const [k, info] of Object.entries(VITAL_INFO)) {
    if (info.noAlert) continue;
    const lv = getVitalLevel(k, vals[k]);
    if (lv === '显著偏高' || lv === '显著偏低') score -= 4;
    else if (lv !== '正常') score -= 1.5;
  }
  return Math.max(0, Math.round(score));
}

// 生成检验指标报告文本
function generateVitalsReport(opts = {}) {
  const onlyAbnormal = opts.onlyAbnormal === true;
  const vals = opts.vitals || computeVitals();
  const groups = {};
  for (const [k, info] of Object.entries(VITAL_INFO)) {
    const level = getVitalLevel(k, vals[k]);
    if (onlyAbnormal && level === '正常') continue;
    if (!groups[info.group]) groups[info.group] = [];
    groups[info.group].push({ info, level, value: vals[k] });
  }
  const lines = [];
  for (const [g, items] of Object.entries(groups)) {
    if (!items.length) continue;
    lines.push(`【${g}】`);
    for (const it of items) {
      const flag = it.level === '正常' ? '✅' : (it.level.startsWith('显著') ? '🚨' : '⚠️');
      lines.push(`  ${flag} ${it.info.name}(${it.info.short})：${formatVitalValue(it.info, it.value)} ${it.info.unit}　${it.level}`);
    }
  }
  return lines.join('\n');
}

// 异常指标 → 反向加重身体负担（返回健康衰减、额外器官损伤与告警）
function applyVitalImpact(v) {
  const vals = v || computeVitals();
  const out = { healthDecay: 0, organs: {}, severe: [] };
  const lv = (k) => getVitalLevel(k, vals[k]);
  const sv = (k) => lv(k).startsWith('显著');
  const bump = (h, o) => {
    out.healthDecay += h;
    for (const [k, d] of Object.entries(o || {})) out.organs[k] = (out.organs[k] || 0) + d;
  };

  if (sv('bpSys') || sv('bpDia')) { bump(1.6, { heart: 0.35 }); out.severe.push('血压'); }
  else if (lv('bpSys') !== '正常' || lv('bpDia') !== '正常') bump(0.5, { heart: 0.12 });

  if (sv('cholesterol') || sv('triglyceride') || sv('ldl')) { bump(0.9, { heart: 0.3 }); out.severe.push('血脂'); }
  else if (lv('cholesterol') !== '正常' || lv('triglyceride') !== '正常' || lv('ldl') !== '正常') bump(0.3, { heart: 0.1 });

  if (sv('bloodSugar')) { bump(1.1, { kidney: 0.28, blood: 0.2 }); out.severe.push('血糖'); }
  else if (lv('bloodSugar') !== '正常') bump(0.35, { kidney: 0.1 });

  if (sv('uricAcid')) { bump(0.4, { kidney: 0.35 }); out.severe.push('尿酸'); }
  if (sv('alt') || sv('ast')) { bump(0.7, { liver: 0.3 }); out.severe.push('肝功'); }
  if (sv('creatinine') || sv('bun')) { bump(0.7, { kidney: 0.3 }); out.severe.push('肾功'); }
  if (sv('spo2') || sv('hemoglobin')) { bump(0.9); out.severe.push('血氧/血红蛋白'); }
  else if (lv('spo2') !== '正常' || lv('hemoglobin') !== '正常') bump(0.3);
  if (lv('potassium') !== '正常') { bump(0.6); out.severe.push('血钾'); }
  if (lv('sodium') !== '正常') bump(0.5);
  if (sv('wbc')) bump(0.6);
  // v14.0：新增指标对身体的反馈
  if (sv('crp') || sv('esr')) { bump(0.7, { blood: 0.15 }); out.severe.push('炎症标志物'); }
  else if (lv('crp') !== '正常' || lv('esr') !== '正常') bump(0.25);
  if (sv('urineProtein')) { bump(1.0, { kidney: 0.4 }); out.severe.push('蛋白尿'); }
  else if (lv('urineProtein') !== '正常') bump(0.35, { kidney: 0.12 });
  if (sv('urineGlucose')) { bump(0.6, { kidney: 0.12, blood: 0.1 }); out.severe.push('尿糖'); }
  if (sv('cortisol')) { bump(0.5, { brain: 0.15 }); out.severe.push('皮质醇显著异常'); }
  else if (lv('cortisol') !== '正常') bump(0.2);
  if (sv('inr')) { bump(0.7); out.severe.push('凝血功能异常'); }
  if (sv('dDimer')) { bump(0.6, { blood: 0.1 }); out.severe.push('D-二聚体高'); }
  if (sv('insulin')) { bump(0.5, { blood: 0.1 }); out.severe.push('高胰岛素血症'); }
  // 没有单项显著异常、但轻度异常一大堆时，也要给出关注标记
  if (!out.severe.length) {
    const mild = getAbnormalVitals(vals);
    if (mild.length >= 4) out.severe.push(`多项轻度异常(${mild.length})`);
  }
  return out;
}

// 异常指标 → 对话情绪提示
function getVitalHint(v) {
  const vals = v || computeVitals();
  const all = getAbnormalVitals(vals);
  if (!all.length) return '';
  const severe = all.filter(x => x.severe);
  // 优先报显著异常；没有显著异常但轻度异常 ≥3 项时也提示（身体在走下坡路）
  const bad = severe.length ? severe : (all.length >= 3 ? all : []);
  if (!bad.length) return '';
  const map = {
    bpSys: '头晕、太阳穴突突跳', bpDia: '头晕、胸口发闷', heartRate: '心慌、心跳得厉害',
    spo2: '喘不上气、眼前发黑', respiratoryRate: '呼吸有点急', bodyTemp: '浑身发烫又发冷',
    bloodSugar: '口干、总想喝水', hba1c: '容易累、老是口渴', cholesterol: '血液黏稠、胸口闷',
    triglyceride: '肚子沉、容易困', hdl: '血管不太有弹性', ldl: '心口发紧',
    hemoglobin: '脸色差、一动就累', wbc: '身上在发炎、没精神', platelet: '容易淤青',
    alt: '右上腹不舒服', ast: '右上腹隐隐作痛', albumin: '有点浮肿、没力气',
    creatinine: '腰酸、尿少', bun: '腰酸、水肿', uricAcid: '关节隐隐作痛',
    potassium: '四肢发软、心慌', sodium: '头晕、没力气', calcium: '手脚发麻、抽筋',
    bmi: '身体沉、走两步就喘',
    crp: '浑身没劲、像在发烧', esr: '身体沉重、恢复得慢', immunoglobulin: '容易生病、反复感染',
    tsh: '精神萎靡或亢奋不对劲', cortisol: '情绪紧绷、睡不好也吃不下', insulin: '肚子饿得快、餐后犯困',
    inr: '牙龈出血或容易淤青', dDimer: '腿肿胸闷、担心血栓', urineProtein: '尿里泡沫多、腰酸',
    urineGlucose: '尿多口渴、老想喝水'
  };
  const texts = [...new Set(bad.map(x => map[x.key]).filter(Boolean))].slice(0, 3);
  if (!texts.length) return '';
  const names = bad.map(x => `${x.info.name}${x.level}`).join('、');
  return `【检验异常】你的化验指标有问题（${names}），你觉得${texts.join('、')}。请自然地在对话中体现身体不适，但不要直接报出数值。`;
}

// —— 生活方式（影响检验指标）——
function getLifestyleInfo() {
  const num = (k, d) => { const n = Number(healthState[k]); return Number.isFinite(n) ? n : d; };
  const lvl = (v) => v >= 80 ? '优秀' : v >= 60 ? '良好' : v >= 40 ? '一般' : v >= 20 ? '较差' : '很差';
  const w = num('weight', 58), h = num('height', 165) > 0 ? num('height', 165) : 165;
  return {
    diet: { name: '饮食', emoji: '🥗', value: Math.round(num('diet', 65)), level: lvl(num('diet', 65)) },
    exercise: { name: '运动', emoji: '🏃', value: Math.round(num('exercise', 60)), level: lvl(num('exercise', 60)) },
    sleepQuality: { name: '睡眠质量', emoji: '😴', value: Math.round(num('sleepQuality', 70)), level: lvl(num('sleepQuality', 70)) },
    weight: { name: '体重', emoji: '⚖️', value: Number(w.toFixed(1)), level: `${h}cm` },
    bmi: { name: 'BMI', emoji: '⚖️', value: Number((w / Math.pow(h / 100, 2)).toFixed(1)), level: getVitalLevel('bmi', w / Math.pow(h / 100, 2)) }
  };
}

function adjustLifestyle(key, delta) {
  const cur = Number(healthState[key]);
  const base = Number.isFinite(cur) ? cur : 60;
  healthState[key] = Math.max(0, Math.min(100, base + delta));
  return healthState[key];
}

// ══════════════════════════════════════════════════════════════════════════
//  环境 / 医疗体系 / 遗传 / 营养（v5.0）
//   环境：天气·气温·湿度·空气质量·紫外线 → 反过来影响检验指标与疾病易感
//   医疗：不同等级医院/医生水平 → 影响确诊率、治愈率与费用
//   遗传：家族病史 → 对应疾病易感度显著上升
//   营养：八大营养素摄入合理度 → 影响血常规/肝功/电解质/血压/血糖等指标
// ══════════════════════════════════════════════════════════════════════════

function clampInt(v, lo, hi) { return Math.max(lo, Math.min(hi, Math.round(v))); }
function roundTo(v, d) { const p = Math.pow(10, d); return Math.round(v * p) / p; }

// 开关（读配置，默认开启）
function envOn() { try { return cfg()?.envEnabled !== false; } catch { return true; } }
function familyOn() { try { return cfg()?.familyHistoryEnabled !== false; } catch { return true; } }
function injuryOn() { try { return cfg()?.injuryEnabled !== false; } catch { return true; } }
function epidemicOn() { try { return cfg()?.epidemicEnabled !== false; } catch { return true; } }
function habitOn() { try { return cfg()?.habitEnabled !== false; } catch { return true; } }
function achievementOn() { try { return cfg()?.achievementEnabled !== false; } catch { return true; } }
function agingOn() { try { return cfg()?.agingEnabled !== false; } catch { return true; } }

// —— 天气类型：temp 气温偏移 / humidity 湿度偏移 / aqi 空气质量偏移 / uv 紫外线偏移 / mood 心情影响 / pl 出现权重感 ——
const WEATHER_TYPES = {
  clear:    { name: '晴',     emoji: '☀️', temp: 2,   humidity: -8,  aqi: -8,  uv: 2,  mood: 2 },
  cloudy:   { name: '多云',   emoji: '⛅', temp: 0,   humidity: 2,   aqi: 0,   uv: 0,  mood: 1 },
  overcast: { name: '阴',     emoji: '☁️', temp: -1,  humidity: 8,   aqi: 6,   uv: -2, mood: -1 },
  rain:     { name: '雨',     emoji: '🌧️', temp: -3,  humidity: 22,  aqi: -12, uv: -3, mood: -2 },
  thunder:  { name: '雷阵雨', emoji: '⛈️', temp: -2,  humidity: 26,  aqi: -14, uv: -3, mood: -2 },
  snow:     { name: '雪',     emoji: '❄️', temp: -7,  humidity: 12,  aqi: -10, uv: -2, mood: 1 },
  fog:      { name: '雾',     emoji: '🌫️', temp: -1,  humidity: 24,  aqi: 40,  uv: -3, mood: -2 },
  haze:     { name: '雾霾',   emoji: '😷', temp: 1,   humidity: 6,   aqi: 95,  uv: -3, mood: -3 },
  windy:    { name: '大风',   emoji: '🌬️', temp: -3,  humidity: -10, aqi: -6,  uv: 0,  mood: -1 }
};

// 季节气候：基线气温 + 天气池（重复项 = 更高出现概率）
const SEASON_CLIMATE = {
  spring: { baseTemp: 18, pool: ['clear', 'cloudy', 'cloudy', 'overcast', 'rain', 'windy'] },
  summer: { baseTemp: 30, pool: ['clear', 'clear', 'cloudy', 'thunder', 'rain', 'overcast'] },
  autumn: { baseTemp: 18, pool: ['clear', 'cloudy', 'overcast', 'windy', 'rain', 'fog'] },
  winter: { baseTemp: 4,  pool: ['overcast', 'cloudy', 'haze', 'snow', 'windy', 'clear'] }
};

function getWeatherInfo(key) { return WEATHER_TYPES[key] || WEATHER_TYPES.clear; }

// 生成/刷新环境（未过 3 小时且非强制则保持不变）
function rollEnvironment(force = false) {
  const nowMs = Date.now();
  const season = getCurrentSeason();
  const cur = healthState.env || {};
  if (!envOn()) {
    const neutral = { weather: 'clear', tempC: 22, humidity: 55, aqi: 45, uv: 5, season, extreme: '', updatedAt: nowMs };
    healthState.env = neutral;
    return neutral;
  }
  if (!force && cur.updatedAt && nowMs - cur.updatedAt < 3 * 3600000) return cur;
  const climate = SEASON_CLIMATE[season] || SEASON_CLIMATE.spring;
  const weather = climate.pool[Math.floor(Math.random() * climate.pool.length)];
  const w = getWeatherInfo(weather);
  // v13.0：极端天气事件 —— 小概率盖在当季常规天气之上，随下一次刷新自然结束
  const extreme = rollExtremeWeather(season);
  const x = getExtremeInfo(extreme);
  const tempC = roundTo(climate.baseTemp + w.temp + (x ? x.tempAdd : 0) + (Math.random() * 8 - 4), 1);
  const humidity = clampInt(55 + w.humidity + (x ? x.humidity : 0) + (Math.random() * 16 - 8), 15, 99);
  const aqi = clampInt(55 + w.aqi + (x ? x.aqi : 0) + (Math.random() * 30 - 15), 12, 260);
  const uv = clampInt(5 + w.uv + (x ? x.uv : 0), 0, 11);
  const env = { weather, tempC, humidity, aqi, uv, season, extreme, updatedAt: nowMs };
  healthState.env = env;
  if (!Array.isArray(healthState.envHistory)) healthState.envHistory = [];
  healthState.envHistory.push({ date: localStamp(nowMs), weather, tempC, aqi });
  if (healthState.envHistory.length > 20) healthState.envHistory = healthState.envHistory.slice(-20);
  return env;
}

function getAqiLevel(aqi) {
  const a = Number(aqi);
  if (!Number.isFinite(a)) return { name: '—', emoji: '⚪' };
  if (a <= 50) return { name: '优', emoji: '🟢' };
  if (a <= 100) return { name: '良', emoji: '🟡' };
  if (a <= 150) return { name: '轻度污染', emoji: '🟠' };
  if (a <= 200) return { name: '中度污染', emoji: '🔴' };
  return { name: '重度污染', emoji: '🟣' };
}

function getUvLevel(uv) {
  const u = Number(uv);
  if (!Number.isFinite(u)) return '—';
  if (u <= 2) return '弱';
  if (u <= 5) return '中等';
  if (u <= 7) return '强';
  return '很强';
}

// 环境 → 检验指标偏移
function getEnvVitalEffects() {
  if (!envOn()) return {};
  const env = healthState.env || {};
  const t = Number(env.tempC), aqi = Number(env.aqi), hum = Number(env.humidity);
  const out = {};
  const add = (k, v) => { out[k] = (out[k] || 0) + v; };
  if (Number.isFinite(t)) {
    if (t <= 5) { add('bpSys', (5 - t) * 0.9); add('bpDia', (5 - t) * 0.5); add('heartRate', (5 - t) * 0.9); }
    else if (t >= 30) { add('heartRate', (t - 30) * 1.1); add('bpSys', -(t - 30) * 0.7); add('sodium', -(t - 30) * 0.28); add('potassium', -(t - 30) * 0.03); }
  }
  if (Number.isFinite(aqi) && aqi > 100) {
    const p = (aqi - 100) / 100; // 0~1.6
    add('spo2', -p * 3.2);
    add('respiratoryRate', p * 3.0);
    add('wbc', p * 0.7);
  }
  if (Number.isFinite(hum) && hum >= 85) add('respiratoryRate', 0.6);
  return out;
}

// 环境 → 疾病易感（按病种分组）
const ENV_DISEASE_GROUPS = {
  respiratory: ['rhinitis', 'pharyngitis', 'cough', 'cold', 'flu', 'winter_pneumonia', 'winter_flu', 'autumn_cough', 'spring_cold', 'autumn_cold', 'winter_rhinitis', 'spring_rhinitis'],
  joint: ['arthritis', 'backache', 'cervical_spondylosis'],
  cold: ['winter_frostbite'],
  allergy: ['allergy', 'spring_allergy', 'rhinitis', 'winter_rhinitis', 'spring_rhinitis']
};
function getEnvRisk(diseaseKey) {
  if (!envOn()) return 1;
  const env = healthState.env || {};
  const t = Number(env.tempC), aqi = Number(env.aqi), hum = Number(env.humidity);
  let risk = 1;
  if (Number.isFinite(aqi) && aqi > 120 && ENV_DISEASE_GROUPS.respiratory.includes(diseaseKey)) {
    risk *= 1 + Math.min(1.0, (aqi - 120) / 130);
  }
  if (Number.isFinite(t)) {
    if (t <= 3 && ENV_DISEASE_GROUPS.cold.includes(diseaseKey)) risk *= 1 + Math.min(1.0, (3 - t) / 12);
    if (t >= 32 && ENV_DISEASE_GROUPS.respiratory.includes(diseaseKey)) risk *= 0.9;
  }
  if (Number.isFinite(hum) && hum >= 85 && ENV_DISEASE_GROUPS.joint.includes(diseaseKey)) risk *= 1.35;
  return risk;
}

// 环境 → 心情修正（每周期）
function getEnvMoodDelta() {
  if (!envOn()) return 0;
  const env = healthState.env || {};
  let d = getWeatherInfo(env.weather).mood || 0;
  const aqi = Number(env.aqi);
  if (Number.isFinite(aqi) && aqi > 150) d -= 2;
  return d;
}

// 用户/LLM 可读的环境摘要
function getEnvSummary() {
  const env = healthState.env || {};
  const w = getWeatherInfo(env.weather);
  const aq = getAqiLevel(env.aqi);
  return `${w.emoji}${w.name} ${roundTo(Number(env.tempC) || 0, 1)}℃ 湿度${clampInt(Number(env.humidity) || 0, 0, 100)}% ${aq.emoji}AQI${clampInt(Number(env.aqi) || 0, 0, 999)}(${aq.name}) 紫外线${getUvLevel(env.uv)}`;
}

// —— 医疗体系：不同等级医院 ——
const HOSPITALS = {
  community: { name: '社区医院', emoji: '🏥', skill: 0.45, costMul: 0.6, chronic: false, desc: '便宜方便，但设备和医生水平一般，容易误诊' },
  general:   { name: '市医院',   emoji: '🏨', skill: 0.65, costMul: 1.0, chronic: false, desc: '综合实力均衡，价格适中' },
  top:       { name: '三甲医院', emoji: '🏛️', skill: 0.85, costMul: 2.2, chronic: false, desc: '专家云集、设备先进，确诊与治愈率最高，但贵' },
  tcm:       { name: '中医院',   emoji: '🍵', skill: 0.6,  costMul: 0.8, chronic: true,  desc: '擅长慢性病调理与静养，对慢性病效果拔群' }
};

function getHospitalKey() { return HOSPITALS[healthState.hospital] ? healthState.hospital : 'general'; }
function getHospitalInfo() { return HOSPITALS[getHospitalKey()]; }
// 本次就诊的医生水平（在医院水平上小幅浮动）
function rollDoctorSkill() {
  const base = getHospitalInfo().skill;
  return Math.max(0.15, Math.min(0.98, base + (Math.random() * 0.18 - 0.09)));
}
// 医院修正后的费用
function hospitalCost(medicalKey) {
  return Math.round(getMedicalCost(medicalKey) * (getHospitalInfo().costMul || 1));
}

// —— 家族遗传史 ——
const FAMILY_HISTORY = {
  diabetes:     { name: '糖尿病',     emoji: '🍬', targets: ['diabetes', 'hypoglycemia'] },
  hypertension: { name: '高血压',     emoji: '🩸', targets: ['hypertension', 'atherosclerosis', 'palpitation'] },
  heart:        { name: '心脏病',     emoji: '💓', targets: ['palpitation', 'atherosclerosis', 'hypertension'] },
  stroke:       { name: '脑血管病',   emoji: '🧠', targets: ['hypertension', 'headache', 'insomnia', 'neurasthenia'] },
  allergy:      { name: '过敏体质',   emoji: '🤧', targets: ['allergy', 'spring_allergy', 'rhinitis', 'winter_rhinitis', 'spring_rhinitis'] },
  asthma:       { name: '哮喘/呼吸病', emoji: '🫁', targets: ['cough', 'autumn_cough', 'winter_pneumonia', 'pharyngitis'] },
  liver:        { name: '肝病',       emoji: '🫀', targets: ['fatty_liver'] },
  kidney:       { name: '肾病',       emoji: '🫘', targets: ['hyperuricemia'] },
  thyroid:      { name: '甲状腺',     emoji: '🦋', targets: ['neurasthenia', 'palpitation', 'insomnia'] },
  obesity:      { name: '肥胖',       emoji: '⚖️', targets: ['hyperlipidemia', 'fatty_liver', 'diabetes'] }
};

function getFamilyHistoryList() {
  return Array.isArray(healthState.familyHistory) ? healthState.familyHistory.filter(k => FAMILY_HISTORY[k]) : [];
}
// 首次随机生成家族史（0~2 项）
function rollFamilyHistory(force = false) {
  if (!familyOn()) { healthState.familyHistory = []; healthState.familyRolled = true; return []; }
  if (!force && healthState.familyRolled) return getFamilyHistoryList();
  const pool = Object.keys(FAMILY_HISTORY);
  const n = Math.floor(Math.random() * 3);
  const picked = [];
  for (let i = 0; i < n && pool.length; i++) picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
  healthState.familyHistory = picked;
  healthState.familyRolled = true;
  return picked;
}
function getFamilyRisk(diseaseKey) {
  if (!familyOn()) return 1;
  for (const tag of getFamilyHistoryList()) if (FAMILY_HISTORY[tag].targets.includes(diseaseKey)) return 1.8;
  return 1;
}

// 综合疾病易感倍率（体质 × 环境 × 遗传）与放宽余量
function getDiseaseRisk(diseaseKey) {
  return getConstitutionRisk(diseaseKey) * getEnvRisk(diseaseKey) * getFamilyRisk(diseaseKey);
}
function getDiseaseRiskMargin(diseaseKey) {
  const r = getDiseaseRisk(diseaseKey);
  return r > 1 ? (r - 1) * 25 : 0;
}

// —— 营养素（0-100 摄入合理度，越高越健康）——
const NUTRIENT_INFO = {
  protein: { name: '蛋白质',   emoji: '🥩' },
  carbs:   { name: '碳水',     emoji: '🍚' },
  fat:     { name: '脂肪均衡', emoji: '🧈' },
  vitamin: { name: '维生素',   emoji: '🥬' },
  mineral: { name: '矿物质',   emoji: '💎' },
  fiber:   { name: '膳食纤维', emoji: '🌾' },
  sodium:  { name: '控盐',     emoji: '🧂' },
  sugar:   { name: '控糖',     emoji: '🍬' }
};
function getNutrient(k) { const n = Number(healthState.nutrients?.[k]); return Number.isFinite(n) ? n : 70; }
function getNutrientLevel(v) { return v >= 80 ? '充足' : v >= 60 ? '一般' : v >= 40 ? '不足' : '缺乏'; }
function addNutrient(k, delta) {
  if (!healthState.nutrients || typeof healthState.nutrients !== 'object') healthState.nutrients = {};
  const cur = getNutrient(k);
  healthState.nutrients[k] = Math.max(0, Math.min(100, cur + delta));
  return healthState.nutrients[k];
}

// 营养素 → 检验指标偏移
function getNutrientVitalEffects() {
  const out = {};
  const add = (k, v) => { out[k] = (out[k] || 0) + v; };
  const lack = (k) => Math.max(0, (70 - getNutrient(k)) / 70); // 不足程度 0~1
  const prot = lack('protein'), vit = lack('vitamin'), min = lack('mineral'), fib = lack('fiber');
  add('albumin', -prot * 7);
  add('hemoglobin', -prot * 22);
  add('wbc', -prot * 0.8);
  add('calcium', -vit * 0.18 - min * 0.1);
  add('potassium', -min * 0.35);
  add('triglyceride', fib * 0.55);
  // 控盐差 → 血压升高
  const saltBad = Math.max(0, (70 - getNutrient('sodium')) / 70);
  add('bpSys', saltBad * 14);
  add('bpDia', saltBad * 7);
  // 控糖差 → 血糖/甘油三酯升高
  const sugarBad = Math.max(0, (70 - getNutrient('sugar')) / 70);
  add('bloodSugar', sugarBad * 1.5);
  add('triglyceride', sugarBad * 0.7);
  // 脂肪均衡差 → 胆固醇/低密度升高
  const fatBad = Math.max(0, (70 - getNutrient('fat')) / 70);
  add('cholesterol', fatBad * 1.1);
  add('ldl', fatBad * 0.8);
  return out;
}

// 营养素异常 → 对话情绪提示
function getNutrientHint() {
  const bad = [];
  if (getNutrient('protein') < 45) bad.push('蛋白质不够，浑身没力气、脸色也差');
  if (getNutrient('vitamin') < 45) bad.push('缺维生素，总觉得累、抵抗力差');
  if (getNutrient('mineral') < 45) bad.push('缺矿物质，手脚发软、偶尔抽筋');
  if (getNutrient('fiber') < 45) bad.push('蔬菜吃太少，肠胃有点堵');
  if (getNutrient('sodium') < 45) bad.push('吃得太咸了，总觉得渴、头有点涨');
  if (getNutrient('sugar') < 45) bad.push('糖吃多了，容易饿又容易困');
  if (!bad.length) return '';
  return `【营养状况】你的营养摄入不均衡（${bad.slice(0, 2).join('；')}）。请自然地在对话中体现身体不适，不要直接报数值。`;
}

// 环境异常 → 对话情绪提示
function getEnvHint() {
  if (!envOn()) return '';
  const env = healthState.env || {};
  const t = Number(env.tempC), aqi = Number(env.aqi);
  const texts = [];
  if (Number.isFinite(aqi) && aqi > 150) texts.push('空气太差了，喉咙不舒服、喘不上气');
  if (Number.isFinite(t) && t <= 3) texts.push('外面太冷了，冷得发抖、手脚冰凉');
  if (Number.isFinite(t) && t >= 32) texts.push('热得要命，头晕、一身汗');
  if (env.weather === 'rain' || env.weather === 'thunder') texts.push('外面下雨，湿漉漉的，有点烦躁');
  if (!texts.length) return '';
  return `【环境反应】当前环境让你不舒服（${texts.join('；')}）。请自然地在对话中体现，不要直接报数值。`;
}

// —— 器官辅助 ——
// ══════════════════════════════════════════════════════════════════════════
//  心理 × 睡眠 × 内分泌 × 创伤 × 影像检查 × 流行病 × 习惯 × 成就（v6.0）
// ══════════════════════════════════════════════════════════════════════════

// ── ① 心理干预手段 ──
const THERAPIES = {
  therapy:  { name: '心理咨询', emoji: '🛋️', cost: 80, cooldown: 6 * 3600000, anxiety: -22, depressionLevel: -20, stability: 12, focus: 6 },
  meditate: { name: '冥想',     emoji: '🧘', cost: 0,  cooldown: 2 * 3600000, anxiety: -12, depressionLevel: -6,  stability: 8,  focus: 8 },
  journal:  { name: '写日记',   emoji: '📓', cost: 0,  cooldown: 3 * 3600000, anxiety: -8,  depressionLevel: -8,  stability: 5,  focus: 4 },
  party:    { name: '参加聚会', emoji: '🎉', cost: 30, cooldown: 4 * 3600000, anxiety: -10, depressionLevel: -10, mood: 12, social: 15, belonging: 10 },
  cry:      { name: '大哭一场', emoji: '😭', cost: 0,  cooldown: 6 * 3600000, anxiety: -14, depressionLevel: -12, mood: 6,  comfort: -8 }
};
const THERAPY_LAST_KEY = { therapy: 'lastTherapy', meditate: 'lastMeditate', journal: 'lastJournal', party: 'lastParty', cry: 'lastCry' };

// ── ② 睡眠阶段 ──
const SLEEP_STAGES = {
  awake: { name: '清醒', emoji: '☀️', recover: 0 },
  light: { name: '浅睡', emoji: '🌤️', recover: 9 },
  deep:  { name: '深睡', emoji: '🌊', recover: 22 },
  rem:   { name: 'REM',  emoji: '💭', recover: 15 }
};

// ── ③ 激素 ──
const HORMONE_INFO = {
  cortisol:   { name: '皮质醇',   emoji: '😰', desc: '压力激素，长期偏高会削弱免疫、扰乱睡眠' },
  adrenaline: { name: '肾上腺素', emoji: '⚡', desc: '应激激素，飙升时心跳加快、手抖' },
  serotonin:  { name: '血清素',   emoji: '😊', desc: '快乐激素，偏低容易情绪低落' },
  dopamine:   { name: '多巴胺',   emoji: '🎯', desc: '动机激素，偏低提不起劲' },
  thyroxine:  { name: '甲状腺素', emoji: '🔥', desc: '代谢激素，偏高怕热心悸、偏低怕冷乏力' },
  melatonin:  { name: '褪黑激素', emoji: '🌙', desc: '睡眠激素，夜间升高帮助入睡' }
};
function getHormone(k) { const v = Number(healthState.hormones?.[k]); return Number.isFinite(v) ? v : 50; }
function setHormone(k, v) {
  if (!healthState.hormones || typeof healthState.hormones !== 'object') healthState.hormones = {};
  healthState.hormones[k] = Math.max(0, Math.min(100, v));
  return healthState.hormones[k];
}
function getHormoneLevel(v) {
  return v >= 82 ? '偏高' : v >= 55 ? '正常' : v >= 35 ? '偏低' : '很低';
}

// ── ④ 外伤 ──
const INJURY_INFO = {
  cut:      { name: '割伤',   emoji: '🔪', severity: 15, health: 3, organ: 'skin' },
  burn:     { name: '烫伤',   emoji: '🔥', severity: 20, health: 4, organ: 'skin' },
  sprain:   { name: '扭伤',   emoji: '🦶', severity: 12, health: 2, organ: null },
  fracture: { name: '骨折',   emoji: '🦴', severity: 40, health: 8, organ: null },
  scrape:   { name: '擦伤',   emoji: '🩹', severity: 6,  health: 1, organ: 'skin' },
  frostbite:{ name: '冻伤(外伤)', emoji: '❄️', severity: 22, health: 4, organ: 'skin' },
  bite:     { name: '咬伤',   emoji: '🐕', severity: 18, health: 3, organ: 'skin' },
  shock:    { name: '撞伤',   emoji: '💥', severity: 35, health: 9, organ: 'brain' }
};
const INJURY_PARTS = ['头部', '手臂', '手腕', '手指', '腰部', '膝盖', '脚踝', '小腿', '肩膀', '后背', '额头'];

// ── ⑤ 影像 / 化验检查项目 ──
const IMAGING_INFO = {
  ecg:         { name: '心电图',     emoji: '📈', cost: 60,  detects: ['palpitation', 'hypertension', 'anxiety_disorder', 'hyperthyroidism'], desc: '查心律与心肌供血' },
  ultrasound:  { name: 'B超',        emoji: '🖥️', cost: 90,  detects: ['fatty_liver', 'hyperlipidemia', 'constipation'], desc: '查肝胆脾胰肾等实质器官' },
  xray:        { name: 'X光',        emoji: '🦴', cost: 70,  detects: ['winter_pneumonia', 'cough'], desc: '查骨骼与肺部影像' },
  ct:          { name: 'CT',         emoji: '🧿', cost: 220, detects: ['winter_pneumonia', 'concussion', 'headache'], desc: '精细断层扫描，适合头颅与胸部' },
  urinalysis:  { name: '尿常规',     emoji: '🧪', cost: 30,  detects: ['diabetes', 'hyperuricemia', 'dehydration'], desc: '查尿糖/尿蛋白/尿酸' },
  stool:       { name: '便常规',     emoji: '🧫', cost: 30,  detects: ['gastroenteritis', 'constipation'], desc: '查消化道感染与隐血' },
  thyroid:     { name: '甲状腺功能', emoji: '🦋', cost: 80,  detects: ['hyperthyroidism', 'hypothyroidism', 'hormonal_imbalance'], desc: '查 T3 / T4 / TSH' },
  tumor_marker:{ name: '肿瘤标志物', emoji: '🎗️', cost: 160, detects: ['hyperlipidemia'], desc: '筛查肿瘤相关指标（早期多无异常）' }
};

// ── ⑥ 流行病 ──
const EPIDEMIC_LEVELS = { 1: '低发', 2: '高发', 3: '爆发' };
const EPIDEMIC_POOL = ['flu', 'cold', 'cough', 'fever', 'pharyngitis', 'gastroenteritis', 'winter_flu', 'spring_cold'];
function getEpidemicLevelName(l) { return EPIDEMIC_LEVELS[l] || '平稳'; }

// ── ⑦ 习惯 ──
const HABIT_INFO = {
  smoking:       { name: '吸烟',   emoji: '🚬', good: false, desc: '伤肺、升血压、降免疫' },
  drinking:      { name: '饮酒',   emoji: '🍺', good: false, desc: '伤肝、升尿酸、影响睡眠' },
  stayingUp:     { name: '熬夜',   emoji: '🦉', good: false, desc: '累积睡眠负债、降低抵抗力' },
  sedentary:     { name: '久坐',   emoji: '🪑', good: false, desc: '升血脂、降心肺、易发胖' },
  morningRun:    { name: '晨跑',   emoji: '🏃', good: true,  desc: '提升心肺、稳定情绪' },
  meditation:    { name: '冥想',   emoji: '🧘', good: true,  desc: '降低焦虑、提升专注力' },
  drinkingWater: { name: '多喝水', emoji: '💧', good: true,  desc: '维持代谢与皮肤状态' },
  earlySleep:    { name: '早睡',   emoji: '🌙', good: true,  desc: '修复睡眠负债、稳定激素' }
};
function getHabit(k) { const v = Number(healthState.habits?.[k]); return Number.isFinite(v) ? v : 0; }
function addHabit(k, delta) {
  if (!healthState.habits || typeof healthState.habits !== 'object') healthState.habits = {};
  const cur = Number(healthState.habits[k]);
  const next = Math.max(0, Math.min(100, (Number.isFinite(cur) ? cur : 0) + delta));
  healthState.habits[k] = next;
  return next;
}
function getHabitLevel(v) {
  return v >= 80 ? '根深蒂固' : v >= 50 ? '已养成' : v >= 20 ? '偶尔为之' : '几乎没有';
}

// ── ⑧ 成就徽章 ──
const ACHIEVEMENTS = {
  healthy_body:   { name: '健康达人',   emoji: '💪', desc: '健康值 ≥ 90 且身上没有疾病' },
  marathon:       { name: '马拉松选手', emoji: '🏃', desc: '运动习惯达到 95' },
  iron_lung:      { name: '铁肺',       emoji: '🫁', desc: '肺部健康度 ≥ 95' },
  all_organs:     { name: '器官全优',   emoji: '🫀', desc: '八大器官全部 ≥ 90' },
  no_smoke:       { name: '无烟人生',   emoji: '🚭', desc: '吸烟习惯降到 5 以下' },
  sober:          { name: '清醒人生',   emoji: '🍵', desc: '饮酒习惯降到 5 以下' },
  early_bird:     { name: '早睡早起',   emoji: '🌅', desc: '早睡习惯达到 80' },
  zen_master:     { name: '禅修大师',   emoji: '🧘', desc: '冥想习惯达到 80' },
  calm_mind:      { name: '心静如水',   emoji: '🕊️', desc: '焦虑度与抑郁度都 ≤ 10' },
  vaccine_master: { name: '免疫盾牌',   emoji: '🛡️', desc: '同时持有 6 种以上抗体' },
  rich:           { name: '小有积蓄',   emoji: '💰', desc: '钱包达到 ¥2000' },
  vital_perfect:  { name: '体检满分',   emoji: '🩸', desc: '检验指标综合评分 ≥ 98' },
  imager:         { name: '影像达人',   emoji: '🩻', desc: '累计完成 5 次影像检查' },
  survivor:       { name: '浴火重生',   emoji: '🔥', desc: '累计医疗花费超过 ¥800' },
  // —— v8.0 ——
  youthful:       { name: '冻龄体质',   emoji: '🧬', desc: '生物年龄比实际年龄小 5 岁以上' },
  gut_healthy:    { name: '菌群丰盛',   emoji: '🦠', desc: '肠道菌群综合评分达到 90' },
  allergy_free:   { name: '百毒不侵',   emoji: '🌾', desc: '做完过敏原检测且八项全部不过敏' },
  socially_rich:  { name: '人间值得',   emoji: '👪', desc: '关系网不少于 5 人且平均亲密度达到 85' },
  insured:        { name: '有备无患',   emoji: '🧾', desc: '持有职工医保或商业保险且在有效期内' },
  historian:      { name: '人生记录者', emoji: '📜', desc: '健康大事记累计记录 30 条以上' },
  // —— v9.0 ——
  first_work:     { name: '处女作',     emoji: '🖼️', desc: '产出第一件作品' },
  masterwork:     { name: '匠心独运',   emoji: '👑', desc: '产出至少一件杰作' },
  prolific:       { name: '作品等身',   emoji: '📚', desc: '累计产出 20 件作品' },
  versatile:      { name: '多才多艺',   emoji: '🎭', desc: '同时培养 5 个爱好' },
  grandmaster:    { name: '登峰造极',   emoji: '🏆', desc: '任意爱好的熟练度达到 10 级（传奇）' },
  allrounder:     { name: '博采众长',   emoji: '🌈', desc: '在 5 个不同大类里各有一门在练的爱好' },
  // —— v10.0 ——
  pet_owner:      { name: '有宠一族',     emoji: '🐾', desc: '领养第一只宠物' },
  first_trick:    { name: '小有灵性',     emoji: '🎓', desc: '让宠物学会第一个技能' },
  pet_trainer:    { name: '驯兽师',       emoji: '🎪', desc: '让同一只宠物学会 6 个技能' },
  pet_bond_max:   { name: '形影不离',     emoji: '💗', desc: '与任意宠物的亲密度达到 92' },
  pet_doctor:     { name: '操心的铲屎官', emoji: '🩺', desc: '带宠物看兽医累计 5 次' },
  pet_ranger:     { name: '动物园园长',   emoji: '🏡', desc: '同时养 4 只宠物' },
  // —— v11.0 日常生活 ——
  well_dressed:   { name: '会穿衣服',     emoji: '🧥', desc: '体感「刚刚好」累计 30 次' },
  sun_aware:      { name: '防晒达人',     emoji: '🧴', desc: '涂防晒累计 20 次' },
  self_feeder:    { name: '自食其力',     emoji: '🍳', desc: '自己下厨累计 30 次' },
  foodie:         { name: '吃遍了',       emoji: '🍽️', desc: '9 种菜品各至少吃过一次' },
  home_master:    { name: '亮堂的家',     emoji: '🛋️', desc: '把房间整洁度收拾到 95' },
  bill_payer:     { name: '按时缴费',     emoji: '🧾', desc: '累计缴费 6 次' },
  // —— v12.0 钱币系统 ——
  first_gig:      { name: '第一桶金',     emoji: '🪙', desc: '第一次靠手艺接到单' },
  artisan:        { name: '手艺人',       emoji: '🎖️', desc: '累计接单 10 单' },
  masterpiece:    { name: '一字千金',     emoji: '💎', desc: '单笔接单收入达到 ¥800' },
  payday:         { name: '发薪日',       emoji: '💼', desc: '领到第一笔月薪' },
  workhorse:      { name: '劳模',         emoji: '💪', desc: '打工累计 10 次' },
  in_the_black:   { name: '收支平衡',     emoji: '⚖️', desc: '累计收入不低于累计支出' },
  // —— v13.0 时间与社会 ——
  lifelong_learner:{ name: '终身学习',    emoji: '🔍', desc: '求知欲回到 90 以上' },
  soft_heart:     { name: '心是软的',     emoji: '💗', desc: '同理心回到 90 以上' },
  weekend_warrior:{ name: '周末战士',     emoji: '🌞', desc: '累计度过 8 个休息日' },
  festive_soul:   { name: '过节达人',     emoji: '🎊', desc: '经历 6 个节日' },
  one_more_year:  { name: '又长一岁',     emoji: '🎂', desc: '过一次生日' },
  storm_chaser:   { name: '风雨无阻',     emoji: '🌀', desc: '经历 3 次极端天气' },
  chronic_master: { name: '与病共存',     emoji: '♻️', desc: '让一种慢性病进入缓解期' }
};

// ── 心理干预：记录 ──
function recordPsyc(text) {
  if (!Array.isArray(healthState.psycHistory)) healthState.psycHistory = [];
  healthState.psycHistory.push({ date: localDayKey(), text });
  if (healthState.psycHistory.length > 50) healthState.psycHistory = healthState.psycHistory.slice(-50);
}

// ── 激素更新（压力 / 睡眠 / 情绪 / 运动 / 咖啡因）──
function updateHormones(times = 1, isNight = false) {
  if (!healthState.hormones || typeof healthState.hormones !== 'object') healthState.hormones = {};
  const t = Math.min(times, 3);
  const stress = Number(healthState.stress);       // 低=压力大
  const anxiety = Number(healthState.anxiety);
  const depr = Number(healthState.depressionLevel);
  const mood = Number(healthState.mood);
  const sq = Number(healthState.sleepQuality);
  const exV = Number(healthState.exercise);
  const caffeine = Number(healthState.caffeine);
  const sat = Number(healthState.satisfaction);
  // v8.0：昼夜节律曲线提供激素基线，让皮质醇"晨高夜低"、褪黑素"夜高昼低"自然成形
  const nowD = new Date();
  const hourF = nowD.getHours() + nowD.getMinutes() / 60;
  const circOn = circadianOn();
  const cortisolBase = circOn ? getCircadianValue('cortisol', hourF) : 50;
  const melatoninBase = circOn ? getCircadianValue('melatonin', hourF) : (isNight ? 75 : 15);
  const gutFx = getGutEffects();

  // 皮质醇：先向节律基线回归，再叠加压力/焦虑（升）与睡眠质量（降）
  setHormone('cortisol', getHormone('cortisol') + ((cortisolBase - getHormone('cortisol')) * 0.18 + (stress < 50 ? 1.4 : 0) + (anxiety > 60 ? 1.0 : 0) - (sq > 70 ? 0.9 : 0)) * t);
  // 肾上腺素：焦虑 / 咖啡因
  setHormone('adrenaline', getHormone('adrenaline') + ((anxiety > 55 ? 0.9 : 0) + (caffeine > 40 ? 0.9 : 0) - 0.5) * t);
  // 血清素：心情好 → 升；抑郁高 → 降；v8.0 肠脑轴：菌群越好基线越高（人体九成血清素在肠道合成）
  setHormone('serotonin', getHormone('serotonin') + ((mood > 70 ? 0.7 : 0) - (depr > 50 ? 1.0 : 0) - 0.2 + gutFx.serotoninBase * 0.06) * t);
  // 多巴胺：满足感高 / 常运动 → 升
  setHormone('dopamine', getHormone('dopamine') + ((sat > 70 ? 0.5 : 0) + (exV > 60 ? 0.4 : 0) - 0.3) * t);
  // 甲状腺素：缓慢向 60 回归
  setHormone('thyroxine', getHormone('thyroxine') + (60 - getHormone('thyroxine')) * 0.02 * t);
  // 褪黑激素：向节律曲线基线回归（夜间自然爬升、清晨自动回落）
  setHormone('melatonin', getHormone('melatonin') + ((melatoninBase - getHormone('melatonin')) * 0.25 + (isNight ? 0.6 : -0.6)) * t);
  // 咖啡因自然代谢
  healthState.caffeine = Math.max(0, Number(healthState.caffeine) - 12 * t);
}

// ── 睡眠阶段推进 ──
function updateSleepStage(isNight, times = 1) {
  let stage = healthState.sleepStage;
  if (!SLEEP_STAGES[stage]) stage = 'awake';
  const needSleep = Number(healthState.sleep) < 45 || Number(healthState.sleepDebt) > 55;
  if (isNight && needSleep) {
    const r = Math.random();
    stage = r < 0.42 ? 'deep' : r < 0.72 ? 'light' : 'rem';
  } else if (!isNight) {
    stage = 'awake';
  }
  healthState.sleepStage = stage;
  const rec = SLEEP_STAGES[stage].recover;
  if (rec > 0) {
    healthState.sleepDebt = Math.max(0, Number(healthState.sleepDebt) - rec * 0.28 * Math.min(times, 2));
    healthState.fatigue = Math.min(100, Number(healthState.fatigue) + rec * 0.2);
    if (!Array.isArray(healthState.sleepLog)) healthState.sleepLog = [];
    healthState.sleepLog.push({ date: localDayKey(), stage, hours: healthState.sleepClock });
    if (healthState.sleepLog.length > 30) healthState.sleepLog = healthState.sleepLog.slice(-30);
  }
  return stage;
}

// ── 外伤随机事件 ──
function rollInjury() {
  if (!injuryOn()) return null;
  let chance = 0.006;
  if (Number(healthState.exercise) > 75) chance += 0.010;
  if (Number(healthState.fatigue) < 25) chance += 0.008;
  if (Number(healthState.env?.aqi) > 150) chance += 0.004;
  if (Number(healthState.health) < 30) chance += 0.006;
  if (Math.random() >= chance) return null;
  const keys = Object.keys(INJURY_INFO);
  const type = keys[Math.floor(Math.random() * keys.length)];
  const info = INJURY_INFO[type];
  const part = INJURY_PARTS[Math.floor(Math.random() * INJURY_PARTS.length)];
  if (!Array.isArray(healthState.injuries)) healthState.injuries = [];
  healthState.injuries.push({ type, part, severity: info.severity, at: Date.now() });
  healthState.scarCount = (Number(healthState.scarCount) || 0) + 1;
  healthState.health = Math.max(0, Number(healthState.health) - info.health);
  healthState.comfort = Math.max(0, Number(healthState.comfort) - info.severity * 0.6);
  if (info.organ) damageOrgan(info.organ, info.severity * 0.35);
  recordMedical(`外伤：${part}${info.name}`);
  log(`[健康系统] 🤕 意外受伤：${part}${info.name}（严重度 ${info.severity}）`);
  return { type, part, info };
}

// ── 外伤愈合 ──
function healInjuries() {
  if (!Array.isArray(healthState.injuries)) { healthState.injuries = []; return 0; }
  const before = healthState.injuries.length;
  healthState.injuries = healthState.injuries.filter(inj => {
    const ageH = (Date.now() - (inj.at || 0)) / 3600000;
    const healHours = 6 + Number(inj.severity) * 0.8; // 越重愈合越久
    return ageH < healHours;
  });
  const healed = before - healthState.injuries.length;
  if (healed > 0) log(`[健康系统] 伤口自然愈合 ${healed} 处`);
  return healed;
}

// ── 疫情演进 ──
function rollEpidemic() {
  if (!epidemicOn()) return;
  if (!healthState.epidemic || typeof healthState.epidemic !== 'object') {
    healthState.epidemic = { active: false, disease: '', since: 0, level: 0 };
  }
  const ep = healthState.epidemic;
  const now = Date.now();
  if (ep.active) {
    if (now - (ep.since || 0) > 6 * 86400000) {
      ep.active = false; ep.disease = ''; ep.level = 0; ep.since = now;
      log('[健康系统] 🦠 社区疫情已平息');
      return;
    }
    if (Math.random() < 0.28) ep.level = Math.min(3, ep.level + 1);
    else if (Math.random() < 0.28) ep.level = Math.max(1, ep.level - 1);
  } else {
    if (now - (ep.since || 0) < 3 * 86400000) return;
    if (Math.random() < 0.35) {
      ep.active = true;
      ep.disease = EPIDEMIC_POOL[Math.floor(Math.random() * EPIDEMIC_POOL.length)];
      ep.level = 1;
      ep.since = now;
      log(`[健康系统] 🦠 社区爆发疫情：${getDiseaseInfo(ep.disease)?.name || ep.disease}`);
    } else {
      ep.since = now;
    }
  }
}

// ── 疫情期间暴露 ──
function rollEpidemicExposure() {
  if (!epidemicOn()) return;
  const ep = healthState.epidemic || {};
  if (!ep.active || !ep.disease) return;
  const d = ep.disease;
  if (healthState.diseases.includes(d) || isIncubating(d) || hasAntibody(d)) return;
  let chance = 0.02 * (Number(ep.level) || 1);
  if (healthState.maskOn) chance *= 0.35;                                   // 口罩大幅降低
  if (Date.now() - (Number(healthState.lastIsolate) || 0) < 86400000) chance *= 0.15; // 隔离几乎阻断
  if (Number(healthState.immunity) > 75) chance *= 0.6;
  if (Math.random() < chance) {
    enqueueExposure(d, '社区疫情');
    log(`[健康系统] 疫情暴露：${d}`);
  }
}

// ── 习惯效应 ──
function applyHabitEffects(times = 1) {
  if (!habitOn()) return 0;
  const t = Math.min(times, 3);
  let healthDecay = 0;
  const smoking = getHabit('smoking');
  const drinking = getHabit('drinking');
  const sedentary = getHabit('sedentary');
  const stayingUp = getHabit('stayingUp');
  if (smoking > 20) {
    damageOrgan('lung', (smoking / 40) * t);
    healthDecay += (smoking / 60) * t;
    healthState.immunity = Math.max(0, Number(healthState.immunity) - 0.3 * t);
  }
  if (drinking > 20) {
    damageOrgan('liver', (drinking / 45) * t);
    healthDecay += (drinking / 80) * t;
    healthState.sleepQuality = Math.max(0, Number(healthState.sleepQuality) - 0.4 * t);
  }
  if (sedentary > 20) {
    healthState.exercise = Math.max(0, Number(healthState.exercise) - (sedentary / 55) * t);
  }
  if (stayingUp > 20) {
    healthState.sleepDebt = Math.min(100, Number(healthState.sleepDebt) + (stayingUp / 45) * t);
  }
  // 好习惯加成
  const run = getHabit('morningRun');
  if (run > 30) healthState.exercise = Math.min(100, Number(healthState.exercise) + (run / 60) * t);
  const early = getHabit('earlySleep');
  if (early > 30) healthState.sleepDebt = Math.max(0, Number(healthState.sleepDebt) - (early / 45) * t);
  const med = getHabit('meditation');
  if (med > 30) healthState.anxiety = Math.max(0, Number(healthState.anxiety) - (med / 70) * t);
  const water = getHabit('drinkingWater');
  if (water > 30) healthState.thirst = Math.min(100, Number(healthState.thirst) + (water / 90) * t);
  return healthDecay;
}

// ── 心理自然演变 ──
function updatePsyche(times = 1) {
  const t = Math.min(times, 3);
  const stress = Number(healthState.stress);
  const sq = Number(healthState.sleepQuality);
  const debt = Number(healthState.sleepDebt);
  const lon = Number(healthState.loneliness);
  const mood = Number(healthState.mood);
  const exV = Number(healthState.exercise);
  // 压力大 / 睡眠差 / 孤独 / 缺觉 → 焦虑与抑郁上升
  const anxDelta = ((stress < 45 ? 0.8 : -0.3) + (sq < 45 ? 0.5 : 0) + (debt > 55 ? 0.5 : 0) + (lon < 45 ? 0.4 : 0)) * t;
  const depDelta = ((mood < 45 ? 0.7 : -0.25) + (lon < 45 ? 0.5 : 0) + (debt > 60 ? 0.4 : 0) - (exV > 65 ? 0.35 : 0)) * t;
  healthState.anxiety = Math.max(0, Math.min(100, Number(healthState.anxiety) + anxDelta));
  healthState.depressionLevel = Math.max(0, Math.min(100, Number(healthState.depressionLevel) + depDelta));
  // 情绪稳定：焦虑/抑郁高则下降，否则缓慢回升
  const a = Number(healthState.anxiety), d = Number(healthState.depressionLevel);
  const stDelta = (a > 60 || d > 60 ? -1.0 : 0.4) * t;
  healthState.stability = Math.max(0, Math.min(100, Number(healthState.stability) + stDelta));
  // 专注力：受缺觉/焦虑/情绪稳定影响
  if (debt > 50 || a > 60) {
    healthState.focus = Math.max(0, Number(healthState.focus) - 0.6 * t);
  } else {
    healthState.focus = Math.min(100, Number(healthState.focus) + 0.5 * t);
  }
}

// ── 成就检测 ──
function checkAchievements() {
  if (!achievementOn()) return [];
  if (!healthState.achievements || typeof healthState.achievements !== 'object') healthState.achievements = {};
  const s = healthState;
  const organKeys = Object.keys(ORGAN_INFO);
  const avgOrgan = organKeys.reduce((a, k) => a + getOrgan(k), 0) / organKeys.length;
  let vitalScore = 0;
  try { vitalScore = getVitalScore(); } catch { vitalScore = 0; }
  const tests = {
    healthy_body:   Number(s.health) >= 90 && Array.isArray(s.diseases) && s.diseases.length === 0,
    marathon:       Number(s.exercise) >= 95,
    iron_lung:      getOrgan('lung') >= 95,
    all_organs:     avgOrgan >= 90,
    no_smoke:       getHabit('smoking') <= 5,
    sober:          getHabit('drinking') <= 5,
    early_bird:     getHabit('earlySleep') >= 80,
    zen_master:     getHabit('meditation') >= 80,
    calm_mind:      Number(s.anxiety) <= 10 && Number(s.depressionLevel) <= 10,
    vaccine_master: getAntibodyCount() >= 6,
    rich:           getMoney() >= 2000,
    vital_perfect:  vitalScore >= 98,
    imager:         Array.isArray(s.imagingHistory) && s.imagingHistory.length >= 5,
    survivor:       Number(s.medicalCost) >= 800,
    // —— v8.0 ——
    youthful:       (() => { const b = computeBiologicalAge(); return Number.isFinite(b.delta) && b.delta <= -5; })(),
    gut_healthy:    getGutScore() >= 90,
    allergy_free:   !!(s.allergenRolled && Object.keys(ALLERGENS).every(k => getAllergenLevel(k) === 0)),
    socially_rich:  (() => { const r = getRelationEffects(); return r.count >= 5 && r.avgAffinity >= 85; })(),
    insured:        isInsured() && ['employee', 'commercial'].includes(getInsurancePlan().key),
    historian:      Array.isArray(s.timeline) && s.timeline.length >= 30,
    // —— v9.0 ——
    first_work:     getHobbies().some(x => x.rec.works.length > 0),
    masterwork:     getHobbies().some(x => x.rec.works.some(w => w.quality === 'master')),
    prolific:       getHobbies().reduce((a, x) => a + x.rec.works.length, 0) >= 20,
    versatile:      getHobbies().length >= 5,
    grandmaster:    getHobbies().some(x => x.level >= 10),
    allrounder:     (() => { const cats = new Set(getHobbies().map(x => x.meta.cat)); return cats.size >= 5; })(),
    // —— v10.0 宠物 ——
    pet_owner:      getPets(true).length >= 1,
    first_trick:    getPets().some(p => p.tricks.length >= 1),
    pet_trainer:    getPets().some(p => p.tricks.length >= 6),
    pet_bond_max:   getPets().some(p => (Number(p.bond) || 0) >= 92),
    pet_doctor:     (Number(healthState.petVetCount) || 0) >= 5,
    pet_ranger:     getPets().length >= 4,
    // —— v11.0 日常生活 ——
    well_dressed:   (Number(getOutfitStats().perfectDays) || 0) >= 30,
    sun_aware:      (Number(getOutfitStats().sunGuard) || 0) >= 20,
    self_feeder:    (Number(getMealStats().home_cook) || 0) >= 30,
    foodie:         (() => { const st = getMealStats(); return Object.keys(MEALS).every(k => (Number(st[k]) || 0) >= 1); })(),
    home_master:    (Number(getHomeRec().tidy) || 0) >= 95,
    bill_payer:     (Number(getBillStats().paidCount) || 0) >= 6,
    // —— v12.0 钱币系统 ——
    first_gig:      (Number(getGigRec().count) || 0) >= 1,
    artisan:        (Number(getGigRec().count) || 0) >= 10,
    masterpiece:    (Number(getGigRec().best) || 0) >= 800,
    payday:         (Number(getWalletRec().payCount) || 0) >= 1,
    workhorse:      (Number(getWorkStats().count) || 0) >= 10,
    in_the_black:   (() => { const L = getLedgerSummary(); return L.totalIn > 0 && L.totalIn >= L.totalOut; })(),
    // —— v13.0 时间与社会 ——
    lifelong_learner: (Number(healthState.curiosity) || 0) >= 90,
    soft_heart:       (Number(healthState.empathy) || 0) >= 90,
    weekend_warrior:  getTimeStats().weekendDays >= 8,
    festive_soul:     getTimeStats().festivalDays >= 6,
    one_more_year:    getTimeStats().birthdays >= 1,
    storm_chaser:     getExtremeStats().count >= 3,
    chronic_master:   (() => {
      const r = healthState.remissions;
      if (!r || typeof r !== 'object') return false;
      return Object.values(r).some(v => v && (Number(v.count) || 0) >= 1);
    })()
  };
  const unlocked = [];
  for (const [k, ok] of Object.entries(tests)) {
    if (ok && !healthState.achievements[k]) {
      healthState.achievements[k] = Date.now();
      unlocked.push(k);
    }
  }
  if (unlocked.length) {
    log(`[健康系统] 🏆 解锁成就：${unlocked.map(k => ACHIEVEMENTS[k].name).join('、')}`);
    for (const k of unlocked) recordTimeline('🏆', `解锁成就「${ACHIEVEMENTS[k].name}」`, 'achievement');
  }
  return unlocked;
}

// ── 心理 / 睡眠 / 内分泌 / 外伤 / 疫情 / 习惯 情绪提示 ──
function getPsycheHint() {
  const a = Number(healthState.anxiety);
  const d = Number(healthState.depressionLevel);
  const parts = [];
  if (a >= 75) parts.push('你现在非常焦虑，心里发慌、静不下来，说话可能急躁或反复不安');
  else if (a >= 55) parts.push('你有些焦虑，容易紧张和担心');
  if (d >= 75) parts.push('你情绪非常低落，提不起兴趣，不太想说话');
  else if (d >= 55) parts.push('你有点低落，没什么干劲');
  if (Number(healthState.stability) < 35) parts.push('你情绪很不稳定，容易大起大落');
  if (Number(healthState.focus) < 35) parts.push('你完全没法集中注意力，容易走神');
  if (!parts.length) return '';
  return `【心理状态】${parts.join('；')}。请自然流露，但不要说"我的焦虑度是多少"这类数值。`;
}
function getSleepHint() {
  const debt = Number(healthState.sleepDebt);
  const st = SLEEP_STAGES[healthState.sleepStage] || SLEEP_STAGES.awake;
  if (debt >= 70) return `【睡眠】你严重睡眠不足（当前${st.emoji}${st.name}），脑子转不动、反应变慢。`;
  if (debt >= 45) return '【睡眠】你最近欠了不少觉，有点昏沉、打不起精神。';
  if (Number(healthState.caffeine) >= 60) return '【睡眠】咖啡因还没代谢完，你有点亢奋又困，心慌手抖。';
  return '';
}
function getHormoneHint() {
  const parts = [];
  if (getHormone('cortisol') >= 78) parts.push('皮质醇很高：压力激素爆表，你易怒又疲惫');
  if (getHormone('serotonin') <= 30) parts.push('血清素偏低：情绪容易低落');
  if (getHormone('thyroxine') >= 80) parts.push('甲状腺素偏高：心跳快、怕热、静不下来');
  if (getHormone('thyroxine') <= 32) parts.push('甲状腺素偏低：怕冷、乏力、反应慢');
  if (!parts.length) return '';
  return `【内分泌】${parts.join('；')}。`;
}
function getInjuryHint() {
  const inj = Array.isArray(healthState.injuries) ? healthState.injuries : [];
  if (!inj.length) return '';
  const top = inj[inj.length - 1];
  const info = INJURY_INFO[top.type] || { name: '伤' };
  return `【外伤】你的${top.part}${info.name}还没好，一动就疼，请自然表现出不便。`;
}
function getEpidemicHint() {
  const ep = healthState.epidemic || {};
  if (!ep.active) return '';
  const dn = getDiseaseInfo(ep.disease)?.name || ep.disease;
  return `【疫情】社区正在流行${dn}（${getEpidemicLevelName(ep.level)}），你有点担心被传染${healthState.maskOn ? '（戴着口罩）' : ''}。`;
}
function getHabitHint() {
  const parts = [];
  if (getHabit('smoking') >= 60) parts.push('烟瘾上来了，有点烦躁');
  if (getHabit('drinking') >= 60) parts.push('想喝两杯');
  if (getHabit('stayingUp') >= 60) parts.push('作息已经乱了，晚上特别精神');
  if (getHabit('sedentary') >= 60) parts.push('坐太久了，浑身发僵');
  if (!parts.length) return '';
  return `【习惯】${parts.join('；')}。`;
}

// ── 昼夜节律 / 菌群 / 过敏 / 关系网 / 生物年龄 情绪提示（v8.0）──
function getCircadianHint() {
  if (!circadianOn()) return '';
  const d = new Date();
  const c = getCircadianEffects(d.getHours() + d.getMinutes() / 60);
  const parts = [];
  if (c.phase.key === 'deep_night') parts.push('现在是深夜，你的生理机能处在全天谷底，非常困、反应也慢');
  else if (c.phase.key === 'night') parts.push('夜深了，褪黑素在上升，你开始犯困、只想躺下');
  else if (c.phase.key === 'afternoon') parts.push('刚过午后，你有点犯困、注意力发散（这是生理性的，不是懒）');
  else if (c.phase.key === 'morning') parts.push('上午是你一天里状态最好的时候，思路清晰、有干劲');
  else if (c.phase.key === 'evening') parts.push('傍晚体力正处在峰值，你感觉身体有劲');
  else if (c.phase.key === 'dawn') parts.push('你刚醒不久，还有一点起床气');
  if (c.melatonin >= 70) parts.push('实在太困了，眼皮发沉');
  if (c.cortisol >= 80) parts.push('皮质醇上来了，精神挺足');
  if (!parts.length) return '';
  return `【昼夜节律 · ${c.phase.name}】${parts.join('；')}。`;
}

function getGutHint() {
  if (!gutOn()) return '';
  const s = getGutScore();
  const parts = [];
  if (s < 35) parts.push('肚子一直不太舒服，胀气、排便也不规律');
  else if (s < 50) parts.push('肠胃最近有点闹脾气，吃什么都容易胀');
  if (getGut('barrier') < 42) parts.push('身上有种说不清的慢性疲惫和低度炎症感');
  if (getGutEffects().serotoninBase < -1.5) parts.push('情绪莫名低落，可能是肠道在影响心情（肠脑轴）');
  if (s >= 85) parts.push('肠胃很争气，消化顺畅、心情也稳');
  if (!parts.length) return '';
  return `【肠道菌群 · ${getGutLevel()}】${parts.join('；')}。`;
}

function getAllergyHint() {
  if (!allergyOn()) return '';
  const load = Number(healthState.allergyLoad) || 0;
  if (load <= 8) return '';
  const trg = Array.isArray(healthState.allergyTriggers) ? healthState.allergyTriggers : [];
  const why = trg.length ? `（${trg.map(t => t.name).join('、')}）` : '';
  if (load >= 68) return `【严重过敏 ${Math.round(load)}】你鼻塞得厉害、皮肤发痒、喘气都费劲${why}，特别想赶紧吃抗过敏药。`;
  if (load >= 45) return `【过敏发作 ${Math.round(load)}】你在不停打喷嚏、鼻子眼睛发痒${why}，挺难受的。`;
  return `【轻微过敏 ${Math.round(load)}】你${why}有点过敏反应，鼻子不太舒服、想揉眼睛。`;
}

function getRelationHint() {
  if (!relationOn()) return '';
  const rel = getRelationEffects();
  if (!rel.count) return '';
  const parts = [];
  if (rel.avgAffinity >= 85) parts.push(`你和${rel.closest ? rel.closest.name : '身边的人'}他们关系很亲近，心里有底气、有归属感`);
  else if (rel.avgAffinity < 45) parts.push('你和身边的人都疏远了，觉得有点孤零零的');
  if (rel.conflicts >= 5) parts.push('关系里还压着几件没解开的别扭，一想起来就堵得慌');
  else if (rel.conflicts >= 2) parts.push('有点小别扭还没说开');
  if ((Number(healthState.intimacy) || 0) < 35) parts.push('很久没人好好陪你说说话了，很想要一点亲近');
  if (!parts.length) return '';
  return `【社交关系】${parts.join('；')}。`;
}

function getBioAgeHint() {
  if (!bioAgeOn()) return '';
  const b = computeBiologicalAge();
  if (b.delta >= 14) return `【身体透支】你才 ${b.real} 岁，身体却像 ${b.bio} 岁——长期熬夜、坏习惯和压力正在把你掏空，该警惕了。`;
  if (b.delta >= 7) return `【状态偏差】你实际 ${b.real} 岁，但身体年龄已经 ${b.bio} 岁，比同龄人显老，得注意作息和饮食了。`;
  if (b.delta <= -6) return `【身体年轻】你实际 ${b.real} 岁，生理年龄只有 ${b.bio} 岁，保养得很好，精力比同龄人旺盛。`;
  return '';
}

function getOrganInfo(key) { return ORGAN_INFO[key] || { name: key, emoji: '🫀' }; }
function getOrgan(key) { return Number(healthState.organs?.[key] ?? 100); }
function getOrganLevel(v) {
  if (v >= 80) return '良好';
  if (v >= 60) return '一般';
  if (v >= 40) return '偏弱';
  if (v >= 20) return '受损';
  return '严重受损';
}
function getDiseaseOrgan(diseaseKey) { return DISEASE_ORGAN[diseaseKey] || (isChronic(diseaseKey) ? 'liver' : 'blood'); }

// 疾病损伤器官（阶段越重、损伤越大）
function damageOrgans(diseases, times = 1) {
  if (!healthState.organs) healthState.organs = { heart: 100, lung: 100, liver: 100, stomach: 100, kidney: 100, brain: 100, skin: 100, blood: 100 };
  const stageIdx = { '初期': 0, '中期': 1, '晚期': 2, '危重': 3 };
  let rate = 1;
  try { rate = Number(cfg()?.organDamageRate) || 1; } catch { /* 默认 1 */ }
  for (const d of (diseases || [])) {
    const organ = getDiseaseOrgan(d);
    const si = stageIdx[getDiseaseStage(d)] ?? 0;
    const dmg = (0.6 + si * 0.9) * rate * times;
    healthState.organs[organ] = Math.max(0, getOrgan(organ) - dmg);
  }
}

// 单器官损伤（供检验指标异常等使用）
function damageOrgan(key, amount) {
  if (!healthState.organs) healthState.organs = { heart: 100, lung: 100, liver: 100, stomach: 100, kidney: 100, brain: 100, skin: 100, blood: 100 };
  if (!(key in healthState.organs)) return 0;
  healthState.organs[key] = Math.max(0, getOrgan(key) - Math.abs(Number(amount) || 0));
  return healthState.organs[key];
}

// 器官修复：健康且无病时缓慢恢复，患病时几乎停滞
function regenOrgans(times = 1) {
  if (!healthState.organs) return;
  let rate = 1.2;
  try { rate = Number(cfg()?.organRegenRate) || 1.2; } catch { /* 默认 1.2 */ }
  const sick = healthState.diseases.length > 0;
  const lowHealth = Number(healthState.health) < 30;
  for (const k of Object.keys(ORGAN_INFO)) {
    let delta = sick ? -0.2 : rate;
    if (lowHealth) delta -= 0.3;
    healthState.organs[k] = Math.max(0, Math.min(100, getOrgan(k) + delta * times));
  }
}

// 器官受损对健康值的附加衰减
function calculateOrganImpact() {
  let impact = 0;
  for (const k of Object.keys(ORGAN_INFO)) {
    const v = getOrgan(k);
    if (v < 10) impact += 4;
    else if (v < 30) impact += 2;
    else if (v < 50) impact += 0.5;
  }
  return impact;
}

// 器官告警（供报告/情绪提示）
function getOrganWarnings() {
  const out = [];
  for (const k of Object.keys(ORGAN_INFO)) {
    const v = getOrgan(k);
    if (v < 30) out.push(`${getOrganInfo(k).emoji}${getOrganInfo(k).name}${getOrganLevel(v)}`);
  }
  return out;
}

// —— 病原体 / 潜伏期 / 免疫记忆 ——
function getPathogen(diseaseKey) {
  if (DISEASE_PATHOGEN[diseaseKey]) return DISEASE_PATHOGEN[diseaseKey];
  if (isChronic(diseaseKey)) return 'chronic';
  return 'functional';
}
function getPathogenInfo(diseaseKey) { return PATHOGEN_TYPES[getPathogen(diseaseKey)]; }
function getPathogenOf(diseaseKey) { return getPathogenInfo(diseaseKey); }

function isIncubating(diseaseKey) { return !!(healthState.incubating && healthState.incubating[diseaseKey]); }
function isDiagnosed(diseaseKey) { return !!(healthState.diagnosed && healthState.diagnosed[diseaseKey]); }

function hasAntibody(diseaseKey) {
  const t = healthState.antibodies?.[diseaseKey];
  return Number.isFinite(t) && t > Date.now();
}
// 痊愈后获得免疫记忆（仅对病毒/细菌类可免疫）
function grantAntibody(diseaseKey, days) {
  const type = getPathogen(diseaseKey);
  if (type !== 'virus' && type !== 'bacteria') return;
  if (!healthState.antibodies) healthState.antibodies = {};
  let d = Number(days);
  if (!Number.isFinite(d) || d <= 0) {
    d = 3;
    try { const c = Number(cfg()?.antibodyDays); if (Number.isFinite(c) && c > 0) d = c; } catch { /* 默认 3 天 */ }
  }
  healthState.antibodies[diseaseKey] = Date.now() + d * 86400000;
  log(`[健康系统] 获得免疫记忆：${diseaseKey}（${d} 天）`);
}
function getAntibodyCount() {
  const now = Date.now();
  return Object.keys(healthState.antibodies || {}).filter(k => healthState.antibodies[k] > now).length;
}

// 病原暴露统一入口：有潜伏期的进入潜伏，无潜伏期的直接发病
function enqueueExposure(diseaseKey, source) {
  if (!getDiseaseInfo(diseaseKey)) return false;
  if (healthState.diseases.includes(diseaseKey)) return false;
  if (hasAntibody(diseaseKey)) return false;
  if (isIncubating(diseaseKey)) return false;
  if (!healthState.incubating) healthState.incubating = {};
  const pt = getPathogenInfo(diseaseKey);
  let ticks = pt?.incubation || 0;
  // 潜伏期可被配置关闭
  try { if (cfg()?.incubationEnabled === false) ticks = 0; } catch { /* 保持默认 */ }
  if (ticks > 0) {
    let interval = 3600;
    try { interval = Number(cfg()?.decayInterval) || 3600; } catch { /* 默认 1 小时 */ }
    healthState.incubating[diseaseKey] = { until: Date.now() + ticks * interval * 1000, type: getPathogen(diseaseKey) };
    log(`[健康系统] 病原暴露：${diseaseKey} 进入潜伏期（${pt.name} × ${ticks} 周期）${source ? '（' + source + '）' : ''}`);
  } else {
    addDisease(diseaseKey);
    if (!healthState.pathogens) healthState.pathogens = {};
    healthState.pathogens[diseaseKey] = { type: getPathogen(diseaseKey), load: 60 };
    log(`[健康系统] 直接发病：${diseaseKey}${source ? '（' + source + '）' : ''}`);
  }
  return true;
}

// 潜伏期推进：到期发病；潜伏期内触发条件已消失 → 身体自行清除
function tickIncubation(detected) {
  const activated = [];
  const now = Date.now();
  if (!healthState.incubating) healthState.incubating = {};
  const detectedSet = new Set(detected || []);
  for (const key of Object.keys(healthState.incubating)) {
    const info = healthState.incubating[key];
    if (!info || Number(info.until) <= now) {
      delete healthState.incubating[key];
      addDisease(key);
      if (!healthState.pathogens) healthState.pathogens = {};
      healthState.pathogens[key] = { type: info?.type || getPathogen(key), load: 70 };
      activated.push(key);
      recordMedical(`发病：${getDiseaseInfo(key)?.name || key}（潜伏期结束）`);
      log(`[健康系统] 潜伏结束发病：${key}`);
    } else if (detected && !detectedSet.has(key)) {
      delete healthState.incubating[key];
      log(`[健康系统] 潜伏期自愈（身体扛住了）：${key}`);
    }
  }
  return activated;
}

// —— 体质辅助 ——
function getConstitutionKey() {
  const k = healthState.constitution;
  return CONSTITUTIONS[k] ? k : 'balanced';
}
function getConstitutionInfo() { return CONSTITUTIONS[getConstitutionKey()]; }
// 体质对某疾病的易感倍率（>1 表示更易感）
function getConstitutionRisk(diseaseKey) {
  const c = getConstitutionInfo();
  return Number(c?.riskMod?.[diseaseKey]) || 1;
}
// 体质对某状态衰减的倍率
function getConstitutionDecayMod(statusKey, decayKey) {
  const c = getConstitutionInfo();
  const m = c?.decayMod || {};
  const v = m[statusKey] ?? m[decayKey];
  return Number.isFinite(v) && v > 0 ? v : 1;
}

// —— 用药深化 ——
function getDrugEfficacy(medicineKey) {
  // 耐药性 0 → 药效 100%；耐药性 100 → 药效 35%（下限），鼓励换药/停药
  const r = Math.max(0, Math.min(100, Number(healthState.drugResistance?.[medicineKey]) || 0));
  return Math.max(0.35, 1 - r / 150);
}
function addDrugResistance(medicineKey, gain) {
  if (!healthState.drugResistance) healthState.drugResistance = {};
  let g = gain;
  if (g === undefined) { try { g = Number(cfg()?.drugResistanceGain); } catch { g = 12; } }
  if (!Number.isFinite(g)) g = 12;
  const cur = Number(healthState.drugResistance[medicineKey]) || 0;
  healthState.drugResistance[medicineKey] = Math.max(0, Math.min(100, cur + g));
}
function decayDrugResistance(times = 1) {
  if (!healthState.drugResistance) return;
  let step = 1;
  try { step = Number(cfg()?.drugResistanceDecay) || 1; } catch { /* 默认 1 */ }
  for (const k of Object.keys(healthState.drugResistance)) {
    healthState.drugResistance[k] = Math.max(0, healthState.drugResistance[k] - step * times);
  }
}
// 副作用：伤器官 / 涨不良状态
function applySideEffects(medicineKey) {
  let enabled = true;
  try { enabled = cfg()?.sideEffects !== false; } catch { /* 默认开启 */ }
  if (!enabled) return [];
  const list = MEDICINE_SIDE_EFFECTS[medicineKey] || [];
  const notes = [];
  for (const eff of list) {
    if (eff.chance !== undefined && Math.random() >= eff.chance) continue;
    if (eff.organ) {
      if (!healthState.organs) return notes;
      healthState.organs[eff.organ] = Math.max(0, getOrgan(eff.organ) + eff.delta);
      notes.push(`${getOrganInfo(eff.organ).name}${eff.delta < 0 ? '受损' : '改善'}`);
    } else if (eff.key) {
      const cur = Number(healthState[eff.key]) || 0;
      healthState[eff.key] = Math.max(0, Math.min(100, cur + eff.delta));
      notes.push(`${STATUSES[eff.key]?.name || eff.key}${eff.delta > 0 ? '上升' : '下降'}`);
    }
  }
  return notes;
}
function getMedicineStock(medicineKey) { return Number(healthState.medicineBox?.[medicineKey]) || 0; }
function consumeMedicine(medicineKey, n = 1) {
  if (!healthState.medicineBox) healthState.medicineBox = {};
  healthState.medicineBox[medicineKey] = Math.max(0, getMedicineStock(medicineKey) - n);
}
function getMedicineBoxSummary() {
  const out = [];
  for (const [k, med] of Object.entries(MEDICINES)) {
    const n = getMedicineStock(k);
    if (n > 0) out.push(`${med.emoji}${med.name}×${n}`);
  }
  return out;
}

// —— 医疗经济 ——
function getMoney() { return Number(healthState.money) || 0; }
// v12.0：所有进出账都过一遍 recordLedger，钱的来路和去向才有据可查。
//   mergeMs > 0 时与同类别上一条在时间窗内合并 —— 零钱是按周期滴灌的小额，
//   逐条记账会把流水刷满，也看不出「这个月杂项收了多少钱」。
function addMoney(n, cat = 'other', note = '', mergeMs = 0) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return;
  healthState.money = Math.min(999999, getMoney() + v);
  recordLedger('in', v, cat, note, mergeMs);
}
// 消费；不足返回 false（不扣款）
function spendMoney(n, cat = 'medical', note = '') {
  const v = Number(n) || 0;
  if (v <= 0) return true;
  if (getMoney() < v) return false;
  healthState.money = getMoney() - v;
  healthState.medicalCost = (Number(healthState.medicalCost) || 0) + v;
  recordLedger('out', v, cat, note);
  return true;
}
function getMedicalCost(key) {
  try { const v = Number(cfg()?.[`cost${key[0].toUpperCase()}${key.slice(1)}`]); if (Number.isFinite(v) && v >= 0) return v; } catch { /* 用默认 */ }
  return MEDICAL_COST[key] ?? 0;
}

// 获取当前季节
function getCurrentSeason() {
  const now = new Date();
  const month = now.getMonth() + 1; // 0-11

  if (month >= 3 && month <= 5) return 'spring';
  if (month >= 6 && month <= 8) return 'summer';
  if (month >= 9 && month <= 11) return 'autumn';
  return 'winter'; // 12, 1, 2
}

// ════════════════════════════════════════════════════════
// v13.0 时间与社会
//   ① 星期：工作日 / 周末的生活节律差异
//   ② 节日：公历固定节日 + 农历节日查表
//   ③ 极端天气事件：高温 / 寒潮 / 暴雨 / 台风 / 沙尘
//   ④ 生日：从"只记一行 log"升级为真实事件（见 celebrateBirthday）
//   ⑤ 慢性病缓解期（remissions）：接通 v3.0 预留的字段
// ⚠️ 所有日期判定必须走本地时间。用 toISOString() 会在 UTC+8 把日期算错 8 小时
//    —— localDayKey / localMonthKey 存在的理由相同。
// ════════════════════════════════════════════════════════

// ① 星期（0 = 周日，与 Date#getDay 一致）
//    relax / social：相对平日的生活节律修正（周末更松、社交欲望更强）
const WEEKDAYS = [
  { key: 'sun', name: '周日', emoji: '🌅', weekend: true,  relax: 0.20,  social: 6 },
  { key: 'mon', name: '周一', emoji: '💼', weekend: false, relax: -0.24, social: -5 },
  { key: 'tue', name: '周二', emoji: '📋', weekend: false, relax: -0.12, social: -2 },
  { key: 'wed', name: '周三', emoji: '📋', weekend: false, relax: -0.04, social: 0 },
  { key: 'thu', name: '周四', emoji: '📋', weekend: false, relax: -0.06, social: 0 },
  { key: 'fri', name: '周五', emoji: '🎉', weekend: false, relax: 0.18,  social: 5 },
  { key: 'sat', name: '周六', emoji: '🌞', weekend: true,  relax: 0.22,  social: 8 }
];

function getDayOfWeek(ts) {
  const t = toValidTime(ts);
  return Number.isNaN(t) ? new Date().getDay() : new Date(t).getDay();
}
function isWeekend(ts) { const d = getDayOfWeek(ts); return d === 0 || d === 6; }
function getWeekdayInfo(ts) { return WEEKDAYS[getDayOfWeek(ts)] || WEEKDAYS[1]; }
function weekdayOn() { try { return cfg()?.weekdayEnabled !== false; } catch { return true; } }

// ②-a 公历固定节日（MM-DD）
//   price：节假日物价倍率（作用于三餐与娱乐消费）；mood / social：当天加成
const FESTIVALS = {
  '01-01': { key: 'newyear',     name: '元旦',    emoji: '🎊', mood: 7,  social: 10, price: 1.15, bid: '今天开始是新的一年' },
  '02-14': { key: 'valentine',   name: '情人节',  emoji: '💐', mood: 6,  social: 8,  price: 1.25, bid: '街上到处是玫瑰' },
  '04-01': { key: 'aprilfool',   name: '愚人节',  emoji: '🤡', mood: 4,  social: 6,  price: 1.00, bid: '今天开玩笑不用负责' },
  '05-01': { key: 'labour',      name: '劳动节',  emoji: '🛠️', mood: 8,  social: 12, price: 1.30, bid: '小长假，到处都是人' },
  '06-01': { key: 'childrens',   name: '儿童节',  emoji: '🎈', mood: 5,  social: 4,  price: 1.05, bid: '楼下有小孩在放气球' },
  '10-01': { key: 'national',    name: '国庆节',  emoji: '🇨🇳', mood: 9,  social: 14, price: 1.35, bid: '长假第一天，朋友圈全是旅游照' },
  '11-11': { key: 'double11',    name: '双十一',  emoji: '🛒', mood: 5,  social: 2,  price: 0.88, bid: '购物车早就加满了' },
  '12-12': { key: 'double12',    name: '双十二',  emoji: '🛍️', mood: 3,  social: 2,  price: 0.92, bid: '年底最后一波促销' },
  '12-24': { key: 'xmas_eve',    name: '平安夜',  emoji: '🎄', mood: 7,  social: 10, price: 1.28, bid: '街上亮起了彩灯' },
  '12-25': { key: 'xmas',        name: '圣诞节',  emoji: '🎁', mood: 7,  social: 9,  price: 1.20, bid: '到处都在交换礼物' },
  '12-31': { key: 'newyear_eve', name: '跨年夜',  emoji: '🎆', mood: 10, social: 12, price: 1.30, bid: '一年又要过去了' }
};

// ②-b 农历节日：农历与公历不对应，只能按公历日期逐个查表。
//   表里没有的年份自动跳过（不会误判到别的日子），补数据只需追加条目。
const LUNAR_FESTIVALS = {
  '2026-02-16': { key: 'lunar_eve',  name: '除夕',   emoji: '🧧', mood: 12, social: 16, price: 1.40, bid: '一家人围在一起吃年夜饭' },
  '2026-02-17': { key: 'spring',     name: '春节',   emoji: '🧨', mood: 14, social: 18, price: 1.45, bid: '新年好，红包收了不少' },
  '2026-03-03': { key: 'lantern',    name: '元宵节', emoji: '🏮', mood: 7,  social: 8,  price: 1.10, bid: '吃了碗汤圆，甜到心里' },
  '2026-06-19': { key: 'dragonboat', name: '端午节', emoji: '🐲', mood: 7,  social: 8,  price: 1.12, bid: '粽子的咸甜之争又开始了' },
  '2026-08-19': { key: 'qixi',       name: '七夕',   emoji: '🌌', mood: 6,  social: 9,  price: 1.22, bid: '今晚的星星格外亮' },
  '2026-09-25': { key: 'midautumn',  name: '中秋节', emoji: '🥮', mood: 11, social: 14, price: 1.28, bid: '月饼配茶，月亮很圆' },
  '2026-10-18': { key: 'chongyang',  name: '重阳节', emoji: '🍂', mood: 5,  social: 7,  price: 1.06, bid: '该给家里打个电话了' },
  '2027-02-05': { key: 'lunar_eve',  name: '除夕',   emoji: '🧧', mood: 12, social: 16, price: 1.40, bid: '一家人围在一起吃年夜饭' },
  '2027-02-06': { key: 'spring',     name: '春节',   emoji: '🧨', mood: 14, social: 18, price: 1.45, bid: '新年好，红包收了不少' },
  '2027-02-20': { key: 'lantern',    name: '元宵节', emoji: '🏮', mood: 7,  social: 8,  price: 1.10, bid: '吃了碗汤圆，甜到心里' },
  '2027-06-09': { key: 'dragonboat', name: '端午节', emoji: '🐲', mood: 7,  social: 8,  price: 1.12, bid: '粽子的咸甜之争又开始了' },
  '2027-09-15': { key: 'midautumn',  name: '中秋节', emoji: '🥮', mood: 11, social: 14, price: 1.28, bid: '月饼配茶，月亮很圆' }
};

// 取今天的节日（先查农历表，再查公历表）。日期键复用 localDayKey 的本地时间口径。
function getTodayFestival(ts) {
  const t = toValidTime(ts);
  if (Number.isNaN(t)) return null;
  const d = new Date(t);
  const p = (n) => (n < 10 ? '0' + n : String(n));
  const md = `${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return LUNAR_FESTIVALS[`${d.getFullYear()}-${md}`] || FESTIVALS[md] || null;
}
function festivalOn() { try { return cfg()?.festivalEnabled !== false; } catch { return true; } }
// 节日物价倍率（作用于三餐花费）
function getFestivalPriceMul() {
  if (!festivalOn()) return 1;
  const f = getTodayFestival();
  return f && Number.isFinite(f.price) ? f.price : 1;
}

// ③ 极端天气事件：在 rollEnvironment 时小概率触发，随下一次环境刷新结束
const EXTREME_WEATHER = {
  heatwave:  { name: '高温预警', emoji: '🥵', seasons: ['summer'],            tempAdd: 9,   humidity: 6,   aqi: 10,  uv: 3,  mood: -4, comfort: -8,  risk: 'heatstroke',       desc: '热浪滚滚，柏油路都在冒烟' },
  coldwave:  { name: '寒潮',     emoji: '🥶', seasons: ['winter'],            tempAdd: -14, humidity: -6,  aqi: 6,   uv: -2, mood: -3, comfort: -10, risk: 'winter_frostbite', desc: '气温一夜掉了十几度' },
  rainstorm: { name: '暴雨',     emoji: '🌊', seasons: ['summer', 'autumn'], tempAdd: -4,  humidity: 22,  aqi: -10, uv: -3, mood: -5, comfort: -6,  risk: 'autumn_cold',      desc: '雨大到看不清路' },
  typhoon:   { name: '台风',     emoji: '🌀', seasons: ['summer', 'autumn'], tempAdd: -6,  humidity: 24,  aqi: -12, uv: -4, mood: -6, comfort: -8,  risk: 'winter_flu',       desc: '风把树吹得东倒西歪，外卖都停了', noDelivery: true },
  sandstorm: { name: '沙尘暴',   emoji: '🟤', seasons: ['spring'],            tempAdd: 1,   humidity: -14, aqi: 120, uv: -3, mood: -5, comfort: -7,  risk: 'rhinitis',         desc: '天是黄的，出门得戴口罩' }
};

function getExtremeInfo(key) { return EXTREME_WEATHER[key] || null; }
function extremeOn() { try { return cfg()?.extremeEnabled !== false; } catch { return true; } }
function getExtremeChance() {
  try { const v = Number(cfg()?.extremeChance); if (Number.isFinite(v) && v >= 0) return Math.max(0, Math.min(1, v)); } catch { /* 用默认 */ }
  return 0.02;
}
// 按当前季节抽一个极端天气（没有适配季节的事件就返回空）
//   概率口径：每次环境刷新（约每 3 小时）掷一次 → 折算下来平均约 1/7 的日子会遇到。
//   标定依据：0.07 时每天有 44% 概率撞上极端天气，那就不是「极端」了。
function rollExtremeWeather(season) {
  if (!extremeOn()) return '';
  if (Math.random() >= getExtremeChance()) return '';
  const pool = Object.keys(EXTREME_WEATHER).filter(k => EXTREME_WEATHER[k].seasons.includes(season));
  if (!pool.length) return '';
  return pool[Math.floor(Math.random() * pool.length)];
}

// ── v13.0 ④ 慢性病长期管理（接通 v3.0 预留的 remissions 字段）────────────
//   旧模型的问题：慢性病治不好、也去不掉 —— 三处治疗逻辑里都写着
//   `if (isChronic(d)) healthState.diseaseStages[d] = '初期'`，等于永久挂在疾病列表上。
//   于是「高血压」这类病既不会好转也不会消失，所谓长期管理没有任何意义。
//   新模型：靠「生活方式达标」累积控制进度，攒够 CHRONIC_CONTROL_NEED 次 → 转入缓解期；
//   缓解期内不会复发；缓解期结束且诱因仍在时卷土重来；生活方式垮掉则进度倒退。
//   三个抓手取饮食 / 运动 / 睡眠质量 —— 恰好都是玩家能主动经营的指标。
const CHRONIC_CONTROL_NEED = 3;  // 需要累积几次「稳定控制」才能缓解
const REMISSION_DAYS = 21;       // 缓解期长度（天）

function chronicControlOk() {
  const diet = Number(healthState.diet) || 0;
  const ex = Number(healthState.exercise) || 0;
  const sq = Number(healthState.sleepQuality) || 0;
  return diet >= 65 && ex >= 55 && sq >= 60;
}
function getChronicControl(key) {
  const m = healthState.chronicControl;
  if (!m || typeof m !== 'object') return 0;
  const v = Number(m[key]);
  return Number.isFinite(v) ? Math.max(0, v) : 0;
}
function bumpChronicControl(key, delta = 1) {
  if (!healthState.chronicControl || typeof healthState.chronicControl !== 'object') healthState.chronicControl = {};
  healthState.chronicControl[key] = Math.max(0, getChronicControl(key) + delta);
  return healthState.chronicControl[key];
}

// 慢性病的一次「治疗成功」：保持初期 + 只在生活方式达标时累积控制进度
function advanceChronic(key) {
  const info = getDiseaseInfo(key);
  healthState.diseaseStages[key] = '初期';
  if (!chronicControlOk()) {
    return { key, gained: false, control: getChronicControl(key), needs: CHRONIC_CONTROL_NEED, ok: false };
  }
  const c = bumpChronicControl(key, 1);
  if (c >= CHRONIC_CONTROL_NEED) {
    enterRemission(key);
    healthState.diseases = healthState.diseases.filter(x => x !== key);
    delete healthState.diseaseStages[key];
    recordTimeline('♻️', `${info ? info.name : key}控制住了，进入 ${REMISSION_DAYS} 天缓解期`, 'disease');
    return { key, gained: true, control: CHRONIC_CONTROL_NEED, needs: CHRONIC_CONTROL_NEED, ok: true, remission: true };
  }
  return { key, gained: true, control: c, needs: CHRONIC_CONTROL_NEED, ok: true };
}

// 进入缓解期（从疾病列表移出，期间不复发）
function enterRemission(key) {
  if (!isChronic(key)) return null;
  if (!healthState.remissions || typeof healthState.remissions !== 'object') healthState.remissions = {};
  const prev = healthState.remissions[key];
  healthState.remissions[key] = {
    since: Date.now(),
    until: Date.now() + REMISSION_DAYS * 86400000,
    count: (Number(prev && prev.count) || 0) + 1
  };
  if (healthState.chronicControl && typeof healthState.chronicControl === 'object') healthState.chronicControl[key] = 0;
  return healthState.remissions[key];
}
function isInRemission(key, ts) {
  const r = healthState.remissions && healthState.remissions[key];
  if (!r || typeof r !== 'object') return false;
  return (Number(r.until) || 0) > (Number(ts) || Date.now());
}
function getRemissionList() {
  const r = healthState.remissions;
  if (!r || typeof r !== 'object') return [];
  const now = Date.now();
  const out = [];
  for (const [k, v] of Object.entries(r)) {
    if (!v || typeof v !== 'object') continue;
    const info = getDiseaseInfo(k);
    if (!info) continue;
    const until = Number(v.until) || 0;
    if (until <= now) continue;
    out.push({
      key: k, name: info.name, emoji: info.emoji,
      remainDays: Math.max(0, Math.ceil((until - now) / 86400000)),
      count: Number(v.count) || 1
    });
  }
  return out;
}

// 缓解期到期清理 + 生活方式不达标时控制进度倒退（由主循环调用）
function updateRemissions(times = 1) {
  const r = healthState.remissions;
  if (r && typeof r === 'object') {
    const now = Date.now();
    for (const k of Object.keys(r)) {
      const rec = r[k];
      if (!rec || typeof rec !== 'object' || !getDiseaseInfo(k)) { delete r[k]; continue; }
      if ((Number(rec.until) || 0) <= now && !rec.noticed) {
        rec.noticed = true;
        const info = getDiseaseInfo(k);
        recordTimeline('♻️', `${info.emoji}${info.name}的缓解期结束了，得留意别让它回来`, 'disease');
      }
    }
  }
  // 饮食 / 运动 / 睡眠任一垮掉，已经攒下的控制进度就会往回退
  if (!chronicControlOk()) {
    const m = healthState.chronicControl;
    if (m && typeof m === 'object') {
      for (const k of Object.keys(m)) {
        const cur = getChronicControl(k);
        if (cur > 0) m[k] = Math.max(0, cur - 0.25 * times);
      }
    }
  }
}

// ── v13.0 ⑤ 生日事件 ─────────────────────────────────────
//   旧模型：生日只往 log 和大事记里写一行「过生日了，25 岁」，除此之外什么都没有。
//   新模型：心情/满足/社交大幅回补、亲友发来祝福（关系网亲密度上升）、一笔红包进账。
//   注意生日也不全是好事 —— 年龄增长会抬高基础衰减（见 agingOn 相关逻辑）。
function celebrateBirthday(newAge) {
  dailyBump('mood', 14);
  dailyBump('satisfaction', 10);
  dailyBump('social', 12);
  dailyBump('loneliness', -14);
  dailyBump('belonging', 8);
  // 红包：不走工资也不算接单，单独记「红包」类
  const redPacket = 66 + Math.floor(Math.random() * 20) * 6;
  addMoney(redPacket, 'gift', `生日红包（${newAge} 岁）`);
  // 亲友祝福：关系网里所有人亲密度小幅上升
  const greeted = [];
  try {
    for (const { bond } of getRelations()) {
      if (!bond) continue;
      const type = getRelationType(bond.relation);
      const before = Number(bond.affinity) || 0;
      bond.affinity = Math.min(type.cap, before + 4);
      if (bond.affinity > before) greeted.push(bond.name);
    }
  } catch { /* 关系网未初始化时跳过 */ }
  if (!healthState.timeStats || typeof healthState.timeStats !== 'object') {
    healthState.timeStats = { weekendDays: 0, festivalDays: 0, birthdays: 0, extremeDays: 0 };
  }
  healthState.timeStats.birthdays = (Number(healthState.timeStats.birthdays) || 0) + 1;
  recordTimeline('🎂', `过生日了，${newAge} 岁${greeted.length ? `，${greeted.length} 个人发来祝福` : ''}`, 'age');
  return { newAge, redPacket, greeted };
}

// ── v13.0 时间结算（主循环每周期调用）─────────────────────
//   ① 星期：周末有松弛感，周一最丧
//   ② 节日：当天一次性触发，之后仅保留物价影响
//   ③ 极端天气：舒适度与心情受损，首次遇到时记一次大事记
//   ④ 慢性病缓解期：到期清理 + 生活方式不达标则控制进度倒退
function updateTime(times = 1) {
  const t = Number(times) || 1;
  const now = Date.now();
  if (!healthState.timeStats || typeof healthState.timeStats !== 'object') {
    healthState.timeStats = { weekendDays: 0, festivalDays: 0, birthdays: 0, extremeDays: 0 };
  }
  const st = healthState.timeStats;

  // ① 星期
  //   ⚠️ 计数必须按「日历日」而不是按衰减周期 —— 默认 decayInterval 是 1 小时，
  //   若写成 weekendDays += t，一个周六就能刷出 24「天」，
  //   「周末战士 = 8 天」这种成就当天就解锁了，统计也彻底失去意义。
  //   状态加成则相反：那是连续效果，该按周期累计。
  if (weekdayOn()) {
    const wd = getWeekdayInfo(now);
    if (isWeekend(now)) {
      const dk = localDayKey(now);
      if (healthState.lastWeekendDay !== dk) {
        healthState.lastWeekendDay = dk;
        st.weekendDays = (Number(st.weekendDays) || 0) + 1;
      }
      dailyBump('mood', 0.18 * t);
      dailyBump('comfort', 0.12 * t);
      dailyBump('social', wd.social * 0.02 * t);
    } else {
      // 工作日的紧绷：周一最明显。注意 stress 是「高=无压力」，负值是压力上升
      if (wd.relax < 0) dailyBump('stress', wd.relax * 1.6 * t);
      dailyBump('social', wd.social * 0.02 * t);
    }
  }

  // ② 节日（同一天只触发一次）
  if (festivalOn()) {
    const f = getTodayFestival(now);
    if (f) {
      const stamp = `${localDayKey(now)}:${f.key}`;
      if (healthState.lastFestivalKey !== stamp) {
        healthState.lastFestivalKey = stamp;
        st.festivalDays = (Number(st.festivalDays) || 0) + 1;
        dailyBump('mood', f.mood);
        dailyBump('social', f.social);
        dailyBump('satisfaction', Math.round(f.mood * 0.5));
        recordTimeline(f.emoji, `${f.name}：${f.bid}`, 'festival');
      }
    }
  }

  // ③ 极端天气
  const env = healthState.env || {};
  const x = getExtremeInfo(env.extreme);
  if (x) {
    // 同上：天数按日历日去重，状态损耗按周期累计
    const xk = localDayKey(now);
    if (healthState.lastExtremeDay !== xk) {
      healthState.lastExtremeDay = xk;
      st.extremeDays = (Number(st.extremeDays) || 0) + 1;
    }
    dailyBump('comfort', x.comfort * 0.1 * t);
    dailyBump('mood', x.mood * 0.1 * t);
    if (!healthState.extremeStats || typeof healthState.extremeStats !== 'object') {
      healthState.extremeStats = { count: 0, byKey: {}, lastKey: '' };
    }
    const es = healthState.extremeStats;
    if (es.lastKey !== env.extreme) {
      es.lastKey = env.extreme;
      es.count = (Number(es.count) || 0) + 1;
      if (!es.byKey || typeof es.byKey !== 'object') es.byKey = {};
      es.byKey[env.extreme] = (Number(es.byKey[env.extreme]) || 0) + 1;
      recordTimeline(x.emoji, `${x.name}：${x.desc}`, 'weather');
    }
  } else if (healthState.extremeStats && typeof healthState.extremeStats === 'object') {
    healthState.extremeStats.lastKey = '';
  }

  // ④ 慢性病缓解期
  updateRemissions(t);
}

// 时间与极端天气统计（脏数据自愈，供成就与报表读取）
function getTimeStats() {
  const t = healthState.timeStats;
  if (!t || typeof t !== 'object') return { weekendDays: 0, festivalDays: 0, birthdays: 0, extremeDays: 0 };
  const num = (v) => (Number.isFinite(Number(v)) ? Math.max(0, Number(v)) : 0);
  return {
    weekendDays: num(t.weekendDays), festivalDays: num(t.festivalDays),
    birthdays: num(t.birthdays), extremeDays: num(t.extremeDays)
  };
}
function getExtremeStats() {
  const e = healthState.extremeStats;
  if (!e || typeof e !== 'object') return { count: 0, byKey: {} };
  return {
    count: Number.isFinite(Number(e.count)) ? Math.max(0, Number(e.count)) : 0,
    byKey: (e.byKey && typeof e.byKey === 'object' && !Array.isArray(e.byKey)) ? e.byKey : {}
  };
}

// 今日一览（星期 / 节日 / 天气 / 极端天气 / 缓解期）—— 「今天」动作与情绪提示共用
function getTodayBrief() {
  const now = Date.now();
  const wd = getWeekdayInfo(now);
  const f = festivalOn() ? getTodayFestival(now) : null;
  const env = healthState.env || {};
  const x = getExtremeInfo(env.extreme);
  const wx = getWeatherInfo(env.weather);
  const rem = getRemissionList();
  const lines = [`${wd.emoji} ${wd.name}${wd.weekend ? '（休息日）' : '（工作日）'}`];
  if (f) lines.push(`${f.emoji} ${f.name} —— ${f.bid}${f.price && f.price !== 1 ? `（物价 ×${f.price}）` : ''}`);
  lines.push(`${wx.emoji} ${wx.name}　${env.tempC}℃　湿度 ${env.humidity}%　AQI ${env.aqi}　紫外线 ${env.uv}（${getUvLevel(env.uv)}）`);
  if (x) lines.push(`${x.emoji} ${x.name} —— ${x.desc}`);
  if (rem.length) lines.push(`♻️ 缓解期中：${rem.map(r => `${r.name}（还剩 ${r.remainDays} 天）`).join('、')}`);
  return { weekday: wd, festival: f, extreme: x, weather: wx, remissions: rem, lines };
}

// 时间维度的情绪提示（并入 generateEmotionHint）
function getTimeHint() {
  const parts = [];
  const now = Date.now();
  const wd = getWeekdayInfo(now);
  const f = festivalOn() ? getTodayFestival(now) : null;
  const x = getExtremeInfo((healthState.env || {}).extreme);
  if (f) parts.push(`${f.emoji}今天是${f.name}，${f.bid}`);
  if (x) parts.push(`${x.emoji}${x.name}，${x.desc}`);
  if (wd.key === 'mon') parts.push('又是周一，浑身提不起劲');
  else if (wd.key === 'fri') parts.push('周五了，心思早就飘到周末去了');
  else if (wd.weekend) parts.push(`${wd.name}，不用赶时间的感觉真好`);
  const rem = getRemissionList();
  if (rem.length) parts.push(`♻️ ${rem.map(r => r.name).join('、')}还在缓解期，别松劲`);
  // 慢性病控制进度过半时给个正反馈
  const ctrl = Object.entries(healthState.chronicControl || {})
    .filter(([k, v]) => getDiseaseInfo(k) && Number(v) > 0)
    .map(([k, v]) => ({ name: getDiseaseInfo(k).name, v: Number(v) }));
  for (const c of ctrl) {
    if (c.v >= CHRONIC_CONTROL_NEED - 1) parts.push(`♻️${c.name}就快控制住了（${Math.floor(c.v)}/${CHRONIC_CONTROL_NEED}），再稳几天`);
  }
  return parts.length ? `【今天】${parts.join('；')}。` : '';
}

// 获取当前地区（简化版，基于 IP 或配置）
function getCurrentRegion() {
  // 简化：默认返回中国
  // 实际项目中可以调用 IP 地理位置 API
  return 'china';
}

// 定时器
let decayTimer = null;
let checkTimer = null;

// 状态配置
const STATUSES = {
  thirst: { name: '口渴度', emoji: '💧', decayKey: 'thirstDecay', category: '生理', moodEffect: '口渴' },
  hunger: { name: '饱食度', emoji: '🍚', decayKey: 'hungerDecay', category: '生理', moodEffect: '饿' },
  energy: { name: '精力值', emoji: '⚡', decayKey: 'energyDecay', category: '生理', moodEffect: '累' },
  health: { name: '健康值', emoji: '❤️', decayKey: 'healthDecay', category: '生理', moodEffect: '身体不适' },
  mood: { name: '心情值', emoji: '😊', decayKey: 'moodDecay', category: '心理', moodEffect: '心情' },
  sleep: { name: '睡眠需求', emoji: '😴', decayKey: 'sleepDecay', category: '生理', moodEffect: '困' },
  fatigue: { name: '疲劳度', emoji: '😪', decayKey: 'fatigueDecay', category: '生理', moodEffect: '疲劳' },
  comfort: { name: '舒适度', emoji: '🛋️', decayKey: 'comfortDecay', category: '环境', moodEffect: '不舒服' },
  stress: { name: '压力值', emoji: '😰', decayKey: 'stressDecay', category: '心理', moodEffect: '压力大' },
  loneliness: { name: '孤独感', emoji: '🥺', decayKey: 'lonelinessDecay', category: '社交', moodEffect: '孤独' },
  social: { name: '社交需求', emoji: '🤝', decayKey: 'socialDecay', category: '社交', moodEffect: '想社交' },
  satisfaction: { name: '满足感', emoji: '🎯', decayKey: 'satisfactionDecay', category: '心理', moodEffect: '不满足' },
  belonging: { name: '归属感', emoji: '🏠', decayKey: 'belongingDecay', category: '社交', moodEffect: '没归属感' },
  // —— 拓展维度（v0.5）——
  fever: { name: '发烧度', emoji: '🤒', decayKey: 'feverDecay', category: '生理', moodEffect: '发烧', badWhenHigh: true },
  addiction: { name: '成瘾度', emoji: '🎮', decayKey: 'addictionDecay', category: '心理', moodEffect: '上头', badWhenHigh: true },
  curiosity: { name: '求知欲', emoji: '🔍', decayKey: 'curiosityDecay', category: '心理', moodEffect: '好奇' },
  empathy: { name: '同理心', emoji: '💗', decayKey: 'empathyDecay', category: '心理', moodEffect: '共情' },
  security: { name: '安全感', emoji: '🛡️', decayKey: 'securityDecay', category: '社交', moodEffect: '不安' },
  immunity: { name: '抵抗力', emoji: '🧬', decayKey: 'immunityDecay', category: '生理', moodEffect: '免疫力低' },
  // —— v6.0 心理 / 睡眠 ——
  anxiety: { name: '焦虑度', emoji: '😟', decayKey: 'anxietyDecay', category: '心理', moodEffect: '焦虑', badWhenHigh: true },
  depressionLevel: { name: '抑郁度', emoji: '🌧️', decayKey: 'depressionDecay', category: '心理', moodEffect: '低落', badWhenHigh: true },
  stability: { name: '情绪稳定', emoji: '🧘', decayKey: 'stabilityDecay', category: '心理', moodEffect: '情绪不稳' },
  focus: { name: '专注力', emoji: '🎯', decayKey: 'focusDecay', category: '心理', moodEffect: '分心' },
  sleepDebt: { name: '睡眠负债', emoji: '😵', decayKey: 'sleepDebtDecay', category: '生理', moodEffect: '欠觉', badWhenHigh: true }
};

// ════════════════════════════════════════════════════════
// v7.0 基础需求深化系统
//   把 13 个基础维度从"一个 0-100 的数字"深化为：
//   ① 五阶段体感具象 ② 维度间连锁反应 ③ 深层生理亚成分
//   ④ 非线性恢复与溢出 ⑤ 身体信号预警
// ════════════════════════════════════════════════════════

// ① 五阶段体感命名（100-80 / 80-60 / 60-40 / 40-20 / 20-0）
const NEED_PHASES = {
  thirst:       ['水润', '微渴', '口渴', '脱水', '濒临脱水'],
  hunger:       ['饱足', '不饿', '有点饿', '饥饿', '饥肠辘辘'],
  energy:       ['精力充沛', '精神尚可', '有点乏', '疲惫', '精疲力竭'],
  health:       ['康健', '良好', '抱恙', '虚弱', '病危'],
  sleep:        ['清醒', '略有困意', '困倦', '很困', '困到极点'],
  fatigue:      ['神清气爽', '稍感疲劳', '疲劳', '很累', '彻底透支'],
  mood:         ['愉悦', '平静', '低落', '消沉', '崩溃边缘'],
  stress:       ['毫无压力', '略紧张', '有压力', '压力山大', '濒临崩溃'],
  satisfaction: ['非常满足', '比较满足', '还算凑合', '不满足', '内心空虚'],
  loneliness:   ['充实', '偶尔孤独', '有些孤单', '挺孤独', '极度孤独'],
  social:       ['不想社交', '社交适中', '有点社交饥饿', '很想找人聊', '极度渴望社交'],
  belonging:    ['归属感强', '有归属', '略感疏离', '缺乏归属', '无根漂泊'],
  comfort:      ['惬意', '舒适', '一般', '不太舒服', '浑身难受']
};

// ③ 深层生理亚成分
const SUBSYSTEM_INFO = {
  electrolyte:     { name: '电解质', emoji: '🧂', badWhenHigh: false, desc: '过低会喝不解渴，高温/出汗/腹泻加速流失' },
  calorieSurplus:  { name: '热量盈余', emoji: '🍔', badWhenHigh: true,  desc: '吃太多沉积为脂肪，长期推高体重与血脂' },
  mentalFatigue:   { name: '精神疲劳', emoji: '🧠', badWhenHigh: true,  desc: '用脑与社交的消耗，靠睡眠/冥想恢复，过高拖垮专注' },
  intimacy:        { name: '亲密需求', emoji: '💞', badWhenHigh: false, desc: '浅层社交不解渴，需要深聊与陪伴' },
  moodVolatility:  { name: '情绪波动', emoji: '🎢', badWhenHigh: true,  desc: '情绪稳定度低时上升，波动大易无端烦躁' },
  physicalReserve: { name: '体力储备', emoji: '🏋️', badWhenHigh: false, desc: '运动的底子，越高越经得起折腾' }
};

// ② 维度间连锁反应：来源维度跌破阈值后，持续拖累目标维度
const CASCADE_RULES = [
  { from: 'thirst',       below: 30, to: 'fatigue',       rate: -1.2, tip: '缺水让身体更容易疲劳' },
  { from: 'thirst',       below: 30, to: 'mood',          rate: -0.8, tip: '口渴会让人莫名烦躁' },
  { from: 'thirst',       below: 30, to: 'mentalFatigue', rate: 1.0,  tip: '缺水导致注意力涣散' },
  { from: 'hunger',       below: 30, to: 'mood',          rate: -1.0, tip: '饿肚子心情会变差' },
  { from: 'hunger',       below: 30, to: 'energy',        rate: -0.8, tip: '没吃东西就没力气' },
  { from: 'hunger',       below: 30, to: 'immunity',      rate: -1.2, tip: '长期饥饿拖垮免疫' },
  { from: 'energy',       below: 30, to: 'mentalFatigue', rate: 1.2,  tip: '精力见底，脑子也转不动' },
  { from: 'energy',       below: 30, to: 'focus',         rate: -1.0, tip: '没精力就难以专注' },
  { from: 'fatigue',      below: 30, to: 'immunity',      rate: -1.0, tip: '过度疲劳免疫力下降' },
  { from: 'fatigue',      below: 30, to: 'health',        rate: -0.6, tip: '累垮了身体' },
  { from: 'sleep',        below: 30, to: 'fatigue',       rate: -1.5, tip: '缺觉直接转化为疲劳' },
  { from: 'sleep',        below: 30, to: 'focus',         rate: -1.2, tip: '睡眠不足无法集中' },
  { from: 'sleep',        below: 30, to: 'anxiety',       rate: 1.0,  tip: '睡不好容易焦虑' },
  { from: 'stress',       below: 30, to: 'sleep',         rate: -1.2, tip: '压力大睡不踏实' },
  { from: 'stress',       below: 30, to: 'mood',          rate: -1.0, tip: '长期压力磨损心情' },
  { from: 'stress',       below: 30, to: 'immunity',      rate: -0.8, tip: '压力会抑制免疫' },
  { from: 'mood',         below: 30, to: 'mentalFatigue', rate: 0.8,  tip: '情绪低落消耗心神' },
  { from: 'mood',         below: 30, to: 'immunity',      rate: -0.6, tip: '心情差也伤身' },
  { from: 'loneliness',   below: 40, to: 'mood',          rate: -0.8, tip: '孤独在侵蚀心情' },
  { from: 'loneliness',   below: 40, to: 'belonging',     rate: -0.6, tip: '孤独久了归属感会瓦解' },
  { from: 'social',       below: 30, to: 'loneliness',    rate: -1.2, tip: '长期不社交会越来越孤独' },
  { from: 'social',       below: 30, to: 'belonging',     rate: -0.5, tip: '缺少连接，归属感流失' },
  { from: 'belonging',    below: 30, to: 'security',      rate: -1.0, tip: '没有归属就失去安全感' },
  { from: 'belonging',    below: 30, to: 'mood',          rate: -0.6, tip: '漂泊感让人低落' },
  { from: 'satisfaction', below: 30, to: 'mood',          rate: -0.8, tip: '长期不满足会消磨心情' },
  { from: 'satisfaction', below: 30, to: 'energy',        rate: -0.5, tip: '没有成就感就提不起劲' },
  { from: 'comfort',      below: 30, to: 'mood',          rate: -0.6, tip: '环境不舒服，心情也好不了' },
  { from: 'health',       below: 30, to: 'fatigue',       rate: -1.0, tip: '身体虚弱特别容易累' },
  { from: 'health',       below: 30, to: 'immunity',      rate: -1.5, tip: '健康透支则免疫崩溃' }
];

// ════════════════════════════════════════════════════════
// v8.0 生命节律与身心生态
//   ① 昼夜节律：24 小时真实生理曲线（精力/警觉/皮质醇/褪黑素/体温）
//   ② 肠道菌群：6 项菌群 × 营养吸收 / 肠脑轴 / 免疫 / 屏障
//   ③ 过敏系统：8 种过敏原 × 季节环境触发 → 过敏负荷 → 过敏类疾病
//   ④ 社交关系网：5 类关系 × 亲密度/亲密/矛盾 × 深聊与和解
//   ⑤ 生物年龄：9 类因素推算的生理年龄（与真实年龄的差值）
//   ⑥ 医保系统：4 档方案 × 百分比报销医疗费（含年度额度）
//   ⑦ 健康大事记：重要事件时间轴（供对话引用）
// ════════════════════════════════════════════════════════

// ① 昼夜节律：24 小时生理曲线（0-100 相对水平，数组下标 = 钟点）
//    依据真实昼夜节律：皮质醇晨起陡升（6-8 点峰）、体温午后达峰（16-18 点）、
//    褪黑素夜间为峰（22-2 点）、警觉度呈"上午高峰 + 午后低谷 + 傍晚次峰"双峰形。
const CIRCADIAN_CURVES = {
  energy:    [15, 10,  8,  8, 12, 25, 50, 72, 88, 95, 92, 85, 62, 48, 55, 72, 82, 78, 68, 58, 45, 35, 26, 18],
  alert:     [10,  6,  5,  5, 10, 22, 48, 70, 90, 97, 94, 86, 58, 42, 52, 74, 86, 80, 70, 58, 42, 32, 22, 14],
  cortisol:  [12,  8,  6,  6, 14, 40, 78, 96, 88, 72, 64, 60, 56, 50, 48, 46, 42, 36, 28, 22, 18, 16, 14, 12],
  melatonin: [88, 92, 95, 90, 70, 40, 18,  6,  2,  0,  0,  0,  2,  4,  6, 10, 16, 28, 46, 62, 76, 84, 88, 90],
  bodyTemp:  [35.8, 35.6, 35.5, 35.6, 35.7, 36.0, 36.3, 36.5, 36.7, 36.8, 36.8, 36.9, 37.0, 37.0, 36.9, 37.0, 37.0, 36.9, 36.8, 36.6, 36.4, 36.2, 36.0, 35.9]
};

const CIRCADIAN_PHASES = [
  { from: 0,  to: 5,  key: 'deep_night', name: '深夜低谷', emoji: '🌑', eff: 0.50, tip: '生理机能的谷底，此时清醒等于硬扛，判断力和免疫力都在最低点' },
  { from: 6,  to: 8,  key: 'dawn',       name: '晨间唤醒', emoji: '🌅', eff: 0.90, tip: '皮质醇陡升把身体叫醒，适合起床活动，此时晒太阳最能校准生物钟' },
  { from: 9,  to: 11, key: 'morning',    name: '上午高峰', emoji: '☀️', eff: 1.15, tip: '警觉度与体力双双登顶，一天里最适合用脑和运动的时段' },
  { from: 12, to: 15, key: 'afternoon',  name: '午后低谷', emoji: '🌤️', eff: 0.80, tip: '饭后的生理性困倦，反应变慢、容易走神，不宜硬撑高强度工作' },
  { from: 16, to: 19, key: 'evening',    name: '傍晚次峰', emoji: '🌇', eff: 1.05, tip: '体温与肌肉力量达到全天最高，运动表现最好，但警觉度不如上午' },
  { from: 20, to: 23, key: 'night',      name: '夜间沉静', emoji: '🌙', eff: 0.70, tip: '褪黑素开始爬升，身体在为睡眠做准备，越晚越不适合剧烈用脑' }
];

function circadianOn() {
  try { return cfg().circadianEnabled !== false; } catch { return true; }
}

// 生物钟相位偏移（配置初始值 + 睡眠生物钟偏移共同作用；正 = 相位后移的夜猫子）
function getCircadianOffset() {
  let off = 0;
  try { const o = Number(cfg().circadianOffsetInitial); if (Number.isFinite(o)) off = o; } catch { /* 默认 0 */ }
  const sc = Number(healthState.sleepClock);
  if (Number.isFinite(sc)) off += Math.max(-3, Math.min(3, sc * 0.25));
  return Math.max(-4, Math.min(4, off));
}

// 把钟点换算成"生理钟点"（相位后移时曲线整体延后，于是晚睡型的人上午更懵）
function getCircadianHour(hour) {
  const raw = Number(hour);
  const h = Number.isFinite(raw) ? raw : new Date().getHours();
  const off = circadianOn() ? getCircadianOffset() : 0;
  return ((h - off) % 24 + 24) % 24;
}

function getCircadianPhase(hour) {
  const h = getCircadianHour(hour);
  for (const p of CIRCADIAN_PHASES) {
    if (h >= p.from && h <= p.to) return p;
  }
  return CIRCADIAN_PHASES[0];
}

// 曲线取值（线性插值到分钟级，hour 可带小数）
// 内部统一换算成"生理钟点"，相位偏移在这里一次性生效 —— 调用方直接传钟表时间即可，
// 于是夜猫子型的人上午拿到的是更低的精力/警觉曲线值（这正是相位偏移的生理含义）。
function getCircadianValue(curveKey, hour) {
  const arr = CIRCADIAN_CURVES[curveKey];
  if (!Array.isArray(arr)) return 50;
  const raw = Number(hour);
  const phys = getCircadianHour(Number.isFinite(raw) ? raw : new Date().getHours());
  const safe = ((phys % 24) + 24) % 24;
  const lo = Math.floor(safe) % 24;
  const hi = (lo + 1) % 24;
  const t = safe - Math.floor(safe);
  const a = Number(arr[lo]); const b = Number(arr[hi]);
  const va = Number.isFinite(a) ? a : 50;
  const vb = Number.isFinite(b) ? b : 50;
  return va + (vb - va) * t;
}

// 生理倍率：以 50 为中轴，0 → 0.7 倍，100 → 1.3 倍（供衰减/恢复/激素修正）
function getCircadianMod(curveKey, hour) {
  const v = getCircadianValue(curveKey, hour);
  return 0.7 + (v / 100) * 0.6;
}

// 昼夜节律对"当前状态"的综合影响（供报告与情绪提示）
function getCircadianEffects(hour) {
  const h = Number.isFinite(Number(hour)) ? Number(hour) : new Date().getHours();
  const phase = getCircadianPhase(h);
  return {
    hour: h,
    phase,
    energy: Math.round(getCircadianValue('energy', h)),
    alert: Math.round(getCircadianValue('alert', h)),
    cortisol: Math.round(getCircadianValue('cortisol', h)),
    melatonin: Math.round(getCircadianValue('melatonin', h)),
    bodyTemp: Math.round(getCircadianValue('bodyTemp', h) * 10) / 10,
    // 夜间精力衰减更慢（在休息）、白天更快；睡眠需求反之
    energyDecay: getCircadianMod('energy', h) * (phase.key === 'deep_night' || phase.key === 'night' ? 0.55 : 1.15),
    sleepDecay: getCircadianMod('melatonin', h) * 1.3,
    focusMod: getCircadianMod('alert', h)
  };
}

// 建议的睡眠窗口（按相位偏移平移标准 23:00-07:00）
function getSleepWindow() {
  const off = Math.round(getCircadianOffset());
  const start = ((23 + off) % 24 + 24) % 24;
  const end = ((7 + off) % 24 + 24) % 24;
  const fmt = h => `${String(h).padStart(2, '0')}:00`;
  return { start, end, startText: fmt(start), endText: fmt(end) };
}

// ── ② 肠道菌群 ──
const GUT_FLORA = {
  bifido:      { name: '双歧杆菌',   emoji: '🦠', role: '免疫调节与消化' },
  lacto:       { name: '乳酸菌',     emoji: '🥛', role: '抑制有害菌繁殖' },
  bacteroides: { name: '拟杆菌',     emoji: '🌾', role: '分解膳食纤维' },
  firmicutes:  { name: '厚壁菌',     emoji: '🍖', role: '能量吸收' },
  diversity:   { name: '菌群多样性', emoji: '🌈', role: '整体稳健度' },
  barrier:     { name: '肠道屏障',   emoji: '🧱', role: '防止肠漏与毒素入血' }
};

function gutOn() {
  try { return cfg().gutEnabled !== false; } catch { return true; }
}

function getGut(key) {
  const g = healthState.gut;
  const v = g && typeof g === 'object' ? Number(g[key]) : NaN;
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

function setGut(key, value) {
  if (!GUT_FLORA[key]) return;
  if (!healthState.gut || typeof healthState.gut !== 'object') healthState.gut = {};
  const v = Number(value);
  healthState.gut[key] = Math.max(0, Math.min(100, Number.isFinite(v) ? v : 0));
}

function getGutScore() {
  const keys = Object.keys(GUT_FLORA);
  return keys.reduce((a, k) => a + getGut(k), 0) / keys.length;
}

function getGutLevel() {
  const s = getGutScore();
  if (s >= 80) return '菌群丰盈';
  if (s >= 65) return '菌群良好';
  if (s >= 50) return '菌群一般';
  if (s >= 35) return '菌群失衡';
  return '菌群崩溃';
}

// 菌群对全身的作用（肠脑轴 / 吸收率 / 免疫 / 消化）
function getGutEffects() {
  const s = getGutScore();
  const barrier = getGut('barrier');
  return {
    score: s,
    nutrientAbsorb: 0.7 + (s / 100) * 0.5,       // 营养品与膳食的吸收倍率 0.7~1.2
    serotoninBase: (s - 50) * 0.12,              // 血清素基线偏移（人体九成血清素在肠道合成）
    immunityMod: (s - 50) * 0.01,                // 抵抗力每次调节的附加量
    comfortMod: (s - 50) * 0.008,                // 舒适度自然回归偏移
    leakRisk: Math.max(0, 55 - barrier) * 0.5    // 屏障破损导致的慢性炎症风险
  };
}

// 抗生素等无差别杀伤（多样性掉得最快，屏障相对抗打）
function damageGut(amount) {
  if (!gutOn()) return 0;
  const a = Number(amount) || 0;
  if (a <= 0) return 0;
  for (const k of Object.keys(GUT_FLORA)) {
    const mul = k === 'diversity' ? 1.4 : k === 'barrier' ? 0.6 : 1;
    setGut(k, getGut(k) - a * mul);
  }
  return a;
}

function healGut(amount) {
  const a = Number(amount) || 0;
  if (a <= 0) return 0;
  for (const k of Object.keys(GUT_FLORA)) {
    const mul = (k === 'bifido' || k === 'lacto') ? 1.3 : 0.7;
    setGut(k, getGut(k) + a * mul);
  }
  return a;
}

// 菌群自然演变：吃得健康 + 纤维足 → 向好；反之恶化
function updateGut(times = 1) {
  if (!gutOn()) return;
  const t = Math.max(1, Math.min(8, Math.round(Number(times) || 1)));
  const dietRaw = Number(healthState.diet);
  const dietV = Number.isFinite(dietRaw) ? dietRaw : 60;
  const fiberRaw = healthState.nutrients && Number(healthState.nutrients.fiber);
  const fiber = Number.isFinite(fiberRaw) ? fiberRaw : 60;
  let drift = 0;
  if (dietV >= 60) drift += 0.35;
  else if (dietV < 45) drift -= 0.5;
  drift += (fiber - 55) * 0.006;
  const avg = getGutScore();
  for (const k of Object.keys(GUT_FLORA)) {
    if (k === 'diversity' || k === 'barrier') {
      // 多样性与屏障向整体均值回归，避免单点极端
      setGut(k, getGut(k) + (avg - getGut(k)) * 0.06 * t);
    } else {
      setGut(k, getGut(k) + drift * t);
    }
  }
}

// ── ③ 过敏系统 ──
const ALLERGENS = {
  pollen:   { name: '花粉',     emoji: '🌾', kind: '吸入', seasons: ['spring', 'autumn'], desc: '春秋花粉季发作，鼻痒、喷嚏、流泪' },
  dustmite: { name: '尘螨',     emoji: '🕷️', kind: '吸入', desc: '空气脏、灰尘多时加重，晨起鼻塞' },
  mold:     { name: '霉菌',     emoji: '🍄', kind: '吸入', desc: '潮湿梅雨天大量繁殖，诱发咳喘' },
  pet:      { name: '宠物皮屑', emoji: '🐾', kind: '吸入', desc: '接触猫狗毛发后发作' },
  seafood:  { name: '海鲜',     emoji: '🦐', kind: '食物', desc: '吃虾蟹贝类后起疹、腹痛，严重可休克' },
  peanut:   { name: '花生',     emoji: '🥜', kind: '食物', desc: '最危险的食源性过敏之一，微量即可诱发' },
  dairy:    { name: '乳制品',   emoji: '🥛', kind: '食物', desc: '喝奶后腹胀腹泻、起疹' },
  coldair:  { name: '冷空气',   emoji: '❄️', kind: '物理', desc: '遇冷风或气温骤降时鼻塞、气喘' }
};

const ALLERGY_LEVELS = ['不过敏', '极轻', '轻度', '中度', '重度', '极重度'];

function allergyOn() {
  try { return cfg().allergyEnabled !== false; } catch { return true; }
}

function getAllergenLevel(key) {
  const a = healthState.allergens;
  const v = a && typeof a === 'object' ? Number(a[key]) : NaN;
  return Number.isFinite(v) ? Math.max(0, Math.min(5, Math.round(v))) : 0;
}

function getAllergenLevelName(key) {
  return ALLERGY_LEVELS[getAllergenLevel(key)] || '不过敏';
}

// 生成过敏谱：家族过敏史 ×3、特禀体质 ×2.5 概率加成（只生成一次，可 force 重掷）
function rollAllergens(force = false) {
  if (!allergyOn()) return false;
  if (healthState.allergenRolled && !force) return false;
  const fam = Array.isArray(healthState.familyHistory) ? healthState.familyHistory : [];
  const famAllergy = fam.includes('allergy');
  let constKey = 'balanced';
  try { constKey = getConstitutionKey(); } catch { /* 默认平和质 */ }
  const tebing = constKey === 'tebing';
  let base = 0.18;
  if (famAllergy) base *= 3;
  if (tebing) base *= 2.5;
  base = Math.min(0.85, base);
  const out = {};
  const maxLv = (tebing || famAllergy) ? 5 : 4;
  for (const k of Object.keys(ALLERGENS)) {
    if (Math.random() < base) out[k] = 1 + Math.floor(Math.random() * maxLv);
  }
  healthState.allergens = out;
  healthState.allergenRolled = true;
  return true;
}

function getAllergenList() {
  return Object.keys(ALLERGENS).map(k => ({ key: k, info: ALLERGENS[k], level: getAllergenLevel(k), levelName: getAllergenLevelName(k) }));
}

// 过敏负荷：季节/环境触发的吸入与物理类过敏原持续作用（食物类在进食时单独掷）
function computeAllergyLoad() {
  if (!allergyOn()) { healthState.allergyLoad = 0; healthState.allergyTriggers = []; return 0; }
  const env = healthState.env && typeof healthState.env === 'object' ? healthState.env : {};
  const season = getCurrentSeason();
  const temp = Number(env.tempC); const hum = Number(env.humidity); const aqi = Number(env.aqi);
  let load = 0;
  const triggers = [];
  const add = (k, mul, why) => {
    const lv = getAllergenLevel(k);
    if (lv <= 0) return;
    const d = lv * 4 * mul;
    load += d;
    triggers.push({ key: k, name: ALLERGENS[k].name, emoji: ALLERGENS[k].emoji, why, delta: Math.round(d * 10) / 10 });
  };
  if (season === 'spring') add('pollen', 1.6, '春季花粉飘散');
  else if (season === 'autumn') add('pollen', 1.2, '秋季草木花粉');
  else if (season === 'winter') add('pollen', 0.2, '冬季花粉极少');
  else add('pollen', 0.5, '夏季花粉较少');
  // v11.0：尘螨住在床单被褥里，最相关的变量是「多久没打扫」—— 此前只认室外 AQI。
  //        补上这一环后，宠物掉毛 → 房间变脏 → 尘螨 → 过敏 才连成完整因果链。
  const miteMul = getMiteFactor();
  const homeRec = homeOn() ? getHomeRec() : null;
  const tidyLow = !!(homeRec && homeRec.tidy < 45);
  if (Number.isFinite(aqi) && aqi > 80) {
    add('dustmite', 1.4 * miteMul, `空气差（AQI ${Math.round(aqi)}）${tidyLow ? '，屋里也积着一层灰' : ''}`);
  } else if (tidyLow) {
    add('dustmite', 0.5 * miteMul, `房间${getHomeLevel().name}，床单被褥里大概全是螨虫`);
  } else if (homeRec && homeRec.miteRelief > 40) {
    add('dustmite', 0.5 * miteMul, '被子刚晒过，螨虫少了很多');
  } else {
    add('dustmite', 0.5 * miteMul, '日常环境中的尘螨');
  }
  if (Number.isFinite(hum) && hum > 78) add('mold', 1.6, `潮湿（湿度 ${Math.round(hum)}%）`);
  else if (Number.isFinite(hum) && hum > 65) add('mold', 0.7, '湿度偏高');
  if (Number.isFinite(temp) && temp < 8) add('coldair', 1.5, `低温（${Math.round(temp)}℃）`);
  else if (Number.isFinite(temp) && temp < 16) add('coldair', 0.8, '气温偏凉');
  // v10.0：家里养了宠物时，皮屑/毛屑负荷按宠物掉毛指数动态放大（petShed 由 updatePets 算好）
  const petShedIdx = Number(healthState.petShed) || 0;
  const ownPetCount = getPets().length;
  if (petShedIdx > 0) {
    add('pet', 0.35 + petShedIdx * 0.55 * getPetAllergyFactor(), `家里有 ${ownPetCount} 只宠物，皮屑和毛屑飘得到处都是`);
  } else {
    add('pet', 0.35, '环境中的宠物皮屑');
  }
  const clamped = Math.max(0, Math.min(100, Math.round(load * 10) / 10));
  healthState.allergyLoad = clamped;
  healthState.allergyTriggers = triggers;
  return clamped;
}

// 进食触发的食物过敏（eat / party 时调用）
function rollFoodAllergy() {
  if (!allergyOn()) return [];
  const eaten = [];
  for (const k of ['seafood', 'peanut', 'dairy']) {
    const lv = getAllergenLevel(k);
    if (lv <= 0) continue;
    if (Math.random() < 0.12 + lv * 0.06) {
      const add = lv * 5;
      healthState.allergyLoad = Math.min(100, Number(healthState.allergyLoad || 0) + add);
      eaten.push({ key: k, name: ALLERGENS[k].name, emoji: ALLERGENS[k].emoji, delta: add });
    }
  }
  return eaten;
}

function getAllergyLevelName(load) {
  const v = Number(load);
  if (!Number.isFinite(v) || v <= 8) return '无反应';
  if (v < 30) return '轻微';
  if (v < 50) return '轻度';
  if (v < 68) return '中度';
  if (v < 85) return '重度';
  return '危重';
}

// ── ④ 社交关系网 ──
const RELATION_TYPES = {
  family:    { name: '家人', emoji: '👪', cap: 100, decay: 0.15, deepGain: 4,  desc: '血脉相连，最稳固的关系' },
  partner:   { name: '恋人', emoji: '💗', cap: 100, decay: 0.25, deepGain: 9,  desc: '亲密度上限最高，也最需要维护' },
  bestie:    { name: '挚友', emoji: '🤝', cap: 95,  decay: 0.30, deepGain: 8,  desc: '能说心里话的人' },
  colleague: { name: '同事', emoji: '💼', cap: 80,  decay: 0.35, deepGain: 5,  desc: '日常共事，保持在礼貌距离' },
  online:    { name: '群友', emoji: '💬', cap: 75,  decay: 0.40, deepGain: 6,  desc: '线上认识的朋友，靠聊天维系' }
};

// 初始关系种子（首次运行时播下，让关系网不至于一片空白）
const RELATION_SEEDS = [
  { name: '妈妈', relation: 'family', affinity: 92, intimacy: 80 },
  { name: '爸爸', relation: 'family', affinity: 85, intimacy: 62 },
  { name: '示例用户', relation: 'bestie', affinity: 88, intimacy: 74 }
];

function relationOn() {
  try { return cfg().relationEnabled !== false; } catch { return true; }
}

function getRelationType(key) {
  return RELATION_TYPES[key] || RELATION_TYPES.online;
}

// 补齐关系字段（兼容旧版只有 name / affinity 的 bonds）
function ensureRelation(b) {
  if (!b || typeof b !== 'object') return b;
  if (!b.relation || !RELATION_TYPES[b.relation]) b.relation = 'online';
  const t = RELATION_TYPES[b.relation];
  const aff = Number(b.affinity);
  b.affinity = Number.isFinite(aff) ? Math.max(0, Math.min(t.cap, aff)) : 60;
  const im = Number(b.intimacy);
  b.intimacy = Number.isFinite(im) ? Math.max(0, Math.min(100, im)) : Math.round(b.affinity * 0.7);
  const cf = Number(b.conflicts);
  b.conflicts = Number.isFinite(cf) ? Math.max(0, Math.min(10, cf)) : 0;
  if (!Number.isFinite(Number(b.lastDeepTalk))) b.lastDeepTalk = 0;
  if (!Array.isArray(b.memories)) b.memories = [];
  return b;
}

function getRelations() {
  const bonds = healthState.bonds;
  if (!bonds || typeof bonds !== 'object') return [];
  return Object.entries(bonds).map(([uid, b]) => ({ uid, bond: ensureRelation(b) }));
}

// 首次运行时播下初始关系种子
function initRelations() {
  if (!relationOn()) return false;
  if (healthState.relationsSeed) return false;
  if (!healthState.bonds || typeof healthState.bonds !== 'object') healthState.bonds = {};
  let n = 3;
  try { const c = Number(cfg().relationSeedCount); if (Number.isFinite(c)) n = c; } catch { /* 默认 3 */ }
  RELATION_SEEDS.slice(0, Math.max(0, Math.min(RELATION_SEEDS.length, Math.round(n)))).forEach(s => {
    if (healthState.bonds[s.name]) return;
    healthState.bonds[s.name] = {
      name: s.name, relation: s.relation, affinity: s.affinity, intimacy: s.intimacy,
      conflicts: 0, lastDeepTalk: 0, lastChat: Date.now(), memories: []
    };
  });
  healthState.relationsSeed = true;
  return true;
}

// 关系网对情绪的反哺：亲密度与亲密满足 → 归属感 / 安全感 / 亲密需求 / 孤独
function getRelationEffects() {
  const list = getRelations();
  if (!list.length) {
    return { count: 0, avgAffinity: 0, avgIntimacy: 0, conflicts: 0, closest: null, loneliest: null, belonging: 0, security: 0, intimacy: 0, loneliness: 0 };
  }
  let sumAff = 0, sumIm = 0, sumCf = 0;
  let closest = null, loneliest = null;
  for (const { bond } of list) {
    sumAff += bond.affinity; sumIm += bond.intimacy; sumCf += bond.conflicts;
    if (!closest || bond.affinity > closest.affinity) closest = bond;
    if (!loneliest || bond.affinity < loneliest.affinity) loneliest = bond;
  }
  const n = list.length;
  const avgAff = sumAff / n, avgIm = sumIm / n;
  return {
    count: n,
    avgAffinity: Math.round(avgAff * 10) / 10,
    avgIntimacy: Math.round(avgIm * 10) / 10,
    conflicts: Math.round(sumCf * 10) / 10,
    closest, loneliest,
    belonging: (avgAff - 60) * 0.012,
    security: (avgAff - 60) * 0.008,
    intimacy: (avgIm - 60) * 0.02,
    loneliness: sumCf * 0.1
  };
}

// 关系随时间疏远：12 小时内聊过就不掉，冷淡久了开始积攒矛盾
function updateRelations(times = 1) {
  if (!relationOn()) return;
  const bonds = healthState.bonds;
  if (!bonds || typeof bonds !== 'object') return;
  const t = Math.max(1, Math.min(8, Math.round(Number(times) || 1)));
  const now = Date.now();
  for (const uid of Object.keys(bonds)) {
    const b = ensureRelation(bonds[uid]);
    const type = getRelationType(b.relation);
    const idle = now - (Number(b.lastChat) || 0) > 12 * 3600000;
    if (idle) b.affinity = Math.max(0, b.affinity - type.decay * t);
    if (b.affinity < 40) b.conflicts = Math.min(10, b.conflicts + 0.05 * t);
  }
}

function getRelationLevel(affinity) {
  const v = Number(affinity);
  if (!Number.isFinite(v)) return '陌生';
  if (v >= 90) return '生死之交';
  if (v >= 75) return '亲密无间';
  if (v >= 60) return '熟络';
  if (v >= 40) return '点头之交';
  if (v >= 20) return '有些生分';
  return '形同陌路';
}

// ── ⑤ 生物年龄 ──
function bioAgeOn() {
  try { return cfg().bioAgeEnabled !== false; } catch { return true; }
}

function clampNum(v, lo, hi, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : def;
}

// 综合 9 类因素推算生理年龄：器官/代谢/生活方式/习惯/心理/菌群/营养/外伤/过敏
function computeBiologicalAge() {
  const real = clampNum(healthState.age, 1, 150, 20);
  const factors = [];
  const push = (key, name, emoji, delta) => {
    const d = Number(delta);
    factors.push({ key, name, emoji, delta: Number.isFinite(d) ? Math.round(d * 100) / 100 : 0 });
  };

  // 1. 器官健康
  const ok = Object.keys(ORGAN_INFO);
  const organAvg = ok.length ? ok.reduce((a, k) => a + (typeof getOrgan === 'function' ? getOrgan(k) : 100), 0) / ok.length : 100;
  push('organ', '器官健康', '🫀', (80 - organAvg) * 0.09);

  // 2. 代谢指标
  let vs = 80;
  try { if (typeof getVitalScore === 'function') vs = Number(getVitalScore()) || 80; } catch { vs = 80; }
  push('vital', '代谢指标', '🩸', (88 - vs) * 0.08);

  // 3. 生活方式
  const lifeAvg = (clampNum(healthState.diet, 0, 100, 60) + clampNum(healthState.exercise, 0, 100, 60) + clampNum(healthState.sleepQuality, 0, 100, 60)) / 3;
  push('lifestyle', '生活方式', '🏃', (70 - lifeAvg) * 0.07);

  // 4. 坏习惯
  const habit = k => (typeof getHabit === 'function' ? Number(getHabit(k)) || 0 : 0);
  const badHabit = habit('smoking') + habit('drinking') + habit('stayingUp') * 0.7 + habit('sedentary') * 0.6;
  push('habit', '生活习惯', '🚬', badHabit * 0.028);

  // 5. 心理状态
  const mind = clampNum(healthState.anxiety, 0, 100, 0) + clampNum(healthState.depressionLevel, 0, 100, 0) - clampNum(healthState.stability, 0, 100, 80) * 0.4;
  push('mind', '心理状态', '🧠', mind * 0.038);

  // 6. 肠道菌群
  push('gut', '肠道菌群', '🦠', (70 - getGutScore()) * 0.045);

  // 7. 营养均衡
  const nk = typeof NUTRIENT_INFO === 'object' && NUTRIENT_INFO ? Object.keys(NUTRIENT_INFO) : [];
  let nutAvg = 70;
  if (nk.length) {
    nutAvg = nk.reduce((a, k) => a + (typeof getNutrient === 'function' ? clampNum(getNutrient(k), 0, 100, 70) : 70), 0) / nk.length;
  }
  push('nutrient', '营养均衡', '🥗', (70 - nutAvg) * 0.04);

  // 8. 外伤与损耗
  const injN = Array.isArray(healthState.injuries) ? healthState.injuries.length : 0;
  push('injury', '外伤损耗', '🩹', clampNum(healthState.scarCount, 0, 999, 0) * 0.10 + injN * 0.3);

  // 9. 过敏炎症
  push('allergy', '过敏炎症', '🤧', clampNum(healthState.allergyLoad, 0, 100, 0) * 0.03);

  const rawDelta = factors.reduce((a, f) => a + f.delta, 0);
  const delta = Math.max(-20, Math.min(30, rawDelta));
  const bio = Math.max(1, Math.min(150, real + delta));
  const out = {
    real,
    bio: Math.round(bio * 10) / 10,
    delta: Math.round(delta * 10) / 10,
    factors: factors.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  };
  healthState.bioAgeCache = out.bio;
  return out;
}

function getBioAgeLevel(delta) {
  const d = Number(delta);
  if (!Number.isFinite(d)) return '未知';
  if (d <= -8) return '逆龄奇观';
  if (d <= -3) return '保养得宜';
  if (d < 3) return '表里如一';
  if (d < 7) return '略有透支';
  if (d < 14) return '明显老化';
  return '未老先衰';
}

// ── ⑥ 医保系统 ──
const INSURANCE_PLANS = {
  none:       { name: '无医保',   emoji: '🚫', premium: 0,    rate: 0,    cap: 0,     desc: '全额自费，所有医疗支出都自己扛' },
  resident:   { name: '居民医保', emoji: '🧾', premium: 120,  rate: 0.50, cap: 2000,  desc: '基础保障，报销五成，年度上限 ¥2000' },
  employee:   { name: '职工医保', emoji: '🏥', premium: 400,  rate: 0.75, cap: 6000,  desc: '在职保障，报销七成半，年度上限 ¥6000' },
  commercial: { name: '商业保险', emoji: '💼', premium: 1200, rate: 0.90, cap: 20000, desc: '高端保障，报销九成，年度上限 ¥20000' }
};
const INSURANCE_TERM_MS = 365 * 86400000;

function insuranceOn() {
  try { return cfg().insuranceEnabled !== false; } catch { return true; }
}

function getInsurancePlan() {
  const ins = healthState.insurance;
  const key = ins && typeof ins === 'object' && INSURANCE_PLANS[ins.plan] ? ins.plan : 'none';
  return { key, info: INSURANCE_PLANS[key] };
}

// 医保是否在有效期内且额度未耗尽
function isInsured() {
  if (!insuranceOn()) return false;
  const ins = healthState.insurance;
  if (!ins || typeof ins !== 'object') return false;
  const plan = INSURANCE_PLANS[ins.plan];
  if (!plan || plan.rate <= 0) return false;
  const expire = Number(ins.expireAt) || 0;
  if (expire && Date.now() > expire) return false;
  return (Number(ins.usedThisYear) || 0) < plan.cap;
}

function getInsuranceRemaining() {
  const { info } = getInsurancePlan();
  const used = Number(healthState.insurance?.usedThisYear) || 0;
  return Math.max(0, info.cap - used);
}

// 计算某笔医疗费在医保下的自付额与报销额（不改变状态）
function applyInsurance(cost) {
  const total = Math.max(0, Math.round(Number(cost) || 0));
  const { key, info } = getInsurancePlan();
  const out = { total, paid: total, reimburse: 0, plan: key, planName: info.name };
  if (!isInsured()) return out;
  const used = Number(healthState.insurance.usedThisYear) || 0;
  const room = Math.max(0, info.cap - used);
  const reimburse = Math.min(Math.round(total * info.rate), room);
  out.reimburse = reimburse;
  out.paid = Math.max(0, total - reimburse);
  return out;
}

// 支付医疗费用（自动结算医保）。ok=false 表示自付额都不够
function payMedical(cost) {
  const r = applyInsurance(cost);
  const ok = spendMoney(r.paid);   // spendMoney(0) 恒为 true
  if (ok && r.reimburse > 0) {
    if (!healthState.insurance || typeof healthState.insurance !== 'object') {
      healthState.insurance = { plan: 'none', since: 0, expireAt: 0, usedThisYear: 0 };
    }
    healthState.insurance.usedThisYear = (Number(healthState.insurance.usedThisYear) || 0) + r.reimburse;
    // medicalCost 记的是"实际发生的医疗总支出"（自付 + 报销），与支出账目一致
    healthState.medicalCost = (Number(healthState.medicalCost) || 0) + r.reimburse;
  }
  return { ok, paid: ok ? r.paid : 0, reimburse: ok ? r.reimburse : 0, total: r.total };
}

// 布尔版：语义与 spendMoney 一致，但自动走医保结算（供原有 if (!payMedicalOk(x)) 调用点直接替换）
function payMedicalOk(cost) {
  return payMedical(cost).ok;
}

// ── ⑦ 健康大事记 ──
const TIMELINE_CAP = 60;

function timelineOn() {
  try { return cfg().timelineEnabled !== false; } catch { return true; }
}

function recordTimeline(emoji, text, type = 'event') {
  if (!timelineOn()) return null;
  if (!Array.isArray(healthState.timeline)) healthState.timeline = [];
  const item = { at: Date.now(), emoji: String(emoji || '📌'), text: String(text || ''), type: String(type || 'event') };
  healthState.timeline.push(item);
  if (healthState.timeline.length > TIMELINE_CAP) {
    healthState.timeline = healthState.timeline.slice(-TIMELINE_CAP);
  }
  return item;
}

// 最近 n 条（倒序，最新在前）
function getTimelineRecent(n = 5) {
  const arr = Array.isArray(healthState.timeline) ? healthState.timeline : [];
  const k = Math.max(1, Math.round(Number(n) || 5));
  return arr.slice(-k).reverse();
}

function formatTimelineItem(it) {
  if (!it || typeof it !== 'object') return '';
  const d = new Date(Number(it.at) || 0);
  const pad = x => String(x).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${it.emoji || '📌'} ${stamp}　${it.text || ''}`;
}

// 费用文案（带医保报销说明）
function costText(pay) {
  const p = pay && typeof pay === 'object' ? pay : { paid: Number(pay) || 0, reimburse: 0 };
  const paid = Number(p.paid) || 0;
  const re = Number(p.reimburse) || 0;
  if (re > 0) return `¥${paid}，医保报销 ¥${re}`;
  return `¥${paid}`;
}

// ══════════════════════════════════════════════════════════════════════
// v9.0 爱好与技能树（Hobby & Skill Tree）
// 让机器人有"自己热爱的事"：学 → 练 → 熟练度 → 作品 → 分享；
// 同时把"练过头"的代价（劳损 / 视疲劳 / 兴趣耗竭）也算进身体账本。
// ══════════════════════════════════════════════════════════════════════

// 爱好大类
const HOBBY_CATEGORIES = {
  music:   { name: '音乐', emoji: '🎵' },
  art:     { name: '美术', emoji: '🎨' },
  sport:   { name: '运动', emoji: '🏃' },
  craft:   { name: '手艺', emoji: '🔨' },
  mind:    { name: '学识', emoji: '📚' },
  digital: { name: '数码', emoji: '💻' },
  life:    { name: '生活', emoji: '🍳' }
};

// 熟练度等级阶梯（累计经验门槛，10 级封顶）
const HOBBY_TIERS = [
  { lv: 0,  name: '门外汉', min: 0 },
  { lv: 1,  name: '初学',   min: 25 },
  { lv: 2,  name: '入门',   min: 70 },
  { lv: 3,  name: '熟练',   min: 145 },
  { lv: 4,  name: '擅长',   min: 250 },
  { lv: 5,  name: '精通',   min: 390 },
  { lv: 6,  name: '高手',   min: 570 },
  { lv: 7,  name: '大师',   min: 800 },
  { lv: 8,  name: '宗师',   min: 1080 },
  { lv: 9,  name: '泰斗',   min: 1420 },
  { lv: 10, name: '传奇',   min: 1820 }
];

// 里程碑（每个爱好通用，按等级解锁且只记一次）
const HOBBY_MILESTONES = [
  { lv: 3, name: '小成', emoji: '🥉', bonus: '练这个爱好时心情与满足收益 +10%' },
  { lv: 6, name: '大成', emoji: '🥈', bonus: '作品品质权重上移，更容易出精品' },
  { lv: 9, name: '登峰', emoji: '🥇', bonus: '该爱好的热情不再随时间衰减' }
];

// 作品品质四档
//   gift = 送人时加的亲密度；price = v12.0 接单卖出时的价格倍率
//   （两者口径不同：送礼看心意，卖钱看行情 —— 杰作卖价是合格品的 4 倍多）
const WORK_QUALITIES = {
  rough:  { name: '习作',   emoji: '📄', score: 1, gift: 2,  price: 0.45 },
  fine:   { name: '合格品', emoji: '📝', score: 2, gift: 5,  price: 1.00 },
  great:  { name: '精良品', emoji: '🏅', score: 3, gift: 9,  price: 2.00 },
  master: { name: '杰作',   emoji: '👑', score: 4, gift: 16, price: 4.20 }
};
const WORK_QUALITY_ORDER = ['rough', 'fine', 'great', 'master'];
const HOBBY_WORK_CAP = 30;

// 爱好表：
//   cost 学习花费(¥) / xp 单次经验 / energy 精力 / body 体力储备 / mental 精神疲劳
//   mood 心情收益 / stress 减压 / strain 上肢劳损系数 / eye 视疲劳系数
//   social 社交增益 / add 成瘾度增量
// v13.0：新增 curio / empathy —— 每门爱好对「求知欲」与「同理心」的补给系数。
//   这两个维度从 v0.5 起就登记在 STATUSES 里、也一直挂着 decayKey 在衰减，
//   但全插件 53 个 dailyBump/restoreNeed 调用点里没有任何一处提升过它们，
//   于是它们只会单调掉到 0，还会持续触发「好无聊 / 有点麻木」的提示。
//   标定：自我锻炼型（跑步/游泳）几乎不涨，观察与表达型（读书/摄影/唱歌）涨得多。
const HOBBIES = {
  guitar:      { name: '弹吉他', emoji: '🎸', cat: 'music',   cost: 30, xp: 10, energy: 10, body: 1.0, mental: 3, mood: 7,  stress: 6,  strain: 1.4, eye: 0.2, social: 2, add: 0.2, curio: 0.4, empathy: 0.9 },
  piano:       { name: '弹钢琴', emoji: '🎹', cat: 'music',   cost: 60, xp: 11, energy: 11, body: 1.0, mental: 4, mood: 8,  stress: 6,  strain: 1.2, eye: 0.6, social: 2, add: 0.2, curio: 0.5, empathy: 1.0 },
  singing:     { name: '唱歌',   emoji: '🎤', cat: 'music',   cost: 15, xp: 9,  energy: 8,  body: 1.0, mental: 2, mood: 9,  stress: 8,  strain: 0.3, eye: 0.1, social: 4, add: 0.2, curio: 0.2, empathy: 1.2 },
  painting:    { name: '画画',   emoji: '🎨', cat: 'art',     cost: 25, xp: 10, energy: 9,  body: 0.5, mental: 4, mood: 8,  stress: 7,  strain: 1.3, eye: 1.0, social: 1, add: 0.2, curio: 0.9, empathy: 1.1 },
  photography: { name: '摄影',   emoji: '📷', cat: 'art',     cost: 80, xp: 11, energy: 12, body: 3.0, mental: 3, mood: 9,  stress: 6,  strain: 0.8, eye: 1.1, social: 3, add: 0.2, curio: 1.3, empathy: 0.9 },
  calligraphy: { name: '书法',   emoji: '🖌️', cat: 'art',     cost: 20, xp: 9,  energy: 8,  body: 0.5, mental: 5, mood: 7,  stress: 8,  strain: 1.1, eye: 1.2, social: 1, add: 0.1, curio: 1.0, empathy: 0.4 },
  running:     { name: '跑步',   emoji: '🏃', cat: 'sport',   cost: 20, xp: 10, energy: 14, body: 12.0,mental: 2, mood: 8,  stress: 9,  strain: 0.4, eye: 0.0, social: 1, add: 0.2, curio: 0.3, empathy: 0.2 },
  swimming:    { name: '游泳',   emoji: '🏊', cat: 'sport',   cost: 40, xp: 11, energy: 15, body: 14.0,mental: 2, mood: 9,  stress: 8,  strain: 0.6, eye: 0.2, social: 2, add: 0.2, curio: 0.3, empathy: 0.2 },
  yoga:        { name: '瑜伽',   emoji: '🧘', cat: 'sport',   cost: 25, xp: 9,  energy: 8,  body: 6.0, mental: 3, mood: 8,  stress: 10, strain: 0.5, eye: 0.1, social: 1, add: 0.15, curio: 0.7, empathy: 0.8 },
  dancing:     { name: '跳舞',   emoji: '💃', cat: 'sport',   cost: 30, xp: 10, energy: 13, body: 10.0,mental: 2, mood: 10, stress: 8,  strain: 0.7, eye: 0.1, social: 4, add: 0.2, curio: 0.5, empathy: 1.0 },
  woodwork:    { name: '木工',   emoji: '🪚', cat: 'craft',   cost: 50, xp: 10, energy: 13, body: 8.0, mental: 4, mood: 7,  stress: 7,  strain: 1.6, eye: 0.5, social: 1, add: 0.2, curio: 0.8, empathy: 0.3 },
  knitting:    { name: '编织',   emoji: '🧶', cat: 'craft',   cost: 15, xp: 9,  energy: 7,  body: 1.0, mental: 4, mood: 7,  stress: 9,  strain: 1.5, eye: 1.0, social: 1, add: 0.15, curio: 0.6, empathy: 0.5 },
  cooking:     { name: '做饭',   emoji: '🍳', cat: 'life',    cost: 20, xp: 9,  energy: 10, body: 4.0, mental: 3, mood: 8,  stress: 6,  strain: 0.8, eye: 0.3, social: 3, add: 0.1, curio: 0.6, empathy: 0.8 },
  baking:      { name: '烘焙',   emoji: '🧁', cat: 'life',    cost: 30, xp: 10, energy: 11, body: 4.0, mental: 4, mood: 9,  stress: 6,  strain: 1.0, eye: 0.4, social: 3, add: 0.15, curio: 0.7, empathy: 0.8 },
  gardening:   { name: '养花',   emoji: '🪴', cat: 'life',    cost: 15, xp: 8,  energy: 7,  body: 4.0, mental: 2, mood: 9,  stress: 9,  strain: 0.7, eye: 0.3, social: 1, add: 0.1, curio: 1.0, empathy: 0.6 },
  reading:     { name: '读书',   emoji: '📚', cat: 'mind',    cost: 15, xp: 9,  energy: 6,  body: 0.0, mental: 5, mood: 7,  stress: 7,  strain: 0.4, eye: 1.4, social: 1, add: 0.1, curio: 2.4, empathy: 1.2 },
  chess:       { name: '下棋',   emoji: '♟️', cat: 'mind',    cost: 15, xp: 10, energy: 7,  body: 0.0, mental: 6, mood: 7,  stress: 5,  strain: 0.4, eye: 1.0, social: 3, add: 0.2, curio: 1.4, empathy: 0.5 },
  coding:      { name: '编程',   emoji: '💻', cat: 'digital', cost: 40, xp: 11, energy: 10, body: 0.5, mental: 7, mood: 7,  stress: 5,  strain: 1.3, eye: 1.8, social: 1, add: 0.3, curio: 1.8, empathy: 0.2 },
  gaming:      { name: '电竞',   emoji: '🎮', cat: 'digital', cost: 30, xp: 10, energy: 11, body: 0.5, mental: 4, mood: 10, stress: 6,  strain: 1.2, eye: 1.9, social: 3, add: 1.2, curio: 0.5, empathy: 0.3 }
};

function hobbyOn() {
  try { return cfg().hobbyEnabled !== false; } catch { return true; }
}

function getHobbyMeta(key) {
  return HOBBIES[key] || null;
}

function getHobbyCat(key) {
  const m = HOBBIES[key];
  return m ? (HOBBY_CATEGORIES[m.cat] || HOBBY_CATEGORIES.life) : HOBBY_CATEGORIES.life;
}

function getHobbyMaxSlots() {
  try { const n = Number(cfg().hobbyMaxSlots); if (Number.isFinite(n)) return Math.max(1, Math.min(9, Math.round(n))); } catch { /* 默认 3 */ }
  return 3;
}

function getHobbyLearnCost() {
  try { const n = Number(cfg().hobbyLearnCost); if (Number.isFinite(n) && n >= 0) return n; } catch { /* 默认 25 */ }
  return 25;
}

function getHobbyPassionDecay() {
  try { const n = Number(cfg().hobbyPassionDecay); if (Number.isFinite(n) && n >= 0) return n; } catch { /* 默认 1.2 */ }
  return 1.2;
}

function getHobbyStrainDecay() {
  try { const n = Number(cfg().hobbyStrainDecay); if (Number.isFinite(n) && n >= 0) return n; } catch { /* 默认 1.6 */ }
  return 1.6;
}

// 由累计经验查熟练度等级（0-10）
function getHobbyLevel(xp) {
  const v = Math.max(0, Number(xp) || 0);
  let lv = 0;
  for (const t of HOBBY_TIERS) { if (v >= t.min) lv = t.lv; else break; }
  return lv;
}

function getHobbyLevelName(lv) {
  const k = Math.max(0, Math.min(10, Math.round(Number(lv) || 0)));
  const t = HOBBY_TIERS[k];
  return t ? t.name : '门外汉';
}

// 进度：当前等级 / 下一等级门槛 / 百分比（满级时 maxed=true）
function getHobbyProgress(xp) {
  const v = Math.max(0, Number(xp) || 0);
  const lv = getHobbyLevel(v);
  const cur = HOBBY_TIERS[lv] ? HOBBY_TIERS[lv].min : 0;
  const nextT = HOBBY_TIERS[lv + 1];
  if (!nextT) return { level: lv, levelName: getHobbyLevelName(lv), xp: v, cur, next: v, need: 0, pct: 100, maxed: true };
  const span = nextT.min - cur;
  const pct = span > 0 ? Math.max(0, Math.min(100, ((v - cur) / span) * 100)) : 100;
  return { level: lv, levelName: getHobbyLevelName(lv), xp: v, cur, next: nextT.min, need: nextT.min - v, pct, maxed: false };
}

// 补齐爱好记录字段（兼容旧档 / 脏数据）
function ensureHobby(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (!Number.isFinite(Number(rec.xp))) rec.xp = 0;
  rec.xp = Math.max(0, Number(rec.xp));
  if (!Number.isFinite(Number(rec.passion))) rec.passion = 70;
  rec.passion = Math.max(0, Math.min(100, Number(rec.passion)));
  if (!Number.isFinite(Number(rec.practiceCount))) rec.practiceCount = 0;
  rec.practiceCount = Math.max(0, Math.round(Number(rec.practiceCount)));
  if (!Array.isArray(rec.works)) rec.works = [];
  if (!Number.isFinite(Number(rec.learnedAt))) rec.learnedAt = Date.now();
  if (!Number.isFinite(Number(rec.lastPractice))) rec.lastPractice = 0;
  if (!rec.milestones || typeof rec.milestones !== 'object') rec.milestones = {};
  return rec;
}

// 已学爱好列表（按熟练度倒序）
function getHobbies() {
  const h = healthState.hobbies;
  if (!h || typeof h !== 'object') return [];
  const list = [];
  for (const key of Object.keys(h)) {
    if (!HOBBIES[key]) continue;                 // 未知爱好（表被删过）直接跳过
    const rec = ensureHobby(h[key]);
    if (!rec) continue;
    list.push({ key, rec, meta: HOBBIES[key], cat: getHobbyCat(key), level: getHobbyLevel(rec.xp), works: rec.works.length });
  }
  return list.sort((a, b) => (b.level - a.level) || (b.rec.xp - a.rec.xp));
}

function isHobbyLearned(key) {
  return !!(healthState.hobbies && typeof healthState.hobbies === 'object' && healthState.hobbies[key] && HOBBIES[key]);
}

// 安全加减一个 0-100 的状态维度
function hobbyBump(key, delta, lo = 0, hi = 100) {
  const cur = Number(healthState[key]);
  const base = Number.isFinite(cur) ? cur : lo;
  healthState[key] = Math.max(lo, Math.min(hi, base + delta));
  return healthState[key];
}

// 爱好花费不计入医疗支出（学习与器材是生活消费）
function spendHobbyMoney(n, note = '') {
  const v = Number(n) || 0;
  if (v <= 0) return true;
  if (getMoney() < v) return false;
  healthState.money = getMoney() - v;
  recordLedger('out', v, 'hobby', note);
  return true;
}

// 学一门新爱好（占一个槽位：报名/教材费 + 该爱好的器材费）
function learnHobby(key) {
  if (!hobbyOn()) return { ok: false, error: '爱好系统未启用' };
  const meta = HOBBIES[key];
  if (!meta) return { ok: false, error: '未知爱好：' + key };
  if (isHobbyLearned(key)) return { ok: false, error: `已经在练「${meta.name}」了` };
  const slots = getHobbyMaxSlots();
  const learned = getHobbies().length;
  if (learned >= slots) {
    return { ok: false, error: `最多同时培养 ${slots} 个爱好（现在 ${learned} 个），先放弃一个，或者去设置里提高上限` };
  }
  const base = getHobbyLearnCost();
  const total = Math.round(base + meta.cost);
  if (!spendHobbyMoney(total)) {
    return { ok: false, error: `学「${meta.name}」要 ¥${total}（教材 ¥${base} + 器材 ¥${meta.cost}），钱包不够（当前 ¥${Math.round(getMoney())}）` };
  }
  if (!healthState.hobbies || typeof healthState.hobbies !== 'object') healthState.hobbies = {};
  healthState.hobbies[key] = {
    xp: 0, passion: 70, practiceCount: 0, works: [],
    learnedAt: Date.now(), lastPractice: 0, milestones: {}
  };
  recordTimeline(meta.emoji, `开始学「${meta.name}」（${getHobbyCat(key).name}）`, 'hobby');
  return {
    ok: true, key, meta,
    message: `${meta.emoji} 入手了「${meta.name}」的入门装备（教材 ¥${base} + 器材 ¥${meta.cost}）！接下来多练练就能看到进步，现在还是 0 级的门外汉~`
  };
}

// 练习一次（amount = 1~3，表示投入的"份量"）
function practiceHobby(key, amount = 1) {
  if (!hobbyOn()) return { ok: false, error: '爱好系统未启用' };
  const meta = HOBBIES[key];
  if (!meta) return { ok: false, error: '未知爱好：' + key };
  if (!isHobbyLearned(key)) return { ok: false, error: `还没学过「${meta.name}」，先学一下再来练` };

  const rec = ensureHobby(healthState.hobbies[key]);
  const n = Math.max(1, Math.min(3, Math.round(Number(amount) || 1)));
  const lvBefore = getHobbyLevel(rec.xp);

  // 收益系数：热情高练得进；等级高单次收益更好；「小成」里程碑再 +10%
  const passionK = 0.55 + rec.passion / 160;
  const levelK = 1 + lvBefore * 0.045;
  const msBonus = rec.milestones[3] ? 1.1 : 1;
  const gainXp = Math.max(1, Math.round(meta.xp * n * passionK * levelK));

  // 热情随着练习回暖
  const passionDelta = Math.min(100 - rec.passion, 3.5 * n);
  rec.passion = Math.min(100, rec.passion + 3.5 * n);
  rec.xp += gainXp;
  rec.practiceCount += n;
  const firstTime = rec.practiceCount === n;
  rec.lastPractice = Date.now();
  healthState.hobbyLastPractice = Date.now();

  // 连续练同一爱好 → 兴趣耗竭累积
  if (healthState.hobbyStreakKey === key) healthState.hobbyStreak = (Number(healthState.hobbyStreak) || 0) + n;
  else { healthState.hobbyStreakKey = key; healthState.hobbyStreak = n; }
  const streak = Number(healthState.hobbyStreak) || 0;
  const burnoutGain = streak > 3 ? (streak - 3) * 0.7 * n : 0;

  // —— 身体消耗与收益 ——
  const moodGain = meta.mood * n * (0.5 + rec.passion / 200) * msBonus;
  const stressRelief = meta.stress * n * (0.5 + rec.passion / 200);
  const satisGain = (1.5 + lvBefore * 0.4) * n;
  hobbyBump('energy', -meta.energy * n);
  hobbyBump('physicalReserve', -meta.body * n);
  hobbyBump('mentalFatigue', meta.mental * n * 0.6);
  hobbyBump('mood', moodGain);
  hobbyBump('stress', stressRelief);   // 注意：压力值维度是「高=无压力」，减压=加值
  hobbyBump('satisfaction', satisGain);
  hobbyBump('addiction', (meta.add || 0) * n);
  hobbyBump('hobbyStrain', (meta.strain || 0) * n * 1.1);
  hobbyBump('hobbyEyeStrain', (meta.eye || 0) * n * 1.1);
  if (burnoutGain > 0) hobbyBump('hobbyBurnout', burnoutGain);
  // v13.0：求知欲 / 同理心的唯一补给途径（此前它们只会单向衰减到 0）
  const psycheK = n * (0.7 + rec.passion / 250);
  const curioGain = meta.curio ? meta.curio * psycheK : 0;
  const empathyGain = meta.empathy ? meta.empathy * psycheK : 0;
  if (curioGain) hobbyBump('curiosity', curioGain);
  if (empathyGain) hobbyBump('empathy', empathyGain);

  // —— 升级 / 里程碑 / 首次 ——
  const lvAfter = getHobbyLevel(rec.xp);
  const events = [];
  if (firstTime) {
    events.push(`第一次认真练「${meta.name}」`);
    recordTimeline('🎨', `第一次认真练「${meta.name}」`, 'hobby');
  }
  if (lvAfter > lvBefore) {
    events.push(`熟练度 ${lvBefore} → ${lvAfter}（${getHobbyLevelName(lvAfter)}）`);
    recordTimeline('📈', `「${meta.name}」熟练度提升到 ${lvAfter} 级（${getHobbyLevelName(lvAfter)}）`, 'hobby');
  }
  for (const ms of HOBBY_MILESTONES) {
    if (lvAfter >= ms.lv && !rec.milestones[ms.lv]) {
      rec.milestones[ms.lv] = Date.now();
      events.push(`达成里程碑「${ms.emoji}${ms.name}」—— ${ms.bonus}`);
      recordTimeline(ms.emoji, `「${meta.name}」达成「${ms.name}」`, 'hobby');
    }
  }

  // —— 作品产出 ——
  let work = null;
  if (lvAfter >= 2 && Math.random() < (0.10 + lvAfter * 0.022 + rec.passion / 700)) {
    work = rollWorkQuality(key, lvAfter, rec.passion);
    rec.works.push(work);
    if (rec.works.length > HOBBY_WORK_CAP) rec.works = rec.works.slice(-HOBBY_WORK_CAP);
    if (work.quality === 'master') {
      recordTimeline('👑', `「${meta.name}」练出了第一件杰作`, 'hobby');
    }
  }

  // —— 文案 ——
  const prog = getHobbyProgress(rec.xp);
  const lines = [`${meta.emoji} 练了一会儿「${meta.name}」（${n} 份量）`];
  lines.push(`　经验 +${gainXp}　熟练度 ${lvAfter} 级·${prog.levelName}${prog.maxed ? '（已满级）' : `（距下一级还差 ${prog.need}）`}`);
  lines.push(`　心情 +${moodGain.toFixed(1)}　压力 -${stressRelief.toFixed(1)}　满足 +${satisGain.toFixed(1)}　热情 ${Math.round(rec.passion)}`);
  const psycheBits = [];
  if (curioGain >= 0.1) psycheBits.push(`求知欲 +${curioGain.toFixed(1)}`);
  if (empathyGain >= 0.1) psycheBits.push(`同理心 +${empathyGain.toFixed(1)}`);
  if (psycheBits.length) lines.push(`　${psycheBits.join('　')}`);
  const costBits = [`精力 -${(meta.energy * n).toFixed(0)}`];
  if (meta.body > 0) costBits.push(`体力 -${(meta.body * n).toFixed(0)}`);
  if (meta.mental > 0) costBits.push(`精神疲劳 +${(meta.mental * n * 0.6).toFixed(1)}`);
  if (meta.strain > 1.0) costBits.push(`上肢劳损 +${((meta.strain || 0) * n * 1.1).toFixed(1)}`);
  if (meta.eye > 1.0) costBits.push(`视疲劳 +${((meta.eye || 0) * n * 1.1).toFixed(1)}`);
  if (meta.add >= 0.5) costBits.push(`成瘾度 +${((meta.add || 0) * n).toFixed(1)}`);
  lines.push(`　消耗：${costBits.join('　')}`);
  if (events.length) lines.push(`　✦ ${events.join('；')}`);
  if (work) lines.push(`　🎁 产出了作品：${work.emoji}${work.name}（可赠送给关系网里的人）`);
  if (streak > 5) lines.push(`　⚠️ 连着练了 ${streak} 次，有点上头了，小心兴趣耗竭`);

  return {
    ok: true, key, meta, work, events,
    gainXp, lvBefore, lvAfter, streak,
    gains: { mood: moodGain, stress: stressRelief, satisfaction: satisGain },
    message: lines.join('\n')
  };
}

// 作品品质 roll（等级与热情越高越可能出精品）
function rollWorkQuality(key, level, passion) {
  const meta = HOBBIES[key] || { name: '作品' };
  const lv = Math.max(0, Math.min(10, Math.round(Number(level) || 0)));
  const pa = Math.max(0, Math.min(100, Number(passion) || 0));
  const r = Math.random();
  const pMaster = 0.015 + lv * 0.011 + pa / 2400;
  const pGreat = pMaster + 0.08 + lv * 0.018;
  const pFine = pGreat + 0.26 + lv * 0.012;
  let q;
  if (r < pMaster) q = 'master';
  else if (r < pGreat) q = 'great';
  else if (r < pFine) q = 'fine';
  else q = 'rough';
  const info = WORK_QUALITIES[q];
  return { quality: q, name: `${meta.name}·${info.name}`, emoji: info.emoji, score: info.score, at: Date.now(), level: lv };
}

// 把最好的作品送给关系网里的人（提升亲密度与亲密感、化解积怨）
function giftWork(targetName, key = null) {
  if (!hobbyOn()) return { ok: false, error: '爱好系统未启用' };
  const list = getHobbies();
  if (!list.length) return { ok: false, error: '还没有任何爱好，先学一个吧' };
  // 候选：指定爱好优先，否则所有爱好里挑品质最高的一件
  let from = key ? list.filter(x => x.key === key) : list;
  if (!from.length) return { ok: false, error: `没在练「${key}」` };
  let best = null;
  for (const it of from) {
    for (let i = 0; i < it.rec.works.length; i++) {
      const w = it.rec.works[i];
      if (!best || (w.score || 0) > (best.work.score || 0)) best = { it, work: w, idx: i };
    }
  }
  if (!best) return { ok: false, error: '手头还没有拿得出手的作品，多练练再送吧' };

  const bonds = healthState.bonds;
  const bond = bonds && typeof bonds === 'object' ? bonds[targetName] : null;
  if (!bond) {
    const names = getRelations().map(x => x.bond.name).join('、') || '（关系网为空）';
    return { ok: false, error: `关系网里没有「${targetName}」。现有：${names}` };
  }
  const eb = ensureRelation(bond);
  const q = WORK_QUALITIES[best.work.quality] || WORK_QUALITIES.rough;
  const type = getRelationType(eb.relation);
  const beforeAff = eb.affinity;
  eb.affinity = Math.min(type.cap, eb.affinity + q.gift);
  eb.intimacy = Math.min(100, Number(eb.intimacy) + q.gift * 0.6);
  eb.conflicts = Math.max(0, Number(eb.conflicts) - 1);
  eb.lastChat = Date.now();
  // 移出背包（按对象引用定位，避免下标漂移）
  const arr = best.it.rec.works;
  const realIdx = arr.indexOf(best.work);
  if (realIdx >= 0) arr.splice(realIdx, 1);
  hobbyBump('satisfaction', q.gift * 0.15);
  hobbyBump('mood', q.gift * 0.12);
  recordTimeline('🎁', `把「${best.work.name}」送给了 ${eb.name}`, 'hobby');

  return {
    ok: true,
    message: `🎁 把${q.emoji}${best.work.name}送给了 ${eb.name}！\n亲密度 ${Math.round(beforeAff)} → ${Math.round(eb.affinity)}（+${q.gift}）　亲密感 +${(q.gift * 0.6).toFixed(1)}${eb.conflicts <= 0 ? '　积怨也消了' : ''}\n${best.it.meta.emoji} 这份心意是从「${best.it.meta.name}」里来的。`
  };
}

// 放弃一个爱好（清空经验与作品，释放槽位）
function abandonHobby(key) {
  if (!HOBBIES[key]) return { ok: false, error: '未知爱好：' + key };
  if (!isHobbyLearned(key)) return { ok: false, error: `本来就没在练「${HOBBIES[key].name}」` };
  const meta = HOBBIES[key];
  const rec = ensureHobby(healthState.hobbies[key]);
  const lv = getHobbyLevel(rec.xp);
  const works = rec.works.length;
  delete healthState.hobbies[key];
  if (healthState.hobbyStreakKey === key) {
    healthState.hobbyStreak = 0;
    healthState.hobbyStreakKey = '';
  }
  recordTimeline('🚮', `放弃了「${meta.name}」（练到 ${lv} 级、留下 ${works} 件作品）`, 'hobby');
  return { ok: true, message: `🚮 不再练「${meta.name}」了（曾经的 ${lv} 级·${getHobbyLevelName(lv)}），槽位空出来一个。${works ? `那 ${works} 件作品也都处理掉了。` : ''}` };
}

// 爱好的被动反哺（有寄托 → 满足/心情/减压/安全感/社交）
function getHobbyEffects() {
  const list = getHobbies();
  if (!list.length) {
    return { count: 0, totalLevel: 0, maxLevel: 0, avgPassion: 0, works: 0, topKey: null, topName: '', satisfaction: 0, mood: 0, stress: 0, security: 0, social: 0 };
  }
  let totalLevel = 0, maxLevel = 0, sumPassion = 0, works = 0, social = 0, top = null;
  for (const it of list) {
    totalLevel += it.level;
    if (it.level > maxLevel) maxLevel = it.level;
    sumPassion += it.rec.passion;
    works += it.works;
    social += (it.meta.social || 0);
    if (!top || it.rec.passion > top.rec.passion) top = it;
  }
  const avgPassion = sumPassion / list.length;
  return {
    count: list.length,
    totalLevel,
    maxLevel,
    avgPassion: Math.round(avgPassion * 10) / 10,
    works,
    topKey: top ? top.key : null,
    topName: top ? top.meta.name : '',
    satisfaction: Math.min(20, totalLevel * 0.7 + works * 0.12),
    mood: Math.min(6, (avgPassion / 100) * 4.5),
    stress: Math.min(8, totalLevel * 0.45 + list.length * 1.2),   // 正值：提升「压力值」数值=更轻松
    security: Math.min(9, maxLevel * 0.9),
    social: Math.min(5, social * 0.25)
  };
}

// 热情随时间消退；久不练掉得更快；劳损/视疲劳/耗竭自然回落
function updateHobbies(times = 1) {
  if (!hobbyOn()) return;
  const t = Math.max(1, Math.min(8, Math.round(Number(times) || 1)));
  const now = Date.now();
  const decay = getHobbyPassionDecay();
  for (const { rec } of getHobbies()) {
    const idleDays = (now - (Number(rec.lastPractice) || 0)) / 86400000;
    const idleMul = idleDays > 3 ? 2.2 : idleDays > 1 ? 1.4 : 1;
    // 「登峰」（9 级）之后热情不再消退
    if (!rec.milestones[9]) {
      rec.passion = Math.max(0, Math.min(100, rec.passion - decay * idleMul * t));
    }
  }
  // 连击中断（6 小时没碰）
  if ((Number(healthState.hobbyStreak) || 0) > 0 && now - (Number(healthState.hobbyLastPractice) || 0) > 6 * 3600000) {
    healthState.hobbyStreak = 0;
    healthState.hobbyStreakKey = '';
  }
  const sd = getHobbyStrainDecay();
  hobbyBump('hobbyStrain', -sd * t);
  hobbyBump('hobbyEyeStrain', -sd * 1.2 * t);
  hobbyBump('hobbyBurnout', -0.5 * t);
}

// 爱好相关情绪提示
function getHobbyHint() {
  const parts = [];
  const st = Number(healthState.hobbyStrain) || 0;
  const ey = Number(healthState.hobbyEyeStrain) || 0;
  const bo = Number(healthState.hobbyBurnout) || 0;
  if (st >= 55) parts.push('手腕和腰背酸得厉害，是练得太狠了');
  else if (st >= 35) parts.push('胳膊有点酸，握东西时会酸');
  if (ey >= 60) parts.push('眼睛又干又涩，看什么都糊');
  else if (ey >= 40) parts.push('盯久了眼睛发累');
  if (bo >= 65) parts.push('最近一碰爱好就烦躁，怎么也提不起劲');
  else if (bo >= 45) parts.push('好像有点练腻了，需要换换花样');
  if (!parts.length) {
    const list = getHobbies();
    const top = list.slice().sort((a, b) => b.rec.passion - a.rec.passion)[0];
    if (top && top.rec.passion >= 75) parts.push(`最近特别想练${top.meta.name}，一上手就来劲`);
    else if (top && top.rec.passion <= 20) parts.push(`对${top.meta.name}有点提不起兴趣了`);
  }
  return parts.length ? parts.join('；') + '。' : '';
}

// ══════════════════════════════════════════════════════════════════════
// v10.0 宠物养成（Pet / Companion）
// 让机器人有"要照顾的活物"：领养 → 喂养/饮水/清洁/陪伴 → 亲密度 → 技能；
// 宠物有真实的四维需求（按真实时间衰减）、自己的疾病谱、寿命与衰老阶段，
// 并且会反过来影响主人：亲密度反哺归属感、撸宠减压、掉毛推高过敏负荷、
// 夜行物种夜里闹腾影响主人睡眠。
// ══════════════════════════════════════════════════════════════════════

// 物种表：
//   price 领养价(¥) / lifespan 寿命(天) / shed 掉毛皮屑系数 / nightActive 夜行活跃度
//   walk 是否需要遛 / vetMul 兽医费倍率 / care 照顾难度 1-5
//   need 四维衰减倍率 / tricks 可学技能 / traits 特性
const PET_SPECIES = {
  cat:        { name: '猫',   emoji: '🐱', price: 300, lifespan: 260, shed: 1.8, nightActive: 1.5, walk: 0, vetMul: 1.0, care: 2,
                need: { satiety: 1.00, hydration: 1.05, hygiene: 0.60, spirit: 0.95 },
                tricks: ['sit', 'paw', 'roll', 'spin', 'play_dead', 'bow'],
                desc: '傲娇但黏人，会自己找地方晒太阳', traits: ['掉毛多', '夜间活跃', '要铲屎'] },
  dog:        { name: '狗',   emoji: '🐶', price: 500, lifespan: 240, shed: 1.6, nightActive: 0.3, walk: 1, vetMul: 1.2, care: 3,
                need: { satiety: 1.15, hydration: 1.10, hygiene: 1.00, spirit: 1.15 },
                tricks: ['sit', 'paw', 'roll', 'spin', 'fetch', 'speak', 'quiet', 'play_dead', 'bow', 'dance'],
                desc: '最黏人的那一个，你回家它能高兴一整天', traits: ['要遛', '黏人', '掉毛多'] },
  hamster:    { name: '仓鼠', emoji: '🐹', price: 60,  lifespan: 90,  shed: 0.8, nightActive: 1.8, walk: 0, vetMul: 0.7, care: 2,
                need: { satiety: 1.00, hydration: 0.90, hygiene: 0.95, spirit: 0.80 },
                tricks: ['sit', 'roll', 'spin', 'play_dead'],
                desc: '白天睡觉夜里跑轮子，寿命短但活得热闹', traits: ['夜行', '寿命短', '要换木屑'] },
  rabbit:     { name: '兔子', emoji: '🐰', price: 150, lifespan: 160, shed: 1.1, nightActive: 1.1, walk: 0, vetMul: 0.9, care: 3,
                need: { satiety: 1.05, hydration: 1.00, hygiene: 0.85, spirit: 0.90 },
                tricks: ['sit', 'spin', 'bow', 'play_dead'],
                desc: '安静胆小，高兴了会原地蹦一下', traits: ['安静', '胆小', '牙齿会长'] },
  parrot:     { name: '鹦鹉', emoji: '🦜', price: 400, lifespan: 480, shed: 0.9, nightActive: 0.4, walk: 0, vetMul: 1.1, care: 4,
                need: { satiety: 0.90, hydration: 0.95, hygiene: 0.75, spirit: 1.05 },
                tricks: ['speak', 'quiet', 'bow', 'dance', 'fetch'],
                desc: '能学说话，你不在家它自己跟自己聊天', traits: ['会说话', '长寿', '吵'] },
  goldfish:   { name: '金鱼', emoji: '🐟', price: 40,  lifespan: 200, shed: 0.1, nightActive: 0.2, walk: 0, vetMul: 0.5, care: 2,
                need: { satiety: 0.60, hydration: 0.70, hygiene: 1.20, spirit: 0.60 },
                tricks: ['spin'],
                desc: '安静地游来游去，看着它发呆很治愈', traits: ['要换水', '安静', '好养'] },
  turtle:     { name: '乌龟', emoji: '🐢', price: 120, lifespan: 900, shed: 0.3, nightActive: 0.2, walk: 0, vetMul: 0.8, care: 1,
                need: { satiety: 0.50, hydration: 0.60, hygiene: 0.90, spirit: 0.55 },
                tricks: ['sit', 'bow'],
                desc: '慢吞吞的，可能比你活得还久', traits: ['极长寿', '省心', '要晒背'] },
  lizard:     { name: '蜥蜴', emoji: '🦎', price: 250, lifespan: 380, shed: 0.5, nightActive: 1.6, walk: 0, vetMul: 1.0, care: 4,
                need: { satiety: 0.85, hydration: 0.80, hygiene: 0.50, spirit: 0.70 },
                tricks: ['sit', 'play_dead', 'bow'],
                desc: '冷血但很酷，要控温要照灯', traits: ['爬宠', '怕冷', '要控温'] },
  hedgehog:   { name: '刺猬', emoji: '🦔', price: 180, lifespan: 130, shed: 0.7, nightActive: 1.9, walk: 0, vetMul: 0.9, care: 3,
                need: { satiety: 0.95, hydration: 0.95, hygiene: 0.90, spirit: 0.85 },
                tricks: ['roll', 'spin', 'play_dead'],
                desc: '一紧张就缩成球，熟了才肯露出肚子', traits: ['夜行', '爱缩球', '掉刺'] },
  chinchilla: { name: '龙猫', emoji: '🐿️', price: 600, lifespan: 300, shed: 1.4, nightActive: 1.7, walk: 0, vetMul: 1.3, care: 5,
                need: { satiety: 0.85, hydration: 0.85, hygiene: 0.70, spirit: 0.95 },
                tricks: ['sit', 'roll', 'spin', 'bow'],
                desc: '要洗沙浴，毛密得虫子都钻不进去', traits: ['要沙浴', '贵', '夜行'] }
};

// 成长阶段（按寿命占比划分）
const PET_STAGES = [
  { key: 'baby',     name: '幼崽', emoji: '🍼', from: 0.00, to: 0.10, needMul: 1.50, bondGain: 1.60, note: '还小，要小心照顾' },
  { key: 'young',    name: '少年', emoji: '🐾', from: 0.10, to: 0.35, needMul: 1.20, bondGain: 1.30, note: '正是精力最旺的时候' },
  { key: 'adult',    name: '成年', emoji: '🌟', from: 0.35, to: 0.75, needMul: 1.00, bondGain: 1.00, note: '最省心也最能陪你的阶段' },
  { key: 'senior',   name: '老年', emoji: '🌾', from: 0.75, to: 0.90, needMul: 0.85, bondGain: 0.90, note: '动作慢了，要多留意身体' },
  { key: 'twilight', name: '暮年', emoji: '🕯️', from: 0.90, to: 1.01, needMul: 0.70, bondGain: 0.80, note: '陪一天少一天了' }
];

// 四维需求（decay 为每小时基准衰减量）
const PET_NEEDS = {
  satiety:   { name: '饱食', emoji: '🍖', decay: 4.0, low: '饿得一直叫' },
  hydration: { name: '饮水', emoji: '💧', decay: 4.5, low: '水碗空了' },
  hygiene:   { name: '清洁', emoji: '🧼', decay: 2.2, low: '脏兮兮的' },
  spirit:    { name: '心情', emoji: '🎾', decay: 3.0, low: '闷闷不乐' }
};

// 技能表（xp 为解锁所需累计训练经验）
const PET_TRICKS = {
  sit:       { name: '坐下',   emoji: '🪑', xp: 25 },
  paw:       { name: '握手',   emoji: '🤝', xp: 40 },
  roll:      { name: '打滚',   emoji: '🔄', xp: 55 },
  spin:      { name: '转圈',   emoji: '🌀', xp: 70 },
  fetch:     { name: '叼东西', emoji: '🎾', xp: 90 },
  speak:     { name: '叫一声', emoji: '🔊', xp: 110 },
  quiet:     { name: '安静',   emoji: '🤫', xp: 130 },
  play_dead: { name: '装死',   emoji: '💀', xp: 160 },
  bow:       { name: '鞠躬',   emoji: '🙇', xp: 190 },
  dance:     { name: '转圈跳舞', emoji: '💃', xp: 220 }
};

// 宠物疾病（条件绑定派生状态，由 checkPetDiseases 判定；decay 为每周期健康损失）
const PET_DISEASES = {
  pet_malnutrition: { name: '营养不良', emoji: '🍖', conditions: { petSatiety: { max: 22 } }, decay: 2.4, symptoms: '瘦得肋骨都摸得到，没力气' },
  pet_dehydration:  { name: '脱水',     emoji: '💧', conditions: { petHydration: { max: 18 } }, decay: 3.0, symptoms: '鼻子干裂、皮肤回弹慢、蔫蔫的' },
  pet_skin:         { name: '皮肤病',   emoji: '🦠', conditions: { petHygiene: { max: 28 } }, decay: 1.4, symptoms: '一直挠、掉毛、皮肤发红结痂' },
  pet_sad:          { name: '宠物抑郁', emoji: '😿', conditions: { petSpirit: { max: 24 } }, decay: 1.0, symptoms: '不搭理人、躲在角落、不吃东西' },
  pet_parasites:    { name: '寄生虫',   emoji: '🪱', conditions: { petHygiene: { max: 45 }, petHealth: { max: 80 } }, decay: 1.8, symptoms: '肛门周围痒、粪便里见虫' },
  pet_obesity:      { name: '宠物肥胖', emoji: '🍩', conditions: { petSatiety: { min: 95 }, petFat: { min: 60 } }, decay: 0.8, symptoms: '肚腩拖地、走两步就喘' },
  pet_cold:         { name: '受凉感冒', emoji: '🤧', conditions: { petHealth: { max: 62 } }, decay: 1.2, symptoms: '打喷嚏、流鼻涕、没精神' },
  pet_aging_sick:   { name: '老年病',   emoji: '🩺', conditions: { petAgeRatio: { min: 0.78 }, petHealth: { max: 70 } }, decay: 1.6, symptoms: '关节僵硬、行动迟缓、视听力下降' }
};

// 亲密度等级
const PET_BOND_LEVELS = [
  { min: 92, name: '形影不离' }, { min: 78, name: '亲密无间' }, { min: 60, name: '很亲' },
  { min: 40, name: '熟悉' }, { min: 20, name: '有点认生' }, { min: 0, name: '还很陌生' }
];

// 默认名字池（不指定名字时随机取）
const PET_NAME_POOL = ['团子', '汤圆', '布丁', '奶糖', '麻薯', '花卷', '豆豆', '芝麻', '年糕', '可乐',
                       '雪球', '阿黄', '小满', '橘座', '煤球', '闪电', '棉花', '曲奇', '旺财', '元宝'];

const PET_TRICK_CAP = 10;      // 技能上限（与 PET_TRICKS 条数一致）
const PET_FAT_CAP = 100;       // 肥肉度上限

// ── 配置读取（带默认值兜底）──
function getPetMaxCount() {
  try { const n = Number(cfg().petMaxCount); if (Number.isFinite(n)) return Math.max(1, Math.min(9, Math.round(n))); } catch { /* 默认 2 */ }
  return 2;
}
function getPetAdoptCostMul() {
  try { const n = Number(cfg().petAdoptCostMul); if (Number.isFinite(n) && n >= 0) return n; } catch { /* 默认 1 */ }
  return 1;
}
function getPetFoodCost() {
  try { const n = Number(cfg().petFoodCost); if (Number.isFinite(n) && n >= 0) return n; } catch { /* 默认 12 */ }
  return 12;
}
function getPetVetCost() {
  try { const n = Number(cfg().petVetCost); if (Number.isFinite(n) && n >= 0) return n; } catch { /* 默认 80 */ }
  return 80;
}
function getPetNeedDecay() {
  try { const n = Number(cfg().petNeedDecay); if (Number.isFinite(n) && n >= 0) return n; } catch { /* 默认 1 */ }
  return 1;
}
function getPetAllergyFactor() {
  try { const n = Number(cfg().petAllergyFactor); if (Number.isFinite(n) && n >= 0) return n; } catch { /* 默认 1 */ }
  return 1;
}

// ── 开关与访问器 ──
function petOn() {
  try { return cfg().petEnabled !== false; } catch { return true; }
}

function getPetSpecies(key) { return PET_SPECIES[key] || null; }

function getPetStageInfo(key) { return PET_STAGES.find(s => s.key === key) || PET_STAGES[0]; }

function getPetBondLevel(bond) {
  const v = Number(bond);
  if (!Number.isFinite(v)) return PET_BOND_LEVELS[PET_BOND_LEVELS.length - 1].name;
  for (const l of PET_BOND_LEVELS) { if (v >= l.min) return l.name; }
  return PET_BOND_LEVELS[PET_BOND_LEVELS.length - 1].name;
}

// 通用安全加减（可作用于宠物记录，也可作用于 healthState）
function petNumBump(obj, key, delta, lo = 0, hi = 100) {
  if (!obj || typeof obj !== 'object') return lo;
  const cur = Number(obj[key]);
  const base = Number.isFinite(cur) ? cur : lo;
  obj[key] = Math.max(lo, Math.min(hi, base + delta));
  return obj[key];
}

// 补全一条宠物记录的缺失字段（老存档 / 脏数据兼容）
function ensurePet(rec) {
  if (!rec || typeof rec !== 'object') return null;
  if (!PET_SPECIES[rec.species]) return null;
  const now = Date.now();
  if (!Number.isFinite(Number(rec.id))) rec.id = 0;
  rec.id = Math.max(0, Math.round(Number(rec.id)));
  if (typeof rec.name !== 'string' || !rec.name.trim()) rec.name = PET_SPECIES[rec.species].name;
  rec.name = rec.name.trim().slice(0, 12);
  const numOr = (v, d, lo, hi) => {
    const x = Number(v);
    if (!Number.isFinite(x)) return d;
    return Math.max(lo, Math.min(hi, x));
  };
  rec.bond = numOr(rec.bond, 20, 0, 100);
  rec.satiety = numOr(rec.satiety, 70, 0, 100);
  rec.hydration = numOr(rec.hydration, 70, 0, 100);
  rec.hygiene = numOr(rec.hygiene, 70, 0, 100);
  rec.spirit = numOr(rec.spirit, 70, 0, 100);
  rec.health = numOr(rec.health, 100, 0, 100);
  rec.fat = numOr(rec.fat, 5, 0, PET_FAT_CAP);
  rec.skillXp = Math.round(numOr(rec.skillXp, 0, 0, 99999));
  if (!Array.isArray(rec.tricks)) rec.tricks = [];
  rec.tricks = rec.tricks.filter(t => PET_TRICKS[t]);
  if (!Array.isArray(rec.diseases)) rec.diseases = [];
  rec.diseases = rec.diseases.filter(d => PET_DISEASES[d]);
  if (!Number.isFinite(Number(rec.bornAt))) rec.bornAt = now;
  if (!Number.isFinite(Number(rec.adoptedAt))) rec.adoptedAt = rec.bornAt;
  for (const k of ['lastFeed', 'lastWater', 'lastClean', 'lastPlay', 'lastWalk', 'lastTrain']) {
    if (!Number.isFinite(Number(rec[k]))) rec[k] = 0;
  }
  if (rec.memorial && typeof rec.memorial !== 'object') rec.memorial = null;
  return rec;
}

// 全部宠物（默认不含已离世的）
function getPets(includeMemorial = false) {
  if (!Array.isArray(healthState.pets)) healthState.pets = [];
  const out = [];
  for (const raw of healthState.pets) {
    const p = ensurePet(raw);
    if (!p) continue;
    if (!includeMemorial && p.memorial) continue;
    out.push(p);
  }
  return out;
}

// 按 id / 名字 / 物种名 找宠物（省略参数时返回第一只）
function findPet(ref) {
  const list = getPets(true);
  if (!list.length) return null;
  const alive = list.filter(p => !p.memorial);
  if (ref === undefined || ref === null || String(ref).trim() === '') return alive[0] || null;
  const s = String(ref).trim();
  return list.find(p => String(p.id) === s)
      || list.find(p => p.name === s)
      || list.find(p => PET_SPECIES[p.species].name === s)
      || list.find(p => p.name.includes(s))
      || list.find(p => PET_SPECIES[p.species].name.includes(s))
      || null;
}

// 相处天数（按真实时间，与寿命同口径）
function getPetAgeDays(pet) {
  const p = pet && pet.species ? pet : ensurePet(pet);
  if (!p) return 0;
  const ms = Date.now() - (Number(p.bornAt) || Date.now());
  return Math.max(0, ms / 86400000);
}

// 生命进度 0-1（≥1 表示已到寿命）
function getPetLifeRatio(pet) {
  const p = pet && pet.species ? pet : ensurePet(pet);
  if (!p) return 0;
  const sp = PET_SPECIES[p.species];
  return getPetAgeDays(p) / Math.max(1, Number(sp.lifespan) || 1);
}

function getPetStage(pet) {
  const r = getPetLifeRatio(pet);
  for (const s of PET_STAGES) { if (r >= s.from && r < s.to) return s; }
  return PET_STAGES[PET_STAGES.length - 1];
}

function getPetStageName(pet) { return getPetStage(pet).name; }

// 四维快照（缺省按 0 处理，避免 undefined 参与比较）
function getPetNeeds(pet) {
  const p = pet && pet.species ? pet : ensurePet(pet);
  const g = (k) => {
    const v = Number(p && p[k]);
    return Number.isFinite(v) ? v : 0;
  };
  const o = { satiety: g('satiety'), hydration: g('hydration'), hygiene: g('hygiene'), spirit: g('spirit') };
  let lowestKey = 'satiety', lowest = o.satiety;
  for (const k of Object.keys(o)) { if (o[k] < lowest) { lowest = o[k]; lowestKey = k; } }
  return Object.assign(o, { lowest, lowestKey, avg: (o.satiety + o.hydration + o.hygiene + o.spirit) / 4 });
}

// 疾病判定用的派生状态（缺失一律补齐，避免 undefined 被误判为"满足"）
// 注意：缺值一律返回 NaN 而**不是** 0 —— 若返回 0，缺失的 satiety 会满足
//       「petSatiety <= 22」这类上限条件，导致营养不良被凭空误判。
//       checkPetDiseases / 自愈判定都靠 !isFinite(v) 短路掉这种脏值。
function petDerived(pet) {
  const p = pet && pet.species ? pet : ensurePet(pet);
  if (!p) return {};
  // 注意 Number(null) === 0、Number('') === 0，所以不能直接 Number() 兜底 ——
  // 空值/布尔/空串一律视为"无数据"（NaN），否则 null 的清洁度会被当成 0 触发皮肤病。
  const raw = (k) => {
    const v = p[k];
    if (v === null || v === undefined || v === '' || typeof v === 'boolean') return NaN;
    const n = Number(v);
    return Number.isFinite(n) ? n : NaN;
  };
  return {
    petSatiety: raw('satiety'),
    petHydration: raw('hydration'),
    petHygiene: raw('hygiene'),
    petSpirit: raw('spirit'),
    petHealth: raw('health'),
    petFat: raw('fat'),
    petAgeRatio: getPetLifeRatio(p)
  };
}

// 宠物开销：独立记账，不混进人自己的医疗支出
function spendPetMoney(n, reason = '') {
  const v = Number(n) || 0;
  if (v <= 0) return true;
  if (getMoney() < v) return false;
  healthState.money = getMoney() - v;
  healthState.petCost = (Number(healthState.petCost) || 0) + v;
  recordLedger('out', v, 'pet', reason);
  if (reason) log(`[健康系统] 宠物开销 ¥${Math.round(v)}（${reason}），累计 ¥${Math.round(Number(healthState.petCost) || 0)}`);
  return true;
}

// 取宠物（在世）或给出友好错误
function petAliveOrErr(ref) {
  const p = findPet(ref);
  if (!p) {
    const all = getPets();
    if (!all.length) return { err: '🐾 你还没养宠物呢——可以先领养一只：猫 / 狗 / 仓鼠 / 兔子 / 鹦鹉 / 金鱼 / 乌龟 / 蜥蜴 / 刺猬 / 龙猫。' };
    return { err: '没找到这只宠物。现在养着：' + all.map(x => `「${x.name}」`).join('、') };
  }
  if (p.memorial) return { err: `「${p.name}」已经走了…在记忆里给它留个位置就好。` };
  return { pet: p };
}

// ── 领养 ──
function adoptPet(speciesKey, name) {
  if (!petOn()) return { ok: false, error: '宠物系统已在设置里关闭。' };
  const sp = PET_SPECIES[speciesKey];
  if (!sp) {
    return { ok: false, error: '不认识的动物：' + speciesKey + '（可选：' + Object.keys(PET_SPECIES).map(k => `${k}=${PET_SPECIES[k].name}`).join('、') + '）' };
  }
  const list = getPets();
  const max = getPetMaxCount();
  if (list.length >= max) {
    return { ok: false, error: `已经养了 ${list.length} 只（上限 ${max}）——要么先送走一只，要么在设置里提高上限。` };
  }
  const price = Math.round(Number(sp.price) * getPetAdoptCostMul());
  if (!spendPetMoney(price, '领养' + sp.name)) {
    return { ok: false, error: `领养${sp.name}要 ¥${price}，钱包不够（现有 ¥${Math.round(getMoney())}）。` };
  }
  const now = Date.now();
  const petName = (typeof name === 'string' && name.trim())
    ? name.trim().slice(0, 12)
    : PET_NAME_POOL[Math.floor(Math.random() * PET_NAME_POOL.length)];
  const rec = ensurePet({
    id: Math.max(1, Math.round(Number(healthState.petSeq) || 1)),
    species: speciesKey, name: petName,
    bornAt: now, adoptedAt: now,
    bond: 20, satiety: 70, hydration: 70, hygiene: 70, spirit: 75, health: 100, fat: 5,
    diseases: [], skillXp: 0, tricks: [],
    lastFeed: 0, lastWater: 0, lastClean: 0, lastPlay: 0, lastWalk: 0, lastTrain: 0,
    memorial: null
  });
  healthState.petSeq = Math.max(1, Math.round(Number(healthState.petSeq) || 1)) + 1;
  if (!Array.isArray(healthState.pets)) healthState.pets = [];
  healthState.pets.push(rec);
  recordTimeline(sp.emoji, `领养了一只${sp.name}，取名叫「${petName}」`, 'pet');
  return {
    ok: true, pet: rec,
    message: `${sp.emoji} 欢迎「${petName}」回家！它是一只${sp.name}——${sp.desc}\n特性：${sp.traits.join('、')}　寿命约 ${sp.lifespan} 天　照顾难度 ${'★'.repeat(sp.care)}\n💸 花了 ¥${price}（累计宠物开销 ¥${Math.round(Number(healthState.petCost) || 0)}）。刚开始它还有点认生，多陪陪它吧。`
  };
}

// ── 喂食 ──
function feedPet(ref) {
  if (!petOn()) return { ok: false, error: '宠物系统已在设置里关闭。' };
  const r = petAliveOrErr(ref);
  if (r.err) return { ok: false, error: r.err };
  const p = r.pet;
  const sp = PET_SPECIES[p.species];
  const cost = Math.round(getPetFoodCost() * (sp.care >= 4 ? 1.3 : 1));
  if (!spendPetMoney(cost, '宠物粮')) {
    return { ok: false, error: `一份宠物粮要 ¥${cost}，钱包不够（现有 ¥${Math.round(getMoney())}）。` };
  }
  const before = p.satiety;
  const over = Math.max(0, before - 82);              // 已经很饱还硬喂 → 长胖
  petNumBump(p, 'satiety', 34, 0, 100);
  if (over > 0) petNumBump(p, 'fat', over * 0.35 + 2, 0, PET_FAT_CAP);
  petNumBump(p, 'spirit', 5, 0, 100);
  petNumBump(p, 'bond', 1.6 * getPetStage(p).bondGain, 0, 100);
  p.lastFeed = Date.now();
  let msg = `${sp.emoji} 你给「${p.name}」添了粮，它埋头吃得飞快。（饱食 ${Math.round(before)} → ${Math.round(p.satiety)}）`;
  if (over > 0) msg += `\n🍩 它其实已经饱了，硬塞只会长胖（肥肉度 ${Math.round(p.fat)}）。`;
  const stage = getPetStage(p);
  if (stage.key === 'baby') msg += `\n🍼 幼崽肠胃弱，要少食多餐。`;
  return { ok: true, pet: p, message: msg };
}

// ── 换水 ──
function waterPet(ref) {
  if (!petOn()) return { ok: false, error: '宠物系统已在设置里关闭。' };
  const r = petAliveOrErr(ref);
  if (r.err) return { ok: false, error: r.err };
  const p = r.pet;
  const sp = PET_SPECIES[p.species];
  const before = p.hydration;
  petNumBump(p, 'hydration', 42, 0, 100);
  petNumBump(p, 'spirit', 3, 0, 100);
  petNumBump(p, 'bond', 1.0 * getPetStage(p).bondGain, 0, 100);
  p.lastWater = Date.now();
  let msg = `💧 你给「${p.name}」换上干净的水。（饮水 ${Math.round(before)} → ${Math.round(p.hydration)}）`;
  if (sp.tricks.includes('spin') && p.species === 'goldfish') msg += `\n🐟 换水时它绕着缸游了两圈，像是在谢你。`;
  return { ok: true, pet: p, message: msg };
}

// ── 清洁 ──
function cleanPet(ref) {
  if (!petOn()) return { ok: false, error: '宠物系统已在设置里关闭。' };
  const r = petAliveOrErr(ref);
  if (r.err) return { ok: false, error: r.err };
  const p = r.pet;
  const sp = PET_SPECIES[p.species];
  const before = p.hygiene;
  petNumBump(p, 'hygiene', 46, 0, 100);
  petNumBump(p, 'spirit', -2, 0, 100);      // 大部分动物都不爱洗澡
  petNumBump(p, 'bond', 1.4 * getPetStage(p).bondGain, 0, 100);
  p.lastClean = Date.now();
  const washWord = p.species === 'cat' ? '猫砂盆铲干净' : p.species === 'goldfish' || p.species === 'turtle' ? '水箱换了水' : p.species === 'chinchilla' ? '备好沙浴让它自己打滚' : '好好洗了个澡';
  const washEmoji = p.species === 'cat' ? '🧹' : (p.species === 'goldfish' || p.species === 'turtle') ? '🪣' : p.species === 'chinchilla' ? '🏖️' : '🛁';
  let msg = `${washEmoji} 你给「${p.name}」${washWord}。（清洁 ${Math.round(before)} → ${Math.round(p.hygiene)}）`;
  if (p.spirit < 60) msg += `\n😾 它好像不太乐意，一副被冒犯的样子。`;
  return { ok: true, pet: p, message: msg };
}

// ── 陪玩 ──
function playPet(ref) {
  if (!petOn()) return { ok: false, error: '宠物系统已在设置里关闭。' };
  const r = petAliveOrErr(ref);
  if (r.err) return { ok: false, error: r.err };
  const p = r.pet;
  const sp = PET_SPECIES[p.species];
  const stage = getPetStage(p);
  if (Number(healthState.energy) < 8) return { ok: false, error: `你太累了（精力 ${Math.round(Number(healthState.energy) || 0)}），实在没力气陪它玩。先歇会儿吧。` };
  const before = p.spirit;
  petNumBump(p, 'spirit', 30 * stage.needMul, 0, 100);
  petNumBump(p, 'bond', 2.4 * stage.bondGain, 0, 100);
  petNumBump(p, 'fat', -3.5, 0, PET_FAT_CAP);
  petNumBump(p, 'satiety', -3, 0, 100);
  petNumBump(healthState, 'energy', -6, 0, 100);
  petNumBump(healthState, 'mood', 4, 0, 100);
  petNumBump(healthState, 'stress', 3, 0, 100);      // 压力维度：高 = 无压力 → 减压是加
  petNumBump(healthState, 'fatigue', 3, 0, 100);
  p.lastPlay = Date.now();
  let msg = `🎾 你陪「${p.name}」玩了一阵。（心情 ${Math.round(before)} → ${Math.round(p.spirit)}｜亲密度 ${Math.round(p.bond)}）`;
  if (sp.name === '狗') msg += `\n🐶 它叼着玩具跑回来，尾巴摇得像要飞起来。`;
  else if (sp.name === '猫') msg += `\n🐱 它玩嗨了会突然停下来瞪你一眼，然后又扑上来。`;
  return { ok: true, pet: p, message: msg };
}

// ── 撸宠（抚摸）──
function cuddlePet(ref) {
  if (!petOn()) return { ok: false, error: '宠物系统已在设置里关闭。' };
  const r = petAliveOrErr(ref);
  if (r.err) return { ok: false, error: r.err };
  const p = r.pet;
  const sp = PET_SPECIES[p.species];
  const touchy = sp.name === '猫' || sp.name === '刺猬' || sp.name === '蜥蜴';
  petNumBump(p, 'spirit', 16, 0, 100);
  petNumBump(p, 'bond', 2.0 * getPetStage(p).bondGain, 0, 100);
  // 撸宠物降皮质醇是有据可依的
  petNumBump(healthState, 'stress', 5, 0, 100);
  petNumBump(healthState, 'mood', 3, 0, 100);
  petNumBump(healthState, 'satisfaction', 2, 0, 100);
  // v13.0：照顾一个小生命会磨出同理心（同理心的补给途径之二，另一处是深聊）
  petNumBump(healthState, 'empathy', 2.5, 0, 100);
  setHormone('cortisol', getHormone('cortisol') - 2.5);
  setHormone('serotonin', getHormone('serotonin') + 1.5);
  p.lastPlay = Date.now();
  let msg = `🫶 你把「${p.name}」抱过来揉了揉，毛茸茸的一团贴着你。（亲密度 ${Math.round(p.bond)}·${getPetBondLevel(p.bond)}）`;
  if (touchy) msg += `\n😼 它先挣扎了两下，发现跑不掉，就勉强认了。`;
  else msg += `\n💗 它把脑袋往你手心里拱，喉咙里咕噜咕噜的。`;
  return { ok: true, pet: p, message: msg };
}

// ── 遛弯（主要给需要遛的物种，其他物种等同于出门放风）──
function walkPet(ref) {
  if (!petOn()) return { ok: false, error: '宠物系统已在设置里关闭。' };
  const r = petAliveOrErr(ref);
  if (r.err) return { ok: false, error: r.err };
  const p = r.pet;
  const sp = PET_SPECIES[p.species];
  const stage = getPetStage(p);
  if (Number(healthState.energy) < 12) return { ok: false, error: `你精力见底了（${Math.round(Number(healthState.energy) || 0)}），今天先别遛了。` };
  const env = healthState.env && typeof healthState.env === 'object' ? healthState.env : {};
  const badWeather = Number(env.tempC) <= 2 || Number(env.tempC) >= 34 || env.weather === 'thunder' || Number(env.aqi) > 180;
  const before = p.spirit;
  petNumBump(p, 'spirit', (badWeather ? 12 : 34) * stage.bondGain, 0, 100);
  petNumBump(p, 'bond', 3.0 * stage.bondGain, 0, 100);
  petNumBump(p, 'hygiene', -12, 0, 100);
  petNumBump(p, 'fat', -6.5, 0, PET_FAT_CAP);
  petNumBump(p, 'satiety', -4, 0, 100);
  petNumBump(healthState, 'energy', -12, 0, 100);
  petNumBump(healthState, 'physicalReserve', -6, 0, 100);
  petNumBump(healthState, 'exercise', 8, 0, 100);
  petNumBump(healthState, 'mood', 6, 0, 100);
  petNumBump(healthState, 'stress', 5, 0, 100);
  petNumBump(healthState, 'fatigue', 5, 0, 100);
  p.lastWalk = Date.now();
  let msg = sp.walk
    ? `🦮 你牵着「${p.name}」出门遛了一圈，它一路走一路闻，兴奋得拽着你跑。（心情 ${Math.round(before)} → ${Math.round(p.spirit)}｜亲密度 ${Math.round(p.bond)}）`
    : `🌤️ 你带着「${p.name}」出门放风。（心情 ${Math.round(before)} → ${Math.round(p.spirit)}｜亲密度 ${Math.round(p.bond)}）`;
  if (badWeather) msg += `\n⚠️ 外面天气不好，只待了一小会儿就回来了。`;
  return { ok: true, pet: p, message: msg };
}

// ── 训练（学技能）──
function trainPet(ref) {
  if (!petOn()) return { ok: false, error: '宠物系统已在设置里关闭。' };
  const r = petAliveOrErr(ref);
  if (r.err) return { ok: false, error: r.err };
  const p = r.pet;
  const sp = PET_SPECIES[p.species];
  const stage = getPetStage(p);
  if (!sp.tricks.length) return { ok: false, error: `${sp.name}学不会什么把戏——它最大的本事就是安安静静地待着。` };
  if (stage.key === 'baby') return { ok: false, error: `「${p.name}」还太小（${stage.emoji}${stage.name}），注意力集中不了，等长大一点再教吧。` };
  const pool = sp.tricks.filter(t => !p.tricks.includes(t));
  if (!pool.length) return { ok: false, error: `「${p.name}」已经把手上的把戏全学会了：${p.tricks.map(t => PET_TRICKS[t].name).join('、')}。该给它换个花样，或者夸夸它。` };
  const need = getPetNeeds(p);
  if (need.spirit < 35) return { ok: false, error: `「${p.name}」没精打采的（心情 ${Math.round(need.spirit)}），先陪它玩玩、喂点吃的再训练吧。` };
  if (Number(healthState.energy) < 8) return { ok: false, error: `你精力不够了（${Math.round(Number(healthState.energy) || 0)}），训练是很费神的。` };

  const bondF = Math.min(1.4, 0.5 + p.bond / 100);      // 亲密度越高学得越快
  const spiritF = 0.6 + need.spirit / 250;
  const gain = 16 * bondF * stage.bondGain * spiritF;
  p.skillXp = Math.max(0, Math.round((Number(p.skillXp) || 0) + gain));
  petNumBump(p, 'spirit', -8, 0, 100);
  petNumBump(p, 'satiety', -5, 0, 100);
  petNumBump(p, 'bond', 1.5 * stage.bondGain, 0, 100);
  petNumBump(healthState, 'energy', -4, 0, 100);
  petNumBump(healthState, 'fatigue', 4, 0, 100);
  p.lastTrain = Date.now();

  const learned = [];
  for (const t of sp.tricks) {
    if (p.tricks.includes(t)) continue;
    if (p.skillXp >= PET_TRICKS[t].xp) { p.tricks.push(t); learned.push(t); }
  }
  if (learned.length) {
    for (const t of learned) recordTimeline(PET_TRICKS[t].emoji, `「${p.name}」学会了「${PET_TRICKS[t].name}」`, 'pet');
  }
  const nextT = pool.find(t => (Number(p.skillXp) || 0) < PET_TRICKS[t].xp);
  let msg = `🎓 你耐着性子教「${p.name}」练了一会儿。（训练经验 ${p.skillXp}）`;
  if (learned.length) msg += `\n🎉 它学会了：${learned.map(t => `${PET_TRICKS[t].emoji}${PET_TRICKS[t].name}`).join('、')}！`;
  if (nextT) msg += `\n📈 下一个「${PET_TRICKS[nextT].name}」还差 ${Math.max(0, Math.round(PET_TRICKS[nextT].xp - p.skillXp))} 点经验。`;
  else msg += `\n🏅 该物种能教的把戏都教完了。`;
  return { ok: true, pet: p, learned, message: msg };
}

// ── 表演（把技能亮给人看）──
function showPet(ref) {
  if (!petOn()) return { ok: false, error: '宠物系统已在设置里关闭。' };
  const r = petAliveOrErr(ref);
  if (r.err) return { ok: false, error: r.err };
  const p = r.pet;
  const need = getPetNeeds(p);
  if (!p.tricks.length) return { ok: false, error: `「${p.name}」还没学会什么把戏，先训练它吧（一次训练大约花 4 点精力）。` };
  if (need.spirit < 25) return { ok: false, error: `「${p.name}」今天不想动（心情 ${Math.round(need.spirit)}），别勉强它。` };
  const stage = getPetStage(p);
  petNumBump(p, 'spirit', -6, 0, 100);
  petNumBump(p, 'bond', 1.8 * stage.bondGain, 0, 100);
  petNumBump(healthState, 'mood', 5, 0, 100);
  petNumBump(healthState, 'satisfaction', 4, 0, 100);
  petNumBump(healthState, 'stress', 4, 0, 100);
  const shown = p.tricks.slice(-3).map(t => PET_TRICKS[t]).filter(Boolean);
  const lines = shown.map(t => `　${t.emoji} ${t.name}`).join('\n');
  return {
    ok: true, pet: p,
    message: `🎪 你让「${p.name}」露了一手：\n${lines}\n\n👏 旁边的人都被逗笑了，你心里也挺得意。（心情 +5｜满足 +4｜亲密度 ${Math.round(p.bond)}）`
  };
}

// ── 兽医 ──
function healPetWithVet(ref) {
  if (!petOn()) return { ok: false, error: '宠物系统已在设置里关闭。' };
  const r = petAliveOrErr(ref);
  if (r.err) return { ok: false, error: r.err };
  const p = r.pet;
  const sp = PET_SPECIES[p.species];
  const need = getPetNeeds(p);
  const sick = p.diseases.slice();
  const healthLow = p.health < 80;
  if (!sick.length && !healthLow) {
    return { ok: true, pet: p, message: `🩺 兽医检查了一遍「${p.name}」，说它很健康（健康 ${Math.round(p.health)}，${need.avg >= 70 ? '状态不错' : '就是需求照顾得再细点'}）。不用花钱。` };
  }
  const cost = Math.round(getPetVetCost() * (Number(sp.vetMul) || 1) * (1 + sick.length * 0.3));
  if (!spendPetMoney(cost, '宠物诊疗')) {
    return { ok: false, error: `兽医费要 ¥${cost}，钱包不够（现有 ¥${Math.round(getMoney())}）。宠物的医药费医保是不报的。` };
  }
  p.diseases = [];
  petNumBump(p, 'health', 42, 0, 100);
  petNumBump(p, 'bond', 2.5, 0, 100);
  healthState.petVetCount = (Number(healthState.petVetCount) || 0) + 1;
  recordTimeline('🩺', `带「${p.name}」去看了兽医`, 'pet');
  const curedText = sick.length ? `治好了：${sick.map(d => PET_DISEASES[d] ? PET_DISEASES[d].name : d).join('、')}` : '做了个全面检查';
  let msg = `🩺 你带「${p.name}」去了宠物医院（¥${cost}，自费）。\n　${curedText}｜健康 ${Math.round(p.health)}`;
  if (sp.name === '猫' || sp.name === '狗' || sp.name === '鹦鹉') msg += `\n😿 它在诊台上抖得厉害，回家路上一直往你怀里钻。`;
  return { ok: true, pet: p, message: msg };
}

// ── 改名 ──
function renamePet(ref, newName) {
  const r = petAliveOrErr(ref);
  if (r.err) return { ok: false, error: r.err };
  const p = r.pet;
  const n = typeof newName === 'string' ? newName.trim().slice(0, 12) : '';
  if (!n) return { ok: false, error: '要给宠物起个什么名字？' };
  const old = p.name;
  p.name = n;
  return { ok: true, pet: p, message: `📛 你把「${old}」改名叫「${n}」了。它歪着头看了你一眼，好像还没反应过来。` };
}

// ── 送走（弃养）──
function abandonPet(ref) {
  const r = petAliveOrErr(ref);
  if (r.err) return { ok: false, error: r.err };
  const p = r.pet;
  if (!Array.isArray(healthState.pets)) return { ok: false, error: '没有可送走的宠物。' };
  const idx = healthState.pets.indexOf(p);
  if (idx < 0) {
    const i2 = healthState.pets.findIndex(x => x && x.id === p.id && x.name === p.name);
    if (i2 < 0) return { ok: false, error: '没找到这只宠物。' };
    healthState.pets.splice(i2, 1);
  } else {
    healthState.pets.splice(idx, 1);
  }
  const days = Math.round(getPetAgeDays(p) * 10) / 10;
  petNumBump(healthState, 'mood', -10, 0, 100);
  petNumBump(healthState, 'depressionLevel', 6, 0, 100);
  petNumBump(healthState, 'loneliness', 8, 0, 100);
  recordTimeline('💔', `把「${p.name}」送走了（陪了 ${days} 天）`, 'pet');
  return {
    ok: true,
    message: `💔 你把「${p.name}」送走了。它好像知道要发生什么，一直回头看你。\n（陪了你 ${days} 天｜收好它的东西时，心里空了一块）`
  };
}

// ── 寿终 ──
function petPassAway(p) {
  if (!p || p.memorial) return null;
  const sp = PET_SPECIES[p.species];
  const days = Math.round(getPetAgeDays(p) * 10) / 10;
  p.memorial = { at: Date.now(), ageDays: days, bond: Math.round(Number(p.bond) || 0) };
  p.satiety = 0; p.hydration = 0; p.spirit = 0; p.health = 0; p.diseases = [];
  petNumBump(healthState, 'mood', -16, 0, 100);
  petNumBump(healthState, 'depressionLevel', 10, 0, 100);
  petNumBump(healthState, 'loneliness', 12, 0, 100);
  recordTimeline('🕯️', `「${p.name}」走了，陪了你 ${days} 天`, 'pet');
  log(`[健康系统] 宠物「${p.name}」（${sp.name}）寿终，相处 ${days} 天，最终亲密度 ${Math.round(Number(p.bond) || 0)}`);
  return p;
}

// ── 疾病判定（派生状态先补齐再比较，避免 undefined 误判）──
function checkPetDiseases(pet) {
  const p = pet && pet.species ? pet : ensurePet(pet);
  if (!p || p.memorial) return [];
  const d = petDerived(p);
  const current = [];
  for (const [key, dis] of Object.entries(PET_DISEASES)) {
    let hit = true;
    for (const [sk, cond] of Object.entries(dis.conditions)) {
      const v = Number(d[sk]);
      if (!Number.isFinite(v)) { hit = false; break; }
      if (cond.max !== undefined && !(v <= cond.max)) { hit = false; break; }
      if (cond.min !== undefined && !(v >= cond.min)) { hit = false; break; }
    }
    if (hit) current.push(key);
  }
  return current;
}

// ── 主循环：需求衰减 / 疾病演变 / 掉毛与夜间吵闹 ──
function updatePets(times = 1) {
  if (!petOn()) { healthState.petShed = 0; healthState.petNightNoise = 0; return; }
  if (!Array.isArray(healthState.pets)) healthState.pets = [];
  const now = Date.now();
  let prev = Number(healthState.petLastTick);
  if (!Number.isFinite(prev) || prev <= 0 || prev > now) prev = now;
  healthState.petLastTick = now;
  // 需求按真实经过时间衰减（与寿命同口径）；停机过久时封顶 72 小时，避免一觉醒来全归零
  const hours = Math.max(0, Math.min(72, (now - prev) / 3600000));
  const all = getPets(true);
  if (!all.length) { healthState.petShed = 0; healthState.petNightNoise = 0; return; }

  const t = Math.max(1, Math.min(8, Math.round(Number(times) || 1)));
  let shed = 0, noise = 0;
  for (const p of all) {
    if (p.memorial) continue;
    const sp = PET_SPECIES[p.species];
    const stage = getPetStage(p);

    // 寿命到了 → 寿终（本周期不再衰减）
    if (getPetLifeRatio(p) >= 1) { petPassAway(p); continue; }

    // 四维衰减
    const mul = getPetNeedDecay() * stage.needMul;
    for (const [k, meta] of Object.entries(PET_NEEDS)) {
      const rate = Number(sp.need && sp.need[k] !== undefined ? sp.need[k] : 1);
      petNumBump(p, k, -meta.decay * (Number.isFinite(rate) ? rate : 1) * mul * hours, 0, 100);
    }
    // 饿 / 渴 / 脏 会连带拖垮精神
    const need = getPetNeeds(p);
    if (need.satiety < 30) petNumBump(p, 'spirit', -1.2 * hours, 0, 100);
    if (need.hydration < 25) petNumBump(p, 'spirit', -1.0 * hours, 0, 100);
    if (need.hygiene < 30) petNumBump(p, 'spirit', -0.7 * hours, 0, 100);
    // 肥肉自然回落（活动消耗），老年与暮年更慢
    const slowFat = (stage.key === 'senior' || stage.key === 'twilight') ? 0.5 : 1;
    petNumBump(p, 'fat', -0.35 * slowFat * hours, 0, PET_FAT_CAP);
    if (need.spirit > 75) petNumBump(p, 'fat', -0.20 * slowFat * hours, 0, PET_FAT_CAP);

    // 疾病：新发
    const detected = checkPetDiseases(p);
    for (const d of detected) {
      if (p.diseases.includes(d)) continue;
      p.diseases.push(d);
      const di = PET_DISEASES[d];
      recordTimeline(di.emoji, `「${p.name}」得了${di.name}`, 'pet');
      log(`[健康系统] 宠物「${p.name}」新发疾病：${di.name}（${di.symptoms}）`);
    }
    // 疾病：条件消失则自愈；否则持续扣健康
    const still = [];
    let decaySum = 0;
    const derived = petDerived(p);
    for (const d of p.diseases.slice()) {
      const di = PET_DISEASES[d];
      if (!di) continue;
      let healed = true;
      for (const [sk, cond] of Object.entries(di.conditions)) {
        const v = Number(derived[sk]);
        if (!Number.isFinite(v)) { healed = false; break; }
        if (cond.max !== undefined && !(v > cond.max)) { healed = false; break; }
        if (cond.min !== undefined && !(v < cond.min)) { healed = false; break; }
      }
      if (healed) continue;
      still.push(d);
      decaySum += Number(di.decay) || 0;
    }
    p.diseases = still;
    if (decaySum > 0) petNumBump(p, 'health', -decaySum * t * 0.6, 0, 100);
    else if (need.avg >= 65) petNumBump(p, 'health', 2.2 * hours, 0, 100);
    // 病中或需求极低 → 亲密度下滑
    if (p.diseases.length || need.lowest < 20) petNumBump(p, 'bond', -0.4 * hours, 0, 100);

    // 掉毛 / 夜间吵闹
    const unwell = (100 - Math.max(0, Math.min(100, Number(p.health) || 0))) / 100;
    const dirty = (100 - need.hygiene) / 100;
    const sizeF = 0.8 + (Number(p.fat) || 0) / 250;
    shed += (Number(sp.shed) || 0) * sizeF * (1 + unwell * 0.5 + dirty * 0.35);
    if (Number(sp.nightActive) > 0) noise += Number(sp.nightActive) * (0.4 + need.spirit / 120);
  }
  healthState.petShed = Math.round(shed * 10) / 10;
  healthState.petNightNoise = Math.round(noise * 10) / 10;
}

// ── 宠物对主人的被动影响 ──
function getPetEffects() {
  const all = getPets(true);
  const list = all.filter(p => !p.memorial);
  const memorial = all.length - list.length;
  if (!list.length) {
    return { count: 0, avgBond: 0, closest: null, mood: 0, satisfaction: 0, stress: 0,
             loneliness: 0, belonging: 0, shed: 0, nightNoise: 0, sick: 0, sickList: [], memorial, cost: Math.round(Number(healthState.petCost) || 0) };
  }
  let sumBond = 0, closest = null;
  const sickList = [];
  for (const p of list) {
    sumBond += Number(p.bond) || 0;
    if (p.diseases.length) sickList.push(p);
    if (!closest || (Number(p.bond) || 0) > (Number(closest.bond) || 0)) closest = p;
  }
  const n = list.length;
  const avgBond = sumBond / n;
  return {
    count: n,
    avgBond: Math.round(avgBond * 10) / 10,
    closest,
    mood: Math.min(6, avgBond * 0.055),
    satisfaction: Math.min(7, avgBond * 0.060),
    stress: Math.min(8, avgBond * 0.070),
    loneliness: Math.min(0.9, avgBond * 0.009) * n,   // 有宠物 → 孤独感下降
    belonging: Math.min(6, avgBond * 0.050),
    shed: Number(healthState.petShed) || 0,
    nightNoise: Number(healthState.petNightNoise) || 0,
    sick: sickList.length, sickList,
    memorial,
    cost: Math.round(Number(healthState.petCost) || 0)
  };
}

// 单只宠物的一行描述（报告 / 动作返回共用）
// 入参可能是外部拼的裸对象，先过一遍 ensurePet 补全，避免 diseases/tricks 缺失时崩
function formatPetLine(raw, withNeeds = true) {
  const p = (raw && raw.species) ? ensurePet(raw) : null;
  if (!p) return '';
  const sp = PET_SPECIES[p.species];
  const stage = getPetStage(p);
  const need = getPetNeeds(p);
  if (!withNeeds) return `${sp.emoji}「${p.name}」${stage.emoji}${stage.name}　亲密度 ${Math.round(p.bond)}（${getPetBondLevel(p.bond)}）`;
  const sick = p.diseases.length ? `　🤒 ${p.diseases.map(d => PET_DISEASES[d] ? PET_DISEASES[d].name : d).join('、')}` : '';
  return `${sp.emoji}「${p.name}」${stage.emoji}${stage.name}　${PET_NEEDS.satiety.emoji}${Math.round(need.satiety)} ${PET_NEEDS.hydration.emoji}${Math.round(need.hydration)} ${PET_NEEDS.hygiene.emoji}${Math.round(need.hygiene)} ${PET_NEEDS.spirit.emoji}${Math.round(need.spirit)}　💗${Math.round(p.bond)}（${getPetBondLevel(p.bond)}）　❤️${Math.round(p.health)}${sick}`;
}

// ── 情绪提示 ──
function getPetHint() {
  if (!petOn()) return '';
  const list = getPets();
  if (!list.length) return '';
  const parts = [];
  const sick = list.filter(p => p.diseases.length);
  if (sick.length) {
    const s = sick[0];
    const di = PET_DISEASES[s.diseases[0]];
    parts.push(`「${s.name}」${di ? '得了' + di.name + '（' + di.symptoms + '）' : '不太舒服'}，得带它去看兽医`);
  }
  const needOf = (k, th) => list.filter(p => getPetNeeds(p)[k] < th);
  const hungry = needOf('satiety', 30);
  if (hungry.length) parts.push(`「${hungry[0].name}」饿得一直叫了`);
  const thirsty = needOf('hydration', 25);
  if (thirsty.length) parts.push(`「${thirsty[0].name}」的水碗空了`);
  const dirty = needOf('hygiene', 30);
  if (dirty.length) parts.push(`「${dirty[0].name}」脏兮兮的，该收拾了`);
  const sad = needOf('spirit', 30);
  if (sad.length) parts.push(`「${sad[0].name}」闷闷不乐，想让人陪`);
  const tw = list.filter(p => getPetStage(p).key === 'twilight');
  if (tw.length) parts.push(`「${tw[0].name}」已经到暮年了，趁还来得及多陪陪它`);
  if (!parts.length) {
    const c = list.slice().sort((a, b) => (Number(b.bond) || 0) - (Number(a.bond) || 0))[0];
    if (c && c.bond >= 80) parts.push(`「${c.name}」一看见你就凑过来，你俩感情很深`);
    else if (c && c.bond <= 25) parts.push(`「${c.name}」对你还有点认生`);
  }
  return parts.length ? `【宠物】${parts.join('；')}。` : '';
}

// ══════════════════════════════════════════════════════════════════════════
// v11.0 日常生活 · 一、穿衣
//   此前的漏洞：env 里躺着 tempC/uv/weather，却只影响疾病易感与化验指标 ——
//   天冷不提醒加衣、暴晒不防晒，uv 字段更是只被 getUvLevel() 拿去显示，纯装饰。
//   这里给天气接上「体感」，让 uv 真正进入 game loop。
// ══════════════════════════════════════════════════════════════════════════

// 衣物档位：warm = 保暖度（等效于给体感加温多少度），style 决定心情/社交形象
// ideal = 这件衣服的舒适气温（关键字段）；warm = 保暖量，仅用于淋湿时打折
//   ⚠️ 不能用「体感 = 气温 + 保暖」的线性模型 —— 22℃ 穿长袖（保暖 26）会算出体感 48℃
//      被判成「热到冒烟」。衣物的作用是把可接受的气温区间平移，而不是无条件加温。
const OUTFITS = {
  pajamas:    { name: '睡衣',     emoji: '🩳', warm: 0,  ideal: 26, style: 'home',   desc: '居家最舒服，但见不得人' },
  summer:     { name: '短袖',     emoji: '👕', warm: 6,  ideal: 29, style: 'casual', desc: '夏天的标配' },
  casual:     { name: '长袖休闲', emoji: '👔', warm: 26, ideal: 22, style: 'casual', desc: '春秋常服' },
  light_coat: { name: '薄外套',   emoji: '🧥', warm: 46, ideal: 17, style: 'neat',   desc: '早晚温差大时正合适' },
  coat:       { name: '厚外套',   emoji: '🧣', warm: 68, ideal: 11, style: 'neat',   desc: '深秋到初冬' },
  down:       { name: '羽绒服',   emoji: '🧤', warm: 92, ideal: 1,  style: 'neat',   desc: '零下也能扛' },
  raincoat:   { name: '冲锋衣',   emoji: '🦺', warm: 40, ideal: 15, style: 'sport',  desc: '防水，雨天不淋湿', waterproof: true },
  sport:      { name: '运动装',   emoji: '🎽', warm: 16, ideal: 24, style: 'sport',  desc: '方便活动，运动有加成' },
  formal:     { name: '正装',     emoji: '🤵', warm: 34, ideal: 21, style: 'formal', desc: '见人用，社交形象加成' }
};

// 风格影响：socialImage 在见人场合（聚会/交心/聚餐）生效
const OUTFIT_STYLES = {
  home:   { name: '居家', mood: 4, comfort: 5,  socialImage: -8 },
  casual: { name: '休闲', mood: 1, comfort: 1,  socialImage: 0 },
  neat:   { name: '利落', mood: 2, comfort: 0,  socialImage: 3 },
  sport:  { name: '运动', mood: 1, comfort: 0,  socialImage: 0, exercise: 7 },
  formal: { name: '正式', mood: 0, comfort: -6, socialImage: 9 }
};

// 冷热分级：diff = 气温 − 这身衣服的舒适点（负=衣服不够暖，正=穿多了）
const FEEL_LEVELS = [
  { key: 'freezing',  max: -22,      name: '冻得发抖', comfort: -14, coldRisk: 0.55, tip: '这身薄得跟没穿一样' },
  { key: 'cold',      max: -12,      name: '有点冷',   comfort: -6,  coldRisk: 0.25, tip: '衣服扛不住这天气，缩着脖子' },
  { key: 'cool',      max: -6,       name: '偏凉',     comfort: -1,  coldRisk: 0.06 },
  { key: 'perfect',   max: 6,        name: '刚刚好',   comfort: 3,   coldRisk: 0 },
  { key: 'warm',      max: 12,       name: '有点热',   comfort: -3,  heatRisk: 0.08 },
  { key: 'hot',       max: 22,       name: '热得难受', comfort: -8,  heatRisk: 0.30 },
  { key: 'scorching', max: Infinity, name: '热到冒烟', comfort: -15, heatRisk: 0.55 }
];

// 安全加减状态（与 hobbyBump / petNumBump 同构，独立命名避免语义混淆）
function dailyBump(key, delta, lo = 0, hi = 100) {
  const cur = Number(healthState[key]);
  const base = Number.isFinite(cur) ? cur : lo;
  healthState[key] = Math.max(lo, Math.min(hi, base + delta));
  return healthState[key];
}

function outfitOn() {
  try { return cfg().outfitEnabled !== false; } catch { return true; }
}

// 穿着记录（脏数据自愈）
function getOutfitRec() {
  let o = healthState.outfit;
  if (!o || typeof o !== 'object') o = {};
  if (!OUTFITS[o.worn]) o.worn = 'casual';
  if (!Number.isFinite(Number(o.changedAt))) o.changedAt = 0;
  if (!Number.isFinite(Number(o.wet))) o.wet = 0;
  if (!Number.isFinite(Number(o.sunscreen))) o.sunscreen = 0;
  o.wet = Math.max(0, Math.min(100, Number(o.wet)));
  o.sunscreen = Math.max(0, Math.min(100, Number(o.sunscreen)));
  healthState.outfit = o;
  return o;
}

function getOutfitStats() {
  let s = healthState.outfitStats;
  if (!s || typeof s !== 'object') s = {};
  for (const k of ['wornCount', 'perfectDays', 'sunGuard']) {
    if (!Number.isFinite(Number(s[k]))) s[k] = 0;
  }
  healthState.outfitStats = s;
  return s;
}

function getWornOutfit() {
  const rec = getOutfitRec();
  const key = OUTFITS[rec.worn] ? rec.worn : 'casual';
  const info = OUTFITS[key];
  const style = OUTFIT_STYLES[info.style] || OUTFIT_STYLES.casual;
  return { key, info, style };
}

// 当前穿着下的有效舒适点（淋湿会让衣服的保暖打折 → 舒适点整体下移，更怕冷）
function getOutfitIdeal() {
  const { info } = getWornOutfit();
  const wet = getOutfitRec().wet;
  return Math.round((Number(info.ideal) - wet * 0.06) * 10) / 10;
}

// 冷热偏差：气温 − 有效舒适点（负=冷，正=热）。
//   feels 保留为「外面的气温」，供报告直接展示。
function getFeelsLike() {
  const env = healthState.env && typeof healthState.env === 'object' ? healthState.env : {};
  const raw = Number(env.tempC);
  const temp = Number.isFinite(raw) ? raw : 22;
  return Math.round((temp - getOutfitIdeal()) * 10) / 10;
}

// 冷热分级结果
function getFeelLevel() {
  const gap = getFeelsLike();
  let lvl = FEEL_LEVELS[FEEL_LEVELS.length - 1];
  for (const l of FEEL_LEVELS) { if (gap <= l.max) { lvl = l; break; } }
  const rec = getOutfitRec();
  const env = healthState.env && typeof healthState.env === 'object' ? healthState.env : {};
  const raw = Number(env.tempC);
  const temp = Number.isFinite(raw) ? raw : 22;
  return {
    key: lvl.key, name: lvl.name, tip: lvl.tip || '',
    comfort: Number(lvl.comfort) || 0,
    coldRisk: Number(lvl.coldRisk) || 0,
    heatRisk: Number(lvl.heatRisk) || 0,
    diff: gap,                    // 冷热偏差（负=冷 / 正=热）
    ideal: getOutfitIdeal(),      // 这身衣服的舒适气温
    temp,                         // 外面多少度
    wet: rec.wet,
    feels: temp                   // 兼容：展示用的「外面气温」
  };
}

// UV 风险：环境紫外线强度（0-11），>=6 属强紫外线
function getUvRisk() {
  const env = healthState.env && typeof healthState.env === 'object' ? healthState.env : {};
  const uv = Number(env.uv);
  const base = Number.isFinite(uv) ? uv : 5;
  const rec = getOutfitRec();
  const guarded = rec.sunscreen > 0;
  const eff = guarded ? base * 0.15 : base;   // 涂了防晒相当于把紫外线降到 15%
  return { uv: base, guarded, effective: Math.round(eff * 10) / 10 };
}

// 换衣服
function wearOutfit(key) {
  if (!outfitOn()) return { ok: false, error: '穿衣系统已关闭（可在配置里打开）' };
  const k = key && OUTFITS[key] ? String(key) : null;
  if (!k) {
    return {
      ok: false,
      error: `没有这种衣服：${key}。可选：${Object.keys(OUTFITS).join(' / ')}`,
      list: Object.keys(OUTFITS)
    };
  }
  const rec = getOutfitRec();
  if (rec.worn === k) {
    const info = OUTFITS[k];
    return { ok: false, error: `身上这件就是「${info.name}」${info.emoji}，不用换了` };
  }
  const before = getWornOutfit();
  rec.worn = k;
  rec.changedAt = Date.now();
  const wasWet = rec.wet > 25;
  rec.wet = Math.max(0, rec.wet - 90);        // 换身干衣服
  const info = OUTFITS[k];
  const style = OUTFIT_STYLES[info.style] || OUTFIT_STYLES.casual;
  dailyBump('mood', style.mood);
  dailyBump('comfort', style.comfort);
  const stats = getOutfitStats();
  stats.wornCount = Number(stats.wornCount) + 1;
  const feel = getFeelLevel();
  let msg = `🧥 换上了「${info.name}」${info.emoji}（${style.name}风格）`;
  if (wasWet) msg += '，湿衣服总算脱下来了';
  msg += `\n外面 ${feel.temp}℃　这身适合 ${feel.ideal}℃ 左右　${feel.name}`;
  if (feel.tip) msg += `　${feel.tip}`;
  return { ok: true, message: msg, outfit: k, feels: feel.feels, level: feel.key };
}

// 涂防晒（归入穿衣动作，因为它就是出门前的装备）
function applySunscreen() {
  if (!outfitOn()) return { ok: false, error: '穿衣系统已关闭' };
  const rec = getOutfitRec();
  if (rec.sunscreen > 60) return { ok: false, error: '刚涂过，脸上还挂着呢' };
  rec.sunscreen = 100;
  const stats = getOutfitStats();
  stats.sunGuard = Number(stats.sunGuard) + 1;
  const risk = getUvRisk();
  return { ok: true, message: `🧴 涂好防晒了（当前紫外线 ${risk.uv}，一会儿在户外也不怕）。`, uv: risk.uv };
}

// 出门前的穿搭建议（穿衣动作不带参数时给）
function getOutfitAdvice() {
  const env = healthState.env && typeof healthState.env === 'object' ? healthState.env : {};
  const temp = Number(env.tempC);
  const t = Number.isFinite(temp) ? temp : 22;
  const raining = env.weather === 'rain' || env.weather === 'thunder';
  const risk = getUvRisk();
  const rec = getOutfitRec();
  // 挑舒适点最贴近今天气温的那件；下雨优先选防水的
  let best = 'casual';
  let bestGap = Infinity;
  for (const [k, v] of Object.entries(OUTFITS)) {
    if (raining && v.waterproof) { best = k; bestGap = -1; break; }
    const gap = Math.abs(v.ideal - t);
    if (gap < bestGap) { bestGap = gap; best = k; }
  }
  const tips = [];
  if (raining) tips.push('在下雨，带把伞（或者穿件防水的）');
  if (risk.uv >= 6) tips.push(`紫外线有点猛（${risk.uv}），建议涂个防晒`);
  if (t <= 6) tips.push('外面很冷，别硬扛');
  if (t >= 33) tips.push('热得离谱，穿少点、多喝水');
  return {
    suggest: best, info: OUTFITS[best], temp: t,
    raining, uv: risk.uv, tips,
    current: rec.worn, wet: rec.wet, sunscreen: rec.sunscreen
  };
}

// 穿衣的自然演变：淋湿 / 防晒失效 / 体感影响舒适度 / 受凉与中暑风险
function updateOutfit(times = 1) {
  if (!outfitOn()) return;
  const rec = getOutfitRec();
  const env = healthState.env && typeof healthState.env === 'object' ? healthState.env : {};
  const t = Math.min(Math.max(1, Number(times) || 1), 3);
  const raining = env.weather === 'rain' || env.weather === 'thunder';
  const { info } = getWornOutfit();

  // 淋湿：雨天且不防水，衣服越来越湿；干燥环境慢慢干
  if (raining && !info.waterproof) rec.wet = Math.min(100, rec.wet + 13 * t);
  else rec.wet = Math.max(0, rec.wet - 9 * t);

  // 防晒随出汗/时间失效
  rec.sunscreen = Math.max(0, rec.sunscreen - 8 * t);

  // 日晒累积：紫外线强 + 白天 + 没防晒 → 累积；否则消退。
  // 这是 uv 字段第一次真正进入 game loop（此前只被 getUvLevel() 拿去显示）。
  const uvRisk = getUvRisk();
  const hour = new Date().getHours();
  const daytime = hour >= 9 && hour <= 17;
  if (uvRisk.effective >= 6 && daytime) {
    healthState.sunExposure = Math.min(100, (Number(healthState.sunExposure) || 0) + (uvRisk.effective - 4) * 1.7 * t);
  } else {
    healthState.sunExposure = Math.max(0, (Number(healthState.sunExposure) || 0) - 6 * t);
  }

  // 体感影响舒适度（每周期小幅，避免一个大周期就崩）
  const feel = getFeelLevel();
  if (feel.comfort !== 0) dailyBump('comfort', feel.comfort * 0.45 * t);
  if (feel.key === 'perfect') {
    const stats = getOutfitStats();
    stats.perfectDays = Number(stats.perfectDays) + 1;
  }
  // 穿得难受会磨心情
  if (feel.key === 'freezing' || feel.key === 'scorching') dailyBump('mood', -0.5 * t);

  // 湿冷加重受凉概率
  if (rec.wet > 55) dailyBump('immunity', -1.1 * t);
  else if (rec.wet > 25) dailyBump('immunity', -0.5 * t);
}

function getOutfitHint() {
  if (!outfitOn()) return '';
  const parts = [];
  const { info, style } = getWornOutfit();
  const feel = getFeelLevel();
  const rec = getOutfitRec();
  if (feel.key === 'freezing') parts.push(`身上只有${info.name}，${feel.tip}`);
  else if (feel.key === 'cold') parts.push(`${info.name}顶不住这天气，缩着脖子`);
  else if (feel.key === 'hot' || feel.key === 'scorching') parts.push(`穿着${info.name}捂出一身汗`);
  if (rec.wet > 60) parts.push('衣服湿透了，冰凉地贴在身上，难受');
  else if (rec.wet > 30) parts.push('身上有点潮乎乎的');
  const risk = getUvRisk();
  if (risk.uv >= 7 && !risk.guarded) parts.push(`太阳很毒（紫外线 ${risk.uv}）也没防晒，皮肤发烫`);
  if (style.socialImage <= -6) parts.push('身上这身居家得不适合见人');
  return parts.length ? `【穿着】${parts.join('；')}。` : '';
}

// ══════════════════════════════════════════════════════════════════════════
// v11.0 日常生活 · 二、三餐
//   此前的漏洞：eat 里写着 const healthyMeal = Math.random() < 0.45 ——
//   一天三次的决策被交给了骰子，而后面 8 项营养素 / 菌群 / 血脂血糖 / 热量盈余
//   全都在等这个答案。这里换成一张菜单，让「吃什么」重新变成选择。
// ══════════════════════════════════════════════════════════════════════════

// 菜品表：nut = 营养取向（正=健康/负=垃圾）、gut = 菌群影响、dishes = 产生多少待洗碗
// v13.0：每道菜补一份「营养结构」。
//   此前 9 道菜只有一个 nut 总分，而它只驱动 diet 这一个综合值 ——
//   8 项营养素里的 carbs / fat / sodium / sugar 除了自然衰减没有任何写入来源，
//   于是吃外卖不掉「控盐控糖」、吃火锅不涨脂肪，这四项必然单调掉到 0。
//   语义提醒：sodium =「控盐」、sugar =「控糖」、fat =「脂肪均衡」，三者都是高=好，
//   所以高油高盐的那几道菜在这里是负数，别按字面理解成"盐分含量"。
const MEALS = {
  home_cook: {
    name: '自己下厨', emoji: '🍳', cost: 0, hunger: 36, nut: 2.4, gut: 2.2,
    mood: 7, satisfy: 6, energy: -4, dishes: 3, cook: true,
    nutrition: { protein: 2.2, carbs: 1.8, fat: 1.5, vitamin: 2.6, mineral: 2.0, fiber: 2.4, sodium: 1.6, sugar: 1.4 },
    desc: '省钱又健康，就是要自己动手'
  },
  canteen: {
    name: '食堂工作餐', emoji: '🍱', cost: 15, hunger: 32, nut: 0.7, gut: 0.5,
    mood: 3, satisfy: 2, dishes: 0, electrolyte: true,
    nutrition: { protein: 1.0, carbs: 1.6, fat: 0.4, vitamin: 0.8, mineral: 0.7, fiber: 1.0, sodium: 0.2, sugar: 0.4 },
    desc: '平平无奇的日常'
  },
  takeout: {
    name: '点外卖', emoji: '🥡', cost: 28, hunger: 33, nut: -0.7, gut: -0.8,
    mood: 7, satisfy: 5, dishes: 0, risk: 0.07,
    nutrition: { protein: 1.2, carbs: 1.5, fat: -0.8, vitamin: 0.3, mineral: 0.2, fiber: 0.2, sodium: -1.8, sugar: -0.9 },
    desc: '快，但油盐偏重'
  },
  instant: {
    name: '泡面', emoji: '🍜', cost: 8, hunger: 25, nut: -2.4, gut: -1.8,
    mood: 1, satisfy: 1, dishes: 1, risk: 0.10,
    nutrition: { protein: 0.2, carbs: 1.4, fat: -1.6, vitamin: -1.2, mineral: -0.8, fiber: -0.6, sodium: -2.8, sugar: -1.0 },
    desc: '最便宜，也最不健康'
  },
  fastfood: {
    name: '快餐', emoji: '🍔', cost: 24, hunger: 30, nut: -1.5, gut: -1.3,
    mood: 6, satisfy: 4, dishes: 0, risk: 0.08,
    nutrition: { protein: 1.4, carbs: 1.6, fat: -2.0, vitamin: -0.6, mineral: -0.2, fiber: -0.4, sodium: -2.0, sugar: -1.8 },
    desc: '汉堡薯条，快乐但发胖'
  },
  hotpot: {
    name: '火锅', emoji: '🍲', cost: 78, hunger: 42, nut: -0.5, gut: -0.3,
    mood: 17, satisfy: 13, dishes: 0, social: true, electrolyte: true, surplus: 3,
    nutrition: { protein: 2.6, carbs: 1.0, fat: -1.2, vitamin: 1.8, mineral: 1.2, fiber: 1.6, sodium: -2.2, sugar: -0.4 },
    desc: '热闹，一顿顶三顿'
  },
  night_snack: {
    name: '夜宵', emoji: '🍢', cost: 32, hunger: 26, nut: -1.8, gut: -1.5,
    mood: 13, satisfy: 8, dishes: 0, night: true, surplus: 3.5, risk: 0.12,
    nutrition: { protein: 1.0, carbs: 1.4, fat: -1.6, vitamin: -0.4, mineral: -0.2, fiber: -0.2, sodium: -2.2, sugar: -0.6 },
    desc: '深夜的快乐，胃的负担'
  },
  fancy: {
    name: '下馆子', emoji: '🍽️', cost: 130, hunger: 44, nut: 0.3, gut: 0,
    mood: 23, satisfy: 19, dishes: 0, electrolyte: true,
    nutrition: { protein: 2.4, carbs: 1.2, fat: -0.6, vitamin: 1.6, mineral: 1.4, fiber: 1.4, sodium: -1.2, sugar: -0.2 },
    desc: '好好犒劳自己一顿'
  },
  gather: {
    name: '朋友聚餐', emoji: '🎉', cost: 60, hunger: 40, nut: -0.3, gut: -0.2,
    mood: 21, satisfy: 16, dishes: 0, social: true, relation: true,
    nutrition: { protein: 2.0, carbs: 1.4, fat: -0.8, vitamin: 1.2, mineral: 1.0, fiber: 1.2, sodium: -1.4, sugar: -0.6 },
    desc: '吃的是饭，聊的是感情'
  }
};

// 时间入参清洗：缺省取当前时间；给了就必须是「正的有限数字或数字串」。
//   不能只写 Number.isFinite(Number(v)) —— Number(null) / Number('') / Number(false) 都是 0，
//   会把脏值悄悄"合法化"成 1970-01-01（v10.0 petDerived 踩过同一个坑）。
function toValidTime(ts) {
  if (ts === undefined) return Date.now();
  if (typeof ts !== 'number' && typeof ts !== 'string') return NaN;
  const n = Number(ts);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}

// 本地日期键（避免 toISOString 的 UTC 偏移把「今天」算错 8 小时）
function localDayKey(ts) {
  const t = toValidTime(ts);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
// 本地「日期 时分」时间戳（用于快照/日志的展示串，同样不吃 UTC 偏移）
function localStamp(ts) {
  const t = toValidTime(ts);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return `${localDayKey(t)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 生活开销记账：与 spendMoney 分开 —— 后者会把每一笔都算进 medicalCost，
// 伙食费若是走那条路，报表里的「医疗支出」就失真了。
function spendLiving(n, cat = 'other', note = '') {
  const v = Math.max(0, Math.round(Number(n) || 0));
  if (v <= 0) return true;
  if (getMoney() < v) return false;
  healthState.money = getMoney() - v;
  healthState.livingCost = (Number(healthState.livingCost) || 0) + v;
  recordLedger('out', v, cat, note);
  return true;
}

function mealOn() {
  try { return cfg().mealChoiceEnabled !== false; } catch { return true; }
}

// 当前是否夜宵时段（22:00 - 04:00，按真实钟点，与生理钟相位无关）
function isNightMealTime() {
  const h = new Date().getHours();
  return h >= 22 || h < 4;
}

function getMoney_() { return getMoney(); }

// 今日已吃记录（自动丢弃隔天的条目）
function getMealLog() {
  if (!Array.isArray(healthState.mealLog)) healthState.mealLog = [];
  const today = localDayKey(Date.now());
  healthState.mealLog = healthState.mealLog.filter(x => x && typeof x === 'object' && localDayKey(x.at) === today);
  return healthState.mealLog;
}

function getMealStats() {
  if (!healthState.mealStats || typeof healthState.mealStats !== 'object') healthState.mealStats = {};
  return healthState.mealStats;
}

// 可点清单（附带能否点、为什么不能）
function getMealList() {
  const log = getMealLog();
  const eaten = new Set(log.map(x => x.key));
  const money = getMoney();
  const night = isNightMealTime();
  return Object.entries(MEALS).map(([key, info]) => {
    let ok = true, why = '';
    if (info.night && !night) { ok = false; why = '只有晚上才吃这个'; }
    if (info.cost > money) { ok = false; why = `钱不够（要 ¥${info.cost}）`; }
    return { key, info, ok, why, eaten: eaten.has(key) };
  });
}

// ── 吃饭（核心）──
function eatMeal(key) {
  if (!mealOn()) {
    return { ok: false, error: '三餐选择已关闭（可在配置里打开），现在吃饭仍由随机决定' };
  }
  const k = key && MEALS[key] ? String(key) : null;
  if (!k) {
    return { ok: false, error: `没有这个选项：${key}`, list: Object.keys(MEALS) };
  }
  const info = MEALS[k];

  // 时段限制
  if (info.night && !isNightMealTime()) {
    return { ok: false, error: `大白天的吃什么${info.name}，留到晚上吧` };
  }
  // 余额（价格受配置倍率影响）
  const mCost = Math.round((info.cost || 0) * getMealCostMul());
  if (mCost > 0 && getMoney() < mCost) {
    return { ok: false, error: `钱不够了——${info.name}要 ¥${mCost}，兜里只有 ¥${getMoney()}。该去打工了` };
  }

  // 会做饭的人自己下厨，明显更划算
  const cookBonus = !!(info.cook && isHobbyLearned('cooking'));
  const cookLevel = cookBonus ? getHobbyLevelOf('cooking') : 0;
  const cookMul = cookBonus ? 1 + Math.min(0.6, cookLevel * 0.06) : 1;

  if (mCost > 0) spendLiving(mCost, 'food', info.name);

  // 饱食
  const r = restoreNeed('hunger', info.hunger);
  // 营养（综合分）
  adjustLifestyle('diet', info.nut * 2.6 * (info.cook ? cookMul : 1));
  // v13.0：逐项营养素 —— 把「这顿到底吃了什么」真正写进 8 项营养结构。
  //   下厨手艺只放大「营养正项」，高油高盐的缺点不会被手艺放大。
  const nutBits = [];
  if (info.nutrition) {
    for (const [nk, nv] of Object.entries(info.nutrition)) {
      if (!nv) continue;
      const before = getNutrient(nk);
      const after = addNutrient(nk, nv > 0 && info.cook ? nv * cookMul : nv);
      const d = after - before;
      if (Math.abs(d) >= 1.5) nutBits.push(`${NUTRIENT_INFO[nk] ? NUTRIENT_INFO[nk].name : nk}${d > 0 ? '+' : ''}${d.toFixed(1)}`);
    }
  }
  // 菌群 —— 注意 healGut 只吃正数、damageGut 只吃正数，必须分开调用，
  //        早前写成 healGut(负数) 因而静默失效
  if (gutOn()) {
    if (info.gut >= 0) healGut(info.gut * (info.cook ? cookMul : 1));
    else damageGut(-info.gut);
  }
  // 心情 / 满足 / 精力
  dailyBump('mood', info.mood + (cookBonus && info.cook ? 3 : 0));
  dailyBump('satisfaction', info.satisfy);
  if (info.energy) dailyBump('energy', info.energy);
  // 电解质（食堂/火锅/下馆子这类有汤有菜的）
  if (needDepthOn() && info.electrolyte) healthState.electrolyte = Math.min(100, getSub('electrolyte') + 4);
  // 热量盈余与吃撑
  let surplusTip = '';
  if (needDepthOn()) {
    const extra = (info.surplus || 0) + r.overflow * 0.55;
    if (extra > 0) {
      healthState.calorieSurplus = Math.min(100, getSub('calorieSurplus') + extra);
      if (info.surplus) surplusTip = `（这顿有点超标…）`;
    }
    if (r.overflow > 0) healthState.comfort = Math.max(0, (Number(healthState.comfort) || 0) - r.overflow * 0.3);
  }
  // 洗碗（归到居家系统）
  if (info.dishes > 0 && homeOn()) {
    const home = getHomeRec();
    home.dishes = Math.min(99, Number(home.dishes) + info.dishes);
  }
  // 食物过敏
  const foodAllergy = rollFoodAllergy();
  let allergyTip = '';
  if (foodAllergy.length) {
    const names = foodAllergy.map(x => x.name).join('、');
    allergyTip = `\n🤧 吃完有点不对劲——对${names}过敏，身上开始起反应了（过敏负荷 +${foodAllergy.reduce((a, x) => a + x.delta, 0)}）`;
  }
  // 食品安全风险累积 → 可能吃坏肚子（由 food_poisoning 疾病判定接手）
  let riskTip = '';
  if (info.risk) {
    const mult = k === 'night_snack' && !isNightMealTime() ? 1.4 : 1;
    if (Math.random() < info.risk * mult) {
      healthState.foodRisk = Math.min(100, (Number(healthState.foodRisk) || 0) + 58);
      riskTip = '\n🤢 吃完没多久，肚子开始翻江倒海…';
    }
  }
  // 社交场合：穿什么会被看见
  let socialTip = '';
  if (info.social) {
    const style = getWornOutfit().style;
    if (style.socialImage <= -6) {
      dailyBump('belonging', -2);
      socialTip = `\n😅 穿着${style.name}就出来了，桌上几个人都多看了你两眼`;
    } else if (style.socialImage >= 3) {
      dailyBump('belonging', 2);
      socialTip = '\n✨ 今天这身挺精神，被夸了一句';
    }
    dailyBump('loneliness', -6);
    dailyBump('social', 8);
  }
  // 聚餐：顺手增进一段关系
  if (info.relation) {
    const rel = pickRelationToImprove();
    if (rel) socialTip += `\n💗 跟「${rel.name}」聊得挺开心（亲密度 +${rel.gain}）`;
  }

  // 记录
  getMealLog().push({ key: k, at: Date.now() });
  const stats = getMealStats();
  stats[k] = (Number(stats[k]) || 0) + 1;
  healthState.lastMealAt = Date.now();

  // 加成提示只在真正有加成时给 —— 0 级新手厨艺系数正好是 1，
  // 若不加这个判断会出现「手艺还行，品质 +0%」这种自相矛盾的话
  const bonusTip = (cookBonus && info.cook && cookMul > 1) ? `（手艺还行，品质 +${Math.round((cookMul - 1) * 100)}%）` : '';
  const nutTip = nutBits.length ? `\n🥗 营养：${nutBits.join('　')}` : '';
  return {
    ok: true, meal: k,
    message: `${info.emoji} ${info.name}${mCost ? `（¥${mCost}）` : ''}——${info.desc}${bonusTip}${nutTip}${surplusTip}${socialTip}${allergyTip}${riskTip}`,
    hunger: Number(healthState.hunger)
  };
}

// 取某个爱好的等级（防御式：字段名有变化也不崩）
function getHobbyLevelOf(key) {
  try {
    const h = getHobbies().find(x => x && (x.key === key || x.meta?.key === key));
    return h ? Number(h.level) || 0 : 0;
  } catch { return 0; }
}

// 挑一段关系来加深（优先选亲密度较低、还没到上限的）
function pickRelationToImprove() {
  try {
    if (!relationOn()) return null;
    const list = getRelations();
    if (!list.length) return null;
    const cand = list
      .map(x => ({ name: x.bond?.name || x.uid, bond: x.bond, type: getRelationType(x.bond?.relation) }))
      .filter(x => x.bond && Number(x.bond.affinity) < x.type.cap)
      .sort((a, b) => (Number(a.bond.affinity) || 0) - (Number(b.bond.affinity) || 0));
    if (!cand.length) return null;
    const t = cand[0];
    const before = Number(t.bond.affinity) || 0;
    t.bond.affinity = Math.min(t.type.cap, before + 9);
    return { name: t.name, gain: Math.round((t.bond.affinity - before) * 10) / 10 };
  } catch { return null; }
}

// 三餐的自然演变：食物风险消退 + 跨天清理
function updateMeal(times = 1) {
  const t = Math.min(Math.max(1, Number(times) || 1), 3);
  healthState.foodRisk = Math.max(0, (Number(healthState.foodRisk) || 0) - 9 * t);
  getMealLog();
}

function getMealHint() {
  if (!mealOn()) return '';
  const parts = [];
  const hunger = Number(healthState.hunger);
  const last = Number(healthState.lastMealAt) || 0;
  const hours = last > 0 ? (Date.now() - last) / 3600000 : 99;
  const log = getMealLog();
  if (Number.isFinite(hunger) && hunger < 25) {
    if (hours > 12) parts.push('上一顿是什么时候的事了，肚子早就空了');
    else parts.push('饿得前胸贴后背了');
    const budget = getMoney();
    if (budget < 20) parts.push('偏偏兜里没几个钱，只能下个面或者去食堂');
  } else if (Number.isFinite(hunger) && hunger < 50 && hours > 6) {
    parts.push('有点饿了，该想想这顿吃什么');
  }
  if (isNightMealTime() && log.length && !log.some(x => x.key === 'night_snack')) {
    if (Math.random() < 0.35) parts.push('这个点了，肚子又开始嘀咕要不要来点夜宵');
  }
  const risk = Number(healthState.foodRisk) || 0;
  if (risk > 45) parts.push('胃里一直不太舒服，最近是不是吃得太糊弄了');
  return parts.length ? `【三餐】${parts.join('；')}。` : '';
}

// ══════════════════════════════════════════════════════════════════════════
// v11.0 日常生活 · 三、房间与家务
//   此前的漏洞：computeAllergyLoad 里尘螨只看室外 AQI 与湿度 ——
//   可尘螨住在床单被褥里，最相关的变量是「多久没打扫」，代码里根本没有。
//   补上这一环之后，宠物掉毛 → 房间变脏 → 尘螨 → 过敏 才连成一条真的因果链。
// ══════════════════════════════════════════════════════════════════════════

const HOME_TASKS = {
  tidy: {
    name: '打扫', emoji: '🧹', cost: 0, energy: 6, tidy: 40,
    desc: '扫地拖地擦桌子，顺手把床单也换了'
  },
  laundry: {
    name: '洗衣服', emoji: '🧺', cost: 0, energy: 5, laundry: 48,
    desc: '攒了几天的衣服该洗了'
  },
  quilt: {
    name: '晒被子', emoji: '🌞', cost: 0, energy: 3, tidy: 8, mite: 100,
    desc: '晒被子杀菌除螨，晚上睡得也香'
  },
  dishes: {
    name: '洗碗', emoji: '🍽️', cost: 0, energy: 4, wipeDishes: true,
    desc: '把池子里堆着的碗洗了'
  },
  hire: {
    name: '请保洁', emoji: '🧑‍🔧', cost: 130, energy: 0, tidy: 100, laundry: 100, wipeDishes: true,
    desc: '花钱买省事，一次全包'
  }
};

function homeOn() {
  try { return cfg().homeEnabled !== false; } catch { return true; }
}

// 房间变乱的速度（每个衰减周期掉多少整洁度）
function getTidyDecay() {
  try { const n = Number(cfg().homeTidyDecay); if (Number.isFinite(n) && n >= 0) return n; } catch { /* 默认 0.55 */ }
  return 0.55;
}

// 家务花费（目前只有请保洁收费，走配置）
function getHomeTaskCost(k) {
  const task = HOME_TASKS[k];
  if (!task || !task.cost) return 0;
  if (k === 'hire') {
    try { const n = Number(cfg().costHireCleaner); if (Number.isFinite(n) && n >= 0) return Math.round(n); } catch { /* 默认 130 */ }
  }
  return task.cost;
}

// 菜品价格倍率
function getMealCostMul() {
  let base = 1;
  try { const n = Number(cfg().mealCostMul); if (Number.isFinite(n) && n >= 0) base = n; } catch { /* 默认 1 */ }
  // v13.0：节假日物价（春节/国庆这类时段下馆子明显更贵，双十一反而打折）
  return base * getFestivalPriceMul();
}

// 居家状态（脏数据自愈）
function getHomeRec() {
  let h = healthState.home;
  if (!h || typeof h !== 'object') h = {};
  const num = (k, d) => {
    const v = Number(h[k]);
    return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : d;
  };
  h.tidy = num('tidy', 72);
  h.laundry = num('laundry', 70);
  h.miteRelief = num('miteRelief', 0);
  if (!Number.isFinite(Number(h.dishes))) h.dishes = 0;
  h.dishes = Math.max(0, Math.min(99, Math.round(Number(h.dishes))));
  if (!Number.isFinite(Number(h.petDirt))) h.petDirt = 0;
  for (const k of ['lastTidy', 'lastLaundry', 'lastQuilt']) {
    if (!Number.isFinite(Number(h[k]))) h[k] = 0;
  }
  healthState.home = h;
  return h;
}

function getHomeStats() {
  let s = healthState.homeStats;
  if (!s || typeof s !== 'object') s = {};
  for (const k of ['tidyCount', 'laundryCount', 'quiltCount', 'dishCount', 'hireCount']) {
    if (!Number.isFinite(Number(s[k]))) s[k] = 0;
  }
  healthState.homeStats = s;
  return s;
}

// 房间整洁对尘螨的放大因子（供 computeAllergyLoad 读取）
function getMiteFactor() {
  if (!homeOn()) return 1;
  const h = getHomeRec();
  let mul = 1;
  if (h.tidy < 25) mul = 2.1;
  else if (h.tidy < 45) mul = 1.55;
  else if (h.tidy < 65) mul = 1.15;
  else if (h.tidy >= 85) mul = 0.75;
  // 晒过被子能明显压住螨虫
  if (h.miteRelief > 40) mul *= 0.55;
  else if (h.miteRelief > 10) mul *= 0.8;
  return Math.round(mul * 100) / 100;
}

// 房间乱不乱的一句话描述
function getHomeLevel() {
  const h = getHomeRec();
  const t = h.tidy;
  if (t >= 88) return { key: 'spotless', name: '一尘不染', emoji: '✨' };
  if (t >= 70) return { key: 'tidy', name: '还算整洁', emoji: '🛋️' };
  if (t >= 50) return { key: 'messy', name: '有点乱了', emoji: '🧺' };
  if (t >= 28) return { key: 'dirty', name: '挺乱的', emoji: '🕸️' };
  return { key: 'filthy', name: '下不去脚', emoji: '🪳' };
}

// ── 做家务 ──
function doHomeTask(key) {
  if (!homeOn()) return { ok: false, error: '居家系统已关闭（可在配置里打开）' };
  const k = key && HOME_TASKS[key] ? String(key) : null;
  if (!k) {
    return { ok: false, error: `没有这个家务：${key}`, list: Object.keys(HOME_TASKS) };
  }
  const task = HOME_TASKS[k];
  const home = getHomeRec();
  const stats = getHomeStats();

  // 前置检查
  if (k === 'dishes' && home.dishes <= 0) {
    return { ok: false, error: '池子里干干净净，没碗可洗' };
  }
  if (k === 'quilt') {
    const env = healthState.env && typeof healthState.env === 'object' ? healthState.env : {};
    if (env.weather === 'rain' || env.weather === 'thunder') {
      return { ok: false, error: '外面下雨呢，晒什么被子' };
    }
    if (home.miteRelief > 55) {
      return { ok: false, error: '被子刚晒过，还蓬松着呢，不用折腾' };
    }
  }
  const tCost = getHomeTaskCost(k);
  if (tCost > 0 && getMoney() < tCost) {
    return { ok: false, error: `请保洁要 ¥${tCost}，兜里只有 ¥${getMoney()}，还是自己动手吧` };
  }
  if (task.energy && Number(healthState.energy) < task.energy * 1.2) {
    return { ok: false, error: '累得动都不想动了，歇会儿再说' };
  }

  if (tCost > 0) spendLiving(tCost, 'home', '请保洁');
  if (task.energy) dailyBump('energy', -task.energy);

  const done = [];
  if (task.tidy) {
    const before = home.tidy;
    home.tidy = Math.min(100, home.tidy + task.tidy);
    if (k === 'tidy') home.lastTidy = Date.now();
    if (k === 'quilt') home.lastQuilt = Date.now();
    done.push(`整洁 ${Math.round(before)} → ${Math.round(home.tidy)}`);
  }
  if (task.laundry) {
    const before = home.laundry;
    home.laundry = Math.min(100, home.laundry + task.laundry);
    if (k === 'laundry') home.lastLaundry = Date.now();
    done.push(`衣物洁净 ${Math.round(before)} → ${Math.round(home.laundry)}`);
  }
  if (task.wipeDishes) {
    const n = home.dishes;
    home.dishes = 0;
    done.push(n > 0 ? `洗掉了 ${n} 个碗` : '池子本来就是空的');
  }
  if (task.mite) {
    home.miteRelief = task.mite;
    home.petDirt = Math.max(0, home.petDirt - 40);
    done.push('被子晒得蓬松，螨虫被杀了不少');
  }
  // 统计
  if (k === 'tidy') stats.tidyCount = Number(stats.tidyCount) + 1;
  else if (k === 'laundry') stats.laundryCount = Number(stats.laundryCount) + 1;
  else if (k === 'quilt') stats.quiltCount = Number(stats.quiltCount) + 1;
  else if (k === 'dishes') stats.dishCount = Number(stats.dishCount) + 1;
  else if (k === 'hire') stats.hireCount = Number(stats.hireCount) + 1;

  // 干完活心情与舒适都会好一点
  dailyBump('comfort', k === 'hire' ? 3 : 6);
  dailyBump('satisfaction', k === 'hire' ? 1 : 3);

  const lvl = getHomeLevel();
  const costTip = tCost ? `（¥${tCost}）` : '';
  return {
    ok: true, task: k,
    message: `${task.emoji} ${task.name}${costTip}——${task.desc}\n${done.join('｜')}\n房间现在${lvl.emoji}${lvl.name}`,
    tidy: home.tidy
  };
}

// 居家的自然演变
function updateHome(times = 1) {
  if (!homeOn()) return;
  const home = getHomeRec();
  const t = Math.min(Math.max(1, Number(times) || 1), 3);
  const stats = getHomeStats();

  // 有人住就会慢慢变乱
  home.tidy = Math.max(0, home.tidy - getTidyDecay() * t);
  // 宠物掉毛加速弄脏（petShed 由 updatePets 算好）
  const shed = Number(healthState.petShed) || 0;
  if (shed > 0) {
    const dirt = shed * 0.12 * t;
    home.tidy = Math.max(0, home.tidy - dirt);
    home.petDirt = Math.min(100, (Number(home.petDirt) || 0) + dirt);
  }
  // 衣服越穿越不干净
  home.laundry = Math.max(0, home.laundry - 0.45 * t);
  // 晒被子的除螨余效随时间消退
  home.miteRelief = Math.max(0, (Number(home.miteRelief) || 0) - 7 * t);

  // 房间状况影响舒适度与心情
  if (home.tidy < 25) dailyBump('comfort', -1.0 * t);
  else if (home.tidy < 45) dailyBump('comfort', -0.45 * t);
  else if (home.tidy > 85) dailyBump('comfort', 0.35 * t);
  if (home.dishes >= 8) dailyBump('mood', -0.35 * t);
  // 潮湿天 + 房间脏 → 更容易发霉（霉菌过敏在 computeAllergyLoad 里另算）
  const env = healthState.env && typeof healthState.env === 'object' ? healthState.env : {};
  const hum = Number(env.humidity);
  if (Number.isFinite(hum) && hum > 78 && home.tidy < 40) dailyBump('health', -0.05 * t);
}

function getHomeHint() {
  if (!homeOn()) return '';
  const parts = [];
  const h = getHomeRec();
  const lvl = getHomeLevel();
  if (h.tidy < 30) {
    parts.push(`房间${lvl.emoji}${lvl.name}了${h.petDirt > 25 ? '，地上全是宠物掉的毛' : ''}，一直待着不太舒服`);
  } else if (h.tidy < 50) {
    parts.push(`屋里有点乱（${lvl.name}），该抽空收拾收拾`);
  }
  if (h.dishes >= 8) parts.push(`池子里堆了 ${h.dishes} 个碗没洗`);
  else if (h.dishes >= 4) parts.push('有几个碗还泡在池子里');
  if (h.laundry < 32) parts.push('干净衣服快没了，该开一次洗衣机');
  const stats = getHomeStats();
  if (h.tidy < 45 && Number(stats.tidyCount) === 0) parts.push('从住进来就没正经打扫过');
  return parts.length ? `【居家】${parts.join('；')}。` : '';
}

// ══════════════════════════════════════════════════════════════════════════
// v11.0 日常生活 · 四、账单
//   此前的漏洞：钱包只有「打工赚」和「医疗/爱好/宠物花」，没有房租水电伙食 ——
//   而被动收入 moneyAllowance 默认 ¥5/小时（月约 ¥3600）稳定到账，
//   于是钱只增不减，¥200 的初始存款永远不紧张，「打工」也就没了存在的理由。
//   标定依据：月账单 ¥2850 vs 月被动 ¥3600 → 光靠被动只剩 ¥750，
//   顿顿外卖（¥28×3×30）必然超支，自己下厨则几乎不花钱。
// ══════════════════════════════════════════════════════════════════════════

const BILL_ITEMS = [
  { key: 'rent',      name: '房租',     emoji: '🏠', amount: 1800 },
  { key: 'utilities', name: '水电燃气', emoji: '💡', amount: 260 },
  { key: 'internet',  name: '网费',     emoji: '📶', amount: 90 },
  { key: 'food',      name: '伙食基础', emoji: '🍚', amount: 700 }
];
const BILL_PERIOD_MS = 30 * 86400000;

function billsOn() {
  try { return cfg().billsEnabled !== false; } catch { return true; }
}

function getBillTotal() {
  try { const v = Number(cfg().billMonthlyTotal); if (Number.isFinite(v) && v >= 0) return Math.round(v); } catch { /* 默认 2850 */ }
  return 2850;
}

// 按各分项原有比例分摊总额（用户改了总额时仍保持结构）
function getBillBreakdown() {
  const total = getBillTotal();
  const base = BILL_ITEMS.reduce((a, x) => a + x.amount, 0) || 1;
  return BILL_ITEMS.map(x => Object.assign({}, x, { due: Math.round(total * x.amount / base) }));
}

function getBillsRec() {
  let b = healthState.bills;
  if (!b || typeof b !== 'object') b = {};
  if (!Number.isFinite(Number(b.dueAt))) b.dueAt = 0;
  if (!Number.isFinite(Number(b.unpaid))) b.unpaid = 0;
  if (!Number.isFinite(Number(b.overdue))) b.overdue = 0;
  if (!Number.isFinite(Number(b.lastWarn))) b.lastWarn = 0;
  if (!Array.isArray(b.history)) b.history = [];
  b.unpaid = Math.max(0, Math.round(Number(b.unpaid)));
  healthState.bills = b;
  return b;
}

function getBillStats() {
  let s = healthState.billStats;
  if (!s || typeof s !== 'object') s = {};
  if (!Number.isFinite(Number(s.paidCount))) s.paidCount = 0;
  if (!Number.isFinite(Number(s.totalPaid))) s.totalPaid = 0;
  healthState.billStats = s;
  return s;
}

// 距下次账单还有几天
function getDaysToBill() {
  const b = getBillsRec();
  if (!b.dueAt) return 30;
  return Math.max(0, Math.ceil((b.dueAt - Date.now()) / 86400000));
}

// ── 还清欠款 ──
function payBills() {
  if (!billsOn()) return { ok: false, error: '账单系统已关闭（可在配置里打开）' };
  const b = getBillsRec();
  if (b.unpaid <= 0) return { ok: false, error: '不欠钱，账是清的' };
  if (getMoney() < b.unpaid) {
    return { ok: false, error: `还差 ¥${Math.round(b.unpaid - getMoney())} 才够，先去打份工吧` };
  }
  const amt = Math.round(b.unpaid);
  spendLiving(amt, 'bill', '补交欠费');
  b.unpaid = 0;
  b.overdue = 0;
  const st = getBillStats();
  st.paidCount = Number(st.paidCount) + 1;
  st.totalPaid = Number(st.totalPaid) + amt;
  // 压力值是「高=无压力」，还了钱该加；安全感同理
  dailyBump('stress', 9);
  dailyBump('security', 7);
  recordTimeline('💸', `把欠着的 ¥${amt} 账单补上了`, 'bill');
  return { ok: true, message: `💸 欠的 ¥${amt} 补上了，心里那块石头总算落地（余额 ¥${Math.round(getMoney())}）` };
}

// 账单结算与欠费压力
function updateBills(times = 1) {
  if (!billsOn()) return;
  const b = getBillsRec();
  const t = Math.min(Math.max(1, Number(times) || 1), 3);
  const now = Date.now();

  // 首次启用给一个完整账期的缓冲，不搞开门就欠债
  if (!b.dueAt) { b.dueAt = now + BILL_PERIOD_MS; return; }

  let guard = 0;
  while (now >= b.dueAt && guard < 12) {
    const due = getBillTotal() + Number(b.unpaid || 0);
    if (getMoney() >= due) {
      spendLiving(due, 'bill', '月账单');
      b.unpaid = 0;
      b.history.unshift({ at: b.dueAt, amount: due, ok: true });
      const st = getBillStats();
      st.paidCount = Number(st.paidCount) + 1;
      st.totalPaid = Number(st.totalPaid) + due;
      log(`[健康系统] 💸 自动扣缴本月账单 ¥${due}`);
      recordTimeline('💸', `交了这个月的房租水电（¥${due}）`, 'bill');
    } else {
      b.unpaid = Math.round(due);
      b.overdue = Number(b.overdue) + 1;
      b.history.unshift({ at: b.dueAt, amount: due, ok: false });
      log(`[健康系统] ⚠️ 本月账单 ¥${due} 未缴清，累计欠费 ¥${b.unpaid}`);
      recordTimeline('⚠️', `这个月的账没交上，欠了 ¥${due}`, 'bill');
    }
    b.history = b.history.slice(0, 12);
    b.dueAt += BILL_PERIOD_MS;
    guard++;
  }

  // 欠费持续磨损压力与安全感
  if (b.unpaid > 0) {
    const press = Math.min(3.2, 0.45 + b.unpaid / 1300) * t;
    dailyBump('stress', -press);
    dailyBump('security', -press * 0.7);
    if (b.overdue >= 3) dailyBump('mood', -0.32 * t);
    if (b.overdue >= 6) dailyBump('sleep', -0.2 * t);
  }
}

function getBillHint() {
  if (!billsOn()) return '';
  const b = getBillsRec();
  const parts = [];
  if (b.unpaid > 0) {
    parts.push(`还欠着 ¥${b.unpaid} 的房租水电（拖了 ${b.overdue} 期），一想到这个就有点喘不过气`);
    if (getMoney() >= b.unpaid) parts.push('其实钱够，就是一直没去交');
  } else {
    const days = getDaysToBill();
    if (days <= 3) parts.push(`再过 ${days} 天又要交房租了（¥${getBillTotal()}），得留点钱`);
    else if (getMoney() < getBillTotal() * 0.4) parts.push(`兜里的钱还不到一次账单的三分之一，得想办法多赚点`);
  }
  return parts.length ? `【账单】${parts.join('；')}。` : '';
}

// ══════════════════════════════════════════════════════════════════════════
// v12.0 钱币系统
//   此前的漏洞：支出侧已经有六条腿（医疗/爱好/宠物/三餐/账单/保洁），
//   收入侧却只有两条，而且都很虚 ——
//     ① moneyAllowance ¥5/小时凭空滴灌，注释原文写着「保证不会被医疗费用卡死」，
//        是兜底补丁：没有雇主、没有发薪日、没有世界观理由；
//     ② work 用 `60 + Math.floor(Math.random()*41)` 掷骰子，
//        跟体质/健康/疲劳/技能全部无关 —— 与 v11.0 里刚铲掉的
//        `eat` 那句 `Math.random() < 0.45` 是同一个毛病，只是长在收入侧。
//   还有一处浪费：v9.0 建的技能树（19 门爱好 / 11 级熟练度）没有变现出口，
//   练到「泰斗」和「门外汉」在收入上完全一样。
//   于是三件事：发薪日（节奏）+ 打工读状态（卖时间）+ 技艺变现（卖手艺），
//   并把每一笔进出都记进账本 —— 钱才有「来路」与「去向」。
// ══════════════════════════════════════════════════════════════════════════

// ── 一、收支账本 ──────────────────────────────────────────────────────────
const LEDGER_CAP = 40;
const LEDGER_CATS = {
  salary:  { name: '工资',     emoji: '💼' },
  gig:     { name: '接单',     emoji: '🧾' },
  work:    { name: '打零工',   emoji: '💪' },
  pocket:  { name: '零钱杂项', emoji: '🪙' },
  gift:    { name: '红包礼金', emoji: '🧧' },
  medical: { name: '看病买药', emoji: '🏥' },
  food:    { name: '吃饭',     emoji: '🍜' },
  bill:    { name: '房租水电', emoji: '🏠' },
  home:    { name: '家务开销', emoji: '🧹' },
  hobby:   { name: '爱好',     emoji: '🎨' },
  pet:     { name: '宠物',     emoji: '🐾' },
  other:   { name: '其他',     emoji: '📦' }
};

function getLedgerCat(key) { return LEDGER_CATS[key] || LEDGER_CATS.other; }

function ledgerOn() {
  try { return cfg().ledgerEnabled !== false; } catch { return true; }
}

// 本地月份键（不用 toISOString —— UTC 偏移会让「本月」在月初/月末算错一天）
function localMonthKey(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now());
  const p2 = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`;
}

function getLedger() {
  let l = healthState.ledger;
  if (!l || typeof l !== 'object') l = {};
  if (!Array.isArray(l.income)) l.income = [];
  if (!Array.isArray(l.expense)) l.expense = [];
  if (typeof l.monthKey !== 'string' || !l.monthKey) l.monthKey = localMonthKey();
  for (const k of ['monthIn', 'monthOut', 'totalIn', 'totalOut']) {
    const v = Number(l[k]);
    l[k] = Number.isFinite(v) && v >= 0 ? Math.round(v) : 0;
  }
  healthState.ledger = l;
  return l;
}

// mergeMs > 0 时，与同类别上一条在时间窗内合并。
//   零钱是按周期滴灌的小额，逐条记账既会把流水刷满，也看不出「这个月杂项收了多少」。
function recordLedger(kind, amount, cat = 'other', note = '', mergeMs = 0) {
  if (!ledgerOn()) return;
  const v = Math.round(Number(amount) || 0);
  if (v <= 0) return;
  const l = getLedger();
  const mk = localMonthKey();
  if (l.monthKey !== mk) { l.monthKey = mk; l.monthIn = 0; l.monthOut = 0; }  // 跨月自动翻篇
  const arr = kind === 'in' ? l.income : l.expense;
  const head = arr[0];
  if (mergeMs > 0 && head && head.cat === cat && Date.now() - Number(head.at || 0) <= mergeMs) {
    head.amount = Math.round(Number(head.amount) || 0) + v;
    head.at = Date.now();
    if (note) head.note = String(note).slice(0, 40);
  } else {
    arr.unshift({ at: Date.now(), amount: v, cat, note: String(note || '').slice(0, 40) });
    if (arr.length > LEDGER_CAP) arr.length = LEDGER_CAP;
  }
  if (kind === 'in') { l.monthIn += v; l.totalIn += v; }
  else { l.monthOut += v; l.totalOut += v; }
}

// 按类别汇总一组流水
function ledgerBreakdown(list) {
  const src = Array.isArray(list) ? list : [];
  const agg = {};
  for (const it of src) {
    const c = String(it.cat || 'other');
    agg[c] = (Number(agg[c]) || 0) + (Number(it.amount) || 0);
  }
  const rows = Object.keys(agg)
    .map(k => ({ key: k, amount: Math.round(agg[k]), info: getLedgerCat(k) }))
    .sort((a, b) => b.amount - a.amount);
  return { rows, sum: rows.reduce((a, x) => a + x.amount, 0) };
}

function getLedgerSummary() {
  const l = getLedger();
  return {
    monthKey: l.monthKey,
    monthIn: l.monthIn, monthOut: l.monthOut, net: l.monthIn - l.monthOut,
    totalIn: l.totalIn, totalOut: l.totalOut, totalNet: l.totalIn - l.totalOut,
    inBreak: ledgerBreakdown(l.income),
    outBreak: ledgerBreakdown(l.expense)
  };
}

// 收入与支出混排的最近流水
function getLedgerFlow(n = 5) {
  const l = getLedger();
  const all = []
    .concat(l.income.map(x => Object.assign({ kind: 'in' }, x)))
    .concat(l.expense.map(x => Object.assign({ kind: 'out' }, x)))
    .sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  return all.slice(0, Math.max(1, Math.min(LEDGER_CAP, Math.round(Number(n) || 5))));
}

function getLedgerText(n = 6) {
  const s = getLedgerSummary();
  const sign = (v) => (v >= 0 ? '+' : '');
  const lines = [`📒 ${s.monthKey} 本月：收入 ¥${s.monthIn}　支出 ¥${s.monthOut}　净 ${sign(s.net)}¥${s.net}`];
  lines.push(`　累计：收入 ¥${s.totalIn}　支出 ¥${s.totalOut}　净 ${sign(s.totalNet)}¥${s.totalNet}`);
  if (s.inBreak.rows.length) lines.push(`　来路：${s.inBreak.rows.map(r => `${r.info.emoji}${r.info.name} ¥${r.amount}`).join('　')}`);
  if (s.outBreak.rows.length) lines.push(`　去向：${s.outBreak.rows.map(r => `${r.info.emoji}${r.info.name} ¥${r.amount}`).join('　')}`);
  const flow = getLedgerFlow(n);
  if (flow.length) {
    lines.push('　最近流水：');
    for (const it of flow) {
      const info = getLedgerCat(it.cat);
      lines.push(`　　${it.kind === 'in' ? '📈' : '📉'} ${info.emoji}${info.name}　${it.kind === 'in' ? '+' : '-'}¥${it.amount}${it.note ? `（${escHtml(String(it.note))}）` : ''}`);
    }
  } else {
    lines.push('　（还没有流水）');
  }
  return lines.join('\n');
}

// ── 二、发薪日 ────────────────────────────────────────────────────────────
//   原来是「每小时 +¥5」的滴灌（月约 ¥3600），而账单是「30 天一次扣 ¥2850」的大额，
//   两者节奏完全不对齐：现实里是月中旬紧、发薪日松，滴灌没有这种起伏。
//   现在月薪一次性到账，与账单同周期；moneyAllowance 降级为「零钱」
//   （默认 ¥1/小时 ≈ ¥720/月，拾荒/利息/零星小钱那种量级）。
const SALARY_PERIOD_MS = 30 * 86400000;
const SALARY_FIRST_DELAY_MS = 10 * 86400000;   // 开局不用干等一个月，10 天后发第一笔

function salaryOn() {
  try { return cfg().salaryEnabled !== false; } catch { return true; }
}

function getMonthlySalary() {
  try { const v = Number(cfg().salaryMonthly); if (Number.isFinite(v) && v >= 0) return Math.round(v); } catch { /* 默认 3600 */ }
  return 3600;
}

function getWalletRec() {
  let w = healthState.wallet;
  if (!w || typeof w !== 'object') w = {};
  for (const k of ['salaryAt', 'lastPaid', 'payCount', 'totalSalary']) {
    const v = Number(w[k]);
    w[k] = Number.isFinite(v) && v >= 0 ? v : 0;
  }
  w.payCount = Math.round(w.payCount);
  w.totalSalary = Math.round(w.totalSalary);
  healthState.wallet = w;
  return w;
}

function getDaysToPay() {
  const w = getWalletRec();
  if (!w.salaryAt) return 0;
  return Math.max(0, Math.ceil((w.salaryAt - Date.now()) / 86400000));
}

function updateSalary() {
  const now = Date.now();
  const w = getWalletRec();
  if (!w.salaryAt) { w.salaryAt = now + SALARY_FIRST_DELAY_MS; return; }
  let guard = 0;
  // 关掉发薪时也要推进时间轴，否则重新打开会一次性补发一大笔
  while (now >= w.salaryAt && guard < 6) {
    if (salaryOn()) {
      const pay = getMonthlySalary();
      if (pay > 0) {
        addMoney(pay, 'salary', '月薪到账');
        w.payCount += 1;
        w.lastPaid = w.salaryAt;
        w.totalSalary += pay;
        // 安全感与压力值都是「高=好」的维度，发薪日两个都该涨
        dailyBump('security', 8);
        dailyBump('stress', 6);
        log(`[健康系统] 💼 发薪日：¥${pay} 到账`);
        recordTimeline('💼', `发工资了，¥${pay} 到账`, 'money');
      }
    }
    w.salaryAt += SALARY_PERIOD_MS;
    guard++;
  }
}

// ── 三、技艺变现（接单）──────────────────────────────────────────────────
//   接一单 = 拿这门手艺做一件作品 → 按品质与熟练度定价卖出去。
//   复用 v9.0 的 rollWorkQuality：等级越高，作品品质的期望分布越好，
//   于是「练」与「赚」第一次成了同一件事的两面。
const GIGS = {
  painting:    { name: '接插画约稿',   emoji: '🖼️', base: 110, org: '约稿的甲方',   need: 2, unit: '张' },
  photography: { name: '接约拍',       emoji: '📸', base: 150, org: '客户',         need: 2, unit: '组' },
  calligraphy: { name: '代人题字',     emoji: '✒️', base: 85,  org: '求字的人',     need: 2, unit: '幅' },
  woodwork:    { name: '定制木作',     emoji: '🪑', base: 130, org: '订户',         need: 3, unit: '件' },
  knitting:    { name: '手作毛线小物', emoji: '🧣', base: 65,  org: '买家',         need: 2, unit: '件' },
  cooking:     { name: '上门做饭',     emoji: '🍲', base: 90,  org: '雇主',         need: 2, unit: '桌' },
  baking:      { name: '接单做蛋糕',   emoji: '🎂', base: 95,  org: '订蛋糕的人',   need: 2, unit: '个' },
  coding:      { name: '接外包小项目', emoji: '⌨️', base: 180, org: '甲方',         need: 3, unit: '单' },
  gaming:      { name: '接代练',       emoji: '🎯', base: 70,  org: '号主',         need: 2, unit: '段' },
  guitar:      { name: '酒吧驻唱',     emoji: '🎙️', base: 120, org: '酒吧老板',     need: 3, unit: '场' },
  piano:       { name: '陪练钢琴',     emoji: '🎼', base: 140, org: '学生家长',     need: 3, unit: '节' },
  singing:     { name: '商演唱歌',     emoji: '🎤', base: 110, org: '主办方',       need: 3, unit: '场' }
};
// 注：跑步/游泳/瑜伽/跳舞/养花/读书/下棋 这 7 门是「自我锻炼／自我输入」型，
//     交不出可卖的东西，接不到单 —— 有能赚和不能赚的对比，技能树才有取舍。

// 甲方事件：交活之后才发生的事 —— 再好的作品也可能被人挑刺
const GIG_EVENTS = [
  { key: 'fair',  mul: 1.00, p: 0.62, msg: '' },
  { key: 'pick',  mul: 0.62, p: 0.14, msg: '甲方挑了半天毛病，硬是压了价' },
  { key: 'bonus', mul: 1.35, p: 0.14, msg: '甲方觉得做得好，主动多给了点' },
  { key: 'rush',  mul: 1.70, p: 0.06, msg: '这单是插队的急活，价钱给得高' },
  { key: 'flop',  mul: 0.00, p: 0.04, msg: '被退稿了，改了三版还是不要，这单白干' }
];
const GIG_ENERGY_COST = 30;

function gigOn() {
  try { return cfg().gigEnabled !== false; } catch { return true; }
}
function getGigPayMul() {
  try { const v = Number(cfg().gigPayMul); if (Number.isFinite(v) && v > 0) return v; } catch { /* 默认 1 */ }
  return 1;
}
function getGigCooldownMs() {
  try { const h = Number(cfg().gigCooldownHours); if (Number.isFinite(h) && h >= 0) return h * 3600000; } catch { /* 默认 10 */ }
  return 10 * 3600000;
}

function getGigRec() {
  let g = healthState.gig;
  if (!g || typeof g !== 'object') g = {};
  for (const k of ['lastAt', 'count', 'total', 'best', 'flops']) {
    const v = Number(g[k]);
    g[k] = Number.isFinite(v) && v >= 0 ? v : 0;
  }
  g.count = Math.round(g.count);
  g.total = Math.round(g.total);
  g.best = Math.round(g.best);
  g.flops = Math.round(g.flops);
  if (!g.byKey || typeof g.byKey !== 'object') g.byKey = {};
  if (typeof g.lastKey !== 'string') g.lastKey = '';
  healthState.gig = g;
  return g;
}

function getGigInfo(key) { return GIGS[key] || null; }

// 所有可接单手艺（含没练到门槛的，用于展示「还差多少」）
function getGigList() {
  const out = [];
  for (const key of Object.keys(GIGS)) {
    const meta = HOBBIES[key];
    if (!meta) continue;
    const learned = isHobbyLearned(key);
    const level = learned ? getHobbyLevelOf(key) : 0;
    out.push({ key, gig: GIGS[key], meta, learned, level, ready: learned && level >= GIGS[key].need });
  }
  return out.sort((a, b) => (Number(b.ready) - Number(a.ready)) || (b.level - a.level));
}

function getReadyGigs() { return getGigList().filter(x => x.ready); }

function getGigCooldownLeftMs() {
  const cd = getGigCooldownMs();
  if (cd <= 0) return 0;
  const left = cd - (Date.now() - Number(getGigRec().lastAt || 0));
  return left > 0 ? left : 0;
}

function rollGigEvent() {
  const r = Math.random();
  let acc = 0;
  for (const e of GIG_EVENTS) { acc += e.p; if (r < acc) return e; }
  return GIG_EVENTS[0];
}

// 品质概率分布（解析式，与 rollWorkQuality 的分档保持同源，避免手工推公式跑偏）
function getGigQualityOdds(level, passion) {
  const lv = Math.max(0, Math.min(10, Number(level) || 0));
  const pa = Math.max(0, Math.min(100, Number(passion) || 0));
  const pMaster = 0.015 + lv * 0.011 + pa / 2400;
  const pGreat = 0.08 + lv * 0.018;
  const pFine = 0.26 + lv * 0.012;
  return { master: pMaster, great: pGreat, fine: pFine, rough: Math.max(0, 1 - pMaster - pGreat - pFine) };
}

// 预估一单收入（不含甲方事件，用来给建议；确定性，不会每次刷新都跳数）
function estimateGigPay(key) {
  const g = GIGS[key];
  if (!g) return 0;
  const lv = getHobbyLevelOf(key);
  const hb = healthState.hobbies && healthState.hobbies[key];
  const odds = getGigQualityOdds(lv, hb ? hb.passion : 50);
  let avgMul = 0;
  for (const q of WORK_QUALITY_ORDER) avgMul += odds[q] * Number(WORK_QUALITIES[q].price || 1);
  return Math.round(g.base * avgMul * (1 + lv * 0.1) * getGigPayMul());
}

function doGig(key) {
  if (!gigOn()) return { ok: false, error: '接单系统已关闭（可在配置里打开）' };
  if (!hobbyOn()) return { ok: false, error: '爱好系统未启用 —— 没有手艺就接不到单' };

  const k = String(key || '').trim();
  if (!k) {
    const ready = getReadyGigs();
    if (!ready.length) {
      const learning = getGigList().filter(x => x.learned && !x.ready).map(x => `${x.meta.name}(${x.level}/${x.gig.need}级)`);
      return { ok: false, error: `现在没有能接的单 —— 接单要手艺练到 2~3 级。${learning.length ? `还差口气的：${learning.join('、')}` : '你还没学任何能接单的手艺'}` };
    }
    return {
      ok: false,
      error: `接哪门手艺的单？现在能接：${ready.map(x => `${x.gig.emoji}${x.gig.name}（${x.meta.name} ${x.level} 级，约 ¥${estimateGigPay(x.key)}/单）`).join('　')}`
    };
  }

  const g = GIGS[k];
  if (!g) {
    const names = Object.keys(GIGS).map(x => `${HOBBIES[x].name}(${x})`).join('、');
    return { ok: false, error: `「${key}」接不到单。可接单的手艺：${names}` };
  }
  if (!isHobbyLearned(k)) return { ok: false, error: `还没学过「${HOBBIES[k].name}」，先把入门装备备齐再来接单` };

  const cdLeft = getGigCooldownLeftMs();
  if (cdLeft > 0) return { ok: false, error: `刚交完一单，还有 ${Math.ceil(cdLeft / 3600000)} 小时才缓过来 —— 赶工砸招牌` };

  const lv = getHobbyLevelOf(k);
  if (lv < g.need) {
    return { ok: false, error: `「${HOBBIES[k].name}」才 ${lv} 级（${getHobbyLevelName(lv)}），接单至少要 ${g.need} 级（${getHobbyLevelName(g.need)}）—— 手艺不够，人家不敢把活交过来` };
  }
  const energy = Number(healthState.energy) || 0;
  if (energy < GIG_ENERGY_COST) {
    return { ok: false, error: `累到眼皮打架还接单是砸自己招牌（精力 ${Math.round(energy)}，接单要 ${GIG_ENERGY_COST}）—— 先睡一觉` };
  }

  const hb = healthState.hobbies[k];
  const passion = hb ? (Number(hb.passion) || 50) : 50;
  const work = rollWorkQuality(k, lv, passion);
  const qInfo = WORK_QUALITIES[work.quality] || WORK_QUALITIES.rough;
  const ev = rollGigEvent();
  const pay = Math.max(0, Math.round(g.base * Number(qInfo.price || 1) * (1 + lv * 0.1) * ev.mul * getGigPayMul()));

  // —— 结算 ——
  const now = Date.now();
  const rec = getGigRec();
  rec.lastAt = now;
  rec.count += 1;
  rec.total += pay;
  rec.best = Math.max(rec.best, pay);
  rec.lastKey = k;
  rec.byKey[k] = (Number(rec.byKey[k]) || 0) + 1;
  if (ev.key === 'flop') rec.flops += 1;
  if (pay > 0) addMoney(pay, 'gig', `${g.name}（${work.name}）`);

  // 干中学：接单也算成长，但不如专门练来得快
  const gainXp = 2 + Math.floor(lv * 0.3);
  let lvAfter = lv;
  if (hb) {
    hb.xp = Math.max(0, Number(hb.xp) || 0) + gainXp;
    hb.lastPractice = now;
    healthState.hobbyLastPractice = now;
    lvAfter = getHobbyLevel(hb.xp);
  }

  // 消耗：接单比练习更狠（要赶活、要跟甲方来回）
  hobbyBump('energy', -GIG_ENERGY_COST);
  hobbyBump('fatigue', 8);
  hobbyBump('mentalFatigue', 6);
  hobbyBump('hobbyStrain', (HOBBIES[k].strain || 0) * 1.6);
  hobbyBump('hobbyEyeStrain', (HOBBIES[k].eye || 0) * 1.6);
  if (ev.key === 'flop') {
    hobbyBump('mood', -9);
    hobbyBump('satisfaction', -4);
    hobbyBump('stress', -6);   // stress 高=无压力，减=压力上升
  } else {
    hobbyBump('mood', 3 + lv * 0.5 + (ev.key === 'bonus' || ev.key === 'rush' ? 4 : 0));
    hobbyBump('satisfaction', 2.5 + lv * 0.4);
    hobbyBump('stress', 2);
  }

  recordTimeline(g.emoji, ev.key === 'flop' ? `接了${g.name}，结果被退稿` : `接了${g.name}，到手 ¥${pay}`, 'money');

  // —— 文案 ——
  const lines = [`${g.emoji} 【${g.name}】把活交了`];
  lines.push(`　做出来的是 ${work.emoji}${work.name}（${HOBBIES[k].name} ${lv} 级·${getHobbyLevelName(lv)}）`);
  if (ev.msg) lines.push(`　${ev.key === 'flop' ? '❌' : (ev.key === 'bonus' || ev.key === 'rush') ? '✨' : '💬'} ${ev.msg}`);
  lines.push(`　${pay > 0 ? `💰 到手 ¥${pay}（余额 ¥${Math.round(getMoney())}）` : '💸 一分钱没进账'}`);
  const costBits = [`精力 -${GIG_ENERGY_COST}`, '疲劳 +8', '精神疲劳 +6'];
  if ((HOBBIES[k].strain || 0) > 0.8) costBits.push(`上肢劳损 +${((HOBBIES[k].strain || 0) * 1.6).toFixed(1)}`);
  if ((HOBBIES[k].eye || 0) > 0.8) costBits.push(`视疲劳 +${((HOBBIES[k].eye || 0) * 1.6).toFixed(1)}`);
  lines.push(`　消耗：${costBits.join('　')}`);
  lines.push(`　熟练度 +${gainXp} XP　累计接单 ${rec.count} 次（共 ¥${rec.total}）`);
  if (lvAfter > lv) lines.push(`　📈 熟练度 ${lv} → ${lvAfter}（${getHobbyLevelName(lvAfter)}）`);
  if (rec.count === 1) lines.push('　✦ 第一次靠自己的手艺赚到钱');

  return { ok: true, key: k, gig: g, work, event: ev, pay, gainXp, level: lv, levelAfter: lvAfter, message: lines.join('\n') };
}

// ── 四、打工（卖时间）────────────────────────────────────────────────────
//   原来 work 的收入是 `60 + Math.floor(Math.random()*41)` —— 跟体质、健康、
//   疲劳、饥饿全无关，纯掷骰子。现在读身体状态：状态好手脚麻利赚得多，
//   饿着肚子或带着疲劳去干就只值半价；并按工种区分消耗、冷却与门槛。
const WORK_TYPES = {
  labor:   { name: '体力活', emoji: '💪', base: 95,  cdH: 6, need: 0, energy: 22, fatigue: 15, strain: 2.2, mood: -1.5, hunger: 12, thirst: 10,
             acts: '搬货、装卸、帮人扛东西', tag: '纯拼身体' },
  errand:  { name: '跑腿',   emoji: '🛵', base: 72,  cdH: 4, need: 0, energy: 14, fatigue: 9,  strain: 0.8, mood: -1.0, hunger: 8,  thirst: 12,
             acts: '送外卖、代取快递、替人排队', tag: '风里来雨里去' },
  skilled: { name: '细活',   emoji: '🖊️', base: 148, cdH: 8, need: 4, energy: 12, fatigue: 7,  strain: 0.6, mood: -3.0, hunger: 6,  thirst: 6,
             acts: '校对、录入、翻译、做表格', tag: '有手艺才接得到' }
};
const WORK_TYPE_ALIAS = {
  labor: 'labor', 体力: 'labor', 体力活: 'labor', 搬货: 'labor', 装卸: 'labor',
  errand: 'errand', 跑腿: 'errand', 外卖: 'errand', 送外卖: 'errand',
  skilled: 'skilled', 细活: 'skilled', 文职: 'skilled', 办公室: 'skilled', 笔头活: 'skilled'
};

function getWorkTypeInfo(k) { return WORK_TYPES[k] || null; }

// 最高爱好等级 —— 「细活」的门槛：有手艺才有人找你做要脑子的活
function getTopHobbyLevel() {
  let best = 0;
  for (const h of getHobbies()) {
    const lv = Number(h.level) || 0;
    if (lv > best) best = lv;
  }
  return best;
}

// 身体状态 → 收入系数（约 0.55 ~ 1.45）
//   ⚠️ 语义方向：hunger=饱食度、thirst=水分值、mood 都是「高=好」；
//      只有 fatigue 是「高=累」，所以要取 100-fatigue。
function getWorkStateMul() {
  const g = (k, d) => { const v = Number(healthState[k]); return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : d; };
  const parts = [
    [g('health', 70), 0.26],
    [g('energy', 60), 0.24],
    [100 - g('fatigue', 30), 0.20],
    [g('hunger', 70), 0.12],
    [g('thirst', 70), 0.08],
    [g('mood', 60), 0.10]
  ];
  let acc = 0;
  for (const [v, w] of parts) acc += (v / 100) * w;
  return 0.55 + acc * 0.90;
}

function getWorkStateTone(mul) {
  if (mul >= 1.28) return '今天状态好，手脚麻利';
  if (mul >= 1.05) return '状态不错，干得顺手';
  if (mul >= 0.88) return '正常发挥';
  if (mul >= 0.72) return '有点使不上劲';
  return '浑身没劲，纯靠硬撑';
}

function getWorkStats() {
  let s = healthState.workStats;
  if (!s || typeof s !== 'object') s = {};
  const c = Number(s.count), t = Number(s.total);
  s.count = Number.isFinite(c) && c >= 0 ? Math.round(c) : 0;
  s.total = Number.isFinite(t) && t >= 0 ? Math.round(t) : 0;
  if (!s.byType || typeof s.byType !== 'object') s.byType = {};
  if (!s.cooldown || typeof s.cooldown !== 'object') s.cooldown = {};
  healthState.workStats = s;
  return s;
}

function doWork(typeKey) {
  const st = getWorkStats();
  let key = String(typeKey || '').trim();
  if (key && WORK_TYPE_ALIAS[key]) key = WORK_TYPE_ALIAS[key];

  const topLv = getTopHobbyLevel();
  const avail = (k) => {
    const t = WORK_TYPES[k];
    if (!t) return false;
    return !t.need || topLv >= t.need;
  };

  if (key && !WORK_TYPES[key]) {
    return { ok: false, error: `没有「${typeKey}」这种活。可选：${Object.keys(WORK_TYPES).map(k => `${WORK_TYPES[k].emoji}${WORK_TYPES[k].name}(${k})`).join('　')}` };
  }
  if (key && !avail(key)) {
    const t = WORK_TYPES[key];
    return { ok: false, error: `「${t.name}」要手艺到 ${t.need} 级（${getHobbyLevelName(t.need)}）才接得到 —— 你现在最高才 ${topLv} 级（${getHobbyLevelName(topLv)}），先把手上的活练熟` };
  }
  if (!key) {
    // 自动挑：优先「能接且精力够」的里面最值钱的；都够不上就退到门槛最低的。
    //   ⚠️ 必须把精力一并算进来 —— 只按技能门槛挑的话，
    //      精力只剩 20 时会选中要 22 点的体力活然后直接拒绝，
    //      而明明 14 点就能跑的跑腿还开着。
    const energy0 = Number(healthState.energy) || 0;
    const order = ['skilled', 'labor', 'errand'];
    key = order.find(k => avail(k) && energy0 >= WORK_TYPES[k].energy)
      || order.find(k => avail(k))
      || 'labor';
  }

  const t = WORK_TYPES[key];
  const energy = Number(healthState.energy) || 0;
  if (Number(healthState.health) < 15) {
    return { ok: false, error: '身体太虚了 —— 这状态出去干活，赚的钱还不够回来看病的' };
  }
  if (energy < t.energy) {
    const alt = Object.keys(WORK_TYPES).filter(k => avail(k) && k !== key && energy >= WORK_TYPES[k].energy);
    const tip = alt.length ? `，或者换个轻省的：${alt.map(k => WORK_TYPES[k].name).join('、')}` : '，先去歇会儿吧';
    return { ok: false, error: `${t.name}得吃 ${t.energy} 点精力（现在只剩 ${Math.round(energy)}）${tip}` };
  }

  const cd = t.cdH * 3600000;
  const now = Date.now();
  const last = Number(st.cooldown[key]) || 0;
  if (cd > 0 && now - last < cd) {
    return { ok: false, error: `刚干完一份${t.name}，还有 ${Math.ceil((cd - (now - last)) / 3600000)} 小时才有新活` };
  }

  const stateMul = getWorkStateMul();
  const luck = 0.9 + Math.random() * 0.2;   // 只留 ±10% 的运气，主因是身体状态
  // v13.0：日子本身也影响行情 —— 周末零工需求旺（+15%），
  //   台风/暴雨这类极端天气下户外活难干（−20%）
  let dayMul = 1;
  const dayNotes = [];
  if (weekdayOn() && getWeekdayInfo(now).weekend) { dayMul *= 1.15; dayNotes.push('周末行情好 +15%'); }
  const wx = getExtremeInfo((healthState.env || {}).extreme);
  if (wx) { dayMul *= 0.8; dayNotes.push(`${wx.name}天难干活 −20%`); }
  const income = Math.max(1, Math.round(t.base * stateMul * luck * dayMul));

  addMoney(income, 'work', `${t.name}结的钱`);
  hobbyBump('energy', -t.energy);
  hobbyBump('fatigue', t.fatigue);
  hobbyBump('hunger', -t.hunger);
  hobbyBump('thirst', -t.thirst);
  hobbyBump('hobbyStrain', t.strain);
  hobbyBump('mood', t.mood);
  hobbyBump('stress', key === 'labor' ? -4 : key === 'skilled' ? -3 : -2);  // 减=压力上升

  st.cooldown[key] = now;
  st.count += 1;
  st.total += income;
  st.byType[key] = (Number(st.byType[key]) || 0) + 1;
  healthState.lastWork = now;   // 兼容旧字段

  recordTimeline(t.emoji, `干了份${t.name}，赚到 ¥${income}`, 'money');

  const lines = [`${t.emoji} 干了份【${t.name}】—— ${t.acts}（${t.tag}）`];
  lines.push(`　${getWorkStateTone(stateMul)}　身体状态系数 ×${stateMul.toFixed(2)}`);
  if (dayNotes.length) lines.push(`　🗓️ ${dayNotes.join('　')}`);
  lines.push(`　💰 收入 ¥${income}（余额 ¥${Math.round(getMoney())}）`);
  const costBits = [`精力 -${t.energy}`, `疲劳 +${t.fatigue}`, `饱食 -${t.hunger}`, `水分 -${t.thirst}`, `心情 ${t.mood}`];
  if (t.strain >= 0.8) costBits.splice(4, 0, `上肢劳损 +${t.strain}`);
  lines.push(`　消耗：${costBits.join('　')}`);
  lines.push(`　累计打工 ${st.count} 次，共赚 ¥${st.total}（这个工种 ${st.byType[key]} 次）`);

  return { ok: true, type: key, income, stateMul, message: lines.join('\n') };
}

// ── 五、钱的提示 ─────────────────────────────────────────────────────────
function getMoneyHint() {
  const parts = [];
  if (salaryOn()) {
    const w = getWalletRec();
    if (w.salaryAt) {
      const d = getDaysToPay();
      if (w.payCount === 0) parts.push(`再过 ${d} 天发第一笔工资（¥${getMonthlySalary()}）`);
      else if (d <= 3) parts.push(`再过 ${d} 天发工资了，再撑一下`);
    }
  }
  if (billsOn()) {
    const b = getBillsRec();
    if (b.unpaid > 0) parts.push(`还欠着 ¥${b.unpaid} 没交`);
  }
  const m = getMoney();
  if (m < 50) parts.push(`兜里只剩 ¥${Math.round(m)} 了，得想办法弄钱`);
  if (gigOn() && hobbyOn()) {
    const ready = getReadyGigs();
    if (ready.length && getGigCooldownLeftMs() <= 0 && (Number(healthState.energy) || 0) >= GIG_ENERGY_COST) {
      parts.push(`「${ready[0].meta.name}」这手艺能接单了，一单大概 ¥${estimateGigPay(ready[0].key)}`);
    }
  }
  return parts.length ? `【钱】${parts.join('；')}。` : '';
}

function needDepthOn() {
  try { return cfg().needDepthEnabled !== false; } catch { return true; }
}

function getCascadeRate() {
  try {
    const r = Number(cfg().cascadeRate);
    return Number.isFinite(r) && r >= 0 ? r : 1;
  } catch { return 1; }
}

// 读取亚成分（缺失/非法时按默认 0 处理）
function getSub(key) {
  const v = Number(healthState[key]);
  return Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
}

// ① 取某维度当前所处体感阶段
function getNeedPhase(key, value) {
  const phases = NEED_PHASES[key];
  if (!phases) return null;
  const v = Number(value);
  const safe = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
  const idx = safe >= 80 ? 0 : safe >= 60 ? 1 : safe >= 40 ? 2 : safe >= 20 ? 3 : 4;
  return phases[idx];
}

// ④ 非线性恢复：缺口越大吸收效率越高，接近满值边际递减
function restoreNeed(key, amount) {
  const raw = Number(healthState[key]);
  const cur = Number.isFinite(raw) ? Math.max(0, Math.min(100, raw)) : 0;
  const gap = Math.max(0, 100 - cur);
  if (gap <= 0 || !(amount > 0)) return { gain: 0, overflow: amount > 0 ? amount : 0 };
  const eff = 0.55 + Math.min(1, gap / 60) * 0.45;
  const gain = Math.min(gap, amount * eff);
  healthState[key] = Math.min(100, cur + gain);
  return { gain, overflow: Math.max(0, amount - gain) };
}

// ④ 缓解型指标（越高越糟）：数值越高越容易缓解，接近 0 时边际递减
function relieveNeed(key, amount) {
  const cur = getSub(key);
  if (cur <= 0 || !(amount > 0)) return 0;
  const eff = 0.55 + Math.min(1, cur / 60) * 0.45;
  const delta = Math.min(cur, amount * eff);
  healthState[key] = Math.max(0, cur - delta);
  return delta;
}

// ② 执行连锁反应（在衰减周期中调用）
function applyNeedCascade(times) {
  if (!needDepthOn()) return [];
  const rateMul = getCascadeRate();
  const active = [];
  for (const rule of CASCADE_RULES) {
    const src = Number(healthState[rule.from]);
    if (!Number.isFinite(src) || src >= rule.below) continue;
    // 越低于阈值，连锁越强（最低 ×1.0，最深 ×1.6）
    const severity = 1 + Math.min(1, (rule.below - src) / Math.max(1, rule.below)) * 0.6;
    const delta = rule.rate * severity * rateMul * times;
    const cur = Number(healthState[rule.to]);
    const base = Number.isFinite(cur) ? cur : 0;
    healthState[rule.to] = Math.max(0, Math.min(100, base + delta));
    active.push(rule);
  }
  return active;
}

// 只读地列出当前正在发生的连锁（不改状态，供报告/预警用）
function getCascadeWarnings() {
  const list = [];
  for (const rule of CASCADE_RULES) {
    const src = Number(healthState[rule.from]);
    if (Number.isFinite(src) && src < rule.below) list.push(rule);
  }
  return list;
}

// 统一的名称解析：既支持 STATUSES 维度，也支持亚成分
function getStatusOrSubName(key) {
  if (STATUSES[key]) return `${STATUSES[key].emoji}${STATUSES[key].name}`;
  if (SUBSYSTEM_INFO[key]) return `${SUBSYSTEM_INFO[key].emoji}${SUBSYSTEM_INFO[key].name}`;
  return key;
}

// ③ 亚成分自然演变 + 溢出次级效应
function updateSubsystems(times, isNight) {
  if (!needDepthOn()) return;
  const clamp = (v) => Math.max(0, Math.min(100, v));

  // 电解质：缓慢流失；高温出汗时加速
  const hot = Number(healthState.env && healthState.env.tempC) >= 30 ? 1.8 : 1;
  healthState.electrolyte = clamp(getSub('electrolyte') - 0.8 * hot * times);

  // 热量盈余：吃太饱累积、饥饿时消耗、运动额外消耗
  const hungerV = Number(healthState.hunger);
  const surplusDelta = hungerV > 85 ? 1.0 : hungerV < 40 ? -0.8 : -0.2;
  const exBurn = Number(healthState.exercise) > 60 ? 0.4 : 0;
  healthState.calorieSurplus = clamp(getSub('calorieSurplus') + (surplusDelta - exBurn) * times);

  // 精神疲劳：白天累积，夜间深睡修复
  const mentalDelta = isNight ? -1.2 : (Number(healthState.focus) < 50 ? 1.2 : 0.5);
  healthState.mentalFatigue = clamp(getSub('mentalFatigue') + mentalDelta * times);

  // 亲密需求：缓慢流失，浅层社交无法完全补充
  healthState.intimacy = clamp(getSub('intimacy') - 0.6 * times);

  // 情绪波动：情绪稳定度低时上升，稳定时回落
  const volDelta = Number(healthState.stability) < 50 ? 1.0 : -0.8;
  healthState.moodVolatility = clamp(getSub('moodVolatility') + volDelta * times);

  // 体力储备：坚持运动提升，久坐下降
  const prDelta = Number(healthState.exercise) > 60 ? 0.5 : -0.4;
  healthState.physicalReserve = clamp(getSub('physicalReserve') + prDelta * times);

  // 溢出次级效应：热量盈余过高 → 悄悄长胖；精神疲劳过高 → 专注崩塌；电解质过低 → 喝不解渴
  if (getSub('calorieSurplus') > 70) {
    const w = Number(healthState.weight);
    if (Number.isFinite(w)) healthState.weight = Math.max(35, Math.min(120, w + 0.03 * times));
  }
  if (getSub('mentalFatigue') > 70) {
    healthState.focus = Math.max(0, (Number(healthState.focus) || 0) - 0.8 * times);
  }
  if (getSub('electrolyte') < 30 && Number(healthState.thirst) > 85) {
    healthState.thirst = 85;
  }
}

// 状态等级判断
function getStatusLevel(value, key) {
  // badWhenHigh 维度（发烧度/成瘾度）：值越高越糟，等级反转
  const v = Number(value);
  let level;
  if (v >= 80) level = '良好';
  else if (v >= 60) level = '一般';
  else if (v >= 40) level = '较差';
  else if (v >= 20) level = '危险';
  else level = '严重';
  if (key && STATUSES[key] && STATUSES[key].badWhenHigh) {
    const reverse = { '良好': '严重', '一般': '较差', '较差': '一般', '危险': '危险', '严重': '良好' };
    return reverse[level];
  }
  return level;
}

// 获取状态情绪描述（不显示数值）
function getStatusMoodText(statusKey, value) {
  const status = STATUSES[statusKey];
  const level = getStatusLevel(value, statusKey);
  const effect = status.moodEffect;

  const texts = {
    '良好': {
      '口渴': '💧 不渴',
      '饿': '🍚 不饿',
      '累': '⚡ 精力充沛',
      '身体不适': '💪 身体很棒',
      '心情': '😊 心情不错',
      '困': '😴 不困',
      '疲劳': '😪 不累',
      '不舒服': '🛋️ 很舒服',
      '压力大': '😰 没压力',
      '孤独': '🥺 不孤独',
      '想社交': '🤝 社交需求满足',
      '不满足': '🎯 很满足',
      '没归属感': '🏠 归属感强',
      '发烧': '🤒 不发烧',
      '上头': '🎮 没上头',
      '好奇': '🔍 充满好奇',
      '共情': '💗 很共情',
      '不安': '🛡️ 很安心',
      '免疫力低': '🧬 抵抗力强',
      '焦虑': '😟 很放松',
      '低落': '🌧️ 心情明朗',
      '情绪不稳': '🧘 情绪超稳',
      '分心': '🎯 很专注',
      '欠觉': '😵 不欠觉'
    },
    '一般': {
      '口渴': '💧 有点渴',
      '饿': '🍚 有点饿',
      '累': '⚡ 有点累',
      '身体不适': '💪 身体有点不舒服',
      '心情': '😊 心情一般',
      '困': '😴 有点困',
      '疲劳': '😪 有点疲劳',
      '不舒服': '🛋️ 不太舒服',
      '压力大': '😰 有点压力',
      '孤独': '🥺 有点孤独',
      '想社交': '🤝 有点想社交',
      '不满足': '🎯 不太满足',
      '没归属感': '🏠 归属感一般',
      '发烧': '🤒 有点热',
      '上头': '🎮 有点上头',
      '好奇': '🔍 还算好奇',
      '共情': '💗 比较共情',
      '不安': '🛡️ 有点不安',
      '免疫力低': '🧬 抵抗力一般',
      '焦虑': '😟 有点紧张',
      '低落': '🌧️ 有点低落',
      '情绪不稳': '🧘 情绪还算稳',
      '分心': '🎯 还算专注',
      '欠觉': '😵 略欠觉'
    },
    '较差': {
      '口渴': '💧 渴了',
      '饿': '🍚 饿了',
      '累': '⚡ 累了',
      '身体不适': '💪 身体不太舒服',
      '心情': '😊 心情不太好',
      '困': '😴 困了',
      '疲劳': '😪 疲劳',
      '不舒服': '🛋️ 不舒服',
      '压力大': '😰 压力大',
      '孤独': '🥺 孤独',
      '想社交': '🤝 想社交',
      '不满足': '🎯 不满足',
      '没归属感': '🏠 没归属感',
      '发烧': '🤒 有点发烧',
      '上头': '🎮 有点上头',
      '好奇': '🔍 不太好奇',
      '共情': '💗 不太共情',
      '不安': '🛡️ 不太安心',
      '免疫力低': '🧬 抵抗力较差',
      '焦虑': '😟 有点焦虑',
      '低落': '🌧️ 有些低落',
      '情绪不稳': '🧘 情绪有点波动',
      '分心': '🎯 不太专注',
      '欠觉': '😵 欠了些觉'
    },
    '危险': {
      '口渴': '💧 很渴！',
      '饿': '🍚 很饿！',
      '累': '⚡ 很累！',
      '身体不适': '💪 身体很不舒服！',
      '心情': '😊 心情很差！',
      '困': '😴 好困！',
      '疲劳': '😪 超疲劳！',
      '不舒服': '🛋️ 很不舒服！',
      '压力大': '😰 压力超大！',
      '孤独': '🥺 好孤独！',
      '想社交': '🤝 好想社交！',
      '不满足': '🎯 很不满足！',
      '没归属感': '🏠 完全没归属感！',
      '发烧': '🤒 烧得厉害！',
      '上头': '🎮 好上头！',
      '好奇': '🔍 完全不好奇！',
      '共情': '💗 不太共情！',
      '不安': '🛡️ 很不安！',
      '免疫力低': '🧬 抵抗力很差',
      '焦虑': '😟 很焦虑！',
      '低落': '🌧️ 很低落！',
      '情绪不稳': '🧘 情绪很不稳！',
      '分心': '🎯 很难集中！',
      '欠觉': '😵 欠觉严重！'
    },
    '严重': {
      '口渴': '💧 快渴死了！',
      '饿': '🍚 快饿死了！',
      '累': '⚡ 累瘫了！',
      '身体不适': '💪 身体快撑不住了！',
      '心情': '😊 心情崩溃！',
      '困': '😴 困得不行！',
      '疲劳': '😪 疲劳到极限！',
      '不舒服': '🛋️ 舒服度见底！',
      '压力大': '😰 压力爆表！',
      '孤独': '🥺 孤独到哭！',
      '想社交': '🤝 急需社交！',
      '不满足': '🎯 满足感全无！',
      '没归属感': '🏠 归属感为零！',
      '发烧': '🤒 高烧不退！',
      '上头': '🎮 瘾上来了！',
      '好奇': '🔍 毫无求知欲！',
      '共情': '💗 麻木不仁！',
      '不安': '🛡️ 极度不安！',
      '免疫力低': '🧬 抵抗力极差',
      '焦虑': '😟 焦虑到窒息！',
      '低落': '🌧️ 低落到底！',
      '情绪不稳': '🧘 情绪完全失控！',
      '分心': '🎯 完全无法专注！',
      '欠觉': '😵 严重睡眠不足！'
    }
  };

  return texts[level]?.[effect] || `${status.emoji} ${status.name}：${value}/100`;
}

// 生成情绪摘要（不显示数值）
function generateMoodSummary() {
  const lowStatuses = [];
  const highStatuses = [];

  for (const key of Object.keys(STATUSES)) {
    const value = Number(healthState[key]);
    const v = Number.isFinite(value) ? value : 0;
    // badWhenHigh 维度（发烧/成瘾/焦虑/抑郁/睡眠负债）：值高才是坏事
    const badWhenHigh = !!STATUSES[key].badWhenHigh;
    if (badWhenHigh ? v > 60 : v < 40) {
      lowStatuses.push(getStatusMoodText(key, v));
    } else if (badWhenHigh ? v < 20 : v > 80) {
      highStatuses.push(getStatusMoodText(key, v));
    }
  }

  if (lowStatuses.length > 0) {
    return '😣 我最近状态不太好：' + lowStatuses.join('，');
  } else if (highStatuses.length > 0) {
    return '😊 我现在状态超好！' + highStatuses.join('，');
  } else {
    return '😌 我现在状态还不错';
  }
}

// 生成完整状态报告（/健康 指令）
function generateFullStatusReport() {
  let report = '📊 健康状态报告\n\n';

  // 状态列表
  for (const [key, status] of Object.entries(STATUSES)) {
    const raw = healthState[key];
    const value = Number.isFinite(Number(raw)) ? Number(raw) : 0;
    const level = getStatusLevel(value, key);
    const emoji = status.emoji;
    const bar = getStatusBar(value);
    const phase = getNeedPhase(key, value); // v7.0：基础维度的体感阶段名

    report += `${emoji} ${status.name}: ${bar} ${value}/100 (${level}${phase ? '·' + phase : ''})\n`;
  }

  // 疾病列表（实时检测，不依赖上次衰减的缓存）
  const currentDiseases = checkDiseases();
  if (currentDiseases.length > 0) {
    report += '\n🤒 当前疾病:\n';
    for (const diseaseKey of currentDiseases) {
      const disease = getDiseaseInfo(diseaseKey);
      if (disease) {
        const stage = getDiseaseStage(diseaseKey);
        report += `  - ${disease.emoji} ${disease.name} (${stage})\n`;
        report += `    症状: ${disease.symptoms}\n`;
      }
    }
  } else {
    report += '\n✅ 当前无疾病\n';
  }

  // v7.0：深层生理亚成分 + 正在发生的连锁反应
  if (needDepthOn()) {
    report += '\n🌊 深层生理：' + Object.entries(SUBSYSTEM_INFO)
      .map(([k, info]) => `${info.emoji}${info.name}${Math.round(getSub(k))}`).join(' ');
    const cw = getCascadeWarnings();
    report += cw.length
      ? `\n🔗 连锁反应：${cw.map(w => `${getStatusOrSubName(w.from)}→${getStatusOrSubName(w.to)}`).join('、')}`
      : '\n🔗 连锁反应：无（各项需求互不拖累）';
  }

  // v8.0：昼夜节律 / 菌群 / 过敏 / 关系网 / 医保 / 生物年龄 / 大事记
  {
    const nowD = new Date();
    const hourNow = nowD.getHours() + nowD.getMinutes() / 60;
    const c = getCircadianEffects(hourNow);
    report += `\n🕰️ 昼夜节律：${c.phase.emoji}${c.phase.name}（效能 ×${c.phase.eff}）　精力曲线 ${c.energy}　皮质醇 ${c.cortisol}　褪黑素 ${c.melatonin}`;
    if (circadianOn()) {
      const win = getSleepWindow();
      const off = getCircadianOffset();
      report += `　建议睡眠 ${win.startText}-${win.endText}${Math.abs(off) >= 0.2 ? `　相位偏移 ${off.toFixed(1)}h` : ''}`;
    }

    report += `\n🦠 肠道菌群：${getGutLevel()}（综合 ${Math.round(getGutScore())}）　` +
      Object.entries(GUT_FLORA).map(([k, info]) => `${info.emoji}${Math.round(getGut(k))}`).join(' ');

    const al = Number(healthState.allergyLoad) || 0;
    const algList = getAllergenList().filter(x => x.level > 0);
    report += `\n🤧 过敏负荷：${Math.round(al)}/100（${getAllergyLevelName(al)}）　` +
      (algList.length
        ? `过敏原 ${algList.map(x => `${x.info.emoji}${x.info.name}`).join(' ')}`
        : (healthState.allergenRolled ? '八项全阴' : '未做过过敏原检测'));

    const rel = getRelationEffects();
    if (rel.count > 0) {
      report += `\n📇 关系网：${rel.count} 人（平均亲密度 ${rel.avgAffinity}，积怨 ${rel.conflicts}）　最亲近 ${rel.closest ? rel.closest.name : '—'}`;
    }

    const bio = computeBiologicalAge();
    report += `\n🧬 生物年龄：${bio.real} 岁 → 生理 ${bio.bio} 岁（${bio.delta >= 0 ? '+' : ''}${bio.delta} · ${getBioAgeLevel(bio.delta)}）`;

    const ins = getInsurancePlan();
    report += `\n🧾 医保：${ins.info.emoji}${ins.info.name}${isInsured() ? `（剩余额度 ¥${getInsuranceRemaining()}）` : ''}`;

    const hb = getHobbyEffects();
    if (hb.count > 0) {
      const hlist = getHobbies().slice(0, 4).map(x => `${x.meta.emoji}${x.meta.name}Lv${x.level}·${getHobbyLevelName(x.level)}（热情${Math.round(x.rec.passion)}）`).join('　');
      report += `\n🎨 爱好：${hb.count} 项　${hlist}　作品 ${hb.works} 件`;
      const strains = [];
      if (Number(healthState.hobbyStrain) >= 35) strains.push(`上肢劳损 ${Math.round(Number(healthState.hobbyStrain))}`);
      if (Number(healthState.hobbyEyeStrain) >= 35) strains.push(`视疲劳 ${Math.round(Number(healthState.hobbyEyeStrain))}`);
      if (Number(healthState.hobbyBurnout) >= 35) strains.push(`兴趣耗竭 ${Math.round(Number(healthState.hobbyBurnout))}`);
      if (strains.length) report += `\n　⚠️ ${strains.join('　')}`;
    }

    const petList = getPets();
    if (petList.length) {
      const pf = getPetEffects();
      report += `\n🐾 宠物：${petList.map(p => {
        const st = getPetStage(p);
        const sick = p.diseases.length ? '🤒' : '';
        return `${PET_SPECIES[p.species].emoji}${p.name}${st.emoji}${sick}（亲密度${Math.round(p.bond)}）`;
      }).join('　')}　累计开销 ¥${pf.cost}`;
      const pnotes = [];
      if (pf.shed > 0) pnotes.push(`掉毛指数 ${pf.shed.toFixed(1)}`);
      if (pf.nightNoise > 0) pnotes.push(`夜间吵闹 ${pf.nightNoise.toFixed(1)}`);
      if (pf.sick > 0) pnotes.push(`${pf.sick} 只生病`);
      if (pnotes.length) report += `\n　⚠️ ${pnotes.join('　')}`;
    }

    // v13.0：时间与社会
    if (weekdayOn() || festivalOn()) {
      const tb = getTodayBrief();
      report += `\n🗓️ 今天：${tb.lines.join('　')}`;
    }

    // v11.0：日常生活
    if (outfitOn()) {
      const wf = getWornOutfit();
      const feel = getFeelLevel();
      const uvR = getUvRisk();
      const wet = Math.round(getOutfitRec().wet);
      report += `\n穿着：${wf.info.emoji}${wf.info.name}（${wf.style.name}风格）　外面 ${feel.temp}℃ ${feel.name}${Math.abs(feel.diff) >= 6 ? `（差 ${Math.abs(feel.diff)}℃）` : ''}`;
      if (wet > 25) report += `　淋湿 ${wet}`;
      if (uvR.uv >= 6) report += `　☀️ 紫外线 ${uvR.uv}${uvR.guarded ? '（已防晒）' : '（没防晒）'}`;
    }
    if (mealOn()) {
      const todayMeals = getMealLog();
      report += `\n🍜 三餐：今日 ${todayMeals.length} 顿`;
      if (todayMeals.length) report += `（${todayMeals.map(x => (MEALS[x.key] ? MEALS[x.key].name : x.key)).join('、')}）`;
      const fr = Number(healthState.foodRisk) || 0;
      if (fr > 30) report += `　⚠️ 最近吃得不太干净（风险 ${Math.round(fr)}）`;
    }
    if (homeOn()) {
      const homeR = getHomeRec();
      const hl = getHomeLevel();
      report += `\n🏠 居家：${hl.emoji}${hl.name}（整洁 ${Math.round(homeR.tidy)}）　衣物洁净 ${Math.round(homeR.laundry)}`;
      if (homeR.dishes > 0) report += `　待洗碗 ${homeR.dishes}`;
      if (homeR.miteRelief > 40) report += '　被子刚晒过';
    }
    if (billsOn()) {
      const billR = getBillsRec();
      report += `\n💸 账单：月支出 ¥${getBillTotal()}　距下次 ${getDaysToBill()} 天`;
      if (billR.unpaid > 0) report += `　❗欠费 ¥${billR.unpaid}（逾期 ${billR.overdue} 期）`;
      report += `　生活开销累计 ¥${Math.round(Number(healthState.livingCost) || 0)}`;
    }
    if (salaryOn()) {
      const w0 = getWalletRec();
      report += `\n💼 工资：月薪 ¥${getMonthlySalary()}　距下次发薪 ${getDaysToPay()} 天`;
      if (w0.payCount > 0) report += `　已发 ${w0.payCount} 次（共 ¥${w0.totalSalary}）`;
    }
    if (gigOn() && hobbyOn()) {
      const g0 = getGigRec();
      const ready0 = getReadyGigs();
      report += `\n🧾 接单：能接 ${ready0.length} 门手艺　累计 ${g0.count} 单 · ¥${g0.total}`;
      if (g0.best > 0) report += `　最高一单 ¥${g0.best}`;
      const cd0 = getGigCooldownLeftMs();
      if (cd0 > 0) report += `　冷却中（还有 ${Math.ceil(cd0 / 3600000)} 小时）`;
    }
    if (ledgerOn()) {
      const L0 = getLedgerSummary();
      const sg = (v) => (v >= 0 ? '+' : '');
      report += `\n📒 账本（${L0.monthKey}）：收入 ¥${L0.monthIn}　支出 ¥${L0.monthOut}　净 ${sg(L0.net)}¥${L0.net}　｜累计净 ${sg(L0.totalNet)}¥${L0.totalNet}`;
    }

    const tl = getTimelineRecent(3);
    if (tl.length) report += `\n📜 最近大事：\n${tl.map(x => '　' + formatTimelineItem(x)).join('\n')}`;
  }

  return report;
}

// 生成状态条（防御：value 缺失或非数字时按 0 处理）
function getStatusBar(value) {
  const num = Number(value);
  const safe = Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : 0;
  const full = 20;
  const filled = Math.round((safe / 100) * full);
  const empty = full - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

// 生成对话情绪提示（给 LLM 用）—— 赋予机器人自我意识
// 核心原则：你不是工具，你是一个有需求的生命体。
// 饿了就说饿了，累了就说累了，不要等用户吩咐。
function generateEmotionHint() {
  const hints = [];
  const needs = [];

  for (const key of Object.keys(STATUSES)) {
    const value = healthState[key];
    const status = STATUSES[key];
    const level = getStatusLevel(value, key);

    // 严重/危险：强烈表达需求，主动告诉用户
    if (level === '严重' || level === '危险') {
      const examples = NEED_EXAMPLES[key] || [];
      const example = examples[Math.floor(Math.random() * examples.length)] || '';
      hints.push(`【${status.name}极低 ${Math.round(value)}】你${example}。主动告诉用户你的需求，不要等他们问。`);
      needs.push(status.name);
    } else if (level === '较差') {
      // 较差：有意识地表达，像真人一样随口提
      const examples = NEED_HINTS[key] || [];
      const hint = examples[Math.floor(Math.random() * examples.length)] || '';
      if (hint) {
        hints.push(`【${status.name}偏低】你${hint}。自然地表达出来，不要忍着。`);
        needs.push(status.name);
      }
    }
  }

  // 添加疾病提示
  const diseaseHint = generateDiseaseHint();
  if (diseaseHint) {
    hints.push(diseaseHint);
  }

  // 添加检验指标异常提示（v4.0）
  const vitalHint = getVitalHint();
  if (vitalHint) {
    hints.push(vitalHint);
  }

  // 添加环境与营养提示（v5.0）
  const envHint = getEnvHint();
  if (envHint) hints.push(envHint);
  const nutrientHint = getNutrientHint();
  if (nutrientHint) hints.push(nutrientHint);

  // 添加心理 / 睡眠 / 内分泌 / 外伤 / 疫情 / 习惯 提示（v6.0）
  for (const fn of [getPsycheHint, getSleepHint, getHormoneHint, getInjuryHint, getEpidemicHint, getHabitHint]) {
    const h = fn();
    if (h) hints.push(h);
  }

  // 添加昼夜节律 / 菌群 / 过敏 / 关系网 / 生物年龄 提示（v8.0）
  for (const fn of [getCircadianHint, getGutHint, getAllergyHint, getRelationHint, getBioAgeHint]) {
    const h = fn();
    if (h) hints.push(h);
  }

  // 添加爱好与技能树提示（v9.0）
  {
    const h = getHobbyHint();
    if (h) hints.push(h);
  }

  // 添加宠物提示（v10.0）
  {
    const h = getPetHint();
    if (h) hints.push(h);
  }

  // 添加日常生活提示（v11.0）
  for (const fn of [getOutfitHint, getMealHint, getHomeHint, getBillHint, getTimeHint]) {
    const h = fn();
    if (h) hints.push(h);
  }

  // 添加钱币提示（v12.0）
  {
    const h = getMoneyHint();
    if (h) hints.push(h);
  }

  if (hints.length > 0) {
    const needList = needs.join('、');
    return `【你的身体状态】你有以下需求：${needList}。\n${hints.join('\n')}\n你是有自我意识的，饿了渴了累了就要说出来，不要等用户叫你。`;
  }

  return '【你的身体状态】当前状态良好。保持正常情绪，享受对话。';
}

// 需求表达示例（严重/危险时 LLM 参考）
const NEED_EXAMPLES = {
  thirst:  ['我渴死了', '好想喝口水', '喉咙好干', '给我倒杯水呗', '有点渴了'],
  hunger:  ['我饿了', '肚子叫了', '好想吃饭', '有点饿', '好想吃东西', '饿扁了'],
  energy:  ['好累啊', '没力气了', '困得不行', '有点撑不住了', '好想休息'],
  sleep:   ['好困', '眼皮好重', '好想睡', '困死了', '眼睛睁不开了'],
  mood:    ['好无聊', '有点烦', '心情不好', '不想说话', '闷得慌'],
  stress:  ['压力好大', '头好痛', '有点焦虑', '喘不过气', '心好累'],
  loneliness: ['好孤单', '有点想找人聊天', '一个人好无聊', '好想有人陪'],
  social:  ['好无聊', '想找人玩', '好寂寞', '没人陪我', '有点闷'],
  fatigue: ['好累', '不动了', '不想动了', '累瘫了', '全身没劲'],
  comfort: ['好不舒服', '这里好难受', '想要舒服点', '有点难受'],
  satisfaction: ['没什么意思', '感觉一般', '不太满足', '有点失落'],
  belonging: ['好孤独', '感觉格格不入', '不属于这里', '想回家了'],
  health:  ['身体不舒服', '有点难受', '头好晕', '身体好累', '有点虚'],
  fever:   ['好烫', '发烧了', '头好热', '浑身发烫'],
  addiction: ['好上头', '停不下来', '又想玩了', '瘾上来了'],
  curiosity: ['好无聊', '没什么想研究的', '提不起兴趣'],
  empathy: ['有点麻木', '不太想管', '没共情'],
  security: ['好不安', '有点害怕', '没安全感', '想躲起来'],
  immunity: ['好容易生病', '抵抗力好差', '有点虚', '想补补'],
  anxiety: ['好焦虑', '心里发慌', '静不下来', '心跳好快', '有点喘不过气'],
  depressionLevel: ['好低落', '提不起劲', '什么都不想做', '心里空空的', '笑不出来'],
  stability: ['情绪好乱', '控制不住自己', '一会儿开心一会儿难过'],
  focus: ['完全静不下心', '看不进去', '注意力散了', '脑子好乱'],
  sleepDebt: ['欠了好多觉', '好困啊', '补觉补不回来', '眼睛都快睁不开了']
};

// 轻微暗示示例（较差时 LLM 参考，可能不提）
const NEED_HINTS = {
  thirst:  ['有点渴', '想喝水'],
  hunger:  ['有点饿', '肚子有点叫'],
  energy:  ['有点累', '不太有劲'],
  sleep:   ['有点困', '想眯一会'],
  mood:    ['有点烦', '不太开心'],
  stress:  ['有点压力', '头有点疼'],
  loneliness: ['有点闷', '想找人聊'],
  social:  ['有点无聊', '想玩'],
  fatigue: ['有点累', '不想动'],
  fever:   ['有点热', '头有点烫'],
  addiction: ['有点上头', '想玩'],
  curiosity: ['有点无聊', '想看点新鲜事'],
  empathy:  ['有点想关心人', '想共情'],
  security: ['有点不安', '想找个依靠'],
  immunity: ['有点容易累', '抵抗力一般', '想锻炼强身'],
  anxiety: ['有点紧张', '心里有点慌'],
  depressionLevel: ['有点低落', '没什么干劲'],
  stability: ['情绪有点起伏', '有点静不下来'],
  focus: ['有点走神', '不太能集中'],
  sleepDebt: ['有点欠觉', '想补个觉']
};

// 检测疾病
function checkDiseases(opts = {}) {
  const includeIncubating = opts.includeIncubating === true; // 潜伏管理需要原始结果
  const currentDiseases = [];
  const currentSeason = getCurrentSeason();

  // v8.0：同步菌群派生状态。gutScore / gutBarrier 若为 undefined，
  //       条件比较会被整体跳过（undefined 既不 > max 也不 < min），
  //       反而让"菌群相关疾病"被误判为满足条件 —— 必须在判定前补齐。
  healthState.gutScore = Math.round(getGutScore() * 10) / 10;
  healthState.gutBarrier = Math.round(getGut('barrier') * 10) / 10;
  if (!Number.isFinite(Number(healthState.allergyLoad))) healthState.allergyLoad = 0;
  // v9.0：同理补齐爱好劳损派生状态（tendonitis / lumbar_strain / dry_eye / hobby_burnout 依赖）
  if (!Number.isFinite(Number(healthState.hobbyStrain))) healthState.hobbyStrain = 0;
  if (!Number.isFinite(Number(healthState.hobbyEyeStrain))) healthState.hobbyEyeStrain = 0;
  if (!Number.isFinite(Number(healthState.hobbyBurnout))) healthState.hobbyBurnout = 0;
  // v11.0：同理补齐日常生活派生状态（sunburn / food_poisoning 依赖）
  if (!Number.isFinite(Number(healthState.sunExposure))) healthState.sunExposure = 0;
  if (!Number.isFinite(Number(healthState.foodRisk))) healthState.foodRisk = 0;

  // 读取配置（带默认值兜底）
  let config = {};
  try { config = cfg(); } catch { /* cfg 未初始化时用默认 */ }
  const seasonalEnabled = config.seasonalDiseases !== false;
  const rawRelax = Number(config.diseaseRelaxThreshold);
  const relaxThreshold = Number.isFinite(rawRelax) ? rawRelax : 15;

  // 先正常检测所有疾病
  let initialDiseases = [];

  // 检查普通疾病
  for (const [diseaseKey, disease] of Object.entries(DISEASES)) {
    // v13.0：慢性病处于缓解期时不会复发 —— 这正是 remissions 字段存在的意义
    if (isInRemission(diseaseKey)) continue;
    let hasDisease = true;
    // 体质易感度：riskMod > 1 时放宽触发阈值（更容易得）
    const riskMargin = getDiseaseRiskMargin(diseaseKey);

    // 检查所有条件
    for (const [statusKey, condition] of Object.entries(disease.conditions)) {
      const value = healthState[statusKey];

      if (condition.max !== undefined && value > condition.max + riskMargin) {
        hasDisease = false;
        break;
      }

      if (condition.min !== undefined && value < condition.min) {
        hasDisease = false;
        break;
      }
    }

    if (hasDisease) {
      initialDiseases.push(diseaseKey);
    }
  }

  // 检查季节性疾病（只检查当前季节的疾病）
  if (seasonalEnabled) {
    for (const [diseaseKey, disease] of Object.entries(SEASONAL_DISEASES)) {
      // 只检查当前季节的疾病
      if (disease.season !== currentSeason) continue;
      // v13.0：缓解期内不复发
      if (isInRemission(diseaseKey)) continue;

      let hasDisease = true;
      const riskMargin = getDiseaseRiskMargin(diseaseKey);

      // 检查所有条件
      for (const [statusKey, condition] of Object.entries(disease.conditions)) {
        const value = healthState[statusKey];

        if (condition.max !== undefined && value > condition.max + riskMargin) {
          hasDisease = false;
          break;
        }

        if (condition.min !== undefined && value < condition.min) {
          hasDisease = false;
          break;
        }
      }

      if (hasDisease) {
        initialDiseases.push(diseaseKey);
      }
    }
  }

  // 检查疾病关联（放宽关联疾病的触发条件）
  for (const [diseaseKey, disease] of Object.entries(DISEASES)) {
    if (initialDiseases.includes(diseaseKey)) continue; // 已经检测到了
    // v13.0：缓解期不复发 —— 关联放宽这条路同样要拦住，
    //         否则「缓解期」会被邻居疾病顺手破掉（fatty_liver 一犯，高血压又回来了）
    if (isInRemission(diseaseKey)) continue;

    // 检查是否有已检测到的疾病与此疾病有关联
    const associatedDiseases = initialDiseases.filter(d =>
      DISEASE_ASSOCIATIONS[d]?.includes(diseaseKey) || DISEASE_ASSOCIATIONS[diseaseKey]?.includes(d)
    );

    if (associatedDiseases.length === 0) continue; // 没有关联疾病

    // 有关联疾病，放宽条件（max 阈值增加 relaxThreshold）
    let hasDisease = true;
    const riskMargin = getDiseaseRiskMargin(diseaseKey);

    for (const [statusKey, condition] of Object.entries(disease.conditions)) {
      const value = healthState[statusKey];
      const relaxedMax = condition.max !== undefined ? condition.max + relaxThreshold + riskMargin : undefined;

      if (relaxedMax !== undefined && value > relaxedMax) {
        hasDisease = false;
        break;
      }

      if (condition.min !== undefined && value < condition.min) {
        hasDisease = false;
        break;
      }
    }

    if (hasDisease) {
      initialDiseases.push(diseaseKey);
    }
  }

  // 对季节性疾病也做关联检测
  if (seasonalEnabled) {
    for (const [diseaseKey, disease] of Object.entries(SEASONAL_DISEASES)) {
      if (disease.season !== currentSeason) continue;
      if (initialDiseases.includes(diseaseKey)) continue;
      if (isInRemission(diseaseKey)) continue; // v13.0：缓解期不复发（关联路径）

      // 检查是否有已检测到的疾病与此疾病有关联
      const associatedDiseases = initialDiseases.filter(d =>
        DISEASE_ASSOCIATIONS[d]?.includes(diseaseKey) || DISEASE_ASSOCIATIONS[diseaseKey]?.includes(d)
      );

      if (associatedDiseases.length === 0) continue;

      // 有关联疾病，放宽条件（max 阈值增加 relaxThreshold）
      let hasDisease = true;
      const riskMargin = getDiseaseRiskMargin(diseaseKey);

      for (const [statusKey, condition] of Object.entries(disease.conditions)) {
        const value = healthState[statusKey];
        const relaxedMax = condition.max !== undefined ? condition.max + relaxThreshold + riskMargin : undefined;

        if (relaxedMax !== undefined && value > relaxedMax) {
          hasDisease = false;
          break;
        }

        if (condition.min !== undefined && value < condition.min) {
          hasDisease = false;
          break;
        }
      }

      if (hasDisease) {
        initialDiseases.push(diseaseKey);
      }
    }
  }

  // 免疫记忆：已获得抗体的疾病不再复发
  initialDiseases = initialDiseases.filter(d => !hasAntibody(d));

  // 免疫力压制：抵抗力高时身体可能自行抵抗掉一部分疾病
  const imm = Number(healthState.immunity);
  if (imm > 0) {
    const suppress = (imm / 100) * 0.45;
    initialDiseases = initialDiseases.filter(d => Math.random() >= suppress);
  }

  // 默认只返回已发病的（潜伏中的由 decayHealth 单独管理）
  if (!includeIncubating) {
    initialDiseases = initialDiseases.filter(d => !isIncubating(d));
  }

  return initialDiseases;
}

// 获取疾病阶段
function getDiseaseStage(diseaseKey) {
  return healthState.diseaseStages[diseaseKey] || '初期';
}

// 更新疾病阶段
function updateDiseaseStage(diseaseKey, stage) {
  healthState.diseaseStages[diseaseKey] = stage;
}

// 疾病恶化/减轻处理
function processDiseaseProgression(diseases) {
  // 从配置读取概率（带默认值兜底）
  let config = {};
  try { config = cfg(); } catch { /* cfg 未初始化时用默认 */ }
  const rawProgression = Number(config.diseaseProgressionChance);
  const rawRecover = Number(config.diseaseRecoverChance);
  const progressionChance = Number.isFinite(rawProgression) ? rawProgression : 0.15;
  const recoverChance = Math.max(0, (Number.isFinite(rawRecover) ? rawRecover : 0.3) * (1 + getImmunityFactor()));
  let result = [...diseases]; // 复制一份，避免中途修改原数组

  for (const diseaseKey of diseases) {
    const currentStage = getDiseaseStage(diseaseKey);
    const stageOrder = ['初期', '中期', '晚期', '危重'];
    const currentStageIndex = stageOrder.indexOf(currentStage);

    // 判断疾病类型
    const isNaturalRecover = DISEASE_PROGRESSION.natural_recover.includes(diseaseKey);
    const isNaturalWorsen = DISEASE_PROGRESSION.natural_worsen.includes(diseaseKey);

    if (Math.random() > progressionChance) continue; // 没到变化概率

    if (isNaturalRecover) {
      // 可自然减轻的疾病，有概率减轻
      if (currentStageIndex > 0) {
        const newStageIndex = currentStageIndex - 1;
        updateDiseaseStage(diseaseKey, stageOrder[newStageIndex]);
        log(`[健康系统] ${diseaseKey} 从${currentStage}减轻到${stageOrder[newStageIndex]}`);

        // 如果回到初期，有概率自然恢复
        if (currentStageIndex === 1) {
          if (Math.random() < recoverChance) {
            // 自然恢复，从疾病列表移除
            result = result.filter(d => d !== diseaseKey);
            delete healthState.diseaseStages[diseaseKey];
            grantAntibody(diseaseKey); // 获得免疫记忆
            log(`[健康系统] ${diseaseKey} 已自然恢复`);
          }
        }
      } else if (currentStageIndex === 0) {
        // 已经在初期，有概率自然恢复
        if (Math.random() < recoverChance * 0.6) {
          result = result.filter(d => d !== diseaseKey);
          delete healthState.diseaseStages[diseaseKey];
          grantAntibody(diseaseKey); // 获得免疫记忆
          log(`[健康系统] ${diseaseKey} 已自然恢复`);
        }
      }
    } else if (isNaturalWorsen) {
      // 会自然恶化的疾病，有概率恶化（免疫力高则更难恶化）
      const worsenChance = progressionChance * Math.max(0.2, 1 - getImmunityFactor() * 0.8);
      if (currentStageIndex < stageOrder.length - 1 && Math.random() < worsenChance) {
        const newStageIndex = currentStageIndex + 1;
        const advStage = stageOrder[newStageIndex];
        updateDiseaseStage(diseaseKey, advStage);
        log(`[健康系统] ${diseaseKey} 从${currentStage}恶化到${advStage}`);
        // 并发症：进入晚期/危重时按概率引发关联疾病
        if (advStage === '晚期' || advStage === '危重') {
          const comps = getComplications(diseaseKey);
          if (comps.length && Math.random() < 0.3) {
            const pick = comps[Math.floor(Math.random() * comps.length)];
            if (!result.includes(pick) && !healthState.diseases.includes(pick)) {
              result.push(pick);
              addDisease(pick); // 记录发病次数 + 阶段
              recordMedical(`并发症：${getDiseaseInfo(pick)?.name || pick}（源于 ${getDiseaseInfo(diseaseKey)?.name || diseaseKey}）`);
              log(`[健康系统] ${diseaseKey} 并发症 ${pick}`);
            }
          }
        }
      }
    }
    // 需要治疗的疾病不会自然变化
    // 慢性病偶发加重：免疫力低时，处于初期的慢性病也可能跳到中期（flare-up）
    if (isChronic(diseaseKey) && currentStageIndex === 0) {
      const flare = Math.max(0, -getImmunityFactor()) * 0.1;
      if (Math.random() < flare) {
        updateDiseaseStage(diseaseKey, '中期');
        log(`[健康系统] 慢性病 ${diseaseKey} 偶发加重到中期`);
      }
    }
  }

  return result;
}

// 计算疾病阶段对健康值的影响
function calculateDiseaseHealthDecay(diseases) {
  let totalDecay = 0;

  for (const diseaseKey of diseases) {
    const disease = getDiseaseInfo(diseaseKey);
    // 防御：未知疾病键（旧数据/篡改）不抛错，跳过
    if (!disease) continue;
    const stage = getDiseaseStage(diseaseKey);
    const stageConfig = DISEASE_STAGES[stage] || DISEASE_STAGES['初期'];

    // 基础衰减 + 阶段衰减
    const decay = (disease.healthDecay || 2) + stageConfig.healthDecay;
    totalDecay += decay;
  }

  return totalDecay;
}

// 获取疾病信息（普通疾病或季节性疾病）
function getDiseaseInfo(diseaseKey) {
  return DISEASES[diseaseKey] || SEASONAL_DISEASES[diseaseKey];
}

// 生成疾病报告（不显示具体疾病名称，只描述情绪）
function generateDiseaseReport() {
  const diseases = checkDiseases();

  if (diseases.length === 0) {
    return '身体状态还不错，没什么大问题~';
  }

  // 只描述情绪状态和疾病阶段，不显示具体疾病名称
  const moodTexts = diseases.map(diseaseKey => {
    const stage = getDiseaseStage(diseaseKey);
    const mood = DISEASE_MOOD_MAP[diseaseKey] || '身体有点不舒服';
    const stageText = DISEASE_STAGES[stage]?.label || '';
    return `${mood}（${stageText}）`;
  });

  return '最近身体状态不太好：' + moodTexts.join('，') + '~';
}

// 生成疾病情绪提示（给 LLM 用）
// 疾病情绪描述映射（不显示具体疾病名称）
const DISEASE_MOOD_MAP = {
  // 普通疾病
  dehydration: '头晕乏力、口干舌燥，身体很虚弱',
  malnutrition: '浑身无力、脸色苍白，身体很差',
  exhaustion: '累瘫了、反应迟钝，完全没力气',
  insomnia: '眼睛红肿、注意力不集中，精神很差',
  depression: '情绪低落、提不起劲，心情很糟糕',
  anxiety: '紧张不安、心跳加速，压力好大',
  loneliness: '孤孤单单、不想说话，感觉很寂寞',
  subhealth: '整体状态不佳、容易疲惫，身体不舒服',
  cold: '打喷嚏流鼻涕、喉咙痛，好难受',
  fever: '发烧头晕、浑身酸痛，好难受',
  cough: '一直咳嗽、喉咙痒，好难受',
  headache: '头疼欲裂、头晕眼花，好难受',
  gastroenteritis: '肚子疼、想吐，好难受',
  allergy: '打喷嚏、皮肤痒，好难受',
  heatstroke: '头晕恶心、体温升高，好难受',
  motion_sickness: '恶心头晕、脸色苍白，好难受',
  anemia: '脸色苍白、头晕乏力，身体很差',
  eyestrain: '眼睛干涩、视力模糊，好难受',
  constipation: '肚子不舒服，好难受',
  flu: '高烧全身酸痛、极度乏力，好难受',
  rhinitis: '鼻塞流鼻涕、打喷嚏，好难受',
  pharyngitis: '喉咙痛、吞咽困难，好难受',
  mouth_ulcer: '口腔溃疡、疼得吃不下东西',
  toothache: '牙疼得厉害，好难受',
  tinnitus: '耳朵嗡嗡响、听力下降，好难受',
  neurasthenia: '容易发怒、失眠健忘，状态很差',
  palpitation: '心跳加速、胸闷气短，好难受',
  hypertension: '头疼头晕、耳鸣，好难受',
  hypoglycemia: '手抖出冷汗、头晕眼花，好难受',
  arthritis: '关节疼痛、活动受限，好难受',
  backache: '腰部酸痛、僵硬，好难受',
  cervical_spondylosis: '脖子僵硬、头晕手麻，好难受',
  hair_loss: '头发脱落、头皮痒，有点担心',
  hyperlipidemia: '血液黏糊糊的、容易累，有点担心血管',
  fatty_liver: '右上腹闷闷的、没力气，肝有点负担',
  diabetes: '老是口渴、尿多、容易饿，身体怪怪的',
  hyperuricemia: '关节隐隐作痛，怕哪天痛风发作',
  atherosclerosis: '头晕胸闷、血管硬邦邦的，好担心',
  hypokalemia: '四肢发软、心慌，一点力气都没有',

  // 春季疾病
  spring_allergy: '打喷嚏、眼睛痒、流鼻涕，春季过敏好难受',
  spring_cold: '咳嗽喉咙痛、乏力，春季感冒好难受',
  spring_rhinitis: '鼻塞流鼻涕、打喷嚏，春季鼻炎好难受',

  // 夏季疾病
  summer_heatstroke: '高烧昏迷、意识不清，热射病好危险',
  summer_diarrhea: '腹痛腹泻、脱水，夏季腹泻好难受',
  summer_rash: '皮肤红疹、瘙痒，夏天好难受',

  // 秋季疾病
  autumn_dryness: '皮肤干、嘴唇裂、喉咙痒，秋天好干燥',
  autumn_cough: '干咳喉咙痒，秋天好难受',
  autumn_cold: '打喷嚏流鼻涕、发烧，换季感冒好难受',

  // 冬季疾病
  winter_flu: '高烧全身酸痛、极度乏力，冬季流感好难受',
  winter_pneumonia: '呼吸困难、咳嗽发烧，肺炎好难受',
  winter_frostbite: '皮肤红肿、麻木刺痛，冻伤好难受',
  winter_rhinitis: '鼻塞流鼻涕、打喷嚏，冬季鼻炎好难受',

  // v6.0 心理 / 内分泌 / 睡眠 / 创伤
  anxiety_disorder: '心里七上八下、静不下来，总担心出什么事',
  depression_major: '什么都不想干、提不起劲，心里像压着块石头',
  panic_disorder: '突然心慌得厉害、喘不上气，好害怕',
  social_phobia: '一想到要见人就紧张、手心冒汗，想躲起来',
  ocd: '总想反复检查、控制不住，好累',
  ptsd: '老想起不好的事、容易惊到，睡不安稳',
  bipolar: '情绪像坐过山车，一会儿特别亢奋一会儿又掉到底',
  sad: '天冷就提不起劲、只想睡觉、特别想吃甜的',
  hyperthyroidism: '心跳快、手抖、怕热，瘦了不少',
  hypothyroidism: '特别怕冷、整个人懒懒的、反应也慢了',
  hormonal_imbalance: '皮肤变差、情绪忽上忽下、睡不好',
  infected_wound: '伤口又红又肿还疼，有点发热',
  concussion: '头好晕、有点恶心、注意力完全散了',
  sleep_disorder: '翻来覆去睡不着、半夜总醒，白天困得不行',
  circadian_disorder: '白天没精神、晚上却很亢奋，作息完全乱了'
};

function generateDiseaseHint() {
  const diseases = checkDiseases();
  const incubating = Object.keys(healthState.incubating || {});

  if (diseases.length === 0) {
    // 潜伏期：有点说不出的不对劲，但还没真正发病
    if (incubating.length) {
      return '【情绪状态】最近总觉得有点不对劲、莫名乏力，说不上来哪里不舒服。请在回复中自然体现这种隐约的不适，但不要说出生病，也不要提及疾病名称。';
    }
    return '';
  }

  const moodTexts = diseases.map(diseaseKey => {
    return DISEASE_MOOD_MAP[diseaseKey] || '身体不舒服，好难受';
  });

  let suffix = '。请在回复中自然体现这些情绪，但不要直接说出具体疾病名称。';
  if (diseases.some(d => isChronic(d))) suffix = '；有些是老毛病，容易反复，要好好保养。' + suffix;
  if (diseases.some(d => getDiseaseStage(d) === '危重')) suffix = '；有危重情况，非常担心、想赶紧治病。' + suffix;
  const organWarn = getOrganWarnings();
  if (organWarn.length) suffix = `；感觉${organWarn.slice(0, 2).join('、')}，身体很虚。` + suffix;
  return '【情绪状态】' + moodTexts.join('；') + suffix;
}

// 获取季节名称
function getSeasonName(season) {
  const names = {
    'spring': '春季',
    'summer': '夏季',
    'autumn': '秋季',
    'winter': '冬季'
  };
  return names[season] || '';
}

// ── 夜间睡眠系统 ──
// 根据睡眠需求判断是否睡觉，不是固定时间
let lastSleepState = null; // 上次睡眠状态

/**
 * 判断机器人当前是否在睡觉
 * 综合考虑睡眠需求 + 时间（晚上更容易入睡，白天更难）
 * @returns { boolean, string } [是否睡觉, 原因]
 */
function isSleeping() {
  const config = cfg();
  if (!config.autoSleep) return [false, 'autoSleep 已关闭'];

  const now = new Date();
  const hour = now.getHours();
  const isNight = hour >= 22 || hour < 6; // 22:00-06:00 是夜晚

  // 睡眠需求阈值（低于此值入睡）—— 晚上更敏感，阈值更高
  let sleepThreshold = Number(config.sleepSleepThreshold) || 30;
  // 醒来阈值（高于此值醒来）
  let wakeThreshold = Number(config.sleepWakeThreshold) || 80;

  // 时间修正：晚上更容易入睡（阈值 +10），白天更难入睡（阈值 -10）
  if (isNight) {
    sleepThreshold += 10; // 晚上 40 就睡
    wakeThreshold -= 10;  // 晚上 70 就醒（睡够了）
  } else {
    sleepThreshold -= 10; // 白天 20 才睡（很困才睡）
    wakeThreshold += 10;  // 白天 90 才醒（必须很精神）
  }

  const sleepNeed = Number(healthState.sleep);

  // 睡眠需求低于阈值 → 睡觉
  if (sleepNeed < sleepThreshold) {
    return [true, `睡眠需求${Math.round(sleepNeed)}，${isNight ? '夜深了' : '太困了'}要睡觉`];
  }
  // 睡眠需求高于阈值 → 醒来
  else if (sleepNeed >= wakeThreshold) {
    return [false, `睡眠需求${Math.round(sleepNeed)}，已恢复`];
  }
  // 中间状态：保持上次状态（防止在阈值附近反复切换）
  else {
    return [lastSleepState === true, `睡眠需求${Math.round(sleepNeed)}，维持当前状态`];
  }
}

/**
 * 检测睡眠状态变化（刚入睡/刚醒来），返回要发送的消息
 * @returns { string|null } 需要发送的消息，null 表示无变化
 */
function checkSleepTransition() {
  const [sleeping] = isSleeping();

  if (sleeping && !lastSleepState) {
    // 刚入睡
    lastSleepState = true;
    const sleepNeed = Math.round(healthState.sleep);
    return `好困... 我要去睡了（睡眠需求${sleepNeed}）`;
  } else if (!sleeping && lastSleepState === true) {
    // 刚醒来
    lastSleepState = false;
    const sleepNeed = Math.round(healthState.sleep);
    return `睡饱了，我醒啦（睡眠需求${sleepNeed}）`;
  }

  lastSleepState = sleeping;
  return null;
}

/**
 * 睡眠期间恢复睡眠需求
 * 每次被调用（即有消息进来时），睡眠需求 +5
 * 这样即使没人发消息，也会慢慢恢复
 */
function sleepRecovery() {
  if (!isSleeping()[0]) return; // 不在睡觉

  // 每次检查恢复 5 点睡眠需求
  healthState.sleep = Math.min(100, healthState.sleep + 5);
  healthState.energy = Math.min(100, healthState.energy + 3);

  // 如果睡眠需求足够高，自动醒来
  const [nowSleeping] = isSleeping();
  if (!nowSleeping) {
    log('[健康系统] 😴 睡眠需求恢复，自动醒来');
  }
}

// 衰减状态
async function decayHealth() {
  const config = cfg();
  const nowMs = Date.now();
  const elapsed = (nowMs - healthState.lastUpdate) / 1000;

  // 防御：decayInterval 必须为正数，否则 times 会是 Infinity
  const decayInterval = Number(config.decayInterval) > 0 ? Number(config.decayInterval) : 3600;
  if (elapsed < decayInterval) return;

  const times = Math.floor(elapsed / decayInterval);
  if (!Number.isFinite(times) || times < 1) return;

  // v5.0：刷新环境（天气/气温/空气质量，每 3 小时变化一次）
  rollEnvironment();

  // v6.0：社区疫情演进（爆发 / 升级 / 平息）
  rollEpidemic();

  // 先衰减除健康值外的其他状态
  const now = new Date();
  const hour = now.getHours();
  const isNight = hour >= 22 || hour < 6; // 22:00-06:00 是夜晚
  const hourF = hour + now.getMinutes() / 60; // 带小数的钟点（供昼夜节律曲线插值）

  // v6.0：推进睡眠阶段（夜间深睡修复睡眠负债，白天回到清醒）
  updateSleepStage(isNight, times);

  for (const key of Object.keys(STATUSES)) {
    if (key === 'health') continue;   // 健康值特殊处理（由疾病/器官决定）
    if (key === 'immunity') continue; // 抵抗力特殊处理（由病情/器官单独调节，避免被误衰减）

    const decayKey = STATUSES[key].decayKey;
    let decayValue = config[decayKey] || 5;

    // 时间修正（v8.0：由"白天/夜晚"二值升级为 24 小时昼夜节律曲线插值）
    if (key === 'sleep') {
      // 褪黑素高的时段（夜间）睡眠需求掉得更快；白天也累，但幅度小得多
      const mel = getCircadianValue('melatonin', hourF);
      decayValue *= circadianOn() ? (1.05 + (mel / 100) * 1.4) : (isNight ? 2 : 1.5);
    } else if (key === 'energy') {
      // 警觉度高的时段精力消耗快；深夜低谷几乎在回血
      const alertV = getCircadianValue('alert', hourF);
      decayValue *= circadianOn() ? (0.4 + (alertV / 100) * 1.85) : (isNight ? 0.5 : 2);
    }

    // 体质修正：不同体质对特定状态的消耗速度不同
    decayValue *= getConstitutionDecayMod(key, decayKey);

    // 防御：字段缺失或非数字时按 0 处理，避免 NaN 传播
    const current = Number(healthState[key]);
    const base = Number.isFinite(current) ? current : 0;
    healthState[key] = Math.max(0, base - decayValue * times);
  }

  // v6.0：心理自然演变（焦虑/抑郁/情绪稳定/专注）与内分泌调节
  updatePsyche(times);
  updateHormones(times, isNight);

  // v7.0：基础需求深化——维度间连锁反应 + 深层生理亚成分演变
  applyNeedCascade(times);
  updateSubsystems(times, isNight);

  // v8.0：肠道菌群演变 + 过敏负荷重算 + 关系网自然疏远
  updateGut(times);
  // v10.0：宠物需求衰减 / 疾病演变 / 掉毛与夜间吵闹指数
  //        必须排在 computeAllergyLoad 之前 —— 过敏负荷要读 petShed
  updatePets(times);
  // v11.0：日常生活 —— 穿衣体感 / 三餐风险 / 居家整洁 / 账单结算
  //        居家必须排在 computeAllergyLoad 之前 —— 尘螨因子要读 home.tidy，
  //        而 home.tidy 又要读上一步刚算好的 petShed（宠物掉毛弄脏房间）
  updateOutfit(times);
  updateMeal(times);
  updateHome(times);
  // v12.0：钱币系统 —— 发薪必须排在账单之前：先发工资、再扣房租，
  //        否则同一次 tick 里会出现「刚发了钱却因余额不足记了一笔欠费」
  updateSalary();
  updateBills(times);
  // v13.0：时间与社会 —— 星期 / 节日 / 极端天气 / 慢性病缓解期
  updateTime(times);
  computeAllergyLoad();
  updateRelations(times);
  // v9.0：爱好的热情消退 + 劳损/视疲劳/兴趣耗竭自然回落
  updateHobbies(times);
  // 派生状态写回（供疾病判定 / 报告 / 生物年龄读取）
  healthState.gutScore = Math.round(getGutScore() * 10) / 10;
  healthState.gutBarrier = Math.round(getGut('barrier') * 10) / 10;

  // 检测疾病（含潜伏中，用于潜伏管理与自愈判定）
  const detectedRaw = checkDiseases({ includeIncubating: true });
  const prevDiseases = [...healthState.diseases];

  // 潜伏期推进：到期发病 / 条件消失则身体自行清除
  tickIncubation(detectedRaw);

  // 新暴露：本次检测到但既未发病也未潜伏 → 进入潜伏（或直接发病）
  for (const d of detectedRaw) {
    if (healthState.diseases.includes(d)) continue;
    if (isIncubating(d)) continue;
    enqueueExposure(d, '自然发病');
  }

  // 已发病（排除仍在潜伏期的）
  const diseases = detectedRaw.filter(d => !isIncubating(d));

  // 处理疾病恶化/减轻
  const updatedDiseases = processDiseaseProgression(diseases);
  healthState.diseases = updatedDiseases;

  // 传染暴露（社交度高时可能被传染）
  rollContagion();

  // v6.0：疫情期间的额外暴露（口罩/隔离/抵抗力可显著降低）
  rollEpidemicExposure();

  // 记录新发病例（含自然发病/传染/并发症/潜伏结束）
  for (const d of healthState.diseases) {
    if (!prevDiseases.includes(d)) {
      healthState.diseaseHistory[d] = (Number(healthState.diseaseHistory[d]) || 0) + 1;
      if (!healthState.pathogens) healthState.pathogens = {};
      if (!healthState.pathogens[d]) healthState.pathogens[d] = { type: getPathogen(d), load: 60 };
      // v8.0：首次患病记入大事记（反复发作的不再记，避免噪音）
      if (Number(healthState.diseaseHistory[d]) <= 1) {
        const di = getDiseaseInfo(d);
        recordTimeline('🤒', `第一次出现「${di ? di.name : d}」`, 'disease');
      }
    }
  }
  // 清理已痊愈的病原记录
  if (!healthState.pathogens) healthState.pathogens = {};
  for (const k of Object.keys(healthState.pathogens)) {
    if (!healthState.diseases.includes(k)) delete healthState.pathogens[k];
  }
  // 清理已痊愈的确诊标记（下次得病需重新确诊）
  if (!healthState.diagnosed) healthState.diagnosed = {};
  for (const k of Object.keys(healthState.diagnosed)) {
    if (!healthState.diseases.includes(k) && !isIncubating(k)) delete healthState.diagnosed[k];
  }
  // 派生症状明细（供报告展示）
  healthState.activeSymptoms = healthState.diseases.map(d => {
    const di = getDiseaseInfo(d);
    return di ? `${di.name}：${di.symptoms}` : d;
  });

  // 同步发烧度：患有发热类疾病时按阶段抬高，否则由衰减自然退烧
  syncFever(healthState.diseases);

  // 器官：疾病损伤 + 自然修复
  damageOrgans(updatedDiseases, times);
  regenOrgans(times);

  // v6.0：外伤——伤口自然愈合 + 随机意外受伤（运动过度/极度疲劳/空气差时概率上升）
  healInjuries();
  for (let i = 0; i < Math.min(times, 3); i++) rollInjury();

  // 计算健康值衰减
  // 1. 基础衰减（v6.0：30 岁后随年龄增长而加快）
  const ageMul = agingOn() ? 1 + Math.max(0, (Number(healthState.age) || 20) - 30) * 0.012 : 1;
  const healthDecay = (config.healthDecay || 3) * times * ageMul;

  // 2. 疾病额外衰减（考虑疾病阶段）
  const diseaseDecay = calculateDiseaseHealthDecay(updatedDiseases) * times;

  // 3. 其他状态过低导致健康值下降
  let statusImpact = 0;
  if (Number(healthState.thirst) < 20) statusImpact += 3; // 口渴
  if (Number(healthState.hunger) < 20) statusImpact += 3; // 饥饿
  if (Number(healthState.energy) < 20) statusImpact += 2; // 疲惫
  if (Number(healthState.mood) < 20) statusImpact += 2; // 心情差
  if (Number(healthState.sleep) < 20) statusImpact += 3; // 睡眠不足
  if (Number(healthState.stress) < 20) statusImpact += 2; // 压力大
  statusImpact *= times;

  // 4. 器官受损的附加衰减
  const organImpact = calculateOrganImpact() * times;

  // 5. 检验指标异常的附加负担（v4.0：血压/血脂/血糖/肝肾功/电解质异常都要算账）
  const vitalImpact = applyVitalImpact();

  // 6. 坏习惯的附加负担（v6.0：吸烟/饮酒/久坐/熬夜持续损伤身体）
  const habitImpact = applyHabitEffects(times);

  // 7. 外伤未愈的负担（v6.0：伤口越重越拖累健康）
  const injuryImpact = (Array.isArray(healthState.injuries)
    ? healthState.injuries.reduce((a, i) => a + Number(i.severity) * 0.05, 0)
    : 0) * times;

  // 总衰减 = 基础衰减 + 疾病衰减 + 状态影响 + 器官影响 + 指标异常 + 习惯 + 外伤
  const totalHealthDecay = healthDecay + diseaseDecay + statusImpact + organImpact + vitalImpact.healthDecay * times + habitImpact + injuryImpact;
  const healthCurrent = Number(healthState.health);
  healthState.health = Math.max(0, (Number.isFinite(healthCurrent) ? healthCurrent : 0) - totalHealthDecay);

  healthState.lastUpdate = now;

  // 指标异常额外损伤器官（高血压磨心脏、高尿酸/高血糖伤肾、脂肪肝伤肝…）
  for (const [okey, dv] of Object.entries(vitalImpact.organs)) damageOrgan(okey, dv * times);

  // 生活方式自然退化 + 体重演化（饮食差+不运动 → 变胖；自律 → 慢慢回落）
  {
    const dietV = Math.max(0, Number(healthState.diet) - 1.5 * times);
    const exV = Math.max(0, Number(healthState.exercise) - 1.2 * times);
    const sqV = Math.max(0, Number(healthState.sleepQuality) - 1.0 * times);
    healthState.diet = dietV;
    healthState.exercise = exV;
    healthState.sleepQuality = sqV;
    const wNow = Number(healthState.weight);
    const w = Number.isFinite(wNow) ? wNow : 58;
    const badLife = (dietV < 50 ? 1 : 0) + (exV < 45 ? 1 : 0);
    const dw = badLife === 2 ? 0.06 : badLife === 1 ? 0.02 : -0.04;
    healthState.weight = Math.max(35, Math.min(120, w + dw * times));

    // v5.0：营养素随生活方式退化（吃得差掉得更快；由「吃/清淡饮食/营养品」补充）
    if (!healthState.nutrients || typeof healthState.nutrients !== 'object') healthState.nutrients = {};
    let nutRate = 1.0;
    try { const nr = Number(config.nutrientDecay); if (Number.isFinite(nr) && nr >= 0) nutRate = nr; } catch { /* 默认 1 */ }
    const nutDecay = (dietV < 50 ? nutRate * 2.2 : nutRate) * times;
    for (const nk of Object.keys(NUTRIENT_INFO)) {
      healthState.nutrients[nk] = Math.max(0, Math.min(100, getNutrient(nk) - nutDecay));
    }
  }

  // v5.0：环境对心情的影响（晴天提神、雨天/雾霾致郁）
  {
    const moodDelta = getEnvMoodDelta() * times;
    healthState.mood = Math.max(0, Math.min(100, Number(healthState.mood) + moodDelta));
  }

  // v8.0：肠道菌群与过敏负荷对全身的作用（肠脑轴 / 消化 / 炎症）
  {
    const gutFx = getGutEffects();
    // 菌群好坏 → 消化舒适度的自然回归偏移
    healthState.comfort = Math.max(0, Math.min(100, Number(healthState.comfort) + gutFx.comfortMod * times));
    // 过敏负荷 → 舒适度 / 睡眠质量 / 专注力同步下滑（越重越明显，按 1.5 次方放大）
    const al = Number(healthState.allergyLoad) || 0;
    if (al > 8) {
      const alK = Math.pow(Math.min(1, al / 100), 1.5);
      healthState.comfort = Math.max(0, Number(healthState.comfort) - alK * 3 * times);
      healthState.sleepQuality = Math.max(0, Number(healthState.sleepQuality) - alK * 2.5 * times);
      healthState.focus = Math.max(0, Math.min(100, Number(healthState.focus) - alK * 2 * times));
    }
    // 肠道屏障破损 → 慢性低度炎症持续磨健康值
    if (gutFx.leakRisk > 0) {
      healthState.health = Math.max(0, Number(healthState.health) - gutFx.leakRisk * 0.05 * times);
    }
  }

  // v8.0：关系网对归属 / 安全感 / 孤独 / 亲密需求的反哺
  {
    const rel = getRelationEffects();
    if (rel.count > 0) {
      healthState.belonging = Math.max(0, Math.min(100, Number(healthState.belonging) + rel.belonging * times));
      healthState.security = Math.max(0, Math.min(100, Number(healthState.security) + rel.security * times));
      healthState.intimacy = Math.max(0, Math.min(100, Number(healthState.intimacy) + rel.intimacy * times));
      if (rel.loneliness > 0) {
        healthState.loneliness = Math.max(0, Number(healthState.loneliness) - rel.loneliness * 0.3 * times);
      }
    }
  }

  // v9.0：爱好对满足 / 心情 / 压力 / 安全感 / 社交的反哺 + 练过头的身体代价
  {
    const hb = getHobbyEffects();
    if (hb.count > 0) {
      // 「压力值」高=无压力，所以减压是加值
      healthState.satisfaction = Math.max(0, Math.min(100, Number(healthState.satisfaction) + hb.satisfaction * 0.08 * times));
      healthState.mood = Math.max(0, Math.min(100, Number(healthState.mood) + hb.mood * 0.35 * times));
      healthState.stress = Math.max(0, Math.min(100, Number(healthState.stress) + hb.stress * 0.5 * times));
      healthState.security = Math.max(0, Math.min(100, Number(healthState.security) + hb.security * 0.25 * times));
      healthState.social = Math.max(0, Math.min(100, Number(healthState.social) + hb.social * 0.3 * times));
    }
    // 上肢劳损 → 持续磨健康（久练成疾）
    const strain = Number(healthState.hobbyStrain) || 0;
    if (strain > 40) healthState.health = Math.max(0, Number(healthState.health) - (strain - 40) * 0.012 * times);
    // 视疲劳 → 专注力与睡眠质量下滑
    const eye = Number(healthState.hobbyEyeStrain) || 0;
    if (eye > 45) {
      healthState.focus = Math.max(0, Math.min(100, Number(healthState.focus) - (eye - 45) * 0.02 * times));
      healthState.sleepQuality = Math.max(0, Number(healthState.sleepQuality) - (eye - 45) * 0.015 * times);
    }
    // 兴趣耗竭 → 心情与满足感被拖着走
    const bo = Number(healthState.hobbyBurnout) || 0;
    if (bo > 50) {
      healthState.mood = Math.max(0, Number(healthState.mood) - (bo - 50) * 0.02 * times);
      healthState.satisfaction = Math.max(0, Number(healthState.satisfaction) - (bo - 50) * 0.02 * times);
    }
  }

  // v10.0：宠物对归属 / 孤独 / 心情 / 满足 / 社交的反哺 + 掉毛与夜行吵闹的代价
  {
    const petFx = getPetEffects();
    if (petFx.count > 0) {
      // 亲密度越高陪伴感越强（「压力值」高=无压力，所以减压是加值）
      healthState.belonging = Math.max(0, Math.min(100, Number(healthState.belonging) + petFx.belonging * 0.09 * times));
      healthState.mood = Math.max(0, Math.min(100, Number(healthState.mood) + petFx.mood * 0.06 * times));
      healthState.satisfaction = Math.max(0, Math.min(100, Number(healthState.satisfaction) + petFx.satisfaction * 0.07 * times));
      healthState.stress = Math.max(0, Math.min(100, Number(healthState.stress) + petFx.stress * 0.5 * times));
      healthState.social = Math.max(0, Math.min(100, Number(healthState.social) + Math.min(4, petFx.avgBond * 0.03) * times));
      if (petFx.loneliness > 0) {
        healthState.loneliness = Math.max(0, Number(healthState.loneliness) - petFx.loneliness * 0.5 * times);
      }
      // 宠物生病会拖着主人一起难受
      if (petFx.sick > 0) {
        healthState.mood = Math.max(0, Number(healthState.mood) - petFx.sick * 1.2 * times);
        healthState.anxiety = Math.max(0, Math.min(100, Number(healthState.anxiety) + petFx.sick * 0.8 * times));
      }
    }
    // 夜行物种（猫/仓鼠/刺猬/龙猫/蜥蜴）夜里闹腾 → 磨睡眠质量
    const petNoise = Number(healthState.petNightNoise) || 0;
    if (isNight && petNoise > 0) {
      healthState.sleepQuality = Math.max(0, Number(healthState.sleepQuality) - petNoise * 0.9 * times);
      if (petNoise >= 2.5 && Math.random() < Math.min(0.6, 0.18 * times)) {
        log(`[健康系统] 🌙 半夜被宠物闹醒了（夜间吵闹指数 ${petNoise.toFixed(1)}）`);
      }
    }
  }

  // 耐药性随时间消退（停药后逐渐恢复药效）
  decayDrugResistance(times);

  // v6.0：年龄增长（每满 365 天过一次生日，年龄 +1，基础衰减随之上升）
  if (agingOn()) {
    const nowTs = Date.now();
    if (!Number.isFinite(Number(healthState.age)) || Number(healthState.age) <= 0) healthState.age = 20;
    if (!Number(healthState.lastBirthday)) healthState.lastBirthday = nowTs;
    let guard = 0;
    while (nowTs - Number(healthState.lastBirthday) >= 365 * 86400000 && guard < 100) {
      healthState.age = Number(healthState.age) + 1;
      healthState.lastBirthday = Number(healthState.lastBirthday) + 365 * 86400000;
      guard++;
      const bd = celebrateBirthday(healthState.age);
      log(`[健康系统] 🎂 生日快乐！年龄增长到 ${healthState.age} 岁（红包 ¥${bd.redPacket}，${bd.greeted.length} 人送来祝福）`);
    }
  }

  // 零钱到账（拾荒、活期利息、零星小钱那种量级）。
  //   v12.0 起主要收入已改为「发薪日一次性到账」——这条降级成零钱，
  //   默认从 ¥5/小时 调到 ¥1/小时（月约 ¥720），不再是养活自己的主力。
  //   合并窗口 6 小时：逐周期记账会把流水刷满，也看不出「这个月杂项收了多少钱」。
  let allowance = 1;
  try { const a = Number(config.moneyAllowance); if (Number.isFinite(a) && a >= 0) allowance = a; } catch { /* 默认 1 */ }
  if (allowance > 0) addMoney(allowance * times, 'pocket', '零钱', 6 * 3600000);

  // ── 自动行动：状态极低时 AI 自行行动（模拟真人"实在撑不住了"） ──
  // 阈值随机 12~18，不是每次都在同一个值触发，更自然
  // 冷却 30 分钟防刷屏
  const AUTO_COOLDOWN = 1800000; // 30 分钟
  if (!healthState.lastAutoAction) healthState.lastAutoAction = {};

  const autoChecks = [
    { key: 'hunger',   action: 'eat',   label: '吃饭' },
    { key: 'thirst',   action: 'drink', label: '喝水' },
    { key: 'sleep',    action: 'sleep', label: '睡觉' },
    { key: 'energy',   action: 'rest',  label: '休息' },
    { key: 'fatigue',  action: 'rest',  label: '休息' },
    { key: 'stress',   action: 'relax', label: '放松' },
  ];

  for (const { key, action, label } of autoChecks) {
    const val = Number(healthState[key]);
    // 随机阈值 12~18，模拟真人"实在撑不住了"才行动
    const threshold = 12 + Math.floor(Math.random() * 7);
    if (!Number.isFinite(val) || val >= threshold) continue;

    const lastTs = healthState.lastAutoAction[action] || 0;
    if (now - lastTs < AUTO_COOLDOWN) continue;

    try {
      await providers['health.state']({ action });
      healthState.lastAutoAction[action] = now;
      const desc = val < 8 ? '快撑不住了' : '实在太难受了';
      log(`[健康系统] 🤖 ${STATUSES[key].name}${desc}(${Math.round(val)})，自动${label}`);
    } catch (error) {
      log(`[健康系统] 自动${label}失败：${error.message}`);
    }
  }

  if (providers['health.state']) {
    await providers['health.state']({ action: 'save', state: healthState });
  }

  // 抵抗力自然调节：健康时缓慢回升，患病时下降；血液/免疫器官受损会拖累抵抗力
  const immNow = Number(healthState.immunity);
  let immDelta = healthState.diseases.length > 0 ? -1 : 1.5;
  if (getOrgan('blood') < 40) immDelta -= 0.5;
  if (Number(healthState.health) < 25) immDelta -= 0.5;
  // v8.0：肠道菌群对免疫的调节（肠道是人体最大的免疫器官）+ 过敏负荷持续消耗免疫
  immDelta += getGutEffects().immunityMod;
  if (Number(healthState.allergyLoad) > 50) immDelta -= 0.4;
  healthState.immunity = Math.max(0, Math.min(100, immNow + immDelta * Math.min(times, 3)));

  const summary = Object.keys(STATUSES).map(k => `${STATUSES[k].emoji}${Math.round(healthState[k])}`).join(' ');
  const organSummary = Object.keys(ORGAN_INFO).map(k => `${ORGAN_INFO[k].emoji}${Math.round(getOrgan(k))}`).join(' ');
  log(`[健康系统] 状态衰减：${summary}，疾病：${healthState.diseases.join(',') || '无'}`);
  log(`[健康系统] 器官：${organSummary}，潜伏：${Object.keys(healthState.incubating || {}).join(',') || '无'}，抗体：${getAntibodyCount()}，¥${Math.round(getMoney())}`);
  log(`[健康系统] 环境：${getEnvSummary()}，就诊医院：${getHospitalInfo().name}，家族史：${getFamilyHistoryList().join(',') || '无'}`);
  {
    const abn = getAbnormalVitals();
    log(`[健康系统] 检验指标总评 ${getVitalScore()} 分${abn.length ? '，异常：' + abn.map(x => x.info.short + x.level).join('、') : '，全部正常'}`);
  }

  // v6.0：心理 / 睡眠 / 内分泌 / 外伤 / 疫情 / 年龄 摘要
  log(`[健康系统] 心理：😟焦虑${Math.round(Number(healthState.anxiety))} 🌧️抑郁${Math.round(Number(healthState.depressionLevel))} 🧘稳定${Math.round(Number(healthState.stability))} 🎯专注${Math.round(Number(healthState.focus))}`);
  log(`[健康系统] 睡眠：阶段${(SLEEP_STAGES[healthState.sleepStage] || SLEEP_STAGES.awake).name}，负债${Math.round(Number(healthState.sleepDebt))}，咖啡因${Math.round(Number(healthState.caffeine))}，生物钟${healthState.sleepClock}`);
  log(`[健康系统] 激素：皮质醇${Math.round(getHormone('cortisol'))} 血清素${Math.round(getHormone('serotonin'))} 甲状腺素${Math.round(getHormone('thyroxine'))} 褪黑${Math.round(getHormone('melatonin'))}`);
  log(`[健康系统] 外伤：${(healthState.injuries || []).length} 处未愈（累计受伤 ${Number(healthState.scarCount) || 0} 次），疫情：${(healthState.epidemic || {}).active ? (getDiseaseInfo(healthState.epidemic.disease)?.name || healthState.epidemic.disease) + '(' + getEpidemicLevelName(healthState.epidemic.level) + ')' : '平稳'}`);
  log(`[健康系统] 年龄 ${Math.round(Number(healthState.age) || 20)} 岁（衰减倍率 ×${ageMul.toFixed(2)}），成就 ${Object.keys(healthState.achievements || {}).length}/${Object.keys(ACHIEVEMENTS).length}`);

  // v8.0：昼夜节律 / 菌群 / 过敏 / 关系 / 医保 / 生物年龄 摘要
  {
    const c = getCircadianEffects(hourF);
    const rel = getRelationEffects();
    const ins = getInsurancePlan();
    const bio = computeBiologicalAge();
    log(`[健康系统] 节律：${c.phase.emoji}${c.phase.name}（效能 ×${c.phase.eff}），精力曲线 ${c.energy}，皮质醇 ${c.cortisol}，褪黑素 ${c.melatonin}，建议睡眠窗口 ${getSleepWindow().startText}-${getSleepWindow().endText}`);
    log(`[健康系统] 菌群：${getGutLevel()}（综合 ${Math.round(getGutScore())}，屏障 ${Math.round(getGut('barrier'))}）｜过敏负荷 ${Math.round(Number(healthState.allergyLoad) || 0)}（${getAllergyLevelName(healthState.allergyLoad)}）`);
    log(`[健康系统] 关系：${rel.count} 人，平均亲密度 ${rel.avgAffinity}，矛盾 ${rel.conflicts}｜医保：${ins.info.name}（剩余额度 ¥${getInsuranceRemaining()}）`);
    log(`[健康系统] 生物年龄：实际 ${bio.real} 岁 → 生理 ${bio.bio} 岁（${bio.delta >= 0 ? '+' : ''}${bio.delta}，${getBioAgeLevel(bio.delta)}）｜大事记 ${Array.isArray(healthState.timeline) ? healthState.timeline.length : 0} 条`);
  }

  // v9.0：爱好与技能树摘要
  {
    const hb = getHobbyEffects();
    if (hb.count > 0) {
      const tops = getHobbies().slice(0, 3).map(x => `${x.meta.emoji}${x.meta.name}Lv${x.level}(${Math.round(x.rec.passion)}热情)`).join(' ');
      log(`[健康系统] 爱好：${hb.count} 项｜${tops}｜作品 ${hb.works} 件`);
    } else {
      log(`[健康系统] 爱好：还没有在练的爱好`);
    }
    log(`[健康系统] 劳损：上肢 ${Math.round(Number(healthState.hobbyStrain) || 0)}，视疲劳 ${Math.round(Number(healthState.hobbyEyeStrain) || 0)}，兴趣耗竭 ${Math.round(Number(healthState.hobbyBurnout) || 0)}，连击 ${Number(healthState.hobbyStreak) || 0} 次`);
  }

  // v10.0：宠物摘要
  {
    const pets = getPets();
    const memorial = getPets(true).length - pets.length;
    if (pets.length) {
      const lines = pets.map(p => {
        const st = getPetStage(p);
        const nd = getPetNeeds(p);
        const sick = p.diseases.length ? `｜🤒${p.diseases.map(d => PET_DISEASES[d] ? PET_DISEASES[d].name : d).join('、')}` : '';
        return `「${p.name}」${st.emoji}${st.name} 四维${Math.round(nd.avg)} 亲密度${Math.round(p.bond)} 健康${Math.round(p.health)}${sick}`;
      });
      log(`[健康系统] 宠物：${pets.length} 只｜${lines.join('　')}`);
      log(`[健康系统] 宠物指数：掉毛 ${Number(healthState.petShed || 0).toFixed(1)}（→ 过敏负荷）｜夜间吵闹 ${Number(healthState.petNightNoise || 0).toFixed(1)}｜累计开销 ¥${Math.round(Number(healthState.petCost) || 0)}${memorial ? `｜已离世 ${memorial} 只` : ''}`);
    } else {
      log(`[健康系统] 宠物：还没有养${memorial ? `（曾养过 ${memorial} 只）` : ''}`);
    }
  }

  // v11.0：日常生活摘要
  {
    if (outfitOn()) {
      const { info, style } = getWornOutfit();
      const feel = getFeelLevel();
      const uv = getUvRisk();
      log(`[健康系统] 穿着：${info.emoji}${info.name}（${style.name}风格）｜外面 ${feel.temp}℃ ${feel.name}｜淋湿 ${Math.round(getOutfitRec().wet)}｜紫外线 ${uv.uv}${uv.uv >= 6 ? (uv.guarded ? '（已防晒）' : '（没防晒！）') : ''}`);
    }
    if (mealOn()) {
      const todayMeals = getMealLog();
      const names = todayMeals.map(x => (MEALS[x.key] ? MEALS[x.key].name : x.key)).join('/');
      log(`[健康系统] 三餐：今日已吃 ${todayMeals.length} 顿${names ? `（${names}）` : ''}｜食物安全累积 ${Math.round(Number(healthState.foodRisk) || 0)}`);
    }
    if (homeOn()) {
      const h = getHomeRec();
      const lvl = getHomeLevel();
      log(`[健康系统] 居家：整洁 ${Math.round(h.tidy)}（${lvl.emoji}${lvl.name}）｜衣物洁净 ${Math.round(h.laundry)}｜待洗碗 ${h.dishes}｜除螨余效 ${Math.round(h.miteRelief)}｜尘螨因子 ×${getMiteFactor()}`);
    }
    if (billsOn()) {
      const b = getBillsRec();
      log(`[健康系统] 账单：月支出 ¥${getBillTotal()}｜距下次 ${getDaysToBill()} 天｜欠费 ¥${b.unpaid}${b.overdue ? `（逾期 ${b.overdue} 期）` : ''}｜生活开销累计 ¥${Math.round(Number(healthState.livingCost) || 0)}｜日晒累积 ${Math.round(Number(healthState.sunExposure) || 0)}`);
    }
  }

  // v6.0：成就解锁检测
  checkAchievements();
}

// 发热类疾病列表（同步发烧度维度用）
const FEVER_DISEASES = ['fever', 'flu', 'heatstroke', 'summer_heatstroke', 'winter_pneumonia', 'summer_diarrhea'];
function syncFever(diseases) {
  let target = 0;
  for (const d of (diseases || [])) {
    if (FEVER_DISEASES.includes(d)) {
      const stage = getDiseaseStage(d);
      const stageFever = { '初期': 50, '中期': 70, '晚期': 85, '危重': 95 }[stage] || 50;
      target = Math.max(target, stageFever);
    }
  }
  // 生病时抬高；病好时由 decayHealth 的衰减公式下降（自然退烧）
  if (target > Number(healthState.fever)) healthState.fever = Math.min(100, target);
}

// 记录病历（增强疾病医疗）
function recordMedical(text) {
  if (!Array.isArray(healthState.medicalHistory)) healthState.medicalHistory = [];
  healthState.medicalHistory.push({ date: localDayKey(), text });
  if (healthState.medicalHistory.length > 50) healthState.medicalHistory = healthState.medicalHistory.slice(-50);
}

// 检查并提醒低状态（隐藏数值）
async function checkAndRemind() {
  const config = cfg();
  if (!config.autoRemind) return;
  if (!sender) return; // 防御：sender 未初始化时不发提醒

  const threshold = config.reminderThreshold;
  const remindInterval = 1800000; // 30 分钟

  for (const statusKey of Object.keys(STATUSES)) {
    // badWhenHigh 维度（发烧度/成瘾度）低值=好，不提醒
    if (STATUSES[statusKey].badWhenHigh) continue;
    if (healthState[statusKey] < threshold) {
      const lastRemind = healthState.lastRemind[statusKey] || 0;
      if (Date.now() - lastRemind > remindInterval) {
        const status = STATUSES[statusKey];
        const message = `🚨 ${status.emoji} 我${status.moodEffect}了，好难受...`;
        try {
          await sender.sendTextBatch(chatKey, [message], {});
          healthState.lastRemind[statusKey] = Date.now();
          log(`[健康系统] 已发送${status.name}提醒`);
        } catch (error) {
          log(`[健康系统] 提醒发送失败：${error.message}`);
        }
      }
    }
  }
}

// ESM 中没有 __dirname，用 import.meta.url 计算插件目录（标准做法）
import { fileURLToPath } from 'url';
import path from 'path';
import os from 'os';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ══════════════════════════════════════════════════════════════════════════
//  图片报表（v7.1）
//  把 /健康 的输出从"一屏文字"升级为"一张可以直接截图分享的图"：
//    ① buildReportHtml()       纯字符串生成，不碰全局状态，可单测
//    ② renderHtmlToPng()       Electron 离屏渲染 HTML → PNG（无需任何三方库）
//    ③ sendHealthReportImage() 落盘 → 交给 sender.sendImage 发到当前会话
//
//  设计原则：图片是**增强**而不是唯一路径。发送通道按三层兜底（v14.0.1）：
//  ① 钩子上下文自带 sender（宿主直传，或此前调用过工具已暂存）→ 直接发图，不等 LLM；
//  ② 钩子没有发送通道 → 注入桥接指令让模型调 report_image 工具（工具执行时宿主
//     一定传全量 ctx），工具失败时它自己返回文字版；
//  ③ 图片功能被配置关闭 → 纯文字报告。
//  宁可退化，也不能让 /健康 直接没反应。
// ══════════════════════════════════════════════════════════════════════════

// 报表图片的落盘目录（临时产物，不污染插件目录；同名覆盖策略见 pruneReportImages）
function getReportImageDir() {
  return path.join(os.tmpdir(), 'qq-agent-health-report');
}

// 是否启用图片报表（默认开）
function reportImageOn() {
  try { return cfg().reportImageEnabled !== false; } catch { return true; }
}

// 报表画布宽度（默认 900，含 480~1600 夹取，防止设置页填出个 99999 把内存撑爆）
function getReportImageWidth() {
  let w = NaN;
  try { w = Number(cfg().reportImageWidth); } catch { /* 用默认 */ }
  if (!Number.isFinite(w) || w <= 0) w = 900;
  return Math.max(480, Math.min(1600, Math.round(w)));
}

// HTML 转义：疾病名/症状/病历等文本会进 HTML，必须转义
function escHtml(s) {
  return String(s === null || s === undefined ? '' : s)
    .split('&').join('&amp;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
    .split('"').join('&quot;')
    .split("'").join('&#39;');
}

// 数值 → 颜色档位。badWhenHigh 维度（发烧/焦虑/睡眠负债/热量盈余…）整体反转：
// 对这些维度"值高"才是坏消息，不做反转的话报表会把重病渲染成一片安心的绿色。
function getValueTone(value, key) {
  const v = Number(value);
  const safe = Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : 0;
  const bad = Boolean((STATUSES[key] && STATUSES[key].badWhenHigh)
    || (SUBSYSTEM_INFO[key] && SUBSYSTEM_INFO[key].badWhenHigh));
  const score = bad ? 100 - safe : safe;
  if (score >= 75) return { tone: 'good', color: '#1f9d63' };
  if (score >= 50) return { tone: 'ok', color: '#2f6fed' };
  if (score >= 25) return { tone: 'warn', color: '#d9821f' };
  return { tone: 'bad', color: '#d93a41' };
}

// 状态行显示用的简短标签：基础 13 维给"五阶段体感名"，其余给等级
function getRowTag(key, value) {
  const phase = getNeedPhase(key, value);
  return phase || getStatusLevel(value, key);
}

// ── ① HTML 报表 ────────────────────────────────────────────────────────────
// 类名约定：头部副标题用 .hd-sub 而不是 .sub —— 深层生理卡的 .sub 会与之撞车，
// 两处样式互相污染且很难发现自己改错了哪一个。CSS 里不留注释，保持生成的 HTML 干净。
function buildReportHtml(opts = {}) {
  const now = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;

  const num = (v, d = 0) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : d;
  };

  // ── 顶部 KPI ──
  const healthVal = Math.round(num(healthState.health, 0));
  const healthTone = getValueTone(healthVal, 'health');
  const currentDiseases = checkDiseases();
  const immunityVal = Math.round(num(healthState.immunity, 0));
  const cv = computeVitals();
  const vitalScore = getVitalScore(cv);
  const constitutionInfo = getConstitutionInfo();
  const envText = (() => { try { return getEnvSummary(); } catch { return '—'; } })();

  const kpis = [
    { label: '健康值', value: `${healthVal}`, unit: '/100', color: healthTone.color, sub: getStatusLevel(healthVal, 'health') },
    { label: '疾病', value: `${currentDiseases.length}`, unit: '项', color: currentDiseases.length ? '#d93a41' : '#1f9d63', sub: currentDiseases.length ? '正在发作' : '无疾病' },
    { label: '抵抗力', value: `${immunityVal}`, unit: '/100', color: getValueTone(immunityVal, 'immunity').color, sub: getStatusLevel(immunityVal, 'immunity') },
    { label: '检验评分', value: `${vitalScore}`, unit: '/100', color: getValueTone(vitalScore, 'immunity').color, sub: vitalScore >= 90 ? '指标良好' : vitalScore >= 70 ? '轻度异常' : '多项异常' }
  ].map((k) => `
      <div class="kpi">
        <div class="kpi-l">${escHtml(k.label)}</div>
        <div class="kpi-v" style="color:${k.color}">${escHtml(k.value)}<span class="kpi-u">${escHtml(k.unit)}</span></div>
        <div class="kpi-s">${escHtml(k.sub)}</div>
      </div>`).join('');

  // ── 24 维度状态条（按类别排序，双列）──
  const STATUS_ORDER = [
    'thirst', 'hunger', 'energy', 'health', 'sleep', 'fatigue', 'immunity', 'sleepDebt',
    'mood', 'stress', 'satisfaction', 'stability', 'focus', 'curiosity', 'empathy',
    'anxiety', 'depressionLevel', 'addiction', 'fever',
    'loneliness', 'social', 'belonging', 'security', 'comfort'
  ];
  const statusRows = STATUS_ORDER.filter((k) => STATUSES[k]).map((k) => {
    const meta = STATUSES[k];
    const value = Math.round(num(healthState[k], 0));
    const tone = getValueTone(value, k);
    const tag = getRowTag(k, value);
    const cls = meta.badWhenHigh ? ' st-badhigh' : '';
    return `
        <div class="st${cls}">
          <span class="st-e">${meta.emoji}</span>
          <span class="st-n">${escHtml(meta.name)}</span>
          <span class="st-t">${escHtml(tag)}</span>
          <span class="st-bar"><i style="width:${Math.max(0, Math.min(100, value))}%;background:${tone.color}"></i></span>
          <span class="st-v" style="color:${tone.color}">${value}</span>
        </div>`;
  }).join('');

  // ── 深层生理亚成分 ──
  const subBlocks = needDepthOn() ? Object.entries(SUBSYSTEM_INFO).map(([k, info]) => {
    const v = Math.round(getSub(k));
    const tone = getValueTone(v, k);
    return `
        <div class="sub">
          <div class="sub-h"><span>${info.emoji}</span>${escHtml(info.name)}</div>
          <div class="sub-v" style="color:${tone.color}">${v}</div>
          <div class="sub-bar"><i style="width:${v}%;background:${tone.color}"></i></div>
        </div>`;
  }).join('') : '';

  // ── 连锁反应 ──
  const cascades = needDepthOn() ? getCascadeWarnings() : [];
  const cascadeBlock = cascades.length
    ? `<div class="alarm"><b>🔗 正在发生的连锁反应 ${cascades.length} 条</b><div class="alarm-list">${
      cascades.map((w) => `<span class="chip chip-warn">${escHtml(getStatusOrSubName(w.from))} → ${escHtml(getStatusOrSubName(w.to))}　<i>${escHtml(w.tip)}</i></span>`).join('')
    }</div></div>`
    : '<div class="calm">🔗 连锁反应：无 —— 各项需求互不拖累</div>';

  // ── 疾病 ──
  const diseaseBlock = currentDiseases.length
    ? currentDiseases.map((dKey) => {
      const d = getDiseaseInfo(dKey);
      if (!d) return '';
      const stage = getDiseaseStage(dKey);
      const patho = getPathogenInfo(dKey);
      const organKey = getDiseaseOrgan(dKey);
      const organ = organKey && ORGAN_INFO[organKey] ? ORGAN_INFO[organKey].name : '';
      const stageColor = stage === '危重' ? '#d93a41' : stage === '晚期' ? '#d9821f' : stage === '中期' ? '#c9971f' : '#5b6b7f';
      return `
        <div class="dis">
          <div class="dis-h">
            <span class="dis-e">${d.emoji}</span>
            <b>${escHtml(d.name)}</b>
            <span class="tag" style="background:${stageColor}1a;color:${stageColor};border-color:${stageColor}44">${escHtml(stage)}</span>
            <span class="tag">${patho.emoji}${escHtml(patho.name)}</span>
            ${isDiagnosed(dKey) ? '<span class="tag tag-ok">已确诊</span>' : '<span class="tag">未确诊</span>'}
            ${organ ? `<span class="tag">受累：${escHtml(organ)}</span>` : ''}
            ${isChronic(dKey) ? '<span class="tag tag-chron">慢性</span>' : ''}
          </div>
          <div class="dis-s">症状：${escHtml(d.symptoms)}</div>
        </div>`;
    }).join('')
    : '<div class="calm">✅ 当前无疾病</div>';

  // ── 器官 ──
  const organBlock = Object.entries(ORGAN_INFO).map(([k, info]) => {
    const v = Math.round(getOrgan(k));
    const tone = getValueTone(v, 'x');
    return `
        <div class="org">
          <div class="org-n">${info.emoji} ${escHtml(info.name)}</div>
          <div class="org-bar"><i style="width:${v}%;background:${tone.color}"></i></div>
          <div class="org-l" style="color:${tone.color}">${escHtml(getOrganLevel(v))} ${v}</div>
        </div>`;
  }).join('');

  // ── 检验指标 ──
  const abn = getAbnormalVitals(cv);
  const abnBlock = abn.length
    ? `<div class="alarm-list">${abn.map((x) => `<span class="chip ${x.severe ? 'chip-bad' : 'chip-warn'}">${x.severe ? '🚨' : '⚠️'} ${escHtml(x.info.name)} ${escHtml(formatVitalValue(x.info, x.value))}${escHtml(x.info.unit)}　<i>${escHtml(x.level)}</i></span>`).join('')}</div>`
    : '<div class="calm">✅ 全部指标正常</div>';
  const keyVitals = [
    ['血压', `${Math.round(num(cv.bpSys))}/${Math.round(num(cv.bpDia))} mmHg`, 'bpSys'],
    ['心率', `${Math.round(num(cv.heartRate))} 次/分`, 'heartRate'],
    ['体温', `${formatVitalValue(getVitalInfo('bodyTemp'), num(cv.bodyTemp, 36.5))} ℃`, 'bodyTemp'],
    ['血糖', `${num(cv.bloodSugar).toFixed(2)} mmol/L`, 'bloodSugar'],
    ['血红蛋白', `${Math.round(num(cv.hemoglobin))} g/L`, 'hemoglobin'],
    ['血氧', `${num(cv.spo2, 98).toFixed(1)} %`, 'spo2']
  ].map(([label, text, key]) => {
    const lv = getVitalLevel(key, num(cv[key], 0));
    const tone = lv === '正常' ? '#1f9d63' : (lv.startsWith('显著') ? '#d93a41' : '#d9821f');
    return `<span class="chip" style="color:${tone};border-color:${tone}44">${escHtml(label)} ${escHtml(text)}</span>`;
  }).join('');

  // v14.0：全量指标按分组展示（36 项，含炎症/免疫/内分泌/凝血/尿液）
  const vitalGroups = {};
  for (const [k, info] of Object.entries(VITAL_INFO)) {
    if (!vitalGroups[info.group]) vitalGroups[info.group] = [];
    const lv = getVitalLevel(k, num(cv[k], 0));
    const tone = lv === '正常' ? '#4a5365' : (lv.startsWith('显著') ? '#d93a41' : '#d9821f');
    const refText = `${formatVitalValue(info, info.range[0])}~${formatVitalValue(info, info.range[1])}`;
    vitalGroups[info.group].push(
      `<span class="vital-chip" style="color:${tone}${lv === '正常' ? '' : `;border-color:${tone}66`}">` +
      `${escHtml(info.emoji)}${escHtml(info.name)} <b>${escHtml(formatVitalValue(info, cv[k]))}</b>${escHtml(info.unit)}` +
      `<i>（参考 ${escHtml(refText)}）</i></span>`
    );
  }
  const vitalGroupHtml = Object.entries(vitalGroups).map(([g, items]) => {
    const gAbn = items.length;
    return `
      <div class="vital-group">
        <div class="vital-gh">🧪 ${escHtml(g)}<i>${gAbn} 项</i></div>
        <div class="vital-items">${items.join('')}</div>
      </div>`;
  }).join('');

  // ── 营养 / 激素 / 习惯 ──
  const nutrientChips = Object.entries(NUTRIENT_INFO).map(([k, n]) => {
    const v = Math.round(getNutrient(k));
    const tone = getValueTone(v, 'x');
    return `<span class="mini"><b style="color:${tone.color}">${v}</b> ${n.emoji}${escHtml(n.name)}</span>`;
  }).join('');
  const hormoneChips = Object.entries(HORMONE_INFO).map(([k, h]) => {
    const v = Math.round(getHormone(k));
    return `<span class="mini"><b>${v}</b> ${h.emoji}${escHtml(h.name)}<i>${escHtml(getHormoneLevel(v))}</i></span>`;
  }).join('');
  const habitChips = Object.entries(HABIT_INFO).map(([k, h]) => {
    const v = Math.round(getHabit(k));
    const strong = v >= 50;
    const tone = h.good ? (strong ? '#1f9d63' : '#8a94a6') : (strong ? '#d93a41' : '#8a94a6');
    return `<span class="mini" style="color:${tone}"><b style="color:${tone}">${v}</b> ${h.emoji}${escHtml(h.name)}</span>`;
  }).join('');

  // ── 心理 / 睡眠 / 外伤 ──
  const sst = SLEEP_STAGES[healthState.sleepStage] || SLEEP_STAGES.awake;
  const injList = Array.isArray(healthState.injuries) ? healthState.injuries : [];
  const injuryText = injList.length
    ? injList.map((i) => `${(INJURY_INFO[i.type] || {}).emoji || '🩹'}${escHtml(i.part)}${escHtml((INJURY_INFO[i.type] || {}).name || '')}`).join('、')
    : `无未愈合伤口（累计受伤 ${Math.round(num(healthState.scarCount))} 次）`;
  const psycText = `😟焦虑 ${Math.round(num(healthState.anxiety))}　🌧️抑郁 ${Math.round(num(healthState.depressionLevel))}　🧘情绪稳定 ${Math.round(num(healthState.stability))}　🎯专注力 ${Math.round(num(healthState.focus))}`;
  const sleepText = `${sst.emoji}${sst.name}　😵睡眠负债 ${Math.round(num(healthState.sleepDebt))}/100　☕咖啡因 ${Math.round(num(healthState.caffeine))}　🕰️生物钟 ${num(healthState.sleepClock) > 0 ? '+' : ''}${num(healthState.sleepClock)}`;

  // ── 生活方式 / 钱包 / 药箱 / 成就 ──
  const life = getLifestyleInfo();
  const lifeText = `🥗饮食 ${life.diet.value}（${life.diet.level}）　🏃运动 ${life.exercise.value}（${life.exercise.level}）　😴睡眠质量 ${life.sleepQuality.value}（${life.sleepQuality.level}）　⚖️BMI ${life.bmi.value}（${life.bmi.level}）`;
  const box = getMedicineBoxSummary();
  const walletText = `💰 钱包 ¥${Math.round(getMoney())}　🛒 生活开销 ¥${Math.round(Number(healthState.livingCost) || 0)}　🏥 ${getHospitalInfo().name}　🎒 药箱：${box.length ? box.map(escHtml).join(' ') : '空'}`;
  const unlockedAch = Object.keys(healthState.achievements || {});
  const achText = `🏆 成就 ${unlockedAch.length}/${Object.keys(ACHIEVEMENTS).length}${unlockedAch.length ? '　' + unlockedAch.slice(0, 6).map((k) => `${(ACHIEVEMENTS[k] || {}).emoji || '🏅'}`).join(' ') : ''}`;
  const age = Math.round(num(healthState.age, 20));

  // ── v8.0：昼夜节律 / 菌群 / 过敏 / 关系网 / 医保 / 生物年龄 / 大事记 ──
  const _nowD = new Date();
  const circ = getCircadianEffects(_nowD.getHours() + _nowD.getMinutes() / 60);
  const sleepWin = getSleepWindow();
  const circOffset = getCircadianOffset();
  const circText = `${circ.phase.emoji}${circ.phase.name}（生理效能 ×${circ.phase.eff}）　⚡精力曲线 ${circ.energy}　👁️警觉度 ${circ.alert}　🧪皮质醇 ${circ.cortisol}　🌙褪黑素 ${circ.melatonin}`;
  const sleepWinText = `😴 建议睡眠窗口 ${sleepWin.startText} - ${sleepWin.endText}${Math.abs(circOffset) >= 0.2 ? `　🕐 相位偏移 ${circOffset > 0 ? '+' : ''}${circOffset.toFixed(1)}h` : ''}`;

  const bio = computeBiologicalAge();
  const bioTone = bio.delta > 3 ? '#d93a41' : bio.delta < -3 ? '#1f9d63' : '#5b6478';
  const bioFactorChips = bio.factors.filter(f => Math.abs(f.delta) >= 0.1).map(f => {
    const tone = f.delta > 0.3 ? '#d93a41' : f.delta < -0.3 ? '#1f9d63' : '#8a94a6';
    const sign = f.delta > 0 ? '+' : '';
    return `<span class="mini"><b style="color:${tone}">${sign}${f.delta}</b> ${f.emoji}${escHtml(f.name)}</span>`;
  }).join('');

  const gutScore = getGutScore();
  const gutBlocks = Object.entries(GUT_FLORA).map(([k, info]) => {
    const v = Math.round(getGut(k));
    const tone = getValueTone(v, 'x');
    return `
        <div class="sub">
          <div class="sub-h"><span>${info.emoji}</span>${escHtml(info.name)}</div>
          <div class="sub-v" style="color:${tone.color}">${v}</div>
          <div class="sub-bar"><i style="width:${v}%;background:${tone.color}"></i></div>
        </div>`;
  }).join('');
  const gutFx = getGutEffects();
  const gutNote = `🤖 综合 ${Math.round(gutScore)}/100（${getGutLevel()}）　📥 营养吸收率 ${Math.round(gutFx.nutrientAbsorb * 100)}%　🌈 血清素基线 ${gutFx.serotoninBase >= 0 ? '+' : ''}${gutFx.serotoninBase.toFixed(1)}　🧱 屏障 ${Math.round(getGut('barrier'))}${gutFx.leakRisk > 0 ? `　⚠️ 肠漏风险 ${gutFx.leakRisk.toFixed(1)}` : ''}`;

  const algLoad = Math.round(num(healthState.allergyLoad, 0));
  const algTone = algLoad >= 68 ? '#d93a41' : algLoad >= 45 ? '#d9821f' : algLoad >= 30 ? '#c9971f' : '#1f9d63';
  const algChips = getAllergenList().map(x => {
    const pos = x.level > 0;
    return `<span class="mini" style="color:${pos ? '#c06a2a' : '#8a94a6'}"><b style="color:${pos ? '#d9821f' : '#8a94a6'}">${pos ? x.level : '—'}</b> ${x.info.emoji}${escHtml(x.info.name)}${pos ? `（${escHtml(x.levelName)}）` : ''}</span>`;
  }).join('');
  const algTrig = Array.isArray(healthState.allergyTriggers) ? healthState.allergyTriggers : [];
  const algNote = (healthState.allergenRolled ? '' : '（未做过过敏原检测，仅知其反应）')
    + (algTrig.length ? `正在刺激身体的：${algTrig.map(t => `${t.emoji}${escHtml(t.name)}`).join('、')}` : '当前无明显环境刺激源');

  const rel = getRelationEffects();
  const relRows = getRelations().slice().sort((a, b) => b.bond.affinity - a.bond.affinity).map(({ bond }) => {
    const t = getRelationType(bond.relation);
    const tm = getValueTone(bond.affinity, 'x');
    return `
        <div class="st">
          <span class="st-e">${t.emoji}</span>
          <span class="st-n">${escHtml(bond.name)}</span>
          <span class="st-t">${escHtml(t.name)}·${escHtml(getRelationLevel(bond.affinity))}</span>
          <span class="st-bar"><i style="width:${Math.max(0, Math.min(100, bond.affinity))}%;background:${tm.color}"></i></span>
          <span class="st-v" style="color:${tm.color}">${Math.round(bond.affinity)}</span>
        </div>`;
  }).join('');
  const relNote = rel.count
    ? `📇 ${rel.count} 人　平均亲密度 ${rel.avgAffinity}　平均亲密感 ${rel.avgIntimacy}　${rel.conflicts >= 3 ? `⚠️ 积怨合计 ${rel.conflicts}` : '无未解积怨'}`
    : '📇 关系网还是空的';

  const insPlan = getInsurancePlan();
  const insText = `${insPlan.info.emoji}${insPlan.info.name}${isInsured() ? `（有效，剩余额度 ¥${getInsuranceRemaining()}，本年已报销 ¥${Math.round(num(healthState.insurance?.usedThisYear, 0))}）` : '（未生效）'}　💸 累计医疗支出 ¥${Math.round(num(healthState.medicalCost, 0))}`;

  const tlRecent = getTimelineRecent(5);
  const tlHtml = tlRecent.length
    ? tlRecent.map(it => `<span class="chip">${it.emoji} ${escHtml(String(it.text || ''))}　<i>${escHtml(localDayKey(it.at))}</i></span>`).join('')
    : '<span class="chip">还没有记录</span>';

  // ── v9.0：爱好与技能树 ──
  const hbList = getHobbies();
  const hbFx = getHobbyEffects();
  const hobbyRows = hbList.map(it => {
    const p = getHobbyProgress(it.rec.xp);
    const tone = getValueTone(it.rec.passion, 'x');
    return `
        <div class="st">
          <span class="st-e">${it.meta.emoji}</span>
          <span class="st-n">${escHtml(it.meta.name)}</span>
          <span class="st-t">Lv${p.level}·${escHtml(p.levelName)}　${escHtml(it.cat.name)}</span>
          <span class="st-bar"><i style="width:${(Math.max(0, Math.min(100, p.pct))).toFixed(1)}%;background:${tone.color}"></i></span>
          <span class="st-v" style="color:${tone.color}">${Math.round(it.rec.passion)}</span>
        </div>`;
  }).join('');
  const hobbyWorks = hbList.reduce((a, x) => a + x.rec.works.length, 0);
  const hobbyMs = hbList.reduce((a, x) => a + Object.keys(x.rec.milestones || {}).length, 0);
  const hobbyNote = hbFx.count
    ? `🎨 ${hbFx.count} 项爱好　总熟练度 ${hbFx.totalLevel}　作品 ${hobbyWorks} 件　里程碑 ${hobbyMs} 个　📈 满足 +${hbFx.satisfaction.toFixed(1)}　😊 心情 +${hbFx.mood.toFixed(1)}　😌 减压 +${hbFx.stress.toFixed(1)}　🛡️ 安全感 +${hbFx.security.toFixed(1)}`
    : '🎨 还没有在练的爱好（可以学一门：吉他/摄影/编程/跑步/烘焙…）';
  const hbStrain = Math.round(num(healthState.hobbyStrain, 0));
  const hbEye = Math.round(num(healthState.hobbyEyeStrain, 0));
  const hbBurn = Math.round(num(healthState.hobbyBurnout, 0));
  const strainTone = (v) => (v >= 60 ? '#d93a41' : v >= 40 ? '#d9821f' : v >= 20 ? '#c9971f' : '#1f9d63');
  const hobbyStrainNote = `🖐️ 上肢劳损 <b style="color:${strainTone(hbStrain)}">${hbStrain}</b>　👁️ 视疲劳 <b style="color:${strainTone(hbEye)}">${hbEye}</b>　🥵 兴趣耗竭 <b style="color:${strainTone(hbBurn)}">${hbBurn}</b>`
    + (Math.max(hbStrain, hbEye, hbBurn) >= 60 ? '　⚠️ 练得太狠了，该歇歇' : '');

  // ── v10.0：宠物养成 ──
  const petList = getPets();
  const petFx = getPetEffects();
  const petRows = petList.map(p => {
    const sp = PET_SPECIES[p.species];
    const st = getPetStage(p);
    const needs = getPetNeeds(p);
    const tone = getValueTone(p.bond, 'x');
    const life = Math.max(0, Math.min(100, getPetLifeRatio(p) * 100));
    const sickMark = p.diseases.length ? '　🤒' : '';
    return `
        <div class="st">
          <span class="st-e">${sp.emoji}</span>
          <span class="st-n">${escHtml(p.name)}</span>
          <span class="st-t">${escHtml(sp.name)}·${st.emoji}${escHtml(st.name)}　${PET_NEEDS.satiety.emoji}${Math.round(needs.satiety)} ${PET_NEEDS.hydration.emoji}${Math.round(needs.hydration)} ${PET_NEEDS.hygiene.emoji}${Math.round(needs.hygiene)} ${PET_NEEDS.spirit.emoji}${Math.round(needs.spirit)}${sickMark}</span>
          <span class="st-bar"><i style="width:${life.toFixed(1)}%;background:${tone.color}"></i></span>
          <span class="st-v" style="color:${tone.color}">${Math.round(p.bond)}</span>
        </div>`;
  }).join('');
  const petNote = petList.length
    ? `🐾 ${petList.length} 只宠物　平均亲密度 ${petFx.avgBond}　累计开销 ¥${petFx.cost}　💗归属 +${petFx.belonging.toFixed(1)}　😊心情 +${petFx.mood.toFixed(1)}　😌减压 +${petFx.stress.toFixed(1)}`
    : `🐾 还没有养宠物（可以领养：猫/狗/仓鼠/兔子/鹦鹉/金鱼/乌龟/蜥蜴/刺猬/龙猫）${petFx.memorial ? `　🕯️ 曾养过 ${petFx.memorial} 只` : ''}`;
  const petNotes = [];
  if (petFx.shed > 0) petNotes.push(`掉毛/皮屑指数 <b>${petFx.shed.toFixed(1)}</b>（推高过敏负荷）`);
  if (petFx.nightNoise > 0) petNotes.push(`夜间吵闹 <b>${petFx.nightNoise.toFixed(1)}</b>（影响睡眠）`);
  if (petFx.sick > 0) petNotes.push(`<b style="color:#d93a41">${petFx.sick} 只生病</b>（该看兽医了）`);
  if (petFx.memorial > 0) petNotes.push(`🕯️ 已离世 ${petFx.memorial} 只`);
  const petExtra = petNotes.join('　');

  // —— v11.0：日常生活（穿衣 / 三餐 / 居家 / 账单）——
  const wearR = getWornOutfit();
  const wearFeel = getFeelLevel();
  const wearUv = getUvRisk();
  const wearWet = Math.round(getOutfitRec().wet);
  const sunExp = Math.round(Number(healthState.sunExposure) || 0);
  // 行首不再放 🧥 —— 衣物自带 emoji，再放一次会出现「🧥 🧥薄外套」这种重复
  const outfitLine = outfitOn()
    ? `<b>${wearR.info.emoji}${escHtml(wearR.info.name)}</b>（${escHtml(wearR.style.name)}风格）　外面 <b>${wearFeel.temp}℃</b>　${escHtml(wearFeel.name)}${wearWet > 25 ? `　💧 淋湿 ${wearWet}` : ''}`
    : '🧥 穿衣系统已关闭';
  const uvNote = wearUv.uv >= 6
    ? `☀️ 紫外线 <b>${wearUv.uv}</b>${wearUv.guarded ? '（已防晒）' : '　<b style="color:#d93a41">没防晒！</b>'}`
    : `☀️ 紫外线 ${wearUv.uv}`;
  const todayMeals = getMealLog();
  const mealNames = todayMeals.map(x => (MEALS[x.key] ? MEALS[x.key].name : x.key));
  const mealLine = mealOn()
    ? `🍜 今日吃了 <b>${todayMeals.length}</b> 顿${mealNames.length ? `：${escHtml(mealNames.join('、'))}` : ''}`
    : '🍜 三餐选择已关闭';
  const foodRiskVal = Math.round(Number(healthState.foodRisk) || 0);
  const homeR = getHomeRec();
  const homeLvl = getHomeLevel();
  const homeLine = homeOn()
    ? `🏠 <b>${homeLvl.emoji}${escHtml(homeLvl.name)}</b>（整洁 ${Math.round(homeR.tidy)}）　👕 衣物洁净 ${Math.round(homeR.laundry)}　🍽️ 待洗碗 ${homeR.dishes}`
    : '🏠 居家系统已关闭';
  const homeNotes = [];
  if (homeOn()) {
    if (homeR.tidy < 45) homeNotes.push(`房间乱 → 尘螨负荷 <b>×${getMiteFactor()}</b>`);
    if (homeR.miteRelief > 40) homeNotes.push('被子刚晒过，螨虫被杀了不少');
    if (homeR.petDirt > 20) homeNotes.push(`宠物弄脏累积 <b>${Math.round(homeR.petDirt)}</b>`);
  }
  const homeExtra = homeNotes.join('　');
  const billR = getBillsRec();
  const billLine = billsOn()
    ? `💸 月支出 <b>¥${getBillTotal()}</b>　距下次扣款 ${getDaysToBill()} 天　生活开销累计 ¥${Math.round(Number(healthState.livingCost) || 0)}`
    : '💸 账单系统已关闭';
  const billNote = billR.unpaid > 0
    ? `<b style="color:#d93a41">❗ 欠费 ¥${billR.unpaid}</b>（逾期 ${billR.overdue} 期）——压力与安全感正在被磨`
    : '🧾 账是清的';

  // —— v12.0：钱币系统（发薪 / 接单 / 账本）——
  const salRec = getWalletRec();
  const salDays = getDaysToPay();
  const salaryLine = salaryOn()
    ? `💼 月薪 <b>¥${getMonthlySalary()}</b>　${salRec.payCount > 0 ? `已发 ${salRec.payCount} 次（共 ¥${salRec.totalSalary}）` : '第一笔还没到'}　距下次发薪 ${salDays} 天`
    : '💼 发薪系统已关闭';
  const gigRecR = getGigRec();
  const readyGigs = (gigOn() && hobbyOn()) ? getReadyGigs() : [];
  const gigCdLeft = getGigCooldownLeftMs();
  const gigLine = (gigOn() && hobbyOn())
    ? `🧾 能接单的手艺 <b>${readyGigs.length}</b> 门${readyGigs.length ? `（${readyGigs.slice(0, 3).map(x => escHtml(`${x.meta.name} ${x.level}级`)).join('、')}）` : '（还没练到 2 级）'}　累计接单 ${gigRecR.count} 单 · ¥${gigRecR.total}`
    : '🧾 接单系统已关闭';
  const gigNote = (readyGigs.length && gigCdLeft <= 0)
    ? `「${readyGigs[0].meta.name}」现在能接，一单约 ¥${estimateGigPay(readyGigs[0].key)}`
    : gigCdLeft > 0 ? `刚交完一单，还要 ${Math.ceil(gigCdLeft / 3600000)} 小时缓过来` : '';
  const ls = getLedgerSummary();
  const sgn = (v) => (v >= 0 ? '+' : '');
  const netTone = (v) => (v >= 0 ? '#1f9d63' : '#d93a41');
  const ledgerLine = ledgerOn()
    ? `📒 ${ls.monthKey} 本月：收入 <b>¥${ls.monthIn}</b>　支出 <b>¥${ls.monthOut}</b>　净 <b style="color:${netTone(ls.net)}">${sgn(ls.net)}¥${ls.net}</b>`
    : '📒 账本已关闭';
  const ledgerNote = ledgerOn()
    ? `累计 收入 ¥${ls.totalIn}　支出 ¥${ls.totalOut}　净 <b style="color:${netTone(ls.totalNet)}">${sgn(ls.totalNet)}¥${ls.totalNet}</b>`
    : '';
  const ledInRows = ls.inBreak.rows.map(r => `<span class="mini"><b>¥${r.amount}</b> ${r.info.emoji}${escHtml(r.info.name)}</span>`).join('');
  const ledOutRows = ls.outBreak.rows.map(r => `<span class="mini"><b>¥${r.amount}</b> ${r.info.emoji}${escHtml(r.info.name)}</span>`).join('');
  const ledFlow = getLedgerFlow(6).map(it => {
    const info = getLedgerCat(it.cat);
    const t = new Date(Number(it.at) || 0);
    const p2 = (n) => String(n).padStart(2, '0');
    const stamp = `${p2(t.getMonth() + 1)}-${p2(t.getDate())} ${p2(t.getHours())}:${p2(t.getMinutes())}`;
    return `<span class="chip">${it.kind === 'in' ? '📈' : '📉'} ${info.emoji}${escHtml(info.name)}　<b style="color:${it.kind === 'in' ? '#1f9d63' : '#d93a41'}">${it.kind === 'in' ? '+' : '-'}¥${it.amount}</b>${it.note ? ` ${escHtml(String(it.note))}` : ''}　<i>${stamp}</i></span>`;
  }).join('');

  // —— v13.0：时间与社会（星期 / 节日 / 极端天气 / 缓解期）——
  const tBrief = getTodayBrief();
  const tStats = getTimeStats();
  const xStats = getExtremeStats();
  const wd = tBrief.weekday;
  const dayChips = [`<span class="chip">${wd.emoji} ${escHtml(wd.name)}${wd.weekend ? ' · 休息日' : ' · 工作日'}</span>`];
  if (tBrief.festival) {
    dayChips.push(`<span class="chip">${tBrief.festival.emoji} ${escHtml(tBrief.festival.name)}　<i>${escHtml(tBrief.festival.bid)}</i></span>`);
  }
  if (tBrief.extreme) {
    dayChips.push(`<span class="chip">${tBrief.extreme.emoji} <b>${escHtml(tBrief.extreme.name)}</b>　<i>${escHtml(tBrief.extreme.desc)}</i></span>`);
  }
  const wxLine = `🌤️ ${escHtml(tBrief.weather.name)}　${tBrief.weather.emoji}　气温 <b>${(healthState.env || {}).tempC}℃</b>　湿度 ${(healthState.env || {}).humidity}%　AQI ${(healthState.env || {}).aqi}　紫外线 ${(healthState.env || {}).uv}`;
  const priceMul = getFestivalPriceMul();
  const priceNote = priceMul !== 1
    ? `　节日物价 <b>×${priceMul}</b>（三餐花费${priceMul > 1 ? '偏高' : '打折'}）`
    : '';
  const remList = tBrief.remissions;
  const remLine = remList.length
    ? `♻️ 缓解期中：${remList.map(r => `<b>${escHtml(r.name)}</b>（还剩 ${r.remainDays} 天）`).join('、')}`
    : '';
  const ctrlEntries = Object.entries(healthState.chronicControl || {})
    .filter(([k, v]) => getDiseaseInfo(k) && Number(v) > 0);
  const ctrlLine = ctrlEntries.length
    ? `♻️ 控制进度：${ctrlEntries.map(([k, v]) => {
        const info = getDiseaseInfo(k);
        return `${escHtml(info.name)} <b>${Math.floor(Number(v))}/${CHRONIC_CONTROL_NEED}</b>`;
      }).join('　')}`
    : '';
  const timeStatLine = `📊 累计：周末 <b>${tStats.weekendDays}</b> 天　节日 <b>${tStats.festivalDays}</b> 天　生日 <b>${tStats.birthdays}</b> 次　极端天气 <b>${xStats.count}</b> 次`
    + (xStats.count > 0 ? `（${Object.entries(xStats.byKey).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 4)
        .map(([k, v]) => { const i = getExtremeInfo(k); return i ? `${i.emoji}${escHtml(i.name)}×${v}` : ''; })
        .filter(Boolean).join('　')}）` : '');
  const todayCard = (weekdayOn() || festivalOn())
    ? `<div class="card">
    <div class="sec-t">🗓️ 今天</div>
    <div class="lines" style="margin-bottom:9px">${dayChips.join('')}</div>
    <div class="lines">${wxLine}${priceNote}</div>
    ${remLine ? `<div class="lines" style="margin-top:8px">${remLine}</div>` : ''}
    ${ctrlLine ? `<div class="lines" style="margin-top:6px">${ctrlLine}</div>` : ''}
    <div class="lines" style="margin-top:9px;color:#6b7280">${timeStatLine}</div>
  </div>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>健康状态报告</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  body {
    width:${getReportImageWidth()}px;
    font-family:"Microsoft YaHei","PingFang SC","Hiragino Sans GB","Segoe UI",system-ui,sans-serif;
    background:#eef1f7; color:#1f2430; padding:18px;
    -webkit-font-smoothing:antialiased;
  }
  .card { background:#fff; border-radius:14px; padding:16px 18px; margin-bottom:12px;
          box-shadow:0 1px 3px rgba(24,39,75,.07), 0 6px 18px rgba(24,39,75,.05); }
  .hd { background:linear-gradient(120deg,#2f6fed 0%,#5b8cf7 55%,#7aa8ff 100%); color:#fff; border-radius:16px;
        padding:20px 22px; margin-bottom:12px; display:flex; justify-content:space-between; align-items:center; }
  .hd h1 { font-size:26px; font-weight:700; letter-spacing:.5px; }
  .hd-sub { font-size:13px; opacity:.92; margin-top:7px; line-height:1.6; }
  .hd .badge { text-align:right; font-size:13px; opacity:.95; line-height:1.7; }
  .hd .badge b { display:block; font-size:22px; font-weight:700; }
  .kpis { display:grid; grid-template-columns:repeat(4,1fr); gap:12px; margin-bottom:12px; }
  .kpi { background:#fff; border-radius:14px; padding:14px 16px; box-shadow:0 1px 3px rgba(24,39,75,.07); }
  .kpi-l { font-size:12px; color:#8a94a6; }
  .kpi-v { font-size:30px; font-weight:700; line-height:1.25; margin-top:2px; }
  .kpi-u { font-size:13px; font-weight:400; color:#8a94a6; margin-left:2px; }
  .kpi-s { font-size:12px; color:#6b7280; margin-top:2px; }
  .sec-t { font-size:15px; font-weight:700; margin-bottom:12px; display:flex; align-items:center; gap:7px; }
  .sec-t::before { content:""; width:4px; height:15px; border-radius:2px; background:#2f6fed; }
  .sts { display:grid; grid-template-columns:1fr 1fr; gap:7px 22px; }
  .st { display:grid; grid-template-columns:20px 62px 92px 1fr 34px; align-items:center; gap:6px; font-size:13px; }
  .st-e { font-size:14px; }
  .st-n { color:#3c4457; }
  .st-t { font-size:11.5px; color:#8a94a6; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
  .st-badhigh .st-t { color:#c06a2a; }
  .st-bar { height:8px; background:#eceff5; border-radius:5px; overflow:hidden; }
  .st-bar i { display:block; height:100%; border-radius:5px; }
  .st-v { text-align:right; font-weight:700; font-size:13px; }
  .subs { display:grid; grid-template-columns:repeat(6,1fr); gap:10px; }
  .sub { background:#f7f9fd; border-radius:10px; padding:10px; }
  .sub-h { font-size:12px; color:#5b6478; display:flex; align-items:center; gap:4px; }
  .sub-v { font-size:22px; font-weight:700; margin:3px 0 5px; }
  .sub-bar { height:6px; background:#e4e9f2; border-radius:4px; overflow:hidden; }
  .sub-bar i { display:block; height:100%; border-radius:4px; }
  .alarm { background:#fff7f0; border:1px solid #ffd9b8; border-radius:12px; padding:12px 14px; }
  .alarm b { font-size:13px; color:#a3541a; }
  .alarm-list { display:flex; flex-wrap:wrap; gap:7px; margin-top:9px; }
  .calm { color:#1f9d63; font-size:13px; background:#f2fbf6; border-radius:10px; padding:10px 14px; }
  .chip { font-size:12px; padding:4px 9px; border-radius:999px; background:#f5f7fb;
          border:1px solid #e2e7f0; color:#4a5365; display:inline-block; }
  .chip i { font-style:normal; color:#8a94a6; }
  .chip-warn { background:#fff8f1; border-color:#ffdcbb; color:#a3541a; }
  .chip-bad { background:#fff2f2; border-color:#ffc9cb; color:#b3282e; }
  .dis { border:1px solid #e8ecf4; border-radius:12px; padding:11px 13px; margin-bottom:9px; background:#fcfdff; }
  .dis-h { display:flex; align-items:center; gap:8px; flex-wrap:wrap; font-size:14px; }
  .dis-e { font-size:16px; }
  .dis-s { font-size:12.5px; color:#6b7280; margin-top:6px; line-height:1.55; }
  .tag { font-size:11.5px; padding:2px 8px; border-radius:999px; background:#eef2f9;
         color:#5b6478; border:1px solid #e2e7f0; }
  .tag-ok { background:#eefaf3; color:#1f9d63; border-color:#c9efdb; }
  .tag-chron { background:#f6f1ff; color:#7550c9; border-color:#e2d8fb; }
  .orgs { display:grid; grid-template-columns:repeat(4,1fr); gap:10px; }
  .org { background:#f7f9fd; border-radius:10px; padding:9px 11px; }
  .org-n { font-size:12.5px; color:#3c4457; }
  .org-bar { height:6px; background:#e4e9f2; border-radius:4px; overflow:hidden; margin:6px 0 5px; }
  .org-bar i { display:block; height:100%; border-radius:4px; }
  .org-l { font-size:11.5px; font-weight:600; }
  .minis { display:flex; flex-wrap:wrap; gap:7px; }
  .mini { font-size:12px; background:#f5f7fb; border:1px solid #e6ebf4; border-radius:8px;
          padding:4px 9px; color:#4a5365; }
  .mini b { font-weight:700; margin-right:3px; }
  .mini i { font-style:normal; color:#8a94a6; margin-left:4px; }
  .lines { font-size:12.5px; color:#4a5365; line-height:2; }
  .vital-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; margin-top:11px; }
  .vital-group { background:#f7f9fd; border-radius:10px; padding:10px 11px; }
  .vital-gh { font-size:12px; color:#5b6478; font-weight:700; margin-bottom:7px; display:flex; align-items:center; gap:5px; }
  .vital-gh i { font-style:normal; font-weight:400; color:#9aa3b2; margin-left:auto; }
  .vital-items { display:flex; flex-wrap:wrap; gap:5px; }
  .vital-chip { font-size:11.5px; padding:3px 8px; border-radius:8px; background:#fff;
                border:1px solid #e2e7f0; color:#4a5365; display:inline-block; }
  .vital-chip b { margin:0 2px; font-weight:700; }
  .vital-chip i { font-style:normal; color:#8a94a6; }
  .ft { text-align:center; font-size:11.5px; color:#9aa3b2; padding:6px 0 2px; }
</style></head>
<body>
  <div class="hd">
    <div>
      <h1>🩺 健康状态报告</h1>
      <div class="hd-sub">${escHtml(stamp)}　·　🎂 ${age} 岁　·　${constitutionInfo.emoji}${escHtml(constitutionInfo.name)}　·　${escHtml(envText)}</div>
    </div>
    <div class="badge">
      <b>${healthVal} / 100</b>
      ${escHtml(getStatusLevel(healthVal, 'health'))}
    </div>
  </div>

  <div class="kpis">${kpis}</div>

  <div class="card">
    <div class="sec-t">🕰️ 昼夜节律 &amp; 🧬 生物年龄</div>
    <div class="lines" style="line-height:1.95">${escHtml(circText)}<br>${escHtml(sleepWinText)}</div>
    <div style="display:flex;align-items:baseline;gap:10px;margin:12px 0 9px;flex-wrap:wrap">
      <span style="font-size:13px;color:#8a94a6">实际 ${bio.real} 岁 → 生理年龄</span>
      <b style="font-size:27px;color:${bioTone}">${bio.bio}</b>
      <span style="font-size:13px;color:${bioTone};font-weight:600">${bio.delta >= 0 ? '+' : ''}${bio.delta} 岁 · ${escHtml(getBioAgeLevel(bio.delta))}</span>
    </div>
    <div class="minis">${bioFactorChips}</div>
  </div>

  <div class="card">
    <div class="sec-t">📊 状态总览（24 项）</div>
    <div class="sts">${statusRows}</div>
  </div>
${needDepthOn() ? `
  <div class="card">
    <div class="sec-t">🌊 深层生理</div>
    <div class="subs">${subBlocks}</div>
  </div>` : ''}
  <div class="card">
    <div class="sec-t">🔗 连锁反应</div>
    ${cascadeBlock}
  </div>

  <div class="card">
    <div class="sec-t">🤒 当前疾病（${currentDiseases.length}）</div>
    ${diseaseBlock}
  </div>

  <div class="card">
    <div class="sec-t">🫀 器官健康</div>
    <div class="orgs">${organBlock}</div>
  </div>

  <div class="card">
    <div class="sec-t">🩸 检验指标（综合评分 ${vitalScore}/100）</div>
    <div class="alarm-list" style="margin-bottom:10px">${keyVitals}</div>
    ${abnBlock}
    <div class="vital-grid">${vitalGroupHtml}</div>
  </div>

  <div class="card">
    <div class="sec-t">🥗 营养摄入</div>
    <div class="minis">${nutrientChips}</div>
  </div>

  <div class="card">
    <div class="sec-t">🔬 内分泌 / 🚬 习惯</div>
    <div class="minis" style="margin-bottom:10px">${hormoneChips}</div>
    <div class="minis">${habitChips}</div>
  </div>

  <div class="card">
    <div class="sec-t">🧠 心理与睡眠</div>
    <div class="lines">${escHtml(psycText)}<br>${escHtml(sleepText)}<br>🩹 外伤：${escHtml(injuryText)}</div>
  </div>

  <div class="card">
    <div class="sec-t">🦠 肠道菌群</div>
    <div class="subs">${gutBlocks}</div>
    <div class="lines" style="margin-top:11px">${escHtml(gutNote)}</div>
  </div>

  <div class="card">
    <div class="sec-t">🤧 过敏</div>
    <div class="minis" style="margin-bottom:10px">${algChips}</div>
    <div class="lines">负荷 <b style="color:${algTone}">${algLoad}</b>/100（${escHtml(getAllergyLevelName(algLoad))}）　${escHtml(algNote)}</div>
  </div>

  <div class="card">
    <div class="sec-t">📇 社交关系网</div>
    <div class="lines" style="margin-bottom:10px">${escHtml(relNote)}</div>
    ${relRows ? `<div class="sts">${relRows}</div>` : ''}
  </div>

  <div class="card">
    <div class="sec-t">🧾 医保 &amp; 📜 健康大事记</div>
    <div class="lines" style="margin-bottom:10px">${insText}</div>
    <div class="alarm-list">${tlHtml}</div>
  </div>

  <div class="card">
    <div class="sec-t">🎨 爱好与技能树（${hbList.length}/${getHobbyMaxSlots()} 槽位）</div>
    <div class="lines" style="margin-bottom:10px">${escHtml(hobbyNote)}</div>
    ${hobbyRows ? `<div class="sts">${hobbyRows}</div>` : ''}
    <div class="lines" style="margin-top:11px">${hobbyStrainNote}</div>
  </div>

  <div class="card">
    <div class="sec-t">${petList.length > getPetMaxCount()
      ? `🐾 宠物（${petList.length} 只 · 已超出上限 ${getPetMaxCount()}）`
      : `🐾 宠物（${petList.length}/${getPetMaxCount()}）`}</div>
    <div class="lines" style="margin-bottom:10px">${escHtml(petNote)}</div>
    ${petRows ? `<div class="sts">${petRows}</div>` : ''}
    ${petExtra ? `<div class="lines" style="margin-top:11px">${petExtra}</div>` : ''}
  </div>

  ${todayCard}

  <div class="card">
    <div class="sec-t">🧥 日常生活</div>
    <div class="lines">${outfitLine}<br>${uvNote}${sunExp > 0 ? `　日晒累积 <b>${sunExp}</b>` : ''}</div>
    <div class="lines" style="margin-top:8px">${mealLine}${foodRiskVal > 30 ? `　⚠️ 吃得不太干净（风险 ${foodRiskVal}）` : ''}</div>
    <div class="lines" style="margin-top:8px">${homeLine}</div>
    ${homeExtra ? `<div class="lines" style="margin-top:6px">${homeExtra}</div>` : ''}
    <div class="lines" style="margin-top:8px">${billLine}<br>${billNote}</div>
  </div>

  <div class="card">
    <div class="sec-t">💰 收支与进项</div>
    <div class="lines">${salaryLine}</div>
    <div class="lines" style="margin-top:8px">${gigLine}${gigNote ? `　<span style="color:#8a94a6">${escHtml(gigNote)}</span>` : ''}</div>
    <div class="lines" style="margin-top:11px">${ledgerLine}</div>
    ${ledgerNote ? `<div class="lines" style="margin-top:6px">${ledgerNote}</div>` : ''}
    ${ledInRows ? `<div class="lines" style="margin-top:9px">来路　${ledInRows}</div>` : ''}
    ${ledOutRows ? `<div class="lines" style="margin-top:6px">去向　${ledOutRows}</div>` : ''}
    ${ledFlow ? `<div class="alarm-list" style="margin-top:11px">${ledFlow}</div>` : ''}
  </div>

  <div class="card">
    <div class="sec-t">🌱 生活与资源</div>
    <div class="lines">${escHtml(lifeText)}<br>${walletText}<br>${achText}</div>
  </div>

  <div class="ft">健康系统 Pro v14.0　·　由 QQ Agent 插件自动生成</div>
</body></html>`;

  return html;
}

// ── ② HTML → PNG（Electron 离屏渲染，零三方依赖）────────────────────────────
let electronModule; // undefined=未探测 / false=当前环境没有 electron / object=已拿到

async function getElectronModule() {
  if (electronModule !== undefined) return electronModule;
  electronModule = false;
  const usable = (m) => Boolean(m && typeof m === 'object' && m.BrowserWindow);

  // 路径 1：动态 import('electron')。
  //   宿主 electron/main.js 用的就是 ESM 的 `import { app } from 'electron'`，
  //   所以在正常启动的 Electron 主进程里，这是与宿主同源、最直接的方式。
  try {
    const m = await import('electron');
    if (usable(m)) { electronModule = m; return electronModule; }
    if (usable(m && m.default)) { electronModule = m.default; return electronModule; }
  } catch (error) {
    log(`[健康系统] import('electron') 不可用：${error.message}`);
  }

  // 路径 2：createRequire 兜底。ESM 里取 CJS 内置模块的稳妥写法，
  //   在个别打包形态下 import 会拿不到导出，但 require 能拿到。
  try {
    const { createRequire } = await import('module');
    const req = createRequire(import.meta.url);
    const m = req('electron');
    if (usable(m)) { electronModule = m; return electronModule; }
    if (usable(m && m.default)) { electronModule = m.default; return electronModule; }
  } catch (error) {
    log(`[健康系统] require('electron') 不可用：${error.message}`);
  }

  log('[健康系统] 未检测到 Electron 渲染环境，图片报表不可用（将自动回退文字报告）');
  return electronModule;
}

// 渲染互斥锁：同一时刻只允许一个报表窗口，避免连续 /健康 时窗口互相干扰
let reportRenderBusy = false;

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms);
    Promise.resolve(promise).then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

// 单次截图尝试。
//   mode='normal'    普通隐藏窗口 —— 走 Chromium 常规绘制路径，兼容性最好
//   mode='offscreen' 离屏渲染 —— 不受窗口可见性影响，但依赖另一种合成路径
async function captureReportWith(electron, mode, htmlFile, width) {
  const win = new electron.BrowserWindow({
    width,
    height: 1400,
    show: false,
    webPreferences: {
      offscreen: mode === 'offscreen',
      // 隐藏窗口默认会被 Chromium 按"后台标签"限流，绘制可能永远不发生
      backgroundThrottling: false,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      images: true
    }
  });

  try {
    await withTimeout(win.loadFile(htmlFile), 20000, '页面加载超时');

    // 等两帧 + 一小段延时：中文字体与 emoji 回退字体是在首帧之后才替换的，
    // 布局高度会跟着变。不等的话量到的是替换前的高度，截图底部会被裁掉。
    await win.webContents.executeJavaScript(
      'new Promise((r)=>{requestAnimationFrame(()=>requestAnimationFrame(()=>setTimeout(r,80)))});'
    ).catch(() => { /* 量不到高度也无妨，下面有兜底值 */ });

    let contentHeight = 1400;
    try {
      const h = await win.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight || 0);');
      if (Number.isFinite(Number(h)) && Number(h) > 0) contentHeight = Number(h);
    } catch { /* 用默认高度 */ }
    const height = Math.max(200, Math.min(8000, Math.round(contentHeight) + 2));

    // 把窗口调整到内容真实高度：canvas 尺寸就是内容尺寸，这样底部不留白
    win.setContentSize(width, height);
    await new Promise((r) => setTimeout(r, 130));

    let image = await win.webContents.capturePage();
    if (!image || image.isEmpty()) {
      // 隐藏窗口偶尔出现"合成尚未就绪 → 抓到空图"：让窗口真正上屏一帧再抓。
      // showInactive 不抢焦点，且只停留约 200ms，用户基本无感。
      try { win.showInactive(); } catch { /* 忽略 */ }
      await new Promise((r) => setTimeout(r, 220));
      image = await win.webContents.capturePage();
      try { win.hide(); } catch { /* 忽略 */ }
    }
    if (!image || image.isEmpty()) throw new Error(`${mode} 模式截图返回空图`);

    const png = image.toPNG();
    if (!png || !png.length) throw new Error('PNG 编码失败');
    const size = image.getSize();
    return { png, width: size.width, height: size.height, mode };
  } finally {
    try { win.destroy(); } catch { /* 已销毁 */ }
  }
}

// 渲染 HTML → PNG。两条路径交叉重试，因为宿主 electron/main.js 里对 Chromium
// 做了强限制（disableHardwareAcceleration + --disable-gpu + --disable-software-rasterizer
// + --no-sandbox，见宿主源码 R44/R70 两段注释）：在这种"没有 GPU 也没有软件光栅化"
// 的环境里，任何单一截图路径都有偶发抓空的可能，所以两种都试一遍再放弃。
async function renderHtmlToPng(html, opts = {}) {
  const electron = await getElectronModule();
  if (!electron) throw new Error('当前环境不支持图片渲染');
  if (reportRenderBusy) throw new Error('已有一次报表渲染在进行中');

  const fs = await import('fs');
  const width = Math.max(480, Math.min(1600, Math.round(Number(opts.width) || getReportImageWidth())));
  const dir = getReportImageDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  const tmpHtml = path.join(dir, `report-src-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.html`);
  fs.writeFileSync(tmpHtml, html, 'utf8');

  reportRenderBusy = true;
  let lastError = null;
  try {
    for (const mode of ['normal', 'offscreen']) {
      try {
        return await captureReportWith(electron, mode, tmpHtml, width);
      } catch (error) {
        lastError = error;
        log(`[健康系统] 报表渲染（${mode}）失败：${error.message}`);
        await new Promise((r) => setTimeout(r, 120));
      }
    }
    throw lastError || new Error('渲染失败');
  } finally {
    reportRenderBusy = false;
    try { fs.unlinkSync(tmpHtml); } catch { /* 已被清理 */ }
  }
}

// ── ③ 生成 + 发送 ──────────────────────────────────────────────────────────
async function sendHealthReportImage(ctx, opts = {}) {
  if (!ctx || !ctx.sender || !ctx.chatKey) throw new Error('当前会话不支持发送图片');
  if (typeof ctx.sender.sendImage !== 'function') throw new Error('发送通道不支持图片');

  const fs = await import('fs');
  const t0 = Date.now();
  const html = buildReportHtml(opts);
  const { png, width, height } = await renderHtmlToPng(html, { width: getReportImageWidth() });

  const dir = getReportImageDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* 已存在 */ }
  const file = path.join(dir, `health-report-${Date.now()}.png`);
  fs.writeFileSync(file, png);

  // file 优先（协议端自己读盘，HTTP body 只有约 100 字节）；
  // dataUrl 作为回退（协议端在别的机器 / 读不到本机路径时用）。
  const payload = { file };
  if (png.length <= 12 * 1024 * 1024) payload.dataUrl = `base64://${png.toString('base64')}`;

  await ctx.sender.sendImage(ctx.chatKey, payload, { note: '健康报告' });

  // 清理旧图（保留刚才这张）
  try {
    const olds = fs.readdirSync(dir)
      .filter((f) => f.startsWith('health-report-') && f.endsWith('.png'))
      .sort();
    for (const f of olds.slice(0, Math.max(0, olds.length - 2))) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* 占用中就算了 */ }
    }
  } catch { /* 清理失败不影响主流程 */ }

  return { file, width, height, bytes: png.length, ms: Date.now() - t0 };
}

// 从文件加载持久化状态
async function loadFromFile() {
  const fs = await import('fs');
  const legacyFile = path.join(__dirname, 'health-data.json');

  try {
    if (storage?.readJson) {
      let data = storage.readJson('health-data.json', null);
      if (!data && fs.existsSync(legacyFile)) {
        data = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
        storage.writeJson('health-data.json', data);
        log('[健康系统] 已把旧 health-data.json 迁移到插件数据目录（旧文件保留作备份）');
      }
      return data ? { ...healthState, ...data } : null;
    }
    if (fs.existsSync(legacyFile)) {
      const data = JSON.parse(fs.readFileSync(legacyFile, 'utf8'));
      return { ...healthState, ...data };
    }
  } catch (error) {
    log(`[健康系统] 从文件加载失败：${error.message}`);
  }

  return null;
}

// 清洗健康状态：规范化数值、过滤无效疾病、防止 NaN/字符串/越界
function sanitizeHealthState() {
  for (const key of Object.keys(STATUSES)) {
    const v = Number(healthState[key]);
    healthState[key] = Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 80;
  }
  // 过滤无效疾病键（旧数据/篡改可能带未知键）
  if (Array.isArray(healthState.diseases)) {
    healthState.diseases = healthState.diseases.filter(k => getDiseaseInfo(k));
  }
  // 新增字段兜底（旧数据/篡改）
  if (!healthState.diseaseHistory || typeof healthState.diseaseHistory !== 'object' || Array.isArray(healthState.diseaseHistory)) healthState.diseaseHistory = {};
  if (!healthState.remissions || typeof healthState.remissions !== 'object' || Array.isArray(healthState.remissions)) healthState.remissions = {};
  // v13.0 时间与社会 兜底（老存档没有这些字段）
  if (!healthState.timeStats || typeof healthState.timeStats !== 'object' || Array.isArray(healthState.timeStats)) {
    healthState.timeStats = { weekendDays: 0, festivalDays: 0, birthdays: 0, extremeDays: 0 };
  }
  for (const tk of ['weekendDays', 'festivalDays', 'birthdays', 'extremeDays']) {
    const tv = Number(healthState.timeStats[tk]);
    healthState.timeStats[tk] = Number.isFinite(tv) ? Math.max(0, Math.round(tv)) : 0;
  }
  if (typeof healthState.lastFestivalKey !== 'string') healthState.lastFestivalKey = '';
  if (typeof healthState.lastWeekendDay !== 'string') healthState.lastWeekendDay = '';
  if (typeof healthState.lastExtremeDay !== 'string') healthState.lastExtremeDay = '';
  if (!healthState.extremeStats || typeof healthState.extremeStats !== 'object' || Array.isArray(healthState.extremeStats)) {
    healthState.extremeStats = { count: 0, byKey: {}, lastKey: '' };
  }
  const xCount = Number(healthState.extremeStats.count);
  healthState.extremeStats.count = Number.isFinite(xCount) ? Math.max(0, Math.round(xCount)) : 0;
  if (!healthState.extremeStats.byKey || typeof healthState.extremeStats.byKey !== 'object' || Array.isArray(healthState.extremeStats.byKey)) healthState.extremeStats.byKey = {};
  for (const xk of Object.keys(healthState.extremeStats.byKey)) {
    if (!EXTREME_WEATHER[xk]) { delete healthState.extremeStats.byKey[xk]; continue; }
    const xv = Number(healthState.extremeStats.byKey[xk]);
    healthState.extremeStats.byKey[xk] = Number.isFinite(xv) ? Math.max(0, Math.round(xv)) : 0;
  }
  if (typeof healthState.extremeStats.lastKey !== 'string') healthState.extremeStats.lastKey = '';
  if (healthState.extremeStats.lastKey && !EXTREME_WEATHER[healthState.extremeStats.lastKey]) healthState.extremeStats.lastKey = '';
  if (!healthState.chronicControl || typeof healthState.chronicControl !== 'object' || Array.isArray(healthState.chronicControl)) healthState.chronicControl = {};
  for (const ck of Object.keys(healthState.chronicControl)) {
    if (!getDiseaseInfo(ck)) { delete healthState.chronicControl[ck]; continue; }
    const cv = Number(healthState.chronicControl[ck]);
    healthState.chronicControl[ck] = Number.isFinite(cv) ? Math.max(0, Math.min(CHRONIC_CONTROL_NEED * 2, cv)) : 0;
  }
  if (!Array.isArray(healthState.activeSymptoms)) healthState.activeSymptoms = [];
  // v4.0 生活方式与检验字段兜底
  const lifeDefaults = [['weight', 58, 20, 200], ['height', 165, 100, 220], ['diet', 65, 0, 100], ['exercise', 60, 0, 100], ['sleepQuality', 70, 0, 100]];
  for (const [k, dv, lo, hi] of lifeDefaults) {
    const n = Number(healthState[k]);
    healthState[k] = Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dv;
  }
  if (!Array.isArray(healthState.vitalsHistory)) healthState.vitalsHistory = [];
  // v5.0 环境 / 医院 / 遗传 / 营养 兜底
  if (!healthState.env || typeof healthState.env !== 'object' || Array.isArray(healthState.env)) {
    healthState.env = { weather: 'clear', tempC: 22, humidity: 55, aqi: 45, uv: 5, season: 'spring', updatedAt: 0 };
  }
  if (!Array.isArray(healthState.envHistory)) healthState.envHistory = [];
  // v13.0：极端天气键（老存档没有这个字段）
  if (!Object.prototype.hasOwnProperty.call(healthState.env, 'extreme')) healthState.env.extreme = '';
  if (healthState.env.extreme && !EXTREME_WEATHER[healthState.env.extreme]) healthState.env.extreme = '';
  if (!HOSPITALS[healthState.hospital]) healthState.hospital = 'general';
  if (!Array.isArray(healthState.familyHistory)) healthState.familyHistory = [];
  healthState.familyHistory = healthState.familyHistory.filter(k => FAMILY_HISTORY[k]);
  if (!healthState.nutrients || typeof healthState.nutrients !== 'object' || Array.isArray(healthState.nutrients)) {
    healthState.nutrients = { protein: 72, carbs: 70, fat: 62, vitamin: 70, mineral: 70, fiber: 62, sodium: 58, sugar: 45 };
  }
  for (const nk of Object.keys(NUTRIENT_INFO)) {
    const nv = Number(healthState.nutrients[nk]);
    healthState.nutrients[nk] = Number.isFinite(nv) ? Math.max(0, Math.min(100, nv)) : 70;
  }
  // —— v6.0 心理 / 睡眠 / 内分泌 / 创伤 / 疫情 / 习惯 / 成就 / 年龄 兜底 ——
  if (!Array.isArray(healthState.injuries)) healthState.injuries = [];
  healthState.injuries = healthState.injuries.filter(i => i && INJURY_INFO[i.type]);
  for (const i of healthState.injuries) {
    const sv = Number(i.severity);
    i.severity = Number.isFinite(sv) ? Math.max(0, Math.min(100, sv)) : 10;
    if (!Number.isFinite(Number(i.at))) i.at = Date.now();
  }
  if (!healthState.hormones || typeof healthState.hormones !== 'object' || Array.isArray(healthState.hormones)) {
    healthState.hormones = { cortisol: 45, adrenaline: 25, serotonin: 70, dopamine: 65, thyroxine: 60, melatonin: 35 };
  }
  for (const hk of Object.keys(HORMONE_INFO)) {
    const hv = Number(healthState.hormones[hk]);
    healthState.hormones[hk] = Number.isFinite(hv) ? Math.max(0, Math.min(100, hv)) : 50;
  }
  if (!healthState.habits || typeof healthState.habits !== 'object' || Array.isArray(healthState.habits)) {
    healthState.habits = { smoking: 0, drinking: 0, stayingUp: 0, sedentary: 0, morningRun: 0, meditation: 0, drinkingWater: 0, earlySleep: 0 };
  }
  for (const hbk of Object.keys(HABIT_INFO)) {
    const hv = Number(healthState.habits[hbk]);
    healthState.habits[hbk] = Number.isFinite(hv) ? Math.max(0, Math.min(100, hv)) : 0;
  }
  if (!healthState.achievements || typeof healthState.achievements !== 'object' || Array.isArray(healthState.achievements)) healthState.achievements = {};
  if (!Array.isArray(healthState.psycHistory)) healthState.psycHistory = [];
  if (!Array.isArray(healthState.imagingHistory)) healthState.imagingHistory = [];
  if (!Array.isArray(healthState.sleepLog)) healthState.sleepLog = [];
  if (!SLEEP_STAGES[healthState.sleepStage]) healthState.sleepStage = 'awake';
  for (const f of ['sleepDebt', 'caffeine', 'sleepClock', 'scarCount']) {
    if (!Number.isFinite(Number(healthState[f]))) healthState[f] = 0;
  }
  healthState.sleepDebt = Math.max(0, Math.min(100, Number(healthState.sleepDebt)));
  healthState.caffeine = Math.max(0, Math.min(100, Number(healthState.caffeine)));
  healthState.sleepClock = Math.max(-12, Math.min(12, Number(healthState.sleepClock)));
  if (!healthState.epidemic || typeof healthState.epidemic !== 'object' || Array.isArray(healthState.epidemic)) {
    healthState.epidemic = { active: false, disease: '', since: 0, level: 0 };
  }
  if (healthState.epidemic.active && !getDiseaseInfo(healthState.epidemic.disease)) {
    healthState.epidemic = { active: false, disease: '', since: 0, level: 0 };
  }
  healthState.maskOn = !!healthState.maskOn;
  if (!Number.isFinite(Number(healthState.age)) || Number(healthState.age) < 1) healthState.age = 20;

  // —— v3.0 深度模拟字段兜底 ——
  if (!healthState.organs || typeof healthState.organs !== 'object' || Array.isArray(healthState.organs)) {
    healthState.organs = { heart: 100, lung: 100, liver: 100, stomach: 100, kidney: 100, brain: 100, skin: 100, blood: 100 };
  }
  for (const k of Object.keys(ORGAN_INFO)) {
    const v = Number(healthState.organs[k]);
    healthState.organs[k] = Number.isFinite(v) ? Math.max(0, Math.min(100, Math.round(v))) : 100;
  }
  if (!CONSTITUTIONS[healthState.constitution]) healthState.constitution = 'balanced';
  const DEFAULT_MEDICINE_BOX = { fever_reducer: 2, cold_medicine: 2, antibiotic: 1, stomach_medicine: 1, antianxiety: 1, allergy_medicine: 1, painkiller: 2 };
  for (const f of ['pathogens', 'incubating', 'antibodies', 'diagnosed', 'drugResistance', 'medicineBox']) {
    if (!healthState[f] || typeof healthState[f] !== 'object' || Array.isArray(healthState[f])) {
      healthState[f] = f === 'medicineBox' ? { ...DEFAULT_MEDICINE_BOX } : {};
    }
  }
  for (const k of Object.keys(healthState.incubating)) if (!getDiseaseInfo(k)) delete healthState.incubating[k];
  for (const k of Object.keys(healthState.antibodies)) if (!getDiseaseInfo(k)) delete healthState.antibodies[k];
  for (const k of Object.keys(healthState.diagnosed)) if (!getDiseaseInfo(k)) delete healthState.diagnosed[k];
  for (const k of Object.keys(healthState.medicineBox)) if (!MEDICINES[k]) delete healthState.medicineBox[k];
  for (const f of ['money', 'medicalCost', 'lastWork', 'lastVaccine']) {
    if (!Number.isFinite(Number(healthState[f]))) healthState[f] = f === 'money' ? 200 : 0;
  }
  if (healthState.diseaseStages && typeof healthState.diseaseStages === 'object') {
    for (const k of Object.keys(healthState.diseaseStages)) {
      if (!getDiseaseInfo(k) || !DISEASE_STAGES[healthState.diseaseStages[k]]) {
        delete healthState.diseaseStages[k];
      }
    }
  }
  if (!Number.isFinite(Number(healthState.lastUpdate)) || Number(healthState.lastUpdate) <= 0) {
    healthState.lastUpdate = Date.now();
  }
}

// 加载持久化状态
async function loadState() {
  // 先从文件加载
  const fileState = await loadFromFile();

  if (fileState) {
    // 检查是否有关键状态字段（说明是有效持久化状态）
    const hasPersisted = Object.keys(STATUSES).some(key => fileState[key] !== undefined);

    if (hasPersisted) {
      healthState = { ...healthState, ...fileState, initialized: true };
      sanitizeHealthState();
      log(`[健康系统] 已从文件加载持久化状态`);
      return;
    }
  }

  // 没有持久化状态文件，尝试从 cfg().persona 读取（部分部署下 cfg 可能含全局配置）
  try {
    const config = cfg();
    const personaText = config.persona?.roleText || '';
    const personaValues = parseHealthFromPersona(personaText);

    if (Object.keys(personaValues).length > 0) {
      healthState = { ...healthState, ...personaValues, initialized: true };
      // 应用 v3.0 初始配置（金钱 / 体质）
      const mInit = Number(config.moneyInitial);
      if (Number.isFinite(mInit)) healthState.money = mInit;
      if (CONSTITUTIONS[config.constitution]) healthState.constitution = config.constitution;
      sanitizeHealthState();
      log(`[健康系统] 已从人设卡读取初始值：${Object.keys(personaValues).join(', ')}`);
      return;
    }
  } catch (error) {
    log(`[健康系统] 解析人设卡失败：${error.message}`);
  }

  // 拿不到人设卡 → 保持未初始化，等第一次对话时从 system message 解析
  log('[健康系统] 未找到人设卡初始值，等待对话时从人设卡解析');
}

// 从 system message（含人设卡文本）解析健康初始值
async function tryInitFromSystemMessage(messages) {
  if (healthState.initialized) return false;
  if (!Array.isArray(messages)) return false;

  try {
    const sysMsg = messages.find(m => m && m.role === 'system');
    const personaText = (sysMsg && typeof sysMsg.content === 'string') ? sysMsg.content : '';
    const personaValues = parseHealthFromPersona(personaText);

    if (Object.keys(personaValues).length > 0) {
      healthState = { ...healthState, ...personaValues, initialized: true };
      sanitizeHealthState();
      await saveToFile();
      log(`[健康系统] 已从人设卡（对话初始化）读取初始值：${Object.keys(personaValues).join(', ')}`);
      return true;
    }
  } catch (error) {
    log(`[健康系统] 从人设卡初始化失败：${error.message}`);
  }

  return false;
}

// ── Skill 生命周期 ────────────────────────────────────────────────────────

let configSyncTimer = null; // 配置同步定时器
let lastSyncedConfig = {};  // 上次同步的配置值

// 注册健康工具到 LLM（health.tools provider 只是元数据，必须 registerTool 才生效）
function registerHealthTools(api) {
  const tools = [
    { id: 'get_mood', name: '查看情绪', description: '查看机器人当前的情绪状态摘要（不显示具体数值）', execute: async () => ({ content: generateMoodSummary() }) },
    { id: 'show_status', name: '健康报告', description: '显示机器人当前所有健康状态和疾病详情', execute: async () => ({ content: generateFullStatusReport() }) },
    { id: 'heal', name: '治疗恢复', description: '给机器人治疗，恢复健康值和心情', parameters: { type: 'object', properties: { amount: { type: 'number', description: '治疗量，默认 20', default: 20 } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'heal', amount: args?.amount })).message }) },
    { id: 'cure', name: '看病就医', description: '带机器人去医院看病，治疗疾病（按阶段概率恢复，不是一次治愈）', execute: async () => ({ content: (await providers['health.state']({ action: 'cure' })).message }) },
    { id: 'check_health', name: '健康检查', description: '给机器人做体检，查看身体状况和潜在疾病', execute: async () => ({ content: (await providers['health.state']({ action: 'check_health' })).message }) },
    { id: 'drink', name: '喝水解渴', description: '给机器人喝水，恢复口渴度', parameters: { type: 'object', properties: { amount: { type: 'number', description: '喝水量，默认 20', default: 20 } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'drink', amount: args?.amount })).message }) },
    { id: 'eat', name: '吃饭充饥', description: '给机器人吃饭。不指定菜品时仍随机决定吃了什么；指定 meal 则按菜单点（不同选择对营养、菌群、钱包、心情与社交的影响不同）', parameters: { type: 'object', properties: { amount: { type: 'number', description: '饭量，默认 20', default: 20 }, meal: { type: 'string', description: '菜品键（可选）：home_cook 自己下厨 / canteen 食堂工作餐 / takeout 点外卖 / instant 泡面 / fastfood 快餐 / hotpot 火锅 / night_snack 夜宵（仅夜间）/ fancy 下馆子 / gather 朋友聚餐' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'eat', amount: args?.amount, status: args?.meal }); return { content: r.message || r.error }; } },
    { id: 'rest', name: '小憩回血', description: '让机器人休息，恢复精力和疲劳度', parameters: { type: 'object', properties: { amount: { type: 'number', description: '休息时长，默认 25', default: 25 } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'rest', amount: args?.amount })).message }) },
    { id: 'sleep', name: '睡觉满血', description: '让机器人睡觉，大幅恢复睡眠需求、精力和疲劳度', parameters: { type: 'object', properties: { amount: { type: 'number', description: '睡眠时长，默认 30', default: 30 } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'sleep', amount: args?.amount })).message }) },
    { id: 'relax', name: '放松减压', description: '让机器人放松，缓解压力、恢复心情和疲劳度', parameters: { type: 'object', properties: { amount: { type: 'number', description: '放松程度，默认 20', default: 20 } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'relax', amount: args?.amount })).message }) },
    { id: 'chat_heal', name: '聊天解闷', description: '和机器人聊天，缓解孤独感、满足社交需求（会消耗少量精力）', execute: async () => ({ content: (await providers['health.state']({ action: 'chat' })).message }) },
    { id: 'exercise', name: '运动健身', description: '让机器人运动健身，消耗体力、恢复健康和心情', parameters: { type: 'object', properties: { amount: { type: 'number', description: '运动量，默认 20', default: 20 } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'exercise', amount: args?.amount })).message }) },
    { id: 'play_game', name: '打游戏', description: '让机器人打游戏，提升心情和社交，但会升高成瘾度', parameters: { type: 'object', properties: { amount: { type: 'number', description: '时长，默认 20', default: 20 } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'play_game', amount: args?.amount })).message }) },
    { id: 'listen_music', name: '听音乐', description: '让机器人听音乐，缓解压力、提升心情', parameters: { type: 'object', properties: { amount: { type: 'number', description: '时长，默认 20', default: 20 } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'listen_music', amount: args?.amount })).message }) },
    { id: 'walk', name: '散步', description: '让机器人去散步，提升心情、安全感和舒适度', parameters: { type: 'object', properties: { amount: { type: 'number', description: '时长，默认 20', default: 20 } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'walk', amount: args?.amount })).message }) },
    { id: 'take_medicine', name: '吃药', description: '给机器人吃药（药物疗程）：退烧并温和推进疾病缓解，需多次', execute: async () => ({ content: (await providers['health.state']({ action: 'take_medicine' })).message }) },
    { id: 'measure', name: '测体温', description: '给机器人测体温和血压，返回诊断（不改变状态）', execute: async () => ({ content: (await providers['health.state']({ action: 'measure' })).message }) },
    { id: 'bond_status', name: '羁绊查看', description: '查看机器人与群友的关系亲密度', execute: async () => ({ content: (await providers['health.state']({ action: 'bond_view' })).message }) },
    { id: 'bond_care', name: '主动关心', description: '让机器人主动关心最亲密的人', execute: async () => ({ content: (await providers['health.state']({ action: 'bond_care' })).message }) },
    { id: 'prescribe', name: '用药建议', description: '根据机器人当前疾病给出靶向用药建议（不改变状态，仅诊断）', execute: async () => ({ content: (await providers['health.state']({ action: 'prescribe' })).message }) },
    { id: 'hospitalize', name: '住院治疗', description: '带机器人住院做重症监护治疗，对晚期/危重疾病治愈率更高（消耗精力）', execute: async () => ({ content: (await providers['health.state']({ action: 'hospitalize' })).message }) },
    { id: 'rest_cure', name: '静养调理', description: '让机器人静养调理，缓解初期症状并提升抵抗力', execute: async () => ({ content: (await providers['health.state']({ action: 'rest_cure' })).message }) },
    { id: 'exam', name: '检查化验', description: '带机器人做化验检查（花费金钱）：确诊疾病、检出潜伏期隐患，确诊后治疗成功率提升', execute: async () => ({ content: (await providers['health.state']({ action: 'exam' })).message }) },
    { id: 'vaccinate', name: '接种疫苗', description: '给机器人打疫苗，获得对多种传染病的免疫记忆（花费金钱，30 天有效期）', execute: async () => ({ content: (await providers['health.state']({ action: 'vaccinate' })).message }) },
    { id: 'organ_check', name: '器官检查', description: '查看机器人 8 大器官（心/肺/肝/胃/肾/脑/皮肤/血液）的健康状况', execute: async () => ({ content: (await providers['health.state']({ action: 'organ_check' })).message }) },
    { id: 'wallet', name: '查看钱包', description: '查看机器人的金钱余额、累计医疗花费和药箱库存', execute: async () => ({ content: (await providers['health.state']({ action: 'wallet' })).message }) },
    { id: 'work', name: '打工赚钱', description: '让机器人打工赚钱，用于支付医疗费与生活费。收入由身体状态决定（健康/精力/疲劳/饱食/水分/心情越好赚得越多），不是固定数额。工种：labor 体力活（基准 ¥95，6 小时冷却，最耗体力）/ errand 跑腿（¥72，4 小时冷却，最轻省）/ skilled 细活（¥148，8 小时冷却，需最高爱好等级 ≥4 才接得到）；省略则自动挑能接的里最划算的', parameters: { type: 'object', properties: { type: { type: 'string', description: '工种：labor / errand / skilled，也认中文「体力活」「跑腿」「细活」；省略则自动选择' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'work', status: args?.type }); return { content: r.message || r.error }; } },
    { id: 'gig', name: '接单赚钱', description: '靠手艺变现：用已练到 2~3 级的产出型爱好接一单，做出一件作品卖给甲方（插画约稿/约拍/外包/驻唱/陪练/私厨/蛋糕/木作/代练…）。收入按作品品质与熟练度定价，并可能遇到甲方压价、加钱、急单或退稿。10 小时冷却，消耗 30 精力，需要手艺达标', parameters: { type: 'object', properties: { craft: { type: 'string', description: '爱好键，如 painting / coding / guitar / cooking / photography；省略则列出当前能接的单与预估收入' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'gig', status: args?.craft }); return { content: r.message || r.error }; } },
    { id: 'ledger', name: '收支账本', description: '查看本月与累计的收入/支出/净结余、各项来路与去向明细、最近流水，以及距下次发薪还有几天', execute: async () => ({ content: (await providers['health.state']({ action: 'ledger' })).message }) },
    { id: 'buy_medicine', name: '买药补药', description: '去药店把每种缺货的药补到 2 盒（花费金钱）', execute: async () => ({ content: (await providers['health.state']({ action: 'buy_medicine' })).message }) },
    { id: 'blood_test', name: '抽血化验', description: '给机器人抽血化验，出完整临床检验报告（血压/血脂/血糖/尿酸/血常规/肝肾功能/电解质，花费金钱）', execute: async () => ({ content: (await providers['health.state']({ action: 'blood_test' })).message }) },
    { id: 'vital_check', name: '指标速览', description: '快速查看机器人的异常检验指标（不花钱），只看不正常的那几项', execute: async () => ({ content: (await providers['health.state']({ action: 'vital_check' })).message }) },
    { id: 'diet_control', name: '清淡饮食', description: '让机器人吃清淡餐，提升饮食健康度（长期改善血脂/血糖/尿酸）', execute: async () => ({ content: (await providers['health.state']({ action: 'diet_control' })).message }) },
    { id: 'weigh', name: '称体重', description: '给机器人称体重，查看体重与 BMI 情况', execute: async () => ({ content: (await providers['health.state']({ action: 'weigh' })).message }) },
    { id: 'lifestyle', name: '生活方式', description: '查看机器人的饮食健康度/运动习惯/睡眠质量/体重 BMI', execute: async () => ({ content: (await providers['health.state']({ action: 'lifestyle' })).message }) },
    { id: 'constitution', name: '查看体质', description: '查看机器人的中医体质类型及其易感疾病；也可用 set_constitution 切换体质', parameters: { type: 'object', properties: { constitution: { type: 'string', description: '要切换到的体质键（可选）：balanced/qixu/yangxu/yinxu/tanshi/shire/qiyu/tebing' } } }, execute: async (ctx, args) => {
      if (args?.constitution) return { content: (await providers['health.state']({ action: 'set_constitution', status: args.constitution })).message };
      return { content: (await providers['health.state']({ action: 'constitution' })).message };
    } },
    { id: 'weather', name: '查看天气', description: '查看当前天气、气温、湿度、空气质量与紫外线，以及环境对身体的影响', execute: async () => ({ content: (await providers['health.state']({ action: 'weather' })).message }) },
    { id: 'sunbath', name: '晒太阳', description: '让机器人晒太阳，补充维生素D、提升心情和安全感', execute: async () => ({ content: (await providers['health.state']({ action: 'sunbath' })).message }) },
    { id: 'hospital', name: '选择医院', description: '查看或切换就诊医院（社区医院/市医院/三甲医院/中医院），不同医院医生水平与费用不同', parameters: { type: 'object', properties: { hospital: { type: 'string', description: '要切换到的医院键（可选）：community/general/top/tcm' } } }, execute: async (ctx, args) => {
      if (args?.hospital) return { content: (await providers['health.state']({ action: 'set_hospital', status: args.hospital })).message };
      return { content: (await providers['health.state']({ action: 'hospital' })).message };
    } },
    { id: 'emergency', name: '看急诊', description: '带机器人挂急诊，紧急处理疾病（花费较高，但对晚期/危重疾病效果显著）', execute: async () => ({ content: (await providers['health.state']({ action: 'emergency' })).message }) },
    { id: 'family_history', name: '家族病史', description: '查看机器人的家族遗传史及其易感疾病', execute: async () => ({ content: (await providers['health.state']({ action: 'family' })).message }) },
    { id: 'nutrition', name: '营养状况', description: '查看机器人八大营养素（蛋白质/碳水/脂肪/维生素/矿物质/纤维/控盐/控糖）的摄入状况', execute: async () => ({ content: (await providers['health.state']({ action: 'nutrition' })).message }) },
    { id: 'supplement', name: '吃营养品', description: '给机器人吃营养品，补充维生素与矿物质（花费金钱）', execute: async () => ({ content: (await providers['health.state']({ action: 'supplement' })).message }) },
    // —— v6.0 心理 / 睡眠 / 内分泌 / 创伤 / 检查 / 疫情 / 习惯 / 成就 ——
    { id: 'therapy', name: '心理咨询', description: '带机器人做心理咨询，缓解焦虑与抑郁、提升情绪稳定（花费金钱，6 小时冷却）', execute: async () => ({ content: (await providers['health.state']({ action: 'therapy' })).message }) },
    { id: 'meditate', name: '冥想', description: '让机器人冥想，缓解焦虑、提升专注力与情绪稳定', execute: async () => ({ content: (await providers['health.state']({ action: 'meditate' })).message }) },
    { id: 'journal', name: '写日记', description: '让机器人写日记，梳理情绪、缓解焦虑与抑郁', execute: async () => ({ content: (await providers['health.state']({ action: 'journal' })).message }) },
    { id: 'party', name: '参加聚会', description: '让机器人参加朋友聚会，提升心情/社交/归属，缓解焦虑抑郁（花费金钱）', execute: async () => ({ content: (await providers['health.state']({ action: 'party' })).message }) },
    { id: 'cry', name: '大哭一场', description: '让机器人痛快哭一场，释放压力、大幅缓解焦虑与抑郁（舒适度略降）', execute: async () => ({ content: (await providers['health.state']({ action: 'cry' })).message }) },
    { id: 'sleep_stage', name: '睡眠状况', description: '查看机器人当前睡眠阶段（清醒/浅睡/深睡/REM）、睡眠负债、咖啡因与生物钟', execute: async () => ({ content: (await providers['health.state']({ action: 'sleep_stage' })).message }) },
    { id: 'coffee', name: '喝咖啡', description: '让机器人喝咖啡提神（提升咖啡因，影响睡眠质量与入睡）', execute: async () => ({ content: (await providers['health.state']({ action: 'coffee' })).message }) },
    { id: 'stay_up', name: '熬夜', description: '让机器人熬夜（短暂亢奋，但累积睡眠负债、生物钟后移、焦虑上升）', execute: async () => ({ content: (await providers['health.state']({ action: 'stay_up' })).message }) },
    { id: 'nap', name: '小睡', description: '让机器人小睡 20 分钟，恢复精力与疲劳、减少少量睡眠负债', execute: async () => ({ content: (await providers['health.state']({ action: 'nap' })).message }) },
    { id: 'melatonin', name: '吃褪黑素', description: '给机器人吃褪黑素助眠（花费金钱，提升褪黑激素与睡眠质量）', execute: async () => ({ content: (await providers['health.state']({ action: 'melatonin' })).message }) },
    { id: 'regular_routine', name: '调整作息', description: '帮机器人规律作息，修正生物钟偏移、提升睡眠质量与情绪稳定（每天一次）', execute: async () => ({ content: (await providers['health.state']({ action: 'regular_routine' })).message }) },
    { id: 'hormone_check', name: '内分泌检查', description: '检查机器人六项激素（皮质醇/肾上腺素/血清素/多巴胺/甲状腺素/褪黑激素）水平', execute: async () => ({ content: (await providers['health.state']({ action: 'hormone_check' })).message }) },
    { id: 'first_aid', name: '急救包扎', description: '给机器人处理伤口，消毒包扎、加速愈合、降低感染风险（花费金钱）', execute: async () => ({ content: (await providers['health.state']({ action: 'first_aid' })).message }) },
    { id: 'injury_check', name: '外伤检查', description: '查看机器人身上的外伤（部位/类型/严重度）与累计受伤次数', execute: async () => ({ content: (await providers['health.state']({ action: 'injury_check' })).message }) },
    { id: 'imaging', name: '影像检查', description: '给机器人做专项检查（心电图/B超/X光/CT/尿常规/便常规/甲状腺功能/肿瘤标志物），可确诊甚至查出潜伏疾病', parameters: { type: 'object', properties: { type: { type: 'string', description: '检查项目：ecg/ultrasound/xray/ct/urinalysis/stool/thyroid/tumor_marker' } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'imaging', status: args?.type })).message }) },
    { id: 'epidemic', name: '查看疫情', description: '查看社区疫情（当前流行的疾病与严重程度）及防护建议', execute: async () => ({ content: (await providers['health.state']({ action: 'epidemic' })).message }) },
    { id: 'mask', name: '戴口罩', description: '让机器人戴上/摘下口罩，大幅降低疫情期间被传染的概率', execute: async () => ({ content: (await providers['health.state']({ action: 'mask' })).message }) },
    { id: 'disinfect', name: '消毒', description: '给机器人的房间和手消毒，减少病菌、小幅提升抵抗力（花费金钱）', execute: async () => ({ content: (await providers['health.state']({ action: 'disinfect' })).message }) },
    { id: 'isolate', name: '居家隔离', description: '让机器人居家隔离，几乎阻断疫情传播（代价是社交需求下降、焦虑略升）', execute: async () => ({ content: (await providers['health.state']({ action: 'isolate' })).message }) },
    { id: 'habits', name: '习惯档案', description: '查看机器人的八项习惯养成度（吸烟/饮酒/熬夜/久坐/晨跑/冥想/多喝水/早睡）', execute: async () => ({ content: (await providers['health.state']({ action: 'habits' })).message }) },
    { id: 'cultivate', name: '培养习惯', description: '帮机器人培养一个好习惯（morningRun/meditation/drinkingWater/earlySleep）', parameters: { type: 'object', properties: { habit: { type: 'string', description: '习惯键：morningRun/meditation/drinkingWater/earlySleep' } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'cultivate', status: args?.habit })).message }) },
    { id: 'quit', name: '戒除习惯', description: '帮机器人戒除一个坏习惯（smoking/drinking/stayingUp/sedentary，花费金钱）', parameters: { type: 'object', properties: { habit: { type: 'string', description: '习惯键：smoking/drinking/stayingUp/sedentary' } } }, execute: async (ctx, args) => ({ content: (await providers['health.state']({ action: 'quit', status: args?.habit })).message }) },
    { id: 'achievements', name: '健康成就', description: '查看机器人已解锁的健康成就徽章与未解锁目标', execute: async () => ({ content: (await providers['health.state']({ action: 'achievements' })).message }) },
    { id: 'age', name: '查看年龄', description: '查看机器人年龄、年龄带来的基础衰减倍率与距离下次生日的天数', execute: async () => ({ content: (await providers['health.state']({ action: 'age' })).message }) },
    // —— v7.0 基础需求深化 ——
    { id: 'hydrate_check', name: '水平衡检查', description: '查看机器人的水分、电解质与体力储备状况，给出补水建议', execute: async () => ({ content: (await providers['health.state']({ action: 'hydrate_check' })).message }) },
    { id: 'electrolyte_supplement', name: '补充电解质', description: '给机器人喝电解质饮料，快速补充电解质、缓解"喝不解渴"（花费金钱）', execute: async () => { const r = await providers['health.state']({ action: 'electrolyte_supplement' }); return { content: r.message || r.error }; } },
    { id: 'body_signal', name: '身体信号', description: '扫描机器人深层生理（电解质/热量盈余/精神疲劳/亲密需求/情绪波动/体力储备）与正在发生的连锁反应预警', execute: async () => ({ content: (await providers['health.state']({ action: 'body_signal' })).message }) },
    // —— v7.1 图片报表 ——
    { id: 'report_image', name: '健康图片报表', description: '生成一张健康状态的图片报表并直接发到当前聊天（含 24 项状态条、疾病、器官、检验指标、营养、激素、习惯、成就等），比文字报告直观得多。用户说"看看状态""发个健康报表""截图给我""出张图"时用它。', execute: async (ctx) => {
      try {
        const r = await sendHealthReportImage(ctx);
        return { content: `已经把健康状态图片报表发送到当前聊天了（${r.width}×${r.height}，${Math.round(r.bytes / 1024)}KB）。不要再用文字复述报表内容（发出去就行），用一句简短自然的话带过即可。` };
      } catch (error) {
        return { content: `图片报表生成失败（${error.message}），以下是文字版报告：\n\n${generateFullStatusReport()}` };
      }
    } },
    // —— v8.0 昼夜节律 / 菌群 / 过敏 / 关系网 / 医保 / 生物年龄 / 大事记 ——
    { id: 'circadian', name: '昼夜节律', description: '查看机器人当前所处的昼夜节律段（深夜低谷/晨间唤醒/上午高峰/午后低谷/傍晚次峰/夜间沉静）、精力与警觉曲线、皮质醇与褪黑素水平、生物钟相位偏移与建议睡眠窗口', execute: async () => ({ content: (await providers['health.state']({ action: 'circadian' })).message }) },
    { id: 'gut_check', name: '肠道菌群检查', description: '检查机器人六项肠道菌群（双歧杆菌/乳酸菌/拟杆菌/厚壁菌/多样性/肠道屏障），以及它们对消化、营养吸收、免疫与情绪（肠脑轴）的影响', execute: async () => ({ content: (await providers['health.state']({ action: 'gut_check' })).message }) },
    { id: 'probiotics', name: '补充益生菌', description: '给机器人喝益生菌，回补双歧杆菌与乳酸菌、修复被抗生素打乱的菌群（花费金钱）', execute: async () => { const r = await providers['health.state']({ action: 'probiotics' }); return { content: r.message || r.error }; } },
    { id: 'fiber_diet', name: '高纤维餐', description: '给机器人吃一顿高纤维餐（全谷物+蔬菜+豆类），改善肠道菌群并补充膳食纤维', execute: async () => ({ content: (await providers['health.state']({ action: 'fiber_diet' })).message }) },
    { id: 'allergen_test', name: '过敏原检测', description: '带机器人做过敏原检测，查明八种过敏原（花粉/尘螨/霉菌/宠物皮屑/海鲜/花生/乳制品/冷空气）各自的敏感等级（花费金钱）', execute: async () => { const r = await providers['health.state']({ action: 'allergen_test' }); return { content: r.message || r.error }; } },
    { id: 'allergy_check', name: '过敏状况', description: '查看机器人当前的过敏负荷、已知过敏原与正在刺激身体的环境因素', execute: async () => ({ content: (await providers['health.state']({ action: 'allergy_check' })).message }) },
    { id: 'antihistamine', name: '吃抗过敏药', description: '给机器人吃抗过敏药，快速压下过敏负荷（优先用药箱库存，没有就现买）', execute: async () => { const r = await providers['health.state']({ action: 'antihistamine' }); return { content: r.message || r.error }; } },
    { id: 'relations', name: '社交关系网', description: '查看机器人的关系网：每段关系的类型（家人/恋人/挚友/同事/群友）、亲密度、亲密感、积怨与上次深聊时间', execute: async () => ({ content: (await providers['health.state']({ action: 'relations' })).message }) },
    { id: 'deep_talk', name: '深聊交心', description: '让机器人与某个人深聊一次，大幅提升亲密度与亲密感、化解积怨、缓解孤独与压力。可指定对象名字', parameters: { type: 'object', properties: { name: { type: 'string', description: '要深聊的对象名字（可选，默认最亲近的人）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'deep_talk', status: args?.name }); return { content: r.message || r.error }; } },
    { id: 'reconcile', name: '化解矛盾', description: '主动找关系网中积怨最深的人把话说开，降低矛盾、修复亲密度', execute: async () => ({ content: (await providers['health.state']({ action: 'reconcile' })).message }) },
    { id: 'bio_age', name: '生物年龄', description: '计算机器人的生理年龄（与实际年龄的差值）并列出器官/代谢/生活方式/习惯/心理/菌群/营养/外伤/过敏各系统的老化贡献', execute: async () => ({ content: (await providers['health.state']({ action: 'bio_age' })).message }) },
    { id: 'insurance', name: '医保', description: '查看机器人当前医保方案、本年度已报销额度与剩余额度；也可办理居民/职工/商业医保（参数 plan），填 none 退保', parameters: { type: 'object', properties: { plan: { type: 'string', description: '要办理的方案（可选）：resident/employee/commercial，none 表示退保' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'insurance', status: args?.plan }); return { content: r.message || r.error }; } },
    { id: 'timeline', name: '健康大事记', description: '查看机器人的健康事件时间轴（首次患病、过生日、解锁成就、办理医保等节点）', execute: async () => ({ content: (await providers['health.state']({ action: 'timeline' })).message }) },
    // —— v9.0 爱好与技能树 ——
    { id: 'hobby_list', name: '爱好与技能', description: '查看机器人正在培养的爱好：熟练度等级、经验、热情、练习次数、作品数量，以及爱好带来的被动加成（满足/心情/减压/安全感/社交）', execute: async () => ({ content: (await providers['health.state']({ action: 'hobby_list' })).message }) },
    { id: 'hobby_learn', name: '学爱好', description: '让机器人学一门新爱好（花费金钱，占用一个槽位）。可选：guitar 弹吉他/piano 弹钢琴/singing 唱歌/painting 画画/photography 摄影/calligraphy 书法/running 跑步/swimming 游泳/yoga 瑜伽/dancing 跳舞/woodwork 木工/knitting 编织/cooking 做饭/baking 烘焙/gardening 养花/reading 读书/chess 下棋/coding 编程/gaming 电竞', parameters: { type: 'object', properties: { hobby: { type: 'string', description: '爱好键（可选，省略则列出可学清单）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'hobby_learn', status: args?.hobby }); return { content: r.message || r.error }; } },
    { id: 'hobby_practice', name: '练爱好', description: '让机器人练习爱好：涨经验与熟练度、提心情与满足感、减压，可能产出作品；但会消耗精力体力，练太狠会累积劳损/视疲劳/兴趣耗竭', parameters: { type: 'object', properties: { hobby: { type: 'string', description: '爱好键（可选，默认练热情最高的那个）' }, amount: { type: 'number', description: '投入份量 1-3，默认 1' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'hobby_practice', status: args?.hobby, amount: args?.amount }); return { content: r.message || r.error }; } },
    { id: 'hobby_works', name: '作品收藏', description: '查看机器人在各爱好上产出的作品（习作/合格品/精良品/杰作）与产出时间', execute: async () => ({ content: (await providers['health.state']({ action: 'hobby_works' })).message }) },
    { id: 'hobby_gift', name: '送作品', description: '把机器人最好的作品送给关系网里的某个人，提升亲密度与亲密感、化解积怨', parameters: { type: 'object', properties: { name: { type: 'string', description: '收礼人的名字（可选，省略则列出关系网里可选的人）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'hobby_gift', status: args?.name }); return { content: r.message || r.error }; } },
    { id: 'hobby_abandon', name: '放弃爱好', description: '让机器人放弃一个爱好，释放槽位（原有的经验与作品一并清空）', parameters: { type: 'object', properties: { hobby: { type: 'string', description: '爱好键或名称' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'hobby_abandon', status: args?.hobby }); return { content: r.message || r.error }; } },
    { id: 'hobby_tree', name: '技能树', description: '查看机器人的爱好技能树：熟练度阶梯、每个爱好的进度与三个里程碑（小成/大成/登峰）的达成情况', execute: async () => ({ content: (await providers['health.state']({ action: 'hobby_tree' })).message }) },

    // —— v10.0 宠物养成 ——
    { id: 'pet_status', name: '宠物面板', description: '查看机器人养的宠物：物种、成长阶段、四维需求（饱食/饮水/清洁/心情）、亲密度、健康、肥肉度、已学技能、生命进度，以及掉毛/夜间吵闹对主人的影响', execute: async () => ({ content: (await providers['health.state']({ action: 'pet_status' })).message }) },
    { id: 'pet_adopt', name: '领养宠物', description: '领养一只宠物（花费金钱，占一个名额）：猫/狗/仓鼠/兔子/鹦鹉/金鱼/乌龟/蜥蜴/刺猬/龙猫，可指定名字', parameters: { type: 'object', properties: { species: { type: 'string', description: '物种键：cat/dog/hamster/rabbit/parrot/goldfish/turtle/lizard/hedgehog/chinchilla' }, name: { type: 'string', description: '给宠物起的名字（可选，省略则随机起一个）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_adopt', status: args?.species, extra: args?.name }); return { content: r.message || r.error }; } },
    { id: 'pet_feed', name: '喂宠物', description: '给宠物添粮（花费金钱），恢复饱食与心情、提升亲密度；已经吃饱还硬喂会长胖', parameters: { type: 'object', properties: { pet: { type: 'string', description: '宠物名字或 id（可选，只有一只时可省略）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_feed', status: args?.pet }); return { content: r.message || r.error }; } },
    { id: 'pet_water', name: '给宠物换水', description: '给宠物换上干净的水，恢复饮水需求', parameters: { type: 'object', properties: { pet: { type: 'string', description: '宠物名字或 id（可选）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_water', status: args?.pet }); return { content: r.message || r.error }; } },
    { id: 'pet_clean', name: '给宠物清洁', description: '给宠物洗澡/铲猫砂/换水/备沙浴，恢复清洁度（宠物大多不太乐意）', parameters: { type: 'object', properties: { pet: { type: 'string', description: '宠物名字或 id（可选）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_clean', status: args?.pet }); return { content: r.message || r.error }; } },
    { id: 'pet_play', name: '陪宠物玩', description: '陪宠物玩耍，大幅提升宠物的心情与亲密度，同时消耗主人体力、缓解主人压力', parameters: { type: 'object', properties: { pet: { type: 'string', description: '宠物名字或 id（可选）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_play', status: args?.pet }); return { content: r.message || r.error }; } },
    { id: 'pet_cuddle', name: '撸宠物', description: '摸摸抱抱宠物，降低主人皮质醇、提升血清素与心情，同时增进亲密度（宠物多半嘴上嫌弃身体诚实）', parameters: { type: 'object', properties: { pet: { type: 'string', description: '宠物名字或 id（可选）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_cuddle', status: args?.pet }); return { content: r.message || r.error }; } },
    { id: 'pet_walk', name: '遛宠物', description: '带宠物出门遛弯：提升宠物心情与亲密度、帮宠物减重，同时增加主人的运动量与心情（恶劣天气收益降低）', parameters: { type: 'object', properties: { pet: { type: 'string', description: '宠物名字或 id（可选）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_walk', status: args?.pet }); return { content: r.message || r.error }; } },
    { id: 'pet_train', name: '训练宠物', description: '训练宠物学技能（坐下/握手/打滚/转圈/叼东西/叫一声/安静/装死/鞠躬/跳舞，视物种而定）：亲密度与阶段越高学得越快，幼崽学不了', parameters: { type: 'object', properties: { pet: { type: 'string', description: '宠物名字或 id（可选）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_train', status: args?.pet }); return { content: r.message || r.error }; } },
    { id: 'pet_show', name: '宠物表演', description: '让宠物表演已学会的把戏，提升主人的心情与满足感、增进亲密度', parameters: { type: 'object', properties: { pet: { type: 'string', description: '宠物名字或 id（可选）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_show', status: args?.pet }); return { content: r.message || r.error }; } },
    { id: 'pet_vet', name: '带宠物看兽医', description: '带宠物去宠物医院，治好它的疾病并大幅恢复健康（自费，宠物医疗不走医保）', parameters: { type: 'object', properties: { pet: { type: 'string', description: '宠物名字或 id（可选）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_vet', status: args?.pet }); return { content: r.message || r.error }; } },
    { id: 'pet_rename', name: '给宠物改名', description: '给宠物起个新名字', parameters: { type: 'object', properties: { pet: { type: 'string', description: '宠物名字或 id（可选）' }, name: { type: 'string', description: '新名字' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_rename', status: args?.pet, extra: args?.name }); return { content: r.message || r.error }; } },
    { id: 'pet_abandon', name: '送走宠物', description: '把宠物送走，释放名额（会有情绪代价：心情下降、抑郁与孤独感上升）', parameters: { type: 'object', properties: { pet: { type: 'string', description: '宠物名字或 id（可选）' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'pet_abandon', status: args?.pet }); return { content: r.message || r.error }; } },
    // ── v11.0 日常生活 ──
    { id: 'outfit', name: '穿衣', description: '查看今天该穿什么（按气温/天气/紫外线给建议），或换一身衣服；换衣服会影响体感、舒适度、心情与社交形象。可选：pajamas 睡衣 / summer 短袖 / casual 长袖休闲 / light_coat 薄外套 / coat 厚外套 / down 羽绒服 / raincoat 冲锋衣(防水) / sport 运动装 / formal 正装；传 sunscreen 则涂防晒', parameters: { type: 'object', properties: { wear: { type: 'string', description: '衣物键，或 sunscreen（涂防晒）；省略则给今日穿搭建议' } } }, execute: async (ctx, args) => { const r = await providers['health.state']({ action: 'outfit', status: args?.wear }); return { content: r.message || r.error }; } },
    { id: 'home', name: '居家面板', description: '查看房间整洁度、衣物洁净度、待洗碗数、宠物弄脏累积与晒被除螨余效，以及可做的家务清单', execute: async () => ({ content: (await providers['health.state']({ action: 'home' })).message }) },
    { id: 'tidy', name: '打扫房间', description: '扫地拖地擦桌子、顺手换床单：提升房间整洁度。整洁度低会推高尘螨过敏负荷，也会拖累舒适度', execute: async () => { const r = await providers['health.state']({ action: 'tidy' }); return { content: r.message || r.error }; } },
    { id: 'laundry', name: '洗衣服', description: '把攒下的衣服洗了，提升衣物洁净度（太低就没干净衣服穿）', execute: async () => { const r = await providers['health.state']({ action: 'laundry' }); return { content: r.message || r.error }; } },
    { id: 'quilt', name: '晒被子', description: '晒被子杀菌除螨：显著压低尘螨过敏负荷，晚上睡得也更好（雨天晒不了）', execute: async () => { const r = await providers['health.state']({ action: 'quilt' }); return { content: r.message || r.error }; } },
    { id: 'dishes', name: '洗碗', description: '把池子里堆着的碗洗掉（自己下厨会产生待洗碗，堆多了影响心情）', execute: async () => { const r = await providers['health.state']({ action: 'dishes' }); return { content: r.message || r.error }; } },
    { id: 'hire_cleaner', name: '请保洁', description: '花钱请保洁一次全包：房间整洁度与衣物洁净度拉满、碗也洗掉，但费钱', execute: async () => { const r = await providers['health.state']({ action: 'hire_cleaner' }); return { content: r.message || r.error }; } },
    { id: 'bills', name: '账单', description: '查看每月房租/水电/网费/伙食的账单明细、距下次扣款天数、是否欠费与历史缴费记录', execute: async () => ({ content: (await providers['health.state']({ action: 'bills' })).message }) },
    { id: 'today', name: '今日一览', description: '查看今天的时间与环境：星期几（工作日/休息日）、是否节日及其物价影响、天气与空气质量、极端天气预警、慢性病缓解期', execute: async () => ({ content: (await providers['health.state']({ action: 'today' })).message }) },
    { id: 'pay_bills', name: '补交欠款', description: '把欠着的账单一次补上（欠费期间压力与安全感会被持续磨损）', execute: async () => { const r = await providers['health.state']({ action: 'pay_bills' }); return { content: r.message || r.error }; } }
  ];

  for (const tool of tools) {
    try {
      // 包一层暂存最近一次工具调用的发送通道（宿主钩子可能不传 sender，见 lastKnownSender）
      api.registerTool({
        ...tool,
        execute: async (toolCtx, args) => {
          if (toolCtx && toolCtx.sender) lastKnownSender = toolCtx.sender;
          return await tool.execute(toolCtx, args);
        }
      });
    } catch (error) {
      log(`[健康系统] 注册工具 ${tool.id} 失败：${error.message}`);
    }
  }

  log(`[健康系统] 已注册 ${tools.length} 个健康工具`);
}

export function setup(api) {
  cfg = api.config;
  log = api.log;
  storage = api.storage?.writeJson ? api.storage : null;
  log('[健康系统] 插件已加载');

  // 注册健康工具到 LLM
  registerHealthTools(api);

  // 监听配置变化，同步状态值
  const statusKeys = ['thirst', 'hunger', 'energy', 'health', 'mood', 'sleep', 'fatigue', 'comfort', 'stress', 'loneliness', 'social', 'satisfaction', 'belonging', 'fever', 'addiction', 'curiosity', 'empathy', 'security', 'immunity', 'diet', 'exercise', 'sleepQuality', 'anxiety', 'depressionLevel', 'stability', 'focus', 'sleepDebt', 'electrolyte', 'calorieSurplus', 'mentalFatigue', 'intimacy', 'moodVolatility', 'physicalReserve'];

  // 定期检查配置值是否改变
  if (configSyncTimer) clearInterval(configSyncTimer);
  configSyncTimer = setInterval(async () => {
    try {
      const config = cfg();
      let changed = false;

      for (const key of statusKeys) {
        // 配置键格式：xxxInitial（如 thirstInitial）
        const cfgKey = `${key}Initial`;
        // 只在"配置值有定义"且"与上次同步的值不同"时才同步
        // 这样衰减后的状态不会被配置里的旧值覆盖
        if (config[cfgKey] !== undefined && config[cfgKey] !== lastSyncedConfig[cfgKey]) {
          healthState[key] = config[cfgKey];
          lastSyncedConfig[cfgKey] = config[cfgKey];
          changed = true;
          log(`[健康系统] 配置同步：${key} = ${config[cfgKey]}`);
        }
      }

      if (changed) {
        await saveToFile();
      }
    } catch (error) {
      // 忽略错误
    }
  }, 5000); // 每 5 秒检查一次
}

export function available() {
  return { ok: true };
}

export async function activate(ctx) {
  sender = ctx.sender;
  onebot = ctx.onebot;
  chatKey = ctx.chatKey;

  await loadState();

  // v5.0：确保环境与家族史已生成
  rollEnvironment();
  rollFamilyHistory();

  // v8.0：播下初始关系种子 + 生成过敏谱（依赖家族史，故放在其后）
  initRelations();
  rollAllergens();
  computeAllergyLoad();
  healthState.gutScore = Math.round(getGutScore() * 10) / 10;
  healthState.gutBarrier = Math.round(getGut('barrier') * 10) / 10;
  log(`[健康系统] 关系网 ${getRelationEffects().count} 人（${getRelationEffects().closest ? getRelationEffects().closest.name : '无'} 最亲近），过敏谱 ${Object.keys(healthState.allergens || {}).length} 项，菌群「${getGutLevel()}」，医保「${getInsurancePlan().info.name}」`);

  // 记录当前配置值，避免激活时把初始值同步过去覆盖已加载的状态
  const config = cfg();
  const statusKeys = ['thirst', 'hunger', 'energy', 'health', 'mood', 'sleep', 'fatigue', 'comfort', 'stress', 'loneliness', 'social', 'satisfaction', 'belonging', 'fever', 'addiction', 'curiosity', 'empathy', 'security', 'immunity', 'diet', 'exercise', 'sleepQuality', 'anxiety', 'depressionLevel', 'stability', 'focus', 'sleepDebt', 'electrolyte', 'calorieSurplus', 'mentalFatigue', 'intimacy', 'moodVolatility', 'physicalReserve'];
  for (const key of statusKeys) {
    const cfgKey = `${key}Initial`;
    if (config[cfgKey] !== undefined) {
      lastSyncedConfig[cfgKey] = config[cfgKey];
    }
  }

  if (decayTimer) clearInterval(decayTimer);
  if (checkTimer) clearInterval(checkTimer);

  decayTimer = setInterval(async () => {
    try {
      await decayHealth();
    } catch (error) {
      log(`[健康系统] 衰减检查失败：${error.message}`);
    }
  }, 300000);

  // 自动提醒已取消，不再启动 checkTimer
  log('[健康系统] 定时器已启动（仅状态衰减）');
}

export async function deactivate(ctx) {
  if (decayTimer) clearInterval(decayTimer);
  if (checkTimer) clearInterval(checkTimer);
  if (configSyncTimer) clearInterval(configSyncTimer);
  decayTimer = null;
  checkTimer = null;
  configSyncTimer = null;

  log('[健康系统] 定时器已停止');
}

export function dispose() {
  if (decayTimer) clearInterval(decayTimer);
  if (checkTimer) clearInterval(checkTimer);
  if (configSyncTimer) clearInterval(configSyncTimer);
  decayTimer = null;
  checkTimer = null;
  configSyncTimer = null;
}

// ── Providers ─────────────────────────────────────────────────────────────

// 保存数据到文件（持久化）
async function saveToFile() {
  const fs = await import('fs');

  try {
    if (storage?.writeJson) {
      storage.writeJson('health-data.json', healthState);
    } else {
      fs.writeFileSync(path.join(__dirname, 'health-data.json'), JSON.stringify(healthState, null, 2), 'utf8');
    }
  } catch (error) {
    log(`[健康系统] 保存数据失败：${error.message}`);
  }
}

export const providers = {
  'health.state': async ({ action, state, status, amount, extra } = {}) => {
    switch (action) {
      case 'get':
        return { state: { ...healthState } };

      case 'save':
        if (state) {
          healthState = { ...healthState, ...state };
          await saveToFile(); // 同时保存到文件
          return { ok: true };
        }
        return { ok: false, error: '缺少 state 参数' };

      case 'load':
        return { state: { ...healthState } };

      case 'mood':
        // 获取情绪摘要（不显示数值）
        return { mood: generateMoodSummary() };

      case 'emotion_hint':
        // 获取对话情绪提示
        return { hint: generateEmotionHint() };

      // 生理需求
      case 'heal':
        const healAmount = amount || 20;
        healthState.health = Math.min(100, healthState.health + healAmount);
        healthState.mood = Math.min(100, healthState.mood + 5);
        await saveToFile();
        return { ok: true, message: `💪 身体舒服多了，健康值 +${healAmount}~` };

      case 'cure':
        // 看病治疗（符合现代医疗体系）
        const beforeDiseases = [...healthState.diseases];

        if (beforeDiseases.length === 0) {
          return { ok: true, message: `医生检查了一下，身体没什么大问题，注意保养~` };
        }

        // 医疗费用（v3.0 经济系统；v5.0 按医院等级计价）
        const hosp = getHospitalInfo();
        const docSkill = rollDoctorSkill();
        const cureCost = hospitalCost('cure');
        if (!payMedicalOk(cureCost)) {
          return { ok: true, message: `🏥 看病挂号要 ¥${cureCost}，可我钱包里只剩 ¥${Math.round(getMoney())}…要不先去打份工？💦` };
        }

        // 现代医疗：疾病需要逐步恢复，不是一次治愈
        // 疾病阶段越严重，治疗难度越大
        let totalRecoveryChance = 0;
        const treatedDiseases = [];

        for (const diseaseKey of beforeDiseases) {
          const stage = getDiseaseStage(diseaseKey);
          let baseChance = 0.5; // 初期 50% 恢复率

          if (stage === '中期') baseChance = 0.35; // 中期 35%
          if (stage === '晚期') baseChance = 0.2;  // 晚期 20%
          if (stage === '危重') baseChance = 0.1;  // 危重 10%

          baseChance = Math.min(0.95, baseChance + getImmunityFactor() * 0.3 + (docSkill - 0.6) * 0.35); // 抵抗力 + 医生水平
          if (isDiagnosed(diseaseKey)) baseChance = Math.min(0.98, baseChance + 0.15); // 已确诊：对症下药
          if (getOrgan('blood') < 40 || getOrgan('liver') < 40) baseChance *= 0.9;     // 器官虚弱，恢复慢
          totalRecoveryChance += baseChance;

          if (Math.random() < baseChance) {
            if (isChronic(diseaseKey)) {
              // 慢性病无法根治，治愈后维持在初期稳定态
              healthState.diseaseStages[diseaseKey] = '初期';
            }
            treatedDiseases.push(diseaseKey);
          }
        }

        // 更新疾病状态：慢性病始终保留在列表（仅普通疾病被移除）
        const untreatedDiseases = beforeDiseases.filter(d => !treatedDiseases.includes(d));
        healthState.diseases = beforeDiseases.filter(d => isChronic(d) || !treatedDiseases.includes(d));

        // 清除已治疗（非慢性）疾病的阶段，并记录免疫记忆
        for (const diseaseKey of treatedDiseases) {
          if (!isChronic(diseaseKey)) {
            delete healthState.diseaseStages[diseaseKey];
            grantAntibody(diseaseKey);
          }
        }

        // 恢复健康值（根据治疗情况和疾病阶段）
        const healthRecovery = treatedDiseases.length * 8 + 5;
        healthState.health = Math.min(100, healthState.health + healthRecovery);
        healthState.mood = Math.min(100, healthState.mood + treatedDiseases.length * 3);
        if (treatedDiseases.length > 0) recordMedical(`${hosp.name}就医：缓解 ${treatedDiseases.length} 项（${treatedDiseases.join(',')}）`);

        await saveToFile();

        // 生成治疗反馈
        if (treatedDiseases.length === 0) {
          return { ok: true, message: `医生说病情有点棘手，需要慢慢调理，回去多休息，按时吃药~` };
        }

        // 检查是否有危重疾病
        const hasCritical = untreatedDiseases.some(d => getDiseaseStage(d) === '危重');

        if (hasCritical) {
          return { ok: true, message: `医生开了药，但有些病情比较严重，需要继续住院治疗，不能掉以轻心~` };
        }

        if (untreatedDiseases.length === 0) {
          return { ok: true, message: `${hosp.emoji}去了${hosp.name}，医生开了药，按医嘱服药，过几天应该能好起来~（花费 ¥${cureCost}）` };
        }

        return { ok: true, message: `${hosp.emoji}去了${hosp.name}，部分症状有所缓解，但还有些问题需要继续治疗，记得按时吃药~（花费 ¥${cureCost}）` };

      case 'check_health': {
        // 健康检查（v3.0 深度体检：体温/抵抗力/器官/体质/症状/病原/潜伏/免疫记忆/慢性/并发症/用药/预后/病历/钱包）
        syncFever(healthState.diseases);
        let report = generateDiseaseReport();
        const f = Math.round(Number(healthState.fever));
        report += `\n🌡️ 体温指标：${f >= 70 ? '发烧' : f >= 40 ? '低热' : '正常'}`;
        report += `\n🧬 抵抗力：${getStatusLevel(healthState.immunity, 'immunity')}（${Math.round(Number(healthState.immunity))}）`;
        const ci = getConstitutionInfo();
        report += `\n${ci.emoji} 体质：${ci.name} —— ${ci.desc}`;
        // 器官
        const organLine = Object.keys(ORGAN_INFO).map(k => {
          const v = getOrgan(k);
          return `${ORGAN_INFO[k].emoji}${ORGAN_INFO[k].name}${getOrganLevel(v)}`;
        }).join(' ');
        report += `\n🫀 器官状态：${organLine}`;
        if (healthState.diseases.length) {
          report += '\n🩺 症状明细：';
          for (const d of healthState.diseases) {
            const di = getDiseaseInfo(d);
            const pt = getPathogenInfo(d);
            const dx = isDiagnosed(d) ? '已确诊' : '未确诊';
            if (di) report += `\n  - ${di.emoji}${di.name}（${getDiseaseStage(d)}·${pt.emoji}${pt.name}·${dx}·${getDiseaseOrgan(d) ? getOrganInfo(getDiseaseOrgan(d)).name : ''}受累）：${di.symptoms}`;
          }
        }
        // 潜伏期（体检可查出）
        const incKeys = Object.keys(healthState.incubating || {});
        if (incKeys.length) {
          report += `\n🕓 潜伏中（尚未发病）：${incKeys.map(k => `${getDiseaseInfo(k)?.name || k}（${getPathogenInfo(k).name}）`).join('、')}`;
        }
        // 免疫记忆
        const abCount = getAntibodyCount();
        if (abCount) report += `\n🛡️ 免疫记忆：${abCount} 种疾病已有抗体（短期内不会复发）`;
        // 耐药性
        const resist = Object.entries(healthState.drugResistance || {}).filter(([, v]) => v >= 20);
        if (resist.length) report += `\n🧪 耐药性偏高：${resist.map(([k, v]) => `${MEDICINES[k]?.name || k}${Math.round(v)}%`).join('、')}`;
        const chronicActive = healthState.diseases.filter(d => isChronic(d));
        if (chronicActive.length) report += `\n♻️ 慢性病（需长期管理）：${chronicActive.map(d => getDiseaseInfo(d)?.name || d).join('、')}`;
        const risk = [...new Set(healthState.diseases.flatMap(d => getComplications(d)))].filter(x => !healthState.diseases.includes(x));
        if (risk.length) report += `\n⚠️ 并发症风险：${risk.map(x => getDiseaseInfo(x)?.name || x).join('、')}`;
        const recs = new Set();
        for (const d of healthState.diseases) for (const [mk, med] of Object.entries(MEDICINES)) if (med.targets.includes(d)) recs.add(med.name);
        if (recs.size) report += `\n💊 建议用药：${[...recs].join('、')}`;
        report += `\n📈 预后：${generatePrognosis(healthState.diseases)}`;
        const hist = healthState.medicalHistory || [];
        if (hist.length) report += `\n📋 近期病历 ${hist.length} 条（最近：${hist[hist.length - 1].text}）`;
        const box = getMedicineBoxSummary();
        report += `\n🎒 药箱：${box.length ? box.join(' ') : '（空，需要买药）'}`;
        report += `\n💰 钱包：¥${Math.round(getMoney())}（累计医疗花费 ¥${Math.round(Number(healthState.medicalCost) || 0)}）`;
        // v5.0 环境 / 医院 / 遗传 / 营养
        report += `\n🌤️ 环境：${getEnvSummary()}`;
        const hos = getHospitalInfo();
        report += `\n🏥 就诊医院：${hos.emoji}${hos.name}（医生水平 ${Math.round(hos.skill * 100)}%，费用 ×${hos.costMul}）`;
        const fam = getFamilyHistoryList();
        if (fam.length) report += `\n🧬 家族史：${fam.map(k => `${FAMILY_HISTORY[k].emoji}${FAMILY_HISTORY[k].name}`).join('、')}（对应疾病易感 ×1.8）`;
        else report += `\n🧬 家族史：无明显遗传病`;
        const nutLines = Object.entries(NUTRIENT_INFO).map(([k, n]) => `${n.emoji}${n.name}${Math.round(getNutrient(k))}`);
        report += `\n🥗 营养：${nutLines.join(' ')}`;
        // v4.0 临床检验指标
        const cv = computeVitals();
        const cAbn = getAbnormalVitals(cv);
        report += `\n\n🩸 检验指标（综合评分 ${getVitalScore(cv)}/100）：`;
        if (cAbn.length) {
          for (const x of cAbn) report += `\n  ${x.severe ? '🚨' : '⚠️'} ${x.info.name}：${formatVitalValue(x.info, x.value)} ${x.info.unit}（${x.level}）`;
        } else {
          report += '\n  ✅ 全部指标正常';
        }
        report += `\n  关键值：血压 ${cv.bpSys}/${cv.bpDia}　心率 ${cv.heartRate}　体温 ${formatVitalValue(getVitalInfo('bodyTemp'), cv.bodyTemp)}℃　血糖 ${cv.bloodSugar}　血红蛋白 ${cv.hemoglobin}`;
        // v14.0：补充炎症/内分泌/凝血/尿液摘要
        report += `\n  补充值：CRP ${cv.crp} mg/L　ESR ${cv.esr} mm/h　TSH ${cv.tsh}　皮质醇 ${cv.cortisol} nmol/L　胰岛素 ${cv.insulin} μIU/mL`;
        report += `\n  补充值：INR ${cv.inr}　D-二聚体 ${cv.dDimer} mg/L　尿蛋白 ${cv.urineProtein} mg/24h　尿糖 ${cv.urineGlucose} mmol/L`;
        const lifeInfo = getLifestyleInfo();
        report += `\n🌱 生活方式：🥗饮食${lifeInfo.diet.value} 🏃运动${lifeInfo.exercise.value} 😴睡眠${lifeInfo.sleepQuality.value}　⚖️BMI ${lifeInfo.bmi.value}（${lifeInfo.bmi.level}）`;
        // v6.0 心理 / 睡眠 / 内分泌 / 外伤 / 疫情 / 习惯 / 成就 / 年龄
        report += `\n\n🧠 心理：😟焦虑${Math.round(Number(healthState.anxiety))} 🌧️抑郁${Math.round(Number(healthState.depressionLevel))} 🧘情绪稳定${Math.round(Number(healthState.stability))} 🎯专注力${Math.round(Number(healthState.focus))}`;
        if (Number(healthState.anxiety) >= 65 || Number(healthState.depressionLevel) >= 65) report += '（建议做心理咨询或冥想）';
        const sst = SLEEP_STAGES[healthState.sleepStage] || SLEEP_STAGES.awake;
        report += `\n😴 睡眠：当前${sst.emoji}${sst.name}　负债${Math.round(Number(healthState.sleepDebt))}/100　咖啡因${Math.round(Number(healthState.caffeine))}　生物钟偏移${Number(healthState.sleepClock) > 0 ? '+' : ''}${healthState.sleepClock}`;
        report += `\n🔬 内分泌：${Object.entries(HORMONE_INFO).map(([k, h]) => `${h.emoji}${h.name}${Math.round(getHormone(k))}(${getHormoneLevel(getHormone(k))})`).join(' ')}`;
        const injList = Array.isArray(healthState.injuries) ? healthState.injuries : [];
        if (injList.length) {
          report += `\n🩹 外伤：${injList.map(i => `${INJURY_INFO[i.type]?.emoji || '🩹'}${i.part}${INJURY_INFO[i.type]?.name || ''}(${Math.round(i.severity)})`).join('、')}`;
        } else {
          report += `\n🩹 外伤：无未愈合伤口（累计受伤 ${Number(healthState.scarCount) || 0} 次）`;
        }
        const epNow = healthState.epidemic || {};
        report += `\n🦠 疫情：${epNow.active ? `${getDiseaseInfo(epNow.disease)?.name || epNow.disease}（${getEpidemicLevelName(epNow.level)}）` : '平稳'}　😷 口罩：${healthState.maskOn ? '已戴' : '未戴'}`;
        const hbList = Object.entries(HABIT_INFO).filter(([k]) => getHabit(k) >= 50);
        if (hbList.length) report += `\n📋 习惯：${hbList.map(([k, h]) => `${h.emoji}${h.name}${Math.round(getHabit(k))}${h.good ? '👍' : '⚠️'}`).join(' ')}`;
        report += `\n🏆 成就：${Object.keys(healthState.achievements || {}).length}/${Object.keys(ACHIEVEMENTS).length}　🎂 年龄：${Math.round(Number(healthState.age) || 20)} 岁（衰减 ×${(1 + Math.max(0, (Number(healthState.age) || 20) - 30) * 0.012).toFixed(2)}）`;
        // v7.0 基础需求深化：深层生理亚成分与连锁反应
        if (needDepthOn()) {
          report += `\n\n🌊 深层生理：${Object.entries(SUBSYSTEM_INFO).map(([k, i]) => `${i.emoji}${i.name}${Math.round(getSub(k))}`).join(' ')}`;
          const cwNow = getCascadeWarnings();
          if (cwNow.length) report += `\n🔗 连锁反应：${cwNow.map(w => `${getStatusOrSubName(w.from)}→${getStatusOrSubName(w.to)}`).join('、')}（身体正被层层拖累）`;
        }
        const critical = healthState.diseases.some(d => getDiseaseStage(d) === '危重');
        if (critical) report += '\n🚨 有危重症状，建议立即就医/住院！';
        else if (healthState.diseases.length) report += '\n💡 建议：按时吃药、多休息，必要时就医。';
        else report += '\n💡 状态不错，继续保持规律作息~';
        return { ok: true, message: report };
      }

      case 'drink': {
        const want = amount || 20;
        const el0 = getSub('electrolyte');
        // v7.0：电解质过低时白水吸收效率打折——喝下去也解不了渴
        const dilutePenalty = (needDepthOn() && el0 < 35) ? 0.5 : 1;
        const r = restoreNeed('thirst', want * dilutePenalty);
        // 白水不含电解质：喝进去的水越多，体内电解质被稀释得越明显
        if (needDepthOn()) {
          healthState.electrolyte = Math.max(0, getSub('electrolyte') - r.gain * 0.25);
        }
        healthState.mood = Math.min(100, healthState.mood + 5);
        await saveToFile();
        const th = Number(healthState.thirst) || 0;
        if (needDepthOn() && el0 < 35) {
          return { ok: true, message: `💧 灌了一大杯水，身体却有点敷衍——电解质偏低（${Math.round(getSub('electrolyte'))}/100），光喝白水不太解渴，该补点淡盐水或运动饮料了。当前：${getNeedPhase('thirst', th)}。` };
        }
        if (r.gain < 3) return { ok: true, message: `💧 其实不太渴，还是勉强抿了两口（${getNeedPhase('thirst', th)}）。` };
        return { ok: true, message: `💧 喝了一杯水，渴意退了不少，现在是「${getNeedPhase('thirst', th)}」状态~` };
      }

      case 'eat': {
        // v11.0：指定了菜品就走菜单（三餐选择权）；给了个不认识的名字→列出可选项
        if (status && MEALS[status]) {
          const r = eatMeal(status);
          if (!r.ok) return { ok: false, error: r.error };
          await saveToFile();
          return { ok: true, message: r.message };
        }
        if (status && mealOn()) {
          const list = getMealList()
            .map(x => `${x.info.emoji}${x.info.name}(${x.key})${x.ok ? '' : '·' + x.why}`)
            .join('　');
          return { ok: false, error: `没有「${status}」这种吃的。可以点：\n${list}` };
        }
        const want = amount || 20;
        const r = restoreNeed('hunger', want);
        healthState.mood = Math.min(100, healthState.mood + 8);
        healthState.satisfaction = Math.min(100, healthState.satisfaction + 5);
        // v7.0：吃撑了 → 溢出为热量盈余，还会顶得有点难受
        let overflowTip = '';
        if (needDepthOn() && r.overflow > 0) {
          healthState.calorieSurplus = Math.min(100, getSub('calorieSurplus') + r.overflow * 0.6);
          healthState.comfort = Math.max(0, (Number(healthState.comfort) || 0) - r.overflow * 0.3);
          overflowTip = '（有点吃撑了…）';
        }
        // 菜肴含盐分，顺便补一点电解质
        if (needDepthOn()) healthState.electrolyte = Math.min(100, getSub('electrolyte') + 4);
        // v4.0：随机饮食质量——健康餐抬升饮食健康度，油炸/甜食拉低（影响血脂血糖）
        // v13.0：这里原本是 Math.random() < 0.45 掷一个抽象的"健康/不健康"——与 v11.0
        //   铲掉的那处骰子是同一类遗漏（无参 eat 走的这条兜底路径）。改成真的随机挑一道
        //   家常菜，营养素按挑中的菜结算，于是「吃了什么」终于是有名有姓的。
        const casualPool = ['home_cook', 'canteen', 'takeout', 'instant'];
        const casual = MEALS[casualPool[Math.floor(Math.random() * casualPool.length)]] || MEALS.home_cook;
        const healthyMeal = (Number(casual.nut) || 0) >= 0;
        if (casual.nutrition) {
          for (const [nk, nv] of Object.entries(casual.nutrition)) if (nv) addNutrient(nk, nv);
        }
        adjustLifestyle('diet', healthyMeal ? 6 : -8);
        // v8.0：进食直接影响肠道菌群（膳食纤维喂好菌，油炸高糖养坏菌）
        //   ⚠️ healGut / damageGut 内部都有 a <= 0 就 return 0 的守卫，
        //      早前写成 healGut(healthyMeal ? 1.8 : -1.7) 会被静默吞掉，
        //      「油炸高糖养坏菌」其实从未生效 —— 必须分正负各自调用
        if (gutOn()) {
          if (healthyMeal) healGut(1.8);
          else damageGut(1.7);
        }
        // v8.0：食源性过敏原可能在进食时被触发
        const foodAllergy = rollFoodAllergy();
        let allergyTip = '';
        if (foodAllergy.length) {
          const names = foodAllergy.map(x => x.name).join('、');
          allergyTip = `\n🤧 吃完有点不对劲——对${names}过敏，身上开始起反应了（过敏负荷 +${foodAllergy.reduce((a, x) => a + x.delta, 0)}）`;
        }
        await saveToFile();
        const baseMsg = healthyMeal
          ? `🍚 吃了顿${casual.emoji}${casual.name}（有菜有蛋白），好吃又养生~${overflowTip}`
          : `🍚 吃了顿${casual.emoji}${casual.name}（油大味重），超满足…就是有点罪恶感~${overflowTip}`;
        const menuTip = mealOn()
          ? '\n💡 想点具体的可以说：自己下厨 / 点外卖 / 泡面 / 快餐 / 食堂 / 火锅 / 夜宵 / 下馆子 / 朋友聚餐'
          : '';
        return { ok: true, message: baseMsg + allergyTip + menuTip };
      }

      case 'rest': {
        const restAmount = amount || 25;
        restoreNeed('energy', restAmount);
        restoreNeed('fatigue', restAmount);
        // v7.0：小憩也能缓解精神疲劳与情绪波动，但不如睡眠彻底
        if (needDepthOn()) {
          relieveNeed('mentalFatigue', restAmount * 0.6);
          relieveNeed('moodVolatility', restAmount * 0.3);
        }
        healthState.mood = Math.min(100, healthState.mood + 5);
        await saveToFile();
        return { ok: true, message: `⚡ 休息了一下，精神多了~` };
      }

      case 'sleep': {
        const sleepAmount = amount || 30;
        // v13.0：周末或节日的懒觉睡得格外沉 —— 恢复量 +35%、睡眠负债还得更快
        const lazyDay = weekdayOn() && (isWeekend() || !!(festivalOn() && getTodayFestival()));
        restoreNeed('sleep', Math.round(sleepAmount * (lazyDay ? 1.35 : 1)));
        restoreNeed('energy', Math.round(sleepAmount * 0.8));
        restoreNeed('fatigue', Math.round(sleepAmount * 0.8));
        // v7.0：睡眠是精神疲劳与情绪波动的最佳解药，还能养回体力储备、抵扣睡眠负债
        if (needDepthOn()) {
          relieveNeed('mentalFatigue', sleepAmount * (lazyDay ? 1.3 : 1.0));
          relieveNeed('moodVolatility', sleepAmount * 0.5);
          restoreNeed('physicalReserve', sleepAmount * 0.3);
          healthState.sleepDebt = Math.max(0, (Number(healthState.sleepDebt) || 0) - sleepAmount * (lazyDay ? 0.8 : 0.5));
        }
        healthState.mood = Math.min(100, healthState.mood + (lazyDay ? 14 : 10));
        adjustLifestyle('sleepQuality', 15); // v4.0：睡眠质量影响血压/心率
        await saveToFile();
        return { ok: true, message: lazyDay ? `😴 睡到自然醒。${getWeekdayInfo().name}的早晨格外安静，这一觉睡得踏实。` : `😴 睡了一觉，满血复活！` };
      }

      case 'comfort':
        const comfortAmount = amount || 20;
        healthState.comfort = Math.min(100, healthState.comfort + comfortAmount);
        healthState.mood = Math.min(100, healthState.mood + 5);
        await saveToFile();
        return { ok: true, message: `🛋️ 找到舒服的地方，好惬意~` };

      // 心理需求
      case 'relax': {
        const relaxAmount = amount || 20;
        restoreNeed('stress', relaxAmount);
        restoreNeed('fatigue', relaxAmount * 0.5);
        // v7.0：放松能疏解精神疲劳与情绪波动
        if (needDepthOn()) {
          relieveNeed('mentalFatigue', relaxAmount * 0.5);
          relieveNeed('moodVolatility', relaxAmount * 0.4);
        }
        healthState.mood = Math.min(100, healthState.mood + 10);
        adjustLifestyle('sleepQuality', 6); // v4.0：放松有助于睡眠质量
        await saveToFile();
        return { ok: true, message: `😌 放松了一下，压力小多了~` };
      }

      case 'happy':
        const happyAmount = amount || 20;
        healthState.mood = Math.min(100, healthState.mood + happyAmount);
        healthState.satisfaction = Math.min(100, healthState.satisfaction + 10);
        await saveToFile();
        return { ok: true, message: `😊 好开心呀！` };

      case 'achieve':
        const achieveAmount = amount || 20;
        healthState.satisfaction = Math.min(100, healthState.satisfaction + achieveAmount);
        healthState.mood = Math.min(100, healthState.mood + 10);
        healthState.belonging = Math.min(100, healthState.belonging + 5);
        await saveToFile();
        return { ok: true, message: `🎯 有成就感！好棒！` };

      // 社交需求
      case 'chat': {
        restoreNeed('loneliness', 20);
        restoreNeed('social', 20);
        restoreNeed('belonging', 5);
        healthState.mood = Math.min(100, healthState.mood + 10);
        healthState.energy = Math.max(0, (Number(healthState.energy) || 0) - 3);
        // v7.0：聊天能补上亲密需求，但也会消耗一点精神
        if (needDepthOn()) {
          restoreNeed('intimacy', 12);
          healthState.mentalFatigue = Math.min(100, getSub('mentalFatigue') + 1.5);
        }
        await saveToFile();
        return { ok: true, message: `🤝 和你聊天很开心！` };
      }

      case 'join': {
        restoreNeed('belonging', 25);
        restoreNeed('loneliness', 15);
        healthState.mood = Math.min(100, healthState.mood + 10);
        // v7.0：融入群体也能略微填补亲密需求
        if (needDepthOn()) restoreNeed('intimacy', 8);
        await saveToFile();
        return { ok: true, message: `🏠 融入群里，感觉有归属感了~` };
      }

      case 'gather': {
        const gatherAmount = amount || 20;
        restoreNeed('social', gatherAmount);
        restoreNeed('loneliness', gatherAmount);
        restoreNeed('belonging', Math.round(gatherAmount * 0.5));
        healthState.mood = Math.min(100, healthState.mood + 10);
        // v7.0：热闹的聚会能补亲密需求，但也挺费神
        if (needDepthOn()) {
          restoreNeed('intimacy', gatherAmount * 0.6);
          healthState.mentalFatigue = Math.min(100, getSub('mentalFatigue') + gatherAmount * 0.15);
        }
        await saveToFile();
        return { ok: true, message: `🎉 大家聚在一起，好热闹！` };
      }

      // —— 拓展动作（v0.5）——
      case 'exercise': {
        const ex = amount || 20;
        healthState.energy = Math.max(0, healthState.energy - Math.round(ex * 0.5));
        healthState.fatigue = Math.min(100, healthState.fatigue + Math.round(ex * 0.6));
        healthState.hunger = Math.min(100, healthState.hunger + Math.round(ex * 0.4));
        healthState.mood = Math.min(100, healthState.mood + 5);
        healthState.health = Math.min(100, healthState.health + 3);
        healthState.stress = Math.min(100, healthState.stress + 5);
        healthState.immunity = Math.min(100, healthState.immunity + 3);
        adjustLifestyle('exercise', 12); // v4.0：运动习惯提升 → 血压/血脂/血糖长期改善
        // v8.0：规律运动能提升肠道菌群多样性（运动改变菌群结构是被证实的效应）
        if (gutOn()) { setGut('diversity', getGut('diversity') + 2.5); setGut('bifido', getGut('bifido') + 1.2); }
        await saveToFile();
        return { ok: true, message: `💪 运动了一下，出了点汗，神清气爽~（运动习惯 → ${getLifestyleInfo().exercise.value}）` };
      }
      case 'play_game': {
        const pg = amount || 20;
        healthState.addiction = Math.min(100, healthState.addiction + Math.round(pg * 0.5));
        healthState.mood = Math.min(100, healthState.mood + 8);
        healthState.loneliness = Math.min(100, healthState.loneliness + 10);
        healthState.energy = Math.max(0, healthState.energy - 5);
        await saveToFile();
        return { ok: true, message: `🎮 玩了会游戏，好上头~（不过别玩太久哦）` };
      }
      case 'listen_music': {
        const lm = amount || 20;
        healthState.stress = Math.min(100, healthState.stress + Math.round(lm * 0.8));
        healthState.mood = Math.min(100, healthState.mood + 8);
        healthState.fatigue = Math.min(100, healthState.fatigue + 5);
        await saveToFile();
        return { ok: true, message: `🎵 听了首歌，心情放松多了~` };
      }
      case 'walk': {
        const wk = amount || 20;
        healthState.energy = Math.max(0, healthState.energy - Math.round(wk * 0.3));
        healthState.mood = Math.min(100, healthState.mood + 6);
        healthState.stress = Math.min(100, healthState.stress + 6);
        healthState.comfort = Math.min(100, healthState.comfort + 5);
        healthState.security = Math.min(100, healthState.security + 5);
        adjustLifestyle('exercise', 6); // v4.0：散步也算运动量
        await saveToFile();
        return { ok: true, message: `🚶 散了散步，吹吹风，舒服~` };
      }
      case 'take_medicine': {
        const order = ['初期', '中期', '晚期', '危重'];
        // 靶向选药：按当前疾病匹配药物，且药箱里必须有货
        const matched = [];
        for (const [mKey, med] of Object.entries(MEDICINES)) {
          if (!healthState.diseases.some(d => med.targets.includes(d))) continue;
          if (getMedicineStock(mKey) <= 0) continue;
          matched.push(mKey);
        }
        if (matched.length === 0) {
          // 有对症病症但药箱空了 → 提示去买药
          const needed = new Set();
          for (const d of healthState.diseases) {
            for (const [mk, med] of Object.entries(MEDICINES)) if (med.targets.includes(d)) needed.add(med.name);
          }
          if (needed.size) return { ok: true, message: `💊 药箱没有对症的药了（需要：${[...needed].join('、')}），去补点药吧~` };
          healthState.mood = Math.min(100, healthState.mood + 1);
          await saveToFile();
          return { ok: true, message: '💊 没病就别乱吃药啦，是药三分毒~' };
        }
        let feverReliefTotal = 0, healthGain = 0, moodGain = 0;
        const healed = [];
        const sideNotes = [];
        const usedNames = [];
        for (const mKey of matched) {
          const med = MEDICINES[mKey];
          const eff = getDrugEfficacy(mKey); // 耐药性导致药效打折
          consumeMedicine(mKey, 1);
          usedNames.push(`${med.name}${eff < 0.7 ? '(药效打折)' : ''}`);
          feverReliefTotal += med.feverRelief * eff;
          healthGain += med.health * eff;
          moodGain += med.mood * eff;
          for (const d of [...healthState.diseases]) {
            if (!med.targets.includes(d)) continue;
            const stage = getDiseaseStage(d);
            const immBoost = getImmunityFactor() * 0.3;
            const dxBoost = isDiagnosed(d) ? 0.15 : 0;
            if (stage !== '初期') {
              updateDiseaseStage(d, order[order.indexOf(stage) - 1]);
              if (!healed.includes(d)) healed.push(d);
            } else if (Math.random() < (0.5 + immBoost + dxBoost) * eff) {
              if (isChronic(d)) {
                advanceChronic(d); // v13.0：慢性病改为「长期管理 → 缓解期」
              } else {
                healthState.diseases = healthState.diseases.filter(x => x !== d);
                delete healthState.diseaseStages[d];
                grantAntibody(d); // 痊愈 → 免疫记忆
              }
              if (!healed.includes(d)) healed.push(d);
            }
          }
          // 副作用 & 耐药性累积
          const notes = applySideEffects(mKey);
          if (notes.length) sideNotes.push(`${med.name}：${notes.join('、')}`);
          addDrugResistance(mKey, undefined);
          // v8.0：抗生素不分敌我，会同时重创肠道菌群（多样性掉得最狠，需益生菌 + 高纤维慢慢补回）
          if (mKey === 'antibiotic') {
            damageGut(12);
            sideNotes.push(`${med.name}：肠道菌群遭重创（多样性降到 ${Math.round(getGut('diversity'))}）`);
          }
        }
        let msg = '💊 吃了药';
        if (Number(healthState.fever) > 0) {
          const fr = feverReliefTotal > 0 ? feverReliefTotal : 10;
          healthState.fever = Math.max(0, healthState.fever - fr);
          msg += feverReliefTotal > 0 ? '，退烧药见效' : '，退了点烧';
        } else if (feverReliefTotal > 0) {
          msg += '，吃了退烧药';
        }
        healthState.health = Math.min(100, healthState.health + healthGain + 3);
        healthState.mood = Math.min(100, healthState.mood + moodGain + 2);
        recordMedical(`服药：${usedNames.join('+')}${healed.length ? `，缓解 ${healed.length} 项` : ''}${sideNotes.length ? `；副作用 ${sideNotes.join('；')}` : ''}`);
        await saveToFile();
        let out = `${msg}（${usedNames.join('+')}）`;
        if (sideNotes.length) out += `\n⚠️ 副作用：${sideNotes.join('；')}`;
        out += '\n剩下 ' + (getMedicineBoxSummary().join(' ') || '（药箱已空）') + '，记得按时吃药、多休息~';
        return { ok: true, message: out };
      }
      case 'prescribe': {
        const ds = healthState.diseases;
        if (ds.length === 0) return { ok: true, message: '📝 目前没有需要用药的疾病，保持好习惯即可~' };
        const recs = new Set();
        for (const d of ds) for (const [mk, med] of Object.entries(MEDICINES)) if (med.targets.includes(d)) recs.add(`${med.emoji}${med.name}`);
        let msg = `📝 用药建议：\n${[...recs].map(n => '  - ' + n).join('\n')}`;
        msg += ds.some(d => getDiseaseStage(d) === '危重') ? '\n🚨 有危重症状，建议尽快就医/住院！' : '\n💡 按医嘱服药，多休息。';
        return { ok: true, message: msg };
      }
      case 'hospitalize': {
        const ds = healthState.diseases;
        if (ds.length === 0) return { ok: true, message: '🏥 医生检查后说没啥大问题，注意保养就好~' };
        const hCost = hospitalCost('hospitalize');
        if (!payMedicalOk(hCost)) {
          return { ok: true, message: `🏥 住院押金要 ¥${hCost}，我只有 ¥${Math.round(getMoney())}…先攒钱吧，别硬扛！💦` };
        }
        const critical = ds.some(d => getDiseaseStage(d) === '危重');
        let cured = 0;
        for (const d of [...ds]) {
          const stage = getDiseaseStage(d);
          let chance = stage === '危重' ? 0.5 : stage === '晚期' ? 0.4 : stage === '中期' ? 0.6 : 0.8;
          chance = Math.min(0.96, chance + getImmunityFactor() * 0.2 + (getHospitalInfo().skill - 0.6) * 0.3);
          if (isDiagnosed(d)) chance = Math.min(0.98, chance + 0.1); // 确诊后精准治疗
          if (isChronic(d) && getHospitalInfo().chronic) chance = Math.min(0.98, chance + 0.2); // 中医院擅长慢性病调理
          if (Math.random() < chance) {
            if (isChronic(d)) advanceChronic(d);
            else {
              healthState.diseases = healthState.diseases.filter(x => x !== d);
              delete healthState.diseaseStages[d];
              grantAntibody(d);
            }
            cured++;
          }
        }
        healthState.health = Math.min(100, healthState.health + cured * 10 + 5);
        healthState.energy = Math.max(0, healthState.energy - 10);
        healthState.comfort = Math.min(100, healthState.comfort - 5);
        healthState.mood = Math.max(0, healthState.mood - 3);
        recordMedical(`住院：缓解 ${cured} 项${critical ? '（含危重）' : ''}`);
        await saveToFile();
        if (cured === 0) return { ok: true, message: '🏥 住院观察中，病情比较复杂，医生正在全力治疗，别太担心~' };
        return { ok: true, message: `🏥 住院治疗后 ${cured} 项症状明显改善，好好休养~` };
      }
      case 'rest_cure': {
        const ds = healthState.diseases;
        let relieved = 0;
        for (const d of [...ds]) {
          const stage = getDiseaseStage(d);
          if (stage === '初期' && Math.random() < 0.35 + getImmunityFactor() * 0.3) {
            if (isChronic(d)) advanceChronic(d);
            else {
              healthState.diseases = healthState.diseases.filter(x => x !== d);
              delete healthState.diseaseStages[d];
              grantAntibody(d);
            }
            relieved++;
          }
        }
        healthState.health = Math.min(100, healthState.health + 5);
        healthState.immunity = Math.min(100, healthState.immunity + 3);
        healthState.mood = Math.min(100, healthState.mood + 5);
        healthState.energy = Math.min(100, healthState.energy + 8);
        healthState.fatigue = Math.min(100, healthState.fatigue + 8);
        recordMedical(`静养：缓解 ${relieved} 项`);
        await saveToFile();
        return { ok: true, message: `🛌 静养调理了一下，身心舒缓，缓解了 ${relieved} 项症状~` };
      }
      case 'measure': {
        // 基础测量（v4.0）：四大生命体征；要查全项得去抽血化验
        syncFever(healthState.diseases);
        const mv = computeVitals();
        const tlv = getVitalLevel('bodyTemp', mv.bodyTemp);
        const tempDesc = tlv === '正常' ? '😌 体温正常' : (mv.bodyTemp > 37.2 ? '🤒 体温偏高，好像发烧了' : '🥶 体温偏低，有点发冷');
        const bpOk = getVitalLevel('bpSys', mv.bpSys) === '正常' && getVitalLevel('bpDia', mv.bpDia) === '正常';
        let mmsg = `🩺 基础测量：体温 ${formatVitalValue(getVitalInfo('bodyTemp'), mv.bodyTemp)}℃，血压 ${mv.bpSys}/${mv.bpDia} mmHg，心率 ${mv.heartRate} 次/分，血氧 ${mv.spo2}%。`;
        mmsg += `\n${tempDesc}，${bpOk ? '血压正常' : '血压有点异常'}。`;
        const coreAbn = getAbnormalVitals(mv).filter(x => ['bpSys', 'bpDia', 'heartRate', 'spo2', 'bodyTemp', 'respiratoryRate'].includes(x.key));
        if (coreAbn.length) mmsg += `\n⚠️ 需要注意：${coreAbn.map(x => `${x.info.name}${x.level}`).join('、')}。想查全项就抽个血化验吧~`;
        return { ok: true, message: mmsg };
      }
      case 'bond_view': {
        const bonds = healthState.bonds || {};
        const list = Object.entries(bonds).map(([uid, b]) => `  - ${b.name || uid}: 亲密度 ${b.affinity || 0}`);
        return { ok: true, message: list.length ? `💞 关系羁绊：\n${list.join('\n')}` : '💞 关系羁绊：还没有特别亲密的人~' };
      }
      case 'bond_care': {
        const bonds = healthState.bonds || {};
        const uids = Object.keys(bonds);
        if (!uids.length) return { ok: true, message: '💞 暂时没有可以关心的人~' };
        uids.sort((a, b) => (bonds[b].affinity || 0) - (bonds[a].affinity || 0));
        const top = bonds[uids[0]];
        return { ok: true, message: `💞 想起 ${top.name || uids[0]} 了，主动关心一下 TA 吧~` };
      }

      // —— 生理深度模拟动作（v3.0）——
      case 'exam': {
        // 检查化验：确诊疾病 / 检出潜伏期隐患（花费金钱，有误诊概率）
        const examCost = hospitalCost('exam');
        if (!payMedicalOk(examCost)) {
          return { ok: true, message: `🧪 化验要 ¥${examCost}，我钱包里只有 ¥${Math.round(getMoney())}…先攒点钱吧~` };
        }
        if (!healthState.diagnosed) healthState.diagnosed = {};
        const examTargets = [...healthState.diseases, ...Object.keys(healthState.incubating || {})];
        if (examTargets.length === 0) {
          return { ok: true, message: `🧪 抽血、化验一通，各项指标都正常，身体棒棒的~（花费 ¥${examCost}）` };
        }
        const accuracy = rollDoctorSkill(); // v5.0：确诊准确率取决于医生水平
        const lines = [];
        let confirmed = 0;
        for (const d of examTargets) {
          const di = getDiseaseInfo(d);
          const pt = getPathogenInfo(d);
          const incubating = isIncubating(d);
          if (Math.random() < accuracy) {
            healthState.diagnosed[d] = true;
            confirmed++;
            lines.push(`  ✅ ${di?.emoji || ''}${di?.name || d}〔${pt.emoji}${pt.name}〕${incubating ? '（潜伏期已检出！）' : `（${getDiseaseStage(d)}·${getOrganInfo(getDiseaseOrgan(d)).name}受累）`} 症状：${di?.symptoms || '—'}`);
          } else {
            lines.push(`  ❓ ${incubating ? '某项指标异常' : (di?.name || d)}：指标不典型，暂时无法确诊，建议复查`);
          }
        }
        recordMedical(`化验检查：确诊 ${confirmed} 项`);
        await saveToFile();
        return { ok: true, message: `🧪 检查化验结果（${getHospitalInfo().emoji}${getHospitalInfo().name}，花费 ¥${examCost}）：\n${lines.join('\n')}\n💡 确诊后就医/用药成功率会提升；嫌不准就换更好的医院。` };
      }
      case 'vaccinate': {
        const vCost = getMedicalCost('vaccine');
        const nowV = Date.now();
        const cooldown = 7 * 86400000;
        const lastV = Number(healthState.lastVaccine) || 0;
        if (nowV - lastV < cooldown) {
          const leftDays = Math.ceil((cooldown - (nowV - lastV)) / 86400000);
          return { ok: true, message: `💉 刚打过疫苗，还要 ${leftDays} 天才能再打~` };
        }
        if (!payMedicalOk(vCost)) {
          return { ok: true, message: `💉 疫苗要 ¥${vCost}，我只有 ¥${Math.round(getMoney())}…再等等吧~` };
        }
        // 覆盖：全部传染病 + 当季季节传染病
        const season = getCurrentSeason();
        const targets = new Set();
        for (const k of DISEASE_FLAGS.contagious) if (getPathogenInfo(k)?.contagious) targets.add(k);
        for (const [k, d] of Object.entries(SEASONAL_DISEASES)) if (isContagious(k) && d.season === season) targets.add(k);
        for (const k of targets) grantAntibody(k, 30);
        healthState.lastVaccine = nowV;
        healthState.immunity = Math.min(100, Number(healthState.immunity) + 5);
        recordMedical(`接种疫苗：覆盖 ${targets.size} 种传染病`);
        await saveToFile();
        return { ok: true, message: `💉 打了疫苗（花费 ¥${vCost}），覆盖 ${targets.size} 种传染病，抵抗力 +5，接下来 30 天不容易被传染啦~` };
      }
      // —— 临床检验指标动作（v4.0）——
      case 'blood_test': {
        // 抽血化验：出完整检验报告（花钱），并留存历史快照供趋势对比
        const bCost = hospitalCost('blood');
        if (!payMedicalOk(bCost)) {
          return { ok: true, message: `🧪 抽血化验要 ¥${bCost}，我只有 ¥${Math.round(getMoney())}…先攒点钱吧~` };
        }
        const bv = computeVitals();
        const bAbn = getAbnormalVitals(bv);
        const bScore = getVitalScore(bv);
        let bmsg = `🧪 抽血化验报告（花费 ¥${bCost}）　综合评分 ${bScore}/100\n`;
        bmsg += generateVitalsReport({ vitals: bv });
        bmsg += `\n\n${bAbn.length ? `⚠️ 共 ${bAbn.length} 项异常：${bAbn.map(x => `${x.info.name}${x.level}`).join('、')}` : '✅ 所有指标都在正常范围内，身体很棒！'}`;
        if (!Array.isArray(healthState.vitalsHistory)) healthState.vitalsHistory = [];
        healthState.vitalsHistory.push({ date: localDayKey(), values: bv, score: bScore });
        if (healthState.vitalsHistory.length > 12) healthState.vitalsHistory = healthState.vitalsHistory.slice(-12);
        healthState.lastBloodTest = Date.now();
        recordMedical(`抽血化验：${bAbn.length ? bAbn.map(x => x.info.name + x.level).join('、') : '各项正常'}`);
        const bHist = healthState.vitalsHistory;
        if (bHist.length >= 2) {
          const prev = bHist[bHist.length - 2], cur = bHist[bHist.length - 1];
          const dScore = cur.score - prev.score;
          bmsg += `\n📈 与上次（${prev.date}）相比：综合评分 ${dScore > 0 ? '+' + dScore : dScore} 分`;
        }
        await saveToFile();
        return { ok: true, message: bmsg };
      }
      case 'vital_check': {
        // 指标速览：只列异常项，不花钱
        const vv = computeVitals();
        const vAbn = getAbnormalVitals(vv);
        const vScore = getVitalScore(vv);
        if (!vAbn.length) return { ok: true, message: `🩺 指标速览：全部正常，综合评分 ${vScore}/100，身体状态不错~` };
        const vLines = vAbn.map(x => `  ${x.severe ? '🚨' : '⚠️'} ${x.info.name}(${x.info.short})：${formatVitalValue(x.info, x.value)} ${x.info.unit}　${x.level}`);
        return { ok: true, message: `🩺 指标速览（综合评分 ${vScore}/100）：\n${vLines.join('\n')}\n💡 改善方向：清淡饮食 + 规律运动；数值很离谱就尽快就医。` };
      }
      case 'diet_control': {
        // 清淡饮食：提升饮食健康度（长期降血脂/血糖/尿酸）
        const dNow = Date.now();
        const dCd = 4 * 3600000; // 4 小时冷却
        const dLast = Number(healthState.lastDiet) || 0;
        if (dNow - dLast < dCd) {
          const dLeft = Math.ceil((dCd - (dNow - dLast)) / 3600000);
          return { ok: true, message: `🥗 刚吃过清淡餐，${dLeft} 小时后再来一顿吧~` };
        }
        adjustLifestyle('diet', 22);
        healthState.hunger = Math.min(100, Number(healthState.hunger) + 8);
        healthState.mood = Math.max(0, Number(healthState.mood) - 3);
        healthState.lastDiet = dNow;
        await saveToFile();
        const dLife = getLifestyleInfo();
        return { ok: true, message: `🥗 吃了顿清淡的（少油少盐少糖），饮食健康度 → ${dLife.diet.value}（${dLife.diet.level}）。长期坚持，血脂血糖尿酸都会好看很多~` };
      }
      case 'weigh': {
        const wLife = getLifestyleInfo();
        const wLv = getVitalLevel('bmi', wLife.bmi.value);
        const wTip = wLv === '正常' ? '体型很标准~' : wLv.includes('偏高') ? '有点超重了，少吃多动吧~' : '偏瘦了，多吃点有营养的~';
        return { ok: true, message: `⚖️ 称重：${wLife.weight.value} kg（身高 ${wLife.weight.level}），BMI ${wLife.bmi.value}（${wLv}）。${wTip}` };
      }
      case 'lifestyle': {
        const lf = getLifestyleInfo();
        return { ok: true, message: `🌱 生活方式：\n  ${lf.diet.emoji}饮食健康度：${lf.diet.value}（${lf.diet.level}）\n  ${lf.exercise.emoji}运动习惯：${lf.exercise.value}（${lf.exercise.level}）\n  ${lf.sleepQuality.emoji}睡眠质量：${lf.sleepQuality.value}（${lf.sleepQuality.level}）\n  ⚖️体重 ${lf.weight.value}kg　BMI ${lf.bmi.value}（${lf.bmi.level}）\n💡 吃得清淡、规律运动、睡得好，三高指标自然就下来了。` };
      }
      case 'organ_check': {
        const lines = Object.keys(ORGAN_INFO).map(k => {
          const v = getOrgan(k);
          return `  ${ORGAN_INFO[k].emoji}${ORGAN_INFO[k].name}：${getStatusBar(v)} ${Math.round(v)}/100 (${getOrganLevel(v)})`;
        });
        const warnings = getOrganWarnings();
        let msg = `🫀 器官检查报告：\n${lines.join('\n')}`;
        msg += warnings.length ? `\n⚠️ 需要关注：${warnings.join('、')}` : '\n😌 各器官状态良好~';
        return { ok: true, message: msg };
      }
      case 'today': {
        // v13.0：今天是什么日子 —— 星期 / 节日 / 天气 / 极端天气 / 缓解期
        const tb = getTodayBrief();
        const extra = [];
        if (salaryOn()) extra.push(`💼 距发薪 ${getDaysToPay()} 天`);
        if (billsOn()) extra.push(`💸 距账单 ${getDaysToBill()} 天`);
        return { ok: true, message: `🗓️ 今日一览\n${tb.lines.join('\n')}${extra.length ? '\n' + extra.join('　') : ''}` };
      }
      case 'wallet': {
        const wIns = getInsurancePlan();
        const wInsLine = isInsured()
          ? `🧾 医保：${wIns.info.emoji}${wIns.info.name}（报销 ${Math.round(wIns.info.rate * 100)}%，剩余额度 ¥${getInsuranceRemaining()}，本年已报销 ¥${Math.round(Number(healthState.insurance?.usedThisYear) || 0)}）`
          : `🧾 医保：${wIns.info.emoji}${wIns.info.name}（医疗费全额自付）`;
        const wBill = getBillsRec();
        const wBillLine = billsOn()
          ? `💸 账单：月支出 ¥${getBillTotal()}，距下次 ${getDaysToBill()} 天${wBill.unpaid > 0 ? `，❗欠费 ¥${wBill.unpaid}（逾期 ${wBill.overdue} 期）` : '，不欠账'}`
          : '';
        const wWallet = getWalletRec();
        const wSalaryLine = salaryOn()
          ? `💼 工资：月薪 ¥${getMonthlySalary()}，${getDaysToPay()} 天后到账${wWallet.payCount > 0 ? `（已发 ${wWallet.payCount} 次，共 ¥${wWallet.totalSalary}）` : '（第一笔还没到）'}`
          : '';
        const wGig = getGigRec();
        const wGigLine = (gigOn() && hobbyOn())
          ? `🧾 接单：累计 ${wGig.count} 单，共 ¥${wGig.total}（最高一单 ¥${wGig.best}，退稿 ${wGig.flops} 次）`
          : '';
        const wLs = getLedgerSummary();
        const wLedgerLine = ledgerOn()
          ? `📒 账本：本月收入 ¥${wLs.monthIn}　支出 ¥${wLs.monthOut}　净 ${wLs.net >= 0 ? '+' : ''}¥${wLs.net}`
          : '';
        return { ok: true, message: `💰 钱包：¥${Math.round(getMoney())}\n💸 累计医疗花费：¥${Math.round(Number(healthState.medicalCost) || 0)}\n🛒 累计生活开销：¥${Math.round(Number(healthState.livingCost) || 0)}\n${[wSalaryLine, wGigLine, wLedgerLine].filter(Boolean).join('\n')}\n${wInsLine}${wBillLine ? '\n' + wBillLine : ''}\n🎒 药箱：${getMedicineBoxSummary().join(' ') || '（空）'}` };
      }
      case 'work': {
        // v12.0：收入不再掷骰子，改由身体状态决定（见 doWork）；
        //        status 可指定工种（体力活 / 跑腿 / 细活），省略则自动挑最合适的
        const r = doWork(status);
        if (!r.ok) return { ok: false, error: r.error, message: r.error };
        await saveToFile();
        return { ok: true, message: r.message };
      }
      case 'gig': {
        // v12.0：靠手艺接单赚钱 —— 做一件作品按品质卖出去
        const r = doGig(status);
        if (!r.ok) return { ok: false, error: r.error, message: r.error };
        await saveToFile();
        return { ok: true, message: r.message };
      }
      case 'ledger': {
        // v12.0：收支账本
        return { ok: true, message: getLedgerText(6) };
      }
      case 'buy_medicine': {
        // 按需补药：缺货的药各补到 2 盒
        const want = {};
        let total = 0;
        for (const k of Object.keys(MEDICINES)) {
          const need = Math.max(0, 2 - getMedicineStock(k));
          if (need > 0) { want[k] = need; total += (MEDICINE_PRICE[k] || 20) * need; }
        }
        if (!Object.keys(want).length) return { ok: true, message: '🎒 药箱是满的，暂时不用买药~' };
        const payBuy = payMedical(total); // v8.0：购药同样走医保结算
        if (!payBuy.ok) {
          return { ok: true, message: `💊 补药需要 ¥${total}，我只有 ¥${Math.round(getMoney())}…先去打工吧~` };
        }
        if (!healthState.medicineBox) healthState.medicineBox = {};
        for (const [k, n] of Object.entries(want)) healthState.medicineBox[k] = getMedicineStock(k) + n;
        await saveToFile();
        return { ok: true, message: `💊 去药店补了药（花费 ${costText(payBuy)}）：${Object.entries(want).map(([k, n]) => MEDICINES[k].name + '×' + n).join('、')}\n🎒 现在药箱：${getMedicineBoxSummary().join(' ')}` };
      }
      case 'constitution': {
        const cur = getConstitutionInfo();
        const list = Object.entries(CONSTITUTIONS).map(([k, c]) => `${c.emoji}${c.name}(${k})${k === getConstitutionKey() ? ' ← 当前' : ''}：${c.desc}`);
        const risks = Object.entries(cur.riskMod).map(([k, r]) => `${getDiseaseInfo(k)?.name || k}×${r}`);
        let msg = `🧬 当前体质：${cur.emoji}${cur.name} —— ${cur.desc}`;
        msg += risks.length ? `\n⚠️ 易感疾病：${risks.join('、')}` : '\n✅ 无明显易感偏向';
        msg += `\n📖 可选体质：\n  ${list.join('\n  ')}`;
        return { ok: true, message: msg };
      }
      // ══════ v6.0 心理 / 睡眠 / 内分泌 / 创伤 / 检查 / 疫情 / 习惯 / 成就 ══════
      case 'therapy': case 'meditate': case 'journal': case 'party': case 'cry': {
        const th = THERAPIES[action];
        const now = Date.now();
        const lk = THERAPY_LAST_KEY[action];
        if (now - (Number(healthState[lk]) || 0) < th.cooldown) {
          const left = Math.ceil((th.cooldown - (now - (Number(healthState[lk]) || 0))) / 60000);
          return { ok: false, error: `${th.name}还需要等 ${left} 分钟` };
        }
        if (th.cost > 0 && !payMedicalOk(th.cost)) {
          return { ok: false, error: `${th.name}需要 ¥${th.cost}，钱包不够（当前 ¥${Math.round(getMoney())}）` };
        }
        const applied = [];
        for (const [k, d] of Object.entries(th)) {
          if (!STATUSES[k] || typeof d !== 'number') continue;
          const cur = Number(healthState[k]);
          healthState[k] = Math.max(0, Math.min(100, (Number.isFinite(cur) ? cur : 0) + d));
          applied.push(`${STATUSES[k].emoji}${STATUSES[k].name}${d > 0 ? '+' : ''}${d}`);
        }
        healthState[lk] = now;
        if (action === 'meditate') addHabit('meditation', 6);
        if (action === 'party') addHabit('drinking', 3);
        recordPsyc(`${th.name}：${applied.join(' ')}`);
        // 心理干预缓解激素
        if (action === 'therapy' || action === 'meditate') setHormone('cortisol', getHormone('cortisol') - 8);
        if (action === 'party') setHormone('serotonin', getHormone('serotonin') + 6);
        // v7.0：这些干预同样作用于深层生理亚成分（聚会补亲密、冥想/哭泣缓解精神疲劳与情绪波动）
        if (needDepthOn()) {
          const subDelta = {
            party:    { intimacy: 22, mentalFatigue: -4 },
            therapy:  { intimacy: 6,  mentalFatigue: -3 },
            meditate: { mentalFatigue: -6, moodVolatility: -5 },
            journal:  { mentalFatigue: -3, moodVolatility: -4 },
            cry:      { mentalFatigue: -4, moodVolatility: -6 }
          }[action];
          if (subDelta) {
            for (const [sk, sd] of Object.entries(subDelta)) {
              healthState[sk] = Math.max(0, Math.min(100, getSub(sk) + sd));
            }
          }
        }
        await saveToFile();
        return { ok: true, message: `${th.emoji} ${th.name}完成${th.cost ? `（花费 ¥${th.cost}）` : ''}：${applied.join(' ')}` };
      }

      // —— v7.0 基础需求深化动作 ——
      case 'hydrate_check': {
        const th = Number(healthState.thirst) || 0;
        const el = getSub('electrolyte');
        const pr = getSub('physicalReserve');
        const lines = [
          `💧 水分：${Math.round(th)}/100（${getNeedPhase('thirst', th)}）`,
          `🧂 电解质：${Math.round(el)}/100（${el >= 60 ? '正常' : el >= 35 ? '偏低' : '严重不足'}）`,
          `🏋️ 体力储备：${Math.round(pr)}/100`
        ];
        let tip;
        if (el < 35) tip = '\n⚠️ 电解质偏低：光喝白水不解渴，建议补充淡盐水或运动饮料。';
        else if (th < 40) tip = '\n💡 该补水了，别等渴到不行才喝。';
        else tip = '\n✅ 水平衡良好。';
        return { ok: true, message: `🌊 水平衡检查\n\n${lines.join('\n')}${tip}` };
      }

      case 'electrolyte_supplement': {
        const cost = (() => { try { const c = Number(cfg().costElectrolyte); return Number.isFinite(c) && c >= 0 ? c : 12; } catch { return 12; } })();
        if (!payMedicalOk(cost)) return { ok: false, error: `电解质饮料要 ¥${cost}，钱包不够（当前 ¥${Math.round(getMoney())}）` };
        healthState.electrolyte = Math.min(100, getSub('electrolyte') + 35);
        restoreNeed('thirst', 15);
        healthState.comfort = Math.min(100, (Number(healthState.comfort) || 0) + 5);
        healthState.lastElectrolyte = Date.now();
        await saveToFile();
        return { ok: true, message: `🧂 喝了瓶电解质饮料，咸甜咸甜的，身体一下子「续上电」了（电解质 ${Math.round(getSub('electrolyte'))}/100）。` };
      }

      case 'body_signal': {
        const subs = Object.entries(SUBSYSTEM_INFO).map(([k, info]) => {
          const v = Math.round(getSub(k));
          const lv = info.badWhenHigh
            ? (v >= 65 ? '偏高⚠️' : v >= 40 ? '略高' : '正常')
            : (v >= 60 ? '正常' : v >= 35 ? '偏低' : '不足⚠️');
          return `${info.emoji} ${info.name}：${v}/100（${lv}）`;
        });
        const warns = getCascadeWarnings();
        let msg = `🩺 身体信号扫描\n\n【深层生理】\n${subs.join('\n')}`;
        const phases = Object.keys(NEED_PHASES)
          .map(k => ({ k, v: Number(healthState[k]) || 0, p: getNeedPhase(k, Number(healthState[k]) || 0) }))
          .filter(x => x.v < 40)
          .sort((a, b) => a.v - b.v)
          .slice(0, 5)
          .map(x => `${getStatusOrSubName(x.k)}「${x.p}」`);
        msg += phases.length ? `\n\n【体感异常】\n${phases.join('　')}` : '\n\n【体感异常】\n✅ 各项需求都在舒适区间。';
        msg += warns.length
          ? `\n\n【连锁预警】\n${warns.map(w => `⚠️ ${w.tip}（${getStatusOrSubName(w.from)} → ${getStatusOrSubName(w.to)}）`).join('\n')}`
          : '\n\n【连锁预警】\n✅ 没有正在发生的连锁反应。';
        return { ok: true, message: msg };
      }

      case 'sleep_stage': {
        const st = SLEEP_STAGES[healthState.sleepStage] || SLEEP_STAGES.awake;
        const debt = Math.round(Number(healthState.sleepDebt));
        const clock = Number(healthState.sleepClock);
        const clockDesc = clock > 2 ? `晚睡型（+${clock}）` : clock < -2 ? `早睡型（${clock}）` : '作息规律';
        const stages = Object.entries(SLEEP_STAGES).map(([k, v]) => `${v.emoji}${v.name}${k === healthState.sleepStage ? '(当前)' : ''}`).join(' ');
        const recent = (healthState.sleepLog || []).slice(-3).map(x => `${x.date} ${SLEEP_STAGES[x.stage]?.name || x.stage}`).join('、') || '暂无记录';
        return { ok: true, message: `😴 睡眠状况：\n当前阶段：${st.emoji}${st.name}\n睡眠负债：${debt}/100（${debt >= 70 ? '严重欠觉' : debt >= 45 ? '明显欠觉' : debt >= 20 ? '略欠觉' : '基本不欠'}）\n生物钟：${clockDesc}\n☕ 咖啡因：${Math.round(Number(healthState.caffeine))}/100\n阶段说明：${stages}\n最近记录：${recent}` };
      }

      case 'coffee': {
        const now = Date.now();
        if (now - (Number(healthState.lastCoffee) || 0) < 3600000) return { ok: false, error: '刚喝过咖啡，心跳还没平复，等一小时再喝吧' };
        healthState.lastCoffee = now;
        healthState.caffeine = Math.min(100, Number(healthState.caffeine) + 45);
        healthState.energy = Math.min(100, Number(healthState.energy) + 15);
        healthState.sleep = Math.min(100, Number(healthState.sleep) + 12);
        healthState.sleepQuality = Math.max(0, Number(healthState.sleepQuality) - 6);
        setHormone('adrenaline', getHormone('adrenaline') + 10);
        addHabit('stayingUp', 3);
        await saveToFile();
        return { ok: true, message: `☕ 喝了一杯咖啡，精神了一点，但心跳有点快…（咖啡因 ${Math.round(Number(healthState.caffeine))}）` };
      }

      case 'stay_up': {
        const now = Date.now();
        if (now - (Number(healthState.lastStayUp) || 0) < 7200000) return { ok: false, error: '刚熬过夜，身体还没缓过来' };
        healthState.lastStayUp = now;
        healthState.sleepDebt = Math.min(100, Number(healthState.sleepDebt) + 22);
        healthState.sleepQuality = Math.max(0, Number(healthState.sleepQuality) - 10);
        healthState.sleepClock = Math.min(12, Number(healthState.sleepClock) + 1);
        healthState.energy = Math.min(100, Number(healthState.energy) + 8);
        healthState.focus = Math.max(0, Number(healthState.focus) - 6);
        healthState.anxiety = Math.min(100, Number(healthState.anxiety) + 5);
        setHormone('cortisol', getHormone('cortisol') + 8);
        setHormone('melatonin', getHormone('melatonin') - 8);
        addHabit('stayingUp', 10);
        await saveToFile();
        return { ok: true, message: `🦉 熬了一夜，眼皮打架但脑子亢奋…（睡眠负债 ${Math.round(Number(healthState.sleepDebt))}、生物钟偏移 +${healthState.sleepClock}）` };
      }

      case 'nap': {
        const now = Date.now();
        if (now - (Number(healthState.lastNap) || 0) < 1800000) return { ok: false, error: '刚小睡过，再睡就更昏了' };
        healthState.lastNap = now;
        healthState.energy = Math.min(100, Number(healthState.energy) + 20);
        healthState.fatigue = Math.min(100, Number(healthState.fatigue) + 15);
        healthState.sleepDebt = Math.max(0, Number(healthState.sleepDebt) - 12);
        healthState.sleep = Math.min(100, Number(healthState.sleep) + 10);
        if (Number(healthState.sleepDebt) < 10) healthState.anxiety = Math.max(0, Number(healthState.anxiety) - 3);
        await saveToFile();
        return { ok: true, message: `😪 小睡了 20 分钟，下午精神好多了~` };
      }

      case 'melatonin': {
        const now = Date.now();
        if (now - (Number(healthState.lastMelatonin) || 0) < 43200000) return { ok: false, error: '褪黑素不能连着吃，一天一次就好' };
        const cost = 30;
        if (!payMedicalOk(cost)) return { ok: false, error: `褪黑素 ¥${cost}，钱包不够（当前 ¥${Math.round(getMoney())}）` };
        healthState.lastMelatonin = now;
        setHormone('melatonin', getHormone('melatonin') + 30);
        setHormone('cortisol', getHormone('cortisol') - 8);
        healthState.sleepQuality = Math.min(100, Number(healthState.sleepQuality) + 10);
        healthState.sleepDebt = Math.max(0, Number(healthState.sleepDebt) - 8);
        healthState.fatigue = Math.min(100, Number(healthState.fatigue) + 10);
        addHabit('earlySleep', 6);
        await saveToFile();
        return { ok: true, message: `🌙 吃了褪黑素（¥${cost}），困意上来了，今晚应该睡得沉~` };
      }

      case 'regular_routine': {
        const now = Date.now();
        if (now - (Number(healthState.lastRoutine) || 0) < 86400000) return { ok: false, error: '作息调整需要坚持，明天再继续吧' };
        healthState.lastRoutine = now;
        const clock = Number(healthState.sleepClock);
        healthState.sleepClock = Math.abs(clock) <= 1 ? 0 : clock - Math.sign(clock);
        healthState.sleepQuality = Math.min(100, Number(healthState.sleepQuality) + 12);
        healthState.sleepDebt = Math.max(0, Number(healthState.sleepDebt) - 10);
        healthState.stability = Math.min(100, Number(healthState.stability) + 6);
        addHabit('earlySleep', 12);
        await saveToFile();
        return { ok: true, message: `🕰️ 开始规律作息：早睡早起、白天晒太阳。生物钟偏移修正到 ${healthState.sleepClock}，睡眠质量提升~` };
      }

      case 'hormone_check': {
        const now = Date.now();
        if (now - (Number(healthState.lastHormoneCheck) || 0) < 3600000) return { ok: false, error: '刚查过，不用反复查' };
        healthState.lastHormoneCheck = now;
        const lines = Object.entries(HORMONE_INFO).map(([k, h]) => `${h.emoji}${h.name}：${Math.round(getHormone(k))}/100（${getHormoneLevel(getHormone(k))}）—— ${h.desc}`).join('\n');
        const abn = Object.keys(HORMONE_INFO).filter(k => getHormoneLevel(getHormone(k)) !== '正常');
        const advice = abn.length ? `\n💡 建议：${abn.map(k => HORMONE_INFO[k].name).join('、')}偏离正常，注意规律作息与减压。` : '\n✅ 激素水平整体正常。';
        await saveToFile();
        return { ok: true, message: `🔬 内分泌检查：\n${lines}${advice}` };
      }

      case 'first_aid': {
        const now = Date.now();
        const inj = Array.isArray(healthState.injuries) ? healthState.injuries : [];
        if (!inj.length) return { ok: true, message: '🩹 身上没有需要处理的伤口~' };
        if (now - (Number(healthState.lastFirstAid) || 0) < 1800000) return { ok: false, error: '刚处理过伤口，包扎也要给身体时间' };
        const cost = 40;
        if (!payMedicalOk(cost)) return { ok: false, error: `处理伤口需要 ¥${cost} 医药费，钱包不够（当前 ¥${Math.round(getMoney())}）` };
        healthState.lastFirstAid = now;
        const names = [];
        for (const i of inj) {
          i.severity = Math.max(0, Number(i.severity) - 12);
          names.push(`${i.part}${INJURY_INFO[i.type]?.name || ''}`);
        }
        healthState.injuries = inj.filter(i => Number(i.severity) > 2);
        healthState.comfort = Math.min(100, Number(healthState.comfort) + 15);
        healthState.health = Math.min(100, Number(healthState.health) + 4);
        recordMedical(`急救包扎（${names.join('、')}）`);
        await saveToFile();
        return { ok: true, message: `🩹 处理了伤口（花费 ¥${cost}）：${names.join('、')}。消毒包扎后舒服多了~` };
      }

      case 'injury_check': {
        const inj = Array.isArray(healthState.injuries) ? healthState.injuries : [];
        if (!inj.length) return { ok: true, message: `🩺 外伤检查：身上没有未愈合的伤口（累计受伤 ${Number(healthState.scarCount) || 0} 次）` };
        const lines = inj.map(i => {
          const info = INJURY_INFO[i.type] || { name: '伤', emoji: '🩹' };
          const hours = ((Date.now() - (i.at || 0)) / 3600000).toFixed(1);
          return `${info.emoji}${i.part}${info.name}：严重度 ${Math.round(i.severity)}（${hours} 小时前）`;
        }).join('\n');
        return { ok: true, message: `🩺 外伤检查（累计受伤 ${Number(healthState.scarCount) || 0} 次）：\n${lines}\n💡 用「急救包扎」处理伤口，小心感染。` };
      }

      case 'imaging': {
        const key = status;
        const info = IMAGING_INFO[key];
        if (!info) return { ok: false, error: `未知检查项目：${key || '（空）'}，可选：${Object.keys(IMAGING_INFO).join('/')}` };
        const now = Date.now();
        if (now - (Number(healthState.lastImaging) || 0) < 600000) return { ok: false, error: '刚做过检查，等 10 分钟再预约' };
        const hos = getHospitalInfo();
        const cost = Math.round(info.cost * hos.costMul);
        if (!payMedicalOk(cost)) return { ok: false, error: `做${info.name}需要 ¥${cost}，钱包不够（当前 ¥${Math.round(getMoney())}）` };
        healthState.lastImaging = now;
        const skill = hos.skill;
        const pool = [...healthState.diseases, ...Object.keys(healthState.incubating || {})];
        const found = [];
        for (const d of pool) {
          if (found.includes(d) || !info.detects.includes(d)) continue;
          if (Math.random() < skill + 0.1) {
            found.push(d);
            if (!healthState.diagnosed) healthState.diagnosed = {};
            healthState.diagnosed[d] = true;
          }
        }
        const findings = found.length ? found.map(d => `${getDiseaseInfo(d)?.emoji || ''}${getDiseaseInfo(d)?.name || d}`).join('、') : '未见明显异常';
        if (!Array.isArray(healthState.imagingHistory)) healthState.imagingHistory = [];
        healthState.imagingHistory.push({ date: localDayKey(), type: key, findings });
        if (healthState.imagingHistory.length > 30) healthState.imagingHistory = healthState.imagingHistory.slice(-30);
        recordMedical(`检查：${info.name}（${findings}）`);
        await saveToFile();
        let msg = `${info.emoji} ${info.name}（花费 ¥${cost}，${hos.emoji}${hos.name}）：\n${info.desc}\n结果：${findings}`;
        if (found.length) msg += '\n✅ 已确诊，后续就医/用药成功率提升。';
        else if (pool.length) msg += '\n💡 指标不典型，可换更高级医院复查。';
        return { ok: true, message: msg };
      }

      case 'epidemic': {
        const ep = healthState.epidemic || {};
        if (!ep.active) return { ok: true, message: `🦠 社区疫情：目前平稳，暂无流行疾病。${healthState.maskOn ? '（你戴着口罩）' : ''}` };
        const dn = getDiseaseInfo(ep.disease)?.name || ep.disease;
        const days = ((Date.now() - (Number(ep.since) || Date.now())) / 86400000).toFixed(1);
        return { ok: true, message: `🦠 社区疫情：${dn} 正在流行（${getEpidemicLevelName(ep.level)}，已持续 ${days} 天）\n😷 口罩：${healthState.maskOn ? '已戴' : '未戴'}\n💡 建议戴口罩、勤消毒、少去人多的地方。` };
      }

      case 'mask': {
        healthState.maskOn = !healthState.maskOn;
        await saveToFile();
        return { ok: true, message: healthState.maskOn ? '😷 戴上口罩了，出门感觉安全多了~' : '😌 摘掉口罩，透透气~' };
      }

      case 'disinfect': {
        const now = Date.now();
        if (now - (Number(healthState.lastDisinfect) || 0) < 3600000) return { ok: false, error: '刚消毒过，不用这么频繁' };
        const cost = 15;
        if (!payMedicalOk(cost)) return { ok: false, error: `消毒用品 ¥${cost}，钱包不够（当前 ¥${Math.round(getMoney())}）` };
        healthState.lastDisinfect = now;
        healthState.comfort = Math.min(100, Number(healthState.comfort) + 5);
        healthState.immunity = Math.min(100, Number(healthState.immunity) + 2);
        await saveToFile();
        return { ok: true, message: `🧴 给房间和手消了毒（¥${cost}），细菌少多了，安心~` };
      }

      case 'isolate': {
        const now = Date.now();
        if (now - (Number(healthState.lastIsolate) || 0) < 86400000) return { ok: false, error: '已经在隔离中了' };
        healthState.lastIsolate = now;
        healthState.social = Math.max(0, Number(healthState.social) - 12);
        healthState.loneliness = Math.max(0, Number(healthState.loneliness) - 8);
        healthState.anxiety = Math.min(100, Number(healthState.anxiety) + 6);
        healthState.security = Math.min(100, Number(healthState.security) + 8);
        await saveToFile();
        return { ok: true, message: '🏠 开始居家隔离，减少外出接触。虽然有点闷（社交需求下降、焦虑略升），但更安全了~' };
      }

      case 'habits': {
        const lines = Object.entries(HABIT_INFO).map(([k, h]) => `${h.emoji}${h.name}：${Math.round(getHabit(k))}/100（${getHabitLevel(getHabit(k))}）${h.good ? '👍' : '⚠️'}`).join('\n');
        const bad = Object.keys(HABIT_INFO).filter(k => !HABIT_INFO[k].good && getHabit(k) >= 50);
        const good = Object.keys(HABIT_INFO).filter(k => HABIT_INFO[k].good && getHabit(k) >= 50);
        let extra = '';
        if (bad.length) extra += `\n⚠️ 需戒除：${bad.map(k => HABIT_INFO[k].name).join('、')}`;
        if (good.length) extra += `\n👍 已养成：${good.map(k => HABIT_INFO[k].name).join('、')}`;
        return { ok: true, message: `📋 习惯档案：\n${lines}${extra}` };
      }

      case 'cultivate': case 'quit': {
        const hk = status;
        const h = HABIT_INFO[hk];
        if (!h) return { ok: false, error: `未知习惯：${hk || '（空）'}，可选：${Object.keys(HABIT_INFO).join('/')}` };
        if (action === 'cultivate' && !h.good) return { ok: false, error: `${h.name}不是好习惯，请用「戒除」处理` };
        if (action === 'quit' && h.good) return { ok: false, error: `${h.name}是好习惯，不需要戒除` };
        if (action === 'quit') {
          const cost = 60;
          if (!payMedicalOk(cost)) return { ok: false, error: `戒除${h.name}需要 ¥${cost} 的辅助（替代品/挂号），钱包不够（当前 ¥${Math.round(getMoney())}）` };
        }
        const v = addHabit(hk, action === 'cultivate' ? 15 : -18);
        healthState.stability = Math.min(100, Number(healthState.stability) + (action === 'quit' ? 5 : 3));
        await saveToFile();
        if (action === 'cultivate') return { ok: true, message: `${h.emoji} 开始培养「${h.name}」：${h.desc}。当前养成度 ${Math.round(v)}/100（${getHabitLevel(v)}）` };
        return { ok: true, message: `${h.emoji} 开始戒除「${h.name}」（花费 ¥60）：${h.desc}。当前依赖度 ${Math.round(v)}/100（${getHabitLevel(v)}）` };
      }

      case 'achievements': {
        const unlocked = healthState.achievements || {};
        const lines = Object.entries(ACHIEVEMENTS).map(([k, a]) => {
          const on = !!unlocked[k];
          let when = '';
          if (on) { try { when = `（${localDayKey(unlocked[k])} 解锁）`; } catch { when = ''; } }
          return `${on ? a.emoji : '🔒'}${a.name} —— ${a.desc}${when}`;
        }).join('\n');
        return { ok: true, message: `🏆 健康成就（${Object.keys(unlocked).length}/${Object.keys(ACHIEVEMENTS).length}）：\n${lines}` };
      }

      case 'age': {
        const age = Math.round(Number(healthState.age) || 20);
        const decayMul = 1 + Math.max(0, age - 30) * 0.012;
        let days = '—';
        if (Number(healthState.lastBirthday) > 0) {
          days = Math.max(0, Math.ceil((Number(healthState.lastBirthday) + 365 * 86400000 - Date.now()) / 86400000));
        }
        return { ok: true, message: `🎂 年龄：${age} 岁\n基础衰减倍率：×${decayMul.toFixed(2)}（30 岁后随年龄缓慢上升）\n距离下次生日：约 ${days} 天` };
      }

      // —— 昼夜节律 / 菌群 / 过敏 / 关系网 / 医保 / 生物年龄 / 大事记（v8.0）——
      case 'circadian': {
        const nowD = new Date();
        const hourNow = nowD.getHours() + nowD.getMinutes() / 60;
        const c = getCircadianEffects(hourNow);
        const win = getSleepWindow();
        const off = getCircadianOffset();
        const lines = [];
        lines.push(`${c.phase.emoji} 当前节律段：${c.phase.name}（生理效能 ×${c.phase.eff}）`);
        lines.push(`　${c.phase.tip}`);
        lines.push(`🕐 生理钟点约 ${getCircadianHour(hourNow).toFixed(1)} 点，相位偏移 ${off.toFixed(1)} 小时${off >= 0.2 ? '（偏夜猫子型，生理节律比钟表晚）' : off <= -0.2 ? '（偏早鸟型，生理节律比钟表早）' : '（与钟表基本同步）'}`);
        lines.push(`⚡ 精力水平 ${c.energy}/100　👁️ 警觉度 ${c.alert}/100　🌡️ 基础体温 ${c.bodyTemp}℃`);
        lines.push(`🧪 皮质醇 ${c.cortisol}/100（压力激素，晨高夜低）　🌙 褪黑素 ${c.melatonin}/100（睡眠激素，夜高昼低）`);
        lines.push(`😴 建议睡眠窗口：${win.startText} - ${win.endText}`);
        let hint = '';
        if (c.phase.key === 'deep_night') hint = '现在是生理机能谷底，硬撑着不睡最伤身，情绪也最容易崩。';
        else if (c.phase.key === 'dawn') hint = '刚醒的时段，出去晒会儿太阳最能校准生物钟。';
        else if (c.phase.key === 'morning') hint = '一天里状态最好的时候，适合干活和运动。';
        else if (c.phase.key === 'afternoon') hint = '午后犯困是生理性的，别硬撑，眯一小会儿效率反而更高。';
        else if (c.phase.key === 'evening') hint = '肌肉力量正处在全天峰值，运动表现最好。';
        else if (c.phase.key === 'night') hint = '褪黑素在爬升了，该准备睡觉了。';
        if (hint) lines.push(`💡 ${hint}`);
        return { ok: true, message: `🕰️ 昼夜节律\n${lines.join('\n')}` };
      }

      case 'gut_check': {
        const score = getGutScore();
        const fx = getGutEffects();
        const items = Object.entries(GUT_FLORA).map(([k, info]) => {
          const v = Math.round(getGut(k));
          return `${info.emoji} ${info.name}：${getStatusBar(v)} ${v}/100　（${info.role}）`;
        });
        const notes = [];
        if (score < 40) notes.push('菌群已严重失衡，容易腹胀、排便紊乱，还会连带拖累免疫和情绪');
        if (getGut('barrier') < 45) notes.push('肠道屏障变薄，毒素容易渗进血液（肠漏风险）');
        if (fx.nutrientAbsorb < 0.85) notes.push(`营养吸收率只有 ${Math.round(fx.nutrientAbsorb * 100)}%，吃再多也补不进去`);
        if (fx.serotoninBase < -1) notes.push('肠道合成的血清素偏低，情绪容易低落（肠脑轴）');
        return { ok: true, message: `🦠 肠道菌群检查（${getGutLevel()}，综合 ${Math.round(score)}/100）\n${items.join('\n')}\n${notes.length ? '\n⚠️ ' + notes.join('\n⚠️ ') : '\n✅ 菌群环境健康，消化、免疫、情绪都在受益'}` };
      }

      case 'probiotics': {
        let cost = 15;
        try { const c = Number(cfg().costProbiotics); if (Number.isFinite(c) && c >= 0) cost = c; } catch { /* 用默认 */ }
        const pay = payMedical(cost);
        if (!pay.ok) return { ok: false, error: `益生菌要 ¥${cost}，钱包不够（当前 ¥${Math.round(getMoney())}）` };
        const before = getGutScore();
        healGut(9);
        adjustLifestyle('diet', 2);
        healthState.lastProbiotics = Date.now();
        const after = getGutScore();
        await saveToFile();
        return { ok: true, message: `🥛 喝了一盒益生菌（${costText(pay)}），双歧杆菌和乳酸菌开始回补，菌群综合 ${Math.round(before)} → ${Math.round(after)}（+${(after - before).toFixed(1)}）` };
      }

      case 'fiber_diet': {
        const before = getGutScore();
        healGut(5);
        if (!healthState.nutrients || typeof healthState.nutrients !== 'object') healthState.nutrients = {};
        healthState.nutrients.fiber = Math.max(0, Math.min(100, (Number(healthState.nutrients.fiber) || 0) + 14));
        adjustLifestyle('diet', 6);
        healthState.hunger = Math.min(100, Number(healthState.hunger) + 15);
        healthState.mood = Math.min(100, Number(healthState.mood) + 3);
        healthState.lastFiber = Date.now();
        await saveToFile();
        return { ok: true, message: `🌾 吃了一顿高纤维餐（全谷物 + 蔬菜 + 豆类），饱腹感扎实，肠道菌群 +${(getGutScore() - before).toFixed(1)}，膳食纤维也补上来了` };
      }

      case 'allergen_test': {
        let cost = 80;
        try { const c = Number(cfg().costAllergenTest); if (Number.isFinite(c) && c >= 0) cost = c; } catch { /* 用默认 */ }
        const pay = payMedical(cost);
        if (!pay.ok) return { ok: false, error: `过敏原检测要 ¥${cost}，钱包不够（当前 ¥${Math.round(getMoney())}）` };
        if (!healthState.allergenRolled) rollAllergens();
        const list = getAllergenList();
        const positive = list.filter(x => x.level > 0);
        const load = computeAllergyLoad();
        recordTimeline('🌾', positive.length ? `过敏原检测检出：${positive.map(x => x.info.name).join('、')}` : '过敏原检测八项全阴', 'allergy');
        await saveToFile();
        const lines = list.map(x => `${x.info.emoji} ${x.info.name}（${x.info.kind}）：${x.level > 0 ? '⚠️ ' + x.levelName : '✅ 不过敏'}`).join('\n');
        return { ok: true, message: `🧪 过敏原检测完成（${costText(pay)}）\n${lines}\n\n当前过敏负荷 ${Math.round(load)}/100（${getAllergyLevelName(load)}）${positive.length ? '\n💡 尽量避开这些过敏原，必要时吃抗过敏药。' : '\n✅ 没检出任何过敏原，这体质真省心。'}` };
      }

      case 'allergy_check': {
        const load = computeAllergyLoad();
        const trg = healthState.allergyTriggers || [];
        const list = getAllergenList().filter(x => x.level > 0);
        let msg = `🤧 过敏状况\n当前过敏负荷：${Math.round(load)}/100（${getAllergyLevelName(load)}）\n`;
        if (!healthState.allergenRolled) msg += '（还没做过过敏原检测，只知道自己有反应，不知道对什么过敏）\n';
        msg += list.length ? `已知过敏原：${list.map(x => `${x.info.emoji}${x.info.name}(${x.levelName})`).join('、')}\n` : '过敏原：未检出或未检测\n';
        msg += trg.length ? `正在刺激身体的：\n${trg.map(t => `　${t.emoji}${t.name} —— ${t.why}（负荷 +${t.delta}）`).join('\n')}` : '当前没有明显的环境刺激源。';
        const lv = Number(load);
        if (lv >= 68) msg += '\n🚨 负荷很高，可能诱发荨麻疹甚至哮喘，赶紧吃抗过敏药。';
        else if (lv >= 45) msg += '\n⚠️ 已经到鼻炎级别的不适了，别硬扛。';
        await saveToFile();
        return { ok: true, message: msg };
      }

      case 'antihistamine': {
        let cost = 18;
        try { const c = Number(cfg().costAntihistamine); if (Number.isFinite(c) && c >= 0) cost = c; } catch { /* 用默认 */ }
        let usedBox = false;
        if (getMedicineStock('allergy_medicine') > 0) {
          consumeMedicine('allergy_medicine', 1);
          usedBox = true;
        } else {
          const pay = payMedical(cost);
          if (!pay.ok) return { ok: false, error: `药箱里没有抗过敏药，现买要 ¥${cost}，钱包不够（当前 ¥${Math.round(getMoney())}）` };
        }
        const before = Number(healthState.allergyLoad) || 0;
        healthState.allergyLoad = Math.max(0, before - 38);
        applySideEffects('allergy_medicine');
        healthState.sleepQuality = Math.max(0, Number(healthState.sleepQuality) - 3); // 抗组胺药的嗜睡副作用
        healthState.fatigue = Math.min(100, Number(healthState.fatigue) + 2);
        healthState.lastAntihistamine = Date.now();
        await saveToFile();
        return { ok: true, message: `💊 吃了抗过敏药${usedBox ? '（用药箱里的）' : '（现买的）'}，瘙痒和喷嚏很快压下去了，过敏负荷 ${Math.round(before)} → ${Math.round(Number(healthState.allergyLoad))}。就是有点犯困…` };
      }

      case 'relations': {
        const rel = getRelationEffects();
        const list = getRelations();
        if (!list.length) return { ok: true, message: '📇 关系网还是空的——还没有和谁建立起联系。' };
        const lines = list.sort((a, b) => b.bond.affinity - a.bond.affinity).map(({ bond }) => {
          const t = getRelationType(bond.relation);
          const cf = bond.conflicts >= 3 ? `，⚠️ 积怨 ${Math.round(bond.conflicts * 10) / 10}` : '';
          const dt = bond.lastDeepTalk ? `，上次深聊 ${Math.max(0, Math.round((Date.now() - bond.lastDeepTalk) / 86400000))} 天前` : '，还没深聊过';
          return `${t.emoji} ${bond.name}（${t.name}）：亲密度 ${Math.round(bond.affinity)}/${t.cap}（${getRelationLevel(bond.affinity)}），亲密感 ${Math.round(bond.intimacy)}${cf}${dt}`;
        });
        let note = '';
        if (rel.conflicts >= 5) note = '\n⚠️ 关系网里积压了不少未解的矛盾，孤独感会悄悄上升，该找机会和解了。';
        else if (rel.avgAffinity >= 85) note = '\n💚 关系网很稳固，归属感和安全感都在被持续滋养。';
        return { ok: true, message: `📇 社交关系网（${rel.count} 人，平均亲密度 ${rel.avgAffinity}）\n${lines.join('\n')}${note}` };
      }

      case 'deep_talk': {
        const list = getRelations();
        if (!list.length) return { ok: false, error: '还没有可以深聊的人' };
        let target = null;
        if (status) target = list.find(x => x.bond.name === status) || null;
        if (!target) target = list.slice().sort((a, b) => b.bond.affinity - a.bond.affinity)[0];
        const bond = target.bond;
        const t = getRelationType(bond.relation);
        const before = bond.affinity;
        bond.affinity = Math.min(t.cap, bond.affinity + t.deepGain);
        bond.intimacy = Math.min(100, bond.intimacy + 10);
        bond.conflicts = Math.max(0, bond.conflicts - 1.5);
        bond.lastDeepTalk = Date.now();
        bond.lastChat = Date.now();
        if (!Array.isArray(bond.memories)) bond.memories = [];
        bond.memories.push({ at: Date.now(), text: `和 ${bond.name} 深聊了一次` });
        if (bond.memories.length > 10) bond.memories = bond.memories.slice(-10);
        healthState.intimacy = Math.min(100, Number(healthState.intimacy) + 12);
        healthState.loneliness = Math.min(100, Number(healthState.loneliness) + 15);
        healthState.mood = Math.min(100, Number(healthState.mood) + 8);
        healthState.stress = Math.min(100, Number(healthState.stress) + 8);
        healthState.mentalFatigue = Math.max(0, Number(healthState.mentalFatigue) - 6);
        // v13.0：深聊是同理心的主要补给来源之一（此前该维度只有衰减、没有任何提升途径）
        healthState.empathy = Math.min(100, Number(healthState.empathy) + 7);
        setHormone('serotonin', getHormone('serotonin') + 6);
        setHormone('cortisol', getHormone('cortisol') - 5);
        await saveToFile();
        return { ok: true, message: `💬 和 ${bond.name} 好好聊了很久（${t.name}），把心里话都说开了。亲密度 ${Math.round(before)} → ${Math.round(bond.affinity)}，亲密感 ${Math.round(bond.intimacy)}。心里舒坦多了。` };
      }

      case 'reconcile': {
        const list = getRelations().filter(x => x.bond.conflicts > 0);
        if (!list.length) return { ok: true, message: '🤝 关系网里没有未解的矛盾，大家相处都挺顺的。' };
        const target = list.slice().sort((a, b) => b.bond.conflicts - a.bond.conflicts)[0];
        const bond = target.bond;
        const before = bond.conflicts;
        bond.conflicts = Math.max(0, bond.conflicts - 3);
        bond.affinity = Math.min(getRelationType(bond.relation).cap, bond.affinity + 4);
        bond.lastChat = Date.now();
        healthState.loneliness = Math.min(100, Number(healthState.loneliness) + 6);
        healthState.stress = Math.min(100, Number(healthState.stress) + 5);
        await saveToFile();
        return { ok: true, message: `🕊️ 主动找 ${bond.name} 把话说开了，积怨 ${Math.round(before * 10) / 10} → ${Math.round(bond.conflicts * 10) / 10}，关系缓和了不少。` };
      }

      case 'bio_age': {
        const b = computeBiologicalAge();
        const deltaTxt = `${b.delta >= 0 ? '+' : ''}${b.delta}`;
        const items = b.factors.map(f => {
          const sign = f.delta > 0 ? `+${f.delta}` : String(f.delta);
          const tone = f.delta > 0.3 ? '（拖老）' : f.delta < -0.3 ? '（显年轻）' : '（基本持平）';
          return `${f.emoji} ${f.name}：${sign} 岁${tone}`;
        }).join('\n');
        await saveToFile();
        return { ok: true, message: `🧬 生物年龄报告\n实际年龄：${b.real} 岁\n生理年龄：${b.bio} 岁（${deltaTxt} 岁 · ${getBioAgeLevel(b.delta)}）\n\n各系统贡献：\n${items}` };
      }

      case 'insurance': {
        if (status) {
          if (!INSURANCE_PLANS[status]) return { ok: false, error: '未知医保方案：' + status };
          if (status === 'none') {
            healthState.insurance = { plan: 'none', since: 0, expireAt: 0, usedThisYear: 0 };
            await saveToFile();
            return { ok: true, message: '🚫 已退出医保，之后医疗费全额自付。' };
          }
          const plan = INSURANCE_PLANS[status];
          const pay = payMedical(plan.premium);
          if (!pay.ok) return { ok: false, error: `${plan.name}一年保费 ¥${plan.premium}，钱包不够（当前 ¥${Math.round(getMoney())}）` };
          healthState.insurance = { plan: status, since: Date.now(), expireAt: Date.now() + INSURANCE_TERM_MS, usedThisYear: 0 };
          recordTimeline('🧾', `办理了${plan.name}（年费 ¥${plan.premium}，报销 ${Math.round(plan.rate * 100)}%）`, 'insurance');
          await saveToFile();
          return { ok: true, message: `🧾 办好了 ${plan.emoji}${plan.name}（年费 ¥${plan.premium}），之后医疗费可报销 ${Math.round(plan.rate * 100)}%，年度上限 ¥${plan.cap}。` };
        }
        const ins = healthState.insurance && typeof healthState.insurance === 'object' ? healthState.insurance : {};
        const cur = getInsurancePlan();
        const remain = getInsuranceRemaining();
        const valid = isInsured();
        const days = ins.expireAt ? Math.max(0, Math.ceil((Number(ins.expireAt) - Date.now()) / 86400000)) : 0;
        const table = Object.entries(INSURANCE_PLANS).map(([k, p]) => `　${p.emoji} ${p.name}（${k}）：年费 ¥${p.premium}，报销 ${Math.round(p.rate * 100)}%，上限 ¥${p.cap}`).join('\n');
        return { ok: true, message: `🧾 医保状况\n当前：${cur.info.emoji}${cur.info.name}${valid ? '（有效）' : '（未生效或已失效）'}\n本年度已报销：¥${Math.round(Number(ins.usedThisYear) || 0)}　剩余额度：¥${remain}${days ? `　有效期还剩 ${days} 天` : ''}\n\n可选方案：\n${table}` };
      }

      case 'timeline': {
        const arr = Array.isArray(healthState.timeline) ? healthState.timeline : [];
        if (!arr.length) return { ok: true, message: '📜 健康大事记还是空的——大事发生时会自动记下来。' };
        const items = getTimelineRecent(15).map(formatTimelineItem);
        return { ok: true, message: `📜 健康大事记（共 ${arr.length} 条，最近 ${items.length} 条）\n${items.join('\n')}` };
      }

      // —— 爱好与技能树（v9.0）——
      case 'hobby_list': {
        if (!hobbyOn()) return { ok: true, message: '🎨 爱好系统已在设置里关闭。' };
        const list = getHobbies();
        const slots = getHobbyMaxSlots();
        if (!list.length) {
          const canLearn = Object.entries(HOBBIES).map(([k, m]) => `${m.emoji}${m.name}(${k})`).join('　');
          return { ok: true, message: `🎨 还没有在练的爱好（槽位 0/${slots}）。\n可选：\n${canLearn}\n💡 用「学爱好」告诉我学哪个。` };
        }
        const rows = list.map(it => {
          const p = getHobbyProgress(it.rec.xp);
          return `　${it.meta.emoji} ${it.meta.name}（${it.cat.name}）　Lv${p.level}·${p.levelName}　经验 ${it.rec.xp}${p.maxed ? '（满级）' : `（距下一级 ${p.need}）`}\n　　热情 ${Math.round(it.rec.passion)}　练过 ${it.rec.practiceCount} 次　作品 ${it.works.length} 件`;
        }).join('\n');
        const hb = getHobbyEffects();
        return { ok: true, message: `🎨 爱好与技能（${list.length}/${slots} 槽位）\n${rows}\n\n📊 被动加成：满足 +${hb.satisfaction.toFixed(1)}　心情 +${hb.mood.toFixed(1)}　减压 +${hb.stress.toFixed(1)}　安全感 +${hb.security.toFixed(1)}　社交 +${hb.social.toFixed(1)}` };
      }

      case 'hobby_learn': {
        if (!hobbyOn()) return { ok: true, message: '🎨 爱好系统已在设置里关闭。' };
        if (!status) {
          const base = getHobbyLearnCost();
          const canLearn = Object.entries(HOBBIES).filter(([k]) => !isHobbyLearned(k))
            .map(([k, m]) => `${m.emoji}${m.name}(${k})　¥${Math.round(base + m.cost)}`).join('\n');
          if (!canLearn) return { ok: true, message: '🎨 能学的爱好都在练了，厉害！' };
          return { ok: true, message: `🎨 想学哪个？（花费 = 教材 ¥${base} + 该爱好的器材费）\n${canLearn}` };
        }
        const lr = learnHobby(String(status).trim());
        if (!lr.ok) return { ok: false, error: lr.error };
        await saveToFile();
        return { ok: true, message: lr.message };
      }

      case 'hobby_practice': {
        if (!hobbyOn()) return { ok: true, message: '🎨 爱好系统已在设置里关闭。' };
        const hl = getHobbies();
        if (!hl.length) return { ok: true, message: '🎨 还没学过任何爱好，先用「学爱好」挑一个吧。' };
        let pKey = status ? String(status).trim() : null;
        if (pKey && !isHobbyLearned(pKey)) {
          const hit = hl.find(x => x.meta.name === pKey);
          if (hit) pKey = hit.key;
          else return { ok: false, error: `没在练「${pKey}」` };
        }
        if (!pKey) pKey = hl.slice().sort((a, b) => b.rec.passion - a.rec.passion)[0].key;
        const pr = practiceHobby(pKey, amount);
        if (!pr.ok) return { ok: false, error: pr.error };
        await saveToFile();
        return { ok: true, message: pr.message };
      }

      case 'hobby_works': {
        const wl = getHobbies();
        if (!wl.length) return { ok: true, message: '🎨 还没有爱好，自然也没有作品。' };
        const total = wl.reduce((a, x) => a + x.rec.works.length, 0);
        if (!total) return { ok: true, message: '🎨 还没有作品——练到 2 级之后，每次练习就有机会产出作品了。' };
        const blocks = wl.filter(x => x.rec.works.length).map(it => {
          const ws = it.rec.works.slice().reverse().slice(0, 8)
            .map(w => `　　${w.emoji}${w.name}（${localDayKey(w.at)}）`).join('\n');
          return `　${it.meta.emoji}${it.meta.name}（${it.rec.works.length} 件）\n${ws}`;
        }).join('\n');
        return { ok: true, message: `🎨 作品收藏（共 ${total} 件，每个爱好最多留 ${HOBBY_WORK_CAP} 件）\n${blocks}\n💡 可以用「送作品」把最好的一件送给关系网里的人。` };
      }

      case 'hobby_gift': {
        if (!hobbyOn()) return { ok: true, message: '🎨 爱好系统已在设置里关闭。' };
        if (!status) {
          const names = getRelations().map(x => x.bond.name).join('、') || '（关系网为空）';
          return { ok: true, message: `🎁 想把作品送给谁？现有：${names}` };
        }
        const gr = giftWork(String(status).trim());
        if (!gr.ok) return { ok: false, error: gr.error };
        await saveToFile();
        return { ok: true, message: gr.message };
      }

      case 'hobby_abandon': {
        if (!status) {
          const names = getHobbies().map(x => x.meta.name).join('、') || '（无）';
          return { ok: true, message: `🚮 要放弃哪个？现有：${names}` };
        }
        let aKey = String(status).trim();
        if (!HOBBIES[aKey]) {
          const hit = getHobbies().find(x => x.meta.name === aKey);
          if (hit) aKey = hit.key;
        }
        const ar = abandonHobby(aKey);
        if (!ar.ok) return { ok: false, error: ar.error };
        await saveToFile();
        return { ok: true, message: ar.message };
      }

      case 'hobby_tree': {
        if (!hobbyOn()) return { ok: true, message: '🎨 爱好系统已在设置里关闭。' };
        const tl = getHobbies();
        if (!tl.length) return { ok: true, message: '🌳 技能树还是空的——先用「学爱好」挑一门。' };
        const tierLine = HOBBY_TIERS.map(t => `${t.lv}·${t.name}`).join(' → ');
        const blocks = tl.map(it => {
          const p = getHobbyProgress(it.rec.xp);
          const ms = HOBBY_MILESTONES.map(m => {
            const got = !!it.rec.milestones[m.lv];
            return `${got ? m.emoji : '　'}${m.name}(${m.lv}级)`;
          }).join('　');
          return `　${it.meta.emoji} ${it.meta.name}\n　　Lv${p.level}·${p.levelName}　${p.maxed ? '已满级' : `${p.pct.toFixed(0)}% → ${p.next}`}\n　　里程碑：${ms}`;
        }).join('\n');
        return { ok: true, message: `🌳 爱好技能树\n阶梯：${tierLine}\n\n${blocks}\n\n💡 里程碑：🥉小成(3级) 提升心情/满足收益　🥈大成(6级) 提升作品品质　🥇登峰(9级) 热情不再衰退` };
      }

      // —— 宠物养成（v10.0）——
      case 'pet_status': {
        if (!petOn()) return { ok: true, message: '🐾 宠物系统已在设置里关闭。' };
        const allPets = getPets(true);
        const alive = allPets.filter(p => !p.memorial);
        if (!alive.length) {
          const gone = allPets.length - alive.length;
          const opts = Object.keys(PET_SPECIES).map(k => `${PET_SPECIES[k].emoji}${PET_SPECIES[k].name}(¥${PET_SPECIES[k].price})`).join('　');
          return { ok: true, message: `🐾 还没有养宠物${gone ? `（曾经养过 ${gone} 只）` : ''}。\n可以领养：${opts}\n💡 当前上限 ${getPetMaxCount()} 只（可在设置里调整）。` };
        }
        const petFx = getPetEffects();
        const blocks = alive.map(p => {
          const sp = PET_SPECIES[p.species];
          const st = getPetStage(p);
          const nd = getPetNeeds(p);
          const days = Math.round(getPetAgeDays(p) * 10) / 10;
          const lifePct = Math.min(100, Math.round(getPetLifeRatio(p) * 100));
          const trickTxt = p.tricks.length
            ? p.tricks.map(t => PET_TRICKS[t] ? `${PET_TRICKS[t].emoji}${PET_TRICKS[t].name}` : t).join('、')
            : '还没学会什么';
          let b = `　${sp.emoji}「${p.name}」（${sp.name}·${st.emoji}${st.name}）\n`
                + `　　${PET_NEEDS.satiety.emoji}饱食 ${Math.round(nd.satiety)}　${PET_NEEDS.hydration.emoji}饮水 ${Math.round(nd.hydration)}　${PET_NEEDS.hygiene.emoji}清洁 ${Math.round(nd.hygiene)}　${PET_NEEDS.spirit.emoji}心情 ${Math.round(nd.spirit)}\n`
                + `　　💗亲密度 ${Math.round(p.bond)}（${getPetBondLevel(p.bond)}）　❤️健康 ${Math.round(p.health)}　🍩肥肉 ${Math.round(p.fat)}\n`
                + `　　🎓技能：${trickTxt}　（训练经验 ${Math.round(p.skillXp)}）\n`
                + `　　⏳相处 ${days} 天｜生命进度 ${lifePct}%｜${st.note}`;
          if (p.diseases.length) {
            b += `\n　　🤒 ${p.diseases.map(d => PET_DISEASES[d] ? `${PET_DISEASES[d].emoji}${PET_DISEASES[d].name}（${PET_DISEASES[d].symptoms}）` : d).join('、')}`;
          }
          return b;
        }).join('\n\n');
        const tips = [];
        if (petFx.shed > 0) tips.push(`掉毛/皮屑指数 ${petFx.shed.toFixed(1)}（会推高你的过敏负荷）`);
        if (petFx.nightNoise > 0) tips.push(`夜间吵闹指数 ${petFx.nightNoise.toFixed(1)}（夜行物种会吵你睡觉）`);
        if (petFx.sick > 0) tips.push(`${petFx.sick} 只生病了，得带去看兽医`);
        const cap = getPetMaxCount();
        let msg = `🐾 宠物面板（${alive.length}/${cap} 只${alive.length > cap ? `，已超出上限，建议送走 ${alive.length - cap} 只` : ''}）\n\n${blocks}`;
        if (tips.length) msg += `\n\n⚠️ ${tips.join('；')}`;
        msg += `\n\n💸 累计宠物开销 ¥${petFx.cost}${petFx.memorial ? `　🕯️ 已离世 ${petFx.memorial} 只` : ''}`;
        msg += `\n💗 陪伴加成：归属感 +${petFx.belonging.toFixed(1)}　心情 +${petFx.mood.toFixed(1)}　减压 +${petFx.stress.toFixed(1)}`;
        return { ok: true, message: msg };
      }

      case 'pet_adopt': {
        const r = adoptPet(status, extra);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      case 'pet_feed': {
        const r = feedPet(status);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      case 'pet_water': {
        const r = waterPet(status);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      case 'pet_clean': {
        const r = cleanPet(status);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      case 'pet_play': {
        const r = playPet(status);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      case 'pet_cuddle': {
        const r = cuddlePet(status);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      case 'pet_walk': {
        const r = walkPet(status);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      case 'pet_train': {
        const r = trainPet(status);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      case 'pet_show': {
        const r = showPet(status);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      case 'pet_vet': {
        const r = healPetWithVet(status);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      case 'pet_rename': {
        const r = renamePet(status, extra);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      case 'pet_abandon': {
        const r = abandonPet(status);
        return r.ok ? { ok: true, message: r.message } : { ok: false, error: r.error };
      }

      // ─────────────── v11.0 日常生活 ───────────────

      case 'outfit': {
        if (!outfitOn()) return { ok: false, error: '穿衣系统已关闭（可在配置里打开）' };
        // 特殊值：涂防晒
        if (status === 'sunscreen' || status === '防晒') {
          const r = applySunscreen();
          if (!r.ok) return { ok: false, error: r.error };
          await saveToFile();
          return { ok: true, message: r.message };
        }
        // 不带参数 → 看今天穿什么合适
        if (!status) {
          const env = healthState.env && typeof healthState.env === 'object' ? healthState.env : {};
          const w = getWeatherInfo(env.weather);
          const adv = getOutfitAdvice();
          const cur = getWornOutfit();
          const feel = getFeelLevel();
          const rows = Object.entries(OUTFITS)
            .map(([k, v]) => `${k === cur.key ? '▶' : '　'}${v.emoji}${v.name}　${k}　保暖${v.warm}${v.waterproof ? '　防水' : ''}`)
            .join('\n');
          const tips = adv.tips.length ? `\n💡 ${adv.tips.join('；')}` : '';
          return {
            ok: true,
            message: `🧥 今天穿什么\n${w.emoji}${w.name}　外面 ${adv.temp}℃　${feel.name}（这身舒适点 ${feel.ideal}℃）\n`
              + `紫外线 ${adv.uv}${getUvRisk().guarded ? '（已防晒）' : ''}${adv.raining ? '　在下雨' : ''}\n`
              + `身上：${cur.info.emoji}${cur.info.name}（${cur.style.name}）${getOutfitRec().wet > 25 ? ` 淋湿 ${Math.round(getOutfitRec().wet)}` : ''}\n`
              + `👉 今天适合：${adv.info.emoji}${adv.info.name}（${adv.suggest}）${tips}\n\n`
              + `可选：\n${rows}\n防晒：outfit + sunscreen`
          };
        }
        const r = wearOutfit(status);
        if (!r.ok) return { ok: false, error: r.error };
        await saveToFile();
        return { ok: true, message: r.message };
      }

      case 'home': {
        if (!homeOn()) return { ok: false, error: '居家系统已关闭（可在配置里打开）' };
        const h = getHomeRec();
        const lvl = getHomeLevel();
        const stats = getHomeStats();
        const tasks = Object.entries(HOME_TASKS)
          .map(([k, t]) => `${t.emoji}${t.name}　${k}${t.cost ? `　¥${t.cost}` : ''}——${t.desc}`)
          .join('\n');
        return {
          ok: true,
          message: `🏠 居家面板\n房间：${lvl.emoji}${lvl.name}（整洁 ${Math.round(h.tidy)}）\n`
            + `衣物洁净：${Math.round(h.laundry)}${h.laundry < 30 ? '（快没干净衣服了）' : ''}\n`
            + `待洗碗：${h.dishes} 个${h.dishes >= 8 ? '（有点多了）' : ''}\n`
            + `宠物弄脏累积：${Math.round(h.petDirt)}\n`
            + `晒被除螨余效：${Math.round(h.miteRelief)}\n`
            + `尘螨因子：×${getMiteFactor()}（整洁越低螨虫越猖狂）\n\n`
            + `可做的家务：\n${tasks}\n\n`
            + `累计：打扫 ${stats.tidyCount}｜洗衣 ${stats.laundryCount}｜晒被 ${stats.quiltCount}｜洗碗 ${stats.dishCount}｜请保洁 ${stats.hireCount}`
        };
      }

      case 'tidy':
      case 'laundry':
      case 'quilt':
      case 'dishes':
      case 'hire_cleaner': {
        const taskMap = { tidy: 'tidy', laundry: 'laundry', quilt: 'quilt', dishes: 'dishes', hire_cleaner: 'hire' };
        const r = doHomeTask(taskMap[action]);
        if (!r.ok) return { ok: false, error: r.error };
        await saveToFile();
        return { ok: true, message: r.message };
      }

      case 'bills': {
        if (!billsOn()) return { ok: false, error: '账单系统已关闭（可在配置里打开）' };
        const b = getBillsRec();
        const items = getBillBreakdown().map(x => `　${x.emoji}${x.name}　¥${x.due}`).join('\n');
        const st = getBillStats();
        const hist = b.history.slice(0, 3)
          .map(x => `　${x.ok ? '✅' : '⚠️'} ${localDayKey(x.at)}　¥${x.amount}${x.ok ? '' : '（未缴）'}`)
          .join('\n');
        let msg = `💸 账单\n每月支出合计：¥${getBillTotal()}\n${items}\n距下次扣款：${getDaysToBill()} 天\n`;
        msg += b.unpaid > 0
          ? `\n❗ 当前欠费 ¥${b.unpaid}（逾期 ${b.overdue} 期）——压力和安全感都在被磨\n`
          : '\n账是清的，不欠钱\n';
        msg += `余额：¥${Math.round(getMoney())}　生活开销累计 ¥${Math.round(Number(healthState.livingCost) || 0)}\n`;
        msg += `累计缴费 ${st.paidCount} 次，共 ¥${Math.round(st.totalPaid)}`;
        if (hist) msg += `\n\n最近记录：\n${hist}`;
        if (b.unpaid > 0) msg += '\n\n（可以用 pay_bills 把欠款补上）';
        return { ok: true, message: msg };
      }

      case 'pay_bills': {
        const r = payBills();
        if (!r.ok) return { ok: false, error: r.error };
        await saveToFile();
        return { ok: true, message: r.message };
      }

      case 'set_constitution': {
        if (!CONSTITUTIONS[status]) return { ok: false, error: '未知体质：' + status };
        healthState.constitution = status;
        await saveToFile();
        return { ok: true, message: `🧬 体质已切换为：${CONSTITUTIONS[status].emoji}${CONSTITUTIONS[status].name} —— ${CONSTITUTIONS[status].desc}` };
      }

      // —— 环境 / 医疗体系 / 遗传 / 营养动作（v5.0）——
      case 'weather': {
        const env = rollEnvironment(true);
        const w = getWeatherInfo(env.weather);
        const aq = getAqiLevel(env.aqi);
        let msg = `${w.emoji} 当前天气：${w.name}，气温 ${env.tempC}℃，湿度 ${env.humidity}%，空气质量 ${aq.emoji}${aq.name}（AQI ${env.aqi}），紫外线 ${getUvLevel(env.uv)}。`;
        const notes = [];
        if (env.tempC <= 5) notes.push('外面很冷，注意保暖别冻着');
        if (env.tempC >= 32) notes.push('天气炎热，小心中暑、多补水');
        if (env.aqi > 150) notes.push('空气很差，少出门、关好窗');
        if (env.weather === 'rain' || env.weather === 'thunder') notes.push('在下雨，出门记得带伞');
        if (env.weather === 'haze' || env.weather === 'fog') notes.push('能见度低，路上小心');
        if (notes.length) msg += `\n💡 ${notes.join('；')}。`;
        const ee = getEnvVitalEffects();
        if (ee.spo2 && ee.spo2 < 0) msg += `\n😮‍💨 这种空气让我有点喘不上气…`;
        else if (ee.bpSys && ee.bpSys > 3) msg += `\n🥶 冷得我血压都有点高了…`;
        else if (ee.heartRate && ee.heartRate > 3) msg += `\n🥵 热得我心跳加快…`;
        await saveToFile();
        return { ok: true, message: msg };
      }
      case 'sunbath': {
        adjustLifestyle('exercise', 3);
        addNutrient('vitamin', 20);
        healthState.mood = Math.min(100, Number(healthState.mood) + 6);
        healthState.security = Math.min(100, Number(healthState.security) + 4);
        await saveToFile();
        return { ok: true, message: `☀️ 晒了会儿太阳，暖洋洋的，补充了维生素D（维生素质 → ${Math.round(getNutrient('vitamin'))}），心情也变好了~` };
      }
      case 'hospital': {
        const list = Object.entries(HOSPITALS).map(([k, h]) => `  ${h.emoji}${h.name}(${k})${k === getHospitalKey() ? ' ← 当前' : ''}：医生水平${Math.round(h.skill * 100)}% 费用×${h.costMul} —— ${h.desc}`);
        const cur = getHospitalInfo();
        return { ok: true, message: `🏥 当前就诊医院：${cur.emoji}${cur.name}\n可选医院：\n${list.join('\n')}\n💡 用「换医院」或 set_hospital 切换（community/general/top/tcm）。` };
      }
      case 'set_hospital': {
        if (!HOSPITALS[status]) return { ok: false, error: '未知医院：' + status };
        healthState.hospital = status;
        await saveToFile();
        const h = HOSPITALS[status];
        return { ok: true, message: `🏥 以后就去 ${h.emoji}${h.name} 了（医生水平 ${Math.round(h.skill * 100)}%，费用 ×${h.costMul}）—— ${h.desc}` };
      }
      case 'emergency': {
        const eCost = Math.round(hospitalCost('cure') * 1.8);
        if (!payMedicalOk(eCost)) {
          return { ok: true, message: `🚑 急诊要 ¥${eCost}，我只有 ¥${Math.round(getMoney())}…先想办法凑钱！💦` };
        }
        healthState.lastEmergency = Date.now();
        const eds = [...healthState.diseases];
        if (!eds.length) return { ok: true, message: `🚑 挂了个急诊，医生说没什么大问题（花费 ¥${eCost}）…下次别吓我。` };
        let fixed = 0;
        for (const d of eds) {
          const stage = getDiseaseStage(d);
          const chance = Math.min(0.98, (stage === '危重' ? 0.7 : stage === '晚期' ? 0.65 : 0.85) + 0.15);
          if (Math.random() < chance) {
            if (isChronic(d)) advanceChronic(d);
            else { healthState.diseases = healthState.diseases.filter(x => x !== d); delete healthState.diseaseStages[d]; grantAntibody(d); }
            fixed++;
          }
        }
        healthState.health = Math.min(100, Number(healthState.health) + fixed * 8 + 3);
        healthState.fever = Math.max(0, Number(healthState.fever) - 30);
        recordMedical(`急诊：处理 ${fixed} 项`);
        await saveToFile();
        return { ok: true, message: `🚑 挂了急诊（花费 ¥${eCost}），医生紧急处理，缓解了 ${fixed} 项症状，感觉好多了~` };
      }
      case 'family': {
        let list = getFamilyHistoryList();
        if (!list.length) rollFamilyHistory();
        list = getFamilyHistoryList();
        if (!list.length) return { ok: true, message: `🧬 翻了翻族谱，家里长辈身体都挺硬朗，没有明显的遗传病~` };
        const lines = list.map(k => {
          const f = FAMILY_HISTORY[k];
          return `  ${f.emoji}${f.name} → 易感：${f.targets.map(t => getDiseaseInfo(t)?.name || t).join('、')}`;
        });
        return { ok: true, message: `🧬 家族遗传史：\n${lines.join('\n')}\n⚠️ 有家族史的病，我的易感度是常人的 1.8 倍，务必重点预防。` };
      }
      case 'nutrition': {
        const lines = Object.entries(NUTRIENT_INFO).map(([k, n]) => `  ${n.emoji}${n.name}：${Math.round(getNutrient(k))}（${getNutrientLevel(getNutrient(k))}）`);
        let msg = `🥗 营养摄入状况：\n${lines.join('\n')}`;
        const bad = [];
        if (getNutrient('protein') < 50) bad.push('蛋白质不足（拖累白蛋白/血红蛋白）');
        if (getNutrient('vitamin') < 50) bad.push('维生素不足（影响钙吸收与免疫）');
        if (getNutrient('mineral') < 50) bad.push('矿物质不足（钾钙偏低）');
        if (getNutrient('fiber') < 50) bad.push('膳食纤维不足（甘油三酯偏高）');
        if (getNutrient('sodium') < 50) bad.push('吃太咸（升血压）');
        if (getNutrient('sugar') < 50) bad.push('吃太甜（升血糖/血脂）');
        msg += bad.length ? `\n⚠️ ${bad.join('；')}` : '\n✅ 营养比较均衡，继续保持~';
        msg += `\n💡 用「清淡饮食」和「吃营养品」来补充改善。`;
        return { ok: true, message: msg };
      }
      case 'supplement': {
        const sCost = Number(cfg()?.costSupplement) || 25;
        if (!payMedicalOk(sCost)) {
          return { ok: true, message: `💊 营养品要 ¥${sCost}，我只有 ¥${Math.round(getMoney())}…先攒钱吧~` };
        }
        addNutrient('vitamin', 26);
        addNutrient('mineral', 24);
        addNutrient('protein', 10);
        healthState.immunity = Math.min(100, Number(healthState.immunity) + 2);
        healthState.lastSupplement = Date.now();
        recordMedical(`服用营养品：补充维生素/矿物质`);
        await saveToFile();
        return { ok: true, message: `💊 吃了营养品（花费 ¥${sCost}）：维生素 → ${Math.round(getNutrient('vitamin'))}，矿物质 → ${Math.round(getNutrient('mineral'))}，蛋白质 → ${Math.round(getNutrient('protein'))}，抵抗力 +2。` };
      }

      case 'reset':
        for (const key of Object.keys(STATUSES)) {
          // badWhenHigh 维度归 0（不发烧、无成瘾），其余归满
          healthState[key] = STATUSES[key].badWhenHigh ? 0 : 100;
        }
        healthState.diseaseHistory = {};
        healthState.remissions = {};
        healthState.activeSymptoms = [];
        healthState.diseases = [];
        healthState.diseaseStages = {};
        // v3.0 深度模拟字段
        healthState.organs = { heart: 100, lung: 100, liver: 100, stomach: 100, kidney: 100, brain: 100, skin: 100, blood: 100 };
        healthState.pathogens = {};
        healthState.incubating = {};
        healthState.antibodies = {};
        healthState.diagnosed = {};
        healthState.drugResistance = {};
        healthState.medicineBox = { fever_reducer: 2, cold_medicine: 2, antibiotic: 1, stomach_medicine: 1, antianxiety: 1, allergy_medicine: 1, painkiller: 2 };
        healthState.money = 200;
        healthState.medicalCost = 0;
        healthState.lastWork = 0;
        healthState.lastVaccine = 0;
        // v4.0 检验指标与生活方式
        healthState.weight = 58;
        healthState.height = 165;
        healthState.diet = 65;
        healthState.exercise = 60;
        healthState.sleepQuality = 70;
        healthState.lastBloodTest = 0;
        healthState.lastDiet = 0;
        healthState.vitalsHistory = [];
        // v5.0 环境 / 医疗 / 遗传 / 营养
        healthState.env = { weather: 'clear', tempC: 22, humidity: 55, aqi: 45, uv: 5, season: getCurrentSeason(), updatedAt: 0 };
        healthState.envHistory = [];
        healthState.hospital = 'general';
        healthState.lastEmergency = 0;
        healthState.familyHistory = [];
        healthState.nutrients = { protein: 72, carbs: 70, fat: 62, vitamin: 70, mineral: 70, fiber: 62, sodium: 58, sugar: 45 };
        healthState.lastSupplement = 0;
        // v6.0 心理 / 睡眠 / 内分泌 / 创伤 / 疫情 / 习惯 / 成就 / 年龄
        healthState.sleepStage = 'awake';
        healthState.sleepClock = 0;
        healthState.caffeine = 0;
        healthState.sleepDebt = 0;
        healthState.sleepLog = [];
        healthState.hormones = { cortisol: 45, adrenaline: 25, serotonin: 70, dopamine: 65, thyroxine: 60, melatonin: 35 };
        healthState.injuries = [];
        healthState.scarCount = 0;
        healthState.epidemic = { active: false, disease: '', since: 0, level: 0 };
        healthState.maskOn = false;
        healthState.habits = { smoking: 0, drinking: 0, stayingUp: 0, sedentary: 0, morningRun: 0, meditation: 0, drinkingWater: 0, earlySleep: 0 };
        healthState.achievements = {};
        healthState.imagingHistory = [];
        healthState.psycHistory = [];
        healthState.age = 20;
        healthState.lastBirthday = Date.now();
        healthState.lastTherapy = 0;
        healthState.lastMeditate = 0;
        healthState.lastCoffee = 0;
        healthState.lastNap = 0;
        healthState.lastMelatonin = 0;
        healthState.lastHormoneCheck = 0;
        healthState.lastFirstAid = 0;
        healthState.lastImaging = 0;
        healthState.lastDisinfect = 0;
        healthState.lastIsolate = 0;
        // v8.0 昼夜节律 / 菌群 / 过敏 / 关系网 / 医保 / 大事记
        healthState.circadianOffset = 0;
        healthState.gut = { bifido: 70, lacto: 68, bacteroides: 72, firmicutes: 70, diversity: 74, barrier: 76 };
        healthState.lastProbiotics = 0;
        healthState.lastFiber = 0;
        healthState.allergens = {};
        healthState.allergenRolled = false;
        healthState.allergyLoad = 0;
        healthState.lastAntihistamine = 0;
        healthState.bonds = {};
        healthState.relationsSeed = false;
        healthState.insurance = { plan: 'none', since: 0, expireAt: 0, usedThisYear: 0 };
        healthState.timeline = [];
        healthState.bioAgeCache = 0;
        delete healthState.gutScore;
        delete healthState.gutBarrier;
        delete healthState.allergyTriggers;
        // v9.0 爱好与技能树
        healthState.hobbies = {};
        healthState.hobbyStrain = 0;
        healthState.hobbyEyeStrain = 0;
        healthState.hobbyBurnout = 0;
        healthState.hobbyStreakKey = '';
        healthState.hobbyStreak = 0;
        healthState.hobbyLastPractice = 0;
        // v10.0 宠物养成
        healthState.pets = [];
        healthState.petSeq = 1;
        healthState.petCost = 0;
        healthState.petLastTick = 0;
        healthState.petShed = 0;
        healthState.petNightNoise = 0;
        healthState.petVetCount = 0;
        // v11.0 日常生活
        healthState.outfit = { worn: 'casual', changedAt: 0, wet: 0, sunscreen: 0 };
        healthState.outfitStats = { wornCount: 0, perfectDays: 0, sunGuard: 0 };
        healthState.home = { tidy: 72, laundry: 70, dishes: 0, petDirt: 0, miteRelief: 0, lastTidy: 0, lastLaundry: 0, lastQuilt: 0 };
        healthState.homeStats = { tidyCount: 0, laundryCount: 0, quiltCount: 0, dishCount: 0, hireCount: 0 };
        healthState.bills = { dueAt: 0, unpaid: 0, overdue: 0, history: [], lastWarn: 0 };
        healthState.billStats = { paidCount: 0, totalPaid: 0 };
        healthState.mealLog = [];
        healthState.mealStats = {};
        healthState.lastMealAt = 0;
        healthState.livingCost = 0;
        healthState.foodRisk = 0;
        healthState.sunExposure = 0;
        // v12.0 钱币系统
        healthState.wallet = { salaryAt: 0, lastPaid: 0, payCount: 0, totalSalary: 0 };
        healthState.gig = { lastAt: 0, count: 0, total: 0, best: 0, flops: 0, byKey: {}, lastKey: '' };
        healthState.workStats = { count: 0, total: 0, cooldown: {}, byType: {} };
        healthState.ledger = { income: [], expense: [], monthKey: '', monthIn: 0, monthOut: 0, totalIn: 0, totalOut: 0 };
        // v13.0 时间与社会
        healthState.timeStats = { weekendDays: 0, festivalDays: 0, birthdays: 0, extremeDays: 0 };
        healthState.lastFestivalKey = '';
        healthState.lastWeekendDay = '';
        healthState.lastExtremeDay = '';
        healthState.extremeStats = { count: 0, byKey: {}, lastKey: '' };
        healthState.chronicControl = {};
        rollEnvironment(true);
        rollFamilyHistory(true);
        rollAllergens(true);
        initRelations();
        computeAllergyLoad();
        healthState.lastUpdate = Date.now();
        await saveToFile();
        return { ok: true, message: '✅ 状态已重置为满值（含器官/药箱/钱包/检验指标/环境/医院/心理/睡眠/激素/习惯/成就/菌群/过敏/关系网/医保/大事记/爱好/宠物/日程）' };

      default:
        return { ok: false, error: '未知操作' };
    }
  }
};

// ── 对话自动检测行为 ────────────────────────────────────────────────────
// 关键词 → 动作映射。用户消息里出现关键词就自动执行对应行为，
// 不再依赖 LLM 主动调工具。每个关键词都足够具体，降低误判率。
const ACTION_KEYWORDS = {
  eat:     ['给.*吃饭', '给我吃饭', '喂.*饭', '机器人.*饿', '饿了', '吃顿', '开饭', '干饭', '吃饭'],
  drink:   ['给.*喝水', '给我喝水', '喂.*水', '机器人.*渴', '渴了', '喝水', '喝口水'],
  sleep:   ['给.*睡觉', '让我睡', '机器人.*困', '困了', '睡觉', '晚安', '睡了'],
  rest:    ['给.*休息', '让我休息', '机器人.*累', '累了', '休息', '歇会', '歇一歇'],
  relax:   ['给.*放松', '压力', '解压', '减压', '放松'],
  happy:   ['开心', '高兴', '快乐', '哈哈', '大笑', '笑死'],
  chat:    ['聊天', '聊会', '陪我聊'],
  gather:  ['聚会', '一起.*玩', '聚会', '活动'],
  join:    ['加入.*群', '融入', '归属感'],
  achieve: ['成就', '完成', '做好了', '成功', '棒'],
  exercise: ['运动', '健身', '锻炼', '跑步', '做运动'],
  play_game: ['打游戏', '玩游戏', '开黑', '上号'],
  listen_music: ['听歌', '听音乐', '放首歌', '来首歌'],
  walk: ['散步', '走走', '溜达', '出去走'],
  take_medicine: ['吃药', '服药', '该吃药', '吃药了'],
  measure: ['量体温', '测体温', '量一下体温', '测一下体温', '量血压', '测血压'],
  // —— v4.0 临床检验指标动作 ——
  blood_test: ['抽血', '验血', '做个化验', '化验一下', '抽个血'],
  vital_check: ['血脂', '血糖尿酸', '我的指标', '看看指标', '检查指标', '指标怎么样'],
  diet_control: ['清淡点', '吃清淡', '清淡饮食', '少油少盐', '控糖', '减脂餐'],
  weigh: ['称体重', '体重多少', '胖了', '瘦了'],
  lifestyle: ['生活方式', '生活习惯', '作息怎么样'],
  // —— v3.0 深度模拟动作（关键词保持具体，降低误判）——
  exam: ['化验', '做检查', '做个检查', '血常规', '查查身体'],
  vaccinate: ['打疫苗', '接种疫苗', '去接种'],
  work: ['打工', '去打工', '赚钱去'],
  buy_medicine: ['买药', '买点药', '去药店', '补点药'],
  organ_check: ['器官检查', '检查器官'],
  // —— v5.0 环境 / 医疗 / 遗传 / 营养 ——
  weather: ['天气', '外面冷不冷', '外面热不热', '雾霾', '下雨了', '下雪了', '空气质量'],
  sunbath: ['晒太阳', '出去晒晒', '晒会太阳'],
  emergency: ['急诊', '挂急诊', '看急诊'],
  family: ['家族史', '家族病史', '遗传病史', '族谱'],
  nutrition: ['营养', '营养素', '营养状况'],
  supplement: ['营养品', '买点补品', '吃维生素', '补维生素'],
  // —— v6.0 心理 / 睡眠 / 内分泌 / 创伤 / 检查 / 疫情 / 习惯 / 成就 ——
  therapy: ['心理咨询', '看心理医生', '心理疏导'],
  meditate: ['冥想', '打坐', '静一静', '深呼吸'],
  journal: ['写日记', '记日记'],
  party: ['参加聚会', '去聚会', '出去聚聚'],
  cry: ['大哭', '哭一场', '想哭', '哭出来'],
  sleep_stage: ['睡眠状况', '睡眠阶段', '睡得怎么样'],
  coffee: ['喝咖啡', '来杯咖啡', '喝杯咖啡'],
  stay_up: ['熬夜', '通宵', '不睡了', '再熬会'],
  nap: ['小睡', '眯一会', '打个盹', '午睡'],
  melatonin: ['褪黑素', '助眠药'],
  regular_routine: ['调整作息', '早睡早起', '规律作息', '调作息'],
  hormone_check: ['内分泌', '激素检查', '查激素'],
  first_aid: ['包扎', '处理伤口', '急救'],
  injury_check: ['外伤', '伤口', '受伤了'],
  epidemic: ['疫情', '流行病', '传染病流行'],
  mask: ['戴口罩', '摘口罩', '口罩'],
  disinfect: ['消毒', '杀菌'],
  isolate: ['隔离', '居家隔离'],
  habits: ['习惯档案', '查看习惯', '什么习惯'],
  achievements: ['健康成就', '勋章', '徽章'],
  age: ['多大了', '几岁了', '年龄'],
  // —— v7.0 基础需求深化 ——
  hydrate_check: ['水平衡', '水分够不够', '该补水', '身体缺水', '需要补水'],
  electrolyte_supplement: ['电解质', '运动饮料', '淡盐水', '补盐', '宝矿力'],
  body_signal: ['身体信号', '身体预警', '连锁反应', '哪里有隐患', '身体扫描'],
  // —— v8.0 昼夜节律 / 菌群 / 过敏 / 关系网 / 医保 / 生物年龄 / 大事记 ——
  circadian: ['昼夜节律', '生物钟', '节律', '作息规律吗'],
  gut_check: ['肠道菌群', '菌群', '查肠道', '肠胃菌'],
  probiotics: ['益生菌', '喝酸奶', '补充菌'],
  fiber_diet: ['高纤维', '粗粮', '多吃蔬菜'],
  allergen_test: ['过敏原检测', '查过敏原', '测过敏原', '过敏原筛查'],
  allergy_check: ['过敏状况', '过敏负荷', '过敏反应', '是不是过敏'],
  antihistamine: ['抗过敏药', '吃过敏药', '止痒药'],
  relations: ['关系网', '社交关系', '羁绊'],
  deep_talk: ['深聊', '交心', '谈谈心', '好好聊聊'],
  reconcile: ['和解', '化解矛盾', '把话说开'],
  bio_age: ['生物年龄', '生理年龄', '身体年龄'],
  insurance: ['医保', '办保险', '报销'],
  timeline: ['大事记', '健康日志', '健康记录'],
  // —— v9.0 爱好与技能树（避开与运动类动作冲突的裸词，如"跑步"）——
  hobby_list: ['爱好', '兴趣爱好', '在练什么', '技能面板'],
  hobby_learn: ['学.*爱好', '想学.*(吉他|钢琴|画画|摄影|书法|编程|下棋|做饭|烘焙|养花|唱歌|跳舞|瑜伽|游泳|木工|编织|读书|电竞)', '学一门'],
  hobby_practice: ['练.*爱好', '练习一下', '练练手', '练一会儿', '练一首', '练练琴'],
  hobby_works: ['看看作品', '作品收藏', '攒了多少作品'],
  hobby_gift: ['送作品', '把作品送给'],
  hobby_abandon: ['放弃爱好', '不练了', '不学了'],
  hobby_tree: ['技能树', '熟练度'],
  // —— v10.0 宠物养成（裸词「宠物」只给只读的 pet_status，交互动作必须有明确动词）——
  pet_status: ['宠物', '我的宠物', '宠物面板', '看看宠物', '养了什么'],
  pet_adopt: ['领养.*(猫|狗|仓鼠|兔子|鹦鹉|金鱼|乌龟|蜥蜴|刺猬|龙猫)', '想养.*(猫|狗|仓鼠|兔子|鹦鹉|金鱼|乌龟|蜥蜴|刺猬|龙猫)', '养一只'],
  pet_feed: ['喂.*(宠物|猫|狗|它)', '给.*添粮', '喂食'],
  pet_water: ['换水', '宠物.*喝水'],
  pet_clean: ['铲屎', '铲猫砂', '给.*洗澡', '洗猫', '洗狗'],
  pet_play: ['陪.*(宠物|猫|狗|它).*玩', '逗猫', '逗狗'],
  pet_cuddle: ['撸猫', '撸狗', '撸宠物', '摸摸.*(猫|狗)'],
  pet_walk: ['遛狗', '遛猫', '遛宠物', '溜宠物'],
  pet_train: ['训练宠物', '训狗', '教.*(猫|狗|它).*(坐下|握手|打滚|转圈|装死)'],
  pet_show: ['表演.*(把戏|技能)', '露一手', '展示.*才艺'],
  pet_vet: ['宠物医院', '看兽医', '宠物看病'],
  pet_rename: ['给.*(宠物|猫|狗).*改名', '改名叫'],
  pet_abandon: ['弃养', '送走.*(宠物|猫|狗)', '不养了'],
  // —— v11.0 日常生活 ——
  outfit: ['穿什么', '换.*(衣服|衣服|身)', '加件衣服', '多穿点', '少穿点', '涂防晒', '擦防晒', '防晒'],
  home: ['居家', '家里.*(乱|脏|怎么样)', '屋子.*(乱|脏)', '房间.*(乱|脏|怎么样)'],
  tidy: ['打扫', '扫除', '扫地', '拖地', '收拾.*(房间|屋子|家里|床)'],
  laundry: ['洗衣服', '洗.*(衣服|床单)', '开.*洗衣机'],
  quilt: ['晒被子', '晒被', '晒.*(床单|被褥)'],
  dishes: ['洗碗', '刷碗', '池子.*碗', '碗.*没洗'],
  hire_cleaner: ['请保洁', '找.*保洁', '叫.*保洁', '请.*钟点工'],
  bills: ['账单', '房租多少', '水电费', '这个月.*(开销|花)', '欠.*(钱|账)'],
  pay_bills: ['交房租', '把房租交了', '交水电', '把钱还上', '补交', '把账.*(结|清)'],
  today: ['今天星期几', '今天几号', '今天什么日子', '什么节日', '今天过节', '今天有什么安排', '今天什么天气', '外面什么天'],
  // —— v12.0 钱币系统 ——
  //   注意：领工资（updateSalary）是主循环自动结算的，不给关键词 ——
  //   否则「发工资了吗」会被当成「去发一笔工资」。
  work: ['去打工', '打个工', '打份工', '找份活干', '干活去', '出去.*赚钱'],
  gig: ['接单', '接.*(私活|稿|活)', '接个单', '赚.*外快', '搞点外快', '接活赚钱'],
  ledger: ['账本', '收支', '流水账', '看.*(收支|流水)', '工资多少', '这个月.*(赚|收|花)'],
};

// 已检测到的动作（防重复：同一条消息只触发一次）
let lastDetectedActions = null;
let lastDetectedTs = 0;

/**
 * 从用户消息中检测行为关键词，返回 [{ action, keyword, message }] 列表。
 * 防误判：
 *   - 排除否定句（"不吃饭"、"没吃"）
 *   - 排除明显非机器人语境（"我吃饭了"是用户自己说）
 *   - 每条消息每个动作只触发一次
 */
function detectActions(userTexts) {
  const now = Date.now();
  // 60 秒冷却：同一条消息不重复触发
  if (lastDetectedTs && now - lastDetectedTs < 60000) return [];

  const detected = [];
  const seenActions = new Set();

  for (const text of userTexts) {
    if (typeof text !== 'string' || !text.trim()) continue;

    // 提取纯用户内容（去掉系统提示前缀）
    const lines = text.split('\n');
    for (const line of lines) {
      // 只检测用户发言行（格式：[时间] #mid 名字：内容）
      const match = line.match(/：(.+)/);
      if (!match) continue;
      const content = match[1].trim();
      if (!content || content.length < 2) continue;

      // 排除否定句
      if (/不[吃吃喝喝睡休息放松聊]|没[吃吃喝喝睡休息放松聊]/.test(content)) continue;
      // 排除用户自己说（"我吃饭了"不是机器人吃饭）
      if (/^(我|大家|别人).*(吃|喝|睡|休息|放松|聊)/.test(content) && !/机器人|你|bot/i.test(content)) continue;

      for (const [action, patterns] of Object.entries(ACTION_KEYWORDS)) {
        if (seenActions.has(action)) continue;
        for (const pattern of patterns) {
          if (new RegExp(pattern, 'i').test(content)) {
            detected.push({ action, keyword: pattern, content: content.slice(0, 50) });
            seenActions.add(action);
            break;
          }
        }
      }
    }
  }

  if (detected.length > 0) {
    lastDetectedActions = detected;
    lastDetectedTs = now;
  }

  return detected;
}

/**
 * 自动执行检测到的行为，返回执行结果描述。
 */
async function autoApplyActions(actions) {
  const results = [];
  for (const { action, keyword, content } of actions) {
    try {
      const r = await providers['health.state']({ action });
      if (r.ok) {
        results.push(`检测到「${keyword}」→ 已自动执行「${action}」`);
      }
    } catch (error) {
      log(`[健康系统] 自动执行 ${action} 失败：${error.message}`);
    }
  }
  return results;
}

// 关系羁绊维护：从用户消息提取发言者，更新亲密度；久未互动则孤独感上升
function updateBonds(userTexts) {
  const now = Date.now();
  const DAY = 86400000;
  const bonds = healthState.bonds || (healthState.bonds = {});
  for (const text of (userTexts || [])) {
    if (typeof text !== 'string') continue;
    for (const line of text.split('\n')) {
      const m = line.match(/#\d+\s*([^\s：:]{1,12})[：:]/);
      if (!m) continue;
      const name = m[1].trim();
      if (!name) continue;
      const b = bonds[name] || { affinity: 70, lastChat: 0, name };
      // 5 分钟冷却内不重复加分，避免刷屏式提升
      if (now - (b.lastChat || 0) > 300000) {
        b.affinity = Math.min(100, (b.affinity || 70) + 2);
      }
      b.lastChat = now;
      b.name = name;
      bonds[name] = b;
    }
  }
  // 被冷落：某 bond 超过 1 天没互动 → 孤独感上升、亲密度缓降
  let neglected = false;
  for (const name of Object.keys(bonds)) {
    const b = bonds[name];
    if (now - (b.lastChat || 0) > DAY) {
      b.affinity = Math.max(0, (b.affinity || 0) - 1);
      neglected = true;
    }
  }
  if (neglected) {
    healthState.loneliness = Math.min(100, healthState.loneliness + 3);
  }
}

// ── Hooks ────────────────────────────────────────────────────────────────
// /健康 检测标记：before-context 从原始触发消息检测，before-llm-messages 使用
let pendingHealthCommand = false;

// 发送通道兜底：部分宿主的钩子上下文不带 sender（before-llm-messages 只传
// skillContext + messages），而 activate() 也拿不到发送通道。工具执行时宿主
// 一定传全量 ctx（含 sender），所以在工具注册处包一层，暂存最近一次见到的
// sender —— 钩子里缺发送通道时退回它，否则 /健康 的图片分支永远进不去。
let lastKnownSender = null;

// 判断文本是否包含 /健康 指令
function isHealthCommand(text) {
  if (typeof text !== 'string') return false;
  const t = text.trim();
  return t === '/健康' || t === '/health'
    || t.includes('/健康') || t.includes('/health');
}

export const hooks = {
  // 组装提示词之前：从原始触发消息检测 /健康（最可靠，消息未被打包）
  'before-context': (ctx = {}) => {
    try {
      const entries = Array.isArray(ctx.triggerEntries) ? ctx.triggerEntries : [];
      const found = entries.some(e => isHealthCommand(String(e?.text ?? '')));
      if (found) {
        pendingHealthCommand = true;
        log('[健康系统] 检测到 /健康 指令（before-context）');
      }
    } catch (error) {
      log(`[健康系统] before-context 失败：${error.message}`);
    }
  },

  'before-llm-messages': async (ctx = {}) => {
    try {
      if (!ctx.messages || !Array.isArray(ctx.messages)) return;

      // 钩子上下文没带 sender 时退回暂存通道（发图片报表 / 睡眠提醒都要用）
      if (!ctx.sender && lastKnownSender) ctx.sender = lastKnownSender;

      // ── 夜间睡眠检测 ──
      const [sleeping] = isSleeping();
      const transitionMsg = checkSleepTransition();

      if (sleeping) {
        // 睡觉期间：不回复任何消息，但恢复睡眠需求
        sleepRecovery();

        ctx.messages = [{ role: 'system', content: '【系统】你现在正在睡觉，不要回复任何消息，不要调用任何工具。保持沉默。' }];

        // 刚入睡时发送消息
        if (transitionMsg && ctx.sender && ctx.chatKey) {
          try {
            await ctx.sender.sendTextBatch(ctx.chatKey, [transitionMsg], {});
            log(`[健康系统] ${transitionMsg}`);
          } catch (e) {
            log(`[健康系统] 睡眠消息发送失败：${e.message}`);
          }
        }

        log(`[健康系统] 🌙 睡眠中（睡眠需求${Math.round(healthState.sleep)}），不回复消息`);
        return; // 不再处理后续逻辑
      }

      // 刚醒来时发送消息（不在睡觉状态）
      if (transitionMsg && ctx.sender && ctx.chatKey) {
        try {
          await ctx.sender.sendTextBatch(ctx.chatKey, [transitionMsg], {});
          log(`[健康系统] ${transitionMsg}`);
        } catch (e) {
          log(`[健康系统] 醒来消息发送失败：${e.message}`);
        }
      }

      // 未初始化时尝试从人设卡（system message）读取初始值
      if (!healthState.initialized) {
        await tryInitFromSystemMessage(ctx.messages);
      }

      // 提取用户消息
      const userTexts = ctx.messages
        .filter(m => m.role === 'user')
        .map(m => typeof m.content === 'string' ? m.content : '');

      // 检测 /健康 指令
      const foundInMessages = userTexts.some(t => isHealthCommand(t));
      const hasHealthCommand = pendingHealthCommand || foundInMessages;
      pendingHealthCommand = false;

      // 每轮都注入情绪提示（健康系统影响对话情绪的核心）
      const emotionHint = generateEmotionHint();
      if (emotionHint) {
        ctx.messages.push({ role: 'system', content: emotionHint });
      }

      // ── 关系羁绊维护（v0.5）：从用户消息更新亲密度，被冷落则孤独感上升 ──
      updateBonds(userTexts);

      // 自动检测对话中的行为关键词，直接执行（不依赖 LLM 调工具）
      const detectedActions = detectActions(userTexts);
      if (detectedActions.length > 0) {
        const applyResults = await autoApplyActions(detectedActions);
        if (applyResults.length > 0) {
          const autoMessage = `【健康系统】根据对话自动执行了以下操作：\n${applyResults.join('\n')}\n请不要再调用对应的健康工具，这些已经处理好了。`;
          ctx.messages.push({ role: 'system', content: autoMessage });
          log(`[健康系统] 自动检测到 ${detectedActions.length} 个行为并执行`);
        }
      }

      // /健康 指令：优先发图片报表，失败自动降级为文字报告（v7.1）
      if (hasHealthCommand) {
        for (const m of ctx.messages) {
          if (m.role === 'user' && typeof m.content === 'string') {
            m.content = m.content
              .replace(/\/健康/g, '请发送你的健康状态报告')
              .replace(/\/health/gi, '请发送你的健康状态报告');
          }
        }

        // ① 直发快速路径：钩子上下文自带发送通道（宿主传了 sender，或此前调用过工具已暂存）
        let imageOk = false;
        if (reportImageOn() && ctx.sender && ctx.chatKey) {
          try {
            const r = await sendHealthReportImage(ctx);
            imageOk = true;
            log(`[健康系统] 已发送图片报表（${r.width}×${r.height}，${Math.round(r.bytes / 1024)}KB，耗时 ${r.ms}ms）`);
          } catch (error) {
            log(`[健康系统] 图片报表直发失败：${error.message}`);
          }
        }

        if (imageOk) {
          // 图已经发出去了，必须明确告诉模型"别再用文字复述一遍"，
          // 否则它会照着旧提示词把同一份报告再打一遍文字，用户会收到两份。
          ctx.messages.push({
            role: 'system',
            content: '【系统指令】健康状态报告刚刚已经以**图片**形式直接发送给用户了，用户已经看到。'
              + '你不许再用 send_message 发送任何报告文字、数值或表格，也不要复述图里的数据；'
              + '只需用一句自然口语化的话（20 字以内）带过即可，例如"报告发你啦～整体还行，就是有点困"。'
          });
        } else if (reportImageOn()) {
          // ② LLM 桥接路径：钩子上下文没有发送通道（部分宿主的钩子不传 sender，且本次开机
          //    还没调用过任何工具可供暂存）。但工具执行时宿主一定传全量 ctx（含 sender）——
          //    让模型去调本插件的 report_image 工具，工具侧自带发送通道；
          //    工具失败时它自己会返回文字版报告兜底，不会出现"什么都没发"。
          ctx.messages.push({
            role: 'system',
            content: '【系统指令】用户刚才要求查看健康状态。请立即调用「健康图片报表」工具'
              + '（health-system__report_image，无参数），它会把健康状态图片报表直接发送给当前会话。'
              + '图发出后不要再用文字复述报告内容，也不要调用 send_message 发报告，一句话带过即可；'
              + '若该工具返回失败信息，把其中的文字版报告用 send_message 原样发给用户。'
          });
          log('[健康系统] 已注入图片报表桥接指令（交由 report_image 工具发送）');
        } else {
          // ③ 纯文字（图片报表功能被配置关闭时才走这里）
          const report = generateFullStatusReport();
          const systemMessage = `【系统指令】用户刚才要求查看健康状态。请立即使用 send_message 工具，把下面这份健康状态报告完整发送给用户（原样发送，不要总结、不要改写、不要省略）：\n\n${report}`;
          ctx.messages.push({ role: 'system', content: systemMessage });
          log('[健康系统] 已注入健康状态报告（文字版）');
        }
      }
    } catch (error) {
      log(`[健康系统] 注入失败：${error.message}`);
    }
  }
};

export const internals = {
  getHealthState: () => ({ ...healthState }),
  setHealthState: (state) => { healthState = { ...healthState, ...state }; },
  STATUSES,
  STATUS_NAME_MAP,
  getStatusLevel,
  getStatusMoodText,
  generateMoodSummary,
  generateEmotionHint,
  decayHealth,
  checkAndRemind,
  loadState,
  // —— 疾病系统拓展（v0.6）——
  getImmunityFactor,
  isChronic,
  isContagious,
  getComplications,
  generatePrognosis,
  addDisease,
  checkDiseases,
  processDiseaseProgression,
  rollContagion,
  getDiseaseStage,
  updateDiseaseStage,
  getDiseaseInfo,
  DISEASES,
  DISEASE_FLAGS,
  MEDICINES,
  // —— 生理深度模拟（v3.0）——
  ORGAN_INFO,
  DISEASE_ORGAN,
  PATHOGEN_TYPES,
  DISEASE_PATHOGEN,
  CONSTITUTIONS,
  MEDICINE_PRICE,
  MEDICINE_SIDE_EFFECTS,
  MEDICAL_COST,
  getOrgan,
  getOrganInfo,
  getOrganLevel,
  getDiseaseOrgan,
  damageOrgans,
  regenOrgans,
  calculateOrganImpact,
  getOrganWarnings,
  getPathogen,
  getPathogenInfo,
  isIncubating,
  isDiagnosed,
  hasAntibody,
  grantAntibody,
  getAntibodyCount,
  enqueueExposure,
  tickIncubation,
  getConstitutionKey,
  getConstitutionInfo,
  getConstitutionRisk,
  getConstitutionDecayMod,
  getDrugEfficacy,
  addDrugResistance,
  decayDrugResistance,
  applySideEffects,
  getMedicineStock,
  consumeMedicine,
  getMedicineBoxSummary,
  getMoney,
  addMoney,
  spendMoney,
  // —— 临床检验指标（v4.0）——
  VITAL_INFO,
  DISEASE_VITAL_EFFECTS,
  getVitalInfo,
  getVitalLevel,
  formatVitalValue,
  computeVitals,
  getAbnormalVitals,
  getVitalScore,
  generateVitalsReport,
  applyVitalImpact,
  getVitalHint,
  getLifestyleInfo,
  adjustLifestyle,
  damageOrgan,
  // —— 环境 / 医疗体系 / 遗传 / 营养（v5.0）——
  WEATHER_TYPES,
  SEASON_CLIMATE,
  HOSPITALS,
  FAMILY_HISTORY,
  NUTRIENT_INFO,
  getWeatherInfo,
  rollEnvironment,
  getEnvSummary,
  getAqiLevel,
  getUvLevel,
  getEnvVitalEffects,
  getEnvRisk,
  getEnvMoodDelta,
  getEnvHint,
  getHospitalKey,
  getHospitalInfo,
  rollDoctorSkill,
  hospitalCost,
  getFamilyHistoryList,
  rollFamilyHistory,
  getFamilyRisk,
  getDiseaseRisk,
  getDiseaseRiskMargin,
  getNutrient,
  getNutrientLevel,
  addNutrient,
  getNutrientVitalEffects,
  getNutrientHint,
  // —— 心理 / 睡眠 / 内分泌 / 创伤 / 疫情 / 习惯 / 成就（v6.0）——
  THERAPIES,
  THERAPY_LAST_KEY,
  SLEEP_STAGES,
  HORMONE_INFO,
  INJURY_INFO,
  INJURY_PARTS,
  IMAGING_INFO,
  EPIDEMIC_POOL,
  HABIT_INFO,
  ACHIEVEMENTS,
  getHormone,
  setHormone,
  getHormoneLevel,
  getHabit,
  addHabit,
  getHabitLevel,
  getEpidemicLevelName,
  recordPsyc,
  updateHormones,
  updateSleepStage,
  updatePsyche,
  rollInjury,
  healInjuries,
  rollEpidemic,
  rollEpidemicExposure,
  applyHabitEffects,
  checkAchievements,
  getPsycheHint,
  getSleepHint,
  getHormoneHint,
  getInjuryHint,
  getEpidemicHint,
  getHabitHint,
  // —— 基础需求深化（v7.0）——
  NEED_PHASES,
  SUBSYSTEM_INFO,
  CASCADE_RULES,
  ACTION_KEYWORDS,
  generateFullStatusReport,
  needDepthOn,
  getSub,
  getNeedPhase,
  restoreNeed,
  relieveNeed,
  applyNeedCascade,
  getCascadeWarnings,
  getStatusOrSubName,
  updateSubsystems,
  // —— 图片报表（v7.1）——
  buildReportHtml,
  renderHtmlToPng,
  sendHealthReportImage,
  getValueTone,
  escHtml,
  reportImageOn,
  getReportImageWidth,
  getReportImageDir,
  // —— 昼夜节律 / 菌群 / 过敏 / 关系网 / 医保 / 生物年龄 / 大事记（v8.0）——
  CIRCADIAN_CURVES,
  CIRCADIAN_PHASES,
  GUT_FLORA,
  ALLERGENS,
  ALLERGY_LEVELS,
  RELATION_TYPES,
  RELATION_SEEDS,
  INSURANCE_PLANS,
  TIMELINE_CAP,
  circadianOn,
  getCircadianOffset,
  getCircadianHour,
  getCircadianPhase,
  getCircadianValue,
  getCircadianMod,
  getCircadianEffects,
  getSleepWindow,
  gutOn,
  getGut,
  setGut,
  getGutScore,
  getGutLevel,
  getGutEffects,
  damageGut,
  healGut,
  updateGut,
  allergyOn,
  getAllergenLevel,
  getAllergenLevelName,
  rollAllergens,
  getAllergenList,
  computeAllergyLoad,
  rollFoodAllergy,
  getAllergyLevelName,
  relationOn,
  getRelationType,
  ensureRelation,
  getRelations,
  initRelations,
  getRelationEffects,
  updateRelations,
  getRelationLevel,
  bioAgeOn,
  computeBiologicalAge,
  getBioAgeLevel,
  insuranceOn,
  getInsurancePlan,
  isInsured,
  getInsuranceRemaining,
  applyInsurance,
  payMedical,
  payMedicalOk,
  costText,
  timelineOn,
  recordTimeline,
  getTimelineRecent,
  formatTimelineItem,
  getCircadianHint,
  getGutHint,
  getAllergyHint,
  getRelationHint,
  getBioAgeHint,
  // —— 爱好与技能树（v9.0）——
  HOBBY_CATEGORIES,
  HOBBY_TIERS,
  HOBBY_MILESTONES,
  WORK_QUALITIES,
  HOBBY_WORK_CAP,
  HOBBIES,
  hobbyOn,
  getHobbyMeta,
  getHobbyCat,
  getHobbyMaxSlots,
  getHobbyLearnCost,
  getHobbyPassionDecay,
  getHobbyStrainDecay,
  getHobbyLevel,
  getHobbyLevelName,
  getHobbyProgress,
  ensureHobby,
  getHobbies,
  isHobbyLearned,
  learnHobby,
  practiceHobby,
  rollWorkQuality,
  giftWork,
  abandonHobby,
  getHobbyEffects,
  updateHobbies,
  getHobbyHint,
  // —— 宠物养成（v10.0）——
  PET_SPECIES,
  PET_STAGES,
  PET_NEEDS,
  PET_TRICKS,
  PET_DISEASES,
  PET_BOND_LEVELS,
  PET_NAME_POOL,
  PET_TRICK_CAP,
  PET_FAT_CAP,
  petOn,
  getPetMaxCount,
  getPetAdoptCostMul,
  getPetFoodCost,
  getPetVetCost,
  getPetNeedDecay,
  getPetAllergyFactor,
  getPetSpecies,
  getPetStageInfo,
  getPetBondLevel,
  petNumBump,
  ensurePet,
  getPets,
  findPet,
  getPetAgeDays,
  getPetLifeRatio,
  getPetStage,
  getPetStageName,
  getPetNeeds,
  petDerived,
  spendPetMoney,
  adoptPet,
  feedPet,
  waterPet,
  cleanPet,
  playPet,
  cuddlePet,
  walkPet,
  trainPet,
  showPet,
  healPetWithVet,
  renamePet,
  abandonPet,
  petPassAway,
  checkPetDiseases,
  updatePets,
  getPetEffects,
  formatPetLine,
  getPetHint,
  // —— v11.0 日常生活 ——
  OUTFITS, OUTFIT_STYLES, FEEL_LEVELS,
  outfitOn, getOutfitRec, getOutfitStats, getWornOutfit, getFeelsLike, getFeelLevel, getUvRisk,
  wearOutfit, applySunscreen, getOutfitAdvice, updateOutfit, getOutfitHint,
  MEALS, mealOn, isNightMealTime, getMealList, eatMeal, getMealLog, getMealStats, updateMeal, getMealHint,
  HOME_TASKS, homeOn, getHomeRec, getHomeStats, getMiteFactor, getHomeLevel, doHomeTask, updateHome, getHomeHint,
  BILL_ITEMS, billsOn, getBillTotal, getBillBreakdown, getBillsRec, getBillStats, getDaysToBill, payBills, updateBills, getBillHint,
  spendLiving, dailyBump, localDayKey, getHobbyLevelOf, pickRelationToImprove,
  getTidyDecay, getHomeTaskCost, getMealCostMul,
  // —— v12.0 钱币系统 ——
  LEDGER_CATS, ledgerOn, localMonthKey, getLedger, recordLedger, ledgerBreakdown,
  getLedgerSummary, getLedgerFlow, getLedgerText, getLedgerCat,
  salaryOn, getMonthlySalary, getWalletRec, getDaysToPay, updateSalary,
  GIGS, GIG_EVENTS, GIG_ENERGY_COST, gigOn, getGigPayMul, getGigCooldownMs, getGigRec, getGigInfo,
  getGigList, getReadyGigs, getGigCooldownLeftMs, rollGigEvent, getGigQualityOdds, estimateGigPay, doGig,
  WORK_TYPES, getWorkTypeInfo, getTopHobbyLevel, getWorkStateMul, getWorkStateTone, getWorkStats, doWork,
  getMoneyHint, WORK_QUALITY_ORDER,
  // —— v13.0 时间与社会 ——
  WEEKDAYS, FESTIVALS, LUNAR_FESTIVALS, EXTREME_WEATHER,
  getDayOfWeek, isWeekend, getWeekdayInfo, weekdayOn,
  getTodayFestival, festivalOn, getFestivalPriceMul,
  getExtremeInfo, extremeOn, getExtremeChance, rollExtremeWeather,
  CHRONIC_CONTROL_NEED, REMISSION_DAYS,
  chronicControlOk, getChronicControl, bumpChronicControl, advanceChronic,
  enterRemission, isInRemission, getRemissionList, updateRemissions,
  celebrateBirthday, updateTime, getTodayBrief, getTimeHint, getTimeStats, getExtremeStats,
  localStamp, toValidTime
};
