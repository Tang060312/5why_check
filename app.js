(() => {
  const $ = (sel) => document.querySelector(sel);
  const chat = $('#chat');
  const bgInput = $('#in-background');
  const summaryEl = $('#in-summary');
  const sendBtn = $('#btn-send');
  const listEl = $('#session-list');
  const chainEl = $('#chain-fields');
  const addBtn = $('#btn-add-layer');
  const MAX_LAYERS = 10;

  const SESSIONS_KEY = '5why_check_sessions';
  const CONFIG_KEY = '5why_check_ai_config';
  const GREETING = '你好，我是 5Why 分析审核助手。\n\n请在表单中填写他人的 5Why 分析：第 1 层必填，点击「＋ 添加下一层」可继续扩充（最多 10 层），问题背景可选，问题总结必填。提交后我将逐层审核逻辑链，指出漏洞并给出修改建议。';
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
        const titleSrc = first.background || (first.chain[0] && first.chain[0].q) || first.summary || '';
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

    if (m.summary) {
      const sum = document.createElement('div');
      sum.className = 'sub-bg';
      const sumLabel = document.createElement('div');
      sumLabel.className = 'sub-label';
      sumLabel.textContent = '问题总结';
      const sumText = document.createElement('div');
      sumText.className = 'sub-text';
      sumText.textContent = m.summary;
      sum.appendChild(sumLabel);
      sum.appendChild(sumText);
      card.appendChild(sum);
    }

    wrap.appendChild(card);
  }

  /* 将 AI 回复渲染为突出卡片：结论/评分/漏洞数着色，漏洞清单条目高亮，
     问题词句（AI 用 **加粗** 标注）转换为高亮标记，逐层点评附（N/10）得分徽章 */
  function formatAI(text) {
    const lines = esc(String(text)).split('\n');
    let inIssues = false;
    let inLayers = false;
    const mapped = lines.map((raw) => {
      let line = raw;
      if (/^(漏洞清单|漏洞列表|漏洞)[：:]/.test(raw)) { inIssues = true; inLayers = false; }
      else if (/^(逐层点评|逐层审核)[：:]/.test(raw)) { inIssues = false; inLayers = true; }
      else if (/^(修改建议|改进建议|结论|漏洞数|评分|得分)[：:]/.test(raw)) { inIssues = false; inLayers = false; }
      let m = line.match(/^(结论)[：:](.*)$/);
      if (m) {
        const rest = m[2];
        let cls = '';
        if (/不合格/.test(rest)) cls = 'err';
        else if (/基本/.test(rest)) cls = 'warn';
        else if (/合格/.test(rest)) cls = 'ok';
        line = `<span class="judge-line conclusion ${cls}"><b class="jl">结论：</b>${rest}</span>`;
      } else {
        m = line.match(/^(评分|得分)[：:]\s*(\d{1,3})/);
        if (m) {
          const s = Math.min(100, Math.max(0, parseInt(m[2], 10)));
          const cls = s >= 85 ? 'ok' : (s >= 60 ? 'warn' : 'err');
          line = `<span class="score-card ${cls}"><span class="score-num">${s}</span><span class="score-label">分</span><span class="score-bar"><i style="width:${s}%"></i></span></span>`;
        } else {
          m = line.match(/^(漏洞数)[：:](.*)$/);
          if (m) {
            const n = parseInt(m[2], 10);
            const cls = isNaN(n) || n === 0 ? 'ok' : 'warn';
            line = `<span class="judge-line conclusion ${cls}"><b class="jl">漏洞数：</b>${m[2]}</span>`;
          }
        }
      }
      if (inLayers) {
        line = line.replace(/（\s*(\d{1,2})\s*\/\s*10\s*）/g, (_mm, n) => {
          const v = parseInt(n, 10);
          const cls = v >= 8 ? 'ok' : (v >= 6 ? 'warn' : 'err');
          return `<span class="layer-score ${cls}">${v}/10</span>`;
        });
      }
      if (inIssues && line.indexOf('<span') !== 0 && /^\s*\d+[.、]/.test(line)) {
        line = `<span class="issue-line">${line}</span>`;
      }
      line = line.replace(/\*\*(.+?)\*\*/g, '<mark>$1</mark>');
      return line;
    });
    /* 去掉紧邻卡片前后的空行；卡片边界不输出换行符，避免 pre-wrap 额外渲染空行高 */
    const isCard = (l) => l && (l.indexOf('<span class="judge-line') === 0 || l.indexOf('<span class="issue-line') === 0 || l.indexOf('<span class="score-card') === 0);
    const kept = mapped.filter((line, i) => {
      if (line.trim() !== '') return true;
      return !(isCard(mapped[i - 1]) || isCard(mapped[i + 1]));
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
    applyInputVisibility();
    scrollToBottom();
  }

  /* 每条记录只分析一个问题：提交过即隐藏输入区，聊天区占满 */
  function applyInputVisibility() {
    const hasSubmission = !!(current && current.messages.some((m) => m.type === 'submission'));
    document.querySelector('.main').classList.toggle('no-input', hasSubmission);
  }

  function scrollToBottom() {
    chat.scrollTop = chat.scrollHeight;
  }

  /* ---------- 动态层管理 ---------- */
  function bindInput(el) {
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSubmit();
      }
    });
    el.addEventListener('input', () => autoResize(el));
  }

  function getLayers() {
    return Array.from(chainEl.querySelectorAll('.layer-row')).map((row) => ({
      row,
      q: row.querySelector('.layer-q'),
      a: row.querySelector('.layer-a'),
    }));
  }

  function buildLayerRow(n) {
    const row = document.createElement('div');
    row.className = 'layer-row';
    const tag = document.createElement('div');
    tag.className = 'layer-tag';
    tag.textContent = '第 ' + n + ' 层';
    const qField = document.createElement('div');
    qField.className = 'qa-field';
    const qLabel = document.createElement('div');
    qLabel.className = 'qa-label layer-q-label';
    qLabel.innerHTML = '为什么？' + (n === 1 ? ' <em>必填</em>' : ' <em>可选</em>');
    const q = document.createElement('textarea');
    q.className = 'layer-q';
    q.rows = 1;
    q.placeholder = n === 1 ? '第一层提出的为什么问题' : '基于上一层分析继续追问';
    qField.appendChild(qLabel);
    qField.appendChild(q);
    const aField = document.createElement('div');
    aField.className = 'qa-field';
    const aLabel = document.createElement('div');
    aLabel.className = 'qa-label';
    aLabel.innerHTML = '分析 / 解答' + (n === 1 ? ' <em>必填</em>' : ' <em>可选</em>');
    const a = document.createElement('textarea');
    a.className = 'layer-a';
    a.rows = 1;
    a.placeholder = n === 1 ? '对这一层问题的解答、原因分析' : '对这一层问题的解答';
    aField.appendChild(aLabel);
    aField.appendChild(a);
    row.appendChild(tag);
    row.appendChild(qField);
    row.appendChild(aField);
    if (n > 1) {
      const del = document.createElement('button');
      del.className = 'layer-del';
      del.textContent = '×';
      del.title = '删除该层';
      del.addEventListener('click', () => {
        row.remove();
        updateLayerState();
      });
      row.appendChild(del);
    }
    bindInput(q);
    bindInput(a);
    return row;
  }

  function updateLayerState() {
    getLayers().forEach(({ row }, i) => {
      const n = i + 1;
      row.querySelector('.layer-tag').textContent = '第 ' + n + ' 层';
      row.querySelector('.layer-q-label').innerHTML = '为什么？' + (n === 1 ? ' <em>必填</em>' : ' <em>可选</em>');
    });
    const count = getLayers().length;
    addBtn.classList.toggle('hidden', count >= MAX_LAYERS);
  }

  function setInputEnabled(enabled) {
    busy = !enabled;
    bgInput.disabled = !enabled;
    summaryEl.disabled = !enabled;
    getLayers().forEach(({ q, a }) => { q.disabled = !enabled; a.disabled = !enabled; });
    addBtn.disabled = !enabled;
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
          thinking: 'low',
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
    const summary = summaryEl.value.trim();
    if (!summary) return { error: '请填写「问题总结」。' };
    const chain = [];
    const layers = getLayers();
    for (let i = 0; i < layers.length; i++) {
      const q = layers[i].q.value.trim();
      const a = layers[i].a.value.trim();
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
    return { background, chain, summary };
  }

  function submissionToText(background, chain, summary) {
    let text = background ? `【问题背景】\n${background}\n\n` : '';
    chain.forEach((step, i) => {
      text += `【第 ${i + 1} 层】\n问题：${step.q}\n分析：${step.a}\n\n`;
    });
    if (summary) text += `【总结】\n${summary}\n`;
    return text.trim();
  }

  async function onSubmit() {
    if (busy || !current) return;
    const errEl = $('#form-error');
    errEl.className = 'error-panel hidden';

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
      summary: data.summary || '',
      content: submissionToText(data.background, data.chain, data.summary),
    };
    current.messages.push(msg);
    bgInput.value = '';
    summaryEl.value = '';
    getLayers().forEach(({ q, a }) => { q.value = ''; a.value = ''; });
    chainEl.innerHTML = '';
    chainEl.appendChild(buildLayerRow(1));
    updateLayerState();
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
      const isNetErr = e instanceof TypeError;
      const hint = IS_PROXY
        ? '本地服务连接中断（请确认 server.js 仍在运行）。'
        : '无法访问 AI 服务，可能原因：网络/代理无法连通接口地址、接口不支持浏览器跨域（CORS）。建议改用本地模式（localhost:3001 运行 server.js）。';
      errPanel.textContent = 'AI 审核失败：' + (isNetErr ? '网络连接失败（' + hint + '）' : e.message || '未知错误') + '，请重试。';
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

  /* ---------- 表格模板 / 上传解析 ---------- */
  function showFormMsg(text, cls) {
    const el = $('#form-error');
    el.textContent = text;
    el.className = 'error-panel' + (cls ? ' ' + cls : '');
  }

  function downloadTemplate() {
    if (typeof XLSX === 'undefined') {
      showFormMsg('表格组件未加载，请刷新页面后重试。');
      return;
    }
    const aoa = [
      ['字段', '问题（为什么）', '分析 / 解答'],
      ['问题背景', '示例：今天 A 产线良品率下降 5%（可选，建议填写）', ''],
      ['第1层', '为什么良品率下降？', '因为操作员操作不规范'],
      ['第2层', '为什么操作不规范？', '因为没有标准化作业指导书'],
      ['第3层', '（留空即可忽略）', ''],
      ['第4层', '', ''],
      ['第5层', '', ''],
      ['第6层', '', ''],
      ['第7层', '', ''],
      ['第8层', '', ''],
      ['第9层', '', ''],
      ['第10层', '', ''],
      ['问题总结', '示例：根本原因是缺少标准化作业指导书（必填）', ''],
    ];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 12 }, { wch: 40 }, { wch: 40 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '5Why审核');
    XLSX.writeFile(wb, '5why-审核模板.xlsx');
  }

  /* 识别规则：第一列为字段标签；含"背景"→问题背景，含"总结"→问题总结，
     匹配"第N层"（或纯数字）→ 该层问题(第2列)/分析(第3列)；其余行忽略 */
  function parseRows(rows) {
    const out = { background: '', layers: [], summary: '' };
    rows.forEach((row) => {
      if (!Array.isArray(row)) return;
      const cells = row.map((c) => String(c == null ? '' : c).trim());
      const label = cells.find((c) => c !== '') || '';
      if (!label) return;
      const rest = cells.slice(cells.indexOf(label) + 1).filter(Boolean);
      const text = rest.join(' ');
      if (/背景/.test(label)) {
        if (text) out.background = text;
        return;
      }
      if (/总结/.test(label)) {
        if (text) out.summary = text;
        return;
      }
      const m = label.match(/^\s*第?\s*(\d+)\s*层?\s*$/);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n < 1 || n > MAX_LAYERS) return;
        const q = rest[0] || '';
        const a = rest[1] || '';
        if (q || a) out.layers.push({ n, q, a });
      }
    });
    out.layers.sort((x, y) => x.n - y.n);
    return out;
  }

  function fillForm(parsed) {
    chainEl.innerHTML = '';
    const count = Math.max(1, parsed.layers.length);
    for (let i = 0; i < count; i++) {
      chainEl.appendChild(buildLayerRow(i === 0 ? 1 : 2));
    }
    updateLayerState();
    const layers = getLayers();
    parsed.layers.forEach((l, i) => {
      if (i >= layers.length) return;
      layers[i].q.value = l.q;
      layers[i].a.value = l.a;
      autoResize(layers[i].q);
      autoResize(layers[i].a);
    });
    bgInput.value = parsed.background;
    autoResize(bgInput);
    summaryEl.value = parsed.summary;
    autoResize(summaryEl);
  }

  async function onUpload(file) {
    if (typeof XLSX === 'undefined') {
      showFormMsg('表格组件未加载，请刷新页面后重试。');
      return;
    }
    try {
      let data;
      if (/\.csv$/i.test(file.name)) {
        const buf = await file.arrayBuffer();
        let str = new TextDecoder('utf-8').decode(buf);
        if (str.includes('\uFFFD')) str = new TextDecoder('gbk').decode(buf);
        data = XLSX.read(str, { type: 'string' });
      } else {
        data = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      }
      const ws = data.Sheets[data.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const parsed = parseRows(rows);
      if (!parsed.layers.length) {
        showFormMsg('未识别到有效的「第 N 层」行，请使用「下载模板」的格式填写。');
        return;
      }
      if (!parsed.summary) {
        showFormMsg('已识别 ' + parsed.layers.length + ' 层（背景' + (parsed.background ? '有' : '无') + '），但未找到「问题总结」，提交前请补充。', 'warn');
      } else {
        showFormMsg('识别成功：背景' + (parsed.background ? '有' : '无') + '，' + parsed.layers.length + ' 层，总结有。请确认后提交审核。', 'success');
      }
      if (current && current.messages.some((m) => m.type === 'submission')) newSession();
      fillForm(parsed);
    } catch (e) {
      showFormMsg('表格解析失败：' + (e.message || '未知错误') + '，请检查文件是否损坏。');
    }
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
    el.style.height = Math.min(el.scrollHeight, 96) + 'px';
  };
  [bgInput, summaryEl].forEach(bindInput);
  addBtn.addEventListener('click', () => {
    const count = getLayers().length;
    if (count >= MAX_LAYERS) return;
    chainEl.appendChild(buildLayerRow(count + 1));
    updateLayerState();
    getLayers()[count].q.focus();
  });
  $('#btn-export').addEventListener('click', exportReport);
  $('#btn-template').addEventListener('click', downloadTemplate);
  $('#btn-upload').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) onUpload(f);
    e.target.value = '';
  });
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
  chainEl.appendChild(buildLayerRow(1));
  updateLayerState();
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
