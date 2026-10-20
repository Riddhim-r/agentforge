import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toOpenAIMessages, createChunkAccumulator, createOpenAIProvider } from '../src/providers/openai.js';
import { toAnthropicMessages, createEventAccumulator } from '../src/providers/anthropic.js';
import { planDemo, createDemoProvider } from '../src/providers/demo.js';
import { createProvider } from '../src/providers/index.js';

const history = [
  { role: 'user', content: 'weather?' },
  { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'web_search', arguments: { query: 'weather' } }, { id: 'c2', name: 'get_datetime', arguments: {} }] },
  { role: 'tool', toolCallId: 'c1', name: 'web_search', content: 'sunny' },
  { role: 'tool', toolCallId: 'c2', name: 'get_datetime', content: 'monday', isError: true },
  { role: 'notice', kind: 'info', content: 'UI only' },
  { role: 'assistant', content: 'Sunny on Monday.' },
];

test('OpenAI message conversion', () => {
  const out = toOpenAIMessages('be nice', history);
  assert.deepEqual(out.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'tool', 'assistant']);
  assert.equal(out[2].content, null);
  assert.equal(out[2].tool_calls[0].function.arguments, '{"query":"weather"}');
  assert.equal(out[3].tool_call_id, 'c1');
});

test('Anthropic message conversion merges tool results into one user turn', () => {
  const out = toAnthropicMessages(history);
  assert.deepEqual(out.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.deepEqual(out[1].content.map((b) => b.type), ['tool_use', 'tool_use']);
  assert.deepEqual(out[2].content.map((b) => b.tool_use_id), ['c1', 'c2']);
  assert.equal(out[2].content[1].is_error, true);
});

test('OpenAI stream accumulator assembles text and streamed tool calls', () => {
  const seen = [];
  const acc = createChunkAccumulator((d) => seen.push(d));
  [
    { choices: [{ delta: { content: 'Hel' } }] },
    { choices: [{ delta: { content: 'lo' } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'web_search', arguments: '{"que' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ry":"x"}' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 1, id: 'call_2', function: { name: 'get_datetime', arguments: '{}' } }] } }] },
    { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 12, completion_tokens: 7 } },
  ].forEach((c) => acc.push(c));
  const r = acc.result();
  assert.equal(r.content, 'Hello');
  assert.deepEqual(seen, ['Hel', 'lo']);
  assert.deepEqual(r.toolCalls, [{ id: 'call_1', name: 'web_search', arguments: '{"query":"x"}' }, { id: 'call_2', name: 'get_datetime', arguments: '{}' }]);
  assert.deepEqual(r.usage, { input: 12, output: 7 });
});

test('Anthropic event accumulator', () => {
  const acc = createEventAccumulator();
  acc.push('message_start', { message: { usage: { input_tokens: 40, output_tokens: 1 } } });
  acc.push('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
  acc.push('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Checking.' } });
  acc.push('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'web_search' } });
  acc.push('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":' } });
  acc.push('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"x"}' } });
  acc.push('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 22 } });
  const r = acc.result();
  assert.equal(r.content, 'Checking.');
  assert.deepEqual(r.toolCalls, [{ id: 'tu_1', name: 'web_search', arguments: '{"query":"x"}' }]);
  assert.deepEqual(r.usage, { input: 40, output: 22 });
});

test('OpenAI provider streams over SSE end to end (mocked fetch)', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"content":"Hi"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c","function":{"name":"add","arguments":"{}"}}]}}]}',
    'data: [DONE]', '',
  ].join('\n\n');
  let sent;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => { sent = { url, body: JSON.parse(opts.body), headers: opts.headers }; return new Response(sse, { headers: { 'content-type': 'text/event-stream' } }); };
  try {
    const p = createOpenAIProvider({ baseUrl: 'https://example.test/v1/', apiKey: 'k', model: 'm' });
    const r = await p.chat({ system: 's', messages: [{ role: 'user', content: 'u' }], tools: [{ name: 'add', description: 'd', parameters: {} }], onText: () => {} });
    assert.equal(sent.url, 'https://example.test/v1/chat/completions');
    assert.equal(sent.headers.Authorization, 'Bearer k');
    assert.equal(sent.body.tools[0].type, 'function');
    assert.equal(sent.body.stream, true);
    assert.equal(r.content, 'Hi');
    assert.equal(r.toolCalls[0].name, 'add');
  } finally { globalThis.fetch = realFetch; }
});

test('createProvider validates keys and base URLs', () => {
  assert.throws(() => createProvider({ provider: 'openai', apiKey: '' }), /API key/);
  assert.throws(() => createProvider({ provider: 'custom', baseUrl: '' }), /base URL/);
  assert.equal(createProvider({ provider: 'demo' }).label, 'Demo');
  assert.equal(createProvider({ provider: 'ollama' }).label, 'Ollama (local)');
});

test('demo planner picks sensible tools', () => {
  assert.equal(planDemo('Search for the history of Python').name, 'web_search');
  assert.equal(planDemo('Search for the history of Python').arguments.query, 'the history of Python');
  assert.equal(planDemo('Run some python statistics').name, 'run_python');
  assert.equal(planDemo('calculate fibonacci in JavaScript').name, 'run_javascript');
  assert.equal(planDemo('make a line chart').arguments.type, 'line');
  assert.equal(planDemo('what time is it').name, 'get_datetime');
  assert.deepEqual(planDemo('summarise this', ['a.csv']), { name: 'read_file', arguments: { name: 'a.csv' } });
  assert.deepEqual(planDemo('list my files').arguments, {});
  assert.equal(planDemo('hello there'), null);
});

test('demo provider calls a tool, then summarises its result', async () => {
  const p = createDemoProvider();
  const first = await p.chat({ messages: [{ role: 'user', content: 'what time is it' }] });
  assert.equal(first.toolCalls[0].name, 'get_datetime');
  const second = await p.chat({ messages: [
    { role: 'user', content: 'what time is it' },
    { role: 'assistant', content: first.content, toolCalls: first.toolCalls },
    { role: 'tool', toolCallId: first.toolCalls[0].id, name: 'get_datetime', content: '{"local":"Monday","timeZone":"Asia/Kolkata"}' },
  ] });
  assert.equal(second.toolCalls.length, 0);
  assert.match(second.content, /Monday/);
});
