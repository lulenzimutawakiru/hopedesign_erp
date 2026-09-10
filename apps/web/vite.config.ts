import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Changes on every deploy. index.html carries it as a <meta> tag and the
// browser re-checks /build.json, so a tab left open across a deploy can
// notice that a newer build exists instead of silently running stale code.
const BUILD_ID = process.env.BUILD_ID ?? new Date().toISOString().replace(/[^0-9]/g, '');

function buildSignal(): Plugin {
  let outDir = "dist";
  return {
    name: 'hdg-build-signal',
    configResolved(config) {
      outDir = config.build.outDir;
    },
    transformIndexHtml(html) {
      return html.replace(
        '</head>',
        `  <meta name="build-id" content="${BUILD_ID}" />\n  </head>`
      );
    },
    closeBundle() {
      writeFileSync(
        resolve(outDir, 'build.json'),
        JSON.stringify({ buildId: BUILD_ID, builtAt: new Date().toISOString() }) + "\n",
        'utf8'
      );
    },
  };
}

export default defineConfig({
  plugins: [react(), buildSignal()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:4000', changeOrigin: true },
    },
  },
  build: { outDir: 'dist', sourcemap: process.env.SOURCEMAP !== 'false' },
});
