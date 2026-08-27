import { createContext, useContext, useEffect, useState, ReactNode, useCallback } from 'react';
import { api, getToken, setToken, clearToken } from './api';

export interface MeUser {
  id: number;
  tenant_id: number;
  company_id: number | null;
  branch_id: number | null;
  department_id: number | null;
  division_id?: number | null;
  employee_id?: number | null;
  email: string;
  username: string | null;
  first_name: string;
  last_name: string;
  job_title: string | null;
  status: string;
  must_change_password: boolean;
  mfa_enabled: boolean;
  permissions: string[];
  activate_modules?: string[];
  roles: { role_id: number; role_code: string; company_id: number | null; branch_id: number | null }[];
  tenant_code?: string | null;
  tenant_name?: string | null;
  company_name?: string | null;
  company_code?: string | null;
  branch_name?: string | null;
  branch_code?: string | null;
  department_code?: string | null;
  department_name?: string | null;
  division_code?: string | null;
  division_name?: string | null;
  requester_code?: string | null;
  requester_name?: string | null;
  requesting_location_id?: number | null;
  requesting_location_code?: string | null;
  requesting_location_name?: string | null;
  requesting_location_address?: string | null;
  cost_centre_id?: number | null;
  cost_centre_code?: string | null;
  cost_centre_name?: string | null;
  project_id?: number | null;
  project_code?: string | null;
  project_name?: string | null;
  budget_id?: number | null;
  budget_code?: string | null;
  budget_amount?: number | null;
  budget_status?: string | null;
  fiscal_year_id?: number | null;
  fiscal_year_code?: string | null;
  fiscal_year_name?: string | null;
  fiscal_year_start?: string | null;
  fiscal_year_end?: string | null;
  fiscal_year_status?: string | null;
  request_date?: string | null;
  default_lead_days?: number | null;
  required_by_date?: string | null;
  default_priority?: string | null;
  default_procurement_category?: string | null;
  default_purpose?: string | null;
  default_business_justification?: string | null;
  default_delivery_location?: string | null;
  default_currency_code?: string | null;
  default_tax_code?: string | null;
  default_expected_total?: number | null;
  default_confidentiality_level?: string | null;
  default_emergency_purchase?: boolean | null;
  default_recurring_purchase?: boolean | null;
  default_company_id?: number | null;
  default_company_code?: string | null;
  default_company_name?: string | null;
  default_branch_id?: number | null;
  default_branch_code?: string | null;
  default_branch_name?: string | null;
  default_fiscal_year_id?: number | null;
  default_fiscal_year_code?: string | null;
  default_fiscal_year_name?: string | null;
}

interface AuthState {
  user: MeUser | null;
  loading: boolean;
  login: (identifier: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<MeUser | null>(null);
  const [loading, setLoading] = useState(true);

  const loadMe = useCallback(async () => {
    const r = await api<{ user: MeUser }>('/api/auth/me');
    setUser(r.user);
    return r.user;
  }, []);

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    loadMe()
      .catch(() => {
        clearToken();
        if (location.hash !== '#/login') location.hash = '#/login';
      })
      .finally(() => setLoading(false));
  }, [loadMe]);

  const login = async (identifier: string, password: string) => {
    const r = await api<{ accessToken: string; refreshToken: string; user: Partial<MeUser> }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ identifier, password }),
    });
    setToken(r.accessToken);
    await loadMe();
  };

  const logout = () => {
    clearToken();
    setUser(null);
    location.hash = '#/login';
  };

  return <AuthContext.Provider value={{ user, loading, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}

export function can(user: MeUser | null, permission: string): boolean {
  if (!user) return false;
  const perms = user.permissions;
  if (perms.includes('system.admin.all') || perms.includes('*')) return true;
  const [m, r] = permission.split('.');
  return (
    perms.includes(permission) ||
    perms.includes(`${m}.${r}.*`) ||
    perms.includes(`${m}.*`)
  );
}
