/**
 * 从《颌一口腔门诊资料包.md》中抽取：
 *  1. 门诊基本信息表 + 导航说明
 *  2. 91 条 AI 客服 Q&A
 *  3. 内嵌的 Base64 图片 -> assets/*.jpg
 * 输出：data/clinic.json, data/qa.json, data/assets.json
 * 用法：node tools/extract.js
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const SRC = process.argv[2] ||
  'E:/xwechat_files/wxid_rzd054duqmwl22_4f75/msg/attach/8f26643d2fea314b1e61fa7399f6226a/2026-10/Rec/08e99710d84c6a8a/F/0/颌一口腔门诊资料包.md';

const raw = fs.readFileSync(SRC, 'utf8');
const lines = raw.split(/\r?\n/);

/* ---------- 1. 图片 ---------- */
const assets = [];
const imgRe = /<img src="data:image\/(jpeg|jpg|png);base64,([A-Za-z0-9+/=]+)"/g;
let m;
let imgIdx = 0;
const lineOfImg = [];
lines.forEach((ln, i) => {
  if (/<img src="data:image/.test(ln)) lineOfImg.push({ line: i, text: ln });
});
for (const item of lineOfImg) {
  imgRe.lastIndex = 0;
  const mm = imgRe.exec(item.text);
  if (!mm) continue;
  const ext = mm[1] === 'png' ? 'png' : 'jpg';
  // 向上找最近的图片标题（**xxx** 或 ### 标题）
  let caption = '';
  for (let k = item.line - 1; k >= Math.max(0, item.line - 4); k--) {
    const t = lines[k].trim();
    if (/^\*\*.+\*\*$/.test(t)) { caption = t.replace(/\*/g, '').trim(); break; }
  }
  // 再往上一行通常是文字描述
  let desc = '';
  for (let k = item.line - 1; k >= Math.max(0, item.line - 3); k--) {
    const t = lines[k].trim();
    if (t && !t.startsWith('<img') && !/^\*\*/.test(t) && !t.startsWith('#')) { desc = t; break; }
  }
  const file = `clinic-${String(++imgIdx).padStart(2, '0')}.${ext}`;
  fs.writeFileSync(path.join(ROOT, 'assets', file), Buffer.from(mm[2], 'base64'));
  assets.push({ file, url: `/assets/${file}`, title: caption, desc, bytes: Buffer.from(mm[2], 'base64').length });
}
console.log(`[图片] 导出 ${assets.length} 张`);

/* ---------- 2. 门诊信息表 ---------- */
const infoTable = {};
for (let i = 0; i < lines.length; i++) {
  const ln = lines[i].trim();
  if (!ln.startsWith('|')) continue;
  const cells = ln.split('|').map(s => s.trim()).filter((s, idx, arr) => idx > 0 && idx < arr.length - 1);
  if (cells.length < 2) continue;
  const key = cells[0], val = cells[1];
  if (key === '字段' || key === '---' || /^-+$/.test(key)) continue;
  if (val && !/^-+$/.test(val)) infoTable[key] = val;
}

/* ---------- 3. 导航说明 ---------- */
const nav = { metro: '', drive: '' };
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('**地铁**')) nav.metro = lines[i].replace(/\*\*地铁\*\*[：:]?/, '').replace(/\*\*/g, '').trim();
  if (lines[i].includes('**自驾**')) nav.drive = lines[i].replace(/\*\*自驾\*\*[：:]?/, '').replace(/\*\*/g, '').trim();
}

/* ---------- 4. Q&A ---------- */
const qa = [];
let cur = null;
for (const ln of lines) {
  const h = ln.match(/^###\s*(QA-\d+)｜(.+)$/);
  if (h) {
    if (cur && cur.answer) qa.push(cur);
    cur = { id: h[1], question: h[2].trim(), answer: '' };
    continue;
  }
  const a = ln.match(/^-\s*\*\*answer\*\*[：:]\s*(.+)$/);
  if (a && cur) cur.answer = a[1].trim();
}
if (cur && cur.answer) qa.push(cur);
console.log(`[Q&A] 解析 ${qa.length} 条`);

/* ---------- 5. 医生 ---------- */
const doctors = [];
for (let i = 0; i < lines.length; i++) {
  const t = lines[i].trim();
  if (/^图片可辨认[：:]/.test(t) || /^\*\*.+医生介绍卡\*\*$/.test(t)) {
    const nameM = lines.slice(i, i + 3).join(' ').match(/([\u4e00-\u9fa5]{2,4})，医师/);
    if (nameM && !doctors.some(d => d.name === nameM[1])) {
      doctors.push({ name: nameM[1], title: '医师', note: '图片可辨认姓名与"医师"身份；其余履历、头衔、认证等小字需门诊核对后再录入，AI 不主动使用。' });
    }
  }
}
console.log(`[医生] ${doctors.map(d => d.name).join('、')}`);

/* ---------- 6. 输出 ---------- */
const clinic = {
  name: infoTable['门诊名称'] || '颌一口腔',
  address: infoTable['地址'] || '',
  contact: infoTable['电话/微信号'] || '',
  hours: {
    weekday: infoTable['周一至周五'] || '',
    weekend: infoTable['周六及周日'] || ''
  },
  booking: infoTable['预约'] || '',
  services: (infoTable['服务项目'] || '').split('、').map(s => s.trim()).filter(Boolean),
  nav,
  doctors,
  rules: [
    'AI 仅回答一般性服务与口腔健康教育问题，不做个体诊断、不给治疗方案、不给具体报价、不承诺排班号源。',
    '涉及个体诊断、治疗方案、适应证、用药、术后急症、价格、医生排班的问题，一律转人工/医生。',
    '不杜撰医生履历、价格、治疗成功率、能否预约、停车收费等未明确的信息。',
    '留存用户资料及发送后续消息须取得客户明确授权，且可随时退出。'
  ]
};

fs.writeFileSync(path.join(ROOT, 'data', 'clinic.json'), JSON.stringify(clinic, null, 2), 'utf8');
fs.writeFileSync(path.join(ROOT, 'data', 'qa.json'), JSON.stringify(qa, null, 2), 'utf8');
fs.writeFileSync(path.join(ROOT, 'data', 'assets.json'), JSON.stringify(assets, null, 2), 'utf8');
console.log('[输出] data/clinic.json, data/qa.json, data/assets.json');
