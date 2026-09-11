import {
  Account,
  defaultVaultPath,
  emptyVault,
  readVault,
  vaultExists,
  writeVault,
  WrongPassphraseError,
  type StoredAccount,
  type VaultContents,
} from '@sda/core';
import { askSecret, c, fail, say } from './term.js';

export interface OpenVault {
  contents: VaultContents;
  passphrase: string;
  path: string;
  save(): Promise<void>;
  accounts(): Account[];
  find(query: string): Account | undefined;
}

/**
 * Opens the vault, asking for the passphrase.
 *
 * The passphrase lives in this process and nowhere else. It never reaches a
 * file, an environment variable we write, or the network.
 */
export async function openVault(path = defaultVaultPath()): Promise<OpenVault> {
  if (!(await vaultExists(path))) {
    fail(`No vault at ${path}`);
    say(`${c.muted('Run')} ${c.bone('sda setup')} ${c.muted('to make one.')}`);
    process.exit(1);
  }

  // Scripts and CI can pass the passphrase in, at their own risk.
  const fromEnv = process.env['SDA_PASSPHRASE'];
  let passphrase = fromEnv ?? (await askSecret('Vault passphrase:'));

  let contents: VaultContents;
  for (let attempt = 1; ; attempt++) {
    try {
      contents = await readVault(passphrase, path);
      break;
    } catch (err) {
      if (!(err instanceof WrongPassphraseError)) throw err;
      if (fromEnv || attempt >= 3) {
        fail('That passphrase does not open this vault.');
        process.exit(1);
      }
      fail(`Wrong passphrase. ${3 - attempt} ${3 - attempt === 1 ? 'try' : 'tries'} left.`);
      passphrase = await askSecret('Vault passphrase:');
    }
  }

  const built = new Map<string, Account>();
  const vault: OpenVault = {
    contents,
    passphrase,
    path,
    async save() {
      await writeVault(contents, passphrase, path);
    },
    accounts() {
      return contents.accounts.map((stored) => {
        const key = stored.secrets.steamId;
        let account = built.get(key);
        if (!account) {
          account = new Account(stored, {
            onSessionChange: (tokens) => {
              stored.session = tokens;
              void writeVault(contents, passphrase, path).catch(() => {});
            },
          });
          built.set(key, account);
        }
        return account;
      });
    },
    find(query) {
      return findAccount(vault.accounts(), query);
    },
  };
  return vault;
}

/**
 * Opens a vault with a passphrase already in hand.
 *
 * The server uses this so the web interface can carry its own unlock screen,
 * rather than forcing every user through a terminal prompt.
 */
export async function openVaultWithPassphrase(
  passphrase: string,
  path = defaultVaultPath(),
): Promise<OpenVault> {
  const contents = await readVault(passphrase, path);
  const built = new Map<string, Account>();

  const vault: OpenVault = {
    contents,
    passphrase,
    path,
    async save() {
      await writeVault(contents, passphrase, path);
    },
    accounts() {
      return contents.accounts.map((stored) => {
        const key = stored.secrets.steamId;
        let account = built.get(key);
        if (!account) {
          account = new Account(stored, {
            onSessionChange: (tokens) => {
              stored.session = tokens;
              void writeVault(contents, passphrase, path).catch(() => {});
            },
          });
          built.set(key, account);
        }
        return account;
      });
    },
    find(query) {
      return findAccount(vault.accounts(), query);
    },
  };
  return vault;
}

/** Matches on account name, label or SteamID, case-insensitively. */
export function findAccount(accounts: Account[], query: string): Account | undefined {
  const q = query.trim().toLowerCase();
  return (
    accounts.find((a) => a.accountName.toLowerCase() === q) ??
    accounts.find((a) => a.label.toLowerCase() === q) ??
    accounts.find((a) => a.steamId === query) ??
    accounts.find((a) => a.accountName.toLowerCase().startsWith(q))
  );
}

/** Asks which account when a command needs one and the user named none. */
export async function pickAccount(vault: OpenVault, query?: string): Promise<Account> {
  const accounts = vault.accounts();
  if (accounts.length === 0) {
    fail('This vault has no accounts yet.');
    say(`${c.muted('Add one with')} ${c.bone('sda import <path-to-maFile>')}`);
    process.exit(1);
  }

  if (query) {
    const match = vault.find(query);
    if (!match) {
      fail(`No account here matches "${query}".`);
      say(`${c.muted('Known accounts:')} ${accounts.map((a) => a.label).join(', ')}`);
      process.exit(1);
    }
    return match;
  }

  if (accounts.length === 1) return accounts[0]!;

  say();
  accounts.forEach((a, i) => {
    say(`  ${c.bone(String(i + 1).padStart(2))}  ${a.label} ${c.dim(a.steamId)}`);
  });
  const { ask } = await import('./term.js');
  const answer = await ask('\nWhich account?');
  const index = Number(answer) - 1;
  if (Number.isInteger(index) && accounts[index]) return accounts[index]!;

  const byName = findAccount(accounts, answer);
  if (byName) return byName;

  fail('That is not one of the accounts listed.');
  process.exit(1);
}

export function newVault(): VaultContents {
  return emptyVault();
}

export function addAccount(vault: VaultContents, account: StoredAccount): 'added' | 'replaced' {
  const index = vault.accounts.findIndex((a) => a.secrets.steamId === account.secrets.steamId);
  if (index >= 0) {
    vault.accounts[index] = account;
    return 'replaced';
  }
  vault.accounts.push(account);
  return 'added';
}
