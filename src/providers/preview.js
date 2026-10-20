/**
 * Preview provider: a tiny scripted planner so the app works with no API key.
 * The model is scripted; the tools it calls are real.
 */

const SAMPLE_JS = `// First 15 Fibonacci numbers and how many are prime
const fib = [0, 1];
while (fib.length < 15) fib.push(fib.at(-1) + fib.at(-2));
const isPrime = (n) => n > 1 && [...Array(Math.floor(Math.sqrt(n)) + 1).keys()].slice(2).every((d) => n % d);
console.log('fibonacci:', fib.join(', '));
return { primes: fib.filter(isPrime) };`;

const SAMPLE_PY = `import statistics as st
scores = [72, 88, 91, 65, 79, 94, 83, 70]
print("mean:", round(st.mean(scores), 2))
print("median:", st.median(scores))
print("stdev:", round(st.stdev(scores), 2))`;

const codeBlock = (text, langs) => {
  const m = text.match(/```(\w*)\n([\s\S]*?)```/);
  if (!m) return null;
  const lang = (m[1] || '').toLowerCase();
  return !langs || langs.includes(lang) ? m[2].trim() : null;
};

/** Decide which tool (if any) to call for a user message. Exported for tests. */
export function planPreview(text, fileNames = []) {
  const hasFiles = fileNames.length > 0;
  const t = (text || '').toLowerCase();
  const searchQuery = () => text.replace(/^(please\s+)?(search( the web)?( for)?|tell me about|who (is|was)|what (is|are|was)|explain)\s*/i, '').replace(/[?.!]+$/, '').trim() || text;
  if (/^\s*(please\s+)?search\b/.test(t)) return { name: 'web_search', arguments: { query: searchQuery() } };
  const py = codeBlock(text, ['py', 'python']);
  if (py || /\b(python|pandas|numpy|statistics)\b/.test(t)) return { name: 'run_python', arguments: { code: py || SAMPLE_PY } };
  const js = codeBlock(text, ['', 'js', 'javascript']);
  if (js || /\b(javascript|js|fibonacci|prime|calculate|compute)\b/.test(t)) return { name: 'run_javascript', arguments: { code: js || SAMPLE_JS } };
  if (/\b(chart|plot|graph|visuali[sz]e)\b/.test(t)) {
    return {
      name: 'create_chart',
      arguments: {
        type: /\bline\b/.test(t) ? 'line' : /\bpie\b/.test(t) ? 'pie' : 'bar',
        title: 'Monthly active users (sample data)',
        labels: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'],
        datasets: [{ label: 'Users (k)', data: [12, 19, 23, 31, 38, 52] }],
      },
    };
  }
  if (/\b(files?|csv|upload(ed)?|attach(ed|ment)?|document)\b/.test(t) || (hasFiles && /\b(read|summari[sz]e|analy[sz]e)\b/.test(t))) {
    return { name: 'read_file', arguments: hasFiles ? { name: fileNames[fileNames.length - 1] } : {} };
  }
  if (/\b(time|date|today|day is it)\b/.test(t)) return { name: 'get_datetime', arguments: {} };
  if (/\b(search|who|what|when|where|tell me about|wiki|history of|explain)\b/.test(t)) {
    return { name: 'web_search', arguments: { query: searchQuery() } };
  }
  return null;
}

function summarize(results) {
  return results.map((r) => {
    if (r.isError) return `\`${r.name}\` failed: ${r.content}`;
    let data;
    try { data = JSON.parse(r.content); } catch { data = null; }
    switch (r.name) {
      case 'web_search': {
        const items = data?.results || [];
        if (!items.length) return 'The search returned no results.';
        return `Here's what I found (${data.source}):\n\n${items.map((i) => `- **[${i.title}](${i.url})** — ${i.snippet}`).join('\n')}`;
      }
      case 'run_javascript':
      case 'run_python': {
        const parts = [];
        if (data?.stdout) parts.push(`Output:\n\n\`\`\`text\n${data.stdout.trim()}\n\`\`\``);
        if (data?.result !== undefined && data?.result !== null) parts.push(`Return value:\n\n\`\`\`json\n${typeof data.result === 'string' ? data.result : JSON.stringify(data.result, null, 2)}\n\`\`\``);
        return `The code ran in ${r.ms} ms.\n\n${parts.join('\n\n') || 'It produced no output.'}`;
      }
      case 'create_chart': return 'The chart is rendered above. With a model connected, the agent builds charts from your own data.';
      case 'get_datetime': return `It's **${data?.local}** (${data?.timeZone}).`;
      case 'read_file': return data?.files
        ? (data.files.length ? `Files you've attached:\n\n${data.files.map((f) => `- \`${f.name}\` (${f.chars.toLocaleString()} characters)`).join('\n')}` : 'No files are attached yet. Use the paperclip or drop a file here.')
        : `First part of \`${data?.name}\`:\n\n\`\`\`text\n${String(data?.content || '').slice(0, 1200)}\n\`\`\``;
      default: return `\`\`\`json\n${r.content.slice(0, 1500)}\n\`\`\``;
    }
  }).join('\n\n');
}

const HELP = `This is **preview mode**: no AI model is connected, so a small keyword planner is answering. The tools it calls are real, though. Try:

- "**Search** for the history of the transformer architecture"
- "**Calculate** the first Fibonacci numbers in JavaScript"
- "Run some **Python** statistics"
- "Make a **chart** of user growth"
- Attach a file and ask me to **read** it

For real answers, click **Connect a model** and add an API key. OpenRouter (which has free models), OpenAI, Anthropic, Gemini, Groq and local Ollama all work.`;

async function streamText(text, onText, signal) {
  const parts = text.match(/\S+\s*/g) || [text];
  for (const p of parts) {
    if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
    onText(p);
    await new Promise((r) => setTimeout(r, 12));
  }
}

export function createPreviewProvider({ fileNames = () => [] } = {}) {
  let counter = 0;
  return {
    label: 'Preview',
    async chat({ messages, signal, onText = () => {} }) {
      const convo = messages.filter((m) => ['user', 'assistant', 'tool'].includes(m.role));
      const last = convo[convo.length - 1];
      if (last?.role === 'tool') {
        const results = [];
        for (let i = convo.length - 1; i >= 0 && convo[i].role === 'tool'; i--) results.unshift(convo[i]);
        const text = summarize(results);
        await streamText(text, onText, signal);
        return { content: text, toolCalls: [], usage: null };
      }
      const plan = planPreview(last?.content, fileNames());
      if (!plan) {
        await streamText(HELP, onText, signal);
        return { content: HELP, toolCalls: [], usage: null };
      }
      const intro = `I'll use the \`${plan.name}\` tool for this.`;
      await streamText(intro, onText, signal);
      return { content: intro, toolCalls: [{ id: `preview_${++counter}_${Date.now().toString(36)}`, name: plan.name, arguments: plan.arguments }], usage: null };
    },
    async listModels() { return ['scripted-planner']; },
  };
}
