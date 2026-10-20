/** run_javascript and run_python: sandboxed code execution in Web Workers. */
const workerUrl = (file) => new URL(file, import.meta.url);

export const runJavascriptTool = {
  name: 'run_javascript',
  description: 'Run JavaScript in an isolated Web Worker (no DOM, 10 s limit). Use for calculations, data transforms and quick checks. console.log output is captured; use `return` to send back a value. Top-level await works.',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string', description: 'JavaScript source code' } },
    required: ['code'],
  },
  requiresApproval: true,
  run({ code }, ctx = {}) {
    if (!code) throw new Error('code is required');
    return new Promise((resolve, reject) => {
      const worker = new Worker(workerUrl('./js-worker.js'));
      const done = (fn) => { clearTimeout(timer); worker.terminate(); ctx.signal?.removeEventListener('abort', onAbort); fn(); };
      const timer = setTimeout(() => done(() => reject(new Error('Timed out after 10 s (possible infinite loop). The worker was terminated.'))), 10_000);
      const onAbort = () => done(() => reject(new Error('Stopped by user')));
      ctx.signal?.addEventListener('abort', onAbort);
      worker.onmessage = ({ data }) => done(() => (data.ok
        ? resolve({ content: JSON.stringify({ stdout: data.stdout, result: data.result }, null, 2) })
        : reject(new Error(`${data.error}${data.stdout ? `\nOutput before the error:\n${data.stdout}` : ''}`))));
      worker.onerror = (e) => done(() => reject(new Error(e.message || 'Worker error')));
      worker.postMessage({ code });
    });
  },
};

let pyWorker = null;
let pyCounter = 0;

export const runPythonTool = {
  name: 'run_python',
  description: 'Run Python 3 (Pyodide/WebAssembly) in the browser. Standard library plus packages like numpy and pandas load automatically from imports. Files the user attached are available under /data/. print() output is captured; the value of the last expression is returned. State persists between calls. The first call downloads the runtime (~10 MB).',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string', description: 'Python source code' } },
    required: ['code'],
  },
  requiresApproval: true,
  run({ code }, ctx = {}) {
    if (!code) throw new Error('code is required');
    pyWorker ||= new Worker(workerUrl('./python-worker.js'));
    const worker = pyWorker;
    const id = ++pyCounter;
    const files = [...(ctx.getFiles?.() || [])].map((f) => ({ name: f.name, text: f.text }));
    return new Promise((resolve, reject) => {
      const reset = () => { worker.terminate(); if (pyWorker === worker) pyWorker = null; };
      const cleanup = () => { clearTimeout(timer); worker.removeEventListener('message', onMessage); ctx.signal?.removeEventListener('abort', onAbort); };
      const timer = setTimeout(() => { cleanup(); reset(); reject(new Error('Timed out after 120 s. The Python runtime was reset.')); }, 120_000);
      const onAbort = () => { cleanup(); reset(); reject(new Error('Stopped by user')); };
      const onMessage = ({ data }) => {
        if (data.id !== id) return;
        cleanup();
        if (data.ok) resolve({ content: JSON.stringify({ stdout: data.stdout, result: data.result }, null, 2) });
        else reject(new Error(`${data.error}${data.stdout ? `\nOutput before the error:\n${data.stdout}` : ''}`));
      };
      ctx.signal?.addEventListener('abort', onAbort);
      worker.addEventListener('message', onMessage);
      worker.onerror = (e) => { cleanup(); reset(); reject(new Error(e.message || 'Could not start Python (is cdn.jsdelivr.net reachable?)')); };
      worker.postMessage({ id, code, files });
    });
  },
};
