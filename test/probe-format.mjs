/**
 * 直接抽取 D:\5why_check\app.js 里的真实 formatAI() 函数并对其测试，
 * 验证哪些 AI 输出格式会导致前端渲染降级。
 * 运行：node probe-format.mjs
 */
import fs from 'node:fs';

const APP = process.argv[2] || 'D:\\5why_check\\app.js';
const src = fs.readFileSync(APP, 'utf8');
console.log('被测文件: ' + APP);

const start = src.indexOf('  function formatAI(text) {');
const end = src.indexOf('  function renderMessage(m) {');
if (start < 0 || end < 0) throw new Error('未能定位 formatAI()');
const fnSrc = src.slice(start, end).trim();

// app.js 里的 esc() 实现（同源抽取，保证一致）
const escSrc = src.match(/function esc\(s\) \{[\s\S]*?\n  \}/)[0];

const factory = new Function(`${escSrc}\n${fnSrc}\nreturn formatAI;`);
const formatAI = factory();

const CASES = {
  'A 规范输出（全角冒号、全角括号）': `结论：合格
评分：90
漏洞数：0
漏洞清单：
无
逐层点评：
第1层：贴合背景（9/10）
第2层：证据充分（9/10）
修改建议：无需修改。`,

  'B 模型把标题也加粗（**结论：**）': `**结论：**合格
**评分：**90
**漏洞数：**0
漏洞清单：
无
逐层点评：
第1层：贴合背景（9/10）
修改建议：无需修改。`,

  'C 层得分用半角括号 (9/10)': `结论：合格
评分：90
漏洞数：0
漏洞清单：
无
逐层点评：
第1层：贴合背景 (9/10)
第2层：证据充分 (9/10)
修改建议：无需修改。`,

  'D 用 Markdown 标题（## 结论）': `## 结论
合格
## 评分
90
## 漏洞清单
无
## 逐层点评
第1层：贴合背景（9/10）
## 修改建议
无需修改。`,

  'E 规范 + 半角冒号': `结论: 合格
评分: 90
漏洞数: 0
漏洞清单:
无
逐层点评:
第1层: 贴合背景（9/10）
修改建议: 无需修改。`,

  'F 点评照抄占位符（N/10）—— 实测高发': `结论：不合格
评分：59
漏洞数：4
漏洞清单：
1. 第2层·分析：归咎个人（建议：改系统层面）
逐层点评：
第1层：逻辑断裂（N/10）
第2层：答非所问（N/10）
修改建议：逐层重构（N/10）`,
};

const MARK = {
  '  · 结论卡片 judge-line': (h) => h.includes('judge-line conclusion'),
  '  · 评分卡片 score-card': (h) => h.includes('score-card'),
  '  · 层得分徽章 layer-score': (h) => h.includes('layer-score'),
  '  · 问题词句高亮 <mark>': (h) => h.includes('<mark>'),
};

let broken = 0;
for (const [name, text] of Object.entries(CASES)) {
  const html = formatAI(text);
  const ref = CASES['A 规范输出（全角冒号、全角括号）'];
  const htmlRef = formatAI(ref);
  console.log('\n' + name);
  for (const [label, test] of Object.entries(MARK)) {
    const got = test(html);
    const baseline = test(htmlRef);
    const flag = baseline && !got ? '❌ 降级' : (got ? '✅ 正常' : '— 无（基线也无）');
    if (flag === '❌ 降级') broken++;
    console.log(`  ${flag}${label}`);
  }
  if (name.startsWith('B')) console.log('    实际输出片段：' + html.split('\n')[0].slice(0, 120));
}
console.log(`\n共发现 ${broken} 处渲染降级。`);
