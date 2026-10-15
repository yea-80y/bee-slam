import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { WhitelistManager, type CompactionStep, type WhitelistOptions } from '../src/whitelist.js';

const hash = (): string => randomBytes(32).toString('hex');
const [A, B, C] = [hash(), hash(), hash()];

async function fresh(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'whitelist-test-'));
  return join(dir, 'whitelist.json');
}

async function boot(path: string, options: WhitelistOptions = {}): Promise<WhitelistManager> {
  const wl = new WhitelistManager(path, options);
  await wl.initialize();
  return wl;
}

const sorted = (wl: WhitelistManager): string[] => wl.getAll().sort();
const logOf = (path: string): Promise<string> => readFile(`${path}.log`, 'utf8');

test('a first boot with no files starts empty and writes both files', async () => {
  const path = await fresh();
  const wl = await boot(path);
  assert.equal(wl.count(), 0);
  assert.equal(await readFile(path, 'utf8'), '[]');
  assert.equal(await logOf(path), '');
});

test('adds, removes and clears survive a restart', async () => {
  const path = await fresh();
  const wl = await boot(path);
  await wl.add(A);
  await wl.add(B.toUpperCase());
  await wl.remove(A);
  assert.deepEqual(sorted(await boot(path)), [B]);

  await (await boot(path)).clear();
  assert.deepEqual(sorted(await boot(path)), []);
});

test('an add appends one line and never rewrites the snapshot', async () => {
  const path = await fresh();
  const wl = await boot(path);
  const before = await stat(path);
  await wl.add(A);
  await wl.add(A);
  await wl.addMany([B, B, A]);
  const after = await stat(path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(await logOf(path), `+${A}\n+${B}\n`, 'a hash already listed is not written again');
});

test('the snapshot is compact JSON, replaced by rename rather than rewritten in place', async () => {
  const path = await fresh();
  const wl = await boot(path, { compactMin: 3 });
  const before = await stat(path);
  await wl.addMany([A, B, C]);
  assert.equal(await logOf(path), '', 'reaching compactMin folds the log into the snapshot');
  const text = await readFile(path, 'utf8');
  assert.equal(text, JSON.stringify([A, B, C]));
  assert.notEqual((await stat(path)).ino, before.ino, 'the snapshot was written in place');
});

test('both files are private to the gateway user', async () => {
  const path = await fresh();
  const wl = await boot(path);
  await wl.add(A);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(`${path}.log`)).mode & 0o777, 0o600);
});

test('the pretty-printed file the old code wrote still loads, and is rewritten compact', async () => {
  const path = await fresh();
  await writeFile(path, JSON.stringify([A, B.toUpperCase()], null, 2));
  const wl = await boot(path);
  assert.deepEqual(sorted(wl), [A, B].sort());
  assert.equal(await readFile(path, 'utf8'), JSON.stringify([A, B]));
});

test('boot refuses a snapshot it cannot read in full, and leaves it untouched', async () => {
  const cases: Array<[string, string]> = [
    ['truncated mid-write', JSON.stringify([A, B], null, 2).slice(0, 80)],
    ['empty file', ''],
    ['not an array', JSON.stringify({ hashes: [A] })],
    ['a short hash', JSON.stringify([A, 'abc'])],
    ['a non-string entry', JSON.stringify([A, 42])],
    ['a null entry', JSON.stringify([null])],
  ];
  for (const [name, content] of cases) {
    const path = await fresh();
    await writeFile(path, content);
    await assert.rejects(boot(path), /refusing to start/, name);
    assert.equal(await readFile(path, 'utf8'), content, `${name}: the file was changed`);
    await assert.rejects(stat(`${path}.log`), { code: 'ENOENT' }, `${name}: a log was created`);
  }
});

test('boot refuses a snapshot path it cannot read for any reason other than absence', async () => {
  const path = await fresh();
  await mkdir(path);
  await assert.rejects(boot(path), { code: 'EISDIR' });
});

test('a missing snapshot beside a log with records refuses to start, and creates nothing', async () => {
  const path = await fresh();
  await writeFile(`${path}.log`, `+${A}\n`);
  await assert.rejects(boot(path), /missing/);
  await assert.rejects(stat(path), { code: 'ENOENT' });
  assert.equal(await logOf(path), `+${A}\n`);
});

