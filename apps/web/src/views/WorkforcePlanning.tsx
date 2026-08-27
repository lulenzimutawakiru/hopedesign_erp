import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, fmtDate, fmtMoney, fmtNum } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader } from '../components/ui';
import {
  Avatar,
  CodeChip,
  CountChip,
  employeeIdOf,
  fullNameOf,
  HrKpi,
  HrKpiGrid,
  HrPageHeader,
  HrTableEmpty,
  HrToolbar,
} from '../components/hrUi';

type Rec = Record<string, unknown>;

const POSITION_STATUSES = ['PLANNED', 'APPROVED', 'FROZEN', 'CLOSED'];
const PLAN_STATUSES = ['DRAFT', 'SUBMITTED', 'APPROVED', 'EXECUTING', 'CLOSED'];

export default function WorkforcePlanning({ path }: { path: string }) {
  const parts = path.split('/').filter(Boolean);
  const view = parts[1] ?? 'workforce';
  const id = parts[2] ?? null;
  if (view === 'org') return <OrgTree />;
  if (view === 'positions') return <Positions />;
  if (view === 'scenarios' && id) return <PlanDesk id={Number(id)} scenarioOpen />;
  if (view === 'workforce' && id) return <PlanDesk id={Number(id)} scenarioOpen={parts[3] === 'scenario'} />;
  if (view === 'workforce-plans' && id) return <PlanDesk id={Number(id)} />;
  return <WorkforcePlans />;
}

// ============================================================
// ORG CHART
// ============================================================

type OrgNodeData = {
  id: string;
  kind: 'company' | 'division' | 'dept' | 'unit' | 'team' | 'position' | 'employee';
  depth: number;
  name: string;
  code?: string;
  searchText: string;
  headcount: number;
  vacancyCount: number;
  hasVacancy: boolean;
  children: OrgNodeData[];
  emp?: Rec;
  pos?: Rec;
  deptCount?: number;
  divisionCount?: number;
  teamCount?: number;
  posCount?: number;
};

const ORG_LEGEND: { tone: string; label: string }[] = [
  { tone: 'company', label: 'Company' },
  { tone: 'division', label: 'Division' },
  { tone: 'dept', label: 'Department' },
  { tone: 'unit', label: 'Org unit' },
  { tone: 'team', label: 'Team' },
  { tone: 'position', label: 'Position' },
];

function sumHeadcount(children: OrgNodeData[]): number {
  return children.reduce((s, c) => s + c.headcount, 0);
}

function sumVacancies(children: OrgNodeData[]): number {
  return children.reduce((s, c) => s + c.vacancyCount, 0);
}

function buildOrgTree(doc: Rec): OrgNodeData {
  const company = (doc.company ?? {}) as Rec;
  const divisions = (doc.divisions as Rec[]) ?? [];
  const without = (doc.departmentsWithoutDivision as Rec[]) ?? [];
  const children = [
    ...divisions.map((div) => buildDivision(div, 1)),
    ...without.map((d) => buildDepartment(d, 1)),
  ];
  return {
    id: 'company',
    kind: 'company',
    depth: 0,
    name: String(company.name ?? 'Company'),
    code: String(company.code ?? ''),
    searchText: [String(company.name ?? ''), String(company.code ?? '')].join(' ').toLowerCase(),
    headcount: sumHeadcount(children),
    vacancyCount: sumVacancies(children),
    hasVacancy: children.some((c) => c.hasVacancy),
    divisionCount: divisions.length,
    children,
  };
}

function buildDivision(div: Rec, depth: number): OrgNodeData {
  const departments = (div.departments as Rec[]) ?? [];
  const children = departments.map((d) => buildDepartment(d, depth + 1));
  return {
    id: `div-${String(div.id)}`,
    kind: 'division',
    depth,
    name: String(div.name ?? '-'),
    searchText: String(div.name ?? '').toLowerCase(),
    headcount: sumHeadcount(children),
    vacancyCount: sumVacancies(children),
    hasVacancy: children.some((c) => c.hasVacancy),
    deptCount: children.length,
    children,
  };
}

function buildDepartment(dept: Rec, depth: number): OrgNodeData {
  const orgUnits = (dept.orgUnits as Rec[]) ?? [];
  const teams = (dept.teams as Rec[]) ?? [];
  const positions = (dept.positions as Rec[]) ?? [];
  const employees = (dept.employees as Rec[]) ?? [];
  const children = [
    ...orgUnits.map((u) => buildOrgUnit(u, depth + 1)),
    ...teams.map((t) => buildTeam(t, depth + 1)),
    ...positions.map((p) => buildPosition(p, depth + 1)),
    ...employees.map((e) => buildEmployee(e, depth + 1)),
  ];
  return {
    id: `dept-${String(dept.id)}`,
    kind: 'dept',
    depth,
    name: String(dept.name ?? '-'),
    code: String(dept.code ?? ''),
    searchText: [String(dept.name ?? ''), String(dept.code ?? '')].join(' ').toLowerCase(),
    headcount: sumHeadcount(children),
    vacancyCount: sumVacancies(children),
    hasVacancy: children.some((c) => c.hasVacancy),
    teamCount: teams.length,
    posCount: positions.length,
    children,
  };
}

function buildOrgUnit(ou: Rec, depth: number): OrgNodeData {
  const teams = (ou.teams as Rec[]) ?? [];
  const employees = (ou.employees as Rec[]) ?? [];
  const children = [
    ...teams.map((t) => buildTeam(t, depth + 1)),
    ...employees.map((e) => buildEmployee(e, depth + 1)),
  ];
  return {
    id: `unit-${String(ou.id)}`,
    kind: 'unit',
    depth,
    name: String(ou.name ?? '-'),
    searchText: String(ou.name ?? '').toLowerCase(),
    headcount: sumHeadcount(children),
    vacancyCount: sumVacancies(children),
    hasVacancy: children.some((c) => c.hasVacancy),
    teamCount: teams.length,
    children,
  };
}

