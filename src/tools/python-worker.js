// Python via Pyodide (CPython compiled to WebAssembly). Loaded on first use and kept warm.
const PYODIDE = 'https://cdn.jsdelivr.net/pyodide/v0.26.2/full/';
importScripts(`${PYODIDE}pyodide.js`);

let pyodidePromise = null;
const boot = () => (pyodidePromise ||= loadPyodide({ indexURL: PYODIDE }));

self.onmessage = async (event) => {
  const { id, code, files = [] } = event.data;
  const out = [];
  try {
    const py = await boot();
    py.setStdout({ batched: (s) => out.push(s) });
    py.setStderr({ batched: (s) => out.push(`[stderr] ${s}`) });
    py.FS.mkdirTree('/data');
    for (const f of files) py.FS.writeFile(`/data/${f.name.replace(/[\\/]/g, '_')}`, f.text);
    await py.loadPackagesFromImports(code);
    const value = await py.runPythonAsync(code);
    let result = null;
    if (value !== undefined && value !== null) {
      result = value.toJs ? String(value.toJs({ dict_converter: Object.fromEntries })) : value;
      value.destroy?.();
    }
    self.postMessage({ id, ok: true, stdout: out.join('\n'), result });
  } catch (err) {
    self.postMessage({ id, ok: false, stdout: out.join('\n'), error: String(err?.message || err) });
  }
};
