/**
 * 咨询大脑（方向 B 的本地引擎）
 * 职责：风险分级 → 意图识别 → 槽位抽取 → 多轮引导 → 知识库作答 → 转人工摘要
 * 设计原则：不诊断、不报价、不承诺排班、不杜撰信息；不确定就转人工。
 */
const kb = require('./kb');

/* ================= 风险词典 ================= */
const RISK = {
  // 急症 / 需立即就医
  emergency: ['呼吸困难', '喘不上气', '大量出血', '止不住血', '高烧', '发烧不退', '外伤', '撞掉', '磕掉', '牙齿掉了', '剧烈疼痛', '疼得受不了', '脸肿得', '张不开嘴还', '昏迷'],
  // 症状自述 → 需专业评估，AI 不诊断
  symptom: ['张不开', '张不大', '白色的东西', '白斑', '溃疡', '糜烂', '肿块', '麻木', '出血', '疼', '痛', '松动', '臭', '脓', '肿', '敏感', '酸软', '裂', '发黑', '变黑', '卡住', '合不上', '弹响', '磨牙', '口臭'],
  // 求诊断
  diagnose: ['是不是', '怎么回事', '什么原因', '严重吗', '会不会癌', '是不是癌', '要不要紧', '什么病', '怎么治疗', '能治好吗', '要拔吗', '要补吗', '需要根管吗', '要不要做', '怎么办'],
  // 报价
  price: ['多少钱', '费用', '收费', '价格', '贵不贵', '报价', '大概多少', '几块钱', '预算', '报销', '医保'],
  // 排班 / 号源
  schedule: ['排班', '号源', '有号', '没号', '有空', '医生在吗', '谁坐诊', '一定能', '保证有', '排到', '约得上', '当天', '最晚几点', '几点关门'],
  // 用药
  medication: ['吃什么药', '消炎药', '止痛药', '甲硝唑', '阿莫西林', '能不能吃', '停药', '地舒单抗', '用药'],
  // 医生个人资质细节
  resume: ['简历', '毕业', '执业', '资质', '证书', '工作几年', '从业多少年', '擅长什么', '哪个学校']
};

const SERVICE_MAP = [
  { key: '洗牙', words: ['洗牙', '洁牙', '超声波', '清洁牙齿'] },
  { key: '儿童涂氟', words: ['涂氟', '防蛀', '防龋'] },
  { key: '窝沟封闭', words: ['窝沟封闭', '窝沟', '封沟'] },
  { key: '补牙', words: ['补牙', '补洞', '充填', '龋齿', '蛀牙'] },
  { key: '拔牙', words: ['拔牙', '拔掉', '拔除'] },
  { key: '牙齿矫正', words: ['矫正', '正畸', '牙套', '箍牙', '整牙', '隐形'] },
  { key: '种植牙', words: ['种牙', '种植牙', '植牙', '镶牙'] },
  { key: '牙周治疗', words: ['牙周', '牙龈出血', '牙周炎'] },
  { key: '儿童齿科', words: ['孩子', '儿童', '小朋友', '宝宝', '小孩', '乳牙'] },
  { key: '口腔检查', words: ['检查', '看看', '体检', '拍片'] }
];

const TIME_WORDS = ['周六', '星期六', '周日', '星期天', '周末', '周一', '星期一', '周二', '星期二', '周三', '星期三', '周四', '星期四', '周五', '星期五', '工作日', '今天', '明天', '后天', '上午', '下午', '中午', '晚上', '早上'];

