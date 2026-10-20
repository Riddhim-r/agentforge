/**
 * Persistence. Conversations and settings live in localStorage.
 * API keys live in sessionStorage (cleared when the tab closes) unless the
 * user ticks "Remember on this device".
 */
const NS = 'agentforge:';

const read = (store, key, fallback) => {
  try {
    const raw = store.getItem(NS + key);
    return raw === null ? fallback : JSON.parse(raw);
  } catch { return fallback; }
};
const write = (store, key, value) => {
  try { store.setItem(NS + key, JSON.stringify(value)); return true; } catch { return false; }
};
const remove = (store, key) => { try { store.removeItem(NS + key); } catch { /* ignore */ } };

export const DEFAULT_SYSTEM_PROMPT = `You are AgentForge, an AI agent running entirely in the user's browser.

You can call tools. Use them whenever they give a better answer than memory alone:
- web_search for anything current or factual you are unsure about. Cite the URLs you use.
- run_javascript or run_python to calculate, transform data or check code, instead of doing maths in your head.
- read_file to read files the user attached.
- create_chart when a chart helps the user see data.
- get_datetime when the answer depends on today's date.

Think about which tool fits, call it, read the result, then answer clearly and concisely in Markdown.`;

export const DEFAULT_SETTINGS = {
  provider: 'preview',
  model: '',
  baseUrl: '',
  temperature: 0.4,
  maxTokens: 2048,
  maxSteps: 8,
  systemPrompt: DEFAULT_SYSTEM_PROMPT,
  confirmCode: false,
  tavilyKey: '',
  theme: 'system',
  models: {},
};

export function loadSettings() {
  const saved = read(localStorage, 'settings', {});
  const s = { ...DEFAULT_SETTINGS, ...saved };
  if (s.provider === 'demo') s.provider = 'preview'; // renamed in v1.1
  s.tavilyKey = read(sessionStorage, 'tavily', null) ?? read(localStorage, 'tavily', '');
  return s;
}

export function saveSettings(settings) {
  const { tavilyKey, ...rest } = settings;
  write(localStorage, 'settings', rest);
}

export function getKey(provider) {
  return read(sessionStorage, `key:${provider}`, null) ?? read(localStorage, `key:${provider}`, '');
}
export function isKeyRemembered(provider) {
  return !!read(localStorage, `key:${provider}`, '');
}
export function setKey(provider, key, remember) {
  remove(sessionStorage, `key:${provider}`);
  remove(localStorage, `key:${provider}`);
  if (!key) return;
  write(remember ? localStorage : sessionStorage, `key:${provider}`, key);
}
export function setTavilyKey(key, remember) {
  remove(sessionStorage, 'tavily');
  remove(localStorage, 'tavily');
  if (key) write(remember ? localStorage : sessionStorage, 'tavily', key);
}

export const loadConversations = () => read(localStorage, 'conversations', []);
export function saveConversations(conversations) {
  // Keep the 50 most recent; drop bulky chart configs first if storage is full.
  const list = [...conversations].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 50);
  if (!write(localStorage, 'conversations', list)) {
    const slim = list.slice(0, 20).map((c) => ({ ...c, messages: c.messages.map(({ display, ...m }) => m) }));
    write(localStorage, 'conversations', slim);
  }
}

export const hasSeenWelcome = () => !!read(localStorage, 'welcomed', false);
export const markWelcomed = () => write(localStorage, 'welcomed', true);

export function clearAll() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      Object.keys(store).filter((k) => k.startsWith(NS)).forEach((k) => store.removeItem(k));
    } catch { /* ignore */ }
  }
}
