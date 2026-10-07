# Isolation levels lab and the transfer fix (Milestone 2)

## Step 1: two psql sessions, side by side

Reproduce with the compose database running (`docker compose up -d db`):

```bash
npm run isolation-lab        # = bash scripts/isolation-lab.sh
```

The script creates a fresh `wallet_lab` database from the real migrations, opens **two real `psql` sessions**
(A and B) and feeds them the commands below step by step, printing each session's input (`psql -a` echoes it) and
output. The transcript is the unedited output of the run; lines starting `-- ` are narration. Data: Asha has a
`main` wallet with 100000 paise and a `savings` wallet with 50000 paise (account ids 4 and 5; ids 1-3 are the system accounts).

If you prefer to type it yourself, open two terminals with
`docker compose exec db psql -U wallet -d wallet_lab` and paste the `[A]` / `[B]` lines in the order shown.

```text
================ CASE 1: READ COMMITTED (the PostgreSQL default) ================

-- Session A reads the balance, B changes it and commits, A reads again.
[A] BEGIN;
[A] SHOW transaction_isolation;
[A]  transaction_isolation 
[A] -----------------------
[A]  read committed
[A] (1 row)
[A] 
[A] SELECT id, label, balance FROM accounts WHERE label = 'main';
[A]  id | label | balance 
[A] ----+-------+---------
[A]   4 | main  |  100000
[A] (1 row)
[A] 
[B] BEGIN;
[B] UPDATE accounts SET balance = balance - 30000 WHERE label = 'main';
[B] COMMIT;
[A] SELECT id, label, balance FROM accounts WHERE label = 'main';
[A]  id | label | balance 
[A] ----+-------+---------
[A]   4 | main  |   70000
[A] (1 row)
[A] 
[A] COMMIT;

-- RESULT: A saw 100000 first and 70000 second inside ONE transaction (a non-repeatable read).

================ CASE 2: REPEATABLE READ ================

-- Same steps, but A runs at REPEATABLE READ.
[A] BEGIN ISOLATION LEVEL REPEATABLE READ;
[A] SHOW transaction_isolation;
[A]  transaction_isolation 
[A] -----------------------
[A]  repeatable read
[A] (1 row)
[A] 
[A] SELECT id, label, balance FROM accounts WHERE label = 'main';
[A]  id | label | balance 
[A] ----+-------+---------
[A]   4 | main  |  100000
[A] (1 row)
[A] 
[B] BEGIN;
[B] UPDATE accounts SET balance = balance - 30000 WHERE label = 'main';
[B] COMMIT;
[A] SELECT id, label, balance FROM accounts WHERE label = 'main';
[A]  id | label | balance 
[A] ----+-------+---------
[A]   4 | main  |  100000
[A] (1 row)
[A] 

-- RESULT: A still sees 100000. Its snapshot was frozen at its first query. Now A tries to write the row B changed:
[A] UPDATE accounts SET balance = balance - 10000 WHERE label = 'main';
[A] ERROR:  could not serialize access due to concurrent update
[A] ROLLBACK;
[A] SELECT id, label, balance FROM accounts WHERE label = 'main';
[A]  id | label | balance 
[A] ----+-------+---------
[A]   4 | main  |   70000
[A] (1 row)
[A] 

-- RESULT: the write fails (could not serialize access due to concurrent update). A must retry; the new snapshot shows 70000.

================ CASE 3: SERIALIZABLE (write skew) ================

-- Rule both sessions want to keep: Asha's two wallets together must keep at least 50000 paise. Each reads the total, then withdraws from a DIFFERENT wallet.
[A] BEGIN ISOLATION LEVEL SERIALIZABLE;
[B] BEGIN ISOLATION LEVEL SERIALIZABLE;
[A] SELECT SUM(balance) AS total FROM accounts WHERE user_id = 1;
[A]  total  
[A] --------
[A]  150000
[A] (1 row)
[A] 
[B] SELECT SUM(balance) AS total FROM accounts WHERE user_id = 1;
[B]  total  
[B] --------
[B]  150000
[B] (1 row)
[B] 

-- Both see 150000, so each thinks it may take 90000 (150000 - 90000 >= 50000).
[A] UPDATE accounts SET balance = balance - 90000 WHERE label = 'main';
[B] UPDATE accounts SET balance = balance - 40000 WHERE label = 'savings';
[A] COMMIT;
[B] COMMIT;
[B] ERROR:  could not serialize access due to read/write dependencies among transactions
[B] DETAIL:  Reason code: Canceled on identification as a pivot, during commit attempt.
[B] HINT:  The transaction might succeed if retried.
[B] ROLLBACK;
[B] WARNING:  there is no transaction in progress
 total_after 
-------------
       60000
(1 row)


-- RESULT: one transaction commits, the other is aborted with SQLSTATE 40001 (could not serialize access due to read/write dependencies). Without SERIALIZABLE both would commit and the total would be 20000, breaking the rule.

================ CASE 4: REPEATABLE READ with a JOIN ================

-- A joins accounts and users; B changes BOTH tables and commits; A repeats the join.
[A] BEGIN ISOLATION LEVEL REPEATABLE READ;
[A] SELECT u.name, a.label, a.balance FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.label = 'main';
[A]  name | label | balance 
[A] ------+-------+---------
[A]  Asha | main  |  100000
[A] (1 row)
[A] 
[B] BEGIN;
[B] UPDATE users SET name = 'Asha Sharma' WHERE id = 1;
[B] UPDATE accounts SET balance = balance - 30000 WHERE label = 'main';
[B] COMMIT;
[A] SELECT u.name, a.label, a.balance FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.label = 'main';
[A]  name | label | balance 
[A] ------+-------+---------
[A]  Asha | main  |  100000
[A] (1 row)
[A] 
[A] COMMIT;
[A] SELECT u.name, a.label, a.balance FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.label = 'main';
[A]     name     | label | balance 
[A] -------------+-------+---------
[A]  Asha Sharma | main  |   70000
[A] (1 row)
[A] 

-- RESULT: inside A's transaction both tables stayed frozen together (old name AND old balance). The snapshot is per transaction, not per table, so the guarantee holds for joins. After COMMIT, A sees both changes.

-- CAVEAT: the snapshot starts at the FIRST QUERY, not at BEGIN.
[A] BEGIN ISOLATION LEVEL REPEATABLE READ;
[B] UPDATE accounts SET balance = balance - 30000 WHERE label = 'main';
[A] SELECT label, balance FROM accounts WHERE label = 'main';
[A]  label | balance 
[A] -------+---------
[A]  main  |   70000
[A] (1 row)
[A] 
[A] COMMIT;

-- RESULT: A already sees 70000 because B committed before A's first SELECT took the snapshot.
```

