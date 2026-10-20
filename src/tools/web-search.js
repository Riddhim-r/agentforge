/**
 * web_search: Tavily when the user has added a key (full-web results),
 * otherwise Wikipedia's public API, which needs no key and allows browser requests.
 */
const stripHtml = (s = '') => s.replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'");

export async function searchWikipedia(query, limit, signal) {
  const params = new URLSearchParams({
    action: 'query', generator: 'search', gsrsearch: query, gsrlimit: String(limit),
    prop: 'extracts|info', exintro: '1', explaintext: '1', exsentences: '3', exlimit: 'max', inprop: 'url',
    format: 'json', origin: '*',
  });
  const res = await fetch(`https://en.wikipedia.org/w/api.php?${params}`, { signal });
  if (!res.ok) throw new Error(`Wikipedia search failed (${res.status})`);
  const pages = Object.values((await res.json()).query?.pages || {}).sort((a, b) => a.index - b.index);
  return pages.map((p) => ({ title: p.title, url: p.fullurl, snippet: stripHtml(p.extract || '').slice(0, 500) }));
}

export async function searchTavily(query, limit, apiKey, signal) {
  const res = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({ query, max_results: limit, search_depth: 'basic' }),
    signal,
  });
  if (!res.ok) throw new Error(`Tavily search failed (${res.status}). Check the Tavily key in Settings.`);
  return ((await res.json()).results || []).map((r) => ({ title: r.title, url: r.url, snippet: (r.content || '').slice(0, 600) }));
}

export const webSearchTool = {
  name: 'web_search',
  description: 'Search for up-to-date information. Returns titles, URLs and snippets. Cite the URLs you use in your answer.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      max_results: { type: 'integer', description: 'Number of results (1-8)', default: 5 },
    },
    required: ['query'],
  },
  async run({ query, max_results = 5 }, ctx) {
    if (!query) throw new Error('query is required');
    const limit = Math.max(1, Math.min(8, Number(max_results) || 5));
    const key = ctx.settings?.tavilyKey;
    const results = key ? await searchTavily(query, limit, key, ctx.signal) : await searchWikipedia(query, limit, ctx.signal);
    return { content: JSON.stringify({ source: key ? 'Tavily web search' : 'Wikipedia', query, results }, null, 2) };
  },
};
