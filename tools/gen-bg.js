/*
 * 生成首页 / 全站背景所用的「牙齿轮廓暗纹」data URI，并写回 public/css/style.css。
 * 用法：node tools/gen-bg.js
 * 可改 BEGIN/END 之间的 SVG 内容，或调整 TILE / OPACITY 后重跑。
 */
const fs = require('fs'), path = require('path');

const TILE = 118;
const STROKE_OPACITY = 0.20;
const STROKE = '#2dd4bf';

// 对称牙齿：冠部 y5–26，两枚牙根 y28.6–40，中间为根分叉缺口
const TOOTH = 'M7.5 20C7.5 12 12.5 6.5 17.5 6.5C19 6.5 19.5 8 20 8C20.5 8 21 6.5 22.5 6.5C27.5 6.5 32.5 12 32.5 20L32.5 26C32.5 31.5 31.2 35.5 29.8 38.4C29.3 40 27.3 40.2 26.9 38.6C26.4 36.4 27 33 24.6 30.6C23 29.4 21.6 28.6 20 28.6C18.4 28.6 17 29.4 15.4 30.6C13 33 13.6 36.4 13.1 38.6C12.7 40.2 10.7 40 10.2 38.4C8.8 35.5 7.5 31.5 7.5 26L7.5 20Z';

const svg =
  `<svg xmlns="http://www.w3.org/2000/svg" width="${TILE}" height="${TILE}" viewBox="0 0 ${TILE} ${TILE}">` +
  `<g fill="none" stroke="${STROKE}" stroke-opacity="${STROKE_OPACITY}" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">` +
  `<g transform="translate(14,14) rotate(-12) scale(1.05)"><path d="${TOOTH}"/></g>` +
  `<g transform="translate(66,64) rotate(14) scale(1.05)"><path d="${TOOTH}"/></g>` +
  `</g>` +
  `<g fill="#ffffff" fill-opacity="0.07"><circle cx="96" cy="30" r="1.7"/><circle cx="28" cy="92" r="1.7"/><circle cx="66" cy="40" r="1.2"/></g>` +
  `<g stroke="#ffffff" stroke-opacity="0.06" stroke-width="1.3" stroke-linecap="round">` +
  `<path d="M56 6v7M52.5 9.5h7"/><path d="M8 62v5.5M5.2 64.8h5.6"/></g>` +
  `</svg>`;

const uri = 'data:image/svg+xml,' + encodeURIComponent(svg).replace(/%20/g, ' ');

const file = path.join(__dirname, '..', 'public', 'css', 'style.css');
let css = fs.readFileSync(file, 'utf8');

// 按位置替换旧的 data URI（不用正则，避免 % 转义带来的匹配问题）
const at = css.indexOf('data:image/svg+xml,');
const from = at < 0 ? -1 : css.lastIndexOf('url("', at);
const to = from < 0 ? -1 : css.indexOf('")', at) + 2;
if (from < 0 || to < 2) {
  console.error('未在 style.css 中找到待替换的 data URI');
  process.exit(1);
}
css = css.slice(0, from) + `url("${uri}")` + css.slice(to);
fs.writeFileSync(file, css);
console.log('已写入牙齿轮廓暗纹，data URI 长度：', uri.length);
