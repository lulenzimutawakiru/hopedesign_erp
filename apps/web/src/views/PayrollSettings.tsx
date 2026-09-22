import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError, fmtDate, fmtMoney, fmtNum } from '../api';
import { ErrorBanner, Modal, PageLoader } from '../components/ui';
import { ConfirmDialog } from '../components/os';
import { toast } from '../components/toast';
import { useAuth, can } from '../auth';
import { navigate } from '../router';
import { CodeChip, HrKpi, HrKpiGrid, HrPageHeader } from '../components/hrUi';
import {
  CATEGORY_BLURB,
  CATEGORY_LABELS,
  categoryLabel,
  today,
  type ExtraSetting,
  type PreviewPayload,
  type Rec,
  type ResolutionRow,
  type SettingDefinition,
  type SettingsPayload,
  type StatutoryConfig,
  type StatutoryPayload,
  type StatutoryState,
} from './payrollConfigShared';

/**
 * Payroll configuration.
 *
 * Two halves of one job: the statutory tables the law makes payroll withhold
 * from, and the settings that shape a run. Both are read back from the same
 * engine that calculates a payslip, so this screen can never describe a band,
 * a rate or a precedence rule differently from the arithmetic that uses it.
 */

function message(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : err instanceof Error ? err.message : fallback;
}

const num = (value: string): number => {
  const n = Number(String(value).trim());
  return Number.isFinite(n) ? n : 0;
};

/** A blank optional number box means "no value", not zero. */
const numOrNull = (value: string): number | null => {
  const s = String(value).trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

const text = (value: unknown): string => (value == null || value === '' ? '-' : String(value));

const STATE_META: Record<StatutoryState, { tone: string; label: string; hint: string }> = {
  IN_EFFECT: { tone: 'badge-green', label: 'In effect', hint: 'This is the table payroll uses on the as-at date.' },
  SCHEDULED: { tone: 'badge-blue', label: 'Scheduled', hint: 'Its window opens after the as-at date.' },
  OUTRANKED: { tone: 'badge-neutral', label: 'Outranked', hint: 'Another table wins for this scope on the as-at date.' },
  SHADOWED_BY_COMPANY: { tone: 'badge-neutral', label: 'Shadowed', hint: 'A company-specific table outranks this tenant-wide one.' },
  EXPIRED: { tone: 'badge-amber', label: 'Expired', hint: 'The window closed before the as-at date.' },
  SUPERSEDED: { tone: 'badge-neutral', label: 'Superseded', hint: 'Retired. Kept so past payslips still explain themselves.' },
};

function StateBadge({ state }: { state: StatutoryState }) {
  const meta = STATE_META[state] ?? { tone: 'badge-neutral', label: state, hint: '' };
  return (
    <span className={'badge ' + meta.tone} title={meta.hint}>
      {meta.label}
    </span>
  );
}

function ScopeBadge({ scope }: { scope: 'COMPANY' | 'TENANT' | null }) {
  if (!scope) return <span className="muted">-</span>;
  return <span className={'badge ' + (scope === 'COMPANY' ? 'badge-purple' : 'badge-teal')}>{scope === 'COMPANY' ? 'Company' : 'Tenant-wide'}</span>;
}

function json(value: unknown, fallback = '-'): string {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return fallback;
  }
}

function parseJson(value: string, field: string, errors: string[]): unknown {
  const s = value.trim();
  if (s === '') return null;
  try {
    return JSON.parse(s);
  } catch {
    errors.push(`${field} is not valid JSON.`);
    return null;
  }
}

// --- PAYE bands -------------------------------------------------------------

interface PayeBand {
  min: string;
  max: string;
  rate: string;
}

function payeBandsFrom(rates: unknown): PayeBand[] {
  if (!Array.isArray(rates)) return [];
  const out: PayeBand[] = [];
  for (const entry of rates) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const o = entry as Rec;
    out.push({
      min: o.min == null ? '' : String(o.min),
      max: o.max == null ? '' : String(o.max),
      rate: o.rate == null ? '' : String(o.rate),
    });
  }
  return out;
}

function payeBandsPayload(bands: PayeBand[]) {
  return bands.map((b) => ({ min: num(b.min), max: numOrNull(b.max), rate: num(b.rate) }));
}

/** Mirrors the server's band checks so a boundary typo is caught before the round trip. */
function payeBandsErrors(bands: PayeBand[]): string[] {
  if (bands.length === 0) return ['Add at least one band.'];
  const errors: string[] = [];
  const parsed = payeBandsPayload(bands);
  parsed.forEach((b, i) => {
    if (b.rate < 0 || b.rate > 100) errors.push(`Band ${i + 1}: rate must be between 0 and 100.`);
    if (b.max !== null && b.max <= b.min) errors.push(`Band ${i + 1}: end must be above its start.`);
  });
  const sorted = [...parsed].sort((a, b) => a.min - b.min);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].min !== sorted[i - 1].max) {
      errors.push(`Bands must be contiguous: one starts at ${sorted[i].min} where the band below ends at ${sorted[i - 1].max}.`);
    }
  }
  const open = sorted.findIndex((b) => b.max === null);
  if (open !== -1 && open !== sorted.length - 1) errors.push('Only the top band may be left open-ended.');
  return errors;
}

