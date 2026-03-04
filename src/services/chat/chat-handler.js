import { DEFAULT_OLLAMA_URL, DEFAULT_SEARXNG_URL, READ_ONLY_FILE_SEARCH_GUARD } from '../../config/constants.js';
import { clamp } from '../../utils/math.js';
import { listLoadedModels } from '../ollama-service.js';
import { rerankWebResultsWithModel } from '../reranker-service.js';
import { searchFiles, searchWeb } from '../search-service.js';
import { buildToolContext } from './context-builder.js';
import { buildTokenMetrics } from './token-metrics.js';

// End-to-end chat orchestration: tools, reranker, main model call, and trace construction.
export async function handleChatRequest(body = {}) {
  const {
    messages,
    model,
    ollamaUrl = DEFAULT_OLLAMA_URL,
    searxngUrl = DEFAULT_SEARXNG_URL,
    enableFileSearch = false,
    enableWebSearch = false,
    fileSearchPath = process.cwd(),
    fileSearchRoot = null,
    maxFileResults = 6,
    maxWebResults = 4,
    contextWindow = 8192,
    usageParameters = {},
    rerankerModel = null,
    fullContext = false,
    uploadedDocuments = []
  } = body;

  if (!Array.isArray(messages) || !messages.length) {
    return { status: 400, body: { error: 'messages is required' } };
  }

  if (!model) {
    return { status: 400, body: { error: 'model is required' } };
  }

  const userMessage = [...messages].reverse().find((m) => m.role === 'user')?.content || '';

  let fileResults = [];
  let webResults = [];
  const originalWebResults = [];

  try {
    if (enableFileSearch && userMessage) {
      fileResults = await searchFiles({
        query: userMessage,
        rootPath: fileSearchRoot || fileSearchPath,
        maxResults: clamp(maxFileResults, 1, 20)
      });
    }
  } catch {
    fileResults = [];
  }

  try {
    if (enableWebSearch && userMessage) {
      webResults = await searchWeb({
        query: userMessage,
        searxngUrl,
        maxResults: clamp(maxWebResults, 1, 10)
      });
      originalWebResults.push(...webResults);
    }
  } catch {
    webResults = [];
  }

  let reranker = null;
  let rerankerTrace = null;
  if (enableWebSearch && webResults.length > 1 && rerankerModel) {
    try {
      const reranked = await rerankWebResultsWithModel({
        ollamaUrl,
        rerankerModel,
        userQuery: userMessage,
        webResults
      });
      webResults = reranked.webResults;
      reranker = reranked.reranker;
      rerankerTrace = reranked.rerankerTrace;
    } catch (error) {
      reranker = { model: rerankerModel, applied: false, reason: error.message };
      rerankerTrace = { model: rerankerModel, status: 'error', error: error.message };
    }
  }

  const loadedModelsSnapshot = await listLoadedModels(ollamaUrl);
  const toolContext = buildToolContext({
    fileResults,
    webResults,
    rerankerSummary: reranker?.summary || reranker?.reason || '',
    uploadedDocuments,
    fullContext
  });
  const payloadMessages = toolContext ? [{ role: 'system', content: toolContext }, ...messages] : messages;

  const mainRequestPayload = {
    model,
    messages: payloadMessages,
    stream: false,
    options: {
      num_ctx: clamp(Number(contextWindow || 8192), 512, 131072),
      temperature: Number(usageParameters.temperature ?? 0.7),
      top_p: Number(usageParameters.top_p ?? 0.9),
      top_k: Number(usageParameters.top_k ?? 40),
      repeat_penalty: Number(usageParameters.repeat_penalty ?? 1.1),
      num_predict: clamp(Number(usageParameters.num_predict ?? 1024), 1, 131072)
    }
  };

  try {
    const response = await fetch(new URL('/api/chat', ollamaUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(mainRequestPayload)
    });

    if (!response.ok) {
      const text = await response.text();
      return {
        status: response.status,
        body: { error: `Ollama error: ${response.status}`, details: text }
      };
    }

    const data = await response.json();
    const tokenMetrics = buildTokenMetrics(data);
    const webIncluded = webResults.map((r) => r.url || r.title || 'unknown');
    const webExcluded = originalWebResults
      .filter((r) => !webResults.includes(r))
      .map((r) => r.url || r.title || 'unknown');

    return {
      status: 200,
      body: {
        model,
        message: data.message,
        tokenMetrics,
        toolUsage: {
          fileResults,
          webResults,
          reranker,
          fileSearchGuard: READ_ONLY_FILE_SEARCH_GUARD
        },
        trace: {
          mainModel: {
            model,
            loadedModelsSnapshot: loadedModelsSnapshot.map((m) => m.name || m.model),
            request: {
              userMessage,
              fullContextEnabled: Boolean(fullContext),
              uploadedDocuments: uploadedDocuments.map((d) => ({
                name: d.name,
                chars: String(d.content || '').length
              })),
              systemContext: toolContext || null,
              options: mainRequestPayload.options
            },
            responsePreview: data?.message?.content || '',
            tokenMetrics
          },
          rerankerModel: rerankerTrace,
          sources: {
            reviewed: originalWebResults,
            passedToMain: webResults,
            included: webIncluded,
            excluded: webExcluded
          }
        }
      }
    };
  } catch (error) {
    return {
      status: 500,
      body: {
        error: 'Failed to call Ollama server',
        details: error.message
      }
    };
  }
}
