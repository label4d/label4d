#!/usr/bin/env node
// Compatibility entry for the Python importer. The historical raw/tracking mixer is retired.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
if (args.length && !args[0].startsWith('--')) {
  console.error('The old raw-drive/tracking pairing is retired. Use pnpm data:import:kitti --input <tracking-root> --sequence <NNNN> --output <dir> --url-prefix <url>.');
  process.exit(2);
}
const result = spawnSync('uv', ['run', '--project', 'tools/py', 'python', 'tools/py/import_kitti_tracking.py', ...args], { cwd: root, stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
