// Feed-manifest cache rules: which manifests the proxy knows, what each one last
// resolved to, and for how long that answer may be served. Kept free of express
// and fetch so the rules can be tested on their own (test/feed-cache.test.ts).

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
  // WoCo Events App feed manifest (topic: woco-events-v1) — used by woco.eth.limo
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

// Keys are lowercased throughout so a refresh finds an entry however the hash was
// cased in the request that cached it.
export class FeedCache {
  private readonly detected = new Map<string, FeedInfo>();
  private readonly store: Map<string, FeedCacheEntry>;
  private readonly now: () => number;

  constructor(opts: { store?: Map<string, FeedCacheEntry>; now?: () => number } = {}) {
    this.store = opts.store ?? new Map();
    this.now = opts.now ?? (() => Date.now());
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

  /** Caches a resolved content ref and returns the TTL applied, in ms. */
  set(hash: string, contentRef: string, opts: CacheOptions = {}): number {
    const ttl = ttlFor(hash, opts);
    this.store.set(hash.toLowerCase(), { contentRef, expires: this.now() + ttl });
    return ttl;
  }

  drop(hash: string): boolean {
    return this.store.delete(hash.toLowerCase());
  }
}

export interface RefreshDeps {
  isAllowedOwner(owner: string): boolean;
  resolveFeed(owner: string, topic: string): Promise<string | null>;
  whitelist(contentRef: string): Promise<void>;
}

export interface RefreshResult {
  ok: true;
  hash: string;
  refreshed: boolean;
  contentRef: string | null;
}

/**
 * Drops a manifest's cached content ref and, when the feed is known and its owner
 * trusted, re-resolves it now. An unknown hash is not an error: a deploy may refresh
 * a feed before any request has made the proxy see it. The drop happens either way,
 * so a failed re-resolve still stops the stale ref being served.
 */
export async function refreshFeedManifest(
  cache: FeedCache,
  hash: string,
  deps: RefreshDeps,
): Promise<RefreshResult> {
  const key = hash.toLowerCase();
  cache.drop(key);

  const info = cache.lookup(key);
  if (!info || !deps.isAllowedOwner(info.owner)) {
    return { ok: true, hash: key, refreshed: false, contentRef: null };
  }

  const contentRef = await deps.resolveFeed(info.owner, info.topic);
  if (!contentRef) {
    return { ok: true, hash: key, refreshed: false, contentRef: null };
  }

  cache.set(key, contentRef);
  await deps.whitelist(contentRef);
  return { ok: true, hash: key, refreshed: true, contentRef };
}
