import { Router } from 'express';
import { createHealthRouter } from './health-routes.js';
import { createGpuRouter } from './gpu-routes.js';
import { createModelRouter } from './model-routes.js';
import { createSearchRouter } from './search-routes.js';
import { createChatRouter } from './chat-routes.js';

// API composition root: mounts one router per cohesive responsibility domain.
export function createApiRouter() {
  const router = Router();

  router.use(createHealthRouter());
  router.use(createGpuRouter());
  router.use(createModelRouter());
  router.use(createSearchRouter());
  router.use(createChatRouter());

  return router;
}
