import { Router } from 'express';
import { DEFAULT_OLLAMA_URL, DEFAULT_SEARXNG_URL, READ_ONLY_FILE_SEARCH_GUARD } from '../config/constants.js';
import { clamp } from '../utils/math.js';
import { getGpuStatus } from '../services/gpu-service.js';
import {
  estimateModelAndContextVRAMMB,
  getOllamaTags,
  listLoadedModels,
  loadModel,
  unloadModel
} from '../services/ollama-service.js';
import { searchFiles, searchWeb } from '../services/search-service.js';
import { handleChatRequest } from '../services/chat-service.js';

// Declares all API endpoints while delegating business logic to services.
export function createApiRouter() {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, defaultOllamaUrl: DEFAULT_OLLAMA_URL, defaultSearxngUrl: DEFAULT_SEARXNG_URL });
  });

  router.get('/models', async (req, res) => {
    const ollamaUrl = req.query.ollamaUrl || DEFAULT_OLLAMA_URL;
    try {
      const tags = await getOllamaTags(ollamaUrl);
      const models = tags.map((m) => m.name || m.model).filter(Boolean);
      res.json({ models });
    } catch (error) {
      res.status(500).json({ error: 'Failed to load models', details: error.message });
    }
  });

  router.get('/gpu/status', async (_req, res) => {
    try {
      const gpus = await getGpuStatus();
      res.json({ gpus });
    } catch (error) {
      res.status(500).json({ error: 'Failed to read GPU status', details: error.message });
    }
  });

  router.post('/gpu/clear', async (req, res) => {
    const { ollamaUrl = DEFAULT_OLLAMA_URL } = req.body || {};
    try {
      const loaded = await listLoadedModels(ollamaUrl);
      for (const model of loaded) {
        await unloadModel(ollamaUrl, model.name || model.model);
      }

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

  router.post('/model/switch', async (req, res) => {
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

  router.post('/files/search', async (req, res) => {
    const { query, rootPath = process.cwd(), maxResults = 8 } = req.body || {};
    if (!query) {
      return res.status(400).json({ error: 'Missing query' });
    }

    try {
      const results = await searchFiles({ query, rootPath, maxResults: clamp(maxResults, 1, 30) });
      res.json({ results, fileSearchGuard: READ_ONLY_FILE_SEARCH_GUARD });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  router.post('/web/search', async (req, res) => {
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

  router.post('/chat', async (req, res) => {
    const result = await handleChatRequest(req.body || {});
    res.status(result.status).json(result.body);
  });

  return router;
}
