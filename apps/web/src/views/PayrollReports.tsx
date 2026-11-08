import { useCallback, useEffect, useState } from 'react';
import { api, fmtMoney, fmtNum } from '../api';
import { Badge, ErrorBanner, PageLoader } from '../components/ui';
import { HrKpi, HrKpiGrid, HrPageHeader, HrTableEmpty, HrToolbar } from '../components/hrUi';
import { type Rec } from './hrShared';

/**
 * Odoo "Reporting" parity — the Payroll Register (per-employee) and the Payslip
 * Analysis (per-run) summary, both read from the stored payroll items so they
 * reproduce the figures payroll released on the day it ran.
 */

const day = (v: unknown) => (v ? String(v).slice(0, 10) : '-');

function money(v: unknown) {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
}

const MONEY_COLS = [
  ['gross', 'Gross'],
  ['taxable', 'Taxable'],
  ['paye', 'PAYE'],
  ['nssfEmployee', 'NSSF'],
  ['nssfEmployer', 'Empl. NSSF'],
  ['lst', 'LST'],
  ['deductions', 'Deductions'],
  ['net', 'Net'],
] as const;

interface RegisterResponse {
  rows: Rec[];
  page: number;
  pageSize: number;
  totals: Rec;
}
interface AnalysisResponse {
  rows: Rec[];
  totals: Rec;
}

function TotalsRow({ totals, colSpan }: { totals: Rec; colSpan: number }) {
  return (
    <tfoot>
      <tr>
        <td colSpan={colSpan}><strong>Total</strong>{totals.lines != null && <span className="cell-sub"> {fmtNum(totals.lines)} lines</span>}</td>
        {MONEY_COLS.map(([k]) => (
          <td key={k} className="cell-num"><strong>{fmtMoney(totals[k])}</strong></td>
        ))}
      </tr>
    </tfoot>
  );
}