function buildTeam(team: Rec, depth: number): OrgNodeData {
  const employees = (team.employees as Rec[]) ?? [];
  const children = employees.map((e) => buildEmployee(e, depth + 1));
  return {
    id: `team-${String(team.id)}`,
    kind: 'team',
    depth,
    name: String(team.name ?? '-'),
    searchText: String(team.name ?? '').toLowerCase(),
    headcount: sumHeadcount(children),
    vacancyCount: sumVacancies(children),
    hasVacancy: children.some((c) => c.hasVacancy),
    children,
  };
}

function buildPosition(pos: Rec, depth: number): OrgNodeData {
  const employees = (pos.employees as Rec[]) ?? [];
  const approved = Number(pos.approvedHeadcount ?? 0);
  const occupied = Number(pos.occupied ?? 0);
  const vacancy = Math.max(0, Number(pos.vacancy ?? approved - occupied));
  const children = employees.map((e) => buildEmployee(e, depth + 1));
  return {
    id: `pos-${String(pos.id)}`,
    kind: 'position',
    depth,
    name: String(pos.title ?? '-'),
    code: String(pos.code ?? ''),
    searchText: [String(pos.title ?? ''), String(pos.code ?? '')].join(' ').toLowerCase(),
    headcount: employees.length,
    vacancyCount: vacancy,
    hasVacancy: vacancy > 0,
    children,
    pos,
  };
}

function buildEmployee(emp: Rec, depth: number): OrgNodeData {
  return {
    id: `emp-${String(emp.id ?? 'x')}`,
    kind: 'employee',
    depth,
    name: fullNameOf(emp) || '\u2014',
    searchText: [fullNameOf(emp), employeeIdOf(emp), String(emp.position ?? ''), String(emp.status ?? '')].join(' ').toLowerCase(),
    headcount: 1,
    vacancyCount: 0,
    hasVacancy: false,
    children: [],
    emp,
  };
}

function defaultExpanded(tree: OrgNodeData): Set<string> {
  const ids = new Set<string>();
  const walk = (n: OrgNodeData, depth: number) => {
    ids.add(n.id);
    if (depth >= 2) return;
    n.children.forEach((c) => walk(c, depth + 1));
  };
  walk(tree, 0);
  return ids;
}

function orgEmptyNote(node: OrgNodeData, vacantOnly: boolean): string {
  if (vacantOnly) return 'No vacancies below this level.';
  switch (node.kind) {
    case 'company': return 'No departments yet - add departments in organisation setup to start building the tree.';
    case 'division': return 'No departments in this division yet.';
    case 'dept': return 'No org units, teams, positions or staff below this department.';
    case 'unit': return 'No teams or staff in this org unit.';
    case 'team': return 'No staff assigned to this team.';
    case 'position': return 'Vacant - no active employee assigned to this position.';
    default: return '';
  }
}

