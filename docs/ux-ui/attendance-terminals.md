# Attendance Terminal Compatibility — HOPE DESIGN ERP

> Audience: IT / Project implementation team purchasing or deploying attendance
> hardware for HOPE DESIGN GROUP LTD. This document describes exactly what a
> terminal must be able to do to work with the ERP attendance pipeline **as it
> is already built**. It is not a wish list — it is a reverse-engineered
> contract taken from the live receiver, parser and processor.

---

## 1. Summary

The ERP receives attendance from **Hikvision ISAPI devices that can push an
event notification over HTTP(S) to a URL we configure.**

That is the single hard requirement. If a terminal cannot POST an event to an
arbitrary URL with custom headers, it cannot feed attendance — regardless of how
good the biometric engine is.

**Recommended purchase:** Hikvision face-recognition terminal, DS-K1T3xx /
DS-K1T6xx / DS-K1T2xx (MinMoe) class, **with HTTP event linkage enabled**, one
unit for ENTRY and one for EXIT per gate.

---

## 2. The integration contract

### 2.1 Endpoint

```
POST https://<erp-host>/api/integrations/hikvision/events
```

Mounted **above** the JWT middleware — devices are authenticated by their own
credentials, not by a user session.

### 2.2 Device authentication (required)

| Header | Value |
|---|---|
| `x-hikvision-serial` | The device serial number, exactly as registered in `hikvision_devices.serial_number` |
| `x-hikvision-key` | The device webhook key (stored **hashed** as `auth_key_hash`) |

Optional, recorded for diagnostics: `x-hikvision-model`, `x-hikvision-firmware`.

**Query-string credentials** (`?serial=…&key=…`) are accepted **only** when the
device row has `allow_query_key = true`. This defaults to `false` and should
**stay false** — the terminal must be able to send custom headers.

Authentication is performed in the database by
`hikvision_auth_device(serial, key, ip)`, which does a constant-time key compare
and optionally enforces `ip_allowlist`. A wrong key, an unregistered serial, or
an IP outside the allow-list returns an opaque `401`.

### 2.3 Accepted payload formats

The parser accepts, in detection order:

1. **JSON** object (global `express.json`) — preferred
2. **XML** with `Content-Type: application/xml` or `text/xml` (2 MB limit)
3. **Form** `application/x-www-form-urlencoded`
4. A raw body string starting with `<` (treated as XML) or `{` (treated as JSON)

Hikvision ISAPI `<EventNotificationAlert>` XML works out of the box. XML is
parsed by a strict, DOCTYPE-rejecting, entity-free leaf extractor, so it is XXE
safe by construction — but it also means **a payload with a `<!DOCTYPE>`
declaration is rejected with 400**.

### 2.4 Response and retry semantics

```json
HTTP 202 { "received": true, "eventId": 1234, "status": "RECEIVED" }
```

- **202 = accepted.** The terminal can move on.
- Duplicates are detected and returned as `status: "DUPLICATE"` with
  `duplicateOf`. **Retrying is therefore safe** and should be enabled on the
  terminal for any non-2xx response.
- Rate limit: **300 requests/minute per `ip:serial`**.
- Errors are deliberately opaque: `401 Unauthorized` / `400 Invalid event
  payload` / `500 Service unavailable`. Parser internals and stack traces never
  reach the device.

### 2.5 Field aliases the terminal payload must hit

The parser looks for these exact key names (first non-empty wins):

| Meaning | Accepted keys |
|---|---|
| Person number | `employeeNoString`, `employeeNo`, `employeeNumber`, `empNo`, `cardNo`, `EmployeeNoString`, `EmployeeNo`, `CardNo`, `personId`, `employeeID` |
| Event time | `time`, `eventTime`, `recordTime`, `Time`, `EventTime` |
| Event type / outcome | `eventType`, `event`, `attendanceStatus`, `accessStatus`, `EventType`, `AttendanceStatus`, `AccessStatus` |
| Verification mode | `verifyNo`, `verifyMode`, `verificationMethod`, `verifyMethod`, `verifyType`, `VerifyNo`, `VerifyMode` |
| Device serial | `serialNo`, `serialNumber`, `deviceSerial`, `SerialNo`, `SerialNumber` |
| Device name | `deviceName`, `DeviceName`, `name` |

Standard Hikvision ISAPI JSON already emits `employeeNoString`, `time`,
`eventType`, `serialNo` — **no custom firmware or payload shaping is needed.**
`personId` is included specifically to cover MinMoe-style devices.

