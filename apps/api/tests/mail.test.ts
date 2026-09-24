/**
 * Company mailing system (mail) API coverage.
 *
 * Exercises the tenant-facing surface mounted at /api/ops/mail: mailbox
 * visibility and RBAC denial, classification/folder metadata, the read
 * endpoints the mail UI depends on, and the write paths (labels, drafts,
 * signatures, distribution lists, provider configs). Provider credentials are
 * checked to never leave the API, and every row created here is removed again
 * so the shared database is left as it was found.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { api, auth, db, loginAs } from './helpers.js';
import { dedupeEmails, runCronJobById } from '../src/services/cronJobs.js';
import { config } from '../src/config.js';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';
import { tx } from '../src/db.js';
import type { Ctx } from '../src/db.js';
import {
  insertOutboundEmail,
  notifyCustomer,
  notifyUserAdvanced,
  renderTemplate,
} from '../src/services/communication.js';
import { resolveDocumentType } from '../src/services/mail/erpAttachment.js';

const BASE = '/api/ops/mail';
const MAIL_INFO = 3; // seeded SHARED mailbox (MAIL-INFO)
const WORKSPACE_FOLDERS = ['INBOX', 'SENT', 'DRAFTS', 'SCHEDULED', 'OUTBOX', 'ARCHIVE', 'TRASH', 'SPAM'];

const stamp = Date.now().toString(36);

let adminToken = '';
let adminUserId = 0;
let lowToken = '';
let lowUserId = 0;

const createdMessages: number[] = [];
const createdLabels: number[] = [];
const createdSignatures: number[] = [];
const createdLists: number[] = [];
const createdConfigs: number[] = [];
const createdDelegations: number[] = [];

beforeAll(async () => {
  const admin = await loginAs('admin');
  adminToken = admin.token;
  adminUserId = Number(admin.user.id);
  const low = await loginAs('willy.wh'); // warehouse roles: no communication.* grants
  lowToken = low.token;
  lowUserId = Number(low.user.id);
});

afterAll(async () => {
  if (createdMessages.length) await db('DELETE FROM emails WHERE id = ANY($1::int[])', [createdMessages]);
  if (createdDelegations.length) {
    await db('DELETE FROM mailbox_delegations WHERE id = ANY($1::int[])', [createdDelegations]);
  }
  if (createdLabels.length) await db('DELETE FROM email_labels WHERE id = ANY($1::int[])', [createdLabels]);
  if (createdSignatures.length) {
    await db('DELETE FROM email_signatures WHERE id = ANY($1::int[])', [createdSignatures]);
  }
  if (createdLists.length) {
    await db('DELETE FROM email_distribution_lists WHERE id = ANY($1::int[])', [createdLists]);
  }
  if (createdConfigs.length) {
    await db('DELETE FROM email_provider_configs WHERE id = ANY($1::int[])', [createdConfigs]);
  }
  // Membership is the grant path that makes a mailbox reachable at all, so it is
  // removed explicitly rather than left behind on the shared database.
  if (lowUserId) {
    await db('DELETE FROM mailbox_members WHERE mailbox_id = $1 AND user_id = $2', [MAIL_INFO, lowUserId]);
  }
});

describe('mail: mailbox visibility', () => {
  it('lists the seeded mailboxes with resolved permissions', async () => {
    const res = await api.get(`${BASE}/mailboxes`).set(auth(adminToken));
    expect(res.status).toBe(200);
    const mailboxes = res.body.data.mailboxes as Array<Record<string, unknown>>;
    expect(Array.isArray(mailboxes)).toBe(true);
    expect(mailboxes.length).toBeGreaterThanOrEqual(10);
    expect(mailboxes.map((m) => String(m.code))).toContain('MAIL-INFO');

    for (const mailbox of mailboxes) {
      expect(typeof mailbox.address).toBe('string');
      expect(String(mailbox.address)).toContain('@');
      expect(typeof mailbox.defaultClassification).toBe('string');
      expect(typeof mailbox.permissions).toBe('object');
      expect(mailbox.permissions).not.toBeNull();
      expect(typeof (mailbox.permissions as Record<string, unknown>).canView).toBe('boolean');
    }
    // A mail administrator sees every mailbox with full rights.
    expect(mailboxes.every((m) => m.globalAdmin === true)).toBe(true);
  });

  it('filters mailboxes by kind', async () => {
    const res = await api.get(`${BASE}/mailboxes?kind=SYSTEM`).set(auth(adminToken));
    expect(res.status).toBe(200);
    const mailboxes = res.body.data.mailboxes as Array<Record<string, unknown>>;
    expect(mailboxes).toHaveLength(2);
    for (const mailbox of mailboxes) expect(mailbox.kind).toBe('SYSTEM');
    expect(mailboxes.map((m) => String(m.code)).sort()).toEqual(['MAIL-NOREPLY', 'MAIL-NOTIFICATIONS']);
  });

  it('returns a single mailbox by id', async () => {
    const res = await api.get(`${BASE}/mailboxes/${MAIL_INFO}`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(res.body.data.code).toBe('MAIL-INFO');
    expect(Number(res.body.data.id)).toBe(MAIL_INFO);
  });

  it('404s an unknown mailbox', async () => {
    const res = await api.get(`${BASE}/mailboxes/999999`).set(auth(adminToken));
    expect(res.status).toBe(404);
    expect(res.body.error.message).toBe('Mailbox not found');
  });
});

describe('mail: RBAC denials', () => {
  it('rejects unauthenticated calls', async () => {
    const res = await api.get(`${BASE}/mailboxes`);
    expect(res.status).toBe(401);
  });

  it('blocks a user without communication permissions', async () => {
    for (const path of ['/mailboxes', '/messages', '/outbox', '/approvals', '/audit']) {
      const res = await api.get(`${BASE}${path}`).set(auth(lowToken));
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('FORBIDDEN');
    }
  });
});

describe('mail: classifications and folder summary', () => {
  it('lists the active classifications', async () => {
    const res = await api.get(`${BASE}/classifications`).set(auth(adminToken));
    expect(res.status).toBe(200);
    const rows = res.body.data.classifications as Array<Record<string, unknown>>;
    expect(rows.length).toBeGreaterThan(0);
    const codes = rows.map((r) => String(r.code));
    expect(codes).toContain('INTERNAL');
    expect(codes).toContain('CONFIDENTIAL');
  });

  it('reports a counter for every workspace folder', async () => {
    const res = await api.get(`${BASE}/messages/summary`).set(auth(adminToken));
    expect(res.status).toBe(200);
    const folders = res.body.data.folders as Record<string, unknown>;
    for (const folder of WORKSPACE_FOLDERS) {
      expect(folders).toHaveProperty(folder);
      expect(typeof (folders[folder] as Record<string, unknown>).total).toBe('number');
    }
    expect(typeof res.body.data.mailboxCount).toBe('number');
  });

  it('rejects an unsupported folder filter', async () => {
    const res = await api.get(`${BASE}/messages?folder=NOPE`).set(auth(adminToken));
    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe('Unsupported folder "NOPE"');
  });
});

describe('mail: read endpoints', () => {
  it('returns paginated message rows', async () => {
    const res = await api.get(`${BASE}/messages`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.rows)).toBe(true);
    expect(typeof res.body.data.pagination.page).toBe('number');
    expect(typeof res.body.data.pagination.pageSize).toBe('number');
    expect(typeof res.body.data.pagination.total).toBe('number');
  });

  it('returns the outbox, approvals, signatures and distribution lists', async () => {
    const outbox = await api.get(`${BASE}/outbox`).set(auth(adminToken));
    expect(outbox.status).toBe(200);
    expect(Array.isArray(outbox.body.data.rows)).toBe(true);

    const approvals = await api.get(`${BASE}/approvals`).set(auth(adminToken));
    expect(approvals.status).toBe(200);
    expect(Array.isArray(approvals.body.data.approvals)).toBe(true);
    expect(typeof approvals.body.data.actionableCount).toBe('number');

    const signatures = await api.get(`${BASE}/signatures`).set(auth(adminToken));
    expect(signatures.status).toBe(200);
    expect(Array.isArray(signatures.body.data.signatures)).toBe(true);
    expect(signatures.body.data).toHaveProperty('defaultSignature');

    const lists = await api.get(`${BASE}/distribution-lists`).set(auth(adminToken));
    expect(lists.status).toBe(200);
    expect(Array.isArray(lists.body.data.lists)).toBe(true);
  });

  it('returns paginated audit rows', async () => {
    const res = await api.get(`${BASE}/audit`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data.rows)).toBe(true);
    expect(res.body.data.pagination).toBeTruthy();
  });

  it('returns directory users for pickers as a bare array', async () => {
    const res = await api.get(`${BASE}/directory/users`).set(auth(adminToken));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.data)).toBe(true);
    for (const person of res.body.data as Array<Record<string, unknown>>) {
      // Ids arrive as strings (bigint serialised by node-postgres) and callers
      // coerce before use, so assert the shape the API actually guarantees.
      expect(Number.isFinite(Number(person.id))).toBe(true);
      expect(typeof person.username).toBe('string');
    }
  });
});

describe('mail: provider configuration', () => {
  const secret = `tok_live_${stamp}_never_returned`;

  it('stores credentials encrypted and never echoes them back', async () => {
    const created = await api
      .post(`${BASE}/provider-configs`)
      .set(auth(adminToken))
      .send({
        environment: 'SANDBOX',
        provider: 'RESEND',
        label: `test-${stamp}`,
        fromAddress: 'noreply@hopedesign.jorlentech.com',
        credentials: secret,
        config: {},
      });
    expect(created.status).toBe(200);
    const view = created.body.data as Record<string, unknown>;
    createdConfigs.push(Number(view.id));

    // The public shape is fixed: credentials are represented by a boolean only.
    expect(Object.keys(view).sort()).toEqual(
      [
        'id', 'environment', 'provider', 'label', 'fromName', 'fromAddress', 'replyTo',
        'inboundAddress', 'config', 'isActive', 'isDefault', 'hasCredentials',
        'lastVerifiedAt', 'lastError', 'createdBy', 'createdAt', 'updatedAt',
      ].sort()
    );
    expect(view.hasCredentials).toBe(true);
    expect(JSON.stringify(view)).not.toContain(secret);

    const listed = await api.get(`${BASE}/provider-configs`).set(auth(adminToken));
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain(secret);
    for (const row of listed.body.data.rows as Array<Record<string, unknown>>) {
      expect(typeof row.hasCredentials).toBe('boolean');
      expect(row).not.toHaveProperty('credentials');
      expect(row).not.toHaveProperty('credentialsEncrypted');
      expect(row).not.toHaveProperty('credentials_encrypted');
    }

    // The secret really is persisted, just in encrypted form.
    const stored = await db('SELECT credentials_encrypted FROM email_provider_configs WHERE id = $1', [view.id]);
    expect(stored.rows[0]?.credentials_encrypted).toBeTruthy();
    expect(stored.rows[0]?.credentials_encrypted).not.toBe(secret);
  });

  it('requires credentials and a supported environment', async () => {
    const missing = await api
      .post(`${BASE}/provider-configs`)
      .set(auth(adminToken))
      .send({ environment: 'SANDBOX', provider: 'RESEND', label: `missing-${stamp}` });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toBe('credentials is required');

    const badEnv = await api
      .post(`${BASE}/provider-configs`)
      .set(auth(adminToken))
      .send({ environment: 'NOPE', provider: 'RESEND', label: `badenv-${stamp}`, credentials: 'x' });
    expect(badEnv.status).toBe(400);
    expect(badEnv.body.error.message).toBe('Unsupported environment "NOPE". Use SANDBOX or PRODUCTION.');
  });

  it('rejects a duplicate configuration and an empty update', async () => {
    const body = { environment: 'PRODUCTION', provider: 'SMTP', label: `dup-${stamp}`, credentials: 'x' };
    const first = await api.post(`${BASE}/provider-configs`).set(auth(adminToken)).send(body);
    expect(first.status).toBe(200);
    createdConfigs.push(Number(first.body.data.id));

    const second = await api.post(`${BASE}/provider-configs`).set(auth(adminToken)).send(body);
    expect(second.status).toBe(409);
    expect(second.body.error.message).toContain('already exists');

    const noop = await api.patch(`${BASE}/provider-configs/${first.body.data.id}`).set(auth(adminToken)).send({});
    expect(noop.status).toBe(400);
    expect(noop.body.error.message).toBe('No supported fields were supplied');
  });
});

describe('mail: labels', () => {
  it('creates, renames and deletes a mailbox label', async () => {
    const name = `Suite-${stamp}`;
    const created = await api
      .post(`${BASE}/mailboxes/${MAIL_INFO}/labels`)
      .set(auth(adminToken))
      .send({ name, color: 'blue' });
    expect(created.status).toBe(200);
    const label = created.body.data.label as Record<string, unknown>;
    expect(label.name).toBe(name);
    expect(label.kind).toBe('USER');
    expect(Number(label.mailboxId)).toBe(MAIL_INFO);

    const duplicate = await api
      .post(`${BASE}/mailboxes/${MAIL_INFO}/labels`)
      .set(auth(adminToken))
      .send({ name, color: 'blue' });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.message).toBe('A label with that name already exists on this mailbox.');

    const listed = await api.get(`${BASE}/mailboxes/${MAIL_INFO}/labels`).set(auth(adminToken));
    expect(listed.status).toBe(200);
    const ids = (listed.body.data.labels as Array<Record<string, unknown>>).map((l) => Number(l.id));
    expect(ids).toContain(Number(label.id));

    const patched = await api
      .patch(`${BASE}/labels/${label.id}`)
      .set(auth(adminToken))
      .send({ name: `${name}-renamed`, color: 'red' });
    expect(patched.status).toBe(200);
    expect(patched.body.data.label.name).toBe(`${name}-renamed`);
    expect(patched.body.data.label.color).toBe('red');

    const empty = await api.patch(`${BASE}/labels/${label.id}`).set(auth(adminToken)).send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toBe('No supported fields supplied');

    const removed = await api.delete(`${BASE}/labels/${label.id}`).set(auth(adminToken));
    expect(removed.status).toBe(200);
    expect(removed.body.data).toEqual({ id: Number(label.id), deleted: true });
  });

  it('validates label input', async () => {
    const blank = await api
      .post(`${BASE}/mailboxes/${MAIL_INFO}/labels`)
      .set(auth(adminToken))
      .send({ name: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.message).toBe('A label name is required.');

    const badKind = await api
      .post(`${BASE}/mailboxes/${MAIL_INFO}/labels`)
      .set(auth(adminToken))
      .send({ name: `kind-${stamp}`, kind: 'NOPE' });
    expect(badKind.status).toBe(400);
    expect(badKind.body.error.message).toBe('kind must be USER, SYSTEM or CLASSIFICATION');
  });
});

describe('mail: draft lifecycle', () => {
  it('creates a draft, moves it through the folders and purges it', async () => {
    const subject = `Draft ${stamp}`;
    const created = await api
      .post(`${BASE}/messages`)
      .set(auth(adminToken))
      .send({
        mailboxId: MAIL_INFO,
        to: 'external.party@example.com',
        subject,
        body: 'Hello from the test suite.',
        classification: 'CONFIDENTIAL',
      });
    expect(created.status).toBe(200);
    const draft = created.body.data as Record<string, unknown>;
    createdMessages.push(Number(draft.id));
    expect(draft.status).toBe('DRAFT');
    expect(draft.folder).toBe('DRAFTS');
    expect(Number(draft.recipientCount)).toBe(1);

    const detail = await api.get(`${BASE}/messages/${draft.id}`).set(auth(adminToken));
    expect(detail.status).toBe(200);
    expect(detail.body.data.message.subject).toBe(subject);
    expect(detail.body.data.mailbox.code).toBe('MAIL-INFO');
    expect(detail.body.data.policy).toBeTruthy();

    const drafts = await api
      .get(`${BASE}/messages?folder=DRAFTS&mailboxId=${MAIL_INFO}`)
      .set(auth(adminToken));
    expect(drafts.status).toBe(200);
    const draftIds = (drafts.body.data.rows as Array<Record<string, unknown>>).map((r) => Number(r.id));
    expect(draftIds).toContain(Number(draft.id));

    const archived = await api.post(`${BASE}/messages/${draft.id}/archive`).set(auth(adminToken)).send({});
    expect(archived.status).toBe(200);
    expect(archived.body.data.folder).toBe('ARCHIVE');

    const unarchived = await api.post(`${BASE}/messages/${draft.id}/unarchive`).set(auth(adminToken)).send({});
    expect(unarchived.status).toBe(200);
    expect(unarchived.body.data.folder).toBe('INBOX');

    const trashed = await api.delete(`${BASE}/messages/${draft.id}`).set(auth(adminToken));
    expect(trashed.status).toBe(200);
    expect(trashed.body.data.folder).toBe('TRASH');

    const restored = await api.post(`${BASE}/messages/${draft.id}/restore`).set(auth(adminToken)).send({});
    expect(restored.status).toBe(200);
    expect(restored.body.data.folder).toBe('INBOX');

    const retrashed = await api.delete(`${BASE}/messages/${draft.id}`).set(auth(adminToken));
    expect(retrashed.status).toBe(200);

    const purged = await api.post(`${BASE}/messages/${draft.id}/purge`).set(auth(adminToken)).send({});
    expect(purged.status).toBe(200);
    expect(purged.body.data).toEqual({ id: Number(draft.id), deleted: true });

    const gone = await api.get(`${BASE}/messages/${draft.id}`).set(auth(adminToken));
    expect(gone.status).toBe(404);
  });

  it('refuses a restricted classification for an external recipient', async () => {
    const res = await api
      .post(`${BASE}/messages`)
      .set(auth(adminToken))
      .send({
        mailboxId: MAIL_INFO,
        to: 'external.party@example.com',
        subject: `Restricted ${stamp}`,
        body: 'Should not be allowed.',
        classification: 'RESTRICTED',
      });
    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain('cannot be addressed outside the organisation');
  });
});

describe('mail: signatures', () => {
  it('creates a signature and rejects an empty update', async () => {
    const created = await api
      .post(`${BASE}/signatures`)
      .set(auth(adminToken))
      .send({ name: `Sig ${stamp}`, bodyText: 'Kind regards' });
    expect(created.status).toBe(200);
    const signature = created.body.data.signature as Record<string, unknown>;
    createdSignatures.push(Number(signature.id));
    expect(signature.name).toBe(`Sig ${stamp}`);

    const noop = await api.patch(`${BASE}/signatures/${signature.id}`).set(auth(adminToken)).send({});
    expect(noop.status).toBe(400);
    expect(noop.body.error.message).toBe('No supported fields supplied');

    const renamed = await api
      .patch(`${BASE}/signatures/${signature.id}`)
      .set(auth(adminToken))
      .send({ name: `Sig ${stamp} v2` });
    expect(renamed.status).toBe(200);
    expect(renamed.body.data.signature.name).toBe(`Sig ${stamp} v2`);

    const listed = await api.get(`${BASE}/signatures`).set(auth(adminToken));
    expect(listed.status).toBe(200);
    const ids = (listed.body.data.signatures as Array<Record<string, unknown>>).map((s) => Number(s.id));
    expect(ids).toContain(Number(signature.id));

    const deleted = await api.delete(`${BASE}/signatures/${signature.id}`).set(auth(adminToken));
    expect(deleted.status).toBe(200);
    expect(Number(deleted.body.data.id)).toBe(Number(signature.id));
  });

  it('validates signature input', async () => {
    const blank = await api.post(`${BASE}/signatures`).set(auth(adminToken)).send({ name: '   ' });
    expect(blank.status).toBe(400);
    expect(blank.body.error.message).toBe('A signature name is required.');

    const shared = await api
      .post(`${BASE}/signatures`)
      .set(auth(adminToken))
      .send({ name: `Shared ${stamp}`, isShared: true });
    expect(shared.status).toBe(400);
    expect(shared.body.error.message).toBe('A shared signature must be scoped to a mailbox.');
  });
});

describe('mail: distribution lists', () => {
  it('creates, validates and deletes a list', async () => {
    const code = `DL-${stamp}`;
    const address = `dl-${stamp}@hopedesign.jorlentech.com`;
    const created = await api
      .post(`${BASE}/distribution-lists`)
      .set(auth(adminToken))
      .send({ code, name: `List ${stamp}`, address });
    expect(created.status).toBe(200);
    const list = created.body.data.list as Record<string, unknown>;
    createdLists.push(Number(list.id));
    expect(list.code).toBe(code);
    expect(list.address).toBe(address);

    const duplicate = await api
      .post(`${BASE}/distribution-lists`)
      .set(auth(adminToken))
      .send({ code, name: `List ${stamp} again`, address });
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.error.message).toContain('already uses');

    const blankCode = await api
      .post(`${BASE}/distribution-lists`)
      .set(auth(adminToken))
      .send({ code: '  ', name: 'x', address: `other-${stamp}@hopedesign.jorlentech.com` });
    expect(blankCode.status).toBe(400);
    expect(blankCode.body.error.message).toBe('A list code is required.');

    const badAddress = await api
      .post(`${BASE}/distribution-lists`)
      .set(auth(adminToken))
      .send({ code: `BAD-${stamp}`, name: 'x', address: 'not-an-address' });
    expect(badAddress.status).toBe(400);
    expect(badAddress.body.error.message).toBe('A valid list address is required.');

    const listed = await api.get(`${BASE}/distribution-lists`).set(auth(adminToken));
    expect(listed.status).toBe(200);
    const ids = (listed.body.data.lists as Array<Record<string, unknown>>).map((l) => Number(l.id));
    expect(ids).toContain(Number(list.id));

    const removed = await api.delete(`${BASE}/distribution-lists/${list.id}`).set(auth(adminToken));
    expect(removed.status).toBe(200);
  });
});

describe('mail: mailbox delegations', () => {
  it('requires an expiry in the future', async () => {
    const missing = await api
      .post(`${BASE}/mailboxes/${MAIL_INFO}/delegations`)
      .set(auth(adminToken))
      .send({ delegateUserId: adminUserId });
    expect(missing.status).toBe(400);
    expect(missing.body.error.message).toBe('endsAt is required: delegations must expire');

    const past = await api
      .post(`${BASE}/mailboxes/${MAIL_INFO}/delegations`)
      .set(auth(adminToken))
      .send({ delegateUserId: adminUserId, endsAt: new Date(Date.now() - 86_400_000).toISOString() });
    expect(past.status).toBe(400);
    expect(past.body.error.message).toBe('endsAt must be in the future');

    const self = await api
      .post(`${BASE}/mailboxes/${MAIL_INFO}/delegations`)
      .set(auth(adminToken))
      .send({ delegateUserId: adminUserId, endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString() });
    expect(self.status).toBe(400);
    expect(self.body.error.message).toBe('You cannot delegate a mailbox to yourself');
  });

  it('creates and revokes a delegation to another tenant user', async () => {
    const directory = await api.get(`${BASE}/directory/users`).set(auth(adminToken));
    expect(directory.status).toBe(200);
    const target = (directory.body.data as Array<Record<string, unknown>>).find(
      (u) => Number(u.id) !== adminUserId
    );
    if (!target) return; // single-user tenant: nothing to delegate to

    const created = await api
      .post(`${BASE}/mailboxes/${MAIL_INFO}/delegations`)
      .set(auth(adminToken))
      .send({
        delegateUserId: Number(target.id),
        endsAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        permissions: ['canView'],
      });
    expect(created.status).toBe(200);
    const delegationId = Number(created.body.data.id);
    createdDelegations.push(delegationId);
    expect(Number(created.body.data.mailboxId)).toBe(MAIL_INFO);

    const listed = await api.get(`${BASE}/mailboxes/${MAIL_INFO}/delegations`).set(auth(adminToken));
    expect(listed.status).toBe(200);
    const ids = (listed.body.data.delegations as Array<Record<string, unknown>>).map((d) => Number(d.id));
    expect(ids).toContain(delegationId);

    const revoked = await api
      .post(`${BASE}/delegations/${delegationId}/revoke`)
      .set(auth(adminToken))
      .send({});
    expect(revoked.status).toBe(200);

    const again = await api
      .post(`${BASE}/delegations/${delegationId}/revoke`)
      .set(auth(adminToken))
      .send({});
    expect(again.status).toBe(409);
  });
});

describe('mail: mailbox membership', () => {
  it('grants, updates and revokes membership on a mailbox', async () => {
    const badRole = await api
      .post(`${BASE}/mailboxes/${MAIL_INFO}/members`)
      .set(auth(adminToken))
      .send({ userId: lowUserId, memberRole: 'SUPERUSER' });
    expect(badRole.status).toBe(400);
    expect(badRole.body.error.message).toBe('memberRole must be OWNER, MANAGER, MEMBER or READ_ONLY');

    const unknown = await api
      .post(`${BASE}/mailboxes/${MAIL_INFO}/members`)
      .set(auth(adminToken))
      .send({ userId: 9_999_999, memberRole: 'MEMBER' });
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.message).toBe('User not found in this tenant');

    const created = await api
      .post(`${BASE}/mailboxes/${MAIL_INFO}/members`)
      .set(auth(adminToken))
      .send({ userId: lowUserId, memberRole: 'READ_ONLY', canView: true, canSend: false });
    expect(created.status).toBe(200);
    expect(Number(created.body.data.mailboxId)).toBe(MAIL_INFO);
    expect(Number(created.body.data.userId)).toBe(lowUserId);
    expect(created.body.data.memberRole).toBe('READ_ONLY');

    const listed = await api.get(`${BASE}/mailboxes/${MAIL_INFO}/members`).set(auth(adminToken));
    expect(listed.status).toBe(200);
    const members = listed.body.data.members as Array<Record<string, unknown>>;
    const mine = members.find((m) => Number(m.userId) === lowUserId);
    expect(mine).toBeTruthy();
    expect(mine?.memberRole).toBe('READ_ONLY');
    expect(mine?.canView).toBe(true);
    expect(mine?.canSend).toBe(false);

    const empty = await api
      .patch(`${BASE}/mailboxes/${MAIL_INFO}/members/${lowUserId}`)
      .set(auth(adminToken))
      .send({});
    expect(empty.status).toBe(400);
    expect(empty.body.error.message).toBe('No supported fields supplied');

    const updated = await api
      .patch(`${BASE}/mailboxes/${MAIL_INFO}/members/${lowUserId}`)
      .set(auth(adminToken))
      .send({ memberRole: 'MEMBER', canSend: true });
    expect(updated.status).toBe(200);

    const reread = await api.get(`${BASE}/mailboxes/${MAIL_INFO}/members`).set(auth(adminToken));
    const promoted = (reread.body.data.members as Array<Record<string, unknown>>).find(
      (m) => Number(m.userId) === lowUserId
    );
    expect(promoted?.memberRole).toBe('MEMBER');
    expect(promoted?.canSend).toBe(true);

    const removed = await api
      .delete(`${BASE}/mailboxes/${MAIL_INFO}/members/${lowUserId}`)
      .set(auth(adminToken));
    expect(removed.status).toBe(200);
    expect(removed.body.data.removed).toBe(true);

    const gone = await api.delete(`${BASE}/mailboxes/${MAIL_INFO}/members/${lowUserId}`).set(auth(adminToken));
    expect(gone.status).toBe(404);
    expect(gone.body.error.message).toBe('Mailbox member not found');
  });
});

/**
 * Scheduling a message only stores it; the queue flush is what sends it. The
 * flush must not grow a second send path, so these cases assert on where the
 * message itself ends up: a due message leaves through the same pipeline a
 * direct send uses (mailbox authorisation, the author's signature,
 * classification policy), and a message whose author cannot be authorised is
 * parked in the OUTBOX rather than going out unattributed.
 */