function OrgTree() {
  const [doc, setDoc] = useState<Rec | null>(null);
  const [tree, setTree] = useState<OrgNodeData | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [vacantOnly, setVacantOnly] = useState(false);
  const [legend, setLegend] = useState(false);
  const [expanded, setExpanded] = useState<Set<string>>(new Set(['company']));

  useEffect(() => {
    api<{ data: Rec }>('/api/ops/hcm/org-chart')
      .then((r) => {
        const t = buildOrgTree(r.data);
        setTree(t);
        setDoc(r.data);
        setExpanded(defaultExpanded(t));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Org chart failed'));
  }, []);

  const flat = useMemo(() => {
    const nodes: OrgNodeData[] = [];
    const parents = new Map<string, string | null>();
    const walk = (n: OrgNodeData, parent: string | null) => {
      nodes.push(n);
      parents.set(n.id, parent);
      n.children.forEach((c) => walk(c, n.id));
    };
    if (tree) walk(tree, null);
    const descendants = new Map<string, string[]>();
    for (const n of nodes) {
      const ds: string[] = [];
      const stack = [...n.children];
      while (stack.length) {
        const cur = stack.pop()!;
        ds.push(cur.id);
        stack.push(...cur.children);
      }
      descendants.set(n.id, ds);
    }
    return { nodes, parents, descendants };
  }, [tree]);

  const query = q.trim().toLowerCase();
  const matchIds = useMemo(() => {
    const ids = new Set<string>();
    if (!query) return ids;
    flat.nodes.forEach((n) => {
      if (n.searchText.includes(query)) ids.add(n.id);
    });
    return ids;
  }, [flat, query]);

  const revealIds = useMemo(() => {
    const ids = new Set<string>();
    if (!query) return ids;
    matchIds.forEach((id) => {
      let parent = flat.parents.get(id);
      while (parent) {
        ids.add(parent);
        parent = flat.parents.get(parent);
      }
    });
    return ids;
  }, [flat, matchIds, query]);

  const activeExpanded = useMemo(() => {
    if (!query) return expanded;
    const next = new Set(expanded);
    revealIds.forEach((id) => next.add(id));
    matchIds.forEach((id) => next.add(id));
    return next;
  }, [expanded, query, revealIds, matchIds]);

  if (error && !tree) return <ErrorBanner error={error} />;
  if (!doc || !tree) return <PageLoader label="Building org chart" />;

  const company = (doc.company ?? {}) as Rec;
  const summary = (doc.summary ?? {}) as Rec;
  const divisions = (doc.divisions as Rec[]) ?? [];
  const branches = (doc.branches as Rec[]) ?? [];
  const companyId = Number(company.id);
  const companyCode = String(company.code ?? '');
  const headcount = Number(summary.headcount ?? tree.headcount);
  const openPositions = Number(summary.activePositions ?? 0);
  const vacant = Number(summary.vacantPositions ?? 0);
  const fillPct = openPositions > 0 ? Math.round(((openPositions - vacant) / openPositions) * 100) : 0;

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const focusBranch = (id: string) => setExpanded(new Set([id, ...(flat.descendants.get(id) ?? [])]));
  const expandAll = () => setExpanded(new Set(flat.nodes.map((n) => n.id)));
  const collapseAll = () => setExpanded(new Set(['company']));

  return (
    <div className="page">
      <HrPageHeader
        kicker="Organization management"
        title="Org chart"
        subtitle={`Live organisation tree for ${String(company.name ?? 'the company')}${companyCode ? ` (${companyCode}${companyId ? ` \u00b7 #${companyId}` : ''})` : ''} - divisions, departments, org units, teams and positions with headcount and vacancy.`}
        actions={
          <>
            <button className="btn" onClick={() => navigate('/people/positions')}>Positions</button>
            <button className="btn btn-primary" onClick={() => navigate('/people/workforce')}>Workforce plans</button>
          </>
        }
      />
      {error && <ErrorBanner error={error} />}
      <HrKpiGrid>
        <HrKpi label="Headcount" value={fmtNum(headcount)} sub={`${fmtNum(divisions.length)} divisions`} />
        <HrKpi label="Active positions" value={fmtNum(openPositions)} sub={`${fillPct}% filled`} />
        <HrKpi label="Vacant" value={fmtNum(vacant)} sub="open seats" accent="#D97706" tint="rgba(217, 119, 6, 0.12)" />
        <HrKpi label="Departments" value={fmtNum(summary.departments)} sub={`${fmtNum(branches.length)} branches`} accent="#1261A0" tint="rgba(18, 97, 160, 0.12)" />
        <HrKpi label="Org units" value={fmtNum(summary.orgUnits)} sub="operational units" accent="#168A5B" tint="rgba(22, 138, 91, 0.12)" />
        <HrKpi label="Teams" value={fmtNum(summary.teams)} sub="cross-functional groups" accent="#4F46A5" tint="rgba(79, 70, 165, 0.12)" />
      </HrKpiGrid>
      <section className="card card-pad">
        <div className="card-head">
          <h3>Organisation tree</h3>
          <span className="org-head-meta">
            <CodeChip>{companyCode || `#${companyId}`}</CodeChip>
            <span className="muted">{String(company.name ?? '-')} {'\u00b7'} #{companyId} {'\u00b7'} {fmtNum(branches.length)} branches</span>
          </span>
        </div>
        <div className="org-tools">
          <label className="org-search">
            <span className="org-search-icon" aria-hidden />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people, teams, positions..." aria-label="Search org chart" />
            {q && <button type="button" className="org-search-clear" onClick={() => setQ('')} aria-label="Clear search">&times;</button>}
          </label>
          <div className="org-tool-btns">
            <button type="button" className={'btn btn-sm' + (vacantOnly ? ' btn-primary' : '')} onClick={() => setVacantOnly((v) => !v)} title="Show only branches that contain open seats">
              {vacantOnly ? 'Show all nodes' : 'Vacancies only'}
            </button>
            <button type="button" className="btn btn-sm" onClick={expandAll}>Expand all</button>
            <button type="button" className="btn btn-sm" onClick={collapseAll}>Collapse all</button>
            <button type="button" className={'btn btn-sm btn-ghost' + (legend ? ' btn-ghost-on' : '')} onClick={() => setLegend((v) => !v)}>Legend</button>
          </div>
        </div>
        {query && (
          <p className="org-match-summary">
            {matchIds.size === 0 ? 'No matches found.' : `${matchIds.size} match${matchIds.size === 1 ? '' : 'es'} found.`}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => setQ('')}>Clear search</button>
          </p>
        )}
        {legend && (
          <div className="org-legend">
            {ORG_LEGEND.map((l) => (
              <span key={l.tone} className="org-legend-item" data-tone={l.tone}><i className="org-dot" aria-hidden />{l.label}</span>
            ))}
          </div>
        )}
        <div className="org-tree">
          <OrgRow
            node={tree}
            expanded={activeExpanded}
            matchIds={matchIds}
            query={query}
            vacantOnly={vacantOnly}
            onToggle={toggle}
            onFocus={focusBranch}
          />
        </div>
      </section>
    </div>
  );
}

function OrgRow({ node, expanded, matchIds, query, vacantOnly, onToggle, onFocus }: {
  node: OrgNodeData;
  expanded: Set<string>;
  matchIds: Set<string>;
  query: string;
  vacantOnly: boolean;
  onToggle: (id: string) => void;
  onFocus: (id: string) => void;
}) {
  if (node.emp) return <EmployeeLeafCard emp={node.emp} matched={!!query && matchIds.has(node.id)} />;
  const open = expanded.has(node.id);
  const matched = !!query && matchIds.has(node.id);
  const kids = vacantOnly ? node.children.filter((c) => c.hasVacancy) : node.children;
  return (
    <div className={'org-node-card' + (matched ? ' org-match' : '')} data-tone={node.kind} data-depth={node.depth}>
      <div
        className="org-card-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => onToggle(node.id)}
        onDoubleClick={() => onFocus(node.id)}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget) return;
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle(node.id);
          }
        }}
      >
        <span className={'org-chev' + (open ? ' open' : '')} aria-hidden />
        <span className="org-dot" aria-hidden />
        <span className="org-label">{node.name}{node.code ? <CodeChip>{node.code}</CodeChip> : null}</span>
        <OrgNodeMeta node={node} />
        {node.children.length > 0 && (
          <span className="org-focus">
            <button type="button" className="btn btn-sm btn-ghost" title="Expand this whole branch and collapse the rest" onClick={(e) => { e.stopPropagation(); onFocus(node.id); }}>
              Focus
            </button>
          </span>
        )}
      </div>
      {open && (
        kids.length > 0
          ? <div className="org-children">{kids.map((k) => <OrgRow key={k.id} node={k} expanded={expanded} matchIds={matchIds} query={query} vacantOnly={vacantOnly} onToggle={onToggle} onFocus={onFocus} />)}</div>
          : <p className="org-note">{orgEmptyNote(node, vacantOnly)}</p>
      )}
    </div>
  );
}

