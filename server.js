import express from 'express';
import cors from 'cors';
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static('public'));

const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const DEFAULT_SEARXNG_URL = process.env.SEARXNG_URL || 'http://127.0.0.1:8080';

const clamp = (num, min, max) => Math.max(min, Math.min(max, num));

function runCommand(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (d) => {
      stdout += d.toString();
    });
    proc.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `${cmd} exited with ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

async function getGpuStatus() {
  const output = await runCommand('nvidia-smi', [
    '--query-gpu=index,name,memory.total,memory.used,memory.free',
    '--format=csv,noheader,nounits'
  ]);

  return output
    .split('\n')
    .map((x) => x.trim())
    .filter(Boolean)
    .map((line) => {
      const [index, name, total, used, free] = line.split(',').map((x) => x.trim());
      return {
        index: Number(index),
        name,
        totalMB: Number(total),
        usedMB: Number(used),
        freeMB: Number(free)
      };
    });
}

async function fetchOllamaJson(ollamaUrl, endpoint, options = {}) {
  const response = await fetch(new URL(endpoint, ollamaUrl), options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }
  return response.json();
}

async function getOllamaTags(ollamaUrl) {
  const data = await fetchOllamaJson(ollamaUrl, '/api/tags');
  return data.models || [];
}

async function listLoadedModels(ollamaUrl) {
  try {
    const data = await fetchOllamaJson(ollamaUrl, '/api/ps');
    return data.models || [];
  } catch {
    return [];
  }
}

async function unloadModel(ollamaUrl, model) {
  return fetchOllamaJson(ollamaUrl, '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 })
  });
}

async function loadModel(ollamaUrl, model) {
  return fetchOllamaJson(ollamaUrl, '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: '10m' })
  });
}

async function estimateModelAndContextVRAMMB({ ollamaUrl, model, contextWindow = 8192 }) {
  const tags = await getOllamaTags(ollamaUrl);
  const match = tags.find((m) => m.name === model || m.model === model) || null;
  const modelBytes = match?.size || 0;
  const modelMB = modelBytes ? modelBytes / (1024 * 1024) : 4096;

  // Coarse context estimate (KV cache + overhead).
  const contextMB = clamp(Math.round((contextWindow / 1024) * 160), 256, 8192);

  // runtime overhead for kernels / allocator fragmentation.
  const overheadMB = Math.round(modelMB * 0.18);

  return {
    modelMB: Math.round(modelMB),
    contextMB,
    overheadMB,
    totalEstimatedMB: Math.round(modelMB + contextMB + overheadMB)
  };
}

async function searchFilesWithRg({ rootPath, query, maxResults = 8 }) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  if (!terms.length) return [];

  return new Promise((resolve, reject) => {
    const args = ['--files', rootPath];
    const rg = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';

    rg.stdout.on('data', (d) => (out += d.toString()));
    rg.stderr.on('data', (d) => (err += d.toString()));

    rg.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(err || 'rg --files failed'));
        return;
      }
      const files = out
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((file) => {
          const lower = file.toLowerCase();
          return terms.some((t) => lower.includes(t));
        })
        .slice(0, maxResults);

      const results = [];
      for (const file of files) {
        try {
          const stat = await fs.stat(file);
          results.push({ path: file, size: stat.size });
        } catch {
          // ignore race conditions
        }
      }
      resolve(results);
    });
  });
}

async function searchFilesFallback({ rootPath, query, maxResults = 8 }) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  const queue = [rootPath];
  const results = [];

  while (queue.length && results.length < maxResults) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          !entry.name.startsWith('.') &&
          entry.name !== 'node_modules' &&
          entry.name !== '.git'
        ) {
          queue.push(full);
        }
      } else if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if (terms.some((t) => lower.includes(t))) {
          try {
            const stat = await fs.stat(full);
            results.push({ path: full, size: stat.size });
            if (results.length >= maxResults) break;
          } catch {
            // skip
          }
        }
      }
    }
  }

  return results;
}

async function searchFiles(options) {
  try {
    return await searchFilesWithRg(options);
  } catch {
    return searchFilesFallback(options);
  }
}

async function searchWeb({ searxngUrl, query, maxResults = 5 }) {
  const url = new URL('/search', searxngUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`SearXNG search failed: ${res.status}`);
  }

  const data = await res.json();
  const results = (data.results || []).slice(0, maxResults).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    engine: r.engine
  }));

  return results;
}

function extractJsonObject(text = '') {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

async function rerankWebResultsWithModel({ ollamaUrl, rerankerModel, userQuery, webResults }) {
  const trace = {
    model: rerankerModel || null,
    prompt: null,
    rawResponse: null,
    parsedResponse: null,
    orderedIndices: [],
    includedSources: [],
    excludedSources: [],
    status: 'skipped'
  };

  if (!rerankerModel || !webResults?.length) {
    return { webResults, reranker: null, rerankerTrace: trace };
  }

  const rerankerPrompt = [
    'Re-rank these web results by relevance to the user query.',
    'Return ONLY valid JSON with this shape:',
    '{"ordered_indices":[...],"summary":"..."}',
    '',
    `User query: ${userQuery}`,
    '',
    'Web results JSON:',
    JSON.stringify(webResults)
  ].join('\n');

  trace.prompt = rerankerPrompt;

  const response = await fetch(new URL('/api/chat', ollamaUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: rerankerModel,
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'You are a search reranker. Output strict JSON only, no markdown, no prose outside JSON.'
        },
        { role: 'user', content: rerankerPrompt }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    trace.status = 'error';
    trace.rawResponse = details;
    throw new Error(`Reranker model error ${response.status}: ${details}`);
  }

  const data = await response.json();
  trace.rawResponse = data?.message?.content || '';
  const parsed = extractJsonObject(trace.rawResponse);
  trace.parsedResponse = parsed;

  if (!parsed || !Array.isArray(parsed.ordered_indices)) {
    trace.status = 'invalid_output';
    trace.includedSources = webResults.map((r) => r.url || r.title || 'unknown');
    trace.excludedSources = [];
    return {
      webResults,
      reranker: {
        model: rerankerModel,
        applied: false,
        reason: 'Reranker did not return valid ordered_indices JSON'
      },
      rerankerTrace: trace
    };
  }

  const orderedIndices = parsed.ordered_indices
    .map((idx) => Number(idx))
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < webResults.length);
  trace.orderedIndices = orderedIndices;

  const ordered = orderedIndices.map((idx) => webResults[idx]);
  const missing = webResults.filter((r) => !ordered.includes(r));
  const rerankedWebResults = [...ordered, ...missing];

  trace.includedSources = rerankedWebResults.map((r) => r.url || r.title || 'unknown');
  trace.excludedSources = webResults
    .filter((r) => !rerankedWebResults.includes(r))
    .map((r) => r.url || r.title || 'unknown');
  trace.status = 'applied';

  return {
    webResults: rerankedWebResults,
    reranker: {
      model: rerankerModel,
      applied: true,
      summary: parsed.summary || ''
    },
    rerankerTrace: trace
  };
}


function buildToolContext({ fileResults, webResults, rerankerSummary, uploadedDocuments = [], fullContext = false }) {
  const sections = [];

  if (fileResults?.length) {
    sections.push(
      `Filesystem search results:\n${fileResults
        .map((f, i) => `${i + 1}. ${f.path} (size: ${f.size} bytes)`)
        .join('\n')}`
    );
  }

  if (webResults?.length) {
    sections.push(
      `Web search results:\n${webResults
        .map(
          (r, i) =>
            `${i + 1}. ${r.title}\nURL: ${r.url}\nSource engine: ${r.engine || 'n/a'}\nSnippet: ${
              r.content || ''
            }`
        )
        .join('\n\n')}`
    );
  }


  if (uploadedDocuments?.length) {
    const docsSection = uploadedDocuments
      .map((doc, i) => {
        const raw = String(doc.content || '');
        const content = fullContext ? raw : raw.slice(0, 4000);
        const suffix = fullContext ? '' : raw.length > 4000 ? `\n[Truncated ${raw.length - 4000} chars]` : '';
        return `${i + 1}. ${doc.name}\n${content}${suffix}`;
      })
      .join('\n\n');

    sections.push(`Uploaded document context:\n${docsSection}`);
  }

  if (rerankerSummary) {
    sections.push(`Reranker summary:
