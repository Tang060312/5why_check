/**
 * 验证 server.js 的全局串行队列是否真的生效。
 * 同时并发发 N 个审核请求，检查：
 *   1. 每个请求都先收到 queued 事件，且 ahead 依次为 0/1/2…（说明排队了）
 *   2. 任意两个请求的 [start, done] 区间不重叠（说明真串行，没撞并发）
 *   3. 所有请求都正常拿到 done（说明排队没把请求搞丢）
 *
 * 用法：先启动带队列的服务，再运行本脚本
 *   $env:AI_API_KEY="..."; $env:AI_ENDPOINT="https://open.bigmodel.cn/api/paas/v4/chat/completions";
 *   $env:AI_MODEL="glm-4-flash-250414"; $env:AI_CONCURRENCY="1"; $env:PORT="3011"; node server.js
 *   node test-queue.mjs
 */
const URL = process.env.QUEUE_URL || 'http://localhost:3011/api/5why/review';
const N = Number(process.env.QUEUE_N || 3);

const SUBMISSION = [
  '【问题背景】',
  '2026-09-12 夜班，A 线 OP30 连续出现 3 件孔径超差（超差 0.03mm），停线 40 分钟。',
  '',
  '【第 1 层】',
  '问题：为什么 OP30 会出现孔径超差？',
  '分析：操作工李某换刀后没有执行首件确认就继续加工。',
  '',
  '【第 2 层】',
  '问题：为什么没有执行首件确认？',
  '分析：该员工粗心大意，责任心不强。',
  '',
  '【总结】',
  '员工责任心不足，需要加强培训。',
].join('\n');

async function one(i) {
  const events = [];
  let text = '';
  let httpError = '';
  try {
    const res = await fetch(URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: [{ role: 'user', content: SUBMISSION }] }),
    });
    if (!res.ok) {
      httpError = `HTTP ${res.status}: ${(await res.text()).slice(0, 120)}`;
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop();
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const p = line.slice(6).trim();
          if (p === '[DONE]') continue;
          try {
            const j = JSON.parse(p);
            if (j.type === 'queued') events.push({ at: Date.now(), kind: 'queued', ahead: j.ahead, running: j.running });
            else if (j.type === 'start') events.push({ at: Date.now(), kind: 'start' });
            else if (j.type === 'retry') events.push({ at: Date.now(), kind: 'retry', attempt: j.attempt, waitMs: j.waitMs });
            else if (j.type === 'chunk') text += j.content;
            else if (j.type === 'done') events.push({ at: Date.now(), kind: 'done' });
            else if (j.type === 'error') events.push({ at: Date.now(), kind: 'error', message: j.message });
          } catch { /* 忽略 */ }
        }
      }
    }
  } catch (e) {
    httpError = '连接失败: ' + e.message;
  }
  const start = events.find((e) => e.kind === 'start');
  const done = events.find((e) => e.kind === 'done');
  const err = events.find((e) => e.kind === 'error');
  return {
    i,
    events,
    chars: text.replace(/\s/g, '').length,
    startAt: start ? start.at : null,
    endAt: done ? done.at : (events.length ? events[events.length - 1].at : null),
    queuedAheads: events.filter((e) => e.kind === 'queued').map((e) => e.ahead),
    errors: [err && err.message, httpError].filter(Boolean),
  };
}

const t0 = Date.now();
console.log(`并发发送 ${N} 个审核请求 → ${URL}\n`);
const results = await Promise.all([...Array(N)].map((_, i) => one(i)));
const total = ((Date.now() - t0) / 1000).toFixed(1);

console.log('== 每个请求的时间线（相对开始，秒） ==');
for (const r of results) {
  const line = r.events
    .map((e) => {
      const t = ((e.at - t0) / 1000).toFixed(1);
      if (e.kind === 'queued') return `${t}s queued(ahead=${e.ahead},running=${e.running})`;
      if (e.kind === 'retry') return `${t}s retry#${e.attempt}(等${Math.round(e.waitMs / 1000)}s)`;
      return `${t}s ${e.kind}`;
    })
    .join(' → ');
  console.log(`  #${r.i}: ${line}`);
  if (r.chars) console.log(`      回答 ${r.chars} 字；初次排队 ahead 序列 [${r.queuedAheads.join(', ')}]`);
  if (r.errors.length) console.log(`      ❌ ${r.errors.join(' | ')}`);
}

/* ---- 判定 ---- */
let bad = 0;
const say = (ok, msg) => { console.log(`  ${ok ? '✅' : '❌'} ${msg}`); if (!ok) bad++; };

console.log('\n== 判定 ==');
say(results.every((r) => r.events.some((e) => e.kind === 'queued') || r.events.some((e) => e.kind === 'start')),
  '每个请求都收到了排队通知或直接开工（队首会直接 start）');
say(results.some((r) => r.queuedAheads.some((a) => a > 0)) || N === 1, '有请求排在别人后面（ahead > 0），说明确实在排队');
say(results.some((r) => r.queuedAheads.length >= 2 && r.queuedAheads[r.queuedAheads.length - 1] < r.queuedAheads[0]) || N <= 1,
  '排队位置会随前面的人完成而前移（收到多次 queued 且 ahead 递减）');

const withInterval = results.filter((r) => r.startAt && r.endAt).sort((a, b) => a.startAt - b.startAt);
say(withInterval.length === N, `所有 ${N} 个请求都走完了 start → done 全流程（实际 ${withInterval.length} 个）`);
let overlap = null;
for (let i = 1; i < withInterval.length; i++) {
  if (withInterval[i].startAt < withInterval[i - 1].endAt) {
    overlap = [withInterval[i - 1].i, withInterval[i].i];
  }
}
say(!overlap, overlap
  ? `请求 #${overlap[0]} 与 #${overlap[1]} 的处理区间重叠 → 没有真正串行！`
  : `任意两个请求的处理区间都不重叠 → 全局串行生效（并发上限 1）`);

say(results.every((r) => r.chars > 0 && !r.errors.length), `所有请求都拿到了完整回答（耗时合计 ${total}s）`);

console.log(bad === 0 ? '\n✅ 队列验证通过' : `\n❌ 有 ${bad} 项未通过`);
process.exit(bad === 0 ? 0 : 1);
