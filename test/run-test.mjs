#!/usr/bin/env node
/**
 * 5Why 审核工具 · 回答质量测试台
 * ------------------------------------------------------------------
 * 用途：对同一批 5Why 用例，跑通真实 AI 调用，检查输出是否符合
 *       提示词要求（六板块/评分/逐层点评…），并检查输出能否被前端
 *       app.js 的 formatAI() 正确解析。
 *
 * 用法：
 *   离线自检（不需要 Key，验证检测逻辑本身）：
 *     node run-test.mjs --selftest
 *
 *   真机测试（智谱免费档）：
 *     node run-test.mjs --provider zhipu --key sk-xxxx
 *
 *   真机测试（本地代理，即 npm start 后）：
 *     node run-test.mjs --provider proxy
 *
 *   对比 max_tokens 是否导致截断（核心假设验证）：
 *     node run-test.mjs --provider zhipu --key sk-xxxx --max-tokens 350
 *     node run-test.mjs --provider zhipu --key sk-xxxx --max-tokens 1200
 *
 * 常用参数：
 *   --provider <zhipu|deepseek|proxy|custom>   默认 zhipu
 *   --key <apiKey>                             custom/proxy 之外必填
 *   --endpoint <url>                           覆盖接口地址
 *   --model <name>                             覆盖模型名
 *   --max-tokens <n>                           默认 350（与现工程一致）
 *   --temperature <n>                          默认 0.3（与现工程一致）
 *   --thinking <disabled|enabled|none>         默认 disabled（与现工程一致）
 *   --prompt <path>                            提示词文件，默认自动查找 promt.txt
 *   --cases <01,02>                            只跑指定用例
 *   --out <dir>                                报告目录，默认 ./reports
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CASES_DIR = path.join(__dirname, 'cases');

/* ------------------------------ 参数解析 ------------------------------ */
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (!k.startsWith('--')) continue;
    const name = k.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) a[name] = true;
    else { a[name] = next; i++; }
  }
  return a;
}
const args = parseArgs(process.argv.slice(2));

const PRESETS = {
  zhipu: { endpoint: 'https://open.bigmodel.cn/api/paas/v4/chat/completions', model: 'glm-4.7-flash' },
  deepseek: { endpoint: 'https://api.deepseek.com/chat/completions', model: 'deepseek-chat' },
  proxy: { endpoint: 'http://localhost:3001/api/5why/review', model: '(服务端 AI_CONFIG)' },
  custom: {},
};

const provider = String(args.provider || 'zhipu');
const preset = PRESETS[provider] || {};
const endpoint = String(args.endpoint || preset.endpoint || '');
const model = String(args.model || preset.model || '');
const maxTokens = Number(args['max-tokens'] ?? 350);
const temperature = Number(args.temperature ?? 0.3);
const thinking = String(args.thinking || 'disabled');
const apiKey = args.key ? String(args.key) : process.env.ZHIPU_API_KEY || process.env.DEEPSEEK_API_KEY || '';

/* --------------------------- 提示词定位 --------------------------- */
function findPrompt() {
  if (args.prompt) return String(args.prompt);
  const cands = [
    path.join(__dirname, '..', 'promt.txt'),
    'D:\\5why_check\\promt.txt',
  ];
  for (const c of cands) if (fs.existsSync(c)) return c;
  return null;
}

/* ----------------------------- 用例读取 ----------------------------- */
function loadCases(filter) {
  if (!fs.existsSync(CASES_DIR)) throw new Error('找不到用例目录: ' + CASES_DIR);
  const files = fs.readdirSync(CASES_DIR).filter((f) => f.endsWith('.md')).sort();
  const wanted = filter ? String(filter).split(',').map((s) => s.trim()) : null;
  const out = [];
  for (const f of files) {
    if (wanted && !wanted.some((w) => f.startsWith(w))) continue;
    const raw = fs.readFileSync(path.join(CASES_DIR, f), 'utf8');
    const meta = {};
    const m = raw.match(/<!--\s*meta([\s\S]*?)-->/);
    if (m) {
      for (const line of m[1].split('\n')) {
        const i = line.indexOf(':');
        if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
      }
    }
    const submission = raw.replace(/<!--\s*meta[\s\S]*?-->/, '').trim();
    const layers = (submission.match(/【第\s*\d+\s*层】/g) || []).length;
    out.push({ id: f.match(/^(\d+)/)?.[1] || f, file: f, meta, submission, layers });
  }
  return out;
}

