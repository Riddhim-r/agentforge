/** DOM rendering: Markdown, messages, tool cards and charts. */
import { TOOL_META } from './tools/index.js';

const ICONS = {
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  code: '<path d="m8 6-6 6 6 6M16 6l6 6-6 6"/>',
  terminal: '<path d="m4 17 6-5-6-5M12 19h8"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>',
  chart: '<path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  tool: '<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.5 2.5-2.4-.6-.6-2.4z"/>',
  check: '<path d="m5 12 5 5 9-10"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
  alert: '<path d="M12 3 2 21h20zM12 10v5M12 18h.01"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
  retry: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5"/>',
  spark: '<path d="M12 2v6M12 16v6M2 12h6M16 12h6M5 5l3 3M16 16l3 3M5 19l3-3M16 8l3-3"/>',
};
export const icon = (name, cls = '') => `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ICONS.tool}</svg>`;

export const escapeHtml = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let markedReady = false;
export function renderMarkdown(text = '') {
  if (!window.marked || !window.DOMPurify) return `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`;
  if (!markedReady) {
    window.marked.setOptions({ gfm: true, breaks: true });
    window.DOMPurify.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A') { node.setAttribute('target', '_blank'); node.setAttribute('rel', 'noopener noreferrer'); }
    });
    markedReady = true;
  }
  return window.DOMPurify.sanitize(window.marked.parse(text));
}

/** Syntax-highlight code blocks and add copy buttons. */
export function enhance(root) {
  root.querySelectorAll('.md pre > code:not([data-done])').forEach((code) => {
    code.dataset.done = '1';
    try { window.hljs?.highlightElement(code); } catch { /* ignore */ }
    const btn = document.createElement('button');
    btn.className = 'copy-code';
    btn.type = 'button';
    btn.dataset.copy = '';
    btn.title = 'Copy code';
    btn.innerHTML = icon('copy');
    code.parentElement.appendChild(btn);
  });
  root.querySelectorAll('.tool-code code:not([data-done])').forEach((code) => {
    code.dataset.done = '1';
    try { window.hljs?.highlightElement(code); } catch { /* ignore */ }
  });
  mountCharts(root);
}

function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }

export function mountCharts(root) {
  if (!window.Chart) return;
  root.querySelectorAll('canvas[data-chart]:not([data-mounted])').forEach((canvas) => {
    canvas.dataset.mounted = '1';
    try {
      const cfg = JSON.parse(canvas.dataset.chart);
      const text = cssVar('--text-2') || '#666';
      const grid = cssVar('--border') || '#ddd';
      const round = ['pie', 'doughnut', 'radar'].includes(cfg.type);
      // eslint-disable-next-line no-new
      new window.Chart(canvas, {
        type: cfg.type,
        data: cfg.data,
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            title: { display: !!cfg.options?.title, text: cfg.options?.title, color: text, font: { size: 14, weight: '600' } },
            legend: { labels: { color: text } },
          },
          scales: round ? {} : { x: { ticks: { color: text }, grid: { color: grid } }, y: { ticks: { color: text }, grid: { color: grid } } },
        },
      });
    } catch (e) {
      canvas.replaceWith(Object.assign(document.createElement('p'), { className: 'muted', textContent: `Could not draw chart: ${e.message}` }));
    }
  });
}

const preview = (call) => {
  const meta = TOOL_META[call.name] || {};
  const v = meta.argKey ? call.arguments?.[meta.argKey] : '';
  if (!v) return '';
  const s = String(v).split('\n').find((l) => l.trim() && !l.trim().startsWith('//') && !l.trim().startsWith('#')) || String(v);
  return s.length > 80 ? `${s.slice(0, 80)}…` : s;
};

function prettyOutput(content = '') {
  try { return JSON.stringify(JSON.parse(content), null, 2); } catch { return content; }
}

