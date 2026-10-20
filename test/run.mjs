/**
 * Dependency-free smoke-test runner (wired to `npm test`).
 *
 * For each test/*.test.ts: bundle with esbuild (CJS, node, vscode external)
 * into a temp file, run it with `node`, print PASS/FAIL per file, clean up,
 * and exit non-zero if anything failed.
 */
import { readdirSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const files = readdirSync(here)
  .filter((f) => f.endsWith('.test.ts'))
  .sort();

if (files.length === 0) {
  console.error('no test/*.test.ts files found — nothing to run');
  process.exit(1);
}

let failedFiles = 0;
const tempFiles = [];

for (const file of files) {
  const name = file.replace(/\.test\.ts$/, '');
  const outfile = path.join(os.tmpdir(), `litellm-test-${name}.js`);
  try {
    esbuild.buildSync({
      entryPoints: [path.join(here, file)],
      bundle: true,
      platform: 'node',
      format: 'cjs',
      outfile,
      external: ['vscode'],
      logLevel: 'silent',
    });
  } catch (err) {
    failedFiles++;
    console.log(`FAIL  ${file}  (esbuild error)`);
    console.log(String(err));
    continue;
  }
  tempFiles.push(outfile);

  const result = spawnSync(process.execPath, [outfile], { encoding: 'utf8' });
  if (result.status === 0) {
    const tail = (result.stdout || '').trim().split('\n').pop();
    console.log(`PASS  ${file}${tail ? `  (${tail})` : ''}`);
  } else {
    failedFiles++;
    console.log(`FAIL  ${file}`);
    if (result.stdout) process.stdout.write(indent(result.stdout));
    if (result.stderr) process.stderr.write(indent(result.stderr));
  }
}

for (const f of tempFiles) {
  try {
    unlinkSync(f);
  } catch {
    // best effort
  }
}

const ok = files.length - failedFiles;
console.log(`\n${ok}/${files.length} test files passed${failedFiles ? ` (${failedFiles} failed)` : ' — all green'}`);
process.exit(failedFiles ? 1 : 0);

function indent(s) {
  return s
    .split('\n')
    .map((l) => '      ' + l)
    .join('\n')
    .trimEnd() + '\n';
}