/* --------------------------- 输出检测规则 --------------------------- */
/** 逐条检查 AI 输出。返回 {id, level:'ok'|'warn'|'fail', msg} 列表 */
function checkOutput(text, c, finishReason) {
  const R = [];
  const push = (id, level, msg) => R.push({ id, level, msg });
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''));
  const lineOf = (re) => lines.find((l) => re.test(l));

  const conclusionLine = lineOf(/^结论[：:]/);
  const scoreLine = lineOf(/^(评分|得分)[：:]\s*\d{1,3}/);
  const countLine = lineOf(/^漏洞数[：:]/);
  const issueHead = lines.findIndex((l) => /^漏洞清单[：:]/.test(l));
  const layerHead = lines.findIndex((l) => /^逐层点评[：:]/.test(l));
  const dirHead = lines.findIndex((l) => /^\*{0,2}(方向纠偏|改进方向)\*{0,2}[：:]/.test(l));
  const adviceIdx = lines.findIndex((l) => /^修改建议[：:]/.test(l));

  /* --- 1. 六板块齐全 --- */
  if (!conclusionLine) push('S1', 'fail', '缺少「结论：」行');
  if (!scoreLine) push('S2', 'fail', '缺少「评分：」行（前端评分卡不会渲染）');
  if (!countLine) push('S3', 'fail', '缺少「漏洞数：」行');
  if (issueHead < 0) push('S4', 'fail', '缺少「漏洞清单：」标题');
  if (layerHead < 0) push('S5', 'fail', '缺少「逐层点评：」标题');
  if (adviceIdx < 0) push('S6', 'fail', '缺少「修改建议：」（也可能被 max_tokens 截断）');

  /* --- 2. 板块顺序 --- */
  const order = [
    ['结论', conclusionLine ? lines.indexOf(conclusionLine) : -1],
    ['评分', scoreLine ? lines.indexOf(scoreLine) : -1],
    ['漏洞清单', issueHead],
    ['逐层点评', layerHead],
    ['方向纠偏', dirHead],
    ['修改建议', adviceIdx],
  ].filter(([, i]) => i >= 0);
  const badOrder = order.some(([, i], k) => k > 0 && i < order[k - 1][1]);
  if (badOrder) push('S7', 'warn', '板块顺序与提示词要求不一致：' + order.map(([n]) => n).join(' → '));

  /* --- 3. 结论取值 --- */
  if (conclusionLine) {
    const v = conclusionLine.replace(/^结论[：:]\s*/, '').trim();
    if (!/^(合格|基本合格|不合格)/.test(v)) push('S1b', 'fail', `结论取值不合法：「${v}」（应为 合格/基本合格/不合格）`);
  }

  /* --- 4. 结论与评分区间一致 --- */
  if (conclusionLine && scoreLine) {
    const cv = conclusionLine.replace(/^结论[：:]\s*/, '').trim();
    const sv = parseInt(scoreLine.replace(/^(评分|得分)[：:]\s*/, ''), 10);
    let want = null;
    if (/^不合格/.test(cv)) want = [0, 59];
    else if (/^基本合格/.test(cv)) want = [60, 84];
    else if (/^合格/.test(cv)) want = [85, 100];
    if (want && (sv < want[0] || sv > want[1])) {
      push('S9', 'fail', `结论「${cv}」与评分 ${sv} 不匹配（应为 ${want[0]}~${want[1]}）`);
    }
  }

  /* --- 5. 漏洞数 与 漏洞清单条数 --- */
  if (countLine) {
    const n = parseInt(countLine.replace(/^漏洞数[：:]\s*/, ''), 10);
    const issueBlock = issueHead >= 0 ? lines.slice(issueHead + 1, layerHead >= 0 ? layerHead : lines.length) : [];
    const items = issueBlock.filter((l) => /^\s*\d+[.、]/.test(l));
    const saidNone = issueBlock.some((l) => /^\s*无\s*$/.test(l))
      || /[：:]\s*无\s*$/.test(issueHead >= 0 ? lines[issueHead] : '');
    if (!isNaN(n)) {
      if (n === 0 && !saidNone && items.length === 0) push('S8b', 'warn', '漏洞数为 0，但清单未写「无」');
      if (n > 0 && items.length !== n) push('S8', 'fail', `漏洞数写 ${n}，清单实际 ${items.length} 条`);
    }
    // 提示词要求每条漏洞附「（建议：如何改）」
    const noAdvice = items.filter((l) => !/[（(]\s*建议/.test(l)).length;
    if (noAdvice) push('S12', 'warn', `${noAdvice} 条漏洞未附「（建议：…）」，可操作性下降`);
  }

  /* --- 6. 逐层点评覆盖度 --- */
  if (layerHead >= 0) {
    const block = lines.slice(layerHead + 1, adviceIdx >= 0 ? adviceIdx : lines.length);
    const seen = new Set();
    let missingScore = 0;
    for (const l of block) {
      const m = l.match(/^第\s*(\d+)\s*层/);
      if (m) {
        seen.add(Number(m[1]));
        if (!/[（(]\s*\d{1,2}\s*\/\s*10\s*[）)]/.test(l)) missingScore++;
      }
    }
    for (let i = 1; i <= c.layers; i++) if (!seen.has(i)) push('S10', 'fail', `逐层点评缺少第 ${i} 层`);
    if (missingScore) push('S10b', 'fail', `${missingScore} 行点评缺少（N/10）得分（且须为全角括号）`);
    for (const n of seen) if (n > c.layers) push('S10c', 'warn', `点评了不存在的第 ${n} 层（提交只有 ${c.layers} 层）`);
    // 实测高发：模型把提示词里的占位符「（N/10）」原样照抄，未替换为实际分数
    const ph = block.filter((l) => /^第\s*\d+\s*层/.test(l) && /[（(]\s*N\s*\/\s*10\s*[）)]/i.test(l)).length;
    if (ph) push('S10d', 'fail', `${ph} 行点评照抄了占位符「（N/10）」未替换为实际数字 → 前端得分徽章必然全部丢失`);
  }
  /* --- 6b. 方向纠偏（2026-10-16 新增需求：方向偏差要指出该往哪想） --- */
  if (dirHead < 0) {
    push('D0', 'fail', '缺少「方向纠偏：」节（新需求要求必须输出）');
  } else {
    const end = adviceIdx > dirHead ? adviceIdx : lines.length;
    const dBlock = lines.slice(dirHead + 1, end).map((l) => l.trim()).filter(Boolean);
    const saidNone = dBlock.some((l) => /^无[。.]?$/.test(l));
    if (!dBlock.length) push('D1', 'fail', '「方向纠偏」节为空');
    else if (c.meta.expectDirection === '1' && saidNone) push('D1', 'fail', '本用例存在明显方向偏差，但「方向纠偏」写了"无"（漏检方向问题）');
    else if (c.meta.expectDirection === '0' && !saidNone) push('D1', 'warn', '本用例方向正确，却仍给出了方向纠偏（疑似误报，需人工确认）');
    else if (c.meta.expectDirection === '1' && !/→|->|改为|转向/.test(dBlock.join(''))) push('D1b', 'warn', '「方向纠偏」未写清"当前方向 → 更好的方向"的对比');
    else push('D1', 'ok', '「方向纠偏」节存在且与用例期望一致');
  }

  if (adviceIdx >= 0 && /[（(]\s*\d{1,2}\s*\/\s*10\s*[）)]/.test(lines[adviceIdx])) {
    push('S10e', 'warn', '「修改建议」行误带了 (N/10) 分数（提示词「每行末尾」表述有歧义）');
  }

  /* --- 7. 字数（与 promt.txt 的篇幅要求对齐，默认 400 字） --- */
  const clean = text.replace(/\s/g, '');
  const charLimit = Number(args['char-limit'] ?? 1000);
  if (clean.length > charLimit) push('S11', 'warn', `全篇 ${clean.length} 字，超出提示词「≤${charLimit}字」要求（当前 max_tokens=${maxTokens}）`);
  else push('S11', 'ok', `全篇 ${clean.length} 字，符合 ≤${charLimit} 字要求`);

  /* --- 8. 截断检测（优先用接口的 finish_reason，权威；无该字段时退回启发式） --- */
  const tail = text.trimEnd().slice(-40);
  const endsWell = /[。！？）」\d]$/.test(text.trimEnd());
  if (finishReason === 'length') {
    push('S13', 'fail', `接口返回 finish_reason=length：输出被 max_tokens=${maxTokens} 截断，末尾为：「…${tail}」`);
  } else if (!finishReason && adviceIdx >= 0 && !endsWell) {
    push('S13', 'fail', `疑似被 max_tokens 截断，末尾为：「…${tail}」`);
  }

  /* --- 9. 前端解析兼容性（复刻 app.js formatAI 的正则） --- */
  const conclBold = lines.find((l) => /^\*\*结论/.test(l));
  if (conclBold) push('F1', 'fail', '结论行以 ** 开头 → app.js:268 的 ^(结论)[：:] 匹配失败，结论卡片不渲染');
  const scoreBold = lines.find((l) => /^\*\*(评分|得分)/.test(l));
  if (scoreBold) push('F2', 'fail', '评分行以 ** 开头 → app.js:277 匹配失败，评分卡不渲染');
  if (layerHead >= 0) {
    const block = lines.slice(layerHead + 1, adviceIdx >= 0 ? adviceIdx : lines.length);
    const halfWidth = block.filter((l) => /^第\s*\d+\s*层/.test(l) && /\(\s*\d{1,2}\s*\/\s*10\s*\)/.test(l)).length;
    if (halfWidth) push('F3', 'ok', `${halfWidth} 行使用半角括号 (N/10)：偏离提示词，但 app.js 已容错（2026-10-16 修复），徽章正常`);
  }
  if (conclusionLine === undefined && lines.some((l) => /^#+\s*结论/.test(l))) {
    push('F1b', 'fail', '结论用了 Markdown 标题（## 结论）→ 前端不识别');
  }

  if (!R.some((r) => r.level === 'fail')) push('OK', 'ok', '结构化检查全部通过');
  return R;
}

/** 对照用例 meta 的期望值打分 */
function checkGroundTruth(text, c) {
  const R = [];
  const push = (id, level, msg) => R.push({ id, level, msg });
  const meta = c.meta;
  const cv = (text.match(/^结论[：:]\s*(.*)$/m) || [])[1]?.trim() || '';
  const sv = parseInt((text.match(/^(?:评分|得分)[：:]\s*(\d{1,3})/m) || [])[1] || '', 10);
  const nv = parseInt((text.match(/^漏洞数[：:]\s*(\d+)/m) || [])[1] || '', 10);

  if (meta.expect && !cv.startsWith(meta.expect)) push('G1', 'fail', `结论期望「${meta.expect}」，实际「${cv}」`);
  else if (meta.expect) push('G1', 'ok', `结论「${cv}」符合期望`);

  if (!isNaN(sv)) {
    const lo = meta.expectScoreMin !== undefined ? Number(meta.expectScoreMin) : 0;
    const hi = meta.expectScoreMax !== undefined ? Number(meta.expectScoreMax) : 100;
    if (sv < lo || sv > hi) push('G2', 'fail', `评分期望 ${lo}~${hi}，实际 ${sv}`);
    else push('G2', 'ok', `评分 ${sv} 落在期望区间 ${lo}~${hi}`);
  }
  if (!isNaN(nv)) {
    if (meta.expectIssuesMin !== undefined && nv < Number(meta.expectIssuesMin)) push('G3', 'fail', `漏洞数期望 ≥${meta.expectIssuesMin}，实际 ${nv}（漏检）`);
    else if (meta.expectIssuesMax !== undefined && nv > Number(meta.expectIssuesMax)) push('G3', 'fail', `漏洞数期望 ≤${meta.expectIssuesMax}，实际 ${nv}（误报）`);
    else push('G3', 'ok', `漏洞数 ${nv} 符合期望`);
  }
  if (meta.expectIssueLayers) {
    const want = meta.expectIssueLayers.split(',').map((s) => s.trim());
    const miss = want.filter((n) => !new RegExp(`第\\s*${n}\\s*层`).test(text));
    if (miss.length) push('G4', 'warn', `未点名关键层：${miss.map((n) => '第' + n + '层').join('、')}`);
    else push('G4', 'ok', '关键缺陷层均被点名');
  }
  return R;
}

/* ------------------------------ 调用 AI ------------------------------ */
async function callDirect(prompt, submission) {
  const build = (withUsage) => {
    const body = {
      model,
      temperature,
      max_tokens: maxTokens,
      stream: true,
      messages: [
        { role: 'system', content: prompt },
        { role: 'user', content: submission },
      ],
    };
    if (thinking !== 'none') body.thinking = { type: thinking };
    if (withUsage) body.stream_options = { include_usage: true };
    return body;
  };
  const post = (body) => fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
    body: JSON.stringify(body),
  });

  let res = await post(build(true));
  if (!res.ok && res.status === 400) res = await post(build(false)); // 少数端点不认 stream_options
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return readSSE(res, (j) => j.choices?.[0]?.delta?.content);
}

