import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSSEParser } from '../src/core/sse.js';

const collect = (chunks) => {
  const events = [];
  const p = createSSEParser((e) => events.push(e));
  chunks.forEach((c) => p.feed(c));
  p.end();
  return events;
};

test('parses data and named events', () => {
  const events = collect(['event: ping\ndata: {"a":1}\n\n', 'data: hello\n\n']);
  assert.deepEqual(events, [{ event: 'ping', data: '{"a":1}' }, { event: 'message', data: 'hello' }]);
});

test('handles events split across arbitrary chunk boundaries', () => {
  const stream = 'data: {"x":"first"}\n\ndata: {"x":"second"}\n\ndata: [DONE]\n\n';
  for (let size = 1; size < stream.length; size += 3) {
    const chunks = stream.match(new RegExp(`[\\s\\S]{1,${size}}`, 'g'));
    assert.deepEqual(collect(chunks).map((e) => e.data), ['{"x":"first"}', '{"x":"second"}', '[DONE]']);
  }
});

test('ignores comments, joins multi-line data, accepts CRLF and a trailing event without blank line', () => {
  const events = collect([': keep-alive\r\n', 'data: line1\r\ndata: line2\r\n\r\n', 'data: tail']);
  assert.deepEqual(events.map((e) => e.data), ['line1\nline2', 'tail']);
});
