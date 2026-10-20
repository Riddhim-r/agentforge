/**
 * Minimal Server-Sent Events parser.
 * Works on any chunking of the stream (chunks may split lines or events).
 */
export function createSSEParser(onEvent) {
  let buffer = '';
  let eventName = null;
  let dataLines = [];

  const dispatch = () => {
    if (dataLines.length) onEvent({ event: eventName || 'message', data: dataLines.join('\n') });
    eventName = null;
    dataLines = [];
  };

  const handleLine = (rawLine) => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') return dispatch();
    if (line.startsWith(':')) return; // comment / keep-alive
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') eventName = value;
    else if (field === 'data') dataLines.push(value);
  };

  return {
    feed(chunk) {
      buffer += chunk;
      let idx;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        handleLine(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 1);
      }
    },
    end() {
      if (buffer) handleLine(buffer);
      buffer = '';
      dispatch();
    },
  };
}

/** Read a fetch Response body as SSE, calling onEvent for every event. */
export async function readSSE(response, onEvent) {
  const parser = createSSEParser(onEvent);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.feed(decoder.decode(value, { stream: true }));
  }
  parser.feed(decoder.decode());
  parser.end();
}