export function toolCardHTML(call, result, approval) {
  const meta = TOOL_META[call.name] || { label: call.name, icon: 'tool' };
  const status = approval ? 'waiting' : !result ? 'running' : result.isError ? 'error' : 'ok';
  const statusHTML = {
    waiting: '<span class="badge warn">Needs approval</span>',
    running: '<span class="spinner" aria-label="Running"></span>',
    error: `<span class="badge err">${icon('alert')} Failed</span>`,
    ok: `<span class="badge ok">${icon('check')} ${result?.ms ?? 0} ms</span>`,
  }[status];

  const code = meta.lang && call.arguments?.code;
  const input = code
    ? `<pre class="tool-code"><code class="language-${meta.lang}">${escapeHtml(code)}</code></pre>`
    : `<pre>${escapeHtml(JSON.stringify(call.arguments ?? {}, null, 2))}</pre>`;
  const out = result ? prettyOutput(result.content) : '';
  const output = result ? `<div class="tool-label">Output</div><pre class="${result.isError ? 'err-text' : ''}">${escapeHtml(out.length > 6000 ? `${out.slice(0, 6000)}\n…` : out)}</pre>` : '';
  const chart = result?.display?.kind === 'chart'
    ? `<div class="chart-wrap"><canvas data-chart="${escapeHtml(JSON.stringify(result.display.config))}"></canvas></div>` : '';
  const approvalHTML = approval
    ? `<div class="approval"><span>Run this ${escapeHtml(meta.label)} code in your browser?</span><button type="button" class="btn sm primary" data-approve="${escapeHtml(call.id)}">Run</button><button type="button" class="btn sm" data-deny="${escapeHtml(call.id)}">Skip</button></div>` : '';

  return `<div class="tool-card ${status}" data-call="${escapeHtml(call.id)}">
    <details ${approval || (result?.isError) ? 'open' : ''}>
      <summary>
        <span class="tool-icon">${icon(meta.icon)}</span>
        <span class="tool-name">${escapeHtml(meta.label || call.name)}</span>
        <span class="tool-preview">${escapeHtml(preview(call))}</span>
        ${statusHTML}
      </summary>
      <div class="tool-body"><div class="tool-label">Input · <code>${escapeHtml(call.name)}</code></div>${input}${output}</div>
    </details>
    ${approvalHTML}${chart}
  </div>`;
}

export function userHTML(m) {
  return `<div class="msg user"><div class="bubble">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>${m.files?.length ? `<div class="msg-files">${m.files.map((f) => `<span class="chip">${icon('file')}${escapeHtml(f)}</span>`).join('')}</div>` : ''}</div>`;
}

export function assistantInnerHTML(m, results = {}, approvals = new Set(), { streaming = false } = {}) {
  const text = m.content ? `<div class="md">${renderMarkdown(m.content)}</div>` : (streaming && !m.toolCalls?.length ? '<div class="thinking"><span></span><span></span><span></span></div>' : '');
  const tools = (m.toolCalls || []).map((c) => toolCardHTML(c, results[c.id], approvals.has(c.id))).join('');
  return `${text}${tools ? `<div class="tools">${tools}</div>` : ''}`;
}

export function noticeHTML(m) {
  const retry = m.kind === 'error' ? `<button type="button" class="btn sm" data-retry>${icon('retry')} Retry</button>` : '';
  return `<div class="notice ${m.kind}">${icon(m.kind === 'error' ? 'alert' : 'spark')}<div class="notice-text">${escapeHtml(m.content).replace(/\n/g, '<br>')}</div>${retry}</div>`;
}

/** Group a conversation into renderable blocks: consecutive assistant/tool messages form one agent turn. */
export function conversationHTML(messages) {
  const results = {};
  for (const m of messages) if (m.role === 'tool') results[m.toolCallId] = m;
  const html = [];
  let turn = null;
  const close = () => { if (turn) { html.push(`<div class="msg assistant"><div class="avatar">${icon('spark')}</div><div class="turn">${turn.join('')}</div></div>`); turn = null; } };
  for (const m of messages) {
    if (m.role === 'assistant') { turn ||= []; turn.push(`<div class="step">${assistantInnerHTML(m, results)}</div>`); }
    else if (m.role === 'tool') continue;
    else { close(); html.push(m.role === 'user' ? userHTML(m) : noticeHTML(m)); }
  }
  close();
  return html.join('');
}
