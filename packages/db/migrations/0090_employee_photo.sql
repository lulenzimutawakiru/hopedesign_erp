-- Passport / staff photograph used on employment contracts and the employee file.
ALTER TABLE employees
  ADD COLUMN IF NOT EXISTS photo_path TEXT,
  ADD COLUMN IF NOT EXISTS photo_mime TEXT,
  ADD COLUMN IF NOT EXISTS photo_kind TEXT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'employees_photo_kind_check'
  ) THEN
    ALTER TABLE employees
      ADD CONSTRAINT employees_photo_kind_check
      CHECK (photo_kind IS NULL OR photo_kind IN ('PHOTO', 'PASSPORT'));
  END IF;
END $$;
