-- Self-service password reset (AUTH-003).
--
-- `password_reset_tokens` has existed since 0072, but until now only the admin
-- console minted tokens and nothing ever consumed one: there was no way for an
-- employee to recover their own account, and no trace of who asked.
--
-- Row security note: 0127 enables AND forces RLS on every table carrying
-- `tenant_id`, and this table carries a single `tenant_isolation` policy. The
-- reset flow must read and consume a token at a point where no session exists
-- at all - the holder cannot sign in, which is the whole reason they are here -
-- so a plain table query would be fail-closed. Every token access therefore
-- goes through the narrow SECURITY DEFINER helpers below, the same posture as
-- the pre-login helpers in 0128. Each one pins search_path and grants EXECUTE
-- only to the least-privilege runtime role.

-- Organisation, provenance and Service Desk hand-off for each request.
ALTER TABLE public.password_reset_tokens
  ADD COLUMN IF NOT EXISTS company_id BIGINT REFERENCES public.companies(id),
  ADD COLUMN IF NOT EXISTS branch_id BIGINT REFERENCES public.branches(id),
  ADD COLUMN IF NOT EXISTS ticket_id BIGINT REFERENCES public.service_tickets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS requested_ip TEXT,
  ADD COLUMN IF NOT EXISTS user_agent TEXT;

CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user_created
  ON public.password_reset_tokens(user_id, created_at DESC);

-- Mint a reset token. `created_by` is the account's own id: a self-service
-- request is self-authorised, and the audit trail already separates the two
-- flows by the action name.
CREATE OR REPLACE FUNCTION public.auth_reset_create(
  p_tenant bigint,
  p_user bigint,
  p_token_hash text,
  p_expires_at timestamptz,
  p_company bigint,
  p_branch bigint,
  p_ip text,
  p_user_agent text
)
RETURNS SETOF public.password_reset_tokens
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  INSERT INTO public.password_reset_tokens
    (tenant_id, user_id, token_hash, expires_at, created_by,
     company_id, branch_id, requested_ip, user_agent)
  VALUES (p_tenant, p_user, p_token_hash, p_expires_at, p_user,
          p_company, p_branch, p_ip, p_user_agent)
  RETURNING *;
$$;

-- Look a token up by its stored hash (pre-session, so pre-tenant-context).
CREATE OR REPLACE FUNCTION public.auth_reset_token_by_hash(p_token_hash text)
RETURNS SETOF public.password_reset_tokens
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.password_reset_tokens
   WHERE token_hash = p_token_hash
   LIMIT 1;
$$;

-- Claim a token. The UPDATE only matches while the token is unused and
-- unexpired and hands the row back only to the caller that actually won, so two
-- concurrent submissions cannot both complete a reset.
CREATE OR REPLACE FUNCTION public.auth_reset_consume(p_token_hash text, p_ip text, p_user_agent text)
RETURNS SETOF public.password_reset_tokens
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.password_reset_tokens
     SET used_at = now(),
         requested_ip = COALESCE(p_ip, requested_ip),
         user_agent = COALESCE(p_user_agent, user_agent)
   WHERE token_hash = p_token_hash
     AND used_at IS NULL
     AND expires_at > now()
   RETURNING *;
$$;

-- A fresh request retires every outstanding link, so an older intercepted link
-- cannot be replayed after the holder asks again.
CREATE OR REPLACE FUNCTION public.auth_supersede_reset_tokens(p_user_id bigint)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.password_reset_tokens SET used_at = now()
   WHERE user_id = p_user_id AND used_at IS NULL;
$$;

-- Completing a reset ends every other session on the account: whoever forced
-- the reset must not be shadowed by a session the old password already opened.
CREATE OR REPLACE FUNCTION public.auth_revoke_all_sessions(p_user_id bigint)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.sessions SET revoked_at = now()
   WHERE user_id = p_user_id AND revoked_at IS NULL;
$$;

-- Record the Service Desk ticket raised alongside the request.
CREATE OR REPLACE FUNCTION public.auth_reset_attach_ticket(p_token_id bigint, p_ticket_id bigint)
RETURNS void
LANGUAGE sql SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  UPDATE public.password_reset_tokens SET ticket_id = p_ticket_id WHERE id = p_token_id;
$$;

-- AUTH-003: identity resolution was an exact match on email or username, so a
-- display name ("Nyirinkindi Annonciata"), a dotted handle and a bare username
-- were three different accounts and two of them did not exist. Match
-- case-insensitively and treat spaces, dots, underscores and hyphens as
-- equivalent separators. The API normalises the identifier the same way.
CREATE OR REPLACE FUNCTION public.auth_resolve_user_by_identifier(p_identifier text)
RETURNS SETOF public.users
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT * FROM public.users
   WHERE lower(email) = lower(btrim(p_identifier))
      OR lower(username) = lower(btrim(p_identifier))
      OR (
           regexp_replace(lower(btrim(COALESCE(username, ''))), '[\s._-]+', '', 'g') <> ''
           AND regexp_replace(lower(btrim(COALESCE(username, ''))), '[\s._-]+', '', 'g')
             = regexp_replace(lower(btrim(COALESCE(p_identifier, ''))), '[\s._-]+', '', 'g')
         )
   LIMIT 1;
$$;

-- Narrow execution to the least-privilege role only (the owner keeps implicit
-- EXECUTE; PUBLIC is stripped so arbitrary DB users cannot mint or consume
-- reset tokens, nor probe which identifiers exist).
REVOKE ALL ON FUNCTION public.auth_reset_create(bigint, bigint, text, timestamptz, bigint, bigint, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_reset_token_by_hash(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_reset_consume(text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_supersede_reset_tokens(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_revoke_all_sessions(bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_reset_attach_ticket(bigint, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_resolve_user_by_identifier(text) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.auth_reset_create(bigint, bigint, text, timestamptz, bigint, bigint, text, text) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.auth_reset_token_by_hash(text) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.auth_reset_consume(text, text, text) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.auth_supersede_reset_tokens(bigint) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.auth_revoke_all_sessions(bigint) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.auth_reset_attach_ticket(bigint, bigint) TO hopedesign_app;
GRANT EXECUTE ON FUNCTION public.auth_resolve_user_by_identifier(text) TO hopedesign_app;
