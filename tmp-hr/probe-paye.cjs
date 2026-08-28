// Probe: replicate engine formula (hr.ts calculatePayroll) with DB configs.
const PAYE = [
  { min: 0, max: 335000, rate: 0 },
  { min: 335000, max: 410000, rate: 20 },
  { min: 410000, max: 485000, rate: 25 },
  { min: 485000, max: 10000000, rate: 30 },
  { min: 10000000, max: null, rate: 40 },
];
const LST_BANDS = [
  { max: 100000, amt: 0 }, { max: 200000, amt: 1250 }, { max: 300000, amt: 2500 },
  { max: 400000, amt: 5000 }, { max: 500000, amt: 7500 }, { max: 600000, amt: 10000 },
  { max: 700000, amt: 15000 }, { max: 800000, amt: 17500 }, { max: 900000, amt: 20000 },
  { max: 1000000, amt: 22500 }, { max: null, amt: 25000 },
];
const r2 = (n) => Math.round(n * 100) / 100;
const paye = (t) => {
  let tax = 0;
  for (const b of PAYE) {
    if (t <= b.min) break;
    const upper = b.max ?? Infinity;
    if (upper <= b.min) continue;
    tax += (Math.min(t, upper) - b.min) * (b.rate / 100);
  }
  return r2(tax);
};
const nssfEmp = (g) => r2(g * 0.05);
const lst = (g, periodStart, periodEnd) => {
  // season gate: months 7,8,9,10; overlap check on period
  const months = [7, 8, 9, 10];
  const start = new Date(periodStart + 'T00:00:00');
  const end = new Date(periodEnd + 'T00:00:00');
  const first = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), 1));
  let overlap = false;
  for (let d = new Date(first); d <= last && !overlap; d.setUTCMonth(d.getUTCMonth() + 1)) {
    if (months.includes(d.getUTCMonth() + 1)) overlap = true;
  }
  if (!overlap) return 0;
  for (const b of LST_BANDS) {
    if (g <= (b.max ?? Infinity)) return b.amt;
  }
  return 0;
};
const calc = (label, gross, chargeable, periodStart, periodEnd, extra = {}) => {
  const n = nssfEmp(gross);
  const t = r2(Math.max(0, chargeable - n));
  const p = paye(t);
  const l = lst(gross, periodStart, periodEnd);
  const other = extra.other ?? 0;
  const loans = extra.loans ?? 0;
  const net = r2(gross - p - n - l - other - loans);
  console.log(label, JSON.stringify({ gross, chargeable, nssf: n, taxable: t, paye: p, lst: l, other, loans, net }));
};
calc('IT1 modern Sep2027', 3800000, 3900000, '2027-09-15', '2027-09-15', { other: 120000 });
calc('IT2 prorated Sep2027', 2100000, 2100000, '2027-09-01', '2027-09-30');
calc('hr Peter Mar2027', 3000000, 3000000, '2027-03-15', '2027-03-15', { loans: 100000 });
calc('hr Asha Mar2027', 200000, 200000, '2027-03-15', '2027-03-15');
calc('hr bonus Apr2027', 3500000, 3500000, '2027-04-20', '2027-04-20', { loans: 100000, other: 50000 });
calc('hr arrears May2027', 3350000, 3350000, '2027-05-20', '2027-05-20');
calc('hcm Aug2026', 638709.68, 638709.68, '2026-08-21', '2026-08-21');
calc('reports Jun2027', 3000000, 3000000, '2027-06-15', '2027-06-15');
