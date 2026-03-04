import { Router } from 'express';
import { DEFAULT_OLLAMA_URL, DEFAULT_SEARXNG_URL } from '../config/constants.js';

// Health and defaults endpoint for quick runtime checks.
export function createHealthRouter() {
  const router = Router();

  router.get('/health', (_req, res) => {
    res.json({ ok: true, defaultOllamaUrl: DEFAULT_OLLAMA_URL, defaultSearxngUrl: DEFAULT_SEARXNG_URL });
  });

  return router;
}
