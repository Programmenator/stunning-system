const chatEl = document.getElementById('chat');
const composer = document.getElementById('composer');
const promptEl = document.getElementById('prompt');
const statusEl = document.getElementById('status');
const newChatBtn = document.getElementById('newChatBtn');
const clearVramBtn = document.getElementById('clearVramBtn');
const openSettingsBtn = document.getElementById('openSettingsBtn');
const settingsDialog = document.getElementById('settingsDialog');
const settingsForm = document.getElementById('settingsForm');
const closeSettingsBtn = document.getElementById('closeSettingsBtn');
const gpuMonitorEl = document.getElementById('gpuMonitor');
const tokenMonitorEl = document.getElementById('tokenMonitor');
const documentUploadEl = document.getElementById('documentUpload');
const documentSummaryEl = document.getElementById('documentSummary');
const template = document.getElementById('messageTemplate');

const settings = {
  ollamaUrl: document.getElementById('ollamaUrl'),
  model: document.getElementById('model'),
  searxngUrl: document.getElementById('searxngUrl'),
  fileSearchPath: document.getElementById('fileSearchPath'),
  enableFileSearch: document.getElementById('enableFileSearch'),
  enableWebSearch: document.getElementById('enableWebSearch'),
  mainContextWindow: document.getElementById('mainContextWindow')
};

const paramInputs = {
  temperature: document.getElementById('temperature'),
  topP: document.getElementById('topP'),
  topK: document.getElementById('topK'),
  repeatPenalty: document.getElementById('repeatPenalty'),
  numPredict: document.getElementById('numPredict'),
  rerankerModel: document.getElementById('rerankerModel'),
  fullContextToggle: document.getElementById('fullContextToggle')
};

let messages = [];
let activeModel = settings.model.value.trim();
let gpuMonitorTimer = null;

const tokenStats = {
  responses: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  last: null
};

const sessionParams = {
  temperature: Number(paramInputs.temperature.value),
  top_p: Number(paramInputs.topP.value),
  top_k: Number(paramInputs.topK.value),
  repeat_penalty: Number(paramInputs.repeatPenalty.value),
  num_predict: Number(paramInputs.numPredict.value)
};

const sessionTools = {
  rerankerModel: '',
  fullContext: false
};

let uploadedDocuments = [];


async function readUploadedDocuments(fileList) {
  const files = Array.from(fileList || []).slice(0, 8);
  const docs = [];
  for (const file of files) {
    const text = await file.text();
    docs.push({ name: file.name, content: text });
  }
  return docs;
}

function renderDocumentSummary() {
  if (!uploadedDocuments.length) {
    documentSummaryEl.textContent = 'No documents attached.';
    return;
  }

  const totalChars = uploadedDocuments.reduce((sum, d) => sum + (d.content?.length || 0), 0);
  documentSummaryEl.textContent = `Attached ${uploadedDocuments.length} document(s), ${totalChars} chars total.`;
}

function setStatus(text) {
  statusEl.textContent = text;
}

function addMessage(role, content) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.classList.add(role);
  node.querySelector('.message').textContent = content;
  chatEl.appendChild(node);
  chatEl.scrollTop = chatEl.scrollHeight;
  return node;
}

function getContextWindow() {
  return Number(settings.mainContextWindow.value || 8192);
}

function renderTokenMonitor() {
  if (!tokenStats.responses) {
    tokenMonitorEl.textContent = 'No generations yet.';
    return;
  }

  const last = tokenStats.last || {};
  tokenMonitorEl.innerHTML = `
    <div class="gpu-row">
      <div><strong>Last response</strong></div>
      <div>Prompt: ${last.promptTokens ?? 0} tok</div>
      <div>Completion: ${last.completionTokens ?? 0} tok</div>
      <div>Total: ${last.totalTokens ?? 0} tok</div>
      <div>Gen throughput: ${last.completionTokensPerSecond ?? 'n/a'} tok/s</div>
    </div>
    <div class="gpu-row">
      <div><strong>Session totals</strong></div>
      <div>Responses: ${tokenStats.responses}</div>
      <div>Prompt tokens: ${tokenStats.promptTokens}</div>
      <div>Completion tokens: ${tokenStats.completionTokens}</div>
      <div>Total tokens: ${tokenStats.totalTokens}</div>
    </div>
  `;
}

