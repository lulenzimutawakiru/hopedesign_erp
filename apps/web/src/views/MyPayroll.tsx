/**
 * My Payroll - employee self-service (spec 33, 34).
 *
 * The employee home for pay: the current payslip, the payslip history, the year
 * to date totals, loans and advances still in recovery, and a line by line
 * explanation of any slip the employee opens.
 *
 * The server resolves the employee from the signed-in user, so this screen never
 * names an employee id and cannot be pointed at a colleague's records. Every
 * figure is read back from the payroll that was actually released - the payslip
 * header and the payroll item's stored calculation - and never recalculated from
 * today's salary, so a slip always reproduces exactly what was paid on the day it
 * was paid, even after a raise or a change in the statutory rates.
 */
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { ApiError, api, fmtDate, fmtMoney, fmtNum, openDocument } from '../api';
import { Badge, ErrorBanner, PageLoader, Pager } from '../components/ui';
import { Drawer } from '../components/os';
import { HrEmptyState, HrKpi, HrKpiGrid, HrPageHeader, HrTableEmpty, HrToolbar } from '../components/hrUi';

type Rec = Record<string, unknown>;

interface MyEmployee {
  id: number;
  employeeNo: string | null;
  name: string;
  position: string | null;
  departmentName: string | null;
  branchName: string | null;
  companyName: string | null;
  nssfNo: string | null;
  tin: string | null;
  bankName: string | null;
  bankAccountMasked: string | null;
}

interface MySlip extends Rec {
  id: number;
  payslipNo: string | null;
  currency: string | null;
  grossTotal: number;
  taxableTotal: number;
  deductionTotal: number;
  netTotal: number;
  employerContributions: number;
  paymentDate: string | null;
  status: string;
  publishedAt: string | null;
  viewedAt: string | null;
  viewedCount: number;
  downloadCount: number;
  verificationCode: string | null;
  payrollId: number | null;
  payrollNo: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  runType: string | null;
  offCycleType: string | null;
}

interface YearToDate {
  year: number;
  periods: number;
  gross: number;
  taxable: number;
  deductions: number;
  net: number;
  paye: number;
  nssfEmployee: number;
  nssfEmployer: number;
  lst: number;
  loans: number;
  advances: number;
  otherDeductions: number;
}

interface TrendPoint {
  id: number;
  payslipNo: string | null;
  netTotal: number;
  grossTotal: number;
  currency: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  payrollNo: string | null;
}

interface Home {
  employee: MyEmployee;
  current: MySlip | null;
  payslips: MySlip[];
  page: number;
  pageSize: number;
  totalCount: number;
  yearToDate: YearToDate;
  trend: TrendPoint[];
  loans: Rec[];
  advances: Rec[];
}

interface TraceLine {
  label: string;
  detail: string;
  amount: number;
}

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

