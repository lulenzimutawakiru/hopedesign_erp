const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

const rows = JSON.parse(fs.readFileSync(path.join(__dirname, 'register-data.json'), 'utf8').replace(/^\uFEFF/, ''));
const r2 = (v) => Math.round(v * 100) / 100;

const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
const totals = {
  basic: r2(sum('basic')), allow: r2(sum('allow')), gross: r2(sum('gross')), lst: r2(sum('lst')),
  taxable: r2(sum('taxable')), nssf: r2(sum('nssf')), paye: r2(sum('paye')), net: r2(sum('net')), empNssf: r2(sum('empNssf')),
};
const employerCost = r2(totals.gross + totals.empNssf);

const numFmt = '#,##0.00';
const headers = ['No.', 'Employee Name', 'Position', 'Basic Salary', 'Transport Allowance', 'Gross Pay', 'LST', 'Taxable Pay', 'Employee NSSF (5%)', 'PAYE', 'Net Pay', 'Employer NSSF (10%)'];

const wb = new ExcelJS.Workbook();
wb.creator = 'Hope Design ERP';
const ws = wb.addWorksheet('Payroll Register');
ws.columns = headers.map((h) => ({ header: h, width: h.length > 18 ? 24 : 14 }));

ws.mergeCells('A1:L1');
const title = ws.getCell('A1');
title.value = 'HOPE DESIGN LIMITED \u2014 PAYROLL REGISTER \u2014 AUGUST 2026';
title.font = { name: 'Calibri', size: 16, bold: true };
title.alignment = { horizontal: 'center' };

ws.mergeCells('A2:L2');
ws.getCell('A2').value = 'Currency: Uganda Shillings (UGX)   |   Document Ref: HDL/PR/2026/08   |   PAYE: FY2026/27 brackets applied after employee NSSF (LST shown separately)';
ws.getCell('A2').font = { name: 'Calibri', size: 10, italic: true, color: { argb: 'FF555555' } };
ws.getCell('A2').alignment = { horizontal: 'center' };

const headerRow = ws.getRow(4);
headers.forEach((h, i) => {
  const c = headerRow.getCell(i + 1);
  c.value = h;
  c.font = { name: 'Calibri', size: 10, bold: true, color: { argb: 'FFFFFFFF' } };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
  c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
});
headerRow.height = 30;

rows.forEach((r, idx) => {
  const row = ws.getRow(5 + idx);
  const values = [r.no, r.name, r.position, r2(r.basic), r2(r.allow), r2(r.gross), r2(r.lst), r2(r.taxable), r2(r.nssf), r2(r.paye), r2(r.net), r2(r.empNssf)];
  values.forEach((v, i) => {
    const c = row.getCell(i + 1);
    c.value = v;
    c.font = { name: 'Calibri', size: 10 };
    if (i >= 3) { c.numFmt = numFmt; c.alignment = { horizontal: 'right' }; }
    if (i <= 2) c.alignment = i === 0 ? { horizontal: 'center' } : { horizontal: 'left' };
    if (idx % 2 === 1) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1F8' } };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
  });
});

const totalRow = ws.getRow(5 + rows.length);
totalRow.getCell(1).value = '';
totalRow.getCell(2).value = 'TOTAL';
totalRow.getCell(2).font = { name: 'Calibri', size: 10, bold: true };
const tvals = [totals.basic, totals.allow, totals.gross, totals.lst, totals.taxable, totals.nssf, totals.paye, totals.net, totals.empNssf];
tvals.forEach((v, i) => {
  const c = totalRow.getCell(4 + i);
  c.value = v;
  c.numFmt = numFmt;
  c.alignment = { horizontal: 'right' };
  c.font = { name: 'Calibri', size: 10, bold: true };
});
totalRow.getCell(3).value = '';
totalRow.eachCell({ includeEmpty: true }, (c) => {
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
  c.border = { top: { style: 'medium', color: { argb: 'FF1F4E78' } } };
});

