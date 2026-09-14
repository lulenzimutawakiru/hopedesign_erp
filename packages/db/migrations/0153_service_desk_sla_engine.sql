-- ============================================================
-- HOPE DESIGN ERP - Service Desk & ITSM
-- 0153: SLA engine helpers
--
-- Spec 7 requires the SLA engine to understand business hours, weekends,
-- public holidays and pause conditions. The 0150 baseline stores the
-- calendar data (service_business_calendars / service_holidays) but the
-- due-date arithmetic has to live in the database so that every caller -
-- API, worker, report - agrees on the same deadline.
--
-- sla_policies.time_basis controls how policy minutes are interpreted:
--   CALENDAR - minutes of wall clock (P1 15m response, P2 8h resolution...)
--   BUSINESS - minutes counted only inside the business calendar's working
--              windows, skipping weekends and holidays
-- The seeded standard policies use CALENDAR so the published tables in the
-- specification read exactly as authored; a policy that opts into BUSINESS
-- gets true business-hours deadlines.
-- ============================================================

ALTER TABLE sla_policies
  ADD COLUMN IF NOT EXISTS time_basis TEXT NOT NULL DEFAULT 'CALENDAR';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'sla_policies_time_basis_check'
  ) THEN
    ALTER TABLE sla_policies
      ADD CONSTRAINT sla_policies_time_basis_check
      CHECK (time_basis = ANY (ARRAY['CALENDAR'::text, 'BUSINESS'::text]));
  END IF;
END $$;

-- ---------- Business-hours arithmetic ----------
-- Advance p_start by p_minutes of *working* time. The walk is day by day so
-- weekends, holidays and outside-hours time are skipped without a lookup
-- table; a guard bounds the loop in case a caller passes an empty working
-- week so a bad configuration degrades to wall-clock instead of hanging.
CREATE OR REPLACE FUNCTION service_add_business_minutes(
  p_start        timestamptz,
  p_minutes      integer,
  p_working_days integer[],
  p_work_start   time,
  p_work_end     time,
  p_tz           text,
  p_holidays     date[]
) RETURNS timestamptz AS $$
DECLARE
  v_remaining integer   := GREATEST(COALESCE(p_minutes, 0), 0);
  v_days      integer[] := COALESCE(p_working_days, ARRAY[1,2,3,4,5,6,7]);
  v_start     time      := COALESCE(p_work_start, time '00:00');
  v_end       time      := COALESCE(p_work_end,   time '23:59:59');
  v_tz        text      := COALESCE(p_tz, 'UTC');
  v_holidays  date[]    := COALESCE(p_holidays, ARRAY[]::date[]);
  v_cur       timestamp;
  v_date      date;
  v_avail     numeric;
  v_guard     integer   := 0;
BEGIN
  IF p_start IS NULL THEN RETURN NULL; END IF;
  IF v_remaining <= 0 THEN RETURN p_start; END IF;

  v_cur := p_start AT TIME ZONE v_tz;

  WHILE v_remaining > 0 AND v_guard < 4000 LOOP
    v_guard := v_guard + 1;
    v_date  := v_cur::date;

    -- Non-working day (weekend or public holiday): skip the whole day.
    IF NOT (EXTRACT(ISODOW FROM v_date)::integer = ANY(v_days))
       OR v_date = ANY(v_holidays) THEN
      v_cur := v_date + 1 + v_start;
      CONTINUE;
    END IF;

    -- Before opening: snap to the start of the working window.
    IF v_cur::time < v_start THEN
      v_cur := v_date + v_start;
    END IF;

    -- At or after closing: the window is used up, move to the next day.
    IF v_cur::time >= v_end THEN
      v_cur := v_date + 1 + v_start;
      CONTINUE;
    END IF;

    v_avail := EXTRACT(EPOCH FROM (v_end - v_cur::time)) / 60.0;

    IF v_remaining <= v_avail THEN
      RETURN (v_cur + make_interval(mins => v_remaining)) AT TIME ZONE v_tz;
    END IF;

    v_remaining := v_remaining - FLOOR(v_avail)::integer;
    v_cur := v_date + 1 + v_start;
  END LOOP;

  -- Guard tripped: never leave the caller without a deadline.
  RETURN p_start + make_interval(mins => p_minutes);
