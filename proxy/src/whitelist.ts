import { promises as fs } from 'fs';
import { dirname } from 'path';

// The whitelist is data-plane state: a hash missing from it reads as "this chunk does not
// exist", never as "unknown". So persistence is built to never lose an acknowledged add and
// never come up empty over a real list.
//
// On disk: a compact JSON snapshot at `persistPath` plus an append-only log beside it
// (`<persistPath>.log`), one record per line: `+<hash>`, `-<hash>` or `clear`. An operation is
// acknowledged only after its line is written and fsynced, and memory changes only after
// that, so memory never holds what the disk does not. Compaction folds the log into a new
// snapshot (temp file + rename) and only then empties the log. Replaying a log over a snapshot
// that already contains it gives the same set, so a crash between those two steps is harmless.

const LOG_RECORD = /^(?:[+-][0-9a-f]{64}|clear)$/;

export type CompactionStep = 'temp-written' | 'renamed' | 'dir-synced' | 'log-emptied';

export interface WhitelistOptions {
  /** Start with an empty list when neither file exists. Off by default: a wrong volume mount
   *  looks exactly like a fresh install, and an empty gateway reads every real chunk as absent. */
  allowEmptyStart?: boolean;
  /** Log records that trigger a compaction, at least. The bar rises with the set's size. */
  compactMin?: number;
  /** Tests only: called after each compaction step; throwing there stands in for a crash. */
  onCompactionStep?: (step: CompactionStep) => void;
}

export class WhitelistManager {
  private whitelist: Set<string>;
  private persistPath: string;
  private logPath: string;
  private tempPath: string;
  private allowEmptyStart: boolean;
  private compactMin: number;
  private onCompactionStep?: (step: CompactionStep) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private logRecords = 0;
  private compactAt = 0;
  // Set when the log may end in a partial line (a failed append, or a torn tail the startup
  // compaction could not clean away). Appending after one would merge two records into a
  // corrupt line, so the next write compacts first.
  private logDirty = false;

  constructor(persistPath: string = '/data/whitelist.json', options: WhitelistOptions = {}) {
    this.whitelist = new Set<string>();
    this.persistPath = persistPath;
    this.logPath = `${persistPath}.log`;
    this.tempPath = `${persistPath}.tmp`;
    this.allowEmptyStart = options.allowEmptyStart ?? false;
    this.compactMin = options.compactMin ?? 1024;
    this.onCompactionStep = options.onCompactionStep;
  }

  /**
   * Load the snapshot and replay the log. Throws (so the gateway refuses to start) on
   * anything it cannot read in full - an empty list would 403 every real chunk.
   */
  async initialize(): Promise<void> {
    console.log(`Loading whitelist from ${this.persistPath}`);
    const snapshot = await readIfExists(this.persistPath, 'utf-8');
    const log = await readIfExists(this.logPath, null);

    if (snapshot === null) {
      // The first boot writes a snapshot and later ones only ever rename over it, so a
      // missing snapshot beside a non-empty log means it was deleted or moved.
      if (log !== null && log.length > 0) {
        throw new Error(`${this.persistPath} is missing but ${this.logPath} has records - refusing to start without the snapshot`);
      }
      if (!this.allowEmptyStart) {
        throw new Error(`${this.persistPath} does not exist - refusing to start with an empty whitelist. Check the volume mount; on a fresh install, start once with WHITELIST_ALLOW_EMPTY=1`);
      }
      console.log('No existing whitelist found, starting with empty whitelist');
    }

    const set = snapshot === null ? new Set<string>() : parseSnapshot(snapshot, this.persistPath);
    const { records, tornBytes } = parseLog(log ?? Buffer.alloc(0), this.logPath);
    for (const record of records) applyRecord(set, record);
    if (tornBytes > 0) {
      // Only the line being written when the process died can lack its newline, and it was
      // never acknowledged.
      console.warn(`Dropped ${tornBytes} bytes of an unfinished last line in ${this.logPath}`);
    }

    this.whitelist = set;
    this.logRecords = records.length;
    this.logDirty = tornBytes > 0;
    try {
      await this.enqueue(() => this.compact());
    } catch (error) {
      // Reads work from memory, so stay up. A clean log still takes appends; one with a torn
      // tail makes every write retry the compaction first, and fail until it succeeds.
      console.error('Could not compact the whitelist at startup:', error);
    }
    console.log(`Loaded ${this.whitelist.size} hashes from whitelist`);
  }

  /**
   * Check if a hash is whitelisted (case-insensitive)
   */
  isWhitelisted(hash: string): boolean {
    return this.whitelist.has(hash.toLowerCase());
  }

  /**
   * Add a hash to the whitelist (normalized to lowercase)
   */
  async add(hash: string): Promise<void> {
    if (!this.isValidHash(hash)) {
      throw new Error('Invalid hash format');
    }
    await this.addMany([hash]);
  }