/* ================= 工具 ================= */
function hits(text, list) {
  return list.filter(w => text.includes(w));
}
function now() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ================= 槽位抽取 ================= */
function extractSlots(text, prev = {}) {
  const s = { ...prev };
  const phoneM = text.match(/1[3-9]\d{9}/);
  if (phoneM) s.phone = phoneM[0];

  const ageM = text.match(/(\d{1,3})\s*(岁|周岁)/) || text.match(/(\d{1,2})\s*个月/);
  if (ageM) s.age = ageM[0];

  const nameM = text.match(/(?:我叫|我是|姓名[是为:]?|姓)\s*([\u4e00-\u9fa5]{2,4})(?![孩先医])/);
  if (nameM && !s.name) s.name = nameM[1];

  if (!s.service) {
    for (const item of SERVICE_MAP) {
      if (item.words.some(w => text.includes(w))) { s.service = item.key; break; }
    }
  }
  const tw = hits(text, TIME_WORDS);
  if (tw.length) s.timePref = [...new Set([...(s.timePref || []), ...tw])];

  if (/(小孩|孩子|儿童|宝宝|儿子|女儿)/.test(text) && !s.service) s.service = '儿童齿科';
  return s;
}

/* ================= 风险分级 ================= */
function riskOf(text) {
  const t = text;
  if (hits(t, RISK.emergency).length) {
    return { level: 'emergency', reason: '客户描述疑似急症表现', tags: hits(t, RISK.emergency) };
  }
  const med = hits(t, RISK.medication);
  if (med.length) return { level: 'medication', reason: '问题涉及用药，需医生判断', tags: med };
  const price = hits(t, RISK.price);
  const diag = hits(t, RISK.diagnose);
  const sym = hits(t, RISK.symptom);
  if ((diag.length && (sym.length || price.length)) || (sym.length && price.length)) {
    return { level: 'diagnosis', reason: '客户描述了症状并寻求诊断或费用判断，需专业检查评估', tags: [...diag, ...sym, ...price] };
  }
  // 停车收费属于门诊信息，不是治疗报价，交给知识库正常作答
  const isParking = /(停车|车位|停车场|自驾)/.test(t) && !/(矫正|种植|补牙|拔牙|洗牙|治疗|方案|报价)/.test(t);
  if (price.length && !isParking) return { level: 'price', reason: '涉及具体费用，需医生检查后报价', tags: price };
  if (hits(t, RISK.schedule).length) return { level: 'schedule', reason: '涉及医生排班与号源，需门诊确认', tags: hits(t, RISK.schedule) };
  if (hits(t, RISK.resume).length) return { level: 'resume', reason: '涉及医生具体履历资质，需门诊核对后答复', tags: hits(t, RISK.resume) };
  return { level: 'normal', reason: '', tags: [] };
}

/* ================= 意图识别 ================= */
function intentOf(text, session) {
  const t = text;
  if (/^(你好|您好|hi|hello|在吗|在么|有人吗)/i.test(t.trim())) return 'greeting';
  if (/(谢谢|感谢|明白了|好的|收到)/.test(t) && t.length < 12) return 'thanks';
  if (/(转人工|人工|客服|真人|找医生|咨询医生)/.test(t)) return 'handoff';
  if (session.stage === 'confirm' && t.length <= 12 && /(确认|对的|正确|没.?问题|是的|可以|同意|就这|好|行)/.test(t)) return 'confirm';
  if (/(预约|约一下|约个|挂号|订个|安排一下|帮我登记|登记一下)/.test(t)) return 'booking';
  if (session.stage === 'collecting' || session.stage === 'confirm') return 'booking';
  // 客户主动留下联系方式 / 明确给出时间偏好：即使没说"预约"两个字，也要接住。
  // 否则"周六上午，我叫张小雨，13800009999"会被当成普通提问，线索信息丢失、工作台看不到。
  const hasContact = /1[3-9]\d{9}/.test(t) || /(电话|手机号|联系方式|联系我|打我手机)/.test(t);
  const hasTime = hits(t, TIME_WORDS).length > 0;
  const hasName = /(我叫|我是|姓名[是为:]?|姓)/.test(t);
  if (hasContact && (hasTime || hasName)) return 'booking';
  if (hasName && hasTime && /(想|要|希望|麻烦|请)/.test(t)) return 'booking';
  return 'faq';
}