### What the four cases show

| # | Level | What session A saw | Why it matters for a wallet |
|---|---|---|---|
| 1 | READ COMMITTED (default) | 100000, then **70000** inside one transaction | every statement gets a fresh snapshot: a balance you read and checked can be stale by the time you write |
| 2 | REPEATABLE READ | 100000 both times; writing the row B changed fails with `could not serialize access due to concurrent update` | one snapshot per transaction; Postgres refuses to let you overwrite a change you could not see, so the caller must retry |
| 3 | SERIALIZABLE | two sessions read the same total and wrote different rows (**write skew**); one commit fails with `40001 could not serialize access due to read/write dependencies among transactions` | only SERIALIZABLE catches anomalies where the transactions do not touch the same row. Which of the two is aborted is up to Postgres (here B at commit) |
| 4 | REPEATABLE READ + JOIN | old `name` **and** old `balance` while B had changed both tables | yes, the guarantee holds for joins: the snapshot is for the whole transaction, not per table. Caveat shown at the end: the snapshot is taken at the first query, not at `BEGIN` |

## Step 2: break it first

`scripts/naive-stampede.ts` (`npm run naive-stampede`) is a deliberately wrong transfer: it reads the balance,
checks it in application code, sleeps a few milliseconds ("business logic"), then writes `balance = <stale value>`,
with no locks. 100 parallel Rs 10 transfers against a Rs 500 wallet produced (one actual run; numbers vary run to run):

```text
--- naive transfer (no locks), 100 x Rs 10 against Rs 500 ---
transfers that "succeeded":      100   (correct answer: 50)
money that left the wallet:      Rs 1000  (wallet only ever held Rs 500)
stored balance of the wallet:    Rs 440  (lost updates: should be Rs 0)
balance computed from ledger:    Rs -500  (the ledger shows the real overdraft)
stored vs ledger mismatch:       Rs 940
```

