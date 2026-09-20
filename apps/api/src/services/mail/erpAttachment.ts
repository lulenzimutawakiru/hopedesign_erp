import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import { config } from '../../config.js';
import { Ctx } from '../../db.js';
import { can } from '../../middleware/authorize.js';
import {
  documentFingerprint,
  documentVerifyUrl,
  issueDocumentToken,
  loadCompanyProfile,
} from '../branding.js';
import { auditComms } from '../communication.js';
import { DOCUMENT_TYPES, renderDocument } from '../documents.js';
import { loadClassification } from './policy.js';

/**
 * Auto-attach the ERP document a message is about.
 *
 * A message linked to a business record (`emails.entity_type` /
 * `emails.entity_id`) is, in practice, that record doing the rounds: an invoice
 * on its way to a customer, a purchase order on its way to a supplier. Making
 * the sender export the PDF by hand and upload it again is busywork with a
 * real failure mode - the wrong revision, or no attachment at all - so the send
 * pipeline generates and attaches it instead.
 *
 * This runs inside the caller's send transaction but under a SAVEPOINT. A
 * document that cannot be rendered must never abort the send, and must never
 * leave a half-written attachment row behind for `prepareAttachments` to trip
 * over: the message still goes out, without the file, and the reason is
 * recorded in the comms audit trail rather than swallowed.
 *
 * The manual path lives at POST /api/ops/mail/messages/:id/attachments/erp
 * (routes/ops/mail.ts) and stays put: it attaches a file somebody already
 * uploaded to the DMS. This module is the automatic path, and the only one that
 * helps when no such file exists. The two cannot collide - that route records
 * entity_type as the DMS document's own type, this records the business document
 * type - so the dedup below only ever matches rows this module wrote.
 */

/** Mirrored from services/mail/send.ts, which keeps its own copies private. */
const MAX_ATTACHMENT_COUNT = 20;
const MAX_ATTACHMENT_TOTAL_BYTES = 18 * 1024 * 1024;

/**
 * `emails.entity_type` is free text written by several code paths, so the same
 * business object reaches us spelled three ways: the dotted module key
 * (`sales.orders`), the table it lives in (`sales_orders`,
 * `customer_invoices`) and the document type itself (`sales-order`). They are
 * all folded onto DOCUMENT_TYPES keys here. An entity we cannot map is left
 * alone - guessing would attach the wrong document to a customer's mail.
 */
const DOCUMENT_TYPE_ALIASES: Record<string, string> = {
  // Sales
  'sales-orders': 'sales-order',
  'sales-quotations': 'sales-quotation',
  'sales-invoices': 'sales-invoice',
  'customer-invoices': 'sales-invoice',
  'sales-credit-notes': 'credit-note',
  'credit-notes': 'credit-note',
  'sales-debit-notes': 'debit-note',
  'debit-notes': 'debit-note',
  'sales-returns': 'sales-return',
  'sales-receipts': 'receipt',
  'sales-delivery-notes': 'delivery-note',
  'delivery-notes': 'delivery-note',
  receipts: 'receipt',

  // Procurement
  'procurement-requisitions': 'requisition',
  'purchase-requisitions': 'requisition',
  'procurement-orders': 'purchase-order',
  'purchase-orders': 'purchase-order',
  'procurement-supplier-invoices': 'purchase-invoice',
  'supplier-invoices': 'purchase-invoice',
  'procurement-supplier-quotations': 'supplier-quotation',
  'supplier-quotations': 'supplier-quotation',
  'procurement-payments': 'supplier-payment',
  'supplier-payments': 'supplier-payment',
  'procurement-goods-receipts': 'goods-receipt',
  'goods-receipts': 'goods-receipt',
  'procurement-rfqs': 'rfq',
  'procurement-returns': 'purchase-return',
  'purchase-returns': 'purchase-return',
  requisitions: 'requisition',
  rfqs: 'rfq',

  // Finance, HR, operations, quality
  'ops-expenses': 'expense',
  'expense-transactions': 'expense',
  'finance-journals': 'journal',
  'hr-contracts': 'employment-contract',
  'employment-contracts': 'employment-contract',
  'hr-payslips': 'payslip',
  'hr-payrolls': 'payroll-register',
  'employee-identities': 'employee-id',
  'employee-id-cards': 'employee-id-card',
  'quality-inspections': 'inspection',
  expenses: 'expense',
  journals: 'journal',
  payrolls: 'payroll-register',
  payslips: 'payslip',
  inspections: 'inspection',
};

