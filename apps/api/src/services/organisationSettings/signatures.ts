import pg from 'pg';
import { Ctx } from '../../db.js';
import { badRequest, forbidden, notFound } from '../../utils.js';
import {
  activateSignatureProfile,
  applyDocumentSignature,
  approveSignatureProfile,
  approveSignatureScope,
  attachSignatureArtwork,
  createSignatureProfile,
  createSignatureScope,
  deleteSignatureScope,
  expireSignatureProfile,
  getSignatureProfileDetail,
  listDocumentSignatures,
  listSignatureProfiles,
  listSignatureScopes,
  rejectSignatureProfile,
  rejectSignatureScope,
  revokeSignatureProfile,
  signatureDashboard,
  submitSignatureProfile,
  suspendSignatureProfile,
  updateSignatureProfile,
  updateSignatureScope,
  verifyDocumentSignature,
} from '../governance.js';

/**
 * Signature settings.
 *
 * Every one of these is a re-export of the governance implementation, wrapped
 * only where the settings module needs a different shape. Nothing about a
 * signature is reimplemented here, and that is deliberate: the signing chain
 *
 *   Prepare -> Approve -> Verify authority -> Verify signature
 *           -> Apply -> Final PDF -> Hash -> Store -> Audit
 *
 * already exists in governance.ts, and a second implementation of it in a
 * settings file is exactly how "who is allowed to sign this" ends up with two
 * different answers depending on which caller asked.
 *
 * The one invariant worth restating, because it is a security property and not
 * a convenience: a user may only apply their own ACTIVE profile, inside its
 * effective window, within an approved authority scope, and only to documents
 * whose type and amount that scope covers. governance.applyDocumentSignature()
 * enforces all four; the wrapper below does not weaken any of them, it just
 * refuses earlier with a clearer message so a settings screen cannot present an
 * action that would fail (TC-ORG-007).
 */

export const SIGNATURE_STATUSES = [
  'DRAFT', 'PENDING', 'ACTIVE', 'SUSPENDED', 'REVOKED', 'EXPIRED', 'REJECTED',
] as const;

export const SIGNATURE_AUTHORITY_LEVELS = [
  'EXECUTIVE', 'MANAGEMENT', 'FINANCE', 'HR', 'OPERATIONS', 'TECHNICAL', 'SECURITY', 'OTHER',
] as const;

/** The states a profile can be edited in, per governance.updateSignatureProfile. */
export const EDITABLE_SIGNATURE_STATUSES: ReadonlySet<string> = new Set([
  'DRAFT', 'PENDING', 'SUSPENDED', 'REJECTED',
]);

export const signatureProfiles = {
  list: listSignatureProfiles,
  detail: getSignatureProfileDetail,
  create: createSignatureProfile,
  update: updateSignatureProfile,
  attachArtwork: attachSignatureArtwork,
  submit: submitSignatureProfile,
  approve: approveSignatureProfile,
  reject: rejectSignatureProfile,
  activate: activateSignatureProfile,
  suspend: suspendSignatureProfile,
  revoke: revokeSignatureProfile,
  expire: expireSignatureProfile,
};

export const signatureScopes = {
  list: listSignatureScopes,
  create: createSignatureScope,
  update: updateSignatureScope,
  remove: deleteSignatureScope,
  approve: approveSignatureScope,
  reject: rejectSignatureScope,
};

export const documentSignatures = {
  list: listDocumentSignatures,
  apply: applyDocumentSignature,
  verify: verifyDocumentSignature,
};

export function signatureOverview(client: pg.PoolClient, ctx: Ctx) {
  return signatureDashboard(client, ctx);
}

/**
 * Can this user sign this document right now?
 *
 * A UI that offers a Sign button should ask this first. It answers with a
 * reason rather than a bare boolean so the screen can explain the refusal
 * instead of showing a disabled control with no explanation.
 */
export async function canSign(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { profileId: number; documentType: string; amount?: number | null; transactionType?: string | null }
): Promise<{ allowed: boolean; reason: string | null }> {
  if (!input.profileId) return { allowed: false, reason: 'No signature profile selected' };
  const detail = await getSignatureProfileDetail(client, ctx, input.profileId);
  const profile = detail.profile as Record<string, unknown>;
  const status = String(profile.status ?? '');

  if (status !== 'ACTIVE') {
    return { allowed: false, reason: 'The signature profile is ' + (status || 'not set up') + ', not ACTIVE' };
  }
  if (profile.userId != null && ctx.userId != null && Number(profile.userId) !== Number(ctx.userId)) {
    return { allowed: false, reason: 'A user can only apply their own signature profile' };
  }
  const now = Date.now();
  const from = profile.effectiveFrom ? new Date(String(profile.effectiveFrom)).getTime() : null;
  if (from != null && Number.isFinite(from) && from > now) {
    return { allowed: false, reason: 'The signature profile is not yet effective' };
  }
  const to = profile.expiresAt ? new Date(String(profile.expiresAt)).getTime() : null;
  if (to != null && Number.isFinite(to) && to <= now) {
    return { allowed: false, reason: 'The signature profile has expired' };
  }

  const amount = input.amount == null ? null : Number(input.amount);
  const scopes = detail.scopes as Array<Record<string, unknown>>;
  const covering = scopes.filter((s) => {
    if (String(s.documentType) !== input.documentType) return false;
    const st = s.transactionType == null ? null : String(s.transactionType);
    if (st !== (input.transactionType ?? null)) return false;
    if (String(s.status) === 'REJECTED') return false;
    if (String(s.status) !== 'APPROVED') return false;
    const cap = s.maxAmount == null ? null : Number(s.maxAmount);
    if (amount != null && cap != null && amount > cap) return false;
    return true;
  });

  if (covering.length === 0) {
    return {
      allowed: false,
      reason: 'No approved signature authority covers ' + input.documentType +
        (amount == null ? '' : ' at this amount'),
    };
  }
  return { allowed: true, reason: null };
}

/** Convenience for callers that want a throw rather than a verdict. */
export async function assertCanSign(
  client: pg.PoolClient,
  ctx: Ctx,
  input: { profileId: number; documentType: string; amount?: number | null; transactionType?: string | null }
) {
  const verdict = await canSign(client, ctx, input);
  if (!verdict.allowed) throw forbidden(verdict.reason ?? 'Not authorised to sign this document');
  return true;
}

/**
 * Guard for the settings list: a profile belonging to another company must not
 * be visible, and a missing profile must read as missing rather than as an
 * empty form.
 */
export async function requireSignatureProfile(client: pg.PoolClient, ctx: Ctx, id: number) {
  if (!Number.isFinite(id) || id <= 0) throw badRequest('A signature profile id is required');
  const detail = await getSignatureProfileDetail(client, ctx, id);
  const profile = detail.profile as Record<string, unknown>;
  if (!profile || profile.id == null) throw notFound('Signature profile not found');
  if (ctx.companyId != null && profile.companyId != null && Number(profile.companyId) !== Number(ctx.companyId)) {
    throw forbidden('The signature profile belongs to another company');
  }
  return detail;
}
