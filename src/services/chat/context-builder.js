// Builds the system context block passed to the main model from enabled tools.
export function buildToolContext({
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
