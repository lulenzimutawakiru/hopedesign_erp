import { BrandMark, BrandWordmark, hasBrandAsset } from './BrandMark';
import { Breadcrumbs, ScopeChip, UserMenu } from './nav';
import { CreateMenu } from './os';
import NotificationsBell from '../views/NotificationsBell';
import { navigate } from '../router';
import type { MeUser } from '../auth';
import type { Prefs } from '../prefs';
import type { CompanyProfile } from '../company';

/**
 * Single global utility header for the ERP shell.
 *
 * Owns exactly one 56px row: global search, breadcrumb page-context and the
 * high-level utility actions (scan, create, tasks, notifications, session
 * scope, profile). Module and sub-module navigation live exclusively in the
 * Sidebar - this bar never renders a secondary navigation strip.
 */
export default function TopHeader({
  path,
  user,
  approvalCount,
  compact,
  focus,
  company,
  brandCompany,
  prefs,
  onOpenSidebar,
  onOpenSearch,
  onOpenScanner,
  onOpenHelp,
  onToggleFocus,
  onPin,
  onLogout,
}: {
  path: string;
  user: MeUser | null;
  approvalCount: number;
  compact: boolean;
  focus: boolean;
  company: CompanyProfile;
  brandCompany: { name: string; code?: string | null };
  prefs: Prefs;
  onOpenSidebar: () => void;
  onOpenSearch: () => void;
  onOpenScanner: () => void;
  onOpenHelp: () => void;
  onToggleFocus: () => void;
  onPin: () => void;
  onLogout: () => void;
}) {
  return (
    <header className="topbar">
      <div className="topbar-row">
        {compact && !focus && (
          <button
            className="icon-btn menu-btn"
            type="button"
            onClick={onOpenSidebar}
            aria-label="Open navigation"
          >
            &#9776;
          </button>
        )}
        {focus && (
          <button className="icon-btn" type="button" onClick={() => history.back()} aria-label="Back">
            &#8592;
          </button>
        )}
        {compact && hasBrandAsset(company.logo_url) && (
          <button
            className="topbar-brand"
            type="button"
            onClick={() => navigate('/dashboard')}
            aria-label={`${brandCompany.name} dashboard`}
          >
            <BrandMark size="sm" logoUrl={company.logo_url} />
          </button>
        )}

        <button
          className="cmd-open"
          type="button"
          onClick={onOpenSearch}
          aria-keyshortcuts="Control+K"
        >
          <span>Search or type a command&hellip;</span>
          <kbd>Ctrl K</kbd>
        </button>

        <div className="topbar-crumbs">
          <Breadcrumbs path={path} />
        </div>

        <BrandWordmark
          size="md"
          className="topbar-brand-alt hide-phone"
          logoUrl={company.secondary_logo_url}
          title={`${brandCompany.name} logo`}
        />

        <div className="topbar-actions">
          <button className="btn btn-sm btn-scan hide-phone" type="button" onClick={onOpenScanner}>
            Scan QR
          </button>
          <span className="hide-phone"><CreateMenu /></span>
          <button className="btn btn-sm hide-phone" type="button" onClick={() => navigate('/inbox')}>
            Tasks {approvalCount > 0 && <span className="count-badge">{approvalCount}</span>}
          </button>
          <NotificationsBell />
          <ScopeChip user={user} />
          <UserMenu
            user={user}
            prefsLabel={`${prefs.theme} · ${prefs.density}`}
            focusMode={prefs.focusMode}
            onHelp={onOpenHelp}
            onFocus={onToggleFocus}
            onPin={onPin}
            onLogout={onLogout}
          />
        </div>
      </div>
    </header>
  );
}
