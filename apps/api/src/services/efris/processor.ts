/**
 * EFRIS background fiscalization worker (spec 79-92, 102-103).
 *
 * Claims due fiscal transactions through the SECURITY DEFINER bridge
 * (efris_claim_fiscal_batch) so it can run without an end-user session, then
 * processes each claimed transaction in its own transaction with app context
 * applied manually. FISCALIZED is ONLY ever written after the URA gateway
 * returns a confirmed FDN + verification code; anything short of that is
 * recorded in efris_integration_errors and retried with backoff (or marked
 * FAILED once the configured attempt budget is exhausted).
 */
import pg from 'pg';
import { pool } from '../../db.js';
import { logAudit } from '../audit.js';
import { emitEvent } from '../events.js';
import { notifyRoleAdvanced } from '../communication.js';
import { resolveCredentials, notificationRoleCodes, type EfrisConfigurationRow } from './config.js';
import { buildSubmitPayload, type EfrisTaxpayerLite } from './builders.js';
import { submitFiscalDocument, extractFiscalIdentifiers, EfrisClientError } from './client.js';

/** Row returned by efris_claim_fiscal_batch(). */
export interface ClaimedFiscalTransaction {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
  taxpayer_id: number | null;
  config_id: number;
  config_code: string;
  fiscal_mode: 'TEST' | 'ACTIVE';
  base_url: string | null;
  token_url: string | null;
  auth_grant_type: string;
  client_id_ref: string | null;
  credentials_ref: string | null;
  timeout_seconds: number;
  max_attempts: number;
  retry_backoff_seconds: number;
  duplicate_window_seconds: number;
  doc_type: string;
  doc_ref_type: string;
  doc_ref_id: number;
  doc_ref_code: string;
  txn_date: string;
  currency: string;
  gross_amount: number;
  tax_amount: number;
  attempts: number;
  request_ref: string | null;
  request_payload: Record<string, unknown> | null;
}

interface WorkerRowMeta {
  id: number;
  tenant_id: number;
  company_id: number;
  branch_id: number | null;
}

const errMsg = (err: unknown): string => (err instanceof Error ? err.message : String(err));

async function applyWorkerContext(client: pg.PoolClient, row: WorkerRowMeta): Promise<void> {
  await client.query('SELECT set_app_context($1,$2,$3,$4)', [
    row.tenant_id,
    row.company_id,
    row.branch_id ?? null,
    null,
  ]);
  await client.query('SELECT set_config($1,$2,true)', ['app.correlation_id', `efris-${row.id}`]);
  await client.query('SELECT set_config($1,$2,true)', ['app.ip', '']);
  await client.query('SELECT set_config($1,$2,true)', ['app.user_agent', 'efris-worker']);
  await client.query('SELECT set_config($1,$2,true)', ['app.device', 'efris-worker']);
}

function errCode(err: unknown): string {
  if (err instanceof EfrisClientError) return err.code;
  if (err instanceof Error && (err as Error & { code?: string }).code) {
    return String((err as Error & { code?: string }).code);
  }
  return 'EFRIS_PROCESSING_ERROR';
}

function errPayload(err: unknown): unknown {
  return err instanceof EfrisClientError ? err.payload ?? null : null;
}

