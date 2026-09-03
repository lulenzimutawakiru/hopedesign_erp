const path = require("path");
const fs = require("fs");
const { Pool } = require("pg");

function loadEnv() {
  const root = path.resolve(__dirname, "..", "..", "..");
  require("dotenv").config({ path: path.join(root, ".env") });
  require("dotenv").config({ path: path.join(root, ".env.local"), override: true });
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