function trackTokenMetrics(metrics) {
  if (!metrics) return;
  tokenStats.responses += 1;
  tokenStats.promptTokens += Number(metrics.promptTokens || 0);
  tokenStats.completionTokens += Number(metrics.completionTokens || 0);
  tokenStats.totalTokens += Number(metrics.totalTokens || 0);
  tokenStats.last = metrics;
  renderTokenMonitor();
renderDocumentSummary();
}

function addAssistantToolInfo(toolUsage) {
  const parts = [];
  if (toolUsage?.fileResults?.length) {
    parts.push(`Files:\n${toolUsage.fileResults.map((f) => `- ${f.path}`).join('\n')}`);
  }
  if (toolUsage?.webResults?.length) {
    parts.push(`Web:\n${toolUsage.webResults.map((r) => `- ${r.title} (${r.url})`).join('\n')}`);
  }
  if (toolUsage?.reranker) {
    const rr = toolUsage.reranker;
    parts.push(
      `Reranker: ${rr.model} (${rr.applied ? 'applied' : 'not applied'})${
        rr.summary ? `\n- ${rr.summary}` : rr.reason ? `\n- ${rr.reason}` : ''
      }`
    );
  }

  if (parts.length) {
    addMessage('system', `Tool context used:\n\n${parts.join('\n\n')}`);
  }
}

function formatTrace(trace) {
  return JSON.stringify(trace, null, 2);
}

function addTracePanel(assistantRow, trace) {
  if (!assistantRow || !trace) return;
  const details = document.createElement('details');
  details.className = 'trace-details';
  details.innerHTML = `
    <summary>Model reasoning trace (main + reranker + sources)</summary>
    <pre>${formatTrace(trace)}</pre>
  `;
  assistantRow.appendChild(details);
}

function collectSessionParameters() {
  return {
    temperature: Number(paramInputs.temperature.value),
    top_p: Number(paramInputs.topP.value),
    top_k: Number(paramInputs.topK.value),
    repeat_penalty: Number(paramInputs.repeatPenalty.value),
    num_predict: Number(paramInputs.numPredict.value)
  };
}

