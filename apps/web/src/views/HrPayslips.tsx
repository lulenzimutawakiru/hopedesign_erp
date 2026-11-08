import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, fmtMoney, fmtNum, openDocument } from '../api';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { Drawer } from '../components/os';
import { HrKpi, HrKpiGrid, HrPageHeader, HrTableEmpty, HrToolbar } from '../components/hrUi';
import { type Rec } from './hrShared';

/**
 * Odoo "Payslips" parity — the cross-run payslip register and the HR-side
 * line-by-line payslip reconstruction (the same trace the employee sees in
 * self-service, minus the self-only scoping).
 */

const money = (v: unknown) => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown) => (v == null ? '' : String(v));
const day = (v: unknown) => (v ? String(v).slice(0, 10) : '-');
const num = (v: unknown) => money(v);

function Panel({ title, sub, children }: { title: string; sub?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head"><h3>{title}</h3>{sub && <span className="muted">{sub}</span>}</div>
      <div className="card-pad">{children}</div>
    </section>
  );
}
function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="detail-row"><span>{label}</span><span>{children}</span></div>;
}
interface TraceLine { label: string; detail: string; amount: number }
interface Trace {
  earnings: { lines: TraceLine[]; total: number; balanced: boolean };
  gross: number;
  chargeable: {
    gross: number;
    lessNonTaxableEarnings: number;
    lessEmployeeNssf: number;
    chargeableIncome: number;
    taxableIncome: number;
    reconciled: boolean;
  };
  deductions: { lines: TraceLine[]; total: number; stored: number; balanced: boolean };
  net: number;
  netBalanced: boolean;
  employerCost: number;
  employerNssf: number;
  proration: Rec;
  attendanceUnpaidDays: number | null;
  benefits: Rec;
  ruleVersions: { paye: Rec; nssf: Rec; lst: Rec };
}
interface Slip {
  id: number;
  payslipNo: string | null;
  paymentDate: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  verificationCode: string | null;
  payrollNo: string | null;
}
interface SlipEmployee { name: string; employeeNo: string | null }
interface SlipDetail {
  payslip: Slip;
  employee: SlipEmployee;
  employer: Rec;
  trace: Trace;
}

function Breakdown({ lines, total, label, balanced, note }: { lines: TraceLine[]; total: number; label: string; balanced?: boolean; note?: string }) {
  return (
    <div className="stack" style={{ gap: 0 }}>
      <div className="table-wrap">
        <table className="data">
          <thead><tr><th>Line</th><th>Basis</th><th className="cell-num">Amount</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={String(i) + l.label}>
                <td>{l.label}</td><td className="cell-sub">{l.detail}</td><td className="cell-num">{fmtMoney(l.amount)}</td>
              </tr>
            ))}
            {lines.length === 0 && <HrTableEmpty colSpan={3} title="Nothing to show" hint="No lines were recorded for this section." />}
          </tbody>
          <tfoot><tr><td><strong>{label}</strong></td><td className="cell-sub">{note ?? ''}</td><td className="cell-num"><strong>{fmtMoney(total)}</strong></td></tr></tfoot>
        </table>
      </div>
      {balanced !== undefined && (
        <div className="chip-row">
          <span className={balanced ? 'chip chip-green' : 'chip chip-red'}>{balanced ? 'Adds up to the stored total' : 'Does not add up to the stored total'}</span>
        </div>
      )}
    </div>
  );
}
function ruleLabel(rule: Rec, fallback: string): string {
  const code = str(rule.code);
  const version = str(rule.version);
  if (!code && !version) return fallback;
  return (code || fallback) + (version ? ' v' + version : '');
}
function periodLabel(slip: Slip): string {
  const from = day(slip.periodStart);
  const to = day(slip.periodEnd);
  if (from === '-' && to === '-') return 'Period not recorded';
  return from + ' to ' + to;
}