describe('mail: queue flush sends due messages', () => {
  const jobState: Record<string, unknown> = {};
  const testStart = new Date();
  let flushJobId = 0;
  let savedApiKey = '';
  let savedFromEmail = '';

  beforeAll(async () => {
    const job = await db(
      `SELECT * FROM cron_jobs
        WHERE job_type = 'EMAIL_QUEUE_FLUSH'
          AND tenant_id = (SELECT tenant_id FROM users WHERE id = $1)
        ORDER BY id
        LIMIT 1`,
      [adminUserId]
    );
    if (job.rows.length === 0) throw new Error('this tenant has no EMAIL_QUEUE_FLUSH cron job');
    const row = job.rows[0] as Record<string, unknown>;
    flushJobId = Number(row.id);
    for (const key of ['enabled', 'next_run_at', 'last_run_at', 'last_status', 'last_error', 'last_run_duration_ms']) {
      jobState[key] = row[key];
    }
    // The in-process scheduler would otherwise fire this job on its own cadence
    // and race the runs below. runCronJobById ignores `enabled`, so each run
    // here is still the real handler doing the real work.
    await db('UPDATE cron_jobs SET enabled = false WHERE id = $1', [flushJobId]);
    savedApiKey = config.resend.apiKey;
    savedFromEmail = config.resend.fromEmail;
  });

  afterAll(async () => {
    config.resend.apiKey = savedApiKey;
    config.resend.fromEmail = savedFromEmail;
    if (!flushJobId) return;
    await db(
      `UPDATE cron_jobs
          SET enabled = $2, next_run_at = $3, last_run_at = $4, last_status = $5,
              last_error = $6, last_run_duration_ms = $7
        WHERE id = $1`,
      [
        flushJobId,
        jobState.enabled,
        jobState.next_run_at,
        jobState.last_run_at,
        jobState.last_status,
        jobState.last_error,
        jobState.last_run_duration_ms,
      ]
    );
    await db('DELETE FROM cron_job_runs WHERE job_id = $1 AND started_at >= $2', [flushJobId, testStart]);
  });

  it('sends a due scheduled message through the send pipeline, and records the provider failure', async () => {
    const created = await api
      .post(`${BASE}/messages`)
      .set(auth(adminToken))
      .send({
        mailboxId: MAIL_INFO,
        to: 'info@hopedesign.jorlentech.com',
        subject: `Flush scheduled ${stamp}`,
        body: 'Composed now, sent by the queue flush.',
        classification: 'INTERNAL',
      });
    expect(created.status).toBe(200);
    const emailId = Number(created.body.data.id);
    createdMessages.push(emailId);
    expect(created.body.data.status).toBe('DRAFT');

    const scheduled = await api
      .post(`${BASE}/messages/${emailId}/schedule`)
      .set(auth(adminToken))
      .send({ scheduledAt: new Date(Date.now() + 60_000).toISOString() });
    expect(scheduled.status).toBe(200);
    expect(scheduled.body.data.status).toBe('SCHEDULED');
    expect(scheduled.body.data.folder).toBe('SCHEDULED');

    // The flush only takes messages whose time has come. Which pipeline the
    // message goes through is what is under test here, not the passing of a
    // minute, so the due time is moved up rather than waited out.
    await db(`UPDATE emails SET scheduled_at = now() - interval '1 minute' WHERE id = $1`, [emailId]);

    // Resend is configured in this environment, and a test must not put mail on
    // the wire. Blanking the credentials for the duration of the run keeps the
    // provider branch deterministic while still proving that a scheduled
    // message reaches the provider at all.
    config.resend.apiKey = '';
    config.resend.fromEmail = '';
    let result: { ok: boolean; error?: string };
    try {
      result = await runCronJobById(flushJobId);
    } finally {
      config.resend.apiKey = savedApiKey;
      config.resend.fromEmail = savedFromEmail;
    }
    expect(result.ok).toBe(true);

    const email = await db('SELECT status, folder, sent_at FROM emails WHERE id = $1', [emailId]);
    expect(email.rows[0].status).toBe('FAILED');
    expect(email.rows[0].folder).toBe('OUTBOX');
    // A message the provider refused has not been sent, and must not say it was.
    expect(email.rows[0].sent_at).toBeNull();

    const recipients = await db('SELECT status, error FROM email_recipients WHERE email_id = $1', [emailId]);
    expect(recipients.rows).toHaveLength(1);
    expect(recipients.rows[0].status).toBe('FAILED');
    expect(String(recipients.rows[0].error)).toContain('Resend');

    const outbox = await db('SELECT attempts, last_error FROM email_outbox WHERE email_id = $1', [emailId]);
    expect(outbox.rows).toHaveLength(1);
    expect(Number(outbox.rows[0].attempts)).toBe(1);
    expect(String(outbox.rows[0].last_error)).toContain('Resend');

    const run = await db('SELECT details FROM cron_job_runs WHERE job_id = $1 ORDER BY id DESC LIMIT 1', [flushJobId]);
    const details = run.rows[0].details as Record<string, unknown>;
    expect(Number(details.checked)).toBeGreaterThanOrEqual(1);
    expect(Number(details.failed)).toBeGreaterThanOrEqual(1);
    expect(Object.keys(details.reasons as Record<string, number>).some((r) => r.includes('Resend'))).toBe(true);
  });

  it('parks a due message that has no author instead of sending it unattributed', async () => {
    const inserted = await db(
      `INSERT INTO emails
         (tenant_id, mailbox_id, subject, body, status, folder, classification, scheduled_at, created_by)
       SELECT u.tenant_id, $1, $2, 'Has no author.', 'SCHEDULED', 'SCHEDULED', 'INTERNAL',
              now() - interval '1 minute', NULL
         FROM users u WHERE u.id = $3
       RETURNING id`,
      [MAIL_INFO, `Flush orphan ${stamp}`, adminUserId]
    );
    const emailId = Number(inserted.rows[0].id);
    createdMessages.push(emailId);
    await db(
      `INSERT INTO email_recipients (tenant_id, email_id, kind, email, status)
       SELECT tenant_id, id, 'TO', 'info@hopedesign.jorlentech.com', 'QUEUED'
         FROM emails WHERE id = $1`,
      [emailId]
    );

    const result = await runCronJobById(flushJobId);
    expect(result.ok).toBe(true);

    const reason = 'This message has no author, so it cannot be sent.';
    const email = await db('SELECT status, folder FROM emails WHERE id = $1', [emailId]);
    expect(email.rows[0].status).toBe('FAILED');
    expect(email.rows[0].folder).toBe('OUTBOX');

    const recipients = await db('SELECT status, error FROM email_recipients WHERE email_id = $1', [emailId]);
    expect(recipients.rows).toHaveLength(1);
    expect(recipients.rows[0].status).toBe('FAILED');
    expect(recipients.rows[0].error).toBe(reason);

    // Parked, not dropped: the message stays visible in the OUTBOX with the
    // reason attached, so somebody can act on it.
    const outbox = await db('SELECT status, attempts, last_error FROM email_outbox WHERE email_id = $1', [emailId]);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].status).toBe('QUEUED');
    expect(Number(outbox.rows[0].attempts)).toBe(1);
    expect(outbox.rows[0].last_error).toBe(reason);

    const run = await db('SELECT details FROM cron_job_runs WHERE job_id = $1 ORDER BY id DESC LIMIT 1', [flushJobId]);
    const details = run.rows[0].details as Record<string, unknown>;
    expect(Number((details.reasons as Record<string, number>)[reason])).toBe(1);
  });
});

