/**
 * Hikvision webhook payload decoding.
 *
 * Real terminals configured with an HTTP listening host push
 * multipart/form-data whose single part (AccessControllerEvent) is a JSON
 * object with the meaningful fields nested inside it. These tests pin the
 * exact shape captured from the production terminal so a decoding regression
 * cannot silently drop attendance again.
 */
import { describe, it, expect } from 'vitest';
import { hoistEventFields, parseEventPayload, parseMultipartBody } from '../src/services/hikvision/parser.js';

const BOUNDARY = 'MIME_boundary';
const CONTENT_TYPE = `multipart/form-data; boundary=${BOUNDARY}`;
const TZ = 'Africa/Kampala';

/** Build a multipart body the way the DS-K1T323 does: tab-indented JSON. */
function multipartPayload(payload: Record<string, unknown>): Buffer {
  const json = JSON.stringify(payload, null, '\t');
  return Buffer.from(
    [
      `--${BOUNDARY}`,
      'Content-Disposition: form-data; name="AccessControllerEvent"',
      'Content-Type: application/json',
      `Content-Length: ${Buffer.byteLength(json)}`,
      '',
      json,
      `--${BOUNDARY}--`,
      '',
    ].join('\r\n'),
    'utf8'
  );
}

const HEARTBEAT = {
  ipAddress: '10.70.18.20',
  portNo: 80,
  protocol: 'HTTPS',
  macAddress: '88:de:39:7a:22:cf',
  channelID: 1,
  dateTime: '2026-09-19T22:05:16+08:30',
  activePostCount: 1,
  eventType: 'heartBeat',
  eventState: 'active',
  eventDescription: 'heartBeat',
};

const PUNCH = {
  ipAddress: '10.70.18.20',
  portNo: 80,
  protocol: 'HTTPS',
  macAddress: '88:de:39:7a:22:cf',
  channelID: 1,
  dateTime: '2026-09-19T08:02:11+08:30',
  activePostCount: 1,
  eventType: 'AccessControllerEvent',
  eventState: 'active',
  employeeNoString: '000015',
  majorEventType: 1,
  subEventType: 75,
  name: 'lulenzi Mutawakiru',
  verifyNo: 1,
};

