-- 002_idempotency_audit.sql
-- Idempotency keys (Milestone 3) and the transfer status audit log.

CREATE TABLE idempotency_keys (
  id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id        BIGINT      REFERENCES users (id),   -- NULL = platform-level request (sign-up, admin)
  key            UUID        NOT NULL,
  request_hash   CHAR(64)    NOT NULL,                -- SHA-256 of route + canonical JSON body
  status         TEXT        NOT NULL DEFAULT 'in_progress' CHECK (status IN ('in_progress', 'completed')),
  response_code  INT,
  response_body  JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at   TIMESTAMPTZ,
  CONSTRAINT idempotency_completed_has_response CHECK (
    status = 'in_progress' OR (response_code IS NOT NULL AND response_body IS NOT NULL)
  )
);
-- "(user_id, key) is unique". Two partial indexes because NULLs never collide in a plain UNIQUE.
CREATE UNIQUE INDEX idempotency_user_key_uq     ON idempotency_keys (user_id, key) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX idempotency_platform_key_uq ON idempotency_keys (key)          WHERE user_id IS NULL;
CREATE INDEX idempotency_created_idx            ON idempotency_keys (created_at);   -- 24h cleanup job

CREATE TABLE transfer_audit_logs (
  id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transfer_id  BIGINT      NOT NULL REFERENCES transfers (id),
  from_status  TEXT,                                   -- NULL on creation
  to_status    TEXT        NOT NULL,
  changed_by   TEXT        NOT NULL,                   -- 'user:12', 'admin:alice', 'system:...'
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX transfer_audit_logs_transfer_idx ON transfer_audit_logs (transfer_id, id);

CREATE TRIGGER transfer_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON transfer_audit_logs
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER transfer_audit_logs_no_truncate
  BEFORE TRUNCATE ON transfer_audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
