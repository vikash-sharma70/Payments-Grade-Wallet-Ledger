# Performance evidence

All numbers: PostgreSQL 16 in Docker on a laptop (Apple silicon, default `postgresql.conf`), single run each, warm cache.
Reproduce: `npm run bench:explain` (against an empty database; it seeds ~1M entries itself) and `npm run bench:fraud`.

## 1. Reconciliation checks at ~1M ledger entries

Data set: 1,300,000 ledger entries, 650,000 transfers, 10,003 accounts

(`bench:explain` seeds 500,000 transfers = 1,000,000 entries, plus one "hot" wallet with 150,000 extra transfers so the
`OFFSET 100000` experiment has something to skip. Hence 1.3M entries in total.)

| Check | Execution time | Plan | Needs an index? |
|---|---|---|---|
| 1. global debits = credits | 30 ms | parallel seq scan of `ledger_entries`, one aggregate | **No.** It must read every row; an index cannot help. |
| 2. each transfer balances (`GROUP BY transfer_id HAVING`) | 305 ms | `GroupAggregate` over `ledger_entries_transfer_idx` | **No for the job.** The index lets the planner stream sorted groups with no hash table; a seq scan + `HashAggregate` over 650k groups is the alternative. Either way it reads every row. |
| 3. stored balance = computed | 53 ms | parallel seq scan + hash aggregate by account, hash-joined to `accounts` | **No.** Full scan, only 10k groups. |
| 4. no overdrafts | 69 ms | same shape as 3, restricted to user wallets | **No.** |
| 5a. completed transfer without entries (`NOT EXISTS`) | 88 ms (92 ms with the `transfer_id` index dropped) | hash anti join of two seq scans | **No.** I measured it both ways: the planner picks a hash anti join regardless. |
| 5b. entry without a transfer (`LEFT JOIN ... IS NULL`) | 89 ms | hash join; transfers read index-only through the primary key | **No**: the primary key on `transfers` is all it uses. |

**Which checks can afford a full table scan?** All five. It is a nightly job, and the whole set takes about 0.6 s at
1.3M entries (everything reads every row once, so it scales linearly: ~100x the data is minutes, still fine at night).
**Which need an index?** None of them for their own speed, which is the honest result. The indexes that matter for the
checks exist for other reasons: `ledger_entries (transfer_id)` is required by the deferred *balanced entries* trigger
(without it, every inserted ledger line would sequentially scan the table to sum its siblings at commit; the *transfer* path needs it,
not the nightly job) and by reversal lookups, and the primary keys are used by the joins in 5a/5b.
If the ledger outgrew a nightly full read, the next step is incremental reconciliation (check only entries newer than the last verified id, per-account checkpoints), not more indexes.

## 2. Statement pagination: why `OFFSET 100000` is slow

Hot wallet with ~150,000 entries, 20 rows per page.

| Query | Execution time | What it did |
|---|---|---|
| `ORDER BY created_at DESC, id DESC LIMIT 20 OFFSET 0` | **0.07 ms** | index scan on `(account_id, created_at DESC, id DESC)`, stops after 20 rows |
| same, `OFFSET 100000` | **52.7 ms** (~750x) | produced **100,020 rows** (`Gather Merge actual rows=100020`), sorted them (external merge on disk), then threw the first 100,000 away |
| cursor: `WHERE account_id = $1 AND (created_at, id) < ($2, $3) ORDER BY ... LIMIT 20`, same page as above | **0.08 ms** | index range scan seeks directly to the cursor and reads 20 rows |

**Why OFFSET is slow:** the database cannot jump to "row 100,001". It has to generate rows in order and discard the first
100,000, so the cost is proportional to the offset (page 5,000 costs 5,000x page 1) and the deep page also joins and sorts all those
rows (note the planner switched to a hash join + sort instead of a nested loop once it knew it needed 100k rows).
It is also *unstable*: a new entry arriving between page requests shifts every row down by one, so a client sees a duplicate or skips a row.

