-- Emails: store per-email template variables so {{VAR}} placeholders can be
-- rendered server-side at send time instead of sending literal tokens.
-- Supports both UI-composed emails (templateVars from the composer) and any
-- future programmatic generation (template_code + entity link).

ALTER TABLE public.emails ADD COLUMN IF NOT EXISTS template_vars jsonb;
