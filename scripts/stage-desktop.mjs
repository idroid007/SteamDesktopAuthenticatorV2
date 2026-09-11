/**
 * Copies the workspace packages into the desktop app as real directories.
 *
 * npm workspaces link @sda/core, @sda/ui and @sda/cli as symlinks pointing back
 * up the tree. electron-builder packages a directory, and a symlink out of that
 * directory does not survive the trip, so the app ships with the modules
 * missing. Copying them in first keeps the packaged app self-contained.
 *
 * None of the three has a runtime dependency of its own, so this copies three
 * folders and stops. That is the whole benefit of the zero-dependency rule
 * showing up somewhere unexpected.
 */
import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const DESKTOP = join('packages', 'desktop');
const TARGET = join(DESKTOP, 'node_modules', '@sda');
const PACKAGES = ['core', 'ui', 'cli'];

await rm(TARGET, { recursive: true, force: true });
await mkdir(TARGET, { recursive: true });

for (const name of PACKAGES) {
  const from = join('packages', name);
  const to = join(TARGET, name);
  await mkdir(to, { recursive: true });

  await cp(join(from, 'dist'), join(to, 'dist'), { recursive: true });
  await cp(join(from, 'package.json'), join(to, 'package.json'));

  const manifest = JSON.parse(await readFile(join(to, 'package.json'), 'utf8'));
  console.log(`staged @sda/${name}  ${manifest.version}`);
}

// The packaged app resolves its own copies, so drop the workspace links.
const manifestPath = join(DESKTOP, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log('desktop staged');
