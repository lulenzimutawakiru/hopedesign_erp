/**
 * Write a software bill of materials from the locked production dependency tree.
 * Names and versions only. This is the company's own inventory, not a certificate.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const packages = lock.packages ?? {};
const components = [];
for (const [name, meta] of Object.entries(packages)) {
  if (!name || name === '') continue;
  if (!meta || typeof meta !== 'object' || !meta.version) continue;
  const short = name.startsWith('node_modules/') ? name.slice('node_modules/'.length) : name;
  if (short.includes('node_modules/')) continue;
  components.push({ name: short, version: meta.version });
}
components.sort((a, b) => a.name.localeCompare(b.name));
const doc = {
  bomFormat: 'HopeDesign-SBOM',
  generatedFrom: 'package-lock.json',
  componentCount: components.length,
  components,
};
writeFileSync(path.join(root, 'docs', 'iso-sbom.json'), JSON.stringify(doc, null, 2) + '\n');
console.log(`Wrote ${components.length} components to docs/iso-sbom.json`);
