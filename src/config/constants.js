// Central configuration constants used across routes and services.
export const DEFAULT_OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
export const DEFAULT_SEARXNG_URL = process.env.SEARXNG_URL || 'http://127.0.0.1:8080';

// Read-only contract for local file search operations.
export const READ_ONLY_FILE_SEARCH_GUARD = Object.freeze({
  mode: 'read-only',
  allowedFsOps: Object.freeze(['readdir', 'stat'])
});
