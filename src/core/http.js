/** Turn a failed HTTP response into a readable Error. */
export async function httpError(response, providerLabel = 'Provider') {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.error?.message || body?.message || body?.error || JSON.stringify(body);
  } catch {
    try { detail = await response.text(); } catch { /* ignore */ }
  }
  const hints = {
    400: 'The request was rejected. The model may not support tool calling, or a setting is out of range.',
    401: 'The API key was rejected. Check it in Settings.',
    403: 'This key does not have access to that model or endpoint.',
    404: 'Model or endpoint not found. Check the model name in Settings.',
    429: 'Rate limit or quota reached. Wait a moment or check your billing.',
  };
  const hint = hints[response.status] || (response.status >= 500 ? `${providerLabel} is having trouble. Try again shortly.` : '');
  const err = new Error(`${providerLabel} error ${response.status}${hint ? ` — ${hint}` : ''}${detail ? `\n\n${String(detail).slice(0, 500)}` : ''}`);
  err.status = response.status;
  return err;
}

/** fetch() wrapper that explains network/CORS failures instead of "Failed to fetch". */
export async function safeFetch(url, options, providerLabel = 'Provider') {
  try {
    return await fetch(url, options);
  } catch (e) {
    if (e?.name === 'AbortError') throw e;
    throw new Error(`Could not reach ${providerLabel} (${new URL(url).host}). Check your connection. If this is a local or custom endpoint, it must allow browser (CORS) requests from this site.`);
  }
}