${rerankerSummary}`);
  }

  if (!sections.length) return null;

  return (
    (fullContext ? 'You have full uploaded document text available. Analyze it thoroughly and do not skip sections. Always cite source path/URL when used.\n\n' : 'You can use the external context below to answer the user. Always cite the relevant source path/URL when you use this context.\n\n') +
    sections.join('\n\n')
  );
}

function buildTokenMetrics(data = {}) {
  const promptTokens = Number(data.prompt_eval_count || 0);
  const completionTokens = Number(data.eval_count || 0);
  const totalTokens = promptTokens + completionTokens;

  const promptEvalDurationNs = Number(data.prompt_eval_duration || 0);
  const evalDurationNs = Number(data.eval_duration || 0);
  const totalDurationNs = Number(data.total_duration || 0);

  const completionTokensPerSecond =
    evalDurationNs > 0 ? Number((completionTokens / (evalDurationNs / 1e9)).toFixed(2)) : null;
  const promptTokensPerSecond =
    promptEvalDurationNs > 0 ? Number((promptTokens / (promptEvalDurationNs / 1e9)).toFixed(2)) : null;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    completionTokensPerSecond,
    promptTokensPerSecond,
    durations: {
      promptEvalMs: Math.round(promptEvalDurationNs / 1e6),
      completionEvalMs: Math.round(evalDurationNs / 1e6),
      totalMs: Math.round(totalDurationNs / 1e6)
    }
  };
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, defaultOllamaUrl: DEFAULT_OLLAMA_URL, defaultSearxngUrl: DEFAULT_SEARXNG_URL });
});

app.get('/api/models', async (req, res) => {
  const ollamaUrl = req.query.ollamaUrl || DEFAULT_OLLAMA_URL;
  try {
    const tags = await getOllamaTags(ollamaUrl);
    const models = tags.map((m) => m.name || m.model).filter(Boolean);
    res.json({ models });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load models', details: error.message });
  }
});

app.get('/api/gpu/status', async (_req, res) => {
  try {
    const gpus = await getGpuStatus();
    res.json({ gpus });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read GPU status', details: error.message });
  }
});

app.post('/api/gpu/clear', async (req, res) => {
  const { ollamaUrl = DEFAULT_OLLAMA_URL } = req.body || {};
  try {
    const loaded = await listLoadedModels(ollamaUrl);
    for (const model of loaded) {
      await unloadModel(ollamaUrl, model.name || model.model);
    }

    // Give driver time to reclaim memory.
    await new Promise((r) => setTimeout(r, 800));

    const gpus = await getGpuStatus();
    const stillUsed = gpus.some((gpu) => gpu.usedMB > Math.max(1024, gpu.totalMB * 0.2));
    if (stillUsed) {
      return res.status(500).json({
        cleared: false,
        error: 'VRAM still in use after unload attempt',
        gpus
      });
    }

    res.json({ cleared: true, unloadedModels: loaded.map((m) => m.name || m.model), gpus });
  } catch (error) {
    res.status(500).json({ cleared: false, error: error.message });
  }
});

app.post('/api/model/switch', async (req, res) => {
  const {
    ollamaUrl = DEFAULT_OLLAMA_URL,
    currentModel,
    newModel,
    clearPrevious = true,
    contextWindow = 8192
  } = req.body || {};

  if (!newModel) {
    return res.status(400).json({ error: 'newModel is required' });
  }

  try {
    const beforeGpus = await getGpuStatus();
    const estimate = await estimateModelAndContextVRAMMB({ ollamaUrl, model: newModel, contextWindow });

    if (clearPrevious && currentModel && currentModel !== newModel) {
      await unloadModel(ollamaUrl, currentModel);
      await new Promise((r) => setTimeout(r, 500));
    }

    const afterClearGpus = await getGpuStatus();
    const bestGpu = [...afterClearGpus].sort((a, b) => b.freeMB - a.freeMB)[0];
    const canLoad = bestGpu ? bestGpu.freeMB >= estimate.totalEstimatedMB : false;

    if (!canLoad) {
      return res.status(409).json({
        loaded: false,
        reason: 'insufficient_vram',
        message: `Not enough free VRAM for ${newModel}. Need ~${estimate.totalEstimatedMB}MB, free ${bestGpu?.freeMB ?? 0}MB.`,
        estimate,
        gpus: afterClearGpus
      });
    }

    await loadModel(ollamaUrl, newModel);
    await new Promise((r) => setTimeout(r, 500));
    const finalGpus = await getGpuStatus();

    res.json({
      loaded: true,
      model: newModel,
      clearPrevious,
      estimate,
      gpusBefore: beforeGpus,
      gpusAfter: finalGpus
    });
  } catch (error) {
    res.status(500).json({ loaded: false, error: error.message });
  }
});

app.post('/api/files/search', async (req, res) => {
  const { query, rootPath = process.cwd(), maxResults = 8 } = req.body || {};
  if (!query) {
    return res.status(400).json({ error: 'Missing query' });
  }

  try {
    const results = await searchFiles({ query, rootPath, maxResults: clamp(maxResults, 1, 30) });
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/web/search', async (req, res) => {
  const { query, searxngUrl = DEFAULT_SEARXNG_URL, maxResults = 5 } = req.body || {};
  if (!query) {
    return res.status(400).json({ error: 'Missing query' });
  }

  try {
    const results = await searchWeb({ query, searxngUrl, maxResults: clamp(maxResults, 1, 10) });
    res.json({ results });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/chat', async (req, res) => {
  const {
    messages,
    model,
    ollamaUrl = DEFAULT_OLLAMA_URL,
    searxngUrl = DEFAULT_SEARXNG_URL,
    enableFileSearch = false,
    enableWebSearch = false,
    fileSearchPath = process.cwd(),
    fileSearchRoot = null,
    maxFileResults = 6,
    maxWebResults = 4,
    contextWindow = 8192,
    usageParameters = {},
    rerankerModel = null,
    fullContext = false,
    uploadedDocuments = []
  } = req.body || {};

  if (!Array.isArray(messages) || !messages.length) {
    return res.status(400).json({ error: 'messages is required' });
  }

  if (!model) {
    return res.status(400).json({ error: 'model is required' });
  }

  const userMessage = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  let fileResults = [];
  let webResults = [];
  const originalWebResults = [];

  try {
    if (enableFileSearch && userMessage) {
      fileResults = await searchFiles({
        query: userMessage,
        rootPath: fileSearchRoot || fileSearchPath,
        maxResults: clamp(maxFileResults, 1, 20)
      });
    }
  } catch {
    fileResults = [];
  }

  try {
    if (enableWebSearch && userMessage) {
      webResults = await searchWeb({
        query: userMessage,
        searxngUrl,
        maxResults: clamp(maxWebResults, 1, 10)
      });
      originalWebResults.push(...webResults);
    }
  } catch {
    webResults = [];
  }

  let reranker = null;
  let rerankerTrace = null;
  if (enableWebSearch && webResults.length > 1 && rerankerModel) {
    try {
      const reranked = await rerankWebResultsWithModel({
        ollamaUrl,
        rerankerModel,
        userQuery: userMessage,
        webResults
      });
      webResults = reranked.webResults;
      reranker = reranked.reranker;
      rerankerTrace = reranked.rerankerTrace;
    } catch (error) {
      reranker = { model: rerankerModel, applied: false, reason: error.message };
      rerankerTrace = { model: rerankerModel, status: "error", error: error.message };
    }
  }

  const loadedModelsSnapshot = await listLoadedModels(ollamaUrl);

  const toolContext = buildToolContext({
    fileResults,
    webResults,
    rerankerSummary: reranker?.summary || reranker?.reason || '',
    uploadedDocuments,
    fullContext
  });
  const payloadMessages = toolContext
    ? [{ role: 'system', content: toolContext }, ...messages]
    : messages;

  try {
    const mainRequestPayload = {
      model,
      messages: payloadMessages,
      stream: false,
      options: {
        num_ctx: clamp(Number(contextWindow || 8192), 512, 131072),
        temperature: Number(usageParameters.temperature ?? 0.7),
        top_p: Number(usageParameters.top_p ?? 0.9),
        top_k: Number(usageParameters.top_k ?? 40),
        repeat_penalty: Number(usageParameters.repeat_penalty ?? 1.1),
        num_predict: Number(usageParameters.num_predict ?? 1024)
      }
    };

    const response = await fetch(new URL('/api/chat', ollamaUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mainRequestPayload)
    });

    if (!response.ok) {
      const text = await response.text();
      return res.status(response.status).json({
        error: `Ollama error: ${response.status}`,
        details: text
      });
    }

    const data = await response.json();
    const tokenMetrics = buildTokenMetrics(data);
    const webIncluded = webResults.map((r) => r.url || r.title || "unknown");
    const webExcluded = originalWebResults
      .filter((r) => !webResults.includes(r))
      .map((r) => r.url || r.title || "unknown");

    res.json({
      model,
      message: data.message,
      tokenMetrics,
      toolUsage: {
        fileResults,
        webResults,
        reranker
      },
      trace: {
        mainModel: {
          model,
          loadedModelsSnapshot: loadedModelsSnapshot.map((m) => m.name || m.model),
          request: {
            userMessage,
            fullContextEnabled: Boolean(fullContext),
            uploadedDocuments: uploadedDocuments.map((d) => ({
              name: d.name,
              chars: String(d.content || '').length
            })),
            systemContext: toolContext || null,
            options: mainRequestPayload.options
          },
          responsePreview: data?.message?.content || "",
          tokenMetrics
        },
        rerankerModel: rerankerTrace,
        sources: {
          reviewed: originalWebResults,
          passedToMain: webResults,
          included: webIncluded,
          excluded: webExcluded
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to call Ollama server',
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
