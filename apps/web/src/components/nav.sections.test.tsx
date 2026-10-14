import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { MeUser } from '../auth';
import { landingModule } from '../nav';
import { ModuleSections } from './ModuleSections';
import { Sidebar } from './nav';

const admin = { permissions: ['*'], roles: [], first_name: 'Ada' } as unknown as MeUser;

function sidebar(path: string) {
  return render(
    <Sidebar
      path={path}
      user={admin}
      collapsed={false}
      open={false}
      peek={false}
      onPeek={() => undefined}
      counts={{}}
      favorites={[]}
      recents={[]}
      onNavigate={() => undefined}
      onToggle={() => undefined}
    />
  );
}

describe('sidebar sections', () => {
  it('shows the finance sections on the finance dashboard', () => {
    window.location.hash = '#/finance';
    sidebar('/finance');
    expect(screen.getByRole('button', { name: 'Chart of Accounts' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'EFRIS' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Trial Balance' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Org Chart' })).not.toBeInTheDocument();
  });

  it('keeps other modules collapsed until their section list is opened', async () => {
    window.location.hash = '#/dashboard';
    sidebar('/dashboard');
    expect(screen.queryByRole('button', { name: 'Chart of Accounts' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Show Accounting sections' }));
    expect(screen.getByRole('button', { name: 'Chart of Accounts' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Petty Cash' })).not.toBeInTheDocument();
  });

  it('lists every finance section on the finance dashboard', () => {
    window.location.hash = '#/finance';
    const item = landingModule('/finance', admin);
    expect(item).toBeTruthy();
    render(<ModuleSections item={item!} />);
    const nav = screen.getByRole('navigation', { name: 'Accounting sections' });
    expect(nav).toBeInTheDocument();
    for (const label of ['Chart of Accounts', 'EFRIS', 'Trial Balance', 'Bank & Cash', 'Period Close', 'Audit Trail']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });
});
