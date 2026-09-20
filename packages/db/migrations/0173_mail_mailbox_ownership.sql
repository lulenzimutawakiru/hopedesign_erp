-- 0173_mail_mailbox_ownership.sql
--
-- Names the person accountable for each company mailbox.
--
-- Every mailbox in HOPE DESIGN carried a NULL owner_user_id, so nobody was
-- individually answerable for info@, sales@ or procurement@: mail was visible
-- to whoever happened to be a member, and the mailbox itself had no
-- administrator. This migration records the assignments the business asked for:
--
--   info@        -> the CEO's assistant   (shared, company-wide enquiries)
--   sales@       -> John Paul             (head of Sales & Marketing)
--   procurement@ -> John Paul             (head of Procurement)
--
-- accounts@ and admin@ are deliberately left unassigned - no owner has been
-- named for them.
--
-- Three writes, each resolved by email rather than by id, so the migration
-- cannot bind the wrong person when ids differ between environments, and each
-- guarded so that a tenant without those accounts is left untouched instead of
-- failing on a missing row:
--
--   1. mailboxes.owner_user_id  - the owner the access resolver reads directly,
--      and the column that puts the mailbox in the owner's mailbox list.
--   2. mailbox_members (OWNER)  - the same grant, visible in the member list.
--   3. departments.head_user_id - the departmental head, for SAL and PROC.
--
-- Why the membership row carries every permission flag:
-- resolveMailboxAccess() prefers an explicit membership row over owner_user_id,
-- and grants the full permission set only on the path where the owner has no
-- membership row. John Paul is already a MEMBER of sales@ and procurement@, so
-- an OWNER row seeded with a narrower flag set would leave him with FEWER
-- rights than owner_user_id alone implies - his access would depend on which
-- row the resolver happened to read. Seeding the full set keeps both paths
-- identical, so "owner" means the same thing however it is reached.

-- ------------------------------------------------------------
-- 1. The accountable owner
-- ------------------------------------------------------------
WITH hd AS (
  SELECT id FROM tenants WHERE code = 'HDG'
),
want(mailbox_code, owner_email) AS (
  VALUES
    ('MAIL-INFO',        'mutawakirul@gmail.com'),
    ('MAIL-SALES',       'jpniyongabo40@gmail.com'),
    ('MAIL-PROCUREMENT', 'jpniyongabo40@gmail.com')
)
UPDATE mailboxes m
   SET owner_user_id = u.id,
       updated_at    = now()
  FROM hd
  JOIN want        ON true
  JOIN users u     ON u.tenant_id = hd.id
                  AND lower(btrim(u.email)) = lower(want.owner_email)
 WHERE m.tenant_id = hd.id
   AND m.code      = want.mailbox_code
   AND m.owner_user_id IS DISTINCT FROM u.id;

-- ------------------------------------------------------------
-- 2. The matching OWNER membership
-- ------------------------------------------------------------
-- ON CONFLICT upgrades the existing MEMBER rows rather than inserting a second
-- row, which the UNIQUE (mailbox_id, user_id) constraint would reject. The
-- WHERE on DO UPDATE makes a re-run a genuine no-op instead of rewriting
-- updated_at on every pass.
WITH hd AS (
  SELECT id FROM tenants WHERE code = 'HDG'
),
want(mailbox_code, owner_email) AS (
  VALUES
    ('MAIL-INFO',        'mutawakirul@gmail.com'),
    ('MAIL-SALES',       'jpniyongabo40@gmail.com'),
    ('MAIL-PROCUREMENT', 'jpniyongabo40@gmail.com')
)
INSERT INTO mailbox_members
  (tenant_id, mailbox_id, user_id, member_role, can_view, can_send, can_reply,
   can_delete, can_archive, can_delegate, can_export, can_admin, is_active, created_by)
SELECT hd.id, m.id, u.id, 'OWNER', true, true, true, true, true, true, true, true, true, u.id
  FROM hd
  JOIN want    ON true
  JOIN mailboxes m ON m.tenant_id = hd.id
                  AND m.code      = want.mailbox_code
  JOIN users u     ON u.tenant_id = hd.id
                  AND lower(btrim(u.email)) = lower(want.owner_email)
ON CONFLICT (mailbox_id, user_id) DO UPDATE SET
  member_role  = 'OWNER',
  can_view     = true,
  can_send     = true,
  can_reply    = true,
  can_delete   = true,
  can_archive  = true,
  can_delegate = true,
  can_export   = true,
  can_admin    = true,
  is_active    = true,
  updated_at   = now()
WHERE mailbox_members.member_role  IS DISTINCT FROM 'OWNER'
   OR mailbox_members.can_view     IS DISTINCT FROM true
   OR mailbox_members.can_send     IS DISTINCT FROM true
   OR mailbox_members.can_reply    IS DISTINCT FROM true
   OR mailbox_members.can_delete   IS DISTINCT FROM true
   OR mailbox_members.can_archive  IS DISTINCT FROM true
   OR mailbox_members.can_delegate IS DISTINCT FROM true
   OR mailbox_members.can_export   IS DISTINCT FROM true
   OR mailbox_members.can_admin    IS DISTINCT FROM true
   OR mailbox_members.is_active    IS DISTINCT FROM true;

-- ------------------------------------------------------------
-- 3. The departmental heads
-- ------------------------------------------------------------
-- SAL (Sales & Marketing) and PROC (Procurement) are both headed by John Paul.
-- Archived departments are skipped: a head is not assigned to a department that
-- is no longer in use.
WITH hd AS (
  SELECT id FROM tenants WHERE code = 'HDG'
),
heads(dept_code, head_email) AS (
  VALUES
    ('SAL',  'jpniyongabo40@gmail.com'),
    ('PROC', 'jpniyongabo40@gmail.com')
)
UPDATE departments d
   SET head_user_id = u.id,
       updated_at   = now()
  FROM hd
  JOIN heads   ON true
  JOIN users u ON u.tenant_id = hd.id
              AND lower(btrim(u.email)) = lower(heads.head_email)
 WHERE d.tenant_id  = hd.id
   AND d.code       = heads.dept_code
   AND d.archived_at IS NULL
   AND d.head_user_id IS DISTINCT FROM u.id;