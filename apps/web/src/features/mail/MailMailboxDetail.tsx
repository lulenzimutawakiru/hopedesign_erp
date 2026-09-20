/**
 * Company mail - one mailbox in full: members, delegations and labels.
 *
 * Authorisation is decided by the backend and read from the mailbox projection
 * (`permissions.canAdmin` / `globalAdmin`), never inferred from the route. Every
 * control below is therefore gated twice: the mailbox must grant administration
 * and the signed-in user must hold the matching ERP permission. A control the
 * user cannot use is disabled rather than hidden, so the screen still shows what
 * is possible on this mailbox.
 *
 * Two rules come straight from the API and are enforced before the round-trip:
 * a delegation must expire (`endsAt` required, in the future, after `startsAt`)
 * and nobody may delegate a mailbox to themselves - the current user is filtered
 * out of the delegate picker. System / tenant-wide labels need mail
 * administration, so those options stay disabled without it.
 *
 * Nothing here is invented: member rights are echoed from the flags Postgres
 * returned, and a mailbox whose projection has not loaded yet shows the loader
 * rather than a guessed empty state.
 */
import { useEffect, useState } from 'react';
import { can, useAuth } from '../../auth';
import { navigate } from '../../router';
import { ErrorBanner, PageLoader } from '../../components/ui';
import { toast } from '../../components/toast';
import {
  addMember,
  createDelegation,
  createLabel,
  deleteLabel,
  removeMember,
  revokeDelegation,
  searchDirectoryUsers,
  updateLabel,
  updateMember,
} from './mailApi';
import type { DirectoryUser } from './mailApi';
import {
  useDebounced,
  useMailDelegations,
  useMailLabels,
  useMailMembers,
  useMailbox,
} from './useMail';
import {
  EmptyRow,
  KpiRow,
  KpiTile,
  MailHead,
  MailTabs,
  Nothing,
  RefreshBtn,
  SecCard,
  bool,
  countText,
  initials,
  modStyle,
  num,
  s,
  truncate,
  whenText,
} from './mailShared';
import { ToneBadge } from './mailBits';
import type { DeliveryTone } from './mailDelivery';
import type { MailboxDelegation, MailboxMember, Rec } from './mail.types';

const MEMBER_ROLES = ['OWNER', 'MANAGER', 'MEMBER', 'READ_ONLY'];
const LABEL_KINDS = ['USER', 'SYSTEM', 'CLASSIFICATION'];
const LABEL_COLORS = ['slate', 'blue', 'green', 'amber', 'red', 'purple', 'teal', 'pink'];

/**
 * Flags mirror the chosen role so a member cannot be created with a role that
 * grants more than the flags on the same row suggest. `canView` is always on -
 * a member who cannot view the mailbox is not a member.
 */
const ROLE_FLAGS: Record<string, Omit<Rec, never>> = {
  OWNER: {
    canSend: true,
    canReply: true,
    canDelete: true,
    canArchive: true,
    canDelegate: true,
    canExport: true,
    canAdmin: true,
  },
  MANAGER: {
    canSend: true,
    canReply: true,
    canDelete: true,
    canArchive: true,
    canDelegate: true,
    canExport: true,
    canAdmin: false,
  },
  MEMBER: {
    canSend: true,
    canReply: true,
    canDelete: false,
    canArchive: true,
    canDelegate: false,
    canExport: false,
    canAdmin: false,
  },
  READ_ONLY: {
    canSend: false,
    canReply: false,
    canDelete: false,
    canArchive: false,
    canDelegate: false,
    canExport: false,
    canAdmin: false,
  },
};

const FLAG_LABELS: Array<[string, string]> = [
  ['canView', 'view'],
  ['canSend', 'send'],
  ['canReply', 'reply'],
  ['canDelete', 'delete'],
  ['canArchive', 'archive'],
  ['canDelegate', 'delegate'],
  ['canExport', 'export'],
  ['canAdmin', 'admin'],
];

function roleTone(role: unknown): DeliveryTone {
  const key = s(role).toUpperCase();
  if (key === 'OWNER') return 'badge-purple';
  if (key === 'MANAGER') return 'badge-blue';
  if (key === 'READ_ONLY') return 'badge-neutral';
  return 'badge-green';
}

