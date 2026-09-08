const fs = require("fs");
const path = require("path");
const { createPool } = require("./lib");

async function ensureBootstrapOrg(client) {
  const { rows } = await client.query(`
    SELECT to_regclass('public.tenants') AS tenants,
           to_regclass('public.companies') AS companies,
           to_regclass('public.branches') AS branches
  `);
  if (!rows[0].tenants || !rows[0].companies || !rows[0].branches) return;
  const sql = fs.readFileSync(path.join(__dirname, "bootstrap-org.sql"), "utf8").replace(/^\uFEFF/, "");
  await client.query(sql);
}

async function main() {
  const pool = createPool();
  const client = await pool.connect();
  try {
    // Session-level advisory lock shared with the API's WORKER_LOCKS.MIGRATIONS
    // key (88100). With multiple API replicas booting at the same time, only
    // one runs the migration pass; the others block here, then observe the
    // already-applied migration set below and start cleanly.
    await client.query('SELECT pg_advisory_lock(88100)');
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id BIGSERIAL PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
    `);
    // Re-read after acquiring the lock: a concurrent boot may have applied
    // migrations while we waited for the advisory lock.
    const dir = path.resolve(__dirname, "..", "migrations");
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const { rows } = await client.query("SELECT name FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.name));
    await ensureBootstrapOrg(client);
    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = fs.readFileSync(path.join(dir, file), "utf8").replace(/^\uFEFF/, "");
      console.log(`Applying ${file} ...`);
      await client.query("BEGIN");
      try {
        await client.query(sql);
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        console.log(`  ok (${file})`);
      } catch (err) {
        await client.query("ROLLBACK");
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
      await ensureBootstrapOrg(client);
    }
    console.log("Migrations up to date.");
  } finally {
    await client.query('SELECT pg_advisory_unlock(88100)').catch(() => undefined);
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
