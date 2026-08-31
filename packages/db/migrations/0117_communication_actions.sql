-- ============================================================================
-- 0117 - Communication actions: archive + snooze + summary
-- Adds archive/snooze state to notifications for the Communication Center.
-- Idempotent: safe on fresh + existing DB.
-- ============================================================================

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS snoozed_until TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_notifications_archive ON notifications(user_id, archived_at);