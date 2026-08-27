const { Pool } = require("pg");
const p = new Pool({ connectionString: "postgres://hopedesign:hopedesign_dev@127.0.0.1:5432/hopedesign_erp" });
(async () => {
  try {
    const tables = ["requisitions","requisition_lines","requisition_approvals","requisition_fulfillments",
      "expense_transactions","expense_lines","expense_allocations","expense_categories","petty_cash_funds",
      "petty_cash_transactions","petty_cash_replenishments","employee_expense_claims","expense_receipts",
      "daily_cash_closings","cash_reconciliations","expense_audit_logs","expense_requests","expense_duplicates"];
    for (const t of tables) {
      const r = await p.query(
        "SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position",
        [t]
      );
      if (r.rows.length === 0) { console.log("=== " + t + " : MISSING"); continue; }
      console.log("=== " + t + " ===");
      for (const c of r.rows) {
        console.log(`  ${c.column_name} ${c.data_type}${c.is_nullable==="NO"?" NOT NULL":""}${c.column_default?` DEFAULT ${c.column_default}`:""}`);
      }
    }
  } catch (e) { console.error("ERR", e.message); }
  finally { await p.end(); }
})();