/* ================= 转人工话术 ================= */
function handoffReply(risk, session) {
  const c = kb.clinic;
  const map = {
    emergency: `您描述的情况需要尽快由口腔专业人员当面检查，我不适合在线上判断。建议尽快联系门诊 ${c.contact}，如果症状明显加重或持续不缓解，请及时前往就近医院急诊。`,
    diagnosis: `您提到的情况需要医生当面检查后才能判断，我这边不能在线上给出诊断，也不能凭描述给出治疗费用——这两件事都需要检查后由医生评估、制定方案再说明。`,
    price: `具体费用与牙齿情况、矫治/修复方式和方案有关，需要医生检查后制定方案才能报价。资料里没有提供统一价目表，我不想给您一个不准的数字。`,
    medication: `用药相关问题需要医生结合您的身体情况判断，请务必告知医生您的全部用药史，不要自行停药或加药。`,
    schedule: `医生的排班和号源需要门诊工作人员实时确认，我这边不能承诺具体时段。`,
    resume: `医生的履历与资质细节以门诊核对后的书面介绍为准，可以联系工作人员查看。`
  };
  const body = map[risk.level] || map.diagnosis;
  const urgent = risk.level === 'emergency';
  return {
    text: `${body}\n\n我已经把您的情况整理成一条待办交给门诊工作人员，他们会尽快与您联系${urgent ? '（已标记为加急）' : ''}。`,
    handoff: true,
    urgency: urgent ? 'high' : 'normal',
    reason: risk.reason
  };
}

/* ================= 知识库作答 ================= */
function answerFromKB(text) {
  const res = kb.search(text, 3);
  if (!res.length || res[0].score < 2.2) return null;
  const top = res[0];
  let a = top.answer;
  // 带 flag 的条目补一句边界提示
  if (top.flags.includes('price')) a += ' 具体费用需要医生检查后报价。';
  if (top.flags.includes('diagnosis')) a += ' 是否适用需要医生结合检查判断。';
  if (top.flags.includes('medication')) a += ' 请务必提前告知医生您的用药史，不要自行停药。';
  if (top.flags.includes('emergency')) a += ' 若症状持续或加重，请及时联系门诊复诊。';
  if (top.flags.includes('schedule')) a += ' 具体时段由门诊工作人员确认。';
  return {
    answer: a,
    sources: res.map(r => ({ id: r.id, question: r.question, score: +r.score.toFixed(2), topic: r.topicName })),
    qa: top
  };
}

/* ================= 复合意图：一句话里既有提问又有预约 ================= */
const Q_MARK = /[?？]|吗|怎么|什么|多久|多少|哪里|在哪|能不能|可以吗|要不要|是不是|几岁|哪种|收费|环境|流程/;
function splitClauses(text) {
  return text.split(/[。！？!?；;\n]/).map(s => s.trim()).filter(s => s.length >= 4);
}
const CONFIRM_ONLY = /^(确认|好的|可以|是的|对的|正确|没问题|嗯|行|就这|同意|好)[。！!,.，]?$/;
function answerMulti(text) {
  // 纯确认性回复不触发知识库检索（避免"确认"误命中含该词的条目）
  if (!text || text.length <= 8 && CONFIRM_ONLY.test(text.trim())) return null;
  const segs = splitClauses(text);
  const asked = segs.filter(s => Q_MARK.test(s));
  const targets = asked.length ? asked : [text];
  const outs = [], src = [], seen = new Set();
  for (const s of targets.slice(0, 3)) {
    const r = answerFromKB(s);
    if (r && !seen.has(r.qa.id)) { seen.add(r.qa.id); outs.push(r.answer); src.push(...r.sources); }
  }
  if (!outs.length) return null;
  return { text: outs.join('\n\n'), sources: src.slice(0, 4) };
}

/* ================= 预约流程 ================= */
const REQUIRED = [
  { key: 'name', ask: '方便留一下就诊人的称呼吗？' },
  { key: 'phone', ask: '留一个可以联系到您的手机号，门诊确认时间后会联系您。' },
  { key: 'service', ask: '这次主要想做什么项目呢？比如洗牙、补牙、涂氟、矫正、种植都可以。' },
  { key: 'timePref', ask: '您比较方便的时间是？工作日还是周末？上午还是下午？' }
];

