/**
 * Company mail - mailbox directory.
 *
 * A mailbox is the address mail is sent from and delivered to: a person's own
 * mailbox, a department queue, or a shared address such as info@. The list is
 * filtered by Postgres (`?kind=`) and the endpoint returns the whole matching
 * set, so the counts below are the real directory totals rather than a page.
 *
 * Creation is gated on `communication.mailboxes.create`. The address and code
 * are validated by the backend (uniqueness and e-mail shape), and its message is
 * surfaced verbatim rather than guessed at here.
 */
import { useState } from 'react';
import { can, useAuth } from '../../auth';
import { ErrorBanner, Modal, PageLoader } from '../../components/ui';
import { toast } from '../../components/toast';
import { createMailbox } from './mailApi';
import { useMailboxes, useMailClassifications } from './useMail';
import {
  EmptyRow,
  KpiRow,
  KpiTile,
  MailHead,
  MailTabs,
  Nothing,
  RefreshBtn,
  SecCard,
  countText,
  modStyle,
  s,
} from './mailShared';
import { ToneBadge } from './mailBits';
import type { MailboxView } from './mail.types';

const KINDS = ['INDIVIDUAL', 'DEPARTMENT', 'SHARED', 'SYSTEM', 'DISTRIBUTION'];

interface FormState {
  code: string;
  address: string;
  displayName: string;
  kind: string;
  defaultClassification: string;
  description: string;
  allowExternalSend: boolean;
  requireApproval: boolean;
}

const EMPTY_FORM: FormState = {
  code: '',
  address: '',
  displayName: '',
  kind: 'SHARED',
  defaultClassification: 'INTERNAL',
  description: '',
  allowExternalSend: true,
  requireApproval: false,
};

function kindTone(kind: unknown): 'badge-blue' | 'badge-teal' | 'badge-purple' | 'badge-neutral' {
  const key = s(kind).toUpperCase();
  if (key === 'DEPARTMENT') return 'badge-blue';
  if (key === 'SHARED') return 'badge-teal';
  if (key === 'DISTRIBUTION') return 'badge-purple';
  return 'badge-neutral';
}