function BandRows({
  rows,
  onChange,
  amountLabel = 'Rate %',
  amountPlaceholder = '10',
}: {
  rows: PayeBand[];
  onChange: (next: PayeBand[]) => void;
  amountLabel?: string;
  amountPlaceholder?: string;
}) {
  const update = (index: number, patch: Partial<PayeBand>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  const remove = (index: number) => onChange(rows.filter((_, i) => i !== index));
  const add = () => {
    const last = rows[rows.length - 1];
    const start = last ? (last.max.trim() === '' ? last.min : last.max) : '0';
    onChange([...rows, { min: start, max: '', rate: '' }]);
  };
  return (
    <div className="stack">
      {rows.length === 0 && <p className="hint">No bands yet. Add the first one.</p>}
      {rows.map((row, i) => (
        <div className="grid-4" key={i}>
          <div className="field">
            <label>{i === 0 ? 'From' : 'From (UGX)'}</label>
            <input type="number" value={row.min} onChange={(e) => update(i, { min: e.target.value })} />
          </div>
          <div className="field">
            <label>To</label>
            <input type="number" value={row.max} placeholder="blank = top band" onChange={(e) => update(i, { max: e.target.value })} />
          </div>
          <div className="field">
            <label>{amountLabel}</label>
            <input type="number" value={row.rate} placeholder={amountPlaceholder} onChange={(e) => update(i, { rate: e.target.value })} />
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <button className="btn btn-sm" type="button" onClick={() => remove(i)}>Remove</button>
          </div>
        </div>
      ))}
      <div className="action-group">
        <button className="btn btn-sm" type="button" onClick={add}>Add band</button>
      </div>
    </div>
  );
}

// --- the remaining category shapes ------------------------------------------

interface NssfDraft {
  employee: string;
  employer: string;
  ceiling: string;
}

interface LstBand {
  max: string;
  amount: string;
}

interface LstDraft {
  shape: 'bands' | 'flat' | 'rate';
  bands: LstBand[];
  flat: string;
  rate: string;
  minGross: string;
  months: string;
  applyToPayroll: boolean;
}

interface GenericDraft {
  rates: string;
  thresholds: string;
  limits: string;
  formula: string;
}

interface ShapeDraft {
  paye: PayeBand[];
  nssf: NssfDraft;
  lst: LstDraft;
  generic: GenericDraft;
}

interface PreparedShape {
  rates: unknown;
  thresholds: unknown;
  limits: unknown;
  formula: unknown;
}

/** The engine also accepts a one-element array where an object is expected. */
function objOf(value: unknown): Rec {
  if (value === null || value === undefined) return {};
  if (Array.isArray(value)) {
    return value.length === 1 && value[0] !== null && typeof value[0] === 'object' ? (value[0] as Rec) : {};
  }
  return typeof value === 'object' ? (value as Rec) : {};
}

const pctOf = (value: unknown): string =>
  value === null || value === undefined || value === '' ? '' : String(Number((Number(value) * 100).toFixed(6)));

function nssfFrom(config: StatutoryConfig | null): NssfDraft {
  const rates = objOf(config?.rates);
  const limits = objOf(config?.limits);
  return {
    employee: pctOf(rates.employee),
    employer: pctOf(rates.employer),
    ceiling: limits.monthly_ceiling == null ? '' : String(limits.monthly_ceiling),
  };
}

function lstFrom(config: StatutoryConfig | null): LstDraft {
  const limits = objOf(config?.limits);
  const rates = objOf(config?.rates);
  const rawBands = Array.isArray(limits.bands) ? limits.bands : [];
  const shape: LstDraft['shape'] =
    rawBands.length > 0 ? 'bands' : limits.monthly_amount != null || rates.monthly_amount != null ? 'flat' : 'rate';
  const months = Array.isArray(limits.months) ? limits.months.map((m) => String(m)).join(', ') : '';
  return {
    shape,
    bands: rawBands.map((entry) => {
      const o = objOf(entry);
      return { max: o.max == null ? '' : String(o.max), amount: o.monthly_amount == null ? '' : String(o.monthly_amount) };
    }),
    flat: limits.monthly_amount == null ? '' : String(limits.monthly_amount),
    rate: rates.rate == null ? '' : String(rates.rate),
    minGross: limits.min_gross == null ? '' : String(limits.min_gross),
    months,
    applyToPayroll: limits.apply_to_payroll !== false,
  };
}

function genericFrom(config: StatutoryConfig | null): GenericDraft {
  return {
    rates: config ? json(config.rates, '[]') : '[]',
    thresholds: config ? json(config.thresholds, '[]') : '[]',
    limits: config ? json(config.limits, '{}') : '{}',
    formula: config?.formula == null ? '' : json(config.formula, ''),
  };
}

function draftFrom(config: StatutoryConfig | null): ShapeDraft {
  return {
    paye: payeBandsFrom(config?.rates),
    nssf: nssfFrom(config),
    lst: lstFrom(config),
    generic: genericFrom(config),
  };
}

function monthsPayload(raw: string, errors: string[]): number[] | null {
  const parts = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  if (parts.length === 0) return null;
  const out: number[] = [];
  for (const part of parts) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > 12) {
      errors.push(`Months must be whole numbers from 1 to 12; got "${part}".`);
      return null;
    }
    out.push(n);
  }
  const unique = [...new Set(out)].sort((a, b) => a - b);
  if (unique.length !== out.length) {
    errors.push('Months cannot list the same month twice.');
    return null;
  }
  return unique;
}

function lstBandsErrors(bands: LstBand[]): string[] {
  const errors: string[] = [];
  if (bands.length === 0) return ['Add at least one band, or switch to a flat amount.'];
  const parsed = bands.map((b) => ({ max: numOrNull(b.max), amount: num(b.amount) }));
  parsed.forEach((b, i) => {
    if (b.amount < 0) errors.push(`Band ${i + 1}: amount cannot be negative.`);
    if (b.max !== null && b.max <= 0) errors.push(`Band ${i + 1}: ceiling must be above zero.`);
  });
  const sorted = [...parsed].sort((a, b) => (a.max ?? Number.POSITIVE_INFINITY) - (b.max ?? Number.POSITIVE_INFINITY));
  sorted.forEach((b, i) => {
    if (b.max === null && i !== sorted.length - 1) errors.push('Only the top band may be left open-ended.');
    if (i > 0) {
      const previous = sorted[i - 1].max;
      if (previous === null) errors.push(`Band ${i + 1} follows an open-ended band, so it can never apply.`);
      else if (b.max !== null && b.max <= previous) errors.push(`Band ${i + 1} must end above the band below it (${previous}).`);
    }
  });
  return errors;
}

/** Turn the on-screen draft into the JSON the API validates and stores. */
function buildShape(category: string, draft: ShapeDraft, config: StatutoryConfig | null): { shape: PreparedShape; errors: string[] } {
  const errors: string[] = [];
  const baseLimits = objOf(config?.limits);
  const baseRates = objOf(config?.rates);
  const formula = config?.formula ?? null;

  if (category === 'PAYE') {
    errors.push(...payeBandsErrors(draft.paye));
    return { shape: { rates: payeBandsPayload(draft.paye), thresholds: [], limits: baseLimits, formula }, errors };
  }

  if (category === 'NSSF') {
    const employee = num(draft.nssf.employee) / 100;
    const employer = num(draft.nssf.employer) / 100;
    const ceiling = num(draft.nssf.ceiling);
    if (employee < 0 || employee > 1) errors.push('Employee rate must be between 0% and 100%.');
    if (employer < 0 || employer > 1) errors.push('Employer rate must be between 0% and 100%.');
    if (ceiling < 0) errors.push('Monthly ceiling cannot be negative; leave it blank for no ceiling.');
    return {
      shape: {
        rates: { ...baseRates, employee, employer },
        thresholds: [],
        limits: { ...baseLimits, monthly_ceiling: ceiling },
        formula,
      },
      errors,
    };
  }

  if (category === 'LST') {
    const limits: Rec = { ...baseLimits };
    const rates: Rec = { ...baseRates };
    delete limits.bands;
    delete limits.monthly_amount;
    delete rates.monthly_amount;
    delete rates.rate;
    const months = monthsPayload(draft.lst.months, errors);
    if (months) limits.months = months;
    else delete limits.months;
    limits.min_gross = num(draft.lst.minGross);
    limits.apply_to_payroll = draft.lst.applyToPayroll;
    if (limits.min_gross as number < 0) errors.push('Minimum gross cannot be negative.');

    if (draft.lst.shape === 'bands') {
      errors.push(...lstBandsErrors(draft.lst.bands));
      limits.bands = draft.lst.bands.map((b) => ({ max: numOrNull(b.max), monthly_amount: num(b.amount) }));
    } else if (draft.lst.shape === 'flat') {
      const flat = num(draft.lst.flat);
      if (flat < 0) errors.push('Flat monthly amount cannot be negative.');
      limits.monthly_amount = flat;
    } else {
      const rate = num(draft.lst.rate);
      if (rate < 0 || rate > 100) errors.push('Rate must be between 0 and 100.');
      rates.rate = rate;
    }
    return { shape: { rates, thresholds: [], limits, formula }, errors };
  }

  const rates = parseJson(draft.generic.rates, 'Rates', errors) ?? [];
  const thresholds = parseJson(draft.generic.thresholds, 'Thresholds', errors) ?? [];
  const limits = parseJson(draft.generic.limits, 'Limits', errors) ?? {};
  const genericFormula = parseJson(draft.generic.formula, 'Formula', errors);
  if (limits !== null && (typeof limits !== 'object' || Array.isArray(limits))) {
    errors.push('Limits must be a JSON object.');
  }
  return { shape: { rates, thresholds, limits, formula: genericFormula }, errors };
}


