import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { app } from './app.js';
import { config } from './config.js';
import { pingDb } from './db.js';

// Vercel (framework preset "express") imports this module and uses the default
// export as the request handler. Only start a long-running listener when the
// entrypoint is executed directly (local dev / `npm start`).
export default app;

async function main() {
  await pingDb();
  const server = app.listen(config.port, () => {
    console.log(`[api] Hope Design ERP API listening on http://localhost:${config.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[api] ${signal} received - shutting down`);
    server.close(() => {
      import('./db.js')
        .then(({ pool }) => pool.end())
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
const isDirectRun = entry !== '' && fileURLToPath(import.meta.url) === entry;

if (isDirectRun) {
  main().catch((err) => {
    console.error('[api] failed to start', err);
    process.exit(1);
  });
}
