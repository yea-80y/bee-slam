// POST /bytes-bundle (bundle.ts): many whitelisted /bytes blobs per request.
//
// The rules: exactly one item per requested root, in request order; an unlisted
// root costs no bee read; a root delisted while it was read is not served; a slow
// bee yields per-root errors at the deadline, never a failed request; oversize
// blobs are cut off by declared length AND by bytes read.
//
// MUTATION: skip the before-read or after-read list check, merge duplicates,
// accept >100 roots, reorder items, drop the deadline, or trust Content-Length
// alone, and a case below goes red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUNDLE_MAX_ROOTS,
  beeBlobReader,
  buildBundle,
  encodeBundle,
  parseBundleRequest,
  type BlobRead,
  type BundleDeps,
} from '../src/bundle.js';

const R = (c: string) => c.repeat(64);
const bytes = (s: string) => new TextEncoder().encode(s);

function decode(buf: Buffer): { header: { v: number; items: Array<{ root: string; status: string; len?: number }> }; blobs: string[] } {
  const len = buf.readUInt32BE(0);
  const header = JSON.parse(buf.subarray(4, 4 + len).toString('utf8'));
  const blobs: string[] = [];
  let off = 4 + len;
  for (const it of header.items) {
    if (it.status !== 'ok') continue;
    blobs.push(buf.subarray(off, off + it.len).toString('utf8'));
    off += it.len;
  }
  assert.equal(off, buf.length, 'no trailing bytes');
  return { header, blobs };
}

test('parse: a well-formed request, lowercased; anything else is refused whole', () => {
  assert.deepEqual(parseBundleRequest({ v: 1, roots: [R('A'), R('b')] }), [R('a'), R('b')]);
  assert.equal(parseBundleRequest({ v: 2, roots: [R('a')] }), null);
  assert.equal(parseBundleRequest({ v: 1, roots: [] }), null);
  assert.equal(parseBundleRequest({ v: 1, roots: [R('a'), R('A')] }), null, 'a duplicate (any case) is refused, not merged');
  assert.equal(parseBundleRequest({ v: 1, roots: ['ab'] }), null);
  assert.equal(parseBundleRequest({ v: 1, roots: [7] }), null);
  assert.equal(parseBundleRequest(null), null);
  const many = Array.from({ length: BUNDLE_MAX_ROOTS + 1 }, (_, i) => i.toString(16).padStart(64, '0'));
  assert.equal(parseBundleRequest({ v: 1, roots: many }), null);
  assert.equal(parseBundleRequest({ v: 1, roots: many.slice(0, BUNDLE_MAX_ROOTS) })?.length, BUNDLE_MAX_ROOTS);
});

function deps(opts: { listed: Set<string>; blobs?: Record<string, BlobRead>; onRead?: (root: string) => void; delay?: number }) {
  const reads: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const d: BundleDeps = {
    isListed: (r) => opts.listed.has(r),
    async readBlob(root, signal) {
      reads.push(root);
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        opts.onRead?.(root);
        if (opts.delay) {
          await new Promise<void>((resolve, reject) => {
            const t = setTimeout(resolve, opts.delay);
            signal.addEventListener('abort', () => {
              clearTimeout(t);
              reject(new Error('aborted'));
            });
          });
        }
        return opts.blobs?.[root] ?? { status: 'ok', bytes: bytes(`blob-${root.slice(0, 2)}`) };
      } finally {
        inFlight--;
      }
    },
  };
  return { d, reads, peak: () => peak };
}

test('one item per root, in request order; blobs follow in that order', async () => {
  const roots = [R('c'), R('a'), R('b')];
  const { d } = deps({ listed: new Set(roots), blobs: { [R('a')]: { status: 'not-found' } } });
  const { items, blobs } = await buildBundle(roots, d);
  const { header, blobs: out } = decode(encodeBundle(items, blobs));
  assert.deepEqual(header, {
    v: 1,
    items: [
      { root: R('c'), status: 'ok', len: 7 },
      { root: R('a'), status: 'not-found' },
      { root: R('b'), status: 'ok', len: 7 },
    ],
  });
  assert.deepEqual(out, ['blob-cc', 'blob-bb']);
});

