// ============================================================
// Hope Design ERP - deterministic seed data
// Single transaction; guarded so it can be re-run safely.
// ============================================================
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const { buildPermissions, ROLES } = require("./catalogue");

// ---------- helpers ----------
function json(v) {
  if (v === undefined) return undefined;
  if (v === null) return null;
  if (Array.isArray(v) || (typeof v === "object" && !(v instanceof Date))) {
    return JSON.stringify(v);
  }
  return v;
}

async function insertOne(client, table, data) {
  const cols = [];
  const vals = [];
  for (const [k, v] of Object.entries(data)) {
    if (v === undefined) continue;
    cols.push(k);
    vals.push(json(v));
  }
  if (!cols.length) throw new Error(`insertOne: no columns for ${table}`);
  const params = cols.map((_, i) => `$${i + 1}`);
  const { rows } = await client.query(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES (${params.join(", ")}) RETURNING id`,
    vals
  );
  return rows[0].id;
}

// Bulk insert; all rows must share identical keys. Returns ids unless
// returnIds is false (for tables with composite PKs and no id column).
async function bulkInsert(client, table, rows, returnIds = true) {
  if (!rows.length) return [];
  const cols = Object.keys(rows[0]);
  const params = [];
  const placeholders = rows.map((row, ri) => {
    const parts = cols.map((c, ci) => {
      params.push(json(row[c]));
      return `$${ri * cols.length + ci + 1}`;
    });
    return `(${parts.join(", ")})`;
  });
  const suffix = returnIds ? " RETURNING id" : "";
  const { rows: out } = await client.query(
    `INSERT INTO ${table} (${cols.join(", ")}) VALUES ${placeholders.join(", ")}${suffix}`,
    params
  );
  return returnIds ? out.map((r) => r.id) : [];
}

// Expand role grant wildcards into concrete permission codes.
// Unknown grants are skipped silently (catalogue contains strays).
function expandGrants(grants) {
  const perms = buildPermissions();
  const all = perms.map((p) => p.code);
  const byModule = {};
  const byResource = {};
  for (const p of perms) {
    (byModule[p.module] ||= []).push(p.code);
    (byResource[`${p.module}.${p.resource}`] ||= []).push(p.code);
  }
  const out = new Set();
  const excludes = [];
  for (const g of grants) {
    if (g.startsWith("!")) {
      excludes.push(g.slice(1));
      continue;
    }
    if (g === "*") {
      for (const c of all) out.add(c);
      continue;
    }
    if (g.endsWith(".*")) {
      // wildcard: expand module.* or module.resource.*
      const base = g.slice(0, -2);
      const hits = byModule[base] || byResource[base] || [];
      for (const c of hits) out.add(c);
      continue;
    }
    if (all.includes(g)) out.add(g);
    // else: unknown grant -> skip
  }
  // Exclusion grants ("!admin.users.*") remove already-expanded codes.
  for (const e of excludes) {
    if (e === "*") { out.clear(); continue; }
    if (e.endsWith(".*")) {
      const base = e.slice(0, -2);
      const hits = byModule[base] || byResource[base] || [];
      for (const c of hits) out.delete(c);
      continue;
    }
    out.delete(e);
  }
  return [...out];
}

// Reconcile the RBAC catalogue against an already-seeded tenant.
// Idempotent: upserts catalogue permissions and replaces every role's
// grants so `npm run db:seed` stays safe to re-run after catalogue edits.
async function reconcileRbac(client, tenantId) {
  const perms = buildPermissions();
  const cols = ["code", "module", "resource", "action", "description", "is_system"];
  for (let i = 0; i < perms.length; i += 200) {
    const slice = perms.slice(i, i + 200);
    const params = [];
    const placeholders = slice.map((p, ri) => {
      const parts = cols.map((c, ci) => {
        params.push(json(c === "is_system" ? false : p[c]));
        return `$${ri * cols.length + ci + 1}`;
      });
      return `(${parts.join(", ")})`;
    });
    await client.query(
      `INSERT INTO permissions (${cols.join(", ")}) VALUES ${placeholders.join(", ")}
       ON CONFLICT (code) DO UPDATE SET
         module = EXCLUDED.module,
         resource = EXCLUDED.resource,
         action = EXCLUDED.action,
         description = EXCLUDED.description`,
      params
    );
  }

  const { rows: permRows } = await client.query(
    "SELECT id, code FROM permissions"
  );
  const permIdByCode = {};
  for (const r of permRows) permIdByCode[r.code] = r.id;

  const { rows: roleRows } = await client.query(
    "SELECT id, code FROM roles WHERE tenant_id = $1",
    [tenantId]
  );
  const roleIdByCode = {};
  for (const r of roleRows) roleIdByCode[r.code] = r.id;

  let granted = 0;
  for (const role of ROLES) {
    const roleId = roleIdByCode[role.code];
    if (!roleId) continue;
    const codes = expandGrants(role.grants).filter((c) => permIdByCode[c]);
    await client.query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);
    if (codes.length) {
      const rolePermRows = codes.map((c) => ({
        role_id: roleId,
        permission_id: permIdByCode[c],
      }));
      await bulkInsert(client, "role_permissions", rolePermRows, false);
      granted += rolePermRows.length;
    }
  }
  return { permissions: perms.length, role_permissions: granted };
}

/** Opening warehouse balances so the dashboard and sales allocate path have stock. */
async function ensureOpeningStock(client, tenantId) {
  const company = await client.query(
    "SELECT id FROM companies WHERE tenant_id = $1 ORDER BY id LIMIT 1",
    [tenantId]
  );
  if (!company.rows.length) return { inserted: 0 };
  const companyId = company.rows[0].id;

  const opening = [
    ["NATEX-A4", "FG-WH", 8000],
    ["A3-80", "FG-WH", 2500],
    ["SEC-WM", "SEC-WH", 600],
    ["JUMBO-105", "RAW-MAT", 24],
    ["BOB-80", "RAW-MAT", 40],
    ["CARTON-A4", "PACK-WH", 1200],
    ["LBL-REAM", "PACK-WH", 20000],
  ];

  let inserted = 0;
  for (const [pcode, wcode, qty] of opening) {
    const p = await client.query(
      "SELECT id, standard_cost, valuation_method FROM products WHERE company_id = $1 AND code = $2",
      [companyId, pcode]
    );
    const w = await client.query(
      "SELECT id FROM warehouses WHERE company_id = $1 AND code = $2",
      [companyId, wcode]
    );
    if (!p.rows.length || !w.rows.length) continue;
    const bin = await client.query(
      "SELECT id FROM warehouse_bins WHERE warehouse_id = $1 ORDER BY code LIMIT 1",
      [w.rows[0].id]
    );
    const existing = await client.query(
      `SELECT id FROM inventory
       WHERE tenant_id = $1 AND product_id = $2 AND warehouse_id = $3
         AND batch_id IS NULL AND bin_id IS NOT DISTINCT FROM $4
       ORDER BY id LIMIT 1`,
      [tenantId, p.rows[0].id, w.rows[0].id, bin.rows[0] ? bin.rows[0].id : null]
    );
    if (existing.rows.length) {
      await client.query(
        "UPDATE inventory SET quantity = $1, avg_cost = $2, valuation_method = $3, reserved_qty = 0 WHERE id = $4",
        [qty, p.rows[0].standard_cost, p.rows[0].valuation_method, existing.rows[0].id]
      );
    } else {
      await client.query(
        `INSERT INTO inventory
           (company_id, tenant_id, product_id, warehouse_id, bin_id, quantity, reserved_qty, avg_cost, valuation_method)
         VALUES ($1,$2,$3,$4,$5,$6,0,$7,$8)`,
        [
          companyId,
          tenantId,
          p.rows[0].id,
          w.rows[0].id,
          bin.rows[0] ? bin.rows[0].id : null,
          qty,
          p.rows[0].standard_cost,
          p.rows[0].valuation_method,
        ]
      );
    }
    inserted += 1;
  }
  return { inserted };
}

/** CRM/procurement master rows with fixed ids (customer 1 / supplier 1) so
 *  documents, sales, workflow, security-printing and SoD flows have stable
 *  counter and supplier fixtures across fresh and re-seeded databases.
 *  Idempotent: adopts rows that already exist for the HDG company and only
 *  inserts when the fixed ids are free, advancing each sequence afterwards so
 *  API-created rows never collide with the fixtures. */
async function ensureCrmProcurementMasters(client, tenantId) {
  const company = await client.query(
    "SELECT id FROM companies WHERE tenant_id = $1 AND code = 'HDG' ORDER BY id LIMIT 1",
    [tenantId]
  );
  if (!company.rows.length) return { customers: 0, suppliers: 0 };
  const companyId = company.rows[0].id;
  const branch = await client.query(
    "SELECT id FROM branches WHERE company_id = $1 AND code = 'KAMPALA-HQ' ORDER BY id LIMIT 1",
    [companyId]
  );
  const branchId = branch.rows.length ? branch.rows[0].id : null;

  let customers = 0;
  const existingCustomer = await client.query(
    "SELECT id, company_id FROM customers WHERE id = 1"
  );
  if (existingCustomer.rowCount === 0) {
    await client.query(
      `INSERT INTO customers (id, company_id, tenant_id, branch_id, code, name,
         customer_type, phone, email, address, credit_limit, payment_terms_days,
         currency, status, security_classification)
       VALUES (1, $1, $2, $3, 'HDG-WALK-IN', 'Walk-In Counter Customer',
         'COMPANY', '+256700000001', 'walkin@hopedesign.co.ug',
         'Plot 12, Namanve Industrial Park, Kampala, Uganda', 0, 0, 'UGX',
         'ACTIVE', 'NONE')
       ON CONFLICT (id) DO NOTHING`,
      [companyId, tenantId, branchId]
    );
    const seq = await client.query(
      "SELECT pg_get_serial_sequence('customers', 'id') AS s"
    );
    if (seq.rows[0]?.s) {
      await client.query(
        `SELECT setval($1, (SELECT COALESCE(MAX(id), 1) FROM customers), true)`,
        [seq.rows[0].s]
      );
    }
    customers = 1;
  }

  let suppliers = 0;
  const existingSupplier = await client.query(
    "SELECT id, company_id FROM suppliers WHERE id = 1"
  );
  if (existingSupplier.rowCount === 0) {
    await client.query(
      `INSERT INTO suppliers (id, company_id, tenant_id, branch_id, code, name,
         supplier_type, phone, email, address, payment_terms_days, currency,
         default_lead_time_days, rating, status, security_cleared)
       VALUES (1, $1, $2, $3, 'HDG-RAW-001', 'National Paper Merchants Ltd',
         'RAW_MATERIAL', '+256700000002', 'supply@npaper.co.ug',
         'Plot 7, Bweyogerere Industrial Area, Kampala, Uganda', 30, 'UGX',
         7, 4.5, 'ACTIVE', true)
       ON CONFLICT (id) DO NOTHING`,
      [companyId, tenantId, branchId]
    );
    const seq = await client.query(
      "SELECT pg_get_serial_sequence('suppliers', 'id') AS s"
    );
    if (seq.rows[0]?.s) {
      await client.query(
        `SELECT setval($1, (SELECT COALESCE(MAX(id), 1) FROM suppliers), true)`,
        [seq.rows[0].s]
      );
    }
    suppliers = 1;
  }
  return { customers, suppliers };
}

/** Uganda statutory payroll defaults as versioned DB rows (PAYE, NSSF, LST).
 *  Legal values live in statutory_configs so rate changes are a versioned
 *  config update, never a code change. Idempotent: only seeds a tenant that
 *  has no rows yet, and rows are tenant-wide so every company inherits them
 *  until an administrator adds a company-specific override. */
async function ensureStatutoryConfigs(client, tenantId) {
  const existing = await client.query(
    "SELECT count(*)::int AS n FROM statutory_configs WHERE tenant_id = $1",
    [tenantId]
  );
  if (Number(existing.rows[0].n) > 0) return { inserted: 0 };

  const defs = [
    {
      category: "PAYE",
      code: "UG-PAYE-2023",
      name: "Uganda PAYE (FY2023/24 rates)",
      description: "Monthly PAYE bands effective from 01 Jul 2023.",
      effective_from: "2023-07-01",
      effective_to: "2026-06-30",
      version: 1,
      rates: [
        { min: 0, max: 235000, rate: 0 },
        { min: 235000, max: 335000, rate: 10 },
        { min: 335000, max: 410000, rate: 20 },
        { min: 410000, max: 10000000, rate: 30 },
        { min: 10000000, max: null, rate: 40 },
      ],
      limits: {},
    },
    {
      category: "PAYE",
      code: "UG-PAYE-2026",
      name: "Uganda PAYE (current)",
      description: "Current monthly PAYE bands. Create a new version when URA changes rates.",
      effective_from: "2026-07-01",
      effective_to: null,
      version: 2,
      rates: [
        { min: 0, max: 335000, rate: 0 },
        { min: 335000, max: 410000, rate: 20 },
        { min: 410000, max: 485000, rate: 25 },
        { min: 485000, max: 10000000, rate: 30 },
        { min: 10000000, max: null, rate: 40 },
      ],
      limits: {},
    },
    {
      category: "NSSF",
      code: "UG-NSSF-2023",
      name: "Uganda NSSF (5% employee / 10% employer)",
      description: "NSSF Act contributions. monthly_ceiling 0 = no ceiling; set to cap the base.",
      effective_from: "2023-07-01",
      effective_to: null,
      version: 1,
      rates: { employee: 0.05, employer: 0.1 },
      limits: { monthly_ceiling: 0 },
    },
    {
      category: "LST",
      code: "UG-LST-2023",
      name: "Uganda Local Service Tax (monthly)",
      description: "Monthly LST where applicable. Disabled by default; flip apply_to_payroll to enable.",
      effective_from: "2023-07-01",
      effective_to: null,
      version: 1,
      rates: { monthly_amount: 5000 },
      limits: { monthly_amount: 5000, min_gross: 100000, apply_to_payroll: false },
    },
  ];

  let inserted = 0;
  for (const d of defs) {
    await client.query(
      `INSERT INTO statutory_configs
         (company_id, tenant_id, country, category, code, name, description,
          effective_from, effective_to, rates, thresholds, limits, formula, version, status)
       VALUES (NULL,$1,'UG',$2,$3,$4,$5,$6,$7,$8,'[]'::jsonb,$9,NULL,$10,'ACTIVE')`,
      [
        tenantId, d.category, d.code, d.name, d.description ?? null,
        d.effective_from, d.effective_to ?? null,
        JSON.stringify(d.rates), JSON.stringify(d.limits ?? {}), d.version,
      ]
    );
    inserted += 1;
  }
  return { inserted };
}


/** Company-level statutory overrides for the HDG org. The tenant-wide LST
 *  default is deliberately disabled (least privilege); Kampala entities that
 *  actually owe Local Service Tax declare a company-specific KCCA override,
 *  which the payroll engine resolves ahead of tenant-wide rows. Idempotent. */
async function ensureCompanyStatutoryOverrides(client, tenantId, companyId = null) {
  if (!companyId) {
    const { rows } = await client.query(
      "SELECT id FROM companies WHERE tenant_id = $1 AND code = 'HDG'",
      [tenantId]
    );
    if (rows.length === 0) return { inserted: 0 };
    companyId = rows[0].id;
  }
  const exists = await client.query(
    `SELECT id FROM statutory_configs
     WHERE company_id = $1 AND tenant_id = $2 AND code = 'UG-LST-KCCA'`,
    [companyId, tenantId]
  );
  if (exists.rowCount > 0) return { inserted: 0 };
  await client.query(
    `INSERT INTO statutory_configs
       (company_id, tenant_id, country, category, code, name, description,
        effective_from, effective_to, rates, thresholds, limits, formula, version, status)
     VALUES ($1,$2,'UG','LST','UG-LST-KCCA',
        'Uganda Local Service Tax - KCCA Kampala (monthly)',
        'KCCA graduated monthly LST collected Jul-Oct for Kampala employees.',
        '2023-07-01', NULL, '{}'::jsonb, '[]'::jsonb,
        $3, NULL, 1, 'ACTIVE')`,
    [
      companyId,
      tenantId,
      JSON.stringify({
        apply_to_payroll: true,
        months: [7, 8, 9, 10],
        min_gross: 100000,
        bands: [
          { max: 200000, monthly_amount: 1250 },
          { max: 300000, monthly_amount: 2500 },
          { max: 400000, monthly_amount: 5000 },
          { max: 600000, monthly_amount: 10000 },
          { max: 1000000, monthly_amount: 20000 },
          { max: null, monthly_amount: 25000 },
        ],
      }),
    ]
  );
  return { inserted: 1 };
}

// Uganda-flavoured HCM baseline for the HDG tenant. Idempotent per table and
// safe on the early "already seeded" path: it resolves existing org rows
// (branch/departments/cost centres) instead of re-creating them.
async function ensureHcmSeed(client, tenantId, companyId = null) {
  const inserted = {};
  const bump = (t, n = 1) => {
    inserted[t] = (inserted[t] || 0) + n;
  };
  if (!companyId) {
    const { rows } = await client.query(
      "SELECT id FROM companies WHERE tenant_id = $1 AND code = 'HDG'",
      [tenantId]
    );
    if (rows.length === 0) return { inserted };
    companyId = rows[0].id;
  }
  const row = async (table, codeCol, code) => {
    const { rows } = await client.query(
      `SELECT id FROM ${table} WHERE company_id = $1 AND tenant_id = $2 AND ${codeCol} = $3`,
      [companyId, tenantId, code]
    );
    return rows.length ? rows[0].id : null;
  };
  const count = async (table) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1 AND tenant_id = $2`,
      [companyId, tenantId]
    );
    return rows[0].n;
  };
  const branchId = await row("branches", "code", "KAMPALA-HQ");
  const deptProd = await row("departments", "code", "PROD");
  const deptIt = await row("departments", "code", "IT");
  const ccProd = await row("cost_centres", "code", "CC-PROD");
  if (!branchId || !deptProd || !deptIt || !ccProd) return { inserted };

  // Locations (workplaces/factory)
  if ((await count("locations")) === 0) {
    for (const l of [
      { code: "KAMPALA-HQ", name: "Kampala Headquarters", type: "WORKPLACE", address: "Plot 12, Namanve Industrial Park, Kampala", city: "Kampala" },
      { code: "NAMANVE-FACTORY", name: "Namanve Factory", type: "FACTORY", address: "Namanve Industrial Park, Kampala", city: "Kampala" },
    ]) {
      await insertOne(client, "locations", {
        company_id: companyId,
        tenant_id: tenantId,
        branch_id: branchId,
        code: l.code,
        name: l.name,
        type: l.type,
        address: l.address,
        city: l.city,
        country: "UG",
        timezone: "Africa/Kampala",
        geo: {},
        status: "ACTIVE",
      });
      bump("locations");
    }
  }

  // Divisions (only when the company has none yet)
  if ((await count("divisions")) === 0) {
    for (const [code, name] of [
      ["DSGN", "Design"],
      ["PRNT", "Printing"],
      ["PUR", "Procurement"],
      ["CRPS", "Corporate Services"],
    ]) {
      await insertOne(client, "divisions", {
        company_id: companyId,
        tenant_id: tenantId,
        branch_id: null,
        code,
        name,
        status: "ACTIVE",
      });
      bump("divisions");
    }
  }

  // Org units
  if ((await count("org_units")) === 0) {
    await insertOne(client, "org_units", {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      department_id: deptProd, parent_id: null, code: "PROD-1",
      name: "Production Unit 1", status: "ACTIVE",
    });
    bump("org_units");
    await insertOne(client, "org_units", {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      department_id: deptIt, parent_id: null, code: "IT-1",
      name: "ICT Unit", status: "ACTIVE",
    });
    bump("org_units");
  }
  const ouProd = await row("org_units", "code", "PROD-1");

  // Teams
  if ((await count("teams")) === 0) {
    await insertOne(client, "teams", {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      department_id: deptProd, org_unit_id: ouProd, code: "SHIFT-A",
      name: "Shift A", status: "ACTIVE",
    });
    bump("teams");
  }

  // Job families
  if ((await count("job_families")) === 0) {
    for (const [code, name] of [
      ["OPS", "Operations"],
      ["DSGN", "Design"],
      ["FIN", "Finance"],
      ["HR", "Human Resources"],
    ]) {
      await insertOne(client, "job_families", {
        company_id: companyId, tenant_id: tenantId, code, name, status: "ACTIVE",
      });
      bump("job_families");
    }
  }
  const famOps = await row("job_families", "code", "OPS");

  // Job grades (UGX salary bands)
  if ((await count("job_grades")) === 0) {
    const grades = [
      ["G1", "Grade 1", 1, 500000, 1000000],
      ["G2", "Grade 2", 2, 800000, 1500000],
      ["G3", "Grade 3", 3, 1200000, 2500000],
      ["G4", "Grade 4", 4, 2000000, 4000000],
      ["G5", "Grade 5", 5, 3500000, 7000000],
    ];
    for (const [code, name, level, minSalary, maxSalary] of grades) {
      await insertOne(client, "job_grades", {
        company_id: companyId, tenant_id: tenantId, code, name, level,
        min_salary: minSalary, max_salary: maxSalary, currency: "UGX", status: "ACTIVE",
      });
      bump("job_grades");
    }
  }
  const gradeG3 = await row("job_grades", "code", "G3");

  // Position: Production Supervisor (an approved slot, separate from the occupant)
  const posCount = await client.query(
    "SELECT count(*)::int AS n FROM positions WHERE company_id = $1 AND tenant_id = $2 AND code = 'PROD-SUP'",
    [companyId, tenantId]
  );
  if (posCount.rows[0].n === 0) {
    await insertOne(client, "positions", {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      department_id: deptProd, division_id: null, org_unit_id: ouProd,
      team_id: null, location_id: null, job_family_id: famOps, job_grade_id: gradeG3,
      cost_centre_id: ccProd, code: "PROD-SUP", title: "Production Supervisor",
      report_to_position_id: null, approved_headcount: 5, salary_min: 1200000,
      salary_max: 2500000, currency: "UGX",
      required_qualifications: ["Diploma in Production Management"],
      required_skills: ["Lean Manufacturing", "Team Leadership"],
      job_description: "Supervise a production shift, quality and safety on the floor.",
      status: "APPROVED", attributes: {},
    });
    bump("positions");
  }

  // Leave types (statutory values are configurable; these are editable baselines)
  if ((await count("leave_types")) === 0) {
    const leaveTypes = [
      ["ANNUAL", "Annual Leave", "ANNUAL", 18, 15, true],
      ["SICK", "Sick Leave", "SICK", 12, 7, true],
      ["MATERNITY", "Maternity Leave", "MATERNITY", 60, 60, true],
      ["PATERNITY", "Paternity Leave", "PATERNITY", 4, 4, true],
      ["COMPASSIONATE", "Compassionate Leave", "COMPASSIONATE", 5, 5, true],
      ["STUDY", "Study Leave", "STUDY", 10, 30, true],
      ["UNPAID", "Unpaid Leave", "UNPAID", 0, 30, false],
      ["BEREAVEMENT", "Bereavement Leave", "BEREAVEMENT", 3, 3, true],
      ["PUBLIC", "Public Holiday", "PUBLIC", 0, 1, false],
    ];
    for (const [code, name, category, daysPerYear, maxConsecutive, isPaid] of leaveTypes) {
      await insertOne(client, "leave_types", {
        company_id: companyId, tenant_id: tenantId, code, name, category,
        days_per_year: daysPerYear, max_consecutive_days: maxConsecutive,
        carryover_limit: 0, is_paid: isPaid, requires_approval: true, status: "ACTIVE",
      });
      bump("leave_types");
    }
  }

  // Leave policies + monthly-proportion accrual rules
  if ((await count("leave_policies")) === 0) {
    const types = await client.query(
      "SELECT id, code, days_per_year FROM leave_types WHERE company_id = $1 AND tenant_id = $2",
      [companyId, tenantId]
    );
    for (const lt of types.rows) {
      const policyId = await insertOne(client, "leave_policies", {
        company_id: companyId, tenant_id: tenantId, code: "LP-" + lt.code,
        name: String(lt.code) + " Leave Policy", leave_type_id: lt.id,
        applies_to: "ALL", accrual_method: "MONTHLY_PROPORTION",
        effective_from: "2026-01-01", status: "ACTIVE",
      });
      bump("leave_policies");
      await insertOne(client, "leave_accrual_rules", {
        company_id: companyId, tenant_id: tenantId, policy_id: policyId,
        rule_type: "MONTHLY_PROPORTION",
        accrual_rate: Number(lt.days_per_year) || 0,
        cap: 30, minimum_service_days: 0,
      });
      bump("leave_accrual_rules");
    }
  }

  // Public holidays (no unique constraint; guarded at company+tenant level)
  if ((await count("holidays")) === 0) {
    const holidays = [
      ["New Year's Day", "2026-01-01"],
      ["NRM Liberation Day", "2026-01-26"],
      ["International Women's Day", "2026-03-08"],
      ["Labour Day", "2026-05-01"],
      ["Martyrs' Day", "2026-06-03"],
      ["Independence Day", "2026-10-09"],
      ["Christmas Day", "2026-12-25"],
      ["Boxing Day", "2026-12-26"],
    ];
    for (const [name, holidayDate] of holidays) {
      await insertOne(client, "holidays", {
        company_id: companyId, tenant_id: tenantId, name,
        holiday_date: holidayDate, is_recurring: true, country: "UG",
      });
      bump("holidays");
    }
  }

  // Onboarding checklist + tasks
  if ((await count("onboarding_checklists")) === 0) {
    const checklistId = await insertOne(client, "onboarding_checklists", {
      company_id: companyId, tenant_id: tenantId, code: "OB-STD",
      name: "Standard Onboarding Checklist",
      description: "Standard new-hire onboarding for HDG.", status: "ACTIVE",
    });
    bump("onboarding_checklists");
    const tasks = [
      ["T01", "Collect National ID & TIN", "DOCUMENT", 0, 10],
      ["T02", "Issue Laptop & Access Card", "EQUIPMENT", 1, 20],
      ["T03", "Create Email & System Accounts", "ACCOUNT", 1, 30],
      ["T04", "Health & Safety Induction", "TRAINING", 2, 40],
      ["T05", "Office Orientation", "ORIENTATION", 2, 50],
      ["T06", "IT Systems Training", "IT", 3, 60],
    ];
    for (const [taskNo, title, category, dueDays, sortOrder] of tasks) {
      await insertOne(client, "onboarding_tasks", {
        company_id: companyId, tenant_id: tenantId, checklist_id: checklistId,
        task_no: taskNo, title, category, due_days: dueDays, is_required: true,
        sort_order: sortOrder, status: "ACTIVE",
      });
      bump("onboarding_tasks");
    }
  }

  // Offboarding checklist + tasks (exit clearance)
  if ((await count("offboarding_checklists")) === 0) {
    const offChecklistId = await insertOne(client, "offboarding_checklists", {
      company_id: companyId, tenant_id: tenantId, code: "EXIT-STD",
      name: "Standard Offboarding Checklist",
      description: "Standard employee exit and clearance for HDG.", status: "ACTIVE",
    });
    bump("offboarding_checklists");
    const exitTasks = [
      ["X01", "Manager review & handover", "CLEARANCE", 0, 10],
      ["X02", "Return company assets (laptop, phone, access card)", "ASSET_RETURN", 1, 20],
      ["X03", "IT account & system access revocation", "IT_ACCESS", 1, 30],
      ["X04", "Finance clearance (advances, loans, expenses)", "FINANCE_CLEARANCE", 2, 40],
      ["X05", "Return company documents & records", "DOCUMENT_RETURN", 2, 50],
      ["X06", "Final settlement & statutory reporting (PAYE/NSSF)", "FINAL_SETTLEMENT", 3, 60],
      ["X07", "Exit interview", "EXIT_INTERVIEW", 3, 70],
    ];
    for (const [taskNo, title, category, dueDays, sortOrder] of exitTasks) {
      await insertOne(client, "offboarding_tasks", {
        company_id: companyId, tenant_id: tenantId, checklist_id: offChecklistId,
        task_no: taskNo, title, category, due_days: dueDays, is_required: true,
        sort_order: sortOrder, status: "ACTIVE",
      });
      bump("offboarding_tasks");
    }
  }

  // Training catalogue + scheduled sessions
  if ((await count("training_catalog")) === 0) {
    const courses = [
      ["FIRST-AID", "First Aid & Emergency Response", "SAFETY", 8, "Uganda Red Cross", 350000],
      ["FOOD-SAFETY", "Food Safety & Hygiene", "SAFETY", 6, "KCCA Health Inspectorate", 250000],
      ["MSOFFICE", "Microsoft Office Essentials", "SKILLS", 16, "ICT Training Centre", 400000],
      ["GDPR", "Data Protection & Confidentiality", "COMPLIANCE", 4, "Internal", 0],
    ];
    for (const [code, title, category, durationHours, provider, cost] of courses) {
      const trainingId = await insertOne(client, "training_catalog", {
        company_id: companyId, tenant_id: tenantId, code, title, category,
        duration_hours: durationHours, provider, cost, status: "ACTIVE",
      });
      bump("training_catalog");
      await insertOne(client, "training_sessions", {
        company_id: companyId, tenant_id: tenantId, training_id: trainingId,
        code: "TRN-" + code + "-01", trainer: provider,
        start_date: "2026-09-15", end_date: "2026-09-16",
        location: "HDG Training Room", capacity: 20, cost, status: "SCHEDULED",
      });
      bump("training_sessions");
    }
  }

  // Benefit plans
  if ((await count("benefit_plans")) === 0) {
    const benefits = [
      ["MED-CORE", "Core Medical Cover", "MEDICAL", "Jubilee Insurance", 150000],
      ["GPA-INSURANCE", "Group Personal Accident", "INSURANCE", "Jubilee Insurance", 20000],
      ["MEAL-ALLOWANCE", "Meal Allowance", "MEAL", null, 120000],
      ["TRANSPORT-ALLOWANCE", "Transport Allowance", "TRANSPORT", null, 100000],
    ];
    for (const [code, name, category, provider, employerContribution] of benefits) {
      await insertOne(client, "benefit_plans", {
        company_id: companyId, tenant_id: tenantId, code, name, category, provider,
        cost: employerContribution, employee_contribution: 0,
        employer_contribution: employerContribution, eligibility_rule: {},
        status: "ACTIVE",
      });
      bump("benefit_plans");
    }
  }

  // Asset categories + assets
  if ((await count("asset_categories")) === 0) {
    await insertOne(client, "asset_categories", {
      company_id: companyId, tenant_id: tenantId, code: "IT-EQUIP",
      name: "IT Equipment", depreciation_method: "STRAIGHT_LINE", default_life_years: 3,
    });
    bump("asset_categories");
    await insertOne(client, "asset_categories", {
      company_id: companyId, tenant_id: tenantId, code: "OFFICE-EQUIP",
      name: "Office Equipment", depreciation_method: "STRAIGHT_LINE", default_life_years: 5,
    });
    bump("asset_categories");
  }
  const catIt = await row("asset_categories", "code", "IT-EQUIP");
  const catOffice = await row("asset_categories", "code", "OFFICE-EQUIP");
  if ((await count("assets")) === 0) {
    await insertOne(client, "assets", {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      category_id: catIt, code: "AST-LAPTOP-001", name: "Laptop - Dell XPS",
      serial_no: "SN-XPS-1001", purchase_date: "2026-01-15",
      purchase_cost: 4500000, useful_life_years: 3, depreciation_method: "STRAIGHT_LINE",
      accumulated_depreciation: 0, salvage_value: 0, status: "IN_STORE", attributes: {},
    });
    bump("assets");
    await insertOne(client, "assets", {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      category_id: catOffice, code: "AST-PHONE-001", name: "Office Phone",
      serial_no: null, purchase_date: "2026-01-15", purchase_cost: 800000,
      useful_life_years: 5, depreciation_method: "STRAIGHT_LINE",
      accumulated_depreciation: 0, salvage_value: 0, status: "IN_STORE", attributes: {},
    });
    bump("assets");
  }

  // Recruitment + workforce-plan approval workflows (fail-closed: amount_max 0)
  const wfRes = await client.query(
    "SELECT code FROM workflows WHERE company_id = $1 AND tenant_id = $2 AND code IN ('WF-REQ','WF-WFP')",
    [companyId, tenantId]
  );
  const existingWf = new Set(wfRes.rows.map((r) => String(r.code)));
  const wfDefs = [
    {
      code: "WF-REQ",
      name: "Job Requisition Approval",
      entity_type: "hr.requisitions",
      desc: "Single HR Manager approval for job requisitions.",
      steps: [
        { seq: 1, name: "HR Manager Approval", approver_role: "hr_manager", amount_min: 0, amount_max: 0, sla_hours: 24 },
      ],
    },
    {
      code: "WF-WFP",
      name: "Workforce Plan Approval",
      entity_type: "hr.workforce_plans",
      desc: "Single HR Manager approval for workforce plans.",
      steps: [
        { seq: 1, name: "HR Manager Approval", approver_role: "hr_manager", amount_min: 0, amount_max: 0, sla_hours: 24 },
      ],
    },
  ];
  for (const w of wfDefs) {
    if (existingWf.has(w.code)) continue;
    await insertOne(client, "workflows", {
      company_id: companyId, tenant_id: tenantId, code: w.code, name: w.name,
      entity_type: w.entity_type, description: w.desc, config: w.steps, is_active: true,
    });
    bump("workflows");
  }

  return { inserted };
}