test('a missing snapshot beside an empty log is a fresh install', async () => {
  const path = await fresh();
  await writeFile(`${path}.log`, '');
  assert.equal((await boot(path)).count(), 0);
});

test('boot refuses any complete log line that is not a record', async () => {
  const cases: Array<[string, string]> = [
    ['garbage', `+${A}\nnot-a-record\n+${B}\n`],
    ['two records merged', `+${A}+${B}\n`],
    ['an empty line', `+${A}\n\n`],
    ['an uppercase record', `+${A.toUpperCase()}\n`],
    ['a short hash', `+${A.slice(2)}\n`],
    ['a corrupt line before an unfinished one', `junk\n+${B.slice(0, 10)}`],
  ];
  for (const [name, log] of cases) {
    const path = await fresh();
    await writeFile(path, '[]');
    await writeFile(`${path}.log`, log);
    await assert.rejects(boot(path), /refusing to start/, name);
    assert.equal(await logOf(path), log, `${name}: the log was changed`);
    assert.equal(await readFile(path, 'utf8'), '[]', `${name}: the snapshot was changed`);
  }
});

test('an unfinished last line is dropped, and cleaned away before anything is appended', async () => {
  for (const tail of [`+${B.slice(0, 20)}`, `+${B}`, '\0\0\0\0\0\0\0\0', 'cle']) {
    const path = await fresh();
    await writeFile(path, '[]');
    await writeFile(`${path}.log`, `+${A}\n${tail}`);
    const wl = await boot(path);
    assert.deepEqual(sorted(wl), [A], JSON.stringify(tail));
    await wl.add(C);
    // Appended after the tail, C would merge into a corrupt line and the next boot refuse.
    assert.deepEqual(sorted(await boot(path)), [A, C].sort(), JSON.stringify(tail));
  }
});

test('a log replayed over the snapshot it was folded into changes nothing', async () => {
  // The state a crash after the rename, before the log is emptied, leaves behind.
  const path = await fresh();
  await writeFile(path, JSON.stringify([B, C]));
  await writeFile(`${path}.log`, `+${A}\n+${B}\n-${A}\n+${C}\n`);
  assert.deepEqual(sorted(await boot(path)), [B, C].sort());
});

test('a crash at any compaction step loses no acknowledged operation', async () => {
  const steps: CompactionStep[] = ['temp-written', 'renamed', 'dir-synced', 'log-emptied'];
  for (const step of steps) {
    const path = await fresh();
    let armed = false;
    const wl = await boot(path, {
      compactMin: 4,
      onCompactionStep: (s) => { if (armed && s === step) throw new Error(`crash at ${s}`); },
    });
    await wl.add(A);
    await wl.add(B);
    await wl.remove(A);
    armed = true;
    await wl.add(C); // the fourth record triggers the compaction that "crashes"
    // The process is gone at this point: a fresh boot reads only what reached the disk.
    assert.deepEqual(sorted(await boot(path)), [B, C].sort(), step);
  }
});

test('a clear survives a crash between the new snapshot and the emptied log', async () => {
  for (const step of ['renamed', 'dir-synced'] as CompactionStep[]) {
    const path = await fresh();
    let armed = false;
    const wl = await boot(path, {
      compactMin: 3,
      onCompactionStep: (s) => { if (armed && s === step) throw new Error(`crash at ${s}`); },
    });
    await wl.add(A);
    await wl.add(B);
    armed = true;
    await wl.clear();
    assert.equal(wl.count(), 0);
    assert.deepEqual(sorted(await boot(path)), [], step);
  }
});

test('concurrent writes are serialised: nothing acknowledged is lost across compactions', async () => {
  const path = await fresh();
  const wl = await boot(path, { compactMin: 8 });
  const added = Array.from({ length: 300 }, hash);
  const removed = new Set(added.filter((_, i) => i % 7 === 0));
  await Promise.all(added.map(async (h) => {
    await wl.add(h);
    if (removed.has(h)) await wl.remove(h);
  }));
  const expected = added.filter(h => !removed.has(h)).sort();
  assert.deepEqual(sorted(wl), expected);
  assert.deepEqual(sorted(await boot(path)), expected);
});