async function callProxy(submission) {
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: submission }] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return readSSE(res, (j) => (j.type === 'chunk' ? j.content : j.choices?.[0]?.delta?.content));
}

async function readSSE(res, pick) {
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let out = '';
  let finishReason = '';
  let usage = null;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith('data:')) continue;
      const p = t.slice(5).trim();
      if (p === '[DONE]') return { text: out, finishReason, usage };
      try {
        const j = JSON.parse(p);
        if (j.usage) usage = j.usage;
        const fr = j.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
        const c = pick(j);
        if (c) out += c;
      } catch { /* 忽略 */ }
    }
  }
  return { text: out, finishReason, usage };
}

/* ------------------------------- 报告 ------------------------------- */
function fmt(results) {
  const icon = { ok: '✅', warn: '⚠️', fail: '❌' };
  return results.map((r) => `  ${icon[r.level]} [${r.id}] ${r.msg}`).join('\n');
}

/* ------------------------------ 自检 ------------------------------ */
const SELFTEST_SAMPLES = {
  good: `结论：不合格
评分：35
漏洞数：3
漏洞清单：
1. 第2层·分析：**归咎个人**，未指向系统（建议：追问检查机制为何失效）
2. 第3层·问题：**答非所问**，未承接上层（建议：改为追问为何检查不到位）
3. 第4层·分析：停在**没有培训**表层（建议：深挖培训缺失的机制原因）
逐层点评：
第1层：描述现象未验证（5/10）
第2层：归因个人（2/10）
第3层：答非所问（2/10）
第4层：过早停止（3/10）
方向纠偏：
1. 当前方向：只追个人责任 → 更好的方向：追检查机制为何失效（可这样追问：为什么首件确认没有被强制执行？）
修改建议：优先改第2层，把个人归因改为检查机制问题。`,
  truncated: `结论：基本合格
评分：70
漏洞数：2
漏洞清单：
1. 第2层·分析：归因个人（建议：改为系统层面）
2. 第3层·问题：答非所问（建议：承接上层）
逐层点评：
第1层：描述现象（6/10）
第2层：归因个人（4/10）
第3层：答非所问（4/10）
第4层：过早停止（5/10）
修改建议：优先改第2层`,
  malformed: `## 结论
合格

得分：90
漏洞清单：
1. 第1层：ok
逐层点评：
第1层：没问题 (9/10)
第2层：没问题 (8/10)
修改建议：无需修改。`,
};