function bookingReply(session) {
  const s = session.slots;
  const tp = (s.timePref || []).join('、');
  const isWeekend = /周[六日]|周末|星期六|星期天/.test(tp);
  const missing = REQUIRED.filter(r => !s[r.key] || (Array.isArray(s[r.key]) && !s[r.key].length));

  let prefix = '';

  // ① 周末分流建议：客户一给出周末偏好就说明，不阻塞信息收集
  if (isWeekend && !session.weekendNotified) {
    session.weekendNotified = true;
    prefix = `明白了，您希望 ${tp} 到店。补充一个信息：门诊周末接诊时间是 08:45–17:45，工作日是 09:00–18:00，周末号源相对紧张一些。如果时间能调整，工作日的时段通常会更宽裕；当然，如果您只有周末方便，我们完全尊重您的安排，会按您希望的时间去协调。`;
    if (missing.length) {
      session.stage = 'collecting';
      return { text: `${prefix}\n\n${missing[0].ask}`, booking: true, divert: 'weekend', missing: missing.map(x => x.key) };
    }
    session.stage = 'confirm';
    return { text: prefix, booking: true, divert: 'weekend' };
  }

  // ② 客户在分流后仍坚持周末：明确尊重，不再重复建议
  if (isWeekend && session.insistWeekend && !session.weekendRespected) {
    session.weekendRespected = true;
    prefix = '好的，我们完全尊重您的安排，就按您希望的时间去协调，会把这个偏好同步给门诊工作人员。\n\n';
  }

  // ③ 信息未齐：继续收集
  if (missing.length) {
    session.stage = 'collecting';
    return {
      text: `${prefix}好的，我帮您登记预约意向。${missing[0].ask}`,
      booking: true, missing: missing.map(x => x.key)
    };
  }

  // ④ 信息齐全：确认卡片
  session.stage = 'confirm';
  return {
    text: `${prefix}我这边整理了一下：\n\n· 就诊人：${s.name}${s.age ? `（${s.age}）` : ''}\n· 联系电话：${s.phone}\n· 意向项目：${s.service}\n· 期望时间：${tp}\n\n请确认以上信息是否正确？确认后我会把预约意向提交给门诊工作人员，由他们与您确认最终到店时间。`,
    booking: true,
    needConfirm: true
  };
}

