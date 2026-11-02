// copyBeeHeaders (bee-headers.ts): bee's CORS headers never replace the proxy's.
//
// MUTATION: copy access-control-* through, drop the skip hook, or take a
// RateLimit header out of EXPOSED_HEADERS, and a case below goes red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { copyBeeHeaders, EXPOSED_HEADERS } from '../src/bee-headers.js';

test("bee's CORS headers are not copied; everything else is", () => {
  const from = new Headers({
    'Access-Control-Expose-Headers': 'Content-Disposition',
    'access-control-allow-origin': 'https://bee.example',
    'content-type': 'application/octet-stream',
    etag: '"abc"',
  });
  const set: Record<string, string> = {};
  copyBeeHeaders(from, (k, v) => (set[k.toLowerCase()] = v));
  assert.deepEqual(set, { 'content-type': 'application/octet-stream', etag: '"abc"' });
});

test('a caller can skip more headers', () => {
  const set: string[] = [];
  copyBeeHeaders(new Headers({ 'content-length': '5', 'content-encoding': 'gzip', etag: 'x' }), (k) => set.push(k.toLowerCase()), (k) => k.startsWith('content-'));
  assert.deepEqual(set, ['etag']);
});

test('a cross-origin reader can see the gate tag, the budget and the retry time', () => {
  for (const h of ['X-Chunk-Gate', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset', 'Retry-After']) {
    assert.ok(EXPOSED_HEADERS.split(', ').includes(h), `${h} exposed`);
  }
});

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

test('no route copies bee headers any other way', () => {
  assert.doesNotMatch(source, /headers\.forEach\(/);
  assert.match(source, /res\.setHeader\('Access-Control-Expose-Headers', EXPOSED_HEADERS\);/);
});
