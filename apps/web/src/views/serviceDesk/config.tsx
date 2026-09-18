import { useCallback, useEffect, useMemo, useState } from 'react';
import { ErrorBanner, Modal, Spinner } from '../../components/ui';
import { Check, Field, Inp, Sel, Txa } from '../hikvision/fields';
import { can, useAuth } from '../../auth';
import {
  EmptyRow,
  KpiRow,
  KpiTile,
  PriorityChip,
  Nothing,
  type Rec,
  SdHead,
  SdTabs,
  SecCard,
  fmtDT,
  fmtDur,
  has,
  label,
  num,
  s,
  sdApi,
  sdErr,
  sdPatch,
  sdPost,
  useSdMeta,
} from '../serviceDeskShared';

/*
 * Service Desk administration (spec sections 5, 6, 7, 10, 16, 17).
 *
 * Read-mostly surfaces - queues, teams, calendars, escalation levels - live in
 * the Queues workspace because they are operational. This view owns the things
 * an administrator *authors*: the service catalogue, SLA policies, escalation
 * rules and the skill matrix. Everything here is RBAC gated per tab, and every
 * write is audited server-side.
 */

/** Mirror of service_priority_for() in migration 0150 - one source of truth. */
const IMPACTS = ['ENTERPRISE', 'DEPARTMENT', 'INDIVIDUAL', 'MINOR'];
const URGENCIES = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];
const MATRIX: Record<string, Record<string, string>> = {
  ENTERPRISE: { CRITICAL: 'P1', HIGH: 'P1', MEDIUM: 'P2', LOW: 'P2' },
  DEPARTMENT: { CRITICAL: 'P1', HIGH: 'P2', MEDIUM: 'P3', LOW: 'P3' },
  INDIVIDUAL: { CRITICAL: 'P2', HIGH: 'P3', MEDIUM: 'P3', LOW: 'P4' },
  MINOR: { CRITICAL: 'P3', HIGH: 'P4', MEDIUM: 'P4', LOW: 'P4' },
};

const ACCENTS = ['SKY', 'BLUE', 'GREEN', 'AMBER', 'RED', 'VIOLET', 'SLATE'];
const TIME_BASES = ['CALENDAR', 'BUSINESS'];
const TRIGGERS = ['NO_RESPONSE', 'NO_RESOLUTION', 'SLA_WARNING', 'SLA_BREACH'];
const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];

type Tab = 'categories' | 'sla' | 'escalation' | 'skills' | 'matrix';

function opts(list: string[], extra?: { value: string; label: string }[]) {
  return [...list.map((v) => ({ value: v, label: label(v) })), ...(extra ?? [])];
}

function blank(): Rec {
  return {};
}

