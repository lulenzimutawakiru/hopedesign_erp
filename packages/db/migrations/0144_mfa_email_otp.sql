-- 0144_mfa_email_otp.sql
-- MFA-002: replace the authenticator-app (TOTP) second factor with a six-digit
-- one-time code emailed to the account holder's PERSONAL address.
--
-- Design notes
--  * users.personal_email is the delivery address for the sign-in code. It is a
--    real column rather than an attributes jsonb key so it can be uniquely
--    indexed, validated, and searched by an operator who is unblocking an
--    account. The address is personal on purpose: the code must still be
--    deliverable when the company mailbox is unreachable.
--  * The TOTP columns (mfa_secret / mfa_method = 'TOTP') are deliberately kept.
--    Accounts already enrolled in an authenticator app keep working as a
--    fallback and no secret is ever deleted, so this change is reversible.
--  * mfa_email_codes stores only the sha256 hash of the code. A plaintext code
--    is never persisted, returned by an API, or written to a log.
--  * No row trigger is attached to mfa_email_codes: the API logs an explicit
--    audit entry for every issue/verify/failure instead of copying credential
--    rows into the generic audit log.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 1. Personal (sign-in) email on the identity record.
-- ---------------------------------------------------------------------------
ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS personal_email_verified_at TIMESTAMPTZ;

COMMENT ON COLUMN users.personal_email IS
  'Personal address that receives the emailed MFA sign-in code. Distinct from users.email (work address).';

CREATE UNIQUE INDEX IF NOT EXISTS ux_users_personal_email
  ON users (lower(personal_email))
  WHERE personal_email IS NOT NULL;

-- ---------------------------------------------------------------------------
-- 2. One-time email sign-in codes.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mfa_email_codes (
  id BIGSERIAL PRIMARY KEY,
  tenant_id BIGINT NOT NULL REFERENCES tenants(id),
  user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  -- Address the code was delivered to. For CHANGE_EMAIL this is the *pending*
  -- new address, which is only promoted onto users.personal_email after the
  -- holder proves they can read it.
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  purpose TEXT NOT NULL DEFAULT 'LOGIN',
  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 5,
  ip TEXT,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mfa_email_codes_purpose_chk CHECK (purpose IN ('LOGIN', 'ENROLL', 'CHANGE_EMAIL')),
  CONSTRAINT mfa_email_codes_attempts_chk CHECK (attempts >= 0)
);

CREATE INDEX IF NOT EXISTS idx_mfa_email_codes_user
  ON mfa_email_codes (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mfa_email_codes_tenant
  ON mfa_email_codes (tenant_id, created_at DESC);
-- Hot path: "newest still-open code for this user".
CREATE INDEX IF NOT EXISTS idx_mfa_email_codes_open
  ON mfa_email_codes (user_id, purpose)
  WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. Tenant isolation, matching every other integration/governance table.
--    (0126 granted SELECT/INSERT/UPDATE/DELETE on all tables plus ALTER
--    DEFAULT PRIVILEGES to the runtime role, so no explicit GRANT is needed.)
-- ---------------------------------------------------------------------------
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['mfa_email_codes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = t AND policyname = 'tenant_isolation') THEN
      EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = app_tenant_id())', t);
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 4. Backfill: every account that already has a TOTP secret keeps it, so the
--    method column stays truthful. Accounts with no method yet are marked
--    EMAIL so the next challenge is the emailed code.
-- ---------------------------------------------------------------------------
UPDATE users
   SET mfa_method = 'EMAIL'
 WHERE mfa_method IS NULL
   AND mfa_secret IS NULL;

-- ---------------------------------------------------------------------------
-- 5. Expire codes that were never used so a long-dormant row can never be
--    replayed after this migration.
-- ---------------------------------------------------------------------------
UPDATE mfa_email_codes SET consumed_at = now() WHERE consumed_at IS NULL AND expires_at < now();