// --- shape editors ----------------------------------------------------------
//
// One editor per shape the engine understands. PAYE has bands, NSSF has two
// rates and a ceiling, LST is one of three shapes, and every other category is
// passed through as the JSON the engine already accepts. They exist so a rate
// is typed in the unit the gazette prints it in, and so a band boundary is
// caught before it reaches a payslip.

function PayeShapeEditor({ draft, setDraft }: { draft: ShapeDraft; setDraft: (next: ShapeDraft) => void }) {
  return (
    <div className="stack">
      <p className="hint">
        Checked the way the engine checks it: bands run in order, nothing may fall between them, and only the top
        band is left open-ended.
      </p>
      <BandRows rows={draft.paye} onChange={(paye) => setDraft({ ...draft, paye })} />
    </div>
  );
}

function NssfShapeEditor({ draft, setDraft }: { draft: ShapeDraft; setDraft: (next: ShapeDraft) => void }) {
  const set = (patch: Partial<NssfDraft>) => setDraft({ ...draft, nssf: { ...draft.nssf, ...patch } });
  return (
    <div className="stack">
      <div className="grid-3">
        <div className="field">
          <label>Employee rate (%)</label>
          <input type="number" min="0" max="100" step="0.01" value={draft.nssf.employee} onChange={(e) => set({ employee: e.target.value })} />
          <p className="field-hint">Taken off gross pay. A 5% contribution is entered as 5.</p>
        </div>
        <div className="field">
          <label>Employer rate (%)</label>
          <input type="number" min="0" max="100" step="0.01" value={draft.nssf.employer} onChange={(e) => set({ employer: e.target.value })} />
          <p className="field-hint">Costs the company, not the employee.</p>
        </div>
        <div className="field">
          <label>Monthly ceiling (UGX)</label>
          <input type="number" min="0" value={draft.nssf.ceiling} placeholder="Blank = no ceiling" onChange={(e) => set({ ceiling: e.target.value })} />
          <p className="field-hint">Contributions stop once gross reaches this. Blank or 0 means no ceiling.</p>
        </div>
      </div>
    </div>
  );
}

function LstBandRows({ bands, onChange }: { bands: LstBand[]; onChange: (next: LstBand[]) => void }) {
  const update = (index: number, patch: Partial<LstBand>) => onChange(bands.map((band, i) => (i === index ? { ...band, ...patch } : band)));
  const remove = (index: number) => onChange(bands.filter((_, i) => i !== index));
  const add = () => onChange([...bands, { max: '', amount: '' }]);
  return (
    <div className="stack">
      {bands.length === 0 && <p className="hint">No bands yet. Add the lowest ceiling first.</p>}
      {bands.map((band, i) => (
        <div className="grid-3" key={i}>
          <div className="field">
            <label>Gross up to (UGX)</label>
            <input type="number" value={band.max} placeholder="blank = and above" onChange={(e) => update(i, { max: e.target.value })} />
          </div>
          <div className="field">
            <label>Monthly amount (UGX)</label>
            <input type="number" value={band.amount} placeholder="5000" onChange={(e) => update(i, { amount: e.target.value })} />
          </div>
          <div className="field">
            <label>&nbsp;</label>
            <button className="btn btn-sm" type="button" onClick={() => remove(i)}>Remove</button>
          </div>
        </div>
      ))}
      <div className="action-group">
        <button className="btn btn-sm" type="button" onClick={add}>Add band</button>
      </div>
    </div>
  );
}

const LST_SHAPES: Array<[LstDraft['shape'], string, string]> = [
  ['bands', 'Graduated bands', 'A monthly amount per band of gross pay.'],
  ['flat', 'Flat monthly amount', 'One amount for everyone the table covers.'],
  ['rate', 'Percentage of gross', 'A share of gross pay, like NSSF.'],
];

function LstShapeEditor({ draft, setDraft }: { draft: ShapeDraft; setDraft: (next: ShapeDraft) => void }) {
  const lst = draft.lst;
  const set = (patch: Partial<LstDraft>) => setDraft({ ...draft, lst: { ...lst, ...patch } });
  const chosen = LST_SHAPES.find(([key]) => key === lst.shape) ?? LST_SHAPES[0];
  return (
    <div className="stack">
      <div className="field">
        <label>How the tax is worked out</label>
        <div className="chips">
          {LST_SHAPES.map(([key, label]) => (
            <button key={key} type="button" className={lst.shape === key ? 'chip chip-on' : 'chip'} onClick={() => set({ shape: key })}>
              {label}
            </button>
          ))}
        </div>
        <p className="field-hint">{chosen[2]}</p>
      </div>
      {lst.shape === 'bands' && <LstBandRows bands={lst.bands} onChange={(bands) => set({ bands })} />}
      {lst.shape === 'flat' && (
        <div className="field">
          <label>Monthly amount (UGX)</label>
          <input type="number" min="0" value={lst.flat} placeholder="5000" onChange={(e) => set({ flat: e.target.value })} />
        </div>
      )}
      {lst.shape === 'rate' && (
        <div className="field">
          <label>Rate (%)</label>
          <input type="number" min="0" max="100" step="0.01" value={lst.rate} placeholder="1" onChange={(e) => set({ rate: e.target.value })} />
          <p className="field-hint">A percentage of gross pay, e.g. 1 for one percent.</p>
        </div>
      )}
      <div className="grid-3">
        <div className="field">
          <label>Minimum gross (UGX)</label>
          <input type="number" min="0" value={lst.minGross} placeholder="0" onChange={(e) => set({ minGross: e.target.value })} />
          <p className="field-hint">Nobody earning below this is charged.</p>
        </div>
        <div className="field">
          <label>Applies in months</label>
          <input type="text" value={lst.months} placeholder="e.g. 7, 8, 9, 10" onChange={(e) => set({ months: e.target.value })} />
          <p className="field-hint">Comma-separated months, 1 to 12. Blank means all year.</p>
        </div>
        <div className="field">
          <label>
            <input type="checkbox" checked={lst.applyToPayroll} onChange={(e) => set({ applyToPayroll: e.target.checked })} /> Deduct this on payslips
          </label>
          <p className="field-hint">Unticked keeps the table on file without taking it off anyone.</p>
        </div>
      </div>
    </div>
  );
}

function GenericShapeEditor({ draft, setDraft }: { draft: ShapeDraft; setDraft: (next: ShapeDraft) => void }) {
  const set = (patch: Partial<GenericDraft>) => setDraft({ ...draft, generic: { ...draft.generic, ...patch } });
  return (
    <div className="stack">
      <p className="hint">
        This category has no typed form, so the table is written as the JSON the engine reads. Rates may be an array
        of bands or an object of named rates.
      </p>
      <div className="grid-2">
        <div className="field">
          <label>Rates (JSON)</label>
          <textarea value={draft.generic.rates} onChange={(e) => set({ rates: e.target.value })} />
        </div>
        <div className="field">
          <label>Thresholds (JSON)</label>
          <textarea value={draft.generic.thresholds} onChange={(e) => set({ thresholds: e.target.value })} />
        </div>
      </div>
      <div className="grid-2">
        <div className="field">
          <label>Limits (JSON)</label>
          <textarea value={draft.generic.limits} onChange={(e) => set({ limits: e.target.value })} />
        </div>
        <div className="field">
          <label>Formula (JSON, optional)</label>
          <textarea value={draft.generic.formula} placeholder="blank = none" onChange={(e) => set({ formula: e.target.value })} />
        </div>
      </div>
    </div>
  );
}