**Cursor (keyset) pagination** (`?cursor=...`, implemented in `src/services/statement.ts`) remembers the last `(created_at, id)`
and asks for rows strictly before it. The row-value comparison is a range condition on the index, so cost is constant
for any depth and new rows cannot cause duplicates or gaps. The trade-off: no "jump to page N". Offset mode stays as the default because the
brief asks for it; clients that scroll should use the cursor from `next_cursor`.

Without the `(account_id, created_at, id)` index the deep-page query took 55.8 ms here because the planner had already chosen a bitmap + hash join + sort plan for this
join. The index matters for the cheap case: page 1 and every cursor page would become a sort of the account's whole history.

<details><summary>Full EXPLAIN (ANALYZE, BUFFERS) output of every query above</summary>

### Check 1: global balance
```
Finalize Aggregate (actual rows=1 loops=1)
  Buffers: shared hit=7147 read=5003 written=96
  ->  Gather (actual rows=3 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=7147 read=5003 written=96
        ->  Partial Aggregate (actual rows=1 loops=3)
              Buffers: shared hit=7147 read=5003 written=96
              ->  Parallel Seq Scan on ledger_entries (actual rows=433333 loops=3)
                    Buffers: shared hit=7147 read=5003 written=96
Planning:
  Buffers: shared hit=6
Planning Time: 0.068 ms
Execution Time: 29.553 ms
```

### Check 2: per-transfer balance
```
GroupAggregate (actual rows=0 loops=1)
  Group Key: transfer_id
  Filter: (COALESCE(sum(amount) FILTER (WHERE (direction = 'debit'::text)), '0'::numeric) <> COALESCE(sum(amount) FILTER (WHERE (direction = 'credit'::text)), '0'::numeric))
  Rows Removed by Filter: 650000
  Buffers: shared hit=1289427 read=14126 written=9830
  ->  Index Scan using ledger_entries_transfer_idx on ledger_entries (actual rows=1300000 loops=1)
        Buffers: shared hit=1289427 read=14126 written=9830
Planning Time: 0.057 ms
Execution Time: 305.222 ms
```

### Check 3: stored balances
```
Sort (actual rows=0 loops=1)
  Sort Key: a.id
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=12150 read=228 written=124
  ->  Hash Left Join (actual rows=0 loops=1)
        Hash Cond: (a.id = c.account_id)
        Filter: (a.balance <> COALESCE(c.balance, '0'::bigint))
        Rows Removed by Filter: 10003
        Buffers: shared hit=12150 read=228 written=124
        ->  Seq Scan on accounts a (actual rows=10003 loops=1)
              Buffers: shared read=228 written=124
        ->  Hash (actual rows=10001 loops=1)
              Buckets: 16384  Batches: 1  Memory Usage: 597kB
              Buffers: shared hit=12150
              ->  Subquery Scan on c (actual rows=10001 loops=1)
                    Buffers: shared hit=12150
                    ->  Finalize HashAggregate (actual rows=10001 loops=1)
                          Group Key: ledger_entries.account_id
                          Batches: 1  Memory Usage: 1937kB
                          Buffers: shared hit=12150
                          ->  Gather (actual rows=30003 loops=1)
                                Workers Planned: 2
                                Workers Launched: 2
                                Buffers: shared hit=12150
                                ->  Partial HashAggregate (actual rows=10001 loops=3)
                                      Group Key: ledger_entries.account_id
                                      Batches: 1  Memory Usage: 1937kB
                                      Buffers: shared hit=12150
                                      Worker 0:  Batches: 1  Memory Usage: 1937kB
                                      Worker 1:  Batches: 1  Memory Usage: 1937kB
                                      ->  Parallel Seq Scan on ledger_entries (actual rows=433333 loops=3)
                                            Buffers: shared hit=12150
Planning:
  Buffers: shared hit=13
Planning Time: 0.109 ms
Execution Time: 52.608 ms
```

