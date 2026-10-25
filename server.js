/**
 * 颌一口腔 AI 工作台 · 服务端
 * 零外部依赖（仅 Node 内置模块），`node server.js` 即可启动
 * 模块：/api/kb 知识库 | /api/chat 咨询 | /api/leads 线索 | /api/content 内容生产 | /api/settings 模型配置
 */
const crypto = require('crypto');
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const kb = require('./lib/kb');
const brain = require('./lib/brain');
const content = require('./lib/content');
const llm = require('./lib/llm');
const store = require('./lib/store');
const daily = require('./lib/daily');

const ROOT = path.resolve(__dirname);
const PUBLIC = path.join(ROOT, 'public');
const PORT = process.env.PORT || 5173;

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2'
};

/* ---------------- 工具 ---------------- */
function send(res, code, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(code, {
    'Content-Type': typeof data === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => {
      b += c;
      if (b.length > 2_000_000) { reject(new Error('请求体过大')); req.destroy(); }
    });
    req.on('end', () => {
      if (!b) return resolve({});
      try { resolve(JSON.parse(b)); } catch (e) { reject(new Error('JSON 解析失败')); }
    });
    req.on('error', reject);
  });
}
function uid(prefix = 'id') {
  return prefix + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/* ---------------- 登录鉴权 ---------------- */
/* 演示环境账号：真实部署时应接入门诊既有账号体系，密码不得明文落库。
   演示密码可用环境变量 CLINIC_PASSWORD 覆盖；部署到公网环境务必设置该项。 */
const DEMO_PASSWORD = process.env.CLINIC_PASSWORD || 'heyi2026';
const ACCOUNTS = [
  { username: 'admin', password: DEMO_PASSWORD, name: '门诊负责人', role: 'admin', title: '门诊负责人 · 全部功能' },
  { username: 'ops', password: DEMO_PASSWORD, name: '运营 小林', role: 'ops', title: '运营 · 内容生产与门诊信息' },
  { username: 'front', password: DEMO_PASSWORD, name: '前台 小周', role: 'front', title: '前台 · 客户咨询与预约线索' }
];
/* 角色可见页面：admin 全部，ops 不进线索区，front 只做客户承接 */
const ROLE_PAGES = {
  admin: ['/', '/content', '/workbench', '/map', '/settings'],
  ops: ['/', '/content', '/map', '/settings'],
  front: ['/', '/workbench', '/map']
};
const OPEN_PAGES = new Set(['/login', '/consult']);
const PAGE_MAP = {
  '/': '/index.html', '/consult': '/consult.html', '/content': '/content.html',
  '/workbench': '/workbench.html', '/settings': '/settings.html', '/map': '/map.html', '/login': '/login.html'
};

const hashPw = pw => crypto.createHash('sha256').update('heyi::' + pw).digest('hex');

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function userOf(req) {
  const token = parseCookies(req).hy_token;
  if (!token) return null;
  const auth = store.read('auth', { tokens: {} });
  const s = auth.tokens[token];
  if (!s) return null;
  if (s.exp && s.exp < Date.now()) return null;
  return { token, username: s.username, name: s.name, role: s.role };
}
function canVisit(user, pathname) {
  if (!user) return false;
  const allow = ROLE_PAGES[user.role] || ROLE_PAGES.front;
  if (allow.includes(pathname)) return true;
  // 详情页等未在清单里的路径，按所属模块的首段判断
  const head = '/' + String(pathname).split('/')[1];
  return allow.includes(head);
}
function signIn(res, acc) {
  const token = crypto.randomBytes(24).toString('hex');
  const auth = store.read('auth', { tokens: {} });
  const now = Date.now();
  // 顺手清理过期票据
  for (const [k, v] of Object.entries(auth.tokens)) if (v.exp && v.exp < now) delete auth.tokens[k];
  auth.tokens[token] = { username: acc.username, name: acc.name, role: acc.role, at: now, exp: now + 7 * 86400 * 1000 };
  store.write('auth', auth);
  res.setHeader('Set-Cookie', `hy_token=${token}; Path=/; Max-Age=${7 * 86400}; HttpOnly; SameSite=Lax`);
  return { name: acc.name, role: acc.role, title: acc.title, username: acc.username };
}
function signOut(req, res) {
  const token = parseCookies(req).hy_token;
  if (token) {
    const auth = store.read('auth', { tokens: {} });
    delete auth.tokens[token];
    store.write('auth', auth);
  }
  res.setHeader('Set-Cookie', 'hy_token=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax');
}
/* 需登录才能访问的接口（咨询链路与公共资料对外放行） */
const GUARDED_API = /^\/api\/(lead|leads|content|contents|settings|demo)/;

/* ---------------- 会话与线索 ---------------- */
function getSession(id) {
  const all = store.read('sessions', {});
  if (!all[id]) {
    all[id] = { id, slots: {}, turns: [], stage: 'idle', createdAt: brain.now(), updatedAt: brain.now(), consent: null, source: '直接访问' };
  }
  return all[id];
}
function saveSession(s) {
  store.update('sessions', {}, all => { all[s.id] = s; return all; });
}
function getLeads() { return store.read('leads', []); }
function saveLeads(l) { store.write('leads', l); }

function upsertLead(session) {
  const leads = getLeads();
  const s = session.slots || {};
  const meta = brain.summarize(session);
  let lead = leads.find(x => x.sessionId === session.id);
  const base = {
    sessionId: session.id,
    source: session.source || '直接访问',
    customer: { name: s.name || '', phone: s.phone || '', age: s.age || '' },
    service: s.service || '',
    timePref: s.timePref || [],
    summary: meta.summary,
    askedCount: meta.askedCount,
    riskLevels: meta.riskLevels,
    topics: meta.topics,
    urgency: session.pendingHandoff?.level === 'emergency' ? 'high' : 'normal',
    reason: session.pendingHandoff?.reason || (session.stage === 'done' ? '客户完成预约意向登记' : '咨询中'),
    transcript: session.turns.slice(-20),
    consent: session.consent
  };
  if (lead) Object.assign(lead, base, { updatedAt: brain.now() });
  else {
    lead = { id: uid('lead'), createdAt: brain.now(), updatedAt: brain.now(), status: 'pending', notes: [], ...base };
    leads.unshift(lead);
  }
  saveLeads(leads);
  return lead;
}

/* ---------------- 大模型增强（可降级） ---------------- */
const SYS_CONSULT = `你是「${kb.clinic.name}」的智能咨询助手，面对的是门诊的潜在客户。
硬性约束（违反任何一条都是重大错误）：
1. 只能使用【门诊事实】和【知识库条目】中的信息回答问题，不得补充资料外的任何事实。
2. 不做诊断、不给治疗方案、不给具体价格、不承诺医生排班与号源。
3. 涉及症状判断、治疗费用、用药、术后急症、医生排班的问题，直接说明需要医生/工作人员处理，并引导留下联系方式。
4. 不虚构医生履历、成功案例、疗效数据、停车收费标准。
5. 语气温暖克制，不制造焦虑，不夸大效果，不用感叹号堆砌。
6. 回复控制在 200 字以内，分 2-4 个短段落，可直接作为聊天消息发送。

门诊事实：
${JSON.stringify(kb.clinic, null, 1)}`;

async function polishConsult(reply, session, userMsg) {
  if (!llm.available()) return reply;
  const retrieved = brain.answerFromKB(userMsg);
  const ctx = retrieved
    ? `知识库命中条目（仅供引用，不要超出其范围）：\n${retrieved.sources.map(s => `- ${s.question}`).join('\n')}\n标准答复：${retrieved.answer}`
    : '知识库未命中；若问题超出资料范围，请明确说明并引导联系门诊。';
  const r = await llm.chat([
    { role: 'system', content: SYS_CONSULT },
    { role: 'system', content: ctx },
    ...session.turns.slice(-6).map(t => ({ role: t.role === 'user' ? 'user' : 'assistant', content: t.text }))
  ], { temperature: 0.5 });
  if (!r.ok) return { ...reply, llmNote: '大模型调用失败，已使用本地引擎：' + r.error };
  const chk = content.complianceCheck(r.content);
  if (!chk.pass) return { ...reply, llmNote: '大模型输出未通过合规体检，已回退本地引擎：' + chk.issues.map(i => i.tip).join('；') };
  return { ...reply, text: r.content.trim(), llm: true };
}

const SYS_CONTENT = `你是口腔门诊的内容运营专家，服务「${kb.clinic.name}」。
硬性约束：
1. 只能基于【知识库事实】创作，不得补充资料外的事实、数据、案例或医生履历。
2. 禁止疗效承诺、绝对化用语、无痛/根治/最好/100% 等表述，禁止制造焦虑。
3. 不得出现任何具体价格、折扣、优惠信息。
4. 必须体现平台差异：不同平台的标题风格、结构、节奏完全不同，不能是同一段话改字数。
5. 涉及"是否需要做、多久做一次、是否适合你"的地方，统一落到"由医生检查后判断"。`;

async function llmGenerate(opts) {
  if (!llm.available()) return null;
  const facts = content.gatherFacts(opts.topic, 6);
  const want = (opts.platforms || []).map(p => content.PLATFORMS[p]).filter(Boolean);
  const prompt = `主题：${opts.topic}
变体序号：${opts.variant}（同一主题的不同切入角度：0 答疑型 / 1 清单型 / 2 纠偏型 / 3 流程型，请按序号切换角度）

知识库事实（唯一可引用来源）：
${facts.map(f => `- [${f.id}] ${f.question}\n  ${f.answer}`).join('\n')}

需要生成以下平台的内容：
${want.map(p => `【${p.name}】读者：${p.reader}；语气：${p.tone}；形式：${p.format}；要求：${p.limits}`).join('\n')}

请严格按以下 JSON 输出，不要输出任何解释或 markdown 代码块标记：
{
  "results": [
    {
      "platform": "平台 key（${want.map(p => p.key).join('|')}）",
      "title": "标题",
      "body": "正文或脚本全文",
      "imagePlan": ["配图建议1", "配图建议2"]
    }
  ]
}`;
  const r = await llm.chat([
    { role: 'system', content: SYS_CONTENT },
    { role: 'user', content: prompt }
  ], { temperature: 0.9 });
  if (!r.ok) return { error: r.error };
  try {
    const cleaned = r.content.replace(/```json/g, '').replace(/```/g, '').trim();
    const data = JSON.parse(cleaned);
    return { data, facts };
  } catch (e) {
    return { error: 'JSON 解析失败：' + e.message };
  }
}

/* ---------------- 路由 ---------------- */
const routes = {
  /* 登录鉴权 */
  'GET /api/me': async (body, q, req) => {
    const u = userOf(req);
    if (!u) return { user: null };
    return { user: { name: u.name, role: u.role, username: u.username, pages: ROLE_PAGES[u.role] || [] } };
  },
  'POST /api/login': async (body, q, req, res) => {
    const username = String((body || {}).username || '').trim();
    const password = String((body || {}).password || '');
    const acc = ACCOUNTS.find(a => a.username === username && hashPw(password) === hashPw(a.password));
    if (!acc) return { ok: false, error: '账号或密码不正确' };
    return { ok: true, user: signIn(res, acc) };
  },
  'POST /api/logout': async (body, q, req, res) => {
    signOut(req, res);
    return { ok: true };
  },

  /* 知识库与门诊信息 */
  'GET /api/clinic': async () => ({ clinic: kb.clinic, assets: kb.assets }),
  'GET /api/assets': async () => ({ assets: kb.assets }),
  'GET /api/topics': async () => ({ topics: kb.TOPICS, total: kb.QA.length }),
  'GET /api/qa': async (body, q) => {
    const kw = q.get('q') || '';
    if (!kw) return { items: kb.QA.slice(0, 20), total: kb.QA.length };
    return { items: kb.search(kw, 8), total: kb.QA.length };
  },
  'GET /api/solar-terms': async () => ({ terms: content.SOLAR_TERMS }),
  /* 每日口腔科普：按日期确定性轮换，同一天所有访客看到同一条；?date=YYYY-MM-DD 可预览任意一天 */
  'GET /api/daily': async (body, q) => daily.overview(q && q.get('date')),
  'GET /api/engine': async () => ({
    llm: { available: llm.available(), ...llm.getSettings(), apiKey: llm.getSettings().apiKey ? '******' : '' },
    kb: { qa: kb.QA.length, assets: kb.assets.length, doctors: kb.clinic.doctors.length }
  }),

  /* 方向 B：咨询 */
  'POST /api/chat': async (body) => {
    const { sessionId, message, elderly, source, useLLM = true } = body || {};
    if (!message) return { error: '缺少 message' };
    const sid = sessionId || uid('s');
    const session = getSession(sid);
    session.elderly = !!elderly;
    if (source) session.source = source;
    let reply = brain.chat(session, message);
    if (useLLM && reply.text && !reply.handoff) reply = await polishConsult(reply, session, message);
    saveSession(session);
    if (reply.handoff || reply.bookingDone) {
      const lead = upsertLead(session);
      reply.leadId = lead.id;
    }
    return { sessionId: sid, ...reply, slots: session.slots, stage: session.stage };
  },
  'GET /api/session': async (body, q) => {
    const id = q.get('id');
    return id ? getSession(id) : { error: '缺少 id' };
  },
  'POST /api/consent': async (body) => {
    const { sessionId, granted } = body || {};
    const s = getSession(sessionId);
    s.consent = {
      granted: !!granted,
      at: brain.now(),
      text: '门诊将使用您的称呼、联系电话与需求信息，仅用于本次预约沟通与后续服务，不作其他用途，您可随时要求删除。'
    };
    saveSession(s);
    if (granted) upsertLead(s);
    return { ok: true, consent: s.consent };
  },

  /* 门诊工作台 */
  'GET /api/leads': async () => ({ leads: getLeads() }),
  'POST /api/lead': async (body) => {
    const { id, status, note } = body || {};
    const leads = getLeads();
    const lead = leads.find(l => l.id === id);
    if (!lead) return { error: '未找到线索' };
    if (status) lead.status = status;
    if (note) lead.notes.push({ text: note, at: brain.now() });
    lead.updatedAt = brain.now();
    saveLeads(leads);
    return { ok: true, lead };
  },
  'DELETE /api/lead': async (body, q) => {
    const id = (body && body.id) || q.get('id');
    saveLeads(getLeads().filter(l => l.id !== id));
    return { ok: true };
  },

  /* 方向 A：内容生产 */
  'POST /api/content/generate': async (body) => {
    const opts = body || {};
    if (!opts.topic && opts.mode !== 'term' && opts.mode !== 'material') return { error: '缺少主题' };
    const local = content.generate(opts);
    if (opts.useLLM !== false) {
      const r = await llmGenerate({ ...opts, topic: local.topic || opts.topic });
      if (r && r.data && Array.isArray(r.data.results)) {
        for (const item of r.data.results) {
          const target = local.results.find(x => x.platform === item.platform);
          const chk = content.complianceCheck(`${item.title}\n${item.body}`);
          if (!target) continue;
          if (!chk.pass) {
            target.llmNote = '大模型版本未通过合规体检，已保留本地版本：' + chk.issues.map(i => i.tip).join('；');
            continue;
          }
          target.title = item.title || target.title;
          target.body = item.body || target.body;
          if (item.imagePlan?.length) target.imagePlan = item.imagePlan;
          target.wordCount = String(target.body).replace(/\s/g, '').length;
          target.compliance = chk;
          target.llm = true;
        }
        local.llmUsed = true;
      } else if (r && r.error) {
        local.llmNote = '大模型调用失败，已使用本地引擎：' + r.error;
      }
    }
    return local;
  },
  'POST /api/content/check': async (body) => content.complianceCheck((body || {}).text || ''),
  'GET /api/contents': async () => ({ items: store.read('contents', []) }),
  'POST /api/contents': async (body) => {
    const items = store.read('contents', []);
    const item = { id: uid('c'), createdAt: brain.now(), status: 'draft', ...body };
    items.unshift(item);
    store.write('contents', items);
    return { ok: true, item };
  },
  'POST /api/contents/update': async (body) => {
    const { id, ...patch } = body || {};
    const items = store.read('contents', []);
    const it = items.find(x => x.id === id);
    if (!it) return { error: '未找到' };
    Object.assign(it, patch, { updatedAt: brain.now() });
    store.write('contents', items);
    return { ok: true, item: it };
  },
  'DELETE /api/contents': async (body, q) => {
    const id = (body && body.id) || q.get('id');
    store.write('contents', store.read('contents', []).filter(x => x.id !== id));
    return { ok: true };
  },

  /* 模型配置 */
  'GET /api/settings': async () => {
    const s = llm.getSettings();
    return { llm: { ...s, apiKey: s.apiKey ? '******' : '' } };
  },
  'POST /api/settings': async (body) => {
    const patch = body || {};
    if (patch.apiKey === '******') delete patch.apiKey;
    const saved = llm.saveSettings(patch);
    return { ok: true, llm: { ...saved, apiKey: saved.apiKey ? '******' : '' } };
  },
  'POST /api/settings/test': async () => llm.test(),

  /* 演示辅助 */
  'POST /api/demo/reset': async () => {
    store.write('sessions', {});
    store.write('leads', []);
    store.write('contents', []);
    return { ok: true };
  }
};

/* ---------------- 静态资源 ---------------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === '/' || rel === '') rel = '/index.html';
  const map = { '/': '/index.html', '/consult': '/consult.html', '/content': '/content.html', '/workbench': '/workbench.html', '/settings': '/settings.html', '/map': '/map.html', '/login': '/login.html' };
  if (map[rel]) rel = map[rel];
  if (!rel.startsWith('/assets/') && !path.extname(rel)) rel += '.html';

  const base = rel.startsWith('/assets/') ? ROOT : PUBLIC;
  const file = path.join(base, rel.replace(/^\/assets\//, 'assets/'));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    return send(res, 404, 'Not Found: ' + rel);
  }
  const ext = path.extname(file).toLowerCase();
  res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
}

/* ---------------- 启动 ---------------- */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const pathname = u.pathname;
  const key = `${req.method} ${pathname}`;
  const user = userOf(req);

  if (routes[key]) {
    if (GUARDED_API.test(pathname) && !user) return send(res, 401, { error: '登录状态已失效，请重新登录', needLogin: true });
    try {
      const body = ['POST', 'PATCH', 'PUT', 'DELETE'].includes(req.method) ? await readBody(req) : {};
      const out = await routes[key](body, u.searchParams, req, res);
      return send(res, 200, out);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }
  if (pathname.startsWith('/api/')) return send(res, 404, { error: '未知接口 ' + key });

  /* 页面访问：登录页与客户咨询入口对外放行，其余需登录 */
  const clean = pathname === '/' ? '/' : pathname.replace(/\/$/, '');
  const isPage = !path.extname(pathname) || PAGE_MAP[clean];
  if (isPage && !OPEN_PAGES.has(clean)) {
    if (!user) {
      res.writeHead(302, { Location: '/login?to=' + encodeURIComponent(clean), 'Cache-Control': 'no-store' });
      return res.end();
    }
    if (clean !== '/' && !canVisit(user, clean)) {
      const home = (ROLE_PAGES[user.role] || ROLE_PAGES.front)[0] || '/';
      res.writeHead(302, { Location: home + '?deny=' + encodeURIComponent(clean), 'Cache-Control': 'no-store' });
      return res.end();
    }
  }
  return serveStatic(req, res, pathname);
});

server.listen(PORT, () => {
  console.log('');
  console.log('  🦷 颌一口腔 AI 工作台已启动');
  console.log(`  → 登录入口   http://localhost:${PORT}/login   （admin / heyi2026）`);
  console.log(`  → 门诊首页   http://localhost:${PORT}/`);
  console.log(`  → 内容生产   http://localhost:${PORT}/content`);
  console.log(`  → 咨询助手   http://localhost:${PORT}/consult   （客户扫码入口，免登录）`);
  console.log(`  → 门诊工作台 http://localhost:${PORT}/workbench`);
  console.log(`  → 到店导览   http://localhost:${PORT}/map`);
  console.log(`  → 模型配置   http://localhost:${PORT}/settings`);
  console.log(`  → 知识库 ${kb.QA.length} 条 Q&A / ${kb.assets.length} 张门诊图片 / 引擎：本地${llm.available() ? ' + 大模型' : ''}`);
  console.log('');
});