const s0 = 5 + rows.length + 2;
const summary = [
  ['Total Employees', 14, false],
  ['Total Basic Salary', totals.basic, true],
  ['Total Transport Allowances', totals.allow, true],
  ['Total August Gross Payroll', totals.gross, true],
  ['Less: Local Service Tax (LST)', -totals.lst, true],
  ['Less: Employee NSSF Contributions', -totals.nssf, true],
  ['Less: PAYE under New Brackets', -totals.paye, true],
  ['TOTAL AUGUST NET PAY', totals.net, true],
  ['Employer NSSF Contribution (10%)', totals.empNssf, true],
  ['TOTAL EMPLOYER PAYROLL COST (Gross + Employer NSSF)', employerCost, true],
];
summary.forEach(([label, val, bold], i) => {
  ws.mergeCells(s0 + i, 1, s0 + i, 4);
  const lc = ws.getCell(s0 + i, 1);
  lc.value = label;
  lc.font = { name: 'Calibri', size: 11, bold };
  const vc = ws.getCell(s0 + i, 5);
  vc.value = val;
  vc.numFmt = numFmt;
  vc.font = { name: 'Calibri', size: 11, bold };
  vc.alignment = { horizontal: 'right' };
  if (bold) {
    lc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
    vc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD9E2F3' } };
  }
});

// --- Reference sections: statutory rates, suspension deductions, new-starter pro-rations ---
const refStart = s0 + summary.length + 1;
let rr = refStart;
const refTitle = (text) => {
  ws.mergeCells(rr, 1, rr, 12);
  const c = ws.getCell(rr, 1);
  c.value = text;
  c.font = { name: 'Calibri', size: 12, bold: true, color: { argb: 'FF1F4E78' } };
  c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEAF1F8' } };
  rr++;
};
const refLabel = (text) => {
  ws.mergeCells(rr, 1, rr, 6);
  const c = ws.getCell(rr, 1);
  c.value = text;
  c.font = { name: 'Calibri', size: 10, bold: true };
  rr++;
};
const refPair = (label, value) => {
  ws.mergeCells(rr, 1, rr, 3);
  ws.getCell(rr, 1).value = label;
  ws.getCell(rr, 1).font = { name: 'Calibri', size: 10 };
  ws.mergeCells(rr, 4, rr, 6);
  const vc = ws.getCell(rr, 4);
  vc.value = value;
  vc.font = { name: 'Calibri', size: 10 };
  vc.alignment = { horizontal: 'right' };
  if (typeof value === 'number') vc.numFmt = numFmt;
  rr++;
};
const refTbl = (headers, rows) => {
  headers.forEach((h, i) => {
    const c = ws.getCell(rr, i + 1);
    c.value = h;
    c.font = { name: 'Calibri', size: 9, bold: true, color: { argb: 'FFFFFFFF' } };
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E78' } };
    c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    c.border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
  });
  rr++;
  rows.forEach((row) => {
    row.forEach((v, i) => {
      const c = ws.getCell(rr, i + 1);
      c.value = v;
      c.font = { name: 'Calibri', size: 9 };
      c.border = { bottom: { style: 'thin', color: { argb: 'FFCCCCCC' } } };
      if (typeof v === 'number') { c.numFmt = numFmt; c.alignment = { horizontal: 'right' }; }
    });
    rr++;
  });
  rr++;
};
const refNote = (text) => {
  ws.mergeCells(rr, 1, rr, 12);
  const c = ws.getCell(rr, 1);
  c.value = text;
  c.font = { name: 'Calibri', size: 9, italic: true, color: { argb: 'FF555555' } };
  c.alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(rr).height = 30;
  rr++;
};

