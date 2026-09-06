import { query } from '../db.js';

/** Runs outside the webhook request. The database function claims rows with
 * SKIP LOCKED, so multiple API replicas may safely run this worker. */
export async function processHikvisionEvents(limit = 50): Promise<number> {
  const result = await query<{ hikvision_process_events: number }>('SELECT hikvision_process_events($1)', [limit]);
  return Number(result.rows[0]?.hikvision_process_events ?? 0);
}
