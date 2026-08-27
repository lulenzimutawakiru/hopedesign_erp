export class ApiError extends Error {
  status: number;
  code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const TOKEN_KEY = 'hdg_token';
export const getToken = () => localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string) => localStorage.setItem(TOKEN_KEY, t);
export const clearToken = () => localStorage.removeItem(TOKEN_KEY);

interface ApiResponse<T = unknown> {
  data: T;
  [key: string]: unknown;
}

export async function api<T = ApiResponse>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
  const token = getToken();
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (init.body && !headers['Content-Type'] && !(init.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(path, { ...init, headers });
  if (res.status === 401 && !path.startsWith('/api/auth/')) {
    clearToken();
    if (location.hash !== '#/login') location.hash = '#/login';
    throw new ApiError('Session expired', 401, 'UNAUTHORIZED');
  }
  let body: any = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (!res.ok) {
    throw new ApiError(
      body?.error?.message ?? `Request failed (${res.status})`,
      res.status,
      body?.error?.code ?? 'ERROR'
    );
  }
  return body as T;
}

/** Fetch a branded document as a download or a print-friendly HTML window. */
export async function openDocument(
  type: string,
  id: unknown,
  format: 'pdf' | 'print',
  filename: string
): Promise<void> {
  const token = getToken();
  const res = await fetch('/api/documents/' + type + '/' + String(id) + '?format=' + format, {
    headers: token ? { Authorization: 'Bearer ' + token } : undefined,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg =
      body && body.error && body.error.message
        ? String(body.error.message)
        : (format === 'print' ? 'Print' : 'Download') + ' failed (' + res.status + ')';
    throw new Error(msg);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  if (format === 'print') {
    const win = window.open(url, '_blank');
    if (!win) {
      URL.revokeObjectURL(url);
      throw new Error('Popup blocked - allow popups for print.');
    }
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    return;
  }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename.endsWith('.pdf') ? filename : filename + '.pdf';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
}

export interface ListResult<T = Record<string, unknown>> {
  data: T[];
  pagination?: Pagination;
  count?: number;
}

export interface MetaColumn {
  name: string;
  camel: string;
  dataType: string;
  nullable: boolean;
  hasDefault: boolean;
  writable: boolean;
}

export interface EntityMeta {
  table: string;
  module: string;
  resource: string;
  label: string;
  entityType: string | null;
  codeColumn: string | null;
  statusColumn: string | null;
  searchable: string[];
  qrEntityType: string | null;
  columns: MetaColumn[];
  writable: string[];
}

export interface EntityBrief {
  module: string;
  resource: string;
  table: string;
  label: string;
  codeColumn: string | null;
  statusColumn: string | null;
  searchable: string[];
  hasCreate: boolean;
  hasView: boolean;
  hasUpdate: boolean;
  hasSubmit: boolean;
  hasApprove: boolean;
  hasDelete: boolean;
}

export const fmtMoney = (v: unknown) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-UG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

export const fmtNum = (v: unknown) => {
  const n = Number(v ?? 0);
  if (!Number.isFinite(n)) return '-';
  return n.toLocaleString('en-UG');
};

export const fmtDate = (v: unknown) => {
  if (!v) return '-';
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-UG');
};

export const fmtBool = (v: unknown) => (v ? 'Yes' : 'No');
