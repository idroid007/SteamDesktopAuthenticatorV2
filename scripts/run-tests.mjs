/**
 * Runs the test suite on every Node version this project supports.
 *
 * `node --test "test/*.test.js"` expands the glob itself, but only from Node 22.
 * On Node 20 the pattern reaches the runner as a literal filename and the run
 * fails. Passing a directory breaks the other way on Node 24. Listing the files
 * here and handing over real paths works everywhere.
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';

const dir = process.argv[2] ?? 'test';
const files = (await readdir(dir))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => join(dir, name));

if (files.length === 0) {
  console.error(`No test files in ${dir}`);
  process.exit(1);
}

const child = spawn(process.execPath, ['--test', ...files], { stdio: 'inherit' });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 1);
});
