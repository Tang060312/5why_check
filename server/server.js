const express = require('express');
const path = require('path');
const fs = require('fs');

/* =====================================================================
 * ★★★ 在这里接入你的大模型 API ★★★
 * ---------------------------------------------------------------------
 * 本服务通过「OpenAI 兼容接口」调用大模型（DeepSeek / 智谱 GLM /
 * 通义千问 / Kimi / GPT / 本地 Ollama 等均支持该协议）。
 *
 * 配置优先级：环境变量 > 下面的 AI_CONFIG 默认值。
 * 推荐用环境变量传 Key，不要把 Key 提交进仓库（本仓库是公开的）：
 *   set AI_API_KEY=你的Key          （Windows cmd）
 *   $env:AI_API_KEY="你的Key"       （PowerShell）
 *   export AI_API_KEY=你的Key       （bash）
 * 可选：AI_ENDPOINT / AI_MODEL / AI_CONCURRENCY / AI_QUEUE_LIMIT
 *
 * 未配置（apiKey 仍为占位符）时，服务会返回内置模拟回复，
 * 方便先体验完整流程；配置后自动切换为真实 AI。
 * ===================================================================== */
const AI_CONFIG = {
  endpoint: process.env.AI_ENDPOINT || 'https://api.deepseek.com/chat/completions', // ← 接口地址
  apiKey: process.env.AI_API_KEY || process.env.ZHIPU_API_KEY || 'sk-在这里填入你的APIKey', // ← 你的 API Key
  model: process.env.AI_MODEL || 'deepseek-v4-flash',   // ← 模型名称
  temperature: 0.3,                                     // ← 采样温度
  // 思考模式：{ type: 'disabled' } 关闭推理（省 token、最快）；需要推理时可改为
  // { type: 'enabled', budget_tokens: 1024 }（注意：API 只接受对象格式，字符串 'low' 会报 400）
  thinking: { type: 'disabled' },
  // 2026-10-16 由 350 上调至 2000：350 会挤压回答质量；2000 只作失控兜底，
  // 真正的防爆炸闸门是 thinking 关闭（推理 token 才是当初消耗失控的主因）。
  maxTokens: 2000,
};

/* =====================================================================
 * 排队与限流配置（2026-10-16 新增）
 * ---------------------------------------------------------------------
 * 免费档（如智谱 GLM-4.7-Flash）通常只允许 1 个并发，多人同时提交时
 * 后来者会直接吃到 1302「触发用户速率限制」报错。这里在服务端做
 * 全局串行队列：所有使用者的请求排成一条队，一个一个发给 AI。
 * ===================================================================== */
const QUEUE_CONFIG = {
  concurrency: Math.max(1, Number(process.env.AI_CONCURRENCY || 1)), // 同时发给 AI 的请求数（免费档填 1）
  queueLimit: Math.max(1, Number(process.env.AI_QUEUE_LIMIT || 20)), // 最多允许多人排队，超出直接拒绝
  maxRetries: Math.max(0, Number(process.env.AI_MAX_RETRIES || 3)),  // 遇到限流/过载自动重试次数
  retryBaseMs: Math.max(500, Number(process.env.AI_RETRY_BASE_MS || 3000)), // 首次重试等待，之后翻倍
  jobTimeoutMs: Math.max(5000, Number(process.env.AI_JOB_TIMEOUT_MS || 120000)), // 单个请求最长处理时间
};

/* =====================================================================
 * 以下为服务实现代码，一般无需修改
 * ===================================================================== */
const app = express();
const PORT = process.env.PORT || 3001; // 与 5why 项目（3000 端口）互不冲突
const PLACEHOLDER_KEY = 'sk-在这里填入你的APIKey';

/* 系统提示词：直接读取仓库根目录的 promt.txt（每次请求时读取，
   修改 promt.txt 后无需重启服务即可生效） */
const PROMPT_FILE = path.join(__dirname, '..', 'promt.txt');
const FALLBACK_PROMPT = '你是一位5Why分析审核专家，请审核用户提交的5Why分析链条是否存在逻辑漏洞，并给出修改建议。';

function getSystemPrompt() {
  try {
    const content = fs.readFileSync(PROMPT_FILE, 'utf8');
    return content.trim() || FALLBACK_PROMPT;
  } catch {
    return FALLBACK_PROMPT;
  }
}

function isAIConfigured() {
  return !!AI_CONFIG.apiKey && AI_CONFIG.apiKey !== PLACEHOLDER_KEY && AI_CONFIG.apiKey !== '';
}

app.use(express.json({ limit: '2mb' }));

