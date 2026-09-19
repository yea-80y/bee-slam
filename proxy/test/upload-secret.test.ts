import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secretMatches } from '../src/upload-secret.js';

const SECRET = 'a3f1c9e0b7d24c5e8f6a1b2c3d4e5f60';

test('the right secret matches', () => {
  assert.equal(secretMatches(SECRET, SECRET), true);
});

test('anything else does not: wrong, prefix, extended, case, empty, missing', () => {
  for (const given of ['wrong', SECRET.slice(0, -1), `${SECRET}0`, SECRET.toUpperCase(), '', undefined, null]) {
    assert.equal(secretMatches(given, SECRET), false, `accepted ${String(given)}`);
  }
});

test('a header sent twice (an array) is refused, never joined', () => {
  assert.equal(secretMatches([SECRET, SECRET], SECRET), false);
  assert.equal(secretMatches([SECRET], SECRET), false);
});

test('an unset expected secret matches nothing, not even an empty header', () => {
  // requireUploadSecret treats "unset" as dev mode before it gets here; this is
  // the belt to that brace, so no caller can ever authenticate against ''.
  assert.equal(secretMatches('', ''), false);
});

test('unequal lengths neither throw nor short-circuit to a different code path', () => {
  assert.doesNotThrow(() => secretMatches('x'.repeat(10_000), SECRET));
  assert.equal(secretMatches('x'.repeat(10_000), SECRET), false);
});

test('the comparison is timingSafeEqual over digests - never === on the inputs', async () => {
  // Timing cannot be asserted from a unit test, so the SHAPE is pinned instead:
  // a plain `given === expected` passes every behaviour test above.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/upload-secret.ts', import.meta.url), 'utf8')
    .replace(/\/\/.*$/gm, '');
  assert.match(src, /return timingSafeEqual\(a, b\);/);
  assert.match(src, /createHash\('sha256'\)\.update\(given, 'utf8'\)\.digest\(\)/);
  assert.doesNotMatch(src, /given\s*[!=]==\s*expected|expected\s*[!=]==\s*given/);
});
