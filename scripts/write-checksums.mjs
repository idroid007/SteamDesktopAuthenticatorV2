/**
 * Writes a SHA256SUMS file into each publishable package.
 *
 * `sda verify` reads this to tell a user whether the copy on their disk matches
 * what our CI built. Fake SDA builds have been stealing accounts since 2018, and
 * a checksum a user can check themselves beats asking them to trust a download.
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const PACKAGES = ['packages/core', 'packages/ui', 'packages/cli'];

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    // Source maps change with the build path and add nothing to verify against.
    else if (entry.isFile() && !entry.name.endsWith('.map')) out.push(full);
  }
  return out;
}

for (const pkg of PACKAGES) {
  const dist = join(pkg, 'dist');
  const files = (await walk(dist)).sort();

  const lines = [];
  for (const file of files) {
    const hash = createHash('sha256').update(await readFile(file)).digest('hex');
    lines.push(`${hash}  ${relative(pkg, file).split('\\').join('/')}`);
  }

  await writeFile(join(pkg, 'SHA256SUMS'), `${lines.join('\n')}\n`);
  console.log(`${pkg}/SHA256SUMS  ${lines.length} files`);
}
