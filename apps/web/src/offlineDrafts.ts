/**
 * Client-side queue for Quick Stock Entry drafts created while offline.
 *
 * Drafts live in localStorage so a warehouse operator can keep recording on a
 * tablet with a dead connection, then sync once the network returns. Each entry
 * keeps the exact POST body it would have sent, including its idempotent
 * `clientToken`, so a sync that is retried after a partial success still cannot
 * double-post — the server's UNIQUE(tenant_id, client_token) guard is the source
 * of truth, and the client just replays the same body.
 */

export interface OfflineStockEntry {
  /** The draft's clientToken (stable idempotency key). */
  id: string;
  entryType: string;
  /** Short human summary, e.g. "RECEIPT · 3 lines". */
  summary: string;
  /** Exact request body to replay against POST /api/ops/inventory/entries. */
  payload: Record<string, unknown>;
  createdAt: number;
}

const KEY = 'hdg_offline_stock_entries';

export function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine;
}

export function listOfflineEntries(): OfflineStockEntry[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as OfflineStockEntry[]) : [];
  } catch {
    return [];
  }
}

function write(list: OfflineStockEntry[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Quota / private mode — best effort, never throw.
  }
}

export function queueOfflineEntry(entry: OfflineStockEntry): void {
  const next = listOfflineEntries().filter((e) => e.id !== entry.id);
  next.unshift(entry);
  write(next);
}

export function removeOfflineEntry(id: string): void {
  write(listOfflineEntries().filter((e) => e.id !== id));
}
