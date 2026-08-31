import { lazy, Suspense, useEffect } from 'react';
import { useAuth } from './auth';
import { shortCompanyName, useCompanyProfile } from './company';
import { useHashRoute } from './router';
import Login from './views/Login';
import { BrandMark } from './components/BrandMark';
import { PageLoader } from './components/ui';

const Shell = lazy(() => import('./views/Shell'));
const PublicVerify = lazy(() => import('./views/PublicVerify'));
const AcceptInvite = lazy(() => import('./views/AcceptInvite'));

export default function App() {
  const { user, loading } = useAuth();
  const company = useCompanyProfile();
  const path = useHashRoute();

  useEffect(() => {
    document.title = company.name !== 'Company' ? `${shortCompanyName(company.name)} ERP` : 'Company ERP';
  }, [company]);

  useEffect(() => {
    const favicon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    const apple = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]');
    if (user && user.tenant_id) {
      const href = `/api/public/branding/favicon?tenant=${user.tenant_id}&company=${user.company_id ?? 0}&t=${Date.now()}`;
      const img = new Image();
      img.onload = () => {
        if (favicon) favicon.href = href;
        if (apple) apple.href = href;
      };
      img.onerror = () => {
        if (favicon) favicon.href = '/favicon.svg';
        if (apple) apple.href = '/logo.svg';
      };
      img.src = href;
    } else {
      if (favicon) favicon.href = '/favicon.svg';
      if (apple) apple.href = '/logo.svg';
    }
  }, [user]);

  if (loading) {
    return (
      <div className="center-box" style={{ flexDirection: 'column', gap: 12 }}>
        <BrandMark size="lg" />
        <div className="muted">Restoring named session…</div>
      </div>
    );
  }

  // Public authenticity portal — reachable without a session.
  // Public invitation acceptance - reachable without a session.
  if (path === '/invite') {
    return (
      <Suspense fallback={<PageLoader />}>
        <AcceptInvite />
      </Suspense>
    );
  }

  if (path === '/verify') {
    return (
      <Suspense fallback={<PageLoader />}>
        <PublicVerify />
      </Suspense>
    );
  }

  if (!user) {
    return path === '/login' ? <Login /> : <Login />;
  }

  if (path === '/login') {
    // Already authenticated; treat as dashboard.
    window.location.hash = '/dashboard';
    return null;
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <Shell />
    </Suspense>
  );
}
