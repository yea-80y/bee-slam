// The proxy's forward feed walk (src/feed-walk.ts). Vectors 239-241 are the WoCo app
// feed's real updates, read from our bee on 2026-10-14 - the same vectors pin the
// client's walk (woco_app packages/shared/test/swarm/feed-walk.test.ts), so the two
// implementations are proven against identical data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SigningKey, concat, getBytes, hashMessage, keccak256, toUtf8Bytes } from 'ethers';
import { feedUpdateAddress, readFeedUpdate, verifyFeedUpdate, walkFeedForward, type ChunkReader } from '../src/feed-walk.js';

const APP_OWNER = 'f8af4904c6e4f08ce5f7deab7f01221280b23a80';
const APP_TOPIC = 'aef7b3bb8b50eff1516536370de7ab15de8e24592a35d2abd9977d00ebb650b2';
const LIVE: Record<number, { address?: string; ref: string; hex: string }> = {
  239: {
    ref: 'bed6f78ac4dd2c5fabdce139d6c1ab7aa9c12a1219ed9ad16c1030fdda71ef61',
    hex: '40166a06d3cb170cec35cddafff4b0d964ed2d8b775a154452edffee87c2db7b3c7606f4cffbf1b616f029e6fac8e558b211aeb600b205b1fa03e9626b9f56074b312e5f35fc9a3482d3b351cc9b6c38336c940120600ecce25f6b70348f3f621b2800000000000000000000006ace5b10bed6f78ac4dd2c5fabdce139d6c1ab7aa9c12a1219ed9ad16c1030fdda71ef61',
  },
  240: {
    ref: '653d3eff3a7e02f98cc334456bb148f5a70f61effdd2e4cf4c03c4a69f213b66',
    hex: 'f0cd33c36b11de351e33f51d35cc3bc745f27de2b9cb10bbc555e58bb039fde392a913503ea2fed02279f5fe005ca7ec0c1ddc8ca81134dde81c6e44f9c867552ba19369eeed45baa80a25214929048c3723b95c784204ba7342298fb22475de1c2800000000000000000000006acede96653d3eff3a7e02f98cc334456bb148f5a70f61effdd2e4cf4c03c4a69f213b66',
  },
  241: {
    address: 'd5d1f55ac90da60930a7b54b75ef35c99d182edd9ad4a39ddf43cc0735fc83d4',
    ref: '4ca914bc102d8ce3a03b3271a89fcb2b33154adbae2668b6b682c37c10d70089',
    hex: '1c45e7e9a36887e8d0dbf663ccee80598d95a04ee27a742c74e50b5f4a119f043a188e21b14a3a4f5cc93cad80902a78496cbf52c4533375d5287b69069b79e35b0fcd73e6d9ea29033b86c3820f790316a3723b388d7c123f597e4104af5cf81c2800000000000000000000006acf01f34ca914bc102d8ce3a03b3271a89fcb2b33154adbae2668b6b682c37c10d70089',
  },
};
const app = (index: number) => ({ owner: APP_OWNER, topic: APP_TOPIC, index });

test('live vectors: verified, with the deployed refs', () => {
  for (const i of [239, 240, 241]) {
    assert.deepEqual(verifyFeedUpdate(getBytes(`0x${LIVE[i].hex}`), app(i)), { index: i, ref: LIVE[i].ref });
  }
});

test('live vector 241 is stored where we compute it', () => {
  assert.equal(feedUpdateAddress(APP_OWNER, APP_TOPIC, 241), LIVE[241].address);
});

test('a flipped byte, an older update for a newer index, or another owner: refused', () => {
  const good = getBytes(`0x${LIVE[241].hex}`);
  for (const at of [0, 40, 42, 96, 99, 107, good.length - 1]) {
    const bad = good.slice();
    bad[at] ^= 1;
    assert.equal(verifyFeedUpdate(bad, app(241)), null, `flip at ${at}`);
  }
  assert.equal(verifyFeedUpdate(getBytes(`0x${LIVE[240].hex}`), app(241)), null);
  assert.equal(verifyFeedUpdate(good, { ...app(241), owner: '11'.repeat(20) }), null);
});

// ---- synthetic feeds ----