### Check 4: overdrafts
```
Sort (actual rows=0 loops=1)
  Sort Key: a.id
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=12838 read=2 written=2
  ->  Finalize HashAggregate (actual rows=0 loops=1)
        Group Key: a.id
        Filter: (sum(CASE e.direction WHEN 'credit'::text THEN e.amount ELSE (- e.amount) END) < '0'::numeric)
        Batches: 1  Memory Usage: 1937kB
        Rows Removed by Filter: 10000
        Buffers: shared hit=12838 read=2 written=2
        ->  Gather (actual rows=30000 loops=1)
              Workers Planned: 2
              Workers Launched: 2
              Buffers: shared hit=12838 read=2 written=2
              ->  Partial HashAggregate (actual rows=10000 loops=3)
                    Group Key: a.id
                    Batches: 1  Memory Usage: 1937kB
                    Buffers: shared hit=12838 read=2 written=2
                    Worker 0:  Batches: 1  Memory Usage: 1937kB
                    Worker 1:  Batches: 1  Memory Usage: 1937kB
                    ->  Hash Join (actual rows=380000 loops=3)
                          Hash Cond: (e.account_id = a.id)
                          Buffers: shared hit=12838 read=2 written=2
                          ->  Parallel Seq Scan on ledger_entries e (actual rows=433333 loops=3)
                                Buffers: shared hit=12150
                          ->  Hash (actual rows=10000 loops=3)
                                Buckets: 16384  Batches: 1  Memory Usage: 519kB
                                Buffers: shared hit=684
                                ->  Seq Scan on accounts a (actual rows=10000 loops=3)
                                      Filter: (kind = 'user_wallet'::text)
                                      Rows Removed by Filter: 3
                                      Buffers: shared hit=684
Planning:
  Buffers: shared hit=19 read=10 written=10
Planning Time: 0.234 ms
Execution Time: 68.834 ms
```

### Check 5a: completed transfers without entries (WITH index on ledger_entries.transfer_id)
```
Gather Merge (actual rows=0 loops=1)
  Workers Planned: 2
  Workers Launched: 2
  Buffers: shared hit=12901 read=9889 written=90, temp read=7068 written=7184
  ->  Sort (actual rows=0 loops=3)
        Sort Key: t.id
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=12901 read=9889 written=90, temp read=7068 written=7184
        Worker 0:  Sort Method: quicksort  Memory: 25kB
        Worker 1:  Sort Method: quicksort  Memory: 25kB
        ->  Parallel Hash Anti Join (actual rows=0 loops=3)
              Hash Cond: (t.id = e.transfer_id)
              Buffers: shared hit=12827 read=9889 written=90, temp read=7068 written=7184
              ->  Parallel Seq Scan on transfers t (actual rows=216667 loops=3)
                    Filter: (status = ANY ('{completed,reversed}'::text[]))
                    Buffers: shared hit=581 read=9889 written=90
              ->  Parallel Hash (actual rows=433333 loops=3)
                    Buckets: 262144  Batches: 16  Memory Usage: 5280kB
                    Buffers: shared hit=12150, temp written=4260
                    ->  Parallel Seq Scan on ledger_entries e (actual rows=433333 loops=3)
                          Buffers: shared hit=12150
Planning:
  Buffers: shared hit=23 read=9 written=9
Planning Time: 0.212 ms
Execution Time: 87.704 ms
```

### Check 5a: same query WITHOUT the transfer_id index
```
Gather Merge (actual rows=0 loops=1)
  Workers Planned: 2
  Workers Launched: 2
  Buffers: shared hit=12997 read=9793, temp read=7069 written=7208
  ->  Sort (actual rows=0 loops=3)
        Sort Key: t.id
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=12997 read=9793, temp read=7069 written=7208
        Worker 0:  Sort Method: quicksort  Memory: 25kB
        Worker 1:  Sort Method: quicksort  Memory: 25kB
        ->  Parallel Hash Anti Join (actual rows=0 loops=3)
              Hash Cond: (t.id = e.transfer_id)
              Buffers: shared hit=12923 read=9793, temp read=7069 written=7208
              ->  Parallel Seq Scan on transfers t (actual rows=216667 loops=3)
                    Filter: (status = ANY ('{completed,reversed}'::text[]))
                    Buffers: shared hit=677 read=9793
              ->  Parallel Hash (actual rows=433333 loops=3)
                    Buckets: 262144  Batches: 16  Memory Usage: 5280kB
                    Buffers: shared hit=12150, temp written=4256
                    ->  Parallel Seq Scan on ledger_entries e (actual rows=433333 loops=3)
                          Buffers: shared hit=12150
Planning:
  Buffers: shared hit=17 read=1
Planning Time: 0.109 ms
Execution Time: 92.341 ms
```