/** Lower-case an entity type and flatten the separators used across modules. */
function normalizeEntityType(raw: unknown): string {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[._\s]+/g, '-');
}

/**
 * Resolve a key to itself when this system can actually render it, else null.
 * The alias table is plain text, so nothing stops an entry from naming a
 * document that was never built; without this check the attachment step would
 * be handed such a key and trip over `DOCUMENT_TYPES[type]` being undefined.
 * Every alias resolves today - this only keeps that true by construction as
 * the table grows.
 */
function documentTypeKey(key: string | undefined): string | null {
  if (!key) return null;
  return Object.prototype.hasOwnProperty.call(DOCUMENT_TYPES, key) ? key : null;
}

/**
 * Map `emails.entity_type` onto a DOCUMENT_TYPES key, or null when the linked
 * record is not a document this system can generate.
 */
export function resolveDocumentType(entityType: unknown): string | null {
  const key = normalizeEntityType(entityType);
  if (!key) return null;
  const direct = documentTypeKey(key);
  if (direct) return direct;
  const alias = documentTypeKey(DOCUMENT_TYPE_ALIASES[key]);
  if (alias) return alias;
  const singular = key.replace(/s$/, '');
  const singularDirect = documentTypeKey(singular);
  if (singularDirect) return singularDirect;
  return documentTypeKey(DOCUMENT_TYPE_ALIASES[singular]);
}

export interface ErpAttachmentOutcome {
  attached: boolean;
  /** Why nothing was attached. Null on success. Never shown to the recipient. */
  reason: string | null;
  documentType: string | null;
  entityId: number | null;
  attachmentId: number | null;
  fileName: string | null;
}

/**
 * Storage key for a mail attachment. Mirrors the layout in routes/ops/mail.ts so
 * both writers agree on where a message's files live.
 */
function attachmentStorageRel(
  tenantId: number,
  companyId: number | null | undefined,
  emailId: number,
  attachmentId: number,
  ext: string
): string {
  return `dms/${tenantId}/${companyId ?? 0}/mail/${emailId}/${attachmentId}${ext}`;
}

/** Current attachment count and byte total for a message. */
async function attachmentHeadroom(
  client: pg.PoolClient,
  tenantId: number,
  emailId: number
): Promise<{ count: number; total: number }> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS count, COALESCE(sum(file_size), 0)::bigint AS total
       FROM email_attachments
      WHERE email_id = $1 AND tenant_id = $2 AND deleted_at IS NULL`,
    [emailId, tenantId]
  );
  return { count: Number(rows[0]?.count ?? 0), total: Number(rows[0]?.total ?? 0) };
}

/** Recompute the message's attachment flag from the rows that actually remain. */
async function refreshAttachmentFlag(
  client: pg.PoolClient,
  tenantId: number,
  emailId: number
): Promise<void> {
  await client.query(
    `UPDATE emails
        SET has_attachments = EXISTS (
              SELECT 1 FROM email_attachments a
               WHERE a.email_id = $1 AND a.tenant_id = $2 AND a.deleted_at IS NULL
            ),
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND tenant_id = $2`,
    [emailId, tenantId]
  );
}

/** Name printed as the issuer on the generated document. */
async function issuerName(client: pg.PoolClient, ctx: Ctx): Promise<string> {
  const userId = ctx.userId ?? 0;
  if (userId) {
    const { rows } = await client.query(
      `SELECT first_name, last_name FROM users
        WHERE id = $1 AND tenant_id = COALESCE($2::bigint, tenant_id)`,
      [userId, ctx.tenantId ?? null]
    );
    const name = rows[0]
      ? [rows[0].first_name, rows[0].last_name].filter(Boolean).join(' ').trim()
      : '';
    if (name) return name;
  }
  return 'HOPE DESIGN ERP';
}

/**
 * Best-effort note that a document was expected but not attached. Never throws:
 * the caller is mid-send and a bookkeeping insert must not become the reason a
 * message fails.
 */
async function recordSkipped(
  client: pg.PoolClient,
  ctx: Ctx,
  emailId: number,
  documentType: string | null,
  entityId: number | null,
  reason: string
): Promise<void> {
  if (ctx.tenantId == null) return;
  console.error(
    `[mail] no ERP document attached to email ${emailId} (${documentType ?? 'unmapped'}#${entityId ?? 0}): ${reason}`
  );
  await client.query('SAVEPOINT erp_mail_attachment_err');
  try {
    await auditComms(client, ctx, 'EMAIL_ATTACHMENT_AUTO_SKIPPED', 'email', emailId, {
      documentType,
      entityId,
      reason,
    });
    await client.query('RELEASE SAVEPOINT erp_mail_attachment_err');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT erp_mail_attachment_err');
    await client.query('RELEASE SAVEPOINT erp_mail_attachment_err');
  }
}

