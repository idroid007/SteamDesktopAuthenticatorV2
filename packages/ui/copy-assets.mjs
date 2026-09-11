import { cp, mkdir, readdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';

const src = 'src';
const out = 'dist';
await mkdir(out, { recursive: true });

for (const entry of await readdir(src, { withFileTypes: true })) {
  if (entry.isDirectory()) {
    await cp(join(src, entry.name), join(out, entry.name), { recursive: true });
    console.log(`copied ${entry.name}/`);
    continue;
  }
  if (entry.name.endsWith('.ts')) continue;
  await copyFile(join(src, entry.name), join(out, entry.name));
  console.log(`copied ${entry.name}`);
}
