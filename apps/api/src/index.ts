import 'dotenv/config';
import { injectSpeedInsights } from '@vercel/speed-insights';
import { app } from './app.js';
import { config } from './config.js';
import { pingDb } from './db.js';

// Initialize Vercel Speed Insights
injectSpeedInsights();

async function main() {
  await pingDb();
  const server = app.listen(config.port, () => {
    console.log(`[api] Hope Design ERP API listening on http://localhost:${config.port}`);
  });

  const shutdown = (signal: string) => {
    console.log(`[api] ${signal} received ? shutting down`);
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

main().catch((err) => {
  console.error('[api] failed to start', err);
  process.exit(1);
});