### Check 5b: entries without a transfer
```
Sort (actual rows=0 loops=1)
  Sort Key: e.id
  Sort Method: quicksort  Memory: 25kB
  Buffers: shared hit=12311 read=1774 written=2, temp read=7678 written=7760
  ->  Gather (actual rows=0 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=12311 read=1774 written=2, temp read=7678 written=7760
        ->  Parallel Hash Anti Join (actual rows=0 loops=3)
              Hash Cond: (e.transfer_id = t.id)
              Buffers: shared hit=12311 read=1774 written=2, temp read=7678 written=7760
              ->  Parallel Seq Scan on ledger_entries e (actual rows=433333 loops=3)
                    Buffers: shared hit=12150
              ->  Parallel Hash (actual rows=216667 loops=3)
                    Buckets: 262144  Batches: 8  Memory Usage: 5280kB
                    Buffers: shared hit=7 read=1774 written=2, temp written=1984
                    ->  Parallel Index Only Scan using transfers_pkey on transfers t (actual rows=216667 loops=3)
                          Heap Fetches: 0
                          Buffers: shared hit=7 read=1774 written=2
Planning:
  Buffers: shared hit=37 read=1
Planning Time: 0.151 ms
Execution Time: 89.009 ms
```

### Statement page 1 (OFFSET 0)
```
Limit (actual rows=20 loops=1)
  Buffers: shared hit=83 read=1
  ->  Nested Loop (actual rows=20 loops=1)
        Buffers: shared hit=83 read=1
        ->  Index Scan using ledger_entries_account_created_idx on ledger_entries e (actual rows=20 loops=1)
              Index Cond: (account_id = '1'::bigint)
              Buffers: shared hit=23
        ->  Index Only Scan using transfers_pkey on transfers t (actual rows=1 loops=20)
              Index Cond: (id = e.transfer_id)
              Heap Fetches: 0
              Buffers: shared hit=60 read=1
Planning:
  Buffers: shared hit=23 read=4
Planning Time: 0.151 ms
Execution Time: 0.070 ms
```

### Statement deep page (OFFSET 100000)
```
Limit (actual rows=20 loops=1)
  Buffers: shared hit=3407 read=1059, temp read=919 written=985
  ->  Gather Merge (actual rows=100020 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=3407 read=1059, temp read=919 written=985
        ->  Sort (actual rows=33865 loops=3)
              Sort Key: e.created_at DESC, e.id DESC
              Sort Method: external merge  Disk: 2736kB
              Buffers: shared hit=3407 read=1059, temp read=919 written=985
              Worker 0:  Sort Method: external merge  Disk: 2408kB
              Worker 1:  Sort Method: external merge  Disk: 2712kB
              ->  Parallel Hash Join (actual rows=53333 loops=3)
                    Hash Cond: (t.id = e.transfer_id)
                    Buffers: shared hit=3377 read=1059
                    ->  Parallel Index Only Scan using transfers_pkey on transfers t (actual rows=216667 loops=3)
                          Heap Fetches: 0
                          Buffers: shared hit=1781
                    ->  Parallel Hash (actual rows=53333 loops=3)
                          Buckets: 262144  Batches: 1  Memory Usage: 13376kB
                          Buffers: shared hit=1500 read=1059
                          ->  Parallel Bitmap Heap Scan on ledger_entries e (actual rows=53333 loops=3)
                                Recheck Cond: (account_id = '1'::bigint)
                                Heap Blocks: exact=541
                                Buffers: shared hit=1500 read=1059
                                ->  Bitmap Index Scan on ledger_entries_account_created_idx (actual rows=160000 loops=1)
                                      Index Cond: (account_id = '1'::bigint)
                                      Buffers: shared hit=3 read=1059
Planning:
  Buffers: shared hit=19
Planning Time: 0.083 ms
Execution Time: 52.730 ms
```