/** Persist a failure outside the rolled-back processing transaction. */
async function recordFailure(row: ClaimedFiscalTransaction, err: unknown): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyWorkerContext(client, row);
    const message = errMsg(err).slice(0, 2000);
    const code = errCode(err);
    const payload = errPayload(err);
    const configRes = await client.query(
      `SELECT * FROM efris_configurations WHERE id = $1 AND tenant_id = $2`,
      [row.config_id, row.tenant_id]
    );
    const config = configRes.rows[0] as EfrisConfigurationRow | undefined;
    const maxAttempts = config ? Number(config.max_attempts) : Number(row.max_attempts);
    const backoff = config ? Number(config.retry_backoff_seconds) : Number(row.retry_backoff_seconds);
    const nonRetryable = err instanceof EfrisClientError ? !err.retryable : false;
    const stageConfig = err instanceof EfrisClientError && err.stage === 'config';
    const attempts = Number(row.attempts);
    const terminal = stageConfig || nonRetryable || attempts >= maxAttempts;
    const targetStatus = terminal ? 'FAILED' : 'RETRYING';
    const backoffSeconds = Math.min(Math.max(backoff, 5) * Math.max(attempts, 1), 3600);

    await client.query(
      `INSERT INTO efris_integration_errors
         (tenant_id, company_id, efris_transaction_id, taxpayer_id, config_id, stage,
          error_code, error_message, request_payload, response_payload, retry_count)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11)`,
      [
        row.tenant_id,
        row.company_id,
        row.id,
        row.taxpayer_id,
        row.config_id,
        err instanceof EfrisClientError ? err.stage : 'submit',
        code,
        message,
        JSON.stringify(row.request_payload ?? {}),
        JSON.stringify(payload ?? {}),
        attempts,
      ]
    );
    await client.query(
      `UPDATE efris_transactions
          SET status = $2, claimed_at = NULL, last_error = $3, error_code = $4,
              next_attempt_at = $5, updated_at = now()
        WHERE id = $1`,
      [row.id, targetStatus, message, code, terminal ? null : new Date(Date.now() + backoffSeconds * 1000)]
    );
    await client.query(
      `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, request_payload, response_payload, error)
       VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6)`,
      [
        row.tenant_id,
        row.id,
        targetStatus,
        JSON.stringify(row.request_payload ?? {}),
        JSON.stringify(payload ?? {}),
        message,
      ]
    );
    await logAudit(client, { tenantId: row.tenant_id, companyId: row.company_id, branchId: row.branch_id }, {
      action: terminal ? 'efris.fiscalization.failed' : 'efris.fiscalization.retrying',
      resource: 'efris_transactions',
      recordId: row.id,
      recordCode: row.doc_ref_code,
      metadata: { errorCode: code, error: message.slice(0, 500), attempts, terminal },
    });

    if (terminal && config && config.notify_on_failure) {
      try {
        await notifyRoleAdvanced(
          client,
          { tenantId: row.tenant_id, companyId: row.company_id },
          notificationRoleCodes(config).length ? notificationRoleCodes(config) : ['cfo', 'finance_manager', 'chief_accountant', 'tax_officer'],
          {
            type: 'efris.fiscalization_failed',
            title: 'EFRIS fiscalization failed',
            body: `${row.doc_ref_code} (${row.doc_type}) could not be fiscalized after ${attempts} attempt(s): ${code}`,
            link: '/finance/efris',
            entityType: 'EFRIS_TRANSACTION',
            entityId: row.id,
            severity: 'ERROR',
            priority: 'HIGH',
            data: { transactionId: row.id, docRefCode: row.doc_ref_code, errorCode: code },
          }
        );
      } catch (notifyErr) {
        console.error('[efris][worker] failure notification error', errMsg(notifyErr));
      }
    }
    await client.query('COMMIT');
  } catch (inner) {
    await client.query('ROLLBACK');
    console.error('[efris][worker] failure-logging error', errMsg(inner));
  } finally {
    client.release();
  }
}

