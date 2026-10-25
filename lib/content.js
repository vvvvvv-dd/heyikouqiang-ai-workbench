/**
 * 内容生产引擎（方向 A 的本地引擎）
 * 输入：主题 / 节气 / 门诊素材 + 平台 + 变体序号
 * 输出：按平台特征结构化的内容，每条都能追溯到门诊知识库条目
 * 合规：任何生成结果都会过一遍合规体检，命中即标记并给出改写建议
 */
const kb = require('./kb');

/* ================= 平台画像 ================= */
const PLATFORMS = {
  xhs: {
    key: 'xhs', name: '小红书', icon: '📕', color: '#ff4d6d',
    reader: '以 20–40 岁女性为主的主动搜索型用户',
    tone: '朋友口吻、短句、真实感强，标题要有明确的搜索词',
    format: '图文笔记（封面标题 + 正文 + 话题标签）',
    limits: '正文 300–800 字，分段短，多用换行和序号'
  },
  douyin: {
    key: 'douyin', name: '抖音', icon: '🎵', color: '#161823',
    reader: '泛人群信息流，前 3 秒决定完播',
    tone: '口语化、节奏快、一句话一个信息点',
    format: '短视频脚本（分镜表：时间 / 画面 / 口播 / 字幕）',
    limits: '建议 35–50 秒，钩子前置，结尾给行动指令'
  },
  sph: {
    key: 'sph', name: '微信视频号', icon: '💚', color: '#07c160',
    reader: '微信熟人社交链，中老年与本地家长占比高',
    tone: '温暖克制、可信、不夸张，适合本地信任传播',
    format: '视频脚本 + 封面标题 + 转发语',
    limits: '建议 45–60 秒，语速略慢，字幕大一号'
  },
  gzh: {
    key: 'gzh', name: '微信公众号', icon: '📘', color: '#2b6cb0',
    reader: '已关注门诊的老客户与本地家长，阅读耐心较高',
    tone: '专业、完整、可保存，结构清晰',
    format: '长图文（标题 + 导语 + 分节正文 + 温馨提示 + 门诊信息）',
    limits: '1200–1800 字，配 3–4 张图片'
  },
  pyq: {
    key: 'pyq', name: '朋友圈', icon: '💬', color: '#f59e0b',
    reader: '门诊私域老客户与周边居民',
    tone: '一句话讲清一件事，像门店自己人在说话',
    format: '短文案 + 配图建议',
    limits: '3–5 行，100 字以内'
  }
};

