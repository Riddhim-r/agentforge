/** AgentForge app controller: wires the UI to the agent loop. */
import { runAgent, repairHistory } from './core/agent.js';
import { PROVIDERS, createProvider } from './providers/index.js';
import { getTools } from './tools/index.js';
import * as store from './storage.js';
import { conversationHTML, assistantInnerHTML, userHTML, noticeHTML, enhance, escapeHtml, icon } from './render.js';

const $ = (sel) => document.querySelector(sel);
const TEXT_TYPES = /\.(txt|md|markdown|csv|tsv|json|jsonl|js|mjs|ts|tsx|jsx|py|html|css|xml|yaml|yml|sql|log|ini|toml|sh|r|java|c|cpp|h|go|rs|rb|php)$/i;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

const state = {
  settings: store.loadSettings(),
  conversations: store.loadConversations(),
  currentId: null,
  files: new Map(), // name -> { name, type, size, text }, kept in memory only
  running: null, // { controller, approvals: Map }
};

const el = {
  sidebar: $('#sidebar'), convList: $('#conv-list'), messages: $('#messages'), scroller: $('#scroller'), empty: $('#empty'),
  form: $('#composer'), input: $('#input'), send: $('#send'), attach: $('#attach'), fileInput: $('#file-input'), chips: $('#file-chips'),
  title: $('#chat-title'), modelBadge: $('#model-badge'), usage: $('#usage'), dialog: $('#settings'), settingsForm: $('#settings-form'),
  toast: $('#toast'), mic: $('#mic'), dropzone: $('#dropzone'),
};

// ---------- helpers ----------
const current = () => state.conversations.find((c) => c.id === state.currentId);
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function toast(message, kind = 'info') {
  const t = document.createElement('div');
  t.className = `toast-item ${kind}`;
  t.textContent = message;
  el.toast.appendChild(t);
  setTimeout(() => t.classList.add('out'), 3200);
  setTimeout(() => t.remove(), 3600);
}

function persist() { store.saveConversations(state.conversations); }

function scrollToBottom(force = false) {
  const s = el.scroller;
  const near = s.scrollHeight - s.scrollTop - s.clientHeight < 160;
  if (force || near) s.scrollTop = s.scrollHeight;
}

