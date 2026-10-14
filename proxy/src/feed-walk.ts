// The newest update of a sequence feed, found without bee's feed lookup.
//
// bee's sequence finder (pkg/feeds/sequence, v2.6 through master) gives each probe a
// hardcoded 1 s and reads a slow probe as "absent", so it can answer an OLDER index
// (ethersphere/bee#5251). The proxy caches whatever it is told, so one short answer
// served an old build for up to a day. Here an update counts only once its signature
// recovers to the feed owner, and the walk only ever moves forward from an index
// already held. The WoCo client does the same (woco_app packages/shared/src/swarm/
// feed-walk.ts); both are pinned to the same live updates in their tests.

import { concat, getBytes, hexlify, keccak256, verifyMessage } from 'ethers';

export interface FeedPoint {
  index: number;
  ref: string;
}

/** Raw stored chunk bytes for an address, or null for absent/unknown. */
export type ChunkReader = (address: string, timeoutMs: number) => Promise<Uint8Array | null>;

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ROUND_OFFSETS = [1, 2, 4, 8, 16, 32, 64, 128];
const strip0x = (h: string) => h.replace(/^0x/i, '').toLowerCase();

function uint64be(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(n);
  for (let i = 7; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function spanOf(length: number): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt(length);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bmtRoot(payload: Uint8Array): Uint8Array {
  const padded = new Uint8Array(4096);
  padded.set(payload);
  let level: Uint8Array[] = [];
  for (let off = 0; off < 4096; off += 32) level.push(padded.subarray(off, off + 32));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(getBytes(keccak256(concat([level[i], level[i + 1]]))));
    level = next;
  }
  return level[0];
}

function identifierOf(topic: string, index: number): Uint8Array {
  if (!Number.isSafeInteger(index) || index < 0) throw new Error('index must be a non-negative integer');
  const t = strip0x(topic);
  if (!HEX64.test(t)) throw new Error('topic must be 32 bytes of hex');
  return getBytes(keccak256(concat([getBytes(`0x${t}`), uint64be(index)])));
}

/** Where update `index` is stored: keccak256(keccak256(topic || uint64be(index)) || owner). */
export function feedUpdateAddress(owner: string, topic: string, index: number): string {
  const o = strip0x(owner);
  if (!HEX40.test(o)) throw new Error('owner must be a 20-byte address');
  return strip0x(keccak256(concat([identifierOf(topic, index), getBytes(`0x${o}`)])));
}

/**
 * The update at `index` if `raw` is exactly that SOC - identifier, span, a v1 payload
 * (8-byte timestamp + 32-byte reference) - signed by `owner`; otherwise null.
 */
export function verifyFeedUpdate(raw: Uint8Array, expected: { owner: string; topic: string; index: number }): FeedPoint | null {
  try {
    if (raw.length !== 32 + 65 + 8 + 40) return null;
    const identifier = identifierOf(expected.topic, expected.index);
    if (hexlify(raw.subarray(0, 32)) !== hexlify(identifier)) return null;
    const signature = raw.subarray(32, 97);
    const span = raw.subarray(97, 105);
    const payload = raw.subarray(105);
    if (hexlify(span) !== hexlify(spanOf(payload.length))) return null;
    const cac = keccak256(concat([span, bmtRoot(payload)]));
    const signer = verifyMessage(getBytes(keccak256(concat([identifier, cac]))), hexlify(signature));
    if (strip0x(signer) !== strip0x(expected.owner)) return null;
    return { index: expected.index, ref: strip0x(hexlify(payload.subarray(8, 40))) };
  } catch {
    return null;
  }
}

export interface WalkOptions {
  owner: string;
  topic: string;
  /** The highest index already held; -1 for none. Only indices above it are read. */
  fromIndex: number;
  read: ChunkReader;
  probeTimeoutMs: number;
  maxRounds?: number;
}

/** The newest verified update above `fromIndex`, or null. Gaps below the head are crossed. */
export async function walkFeedForward(opts: WalkOptions): Promise<FeedPoint | null> {
  let best: FeedPoint | null = null;
  let base = opts.fromIndex;
  for (let round = 0; round < (opts.maxRounds ?? 8); round++) {
    const hits = await Promise.all(
      ROUND_OFFSETS.map(async (offset) => {
        const index = base + offset;
        const raw = await opts.read(feedUpdateAddress(opts.owner, opts.topic, index), opts.probeTimeoutMs).catch(() => null);
        return raw ? verifyFeedUpdate(raw, { owner: opts.owner, topic: opts.topic, index }) : null;
      }),
    );
    let top: FeedPoint | null = null;
    for (const h of hits) if (h && (!top || h.index > top.index)) top = h;
    if (!top) break;
    best = top;
    base = top.index;
  }
  return best;
}

/** One update read directly, for an index the caller already expects to exist. */
export async function readFeedUpdate(
  opts: Omit<WalkOptions, 'fromIndex' | 'maxRounds'>,
  index: number,
): Promise<FeedPoint | null> {
  const raw = await opts.read(feedUpdateAddress(opts.owner, opts.topic, index), opts.probeTimeoutMs).catch(() => null);
  return raw ? verifyFeedUpdate(raw, { owner: opts.owner, topic: opts.topic, index }) : null;
}