test('an unlisted root is refused with no bee read at all', async () => {
  const { d, reads } = deps({ listed: new Set([R('a')]) });
  const { items } = await buildBundle([R('a'), R('b')], d);
  assert.deepEqual(items.map((i) => i.status), ['ok', 'not-whitelisted']);
  assert.deepEqual(reads, [R('a')]);
});

test('a root delisted while it was being read is not served', async () => {
  const listed = new Set([R('a'), R('b')]);
  const { d } = deps({ listed, onRead: (root) => root === R('a') && listed.delete(R('a')) });
  const { items, blobs } = await buildBundle([R('a'), R('b')], d);
  assert.deepEqual(items.map((i) => i.status), ['not-whitelisted', 'ok']);
  assert.equal(blobs.length, 1);
});

test('bee failures map per root: thrown = error, not found, too large', async () => {
  const listed = new Set([R('a'), R('b'), R('c')]);
  const d: BundleDeps = {
    isListed: (r) => listed.has(r),
    async readBlob(root) {
      if (root === R('a')) throw new Error('boom');
      return root === R('b') ? { status: 'not-found' } : { status: 'too-large' };
    },
  };
  const { items } = await buildBundle([R('a'), R('b'), R('c')], d);
  assert.deepEqual(items.map((i) => i.status), ['error', 'not-found', 'too-large']);
});

test('the deadline ends the bundle: unread roots are errors, nothing throws, nothing waits', async () => {
  const roots = [R('a'), R('b'), R('c'), R('d')];
  const { d } = deps({ listed: new Set(roots), delay: 1_000 });
  const t0 = Date.now();
  const { items, blobs } = await buildBundle(roots, d, { deadlineMs: 40, concurrency: 2 });
  assert.ok(Date.now() - t0 < 500, 'returned at the deadline, not after the slow reads');
  assert.deepEqual(items.map((i) => i.status), ['error', 'error', 'error', 'error']);
  assert.equal(blobs.length, 0);
});

test('bee reads in flight never exceed the concurrency bound', async () => {
  const roots = Array.from({ length: 30 }, (_, i) => i.toString(16).padStart(64, '0'));
  const { d, peak } = deps({ listed: new Set(roots), delay: 5 });
  const { items } = await buildBundle(roots, d, { concurrency: 4 });
  assert.equal(items.filter((i) => i.status === 'ok').length, 30);
  assert.ok(peak() <= 4);
});

function fakeFetch(make: () => Response | Promise<Response>): typeof fetch {
  return (async () => make()) as unknown as typeof fetch;
}
const stream = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(ch);
      c.close();
    },
  });

test('bee reader: ok, 404, 5xx and a thrown fetch', async () => {
  const signal = new AbortController().signal;
  assert.deepEqual(await beeBlobReader('http://bee', fakeFetch(() => new Response(bytes('hello'))))(R('a'), signal, 100), { status: 'ok', bytes: bytes('hello') });
  assert.deepEqual(await beeBlobReader('http://bee', fakeFetch(() => new Response('nope', { status: 404 })))(R('a'), signal, 100), { status: 'not-found' });
  assert.deepEqual(await beeBlobReader('http://bee', fakeFetch(() => new Response('x', { status: 500 })))(R('a'), signal, 100), { status: 'error' });
  const throwing = (async () => {
    throw new Error('down');
  }) as unknown as typeof fetch;
  assert.deepEqual(await beeBlobReader('http://bee', throwing)(R('a'), signal, 100), { status: 'error' });
});

test('bee reader: too large by declared length, and by bytes read when none is declared', async () => {
  const signal = new AbortController().signal;
  const declared = fakeFetch(() => new Response(bytes('x'.repeat(10)), { headers: { 'content-length': '10' } }));
  assert.deepEqual(await beeBlobReader('http://bee', declared)(R('a'), signal, 5), { status: 'too-large' });
  const undeclared = fakeFetch(() => new Response(stream([bytes('xxxx'), bytes('xxxx')])));
  assert.deepEqual(await beeBlobReader('http://bee', undeclared)(R('a'), signal, 5), { status: 'too-large' });
  const fits = fakeFetch(() => new Response(stream([bytes('ab'), bytes('cd')])));
  assert.deepEqual(await beeBlobReader('http://bee', fits)(R('a'), signal, 5), { status: 'ok', bytes: bytes('abcd') });
});
