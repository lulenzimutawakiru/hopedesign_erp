import { useCallback, useEffect, useState } from 'react';
import { api } from '../../api';
import { useAuth, can } from '../../auth';
import { ErrorBanner } from '../../components/ui';
import { SpendShell, num, s, type Rec } from './kit';

/**
 * Expenditure posting configuration. The five GL accounts here were formerly
 * hardcoded inside the backend; they now resolve from `app_settings` (category
 * `expenditure`) and can be pointed at any real chart-of-accounts code. Every
 * save is validated server-side and written to the configuration audit trail.
 */
export default function ExpensePolicies() {
  const { user } = useAuth();
  const [settings, setSettings] = useState<Rec | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

  const load = useCallback(() => {
    api<{ data: Rec }>('/api/ops/expenditure/settings')
      .then((r) => setSettings(r.data))
      .catch((e) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  const mayEdit = can(user, 'expenditure.settings.update');
  const patch = (key: string, value: unknown) => setSettings((s) => ({ ...(s ?? {}), [key]: value }));

  const save = async () => {
    if (!settings) return;
    setBusy(true);
    setMsg('');
    setError('');
    try {
      await api('/api/ops/expenditure/settings', {
        method: 'POST',
        body: JSON.stringify({
          expenseAccountCode: s(settings.expenseAccountCode),
          expensePayableAccountCode: s(settings.expensePayableAccountCode),
          bankClearingAccountCode: s(settings.bankClearingAccountCode),
          reimbursementPayableAccountCode: s(settings.reimbursementPayableAccountCode),
          inputVatAccountCode: s(settings.inputVatAccountCode),
          approvalLimitAmount: num(settings.approvalLimitAmount),
          allowOverBudget: settings.allowOverBudget === true,
          reimburseInPayslip: settings.reimburseInPayslip === true,
        }),
      });
      setMsg('Policies saved.');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const accounts: Array<{ key: string; label: string; hint: string }> = [
    { key: 'expenseAccountCode', label: 'Default expense GL account', hint: 'Debit side when an expense has no category or account override.' },
    { key: 'expensePayableAccountCode', label: 'Accounts payable (expense)', hint: 'Credit side for approved-but-unpaid expenses and credit terms.' },
    { key: 'bankClearingAccountCode', label: 'Bank / card clearing', hint: 'Credit side for bank, card and direct-supplier settlement.' },
    { key: 'reimbursementPayableAccountCode', label: 'Reimbursement / petty cash', hint: 'Credit side for mobile, petty cash and employee reimbursements.' },
    { key: 'inputVatAccountCode', label: 'Input VAT account', hint: 'Debited for the tax portion of an expense when present.' },
  ];

  return (
    <SpendShell
      title="Settings"
      blurb="Default expense accounts, approval limit, payslip reimbursement and posting policy for the Expenses app."
      active="policies"
    >
      {!can(user, 'expenditure.settings.view') ? (
        <p className="empty-state">You don&apos;t have permission to view expenditure policies.</p>
      ) : (
        <>
          {error && <ErrorBanner error={error} />}
          {msg && <div className="notice-banner">{msg}</div>}
          {!settings ? (
            <p className="empty-state">Loading policies…</p>
          ) : (
            <>
              <section className="card">
                <div className="card-head"><h3>Posting accounts</h3></div>
                <div className="form-grid">
                  {accounts.map((f) => (
                    <label className="field" key={f.key}>
                      <span>{f.label}</span>
                      <input value={s(settings[f.key])} disabled={!mayEdit} onChange={(e) => patch(f.key, e.target.value)} />
                      <span className="field-hint">{f.hint}</span>
                    </label>
                  ))}
                </div>
              </section>
              <section className="card">
                <div className="card-head"><h3>Approval policy</h3></div>
                <div className="form-grid">
                  <label className="field">
                    <span>Approval limit amount</span>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={num(settings.approvalLimitAmount)}
                      disabled={!mayEdit}
                      onChange={(e) => patch('approvalLimitAmount', e.target.value === '' ? 0 : Number(e.target.value))}
                    />
                    <span className="field-hint">0 means no automatic limit is applied.</span>
                  </label>
                  <label className="field">
                    <span>Allow over budget</span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 38 }}>
                      <input type="checkbox" checked={settings.allowOverBudget === true} disabled={!mayEdit} onChange={(e) => patch('allowOverBudget', e.target.checked)} />
                      <span className="muted">{settings.allowOverBudget === true ? 'Enabled' : 'Disabled'}</span>
                    </div>
                  </label>
                </div>
              </section>
              <section className="card">
                <div className="card-head"><h3>Reimbursement</h3></div>
                <div className="form-grid">
                  <label className="field">
                    <span>Reimburse in payslip</span>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', minHeight: 38 }}>
                      <input type="checkbox" checked={settings.reimburseInPayslip === true} disabled={!mayEdit} onChange={(e) => patch('reimburseInPayslip', e.target.checked)} />
                      <span className="muted">{settings.reimburseInPayslip === true ? 'Enabled' : 'Disabled'}</span>
                    </div>
                    <span className="field-hint">Approved or posted expenses paid by the employee can be flagged for the next payslip. The flag does not create a payroll payment. Cash, cheque and bank transfer still use Register Payment after the expense is posted.</span>
                  </label>
                </div>
              </section>
              {mayEdit && (
                <div className="spend-dock">
                  <div className="spend-dock-meta">Posting configuration is validated and audited on save.</div>
                  <div className="head-actions">
                    <button className="btn btn-primary" disabled={busy} onClick={save}>
                      {busy ? 'Saving…' : 'Save policies'}
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </>
      )}
    </SpendShell>
  );
}
