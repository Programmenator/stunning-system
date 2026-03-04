// Attempts to parse model output as JSON object, including fenced/prose responses.
function extractJsonObject(text = '') {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // continue to regex extraction
  }

  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

// Uses a selected Ollama model to reorder web search results for final response quality.
export async function rerankWebResultsWithModel({ ollamaUrl, rerankerModel, userQuery, webResults }) {
  const trace = {
    model: rerankerModel || null,
    prompt: null,
    rawResponse: null,
    parsedResponse: null,
    orderedIndices: [],
    includedSources: [],
    excludedSources: [],
    status: 'skipped'
  };

  if (!rerankerModel || !webResults?.length) {
    return { webResults, reranker: null, rerankerTrace: trace };
  }

  const rerankerPrompt = [
    'Re-rank these web results by relevance to the user query.',
    'Return ONLY valid JSON with this shape:',
    '{"ordered_indices":[...],"summary":"..."}',
    '',
    `User query: ${userQuery}`,
    '',
    'Web results JSON:',
    JSON.stringify(webResults)
  ].join('\n');

  trace.prompt = rerankerPrompt;

  const response = await fetch(new URL('/api/chat', ollamaUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: rerankerModel,
      stream: false,
      messages: [
        {
          role: 'system',
          content:
            'You are a search reranker. Output strict JSON only, no markdown, no prose outside JSON.'
        },
        { role: 'user', content: rerankerPrompt }
      ]
    })
  });

  if (!response.ok) {
    const details = await response.text();
    trace.status = 'error';
    trace.rawResponse = details;
    throw new Error(`Reranker model error ${response.status}: ${details}`);
  }

  const data = await response.json();
  trace.rawResponse = data?.message?.content || '';
  const parsed = extractJsonObject(trace.rawResponse);
  trace.parsedResponse = parsed;

  if (!parsed || !Array.isArray(parsed.ordered_indices)) {
    trace.status = 'invalid_output';
    trace.includedSources = webResults.map((r) => r.url || r.title || 'unknown');
    trace.excludedSources = [];
    return {
      webResults,
      reranker: {
        model: rerankerModel,
        applied: false,
        reason: 'Reranker did not return valid ordered_indices JSON'
      },
      rerankerTrace: trace
    };
  }

  const orderedIndices = parsed.ordered_indices
    .map((idx) => Number(idx))
    .filter((idx) => Number.isInteger(idx) && idx >= 0 && idx < webResults.length);
  trace.orderedIndices = orderedIndices;

  const ordered = orderedIndices.map((idx) => webResults[idx]);
  const missing = webResults.filter((r) => !ordered.includes(r));
  const rerankedWebResults = [...ordered, ...missing];

  trace.includedSources = rerankedWebResults.map((r) => r.url || r.title || 'unknown');
  trace.excludedSources = webResults
    .filter((r) => !rerankedWebResults.includes(r))
    .map((r) => r.url || r.title || 'unknown');
  trace.status = 'applied';

  return {
    webResults: rerankedWebResults,
    reranker: {
      model: rerankerModel,
      applied: true,
      summary: parsed.summary || ''
    },
    rerankerTrace: trace
  };
}
