import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileTool, createChartTool, getDatetimeTool, ALL_TOOLS } from '../src/tools/index.js';
import { webSearchTool } from '../src/tools/web-search.js';

const files = [{ name: 'data.csv', type: 'text/csv', text: 'a,b\n1,2\n3,4\n' }];
const ctx = { getFiles: () => files, settings: {} };

test('every tool has a valid JSON-schema definition', () => {
  const names = new Set();
  for (const t of ALL_TOOLS) {
    assert.match(t.name, /^[a-z_]+$/);
    assert.ok(!names.has(t.name)); names.add(t.name);
    assert.ok(t.description.length > 20);
    assert.equal(t.parameters.type, 'object');
    assert.equal(typeof t.run, 'function');
  }
});

test('read_file lists, reads and pages', async () => {
  const list = JSON.parse((await readFileTool.run({}, ctx)).content);
  assert.deepEqual(list.files, [{ name: 'data.csv', type: 'text/csv', chars: 12 }]);
  const page = JSON.parse((await readFileTool.run({ name: 'DATA.CSV', offset: 4, max_chars: 100 }, ctx)).content);
  assert.equal(page.content, '1,2\n3,4\n');
  await assert.rejects(readFileTool.run({ name: 'nope.txt' }, ctx), /No attached file/);
});

test('create_chart returns a display payload', async () => {
  const out = await createChartTool.run({ type: 'pie', title: 'Share', labels: ['a', 'b'], datasets: [{ data: ['1', 2] }] });
  assert.equal(out.display.kind, 'chart');
  assert.equal(out.display.config.type, 'pie');
  assert.deepEqual(out.display.config.data.datasets[0].data, [1, 2]);
  assert.equal(out.display.config.data.datasets[0].backgroundColor.length, 2);
  await assert.rejects(createChartTool.run({ datasets: [] }), /non-empty/);
});

test('get_datetime returns ISO and time zone', async () => {
  const d = JSON.parse((await getDatetimeTool.run()).content);
  assert.ok(!Number.isNaN(Date.parse(d.iso)));
  assert.ok(d.timeZone);
});

test('web_search uses Wikipedia without a key (mocked fetch)', async () => {
  const realFetch = globalThis.fetch;
  let url;
  globalThis.fetch = async (u) => {
    url = String(u);
    return new Response(JSON.stringify({ query: { pages: {
      2: { index: 2, title: 'B', fullurl: 'https://en.wikipedia.org/wiki/B', extract: 'Second' },
      1: { index: 1, title: 'A', fullurl: 'https://en.wikipedia.org/wiki/A', extract: 'First <b>bold</b>' },
    } } }));
  };
  try {
    const out = JSON.parse((await webSearchTool.run({ query: 'transformers' }, ctx)).content);
    assert.match(url, /en\.wikipedia\.org.*gsrsearch=transformers.*origin=\*/);
    assert.equal(out.source, 'Wikipedia');
    assert.deepEqual(out.results.map((r) => r.title), ['A', 'B']);
    assert.equal(out.results[0].snippet, 'First bold');
  } finally { globalThis.fetch = realFetch; }
});
