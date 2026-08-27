const { createPool } = require("./lib");
const { seedAll } = require("./seed-data");

async function main() {
  const pool = createPool();
  try {
    await seedAll(pool);
    console.log("Seed complete.");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
