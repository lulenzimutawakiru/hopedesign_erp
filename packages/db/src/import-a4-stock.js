// ============================================================
// import-a4-stock.js
//
// Imports the October 2026 "A4 Stock Management Sheet" into the
// inventory ledger. Each sheet day becomes finished-goods movements
// posted through post_inventory_move(), so on-hand balances, cost and
// the stock ledger stay identical to every other movement in the system.
//
// The sheet tracks NATEX-A4 in reams (the product's base unit). "Boxes"
// are the 5-ream carton view and are not imported — the system models
// reams as inventory and cartons separately in the packing module.
//
// Movement mapping:
//   opening balance (55 reams)  -> RECEIPT
//   produced (reams)            -> PRODUCTION_OUTPUT
//   sample given (reams)        -> ISSUE   (reason "Sample given")
//   sold (reams)                -> ISSUE   (reason "Sale")
//
// Idempotent: every posted movement is tagged reference_type='a4-stock-sheet',
// and the script refuses to run again once any such movement exists.
//
// --replace makes the sheet the *current* record: it first clears any existing
// NATEX-A4 inventory (movements, layers, balances, batch quantities) and any
// active quality hold on the product, then imports the sheet fresh. Use it when
// the sheet should supersede the demo/seed stock rather than sit on top of it.
//
// Usage:
//   node src/import-a4-stock.js                    # local dev (.env + .env.local)
//   node src/import-a4-stock.js --replace          # clear NATEX-A4, then import
//   node src/import-a4-stock.js --dry-run          # print the plan, post nothing
//   node src/import-a4-stock.js --replace --dry-run
// ============================================================
const path = require("path");
const { Pool } = require("pg");
const dotenv = require("dotenv");

const ROOT = path.resolve(__dirname, "..", "..", "..");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const replace = args.includes("--replace");
const envArg = args.find((a) => a.startsWith("--env="));

// Resolve master data by code, not hard-coded id, so the import targets
// whichever environment it is pointed at.
const TENANT_CODE = "HDG";
const PRODUCT_CODE = "NATEX-A4";
const WAREHOUSE_CODE = "FG-WH";
const REF_TYPE = "a4-stock-sheet";

// Opening stock on the first sheet day (8th Oct 2026), in reams.
const OPENING_REAMS = 55;

// One row per production day from the sheet: [date, produced, sample, sold] in reams.
const DAYS = [
  ["2026-10-08", 439, 0, 0],
  ["2026-10-09", 422, 0, 0],
  ["2026-10-10", 434, 0, 0],
  ["2026-10-12", 437, 1, 0],
  ["2026-10-13", 472, 0, 0],
  ["2026-10-14", 470, 2, 0],
  ["2026-10-15", 515, 0, 2725],
  ["2026-10-16", 479, 0, 0],
  ["2026-10-18", 340, 0, 0],
  ["2026-10-19", 435, 4, 0],
  ["2026-10-20", 430, 0, 0],
  ["2026-10-21", 537, 0, 0],
  ["2026-10-22", 554, 0, 0],
  ["2026-10-23", 579, 0, 0],
  ["2026-10-24", 406, 0, 0],
  ["2026-10-26", 461, 0, 4360],
  ["2026-10-27", 549, 0, 640],
  ["2026-10-28", 392, 0, 0],
];

function loadEnv() {
  if (envArg) {
    dotenv.config({ path: path.resolve(ROOT, envArg.slice(6)), override: true });
  } else {
    dotenv.config({ path: path.join(ROOT, ".env") });
    dotenv.config({ path: path.join(ROOT, ".env.local"), override: true });
  }
}

function maskUrl(url) {
  return url.replace(/\/\/[^@/]+@/, "//***:***@");
}

