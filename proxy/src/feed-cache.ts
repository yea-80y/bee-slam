// Feed-manifest cache rules: which manifests the proxy knows, what each one last
// resolved to, and for how long that answer may be served. Kept free of express
// and fetch so the rules can be tested on their own (test/feed-cache.test.ts).
//
// An answer carries its feed INDEX, and the cache never trades a higher index for a
// lower one: bee's lookup can land short (feed-walk.ts), and before this one short
// answer at a refresh, a prewarm or an expiry served an old build for up to a day.

import type { FeedPoint } from './feed-walk.js';

export interface FeedInfo {
  owner: string;
  topic: string;
}

/**
 * The platform's own feed manifests, fixed at build time. Membership here is the
 * ONLY thing that earns SEEDED_FEED_CACHE_TTL_MS: these are pre-warmed at startup
 * and re-resolved through POST /admin/feeds/:hash/refresh after a deploy.
 *
 * Frozen, and kept apart from the runtime registry, on purpose. Detection used to
 * write into the same record that picked the TTL, so a feed detected once (e.g. on
 * the /bzz 404 fallback after one bee hiccup) was then served stale for up to 24h
 * after every republish. Detected manifests go into FeedCache's own registry, which
 * answers "whose feed is this" and never lengthens a TTL.
 */
export const SEEDED_FEED_MANIFESTS: Readonly<Record<string, Readonly<FeedInfo>>> = Object.freeze({
  // WoCo app feed manifest from launch (topic: woco-app-v1, 2026-10-23) — woco.eth.limo and
  // app.woco.eth.limo. Feed updates and this manifest are on the core batch, never replaced.
  'a6792e9294740ac34229f83edda806fddc93d833f3b0d81d02ed6d0fc91107bd': Object.freeze({
    owner: 'f8af4904c6e4f08ce5f7deab7f01221280b23a80',
    topic: 'e9a7db81030196a62ac537b080cdf0b34c86bf590e5bfb74fdb54095587b28fa'
  }),
  // The app's pre-launch feed manifest (topic: woco-events-v1) — kept so open tabs and old
  // links still resolve to its last build.
  'd66c6ff7650a468c2fd98439c8f04547b5b8a4b933d349ff16db1d0b00c23adc': Object.freeze({
    owner: 'f8af4904c6e4f08ce5f7deab7f01221280b23a80',
    topic: 'aef7b3bb8b50eff1516536370de7ab15de8e24592a35d2abd9977d00ebb650b2'
  }),
  // Gateway feed manifest (topic: woco-website-v2)
  '9ebcea7ca2d4a3a975d1724ee579856684dc6f2ffa3082b64317006c922f3100': Object.freeze({
    owner: 'f8af4904c6e4f08ce5f7deab7f01221280b23a80',
    topic: '57d52cda5c8794db2dc1540fde6be327e9d7ea120f8c491eef9f8469e7167568'
  }),
  // Legacy feed manifest (topic: woco-website)
  '0b4ea8162a3fcbb19b63705f0c97137eef667d3c3cd4ecf69d686c5f98fb0054': Object.freeze({
    owner: 'f8af4904c6e4f08ce5f7deab7f01221280b23a80',
    topic: 'bb6a23bf07aa84a41fe44a485dd811ea10cc57a7cb88257789920813549f81d1'
  }),
  // ENS feed manifest (topic: woco-ens-2026)
  'e315d1798ec34cc7137c6b8c79cb28d586d972898fef769cdca08ad13b74d89c': Object.freeze({
    owner: 'f8af4904c6e4f08ce5f7deab7f01221280b23a80',
    topic: '20449894e8e4183fc8f0ba08b57e55ca9c0a3d669cab29e1eaf12a4ccc927e0e'
  })
});

// Detected and third-party feeds, and anything resolved on the /bzz 404 fallback:
// short, so a republish shows up within a minute with no operator action.
export const FEED_CACHE_TTL_MS = 60 * 1000;
// Seeded feeds only: long, so user requests never pay bee's ~3s cold feed resolve.
// Freshness after a deploy comes from the refresh endpoint, not from expiry.
export const SEEDED_FEED_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

const MANIFEST_HASH = /^[0-9a-fA-F]{64}$/;

export function isManifestHash(value: string): boolean {
  return MANIFEST_HASH.test(value);
}

export function isSeededFeedManifest(hash: string): boolean {
  return Object.hasOwn(SEEDED_FEED_MANIFESTS, hash.toLowerCase());
}

export interface CacheOptions {
  // The /bzz 404 fallback fires precisely when bee could not walk the manifest,
  // i.e. when bee is unhealthy. A ref resolved in that state is never pinned for
  // a day, seeded or not.
  viaFallback?: boolean;
}

export function ttlFor(hash: string, opts: CacheOptions = {}): number {
  if (opts.viaFallback) return FEED_CACHE_TTL_MS;
  return isSeededFeedManifest(hash) ? SEEDED_FEED_CACHE_TTL_MS : FEED_CACHE_TTL_MS;
}

export interface FeedCacheEntry {
  contentRef: string;
  expires: number;
}

export type { FeedPoint };

// Keys are lowercased throughout so a refresh finds an entry however the hash was
// cased in the request that cached it.
export class FeedCache {
  private readonly detected = new Map<string, FeedInfo>();
  private readonly store: Map<string, FeedCacheEntry>;
  // The highest verified update seen per manifest. Never expires and never goes
  // down: every re-resolve starts from it.
  private readonly highWater = new Map<string, FeedPoint>();
  private readonly now: () => number;

