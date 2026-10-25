/**
 * 每日口腔科普库
 *
 * 从门诊标准问答中筛出「科普型」条目，按读者视角重新分组，
 * 并按当前日期做确定性轮换 —— 同一天所有访客看到同一条，隔天自动更换。
 *
 * 选取算法用「绝对天数」而不是「年内第几天」，因此跨年也连续、不会每年日历重合。
 * 步长 STEP 与科普池长度互质，保证相邻日期落在池内相距较远的位置，连续几天不会撞同一主题。
 */

const kb = require('./kb');

/* ---------- 科普分组：按读者关心的角度组织，而不是按资料包的内部编号 ---------- */
const GROUPS = [
  {
    id: 'child', name: '儿童口腔', icon: '🧸',
    desc: '涂氟、窝沟封闭、乳牙龋坏、早期矫治与孩子看牙配合',
    topics: ['fluoride', 'sealant', 'childfear', 'babyteeth', 'earlyortho']
  },
  {
    id: 'perio', name: '洗牙与牙周', icon: '🌿',
    desc: '洁治常见误解、洗牙频率与牙周维护',
    topics: ['cleaning']
  },
  {
    id: 'filling', name: '补牙', icon: '🛠️',
    desc: '补牙后的使用、护理与复查',
    topics: ['filling']
  },
  {
    id: 'extraction', name: '拔牙', icon: '🦷',
    desc: '麻醉、术后饮食护理，以及什么情况要联系门诊',
    topics: ['extraction']
  },
  {
    id: 'ortho', name: '牙齿矫正', icon: '😁',
    desc: '矫正时机、周期、检查流程与常见顾虑',
    topics: ['ortho']
  },
  {
    id: 'implant', name: '种植牙', icon: '🔩',
    desc: '术前评估、使用年限影响因素与术后维护',
    topics: ['implant']
  },
  {
    id: 'betel', name: '槟榔与口腔黏膜', icon: '🚭',
    desc: '湖南地区高发的咀嚼槟榔相关口腔问题',
    topics: ['betel']
  }
];

/* 门诊运营类（位置、预约、医生简历、环境、服务项目）不是健康科普，不进科普池 */
const CLINIC_TOPICS = ['location', 'booking', 'doctor', 'other'];
/* 纯价格条目没有科普价值，且其结论一律是「需面诊报价」 */
const EXCLUDE_FLAGS = ['price'];

const TOPIC_TO_GROUP = {};
GROUPS.forEach(g => g.topics.forEach(t => { TOPIC_TO_GROUP[t] = g; }));

/* ---------- 风险提示分级：让科普自带边界，不替医生下结论 ---------- */
const CARE = {
  general: { label: '通用口腔常识', tone: 'brand' },
  evaluate: { label: '需医生检查评估', tone: 'warn' },
  urgent: { label: '不适请及时联系门诊', tone: 'danger' }
};

const EVALUATE_RE = /(医生评估|检查后|由医生|医生检查|不能保证|因人而异|并非一定|不一定|视.{0,4}情况|不明显的情况)/;

function careOf(q) {
  if (q.flags.includes('emergency')) return 'urgent';
  if (q.flags.includes('diagnosis') || q.flags.includes('medication')) return 'evaluate';
  if (EVALUATE_RE.test(q.answer)) return 'evaluate';
  return 'general';
}

/** 取答案的首个完整句作为一句话摘要 */
function summaryOf(answer) {
  const first = String(answer).split(/(?<=[。！？；])/)[0] || answer;
  return first.length > 46 ? first.slice(0, 46) + '…' : first;
}

function buildPool() {
  return kb.QA
    .filter(q => !CLINIC_TOPICS.includes(q.topic))
    .filter(q => !EXCLUDE_FLAGS.some(f => q.flags.includes(f)))
    .filter(q => TOPIC_TO_GROUP[q.topic])
    .map(q => {
      const g = TOPIC_TO_GROUP[q.topic];
      return {
        id: q.id,
        no: q.no,
        question: q.question,
        answer: q.answer,
        summary: summaryOf(q.answer),
        group: g.id,
        groupName: g.name,
        icon: g.icon,
        topicName: q.topicName,
        care: careOf(q),
        careLabel: CARE[careOf(q)].label,
        tone: CARE[careOf(q)].tone
      };
    });
}

const RAW_POOL = buildPool();

/**
 * 按组轮转交错重排。
 * 资料包里条目是按主题连续编号的，若直接用它做取模，相邻日期会长期停在同一块区域
 * （试过：连续 10 天只有儿童/拔牙/槟榔，种植与矫正一次没出现）。
 * 交错之后每个组的条目均匀铺开，固定步长跳一次就能自然跨到另一个组。
 */
function interleave(pool) {
  const buckets = {};
  pool.forEach(x => { (buckets[x.group] = buckets[x.group] || []).push(x); });
  const queues = GROUPS.map(g => (buckets[g.id] || []).slice()).filter(q => q.length);
  const out = [];
  for (let more = true; more;) {
    more = false;
    for (const q of queues) {
      if (q.length) { out.push(q.shift()); more = true; }
    }
  }
  return out;
}

