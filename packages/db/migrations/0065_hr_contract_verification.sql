-- 0065: HR contract document verification
-- SECURITY DEFINER so the public verification endpoint can verify an executed
-- employment contract without exposing PII or requiring authenticated DB access.
-- The verification record stores only a SHA-256 hash of the one-time secret.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION verify_contract_document(
  p_code text,
  p_secret text,
  p_ip text,
  p_user_agent text,
  p_device text,
  p_user_id bigint,
  p_correlation_id text
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rec document_verification%ROWTYPE;
  v_first timestamptz;
  v_count integer;
BEGIN
  SELECT * INTO v_rec
  FROM document_verification
  WHERE verification_code = p_code
  LIMIT 1;

  IF NOT FOUND OR v_rec.status <> 'ACTIVE'
     OR encode(digest(p_secret, 'sha256'), 'hex') <> v_rec.secret_hash THEN
    RETURN jsonb_build_object(
      'valid', false,
      'status', COALESCE(v_rec.status, 'NOT_FOUND'),
      'document_no', NULL,
      'document_type', NULL,
      'first_verified_at', NULL,
      'verify_count', 0
    );
  END IF;

  UPDATE document_verification
  SET verify_count = verify_count + 1,
      first_verified_at = COALESCE(first_verified_at, now()),
      updated_at = now()
  WHERE id = v_rec.id
  RETURNING first_verified_at, verify_count INTO v_first, v_count;

  RETURN jsonb_build_object(
    'valid', true,
    'status', v_rec.status,
    'document_no', v_rec.document_no,
    'document_type', v_rec.document_type,
    'first_verified_at', v_first,
    'verify_count', v_count
  );
END;
$$;