function outcome(
  attached: boolean,
  reason: string | null,
  documentType: string | null,
  entityId: number | null
): ErpAttachmentOutcome {
  return { attached, reason, documentType, entityId, attachmentId: null, fileName: null };
}

/**
 * Attach the ERP document this message is about, if it is about one.
 *
 * Idempotent: a message that already carries this entity's document is left
 * alone, so an outbox retry cannot duplicate the file. Never throws.
 */
export async function attachErpDocumentForEmail(
  client: pg.PoolClient,
  ctx: Ctx,
  permissions: readonly string[] | undefined,
  email: Record<string, unknown>
): Promise<ErpAttachmentOutcome> {
  const emailId = Number(email.id);
  if (!Number.isFinite(emailId) || emailId <= 0) {
    return outcome(false, 'NO_MESSAGE', null, null);
  }

  const documentType = resolveDocumentType(email.entity_type);
  const rawEntityId = Number(email.entity_id ?? 0);
  const entityId =
    Number.isFinite(rawEntityId) && Number.isInteger(rawEntityId) && rawEntityId > 0
      ? rawEntityId
      : null;
  if (!documentType || entityId == null) {
    return outcome(false, 'NO_ENTITY', documentType, entityId);
  }

  const def = DOCUMENT_TYPES[documentType];
  // The attachment carries exactly the facts the document endpoint serves, so it
  // is released under the same permission. Someone who may not read the
  // document must not be able to post it out by attaching it to a message.
  if (!can(permissions, def.permission)) {
    return outcome(false, 'NO_PERMISSION', documentType, entityId);
  }

  const tenantId = ctx.tenantId ?? 0;
  let writtenPath: string | null = null;

  await client.query('SAVEPOINT erp_mail_attachment');
  try {
    const already = await client.query(
      `SELECT id FROM email_attachments
        WHERE tenant_id = $1 AND email_id = $2 AND deleted_at IS NULL
          AND source = 'ERP_DOCUMENT' AND lower(entity_type) = $3 AND entity_id = $4
        LIMIT 1`,
      [tenantId, emailId, documentType, entityId]
    );
    if (already.rows.length > 0) {
      await client.query('RELEASE SAVEPOINT erp_mail_attachment');
      return outcome(false, 'ALREADY_ATTACHED', documentType, entityId);
    }

    const headroom = await attachmentHeadroom(client, tenantId, emailId);
    if (headroom.count >= MAX_ATTACHMENT_COUNT || headroom.total >= MAX_ATTACHMENT_TOTAL_BYTES) {
      await client.query('RELEASE SAVEPOINT erp_mail_attachment');
      return outcome(false, 'BUDGET', documentType, entityId);
    }

    const loaded = await def.load(client, ctx, entityId);
    const company = await loadCompanyProfile(client, ctx);
    const classification = await loadClassification(
      client,
      tenantId,
      String(email.classification ?? 'INTERNAL')
    );
    const issuedAt = new Date().toISOString();
    const issuer = await issuerName(client, ctx);
    const fingerprint = documentFingerprint({
      code: loaded.code,
      title: loaded.title,
      subtitle: loaded.subtitle,
      meta: loaded.meta,
      columns: loaded.columns,
      items: loaded.items,
      totals: loaded.totals,
      notes: loaded.notes,
    });
    const token = company.verifyEnabled
      ? issueDocumentToken({
          type: def.type,
          id: entityId,
          code: loaded.code,
          title: loaded.title,
          fingerprint,
          issuedAt,
          tenantId,
          companyId: ctx.companyId ?? null,
          companyName: company.name,
          issuer: 'mailer',
          issuerName: issuer,
        })
      : '';

    // The message's own classification is stamped on the document, so a file
    // generated for a sensitive message is never handed out under a weaker
    // label than the message it travels with.
    const rendered = await renderDocument('pdf', loaded, {
      company,
      issuedBy: issuer,
      issuedAt,
      signerName: issuer,
      correlationId: ctx.correlationId ?? null,
      classification: classification.label,
      fingerprint,
      token: token || undefined,
      verifyUrl: token ? documentVerifyUrl(company, token) : undefined,
    });
    const buffer = rendered.buffer;
    if (headroom.total + buffer.length > MAX_ATTACHMENT_TOTAL_BYTES) {
      await client.query('RELEASE SAVEPOINT erp_mail_attachment');
      return outcome(false, 'BUDGET', documentType, entityId);
    }

    const safe = String(loaded.code || `${def.type}-${entityId}`).replace(
      /[^A-Za-z0-9._-]+/g,
      '_'
    );
    const fileName = `${def.type}_${safe}.${rendered.extension}`;
    const hash = createHash('sha256').update(buffer).digest('hex');

    const inserted = await client.query(
      `INSERT INTO email_attachments
         (tenant_id, email_id, file_name, file_type, file_size, storage_path,
          content_hash, source, scan_status, dms_document_id, entity_type,
          entity_id, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,NULL,$6,'ERP_DOCUMENT','SKIPPED',NULL,$7,$8,$9)
       RETURNING id`,
      [
        tenantId,
        emailId,
        fileName,
        rendered.contentType,
        buffer.length,
        hash,
        documentType,
        entityId,
        ctx.userId ?? null,
      ]
    );
    const attachmentId = Number(inserted.rows[0].id);

    const rel = attachmentStorageRel(tenantId, ctx.companyId, emailId, attachmentId, `.${rendered.extension}`);
    const abs = path.join(config.storageRoot, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, buffer);
    writtenPath = abs;

    await client.query(
      `UPDATE email_attachments
          SET storage_path = $1, content_hash = $2, file_size = $3, updated_at = now()
        WHERE id = $4 AND tenant_id = $5`,
      [rel, hash, buffer.length, attachmentId, tenantId]
    );
    await refreshAttachmentFlag(client, tenantId, emailId);
    await auditComms(client, ctx, 'EMAIL_ATTACHMENT_ATTACHED', 'email', emailId, {
      attachmentId,
      documentType,
      entityId,
      fileName,
      source: 'ERP_DOCUMENT',
      automatic: true,
    });
    await client.query('RELEASE SAVEPOINT erp_mail_attachment');

    return {
      attached: true,
      reason: null,
      documentType,
      entityId,
      attachmentId,
      fileName,
    };
  } catch (err) {
    await client.query('ROLLBACK TO SAVEPOINT erp_mail_attachment');
    await client.query('RELEASE SAVEPOINT erp_mail_attachment');
    // The row is gone with the savepoint; drop the orphaned bytes with it.
    if (writtenPath) {
      try {
        rmSync(writtenPath, { force: true });
      } catch {
        /* an orphaned file is harmless; a failed send is not */
      }
    }
    await recordSkipped(
      client,
      ctx,
      emailId,
      documentType,
      entityId,
      err instanceof Error ? err.message : String(err)
    );
    return outcome(false, 'RENDER_FAILED', documentType, entityId);
  }
}
