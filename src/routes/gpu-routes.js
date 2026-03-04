import { Router } from 'express';
import { DEFAULT_OLLAMA_URL } from '../config/constants.js';
import { getGpuStatus } from '../services/gpu-service.js';
import { listLoadedModels, unloadModel } from '../services/ollama-service.js';

// GPU monitoring and clear-memory endpoints.
export function createGpuRouter() {
  const router = Router();

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

  return router;
}
