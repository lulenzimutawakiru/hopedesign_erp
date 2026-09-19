-- Hikvision terminals configured with an HTTP listening host push events as
-- multipart/form-data (one JSON part named AccessControllerEvent per push).
-- The original payload_format CHECK allowed only JSON/XML/FORM/UNKNOWN, so
-- every genuine webhook hit a constraint error at the storage layer and the
-- terminal saw a 400. Allow MULTIPART so the payload is preserved verbatim
-- with its true format.

ALTER TABLE hikvision_raw_events
  DROP CONSTRAINT IF EXISTS hikvision_raw_events_payload_format_check;
ALTER TABLE hikvision_raw_events
  ADD CONSTRAINT hikvision_raw_events_payload_format_check
  CHECK (payload_format IN ('JSON','XML','FORM','MULTIPART','UNKNOWN'));