function applyTheme() {
  const pref = state.settings.theme;
  const dark = pref === 'dark' || (pref === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('#hljs-theme').href = `https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/styles/github${dark ? '-dark' : ''}.min.css`;
}

function providerLabel() {
  const s = state.settings;
  const preset = PROVIDERS[s.provider] || PROVIDERS.demo;
  if (s.provider === 'demo') return 'Demo mode';
  return `${preset.label} · ${s.model || preset.defaultModel || 'no model'}`;
}

// ---------- rendering ----------
function renderSidebar() {
  const list = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
  el.convList.innerHTML = list.length
    ? list.map((c) => `<div class="conv ${c.id === state.currentId ? 'active' : ''}" data-id="${c.id}">
        <button type="button" class="conv-open" data-open="${c.id}"><span class="conv-title">${escapeHtml(c.title)}</span><span class="conv-meta">${new Date(c.updatedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</span></button>
        <button type="button" class="icon-btn conv-del" data-del="${c.id}" title="Delete conversation" aria-label="Delete conversation">${icon('x')}</button>
      </div>`).join('')
    : '<p class="muted small pad">No conversations yet.</p>';
}

function renderHeader() {
  const c = current();
  el.title.textContent = c?.title || 'New conversation';
  el.modelBadge.textContent = providerLabel();
  el.modelBadge.classList.toggle('demo', state.settings.provider === 'demo');
  const u = c?.usage;
  el.usage.textContent = u && (u.input || u.output) ? `${fmtTokens(u.input)} in · ${fmtTokens(u.output)} out tokens` : '';
}

function renderConversation() {
  const c = current();
  const has = c && c.messages.length;
  el.empty.hidden = !!has;
  el.messages.innerHTML = has ? conversationHTML(c.messages) : '';
  enhance(el.messages);
  renderHeader();
  renderSidebar();
  scrollToBottom(true);
}

function renderChips() {
  el.chips.innerHTML = [...state.files.values()].map((f) => `<span class="chip">${icon('file')}${escapeHtml(f.name)}<small>${(f.size / 1024).toFixed(1)} KB</small><button type="button" data-unfile="${escapeHtml(f.name)}" aria-label="Remove ${escapeHtml(f.name)}">${icon('x')}</button></span>`).join('');
  el.chips.hidden = state.files.size === 0;
}

function setRunning(running) {
  el.send.classList.toggle('stop', running);
  el.send.innerHTML = running ? '<span class="stop-square"></span>' : '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
  el.send.title = running ? 'Stop' : 'Send';
  el.send.setAttribute('aria-label', running ? 'Stop' : 'Send');
  document.body.classList.toggle('is-running', running);
}

// ---------- conversations ----------
function newConversation() {
  if (state.running) return;
  const empty = state.conversations.find((c) => !c.messages.length);
  if (empty) { state.currentId = empty.id; renderConversation(); el.input.focus(); return; }
  const c = { id: uid('conv'), title: 'New conversation', messages: [], usage: { input: 0, output: 0 }, createdAt: Date.now(), updatedAt: Date.now() };
  state.conversations.push(c);
  state.currentId = c.id;
  renderConversation();
  el.input.focus();
}

function openConversation(id) {
  if (state.running) return toast('Stop the current run first.');
  state.currentId = id;
  renderConversation();
  el.sidebar.classList.remove('open');
}

function deleteConversation(id) {
  if (state.running && id === state.currentId) return;
  state.conversations = state.conversations.filter((c) => c.id !== id);
  if (id === state.currentId) {
    const next = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    state.currentId = next?.id || null;
    if (!next) return newConversation();
  }
  persist();
  renderConversation();
}

// ---------- the run ----------
function systemPrompt() {
  let s = state.settings.systemPrompt || store.DEFAULT_SYSTEM_PROMPT;
  if (state.files.size) s += `\n\nThe user has attached these files (read them with read_file; in Python they are under /data/):\n${[...state.files.values()].map((f) => `- ${f.name} (${f.text.length} characters)`).join('\n')}`;
  return s;
}

async function run() {
  const conv = current();
  const settings = state.settings;
  let provider;
  try {
    provider = createProvider({ ...settings, apiKey: store.getKey(settings.provider) }, { fileNames: () => [...state.files.keys()] });
  } catch (e) {
    conv.messages.push({ role: 'notice', kind: 'error', content: e.message });
    renderConversation();
    return;
  }

  const controller = new AbortController();
  const approvals = new Map();
  state.running = { controller, approvals };
  setRunning(true);

  const turnEl = document.createElement('div');
  turnEl.className = 'msg assistant';
  turnEl.innerHTML = `<div class="avatar">${icon('spark')}</div><div class="turn"></div>`;
  el.messages.appendChild(turnEl);
  const turn = turnEl.querySelector('.turn');

  let step = null; // { msg, el, results }
  let frame = 0;
  const paint = () => {
    frame = 0;
    if (!step) return;
    step.el.innerHTML = assistantInnerHTML(step.msg, step.results, new Set(approvals.keys()), { streaming: !step.done });
    enhance(step.el);
    scrollToBottom();
  };
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint); };

  const onEvent = (ev) => {
    switch (ev.type) {
      case 'step_start':
        step = { msg: { role: 'assistant', content: '' }, el: Object.assign(document.createElement('div'), { className: 'step' }), results: {}, done: false };
        turn.appendChild(step.el);
        paint();
        break;
      case 'text': step.msg.content += ev.delta; schedule(); break;
      case 'assistant':
        step.msg = ev.message;
        if (!ev.message.toolCalls) step.done = true;
        if (ev.usage) { conv.usage.input += ev.usage.input || 0; conv.usage.output += ev.usage.output || 0; renderHeader(); }
        paint();
        break;
      case 'tool_start': paint(); break;
      case 'tool_end':
        step.results[ev.call.id] = ev.result;
        if (step.msg.toolCalls.every((c) => step.results[c.id])) step.done = true;
        paint();
        break;
      case 'max_steps':
        conv.messages.push({ role: 'notice', kind: 'info', content: `Stopped after ${ev.maxSteps} steps (the limit in Settings). Send "continue" to let the agent keep going.` });
        break;
      default:
    }
  };

  const approve = settings.confirmCode
    ? (call) => new Promise((resolve) => { approvals.set(call.id, resolve); paint(); })
    : undefined;

  try {
    await runAgent({
      provider,
      system: systemPrompt(),
      messages: conv.messages,
      tools: getTools(),
      maxSteps: settings.maxSteps,
      signal: controller.signal,
      onEvent,
      approve,
      toolContext: { settings, getFiles: () => state.files.values() },
    });
  } catch (e) {
    if (e?.name === 'AbortError' || controller.signal.aborted) conv.messages.push({ role: 'notice', kind: 'info', content: 'Stopped.' });
    else conv.messages.push({ role: 'notice', kind: 'error', content: e?.message || String(e) });
  } finally {
    for (const resolve of approvals.values()) resolve(false);
    repairHistory(conv.messages);
    state.running = null;
    conv.updatedAt = Date.now();
    persist();
    setRunning(false);
    renderConversation();
  }
}

