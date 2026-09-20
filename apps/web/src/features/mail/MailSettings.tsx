/**
 * Company mail - settings.
 *
 * Four sections, each owned by its own backend permission, so a section is only
 * rendered when the caller may actually read it rather than shown empty:
 *
 *   signatures        communication.mail_signatures.*
 *   distribution      communication.mail_distribution_lists.*
 *   classifications   communication.mail_classifications.view / .manage
 *   providers         communication.mail_providers.view
 *
 * Two details are deliberate. Signature bodies are sent as `bodyText` /
 * `bodyHtml` because that is the field name the API stores, and every read goes
 * through the raw row as well so a signature written under the older `body` key
 * still displays. Provider configuration is strictly read-only and never shows a
 * credential - the API only ever returns `hasCredentials`.
 *
 * Classification edits are collected as a sparse patch per row: only the fields
 * the operator actually changed are sent, which is what the endpoint expects
 * (`400 No supported fields supplied` when nothing changed), and Save stays
 * disabled until something has.
 */
import { useEffect, useState } from 'react';
import { can, useAuth } from '../../auth';
import { ErrorBanner, Modal, PageLoader } from '../../components/ui';
import { toast } from '../../components/toast';
import {
  addDistributionMember,
  createDistributionList,
  createSignature,
  deleteDistributionList,
  deleteSignature,
  listProviderConfigs,
  removeDistributionMember,
  searchDirectoryUsers,
  setDefaultSignature,
  updateClassification,
  updateDistributionList,
  updateSignature,
} from './mailApi';
import type { DirectoryUser } from './mailApi';
import {
  useDebounced,
  useMailboxes,
  useMailClassifications,
  useMailDistributionLists,
  useMailDistributionMembers,
  useMailSignatures,
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
  modStyle,
  num,
  s,
  truncate,
  whenText,
} from './mailShared';
import type { Rec } from './mailShared';
import { ToneBadge } from './mailBits';
import { classificationTone } from './mailDelivery';
import type { DeliveryTone } from './mailDelivery';
import type {
  DistributionList,
  MailClassification,
  MailSignature,
  ProviderConfig,
} from './mail.types';

const MEMBER_TYPES = ['USER', 'EMAIL', 'MAILBOX', 'DEPARTMENT'];

/** The policy switches a classification controls, in the order the API accepts them. */
const POLICY_FIELDS: Array<[string, string]> = [
  ['allowForward', 'Forward'],
  ['allowDownload', 'Download'],
  ['allowPrint', 'Print'],
  ['allowExport', 'Export'],
  ['allowExternal', 'External'],
  ['requireApproval', 'Approval'],
  ['requireEncryption', 'Encryption'],
  ['isActive', 'Active'],
];

interface SigForm {
  id: number;
  name: string;
  mailboxId: string;
  isShared: boolean;
  isDefault: boolean;
  jobTitle: string;
  department: string;
  phone: string;
  website: string;
  logoPath: string;
  disclaimer: string;
  bodyText: string;
  bodyHtml: string;
}

const EMPTY_SIG: SigForm = {
  id: 0,
  name: '',
  mailboxId: '',
  isShared: false,
  isDefault: false,
  jobTitle: '',
  department: '',
  phone: '',
  website: '',
  logoPath: '',
  disclaimer: '',
  bodyText: '',
  bodyHtml: '',
};

interface ListForm {
  code: string;
  name: string;
  address: string;
  description: string;
}

const EMPTY_LIST: ListForm = { code: '', name: '', address: '', description: '' };

/** Signature bodies are stored as `bodyText`/`bodyHtml`; older rows used `body`/`html`. */
function sigBody(sig: MailSignature): string {
  const row = sig as unknown as Rec;
  return s(row.bodyText) || s(row.body) || '';
}

function sigHtml(sig: MailSignature): string {
  const row = sig as unknown as Rec;
  return s(row.bodyHtml) || s(row.html) || '';
}

function sigField(sig: MailSignature, key: string): string {
  return s((sig as unknown as Rec)[key]);
}

function sigTone(sig: MailSignature): DeliveryTone {
  return sig.isDefault === true ? 'badge-green' : sig.isShared ? 'badge-blue' : 'badge-neutral';
}

function classificationDiffText(diff: Rec): string {
  const keys = Object.keys(diff);
  return keys.length === 1 ? '1 change ready' : keys.length + ' changes ready';
}

/** Picker label for a directory row - the identity lookup returns no display name. */
function directoryLabel(person: DirectoryUser): string {
  const full = [s(person.firstName), s(person.lastName)].filter(Boolean).join(' ');
  return full || s(person.username) || s(person.email) || 'User ' + String(num(person.id));
}

