import { createHash } from 'node:crypto';

/**
 * Consistent-hash ring with virtual nodes (Stretch Milestone).
 *
 * Each shard is placed on the ring `vnodes` times; a key belongs to the first shard point clockwise
 * from the key's hash. Adding or removing a shard therefore only moves the keys between that shard's
 * points and their predecessors (about 1/N of all keys), instead of reshuffling everything the way
 * `hash(key) % N` does. See docs/sharding.md for how this applies to the wallet ledger.
 */
export class ConsistentHashRing {
  private points: { hash: number; shard: string }[] = [];
  private readonly shards = new Set<string>();

  constructor(shards: string[] = [], private readonly vnodes = 160) {
    shards.forEach((s) => this.addShard(s));
  }

  static hash(s: string): number {
    // first 4 bytes of MD5 as an unsigned 32-bit ring position
    return createHash('md5').update(s).digest().readUInt32BE(0);
  }

  addShard(shard: string) {
    if (this.shards.has(shard)) return;
    this.shards.add(shard);
    for (let i = 0; i < this.vnodes; i++) this.points.push({ hash: ConsistentHashRing.hash(`${shard}#${i}`), shard });
    this.points.sort((a, b) => a.hash - b.hash);
  }

  removeShard(shard: string) {
    if (!this.shards.delete(shard)) return;
    this.points = this.points.filter((p) => p.shard !== shard);
  }

  get shardNames(): string[] {
    return [...this.shards];
  }

  /** Which shard owns this key (e.g. a user id: all of a user's wallets live together). */
  locate(key: string | number): string {
    if (this.points.length === 0) throw new Error('ring has no shards');
    const h = ConsistentHashRing.hash(String(key));
    let lo = 0;
    let hi = this.points.length; // first point with hash >= h (binary search), wrapping to 0
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.points[mid].hash < h) lo = mid + 1;
      else hi = mid;
    }
    return this.points[lo % this.points.length].shard;
  }
}

/** The naive alternative, for comparison: adding a shard reshuffles almost every key. */
export const moduloShard = (key: string | number, shardCount: number) => ConsistentHashRing.hash(String(key)) % shardCount;