function OrgNodeMeta({ node }: { node: OrgNodeData }) {
  if (node.kind === 'company') {
    return (
      <>
        <CountChip value={node.headcount} title="people" />
        <span className="muted">{fmtNum(node.divisionCount ?? 0)} division{node.divisionCount === 1 ? '' : 's'}</span>
        {node.vacancyCount > 0 && <span className="org-vacant">{fmtNum(node.vacancyCount)} vacant</span>}
      </>
    );
  }
  if (node.kind === 'division') {
    return (
      <>
        <CountChip value={node.headcount} title="people" />
        <span className="muted">{fmtNum(node.deptCount ?? 0)} department{node.deptCount === 1 ? '' : 's'}</span>
        {node.vacancyCount > 0 && <span className="org-vacant">{fmtNum(node.vacancyCount)} vacant</span>}
      </>
    );
  }
  if (node.kind === 'dept') {
    return (
      <>
        <CountChip value={node.headcount} title="people" />
        <span className="muted">{fmtNum(node.posCount ?? 0)} positions</span>
        {node.vacancyCount > 0 && <span className="org-vacant">{fmtNum(node.vacancyCount)} vacant</span>}
      </>
    );
  }
  if (node.kind === 'unit') {
    return (
      <>
        <CountChip value={node.headcount} title="people" />
        <span className="muted">{fmtNum(node.teamCount ?? 0)} team{node.teamCount === 1 ? '' : 's'}</span>
        {node.vacancyCount > 0 && <span className="org-vacant">{fmtNum(node.vacancyCount)} vacant</span>}
      </>
    );
  }
  if (node.kind === 'team') {
    return (
      <>
        <CountChip value={node.headcount} title="people" />
        <span className="muted">team</span>
      </>
    );
  }
  const p = node.pos ?? {};
  const approved = Number(p.approvedHeadcount ?? 0);
  const occupied = Number(p.occupied ?? 0);
  const pct = approved > 0 ? Math.min(100, Math.round((occupied / approved) * 100)) : 0;
  return (
    <>
      <span className="org-fill" title={`${fmtNum(occupied)} of ${fmtNum(approved)} filled`}><span style={{ width: `${pct}%` }} /></span>
      <span className="muted">{fmtNum(occupied)}/{fmtNum(approved)} filled</span>
      {node.vacancyCount > 0 && <span className="org-vacant">{fmtNum(node.vacancyCount)} vacant</span>}
    </>
  );
}

function EmployeeLeafCard({ emp, matched }: { emp: Rec; matched: boolean }) {
  const id = String(emp.id ?? '');
  return (
    <div
      className={'org-leaf' + (id ? ' org-leaf-click' : '') + (matched ? ' org-match' : '')}
      onClick={id ? () => navigate(`/people/employees/${id}`) : undefined}
    >
      <Avatar name={fullNameOf(emp)} size="sm" meta={false} />
      <span className="org-leaf-meta">
        <span className="org-leaf-name">{fullNameOf(emp) || '\u2014'}</span>
        <span className="org-leaf-sub">
          {employeeIdOf(emp) ? <CodeChip>{employeeIdOf(emp)}</CodeChip> : null}
          {String(emp.position ?? '') && <span className="muted">{String(emp.position)}</span>}
        </span>
      </span>
      {emp.status ? <Badge value={emp.status} /> : null}
    </div>
  );
}

// ============================================================
// POSITIONS
// ============================================================

function Positions() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [depts, setDepts] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [q, setQ] = useState('');
  const [deptId, setDeptId] = useState('');
  const [status, setStatus] = useState('');
  const [composer, setComposer] = useState(false);
  const load = useCallback(() => {
    const params = new URLSearchParams();
    params.set('pageSize', '200');
    if (q.trim()) params.set('q', q.trim());
    if (deptId) params.set('departmentId', deptId);
    if (status) params.set('status', status);
    api<{ data: Rec[] }>(`/api/ops/hcm/positions?${params.toString()}`)
      .then((r) => setRows(r.data ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Positions failed'));
  }, [q, deptId, status]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hr/departments')
      .then((r) => setDepts(r.data ?? []))
      .catch(() => undefined);
  }, []);
  const deptName = (id: unknown) => {
    const d = depts.find((x) => Number(x.id) === Number(id));
    return d ? String(d.name ?? '-') : '-';
  };
  return (
    <div className="page">
      <HrPageHeader
        kicker="Organization management"
        title="Positions"
        subtitle="Approved headcount per position, separated from the people in them. Occupied and vacancy update automatically from active employees."
        actions={can(user, 'hr.positions.create') ? <button className="btn btn-primary" onClick={() => setComposer(true)}>New position</button> : undefined}
      />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <HrToolbar>
        <input type="search" placeholder="Search title or code..." value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search positions" />
        <select value={deptId} onChange={(e) => setDeptId(e.target.value)} aria-label="Filter by department">
          <option value="">All departments</option>
          {depts.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.name ?? '-')}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {POSITION_STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
        </select>
      </HrToolbar>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Code</th><th>Title</th><th>Department</th><th>Branch</th><th className="cell-num">Approved</th><th className="cell-num">Occupied</th><th className="cell-num">Vacancy</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)}>
                <td className="cell-mono">{String(r.code ?? '-')}</td>
                <td><strong>{String(r.title ?? '-')}</strong></td>
                <td>{String(r.departmentName ?? deptName(r.departmentId))}</td>
                <td>{String(r.branchName ?? '-')}</td>
                <td className="cell-num">{fmtNum(r.approvedHeadcount)}</td>
                <td className="cell-num">{fmtNum(r.occupied)}</td>
                <td className="cell-num">{fmtNum(r.vacancy)}</td>
                <td><Badge value={r.status} /></td>
              </tr>
            ))}
            {rows.length === 0 && <HrTableEmpty colSpan={8} icon="◦" title="No positions found" hint="Try clearing the filters, or create a new position to model approved headcount." />}
          </tbody>
        </table>
      </div>
      {composer && <PositionComposer depts={depts} onClose={() => setComposer(false)} onSaved={() => { setComposer(false); setNotice('Position created'); load(); }} />}
    </div>
  );
}