/* 网关标记（2026-10-16）：前端启动时会来取这个文件。
   取到了 = "本页面就是网关自己发出来的"，于是自动切到网关模式：
   请求打相对地址、同源、使用者不用填 Key、并且享受这里的排队。
   GitHub Pages 上没有这个文件 → 前端照常走浏览器直连模式。
   （必须放在 express.static 之前注册。） */
app.get('/gateway.json', (req, res) => {
  res.json({
    gateway: true,
    endpoint: '/api/5why/review',
    needKey: false,
    concurrency: QUEUE_CONFIG.concurrency,
    queueLimit: QUEUE_CONFIG.queueLimit,
    model: AI_CONFIG.model,
    configured: isAIConfigured(),
  });
});

app.use(express.static(path.join(__dirname, '..')));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* 判断错误是否属于「稍等一会儿就好」的类型，值得自动重试：
   1302 = 触发用户速率限制（并发超限）；1305 = 平台访问量过大；429 = Too Many Requests */
function isRetryableError(e) {
  const msg = String((e && e.message) || '');
  return /13(02|05)|429|Too Many Requests|rate limit|速率限制|访问量过大|稍后再试|overload/i.test(msg);
}

/* 调用真实 AI（OpenAI 兼容流式接口），onChunk 收到一段文本 */
async function callAIStream(apiMessages, onChunk) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QUEUE_CONFIG.jobTimeoutMs);
  try {
    const res = await fetch(AI_CONFIG.endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${AI_CONFIG.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model: AI_CONFIG.model,
        temperature: AI_CONFIG.temperature,
        thinking: AI_CONFIG.thinking,
        max_tokens: AI_CONFIG.maxTokens,
        stream: true,
        messages: apiMessages,
      }),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`AI 接口返回 ${res.status}: ${text.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (payload === '[DONE]') return;
        try {
          const json = JSON.parse(payload);
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) onChunk(delta);
        } catch { /* 忽略无法解析的行 */ }
      }
    }
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error(`处理超时（超过 ${QUEUE_CONFIG.jobTimeoutMs / 1000} 秒）`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/* 未配置真实 AI 时的模拟回复，便于先跑通全流程
   注意：格式必须与 promt.txt 的输出格式保持一致（2026-10-16 补上缺失的「评分」行，
   并给逐层点评补上（N/10）实际分数，否则前端评分卡与层得分徽章都不显示） */
function mockStream(onChunk) {
  const mock = '结论：基本合格\n评分：72\n漏洞数：1\n漏洞清单：\n1. 第3层·分析：**跳层**，未回答第2层提出的问题（建议：回到第2层的标准缺失继续追问）。\n逐层点评：\n第1层：问题与背景匹配（9/10）\n第2层：归因有事实支撑（8/10）\n第3层：与上一层**脱节**（4/10）\n方向纠偏：\n无\n修改建议：优先补第3层，针对"标准为何没被建立"继续追问后再提交审核。';
  return new Promise((resolve) => {
    let i = 0;
    const tick = setInterval(() => {
      if (i >= mock.length) { clearInterval(tick); resolve(); return; }
      onChunk(mock.slice(i, i + 12));
      i += 12;
    }, 40);
  });
}

/* ---------------------------------------------------------------------
 * 全局串行队列
 * ------------------------------------------------------------------- */
const queue = [];        // 等待中的任务（FIFO）
let activeCount = 0;     // 正在发给 AI 的任务数
let jobSeq = 0;
const DEBUG = !!process.env.AI_DEBUG;
const dlog = (...a) => { if (DEBUG) console.log('[queue]', ...a); };

/** 把当前排队情况广播给所有等待者，让他们看到自己的位置在往前挪。
    ahead = 排在我前面的请求数（含正在处理的那个），使用者看到的就是"前面还有几位"。 */
function broadcastQueue() {
  queue.forEach((job, i) => {
    job.send({ type: 'queued', ahead: i + activeCount, running: activeCount, total: queue.length + activeCount });
  });
}

function enqueue(job) {
  queue.push(job);
  dlog(`#${job.id} 入队，队列长度 ${queue.length}，处理中 ${activeCount}`);
  pump();            // 有空闲就立刻开工
  broadcastQueue();  // 再统一播报一次位置（含刚入队、还没轮到的人）
}

/** 只要还有并发额度且队列非空，就取出队首执行 */
function pump() {
  while (activeCount < QUEUE_CONFIG.concurrency && queue.length > 0) {
    const job = queue.shift();
    activeCount += 1;
    dlog(`#${job.id} 出队开始处理，处理中 ${activeCount}`);
    runJob(job).finally(() => {
      activeCount -= 1;
      dlog(`#${job.id} 结束，处理中 ${activeCount}，队列剩 ${queue.length}`);
      pump();
      broadcastQueue();
    });
  }
}