function send(text) {
  const content = (text ?? el.input.value).trim();
  if (!content || state.running) return;
  if (!current()) newConversation();
  const conv = current();
  const files = [...state.files.keys()];
  conv.messages.push(files.length ? { role: 'user', content, files } : { role: 'user', content });
  if (conv.title === 'New conversation') conv.title = content.length > 48 ? `${content.slice(0, 48)}…` : content;
  conv.updatedAt = Date.now();
  el.input.value = '';
  autoSize();
  el.empty.hidden = true;
  el.messages.insertAdjacentHTML('beforeend', userHTML(conv.messages.at(-1)));
  renderSidebar();
  renderHeader();
  scrollToBottom(true);
  run();
}

function retry() {
  const conv = current();
  if (!conv || state.running) return;
  while (conv.messages.length && conv.messages.at(-1).role === 'notice') conv.messages.pop();
  if (!conv.messages.length) return;
  renderConversation();
  run();
}

// ---------- files ----------
async function extractPdf(file) {
  const pdfjs = await import('https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.min.mjs');
  pdfjs.GlobalWorkerOptions.workerSrc = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.4.168/build/pdf.worker.min.mjs';
  const doc = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const pages = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    pages.push(`--- Page ${i} ---\n${tc.items.map((it) => it.str).join(' ')}`);
  }
  return pages.join('\n\n');
}

async function addFiles(list) {
  for (const file of list) {
    if (file.size > MAX_FILE_BYTES) { toast(`${file.name} is larger than 5 MB.`, 'error'); continue; }
    const isPdf = /\.pdf$/i.test(file.name) || file.type === 'application/pdf';
    if (!isPdf && !TEXT_TYPES.test(file.name) && !file.type.startsWith('text/')) { toast(`${file.name}: only text, code, data and PDF files are supported.`, 'error'); continue; }
    try {
      const text = isPdf ? await extractPdf(file) : await file.text();
      state.files.set(file.name, { name: file.name, type: isPdf ? 'pdf' : (file.type || 'text'), size: file.size, text });
      toast(`Attached ${file.name}`);
    } catch (e) {
      toast(`Could not read ${file.name}: ${e.message}`, 'error');
    }
  }
  renderChips();
}

// ---------- settings ----------
function fillSettingsForm() {
  const s = state.settings;
  const f = el.settingsForm;
  f.provider.innerHTML = Object.entries(PROVIDERS).map(([id, p]) => `<option value="${id}">${escapeHtml(p.label)}</option>`).join('');
  f.provider.value = s.provider;
  f.temperature.value = s.temperature;
  f.maxTokens.value = s.maxTokens;
  f.maxSteps.value = s.maxSteps;
  f.systemPrompt.value = s.systemPrompt;
  f.confirmCode.checked = !!s.confirmCode;
  f.tavilyKey.value = s.tavilyKey || '';
  f.theme.value = s.theme;
  syncProviderFields();
  $('#temp-value').textContent = s.temperature;
}

