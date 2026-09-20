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
