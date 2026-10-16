/** 探测智谱免费档各模型的可用性（不发散、非流式、最小请求） */
const KEY = process.env.ZHIPU_API_KEY;
const ENDPOINT = 'https://open.bigmodel.cn/api/paas/v4/chat/completions';

const MODELS = [
  'glm-4.7-flash',
  'glm-4-flash-250414',
  'glm-4.5-flash',
  'glm-4-flash',
  'glm-4.6v-flash',
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function probe(model, maxTokens = 16) {
  const t0 = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + KEY },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        stream: false,
        messages: [{ role: 'user', content: '回复两个字：收到' }],
      }),
    });
    const ms = Date.now() - t0;
    const txt = await res.text();
    if (res.ok) {
      let content = '';
      try { content = JSON.parse(txt).choices?.[0]?.message?.content || ''; } catch { /* ignore */ }
      return { model, ok: true, status: res.status, ms, note: `回复="${String(content).slice(0, 30)}"` };
    }
    let code = '', msg = txt.slice(0, 120);
    try { const j = JSON.parse(txt); code = j.error?.code || ''; msg = j.error?.message || msg; } catch { /* ignore */ }
    return { model, ok: false, status: res.status, ms, note: `code=${code} ${msg}` };
  } catch (e) {
    return { model, ok: false, status: 0, ms: Date.now() - t0, note: 'ERR ' + e.message };
  }
}

const results = [];
console.log('=== 第一轮：逐个免费模型 ===');
for (const m of MODELS) {
  const r = await probe(m);
  results.push(r);
  console.log(`${r.ok ? '✅' : '❌'} ${m.padEnd(22)} HTTP ${r.status}  ${r.ms}ms  ${r.note}`);
  await sleep(1200);
}

// 对第一个失败但认证正常的模型做退避重试，判断 1305 是否为瞬态
const flaky = results.find((r) => !r.ok && /1305|1302|429/.test(r.note + r.status));
if (flaky) {
  console.log(`\n=== 第二轮：对 ${flaky.model} 做退避重试（判断 1305 是否瞬态）===`);
  const waits = [3000, 8000, 20000];
  for (const w of waits) {
    await sleep(w);
    const r = await probe(flaky.model);
    console.log(`  等待 ${w}ms 后重试 → ${r.ok ? '✅ 成功' : '❌ ' + r.status} ${r.ms}ms  ${r.note}`);
    if (r.ok) break;
  }
}
