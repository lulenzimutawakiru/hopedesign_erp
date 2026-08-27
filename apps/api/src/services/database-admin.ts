import pg from 'pg';
import { Ctx } from '../db.js';
import { logAudit } from './audit.js';
import { badRequest, notFound, toCamelRow, toCamelRows } from '../utils.js';

const DB_RESOURCE = 'database';

export function classifyTable(name: string): string {
  const n = name.toLowerCase();
  if (/payroll|salary|national_id|employee/.test(n)) return 'RESTRICTED';
  if (/security_print|qr_|secret|credential|api_key/.test(n)) return 'HIGHLY_RESTRICTED';
  if (/journal|ledger|finance|bank|cash|invoice|tax|asset|budget|efris|payment|receipt|gl_|cost/.test(n)) return 'CONFIDENTIAL';
  if (/customer|supplier|contract|lead|order/.test(n)) return 'CONFIDENTIAL';
  return 'INTERNAL';
}

async function settingsMap(client: pg.PoolClient, tenantId: number | null | undefined): Promise<Record<string, unknown>> {
  if (!tenantId) return {};
  const r = await client.query('SELECT key, value FROM db_settings WHERE tenant_id = $1', [tenantId]);
  const out: Record<string, unknown> = {};
  for (const row of r.rows) {
    const v = row.value;
    out[row.key] = typeof v === 'object' && v !== null ? (v as Record<string, unknown>).value ?? (v as Record<string, unknown>).v ?? v : v;
  }
  return out;
}

