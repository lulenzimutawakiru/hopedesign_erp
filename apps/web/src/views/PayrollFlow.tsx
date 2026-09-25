import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, DocFormat, fmtMoney, fmtNum, openDocument } from '../api';
import { useAuth, can } from '../auth';
import { navigate, useHashQuery } from '../router';
import { Badge, ErrorBanner, Modal, PageLoader, Pager } from '../components/ui';
import { ConfirmDialog, Drawer } from '../components/os';
import { HrEmptyState, HrKpi, HrKpiGrid, HrPageHeader, HrTableEmpty, HrToolbar } from '../components/hrUi';
import { categoryLabel, type PreviewPayload, type StatutoryConfig, type StatutoryPayload } from './payrollConfigShared';

type Rec = Record<string, unknown>;

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string {
  return v === null || v === undefined ? '' : String(v);
}

function day(v: unknown): string {
  const s = str(v);
  return s ? s.slice(0, 10) : '-';
}

function money(v: unknown): string {
  return fmtMoney(num(v));
}

function nameOf(row: Rec): string {
  const first = row.firstName ?? row.first_name;
  const last = row.lastName ?? row.last_name;
  const combined = [str(first), str(last)].filter(Boolean).join(' ').trim();
  return combined || str(row.employeeNo ?? row.employee_no) || 'Employee';
}

function runTypeLabel(value: unknown): string {
  const raw = str(value) || 'REGULAR';
  return raw.replace(/_/g, ' ').toLowerCase().replace(/(^|\s)\S/g, (m) => m.toUpperCase());
}

function breakdownOf(item: Rec): Rec {
  const raw = item.breakdown;
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Rec;
    } catch {
      return {};
    }
  }
  return raw as Rec;
}

type ComponentRow = {
  key: string;
  code: string;
  name: string;
  kind: string;
  taxable: boolean | null;
  amount: number;
  lines: number;
};

function aggregateComponents(items: Rec[], bucket: 'earnings' | 'deductions'): ComponentRow[] {
  const map = new Map<string, ComponentRow>();
  for (const item of items) {
    const bd = breakdownOf(item);
    const rawRows = bd[bucket];
    const rows = Array.isArray(rawRows) ? (rawRows as Rec[]) : [];
    for (const row of rows) {
      const code = str(row.code) || str(row.kind) || 'OTHER';
      const kind = str(row.kind) || bucket.toUpperCase();
      const key = bucket + ':' + code + ':' + kind;
      const amount = num(row.amount);
      const found = map.get(key);
      if (found) {
        found.amount += amount;
        found.lines += 1;
      } else {
        map.set(key, {
          key,
          code,
          name: str(row.name) || code,
          kind,
          taxable: typeof row.taxable === 'boolean' ? row.taxable : null,
          amount,
          lines: 1,
        });
      }
    }
  }
  return Array.from(map.values()).sort((a, b) => b.amount - a.amount);
}

type StatutoryTotals = {
  paye: number;
  employeeNssf: number;
  employerNssf: number;
  nssfBase: number;
  lst: number;
  taxableIncome: number;
  chargeableIncome: number;
  employeeBenefits: number;
  employerBenefits: number;
  rules: string[];
};

function statutoryTotals(items: Rec[]): StatutoryTotals {
  const totals: StatutoryTotals = {
    paye: 0,
    employeeNssf: 0,
    employerNssf: 0,
    nssfBase: 0,
    lst: 0,
    taxableIncome: 0,
    chargeableIncome: 0,
    employeeBenefits: 0,
    employerBenefits: 0,
    rules: [],
  };
  const rules = new Set<string>();
  for (const item of items) {
    const bd = breakdownOf(item);
    const paye = (bd.paye ?? {}) as Rec;
    const nssf = (bd.nssf ?? {}) as Rec;
    const lst = (bd.lst ?? {}) as Rec;
    const benefits = (bd.benefits ?? {}) as Rec;
    totals.paye += num(paye.tax) || num(item.paye);
    totals.employeeNssf += num(nssf.employee) || num(item.nssf);
    totals.employerNssf += num(nssf.employer) || num(item.employerNssf);
    totals.nssfBase += num(nssf.base);
    totals.lst += num(lst.amount) || num(item.lst);
    totals.taxableIncome += num(bd.taxableIncome);
    totals.chargeableIncome += num(bd.chargeableIncome);
    totals.employeeBenefits += num(benefits.employee);
    totals.employerBenefits += num(benefits.employer);
    if (paye.code) rules.add('PAYE ' + str(paye.code) + ' v' + str(paye.version));
    if (nssf.code) rules.add('NSSF ' + str(nssf.code) + ' v' + str(nssf.version));
    if (lst.code) rules.add('LST ' + str(lst.code) + ' v' + str(lst.version));
  }
  totals.rules = Array.from(rules);
  return totals;
}

const RECALC_STATUSES = ['DRAFT', 'SUBMITTED'];
const POSTABLE_STATUSES = ['APPROVED', 'RELEASED', 'PAID', 'POSTED'];
const BATCHABLE_STATUSES = ['APPROVED', 'RELEASED', 'PAID', 'POSTED'];
const CLOSABLE_STATUSES = ['PAID', 'POSTED'];
const REOPENABLE_STATUSES = ['APPROVED', 'RELEASED', 'PAID', 'POSTED', 'CLOSED', 'LOCKED'];
const PUBLISH_STATUSES = ['RELEASED', 'PAID', 'POSTED', 'CLOSED'];

