import pg from 'pg';
import { forbidden } from '../../utils.js';

/**
 * Data-classification policy for mail.
 *
 * A classification is not a label alone: it carries the rules that govern what a
 * reader may do with the message (forward / download / print / export / external
 * send) and whether approval is required before it leaves the building.
 *
 * The database is authoritative. Nothing here invents a policy: when the
 * classification row is missing we fall back to the most restrictive defaults
 * rather than the most permissive ones.
 */

export type ClassificationCode =
  | 'PUBLIC'
  | 'INTERNAL'
  | 'CONFIDENTIAL'
  | 'RESTRICTED'
  | 'HIGHLY_RESTRICTED';

export interface MailClassification {
  id: number | null;
  code: string;
  label: string;
  rank: number;
  color: string;
  description: string | null;
  allowForward: boolean;
  allowDownload: boolean;
  allowPrint: boolean;
  allowExport: boolean;
  allowExternal: boolean;
  requireApproval: boolean;
  requireEncryption: boolean;
  minRoleRank: number | null;
}

/**
 * Fallback used only when a tenant has not migrated the classification row.
 * Restrictive by design: a missing policy must never widen access.
 */
export function fallbackClassification(code: string): MailClassification {
  const normalized = String(code || 'INTERNAL').toUpperCase();
  return {
    id: null,
    code: normalized,
    label: normalized.replace(/_/g, ' '),
    rank: 2,
    color: 'slate',
    description: null,
    allowForward: false,
    allowDownload: false,
    allowPrint: false,
    allowExport: false,
    allowExternal: false,
    requireApproval: normalized === 'CONFIDENTIAL'
      || normalized === 'RESTRICTED'
      || normalized === 'HIGHLY_RESTRICTED',
    requireEncryption: normalized === 'HIGHLY_RESTRICTED',
    minRoleRank: null,
  };
}

function toClassification(row: Record<string, unknown>): MailClassification {
  return {
    id: Number(row.id),
    code: String(row.code),
    label: String(row.label ?? row.code),
    rank: Number(row.rank ?? 1),
    color: String(row.color ?? 'slate'),
    description: row.description == null ? null : String(row.description),
    allowForward: row.allow_forward !== false,
    allowDownload: row.allow_download !== false,
    allowPrint: row.allow_print !== false,
    allowExport: row.allow_export !== false,
    allowExternal: row.allow_external !== false,
    requireApproval: row.require_approval === true,
    requireEncryption: row.require_encryption === true,
    minRoleRank: row.min_role_rank == null ? null : Number(row.min_role_rank),
  };
}

/** Load one classification by code, falling back to restrictive defaults. */
export async function loadClassification(
  client: pg.PoolClient,
  tenantId: number,
  code: string
): Promise<MailClassification> {
  const normalized = String(code || 'INTERNAL').toUpperCase();
  const { rows } = await client.query(
    `SELECT * FROM email_classifications
      WHERE tenant_id = $1 AND code = $2 AND is_active = true`,
    [tenantId, normalized]
  );
  return rows[0] ? toClassification(rows[0]) : fallbackClassification(normalized);
}

/** All active classifications for a tenant, ordered least to most sensitive. */
export async function listClassifications(
  client: pg.PoolClient,
  tenantId: number
): Promise<MailClassification[]> {
  const { rows } = await client.query(
    `SELECT * FROM email_classifications
      WHERE tenant_id = $1 AND is_active = true
      ORDER BY rank, code`,
    [tenantId]
  );
  return rows.map(toClassification);
}

/**
 * The class of action a user is attempting. Each maps to one policy flag.
 * `EXTERNAL` is evaluated in addition to the base action when any recipient is
 * outside the tenant's own domains.
 */
export type MailAction =
  | 'VIEW'
  | 'FORWARD'
  | 'DOWNLOAD'
  | 'PRINT'
  | 'EXPORT';

/** Human-readable phrase used in the denial message. */
const ACTION_LABEL: Record<MailAction, string> = {
  VIEW: 'view',
  FORWARD: 'forward',
  DOWNLOAD: 'download',
  PRINT: 'print',
  EXPORT: 'export',
};

/**
 * Returns null when the action is permitted, or a message explaining the block.
 * Callers surface the message directly so the user is told *why*, not just that
 * a button is unavailable.
 */
export function classificationBlockReason(
  classification: MailClassification,
  action: MailAction
): string | null {
  switch (action) {
    case 'FORWARD':
      if (!classification.allowForward) {
        return `Messages classified ${classification.label} cannot be forwarded.`;
      }
      break;
    case 'DOWNLOAD':
      if (!classification.allowDownload) {
        return `Attachments on messages classified ${classification.label} cannot be downloaded.`;
      }
      break;
    case 'PRINT':
      if (!classification.allowPrint) {
        return `Messages classified ${classification.label} cannot be printed.`;
      }
      break;
    case 'EXPORT':
      if (!classification.allowExport) {
        return `Messages classified ${classification.label} cannot be exported.`;
      }
      break;
    case 'VIEW':
      break;
    default:
      break;
  }
  return null;
}

/** Throw 403 when the classification forbids the action. */
export function assertClassificationAllows(
  classification: MailClassification,
  action: MailAction
): void {
  const reason = classificationBlockReason(classification, action);
  if (reason) throw forbidden(reason);
}

/**
 * Whether any recipient address sits outside the mailbox/tenant domains.
 * Callers pass the tenant's own domains so an internal-only send is not
 * treated as external.
 */
export function hasExternalRecipient(
  recipients: readonly string[],
  internalDomains: readonly string[]
): boolean {
  const normalized = internalDomains
    .map((d) => String(d || '').trim().toLowerCase().replace(/^@/, ''))
    .filter(Boolean);
  if (normalized.length === 0) return recipients.length > 0;
  return recipients.some((address) => {
    const at = String(address || '').lastIndexOf('@');
    if (at < 0) return true;
    const domain = String(address).slice(at + 1).trim().toLowerCase();
    return !normalized.includes(domain);
  });
}

/**
 * Throw 403 when a message classified with `allow_external = false` is addressed
 * outside the organisation. Internal deliveries are unaffected.
 */
export function assertExternalAllowed(
  classification: MailClassification,
  recipients: readonly string[],
  internalDomains: readonly string[]
): void {
  if (classification.allowExternal) return;
  if (!hasExternalRecipient(recipients, internalDomains)) return;
  throw forbidden(
    `Messages classified ${classification.label} cannot be sent outside the organisation.`
  );
}