function delegationTone(status: unknown): DeliveryTone {
  const key = s(status).toUpperCase();
  if (key === 'ACTIVE') return 'badge-green';
  if (key === 'EXPIRED') return 'badge-amber';
  if (key === 'REVOKED') return 'badge-neutral';
  return 'badge-blue';
}

/** Echo the stored flags; a member row whose flags were not returned reads as unknown. */
function memberRights(member: MailboxMember): string {
  const row = member as unknown as Rec;
  const granted: string[] = [];
  let seen = false;
  for (const [key, text] of FLAG_LABELS) {
    const value = row[key];
    if (value === undefined || value === null) continue;
    seen = true;
    if (bool(value)) granted.push(text);
  }
  if (!seen) return '\u2014';
  return granted.length ? granted.join(', ') : 'none';
}

function personName(row: Rec): string {
  const full = [s(row.firstName), s(row.lastName)].filter(Boolean).join(' ');
  return full || s(row.username) || s(row.email) || 'User ' + String(num(row.userId));
}

function delegateName(row: MailboxDelegation): string {
  const full = [s(row.delegateFirstName), s(row.delegateLastName)].filter(Boolean).join(' ');
  return full || s(row.delegateEmail) || 'User ' + String(num(row.delegateUserId));
}

/** Picker label for a directory row - the identity lookup returns no display name. */
function directoryLabel(person: DirectoryUser): string {
  const full = [s(person.firstName), s(person.lastName)].filter(Boolean).join(' ');
  return full || s(person.username) || s(person.email) || 'User ' + String(num(person.id));
}

