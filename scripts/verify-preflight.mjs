#!/usr/bin/env node
/**
 * verify:preflight — historical v2 fixture and environment checks.
 * Checks: node version, workspace deps, schema validity, manifest samples
 * (valid passes / invalid rejected), fixture presence + checksums, environment.
 * Exit codes: 0 all-pass, 1 fail, 2 blocked, 3 runner error.
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const results = [];
const add = (id, status, detail) => {
  results.push({ id, status, detail });
  console.log(`${status.padEnd(7)} ${id}: ${detail}`);
};

// 1. node
const nodeOk = Number(process.versions.node.split('.')[0]) >= 18;
add('node>=18', nodeOk ? 'PASS' : 'FAIL', `node ${process.versions.node}`);

// 2. workspace deps
const depsInstalled = existsSync('node_modules/.pnpm') || existsSync('node_modules/three');
add('workspace-deps', depsInstalled ? 'PASS' : 'FAIL', depsInstalled ? 'node_modules present' : 'run: pnpm install');

// 3. schema + samples
const schemaPath = 'fixtures/schemas/manifest.v2.schema.json';
if (existsSync(schemaPath)) {
  add('schema-present', 'PASS', schemaPath);
  const samplesDir = 'fixtures/schemas/samples';
  if (existsSync(samplesDir)) {
    let pass = 0, fail = 0;
    const files = readdirSync(samplesDir).filter((f) => f.endsWith('.json'));
    const validation = spawnSync('uv', ['run', '--project', 'tools/py', 'python', 'tools/py/validate_manifest.py', '--json', schemaPath, ...files.map((f) => `${samplesDir}/${f}`)], { encoding: 'utf8' });
    if (validation.error || ![0, 1].includes(validation.status)) {
      console.error(`Schema validator failed: ${validation.error?.message ?? validation.stderr}`);
      process.exit(3);
    }
    const validations = JSON.parse(validation.stdout);
    for (const [i, f] of files.entries()) {
      const errors = validations[i].errors;
      const shouldBeValid = !f.includes('invalid');
      if (shouldBeValid && errors.length === 0) pass++;
      else if (!shouldBeValid && errors.length > 0) pass++;
      else { fail++; add(`sample:${f}`, 'FAIL', shouldBeValid ? 'unexpected errors: ' + errors[0] : 'expected rejection, got VALID'); }
    }
    add('manifest-samples', fail === 0 ? 'PASS' : 'FAIL', `${pass} samples behave as expected, ${fail} violations`);
  } else {
    add('manifest-samples', 'BLOCKED', 'samples dir missing');
  }
} else {
  add('schema-present', 'FAIL', 'missing ' + schemaPath);
}

// 4. fixtures (S-mini / R-mini) presence + checksums
for (const fixture of ['s-mini', 'r-mini']) {
  const dir = `fixtures/${fixture}`;
  const checksumFile = `${dir}/checksums.json`;
  if (!existsSync(dir)) {
    add(`fixture:${fixture}`, 'BLOCKED', 'not generated yet (see scripts/fixtures/)');
    continue;
  }
  if (!existsSync(checksumFile)) {
    add(`fixture:${fixture}`, 'FAIL', 'checksums.json missing');
    continue;
  }
  const checksums = JSON.parse(readFileSync(checksumFile, 'utf8'));
  let mismatch = 0, missing = 0, checked = 0;
  for (const [file, expected] of Object.entries(checksums)) {
    checked++;
    if (!existsSync(`${dir}/${file}`)) { missing++; continue; }
    const actual = createHash('sha256').update(readFileSync(`${dir}/${file}`)).digest('hex');
    if (actual !== expected) mismatch++;
  }
  add(`fixture:${fixture}`, mismatch === 0 && missing === 0 ? 'PASS' : 'FAIL', `${checked} files checked, ${mismatch} checksum mismatch, ${missing} missing`);
}

// 5. environment info (evidence)
const env = {
  node: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  cwd: process.cwd(),
  timestamp: new Date().toISOString(),
};
console.log('ENV ' + JSON.stringify(env));

const hasFail = results.some((r) => r.status === 'FAIL');
const hasBlocked = results.some((r) => r.status === 'BLOCKED');
process.exit(hasFail ? 1 : hasBlocked ? 2 : 0);