> A payload with no recognisable content (empty object, empty form, whitespace
> XML) is rejected with 400 rather than silently stored.

---

## 3. Required terminal capabilities (the checklist)

Ask the supplier to confirm **all** of these on the exact model + firmware:

| # | Capability | Why |
|---|---|---|
| 1 | **ISAPI event linkage → HTTP notification** ("Notify Event", "HTTP Data Transfer", "Event Linkage → HTTP", "HTTP Listening") | No push, no attendance |
| 2 | **Configurable destination URL** | Point it at the ERP endpoint |
| 3 | **Arbitrary custom request headers** (or at minimum a configurable "custom header" field) | Carries `x-hikvision-serial` / `x-hikvision-key` |
| 4 | **JSON or XML body** | Parser accepts both |
| 5 | **Person number emitted as `employeeNoString` / `employeeNo` / `personId` / `cardNo`** | This is how the punch is matched to an employee |
| 6 | **Configurable device timezone** | Naive local timestamps are interpreted in `hikvision_devices.timezone` (default `Africa/Kampala`) |
| 7 | **NTP client** | Clock drift is monitored; a drifting clock corrupts attendance |
| 8 | **Periodic event/heartbeat push** | Keeps `last_heartbeat_at` fresh; there is **no separate heartbeat endpoint** — any event refreshes the heartbeat |
| 9 | **Retry on non-2xx** | 202 means accepted; retries are deduplicated |

**If the device cannot set custom headers:** it can only be onboarded with
`allow_query_key = true`, which puts the shared key in the URL and into any
proxy/access log. That is a downgrade — accept it only as a documented
exception, with a rotated key and a tight `ip_allowlist`.

---

## 4. Models that work, models to avoid

### Recommended

| Class | Examples | Why |
|---|---|---|
| **Face recognition terminal** | DS-K1T3xx, DS-K1T6xx, DS-K1T2xx (MinMoe) | ISAPI event linkage is standard; emits `employeeNoString`, `time`, `eventType`; touchscreen + face is the fastest punch |
| **Fingerprint / card reader with ISAPI HTTP notification** | DS-K1T series reader variants | Same protocol, cheaper where face is unnecessary |
| **Access controller** | DS-K260x class | Best where doors/gates already have controllers — the controller pushes events, readers stay dumb |

### Avoid, or verify per SKU

- **Consumer / push-to-cloud-only devices** that talk only to **Hik-Connect /
  ISUP** with no local HTTP notification. These are **not compatible** and would
  require us to build a whole new receiver path. Cheap consumer units and
  "cloud-only" SKUs fall here.
- Devices locked to a closed cloud without an ISAPI HTTP linkage page.
- Anything where the vendor cannot show you the **Event → HTTP** configuration
  page in the device web UI.

**Verification before purchase (5 minutes, on the demo unit):**
open the device web UI → `Configuration → Network → Event / Notification →
HTTP Listening` (wording varies) and confirm you can set a URL **and** custom
headers, and choose the payload format. If that page does not exist, stop.

---

## 5. Topology — this matters more than the hardware

How devices are placed determines attendance accuracy far more than the model
chosen.

### Strongly recommended: split ENTRY / EXIT

```
Gate In  → device_purpose = ENTRY   → every punch = CHECK_IN
Gate Out → device_purpose = EXIT    → every punch = CHECK_OUT
```

Deterministic. A missed punch is a visible gap, not a corrupted day.

### Acceptable but fragile: single ATTENDANCE terminal

```
Main door → device_purpose = ATTENDANCE → even punch = CHECK_IN, odd = CHECK_OUT
```

This uses **alternation**: the punch number for the day decides the type. If
someone misses a punch, **every subsequent punch that day is inverted**. Use
only where a second reader is genuinely impossible, and expect the exception
queue to carry the load.

### Additional purposes (no attendance impact)

| Purpose | Behaviour |
|---|---|
| `BREAK_ENTRY` | Punch classified `BREAK_START` |
| `BREAK_EXIT` | Punch classified `BREAK_END` |
| `PRODUCTION` / `WAREHOUSE` / `SECURE_AREA` | Logged as `ACCESS_GRANTED` — **never an attendance punch** |

Put break devices at the canteen / rest area, and production/warehouse/secure
devices at the operational doors. Those give you access history and security
traceability without polluting attendance.

### Classification fallback

If `device_purpose` does not settle it, the payload text is scanned:
`out|exit|leave|off-duty` → CHECK_OUT, `in|entry|arrive|on-duty|check` →
CHECK_IN, `grant|pass|allow|success` → ACCESS_GRANTED, and anything containing
`denied|reject|fail` (without `grant`) → ACCESS_DENIED.

