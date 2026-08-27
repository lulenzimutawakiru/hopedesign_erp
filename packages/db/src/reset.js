const { createPool } = require("./lib");

async function main() {
  const pool = createPool();
  await pool.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await pool.end();
  console.log("Database reset. Run `npm run db:migrate` and `npm run db:seed`.");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