/* ================= 二十四节气 × 口腔健康 × 长沙生活 ================= */
const SOLAR_TERMS = {
  立春: { time: '2 月上旬', climate: '气温回升、昼夜温差大', oral: '换季牙龈敏感、上火感明显', local: '长沙湿冷转暖，饮食开始偏辛辣' },
  雨水: { time: '2 月中下旬', climate: '降水增多、湿度大', oral: '湿度高更要注意牙刷存放与更换', local: '回南天前兆，家里注意通风' },
  惊蛰: { time: '3 月上旬', climate: '春雷始鸣、万物萌动', oral: '开学季儿童口腔检查的高峰', local: '中小学开学，孩子作息调整' },
  春分: { time: '3 月中下旬', climate: '昼夜均分、气温平稳', oral: '适合安排一年一次的口腔检查', local: '长沙进入赏花期，户外活动增多' },
  清明: { time: '4 月上旬', climate: '气温回暖、雨水偏多', oral: '冷热交替易诱发牙本质敏感', local: '清明前后多雨，出行注意口腔清洁用品携带' },
  谷雨: { time: '4 月中下旬', climate: '雨量充足、湿度高', oral: '儿童涂氟与窝沟封闭的适宜安排期', local: '学期中段，孩子课业时间相对固定' },
  立夏: { time: '5 月上旬', climate: '气温升高、昼长夜短', oral: '冷饮增多，牙齿冷热刺激机会增加', local: '长沙提前入夏，冷饮消费上升' },
  小满: { time: '5 月中下旬', climate: '闷热潮湿', oral: '口腔清洁频率需跟上，牙菌斑更易堆积', local: '梅雨将至，注意牙刷干燥存放' },
  芒种: { time: '6 月上旬', climate: '高温高湿、梅雨季', oral: '牙周炎易在疲劳期加重', local: '长沙梅雨季，作息易紊乱' },
  夏至: { time: '6 月中下旬', climate: '全年白昼最长、炎热', oral: '碳酸饮料与冰饮带来的酸蚀风险', local: '夜宵文化活跃，夜刷更需坚持' },
  小暑: { time: '7 月上旬', climate: '出梅入伏、湿热', oral: '暑期是儿童矫治与涂氟的集中期', local: '暑假开始，家长安排孩子就诊' },
  大暑: { time: '7 月中下旬', climate: '一年最热', oral: '拔牙、种植术后护理要格外注意清洁', local: '高温天要注意术后饮食温度' },
  立秋: { time: '8 月上旬', climate: '暑热未退、早晚转凉', oral: '暑期尾声，矫正复查集中', local: '开学前体检与口腔检查叠加' },
  处暑: { time: '8 月中下旬', climate: '暑气渐止', oral: '假期作息紊乱后的牙龈状态恢复', local: '孩子收心期，可安排一次检查' },
  白露: { time: '9 月上旬', climate: '昼夜温差加大、干燥', oral: '口干会加重口臭与菌斑堆积', local: '长沙转干，注意补水' },
  秋分: { time: '9 月中下旬', climate: '凉爽干燥', oral: '适合安排洁治与牙周维护', local: '秋高气爽，就诊舒适度高' },
  寒露: { time: '10 月上旬', climate: '露气寒冷、明显转凉', oral: '热食增多，需警惕过烫刺激黏膜', local: '长沙降温明显，火锅开始上桌' },
  霜降: { time: '10 月中下旬', climate: '初霜出现、干燥寒冷', oral: '冷热交替明显，牙齿敏感与牙龈出血高发', local: '长沙昼夜温差拉大，热饮与火锅增多' },
  立冬: { time: '11 月上旬', climate: '冬季开始', oral: '温水刷牙减少敏感刺激', local: '进补开始，甜食与坚果摄入增加' },
  小雪: { time: '11 月中下旬', climate: '气温持续下降', oral: '冬季是安排种植与修复的常见时段', local: '天气转冷，就诊时需提前预约' },
  大雪: { time: '12 月上旬', climate: '气温显著下降', oral: '口腔黏膜干燥，需注意义齿清洁', local: '老年患者更需关注义齿与黏膜' },
  冬至: { time: '12 月中下旬', climate: '全年白昼最短', oral: '年终是洁治与年度检查的高峰', local: '年末安排一次口腔检查' },
  小寒: { time: '1 月上旬', climate: '一年最冷时段开始', oral: '冷空气刺激可能诱发牙痛', local: '长沙湿冷，注意保暖与口腔卫生' },
  大寒: { time: '1 月中下旬', climate: '严寒将尽', oral: '寒假是儿童矫治与早矫评估的窗口', local: '寒假临近，家长可提前规划' }
};

/* ================= 合规词库 ================= */
const COMPLIANCE = [
  { re: /保证|包治|一定能|绝对|100%|百分百|永远|永不|彻底根治|根治/, level: 'high', tip: '涉嫌疗效或结果承诺，改为"由医生检查后评估"' },
  { re: /无痛|一点也不疼|完全不疼|不疼|毫无痛苦/, level: 'high', tip: '不得承诺无痛，改为"治疗中会采用局部麻醉，具体感受因人而异"' },
  // 「第一」排除序数用法（第一个问题、第一步…），只拦"排名第一"这类绝对化表述
  { re: /最好|最优|第一(?!个|步|次|条|点|天|周|月|年|批|版|线|作|时|章|节|组|类|梯|时)|顶级|国际领先|最先进|权威|特效|神奇|立竿见影/, level: 'high', tip: '绝对化或夸大用语，改为客观描述' },
  { re: /治愈率|成功率\s*\d+|不复发|终身/, level: 'high', tip: '不得宣传治愈率或终身效果' },
  { re: /博士|主任|教授|专家|毕业于|从业\s*\d+\s*年|留学/, level: 'mid', tip: '医生资质未经门诊核对，不得自行添加' },
  { re: /[¥￥]\s*\d+|\d+\s*元|\d+\s*块/, level: 'mid', tip: '资料中无价格信息，不得出现具体金额' },
  { re: /癌变|得了癌|会癌变|后悔一辈子|再不.{0,6}就晚/, level: 'high', tip: '不得制造焦虑或暗示严重后果，改为"建议尽早检查"' },
  { re: /根治|一次性解决|彻底解决/, level: 'high', tip: '改为"由医生评估后制定方案"' }
];

