import { promises as fs } from 'fs';
import { join } from 'path';

export class WhitelistManager {
  private whitelist: Set<string>;
  private persistPath: string;

  constructor(persistPath: string = '/data/whitelist.json') {
    this.whitelist = new Set<string>();
    this.persistPath = persistPath;
  }

  /**
   * Initialize the whitelist by loading from persistent storage
   */
  async initialize(): Promise<void> {
    try {
      console.log(`Loading whitelist from ${this.persistPath}`);
      const data = await fs.readFile(this.persistPath, 'utf-8');
      const hashes: string[] = JSON.parse(data);
      // Normalize all hashes to lowercase for consistent matching
      this.whitelist = new Set(hashes.map(h => h.toLowerCase()));
      console.log(`Loaded ${this.whitelist.size} hashes from whitelist`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        console.log('No existing whitelist found, starting with empty whitelist');
        await this.persist();
      } else {
        console.error('Error loading whitelist:', error);
        throw error;
      }
    }
  }

  /**
   * Persist the current whitelist to disk
   */
  private async persist(): Promise<void> {
    try {
      const dir = join(this.persistPath, '..');
      await fs.mkdir(dir, { recursive: true });
      const data = JSON.stringify(Array.from(this.whitelist), null, 2);
      await fs.writeFile(this.persistPath, data, 'utf-8');
      console.log(`Persisted whitelist (${this.whitelist.size} hashes) to ${this.persistPath}`);
    } catch (error) {
      console.error('Error persisting whitelist:', error);
      throw error;
    }
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
    this.whitelist.add(hash.toLowerCase());
    await this.persist();
  }

  /**
   * Add multiple hashes to the whitelist (normalized to lowercase)
   */
  async addMany(hashes: string[]): Promise<void> {
    for (const hash of hashes) {
      if (!this.isValidHash(hash)) {
        throw new Error(`Invalid hash format: ${hash}`);
      }
      this.whitelist.add(hash.toLowerCase());
    }
    await this.persist();
  }

  /**
   * Remove a hash from the whitelist (case-insensitive)
   */
  async remove(hash: string): Promise<void> {
    this.whitelist.delete(hash.toLowerCase());
    await this.persist();
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
    this.whitelist.clear();
    await this.persist();
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
}