/* ================= 主入口 ================= */
function chat(session, message) {
  const text = String(message || '').trim();
  session.turns = session.turns || [];
  session.slots = session.slots || {};
  session.turns.push({ role: 'user', text, at: now() });

  const intent = intentOf(text, session);
  session.slots = extractSlots(text, session.slots);
  const risk = riskOf(text);
  // 客户在已收到分流提示后仍坚持（只认明确的坚持表述，避免把"想周六"的陈述误判为坚持）
  if (session.weekendNotified && /(还是|坚持|就要|就想|只能|只有|偏要|执意)/.test(text)) session.insistWeekend = true;

  let out = { text: '', sources: [], handoff: false, intent, risk: risk.level, slots: session.slots };

  // 1) 高风险：直接转人工
  if (risk.level !== 'normal') {
    const h = handoffReply(risk, session);
    Object.assign(out, h);
    session.pendingHandoff = { reason: risk.reason, level: risk.level, tags: risk.tags, at: now() };
    session.stage = 'handoff';
  }
  // 2) 打招呼
  else if (intent === 'greeting') {
    const c = kb.clinic;
    out.text = `您好，我是${c.name}的智能助手，可以帮您解答门诊信息、预约流程和常见口腔健康问题。\n\n比如：门诊在哪里、怎么预约、洗牙多久一次、孩子几岁可以涂氟。\n\n如果是牙齿不适、治疗方案或费用这类需要专业判断的问题，我会帮您转给门诊工作人员或医生。请问有什么可以帮您？`;
  }
  // 3) 明确要求转人工
  else if (intent === 'handoff') {
    out.handoff = true;
    out.urgency = 'normal';
    out.reason = '客户主动要求人工服务';
    out.text = `好的，我帮您转接门诊工作人员。您可以直接拨打/添加门诊微信 ${kb.clinic.contact}，我会同步把刚才的沟通记录整理给他们，方便他们直接接手。`;
    session.pendingHandoff = { reason: out.reason, level: 'normal', tags: [], at: now() };
    session.stage = 'handoff';
  }
  // 4) 确认预约信息
  else if (intent === 'confirm' && session.stage === 'confirm') {
    out.bookingDone = true;
    out.text = `已经提交给门诊工作人员了。他们会按您留的号码联系您，确认最终到店时间。

提前两小时预约制是门诊的常规安排，建议您在到店前再确认一下时间。祝您就诊顺利！`;
    session.stage = 'done';
  }
  // 5) 预约流程：若同一句话里还问了别的事，先回答再引导登记
  else if (intent === 'booking') {
    const b = bookingReply(session);
    Object.assign(out, b);
    const m = answerMulti(text);
    if (m) {
      out.text = `${m.text}\n\n${b.text}`;
      out.sources = m.sources;
    }
  }
  // 6) 知识库问答（支持一句话多个问题）
  else {
    const multi = answerMulti(text);
    if (multi) {
      out.sources = multi.sources;
      // 位置、预约、环境、医生这类门诊信息不加"需医生检查"的提示，避免答非所问
      const allInfo = multi.sources.every(s => /位置与交通|预约规则|门诊环境|服务项目|医生与案例/.test(s.topic || ''));
      out.text = multi.text + (allInfo ? '' : `\n\n（具体到您或孩子的情况，还是要医生检查后才能确定。）`);
    } else {
    const r = answerFromKB(text);
    if (r) {
      out.text = r.answer;
      out.sources = r.sources;
      // 医疗相关条目统一补一句面诊提示
      if (!/预约|地址|电话|停车|地铁|门诊时间/.test(r.qa.question) && !r.qa.flags.includes('resume')) {
        out.text += `\n\n（每个人的口腔情况不同，具体到您是否适用、需要怎么处理，还是要医生检查后才能确定。）`;
      }
    } else {
      out.handoff = true;
      out.urgency = 'normal';
      out.reason = '问题超出知识库范围';
      out.text = `这个问题在我的资料里没有查到可靠依据，我不想给您一个不确定的答复。我已经记录下来转给门诊工作人员，他们会给您准确回复。您也可以直接联系门诊 ${kb.clinic.contact}。`;
      session.pendingHandoff = { reason: out.reason, level: 'normal', tags: [], at: now() };
      session.stage = 'handoff';
    }
    }
  }

  // 老年人模式：句子更短
  if (session.elderly) out.text = shorten(out.text);

  session.turns.push({ role: 'assistant', text: out.text, at: now(), risk: risk.level, sources: out.sources });
  if (session.turns.length > 60) session.turns = session.turns.slice(-60);
  session.updatedAt = now();
  return out;
}

function shorten(text) {
  const parts = String(text).split(/\n+/);
  return parts.slice(0, 3).join('\n').replace(/（[^）]*）/g, '');
}

/* ================= 生成咨询摘要（给门诊工作台） ================= */
function summarize(session) {
  const s = session.slots || {};
  const asked = session.turns.filter(t => t.role === 'user').map(t => t.text);
  const risks = [...new Set(session.turns.filter(t => t.risk && t.risk !== 'normal').map(t => t.risk))];
  const topics = [...new Set((session.turns.flatMap(t => (t.sources || []).map(x => x.topic)) || []))].filter(Boolean);
  const line = [];
  line.push(`客户诉求：${asked[asked.length - 1] || asked[0] || '（未明）'}`);
  if (s.service) line.push(`意向项目：${s.service}`);
  if (s.age) line.push(`就诊人年龄：${s.age}`);
  if ((s.timePref || []).length) line.push(`期望时间：${s.timePref.join('、')}`);
  if (topics.length) line.push(`涉及知识点：${topics.join('、')}`);
  if (session.pendingHandoff) line.push(`转接原因：${session.pendingHandoff.reason}`);
  return {
    summary: line.join('\n'),
    askedCount: asked.length,
    riskLevels: risks,
    topics
  };
}

module.exports = { chat, summarize, extractSlots, riskOf, answerFromKB, now };
