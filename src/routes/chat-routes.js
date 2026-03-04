import { Router } from 'express';
import { handleChatRequest } from '../services/chat-service.js';

// Main chat endpoint (delegates orchestration to chat service).
export function createChatRouter() {
  const router = Router();

  router.post('/chat', async (req, res) => {
    const result = await handleChatRequest(req.body || {});
    res.status(result.status).json(result.body);
  });

  return router;
}
