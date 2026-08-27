const { Pool } = require("pg");
const p = new Pool({ connectionString: "postgres://hopedesign:hopedesign_dev@127.0.0.1:5432/hopedesign_erp" });
(async () => {
  try {
    const r = await p.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND (table_name LIKE '%expense%' OR table_name LIKE '%requisition%' OR table_name LIKE '%petty%' OR table_name LIKE '%cost_centre%' OR table_name LIKE '%budget%' OR table_name LIKE '%replenish%' OR table_name LIKE '%claim%' OR table_name LIKE '%daily_cash%' OR table_name LIKE '%reconcil%') ORDER BY table_name");
    console.log("TABLES:", r.rows.map(x=>x.table_name).join(", "));
    for (const t of ["expense_categories","expense_lines","petty_cash_transactions","expense_receipts"]) {
      const c = await p.query("SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [t]);
      console.log("=== "+t+" ===");
      console.log(c.rows.map(x=>`${x.column_name}:${x.data_type}`).join(", "));
    }
  } catch (e) { console.error("ERR", e.message); }
  finally { await p.end(); }
})();
