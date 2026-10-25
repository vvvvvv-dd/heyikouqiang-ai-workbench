/**
 * 门诊知识库：91 条 Q&A 的加载、主题归类、中文检索（BM25）
 * 供方向 A（内容生产）与方向 B（咨询助手）共用，保证两边口径一致。
 */
const fs = require('fs');
const path = require('path');

const DATA = path.resolve(__dirname, '..', 'data');
const clinic = JSON.parse(fs.readFileSync(path.join(DATA, 'clinic.json'), 'utf8'));
const assets = JSON.parse(fs.readFileSync(path.join(DATA, 'assets.json'), 'utf8'));
const rawQA = JSON.parse(fs.readFileSync(path.join(DATA, 'qa.json'), 'utf8'));

/* ---------- 主题归类（按题库编号区间） ---------- */
const TOPICS = [
  { id: 'location', name: '位置与交通', from: 1, to: 4 },
  { id: 'booking', name: '预约规则', from: 5, to: 9 },
  { id: 'doctor', name: '医生与案例', from: 10, to: 15 },
  { id: 'fluoride', name: '儿童涂氟', from: 16, to: 20 },
  { id: 'sealant', name: '窝沟封闭', from: 21, to: 25 },
  { id: 'childfear', name: '儿童看牙配合', from: 26, to: 29 },
  { id: 'babyteeth', name: '乳牙龋坏', from: 30, to: 34 },
  { id: 'earlyortho', name: '儿童早期矫治', from: 35, to: 41 },
  { id: 'cleaning', name: '洗牙与牙周', from: 42, to: 47 },
  { id: 'filling', name: '补牙', from: 48, to: 51 },
  { id: 'extraction', name: '拔牙', from: 52, to: 62 },
  { id: 'ortho', name: '牙齿矫正', from: 63, to: 69 },
  { id: 'implant', name: '种植牙', from: 70, to: 83 },
  { id: 'betel', name: '槟榔与口腔黏膜', from: 84, to: 91 }
];

/* ---------- 需要转人工 / 必须提示面诊的条目（遵守资料包第一节 AI 使用规则） ---------- */
const FLAGS = {
  3: ['parking'], 9: ['schedule'], 10: ['resume'], 11: ['resume'],
  56: ['diagnosis'], 61: ['emergency'], 63: ['price'], 64: ['price'], 69: ['price'],
  70: ['price'], 71: ['price'], 75: ['diagnosis'], 76: ['diagnosis'], 77: ['diagnosis'],
  78: ['medication'], 83: ['emergency']
};

const rawQA2 = rawQA.map(item => {
  const n = parseInt(item.id.replace('QA-', ''), 10);
  const topic = TOPICS.find(t => n >= t.from && n <= t.to);
  return {
    ...item,
    no: n,
    topic: topic ? topic.id : 'other',
    topicName: topic ? topic.name : '其他',
    flags: FLAGS[n] || []
  };
});

/* 门诊基础信息条目（由资料包第二节整理，供 AI 直接引用，避免"有资料答不上来"） */
const TOPIC_NAME = {
  environment: '门诊环境', location: '位置与交通', booking: '预约规则',
  service: '服务项目', doctor: '医生与案例', childfear: '儿童看牙配合'
};
const extra = JSON.parse(fs.readFileSync(path.join(DATA, 'facts.json'), 'utf8')).map((f, i) => ({
  ...f, no: 900 + i, topicName: TOPIC_NAME[f.topic] || '门诊信息', flags: [], fromClinicInfo: true
}));

const QA = [...rawQA2, ...extra];

/* ---------- 中文分词：字符 bigram + 单字，英文数字按词 ---------- */
const STOP = new Set(['的', '了', '是', '在', '我', '有', '和', '就', '不', '人', '都', '一', '一个', '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己', '这', '吗', '呢', '吧', '啊', '请问', '想', '可以', '需要', '怎么', '什么', '多少', '为什么', '你们', '我们', '之', '与', '或', '及', '等', '为', '对', '从', '把', '被', '让', '给', '做', '吗']);

function tokenize(text) {
  const s = String(text || '').toLowerCase();
  const tokens = [];
  // 英文 / 数字
  const words = s.match(/[a-z0-9]+/g);
  if (words) tokens.push(...words);
  // 中文：unigram + bigram
  const han = s.match(/[\u4e00-\u9fa5]+/g) || [];
  for (const seg of han) {
    for (let i = 0; i < seg.length; i++) {
      const c = seg[i];
      if (!STOP.has(c)) tokens.push(c);
      if (i + 1 < seg.length) {
        const bg = seg.slice(i, i + 2);
        if (!STOP.has(bg)) tokens.push(bg);
      }
    }
  }
  return tokens;
}

