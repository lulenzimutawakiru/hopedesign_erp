import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, fmtDate, fmtMoney, fmtNum, ListResult, openDocument } from '../../api';
import { useAuth, can } from '../../auth';
import { navigate, useHashQuery } from '../../router';
import { pick } from '../../helpers';
import { Badge, ErrorBanner, PageLoader } from '../../components/ui';
import { toast } from '../../components/toast';
import {
  afterSubmit,
  buildOptionals,
  buildQuotationItems,
  confirmLabel,
  defaultValidUntil,
  quotationTotals,
  shippingPolicyLabel,
  todayIso,
  type DraftLine,
  type DraftOptional,
  type LineKind,
} from './odooSales';

type Rec = Record<string, unknown>;
type Tab = 'lines' | 'optional' | 'other' | 'notes';

interface SalesSettings {
  defaultQuotationValidityDays: number;
  proformaInvoice: boolean;
  showMargins: boolean;
  discounts: boolean;
  saleWarnings: boolean;
  defaultTemplateId: number | null;
}

interface Person { id: number; firstName: string; lastName: string }
interface TaxOption { code: string; name: string; rate: number }

const FALLBACK_SETTINGS: SalesSettings = {
  defaultQuotationValidityDays: 30,
  proformaInvoice: false,
  showMargins: false,
  discounts: true,
  saleWarnings: true,
  defaultTemplateId: null,
};

const TABS: { id: Tab; label: string }[] = [
  { id: 'lines', label: 'Order Lines' },
  { id: 'optional', label: 'Optional Products' },
  { id: 'other', label: 'Other Info' },
  { id: 'notes', label: 'Notes' },
];

function num(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function day(v: unknown): string {
  if (v == null || v === '') return '';
  return String(v).slice(0, 10);
}

function nextKey(): string {
  return `l-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function blankProduct(tax: TaxOption): DraftLine {
  return {
    key: nextKey(),
    lineKind: 'PRODUCT',
    productId: '',
    description: '',
    quantity: 1,
    unitId: '',
    unitPrice: 0,
    discountPercent: 0,
    taxPercent: tax.rate,
    taxCategory: tax.code,
    cost: 0,
    weight: 0,
  };
}

function blankOptional(): DraftOptional {
  return { key: nextKey(), productId: '', description: '', quantity: 1, unitPrice: 0 };
}

function lineFromRow(row: Rec): DraftLine {
  const raw = String(row.lineKind ?? 'PRODUCT').toUpperCase();
  const lineKind: LineKind = raw === 'SECTION' || raw === 'NOTE' ? raw : 'PRODUCT';
  return {
    key: `saved-${String(row.id ?? nextKey())}`,
    lineKind,
    productId: row.productId != null ? num(row.productId) : '',
    description: String(row.description ?? row.productName ?? ''),
    quantity: lineKind === 'PRODUCT' ? num(row.quantity, 1) : 0,
    unitId: row.unitId != null ? num(row.unitId) : '',
    unitPrice: num(row.unitPrice),
    discountPercent: num(row.discountPercent),
    taxPercent: num(row.taxPercent),
    taxCategory: String(row.taxCategory ?? 'STANDARD'),
    cost: num(row.standardCost),
    weight: num(row.weightPerUnit),
  };
}

function optionalFromRow(row: Rec): DraftOptional {
  return {
    key: `opt-${String(row.id ?? nextKey())}`,
    productId: row.productId != null ? num(row.productId) : '',
    description: String(row.description ?? row.productName ?? ''),
    quantity: num(row.quantity, 1),
    unitPrice: num(row.unitPrice),
  };
}

function personName(p: Person): string {
  return `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim();
}

function sectionUntaxed(lines: DraftLine[], index: number): number {
  const next = lines.findIndex((row, i) => i > index && row.lineKind === 'SECTION');
  return quotationTotals(lines.slice(index + 1, next === -1 ? undefined : next)).untaxed;
}

function LookupField({
  endpoint,
  valueLabel,
  onPick,
  placeholder,
  disabled,
}: {
  endpoint: string;
  valueLabel: string;
  onPick: (row: Rec) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [q, setQ] = useState(valueLabel);
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<Rec[]>([]);

  useEffect(() => { setQ(valueLabel); }, [valueLabel]);

  useEffect(() => {
    if (!open || disabled) return;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ pageSize: '12' });
      if (q.trim() && q !== valueLabel) params.set('q', q.trim());
      const sep = endpoint.includes('?') ? '&' : '?';
      api<ListResult>(`${endpoint}${sep}${params.toString()}`)
        .then((r) => setRows(r.data ?? []))
        .catch(() => setRows([]));
    }, 180);
    return () => clearTimeout(t);
  }, [disabled, endpoint, open, q, valueLabel]);

  return (
    <div className="lookup">
      <input
        value={q}
        disabled={disabled}
        placeholder={placeholder ?? 'Search…'}
        onFocus={() => setOpen(true)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onBlur={() => setTimeout(() => setOpen(false), 180)}
      />
      {open && !disabled && (
        <div className="lookup-menu">
          {rows.map((r) => (
            <button
              key={String(r.id)}
              type="button"
              className="lookup-item"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(r); setOpen(false); }}
            >
              {`${pick(r, 'code') ?? ''} · ${pick(r, 'name') ?? ''}`.replace(/^ · /, '')}
            </button>
          ))}
          {rows.length === 0 && <div className="search-hint">No matches</div>}
        </div>
      )}
    </div>
  );
}

