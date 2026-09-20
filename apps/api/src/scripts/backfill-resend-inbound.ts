/**
 * File the backlog of already-received Resend mail into the ERP inbox.
 *
 * Inbound mail is normally pushed to the API by the Resend webhook, so any
 * message that arrived while no webhook was registered is still sitting in the
 * Resend account and invisible to the ERP. This script lists those messages and
 * replays each one through the same pipeline the webhook uses, so a backfilled
 * message and a webhook-delivered message produce the same rows and dedupe
 * against each other.
 *
 * Operator-run, inside the API container:
 *
 *   docker compose exec api-a node dist/scripts/backfill-resend-inbound.js
 *
 * Pass --dry-run to list what is waiting without writing anything.
 *
 * A message addressed to an address no active mailbox owns is refused rather
 * than invented into an arbitrary tenant. Refusals are reported and do not by
 * themselves fail the run; anything else that goes wrong exits non-zero.
 */
import { pool } from '../db.js';
import { backfillReceivedEmail } from '../services/mail/inbound/ingest.js';
import { type ReceivedEmailSummary, listReceivedEmails } from '../services/mail/inbound/resend.js';

/** How many stored messages to pull per run; the provider API caps this at 100. */
const PAGE_SIZE = 100;

/**
 * Refusals that mean "this message is not ours to file" rather than "something
 * broke". The domain receives mail for addresses no mailbox owns, so those are
 * expected; every other reason is a real failure and fails the run.
 */
const EXPECTED_REFUSALS = new Set(['NO_MAILBOX']);

const DRY_RUN = process.argv.includes('--dry-run');

/** Pad to a fixed width, truncating with a trailing marker when too long. */
function clip(value: string, width: number): string {
  const text = value.length > width ? `${value.slice(0, width - 1)}~` : value;
  return text.padEnd(width, ' ');
}

/** Oldest first, so a run files the backlog in the order it arrived. */
function chronological(rows: ReceivedEmailSummary[]): ReceivedEmailSummary[] {
  return [...rows].sort((a, b) => {
    const left = a.created_at ?? '';
    const right = b.created_at ?? '';
    if (left !== right) return left < right ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
}

async function main(): Promise<number> {
  const listed = chronological(await listReceivedEmails(PAGE_SIZE));
  console.log(`[backfill] ${listed.length} stored message(s) at the provider`);
  if (DRY_RUN) console.log('[backfill] dry run - reporting only, nothing is written');

  const counts = { filed: 0, duplicate: 0, refused: 0, failed: 0 };

  for (const summary of listed) {
    const recipients = summary.to;
    const stamp = clip(summary.created_at ?? '-', 25);
    const from = clip(summary.from ?? '-', 32);
    const to = recipients[0] ?? '-';
    const subject = (summary.subject ?? '').replace(/\s+/g, ' ').trim();

    if (DRY_RUN) {
      console.log(`[backfill] ${clip('PENDING', 9)} ${clip(summary.id, 38)} ${stamp} ${from} -> ${to}  ${subject}`);
      continue;
    }

    // The stored summary is the envelope; the pipeline re-fetches the message
    // and prefers its own received_for, so these addresses are only a fallback.
    const result = await backfillReceivedEmail({ emailId: summary.id, recipients });

    if (!result.accepted) {
      const reason = result.reason ?? 'UNKNOWN';
      counts.refused += 1;
      const unexpected = !EXPECTED_REFUSALS.has(reason);
      if (unexpected) counts.failed += 1;
      console.log(`[backfill] ${clip('REFUSED', 9)} ${clip(summary.id, 38)} ${stamp} ${from} -> ${to}  reason=${reason}${unexpected ? ' (unexpected)' : ''}`);
      continue;
    }

    if (result.duplicate) {
      counts.duplicate += 1;
    } else {
      counts.filed += 1;
    }
    const status = result.duplicate ? 'DUPLICATE' : 'FILED';
    const trace = `row=${result.emailRowId ?? '-'} mailbox=${result.mailboxId ?? '-'}`;
    console.log(`[backfill] ${clip(status, 9)} ${clip(summary.id, 38)} ${stamp} ${from} -> ${to}  ${trace}  ${subject}`);
  }

  console.log('---- SUMMARY ----');
  console.log(`listed    ${listed.length}`);
  console.log(`filed     ${counts.filed}`);
  console.log(`duplicate ${counts.duplicate}`);
  console.log(`refused   ${counts.refused}`);
  console.log(`failed    ${counts.failed}`);

  return counts.failed === 0 ? 0 : 1;
}

main()
  .then(async (code) => {
    await pool.end();
    process.exit(code);
  })
  .catch(async (err: unknown) => {
    console.error('[backfill] aborted:', err instanceof Error ? err.message : String(err));
    await pool.end().catch(() => undefined);
    process.exit(1);
  });