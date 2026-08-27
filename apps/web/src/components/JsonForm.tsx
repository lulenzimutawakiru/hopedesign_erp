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

export interface JsonFormProps {
  meta: EntityMeta;
  initial?: Record<string, unknown>;
  onSubmit: (values: Record<string, unknown>) => Promise<void>;
  onCancel: () => void;
  submitLabel?: string;
}

export function JsonForm({ meta, initial, onSubmit, onCancel, submitLabel = 'Save' }: JsonFormProps) {
  const fields = useMemo(() => meta.columns.filter((c) => c.writable && !['id'].includes(c.name)), [meta]);
  const [values, setValues] = useState<Record<string, unknown>>(() => {
    const v: Record<string, unknown> = {};
    for (const c of fields) {
      const key = c.camel;
      v[key] = initial?.[key] !== undefined && initial?.[key] !== null ? initial[key] : defaultValueFor(c);
    }
    return v;
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const v: Record<string, unknown> = {};
    for (const c of fields) {
      const key = c.camel;
      v[key] = initial?.[key] !== undefined && initial?.[key] !== null ? initial[key] : defaultValueFor(c);
    }
    setValues(v);
  }, [initial, fields]);

  const set = (camel: string, value: unknown) => setValues((prev) => ({ ...prev, [camel]: value }));

  const submit = async () => {
    setBusy(true);
    setError(null);
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
          try {
            payload[c.camel] = JSON.parse(String(raw));
          } catch {
            payload[c.camel] = String(raw);
          }
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

  return (
    <div>
      {error && <div className="error-banner">{error}</div>}
      <div className="form-grid">
        {fields.map((c) => {
          const t = inputTypeFor(c);
          const label = prettyLabel(c.name);
          const isTextarea = c.dataType === 'text' && TEXTAREA_COLS.has(c.name);
          const id = `f-${c.name}`;
          return (
            <div className={`field ${!c.nullable && !c.hasDefault ? 'field-required' : ''}`} key={c.name} style={isTextarea ? { gridColumn: '1 / -1' } : undefined}>
              <label htmlFor={id}>{label}</label>
              {t === 'boolean' ? (
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
        })}
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 16 }}>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Saving…' : submitLabel}</button>
      </div>
    </div>
  );
}