test('an add whose write fails is not whitelisted, and the next write compacts first', async () => {
  const path = await fresh();
  const wl = await boot(path);
  await wl.add(A);
  // A directory where the log should be makes the append fail.
  await rm(`${path}.log`);
  await mkdir(`${path}.log`);
  await assert.rejects(wl.add(B));
  assert.equal(wl.isWhitelisted(B), false, 'memory got ahead of the disk');
  // What a write that died halfway would leave behind.
  await rmdir(`${path}.log`);
  await writeFile(`${path}.log`, `+${B.slice(0, 30)}`);
  await wl.add(C);
  assert.deepEqual(sorted(await boot(path)), [A, C].sort());
});

test('addMany is all or nothing: one bad hash writes none of them', async () => {
  const path = await fresh();
  const wl = await boot(path);
  await assert.rejects(wl.addMany([A, 'zz']), /Invalid hash format/);
  await assert.rejects(wl.add('zz'), /Invalid hash format/);
  assert.equal(wl.isWhitelisted(A), false);
  assert.equal(await logOf(path), '');
});

test('removing a hash that is not listed writes nothing', async () => {
  const path = await fresh();
  const wl = await boot(path);
  await wl.remove(A);
  assert.equal(await logOf(path), '');
});

test('a compaction that fails at runtime keeps the add, and the log keeps everything', async () => {
  const path = await fresh();
  const wl = await boot(path, { compactMin: 2 });
  await mkdir(`${path}.tmp`); // the temp file cannot be created
  await wl.add(A);
  await wl.add(B);
  assert.deepEqual(sorted(wl), [A, B].sort());
  assert.equal(await logOf(path), `+${A}\n+${B}\n`);
  assert.deepEqual(sorted(await boot(path).catch(() => wl)), [A, B].sort());
});

test('a compaction that fails at boot keeps serving reads and, with a clean log, writes', async () => {
  const path = await fresh();
  await (await boot(path)).add(A);
  await mkdir(`${path}.tmp`);
  const wl = await boot(path);
  assert.equal(wl.isWhitelisted(A), true);
  await wl.add(B);
  assert.deepEqual(sorted(await boot(path).catch(() => wl)), [A, B].sort());
});

test('a torn tail the boot compaction could not clean blocks writes until it can', async () => {
  const path = await fresh();
  await (await boot(path)).add(A);
  await writeFile(`${path}.log`, `+${A}\n+${B.slice(0, 12)}`);
  await mkdir(`${path}.tmp`);
  const wl = await boot(path);
  assert.equal(wl.isWhitelisted(A), true);
  await assert.rejects(wl.add(C), 'appended after the torn tail, C would corrupt the log');
  assert.equal(wl.isWhitelisted(C), false);
  await rmdir(`${path}.tmp`);
  await wl.add(C);
  assert.deepEqual(sorted(await boot(path)), [A, C].sort());
});

test('flush leaves the snapshot complete on its own, which is all an older build reads', async () => {
  const path = await fresh();
  const wl = await boot(path);
  await wl.addMany([A, B]);
  await wl.remove(A);
  await wl.flush();
  assert.equal(await logOf(path), '');
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), [B]);
});

test('compaction makes the rename durable before it empties the log', async () => {
  // A power cut cannot be simulated here, so the order is pinned on the source: emptied
  // first, the log could survive a cut that loses the rename, and the adds with it.
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../src/whitelist.ts', import.meta.url), 'utf8');
  const body = src.slice(src.indexOf('private async compact()'), src.indexOf('private threshold()'));
  const order = [
    'await tmp.datasync();',
    'await fs.rename(this.tempPath, this.persistPath);',
    'await syncDir(dirname(this.persistPath));',
    "await fs.open(this.logPath, 'w', 0o600);",
  ].map(step => body.indexOf(step));
  assert.ok(order.every(i => i >= 0), `a compaction step is missing: ${order}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, 'compaction steps out of order');
});
