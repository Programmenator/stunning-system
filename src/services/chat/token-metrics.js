// Normalizes Ollama timing and token counters for UI reporting.
export function buildTokenMetrics(data = {}) {
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
