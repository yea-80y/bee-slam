import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FEED_CACHE_TTL_MS,
  FeedCache,
  SEEDED_FEED_CACHE_TTL_MS,
  SEEDED_FEED_MANIFESTS,
  isManifestHash,
  isSeededFeedManifest,
  refreshFeedManifest,
  ttlFor,
  type FeedCacheEntry,
  type FeedPoint,
  type RefreshDeps,
} from '../src/feed-cache.js';

const PLATFORM_OWNER = 'f8af4904c6e4f08ce5f7deab7f01221280b23a80';
// woco-events-v1, the manifest behind woco.eth.limo
const SEEDED = 'd66c6ff7650a468c2fd98439c8f04547b5b8a4b933d349ff16db1d0b00c23adc';
const SEEDED_TOPIC = 'aef7b3bb8b50eff1516536370de7ab15de8e24592a35d2abd9977d00ebb650b2';
// Stands in for an organiser site's feed manifest: platform-owned, but detected, not seeded.
const DETECTED = 'a'.repeat(64);
const DETECTED_TOPIC = 'd'.repeat(64);
const UNKNOWN = 'b'.repeat(64);
const OLD_REF = '1'.repeat(64);
const NEW_REF = '2'.repeat(64);

function setup() {
  let t = 1_700_000_000_000;
  const store = new Map<string, FeedCacheEntry>();
  const cache = new FeedCache({ store, now: () => t });
  return {
    cache,
    store,
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

function fakeDeps(resolved: FeedPoint | null = { index: 7, ref: NEW_REF }) {
  const calls = {
    resolved: [] as Array<[string, string]>,
    from: [] as Array<FeedPoint | undefined>,
    expect: [] as Array<number | undefined>,
    whitelisted: [] as string[],
  };
  const deps: RefreshDeps = {
    isAllowedOwner: (owner) => owner.toLowerCase() === PLATFORM_OWNER,
    resolveLatest: async (info, from, expectIndex) => {
      calls.resolved.push([info.owner, info.topic]);
      calls.from.push(from);
      calls.expect.push(expectIndex);
      return resolved;
    },
    whitelist: async (contentRef) => {
      calls.whitelisted.push(contentRef);
    },
  };
  return { deps, calls };
}

describe('TTL rules', () => {
  test('a seeded manifest is cached for 24h', () => {
    const { cache, advance } = setup();
    assert.equal(ttlFor(SEEDED), SEEDED_FEED_CACHE_TTL_MS);
    assert.equal(SEEDED_FEED_CACHE_TTL_MS, 24 * 60 * 60 * 1000);
    assert.equal(cache.set(SEEDED, OLD_REF), SEEDED_FEED_CACHE_TTL_MS);
    advance(SEEDED_FEED_CACHE_TTL_MS - 1);
    assert.equal(cache.get(SEEDED), OLD_REF);
    advance(1);
    assert.equal(cache.get(SEEDED), null);
  });

  test('a seeded manifest is recognised whatever its case', () => {
    assert.ok(isSeededFeedManifest(SEEDED.toUpperCase()));
    assert.equal(ttlFor(SEEDED.toUpperCase()), SEEDED_FEED_CACHE_TTL_MS);
  });

  test('a detected manifest is cached for 60s, even when the platform owns it', () => {
    const { cache, advance } = setup();
    cache.registerDetected(DETECTED, { owner: PLATFORM_OWNER, topic: DETECTED_TOPIC });
    assert.ok(cache.lookup(DETECTED), 'detection must still register the manifest');
    assert.equal(isSeededFeedManifest(DETECTED), false);
    assert.equal(ttlFor(DETECTED), FEED_CACHE_TTL_MS);
    assert.equal(FEED_CACHE_TTL_MS, 60 * 1000);
    assert.equal(cache.set(DETECTED, OLD_REF), FEED_CACHE_TTL_MS);
    advance(FEED_CACHE_TTL_MS - 1);
    assert.equal(cache.get(DETECTED), OLD_REF);
    advance(1);
    assert.equal(cache.get(DETECTED), null);
  });

  test('an unknown manifest is cached for 60s', () => {
    const { cache } = setup();
    assert.equal(cache.set(UNKNOWN, OLD_REF), FEED_CACHE_TTL_MS);
  });

  test('the /bzz 404 fallback is capped at 60s, even for a seeded manifest', () => {
    const { cache, advance } = setup();
    assert.equal(ttlFor(SEEDED, { viaFallback: true }), FEED_CACHE_TTL_MS);
    assert.equal(cache.set(SEEDED, OLD_REF, { viaFallback: true }), FEED_CACHE_TTL_MS);
    advance(FEED_CACHE_TTL_MS);
    assert.equal(cache.get(SEEDED), null);
  });

  test('detection never makes a manifest seeded', () => {
    const { cache } = setup();
    assert.ok(Object.isFrozen(SEEDED_FEED_MANIFESTS));
    assert.throws(() => {
      (SEEDED_FEED_MANIFESTS as Record<string, unknown>)[DETECTED] = { owner: PLATFORM_OWNER, topic: DETECTED_TOPIC };
    }, TypeError);
    cache.registerDetected(DETECTED, { owner: PLATFORM_OWNER, topic: DETECTED_TOPIC });
    assert.equal(isSeededFeedManifest(DETECTED), false);
    assert.equal(Object.keys(SEEDED_FEED_MANIFESTS).length, 4);
  });
});

describe('cache store', () => {
  test('an entry expires exactly at its TTL and is evicted from the store', () => {
    const { cache, store, now, advance } = setup();
    cache.set(UNKNOWN, OLD_REF);
    assert.deepEqual(store.get(UNKNOWN), { contentRef: OLD_REF, expires: now() + FEED_CACHE_TTL_MS });
    advance(FEED_CACHE_TTL_MS - 1);
    assert.equal(cache.get(UNKNOWN), OLD_REF);
    advance(1);
    assert.equal(cache.get(UNKNOWN), null);
    assert.equal(store.has(UNKNOWN), false);
  });

  test('keys are case-insensitive', () => {
    const { cache, store } = setup();
    cache.set(UNKNOWN.toUpperCase(), OLD_REF);
    assert.deepEqual([...store.keys()], [UNKNOWN]);
    assert.equal(cache.get(UNKNOWN), OLD_REF);
    cache.set(SEEDED, OLD_REF);
    assert.equal(cache.get(SEEDED.toUpperCase()), OLD_REF);
  });

  test('drop removes an entry whatever its case, and only that entry', () => {
    const { cache } = setup();
    cache.set(UNKNOWN, OLD_REF);
    cache.set(SEEDED, OLD_REF);
    assert.equal(cache.drop(UNKNOWN.toUpperCase()), true);
    assert.equal(cache.get(UNKNOWN), null);
    assert.equal(cache.get(SEEDED), OLD_REF);
    assert.equal(cache.drop(UNKNOWN), false);
  });
});

describe('manifest lookup', () => {
  test('a seeded manifest is known without detection', () => {
    const { cache } = setup();
    assert.deepEqual(cache.lookup(SEEDED), { owner: PLATFORM_OWNER, topic: SEEDED_TOPIC });
  });

  test('a detected manifest is known once registered, whatever its case', () => {
    const { cache } = setup();
    assert.equal(cache.lookup(DETECTED), undefined);
    cache.registerDetected(DETECTED.toUpperCase(), { owner: PLATFORM_OWNER, topic: DETECTED_TOPIC });
    assert.deepEqual(cache.lookup(DETECTED), { owner: PLATFORM_OWNER, topic: DETECTED_TOPIC });
  });
});

describe('isManifestHash', () => {
  test('accepts 64 hex characters in either case', () => {
    assert.ok(isManifestHash(SEEDED));
    assert.ok(isManifestHash(SEEDED.toUpperCase()));
  });

  test('rejects anything else', () => {
    for (const bad of ['', 'a'.repeat(63), 'a'.repeat(65), `0x${'a'.repeat(62)}`, `0x${'a'.repeat(64)}`, `${'a'.repeat(63)}g`]) {
      assert.equal(isManifestHash(bad), false, bad);
    }
  });
});

describe('refreshFeedManifest', () => {
  test('a seeded manifest: drops the stale ref, re-resolves, caches the new one for 24h', async () => {
    const { cache, store, now } = setup();
    const { deps, calls } = fakeDeps();
    cache.set(SEEDED, OLD_REF);

    const result = await refreshFeedManifest(cache, SEEDED, deps);

    assert.deepEqual(result, { ok: true, hash: SEEDED, refreshed: true, contentRef: NEW_REF, index: 7 });
    assert.deepEqual(calls.resolved, [[PLATFORM_OWNER, SEEDED_TOPIC]]);
    assert.equal(cache.get(SEEDED), NEW_REF);
    assert.equal(store.get(SEEDED)?.expires, now() + SEEDED_FEED_CACHE_TTL_MS);
    assert.deepEqual(calls.whitelisted, [NEW_REF]);
  });

  test('a detected manifest: re-resolved and cached for 60s', async () => {
    const { cache, store, now } = setup();
    const { deps, calls } = fakeDeps();
    cache.registerDetected(DETECTED, { owner: PLATFORM_OWNER, topic: DETECTED_TOPIC });
    cache.set(DETECTED, OLD_REF);

    const result = await refreshFeedManifest(cache, DETECTED, deps);

    assert.deepEqual(result, { ok: true, hash: DETECTED, refreshed: true, contentRef: NEW_REF, index: 7 });
    assert.deepEqual(calls.resolved, [[PLATFORM_OWNER, DETECTED_TOPIC]]);
    assert.equal(store.get(DETECTED)?.expires, now() + FEED_CACHE_TTL_MS);
  });

  test('an unknown hash is not an error: nothing resolved, any cached ref still dropped', async () => {
    const { cache } = setup();
    const { deps, calls } = fakeDeps();
    cache.set(UNKNOWN, OLD_REF);

    const result = await refreshFeedManifest(cache, UNKNOWN, deps);

    assert.deepEqual(result, { ok: true, hash: UNKNOWN, refreshed: false, contentRef: null, index: null });
    assert.deepEqual(calls.resolved, []);
    assert.equal(cache.get(UNKNOWN), null);
  });

  test('a known manifest whose owner is not allowed: dropped, not re-resolved', async () => {
    const { cache } = setup();
    const { deps, calls } = fakeDeps();
    cache.registerDetected(DETECTED, { owner: 'c'.repeat(40), topic: DETECTED_TOPIC });
    cache.set(DETECTED, OLD_REF);

    const result = await refreshFeedManifest(cache, DETECTED, deps);

    assert.deepEqual(result, { ok: true, hash: DETECTED, refreshed: false, contentRef: null, index: null });
    assert.deepEqual(calls.resolved, []);
    assert.equal(cache.get(DETECTED), null);
  });

  test('bee cannot resolve: the stale ref is dropped and nothing is cached or whitelisted', async () => {
    const { cache, store } = setup();
    const { deps, calls } = fakeDeps(null);
    cache.set(SEEDED, OLD_REF);

    const result = await refreshFeedManifest(cache, SEEDED, deps);

    assert.deepEqual(result, { ok: true, hash: SEEDED, refreshed: false, contentRef: null, index: null });
    assert.equal(store.size, 0);
    assert.deepEqual(calls.whitelisted, []);
  });

  test('an upper-case hash is answered and refreshed in lower case', async () => {
    const { cache } = setup();
    const { deps } = fakeDeps();
    cache.set(SEEDED, OLD_REF);

    const result = await refreshFeedManifest(cache, SEEDED.toUpperCase(), deps);

    assert.equal(result.hash, SEEDED);
    assert.equal(result.refreshed, true);
    assert.equal(cache.get(SEEDED), NEW_REF);
  });

  test('a whitelist failure rejects, so the route can answer 500', async () => {
    const { cache } = setup();
    const { deps } = fakeDeps();
    deps.whitelist = async () => { throw new Error('disk full'); };
    await assert.rejects(refreshFeedManifest(cache, SEEDED, deps), /disk full/);
  });
});

describe('never steps back (bee#5251: a short lookup once pinned an old build for a day)', () => {
  test('a lower index after a higher one leaves the newer build served', () => {
    const { cache } = setup();
    cache.set(SEEDED, NEW_REF, {}, 241);
    cache.set(SEEDED, OLD_REF, {}, 224);
    assert.equal(cache.get(SEEDED), NEW_REF);
    assert.deepEqual(cache.latest(SEEDED), { index: 241, ref: NEW_REF });
  });

  test('a higher index moves the mark, and an equal one is accepted', () => {
    const { cache } = setup();
    cache.set(SEEDED, OLD_REF, {}, 240);
    cache.set(SEEDED, NEW_REF, {}, 241);
    assert.deepEqual(cache.latest(SEEDED), { index: 241, ref: NEW_REF });
    cache.set(SEEDED, NEW_REF, {}, 241);
    assert.equal(cache.get(SEEDED), NEW_REF);
  });

  test('the mark outlives the TTL, so a re-resolve after expiry starts from it', () => {
    const { cache, advance } = setup();
    cache.set(SEEDED, NEW_REF, {}, 241);
    advance(SEEDED_FEED_CACHE_TTL_MS);
    assert.equal(cache.get(SEEDED), null);
    assert.deepEqual(cache.latest(SEEDED), { index: 241, ref: NEW_REF });
  });

  test('a refused lower answer still re-arms the TTL with the newer ref', () => {
    const { cache, store, now, advance } = setup();
    cache.set(DETECTED, NEW_REF, {}, 9);
    advance(FEED_CACHE_TTL_MS);
    cache.set(DETECTED, OLD_REF, {}, 3);
    assert.deepEqual(store.get(DETECTED), { contentRef: NEW_REF, expires: now() + FEED_CACHE_TTL_MS });
  });

  test('refresh resolves forward FROM the mark and passes the deploy index through', async () => {
    const { cache } = setup();
    const { deps, calls } = fakeDeps({ index: 242, ref: NEW_REF });
    cache.set(SEEDED, OLD_REF, {}, 241);
    const result = await refreshFeedManifest(cache, SEEDED, deps, 242);
    assert.deepEqual(calls.from, [{ index: 241, ref: OLD_REF }]);
    assert.deepEqual(calls.expect, [242]);
    assert.deepEqual(result, { ok: true, hash: SEEDED, refreshed: true, contentRef: NEW_REF, index: 242 });
  });

  test('refresh that cannot reach the deploy index says so, and keeps serving the mark', async () => {
    const { cache } = setup();
    const { deps } = fakeDeps({ index: 241, ref: OLD_REF });
    cache.set(SEEDED, OLD_REF, {}, 241);
    const result = await refreshFeedManifest(cache, SEEDED, deps, 242);
    assert.deepEqual(result, { ok: true, hash: SEEDED, refreshed: false, contentRef: OLD_REF, index: 241 });
    assert.equal(cache.get(SEEDED), OLD_REF);
  });

  test('a resolver answering lower than the mark cannot lower what is served', async () => {
    const { cache } = setup();
    const { deps, calls } = fakeDeps({ index: 224, ref: OLD_REF });
    cache.set(SEEDED, NEW_REF, {}, 241);
    const result = await refreshFeedManifest(cache, SEEDED, deps);
    assert.equal(result.contentRef, NEW_REF);
    assert.equal(result.index, 241);
    assert.equal(cache.get(SEEDED), NEW_REF);
    assert.deepEqual(calls.whitelisted, [NEW_REF]);
  });

  test('a failed resolve keeps the mark and reports it', async () => {
    const { cache } = setup();
    const { deps } = fakeDeps(null);
    cache.set(SEEDED, NEW_REF, {}, 241);
    const result = await refreshFeedManifest(cache, SEEDED, deps);
    assert.deepEqual(result, { ok: true, hash: SEEDED, refreshed: false, contentRef: NEW_REF, index: 241 });
    assert.deepEqual(cache.latest(SEEDED), { index: 241, ref: NEW_REF });
  });
});

describe('saved marks (a restart resumes from the last verified update)', () => {
  test('export and restore round-trip', () => {
    const { cache } = setup();
    cache.set(SEEDED, NEW_REF, {}, 241);
    const saved = JSON.parse(JSON.stringify(cache.exportMarks()));
    const fresh = setup().cache;
    assert.equal(fresh.restoreMarks(saved), 1);
    assert.deepEqual(fresh.latest(SEEDED), { index: 241, ref: NEW_REF });
    assert.equal(fresh.get(SEEDED), null, 'a restored mark is a starting point, not a fresh cache entry');
  });

  test('malformed entries are skipped; a saved mark never lowers a held one', () => {
    const { cache } = setup();
    cache.set(SEEDED, NEW_REF, {}, 241);
    const n = cache.restoreMarks({
      [SEEDED]: { index: 200, ref: OLD_REF },
      [DETECTED]: { index: -1, ref: OLD_REF },
      [UNKNOWN]: { index: 3, ref: 'not-hex' },
      nothex: { index: 3, ref: OLD_REF },
    });
    assert.equal(n, 0);
    assert.deepEqual(cache.latest(SEEDED), { index: 241, ref: NEW_REF });
    assert.equal(cache.latest(DETECTED), undefined);
    assert.equal(cache.restoreMarks(null), 0);
    assert.equal(cache.restoreMarks('junk'), 0);
  });

  test('the save hook fires when a mark rises, not when it holds or is refused', () => {
    let fired = 0;
    const cache = new FeedCache({ onMarkAdvance: () => fired++ });
    cache.set(SEEDED, OLD_REF, {}, 240);
    cache.set(SEEDED, NEW_REF, {}, 241);
    cache.set(SEEDED, NEW_REF, {}, 241);
    cache.set(SEEDED, OLD_REF, {}, 239);
    cache.set(SEEDED, OLD_REF);
    assert.equal(fired, 2);
  });
});

