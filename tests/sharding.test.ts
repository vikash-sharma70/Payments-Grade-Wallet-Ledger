import { describe, expect, it } from 'vitest';
import { ConsistentHashRing, moduloShard } from '../src/sharding/consistentHash.js';

const KEYS = Array.from({ length: 20_000 }, (_, i) => i + 1); // user ids

describe('Stretch: consistent hashing', () => {
  it('is deterministic and spreads keys roughly evenly', () => {
    const ring = new ConsistentHashRing(['shard-a', 'shard-b', 'shard-c', 'shard-d']);
    const counts: Record<string, number> = {};
    for (const k of KEYS) counts[ring.locate(k)] = (counts[ring.locate(k)] ?? 0) + 1;
    expect(ring.locate(42)).toBe(ring.locate(42));
    for (const n of Object.values(counts)) expect(n / KEYS.length).toBeGreaterThan(0.15); // fair share is 0.25
  });

  it('adding a shard moves only about 1/N of the keys, and only onto the new shard', () => {
    const ring = new ConsistentHashRing(['shard-a', 'shard-b', 'shard-c', 'shard-d']);
    const before = new Map(KEYS.map((k) => [k, ring.locate(k)]));
    ring.addShard('shard-e');
    let moved = 0;
    for (const k of KEYS) {
      const now = ring.locate(k);
      if (now !== before.get(k)) {
        moved++;
        expect(now).toBe('shard-e'); // keys never shuffle between the old shards
      }
    }
    const frac = moved / KEYS.length;
    expect(frac).toBeGreaterThan(0.1);
    expect(frac).toBeLessThan(0.3); // ideal is 1/5 = 0.2
  });

  it('removing a shard only moves that shard\'s keys', () => {
    const ring = new ConsistentHashRing(['shard-a', 'shard-b', 'shard-c', 'shard-d']);
    const before = new Map(KEYS.map((k) => [k, ring.locate(k)]));
    ring.removeShard('shard-b');
    for (const k of KEYS) if (before.get(k) !== 'shard-b') expect(ring.locate(k)).toBe(before.get(k));
  });

  it('modulo hashing, by contrast, reshuffles most keys when a shard is added', () => {
    let moved = 0;
    for (const k of KEYS) if (moduloShard(k, 4) !== moduloShard(k, 5)) moved++;
    expect(moved / KEYS.length).toBeGreaterThan(0.7);
  });
});
