import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';

type ExpressApp = (req: IncomingMessage, res: ServerResponse) => unknown;

let appPromise: Promise<ExpressApp> | null = null;

/**
 * Vercel (framework preset "express", @vercel/node) imports this module and
 * invokes its default export for every request. Loading the entire route graph
 * eagerly at module scope means any boot-time failure (env fail-fast gate,
 * module resolution, DB driver initialisation) crashes the function before a
 * request is ever handled, which Vercel reports as the opaque
 * FUNCTION_INVOCATION_FAILED with no readable body.
 *
 * Instead the app graph is imported lazily on the first request inside the
 * handler, so boot errors are caught and returned as a plain-text HTTP error
 * that is visible in logs / curl output. Local dev still runs through main()
 * below when the entrypoint is executed directly.
 */
async function loadApp(): Promise<ExpressApp> {
  if (!appPromise) {
    appPromise = import('./app.js').then((m) => m.app as ExpressApp);
    appPromise.catch(() => {
      appPromise = null; // allow a later request to retry the boot
    });
  }
  return appPromise;
}

function invokeExpress(app: ExpressApp, req: IncomingMessage, res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (!settled) {
        settled = true;
        clearTimeout(guard);
        resolve();
      }
    };
    const guard = setTimeout(done, 60_000);
    res.once('finish', done);
    res.once('close', done);
    try {
      const result = app(req, res);
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).then(done, done);
      }
    } catch (err) {
      done();
      throw err;
    }
  });
}

export default async function vercelHandler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const prod = process.env.NODE_ENV === 'production';
  try {
    const app = await loadApp();
    if (!prod) console.log(`[api] handling ${req.method ?? ''} ${req.url ?? ''}`);
    await invokeExpress(app, req, res);
  } catch (err) {
    console.error('[api] request/boot error', err);
    const detail = prod
      ? (err instanceof Error ? err.message : 'boot failed')
      : err instanceof Error
        ? err.stack ?? err.message
        : String(err);
    try {
      if (!res.headersSent) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.end('BOOT_ERROR: ' + detail);
        return;
      }
      res.end();
    } catch {
      // Response already terminated upstream; nothing more we can do.
    }
  }
}

async function main(): Promise<void> {
  const [{ config }, { pingDb }, app] = await Promise.all([
    import('./config.js'),
    import('./db.js'),
    loadApp(),
  ]);
  await pingDb();
  const server = (app as unknown as import('express').Express).listen(config.port, config.host, () => {
    console.log(`[api] Hope Design ERP API listening on http://${config.host}:${config.port}`);
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
