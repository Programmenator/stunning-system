import { DEFAULT_OLLAMA_URL, DEFAULT_SEARXNG_URL, READ_ONLY_FILE_SEARCH_GUARD } from '../config/constants.js';
import { clamp } from '../utils/math.js';
import { listLoadedModels } from './ollama-service.js';
import { rerankWebResultsWithModel } from './reranker-service.js';
import { searchFiles, searchWeb } from './search-service.js';

function buildToolContext({
  fileResults,
  webResults,
  rerankerSummary,
  uploadedDocuments = [],
  fullContext = false
}) {
  const sections = [];

  if (fileResults?.length) {
    sections.push(
      `Filesystem search results:\n${fileResults
        .map((f, i) => `${i + 1}. ${f.path} (size: ${f.size} bytes)`)
        .join('\n')}`
    );
  }

  if (webResults?.length) {
    sections.push(
      `Web search results:\n${webResults
        .map(
          (r, i) =>
            `${i + 1}. ${r.title}\nURL: ${r.url}\nSource engine: ${r.engine || 'n/a'}\nSnippet: ${
              r.content || ''
            }`
        )
        .join('\n\n')}`
    );
  }

  if (uploadedDocuments?.length) {
    const docsSection = uploadedDocuments
      .map((doc, i) => {
        const raw = String(doc.content || '');
        const content = fullContext ? raw : raw.slice(0, 4000);
        const suffix = fullContext
          ? ''
          : raw.length > 4000
            ? `\n[Truncated ${raw.length - 4000} chars]`
            : '';
        return `${i + 1}. ${doc.name}\n${content}${suffix}`;
      })
      .join('\n\n');

    sections.push(`Uploaded document context:\n${docsSection}`);
  }

  if (rerankerSummary) {
    sections.push(`Reranker summary:\n${rerankerSummary}`);
  }

  if (!sections.length) return null;

  return (
    (fullContext
      ? 'You have full uploaded document text available. Analyze it thoroughly and do not skip sections. Always cite source path/URL when used.\n\n'
      : 'You can use the external context below to answer the user. Always cite the relevant source path/URL when you use this context.\n\n') +
    sections.join('\n\n')
  );
}

function buildTokenMetrics(data = {}) {
  const promptTokens = Number(data.prompt_eval_count || 0);
  const completionTokens = Number(data.eval_count || 0);
  const totalTokens = promptTokens + completionTokens;

  const promptEvalDurationNs = Number(data.prompt_eval_duration || 0);
  const evalDurationNs = Number(data.eval_duration || 0);
  const totalDurationNs = Number(data.total_duration || 0);

  const completionTokensPerSecond =
    evalDurationNs > 0 ? Number((completionTokens / (evalDurationNs / 1e9)).toFixed(2)) : null;
  const promptTokensPerSecond =
    promptEvalDurationNs > 0 ? Number((promptTokens / (promptEvalDurationNs / 1e9)).toFixed(2)) : null;

  return {
    promptTokens,
    completionTokens,
    totalTokens,
    completionTokensPerSecond,
    promptTokensPerSecond,
    durations: {
      promptEvalMs: Math.round(promptEvalDurationNs / 1e6),
      completionEvalMs: Math.round(evalDurationNs / 1e6),
      totalMs: Math.round(totalDurationNs / 1e6)
    }
  };
}

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
