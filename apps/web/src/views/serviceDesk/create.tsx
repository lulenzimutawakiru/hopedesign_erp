import { useCallback, useEffect, useMemo, useState } from 'react';
import { navigate, useHashQuery } from '../../router';
import { can, useAuth } from '../../auth';
import { ErrorBanner, Spinner } from '../../components/ui';
import { Field, FormErr, Inp, Sel, Txa } from '../hikvision/fields';
import {
  PriorityChip,
  SdHead,
  SdTabs,
  SecCard,
  dash,
  label,
  modStyle,
  num,
  priorityMeta,
  s,
  sdApi,
  sdErr,
  sdPost,
  useSdMeta,
  type Rec,
} from '../serviceDeskShared';

const MY = '/api/my/service-desk';

interface Category extends Rec {
  id: number;
  name: string;
  code: string;
  subcategories?: Rec[];
}

interface PickedAsset {
  id: number;
  ref: string;
  name: string;
  status: string;
}

const MATRIX: Record<string, Record<string, string>> = {
  ENTERPRISE: { CRITICAL: 'P1', HIGH: 'P1', MEDIUM: 'P2', LOW: 'P3' },
  DEPARTMENT: { CRITICAL: 'P1', HIGH: 'P2', MEDIUM: 'P3', LOW: 'P4' },
  INDIVIDUAL: { CRITICAL: 'P2', HIGH: 'P3', MEDIUM: 'P3', LOW: 'P4' },
  MINOR: { CRITICAL: 'P3', HIGH: 'P4', MEDIUM: 'P4', LOW: 'P4' },
};

function deviceInfo(): Rec {
  try {
    const nav = navigator as Navigator & { deviceMemory?: number };
    return {
      userAgent: nav.userAgent,
      platform: nav.platform,
      language: nav.language,
      screen: String(window.screen?.width ?? '') + 'x' + String(window.screen?.height ?? ''),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      capturedAt: new Date().toISOString(),
    };
  } catch {
    return { capturedAt: new Date().toISOString() };
  }
}

function AssetPicker({
  value,
  onChange,
  options,
  canLookup,
}: {
  value: PickedAsset | null;
  onChange: (a: PickedAsset | null) => void;
  options: Rec[];
  canLookup: boolean;
}) {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const lookup = async () => {
    const ref = code.trim();
    if (!ref) return;
    setBusy(true);
    setErr('');
    try {
      const res = await sdApi<{ asset?: Rec }>('/api/service-desk/assets/' + encodeURIComponent(ref));
      const a = res?.asset ?? (res as unknown as Rec);
      const id = num(a?.id);
      if (!id) throw new Error('Asset not recognised');
      onChange({
        id,
        ref: s(a.asset_no ?? a.code ?? ref),
        name: s(a.name ?? a.description),
        status: s(a.status ?? a.asset_status),
      });
      setCode('');
    } catch (e) {
      setErr(sdErr(e));
    } finally {
      setBusy(false);
    }
  };

  if (value) {
    return (
      <div className="sd-asset-picked">
        <div>
          <b className="td-cell-mono">{value.ref}</b>
          <span>{dash(value.name)}</span>
          <span className="muted">Status {dash(value.status)}</span>
        </div>
        <button type="button" className="btn btn-sm" onClick={() => onChange(null)}>Remove</button>
      </div>
    );
  }

  return (
    <div className="sd-asset-pick">
      {canLookup ? (
        <div className="sd-asset-lookup">
          <Inp value={code} onChange={setCode} placeholder="Scan or type an asset number, e.g. HDG-ASSET-2026-000245 or FSS104" />
          <button type="button" className="btn" onClick={() => void lookup()} disabled={busy || !code.trim()}>
            {busy ? <Spinner /> : 'Look up'}
          </button>
        </div>
      ) : null}
      {options.length > 0 && (
        <Sel
          value=""
          onChange={(id) => {
            const found = options.find((o) => s(o.id) === id);
            if (!found) return;
            onChange({
              id: num(found.id),
              ref: s(found.asset_no ?? found.code),
              name: s(found.name ?? found.description),
              status: s(found.status ?? found.asset_status),
            });
          }}
          options={options.map((o) => ({
            value: s(o.id),
            label: s(o.asset_no ?? o.code) + ' - ' + (s(o.name ?? o.description) || 'Asset'),
          }))}
          placeholder="Select equipment assigned to you"
        />
      )}
      {!canLookup && options.length === 0 && (
        <p className="muted" style={{ margin: 0 }}>
          No equipment is registered to you. Scan the asset QR tag from the Asset Scan tab to raise a
          ticket against a specific machine.
        </p>
      )}
      {err && <p className="sd-inline-err">{err}</p>}
    </div>
  );
}