async function main() {
  loadEnv();
  if (!process.env.DATABASE_URL) {
    throw new Error(
      "DATABASE_URL is not set; point it at a seeded database (e.g. the api/worker container already has it)."
    );
  }
  const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 5 });
  const client = await pool.connect();
  try {
    const tenant = await client.query(
      "SELECT id FROM tenants WHERE code = $1",
      [TENANT_CODE]
    );
    if (!tenant.rows.length) {
      throw new Error(`Tenant '${TENANT_CODE}' not found in target database`);
    }
    const tenantId = tenant.rows[0].id;

    const company = await client.query(
      "SELECT id FROM companies WHERE tenant_id = $1 ORDER BY id LIMIT 1",
      [tenantId]
    );
    if (!company.rows.length) {
      throw new Error(`No company found for tenant '${TENANT_CODE}'`);
    }
    const companyId = company.rows[0].id;

    // Scope the connection to this tenant/company so RLS policies and the
    // post_inventory_move() doc-number generator resolve correctly.
    await client.query("SELECT set_app_context($1, $2, NULL, NULL)", [tenantId, companyId]);

    const product = await client.query(
      "SELECT id, standard_cost FROM products WHERE company_id = $1 AND code = $2",
      [companyId, PRODUCT_CODE]
    );
    if (!product.rows.length) {
      throw new Error(`Product '${PRODUCT_CODE}' not found in target database`);
    }
    const productId = product.rows[0].id;
    const unitCost = Number(product.rows[0].standard_cost || 0);

    const wh = await client.query(
      "SELECT id FROM warehouses WHERE company_id = $1 AND code = $2",
      [companyId, WAREHOUSE_CODE]
    );
    if (!wh.rows.length) {
      throw new Error(`Warehouse '${WAREHOUSE_CODE}' not found in target database`);
    }
    const warehouseId = wh.rows[0].id;

    const bin = await client.query(
      "SELECT id FROM warehouse_bins WHERE warehouse_id = $1 ORDER BY code LIMIT 1",
      [warehouseId]
    );
    const binId = bin.rows.length ? bin.rows[0].id : null;

    const user = await client.query(
      "SELECT id FROM users WHERE tenant_id = $1 ORDER BY id LIMIT 1",
      [tenantId]
    );
    const userId = user.rows.length ? user.rows[0].id : null;

    // Idempotency guard (additive mode only; --replace clears and re-imports).
    if (!replace) {
      const done = await client.query(
        "SELECT 1 FROM inventory_movements WHERE reference_type = $1 LIMIT 1",
        [REF_TYPE]
      );
      if (done.rows.length) {
        console.log(`Already imported (movements tagged reference_type='${REF_TYPE}'). Nothing to do.`);
        return;
      }
    }

    // Build the ordered movement plan. ISSUE runs against a running balance
    // that never dips below zero, so the move posts cleanly in date order.
    const plans = [];
    plans.push({
      date: DAYS[0][0],
      type: "RECEIPT",
      qty: OPENING_REAMS,
      reason: "Opening stock — A4 stock sheet",
    });
    for (const [date, produced, sample, sold] of DAYS) {
      if (produced) plans.push({ date, type: "PRODUCTION_OUTPUT", qty: produced, reason: "Production output" });
      if (sample) plans.push({ date, type: "ISSUE", qty: sample, reason: "Sample given" });
      if (sold) plans.push({ date, type: "ISSUE", qty: sold, reason: "Sale" });
    }

    const totals = { RECEIPT: 0, PRODUCTION_OUTPUT: 0, ISSUE: 0 };
    for (const p of plans) totals[p.type] += p.qty;
    const finalOnHand = totals.RECEIPT + totals.PRODUCTION_OUTPUT - totals.ISSUE;

    console.log(`Target:   ${maskUrl(process.env.DATABASE_URL)}`);
    console.log(`Tenant:   ${TENANT_CODE} (company ${companyId})`);
    console.log(`Product:  ${PRODUCT_CODE} -> ${WAREHOUSE_CODE} (unit REAM)`);
    console.log(
      `Plan:     ${plans.length} movements | RECEIPT ${totals.RECEIPT} | ` +
        `PRODUCTION_OUTPUT ${totals.PRODUCTION_OUTPUT} | ISSUE ${totals.ISSUE} | ` +
        `final on-hand ${finalOnHand} reams`
    );

    if (dryRun) {
      for (const p of plans) {
        console.log(`  ${p.date}  ${p.type.padEnd(18)} ${String(p.qty).padStart(6)}  ${p.reason}`);
      }
      return;
    }

    await client.query("BEGIN");

    if (replace) {
      const holdInv = await client.query(
        "DELETE FROM quality_holds WHERE tenant_id = $1 AND product_id = $2 AND status = 'HELD' RETURNING hold_no",
        [tenantId, productId]
      );
      const holdProd = await client.query(
        "DELETE FROM production_quality_holds WHERE tenant_id = $1 AND product_id = $2 AND status IN ('HELD','INVESTIGATING','QUARANTINE') RETURNING hold_no",
        [tenantId, productId]
      );
      const mv = await client.query("DELETE FROM inventory_movements WHERE product_id = $1", [productId]);
      const layers = await client.query("DELETE FROM inventory_layers WHERE product_id = $1", [productId]);
      const inv = await client.query("DELETE FROM inventory WHERE product_id = $1", [productId]);
      const batches = await client.query(
        "UPDATE product_batches SET quantity = 0, updated_at = now() WHERE product_id = $1",
        [productId]
      );
      const holds = [...holdInv.rows, ...holdProd.rows].map((r) => r.hold_no);
      console.log(
        `Cleared: ${mv.rowCount} movements, ${layers.rowCount} layers, ${inv.rowCount} balances, ` +
          `${batches.rowCount} batches zeroed, holds [${holds.join(", ") || "none"}].`
      );
    }

    let posted = 0;
    for (const p of plans) {
      const res = await client.query(
        `SELECT post_inventory_move(
           $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21
         ) AS id`,
        [
          companyId, tenantId, null, p.type, productId, null, warehouseId, binId,
          null, null, null, null, p.qty, unitCost, REF_TYPE, null, p.date,
          null, null, userId, p.reason,
        ]
      );
      const movementId = res.rows[0].id;
      // Stamp the ledger entry to the sheet date so it reads chronologically.
      await client.query(
        "UPDATE inventory_movements SET created_at = $2 WHERE id = $1",
        [movementId, `${p.date}T12:00:00+03:00`]
      );
      posted += 1;
    }
    await client.query("COMMIT");

    const onhand = await client.query(
      "SELECT COALESCE(SUM(quantity), 0) AS qty FROM inventory WHERE product_id = $1",
      [productId]
    );
    console.log(
      `Done: ${posted} movements posted. Expected on-hand = ${finalOnHand} reams; ` +
        `verified inventory on-hand = ${Number(onhand.rows[0].qty)} reams.`
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