const KEY = new SigningKey(`0x${'05'.repeat(32)}`);
const OWNER = keccak256(getBytes(KEY.publicKey).subarray(1)).slice(-40);
const TOPIC = keccak256(toUtf8Bytes('proxy-walk-test')).slice(2);
const OTHER = new SigningKey(`0x${'06'.repeat(32)}`);
const refFor = (i: number) => keccak256(toUtf8Bytes(`build-${i}`)).slice(2);

function u64(n: number, le = false): Uint8Array {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n), le);
  return b;
}

function signUpdate(index: number, key = KEY, payload?: Uint8Array, spanLength?: number): Uint8Array {
  const id = getBytes(keccak256(concat([getBytes(`0x${TOPIC}`), u64(index)])));
  const body = payload ?? concat([u64(1_700_000_000 + index), getBytes(`0x${refFor(index)}`)]);
  const p = getBytes(body);
  const span = u64(spanLength ?? p.length, true);
  const padded = new Uint8Array(4096);
  padded.set(p);
  let level: Uint8Array[] = [];
  for (let o = 0; o < 4096; o += 32) level.push(padded.subarray(o, o + 32));
  while (level.length > 1) {
    const n: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) n.push(getBytes(keccak256(concat([level[i], level[i + 1]]))));
    level = n;
  }
  const cac = keccak256(concat([span, level[0]]));
  const sig = key.sign(hashMessage(getBytes(keccak256(concat([id, cac])))));
  return getBytes(concat([id, sig.serialized, span, p]));
}

function reader(indices: number[], opts: { delayMs?: number; key?: SigningKey } = {}): ChunkReader {
  const held = new Map(indices.map((i) => [feedUpdateAddress(OWNER, TOPIC, i), signUpdate(i, opts.key)]));
  return (address, timeoutMs) =>
    new Promise((resolve) => {
      const answer = () => held.get(address) ?? null;
      if (!opts.delayMs) return resolve(answer());
      const t = setTimeout(() => resolve(answer()), opts.delayMs);
      setTimeout(() => { clearTimeout(t); resolve(null); }, timeoutMs);
    });
}

const walk = (fromIndex: number, read: ChunkReader, probeTimeoutMs = 200) =>
  walkFeedForward({ owner: OWNER, topic: TOPIC, fromIndex, read, probeTimeoutMs });

test('synthetic updates use the live scheme', () => {
  assert.equal(verifyFeedUpdate(signUpdate(3), { owner: OWNER, topic: TOPIC, index: 3 })?.ref, refFor(3));
});

test('owner-signed but not a single-chunk v1 payload: refused', () => {
  // A span larger than the payload makes it a tree root, not the update itself.
  assert.equal(verifyFeedUpdate(signUpdate(3, KEY, undefined, 4096), { owner: OWNER, topic: TOPIC, index: 3 }), null);
  assert.equal(verifyFeedUpdate(signUpdate(3, KEY, new Uint8Array(72).fill(1)), { owner: OWNER, topic: TOPIC, index: 3 }), null);
  assert.equal(verifyFeedUpdate(signUpdate(3, KEY, new Uint8Array(32).fill(1)), { owner: OWNER, topic: TOPIC, index: 3 }), null);
});

test('walks forward to the head, across gaps and past 128-index rounds', async () => {
  assert.equal((await walk(5, reader([5, 6, 7, 8, 9])))?.index, 9);
  assert.equal((await walk(5, reader([5, 7, 8])))?.index, 8);
  assert.equal((await walk(10, reader(Array.from({ length: 400 }, (_, i) => i))))?.index, 399);
});

test('from nothing (-1): finds index 0 and onwards', async () => {
  assert.equal((await walk(-1, reader([0, 1, 2])))?.index, 2);
});

test('nothing newer, wrong signer, or every read timing out: null, never an older update', async () => {
  assert.equal(await walk(9, reader([1, 2, 9])), null);
  assert.equal(await walk(5, reader([6, 7], { key: OTHER })), null);
  const t0 = Date.now();
  assert.equal(await walk(5, reader([6, 7], { delayMs: 5_000 }), 50), null);
  assert.ok(Date.now() - t0 < 1_000);
});

test('readFeedUpdate reads exactly one index, verified', async () => {
  const opts = { owner: OWNER, topic: TOPIC, read: reader([4, 5]), probeTimeoutMs: 200 };
  assert.deepEqual(await readFeedUpdate(opts, 5), { index: 5, ref: refFor(5) });
  assert.equal(await readFeedUpdate(opts, 6), null);
});
