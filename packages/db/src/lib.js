const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

function loadEnv() {
  const root = path.resolve(__dirname, "..", "..", "..");
  for (const f of [".env", ".env.local"]) {
    const p = path.join(root, f);
    if (fs.existsSync(p)) {
      require("dotenv").config({ path: p });
      break;
    }
  }
}

function createPool() {
  loadEnv();
  return new Pool({
    connectionString:
      process.env.DATABASE_URL ||
      "postgres://hopedesign:hopedesign_dev@localhost:5432/hopedesign_erp",
    max: 5,
  });
}

module.exports = { loadEnv, createPool };