const POOL = interleave(RAW_POOL);

function epochDay(d) {
  return Math.floor(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / 86400000);
}

function keyOf(d) {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function parseDate(s) {
  if (!s) return new Date();
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  const d = new Date(s);
  return isNaN(d.getTime()) ? new Date() : d;
}

function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

/**
 * 生成一份长度为「科普池大小」的排期表，之后按绝对天数循环取用。
 *
 * 为什么不用「取模 + 顺延」：那样试下来 365 天会漏掉 11 条，而且 11 天内出现过同一条重复。
 * 这里改用加权轮转（每组权重 = 该组条目数）决定每天轮到哪个组，组内依次发牌。
 * 效果：
 *   · 每 72 天，科普池里每一条恰好出现一次，不重不漏
 *   · 权重最大的「儿童口腔」占 37.5%（低于半数），所以相邻两天不会同组
 *   · 首尾不同组，跨周期边界也不会撞车
 *   · 只依赖绝对天数，同一天所有访客看到同一条，且完全确定性、无需存储状态
 */
function buildSchedule() {
  const active = GROUPS.map(g => POOL.filter(x => x.group === g.id)).filter(a => a.length);
  const w = active.map(a => a.length);
  const total = w.reduce((a, b) => a + b, 0);
  const cur = new Array(active.length).fill(0);
  const queues = active.map(a => a.slice());
  const seq = [];

  for (let t = 0; t < total; t++) {
    let best = 0;
    for (let i = 0; i < active.length; i++) {
      cur[i] += w[i];
      if (cur[i] > cur[best]) best = i;
    }
    cur[best] -= total;
    seq.push(queues[best].shift());
  }

  // 循环边界：若排期最后一条与第一条同组，找一个合适位置与末尾对调
  const last = seq.length - 1;
  if (last > 1 && seq[0].group === seq[last].group) {
    for (let j = last - 1; j >= 1; j--) {
      if (seq[j].group === seq[0].group) continue;
      const prevOk = j === 0 || seq[j - 1].group !== seq[last].group;
      const nextOk = j + 1 === last || seq[j + 1].group !== seq[last].group;
      if (prevOk && nextOk) { [seq[j], seq[last]] = [seq[last], seq[j]]; break; }
    }
  }
  return seq;
}

const SCHEDULE = buildSchedule();

function pick(d) {
  const len = SCHEDULE.length;
  return SCHEDULE[((epochDay(d) % len) + len) % len];
}

/** 同主题优先、不足时用同组补齐的延伸阅读 */
function relatedOf(item, n = 3) {
  const sameTopic = POOL.filter(x => x.topicName === item.topicName && x.id !== item.id);
  const sameGroup = POOL.filter(x => x.group === item.group && x.topicName !== item.topicName);
  return [...sameTopic, ...sameGroup].slice(0, n).map(x => ({
    id: x.id, question: x.question, groupName: x.groupName, icon: x.icon
  }));
}

/**
 * 取某一天的科普卡片
 * @param {string|Date} date 目标日期，默认今天
 */
function weekdayOf(d) {
  return '周' + '日一二三四五六'[d.getUTCDay()];
}

/**
 * 取某一天的科普卡片
 * @param {string|Date} date 目标日期，默认今天
 */
function daily(date) {
  const d = parseDate(date);
  const item = pick(d);
  return {
    key: keyOf(d),
    display: `${d.getUTCFullYear()} 年 ${d.getUTCMonth() + 1} 月 ${d.getUTCDate()} 日 · ${weekdayOf(d)}`,
    weekday: weekdayOf(d),
    item: { ...item, related: relatedOf(item) }
  };
}

/**
 * 首页每日科普所需的全部数据
 * @param {string} date 可选，便于演示任意日期
 */
function overview(date) {
  const today = parseDate(date);
  const cur = daily(today);
  cur.display = `${today.getUTCFullYear()} 年 ${today.getUTCMonth() + 1} 月 ${today.getUTCDate()} 日 · ${weekdayOf(today)}`;

  const next = daily(addDays(today, 1));
  const recent = [1, 2, 3, 4, 5, 6].map(n => {
    const x = daily(addDays(today, -n));
    return {
      key: x.key,
      label: `${+x.key.slice(5, 7)}/${+x.key.slice(8, 10)}`,
      id: x.item.id, question: x.item.question, icon: x.item.icon, groupName: x.item.groupName
    };
  });

  const groups = GROUPS.map(g => ({
    id: g.id, name: g.name, icon: g.icon, desc: g.desc,
    count: POOL.filter(x => x.group === g.id).length,
    items: POOL.filter(x => x.group === g.id)
  }));

  return {
    today: cur,
    tomorrow: { key: next.key, id: next.item.id, question: next.item.question, icon: next.item.icon, groupName: next.item.groupName },
    recent,
    groups,
    pool: POOL.length,
    totalQA: kb.QA.length,
    care: CARE
  };
}

module.exports = { overview, daily, POOL, SCHEDULE, GROUPS, CARE };
