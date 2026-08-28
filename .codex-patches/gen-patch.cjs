const fs = require('fs');
const WARN = '\u26A0'; // ⚠ used in the old alerts callout
const patch = `*** Begin Patch
*** Update File: apps/web/src/views/ContractFlow.tsx
@@
-  const alerts = (data.alerts as string[]) ?? [];
+  const alerts = (data.alerts as Array<Rec | string>) ?? [];
+  const alertMeta: Record<string, { href: string; icon: string; accent: string; tint: string }> = {
+    approval: { href: '/people/contracts/list?statuses=SUBMITTED,HR_REVIEW,MANAGER_REVIEW,FINANCE_REVIEW,LEGAL_REVIEW', icon: '\u26A0', accent: '#D97706', tint: 'rgba(217,119,6,0.12)' },
+    signature: { href: '/people/contracts/list?statuses=SENT_FOR_SIGNATURE,PARTIALLY_SIGNED', icon: '\u270D', accent: '#0284C7', tint: 'rgba(2,132,199,0.12)' },
+    expiry: { href: '/people/contracts/expiring', icon: '\u23F3', accent: '#DC2626', tint: 'rgba(220,38,38,0.12)' },
+    probation: { href: '/people/contracts/probation-ending', icon: '\u25CF', accent: '#16A34A', tint: 'rgba(22,163,74,0.12)' },
+    missing: { href: '/people/contracts/missing-particulars', icon: '!', accent: '#7C3AED', tint: 'rgba(124,58,237,0.12)' },
+  };
@@
-      {alerts.length > 0 && (
-        <section className="card card-pad" style={{ marginTop: 16 }}>
-          <div className="card-head"><h3>Alerts</h3></div>
-          <div className="stack" style={{ gap: 8 }}>
-            {alerts.map((a, i) => (
-              <div key={i} className="callout callout-warn" style={{ margin: 0, padding: '10px 14px' }}>
-                <span className="callout-icon" aria-hidden>${WARN}</span>
-                <div className="callout-body"><p style={{ margin: 0 }}>{a}</p></div>
-              </div>
-            ))}
-          </div>
-        </section>
-      )}
+      <section className="card card-pad" style={{ marginTop: 16 }}>
+        <div className="card-head">
+          <div>
+            <h3 style={{ margin: 0 }}>Action centre</h3>
+            <p className="muted" style={{ margin: '2px 0 0' }}>Work that needs your attention</p>
+          </div>
+        </div>
+        {alerts.length === 0 ? (
+          <p className="muted" style={{ margin: 0 }}>Nothing needs attention. New contract activity will appear here.</p>
+        ) : (
+          <div className="action-grid">
+            {alerts.map((a, i) => {
+              const rec = typeof a === 'string' ? { title: a, body: '', kind: '', count: 0 } : a;
+              const meta = alertMeta[String(rec.kind ?? '')] ?? alertMeta.expiry;
+              const title = String(rec.title ?? '');
+              const body = String(rec.body ?? '');
+              const count = Number(rec.count ?? 0);
+              return (
+                <button key={i} type="button" className="action-card" style={tileStyle(meta.accent, meta.tint)} onClick={() => navigate(meta.href)}>
+                  <span className="action-card-icon" aria-hidden>{String(rec.kind === 'signature' ? '\u270D' : meta.icon)}</span>
+                  <span className="action-card-body">
+                    <span className="action-card-title">{title || body}</span>
+                    {body && <span className="action-card-desc">{body}</span>}
+                  </span>
+                  {count > 0 && <span className="action-card-count" aria-label={count + ' items'}>{fmtNum(count)}</span>}
+                  <span className="action-card-go" aria-hidden>&#8594;</span>
+                </button>
+              );
+            })}
+          </div>
+        )}
+      </section>
*** End Patch
`;
fs.writeFileSync('.codex-patches/p.patch', patch, 'utf8');