function ShapeEditor({ category, draft, setDraft }: { category: string; draft: ShapeDraft; setDraft: (next: ShapeDraft) => void }) {
  if (category === 'PAYE') return <PayeShapeEditor draft={draft} setDraft={setDraft} />;
  if (category === 'NSSF') return <NssfShapeEditor draft={draft} setDraft={setDraft} />;
  if (category === 'LST') return <LstShapeEditor draft={draft} setDraft={setDraft} />;
  return <GenericShapeEditor draft={draft} setDraft={setDraft} />;
}

// --- the create / edit form -------------------------------------------------
//
// One form covers both jobs. The header fields say what the table is and when it
// applies; the shape editor below them says what the engine will actually
// withhold. Editing always sends the whole shape, so a band left on screen is a
// band that survives the save.

type ModalMode = 'create' | 'edit';

interface FormState {
  id: number | null;
  category: string;
  code: string;
  name: string;
  description: string;
  country: string;
  companyId: string;
  effectiveFrom: string;
  effectiveTo: string;
  closePrevious: boolean;
  reason: string;
  draft: ShapeDraft;
  source: StatutoryConfig | null;
}

const blankForm = (category: string, country: string, companyId: string): FormState => ({
  id: null,
  category,
  code: '',
  name: '',
  description: '',
  country,
  companyId,
  effectiveFrom: today(),
  effectiveTo: '',
  closePrevious: true,
  reason: '',
  draft: draftFrom(null),
  source: null,
});

const formFrom = (config: StatutoryConfig): FormState => ({
  id: config.id,
  category: config.category,
  code: config.code,
  name: config.name,
  description: config.description ?? '',
  country: config.country,
  companyId: config.companyId === null ? 'null' : String(config.companyId),
  effectiveFrom: config.effectiveFrom,
  effectiveTo: config.effectiveTo ?? '',
  closePrevious: false,
  reason: '',
  draft: draftFrom(config),
  source: config,
});

/** '' reads as our own company, 'null' as tenant-wide, a number as that company. */
const scopeBody = (raw: string): number | null | '' => {
  if (raw === 'null') return null;
  if (raw === '') return '';
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : '';
};