Two classic failures at once: the **overdraft** (the check-then-act race let 100 transfers through instead of 50, so
the ledger says the wallet is at -Rs 500) and the **lost update** (each transaction wrote an absolute balance computed
from a stale read, so the stored balance, Rs 440, matches nothing). The `balance >= 0` CHECK did not save us: every stale
value it was handed was non-negative. This is exactly the drift the nightly reconciliation job exists to catch.

## Step 3: the fix, row locks

`src/services/transfers.ts` (`submit`). Everything below happens in one transaction, `BEGIN` / `COMMIT` are in
`src/db.ts` and `src/services/idempotency.ts`, not hidden in the transfer code:

```text
BEGIN                                                    -- READ COMMITTED
INSERT INTO idempotency_keys ... ON CONFLICT DO NOTHING  -- Milestone 3
SELECT id, kind, user_id, system_code, balance
  FROM accounts WHERE id = ANY($1) ORDER BY id FOR UPDATE   -- lock BOTH rows, ascending id
-- balance is now read under the lock; reject if balance < amount
-- fraud rules run here (still holding the locks)
INSERT INTO transfers ...  RETURNING *
INSERT INTO ledger_entries (debit source), (credit destination)
UPDATE accounts SET balance = balance - $amount WHERE id = $source
UPDATE accounts SET balance = balance + $amount WHERE id = $dest
INSERT INTO transfer_audit_logs ...
COMMIT                                                   -- balanced-entries trigger fires here
```

* **Deadlock prevention:** accounts are always locked in ascending `account_id` order (`lockAccounts`). If one
  transfer locked A then B while another locked B then A, each would wait for the other forever. The
  `opposite-direction transfers never deadlock` test fires 200 crossing transfers at once. Where a transfer row is involved
  (release / reverse) the order is always *transfer row first, then accounts*.
* **Re-read under the lock:** the balance used for the check is the one returned by the `FOR UPDATE` select, so
  nobody can change it between the check and the write. Under READ COMMITTED a waiting `FOR UPDATE` re-reads the newest
  committed row version once the lock is granted, which is what makes this correct.
* **All or nothing:** any error before `COMMIT` rolls back the transfer, entries, balances and audit row together.

### Which isolation level, and why

The transfer runs at **READ COMMITTED with explicit `SELECT ... FOR UPDATE` row locks**.

Is that enough? Yes for this workload: every invariant that matters (no overdraft, balance = ledger) is about
**rows we lock**: the two accounts. Two transfers touching the same account serialize on that account's row lock;
transfers touching different accounts run fully in parallel. The check "balance >= amount" is done on the locked row,
and the CHECK constraint is a backstop.

Why not SERIALIZABLE? It would also be correct (without the locks), but:

* **Throughput:** SSI tracks read/write dependencies between *all* concurrent transactions. Hot wallets (a merchant
  receiving thousands of payments) produce constant dependency cycles, so a large share of transactions are aborted
  with `40001` instead of just waiting their turn.
* **Retries:** every abort must be retried by the application, with back-off, and the retried request does the full work again;
  tail latency grows and a retry storm can build under load. Under row locks the second transfer simply waits a few ms and then succeeds.
* **Memory/CPU:** predicate-lock bookkeeping grows with concurrent transactions and rows read; reads become more expensive.

REPEATABLE READ would be the worst fit: with `FOR UPDATE` the second transfer fails with `could not serialize access due to concurrent update`
(case 2 above) instead of waiting, so a stampede on one wallet becomes a retry storm.

`withTx` in `src/db.ts` still retries `40001` / `40P01` as a safety net (it never fires on the happy path) and the reconciliation job
deliberately uses REPEATABLE READ because it only reads and needs one consistent snapshot.

## Acceptance test: the stampede

`tests/stampede.test.ts`: Rs 500 in one wallet, 100 concurrent Rs 10 transfers out, asserting exactly 50 succeed (201), exactly 50
fail with `INSUFFICIENT_FUNDS` (422), the wallet ends at 0 and never negative, the receiver has exactly Rs 500, and total debits
equal total credits. The test body **loops 20 times in one run**, and I also ran the whole suite repeatedly (see README).
