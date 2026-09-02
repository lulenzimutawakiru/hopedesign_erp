-- Pre-auth bootstrap helpers for the least-privilege runtime role (DB-001,
-- Phase 2B). The API pool switches from the table owner (`hopedesign`) to
-- `hopedesign_app` (0126), which is subject to row-level security on every
-- tenant-scoped table (0127). A few flows must resolve identity *before* a
-- tenant context exists:
--   * login: find the user row from an email/username identifier,
--   * invitation redemption: find the invitation from its token hash,
--   * logout: revoke the session from the refresh-token hash or session id.
-- Those lookups cannot run as plain table queries under the app role (RLS
-- with no tenant context is fail-closed), so they are exposed as narrow
-- SECURITY DEFINER functions owned by the migration/owner role -- the same
-- posture the existing public verification and scheduler helpers already use
-- (verify_qr_public, get_due_cron_jobs, ...). Each function pins
-- search_path and EXECUTE is granted only to `hopedesign_app`.
--
-- Deployment premise (unchanged from 0126/0127): the object owner that runs
-- migrations owns these functions and is exempt from row security (superuser
-- or BYPASSRLS). The application role never receives BYPASSRLS.

-- Resolve a login identifier to its full users row before tenant context.
CREATE OR REPLACE FUNCTION public.auth_resolve_user_by_identifier(p_identifier text)
RETURNS SETOF public.users
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.users
   WHERE email = p_identifier OR username = p_identifier
   LIMIT 1;
$$;

-- Redeem an invitation by its stored token hash before tenant context.
CREATE OR REPLACE FUNCTION public.auth_invitation_by_token_hash(p_token_hash text)
RETURNS SETOF public.user_invitations
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.user_invitations
   WHERE token_hash = p_token_hash
   LIMIT 1;
$$;

-- Revoke a session by refresh-token hash (logout / logout-all paths).
CREATE OR REPLACE FUNCTION public.auth_revoke_session_by_token_hash(p_token_hash text)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.sessions SET revoked_at = now()
   WHERE token_hash = p_token_hash AND revoked_at IS NULL;
$$;

-- Revoke a session by id (logout with a bearer access token).
CREATE OR REPLACE FUNCTION public.auth_revoke_session_by_id(p_session_id bigint)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.sessions SET revoked_at = now()
   WHERE id = p_session_id AND revoked_at IS NULL;
$$;

-- Narrow execution to the least-privilege role only (owner keeps implicit
-- EXECUTE; PUBLIC is stripped so arbitrary DB users cannot probe identity).
REVOKE ALL ON FUNCTION public.auth_resolve_user_by_identifier(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_invitation_by_token_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_revoke_session_by_token_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_revoke_session_by_id(bigint) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.auth_resolve_user_by_identifier(text) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.auth_invitation_by_token_hash(text) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.auth_revoke_session_by_token_hash(text) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.auth_revoke_session_by_id(bigint) TO hopedesign_app;