function ConfigFormModal({
  mode,
  form,
  setForm,
  categories,
  companies,
  errors,
  busy,
  onSubmit,
  onClose,
}: {
  mode: ModalMode;
  form: FormState;
  setForm: (next: FormState) => void;
  categories: string[];
  companies: Array<{ id: number; name: string }>;
  errors: string[];
  busy: boolean;
  onSubmit: () => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<FormState>) => setForm({ ...form, ...patch });
  const setDraft = (next: ShapeDraft) => setForm({ ...form, draft: next });
  const editing = mode === 'edit';
  return (
    <Modal
      wide
      title={editing ? `Edit ${form.code || 'statutory table'}` : 'New statutory table'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn-primary" type="button" onClick={onSubmit} disabled={busy}>
            {busy ? 'Saving...' : editing ? 'Save changes' : 'Create table'}
          </button>
        </>
      }
    >
      <div className="stack">
        <p className="hint">
          A table is a band of dates, not a single value: payroll picks the newest table whose window covers the pay
          date. Nothing here is deleted, so a payslip from last year can still explain itself.
        </p>

        <div className="grid-3">
          <div className="field">
            <label>Category</label>
            <select value={form.category} disabled={editing} onChange={(e) => set({ category: e.target.value })}>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {categoryLabel(c)}
                </option>
              ))}
            </select>
            {editing && <span className="field-hint">The category is fixed once the table exists.</span>}
          </div>
          <div className="field">
            <label>Code</label>
            <input value={form.code} placeholder="UG-PAYE-2026" onChange={(e) => set({ code: e.target.value.toUpperCase() })} />
            <span className="field-hint">Short, unique, printed on the payslip.</span>
          </div>
          <div className="field">
            <label>Name</label>
            <input value={form.name} placeholder="PAYE 2026" onChange={(e) => set({ name: e.target.value })} />
          </div>
        </div>

        <div className="grid-4">
          <div className="field">
            <label>Country</label>
            <input value={form.country} placeholder="UG" onChange={(e) => set({ country: e.target.value.toUpperCase() })} />
          </div>
          <div className="field">
            <label>Applies to</label>
            <select value={form.companyId} onChange={(e) => set({ companyId: e.target.value })}>
              <option value="">This company only</option>
              <option value="null">Tenant-wide (every company)</option>
              {companies.map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>Effective from</label>
            <input type="date" value={form.effectiveFrom} onChange={(e) => set({ effectiveFrom: e.target.value })} />
          </div>
          <div className="field">
            <label>Effective to (optional)</label>
            <input type="date" value={form.effectiveTo} onChange={(e) => set({ effectiveTo: e.target.value })} />
            <span className="field-hint">Blank keeps the window open.</span>
          </div>
        </div>

        <div className="field">
          <label>Description</label>
          <textarea
            value={form.description}
            placeholder="What this table changes and where the figures come from."
            onChange={(e) => set({ description: e.target.value })}
          />
        </div>

        {!editing && (
          <label className="check-line">
            <input type="checkbox" checked={form.closePrevious} onChange={(e) => set({ closePrevious: e.target.checked })} />
            <span>Close the table this one replaces - it ends the day before this table starts, so the two never overlap.</span>
          </label>
        )}

        <div className="section-title">Rates and bands</div>
        <ShapeEditor category={form.category} draft={form.draft} setDraft={setDraft} />

        <div className="field">
          <label>Reason (written to the audit trail)</label>
          <input
            value={form.reason}
            placeholder={editing ? 'Why this table is changing' : 'Why this table exists'}
            onChange={(e) => set({ reason: e.target.value })}
          />
        </div>

        {errors.length > 0 && (
          <div className="hk-warn-bar">
            <strong>Fix these before saving</strong>
            <ul>
              {errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}

// --- statutory tables -------------------------------------------------------
//
// The law changes by date and by scope, so the screen is built around one
// question: on the pay date, what does payroll actually withhold? The answer is
// read back from the same resolver a run uses, so the table below can never
// disagree with a payslip.

interface ActionState {
  kind: 'supersede' | 'restore';
  config: StatutoryConfig;
  force: boolean;
  note: string;
}

function StatutoryTab() {
  const { user } = useAuth();
  const canCreate = can(user, 'hr.statutory_configs.create');
  const canUpdate = can(user, 'hr.statutory_configs.update');
  const canActivate = can(user, 'hr.statutory_configs.activate');

  const [asOf, setAsOf] = useState(today());
  const [country, setCountry] = useState('UG');
  const [scope, setScope] = useState('');
  const [payload, setPayload] = useState<StatutoryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const query = useMemo(() => {
    const params = new URLSearchParams();
    if (asOf) params.set('asOf', asOf);
    if (country.trim()) params.set('country', country.trim().toUpperCase());
    if (scope) params.set('companyId', scope);
    return params.toString();
  }, [asOf, country, scope]);

  const load = useCallback(() => {
    setLoading(true);
    api<{ data: StatutoryPayload }>(`/api/ops/hr/statutory-configs?${query}`)
      .then((r) => {
        setPayload(r.data);
        setError('');
      })
      .catch((e) => setError(message(e, 'Statutory tables failed to load.')))
      .finally(() => setLoading(false));
  }, [query]);

  useEffect(load, [load]);

  const categories = useMemo(() => {
    const known = Object.keys(CATEGORY_LABELS);
    const extra = (payload?.categories ?? []).filter((c) => !known.includes(c));
    return [...known, ...extra];
  }, [payload]);

  const resolution = payload?.resolution ?? [];
  const missing = resolution.filter((r) => r.missing);
  const resolvedCount = resolution.length - missing.length;
  const inEffect = (payload?.configs ?? []).filter((c) => c.state === 'IN_EFFECT').length;
  const superseded = (payload?.configs ?? []).filter((c) => c.state === 'SUPERSEDED').length;

  const grouped = useMemo(() => {
    const map = new Map<string, StatutoryConfig[]>();
    for (const config of payload?.configs ?? []) {
      const list = map.get(config.category) ?? [];
      list.push(config);
      map.set(config.category, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => {
        if (a.effectiveFrom !== b.effectiveFrom) return a.effectiveFrom < b.effectiveFrom ? 1 : -1;
        return b.version - a.version;
      });
    }
    return [...map.entries()].sort((a, b) => categoryLabel(a[0]).localeCompare(categoryLabel(b[0])));
  }, [payload]);

  // Live preview: the figures move as the gross changes, debounced so a fast
  // typist does not fire a request per keystroke.
  const [gross, setGross] = useState('1000000');
  const [preview, setPreview] = useState<PreviewPayload | null>(null);
  const [previewError, setPreviewError] = useState('');
  const [previewBusy, setPreviewBusy] = useState(false);

  useEffect(() => {
    const amount = Number(gross);
    if (!Number.isFinite(amount) || amount < 0) {
      setPreview(null);
      setPreviewError('');
      return;
    }
    let live = true;
    setPreviewBusy(true);
    const timer = window.setTimeout(() => {
      const body: Rec = { asOf, country: country.trim().toUpperCase(), gross: amount };
      if (scope) body.companyId = scope === 'null' ? null : Number(scope);
      api<{ data: PreviewPayload }>('/api/ops/hr/statutory-configs/preview', {
        method: 'POST',
        body: JSON.stringify(body),
      })
        .then((r) => {
          if (!live) return;
          setPreview(r.data);
          setPreviewError('');
        })
        .catch((e) => {
          if (!live) return;
          setPreview(null);
          setPreviewError(message(e, 'The preview could not be calculated.'));
        })
        .finally(() => {
          if (live) setPreviewBusy(false);
        });
    }, 350);
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [asOf, country, scope, gross, query]);

  const [form, setForm] = useState<FormState | null>(null);
  const [mode, setMode] = useState<ModalMode>('create');
  const [formErrors, setFormErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [action, setAction] = useState<ActionState | null>(null);
  const [acting, setActing] = useState(false);

  const openCreate = () => {
    setMode('create');
    setFormErrors([]);
    setForm(blankForm(categories[0] ?? 'PAYE', country.trim().toUpperCase() || 'UG', scope));
  };

  const openEdit = (config: StatutoryConfig) => {
    setMode('edit');
    setFormErrors([]);
    setForm(formFrom(config));
  };

  const submitForm = async () => {
    if (!form) return;
    const prepared = buildShape(form.category, form.draft, form.source);
    const local = [...prepared.errors];
    if (!form.code.trim()) local.push('A code is required.');
    if (!form.name.trim()) local.push('A name is required.');
    if (!form.country.trim()) local.push('A country is required.');
    if (!form.effectiveFrom) local.push('An effective-from date is required.');
    if (form.effectiveTo && form.effectiveTo < form.effectiveFrom) {
      local.push('The end date cannot fall before the start date.');
    }
    setFormErrors(local);
    if (local.length > 0) return;

    setSaving(true);
    try {
      if (form.id === null) {
        const body: Rec = {
          category: form.category,
          code: form.code.trim(),
          name: form.name.trim(),
          description: form.description.trim() || null,
          country: form.country.trim().toUpperCase(),
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || null,
          closePrevious: form.closePrevious,
          reason: form.reason.trim() || null,
          ...prepared.shape,
        };
        if (form.companyId !== '') body.companyId = scopeBody(form.companyId);
        const r = await api<{ data: { warnings?: string[]; closedPrevious?: Array<{ code?: string }> } }>(
          '/api/ops/hr/statutory-configs',
          { method: 'POST', body: JSON.stringify(body) },
        );
        const warnings = r.data.warnings ?? [];
        const closed = (r.data.closedPrevious ?? []).map((c) => text(c.code)).join(', ');
        toast.success('Statutory table created', {
          body: [closed ? `Closed ${closed}.` : '', ...warnings].filter(Boolean).join(' ') || undefined,
        });
      } else {
        const body: Rec = {
          code: form.code.trim(),
          name: form.name.trim(),
          description: form.description.trim() || null,
          country: form.country.trim().toUpperCase(),
          companyId: scopeBody(form.companyId),
          effectiveFrom: form.effectiveFrom,
          effectiveTo: form.effectiveTo || null,
          reason: form.reason.trim() || null,
          ...prepared.shape,
        };
        await api(`/api/ops/hr/statutory-configs/${form.id}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast.success('Statutory table updated');
      }
      setForm(null);
      load();
    } catch (e) {
      setFormErrors([message(e, 'The table could not be saved.')]);
    } finally {
      setSaving(false);
    }
  };

  const runAction = async (current: ActionState, reason: string) => {
    setActing(true);
    try {
      const r = await api<{ data: Rec }>(`/api/ops/hr/statutory-configs/${current.config.id}/${current.kind}`, {
        method: 'POST',
        body: JSON.stringify({
          asOf: asOf || undefined,
          force: current.force || undefined,
          reason: reason.trim() || undefined,
        }),
      });
      const data = r.data;
      const fallback = Array.isArray(data.replacements)
        ? (data.replacements as Rec[]).map((row) => text(row.code)).join(', ')
        : '';
      toast.success(current.kind === 'supersede' ? 'Table superseded' : 'Table restored', {
        body: fallback ? `Payroll now falls back to ${fallback}.` : undefined,
      });
      setAction(null);
      load();
    } catch (e) {
      if (e instanceof ApiError && e.status === 400 && !current.force) {
        setAction({ ...current, force: true, note: e.message });
        return;
      }
      setAction(null);
      toast.fromError(current.kind === 'supersede' ? 'Supersede failed' : 'Restore failed', e);
    } finally {
      setActing(false);
    }
  };
  const usedCodes = preview
    ? (['paye', 'nssf', 'lst'] as const)
        .map((key) => preview.configs[key] as Rec | null)
        .filter((row): row is Rec => row !== null)
        .map((row) => text(row.code))
    : [];

  return (
    <div className="stack">
      <div className="card card-pad">
        <div className="grid-3">
          <div className="field">
            <label>Pay date</label>
            <input type="date" value={asOf} onChange={(e) => setAsOf(e.target.value)} />
            <span className="field-hint">Every table below is resolved against this date, not today.</span>
          </div>
          <div className="field">
            <label>Country</label>
            <input value={country} onChange={(e) => setCountry(e.target.value.toUpperCase())} />
          </div>
          <div className="field">
            <label>Scope</label>
            <select value={scope} onChange={(e) => setScope(e.target.value)}>
              <option value="">This company, with tenant-wide fallback</option>
              <option value="null">Tenant-wide only</option>
              {(payload?.companies ?? []).map((c) => (
                <option key={c.id} value={String(c.id)}>
                  {c.name}
                </option>
              ))}
            </select>
            <span className="field-hint">A company table outranks a tenant-wide one; the newest version breaks a tie.</span>
          </div>
        </div>
      </div>

      <div className="toolbar">
        <button type="button" className="btn btn-sm" onClick={() => setAsOf(today())} title="Resolve every table against today rather than a chosen pay date">
          Resolve against today
        </button>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {resolution.length} categories, {inEffect} in effect
        </span>
        {canCreate && (
          <button type="button" className="btn btn-primary" onClick={openCreate}>
            New statutory table
          </button>
        )}
      </div>

      <HrKpiGrid>
        <HrKpi label="Categories resolved" value={`${resolvedCount} / ${resolution.length}`} sub={`on ${asOf}`} />
        <HrKpi label="Tables in effect" value={inEffect} accent="#168A5B" tint="rgba(22, 138, 91, 0.12)" />
        <HrKpi
          label="Not configured"
          value={missing.length}
          sub={missing.length ? 'payroll will treat these as zero' : 'every category has a table'}
          accent={missing.length ? '#C93636' : 'var(--mod-hr)'}
          tint="rgba(201, 54, 54, 0.12)"
        />
        <HrKpi label="Superseded" value={superseded} sub="kept so old payslips still explain themselves" />
      </HrKpiGrid>

      {missing.length > 0 && (
        <div className="hk-warn-bar">
          <strong>
            {missing.length === 1 ? '1 category has' : `${missing.length} categories have`} no table covering {asOf}
          </strong>
          <p>{missing.map((row) => categoryLabel(row.category)).join(', ')} - add a table so a run cannot quietly skip a statutory deduction.</p>
        </div>
      )}
      {error && <ErrorBanner error={error} />}

      <div className="grid-2">
        <section className="card card-pad">
          <div className="section-title">What payroll uses on {asOf}</div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Table</th>
                  <th>Scope</th>
                  <th>Window</th>
                </tr>
              </thead>
              <tbody>
                {resolution.map((row: ResolutionRow) => (
                  <tr key={row.category}>
                    <td>{categoryLabel(row.category)}</td>
                    <td>
                      {row.missing ? (
                        <span className="pill pill-danger">Not set</span>
                      ) : (
                        <span className="stack-row">
                          <CodeChip>{row.code ?? '-'}</CodeChip>
                          <span className="muted">{row.name ?? ''}</span>
                        </span>
                      )}
                    </td>
                    <td>
                      <ScopeBadge scope={row.scope} />
                    </td>
                    <td className="cell-mono">
                      {row.missing ? '-' : `${row.effectiveFrom ?? '-'} to ${row.effectiveTo ?? 'open'}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="hint">
            Outranked and superseded tables are kept, not deleted, so a payslip paid last year can still be explained
            against the table that produced it.
          </p>
        </section>

        <section className="card card-pad">
          <div className="section-title">Take-home preview</div>
          <div className="field">
            <label>Gross pay</label>
            <input type="number" value={gross} onChange={(e) => setGross(e.target.value)} />
            <span className="field-hint">Chargeable income defaults to gross; NSSF is capped first, then each band applies in turn.</span>
          </div>
          {previewError && <div className="hk-warn-bar">{previewError}</div>}
          {preview?.payeError && <div className="hk-warn-bar">{preview.payeError}</div>}
          {previewBusy && <p className="hint">Calculating...</p>}
          {preview && (
            <>
              <div className="table-wrap">
                <table className="data">
                  <tbody>
                    {preview.steps.map((step, i) => (
                      <tr key={i}>
                        <td>{step.label}</td>
                        <td className="cell-num" style={step.amount < 0 ? { color: '#8B1E1E' } : undefined}>
                          {step.amount > 0 ? '+' : ''}
                          {fmtMoney(step.amount)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="kv-grid">
                <div>
                  <span className="kv-k">Taxable income</span>
                  <span className="kv-v">{fmtNum(preview.taxableIncome)}</span>
                </div>
                <div>
                  <span className="kv-k">Net pay</span>
                  <span className="kv-v">{fmtMoney(preview.net)}</span>
                </div>
                <div>
                  <span className="kv-k">Total deductions</span>
                  <span className="kv-v">{fmtMoney(preview.totalDeductions)}</span>
                </div>
                <div>
                  <span className="kv-k">Employer cost</span>
                  <span className="kv-v">{fmtMoney(preview.employerCost)}</span>
                </div>
              </div>
              <p className="hint">
                {usedCodes.length > 0 ? `Resolved from ${usedCodes.join(', ')}.` : 'No statutory table was used.'}
              </p>
            </>
          )}
        </section>
      </div>

      {loading && !payload ? <PageLoader /> : null}

      {grouped.map(([category, list]) => (
        <section className="card card-pad" key={category}>
          <div className="def-sec-head">
            <div>
              <h3>{categoryLabel(category)}</h3>
              <p>{CATEGORY_BLURB[category] ?? 'Statutory table.'}</p>
            </div>
            {canCreate && (
              <button
                className="btn btn-sm"
                type="button"
                onClick={() => {
                  setMode('create');
                  setFormErrors([]);
                  setForm(blankForm(category, country.trim().toUpperCase() || 'UG', scope));
                }}
              >
                New {categoryLabel(category)} table
              </button>
            )}
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Name</th>
                  <th>Scope</th>
                  <th>Window</th>
                  <th className="cell-num">Version</th>
                  <th>State</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {list.map((config) => (
                  <tr key={config.id}>
                    <td>
                      <CodeChip>{config.code}</CodeChip>
                    </td>
                    <td>
                      <div>{config.name}</div>
                      {config.description && <div className="muted">{text(config.description)}</div>}
                    </td>
                    <td>
                      <ScopeBadge scope={config.scope} />
                    </td>
                    <td className="cell-mono">
                      {config.effectiveFrom} to {config.effectiveTo ?? 'open'}
                    </td>
                    <td className="cell-num">v{config.version}</td>
                    <td>
                      <StateBadge state={config.state} />
                    </td>
                    <td>
                      <div className="row-actions">
                        {canUpdate && config.status === 'ACTIVE' && (
                          <button className="btn btn-sm" type="button" onClick={() => openEdit(config)}>
                            Edit
                          </button>
                        )}
                        {canActivate && config.status === 'ACTIVE' && (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => setAction({ kind: 'supersede', config, force: false, note: '' })}
                          >
                            Supersede
                          </button>
                        )}
                        {canActivate && config.status === 'SUPERSEDED' && (
                          <button
                            className="btn btn-sm"
                            type="button"
                            onClick={() => setAction({ kind: 'restore', config, force: false, note: '' })}
                          >
                            Restore
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ))}

      {!loading && grouped.length === 0 && (
        <div className="card card-pad">
          <p className="muted">No statutory tables match this view yet.</p>
        </div>
      )}

      {form && (
        <ConfigFormModal
          mode={mode}
          form={form}
          setForm={setForm}
          categories={categories}
          companies={payload?.companies ?? []}
          errors={formErrors}
          busy={saving}
          onSubmit={() => {
            void submitForm();
          }}
          onClose={() => setForm(null)}
        />
      )}

      {action && (
        <ConfirmDialog
          title={action.kind === 'supersede' ? `Supersede ${action.config.code}?` : `Restore ${action.config.code}?`}
          body={
            action.kind === 'supersede'
              ? `${action.config.code} stops applying from ${asOf}, and payroll falls back to the next table covering the same scope. Its history stays readable.`
              : `${action.config.code} becomes active again on ${asOf}, unless another table still outranks it.`
          }
          confirmLabel={action.force ? 'Repeat with force' : action.kind === 'supersede' ? 'Supersede' : 'Restore'}
          danger={action.kind === 'supersede'}
          reasonRequired={action.force}
          confirmDisabled={acting}
          onCancel={() => setAction(null)}
          onConfirm={(reason) => {
            void runAction(action, reason);
          }}
        >
          {action.note ? <div className="hk-warn-bar">{action.note}</div> : null}
        </ConfirmDialog>
      )}
    </div>
  );
}
// --- payroll settings -------------------------------------------------------
//
// A setting is one row of the run: the prefix on a payslip number, the currency
// money is held in, the default way staff are paid. Each one is edited in the
// unit the payroll run reads it in, and every row can be put back to the
// catalogue default without deleting anything.

const EXTRA_KEY = /^[A-Z][A-Z0-9_]{2,63}$/;
const CODE_VALUE = /^[A-Z0-9]{1,8}$/;
const CURRENCY_VALUE = /^[A-Z]{3}$/;

const GROUP_LABELS: Record<string, string> = {
  Documents: 'Documents and numbering',
  Money: 'Money',
  Payroll: 'Payroll run',
};

function SettingsTab() {
  const { user } = useAuth();
  const canUpdate = can(user, 'hr.payroll_settings.update');

  const [payload, setPayload] = useState<SettingsPayload | null>(null);
  const [groups, setGroups] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [groupsError, setGroupsError] = useState('');

  const [draft, setDraft] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');

  const apply = useCallback((next: SettingsPayload) => {
    const map: Record<string, string> = {};
    for (const definition of next.definitions ?? []) map[definition.key] = definition.value ?? '';
    for (const extra of next.extras ?? []) map[extra.key] = extra.value ?? '';
    setDraft(map);
    setFieldErrors({});
  }, []);

  const load = useCallback(() => {
    setLoading(true);
    api<{ data: SettingsPayload }>('/api/ops/hr/payroll-settings')
      .then((r) => {
        setPayload(r.data);
        apply(r.data);
        setError('');
      })
      .catch((e) => setError(message(e, 'Payroll settings failed to load.')))
      .finally(() => setLoading(false));
  }, [apply]);

  useEffect(load, [load]);

  useEffect(() => {
    api<{ data: Rec[] }>('/api/ops/hr/payroll-groups')
      .then((r) => setGroups(r.data ?? []))
      .catch((e) => setGroupsError(message(e, 'Payroll groups failed to load.')));
  }, []);

  const baseline = useMemo(() => {
    const map: Record<string, string> = {};
    for (const definition of payload?.definitions ?? []) map[definition.key] = definition.value ?? '';
    for (const extra of payload?.extras ?? []) map[extra.key] = extra.value ?? '';
    return map;
  }, [payload]);

  const dirtyKeys = useMemo(
    () => Object.keys(draft).filter((key) => (draft[key] ?? '') !== (baseline[key] ?? '')),
    [draft, baseline],
  );
  const entries = dirtyKeys.filter((key) => (draft[key] ?? '').trim() !== '').map((key) => ({ key, value: (draft[key] ?? '').trim() }));
  const remove = dirtyKeys.filter((key) => (draft[key] ?? '').trim() === '');
  const dirty = dirtyKeys.length > 0;

  const setValue = (key: string, value: string) => setDraft((current) => ({ ...current, [key]: value }));

  const definedGroups = useMemo(() => {
    const ordered = payload?.groups ?? [];
    const names = [...ordered, ...(payload?.definitions ?? []).map((d) => d.group)];
    return [...new Set(names)].filter(Boolean);
  }, [payload]);

  const save = async () => {
    const errors: Record<string, string> = {};
    for (const definition of payload?.definitions ?? []) {
      const value = (draft[definition.key] ?? '').trim();
      if (!value) continue;
      if (definition.type === 'code' && !CODE_VALUE.test(value)) {
        errors[definition.key] = 'Use up to 8 letters or digits with no spaces, e.g. PS.';
      } else if (definition.type === 'currency' && !CURRENCY_VALUE.test(value)) {
        errors[definition.key] = 'Use a three-letter currency code, e.g. UGX.';
      } else if (definition.type === 'enum' && definition.options && !definition.options.includes(value)) {
        errors[definition.key] = `Choose one of ${definition.options.join(', ')}.`;
      }
    }
    for (const extra of payload?.extras ?? []) {
      const value = (draft[extra.key] ?? '').trim();
      if (!value) continue;
      if (!EXTRA_KEY.test(extra.key)) {
        errors[extra.key] = 'Keys are uppercase letters, digits and underscores.';
      }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      toast.error('Some values need fixing', { body: 'See the fields marked below.' });
      return;
    }
    if (entries.length === 0 && remove.length === 0) {
      toast.info('Nothing to save', { body: 'Change a value, or add a key, first.' });
      return;
    }

    setSaving(true);
    try {
      const r = await api<{ data: SettingsPayload & { saved?: number; cleared?: number } }>('/api/ops/hr/payroll-settings', {
        method: 'PUT',
        body: JSON.stringify({ entries, remove, reason: reason.trim() || undefined }),
      });
      setPayload(r.data);
      apply(r.data);
      setReason('');
      toast.success('Payroll settings saved', {
        body: `${r.data.saved ?? entries.length} value(s) set, ${r.data.cleared ?? remove.length} back to the catalogue default.`,
      });
    } catch (e) {
      toast.fromError('Settings could not be saved', e);
    } finally {
      setSaving(false);
    }
  };

  const addKey = () => {
    const key = newKey.trim().toUpperCase();
    if (!EXTRA_KEY.test(key)) {
      toast.error('That key is not usable', { body: 'Uppercase letters, digits and underscores, 3 to 64 characters, starting with a letter.' });
      return;
    }
    if (key in draft) {
      toast.error('That key already exists', { body: 'Edit it in place instead.' });
      return;
    }
    if (!newValue.trim()) {
      toast.error('Give the key a value', { body: 'An empty value would have nothing to store.' });
      return;
    }
    setDraft((current) => ({ ...current, [key]: newValue }));
    setNewKey('');
    setNewValue('');
  };
  return (
    <div className="stack">
      {error && <ErrorBanner error={error} />}
      {loading && !payload ? <PageLoader /> : null}

      {payload && (
        <>
          <div className="card card-pad">
            <div className="section-title">How a payroll run reads these</div>
            <p className="hint">
              Each row below is a value the run reads at the moment it needs it, so a change lands on the next run
              rather than on a payslip already issued. Blank means "use the catalogue default", which is always shown
              next to the field.
            </p>
          </div>

          {definedGroups.map((group) => {
            const list = (payload.definitions ?? []).filter((d) => d.group === group);
            if (list.length === 0) return null;
            return (
              <section className="card card-pad" key={group}>
                <div className="section-title">{GROUP_LABELS[group] ?? group}</div>
                <div className="grid-2">
                  {list.map((definition: SettingDefinition) => {
                    const value = draft[definition.key] ?? '';
                    const changed = value.trim() !== (baseline[definition.key] ?? '');
                    const enumOptions = definition.type === 'enum' ? definition.options ?? [] : [];
                    return (
                      <div className={'field' + (fieldErrors[definition.key] ? ' field-invalid' : '')} key={definition.key}>
                        <label htmlFor={'set-' + definition.key}>
                          {definition.label}
                          {changed ? <span className="pill pill-warn">Unsaved</span> : null}
                          {!changed && definition.isDefault === false ? <span className="pill pill-ok">Overridden</span> : null}
                        </label>
                        {enumOptions.length > 0 ? (
                          <select
                            id={'set-' + definition.key}
                            value={value}
                            disabled={!canUpdate}
                            onChange={(e) => setValue(definition.key, e.target.value)}
                          >
                            <option value="">Catalogue default ({definition.defaultValue || 'none'})</option>
                            {enumOptions.map((option) => (
                              <option key={option} value={option}>
                                {option.replace(/_/g, ' ')}
                              </option>
                            ))}
                          </select>
                        ) : (
                          <input
                            id={'set-' + definition.key}
                            value={value}
                            disabled={!canUpdate}
                            placeholder={definition.defaultValue || 'not set'}
                            onChange={(e) =>
                              setValue(definition.key, definition.type === 'text' ? e.target.value : e.target.value.toUpperCase())
                            }
                          />
                        )}
                        <span className="field-hint">{definition.description}</span>
                        <span className="field-hint">
                          Read by {definition.consumedBy}. Catalogue default {definition.defaultValue || 'none'}.
                        </span>
                        {fieldErrors[definition.key] ? <span className="field-error">{fieldErrors[definition.key]}</span> : null}
                        <div className="action-group">
                          <span className="kv-k">{definition.key}</span>
                          <button
                            className="btn btn-sm"
                            type="button"
                            disabled={!canUpdate || value === ''}
                            onClick={() => setValue(definition.key, '')}
                          >
                            Revert to default
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            );
          })}

          <section className="card card-pad">
            <div className="section-title">Save changes</div>
            <div className="grid-2">
              <div className="field">
                <label>Reason (written to the audit trail)</label>
                <input
                  value={reason}
                  placeholder="e.g. New payslip numbering for the coming financial year"
                  onChange={(e) => setReason(e.target.value)}
                />
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <div className="action-group">
                  <button
                    className="btn btn-primary"
                    type="button"
                    disabled={!canUpdate || saving || !dirty}
                    onClick={() => {
                      void save();
                    }}
                  >
                    {saving ? 'Saving...' : 'Save settings'}
                  </button>
                  <button className="btn" type="button" disabled={saving || !dirty} onClick={() => apply(payload)}>
                    Discard changes
                  </button>
                </div>
              </div>
            </div>
            <p className="hint">
              {dirty
                ? `${entries.length} value(s) to set, ${remove.length} to put back to the catalogue default.`
                : 'Nothing has changed yet.'}
            </p>
          </section>

          <section className="card card-pad">
            <div className="section-title">Other keys</div>
            <p className="hint">Anything the catalogue above does not name. Keys are stored exactly as typed.</p>
            {(payload.extras ?? []).length === 0 ? (
              <p className="muted">No extra keys are stored for this company.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Key</th>
                      <th>Value</th>
                      <th>Updated</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {(payload.extras ?? []).map((extra: ExtraSetting) => (
                      <tr key={extra.key}>
                        <td>
                          <CodeChip>{extra.key}</CodeChip>
                        </td>
                        <td>
                          <input
                            value={draft[extra.key] ?? ''}
                            disabled={!canUpdate}
                            onChange={(e) => setValue(extra.key, e.target.value)}
                          />
                          {fieldErrors[extra.key] ? <span className="field-error">{fieldErrors[extra.key]}</span> : null}
                        </td>
                        <td className="muted">{fmtDate(extra.updatedAt)}</td>
                        <td>
                          <div className="row-actions">
                            <button
                              className="btn btn-sm"
                              type="button"
                              disabled={!canUpdate}
                              onClick={() => setValue(extra.key, '')}
                            >
                              Remove
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <div className="grid-3">
              <div className="field">
                <label>New key</label>
                <input value={newKey} placeholder="PAYSLIP_FOOTER" onChange={(e) => setNewKey(e.target.value.toUpperCase())} />
              </div>
              <div className="field">
                <label>Value</label>
                <input value={newValue} onChange={(e) => setNewValue(e.target.value)} />
              </div>
              <div className="field">
                <label>&nbsp;</label>
                <button className="btn btn-sm" type="button" disabled={!canUpdate} onClick={addKey}>
                  Add key
                </button>
              </div>
            </div>
          </section>

          <section className="card card-pad">
            <div className="section-title">Payroll groups</div>
            <p className="hint">
              Read-only. Groups decide who is paid together and how often; they come from the payroll calendar, not
              from these settings.
            </p>
            {groupsError && <div className="hk-warn-bar">{groupsError}</div>}
            {groups.length === 0 && !groupsError ? (
              <p className="muted">No payroll groups are configured for this company yet.</p>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Name</th>
                      <th>Frequency</th>
                      <th>Salary currency</th>
                      <th>Payment method</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((group) => (
                      <tr key={String(group.id)}>
                        <td>
                          <CodeChip>{String(group.code ?? '-')}</CodeChip>
                        </td>
                        <td>{String(group.name ?? '-')}</td>
                        <td>{String(group.frequency ?? '-').replace(/_/g, ' ')}</td>
                        <td className="cell-mono">{String(group.salaryCurrency ?? '-')}</td>
                        <td>{String(group.defaultPaymentMethod ?? '-').replace(/_/g, ' ')}</td>
                        <td>
                          <span className={'badge ' + (String(group.status) === 'ACTIVE' ? 'badge-green' : 'badge-neutral')}>
                            {String(group.status ?? '-')}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}
    </div>
  );
}

const PAYROLL_TABS: Array<[string, string, string]> = [
  ['statutory', 'Statutory tables', '/people/statutory-configs'],
  ['settings', 'Run settings', '/people/payroll-settings'],
];

export default function PayrollSettings({ path }: { path: string }) {
  const tabFromPath = path === '/people/statutory-configs' ? 'statutory' : 'settings';
  const [tab, setTab] = useState<string>(tabFromPath);

  useEffect(() => {
    setTab(tabFromPath);
  }, [tabFromPath]);

  return (
    <div className="page">
      <HrPageHeader
        kicker="Payroll"
        title="Configuration"
        subtitle="The statutory tables payroll withholds from, and the settings that shape a run - both read back from the engine that calculates a payslip."
        actions={<button className="btn" onClick={() => navigate('/people/payrolls')}>Payroll runs</button>}
      />
      <div className="tabs" style={{ marginBottom: 12 }}>
        {PAYROLL_TABS.map(([k, label, href]) => (
          <button
            key={k}
            className={tab === k ? 'tab active' : 'tab'}
            onClick={() => { setTab(k); navigate(href); }}
          >{label}</button>
        ))}
      </div>
      {tab === 'statutory' ? <StatutoryTab /> : <SettingsTab />}
    </div>
  );
}