async function runJob(job) {
  const { send, end, apiMessages, isCancelled } = job;
  if (isCancelled()) { end(); return; }

  send({ type: 'start', concurrency: QUEUE_CONFIG.concurrency });

  for (let attempt = 0; ; attempt++) {
    try {
      if (!isAIConfigured()) {
        await mockStream((chunk) => { if (!isCancelled()) send({ type: 'chunk', content: chunk }); });
      } else {
        await callAIStream(apiMessages, (chunk) => { if (!isCancelled()) send({ type: 'chunk', content: chunk }); });
      }
      if (!isCancelled()) send({ type: 'done' });
      end(); // 必须结束响应，否则连接会一直挂着
      return;
    } catch (e) {
      const retryable = isRetryableError(e);
      if (!retryable || attempt >= QUEUE_CONFIG.maxRetries || isCancelled()) {
        send({ type: 'error', message: e.message || '未知错误' });
        end();
        return;
      }
      const waitMs = QUEUE_CONFIG.retryBaseMs * Math.pow(2, attempt);
      dlog(`#${job.id} 第 ${attempt + 1} 次重试，等待 ${waitMs}ms：${e.message}`);
      send({
        type: 'retry',
        attempt: attempt + 1,
        maxAttempts: QUEUE_CONFIG.maxRetries,
        waitMs,
        message: e.message,
      });
      await sleep(waitMs);
      if (isCancelled()) { end(); return; }
    }
  }
}

/* POST /api/5why/review
 * body: { messages: [{ role: "user" | "assistant", content: string }] }
 *        messages 为完整审核记录（最新的排最后），系统提示词自动取自 promt.txt
 * 返回: SSE 流，事件格式：
 *   data: {"type":"queued","ahead":2,"running":1,"total":3}   排队中，前面还有 ahead 位（含正在处理的）
 *   data: {"type":"start"}                                    开始处理
 *   data: {"type":"retry","attempt":1,"waitMs":3000}          被限流，等待后自动重试
 *   data: {"type":"chunk","content":"..."}                    逐段返回内容
 *   data: {"type":"done"}    或   data: {"type":"error","message":"..."}
 */
app.post('/api/5why/review', async (req, res) => {
  const messages = req.body && req.body.messages;

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: '缺少 messages 参数（审核记录）' });
  }

  if (queue.length >= QUEUE_CONFIG.queueLimit) {
    return res.status(503).json({
      error: `当前排队人数过多（${queue.length} 人等待中），请稍后再试。`,
    });
  }

  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // 反向代理下禁用缓冲，保证排队状态能实时到达
  res.flushHeaders?.();

  const send = (obj) => {
    if (res.writableEnded || res.destroyed) return;
    res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  const apiMessages = [
    { role: 'system', content: getSystemPrompt() },
    // 只保留用户提交内容（去掉问候语与历史 AI 回复），最多 6 条，省 token
    ...messages.filter((m) => m.role === 'user' || m.type).slice(-6),
  ];

  const job = {
    id: ++jobSeq,
    send,
    end: () => { if (!res.writableEnded) res.end(); },
    apiMessages,
    isCancelled: () => res.writableEnded || res.destroyed,
  };

  /* 使用者中途关掉页面/取消时，把它从队列里摘掉，别占着位置。
     注意必须监听 res 而不是 req：Node 16+ 里 req 的 'close' 在**请求体读完**
     就会触发（express.json() 一读完就触发），用它会把还在排队的请求误删。 */
  res.on('close', () => {
    if (res.writableEnded) return; // 正常结束，不需要清理
    const i = queue.indexOf(job);
    if (i >= 0) {
      queue.splice(i, 1);
      dlog(`#${job.id} 客户端已断开，从队列移除`);
      broadcastQueue();
    } else if (activeCount > 0) {
      dlog(`#${job.id} 处理中被客户端中断`);
    }
  });

  enqueue(job);
});

app.listen(PORT, () => {
  console.log('5Why 审核工具已启动: http://localhost:' + PORT);
  console.log('提示词来源: ' + PROMPT_FILE);
  console.log('AI 状态: ' + (isAIConfigured() ? `已配置（${AI_CONFIG.model}）` : '未配置（使用内置模拟回复）'));
  console.log(`排队策略: 并发上限 ${QUEUE_CONFIG.concurrency}，队列上限 ${QUEUE_CONFIG.queueLimit} 人，限流自动重试 ${QUEUE_CONFIG.maxRetries} 次`);
});
