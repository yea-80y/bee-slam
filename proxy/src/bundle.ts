/**
 * POST /bytes-bundle: many whitelisted `/bytes` blobs in one request.
 *
 * Why: a browser reading thousands of small blobs one GET at a time (WoCo's
 * organiser dashboard reads one sealed order per sale) runs into the per-IP
 * request limit long before the bytes cost anything - 5,000 orders took ~8
 * minutes. One bundle carries up to BUNDLE_MAX_ROOTS of them.
 *
 * What it serves is exactly what `GET /bytes/{root}` serves, root by root: the
 * same whitelist gate (no feed-manifest detection - a bundle never names one),
 * the same bee resolution of the whole blob, so the proxy never hands out an
 * address that is not itself listed. Nothing a client gets here is trusted by
 * it either: the reader hashes each blob back to its root.
 *
 * DELISTING. The list is checked just before each root's bee read and again
 * when the read finishes, and a blob delisted in between is dropped as
 * not-whitelisted. Callers that delist before destroying the data (WoCo erases
 * an order that way) therefore never see a blob served after its delisting.
 *
 * Wire format (request order preserved, exactly one item per root):
 *   request   application/json  {"v":1,"roots":["<64 hex>", ...]}
 *   response  application/octet-stream
 *             u32 big-endian header length ‖ header JSON ‖ blob bytes, concatenated
 *             header = {"v":1,"items":[{"root","status","len"?}, ...]}
 *             `len` and a blob only for status "ok", in item order.
 * Item status: ok | not-whitelisted | not-found | too-large | error. A bundle has
 * a deadline: roots still unread then are "error", never a whole-request timeout.
 */

export const BUNDLE_VERSION = 1;
export const BUNDLE_MAX_ROOTS = 100;
/** Per blob. WoCo's largest is 16 KB; this is the gateway's own sanity bound. */
export const BUNDLE_MAX_BLOB_BYTES = 64 * 1024;
/** Well inside Cloudflare's origin timeout, so a slow bee never fails the whole bundle. */
export const BUNDLE_DEADLINE_MS = 20_000;
/** bee reads in flight per bundle. */
export const BUNDLE_BEE_CONCURRENCY = 16;

export type BundleStatus = 'ok' | 'not-whitelisted' | 'not-found' | 'too-large' | 'error';

export interface BundleItem {
  root: string;
  status: BundleStatus;
  len?: number;
}

export type BlobRead = { status: 'ok'; bytes: Uint8Array } | { status: 'not-found' | 'too-large' | 'error' };

export interface BundleDeps {
  isListed(root: string): boolean;
  /** The whole blob at `root` from bee, at most `maxBytes`; aborted by `signal`. */
  readBlob(root: string, signal: AbortSignal, maxBytes: number): Promise<BlobRead>;
}

const REF = /^[0-9a-f]{64}$/;

/** The roots of a well-formed request (lowercased), or null. Duplicates are refused, not merged. */
export function parseBundleRequest(body: unknown): string[] | null {
  if (typeof body !== 'object' || body === null) return null;
  const { v, roots } = body as { v?: unknown; roots?: unknown };
  if (v !== BUNDLE_VERSION || !Array.isArray(roots)) return null;
  if (roots.length === 0 || roots.length > BUNDLE_MAX_ROOTS) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of roots) {
    if (typeof r !== 'string') return null;
    const root = r.toLowerCase();
    if (!REF.test(root) || seen.has(root)) return null;
    seen.add(root);
    out.push(root);
  }
  return out;
}

export interface BundleOptions {
  deadlineMs?: number;
  concurrency?: number;
  maxBlobBytes?: number;
}

/** Read every root under the gate, in request order. Never throws; never outlives the deadline. */
export async function buildBundle(
  roots: string[],
  deps: BundleDeps,
  opts: BundleOptions = {},
): Promise<{ items: BundleItem[]; blobs: Uint8Array[] }> {
  const deadlineMs = opts.deadlineMs ?? BUNDLE_DEADLINE_MS;
  const concurrency = Math.max(1, opts.concurrency ?? BUNDLE_BEE_CONCURRENCY);
  const maxBlob = opts.maxBlobBytes ?? BUNDLE_MAX_BLOB_BYTES;
  const results: Array<{ status: BundleStatus; bytes?: Uint8Array } | undefined> = new Array(roots.length);
  const controller = new AbortController();
  let expired = false;

  const readOne = async (i: number): Promise<void> => {
    const root = roots[i];
    // Checked just before the read: an unlisted root costs no bee call.
    if (!deps.isListed(root)) {
      results[i] = { status: 'not-whitelisted' };
      return;
    }
    let read: BlobRead;
    try {
      read = await deps.readBlob(root, controller.signal, maxBlob);
    } catch {
      read = { status: 'error' };
    }
    if (expired) return;
    // Delisted while it was read: the blob is not served.
    if (!deps.isListed(root)) {
      results[i] = { status: 'not-whitelisted' };
      return;
    }
    results[i] = read.status === 'ok' ? { status: 'ok', bytes: read.bytes } : { status: read.status };
  };

  let next = 0;
  const pool = Promise.all(
    Array.from({ length: Math.min(concurrency, roots.length) }, async () => {
      while (next < roots.length && !expired) await readOne(next++);
    }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      expired = true;
      controller.abort();
      resolve();
    }, deadlineMs);
  });
  await Promise.race([pool, deadline]);
  clearTimeout(timer);

  const items: BundleItem[] = [];
  const blobs: Uint8Array[] = [];
  roots.forEach((root, i) => {
    const r = results[i];
    if (r?.status === 'ok' && r.bytes) {
      items.push({ root, status: 'ok', len: r.bytes.length });
      blobs.push(r.bytes);
    } else {
      items.push({ root, status: r?.status ?? 'error' });
    }
  });
  return { items, blobs };
}

/** The response body: header length, header JSON, then the blobs in item order. */
export function encodeBundle(items: BundleItem[], blobs: Uint8Array[]): Buffer {
  const header = Buffer.from(JSON.stringify({ v: BUNDLE_VERSION, items }), 'utf8');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(header.length, 0);
  return Buffer.concat([prefix, header, ...blobs.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength))]);
}

/**
 * bee's `/bytes/{root}`, size-capped by Content-Length before reading and by the
 * bytes actually read while streaming.
 */
export function beeBlobReader(beeApiUrl: string, fetchImpl: typeof fetch = fetch): BundleDeps['readBlob'] {
  return async (root, signal, maxBytes) => {
    let resp: Response;
    try {
      resp = await fetchImpl(`${beeApiUrl}/bytes/${root}`, { signal });
    } catch {
      return { status: 'error' };
    }
    if (resp.status === 404) {
      await resp.body?.cancel().catch(() => {});
      return { status: 'not-found' };
    }
    if (!resp.ok || !resp.body) {
      await resp.body?.cancel().catch(() => {});
      return { status: 'error' };
    }
    const declared = Number(resp.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await resp.body.cancel().catch(() => {});
      return { status: 'too-large' };
    }
    const reader = resp.body.getReader();
    const parts: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          return { status: 'too-large' };
        }
        parts.push(value);
      }
    } catch {
      return { status: 'error' };
    }
    const bytes = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      bytes.set(p, off);
      off += p.length;
    }
    return { status: 'ok', bytes };
  };
}
