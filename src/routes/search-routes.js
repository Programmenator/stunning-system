import { Router } from 'express';
import { DEFAULT_SEARXNG_URL, READ_ONLY_FILE_SEARCH_GUARD } from '../config/constants.js';
import { clamp } from '../utils/math.js';
import { searchFiles, searchWeb } from '../services/search-service.js';

// Local file-search and internet search endpoints.
export function createSearchRouter() {
  const router = Router();

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

  return router;
}