function PositionComposer({ depts, onClose, onSaved }: { depts: Rec[]; onClose: () => void; onSaved: () => void }) {
  const [title, setTitle] = useState('');
  const [departmentId, setDepartmentId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [approvedHeadcount, setApprovedHeadcount] = useState('1');
  const [salaryMin, setSalaryMin] = useState('');
  const [salaryMax, setSalaryMax] = useState('');
  const [currency, setCurrency] = useState('UGX');
  const [skills, setSkills] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [branches, setBranches] = useState<Rec[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/hcm/org-refs')
      .then((r) => setBranches((r.data.branches as Rec[]) ?? []))
      .catch(() => undefined);
  }, []);
  const save = async () => {
    setBusy(true); setError('');
    try {
      await api<{ data: Rec }>('/api/ops/hcm/positions', {
        method: 'POST',
        body: JSON.stringify({
          title: title.trim(),
          departmentId: departmentId ? Number(departmentId) : null,
          branchId: branchId ? Number(branchId) : null,
          approvedHeadcount: approvedHeadcount ? Number(approvedHeadcount) : 1,
          salaryMin: salaryMin ? Number(salaryMin) : null,
          salaryMax: salaryMax ? Number(salaryMax) : null,
          currency,
          requiredSkills: skills.split(',').map((s) => s.trim()).filter(Boolean),
          jobDescription: jobDescription.trim() || null,
        }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New position" onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !title.trim()} onClick={save}>{busy ? 'Saving...' : 'Create position'}</button>
      </>}>
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <div className="field field-required"><label>Position title</label><input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Production Supervisor" /></div>
        <div className="field"><label>Department</label><select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}><option value="">None</option>{depts.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.name ?? '-')}</option>)}</select></div>
        <div className="field"><label>Branch</label><select value={branchId} onChange={(e) => setBranchId(e.target.value)}><option value="">Default</option>{branches.map((b) => <option key={String(b.id)} value={String(b.id)}>{String(b.name ?? '-')}</option>)}</select></div>
        <div className="field"><label>Approved headcount</label><input type="number" min={0} value={approvedHeadcount} onChange={(e) => setApprovedHeadcount(e.target.value)} /></div>
        <div className="field"><label>Salary min</label><input type="number" min={0} value={salaryMin} onChange={(e) => setSalaryMin(e.target.value)} /></div>
        <div className="field"><label>Salary max</label><input type="number" min={0} value={salaryMax} onChange={(e) => setSalaryMax(e.target.value)} /></div>
        <div className="field"><label>Currency</label><input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="UGX" /></div>
        <div className="field"><label>Required skills (comma separated)</label><input value={skills} onChange={(e) => setSkills(e.target.value)} placeholder="SAP, Lean manufacturing" /></div>
      </div>
      <div className="field" style={{ marginTop: 12 }}><label>Job description</label><textarea rows={4} value={jobDescription} onChange={(e) => setJobDescription(e.target.value)} /></div>
    </Modal>
  );
}

// ============================================================
// WORKFORCE PLANS
// ============================================================

