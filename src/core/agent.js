/**
 * The agent loop.
 *
 * Messages use one provider-neutral shape; each provider adapter converts it:
 *   { role: 'user', content }
 *   { role: 'assistant', content, toolCalls?: [{ id, name, arguments }] }
 *   { role: 'tool', toolCallId, name, content, isError?, ms?, display? }
 * Any other role (e.g. UI notices) is ignored by the providers.
 *
 * A provider is { chat({ system, messages, tools, signal, onText }) => { content, toolCalls, usage } }.
 * A tool is { name, description, parameters, requiresApproval?, run(args, ctx) => { content, display? } }.
 */

export const MAX_TOOL_OUTPUT = 30_000;

export function parseToolArguments(raw) {
  if (raw && typeof raw === 'object') return { args: raw };
  if (raw === undefined || raw === null || String(raw).trim() === '') return { args: {} };
  try {
    const parsed = JSON.parse(raw);
    return { args: parsed && typeof parsed === 'object' ? parsed : {} };
  } catch {
    return { args: {}, error: `Arguments were not valid JSON: ${String(raw).slice(0, 200)}` };
  }
}

/**
 * Make a history safe to send: every assistant tool call must be followed by a
 * tool result (APIs reject it otherwise). Happens after a stop or a crash mid-step.
 */
export function repairHistory(messages) {
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role !== 'assistant' || !m.toolCalls?.length) continue;
    const answered = new Set();
    let j = i + 1;
    while (j < messages.length && messages[j].role === 'tool') answered.add(messages[j++].toolCallId);
    const missing = m.toolCalls.filter((c) => !answered.has(c.id));
    if (missing.length) {
      messages.splice(j, 0, ...missing.map((c) => ({
        role: 'tool', toolCallId: c.id, name: c.name, content: 'Cancelled: the run was stopped before this tool finished.', isError: true,
      })));
      i = j + missing.length - 1;
    }
  }
  return messages;
}

const truncate = (s, n = MAX_TOOL_OUTPUT) => (s.length > n ? `${s.slice(0, n)}\n…[truncated ${s.length - n} characters]` : s);
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export async function executeToolCall(call, toolMap, ctx = {}) {
  const { onEvent = () => {}, approve } = ctx;
  const tool = toolMap.get(call.name);
  onEvent({ type: 'tool_start', call });
  const t0 = now();
  let content;
  let display;
  let isError = false;

  try {
    if (!tool) throw new Error(`Unknown tool "${call.name}". Available: ${[...toolMap.keys()].join(', ')}`);
    if (call.argumentError) throw new Error(call.argumentError);
    if (tool.requiresApproval && approve && !(await approve(call))) {
      throw new Error('The user declined to run this tool. Do not retry it; continue without it.');
    }
    const out = await tool.run(call.arguments || {}, ctx);
    const raw = out && typeof out === 'object' && 'content' in out ? out.content : out;
    content = typeof raw === 'string' ? raw : JSON.stringify(raw ?? null, null, 2);
    display = out?.display;
  } catch (e) {
    isError = true;
    content = `Error: ${e?.message || e}`;
  }

  const result = { role: 'tool', toolCallId: call.id, name: call.name, content: truncate(content), isError, ms: Math.round(now() - t0) };
  if (display) result.display = display;
  onEvent({ type: 'tool_end', call, result });
  return result;
}

export async function runAgent({ provider, system, messages, tools = [], maxSteps = 8, signal, onEvent = () => {}, approve, toolContext = {} }) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const specs = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  const usage = { input: 0, output: 0 };
  repairHistory(messages);

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    onEvent({ type: 'step_start', step });

    const t0 = now();
    const res = await provider.chat({
      system, messages, tools: specs, signal,
      onText: (delta) => onEvent({ type: 'text', delta, step }),
    });
    usage.input += res.usage?.input || 0;
    usage.output += res.usage?.output || 0;

    const toolCalls = (res.toolCalls || []).map((c, i) => {
      const { args, error } = parseToolArguments(c.arguments);
      const call = { id: c.id || `call_${step}_${i}_${Date.now().toString(36)}`, name: c.name, arguments: args };
      if (error) call.argumentError = error;
      return call;
    });

    const message = { role: 'assistant', content: res.content || '' };
    if (toolCalls.length) message.toolCalls = toolCalls;
    messages.push(message);
    onEvent({ type: 'assistant', message, step, usage: res.usage, ms: Math.round(now() - t0) });

    if (!toolCalls.length) return { messages, usage, steps: step, stopReason: 'done' };

    const results = await Promise.all(toolCalls.map((call) => executeToolCall(call, toolMap, { ...toolContext, signal, onEvent, approve })));
    messages.push(...results);
  }

  onEvent({ type: 'max_steps', maxSteps });
  return { messages, usage, steps: maxSteps, stopReason: 'max_steps' };
}