/** Run one claimed transaction through submission inside its own transaction. */
async function processFiscalRow(row: ClaimedFiscalTransaction): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await applyWorkerContext(client, row);

    const configRes = await client.query(
      `SELECT * FROM efris_configurations WHERE id = $1 AND tenant_id = $2 AND is_active = true`,
      [row.config_id, row.tenant_id]
    );
    const config = configRes.rows[0] as EfrisConfigurationRow | undefined;
    if (!config) {
      throw new EfrisClientError({
        code: 'EFRIS_CONFIG_INACTIVE',
        stage: 'config',
        message: 'EFRIS configuration is no longer active for this taxpayer',
        retryable: false,
      });
    }
    const creds = resolveCredentials(config);

    let taxpayer: EfrisTaxpayerLite | null = null;
    if (row.taxpayer_id != null) {
      const tp = await client.query(
        `SELECT id, legal_name, trading_name, tin, vat_registered, vat_number, taxpayer_type,
                business_sector, place_of_business, branch_id
           FROM efris_taxpayers WHERE id = $1 AND tenant_id = $2`,
        [row.taxpayer_id, row.tenant_id]
      );
      taxpayer = tp.rows[0] ?? null;
    }

    const built =
      row.request_payload && Object.keys(row.request_payload).length > 0
        ? { payload: row.request_payload }
        : buildSubmitPayload({
            docType: row.doc_type,
            docRefType: row.doc_ref_type,
            docRefCode: row.doc_ref_code,
            docRefId: row.doc_ref_id,
            txnDate: String(row.txn_date).slice(0, 10),
            currency: row.currency,
            grossAmount: Number(row.gross_amount),
            taxAmount: Number(row.tax_amount),
            requestRef: row.request_ref,
            taxpayer,
            config,
          });

    const raw = await submitFiscalDocument({
      mode: config.mode,
      baseUrl: config.base_url ?? '',
      tokenUrl: config.token_url,
      grantType: config.auth_grant_type || 'client_credentials',
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      timeoutSeconds: Number(config.timeout_seconds || 20),
      payload: built.payload,
    });

    const identifiers = extractFiscalIdentifiers(raw);
    if (!identifiers) {
      throw new EfrisClientError({
        code: 'EFRIS_RESPONSE_INVALID',
        stage: 'response',
        message: 'URA response did not include a confirmed FDN + verification code',
        payload: raw,
        retryable: false,
      });
    }
    const responsePayload = raw as Record<string, unknown>;

    await client.query(
      `INSERT INTO efris_documents
         (tenant_id, efris_transaction_id, erp_doc_no, fdn, verification_code, qr_ref,
          response_payload, transmitted_at, fiscalized_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,now(),now())
       ON CONFLICT (efris_transaction_id) DO UPDATE
         SET fdn = EXCLUDED.fdn, verification_code = EXCLUDED.verification_code,
             qr_ref = EXCLUDED.qr_ref, response_payload = EXCLUDED.response_payload,
             transmitted_at = now(), fiscalized_at = now()`,
      [
        row.tenant_id,
        row.id,
        row.doc_ref_code,
        identifiers.fdn,
        identifiers.vrc,
        identifiers.qrRef ?? null,
        JSON.stringify(responsePayload ?? {}),
      ]
    );
    await client.query(
      `UPDATE efris_transactions
          SET status = 'FISCALIZED', claimed_at = NULL, next_attempt_at = NULL,
              transmitted_at = now(), fiscalized_at = now(), last_error = NULL,
              error_code = NULL, request_payload = $2::jsonb, last_response = $3::jsonb,
              updated_at = now()
        WHERE id = $1`,
      [row.id, JSON.stringify(built.payload ?? {}), JSON.stringify(responsePayload ?? {})]
    );
    await client.query(
      `INSERT INTO efris_sync_logs (tenant_id, efris_transaction_id, status, request_payload, response_payload)
       VALUES ($1,$2,'FISCALIZED',$3::jsonb,$4::jsonb)`,
      [
        row.tenant_id,
        row.id,
        JSON.stringify(built.payload ?? {}),
        JSON.stringify(responsePayload ?? {}),
      ]
    );
    await logAudit(client, { tenantId: row.tenant_id, companyId: row.company_id, branchId: row.branch_id }, {
      action: 'efris.fiscalization.fiscalized',
      resource: 'efris_transactions',
      recordId: row.id,
      recordCode: row.doc_ref_code,
      metadata: { fdn: identifiers.fdn, verificationCode: identifiers.vrc, qrRef: identifiers.qrRef ?? null },
    });
    await emitEvent(client, { tenantId: row.tenant_id, companyId: row.company_id, branchId: row.branch_id }, {
      eventType: 'efris.fiscalized',
      entityType: 'EFRIS_TRANSACTION',
      entityId: row.id,
      entityCode: row.doc_ref_code,
      payload: { status: 'FISCALIZED', fdn: identifiers.fdn, vrc: identifiers.vrc },
    });

    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    await recordFailure(row, err);
    return false;
  } finally {
    client.release();
  }
}

let draining = false;

/** Claim and process a batch of due fiscal transactions. Single-flight safe. */
export async function drainEfrisQueue(batch = 10): Promise<{ claimed: number; processed: number; failed: number }> {
  if (draining) return { claimed: 0, processed: 0, failed: 0 };
  draining = true;
  try {
    const res = await pool.query('SELECT * FROM efris_claim_fiscal_batch($1, 300)', [batch]);
    const rows = res.rows as unknown as ClaimedFiscalTransaction[];
    let processed = 0;
    let failed = 0;
    for (const row of rows) {
      const ok = await processFiscalRow(row);
      if (ok) processed += 1;
      else failed += 1;
    }
    return { claimed: rows.length, processed, failed };
  } finally {
    draining = false;
  }
}

/** Single tick used by the API scheduler (idempotent, never throws). */
export async function runEfrisWorkerTick(): Promise<void> {
  try {
    await drainEfrisQueue(10);
  } catch (err) {
    console.error('[efris][worker]', err instanceof Error ? err.message : err);
  }
}