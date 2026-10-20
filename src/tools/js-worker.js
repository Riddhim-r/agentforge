// Runs untrusted JavaScript off the main thread. The page terminates this worker on timeout.
const format = (v) => {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2) ?? String(v); } catch { return String(v); }
};

self.onmessage = async (event) => {
  const { code } = event.data;
  const logs = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    console[level] = (...args) => logs.push((level === 'log' || level === 'info' ? '' : `[${level}] `) + args.map(format).join(' '));
  }
  try {
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    let fn;
    try { fn = new AsyncFunction(`return (${code}\n);`); } catch { fn = new AsyncFunction(code); }
    const value = await fn();
    let result = value;
    try { result = value === undefined ? null : JSON.parse(JSON.stringify(value)); } catch { result = String(value); }
    self.postMessage({ ok: true, stdout: logs.join('\n'), result });
  } catch (err) {
    self.postMessage({ ok: false, stdout: logs.join('\n'), error: `${err?.name || 'Error'}: ${err?.message || err}` });
  }
};
