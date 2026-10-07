-- 001_core_schema.sql
-- Core money schema: users, accounts (wallets + system accounts), transfers, ledger entries.
-- Convention: plural snake_case tables, singular snake_case columns, BIGINT identity keys,
-- money as whole paise in BIGINT. For EVERY account: balance = SUM(credits) - SUM(debits).

CREATE TABLE users (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name        TEXT        NOT NULL CHECK (length(btrim(name)) > 0),
  email       TEXT        NOT NULL CHECK (email = lower(email) AND position('@' IN email) > 1),
  phone       TEXT        NOT NULL CHECK (length(btrim(phone)) >= 7),
  kyc_status  TEXT        NOT NULL DEFAULT 'pending'
              CHECK (kyc_status IN ('pending', 'verified', 'rejected')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT users_email_key UNIQUE (email),
  CONSTRAINT users_phone_key UNIQUE (phone)
);

-- One table for user wallets AND system accounts: the ledger only ever needs
-- "an account that can be debited or credited" (see docs/schema.md).
CREATE TABLE accounts (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind         TEXT        NOT NULL CHECK (kind IN ('user_wallet', 'system')),
  user_id      BIGINT      REFERENCES users (id),
  label        TEXT        NOT NULL CHECK (length(btrim(label)) > 0),
  system_code  TEXT        CHECK (system_code IN ('CASH_IN', 'CASH_OUT', 'FEE_REVENUE')),
  currency     CHAR(3)     NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  balance      BIGINT      NOT NULL DEFAULT 0,        -- paise, = credits - debits (stored, reconciled nightly)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- a wallet belongs to a user and has no system code; a system account is the opposite
  CONSTRAINT accounts_kind_shape CHECK (
    (kind = 'user_wallet' AND user_id IS NOT NULL AND system_code IS NULL) OR
    (kind = 'system'      AND user_id IS NULL     AND system_code IS NOT NULL)
  ),
  -- THE overdraft guard: user wallets can never go below zero, system accounts may.
  CONSTRAINT accounts_user_wallet_non_negative CHECK (kind = 'system' OR balance >= 0)
);
CREATE UNIQUE INDEX accounts_user_label_key  ON accounts (user_id, label) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX accounts_system_code_key ON accounts (system_code)    WHERE system_code IS NOT NULL;
CREATE INDEX accounts_user_id_idx            ON accounts (user_id)        WHERE user_id IS NOT NULL;

INSERT INTO accounts (kind, label, system_code) VALUES
  ('system', 'Cash in (top-ups)',          'CASH_IN'),
  ('system', 'Cash out (withdrawals)',     'CASH_OUT'),
  ('system', 'Fee revenue',                'FEE_REVENUE');

CREATE TABLE transfers (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  type                    TEXT        NOT NULL
                          CHECK (type IN ('top_up', 'peer_transfer', 'withdrawal', 'fee', 'reversal')),
  status                  TEXT        NOT NULL
                          CHECK (status IN ('held', 'completed', 'rejected', 'failed', 'reversed')),
  amount                  BIGINT      NOT NULL CHECK (amount > 0),       -- paise
  currency                CHAR(3)     NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  source_account_id       BIGINT      NOT NULL REFERENCES accounts (id), -- debited
  destination_account_id  BIGINT      NOT NULL REFERENCES accounts (id), -- credited
  initiated_by_user_id    BIGINT      REFERENCES users (id),             -- NULL for system/admin initiated
  reverses_transfer_id    BIGINT      REFERENCES transfers (id),         -- set only on reversals
  parent_transfer_id      BIGINT      REFERENCES transfers (id),         -- set only on fees
  note                    TEXT        CHECK (length(note) <= 500),       -- USER INPUT: never trusted
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT transfers_distinct_accounts CHECK (source_account_id <> destination_account_id),
  CONSTRAINT transfers_reversal_points_to_original CHECK ((type = 'reversal') = (reverses_transfer_id IS NOT NULL)),
  CONSTRAINT transfers_fee_points_to_parent CHECK ((type = 'fee') = (parent_transfer_id IS NOT NULL))
);
-- A transfer can be reversed at most once; a transfer has at most one fee.
CREATE UNIQUE INDEX transfers_reverses_key ON transfers (reverses_transfer_id) WHERE reverses_transfer_id IS NOT NULL;
CREATE UNIQUE INDEX transfers_parent_key   ON transfers (parent_transfer_id)   WHERE parent_transfer_id IS NOT NULL;
-- Fraud rules + "last 10 transfers of a wallet" look at a wallet's recent transfers.
CREATE INDEX transfers_source_created_idx      ON transfers (source_account_id, created_at DESC);
CREATE INDEX transfers_destination_created_idx ON transfers (destination_account_id, created_at DESC);
CREATE INDEX transfers_status_created_idx      ON transfers (status, created_at) WHERE status = 'held';

CREATE TABLE ledger_entries (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id BIGINT      NOT NULL REFERENCES transfers (id),
  account_id  BIGINT      NOT NULL REFERENCES accounts (id),
  direction   TEXT        NOT NULL CHECK (direction IN ('debit', 'credit')),
  amount      BIGINT      NOT NULL CHECK (amount > 0),   -- positive; direction carries the sign
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Statement query: WHERE account_id = $1 ORDER BY created_at DESC, id DESC
CREATE INDEX ledger_entries_account_created_idx ON ledger_entries (account_id, created_at DESC, id DESC);
-- Per-transfer balance check, reversal lookup, FK support.
CREATE INDEX ledger_entries_transfer_idx ON ledger_entries (transfer_id);

-- ---------------------------------------------------------------------------
-- Ledger entries are append-only: no UPDATE, DELETE or TRUNCATE, ever.
-- Mistakes are fixed with a reversal transfer, never by editing history.
-- ---------------------------------------------------------------------------
CREATE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% on % is not allowed: the table is append-only', TG_OP, TG_TABLE_NAME
    USING ERRCODE = '55000';  -- object_not_in_prerequisite_state
END;
$$;

CREATE TRIGGER ledger_entries_immutable
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER ledger_entries_no_truncate
  BEFORE TRUNCATE ON ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- ---------------------------------------------------------------------------
-- Double entry enforced by the database: at COMMIT time the debits and credits
-- of every transfer that received entries must be equal and match the amount.
-- (Deferred, so the two legs can be inserted by two statements.)
-- ---------------------------------------------------------------------------
CREATE FUNCTION assert_transfer_balanced() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_debits  BIGINT;
  v_credits BIGINT;
  v_amount  BIGINT;
BEGIN
  SELECT COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'debit'), 0),
         COALESCE(SUM(e.amount) FILTER (WHERE e.direction = 'credit'), 0)
    INTO v_debits, v_credits
    FROM ledger_entries e
   WHERE e.transfer_id = NEW.transfer_id;

  SELECT t.amount INTO v_amount FROM transfers t WHERE t.id = NEW.transfer_id;

  IF v_debits <> v_credits OR v_debits <> v_amount THEN
    RAISE EXCEPTION 'transfer % is unbalanced: debits=% credits=% amount=%',
      NEW.transfer_id, v_debits, v_credits, v_amount
      USING ERRCODE = '23514';  -- check_violation
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER ledger_entries_balanced
  AFTER INSERT ON ledger_entries
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION assert_transfer_balanced();