async function loadRerankerModels() {
  try {
    const url = new URL('/api/models', window.location.origin);
    url.searchParams.set('ollamaUrl', settings.ollamaUrl.value);
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Failed loading models (${response.status})`);
    const data = await response.json();
    const models = data.models || [];

    const select = paramInputs.rerankerModel;
    const current = sessionTools.rerankerModel;
    select.innerHTML = '<option value="">None (disabled)</option>' + models.map((m) => `<option value="${m}">${m}</option>`).join('');

    if (current && models.includes(current)) {
      select.value = current;
    }
  } catch (error) {
    setStatus(`Model list error: ${error.message}`);
  }
}

async function refreshGpuMonitor() {
  try {
    const response = await fetch('/api/gpu/status');
    if (!response.ok) throw new Error(`GPU monitor unavailable (${response.status})`);

    const data = await response.json();
    const gpus = data.gpus || [];
    if (!gpus.length) {
      gpuMonitorEl.textContent = 'No GPUs reported.';
      return;
    }

    gpuMonitorEl.innerHTML = gpus
      .map((gpu) => {
        const pct = gpu.totalMB > 0 ? Math.round((gpu.usedMB / gpu.totalMB) * 100) : 0;
        return `<div class="gpu-row">
          <div>GPU ${gpu.index}: ${gpu.name}</div>
          <div>${gpu.usedMB}MB / ${gpu.totalMB}MB (${pct}%)</div>
          <div class="bar"><span style="width:${pct}%"></span></div>
        </div>`;
      })
      .join('');
  } catch (error) {
    gpuMonitorEl.textContent = `GPU monitor error: ${error.message}`;
  }
}

async function ensureModelSwapIfNeeded() {
  const selectedModel = settings.model.value.trim();
  if (!selectedModel) throw new Error('Model is required');
  if (selectedModel === activeModel) return true;

  const clearPrevious = window.confirm(
    `You changed model from "${activeModel}" to "${selectedModel}".\n\nDo you want to clear VRAM from the previous model before loading the new one?`
  );

  setStatus('Checking VRAM and switching model...');

  const response = await fetch('/api/model/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ollamaUrl: settings.ollamaUrl.value,
      currentModel: activeModel,
      newModel: selectedModel,
      clearPrevious,
      contextWindow: getContextWindow()
    })
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok || !data.loaded) {
    if (data.reason === 'insufficient_vram') {
      window.alert(`Not enough VRAM to load ${selectedModel} alongside existing model/context.\n\n${data.message}`);
      setStatus('Insufficient VRAM; model not loaded');
      settings.model.value = activeModel;
      await refreshGpuMonitor();
      return false;
    }
    throw new Error(data.error || data.message || `Failed model swap (${response.status})`);
  }

  activeModel = selectedModel;
  window.alert(`Model ${selectedModel} loaded successfully.`);
  await refreshGpuMonitor();
  setStatus('Model ready');
  return true;
}

async function sendChat() {
  const prompt = promptEl.value.trim();
  if (!prompt) return;

  const modelReady = await ensureModelSwapIfNeeded();
  if (!modelReady) return;

  messages.push({ role: 'user', content: prompt });
  addMessage('user', prompt);
  promptEl.value = '';
  setStatus('Thinking...');

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages,
        model: settings.model.value,
        ollamaUrl: settings.ollamaUrl.value,
        searxngUrl: settings.searxngUrl.value,
        fileSearchPath: settings.fileSearchPath.value,
        enableFileSearch: settings.enableFileSearch.checked,
        enableWebSearch: settings.enableWebSearch.checked,
        contextWindow: getContextWindow(),
        usageParameters: sessionParams,
        rerankerModel: sessionTools.rerankerModel || null,
        fullContext: sessionTools.fullContext,
        uploadedDocuments
      })
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    const answer = data?.message?.content || '(No response content)';
    messages.push({ role: 'assistant', content: answer });
    const assistantRow = addMessage('assistant', answer);
    addTracePanel(assistantRow, data.trace);
    addAssistantToolInfo(data.toolUsage);
    trackTokenMetrics(data.tokenMetrics);
    setStatus('Ready');
    await refreshGpuMonitor();
  } catch (error) {
    addMessage('system', `Error: ${error.message}`);
    setStatus('Error');
  }
}

composer.addEventListener('submit', async (e) => {
  e.preventDefault();
  await sendChat();
});

openSettingsBtn.addEventListener('click', async () => {
  await loadRerankerModels();
  paramInputs.rerankerModel.value = sessionTools.rerankerModel || '';
  paramInputs.fullContextToggle.checked = sessionTools.fullContext;
  settingsDialog.showModal();
});

closeSettingsBtn.addEventListener('click', () => {
  settingsDialog.close();
});

settingsForm.addEventListener('submit', (e) => {
  e.preventDefault();
  Object.assign(sessionParams, collectSessionParameters());
  sessionTools.rerankerModel = paramInputs.rerankerModel.value;
  sessionTools.fullContext = paramInputs.fullContextToggle.checked;
  settingsDialog.close();
  window.alert('Session parameters saved for future responses.');
  setStatus('Session settings updated');
});

documentUploadEl.addEventListener('change', async (e) => {
  uploadedDocuments = await readUploadedDocuments(e.target.files);
  renderDocumentSummary();
});

newChatBtn.addEventListener('click', () => {
  messages = [];
  chatEl.innerHTML = '';
  addMessage('system', 'New chat started.');
  uploadedDocuments = [];
  documentUploadEl.value = '';
  renderDocumentSummary();
  setStatus('Ready');
});

clearVramBtn.addEventListener('click', async () => {
  setStatus('Clearing VRAM...');
  try {
    const res = await fetch('/api/gpu/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ollamaUrl: settings.ollamaUrl.value })
    });
    const data = await res.json().catch(() => ({}));

    if (!res.ok || !data.cleared) {
      const errorText = data.error || `HTTP ${res.status}`;
      window.alert(`VRAM was not fully cleared.\n\nError: ${errorText}`);
      setStatus('VRAM clear failed');
      await refreshGpuMonitor();
      return;
    }

    window.alert('VRAM has been cleared successfully.');
    setStatus('VRAM cleared');
    await refreshGpuMonitor();
  } catch (error) {
    window.alert(`VRAM was not cleared.\n\nError: ${error.message}`);
    setStatus('VRAM clear failed');
  }
});

function startGpuMonitorPolling() {
  if (gpuMonitorTimer) clearInterval(gpuMonitorTimer);
  refreshGpuMonitor();
  gpuMonitorTimer = setInterval(refreshGpuMonitor, 4000);
}

addMessage(
  'system',
  'Connected UI ready. Configure your Ollama and SearXNG endpoints in the sidebar, then start chatting.'
);
startGpuMonitorPolling();
renderTokenMonitor();
renderDocumentSummary();
