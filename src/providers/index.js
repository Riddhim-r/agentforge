import { createOpenAIProvider } from './openai.js';
import { createAnthropicProvider } from './anthropic.js';
import { createDemoProvider } from './demo.js';

/**
 * Provider presets. Everything except Anthropic and Demo speaks the
 * OpenAI Chat Completions format, so one adapter covers them all.
 */
export const PROVIDERS = {
  demo: { label: 'Demo (no key needed)', kind: 'demo', defaultModel: 'scripted-planner', needsKey: false },
  openrouter: {
    label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', defaultModel: 'openai/gpt-4o-mini',
    keyUrl: 'https://openrouter.ai/keys', streamUsage: true, needsKey: true,
  },
  openai: { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', defaultModel: 'gpt-4o-mini', keyUrl: 'https://platform.openai.com/api-keys', streamUsage: true, needsKey: true },
  anthropic: { label: 'Anthropic', kind: 'anthropic', defaultModel: 'claude-haiku-4-5', keyUrl: 'https://console.anthropic.com/settings/keys', needsKey: true },
  gemini: {
    label: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', defaultModel: 'gemini-2.5-flash',
    keyUrl: 'https://aistudio.google.com/apikey', needsKey: true,
  },
  groq: { label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', defaultModel: 'llama-3.3-70b-versatile', keyUrl: 'https://console.groq.com/keys', streamUsage: true, needsKey: true },
  aipipe: { label: 'AI Pipe', kind: 'openai', baseUrl: 'https://aipipe.org/openrouter/v1', defaultModel: 'openai/gpt-4o-mini', keyUrl: 'https://aipipe.org/login', needsKey: true },
  ollama: { label: 'Ollama (local)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', defaultModel: 'llama3.2', needsKey: false, editableBaseUrl: true },
  custom: { label: 'Custom (OpenAI-compatible)', kind: 'openai', baseUrl: '', defaultModel: '', needsKey: false, editableBaseUrl: true },
};

export function createProvider({ provider, model, baseUrl, apiKey, temperature, maxTokens }, extras = {}) {
  const preset = PROVIDERS[provider] || PROVIDERS.demo;
  const resolvedModel = model || preset.defaultModel;
  if (preset.kind === 'demo') return createDemoProvider(extras);
  if (preset.needsKey && !apiKey) throw new Error(`Add your ${preset.label} API key in Settings, or switch to Demo mode.`);
  if (preset.kind === 'anthropic') return createAnthropicProvider({ apiKey, model: resolvedModel, temperature, maxTokens });
  const url = (preset.editableBaseUrl && baseUrl) || preset.baseUrl;
  if (!url) throw new Error('Set a base URL for the custom provider in Settings.');
  const extraHeaders = provider === 'openrouter' ? { 'HTTP-Referer': globalThis.location?.origin || 'https://agentforge.app', 'X-Title': 'AgentForge' } : {};
  return createOpenAIProvider({ label: preset.label, baseUrl: url, apiKey, model: resolvedModel, temperature, maxTokens, extraHeaders, streamUsage: preset.streamUsage });
}