### Statement deep page via cursor (same rows as OFFSET 100000)
```
Limit (actual rows=20 loops=1)
  Buffers: shared hit=83 read=1
  ->  Nested Loop (actual rows=20 loops=1)
        Buffers: shared hit=83 read=1
        ->  Index Scan using ledger_entries_account_created_idx on ledger_entries e (actual rows=20 loops=1)
              Index Cond: ((account_id = '1'::bigint) AND (ROW(created_at, id) < ROW('2026-08-27 17:26:47.128+00'::timestamp with time zone, '1014411'::bigint)))
              Buffers: shared hit=22 read=1
        ->  Index Only Scan using transfers_pkey on transfers t (actual rows=1 loops=20)
              Index Cond: (id = e.transfer_id)
              Heap Fetches: 0
              Buffers: shared hit=61
Planning:
  Buffers: shared hit=19
Planning Time: 0.107 ms
Execution Time: 0.080 ms
```

### Statement deep page, OFFSET 100000, WITHOUT the (account_id, created_at, id) index
```
Limit (actual rows=20 loops=1)
  Buffers: shared hit=14115 read=1, temp read=920 written=986
  ->  Gather Merge (actual rows=100020 loops=1)
        Workers Planned: 2
        Workers Launched: 2
        Buffers: shared hit=14115 read=1, temp read=920 written=986
        ->  Sort (actual rows=33890 loops=3)
              Sort Key: e.created_at DESC, e.id DESC
              Sort Method: external merge  Disk: 2624kB
              Buffers: shared hit=14115 read=1, temp read=920 written=986
              Worker 0:  Sort Method: external merge  Disk: 2576kB
              Worker 1:  Sort Method: external merge  Disk: 2664kB
              ->  Parallel Hash Join (actual rows=53333 loops=3)
                    Hash Cond: (t.id = e.transfer_id)
                    Buffers: shared hit=14027 read=1
                    ->  Parallel Index Only Scan using transfers_pkey on transfers t (actual rows=216667 loops=3)
                          Heap Fetches: 0
                          Buffers: shared hit=1781 read=1
                    ->  Parallel Hash (actual rows=53333 loops=3)
                          Buckets: 262144  Batches: 1  Memory Usage: 13376kB
                          Buffers: shared hit=12150
                          ->  Parallel Seq Scan on ledger_entries e (actual rows=53333 loops=3)
                                Filter: (account_id = '1'::bigint)
                                Rows Removed by Filter: 380000
                                Buffers: shared hit=12150
Planning:
  Buffers: shared hit=26
Planning Time: 0.089 ms
Execution Time: 55.810 ms
```

</details>

## 3. How much time do the fraud rules add to a transfer?

`npm run bench:fraud` against the seeded database (1,000 users, 2,000 wallets, 100,000 transfers), 300 iterations each, rules evaluated inside the transfer transaction:

| Rule | Query | Index that keeps it fast | Avg per evaluation |
|---|---|---|---|
| `LARGE_AMOUNT` | none, compares the amount to the threshold | none needed | ~0.000 ms |
| `DAILY_VOLUME` | `SUM(amount)` of the wallet's completed outgoing transfers in the last 24 h | `transfers (source_account_id, created_at DESC)` | 0.21 ms |
| `VELOCITY` | `count(*)` of the wallet's transfers in the last 60 s | `transfers (source_account_id, created_at DESC)` / `(destination_account_id, created_at DESC)` for top-ups | 0.22 ms |
| `RECIPIENT_FANOUT` | `count(DISTINCT destination)` in the last hour | `transfers (source_account_id, created_at DESC)` | 0.18 ms |

End to end (`BEGIN` .. transfer .. `ROLLBACK`, one wallet): **2.17 ms with rules vs 1.45 ms without, so the four rules add about 0.7 ms per transfer**
(three index range queries plus one query to load the rules from `risk_rules`). Each rule only touches the wallet's own rows through the index, so the cost depends on how
many transfers that wallet made inside the window, not on the size of the table. The queries run **after** the wallet rows are locked, which also makes the counts
exact: concurrent transfers from one wallet are evaluated one after another.
