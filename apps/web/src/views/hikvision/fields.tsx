import type { InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';

export function Field({
  label, hint, children, req,
}: { label: string; hint?: string; children: ReactNode; req?: boolean }) {
  return (
    <label className="hk-field">
      <span className="hk-lbl">{label}{req ? ' *' : ''}</span>
      {children}
      {hint ? <span className="hk-subnote">{hint}</span> : null}
    </label>
  );
}

type InpAttrs = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value'>;
export function Inp({
  value, onChange, ...rest
}: { value: string; onChange: (v: string) => void } & InpAttrs) {
  return <input className="hk-input" value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

type TxaAttrs = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'>;
export function Txa({
  value, onChange, ...rest
}: { value: string; onChange: (v: string) => void } & TxaAttrs) {
  return <textarea className="hk-input" rows={3} value={value} onChange={(e) => onChange(e.target.value)} {...rest} />;
}

type SelAttrs = Omit<SelectHTMLAttributes<HTMLSelectElement>, 'onChange' | 'value'>;
export function Sel({
  value, onChange, options, placeholder, ...rest
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  placeholder?: string;
} & SelAttrs) {
  return (
    <select className="hk-select" value={value} onChange={(e) => onChange(e.target.value)} {...rest}>
      {placeholder ? <option value="">{placeholder}</option> : null}
      {options.map((o) => (
        <option key={o.value} value={o.value}>{o.label}</option>
      ))}
    </select>
  );
}

export function Check({
  label, checked, onChange, disabled, hint,
}: { label: string; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; hint?: string }) {
  return (
    <label className="hk-check" style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 13 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} disabled={disabled} />
      <span>
        {label}
        {hint ? <span className="hk-subnote" style={{ display: 'block' }}>{hint}</span> : null}
      </span>
    </label>
  );
}

export function FormErr({ msg }: { msg: string }) {
  if (!msg) return null;
  return <div className="error-banner" style={{ marginTop: 10 }}>{msg}</div>;
}

export function Saved({ msg }: { msg: string }) {
  if (!msg) return null;
  return <div className="notice-banner" style={{ marginTop: 10 }}>{msg}</div>;
}