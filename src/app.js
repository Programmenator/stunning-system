import express from 'express';
import cors from 'cors';
import { createApiRouter } from './routes/api-routes.js';

// Creates and configures the Express application instance.
export function createApp() {
  const app = express();

  app.use(cors());
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static('public'));
  app.use('/api', createApiRouter());

  return app;
}
