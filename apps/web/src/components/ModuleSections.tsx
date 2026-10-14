import { useHashRoute, navigate } from '../router';
import { bestChildHref, groupNavChildren, type NavItem } from '../nav';

/** Every permitted section of a module, grouped the same way as the sidebar. */
export function ModuleSections({ item }: { item: NavItem }) {
  const path = useHashRoute();
  const children = item.children ?? [];
  if (children.length === 0) return null;
  const groups = groupNavChildren(children);
  const labeled = groups.some((g) => g.group);
  const best = bestChildHref(children, path);
  return (
    <nav className="module-sections" aria-label={`${item.label} sections`}>
      {groups.map((g) => (
        <div key={g.group || 'all'} className="module-sections-group">
          {labeled && g.group ? <div className="module-sections-label">{g.group}</div> : null}
          <div className="spend-tabs">
            {g.items.map((c) => {
              const current = best === c.href;
              return (
                <button
                  key={`${c.id}-${c.href}`}
                  type="button"
                  className={'spend-tab' + (current ? ' is-on' : '')}
                  aria-current={current ? 'page' : undefined}
                  onClick={() => navigate(c.href)}
                >
                  {c.label}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </nav>
  );
}
