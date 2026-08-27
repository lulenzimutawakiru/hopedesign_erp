const { Pool } = require("pg");
const p = new Pool({ connectionString: "postgres://hopedesign:hopedesign_dev@127.0.0.1:5432/hopedesign_erp" });
(async () => {
  try {
    const r = await p.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='asset_register' ORDER BY ordinal_position");
    console.log(r.rows.map(x=>`${x.column_name}:${x.data_type}`).join(", "));
    const a = await p.query("SELECT id, asset_no, name, status, custodian_user_id, assigned_to, department_id, category_id FROM asset_register LIMIT 3");
    console.log("SAMPLE:", JSON.stringify(a.rows));
    const cat = await p.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_name LIKE '%asset%' ORDER BY table_name");
    console.log("ASSET TABLES:", cat.rows.map(x=>x.table_name).join(", "));
  } catch (e) { console.error("ERR", e.message); }
  finally { await p.end(); }
})();
