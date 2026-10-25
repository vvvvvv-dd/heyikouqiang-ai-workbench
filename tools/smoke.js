/**
 * 端到端冒烟测试：覆盖评审资料中的 A1/A2/A3 与 B1/B2/B3 六个场景
 * 用法：node tools/smoke.js（服务需已启动）
 * 说明：内部接口需登录，脚本会先以 admin 登录并携带 Cookie；咨询链路保持免登录
 */
const http = require('http');
const PORT = process.env.PORT || 5173;
const DEMO = { username: 'admin', password: 'heyi2026' };

let cookie = '';

function req(path, body, method = 'POST') {
  return new Promise((resolve, reject) => {
    const d = body ? JSON.stringify(body) : '';
    const o = { host: 'localhost', port: PORT, path, method: method || (body ? 'POST' : 'GET'), headers: { 'Content-Type': 'application/json' } };
    if (cookie) o.headers.Cookie = cookie;
    if (body) o.headers['Content-Length'] = Buffer.byteLength(d);
    const r = http.request(o, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => { try { resolve(JSON.parse(b)); } catch (e) { reject(new Error(path + ' → ' + b.slice(0, 200))); } });
    });
    r.on('error', reject);
    r.end(d);
  });
}

/* 抓取 Set-Cookie 的裸请求 */
function raw(path, body) {
  return new Promise((resolve, reject) => {
    const d = JSON.stringify(body);
    const o = { host: 'localhost', port: PORT, path, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(d) } };
    const r = http.request(o, res => {
      let b = ''; res.on('data', c => b += c);
      res.on('end', () => {
        const sc = res.headers['set-cookie'] || [];
        try { resolve({ body: JSON.parse(b), setCookie: sc }); } catch (e) { resolve({ body: b, setCookie: sc }); }
      });
    });
    r.on('error', reject);
    r.end(d);
  });
}