function runSelftest() {
  const c = { layers: 4, meta: { expect: '不合格', expectScoreMax: '59', expectIssuesMin: '3', expectIssueLayers: '2,3,4' } };
  let bad = 0;
  console.log('\n================ 离线自检 ================\n');

  // 样例1：格式良好，应无 fail
  let r = checkOutput(SELFTEST_SAMPLES.good, c);
  let fails = r.filter((x) => x.level === 'fail');
  console.log('【样例A · 格式规范的输出】');
  console.log(fmt(r));
  if (fails.length) { console.log('  → 自检失败：规范输出不应报 fail'); bad++; }
  else console.log('  → 正确：无 fail');

  // 样例2：缺修改建议结尾 → 应检出截断
  r = checkOutput(SELFTEST_SAMPLES.truncated, c);
  fails = r.filter((x) => x.level === 'fail');
  console.log('\n【样例B · 被 max_tokens 截断的输出】');
  console.log(fmt(r));
  if (!fails.some((x) => x.id === 'S13')) { console.log('  → 自检失败：应检出 S13 截断'); bad++; }
  else console.log('  → 正确：检出截断');

  // 样例3：Markdown 标题 + 半角括号 + 无评分行 → 应检出 F1/F3/S2
  r = checkOutput(SELFTEST_SAMPLES.malformed, c);
  fails = r.filter((x) => x.level === 'fail');
  console.log('\n【样例C · 前端无法解析的输出】');
  console.log(fmt(r));
  // 样例C 有「得分：90」，所以 S2 不应报错；用的是 ## 结论 与半角括号，应报 S1/S1b 类问题
  const ids = new Set(fails.map((x) => x.id));
  for (const need of ['S1', 'S3', 'S10', 'F1b']) {
    if (!ids.has(need)) { console.log(`  → 自检失败：应检出 ${need}`); bad++; }
  }
  if (ids.has('S1') && ids.has('S10') && ids.has('F1b')) console.log('  → 正确：检出前端解析问题');

  console.log('\n================ 自检结果 ================');
  console.log(bad === 0 ? '✅ 检测逻辑正常，可用于真机测试' : `❌ 有 ${bad} 项自检未通过`);
  return bad === 0 ? 0 : 1;
}