function syncProviderFields() {
  const f = el.settingsForm;
  const id = f.provider.value;
  const p = PROVIDERS[id];
  const isDemo = id === 'demo';
  $('#provider-fields').hidden = isDemo;
  $('#demo-hint').hidden = !isDemo;
  f.apiKey.value = store.getKey(id);
  f.rememberKey.checked = store.isKeyRemembered(id);
  f.model.value = state.settings.models?.[id] || (id === state.settings.provider ? state.settings.model : '') || '';
  f.model.placeholder = p.defaultModel || 'model name';
  f.baseUrl.value = p.editableBaseUrl ? (state.settings.baseUrls?.[id] || p.baseUrl) : p.baseUrl || '';
  f.baseUrl.readOnly = !p.editableBaseUrl;
  $('#base-url-row').hidden = !p.editableBaseUrl;
  const keyLink = $('#key-link');
  keyLink.hidden = !p.keyUrl;
  if (p.keyUrl) keyLink.href = p.keyUrl;
  f.apiKey.placeholder = p.needsKey ? 'Paste your API key' : 'Optional';
  $('#ollama-hint').hidden = id !== 'ollama';
  $('#model-list').innerHTML = '';
}

async function fetchModels() {
  const f = el.settingsForm;
  const id = f.provider.value;
  const btn = $('#fetch-models');
  btn.disabled = true;
  btn.textContent = 'Loading…';
  try {
    const provider = createProvider({ provider: id, apiKey: f.apiKey.value.trim(), baseUrl: f.baseUrl.value.trim(), model: f.model.value || 'x' });
    const models = await provider.listModels();
    $('#model-list').innerHTML = models.map((m) => `<option value="${escapeHtml(m)}"></option>`).join('');
    toast(`${models.length} models found. Start typing in the Model box to pick one.`);
    f.model.focus();
  } catch (e) {
    toast(e.message.split('\n')[0], 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Load models';
  }
}

function saveSettingsForm() {
  const f = el.settingsForm;
  const s = state.settings;
  const id = f.provider.value;
  s.provider = id;
  s.model = f.model.value.trim();
  s.models = { ...(s.models || {}), [id]: s.model };
  if (PROVIDERS[id].editableBaseUrl) { s.baseUrls = { ...(s.baseUrls || {}), [id]: f.baseUrl.value.trim() }; s.baseUrl = f.baseUrl.value.trim(); } else s.baseUrl = '';
  s.temperature = Number(f.temperature.value);
  s.maxTokens = Math.max(64, Number(f.maxTokens.value) || 2048);
  s.maxSteps = Math.max(1, Math.min(25, Number(f.maxSteps.value) || 8));
  s.systemPrompt = f.systemPrompt.value.trim() || store.DEFAULT_SYSTEM_PROMPT;
  s.confirmCode = f.confirmCode.checked;
  s.theme = f.theme.value;
  s.tavilyKey = f.tavilyKey.value.trim();
  if (id !== 'demo') store.setKey(id, f.apiKey.value.trim(), f.rememberKey.checked);
  store.setTavilyKey(s.tavilyKey, f.rememberKey.checked);
  store.saveSettings(s);
  applyTheme();
  renderHeader();
  toast('Settings saved');
}

// ---------- export ----------
function exportConversation() {
  const c = current();
  if (!c?.messages.length) return toast('Nothing to export yet.');
  const lines = [`# ${c.title}`, '', `_Exported from AgentForge · ${new Date().toLocaleString()} · ${providerLabel()}_`, ''];
  for (const m of c.messages) {
    if (m.role === 'user') lines.push('## You', '', m.content, '');
    else if (m.role === 'assistant') {
      if (m.content) lines.push('## AgentForge', '', m.content, '');
      for (const t of m.toolCalls || []) lines.push(`**Tool call:** \`${t.name}\``, '', '```json', JSON.stringify(t.arguments, null, 2), '```', '');
    } else if (m.role === 'tool') lines.push(`**Tool result** (\`${m.name}\`, ${m.ms ?? '?'} ms${m.isError ? ', error' : ''}):`, '', '```', m.content.slice(0, 4000), '```', '');
    else lines.push(`> ${m.content}`, '');
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `${c.title.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '_') || 'conversation'}.md` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ---------- voice ----------
function setupVoice() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { el.mic.hidden = true; return; }
  const rec = new SR();
  rec.interimResults = true;
  rec.lang = navigator.language || 'en-US';
  let base = '';
  let active = false;
  rec.onresult = (e) => {
    const text = [...e.results].map((r) => r[0].transcript).join('');
    el.input.value = `${base}${base ? ' ' : ''}${text}`;
    autoSize();
  };
  rec.onend = () => { active = false; el.mic.classList.remove('active'); };
  rec.onerror = (e) => { if (e.error !== 'aborted' && e.error !== 'no-speech') toast(`Voice input: ${e.error}`, 'error'); };
  el.mic.addEventListener('click', () => {
    if (active) return rec.stop();
    base = el.input.value.trim();
    active = true;
    el.mic.classList.add('active');
    rec.start();
  });
}

function autoSize() {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 220)}px`;
}

// ---------- events ----------
function bind() {
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.running) state.running.controller.abort();
    else send();
  });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!state.running) send(); }
  });
  el.input.addEventListener('input', autoSize);
  el.attach.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', () => { addFiles([...el.fileInput.files]); el.fileInput.value = ''; });

  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => { if (e.dataTransfer?.types?.includes('Files')) { dragDepth++; el.dropzone.hidden = false; } });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; el.dropzone.hidden = true; } });
  document.addEventListener('dragover', (e) => e.preventDefault());
  document.addEventListener('drop', (e) => { e.preventDefault(); dragDepth = 0; el.dropzone.hidden = true; if (e.dataTransfer?.files?.length) addFiles([...e.dataTransfer.files]); });

  document.addEventListener('click', (e) => {
    const t = e.target.closest('button, [data-open]');
    if (!t) return;
    if (t.dataset.open) openConversation(t.dataset.open);
    else if (t.dataset.del) deleteConversation(t.dataset.del);
    else if (t.dataset.unfile) { state.files.delete(t.dataset.unfile); renderChips(); }
    else if (t.dataset.prompt) send(t.dataset.prompt);
    else if ('retry' in t.dataset) retry();
    else if (t.dataset.approve || t.dataset.deny) {
      const id = t.dataset.approve || t.dataset.deny;
      const resolve = state.running?.approvals.get(id);
      if (resolve) { state.running.approvals.delete(id); resolve(!!t.dataset.approve); }
    } else if ('copy' in t.dataset) {
      navigator.clipboard?.writeText(t.parentElement.querySelector('code')?.innerText || '').then(() => toast('Copied'));
    }
  });

  $('#new-chat').addEventListener('click', newConversation);
  $('#export').addEventListener('click', exportConversation);
  $('#menu').addEventListener('click', () => el.sidebar.classList.toggle('open'));
  $('#scrim').addEventListener('click', () => el.sidebar.classList.remove('open'));
  $('#theme').addEventListener('click', () => {
    state.settings.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    store.saveSettings(state.settings);
    applyTheme();
    renderConversation();
  });
  const openSettings = () => { fillSettingsForm(); el.dialog.showModal(); };
  $('#open-settings').addEventListener('click', openSettings);
  el.modelBadge.addEventListener('click', openSettings);
  $('#close-settings').addEventListener('click', () => el.dialog.close());
  el.settingsForm.provider.addEventListener('change', syncProviderFields);
  el.settingsForm.temperature.addEventListener('input', (e) => { $('#temp-value').textContent = e.target.value; });
  $('#fetch-models').addEventListener('click', fetchModels);
  $('#reset-prompt').addEventListener('click', () => { el.settingsForm.systemPrompt.value = store.DEFAULT_SYSTEM_PROMPT; });
  $('#toggle-key').addEventListener('click', () => { const k = el.settingsForm.apiKey; k.type = k.type === 'password' ? 'text' : 'password'; });
  el.settingsForm.addEventListener('submit', (e) => { e.preventDefault(); saveSettingsForm(); el.dialog.close(); });
  $('#clear-data').addEventListener('click', () => {
    if (!confirm('Delete all conversations, settings and saved keys from this browser?')) return;
    store.clearAll();
    location.reload();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (state.settings.theme === 'system') applyTheme(); });
}

// ---------- boot ----------
function boot() {
  applyTheme();
  bind();
  setupVoice();
  const recent = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (recent) { state.currentId = recent.id; renderConversation(); } else newConversation();
  setRunning(false);
  renderChips();
  document.body.classList.add('ready');
}

boot();