  /**
   * Add multiple hashes to the whitelist (normalized to lowercase). All or nothing: one
   * invalid hash rejects the whole call before anything is written.
   */
  async addMany(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      if (!this.isValidHash(hash)) {
        throw new Error(`Invalid hash format: ${hash}`);
      }
    }
    const normalized = [...new Set(hashes.map(h => h.toLowerCase()))];
    await this.enqueue(async () => {
      const fresh = normalized.filter(h => !this.whitelist.has(h));
      if (fresh.length === 0) return;
      await this.commit(fresh.map(h => `+${h}`), () => {
        for (const h of fresh) this.whitelist.add(h);
      });
    });
  }

  /**
   * Remove a hash from the whitelist (case-insensitive)
   */
  async remove(hash: string): Promise<void> {
    const h = hash.toLowerCase();
    await this.enqueue(async () => {
      if (!this.whitelist.has(h)) return;
      await this.commit([`-${h}`], () => this.whitelist.delete(h));
    });
  }

  /**
   * Get all whitelisted hashes
   */
  getAll(): string[] {
    return Array.from(this.whitelist);
  }

  /**
   * Clear all whitelisted hashes
   */
  async clear(): Promise<void> {
    // A record, not just an empty snapshot: a crash after the rename but before the log is
    // emptied would otherwise replay the old adds back over it.
    await this.enqueue(() => this.commit(['clear'], () => this.whitelist.clear()));
  }

  /**
   * Fold the log into the snapshot now, so `persistPath` alone holds the whole list.
   */
  async flush(): Promise<void> {
    await this.enqueue(() => this.compact());
  }

  /**
   * Get the count of whitelisted hashes
   */
  count(): number {
    return this.whitelist.size;
  }

  /**
   * Validate hash format (64 character hex string)
   */
  private isValidHash(hash: string): boolean {
    return /^[0-9a-fA-F]{64}$/.test(hash);
  }

  // Every disk operation runs here, one at a time, so no append can land between a
  // compaction's snapshot and its emptying of the log.
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // Callers hold the queue. Order matters: the line is durable before memory changes, and
  // memory has changed before a compaction snapshots it.
  private async commit(lines: string[], apply: () => void): Promise<void> {
    if (this.logDirty) await this.compact();
    try {
      const fh = await fs.open(this.logPath, 'a', 0o600);
      try {
        await fh.writeFile(lines.map(l => `${l}\n`).join(''));
        await fh.datasync();
      } finally {
        await fh.close();
      }
    } catch (error) {
      this.logDirty = true;
      throw error;
    }
    apply();
    this.logRecords += lines.length;
    if (this.logRecords >= this.compactAt) {
      try {
        await this.compact();
      } catch (error) {
        // The log still holds everything; try again after as many records again.
        console.error('Whitelist compaction failed, the log keeps growing until it succeeds:', error);
        this.compactAt = this.logRecords + this.threshold();
      }
    }
  }

  // Callers hold the queue.
  private async compact(): Promise<void> {
    const data = JSON.stringify(Array.from(this.whitelist));
    await fs.mkdir(dirname(this.persistPath), { recursive: true });
    const tmp = await fs.open(this.tempPath, 'w', 0o600);
    try {
      await tmp.writeFile(data);
      await tmp.datasync();
    } finally {
      await tmp.close();
    }
    this.onCompactionStep?.('temp-written');
    await fs.rename(this.tempPath, this.persistPath);
    this.onCompactionStep?.('renamed');
    // The rename must be durable before the log is emptied, or a power cut could keep the
    // empty log and the old snapshot.
    await syncDir(dirname(this.persistPath));
    this.onCompactionStep?.('dir-synced');
    const log = await fs.open(this.logPath, 'w', 0o600);
    try {
      await log.sync();
    } finally {
      await log.close();
    }
    this.onCompactionStep?.('log-emptied');
    this.logRecords = 0;
    this.logDirty = false;
    this.compactAt = this.threshold();
    console.log(`Persisted whitelist (${this.whitelist.size} hashes) to ${this.persistPath}`);
  }

  private threshold(): number {
    return Math.max(this.compactMin, this.whitelist.size);
  }
}

async function readIfExists(path: string, encoding: 'utf-8'): Promise<string | null>;
async function readIfExists(path: string, encoding: null): Promise<Buffer | null>;
async function readIfExists(path: string, encoding: 'utf-8' | null): Promise<string | Buffer | null> {
  try {
    return await fs.readFile(path, encoding === null ? {} : { encoding });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function parseSnapshot(text: string, path: string): Set<string> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`${path} is not valid JSON - refusing to start: ${(error as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`${path} is not a JSON array - refusing to start`);
  }
  const set = new Set<string>();
  for (const entry of parsed) {
    if (typeof entry !== 'string' || !/^[0-9a-fA-F]{64}$/.test(entry)) {
      throw new Error(`${path} holds an entry that is not a 64-hex hash (${JSON.stringify(entry)?.slice(0, 80)}) - refusing to start`);
    }
    set.add(entry.toLowerCase());
  }
  return set;
}

function parseLog(bytes: Buffer, path: string): { records: string[]; tornBytes: number } {
  const end = bytes.lastIndexOf(0x0a) + 1;
  const records = end === 0 ? [] : bytes.subarray(0, end - 1).toString('utf-8').split('\n');
  records.forEach((record, i) => {
    if (!LOG_RECORD.test(record)) {
      throw new Error(`${path} line ${i + 1} is not a whitelist record (${JSON.stringify(record.slice(0, 80))}) - refusing to start`);
    }
  });
  return { records, tornBytes: bytes.length - end };
}

function applyRecord(set: Set<string>, record: string): void {
  if (record === 'clear') set.clear();
  else if (record[0] === '+') set.add(record.slice(1));
  else set.delete(record.slice(1));
}

async function syncDir(dir: string): Promise<void> {
  const fh = await fs.open(dir, 'r');
  try {
    await fh.sync();
  } finally {
    await fh.close();
  }
}