/* ---------- 同义词扩展（长沙本地 + 口腔口语） ---------- */
const SYNONYMS = {
  洗牙: ['洁牙', '超声波', '清洁牙齿', '洗牙齿', '洁治'],
  涂氟: ['涂氟化物', '氟保护漆', '防蛀', '防龋'],
  窝沟封闭: ['封沟', '窝沟', '封闭'],
  矫正: ['正畸', '戴牙套', '箍牙', '整牙', '排齐'],
  种植牙: ['种牙', '植牙', '镶牙', '种植'],
  拔牙: ['拔掉', '拔除', '拔牙齿'],
  补牙: ['补龋', '充填', '补洞', '树脂'],
  价格: ['多少钱', '费用', '收费', '贵不贵', '报价', '大概多少'],
  预约: ['挂号', '约时间', '约一下', '排期', '订'],
  槟榔: ['蒌叶', '咀嚼槟榔'],
  停车: ['车位', '停车场', '开车', '自驾'],
  地址: ['在哪里', '位置', '怎么走', '导航', '定位'],
  张不开嘴: ['张口受限', '张不开', '嘴巴张不大'],
  刷牙: ['清洁', '刷']
};

/* 口语改写：把客户的日常说法替换成资料包里的书面关键词，缩小"有资料却答不上来"的比例 */
const PHRASE_MAP = [
  [/坐地铁|乘地铁|地铁怎么|地铁几号线|怎么坐车|坐公交|公交线路/g, '地铁 交通 地址 怎么走'],
  [/几点下班|几点关门|几点开门|营业时间|上班时间|什么时间营业|开门吗|下班吗/g, '门诊时间 周一至周五 周六及周日'],
  [/环境怎么样|环境设施|里面什么样|什么样子|环境好吗|环境如何/g, '门诊环境 休息区 儿童区 诊疗室'],
  [/有夜诊|晚上看牙|晚上能看|夜里能看/g, '夜诊'],
  [/需要多少钱|要多少钱|花多少|贵吗|便宜点/g, '价格'],
  [/有号吗|能约上|约得到|排得上/g, '号源 排班'],
  [/车停哪|好停车|能停车吗|停车方便吗/g, '停车 停车场']
];

function normalize(query) {
  let q = String(query || '');
  for (const [re, to] of PHRASE_MAP) q = q.replace(re, to);
  return q;
}

function expand(query) {
  const out = [query];
  for (const [k, vs] of Object.entries(SYNONYMS)) {
    if (query.includes(k)) out.push(...vs);
    for (const v of vs) if (query.includes(v)) { out.push(k); break; }
  }
  return out.join(' ');
}

/* ---------- BM25 索引 ---------- */
const K1 = 1.5, B = 0.75;
const docs = QA.map(q => ({
  q,
  qTokens: tokenize(q.question),
  aTokens: tokenize(q.answer)
}));
const totalLen = docs.reduce((s, d) => s + d.qTokens.length + d.aTokens.length, 0);
const avgdl = totalLen / docs.length;

const df = new Map();
for (const d of docs) {
  const set = new Set([...d.qTokens, ...d.aTokens]);
  for (const t of set) df.set(t, (df.get(t) || 0) + 1);
}
const N = docs.length;
function idf(t) {
  const n = df.get(t) || 0;
  return Math.log(1 + (N - n + 0.5) / (n + 0.5));
}

/**
 * 检索：返回 [{...qa, score}]
 */
function search(query, topK = 3) {
  const q = normalize(query);
  const qTokens = tokenize(expand(q));
  if (!qTokens.length) return [];
  // 相关性闸门：用「口语改写后、未做同义词扩展」的查询计算覆盖率。
  // 同义词扩展只用于打分，不用于覆盖率，否则扩展词会稀释覆盖率，把"洗牙多久一次"这类正常问法误判为未命中。
  // 只保留在知识库中出现过的 bigram：未出现过的词无法指向任何文档，计入分母反而会稀释真实命中
  const bi = [...new Set(tokenize(q).filter(t =>
    t.length === 2 && /[\u4e00-\u9fa5]{2}/.test(t) && (df.get(t) || 0) > 0))];
  const scored = [];
  for (const d of docs) {
    let score = 0;
    const tf = new Map();
    for (const t of d.qTokens) tf.set(t, (tf.get(t) || 0) + 3);   // 问题权重更高
    for (const t of d.aTokens) tf.set(t, (tf.get(t) || 0) + 1);
    const len = d.qTokens.length + d.aTokens.length;
    for (const qt of new Set(qTokens)) {
      const f = tf.get(qt);
      if (!f) continue;
      score += idf(qt) * (f * (K1 + 1)) / (f + K1 * (1 - B + B * len / avgdl));
    }
    // 问题字面直接包含查询串，强加权
    if (d.q.question.includes(query.slice(0, 6)) && query.length >= 3) score += 4;
    if (score <= 0) continue;
    // IDF 加权覆盖率：命中"地铁"这类稀有词比命中"你们"这类高频词更能说明相关
    const docSet = new Set([...d.qTokens, ...d.aTokens]);
    const wAll = bi.reduce((s, t) => s + idf(t), 0) || 1;
    const cover = bi.reduce((s, t) => s + (docSet.has(t) ? idf(t) : 0), 0) / wAll;
    if (cover < 0.3) continue;
    scored.push({ ...d.q, score, cover: +cover.toFixed(2) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

function byTopic(topic) {
  return QA.filter(q => q.topic === topic);
}

module.exports = { clinic, assets, QA, TOPICS, search, byTopic, tokenize, expand };