---

## 6. Employee mapping

Every punch carries an identifier that must resolve to an employee.

- Simplest: the number enrolled on the terminal **equals `employees.employee_no`**.
- Otherwise create a `hikvision_employee_links` row:
  `employee_id`, `employee_identifier`, optional `device_id`, `verification_method`, `status`.

The unique key is `(company_id, employee_identifier, COALESCE(device_id, 0))`, so
an identifier can be **company-wide** (one row, `device_id` NULL) or
**per-device** (one row per terminal). Per-device is useful when two vendors'
terminals independently assign numbers.

⚠️ **Unmapped punches do not silently disappear** — they land in the exception
queue for a human to resolve. Keep `hikvision_employee_links` current when staff
join, leave or are re-enrolled.

---

## 7. Deployment hardening checklist

- [ ] Use **HTTPS** with a valid certificate on the ERP host.
- [ ] Set `ip_allowlist` on every device row to the terminal's static IP (or the
      site egress range). Terminals should be on static IPs or DHCP reservations.
- [ ] Leave `allow_query_key = false`. Use headers.
- [ ] Issue a **unique, rotatable** webhook key per device. Keys are stored as
      `auth_key_hash` + `auth_key_prefix` — plaintext is never persisted and must
      never be printed in a UI or a log.
- [ ] Set the correct `timezone` per device (`Africa/Kampala` unless a site
      genuinely differs).
- [ ] Enable **NTP** on the terminal; monitor `hikvision_clock_drift_logs` and
      `last_clock_drift_seconds` against `clock_drift_warning_seconds`.
- [ ] Configure the terminal to **retry on non-2xx** (retries are deduplicated).
- [ ] Confirm the device appears in `hikvision_device_heartbeats` with a fresh
      `last_heartbeat_at`.
- [ ] Keep `connection_status` in sync — `MAINTENANCE` / `DISABLED` devices do not
      flip to ONLINE on event.

---

## 8. Onboarding runbook

1. **Register the device** — `hikvision_devices`: `code`, `name`, `model`,
   `serial_number` (unique per company), `ip_address`, `facility`,
   `physical_location`.
2. **Set purpose + timezone + key + allow-list** — `device_purpose`,
   `timezone`, generate the webhook key, `ip_allowlist`.
3. **Enroll persons** on the terminal with numbers that match
   `employees.employee_no` (or note the numbers for step 4).
4. **Create `hikvision_employee_links`** for any identifier that does not equal
   `employee_no`.
5. **Point the terminal** at
   `https://<erp-host>/api/integrations/hikvision/events` with the
   `x-hikvision-serial` and `x-hikvision-key` headers.
6. **Verify** — trigger a test punch, then check, in order:
   `hikvision_raw_events` → `hikvision_normalized_events` →
   `attendance_punch_events` → `attendance_records`.
7. **Confirm the heartbeat** — `hikvision_device_heartbeats` and `last_event_at`.

---

## 9. Processor guardrails you should know about

These are deliberate protections; they explain most "my punch didn't appear"
support calls.

- **Payroll-locked period:** if the `attendance_periods` row is **LOCKED**, the
  punch is **still stored** but the attendance record is left untouched, and an
  exception plus a notification is raised. This protects a finalised payroll run.
- **Approved record:** if the `attendance_records` row is already **approved**, a
  new punch is ignored and an exception is raised — the intended remedy is an
  **adjustment** (`attendance_adjustments`), not a re-punch.
- **Idempotency:** `attendance_punch_events.raw_event_id` is unique, so a
  duplicate delivery can never double-count a punch.
- **Time sanity:** events outside `allow_past_minutes` / `allow_future_minutes`
  are rejected or flagged, and `timestamp_skew_seconds` records drift.
- **Capture first:** every accepted payload is written to `hikvision_raw_events`
  **before** any interpretation, so raw evidence is never lost.

---

## 10. Bottom line

Buy **Hikvision ISAPI terminals that support HTTP event notification with custom
headers**. Confirm the HTTP-listening page exists on the actual firmware before
paying. Deploy **separate ENTRY and EXIT readers per gate**; add break readers at
the canteen and PRODUCTION/WAREHOUSE/SECURE_AREA readers at operational doors.
Enrol person numbers that match `employees.employee_no`, keep
`hikvision_employee_links` current, and put every device on a static IP inside
its `ip_allowlist` with a unique rotatable webhook key over HTTPS.

Do that and the attendance pipeline needs no changes — it already expects exactly
this.
