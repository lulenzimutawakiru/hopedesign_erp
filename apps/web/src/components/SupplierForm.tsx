import { useState } from 'react';
import { api } from '../api';

type Rec = Record<string, unknown>;

export const SUPPLIER_TYPES = [
  { value: 'RAW_MATERIAL', label: 'Raw material' },
  { value: 'PACKAGING', label: 'Packaging' },
  { value: 'SERVICE', label: 'Service' },
  { value: 'CONSUMABLE', label: 'Consumable' },
  { value: 'SECURITY_MATERIAL', label: 'Security material' },
  { value: 'MACHINERY', label: 'Machinery' },
  { value: 'OTHER', label: 'Other' },
];

export const SUPPLIER_CURRENCIES = ['UGX', 'USD', 'EUR', 'GBP', 'KES', 'TZS'];

interface SupplierFormValues {
  name: string;
  supplierType: string;
  tin: string;
  vrn: string;
  phone: string;
  email: string;
  website: string;
  address: string;
  currency: string;
  paymentTermsDays: string;
  defaultLeadTimeDays: string;
  securityCleared: boolean;
}

const INITIAL: SupplierFormValues = {
  name: '',
  supplierType: 'RAW_MATERIAL',
  tin: '',
  vrn: '',
  phone: '',
  email: '',
  website: '',
  address: '',
  currency: 'UGX',
  paymentTermsDays: '30',
  defaultLeadTimeDays: '7',
  securityCleared: false,
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PHONE_RE = /^[+()\d\s.-]{7,}$/;
const URL_RE = /^(https?:\/\/)?([\w-]+\.)+[a-z]{2,}(:\d+)?(\/\S*)?$/i;

function integerInRange(v: string, min: number, max: number): boolean {
  const n = Number(v);
  return Number.isInteger(n) && n >= min && n <= max;
}

function validate(values: SupplierFormValues): Partial<Record<keyof SupplierFormValues, string>> {
  const errors: Partial<Record<keyof SupplierFormValues, string>> = {};
  const name = values.name.trim();
  if (!name) errors.name = 'Supplier name is required';
  else if (name.length < 2) errors.name = 'Supplier name is too short';
  if (values.email.trim() && !EMAIL_RE.test(values.email.trim())) errors.email = 'Enter a valid email address';
  if (values.phone.trim() && !PHONE_RE.test(values.phone.trim())) errors.phone = 'Enter a valid phone number';
  if (values.website.trim() && !URL_RE.test(values.website.trim())) errors.website = 'Enter a valid web address, e.g. https://example.com';
  if (!integerInRange(values.paymentTermsDays, 0, 365)) errors.paymentTermsDays = 'Enter a whole number between 0 and 365 days';
  if (!integerInRange(values.defaultLeadTimeDays, 0, 365)) errors.defaultLeadTimeDays = 'Enter a whole number between 0 and 365 days';
  return errors;
}

export interface SupplierFormProps {
  onCancel: () => void;
  onCreated: (supplier: Rec) => void;
}

export function SupplierForm({ onCancel, onCreated }: SupplierFormProps) {
  const [values, setValues] = useState<SupplierFormValues>(INITIAL);
  const [errors, setErrors] = useState<Partial<Record<keyof SupplierFormValues, string>>>({});
  const [serverError, setServerError] = useState('');
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof SupplierFormValues>(key: K, value: SupplierFormValues[K]) => {
    setValues((prev) => ({ ...prev, [key]: value }));
    if (errors[key]) setErrors((prev) => ({ ...prev, [key]: undefined }));
  };

  const submit = async () => {
    const next = validate(values);
    setErrors(next);
    setServerError('');
    if (Object.values(next).some(Boolean)) return;
    setBusy(true);
    try {
      const payload = {
        name: values.name.trim(),
        supplierType: values.supplierType,
        tin: values.tin.trim() || null,
        vrn: values.vrn.trim() || null,
        phone: values.phone.trim() || null,
        email: values.email.trim() || null,
        website: values.website.trim() || null,
        address: values.address.trim() || null,
        currency: values.currency,
        paymentTermsDays: Number(values.paymentTermsDays),
        defaultLeadTimeDays: Number(values.defaultLeadTimeDays),
        securityCleared: values.securityCleared,
      };
      const r = await api<{ data: { supplierId: number; code: string } }>('/api/ops/procurement/suppliers', {
        method: 'POST',
        body: JSON.stringify(payload),
      });
      onCreated({ id: r.data.supplierId, code: r.data.code, name: values.name.trim() });
    } catch (e) {
      setServerError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const err = (key: keyof SupplierFormValues) => (errors[key] ? 'field-invalid' : '');

  return (
    <div>
      {serverError && <div className="error-banner">{serverError}</div>}
      <div className="form-sec">Company details</div>
      <div className="form-grid">
        <div className={`field field-required ${err('name')}`}>
          <label htmlFor="sup-name">Supplier name</label>
          <input
            id="sup-name"
            value={values.name}
            onChange={(e) => set('name', e.target.value)}
            placeholder="e.g. Kampala Steel Traders"
            autoFocus
          />
          {errors.name ? <div className="field-error">{errors.name}</div> : <span className="field-hint">Legal or trading name used on documents</span>}
        </div>
        <div className="field">
          <label htmlFor="sup-type">Supplier type</label>
          <select id="sup-type" value={values.supplierType} onChange={(e) => set('supplierType', e.target.value)}>
            {SUPPLIER_TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
          </select>
          <span className="field-hint">What the supplier provides</span>
        </div>
        <div className="field">
          <label htmlFor="sup-tin">TIN</label>
          <input id="sup-tin" value={values.tin} onChange={(e) => set('tin', e.target.value)} placeholder="Tax Identification Number" />
          <span className="field-hint">For invoicing and tax records</span>
        </div>
        <div className="field">
          <label htmlFor="sup-vrn">VRN</label>
          <input id="sup-vrn" value={values.vrn} onChange={(e) => set('vrn', e.target.value)} placeholder="VAT Registration Number" />
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label>
            <input type="checkbox" checked={values.securityCleared} onChange={(e) => set('securityCleared', e.target.checked)} />{' '}
            Security cleared
          </label>
          <span className="field-hint">Verified against the security pre-qualification checklist</span>
        </div>
      </div>

      <div className="form-sec">Contact details</div>
      <div className="form-grid">
        <div className={`field ${err('phone')}`}>
          <label htmlFor="sup-phone">Phone</label>
          <input id="sup-phone" type="tel" inputMode="tel" autoComplete="tel" value={values.phone} onChange={(e) => set('phone', e.target.value)} placeholder="+256 700 000 000" />
          {errors.phone ? <div className="field-error">{errors.phone}</div> : null}
        </div>
        <div className={`field ${err('email')}`}>
          <label htmlFor="sup-email">Email</label>
          <input id="sup-email" type="email" inputMode="email" autoComplete="email" value={values.email} onChange={(e) => set('email', e.target.value)} placeholder="accounts@supplier.com" />
          {errors.email ? <div className="field-error">{errors.email}</div> : null}
        </div>
        <div className={`field ${err('website')}`}>
          <label htmlFor="sup-website">Website</label>
          <input id="sup-website" type="url" inputMode="url" value={values.website} onChange={(e) => set('website', e.target.value)} placeholder="https://supplier.com" />
          {errors.website ? <div className="field-error">{errors.website}</div> : null}
        </div>
        <div className="field" style={{ gridColumn: '1 / -1' }}>
          <label htmlFor="sup-address">Address</label>
          <textarea id="sup-address" value={values.address} onChange={(e) => set('address', e.target.value)} placeholder="Street, city, country" />
        </div>
      </div>

      <div className="form-sec">Commercial terms</div>
      <div className="form-grid">
        <div className="field">
          <label htmlFor="sup-currency">Currency</label>
          <select id="sup-currency" value={values.currency} onChange={(e) => set('currency', e.target.value)}>
            {SUPPLIER_CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <span className="field-hint">Default currency for quotes and invoices</span>
        </div>
        <div className={`field ${err('paymentTermsDays')}`}>
          <label htmlFor="sup-terms">Payment terms (days)</label>
          <input id="sup-terms" type="number" inputMode="numeric" min={0} max={365} value={values.paymentTermsDays} onChange={(e) => set('paymentTermsDays', e.target.value)} />
          {errors.paymentTermsDays ? <div className="field-error">{errors.paymentTermsDays}</div> : <span className="field-hint">e.g. 30 for net-30</span>}
        </div>
        <div className={`field ${err('defaultLeadTimeDays')}`}>
          <label htmlFor="sup-lead">Default lead time (days)</label>
          <input id="sup-lead" type="number" inputMode="numeric" min={0} max={365} value={values.defaultLeadTimeDays} onChange={(e) => set('defaultLeadTimeDays', e.target.value)} />
          {errors.defaultLeadTimeDays ? <div className="field-error">{errors.defaultLeadTimeDays}</div> : <span className="field-hint">Typical days from order to delivery</span>}
        </div>
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 18 }}>
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? 'Creating…' : 'Create supplier'}</button>
      </div>
    </div>
  );
}