export default function ServiceDeskConfig() {
  const { user } = useAuth();
  const { meta } = useSdMeta();
  const [tab, setTab] = useState<Tab>('categories');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tick, setTick] = useState(0);
  const [busy, setBusy] = useState(false);

  const [cats, setCats] = useState<Rec[]>([]);
  const [queues, setQueues] = useState<Rec[]>([]);
  const [depts, setDepts] = useState<Rec[]>([]);
  const [calendars, setCalendars] = useState<Rec[]>([]);
  const [policies, setPolicies] = useState<Rec[]>([]);
  const [levels, setLevels] = useState<Rec[]>([]);
  const [rules, setRules] = useState<Rec[]>([]);
  const [skills, setSkills] = useState<Rec[]>([]);

  const [catId, setCatId] = useState<number | null>(null);
  const [catForm, setCatForm] = useState<Rec | null>(null);
  const [subForm, setSubForm] = useState<Rec | null>(null);
  const [slaForm, setSlaForm] = useState<Rec | null>(null);
  const [ruleForm, setRuleForm] = useState<Rec | null>(null);
  const [skillForm, setSkillForm] = useState<Rec | null>(null);

  const may = {
    catsView: can(user, 'service_desk.categories.view'),
    catsCreate: can(user, 'service_desk.categories.create'),
    catsUpdate: can(user, 'service_desk.categories.update'),
    slaView: can(user, 'service_desk.sla.view') || can(user, 'service_desk.sla.manage'),
    slaManage: can(user, 'service_desk.sla.manage'),
    escView: can(user, 'service_desk.escalations.view') || can(user, 'service_desk.escalations.manage'),
    escManage: can(user, 'service_desk.escalations.manage'),
    skillsView:
      can(user, 'service_desk.skills.view') ||
      can(user, 'service_desk.skills.create') ||
      can(user, 'service_desk.skills.update') ||
      can(user, 'service_desk.command.view'),
    skillsCreate: can(user, 'service_desk.skills.create'),
    skillsUpdate: can(user, 'service_desk.skills.update'),
  };

  const soft = useCallback(async <T,>(path: string, fallback: T): Promise<T> => {
    try {
      return await sdApi<T>(path);
    } catch {
      return fallback;
    }
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [ct, qz, dp, cal, pol, lv, rl, sk] = await Promise.all([
        soft<Rec[]>('/api/service-desk/categories?includeInactive=true', []),
        soft<Rec[]>('/api/service-desk/queues', []),
        soft<Rec[]>('/api/ops/hr/departments', []),
        soft<{ rows: Rec[] }>('/api/service-desk/calendars?includeInactive=true&limit=100', { rows: [] }),
        soft<{ rows: Rec[] }>('/api/service-desk/sla/policies?includeInactive=true&limit=200', { rows: [] }),
        soft<Rec[]>('/api/service-desk/escalation/levels', []),
        soft<Rec[]>('/api/service-desk/escalation/rules?includeInactive=true', []),
        soft<{ rows: Rec[] }>('/api/service-desk/skills?includeInactive=true&limit=200', { rows: [] }),
      ]);
      setCats(Array.isArray(ct) ? ct : []);
      setQueues(Array.isArray(qz) ? qz : []);
      setDepts(Array.isArray(dp) ? dp : []);
      setCalendars(cal?.rows ?? []);
      setPolicies(pol?.rows ?? []);
      setLevels(Array.isArray(lv) ? lv : []);
      setRules(Array.isArray(rl) ? rl : []);
      setSkills(sk?.rows ?? []);
      setError('');
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setLoading(false);
    }
  }, [soft]);

  useEffect(() => void load(), [load, tick]);

  const selected = useMemo(
    () => cats.find((c) => num(c.id) === catId) ?? null,
    [cats, catId]
  );

  const subs: Rec[] = useMemo(
    () => (Array.isArray(selected?.subcategories) ? (selected?.subcategories as Rec[]) : []),
    [selected]
  );

  const queueName = useCallback(
    (id: unknown) => {
      const found = queues.find((q) => num(q.id) === num(id));
      return found ? s(found.name) : '';
    },
    [queues]
  );
  const done = (msg: string) => {
    setNotice(msg);
    setError('');
    setTick((t) => t + 1);
  };

  const run = async (fn: () => Promise<unknown>, msg: string) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      done(msg);
      return true;
    } catch (e) {
      setError(sdErr(e));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const saveCat = async (form: Rec) => {
    const body = {
      name: form.name,
      description: form.description,
      icon: form.icon,
      accent: form.accent,
      defaultQueueId: form.defaultQueueId,
      defaultPriority: form.defaultPriority,
      sortOrder: form.sortOrder,
      isActive: form.isActive,
    };
    const ok = has(form.id)
      ? await run(() => sdPatch('/api/service-desk/categories/' + s(form.id), body), 'Service category updated.')
      : await run(
          () => sdPost('/api/service-desk/categories', { ...body, code: form.code }),
          'Service category created.'
        );
    if (ok) setCatForm(null);
  };

  const saveSub = async (form: Rec) => {
    const body = {
      name: form.name,
      description: form.description,
      defaultPriority: form.defaultPriority,
      defaultQueueId: form.defaultQueueId,
      requiresAsset: form.requiresAsset,
      requiresApproval: form.requiresApproval,
      sortOrder: form.sortOrder,
      isActive: form.isActive,
    };
    const ok = has(form.id)
      ? await run(() => sdPatch('/api/service-desk/subcategories/' + s(form.id), body), 'Subcategory updated.')
      : await run(
          () =>
            sdPost('/api/service-desk/subcategories', {
              ...body,
              categoryId: form.categoryId,
              code: form.code,
            }),
          'Subcategory created.'
        );
    if (ok) setSubForm(null);
  };

  const saveSla = async (form: Rec) => {
    const body = {
      name: form.name,
      description: form.description,
      priority: form.priority,
      categoryId: form.categoryId,
      departmentId: form.departmentId,
      calendarId: form.calendarId,
      timeBasis: form.timeBasis,
      responseMinutes: form.responseMinutes,
      resolutionMinutes: form.resolutionMinutes,
      warningMinutes: form.warningMinutes,
      pauseOnPending: form.pauseOnPending,
      escalationEnabled: form.escalationEnabled,
      isActive: form.isActive,
    };
    const ok = has(form.id)
      ? await run(() => sdPatch('/api/service-desk/sla/policies/' + s(form.id), body), 'SLA policy updated.')
      : await run(
          () => sdPost('/api/service-desk/sla/policies', { ...body, code: form.code }),
          'SLA policy created.'
        );
    if (ok) setSlaForm(null);
  };

  const saveRule = async (form: Rec) => {
    const body: Rec = {
      name: form.name,
      levelId: form.levelId,
      afterMinutes: form.afterMinutes,
      triggerOn: form.triggerOn,
      notifyRoles: form.notifyRoles,
      isActive: form.isActive,
    };
    // Blank category and priority mean "any" - omit them so the API does not
    // reject an empty string where it expects an enum value.
    if (has(form.categoryId)) body.categoryId = num(form.categoryId);
    if (has(form.priority)) body.priority = form.priority;
    const ok = has(form.id)
      ? await run(() => sdPatch('/api/service-desk/escalation/rules/' + s(form.id), body), 'Escalation rule updated.')
      : await run(
          () => sdPost('/api/service-desk/escalation/rules', { ...body, code: form.code }),
          'Escalation rule created.'
        );
    if (ok) setRuleForm(null);
  };

  const saveSkill = async (form: Rec) => {
    const body = { name: form.name, description: form.description, isActive: form.isActive };
    const ok = has(form.id)
      ? await run(() => sdPatch('/api/service-desk/skills/' + s(form.id), body), 'Skill updated.')
      : await run(
          () => sdPost('/api/service-desk/skills', { ...body, code: form.code }),
          'Skill created.'
        );
    if (ok) setSkillForm(null);
  };

  const sweep = () =>
    run(() => sdPost('/api/service-desk/sla/sweep'), 'SLA sweep completed. Warnings, breaches and escalations are up to date.');

  /* ---------------------------------------------------------------- tabs */

  const tabs: { key: Tab; labelText: string; show: boolean }[] = [
    { key: 'categories', labelText: 'Catalogue', show: may.catsView },
    { key: 'sla', labelText: 'SLA policies', show: may.slaView },
    { key: 'escalation', labelText: 'Escalation', show: may.escView },
    { key: 'skills', labelText: 'Skills', show: may.skillsView },
    { key: 'matrix', labelText: 'Priority matrix', show: true },
  ];
  const visible = tabs.filter((t) => t.show);
  const anyVisible = visible.length > 0;

  if (!anyVisible) {
    return (
      <div className="page sd-page">
        <SdHead title="Service Desk configuration" sub="Administration of the service catalogue, SLA and escalation." />
        <Nothing text="You do not have permission to view the Service Desk configuration." />
      </div>
    );
  }

  const catRows = cats;

  return (
    <div className="page sd-page">
      <SdHead
        title="Service Desk configuration"
        sub="The service catalogue, SLA policies, escalation ladder and skills that every ticket is measured against."
        kicker="Administration"
        actions={
          <div className="head-actions">
            {may.slaManage ? (
              <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void sweep()}>
                Run SLA sweep
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn-sm"
              disabled={loading}
              onClick={() => setTick((t) => t + 1)}
            >
              {loading ? 'Refreshing\u2026' : 'Refresh'}
            </button>
          </div>
        }
      />
      <SdTabs active="config" />

      {error ? <ErrorBanner error={error} /> : null}
      {notice ? <div className="notice-banner">{notice}</div> : null}

      <div className="tabs sd-sub-tabs">
        {visible.map((t) => (
          <button
            key={t.key}
            type="button"
            className={'tab' + (tab === t.key ? ' active' : '')}
            onClick={() => setTab(t.key)}
          >
            {t.labelText}
          </button>
        ))}
      </div>

      {loading ? (
        <div className="table-loading">
          <Spinner /> {'Loading configuration\u2026'}
        </div>
      ) : null}

      {tab === 'categories' && may.catsView ? (
        <div className="grid-2">
          <SecCard
            title="Service categories"
            sub={catRows.length + ' configured'}
            actions={
              may.catsCreate ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  onClick={() =>
                    setCatForm({ ...blank(), accent: 'SKY', defaultPriority: 'P3', sortOrder: 100, isActive: true })
                  }
                >
                  New category
                </button>
              ) : null
            }
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Category</th>
                    <th>Code</th>
                    <th>Default priority</th>
                    <th>Default queue</th>
                    <th className="sd-num">Subcats</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {catRows.length === 0 ? (
                    <EmptyRow cols={6}>No service categories have been configured yet.</EmptyRow>
                  ) : (
                    catRows.map((c) => (
                      <tr key={s(c.id)} className={num(c.id) === catId ? 'sd-row-on' : undefined}>
                        <td className="sd-subj-cell">
                          <button type="button" className="link-btn sd-subj" onClick={() => setCatId(num(c.id))}>
                            {s(c.name)}
                          </button>
                          {has(c.description) ? <div className="row-sub">{s(c.description)}</div> : null}
                        </td>
                        <td className="cell-mono">{s(c.code)}</td>
                        <td>
                          <PriorityChip value={s(c.default_priority)} compact />
                        </td>
                        <td>{queueName(c.default_queue_id) || <span className="muted">Company default desk</span>}</td>
                        <td className="sd-num">{Array.isArray(c.subcategories) ? c.subcategories.length : 0}</td>
                        <td>
                          {c.is_active === false ? (
                            <span className="badge badge-neutral">Inactive</span>
                          ) : (
                            <span className="badge badge-success">Active</span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </SecCard>

          <SecCard
            title={selected ? s(selected.name) : 'Subcategories'}
            sub={selected ? s(selected.code) : 'Pick a category on the left'}
            actions={
              selected && may.catsCreate ? (
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn btn-sm"
                    onClick={() =>
                      setSubForm({
                        ...blank(),
                        categoryId: num(selected.id),
                        defaultPriority: s(selected.default_priority) || 'P3',
                        sortOrder: 100,
                        isActive: true,
                        requiresAsset: false,
                        requiresApproval: false,
                      })
                    }
                  >
                    Add subcategory
                  </button>
                  {may.catsUpdate ? (
                    <button
                      type="button"
                      className="btn btn-sm"
                      onClick={() =>
                        setCatForm({
                          id: num(selected.id),
                          code: s(selected.code),
                          name: s(selected.name),
                          description: s(selected.description),
                          icon: s(selected.icon),
                          accent: s(selected.accent) || 'SKY',
                          defaultPriority: s(selected.default_priority) || 'P3',
                          defaultQueueId: has(selected.default_queue_id) ? num(selected.default_queue_id) : '',
                          sortOrder: num(selected.sort_order),
                          isActive: selected.is_active !== false,
                        })
                      }
                    >
                      Edit category
                    </button>
                  ) : null}
                </div>
              ) : null
            }
          >
            {selected ? (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Subcategory</th>
                      <th>Code</th>
                      <th>Priority</th>
                      <th>Requires</th>
                      <th>Status</th>
                      {may.catsUpdate ? <th /> : null}
                    </tr>
                  </thead>
                  <tbody>
                    {subs.length === 0 ? (
                      <EmptyRow cols={may.catsUpdate ? 6 : 5}>
                        No subcategories yet. Every ticket is classified down to a subcategory, so add at least one.
                      </EmptyRow>
                    ) : (
                      subs.map((sc) => (
                        <tr key={s(sc.id)}>
                          <td className="sd-subj-cell">
                            <div className="sd-subj">{s(sc.name)}</div>
                            {has(sc.description) ? <div className="row-sub">{s(sc.description)}</div> : null}
                          </td>
                          <td className="cell-mono">{s(sc.code)}</td>
                          <td>
                            <PriorityChip value={s(sc.default_priority)} compact />
                          </td>
                          <td className="muted">
                            {[
                              sc.requires_asset ? 'Asset' : '',
                              sc.requires_approval ? 'Approval' : '',
                            ]
                              .filter(Boolean)
                              .join(' \u00b7 ') || '\u2013'}
                          </td>
                          <td>
                            {sc.is_active === false ? (
                              <span className="badge badge-neutral">Inactive</span>
                            ) : (
                              <span className="badge badge-success">Active</span>
                            )}
                          </td>
                          {may.catsUpdate ? (
                            <td className="row-actions">
                              <button
                                type="button"
                                className="btn btn-xs"
                                onClick={() =>
                                  setSubForm({
                                    id: num(sc.id),
                                    categoryId: num(selected.id),
                                    code: s(sc.code),
                                    name: s(sc.name),
                                    description: s(sc.description),
                                    defaultPriority: s(sc.default_priority) || 'P3',
                                    defaultQueueId: has(sc.default_queue_id) ? num(sc.default_queue_id) : '',
                                    requiresAsset: sc.requires_asset === true,
                                    requiresApproval: sc.requires_approval === true,
                                    sortOrder: num(sc.sort_order),
                                    isActive: sc.is_active !== false,
                                  })
                                }
                              >
                                Edit
                              </button>
                            </td>
                          ) : null}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>
            ) : (
              <Nothing text="Select a service category to review and extend its subcategories." />
            )}
          </SecCard>
        </div>
      ) : null}

      {tab === 'sla' && may.slaView ? (
        <SecCard
          title="SLA policies"
          sub={
            policies.length +
            ' policies \u00b7 response and resolution clocks are measured against the calendar and business hours each policy names'
          }
          actions={
            may.slaManage ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() =>
                  setSlaForm({
                    ...blank(),
                    priority: 'P3',
                    timeBasis: 'CALENDAR',
                    responseMinutes: 240,
                    resolutionMinutes: 2880,
                    warningMinutes: 60,
                    pauseOnPending: true,
                    escalationEnabled: true,
                    isActive: true,
                  })
                }
              >
                New policy
              </button>
            ) : null
          }
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Policy</th>
                  <th>Priority</th>
                  <th>Applies to</th>
                  <th>Calendar</th>
                  <th className="sd-num">Respond</th>
                  <th className="sd-num">Resolve</th>
                  <th className="sd-num">Warn</th>
                  <th>Behaviour</th>
                  <th>Status</th>
                  {may.slaManage ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {policies.length === 0 ? (
                  <EmptyRow cols={may.slaManage ? 10 : 9}>
                    No SLA policies yet. Until one exists, tickets are not measured against a target.
                  </EmptyRow>
                ) : (
                  policies.map((p) => (
                    <tr key={s(p.id)}>
                      <td className="sd-subj-cell">
                        <div className="sd-subj">{s(p.name)}</div>
                        <div className="row-sub cell-mono">{s(p.code)}</div>
                      </td>
                      <td>
                        <PriorityChip value={s(p.priority)} compact />
                      </td>
                      <td className="muted">
                        {[s(p.category_name), s(p.department_name), s(p.ticket_type)].filter(Boolean).join(' \u00b7 ') ||
                          'All tickets'}
                      </td>
                      <td>{s(p.calendar_name) || <span className="muted">{label(p.time_basis)}</span>}</td>
                      <td className="sd-num">{fmtDur(p.response_minutes)}</td>
                      <td className="sd-num">{fmtDur(p.resolution_minutes)}</td>
                      <td className="sd-num">{p.warning_minutes ? fmtDur(p.warning_minutes) : <span className="muted">{'\u2013'}</span>}</td>
                      <td className="muted">
                        {[
                          p.pause_on_pending ? 'Pauses while pending' : '',
                          p.escalation_enabled ? 'Escalates' : 'No escalation',
                        ]
                          .filter(Boolean)
                          .join(' \u00b7 ')}
                      </td>
                      <td>
                        {p.is_active === false ? (
                          <span className="badge badge-neutral">Inactive</span>
                        ) : (
                          <span className="badge badge-success">Active</span>
                        )}
                      </td>
                      {may.slaManage ? (
                        <td className="row-actions">
                          <button
                            type="button"
                            className="btn btn-xs"
                            onClick={() =>
                              setSlaForm({
                                id: num(p.id),
                                code: s(p.code),
                                name: s(p.name),
                                description: s(p.description),
                                priority: s(p.priority) || 'P3',
                                categoryId: has(p.category_id) ? num(p.category_id) : '',
                                departmentId: has(p.department_id) ? num(p.department_id) : '',
                                calendarId: has(p.calendar_id) ? num(p.calendar_id) : '',
                                timeBasis: s(p.time_basis) || 'CALENDAR',
                                responseMinutes: num(p.response_minutes),
                                resolutionMinutes: num(p.resolution_minutes),
                                warningMinutes: num(p.warning_minutes),
                                pauseOnPending: p.pause_on_pending !== false,
                                escalationEnabled: p.escalation_enabled !== false,
                                isActive: p.is_active !== false,
                              })
                            }
                          >
                            Edit
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </SecCard>
      ) : null}

      {tab === 'escalation' && may.escView ? (
        <div className="sd-stack">
          <SecCard
            title="Escalation ladder"
            sub="Who a ticket climbs to when it is not moving (spec section 17)"
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th className="sd-num">Level</th>
                    <th>Code</th>
                    <th>Named role</th>
                    <th>Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  {levels.length === 0 ? (
                    <EmptyRow cols={4}>No escalation levels are defined for this company.</EmptyRow>
                  ) : (
                    levels.map((l) => (
                      <tr key={s(l.id)}>
                        <td className="sd-num">
                          <span className="badge badge-neutral">L{s(l.level)}</span>
                        </td>
                        <td className="cell-mono">{s(l.code)}</td>
                        <td>{s(l.name)}</td>
                        <td className="muted">
                          {s(l.description) || s(l.role_code)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </SecCard>

          <SecCard
            title="Escalation rules"
            sub={rules.length + ' rules \u00b7 category and priority scoped'}
            actions={
              may.escManage ? (
                <button
                  type="button"
                  className="btn btn-sm btn-primary"
                  disabled={levels.length === 0}
                  onClick={() =>
                    setRuleForm({
                      ...blank(),
                      triggerOn: 'NO_RESPONSE',
                      afterMinutes: 15,
                      priority: '',
                      levelId: num(levels[0]?.id),
                      notifyRoles: '',
                      isActive: true,
                    })
                  }
                >
                  New rule
                </button>
              ) : null
            }
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Rule</th>
                    <th>Category</th>
                    <th>Priority</th>
                    <th>Trigger</th>
                    <th className="sd-num">After</th>
                    <th>Escalates to</th>
                    <th>Notifies</th>
                    <th>Status</th>
                    {may.escManage ? <th /> : null}
                  </tr>
                </thead>
                <tbody>
                  {rules.length === 0 ? (
                    <EmptyRow cols={may.escManage ? 9 : 8}>
                      No escalation rules configured. Nothing will climb the ladder automatically.
                    </EmptyRow>
                  ) : (
                    rules.map((r) => (
                      <tr key={s(r.id)}>
                        <td className="sd-subj-cell">
                          <div className="sd-subj">{s(r.name)}</div>
                          <div className="row-sub cell-mono">{s(r.code)}</div>
                        </td>
                        <td>{s(r.category_name) || <span className="muted">Any category</span>}</td>
                        <td>
                          {has(r.priority) ? <PriorityChip value={s(r.priority)} compact /> : <span className="muted">Any</span>}
                        </td>
                        <td>
                          <span className="chip-chip">{label(r.trigger_on)}</span>
                        </td>
                        <td className="sd-num">{fmtDur(r.after_minutes)}</td>
                        <td>
                          {s(r.level_name) || label(r.level_code)}{' '}
                          <span className="muted">{'\u00b7 L' + s(r.level)}</span>
                        </td>
                        <td className="muted">
                          {Array.isArray(r.notify_roles) && r.notify_roles.length > 0
                            ? (r.notify_roles as unknown[]).map((x) => label(x)).join(', ')
                            : '\u2013'}
                        </td>
                        <td>
                          {r.is_active === false ? (
                            <span className="badge badge-neutral">Inactive</span>
                          ) : (
                            <span className="badge badge-success">Active</span>
                          )}
                        </td>
                        {may.escManage ? (
                          <td className="row-actions">
                            <button
                              type="button"
                              className="btn btn-xs"
                              onClick={() =>
                                setRuleForm({
                                  id: num(r.id),
                                  code: s(r.code),
                                  name: s(r.name),
                                  categoryId: has(r.category_id) ? num(r.category_id) : '',
                                  priority: s(r.priority),
                                  levelId: num(r.level_id),
                                  afterMinutes: num(r.after_minutes),
                                  triggerOn: s(r.trigger_on) || 'NO_RESPONSE',
                                  notifyRoles: Array.isArray(r.notify_roles) ? (r.notify_roles as unknown[]).join(', ') : '',
                                  isActive: r.is_active !== false,
                                })
                              }
                            >
                              Edit
                            </button>
                          </td>
                        ) : null}
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </SecCard>
        </div>
      ) : null}
      {tab === 'skills' && may.skillsView ? (
        <SecCard
          title="Service skills"
          sub={
            skills.length +
            ' skills \u00b7 skill-based routing matches work to agents who actually hold the competency'
          }
          actions={
            may.skillsCreate ? (
              <button
                type="button"
                className="btn btn-sm btn-primary"
                onClick={() => setSkillForm({ ...blank(), isActive: true })}
              >
                New skill
              </button>
            ) : null
          }
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Skill</th>
                  <th>Code</th>
                  <th className="sd-num">Agents</th>
                  <th className="sd-num">Categories</th>
                  <th>Updated</th>
                  <th>Status</th>
                  {may.skillsUpdate ? <th /> : null}
                </tr>
              </thead>
              <tbody>
                {skills.length === 0 ? (
                  <EmptyRow cols={may.skillsUpdate ? 7 : 6}>
                    No skills have been defined. Skill-based routing falls back to the queue default.
                  </EmptyRow>
                ) : (
                  skills.map((k) => (
                    <tr key={s(k.id)}>
                      <td className="sd-subj-cell">
                        <div className="sd-subj">{s(k.name)}</div>
                        {has(k.description) ? <div className="row-sub">{s(k.description)}</div> : null}
                      </td>
                      <td className="cell-mono">{s(k.code)}</td>
                      <td className="sd-num">{num(k.agent_count)}</td>
                      <td className="sd-num">{num(k.category_count)}</td>
                      <td className="muted">{fmtDT(k.updated_at)}</td>
                      <td>
                        {k.is_active === false ? (
                          <span className="badge badge-neutral">Inactive</span>
                        ) : (
                          <span className="badge badge-success">Active</span>
                        )}
                      </td>
                      {may.skillsUpdate ? (
                        <td className="row-actions">
                          <button
                            type="button"
                            className="btn btn-xs"
                            onClick={() =>
                              setSkillForm({
                                id: num(k.id),
                                code: s(k.code),
                                name: s(k.name),
                                description: s(k.description),
                                isActive: k.is_active !== false,
                              })
                            }
                          >
                            Edit
                          </button>
                        </td>
                      ) : null}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </SecCard>
      ) : null}

      {tab === 'matrix' ? (
        <div className="sd-stack">
          <KpiRow>
            <KpiTile label="Categories" value={cats.length} sub="top of the service catalogue" />
            <KpiTile
              label="Subcategories"
              value={cats.reduce(
                (total, c) => total + (Array.isArray(c.subcategories) ? c.subcategories.length : 0),
                0
              )}
              sub="classifiable services"
            />
            <KpiTile label="SLA policies" value={policies.length} sub="targets currently configured" />
            <KpiTile
              label="Escalation rules"
              value={rules.length}
              sub="category and priority scoped"
              accent="#FF0000"
              tint="#FFF1F1"
            />
          </KpiRow>

          <SecCard
            title="Priority matrix"
            sub={'IMPACT + URGENCY = PRIORITY \u00b7 mirrored from the database function service_priority_for()'}
          >
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th style={{ width: 190 }}>Impact</th>
                    {URGENCIES.map((u) => (
                      <th key={u}>{label(u)} urgency</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {IMPACTS.map((im) => (
                    <tr key={im}>
                      <td>
                        <b>{label(im)}</b>
                      </td>
                      {URGENCIES.map((u) => (
                        <td key={u}>
                          <PriorityChip value={MATRIX[im][u]} />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="muted" style={{ margin: '12px 0 0', fontSize: 12 }}>
              {'Authoritative ladder returned by the API: ' +
                (meta?.priorities && meta.priorities.length > 0 ? meta.priorities : PRIORITIES).join(' \u00b7 ')}
              {meta?.version ? ' \u00b7 module ' + s(meta.module) + ' v' + s(meta.version) : ''}
            </p>
            <p className="muted" style={{ margin: '6px 0 0', fontSize: 12 }}>
              Agents and managers with service_desk.tickets.assign may override the computed priority, but every
              override demands a reason and is written to the audit trail.
            </p>
          </SecCard>
        </div>
      ) : null}

      {catForm ? (
        <Modal
          title={has(catForm.id) ? 'Edit service category' : 'New service category'}
          onClose={() => setCatForm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setCatForm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveCat(catForm)}>
                {has(catForm.id) ? 'Save changes' : 'Create category'}
              </button>
            </>
          }
        >
          <div className="sd-form-grid">
            <Field label="Name" req>
              <Inp value={s(catForm.name)} onChange={(v) => setCatForm({ ...catForm, name: v })} />
            </Field>
            {has(catForm.id) ? null : (
              <Field label="Code" req hint="Upper-cased. Anything that is not a letter or digit becomes an underscore.">
                <Inp value={s(catForm.code)} onChange={(v) => setCatForm({ ...catForm, code: v })} />
              </Field>
            )}
            <Field label="Default priority">
              <Sel
                value={s(catForm.defaultPriority) || 'P3'}
                onChange={(v) => setCatForm({ ...catForm, defaultPriority: v })}
                options={opts(PRIORITIES)}
              />
            </Field>
            <Field label="Default queue" hint="Where new tickets in this category land before assignment.">
              <Sel
                value={s(catForm.defaultQueueId)}
                onChange={(v) => setCatForm({ ...catForm, defaultQueueId: v })}
                options={[
                  { value: '', label: 'Company default desk' },
                  ...queues.map((q) => ({ value: s(q.id), label: s(q.name) })),
                ]}
              />
            </Field>
            <Field label="Accent" hint="Drives the colour of the category tile on the portal.">
              <Sel
                value={s(catForm.accent) || 'SKY'}
                onChange={(v) => setCatForm({ ...catForm, accent: v })}
                options={ACCENTS.map((a) => ({ value: a, label: a }))}
              />
            </Field>
            <Field label="Sort order" hint="Lower numbers appear first in the picker.">
              <Inp
                type="number"
                value={s(catForm.sortOrder)}
                onChange={(v) => setCatForm({ ...catForm, sortOrder: v })}
              />
            </Field>
            <Field label="Icon" hint="Optional glyph shown beside the category name.">
              <Inp value={s(catForm.icon)} onChange={(v) => setCatForm({ ...catForm, icon: v })} />
            </Field>
            <Field label="Description">
              <Txa
                rows={2}
                value={s(catForm.description)}
                onChange={(v) => setCatForm({ ...catForm, description: v })}
              />
            </Field>
          </div>
          <Check
            label="Active"
            checked={catForm.isActive !== false}
            onChange={(v) => setCatForm({ ...catForm, isActive: v })}
            hint="Inactive categories stay on historic tickets but disappear from the request form."
          />
        </Modal>
      ) : null}

      {subForm ? (
        <Modal
          title={has(subForm.id) ? 'Edit subcategory' : 'New subcategory'}
          onClose={() => setSubForm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setSubForm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveSub(subForm)}>
                {has(subForm.id) ? 'Save changes' : 'Create subcategory'}
              </button>
            </>
          }
        >
          <div className="sd-form-grid">
            <Field label="Name" req>
              <Inp value={s(subForm.name)} onChange={(v) => setSubForm({ ...subForm, name: v })} />
            </Field>
            {has(subForm.id) ? null : (
              <Field label="Code" req hint="Upper-cased. Anything that is not a letter or digit becomes an underscore.">
                <Inp value={s(subForm.code)} onChange={(v) => setSubForm({ ...subForm, code: v })} />
              </Field>
            )}
            <Field label="Default priority" hint="Used when the requester does not pick one.">
              <Sel
                value={s(subForm.defaultPriority) || 'P3'}
                onChange={(v) => setSubForm({ ...subForm, defaultPriority: v })}
                options={opts(PRIORITIES)}
              />
            </Field>
            <Field label="Default queue">
              <Sel
                value={s(subForm.defaultQueueId)}
                onChange={(v) => setSubForm({ ...subForm, defaultQueueId: v })}
                options={[
                  { value: '', label: 'Inherit from the category' },
                  ...queues.map((q) => ({ value: s(q.id), label: s(q.name) })),
                ]}
              />
            </Field>
            <Field label="Sort order">
              <Inp
                type="number"
                value={s(subForm.sortOrder)}
                onChange={(v) => setSubForm({ ...subForm, sortOrder: v })}
              />
            </Field>
            <Field label="Description">
              <Txa
                rows={2}
                value={s(subForm.description)}
                onChange={(v) => setSubForm({ ...subForm, description: v })}
              />
            </Field>
          </div>
          <div className="sd-stack">
            <Check
              label="Requires an affected asset"
              checked={subForm.requiresAsset === true}
              onChange={(v) => setSubForm({ ...subForm, requiresAsset: v })}
            />
            <Check
              label="Requires approval before work starts"
              checked={subForm.requiresApproval === true}
              onChange={(v) => setSubForm({ ...subForm, requiresApproval: v })}
              hint="Typical for access, change and maintenance requests."
            />
            <Check
              label="Active"
              checked={subForm.isActive !== false}
              onChange={(v) => setSubForm({ ...subForm, isActive: v })}
            />
          </div>
        </Modal>
      ) : null}

      {slaForm ? (
        <Modal
          wide
          title={has(slaForm.id) ? 'Edit SLA policy' : 'New SLA policy'}
          onClose={() => setSlaForm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setSlaForm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveSla(slaForm)}>
                {has(slaForm.id) ? 'Save changes' : 'Create policy'}
              </button>
            </>
          }
        >
          <div className="sd-form-grid">
            <Field label="Name" req>
              <Inp value={s(slaForm.name)} onChange={(v) => setSlaForm({ ...slaForm, name: v })} />
            </Field>
            {has(slaForm.id) ? null : (
              <Field label="Code" req hint="Upper-cased. Anything that is not a letter or digit becomes an underscore.">
                <Inp value={s(slaForm.code)} onChange={(v) => setSlaForm({ ...slaForm, code: v })} />
              </Field>
            )}
            <Field label="Priority" hint="Every policy binds to exactly one priority.">
              <Sel
                value={s(slaForm.priority) || 'P3'}
                onChange={(v) => setSlaForm({ ...slaForm, priority: v })}
                options={opts(PRIORITIES)}
              />
            </Field>
            <Field label="Category" hint="Leave blank for a policy that covers every category.">
              <Sel
                value={s(slaForm.categoryId)}
                onChange={(v) => setSlaForm({ ...slaForm, categoryId: v })}
                placeholder="Any category"
                options={cats.map((c) => ({ value: s(c.id), label: s(c.name) }))}
              />
            </Field>
            <Field label="Department" hint="Optional. Narrows the policy to one department's tickets.">
              <Sel
                value={s(slaForm.departmentId)}
                onChange={(v) => setSlaForm({ ...slaForm, departmentId: v })}
                placeholder="Any department"
                options={depts.map((d) => ({ value: s(d.id), label: s(d.name) }))}
              />
            </Field>
            <Field
              label="Clock"
              hint="CALENDAR counts wall-clock time; BUSINESS only counts the hours the calendar says are worked."
            >
              <Sel
                value={s(slaForm.timeBasis) || 'CALENDAR'}
                onChange={(v) => setSlaForm({ ...slaForm, timeBasis: v })}
                options={opts(TIME_BASES)}
              />
            </Field>
            <Field label="Business calendar" hint="Supplies working days, hours and public holidays.">
              <Sel
                value={s(slaForm.calendarId)}
                onChange={(v) => setSlaForm({ ...slaForm, calendarId: v })}
                placeholder="Company default calendar"
                options={calendars.map((c) => ({ value: s(c.id), label: s(c.name) }))}
              />
            </Field>
            <Field label="Response target (minutes)" req hint={'= ' + fmtDur(slaForm.responseMinutes)}>
              <Inp
                type="number"
                min={1}
                value={s(slaForm.responseMinutes)}
                onChange={(v) => setSlaForm({ ...slaForm, responseMinutes: v })}
              />
            </Field>
            <Field label="Resolution target (minutes)" req hint={'= ' + fmtDur(slaForm.resolutionMinutes)}>
              <Inp
                type="number"
                min={1}
                value={s(slaForm.resolutionMinutes)}
                onChange={(v) => setSlaForm({ ...slaForm, resolutionMinutes: v })}
              />
            </Field>
            <Field
              label="Warning threshold (minutes)"
              hint={'Raise an SLA warning this long before the target. Currently ' + fmtDur(slaForm.warningMinutes) + '.'}
            >
              <Inp
                type="number"
                min={0}
                value={s(slaForm.warningMinutes)}
                onChange={(v) => setSlaForm({ ...slaForm, warningMinutes: v })}
              />
            </Field>
            <Field label="Description">
              <Txa
                rows={2}
                value={s(slaForm.description)}
                onChange={(v) => setSlaForm({ ...slaForm, description: v })}
              />
            </Field>
          </div>
          <div className="sd-stack">
            <Check
              label="Pause the clock while the ticket is pending"
              checked={slaForm.pauseOnPending !== false}
              onChange={(v) => setSlaForm({ ...slaForm, pauseOnPending: v })}
              hint="Waiting on the requester or a vendor should not burn the resolution target."
            />
            <Check
              label="Escalate when the target is threatened or missed"
              checked={slaForm.escalationEnabled !== false}
              onChange={(v) => setSlaForm({ ...slaForm, escalationEnabled: v })}
            />
            <Check
              label="Active"
              checked={slaForm.isActive !== false}
              onChange={(v) => setSlaForm({ ...slaForm, isActive: v })}
            />
          </div>
        </Modal>
      ) : null}

      {ruleForm ? (
        <Modal
          title={has(ruleForm.id) ? 'Edit escalation rule' : 'New escalation rule'}
          onClose={() => setRuleForm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setRuleForm(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void saveRule(ruleForm)}>
                {has(ruleForm.id) ? 'Save changes' : 'Create rule'}
              </button>
            </>
          }
        >
          <div className="sd-form-grid">
            <Field label="Name" req>
              <Inp value={s(ruleForm.name)} onChange={(v) => setRuleForm({ ...ruleForm, name: v })} />
            </Field>
            {has(ruleForm.id) ? null : (
              <Field label="Code" req hint="Upper-cased. Anything that is not a letter or digit becomes an underscore.">
                <Inp value={s(ruleForm.code)} onChange={(v) => setRuleForm({ ...ruleForm, code: v })} />
              </Field>
            )}
            <Field label="Trigger" req hint="What the engine watches for.">
              <Sel
                value={s(ruleForm.triggerOn) || 'NO_RESPONSE'}
                onChange={(v) => setRuleForm({ ...ruleForm, triggerOn: v })}
                options={opts(TRIGGERS)}
              />
            </Field>
            <Field label="After (minutes)" req hint={'= ' + fmtDur(ruleForm.afterMinutes)}>
              <Inp
                type="number"
                min={1}
                value={s(ruleForm.afterMinutes)}
                onChange={(v) => setRuleForm({ ...ruleForm, afterMinutes: v })}
              />
            </Field>
            <Field label="Escalate to" req>
              <Sel
                value={s(ruleForm.levelId)}
                onChange={(v) => setRuleForm({ ...ruleForm, levelId: v })}
                options={levels.map((l) => ({
                  value: s(l.id),
                  label: 'L' + s(l.level) + ' \u00b7 ' + s(l.name),
                }))}
              />
            </Field>
            <Field label="Category" hint="Leave blank to apply the rule to every category.">
              <Sel
                value={s(ruleForm.categoryId)}
                onChange={(v) => setRuleForm({ ...ruleForm, categoryId: v })}
                placeholder="Any category"
                options={cats.map((c) => ({ value: s(c.id), label: s(c.name) }))}
              />
            </Field>
            <Field label="Priority" hint="Leave blank to apply the rule to every priority.">
              <Sel
                value={s(ruleForm.priority)}
                onChange={(v) => setRuleForm({ ...ruleForm, priority: v })}
                placeholder="Any priority"
                options={opts(PRIORITIES)}
              />
            </Field>
            <Field label="Notify roles" hint="Comma separated role codes, for example SERVICE_DESK_MANAGER.">
              <Inp value={s(ruleForm.notifyRoles)} onChange={(v) => setRuleForm({ ...ruleForm, notifyRoles: v })} />
            </Field>
          </div>
          <Check
            label="Active"
            checked={ruleForm.isActive !== false}
            onChange={(v) => setRuleForm({ ...ruleForm, isActive: v })}
            hint="Inactive rules are kept for reference but the engine ignores them."
          />
        </Modal>
      ) : null}

      {skillForm ? (
        <Modal
          title={has(skillForm.id) ? 'Edit skill' : 'New skill'}
          onClose={() => setSkillForm(null)}
          footer={
            <>
              <button type="button" className="btn" onClick={() => setSkillForm(null)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void saveSkill(skillForm)}
              >
                {has(skillForm.id) ? 'Save changes' : 'Create skill'}
              </button>
            </>
          }
        >
          <div className="sd-form-grid">
            <Field label="Name" req>
              <Inp value={s(skillForm.name)} onChange={(v) => setSkillForm({ ...skillForm, name: v })} />
            </Field>
            {has(skillForm.id) ? null : (
              <Field label="Code" req hint="Upper-cased. Anything that is not a letter or digit becomes an underscore.">
                <Inp value={s(skillForm.code)} onChange={(v) => setSkillForm({ ...skillForm, code: v })} />
              </Field>
            )}
            <Field label="Description">
              <Txa
                rows={2}
                value={s(skillForm.description)}
                onChange={(v) => setSkillForm({ ...skillForm, description: v })}
              />
            </Field>
          </div>
          <Check
            label="Active"
            checked={skillForm.isActive !== false}
            onChange={(v) => setSkillForm({ ...skillForm, isActive: v })}
          />
        </Modal>
      ) : null}
    </div>
  );
}