export default function CreateRequest({ initialAssetId }: { initialAssetId?: number | null }) {
  const { user } = useAuth();
  const { meta } = useSdMeta();
  const query = useHashQuery();

  const [cats, setCats] = useState<Category[] | null>(null);
  const [myAssets, setMyAssets] = useState<Rec[]>([]);
  const [catErr, setCatErr] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [files, setFiles] = useState<File[]>([]);

  const [ticketType, setTicketType] = useState('SERVICE_REQUEST');
  const [categoryId, setCategoryId] = useState('');
  const [subcategoryId, setSubcategoryId] = useState('');
  const [subject, setSubject] = useState('');
  const [description, setDescription] = useState('');
  const [impact, setImpact] = useState('INDIVIDUAL');
  const [urgency, setUrgency] = useState('MEDIUM');
  const [classification, setClassification] = useState('INTERNAL');
  const [preferredContact, setPreferredContact] = useState('PORTAL');
  const [priorityOverride, setPriorityOverride] = useState('');
  const [overrideReason, setOverrideReason] = useState('');
  const [asset, setAsset] = useState<PickedAsset | null>(null);
  const [prefillDone, setPrefillDone] = useState(false);

  const userName = ((s(user?.first_name) + ' ' + s(user?.last_name)).trim()) || s(user?.username) || 'You';
  const mayOverride = can(user, 'service_desk.tickets.assign');
  const mayLookupAsset = can(user, 'service_desk.assets.view');

  const load = useCallback(async () => {
    try {
      const list = await sdApi<Category[]>(MY + '/categories');
      setCats(Array.isArray(list) ? list : []);
    } catch (e) {
      setCatErr(e);
    }
    try {
      const sum = await sdApi<{ myAssets?: Rec[] }>(MY + '/summary');
      setMyAssets(Array.isArray(sum?.myAssets) ? sum.myAssets : []);
    } catch {
      setMyAssets([]);
    }
  }, []);

  useEffect(() => void load(), [load]);

  const qAssetId = num(query.get('assetId'));
  const qCode = s(query.get('code'));

  useEffect(() => {
    if (prefillDone) return;
    const wanted = initialAssetId ?? (qAssetId || null);
    const pool = [...myAssets];
    if (wanted) {
      const found = pool.find((a) => num(a.id) === wanted);
      if (found) {
        setAsset({
          id: wanted,
          ref: s(found.asset_no ?? found.code),
          name: s(found.name ?? found.description),
          status: s(found.status ?? found.asset_status),
        });
        setPrefillDone(true);
        return;
      }
    }
    if (qCode) {
      const found = pool.find((a) => s(a.asset_no ?? a.code) === qCode);
      if (found) {
        setAsset({
          id: num(found.id),
          ref: qCode,
          name: s(found.name ?? found.description),
          status: s(found.status ?? found.asset_status),
        });
        setPrefillDone(true);
        return;
      }
      if (mayLookupAsset) {
        sdApi<{ asset?: Rec }>('/api/service-desk/assets/' + encodeURIComponent(qCode))
          .then((res) => {
            const a = res?.asset ?? (res as unknown as Rec);
            if (num(a?.id)) {
              setAsset({
                id: num(a.id),
                ref: s(a.asset_no ?? a.code ?? qCode),
                name: s(a.name ?? a.description),
                status: s(a.status ?? a.asset_status),
              });
            }
          })
          .catch(() => undefined);
      }
    }
    if (wanted || qCode) setPrefillDone(true);
  }, [myAssets, qAssetId, qCode, initialAssetId, prefillDone, mayLookupAsset]);
  const activeCat = useMemo(
    () => (cats ?? []).find((c) => s(c.id) === categoryId) ?? null,
    [cats, categoryId]
  );
  const subcats = activeCat?.subcategories ?? [];
  const activeSub = subcats.find((x) => s(x.id) === subcategoryId) ?? null;
  const requiresAsset = Boolean(activeSub?.requires_asset);
  const matrixPriority = (MATRIX[impact] ?? MATRIX.INDIVIDUAL)[urgency] ?? 'P3';
  const effectivePriority = priorityOverride || matrixPriority;
  const overridden = Boolean(priorityOverride) && priorityOverride !== matrixPriority;

  const submit = async () => {
    setError('');
    if (!categoryId) return setError('Select a category - it routes your request to the right queue.');
    if (!subcategoryId) return setError('Select a subcategory so the right specialist picks it up.');
    if (subject.trim().length < 4) return setError('Give the request a short, clear subject.');
    if (description.trim().length < 10) return setError('Describe the problem or request in a little more detail.');
    if (requiresAsset && !asset) return setError('This request type requires an affected asset. Scan or select one.');
    if (overridden && !overrideReason.trim()) return setError('A priority override needs a written reason for the audit trail.');

    setBusy(true);
    try {
      const payload: Rec = {
        ticketType,
        categoryId: num(categoryId),
        subcategoryId: num(subcategoryId),
        subject: subject.trim(),
        description: description.trim(),
        impact,
        urgency,
        dataClassification: classification,
        preferredContact,
        deviceInfo: deviceInfo(),
      };
      if (asset) payload.affectedAssetId = asset.id;
      if (overridden) {
        payload.priority = priorityOverride;
        payload.priorityOverrideReason = overrideReason.trim();
      }
      const res = await sdPost<Rec>(MY + '/tickets', payload);
      const created = (res?.ticket ?? res) as Rec;
      const id = num(created?.id ?? res?.id);

      if (id && files.length > 0) {
        for (const f of files) {
          try {
            const fd = new FormData();
            fd.append('file', f);
            await sdApi(MY + '/tickets/' + id + '/attachments', { method: 'POST', body: fd });
          } catch {
            /* the ticket exists; an attachment failure must not lose it */
          }
        }
      }
      navigate(id ? '/service-desk/t/' + id : '/service-desk');
    } catch (e) {
      setError(sdErr(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page sd-create" style={modStyle()}>
      <SdHead
        title="Create Service Request"
        sub="Describe what is broken or what you need. The request is logged against your employee record and routed automatically; you cannot raise a request on behalf of anybody else."
        actions={
          <>
            <button className="btn" onClick={() => navigate('/service-desk')}>Cancel</button>
            <button className="btn" onClick={() => navigate('/service-desk/knowledge')}>Search knowledge</button>
          </>
        }
      />
      <SdTabs active="portal" />
      {catErr ? <ErrorBanner error={catErr} /> : null}

      <div className="sd-create-grid">
        <SecCard title="What do you need?" sub="Required fields are marked with an asterisk">
          <div className="sd-form">
            <Field label="Request type" req>
              <Sel
                value={ticketType}
                onChange={setTicketType}
                options={(meta?.ticketTypes ?? ['INCIDENT', 'SERVICE_REQUEST']).map((t) => ({ value: t, label: label(t) }))}
              />
            </Field>

            <div className="sd-form-row">
              <Field label="Category" req>
                <Sel
                  value={categoryId}
                  onChange={(v) => { setCategoryId(v); setSubcategoryId(''); }}
                  options={(cats ?? []).map((c) => ({ value: s(c.id), label: s(c.name) }))}
                  placeholder={cats ? 'Select a category' : 'Loading categories'}
                />
              </Field>
              <Field label="Subcategory" req hint={activeCat ? dash(activeCat.name) : undefined}>
                <Sel
                  value={subcategoryId}
                  onChange={setSubcategoryId}
                  options={subcats.map((x) => ({ value: s(x.id), label: s(x.name) }))}
                  placeholder={activeCat ? 'Select a subcategory' : 'Choose a category first'}
                />
              </Field>
            </div>

            <Field label="Subject" req hint="One line - what is the problem?">
              <Inp value={subject} onChange={setSubject} maxLength={200} placeholder="Internet connection down in the Kampala sales office" />
            </Field>

            <Field label="Description" req hint="What happened, when it started, who is affected, what you have already tried.">
              <Txa value={description} onChange={setDescription} rows={6} />
            </Field>

            <div className="sd-form-row">
              <Field label="Impact" req hint="How much of the business is affected">
                <Sel
                  value={impact}
                  onChange={setImpact}
                  options={(meta?.impacts ?? ['ENTERPRISE', 'DEPARTMENT', 'INDIVIDUAL', 'MINOR']).map((v) => ({ value: v, label: label(v) }))}
                />
              </Field>
              <Field label="Urgency" req hint="How quickly it must be dealt with">
                <Sel
                  value={urgency}
                  onChange={setUrgency}
                  options={(meta?.urgencies ?? ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).map((v) => ({ value: v, label: label(v) }))}
                />
              </Field>
            </div>

            <div className="sd-prio-preview">
              <span className="muted">Calculated priority from impact and urgency</span>
              <PriorityChip value={effectivePriority} />
              {overridden && <span className="sd-prio-override">Manually overridden</span>}
            </div>

            {mayOverride && (
              <div className="sd-form-row">
                <Field label="Priority override" hint="Only honoured with the assignment privilege. Audited.">
                  <Sel
                    value={priorityOverride}
                    onChange={setPriorityOverride}
                    options={[{ value: '', label: 'Use the calculated priority' }].concat(
                      (meta?.priorities ?? ['P1', 'P2', 'P3', 'P4']).map((p) => ({
                        value: p,
                        label: p + ' - ' + priorityMeta(p).label,
                      }))
                    )}
                  />
                </Field>
                {overridden && (
                  <Field label="Override reason" req>
                    <Inp value={overrideReason} onChange={setOverrideReason} placeholder="Approved by operations manager during outage" />
                  </Field>
                )}
              </div>
            )}

            <div className="sd-form-row">
              <Field label="Preferred contact method">
                <Sel
                  value={preferredContact}
                  onChange={setPreferredContact}
                  options={(meta?.contactMethods ?? ['PORTAL', 'EMAIL', 'PHONE', 'SMS', 'WHATSAPP', 'IN_PERSON']).map((v) => ({ value: v, label: label(v) }))}
                />
              </Field>
              <Field label="Data classification" hint="Restricted or confidential requests are visible only to authorised staff.">
                <Sel
                  value={classification}
                  onChange={setClassification}
                  options={(meta?.classifications ?? ['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED']).map((v) => ({ value: v, label: label(v) }))}
                />
              </Field>
            </div>
          </div>
        </SecCard>
        <div className="sd-create-side">
          <SecCard
            title="Affected asset"
            sub="Optional unless the request type requires it"
            actions={
              <button className="btn btn-sm" onClick={() => navigate('/service-desk/scan')}>
                Scan QR
              </button>
            }
            pad
          >
            <AssetPicker value={asset} onChange={setAsset} options={myAssets} canLookup={mayLookupAsset} />
            {requiresAsset && !asset && (
              <p className="sd-inline-err">This request type requires an affected asset.</p>
            )}
          </SecCard>

          <SecCard title="Attachments" sub="Photos or screenshots help us diagnose faster" pad>
            <input
              type="file"
              multiple
              className="sd-file-input"
              onChange={(e) => setFiles(Array.from(e.target.files ?? []))}
            />
            {files.length > 0 && (
              <ul className="sd-attach-pending">
                {files.map((f) => (
                  <li key={f.name}>
                    <span>{f.name}</span>
                    <span className="muted">{Math.max(1, Math.round(f.size / 1024))} KB</span>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted" style={{ margin: '8px 0 0', fontSize: 12 }}>
              Up to 10 MB per file. Files upload after the ticket is created.
            </p>
          </SecCard>

          <SecCard title="Captured automatically" sub="You cannot edit these - they come from your session" pad>
            <dl className="sd-auto">
              <div><dt>Requester</dt><dd>{userName}</dd></div>
              <div><dt>Employee</dt><dd className="td-cell-mono">{dash(user?.employee_id)}</dd></div>
              <div><dt>Company</dt><dd>{dash(user?.company_name)}</dd></div>
              <div><dt>Branch</dt><dd>{dash(user?.branch_name)}</dd></div>
              <div><dt>Raised at</dt><dd>{new Date().toLocaleString()}</dd></div>
              <div><dt>Source</dt><dd>Portal</dd></div>
            </dl>
          </SecCard>

          <div className="sd-create-submit">
            <FormErr msg={error} />
            <button className="btn btn-primary sd-primary sd-submit" onClick={() => void submit()} disabled={busy}>
              {busy ? <Spinner /> : 'Submit Request'}
            </button>
            <p className="muted" style={{ margin: 0, fontSize: 12 }}>
              Submitting writes an audit record and starts the SLA response timer.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
