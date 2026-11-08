import { useEffect, useMemo, useState } from 'react';
import { EntityMeta, MetaColumn } from '../api';

const TEXTAREA_COLS = new Set(['description', 'notes', 'specification', 'terms', 'address', 'billing_address', 'shipping_address', 'attributes', 'summary', 'comment']);

function isNumeric(t: string): boolean {
  return ['int2', 'int4', 'int8', 'numeric', 'float4', 'float8', 'money', 'double precision'].includes(t);
}

function isBoolean(t: string): boolean {
  return ['boolean', 'bool'].includes(t);
}

function isDate(t: string): boolean {
  return ['date', 'timestamp', 'timestamp without time zone', 'timestamp with time zone', 'timestamptz'].includes(t);
}

function inputTypeFor(col: MetaColumn): string {
  if (isBoolean(col.dataType)) return 'boolean';
  if (isDate(col.dataType)) return col.name.endsWith('_at') ? 'datetime-local' : 'date';
  if (isNumeric(col.dataType)) return 'number';
  return 'text';
}

/** Strip "_id" suffix for display label: customer_id -> Customer. */
function prettyLabel(name: string): string {
  return name
    .replace(/_id$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function defaultValueFor(col: MetaColumn): unknown {
  if (isBoolean(col.dataType)) return false;
  return '';
}

export interface SelectOption {
  value: string | number;
  label: string;
}

/**
 * An ordered group of fields. `fields` are the camelCase column keys, in the
 * order they should render. Any writable column not listed in any section falls
 * into a trailing, collapsed "More options" section automatically.
 */
export interface FormSection {
  title: string;
  fields: string[];
  defaultOpen?: boolean;
  description?: string;
}

export interface JsonFormProps {
  meta: EntityMeta;
  initial?: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
  /** Optional ordered field groups. When omitted, fields render flat (legacy). */
  sections?: FormSection[];
  /** Optional per-field dropdown options keyed by camelCase column. */
  selects?: Record<string, SelectOption[]>;
}

interface Group {
  key: string;
  title: string;
  description?: string;
  defaultOpen: boolean;
  cols: MetaColumn[];
}

function initValues(fields: MetaColumn[], initial?: Record<string, unknown>): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const c of fields) {
    const key = c.camel;
    v[key] = initial?.[key] !== undefined && initial?.[key] !== null ? initial[key] : defaultValueFor(c);
  }
  return v;
}

function groupFields(fields: MetaColumn[], sections?: FormSection[]): Group[] {
  const byCamel = new Map(fields.map((f) => [f.camel, f]));
  const used = new Set<string>();
  const groups: Group[] = [];
  for (const s of sections ?? []) {
    const cols: MetaColumn[] = [];
    for (const camel of s.fields) {
      const f = byCamel.get(camel);
      if (f && !used.has(camel)) {
        used.add(camel);
        cols.push(f);
      }
    }
    if (cols.length) {
      groups.push({ key: s.title, title: s.title, description: s.description, defaultOpen: s.defaultOpen !== false, cols });
    }
  }
  const rest = fields.filter((f) => !used.has(f.camel));
  if (rest.length) groups.push({ key: '__more', title: 'More options', defaultOpen: false, cols: rest });
  return groups;
}

function initOpen(sections?: FormSection[]): Record<string, boolean> {
  const map: Record<string, boolean> = {};
  for (const s of sections ?? []) map[s.title] = s.defaultOpen !== false;
  map['__more'] = false;
  return map;
}

/** Ensure the current value is selectable even if it is not in the option list. */
function withCurrent(opts: SelectOption[], cur: unknown): SelectOption[] {
  if (cur === undefined || cur === null || cur === '') return opts;
  if (opts.some((o) => String(o.value) === String(cur))) return opts;
  return [{ value: String(cur), label: `#${String(cur)}` }, ...opts];
}

