# stunning-system

A local ChatGPT-style interface for Ollama with optional:

- filesystem search across your machine (or a configured root)
- web search via your own SearXNG instance
- GPU VRAM-aware model switching and monitoring

## Features

- Chat UI with a left configuration panel and persistent in-memory conversation.
- Connects to any Ollama server URL and model.
- Optional file discovery to enrich prompts.
- Optional SearXNG JSON search integration for internet context.
- VRAM-aware model swap flow:
  - prompts whether to clear old model VRAM when model changes,
  - clears old model if requested,
  - otherwise checks if enough free VRAM exists for additional model + context,
  - blocks side-by-side load if VRAM is insufficient.
- Manual "Clear GPU VRAM" action with success/failure popup feedback.
- Live VRAM usage monitor (polls `nvidia-smi` via backend API).
- Token usage monitor for each response (prompt/completion/total tokens) plus generation throughput and session totals.
- Session Settings popup to adjust model usage parameters (temperature, top-p, top-k, repeat penalty, max output tokens) for the current session.
- Internet-search reranker model dropdown (from installed Ollama models) to reorder search results before they are passed to the main model.
- Expandable reasoning trace tab per assistant message showing main-model request context, reranker activity, and source reviewed/passed/excluded readouts.
- Main chat composer includes a direct context-window textbox used for future conversations.
- Full-context toggle for uploaded documents so the model receives full document text (not truncated snippets) when enabled.
- Exposes helper APIs: `/api/chat`, `/api/files/search`, `/api/web/search`, `/api/gpu/status`, `/api/gpu/clear`, `/api/model/switch`, `/api/models`.

## Project structure

- `server.js`: minimal startup entrypoint.
- `src/app.js`: Express app wiring and middleware setup.
- `src/routes/api-routes.js`: API composition root.
- `src/routes/*-routes.js`: one router module per responsibility domain (health, GPU, models, search, chat).
- `src/services/chat/*`: chat orchestration split into handler/context/metrics modules.
- `src/services/*`: modular business logic for GPU, Ollama, search, and reranking.
- `src/config/constants.js`: shared defaults and read-only file-search guard metadata.
- `src/utils/math.js`: utility helpers.

## Quick start (dev)

```bash
npm install
npm start
```

Open `http://localhost:3000`.

## Build Ubuntu `.deb`

```bash
npm run build:deb
```

This produces a package in `dist/`, for example `dist/stunning-system_1.0.0_amd64.deb`.

Install it on Ubuntu:

```bash
sudo dpkg -i dist/stunning-system_1.0.0_amd64.deb
```

Run manually:

```bash
stunning-system
```

Or run as a service:

```bash
sudo systemctl enable --now stunning-system
sudo systemctl status stunning-system
```

## Configuration

You can set defaults with environment variables:

- `OLLAMA_URL` (default: `http://127.0.0.1:11434`)
- `SEARXNG_URL` (default: `http://127.0.0.1:8080`)
- `PORT` (default: `3000`)

And override from the UI per session.

## Notes

- GPU features require `nvidia-smi` to be present and a compatible NVIDIA GPU.
- VRAM estimation for model+context is heuristic and intentionally conservative.
- File search is local and may be slow on very large roots; choose a focused root path.
- This app is designed for local/private use and does not include auth by default.

## Playwright / browser container troubleshooting

If screenshot automation fails with Chromium `SIGSEGV` (for example from `mcp__browser_tools__run_playwright_script`), the issue is usually in the ephemeral browser container/runtime rather than the app server itself.

Recommended mitigations:

1. Confirm the app is actually up (`curl http://127.0.0.1:3000/api/health`).
2. Retry once with `wait_until="domcontentloaded"` instead of `networkidle`.
3. If it still fails, retry in a fresh browser/session; these crashes can be transient.
4. Optionally try another engine (`firefox`/`webkit`) for automation checks.

This does not affect running the app locally via `npm start` or the generated `.deb` package.