refTitle('STATUTORY RATES & DEDUCTIONS \u2014 REFERENCE');
refLabel('NSSF');
refPair('Employee NSSF', '5%');
refPair('Employer NSSF', '10%');
refLabel('Income Tax (PAYE) \u2014 UGX');
refPair('0 to 335,000', '0');
refPair('335,001 to 410,000', '10% of the amount exceeding UGX 335,000');
refPair('410,001 to 485,000', 'UGX 7,500 + 25% of the amount exceeding UGX 410,000');
refPair('485,001 to 10,000,000', 'UGX 26,250 + 30% of the amount exceeding UGX 485,000');
refPair('Above 10,000,000', 'UGX 2,880,750 + 10% of the amount exceeding UGX 10,000,000');
refLabel('Local Service Tax (LST)');
refPair('100,001 - 200,000', 5000);
refPair('200,001 - 300,000', 10000);
refPair('300,001 - 400,000', 20000);
refPair('400,001 - 500,000', 30000);
refPair('500,001 - 600,000', 40000);
refPair('600,001 - 700,000', 60000);
refPair('700,001 - 800,000', 70000);
refPair('800,001 - 900,000', 80000);
refPair('900,001 - 1,000,000', 90000);
refPair('Above 1,000,000', 100000);
refNote('Source: KCCA Local Service Tax (Assessment & Payment) schedule, Local Governments Act Cap 243.');

refTitle('UNPAID LEAVE / SUSPENSION DEDUCTIONS \u2014 AUGUST');
refTbl(
  ['Employee', 'Reason', 'Full Monthly Basic Salary', 'Working Days in Aug 2026 (excl. Sundays)', 'Daily Rate (Basic / Working Days)', 'Days Absent', 'Deduction (Daily Rate x Days Absent)', 'Adjusted Basic Salary'],
  [
    ['Guillaume Niyonzima', '10-day suspension (Sundays excluded)', 1081923, 26, 41612.42, 10, 416124, 665799],
    ['Tabu Derrick', '12 days absent (prorated on calendar-day basis, consistent with new starters)', 369616, 31, 11923.10, 12, 143077, 226539],
  ]
);
refNote('Daily rate = full monthly Basic Salary / 26 working days in August 2026 (31 calendar days less 5 Sundays: Aug 2, 9, 16, 23, 30). Transport allowance is not prorated. The deduction reduces Basic Salary only, so Gross Pay, NSSF, PAYEE and LST in the main table recalculate automatically from the lower base, which is why NET PAY for these two employees is lower than the June/July fixed figure this month.');

refTitle('NEW STARTERS \u2014 PRO-RATED PAY \u2014 AUGUST');
refTbl(
  ['Employee', 'Reason', 'Full Monthly Basic Salary', 'Calendar Days in Aug 2026', 'Daily Rate (Basic / Calendar Days)', 'Days Worked (from 12 Aug)', 'Prorated Basic Salary (Daily Rate x Days Worked)'],
  [
    ['Emile Niyungeko', 'Started 12 Aug 2026 (pro-rated first month)', 368846, 31, 11898.25806, 20, 237965],
    ['Gloria Nakakawa', 'Started 12 Aug 2026 (pro-rated first month)', 368846, 31, 11898.25806, 20, 237965],
    ['Racheal Tagulwa', 'Started 12 Aug 2026 (pro-rated first month)', 368846, 31, 11898.25806, 20, 237965],
    ['Lorraine Ninihazwe', 'Started 12 Aug 2026 (pro-rated first month)', 368846, 31, 11898.25806, 20, 237965],
    ['Shamirah Nantume', 'Started 12 Aug 2026 (pro-rated first month)', 368846, 31, 11898.25806, 20, 237965],
    ['Viola Akatikwasa', 'Started 12 Aug 2026 (pro-rated first month)', 368846, 31, 11898.25806, 20, 237965],
  ]
);
refNote('Daily rate = full monthly Basic Salary / 31 calendar days in August 2026 (pro-rated on a calendar-day basis, not working days, since these employees started mid-month). Days worked = 12 Aug to 31 Aug inclusive = 20 days. Transport allowance is not prorated, consistent with the unpaid-leave deductions above. The prorated figure replaces Basic Salary only, so Gross Pay, NSSF, PAYEE and LST in the main table recalculate automatically from the lower base.');

ws.pageSetup.orientation = 'landscape';
ws.pageSetup.fitToPage = true;
ws.pageSetup.fitToWidth = 1;
ws.pageSetup.fitToHeight = 0;
ws.pageSetup.printArea = 'A1:L' + (rr - 1);

const out = path.join(__dirname, 'register-aug2026-corrected.xlsx');
wb.xlsx.writeFile(out).then(() => {
  console.log('WROTE', out);
  console.log(JSON.stringify({ rows: rows.length, totals, employerCost }));
});
