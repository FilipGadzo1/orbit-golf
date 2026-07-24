/**
 * Bundles the TypeScript smoke test with esbuild (already present via Vite) and
 * runs it in plain Node — no browser, no test framework.
 */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cache = path.join(root, 'node_modules', '.cache');
fs.mkdirSync(cache, { recursive: true });

const suites = ['smoke', 'stats'];
let failed = 0;

for (const suite of suites) {
  const out = path.join(cache, `orbit-golf-${suite}.mjs`);
  await build({
    entryPoints: [path.join(root, 'test', `${suite}.ts`)],
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: out,
    logLevel: 'warning',
  });
  const result = spawnSync(process.execPath, [out], { stdio: 'inherit' });
  if (result.status !== 0) failed++;
}

process.exit(failed === 0 ? 0 : 1);
