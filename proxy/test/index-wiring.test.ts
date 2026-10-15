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
  assert.equal(refresh, 'adminLimiter, requireUploadSecret,');
  assert.equal(refresh, guardsOf('post', '/admin/whitelist'));
  assert.equal(refresh, guardsOf('delete', '/admin/whitelist/:hash'));
});

test('every admin route counts the attempt BEFORE it checks the secret', () => {
  // The other way round, a wrong secret is refused before the limiter sees it,
  // so guessing costs nothing against the admin budget.
  const admin = [
    ['post', '/stamps/:amount/:depth'],
    ['patch', '/stamps/topup/:batchId/:amount'],
    ['patch', '/stamps/dilute/:batchId/:depth'],
    ['post', '/admin/whitelist'],
    ['delete', '/admin/whitelist/:hash'],
    ['post', '/admin/feeds/:hash/refresh'],
  ] as const;
  for (const [method, path] of admin) {
    assert.equal(guardsOf(method, path), 'adminLimiter, requireUploadSecret,', `${method} ${path}`);
  }
  // The two sync/no-param admin routes, matched loosely (no `async` on the GET).
  assert.match(source, /app\.get\('\/admin\/whitelist', adminLimiter, requireUploadSecret,/);
  assert.match(source, /app\.delete\('\/admin\/whitelist', adminLimiter, requireUploadSecret,/);
  assert.doesNotMatch(source, /requireUploadSecret, adminLimiter/, 'no admin route may check the secret first');
});

test('the secret is compared in constant time, not with !==', () => {
  const guard = source.slice(source.indexOf('function requireUploadSecret('), source.indexOf('\n}\n', source.indexOf('function requireUploadSecret(')));
  assert.match(guard, /secretMatches\(req\.headers\['x-upload-secret'\], uploadSecret\)/);
  assert.doesNotMatch(guard, /!==\s*uploadSecret|===\s*uploadSecret/);
  assert.doesNotMatch(source, /172\.x from Docker server\) are exempt/, 'the false exemption comment is gone');
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
  assert.match(body, /^\s*resolveLatest,$/m);
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

test('bee\'s feed lookup is only a hint: nothing caches it without verifying and walking forward', () => {
  assert.doesNotMatch(source, /\bresolveFeed\(/, 'the old trust-bee resolver is gone');
  const hintCalls = source.match(/beeFeedHint\(/g) ?? [];
  assert.equal(hintCalls.length, 2, 'declared once, called once (inside resolveLatest)');
  const resolveLatest = source.slice(source.indexOf('async function resolveLatest('), source.indexOf('\n}\n', source.indexOf('async function resolveLatest(')));
  assert.match(resolveLatest, /beeFeedHint\(/);
  assert.match(resolveLatest, /readFeedUpdate\(walk, hint\.index\)/, 'the hint is verified before use');
  assert.match(resolveLatest, /walkFeedForward\(/);
});

test('every feed cache write carries its index, and serves what the cache holds after it', () => {
  const writes = source.match(/feedCache\.set\([^;]*\);/g) ?? [];
  assert.ok(writes.length >= 3, `found ${writes.length} writes`);
  for (const w of writes) assert.match(w, /point\.index\)/, w);
  for (const site of ['Registry fast-path', 'attempting direct feed resolution']) {
    const at = source.indexOf(site);
    const window = source.slice(Math.max(0, at - 1200), at + 1200);
    assert.match(window, /feedCache\.latest\(hash\)!\.ref/, `${site}: serves the high-water ref, not the raw answer`);
  }
});

test('every resolve starts from the high-water mark, or runs inline only when none is held', () => {
  const uses = source.split('\n').filter((l) => /resolveLatest\(/.test(l) && !/function resolveLatest\(/.test(l));
  assert.ok(uses.length >= 4, `found ${uses.length}`);
  for (const c of uses) {
    if (c.includes('{ inline: true }')) assert.match(c, /mark \?\? \(await resolveLatest\(\w+, undefined, undefined, \{ inline: true \}\)\)/, c);
    else assert.match(c, /resolveLatest\(info, feedCache\.latest\(/, c);
  }
});

test('an expired but held feed is served from its mark, and moved forward in the background', () => {
  for (const site of ['Registry fast-path', 'attempting direct feed resolution']) {
    const at = source.indexOf(site);
    const window = source.slice(Math.max(0, at - 1400), at + 1400);
    assert.match(window, /const mark = feedCache\.latest\(hash\);\n\s*if \(mark\) refreshInBackground\(hash,/, site);
    assert.match(window, /if \(!mark\) feedCache\.set\(hash, point\.ref, /, `${site}: a served mark is not re-cached as if fresh`);
  }
  const bg = source.slice(source.indexOf('function refreshInBackground('), source.indexOf('\n}\n', source.indexOf('function refreshInBackground(')));
  assert.match(bg, /if \(refreshing\.has\(key\)\) return;/, 'one re-resolve per manifest at a time');
  assert.match(bg, /resolveLatest\(info, feedCache\.latest\(key\)\)/);
  assert.match(bg, /\.finally\(\(\) => refreshing\.delete\(key\)\)/);
});

test('on a request, bee\'s lookup is time-boxed and nothing walks the whole feed from zero', () => {
  const rl = source.slice(source.indexOf('async function resolveLatest('), source.indexOf('\n}\n', source.indexOf('async function resolveLatest(')));
  assert.match(rl, /beeFeedHint\(info\.owner, info\.topic, opts\.inline \? REQUEST_HINT_TIMEOUT_MS : BEE_REQUEST_TIMEOUT\)/);
  assert.match(rl, /if \(!base && opts\.inline\) return null;/);
  assert.ok(rl.indexOf('if (!base && opts.inline) return null;') < rl.indexOf('walkFeedForward('));
});

test('marks are saved atomically next to the whitelist and restored before the prewarm', () => {
  assert.match(source, /join\(dirname\(whitelistPath\), 'feed-marks\.json'\)/);
  const save = source.slice(source.indexOf('function scheduleMarksWrite('), source.indexOf('\n}\n', source.indexOf('function scheduleMarksWrite(')));
  assert.match(save, /writeFile\(tmp, JSON\.stringify\(feedCache\.exportMarks\(\)\), \{ mode: 0o600 \}\)/);
  assert.match(save, /rename\(tmp, marksPath\)/);
  const start = source.slice(source.indexOf('async function start('));
  assert.ok(start.indexOf('loadMarks();') > 0 && start.indexOf('loadMarks();') < start.indexOf('await prewarmRegistryFeeds();'));
  assert.match(source, /new FeedCache\(\{ onMarkAdvance: \(\) => scheduleMarksWrite\(\) \}\)/);
});

test('the refresh route validates a deploy index before anything else, and passes it on', () => {
  const body = routeBody('post', '/admin/feeds/:hash/refresh');
  const check = body.indexOf('Number.isSafeInteger(expectIndex)');
  const call = body.indexOf('refreshFeedManifest(');
  assert.ok(check > 0 && call > check, 'index validated before the refresh runs');
  assert.match(body, /\}, expectIndex as number \| undefined\);/);
});

test('the request log names the site a request came from, through requestOrigin only', () => {
  const log = source.slice(source.indexOf('// Logging middleware'), source.indexOf('next();', source.indexOf('// Logging middleware')));
  assert.match(log, /const origin = requestOrigin\(req\.headers\.origin, req\.headers\.referer\);/);
  assert.match(log, /\[ip=\$\{ip\} local=\$\{isLocal\} origin=\$\{origin\}\]/, 'appended, so existing ip/local greps keep working');
  assert.doesNotMatch(log, /req\.headers\.(origin|referer)\}/, 'no raw header reaches the log');
});

test('shutdown folds the whitelist log into the snapshot before closing the server', () => {
  // server.close can wait out the stop timeout on keep-alive connections, and a rollback
  // to a build without the log reads whitelist.json alone.
  const start = source.indexOf('const shutdown = (): void => {');
  assert.ok(start >= 0, 'shutdown handler not found');
  const body = source.slice(start, source.indexOf('\n      };', start));
  assert.match(source, /const fold = \(\): Promise<void> =>\s*whitelist\.flush\(\)/);
  const close = body.indexOf('server.close(');
  const first = body.indexOf('fold()');
  assert.ok(first >= 0 && first < close, 'server.close runs before the first fold');
  // And again once requests have drained, since one may have added meanwhile.
  const second = body.indexOf('fold()', close);
  assert.ok(second > close && second < body.indexOf('process.exit(0)'), 'no fold between draining and exit');
  assert.match(source, /process\.on\('SIGTERM', shutdown\);/);
  assert.match(source, /process\.on\('SIGINT', shutdown\);/);
});

test('an empty start needs WHITELIST_ALLOW_EMPTY=1, never a default', () => {
  // A wrong volume mount looks exactly like a fresh install.
  assert.match(source, /new WhitelistManager\(whitelistPath, \{ allowEmptyStart: process\.env\.WHITELIST_ALLOW_EMPTY === '1' \}\)/);
});