interface SlipDetail {
  payslip: MySlip;
  employer: Rec;
  employee: MyEmployee;
  yearToDate: YearToDate;
  trace: Trace;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const str = (v: unknown): string => (v == null ? '' : String(v));
const day = (v: unknown): string => (v == null || v === '' ? '-' : String(v).slice(0, 10));
const money = (v: unknown): string => fmtMoney(v);

function Panel({ title, sub, actions, children }: { title: string; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="card">
      <div className="card-head">
        <h3>{title}</h3>
        {sub && <span className="muted">{sub}</span>}
        {actions && <div className="action-group">{actions}</div>}
      </div>
      <div className="card-pad">{children}</div>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <span>{children}</span>
    </div>
  );
}

function Breakdown({ lines, total, label, balanced, note }: { lines: TraceLine[]; total: number; label: string; balanced?: boolean; note?: string }) {
  return (
    <div className="stack" style={{ gap: 0 }}>
      <table className="data">
        <thead>
          <tr>
            <th>Line</th>
            <th>Basis</th>
            <th className="cell-num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={String(i) + l.label}>
              <td>{l.label}</td>
              <td className="cell-sub">{l.detail}</td>
              <td className="cell-num">{money(l.amount)}</td>
            </tr>
          ))}
          {lines.length === 0 && <HrTableEmpty colSpan={3} title="Nothing to show" hint="No lines were recorded for this section." />}
        </tbody>
        <tfoot>
          <tr>
            <td><strong>{label}</strong></td>
            <td className="cell-sub">{note ?? ''}</td>
            <td className="cell-num"><strong>{money(total)}</strong></td>
          </tr>
        </tfoot>
      </table>
      {balanced !== undefined && (
        <div className="chip-row">
          <span className={balanced ? 'chip chip-green' : 'chip chip-red'}>
            {balanced ? 'Adds up to the stored total' : 'Does not add up to the stored total'}
          </span>
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

interface PeriodLike {
  periodStart: unknown;
  periodEnd: unknown;
}

function periodLabel(slip: PeriodLike): string {
  const from = day(slip.periodStart);
  const to = day(slip.periodEnd);
  if (from === '-' && to === '-') return 'Period not recorded';
  return from + ' to ' + to;
}

export default function MyPayroll() {
  const [home, setHome] = useState<Home | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(12);

  const [openId, setOpenId] = useState<number | null>(null);
  const [detail, setDetail] = useState<SlipDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<unknown>(null);
  const [busy, setBusy] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ data: Home }>('/api/my/payroll?page=' + page + '&pageSize=' + pageSize);
      setHome(res.data);
    } catch (e) {
      setError(e);
      setHome(null);
    } finally {
      setLoading(false);
    }
  }, [page, pageSize]);

  useEffect(() => {
    void load();
  }, [load]);

  const openSlip = async (slip: MySlip) => {
    setOpenId(slip.id);
    setDetail(null);
    setDetailError(null);
    setDetailLoading(true);
    try {
      const res = await api<{ data: SlipDetail }>('/api/my/payroll/payslips/' + slip.id);
      setDetail(res.data);
      // Delivery evidence: the first open of a slip is audited server side.
      const viewed = await api<{ data: { viewedAt: string | null; viewedCount: number } }>(
        '/api/my/payroll/payslips/' + slip.id + '/viewed',
        { method: 'POST', body: '{}' }
      ).catch(() => null);
      if (viewed && home) {
        setHome({
          ...home,
          payslips: home.payslips.map((s) => (s.id === slip.id ? { ...s, viewedAt: viewed.data.viewedAt, viewedCount: viewed.data.viewedCount } : s)),
          current: home.current && home.current.id === slip.id ? { ...home.current, viewedAt: viewed.data.viewedAt, viewedCount: viewed.data.viewedCount } : home.current,
        });
      }
    } catch (e) {
      setDetailError(e);
    } finally {
      setDetailLoading(false);
    }
  };

  const closeSlip = () => {
    setOpenId(null);
    setDetail(null);
    setDetailError(null);
  };

  const fetchSlip = async (slip: MySlip, format: 'pdf' | 'print') => {
    setBusy(slip.id + ':' + format);
    setNotice('');
    try {
      await openDocument('my-payslip', slip.id, format, 'payslip-' + (slip.payslipNo ?? slip.id) + (format === 'pdf' ? '.pdf' : '.html'));
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'The payslip could not be produced.');
    } finally {
      setBusy('');
    }
  };

  if (loading && !home) return <PageLoader label="Loading your payroll" />;

  const forbidden = error instanceof ApiError && (error.status === 403 || error.code === 'FORBIDDEN');

  if (forbidden) {
    return (
      <>
        <HrPageHeader kicker="Self service" title="My Payroll" subtitle="Your pay, your payslips, and how each figure was worked out." />
        <HrEmptyState
          icon="ID"
          title="Your sign-in is not linked to an employee record"
          hint={error instanceof Error ? error.message : 'Ask HR to link your user account to your employee file, then reload this page.'}
        />
      </>
    );
  }

  const emp = home?.employee ?? null;
  const ytd = home?.yearToDate ?? null;
  const slips = home?.payslips ?? [];
  const current = home?.current ?? null;
  const ccy = str(current?.currency) || 'UGX';
  const maxTrend = Math.max(1, ...(home?.trend ?? []).map((t) => num(t.netTotal)));

  return (
    <>
      <HrPageHeader
        kicker="Self service"
        title="My Payroll"
        subtitle={
          emp
            ? [emp.name, emp.employeeNo, emp.position, emp.departmentName].filter((v) => str(v) !== '').join(' - ')
            : 'Your pay, your payslips, and how each figure was worked out.'
        }
        actions={
          <button className="btn" onClick={() => void load()} disabled={loading}>
            {loading ? 'Refreshing...' : 'Refresh'}
          </button>
        }
      />

      {error && !forbidden && <ErrorBanner error={error} />}
      {notice && <div className="alert alert-error">{notice}</div>}

      {emp && (
        <HrToolbar>
          <span className="chip"><span className="chip-k">Company</span> {str(emp.companyName) || '-'}</span>
          <span className="chip"><span className="chip-k">Branch</span> {str(emp.branchName) || '-'}</span>
          <span className="chip"><span className="chip-k">TIN</span> {str(emp.tin) || 'Not recorded'}</span>
          <span className="chip"><span className="chip-k">NSSF</span> {str(emp.nssfNo) || 'Not recorded'}</span>
          <span className="chip"><span className="chip-k">Paid to</span> {str(emp.bankName) || '-'} {str(emp.bankAccountMasked)}</span>
        </HrToolbar>
      )}

      {slips.length === 0 ? (
        <HrEmptyState
          icon="PS"
          title="No payslips have been published to you yet"
          hint="A payslip appears here once payroll for a period has been approved, released, and published to employees. If you expected a payslip, ask HR whether your payroll run has been published."
        />
      ) : (
        <>
          {current && (
            <section className="card card-accent" style={{ marginBottom: 16 }}>
              <div className="card-head">
                <h3>Latest payslip</h3>
                <span className="muted">{periodLabel(current)}</span>
                <div className="action-group">
                  <Badge value={current.status} />
                </div>
              </div>
              <div className="card-pad">
                <div className="grid-2">
                  <div className="detail-list">
                    <Row label="Payslip number"><span className="cell-mono">{str(current.payslipNo) || '-'}</span></Row>
                    <Row label="Payroll run"><span className="cell-mono">{str(current.payrollNo) || '-'}</span></Row>
                    <Row label="Run type">{str(current.runType) || 'Normal'}{str(current.offCycleType) ? ' - ' + str(current.offCycleType) : ''}</Row>
                    <Row label="Pay date">{day(current.paymentDate)}</Row>
                    <Row label="Published">{current.publishedAt ? fmtDate(current.publishedAt) : 'Not yet published'}</Row>
                    <Row label="Payable">{day(current.periodEnd) === '-' ? '-' : 'On ' + day(current.paymentDate)}</Row>
                  </div>
                  <div className="detail-list">
                    <Row label="Gross pay">{money(current.grossTotal)} {ccy}</Row>
                    <Row label="Taxable pay">{money(current.taxableTotal)} {ccy}</Row>
                    <Row label="Deductions">{money(current.deductionTotal)} {ccy}</Row>
                    <Row label="Employer contributions">{money(current.employerContributions)} {ccy}</Row>
                    <Row label="Net pay"><strong>{money(current.netTotal)} {ccy}</strong></Row>
                  </div>
                </div>
                <div className="chip-row">
                  <button className="btn btn-primary" onClick={() => void openSlip(current)}>How this was calculated</button>
                  <button className="btn" disabled={busy !== ''} onClick={() => void fetchSlip(current, 'pdf')}>
                    {busy === current.id + ':pdf' ? 'Preparing...' : 'Download PDF'}
                  </button>
                  <button className="btn" disabled={busy !== ''} onClick={() => void fetchSlip(current, 'print')}>Print</button>
                </div>
              </div>
            </section>
          )}

          {ytd && (
            <HrKpiGrid>
              <HrKpi label={'Gross ' + ytd.year + ' to date'} value={money(ytd.gross)} sub={fmtNum(ytd.periods) + ' payslip(s) this year'} />
              <HrKpi label="PAYE paid to date" value={money(ytd.paye)} sub="Income tax withheld and remitted" accent="var(--clay)" tint="rgba(201, 54, 54, 0.12)" />
              <HrKpi label="NSSF (your share)" value={money(ytd.nssfEmployee)} sub="5% employee contribution" />
              <HrKpi label="NSSF (employer share)" value={money(ytd.nssfEmployer)} sub="Paid by the employer, not deducted from you" />
              <HrKpi label="Local service tax" value={money(ytd.lst)} sub="Remitted to the local government" />
              <HrKpi label={'Net received ' + ytd.year} value={money(ytd.net)} sub={'Total deductions ' + money(ytd.deductions)} />
            </HrKpiGrid>
          )}

          {(home?.trend ?? []).length > 0 && (
            <Panel title="Net pay trend" sub="Oldest to newest, published payslips only">
              <div className="trend-chart">
                {(home?.trend ?? []).map((t) => (
                  <div className="trend-col" key={t.id} title={periodLabel(t) + ' - net ' + money(t.netTotal) + ' ' + str(t.currency)}>
                    <div className="trend-bars">
                      <div className="trend-bar actual" style={{ height: Math.max(2, (num(t.netTotal) / maxTrend) * 100) + '%' }} />
                    </div>
                    <div className="trend-day">{day(t.periodEnd).slice(0, 7)}</div>
                  </div>
                ))}
              </div>
              <div className="trend-legend">
                <span><i className="trend-swatch actual" /> Net pay</span>
              </div>
            </Panel>
          )}

          <section className="card">
            <div className="card-head">
              <h3>Payslip history</h3>
              <span className="muted">{fmtNum(home?.totalCount ?? 0)} published payslip(s)</span>
            </div>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Period</th>
                    <th>Payslip</th>
                    <th>Run</th>
                    <th>Pay date</th>
                    <th className="cell-num">Gross</th>
                    <th className="cell-num">Deductions</th>
                    <th className="cell-num">Net</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {slips.map((s) => (
                    <tr key={s.id}>
                      <td>{periodLabel(s)}</td>
                      <td className="cell-mono">{str(s.payslipNo) || '-'}</td>
                      <td className="cell-sub">{str(s.runType) || 'Normal'}{str(s.offCycleType) ? ' - ' + str(s.offCycleType) : ''}</td>
                      <td>{day(s.paymentDate)}</td>
                      <td className="cell-num">{money(s.grossTotal)}</td>
                      <td className="cell-num">{money(s.deductionTotal)}</td>
                      <td className="cell-num"><strong>{money(s.netTotal)}</strong></td>
                      <td><Badge value={s.status} /></td>
                      <td>
                        <div className="action-group">
                          <button className="btn btn-sm" onClick={() => void openSlip(s)}>Breakdown</button>
                          <button className="btn btn-sm" disabled={busy !== ''} onClick={() => void fetchSlip(s, 'pdf')}>
                            {busy === s.id + ':pdf' ? '...' : 'PDF'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {slips.length === 0 && (
                    <HrTableEmpty colSpan={9} title="No payslips on this page" hint="Try another page." />
                  )}
                </tbody>
              </table>
            </div>
            <div className="card-pad" style={{ paddingTop: 0 }}>
              <Pager page={page} pageSize={pageSize} total={home?.totalCount ?? 0} onPage={setPage} onPageSize={(n) => { setPageSize(n); setPage(1); }} />
            </div>
          </section>

          {((home?.loans ?? []).length > 0 || (home?.advances ?? []).length > 0) && (
            <div className="grid-2">
              <Panel title="Staff loans in recovery" sub="Recovered from your pay each period">
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>Loan</th><th className="cell-num">Monthly</th><th className="cell-num">Balance</th><th>Ends</th></tr>
                    </thead>
                    <tbody>
                      {(home?.loans ?? []).map((l) => (
                        <tr key={str(l.id)}>
                          <td className="cell-mono">{str(l.loanNo) || str(l.id)}</td>
                          <td className="cell-num">{money(l.monthlyDeduction)}</td>
                          <td className="cell-num">{money(l.balance)}</td>
                          <td>{day(l.endDate)}</td>
                        </tr>
                      ))}
                      {(home?.loans ?? []).length === 0 && <HrTableEmpty colSpan={4} title="No active loans" />}
                    </tbody>
                  </table>
                </div>
              </Panel>
              <Panel title="Salary advances in recovery" sub="Recovered from your pay each period">
                <div className="table-wrap">
                  <table className="data">
                    <thead>
                      <tr><th>Advance</th><th className="cell-num">Monthly</th><th className="cell-num">Outstanding</th><th>Started</th></tr>
                    </thead>
                    <tbody>
                      {(home?.advances ?? []).map((a) => (
                        <tr key={str(a.id)}>
                          <td className="cell-mono">{str(a.advanceNo) || str(a.id)}</td>
                          <td className="cell-num">{money(a.monthlyDeduction)}</td>
                          <td className="cell-num">{money(a.outstandingBalance)}</td>
                          <td>{day(a.startDate)}</td>
                        </tr>
                      ))}
                      {(home?.advances ?? []).length === 0 && <HrTableEmpty colSpan={4} title="No active advances" />}
                    </tbody>
                  </table>
                </div>
              </Panel>
            </div>
          )}
        </>
      )}

      {openId !== null && (
        <Drawer title={detail ? 'Payslip ' + (str(detail.payslip.payslipNo) || '') : 'Payslip'} onClose={closeSlip}>
          {detailLoading && <PageLoader label="Reconstructing the payslip" />}
          {detailError ? <ErrorBanner error={detailError} /> : null}
          {detail && (
            <div className="stack">
              <div className="detail-list">
                <Row label="Employee">{str(detail.employee.name)} ({str(detail.employee.employeeNo)})</Row>
                <Row label="Period">{periodLabel(detail.payslip)}</Row>
                <Row label="Pay date">{day(detail.payslip.paymentDate)}</Row>
                <Row label="Payroll">{str(detail.payslip.payrollNo) || '-'}</Row>
                {detail.payslip.verificationCode && (
                  <Row label="Verification"><span className="cell-mono">{str(detail.payslip.verificationCode)}</span></Row>
                )}
              </div>

              <Panel title="Earnings" sub={'Gross ' + money(detail.trace.gross)}>
                <Breakdown
                  lines={detail.trace.earnings.lines}
                  total={detail.trace.earnings.total}
                  label="Gross earnings"
                  balanced={detail.trace.earnings.balanced}
                  note="Sum of the lines above"
                />
              </Panel>

              <Panel title="From gross to chargeable income" sub="What income tax was computed on">
                <div className="detail-list">
                  <Row label="Gross earnings">{money(detail.trace.chargeable.gross)}</Row>
                  <Row label="Less: earnings not taxed">{money(detail.trace.chargeable.lessNonTaxableEarnings)}</Row>
                  <Row label="Less: your NSSF contribution">{money(detail.trace.chargeable.lessEmployeeNssf)}</Row>
                  <Row label="Chargeable income"><strong>{money(detail.trace.chargeable.chargeableIncome)}</strong></Row>
                  <Row label="Taxable income recorded">{money(detail.trace.chargeable.taxableIncome)}</Row>
                </div>
                <div className="chip-row">
                  <span className={detail.trace.chargeable.reconciled ? 'chip chip-green' : 'chip chip-red'}>
                    {detail.trace.chargeable.reconciled ? 'Chargeable income reconciles to the payroll record' : 'Chargeable income does not reconcile to the payroll record'}
                  </span>
                  <span className="chip">PAYE rule: {ruleLabel(detail.trace.ruleVersions.paye, 'Income tax')}</span>
                </div>
              </Panel>

              <Panel title="Deductions" sub={'Total ' + money(detail.trace.deductions.total)}>
                <Breakdown
                  lines={detail.trace.deductions.lines}
                  total={detail.trace.deductions.total}
                  label="Total deductions"
                  balanced={detail.trace.deductions.balanced}
                  note={'Payroll stored ' + money(detail.trace.deductions.stored)}
                />
                <div className="chip-row">
                  <span className="chip">NSSF rule: {ruleLabel(detail.trace.ruleVersions.nssf, 'Social security')}</span>
                  <span className="chip">LST rule: {ruleLabel(detail.trace.ruleVersions.lst, 'Local service tax')}</span>
                </div>
              </Panel>

              <Panel title="Net pay" sub="What reaches your account">
                <div className="detail-list">
                  <Row label="Gross earnings">{money(detail.trace.gross)}</Row>
                  <Row label="Less: total deductions">{money(detail.trace.deductions.stored)}</Row>
                  <Row label="Net pay"><strong>{money(detail.trace.net)}</strong></Row>
                </div>
                <div className="chip-row">
                  <span className={detail.trace.netBalanced ? 'chip chip-green' : 'chip chip-red'}>
                    {detail.trace.netBalanced ? 'Gross less deductions equals net pay' : 'Gross less deductions does not equal net pay'}
                  </span>
                </div>
              </Panel>

              <Panel title="What the employer paid on top" sub="Not deducted from your pay">
                <div className="detail-list">
                  <Row label="Employer NSSF">{money(detail.trace.employerNssf)}</Row>
                  <Row label="Total employer cost">{money(detail.trace.employerCost)}</Row>
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

              <div className="chip-row">
                <button className="btn" disabled={busy !== ''} onClick={() => void fetchSlip(detail.payslip, 'pdf')}>Download PDF</button>
                <button className="btn" disabled={busy !== ''} onClick={() => void fetchSlip(detail.payslip, 'print')}>Print</button>
              </div>

              <p className="muted" style={{ fontSize: 12 }}>
                This explanation is rebuilt from the payroll that was released, not recalculated from today's salary, so it will
                not change if your pay or the statutory rates change later. If a figure looks wrong, raise it with HR and quote
                the payslip number and payroll run above.
              </p>
            </div>
          )}
        </Drawer>
      )}
    </>
  );
}
