import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_AUTO_CONFIRM, type AutoConfirmRules } from '../autoconfirm.js';
import { decryptVault, encryptVault, type EncryptedVault } from '../crypto/vault.js';
import type { StoredAccount } from '../types.js';

export interface VaultContents {
  version: 2;
  accounts: StoredAccount[];
  settings: VaultSettings;
}

export interface VaultSettings {
  /** Poll Steam for new confirmations while the app is open. */
  autoCheckConfirmations: boolean;
  checkIntervalSeconds: number;
  /** Show a desktop notification when something new arrives. */
  notifyOnNewConfirmation: boolean;
  /** Lock the vault after this many idle minutes. Zero leaves it unlocked. */
  lockAfterIdleMinutes: number;
  /** Answering confirmations without a human looking. See autoconfirm.ts. */
  autoConfirm: AutoConfirmRules;
}

export const DEFAULT_SETTINGS: VaultSettings = {
  autoCheckConfirmations: true,
  checkIntervalSeconds: 30,
  notifyOnNewConfirmation: true,
  lockAfterIdleMinutes: 0,
  autoConfirm: DEFAULT_AUTO_CONFIRM,
};

export function emptyVault(): VaultContents {
  return { version: 2, accounts: [], settings: DEFAULT_SETTINGS };
}

/**
 * Where the vault lives.
 *
 * Everything stays under your own user profile. Nothing syncs, nothing uploads,
 * and no part of this app talks to a server we run, because we do not run one.
 */
export function defaultVaultPath(): string {
  const override = process.env['SDA_VAULT_PATH'];
  if (override) return override;

  const home = homedir();
  switch (platform()) {
    case 'win32':
      return join(process.env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'sda2', 'vault.json');
    case 'darwin':
      return join(home, 'Library', 'Application Support', 'sda2', 'vault.json');
    default:
      return join(
        process.env['XDG_DATA_HOME'] ?? join(home, '.local', 'share'),
        'sda2',
        'vault.json',
      );
  }
}

export async function vaultExists(path = defaultVaultPath()): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch {
    return false;
  }
}

export async function readVault(passphrase: string, path = defaultVaultPath()): Promise<VaultContents> {
  const raw = await readFile(path, 'utf8');
  const envelope = JSON.parse(raw) as EncryptedVault;
  const plaintext = await decryptVault(envelope, passphrase);
  const parsed = JSON.parse(plaintext) as VaultContents;
  return {
    version: 2,
    accounts: parsed.accounts ?? [],
    settings: {
      ...DEFAULT_SETTINGS,
      ...parsed.settings,
      autoConfirm: { ...DEFAULT_AUTO_CONFIRM, ...parsed.settings?.autoConfirm },
    },
  };
}

/**
 * Writes to a temporary file and renames it over the old one, so a crash
 * mid-write leaves the previous vault intact. Losing this file means losing
 * the accounts inside it, so the write path takes no chances.
 */
export async function writeVault(
  contents: VaultContents,
  passphrase: string,
  path = defaultVaultPath(),
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const envelope = await encryptVault(JSON.stringify(contents), passphrase);
  const tmp = `${path}.${process.pid}.tmp`;

  await writeFile(tmp, JSON.stringify(envelope, null, 2), { encoding: 'utf8', mode: 0o600 });
  // Windows ignores POSIX modes. Everywhere else, keep it owner-only.
  if (platform() !== 'win32') {
    await chmod(tmp, 0o600);
  }
  await rename(tmp, path);
}

/** Timestamped copy beside the vault, for before a risky change. */
export async function backupVault(path = defaultVaultPath()): Promise<string | undefined> {
  try {
    const raw = await readFile(path, 'utf8');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const target = `${path}.${stamp}.bak`;
    await writeFile(target, raw, { encoding: 'utf8', mode: 0o600 });
    return target;
  } catch {
    return undefined;
  }
}