function complianceCheck(text) {
  const issues = [];
  for (const c of COMPLIANCE) {
    const m = String(text).match(new RegExp(c.re, 'g'));
    if (m) issues.push({ level: c.level, words: [...new Set(m)], tip: c.tip });
  }
  const high = issues.filter(i => i.level === 'high').length;
  return { pass: high === 0, issueCount: issues.length, issues };
}

/* ================= 事实池 ================= */
function gatherFacts(topic, limit = 6) {
  const res = kb.search(topic, limit);
  const facts = res.filter(r => r.score >= 1.6).map(r => ({
    id: r.id, question: r.question, answer: r.answer, topic: r.topicName, score: +r.score.toFixed(2)
  }));
  if (!facts.length) {
    // 退而求其次：主题命中
    const tp = kb.TOPICS.find(t => topic.includes(t.name));
    if (tp) return kb.byTopic(tp.id).slice(0, 4).map(r => ({ id: r.id, question: r.question, answer: r.answer, topic: r.topicName, score: 0 }));
  }
  return facts;
}

const CITY = '长沙';
function clinicLine() {
  const c = kb.clinic;
  return `${c.name}｜${c.address}\n咨询电话/微信：${c.contact}\n门诊时间：周一至周五 ${c.hours.weekday}，周六及周日 ${c.hours.weekend}`;
}

/* ================= 标题与钩子（按变体换角度） ================= */
const ANGLES = [
  { emoji: '🦷', style: '答疑型', hook: () => '门诊被问得最多的 3 个问题' },
  { emoji: '✅', style: '清单型', hook: () => '先搞清楚这 3 件事，少跑冤枉路' },
  { emoji: '💡', style: '纠偏型', hook: () => '很多人第一步就理解错了' },
  { emoji: '📋', style: '流程型', hook: () => '从预约到就诊，一次说清楚' }
];

function pick(arr, i) { return arr[i % arr.length]; }

/* ================= 各平台生成 ================= */
function genXHS(topic, facts, v) {
  const a = pick(ANGLES, v);
  const title = `${a.emoji} ${topic}｜${a.hook(topic)}`;
  const points = facts.slice(0, 3);
  const body = [
    `最近不少${CITY}的朋友在问${topic}的事，整理一下门诊里真实被问到的几个问题。`,
    '',
    ...points.map((f, i) => `${i + 1}️⃣ ${f.question}\n${f.answer}`),
    '',
    `⚠️ 每个人的口腔情况不一样，上面是一般性说明，具体到你是否需要做、怎么做、多久做一次，还是要医生检查之后才能确定。`,
    '',
    `📍${clinicLine()}`,
    '',
    `#${CITY}口腔 #${topic} #口腔健康 #看牙那些事 #家长必看`
  ].join('\n');
  return {
    platform: 'xhs', title, body,
    imagePlan: [
      `封面：${topic}大字标题 + 门诊实拍图（建议使用 ${kb.assets[10] ? kb.assets[10].title : '门诊前台照片'}）`,
      '内页 2：3 个问题的要点卡片，一页一问',
      '内页 3：门诊环境或儿童区照片，增强真实感'
    ],
    hashtags: [`#${CITY}口腔`, `#${topic}`, '#口腔健康', '#看牙那些事']
  };
}

