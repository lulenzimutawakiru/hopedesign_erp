import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { api, type ListResult } from '../api';
import { pick } from '../helpers';

type Rec = Record<string, unknown>;

export interface EntityOption {
  value: string;
  label: string;
  hint?: string;
  disabled?: boolean;
}

interface EntityPickerProps {
  value: string;
  onChange: (value: string, option?: EntityOption) => void;
  /** Static option list (e.g. records already loaded on the parent record). */
  options?: EntityOption[];
  /** CRUD list endpoint used for remote search, e.g. `/api/inventory/items`. */
  endpoint?: string;
  /** Extra query parameters sent with remote searches. */
  query?: Record<string, string>;
  /** Query-string key the endpoint uses for free-text search (default `q`). */
  searchParam?: string;
  /** Maps an API row to a picker option. Defaults to code/name/id. */
  mapRow?: (row: Rec) => EntityOption;
  placeholder?: string;
  disabled?: boolean;
  /** Accessible name when there is no visible <label htmlFor>. */
  ariaLabel?: string;
  /** Display text for a pre-selected value whose row is not available locally. */
  initialLabel?: string;
  /** Shown when a search returns nothing. */
  emptyHint?: string;
  id?: string;
  className?: string;
}

export const defaultMapRow = (row: Rec): EntityOption => {
  const id = pick(row, 'id');
  const code = pick(row, 'code', 'employeeCode', 'jobNo');
  const name = pick(row, 'name', 'description', 'label', 'title');
  const label = [code, name].filter((v) => v && v !== '-').join(' | ');
  return {
    value: id === undefined || id === null ? '' : String(id),
    label: label || String(id ?? ''),
    hint: pick(row, 'status', 'email', 'phone'),
  };
};

/**
 * Searchable entity picker. Backed by an authorised CRUD list endpoint (never a
 * hardcoded id), or by an explicit option list the caller already holds.
 * Keyboard- and screen-reader-accessible combobox.
 */
export default function EntityPicker({
  value,
  onChange,
  options,
  endpoint,
  query,
  searchParam = 'q',
  mapRow = defaultMapRow,
  placeholder = 'Search...',
  disabled = false,
  ariaLabel,
  initialLabel,
  emptyHint = 'No matches',
  id,
  className,
}: EntityPickerProps) {
  const autoId = useId();
  const inputId = id ?? `picker-${autoId}`;
  const listId = `${inputId}-list`;

  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [rows, setRows] = useState<EntityOption[]>(options ?? []);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [chosen, setChosen] = useState<EntityOption | null>(null);

  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [debounced, setDebounced] = useState('');

  useEffect(() => {
    const t = setTimeout(() => setDebounced(text.trim()), 250);
    return () => clearTimeout(t);
  }, [text]);

  const queryKey = useMemo(() => JSON.stringify(query ?? {}), [query]);

  useEffect(() => {
    if (endpoint) return;
    setRows(options ?? []);
  }, [endpoint, options]);

  useEffect(() => {
    if (!endpoint || !open) return;
    let alive = true;
    const params = new URLSearchParams({ page: '1', pageSize: '25' });
    if (debounced) params.set(searchParam, debounced);
    for (const [k, v] of Object.entries(JSON.parse(queryKey) as Record<string, string>)) {
      if (v) params.set(k, v);
    }
    setLoading(true);
    setError('');
    api<ListResult<Rec>>(`${endpoint}?${params.toString()}`)
      .then((r) => {
        if (!alive) return;
        setRows((r.data ?? []).map(mapRow));
        setActive(0);
      })
      .catch((e) => {
        if (!alive) return;
        setRows([]);
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [endpoint, open, debounced, queryKey, mapRow]);

  const visible = useMemo(() => {
    if (endpoint) return rows;
    const needle = text.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter(
      (o) => o.label.toLowerCase().includes(needle) || (o.hint ?? '').toLowerCase().includes(needle)
    );
  }, [endpoint, rows, text]);

  const selected = useMemo(() => {
    const found = (options ?? rows).find((o) => o.value === value);
    return found ?? chosen ?? null;
  }, [options, rows, value, chosen]);

  const display = open
    ? text
    : selected?.label ?? (value ? initialLabel ?? value : '');

  const commit = useCallback(
    (option: EntityOption) => {
      if (option.disabled) return;
      setChosen(option);
      onChange(option.value, option);
      setOpen(false);
      setText('');
    },
    [onChange]
  );

  useEffect(() => {
    if (!open) return;
    const onDocDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocDown);
    return () => document.removeEventListener('mousedown', onDocDown);
  }, [open]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (disabled) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) { setOpen(true); return; }
      if (!visible.length) return;
      setActive((i) => {
        const next = e.key === 'ArrowDown' ? i + 1 : i - 1;
        return (next + visible.length) % visible.length;
      });
      return;
    }
    if (e.key === 'Enter') {
      if (open && visible[active]) { e.preventDefault(); commit(visible[active]); }
      return;
    }
    if (e.key === 'Escape') {
      if (open) { e.preventDefault(); setOpen(false); setText(''); }
      return;
    }
    if (e.key === 'Tab' && open) setOpen(false);
  };

  const showClear = !disabled && !!value;

  return (
    <div className="picker" ref={wrapRef}>
      <div className="picker-input-row">
        <input
          id={inputId}
          className={className}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label={ariaLabel}
          aria-activedescendant={open && visible[active] ? `${listId}-${active}` : undefined}
          autoComplete="off"
          disabled={disabled}
          placeholder={open ? placeholder : undefined}
          value={display}
          onChange={(e) => { setText(e.target.value); setOpen(true); }}
          onFocus={() => { setOpen(true); setText(''); }}
          onKeyDown={onKeyDown}
        />
        {showClear && (
          <button
            type="button"
            className="btn btn-sm picker-clear"
            aria-label="Clear selection"
            onClick={() => { setChosen(null); onChange(''); setText(''); }}
          >
            Clear
          </button>
        )}
      </div>
      {open && !disabled && (
        <ul className="picker-list" id={listId} role="listbox" aria-label={ariaLabel ?? placeholder}>
          {loading && <li className="picker-note">Searching...</li>}
          {!loading && error && <li className="picker-note picker-note-error">{error}</li>}
          {!loading && !error && visible.length === 0 && <li className="picker-note">{emptyHint}</li>}
          {!loading && !error && visible.map((o, i) => (
            <li
              key={o.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={o.value === value}
              aria-disabled={o.disabled}
              className={`picker-option${i === active ? ' is-active' : ''}${o.disabled ? ' is-disabled' : ''}`}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => { e.preventDefault(); commit(o); }}
            >
              <span className="picker-option-label">{o.label}</span>
              {o.hint && o.hint !== '-' && <span className="picker-option-hint">{o.hint}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
