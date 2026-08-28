const { Pool } = require('pg');
const pool = new Pool({ host: 'localhost', port: 5432, user: 'hopedesign', password: 'hopedesign_dev', database: 'hopedesign_erp' });
(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fk = await client.query(`
      SELECT tc.table_name AS tbl, kcu.column_name AS col
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name AND ccu.table_schema = tc.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY' AND ccu.table_name = 'employees' AND ccu.column_name = 'id'
      ORDER BY tc.table_name
    `);
    for (const r of fk.rows) {
      const q = `DELETE FROM ${r.tbl} WHERE ${r.col} = $1`;
      try {
        const d = await client.query(q, [1368]);
        if (d.rowCount > 0) console.log('cleared', r.tbl + '.' + r.col, d.rowCount);
      } catch (e) { console.log('skip', r.tbl + '.' + r.col, e.message); }
    }
    await client.query('UPDATE users SET employee_id = NULL WHERE employee_id = 1368');
    const del = await client.query('DELETE FROM employees WHERE id = 1368');
    console.log('employees deleted:', del.rowCount);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
})().catch((e) => { console.error(e); process.exit(1); });