export default function MailSettings() {
  const { user } = useAuth();

  const signatures = useMailSignatures();
  const lists = useMailDistributionLists();
  const classes = useMailClassifications();
  const mailboxes = useMailboxes();

  const [providers, setProviders] = useState<ProviderConfig[] | null>(null);
  const [providerError, setProviderError] = useState<unknown>(null);
  const [providerLoading, setProviderLoading] = useState<boolean>(false);
  const [providerTick, setProviderTick] = useState<number>(0);

  const [sigOpen, setSigOpen] = useState<boolean>(false);
  const [sigForm, setSigForm] = useState<SigForm>(EMPTY_SIG);
  const [sigSaving, setSigSaving] = useState<boolean>(false);

  const [listForm, setListForm] = useState<ListForm>(EMPTY_LIST);
  const [listSaving, setListSaving] = useState<boolean>(false);
  const [openList, setOpenList] = useState<number>(0);

  const [expanded, setExpanded] = useState<number>(0);

  // Sparse classification patches, keyed by classification id.
  const [patches, setPatches] = useState<Record<string, Rec>>({});
  const [busy, setBusy] = useState<string>('');

  const maySign = can(user, 'communication.mail_signatures.view');
  const mayDist = can(user, 'communication.mail_distribution_lists.view');
  const mayClass = can(user, 'communication.mail_classifications.view');
  const mayProv = can(user, 'communication.mail_providers.view');
  const mayClassManage = can(user, 'communication.mail_classifications.manage');
  const anySection = maySign || mayDist || mayClass || mayProv;

  useEffect(() => {
    if (!mayProv) return;
    let dead = false;
    setProviderLoading(true);
    setProviderError(null);
    listProviderConfigs()
      .then((rows) => {
        if (!dead) setProviders(rows);
      })
      .catch((e) => {
        if (!dead) setProviderError(e);
      })
      .finally(() => {
        if (!dead) setProviderLoading(false);
      });
    return () => {
      dead = true;
    };
  }, [mayProv, providerTick]);

  const sigRows = signatures.data?.signatures ?? [];
  const defaultSignature = signatures.data?.defaultSignature ?? null;
  const listRows = lists.data ?? [];
  const classRows = classes.data ?? [];
  const providerRows = providers ?? [];

  function scrollTo(anchor: string) {
    const node = document.getElementById(anchor);
    if (node) node.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function guard(key: string, work: () => Promise<void>, done: string, fail: string) {
    if (busy) return;
    setBusy(key);
    try {
      await work();
      toast.success(done);
    } catch (e) {
      toast.fromError(fail, e);
    } finally {
      setBusy('');
    }
  }

  // ---------------------------------------------------------------- signatures

  function openSignature(sig: MailSignature | null) {
    if (!sig) {
      setSigForm(EMPTY_SIG);
    } else {
      setSigForm({
        id: sig.id,
        name: s(sig.name),
        mailboxId: sig.mailboxId === null || sig.mailboxId === undefined ? '' : String(num(sig.mailboxId)),
        isShared: bool(sig.isShared),
        isDefault: bool(sig.isDefault),
        jobTitle: sigField(sig, 'jobTitle'),
        department: sigField(sig, 'department'),
        phone: sigField(sig, 'phone'),
        website: sigField(sig, 'website'),
        logoPath: sigField(sig, 'logoPath'),
        disclaimer: sigField(sig, 'disclaimer'),
        bodyText: sigBody(sig),
        bodyHtml: sigHtml(sig),
      });
    }
    setSigOpen(true);
  }

  function sigFieldSet<K extends keyof SigForm>(key: K, value: SigForm[K]) {
    setSigForm((prev) => ({ ...prev, [key]: value }));
  }

  // The signature's mailbox is fixed at creation: `PATCH /signatures/:id` does not
  // accept `mailboxId` or `isShared`, so the edit form must not offer them.
  const editingSig = sigForm.id !== 0;

  async function saveSignature() {
    if (sigSaving) return;
    const name = sigForm.name.trim();
    if (!name) {
      toast.warning('A signature needs a name');
      return;
    }
    if (sigForm.isShared && !sigForm.mailboxId) {
      toast.warning('A shared signature must be attached to a mailbox');
      return;
    }
    const body: Rec = {
      name,
      isDefault: sigForm.isDefault,
      jobTitle: sigForm.jobTitle.trim() || null,
      department: sigForm.department.trim() || null,
      phone: sigForm.phone.trim() || null,
      website: sigForm.website.trim() || null,
      logoPath: sigForm.logoPath.trim() || null,
      disclaimer: sigForm.disclaimer.trim() || null,
      bodyText: sigForm.bodyText,
      bodyHtml: sigForm.bodyHtml,
    };
    if (!editingSig) {
      body.mailboxId = sigForm.mailboxId ? num(sigForm.mailboxId) : null;
      body.isShared = sigForm.isShared;
    }
    setSigSaving(true);
    try {
      if (sigForm.id) await updateSignature(sigForm.id, body);
      else await createSignature(body);
      setSigOpen(false);
      setSigForm(EMPTY_SIG);
      signatures.refresh();
      toast.success(sigForm.id ? 'Signature updated' : 'Signature created');
    } catch (e) {
      toast.fromError('Could not save the signature', e);
    } finally {
      setSigSaving(false);
    }
  }

  async function makeDefault(sig: MailSignature) {
    await guard(
      'sig:' + sig.id,
      async () => {
        await setDefaultSignature(sig.id);
        signatures.refresh();
      },
      'Default signature changed',
      'Could not set the default signature'
    );
  }

  async function dropSignature(sig: MailSignature) {
    if (!window.confirm('Delete the signature "' + s(sig.name) + '"?')) return;
    await guard(
      'sig:' + sig.id,
      async () => {
        await deleteSignature(sig.id);
        signatures.refresh();
      },
      'Signature deleted',
      'Could not delete the signature'
    );
  }

  // ---------------------------------------------------------- distribution lists

  async function saveList() {
    if (listSaving) return;
    if (!listForm.code.trim() || !listForm.name.trim() || !listForm.address.trim()) {
      toast.warning('Code, name and address are all required');
      return;
    }
    setListSaving(true);
    try {
      await createDistributionList({
        code: listForm.code.trim(),
        name: listForm.name.trim(),
        address: listForm.address.trim(),
        description: listForm.description.trim() || undefined,
      });
      setListForm(EMPTY_LIST);
      lists.refresh();
      toast.success('Distribution list created');
    } catch (e) {
      toast.fromError('Could not create the distribution list', e);
    } finally {
      setListSaving(false);
    }
  }

  async function toggleList(row: DistributionList) {
    const next = !bool(row.isActive);
    await guard(
      'list:' + row.id,
      async () => {
        await updateDistributionList(row.id, { isActive: next });
        lists.refresh();
      },
      next ? 'Distribution list reactivated' : 'Distribution list deactivated',
      'Could not update the distribution list'
    );
  }

  async function dropList(row: DistributionList) {
    if (!window.confirm('Delete the distribution list "' + s(row.name) + '"?')) return;
    await guard(
      'list:' + row.id,
      async () => {
        await deleteDistributionList(row.id);
        lists.refresh();
      },
      'Distribution list deleted',
      'Could not delete the distribution list'
    );
  }

  // ----------------------------------------------------------- classifications

  function patch(id: number | string, key: string, value: unknown) {
    const keyId = String(id);
    setPatches((prev) => ({ ...prev, [keyId]: { ...(prev[keyId] ?? {}), [key]: value } }));
  }

  function clearPatch(id: number | string) {
    const keyId = String(id);
    setPatches((prev) => {
      const copy = { ...prev };
      delete copy[keyId];
      return copy;
    });
  }

  async function saveClassification(row: MailClassification) {
    const keyId = String(row.id);
    const diff = patches[keyId] ?? {};
    if (Object.keys(diff).length === 0) {
      toast.warning('No supported fields supplied');
      return;
    }
    await guard(
      'class:' + keyId,
      async () => {
        await updateClassification(row.id, diff);
        clearPatch(row.id);
        classes.refresh();
      },
      'Classification updated',
      'Could not update the classification'
    );
  }

  if (maySign && signatures.loading && !signatures.data) {
    return <PageLoader label="Loading mail settings" />;
  }

  return (
    <div className="page" style={modStyle()}>
      <MailHead
        kicker="Company mail"
        title="Mail settings"
        sub="Signatures, distribution lists, classification policy and the sending provider behind company mail."
        actions={
          <RefreshBtn
            onClick={() => {
              signatures.refresh();
              lists.refresh();
              classes.refresh();
              setProviderTick((t) => t + 1);
            }}
            disabled={signatures.loading}
          />
        }
      />
      <MailTabs active="settings" />

      {anySection ? (
        <div className="filter-bar">
          {maySign ? (
            <button type="button" className="btn btn-sm" onClick={() => scrollTo('mail-settings-signatures')}>
              Signatures
            </button>
          ) : null}
          {mayDist ? (
            <button type="button" className="btn btn-sm" onClick={() => scrollTo('mail-settings-distribution')}>
              Distribution lists
            </button>
          ) : null}
          {mayClass ? (
            <button type="button" className="btn btn-sm" onClick={() => scrollTo('mail-settings-classifications')}>
              Classifications
            </button>
          ) : null}
          {mayProv ? (
            <button type="button" className="btn btn-sm" onClick={() => scrollTo('mail-settings-providers')}>
              Provider
            </button>
          ) : null}
        </div>
      ) : null}

      {!anySection ? (
        <Nothing text="You do not have access to any company mail setting. Ask an administrator for the mail permissions you need." />
      ) : null}

      {maySign ? (
        <>
          <KpiRow>
            <KpiTile
              label="Signatures"
              value={countText(sigRows.length)}
              sub={defaultSignature ? 'default: ' + (s(defaultSignature.name) || 'unnamed') : 'no default set'}
            />
            {mayDist ? (
              <KpiTile label="Distribution lists" value={countText(listRows.length)} sub="company-wide groups" />
            ) : null}
            {mayClass ? (
              <KpiTile label="Classifications" value={countText(classRows.length)} sub="policy levels" />
            ) : null}
            {mayProv ? (
              <KpiTile
                label="Provider configs"
                value={countText(providerRows.length)}
                sub={providerLoading ? 'loading\u2026' : 'connected senders'}
              />
            ) : null}
          </KpiRow>
        </>
      ) : null}

      {maySign ? (
        <SecCard
          id="mail-settings-signatures"
          title="Signatures"
          sub="Blocks appended to outbound mail. A shared signature belongs to a mailbox; a personal one belongs to its author."
          actions={
            <>
              <RefreshBtn onClick={signatures.refresh} disabled={signatures.loading} />
              <button
                type="button"
                className="btn btn-sm btn-primary"
                disabled={!can(user, 'communication.mail_signatures.create')}
                onClick={() => openSignature(null)}
              >
                New signature
              </button>
            </>
          }
        >
          <ErrorBanner error={signatures.error} />
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Signature</th>
                  <th scope="col">Scope</th>
                  <th scope="col">Body</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {sigRows.length === 0 ? (
                  <EmptyRow cols={4}>
                    <Nothing
                      text={
                        signatures.loading
                          ? 'Loading signatures\u2026'
                          : 'No signatures yet. Create one and it can be attached to messages you send.'
                      }
                    />
                  </EmptyRow>
                ) : (
                  sigRows.map((sig) => {
                    const working = busy === 'sig:' + sig.id;
                    return (
                      <tr key={sig.id}>
                        <td>
                          <div className="cell-main">{s(sig.name) || 'Signature ' + sig.id}</div>
                          <div className="cell-sub">
                            {sig.mailboxId === null || sig.mailboxId === undefined
                              ? 'Personal'
                              : 'Mailbox ' + String(num(sig.mailboxId))}
                          </div>
                        </td>
                        <td>
                          <ToneBadge
                            tone={sigTone(sig)}
                            label={
                              sig.isDefault === true ? 'Default' : sig.isShared ? 'Shared' : 'Personal'
                            }
                          />
                        </td>
                        <td>
                          <div className="cell-sub" style={{ margin: 0 }}>
                            {truncate(sigBody(sig) || sigHtml(sig), 110) || '\u2014'}
                          </div>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-xs btn-primary"
                              disabled={
                                working ||
                                sig.isDefault === true ||
                                !can(user, 'communication.mail_signatures.update')
                              }
                              title={sig.isDefault === true ? 'This is already the default.' : undefined}
                              onClick={() => void makeDefault(sig)}
                            >
                              Make default
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs"
                              disabled={!can(user, 'communication.mail_signatures.update')}
                              onClick={() => openSignature(sig)}
                            >
                              Edit
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs btn-danger"
                              disabled={working || !can(user, 'communication.mail_signatures.delete')}
                              onClick={() => void dropSignature(sig)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </SecCard>
      ) : null}

      {mayDist ? (
        <SecCard
          id="mail-settings-distribution"
          title="Distribution lists"
          sub="Shared addresses that fan out to several people. Deleting a list retires it; existing mail keeps its history."
          actions={<RefreshBtn onClick={lists.refresh} disabled={lists.loading} />}
        >
          <div className="filter-bar">
            <label className="field" style={{ margin: 0 }}>
              <span>Code</span>
              <input
                className="hk-input"
                value={listForm.code}
                onChange={(e) => setListForm((p) => ({ ...p, code: e.target.value }))}
                placeholder="ALLSTAFF"
              />
            </label>
            <label className="field" style={{ margin: 0 }}>
              <span>Name</span>
              <input
                className="hk-input"
                value={listForm.name}
                onChange={(e) => setListForm((p) => ({ ...p, name: e.target.value }))}
                placeholder="All staff"
              />
            </label>
            <label className="field" style={{ margin: 0, minWidth: 220 }}>
              <span>Address</span>
              <input
                className="hk-input"
                value={listForm.address}
                onChange={(e) => setListForm((p) => ({ ...p, address: e.target.value }))}
                placeholder="all@hopedesign.co"
              />
            </label>
            <label className="field" style={{ margin: 0, minWidth: 200 }}>
              <span>Description</span>
              <input
                className="hk-input"
                value={listForm.description}
                onChange={(e) => setListForm((p) => ({ ...p, description: e.target.value }))}
                placeholder="Who this reaches"
              />
            </label>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={listSaving || !can(user, 'communication.mail_distribution_lists.create')}
              onClick={() => void saveList()}
            >
              {listSaving ? 'Creating\u2026' : 'Create list'}
            </button>
          </div>

          <ErrorBanner error={lists.error} />

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">List</th>
                  <th scope="col">Address</th>
                  <th scope="col">Members</th>
                  <th scope="col">Status</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {listRows.length === 0 ? (
                  <EmptyRow cols={5}>
                    <Nothing
                      text={lists.loading ? 'Loading distribution lists\u2026' : 'No distribution lists yet.'}
                    />
                  </EmptyRow>
                ) : (
                  listRows.map((row) => {
                    const working = busy === 'list:' + row.id;
                    const active = bool(row.isActive);
                    return (
                      <tr key={row.id}>
                        <td>
                          <div className="cell-main">{s(row.name) || s(row.code)}</div>
                          <div className="cell-sub">
                            {s(row.code)}
                            {s(row.description) ? ' \u2014 ' + truncate(row.description, 80) : ''}
                          </div>
                        </td>
                        <td>{s(row.address) || '\u2014'}</td>
                        <td>
                          <button
                            type="button"
                            className="btn btn-xs"
                            onClick={() => {
                              const next = expanded === row.id ? 0 : row.id;
                              setExpanded(next);
                              setOpenList(next);
                            }}
                          >
                            {countText(row.memberCount)} {expanded === row.id ? 'Hide' : 'Manage'}
                          </button>
                        </td>
                        <td>
                          <ToneBadge
                            tone={active ? 'badge-green' : 'badge-neutral'}
                            label={active ? 'Active' : 'Retired'}
                          />
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-xs"
                              disabled={working || !can(user, 'communication.mail_distribution_lists.update')}
                              onClick={() => void toggleList(row)}
                            >
                              {active ? 'Deactivate' : 'Reactivate'}
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs btn-danger"
                              disabled={working || !can(user, 'communication.mail_distribution_lists.delete')}
                              onClick={() => void dropList(row)}
                            >
                              Delete
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          {expanded ? (
            <ListMembers
              key={expanded}
              listId={expanded}
              mailboxes={mailboxes.data ?? []}
              canCreate={can(user, 'communication.mail_distribution_lists.create')}
              canDelete={can(user, 'communication.mail_distribution_lists.delete')}
              onChanged={lists.refresh}
              shown={openList === expanded}
            />
          ) : null}
        </SecCard>
      ) : null}

      {mayClass ? (
        <SecCard
          id="mail-settings-classifications"
          title="Classifications"
          sub="What each level of confidentiality permits. Changes are collected per row and only what you changed is sent."
          actions={<RefreshBtn onClick={classes.refresh} disabled={classes.loading} />}
        >
          <ErrorBanner error={classes.error} />
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Classification</th>
                  <th scope="col">Rank</th>
                  <th scope="col">Policy</th>
                  <th scope="col">Change</th>
                </tr>
              </thead>
              <tbody>
                {classRows.length === 0 ? (
                  <EmptyRow cols={4}>
                    <Nothing
                      text={
                        classes.loading
                          ? 'Loading classifications\u2026'
                          : 'No classifications are configured for this tenant.'
                      }
                    />
                  </EmptyRow>
                ) : (
                  classRows.map((row) => {
                    const keyId = String(row.id);
                    const diff = patches[keyId] ?? {};
                    const changed = Object.keys(diff).length;
                    const working = busy === 'class:' + keyId;
                    const raw = row as unknown as Rec;
                    return (
                      <tr key={keyId}>
                        <td>
                          <div className="cell-main">{s(row.code) || 'Level ' + String(num(row.rank))}</div>
                          {mayClassManage ? (
                            <input
                              className="hk-input"
                              style={{ marginTop: 4 }}
                              value={s(raw.label ?? diff.label ?? row.label)}
                              onChange={(e) => patch(row.id, 'label', e.target.value)}
                              aria-label="Classification label"
                            />
                          ) : (
                            <div className="cell-sub">{s(row.label)}</div>
                          )}
                          {s(row.description) ? <div className="cell-sub">{truncate(row.description, 110)}</div> : null}
                        </td>
                        <td>
                          <div className="cell-main">
                            <ToneBadge tone={classificationTone(num(row.rank))} label={String(num(row.rank))} />
                          </div>
                          {mayClassManage ? (
                            <label className="field" style={{ marginTop: 4 }}>
                              <span>Min role rank</span>
                              <input
                                className="hk-input"
                                type="number"
                                value={s(raw.minRoleRank ?? diff.minRoleRank ?? '')}
                                onChange={(e) =>
                                  patch(row.id, 'minRoleRank', e.target.value === '' ? null : Number(e.target.value))
                                }
                              />
                            </label>
                          ) : null}
                        </td>
                        <td>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
                            {POLICY_FIELDS.map(([key, text]) => {
                              const current = (diff[key] as boolean | undefined) ?? bool(raw[key]);
                              return (
                                <label
                                  key={key}
                                  className="field"
                                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, margin: 0 }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={current}
                                    disabled={!mayClassManage}
                                    onChange={(e) => patch(row.id, key, e.target.checked)}
                                  />
                                  <span>{text}</span>
                                </label>
                              );
                            })}
                          </div>
                        </td>
                        <td>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn btn-xs btn-primary"
                              disabled={working || changed === 0 || !mayClassManage}
                              title={changed === 0 ? 'Change a policy first.' : undefined}
                              onClick={() => void saveClassification(row)}
                            >
                              Save
                            </button>
                            <button
                              type="button"
                              className="btn btn-xs"
                              disabled={changed === 0 || working}
                              onClick={() => clearPatch(row.id)}
                            >
                              Reset
                            </button>
                            {changed > 0 ? (
                              <span className="cell-sub" style={{ margin: 0 }}>{classificationDiffText(diff)}</span>
                            ) : null}
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </SecCard>
      ) : null}

      {mayProv ? (
        <SecCard
          id="mail-settings-providers"
          title="Sending provider"
          sub="Read-only. Credentials are never returned by the API - only whether they are present."
          actions={<RefreshBtn onClick={() => setProviderTick((t) => t + 1)} disabled={providerLoading} />}
        >
          <ErrorBanner error={providerError} />
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">From</th>
                  <th scope="col">Inbound</th>
                  <th scope="col">Credentials</th>
                  <th scope="col">Verified</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {providerRows.length === 0 ? (
                  <EmptyRow cols={6}>
                    <Nothing
                      text={
                        providerLoading
                          ? 'Loading provider configuration\u2026'
                          : 'No mail provider configuration is visible to you.'
                      }
                    />
                  </EmptyRow>
                ) : (
                  providerRows.map((row) => (
                    <tr key={row.id}>
                      <td>
                        <div className="cell-main">
                          {s((row as unknown as Rec).label) || s(row.name) || s(row.provider)}
                        </div>
                        <div className="cell-sub">
                          {s(row.provider)}
                          {s(row.environment) ? ' \u00b7 ' + s(row.environment) : ''}
                        </div>
                      </td>
                      <td>
                        <div className="cell-main">{s(row.fromAddress) || '\u2014'}</div>
                        {s(row.fromName) ? <div className="cell-sub">{s(row.fromName)}</div> : null}
                      </td>
                      <td>{s((row as unknown as Rec).inboundAddress) || '\u2014'}</td>
                      <td>
                        <ToneBadge
                          tone={bool(row.hasCredentials) ? 'badge-green' : 'badge-amber'}
                          label={bool(row.hasCredentials) ? 'Present' : 'Missing'}
                        />
                      </td>
                      <td>
                        <div className="cell-sub" style={{ margin: 0 }}>{whenText(row.lastVerifiedAt)}</div>
                        {s((row as unknown as Rec).lastError) ? (
                          <div className="cell-sub">
                            {'Last error: ' + truncate((row as unknown as Rec).lastError, 90)}
                          </div>
                        ) : null}
                      </td>
                      <td>
                        <ToneBadge
                          tone={bool(row.isActive) ? 'badge-green' : 'badge-neutral'}
                          label={bool(row.isActive) ? 'Active' : 'Inactive'}
                        />
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </SecCard>
      ) : null}

      {sigOpen ? (
        <Modal
          wide
          title={sigForm.id ? 'Edit signature' : 'New signature'}
          onClose={() => setSigOpen(false)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setSigOpen(false)} disabled={sigSaving}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => void saveSignature()}
                disabled={sigSaving}
              >
                {sigSaving ? 'Saving\u2026' : 'Save signature'}
              </button>
            </>
          }
        >
          <div className="form-grid">
            <div className="form-sec">
              <label className="field">
                <span>Name</span>
                <input
                  className="hk-input"
                  value={sigForm.name}
                  onChange={(e) => sigFieldSet('name', e.target.value)}
                  placeholder="Sales - formal"
                />
              </label>
              <label className="field">
                <span>Mailbox</span>
                <select
                  className="hk-select"
                  value={sigForm.mailboxId}
                  disabled={editingSig}
                  onChange={(e) => {
                    sigFieldSet('mailboxId', e.target.value);
                    if (!e.target.value) sigFieldSet('isShared', false);
                  }}
                >
                  <option value="">Personal - my own mail only</option>
                  {(mailboxes.data ?? []).map((box) => (
                    <option key={box.id} value={String(box.id)}>
                      {s(box.address) || s(box.displayName)}
                    </option>
                  ))}
                </select>
                {editingSig ? (
                  <span className="field-hint">
                    The mailbox is fixed once a signature exists. Create a new one to move it.
                  </span>
                ) : null}
              </label>
              <label className="field">
                <span>Job title</span>
                <input
                  className="hk-input"
                  value={sigForm.jobTitle}
                  onChange={(e) => sigFieldSet('jobTitle', e.target.value)}
                />
              </label>
              <label className="field">
                <span>Department</span>
                <input
                  className="hk-input"
                  value={sigForm.department}
                  onChange={(e) => sigFieldSet('department', e.target.value)}
                />
              </label>
              <label className="field">
                <span>Phone</span>
                <input
                  className="hk-input"
                  value={sigForm.phone}
                  onChange={(e) => sigFieldSet('phone', e.target.value)}
                />
              </label>
            </div>
            <div className="form-sec">
              <label className="field">
                <span>Website</span>
                <input
                  className="hk-input"
                  value={sigForm.website}
                  onChange={(e) => sigFieldSet('website', e.target.value)}
                />
              </label>
              <label className="field">
                <span>Logo path</span>
                <input
                  className="hk-input"
                  value={sigForm.logoPath}
                  onChange={(e) => sigFieldSet('logoPath', e.target.value)}
                  placeholder="/branding/logo.png"
                />
              </label>
              <label className="field">
                <span>Disclaimer</span>
                <input
                  className="hk-input"
                  value={sigForm.disclaimer}
                  onChange={(e) => sigFieldSet('disclaimer', e.target.value)}
                />
              </label>
              <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={sigForm.isShared}
                  disabled={editingSig || !sigForm.mailboxId}
                  onChange={(e) => sigFieldSet('isShared', e.target.checked)}
                />
                <span>Shared with everyone who can send from that mailbox</span>
              </label>
              <label className="field" style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
                <input
                  type="checkbox"
                  checked={sigForm.isDefault}
                  onChange={(e) => sigFieldSet('isDefault', e.target.checked)}
                />
                <span>Use as the default signature</span>
              </label>
            </div>
          </div>
          <label className="field">
            <span>Plain-text body</span>
            <textarea
              className="hk-input"
              rows={5}
              value={sigForm.bodyText}
              onChange={(e) => sigFieldSet('bodyText', e.target.value)}
              placeholder={'Kind regards\\nHOPE Design'}
            />
          </label>
          <label className="field">
            <span>HTML body</span>
            <textarea
              className="hk-input"
              rows={4}
              value={sigForm.bodyHtml}
              onChange={(e) => sigFieldSet('bodyHtml', e.target.value)}
              placeholder="<p>Kind regards<br>HOPE Design</p>"
            />
            <span className="field-hint">Optional. Left empty, the plain-text body is used.</span>
          </label>
        </Modal>
      ) : null}
    </div>
  );
}

/** Members of one distribution list, loaded only while that list is expanded. */
function ListMembers({
  listId,
  mailboxes,
  canCreate,
  canDelete,
  onChanged,
  shown,
}: {
  listId: number;
  mailboxes: Array<{ id: number; address: string; displayName: string }>;
  canCreate: boolean;
  canDelete: boolean;
  onChanged: () => void;
  shown: boolean;
}) {
  const members = useMailDistributionMembers(listId);
  const [memberType, setMemberType] = useState<string>('USER');
  const [term, setTerm] = useState<string>('');
  const [userPick, setUserPick] = useState<string>('');
  const [mailboxPick, setMailboxPick] = useState<string>('');
  const [departmentId, setDepartmentId] = useState<string>('');
  const [email, setEmail] = useState<string>('');
  const [name, setName] = useState<string>('');
  const [saving, setSaving] = useState<boolean>(false);
  const [busy, setBusy] = useState<number>(0);
  const options = useDirectorySearch(term);

  if (!shown) return null;

  async function add() {
    if (saving) return;
    const body: Rec = { memberType };
    if (memberType === 'USER') {
      const userId = num(userPick);
      if (!userId) {
        toast.warning('Pick a person from the directory first');
        return;
      }
      body.userId = userId;
    } else if (memberType === 'MAILBOX') {
      const mailboxId = num(mailboxPick);
      if (!mailboxId) {
        toast.warning('Pick a mailbox first');
        return;
      }
      body.mailboxId = mailboxId;
    } else if (memberType === 'DEPARTMENT') {
      const id = num(departmentId);
      if (!id) {
        toast.warning('A department id is required');
        return;
      }
      body.departmentId = id;
    } else {
      const address = email.trim();
      if (!address) {
        toast.warning('An e-mail address is required');
        return;
      }
      body.email = address;
      body.name = name.trim() || undefined;
    }
    setSaving(true);
    try {
      await addDistributionMember(listId, body);
      setTerm('');
      setUserPick('');
      setMailboxPick('');
      setDepartmentId('');
      setEmail('');
      setName('');
      members.refresh();
      onChanged();
      toast.success('Member added to the list');
    } catch (e) {
      toast.fromError('Could not add the member', e);
    } finally {
      setSaving(false);
    }
  }

  async function remove(memberId: number, who: string) {
    if (!window.confirm('Remove ' + who + ' from this list?')) return;
    if (busy) return;
    setBusy(memberId);
    try {
      await removeDistributionMember(listId, memberId);
      members.refresh();
      onChanged();
      toast.success('Member removed');
    } catch (e) {
      toast.fromError('Could not remove the member', e);
    } finally {
      setBusy(0);
    }
  }

  const rows = members.data ?? [];

  return (
    <div className="card-pad">
      <h4 style={{ margin: '0 0 8px' }}>Members of this list</h4>
      {canCreate ? (
        <div className="filter-bar">
          <label className="field" style={{ margin: 0 }}>
            <span>Type</span>
            <select className="hk-select" value={memberType} onChange={(e) => setMemberType(e.target.value)}>
              {MEMBER_TYPES.map((type) => (
                <option key={type} value={type}>{type}</option>
              ))}
            </select>
          </label>
          {memberType === 'USER' ? (
            <>
              <label className="field" style={{ margin: 0, minWidth: 200 }}>
                <span>Find a person</span>
                <input
                  className="hk-input"
                  value={term}
                  onChange={(e) => {
                    setTerm(e.target.value);
                    setUserPick('');
                  }}
                  placeholder="Name, username or e-mail"
                />
              </label>
              <label className="field" style={{ margin: 0, minWidth: 200 }}>
                <span>Person</span>
                <select
                  className="hk-select"
                  value={userPick}
                  onChange={(e) => setUserPick(e.target.value)}
                  disabled={options.length === 0}
                >
                  <option value="">
                    {term.trim().length < 2 ? 'Type at least two characters' : 'Select\u2026'}
                  </option>
                  {options.map((person) => (
                    <option key={person.id} value={String(person.id)}>
                      {directoryLabel(person) +
                        (person.email ? ' \u2014 ' + person.email : '')}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
          {memberType === 'MAILBOX' ? (
            <label className="field" style={{ margin: 0, minWidth: 220 }}>
              <span>Mailbox</span>
              <select className="hk-select" value={mailboxPick} onChange={(e) => setMailboxPick(e.target.value)}>
                <option value="">Select\u2026</option>
                {mailboxes.map((box) => (
                  <option key={box.id} value={String(box.id)}>
                    {box.address || box.displayName}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {memberType === 'DEPARTMENT' ? (
            <label className="field" style={{ margin: 0 }}>
              <span>Department id</span>
              <input
                className="hk-input"
                type="number"
                value={departmentId}
                onChange={(e) => setDepartmentId(e.target.value)}
              />
            </label>
          ) : null}
          {memberType === 'EMAIL' ? (
            <>
              <label className="field" style={{ margin: 0, minWidth: 200 }}>
                <span>E-mail</span>
                <input
                  className="hk-input"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="partner@example.com"
                />
              </label>
              <label className="field" style={{ margin: 0, minWidth: 160 }}>
                <span>Display name</span>
                <input className="hk-input" value={name} onChange={(e) => setName(e.target.value)} />
              </label>
            </>
          ) : null}
          <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => void add()}>
            {saving ? 'Adding\u2026' : 'Add member'}
          </button>
        </div>
      ) : null}

      <ErrorBanner error={members.error} />

      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th scope="col">Member</th>
              <th scope="col">Type</th>
              <th scope="col">Address</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <EmptyRow cols={4}>
                <Nothing
                  text={members.loading ? 'Loading members\u2026' : 'This list has no members yet.'}
                />
              </EmptyRow>
            ) : (
              rows.map((row) => {
                const label = s(row.name) || s(row.email) || 'Member ' + row.id;
                return (
                  <tr key={row.id}>
                    <td>{label}</td>
                    <td>
                      <ToneBadge tone="badge-neutral" label={s(row.memberType) || 'USER'} />
                    </td>
                    <td>{s(row.email) || '\u2014'}</td>
                    <td>
                      <button
                        type="button"
                        className="btn btn-xs btn-danger"
                        disabled={!canDelete || busy === row.id}
                        onClick={() => void remove(row.id, label)}
                      >
                        Remove
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Trailing-debounced directory lookup for the member picker. */
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
