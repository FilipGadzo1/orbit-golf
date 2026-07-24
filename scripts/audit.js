/** One-off generator audit. Run with: node scripts/audit.js */
import { build } from 'esbuild';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'node_modules', '.cache', 'orbit-golf-audit.mjs');
fs.mkdirSync(path.dirname(out), { recursive: true });

await build({
  entryPoints: [path.join(root, 'test', 'audit-achievements.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: out,
  logLevel: 'warning',
});

process.exit(spawnSync(process.execPath, [out], { stdio: 'inherit' }).status ?? 1);