function WorkforcePlans() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [status, setStatus] = useState('');
  const [composer, setComposer] = useState(false);
  const load = useCallback(() => {
    const params = new URLSearchParams();
    params.set('pageSize', '100');
    if (status) params.set('status', status);
    api<{ data: { rows: Rec[] } }>(`/api/ops/hcm/workforce-plans?${params.toString()}`)
      .then((r) => setRows(r.data.rows ?? []))
      .catch((e) => setError(e instanceof Error ? e.message : 'Workforce plans failed'));
  }, [status]);
  useEffect(() => { load(); }, [load]);
  return (
    <div className="page">
      <HrPageHeader
        kicker="Workforce planning"
        title="Workforce plans"
        subtitle="Current headcount, planned headcount and hiring requirements by position and department - with what-if scenario costing in UGX."
        actions={can(user, 'hr.workforce_plans.create') ? <button className="btn btn-primary" onClick={() => setComposer(true)}>New plan</button> : undefined}
      />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <HrToolbar>
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          {PLAN_STATUSES.map((s) => <option key={s} value={s}>{s.toLowerCase()}</option>)}
        </select>
      </HrToolbar>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Plan</th><th>Name</th><th className="cell-num">FY</th><th>Department</th><th>Branch</th><th className="cell-num">Current</th><th className="cell-num">Planned</th><th className="cell-num">Gap</th><th className="cell-num">Hiring</th><th className="cell-num">Budget</th><th className="cell-num">Scenarios</th><th>Status</th></tr></thead>
          <tbody>
            {rows.map((r) => {
              const gap = Math.max(0, Number(r.plannedHeadcount ?? 0) - Number(r.currentHeadcount ?? 0));
              return (
                <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/workforce/${String(r.id)}`)}>
                  <td className="cell-mono">{String(r.planNo ?? '-')}</td>
                  <td><strong>{String(r.planName ?? '-')}</strong></td>
                  <td className="cell-num">{fmtNum(r.fiscalYear)}</td>
                  <td>{String(r.departmentName ?? '-')}</td>
                  <td>{String(r.branchName ?? '-')}</td>
                  <td className="cell-num">{fmtNum(r.currentHeadcount)}</td>
                  <td className="cell-num">{fmtNum(r.plannedHeadcount)}</td>
                  <td className="cell-num">{fmtNum(gap)}</td>
                  <td className="cell-num">{fmtNum(r.hiringRequirement)}</td>
                  <td className="cell-num">{fmtMoney(r.budgetAmount)}</td>
                  <td className="cell-num">{fmtNum(r.scenarioCount)}</td>
                  <td><Badge value={r.status} /></td>
                </tr>
              );
            })}
            {rows.length === 0 && <HrTableEmpty colSpan={12} icon="◔" title="No workforce plans yet" hint="Create a plan to model headcount, hiring requirements and cost." />}
          </tbody>
        </table>
      </div>
      {composer && (
        <PlanComposer
          onClose={() => setComposer(false)}
          onSaved={(planId: number) => {
            setComposer(false);
            setNotice('Workforce plan created');
            navigate(`/people/workforce/${planId}`);
          }}
        />
      )}
    </div>
  );
}

type PlanLine = {
  key: number;
  positionId: string;
  currentHeadcount: string;
  plannedHeadcount: string;
  expectedDepartures: string;
  retirements: string;
  newPositions: string;
  salaryBudget: string;
};

function PlanComposer({ onClose, onSaved }: { onClose: () => void; onSaved: (planId: number) => void }) {
  const [planName, setPlanName] = useState('');
  const [fiscalYear, setFiscalYear] = useState(String(new Date().getFullYear()));
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [budgetAmount, setBudgetAmount] = useState('');
  const [currency, setCurrency] = useState('UGX');
  const [departmentId, setDepartmentId] = useState('');
  const [notes, setNotes] = useState('');
  const [depts, setDepts] = useState<Rec[]>([]);
  const [positions, setPositions] = useState<Rec[]>([]);
  const [lines, setLines] = useState<PlanLine[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api<{ data: Rec }>('/api/ops/hcm/org-refs')
      .then((r) => {
        setDepts((r.data.departments as Rec[]) ?? []);
        setPositions((r.data.positions as Rec[]) ?? []);
      })
      .catch(() => undefined);
  }, []);
  const addLine = () => {
    setLines((prev) => [...prev, { key: Date.now() + Math.floor(Math.random() * 1000), positionId: '', currentHeadcount: '0', plannedHeadcount: '0', expectedDepartures: '0', retirements: '0', newPositions: '0', salaryBudget: '' }]);
  };
  const patchLine = (key: number, field: keyof PlanLine, value: string) => {
    setLines((prev) => prev.map((l) => (l.key === key ? { ...l, [field]: value } : l)));
  };
  const removeLine = (key: number) => setLines((prev) => prev.filter((l) => l.key !== key));
  const save = async () => {
    setBusy(true); setError('');
    try {
      const res = await api<{ data: Rec }>('/api/ops/hcm/workforce-plans', {
        method: 'POST',
        body: JSON.stringify({
          planName: planName.trim(),
          fiscalYear: fiscalYear.trim() || String(new Date().getFullYear()),
          periodStart: periodStart || null,
          periodEnd: periodEnd || null,
          budgetAmount: budgetAmount ? Number(budgetAmount) : undefined,
          currency,
          departmentId: departmentId ? Number(departmentId) : null,
          notes: notes.trim() || null,
          lines: lines.filter((l) => l.positionId).map((l) => ({
            positionId: Number(l.positionId),
            currentHeadcount: Number(l.currentHeadcount || 0),
            plannedHeadcount: Number(l.plannedHeadcount || 0),
            expectedDepartures: Number(l.expectedDepartures || 0),
            retirements: Number(l.retirements || 0),
            newPositions: Number(l.newPositions || 0),
            salaryBudget: l.salaryBudget ? Number(l.salaryBudget) : undefined,
          })),
        }),
      });
      onSaved(Number(res.data.planId));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title="New workforce plan" onClose={onClose} wide
      footer={<>
        <button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" disabled={busy || !planName.trim()} onClick={save}>{busy ? 'Saving...' : 'Create plan'}</button>
      </>}>
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <div className="field field-required"><label>Plan name</label><input value={planName} onChange={(e) => setPlanName(e.target.value)} placeholder="Production expansion 2026" /></div>
        <div className="field"><label>Fiscal year</label><input value={fiscalYear} onChange={(e) => setFiscalYear(e.target.value)} placeholder="2026" /></div>
        <div className="field"><label>Period start</label><input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></div>
        <div className="field"><label>Period end</label><input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></div>
        <div className="field"><label>Budget amount</label><input type="number" min={0} value={budgetAmount} onChange={(e) => setBudgetAmount(e.target.value)} /></div>
        <div className="field"><label>Currency</label><input value={currency} onChange={(e) => setCurrency(e.target.value)} placeholder="UGX" /></div>
        <div className="field"><label>Department</label><select value={departmentId} onChange={(e) => setDepartmentId(e.target.value)}><option value="">All</option>{depts.map((d) => <option key={String(d.id)} value={String(d.id)}>{String(d.name ?? '-')}</option>)}</select></div>
      </div>
      <div className="field" style={{ marginTop: 12 }}><label>Notes</label><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></div>
      <div className="card-head" style={{ marginTop: 16 }}><h3>Plan lines</h3><button className="btn btn-sm" onClick={addLine}>Add line</button></div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Position</th><th className="cell-num">Current</th><th className="cell-num">Planned</th><th className="cell-num">Departures</th><th className="cell-num">Retirements</th><th className="cell-num">New positions</th><th className="cell-num">Salary budget</th><th></th></tr></thead>
          <tbody>
            {lines.map((l) => (
              <tr key={l.key}>
                <td>
                  <select value={l.positionId} onChange={(e) => patchLine(l.key, 'positionId', e.target.value)} aria-label="Position" style={{ minWidth: 220 }}>
                    <option value="">Select position...</option>
                    {positions.map((p) => <option key={String(p.id)} value={String(p.id)}>{String(p.code ?? '')} - {String(p.title ?? '')}</option>)}
                  </select>
                </td>
                <td className="cell-num"><input type="number" min={0} style={{ width: 80 }} value={l.currentHeadcount} onChange={(e) => patchLine(l.key, 'currentHeadcount', e.target.value)} aria-label="Current headcount" /></td>
                <td className="cell-num"><input type="number" min={0} style={{ width: 80 }} value={l.plannedHeadcount} onChange={(e) => patchLine(l.key, 'plannedHeadcount', e.target.value)} aria-label="Planned headcount" /></td>
                <td className="cell-num"><input type="number" min={0} style={{ width: 80 }} value={l.expectedDepartures} onChange={(e) => patchLine(l.key, 'expectedDepartures', e.target.value)} aria-label="Expected departures" /></td>
                <td className="cell-num"><input type="number" min={0} style={{ width: 80 }} value={l.retirements} onChange={(e) => patchLine(l.key, 'retirements', e.target.value)} aria-label="Retirements" /></td>
                <td className="cell-num"><input type="number" min={0} style={{ width: 80 }} value={l.newPositions} onChange={(e) => patchLine(l.key, 'newPositions', e.target.value)} aria-label="New positions" /></td>
                <td className="cell-num"><input type="number" min={0} style={{ width: 110 }} value={l.salaryBudget} onChange={(e) => patchLine(l.key, 'salaryBudget', e.target.value)} aria-label="Salary budget" /></td>
                <td><button className="btn btn-sm" onClick={() => removeLine(l.key)}>Remove</button></td>
              </tr>
            ))}
            {lines.length === 0 && <tr><td colSpan={8} className="muted" style={{ textAlign: 'center', padding: 16 }}>No lines yet - add positions to model headcount change.</td></tr>}
          </tbody>
        </table>
      </div>
    </Modal>
  );
}

// ============================================================
// PLAN DESK
// ============================================================

function PlanDesk({ id, scenarioOpen = false }: { id: number; scenarioOpen?: boolean }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ plan: Rec; lines: Rec[]; totals: Rec; scenarios: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [scenOpen, setScenOpen] = useState(!!scenarioOpen);
  const load = useCallback(() => {
    api<{ data: { plan: Rec; lines: Rec[]; totals: Rec; scenarios: Rec[] } }>(`/api/ops/hcm/workforce-plans/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Workforce plan failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);
  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader label="Opening workforce plan" />;
  const plan = doc.plan;
  const lines = doc.lines ?? [];
  const totals = doc.totals ?? {};
  const scenarios = doc.scenarios ?? [];
  const status = String(plan.status);
  const canSubmit = status === 'DRAFT' && can(user, 'hr.workforce_plans.submit');
  const canScenario = can(user, 'hr.workforce_scenarios.simulate');
  const submit = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(`/api/ops/hcm/workforce-plans/${id}/submit`, { method: 'POST' });
      setNotice(`Workforce plan ${String(plan.planNo ?? '')} submitted for approval`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page">
      <HrPageHeader
        kicker="Workforce planning"
        title={String(plan.planName ?? 'Workforce plan')}
        subtitle={<><span className="cell-mono">{String(plan.planNo ?? '')}</span> - FY {fmtNum(plan.fiscalYear)} - {String(plan.departmentName ?? 'All departments')}</>}
        actions={<>
          <button className="btn" onClick={() => navigate('/people/workforce')}>Back to plans</button>
          <Badge value={plan.status} />
        </>}
      />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      <HrKpiGrid>
        <HrKpi label="Current headcount" value={fmtNum(totals.currentHeadcount)} />
        <HrKpi label="Planned headcount" value={fmtNum(totals.plannedHeadcount)} accent="#1261A0" tint="rgba(18, 97, 160, 0.12)" />
        <HrKpi label="Gap" value={fmtNum(totals.gap)} accent="#D97706" tint="rgba(217, 119, 6, 0.12)" />
        <HrKpi label="Hiring requirement" value={fmtNum(totals.hiringRequirement)} accent="#4F46A5" tint="rgba(79, 70, 165, 0.12)" />
        <HrKpi label="Salary budget" value={fmtMoney(totals.salaryBudget)} accent="#168A5B" tint="rgba(22, 138, 91, 0.12)" />
      </HrKpiGrid>
      <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
        {canSubmit && <button className="btn btn-primary" disabled={busy} onClick={submit}>Submit for approval</button>}
        {canScenario && <button className="btn" onClick={() => setScenOpen((v) => !v)}>{scenOpen ? 'Hide scenario' : 'Run what-if scenario'}</button>}
      </div>
      {scenOpen && canScenario && <ScenarioComposer planId={id} onSaved={() => { setNotice('Scenario saved'); setScenOpen(false); load(); }} />}
      <section className="card">
        <div className="card-head"><h3>Plan lines</h3><span className="muted">{fmtNum(lines.length)} positions</span></div>
        <div className="table-wrap">
          <table className="data">
            <thead><tr><th>Position</th><th className="cell-num">Current</th><th className="cell-num">Planned</th><th className="cell-num">Gap</th><th className="cell-num">Departures</th><th className="cell-num">Retirements</th><th className="cell-num">New positions</th><th className="cell-num">Hiring</th><th className="cell-num">Salary budget</th></tr></thead>
            <tbody>
              {lines.map((l) => (
                <tr key={String(l.id)}>
                  <td><div className="cell-mono">{String(l.positionCode ?? '')}</div><strong>{String(l.positionTitle ?? '-')}</strong></td>
                  <td className="cell-num">{fmtNum(l.currentHeadcount)}</td>
                  <td className="cell-num">{fmtNum(l.plannedHeadcount)}</td>
                  <td className="cell-num">{fmtNum(l.gap)}</td>
                  <td className="cell-num">{fmtNum(l.expectedDepartures)}</td>
                  <td className="cell-num">{fmtNum(l.retirements)}</td>
                  <td className="cell-num">{fmtNum(l.newPositions)}</td>
                  <td className="cell-num">{fmtNum(l.hiringRequirement)}</td>
                  <td className="cell-num">{fmtMoney(l.salaryBudget)}</td>
                </tr>
              ))}
              {lines.length === 0 && <HrTableEmpty colSpan={9} icon="◔" title="No plan lines yet" hint="Add positions to model headcount, hiring requirements and budget for this plan." />}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card card-pad">
        <div className="card-head"><h3>Saved scenarios</h3><span className="muted">{fmtNum(scenarios.length)}</span></div>
        {scenarios.map((sc) => <ScenarioCard key={String(sc.id)} sc={sc} />)}
        {scenarios.length === 0 && <p className="muted">No scenarios saved yet. Use "Run what-if scenario" to model growth, cost and training impact.</p>}
      </section>
    </div>
  );
}

function ScenarioComposer({ planId, onSaved }: { planId: number; onSaved: () => void }) {
  const [name, setName] = useState('Growth scenario');
  const [growthPct, setGrowthPct] = useState('10');
  const [benefitsPct, setBenefitsPct] = useState('15');
  const [trainingCostPerHead, setTrainingCostPerHead] = useState('0');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true); setError('');
    try {
      await api(`/api/ops/hcm/workforce-plans/${planId}/scenarios`, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim() || 'Growth scenario',
          growthPct: Number(growthPct || 0),
          benefitsPct: Number(benefitsPct || 0),
          trainingCostPerHead: Number(trainingCostPerHead || 0),
        }),
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="card card-pad">
      <div className="card-head"><h3>What-if scenario</h3></div>
      <p className="muted" style={{ marginBottom: 12 }}>Model a workforce expansion: additional salary, benefits, employer statutory and training cost are estimated from the plan lines and versioned statutory configuration.</p>
      {error && <ErrorBanner error={error} />}
      <div className="form-grid">
        <div className="field"><label>Scenario name</label><input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="field"><label>Growth %</label><input type="number" min={0} value={growthPct} onChange={(e) => setGrowthPct(e.target.value)} /></div>
        <div className="field"><label>Benefits % of salary</label><input type="number" min={0} value={benefitsPct} onChange={(e) => setBenefitsPct(e.target.value)} /></div>
        <div className="field"><label>Training cost per head</label><input type="number" min={0} value={trainingCostPerHead} onChange={(e) => setTrainingCostPerHead(e.target.value)} /></div>
      </div>
      <button className="btn btn-primary" style={{ marginTop: 12 }} disabled={busy} onClick={save}>{busy ? 'Running...' : 'Run scenario'}</button>
    </section>
  );
}

function ScenarioCard({ sc }: { sc: Rec }) {
  const params = (sc.parameters ?? {}) as Rec;
  const results = (sc.results ?? {}) as Rec;
  const projected = (results.projected ?? {}) as Rec;
  const impact = (results.impact ?? {}) as Rec;
  const training = (impact.training ?? {}) as Rec;
  const rows: Array<[string, string]> = [
    ['Additional salary', fmtMoney(impact.annualSalary)],
    ['Benefits', fmtMoney(impact.annualBenefits)],
    ['Employer statutory', fmtMoney(impact.annualEmployerStatutory)],
    ['Total annual payroll impact', fmtMoney(impact.annualPayroll)],
    ['Training', `${fmtNum(training.heads)} heads, ${fmtMoney(training.estimatedCost)} (${fmtNum(training.courses)} courses)`],
  ];
  return (
    <div className="card card-pad" style={{ marginTop: 12 }}>
      <div className="card-head">
        <h4>{String(sc.name ?? 'Scenario')} <span className="cell-mono">{String(sc.scenarioNo ?? '')}</span></h4>
        <span className="muted">{sc.createdAt ? fmtDate(sc.createdAt) : '-'}</span>
      </div>
      <div className="kpi-grid">
        <div className="kpi-card"><span className="kpi-label">Growth</span><span className="kpi-value">{fmtNum(params.growthPct)}%</span></div>
        <div className="kpi-card"><span className="kpi-label">Projected headcount</span><span className="kpi-value">{fmtNum(projected.headcount)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Additional headcount</span><span className="kpi-value">{fmtNum(projected.additionalHeadcount)}</span></div>
        <div className="kpi-card"><span className="kpi-label">Recruitment requirement</span><span className="kpi-value">{fmtNum(projected.recruitmentRequirement)}</span></div>
      </div>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Impact</th><th>Annual amount</th></tr></thead>
          <tbody>
            {rows.map(([k, v]) => (
              <tr key={k}><td>{k}</td><td className="cell-num"><strong>{v}</strong></td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
