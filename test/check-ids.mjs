/**
 * 静态一致性检查：app.js 里用 $('#xxx') / getElementById 引用的每个 id，
 * 必须在 index.html 里真实存在。防的是"改 HTML 时漏加元素、或 id 拼错"
 * 这类只有到浏览器里点一下才会暴露的低级错误。
 *
 * 用法：node check-ids.mjs [appJs] [indexHtml]
 */
import fs from 'node:fs';

const APP = process.argv[2] || 'D:\\5why_check\\app.js';
const HTML = process.argv[3] || 'D:\\5why_check\\index.html';

const js = fs.readFileSync(APP, 'utf8');
const html = fs.readFileSync(HTML, 'utf8');

const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set();
for (const m of js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);
for (const m of js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)) used.add(m[1]);

const missing = [...used].filter((id) => !htmlIds.has(id)).sort();
const unused = [...htmlIds].filter((id) => !used.has(id)).sort();

console.log(`app.js 引用的 id：${used.size} 个`);
console.log(`index.html 定义的 id：${htmlIds.size} 个\n`);

if (missing.length) {
  console.log('❌ app.js 引用了但 index.html 里不存在的 id：');
  for (const id of missing) console.log('   #' + id);
} else {
  console.log('✅ app.js 引用的所有 id 在 index.html 中都存在');
}

if (unused.length) {
  console.log(`\nℹ️ index.html 里定义了、但 app.js 没直接引用的 id（{${unused.length}} 个，通常是 CSS/表单提交用，不一定有问题）：`);
  console.log('   ' + unused.map((i) => '#' + i).join(' '));
}

process.exit(missing.length ? 1 : 0);