const TABS = ['Overview', 'Employees', 'Earnings', 'Deductions', 'Statutory', 'Variance', 'Payments', 'GL', 'Approvals', 'Audit'] as const;
type TabName = (typeof TABS)[number];
function Panel({ title, actions, children }: { title: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h3>{title}</h3>
        {actions ? <div className="action-group">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function severityBadge(severity: unknown) {
  const value = str(severity) || 'INFO';
  const cls =
    value === 'ERROR' ? 'badge-red' : value === 'HIGH_RISK' ? 'badge-critical' : value === 'WARNING' ? 'badge-amber' : 'badge';
  return <span className={`badge ${cls}`}>{value.replace(/_/g, ' ')}</span>;
}

function ShareBar({ value, total }: { value: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;
  return (
    <span className="stack-row" style={{ width: '100%' }}>
      <span
        style={{
          display: 'inline-block',
          height: 6,
          width: `${pct}%`,
          minWidth: 2,
          borderRadius: 3,
          background: 'var(--mill)',
        }}
      />
      <span className="muted" style={{ fontSize: 12 }}>{pct}%</span>
    </span>
  );
}

function OverviewTab({ payroll, exceptions, stat }: { payroll: Rec; exceptions: Rec[]; stat: StatutoryTotals }) {
  const p = payroll;
  const employerCost = num(p.grossTotal) + stat.employerNssf + stat.lst;
  return (
    <div className="stack">
      <div className="grid-2">
        <Panel title="Period">
          <dl className="detail-list">
            <Row label="Payroll number"><span className="cell-mono">{str(p.payrollNo)}</span></Row>
            <Row label="Run type">{runTypeLabel(p.runType)}</Row>
            <Row label="Period">{day(p.periodStart)} to {day(p.periodEnd)}</Row>
            <Row label="Pay date">{day(p.paymentDate)}</Row>
            <Row label="Statutory version">{str(p.statutoryRuleVersion) || 'Not pinned'}</Row>
            <Row label="Currency">{str(p.currency) || 'UGX'}</Row>
            <Row label="Employees paid">{fmtNum(num(p.headcount ?? p.employeeCount))}</Row>
          </dl>
        </Panel>
        <Panel title="Approval trail">
          <dl className="detail-list">
            <Row label="Created">{day(p.createdAt)}</Row>
            <Row label="Reviewed">{p.reviewedAt ? day(p.reviewedAt) : 'Pending'}</Row>
            <Row label="Approved">{p.approvedAt ? day(p.approvedAt) : 'Pending'}</Row>
            <Row label="Released">{p.releasedAt ? day(p.releasedAt) : 'Pending'}</Row>
            <Row label="Closed">{p.closedAt ? day(p.closedAt) : 'Open'}</Row>
            <Row label="Locked">{p.lockedAt ? day(p.lockedAt) : 'No'}</Row>
            <Row label="Reopen count">{fmtNum(num(p.reopenCount))}</Row>
          </dl>
        </Panel>
      </div>
      <Panel title="Money">
        <dl className="detail-list">
          <Row label="Gross earnings">{money(p.grossTotal)}</Row>
          <Row label="Chargeable income">{money(stat.chargeableIncome)}</Row>
          <Row label="PAYE">{money(stat.paye)}</Row>
          <Row label="Employee NSSF">{money(stat.employeeNssf)}</Row>
          <Row label="Employer NSSF">{money(stat.employerNssf)}</Row>
          <Row label="Local service tax">{money(stat.lst)}</Row>
          <Row label="Total deductions">{money(p.deductionTotal)}</Row>
          <Row label="Net pay">{money(p.netTotal)}</Row>
          <Row label="Employer cost">{money(employerCost)}</Row>
        </dl>
      </Panel>
      {stat.rules.length > 0 && (
        <Panel title="Statutory rules applied">
          <div className="chip-row">
            {stat.rules.map((r) => (
              <span key={r} className="chip">{r}</span>
            ))}
          </div>
        </Panel>
      )}
      <Panel title="Exceptions" actions={<span className="muted">{exceptions.length} recorded</span>}>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Employee</th><th>Type</th><th>Severity</th><th>Status</th><th>Message</th></tr>
            </thead>
            <tbody>
              {exceptions.map((x) => (
                <tr key={str(x.id)}>
                  <td>
                    {x.firstName ? nameOf(x) : 'Run-level'} <span className="cell-mono">{str(x.employeeNo)}</span>
                  </td>
                  <td className="cell-mono">{str(x.exceptionType)}</td>
                  <td>{severityBadge(x.severity)}</td>
                  <td>{str(x.status)}</td>
                  <td>{str(x.message)}</td>
                </tr>
              ))}
              {exceptions.length === 0 && (
                <HrTableEmpty colSpan={5} title="No exceptions" hint="Recalculate or validate this run to refresh the exception list." />
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
function EmployeesTab({
  items,
  onOpen,
  canPrintSlips,
  canCreate,
  onHire,
  docBusy,
  onPayslip,
  onRegister,
}: {
  items: Rec[];
  onOpen: (item: Rec) => void;
  canPrintSlips: boolean;
  canCreate: boolean;
  onHire: () => void;
  docBusy: string;
  onPayslip: (slip: Rec, format: 'pdf' | 'print') => void;
  onRegister: (format: DocFormat) => void;
}) {
  const total = (key: string) => items.reduce((s, i) => s + num(i[key]), 0);
  return (
    <Panel
      title="Payroll register"
      actions={
        <div className="action-group">
          <button
            className="btn btn-sm"
            disabled={!canCreate}
            title={canCreate ? 'Hire someone onto the employee file' : 'Ask HR to grant this payroll role the right to add employees'}
            onClick={onHire}
          >
            New employee
          </button>
          <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => onRegister('pdf')}>
            {docBusy === 'registerpdf' ? 'Saving...' : 'Register PDF'}
          </button>
          <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => onRegister('xlsx')}>
            {docBusy === 'registerxlsx' ? 'Saving...' : 'Excel'}
          </button>
          <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => onRegister('csv')}>
            {docBusy === 'registercsv' ? 'Saving...' : 'CSV'}
          </button>
        </div>
      }
    >
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Employee</th>
              <th>Basic</th>
              <th>Allowances</th>
              <th>Overtime</th>
              <th>Gross</th>
              <th>PAYE</th>
              <th>NSSF</th>
              <th>Loans/adv.</th>
              <th>Other ded.</th>
              <th>Net</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {items.map((i) => (
              <tr key={str(i.id)}>
                <td>
                  {nameOf(i)} <span className="cell-mono">{str(i.employeeNo)}</span>
                  <div className="cell-sub">{str(i.position)}</div>
                </td>
                <td className="cell-num">{money(i.basicPay)}</td>
                <td className="cell-num">{money(i.allowances)}</td>
                <td className="cell-num">{money(i.overtime)}</td>
                <td className="cell-num">{money(i.grossPay)}</td>
                <td className="cell-num">{money(i.paye)}</td>
                <td className="cell-num">{money(i.nssf)}</td>
                <td className="cell-num">{money(i.advances)}</td>
                <td className="cell-num">{money(i.otherDeductions)}</td>
                <td className="cell-num"><strong>{money(i.netPay)}</strong></td>
                <td>
                  <div className="action-group">
                    <button className="btn btn-sm" onClick={() => onOpen(i)}>Breakdown</button>
                    {canPrintSlips && (
                      <>
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => onPayslip(i, 'print')}>
                          {docBusy === String(i.id) + 'print' ? 'Printing...' : 'Print'}
                        </button>
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => onPayslip(i, 'pdf')}>
                          {docBusy === String(i.id) + 'pdf' ? 'Saving...' : 'PDF'}
                        </button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {items.length > 0 && (
              <tr>
                <td><strong>Total</strong></td>
                <td className="cell-num">{money(total('basicPay'))}</td>
                <td className="cell-num">{money(total('allowances'))}</td>
                <td className="cell-num">{money(total('overtime'))}</td>
                <td className="cell-num">{money(total('grossPay'))}</td>
                <td className="cell-num">{money(total('paye'))}</td>
                <td className="cell-num">{money(total('nssf'))}</td>
                <td className="cell-num">{money(total('advances'))}</td>
                <td className="cell-num">{money(total('otherDeductions'))}</td>
                <td className="cell-num"><strong>{money(total('netPay'))}</strong></td>
                <td />
              </tr>
            )}
            {items.length === 0 && (
              <HrTableEmpty
                colSpan={11}
                title="No employees in this run"
                hint="Recalculate the payroll to pull in active contracts for the period, or hire someone new onto the file."
              >
                <button
                  className="btn btn-primary btn-sm"
                  disabled={!canCreate}
                  title={canCreate ? 'Hire someone onto the employee file' : 'Ask HR to grant this payroll role the right to add employees'}
                  onClick={onHire}
                >
                  New employee
                </button>
              </HrTableEmpty>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function TraceList({ title, rows, empty }: { title: string; rows: Rec[]; empty: string }) {
  return (
    <div>
      <div className="muted" style={{ fontWeight: 700, margin: '10px 0 6px' }}>{title}</div>
      {rows.length === 0 ? (
        <div className="muted">{empty}</div>
      ) : (
        <table className="data">
          <thead>
            <tr><th>Component</th><th>Kind</th><th>Taxable</th><th>Amount</th></tr>
          </thead>
          <tbody>
            {rows.map((r, idx) => (
              <tr key={str(r.code) + ':' + str(r.kind) + ':' + idx}>
                <td>{str(r.name) || str(r.code)} <span className="cell-mono">{str(r.code)}</span></td>
                <td className="cell-mono">{str(r.kind)}</td>
                <td>{r.taxable === true ? 'Taxable' : r.taxable === false ? 'Exempt' : '-'}</td>
                <td className="cell-num">{money(r.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function EmployeeDrawer({ item, onClose, canPrintSlips, docBusy, onPayslip }: {
  item: Rec;
  onClose: () => void;
  canPrintSlips: boolean;
  docBusy: string;
  onPayslip: (slip: Rec, format: 'pdf' | 'print') => void;
}) {
  const bd = breakdownOf(item);
  const paye = (bd.paye ?? {}) as Rec;
  const nssf = (bd.nssf ?? {}) as Rec;
  const lst = (bd.lst ?? {}) as Rec;
  const earnings = Array.isArray(bd.earnings) ? (bd.earnings as Rec[]) : [];
  const deductions = Array.isArray(bd.deductions) ? (bd.deductions as Rec[]) : [];
  return (
    <Drawer title={nameOf(item) + ' - ' + str(item.employeeNo)} onClose={onClose}>
      <div className="stack">
        <Panel title="Calculation trace">
          <dl className="detail-list">
            <Row label="Basic pay">{money(item.basicPay)}</Row>
            <Row label="Allowances">{money(item.allowances)}</Row>
            <Row label="Overtime">{money(item.overtime)}</Row>
            <Row label="Gross earnings">{money(item.grossPay)}</Row>
            <Row label="Taxable income">{money(bd.taxableIncome)}</Row>
            <Row label="Chargeable income">{money(bd.chargeableIncome)}</Row>
            <Row label="PAYE">{money(paye.tax)}</Row>
            <Row label="Employee NSSF">{money(nssf.employee)}</Row>
            <Row label="Employer NSSF">{money(nssf.employer)}</Row>
            <Row label="NSSF base">{money(nssf.base)}</Row>
            <Row label="Local service tax">{money(lst.amount)}</Row>
            <Row label="Other deductions">{money(item.otherDeductions)}</Row>
            <Row label="Net pay"><strong>{money(item.netPay)}</strong></Row>
          </dl>
        </Panel>
        <Panel title="Statutory rules used">
          <dl className="detail-list">
            <Row label="PAYE rule">{str(paye.code) || '-'} {paye.version ? 'v' + str(paye.version) : ''}</Row>
            <Row label="NSSF rule">{str(nssf.code) || '-'} {nssf.version ? 'v' + str(nssf.version) : ''}</Row>
            <Row label="NSSF ceiling">{nssf.ceiling ? money(nssf.ceiling) : '-'}</Row>
            <Row label="LST rule">{str(lst.code) || 'Not applicable'}</Row>
          </dl>
        </Panel>
        <Panel title="Earnings breakdown">
          <TraceList title="Earnings" rows={earnings} empty="No earning lines recorded for this employee." />
        </Panel>
        <Panel title="Deductions breakdown">
          <TraceList title="Deductions" rows={deductions} empty="Only statutory deductions apply to this employee." />
        </Panel>
        {canPrintSlips && (
          <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
            <button className="btn" disabled={docBusy !== ''} onClick={() => onPayslip(item, 'print')}>Print payslip</button>
            <button className="btn" disabled={docBusy !== ''} onClick={() => onPayslip(item, 'pdf')}>Save payslip PDF</button>
          </div>
        )}
      </div>
    </Drawer>
  );
}
function ComponentsTab({
  title,
  blurb,
  rows,
  total,
  emptyTitle,
  emptyHint,
  showTaxable,
}: {
  title: string;
  blurb: string;
  rows: ComponentRow[];
  total: number;
  emptyTitle: string;
  emptyHint: string;
  showTaxable: boolean;
}) {
  return (
    <Panel title={title} actions={<span className="muted">{money(total)} across {rows.length} component{rows.length === 1 ? '' : 's'}</span>}>
      <p className="muted" style={{ padding: '0 16px 10px', margin: 0 }}>{blurb}</p>
      <div className="table-wrap">
        <table className="data">
          <thead>
            <tr>
              <th>Component</th>
              <th>Code</th>
              <th>Type</th>
              {showTaxable && <th>Tax treatment</th>}
              <th>Employees</th>
              <th>Share</th>
              <th>Amount</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <td>{r.name}</td>
                <td className="cell-mono">{r.code}</td>
                <td className="cell-mono">{r.kind}</td>
                {showTaxable && <td>{r.taxable === true ? 'Taxable' : r.taxable === false ? 'Exempt' : '-'}</td>}
                <td className="cell-num">{fmtNum(r.lines)}</td>
                <td style={{ minWidth: 140 }}><ShareBar value={r.amount} total={total} /></td>
                <td className="cell-num">{money(r.amount)}</td>
              </tr>
            ))}
            {rows.length === 0 && <HrTableEmpty colSpan={showTaxable ? 7 : 6} title={emptyTitle} hint={emptyHint} />}
            {rows.length > 0 && (
              <tr>
                <td colSpan={showTaxable ? 6 : 5}><strong>Total</strong></td>
                <td className="cell-num"><strong>{money(total)}</strong></td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

function StatutoryTab({ payroll, stat, items }: { payroll: Rec; stat: StatutoryTotals; items: Rec[] }) {
  const p = payroll;
  const employerCost = num(p.grossTotal) + stat.employerNssf + stat.lst;
  const contributing = items.filter((i) => num((breakdownOf(i).nssf as Rec | undefined)?.employee) > 0).length;
  return (
    <div className="stack">
      <div className="grid-2">
        <Panel title="PAYE">
          <dl className="detail-list">
            <Row label="Taxable income">{money(stat.taxableIncome)}</Row>
            <Row label="Chargeable income">{money(stat.chargeableIncome)}</Row>
            <Row label="PAYE withheld">{money(stat.paye)}</Row>
            <Row label="Effective rate">
              {stat.taxableIncome > 0 ? ((stat.paye / stat.taxableIncome) * 100).toFixed(2) + '%' : '-'}
            </Row>
            <Row label="Rule version">{str(p.statutoryRuleVersion) || 'Pinned per employee'}</Row>
          </dl>
        </Panel>
        <Panel title="NSSF">
          <dl className="detail-list">
            <Row label="Contribution base">{money(stat.nssfBase)}</Row>
            <Row label="Employee contribution">{money(stat.employeeNssf)}</Row>
            <Row label="Employer contribution">{money(stat.employerNssf)}</Row>
            <Row label="Total remittable">{money(stat.employeeNssf + stat.employerNssf)}</Row>
            <Row label="Employees contributing">{fmtNum(contributing)}</Row>
          </dl>
        </Panel>
      </div>
      <div className="grid-2">
        <Panel title="Employer cost">
          <dl className="detail-list">
            <Row label="Gross earnings">{money(p.grossTotal)}</Row>
            <Row label="Employer NSSF">{money(stat.employerNssf)}</Row>
            <Row label="Local service tax">{money(stat.lst)}</Row>
            <Row label="Employer benefits">{money(stat.employerBenefits)}</Row>
            <Row label="Total employer cost"><strong>{money(employerCost)}</strong></Row>
          </dl>
        </Panel>
        <Panel title="Filing readiness">
          <dl className="detail-list">
            <Row label="Payroll status"><Badge value={p.status} /></Row>
            <Row label="GL posted">{p.glPosted ? 'Yes, journal #' + str(p.glJournalId) : 'Not posted'}</Row>
            <Row label="Readiness score">
              {p.validationScore === null || p.validationScore === undefined ? '-' : str(p.validationScore) + '/100'}
            </Row>
          </dl>
          <div className="flow-actions" style={{ flexDirection: 'row', flexWrap: 'wrap', padding: '0 16px 14px' }}>
            <button className="btn btn-sm" onClick={() => navigate('/people/statutory-configs')}>Statutory configuration</button>
            <button className="btn btn-sm" onClick={() => navigate('/people/payroll-settings')}>Payroll settings</button>
            <button className="btn btn-sm" onClick={() => navigate('/people/reports')}>Statutory reports</button>
          </div>
        </Panel>
      </div>
    </div>
  );
}
function VarianceTab({ payrollId }: { payrollId: number }) {
  const [state, setState] = useState<{ loading: boolean; error: string; data: Rec | null }>({ loading: true, error: '', data: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: '', data: null });
    api<Rec>('/api/ops/hr/payrolls/' + payrollId + '/variance')
      .then((data) => { if (alive) setState({ loading: false, error: '', data }); })
      .catch((e) => { if (alive) setState({ loading: false, error: e instanceof Error ? e.message : String(e), data: null }); });
    return () => { alive = false; };
  }, [payrollId]);
  if (state.loading) return <PageLoader label="Comparing with the previous period" />;
  if (state.error) return <ErrorBanner error={state.error} />;
  const data = state.data;
  if (!data) return <HrEmptyState title="Variance is not available" hint="Variance is computed once the run has a comparable previous period." />;
  const head = (data.headcount ?? {}) as Rec;
  const previous = (data.previousRun ?? null) as Rec | null;
  const measures = Array.isArray(data.measures) ? (data.measures as Rec[]) : [];
  const departments = Array.isArray(data.departments) ? (data.departments as Rec[]) : [];
  const material = Array.isArray(data.materialChanges) ? (data.materialChanges as Rec[]) : [];
  const delta = (v: unknown) => {
    const n = num(v);
    const cls = n > 0 ? 'chip chip-red' : n < 0 ? 'chip chip-green' : 'chip';
    return <span className={cls}>{n > 0 ? '+' : ''}{money(n)}</span>;
  };
  if (!previous) {
    return (
      <Panel title="Variance">
        <div className="stack" style={{ padding: 16 }}>
          <p className="muted" style={{ margin: 0 }}>{str(data.note) || 'No previous period is available for comparison yet.'}</p>
          <HrEmptyState icon="-" title="Nothing to compare" hint="Run a second payroll period to unlock variance analysis." />
        </div>
      </Panel>
    );
  }
  return (
    <div className="stack">
      <Panel
        title="Movement against the previous period"
        actions={<span className="muted">vs {str(previous.payrollNo)} &middot; {day(previous.periodStart)} to {day(previous.periodEnd)}</span>}
      >
        <div className="grid-2" style={{ padding: 16, gap: 16 }}>
          <dl className="detail-list">
            <Row label="Headcount now">{fmtNum(head.current)}</Row>
            <Row label="Headcount previously">{fmtNum(head.previous)}</Row>
            <Row label="Headcount change">
              <span className={(num(head.change) > 0 ? 'chip chip-amber' : 'chip')}>
                {num(head.change) > 0 ? '+' : ''}{fmtNum(head.change)} ({num(head.changePct).toFixed(1)}%)
              </span>
            </Row>
          </dl>
          <dl className="detail-list">
            <Row label="Materiality threshold">{num(data.thresholdPct).toFixed(1)}%</Row>
            <Row label="Material changes">{material.length ? fmtNum(material.length) + ' flagged' : 'None flagged'}</Row>
            <Row label="Note">{str(data.note) || '-'}</Row>
          </dl>
        </div>
      </Panel>
      <Panel title="Measures">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Measure</th>
                <th className="cell-num">Current</th>
                <th className="cell-num">Previous</th>
                <th className="cell-num">Change</th>
                <th className="cell-num">Change %</th>
              </tr>
            </thead>
            <tbody>
              {measures.map((m) => (
                <tr key={str(m.key)}>
                  <td>{str(m.label)}</td>
                  <td className="cell-num">{money(m.current)}</td>
                  <td className="cell-num">{money(m.previous)}</td>
                  <td className="cell-num">{delta(m.change)}</td>
                  <td className="cell-num">{num(m.changePct).toFixed(2)}%</td>
                </tr>
              ))}
              {measures.length === 0 && <HrTableEmpty colSpan={5} title="No measures" hint="This run has no comparable figures." />}
            </tbody>
          </table>
        </div>
      </Panel>
      <Panel title="Department movement">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Department</th>
                <th className="cell-num">Current</th>
                <th className="cell-num">Previous</th>
                <th className="cell-num">Change</th>
              </tr>
            </thead>
            <tbody>
              {departments.map((d, index) => (
                <tr key={str(d.departmentId ?? d.id ?? index)}>
                  <td>{str(d.departmentName ?? d.name ?? d.department) || 'Unassigned'}</td>
                  <td className="cell-num">{money(d.current)}</td>
                  <td className="cell-num">{money(d.previous)}</td>
                  <td className="cell-num">{delta(d.change)}</td>
                </tr>
              ))}
              {departments.length === 0 && <HrTableEmpty colSpan={4} title="No department breakdown" hint="Department movement appears when employees carry a cost centre." />}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}
function PaymentsTab({
  payroll,
  canBatch,
  canPayslips,
  docBusy,
  onPayslip,
  onNotice,
}: {
  payroll: Rec;
  canBatch: boolean;
  canPayslips: boolean;
  docBusy: string;
  onPayslip: (slip: Rec, format: 'pdf' | 'print') => void;
  onNotice: (message: string) => void;
}) {
  const id = num(payroll.id);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [batches, setBatches] = useState<{ rows: Rec[]; page: number; pageSize: number; totalCount: number }>({ rows: [], page: 1, pageSize: 25, totalCount: 0 });
  const [slips, setSlips] = useState<{ rows: Rec[]; page: number; pageSize: number; totalCount: number }>({ rows: [], page: 1, pageSize: 25, totalCount: 0 });
  const [batchPage, setBatchPage] = useState(1);
  const [slipPage, setSlipPage] = useState(1);
  const loadBatches = useCallback(() => {
    api<{ data: { rows: Rec[]; page: number; pageSize: number; totalCount: number } }>(
      '/api/ops/hr/payment-batches?payrollId=' + id + '&page=' + batchPage + '&pageSize=25'
    )
      .then((r) => setBatches(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id, batchPage]);
  const loadSlips = useCallback(() => {
    api<{ data: { rows: Rec[]; page: number; pageSize: number; totalCount: number } }>(
      '/api/ops/hr/payrolls/' + id + '/payslips?page=' + slipPage + '&pageSize=25'
    )
      .then((r) => setSlips(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id, slipPage]);
  useEffect(() => { loadBatches(); }, [loadBatches]);
  useEffect(() => { loadSlips(); }, [loadSlips]);
  const post = async (path: string, ok: string) => {
    setBusy(path); setError('');
    try {
      await api<{ data: Rec }>(path, { method: 'POST', body: '{}' });
      onNotice(ok);
      loadBatches();
      loadSlips();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(''); }
  };
  const status = str(payroll.status);
  const canPublish = canPayslips && PUBLISH_STATUSES.includes(status);
  return (
    <div className="stack">
      {error ? <ErrorBanner error={error} /> : null}
      <Panel
        title="Payment batches"
        actions={
          canBatch && BATCHABLE_STATUSES.includes(status) ? (
            <button
              className="btn btn-primary btn-sm"
              disabled={busy !== '' || batches.rows.some((b) => str(b.status) !== 'CONFIRMED')}
              onClick={() => post('/api/ops/hr/payrolls/' + id + '/payment-batch', 'Payment batch created')}
            >
              {busy ? 'Working...' : 'Create batch'}
            </button>
          ) : (
            <span className="muted">{BATCHABLE_STATUSES.includes(status) ? 'Approved runs only' : 'Not payable at ' + status}</span>
          )
        }
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Batch</th>
                <th>Currency</th>
                <th className="cell-num">Amount</th>
                <th className="cell-num">Items</th>
                <th>Status</th>
                <th>Confirmed</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {batches.rows.map((b) => (
                <tr key={str(b.id)}>
                  <td className="cell-mono">{str(b.batchNo)}</td>
                  <td>{str(b.currency)}</td>
                  <td className="cell-num">{money(b.totalAmount)}</td>
                  <td className="cell-num">{fmtNum(b.itemCount)}</td>
                  <td><Badge value={b.status} /></td>
                  <td>{b.confirmedAt ? day(b.confirmedAt) : '-'}</td>
                  <td className="cell-num">
                    <button className="btn btn-sm" onClick={() => navigate('/people/payments/' + str(b.id))}>Open</button>
                  </td>
                </tr>
              ))}
              {batches.rows.length === 0 && (
                <HrTableEmpty
                  colSpan={7}
                  title="No payment batch"
                  hint="Create a batch once the run is approved, then validate, approve, export and confirm the bank file."
                />
              )}
            </tbody>
          </table>
        </div>
        {batches.totalCount > 25 && (
          <Pager page={batches.page} pageSize={batches.pageSize} total={batches.totalCount} onPage={setBatchPage} />
        )}
      </Panel>
      <Panel
        title="Payslips"
        actions={
          <div className="action-group">
            <span className="muted">{fmtNum(slips.totalCount)} issued</span>
            {canPublish ? (
              <button
                className="btn btn-sm"
                disabled={busy !== ''}
                onClick={() => post('/api/ops/hr/payrolls/' + id + '/publish-payslips', 'Payslips published to employee self-service')}
              >
                Publish payslips
              </button>
            ) : null}
          </div>
        }
      >
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Payslip</th>
                <th>Employee</th>
                <th className="cell-num">Gross</th>
                <th className="cell-num">Deductions</th>
                <th className="cell-num">Net</th>
                <th>Status</th>
                {canPayslips ? <th /> : null}
              </tr>
            </thead>
            <tbody>
              {slips.rows.map((s) => (
                <tr key={str(s.id)}>
                  <td className="cell-mono">{str(s.payslipNo)}</td>
                  <td>{nameOf(s)} <span className="cell-mono">{str(s.employeeNo)}</span></td>
                  <td className="cell-num">{money(s.grossTotal)}</td>
                  <td className="cell-num">{money(s.deductionTotal)}</td>
                  <td className="cell-num"><strong>{money(s.netTotal)}</strong></td>
                  <td><Badge value={s.status} /></td>
                  {canPayslips ? (
                    <td className="cell-num">
                      <div className="action-group">
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => onPayslip(s, 'print')}>Print</button>
                        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => onPayslip(s, 'pdf')}>PDF</button>
                      </div>
                    </td>
                  ) : null}
                </tr>
              ))}
              {slips.rows.length === 0 && (
                <HrTableEmpty colSpan={canPayslips ? 7 : 6} title="No payslips yet" hint="Payslips are issued from the approved payroll snapshot." />
              )}
            </tbody>
          </table>
        </div>
        {slips.totalCount > 25 && (
          <Pager page={slips.page} pageSize={slips.pageSize} total={slips.totalCount} onPage={setSlipPage} />
        )}
      </Panel>
    </div>
  );
}
function GlTab({ payroll, canPost, busy, onPost }: { payroll: Rec; canPost: boolean; busy: boolean; onPost: () => void }) {
  const journalId = num(payroll.glJournalId);
  const posted = Boolean(payroll.glPosted);
  const [journal, setJournal] = useState<{ journal: Rec; lines: Rec[] } | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!journalId) { setJournal(null); return; }
    let alive = true;
    api<{ data: { journal: Rec; lines: Rec[] } }>('/api/ops/finance/journals/' + journalId)
      .then((r) => { if (alive) { setJournal(r.data); setError(''); } })
      .catch((e) => { if (alive) setError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [journalId]);
  const status = str(payroll.status);
  const lines = journal?.lines ?? [];
  const debit = lines.reduce((s, l) => s + num(l.debit), 0);
  const credit = lines.reduce((s, l) => s + num(l.credit), 0);
  const balanced = Math.abs(debit - credit) < 0.01;
  return (
    <div className="stack">
      {error ? <ErrorBanner error={error} /> : null}
      <Panel
        title="General ledger"
        actions={
          !posted && canPost && POSTABLE_STATUSES.includes(status) ? (
            <button className="btn btn-primary btn-sm" disabled={busy} onClick={onPost}>
              {busy ? 'Posting...' : 'Post to general ledger'}
            </button>
          ) : (
            <span className="muted">{posted ? 'Journal posted' : 'Posting available from APPROVED'}</span>
          )
        }
      >
        <div className="grid-2" style={{ padding: 16, gap: 16 }}>
          <dl className="detail-list">
            <Row label="Posting status">
              {posted ? <span className="chip chip-green">Posted</span> : <span className="chip chip-amber">Not posted</span>}
            </Row>
            <Row label="Journal">{journalId ? '#' + journalId : '-'}</Row>
            <Row label="Journal no">{str(journal?.journal?.journalNo) || '-'}</Row>
            <Row label="Posted at">{journal?.journal?.postedAt ? day(journal.journal.postedAt) : '-'}</Row>
          </dl>
          <dl className="detail-list">
            <Row label="Total debits">{money(debit)}</Row>
            <Row label="Total credits">{money(credit)}</Row>
            <Row label="Balanced">
              {lines.length === 0 ? '-' : balanced ? <span className="chip chip-green">Balanced</span> : <span className="chip chip-red">Out by {money(debit - credit)}</span>}
            </Row>
            <Row label="Lines">{fmtNum(lines.length)}</Row>
          </dl>
        </div>
      </Panel>
      <Panel title="Journal lines">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Account</th>
                <th>Name</th>
                <th>Type</th>
                <th>Cost centre</th>
                <th className="cell-num">Debit</th>
                <th className="cell-num">Credit</th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, index) => (
                <tr key={str(l.id ?? index)}>
                  <td className="cell-mono">{str(l.accountCode ?? l.account_code)}</td>
                  <td>{str(l.accountName ?? l.account_name)}</td>
                  <td>{str(l.accountType ?? l.account_type) || '-'}</td>
                  <td>{str(l.costCentre ?? l.cost_centre) || '-'}</td>
                  <td className="cell-num">{money(l.debit)}</td>
                  <td className="cell-num">{money(l.credit)}</td>
                </tr>
              ))}
              {lines.length === 0 && (
                <HrTableEmpty
                  colSpan={6}
                  title={posted ? 'Journal lines unavailable' : 'Not yet posted'}
                  hint={posted ? 'The journal exists but its lines could not be read. Check finance journal permissions.' : 'Posting creates a balanced journal for salaries, statutory liabilities and net pay.'}
                />
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function ApprovalsTab({ payrollId }: { payrollId: number }) {
  const [state, setState] = useState<{ loading: boolean; error: string; decisions: Rec[]; pending: Rec[] }>({ loading: true, error: '', decisions: [], pending: [] });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: '', decisions: [], pending: [] });
    api<{ data: { decisions: Rec[]; pendingSteps: Rec[] } }>('/api/ops/hr/payrolls/' + payrollId + '/approvals')
      .then((r) => {
        if (!alive) return;
        setState({ loading: false, error: '', decisions: r.data.decisions ?? [], pending: r.data.pendingSteps ?? [] });
      })
      .catch((e) => { if (alive) setState({ loading: false, error: e instanceof Error ? e.message : String(e), decisions: [], pending: [] }); });
    return () => { alive = false; };
  }, [payrollId]);
  if (state.loading) return <PageLoader label="Loading the approval trail" />;
  return (
    <div className="stack">
      {state.error ? <ErrorBanner error={state.error} /> : null}
      <Panel title="Pending steps" actions={<span className="muted">Decisions are taken in the approvals inbox</span>}>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th className="cell-num">Step</th>
                <th>Step name</th>
                <th>Due</th>
                <th>Submitted</th>
              </tr>
            </thead>
            <tbody>
              {state.pending.map((s) => (
                <tr key={str(s.taskId)}>
                  <td className="cell-num">{fmtNum(s.stepSeq)}</td>
                  <td>{str(s.stepName)}</td>
                  <td>{s.dueAt ? day(s.dueAt) : '-'}</td>
                  <td>{s.submittedAt ? day(s.submittedAt) : '-'}</td>
                </tr>
              ))}
              {state.pending.length === 0 && (
                <HrTableEmpty colSpan={4} title="Nothing pending" hint="No approval step is waiting on this run." />
              )}
            </tbody>
          </table>
        </div>
        <div className="flow-actions" style={{ flexDirection: 'row', padding: '0 16px 14px' }}>
          <button className="btn btn-sm" onClick={() => navigate('/inbox')}>Open approvals inbox</button>
        </div>
      </Panel>
      <Panel title="Decisions">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>When</th>
                <th>Action</th>
                <th>Stage</th>
                <th>Transition</th>
                <th>Role</th>
                <th>Actor</th>
                <th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {state.decisions.map((d) => (
                <tr key={str(d.id)}>
                  <td>{day(d.decidedAt)}</td>
                  <td><Badge value={d.action} /></td>
                  <td className="cell-mono">{str(d.stage)}</td>
                  <td className="cell-mono">{str(d.fromStatus)} &rarr; {str(d.toStatus)}</td>
                  <td>{str(d.roleCode) || '-'}</td>
                  <td>{str(d.actorName) || '-'}{d.delegatedFromUserId ? ' (delegated)' : ''}</td>
                  <td>{str(d.comment) || '-'}</td>
                </tr>
              ))}
              {state.decisions.length === 0 && (
                <HrTableEmpty colSpan={7} title="No decisions recorded" hint="Submit the run for approval to start the trail." />
              )}
            </tbody>
          </table>
        </div>
      </Panel>
    </div>
  );
}

function AuditTab({ payrollId }: { payrollId: number }) {
  const [state, setState] = useState<{ loading: boolean; error: string; entries: Rec[]; counts: Rec | null }>({ loading: true, error: '', entries: [], counts: null });
  useEffect(() => {
    let alive = true;
    setState({ loading: true, error: '', entries: [], counts: null });
    api<{ data: { entries: Rec[]; counts: Rec } }>('/api/ops/hr/payrolls/' + payrollId + '/audit')
      .then((r) => { if (alive) setState({ loading: false, error: '', entries: r.data.entries ?? [], counts: r.data.counts ?? null }); })
      .catch((e) => { if (alive) setState({ loading: false, error: e instanceof Error ? e.message : String(e), entries: [], counts: null }); });
    return () => { alive = false; };
  }, [payrollId]);
  if (state.loading) return <PageLoader label="Loading the audit trail" />;
  const counts = state.counts ?? {};
  return (
    <div className="stack">
      {state.error ? <ErrorBanner error={state.error} /> : null}
      <Panel
        title="Audit trail"
        actions={
          <span className="muted">
            {fmtNum(counts.statusChanges)} status changes &middot; {fmtNum(counts.decisions)} decisions &middot; {fmtNum(counts.auditEvents)} audit events
          </span>
        }
      >
        <ol className="timeline" style={{ padding: 16 }}>
          {state.entries.map((e, index) => (
            <li className="timeline-item" key={str(e.id) + '-' + index}>
              <span className="timeline-dot" aria-hidden />
              <div className="timeline-title">
                {str(e.action) || str(e.toStatus) || 'Event'}
                {e.fromStatus || e.toStatus ? (
                  <span className="muted"> {str(e.fromStatus) ? str(e.fromStatus) + ' -> ' : ''}{str(e.toStatus)}</span>
                ) : null}
              </div>
              <div className="timeline-meta">
                {day(e.at)} &middot; {str(e.kind)} &middot; {str(e.actor) || 'System'}
                {e.roleCode ? ' (' + str(e.roleCode) + ')' : ''}
                {e.ip ? ' &middot; ' + str(e.ip) : ''}
              </div>
              {e.comment || e.reason ? <div className="timeline-meta">{str(e.comment) || str(e.reason)}</div> : null}
            </li>
          ))}
          {state.entries.length === 0 && (
            <li className="timeline-item">
              <span className="timeline-dot" aria-hidden />
              <div className="timeline-title">No audit entries yet</div>
              <div className="timeline-meta">Calculations, approvals, releases and postings all record here.</div>
            </li>
          )}
        </ol>
      </Panel>
    </div>
  );
}
export function PayrollDesk({ id }: { id: number }) {
  const { user } = useAuth();
  const [doc, setDoc] = useState<{ payroll: Rec; items: Rec[]; exceptions: Rec[]; workflow?: Rec[] } | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [docBusy, setDocBusy] = useState('');
  const [tab, setTab] = useState<TabName>('Overview');
  const [drawer, setDrawer] = useState<Rec | null>(null);
  const [confirm, setConfirm] = useState<'release' | 'paid' | 'close' | 'reopen' | null>(null);
  const [simulation, setSimulation] = useState<Rec | null>(null);
  const hashQuery = useHashQuery();

  const load = useCallback(() => {
    api<{ data: { payroll: Rec; items: Rec[]; exceptions: Rec[]; workflow?: Rec[] } }>(`/api/ops/hr/payrolls/${id}`)
      .then((r) => setDoc(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Payroll failed'));
  }, [id]);
  useEffect(() => { load(); }, [load]);

  // A hire that started from this run comes back with ?hired=1 so the desk can
  // confirm the hand-off and point the operator at the next step.
  useEffect(() => {
    if (hashQuery.get('hired') !== '1') return;
    setNotice('Employee added to the employee file. Recalculate this run to pull them into the register.');
    setTab('Employees');
    navigate('/people/payrolls/' + id, { replace: true });
  }, [hashQuery, id]);

  const act = async (path: string, ok: string, body?: Rec): Promise<Rec | null> => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
      const journalId = r.data ? (r.data as Rec).journalId : undefined;
      setNotice(journalId ? 'Posted journal #' + String(journalId) : ok);
      load();
      return r.data;
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      return null;
    } finally { setBusy(false); }
  };

  const runValidate = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: { validationScore: number; errors: number; warnings: number; ready: boolean } }>(
        `/api/ops/hr/payrolls/${id}/validate`, { method: 'POST', body: '{}' }
      );
      setNotice(`Validation ${r.data.ready ? 'passed' : 'blocked'}: ${r.data.validationScore}/100 (${r.data.errors} errors, ${r.data.warnings} warnings)`);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const runSimulate = async () => {
    setBusy(true); setError(''); setNotice(''); setSimulation(null);
    try {
      const r = await api<{ data: Rec }>(`/api/ops/hr/payrolls/${id}/simulate`, { method: 'POST', body: '{}' });
      setSimulation(r.data);
      setNotice('Simulation complete. Nothing was posted to the ledger.');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(false); }
  };

  const openPayslipDoc = async (slip: Rec, format: 'pdf' | 'print') => {
    setDocBusy(String(slip.id) + format); setError('');
    try {
      await openDocument('payslip', slip.id, format, String(slip.payslipNo ?? 'payslip') + '.pdf');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setDocBusy(''); }
  };

  const openRegisterDoc = async (format: DocFormat) => {
    if (!doc) return;
    setDocBusy('register' + format); setError('');
    const payrollNo = String(doc.payroll.payrollNo ?? id);
    try {
      await openDocument('payroll-register', id, format, `payroll_${payrollNo}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setDocBusy(''); }
  };

  const hireFromRun = () => navigate('/people/employees/new', { query: { returnTo: 'payrolls/' + id } });

  if (error && !doc) return <ErrorBanner error={error} />;
  if (!doc) return <PageLoader variant="page" label="Opening payroll..." />;

  const p = doc.payroll;
  const items = doc.items ?? [];
  const exceptions = doc.exceptions ?? [];
  const workflow = doc.workflow ?? [];
  const stat = statutoryTotals(items);
  const status = str(p.status);
  const openErrors = exceptions.filter((x) => x.severity === 'ERROR' && x.status === 'OPEN').length;
  const highRisk = exceptions.filter((x) => x.severity === 'HIGH_RISK' && x.status === 'OPEN').length;
  const canPrintSlips = can(user, 'hr.payslips.view');
  const canCreate = can(user, 'hr.employees.create');
  const employerCost = num(p.grossTotal) + stat.employerNssf + stat.lst;
  const chargeable = stat.taxableIncome || num(p.grossTotal);
  const earnings = aggregateComponents(items, 'earnings');
  const deductions = aggregateComponents(items, 'deductions');

  return (
    <div className="page">
      <HrPageHeader
        kicker="Payroll run"
        title={'Payroll ' + str(p.payrollNo)}
        subtitle={
          <>
            {day(p.periodStart)} to {day(p.periodEnd)} &middot; {runTypeLabel(p.runType)} &middot; pay date {day(p.paymentDate)}
          </>
        }
        actions={
          <>
            <Badge value={p.status} />
            <button
              className="btn btn-sm"
              disabled={!canCreate}
              title={canCreate ? 'Hire someone onto this payroll' : 'Ask HR to grant this payroll role the right to add employees'}
              onClick={hireFromRun}
            >
              New employee
            </button>
            <button className="btn btn-sm" onClick={() => navigate('/people/payrolls')}>All runs</button>
          </>
        }
      />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}
      {openErrors > 0 && (
        <div className="alert alert-error" role="alert">
          <strong>{openErrors} blocking exception{openErrors === 1 ? '' : 's'}</strong> must be resolved before this run can move
          through review. Open the Overview tab for the detail.
          {highRisk > 0 && (<span> {highRisk} high-risk item{highRisk === 1 ? '' : 's'} also need a decision.</span>)}
        </div>
      )}
      {openErrors > 0 && (
        <div style={{ marginTop: 8 }}>
          <button className="btn btn-sm" onClick={() => setTab('Overview')}>Show the exceptions</button>
        </div>
      )}
      <HrKpiGrid>
        <HrKpi label="Headcount" value={fmtNum(items.length)} sub={runTypeLabel(p.runType)} />
        <HrKpi label="Gross" value={money(p.grossTotal)} sub="Earnings total" />
        <HrKpi label="Taxable" value={money(chargeable)} sub="Chargeable income" />
        <HrKpi label="PAYE" value={money(stat.paye || num(p.payeTotal))} sub="Pay as you earn" />
        <HrKpi label="Employee NSSF" value={money(stat.employeeNssf || num(p.nssfTotal))} sub="Deducted from staff" />
        <HrKpi label="Employer NSSF" value={money(stat.employerNssf)} sub="Employer cost" />
        <HrKpi label="Net pay" value={money(p.netTotal)} sub="After deductions" />
        <HrKpi label="Employer cost" value={money(employerCost)} sub="Gross plus statutory" />
      </HrKpiGrid>
      {simulation && (
        <section className="card">
          <div className="card-head">
            <h3>Simulation</h3>
            <div className="action-group">
              <span className="muted">No accounting posted</span>
              <button className="btn btn-sm" onClick={() => setSimulation(null)}>Dismiss</button>
            </div>
          </div>
          <div style={{ padding: 16 }}>
            <dl className="detail-list">
              <Row label="Headcount">{fmtNum(simulation.headcount)}</Row>
              <Row label="Gross">{money((simulation.totals as Rec | undefined)?.gross)}</Row>
              <Row label="PAYE">{money((simulation.totals as Rec | undefined)?.paye)}</Row>
              <Row label="NSSF (employee / employer)">
                {money((simulation.totals as Rec | undefined)?.employeeNssf)} / {money((simulation.totals as Rec | undefined)?.employerNssf)}
              </Row>
              <Row label="Net">{money((simulation.totals as Rec | undefined)?.net)}</Row>
              <Row label="Employer cost">{money((simulation.totals as Rec | undefined)?.employerCost)}</Row>
              <Row label="Previous run">
                {simulation.previousRun ? str((simulation.previousRun as Rec).payrollNo) : 'None available'}
              </Row>
            </dl>
          </div>
        </section>
      )}
      {workflow.length > 0 && (
        <section className="card">
          <div className="card-head">
            <h3>Workflow</h3>
            <span className="muted">Current stage: {str(workflow.find((s) => s.state === 'CURRENT')?.label) || 'Closed'}</span>
          </div>
          <ol className="pipeline" style={{ padding: 16 }}>
            {workflow.map((s) => (
              <li
                key={str(s.status)}
                className={
                  'pipeline-step ' + (s.state === 'DONE' ? 'done' : s.state === 'CURRENT' ? 'current' : '')
                }
              >
                <span className="pipeline-dot" aria-hidden />
                <span>{str(s.label)}</span>
              </li>
            ))}
          </ol>
        </section>
      )}
      <HrToolbar>
        {RECALC_STATUSES.includes(status) && can(user, 'hr.payrolls.update') && (
          <button className="btn" disabled={busy} onClick={() => act(`/api/ops/hr/payrolls/${id}/calculate`, 'Recalculated')}>Recalculate</button>
        )}
        {RECALC_STATUSES.includes(status) && can(user, 'hr.payrolls.update') && (
          <button className="btn" disabled={busy} onClick={runValidate}>Validate</button>
        )}
        {RECALC_STATUSES.includes(status) && can(user, 'hr.payrolls.calculate') && (
          <button className="btn" disabled={busy} onClick={runSimulate}>Simulate</button>
        )}
        {status === 'DRAFT' && can(user, 'hr.payrolls.submit') && (
          <button className="btn btn-primary" disabled={busy || openErrors > 0} title={openErrors > 0 ? openErrors + ' blocking exception' + (openErrors === 1 ? '' : 's') + ' must be resolved first - see Overview.' : undefined} onClick={() => act(`/api/ops/hr/payrolls/${id}/submit`, 'Submitted for approval')}>Submit for approval</button>
        )}
        {status === 'APPROVED' && can(user, 'hr.payrolls.release') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => setConfirm('release')}>Release payment</button>
        )}
        {status === 'RELEASED' && can(user, 'hr.payrolls.pay') && (
          <button className="btn btn-primary" disabled={busy} onClick={() => setConfirm('paid')}>Mark as paid</button>
        )}
        {POSTABLE_STATUSES.includes(status) && !p.glPosted && can(user, 'hr.payrolls.post') && (
          <button className="btn" disabled={busy} onClick={() => act(`/api/ops/hr/payrolls/${id}/post`, 'Posted to the general ledger')}>Post to GL</button>
        )}
        {CLOSABLE_STATUSES.includes(status) && can(user, 'hr.payrolls.close') && (
          <button className="btn btn-success" disabled={busy} onClick={() => setConfirm('close')}>Close payroll</button>
        )}
        {REOPENABLE_STATUSES.includes(status) && !p.glPosted && can(user, 'hr.payrolls.reopen') && (
          <button className="btn btn-danger" disabled={busy} onClick={() => setConfirm('reopen')}>Reopen</button>
        )}
        <span className="muted">|</span>
        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openRegisterDoc('pdf')}>Register PDF</button>
        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openRegisterDoc('xlsx')}>Register Excel</button>
        <button className="btn btn-sm" disabled={docBusy !== ''} onClick={() => openRegisterDoc('csv')}>Register CSV</button>
      </HrToolbar>
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={'tab' + (tab === t ? ' active' : '')} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>
      {tab === 'Overview' && <OverviewTab payroll={p} exceptions={exceptions} stat={stat} />}
      {tab === 'Employees' && (
        <EmployeesTab
          items={items}
          onOpen={setDrawer}
          canCreate={canCreate}
          onHire={hireFromRun}
          canPrintSlips={canPrintSlips}
          docBusy={docBusy}
          onPayslip={openPayslipDoc}
          onRegister={openRegisterDoc}
        />
      )}
      {tab === 'Earnings' && (
        <ComponentsTab
          title="Earnings"
          blurb="Every earning line that produced this run, aggregated across employees from the stored calculation breakdown."
          rows={earnings}
          total={num(p.grossTotal)}
          emptyTitle="No earnings recorded"
          emptyHint="Earnings appear once the run has been calculated."
          showTaxable
        />
      )}
      {tab === 'Deductions' && (
        <ComponentsTab
          title="Deductions"
          blurb="Statutory and voluntary deductions withheld from employees in this run, by component."
          rows={deductions}
          total={num(p.deductionTotal)}
          emptyTitle="No deductions recorded"
          emptyHint="Deductions appear once the run has been calculated."
          showTaxable={false}
        />
      )}
      {tab === 'Statutory' && <StatutoryTab payroll={p} stat={stat} items={items} />}
      {tab === 'Variance' && <VarianceTab payrollId={id} />}
      {tab === 'Payments' && (
        <PaymentsTab
          payroll={p}
          canBatch={can(user, 'hr.payrolls.update')}
          canPayslips={canPrintSlips}
          docBusy={docBusy}
          onPayslip={openPayslipDoc}
          onNotice={setNotice}
        />
      )}
      {tab === 'GL' && (
        <GlTab
          payroll={p}
          canPost={can(user, 'hr.payrolls.post')}
          busy={busy}
          onPost={() => { void act(`/api/ops/hr/payrolls/${id}/post`, 'Posted to the general ledger'); }}
        />
      )}
      {tab === 'Approvals' && <ApprovalsTab payrollId={id} />}
      {tab === 'Audit' && <AuditTab payrollId={id} />}

      {drawer && (
        <EmployeeDrawer
          item={drawer}
          onClose={() => setDrawer(null)}
          canPrintSlips={canPrintSlips}
          docBusy={docBusy}
          onPayslip={openPayslipDoc}
        />
      )}

      {confirm === 'release' && (
        <ConfirmDialog
          title="Release payment"
          body={'Authorising payment for ' + str(p.payrollNo) + ' (' + money(p.netTotal) + ' to ' + fmtNum(items.length) + ' employees). The run becomes immutable and is locked from further edits.'}
          confirmLabel="Authorise payment"
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => {
            setConfirm(null);
            void act(`/api/ops/hr/payrolls/${id}/release`, 'Payment authorised', { comment: reason });
          }}
        />
      )}

      {confirm === 'paid' && (
        <ConfirmDialog
          title="Mark as paid"
          body={'Confirm the bank has settled this payroll. A validated, approved and confirmed payment batch must exist for ' + str(p.payrollNo) + ' first.'}
          confirmLabel="Confirm paid"
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => {
            setConfirm(null);
            void act(`/api/ops/hr/payrolls/${id}/paid`, 'Payroll marked as paid', { comment: reason });
          }}
        />
      )}

      {confirm === 'close' && (
        <ConfirmDialog
          title="Close payroll"
          body="Closing locks the run permanently. Record the variance explanation that supports this period's movement before closing."
          confirmLabel="Close payroll"
          reasonLabel="Variance explanation"
          reasonRequired
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => {
            setConfirm(null);
            void act(`/api/ops/hr/payrolls/${id}/close`, 'Payroll closed', { comment: reason, varianceExplanation: reason });
          }}
        />
      )}

      {confirm === 'reopen' && (
        <ConfirmDialog
          title="Reopen payroll"
          body="Reopening returns this run to draft so it can be corrected and recalculated. Every approval is cleared and the reopening is written to the audit trail."
          confirmLabel="Reopen payroll"
          danger
          reasonLabel="Reason for reopening (at least 10 characters)"
          reasonRequired
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => {
            const trimmed = reason.trim();
            if (trimmed.length < 10) {
              setError('Give a reason of at least 10 characters for reopening this payroll.');
              return;
            }
            setConfirm(null);
            void act(`/api/ops/hr/payrolls/${id}/reopen`, 'Payroll reopened for correction', { reason: trimmed, recalculate: true });
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Payroll calendar (spec 5, 43)                                      */
/* ------------------------------------------------------------------ */

const PERIOD_STATUS_FILTERS = ['', 'OPEN', 'LOCKED', 'CLOSED', 'CANCELLED'];
const PERIOD_FREQUENCIES = ['MONTHLY', 'SEMI_MONTHLY', 'BIWEEKLY', 'WEEKLY', 'QUARTERLY', 'ANNUAL'];
const PERIOD_TYPE_OPTIONS = ['NORMAL', 'OFF_CYCLE', 'FINAL', 'ADJUSTMENT', 'REVERSAL', 'ARREARS'];

function periodTone(status: unknown): string {
  const s = str(status);
  if (s === 'OPEN') return 'chip chip-green';
  if (s === 'LOCKED') return 'chip chip-amber';
  if (s === 'CANCELLED') return 'chip chip-red';
  return 'chip';
}

function labelOf(value: unknown): string {
  return str(value).replace(/_/g, ' ');
}

function emptyPeriodDraft() {
  const now = new Date();
  const first = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const last = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0));
  return {
    periodStart: first.toISOString().slice(0, 10),
    periodEnd: last.toISOString().slice(0, 10),
    frequency: 'MONTHLY',
    periodType: 'NORMAL',
    paymentDate: last.toISOString().slice(0, 10),
    cutoffDate: last.toISOString().slice(0, 10),
    fiscalYear: String(now.getUTCFullYear()),
    notes: '',
  };
}

/**
 * The calendar payroll runs hang off. A period carries the statutory rule
 * version a run is calculated against, so it is the anchor that keeps an old
 * payroll reproducible after the rates move.
 */
export function PayrollCalendar() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState('');
  const [qInput, setQInput] = useState('');
  const [q, setQ] = useState('');
  const [open, setOpen] = useState<Rec | null>(null);
  const [detail, setDetail] = useState<Rec | null>(null);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState(emptyPeriodDraft);
  const [confirm, setConfirm] = useState<{ title: string; body: string; label: string; danger?: boolean; reason?: string; run: (reason: string) => void } | null>(null);

  const canCreate = can(user, 'hr.payroll_periods.create');
  const canUpdate = can(user, 'hr.payroll_periods.update');
  const canClose = can(user, 'hr.payroll_periods.close');

  const load = useCallback(() => {
    const params = new URLSearchParams();
    params.set('page', String(page));
    params.set('pageSize', String(pageSize));
    if (status) params.set('status', status);
    if (q) params.set('q', q);
    api<{ data: { items: Rec[]; total: number } }>(`/api/ops/hr/payroll-periods?${params.toString()}`)
      .then((r) => {
        setRows(r.data.items ?? []);
        setTotal(Number(r.data.total) || 0);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Payroll calendar failed'));
  }, [page, pageSize, status, q]);
  useEffect(() => { load(); }, [load]);

  const openPeriod = (row: Rec) => {
    setOpen(row);
    setDetail(null);
    api<{ data: Rec }>(`/api/ops/hr/payroll-periods/${row.id}`)
      .then((r) => setDetail(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : 'Period failed'));
  };

  const act = async (path: string, ok: string, body: Rec = {}) => {
    setBusy(true); setError(''); setNotice('');
    try {
      await api(path, { method: 'POST', body: JSON.stringify(body) });
      setNotice(ok);
      setOpen(null); setDetail(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const create = async () => {
    setBusy(true); setError(''); setNotice('');
    try {
      const r = await api<{ data: Rec }>('/api/ops/hr/payroll-periods', {
        method: 'POST',
        body: JSON.stringify({
          periodStart: draft.periodStart,
          periodEnd: draft.periodEnd,
          frequency: draft.frequency,
          periodType: draft.periodType,
          paymentDate: draft.paymentDate || undefined,
          cutoffDate: draft.cutoffDate || undefined,
          fiscalYear: draft.fiscalYear ? Number(draft.fiscalYear) : undefined,
          notes: draft.notes || undefined,
        }),
      });
      setNotice('Payroll period ' + str(r.data.code) + ' opened.');
      setCreating(false);
      setDraft(emptyPeriodDraft());
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const periodRuns = (detail?.runs as Rec[] | undefined) ?? [];

  return (
    <div className="page">
      <HrPageHeader
        kicker="Payroll calendar"
        title="Payroll periods"
        subtitle="The calendar runs are attached to. Each period pins the statutory rule version a run is calculated against."
        actions={
          <>
            <button className="btn btn-sm" onClick={() => navigate('/people/payrolls')}>Command centre</button>
            <button className="btn btn-sm" onClick={() => navigate('/people/payrolls/runs')}>All runs</button>
            {canCreate && <button className="btn btn-primary btn-sm" onClick={() => setCreating((v) => !v)}>{creating ? 'Cancel' : 'New period'}</button>}
          </>
        }
      />
      {notice && <div className="alert alert-success">{notice}</div>}
      {error && <ErrorBanner error={error} />}

      {creating && (
        <section className="card">
          <div className="card-head"><h3>Open a payroll period</h3><span className="muted">The code is allocated automatically.</span></div>
          <div style={{ padding: 16 }}>
            <div className="grid-2">
              <div className="field field-required"><label>Period start</label><input type="date" value={draft.periodStart} onChange={(e) => setDraft({ ...draft, periodStart: e.target.value })} /></div>
              <div className="field field-required"><label>Period end</label><input type="date" value={draft.periodEnd} onChange={(e) => setDraft({ ...draft, periodEnd: e.target.value })} /></div>
              <div className="field"><label>Frequency</label>
                <select value={draft.frequency} onChange={(e) => setDraft({ ...draft, frequency: e.target.value })}>
                  {PERIOD_FREQUENCIES.map((v) => <option key={v} value={v}>{labelOf(v)}</option>)}
                </select>
              </div>
              <div className="field"><label>Period type</label>
                <select value={draft.periodType} onChange={(e) => setDraft({ ...draft, periodType: e.target.value })}>
                  {PERIOD_TYPE_OPTIONS.map((v) => <option key={v} value={v}>{labelOf(v)}</option>)}
                </select>
              </div>
              <div className="field"><label>Pay date</label><input type="date" value={draft.paymentDate} onChange={(e) => setDraft({ ...draft, paymentDate: e.target.value })} /></div>
              <div className="field"><label>Cut-off date</label><input type="date" value={draft.cutoffDate} onChange={(e) => setDraft({ ...draft, cutoffDate: e.target.value })} /></div>
              <div className="field"><label>Fiscal year</label><input type="number" value={draft.fiscalYear} onChange={(e) => setDraft({ ...draft, fiscalYear: e.target.value })} /></div>
              <div className="field"><label>Notes</label><input value={draft.notes} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} placeholder="Optional" /></div>
            </div>
            <button className="btn btn-primary" style={{ marginTop: 16 }} disabled={busy} onClick={create}>Open period</button>
          </div>
        </section>
      )}

      <HrToolbar>
        <select value={status} onChange={(e) => { setStatus(e.target.value); setPage(1); }}>
          {PERIOD_STATUS_FILTERS.map((s) => <option key={s || 'all'} value={s}>{s ? labelOf(s) : 'All statuses'}</option>)}
        </select>
        <input
          value={qInput}
          placeholder="Search code or group"
          onChange={(e) => setQInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { setQ(qInput.trim()); setPage(1); } }}
        />
        <button className="btn btn-sm" onClick={() => { setQ(qInput.trim()); setPage(1); }}>Search</button>
        <span className="muted">{fmtNum(total)} periods</span>
      </HrToolbar>

      <div className="table-wrap card">
        <table className="data">
          <thead>
            <tr>
              <th>Code</th>
              <th>Period</th>
              <th>Pay date</th>
              <th>Frequency</th>
              <th>Type</th>
              <th>Status</th>
              <th className="cell-num">Runs</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={String(r.id)} className="row-click" onClick={() => openPeriod(r)}>
                <td className="cell-mono">{str(r.code)}</td>
                <td>{day(r.periodStart)} to {day(r.periodEnd)}</td>
                <td>{day(r.paymentDate)}</td>
                <td>{labelOf(r.frequency)}</td>
                <td>{labelOf(r.periodType)}{r.payrollGroupName ? <span className="cell-sub">{str(r.payrollGroupName)}</span> : null}</td>
                <td><span className={periodTone(r.status)}>{labelOf(r.status)}</span></td>
                <td className="cell-num">{fmtNum(r.runCount)}</td>
              </tr>
            ))}
            {rows.length === 0 && <HrTableEmpty colSpan={7} title="No payroll periods" hint="Open a period to start scheduling runs against a pay date." />}
          </tbody>
        </table>
      </div>
      {total > pageSize && (
        <Pager page={page} pageSize={pageSize} total={total} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
      )}

      {open && (
        <Drawer title={'Payroll period ' + str(open.code)} onClose={() => { setOpen(null); setDetail(null); }}>
          <dl className="detail-list">
            <Row label="Period">{day(open.periodStart)} to {day(open.periodEnd)}</Row>
            <Row label="Pay date">{day(open.paymentDate)}</Row>
            <Row label="Cut-off">{day(open.cutoffDate)}</Row>
            <Row label="Frequency">{labelOf(open.frequency)}</Row>
            <Row label="Type">{labelOf(open.periodType)}</Row>
            <Row label="Status"><span className={periodTone(open.status)}>{labelOf(open.status)}</span></Row>
            <Row label="Fiscal year">{str(open.fiscalYear)}</Row>
            <Row label="Statutory rules">{str(open.statutoryRuleVersion) || 'Resolved at calculation'}</Row>
            <Row label="Notes">{str(open.notes) || '-'}</Row>
            <Row label="Closed by">{str(open.closedBy) ? str(open.closedBy) + ' on ' + day(open.closedAt) : '-'}</Row>
          </dl>
          <h4 style={{ marginTop: 18 }}>Runs in this period</h4>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Run</th><th>Type</th><th>Status</th><th className="cell-num">Gross</th><th className="cell-num">Net</th></tr></thead>
              <tbody>
                {periodRuns.map((r) => (
                  <tr key={String(r.id)} className="row-click" onClick={() => navigate(`/people/payrolls/${r.id}`)}>
                    <td className="cell-mono">{str(r.payrollNo)}</td>
                    <td>{labelOf(r.runType)}</td>
                    <td><Badge value={r.status} /></td>
                    <td className="cell-num">{money(r.grossTotal)}</td>
                    <td className="cell-num">{money(r.netTotal)}</td>
                  </tr>
                ))}
                {periodRuns.length === 0 && <HrTableEmpty colSpan={5} title="No runs yet" hint="Create a payroll run and attach it to this period." />}
              </tbody>
            </table>
          </div>
          <div className="action-group" style={{ marginTop: 16 }}>
            <button className="btn btn-primary btn-sm" onClick={() => navigate(`/people/payrolls/new?periodId=${str(open.id)}`)}>Start a run</button>
            {canUpdate && str(open.status) === 'OPEN' && (
              <button className="btn btn-sm" disabled={busy} onClick={() => setConfirm({
                title: 'Lock period',
                body: 'A locked period still accepts corrections but no new run may be opened against it without an unlock.',
                label: 'Lock period',
                run: (reason) => act(`/api/ops/hr/payroll-periods/${open.id}/lock`, 'Period locked', { reason }),
              })}>Lock</button>
            )}
            {canUpdate && str(open.status) === 'LOCKED' && (
              <button className="btn btn-sm" disabled={busy} onClick={() => setConfirm({
                title: 'Unlock period',
                body: 'Unlocking reopens the period to new runs. Record why.',
                label: 'Unlock period',
                run: (reason) => act(`/api/ops/hr/payroll-periods/${open.id}/unlock`, 'Period unlocked', { reason }),
              })}>Unlock</button>
            )}
            {canClose && str(open.status) !== 'CLOSED' && str(open.status) !== 'CANCELLED' && (
              <button className="btn btn-danger btn-sm" disabled={busy} onClick={() => setConfirm({
                title: 'Close period',
                body: 'Closing is final. Every run in the period must already be closed or cancelled.',
                label: 'Close period',
                danger: true,
                run: (reason) => act(`/api/ops/hr/payroll-periods/${open.id}/close`, 'Period closed', { reason }),
              })}>Close</button>
            )}
            {canClose && str(open.status) !== 'CANCELLED' && str(open.status) !== 'CLOSED' && (
              <button className="btn btn-sm" disabled={busy} onClick={() => setConfirm({
                title: 'Cancel period',
                body: 'Cancelling withdraws the period. It cannot be used for a run afterwards.',
                label: 'Cancel period',
                danger: true,
                run: (reason) => act(`/api/ops/hr/payroll-periods/${open.id}/cancel`, 'Period cancelled', { reason }),
              })}>Cancel</button>
            )}
          </div>
        </Drawer>
      )}

      {confirm && (
        <ConfirmDialog
          title={confirm.title}
          body={confirm.body}
          confirmLabel={confirm.label}
          danger={confirm.danger}
          reasonLabel="Reason (written to the audit trail)"
          reasonRequired
          onCancel={() => setConfirm(null)}
          onConfirm={(reason) => { const c = confirm; setConfirm(null); if (c) c.run(reason); }}
        />
      )}
    </div>
  );
}


/* ------------------------------------------------------------------ */
/* Statutory compliance centre (spec 35, 36)                          */
/* ------------------------------------------------------------------ */

const ST_OBLIGATIONS = [
  {
    category: 'PAYE',
    label: 'PAYE',
    remitter: 'Uganda Revenue Authority',
    blurb: 'Pay As You Earn withheld from chargeable employment income.',
  },
  {
    category: 'NSSF',
    label: 'NSSF',
    remitter: 'National Social Security Fund',
    blurb: 'Employee and employer social security contributions.',
  },
  {
    category: 'LST',
    label: 'Local service tax',
    remitter: 'Local government',
    blurb: 'Local service tax levied on resident employees.',
  },
];

// The filing lifecycle is PENDING -> PREPARED -> SUBMITTED -> ACCEPTED -> PAID,
// with LATE and CANCELLED as terminal side states, so the tone tracks how far
// a return has travelled rather than a single filed/not-filed flag.
function filingTone(status: unknown): string {
  const s = str(status).toUpperCase();
  if (s === 'PAID') return 'chip chip-green';
  if (s === 'ACCEPTED') return 'chip chip-green';
  if (s === 'SUBMITTED') return 'chip';
  if (s === 'PREPARED') return 'chip chip-amber';
  if (s === 'LATE') return 'chip chip-red';
  if (s === 'CANCELLED') return 'chip chip-red';
  if (s === 'PENDING') return 'chip chip-amber';
  return 'chip';
}

const FILING_STATUSES = ['PENDING', 'PREPARED', 'SUBMITTED', 'ACCEPTED', 'PAID', 'LATE', 'CANCELLED'];

// Which transitions the register offers for a filing in a given status. Accept
// is deliberately separate from submit because the authority acknowledges a
// return and that acknowledgement is a different fact from sending it.
function filingActions(status: unknown): string[] {
  const s = str(status).toUpperCase();
  if (s === 'PENDING') return ['prepare', 'submit', 'cancel'];
  if (s === 'PREPARED') return ['submit', 'cancel'];
  if (s === 'SUBMITTED') return ['accept', 'pay', 'cancel'];
  if (s === 'ACCEPTED') return ['pay', 'cancel'];
  if (s === 'LATE') return ['pay', 'cancel'];
  return [];
}

function filingActionLabel(action: string): string {
  if (action === 'prepare') return 'Mark prepared';
  if (action === 'submit') return 'Submit return';
  if (action === 'accept') return 'Record acknowledgement';
  if (action === 'pay') return 'Record payment';
  if (action === 'reconcile') return 'Reconcile';
  if (action === 'cancel') return 'Cancel return';
  return action;
}

// What each transition actually means, so the confirmation states the
// consequence rather than only repeating the button that was pressed.
function filingActionHelp(action: string): string {
  if (action === 'prepare') return 'This marks the return as assembled and ready to declare. No declared amount changes.';
  if (action === 'submit') return 'This records that the return was sent to the authority, so its declared amounts start counting as filed.';
  if (action === 'accept') return 'This records the authority acknowledging the return. It is deliberately a separate fact from sending it.';
  if (action === 'pay') return 'This records that the declared amount was remitted, so settlement is stored against the return.';
  if (action === 'reconcile') return 'This records the amount actually settled with the authority and keeps any variance instead of discarding it.';
  if (action === 'cancel') return 'This cancels the return. A written reason of at least 10 characters is required and is kept on the audit trail.';
  return 'This records the transition against the return.';
}

// Only the fields the endpoint accepts are sent, so an empty note never
// overwrites a value the register already holds.
function filingActionBody(action: string, reason: string, paymentReference: string, reconciledAmount: string): Rec {
  const note = reason.trim();
  if (action === 'reconcile') {
    return {
      reconciledAmount: Number(reconciledAmount),
      ...(note ? { notes: note } : {}),
    };
  }
  if (action === 'cancel') return { reason };
  if (action === 'pay') {
    return {
      ...(paymentReference.trim() ? { paymentReference: paymentReference.trim() } : {}),
      ...(note ? { notes: note } : {}),
    };
  }
  return note ? { notes: note } : {};
}

function ruleStateTone(state: unknown): string {
  const s = str(state);
  if (s === 'IN_EFFECT') return 'chip chip-green';
  if (s === 'SCHEDULED') return 'chip';
  if (s === 'EXPIRED' || s === 'SUPERSEDED') return 'chip chip-red';
  if (s === 'SHADOWED_BY_COMPANY' || s === 'OUTRANKED') return 'chip chip-amber';
  return 'chip';
}

function jsonBlock(value: unknown): string {
  if (value === null || value === undefined) return 'not configured';
  try {
    const out = JSON.stringify(value, null, 2);
    return out === undefined ? String(value) : out;
  } catch {
    return String(value);
  }
}

function varianceTone(value: number): string {
  if (Math.abs(value) < 0.5) return 'chip chip-green';
  if (Math.abs(value) < 1000) return 'chip chip-amber';
  return 'chip chip-red';
}

export function StatutoryCompliance() {
  const { user } = useAuth();
  const canSeeLiability = can(user, 'hr.payrolls.view');
  const canSeeRules = can(user, 'hr.statutory_configs.view');
  const canManage = can(user, 'hr.statutory_configs.update');
  const canSeeFilings = can(user, 'hr.statutory.view');
  const canFile = can(user, 'hr.statutory.create');
  const canMove = can(user, 'hr.statutory.update');
  const canApproveFiling = can(user, 'hr.statutory.approve');

  const [asOf, setAsOf] = useState(() => new Date().toISOString().slice(0, 10));
  const [companyId, setCompanyId] = useState('');
  const [centre, setCentre] = useState<Rec | null>(null);
  const [rules, setRules] = useState<StatutoryPayload | null>(null);
  const [error, setError] = useState('');
  const [rulesError, setRulesError] = useState('');
  const [ruleOpen, setRuleOpen] = useState<StatutoryConfig | null>(null);

  const [grossInput, setGrossInput] = useState('1500000');
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);

  // Returns and remittances are their own register. The command centre can only
  // show the liability a run produced; declaring that liability and settling it
  // is a separate workflow with its own evidence, so it is read from the filing
  // table rather than inferred from the run.
  const [filingRows, setFilingRows] = useState<Rec[]>([]);
  const [filingsPage, setFilingsPage] = useState(1);
  const [filingsPageSize, setFilingsPageSize] = useState(25);
  const [filingsTotal, setFilingsTotal] = useState(0);
  const [filingStatusFilter, setFilingStatusFilter] = useState('');
  const [filingsCategory, setFilingsCategory] = useState('');
  const [filingsOverdueOnly, setFilingsOverdueOnly] = useState(false);
  const [filingsQuery, setFilingsQuery] = useState('');
  const [filingsError, setFilingsError] = useState('');
  const [filingsNonce, setFilingsNonce] = useState(0);
  const [filingDetail, setFilingDetail] = useState<Rec | null>(null);
  const [filingDetailBusy, setFilingDetailBusy] = useState(false);
  const [filingDetailError, setFilingDetailError] = useState('');
  const [filingAction, setFilingAction] = useState<{ kind: string; filing: Rec } | null>(null);
  const [filingActionBusy, setFilingActionBusy] = useState(false);
  const [filingActionError, setFilingActionError] = useState('');
  // Reconcile needs the amount actually settled and pay needs the remittance
  // reference, so the confirmation carries those facts rather than only a note.
  const [filingReconcileAmount, setFilingReconcileAmount] = useState('');
  const [filingPayReference, setFilingPayReference] = useState('');
  const [filingCreateOpen, setFilingCreateOpen] = useState(false);
  const [filingDraft, setFilingDraft] = useState(() => ({
    category: 'PAYE',
    periodStart: new Date().toISOString().slice(0, 8) + '01',
    periodEnd: new Date().toISOString().slice(0, 10),
    dueDate: '',
    taxPeriod: '',
    notes: '',
  }));

  const load = useCallback(() => {
    if (canSeeLiability) {
      api<{ data: Rec }>('/api/ops/hr/payrolls/command-centre')
        .then((r) => { setCentre(r.data); setError(''); })
        .catch((e) => setError(e instanceof Error ? e.message : 'Statutory liability failed'));
    }
    if (canSeeRules) {
      const params = new URLSearchParams();
      params.set('asOf', asOf);
      if (companyId) params.set('companyId', companyId);
      api<{ data: StatutoryPayload }>('/api/ops/hr/statutory-configs?' + params.toString())
        .then((r) => { setRules(r.data); setRulesError(''); })
        .catch((e) => setRulesError(e instanceof Error ? e.message : 'Statutory rules failed'));
    }
  }, [asOf, companyId, canSeeLiability, canSeeRules]);
  useEffect(() => { load(); }, [load]);

  const loadFilings = useCallback(() => {
    if (!canSeeFilings) return;
    const params = new URLSearchParams();
    params.set('page', String(filingsPage));
    params.set('pageSize', String(filingsPageSize));
    if (filingStatusFilter) params.set('status', filingStatusFilter);
    if (filingsCategory) params.set('category', filingsCategory);
    if (filingsOverdueOnly) params.set('overdueOnly', 'true');
    if (filingsQuery.trim()) params.set('q', filingsQuery.trim());
    api<{ data: Rec }>('/api/ops/hr/statutory-filings?' + params.toString())
      .then((r) => {
        const payload = (r.data ?? {}) as Rec;
        setFilingRows(Array.isArray(payload.items) ? (payload.items as Rec[]) : []);
        setFilingsTotal(num(payload.totalCount));
        setFilingsError('');
      })
      .catch((e) => {
        setFilingRows([]);
        setFilingsTotal(0);
        setFilingsError(e instanceof Error ? e.message : 'Statutory returns failed');
      });
  }, [canSeeFilings, filingsCategory, filingsOverdueOnly, filingsPage, filingsPageSize, filingsQuery, filingStatusFilter]);

  useEffect(() => { loadFilings(); }, [loadFilings, filingsNonce]);

  const openFiling = useCallback(
    (id: unknown) => {
      setFilingDetailBusy(true);
      setFilingDetailError('');
      api<{ data: Rec }>('/api/ops/hr/statutory-filings/' + String(id))
        .then((r) => setFilingDetail(r.data))
        .catch((e) => setFilingDetailError(e instanceof Error ? e.message : 'Statutory return failed'))
        .finally(() => setFilingDetailBusy(false));
    },
    []
  );

  // Every transition posts to the register's own endpoint and then re-reads the
  // filing so the drawer shows the state the server actually stored, not the
  // state the client hoped to write.
  const runFilingAction = useCallback(
    (action: string, body: Rec) => {
      if (!filingAction) return;
      setFilingActionBusy(true);
      setFilingActionError('');
      api<{ data: Rec }>('/api/ops/hr/statutory-filings/' + String(filingAction.filing.id) + '/' + action, {
        method: 'POST',
        body: JSON.stringify(body),
      })
        .then((r) => {
          setFilingAction(null);
          openFiling(filingAction.filing.id);
          setFilingsNonce((n) => n + 1);
          void r;
        })
        .catch((e) => setFilingActionError(e instanceof Error ? e.message : 'Statutory action failed'))
        .finally(() => setFilingActionBusy(false));
    },
    [filingAction, openFiling]
  );

  const createFiling = useCallback(() => {
    setFilingActionBusy(true);
    setFilingActionError('');
    api<{ data: Rec }>('/api/ops/hr/statutory-filings', {
      method: 'POST',
      body: JSON.stringify(filingDraft),
    })
      .then(() => {
        setFilingCreateOpen(false);
        setFilingsNonce((n) => n + 1);
      })
      .catch((e) => setFilingActionError(e instanceof Error ? e.message : 'Could not record the return'))
      .finally(() => setFilingActionBusy(false));
  }, [filingDraft]);

  // The engine's own preview is the single source of truth for statutory
  // arithmetic, so the compliance centre never restates a band or a rate.
  useEffect(() => {
    if (!canSeeRules) return;
    let alive = true;
    setPreviewBusy(true);
    setPreviewError('');
    const body: Rec = { asOf, gross: Number(grossInput) || 0 };
    if (companyId) body.companyId = Number(companyId);
    api<{ data: PreviewPayload }>('/api/ops/hr/statutory-configs/preview', { method: 'POST', body: JSON.stringify(body) })
      .then((r) => { if (alive) setPreview(r.data); })
      .catch((e) => { if (alive) { setPreview(null); setPreviewError(e instanceof Error ? e.message : String(e)); } })
      .finally(() => { if (alive) setPreviewBusy(false); });
    return () => { alive = false; };
  }, [asOf, companyId, canSeeRules, previewNonce, grossInput]);

  const current = (centre?.current ?? null) as Rec | null;
  const currency = str(current?.currency) || 'UGX';
  const statBlock = (centre?.statutory ?? {}) as Rec;
  const expected = (statBlock.expected ?? {}) as Rec;
  const filings = Array.isArray(statBlock.filings) ? (statBlock.filings as Rec[]) : [];

  const expPaye = num(expected.paye);
  const expEeNssf = num(expected.employeeNssf);
  const expErNssf = num(expected.employerNssf);
  const expLst = num(expected.lst);
  const expEmployeeSide = expPaye + expEeNssf + expLst;
  const expEmployerSide = expErNssf;
  const expTotal = expEmployeeSide + expEmployerSide;

  const filedEmployee = filings.reduce((sum, f) => sum + num(f.employeeContribution), 0);
  const filedEmployer = filings.reduce((sum, f) => sum + num(f.employerContribution), 0);
  const filedGross = filings.reduce((sum, f) => sum + num(f.grossAmount), 0);
  const employeeVariance = filedEmployee - expEmployeeSide;
  const employerVariance = filedEmployer - expEmployerSide;

  const resolution = rules?.resolution ?? [];
  const configs = rules?.configs ?? [];
  const companies = rules?.companies ?? [];
  const configById = new Map<number, StatutoryConfig>();
  configs.forEach((cfg) => configById.set(cfg.id, cfg));
  const missingRules = resolution.filter((r) => r.missing);
  const ruleFor = (category: string) => resolution.find((r) => r.category === category);

  const filingsStatus = filings.length
    ? (filings.some((f) => str(f.status).toUpperCase() === 'LATE')
        ? 'LATE'
        : filings.some((f) => str(f.status).toUpperCase() === 'PENDING')
          ? 'PENDING'
          : filings.every((f) => str(f.status).toUpperCase() === 'PAID')
            ? 'PAID'
            : 'SUBMITTED')
    : 'NOT FILED';

  // Register totals come from the register rows themselves, not from the
  // command centre, so the KPI strip always reflects the filter in force.
  const filingsDeclaredTotal = filingRows.reduce((sum, f) => sum + num(f.declaredTotal), 0);
  const filingsSettledTotal = filingRows.reduce((sum, f) => sum + num(f.settledTotal), 0);
  const filingsOutstandingTotal = filingRows.reduce((sum, f) => sum + num(f.outstanding), 0);
  const filingsOverdueCount = filingRows.filter((f) => f.overdue === true).length;
  const filingsCurrency = filingRows.length ? str(filingRows[0].currency) : currency;
  const filingCategories = [...ST_OBLIGATIONS.map((o) => o.category), 'OTHER'];
  const detailFiling = (filingDetail?.filing ?? null) as Rec | null;
  const detailLiability = (filingDetail?.liability ?? null) as Rec | null;
  const detailReconciliation = (filingDetail?.reconciliation ?? null) as Rec | null;
  const detailHistory = (Array.isArray(filingDetail?.history) ? filingDetail?.history : []) as Rec[];
  const detailActions = (detailFiling ? filingActions(detailFiling.status) : []).filter((action) =>
    action === 'accept' || action === 'cancel' ? canApproveFiling : canMove
  );

  const siblings = ruleOpen
    ? configs
        .filter((c) => c.category === ruleOpen.category && c.code === ruleOpen.code)
        .slice()
        .sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1))
    : [];

  const obligations = [
    { category: 'PAYE', label: 'PAYE', liability: expPaye, employer: 0 },
    { category: 'NSSF', label: 'NSSF', liability: expEeNssf, employer: expErNssf },
    { category: 'LST', label: 'Local service tax', liability: expLst, employer: 0 },
  ];

  return (
    <div className="stack">
      <HrPageHeader
        kicker="Payroll"
        title="Statutory compliance"
        subtitle="Every statutory obligation for the selected company: the rule version in force, the liability the payroll run produced, the return that was filed and the reconciliation between the two."
        actions={
          <div className="action-group">
            <button className="btn btn-sm" onClick={() => navigate('/people/statutory-configs')}>
              Statutory configuration
            </button>
            <button className="btn btn-sm" onClick={() => navigate('/people/payroll-settings')}>
              Payroll settings
            </button>
            <button className="btn btn-sm" onClick={() => navigate('/people/payrolls')}>
              Payroll runs
            </button>
          </div>
        }
      />

      <HrToolbar>
        <label className="field">
          <span>Rules in force as at</span>
          <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
        </label>
        {companies.length > 0 && (
          <label className="field">
            <span>Company rule set</span>
            <select value={companyId} onChange={(e) => setCompanyId(e.target.value)}>
              <option value="">Group default</option>
              {companies.map((c) => (
                <option key={c.id} value={String(c.id)}>{c.name}</option>
              ))}
            </select>
          </label>
        )}
        <button className="btn btn-sm" onClick={load}>Refresh</button>
        <span className="muted">
          {current
            ? 'Current run ' + str(current.payrollNo) + ' (' + str(current.runType) + ')'
            : 'No payroll run captured yet'}
        </span>
      </HrToolbar>

      {error && <ErrorBanner error={error} />}
      {rulesError && <ErrorBanner error={rulesError} />}

      {missingRules.length > 0 && (
        <div className="alert alert-error">
          <strong>Statutory configuration is incomplete.</strong>{' '}
          No rule is in force as at {asOf} for: {missingRules.map((r) => r.category).join(', ')}.
          Payroll cannot produce a defensible calculation until each of those categories is configured.
        </div>
      )}

      <HrKpiGrid>
        <HrKpi label="PAYE liability" value={money(expPaye)} sub={currency + ' - in the current run'} />
        <HrKpi label="Employee NSSF" value={money(expEeNssf)} sub="Deducted from employee pay" />
        <HrKpi label="Employer NSSF" value={money(expErNssf)} sub="Employer cost, not net pay" />
        <HrKpi label="Local service tax" value={money(expLst)} sub="Where configured for the company" />
        <HrKpi label="Total statutory due" value={money(expTotal)} sub={'Filing status: ' + filingsStatus} />
      </HrKpiGrid>

      <Panel title="Obligations and the rules in force">
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Obligation</th>
                <th>Remitter</th>
                <th>Rule in force</th>
                <th>Version</th>
                <th>Scope</th>
                <th className="cell-num">Employee share</th>
                <th className="cell-num">Employer share</th>
                <th className="cell-num">Total liability</th>
              </tr>
            </thead>
            <tbody>
              {obligations.map((o) => {
                const row = ruleFor(o.category);
                const cfg = row && row.configId !== null ? configById.get(row.configId) : undefined;
                return (
                  <tr key={o.category}>
                    <td>
                      <strong>{o.label}</strong>
                      <span className="cell-sub">{o.category}</span>
                    </td>
                    <td>{str(ST_OBLIGATIONS.find((s) => s.category === o.category)?.remitter)}</td>
                    <td>
                      {row && !row.missing ? (
                        <button className="link" onClick={() => cfg && setRuleOpen(cfg)}>
                          {str(row.code)}
                        </button>
                      ) : (
                        <span className="chip chip-red">Not configured</span>
                      )}
                    </td>
                    <td>{row && row.version !== null ? 'v' + String(row.version) : '-'}</td>
                    <td>{row && row.scope ? (row.scope === 'COMPANY' ? 'Company override' : 'Group default') : '-'}</td>
                    <td className="cell-num">{money(o.liability)}</td>
                    <td className="cell-num">{o.employer ? money(o.employer) : '-'}</td>
                    <td className="cell-num"><strong>{money(o.liability + o.employer)}</strong></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Panel>

      <div className="grid-2">
        <Panel title="Reconciliation: calculated against filed">
          <Row label="Employee-side liability">
            {money(expEmployeeSide)} <span className="muted">(PAYE + employee NSSF + LST)</span>
          </Row>
          <Row label="Employer-side liability">{money(expEmployerSide)} <span className="muted">(employer NSSF)</span></Row>
          <Row label="Recorded on returns">{money(filedEmployee + filedEmployer)} across {fmtNum(filings.length)} filing(s)</Row>
          <Row label="Gross declared on returns">{money(filedGross)}</Row>
          <div className="detail-row">
            <span>Employee-side variance</span>
            <span className={varianceTone(employeeVariance)}>{money(employeeVariance)}</span>
          </div>
          <div className="detail-row">
            <span>Employer-side variance</span>
            <span className={varianceTone(employerVariance)}>{money(employerVariance)}</span>
          </div>
          {Math.abs(employeeVariance) >= 0.5 || Math.abs(employerVariance) >= 0.5 ? (
            <div className="alert alert-error">
              The amount recorded on statutory returns does not equal the liability this payroll produced.
              Reconciliation must be completed and evidenced before the period is closed.
            </div>
          ) : (
            <div className="alert alert-success">
              Every recorded return agrees with the calculated liability for the selected run.
              {filings.length === 0 && ' No return has been recorded yet, so there is nothing to reconcile against.'}
            </div>
          )}
        </Panel>

        <Panel title="Statutory calculator (engine preview)">
          <p className="muted">
            Uses the same rule resolver and arithmetic that produces a payslip. Nothing here is stored.
          </p>
          <div className="action-group">
            <label className="field">
              <span>Taxable gross ({currency})</span>
              <input
                type="number"
                value={grossInput}
                onChange={(e) => setGrossInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') setPreviewNonce((n) => n + 1); }}
              />
            </label>
            <button className="btn btn-sm" disabled={previewBusy} onClick={() => setPreviewNonce((n) => n + 1)}>
              {previewBusy ? 'Calculating...' : 'Recalculate'}
            </button>
          </div>
          {previewError && <ErrorBanner error={previewError} />}
          {preview && (
            <>
              <div className="timeline">
                {preview.steps.map((step, index) => (
                  <div className="timeline-item" key={step.label + String(index)}>
                    <span className="timeline-dot" />
                    <span className="timeline-title">{step.label}</span>
                    <span className="timeline-meta">
                      {money(step.amount)} <span className="muted">({labelOf(step.kind)})</span>
                    </span>
                  </div>
                ))}
              </div>
              <Row label="Chargeable income">{money(preview.chargeableIncome)}</Row>
              <Row label="PAYE">{money(preview.paye)}</Row>
              <Row label="NSSF (employee)">{money(preview.nssf.employee)}</Row>
              <Row label="NSSF (employer)">{money(preview.nssf.employer)}</Row>
              <Row label="Local service tax">{money(preview.lst)}</Row>
              <Row label="Total deductions">{money(preview.totalDeductions)}</Row>
              <Row label="Net pay">{money(preview.net)}</Row>
              <Row label="Total employer cost">{money(preview.employerCost)}</Row>
              {preview.nssf.ceiling !== null && (
                <Row label="NSSF contribution ceiling">{money(preview.nssf.ceiling)}</Row>
              )}
              {preview.payeError && <div className="alert alert-error">{preview.payeError}</div>}
            </>
          )}
        </Panel>
      </div>

      <HrKpiGrid>
        <HrKpi
          label="Declared"
          value={money(filingsDeclaredTotal)}
          sub={filingsCurrency + ' across the filtered returns'}
          accent="#1261A0"
          tint="rgba(18, 97, 160, 0.12)"
        />
        <HrKpi
          label="Settled"
          value={money(filingsSettledTotal)}
          sub="Remitted and recorded against the return"
          accent="#168A5B"
          tint="rgba(22, 138, 91, 0.12)"
        />
        <HrKpi
          label="Outstanding"
          value={money(filingsOutstandingTotal)}
          sub="Declared and not yet settled"
          accent="#D99A00"
          tint="rgba(217, 154, 0, 0.12)"
        />
        <HrKpi
          label="Overdue"
          value={fmtNum(filingsOverdueCount)}
          sub="Returns past their due date"
          accent="#D93025"
          tint="rgba(217, 48, 37, 0.12)"
        />
      </HrKpiGrid>

      <Panel
        title="Returns and remittances"
        actions={
          <div className="action-group">
            <button className="btn btn-sm" onClick={() => setFilingsNonce((n) => n + 1)}>
              Refresh
            </button>
            {canFile && (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => {
                  setFilingActionError('');
                  setFilingCreateOpen(true);
                }}
              >
                Record return
              </button>
            )}
          </div>
        }
      >
        <HrToolbar>
          <select
            value={filingStatusFilter}
            onChange={(e) => { setFilingStatusFilter(e.target.value); setFilingsPage(1); }}
            aria-label="Filter returns by status"
          >
            <option value="">All statuses</option>
            {FILING_STATUSES.map((s) => (
              <option key={s} value={s}>{labelOf(s)}</option>
            ))}
          </select>
          <select
            value={filingsCategory}
            onChange={(e) => { setFilingsCategory(e.target.value); setFilingsPage(1); }}
            aria-label="Filter returns by obligation"
          >
            <option value="">All obligations</option>
            {filingCategories.map((c) => (
              <option key={c} value={c}>{categoryLabel(c)}</option>
            ))}
          </select>
          <label className="chip" style={{ cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={filingsOverdueOnly}
              onChange={(e) => { setFilingsOverdueOnly(e.target.checked); setFilingsPage(1); }}
            />{' '}
            Overdue only
          </label>
          <input
            type="search"
            placeholder="Search filing number, reference or notes"
            value={filingsQuery}
            onChange={(e) => { setFilingsQuery(e.target.value); setFilingsPage(1); }}
            aria-label="Search returns"
          />
        </HrToolbar>

        <ErrorBanner error={filingsError} />

        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Filing</th>
                <th>Obligation</th>
                <th>Period</th>
                <th>Due</th>
                <th className="cell-num">Declared</th>
                <th className="cell-num">Settled</th>
                <th className="cell-num">Outstanding</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {filingRows.length === 0 ? (
                <HrTableEmpty
                  colSpan={8}
                  title="No statutory return recorded"
                  hint="A payroll run calculates a liability; declaring and settling it is a separate act. Record a return to start that trail."
                />
              ) : (
                filingRows.map((f) => (
                  <tr key={str(f.id)} className="row-click" onClick={() => openFiling(f.id)}>
                    <td className="cell-mono">{str(f.filingNo) || '-'}</td>
                    <td>{categoryLabel(str(f.category))}</td>
                    <td>{day(f.periodStart)} to {day(f.periodEnd)}</td>
                    <td>
                      {f.dueDate ? day(f.dueDate) : '-'}
                      {num(f.daysToDue) !== 0 && (
                        <span className="cell-sub">
                          {num(f.daysToDue) < 0
                            ? ' ' + fmtNum(Math.abs(num(f.daysToDue))) + ' day(s) overdue'
                            : ' ' + fmtNum(num(f.daysToDue)) + ' day(s) to due'}
                        </span>
                      )}
                    </td>
                    <td className="cell-num">{money(f.declaredTotal)}</td>
                    <td className="cell-num">
                      {f.settledTotal === null || f.settledTotal === undefined ? '-' : money(f.settledTotal)}
                    </td>
                    <td className="cell-num">{money(f.outstanding)}</td>
                    <td><span className={filingTone(f.status)}>{labelOf(f.status)}</span></td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {filingsTotal > filingsPageSize && (
          <Pager
            page={filingsPage}
            pageSize={filingsPageSize}
            total={filingsTotal}
            onPage={setFilingsPage}
            onPageSize={(n) => { setFilingsPageSize(n); setFilingsPage(1); }}
          />
        )}
      </Panel>

      <Panel title="Rule versions and effective dating">
        {resolution.length === 0 ? (
          <HrEmptyState
            icon="-"
            title="No statutory resolution"
            hint="Configure PAYE, NSSF and local service tax to see which version is in force for this date."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Rule in force</th>
                  <th>Version</th>
                  <th>Scope</th>
                  <th>Effective from</th>
                  <th>Effective to</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {resolution.map((row) => {
                  const cfg = row.configId !== null ? configById.get(row.configId) : undefined;
                  if (row.missing) {
                    return (
                      <tr key={row.category}>
                        <td><strong>{categoryLabel(row.category)}</strong></td>
                        <td colSpan={6} className="muted">
                          No rule is in force for this category at {asOf}. Payroll would fail to explain this deduction.
                        </td>
                        <td>
                          {canManage && (
                            <button className="btn btn-sm" onClick={() => navigate('/people/statutory-configs')}>
                              Configure
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  }
                  return (
                    <tr key={row.category}>
                      <td><strong>{categoryLabel(row.category)}</strong></td>
                      <td>
                        <button className="link" onClick={() => cfg && setRuleOpen(cfg)}>{str(row.code)}</button>
                        <span className="cell-sub">{str(row.name)}</span>
                      </td>
                      <td>{row.version !== null ? 'v' + String(row.version) : '-'}</td>
                      <td>{row.scope === 'COMPANY' ? 'Company override' : 'Group default'}</td>
                      <td>{day(row.effectiveFrom)}</td>
                      <td>{row.effectiveTo ? day(row.effectiveTo) : 'Open'}</td>
                      <td><span className={ruleStateTone(cfg?.state)}>{labelOf(cfg?.state)}</span></td>
                      <td>
                        {cfg && (
                          <button className="btn btn-sm" onClick={() => setRuleOpen(cfg)}>Inspect</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Version history">
        {configs.length === 0 ? (
          <HrTableEmpty
            colSpan={6}
            icon="-"
            title="No statutory configs"
            hint="Rule versions appear here once statutory configuration has been captured."
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Version</th>
                  <th>Effective from</th>
                  <th>Effective to</th>
                  <th>Scope</th>
                  <th>State</th>
                </tr>
              </thead>
              <tbody>
                {configs.map((cfg) => (
                  <tr key={cfg.id} style={{ cursor: 'pointer' }} onClick={() => setRuleOpen(cfg)}>
                    <td>{categoryLabel(cfg.category)}</td>
                    <td className="cell-mono">{cfg.code}</td>
                    <td>{cfg.name}</td>
                    <td>v{String(cfg.version)}</td>
                    <td>{day(cfg.effectiveFrom)}</td>
                    <td>{cfg.effectiveTo ? day(cfg.effectiveTo) : 'Open'}</td>
                    <td>{cfg.scope === 'COMPANY' ? (cfg.companyName || 'Company override') : 'Group default'}</td>
                    <td><span className={ruleStateTone(cfg.state)}>{labelOf(cfg.state)}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {filingDetail && (
        <Drawer
          title={
            detailFiling
              ? (str(detailFiling.filingNo) || 'Statutory return') + ' - ' + categoryLabel(str(detailFiling.category))
              : 'Statutory return'
          }
          onClose={() => {
            setFilingDetail(null);
            setFilingDetailError('');
          }}
          footer={
            <div className="action-group">
              {canMove && detailFiling && str(detailFiling.status).toUpperCase() !== 'CANCELLED' && (
                <button
                  className="btn"
                  onClick={() => {
                    setFilingReconcileAmount(
                      detailReconciliation ? String(num(detailReconciliation.settled)) : ''
                    );
                    setFilingActionError('');
                    setFilingAction({ kind: 'reconcile', filing: detailFiling });
                  }}
                >
                  Reconcile
                </button>
              )}
              {detailFiling &&
                detailActions.map((action) => (
                  <button
                    key={action}
                    className={'btn' + (action === 'cancel' ? ' btn-danger' : '')}
                    onClick={() => {
                      setFilingPayReference('');
                      setFilingActionError('');
                      setFilingAction({ kind: action, filing: detailFiling });
                    }}
                  >
                    {filingActionLabel(action)}
                  </button>
                ))}
              <button className="btn" onClick={() => setFilingDetail(null)}>
                Close
              </button>
            </div>
          }
        >
          <ErrorBanner error={filingDetailError} />
          {filingDetailBusy && <PageLoader />}
          {detailFiling && (
            <>
              <Row label="Status">
                <span className={filingTone(detailFiling.status)}>{labelOf(detailFiling.status)}</span>
              </Row>
              <Row label="Obligation">{categoryLabel(str(detailFiling.category))}</Row>
              <Row label="Period">
                {day(detailFiling.periodStart)} to {day(detailFiling.periodEnd)}
              </Row>
              <Row label="Due date">{detailFiling.dueDate ? day(detailFiling.dueDate) : 'Not set'}</Row>
              <Row label="Tax period">{str(detailFiling.taxPeriod) || '-'}</Row>
              <Row label="Currency">{str(detailFiling.currency) || 'UGX'}</Row>
              <Row label="Payroll run">
                {str(detailFiling.payrollNo) ||
                  (detailFiling.payrollId ? '#' + String(detailFiling.payrollId) : 'Not linked to a run')}
              </Row>
              {detailFiling.submittedAt && <Row label="Submitted">{day(detailFiling.submittedAt)}</Row>}
              {detailFiling.paymentReference && (
                <Row label="Payment reference">{str(detailFiling.paymentReference)}</Row>
              )}
              {detailFiling.notes && <Row label="Notes">{str(detailFiling.notes)}</Row>}

              <Panel title="Liability this return declares">
                {detailLiability ? (
                  <>
                    <Row label="Gross">{money(detailLiability.grossAmount)}</Row>
                    <Row label="Employee contribution">{money(detailLiability.employeeContribution)}</Row>
                    <Row label="Employer contribution">{money(detailLiability.employerContribution)}</Row>
                    <Row label="Total due">{money(detailLiability.total)}</Row>
                    <Row label="Source run">
                      {str(detailLiability.payrollNo) || '-'} ({day(detailLiability.periodStart)} to{' '}
                      {day(detailLiability.periodEnd)})
                    </Row>
                  </>
                ) : (
                  <p className="muted">
                    This return is not linked to a payroll run, so there is no computed liability to compare
                    the declaration against.
                  </p>
                )}
              </Panel>

              <Panel title="Reconciliation">
                {detailReconciliation ? (
                  <>
                    <Row label="Declared">{money(detailReconciliation.declared)}</Row>
                    <Row label="Settled">{money(detailReconciliation.settled)}</Row>
                    <Row label="Outstanding">{money(detailReconciliation.outstanding)}</Row>
                    <Row label="Variance vs declared">
                      <span className={varianceTone(num(detailReconciliation.variance))}>
                        {money(detailReconciliation.variance)}
                      </span>
                    </Row>
                    {detailReconciliation.expected !== null && detailReconciliation.expected !== undefined && (
                      <Row label="Variance vs payroll liability">
                        <span className={varianceTone(num(detailReconciliation.liabilityVariance))}>
                          {money(detailReconciliation.liabilityVariance)}
                        </span>
                      </Row>
                    )}
                    <Row label="Reconciled">{detailReconciliation.reconciled ? 'Yes' : 'No'}</Row>
                  </>
                ) : (
                  <p className="muted">Nothing has been declared yet, so there is nothing to reconcile.</p>
                )}
              </Panel>

              <Panel title="Audit history">
                {detailHistory.length === 0 ? (
                  <p className="muted">No transitions have been recorded against this return.</p>
                ) : (
                  <div className="timeline">
                    {detailHistory.map((h, i) => (
                      <div className="timeline-item" key={String(h.id ?? i)}>
                        <span className="timeline-dot" />
                        <div className="timeline-title">{labelOf(h.action)}</div>
                        <div className="timeline-meta">
                          {day(h.createdAt)} - {str(h.userId) ? 'User ' + str(h.userId) : 'System'}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Panel>
            </>
          )}
        </Drawer>
      )}

      {ruleOpen && (
        <Drawer
          title={ruleOpen.code + ' v' + String(ruleOpen.version) + ' - ' + ruleOpen.name}
          onClose={() => setRuleOpen(null)}
          footer={
            <div className="action-group">
              {canManage && (
                <button className="btn" onClick={() => navigate('/people/statutory-configs')}>
                  Manage configurations
                </button>
              )}
              <button className="btn" onClick={() => setRuleOpen(null)}>Close</button>
            </div>
          }
        >
          <Row label="Category">{categoryLabel(ruleOpen.category)}</Row>
          <Row label="Scope">{ruleOpen.scope === 'COMPANY' ? ('Company override' + (ruleOpen.companyName ? ' - ' + ruleOpen.companyName : '')) : 'Group default'}</Row>
          <Row label="State"><span className={ruleStateTone(ruleOpen.state)}>{labelOf(ruleOpen.state)}</span></Row>
          <Row label="Effective from">{day(ruleOpen.effectiveFrom)}</Row>
          <Row label="Effective to">{ruleOpen.effectiveTo ? day(ruleOpen.effectiveTo) : 'Open ended'}</Row>
          <Row label="Record status">{labelOf(ruleOpen.status)}</Row>
          {ruleOpen.description && <Row label="Description">{ruleOpen.description}</Row>}

          <Panel title="Rates">
            <pre className="cell-mono">{jsonBlock(ruleOpen.rates)}</pre>
          </Panel>
          <Panel title="Thresholds">
            <pre className="cell-mono">{jsonBlock(ruleOpen.thresholds)}</pre>
          </Panel>
          <Panel title="Limits">
            <pre className="cell-mono">{jsonBlock(ruleOpen.limits)}</pre>
          </Panel>
          <Panel title="Formula">
            <pre className="cell-mono">{jsonBlock(ruleOpen.formula)}</pre>
          </Panel>

          <Panel title="Other versions of this rule">
            {siblings.length <= 1 ? (
              <p className="muted">This is the only captured version of {ruleOpen.code}.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Version</th>
                      <th>Effective from</th>
                      <th>Effective to</th>
                      <th>State</th>
                    </tr>
                  </thead>
                  <tbody>
                    {siblings.map((sib) => (
                      <tr
                        key={sib.id}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setRuleOpen(sib)}
                      >
                        <td>v{String(sib.version)}</td>
                        <td>{day(sib.effectiveFrom)}</td>
                        <td>{sib.effectiveTo ? day(sib.effectiveTo) : 'Open'}</td>
                        <td><span className={ruleStateTone(sib.state)}>{labelOf(sib.state)}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Panel>
          <p className="muted">
            Statutory configuration records are not independently approved; each save is an administrative
            change and the effective-dating rules decide which version a payroll period uses. Historical
            payrolls are never recalculated by a later version.
          </p>
        </Drawer>
      )}

      {filingAction && (
        <ConfirmDialog
          title={filingActionLabel(filingAction.kind)}
          body={
            filingActionHelp(filingAction.kind) +
            ' Filing: ' +
            (str(filingAction.filing.filingNo) ||
              categoryLabel(str(filingAction.filing.category)) +
                ' ' +
                day(filingAction.filing.periodStart) +
                ' to ' +
                day(filingAction.filing.periodEnd)) +
            '.'
          }
          confirmLabel={filingActionLabel(filingAction.kind)}
          danger={filingAction.kind === 'cancel'}
          reasonRequired={filingAction.kind === 'cancel'}
          reasonLabel={
            filingAction.kind === 'cancel'
              ? 'Reason (at least 10 characters, written to the audit trail)'
              : 'Note (optional)'
          }
          confirmDisabled={
            filingAction.kind === 'reconcile' &&
            (filingReconcileAmount.trim() === '' || !Number.isFinite(Number(filingReconcileAmount)))
          }
          onCancel={() => {
            setFilingAction(null);
            setFilingActionError('');
          }}
          onConfirm={(reason) =>
            runFilingAction(
              filingAction.kind,
              filingActionBody(filingAction.kind, reason, filingPayReference, filingReconcileAmount)
            )
          }
        >
          <ErrorBanner error={filingActionError} />
          {filingAction.kind === 'reconcile' && (
            <label className="field">
              <span>Amount actually settled</span>
              <input
                type="number"
                value={filingReconcileAmount}
                onChange={(e) => setFilingReconcileAmount(e.target.value)}
              />
            </label>
          )}
          {filingAction.kind === 'pay' && (
            <label className="field">
              <span>Payment reference</span>
              <input
                value={filingPayReference}
                onChange={(e) => setFilingPayReference(e.target.value)}
                placeholder="Bank or revenue authority remittance reference"
              />
            </label>
          )}
          {filingActionBusy && <p className="muted">Recording the transition...</p>}
        </ConfirmDialog>
      )}

      {filingCreateOpen && (
        <Modal
          title="Record a statutory return"
          onClose={() => {
            setFilingCreateOpen(false);
            setFilingActionError('');
          }}
          footer={
            <div className="action-group">
              <button
                className="btn"
                onClick={() => {
                  setFilingCreateOpen(false);
                  setFilingActionError('');
                }}
              >
                Cancel
              </button>
              <button className="btn btn-primary" disabled={filingActionBusy} onClick={createFiling}>
                Record return
              </button>
            </div>
          }
        >
          <ErrorBanner error={filingActionError} />
          <p className="muted">
            A return records what Hope Design declared to the authority for a period. Linking it to a payroll
            run lets the register compare the declaration against the liability that run computed.
          </p>
          <label className="field">
            <span>Obligation</span>
            <select
              value={filingDraft.category}
              onChange={(e) => setFilingDraft({ ...filingDraft, category: e.target.value })}
            >
              {filingCategories.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Period start</span>
            <input
              type="date"
              value={filingDraft.periodStart}
              onChange={(e) => setFilingDraft({ ...filingDraft, periodStart: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Period end</span>
            <input
              type="date"
              value={filingDraft.periodEnd}
              onChange={(e) => setFilingDraft({ ...filingDraft, periodEnd: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Due date</span>
            <input
              type="date"
              value={filingDraft.dueDate}
              onChange={(e) => setFilingDraft({ ...filingDraft, dueDate: e.target.value })}
            />
          </label>
          <label className="field">
            <span>Tax period</span>
            <input
              value={filingDraft.taxPeriod}
              onChange={(e) => setFilingDraft({ ...filingDraft, taxPeriod: e.target.value })}
              placeholder="e.g. 2026-08"
            />
          </label>
          <label className="field">
            <span>Notes</span>
            <textarea
              value={filingDraft.notes}
              onChange={(e) => setFilingDraft({ ...filingDraft, notes: e.target.value })}
            />
          </label>
        </Modal>
      )}
    </div>
  );
}
