import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent, repairHistory, parseToolArguments, executeToolCall } from '../src/core/agent.js';

/** A fake provider that replays scripted responses and records what it was sent. */
const scripted = (responses) => {
  const calls = [];
  return {
    calls,
    async chat(req) {
      calls.push(structuredClone({ messages: req.messages, tools: req.tools }));
      const r = responses.shift();
      if (r.text) r.text.split(' ').forEach((w) => req.onText(`${w} `));
      return r;
    },
  };
};

const adder = { name: 'add', description: 'Add numbers', parameters: { type: 'object' }, run: ({ a, b }) => ({ content: String(a + b) }) };

test('runs tools and feeds results back until the model answers', async () => {
  const provider = scripted([
    { content: 'Let me add.', toolCalls: [{ id: 't1', name: 'add', arguments: '{"a":2,"b":3}' }], usage: { input: 10, output: 5 } },
    { content: 'The answer is 5.', toolCalls: [], usage: { input: 20, output: 4 } },
  ]);
  const messages = [{ role: 'user', content: 'What is 2+3?' }];
  const events = [];
  const out = await runAgent({ provider, messages, tools: [adder], onEvent: (e) => events.push(e.type) });

  assert.equal(out.stopReason, 'done');
  assert.equal(out.steps, 2);
  assert.deepEqual(out.usage, { input: 30, output: 9 });
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'assistant']);
  assert.equal(messages[2].content, '5');
  assert.equal(messages[2].toolCallId, 't1');
  assert.deepEqual(messages[1].toolCalls[0].arguments, { a: 2, b: 3 });
  // Second request must include the tool result.
  assert.equal(provider.calls[1].messages.at(-1).role, 'tool');
  assert.deepEqual(provider.calls[0].tools.map((t) => t.name), ['add']);
  assert.ok(events.includes('tool_start') && events.includes('tool_end'));
});

test('runs parallel tool calls and keeps their order', async () => {
  const slow = { name: 'slow', parameters: {}, run: async ({ v, ms }) => { await new Promise((r) => setTimeout(r, ms)); return { content: v }; } };
  const provider = scripted([
    { content: '', toolCalls: [{ id: 'a', name: 'slow', arguments: { v: 'A', ms: 30 } }, { id: 'b', name: 'slow', arguments: { v: 'B', ms: 1 } }] },
    { content: 'done', toolCalls: [] },
  ]);
  const messages = [{ role: 'user', content: 'go' }];
  await runAgent({ provider, messages, tools: [slow] });
  assert.deepEqual(messages.filter((m) => m.role === 'tool').map((m) => m.content), ['A', 'B']);
});

test('stops at maxSteps', async () => {
  const loop = () => ({ content: '', toolCalls: [{ id: `x${Math.random()}`, name: 'add', arguments: { a: 1, b: 1 } }] });
  const provider = scripted([loop(), loop(), loop()]);
  const events = [];
  const out = await runAgent({ provider, messages: [{ role: 'user', content: 'loop' }], tools: [adder], maxSteps: 2, onEvent: (e) => events.push(e.type) });
  assert.equal(out.stopReason, 'max_steps');
  assert.ok(events.includes('max_steps'));
});

test('tool errors, unknown tools and bad JSON become error results instead of crashing', async () => {
  const boom = { name: 'boom', parameters: {}, run: () => { throw new Error('kaboom'); } };
  const provider = scripted([
    { content: '', toolCalls: [{ id: '1', name: 'boom', arguments: '{}' }, { id: '2', name: 'nope', arguments: '{}' }, { id: '3', name: 'add', arguments: '{bad' }] },
    { content: 'recovered', toolCalls: [] },
  ]);
  const messages = [{ role: 'user', content: 'x' }];
  await runAgent({ provider, messages, tools: [boom, adder] });
  const results = messages.filter((m) => m.role === 'tool');
  assert.equal(results.length, 3);
  assert.ok(results.every((r) => r.isError));
  assert.match(results[0].content, /kaboom/);
  assert.match(results[1].content, /Unknown tool/);
  assert.match(results[2].content, /not valid JSON/);
  assert.equal(messages.at(-1).content, 'recovered');
});

test('approval: declined tools are not run', async () => {
  let ran = false;
  const guarded = { name: 'danger', parameters: {}, requiresApproval: true, run: () => { ran = true; return 'ran'; } };
  const r = await executeToolCall({ id: 'd', name: 'danger', arguments: {} }, new Map([['danger', guarded]]), { approve: async () => false });
  assert.equal(ran, false);
  assert.equal(r.isError, true);
  assert.match(r.content, /declined/);
});

test('abort signal stops the loop', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runAgent({ provider: scripted([]), messages: [], signal: controller.signal }), { name: 'AbortError' });
});

test('repairHistory fills in missing tool results after an interrupted run', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'x' }, { id: 'b', name: 'y' }] },
    { role: 'tool', toolCallId: 'a', name: 'x', content: 'ok' },
    { role: 'notice', kind: 'info', content: 'Stopped.' },
  ];
  repairHistory(messages);
  assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant', 'tool', 'tool', 'notice']);
  assert.equal(messages[3].toolCallId, 'b');
  assert.equal(messages[3].isError, true);
  repairHistory(messages); // idempotent
  assert.equal(messages.length, 5);
});

test('parseToolArguments', () => {
  assert.deepEqual(parseToolArguments('{"q":"x"}'), { args: { q: 'x' } });
  assert.deepEqual(parseToolArguments(''), { args: {} });
  assert.deepEqual(parseToolArguments({ a: 1 }), { args: { a: 1 } });
  assert.ok(parseToolArguments('{oops').error);
});