export default function MailMailboxes() {
  const { user } = useAuth();
  const [kind, setKind] = useState<string>('');
  const [open, setOpen] = useState<boolean>(false);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [saving, setSaving] = useState<boolean>(false);

  const list = useMailboxes(kind || undefined);
  const classes = useMailClassifications();

  const canCreate = can(user, 'communication.mailboxes.create');
  const rows = list.data ?? [];
  const approvalCount = rows.filter((box) => box.requireApproval).length;
  const internalOnly = rows.filter((box) => !box.allowExternalSend).length;

  function field<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function submit() {
    if (saving) return;
    if (!form.code.trim() || !form.address.trim() || !form.displayName.trim()) {
      toast.warning('Code, address and display name are all required');
      return;
    }
    setSaving(true);
    try {
      await createMailbox({
        code: form.code.trim(),
        address: form.address.trim(),
        displayName: form.displayName.trim(),
        kind: form.kind,
        defaultClassification: form.defaultClassification,
        description: form.description.trim() || undefined,
        allowExternalSend: form.allowExternalSend,
        requireApproval: form.requireApproval,
      });
      setOpen(false);
      setForm(EMPTY_FORM);
      list.refresh();
      toast.success('Mailbox created');
    } catch (e) {
      toast.fromError('Could not create the mailbox', e);
    } finally {
      setSaving(false);
    }
  }

  if (list.loading && !list.data) return <PageLoader label="Loading mailboxes" />;

  return (
    <div className="page" style={modStyle()}>
      <MailHead
        kicker="Company mail"
        title="Mailboxes"
        sub="Every address the company sends from. Open a mailbox to manage its members, delegations and labels."
        actions={<RefreshBtn onClick={list.refresh} disabled={list.loading} />}
      />
      <MailTabs active="mailboxes" />

      <ErrorBanner error={list.error} />

      <KpiRow>
        <KpiTile label="Mailboxes" value={countText(rows.length)} sub={kind ? kind.toLowerCase() : 'all kinds'} />
        <KpiTile
          label="Approval required"
          value={countText(approvalCount)}
          sub="queues with a gate"
          accent="#B45309"
          tint="rgba(180, 83, 9, 0.12)"
        />
        <KpiTile
          label="Internal only"
          value={countText(internalOnly)}
          sub="external send turned off"
          accent="#64748B"
          tint="rgba(100, 116, 139, 0.12)"
        />
      </KpiRow>

      <div className="filter-bar">
        <label className="field" style={{ margin: 0 }}>
          <span>Kind</span>
          <select className="hk-select" value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All kinds</option>
            {KINDS.map((option) => (
              <option key={option} value={option}>{option}</option>
            ))}
          </select>
        </label>
        {canCreate ? (
          <button type="button" className="btn btn-primary" onClick={() => setOpen(true)}>
            New mailbox
          </button>
        ) : null}
      </div>

      <SecCard title="Directory" sub="Addresses you can see. Rows you cannot read are not returned at all.">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Mailbox</th>
                <th scope="col">Address</th>
                <th scope="col">Kind</th>
                <th scope="col">Classification</th>
                <th scope="col">Controls</th>
                <th scope="col">Your access</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <EmptyRow cols={6}>
                  <Nothing
                    text={
                      list.loading
                        ? 'Loading mailboxes\u2026'
                        : kind
                          ? 'No mailboxes of kind ' + kind + '.'
                          : 'No mailboxes have been created yet.'
                    }
                    action={kind && !list.loading ? 'Clear filter' : undefined}
                    onAction={kind && !list.loading ? () => setKind('') : undefined}
                  />
                </EmptyRow>
              ) : (
                rows.map((box: MailboxView) => (
                  <tr key={box.id}>
                    <td>
                      <a className="cell-main" href={'#/communication/mail/mailboxes/' + box.id}>
                        {s(box.displayName) || s(box.code)}
                      </a>
                      <div className="cell-sub">{s(box.code)}</div>
                      {s(box.description) ? (
                        <div className="cell-sub">{s(box.description)}</div>
                      ) : null}
                    </td>
                    <td>
                      <div className="cell-main">{s(box.address)}</div>
                      {box.isActive ? null : <div className="cell-sub">Inactive</div>}
                    </td>
                    <td>
                      <ToneBadge tone={kindTone(box.kind)} label={s(box.kind) || 'Mailbox'} />
                    </td>
                    <td>
                      <div className="cell-main">{s(box.defaultClassification) || '\u2014'}</div>
                      {s(box.defaultSenderName) ? (
                        <div className="cell-sub">{'Sender ' + s(box.defaultSenderName)}</div>
                      ) : null}
                    </td>
                    <td>
                      <div className="cell-sub">
                        {box.allowExternalSend ? 'External send allowed' : 'Internal recipients only'}
                      </div>
                      <div className="cell-sub">
                        {box.requireApproval ? 'Approval required to send' : 'No approval gate'}
                      </div>
                    </td>
                    <td>
                      <div className="cell-main">{s(box.memberRole) || (box.globalAdmin ? 'Administrator' : '\u2014')}</div>
                      <div className="cell-sub">
                        {box.viaDelegation
                          ? 'Via delegation' + (s(box.onBehalfOfName) ? ' for ' + s(box.onBehalfOfName) : '')
                          : permissionSummary(box)}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </SecCard>

      {open ? (
        <Modal
          title="New mailbox"
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" onClick={() => void submit()} disabled={saving}>
                {saving ? 'Creating\u2026' : 'Create mailbox'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-sec">
              <label className="field">
                <span>Code</span>
                <input
                  className="hk-input"
                  value={form.code}
                  onChange={(e) => field('code', e.target.value)}
                  placeholder="INFO"
                />
                <span className="field-hint">Short unique identifier used across the ERP.</span>
              </label>
              <label className="field">
                <span>Address</span>
                <input
                  className="hk-input"
                  value={form.address}
                  onChange={(e) => field('address', e.target.value)}
                  placeholder="info@hopedesign.co"
                />
              </label>
              <label className="field">
                <span>Display name</span>
                <input
                  className="hk-input"
                  value={form.displayName}
                  onChange={(e) => field('displayName', e.target.value)}
                  placeholder="HOPE Design - Information"
                />
              </label>
            </div>
            <div className="form-sec">
              <label className="field">
                <span>Kind</span>
                <select
                  className="hk-select"
                  value={form.kind}
                  onChange={(e) => field('kind', e.target.value)}
                >
                  {KINDS.map((option) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Default classification</span>
                <select
                  className="hk-select"
                  value={form.defaultClassification}
                  onChange={(e) => field('defaultClassification', e.target.value)}
                >
                  {s(form.defaultClassification) ? null : <option value="">Select\u2026</option>}
                  {(classes.data ?? []).map((level) => (
                    <option key={String(level.id)} value={s(level.code)}>
                      {s(level.label) || s(level.code)}
                    </option>
                  ))}
                </select>
                <span className="field-hint">Applied to new messages unless overridden.</span>
              </label>
              <label className="field">
                <span>Description</span>
                <input
                  className="hk-input"
                  value={form.description}
                  onChange={(e) => field('description', e.target.value)}
                  placeholder="What this mailbox is for"
                />
              </label>
            </div>
          </div>
          <div className="stack-row" style={{ gap: 18, flexWrap: 'wrap' }}>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={form.allowExternalSend}
                onChange={(e) => field('allowExternalSend', e.target.checked)}
              />
              <span>Allow sending to external recipients</span>
            </label>
            <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={form.requireApproval}
                onChange={(e) => field('requireApproval', e.target.checked)}
              />
              <span>Require approval before sending</span>
            </label>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}

/** Summarise the permission flags the API returned; never assume a grant. */
function permissionSummary(box: MailboxView): string {
  const perms = box.permissions;
  if (!perms) return '\u2014';
  const granted: string[] = [];
  if (perms.canSend) granted.push('send');
  if (perms.canReply) granted.push('reply');
  if (perms.canDelete) granted.push('delete');
  if (perms.canArchive) granted.push('archive');
  if (perms.canDelegate) granted.push('delegate');
  if (perms.canExport) granted.push('export');
  if (perms.canAdmin) granted.push('admin');
  return granted.length ? granted.join(', ') : 'read only';
}