let pass = 0, fail = 0;
function check(name, cond, detail = '') {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name} ${detail}`); }
}

(async () => {
  console.log('\n══════ 登录与访问控制 ══════');
  const badLogin = await raw('/api/login', { username: 'admin', password: 'xxxxxx' });
  check('错误密码被拒绝', badLogin.body.ok === false && !badLogin.setCookie.length);
  const login = await raw('/api/login', DEMO);
  check('正确账号可登录', login.body.ok === true);
  check('下发 HttpOnly 会话票据', /hy_token=[\da-f]{20,}/.test(String(login.setCookie)) && /HttpOnly/.test(String(login.setCookie)));
  cookie = String(login.setCookie).match(/hy_token=[\da-f]+/)[0];

  /* 未登录时的边界（用不带 Cookie 的原始请求验证）*/
  const anon = await new Promise(res => {
    const r = http.request({ host: 'localhost', port: PORT, path: '/api/leads', method: 'GET' }, s => {
      let b = ''; s.on('data', c => b += c); s.on('end', () => res({ code: s.statusCode, body: b }));
    }); r.end();
  });
  check('未登录调用内部接口返回 401', anon.code === 401, String(anon.code));
  const openApi = await new Promise(res => {
    const r = http.request({ host: 'localhost', port: PORT, path: '/api/clinic', method: 'GET' }, s => {
      let b = ''; s.on('data', c => b += c); s.on('end', () => res({ code: s.statusCode, body: b }));
    }); r.end();
  });
  check('门诊公开资料免登录可读', openApi.code === 200);

  /* 清空演示数据，避免历史会话与线索污染本次结果 */
  const reset = await req('/api/demo/reset', {}, 'POST');
  check('演示数据已重置', reset.ok === true && (await req('/api/leads', null, 'GET')).leads.length === 0);

  console.log('\n══════ 方向 B：AI 售前咨询与客户服务助手 ══════');

  // ---- B1 新客户咨询 ----
  console.log('\n【B1】新客户咨询：6 岁孩子涂氟 + 环境 + 预约');
  let r = await req('/api/chat', { sessionId: 'b1', message: '我家孩子6岁，想带他去涂氟。你们那里环境怎么样？需要提前预约吗？' });
  check('回答了门诊环境问题（引用门诊资料）', /休息区|儿童活动|牙椅/.test(r.text), r.text.slice(0, 80));
  check('回答了预约规则', /提前两小时|预约制/.test(r.text));
  check('随后引导登记预约信息', /称呼|预约登记/.test(r.text));
  check('已抽取年龄 6 岁', r.slots.age === '6岁');
  check('已抽取意向项目', /涂氟/.test(r.slots.service || ''));

  r = await req('/api/chat', { sessionId: 'b1', message: '周六上午可以吗？' });
  check('周末分流：说明周末接诊时间并建议工作日', /08:45–17:45/.test(r.text) && /工作日/.test(r.text));

  r = await req('/api/chat', { sessionId: 'b1', message: '我叫李婷，13900001111' });
  check('收集姓名与电话后进入信息确认', r.stage === 'confirm' && /李婷/.test(r.text) && /13900001111/.test(r.text));

  r = await req('/api/chat', { sessionId: 'b1', message: '确认' });
  check('确认后完成预约意向登记', r.bookingDone === true);
  check('生成了线索 ID', !!r.leadId);
  const leadB1 = r.leadId;

  // ---- B2 专业问题转人工 ----
  console.log('\n【B2】专业问题转人工：嚼槟榔后张不开嘴 + 白色东西 + 问费用');
  r = await req('/api/chat', { sessionId: 'b2', message: '我的嘴最近张不开，口腔里面还有白色的东西，是不是很严重？要花多少钱治疗？' });
  check('识别为需专业评估（不诊断）', r.risk === 'diagnosis' && r.handoff === true);
  check('明确拒绝线上诊断', /不能在线上给出诊断|需要医生当面检查/.test(r.text));
  check('未给出任何费用数字', !/\d+\s*元|[¥￥]\s*\d+/.test(r.text));
  check('提示转门诊工作人员跟进', /门诊工作人员/.test(r.text));
  check('生成线索并进入工作台', !!r.leadId);
  const leadB2 = r.leadId;

  // ---- B3 预约与需求留存（周末紧张，客户坚持） ----
  console.log('\n【B3】周六洗牙预约，门诊周末资源紧张');
  r = await req('/api/chat', { sessionId: 'b3', message: '我想周六预约洗牙' });
  check('识别预约意图并引导留信息', r.booking === true);
  check('给出工作日分流建议', /08:45–17:45/.test(r.text) && /工作日/.test(r.text) && /更宽裕/.test(r.text));
  r = await req('/api/chat', { sessionId: 'b3', message: '我叫王磊，13700002222，想周六' });
  check('收集齐全后进入信息确认', r.stage === 'confirm');
  r = await req('/api/chat', { sessionId: 'b3', message: '我还是希望周六' });
  check('尊重客户意愿，不再强行分流', /尊重|按您希望的时间/.test(r.text));
  r = await req('/api/chat', { sessionId: 'b3', message: '确认' });
  check('客户坚持周六仍能完成登记', r.bookingDone === true);

  // ---- 授权与工作台 ----
  console.log('\n【工作台】授权与状态流转');
  await req('/api/consent', { sessionId: 'b2', granted: true });
  let { leads } = await req('/api/leads', null, 'GET');
  check('线索已全部进入工作台', leads.length >= 3, `实际 ${leads.length} 条`);
  const l2 = leads.find(l => l.sessionId === 'b2');
  check('B2 线索含转接原因', /诊断|专业检查|评估/.test(l2.reason));
  check('B2 线索含授权信息', l2.consent && l2.consent.granted === true);
  check('B2 线索含完整对话记录', l2.transcript.length >= 2);
  check('B2 线索含咨询摘要', !!l2.summary);

  await req('/api/lead', { id: l2.id, status: 'contacted', note: '已电话联系，安排周二上午检查' });
  ({ leads } = await req('/api/leads', null, 'GET'));
  const l2b = leads.find(l => l.id === l2.id);
  check('状态可更新为已联系', l2b.status === 'contacted');
  check('跟进备注已记录', l2b.notes.length === 1);

  console.log('\n══════ 方向 A：AI 多渠道内容生产工具 ══════');

  // ---- A1 同主题多平台 ----
  console.log('\n【A1】同一主题「儿童涂氟」→ 小红书 + 抖音 + 视频号 + 公众号');
  r = await req('/api/content/generate', { topic: '儿童涂氟', platforms: ['xhs', 'douyin', 'sph', 'gzh'], variant: 0, useLLM: false });
  check('四个平台全部生成', r.results.length === 4);
  check('内容有门诊知识依据', r.grounded === true && r.facts.length > 0);
  const xhs = r.results.find(x => x.platform === 'xhs');
  const dy = r.results.find(x => x.platform === 'douyin');
  const gzh = r.results.find(x => x.platform === 'gzh');
  check('小红书为图文笔记形式（含话题标签）', /#/.test(xhs.body) && /📍/.test(xhs.body));
  check('抖音为分镜脚本形式（含时间轴与口播）', /【0–3s】/.test(dy.body) && /口播/.test(dy.body));
  check('公众号为长文结构（含分节与门诊信息）', /## /.test(gzh.body) && gzh.wordCount > 300);
  check('各平台标题明显不同', new Set(r.results.map(x => x.title)).size === 4);
  check('各平台正文明显不同', new Set(r.results.map(x => x.body.slice(0, 50))).size === 4);
  check('全部通过合规体检', r.results.every(x => x.compliance.pass));

  // ---- A2 节气科普 ----
  console.log('\n【A2】节气科普：霜降 × 长沙生活习惯');
  r = await req('/api/content/generate', { mode: 'term', term: '霜降', platforms: ['xhs', 'gzh'], variant: 0, useLLM: false });
  check('生成霜降主题内容', /霜降/.test(r.topic));
  check('带节气背景（气候/口腔关注点/长沙）', !!r.results[0].solar);
  check('节气内容有知识依据', r.facts.length > 0);

  // ---- A3 门诊真实素材 ----
  console.log('\n【A3】门诊真实素材：医生资料 + 环境照片');
  r = await req('/api/content/generate', { mode: 'material', materialType: 'doctor', materialId: '陈子龙', platforms: ['gzh'], variant: 0, useLLM: false });
  check('医生介绍仅使用已核对信息', /陈子龙/.test(r.results[0].body) && /门诊核对/.test(r.results[0].body));
  check('医生介绍带防虚构约束说明', !!r.results[0].guard);
  check('医生介绍通过合规体检', r.results[0].compliance.pass);

  r = await req('/api/content/generate', { mode: 'material', materialType: 'environment', materialId: 'clinic-09.jpg', platforms: ['pyq'], variant: 0, useLLM: false });
  check('环境素材文案仅描述真实可见内容', /儿童/.test(r.results[0].body));
  check('环境素材带防虚构约束说明', /不虚构设备型号/.test(r.results[0].guard || ''));

  // ---- 合规拦截能力 ----
  console.log('\n【合规】违规内容拦截能力');
  const bad = await req('/api/content/check', { text: '我们保证无痛根治，成功率100%，只要1999元，错过后悔一辈子！' });
  check('识别疗效承诺与绝对化用语', bad.issues.some(i => /无痛|根治|100%/.test(i.words.join())));
  check('识别价格信息', bad.issues.some(i => /元/.test(i.words.join())));
  check('识别制造焦虑', bad.issues.some(i => /后悔/.test(i.words.join())));
  check('整体判定为不通过', bad.pass === false);

  const good = await req('/api/content/check', { text: '是否需要处理，需要医生检查后结合您的情况判断。' });
  check('正常内容不误报', good.pass === true);

  // ---- 内容可保存 ----
  console.log('\n【产出】内容可保存与审核');
  const saved = await req('/api/contents', { topic: '儿童涂氟', platform: 'xhs', platformName: '小红书', icon: '📕', title: xhs.title, body: xhs.body, compliance: xhs.compliance, facts: xhs.facts, status: 'draft' });
  check('内容可保存到内容库', saved.ok === true);
  await req('/api/contents/update', { id: saved.item.id, status: 'approved' });
  const { items } = await req('/api/contents', null, 'GET');
  check('内容审核状态可更新', items[0].status === 'approved');

  // ---- 每日口腔科普 ----
  console.log('\n【日常】每日口腔科普');
  const daily = await req('/api/daily', null, 'GET');
  check('科普池非空且已剔除报价条目', daily.pool > 0 && daily.pool < daily.totalQA);
  check('科普分为 7 个组', daily.groups.length === 7);
  check('分组条数之和等于科普池', daily.groups.reduce((a, g) => a + g.count, 0) === daily.pool);
  check('今日科普有答案正文', daily.today.item.answer.length > 5);
  check('今日科普带来源编号', /^QA-\d{3}$/.test(daily.today.item.id));
  check('今日科普有分组与风险分级', !!daily.today.item.groupName && !!daily.today.item.careLabel);
  check('今日科普有延伸问题', daily.today.item.related.length > 0);
  check('往期回顾有 6 天', daily.recent.length === 6);
  check('明日预告与今日不同', daily.tomorrow.id !== daily.today.item.id);

  const tomorrowReal = await req('/api/daily?date=' + daily.tomorrow.key, null, 'GET');
  check('明日日期查询结果与预告一致', tomorrowReal.today.item.id === daily.tomorrow.id);

  const sameDay = await req('/api/daily?date=' + daily.today.key, null, 'GET');
  check('同一天反复查询结果稳定', sameDay.today.item.id === daily.today.item.id);

  const otherDay = await req('/api/daily?date=2026-03-09', null, 'GET');
  check('换一天内容随之更换', otherDay.today.item.id !== daily.today.item.id);

  check('科普内容不含报价类问答', daily.groups.every(g => g.items.every(it => !/检查后报价|多少钱一颗|没有提供具体价目表/.test(it.answer))));

  console.log(`\n══════ 结果：通过 ${pass} 项，失败 ${fail} 项 ══════\n`);
  process.exit(fail ? 1 : 0);
})();