function genDouyin(topic, facts, v) {
  const hooks = [
    `${topic}，先别急，这 3 个问题搞清楚再说`,
    `门诊被问最多的${topic}，30 秒讲明白`,
    `关于${topic}，很多人一开始就理解错了`
  ];
  const hook = pick(hooks, v);
  const p = facts.slice(0, 3);
  const say = (prefix, f) => f ? `${prefix}${f.question} ${f.answer}` : '';
  const shots = [
    { t: '0–3s', scene: '医生/前台近景或门诊环境空镜', line: hook, sub: hook },
    { t: '3–12s', scene: '口播近景，背景为门诊走廊或诊室', line: say('第一个问题：', p[0]), sub: p[0] ? p[0].question : '' },
    { t: '12–24s', scene: '口播 + 牙齿/模型示意画面', line: say('第二个问题：', p[1]), sub: p[1] ? p[1].question : '' },
    { t: '24–36s', scene: '口播 + 门诊环境空镜', line: say('第三个问题：', p[2]), sub: p[2] ? p[2].question : '' },
    { t: '36–45s', scene: '门诊门头或前台画面 + 文字卡', line: '每个人情况不同，具体到你要不要做、怎么做，来检查一下让医生判断。', sub: '门诊信息卡：地址 / 电话 / 门诊时间' }
  ];
  return {
    platform: 'douyin',
    title: `${topic}｜${hook}`,
    duration: '约 45 秒',
    body: shots.map(s => `【${s.t}】\n画面：${s.scene}\n口播：${s.line}\n字幕：${s.sub}`).join('\n\n'),
    shots,
    imagePlan: ['竖屏 9:16，字幕置于画面下方 1/4 处', '口播背景使用门诊真实环境，不使用网络素材'],
    hashtags: [`#${topic}`, '#口腔科普', `#${CITY}牙科`]
  };
}

function genSPH(topic, facts, v) {
  const p = facts.slice(0, 3);
  const cover = `${topic}：先了解，再决定`;
  const shots = [
    { t: '0–5s', scene: '门诊前台/门头', line: `大家好，这里是${kb.clinic.name}。今天聊聊${topic}。`, sub: cover },
    { t: '5–20s', scene: '口播，节奏舒缓', line: p[0] ? `有家长、客户问过：${p[0].question} ${p[0].answer}` : '', sub: p[0] ? p[0].question : '' },
    { t: '20–35s', scene: '口播 + 环境画面', line: p[1] ? `还有人问：${p[1].question} ${p[1].answer}` : '', sub: p[1] ? p[1].question : '' },
    { t: '35–50s', scene: '口播', line: p[2] ? `再补充一点：${p[2].question} ${p[2].answer}` : '', sub: '' },
    { t: '50–60s', scene: '门诊信息卡', line: '具体问题还是要检查后由医生判断，欢迎到门诊当面沟通。', sub: kb.clinic.contact }
  ];
  return {
    platform: 'sph',
    title: cover,
    duration: '约 60 秒',
    body: `封面标题：${cover}\n\n` + shots.map(s => `【${s.t}】${s.scene}\n口播：${s.line}`).join('\n\n'),
    shots,
    shareText: `${topic}的常见问题，${kb.clinic.name}整理了一份说明，需要了解的朋友可以看看。`,
    imagePlan: ['竖屏或横屏均可，字幕偏大，照顾中老年观看', '封面使用门诊真实照片 + 一行大字']
  };
}

function genGZH(topic, facts, v) {
  const p = facts.slice(0, 5);
  const title = `${topic}：门诊整理了 ${p.length} 个常见问题`;
  const body = [
    `> 很多人第一次接触「${topic}」时，问题都差不多。我们把门诊里高频被问到的问题整理出来，供你参考。`,
    '',
    ...p.map((f, i) => `## ${i + 1}. ${f.question}\n\n${f.answer}\n`),
    '## 一点提醒',
    '',
    `以上内容是一般性的口腔健康说明，不能替代面对面的口腔检查。每个人的牙齿情况、身体条件和生活习惯都不一样，是否需要处理、选择什么方式、多久做一次，都需要医生检查之后结合你的实际情况来定。`,
    '',
    '## 门诊信息',
    '',
    clinicLine().split('\n').map(x => `- ${x}`).join('\n'),
    '',
    `_本文由${kb.clinic.name}整理，内容依据门诊标准问答库，仅作健康科普用途。_`
  ].join('\n');
  return {
    platform: 'gzh', title, body,
    imagePlan: [
      '首图：门诊门头或前台照片',
      '正文插图：儿童区 / 诊疗室照片各一张',
      '文末：门诊信息卡片 + 二维码位'
    ]
  };
}

