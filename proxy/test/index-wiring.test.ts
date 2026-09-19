// index.ts binds a port and loads the whitelist on import, so the rules that live
// at its call sites are checked against the source instead. Each assertion guards
// one rule that feed-cache.ts cannot enforce on its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

function guardsOf(method: string, path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = new RegExp(`app\\.${method}\\('${escaped}',((?:\\s*\\w+,)*)\\s*async`).exec(source);
  assert.ok(match, `route ${method.toUpperCase()} ${path} not found`);
  return match[1].replace(/\s+/g, ' ').trim();
}

function routeBody(method: string, path: string): string {
  const start = source.indexOf(`app.${method}('${path}'`);
  assert.ok(start >= 0, `route ${method.toUpperCase()} ${path} not found`);
  return source.slice(start, source.indexOf('\n});', start));
}

test('the refresh route is guarded exactly like the whitelist admin routes', () => {
  const refresh = guardsOf('post', '/admin/feeds/:hash/refresh');
  assert.equal(refresh, 'requireUploadSecret, adminLimiter,');
  assert.equal(refresh, guardsOf('post', '/admin/whitelist'));
  assert.equal(refresh, guardsOf('delete', '/admin/whitelist/:hash'));
});

test('the refresh route rejects a malformed hash before touching the cache', () => {
  const body = routeBody('post', '/admin/feeds/:hash/refresh');
  const validate = body.indexOf('if (!isManifestHash(hash))');
  const reject = body.indexOf('res.status(400)');
  const refresh = body.indexOf('refreshFeedManifest(');
  assert.ok(validate >= 0 && reject > validate && refresh > reject, 'validation must come first');
});

test('the refresh route wires the real owner allowlist, resolver and whitelist', () => {
  const body = routeBody('post', '/admin/feeds/:hash/refresh');
  assert.match(body, /isAllowedOwner: \(owner\) => ALLOWED_FEED_OWNERS\.has\(owner\.toLowerCase\(\)\)/);
  assert.match(body, /^\s*resolveFeed,$/m);
  assert.match(body, /await whitelist\.add\(contentRef\)/);
});

test('the /bzz 404 fallback caches with viaFallback, so it never pins a ref for 24h', () => {
  const start = source.indexOf('if (response.status === 404) {');
  const end = source.indexOf('res.status(404).send(bodyText);', start);
  assert.ok(start >= 0 && end > start, 'could not find the /bzz 404 fallback block');
  const writes = source.slice(start, end).match(/feedCache\.set\([^)]*\)/g) ?? [];
  assert.ok(writes.length > 0, 'the fallback no longer caches through feedCache.set');
  for (const write of writes) {
    assert.match(write, /viaFallback:\s*true/);
  }
});

test('detected manifests are still registered for owner/topic lookup', () => {
  assert.match(source, /feedCache\.registerDetected\(hash, feedInfo\)/);
});

test('index.ts computes no expiry of its own; every TTL comes from feed-cache.ts', () => {
  assert.doesNotMatch(source, /expires/);
  assert.doesNotMatch(source, /Date\.now\(\)\s*\+/);
  assert.doesNotMatch(source, /24 \* 60 \* 60 \* 1000/);
});
