import { webSearchTool } from './web-search.js';
import { runJavascriptTool, runPythonTool } from './code.js';

export const PALETTE = ['#e8590c', '#1c7ed6', '#2f9e44', '#ae3ec9', '#f59f00', '#0ca678', '#d6336c', '#495057'];

export const readFileTool = {
  name: 'read_file',
  description: 'Read a file the user attached. Call with no name to list the attached files. Supports text, code, CSV, JSON, Markdown and PDF (text extracted). Use offset to page through long files.',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'File name. Omit to list files.' },
      offset: { type: 'integer', description: 'Character offset to start from', default: 0 },
      max_chars: { type: 'integer', description: 'Maximum characters to return (up to 20000)', default: 12000 },
    },
  },
  async run({ name, offset = 0, max_chars = 12000 }, ctx) {
    const files = [...(ctx.getFiles?.() || [])];
    if (!name) return { content: JSON.stringify({ files: files.map((f) => ({ name: f.name, type: f.type, chars: f.text.length })) }) };
    const file = files.find((f) => f.name === name) || files.find((f) => f.name.toLowerCase() === String(name).toLowerCase());
    if (!file) throw new Error(`No attached file named "${name}". Attached: ${files.map((f) => f.name).join(', ') || 'none'}`);
    const start = Math.max(0, Number(offset) || 0);
    const size = Math.max(100, Math.min(20000, Number(max_chars) || 12000));
    const content = file.text.slice(start, start + size);
    return {
      content: JSON.stringify({ name: file.name, totalChars: file.text.length, offset: start, returnedChars: content.length, hasMore: start + size < file.text.length, content }),
    };
  },
};

export const createChartTool = {
  name: 'create_chart',
  description: 'Render a chart in the chat for the user. Provide labels and one or more datasets of numbers.',
  parameters: {
    type: 'object',
    properties: {
      type: { type: 'string', enum: ['bar', 'line', 'pie', 'doughnut', 'scatter', 'radar'], default: 'bar' },
      title: { type: 'string' },
      labels: { type: 'array', items: { type: 'string' }, description: 'X-axis labels or category names' },
      datasets: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, data: { type: 'array', items: { type: 'number' } } },
          required: ['data'],
        },
      },
    },
    required: ['datasets'],
  },
  async run({ type = 'bar', title = '', labels = [], datasets = [] }) {
    if (!Array.isArray(datasets) || !datasets.length) throw new Error('datasets must be a non-empty array');
    const allowed = ['bar', 'line', 'pie', 'doughnut', 'scatter', 'radar'];
    const chartType = allowed.includes(type) ? type : 'bar';
    const round = chartType === 'pie' || chartType === 'doughnut';
    const data = {
      labels: labels.map(String),
      datasets: datasets.map((d, i) => ({
        label: d.label || `Series ${i + 1}`,
        data: (d.data || []).map((v) => (typeof v === 'object' ? v : Number(v))),
        backgroundColor: round ? labels.map((_, j) => PALETTE[j % PALETTE.length]) : `${PALETTE[i % PALETTE.length]}cc`,
        borderColor: round ? '#00000000' : PALETTE[i % PALETTE.length],
        borderWidth: 2,
        tension: 0.3,
      })),
    };
    const points = data.datasets.reduce((n, d) => n + d.data.length, 0);
    return {
      content: `Rendered a ${chartType} chart "${title}" with ${data.datasets.length} dataset(s) and ${points} points. The user can see it.`,
      display: { kind: 'chart', config: { type: chartType, data, options: { title } } },
    };
  },
};

export const getDatetimeTool = {
  name: 'get_datetime',
  description: "Get the user's current local date, time and time zone.",
  parameters: { type: 'object', properties: {} },
  async run() {
    const d = new Date();
    return {
      content: JSON.stringify({
        iso: d.toISOString(),
        local: d.toLocaleString(undefined, { dateStyle: 'full', timeStyle: 'short' }),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    };
  },
};

export const ALL_TOOLS = [webSearchTool, runJavascriptTool, runPythonTool, readFileTool, createChartTool, getDatetimeTool];

export const TOOL_META = {
  web_search: { label: 'Web search', icon: 'search', argKey: 'query' },
  run_javascript: { label: 'JavaScript', icon: 'code', argKey: 'code', lang: 'javascript' },
  run_python: { label: 'Python', icon: 'terminal', argKey: 'code', lang: 'python' },
  read_file: { label: 'Read file', icon: 'file', argKey: 'name' },
  create_chart: { label: 'Chart', icon: 'chart', argKey: 'title' },
  get_datetime: { label: 'Date & time', icon: 'clock' },
};

export function getTools(enabled = {}) {
  return ALL_TOOLS.filter((t) => enabled[t.name] !== false);
}