function genPYQ(topic, facts, v) {
  const p = facts[0];
  const lines = [
    `关于${topic}，门诊里最常被问到的是「${p ? p.question : ''}」。`,
    p ? p.answer : '',
    `具体情况每个人不一样，需要检查后由医生判断。`,
    `📍${kb.clinic.name}｜${kb.clinic.contact}`
  ].filter(Boolean);
  return {
    platform: 'pyq', title: `${topic}｜门诊小提示`, body: lines.join('\n'),
    imagePlan: ['配图：门诊实拍 1 张（环境或儿童区），不使用网络素材']
  };
}

const GEN = { xhs: genXHS, douyin: genDouyin, sph: genSPH, gzh: genGZH, pyq: genPYQ };

/* ================= 节气内容 ================= */
function genSolarTerm(term, platforms, v) {
  const t = SOLAR_TERMS[term];
  if (!t) return null;
  const topic = `${term}口腔养护`;
  const facts = [
    { id: 'QA-045', question: '一般多久洗一次牙？', answer: kb.QA.find(q => q.id === 'QA-045').answer, topic: '洗牙与牙周' },
    { id: 'QA-044', question: '洗牙有什么好处？', answer: kb.QA.find(q => q.id === 'QA-044').answer, topic: '洗牙与牙周' },
    { id: 'QA-018', question: '儿童多久涂一次氟？', answer: kb.QA.find(q => q.id === 'QA-018').answer, topic: '儿童涂氟' }
  ];
  const ctx = { term, ...t };
  return { topic, facts, solar: ctx, platforms };
}

/* ================= 门诊素材转内容（场景 A3） ================= */
function genFromMaterial(materialType, materialId, platforms) {
  const c = kb.clinic;
  let title, facts, guard;
  if (materialType === 'doctor') {
    const d = c.doctors.find(x => x.name === materialId) || c.doctors[0];
    title = `${d.name}医生介绍`;
    facts = [{
      id: 'DOCTOR', question: `${d.name}医生的资质与经历`,
      answer: `${d.name}，${d.title}。${d.note}`,
      topic: '医生介绍'
    }];
    guard = '仅使用门诊已核对的姓名与"医师"身份；不添加任何未经核对的职称、毕业院校、执业年限、培训经历或疗效表述。';
  } else {
    const a = kb.assets.find(x => x.file === materialId) || kb.assets[0];
    title = `${a.title}｜门诊环境介绍`;
    facts = [{ id: 'ASSET', question: a.title, answer: a.desc, topic: '门诊环境' }];
    guard = '仅描述图片中真实可见的内容；不虚构设备型号、不暗示设施全天开放、不涉及医生排班承诺。';
  }
  return { topic: title, facts, guard, platforms };
}

/* ================= 统一生成入口 ================= */
function generate(opts) {
  const { topic, platforms = ['xhs', 'gzh'], variant = 0, mode = 'topic', term, materialType, materialId } = opts;
  let ctx;
  if (mode === 'term') ctx = genSolarTerm(term, platforms, variant);
  else if (mode === 'material') ctx = genFromMaterial(materialType, materialId, platforms);
  else ctx = { topic, facts: gatherFacts(topic, 6) };

  if (!ctx) return { error: '未找到对应的节气或素材' };

  const valid = (Array.isArray(platforms) ? platforms : [platforms]).filter(p => PLATFORMS[p]);
  const results = valid.map(p => {
    const fn = GEN[p];
    const r = fn(ctx.topic, ctx.facts, variant);
    const full = `${r.title}\n${r.body}`;
    r.platformName = PLATFORMS[p].name;
    r.icon = PLATFORMS[p].icon;
    r.profile = PLATFORMS[p];
    r.wordCount = String(r.body).replace(/\s/g, '').length;
    r.facts = ctx.facts;
    r.compliance = complianceCheck(full);
    if (ctx.guard) r.guard = ctx.guard;
    if (ctx.solar) r.solar = ctx.solar;
    return r;
  });

  return {
    topic: ctx.topic,
    variant,
    facts: ctx.facts,
    grounded: ctx.facts.length > 0,
    results,
    generatedAt: new Date().toLocaleString('zh-CN', { hour12: false })
  };
}

module.exports = { generate, complianceCheck, PLATFORMS, SOLAR_TERMS, gatherFacts, clinicLine };
