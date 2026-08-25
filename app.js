(() => {
  const $ = (sel) => document.querySelector(sel);
  const chat = $('#chat');
  const bgInput = $('#in-background');
  const sendBtn = $('#btn-send');
  const listEl = $('#session-list');
  const layerIds = [1, 2, 3, 4, 5].map((n) => ({ q: $('#in-q' + n), a: $('#in-a' + n) }));

  const SESSIONS_KEY = '5why_check_sessions';
  const CONFIG_KEY = '5why_check_ai_config';
  const GREETING = '你好，我是 5Why 分析审核助手。\n\n请在表单中填写他人的 5Why 分析（第 1 层必填，最多 5 层），提交后我将逐层审核逻辑链，指出漏洞并给出修改建议。';
  const FALLBACK_PROMPT = '你是一位5Why分析审核专家，请审核用户提交的5Why分析链条是否存在逻辑漏洞，并给出修改建议。';

  /* 本地模式：通过本机 server.js 代理调用（读取 server.js 的 AI_CONFIG 与 promt.txt）
     部署模式（GitHub Pages 等静态托管）：浏览器直连大模型 API，Key 由各使用者自行填写 */
  const IS_PROXY = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);

  const DEFAULT_CONFIG = {
    endpoint: 'https://api.deepseek.com/chat/completions',
    apiKey: '',
    model: 'deepseek-v4-flash',
  };

  let sessions = [];
  let current = null;
  let busy = false;
  let pendingDeleteId = null;
  let cachedPrompt = null;

  /* ---------- 设置（部署模式下使用者自填 Key） ---------- */
  function loadConfig() {
    try {
      return Object.assign({}, DEFAULT_CONFIG, JSON.parse(localStorage.getItem(CONFIG_KEY)));
    } catch {
      return Object.assign({}, DEFAULT_CONFIG);
    }
  }

  function saveConfig(cfg) {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg));
  }

  function openSettings() {
    const cfg = loadConfig();
    $('#set-endpoint').value = cfg.endpoint;
    $('#set-key').value = cfg.apiKey;
    $('#set-model').value = cfg.model;
    $('#settings-hint').textContent = IS_PROXY
      ? '当前为本地模式：AI 调用走 server.js 代理（使用其中配置的 AI_CONFIG），以下设置仅部署模式生效。'
      : '请填写你自己的大模型 API Key（仅保存在本浏览器 localStorage，不会上传）。';
    $('#settings-modal').classList.remove('hidden');
  }

  function closeSettings() {
    const cfg = loadConfig();
    cfg.endpoint = $('#set-endpoint').value.trim() || DEFAULT_CONFIG.endpoint;
    cfg.apiKey = $('#set-key').value.trim();
    cfg.model = $('#set-model').value.trim() || DEFAULT_CONFIG.model;
    saveConfig(cfg);
    $('#settings-modal').classList.add('hidden');
  }

  /* ---------- 提示词（部署模式下从 promt.txt 加载） ---------- */
  async function getPrompt() {
    if (cachedPrompt !== null) return cachedPrompt;
    if (IS_PROXY) return ''; // 代理模式由服务端注入
    try {
      const res = await fetch('promt.txt');
      if (res.ok) {
        const text = await res.text();
        cachedPrompt = text.trim() || FALLBACK_PROMPT;
        return cachedPrompt;
      }
    } catch { /* 继续走兜底 */ }
    cachedPrompt = FALLBACK_PROMPT;
    return cachedPrompt;
  }

  /* ---------- 审核记录（localStorage 持久化） ---------- */
  function loadSessions() {
    try {
      sessions = JSON.parse(localStorage.getItem(SESSIONS_KEY)) || [];
    } catch {
      sessions = [];
    }
  }

  function persist() {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify(sessions));
  }

  function newSession() {
    const s = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      title: '新审核',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ role: 'assistant', content: GREETING }],
    };
    sessions.unshift(s);
    persist();
    switchSession(s.id);
  }

  function switchSession(id) {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    current = s;
    renderSessions();
    renderChat();
  }

  function deleteSession(id) {
    sessions = sessions.filter((s) => s.id !== id);
    persist();
    if (current && current.id === id) {
      current = null;
      if (sessions.length) switchSession(sessions[0].id);
      else newSession();
    } else {
      renderSessions();
    }
  }

  function touchSession() {
    if (!current) return;
    current.updatedAt = Date.now();
    if (current.title === '新审核') {
      const first = current.messages.find((m) => m.type === 'submission');
      if (first) {
        const titleSrc = first.background || (first.chain[0] && first.chain[0].q) || '';
        current.title = titleSrc.replace(/\s+/g, ' ').slice(0, 20);
        $('#session-title').textContent = current.title;
      }
    }
    persist();
    renderSessions();
  }

  function renderSessions() {
    listEl.innerHTML = '';
    if (!sessions.length) {
      const li = document.createElement('li');
      li.className = 'session-item';
      li.style.cursor = 'default';
      li.innerHTML = '<span class="s-title" style="color:#94a3b8">（暂无记录）</span>';
      listEl.appendChild(li);
      return;
    }
    sessions.forEach((s) => {
      const li = document.createElement('li');
      li.className = 'session-item' + (current && current.id === s.id ? ' active' : '');
      const t = document.createElement('span');
      t.className = 's-title';
      t.textContent = s.title;
      const time = document.createElement('span');
      time.className = 's-time';
      time.textContent = new Date(s.updatedAt).toLocaleString('zh-CN', {
        month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const del = document.createElement('button');
      del.className = 's-del';
      del.textContent = '×';
      del.title = '删除记录';
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        pendingDeleteId = s.id;
        $('#modal-text').textContent = `确定要删除「${s.title}」吗？`;
        $('#confirm-modal').classList.remove('hidden');
      });
      li.appendChild(t);
      li.appendChild(time);
      li.appendChild(del);
      li.addEventListener('click', () => switchSession(s.id));
      listEl.appendChild(li);
    });
  }

  /* ---------- 消息渲染 ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  /* 用户提交内容：结构化的 5Why 链条卡片 */
  function renderSubmission(m, wrap) {
    const card = document.createElement('div');
    card.className = 'submission';

    if (m.background) {
      const bg = document.createElement('div');
      bg.className = 'sub-bg';
      const bgLabel = document.createElement('div');
      bgLabel.className = 'sub-label';
      bgLabel.textContent = '问题背景';
      const bgText = document.createElement('div');
      bgText.className = 'sub-text';
      bgText.textContent = m.background;
      bg.appendChild(bgLabel);
      bg.appendChild(bgText);
      card.appendChild(bg);
    }

    const chain = document.createElement('div');
    chain.className = 'sub-chain';
    m.chain.forEach((step, i) => {
      const row = document.createElement('div');
      row.className = 'sub-step';
      const no = document.createElement('div');
      no.className = 'sub-step-no';
      no.textContent = i + 1;
      const body = document.createElement('div');
      body.className = 'sub-step-body';
      const qLabel = document.createElement('div');
      qLabel.className = 'sub-q-label';
      qLabel.textContent = '为什么';
      const q = document.createElement('div');
      q.className = 'sub-q';
      q.textContent = step.q;
      const aLabel = document.createElement('div');
      aLabel.className = 'sub-a-label';
      aLabel.textContent = '分析 / 解答';
      const a = document.createElement('div');
      a.className = 'sub-a';
      a.textContent = step.a;
      body.appendChild(qLabel);
      body.appendChild(q);
      body.appendChild(aLabel);
      body.appendChild(a);
      row.appendChild(no);
      row.appendChild(body);
      chain.appendChild(row);
    });
    card.appendChild(chain);
    wrap.appendChild(card);
  }

  /* 将 AI 回复中的"结论/漏洞数"渲染为突出卡片，结论按合格程度着色 */
  function formatAI(text) {
    const lines = esc(String(text)).split('\n').map((line) => {
      let m = line.match(/^(结论)[：:](.*)$/);
      if (m) {
        const rest = m[2];
        let cls = '';
        if (/不合格/.test(rest)) cls = 'err';
        else if (/基本/.test(rest)) cls = 'warn';
        else if (/合格/.test(rest)) cls = 'ok';
        return `<span class="judge-line conclusion ${cls}"><b class="jl">结论：</b>${rest}</span>`;
      }
      m = line.match(/^(漏洞数)[：:](.*)$/);
      if (m) {
        const n = parseInt(m[2], 10);
        const cls = isNaN(n) || n === 0 ? 'ok' : 'warn';
        return `<span class="judge-line conclusion ${cls}"><b class="jl">漏洞数：</b>${m[2]}</span>`;
      }
      return line;
    });
    /* 去掉紧邻卡片前后的空行；卡片边界不输出换行符，避免 pre-wrap 额外渲染空行高 */
    const isCard = (l) => l && l.indexOf('<span class="judge-line') === 0;
    const kept = lines.filter((line, i) => {
      if (line.trim() !== '') return true;
      return !(isCard(lines[i - 1]) || isCard(lines[i + 1]));
    });
    return kept.map((line, i) => {
      if (i === 0) return line;
      const prevIsCard = isCard(kept[i - 1]);
      const curIsCard = isCard(line);
      return prevIsCard || curIsCard ? line : '\n' + line;
    }).join('');
  }

  function renderMessage(m) {
    const wrap = document.createElement('div');
    wrap.className = 'msg ' + m.role;
    const av = document.createElement('div');
    av.className = 'avatar ' + m.role;
    av.textContent = m.role === 'user' ? '我' : 'AI';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const label = document.createElement('div');
    label.className = 'bubble-label';
    label.textContent = m.role === 'user' ? '我' : 'AI';
    bubble.appendChild(label);
    if (m.type === 'submission') {
      renderSubmission(m, bubble);
    } else {
      const p = document.createElement('p');
      if (m.role === 'assistant') p.innerHTML = formatAI(m.content);
      else p.textContent = m.content;
      bubble.appendChild(p);
    }
    wrap.appendChild(av);
    wrap.appendChild(bubble);
    chat.appendChild(wrap);
  }

  function renderChat() {
    chat.innerHTML = '';
    if (!current) return;
    current.messages.forEach(renderMessage);
    scrollToBottom();
  }

  function scrollToBottom() {
    chat.scrollTop = chat.scrollHeight;
  }

  function setInputEnabled(enabled) {
    busy = !enabled;
    bgInput.disabled = !enabled;
    layerIds.forEach(({ q, a }) => { q.disabled = !enabled; a.disabled = !enabled; });
    sendBtn.disabled = !enabled;
    sendBtn.innerHTML = enabled
      ? '<svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z"/></svg>提交审核'
      : 'AI 审核中...';
  }

  /* ---------- AI 接口调用 ----------
     统一解析两种 SSE 格式：
       - 本地代理：data: {"type":"chunk","content":"..."}
       - 部署模式（OpenAI 兼容原生流）：data: {"choices":[{"delta":{"content":"..."}}]} */
  async function streamReply(messages, onChunk) {
    let res;
    if (IS_PROXY) {
      res = await fetch('/api/5why/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages }),
      });
    } else {
      const cfg = loadConfig();
      if (!cfg.apiKey) throw new Error('尚未配置 API Key，请点击右上角「设置」填写。');
      const prompt = await getPrompt();
      res = await fetch(cfg.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + cfg.apiKey },
        body: JSON.stringify({
          model: cfg.model,
          temperature: 0.3,
          stream: true,
          messages: [{ role: 'system', content: prompt }, ...messages.slice(-30)],
        }),
      });
    }
    if (!res.ok) {
      let detail = '';
      try {
        const err = await res.json();
        detail = (err.error && (err.error.message || err.error)) || '';
      } catch { /* ignore */ }
      throw new Error(detail || ('请求失败 (HTTP ' + res.status + ')'));
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let error = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const payload = line.slice(6).trim();
        if (payload === '[DONE]') continue;
        try {
          const msg = JSON.parse(payload);
          if (msg.type === 'chunk') onChunk(msg.content);
          else if (msg.type === 'error') error = new Error(msg.message);
          else if (msg.type === 'done') return error;
          else if (msg.choices) {
            const delta = msg.choices[0] && msg.choices[0].delta;
            if (delta && delta.content) onChunk(delta.content);
          }
        } catch { /* 忽略无法解析的行 */ }
      }
    }
    return error;
  }

  /* ---------- 表单收集与校验 ---------- */
  function collectSubmission() {
    const background = bgInput.value.trim();
    const chain = [];
    for (let i = 0; i < layerIds.length; i++) {
      const q = layerIds[i].q.value.trim();
      const a = layerIds[i].a.value.trim();
      if (i === 0) {
        if (!q) return { error: '请填写第 1 层的「为什么」。' };
        if (!a) return { error: '请填写第 1 层的「分析 / 解答」。' };
        chain.push({ q, a });
      } else if (q || a) {
        if (!q) return { error: `第 ${i + 1} 层只填了分析，请补充对应的「为什么」。` };
        if (!a) return { error: `第 ${i + 1} 层只填了为什么，请补充对应的「分析 / 解答」。` };
        chain.push({ q, a });
      }
    }
    return { background, chain };
  }

  function submissionToText(background, chain) {
    let text = background ? `【问题背景】\n${background}\n\n` : '';
    chain.forEach((step, i) => {
      text += `【第 ${i + 1} 层】\n问题：${step.q}\n分析：${step.a}\n\n`;
    });
    return text.trim();
  }

  async function onSubmit() {
    if (busy || !current) return;
    const errEl = $('#form-error');
    errEl.classList.add('hidden');

    const data = collectSubmission();
    if (data.error) {
      errEl.textContent = data.error;
      errEl.classList.remove('hidden');
      return;
    }

    if (!IS_PROXY) {
      const cfg = loadConfig();
      if (!cfg.apiKey) {
        openSettings();
        return;
      }
    }

    const msg = {
      role: 'user',
      type: 'submission',
      background: data.background,
      chain: data.chain,
      content: submissionToText(data.background, data.chain),
    };
    current.messages.push(msg);
    bgInput.value = '';
    layerIds.forEach(({ q, a }) => { q.value = ''; a.value = ''; });
    renderChat();
    touchSession();

    setInputEnabled(false);

    const wrap = document.createElement('div');
    wrap.className = 'msg ai';
    const av = document.createElement('div');
    av.className = 'avatar ai';
    av.textContent = 'AI';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    const label = document.createElement('div');
    label.className = 'bubble-label';
    label.textContent = 'AI';
    const p = document.createElement('p');
    p.textContent = '';
    bubble.appendChild(label);
    bubble.appendChild(p);
    wrap.appendChild(av);
    wrap.appendChild(bubble);
    chat.appendChild(wrap);

    const typing = document.createElement('span');
    typing.className = 'typing';
    typing.innerHTML = '<i></i><i></i><i></i>';
    p.appendChild(typing);
    scrollToBottom();

    let full = '';
    try {
      const err = await streamReply(current.messages, (chunk) => {
        if (typing.parentNode) typing.remove();
        full += chunk;
        p.innerHTML = formatAI(full);
        scrollToBottom();
      });
      if (err) throw err;
    } catch (e) {
      if (typing.parentNode) typing.remove();
      const errPanel = document.createElement('div');
      errPanel.className = 'error-panel';
      errPanel.textContent = 'AI 审核失败：' + (e.message || '未知错误') + '，请重试。';
      p.textContent = '';
      bubble.appendChild(errPanel);
      full = '';
    }

    if (full) {
      current.messages.push({ role: 'assistant', content: full });
      touchSession();
    }
    setInputEnabled(true);
  }

  /* ---------- 导出 Markdown 报告 ---------- */
  function exportReport() {
    if (!current || !current.messages.length) return;
    let md = `# 5Why 分析审核报告\n\n> 🔍 AI 辅助审核 | 制造业一线管理者专用\n\n`;
    md += `**审核时间**: ${new Date(current.updatedAt).toLocaleString('zh-CN')}\n\n---\n\n`;
    current.messages.forEach((m) => {
      const who = m.role === 'user' ? '**提交的 5Why 分析**' : '**AI 审核意见**';
      md += `### ${who}\n${m.content}\n\n---\n\n`;
    });
    const blob = new Blob([md], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `5why-review-${Date.now()}.md`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  /* ---------- 事件绑定 ---------- */
  $('#btn-new-chat').addEventListener('click', newSession);
  $('#btn-send').addEventListener('click', onSubmit);
  $('#btn-settings').addEventListener('click', openSettings);
  $('#btn-settings-save').addEventListener('click', closeSettings);
  $('#btn-settings-cancel').addEventListener('click', () => $('#settings-modal').classList.add('hidden'));
  const autoResize = (el) => {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 72) + 'px';
  };
  [bgInput, ...layerIds.map((l) => l.q), ...layerIds.map((l) => l.a)].forEach((el) => {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    });
    el.addEventListener('input', () => autoResize(el));
  });
  $('#btn-export').addEventListener('click', exportReport);
  $('#btn-clear').addEventListener('click', () => {
    if (!current) return;
    current.messages = [{ role: 'assistant', content: GREETING }];
    current.title = '新审核';
    touchSession();
    renderChat();
    bgInput.focus();
  });
  $('#btn-confirm-no').addEventListener('click', () => $('#confirm-modal').classList.add('hidden'));
  $('#btn-confirm-yes').addEventListener('click', () => {
    $('#confirm-modal').classList.add('hidden');
    if (pendingDeleteId) deleteSession(pendingDeleteId);
    pendingDeleteId = null;
  });

  /* ---------- 初始化 ---------- */
  loadSessions();
  if (sessions.length) {
    current = sessions[0];
  } else {
    const s = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
      title: '新审核',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [{ role: 'assistant', content: GREETING }],
    };
    sessions.unshift(s);
    persist();
    current = s;
  }
  renderSessions();
  renderChat();
  bgInput.focus();
})();
