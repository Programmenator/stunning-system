import { readdir, stat } from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';

// Uses ripgrep file listing for fast filename matching.
async function searchFilesWithRg({ rootPath, query, maxResults = 8 }) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  if (!terms.length) return [];

  return new Promise((resolve, reject) => {
    const args = ['--files', rootPath];
    const rg = spawn('rg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';

    rg.stdout.on('data', (d) => (out += d.toString()));
    rg.stderr.on('data', (d) => (err += d.toString()));

    rg.on('close', async (code) => {
      if (code !== 0) {
        reject(new Error(err || 'rg --files failed'));
        return;
      }
      const files = out
        .split('\n')
        .map((x) => x.trim())
        .filter(Boolean)
        .filter((file) => terms.some((t) => file.toLowerCase().includes(t)))
        .slice(0, maxResults);

      const results = [];
      for (const file of files) {
        try {
          const fileStats = await stat(file);
          results.push({ path: file, size: fileStats.size });
        } catch {
          // ignore race conditions
        }
      }
      resolve(results);
    });
  });
}

// Pure JS fallback when rg is unavailable.
async function searchFilesFallback({ rootPath, query, maxResults = 8 }) {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);

  const queue = [rootPath];
  const results = [];

  while (queue.length && results.length < maxResults) {
    const current = queue.shift();
    let entries = [];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (!entry.name.startsWith('.') && entry.name !== 'node_modules' && entry.name !== '.git') {
          queue.push(full);
        }
      } else if (entry.isFile() && terms.some((t) => entry.name.toLowerCase().includes(t))) {
        try {
          const fileStats = await stat(full);
          results.push({ path: full, size: fileStats.size });
          if (results.length >= maxResults) break;
        } catch {
          // skip unreadable file
        }
      }
    }
  }

  return results;
}

export async function searchFiles(options) {
  try {
    return await searchFilesWithRg(options);
  } catch {
    return searchFilesFallback(options);
  }
}

export async function searchWeb({ searxngUrl, query, maxResults = 5 }) {
  const url = new URL('/search', searxngUrl);
  url.searchParams.set('q', query);
  url.searchParams.set('format', 'json');

  const res = await fetch(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`SearXNG search failed: ${res.status}`);
  }

  const data = await res.json();
  return (data.results || []).slice(0, maxResults).map((r) => ({
    title: r.title,
    url: r.url,
    content: r.content,
    engine: r.engine
  }));
}
