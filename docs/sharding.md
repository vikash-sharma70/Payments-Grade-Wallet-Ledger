# Stretch milestone: sharding and consistent hashing

What is implemented: `src/sharding/consistentHash.ts` (a consistent-hash ring with virtual nodes) and
`tests/sharding.test.ts`. The running service is **not** sharded; this document is the design for how it would be,
and the ring is the routing piece that design needs.

## The ring

* Each shard is placed on a 32-bit ring `160` times (virtual nodes), at `md5("<shard>#<i>")`.
* A key belongs to the first shard point clockwise from `md5(key)` (binary search, `O(log(shards x vnodes))`).
* Tests show: keys spread evenly (every shard of 4 gets > 15% of keys, fair share 25%); **adding a 5th shard moves
  about 20% of keys and only onto the new shard**; removing a shard only moves that shard's keys; whereas `hash % N`
  moves > 70% of keys when N goes 4 -> 5. For a ledger, "moves" means copying money history between databases, so
  this is the difference between a routine resize and a migration project.

## Shard key: `user_id`

* A user's wallets, their ledger entries, idempotency keys and statement all live on one shard, so **balance, statement,
  deposit, withdrawal and the user's idempotency keys never leave a shard**. The statement query is already
  `WHERE account_id = ?`, so it is unchanged.
* Account ids would become `(shard, local id)` or be allocated per shard from disjoint ranges, so a wallet id alone says where to route.
* System accounts (`CASH_IN`, `CASH_OUT`, `FEE_REVENUE`) exist **per shard** (e.g. `CASH_IN@shard-3`). They are hot rows today
  (every top-up locks `CASH_IN`), and per-shard copies also spread that contention. Company-level totals are the sum across shards.

## The hard part: a transfer between users on different shards

A single ACID transaction no longer covers both wallets, and both can't be row-locked at once. Options:

| Approach | Verdict |
|---|---|
| Two-phase commit across shards | Correct, but blocks on coordinator failure and holds locks across a network round trip. Reasonable only if cross-shard traffic is rare. |
| **Saga with a transit account** (what I would build) | Transfer A -> B (different shards) becomes two *local, fully ACID* transfers: `A -> TRANSIT@shard(A)` on A's shard, then `TRANSIT@shard(B) -> B` on B's shard. Each is a normal double-entry transfer, so each shard's books always balance on their own. A durable outbox on shard(A) drives step 2 with an idempotency key (`transfer-<id>-leg2`), so retries are safe. If step 2 cannot complete, a **reversal transfer** (the mechanism already in this codebase) returns the money. The `TRANSIT` accounts must net to zero across shards, which becomes one more reconciliation check. |
| Application-level two locks | Not possible without a distributed lock service; no. |

Reconciliation would run per shard (as it does today) plus one cross-shard check that all transit accounts sum to zero.

## Adding a shard

1. Add the shard to the ring: only ~1/(N+1) of users change owner.
2. For each moving user: put the user in "migrating" state (writes return 503 + retry), copy rows, verify with the per-user ledger sum, flip the ring entry, delete from the old shard (the only legitimate `DELETE` of ledger rows, done by a privileged migration role with the immutability trigger disabled for that session).
3. Use a small routing table (user -> shard) as the source of truth, with the ring only choosing the initial placement; moves are explicit and a hot user can be pinned.

## Why not shard now

One PostgreSQL primary comfortably handles thousands of transfers per second (see `docs/performance.md`: ~2 ms per transfer
including the fraud rules). The first scaling steps are read replicas for statements and partitioning `ledger_entries` by month. Sharding adds the saga above,
per-shard system accounts, and resharding procedures; it should be paid for only when write throughput on one primary is the bottleneck.