function SlipDetail({ id, onClose }: { id: number; onClose: () => void }) {
  const [detail, setDetail] = useState<SlipDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  useEffect(() => {
    api<{ data: SlipDetail }>('/api/ops/hr/payslips/' + id)
      .then((r) => setDetail(r.data))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [id]);

  const doc = async (format: 'pdf' | 'print') => {
    setBusy(format);
    try {
      await openDocument('payslip', id, format, 'payslip-' + str(detail?.payslip?.payslipNo ?? id));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally { setBusy(''); }
  };

  return (
    <Drawer title={detail ? 'Payslip ' + str(detail.payslip.payslipNo) : 'Payslip'} onClose={onClose}
      footer={
        <div className="action-group">
          <button className="btn" disabled={busy !== ''} onClick={() => void doc('pdf')}>{busy === 'pdf' ? 'Saving…' : 'Download PDF'}</button>
          <button className="btn" disabled={busy !== ''} onClick={() => void doc('print')}>{busy === 'print' ? 'Printing…' : 'Print'}</button>
        </div>
      }>
      {error ? <ErrorBanner error={error} /> : null}
      {!detail ? <PageLoader label="Reconstructing the payslip" /> : (
        <div className="stack">
          <div className="detail-list">
            <Row label="Employee">{str(detail.employee.name)} ({str(detail.employee.employeeNo)})</Row>
            <Row label="Period">{periodLabel(detail.payslip)}</Row>
            <Row label="Pay date">{day(detail.payslip.paymentDate)}</Row>
            <Row label="Payroll">{str(detail.payslip.payrollNo) || '-'}</Row>
            {detail.payslip.verificationCode && <Row label="Verification"><span className="cell-mono">{str(detail.payslip.verificationCode)}</span></Row>}
          </div>

          <Panel title="Earnings" sub={'Gross ' + fmtMoney(money(detail.trace.gross))}>
            <Breakdown lines={detail.trace.earnings.lines} total={detail.trace.earnings.total} label="Gross earnings" balanced={detail.trace.earnings.balanced} note="Sum of the lines above" />
          </Panel>

          <Panel title="From gross to chargeable income" sub="What income tax was computed on">
            <div className="detail-list">
              <Row label="Gross earnings">{fmtMoney(money(detail.trace.chargeable.gross))}</Row>
              <Row label="Less: earnings not taxed">{fmtMoney(money(detail.trace.chargeable.lessNonTaxableEarnings))}</Row>
              <Row label="Less: NSSF contribution">{fmtMoney(money(detail.trace.chargeable.lessEmployeeNssf))}</Row>
              <Row label="Chargeable income"><strong>{fmtMoney(money(detail.trace.chargeable.chargeableIncome))}</strong></Row>
              <Row label="Taxable income recorded">{fmtMoney(money(detail.trace.chargeable.taxableIncome))}</Row>
            </div>
            <div className="chip-row">
              <span className={detail.trace.chargeable.reconciled ? 'chip chip-green' : 'chip chip-red'}>
                {detail.trace.chargeable.reconciled ? 'Chargeable income reconciles to the payroll record' : 'Chargeable income does not reconcile to the payroll record'}
              </span>
              <span className="chip">PAYE rule: {ruleLabel(detail.trace.ruleVersions.paye, 'Income tax')}</span>
            </div>
          </Panel>

          <Panel title="Deductions" sub={'Total ' + fmtMoney(money(detail.trace.deductions.total))}>
            <Breakdown lines={detail.trace.deductions.lines} total={detail.trace.deductions.total} label="Total deductions" balanced={detail.trace.deductions.balanced} note={'Payroll stored ' + fmtMoney(money(detail.trace.deductions.stored))} />
            <div className="chip-row">
              <span className="chip">NSSF rule: {ruleLabel(detail.trace.ruleVersions.nssf, 'Social security')}</span>
              <span className="chip">LST rule: {ruleLabel(detail.trace.ruleVersions.lst, 'Local service tax')}</span>
            </div>
          </Panel>

          <Panel title="Net pay" sub="What reaches the employee">
            <div className="detail-list">
              <Row label="Gross earnings">{fmtMoney(money(detail.trace.gross))}</Row>
              <Row label="Less: total deductions">{fmtMoney(money(detail.trace.deductions.stored))}</Row>
              <Row label="Net pay"><strong>{fmtMoney(money(detail.trace.net))}</strong></Row>
            </div>
            <div className="chip-row">
              <span className={detail.trace.netBalanced ? 'chip chip-green' : 'chip chip-red'}>{detail.trace.netBalanced ? 'Gross less deductions equals net pay' : 'Gross less deductions does not equal net pay'}</span>
            </div>
          </Panel>

          <Panel title="What the employer paid on top" sub="Not deducted from pay">
            <div className="detail-list">
              <Row label="Employer NSSF">{fmtMoney(money(detail.trace.employerNssf))}</Row>
              <Row label="Total employer cost">{fmtMoney(money(detail.trace.employerCost))}</Row>
            </div>
          </Panel>

          {(detail.trace.attendanceUnpaidDays !== null || num(detail.trace.proration.daysInPeriod) > 0) && (
            <Panel title="Proration and attendance" sub="How unpaid time affected this period">
              <div className="detail-list">
                {detail.trace.attendanceUnpaidDays !== null && <Row label="Unpaid days">{fmtNum(detail.trace.attendanceUnpaidDays)}</Row>}
                {num(detail.trace.proration.daysInPeriod) > 0 && <Row label="Days in period">{fmtNum(detail.trace.proration.daysInPeriod)}</Row>}
                {num(detail.trace.proration.paidDays) > 0 && <Row label="Paid days">{fmtNum(detail.trace.proration.paidDays)}</Row>}
                {num(detail.trace.proration.factor) > 0 && <Row label="Proration factor">{String(detail.trace.proration.factor)}</Row>}
              </div>
            </Panel>
          )}

          <p className="muted" style={{ fontSize: 12 }}>
            Rebuilt from the payroll that was released, not recalculated from today's salary, so it reproduces what was paid on release day.
          </p>
        </div>
      )}
    </Drawer>
  );
}

export default function PayslipsList() {
  const { user } = useAuth();
  const [rows, setRows] = useState<Rec[]>([]);
  const [totalCount, setTotalCount] = useState(0);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [openId, setOpenId] = useState<number | null>(null);
  const canView = can(user, 'hr.payslips.view');

  const load = useCallback(() => {
    api<{ data: { rows: Rec[]; totalCount: number } }>('/api/ops/hr/payslips?pageSize=500')
      .then((r) => { setRows(r.data.rows ?? []); setTotalCount(r.data.totalCount ?? 0); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Payslips failed'));
  }, []);
  useEffect(() => { load(); }, [load]);

  const visible = rows.filter((r) => {
    if (status && String(r.status ?? '') !== status) return false;
    if (!q.trim()) return true;
    const hay = [r.payslipNo, r.payrollNo, r.employeeNo, r.firstName, r.lastName, r.position]
      .map((x) => String(x ?? '')).join(' ').toLowerCase();
    return hay.includes(q.trim().toLowerCase());
  });

  const published = rows.filter((r) => String(r.status ?? '') === 'PUBLISHED').length;
  const netTotal = visible.reduce((s, r) => s + money(r.netTotal), 0);
  const monthPrefix = new Date().getFullYear() + '-' + String(new Date().getMonth() + 1).padStart(2, '0');
  const netThisMonth = rows
    .filter((r) => String(r.paymentDate ?? r.periodStart ?? '').startsWith(monthPrefix))
    .reduce((s, r) => s + money(r.netTotal), 0);

  return (
    <div className="page">
      <HrPageHeader kicker="Payroll" title="Payslips" subtitle="Every employee payslip across every run, searchable by employee or period."
        actions={<button className="btn" onClick={() => navigate('/people/payrolls')}>Payroll runs</button>} />
      {error && <ErrorBanner error={error} />}
      <HrKpiGrid>
        <HrKpi label="Payslips" value={fmtNum(totalCount)} sub={fmtNum(published) + ' published'} />
        <HrKpi label="Net this month" value={fmtMoney(netThisMonth)} sub="Released payslips" accent="var(--success)" tint="rgba(22, 138, 91, 0.12)" />
        <HrKpi label="Net (filtered)" value={fmtMoney(netTotal)} sub={fmtNum(visible.length) + ' slips shown'} accent="var(--hope)" tint="rgba(22, 119, 255, 0.12)" />
      </HrKpiGrid>
      <HrToolbar>
        <input className="search-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search payslip, payroll, employee..." aria-label="Search payslips" />
        <select value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Filter by status">
          <option value="">All statuses</option>
          <option value="PUBLISHED">Published</option>
          <option value="DRAFT">Draft</option>
          <option value="REVOKED">Revoked</option>
        </select>
        {rows.length > 0 && <span className="muted" style={{ marginLeft: 'auto' }}>{fmtNum(visible.length)} of {fmtNum(rows.length)} payslips</span>}
      </HrToolbar>
      <div className="table-wrap card">
        <table className="data">
          <thead><tr><th>Payslip</th><th>Employee</th><th>Period</th><th className="cell-num">Gross</th><th className="cell-num">Net</th><th>Status</th><th /></tr></thead>
          <tbody>
            {visible.map((r) => {
              const name = `${String(r.firstName ?? '')} ${String(r.lastName ?? '')}`.trim();
              return (
                <tr key={String(r.id)} className="row-click" onClick={() => setOpenId(Number(r.id))}>
                  <td className="cell-mono">{String(r.payslipNo ?? '-')}</td>
                  <td>
                    <span className="td-strong">{name || '-'}</span>
                    <span className="cell-sub">{String(r.position ?? '')}</span>
                  </td>
                  <td>
                    {day(r.periodStart)} - {day(r.periodEnd)}
                    <span className="cell-sub">Pays {day(r.paymentDate)}</span>
                  </td>
                  <td className="cell-num">{fmtMoney(r.grossTotal)}</td>
                  <td className="cell-num"><span className="td-strong">{fmtMoney(r.netTotal)}</span></td>
                  <td><Badge value={r.status} /></td>
                  <td><button className="btn btn-sm" onClick={(e) => { e.stopPropagation(); void openDocument('payslip', r.id, 'pdf', 'payslip-' + String(r.payslipNo ?? r.id)); }}>PDF</button></td>
                </tr>
              );
            })}
            {visible.length === 0 && (
              <HrTableEmpty colSpan={7} title={rows.length === 0 ? 'No payslips yet' : 'No payslips match your filters'} hint={rows.length === 0 ? 'Payslips are published from a released payroll run.' : 'Try a different search or status.'} />
            )}
          </tbody>
        </table>
      </div>
      {openId !== null && canView && <SlipDetail id={openId} onClose={() => setOpenId(null)} />}
    </div>
  );
}
