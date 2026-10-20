/** Adapter for the Anthropic Messages API (called directly from the browser). */
import { readSSE } from '../core/sse.js';
import { httpError, safeFetch } from '../core/http.js';

const API = 'https://api.anthropic.com/v1';

export function toAnthropicMessages(messages) {
  const out = [];
  const push = (role, blocks) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'user') push('user', [{ type: 'text', text: m.content || ' ' }]);
    else if (m.role === 'assistant') {
      const blocks = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments ?? {} });
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      const block = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content };
      if (m.isError) block.is_error = true;
      push('user', [block]);
    }
  }
  return out;
}

export const toAnthropicTools = (tools) => tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));

/** Fold Anthropic stream events into one result. */
export function createEventAccumulator(onText = () => {}) {
  let content = '';
  const usage = { input: 0, output: 0 };
  let stopReason = null;
  const blocks = [];
  return {
    push(type, ev) {
      switch (type) {
        case 'message_start':
          usage.input = ev.message?.usage?.input_tokens || 0;
          usage.output = ev.message?.usage?.output_tokens || 0;
          break;
        case 'content_block_start':
          blocks[ev.index] = ev.content_block?.type === 'tool_use'
            ? { kind: 'tool', id: ev.content_block.id, name: ev.content_block.name, json: '' }
            : { kind: 'text' };
          if (ev.content_block?.type === 'text' && ev.content_block.text) { content += ev.content_block.text; onText(ev.content_block.text); }
          break;
        case 'content_block_delta':
          if (ev.delta?.type === 'text_delta') { content += ev.delta.text; onText(ev.delta.text); }
          else if (ev.delta?.type === 'input_json_delta' && blocks[ev.index]) blocks[ev.index].json += ev.delta.partial_json;
          break;
        case 'message_delta':
          if (ev.usage?.output_tokens) usage.output = ev.usage.output_tokens;
          if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
          break;
        case 'error':
          throw new Error(ev.error?.message || 'Anthropic stream error');
        default:
      }
    },
    result() {
      const toolCalls = blocks.filter((b) => b?.kind === 'tool').map((b) => ({ id: b.id, name: b.name, arguments: b.json || '{}' }));
      return { content, toolCalls, usage, stopReason };
    },
  };
}

export function createAnthropicProvider({ apiKey, model, temperature, maxTokens }) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  return {
    label: 'Anthropic',
    async chat({ system, messages, tools, signal, onText }) {
      const body = { model, max_tokens: maxTokens || 4096, messages: toAnthropicMessages(messages), stream: true };
      if (system) body.system = system;
      if (tools?.length) body.tools = toAnthropicTools(tools);
      if (temperature !== undefined) body.temperature = Math.min(temperature, 1);

      const res = await safeFetch(`${API}/messages`, { method: 'POST', headers, body: JSON.stringify(body), signal }, 'Anthropic');
      if (!res.ok) throw await httpError(res, 'Anthropic');
      const acc = createEventAccumulator(onText);
      await readSSE(res, ({ event, data }) => {
        let ev;
        try { ev = JSON.parse(data); } catch { return; }
        acc.push(ev.type || event, ev);
      });
      return acc.result();
    },
    async listModels() {
      const res = await safeFetch(`${API}/models?limit=100`, { headers }, 'Anthropic');
      if (!res.ok) throw await httpError(res, 'Anthropic');
      return ((await res.json()).data || []).map((m) => m.id);
    },
  };
}
