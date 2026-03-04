import { Router } from 'express';
import { DEFAULT_OLLAMA_URL } from '../config/constants.js';
import { getGpuStatus } from '../services/gpu-service.js';
import {
  estimateModelAndContextVRAMMB,
  getOllamaTags,
  loadModel,
  unloadModel
} from '../services/ollama-service.js';

// Ollama model listing and VRAM-aware switch endpoints.
export function createModelRouter() {
  const router = Router();

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

  return router;
}
