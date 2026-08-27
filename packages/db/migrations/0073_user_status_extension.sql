-- 0073_user_status_extension.sql
-- Widen users.status CHECK to cover the full identity lifecycle required by
-- the Users & Administration control plane: invitations, provisioning,
-- suspension, lockout, disable, and termination.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (
  status IN ('INVITED','PENDING_ACTIVATION','ACTIVE','INACTIVE','SUSPENDED','LOCKED','DISABLED','TERMINATED')
);
