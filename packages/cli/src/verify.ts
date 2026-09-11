import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { c, fail, heading, ok, say, warn } from './term.js';

const REPO = 'https://github.com/idroid007/SteamDesktopAuthenticatorV2';

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.isFile() && !entry.name.endsWith('.map')) out.push(full);
  }
  return out.sort();
}

async function sha256(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

/**
 * Checks this install against the checksums published with the release.
 *
 * Fake SDA builds have been stealing Steam accounts since 2018, and telling
 * people to trust us does nothing about that. This command lets you check
 * instead. It compares every shipped file against SHA256SUMS, which our
 * release workflow generates and signs.
 */
export async function verifyInstall(): Promise<void> {
  const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const distDir = join(packageRoot, 'dist');

  heading('Verifying this install');
  say(`${c.muted('Package:')} ${c.dim(packageRoot)}`);
  say();

  let expected: Map<string, string>;
  try {
    const sums = await readFile(join(packageRoot, 'SHA256SUMS'), 'utf8');
    expected = new Map(
      sums
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          const [hash, ...rest] = line.split(/\s+/);
          return [rest.join(' ').replace(/^\*/, ''), hash ?? ''] as [string, string];
        }),
    );
  } catch {
    warn('This build ships no SHA256SUMS, so there is nothing to compare against.');
    say(c.muted('Release builds from our CI always include one.'));
    say();
    printProvenanceHelp();
    return;
  }

  const files = await walk(distDir);
  let matched = 0;
  const problems: string[] = [];

  for (const file of files) {
    const key = relative(packageRoot, file).split('\\').join('/');
    const want = expected.get(key);
    const got = await sha256(file);
    if (!want) {
      problems.push(`${key} is not in SHA256SUMS. Something added it after the release.`);
    } else if (want !== got) {
      problems.push(`${key} does not match. Expected ${want.slice(0, 16)}…, got ${got.slice(0, 16)}…`);
    } else {
      matched++;
    }
  }

  for (const [key] of expected) {
    if (!files.some((f) => relative(packageRoot, f).split('\\').join('/') === key)) {
      problems.push(`${key} is listed in SHA256SUMS but missing from this install.`);
    }
  }

  if (problems.length === 0) {
    ok(`All ${matched} files match the published checksums.`);
    say();
    printProvenanceHelp();
    return;
  }

  fail(`${problems.length} problem${problems.length === 1 ? '' : 's'} found.`);
  for (const problem of problems) say(`  ${c.red('·')} ${problem}`);
  say();
  say(c.bold(c.red('  Do not put Steam secrets into this copy.')));
  say(`  ${c.muted('Get a clean one:')} ${c.bone(REPO)}`);
  say();
  process.exitCode = 1;
}

function printProvenanceHelp(): void {
  say(c.bold(c.bone('  Check the chain yourself')));
  say(`    ${c.bone('npm audit signatures')}  ${c.muted('proves npm served what our CI built')}`);
  say(`    ${c.muted('Every release links to the commit and workflow run that produced it:')}`);
  say(`    ${c.dim(`${REPO}/releases`)}`);
  say();
}
