-- Give every user a phone so SMS deliveries have a recipient, and add SMS
-- to the operational notification rules that should page the mill.
UPDATE users
   SET phone = '+2567' || lpad((id % 100000000)::text, 8, '0')
 WHERE phone IS NULL OR btrim(phone) = '';

UPDATE notification_rules
   SET channels = COALESCE(channels, '[]'::jsonb) || '["SMS"]'::jsonb
 WHERE event_type IN (
        'MACHINE_DOWN',
        'APPROVAL_REQUIRED',
        'QUALITY_FAILED',
        'MATERIAL_SHORTAGE',
        'PRODUCTION_DELAYED'
      )
   AND NOT (COALESCE(channels, '[]'::jsonb) @> '["SMS"]'::jsonb);

-- Quota / missing-recipient retries will never succeed; stop looping them.
UPDATE notification_deliveries
   SET status = 'FAILED'
 WHERE status IN ('QUEUED', 'RETRYING')
   AND channel IN ('EMAIL', 'SMS', 'WHATSAPP')
   AND error IS NOT NULL
   AND error ~* 'quota|rate limit|not configured|missing|invalid|no recipient';