  private readonly onMarkAdvance: () => void;

  constructor(opts: { store?: Map<string, FeedCacheEntry>; now?: () => number; onMarkAdvance?: () => void } = {}) {
    this.store = opts.store ?? new Map();
    this.now = opts.now ?? (() => Date.now());
    this.onMarkAdvance = opts.onMarkAdvance ?? (() => {});
  }

  /** Every high-water mark, for persisting: a restart then resumes from them. */
  exportMarks(): Record<string, FeedPoint> {
    return Object.fromEntries(this.highWater);
  }

  /**
   * Marks saved by a previous run. Malformed entries are skipped, and a saved mark
   * never lowers one this run already holds.
   */
  restoreMarks(saved: unknown): number {
    if (!saved || typeof saved !== 'object') return 0;
    let restored = 0;
    for (const [hash, point] of Object.entries(saved as Record<string, unknown>)) {
      const p = point as Partial<FeedPoint> | null;
      if (!isManifestHash(hash) || !p || !Number.isSafeInteger(p.index) || (p.index as number) < 0) continue;
      if (typeof p.ref !== 'string' || !/^[0-9a-f]{64}$/.test(p.ref)) continue;
      const key = hash.toLowerCase();
      const held = this.highWater.get(key);
      if (held && held.index >= (p.index as number)) continue;
      this.highWater.set(key, { index: p.index as number, ref: p.ref });
      restored++;
    }
    return restored;
  }

  /** Owner and topic of a known manifest: seeded, or detected at runtime. */
  lookup(hash: string): Readonly<FeedInfo> | undefined {
    const key = hash.toLowerCase();
    if (Object.hasOwn(SEEDED_FEED_MANIFESTS, key)) return SEEDED_FEED_MANIFESTS[key];
    return this.detected.get(key);
  }

  registerDetected(hash: string, info: FeedInfo): void {
    this.detected.set(hash.toLowerCase(), info);
  }

  get(hash: string): string | null {
    const key = hash.toLowerCase();
    const cached = this.store.get(key);
    if (cached && cached.expires > this.now()) return cached.contentRef;
    if (cached) this.store.delete(key);
    return null;
  }

  /** The highest update this manifest has resolved to, however long ago. */
  latest(hash: string): FeedPoint | undefined {
    return this.highWater.get(hash.toLowerCase());
  }

  /**
   * Caches a resolved content ref and returns the TTL applied, in ms. With an
   * `index`, an answer below the high-water mark is refused: the newer ref already
   * held is served (and re-armed) instead.
   */
  set(hash: string, contentRef: string, opts: CacheOptions = {}, index?: number): number {
    const key = hash.toLowerCase();
    let ref = contentRef;
    if (index !== undefined) {
      const held = this.highWater.get(key);
      if (held && held.index > index) ref = held.ref;
      else {
        this.highWater.set(key, { index, ref: contentRef });
        if (!held || held.index < index) this.onMarkAdvance();
      }
    }
    const ttl = ttlFor(key, opts);
    this.store.set(key, { contentRef: ref, expires: this.now() + ttl });
    return ttl;
  }

  drop(hash: string): boolean {
    return this.store.delete(hash.toLowerCase());
  }
}

export interface RefreshDeps {
  isAllowedOwner(owner: string): boolean;
  /**
   * The newest VERIFIED update at or above `from`; when `expectIndex` is given, that
   * update is read directly first (a deploy says which index it just wrote).
   */
  resolveLatest(info: FeedInfo, from: FeedPoint | undefined, expectIndex?: number): Promise<FeedPoint | null>;
  whitelist(contentRef: string): Promise<void>;
}

export interface RefreshResult {
  ok: true;
  hash: string;
  refreshed: boolean;
  contentRef: string | null;
  /** The feed index of `contentRef`; null when nothing is held. */
  index: number | null;
}

/**
 * Drops a manifest's cached content ref and, when the feed is known and its owner
 * trusted, re-resolves it now, forward from the highest update already seen. An
 * unknown hash is not an error: a deploy may refresh a feed before any request has
 * made the proxy see it. The drop happens either way, but the high-water mark is
 * kept, so a failed or short re-resolve can never bring back an older build.
 * `refreshed` is true only when the result reaches `expectIndex` (if given).
 */
export async function refreshFeedManifest(
  cache: FeedCache,
  hash: string,
  deps: RefreshDeps,
  expectIndex?: number,
): Promise<RefreshResult> {
  const key = hash.toLowerCase();
  cache.drop(key);

  const info = cache.lookup(key);
  if (!info || !deps.isAllowedOwner(info.owner)) {
    return { ok: true, hash: key, refreshed: false, contentRef: null, index: null };
  }

  const point = await deps.resolveLatest(info, cache.latest(key), expectIndex);
  if (!point) {
    const held = cache.latest(key);
    return { ok: true, hash: key, refreshed: false, contentRef: held?.ref ?? null, index: held?.index ?? null };
  }

  cache.set(key, point.ref, {}, point.index);
  const served = cache.latest(key)!;
  await deps.whitelist(served.ref);
  const refreshed = expectIndex === undefined || served.index >= expectIndex;
  return { ok: true, hash: key, refreshed, contentRef: served.ref, index: served.index };
}
