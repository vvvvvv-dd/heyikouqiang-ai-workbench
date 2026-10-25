/* 公共工具：接口请求、提示、导航渲染 */
const HOME = '/login';
const ROLE_LABEL = { admin: '全部权限', ops: '内容·运营', front: '客户承接' };

async function api(path, body) {
  const opt = body
    ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
    : { method: 'GET' };
  const res = await fetch(path, opt);
  if (res.status === 401) {
    location.replace(HOME + '?to=' + encodeURIComponent(location.pathname));
    throw new Error('未登录');
  }
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

const apiGet = p => api(p);
const apiPost = (p, b) => api(p, b);

function toast(msg, ms = 2200) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  requestAnimationFrame(() => el.classList.add('show'));
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制到剪贴板');
  } catch (e) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); toast('已复制到剪贴板'); } catch (_) { toast('复制失败，请手动选择'); }
    ta.remove();
  }
}

function download(filename, text, type = 'text/plain;charset=utf-8') {
  const blob = new Blob(['\ufeff' + text], { type });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

/* 登录态：未登录跳登录页；返回当前用户或 null */
async function currentUser() {
  try {
    const d = await fetch('/api/me').then(r => r.json());
    return d.user || null;
  } catch (e) { return null; }
}

async function logout() {
  try { await fetch('/api/logout', { method: 'POST' }); } catch (e) { }
  location.replace('/login');
}

/* active: 当前页路径；opts.public=true 表示客户可见的公开页，不做登录校验与跳转 */
function renderTopbar(active, opts) {
  const ALL = [
    ['/', '首页'], ['/content', '内容生产'], ['/consult', '咨询助手'],
    ['/workbench', '门诊工作台'], ['/map', '到店导览'], ['/settings', '模型与知识库']
  ];
  const el = document.querySelector('.topbar');
  if (!el) return null;
  const links = ALL.filter(([h]) => {
    if (h === '/consult') return false;           // 咨询助手由卡片入口进，不占主导航
    const pages = window.__pages;
    return !pages || pages.includes(h);
  });
  el.innerHTML = `
    <div class="logo"><div class="logo-mark">🦷</div><span>颌一口腔 AI 工作台</span></div>
    <div class="nav-links">${links.map(([h, t]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${t}</a>`).join('')}</div>
    <div class="spacer"></div>
    <span class="tag tag-line xs nowrap" id="engineTag">检测引擎…</span>
    <div id="userSlot"></div>`;

  api('/api/engine').then(d => {
    const t = document.getElementById('engineTag');
    if (!t) return;
    const on = d.llm.available;
    t.className = 'tag xs nowrap ' + (on ? 'tag-ok' : 'tag-brand');
    t.textContent = on ? `本地 + ${d.llm.model}` : `本地引擎 · ${d.kb.qa} 条知识`;
  }).catch(() => { });

  if (opts && opts.public) {
    document.getElementById('userSlot').innerHTML =
      '<span class="tag tag-line xs nowrap">公开页 · 无需登录</span>';
    return null;
  }

  const p = currentUser().then(user => {
    if (!user) {
      location.replace('/login?to=' + encodeURIComponent(location.pathname));
      return null;
    }
    window.__pages = user.pages;
    // 按角色重渲染菜单
    const box = document.querySelector('.nav-links');
    if (box) {
      box.innerHTML = ALL.filter(([h, t]) => h === '/consult' ? false : (user.pages || []).includes(h))
        .map(([h, t]) => `<a href="${h}" class="${active === h ? 'active' : ''}">${t}</a>`).join('');
    }
    const initial = String(user.name || '?').slice(-2);
    document.getElementById('userSlot').innerHTML = `
      <div class="user-box">
        <div class="user-avatar" title="${esc(user.name)}">${esc(initial)}</div>
        <div class="user-meta">
          <b>${esc(user.name)}</b>
          <span>${ROLE_LABEL[user.role] || '工作人员'}</span>
        </div>
        <button class="btn-out" title="退出登录" onclick="logout()">退出</button>
      </div>`;
    return user;
  });
  return p;
}

function fmtTime(iso) {
  if (!iso) return '';
  return String(iso).slice(5, 16).replace('-', '/');
}