export default function PayrollReports() {
  const [tab, setTab] = useState<'register' | 'analysis'>('register');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [register, setRegister] = useState<RegisterResponse | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisResponse | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const qs = [fromDate && 'fromDate=' + fromDate, toDate && 'toDate=' + toDate].filter(Boolean).join('&');

  const load = useCallback(() => {
    setLoading(true);
    const suffix = qs ? '&' + qs : '';
    Promise.all([
      api<{ data: RegisterResponse }>('/api/ops/hr/payroll-register?pageSize=500' + suffix),
      api<{ data: AnalysisResponse }>('/api/ops/hr/payroll-analysis' + suffix),
    ])
      .then(([r, a]) => { setRegister(r.data); setAnalysis(a.data); setError(''); })
      .catch((e) => setError(e instanceof Error ? e.message : 'Reports failed'))
      .finally(() => setLoading(false));
  }, [qs]);
  useEffect(() => { load(); }, [load]);

  const regRows: Rec[] = register?.rows ?? [];
  const regTotals: Rec = register?.totals ?? {};
  const anaRows: Rec[] = analysis?.rows ?? [];
  const anaTotals: Rec = analysis?.totals ?? {};

  const netTotal = money(anaTotals.net);
  const payeTotal = money(anaTotals.paye);
  const headcount = Number(anaTotals.headcount ?? 0);

  return (
    <div className="page">
      <HrPageHeader kicker="Payroll" title="Payroll reports" subtitle="The register and payslip analysis as payroll recorded them on release day."
        actions={<button className="btn" onClick={() => window.print()}>Print</button>} />
      {error && <ErrorBanner error={error} />}
      <HrKpiGrid>
        <HrKpi label="Net payroll" value={fmtMoney(netTotal)} sub={fmtNum(headcount) + ' payslips in range'} />
        <HrKpi label="PAYE withheld" value={fmtMoney(payeTotal)} sub="Income tax to remit" accent="var(--success)" tint="rgba(22, 138, 91, 0.12)" />
        <HrKpi label="Runs" value={fmtNum(anaRows.length)} sub="Payroll runs in range" accent="var(--hope)" tint="rgba(22, 119, 255, 0.12)" />
      </HrKpiGrid>
      <div className="tabs" role="tablist" aria-label="Payroll report" style={{ marginBottom: 14 }}>
        <button className={tab === 'register' ? 'tab active' : 'tab'} onClick={() => setTab('register')}>Payroll register</button>
        <button className={tab === 'analysis' ? 'tab active' : 'tab'} onClick={() => setTab('analysis')}>Payslip analysis</button>
      </div>
      <HrToolbar>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="muted">From</span>
          <input type="date" value={fromDate} onChange={(e) => setFromDate(e.target.value)} aria-label="From date" />
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="muted">To</span>
          <input type="date" value={toDate} onChange={(e) => setToDate(e.target.value)} aria-label="To date" />
        </label>
        {qs && <button className="btn btn-sm" onClick={() => { setFromDate(''); setToDate(''); }}>Clear dates</button>}
      </HrToolbar>
      {loading ? <PageLoader label="Loading reports" /> : tab === 'register' ? (
        <div className="table-wrap card">
          <table className="data">
            <thead><tr><th>Employee</th><th>Payroll</th><th>Period</th><th className="cell-num">Gross</th><th className="cell-num">Taxable</th><th className="cell-num">PAYE</th><th className="cell-num">NSSF</th><th className="cell-num">Empl. NSSF</th><th className="cell-num">LST</th><th className="cell-num">Deductions</th><th className="cell-num">Net</th></tr></thead>
            <tbody>
              {regRows.map((r) => (
                <tr key={String(r.id)}>
                  <td><span className="td-strong">{String(r.name ?? '-')}</span><span className="cell-sub">{String(r.employeeNo ?? '')}</span></td>
                  <td className="cell-mono">{String(r.payrollNo ?? '-')}</td>
                  <td>{day(r.periodStart)} - {day(r.periodEnd)}</td>
                  <td className="cell-num">{fmtMoney(r.grossPay)}</td>
                  <td className="cell-num">{fmtMoney(r.taxableIncome)}</td>
                  <td className="cell-num">{fmtMoney(r.paye)}</td>
                  <td className="cell-num">{fmtMoney(r.nssf)}</td>
                  <td className="cell-num">{fmtMoney(r.employerNssf)}</td>
                  <td className="cell-num">{fmtMoney(r.lst)}</td>
                  <td className="cell-num">{fmtMoney(r.totalDeductions)}</td>
                  <td className="cell-num"><span className="td-strong">{fmtMoney(r.netPay)}</span></td>
                </tr>
              ))}
              {regRows.length === 0 && <HrTableEmpty colSpan={11} title="No payroll lines in range" hint="Adjust the date range or run payroll first." />}
            </tbody>
            {regRows.length > 0 && <TotalsRow totals={regTotals} colSpan={3} />}
          </table>
        </div>
      ) : (
        <div className="table-wrap card">
          <table className="data">
            <thead><tr><th>Payroll</th><th>Period</th><th>Type</th><th>Status</th><th className="cell-num">Headcount</th><th className="cell-num">Gross</th><th className="cell-num">Taxable</th><th className="cell-num">PAYE</th><th className="cell-num">NSSF</th><th className="cell-num">Empl. NSSF</th><th className="cell-num">LST</th><th className="cell-num">Deductions</th><th className="cell-num">Net</th></tr></thead>
            <tbody>
              {anaRows.map((r) => (
                <tr key={String(r.payrollId)}>
                  <td className="cell-mono">{String(r.payrollNo ?? '-')}</td>
                  <td>{day(r.periodStart)} - {day(r.periodEnd)}</td>
                  <td>{String(r.runType ?? '-')}</td>
                  <td><Badge value={r.status} /></td>
                  <td className="cell-num">{fmtNum(r.headcount)}</td>
                  <td className="cell-num">{fmtMoney(r.gross)}</td>
                  <td className="cell-num">{fmtMoney(r.taxable)}</td>
                  <td className="cell-num">{fmtMoney(r.paye)}</td>
                  <td className="cell-num">{fmtMoney(r.nssfEmployee)}</td>
                  <td className="cell-num">{fmtMoney(r.nssfEmployer)}</td>
                  <td className="cell-num">{fmtMoney(r.lst)}</td>
                  <td className="cell-num">{fmtMoney(r.deductions)}</td>
                  <td className="cell-num"><span className="td-strong">{fmtMoney(r.net)}</span></td>
                </tr>
              ))}
              {anaRows.length === 0 && <HrTableEmpty colSpan={13} title="No payroll runs in range" hint="Adjust the date range or run payroll first." />}
            </tbody>
            {anaRows.length > 0 && (
              <tfoot>
                <tr>
                  <td colSpan={4}><strong>Grand total</strong><span className="cell-sub"> {fmtNum(headcount)} payslips</span></td>
                  <td className="cell-num"><strong>{fmtNum(anaTotals.headcount)}</strong></td>
                  {MONEY_COLS.map(([k]) => (
                    <td key={k} className="cell-num"><strong>{fmtMoney(anaTotals[k])}</strong></td>
                  ))}
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
    </div>
  );
}