function pct(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

function safeNumber(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export async function getHealth(client: pg.PoolClient, ctx: Ctx) {
  const settings = await settingsMap(client, ctx.tenantId);
  const storageWarn = safeNumber(settings.storage_warning_pct, 80);
  const connWarn = safeNumber(settings.connection_warning_pct, 85);
  const slowMs = safeNumber(settings.slow_query_ms, 1000);
  const capacityBytes = safeNumber(settings.storage_capacity_bytes, 1_000_000_000_000);

  const [sizeR, totalR, actR, maxR, replR, cacheR, avgDurR, backupR] = await Promise.all([
    client.query('SELECT pg_database_size(current_database())::bigint AS bytes'),
    client.query('SELECT COALESCE(sum(pg_database_size(datname)), 0)::bigint AS bytes FROM pg_database'),
    client.query(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE state = 'active')::int AS active,
              count(*) FILTER (WHERE state = 'idle')::int AS idle,
              count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_tx,
              count(*) FILTER (WHERE wait_event_type IS NOT NULL)::int AS waiting,
              count(*) FILTER (WHERE state = 'active' AND now() - query_start > $1 * interval '1 millisecond')::int AS slow
       FROM pg_stat_activity WHERE datname = current_database()`,
      [slowMs]
    ),
    client.query("SELECT setting::int AS max FROM pg_settings WHERE name = 'max_connections'"),
    client.query('SELECT pg_is_in_recovery() AS in_recovery, (SELECT count(*)::int FROM pg_stat_replication) AS replicas'),
    client.query(
      `SELECT COALESCE(sum(blks_hit), 0)::bigint AS hit, COALESCE(sum(blks_read), 0)::bigint AS read,
              COALESCE(sum(xact_commit), 0)::bigint AS commits, COALESCE(sum(xact_rollback), 0)::bigint AS rollbacks,
              max(stats_reset) AS stats_reset
       FROM pg_stat_database WHERE datname = current_database()`
    ),
    client.query(
      `SELECT COALESCE(EXTRACT(EPOCH FROM avg(now() - query_start)) * 1000, 0)::numeric AS avg_ms
       FROM pg_stat_activity WHERE state = 'active' AND datname = current_database()`
    ),
    ctx.tenantId
      ? client.query(
          `SELECT backup_id, backup_type, status, started_at, completed_at, size_bytes, encrypted
           FROM backup_records WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 1`,
          [ctx.tenantId]
        )
      : Promise.resolve({ rows: [] }),
  ]);

  const dbBytes = Number(sizeR.rows[0]?.bytes ?? 0);
  const totalBytes = Number(totalR.rows[0]?.bytes ?? 0);
  const act = actR.rows[0] ?? {};
  const total = Number(act.total ?? 0);
  const maxConn = Number(maxR.rows[0]?.max ?? 100);
  const hit = Number(cacheR.rows[0]?.hit ?? 0);
  const read = Number(cacheR.rows[0]?.read ?? 0);
  const commits = Number(cacheR.rows[0]?.commits ?? 0);
  const rollbacks = Number(cacheR.rows[0]?.rollbacks ?? 0);
  const statsReset = cacheR.rows[0]?.stats_reset ?? null;
  const cacheHit = hit + read > 0 ? Math.round((hit / (hit + read)) * 1000) / 10 : 100;
  const tps = statsReset
    ? Math.round(((commits + rollbacks) / Math.max(1, (Date.now() - new Date(statsReset as string).getTime()) / 1000)) * 10) / 10
    : 0;
  const storagePct = pct(totalBytes, capacityBytes);
  const connPct = pct(total, maxConn);
  const inRecovery = replR.rows[0]?.in_recovery === true;
  const replicas = Number(replR.rows[0]?.replicas ?? 0);
  const slowCount = Number(act.slow ?? 0);

  let status = 'HEALTHY';
  if (storagePct >= 95 || connPct >= 95 || inRecovery) status = 'CRITICAL';
  else if (storagePct >= storageWarn || connPct >= connWarn || slowCount > 0 || replicas === 0) status = 'WARNING';

  const lastBackup = backupR.rows.length > 0 ? toCamelRow(backupR.rows[0] as Record<string, unknown>) : null;

  return {
    status,
    checkedAt: new Date().toISOString(),
    database: {
      sizeBytes: dbBytes,
      totalBytes,
      capacityBytes,
      storagePct,
      sizePretty: pgPretty(dbBytes),
      totalPretty: pgPretty(totalBytes),
    },
    connections: {
      total,
      active: Number(act.active ?? 0),
      idle: Number(act.idle ?? 0),
      idleInTx: Number(act.idle_in_tx ?? 0),
      waiting: Number(act.waiting ?? 0),
      slow: slowCount,
      max: maxConn,
      utilizationPct: pct(total, maxConn),
    },
    performance: {
      cacheHitPct: cacheHit,
      avgQueryDurationMs: Number(avgDurR.rows[0]?.avg_ms ?? 0),
      tpsEstimate: tps,
      slowQueries: slowCount,
      slowQueryMs: slowMs,
    },
    replication: {
      inRecovery,
      replicas,
      status: inRecovery ? 'RECOVERY' : replicas > 0 ? 'HEALTHY' : 'NO_REPLICA',
    },
    backups: { lastBackup, backupStatus: lastBackup ? String(lastBackup.status) : 'NONE' },
    thresholds: { storageWarnPct: storageWarn, connectionWarnPct: connWarn, slowQueryMs: slowMs },
  };
}

export async function getStorage(client: pg.PoolClient, _ctx: Ctx) {
  const [schemaR, tableR] = await Promise.all([
    client.query(
      `SELECT n.nspname AS schema,
              count(c.oid) FILTER (WHERE c.relkind IN ('r','p','m'))::int AS objects,
              COALESCE(sum(CASE WHEN c.relkind IN ('r','p','m') THEN pg_total_relation_size(c.oid) ELSE 0 END), 0)::bigint AS size_bytes
       FROM pg_namespace n
       LEFT JOIN pg_class c ON c.relnamespace = n.oid
       WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
       GROUP BY n.nspname ORDER BY size_bytes DESC`
    ),
    client.query(
      `SELECT n.nspname AS schema, c.relname AS table_name, c.relkind::text AS kind,
              GREATEST(c.reltuples, 0)::bigint AS row_estimate,
              pg_total_relation_size(c.oid)::bigint AS size_bytes,
              (SELECT count(*)::int FROM pg_index i WHERE i.indrelid = c.oid) AS index_count,
              pg_get_userbyid(c.relowner) AS owner,
              c.relrowsecurity AS rls_enabled,
              COALESCE(s.seq_scan, 0)::bigint AS seq_scans,
              COALESCE(s.idx_scan, 0)::bigint AS idx_scans,
              s.last_analyze, s.last_autovacuum
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
       WHERE n.nspname = 'public' AND c.relkind IN ('r','p','m')
       ORDER BY size_bytes DESC LIMIT 500`
    ),
  ]);
  const schemas = schemaR.rows.map((r) => {
    const row = toCamelRow(r as Record<string, unknown>);
    row.sizePretty = pgPretty(Number(r.size_bytes ?? 0));
    return row;
  });
  const tables = tableR.rows.map((r) => {
    const row = toCamelRow(r as Record<string, unknown>);
    row.sizePretty = pgPretty(Number(r.size_bytes ?? 0));
    row.classification = classifyTable(String(r.table_name ?? ''));
    return row;
  });
  const totalSize = tables.reduce((a, b) => a + Number(b.size_bytes ?? 0), 0);
  return { schemas, tables, totalSize, totalSizePretty: pgPretty(totalSize), tableCount: tables.length };
}

export async function getConnections(client: pg.PoolClient, _ctx: Ctx) {
  const [summaryR, listR, blockedR] = await Promise.all([
    client.query(
      `SELECT COALESCE(state, 'unknown') AS state, count(*)::int AS n
       FROM pg_stat_activity WHERE datname = current_database()
       GROUP BY state ORDER BY n DESC`
    ),
    client.query(
      `SELECT pid::int, usename, application_name, client_addr::text, state,
              wait_event_type, wait_event, query_start,
              EXTRACT(EPOCH FROM (now() - query_start))::numeric AS duration_s,
              left(query, 400) AS query
       FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
       ORDER BY query_start NULLS LAST LIMIT 200`
    ),
    client.query(
      `SELECT a.pid::int AS blocked_pid, a.state AS blocked_state,
              EXTRACT(EPOCH FROM (now() - a.query_start))::numeric AS blocked_s,
              left(a.query, 300) AS blocked_query,
              b.pid::int AS blocking_pid, left(b.query, 300) AS blocking_query
       FROM pg_stat_activity a
       JOIN pg_stat_activity b ON b.pid = ANY (pg_blocking_pids(a.pid))
       WHERE a.datname = current_database() AND a.pid <> pg_backend_pid()
       LIMIT 50`
    ),
  ]);
  return {
    summary: summaryR.rows.map((r) => toCamelRow(r as Record<string, unknown>)),
    connections: listR.rows.map((r) => toCamelRow(r as Record<string, unknown>)),
    blocked: blockedR.rows.map((r) => toCamelRow(r as Record<string, unknown>)),
    total: listR.rows.length,
  };
}

export async function getQueries(client: pg.PoolClient, ctx: Ctx) {
  const settings = await settingsMap(client, ctx.tenantId);
  const slowMs = safeNumber(settings.slow_query_ms, 1000);

  const [activeR, topR] = await Promise.all([
    client.query(
      `SELECT pid::int, usename, application_name, client_addr::text, state,
              wait_event_type, wait_event, query_start,
              EXTRACT(EPOCH FROM (now() - query_start))::numeric AS duration_s,
              left(query, 500) AS query
       FROM pg_stat_activity
       WHERE datname = current_database() AND state <> 'idle' AND pid <> pg_backend_pid()
       ORDER BY duration_s DESC LIMIT 100`
    ),
    client.query(
      `SELECT query, calls::bigint, total_exec_time::numeric, mean_exec_time::numeric, rows::bigint
       FROM pg_stat_statements ORDER BY mean_exec_time DESC LIMIT 20`
    ).catch(() => ({ rows: [] })),
  ]);
  const active = activeR.rows.map((r) => {
    const row = toCamelRow(r as Record<string, unknown>);
    row.slow = Number(row.durationS ?? 0) * 1000 > slowMs;
    return row;
  });
  return {
    active,
    slowCount: active.filter((r) => r.slow).length,
    slowQueryMs: slowMs,
    topStatements: topR.rows.map((r) => toCamelRow(r as Record<string, unknown>)),
  };
}

export async function getIndexes(client: pg.PoolClient, _ctx: Ctx) {
  const r = await client.query(
    `SELECT n.nspname AS schema, t.relname AS table_name, i.relname AS index_name,
            pg_get_indexdef(x.indexrelid) AS definition,
            pg_total_relation_size(x.indexrelid)::bigint AS size_bytes,
            COALESCE(s.idx_scan, 0)::bigint AS scans,
            COALESCE(s.idx_tup_read, 0)::bigint AS tuples_read,
            COALESCE(s.idx_tup_fetch, 0)::bigint AS tuples_fetched,
            x.indisunique, x.indisprimary
     FROM pg_index x
     JOIN pg_class i ON i.oid = x.indexrelid
     JOIN pg_class t ON t.oid = x.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     LEFT JOIN pg_stat_user_indexes s ON s.indexrelid = x.indexrelid
     WHERE n.nspname = 'public'
     ORDER BY size_bytes DESC LIMIT 300`
  );
  const indexes = r.rows.map((row) => {
    const out = toCamelRow(row as Record<string, unknown>);
    out.sizePretty = pgPretty(Number(row.size_bytes ?? 0));
    return out;
  });
  const unused = indexes.filter((i) => Number(i.scans ?? 0) === 0 && !i.indisprimary && !i.indisunique);
  const large = indexes.filter((i) => Number(i.sizeBytes ?? 0) > 100 * 1024 * 1024);
  const recommendations: string[] = [];
  if (unused.length > 0) recommendations.push(`${unused.length} unused non-constraint indexes found (review before dropping).`);
  if (large.length > 0) recommendations.push(`${large.length} indexes exceed 100 MB (consider partition or review).`);
  return { indexes, unused, large, recommendations, total: indexes.length };
}

interface IntegrityIssue {
  detail: string;
  [k: string]: unknown;
}
interface IntegrityResult {
  check: string;
  label: string;
  status: 'PASS' | 'WARNING' | 'FAIL';
  passed: number;
  failed: number;
  warnings: number;
  issues: IntegrityIssue[];
}

export async function runIntegrityChecks(client: pg.PoolClient, ctx: Ctx) {
  const tenantId = ctx.tenantId ?? null;
  const results: IntegrityResult[] = [];
  const push = (res: IntegrityResult) => results.push(res);

  const balanced = await client.query(
    `SELECT je.entry_no, je.id::int AS entry_id,
            je.total_debit, je.total_credit,
            COALESCE(SUM(jl.debit), 0)::numeric AS line_debit,
            COALESCE(SUM(jl.credit), 0)::numeric AS line_credit
     FROM journal_entries je
     LEFT JOIN journal_lines jl ON jl.entry_id = je.id
     GROUP BY je.id
     HAVING je.total_debit <> je.total_credit
        OR ABS(COALESCE(SUM(jl.debit), 0) - COALESCE(SUM(jl.credit), 0)) > 0.01
        OR ABS(COALESCE(SUM(jl.debit), 0) - je.total_debit) > 0.01
     LIMIT 50`
  );
  const totalJournals = await client.query('SELECT count(*)::int AS n FROM journal_entries');
  push({
    check: 'journal_balance',
    label: 'Double-entry balance (DEBIT = CREDIT)',
    status: balanced.rows.length > 0 ? 'FAIL' : 'PASS',
    passed: Number(totalJournals.rows[0]?.n ?? 0) - balanced.rows.length,
    failed: balanced.rows.length,
    warnings: 0,
    issues: balanced.rows.map((r) => ({
      detail: `Journal ${r.entry_no} (id ${r.entry_id}) header ${r.total_debit}/${r.total_credit} vs lines ${r.line_debit}/${r.line_credit}`,
    })),
  });

  const qrDup = await client.query(
    `SELECT code, count(*)::int AS n FROM qr_codes GROUP BY code HAVING count(*) > 1 LIMIT 50`
  );
  push({
    check: 'qr_uniqueness',
    label: 'QR code uniqueness (no duplicated codes)',
    status: qrDup.rows.length > 0 ? 'FAIL' : 'PASS',
    passed: 0,
    failed: qrDup.rows.length,
    warnings: 0,
    issues: qrDup.rows.map((r) => ({ detail: `QR code ${r.code} appears ${r.n} times` })),
  });

  const custDup = await client.query(
    `SELECT 'email' AS field, email AS value, count(*)::int AS n FROM customers
       WHERE email IS NOT NULL AND email <> '' GROUP BY email HAVING count(*) > 1
     UNION ALL SELECT 'tin', tin, count(*) FROM customers
       WHERE tin IS NOT NULL AND tin <> '' GROUP BY tin HAVING count(*) > 1
     UNION ALL SELECT 'vrn', vrn, count(*) FROM customers
       WHERE vrn IS NOT NULL AND vrn <> '' GROUP BY vrn HAVING count(*) > 1
     UNION ALL SELECT 'phone', phone, count(*) FROM customers
       WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING count(*) > 1
     LIMIT 50`
  );
  push({
    check: 'customer_duplicates',
    label: 'Customer duplicates (email / TIN / VRN / phone)',
    status: custDup.rows.length > 0 ? 'WARNING' : 'PASS',
    passed: 0,
    failed: 0,
    warnings: custDup.rows.length,
    issues: custDup.rows.map((r) => ({ detail: `Customer ${r.field} '${r.value}' appears ${r.n} times` })),
  });

  const supDup = await client.query(
    `SELECT 'email' AS field, email AS value, count(*)::int AS n FROM suppliers
       WHERE email IS NOT NULL AND email <> '' GROUP BY email HAVING count(*) > 1
     UNION ALL SELECT 'tin', tin, count(*) FROM suppliers
       WHERE tin IS NOT NULL AND tin <> '' GROUP BY tin HAVING count(*) > 1
     UNION ALL SELECT 'vrn', vrn, count(*) FROM suppliers
       WHERE vrn IS NOT NULL AND vrn <> '' GROUP BY vrn HAVING count(*) > 1
     UNION ALL SELECT 'phone', phone, count(*) FROM suppliers
       WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING count(*) > 1
     LIMIT 50`
  );
  push({
    check: 'supplier_duplicates',
    label: 'Supplier duplicates (email / TIN / VRN / phone)',
    status: supDup.rows.length > 0 ? 'WARNING' : 'PASS',
    passed: 0,
    failed: 0,
    warnings: supDup.rows.length,
    issues: supDup.rows.map((r) => ({ detail: `Supplier ${r.field} '${r.value}' appears ${r.n} times` })),
  });

  const orphan = await client.query(
    `SELECT jl.id::int AS line_id FROM journal_lines jl
     LEFT JOIN journal_entries je ON je.id = jl.entry_id
     WHERE je.id IS NULL LIMIT 50`
  );
  push({
    check: 'orphan_references',
    label: 'Orphaned references (journal lines without entries)',
    status: orphan.rows.length > 0 ? 'FAIL' : 'PASS',
    passed: 0,
    failed: orphan.rows.length,
    warnings: 0,
    issues: orphan.rows.map((r) => ({ detail: `journal_lines id ${r.line_id} has no parent journal entry` })),
  });

  const negative = await client.query(
    `SELECT id::int AS line_id FROM journal_lines WHERE debit < 0 OR credit < 0 LIMIT 50`
  );
  push({
    check: 'negative_amounts',
    label: 'No negative debit / credit amounts',
    status: negative.rows.length > 0 ? 'FAIL' : 'PASS',
    passed: 0,
    failed: negative.rows.length,
    warnings: 0,
    issues: negative.rows.map((r) => ({ detail: `journal_lines id ${r.line_id} has a negative amount` })),
  });

  const missing = await client.query(
    `SELECT 'products' AS tbl, id::int AS rid, 'missing code or name' AS issue FROM products WHERE code IS NULL OR code = '' OR name IS NULL OR name = ''
     UNION ALL SELECT 'customers', id, 'missing name' FROM customers WHERE name IS NULL OR name = ''
     UNION ALL SELECT 'suppliers', id, 'missing name' FROM suppliers WHERE name IS NULL OR name = ''
     UNION ALL SELECT 'users', id, 'missing email' FROM users WHERE email IS NULL OR email = ''
     LIMIT 100`
  );
  push({
    check: 'required_fields',
    label: 'Required master data fields present',
    status: missing.rows.length > 0 ? 'WARNING' : 'PASS',
    passed: 0,
    failed: 0,
    warnings: missing.rows.length,
    issues: missing.rows.map((r) => ({ detail: `${r.tbl} id ${r.rid}: ${r.issue}` })),
  });

  for (const res of results) {
    await client.query(
      `INSERT INTO db_integrity_runs (tenant_id, check_name, status, passed, failed, warnings, details, started_at, completed_at, run_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, now(), now(), $8)`,
      [tenantId, res.check, res.status, res.passed, res.failed, res.warnings, JSON.stringify(res.issues.slice(0, 20)), ctx.userId ?? null]
    );
  }
  await logAudit(client, ctx, {
    action: 'run_integrity_checks',
    resource: `${DB_RESOURCE}.integrity`,
    recordCode: `${results.filter((r) => r.status === 'FAIL').length} failed`,
    metadata: {
      checks: results.map((r) => ({ check: r.check, status: r.status, failed: r.failed, warnings: r.warnings })),
    },
  });
  return {
    runs: results,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.status === 'PASS').length,
      failed: results.filter((r) => r.status === 'FAIL').length,
      warnings: results.filter((r) => r.status === 'WARNING').length,
      overall: results.some((r) => r.status === 'FAIL') ? 'FAIL' : results.some((r) => r.status === 'WARNING') ? 'WARNING' : 'PASS',
    },
  };
}

export async function getIntegrityHistory(client: pg.PoolClient, ctx: Ctx) {
  const r = await client.query(
    `SELECT i.id, i.check_name, i.status, i.passed, i.failed, i.warnings, i.started_at, i.completed_at,
            COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS run_by
     FROM db_integrity_runs i LEFT JOIN users u ON u.id = i.run_by
     WHERE i.tenant_id = $1 ORDER BY i.started_at DESC LIMIT 100`,
    [ctx.tenantId]
  );
  return toCamelRows(r.rows as Record<string, unknown>[]);
}

export async function getDataQuality(client: pg.PoolClient, _ctx: Ctx) {
  const issues: { severity: string; category: string; detail: string; count: number }[] = [];
  const add = (severity: string, category: string, detail: string, count: number) => {
    if (count > 0) issues.push({ severity, category, detail, count });
  };
  const run = async (sql: string) => {
    const r = await client.query(sql);
    return r.rows.map((row) => toCamelRow(row as Record<string, unknown>));
  };
  const dup = async (table: string) => {
    const r = await client.query(
      `SELECT 'email' AS field, email AS value, count(*)::int AS n FROM ${table}
         WHERE email IS NOT NULL AND email <> '' GROUP BY email HAVING count(*) > 1
       UNION ALL SELECT 'tin', tin, count(*) FROM ${table}
         WHERE tin IS NOT NULL AND tin <> '' GROUP BY tin HAVING count(*) > 1
       UNION ALL SELECT 'vrn', vrn, count(*) FROM ${table}
         WHERE vrn IS NOT NULL AND vrn <> '' GROUP BY vrn HAVING count(*) > 1
       UNION ALL SELECT 'phone', phone, count(*) FROM ${table}
         WHERE phone IS NOT NULL AND phone <> '' GROUP BY phone HAVING count(*) > 1`
    );
    return r.rows.length;
  };
  const qrDup = await run(`SELECT code, count(*)::int AS n FROM qr_codes GROUP BY code HAVING count(*) > 1`);
  const custDup = await dup('customers');
  const supDup = await dup('suppliers');
  const badEmail = await client.query(
    `SELECT (SELECT count(*)::int FROM customers WHERE email IS NOT NULL AND email <> '' AND email NOT LIKE '%@%') AS c,
            (SELECT count(*)::int FROM suppliers WHERE email IS NOT NULL AND email <> '' AND email NOT LIKE '%@%') AS s,
            (SELECT count(*)::int FROM users WHERE email IS NOT NULL AND email <> '' AND email NOT LIKE '%@%') AS u`
  );
  const missing = await client.query(
    `SELECT (SELECT count(*)::int FROM products WHERE code IS NULL OR code = '' OR name IS NULL OR name = '') AS products,
            (SELECT count(*)::int FROM customers WHERE name IS NULL OR name = '') AS customers,
            (SELECT count(*)::int FROM suppliers WHERE name IS NULL OR name = '') AS suppliers,
            (SELECT count(*)::int FROM users WHERE email IS NULL OR email = '') AS users`
  );

  add('CRITICAL', 'qr', `Duplicate QR codes`, qrDup.length);
  add('WARNING', 'customers', `Duplicate customer records`, custDup);
  add('WARNING', 'suppliers', `Duplicate supplier records`, supDup);
  const bad = Number(badEmail.rows[0]?.c ?? 0) + Number(badEmail.rows[0]?.s ?? 0) + Number(badEmail.rows[0]?.u ?? 0);
  add('WARNING', 'contacts', `Invalid email addresses`, bad);
  const miss =
    Number(missing.rows[0]?.products ?? 0) +
    Number(missing.rows[0]?.customers ?? 0) +
    Number(missing.rows[0]?.suppliers ?? 0) +
    Number(missing.rows[0]?.users ?? 0);
  add('WARNING', 'master_data', `Missing required fields`, miss);

  let score = 100;
  for (const it of issues) {
    if (it.severity === 'CRITICAL') score -= Math.min(it.count * 4, 40);
    else if (it.severity === 'WARNING') score -= Math.min(it.count * 2, 30);
  }
  score = Math.max(0, score);
  return {
    score,
    critical: issues.filter((i) => i.severity === 'CRITICAL').reduce((a, i) => a + i.count, 0),
    warnings: issues.filter((i) => i.severity === 'WARNING').reduce((a, i) => a + i.count, 0),
    info: 0,
    issues,
    byCategory: issues,
    checkedAt: new Date().toISOString(),
  };
}

export async function getRetentionPolicies(client: pg.PoolClient, ctx: Ctx) {
  const r = await client.query(
    `SELECT id, category, retention_days, legal_hold, applies_to, notes, created_at, updated_at
     FROM db_retention_policies WHERE tenant_id = $1 ORDER BY category`,
    [ctx.tenantId]
  );
  return toCamelRows(r.rows as Record<string, unknown>[]);
}

export async function updateRetentionPolicy(client: pg.PoolClient, ctx: Ctx, id: number, body: Record<string, unknown>) {
  const cur = await client.query('SELECT * FROM db_retention_policies WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  if (cur.rows.length === 0) throw notFound('Retention policy not found');
  const old = cur.rows[0];
  const retentionDays = body.retentionDays !== undefined ? Number(body.retentionDays) : Number(old.retention_days);
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) throw badRequest('retentionDays must be a positive integer');
  const legalHold = body.legalHold !== undefined ? Boolean(body.legalHold) : Boolean(old.legal_hold);
  const appliesTo = body.appliesTo !== undefined ? String(body.appliesTo) : String(old.applies_to);
  const notes = body.notes !== undefined ? String(body.notes) : old.notes;
  const upd = await client.query(
    `UPDATE db_retention_policies
     SET retention_days = $1, legal_hold = $2, applies_to = $3, notes = $4, updated_at = now()
     WHERE id = $5 AND tenant_id = $6
     RETURNING id, category, retention_days, legal_hold, applies_to, notes, updated_at`,
    [retentionDays, legalHold, appliesTo, notes, id, ctx.tenantId]
  );
  await logAudit(client, ctx, {
    action: 'update_retention_policy',
    resource: `${DB_RESOURCE}.retention`,
    recordId: id,
    recordCode: String(old.category),
    oldValues: { retentionDays: Number(old.retention_days), legalHold: Boolean(old.legal_hold) },
    newValues: { retentionDays, legalHold },
  });
  return toCamelRow(upd.rows[0] as Record<string, unknown>);
}

export async function getSettings(client: pg.PoolClient, ctx: Ctx) {
  const r = await client.query(
    `SELECT s.id, s.key, s.value, s.updated_at,
            COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS updated_by
     FROM db_settings s LEFT JOIN users u ON u.id = s.updated_by
     WHERE s.tenant_id = $1 ORDER BY s.key`,
    [ctx.tenantId]
  );
  return r.rows.map((row) => {
    const out = toCamelRow(row as Record<string, unknown>);
    out.raw = row.value;
    return out;
  });
}

export async function updateSettings(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const key = String(body.key ?? '').trim();
  if (!key) throw badRequest('key is required');
  const value = body.value ?? body.val ?? null;
  const upd = await client.query(
    `INSERT INTO db_settings (tenant_id, key, value, updated_by, updated_at)
     VALUES ($1, $2, $3::jsonb, $4, now())
     ON CONFLICT (tenant_id, key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
     RETURNING id, key, value, updated_at`,
    [ctx.tenantId, key, JSON.stringify(value), ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'update_setting',
    resource: `${DB_RESOURCE}.settings`,
    recordCode: key,
    newValues: { value },
  });
  return toCamelRow(upd.rows[0] as Record<string, unknown>);
}

export async function getMigrationAudit(client: pg.PoolClient, ctx: Ctx) {
  const [auditR, appliedR] = await Promise.all([
    client.query(
      `SELECT m.id, m.migration_name, m.action, m.status, m.duration_ms, m.notes, m.executed_at, m.created_at,
              COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS executed_by
       FROM db_migration_audit m LEFT JOIN users u ON u.id = m.executed_by
       WHERE m.tenant_id = $1 ORDER BY m.executed_at DESC LIMIT 200`,
      [ctx.tenantId]
    ),
    client.query(`SELECT name, applied_at FROM schema_migrations ORDER BY id DESC LIMIT 200`),
  ]);
  return {
    audit: toCamelRows(auditR.rows as Record<string, unknown>[]),
    applied: appliedR.rows.map((r) => toCamelRow(r as Record<string, unknown>)),
  };
}

export async function recordMigrationEvent(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const migrationName = String(body.migrationName ?? '').trim();
  if (!migrationName) throw badRequest('migrationName is required');
  const action = String(body.action ?? 'APPLY').toUpperCase();
  const status = String(body.status ?? 'COMPLETED').toUpperCase();
  const durationMs = body.durationMs !== undefined ? Number(body.durationMs) : null;
  const notes = body.notes !== undefined ? String(body.notes) : null;
  const ins = await client.query(
    `INSERT INTO db_migration_audit (tenant_id, migration_name, action, status, duration_ms, notes, executed_by, executed_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, now()) RETURNING id`,
    [ctx.tenantId, migrationName, action, status, durationMs, notes, ctx.userId ?? null]
  );
  await logAudit(client, ctx, {
    action: 'migration_event',
    resource: `${DB_RESOURCE}.migration`,
    recordCode: migrationName,
    metadata: { action, status },
  });
  return { id: Number(ins.rows[0].id) };
}

export async function getBackups(client: pg.PoolClient, ctx: Ctx) {
  const [backupR, restoreR] = await Promise.all([
    client.query(
      `SELECT id, backup_id, backup_type, scope, started_at, completed_at, status, size_bytes,
              retention_days, encrypted, created_at
       FROM backup_records WHERE tenant_id = $1 ORDER BY started_at DESC LIMIT 100`,
      [ctx.tenantId]
    ),
    client.query(
      `SELECT rr.id, rr.backup_id, rr.reason, rr.risk_confirmed_at, rr.mfa_verified_at, rr.recovery_point,
              rr.status, rr.completed_at, rr.created_at,
              COALESCE(NULLIF(TRIM(req.first_name || ' ' || req.last_name), ''), req.email) AS requested_by,
              COALESCE(NULLIF(TRIM(app.first_name || ' ' || app.last_name), ''), app.email) AS approved_by
       FROM restore_requests rr
       LEFT JOIN users req ON req.id = rr.requested_by
       LEFT JOIN users app ON app.id = rr.approved_by
       WHERE rr.tenant_id = $1 ORDER BY rr.created_at DESC LIMIT 100`,
      [ctx.tenantId]
    ),
  ]);
  return {
    backups: toCamelRows(backupR.rows as Record<string, unknown>[]),
    restores: toCamelRows(restoreR.rows as Record<string, unknown>[]),
  };
}

export async function createBackup(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const backupType = String(body.backupType ?? 'FULL').toUpperCase();
  if (!['FULL', 'INCREMENTAL', 'DIFFERENTIAL'].includes(backupType)) throw badRequest('Invalid backupType');
  const scope = String(body.scope ?? 'FULL_DATABASE');
  const retentionDays = body.retentionDays !== undefined ? Number(body.retentionDays) : 30;
  const encrypted = body.encrypted !== undefined ? Boolean(body.encrypted) : true;
  const backupId = `BK-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.floor(Math.random() * 9000 + 1000)}`;
  const ins = await client.query(
    `INSERT INTO backup_records (tenant_id, backup_id, backup_type, scope, started_at, status, retention_days, encrypted)
     VALUES ($1, $2, $3, $4, now(), 'PENDING', $5, $6) RETURNING id`,
    [ctx.tenantId, backupId, backupType, scope, retentionDays, encrypted]
  );
  await logAudit(client, ctx, {
    action: 'create_backup',
    resource: `${DB_RESOURCE}.backup`,
    recordId: Number(ins.rows[0].id),
    recordCode: backupId,
    metadata: { backupType, scope, retentionDays, encrypted },
  });
  return { id: Number(ins.rows[0].id), backupId, status: 'PENDING' };
}

export async function requestRestore(client: pg.PoolClient, ctx: Ctx, body: Record<string, unknown>) {
  const backupId = Number(body.backupId ?? 0);
  const reason = String(body.reason ?? '').trim();
  if (!backupId) throw badRequest('backupId is required');
  if (!reason) throw badRequest('A restore reason is required');
  const bk = await client.query('SELECT backup_id FROM backup_records WHERE id = $1 AND tenant_id = $2', [backupId, ctx.tenantId]);
  if (bk.rows.length === 0) throw notFound('Backup record not found');
  const recoveryPoint = body.recoveryPoint ? new Date(String(body.recoveryPoint)) : null;
  const ins = await client.query(
    `INSERT INTO restore_requests (tenant_id, requested_by, backup_id, reason, risk_confirmed_at, recovery_point, status)
     VALUES ($1, $2, $3, $4, now(), $5, 'REQUESTED') RETURNING id`,
    [ctx.tenantId, ctx.userId ?? null, backupId, reason, recoveryPoint]
  );
  await logAudit(client, ctx, {
    action: 'request_restore',
    resource: `${DB_RESOURCE}.restore`,
    recordId: Number(ins.rows[0].id),
    recordCode: bk.rows[0].backup_id,
    metadata: { reason },
  });
  return { id: Number(ins.rows[0].id), status: 'REQUESTED', backupId: bk.rows[0].backup_id };
}

export async function approveRestore(client: pg.PoolClient, ctx: Ctx, id: number, body: Record<string, unknown>) {
  const cur = await client.query('SELECT * FROM restore_requests WHERE id = $1 AND tenant_id = $2', [id, ctx.tenantId]);
  if (cur.rows.length === 0) throw notFound('Restore request not found');
  if (cur.rows[0].status === 'REJECTED') throw badRequest('Restore request was already rejected');
  const decision = String(body.decision ?? 'APPROVE').toUpperCase();
  if (decision === 'REJECT') {
    await client.query(
      `UPDATE restore_requests SET status = 'REJECTED', updated_at = now() WHERE id = $1 AND tenant_id = $2`,
      [id, ctx.tenantId]
    );
  } else {
    await client.query(
      `UPDATE restore_requests SET status = 'APPROVED', approved_by = $1, approved_at = now(), updated_at = now()
       WHERE id = $2 AND tenant_id = $3`,
      [ctx.userId ?? null, id, ctx.tenantId]
    );
  }
  await logAudit(client, ctx, {
    action: decision === 'REJECT' ? 'reject_restore' : 'approve_restore',
    resource: `${DB_RESOURCE}.restore`,
    recordId: id,
    recordCode: cur.rows[0].backup_id,
    metadata: { reason: String(body.reason ?? '') },
  });
  return { id, status: decision === 'REJECT' ? 'REJECTED' : 'APPROVED' };
}

export async function getAudit(client: pg.PoolClient, ctx: Ctx, limit = 300) {
  const r = await client.query(
    `SELECT a.id, a.action, a.resource, a.record_id, a.record_code, a.metadata, a.created_at,
            COALESCE(NULLIF(TRIM(u.first_name || ' ' || u.last_name), ''), u.email) AS actor
     FROM audit_logs a LEFT JOIN users u ON u.id = a.user_id
     WHERE a.tenant_id = $1
       AND (a.resource LIKE 'database.%'
            OR a.resource IN ('db_retention_policies','db_integrity_runs','db_settings','db_migration_audit',
                              'backup_records','restore_requests','database_health_logs'))
     ORDER BY a.created_at DESC LIMIT $2`,
    [ctx.tenantId, limit]
  );
  return toCamelRows(r.rows as Record<string, unknown>[]);
}

export async function getLocks(client: pg.PoolClient, _ctx: Ctx) {
  const [summaryR, blockedR, longR, deadlockR] = await Promise.all([
    client.query(`SELECT l.mode,
                         count(*)::int AS total,
                         count(*) FILTER (WHERE l.granted)::int AS granted,
                         count(*) FILTER (WHERE NOT l.granted)::int AS waiting,
                         COALESCE(n.nspname || '.' || c.relname, l.locktype) AS target
                  FROM pg_locks l
                  LEFT JOIN pg_class c ON c.oid = l.relation
                  LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
                  WHERE l.pid IS NOT NULL
                  GROUP BY l.mode, n.nspname, c.relname, l.locktype
                  ORDER BY waiting DESC, total DESC
                  LIMIT 100`),
    client.query(`SELECT w.pid::int AS waiting_pid,
                         w.state,
                         EXTRACT(EPOCH FROM (now() - w.query_start))::numeric AS wait_seconds,
                         left(w.query, 300) AS waiting_query,
                         b.pid::int AS blocking_pid,
                         b.application_name AS blocking_application,
                         left(b.query, 300) AS blocking_query
                  FROM pg_stat_activity w
                  JOIN LATERAL unnest(pg_blocking_pids(w.pid)) bp(pid) ON true
                  JOIN pg_stat_activity b ON b.pid = bp.pid
                  WHERE w.datname = current_database() AND w.pid <> pg_backend_pid()
                  ORDER BY wait_seconds DESC
                  LIMIT 100`),
    client.query(`SELECT pid::int, usename, application_name, state,
                         EXTRACT(EPOCH FROM (now() - xact_start))::numeric AS xact_seconds,
                         EXTRACT(EPOCH FROM (now() - query_start))::numeric AS query_seconds,
                         left(query, 200) AS query
                  FROM pg_stat_activity
                  WHERE datname = current_database()
                    AND xact_start IS NOT NULL
                    AND now() - xact_start > interval '30 seconds'
                    AND pid <> pg_backend_pid()
                  ORDER BY xact_seconds DESC
                  LIMIT 100`),
    client.query(`SELECT COALESCE(sum(deadlocks), 0)::int AS count
                  FROM pg_stat_database WHERE datname = current_database()`),
  ]);
  return {
    summary: toCamelRows(summaryR.rows as Record<string, unknown>[]),
    blocked: toCamelRows(blockedR.rows as Record<string, unknown>[]),
    longTransactions: toCamelRows(longR.rows as Record<string, unknown>[]),
    deadlocks: Number(deadlockR.rows[0]?.count ?? 0),
  };
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export async function runMaintenance(db: pg.Pool, ctx: Ctx, body: Record<string, unknown>) {
  const action = String(body.action ?? '').toUpperCase();
  if (!['ANALYZE', 'VACUUM', 'VACUUM_ANALYZE', 'REINDEX'].includes(action)) {
    throw badRequest(`Invalid action "${action}". Use ANALYZE, VACUUM, VACUUM_ANALYZE or REINDEX`);
  }
  const tableInput = String(body.table ?? '').trim();
  if (!tableInput) throw badRequest('table is required (e.g. "finance.journal_entries" or "products")');
  const parts = tableInput.split('.').map((s) => s.trim()).filter(Boolean);
  const schema = parts.length > 1 ? parts[0] : 'public';
  const name = parts.length > 1 ? parts[1] : parts[0];

  const val = await db.query(
    `SELECT n.nspname AS schema, c.relname AS name, c.relkind::text AS kind
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
       AND n.nspname = $1 AND c.relname = $2`,
    [schema, name]
  );
  if (val.rows.length === 0) throw notFound(`Table ${schema}.${name} not found`);
  const kind = String(val.rows[0].kind);
  if (!['r', 'p', 'm'].includes(kind)) throw badRequest(`Table ${schema}.${name} is not a maintainable table`);

  if (action === 'REINDEX') {
    if (body.confirmDangerous !== true) {
      throw badRequest('REINDEX TABLE takes an ACCESS EXCLUSIVE lock. Pass confirmDangerous: true to proceed.');
    }
    if (!['r', 'p'].includes(kind)) throw badRequest('REINDEX is only supported on ordinary or partitioned tables');
  }

  const qualified = `${quoteIdent(schema)}.${quoteIdent(name)}`;
  const sql =
    action === 'ANALYZE' ? `ANALYZE ${qualified}` :
    action === 'VACUUM' ? `VACUUM (ANALYZE false) ${qualified}` :
    action === 'VACUUM_ANALYZE' ? `VACUUM (ANALYZE true) ${qualified}` :
    `REINDEX TABLE ${qualified}`;

  const client = await db.connect();
  const startedAt = Date.now();
  try {
    await client.query(sql);
  } catch (e) {
    const err = e as Error;
    try {
      await logAudit(client, ctx, {
        action: 'run_maintenance_failed',
        resource: `${DB_RESOURCE}.maintenance`,
        recordCode: `${action} ${qualified}`,
        metadata: { error: err.message },
      });
    } catch {
      // audit failure must not mask the original error
    }
    throw e;
  } finally {
    client.release();
  }
  const durationMs = Date.now() - startedAt;

  const auditClient = await db.connect();
  try {
    await logAudit(auditClient, ctx, {
      action: 'run_maintenance',
      resource: `${DB_RESOURCE}.maintenance`,
      recordCode: `${action} ${qualified}`,
      metadata: {
        action,
        schema,
        table: name,
        risk: action === 'REINDEX' ? 'HIGH' : action === 'VACUUM' || action === 'VACUUM_ANALYZE' ? 'MEDIUM' : 'LOW',
        durationMs,
      },
    });
  } finally {
    auditClient.release();
  }

  return { action, schema, table: name, sql, durationMs, status: 'COMPLETED' };
}

function pgPretty(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let x = bytes;
  while (x >= 1024 && i < units.length - 1) {
    x /= 1024;
    i += 1;
  }
  return `${x.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
