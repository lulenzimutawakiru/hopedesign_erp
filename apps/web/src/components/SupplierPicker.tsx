import { useState } from 'react';
import { api } from '../api';
import { useAuth, can } from '../auth';
import { SUPPLIER_TYPES } from './SupplierForm';

type Rec = Record<string, unknown>;

interface SupplierPickerProps {
  suppliers: Rec[];
  value: string;
  onChange: (value: string) => void;
  onCreated?: (supplier: Rec) => void;
  placeholder?: string;
  className?: string;
}

export function SupplierPicker({
  suppliers,
  value,
  onChange,
  onCreated,
  placeholder = 'Select supplier...',
  className,
}: SupplierPickerProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [supplierType, setSupplierType] = useState('RAW_MATERIAL');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const canCreate = can(user, 'procurement.suppliers.create');

  const submit = async () => {
    setError('');
    if (!name.trim()) {
      setError('Supplier name is required');
      return;
    }
    setBusy(true);
    try {
      const r = await api<{ data: { supplierId: number; code: string } }>('/api/ops/procurement/suppliers', {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          supplierType,
          phone: phone.trim() || null,
          email: email.trim() || null,
        }),
      });
      const rec: Rec = { id: r.data.supplierId, code: r.data.code, name: name.trim() };
      onCreated?.(rec);
      onChange(String(r.data.supplierId));
      setOpen(false);
      setName('');
      setSupplierType('RAW_MATERIAL');
      setPhone('');
      setEmail('');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <select
            className={className}
            value={value}
            onChange={(e) => onChange(e.target.value)}
          >
            <option value="">{placeholder}</option>
            {suppliers.map((s) => (
              <option key={String(s.id)} value={String(s.id)}>{String(s.code)} | {String(s.name)}</option>
            ))}
          </select>
        </div>
        {canCreate && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => { setOpen((o) => !o); setError(''); }}
          >
            {open ? 'Close' : '+ New'}
          </button>
        )}
      </div>
      {open && (
        <div
          className="supplier-quick"
          style={{
            marginTop: 8,
            padding: 12,
            border: '1px solid var(--line)',
            borderRadius: 'var(--radius)',
            background: 'var(--sheet)',
          }}
        >
          <div className="form-grid">
            <div className="field field-required">
              <label htmlFor="sp-name">Supplier name</label>
              <input id="sp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Kampala Steel Traders" autoFocus />
            </div>
            <div className="field">
              <label htmlFor="sp-type">Type</label>
              <select id="sp-type" value={supplierType} onChange={(e) => setSupplierType(e.target.value)}>
                {SUPPLIER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div className="field">
              <label htmlFor="sp-phone">Phone</label>
              <input id="sp-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+256 700 000 000" />
            </div>
            <div className="field">
              <label htmlFor="sp-email">Email</label>
              <input id="sp-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="accounts@supplier.com" />
            </div>
          </div>
          {error && <div className="field-error" style={{ marginTop: 6 }}>{error}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 10 }}>
            <button type="button" className="btn" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
            <button type="button" className="btn btn-primary" disabled={busy} onClick={submit}>{busy ? 'Adding...' : 'Add supplier'}</button>
          </div>
        </div>
      )}
    </div>
  );
}
