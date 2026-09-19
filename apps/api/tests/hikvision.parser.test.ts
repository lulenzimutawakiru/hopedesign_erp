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
});