END;
$$ LANGUAGE plpgsql STABLE;

-- Working minutes consumed between two instants. Used for SLA reporting
-- (time actually burned against the policy) and to prove that a deadline
-- computed above is consistent with the elapsed counter.
CREATE OR REPLACE FUNCTION service_business_minutes_between(
  p_from         timestamptz,
  p_to           timestamptz,
  p_working_days integer[],
  p_work_start   time,
  p_work_end     time,
  p_tz           text,
  p_holidays     date[]
) RETURNS integer AS $$
DECLARE
  v_total     numeric := 0;
  v_days      integer[] := COALESCE(p_working_days, ARRAY[1,2,3,4,5,6,7]);
  v_start     time      := COALESCE(p_work_start, time '00:00');
  v_close     time      := COALESCE(p_work_end,   time '23:59:59');
  v_tz        text      := COALESCE(p_tz, 'UTC');
  v_holidays  date[]    := COALESCE(p_holidays, ARRAY[]::date[]);
  v_cur       timestamp;
  v_end_ts    timestamp;
  v_date      date;
  v_day_from  time;
  v_day_to    time;
  v_guard     integer   := 0;
BEGIN
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN RETURN 0; END IF;

  v_cur    := p_from AT TIME ZONE v_tz;
  v_end_ts := p_to   AT TIME ZONE v_tz;

  WHILE v_cur < v_end_ts AND v_guard < 4000 LOOP
    v_guard := v_guard + 1;
    v_date  := v_cur::date;

    IF (EXTRACT(ISODOW FROM v_date)::integer = ANY(v_days))
       AND NOT (v_date = ANY(v_holidays)) THEN
      v_day_from := GREATEST(v_cur::time, v_start);
      v_day_to   := LEAST(v_end_ts::time, v_close);
      IF v_end_ts::date > v_date THEN
        v_day_to := v_close;
      END IF;
      IF v_day_to > v_day_from THEN
        v_total := v_total + EXTRACT(EPOCH FROM (v_day_to - v_day_from)) / 60.0;
      END IF;
    END IF;

    v_cur := v_date + 1 + v_start;
  END LOOP;

  RETURN FLOOR(v_total)::integer;
END;
$$ LANGUAGE plpgsql STABLE;

-- ---------- Convenience wrapper ----------
-- Single entry point the API calls: resolves the calendar, honours
-- time_basis and 24x7, and returns the deadline.
CREATE OR REPLACE FUNCTION service_sla_due(
  p_basis       text,
  p_from        timestamptz,
  p_minutes     integer,
  p_calendar_id bigint
) RETURNS timestamptz AS $$
DECLARE
  c record;
BEGIN
  IF p_from IS NULL OR p_minutes IS NULL THEN RETURN NULL; END IF;

  IF upper(COALESCE(p_basis, 'CALENDAR')) = 'BUSINESS' AND p_calendar_id IS NOT NULL THEN
    SELECT * INTO c FROM service_business_calendars WHERE id = p_calendar_id;
    IF FOUND AND c.is_24x7 IS NOT TRUE THEN
      RETURN service_add_business_minutes(
        p_from,
        p_minutes,
        c.working_days,
        c.work_start,
        c.work_end,
        COALESCE(c.timezone, 'Africa/Kampala'),
        ARRAY(SELECT h.holiday_date FROM service_holidays h
               WHERE h.calendar_id = c.id AND h.is_active)
      );
    END IF;
  END IF;

  RETURN p_from + make_interval(mins => p_minutes);
END;
$$ LANGUAGE plpgsql STABLE;
