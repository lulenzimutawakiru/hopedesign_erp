import { lazy, Suspense, useEffect } from 'react';
import { useAuth } from './auth';
import { getToken } from './api';
import { shortCompanyName, useCompanyProfile } from './company';
import { useHashRoute } from './router';
import Login from './views/Login';
import ChangePassword from './views/ChangePassword';
import { BrandMark } from './components/BrandMark';
import { PageLoader } from './components/ui';

const Shell = lazy(() => import('./views/Shell'));
const PublicVerify = lazy(() => import('./views/PublicVerify'));
const AcceptInvite = lazy(() => import('./views/AcceptInvite'));
const ResetPassword = lazy(() => import('./views/ResetPassword'));
const SignPortal = lazy(() => import('./views/SignPortal'));

export default function App() {
  const { user, loading } = useAuth();
  const company = useCompanyProfile();
  const path = useHashRoute();

  useEffect(() => {
    document.title = company.name !== 'Company' ? `${shortCompanyName(company.name)} OS` : 'Natex Cloud';
  }, [company]);

  // Warm the Shell chunk in parallel with the /api/auth/me round-trip. The Shell
  // is the app core rendered as soon as the session restores, so lazy-loading it
  // only after /me resolves would serialize an extra network round-trip onto the
  // cold-start path. App effects run before the parent AuthProvider's effect, so
  // this fetch starts alongside (not after) the /me request. Dynamic imports
  // dedupe, so the lazy() below resolves instantly once the chunk is warm.
  useEffect(() => {
    if (getToken()) void import('./views/Shell');
  }, [user]);

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
        <BrandMark size="lg" logoUrl={company.logo_url} />
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

  // Public password reset - reached from the link mailed by /api/auth/password/forgot.
  if (path === '/reset') {
    return (
      <Suspense fallback={<PageLoader />}>
        <ResetPassword />
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

  // Public e-signature portal — reached from the link emailed to a signer.
  if (path.startsWith('/sign/')) {
    const signToken = path.slice('/sign/'.length);
    return (
      <Suspense fallback={<PageLoader />}>
        <SignPortal token={signToken} />
      </Suspense>
    );
  }

  if (!user) {
    return <Login />;
  }

  if (user.must_change_password) {
    return <ChangePassword />;
  }

  if (path === '/login') {
    window.location.hash = '/dashboard';
    return null;
  }

  return (
    <Suspense fallback={<PageLoader />}>
      <Shell />
    </Suspense>
  );
}