/**
 * The gaps these cases close all concern mail the system puts on the wire
 * without a person pressing send: retrying what a provider outage parked,
 * messages the notification helpers raise, the record a message is about, and
 * the wording of the sign-in code. Every assertion is made against stored rows,
 * because a stored row is what an operator can actually see and act on.
 */
describe('mail: outbox drain and system-generated mail', () => {
  const drainState: Record<string, unknown> = {};
  const flushState: Record<string, unknown> = {};
  const testStart = new Date();
  let drainJobId = 0;
  let flushJobId = 0;
  let savedApiKey = '';
  let savedFromEmail = '';
  const createdNotifications: number[] = [];
  const writtenAttachments: string[] = [];

  const snapshot = (row: Record<string, unknown>): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    for (const key of ['enabled', 'next_run_at', 'last_run_at', 'last_status', 'last_error', 'last_run_duration_ms']) {
      out[key] = row[key];
    }
    return out;
  };

  const findJob = async (jobType: string): Promise<Record<string, unknown>> => {
    const res = await db(
      `SELECT * FROM cron_jobs
        WHERE job_type = $1
          AND tenant_id = (SELECT tenant_id FROM users WHERE id = $2)
        ORDER BY id
        LIMIT 1`,
      [jobType, adminUserId]
    );
    if (res.rows.length === 0) throw new Error(`this tenant has no ${jobType} cron job`);
    return res.rows[0] as Record<string, unknown>;
  };

  beforeAll(async () => {
    const drain = await findJob('EMAIL_OUTBOX_DRAIN');
    drainJobId = Number(drain.id);
    Object.assign(drainState, snapshot(drain));
    const flush = await findJob('EMAIL_QUEUE_FLUSH');
    flushJobId = Number(flush.id);
    Object.assign(flushState, snapshot(flush));
    // Both jobs are run explicitly below. The in-process scheduler would
    // otherwise fire them on its own cadence and race those runs;
    // runCronJobById ignores `enabled`, so each run is still the real handler.
    await db('UPDATE cron_jobs SET enabled = false WHERE id = ANY($1::int[])', [[drainJobId, flushJobId]]);
    savedApiKey = config.resend.apiKey;
    savedFromEmail = config.resend.fromEmail;
  });

  afterAll(async () => {
    config.resend.apiKey = savedApiKey;
    config.resend.fromEmail = savedFromEmail;
    for (const file of writtenAttachments) rmSync(file, { force: true });
    if (createdNotifications.length) {
      await db('DELETE FROM notifications WHERE id = ANY($1::int[])', [createdNotifications]);
    }
    for (const job of [{ id: drainJobId, state: drainState }, { id: flushJobId, state: flushState }]) {
      if (!job.id) continue;
      await db(
        `UPDATE cron_jobs
            SET enabled = $2, next_run_at = $3, last_run_at = $4, last_status = $5,
                last_error = $6, last_run_duration_ms = $7
          WHERE id = $1`,
        [
          job.id,
          job.state.enabled,
          job.state.next_run_at,
          job.state.last_run_at,
          job.state.last_status,
          job.state.last_error,
          job.state.last_run_duration_ms,
        ]
      );
      await db('DELETE FROM cron_job_runs WHERE job_id = $1 AND started_at >= $2', [job.id, testStart]);
    }
  });

  /** Run a cron job with the provider blanked, so nothing reaches the wire. */
  const runBlanked = async (jobId: number): Promise<{ ok: boolean; error?: string }> => {
    config.resend.apiKey = '';
    config.resend.fromEmail = '';
    try {
      return await runCronJobById(jobId);
    } finally {
      config.resend.apiKey = savedApiKey;
      config.resend.fromEmail = savedFromEmail;
    }
  };

  /** Seed a message the provider refused, with its retry bookkeeping row. */
  const seedParked = async (subject: string, attempts: number, maxAttempts: number): Promise<number> => {
    const inserted = await db(
      `INSERT INTO emails
         (tenant_id, mailbox_id, subject, body, status, folder, classification, created_by)
       SELECT u.tenant_id, $1, $2, 'The provider refused this once.', 'FAILED', 'OUTBOX', 'INTERNAL', $3
         FROM users u WHERE u.id = $3
       RETURNING id`,
      [MAIL_INFO, subject, adminUserId]
    );
    const emailId = Number(inserted.rows[0].id);
    createdMessages.push(emailId);
    await db(
      `INSERT INTO email_recipients (tenant_id, email_id, kind, email, status)
       SELECT tenant_id, id, 'TO', 'info@hopedesign.jorlentech.com', 'FAILED' FROM emails WHERE id = $1`,
      [emailId]
    );
    await db(
      `INSERT INTO email_outbox (tenant_id, email_id, status, attempts, max_attempts, next_attempt_at)
       SELECT tenant_id, id, 'QUEUED', $2, $3, NULL FROM emails WHERE id = $1`,
      [emailId, attempts, maxAttempts]
    );
    return emailId;
  };

  it('retries a parked message through the send pipeline and spaces the next attempt', async () => {
    const emailId = await seedParked(`Drain retry ${stamp}`, 1, 3);

    const result = await runBlanked(drainJobId);
    expect(result.ok).toBe(true);

    const run = await db('SELECT details FROM cron_job_runs WHERE job_id = $1 ORDER BY id DESC LIMIT 1', [drainJobId]);
    const details = run.rows[0].details as Record<string, unknown>;
    expect(Number(details.checked)).toBeGreaterThanOrEqual(1);
    expect(Number(details.failed)).toBeGreaterThanOrEqual(1);
    expect(Object.keys(details.reasons as Record<string, number>).some((r) => r.includes('Resend'))).toBe(true);

    const outbox = await db(
      'SELECT status, attempts, next_attempt_at, last_error FROM email_outbox WHERE email_id = $1',
      [emailId]
    );
    expect(outbox.rows).toHaveLength(1);
    // Still queued and one attempt further along, but pushed into the future: a
    // provider blip must not turn into a tight retry loop.
    expect(outbox.rows[0].status).toBe('QUEUED');
    expect(Number(outbox.rows[0].attempts)).toBe(2);
    expect(outbox.rows[0].next_attempt_at).not.toBeNull();
    expect(new Date(outbox.rows[0].next_attempt_at as string).getTime()).toBeGreaterThan(Date.now());
    expect(String(outbox.rows[0].last_error)).toContain('Resend');
  });

  it('stops retrying a message that has reached its own attempt cap', async () => {
    const emailId = await seedParked(`Drain exhausted ${stamp}`, 3, 3);

    const result = await runBlanked(drainJobId);
    expect(result.ok).toBe(true);

    const run = await db('SELECT details FROM cron_job_runs WHERE job_id = $1 ORDER BY id DESC LIMIT 1', [drainJobId]);
    const details = run.rows[0].details as Record<string, unknown>;
    expect(Number(details.exhausted)).toBeGreaterThanOrEqual(1);

    const outbox = await db(
      'SELECT status, attempts, next_attempt_at, last_error FROM email_outbox WHERE email_id = $1',
      [emailId]
    );
    expect(outbox.rows).toHaveLength(1);
    // The cap is the drain's boundary, not something it works around: the row is
    // marked and taken out of the retry set rather than retried forever.
    expect(outbox.rows[0].status).toBe('FAILED');
    expect(outbox.rows[0].next_attempt_at).toBeNull();
    expect(outbox.rows[0].last_error).toBe('Delivery attempts exhausted');
    expect(Number(outbox.rows[0].attempts)).toBe(3);
  });

  it('sends a QUEUED message, not only a SCHEDULED one', async () => {
    const inserted = await db(
      `INSERT INTO emails
         (tenant_id, mailbox_id, subject, body, status, folder, classification, scheduled_at, created_by)
       SELECT u.tenant_id, $1, $2, 'Queued, never attempted.', 'QUEUED', 'OUTBOX', 'INTERNAL', NULL, $3
         FROM users u WHERE u.id = $3
       RETURNING id`,
      [MAIL_INFO, `Flush queued ${stamp}`, adminUserId]
    );
    const emailId = Number(inserted.rows[0].id);
    createdMessages.push(emailId);
    await db(
      `INSERT INTO email_recipients (tenant_id, email_id, kind, email, status)
       SELECT tenant_id, id, 'TO', 'info@hopedesign.jorlentech.com', 'QUEUED' FROM emails WHERE id = $1`,
      [emailId]
    );

    const result = await runBlanked(flushJobId);
    expect(result.ok).toBe(true);

    const email = await db('SELECT status, folder FROM emails WHERE id = $1', [emailId]);
    expect(email.rows[0].status).toBe('FAILED');
    expect(email.rows[0].folder).toBe('OUTBOX');

    const outbox = await db('SELECT status, attempts FROM email_outbox WHERE email_id = $1', [emailId]);
    expect(outbox.rows).toHaveLength(1);
    expect(outbox.rows[0].status).toBe('QUEUED');
    expect(Number(outbox.rows[0].attempts)).toBe(1);
  });

  it('routes notifications from the helpers through the same pipeline', async () => {
    const ctx: Ctx = {
      correlationId: 'test',
      ip: null,
      userAgent: null,
      device: null,
      tenantId: 2,
      companyId: 2,
      branchId: 2,
      userId: adminUserId,
    };
    const customerSubject = `Customer notice ${stamp}`;
    const staffSubject = `Staff notice ${stamp}`;
    const staffType = `TEST_NOTIFY_${stamp}`;

    config.resend.apiKey = '';
    config.resend.fromEmail = '';
    try {
      await tx(async (client, c) => {
        const customer = await notifyCustomer(client, c, {
          email: 'customer@example.test',
          title: customerSubject,
          body: 'Your order is ready for collection.',
          channels: ['EMAIL'],
        });
        // Reaching the provider at all is the point: it means the customer mail
        // was stored, signed and classified instead of handed straight out.
        expect(customer.email?.ok).toBe(false);
        expect(String(customer.email?.error)).toContain('Resend');

        const staff = await notifyUserAdvanced(client, c, lowUserId, {
          type: staffType,
          title: staffSubject,
          body: 'A record needs your attention.',
          channels: ['EMAIL'],
          entityType: 'employee-identities',
          entityId: 291,
        });
        expect(staff.length).toBeGreaterThanOrEqual(1);
        createdNotifications.push(...staff);
      }, ctx);
    } finally {
      config.resend.apiKey = savedApiKey;
      config.resend.fromEmail = savedFromEmail;
    }

    const customerEmail = await db('SELECT id, classification, created_by FROM emails WHERE subject = $1', [
      customerSubject,
    ]);
    expect(customerEmail.rows).toHaveLength(1);
    const customerId = Number(customerEmail.rows[0].id);
    createdMessages.push(customerId);
    expect(customerEmail.rows[0].classification).toBe('PUBLIC');
    expect(Number(customerEmail.rows[0].created_by)).toBe(adminUserId);
    const customerTo = await db('SELECT status FROM email_recipients WHERE email_id = $1', [customerId]);
    expect(customerTo.rows).toHaveLength(1);
    expect(customerTo.rows[0].status).toBe('FAILED');
    const customerOutbox = await db('SELECT status FROM email_outbox WHERE email_id = $1', [customerId]);
    expect(customerOutbox.rows).toHaveLength(1);

    const staffEmail = await db(
      'SELECT id, classification, created_by, entity_type, entity_id FROM emails WHERE subject = $1',
      [staffSubject]
    );
    expect(staffEmail.rows).toHaveLength(1);
    const staffId = Number(staffEmail.rows[0].id);
    createdMessages.push(staffId);
    expect(staffEmail.rows[0].classification).toBe('INTERNAL');
    expect(Number(staffEmail.rows[0].created_by)).toBe(lowUserId);
    // The notification carries the record it is about, which is what gives the
    // attachment step a document to look up.
    expect(staffEmail.rows[0].entity_type).toBe('employee-identities');
    expect(Number(staffEmail.rows[0].entity_id)).toBe(291);

    // A delivery left QUEUED would be picked up by the delivery worker and send
    // a second copy of a message that has already been through the pipeline.
    const open = await db(
      `SELECT count(*)::int AS n FROM notification_deliveries
        WHERE notification_id = ANY($1::int[]) AND channel = 'EMAIL' AND status = 'QUEUED'`,
      [createdNotifications]
    );
    expect(Number(open.rows[0].n)).toBe(0);
  });

  it('renders the seeded sign-in code template with every variable it uses', async () => {
    const tpl = await db(
      `SELECT subject, body FROM email_templates
        WHERE code = 'SECURITY_CODE' AND is_active = true
          AND tenant_id = (SELECT tenant_id FROM users WHERE id = $1)
        ORDER BY id
        LIMIT 1`,
      [adminUserId]
    );
    expect(tpl.rows).toHaveLength(1);
    const row = tpl.rows[0] as Record<string, unknown>;

    const values: Record<string, string> = {
      RECIPIENT_NAME: 'Lulenzi',
      CODE: 'VNWE34KV',
      PURPOSE: 'sign in to HOPE DESIGN',
      TTL_MINUTES: '10',
      COMPANY_NAME: 'HOPE DESIGN GROUP LTD',
    };

    // The template is only adopted if the live renderer can fill it, so every
    // placeholder it uses has to be one the caller actually supplies.
    const used = new Set<string>();
    for (const text of [String(row.subject), String(row.body)]) {
      for (const match of text.matchAll(/\{\{(\w+)\}\}/g)) used.add(match[1]);
    }
    expect(used.size).toBeGreaterThan(0);
    for (const key of used) expect(Object.keys(values)).toContain(key);

    const rendered = renderTemplate(String(row.subject), String(row.body), values);
    expect(rendered.subject).not.toMatch(/\{\{\w+\}\}/);
    expect(rendered.body).not.toMatch(/\{\{\w+\}\}/);
    expect(rendered.body).toContain('VNWE34KV');
  });

  it('maps module entity types onto the documents this system can render', () => {
    expect(resolveDocumentType('customer-invoices')).toBe('sales-invoice');
    expect(resolveDocumentType('employee-identities')).toBe('employee-id');
    expect(resolveDocumentType('purchase-orders')).toBe('purchase-order');
    // A record with no document behind it must resolve to nothing rather than be
    // handed a key the attachment step would trip over.
    expect(resolveDocumentType('not-a-document')).toBeNull();
    expect(resolveDocumentType(null)).toBeNull();
  });

  it('attaches the record a message is about as a PDF', async () => {
    const employee = await db(
      `SELECT id FROM employees WHERE tenant_id = 2 AND company_id = 2 ORDER BY id LIMIT 1`
    );
    expect(employee.rows).toHaveLength(1);
    const employeeId = Number(employee.rows[0].id);

    const subject = `Document attach ${stamp}`;
    const ctx: Ctx = {
      correlationId: 'test',
      ip: null,
      userAgent: null,
      device: null,
      tenantId: 2,
      companyId: 2,
      branchId: 2,
      userId: adminUserId,
    };

    config.resend.apiKey = '';
    config.resend.fromEmail = '';
    let emailId = 0;
    try {
      await tx(async (client, c) => {
        const res = await insertOutboundEmail(client, c, {
          to: ['info@hopedesign.jorlentech.com'],
          subject,
          body: 'The document you asked for is attached.',
          classification: 'INTERNAL',
          createdBy: adminUserId,
          entityType: 'employee-identities',
          entityId: employeeId,
        });
        expect(res.emailId).toBeTruthy();
        emailId = Number(res.emailId);
      }, ctx);
    } finally {
      config.resend.apiKey = savedApiKey;
      config.resend.fromEmail = savedFromEmail;
    }
    createdMessages.push(emailId);

    const attached = await db(
      `SELECT file_name, file_size, storage_path FROM email_attachments
        WHERE email_id = $1 AND source = 'ERP_DOCUMENT'`,
      [emailId]
    );
    expect(attached.rows).toHaveLength(1);
    const row = attached.rows[0] as Record<string, unknown>;
    expect(String(row.file_name).toLowerCase()).toMatch(/\.pdf$/);
    expect(Number(row.file_size)).toBeGreaterThan(0);

    const abs = path.join(config.storageRoot, String(row.storage_path));
    writtenAttachments.push(abs);
    expect(existsSync(abs)).toBe(true);
    expect(statSync(abs).size).toBeGreaterThan(0);
    // The bytes have to be a real PDF, not an empty placeholder: the whole point
    // of attaching the record is that the recipient can open it.
    expect(readFileSync(abs).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});

/**
 * The daily attendance summary runs unattended: it renders the Kampala workday
 * as a branded PDF and mails it to HR, the Operations Manager and the Managing
 * Director. There is no request to derive the tenant from and no signed-in user
 * behind it, so the two things worth pinning down are that the recipients come
 * out of role assignments without duplicates, and that a real PDF reaches the
 * send pipeline instead of being quietly dropped.
 */
describe('cron: daily attendance summary email', () => {
  const summaryStart = new Date();
  const createdEmails: number[] = [];
  let jobId = 0;
  let savedApiKey = '';
  let savedFromEmail = '';

  /** How the seeded roles resolve: raw assignments versus distinct inboxes. */
  const roleInboxes = async (): Promise<{ assignments: number; distinct: number }> => {
    const res = await db(
      `SELECT count(*)::int AS assignments, count(DISTINCT lower(u.email))::int AS distinct_emails
         FROM user_roles ur
         JOIN roles r ON r.id = ur.role_id
         JOIN users u ON u.id = ur.user_id
        WHERE r.tenant_id = (SELECT tenant_id FROM users WHERE id = $1)
          AND r.code IN ('hr_manager','operations_manager','managing_director')
          AND (ur.company_id IS NULL OR ur.company_id = (SELECT company_id FROM users WHERE id = $1))
          AND u.status = 'ACTIVE' AND u.email IS NOT NULL AND u.email <> ''`,
      [adminUserId]
    );
    const row = res.rows[0] as Record<string, unknown>;
    return { assignments: Number(row.assignments), distinct: Number(row.distinct_emails) };
  };

  beforeAll(async () => {
    const created = await db(
      `INSERT INTO cron_jobs
         (tenant_id, company_id, branch_id, code, name, description, job_type, schedule_type,
          run_time, day_of_week, day_of_month, interval_minutes, params, enabled, timezone, next_run_at)
       SELECT tenant_id, company_id, NULL::bigint, $2, 'Attendance summary (test)',
              'Temporary row created by the test suite.', 'ATTENDANCE_SUMMARY_EMAIL', 'DAILY',
              '16:30', NULL, NULL, NULL, $3::jsonb, false, 'Africa/Kampala', now()
         FROM users WHERE id = $1
       RETURNING id`,
      [
        adminUserId,
        `CRON-ATTENDANCE-TEST-${stamp}`,
        JSON.stringify({ notify_roles: ['hr_manager', 'operations_manager', 'managing_director'] }),
      ]
    );
    jobId = Number((created.rows[0] as Record<string, unknown>).id);
    savedApiKey = config.resend.apiKey;
    savedFromEmail = config.resend.fromEmail;
  });

  afterAll(async () => {
    config.resend.apiKey = savedApiKey;
    config.resend.fromEmail = savedFromEmail;
    if (createdEmails.length) {
      await db('DELETE FROM email_outbox WHERE email_id = ANY($1::int[])', [createdEmails]);
      await db('DELETE FROM email_recipients WHERE email_id = ANY($1::int[])', [createdEmails]);
      await db('DELETE FROM emails WHERE id = ANY($1::int[])', [createdEmails]);
    }
    if (jobId) {
      await db('DELETE FROM cron_job_runs WHERE job_id = $1 AND started_at >= $2', [jobId, summaryStart]);
      await db('DELETE FROM cron_jobs WHERE id = $1', [jobId]);
    }
  });

  it('sends the day as a PDF to each role inbox once, through the send pipeline', async (testCtx) => {
    const roleInfo = await roleInboxes();
    // A database with none of the three roles seeded cannot exercise this job.
    // Both this local install and production have at least hr_manager, and the
    // collapse of two roles onto one inbox is covered by the unit test after
    // this block, which does not depend on who happens to be seeded.
    if (roleInfo.distinct === 0) {
      testCtx.skip();
      return;
    }

    // The provider is blanked for the run, exactly as the other cron cases here
    // do: a test must not put mail on the wire.
    config.resend.apiKey = '';
    config.resend.fromEmail = '';
    let result: { ok: boolean; error?: string };
    try {
      result = await runCronJobById(jobId);
    } finally {
      config.resend.apiKey = savedApiKey;
      config.resend.fromEmail = savedFromEmail;
    }
    // An attachment the mail layer rejects throws out of the handler and fails
    // the run, so a clean run is itself proof that the report rendered.
    expect(result.ok).toBe(true);

    const run = await db('SELECT details FROM cron_job_runs WHERE job_id = $1 ORDER BY id DESC LIMIT 1', [jobId]);
    const details = run.rows[0].details as Record<string, unknown>;
    expect(String(details.day)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Number(details.pdfBytes)).toBeGreaterThan(1000);
    expect(Number(details.recipients)).toBe(roleInfo.distinct);

    const emailId = Number(details.emailId);
    expect(emailId).toBeGreaterThan(0);
    createdEmails.push(emailId);

    const email = await db('SELECT subject, classification FROM emails WHERE id = $1', [emailId]);
    expect(email.rows).toHaveLength(1);
    const mail = email.rows[0] as Record<string, unknown>;
    // The date rides in the subject so a day with no captures is visible in the
    // inbox rather than hidden behind an identical line every evening.
    expect(String(mail.subject)).toMatch(/^Attendance Summary - .+\d{4}$/);
    expect(String(mail.classification)).toBe('INTERNAL');

    const recipients = await db(
      'SELECT DISTINCT lower(email) AS email FROM email_recipients WHERE email_id = $1',
      [emailId]
    );
    expect(recipients.rows).toHaveLength(roleInfo.distinct);
    for (const row of recipients.rows as Array<Record<string, unknown>>) {
      expect(String(row.email)).toContain('@');
    }

    // The provider was blanked, so the message has to be parked for the outbox
    // drain rather than lost - the same path a provider outage takes.
    const outbox = await db('SELECT status FROM email_outbox WHERE email_id = $1', [emailId]);
    expect(outbox.rows).toHaveLength(1);
  });
});

/**
 * The collapse that stops one person being mailed twice when they hold two of
 * the roles. Kept separate from the run above because it is the part of the job
 * that depends on the shape of the audience rather than on database contents.
 */
describe('cron: attendance summary recipient collapse', () => {
  it('keeps one address when one person holds two of the roles', () => {
    const collapsed = dedupeEmails([
      { email: 'hr@example.com' },
      { email: 'md@example.com' },
      { email: 'md@example.com' },
    ]);
    expect(collapsed).toEqual(['hr@example.com', 'md@example.com']);
  });

  it('treats addresses that differ only in case as the same mailbox', () => {
    expect(dedupeEmails([{ email: 'MD@Example.com' }, { email: 'md@example.com' }])).toEqual(['MD@Example.com']);
  });

  it('trims, keeps the first spelling, and skips rows with no address', () => {
    expect(dedupeEmails([{ email: '  a@b.com  ' }, { email: null }, { email: '   ' }])).toEqual(['a@b.com']);
  });
});