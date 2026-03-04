import { clamp } from '../utils/math.js';

// Thin helper for JSON-based Ollama HTTP APIs.
export async function fetchOllamaJson(ollamaUrl, endpoint, options = {}) {
  const response = await fetch(new URL(endpoint, ollamaUrl), options);
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama error ${response.status}: ${text}`);
  }
  return response.json();
}

export async function getOllamaTags(ollamaUrl) {
  const data = await fetchOllamaJson(ollamaUrl, '/api/tags');
  return data.models || [];
}

export async function listLoadedModels(ollamaUrl) {
  try {
    const data = await fetchOllamaJson(ollamaUrl, '/api/ps');
    return data.models || [];
  } catch {
    return [];
  }
}

export async function unloadModel(ollamaUrl, model) {
  return fetchOllamaJson(ollamaUrl, '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: 0 })
  });
}

export async function loadModel(ollamaUrl, model) {
  return fetchOllamaJson(ollamaUrl, '/api/generate', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, prompt: '', stream: false, keep_alive: '10m' })
  });
}

// Estimates model + context VRAM requirements for pre-load checks.
export async function estimateModelAndContextVRAMMB({ ollamaUrl, model, contextWindow = 8192 }) {
  const tags = await getOllamaTags(ollamaUrl);
  const match = tags.find((m) => m.name === model || m.model === model) || null;
  const modelBytes = match?.size || 0;
  const modelMB = modelBytes ? modelBytes / (1024 * 1024) : 4096;

  const contextMB = clamp(Math.round((contextWindow / 1024) * 160), 256, 8192);
  const overheadMB = Math.round(modelMB * 0.18);

  return {
    modelMB: Math.round(modelMB),
    contextMB,
    overheadMB,
    totalEstimatedMB: Math.round(modelMB + contextMB + overheadMB)
  };
}