export function JsonForm({ meta, initial, onSubmit, onCancel, submitLabel = 'Save', sections, selects }: JsonFormProps) {
  const fields = useMemo(() => meta.columns.filter((c) => c.writable && !['id'].includes(c.name)), [meta]);
  const [values, setValues] = useState<Record<string, unknown>>(() => initValues(fields, initial));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>(() => initOpen(sections));

  useEffect(() => {
    setValues(initValues(fields, initial));
  }, [initial, fields]);

  const set = (camel: string, value: unknown) => setValues((prev) => ({ ...prev, [camel]: value }));
  const toggle = (key: string) => setOpen((prev) => ({ ...prev, [key]: !prev[key] }));

  const groups = useMemo(() => groupFields(fields, sections), [fields, sections]);

  const submit = async () => {
    setError(null);
    // Reject malformed structured fields up front instead of silently posting the
    // raw text as a string: a jsonb column must never receive a non-object value.
    for (const c of fields) {
      if (c.dataType !== 'jsonb' && c.dataType !== 'json') continue;
      const raw = values[c.camel];
      if (raw === '' || raw === null || raw === undefined) continue;
      try {
        JSON.parse(String(raw));
      } catch {
        setError(`${prettyLabel(c.name)} is not valid JSON. Fix it, or clear the field.`);
        return;
      }
    }
    setBusy(true);
    try {
      const payload: Record<string, unknown> = {};
      for (const c of fields) {
        const raw = values[c.camel];
        if (raw === '' || raw === null || raw === undefined) {
          if (isBoolean(c.dataType)) payload[c.camel] = false;
          continue;
        }
        if (isNumeric(c.dataType)) {
          payload[c.camel] = Number(raw);
        } else if (isBoolean(c.dataType)) {
          payload[c.camel] = Boolean(raw);
        } else if (c.dataType === 'jsonb' || c.dataType === 'json') {
          payload[c.camel] = JSON.parse(String(raw));
        } else {
          payload[c.camel] = String(raw);
        }
      }
      await onSubmit(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const renderField = (c: MetaColumn) => {
    const t = inputTypeFor(c);
    const label = prettyLabel(c.name);
    const isTextarea = c.dataType === 'text' && TEXTAREA_COLS.has(c.name);
    const id = `f-${c.name}`;
    const opts = selects?.[c.camel];
    return (
      <div className={`field ${!c.nullable && !c.hasDefault ? 'field-required' : ''}`} key={c.name} style={isTextarea ? { gridColumn: '1 / -1' } : undefined}>
        <label htmlFor={id}>{label}</label>
        {opts ? (
          <select id={id} value={String(values[c.camel] ?? '')} onChange={(e) => set(c.camel, e.target.value)}>
            <option value="">— Select —</option>
            {withCurrent(opts, values[c.camel]).map((o) => (
              <option key={String(o.value)} value={String(o.value)}>{o.label}</option>
            ))}
          </select>
        ) : t === 'boolean' ? (
          <input
            id={id}
            type="checkbox"
            checked={Boolean(values[c.camel])}
            onChange={(e) => set(c.camel, e.target.checked)}
          />
        ) : isTextarea ? (
          <textarea
            id={id}
            value={String(values[c.camel] ?? '')}
            onChange={(e) => set(c.camel, e.target.value)}
          />
        ) : (
          <input
            id={id}
            type={t === 'number' ? 'number' : t === 'date' ? 'date' : t === 'datetime-local' ? 'datetime-local' : /email/.test(c.name) ? 'email' : /phone|tel|mobile/.test(c.name) ? 'tel' : 'text'}
            inputMode={t === 'number' || /qty|quantity|amount|price/.test(c.name) ? 'decimal' : /phone|tel|mobile/.test(c.name) ? 'tel' : /email/.test(c.name) ? 'email' : undefined}
            autoComplete={/email/.test(c.name) ? 'email' : /phone|tel/.test(c.name) ? 'tel' : undefined}
            value={String(values[c.camel] ?? '')}
            onChange={(e) => set(c.camel, e.target.value)}
          />
        )}
        {!c.nullable && !c.hasDefault && <span className="hint">Required</span>}
      </div>
    );
  };

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      {sections ? (
        groups.map((g) => (
          <section className="asset-form-sec" key={g.key}>
            <button type="button" className="form-sec-head" onClick={() => toggle(g.key)} aria-expanded={open[g.key]}>
              <span className="form-sec-chevron" aria-hidden>{open[g.key] ? '▾' : '▸'}</span>
              <span className="form-sec-copy">
                <span className="form-sec-title">{g.title}</span>
                {g.description ? <span className="form-sec-sub">{g.description}</span> : null}
              </span>
            </button>
            {open[g.key] && <div className="form-grid">{g.cols.map(renderField)}</div>}
          </section>
        ))
      ) : (
        <div className="form-grid">{fields.map(renderField)}</div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
      </div>
    </div>
  );
}