export default function QuotationForm({ id }: { id: number | null }) {
  const { user } = useAuth();
  const query = useHashQuery();
  const [loading, setLoading] = useState(id != null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('lines');
  const [settings, setSettings] = useState<SalesSettings>(FALLBACK_SETTINGS);
  const [taxOptions, setTaxOptions] = useState<TaxOption[]>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [teams, setTeams] = useState<Rec[]>([]);
  const [priceLists, setPriceLists] = useState<Rec[]>([]);
  const [templates, setTemplates] = useState<Rec[]>([]);
  const [listPrices, setListPrices] = useState<Record<number, number>>({});
  const [orders, setOrders] = useState<Rec[]>([]);

  const [status, setStatus] = useState('');
  const [number, setNumber] = useState('');
  const [customerId, setCustomerId] = useState<number | ''>('');
  const [customerLabel, setCustomerLabel] = useState('');
  const [customerStatus, setCustomerStatus] = useState('');
  const [creditLimit, setCreditLimit] = useState(0);
  const [contactId, setContactId] = useState<number | null>(null);
  const [opportunityId, setOpportunityId] = useState<number | ''>('');
  const [quotationDate, setQuotationDate] = useState(todayIso());
  const [validUntil, setValidUntil] = useState('');
  const [currency, setCurrency] = useState('UGX');
  const [buyerType, setBuyerType] = useState('');
  const [invoiceAddress, setInvoiceAddress] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [priceListId, setPriceListId] = useState<number | ''>('');
  const [paymentTermsDays, setPaymentTermsDays] = useState<number | ''>('');
  const [templateId, setTemplateId] = useState<number | ''>('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [optionals, setOptionals] = useState<DraftOptional[]>([]);
  const [salespersonId, setSalespersonId] = useState<number | ''>('');
  const [salesTeamId, setSalesTeamId] = useState<number | ''>('');
  const [customerReference, setCustomerReference] = useState('');
  const [tags, setTags] = useState('');
  const [shippingPolicy, setShippingPolicy] = useState('ASAP');
  const [incoterm, setIncoterm] = useState('');
  const [incotermLocation, setIncotermLocation] = useState('');
  const [deliveryDate, setDeliveryDate] = useState('');
  const [sourceDocument, setSourceDocument] = useState('');
  const [campaign, setCampaign] = useState('');
  const [medium, setMedium] = useState('');
  const [source, setSource] = useState('');
  const [notes, setNotes] = useState('');
  const [terms, setTerms] = useState('');
  const [dirty, setDirty] = useState(false);
  const [booted, setBooted] = useState(false);
  const seeded = useRef(false);

  const defaultTax = useMemo<TaxOption>(
    () => taxOptions.find((o) => o.code === 'STANDARD') ?? taxOptions[0] ?? { code: 'STANDARD', name: 'Standard', rate: 18 },
    [taxOptions]
  );
  const editable = (status === '' || status === 'DRAFT') && (id == null ? can(user, 'sales.quotations.create') : can(user, 'sales.quotations.update'));
  const totals = useMemo(() => quotationTotals(lines), [lines]);
  const actionLabel = confirmLabel(status, can(user, 'sales.quotations.convert'));
  const showConfirm = actionLabel != null && (
    (status === 'APPROVED' && can(user, 'sales.quotations.convert'))
    || ((status === '' || status === 'DRAFT') && editable && can(user, 'sales.quotations.submit'))
  );

  const mark = () => setDirty(true);

  const applyCustomer = (row: Rec) => {
    setCustomerId(num(row.id));
    setCustomerLabel(`${pick(row, 'code') ?? ''} · ${pick(row, 'name') ?? ''}`.replace(/^ · /, ''));
    setCustomerStatus(String(pick(row, 'status') ?? ''));
    setCreditLimit(num(pick(row, 'creditLimit', 'credit_limit')));
    const billing = String(pick(row, 'billingAddress', 'billing_address') ?? pick(row, 'address') ?? '');
    const shipping = String(pick(row, 'shippingAddress', 'shipping_address') ?? '');
    setInvoiceAddress(billing);
    setDeliveryAddress(shipping);
    const termsDays = pick(row, 'paymentTermsDays', 'payment_terms_days');
    setPaymentTermsDays(termsDays != null && termsDays !== '' ? num(termsDays) : '');
    const listId = pick(row, 'priceListId', 'price_list_id');
    setPriceListId(listId != null && listId !== '' ? num(listId) : '');
    mark();
  };

  const applyTemplate = useCallback(async (nextId: number) => {
    const r = await api<{ data: { template: Rec; lines: Rec[] } }>(`/api/ops/sales/templates/${nextId}`);
    const template = r.data.template;
    const copied = (r.data.lines ?? []).map(lineFromRow);
    setTemplateId(nextId);
    setLines(copied.length ? copied : [blankProduct(defaultTax)]);
    if (template.notes != null) setNotes(String(template.notes));
    const days = template.validityDays != null ? num(template.validityDays) : settings.defaultQuotationValidityDays;
    setValidUntil(defaultValidUntil(quotationDate || todayIso(), days));
    setDirty(true);
  }, [defaultTax, quotationDate, settings.defaultQuotationValidityDays]);

  const loadQuote = useCallback(async () => {
    if (id == null) return;
    const r = await api<{ data: { quotation: Rec; items: Rec[]; orders: Rec[]; optionals: Rec[] } }>(`/api/ops/sales/quotations/${id}`);
    const q = r.data.quotation;
    setStatus(String(q.status ?? ''));
    setNumber(String(q.quotationNo ?? ''));
    setCustomerId(num(q.customerId));
    setCustomerLabel(`${q.customerCode ?? ''} · ${q.customerName ?? ''}`.replace(/^ · /, ''));
    setCustomerStatus(String(q.customerStatus ?? ''));
    setCreditLimit(num(q.customerCreditLimit));
    setContactId(q.contactId != null ? num(q.contactId) : null);
    setOpportunityId(q.opportunityId != null ? num(q.opportunityId) : '');
    setQuotationDate(day(q.quotationDate) || todayIso());
    setValidUntil(day(q.validUntil));
    setCurrency(String(q.currency ?? 'UGX'));
    setBuyerType(String(q.buyerType ?? ''));
    setInvoiceAddress(String(q.invoiceAddress ?? ''));
    setDeliveryAddress(String(q.deliveryAddress ?? ''));
    setPriceListId(q.priceListId != null ? num(q.priceListId) : '');
    setPaymentTermsDays(q.paymentTermsDays != null && q.paymentTermsDays !== '' ? num(q.paymentTermsDays) : '');
    setTemplateId(q.templateId != null ? num(q.templateId) : '');
    setLines((r.data.items ?? []).map(lineFromRow));
    setOptionals((r.data.optionals ?? []).map(optionalFromRow));
    setSalespersonId(q.salespersonId != null ? num(q.salespersonId) : '');
    setSalesTeamId(q.salesTeamId != null ? num(q.salesTeamId) : '');
    setCustomerReference(String(q.customerReference ?? ''));
    setTags(String(q.tags ?? ''));
    setShippingPolicy(String(q.shippingPolicy ?? 'ASAP'));
    setIncoterm(String(q.incoterm ?? ''));
    setIncotermLocation(String(q.incotermLocation ?? ''));
    setDeliveryDate(day(q.deliveryDate));
    setSourceDocument(String(q.sourceDocument ?? ''));
    setCampaign(String(q.campaign ?? ''));
    setMedium(String(q.medium ?? ''));
    setSource(String(q.source ?? ''));
    setNotes(String(q.notes ?? ''));
    setTerms(String(q.terms ?? ''));
    setOrders(r.data.orders ?? []);
    setDirty(false);
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api<{ data: SalesSettings }>('/api/ops/sales/settings').catch((e) => {
        if (e instanceof ApiError && e.status === 403) return { data: FALLBACK_SETTINGS };
        throw e;
      }),
      api<{ data: TaxOption[] }>('/api/ops/sales/tax-options').catch(() => ({ data: [] as TaxOption[] })),
      api<{ data: Person[] }>('/api/ops/sales/salespeople').catch(() => ({ data: [] as Person[] })),
      api<{ data: Rec[] }>('/api/ops/sales/teams').catch(() => ({ data: [] as Rec[] })),
      api<{ data: Rec[] }>('/api/ops/sales/price-lists').catch(() => ({ data: [] as Rec[] })),
      api<{ data: Rec[] }>('/api/ops/sales/templates').catch(() => ({ data: [] as Rec[] })),
    ])
      .then(([settingsRes, taxRes, peopleRes, teamRes, listRes, templateRes]) => {
        if (cancelled) return;
        setSettings({ ...FALLBACK_SETTINGS, ...settingsRes.data });
        setTaxOptions(taxRes.data ?? []);
        setPeople(peopleRes.data ?? []);
        setTeams(teamRes.data ?? []);
        setPriceLists(listRes.data ?? []);
        setTemplates(templateRes.data ?? []);
      })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : 'Could not open the quotation'); })
      .finally(() => { if (!cancelled) setBooted(true); });
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (id == null) return;
    setLoading(true);
    loadQuote()
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not load the quotation'))
      .finally(() => setLoading(false));
  }, [id, loadQuote]);

  useEffect(() => {
    if (!booted || id != null || seeded.current) return;
    seeded.current = true;
    const today = todayIso();
    setQuotationDate(today);
    setValidUntil(defaultValidUntil(today, settings.defaultQuotationValidityDays));
    if (user?.id) setSalespersonId(user.id);
    setLines([blankProduct(defaultTax)]);
    const preset = Number(query.get('customer'));
    const label = query.get('customerLabel');
    if (preset > 0) {
      setCustomerId(preset);
      if (label) setCustomerLabel(label);
      api<{ data: { customer: Rec } }>(`/api/ops/sales/customers/${preset}/360`)
        .then((r) => applyCustomer(r.data.customer))
        .catch(() => undefined);
    }
    if (settings.defaultTemplateId) {
      applyTemplate(settings.defaultTemplateId).catch(() => undefined);
    }
  }, [applyTemplate, booted, defaultTax, id, query, settings.defaultQuotationValidityDays, settings.defaultTemplateId, user?.id]);

  useEffect(() => {
    if (priceListId === '') { setListPrices({}); return; }
    api<{ data: { items?: Rec[] } }>(`/api/ops/sales/price-lists/${priceListId}`)
      .then((r) => {
        const map: Record<number, number> = {};
        for (const item of r.data.items ?? []) map[num(item.productId)] = num(item.unitPrice);
        setListPrices(map);
      })
      .catch(() => setListPrices({}));
  }, [priceListId]);

  const setLine = (key: string, patch: Partial<DraftLine>) => {
    setLines((prev) => prev.map((line) => (line.key === key ? { ...line, ...patch } : line)));
    mark();
  };

  const pickProduct = (key: string, row: Rec) => {
    const productId = num(row.id);
    const listed = listPrices[productId];
    setLine(key, {
      lineKind: 'PRODUCT',
      productId,
      description: String(pick(row, 'name') ?? ''),
      unitId: pick(row, 'unitId', 'unit_id') != null ? num(pick(row, 'unitId', 'unit_id')) : '',
      unitPrice: listed != null ? listed : num(pick(row, 'listPrice', 'standardPrice', 'standard_price')),
      cost: num(pick(row, 'standardCost', 'standard_cost')),
      weight: num(pick(row, 'weightPerUnit', 'weight_per_unit')),
    });
  };

  const payload = () => {
    const items = buildQuotationItems(lines.filter((line) => line.lineKind !== 'PRODUCT' || line.productId !== ''));
    return {
      customerId: Number(customerId),
      contactId,
      opportunityId: opportunityId === '' ? null : Number(opportunityId),
      quotationDate,
      validUntil: validUntil || null,
      currency: currency || 'UGX',
      notes: notes || null,
      terms: terms || null,
      buyerType: buyerType || null,
      items,
      optionals: buildOptionals(optionals),
      invoiceAddress: invoiceAddress || null,
      deliveryAddress: deliveryAddress || null,
      priceListId: priceListId === '' ? null : Number(priceListId),
      paymentTermsDays: paymentTermsDays === '' ? null : Number(paymentTermsDays),
      customerReference: customerReference || null,
      salespersonId: salespersonId === '' ? null : Number(salespersonId),
      salesTeamId: salesTeamId === '' ? null : Number(salesTeamId),
      sourceDocument: sourceDocument || null,
      tags: tags || null,
      shippingPolicy,
      incoterm: incoterm || null,
      incotermLocation: incotermLocation || null,
      campaign: campaign || null,
      medium: medium || null,
      source: source || null,
      templateId: templateId === '' ? null : Number(templateId),
      deliveryDate: deliveryDate || null,
    };
  };

  const persist = async (): Promise<number> => {
    if (!customerId) throw new Error('Select a customer');
    const body = payload();
    if (!body.items.some((item) => item.lineKind === 'PRODUCT')) throw new Error('Add at least one product');
    if (id == null) {
      const r = await api<{ data: { quotationId: number } }>('/api/ops/sales/quotations', { method: 'POST', body: JSON.stringify(body) });
      setDirty(false);
      return r.data.quotationId;
    }
    await api(`/api/ops/sales/quotations/${id}`, { method: 'PUT', body: JSON.stringify(body) });
    setDirty(false);
    return id;
  };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const savedId = await persist();
      toast.success('Quotation saved');
      if (id == null) navigate(`/sales/quotations/${savedId}`);
      else await loadQuote();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save the quotation');
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    setBusy(true);
    setError('');
    let currentId = id;
    let created = false;
    try {
      let nextStatus = status;
      if (currentId == null || (editable && dirty)) {
        currentId = await persist();
        created = id == null;
        nextStatus = 'DRAFT';
      }
      if (currentId == null) return;
      if (nextStatus === '' || nextStatus === 'DRAFT') {
        await api(`/api/ops/sales/quotations/${currentId}/submit`, { method: 'POST', body: '{}' });
        const fresh = await api<{ data: { quotation: Rec } }>(`/api/ops/sales/quotations/${currentId}`);
        nextStatus = String(fresh.data.quotation.status ?? '');
      }
      const next = afterSubmit(nextStatus, can(user, 'sales.quotations.convert'));
      if (next === 'convert') {
        const r = await api<{ data: { orderId: number } }>(`/api/ops/sales/quotations/${currentId}/convert`, { method: 'POST', body: '{}' });
        toast.success('Quotation confirmed');
        navigate(`/sales/orders/${r.data.orderId}`);
        return;
      }
      if (next === 'approved') toast.success('Quotation approved. It is waiting for someone who can confirm it.');
      else toast.success('Quotation submitted and waiting for approval.');
      if (created) navigate(`/sales/quotations/${currentId}`);
      else await loadQuote();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not confirm the quotation');
      if (created && currentId != null) navigate(`/sales/quotations/${currentId}`);
    } finally {
      setBusy(false);
    }
  };

  const send = async () => {
    if (id == null && !customerId) { setError('Select a customer'); return; }
    setBusy(true);
    setError('');
    let createdId: number | null = null;
    try {
      const currentId = editable && (id == null || dirty) ? await persist() : id;
      if (currentId == null) return;
      if (id == null) createdId = currentId;
      const r = await api<{ data: { email?: { ok: boolean; error?: string }; sms?: { ok: boolean; error?: string } } }>(
        `/api/ops/sales/quotations/${currentId}/send`,
        { method: 'POST', body: '{}' }
      );
      const bits = [
        r.data.email?.ok ? 'email delivered' : r.data.email?.error ? `email: ${r.data.email.error}` : null,
        r.data.sms?.ok ? 'SMS delivered' : r.data.sms?.error ? `SMS: ${r.data.sms.error}` : null,
      ].filter(Boolean);
      toast.success(bits.length ? `Quotation sent · ${bits.join(' · ')}` : 'Quotation sent');
      if (id == null) navigate(`/sales/quotations/${currentId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not send the quotation');
      if (createdId != null) navigate(`/sales/quotations/${createdId}`);
    } finally {
      setBusy(false);
    }
  };

  const cancelQuote = async () => {
    if (id == null) { navigate('/sales'); return; }
    setBusy(true);
    setError('');
    try {
      await api(`/api/ops/sales/quotations/${id}/cancel`, { method: 'POST', body: '{}' });
      toast.success('Quotation cancelled');
      await loadQuote();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not cancel the quotation');
    } finally {
      setBusy(false);
    }
  };

  const preview = async () => {
    setBusy(true);
    setError('');
    let createdId: number | null = null;
    try {
      const currentId = editable && (id == null || dirty) ? await persist() : id;
      if (currentId == null) return;
      if (id == null) createdId = currentId;
      await openDocument('sales-quotation', currentId, 'print', `${number || 'quotation'}.pdf`);
      if (id == null) navigate(`/sales/quotations/${currentId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not preview the quotation');
      if (createdId != null) navigate(`/sales/quotations/${createdId}`);
    } finally {
      setBusy(false);
    }
  };

  const openProforma = async () => {
    setBusy(true);
    setError('');
    try {
      const currentId = editable && (id == null || dirty) ? await persist() : id;
      if (currentId == null) return;
      navigate(`/sales/quotations/${currentId}/proforma`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not open the pro-forma');
      setBusy(false);
    }
  };

  if (!booted || loading) return <PageLoader variant="page" label="Opening quotation…" />;

  const warning = settings.saleWarnings && (
    customerStatus === 'BLOCKED' || customerStatus === 'INACTIVE'
    || (creditLimit > 0 && totals.untaxed > creditLimit)
  );
  const canCancel = id != null && can(user, 'sales.quotations.update')
    && ['DRAFT', 'SUBMITTED', 'APPROVED', 'REJECTED', 'EXPIRED'].includes(status);
  const canSend = can(user, 'sales.quotations.send') && (id == null ? editable : ['DRAFT', 'SUBMITTED', 'APPROVED'].includes(status));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" type="button" onClick={() => navigate('/sales')}>Back</button>
          <p className="mod-kicker" data-mod="sales">Sales</p>
          <h1>{id == null ? 'New quotation' : number || 'Quotation'}</h1>
          <p className="muted">{customerLabel || 'Choose a customer, then confirm to create the sales order.'}</p>
        </div>
        <div className="head-actions">
          {status && <Badge value={status} />}
          {canSend && <button className="btn" type="button" disabled={busy} onClick={send}>Send by Email</button>}
          {settings.proformaInvoice && (id != null || editable) && <button className="btn" type="button" disabled={busy} onClick={openProforma}>Pro-forma</button>}
          {showConfirm && <button className="btn btn-primary" type="button" disabled={busy} onClick={confirm}>{busy ? 'Working…' : actionLabel}</button>}
          {(id != null || editable) && <button className="btn" type="button" disabled={busy} onClick={preview}>Preview</button>}
          {canCancel && <button className="btn" type="button" disabled={busy} onClick={cancelQuote}>Cancel</button>}
          {editable && <button className="btn" type="button" disabled={busy} onClick={save}>Save</button>}
        </div>
      </header>
      {error && <ErrorBanner error={error} />}
      {!editable && status && status !== 'DRAFT' && (
        <div className="sale-banner">This quotation is {status.replace(/_/g, ' ').toLowerCase()} and can no longer be edited.</div>
      )}
      {warning && (
        <div className="sale-banner">
          {customerStatus === 'BLOCKED' || customerStatus === 'INACTIVE'
            ? `This customer is ${customerStatus.toLowerCase()}.`
            : `This quotation is above the customer credit limit of ${fmtMoney(creditLimit)}.`}
          {' '}Saving still follows the customer credit check.
        </div>
      )}
      <section className="card card-pad">
        <div className="form-grid">
          <div className="field field-required">
            <label>Customer</label>
            <LookupField
              endpoint="/api/ops/sales/customers"
              valueLabel={customerLabel}
              disabled={!editable}
              onPick={applyCustomer}
            />
          </div>
          <label className="field">
            <span>Invoice address</span>
            <textarea value={invoiceAddress} disabled={!editable} onChange={(e) => { setInvoiceAddress(e.target.value); mark(); }} />
          </label>
          <label className="field">
            <span>Delivery address</span>
            <textarea value={deliveryAddress} disabled={!editable} onChange={(e) => { setDeliveryAddress(e.target.value); mark(); }} />
          </label>
          <label className="field">
            <span>Quotation date</span>
            <input type="date" value={quotationDate} disabled={!editable} onChange={(e) => { setQuotationDate(e.target.value); mark(); }} />
          </label>
          <label className="field">
            <span>Expiration</span>
            <input type="date" value={validUntil} disabled={!editable} onChange={(e) => { setValidUntil(e.target.value); mark(); }} />
          </label>
          <label className="field">
            <span>Pricelist</span>
            <select value={priceListId} disabled={!editable} onChange={(e) => { setPriceListId(e.target.value ? Number(e.target.value) : ''); mark(); }}>
              <option value="">Customer price</option>
              {priceLists.map((list) => <option key={String(list.id)} value={String(list.id)}>{String(list.name)}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Payment terms (days)</span>
            <input type="number" min={0} value={paymentTermsDays} disabled={!editable} onChange={(e) => { setPaymentTermsDays(e.target.value === '' ? '' : Number(e.target.value)); mark(); }} />
          </label>
          <label className="field">
            <span>Quotation template</span>
            <select
              value={templateId}
              disabled={!editable}
              onChange={(e) => {
                const next = e.target.value ? Number(e.target.value) : '';
                setTemplateId(next);
                if (next !== '') applyTemplate(next).catch((err) => setError(err instanceof Error ? err.message : 'Could not apply the template'));
              }}
            >
              <option value="">None</option>
              {templates.filter((t) => t.active !== false).map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.name)}</option>)}
            </select>
          </label>
        </div>
      </section>

      <div className="tabs" role="tablist">
        {TABS.map((item) => (
          <button key={item.id} type="button" className={`tab${tab === item.id ? ' active' : ''}`} onClick={() => setTab(item.id)}>{item.label}</button>
        ))}
      </div>

      {tab === 'lines' && (
        <section className="card">
          <div className="card-head">
            <h3>Order Lines</h3>
            {editable && (
              <div className="mini-buttons">
                <button className="btn btn-sm" type="button" onClick={() => { setLines((prev) => [...prev, blankProduct(defaultTax)]); mark(); }}>Add a product</button>
                <button className="btn btn-sm" type="button" onClick={() => { setLines((prev) => [...prev, { ...blankProduct(defaultTax), lineKind: 'SECTION', quantity: 0, description: '' }]); mark(); }}>Add a section</button>
                <button className="btn btn-sm" type="button" onClick={() => { setLines((prev) => [...prev, { ...blankProduct(defaultTax), lineKind: 'NOTE', quantity: 0, description: '' }]); mark(); }}>Add a note</button>
              </div>
            )}
          </div>
          <div className="table-wrap">
            <table className="data sale-lines">
              <thead>
                <tr>
                  <th>Product</th>
                  <th className="cell-num">Quantity</th>
                  <th className="cell-num">Unit price</th>
                  {settings.discounts && <th className="cell-num">Disc %</th>}
                  <th>Tax</th>
                  <th className="cell-num">Amount</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {lines.map((line, index) => {
                  if (line.lineKind === 'SECTION') {
                    const sub = sectionUntaxed(lines, index);
                    return (
                      <tr key={line.key} className="sale-section">
                        <td colSpan={settings.discounts ? 5 : 4}>
                          <input value={line.description} disabled={!editable} placeholder="Section title" onChange={(e) => setLine(line.key, { description: e.target.value })} />
                        </td>
                        <td className="cell-num">{fmtMoney(sub)}</td>
                        <td>{editable && <button className="btn btn-sm" type="button" onClick={() => { setLines((prev) => prev.filter((row) => row.key !== line.key)); mark(); }}>Remove</button>}</td>
                      </tr>
                    );
                  }
                  if (line.lineKind === 'NOTE') {
                    return (
                      <tr key={line.key} className="sale-note">
                        <td colSpan={settings.discounts ? 6 : 5}>
                          <input value={line.description} disabled={!editable} placeholder="Note" onChange={(e) => setLine(line.key, { description: e.target.value })} />
                        </td>
                        <td>{editable && <button className="btn btn-sm" type="button" onClick={() => { setLines((prev) => prev.filter((row) => row.key !== line.key)); mark(); }}>Remove</button>}</td>
                      </tr>
                    );
                  }
                  const amount = quotationTotals([line]).total;
                  return (
                    <tr key={line.key}>
                      <td>
                        <LookupField
                          endpoint={customerId ? `/api/ops/sales/products?customerId=${customerId}` : '/api/ops/sales/products'}
                          valueLabel={line.description}
                          disabled={!editable}
                          placeholder="Search a product…"
                          onPick={(row) => pickProduct(line.key, row)}
                        />
                      </td>
                      <td><input className="cell-input" type="number" min={0} disabled={!editable} value={line.quantity} onChange={(e) => setLine(line.key, { quantity: num(e.target.value) })} /></td>
                      <td><input className="cell-input" type="number" min={0} disabled={!editable} value={line.unitPrice} onChange={(e) => setLine(line.key, { unitPrice: num(e.target.value) })} /></td>
                      {settings.discounts && (
                        <td><input className="cell-input" type="number" min={0} disabled={!editable} value={line.discountPercent} onChange={(e) => setLine(line.key, { discountPercent: num(e.target.value) })} /></td>
                      )}
                      <td>
                        <select className="cell-input" disabled={!editable} value={line.taxCategory} onChange={(e) => {
                          const code = e.target.value;
                          const rate = taxOptions.find((o) => o.code === code)?.rate ?? 0;
                          setLine(line.key, { taxCategory: code, taxPercent: rate });
                        }}>
                          {taxOptions.map((o) => <option key={o.code} value={o.code}>{o.name}{o.rate ? ` (${o.rate}%)` : ''}</option>)}
                          {!taxOptions.some((o) => o.code === line.taxCategory) && <option value={line.taxCategory}>{line.taxCategory}</option>}
                        </select>
                      </td>
                      <td className="cell-num">{fmtMoney(amount)}</td>
                      <td>{editable && <button className="btn btn-sm" type="button" onClick={() => { setLines((prev) => prev.filter((row) => row.key !== line.key)); mark(); }}>Remove</button>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="sale-totals">
            <div><span>Untaxed</span><strong>{fmtMoney(totals.untaxed)}</strong></div>
            <div><span>Tax</span><strong>{fmtMoney(totals.tax)}</strong></div>
            <div><span>Total</span><strong>{fmtMoney(totals.total)}</strong></div>
            {settings.showMargins && <div><span>Margin</span><strong>{fmtMoney(totals.margin)}</strong></div>}
            <div><span>Shipping weight</span><strong>{fmtNum(totals.weight)}</strong></div>
          </div>
        </section>
      )}

      {tab === 'optional' && (
        <section className="card">
          <div className="card-head">
            <h3>Optional Products</h3>
            {editable && <button className="btn btn-sm" type="button" onClick={() => { setOptionals((prev) => [...prev, blankOptional()]); mark(); }}>Add a product</button>}
          </div>
          <p className="muted" style={{ padding: '0 16px' }}>These products are offered with the quotation. Confirming copies them onto the sales order for Orders to Upsell.</p>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Product</th><th className="cell-num">Quantity</th><th className="cell-num">Unit price</th><th /><th /></tr></thead>
              <tbody>
                {optionals.map((row) => (
                  <tr key={row.key}>
                    <td>
                      <LookupField
                        endpoint={customerId ? `/api/ops/sales/products?customerId=${customerId}` : '/api/ops/sales/products'}
                        valueLabel={row.description}
                        disabled={!editable}
                        onPick={(product) => {
                          const productId = num(product.id);
                          setOptionals((prev) => prev.map((item) => item.key === row.key ? {
                            ...item,
                            productId,
                            description: String(pick(product, 'name') ?? ''),
                            unitPrice: listPrices[productId] != null ? listPrices[productId] : num(pick(product, 'listPrice', 'standardPrice', 'standard_price')),
                          } : item));
                          mark();
                        }}
                      />
                    </td>
                    <td><input className="cell-input" type="number" min={0} disabled={!editable} value={row.quantity} onChange={(e) => { setOptionals((prev) => prev.map((item) => item.key === row.key ? { ...item, quantity: num(e.target.value) } : item)); mark(); }} /></td>
                    <td><input className="cell-input" type="number" min={0} disabled={!editable} value={row.unitPrice} onChange={(e) => { setOptionals((prev) => prev.map((item) => item.key === row.key ? { ...item, unitPrice: num(e.target.value) } : item)); mark(); }} /></td>
                    <td>
                      {editable && (
                        <button className="btn btn-sm" type="button" onClick={() => {
                          if (row.productId === '') return;
                          setLines((prev) => [...prev, {
                            ...blankProduct(defaultTax),
                            productId: row.productId,
                            description: row.description,
                            quantity: row.quantity,
                            unitPrice: row.unitPrice,
                          }]);
                          setOptionals((prev) => prev.filter((item) => item.key !== row.key));
                          mark();
                        }}>Add to order</button>
                      )}
                    </td>
                    <td>{editable && <button className="btn btn-sm" type="button" onClick={() => { setOptionals((prev) => prev.filter((item) => item.key !== row.key)); mark(); }}>Remove</button>}</td>
                  </tr>
                ))}
                {optionals.length === 0 && <tr><td colSpan={5} style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>No optional products</td></tr>}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {tab === 'other' && (
        <section className="card card-pad">
          <div className="form-grid">
            <label className="field">
              <span>Salesperson</span>
              <select value={salespersonId} disabled={!editable} onChange={(e) => { setSalespersonId(e.target.value ? Number(e.target.value) : ''); mark(); }}>
                <option value="">None</option>
                {people.map((p) => <option key={p.id} value={p.id}>{personName(p)}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Sales team</span>
              <select value={salesTeamId} disabled={!editable} onChange={(e) => { setSalesTeamId(e.target.value ? Number(e.target.value) : ''); mark(); }}>
                <option value="">None</option>
                {teams.filter((t) => t.active !== false).map((t) => <option key={String(t.id)} value={String(t.id)}>{String(t.name)}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Customer reference</span>
              <input value={customerReference} disabled={!editable} onChange={(e) => { setCustomerReference(e.target.value); mark(); }} />
            </label>
            <label className="field">
              <span>Tags</span>
              <input value={tags} disabled={!editable} onChange={(e) => { setTags(e.target.value); mark(); }} />
            </label>
            <label className="field">
              <span>Shipping policy</span>
              <select value={shippingPolicy} disabled={!editable} onChange={(e) => { setShippingPolicy(e.target.value); mark(); }}>
                <option value="ASAP">{shippingPolicyLabel('ASAP')}</option>
                <option value="WHEN_ALL">{shippingPolicyLabel('WHEN_ALL')}</option>
              </select>
            </label>
            <label className="field">
              <span>Incoterm</span>
              <input value={incoterm} disabled={!editable} onChange={(e) => { setIncoterm(e.target.value); mark(); }} />
            </label>
            <label className="field">
              <span>Incoterm location</span>
              <input value={incotermLocation} disabled={!editable} onChange={(e) => { setIncotermLocation(e.target.value); mark(); }} />
            </label>
            <label className="field">
              <span>Delivery date</span>
              <input type="date" value={deliveryDate} disabled={!editable} onChange={(e) => { setDeliveryDate(e.target.value); mark(); }} />
            </label>
            <label className="field">
              <span>Source document</span>
              <input value={sourceDocument} disabled={!editable} onChange={(e) => { setSourceDocument(e.target.value); mark(); }} />
            </label>
            <label className="field">
              <span>Opportunity</span>
              <input type="number" min={0} value={opportunityId} disabled={!editable} onChange={(e) => { setOpportunityId(e.target.value ? Number(e.target.value) : ''); mark(); }} />
            </label>
            <label className="field">
              <span>Campaign</span>
              <input value={campaign} disabled={!editable} onChange={(e) => { setCampaign(e.target.value); mark(); }} />
            </label>
            <label className="field">
              <span>Medium</span>
              <input value={medium} disabled={!editable} onChange={(e) => { setMedium(e.target.value); mark(); }} />
            </label>
            <label className="field">
              <span>Source</span>
              <input value={source} disabled={!editable} onChange={(e) => { setSource(e.target.value); mark(); }} />
            </label>
            <label className="field">
              <span>Buyer type</span>
              <select value={buyerType} disabled={!editable} onChange={(e) => { setBuyerType(e.target.value); mark(); }}>
                <option value="">— Select —</option>
                <option value="B2B">B2B (Business)</option>
                <option value="B2C">B2C (Consumer)</option>
                <option value="B2G">B2G (Government)</option>
              </select>
            </label>
            <label className="field">
              <span>Currency</span>
              <input value={currency} disabled={!editable} onChange={(e) => { setCurrency(e.target.value.toUpperCase()); mark(); }} />
            </label>
          </div>
        </section>
      )}

      {tab === 'notes' && (
        <section className="card card-pad">
          <label className="field">
            <span>Notes</span>
            <textarea rows={4} value={notes} disabled={!editable} onChange={(e) => { setNotes(e.target.value); mark(); }} />
          </label>
          <label className="field">
            <span>Terms and conditions</span>
            <textarea rows={4} value={terms} disabled={!editable} onChange={(e) => { setTerms(e.target.value); mark(); }} />
          </label>
        </section>
      )}

      {orders.length > 0 && (
        <section className="card" style={{ marginTop: 14 }}>
          <div className="card-head"><h3>Sales orders</h3></div>
          <div className="related-list">
            {orders.map((order) => (
              <button key={String(order.id)} className="related-item" type="button" onClick={() => navigate(`/sales/orders/${order.id}`)}>
                <span className="cell-mono">{String(order.orderNo ?? order.id)}</span>
                <Badge value={order.status} />
                <span className="muted">{fmtMoney(order.total)}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

export function QuotationProforma({ id }: { id: number }) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [allowed, setAllowed] = useState(false);
  const [quote, setQuote] = useState<Rec | null>(null);
  const [lines, setLines] = useState<DraftLine[]>([]);

  useEffect(() => {
    Promise.all([
      api<{ data: SalesSettings }>('/api/ops/sales/settings').catch((e) => {
        if (e instanceof ApiError && e.status === 403) return { data: FALLBACK_SETTINGS };
        throw e;
      }),
      api<{ data: { quotation: Rec; items: Rec[] } }>(`/api/ops/sales/quotations/${id}`),
    ])
      .then(([settingsRes, quoteRes]) => {
        setAllowed(Boolean(settingsRes.data.proformaInvoice));
        setQuote(quoteRes.data.quotation);
        setLines((quoteRes.data.items ?? []).map(lineFromRow));
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Could not open the pro-forma'))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <PageLoader variant="page" label="Opening pro-forma…" />;
  if (error) return <ErrorBanner error={error} />;
  if (!allowed || !quote) {
    return (
      <div className="page">
        <header className="page-head">
          <div>
            <button className="btn btn-sm" type="button" onClick={() => navigate(`/sales/quotations/${id}`)}>Back</button>
            <h1>Pro-forma</h1>
          </div>
        </header>
        <div className="sale-banner">Pro-forma invoices are turned off in Sales settings.</div>
      </div>
    );
  }

  const totals = quotationTotals(lines);
  return (
    <div className="page">
      <header className="page-head">
        <div>
          <button className="btn btn-sm" type="button" onClick={() => navigate(`/sales/quotations/${id}`)}>Back</button>
          <h1>Pro-forma {String(quote.quotationNo ?? '')}</h1>
        </div>
        <button className="btn" type="button" onClick={() => window.print()}>Print</button>
      </header>
      <div className="sale-banner">This pro-forma is not a fiscal invoice and is not sent to EFRIS.</div>
      <article className="sale-proforma">
        <p className="mod-kicker" data-mod="sales">Pro-forma invoice</p>
        <h2 style={{ marginTop: 0 }}>{String(quote.customerName ?? '')}</h2>
        <p>{String(quote.invoiceAddress ?? quote.customerAddress ?? '')}</p>
        <p className="muted">Delivery: {String(quote.deliveryAddress ?? '—')}</p>
        <p className="muted">Quotation date {fmtDate(quote.quotationDate)} · Expiration {quote.validUntil ? fmtDate(quote.validUntil) : '—'}</p>
        <table className="data">
          <thead><tr><th>Description</th><th className="cell-num">Qty</th><th className="cell-num">Price</th><th className="cell-num">Amount</th></tr></thead>
          <tbody>
            {lines.map((line) => (
              <tr key={line.key} className={line.lineKind === 'SECTION' ? 'sale-section' : line.lineKind === 'NOTE' ? 'sale-note' : undefined}>
                <td>{line.description}</td>
                <td className="cell-num">{line.lineKind === 'PRODUCT' ? fmtNum(line.quantity) : ''}</td>
                <td className="cell-num">{line.lineKind === 'PRODUCT' ? fmtMoney(line.unitPrice) : ''}</td>
                <td className="cell-num">{line.lineKind === 'PRODUCT' ? fmtMoney(quotationTotals([line]).total) : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="sale-totals">
          <div><span>Untaxed</span><strong>{fmtMoney(totals.untaxed)}</strong></div>
          <div><span>Tax</span><strong>{fmtMoney(totals.tax)}</strong></div>
          <div><span>Total</span><strong>{fmtMoney(totals.total)}</strong></div>
        </div>
        {quote.notes ? <p>{String(quote.notes)}</p> : null}
        {quote.terms ? <p className="muted">{String(quote.terms)}</p> : null}
      </article>
    </div>
  );
}
