-- 003_reconciliation_risk.sql
-- Nightly reconciliation (Milestone 4) and fraud rules / flags (Milestone 5).

CREATE TABLE job_locks (
  job_name         TEXT PRIMARY KEY,
  last_started_at  TIMESTAMPTZ,
  last_finished_at TIMESTAMPTZ
);
INSERT INTO job_locks (job_name) VALUES ('reconciliation');

CREATE TABLE reconciliation_runs (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  trigger       TEXT        NOT NULL CHECK (trigger IN ('cron', 'manual')),
  started_at    TIMESTAMPTZ NOT NULL,
  finished_at   TIMESTAMPTZ NOT NULL,
  status        TEXT        NOT NULL CHECK (status IN ('ok', 'problems_found', 'failed')),
  checks_run    INT         NOT NULL DEFAULT 0,
  problem_count INT         NOT NULL DEFAULT 0,
  error         TEXT
);

CREATE TABLE reconciliation_problems (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id       BIGINT NOT NULL REFERENCES reconciliation_runs (id),
  check_name   TEXT   NOT NULL,   -- global_balance | transfer_balance | stored_balance | overdraft | orphan
  entity_type  TEXT   NOT NULL,   -- ledger | transfer | account | ledger_entry
  entity_id    BIGINT,
  expected     BIGINT,
  actual       BIGINT,
  details      JSONB  NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX reconciliation_problems_run_idx ON reconciliation_problems (run_id);

-- Fraud rules: thresholds live in data, not in code.
CREATE TABLE risk_rules (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code        TEXT        NOT NULL UNIQUE,
  description TEXT        NOT NULL,
  action      TEXT        NOT NULL CHECK (action IN ('hold', 'flag')),  -- hold = no money moves until admin releases
  params      JSONB       NOT NULL,
  enabled     BOOLEAN     NOT NULL DEFAULT TRUE,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO risk_rules (code, description, action, params) VALUES
  ('LARGE_AMOUNT',
   'A single transfer of at least min_amount paise (default Rs 50,000) is held for review.',
   'hold', '{"min_amount": 5000000}'),
  ('DAILY_VOLUME',
   'Money going out of a wallet in the last window_seconds (default 24h) plus this transfer exceeds max_total paise (default Rs 1,00,000): hold.',
   'hold', '{"max_total": 10000000, "window_seconds": 86400}'),
  ('VELOCITY',
   'max_count or more transfers from the same wallet within window_seconds: allowed, but flagged.',
   'flag', '{"max_count": 20, "window_seconds": 60}'),
  ('RECIPIENT_FANOUT',
   'Money sent to max_recipients or more distinct wallets within window_seconds: allowed, but flagged.',
   'flag', '{"max_recipients": 5, "window_seconds": 3600}');

CREATE TABLE risk_flags (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  BIGINT      NOT NULL REFERENCES transfers (id),
  rule_code    TEXT        NOT NULL REFERENCES risk_rules (code),
  action       TEXT        NOT NULL CHECK (action IN ('hold', 'flag')),
  details      JSONB       NOT NULL DEFAULT '{}'::jsonb,   -- what the rule saw (counts, sums, thresholds)
  label        TEXT        CHECK (label IN ('likely_ok', 'review', 'likely_fraud')),  -- from the nightly LLM step
  explanation  TEXT,
  llm_provider TEXT,
  explained_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT risk_flags_transfer_rule_key UNIQUE (transfer_id, rule_code)
);
CREATE INDEX risk_flags_created_idx ON risk_flags (created_at);
