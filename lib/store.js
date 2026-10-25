/**
 * 极简 JSON 持久化：无需数据库，数据落在 store/*.json
 * 所有写操作串行化（write queue），避免并发覆盖。
 */
const fs = require('fs');
const path = require('path');

const DIR = path.resolve(__dirname, '..', 'store');
if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

const memory = new Map();
const queue = Promise.resolve();

function fileOf(name) {
  return path.join(DIR, name.endsWith('.json') ? name : name + '.json');
}

function read(name, fallback) {
  if (memory.has(name)) return memory.get(name);
  const f = fileOf(name);
  let data = fallback;
  try {
    if (fs.existsSync(f)) data = JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (e) {
    console.error('[store] 读取失败', name, e.message);
  }
  memory.set(name, data);
  return data;
}

function write(name, data) {
  memory.set(name, data);
  queue.then(() => {
    const f = fileOf(name);
    const tmp = f + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  }).catch(e => console.error('[store] 写入失败', name, e.message));
  return data;
}

function update(name, fallback, fn) {
  const data = read(name, fallback);
  const next = fn(data) ?? data;
  return write(name, next);
}

module.exports = { read, write, update };
