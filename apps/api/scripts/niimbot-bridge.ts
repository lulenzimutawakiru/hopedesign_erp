/**
 * Niimbot label bridge daemon.
 *
 * Polls GET /api/qr/labels/spool for queued ream/carton labels, forwards each
 * rendered PNG (base64) to a Niimbot LAN/BLE bridge, then acknowledges the label
 * via /printed (success) or /failed (error). Run with tsx:
 *
 *   NIIMBOT_BRIDGE_URL=http://<printer-bridge>:8188 \
 *   API_BASE_URL=http://localhost:4000 \
 *   PRINTER_USERNAME=admin PRINTER_PASSWORD='ChangeMe!2026' \
 *   npm run niimbot:bridge -w apps/api
 *
 * The printer bridge must accept POST /print with a JSON body
 * { imageBase64, mac? } and return a 2xx status on success. Labels stay queued
 * until they are acknowledged, so a crash between printing and acknowledgement
 * may cause a one-off reprint (at-least-once delivery).
 */

import 'dotenv/config';

const API_BASE = String(process.env.API_BASE_URL ?? 'http://localhost:4000').replace(/\/+$/, '');
const BRIDGE_URL = String(process.env.NIIMBOT_BRIDGE_URL ?? '').replace(/\/+$/, '');
const PRINTER_MAC = process.env.NIIMBOT_MAC ?? '';
const USERNAME = process.env.PRINTER_USERNAME ?? 'admin';
const PASSWORD = process.env.PRINTER_PASSWORD ?? 'ChangeMe!2026';
const POLL_MS = Number(process.env.NIIMBOT_POLL_MS || 3000);

let accessToken: string | null = null;

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function login(): Promise<void> {
  const { status, body } = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: USERNAME, password: PASSWORD }),
  });
  if (status !== 200 || !body?.accessToken) {
    if (body?.mfaRequired) {
      throw new Error('Bridge account requires MFA - use a non-MFA account with qr.labels.print permission');
    }
    throw new Error(`login failed (${status}): ${JSON.stringify(body)}`);
  }
  accessToken = body.accessToken;
  console.log(`[niimbot-bridge] logged in as ${USERNAME}`);
}

async function sendToPrinter(imageDataUrl: string, labelNo: string): Promise<void> {
  const [head, b64] = String(imageDataUrl).split(',');
  if (!b64 || !head.startsWith('data:image/png')) {
    throw new Error('label image is not a PNG data URL');
  }
  const payload: Record<string, unknown> = { imageBase64: b64 };
  if (PRINTER_MAC) payload.mac = PRINTER_MAC;
  const res = await fetch(`${BRIDGE_URL}/print`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    throw new Error(`printer bridge returned ${res.status} for label ${labelNo}`);
  }
}

async function processQueue(): Promise<void> {
  const { status, body } = await api('/api/qr/labels/spool?limit=10');
  if (status === 401) {
    accessToken = null;
    await login();
    return;
  }
  if (status !== 200) {
    console.error(`[niimbot-bridge] spool poll failed (${status}):`, JSON.stringify(body));
    return;
  }
  const rows: any[] = Array.isArray(body?.data) ? body.data : [];
  for (const row of rows) {
    const labelId = Number(row.id);
    const labelNo = String(row.label_no ?? row.labelNo ?? labelId);
    try {
      if (!row.imageDataUrl) {
        throw new Error('label image is missing on disk');
      }
      await sendToPrinter(row.imageDataUrl, labelNo);
      await api(`/api/qr/labels/${labelId}/printed`, { method: 'POST' });
      console.log(`[niimbot-bridge] printed ${labelNo} (qr ${row.qr_code ?? row.qrCode})`);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.error(`[niimbot-bridge] print failed ${labelNo}: ${reason}`);
      try {
        await api(`/api/qr/labels/${labelId}/failed`, {
          method: 'POST',
          body: JSON.stringify({ reason }),
        });
      } catch (ackErr) {
        console.error(`[niimbot-bridge] could not acknowledge failure for ${labelNo}:`, ackErr);
      }
    }
  }
}

async function main(): Promise<void> {
  if (!BRIDGE_URL) {
    console.error('[niimbot-bridge] NIIMBOT_BRIDGE_URL is required (e.g. http://<printer-bridge>:8188)');
    process.exit(1);
  }
  console.log(`[niimbot-bridge] polling ${API_BASE}/api/qr/labels/spool -> ${BRIDGE_URL}/print every ${POLL_MS}ms`);
  await login();
  let stopped = false;
  const shutdown = () => {
    if (stopped) return;
    stopped = true;
    console.log('[niimbot-bridge] stopping');
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  // eslint-disable-next-line no-constant-condition
  while (!stopped) {
    try {
      await processQueue();
    } catch (err) {
      console.error('[niimbot-bridge] unexpected error:', err instanceof Error ? err.message : err);
    }
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

main().catch((err) => {
  console.error('[niimbot-bridge] fatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