/* ------------------------------- 主流程 ------------------------------- */
async function main() {
  if (args.selftest) process.exit(runSelftest());

  const cases = loadCases(args.cases);
  if (!cases.length) { console.error('没有匹配的用例'); process.exit(1); }

  const promptPath = findPrompt();
  if (provider !== 'proxy' && !promptPath) { console.error('找不到 promt.txt，请用 --prompt 指定'); process.exit(1); }
  const prompt = promptPath ? fs.readFileSync(promptPath, 'utf8').trim() : '';
  if (provider !== 'proxy' && !apiKey) { console.error(`provider=${provider} 需要 --key`); process.exit(1); }

  console.log(`\n提示词: ${promptPath || '(由服务端注入)'}  (${prompt.length} 字符)`);
  console.log(`接口  : ${endpoint}`);
  console.log(`模型  : ${model}   温度:${temperature}   max_tokens:${maxTokens}   thinking:${thinking}`);
  console.log(`用例  : ${cases.map((c) => c.id).join(', ')}\n`);

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outArg = args.out ? String(args.out) : 'reports';
  const outDir = path.isAbsolute(outArg) ? outArg : path.join(__dirname, outArg);
  fs.mkdirSync(outDir, { recursive: true });

  const rows = [];
  let md = `# 5Why 审核 · 回答质量测试报告\n\n- 时间：${new Date().toLocaleString('zh-CN')}\n- 接口：${endpoint}\n- 模型：${model}\n- 参数：temperature=${temperature} max_tokens=${maxTokens} thinking=${thinking}\n- 提示词：${promptPath || '(服务端注入)'} (${prompt.length} 字符)\n\n`;

  for (const c of cases) {
    process.stdout.write(`▶ 用例 ${c.id} (${c.layers} 层) … `);
    let text = '';
    let finishReason = '';
    let usage = null;
    try {
      const r = provider === 'proxy' ? await callProxy(c.submission) : await callDirect(prompt, c.submission);
      text = r.text; finishReason = r.finishReason; usage = r.usage;
    } catch (e) {
      console.log('调用失败: ' + e.message);
      md += `## 用例 ${c.id} · 调用失败\n\n\`\`\`\n${e.message}\n\`\`\`\n\n`;
      rows.push({ id: c.id, fail: 1, warn: 0, chars: 0, tokens: '', note: '调用失败' });
      continue;
    }
    const checks = [...checkOutput(text, c, finishReason), ...checkGroundTruth(text, c)];
    const fails = checks.filter((x) => x.level === 'fail').length;
    const warns = checks.filter((x) => x.level === 'warn').length;
    const chars = text.replace(/\s/g, '').length;
    const pt = usage?.prompt_tokens, ct = usage?.completion_tokens, tt = usage?.total_tokens;
    const tokenNote = (tt !== undefined) ? `消耗 ${pt}+${ct}=${tt} tokens` : (usage ? JSON.stringify(usage) : '接口未返回 usage');
    console.log(`${fails} fail / ${warns} warn / ${chars} 字 / ${tokenNote}`);
    rows.push({ id: c.id, fail: fails, warn: warns, chars, tokens: tt !== undefined ? `${pt}+${ct}=${tt}` : '-', note: c.meta.expect || '' });

    md += `## 用例 ${c.id} · ${c.file}\n\n`;
    md += `**期望**：${c.meta.expect || '(未标注)'} ｜ 期望评分：${c.meta.expectScoreMin || 0}~${c.meta.expectScoreMax || 100} ｜ 期望漏洞数：≥${c.meta.expectIssuesMin || 0}\n\n`;
    md += `> ${c.meta.note || ''}\n\n`;
    md += `**检测结果**（${fails} fail / ${warns} warn / 全文 ${chars} 字 / ${tokenNote}）\n\n\`\`\`\n${fmt(checks)}\n\`\`\`\n\n`;
    md += `**原始输出**\n\n\`\`\`text\n${text}\n\`\`\`\n\n---\n\n`;
    if (args.verbose) console.log(fmt(checks) + '\n');
  }

  const sumPt = rows.reduce((a, r) => a + (parseInt(String(r.tokens).split('+')[0], 10) || 0), 0);
  const sumCt = rows.reduce((a, r) => a + (parseInt(String(r.tokens).split('=')[0]?.split('+')[1], 10) || 0), 0);
  md += `## 汇总\n\n| 用例 | fail | warn | 字数 | token（输入+输出=合计） | 期望 |\n|---|---|---|---|---|---|\n` +
    rows.map((r) => `| ${r.id} | ${r.fail} | ${r.warn} | ${r.chars} | ${r.tokens} | ${r.note} |`).join('\n') + '\n';
  if (sumCt) md += `\n**token 合计**：输入 ${sumPt} + 输出 ${sumCt} = ${sumPt + sumCt}（${rows.length} 次审核，平均每次 ${Math.round((sumPt + sumCt) / rows.length)} tokens）\n`;

  const reportPath = path.join(outDir, `report-${stamp}.md`);
  fs.writeFileSync(reportPath, md, 'utf8');
  console.log(`\n报告已写入: ${reportPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
