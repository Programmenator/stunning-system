stunning-system

A local ChatGPT-style interface for Ollama with optional:
- filesystem search across your machine (or a configured root)
- web search via your own SearXNG instance
- GPU VRAM-aware model switching and monitoring

Features
- Chat UI with a left configuration panel and persistent in-memory conversation.
- Connects to any Ollama server URL and model.
- Optional file discovery to enrich prompts.
- Optional SearXNG JSON search integration for internet context.
- VRAM-aware model swap flow.
- Manual "Clear GPU VRAM" action with success/failure feedback.
- Live VRAM usage monitor (polls nvidia-smi via backend API).
- Token usage monitor and generation throughput/session totals.
- Session settings popup for temperature, top-p, top-k, repeat penalty, max output tokens.
- Internet-search reranker model dropdown from installed Ollama models.
- Expandable trace tab per assistant message showing model and source details.
- Context-window textbox in composer for future conversations.
- Full-context toggle for uploaded documents.
- Helper APIs: /api/chat, /api/files/search, /api/web/search, /api/gpu/status, /api/gpu/clear, /api/model/switch, /api/models.

Quick start (dev)
1) npm install
2) npm start
3) Open http://localhost:3000

Build Ubuntu .deb
1) npm run build:deb
2) Install with: sudo dpkg -i dist/stunning-system_1.0.0_amd64.deb
3) Run with: stunning-system

Optional service mode
- sudo systemctl enable --now stunning-system
- sudo systemctl status stunning-system

Configuration
- OLLAMA_URL (default: http://127.0.0.1:11434)
- SEARXNG_URL (default: http://127.0.0.1:8080)
- PORT (default: 3000)

Notes
- GPU features require nvidia-smi and a compatible NVIDIA GPU.
- VRAM estimation is heuristic and conservative.
- File search can be slow on large roots.
- Designed for local/private use; auth is not included by default.