// Uganda Employment Contract Builder baseline. Idempotent: employment types,
// legal rules, sections and variables are tenant-wide; templates and clauses
// are seeded for the HDG company. Legal values are versioned DB rows so future
// amendments to the Employment Act are a config update, never a code change.
async function ensureContractBuilderSeed(client, tenantId, companyId = null) {
  const inserted = {};
  const bump = (t, n = 1) => { inserted[t] = (inserted[t] || 0) + n; };
  if (!companyId) {
    const { rows } = await client.query(
      "SELECT id FROM companies WHERE tenant_id = $1 AND code = 'HDG'",
      [tenantId]
    );
    if (rows.length === 0) return { inserted };
    companyId = rows[0].id;
  }
  const exists = async (table, whereSql, params) => {
    const { rows } = await client.query(`SELECT 1 FROM ${table} WHERE ${whereSql} LIMIT 1`, params);
    return rows.length > 0;
  };

  // ---- employment types (tenant-wide, company NULL) ----
  const empTypes = [
    { code: "PERMANENT", name: "Permanent Employment", is_employment: true, notice_basis: "STATUTORY", warning: null },
    { code: "FIXED_TERM", name: "Fixed-Term Employment", is_employment: true, notice_basis: "STATUTORY", warning: null },
    { code: "PROBATIONARY", name: "Probationary Employment", is_employment: true, max_duration_days: 180, notice_basis: "STATUTORY", warning: "Probation may not exceed six months under the Employment Act (Cap. 226), as amended." },
    { code: "PART_TIME", name: "Part-Time Employment", is_employment: true, notice_basis: "STATUTORY", warning: null },
    { code: "TEMPORARY", name: "Temporary Employment", is_employment: true, notice_basis: "STATUTORY", warning: null },
    { code: "APPRENTICESHIP", name: "Apprenticeship", is_employment: true, notice_basis: "STATUTORY", warning: null },
    { code: "CASUAL", name: "Casual Employment", is_employment: true, notice_basis: "STATUTORY", warning: null },
    { code: "INTERNSHIP", name: "Internship", is_employment: true, notice_basis: "STATUTORY", warning: null },
    { code: "CONSULTANCY", name: "Consultancy / Independent Contractor", is_employment: false, notice_basis: null, warning: "Consultants and independent contractors are not employees under the Employment Act (Cap. 226), as amended. Use a consultancy agreement rather than an employment contract unless the relationship is in fact one of employment." },
    { code: "SECONDMENT", name: "Secondment", is_employment: true, notice_basis: "STATUTORY", warning: null },
  ];
  for (const t of empTypes) {
    if (await exists("employment_types", "tenant_id = $1 AND code = $2", [tenantId, t.code])) continue;
    await insertOne(client, "employment_types", { company_id: null, tenant_id: tenantId, ...t, status: "ACTIVE" });
    bump("employment_types");
  }
  // ---- legal rules (tenant-wide, company NULL) ----
  const law = "Employment Act (Cap. 226, Laws of Uganda), as amended";
  const chapter = "Cap. 226";
  const source = "ULII consolidation of the Employment Act (current version 5 June 2026, including the Employment (Amendment) Act, 2025)";
  const legalDefs = [
    { code: "NOTICE_PERIOD", name: "Notice of Termination of Contract", section: "s.58(3)", enforcement: "HARD", effective_from: "2006-08-23",
      description: "Minimum statutory notice periods based on continuous service.",
      rules: [
        { service_months_min: 6, service_months_max: 12, notice_days: 14, label: "More than 6 months up to 1 year" },
        { service_months_min: 12, service_months_max: 60, notice_days: 30, label: "More than 1 year up to 5 years" },
        { service_months_min: 60, service_months_max: 120, notice_days: 60, label: "More than 5 years up to 10 years" },
        { service_months_min: 120, service_months_max: null, notice_days: 90, label: "More than 10 years" },
      ] },
    { code: "PROBATION_MAX_DURATION", name: "Maximum Probationary Period", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "A probationary period may not exceed six months.",
      rules: { max_duration_days: 180, max_duration_label: "6 months" } },
    { code: "ANNUAL_LEAVE", name: "Annual Leave", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "At least 21 working days paid annual leave per year, accruing at 7 days per 4 months of service.",
      rules: { annual_leave_days: 21, accrual_days_per_4_months: 7 } },
    { code: "SICK_LEAVE", name: "Sick Leave", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "Paid sick leave of 12 working days per year, available after one month of service and on production of a medical certificate. An employee absent due to sickness is entitled to retain employment for up to six months of sick absence in any period of twelve months.",
      rules: { sick_leave_days: 12, qualifying_months: 1, medical_certificate: true, sick_absence_months: 6 } },
    { code: "MATERNITY_LEAVE", name: "Maternity Leave", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "Paid maternity leave of 60 working days.",
      rules: { maternity_leave_days: 60 } },
    { code: "PATERNITY_LEAVE", name: "Paternity Leave", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "Paid paternity leave of 4 working days.",
      rules: { paternity_leave_days: 4 } },
    { code: "CERTIFICATE_OF_SERVICE", name: "Certificate of Service", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "An employer must provide a certificate of service on termination of employment stating the period of employment, capacity and wages.",
      rules: { required_on_termination: true, fields: ["period_of_employment", "capacity", "wages"] } },
    { code: "STATUTORY_RIGHTS_NON_WAIVER", name: "Statutory Rights May Not Be Waived", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "No contract may remove, reduce or contract out of statutory employment rights.",
      rules: { block_clause_patterns: ["waive all statutory", "waive statutory rights", "contract out of", "renounce all statutory"] } },
    { code: "WRITTEN_PARTICULARS", name: "Written Particulars of Employment", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "The employer must give the employee a written statement of key particulars of employment within the statutory period.",
      rules: { required_particulars: ["employer_identity", "employee_identity", "start_date", "job_title", "workplace", "compensation", "payment_interval", "working_hours", "leave", "notice"] } },
    { code: "WORKING_TIME", name: "Hours of Work", section: "s.52", enforcement: "HARD", effective_from: "2006-08-23",
      description: "Normal working hours may not exceed 8 hours a day or 48 hours a week. Work beyond normal hours is overtime and attracts the statutory premium; shifts of 8 hours or more require a rest break of at least 30 minutes.",
      rules: { max_hours_per_day: 8, max_hours_per_week: 48, break_minutes_min: 30, break_trigger_hours: 8 } },
    { code: "WEEKLY_REST", name: "Weekly Rest", section: "s.50", enforcement: "HARD", effective_from: "2006-08-23",
      description: "An employee is entitled to at least 24 consecutive hours of rest in each week and may not be required to work more than six consecutive working days.",
      rules: { weekly_rest_hours_min: 24, max_consecutive_working_days: 6 } },
    { code: "PUBLIC_HOLIDAYS", name: "Public Holidays", section: "s.53", enforcement: "HARD", effective_from: "2006-08-23",
      description: "An employee is entitled to paid leave on public holidays; work performed on a public holiday must be paid at not less than twice the normal rate.",
      rules: { paid_public_holidays: true, public_holiday_rate_multiplier: 2 } },
    { code: "OVERTIME_RATE", name: "Overtime Premium", section: "s.52", enforcement: "HARD", effective_from: "2006-08-23",
      description: "Overtime must be paid at a rate not less than one and a half times the normal rate, and at not less than twice the normal rate for work on a public holiday.",
      rules: { overtime_rate_multiplier: 1.5, public_holiday_rate_multiplier: 2 } },
    { code: "PAYMENT_OF_WAGES", name: "Payment of Wages", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "Wages must be paid in full, in Uganda Shillings, at intervals of not more than one month, with a written pay slip recording amounts paid and deductions made.",
      rules: { payment_currency: "UGX", max_payment_interval_days: 30, pay_slip_required: true } },
    { code: "DEDUCTIONS", name: "Permitted Deductions from Wages", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "Deductions from wages are permitted only where required or authorised by law, by court order, or with the written agreement of the employee.",
      rules: { permitted_bases: ["statutory", "court_order", "written_agreement"] } },
    { code: "NON_DISCRIMINATION", name: "Non-Discrimination", section: "s.5", enforcement: "HARD", effective_from: "2006-08-23",
      description: "An employer may not discriminate against an employee or job applicant on grounds including race, colour, sex, religion, political opinion or affiliation, ethnic origin, family responsibility, disability or HIV status.",
      rules: { prohibited_grounds: ["race", "colour", "sex", "religion", "political_opinion", "ethnic_origin", "family_responsibility", "disability", "hiv_status"] } },
    { code: "EQUAL_PAY", name: "Equal Pay for Work of Equal Value", section: "s.5(7)", enforcement: "HARD", effective_from: "2006-08-23",
      description: "Men and women performing work of equal value are entitled to equal remuneration.",
      rules: { equal_value_equal_pay: true } },
    { code: "FORCED_LABOUR", name: "Prohibition of Forced Labour", section: "s.4", enforcement: "HARD", effective_from: "2006-08-23",
      description: "Forced or compulsory labour is prohibited. An employer may not compel an employee to work under threat or without voluntary consent.",
      rules: { forced_labour_prohibited: true } },
    { code: "CHILD_LABOUR", name: "Prohibition of Child Labour", section: "s.7", enforcement: "HARD", effective_from: "2006-08-23",
      description: "A person below 15 years of age may not be employed. A young person aged 15 to 17 may be employed only with the written authorisation of the Commissioner and subject to restrictions on hazardous work and night work.",
      rules: { minimum_age: 15, young_person_min: 15, young_person_max: 17, commissioner_authorisation: true, hazardous_work_prohibited: true, night_work_prohibited: true } },
    { code: "CASUAL_EMPLOYMENT", name: "Casual Employment", section: null, enforcement: "HARD", effective_from: "2011-06-01",
      description: "An employee engaged on a casual basis for a continuous period exceeding four months must be provided with a written contract and the statutory written particulars (Employment (Minimum Standards) Regulations, 2011, reg. 39).",
      rules: { written_contract_after_months: 4 } },
    { code: "UNFAIR_TERMINATION", name: "Unfair Termination", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "A termination is unfair if the employer fails to prove a valid reason connected with the employee's capacity, conduct or the employer's operational requirements, and fails to give the employee a fair hearing.",
      rules: { valid_reason_required: true, fair_hearing_required: true } },
    { code: "PREGNANCY_PROTECTION", name: "Protection from Dismissal for Pregnancy", section: "s.75(a)", enforcement: "HARD", effective_from: "2006-08-23",
      description: "An employer may not dismiss an employee on account of pregnancy or an illness arising out of pregnancy.",
      rules: { dismissal_on_pregnancy_prohibited: true } },
    { code: "SEXUAL_HARASSMENT", name: "Sexual Harassment", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "Sexual harassment in the workplace is prohibited. The employer must put in place a policy against sexual harassment, display it prominently at the workplace, and take reasonable steps to prevent and address harassment.",
      rules: { prohibited: true, employer_prevention_duty: true, policy_displayed_at_workplace: true } },
    { code: "EMPLOYMENT_RECORDS", name: "Employment Records", section: null, enforcement: "HARD", effective_from: "2006-08-23",
      description: "An employer must keep accurate records of each employee's particulars, working hours, wages and leave, and produce them for inspection by a labour officer on request.",
      rules: { record_fields: ["employee_particulars", "working_hours", "wages", "leave"], produce_for_labour_officer: true } },
    { code: "INTIMIDATION_HARASSMENT", name: "Prohibition of Intimidation and Harassment", section: "s.6A", enforcement: "HARD", effective_from: "2026-06-05",
      description: "An employer must not intimidate, harass or victimise an employee, and a copy of the employer's policy prohibiting such conduct must be displayed at the workplace (Employment (Amendment) Act, 2025, inserting s.6A).",
      rules: { prohibited: true, policy_displayed_at_workplace: true } },
    { code: "PROBATION_TERMINATION_NOTICE", name: "Notice During Probation", section: "s.58(3)", enforcement: "HARD", effective_from: "2026-06-05",
      description: "Termination of a probationary contract requires not less than one month's notice, unless summary dismissal applies (Employment (Amendment) Act, 2025).",
      rules: { notice_days: 30 } },
    { code: "SEVERANCE_ALLOWANCE", name: "Severance Allowance on Redundancy", section: null, enforcement: "HARD", effective_from: "2026-06-05",
      description: "An employee declared redundant is entitled to severance pay of not less than one month's salary for each completed year of continuous service (Employment (Amendment) Act, 2025).",
      rules: { months_per_completed_year: 1 } },
    { code: "OHS_COMMITTEES", name: "Safety and Health Committees", section: null, enforcement: "HARD", effective_from: "2026-06-05",
      description: "Every workplace must establish a safety and health committee, and mental health support is a mandatory part of the employer's occupational safety and health obligations (Employment (Amendment) Act, 2025).",
      rules: { required_for_all_workplaces: true, mental_health_support_required: true } },
    { code: "MIGRANT_WORKERS", name: "Protection of Migrant Workers", section: null, enforcement: "HARD", effective_from: "2026-06-05",
      description: "Migrant workers enjoy the same statutory protections as other employees, including written particulars, fair termination and freedom from intimidation and harassment (Employment Act (Cap. 226), Part IXA, as amended).",
      rules: { equal_statutory_protection: true } },
  ];
  for (const d of legalDefs) {
    if (await exists("legal_rules", "tenant_id = $1 AND code = $2 AND version = 1", [tenantId, d.code])) continue;
    await insertOne(client, "legal_rules", {
      company_id: null, tenant_id: tenantId, code: d.code, name: d.name, law, law_chapter: chapter,
      section: d.section ?? null, description: d.description, rules: d.rules, version: 1,
      status: "ACTIVE", enforcement: d.enforcement, effective_from: d.effective_from,
      effective_to: null, source,
    });
    bump("legal_rules");
  }
  // version 2 snapshots reflecting earlier amendments and the 2026 consolidation
  const v2Snapshots = [
    { code: "NOTICE_PERIOD" },
    { code: "WRITTEN_PARTICULARS" },
    {
      code: "SICK_LEAVE",
      description: "Paid sick leave of 12 working days per year, available after one month of service, with a medical certificate required for an absence of 7 or more consecutive days. An employee absent due to sickness is entitled to retain employment for up to six months of sick absence in any period of twelve months (as amended by the Employment (Amendment) Act, 2025; consolidated in the ULII current version 5 June 2026).",
      rulesOverride: { sick_leave_days: 12, qualifying_months: 1, medical_certificate: true, certificate_required_after_days: 7, sick_absence_months: 6 },
    },
  ];
  for (const snap of v2Snapshots) {
    const code = snap.code;
    if (await exists("legal_rules", "tenant_id = $1 AND code = $2 AND version = 2", [tenantId, code])) continue;
    const base = await client.query(
      "SELECT * FROM legal_rules WHERE tenant_id = $1 AND code = $2 AND version = 1", [tenantId, code]
    );
    if (base.rows.length === 0) continue;
    const b = base.rows[0];
    await insertOne(client, "legal_rules", {
      company_id: null, tenant_id: tenantId, code, name: b.name, law: b.law, law_chapter: b.law_chapter,
      section: b.section,
      description: snap.description ?? `${b.description} (as amended by the Employment (Amendment) Act, 2025; ULII current version 5 June 2026.)`,
      rules: snap.rulesOverride ?? b.rules, version: 2, status: "ACTIVE", enforcement: b.enforcement,
      effective_from: "2026-06-05", effective_to: null, source,
    });
    bump("legal_rules");
  }

  // version 3 snapshots reflecting the Employment (Amendment) Act, 2025
  const v3Snapshots = [
    {
      code: "SICK_LEAVE",
      description: "Paid sick leave of 12 working days per year, available after one month of service, with a medical certificate required for an absence of 7 or more consecutive days. An employee absent due to sickness is entitled to retain employment for up to six months of sick absence in any period of twelve months.",
      rulesOverride: { sick_leave_days: 12, qualifying_months: 1, medical_certificate: true, certificate_required_after_days: 7, sick_absence_months: 6 },
    },
    {
      code: "CASUAL_EMPLOYMENT",
      description: "An employee engaged on a casual basis may not be employed for a continuous period exceeding six months; the employee must then be engaged under a written contract of employment with the statutory written particulars (Employment Act (Cap. 226), s.34A, as amended).",
      rulesOverride: { written_contract_after_months: 6, max_continuous_months: 6 },
    },
    {
      code: "SEXUAL_HARASSMENT",
      description: "Sexual harassment in the workplace is prohibited. The employer must put in place a policy against sexual harassment, display it prominently at the workplace, and take reasonable steps to prevent and address harassment.",
      rulesOverride: { prohibited: true, employer_prevention_duty: true, policy_displayed_at_workplace: true },
    },
    {
      code: "PROBATION_MAX_DURATION",
      description: "A probationary period may not exceed six months, and termination of a probationary contract requires not less than one month's notice unless summary dismissal applies.",
      rulesOverride: { max_duration_days: 180, max_duration_label: "6 months", termination_notice_days: 30 },
    },
  ];
  for (const snap of v3Snapshots) {
    const code = snap.code;
    if (await exists("legal_rules", "tenant_id = $1 AND code = $2 AND version = 3", [tenantId, code])) continue;
    const base = await client.query(
      "SELECT * FROM legal_rules WHERE tenant_id = $1 AND code = $2 ORDER BY version DESC LIMIT 1", [tenantId, code]
    );
    if (base.rows.length === 0) continue;
    const b = base.rows[0];
    await insertOne(client, "legal_rules", {
      company_id: null, tenant_id: tenantId, code, name: b.name, law: b.law, law_chapter: b.law_chapter,
      section: b.section,
      description: snap.description ?? `${b.description} (as amended by the Employment (Amendment) Act, 2025; ULII current version 5 June 2026.)`,
      rules: snap.rulesOverride ?? b.rules, version: 3, status: "ACTIVE", enforcement: b.enforcement,
      effective_from: "2026-06-05", effective_to: null, source,
    });
    bump("legal_rules");
  }

  // ---- contract sections + variables (tenant-wide) ----
  const sections = [
    { code: "EMPLOYER", name: "Employer", sort_order: 1, is_required: true },
    { code: "EMPLOYEE", name: "Employee", sort_order: 2, is_required: true },
    { code: "EMPLOYMENT", name: "Employment", sort_order: 3, is_required: true },
    { code: "COMPENSATION", name: "Compensation", sort_order: 4, is_required: true },
    { code: "DUTIES", name: "Duties", sort_order: 5, is_required: true },
    { code: "WORKING_HOURS", name: "Working Hours", sort_order: 6, is_required: true },
    { code: "LEAVE", name: "Leave", sort_order: 7, is_required: true },
    { code: "PROBATION", name: "Probation", sort_order: 8, is_required: false },
    { code: "CONFIDENTIALITY", name: "Confidentiality", sort_order: 9, is_required: false },
    { code: "TERMINATION", name: "Termination", sort_order: 10, is_required: true },
    { code: "SIGNATURES", name: "Signatures", sort_order: 11, is_required: true },
    { code: "GENERAL", name: "General", sort_order: 12, is_required: false },
    { code: "RIGHTS", name: "Rights & Non-Discrimination", sort_order: 13, is_required: false },
  ];
  for (const s of sections) {
    if (await exists("contract_sections", "tenant_id = $1 AND code = $2", [tenantId, s.code])) continue;
    await insertOne(client, "contract_sections", { company_id: null, tenant_id: tenantId, ...s, status: "ACTIVE" });
    bump("contract_sections");
  }
  const variables = [
    ["employee.full_name", "Employee full name", "employee", "text", true],
    ["employee.employee_number", "Employee number", "employee", "text", true],
    ["employee.address", "Employee residential address", "employee", "text", false],
    ["employee.job_title", "Job title", "employee", "text", true],
    ["employee.department", "Department", "employee", "text", false],
    ["employee.manager", "Reporting manager", "employee", "text", false],
    ["employment.start_date", "Employment start date", "employment", "date", true],
    ["employment.contract_end_date", "Contract end date (fixed term)", "employment", "date", false],
    ["employment.contract_type", "Contract type", "employment", "text", true],
    ["employment.contract_no", "Contract number", "employment", "text", true],
    ["salary.basic", "Basic salary", "salary", "money", true],
    ["salary.gross", "Gross salary", "salary", "money", true],
    ["salary.currency", "Salary currency", "salary", "text", true],
    ["salary.pay_frequency", "Pay frequency", "salary", "text", true],
    ["company.legal_name", "Company legal name", "company", "text", true],
    ["company.address", "Company address", "company", "text", false],
    ["company.representative", "Company representative", "company", "text", false],
    ["company.representative_title", "Company representative title", "company", "text", false],
    ["workplace.location", "Work location", "workplace", "text", true],
    ["working_hours", "Working hours per week", "employment", "text", true],
    ["annual_leave_days", "Annual leave days", "leave", "number", true],
    ["probation.end_date", "Probation end date", "probation", "date", false],
    ["contract.notice_period", "Notice period (days)", "termination", "number", true],
  ];
  for (const v of variables) {
    if (await exists("contract_variables", "tenant_id = $1 AND code = $2", [tenantId, v[0]])) continue;
    await insertOne(client, "contract_variables", {
      company_id: null, tenant_id: tenantId, code: v[0], name: v[1], category: v[2],
      source: v[2], data_type: v[3], is_required: v[4], status: "ACTIVE",
    });
    bump("contract_variables");
  }

  // ---- helper for TEXT[] columns (json() cannot encode Postgres arrays) ----
  const pgArr = (arr) => (arr && arr.length ? "{" + arr.join(",") + "}" : "{}");

  // ---- contract templates (HDG company) ----
  const templateDefs = [
    { code: "TMPL-PERM", name: "Permanent Employment Contract", contract_type: "PERMANENT",
      description: "Standard permanent employment contract with the statutory written particulars.",
      content: [
        { section_code: "EMPLOYER", clauses: [] },
        { section_code: "EMPLOYEE", clauses: [] },
        { section_code: "EMPLOYMENT", clauses: ["APPOINTMENT"] },
        { section_code: "DUTIES", clauses: ["DUTIES", "OHS_COMMITTEE"] },
        { section_code: "COMPENSATION", clauses: ["SALARY", "ALLOWANCES", "OVERTIME"] },
        { section_code: "WORKING_HOURS", clauses: ["WORKING_HOURS"] },
        { section_code: "LEAVE", clauses: ["ANNUAL_LEAVE", "SICK_LEAVE", "MATERNITY_LEAVE", "PATERNITY_LEAVE"] },
{ section_code: "RIGHTS", clauses: ["NON_DISCRIMINATION", "EQUAL_PAY", "SEXUAL_HARASSMENT", "INTIMIDATION_HARASSMENT", "FORCED_LABOUR_PROHIBITION", "CHILD_LABOUR_PROHIBITION", "PREGNANCY_PROTECTION"] },
        { section_code: "CONFIDENTIALITY", clauses: ["CONFIDENTIALITY", "DATA_PROTECTION", "INTELLECTUAL_PROPERTY", "COMPANY_PROPERTY"] },
        { section_code: "TERMINATION", clauses: ["NOTICE", "TERMINATION", "REDUNDANCY", "SEVERANCE_ALLOWANCE", "DISCIPLINARY", "GRIEVANCE", "DISPUTE_RESOLUTION"] },
        { section_code: "SIGNATURES", clauses: [] },
      ] },
    { code: "TMPL-FIXED", name: "Fixed-Term Employment Contract", contract_type: "FIXED_TERM",
      description: "Fixed-term employment contract with expiry tracking and renewal provisions.",
      content: [
        { section_code: "EMPLOYER", clauses: [] },
        { section_code: "EMPLOYEE", clauses: [] },
        { section_code: "EMPLOYMENT", clauses: ["APPOINTMENT", "FIXED_TERM"] },
        { section_code: "DUTIES", clauses: ["DUTIES", "OHS_COMMITTEE"] },
        { section_code: "COMPENSATION", clauses: ["SALARY", "ALLOWANCES", "OVERTIME"] },
        { section_code: "WORKING_HOURS", clauses: ["WORKING_HOURS"] },
        { section_code: "LEAVE", clauses: ["ANNUAL_LEAVE", "SICK_LEAVE", "MATERNITY_LEAVE", "PATERNITY_LEAVE"] },
{ section_code: "RIGHTS", clauses: ["NON_DISCRIMINATION", "EQUAL_PAY", "SEXUAL_HARASSMENT", "INTIMIDATION_HARASSMENT", "FORCED_LABOUR_PROHIBITION", "CHILD_LABOUR_PROHIBITION", "PREGNANCY_PROTECTION"] },
        { section_code: "CONFIDENTIALITY", clauses: ["CONFIDENTIALITY", "DATA_PROTECTION"] },
        { section_code: "TERMINATION", clauses: ["NOTICE", "TERMINATION", "DISCIPLINARY", "GRIEVANCE", "DISPUTE_RESOLUTION", "SEVERANCE_ALLOWANCE"] },
        { section_code: "SIGNATURES", clauses: [] },
      ] },
    { code: "TMPL-PROB", name: "Probationary Employment Contract", contract_type: "PROBATIONARY",
      description: "Probationary contract capped at the statutory maximum of six months.",
      content: [
        { section_code: "EMPLOYER", clauses: [] },
        { section_code: "EMPLOYEE", clauses: [] },
        { section_code: "EMPLOYMENT", clauses: ["APPOINTMENT", "PROBATION"] },
        { section_code: "DUTIES", clauses: ["DUTIES", "OHS_COMMITTEE"] },
        { section_code: "COMPENSATION", clauses: ["SALARY"] },
        { section_code: "WORKING_HOURS", clauses: ["WORKING_HOURS"] },
        { section_code: "LEAVE", clauses: ["ANNUAL_LEAVE", "SICK_LEAVE"] },
        { section_code: "TERMINATION", clauses: ["NOTICE", "TERMINATION", "DISCIPLINARY", "GRIEVANCE"] },
        { section_code: "SIGNATURES", clauses: [] },
      ] },
    { code: "TMPL-VAR", name: "Contract Variation / Addendum", contract_type: "VARIATION",
      description: "Formal addendum varying an executed contract without rewriting history.",
      content: [
        { section_code: "EMPLOYER", clauses: [] },
        { section_code: "EMPLOYEE", clauses: [] },
        { section_code: "EMPLOYMENT", clauses: ["VARIATION"] },
        { section_code: "COMPENSATION", clauses: ["SALARY"] },
        { section_code: "SIGNATURES", clauses: [] },
      ] },
    { code: "TMPL-PROMO", name: "Promotion Letter", contract_type: "PROMOTION",
      description: "Promotion letter recording new position, department and compensation.",
      content: [
        { section_code: "EMPLOYER", clauses: [] },
        { section_code: "EMPLOYEE", clauses: [] },
        { section_code: "EMPLOYMENT", clauses: ["PROMOTION"] },
        { section_code: "COMPENSATION", clauses: ["SALARY"] },
        { section_code: "SIGNATURES", clauses: [] },
      ] },
    { code: "TMPL-SAL", name: "Salary Adjustment Letter", contract_type: "SALARY_ADJUSTMENT",
      description: "Salary adjustment letter recording new basic and gross salary.",
      content: [
        { section_code: "EMPLOYER", clauses: [] },
        { section_code: "EMPLOYEE", clauses: [] },
        { section_code: "COMPENSATION", clauses: ["SALARY"] },
        { section_code: "SIGNATURES", clauses: [] },
      ] },
    { code: "TMPL-COS", name: "Certificate of Service", contract_type: "OTHER",
      description: "Statutory certificate of service issued on termination of employment.",
      content: [
        { section_code: "EMPLOYER", clauses: [] },
        { section_code: "EMPLOYEE", clauses: [] },
        { section_code: "EMPLOYMENT", clauses: ["CERTIFICATE_OF_SERVICE"] },
        { section_code: "SIGNATURES", clauses: [] },
      ] },
  ];
  for (const td of templateDefs) {
    if (await exists("contract_templates", "company_id = $1 AND code = $2", [companyId, td.code])) continue;
    const tid = await insertOne(client, "contract_templates", {
      company_id: companyId, tenant_id: tenantId, code: td.code, name: td.name,
      description: td.description ?? null, contract_type: td.contract_type,
      is_approved: true, status: "ACTIVE", approved_by: null, approved_at: new Date().toISOString(),
    });
    bump("contract_templates");
    await insertOne(client, "contract_template_versions", {
      company_id: companyId, tenant_id: tenantId, template_id: tid, version: 1, name: td.name,
      sections: td.content, content: td.content,
      header: null, footer: null, status: "ACTIVE",
    });
    bump("contract_template_versions");
  }

  // ---- contract clauses (HDG company) ----
  const ALL_EMP = pgArr(["PERMANENT","FIXED_TERM","PROBATIONARY","PART_TIME","TEMPORARY","APPRENTICESHIP","CASUAL","INTERNSHIP","SECONDMENT","RENEWAL"]);
  const clauseDefs = [
    { code: "APPOINTMENT", name: "Appointment", category: "Employment", required: "REQUIRED", rule: "WRITTEN_PARTICULARS",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer appoints the Employee to the position of {{employee.job_title}} in the {{employee.department}} department at {{workplace.location}}, effective {{employment.start_date}}. The Employee accepts the appointment and agrees to serve the Employer faithfully and diligently in accordance with this contract and the Employer's policies." },
    { code: "DUTIES", name: "Duties", category: "Job Duties", required: "REQUIRED", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee shall perform the duties of the position diligently and faithfully, comply with lawful and reasonable instructions, and observe all Employer policies, including the Staff Handbook, as amended from time to time." },
    { code: "SALARY", name: "Salary", category: "Salary", required: "REQUIRED", rule: "WRITTEN_PARTICULARS",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer shall pay the Employee a basic salary of {{salary.currency}} {{salary.basic}} per {{salary.pay_frequency}} and a gross salary of {{salary.currency}} {{salary.gross}} per {{salary.pay_frequency}}. Statutory deductions required by law, including PAYE and social security contributions, shall be made as required. Nothing in this contract removes or reduces any statutory entitlement of the Employee." },
    { code: "ALLOWANCES", name: "Allowances", category: "Allowances", required: "CONDITIONAL", rule: null,
      contracts: ALL_EMP, conditions: [{ field: "has_allowances", op: "eq", value: true }], conflicts: [],
      text: "The Employee shall receive the allowances set out in Schedule A to this contract, payable with salary unless otherwise stated." },
    { code: "OVERTIME", name: "Overtime", category: "Overtime", required: "CONDITIONAL", rule: null,
      contracts: ALL_EMP, conditions: [{ field: "overtime_eligible", op: "eq", value: true }], conflicts: [],
      text: "Overtime shall be compensated in accordance with the Employment Act (Cap. 226), as amended and the Employer's overtime policy, at a rate not less than the statutory rate." },
    { code: "WORKING_HOURS", name: "Working Hours", category: "Working Hours", required: "REQUIRED", rule: "WRITTEN_PARTICULARS",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee's normal working hours are {{working_hours}} per week, on the working days agreed with the Employer. The Employee is entitled to rest days as required by law." },
    { code: "ANNUAL_LEAVE", name: "Annual Leave", category: "Leave", required: "REQUIRED", rule: "ANNUAL_LEAVE",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee is entitled to paid annual leave of {{annual_leave_days}} working days per year, accruing at not less than the statutory rate of 7 working days per 4 months of service, in accordance with the Employment Act (Cap. 226), as amended." },
    { code: "SICK_LEAVE", name: "Sick Leave", category: "Leave", required: "REQUIRED", rule: "SICK_LEAVE",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee is entitled to paid sick leave of up to 12 working days per year after one month of service, on production of a medical certificate, and to retain employment during sickness absence of up to six months in any period of twelve months, in accordance with the Employment Act (Cap. 226), as amended." },
    { code: "MATERNITY_LEAVE", name: "Maternity Leave", category: "Leave", required: "REQUIRED", rule: "MATERNITY_LEAVE",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee is entitled to paid maternity leave of 60 working days in accordance with the Employment Act (Cap. 226), as amended." },
    { code: "PATERNITY_LEAVE", name: "Paternity Leave", category: "Leave", required: "REQUIRED", rule: "PATERNITY_LEAVE",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee is entitled to paid paternity leave of 4 working days in accordance with the Employment Act (Cap. 226), as amended." },
    { code: "PROBATION", name: "Probation", category: "Probation", required: "CONDITIONAL", rule: "PROBATION_MAX_DURATION",
      contracts: pgArr(["PROBATIONARY"]), conditions: [{ field: "employment_type", op: "eq", value: "PROBATIONARY" }], conflicts: [],
      text: "The Employee serves a probationary period from {{employment.start_date}} to {{probation.end_date}}. The probationary period shall not exceed six months and may be extended only to the extent permitted by the Employment Act (Cap. 226), as amended. Termination during probation requires not less than one month's notice unless summary dismissal applies." },
    { code: "FIXED_TERM", name: "Fixed-Term Provision", category: "Employment", required: "CONDITIONAL", rule: null,
      contracts: pgArr(["FIXED_TERM","RENEWAL"]), conditions: [{ field: "employment_type", op: "eq", value: "FIXED_TERM" }], conflicts: [],
      text: "This contract is for a fixed term commencing {{employment.start_date}} and ending {{employment.contract_end_date}}. The contract may be renewed by written agreement of the parties before the expiry date." },
    { code: "NOTICE", name: "Notice Period", category: "Notice", required: "REQUIRED", rule: "NOTICE_PERIOD",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "Either party may terminate this contract by giving not less than the statutory notice under the Employment Act (Cap. 226), s.58(3), as amended, being {{contract.notice_period}} days based on the Employee's continuous service, or by payment in lieu where permitted by law." },
    { code: "TERMINATION", name: "Termination", category: "Termination", required: "REQUIRED", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "This contract may be terminated in accordance with the Employment Act (Cap. 226), as amended, including by notice, payment in lieu of notice where permitted, summary dismissal for gross misconduct, or redundancy. On termination, the Employer shall issue a certificate of service as required by law." },
    { code: "REDUNDANCY", name: "Redundancy", category: "Redundancy", required: "OPTIONAL", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "In the event of redundancy, the Employer shall comply with the Employment Act (Cap. 226), as amended, and pay any statutory redundancy and severance entitlements due, including severance of not less than one month's salary for each completed year of continuous service." },
    { code: "DISCIPLINARY", name: "Disciplinary Matters", category: "Disciplinary Matters", required: "REQUIRED", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee is subject to the Employer's disciplinary rules. Disciplinary action shall be taken in accordance with the Employment Act (Cap. 226), as amended and the principles of natural justice, including a fair hearing." },
    { code: "GRIEVANCE", name: "Grievance", category: "Grievance", required: "REQUIRED", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee may raise a grievance in accordance with the Employer's grievance procedure, without fear of victimisation." },
    { code: "DISPUTE_RESOLUTION", name: "Dispute Resolution", category: "Dispute Resolution", required: "REQUIRED", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "Any dispute arising from this contract shall first be raised internally and, if unresolved, may be referred to the Labour Officer or the Industrial Court in accordance with the Employment Act (Cap. 226), as amended." },
    { code: "GOVERNING_LAW", name: "Governing Law", category: "Applicable Law", required: "REQUIRED", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "This contract is governed by the laws of the Republic of Uganda, including the Employment Act (Cap. 226), as amended." },
    { code: "CONFIDENTIALITY", name: "Confidentiality", category: "Confidentiality", required: "CONDITIONAL", rule: null,
      contracts: ALL_EMP, conditions: [{ field: "has_confidential_access", op: "eq", value: true }], conflicts: [],
      text: "The Employee shall not, during or after employment, disclose confidential information of the Employer or its clients, except as required by law or with written authorisation." },
    { code: "INTELLECTUAL_PROPERTY", name: "Intellectual Property", category: "Intellectual Property", required: "OPTIONAL", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "All works created by the Employee in the course of employment shall vest in the Employer." },
    { code: "DATA_PROTECTION", name: "Data Protection", category: "Data Protection", required: "CONDITIONAL", rule: null,
      contracts: ALL_EMP, conditions: [{ field: "handles_personal_data", op: "eq", value: true }], conflicts: [],
      text: "The Employee shall process personal data in accordance with the Data Protection and Privacy Act, 2019 and the Employer's data protection policy." },
    { code: "COMPANY_PROPERTY", name: "Company Property", category: "Company Property", required: "OPTIONAL", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee shall return all Employer property, documents and equipment on termination of employment." },
    { code: "HEALTH_SAFETY", name: "Health and Safety", category: "Health & Safety", required: "REQUIRED", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer shall provide a safe and healthy workplace, establish and maintain a safety and health committee for the workplace, provide mental health support as part of its occupational safety and health obligations, and the Employee shall comply with all health and safety requirements and report hazards promptly, in accordance with the Employment Act (Cap. 226), as amended." },
    { code: "WORKPLACE_CONDUCT", name: "Workplace Conduct", category: "Workplace Conduct", required: "REQUIRED", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee shall maintain professional conduct and refrain from any conduct that harms the Employer's reputation or business." },
    { code: "NON_SOLICITATION", name: "Non-Solicitation", category: "Non-Solicitation", required: "OPTIONAL", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee shall not, during employment, solicit the Employer's clients or staff for any competing business." },
    { code: "ANTI_BRIBERY", name: "Anti-Bribery", category: "Anti-Bribery", required: "OPTIONAL", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee shall not offer, give, solicit or accept any bribe or improper advantage in connection with the Employer's business." },
    { code: "ANTI_FRAUD", name: "Anti-Fraud", category: "Anti-Fraud", required: "OPTIONAL", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee shall not commit fraud, conceal wrongdoing, or knowingly participate in any dishonest practice." },
    { code: "CONFLICT_OF_INTEREST", name: "Conflict of Interest", category: "Conflict of Interest", required: "OPTIONAL", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee shall promptly declare any actual or potential conflict of interest to the Employer." },
    { code: "VARIATION", name: "Variation of Terms", category: "General", required: "REQUIRED", rule: null,
      contracts: pgArr(["VARIATION","RENEWAL","PROMOTION","TRANSFER","SALARY_ADJUSTMENT"]), conditions: [], conflicts: [],
      text: "This addendum varies the Employee's employment terms as set out below, with effect from {{employment.start_date}}. All other terms of the underlying employment contract remain in full force. Statutory rights are not affected." },
    { code: "PROMOTION", name: "Promotion", category: "Employment", required: "REQUIRED", rule: null,
      contracts: pgArr(["PROMOTION"]), conditions: [], conflicts: [],
      text: "The Employee is promoted to the position of {{employee.job_title}} in the {{employee.department}} department with effect from {{employment.start_date}}, reporting to {{employee.manager}}." },
    { code: "CERTIFICATE_OF_SERVICE", name: "Certificate of Service", category: "Termination", required: "REQUIRED", rule: "CERTIFICATE_OF_SERVICE",
      contracts: pgArr(["OTHER"]), conditions: [], conflicts: [],
      text: "This certificate is issued under the Employment Act (Cap. 226), as amended, confirming the Employee's period of continuous employment with the Employer, the position held, and the wages payable at termination." },
    // ---- Working time, rest and public holidays (WORKING_HOURS) ----
    { code: "WORKING_TIME", name: "Hours of Work", category: "Working Hours", required: "REQUIRED", rule: "WORKING_TIME", legalRef: "Employment Act (Cap. 226), s.52, as amended",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee's normal working hours shall not exceed 8 hours a day or 48 hours a week, in accordance with the Employment Act (Cap. 226), as amended, s.52. Work beyond normal hours is overtime and is compensated at the statutory premium." },
    { code: "WEEKLY_REST", name: "Weekly Rest", category: "Working Hours", required: "REQUIRED", rule: "WEEKLY_REST", legalRef: "Employment Act (Cap. 226), s.50, as amended",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee is entitled to at least 24 consecutive hours of rest in each week and shall not be required to work more than six consecutive working days, in accordance with the Employment Act (Cap. 226), as amended, s.50." },
    { code: "REST_BREAKS", name: "Rest Breaks", category: "Working Hours", required: "REQUIRED", rule: "WORKING_TIME", legalRef: "Employment Act (Cap. 226), s.52, as amended",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee is entitled to a rest break of not less than 30 minutes during a working shift of 8 hours or more, in accordance with the Employment Act (Cap. 226), as amended, s.52." },
    { code: "PUBLIC_HOLIDAYS", name: "Public Holidays", category: "Working Hours", required: "REQUIRED", rule: "PUBLIC_HOLIDAYS", legalRef: "Employment Act (Cap. 226), s.53, as amended",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employee is entitled to paid leave on public holidays. Work performed on a public holiday shall be compensated at not less than twice the normal rate, in accordance with the Employment Act (Cap. 226), as amended, s.53." },
    // ---- Wages, pay slips and deductions (COMPENSATION) ----
    { code: "WAGES_PAYMENT", name: "Payment of Wages", category: "Salary", required: "REQUIRED", rule: "PAYMENT_OF_WAGES",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer shall pay the Employee's wages in full, in Uganda Shillings, at intervals of not more than one month, and shall provide the Employee with a written pay slip recording the amounts paid and any deductions made, in accordance with the Employment Act (Cap. 226), as amended." },
    { code: "PAY_SLIPS", name: "Pay Slips", category: "Salary", required: "REQUIRED", rule: "PAYMENT_OF_WAGES",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer shall provide the Employee with a written pay slip for each payment of wages showing gross pay, statutory and authorised deductions, and net pay." },
    { code: "DEDUCTIONS", name: "Permitted Deductions", category: "Salary", required: "REQUIRED", rule: "DEDUCTIONS",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "Deductions from the Employee's wages shall be made only where required or authorised by law, by court order, or with the Employee's written agreement, and shall not reduce the Employee's wages below the statutory floor, in accordance with the Employment Act (Cap. 226), as amended." },
    // ---- Leave (LEAVE) ----
    { code: "COMPASSIONATE_LEAVE", name: "Compassionate Leave", category: "Leave", required: "OPTIONAL", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer may grant paid or unpaid compassionate leave in accordance with the Employer's leave policy. This clause is a contractual benefit and does not reduce any statutory entitlement of the Employee under the Employment Act (Cap. 226), as amended." },
    // ---- Rights and non-discrimination (RIGHTS) ----
    { code: "NON_DISCRIMINATION", name: "Non-Discrimination", category: "Rights", required: "REQUIRED", rule: "NON_DISCRIMINATION", legalRef: "Employment Act (Cap. 226), s.5, as amended",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer shall not discriminate against the Employee on grounds including race, colour, sex, religion, political opinion or affiliation, ethnic origin, family responsibility, disability or HIV status, in accordance with the Employment Act (Cap. 226), as amended, s.5." },
    { code: "EQUAL_PAY", name: "Equal Pay for Work of Equal Value", category: "Rights", required: "REQUIRED", rule: "EQUAL_PAY", legalRef: "Employment Act (Cap. 226), s.5(7), as amended",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer shall provide equal remuneration to men and women performing work of equal value, in accordance with the Employment Act (Cap. 226), as amended, s.5(7)." },
    { code: "FORCED_LABOUR_PROHIBITION", name: "Prohibition of Forced Labour", category: "Rights", required: "REQUIRED", rule: "FORCED_LABOUR", legalRef: "Employment Act (Cap. 226), s.4, as amended",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer shall not require or compel the Employee to perform forced or compulsory labour. All work under this contract is performed voluntarily, in accordance with the Employment Act (Cap. 226), as amended, s.4." },
    { code: "PREGNANCY_PROTECTION", name: "Protection from Dismissal for Pregnancy", category: "Rights", required: "REQUIRED", rule: "PREGNANCY_PROTECTION", legalRef: "Employment Act (Cap. 226), s.75(a), as amended",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer shall not dismiss the Employee on account of pregnancy or an illness arising out of pregnancy, in accordance with the Employment Act (Cap. 226), as amended, s.75(a)." },
    { code: "SEXUAL_HARASSMENT", name: "Sexual Harassment", category: "Rights", required: "REQUIRED", rule: "SEXUAL_HARASSMENT",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "Sexual harassment in the workplace is prohibited. The Employee may raise a complaint of sexual harassment through the Employer's grievance procedure without fear of victimisation. A copy of the Employer's policy prohibiting sexual harassment, intimidation and harassment is displayed at the workplace, in accordance with the Employment Act (Cap. 226), as amended." },
    { code: "CHILD_LABOUR_PROHIBITION", name: "Prohibition of Child Labour", category: "Rights", required: "REQUIRED", rule: "CHILD_LABOUR", legalRef: "Employment Act (Cap. 226), s.7, as amended",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer confirms that the Employee is not below the minimum working age and shall not employ any person below 15 years of age, in accordance with the Employment Act (Cap. 226), as amended, s.7." },
    { code: "YOUNG_PERSONS_EMPLOYMENT", name: "Employment of Young Persons", category: "Rights", required: "OPTIONAL", rule: "CHILD_LABOUR", legalRef: "Employment Act (Cap. 226), s.8, as amended",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "If the Employee is a young person aged 15 to 17 years, employment is subject to the written authorisation of the Commissioner and shall not involve hazardous work or night work, in accordance with the Employment Act (Cap. 226), as amended, s.8." },
    // ---- Records (GENERAL) ----
    { code: "EMPLOYMENT_RECORDS", name: "Employment Records", category: "General", required: "REQUIRED", rule: "EMPLOYMENT_RECORDS",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer shall keep accurate records of the Employee's particulars, working hours, wages and leave, and shall produce them for inspection by a labour officer on request, in accordance with the Employment Act (Cap. 226), as amended." },
    // ---- Termination (TERMINATION) ----
    { code: "SUMMARY_DISMISSAL", name: "Summary Dismissal", category: "Termination", required: "REQUIRED", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "The Employer may dismiss the Employee without notice only for gross misconduct justifying summary dismissal under the Employment Act (Cap. 226), as amended, and after giving the Employee an opportunity to be heard." },
    { code: "UNFAIR_TERMINATION", name: "Unfair Termination", category: "Termination", required: "REQUIRED", rule: "UNFAIR_TERMINATION",
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "Termination of this contract shall be only for a valid reason connected with the Employee's capacity, conduct or the Employer's operational requirements, and after a fair hearing, in accordance with the Employment Act (Cap. 226), as amended." },
    { code: "TERMINAL_BENEFITS", name: "Terminal Benefits", category: "Termination", required: "REQUIRED", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "On termination of employment, the Employer shall pay all wages due, pay in lieu of accrued leave, and any other terminal benefits due to the Employee under this contract or by law, and shall issue a certificate of service as required by the Employment Act (Cap. 226), as amended." },
    { code: "REDUNDANCY_NOTICE", name: "Redundancy Notice", category: "Termination", required: "OPTIONAL", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "Where the Employee's position becomes redundant, the Employer shall give notice and consult with the Employee and, where applicable, the labour office, and shall pay any statutory redundancy entitlements due under the Employment Act (Cap. 226), as amended." },
    { code: "NON_COMPETE_CAUTION", name: "Restraint of Trade (Advisory)", category: "Termination", required: "OPTIONAL", rule: null,
      contracts: ALL_EMP, conditions: [], conflicts: [],
      text: "Any post-employment restraint of trade is enforceable only to the extent that it protects a legitimate business interest of the Employer and is reasonable in duration, scope and geography. This clause is advisory and should be reviewed by legal counsel before it is relied upon." },
{ code: "SEVERANCE_ALLOWANCE", name: "Severance Allowance", category: "Termination", required: "OPTIONAL", rule: "SEVERANCE_ALLOWANCE", legalRef: "Employment Act (Cap. 226), as amended",
  contracts: ALL_EMP, conditions: [], conflicts: [],
  text: "Where the Employee is declared redundant, the Employer shall pay severance allowance of not less than one month's salary for each completed year of continuous service, in accordance with the Employment Act (Cap. 226), as amended." },
{ code: "INTIMIDATION_HARASSMENT", name: "Prohibition of Intimidation and Harassment", category: "Rights", required: "REQUIRED", rule: "INTIMIDATION_HARASSMENT", legalRef: "Employment Act (Cap. 226), s.6A, as amended",
  contracts: ALL_EMP, conditions: [], conflicts: [],
  text: "The Employer shall not intimidate, harass or victimise the Employee, and a copy of the Employer's policy prohibiting such conduct is displayed at the workplace, in accordance with the Employment Act (Cap. 226), s.6A, as amended." },
{ code: "OHS_COMMITTEE", name: "Safety and Health Committee", category: "Health & Safety", required: "REQUIRED", rule: "OHS_COMMITTEES", legalRef: "Employment Act (Cap. 226), as amended",
  contracts: ALL_EMP, conditions: [], conflicts: [],
  text: "The Employer shall establish and maintain a safety and health committee for the workplace and shall provide mental health support as part of its occupational safety and health obligations, in accordance with the Employment Act (Cap. 226), as amended." },
{ code: "MIGRANT_WORKERS", name: "Protection of Migrant Workers", category: "Rights", required: "OPTIONAL", rule: "MIGRANT_WORKERS", legalRef: "Employment Act (Cap. 226), Part IXA, as amended",
  contracts: ALL_EMP, conditions: [], conflicts: [],
  text: "If the Employee is a migrant worker, the Employee is entitled to the same statutory protections as any other employee under this contract, including written particulars, fair termination and freedom from intimidation and harassment, in accordance with Part IXA of the Employment Act (Cap. 226), as amended." },
  ];
  const ruleCache = {};
  for (const c of clauseDefs) {
    if (await exists("contract_clauses", "company_id = $1 AND clause_code = $2 AND version = 1", [companyId, c.code])) continue;
    let legalRuleId = null;
    let ruleRow = null;
    if (c.rule) {
      if (!(c.rule in ruleCache)) {
        const rr = await client.query("SELECT * FROM legal_rules WHERE tenant_id = $1 AND code = $2 AND version = 1", [tenantId, c.rule]);
        ruleCache[c.rule] = rr.rows.length ? rr.rows[0] : null;
      }
      ruleRow = ruleCache[c.rule];
      legalRuleId = ruleRow ? ruleRow.id : null;
    }
    await insertOne(client, "contract_clauses", {
      company_id: companyId, tenant_id: tenantId, clause_code: c.code, name: c.name,
      category: c.category, text: c.text, version: 1, status: "ACTIVE",
      effective_from: c.effectiveFrom ?? "2006-08-23", effective_to: c.effectiveTo ?? null,
      law: c.law ?? ruleRow?.law ?? law,
      law_chapter: c.chapter ?? ruleRow?.law_chapter ?? chapter,
      section: c.section ?? ruleRow?.section ?? null,
      law_source: c.lawSource ?? ruleRow?.source ?? source,
      validation_status: c.validation ?? "VALIDATED",
      legal_reference: c.legalRef ?? (c.rule ? `Employment Act (Cap. 226), as amended` : null),
      legal_rule_id: legalRuleId,
      required_flag: c.required,
      applicable_employee_types: pgArr([]),
      applicable_contract_types: c.contracts,
      rule_conditions: c.conditions,
      conflicts_with: pgArr(c.conflicts),
      created_by: null, approved_by: null, approval_date: new Date().toISOString(),
    });
    bump("contract_clauses");
  }

  return { inserted };
}

// Enterprise Asset Management baseline (Asset Register, Tagging & Tracking).
// Idempotent: reference data, workflows, SoD rules, asset roles and user
// assignments are upserted so `npm run db:seed` stays safe to re-run.
async function ensureAssetModuleSeed(client, tenantId, companyId = null) {
  const inserted = {};
  const bump = (t, n = 1) => { inserted[t] = (inserted[t] || 0) + n; };
  if (!companyId) {
    const { rows } = await client.query(
      "SELECT id FROM companies WHERE tenant_id = $1 AND code = 'HDG'",
      [tenantId]
    );
    if (rows.length === 0) return { inserted };
    companyId = rows[0].id;
  }
  const upsert = async (table, conflictCols, data) => {
    const cols = Object.keys(data);
    const params = [];
    const placeholders = cols.map((c, i) => {
      params.push(json(data[c]));
      return "$" + (i + 1);
    });
    const updates = cols
      .filter((c) => !conflictCols.includes(c))
      .map((c) => c + " = EXCLUDED." + c)
      .join(", ");
    const { rows } = await client.query(
      "INSERT INTO " + table + " (" + cols.join(", ") + ") VALUES (" + placeholders.join(", ") + ")" +
      " ON CONFLICT (" + conflictCols.join(", ") + ") DO UPDATE SET " + updates +
      " RETURNING id",
      params
    );
    return rows[0].id;
  };

  // Branch used by hierarchical asset locations and user_roles scope.
  const { rows: branchRows } = await client.query(
    "SELECT id FROM branches WHERE company_id = $1 AND tenant_id = $2 AND code = 'KAMPALA-HQ'",
    [companyId, tenantId]
  );
  const branchId = branchRows.length ? branchRows[0].id : null;

  // ---- Segregation of duties (asset lifecycle) ----
  const sodDefs = [
    ["SOD-ASSET-REGISTER", "Create/Approve Asset Registration", "assets.register.create", "assets.register.approve"],
    ["SOD-ASSET-TRANSFER", "Create/Approve Asset Transfer", "assets.transfers.create", "assets.transfers.approve"],
    ["SOD-ASSET-DISPOSAL", "Create/Approve Asset Disposal", "assets.disposals.create", "assets.disposals.approve"],
    ["SOD-ASSET-IMPAIRMENT", "Create/Approve Asset Impairment", "assets.impairments.create", "assets.impairments.approve"],
  ];
  for (const [code, name, primary, conflicting] of sodDefs) {
    await upsert("sod_rules", ["tenant_id", "code"], {
      tenant_id: tenantId, code, name,
      description: "Prevents a single user holding both " + primary + " and " + conflicting + ".",
      primary_permission: primary, conflicting_permission: conflicting,
      enforcement: "hard", is_active: true,
    });
    bump("sod_rules");
  }

  // ---- Approval workflows (skipped when already configured) ----
  const wfDefs = [
    {
      code: "WF-ASSET-REGISTER", name: "Asset Registration Approval",
      entity_type: "assets.register",
      desc: "New asset registrations require Asset Manager approval.",
      steps: [{ seq: 1, name: "Asset Manager Approval", approver_role: "asset_manager", amount_min: 0, amount_max: 1000000000, sla_hours: 24 }],
    },
    {
      code: "WF-ASSET-TRANSFER", name: "Asset Transfer Approval",
      entity_type: "assets.transfers",
      desc: "Asset transfers require Asset Manager approval.",
      steps: [{ seq: 1, name: "Asset Manager Approval", approver_role: "asset_manager", amount_min: 0, amount_max: 0, sla_hours: 24 }],
    },
    {
      code: "WF-ASSET-DISPOSAL", name: "Asset Disposal Approval (Dual Control)",
      entity_type: "assets.disposals",
      desc: "Disposals require Asset Manager then CFO approval (dual control).",
      steps: [
        { seq: 1, name: "Asset Manager Approval", approver_role: "asset_manager", amount_min: 0, amount_max: 0, sla_hours: 24 },
        { seq: 2, name: "CFO Approval", approver_role: "cfo", amount_min: 0, amount_max: 0, sla_hours: 48 },
      ],
    },
  ];
  const wfRes = await client.query(
    "SELECT code FROM workflows WHERE company_id = $1 AND tenant_id = $2 AND code = ANY($3)",
    [companyId, tenantId, wfDefs.map((w) => w.code)]
  );
  const existingWf = new Set(wfRes.rows.map((r) => r.code));
  for (const w of wfDefs) {
    if (existingWf.has(w.code)) continue;
    await insertOne(client, "workflows", {
      company_id: companyId, tenant_id: tenantId, code: w.code, name: w.name,
      entity_type: w.entity_type, description: w.desc, config: w.steps, is_active: true,
    });
    bump("workflows");
  }

  // ---- Asset categories (hierarchical, full HDG catalogue) ----
  // [code, name, depreciation_method, default_life_years, parent, asset_type, sort_order, description]
  const catDefs = [
    ["IT-EQUIPMENT", "IT Equipment", "STRAIGHT_LINE", 3, null, "CAPITAL", 10, "Computing, networking and end-user IT assets"],
    ["COMPUTERS", "Computers", "STRAIGHT_LINE", 3, "IT-EQUIPMENT", "CAPITAL", 11, "Desktop and workstation computers"],
    ["LAPTOPS", "Laptops", "STRAIGHT_LINE", 3, "IT-EQUIPMENT", "CAPITAL", 12, "Portable computers"],
    ["SERVERS", "Servers", "STRAIGHT_LINE", 5, "IT-EQUIPMENT", "CAPITAL", 13, "Server hardware and appliances"],
    ["NETWORKING-EQUIPMENT", "Networking Equipment", "STRAIGHT_LINE", 5, "IT-EQUIPMENT", "CAPITAL", 14, "Switches, routers, access points and firewalls"],
    ["PRINTERS", "Printers", "STRAIGHT_LINE", 3, "IT-EQUIPMENT", "CAPITAL", 15, "Printers, plotters and MFDs"],
    ["MOBILE-DEVICES", "Mobile Devices", "STRAIGHT_LINE", 2, "IT-EQUIPMENT", "CAPITAL", 16, "Phones, tablets and handheld scanners"],
    ["OFFICE-FURNITURE", "Office Furniture", "STRAIGHT_LINE", 10, null, "CAPITAL", 20, "Desks, chairs, cabinets and workstations"],
    ["OFFICE-EQUIPMENT", "Office Equipment", "STRAIGHT_LINE", 5, null, "CAPITAL", 21, "General office machines"],
    ["PRODUCTION-MACHINERY", "Production Machinery", "STRAIGHT_LINE", 10, null, "CAPITAL", 30, "Core production and manufacturing machinery"],
    ["PRINTING-MACHINES", "Printing Machines", "STRAIGHT_LINE", 10, "PRODUCTION-MACHINERY", "CAPITAL", 31, "FSS and other printing machines"],
    ["PLANT-EQUIPMENT", "Plant Equipment", "STRAIGHT_LINE", 10, "PRODUCTION-MACHINERY", "CAPITAL", 32, "Support plant and process equipment"],
    ["VEHICLES", "Vehicles", "STRAIGHT_LINE", 5, null, "CAPITAL", 40, "Company vehicles and motor assets"],
    ["ELECTRICAL-EQUIPMENT", "Electrical Equipment", "STRAIGHT_LINE", 8, null, "CAPITAL", 50, "Electrical installations and equipment"],
    ["GENERATORS", "Generators", "STRAIGHT_LINE", 10, "ELECTRICAL-EQUIPMENT", "CAPITAL", 51, "Standby and main power generators"],
    ["UPS-SYSTEMS", "UPS Systems", "STRAIGHT_LINE", 5, "ELECTRICAL-EQUIPMENT", "CAPITAL", 52, "Uninterruptible power supplies"],
    ["AIR-CONDITIONERS", "Air Conditioners", "STRAIGHT_LINE", 7, "ELECTRICAL-EQUIPMENT", "CAPITAL", 53, "Air conditioning and cooling units"],
    ["LABORATORY-EQUIPMENT", "Laboratory Equipment", "STRAIGHT_LINE", 8, null, "CAPITAL", 60, "Laboratory and testing equipment"],
    ["WAREHOUSE-EQUIPMENT", "Warehouse Equipment", "STRAIGHT_LINE", 8, null, "CAPITAL", 61, "Warehouse handling and storage equipment"],
    ["SECURITY-EQUIPMENT", "Security Equipment", "STRAIGHT_LINE", 5, null, "CAPITAL", 70, "Security systems and hardware"],
    ["CCTV-EQUIPMENT", "CCTV Equipment", "STRAIGHT_LINE", 5, "SECURITY-EQUIPMENT", "CAPITAL", 71, "CCTV cameras, recorders and monitors"],
    ["BUILDINGS", "Buildings", "STRAIGHT_LINE", 30, null, "CAPITAL", 80, "Buildings and premises"],
    ["LAND", "Land", "NONE", 0, null, "CAPITAL", 81, "Land and freehold property"],
    ["TOOLS", "Tools", "STRAIGHT_LINE", 5, null, "CONSUMABLE", 90, "Hand tools and small equipment"],
    ["COMMUNICATION-EQUIPMENT", "Communication Equipment", "STRAIGHT_LINE", 5, null, "CAPITAL", 91, "Telephony, radio and communication assets"],
    ["SOFTWARE-INTANGIBLE", "Software/Intangible Assets", "STRAIGHT_LINE", 3, null, "INTANGIBLE", 92, "Software licences and intangibles"],
    ["OTHER", "Other", "STRAIGHT_LINE", 5, null, "OTHER", 99, "Assets not covered by other categories"],
  ];
  const catIds = {};
  for (const [code, name, method, life, parent, assetType, sortOrder, description] of catDefs) {
    const catId = await upsert("asset_categories", ["company_id", "code"], {
      company_id: companyId, tenant_id: tenantId, code, name,
      depreciation_method: method, default_life_years: life,
      parent_id: parent ? catIds[parent] : null,
      asset_type: assetType, is_active: true, sort_order: sortOrder, description,
    });
    catIds[code] = catId;
    bump("asset_categories");
  }

  // ---- Asset statuses (workflow-controlled lifecycle) ----
  const statusDefs = [
    ["DRAFT", "Draft", false],
    ["PENDING_APPROVAL", "Pending Approval", false],
    ["REGISTERED", "Registered", false],
    ["IN_STORE", "In Store", false],
    ["AVAILABLE", "Available", false],
    ["ASSIGNED", "Assigned", false],
    ["IN_USE", "In Use", false],
    ["TRANSFERRED", "Transferred", false],
    ["UNDER_MAINTENANCE", "Under Maintenance", false],
    ["UNDER_INSPECTION", "Under Inspection", false],
    ["MISSING", "Missing", false],
    ["LOST", "Lost", true],
    ["STOLEN", "Stolen", true],
    ["DAMAGED", "Damaged", false],
    ["QUARANTINED", "Quarantined", false],
    ["RESERVED", "Reserved", false],
    ["DISPOSED", "Disposed", true],
    ["RETIRED", "Retired", true],
    ["ARCHIVED", "Archived", true],
  ];
  for (let i = 0; i < statusDefs.length; i++) {
    const [code, name, terminal] = statusDefs[i];
    await upsert("asset_statuses", ["tenant_id", "code"], {
      tenant_id: tenantId, code, name,
      description: "Lifecycle status " + name + ".",
      is_terminal: terminal, sort_order: i, is_active: true,
    });
    bump("asset_statuses");
  }

  // ---- Asset conditions ----
  const conditionDefs = [
    ["NEW", "New"], ["EXCELLENT", "Excellent"], ["GOOD", "Good"], ["FAIR", "Fair"],
    ["POOR", "Poor"], ["DAMAGED", "Damaged"], ["CRITICAL", "Critical"],
    ["UNDER_REPAIR", "Under Repair"], ["BEYOND_ECONOMIC_REPAIR", "Beyond Economic Repair"],
    ["DISPOSED", "Disposed"],
  ];
  for (let i = 0; i < conditionDefs.length; i++) {
    const [code, name] = conditionDefs[i];
    await upsert("asset_conditions", ["tenant_id", "code"], {
      tenant_id: tenantId, code, name,
      description: "Condition " + name + ".", sort_order: i, is_active: true,
    });
    bump("asset_conditions");
  }

  // ---- Asset types / classes ----
  const typeDefs = [
    ["LAPTOP", "Laptop", "LAPTOPS"], ["COMPUTER", "Computer", "COMPUTERS"],
    ["SERVER", "Server", "SERVERS"], ["PRINTER", "Printer", "PRINTERS"],
    ["MOBILE_DEVICE", "Mobile Device", "MOBILE-DEVICES"], ["VEHICLE", "Vehicle", "VEHICLES"],
    ["PRODUCTION_MACHINE", "Production Machine", "PRODUCTION-MACHINERY"],
    ["PRINTING_MACHINE", "Printing Machine", "PRINTING-MACHINES"],
    ["GENERATOR", "Generator", "GENERATORS"], ["UPS", "UPS System", "UPS-SYSTEMS"],
    ["FURNITURE", "Furniture", "OFFICE-FURNITURE"], ["SOFTWARE", "Software", "SOFTWARE-INTANGIBLE"],
    ["TOOL", "Tool", "TOOLS"], ["OTHER", "Other", "OTHER"],
  ];
  for (const [code, name, catCode] of typeDefs) {
    await upsert("asset_types", ["company_id", "code"], {
      company_id: companyId, tenant_id: tenantId, category_id: catCode ? catIds[catCode] : null,
      code, name, is_active: true,
    });
    bump("asset_types");
  }
  const classDefs = [
    ["FIXED_ASSET", "Fixed Asset", "Capital assets held for use in operations"],
    ["CAPITAL_EQUIPMENT", "Capital Equipment", "Machinery and equipment capitalised in the asset register"],
    ["INTANGIBLE", "Intangible", "Software and non-physical capital assets"],
    ["VEHICLE", "Vehicle", "Motor vehicles"],
    ["BUILDING", "Building", "Buildings and improvements"],
    ["LAND", "Land", "Land and freehold property"],
    ["CONSUMABLE", "Consumable", "Tracked consumable and tool assets"],
  ];
  for (const [code, name, description] of classDefs) {
    await upsert("asset_classes", ["company_id", "code"], {
      company_id: companyId, tenant_id: tenantId, code, name, description, is_active: true,
    });
    bump("asset_classes");
  }

  // ---- Hierarchical asset locations (COMPANY -> BRANCH -> BUILDING -> FLOOR -> DEPARTMENT -> ROOM -> RACK_BIN) ----
  const locDefs = [
    { code: "HDG", name: "Hope Design Group Ltd", level: "COMPANY", parent: null, building: null, floor: null, room: null, rack: null },
    { code: "KAMPALA-HQ", name: "Kampala Branch", level: "BRANCH", parent: "HDG", building: null, floor: null, room: null, rack: null },
    { code: "ADMIN-BLOCK", name: "Administration Block", level: "BUILDING", parent: "KAMPALA-HQ", building: "Administration Block", floor: null, room: null, rack: null },
    { code: "FLR-2", name: "2nd Floor", level: "FLOOR", parent: "ADMIN-BLOCK", building: "Administration Block", floor: "2nd Floor", room: null, rack: null },
    { code: "FIN", name: "Finance Department", level: "DEPARTMENT", parent: "FLR-2", building: "Administration Block", floor: "2nd Floor", room: null, rack: null },
    { code: "CFO-OFFICE", name: "CFO Office", level: "ROOM", parent: "FIN", building: "Administration Block", floor: "2nd Floor", room: "CFO Office", rack: null },
    { code: "RACK-01", name: "Rack 01", level: "RACK_BIN", parent: "CFO-OFFICE", building: "Administration Block", floor: "2nd Floor", room: "CFO Office", rack: "RACK-01" },
  ];
  const locIds = {};
  for (const l of locDefs) {
    const locId = await upsert("asset_locations", ["company_id", "code"], {
      company_id: companyId, tenant_id: tenantId,
      parent_id: l.parent ? locIds[l.parent] : null,
      code: l.code, name: l.name, level: l.level,
      branch_id: branchId, building: l.building, floor: l.floor,
      room: l.room, rack_bin: l.rack, is_active: true,
    });
    locIds[l.code] = locId;
    bump("asset_locations");
  }

  // ---- Numbering rule: HDG-AST-YYYY-000001 ----
  const seqRes = await client.query(
    "SELECT 1 FROM asset_sequence_rules WHERE company_id = $1 AND tenant_id = $2 LIMIT 1",
    [companyId, tenantId]
  );
  if (seqRes.rowCount === 0) {
    await insertOne(client, "asset_sequence_rules", {
      company_id: companyId, tenant_id: tenantId, prefix: "HDG-AST", pad: 6, is_active: true,
    });
    bump("asset_sequence_rules");
  }

  // ---- Asset roles + permissions (from the RBAC catalogue) ----
  const { rows: permRows } = await client.query("SELECT id, code FROM permissions");
  const permIdByCode = {};
  for (const r of permRows) permIdByCode[r.code] = r.id;
  const assetRoleCodes = ["asset_manager", "asset_officer", "asset_custodian", "asset_auditor", "asset_storekeeper", "asset_finance"];
  const roleIdByCode = {};
  for (const roleCode of assetRoleCodes) {
    const role = ROLES.find((r) => r.code === roleCode);
    if (!role) continue;
    const codes = expandGrants(role.grants).filter((c) => permIdByCode[c]);
    const roleId = await upsert("roles", ["tenant_id", "company_id", "code"], {
      tenant_id: tenantId, company_id: companyId, code: role.code,
      name: role.name, description: role.description,
      is_system: true, is_customizable: true, permissions: codes,
    });
    roleIdByCode[role.code] = roleId;
    bump("roles");
    await client.query("DELETE FROM role_permissions WHERE role_id = $1", [roleId]);
    if (codes.length) {
      await bulkInsert(client, "role_permissions", codes.map((c) => ({ role_id: roleId, permission_id: permIdByCode[c] })), false);
      bump("role_permissions", codes.length);
    }
  }

  // ---- Demo user role assignments (asset lifecycle personas) ----
  const userKeys = ["opus.ops", "mia.main", "willy.wh", "qa.auditor", "cindy.cfo"];
  const { rows: userRows } = await client.query(
    "SELECT id, username FROM users WHERE tenant_id = $1 AND username = ANY($2)",
    [tenantId, userKeys]
  );
  const userIdByUsername = {};
  for (const r of userRows) userIdByUsername[r.username] = r.id;
  const userRoleDefs = [
    ["opus.ops", "asset_manager"],
    ["mia.main", "asset_officer"],
    ["willy.wh", "asset_storekeeper"],
    ["qa.auditor", "asset_auditor"],
    ["cindy.cfo", "asset_finance"],
  ];
  for (const [username, roleCode] of userRoleDefs) {
    const uid = userIdByUsername[username];
    const rid = roleIdByCode[roleCode];
    if (!uid || !rid) continue;
    await client.query(
      "INSERT INTO user_roles (user_id, role_id, company_id, branch_id) VALUES ($1, $2, $3, $4)" +
      " ON CONFLICT (user_id, role_id) DO NOTHING",
      [uid, rid, companyId, branchId]
    );
    bump("user_roles");
  }

  return { inserted };
}

// Idempotent: configurable KPI definitions powering the Reports & Analytics
// KPI engine. Actual values are computed live by the API at measure time.
async function ensureAnalyticsSeed(client, tenantId, companyId = null) {
  const inserted = {};
  const bump = (t, n = 1) => { inserted[t] = (inserted[t] || 0) + n; };
  if (!companyId) {
    const { rows } = await client.query(
      "SELECT id FROM companies WHERE tenant_id = $1 AND code = 'HDG'",
      [tenantId]
    );
    if (rows.length === 0) return { inserted };
    companyId = rows[0].id;
  }
  const upsert = async (table, conflictCols, data) => {
    const cols = Object.keys(data);
    const params = [];
    const placeholders = cols.map((c, i) => {
      params.push(json(data[c]));
      return "$" + (i + 1);
    });
    const updates = cols
      .filter((c) => !conflictCols.includes(c))
      .map((c) => c + " = EXCLUDED." + c)
      .join(", ");
    const { rows } = await client.query(
      "INSERT INTO " + table + " (" + cols.join(", ") + ") VALUES (" + placeholders.join(", ") + ")" +
      " ON CONFLICT (" + conflictCols.join(", ") + ") DO UPDATE SET " + updates +
      " RETURNING id",
      params
    );
    return rows[0].id;
  };

  const kpiDefs = [
    { key: "stock_value", name: "Stock Value", description: "Total inventory value across warehouses.",
      department: "Inventory", data_source: "v_stock_value", value_column: "stock_value",
      aggregation: "SUM", period_column: null, unit: "UGX", frequency: "MONTHLY", direction: "HIGHER_BETTER" },
    { key: "inventory_value", name: "Inventory Value", description: "Total stock value at current cost.",
      department: "Inventory", data_source: "v_inventory_summary", value_column: "stock_value",
      aggregation: "SUM", period_column: null, unit: "UGX", frequency: "MONTHLY", direction: "HIGHER_BETTER" },
    { key: "ar_outstanding", name: "AR Outstanding", description: "Total customer invoice balances outstanding.",
      department: "Finance", data_source: "v_ar_aging", value_column: "balance",
      aggregation: "SUM", period_column: null, unit: "UGX", frequency: "MONTHLY", direction: "LOWER_BETTER" },
    { key: "ap_outstanding", name: "AP Outstanding", description: "Total supplier invoice balances outstanding.",
      department: "Finance", data_source: "v_ap_aging", value_column: "balance",
      aggregation: "SUM", period_column: null, unit: "UGX", frequency: "MONTHLY", direction: "LOWER_BETTER" },
    { key: "monthly_revenue", name: "Monthly Revenue", description: "Invoiced revenue for the period.",
      department: "Sales", data_source: "v_sales_by_month", value_column: "revenue",
      aggregation: "SUM", period_column: "month", unit: "UGX", frequency: "MONTHLY", direction: "HIGHER_BETTER" },
    { key: "monthly_production_yield", name: "Monthly Production Yield", description: "Yield percentage across production.",
      department: "Production", data_source: "v_production_yield_by_month", value_column: "yield_pct",
      aggregation: "AVG", period_column: "month", unit: "percent", frequency: "MONTHLY", direction: "HIGHER_BETTER",
      target_value: 95, warning_threshold: 90, critical_threshold: 85 },
    { key: "open_work_orders", name: "Open Work Orders", description: "Count of open production work orders.",
      department: "Production", data_source: "work_orders", value_column: null,
      aggregation: "COUNT", period_column: "created_at", unit: "number", frequency: "MONTHLY", direction: "LOWER_BETTER" },
    { key: "qr_scans_total", name: "QR Scans", description: "Total logged QR verification scans.",
      department: "Traceability", data_source: "qr_scans", value_column: null,
      aggregation: "COUNT", period_column: "created_at", unit: "number", frequency: "MONTHLY", direction: "HIGHER_BETTER" },
    { key: "payroll_gross_month", name: "Monthly Gross Payroll", description: "Gross payroll for the period.",
      department: "HR", data_source: "v_payroll_summary", value_column: "gross_total",
      aggregation: "SUM", period_column: "period_start", unit: "UGX", frequency: "MONTHLY", direction: "LOWER_BETTER" },
    { key: "trial_balance_total", name: "Trial Balance", description: "Net balance across the general ledger.",
      department: "Finance", data_source: "v_trial_balance", value_column: "net_balance",
      aggregation: "SUM", period_column: null, unit: "UGX", frequency: "MONTHLY", direction: "HIGHER_BETTER" },
  ];
  for (const def of kpiDefs) {
    await upsert("analytics_kpis", ["tenant_id", "key"], {
      tenant_id: tenantId,
      company_id: companyId,
      key: def.key,
      name: def.name,
      description: def.description,
      department: def.department,
      data_source: def.data_source,
      value_column: def.value_column,
      aggregation: def.aggregation,
      period_column: def.period_column,
      unit: def.unit,
      frequency: def.frequency,
      direction: def.direction,
      target_value: def.target_value ?? null,
      warning_threshold: def.warning_threshold ?? null,
      critical_threshold: def.critical_threshold ?? null,
      is_active: true,
    });
    bump("analytics_kpis");
  }

  return { inserted };
}

async function ensureMesSeed(client, tenantId, companyId = null, branchId = null, facilityId = null) {
  const inserted = {};
  const bump = (t, n = 1) => {
    inserted[t] = (inserted[t] || 0) + n;
  };
  if (!companyId) {
    const { rows } = await client.query(
      "SELECT id FROM companies WHERE tenant_id = $1 AND code = 'HDG'",
      [tenantId]
    );
    if (rows.length === 0) return { inserted };
    companyId = rows[0].id;
  }
  if (!branchId) {
    const { rows } = await client.query(
      "SELECT id FROM branches WHERE tenant_id = $1 AND code = 'KAMPALA-HQ'",
      [tenantId]
    );
    if (rows.length === 0) return { inserted };
    branchId = rows[0].id;
  }
  if (!facilityId) {
    const { rows } = await client.query(
      "SELECT id FROM production_facilities WHERE company_id = $1 AND code = 'FAC-01'",
      [companyId]
    );
    if (rows.length === 0) return { inserted };
    facilityId = rows[0].id;
  }
  const row = async (table, codeCol, code) => {
    const { rows } = await client.query(
      `SELECT id FROM ${table} WHERE company_id = $1 AND tenant_id = $2 AND ${codeCol} = $3`,
      [companyId, tenantId, code]
    );
    return rows.length ? rows[0].id : null;
  };
  const count = async (table) => {
    const { rows } = await client.query(
      `SELECT count(*)::int AS n FROM ${table} WHERE company_id = $1 AND tenant_id = $2`,
      [companyId, tenantId]
    );
    return rows[0].n;
  };
  const guarded = async (table, whereSql, whereParams, data) => {
    const { rows } = await client.query(
      `SELECT id FROM ${table} WHERE ${whereSql} LIMIT 1`,
      whereParams
    );
    if (rows.length) return rows[0].id;
    const id = await insertOne(client, table, data);
    bump(table);
    return id;
  };
  const now = new Date();
  const { rows: dbTodayRows } = await client.query("SELECT CURRENT_DATE::text AS today");
  const todayStr = dbTodayRows[0].today;
  const ts = (hhmm) => {
    const parts = hhmm.split(":").map(Number);
    return new Date(now.getFullYear(), now.getMonth(), now.getDate(), parts[0], parts[1], 0, 0);
  };
  const addMin = (d, mins) => new Date(d.getTime() + mins * 60000);
  const woNo = (n) => "MO-2026-" + String(n).padStart(6, "0");

  const unit = {};
  const { rows: unitRows } = await client.query("SELECT id, code FROM units ORDER BY id");
  for (const r of unitRows) unit[r.code] = r.id;
  const prod = {};
  const { rows: prodRows } = await client.query(
    "SELECT id, code, name FROM products WHERE company_id = $1 ORDER BY id", [companyId]
  );
  for (const r of prodRows) prod[r.code] = { id: r.id, name: r.name };
  const machine = {};
  const { rows: machineRows } = await client.query(
    "SELECT id, code, name, work_centre_id FROM machines WHERE company_id = $1 ORDER BY id", [companyId]
  );
  for (const r of machineRows) machine[r.code] = r;
  const wc = {};
  const { rows: wcRows } = await client.query(
    "SELECT id, code FROM work_centres WHERE company_id = $1 ORDER BY id", [companyId]
  );
  for (const r of wcRows) wc[r.code] = r.id;
  const wh = {};
  const { rows: whRows } = await client.query(
    "SELECT id, code FROM warehouses WHERE company_id = $1 ORDER BY id", [companyId]
  );
  for (const r of whRows) wh[r.code] = r.id;
  const bin = {};
  const { rows: binRows } = await client.query(
    "SELECT b.id, b.warehouse_id FROM warehouse_bins b JOIN warehouses w ON w.id = b.warehouse_id WHERE w.company_id = $1 ORDER BY b.id", [companyId]
  );
  for (const r of binRows) bin[r.warehouse_id] = r.id;
  const user = {};
  const { rows: userRows } = await client.query(
    "SELECT id, username FROM users WHERE tenant_id = $1 AND username = ANY($2)",
    [tenantId, ["peter.prod", "qiana.qc", "opus.ops", "mia.main"]]
  );
  for (const r of userRows) user[r.username] = r.id;
  const inspPlan = {};
  const { rows: planRows } = await client.query(
    "SELECT id, code FROM inspection_plans WHERE company_id = $1 ORDER BY id", [companyId]
  );
  for (const r of planRows) inspPlan[r.code] = r.id;
  const bomId = {};
  const { rows: bomRows } = await client.query(
    "SELECT id, code FROM boms WHERE company_id = $1 ORDER BY id", [companyId]
  );
  for (const r of bomRows) bomId[r.code] = r.id;
  const routingId = {};
  const { rows: routingRows } = await client.query(
    "SELECT id, code FROM routings WHERE company_id = $1 ORDER BY id", [companyId]
  );
  for (const r of routingRows) routingId[r.code] = r.id;
  const opByRouting = {};
  const { rows: opRows } = await client.query("SELECT id, routing_id, seq FROM routing_operations ORDER BY id");
  for (const r of opRows) {
    (opByRouting[r.routing_id] ||= {})[r.seq] = r.id;
  }
  const { rows: periodRows } = await client.query(
    "SELECT id FROM financial_periods WHERE company_id = $1 AND code = 'FY2026-P12'", [companyId]
  );
  const periodId = periodRows.length ? periodRows[0].id : null;
  const { rows: supplierRows } = await client.query(
    "SELECT id FROM suppliers WHERE company_id = $1 ORDER BY id LIMIT 1", [companyId]
  );
  const supplierId = supplierRows.length ? supplierRows[0].id : null;
  const ccProd = await row("cost_centres", "code", "CC-PROD");
  const batch = {};
  const { rows: batchRows } = await client.query(
    "SELECT id, product_id FROM product_batches WHERE company_id = $1 AND id IN (137, 173, 174)", [companyId]
  );
  for (const r of batchRows) batch[r.product_id] = r.id;

  const prodA4 = prod["NATEX-A4"].id;
  const prodJumbo = prod["JUMBO-105"].id;
  const prodBob = prod["BOB-80"].id;
  const prodCarton = prod["CARTON-A4"].id;
  const prodLabel = prod["LBL-REAM"].id;
  const prodSec = prod["SEC-WM"].id;
  const peter = user["peter.prod"];
  const qiana = user["qiana.qc"];
  const opus = user["opus.ops"];
  const m1 = machine["FSS104"].id;
  const m2 = machine["FSS300"].id;
  const m3 = machine["SEC-PRINT-01"].id;
  const m4 = machine["QC-BENCH-01"].id;
  const m5 = machine["PACK-01"].id;
  const m6 = machine["FSS104-B"].id;
  const whRaw = wh["RAW-MAT"];
  const whWip = wh["WIP"];
  const whFg = wh["FG-WH"];
  const binRaw = bin[whRaw];
  const binFg = bin[whFg];
  const routing1 = routingId["ROUT-A4-80"];
  const routing2 = routingId["ROUT-SEC-WM"];
  const op1 = opByRouting[routing1][10];
  const op3 = opByRouting[routing1][30];
  const op4 = opByRouting[routing1][40];
  const opSec10 = opByRouting[routing2][10];

  // 1. Shifts
  for (const s of [
    ["A", "Shift A", "06:00:00", "14:00:00"],
    ["B", "Shift B", "14:00:00", "22:00:00"],
    ["C", "Shift C", "22:00:00", "06:00:00"],
  ]) {
    await guarded("shifts", "company_id = $1 AND code = $2", [companyId, s[0]], {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      code: s[0], name: s[1], start_time: s[2], end_time: s[3],
      grace_minutes: 0, break_minutes: 30, work_hours: 8,
      applies_to: "ALL", status: "ACTIVE",
    });
  }

  // 2. Product family + variant
  const familyId = await guarded("product_families", "company_id = $1 AND code = $2", [companyId, "FAM-NATEX-A4"], {
    company_id: companyId, tenant_id: tenantId,
    code: "FAM-NATEX-A4", name: "NATEX A4 Paper Family",
    description: "NATEX A4 ream product family (Premium / Superior grades)",
  });
  await guarded("product_variants", "company_id = $1 AND variant_code = $2", [companyId, "NATEX-A4-PRM-80-500"], {
    company_id: companyId, tenant_id: tenantId,
    product_id: prodA4, family_id: familyId, variant_code: "NATEX-A4-PRM-80-500",
    grade: "Premium", gsm: 80, dimensions: "210x297 mm", pack_size: 500,
    carton_config: "5x500", pallet_config: "40 cartons",
    specification: "A4 80gsm ream, 500 sheets per ream",
    packaging_format: "Ream + Carton", standard_cost: 12000,
    target_yield: 0.96, standard_waste_pct: 2.5,
    quality_spec: "GSM 76-84, whiteness per standard, sheet count 500",
    shelf_life_days: 365, is_active: true,
  });

  // 2b. Production standard + packaging hierarchy (NATEX A4)
  await guarded("production_standards", "company_id = $1 AND product_id = $2", [companyId, prodA4], {
    company_id: companyId, tenant_id: tenantId, branch_id: branchId,
    product_id: prodA4, version: 1,
    standard_setup_min: 45, standard_run_min_per_unit: 0.004,
    standard_labour_hours: 2, expected_output: 12000,
    expected_waste_pct: 4, waste_tolerance_pct: 2,
    standard_cost: 12000, cost_rate: 4500,
    quality_checkpoints: [
      { parameter: "Sheet count", method: "Counter", standard: "500", unit: "sheets" },
      { parameter: "GSM", method: "Scale", standard: "80", unit: "gsm" },
      { parameter: "Dimensions", method: "Ruler", standard: "210 x 297", unit: "mm" },
      { parameter: "Packaging", method: "Visual", standard: "Sealed & labelled", unit: "" },
    ],
    attributes: { product_type: "REAM", line: "SCA4-1100" },
    is_active: true,
    notes: "NATEX A4 80gsm premium superior white - SCA4-1100 production line",
    created_by: peter,
  });
  for (const pk of [
    { level: 1, level_code: "SHEET", name: "Sheet", qty_per_parent: 1, weight_kg: 0.005, sort_order: 10 },
    { level: 2, level_code: "REAM", name: "Ream (500 sheets)", qty_per_parent: 500, weight_kg: 2.5, sort_order: 20 },
    { level: 3, level_code: "CARTON", name: "Carton (5 reams)", qty_per_parent: 5, weight_kg: 12.5, sort_order: 30 },
    { level: 4, level_code: "PALLET", name: "Pallet (50 cartons)", qty_per_parent: 50, weight_kg: 625, sort_order: 40 },
  ]) {
    await guarded("packaging_hierarchies", "company_id = $1 AND product_id = $2 AND level = $3", [companyId, prodA4, pk.level], {
      company_id: companyId, tenant_id: tenantId,
      product_id: prodA4, level: pk.level, level_code: pk.level_code, name: pk.name,
      qty_per_parent: pk.qty_per_parent, weight_kg: pk.weight_kg, sort_order: pk.sort_order, is_active: true,
    });
  }

  // 3. BOM versions, lines, substitutes, co-products
  const bv1 = await guarded("bom_versions", "company_id = $1 AND bom_id = $2 AND version_no = $3", [companyId, bomId["BOM-A4-80"], 1], {
    company_id: companyId, tenant_id: tenantId, branch_id: branchId,
    bom_id: bomId["BOM-A4-80"], version_no: 1, code: "NATEX-A4-V3",
    status: "APPROVED", is_current: true, effective_from: "2026-07-01",
    notes: "Current NATEX A4 BOM", approved_by: peter, approved_at: ts("09:00"), created_by: peter,
  });
  const bv2 = await guarded("bom_versions", "company_id = $1 AND bom_id = $2 AND version_no = $3", [companyId, bomId["BOM-SEC-WM"], 1], {
    company_id: companyId, tenant_id: tenantId, branch_id: branchId,
    bom_id: bomId["BOM-SEC-WM"], version_no: 1, code: "NATEX-SEC-V1",
    status: "APPROVED", is_current: true, effective_from: "2026-07-01",
    notes: "Security watermark BOM", approved_by: peter, approved_at: ts("09:00"), created_by: peter,
  });
  const bvl = async (bvId, seq, pid, qty, uid, scrap, consumable) => {
    return guarded("bom_version_lines", "bom_version_id = $1 AND seq = $2", [bvId, seq], {
      company_id: companyId, tenant_id: tenantId,
      bom_version_id: bvId, seq,
      product_id: pid, component_code: prod[pid] ? null : null,
      quantity: qty, unit_id: uid, scrap_factor: scrap, yield_factor: 1,
      is_phantom: false, is_consumable: !!consumable, substitute_group: null,
    });
  };
  const lineJumbo = await bvl(bv1, 10, prodJumbo, 4, unit.ROLL, 0.05, false);
  await bvl(bv1, 20, prodCarton, 40, unit.CARTON, 0, false);
  await bvl(bv1, 30, prodLabel, 1000, unit.PCS, 0, true);
  await bvl(bv2, 10, prodBob, 2, unit.ROLL, 0.03, false);
  await bvl(bv2, 20, prodCarton, 20, unit.CARTON, 0, false);
  await bvl(bv2, 30, prodLabel, 500, unit.PCS, 0, true);
  if ((await count("bom_substitutes")) === 0) {
    await insertOne(client, "bom_substitutes", {
      company_id: companyId, tenant_id: tenantId,
      bom_line_id: lineJumbo, product_id: prodBob, priority: 1, is_active: true,
    });
    bump("bom_substitutes");
  }
  if ((await count("bom_co_products")) === 0) {
    await insertOne(client, "bom_co_products", {
      company_id: companyId, tenant_id: tenantId,
      bom_version_id: bv1, product_id: prodA4, co_type: "MAIN",
      quantity: 1, unit_id: unit.REAM, valuation_rule: "NONE", valuation_value: 0, is_active: true,
    });
    bump("bom_co_products");
  }
  // 4. Work instructions + routing operation materials/quality checks
  const wi = async (code, title, opId, content, safety, settings, params) => {
    return guarded("work_instructions", "company_id = $1 AND code = $2 AND version = $3", [companyId, code, 1], {
      company_id: companyId, tenant_id: tenantId,
      routing_operation_id: opId, code, title, version: 1, status: "APPROVED",
      content, safety_instructions: safety,
      machine_settings: settings, quality_parameters: params,
      media: [], is_current: true,
    });
  };
  await wi("WI-A4-CUT-001", "A4 Ream Cutting - FSS104", op1,
    "Load Jumbo roll onto unwind. Set cut length to 297mm and width to 210mm. Monitor blade sharpness every 5000 cuts.",
    "Do not operate without guards. Keep hands clear of the cutting zone. Wear cut-resistant gloves.",
    { tension: "2.5 N", cut_speed: "120 cuts/min", blade_gap_mm: 0.05 },
    { gsm: "76-84", cut_accuracy_mm: "0.5", sheet_count: 500 });
  await wi("WI-A4-QC-001", "A4 Final Quality Inspection", op3,
    "Sample 20 reams per pallet. Verify GSM, smoothness, tear strength, ream weight and sheet count. Record results in the batch record.",
    "Wear gloves when handling samples. Report any abnormal findings immediately.",
    { sampling_plan: "ISO 2859-1 level II" },
    { gsm: "76-84", smoothness: "80-200", tear_strength: "300-450", ream_weight_kg: "2.35-2.65", sheet_count: 500 });
  await wi("WI-A4-PKG-001", "A4 Ream Cartoning and Palletising", op4,
    "Place 5 reams per carton. Apply label with product, batch and quantity. Stack 40 cartons per pallet and wrap.",
    "Lift with proper technique. Do not stack above 40 cartons. Use shrink wrap safely.",
    { carton_size: "5x500", pallet_stack: 40, wrap_layers: 2 },
    { carton_seal: "sealed", label_position: "top-right" });

  await guarded("routing_operation_materials", "company_id = $1 AND routing_operation_id = $2 AND product_id = $3",
    [companyId, op1, prodJumbo], {
      company_id: companyId, tenant_id: tenantId, routing_operation_id: op1,
      product_id: prodJumbo, quantity: 4, unit_id: unit.ROLL, is_consumable: false,
      notes: "Jumbo roll input for cutting",
    });
  await guarded("routing_operation_materials", "company_id = $1 AND routing_operation_id = $2 AND product_id = $3",
    [companyId, op4, prodCarton], {
      company_id: companyId, tenant_id: tenantId, routing_operation_id: op4,
      product_id: prodCarton, quantity: 40, unit_id: unit.CARTON, is_consumable: false,
      notes: "Cartons for ream packing",
    });
  await guarded("routing_operation_materials", "company_id = $1 AND routing_operation_id = $2 AND product_id = $3",
    [companyId, op4, prodLabel], {
      company_id: companyId, tenant_id: tenantId, routing_operation_id: op4,
      product_id: prodLabel, quantity: 1000, unit_id: unit.PCS, is_consumable: true,
      notes: "Ream labels",
    });

  const roqc = async (opId, seq, code, name, std, min, max, u) => {
    const { rows } = await client.query(
      "SELECT id FROM routing_operation_quality_checks WHERE company_id = $1 AND routing_operation_id = $2 AND seq = $3",
      [companyId, opId, seq]
    );
    if (rows.length) return;
    await insertOne(client, "routing_operation_quality_checks", {
      company_id: companyId, tenant_id: tenantId, routing_operation_id: opId,
      check_code: code, check_name: name, standard_value: std,
      standard_min: min, standard_max: max, unit: u, is_required: true, seq,
    });
    bump("routing_operation_quality_checks");
  };
  await roqc(op1, 10, "QC-CUT-ACC", "Cut Accuracy", "+/-0.5mm from spec", -0.5, 0.5, "mm");
  await roqc(op3, 10, "QC-GSM", "Grammage (GSM)", "76-84", 76, 84, "gsm");
  await roqc(op3, 20, "QC-SMOOTH", "Smoothness", "80-200", 80, 200, "ml/min");
  await roqc(op3, 30, "QC-TEAR", "Tear Strength", "300-450", 300, 450, "mN");
  await roqc(op3, 40, "QC-REAM-WT", "Ream Weight", "2.35-2.65", 2.35, 2.65, "kg");
  await roqc(op3, 50, "QC-SHEETS", "Sheet Count", "500", 500, 500, "sheets");
  await roqc(op4, 10, "QC-PKG", "Packaging Integrity", "Sealed and labelled", null, null, null);
  const mia = user["mia.main"];

  // -- Remove legacy placeholder work orders so the MES seed drives the
  // -- command center instead of old demo rows (ids < 200, WO-2026-*).
  await client.query(
    "DELETE FROM work_orders WHERE company_id = $1 AND wo_no LIKE 'WO-2026-%' AND id < 200",
    [companyId]
  );

  // 6. Production orders (explicit ids, guarded by company + wo_no)
  const woUpsert = async (id, woNo, pid, qty, status, extra) => {
    const { rows } = await client.query(
      "SELECT id FROM work_orders WHERE company_id = $1 AND wo_no = $2",
      [companyId, woNo]
    );
    if (rows.length) {
      await client.query(
        `UPDATE work_orders SET
           start_date = $1, due_date = $1, quantity = $4, status = $5,
           produced_qty = $6, scrapped_qty = $7, rework_qty = $8, waste_qty = $9,
           started_at = $10, completed_at = $11, quality_started_at = $12,
           materials_issued_at = $13, machine_id = $14, operator_id = $15,
           standard_cost = $16, released_qty = $17, released_at = $18,
           priority = $19, notes = $20
         WHERE company_id = $2 AND wo_no = $3`,
        [todayStr, companyId, woNo, qty, status,
         extra.produced ?? 0, extra.scrapped ?? 0, extra.rework ?? 0, extra.waste ?? 0,
         extra.startedAt ?? null, extra.completedAt ?? null, extra.qualityStartedAt ?? null,
         extra.materialsIssuedAt ?? null, extra.machineId ?? null, extra.operatorId ?? null,
         extra.standardCost ?? 12000, extra.releasedQty ?? 0, extra.releasedAt ?? null,
         extra.priority ?? "HIGH", extra.notes ?? null]
      );
      return rows[0].id;
    }
    await client.query(
      `INSERT INTO work_orders
         (id, company_id, tenant_id, branch_id, facility_id, wo_no, product_id,
          bom_id, routing_id, bom_version_id, quantity, produced_qty, scrapped_qty,
          rework_qty, waste_qty, unit_id, priority, status, source_type,
          product_family_id, start_date, due_date, started_at, completed_at,
          quality_started_at, materials_issued_at, machine_id, operator_id,
          standard_cost, released_qty, released_at, created_by, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33)
       RETURNING id`,
      [
        id, companyId, tenantId, branchId, facilityId, woNo, pid,
        bomId["BOM-A4-80"], routing1, bv1, qty,
        extra.produced ?? 0, extra.scrapped ?? 0, extra.rework ?? 0, extra.waste ?? 0,
        unit.REAM, extra.priority ?? "HIGH", status, extra.source ?? "MTS",
        familyId, todayStr, todayStr, extra.startedAt ?? null,
        extra.completedAt ?? null, extra.qualityStartedAt ?? null,
        extra.materialsIssuedAt ?? null, extra.machineId ?? null,
        extra.operatorId ?? null, extra.standardCost ?? 12000,
        extra.releasedQty ?? 0, extra.releasedAt ?? null,
        peter, extra.notes ?? null,
      ]
    );
    bump("work_orders");
    return id;
  };
  const wo1180 = await woUpsert(1180, woNo(1180), prodA4, 10000, "COMPLETED", {
    produced: 10000, scrapped: 300, rework: 100, waste: 300,
    startedAt: ts("06:00"), completedAt: ts("14:00"),
    qualityStartedAt: ts("13:30"), materialsIssuedAt: ts("06:30"),
    machineId: m1, operatorId: peter, releasedQty: 10000, releasedAt: ts("06:00"),
    notes: "NATEX A4 Premium ream production - completed",
  });
  const wo1238 = await woUpsert(1238, woNo(1238), prodA4, 2000, "APPROVED", {
    notes: "Make-to-stock ream order awaiting release",
  });
  const wo1245 = await woUpsert(1245, woNo(1245), prodA4, 5000, "IN_PROGRESS", {
    produced: 4300, waste: 50, startedAt: ts("06:00"),
    materialsIssuedAt: ts("06:30"), machineId: m1, operatorId: peter,
    releasedQty: 5000, releasedAt: ts("06:00"),
    notes: "Shift A run on FSS104",
  });
  const wo1250 = await woUpsert(1250, woNo(1250), prodA4, 1000, "QUALITY_INSPECTION", {
    produced: 1000, startedAt: ts("08:00"), qualityStartedAt: ts("12:30"),
    machineId: m2, operatorId: peter, releasedQty: 1000, releasedAt: ts("08:00"),
    priority: "URGENT", notes: "Urgent ream order - batch on quality hold",
  });
  const wo1260 = await woUpsert(1260, woNo(1260), prodSec, 20000, "RELEASED", {
    startedAt: ts("07:00"), machineId: m3,
    releasedQty: 20000, releasedAt: ts("07:00"),
    notes: "Security watermark reams (outsourced sheeting)",
  });
  const wo1290 = await woUpsert(1290, woNo(1290), prodA4, 100, "APPROVED", {
    priority: "LOW", notes: "Sample order for trade show",
  });
  const wo1291 = await woUpsert(1291, woNo(1291), prodA4, 500, "APPROVED", {
    priority: "MEDIUM", notes: "Afternoon run on FSS300",
  });
  await client.query(
    "SELECT setval(pg_get_serial_sequence('work_orders','id'), (SELECT COALESCE(MAX(id),1) FROM work_orders))"
  );

  // 7. Work order material requirements (guarded by work_order + product)
  const wom = async (woId, pid, req, issued, uid, cost, consumable) => {
    const { rows } = await client.query(
      "SELECT id FROM work_order_materials WHERE work_order_id = $1 AND product_id = $2",
      [woId, pid]
    );
    if (rows.length) {
      await client.query(
        `UPDATE work_order_materials SET required_qty = $1, issued_qty = $2, returned_qty = 0,
           unit_id = $3, unit_cost = $4, is_consumable = $5 WHERE id = $6`,
        [req, issued, uid, cost, !!consumable, rows[0].id]
      );
      return rows[0].id;
    }
    return guarded("work_order_materials", "work_order_id = $1 AND product_id = $2", [woId, pid], {
      work_order_id: woId, product_id: pid, required_qty: req, issued_qty: issued,
      returned_qty: 0, unit_id: uid, unit_cost: cost, is_consumable: !!consumable,
    });
  };
  await wom(wo1180, prodJumbo, 400, 400, unit.ROLL, 10000, false);
  await wom(wo1180, prodCarton, 4000, 4000, unit.CARTON, 2500, false);
  await wom(wo1180, prodLabel, 100000, 100000, unit.PCS, 100, true);
  await wom(wo1245, prodJumbo, 8, 0, unit.ROLL, 10000, false);
  await wom(wo1245, prodCarton, 80, 0, unit.CARTON, 2500, false);
  await wom(wo1245, prodLabel, 2000, 0, unit.PCS, 100, true);
  await wom(wo1260, prodBob, 80, 0, unit.ROLL, 10000, false);
  await wom(wo1260, prodCarton, 80, 0, unit.CARTON, 2500, false);
  await wom(wo1260, prodLabel, 2000, 0, unit.PCS, 100, true);
  await wom(wo1290, prodJumbo, 0.4, 0, unit.ROLL, 10000, false);
  await wom(wo1290, prodCarton, 4, 0, unit.CARTON, 2500, false);
  await wom(wo1290, prodLabel, 100, 0, unit.PCS, 100, true);

  // 8. Production batches (MES batch records)
  const pb = async (batchNo, woId, pid, qty, good, rejected, status, extra) => {
    const { rows } = await client.query(
      "SELECT id FROM production_batches WHERE company_id = $1 AND batch_no = $2",
      [companyId, batchNo]
    );
    if (rows.length) {
      await client.query(
        `UPDATE production_batches SET
           work_order_id = $2, product_id = $3, machine_id = $4, work_centre_id = $5,
           quantity = $6, good_qty = $7, rejected_qty = $8, scrap_qty = $9, rework_qty = 0,
           status = $10, batch_date = $11, shift_code = 'A',
           started_at = $12, ended_at = $13, quality_result = $14
         WHERE id = $1`,
        [rows[0].id, woId, pid, extra.machineId ?? null, extra.wcId ?? null,
         qty, good, rejected, extra.scrap ?? 0, status,
         todayStr, extra.startedAt ?? null, extra.endedAt ?? null,
         extra.qualityResult ?? null]
      );
      return rows[0].id;
    }
    return guarded("production_batches", "company_id = $1 AND batch_no = $2", [companyId, batchNo], {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      batch_no: batchNo, work_order_id: woId, product_id: pid,
      bom_version_id: bv1, routing_id: routing1,
      machine_id: extra.machineId ?? null, work_centre_id: extra.wcId ?? null,
      quantity: qty, good_qty: good, rejected_qty: rejected,
      scrap_qty: extra.scrap ?? 0, rework_qty: 0, status,
      batch_date: todayStr, shift_code: "A",
      started_at: extra.startedAt ?? null, ended_at: extra.endedAt ?? null,
      operators: extra.operators ?? [peter],
      material_batches: extra.materialBatches ?? [],
      packaging: {}, pallet: {}, finished_goods_location: {},
      quality_result: extra.qualityResult ?? null, ebr_json: {}, attributes: {},
    });
  };
  const batch001 = await pb("NTX-A4-20260826-001", wo1245, prodA4, 4300, 4300, 0, "IN_PRODUCTION", {
    machineId: m1, wcId: wc["MC-CUT"], startedAt: ts("06:00"),
    materialBatches: [batch[prodJumbo]],
  });
  const batch002 = await pb("NTX-A4-20260826-002", wo1250, prodA4, 1000, 800, 200, "QUALITY_HOLD", {
    machineId: m2, wcId: wc["MC-CUT"], startedAt: ts("08:00"), qualityResult: "HOLD",
  });
  const batch003 = await pb("NTX-A4-20260826-003", wo1180, prodA4, 9600, 9600, 0, "COMPLETED", {
    machineId: m1, wcId: wc["MC-CUT"], startedAt: ts("06:00"), endedAt: ts("14:00"),
    qualityResult: "PASSED", materialBatches: [batch[prodJumbo]],
  });

  // 9. Material reservation (MRV-2026-001 for WO 1245)
  const pmrLine = async (resNo, woId, pid, req, reserved, status) => {
    return guarded("production_material_reservations",
      "company_id = $1 AND reservation_no = $2 AND work_order_id = $3 AND product_id = $4",
      [companyId, resNo, woId, pid], {
        company_id: companyId, tenant_id: tenantId, branch_id: branchId,
        reservation_no: resNo, work_order_id: woId, product_id: pid,
        batch_id: null, warehouse_id: whRaw, bin_id: binRaw,
        required_qty: req, reserved_qty: reserved, issued_qty: 0, consumed_qty: 0,
        status, reserved_at: ts("06:00"), created_by: peter,
      });
  };
  await pmrLine("MRV-2026-001", wo1245, prodJumbo, 8, 0, "PARTIAL");
  await pmrLine("MRV-2026-001", wo1245, prodCarton, 80, 0, "PARTIAL");
  await pmrLine("MRV-2026-001", wo1245, prodLabel, 2000, 0, "PARTIAL");

  // 10. Material issues (barcode-first, FIFO confirmed, batch captured)
  const pmi = async (issueNo, woId, pid, batchId, qty, cost) => {
    return guarded("production_material_issues", "company_id = $1 AND issue_no = $2", [companyId, issueNo], {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      issue_no: issueNo, work_order_id: woId, reservation_id: null,
      product_id: pid, batch_id: batchId, warehouse_id: whRaw, bin_id: binRaw,
      quantity: qty, unit_cost: cost, issue_type: "NORMAL",
      scanned_at: ts("06:30"), scanned_by: peter, fifo_confirmed: true,
      quality_status: "PASSED",
    });
  };
  await pmi("MIS-2026-001", wo1180, prodJumbo, batch[prodJumbo], 400, 10000);
  await pmi("MIS-2026-002", wo1180, prodCarton, batch[prodCarton], 4000, 2500);
  await pmi("MIS-2026-003", wo1180, prodLabel, null, 100000, 100);

  // 11. WIP balances (partial completion visible at each operation)
  const wip = async (woId, opId, wcId, mId, qty) => {
    return guarded("wip_balances",
      "company_id = $1 AND work_order_id = $2 AND COALESCE(routing_operation_id,0) = $3 AND product_id = $4",
      [companyId, woId, opId, prodA4], {
        company_id: companyId, tenant_id: tenantId,
        work_order_id: woId, routing_operation_id: opId, work_centre_id: wcId,
        machine_id: mId, product_id: prodA4, quantity: qty, unit_id: unit.REAM,
        last_posting_at: ts("13:30"),
      });
  };
  await wip(wo1245, op1, wc["MC-CUT"], m1, 4300);
  await wip(wo1245, op3, wc["MC-QC"], m4, 1200);
  await wip(wo1245, op4, wc["MC-PACK"], m5, 800);

  // 12. Scrap and waste
  await client.query(
    "DELETE FROM scrap_records WHERE company_id = $1 AND tenant_id = $2",
    [companyId, tenantId]
  );
  if ((await count("scrap_records")) === 0) {
    await insertOne(client, "scrap_records", {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      work_order_id: wo1180, production_batch_id: batch003, machine_id: m1,
      operator_id: peter, shift_code: "A", product_id: prodA4,
      scrap_type: "PRODUCTION", quantity: 300, unit_cost: 12000,
      reason: "Edge trim and damaged reams", recorded_at: ts("13:40"), recorded_by: peter,
    });
    bump("scrap_records");
  }
  await client.query(
    "DELETE FROM waste_records WHERE company_id = $1 AND tenant_id = $2",
    [companyId, tenantId]
  );
  if ((await count("waste_records")) === 0) {
    await insertOne(client, "waste_records", {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      work_order_id: wo1180, production_batch_id: batch003, machine_id: m1,
      operator_id: peter, shift_code: "A", waste_type: "NORMAL", category: "TRIM",
      input_qty: 10000, waste_qty: 300, unit_id: unit.KG,
      reason: "Standard edge trim", is_abnormal: false,
      recorded_at: ts("13:45"), recorded_by: peter,
    });
    await insertOne(client, "waste_records", {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      work_order_id: wo1245, production_batch_id: batch001, machine_id: m1,
      operator_id: opus, shift_code: "A", waste_type: "ABNORMAL", category: "SETUP",
      input_qty: 5000, waste_qty: 50, unit_id: unit.KG,
      reason: "Excess waste during setup after blade change", is_abnormal: true,
      recorded_at: ts("10:30"), recorded_by: opus,
    });
    bump("waste_records", 2);
  }

  // 13. Downtime events (252 minutes = 4.2 hours today)
  await client.query(
    "DELETE FROM downtime_events WHERE company_id = $1 AND tenant_id = $2",
    [companyId, tenantId]
  );
  if ((await count("downtime_events")) === 0) {
    const dt = async (mId, wcId, woId, cat, reason, start, dur) => {
      await insertOne(client, "downtime_events", {
        company_id: companyId, tenant_id: tenantId, branch_id: branchId,
        work_order_id: woId, production_batch_id: null, machine_id: mId,
        work_centre_id: wcId, operator_id: opus, shift_code: "A",
        category: cat, reason, started_at: start, ended_at: addMin(start, dur),
        duration_min: dur, maintenance_work_order_id: null, recorded_by: opus,
      });
    };
    await dt(m6, wc["MC-CUT"], wo1245, "MECHANICAL", "Roller bearing overheating", ts("06:00"), 60);
    await dt(m2, wc["MC-CUT"], wo1250, "ELECTRICAL", "Drive motor tripped", ts("08:00"), 48);
    await dt(m5, wc["MC-PACK"], wo1245, "MATERIAL_SHORTAGE", "Waiting for carton labels", ts("09:00"), 36);
    await dt(m1, wc["MC-CUT"], wo1245, "CHANGEOVER", "Blade change and settings", ts("10:00"), 24);
    await dt(m2, wc["MC-CUT"], wo1250, "CLEANING", "Routine cleaning", ts("11:00"), 12);
    await dt(m6, wc["MC-CUT"], null, "MAINTENANCE", "Scheduled maintenance", ts("12:00"), 60);
    await dt(m4, wc["MC-QC"], null, "SETUP", "Sampling bench setup", ts("13:00"), 12);
    bump("downtime_events", 7);
  }

  // 14. Quality hold, rework order, subcontract order
  await guarded("production_quality_holds", "company_id = $1 AND hold_no = $2", [companyId, "QH-2026-001"], {
    company_id: companyId, tenant_id: tenantId, branch_id: branchId,
    hold_no: "QH-2026-001", production_batch_id: batch002, work_order_id: wo1250,
    product_id: prodA4, reason: "Ream weight below specification on sampled cartons",
    held_qty: 1000, status: "HELD", held_by: qiana, held_at: ts("12:30"),
  });
  await guarded("rework_orders", "company_id = $1 AND rework_no = $2", [companyId, "RWK-2026-001"], {
    company_id: companyId, tenant_id: tenantId, branch_id: branchId,
    rework_no: "RWK-2026-001", source_work_order_id: wo1245,
    production_batch_id: batch001, product_id: prodA4, quantity: 100,
    status: "DRAFT", material_required: { jumbo: 0.2, carton: 2, label: 50 },
    rework_cost: 1200000, notes: "Rework of mis-counted reams from FSS104",
  });
  // Subcontract demo needs an existing supplier; on a fresh rebuild none may
  // exist yet (no test depends on SUB-2026-001), so skip it in that case.
  if (supplierId) {
    await guarded("subcontract_orders", "company_id = $1 AND subcon_no = $2", [companyId, "SUB-2026-001"], {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      subcon_no: "SUB-2026-001", work_order_id: wo1260, operation_id: opSec10,
      supplier_id: supplierId, product_id: prodSec, quantity: 500,
      status: "DRAFT", vendor_cost: 150000,
      notes: "Outsourced sheeting of security watermark reams",
    });
  }

  // 15. Changeover log + machine event logs
  if ((await count("changeover_logs")) === 0) {
    await insertOne(client, "changeover_logs", {
      company_id: companyId, tenant_id: tenantId,
      machine_id: m1, from_product_id: prodA4, to_product_id: prodA4,
      work_order_id: wo1245, planned_minutes: 30, actual_minutes: 32,
      steps: [
        { name: "Clean Machine" },
        { name: "Change Blade" },
        { name: "Adjust Settings" },
        { name: "Quality Setup Check" },
      ],
      status: "COMPLETED", started_at: ts("05:30"), completed_at: addMin(ts("05:30"), 32),
    });
    bump("changeover_logs");
  }
  if ((await count("machine_logs")) === 0) {
    const mlog = async (mId, woId, event, from, to, reason, at) => {
      await insertOne(client, "machine_logs", {
        company_id: companyId, tenant_id: tenantId,
        machine_id: mId, work_order_id: woId, event_type: event,
        status_from: from, status_to: to, reason: reason ?? null,
        operator_id: peter, occurred_at: at, payload: {},
      });
    };
    await mlog(m1, wo1245, "STARTED", "IDLE", "RUNNING", null, ts("06:00"));
    await mlog(m2, wo1250, "BREAKDOWN", "RUNNING", "BREAKDOWN", "Electrical trip on drive motor", ts("08:00"));
    await mlog(m6, null, "MAINTENANCE_STARTED", "IDLE", "MAINTENANCE", "Scheduled maintenance", ts("12:00"));
    bump("machine_logs", 3);
  }

  // 16. Digital shift handover
  await guarded("production_shift_handovers", "company_id = $1 AND handover_no = $2", [companyId, "HD-2026-001"], {
    company_id: companyId, tenant_id: tenantId, branch_id: branchId,
    handover_no: "HD-2026-001", work_order_id: wo1245, machine_id: m1,
    from_shift_code: "A", to_shift_code: "B", shift_date: todayStr,
    produced_qty: 18500, outstanding_qty: 1500, machine_status: "RUNNING",
    issues: "Blade requires inspection",
    material_status: "Paper Roll - 2,000 KG remaining",
    quality_status: "Batch NTX-A4-20260826-001 - Passed",
    from_operator_id: opus, status: "PENDING",
  });

  // Ensure the SHO numbering sequence starts at 1 for auto-created handovers.
  await client.query(
    "INSERT INTO document_numbers (tenant_id, prefix, doc_year, last_seq) VALUES ($1, 'SHO', $2, 0) ON CONFLICT (tenant_id, prefix, doc_year) DO NOTHING",
    [tenantId, new Date().getFullYear()]
  );

  // 17. Material availability checks (before release)
  const avLine = (code, required, onHand, critical) => {
    const p = prod[code];
    return {
      productId: p.id, productCode: code, productName: p.name,
      required, onHand, available: onHand >= required, critical,
    };
  };
  const mac = async (checkNo, woId, status, result, at) => {
    return guarded("material_availability_checks", "company_id = $1 AND check_no = $2", [companyId, checkNo], {
      company_id: companyId, tenant_id: tenantId,
      work_order_id: woId, check_no: checkNo, status,
      result, overridden: false, checked_at: at, checked_by: peter,
    });
  };
  await mac("MAC-2026-001", wo1290, "PASS", [
    avLine("JUMBO-105", 0.4, 580.71, true),
    avLine("CARTON-A4", 4, 1197.2, false),
    avLine("LBL-REAM", 100, 19930, false),
  ], ts("08:00"));
  await mac("MAC-2026-002", wo1260, "FAIL", [
    avLine("BOB-80", 80, 40, true),
    avLine("CARTON-A4", 80, 1197.2, false),
    avLine("LBL-REAM", 2000, 19930, false),
  ], ts("07:30"));

  // 18. Production alerts (pinned ids 12-22 so re-seeding stays deterministic)
  await client.query("DELETE FROM production_alerts WHERE company_id = $1 AND tenant_id = $2", [companyId, tenantId]);
  const alert = async (id, type, severity, title, message, refType, refId, at) => {
    await insertOne(client, "production_alerts", {
      id, company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      alert_type: type, severity, title, message,
      ref_type: refType, ref_id: refId, status: "OPEN", payload: {}, created_at: at,
    });
    bump("production_alerts");
  };
  await alert(12, "MATERIAL_SHORTAGE", "CRITICAL", "BOB-80 jumbo rolls short",
    "MO-2026-001260 needs 80 BOB-80 rolls but only 40 are available", "work_orders", wo1260, ts("07:00"));
  await alert(13, "MACHINE_BREAKDOWN", "CRITICAL", "FSS300 drive motor tripped",
    "Machine stopped at 08:00 - electrical fault", "machines", m2, ts("08:00"));
  await alert(14, "PRODUCTION_DELAY", "WARNING", "MO-2026-001245 behind plan",
    "FSS104 produced 4,300 of 5,000 reams; material shortage earlier in shift", "work_orders", wo1245, ts("09:00"));
  await alert(15, "QUALITY_FAILURE", "CRITICAL", "Batch NTX-A4-20260826-002 on hold",
    "Ream weight below specification - quarantined for disposition", "production_batches", batch002, ts("12:30"));
  await alert(16, "HIGH_WASTE", "WARNING", "MO-2026-001180 waste above 5%",
    "Waste and scrap total 6.0% of output", "work_orders", wo1180, ts("13:45"));
  await alert(17, "OEE_BELOW_TARGET", "WARNING", "FSS104 OEE below 85% target",
    "OEE at 80.0% due to changeover and downtime", "machines", m1, ts("10:00"));
  await alert(18, "ORDER_DEADLINE", "WARNING", "MO-2026-001250 due today",
    "Urgent order on quality hold - delivery at risk", "work_orders", wo1250, ts("11:00"));
  await alert(19, "MAINTENANCE_DUE", "WARNING", "FSS104-B maintenance in progress",
    "Scheduled maintenance started at 12:00", "machines", m6, ts("12:00"));
  await alert(20, "MATERIAL_RUNNING_LOW", "INFO", "Carton stock below reorder point",
    "CARTON-A4 on hand 1,197 against 30-day demand of 6,000", "products", prodCarton, ts("09:30"));
  await alert(21, "CAPACITY_OVERLOAD", "WARNING", "FSS300 overloaded this afternoon",
    "Two orders scheduled back-to-back exceed remaining capacity", "machines", m2, ts("07:30"));
  await alert(22, "APPROVAL_PENDING", "INFO", "MO-2026-001238 awaiting release approval",
    "Make-to-stock order waiting for supervisor approval", "work_orders", wo1238, ts("06:15"));
  await client.query(
    "SELECT setval(pg_get_serial_sequence('production_alerts','id'), (SELECT COALESCE(MAX(id),1) FROM production_alerts))"
  );

  // 19. Immutable manufacturing events
  if ((await count("manufacturing_events")) === 0) {
    const ev = async (type, eType, eId, eCode, at, payload) => {
      await insertOne(client, "manufacturing_events", {
        company_id: companyId, tenant_id: tenantId, branch_id: branchId,
        event_type: type, entity_type: eType, entity_id: eId, entity_code: eCode,
        payload: payload ?? {}, occurred_at: at, user_id: peter,
      });
      bump("manufacturing_events");
    };
    await ev("production.order.released", "work_orders", wo1260, woNo(1260), ts("07:00"));
    await ev("production.material.reserved", "work_orders", wo1245, woNo(1245), ts("06:05"));
    await ev("production.material.issued", "work_orders", wo1180, woNo(1180), ts("06:30"));
    await ev("production.started", "work_orders", wo1245, woNo(1245), ts("06:00"));
    await ev("production.output.posted", "work_orders", wo1180, woNo(1180), ts("14:00"));
    await ev("production.scrap.recorded", "work_orders", wo1180, woNo(1180), ts("13:40"));
    await ev("production.quality.failed", "production_batches", batch002, "NTX-A4-20260826-002", ts("12:30"));
    await ev("production.quality.passed", "production_batches", batch003, "NTX-A4-20260826-003", ts("14:00"));
    await ev("production.completed", "work_orders", wo1180, woNo(1180), ts("14:00"));
    await ev("machine.started", "machines", m1, "FSS104", ts("06:00"));
    await ev("machine.breakdown", "machines", m2, "FSS300", ts("08:00"));
    await ev("machine.maintenance.started", "machines", m6, "FSS104-B", ts("12:00"));
  }

  // 20. Manufacturing documents
  const doc = async (docNo, docType, woId) => {
    return guarded("production_documents", "company_id = $1 AND doc_no = $2", [companyId, docNo], {
      company_id: companyId, tenant_id: tenantId, branch_id: branchId,
      doc_type: docType, doc_no: docNo, work_order_id: woId,
      content: {}, status: "GENERATED", generated_at: ts("14:30"), generated_by: peter,
    });
  };
  await doc("DOC-MES-2026-001", "PRODUCTION_ORDER", wo1245);
  await doc("DOC-MES-2026-002", "MATERIAL_REQUISITION", wo1245);
  await doc("DOC-MES-2026-003", "MATERIAL_ISSUE_NOTE", wo1180);
  await doc("DOC-MES-2026-004", "JOB_CARD", wo1245);
  await doc("DOC-MES-2026-005", "ROUTE_SHEET", wo1245);
  await doc("DOC-MES-2026-006", "PRODUCTION_REPORT", wo1180);
  await doc("DOC-MES-2026-007", "SHIFT_HANDOVER", wo1245);
  await doc("DOC-MES-2026-008", "BATCH_RECORD", wo1245);

  const round2 = (n) => Math.round(n * 100) / 100;

  // 21. Production variances (cost / material / machine)
  await client.query("DELETE FROM production_variances WHERE company_id = $1 AND tenant_id = $2", [companyId, tenantId]);
  const pv = async (type, std, actual, reason) => {
    const variance = actual - std;
    await insertOne(client, "production_variances", {
      company_id: companyId, tenant_id: tenantId, work_order_id: wo1180,
      variance_type: type, standard_value: std, actual_value: actual,
      variance, variance_pct: round2((variance / std) * 100),
      reason, calculated_at: ts("14:05"),
    });
    bump("production_variances");
  };
  await pv("COST", 170000000, 171264000, "Cost overrun from material and machine variance");
  await pv("MATERIAL", 134000000, 134516000, "Paper input price higher than standard");
  await pv("MACHINE", 11764000, 11776800, "Extra machine hours on FSS104");

  // 22. Demand forecast feeding MRP
  await guarded("demand_forecasts", "company_id = $1 AND forecast_no = $2", [companyId, "FC-2026-001"], {
    company_id: companyId, tenant_id: tenantId, branch_id: branchId,
    forecast_no: "FC-2026-001", product_id: prodA4,
    period_start: "2026-08-01", period_end: "2026-08-31",
    quantity: 30000, confidence: 85, scenario: "BASE", source: "MANUAL",
    status: "APPROVED", notes: "August NATEX A4 demand forecast",
  });

  // 23. Production schedule (finite capacity visual board)
  const schedId = await guarded("production_schedules", "company_id = $1 AND schedule_no = $2", [companyId, "SCH-2026-001"], {
    company_id: companyId, tenant_id: tenantId, branch_id: branchId,
    schedule_no: "SCH-2026-001", schedule_date: todayStr,
    status: "PUBLISHED", created_by: peter,
  });
  const schedEntry = async (woId, mId, wcId, start, end, seq, status, changeover) => {
    return guarded("production_schedule_entries",
      "schedule_id = $1 AND work_order_id = $2 AND machine_id = $3",
      [schedId, woId, mId], {
        company_id: companyId, tenant_id: tenantId,
        schedule_id: schedId, work_order_id: woId, machine_id: mId,
        work_centre_id: wcId, planned_start: start, planned_end: end,
        priority: 1, sequence: seq, changeover_min: changeover ?? 0, status,
      });
  };
  await schedEntry(wo1245, m1, wc["MC-CUT"], ts("06:00"), ts("14:00"), 1, "CONFIRMED");
  await schedEntry(wo1250, m2, wc["MC-CUT"], ts("08:00"), ts("16:00"), 2, "CONFIRMED");
  await schedEntry(wo1291, m2, wc["MC-CUT"], ts("16:00"), ts("20:00"), 3, "PLANNED");
  await schedEntry(wo1260, m3, wc["MC-LABOUR"], ts("08:00"), ts("16:00"), 4, "CONFIRMED", 30);

  // 24. Final inspection with pass/fail results (16/17 = 94.1% pass rate)
  await client.query(
    "DELETE FROM inspections WHERE company_id = $1 AND inspection_no = $2",
    [companyId, "INS-MES-FIN-001"]
  );
  const inspId = await insertOne(client, "inspections", {
    company_id: companyId, tenant_id: tenantId,
    inspection_no: "INS-MES-FIN-001", plan_id: inspPlan["INSP-FIN-A4"],
    kind: "FINAL", ref_type: "work_orders", ref_id: wo1180,
    product_id: prodA4, batch_id: batch[prodA4], work_order_id: wo1180,
    quantity: 10000, sampled_qty: 400, result: "PASSED", status: "APPROVED",
    inspector_id: qiana, inspected_at: ts("13:30"), completed_at: ts("14:00"),
    approved_by: qiana, approved_at: ts("14:00"),
  });
  bump("inspections");
  const ir = async (parameter, method, std, actual, unit, passed, notes) => {
    await insertOne(client, "inspection_results", {
      inspection_id: inspId, parameter, method, standard_value: std,
      actual_value: actual, unit, passed, notes: notes ?? null,
    });
    bump("inspection_results");
  };
  for (let s = 1; s <= 4; s++) {
    await ir("gsm", "ISO 536", "76-84", "80", "gsm", true, `Sample ${s}`);
    await ir("smoothness", "Bendtsen", "80-200", "140", "ml/min", true, `Sample ${s}`);
    await ir("tear_strength", "Elmendorf", "300-450", "380", "mN", true, `Sample ${s}`);
    await ir("ream_weight", "weighing", "2.35-2.65", "2.5", "kg", true, `Sample ${s}`);
  }
  await ir("sheet_count", "manual count", "500", "499", "sheets", false, "Count shortfall in sample 4");

  // 25. Production outputs (good / scrap / rework)
  await client.query("DELETE FROM production_outputs WHERE work_order_id = $1", [wo1180]);
  const po = async (type, qty, batchId, cost, reason, at) => {
    await insertOne(client, "production_outputs", {
      work_order_id: wo1180, output_type: type, quantity: qty,
      batch_id: batchId, unit_cost: cost, reason: reason ?? null,
      recorded_by: peter, recorded_at: at,
    });
    bump("production_outputs");
  };
  await po("GOOD", 9600, batch[prodA4], 12000, "Good output from batch NTX-A4-20260826-003", ts("14:00"));
  await po("SCRAP", 300, batch[prodA4], 12000, "Edge trim and damaged reams", ts("13:40"));
  await po("REWORK", 100, batch[prodA4], 12000, "Reams returned for rework", ts("14:00"));

  // 26. Production costing (standard vs actual per ream)
  await client.query("DELETE FROM production_costs WHERE company_id = $1 AND tenant_id = $2", [companyId, tenantId]);
  const costId = await insertOne(client, "production_costs", {
    company_id: companyId, tenant_id: tenantId,
    work_order_id: wo1180, product_id: prodA4, period_id: periodId,
    cost_date: todayStr, quantity: 10000,
    expected_cost: 170000000, actual_cost: 171264000, variance: 1264000,
    status: "POSTED", calculated_by: peter, calculated_at: ts("14:05"),
  });
  bump("production_costs");
  const pc = async (type, amount, qty, rate, notes) => {
    await insertOne(client, "production_cost_components", {
      production_cost_id: costId, component_type: type,
      cost_centre_id: ccProd, amount, quantity: qty, rate, notes: notes ?? null,
    });
    bump("production_cost_components");
  };
  await pc("MATERIAL", 134000000, 400, 335000, "Jumbo rolls plus cartons and labels");
  await pc("LABOUR", 17500000, 8, 2187500, "Shift A labour on FSS104");
  await pc("MACHINE", 11764000, 7.36, 1598369.5652, "FSS104 machine hours");
  await pc("PACKAGING", 8000000, 4000, 2000, "Carton packing materials");
  await client.query(
    `UPDATE work_orders SET
       actual_material_cost = $1, actual_labour_cost = $2, actual_machine_cost = $3,
       actual_overhead_cost = $4, actual_waste_cost = $5, actual_other_cost = $6,
       actual_cost = $7, cost_variance = $8, yield_percent = $9, efficiency_percent = $10
     WHERE id = $11`,
    [134000000, 17500000, 11764000, 0, 0, 0, 171264000, 1264000, 96, 85, wo1180]
  );

  // 27. Machine state, additional machines, and daily capacity for OEE
  const mcState = async (mId, state, prodHrs, dtHrs, maint) => {
    await client.query(
      "UPDATE machines SET machine_state = $1, production_hours = $2, downtime_hours = $3, maintenance_status = $4 WHERE id = $5",
      [state, prodHrs, dtHrs, maint, mId]
    );
  };
  await mcState(m1, "RUNNING", 7.36, 0.4, "NONE");
  await mcState(m2, "RUNNING", 7.41, 0.5, "NONE");
  await mcState(m3, "RUNNING", 7.46, 0.6, "NONE");
  await mcState(m4, "RUNNING", 7.85, 0.1, "NONE");
  await mcState(m5, "IDLE", 7.85, 0.1, "NONE");
  await mcState(m6, "MAINTENANCE", 7.0, 1.0, "IN_PROGRESS");
  await client.query("UPDATE machines SET status = 'MAINTENANCE' WHERE id = $1", [m6]);

  const newMachine = async (code, name, wcId, type, capacity, capUnit, opts = {}) => {
    return guarded("machines", "company_id = $1 AND code = $2", [companyId, code], {
      company_id: companyId, tenant_id: tenantId, facility_id: facilityId,
      work_centre_id: wcId, code, name, type,
      capacity, capacity_unit: capUnit, hourly_rate: opts.hourlyRate ?? 150000,
      status: "OPERATIONAL", machine_state: opts.machineState ?? "RUNNING",
      production_hours: opts.productionHours ?? 7.474, downtime_hours: opts.downtimeHours ?? 0.4,
      maintenance_status: "NONE", is_secure: false, attributes: opts.attributes ?? {},
    });
  };
  const m7 = await newMachine("FSS207", "FSS207 Sheet Cutter", wc["MC-CUT"], "CUTTING", 1200, "REAMS/HR");
  const m8 = await newMachine("FSS208", "FSS208 Sheet Cutter", wc["MC-CUT"], "CUTTING", 1100, "REAMS/HR");
  const m9 = await newMachine("PACK-02", "PACK-02 Ream Packing", wc["MC-PACK"], "PACKING", 800, "CARTONS/HR");
  const m10 = await newMachine("CART-01", "CART-01 Cartoning Line", wc["MC-PACK"], "PACKING", 700, "CARTONS/HR");

  // SCA4-1100 primary A4 production line (NATEX A4) - QR identity, machine,
  // daily capacity and routing wiring. Guarded for idempotency.
  const sca4Admin = (
    await client.query(
      "SELECT id FROM users WHERE company_id = $1 AND email = 'admin@hopedesign.co.ug' ORDER BY id LIMIT 1",
      [companyId]
    )
  ).rows[0]?.id ?? null;
  const sca4Qr = await guarded("qr_codes", "company_id = $1 AND code = $2", [companyId, "HDG-MC-SCA4-1100"], {
    company_id: companyId, tenant_id: tenantId, code: "HDG-MC-SCA4-1100",
    secret_hash: qrSecretHash(qrSecret()), entity_type: "MACHINE", entity_id: null,
    status: "ACTIVE", generated_by: sca4Admin,
  });
  const m11 = await newMachine("SCA4-1100", "SCA4-1100 A4 Production Line", wc["MC-CUT"], "SHEET_CUTTER", 1200, "REAMS/HR", {
    hourlyRate: 35000,
    attributes: { line: "SCA4-1100", primary: true, only_manufactured_fg: "NATEX-A4" },
  });
  await client.query("UPDATE qr_codes SET entity_id = $1 WHERE id = $2 AND entity_id IS NULL", [m11, sca4Qr]);
  await client.query("UPDATE machines SET qr_id = $1 WHERE id = $2", [sca4Qr, m11]);
  // Wire SCA4-1100 into the NATEX A4 routing as the primary slitting/cutting step
  if (routing1 && op1) {
    await client.query(
      "UPDATE routing_operations SET name = 'Slitting / Cutting', machine_id = $1 WHERE id = $2",
      [m11, op1]
    );
    await client.query(
      "UPDATE work_instructions SET title = 'A4 Slitting / Cutting - SCA4-1100' WHERE company_id = $1 AND code = 'WI-A4-CUT-001' AND version = 1",
      [companyId]
    );
  }

  const cap = async (mId, wcId, dtHrs, actualHrs) => {
    return guarded("machine_capacity",
      "company_id = $1 AND machine_id = $2 AND capacity_date = $3 AND COALESCE(shift_code,'') = $4",
      [companyId, mId, todayStr, "A"], {
        company_id: companyId, tenant_id: tenantId, machine_id: mId,
        work_centre_id: wcId, capacity_date: todayStr, shift_code: "A",
        available_hours: 8, scheduled_hours: 8, actual_hours: actualHrs,
        downtime_hours: dtHrs, maintenance_hours: 0, changeover_hours: 0,
        break_hours: 0, remaining_hours: 0,
        utilization_pct: round2((actualHrs / 8) * 100),
        efficiency_pct: round2((actualHrs / 8) * 100),
        oee_pct: null,
      });
  };
  const mwc = (code) => (machine[code] ? machine[code].work_centre_id : null);
  await client.query(
    "DELETE FROM machine_capacity WHERE company_id = $1 AND tenant_id = $2",
    [companyId, tenantId]
  );
  await cap(m1, mwc("FSS104"), 0.4, 7.35961);
  await cap(m2, mwc("FSS300"), 0.5, 7.41066);
  await cap(m3, mwc("SEC-PRINT-01"), 0.6, 7.46275);
  await cap(m4, mwc("QC-BENCH-01"), 0.1, 7.84759);
  await cap(m5, mwc("PACK-01"), 0.1, 7.84759);
  await cap(m6, mwc("FSS104-B"), 1.0, 6.9997);
  await cap(m7, wc["MC-CUT"], 0.4, 7.474);
  await cap(m8, wc["MC-CUT"], 0.4, 7.474);
  await cap(m9, wc["MC-PACK"], 0.4, 7.474);
  await cap(m10, wc["MC-PACK"], 0.4, 7.474);
  await cap(m11, wc["MC-CUT"], 0.4, 7.474);

  return { inserted };
}
function qrSecret() {
  return crypto.randomBytes(24).toString("hex");
}

function qrSecretHash(secret) {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

async function seedAll(pool) {
  const client = await pool.connect();
  const stats = {};
  const bump = (key, n = 1) => {
    stats[key] = (stats[key] || 0) + n;
  };
  try {
    await client.query("BEGIN");

    // Guard: already seeded for tenant HDG?
    const { rows: trows } = await client.query(
      "SELECT id FROM tenants WHERE code = 'HDG'"
    );
    let tenantId = trows.length ? trows[0].id : null;
    if (tenantId) {
      const guard = await client.query(
        "SELECT 1 FROM configs WHERE tenant_id = $1 AND key = 'seed.completed'",
        [tenantId]
      );
      if (guard.rowCount > 0) {
        const counts = await reconcileRbac(client, tenantId);
        const stock = await ensureOpeningStock(client, tenantId);
        const stat = await ensureStatutoryConfigs(client, tenantId);
        const lst = await ensureCompanyStatutoryOverrides(client, tenantId);
        const hcm = await ensureHcmSeed(client, tenantId);
        const cb = await ensureContractBuilderSeed(client, tenantId);
        const assetSeed = await ensureAssetModuleSeed(client, tenantId);
        const analyticsSeed = await ensureAnalyticsSeed(client, tenantId);
        const mesSeed = await ensureMesSeed(client, tenantId);
        const masters = await ensureCrmProcurementMasters(client, tenantId);
        await client.query("COMMIT");
        console.log("Seed already completed for tenant HDG; reconciled RBAC from catalogue.", counts, stock, stat, lst, masters, hcm, cb, assetSeed, analyticsSeed, mesSeed);
        return { skipped: true, reconciled: counts, stock, statutory: stat, lstOverride: lst, masters, hcm, contractBuilder: cb, assetModule: assetSeed, analytics: analyticsSeed, mes: mesSeed };
      }
    }

    // ============================================================
    // 1. Organisation structure
    // ============================================================
    if (!tenantId) {
      tenantId = await insertOne(client, "tenants", {
        code: "HDG",
        name: "Hope Design Group Ltd",
        status: "ACTIVE",
        settings: { timezone: "Africa/Kampala", locale: "en-UG" },
      });
    }
    bump("tenants");

    // Adopt pre-existing HDG org rows: bootstrap-org.sql / migrations keep
    // tenant/company/branch at id 2, and several migrations hard-code that id.
    // Falls back to inserting when absent so fresh seeds work identically.
    const companyRow = await client.query(
      "SELECT id FROM companies WHERE tenant_id = $1 AND code = 'HDG'",
      [tenantId]
    );
    const companyId = companyRow.rowCount
      ? companyRow.rows[0].id
      : await insertOne(client, "companies", {
          tenant_id: tenantId,
          code: "HDG",
          name: "Hope Design Group Ltd",
          legal_name: "Hope Design Group Ltd",
          tin: "1012345678",
          vrn: "VAT-UG-1020304",
          currency: "UGX",
          address: "Plot 12, Namanve Industrial Park, Kampala, Uganda",
          phone: "+256 414 000 000",
          email: "info@hopedesign.jorlentech.com",
          website: "https://hopedesign.jorlentech.com",
          fiscal_year_start: "07-01",
          status: "ACTIVE",
        });
    bump("companies");

    const branchRow = await client.query(
      "SELECT id FROM branches WHERE company_id = $1 AND tenant_id = $2 AND code = 'KAMPALA-HQ'",
      [companyId, tenantId]
    );
    const branchId = branchRow.rowCount
      ? branchRow.rows[0].id
      : await insertOne(client, "branches", {
          company_id: companyId,
          tenant_id: tenantId,
          code: "KAMPALA-HQ",
          name: "Kampala Headquarters",
          address: "Plot 12, Namanve Industrial Park, Kampala, Uganda",
          phone: "+256 414 000 000",
          email: "info@hopedesign.jorlentech.com",
          status: "ACTIVE",
        });
    bump("branches");

    const departments = [
      ["FIN", "Finance"],
      ["SAL", "Sales & Marketing"],
      ["PROD", "Production"],
      ["WH", "Warehouse"],
      ["QC", "Quality Control"],
      ["SEC", "Security Printing"],
      ["MAINT", "Maintenance"],
      ["HR", "Human Resources"],
      ["PROC", "Procurement"],
      ["LOG", "Logistics"],
      ["IT", "Information Technology"],
    ];
    const deptId = {};
    for (const [code, name] of departments) {
      deptId[code] = await insertOne(client, "departments", {
        company_id: companyId,
        tenant_id: tenantId,
        branch_id: branchId,
        code,
        name,
        status: "ACTIVE",
      });
      bump("departments");
    }

    const facilityId = await insertOne(client, "production_facilities", {
      company_id: companyId,
      tenant_id: tenantId,
      branch_id: branchId,
      code: "FAC-01",
      name: "Hope Design Main Plant",
      address: "Namanve Industrial Park, Kampala",
      status: "ACTIVE",
    });
    bump("production_facilities");

    const costCentres = [
      ["CC-PROD", "Production"],
      ["CC-SEC", "Security Printing"],
      ["CC-ADMIN", "Administration"],
      ["CC-SALES", "Sales & Marketing"],
      ["CC-WH", "Warehouse"],
    ];
    for (const [code, name] of costCentres) {
      await insertOne(client, "cost_centres", {
        company_id: companyId,
        tenant_id: tenantId,
        code,
        name,
        status: "ACTIVE",
      });
      bump("cost_centres");
    }

    for (const [code, name] of [
      ["PC-PAPER", "Paper Products"],
      ["PC-SEC", "Security Printing"],
    ]) {
      await insertOne(client, "profit_centres", {
        company_id: companyId,
        tenant_id: tenantId,
        code,
        name,
        status: "ACTIVE",
      });
      bump("profit_centres");
    }

    // CRM/procurement master rows with fixed ids (customer 1 / supplier 1).
    const masters = await ensureCrmProcurementMasters(client, tenantId);
    bump("masters", (masters.customers || 0) + (masters.suppliers || 0));

    // ============================================================
    // 2. Warehouses, zones, racks, shelves, bins
    // ============================================================
    const warehouses = [
      ["RAW-MAT", "Raw Materials", "RAW_MATERIAL", false, 120000],
      ["WIP", "Work in Progress", "WIP", false, 5000],
      ["FG-WH", "Finished Goods Warehouse", "FINISHED_GOODS", false, 100000],
      ["SEC-WH", "Secure Store", "SECURE", true, 2000],
      ["QUARANTINE", "Quarantine", "QUARANTINE", false, 1000],
      ["DAMAGED", "Damaged Goods", "DAMAGED", false, 1000],
      ["RETURNS", "Customer Returns", "RETURNS", false, 1000],
      ["CONS-WH", "Consumables Store", "CONSUMABLES", false, 30000],
      ["SPARE-WH", "Spare Parts Store", "SPARE_PARTS", false, 2000],
      ["PACK-WH", "Packaging Materials Store", "PACKAGING", false, 30000],
    ];
    const whId = {};
    for (const [code, name, type, isSecure, capacity] of warehouses) {
      // Adopt migration-created warehouses (e.g. PACK-WH from 0113) with their
      // full zone/rack/shelf/bin hierarchy; only fresh seeds insert everything.
      const existingWh = await client.query(
        "SELECT id FROM warehouses WHERE company_id = $1 AND code = $2",
        [companyId, code]
      );
      if (existingWh.rowCount) {
        whId[code] = existingWh.rows[0].id;
        continue;
      }
      whId[code] = await insertOne(client, "warehouses", {
        company_id: companyId,
        tenant_id: tenantId,
        branch_id: branchId,
        facility_id: facilityId,
        code,
        name,
        type,
        is_secure: isSecure,
        capacity_qty: capacity,
        status: "ACTIVE",
      });
      bump("warehouses");
      const zoneId = await insertOne(client, "warehouse_zones", {
        warehouse_id: whId[code],
        code: "Z1",
        name: `${name} Zone 1`,
      });
      bump("warehouse_zones");
      const rackId = await insertOne(client, "warehouse_racks", {
        zone_id: zoneId,
        code: "R1",
      });
      bump("warehouse_racks");
      const shelfId = await insertOne(client, "warehouse_shelves", {
        rack_id: rackId,
        code: "S1",
      });
      bump("warehouse_shelves");
      await insertOne(client, "warehouse_bins", {
        warehouse_id: whId[code],
        shelf_id: shelfId,
        code: "BIN-01",
        name: `${name} Bin 1`,
        is_secure: isSecure,
        capacity_qty: capacity,
      });
      bump("warehouse_bins");
    }

    // ============================================================
    // 3. Finance: currencies, periods, chart of accounts, banks
    // ============================================================
    // currencies uses code as PK (no id column) - plain upserts
    await client.query(
      "INSERT INTO currencies (code, name, symbol, is_base) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING",
      ["UGX", "Uganda Shilling", "USh", true]
    );
    await client.query(
      "INSERT INTO currencies (code, name, symbol, is_base) VALUES ($1, $2, $3, $4) ON CONFLICT (code) DO NOTHING",
      ["USD", "US Dollar", "$", false]
    );
    bump("currencies", 2);
    await insertOne(client, "exchange_rates", {
      currency_code: "USD",
      rate: 3800,
    });
    bump("exchange_rates");

    // Tax master (VAT / exempt treatments)
    const taxRows = [
      ["VAT18", "Standard VAT", "VAT", 18],
      ["VAT0", "Zero Rated", "VAT", 0],
      ["EXEMPT", "Exempt", "EXEMPT", 0],
    ];
    for (const [code, name, taxType, rate] of taxRows) {
      await client.query(
        "INSERT INTO taxes (company_id, tenant_id, code, name, tax_type, rate, is_active) VALUES ($1, $2, $3, $4, $5, $6, true) ON CONFLICT (company_id, code) DO NOTHING",
        [companyId, tenantId, code, name, taxType, rate]
      );
    }
    bump("taxes");

    // FY2026 = 2026-07-01 .. 2027-06-30 (12 monthly periods)
    const periodRows = [];
    for (let i = 0; i < 12; i++) {
      const start = new Date(Date.UTC(2026, 6 + i, 1));
      const end = new Date(Date.UTC(2026, 7 + i, 0));
      const fmt = (d) =>
        `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
      const month = String(i + 1).padStart(2, "0");
      periodRows.push({
        company_id: companyId,
        tenant_id: tenantId,
        code: `FY2026-P${month}`,
        name: `FY2026 Period ${month}`,
        start_date: fmt(start),
        end_date: fmt(end),
        status: i === 0 ? "OPEN" : "OPEN",
      });
    }
    await bulkInsert(client, "financial_periods", periodRows);
    bump("financial_periods", periodRows.length);

    // Chart of accounts (is_posting=false only for parent headings)
    const coaRows = [
      { code: "1000", name: "Cash & Bank", account_type: "ASSET", is_posting: true, parent: null, currency: "UGX" },
      { code: "1100", name: "Stanbic Bank UGX", account_type: "ASSET", is_posting: true, parent: "1000", currency: "UGX" },
      { code: "1110", name: "Stanbic Bank USD", account_type: "ASSET", is_posting: true, parent: "1000", currency: "USD" },
      { code: "1120", name: "Bank of Baroda UGX", account_type: "ASSET", is_posting: true, parent: "1000", currency: "UGX" },
      { code: "1200", name: "Petty Cash", account_type: "ASSET", is_posting: true, parent: "1000", currency: "UGX" },
      { code: "1300", name: "Inventory", account_type: "ASSET", is_posting: false, parent: null, currency: "UGX" },
      { code: "1310", name: "Raw Materials Inventory", account_type: "ASSET", is_posting: true, parent: "1300", currency: "UGX" },
      { code: "1320", name: "Finished Goods Inventory", account_type: "ASSET", is_posting: true, parent: "1300", currency: "UGX" },
      { code: "1330", name: "Work In Progress", account_type: "ASSET", is_posting: true, parent: "1300", currency: "UGX" },
      { code: "1400", name: "Accounts Receivable", account_type: "ASSET", is_posting: true, parent: null, currency: "UGX" },
      { code: "1500", name: "Prepayments", account_type: "ASSET", is_posting: true, parent: null, currency: "UGX" },
      { code: "1510", name: "Other Receivables", account_type: "ASSET", is_posting: true, parent: null, currency: "UGX" },
      { code: "2000", name: "Liabilities", account_type: "LIABILITY", is_posting: true, parent: null, currency: "UGX" },
      { code: "2100", name: "Accounts Payable", account_type: "LIABILITY", is_posting: true, parent: "2000", currency: "UGX" },
      { code: "2110", name: "VAT Payable", account_type: "LIABILITY", is_posting: true, parent: "2000", currency: "UGX" },
      { code: "2120", name: "PAYE Payable", account_type: "LIABILITY", is_posting: true, parent: "2000", currency: "UGX" },
      { code: "2200", name: "Loans & Borrowings", account_type: "LIABILITY", is_posting: true, parent: "2000", currency: "UGX" },
      { code: "2210", name: "Accruals", account_type: "LIABILITY", is_posting: true, parent: "2000", currency: "UGX" },
      { code: "3000", name: "Equity", account_type: "EQUITY", is_posting: true, parent: null, currency: "UGX" },
      { code: "3100", name: "Retained Earnings", account_type: "EQUITY", is_posting: true, parent: "3000", currency: "UGX" },
      { code: "4000", name: "Revenue", account_type: "REVENUE", is_posting: true, parent: null, currency: "UGX" },
      { code: "4100", name: "Other Income", account_type: "REVENUE", is_posting: true, parent: "4000", currency: "UGX" },
      { code: "5000", name: "Cost of Goods Sold", account_type: "EXPENSE", is_posting: true, parent: null, currency: "UGX" },
      { code: "5100", name: "Direct Production Costs", account_type: "EXPENSE", is_posting: true, parent: "5000", currency: "UGX" },
      { code: "6000", name: "Expenses", account_type: "EXPENSE", is_posting: false, parent: null, currency: "UGX" },
      { code: "6100", name: "Administration Expenses", account_type: "EXPENSE", is_posting: true, parent: "6000", currency: "UGX" },
      { code: "6200", name: "Sales & Marketing Expenses", account_type: "EXPENSE", is_posting: true, parent: "6000", currency: "UGX" },
      { code: "6300", name: "Production Overheads", account_type: "EXPENSE", is_posting: true, parent: "6000", currency: "UGX" },
      { code: "6400", name: "Maintenance Expenses", account_type: "EXPENSE", is_posting: true, parent: "6000", currency: "UGX" },
      { code: "6500", name: "Depreciation", account_type: "EXPENSE", is_posting: true, parent: "6000", currency: "UGX" },
    ];
    const coaId = {};
    for (const row of coaRows) {
      const { parent, ...rest } = row;
      coaId[row.code] = await insertOne(client, "chart_of_accounts", {
        company_id: companyId,
        tenant_id: tenantId,
        code: rest.code,
        name: rest.name,
        account_type: rest.account_type,
        subtype: rest.account_type,
        parent_id: parent ? coaId[parent] : null,
        is_posting: rest.is_posting,
        is_active: true,
        currency: rest.currency,
        opening_balance: 0,
        attributes: {},
      });
      bump("chart_of_accounts");
    }

    const bankAccounts = [
      ["STANBIC-UGX", "Stanbic Bank UGX", "Stanbic Bank", "9030012345678", "CURRENT", "UGX", "1100"],
      ["STANBIC-USD", "Stanbic Bank USD", "Stanbic Bank", "9030012345685", "CURRENT", "USD", "1110"],
      ["BOB-UGX", "Bank of Baroda UGX", "Bank of Baroda", "902011234567", "CURRENT", "UGX", "1120"],
      ["CASH-01", "Main Cashier", "Petty Cash", "CASH-01", "CASH", "UGX", "1200"],
    ];
    for (const [code, name, bank, accNo, type, currency, gl] of bankAccounts) {
      await insertOne(client, "bank_accounts", {
        company_id: companyId,
        tenant_id: tenantId,
        code,
        name,
        bank_name: bank,
        account_no: accNo,
        account_type: type,
        currency,
        opening_balance: 0,
        gl_account_id: coaId[gl],
        is_active: true,
      });
      bump("bank_accounts");
    }

    // ============================================================
    // 4. RBAC: permissions, roles, role_permissions
    // ============================================================
    const perms = buildPermissions();
    const permRows = perms.map((p) => ({
      code: p.code,
      module: p.module,
      resource: p.resource,
      action: p.action,
      description: p.description,
      is_system: false,
    }));
    // Migrations also seed catalogue permissions (0072+, 0115+, ...), so only
    // insert codes that are not present yet. Idempotent against a partially
    // bootstrapped schema; safe on a fully fresh seed too.
    const { rows: existingPermRows } = await client.query(
      "SELECT code FROM permissions"
    );
    const existingPermCodes = new Set(existingPermRows.map((r) => r.code));
    const freshPermRows = permRows.filter((p) => !existingPermCodes.has(p.code));
    // insert in batches of 200 to stay well under statement size limits
    for (let i = 0; i < freshPermRows.length; i += 200) {
      await bulkInsert(client, "permissions", freshPermRows.slice(i, i + 200));
    }
    bump("permissions", freshPermRows.length);

    const { rows: permLookupRows } = await client.query(
      "SELECT id, code FROM permissions"
    );
    const permIdByCode = {};
    for (const r of permLookupRows) permIdByCode[r.code] = r.id;

    const roleIdByCode = {};
    for (const role of ROLES) {
      const codes = expandGrants(role.grants);
      const roleId = await insertOne(client, "roles", {
        tenant_id: tenantId,
        company_id: companyId,
        code: role.code,
        name: role.name,
        description: role.description,
        is_system: true,
        is_customizable: role.code !== "super_administrator",
        permissions: codes,
      });
      roleIdByCode[role.code] = roleId;
      bump("roles");

      const rolePermRows = [];
      for (const code of codes) {
        const pid = permIdByCode[code];
        if (pid) rolePermRows.push({ role_id: roleId, permission_id: pid });
      }
      if (rolePermRows.length) {
        await bulkInsert(client, "role_permissions", rolePermRows, false);
        bump("role_permissions", rolePermRows.length);
      }
    }

    // ============================================================
    // 5. Users + role assignments + org heads
    // ============================================================
    const userDefs = [
      { key: "admin", username: "admin", first: "System", last: "Administrator", email: "admin@hopedesign.co.ug", job: "System Administrator", dept: "IT", roles: ["super_administrator", "system_administrator"], attrs: { policy_exempt_finance_hours: true } },
      { key: "sarah.sales", username: "sarah.sales", first: "Sarah", last: "Nabirye", email: "sarah.sales@hopedesign.co.ug", job: "Sales Manager", dept: "SAL", roles: ["sales_manager"] },
      { key: "willy.wh", username: "willy.wh", first: "William", last: "Okello", email: "willy.wh@hopedesign.co.ug", job: "Warehouse Manager", dept: "WH", roles: ["warehouse_manager"] },
      { key: "peter.prod", username: "peter.prod", first: "Peter", last: "Mugisha", email: "peter.prod@hopedesign.co.ug", job: "Production Manager", dept: "PROD", roles: ["production_manager"] },
      { key: "qiana.qc", username: "qiana.qc", first: "Qiana", last: "Achieng", email: "qiana.qc@hopedesign.co.ug", job: "Quality Manager", dept: "QC", roles: ["quality_manager"] },
      { key: "sam.secure", username: "sam.secure", first: "Samuel", last: "Kizza", email: "sam.secure@hopedesign.co.ug", job: "Security Printing Manager", dept: "SEC", roles: ["security_printing_manager"], attrs: { security_clearance: "CONFIDENTIAL" } },
      { key: "cindy.cfo", username: "cindy.cfo", first: "Cynthia", last: "Nakato", email: "cindy.cfo@hopedesign.co.ug", job: "Chief Financial Officer", dept: "FIN", roles: ["cfo", "finance_manager"] },
      { key: "gina.fin", username: "gina.fin", first: "Gina", last: "Atuhaire", email: "gina.fin@hopedesign.co.ug", job: "Accountant", dept: "FIN", roles: ["accountant"] },
      { key: "secure.approver", username: "secure.approver", first: "Asha", last: "Mukasa", email: "secure.approver@hopedesign.co.ug", job: "Secure Job Approver", dept: "SEC", roles: ["secure_job_approver", "security_administrator"], attrs: { security_clearance: "CONFIDENTIAL" } },
      { key: "qa.auditor", username: "qa.auditor", first: "Quinn", last: "Namaganda", email: "qa.auditor@hopedesign.co.ug", job: "Internal Auditor", dept: "FIN", roles: ["internal_auditor", "quality_inspector"] },
      { key: "re.becka", username: "re.becka", first: "Rebecca", last: "Namutebi", email: "re.becka@hopedesign.co.ug", job: "Sales Executive", dept: "SAL", roles: ["sales_executive"] },
      { key: "opus.ops", username: "opus.ops", first: "Opus", last: "Byaruhanga", email: "opus.ops@hopedesign.co.ug", job: "Operations Director", dept: "PROD", roles: ["operations_director"] },
      { key: "mia.main", username: "mia.main", first: "Mia", last: "Nansubuga", email: "mia.main@hopedesign.co.ug", job: "Maintenance Manager", dept: "MAINT", roles: ["maintenance_manager"] },
      { key: "roy.logi", username: "roy.logi", first: "Roy", last: "Ssemakula", email: "roy.logi@hopedesign.co.ug", job: "Logistics Manager", dept: "LOG", roles: ["logistics_manager"] },
      { key: "hr.hannah", username: "hr.hannah", first: "Hannah", last: "Atim", email: "hr.hannah@hopedesign.co.ug", job: "HR Manager", dept: "HR", roles: ["hr_manager"] },
      { key: "pay.manager", username: "pay.manager", first: "Patrick", last: "Mukasa", email: "pay.manager@hopedesign.co.ug", job: "Payroll Manager", dept: "FIN", roles: ["payroll_manager"] },
      { key: "bi.brian", username: "bi.brian", first: "Brian", last: "Okot", email: "bi.brian@hopedesign.co.ug", job: "BI Manager", dept: "IT", roles: ["bi_manager"] },
      { key: "sso.demo", username: "sso.demo", first: "Demo", last: "Employee", email: "sso.demo@hopedesign.co.ug", job: "Employee", dept: "HR", roles: ["employee_self_service"] },
      { key: "percy.proc", username: "percy.proc", first: "Percy", last: "Kato", email: "percy.proc@hopedesign.co.ug", job: "Procurement Manager", dept: "PROC", roles: ["procurement_manager"] },
      { key: "anna.pur", username: "anna.pur", first: "Anna", last: "Nakimera", email: "anna.pur@hopedesign.co.ug", job: "Procurement Officer", dept: "PROC", roles: ["procurement_officer"] },
    ];
    const passwordHash = bcrypt.hashSync("ChangeMe!2026", 10);
    const userIdByKey = {};
    const userRoleRows = [];
    let phoneSeq = 700000000;
    for (const u of userDefs) {
      phoneSeq += 1;
      const userId = await insertOne(client, "users", {
        tenant_id: tenantId,
        company_id: companyId,
        branch_id: branchId,
        department_id: deptId[u.dept],
        email: u.email,
        username: u.username,
        password_hash: passwordHash,
        first_name: u.first,
        last_name: u.last,
        job_title: u.job,
        phone: `+256${phoneSeq}`,
        status: "ACTIVE",
        must_change_password: true,
        mfa_enabled: false,
        attributes: u.attrs || {},
        settings: { theme: "light", locale: "en-UG" },
      });
      userIdByKey[u.key] = userId;
      bump("users");
      for (const roleCode of u.roles) {
        userRoleRows.push({
          user_id: userId,
          role_id: roleIdByCode[roleCode],
          company_id: companyId,
          branch_id: branchId,
        });
      }
    }
    await bulkInsert(client, "user_roles", userRoleRows, false);
    bump("user_roles", userRoleRows.length);

    // Org heads
    await client.query(
      "UPDATE branches SET manager_user_id = $1 WHERE id = $2",
      [userIdByKey["opus.ops"], branchId]
    );
    const deptHeads = {
      FIN: "cindy.cfo",
      SAL: "sarah.sales",
      PROD: "peter.prod",
      WH: "willy.wh",
      QC: "qiana.qc",
      SEC: "sam.secure",
      MAINT: "mia.main",
      HR: "hr.hannah",
      LOG: "roy.logi",
      IT: "bi.brian",
      PROC: "opus.ops",
    };
    for (const [code, userKey] of Object.entries(deptHeads)) {
      await client.query(
        "UPDATE departments SET head_user_id = $1 WHERE id = $2",
        [userIdByKey[userKey], deptId[code]]
      );
    }

    // ============================================================
    // 6. Segregation of duties
    // ============================================================
    const sodRules = [
      { code: "SOD-PO", name: "Create/Approve Purchase Order", primary: "procurement.orders.create", conflicting: "procurement.orders.approve" },
      { code: "SOD-SUPPLIER", name: "Create/Approve Supplier", primary: "procurement.suppliers.create", conflicting: "procurement.suppliers.approve" },
      { code: "SOD-SUPPLIER-PAY", name: "Approve Supplier/Pay Supplier", primary: "procurement.suppliers.approve", conflicting: "procurement.payments.release" },
      { code: "SOD-INVOICE", name: "Create/Approve Customer Invoice", primary: "sales.invoices.create", conflicting: "sales.invoices.approve" },
      { code: "SOD-RECEIPT", name: "Create/Post Customer Receipt", primary: "sales.receipts.create", conflicting: "sales.receipts.post" },
      { code: "SOD-PAYROLL-CREATE", name: "Create/Approve Payroll", primary: "hr.payrolls.create", conflicting: "hr.payrolls.approve" },
      { code: "SOD-PAYROLL-APPROVE", name: "Approve/Release Payroll", primary: "hr.payrolls.approve", conflicting: "hr.payrolls.release" },
      { code: "SOD-ADJUSTMENT", name: "Create/Approve Stock Adjustment", primary: "inventory.adjustments.create", conflicting: "inventory.adjustments.approve" },
      { code: "SOD-SEC-CREATE-APPROVE", name: "Create/Approve Security Job", primary: "security_printing.jobs.create", conflicting: "security_printing.jobs.approve" },
      { code: "SOD-SEC-APPROVE-AUTHORIZE", name: "Approve/Authorize Materials (Security)", primary: "security_printing.jobs.approve", conflicting: "security_printing.jobs.authorize_materials" },
    ];
    for (const s of sodRules) {
      await insertOne(client, "sod_rules", {
        tenant_id: tenantId,
        code: s.code,
        name: s.name,
        description: `Prevents a single user holding both ${s.primary} and ${s.conflicting}.`,
        primary_permission: s.primary,
        conflicting_permission: s.conflicting,
        enforcement: "hard",
        is_active: true,
      });
      bump("sod_rules");
    }

    // ============================================================
    // 7. ABAC policies (deny by default; high priority denies win)
    // ============================================================
    const policies = [
      {
        code: "ABAC-SEC-CLEARANCE",
        name: "Security Clearance Required",
        description: "Users without a security clearance attribute cannot touch security printing resources.",
        effect: "deny",
        priority: 200,
        subject_attributes: { security_clearance: { $missing: true } },
        resource_attributes: { module: "security_printing" },
        environment_attributes: {},
      },
      {
        code: "ABAC-NO-SELF-APPROVE",
        name: "No Self Approval",
        description: "A user cannot approve, authorize, release or post their own resource (subject id == resource owner).",
        effect: "deny",
        priority: 150,
        subject_attributes: { id: { $ref: "resource.owner_user_id" } },
        resource_attributes: { action: { $in: ["approve", "authorize_materials", "release", "post"] } },
        environment_attributes: {},
      },
      {
        code: "ABAC-FIN-HOURS",
        name: "Finance Posting Hours",
        description: "Finance post/release actions are denied outside 08:00-18:00.",
        effect: "deny",
        priority: 120,
        subject_attributes: { policy_exempt_finance_hours: { $missing: true } },
        resource_attributes: { module: "finance", action: { $in: ["post", "release"] } },
        environment_attributes: { time_of_day: { $outside: ["08:00", "18:00"] } },
      },
      {
        code: "ABAC-DEFAULT-ALLOW",
        name: "Default Allow",
        description: "Fallback allow for requests not matched by a deny policy.",
        effect: "allow",
        priority: 999,
        subject_attributes: {},
        resource_attributes: {},
        environment_attributes: {},
      },
    ];
    for (const p of policies) {
      await insertOne(client, "policies", {
        tenant_id: tenantId,
        code: p.code,
        name: p.name,
        description: p.description,
        effect: p.effect,
        priority: p.priority,
        subject_attributes: p.subject_attributes,
        resource_attributes: p.resource_attributes,
        environment_attributes: p.environment_attributes,
        is_active: true,
      });
      bump("policies");
    }

    // ============================================================
    // 8. Approval limits (0 = unlimited)
    // ============================================================
    const approvalLimits = [
      ["cfo", "sales.orders", "UGX", 0],
      ["cfo", "procurement.orders", "UGX", 0],
      ["cfo", "procurement.payments", "UGX", 0],
      ["cfo", "sales.invoices", "UGX", 0],
      ["cfo", "hr.payrolls", "UGX", 0],
      ["cfo", "expenses", "UGX", 0],
      ["finance_manager", "expenses", "UGX", 50000000],
      ["finance_manager", "procurement.payments", "UGX", 80000000],
      ["finance_manager", "hr.payrolls", "UGX", 100000000],
      ["sales_manager", "sales.orders", "UGX", 100000000],
      ["sales_manager", "sales.invoices", "UGX", 100000000],
      ["procurement_manager", "procurement.orders", "UGX", 200000000],
      ["warehouse_manager", "inventory.adjustments", "UGX", 10000000],
      ["operations_director", "procurement.orders", "UGX", 0],
      ["operations_director", "production.work_orders", "UGX", 0],
      ["secure_job_approver", "security_printing.jobs", "UGX", 0],
      ["quality_manager", "inventory.adjustments", "UGX", 5000000],
      ["hr_manager", "hr.payrolls", "UGX", 20000000],
    ];
    for (const [roleCode, module, currency, maxAmount] of approvalLimits) {
      await insertOne(client, "approval_limits", {
        tenant_id: tenantId,
        role_id: roleIdByCode[roleCode],
        module,
        currency,
        min_amount: 0,
        max_amount: maxAmount,
      });
      bump("approval_limits");
    }

    // ============================================================
    // 9. Master data: units, categories, products
    // ============================================================
    const unitRows = [
      { code: "PCS", name: "Piece", kind: "COUNT" },
      { code: "REAM", name: "Ream", kind: "COUNT" },
      { code: "ROLL", name: "Roll", kind: "COUNT" },
      { code: "KG", name: "Kilogram", kind: "WEIGHT" },
      { code: "BOX", name: "Box", kind: "COUNT" },
      { code: "CARTON", name: "Carton", kind: "COUNT" },
      { code: "SHEET", name: "Sheet", kind: "COUNT" },
      { code: "SET", name: "Set", kind: "COUNT" },
      { code: "L", name: "Litre", kind: "VOLUME" },
      { code: "M", name: "Metre", kind: "LENGTH" },
    ];
    const unitRowsFull = unitRows.map((u) => ({
      company_id: companyId,
      tenant_id: tenantId,
      code: u.code,
      name: u.name,
      kind: u.kind,
    }));
    await bulkInsert(client, "units", unitRowsFull);
    bump("units", unitRowsFull.length);

    const categoryRows = [
      ["RAW-MAT", "Raw Materials", "RAW_MATERIAL"],
      ["PAPER-PROD", "Paper Products", "FINISHED_GOODS"],
      ["SEC-PROD", "Security Products", "SECURITY_ITEM"],
      ["PACKAGING", "Packaging Materials", "PACKAGING"],
      ["CONSUMABLES", "Consumables", "CONSUMABLE"],
    ];
    const categoryId = {};
    for (const [code, name, kind] of categoryRows) {
      categoryId[code] = await insertOne(client, "product_categories", {
        company_id: companyId,
        tenant_id: tenantId,
        code,
        name,
        kind,
        status: "ACTIVE",
      });
      bump("product_categories");
    }

    const productDefs = [
      {
        code: "JUMBO-105",
        name: "Jumbo Roll 105gsm",
        sku: "RM-JUMBO-105",
        type: "JUMBO_ROLL",
        category: "RAW-MAT",
        unit: "ROLL",
        gsm: 105,
        width_mm: 2100,
        roll_length_m: 5000,
        valuation: "WEIGHTED_AVERAGE",
        stdCost: 850000,
        stdPrice: 1050000,
        reorder: 8,
        safety: 4,
        leadTime: 30,
        lotSize: 5,
        desc: "Jumbo paper roll 105gsm, 2100mm wide, 5000m long.",
      },
      {
        code: "BOB-80",
        name: "Paper Bobbin 80gsm",
        sku: "RM-BOB-80",
        type: "PAPER_BOBBIN",
        category: "RAW-MAT",
        unit: "ROLL",
        gsm: 80,
        width_mm: 1050,
        roll_length_m: 3000,
        valuation: "WEIGHTED_AVERAGE",
        stdCost: 320000,
        stdPrice: 420000,
        reorder: 20,
        safety: 10,
        leadTime: 21,
        lotSize: 10,
        desc: "Paper bobbin 80gsm for security printing reels.",
      },
      {
        code: "NATEX-A4",
        name: "NATEX A4 Premium Superior White",
        sku: "FG-NATEX-A4",
        type: "REAM",
        category: "PAPER-PROD",
        unit: "REAM",
        gsm: 80,
        width_mm: 210,
        sheets_per_ream: 500,
        ream_weight_kg: 2.5,
        valuation: "FIFO",
        stdCost: 12000,
        stdPrice: 18000,
        reorder: 2000,
        safety: 500,
        leadTime: 7,
        lotSize: 1000,
        desc: "NATEX A4 80gsm premium superior white, 500 sheets per ream - sole manufactured finished good.",
      },
      {
        code: "A3-80",
        name: "A3 Copy Paper 80gsm (Ream)",
        sku: "FG-A3-80",
        type: "REAM",
        status: "DISCONTINUED",
        category: "PAPER-PROD",
        unit: "REAM",
        gsm: 80,
        width_mm: 297,
        sheets_per_ream: 500,
        ream_weight_kg: 5.0,
        valuation: "FIFO",
        stdCost: 24000,
        stdPrice: 36000,
        reorder: 1000,
        safety: 300,
        leadTime: 7,
        lotSize: 500,
        desc: "A3 80gsm copy paper, 500 sheets per ream.",
      },
      {
        code: "SEC-WM",
        name: "Security Watermarked Paper",
        sku: "SEC-WM-80",
        type: "SECURITY_ITEM",
        status: "DISCONTINUED",
        category: "SEC-PROD",
        unit: "REAM",
        gsm: 80,
        width_mm: 210,
        sheets_per_ream: 500,
        ream_weight_kg: 2.5,
        valuation: "FIFO",
        stdCost: 45000,
        stdPrice: 75000,
        reorder: 500,
        safety: 150,
        leadTime: 14,
        lotSize: 500,
        security: "CONFIDENTIAL",
        desc: "Security paper with embedded watermark for certificates and negotiable documents.",
      },
      {
        code: "CARTON-A4",
        name: "A4 Ream Carton",
        sku: "PK-CARTON-A4",
        type: "PACKAGING",
        category: "PACKAGING",
        unit: "CARTON",
        valuation: "WEIGHTED_AVERAGE",
        stdCost: 2500,
        stdPrice: 4000,
        reorder: 500,
        safety: 100,
        leadTime: 14,
        lotSize: 200,
        desc: "Corrugated carton holding 5 reams of A4 paper.",
      },
      {
        code: "LBL-REAM",
        name: "Ream Label",
        sku: "CN-LBL-REAM",
        type: "CONSUMABLE",
        category: "CONSUMABLES",
        unit: "PCS",
        valuation: "WEIGHTED_AVERAGE",
        stdCost: 100,
        stdPrice: 200,
        reorder: 5000,
        safety: 1000,
        leadTime: 10,
        lotSize: 2000,
        desc: "Self-adhesive ream label printed with product and QR information.",
      },
    ];
    const productIdByCode = {};
    for (const p of productDefs) {
      const row = {
        company_id: companyId,
        tenant_id: tenantId,
        category_id: categoryId[p.category],
        code: p.code,
        name: p.name,
        sku: p.sku,
        type: p.type,
        unit_id: null,
        gsm: p.gsm,
        width_mm: p.width_mm,
        roll_length_m: p.roll_length_m,
        sheets_per_ream: p.sheets_per_ream,
        ream_weight_kg: p.ream_weight_kg,
        valuation_method: p.valuation,
        standard_cost: p.stdCost,
        standard_price: p.stdPrice,
        reorder_point: p.reorder,
        safety_stock: p.safety,
        lead_time_days: p.leadTime,
        lot_size: p.lotSize,
        is_tracked: true,
        is_serialized: false,
        security_classification: p.security || "NONE",
        status: p.status || "ACTIVE",
        attributes: { manufacturing: p.type === "JUMBO_ROLL" || p.type === "PAPER_BOBBIN" || p.type === "REAM" || p.type === "SECURITY_ITEM" },
        description: p.desc,
      };
      if (p.unit === "ROLL") row.unit_id = null; // set below
      productIdByCode[p.code] = await insertOne(client, "products", row);
      bump("products");
    }
    // Link unit_id after units are resolved (unit codes -> ids)
    const { rows: unitRows2 } = await client.query(
      "SELECT id, code FROM units WHERE company_id = $1",
      [companyId]
    );
    const unitIdByCode = {};
    for (const u of unitRows2) unitIdByCode[u.code] = u.id;
    for (const p of productDefs) {
      await client.query("UPDATE products SET unit_id = $1 WHERE id = $2", [
        unitIdByCode[p.unit],
        productIdByCode[p.code],
      ]);
    }

    // ============================================================
    // 10. Manufacturing: work centres, machine QR, machines, BOMs, routings
    // ============================================================
    const workCentreDefs = [
      ["MC-CUT", "Cutting & Slitting", "MACHINE", 25000, 0.15],
      ["MC-LABOUR", "Direct Labour", "LABOUR", 8000, 0.1],
      ["MC-ASSY", "Assembly & Finishing", "ASSEMBLY", 15000, 0.12],
      ["MC-QC", "Quality Control Bench", "QC", 12000, 0.1],
      ["MC-PACK", "Packaging Line", "PACKAGING", 10000, 0.08],
    ];
    const workCentreId = {};
    for (const [code, name, type, hourlyCost, overheadRate] of workCentreDefs) {
      workCentreId[code] = await insertOne(client, "work_centres", {
        company_id: companyId,
        tenant_id: tenantId,
        facility_id: facilityId,
        code,
        name,
        type,
        hourly_cost: hourlyCost,
        overhead_rate: overheadRate,
        status: "ACTIVE",
      });
      bump("work_centres");
    }

    // Machine QR identities (opaque secrets; only the hash is stored)
    const machineQrDefs = [
      ["FSS104", "HDG-MC-FSS104"],
      ["FSS300", "HDG-MC-FSS300"],
      ["SEC-PRINT-01", "HDG-MC-SEC-PRINT-01"],
      ["QC-BENCH-01", "HDG-MC-QC-BENCH-01"],
      ["PACK-01", "HDG-MC-PACK-01"],
      ["FSS104-B", "HDG-MC-FSS104-B"],
    ];
    const machineQrId = {};
    for (const [key, code] of machineQrDefs) {
      const secret = qrSecret();
      machineQrId[key] = await insertOne(client, "qr_codes", {
        company_id: companyId,
        tenant_id: tenantId,
        code,
        secret_hash: qrSecretHash(secret),
        entity_type: "MACHINE",
        entity_id: null,
        status: "ACTIVE",
        generated_by: userIdByKey["admin"],
      });
      bump("qr_codes");
    }

    const machineDefs = [
      ["FSS104", "FSS104 Guillotine Cutter", "Fellowes", "FSS104", "FSS104-0001", "CUTTING", "MC-CUT", 120, "ROLL/hr", 30000, "OPERATIONAL", false],
      ["FSS300", "FSS300 Sheet Cutter", "Fellowes", "FSS300", "FSS300-0001", "SHEET_CUTTER", "MC-CUT", 240, "SHEET/hr", 25000, "OPERATIONAL", false],
      ["SEC-PRINT-01", "Security Printing Press", "HDG Custom", "SEC-1000", "SECP-0001", "SECURITY_PRINTING", "MC-CUT", 60, "REAM/hr", 60000, "OPERATIONAL", true],
      ["QC-BENCH-01", "QC Inspection Bench", "HDG", "QC-B1", "QCB-0001", "GENERAL", "MC-QC", 100, "INSP/hr", 12000, "OPERATIONAL", false],
      ["PACK-01", "Ream Packaging Line", "HDG", "PK-01", "PKG-0001", "PACKING", "MC-PACK", 200, "REAM/hr", 15000, "OPERATIONAL", false],
      ["FSS104-B", "FSS104 Backup Cutter", "Fellowes", "FSS104", "FSS104-0002", "CUTTING", "MC-CUT", 120, "ROLL/hr", 30000, "MAINTENANCE", false],
    ];
    const machineIdByCode = {};
    for (const [code, name, make, model, serial, type, wc, cap, capUnit, rate, status, isSecure] of machineDefs) {
      machineIdByCode[code] = await insertOne(client, "machines", {
        company_id: companyId,
        tenant_id: tenantId,
        facility_id: facilityId,
        work_centre_id: workCentreId[wc],
        code,
        name,
        make,
        model,
        serial_no: serial,
        type,
        capacity: cap,
        capacity_unit: capUnit,
        hourly_rate: rate,
        status,
        is_secure: isSecure,
        qr_id: machineQrId[code],
        attributes: { secure: isSecure },
      });
      bump("machines");
    }

    // Link each machine QR to its entity id
    for (const [key] of machineQrDefs) {
      await client.query("UPDATE qr_codes SET entity_id = $1 WHERE id = $2", [
        machineIdByCode[key],
        machineQrId[key],
      ]);
    }

    // BOMs (approved, multi-level style components)
    const bomDefs = [
      {
        code: "BOM-A4-80",
        name: "NATEX A4 Ream BOM",
        product: "NATEX-A4",
        qty: 1000,
        unit: "REAM",
        items: [
          { product: "JUMBO-105", qty: 4, unit: "ROLL", scrap: 5, consumable: false },
          { product: "CARTON-A4", qty: 40, unit: "CARTON", scrap: 0, consumable: false },
          { product: "LBL-REAM", qty: 1000, unit: "PCS", scrap: 0, consumable: true },
        ],
      },
      {
        code: "BOM-SEC-WM",
        name: "Security Watermarked Paper BOM",
        product: "SEC-WM",
        qty: 500,
        unit: "REAM",
        items: [
          { product: "BOB-80", qty: 2, unit: "ROLL", scrap: 3, consumable: false },
          { product: "CARTON-A4", qty: 20, unit: "CARTON", scrap: 0, consumable: false },
          { product: "LBL-REAM", qty: 500, unit: "PCS", scrap: 0, consumable: true },
        ],
      },
    ];
    const bomIdByCode = {};
    for (const b of bomDefs) {
      bomIdByCode[b.code] = await insertOne(client, "boms", {
        company_id: companyId,
        tenant_id: tenantId,
        product_id: productIdByCode[b.product],
        code: b.code,
        name: b.name,
        version: 1,
        quantity: b.qty,
        unit_id: unitIdByCode[b.unit],
        is_active: true,
        effective_from: "2026-07-01",
        status: b.status || "APPROVED",
      });
      bump("boms");
      for (const it of b.items) {
        await insertOne(client, "bom_items", {
          bom_id: bomIdByCode[b.code],
          product_id: productIdByCode[it.product],
          quantity: it.qty,
          unit_id: unitIdByCode[it.unit],
          scrap_percent: it.scrap,
          is_consumable: it.consumable,
        });
        bump("bom_items");
      }
    }

    // Routings + operations
    const routingDefs = [
      {
        code: "ROUT-A4-80",
        name: "NATEX A4 Production Routing",
        product: "NATEX-A4",
        ops: [
          { seq: 10, name: "Cutting / Slitting", wc: "MC-CUT", machine: "FSS104", setup: 30, run: 0.05, teardown: 10 },
          { seq: 20, name: "Sheet Cutting", wc: "MC-CUT", machine: "FSS300", setup: 20, run: 0.08, teardown: 10 },
          { seq: 30, name: "Quality Control", wc: "MC-QC", machine: "QC-BENCH-01", setup: 5, run: 0.02, teardown: 5 },
          { seq: 40, name: "Packaging", wc: "MC-PACK", machine: "PACK-01", setup: 10, run: 0.04, teardown: 5 },
        ],
      },
      {
        code: "ROUT-SEC-WM",
        name: "Security Paper Production Routing",
        product: "SEC-WM",
        ops: [
          { seq: 10, name: "Security Printing", wc: "MC-CUT", machine: "SEC-PRINT-01", setup: 45, run: 0.1, teardown: 15 },
          { seq: 20, name: "Quality Control", wc: "MC-QC", machine: "QC-BENCH-01", setup: 5, run: 0.02, teardown: 5 },
          { seq: 30, name: "Packaging", wc: "MC-PACK", machine: "PACK-01", setup: 10, run: 0.04, teardown: 5 },
        ],
      },
    ];
    const routingIdByCode = {};
    for (const r of routingDefs) {
      routingIdByCode[r.code] = await insertOne(client, "routings", {
        company_id: companyId,
        tenant_id: tenantId,
        product_id: productIdByCode[r.product],
        code: r.code,
        name: r.name,
        version: 1,
        is_active: true,
      });
      bump("routings");
      for (const op of r.ops) {
        await insertOne(client, "routing_operations", {
          routing_id: routingIdByCode[r.code],
          work_centre_id: workCentreId[op.wc],
          seq: op.seq,
          name: op.name,
          setup_time_min: op.setup,
          run_time_per_unit_min: op.run,
          teardown_time_min: op.teardown,
          machine_id: machineIdByCode[op.machine],
        });
        bump("routing_operations");
      }
    }

    // ============================================================
    // 11. Quality inspection plans
    // ============================================================
    const inspectionPlanDefs = [
      {
        code: "INSP-IN-JUMBO",
        name: "Incoming Jumbo Roll Inspection",
        product: "JUMBO-105",
        kind: "INCOMING",
        params: [
          { name: "gsm", label: "Grammage", unit: "g/m2", method: "Grammage test (ISO 536)", target: 105, min: 100, max: 110 },
          { name: "moisture", label: "Moisture", unit: "%", method: "Moisture meter", target: 5, min: 3, max: 7 },
          { name: "width", label: "Roll Width", unit: "mm", method: "Tape measure", target: 2100, min: 2090, max: 2110 },
          { name: "brightness", label: "Brightness", unit: "%", method: "Brightness meter (ISO 2470)", target: 95, min: 90, max: 100 },
        ],
      },
      {
        code: "INSP-IN-BOB",
        name: "Incoming Paper Bobbin Inspection",
        product: "BOB-80",
        kind: "INCOMING",
        params: [
          { name: "gsm", label: "Grammage", unit: "g/m2", method: "Grammage test (ISO 536)", target: 80, min: 76, max: 84 },
          { name: "moisture", label: "Moisture", unit: "%", method: "Moisture meter", target: 5, min: 3, max: 7 },
          { name: "width", label: "Roll Width", unit: "mm", method: "Tape measure", target: 1050, min: 1042, max: 1058 },
          { name: "brightness", label: "Brightness", unit: "%", method: "Brightness meter (ISO 2470)", target: 94, min: 88, max: 100 },
        ],
      },
      {
        code: "INSP-FIN-A4",
        name: "Final NATEX A4 Inspection",
        product: "NATEX-A4",
        kind: "FINAL",
        params: [
          { name: "gsm", label: "Grammage", unit: "g/m2", method: "Grammage test", target: 80, min: 76, max: 84 },
          { name: "smoothness", label: "Smoothness", unit: "s", method: "Bekk smoothness", target: 120, min: 80, max: 200 },
          { name: "tear_strength", label: "Tear Strength", unit: "mN", method: "Elmendorf tear", target: 350, min: 300, max: 450 },
          { name: "ream_weight", label: "Ream Weight", unit: "kg", method: "Weighing scale", target: 2.5, min: 2.35, max: 2.65 },
          { name: "sheet_count", label: "Sheet Count", unit: "sheets", method: "Count check", target: 500, min: 500, max: 500 },
        ],
      },
      {
        code: "INSP-FIN-SEC",
        name: "Final Security Paper Inspection",
        product: "SEC-WM",
        kind: "FINAL",
        params: [
          { name: "watermark_integrity", label: "Watermark Integrity", unit: "PASS/FAIL", method: "Visual + light box", target: "PASS" },
          { name: "security_thread", label: "Security Thread", unit: "PASS/FAIL", method: "Visual + UV lamp", target: "PASS" },
          { name: "gsm", label: "Grammage", unit: "g/m2", method: "Grammage test", target: 80, min: 77, max: 83 },
          { name: "sheet_count", label: "Sheet Count", unit: "sheets", method: "Count check", target: 500, min: 500, max: 500 },
        ],
      },
    ];
    const inspectionPlanIdByCode = {};
    for (const p of inspectionPlanDefs) {
      inspectionPlanIdByCode[p.code] = await insertOne(client, "inspection_plans", {
        company_id: companyId,
        tenant_id: tenantId,
        product_id: productIdByCode[p.product],
        code: p.code,
        name: p.name,
        kind: p.kind,
        parameters: p.params,
        is_active: true,
      });
      bump("inspection_plans");
    }

    // ============================================================
    // 12. Workflow engine definitions
    // ============================================================
    const workflowDefs = [
      {
        code: "WF-SO",
        name: "Sales Order Approval",
        entity_type: "sales.orders",
        desc: "Sales orders under UGX 50M approved by Sales Manager; above by General Manager.",
        steps: [
          { seq: 1, name: "Sales Manager Approval", approver_role: "sales_manager", amount_min: 0, amount_max: 50000000, sla_hours: 24 },
          { seq: 2, name: "General Manager Approval", approver_role: "general_manager", amount_min: 50000000, amount_max: 0, sla_hours: 48 },
        ],
      },
      {
        code: "WF-PO",
        name: "Purchase Order Approval",
        entity_type: "procurement.orders",
        desc: "POs under UGX 20M approved by Procurement Manager; above by Operations Director.",
        steps: [
          { seq: 1, name: "Procurement Manager Approval", approver_role: "procurement_manager", amount_min: 0, amount_max: 20000000, sla_hours: 24 },
          { seq: 2, name: "Operations Director Approval", approver_role: "operations_director", amount_min: 20000000, amount_max: 0, sla_hours: 48 },
        ],
      },
      {
        code: "WF-PR",
        name: "Purchase Requisition Approval",
        entity_type: "procurement.requisitions",
        desc: "PRs under UGX 20M approved by Procurement Manager; above by Operations Director.",
        steps: [
          { seq: 1, name: "Procurement Manager Approval", approver_role: "procurement_manager", amount_min: 0, amount_max: 20000000, sla_hours: 24 },
          { seq: 2, name: "Operations Director Approval", approver_role: "operations_director", amount_min: 20000000, amount_max: 0, sla_hours: 48 },
        ],
      },
      {
        code: "WF-SUP",
        name: "Supplier Registration Approval",
        entity_type: "procurement.suppliers",
        desc: "New suppliers require Procurement Manager then General Manager sign-off.",
        steps: [
          { seq: 1, name: "Procurement Manager Approval", approver_role: "procurement_manager", amount_min: 0, amount_max: 0, sla_hours: 24 },
          { seq: 2, name: "General Manager Approval", approver_role: "general_manager", amount_min: 0, amount_max: 0, sla_hours: 48 },
        ],
      },
      {
        code: "WF-INV",
        name: "Customer Invoice Approval",
        entity_type: "sales.invoices",
        desc: "Invoices under UGX 50M approved by Finance Manager; above by CFO.",
        steps: [
          { seq: 1, name: "Finance Manager Approval", approver_role: "finance_manager", amount_min: 0, amount_max: 50000000, sla_hours: 24 },
          { seq: 2, name: "CFO Approval", approver_role: "cfo", amount_min: 50000000, amount_max: 0, sla_hours: 48 },
        ],
      },
      {
        code: "WF-CN",
        name: "Credit Note Approval",
        entity_type: "sales.credit_notes",
        desc: "Credit notes require Finance Manager then CFO approval.",
        steps: [
          { seq: 1, name: "Finance Manager Approval", approver_role: "finance_manager", amount_min: 0, amount_max: 0, sla_hours: 24 },
          { seq: 2, name: "CFO Approval", approver_role: "cfo", amount_min: 0, amount_max: 0, sla_hours: 48 },
        ],
      },
      {
        code: "WF-DNM",
        name: "Debit Note Approval",
        entity_type: "sales.debit_notes",
        desc: "Debit notes require Finance Manager then CFO approval, matching credit notes.",
        steps: [
          { seq: 1, name: "Finance Manager Approval", approver_role: "finance_manager", amount_min: 0, amount_max: 0, sla_hours: 24 },
          { seq: 2, name: "CFO Approval", approver_role: "cfo", amount_min: 0, amount_max: 0, sla_hours: 48 },
        ],
      },
      {
        code: "WF-SUPPAY",
        name: "Supplier Payment Approval",
        entity_type: "procurement.payments",
        desc: "Supplier payments require Chief Accountant then CFO release.",
        steps: [
          { seq: 1, name: "Chief Accountant Approval", approver_role: "chief_accountant", amount_min: 0, amount_max: 0, sla_hours: 24 },
          { seq: 2, name: "CFO Release", approver_role: "cfo", amount_min: 0, amount_max: 0, sla_hours: 48 },
        ],
      },
      {
        code: "WF-ADJ",
        name: "Stock Adjustment Approval",
        entity_type: "inventory.adjustments",
        desc: "Adjustments under UGX 10M by Warehouse Manager; above by Operations Director.",
        steps: [
          { seq: 1, name: "Warehouse Manager Approval", approver_role: "warehouse_manager", amount_min: 0, amount_max: 10000000, sla_hours: 24 },
          { seq: 2, name: "Operations Director Approval", approver_role: "operations_director", amount_min: 10000000, amount_max: 0, sla_hours: 48 },
        ],
      },
      {
        code: "WF-XFER",
        name: "Stock Transfer Approval",
        entity_type: "inventory.transfers",
        desc: "Transfers require Warehouse Manager then Operations Director.",
        steps: [
          { seq: 1, name: "Warehouse Manager Approval", approver_role: "warehouse_manager", amount_min: 0, amount_max: 0, sla_hours: 24 },
          { seq: 2, name: "Operations Director Approval", approver_role: "operations_director", amount_min: 0, amount_max: 0, sla_hours: 48 },
        ],
      },
      {
        code: "WF-PAY",
        name: "Payroll Approval",
        entity_type: "hr.payrolls",
        desc: "Payroll prepared by Payroll Manager then released by CFO.",
        steps: [
          { seq: 1, name: "Payroll Manager Approval", approver_role: "payroll_manager", amount_min: 0, amount_max: 0, sla_hours: 24 },
          { seq: 2, name: "CFO Release", approver_role: "cfo", amount_min: 0, amount_max: 0, sla_hours: 48 },
        ],
      },
      {
        code: "WF-SEC",
        name: "Security Printing Job Approval",
        entity_type: "security_printing.jobs",
        desc: "Dual control: Secure Job Approver approves, then authorizes material issue.",
        steps: [
          { seq: 1, name: "Secure Job Approval", approver_role: "secure_job_approver", amount_min: 0, amount_max: 0, sla_hours: 24, condition: "job_approval" },
          { seq: 2, name: "Secure Materials Authorization", approver_role: "secure_job_approver", amount_min: 0, amount_max: 0, sla_hours: 24, condition: "authorize_materials" },
        ],
      },
      {
        code: "WF-REQ",
        name: "Job Requisition Approval",
        entity_type: "hr.requisitions",
        desc: "Single HR Manager approval for job requisitions.",
        steps: [
          { seq: 1, name: "HR Manager Approval", approver_role: "hr_manager", amount_min: 0, amount_max: 0, sla_hours: 24 },
        ],
      },
      {
        code: "WF-REQOPS",
        name: "Ops Requisition Approval",
        entity_type: "ops.requisitions",
        desc: "Tiered ops requisition approval by value: department manager up to 500k; department head plus finance 500k-5M; finance manager plus MD 5M-20M; CFO plus executive above 20M.",
        steps: [
          { seq: 1, name: "Department Manager Approval", approver_role: "finance_manager", amount_min: 0, amount_max: 500000, sla_hours: 24 },
          { seq: 1, name: "Department Head Approval", approver_role: "operations_director", amount_min: 500000, amount_max: 5000000, sla_hours: 24 },
          { seq: 2, name: "Finance Approval", approver_role: "finance_manager", amount_min: 500000, amount_max: 5000000, sla_hours: 24 },
          { seq: 1, name: "Finance Manager Approval", approver_role: "finance_manager", amount_min: 5000000, amount_max: 20000000, sla_hours: 24 },
          { seq: 2, name: "Managing Director Approval", approver_role: "managing_director", amount_min: 5000000, amount_max: 20000000, sla_hours: 48 },
          { seq: 1, name: "CFO Approval", approver_role: "cfo", amount_min: 20000000, amount_max: 1000000000, sla_hours: 24 },
          { seq: 2, name: "Executive Approval", approver_role: "executive_director", amount_min: 20000000, amount_max: 1000000000, sla_hours: 48 },
        ],
      },
      {
        code: "WF-WFP",
        name: "Workforce Plan Approval",
        entity_type: "hr.workforce_plans",
        desc: "Single HR Manager approval for workforce plans.",
        steps: [
          { seq: 1, name: "HR Manager Approval", approver_role: "hr_manager", amount_min: 0, amount_max: 0, sla_hours: 24 },
        ],
      },
    ];
    for (const w of workflowDefs) {
      // Upsert: migrations seed a subset of workflow definitions (WF-PR,
      // WF-DNM, WF-REQ, ...), so reconcile on (company_id, code) instead of
      // plain inserting. Safe for fresh seeds too.
      await client.query(
        `INSERT INTO workflows (company_id, tenant_id, code, name, entity_type, description, config, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7, true)
         ON CONFLICT (company_id, code) DO UPDATE SET
           name = EXCLUDED.name,
           entity_type = EXCLUDED.entity_type,
           description = EXCLUDED.description,
           config = EXCLUDED.config,
           is_active = true`,
        [companyId, tenantId, w.code, w.name, w.entity_type, w.desc, JSON.stringify(w.steps)]
      );
      bump("workflows");
    }

    // ============================================================
    // 13. Label templates + system configs
    // ============================================================
    const labelTemplateDefs = [
      {
        code: "LT-FG-REAM",
        name: "Finished Goods Ream Label",
        kind: "PRODUCT",
        content: {
          format: "QR",
          width_mm: 40,
          height_mm: 25,
          fields: [
            { name: "product_code", label: "Product", source: "product.code" },
            { name: "product_name", label: "Name", source: "product.name" },
            { name: "batch_no", label: "Batch", source: "batch.code" },
            { name: "qr_code", label: "QR", source: "qr.code", type: "qr" },
            { name: "gsm", label: "GSM", source: "product.gsm" },
            { name: "ream_qty", label: "Sheets", source: "product.sheets_per_ream" },
          ],
        },
      },
      {
        code: "LT-CARTON",
        name: "Carton Label",
        kind: "CARTON",
        content: {
          format: "QR",
          width_mm: 60,
          height_mm: 40,
          fields: [
            { name: "product_code", label: "Product", source: "product.code" },
            { name: "batch_no", label: "Batch", source: "batch.code" },
            { name: "reams", label: "Reams", source: "carton.reams" },
            { name: "qr_code", label: "QR", source: "qr.code", type: "qr" },
          ],
        },
      },
      {
        code: "LT-PALLET",
        name: "Pallet Label",
        kind: "PALLET",
        content: {
          format: "QR",
          width_mm: 100,
          height_mm: 70,
          fields: [
            { name: "pallet_no", label: "Pallet", source: "pallet.code" },
            { name: "cartons", label: "Cartons", source: "pallet.cartons" },
            { name: "product_code", label: "Product", source: "product.code" },
            { name: "qr_code", label: "QR", source: "qr.code", type: "qr" },
          ],
        },
      },
      {
        code: "LT-MACHINE",
        name: "Machine QR Label",
        kind: "MACHINE",
        content: {
          format: "QR",
          width_mm: 40,
          height_mm: 40,
          fields: [
            { name: "machine_code", label: "Machine", source: "machine.code" },
            { name: "machine_name", label: "Name", source: "machine.name" },
            { name: "status", label: "Status", source: "machine.status" },
            { name: "qr_code", label: "QR", source: "qr.code", type: "qr" },
          ],
        },
      },
      {
        code: "LT-ASSET",
        name: "Asset QR Label",
        kind: "ASSET",
        content: {
          format: "QR",
          width_mm: 40,
          height_mm: 25,
          fields: [
            { name: "asset_tag", label: "Tag", source: "asset.tag" },
            { name: "asset_name", label: "Name", source: "asset.name" },
            { name: "custodian", label: "Custodian", source: "asset.custodian" },
            { name: "qr_code", label: "QR", source: "qr.code", type: "qr" },
          ],
        },
      },
      {
        code: "LT-SEC-JOB",
        name: "Security Job Label",
        kind: "WORK_ORDER",
        content: {
          format: "QR",
          width_mm: 50,
          height_mm: 30,
          fields: [
            { name: "job_no", label: "Job No", source: "job.no" },
            { name: "classification", label: "Class", source: "job.classification" },
            { name: "qr_code", label: "QR", source: "qr.code", type: "qr" },
          ],
        },
      },
      {
        code: "LT-BIN",
        name: "Bin Location Label",
        kind: "BIN",
        content: {
          format: "QR",
          width_mm: 30,
          height_mm: 20,
          fields: [
            { name: "warehouse", label: "WH", source: "bin.warehouse" },
            { name: "bin_code", label: "Bin", source: "bin.code" },
            { name: "qr_code", label: "QR", source: "qr.code", type: "qr" },
          ],
        },
      },
    ];
    for (const t of labelTemplateDefs) {
      await insertOne(client, "label_templates", {
        company_id: companyId,
        tenant_id: tenantId,
        code: t.code,
        name: t.name,
        kind: t.kind,
        content: t.content,
        is_active: true,
      });
      bump("label_templates");
    }

    const configDefs = [
      {
        key: "company.profile",
        value: {
          name: "Hope Design Group Ltd",
          short_name: "HDG",
          tax_id: "UGR-104-XXX-XXX",
          currency: "UGX",
          country: "UG",
          timezone: "Africa/Kampala",
          fiscal_year_start: "07-01",
        },
        desc: "Company profile used across documents and reports.",
      },
      {
        key: "qr.thresholds",
        value: {
          excessive_scans: 10,
          excessive_window_minutes: 5,
          impossible_movement_km: 500,
          same_qr_locations: 2,
        },
        desc: "QR anomaly detection thresholds.",
      },
      {
        key: "notifications.defaults",
        value: {
          in_app: true,
          email: true,
          sms: false,
          push: true,
          low_stock_alert: true,
          invoice_overdue_days: 30,
        },
        desc: "Default notification channel preferences.",
      },
      {
        key: "system.name",
        value: { name: "Hope Design ERP" },
        desc: "System display name.",
      },
      {
        key: "security.dual_control",
        value: {
          secure_jobs: true,
          secure_material_issue: true,
          supplier_payments: true,
          payroll_release: true,
        },
        desc: "Dual-control enforcement flags for sensitive operations.",
      },
    ];
    for (const c of configDefs) {
      await insertOne(client, "configs", {
        tenant_id: tenantId,
        key: c.key,
        value: c.value,
        description: c.desc,
      });
      bump("configs");
    }

    const stock = await ensureOpeningStock(client, tenantId);
    bump("inventory", stock.inserted);

    const stat = await ensureStatutoryConfigs(client, tenantId);
    bump("statutory_configs", stat.inserted);

    const lst = await ensureCompanyStatutoryOverrides(client, tenantId, companyId);
    bump("statutory_configs", lst.inserted);

    const hcm = await ensureHcmSeed(client, tenantId, companyId);
    for (const [k, v] of Object.entries(hcm.inserted)) bump(k, v);

    const cb = await ensureContractBuilderSeed(client, tenantId, companyId);
    for (const [k, v] of Object.entries(cb.inserted)) bump(k, v);

    const assetSeed = await ensureAssetModuleSeed(client, tenantId, companyId);
    for (const [k, v] of Object.entries(assetSeed.inserted)) bump(k, v);

    const analyticsSeed = await ensureAnalyticsSeed(client, tenantId, companyId);
    for (const [k, v] of Object.entries(analyticsSeed.inserted)) bump(k, v);

    const mesSeed = await ensureMesSeed(client, tenantId, companyId, branchId, facilityId);
    for (const [k, v] of Object.entries(mesSeed.inserted)) bump(k, v);

    // Completion guard MUST be inserted last
    await insertOne(client, "configs", {
      tenant_id: tenantId,
      key: "seed.completed",
      value: {
        completed_at: new Date().toISOString(),
        schema_version: 13,
        counts: stats,
      },
      description: "Marker that the deterministic seed has completed for this tenant.",
    });
    bump("configs");

    await client.query("COMMIT");
    console.log("Seed completed. Counts:", stats);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { seedAll };
