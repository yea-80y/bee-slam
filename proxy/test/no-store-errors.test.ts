import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import express from 'express';
import { noStoreOnErrors } from '../src/no-store-errors.js';

// One real server, one route per way a response leaves the proxy.
const app = express();
app.use(noStoreOnErrors);
app.get('/json-404', (_req, res) => { res.status(404).json({ error: 'not found' }); });
app.get('/send-500', (_req, res) => { res.status(500).send('boom'); });
app.get('/sendStatus-429', (_req, res) => { res.sendStatus(429); });
app.get('/piped-404', (_req, res) => {
  // the /bzz shape: copy upstream headers, set the status, pipe the body
  res.setHeader('Cache-Control', 'max-age=14400');
  res.status(404);
  Readable.from(['{"code":404}']).pipe(res);
});
app.get('/writehead-object', (_req, res) => {
  res.writeHead(403, { 'Cache-Control': 'public, max-age=14400', 'X-Chunk-Gate': 'not-whitelisted' });
  res.end();
});
app.get('/writehead-array', (_req, res) => {
  res.writeHead(502, 'Bad Gateway', ['cache-control', 'max-age=60', 'x-kept', 'yes']);
  res.end();
});
app.get('/ok', (_req, res) => { res.json({ ok: true }); });
app.get('/ok-cached', (_req, res) => { res.setHeader('Cache-Control', 'public, max-age=60'); res.send('fine'); });
app.get('/redirect', (_req, res) => { res.redirect(302, '/ok'); });

const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
after(() => server.close());

async function get(path: string): Promise<Response> {
  const r = await fetch(base + path, { redirect: 'manual' });
  await r.arrayBuffer();
  return r;
}

for (const [path, status] of [
  ['/json-404', 404], ['/send-500', 500], ['/sendStatus-429', 429], ['/piped-404', 404],
  ['/writehead-object', 403], ['/writehead-array', 502], ['/no-such-route', 404],
] as const) {
  test(`${status} via ${path}: never cached, whatever the route set`, async () => {
    const r = await get(path);
    assert.equal(r.status, status);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });
}

test('other headers passed to writeHead survive', async () => {
  assert.equal((await get('/writehead-object')).headers.get('x-chunk-gate'), 'not-whitelisted');
  assert.equal((await get('/writehead-array')).headers.get('x-kept'), 'yes');
});

test('successes and redirects are left alone', async () => {
  assert.equal((await get('/ok')).headers.get('cache-control'), null);
  assert.equal((await get('/ok-cached')).headers.get('cache-control'), 'public, max-age=60');
  const r = await get('/redirect');
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('cache-control'), null);
});

test('index.ts installs it before any other middleware or route', () => {
  const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
  const first = /\napp\.(use|get|post|put|patch|delete|all)\(([^\n]*)/.exec(source);
  assert.ok(first, 'no app.use / route found');
  assert.equal(first[0].trim(), 'app.use(noStoreOnErrors);');
});
