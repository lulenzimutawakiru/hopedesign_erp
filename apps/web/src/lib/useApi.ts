import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';

/**
 * Minimal data-fetching hook for server state.
 *
 * The URL string is the single source of truth: rebuild it from any filter/query
 * state and the effect re-fetches automatically. `reload` re-fires the current
 * request (for after-mutation refreshes). Safe against setState-after-unmount
 * via a per-request cancellation flag.
 */
export function useApi<T>(path: string | null): {
  data: T | null;
  loading: boolean;
  error: string;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState<boolean>(path != null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);

  const reload = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (path == null) {
      setData(null);
      setLoading(false);
      setError('');
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    setError('');
    api<T>(path)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [path, tick]);

  return { data, loading, error, reload };
}