/** Trailing-debounced directory lookup backing both people pickers on this page. */
function useDirectorySearch(term: string): DirectoryUser[] {
  const debounced = useDebounced(term, 300);
  const [rows, setRows] = useState<DirectoryUser[]>([]);
  useEffect(() => {
    const q = debounced.trim();
    if (q.length < 2) {
      setRows([]);
      return;
    }
    let dead = false;
    searchDirectoryUsers(q)
      .then((found) => {
        if (!dead) setRows(found);
      })
      .catch(() => {
        if (!dead) setRows([]);
      });
    return () => {
      dead = true;
    };
  }, [debounced]);
  return rows;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `datetime-local` needs a local wall-clock string, the API needs an instant. */
function toLocalInput(date: Date): string {
  return (
    date.getFullYear() +
    '-' +
    pad(date.getMonth() + 1) +
    '-' +
    pad(date.getDate()) +
    'T' +
    pad(date.getHours()) +
    ':' +
    pad(date.getMinutes())
  );
}

function localInputToIso(value: string): string | null {
  const text = value.trim();
  if (!text) return null;
  const parsed = new Date(text);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export default function MailMailboxDetail({ id }: { id: number }) {
  const { user } = useAuth();

  const box = useMailbox(id);
  const members = useMailMembers(id);
  const delegations = useMailDelegations(id);
  const labels = useMailLabels(id);

  const [busy, setBusy] = useState<string>('');

  // Member picker.
  const [memberTerm, setMemberTerm] = useState<string>('');
  const [memberPick, setMemberPick] = useState<string>('');
  const [memberRole, setMemberRole] = useState<string>('MEMBER');
  const memberOptions = useDirectorySearch(memberTerm);

  // Per-member role draft, keyed by user id; only a changed row offers Save.
  const [roleDraft, setRoleDraft] = useState<Record<number, string>>({});

  // Delegation form.
  const [delegateTerm, setDelegateTerm] = useState<string>('');
  const [delegatePick, setDelegatePick] = useState<string>('');
  const [delegateFrom, setDelegateFrom] = useState<string>('');
  const [delegateTo, setDelegateTo] = useState<string>(() =>
    toLocalInput(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000))
  );
  const [delegateOnBehalf, setDelegateOnBehalf] = useState<boolean>(true);
  const [delegateReason, setDelegateReason] = useState<string>('');
  const delegateOptions = useDirectorySearch(delegateTerm);

  // Label form and inline rename.
  const [labelName, setLabelName] = useState<string>('');
  const [labelColor, setLabelColor] = useState<string>('slate');
  const [labelKind, setLabelKind] = useState<string>('USER');
  const [labelTenantWide, setLabelTenantWide] = useState<boolean>(false);
  const [editLabel, setEditLabel] = useState<number>(0);
  const [editName, setEditName] = useState<string>('');
  const [editColor, setEditColor] = useState<string>('slate');

  const view = box.data;
  const mailboxAdmin = bool(view?.permissions?.canAdmin) || bool(view?.globalAdmin);
  const mailAdmin = can(user, 'communication.mail_admin.manage');

  const memberRows = members.data ?? [];
  const delegationRows = delegations.data ?? [];
  const labelRows = labels.data ?? [];
  const activeMembers = memberRows.filter((row) => row.isActive !== false).length;
  const liveDelegations = delegationRows.filter((row) => s(row.status).toUpperCase() === 'ACTIVE').length;
  const selfId = num(user?.id);

  function refreshAll() {
    box.refresh();
    members.refresh();
    delegations.refresh();
    labels.refresh();
  }

  async function guard(key: string, work: () => Promise<void>, done: string) {
    if (busy) return;
    setBusy(key);
    try {
      await work();
      toast.success(done);
    } catch (e) {
      toast.fromError('Could not save the change', e);
    } finally {
      setBusy('');
    }
  }

  async function submitMember() {
    const userId = num(memberPick);
    if (!userId) {
      toast.warning('Search the directory and pick a person first');
      return;
    }
    await guard(
      'member:add',
      async () => {
        await addMember(id, {
          userId,
          memberRole,
          canView: true,
          ...(ROLE_FLAGS[memberRole] ?? ROLE_FLAGS.MEMBER),
        });
        setMemberTerm('');
        setMemberPick('');
        setMemberRole('MEMBER');
        members.refresh();
      },
      'Member added to the mailbox'
    );
  }

  async function saveMemberRole(member: MailboxMember) {
    const next = roleDraft[member.userId] ?? s(member.memberRole);
    await guard(
      'member:' + member.userId,
      async () => {
        await updateMember(id, member.userId, {
          memberRole: next,
          canView: true,
          ...(ROLE_FLAGS[next] ?? ROLE_FLAGS.MEMBER),
        });
        setRoleDraft((prev) => {
          const copy = { ...prev };
          delete copy[member.userId];
          return copy;
        });
        members.refresh();
      },
      'Member role updated'
    );
  }

  async function toggleMember(member: MailboxMember) {
    const next = !(member.isActive !== false);
    await guard(
      'member:' + member.userId,
      async () => {
        await updateMember(id, member.userId, { isActive: next });
        members.refresh();
      },
      next ? 'Member re-enabled' : 'Member disabled'
    );
  }

  async function dropMember(member: MailboxMember) {
    const who = personName(member as unknown as Rec);
    if (!window.confirm('Remove ' + who + ' from this mailbox?')) return;
    await guard(
      'member:' + member.userId,
      async () => {
        await removeMember(id, member.userId);
        members.refresh();
      },
      who + ' removed from the mailbox'
    );
  }

  async function submitDelegation() {
    const delegateUserId = num(delegatePick);
    if (!delegateUserId) {
      toast.warning('Pick the person receiving the delegation');
      return;
    }
    const endsAt = localInputToIso(delegateTo);
    if (!endsAt) {
      toast.warning('endsAt is required: delegations must expire');
      return;
    }
    if (new Date(endsAt).getTime() <= Date.now()) {
      toast.warning('endsAt must be in the future');
      return;
    }
    const startsAt = localInputToIso(delegateFrom);
    if (startsAt && new Date(endsAt).getTime() <= new Date(startsAt).getTime()) {
      toast.warning('endsAt must be after startsAt');
      return;
    }
    if (delegateUserId === selfId) {
      toast.warning('You cannot delegate a mailbox to yourself');
      return;
    }
    await guard(
      'delegation:add',
      async () => {
        // `permissions` is left to the backend default rather than guessed here.
        await createDelegation(id, {
          delegateUserId,
          endsAt,
          startsAt: startsAt ?? undefined,
          canSendOnBehalf: delegateOnBehalf,
          reason: delegateReason.trim() || undefined,
        });
        setDelegateTerm('');
        setDelegatePick('');
        setDelegateFrom('');
        setDelegateReason('');
        delegations.refresh();
      },
      'Delegation created'
    );
  }

  async function revoke(row: MailboxDelegation) {
    if (!window.confirm('Revoke the delegation for ' + delegateName(row) + '?')) return;
    await guard(
      'delegation:' + row.id,
      async () => {
        await revokeDelegation(row.id);
        delegations.refresh();
      },
      'Delegation revoked'
    );
  }

  async function submitLabel() {
    const name = labelName.trim();
    if (!name) {
      toast.warning('A label needs a name');
      return;
    }
    await guard(
      'label:add',
      async () => {
        await createLabel(id, {
          name,
          color: labelColor,
          kind: labelKind,
          tenantWide: labelTenantWide,
        });
        setLabelName('');
        setLabelColor('slate');
        setLabelKind('USER');
        setLabelTenantWide(false);
        labels.refresh();
      },
      'Label created'
    );
  }

  async function saveLabel(labelId: number) {
    const name = editName.trim();
    if (!name) {
      toast.warning('A label needs a name');
      return;
    }
    await guard(
      'label:' + labelId,
      async () => {
        await updateLabel(labelId, { name, color: editColor });
        setEditLabel(0);
        labels.refresh();
      },
      'Label updated'
    );
  }

  async function dropLabel(labelId: number) {
    if (!window.confirm('Delete this label? Messages already carrying it keep their history.')) return;
    await guard(
      'label:' + labelId,
      async () => {
        await deleteLabel(labelId);
        labels.refresh();
      },
      'Label deleted'
    );
  }

  if (box.loading && !box.data) return <PageLoader label="Loading the mailbox" />;

  if (!view) {
    return (
      <div className="page" style={modStyle()}>
        <MailHead kicker="Company mail" title="Mailbox" sub="This mailbox could not be read." />
        <MailTabs active="mailboxes" />
        <ErrorBanner error={box.error} />
        <Nothing
          text="The mailbox is not available - it may have been removed, or you may not have access to it."
          action="All mailboxes"
          onAction={() => navigate('/communication/mail/mailboxes')}
        />
      </div>
    );
  }

  const title = s(view.displayName) || s(view.address) || 'Mailbox ' + id;

  return (
    <div className="page" style={modStyle()}>
      <MailHead
        kicker="Company mail"
        title={title}
        sub={s(view.address) + (view.isActive === false ? ' \u2014 inactive' : '')}
        actions={
          <>
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => navigate('/communication/mail/mailboxes')}
            >
              All mailboxes
            </button>
            <RefreshBtn onClick={refreshAll} disabled={box.loading} />
          </>
        }
      />
      <MailTabs active="mailboxes" />

      <ErrorBanner error={box.error} />

      <KpiRow>
        <KpiTile label="Members" value={countText(memberRows.length)} sub={s(view.kind).toLowerCase() || undefined} />
        <KpiTile label="Active members" value={countText(activeMembers)} sub="able to use the mailbox" />
        <KpiTile label="Live delegations" value={countText(liveDelegations)} sub="currently granted" accent="#7C3AED" tint="rgba(124, 58, 237, 0.12)" />
        <KpiTile label="Labels" value={countText(labelRows.length)} sub="available in this mailbox" />
      </KpiRow>

      <SecCard
        title="Members"
        sub="Who can open this mailbox, and what each person may do inside it."
        actions={<RefreshBtn onClick={members.refresh} disabled={members.loading} />}
      >
        {mailboxAdmin ? (
          <div className="filter-bar">
            <label className="field" style={{ margin: 0, minWidth: 240 }}>
              <span>Find a person</span>
              <input
                className="hk-input"
                value={memberTerm}
                onChange={(e) => {
                  setMemberTerm(e.target.value);
                  setMemberPick('');
                }}
                placeholder="Name, username or e-mail"
              />
            </label>
            <label className="field" style={{ margin: 0, minWidth: 220 }}>
              <span>Person</span>
              <select
                className="hk-select"
                value={memberPick}
                onChange={(e) => setMemberPick(e.target.value)}
                disabled={memberOptions.length === 0}
              >
                <option value="">
                  {memberTerm.trim().length < 2 ? 'Type at least two characters' : 'Select\u2026'}
                </option>
                {memberOptions.map((person) => (
                  <option key={person.id} value={String(person.id)}>
                    {directoryLabel(person) +
                      (person.email ? ' \u2014 ' + person.email : '')}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Role</span>
              <select className="hk-select" value={memberRole} onChange={(e) => setMemberRole(e.target.value)}>
                {MEMBER_ROLES.map((role) => (
                  <option key={role} value={role}>{role}</option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy === 'member:add' || !can(user, 'communication.mailbox_members.create')}
              onClick={() => void submitMember()}
            >
              Add member
            </button>
          </div>
        ) : (
          <div className="card-pad">
            <p className="cell-sub" style={{ margin: 0 }}>
              You can view this mailbox but not administer its members.
            </p>
          </div>
        )}

        <ErrorBanner error={members.error} />

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Person</th>
                <th scope="col">Role</th>
                <th scope="col">Rights</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {memberRows.length === 0 ? (
                <EmptyRow cols={5}>
                  <Nothing
                    text={members.loading ? 'Loading members\u2026' : 'No one has been added to this mailbox yet.'}
                  />
                </EmptyRow>
              ) : (
                memberRows.map((member) => {
                  const who = personName(member as unknown as Rec);
                  const role = s(member.memberRole) || 'MEMBER';
                  const draft = roleDraft[member.userId] ?? role;
                  const working = busy === 'member:' + member.userId;
                  return (
                    <tr key={member.id}>
                      <td>
                        <div className="cell-main">{who}</div>
                        <div className="cell-sub">
                          {s(member.email) || s(member.username) || initials(who)}
                        </div>
                      </td>
                      <td>
                        {mailboxAdmin ? (
                          <select
                            className="hk-select"
                            value={draft}
                            onChange={(e) =>
                              setRoleDraft((prev) => ({ ...prev, [member.userId]: e.target.value }))
                            }
                            aria-label={'Role for ' + who}
                          >
                            {MEMBER_ROLES.map((option) => (
                              <option key={option} value={option}>{option}</option>
                            ))}
                          </select>
                        ) : (
                          <ToneBadge tone={roleTone(role)} label={role} />
                        )}
                      </td>
                      <td>
                        <div className="cell-sub" style={{ margin: 0 }}>{memberRights(member)}</div>
                      </td>
                      <td>
                        <ToneBadge
                          tone={member.isActive === false ? 'badge-neutral' : 'badge-green'}
                          label={member.isActive === false ? 'Disabled' : 'Active'}
                        />
                      </td>
                      <td>
                        {mailboxAdmin ? (
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-xs btn-primary"
                              disabled={working || draft === role || !can(user, 'communication.mailbox_members.update')}
                              onClick={() => void saveMemberRole(member)}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs"
                              disabled={working || !can(user, 'communication.mailbox_members.update')}
                              onClick={() => void toggleMember(member)}
                            >
                              {member.isActive === false ? 'Enable' : 'Disable'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs btn-danger"
                              disabled={working || !can(user, 'communication.mailbox_members.delete')}
                              onClick={() => void dropMember(member)}
                            >
                              Remove
                            </button>
                          </div>
                        ) : (
                          <span className="cell-sub">{'\u2014'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </SecCard>

      <SecCard
        title="Delegations"
        sub="Time-boxed access handed to someone else. Every delegation must expire."
        actions={<RefreshBtn onClick={delegations.refresh} disabled={delegations.loading} />}
      >
        {mailboxAdmin ? (
          <div className="filter-bar">
            <label className="field" style={{ margin: 0, minWidth: 220 }}>
              <span>Delegate to</span>
              <input
                className="hk-input"
                value={delegateTerm}
                onChange={(e) => {
                  setDelegateTerm(e.target.value);
                  setDelegatePick('');
                }}
                placeholder="Name, username or e-mail"
              />
            </label>
            <label className="field" style={{ margin: 0, minWidth: 220 }}>
              <span>Person</span>
              <select
                className="hk-select"
                value={delegatePick}
                onChange={(e) => setDelegatePick(e.target.value)}
                disabled={delegateOptions.length === 0}
              >
                <option value="">
                  {delegateTerm.trim().length < 2 ? 'Type at least two characters' : 'Select\u2026'}
                </option>
                {delegateOptions
                  .filter((person) => num(person.id) !== selfId)
                  .map((person) => (
                    <option key={person.id} value={String(person.id)}>
                      {directoryLabel(person) +
                        (person.email ? ' \u2014 ' + person.email : '')}
                    </option>
                  ))}
              </select>
              <span className="field-hint">You cannot delegate a mailbox to yourself.</span>
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Starts</span>
              <input
                className="hk-input"
                type="datetime-local"
                value={delegateFrom}
                onChange={(e) => setDelegateFrom(e.target.value)}
              />
              <span className="field-hint">Optional - defaults to now.</span>
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Ends</span>
              <input
                className="hk-input"
                type="datetime-local"
                value={delegateTo}
                onChange={(e) => setDelegateTo(e.target.value)}
              />
              <span className="field-hint">Required, and must be in the future.</span>
            </label>
            <label className="field" style={{ margin: 0, minWidth: 200 }}>
              <span>Reason</span>
              <input
                className="hk-input"
                value={delegateReason}
                onChange={(e) => setDelegateReason(e.target.value)}
                placeholder="Cover while away"
              />
            </label>
            <label className="field" style={{ margin: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={delegateOnBehalf}
                onChange={(e) => setDelegateOnBehalf(e.target.checked)}
              />
              <span>May send on behalf</span>
            </label>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy === 'delegation:add' || !can(user, 'communication.mailbox_delegations.create')}
              onClick={() => void submitDelegation()}
            >
              Create delegation
            </button>
          </div>
        ) : null}

        <ErrorBanner error={delegations.error} />

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Delegate</th>
                <th scope="col">Window</th>
                <th scope="col">Rights</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {delegationRows.length === 0 ? (
                <EmptyRow cols={5}>
                  <Nothing
                    text={
                      delegations.loading
                        ? 'Loading delegations\u2026'
                        : 'Nobody else has been given time-boxed access to this mailbox.'
                    }
                  />
                </EmptyRow>
              ) : (
                delegationRows.map((row) => {
                  const status = s(row.status) || 'ACTIVE';
                  const closed = status.toUpperCase() === 'REVOKED' || status.toUpperCase() === 'EXPIRED';
                  const working = busy === 'delegation:' + row.id;
                  return (
                    <tr key={row.id}>
                      <td>
                        <div className="cell-main">{delegateName(row)}</div>
                        {s(row.delegateEmail) ? <div className="cell-sub">{s(row.delegateEmail)}</div> : null}
                        {s(row.reason) ? <div className="cell-sub">{truncate(row.reason, 110)}</div> : null}
                      </td>
                      <td>
                        <div className="cell-main">{whenText(row.startsAt)}</div>
                        <div className="cell-sub">{'Ends ' + whenText(row.endsAt)}</div>
                      </td>
                      <td>
                        <div className="cell-sub" style={{ margin: 0 }}>
                          {row.canSendOnBehalf === false ? 'Access only' : 'May send on behalf'}
                        </div>
                      </td>
                      <td>
                        <ToneBadge tone={delegationTone(status)} label={status} />
                      </td>
                      <td>
                        {mailboxAdmin ? (
                          <button
                            type="button"
                            className="btn btn-xs btn-danger"
                            disabled={closed || working || !can(user, 'communication.mailbox_delegations.revoke')}
                            title={closed ? 'This delegation is already ' + status.toLowerCase() + '.' : undefined}
                            onClick={() => void revoke(row)}
                          >
                            Revoke
                          </button>
                        ) : (
                          <span className="cell-sub">{'\u2014'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </SecCard>

      <SecCard
        title="Labels"
        sub="Tags available inside this mailbox. System and tenant-wide labels need mail administration."
        actions={<RefreshBtn onClick={labels.refresh} disabled={labels.loading} />}
      >
        {mailboxAdmin ? (
          <div className="filter-bar">
            <label className="field" style={{ margin: 0, minWidth: 200 }}>
              <span>Name</span>
              <input
                className="hk-input"
                value={labelName}
                onChange={(e) => setLabelName(e.target.value)}
                placeholder="Follow up"
              />
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Colour</span>
              <select className="hk-select" value={labelColor} onChange={(e) => setLabelColor(e.target.value)}>
                {LABEL_COLORS.map((color) => (
                  <option key={color} value={color}>{color}</option>
                ))}
              </select>
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Kind</span>
              <select
                className="hk-select"
                value={labelKind}
                onChange={(e) => setLabelKind(e.target.value)}
                disabled={!mailAdmin}
                title={mailAdmin ? undefined : 'System and classification labels need mail administration.'}
              >
                {LABEL_KINDS.map((kind) => (
                  <option key={kind} value={kind} disabled={kind !== 'USER' && !mailAdmin}>
                    {kind}
                  </option>
                ))}
              </select>
            </label>
            <label className="field" style={{ margin: 0, flexDirection: 'row', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={labelTenantWide}
                disabled={!mailAdmin}
                onChange={(e) => setLabelTenantWide(e.target.checked)}
              />
              <span>Available to every mailbox</span>
            </label>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy === 'label:add' || !can(user, 'communication.mail_labels.create')}
              onClick={() => void submitLabel()}
            >
              Add label
            </button>
          </div>
        ) : null}

        <ErrorBanner error={labels.error} />

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th scope="col">Label</th>
                <th scope="col">Kind</th>
                <th scope="col">Scope</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {labelRows.length === 0 ? (
                <EmptyRow cols={4}>
                  <Nothing
                    text={labels.loading ? 'Loading labels\u2026' : 'This mailbox has no labels yet.'}
                  />
                </EmptyRow>
              ) : (
                labelRows.map((label) => {
                  const labelId = num(label.id);
                  const isSystem = bool(label.isSystem);
                  const kind = s(label.kind) || 'USER';
                  const tenantWide = label.mailboxId === null;
                  const editing = editLabel === labelId;
                  const working = busy === 'label:' + labelId;
                  // A system label is part of the taxonomy, so deleting one needs mail administration.
                  const mayDelete =
                    can(user, 'communication.mail_labels.delete') && (!isSystem || mailAdmin);
                  return (
                    <tr key={labelId}>
                      <td>
                        {editing ? (
                          <input
                            className="hk-input"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                            aria-label="Label name"
                          />
                        ) : (
                          <>
                            <div className="cell-main">{s(label.name) || 'Label ' + labelId}</div>
                            <div className="cell-sub">{'Colour ' + (s(label.color) || 'slate')}</div>
                          </>
                        )}
                      </td>
                      <td>
                        <ToneBadge
                          tone={kind === 'SYSTEM' ? 'badge-purple' : kind === 'CLASSIFICATION' ? 'badge-blue' : 'badge-neutral'}
                          label={kind}
                        />
                      </td>
                      <td>
                        <div className="cell-sub" style={{ margin: 0 }}>
                          {tenantWide ? 'Every mailbox' : 'This mailbox only'}
                        </div>
                      </td>
                      <td>
                        {editing ? (
                          <div className="row-actions">
                            <select
                              className="hk-select"
                              value={editColor}
                              onChange={(e) => setEditColor(e.target.value)}
                              aria-label="Label colour"
                            >
                              {LABEL_COLORS.map((color) => (
                                <option key={color} value={color}>{color}</option>
                              ))}
                            </select>
                            <button
                              type="button"
                              className="btn btn-xs btn-primary"
                              disabled={working || !can(user, 'communication.mail_labels.update')}
                              onClick={() => void saveLabel(labelId)}
                            >
                              Save
                            </button>
                            <button type="button" className="btn btn-xs" onClick={() => setEditLabel(0)}>
                              Cancel
                            </button>
                          </div>
                        ) : mailboxAdmin ? (
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-xs"
                              disabled={!can(user, 'communication.mail_labels.update')}
                              onClick={() => {
                                setEditLabel(labelId);
                                setEditName(s(label.name));
                                setEditColor(s(label.color) || 'slate');
                              }}
                            >
                              Rename
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs btn-danger"
                              disabled={working || !mayDelete}
                              title={
                                !mayDelete && isSystem
                                  ? 'System labels can only be deleted with mail administration.'
                                  : undefined
                              }
                              onClick={() => void dropLabel(labelId)}
                            >
                              Delete
                            </button>
                          </div>
                        ) : (
                          <span className="cell-sub">{'\u2014'}</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </SecCard>
    </div>
  );
}
