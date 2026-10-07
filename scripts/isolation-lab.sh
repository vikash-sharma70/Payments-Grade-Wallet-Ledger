#!/usr/bin/env bash
# Milestone 2, Step 1: two real psql sessions (A and B), driven step by step, with the transcript printed.
# Needs the compose database:  docker compose up -d db
#   scripts/isolation-lab.sh | tee /tmp/isolation-transcript.txt
set -euo pipefail
cd "$(dirname "$0")/.."
DB_SVC=${DB_SVC:-db}
PSQL_BASE=(docker compose exec -T "$DB_SVC" psql -U wallet -X)

# fresh lab database built from the real migrations
"${PSQL_BASE[@]}" -d postgres -q -c "DROP DATABASE IF EXISTS wallet_lab" -c "CREATE DATABASE wallet_lab"
DATABASE_URL="postgres://wallet:wallet@localhost:${DB_PORT:-5433}/wallet_lab" npx tsx src/migrate.ts >/dev/null

WORK=$(mktemp -d)
mkfifo "$WORK/A.in" "$WORK/B.in"
: > "$WORK/A.out"; : > "$WORK/B.out"
"${PSQL_BASE[@]}" -d wallet_lab -a -q < "$WORK/A.in" > "$WORK/A.out" 2>&1 &
"${PSQL_BASE[@]}" -d wallet_lab -a -q < "$WORK/B.in" > "$WORK/B.out" 2>&1 &
exec 3>"$WORK/A.in" 4>"$WORK/B.in"
SEEN_A=0; SEEN_B=0   # bytes of each session's output already printed (plain vars: works on macOS bash 3.2)

# step <A|B> "sql": send to that session, wait a moment, print whatever the session printed
step() {
  local who=$1; shift
  if [ "$who" = A ]; then echo "$*" >&3; else echo "$*" >&4; fi
  sleep "${STEP_WAIT:-0.8}"
  local total seen
  total=$(wc -c < "$WORK/$who.out" | tr -d ' ')
  if [ "$who" = A ]; then seen=$SEEN_A; else seen=$SEEN_B; fi
  tail -c +$((seen + 1)) "$WORK/$who.out" | sed "s/^/[$who] /"
  if [ "$who" = A ]; then SEEN_A=$total; else SEEN_B=$total; fi
}
note() { printf '\n-- %s\n' "$*"; }

# setup data in a third, short-lived session
"${PSQL_BASE[@]}" -d wallet_lab -q <<'SQL'
INSERT INTO users (name, email, phone) VALUES ('Asha', 'asha@example.com', '9000000001');
INSERT INTO accounts (kind, user_id, label, balance) VALUES ('user_wallet', 1, 'main', 100000), ('user_wallet', 1, 'savings', 50000);
SQL
reset() { "${PSQL_BASE[@]}" -d wallet_lab -q -c "UPDATE accounts SET balance = 100000 WHERE label='main'; UPDATE accounts SET balance = 50000 WHERE label='savings'; UPDATE users SET name='Asha'"; }

echo "================ CASE 1: READ COMMITTED (the PostgreSQL default) ================"
note "Session A reads the balance, B changes it and commits, A reads again."
step A "BEGIN;"
step A "SHOW transaction_isolation;"
step A "SELECT id, label, balance FROM accounts WHERE label = 'main';"
step B "BEGIN;"
step B "UPDATE accounts SET balance = balance - 30000 WHERE label = 'main';"
step B "COMMIT;"
step A "SELECT id, label, balance FROM accounts WHERE label = 'main';"
step A "COMMIT;"
note "RESULT: A saw 100000 first and 70000 second inside ONE transaction (a non-repeatable read)."
reset

echo; echo "================ CASE 2: REPEATABLE READ ================"
note "Same steps, but A runs at REPEATABLE READ."
step A "BEGIN ISOLATION LEVEL REPEATABLE READ;"
step A "SHOW transaction_isolation;"
step A "SELECT id, label, balance FROM accounts WHERE label = 'main';"
step B "BEGIN;"
step B "UPDATE accounts SET balance = balance - 30000 WHERE label = 'main';"
step B "COMMIT;"
step A "SELECT id, label, balance FROM accounts WHERE label = 'main';"
note "RESULT: A still sees 100000. Its snapshot was frozen at its first query. Now A tries to write the row B changed:"
step A "UPDATE accounts SET balance = balance - 10000 WHERE label = 'main';"
step A "ROLLBACK;"
step A "SELECT id, label, balance FROM accounts WHERE label = 'main';"
note "RESULT: the write fails (could not serialize access due to concurrent update). A must retry; the new snapshot shows 70000."
reset

echo; echo "================ CASE 3: SERIALIZABLE (write skew) ================"
note "Rule both sessions want to keep: Asha's two wallets together must keep at least 50000 paise. Each reads the total, then withdraws from a DIFFERENT wallet."
step A "BEGIN ISOLATION LEVEL SERIALIZABLE;"
step B "BEGIN ISOLATION LEVEL SERIALIZABLE;"
step A "SELECT SUM(balance) AS total FROM accounts WHERE user_id = 1;"
step B "SELECT SUM(balance) AS total FROM accounts WHERE user_id = 1;"
note "Both see 150000, so each thinks it may take 90000 (150000 - 90000 >= 50000)."
step A "UPDATE accounts SET balance = balance - 90000 WHERE label = 'main';"
step B "UPDATE accounts SET balance = balance - 40000 WHERE label = 'savings';"
step A "COMMIT;"
step B "COMMIT;"
step B "ROLLBACK;"
"${PSQL_BASE[@]}" -d wallet_lab -c "SELECT SUM(balance) AS total_after FROM accounts WHERE user_id = 1;"
note "RESULT: one transaction commits, the other is aborted with SQLSTATE 40001 (could not serialize access due to read/write dependencies). Without SERIALIZABLE both would commit and the total would be 20000, breaking the rule."
reset

echo; echo "================ CASE 4: REPEATABLE READ with a JOIN ================"
note "A joins accounts and users; B changes BOTH tables and commits; A repeats the join."
step A "BEGIN ISOLATION LEVEL REPEATABLE READ;"
step A "SELECT u.name, a.label, a.balance FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.label = 'main';"
step B "BEGIN;"
step B "UPDATE users SET name = 'Asha Sharma' WHERE id = 1;"
step B "UPDATE accounts SET balance = balance - 30000 WHERE label = 'main';"
step B "COMMIT;"
step A "SELECT u.name, a.label, a.balance FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.label = 'main';"
step A "COMMIT;"
step A "SELECT u.name, a.label, a.balance FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.label = 'main';"
note "RESULT: inside A's transaction both tables stayed frozen together (old name AND old balance). The snapshot is per transaction, not per table, so the guarantee holds for joins. After COMMIT, A sees both changes."
reset
note "CAVEAT: the snapshot starts at the FIRST QUERY, not at BEGIN."
step A "BEGIN ISOLATION LEVEL REPEATABLE READ;"
step B "UPDATE accounts SET balance = balance - 30000 WHERE label = 'main';"
step A "SELECT label, balance FROM accounts WHERE label = 'main';"
step A "COMMIT;"
note "RESULT: A already sees 70000 because B committed before A's first SELECT took the snapshot."

exec 3>&- 4>&-
wait
rm -rf "$WORK"
