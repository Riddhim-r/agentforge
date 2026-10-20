/**
 * Adapter for any OpenAI-compatible Chat Completions API:
 * OpenAI, OpenRouter, AI Pipe, Groq, Gemini (OpenAI endpoint), Ollama, LM Studio…
 */
import { readSSE } from '../core/sse.js';
import { httpError, safeFetch } from '../core/http.js';

export function toOpenAIMessages(system, messages) {
  const out = system ? [{ role: 'system', content: system }] : [];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: m.content || (m.toolCalls?.length ? null : '') };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
        }));
      }
      out.push(msg);
    } else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
  }
  return out;
}

export const toOpenAITools = (tools) => tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));

/** Fold a stream of chat.completion.chunk objects into one result. */
export function createChunkAccumulator(onText = () => {}) {
  let content = '';
  let usage = null;
  let finishReason = null;
  const calls = [];
  return {
    push(chunk) {
      if (chunk.error) throw new Error(chunk.error.message || JSON.stringify(chunk.error));
      if (chunk.usage) usage = { input: chunk.usage.prompt_tokens || 0, output: chunk.usage.completion_tokens || 0 };
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || choice.message || {};
      if (delta.content) { content += delta.content; onText(delta.content); }
      for (const tc of delta.tool_calls || []) {
        let slot = tc.index !== undefined ? calls[tc.index] : undefined;
        if (!slot) {
          slot = { id: '', name: '', arguments: '' };
          if (tc.index !== undefined) calls[tc.index] = slot; else calls.push(slot);
        }
        if (tc.id) slot.id = tc.id;
        if (tc.function?.name) slot.name = slot.name && slot.name !== tc.function.name ? slot.name + tc.function.name : tc.function.name;
        if (tc.function?.arguments) {
          const a = tc.function.arguments;
          slot.arguments += typeof a === 'string' ? a : JSON.stringify(a);
        }
      }
    },
    result() {
      return { content, toolCalls: calls.filter(Boolean).filter((c) => c.name), usage, finishReason };
    },
  };
}

export function createOpenAIProvider({ label = 'OpenAI', baseUrl, apiKey, model, temperature, maxTokens, extraHeaders = {}, streamUsage = false }) {
  const root = baseUrl.replace(/\/+$/, '');
  const headers = { 'Content-Type': 'application/json', ...extraHeaders };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  return {
    label,
    async chat({ system, messages, tools, signal, onText }) {
      const body = { model, messages: toOpenAIMessages(system, messages), stream: true };
      if (tools?.length) body.tools = toOpenAITools(tools);
      if (temperature !== undefined) body.temperature = temperature;
      if (maxTokens) body.max_tokens = maxTokens;
      if (streamUsage) body.stream_options = { include_usage: true };

      const res = await safeFetch(`${root}/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal }, label);
      if (!res.ok) throw await httpError(res, label);

      const acc = createChunkAccumulator(onText);
      if (!(res.headers.get('content-type') || '').includes('text/event-stream')) {
        acc.push(await res.json()); // some servers ignore stream: true
        return acc.result();
      }
      await readSSE(res, ({ data }) => {
        if (data === '[DONE]') return;
        let chunk;
        try { chunk = JSON.parse(data); } catch { return; }
        acc.push(chunk);
      });
      return acc.result();
    },
    async listModels() {
      const res = await safeFetch(`${root}/models`, { headers }, label);
      if (!res.ok) throw await httpError(res, label);
      const data = await res.json();
      return (data.data || data.models || []).map((m) => m.id || m.name).filter(Boolean).sort();
    },
  };
}
