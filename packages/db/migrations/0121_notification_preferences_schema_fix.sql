-- ============================================================================
-- 0121 - notification_preferences schema fix
-- ============================================================================

DO $$
DECLARE
  has_channel boolean;
  has_in_app  boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'notification_preferences' AND column_name = 'channel'
  ) INTO has_channel;

  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'notification_preferences' AND column_name = 'in_app'
  ) INTO has_in_app;

  IF has_channel AND NOT has_in_app THEN
    CREATE TEMP TABLE _np_conv ON COMMIT DROP AS
    SELECT tenant_id, user_id, event_type,
           bool_or(enabled) FILTER (WHERE channel = 'IN_APP') AS in_app,
           bool_or(enabled) FILTER (WHERE channel = 'EMAIL') AS email,
           bool_or(enabled) FILTER (WHERE channel = 'SMS')   AS sms
      FROM notification_preferences
     GROUP BY tenant_id, user_id, event_type;

    DELETE FROM notification_preferences;

    ALTER TABLE notification_preferences
      ADD COLUMN in_app BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN email BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN push BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN sms BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN whatsapp BOOLEAN NOT NULL DEFAULT false,
      ADD COLUMN digest TEXT NOT NULL DEFAULT 'INSTANT',
      ADD COLUMN critical_bypass BOOLEAN NOT NULL DEFAULT true;

    ALTER TABLE notification_preferences
      ADD CONSTRAINT notification_preferences_digest_check
      CHECK (digest IN ('INSTANT','15_MIN','HOURLY','DAILY','WEEKLY'));

    INSERT INTO notification_preferences (tenant_id, user_id, event_type, in_app, email, sms)
    SELECT tenant_id, user_id, event_type,
           COALESCE(in_app, true), COALESCE(email, true), COALESCE(sms, false)
      FROM _np_conv;

    ALTER TABLE notification_preferences
      ADD CONSTRAINT notification_preferences_tenant_user_event_key
      UNIQUE (tenant_id, user_id, event_type);

    ALTER TABLE notification_preferences DROP COLUMN channel, DROP COLUMN enabled;
  END IF;
END $$;