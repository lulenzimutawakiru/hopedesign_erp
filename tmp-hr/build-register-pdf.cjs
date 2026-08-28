const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'register-data.json'), 'utf8').replace(/^\uFEFF/, ''));
const r2 = (v) => Math.round(v * 100) / 100;
const fmt = (v) => r2(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
const totals = {
  basic: r2(sum('basic')), allow: r2(sum('allow')), gross: r2(sum('gross')), lst: r2(sum('lst')),
  taxable: r2(sum('taxable')), nssf: r2(sum('nssf')), paye: r2(sum('paye')), net: r2(sum('net')), empNssf: r2(sum('empNssf')),
};
const employerCost = r2(totals.gross + totals.empNssf);

const bodyRows = rows.map((r) => `
  <tr>
    <td class="c">${r.no}</td>
    <td>${r.name}</td>
    <td>${r.position}</td>
    <td class="r">${fmt(r.basic)}</td>
    <td class="r">${fmt(r.allow)}</td>
    <td class="r">${fmt(r.gross)}</td>
    <td class="r">${fmt(r.lst)}</td>
    <td class="r">${fmt(r.taxable)}</td>
    <td class="r">${fmt(r.nssf)}</td>
    <td class="r">${fmt(r.paye)}</td>
    <td class="r">${fmt(r.net)}</td>
    <td class="r">${fmt(r.empNssf)}</td>
  </tr>`).join('\n');

const summaryRows = [
  ['Total Employees', '14', false],
  ['Total Basic Salary', fmt(totals.basic), true],
  ['Total Transport Allowances', fmt(totals.allow), true],
  ['Total August Gross Payroll', fmt(totals.gross), true],
  ['Less: Local Service Tax (LST)', '(' + fmt(totals.lst) + ')', true],
  ['Less: Employee NSSF Contributions', '(' + fmt(totals.nssf) + ')', true],
  ['Less: PAYE under New Brackets', '(' + fmt(totals.paye) + ')', true],
  ['TOTAL AUGUST NET PAY', fmt(totals.net), true],
  ['Employer NSSF Contribution (10%)', fmt(totals.empNssf), true],
  ['TOTAL EMPLOYER PAYROLL COST (Gross + Employer NSSF)', fmt(employerCost), true],
].map(([l, v, b]) => `<tr class="${b ? 'sum' : ''}"><td colspan="3">${l}</td><td class="r">${v}</td></tr>`).join('\n');

const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<style>
  @page { size: A4 landscape; margin: 10mm 9mm 10mm 9mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 8.2pt; color: #1a1a1a; margin: 0; }
  .hd { text-align: center; margin-bottom: 6px; }
  .hd h1 { font-size: 15pt; margin: 0 0 2px; letter-spacing: 0.4px; }
  .hd .meta { font-size: 8pt; color: #444; }
  .hd .conf { font-size: 7.5pt; font-weight: 600; color: #8a1f1f; margin-top: 2px; }
  table { border-collapse: collapse; width: 100%; }
  .reg th { background: #1F4E78; color: #fff; font-weight: 600; padding: 4px 3px; border: 0.5pt solid #bbb; }
  .reg td { padding: 3px; border: 0.5pt solid #bbb; }
  .reg tr:nth-child(even) td { background: #eaf1f8; }
  .reg tr.tot td { background: #d9e2f3 !important; font-weight: 700; border-top: 1.2pt solid #1F4E78; }
  .c { text-align: center; } .r { text-align: right; font-variant-numeric: tabular-nums; }
  .sum td { background: #d9e2f3; font-weight: 700; }
  .sum td.r { text-align: right; }
  .notes { margin-top: 6px; font-size: 7.5pt; color: #333; }
  .ref { margin-top: 10px; page-break-inside: avoid; }
  .ref h2 { font-size: 9.5pt; color: #1F4E78; margin: 0 0 3px; border-bottom: 1pt solid #1F4E78; padding-bottom: 1px; }
  .ref table { width: 100%; margin-bottom: 5px; }
  .ref th { background: #1F4E78; color: #fff; font-weight: 600; padding: 3px 4px; border: 0.5pt solid #bbb; text-align: left; }
  .ref td { padding: 2.5px 4px; border: 0.5pt solid #bbb; font-size: 7.6pt; }
  .ref .r { text-align: right; font-variant-numeric: tabular-nums; }
  .src { font-size: 7pt; color: #555; font-style: italic; margin: 2px 0 8px; }
  .pbreak { page-break-before: always; }
</style></head><body>
<div class="hd">
  <h1>HOPE DESIGN LIMITED</h1>
  <div style="font-size:11pt; font-weight:600;">PAYROLL REGISTER &mdash; AUGUST 2026</div>
  <div class="meta">Currency: Uganda Shillings (UGX) &nbsp;|&nbsp; Document Ref: HDL/PR/2026/08 &nbsp;|&nbsp; PAYE: FY2026/27 brackets applied after employee NSSF (LST shown separately) &nbsp;|&nbsp; Period: Sep 1 &ndash; Oct 30, 2026</div>
  <div class="conf">CONFIDENTIAL &mdash; FOR AUTHORIZED MANAGEMENT AND FINANCE USE ONLY</div>
</div>
<table class="reg">
  <thead><tr>
    <th>No.</th><th>Employee Name</th><th>Position</th><th>Basic Salary</th><th>Transport Allowance</th><th>Gross Pay</th>
    <th>LST</th><th>Taxable Pay</th><th>Employee NSSF (5%)</th><th>PAYE</th><th>Net Pay</th><th>Employer NSSF (10%)</th>
  </tr></thead>
  <tbody>
${bodyRows}
    <tr class="tot">
      <td></td><td>TOTAL</td><td></td>
      <td class="r">${fmt(totals.basic)}</td><td class="r">${fmt(totals.allow)}</td><td class="r">${fmt(totals.gross)}</td>
      <td class="r">${fmt(totals.lst)}</td><td class="r">${fmt(totals.taxable)}</td><td class="r">${fmt(totals.nssf)}</td>
      <td class="r">${fmt(totals.paye)}</td><td class="r">${fmt(totals.net)}</td><td class="r">${fmt(totals.empNssf)}</td>
    </tr>
  </tbody>
</table>
<table style="margin-top:8px; width:58%;">
${summaryRows}
</table>
<div class="ref pbreak">
  <h2>STATUTORY RATES &amp; DEDUCTIONS &mdash; REFERENCE</h2>
  <table>
    <thead><tr><th>NSSF Contribution</th><th style="text-align:right;">Rate</th></tr></thead>
    <tbody>
      <tr><td>Employee NSSF</td><td class="r">5%</td></tr>
      <tr><td>Employer NSSF</td><td class="r">10%</td></tr>
    </tbody>
  </table>
  <table>
    <thead><tr><th>Monthly Taxable Income (UGX)</th><th>Tax</th></tr></thead>
    <tbody>
      <tr><td>0 to 335,000</td><td>0</td></tr>
      <tr><td>335,001 to 410,000</td><td>10% of the amount exceeding UGX 335,000</td></tr>
      <tr><td>410,001 to 485,000</td><td>UGX 7,500 + 25% of the amount exceeding UGX 410,000</td></tr>
      <tr><td>485,001 to 10,000,000</td><td>UGX 26,250 + 30% of the amount exceeding UGX 485,000</td></tr>
      <tr><td>Above 10,000,000</td><td>UGX 2,880,750 + 10% of the amount exceeding UGX 10,000,000</td></tr>
    </tbody>
  </table>
  <table>
    <thead><tr><th>Monthly Gross Income (UGX)</th><th style="text-align:right;">Annual LST (UGX)</th></tr></thead>
    <tbody>
      <tr><td>100,001 - 200,000</td><td class="r">5,000</td></tr>
      <tr><td>200,001 - 300,000</td><td class="r">10,000</td></tr>
      <tr><td>300,001 - 400,000</td><td class="r">20,000</td></tr>
      <tr><td>400,001 - 500,000</td><td class="r">30,000</td></tr>
      <tr><td>500,001 - 600,000</td><td class="r">40,000</td></tr>
      <tr><td>600,001 - 700,000</td><td class="r">60,000</td></tr>
      <tr><td>700,001 - 800,000</td><td class="r">70,000</td></tr>
      <tr><td>800,001 - 900,000</td><td class="r">80,000</td></tr>
      <tr><td>900,001 - 1,000,000</td><td class="r">90,000</td></tr>
      <tr><td>Above 1,000,000</td><td class="r">100,000</td></tr>
    </tbody>
  </table>
  <div class="src">Source: KCCA Local Service Tax (Assessment &amp; Payment) schedule, Local Governments Act Cap 243.</div>
</div>
<div class="ref">
  <h2>UNPAID LEAVE / SUSPENSION DEDUCTIONS &mdash; AUGUST</h2>
  <table>
    <thead><tr>
      <th>Employee</th><th>Reason</th><th class="r">Full Monthly Basic Salary</th><th class="r">Working Days in Aug 2026 (excl. Sundays)</th>
      <th class="r">Daily Rate (Basic &divide; Working Days)</th><th class="r">Days Absent</th><th class="r">Deduction (Daily Rate &times; Days Absent)</th><th class="r">Adjusted Basic Salary</th>
    </tr></thead>
    <tbody>
      <tr><td>Guillaume Niyonzima</td><td>10-day suspension (Sundays excluded)</td><td class="r">1,081,923</td><td class="r">26</td><td class="r">41,612.42</td><td class="r">10</td><td class="r">416,124</td><td class="r">665,799</td></tr>
      <tr><td>Tabu Derrick</td><td>12 days absent (prorated on calendar-day basis, consistent with new starters)</td><td class="r">369,616</td><td class="r">31</td><td class="r">11,923.10</td><td class="r">12</td><td class="r">143,077</td><td class="r">226,539</td></tr>
    </tbody>
  </table>
  <div class="src">Daily rate = full monthly Basic Salary &divide; 26 working days in August 2026 (31 calendar days less 5 Sundays: Aug 2, 9, 16, 23, 30). Transport allowance is not prorated. The deduction reduces Basic Salary only, so Gross Pay, NSSF, PAYEE and LST in the main table recalculate automatically from the lower base, which is why NET PAY for these two employees is lower than the June/July fixed figure this month.</div>
</div>
<div class="ref">
  <h2>NEW STARTERS &mdash; PRO-RATED PAY &mdash; AUGUST</h2>
  <table>
    <thead><tr>
      <th>Employee</th><th>Reason</th><th class="r">Full Monthly Basic Salary</th><th class="r">Calendar Days in Aug 2026</th>
      <th class="r">Daily Rate (Basic &divide; Calendar Days)</th><th class="r">Days Worked (from 12 Aug)</th><th class="r">Prorated Basic Salary (Daily Rate &times; Days Worked)</th>
    </tr></thead>
    <tbody>
      <tr><td>Emile Niyungeko</td><td>Started 12 Aug 2026 (pro-rated first month)</td><td class="r">368,846</td><td class="r">31</td><td class="r">11,898.25806</td><td class="r">20</td><td class="r">237,965</td></tr>
      <tr><td>Gloria Nakakawa</td><td>Started 12 Aug 2026 (pro-rated first month)</td><td class="r">368,846</td><td class="r">31</td><td class="r">11,898.25806</td><td class="r">20</td><td class="r">237,965</td></tr>
      <tr><td>Racheal Tagulwa</td><td>Started 12 Aug 2026 (pro-rated first month)</td><td class="r">368,846</td><td class="r">31</td><td class="r">11,898.25806</td><td class="r">20</td><td class="r">237,965</td></tr>
      <tr><td>Lorraine Ninihazwe</td><td>Started 12 Aug 2026 (pro-rated first month)</td><td class="r">368,846</td><td class="r">31</td><td class="r">11,898.25806</td><td class="r">20</td><td class="r">237,965</td></tr>
      <tr><td>Shamirah Nantume</td><td>Started 12 Aug 2026 (pro-rated first month)</td><td class="r">368,846</td><td class="r">31</td><td class="r">11,898.25806</td><td class="r">20</td><td class="r">237,965</td></tr>
      <tr><td>Viola Akatikwasa</td><td>Started 12 Aug 2026 (pro-rated first month)</td><td class="r">368,846</td><td class="r">31</td><td class="r">11,898.25806</td><td class="r">20</td><td class="r">237,965</td></tr>
    </tbody>
  </table>
  <div class="src">Daily rate = full monthly Basic Salary &divide; 31 calendar days in August 2026 (pro-rated on a calendar-day basis, not working days, since these employees started mid-month). Days worked = 12 Aug to 31 Aug inclusive = 20 days. Transport allowance is not prorated, consistent with the unpaid-leave deductions above. The prorated figure replaces Basic Salary only, so Gross Pay, NSSF, PAYEE and LST in the main table recalculate automatically from the lower base.</div>
</div>
<div class="notes">
  Previous unpaid wages: none confirmed (&ldquo;&mdash;&rdquo;) &mdash; amounts to be confirmed and added before payment. All figures above are as recalculated by the Hope Design payroll engine (payroll 632, PAY-2026-00000590).
</div>
</body></html>`;

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1123, height: 794 } });
  await page.setContent(html, { waitUntil: 'networkidle' });
  const pdfPath = path.join(__dirname, 'register-aug2026-corrected.pdf');
  fs.writeFileSync(path.join(__dirname, 'register-aug2026-preview.html'), html);
  await page.pdf({ path: pdfPath, format: 'A4', landscape: true, printBackground: true });
  await page.screenshot({ path: path.join(__dirname, 'register-pdf-preview.png'), fullPage: true });
  console.log('WROTE', pdfPath);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