describe('hikvision multipart decoding', () => {
  it('reads the event out of the AccessControllerEvent part', () => {
    const decoded = parseMultipartBody(multipartPayload(HEARTBEAT), CONTENT_TYPE);
    expect(decoded).not.toBeNull();
    expect(decoded!.raw.AccessControllerEvent).toBeTruthy();
    expect(decoded!.fields.eventType).toBe('heartBeat');
    expect(decoded!.fields.ipAddress).toBe('10.70.18.20');
  });

  it('hoists the nested AccessControllerEvent fields to the top level', () => {
    const fields = hoistEventFields({ AccessControllerEvent: { employeeNoString: '000015', dateTime: '2026-09-19T08:02:11+08:30' } });
    expect(fields.employeeNoString).toBe('000015');
    expect(fields.dateTime).toBe('2026-09-19T08:02:11+08:30');
  });

  it('normalizes a heartbeat without inventing an employee', () => {
    const decoded = parseMultipartBody(multipartPayload(HEARTBEAT), CONTENT_TYPE)!;
    const parsed = parseEventPayload(decoded.fields, CONTENT_TYPE, TZ);
    expect(parsed.format).toBe('MULTIPART');
    expect(parsed.employeeIdentifier).toBeNull();
    expect(parsed.eventTypeRaw).toBe('heartBeat');
    expect(parsed.eventTimeIso).toBe('2026-09-19T13:35:16.000Z');
  });

  it('normalizes a real punch to the terminal employee number', () => {
    const decoded = parseMultipartBody(multipartPayload(PUNCH), CONTENT_TYPE)!;
    const parsed = parseEventPayload(decoded.fields, CONTENT_TYPE, TZ);
    expect(parsed.format).toBe('MULTIPART');
    expect(parsed.employeeIdentifier).toBe('000015');
    expect(parsed.verifyRaw).toBe('1');
    expect(parsed.eventTimeIso).toBe('2026-09-18T23:32:11.000Z');
  });

  it('accepts a nested JSON body that was not wrapped in multipart', () => {
    const parsed = parseEventPayload({ AccessControllerEvent: { employeeNoString: '000015', dateTime: '2026-09-19T08:02:11+08:30' } }, 'application/json', TZ);
    expect(parsed.format).toBe('JSON');
    expect(parsed.employeeIdentifier).toBe('000015');
  });

  it('treats literal absent markers as no employee', () => {
    const parsed = parseEventPayload({ AccessControllerEvent: { employeeNoString: 'null', dateTime: '2026-09-19T08:02:11+08:30' } }, 'application/json', TZ);
    expect(parsed.employeeIdentifier).toBeNull();
  });

  it('returns null when the multipart boundary is missing', () => {
    expect(parseMultipartBody(multipartPayload(PUNCH), 'multipart/form-data')).toBeNull();
  });

  it('decodes when the advertised boundary case differs from the body', () => {
    // Production sends boundary=mime_boundary in Content-Type while delimiting
    // the body with MIME_boundary; a case-sensitive split finds no parts at all.
    const ct = 'multipart/form-data; boundary=mime_boundary';
    const decoded = parseMultipartBody(multipartPayload(PUNCH), ct);
    expect(decoded).not.toBeNull();
    expect(decoded!.fields.employeeNoString).toBe('000015');
    const parsed = parseEventPayload(decoded!.fields, ct, TZ);
    expect(parsed.employeeIdentifier).toBe('000015');
    expect(parsed.eventTimeIso).toBe('2026-09-18T23:32:11.000Z');
  });

  it('recovers the JSON part when a stray delimiter trails the payload', () => {
    const messy = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="AccessControllerEvent"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(HEARTBEAT)}\r\n--SomeOtherBoundary--\r\n`,
      'utf8'
    );
    const decoded = parseMultipartBody(messy, CONTENT_TYPE);
    expect(decoded).not.toBeNull();
    expect(decoded!.fields.eventType).toBe('heartBeat');
  });
  it('keeps a binary JPEG part out of the text decode so jsonb stays valid', () => {
    const json = JSON.stringify({ ...PUNCH, pictureURL: 'Picture1' });
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x00]);
    const body = Buffer.concat([
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="AccessControllerEvent"\r\nContent-Type: application/json\r\n\r\n${json}\r\n`, 'utf8'),
      Buffer.from(`--${BOUNDARY}\r\nContent-Disposition: form-data; name="picture"\r\nContent-Type: image/jpeg\r\n\r\n`, 'utf8'),
      jpeg,
      Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'utf8'),
    ]);
    const decoded = parseMultipartBody(body, CONTENT_TYPE);
    expect(decoded).not.toBeNull();
    expect(decoded!.fields.employeeNoString).toBe('000015');
    // Regression: decoding the JPEG as UTF-8 produced NUL bytes, and Postgres
    // rejected the whole INSERT with SQLSTATE 22P05 (unsupported Unicode escape).
    expect(JSON.stringify(decoded!.raw)).not.toContain('\\u0000');
    expect(JSON.stringify(decoded!.fields)).not.toContain('\\u0000');
    const picture = decoded!.raw.picture as { binary: boolean; contentType: string; bytes: number };
    expect(picture.binary).toBe(true);
    expect(picture.contentType).toBe('image/jpeg');
    expect(picture.bytes).toBe(jpeg.length);
  });

  it('never leaves a NUL byte in the payload, even from a text part', () => {
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="AccessControllerEvent"\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ ...PUNCH, name: 'bad\u0000name' })}\r\n--${BOUNDARY}--\r\n`,
      'utf8'
    );
    const decoded = parseMultipartBody(body, CONTENT_TYPE);
    expect(decoded).not.toBeNull();
    expect(JSON.stringify(decoded!.raw)).not.toContain('\\u0000');
    expect(JSON.stringify(decoded!.fields)).not.toContain('\\u0000');
    expect(decoded!.fields.name).toBe('badname');
  });

  it('reads the employee number out of a doubly nested AccessControllerEvent part', () => {
    // Exact shape captured from the production terminal (hikvision_raw_events
    // payload): the multipart part is itself named AccessControllerEvent and
    // contains an outer container that repeats the name for the inner,
    // event-specific object. The employee number lives in the INNER object,
    // one level deeper than a single-pass hoist reaches.
    const REAL = {
      portNo: 443,
      dateTime: '2026-09-19T18:02:38+03:00',
      protocol: 'HTTPS',
      channelID: 1,
      eventType: 'AccessControllerEvent',
      ipAddress: '10.70.18.20',
      eventState: 'active',
      macAddress: '88:de:39:7a:22:cf',
      activePostCount: 1,
      eventDescription: 'Access Controller Event',
      shortSerialNumber: 'GS7020902',
      AccessControllerEvent: {
        name: 'lulenzi Mutawakiru',
        label: '',
        serialNo: 217,
        userType: 'custom1',
        deviceName: 'Access Controller',
        cardReaderNo: 1,
        subEventType: 38,
        frontSerialNo: 216,
        majorEventType: 5,
        employeeNoString: '000015',
        currentVerifyMode: 'cardOrFaceOrFp',
      },
    };

    const decoded = parseMultipartBody(multipartPayload(REAL), CONTENT_TYPE)!;
    expect(decoded.fields.employeeNoString).toBe('000015');
    expect(decoded.fields.majorEventType).toBe(5);
    expect(decoded.fields.subEventType).toBe(38);

    const parsed = parseEventPayload(decoded.fields, CONTENT_TYPE, TZ);
    expect(parsed.format).toBe('MULTIPART');
    expect(parsed.employeeIdentifier).toBe('000015');
    expect(parsed.eventTimeIso).toBe('2026-09-19T15:02:38.000Z');
    // serialNo is the per-event sequence counter. If it were picked up as the
    // device serial, ingest's payload/source cross-check would reject the event.
    expect(parsed.serialRaw).toBeNull();
  });

  it('flattens containers nested more than one level in a plain JSON body', () => {
    const parsed = parseEventPayload(
      {
        EventNotificationAlert: {
          dateTime: '2026-09-19T18:02:38+03:00',
          AccessControllerEvent: { employeeNoString: '000015', majorEventType: 5 },
        },
      },
      'application/json',
      TZ
    );
    expect(parsed.employeeIdentifier).toBe('000015');
    expect(parsed.eventTimeIso).toBe('2026-09-19T15:02:38.000Z');
  });
});
