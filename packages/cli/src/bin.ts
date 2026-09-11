#!/usr/bin/env node
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  beginLogin,
  defaultVaultPath,
  inspectImport,
  parseMaFile,
  steamTime,
  submitGuardCode,
  toMaFile,
  vaultExists,
  waitForLogin,
  writeVault,
  type Confirmation,
  SteamError,
} from '@sda/core';
import {
  ask,
  askSecret,
  c,
  confirm as askConfirm,
  copyToClipboard,
  fail,
  heading,
  ok,
  progressBar,
  say,
  warn,
} from './term.js';
import { addAccount, newVault, openVault, pickAccount, type OpenVault } from './vault.js';

const VERSION = '2.0.0-alpha.1';
const SITE = 'https://nohax.club';

interface Flags {
  _: string[];
  [key: string]: string | boolean | string[];
}

function parseArgs(argv: string[]): Flags {
  const flags: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=', 2);
      if (!name) continue;
      const next = argv[i + 1];
      if (inline !== undefined) flags[name] = inline;
      else if (next && !next.startsWith('-')) {
        flags[name] = next;
        i++;
      } else flags[name] = true;
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (const ch of arg.slice(1)) flags[ch] = true;
    } else {
      flags._.push(arg);
    }
  }
  return flags;
}

function banner(): void {
  say();
  say(`  ${c.red('▰▰')} ${c.bold(c.bone('Steam Desktop Authenticator'))} ${c.red('v2')}`);
  say(`  ${c.muted('Your secrets stay on this machine.')} ${c.dim(SITE)}`);
}

/* ------------------------------------------------------------------ setup */

async function cmdSetup(flags: Flags): Promise<void> {
  const path = (flags['vault'] as string) ?? defaultVaultPath();
  banner();

  if (await vaultExists(path)) {
    fail(`A vault already exists at ${path}`);
    say(`${c.muted('Delete it yourself if you mean to start over.')}`);
    process.exit(1);
  }

  heading('Create your vault');
  say(`${c.muted('Everything lives at')} ${c.bone(path)}`);
  say(c.muted('Pick a passphrase you can remember. Nobody can reset it for you.'));
  say();

  // Docker images and CI runners have no keyboard, so they pass it in.
  const fromEnv = process.env['SDA_PASSPHRASE'];
  const passphrase = fromEnv ?? (await askSecret('New passphrase:'));
  if (passphrase.length < 8) {
    fail('Use at least 8 characters.');
    process.exit(1);
  }
  if (!fromEnv) {
    const again = await askSecret('Type it again:');
    if (passphrase !== again) {
      fail('Those did not match.');
      process.exit(1);
    }
  }

  say();
  say(c.dim('Deriving the key. This takes a moment by design.'));
  await writeVault(newVault(), passphrase, path);

  ok(`Vault ready at ${path}`);
  say();
  say(`${c.muted('Next:')} ${c.bone('sda import <path-to-your-maFiles>')}`);
}

/* ----------------------------------------------------------------- import */

async function collectMaFiles(target: string): Promise<string[]> {
  const info = await stat(target).catch(() => null);
  if (!info) {
    fail(`Nothing at ${target}`);
    process.exit(1);
  }
  if (info.isFile()) return [target];

  const entries = await readdir(target, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && (e.name.endsWith('.maFile') || e.name.endsWith('.json')))
    .filter((e) => e.name !== 'manifest.json')
    .map((e) => join(target, e.name));
}

async function cmdImport(flags: Flags): Promise<void> {
  const target = flags._[1];
  if (!target) {
    fail('Point me at an maFile or the folder holding them.');
    say(`${c.muted('Example:')} ${c.bone('sda import "C:\\\\SDA\\\\maFiles"')}`);
    process.exit(1);
  }

  const vault = await openVault((flags['vault'] as string) ?? undefined);
  const files = await collectMaFiles(resolve(target));
  if (files.length === 0) {
    fail('No maFiles in there.');
    process.exit(1);
  }

  heading(`Importing ${files.length} file${files.length === 1 ? '' : 's'}`);
  let imported = 0;

  for (const file of files) {
    const name = basename(file);
    try {
      const account = parseMaFile(await readFile(file, 'utf8'), name);
      const result = addAccount(vault.contents, account);
      imported++;
      ok(`${account.secrets.accountName} ${c.dim(account.secrets.steamId)} ${c.muted(result)}`);
      for (const note of inspectImport(account)) warn(`  ${note}`);
    } catch (err) {
      fail(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (imported > 0) {
    await vault.save();
    say();
    ok(`${imported} account${imported === 1 ? '' : 's'} in your vault.`);
    say(`${c.muted('Try')} ${c.bone('sda code')} ${c.muted('or')} ${c.bone('sda confirm')}`);
  }
}

/* ------------------------------------------------------------------- list */

async function cmdList(flags: Flags): Promise<void> {
  const vault = await openVault((flags['vault'] as string) ?? undefined);
  const accounts = vault.accounts();

  if (accounts.length === 0) {
    say(c.muted('No accounts yet. Add one with `sda import`.'));
    return;
  }

  heading(`${accounts.length} account${accounts.length === 1 ? '' : 's'}`);
  for (const account of accounts) {
    const flagsOut: string[] = [];
    if (!account.canConfirm) flagsOut.push(c.amber('no confirmations'));
    if (!account.hasSession) flagsOut.push(c.dim('signed out'));
    say(
      `  ${c.bone(account.label.padEnd(22))} ${c.dim(account.steamId)}  ${flagsOut.join(' ')}`,
    );
  }
}

/* ------------------------------------------------------------------- code */

async function cmdCode(flags: Flags): Promise<void> {
  const vault = await openVault((flags['vault'] as string) ?? undefined);
  const account = await pickAccount(vault, flags._[1]);

  await steamTime.align();

  if (flags['watch'] || flags['w']) return watchCode(vault, account.label);

  const { code, expiresIn } = await account.code();
  say();
  say(`  ${c.bold(c.red(code.split('').join(' ')))}`);
  say(`  ${c.muted(`${account.label} · good for ${expiresIn}s`)}`);

  if (flags['copy'] || flags['c']) {
    say();
    if (await copyToClipboard(code)) ok('Copied to your clipboard.');
    else warn('No clipboard tool found on this system.');
  }
  say();
}

async function watchCode(vault: OpenVault, label: string): Promise<void> {
  const account = vault.find(label)!;
  say();
  say(c.muted('Watching. Press ctrl-c to stop.'));
  say();

  const render = () => {
    const { code, expiresIn } = account.codeSync();
    const line = `  ${c.bold(c.red(code.split('').join(' ')))}   ${progressBar(expiresIn)} ${c.muted(`${String(expiresIn).padStart(2)}s`)}`;
    process.stdout.write(`\r\u001b[2K${line}`);
  };

  render();
  const timer = setInterval(render, 250);
  process.on('SIGINT', () => {
    clearInterval(timer);
    say('\n');
    process.exit(0);
  });
  await new Promise(() => {});
}

/* ---------------------------------------------------------- confirmations */

function describe(conf: Confirmation): string {
  const kind =
    conf.kind === 'trade'
      ? c.cyan('trade')
      : conf.kind === 'market'
        ? c.amber('market')
        : c.muted(conf.kind);
  return `${kind} ${c.bone(conf.headline)}`;
}

function printConfirmations(list: Confirmation[]): void {
  list.forEach((conf, i) => {
    say(`  ${c.bone(String(i + 1).padStart(2))}  ${describe(conf)}`);
    for (const line of conf.summary) say(`      ${c.muted(line)}`);
    say(`      ${c.dim(conf.when)}`);
  });
}

async function cmdConfirm(flags: Flags): Promise<void> {
  const vault = await openVault((flags['vault'] as string) ?? undefined);
  const account = await pickAccount(vault, flags._[1]);

  heading(`Confirmations for ${account.label}`);
  const list = await account.confirmations();

  if (list.length === 0) {
    say(c.muted('  Nothing waiting.'));
    return;
  }

  printConfirmations(list);
  say();

  if (flags['all'] && flags['accept']) {
    await account.respondAll(list, 'accept');
    ok(`Accepted ${list.length}.`);
    return;
  }
  if (flags['all'] && flags['deny']) {
    await account.respondAll(list, 'deny');
    ok(`Denied ${list.length}.`);
    return;
  }

  const answer = await ask(
    `${c.muted('Number to act on, or')} ${c.bone('a')}${c.muted('ccept all /')} ${c.bone('d')}${c.muted('eny all / enter to leave:')}`,
  );
  if (answer === '') return;

  if (answer.toLowerCase() === 'a') {
    if (await askConfirm(`Accept all ${list.length}?`)) {
      await account.respondAll(list, 'accept');
      ok(`Accepted ${list.length}.`);
    }
    return;
  }
  if (answer.toLowerCase() === 'd') {
    if (await askConfirm(`Deny all ${list.length}?`)) {
      await account.respondAll(list, 'deny');
      ok(`Denied ${list.length}.`);
    }
    return;
  }

  const picked = list[Number(answer) - 1];
  if (!picked) {
    fail('No such number.');
    return;
  }
  const decision = await ask(`${c.bone('a')}${c.muted('ccept or')} ${c.bone('d')}${c.muted('eny?')}`);
  if (decision.toLowerCase().startsWith('a')) {
    await account.accept(picked);
    ok('Accepted.');
  } else if (decision.toLowerCase().startsWith('d')) {
    await account.deny(picked);
    ok('Denied.');
  }
}

/* ------------------------------------------------------------------ login */

async function cmdLogin(flags: Flags): Promise<void> {
  const vault = await openVault((flags['vault'] as string) ?? undefined);
  const account = await pickAccount(vault, flags._[1]);

  heading(`Sign in as ${account.accountName}`);
  say(c.muted('Your password is encrypted with a key Steam issues for this attempt.'));
  say(c.muted('It never reaches us, because there is no us in the path.'));
  say();

  const password = await askSecret(`Steam password for ${account.accountName}:`);
  const pending = await beginLogin(account.accountName, password);

  if (pending.guard.kind === 'device-code') {
    const { code } = await account.code();
    say(`${c.muted('Answering the Steam Guard prompt with')} ${c.red(code)}`);
    await submitGuardCode(pending, code);
  } else if (pending.guard.kind === 'email-code') {
    const sentTo = pending.guard.sentTo ? ` sent to ${pending.guard.sentTo}` : '';
    const code = await ask(`Enter the Steam Guard code${sentTo}:`);
    await submitGuardCode(pending, code, 'email');
  } else if (pending.guard.kind === 'device-confirmation') {
    say(c.muted('Approve the prompt in your Steam mobile app.'));
  }

  const tokens = await waitForLogin(pending);
  account.setSession(tokens);
  await vault.save();

  ok(`Signed in as ${account.accountName}.`);
}

/* ----------------------------------------------------------------- export */

async function cmdExport(flags: Flags): Promise<void> {
  const vault = await openVault((flags['vault'] as string) ?? undefined);
  const account = await pickAccount(vault, flags._[1]);

  const target = (flags['out'] as string) ?? `${account.accountName}.maFile`;
  warn('This writes your secrets to disk unencrypted.');
  if (!(await askConfirm(`Write ${target}?`))) return;

  await writeFile(target, toMaFile(account.toJSON()), { encoding: 'utf8', mode: 0o600 });
  ok(`Wrote ${target}`);
  say(c.muted('SDA v1 and steamguard-cli both read this format.'));
}

/* ----------------------------------------------------------------- remove */

async function cmdRemove(flags: Flags): Promise<void> {
  const vault = await openVault((flags['vault'] as string) ?? undefined);
  const account = await pickAccount(vault, flags._[1]);

  warn(`This drops ${account.label} from your vault on this machine.`);
  say(c.muted('Steam keeps the authenticator. Export first if you have no other copy.'));
  if (account.revocationCode) {
    say(`${c.muted('Revocation code:')} ${c.bone(account.revocationCode)}`);
  }
  say();

  if (!(await askConfirm(`Remove ${account.label} from this vault?`))) return;

  vault.contents.accounts = vault.contents.accounts.filter(
    (a) => a.secrets.steamId !== account.steamId,
  );
  await vault.save();
  ok(`${account.label} removed from the vault.`);
}

/* ------------------------------------------------------------------- help */

function cmdHelp(): void {
  banner();
  say();
  say(c.bold(c.bone('  Usage')));
  say(`    ${c.bone('sda')} ${c.muted('<command> [account] [options]')}`);
  say();
  say(c.bold(c.bone('  Commands')));
  const rows: [string, string][] = [
    ['setup', 'Create the encrypted vault'],
    ['import <path>', 'Bring in maFiles from SDA v1 or the Steam app'],
    ['list', 'Show the accounts in your vault'],
    ['code [account]', 'Print the current Steam Guard code'],
    ['confirm [account]', 'Review trades and market listings'],
    ['login [account]', 'Sign in to Steam again'],
    ['export [account]', 'Write an maFile you can take elsewhere'],
    ['remove [account]', 'Drop an account from this vault'],
    ['serve', 'Run the local API and web interface'],
    ['verify', 'Check this install against its published checksums'],
  ];
  for (const [cmd, text] of rows) say(`    ${c.bone(cmd.padEnd(20))} ${c.muted(text)}`);

  say();
  say(c.bold(c.bone('  Options')));
  const opts: [string, string][] = [
    ['-w, --watch', 'Keep the code on screen as it rotates'],
    ['-c, --copy', 'Copy the code to your clipboard'],
    ['--accept --all', 'Accept every pending confirmation'],
    ['--deny --all', 'Deny every pending confirmation'],
    ['--vault <path>', 'Use a vault somewhere other than the default'],
    ['--json', 'Machine-readable output'],
  ];
  for (const [opt, text] of opts) say(`    ${c.bone(opt.padEnd(20))} ${c.muted(text)}`);

  say();
  say(`  ${c.muted('Vault:')} ${c.dim(defaultVaultPath())}`);
  say(`  ${c.muted('Docs and CS2 tools:')} ${c.dim(SITE)}`);
  say();
}

/* ------------------------------------------------------------------- main */

const COMMANDS: Record<string, (flags: Flags) => Promise<void> | void> = {
  setup: cmdSetup,
  import: cmdImport,
  list: cmdList,
  ls: cmdList,
  code: cmdCode,
  confirm: cmdConfirm,
  confirmations: cmdConfirm,
  login: cmdLogin,
  export: cmdExport,
  remove: cmdRemove,
  rm: cmdRemove,
  help: cmdHelp,
};

async function main(): Promise<void> {
  const flags = parseArgs(process.argv.slice(2));
  const command = flags._[0];

  if (flags['version'] || flags['v'] || command === 'version') {
    say(VERSION);
    return;
  }
  if (!command || flags['help'] || flags['h'] || command === 'help') {
    cmdHelp();
    return;
  }

  if (command === 'serve') {
    const { startServer } = await import('./serve.js');
    await startServer(flags);
    return;
  }
  if (command === 'verify') {
    const { verifyInstall } = await import('./verify.js');
    await verifyInstall();
    return;
  }

  const handler = COMMANDS[command];
  if (!handler) {
    fail(`No command called "${command}".`);
    say(`${c.muted('Run')} ${c.bone('sda help')} ${c.muted('to see what there is.')}`);
    process.exit(1);
  }
  await handler(flags);
}

main().catch((err: unknown) => {
  say();
  if (err instanceof SteamError) {
    fail(err.message);
    if (err.code === 'SESSION_EXPIRED') {
      say(`${c.muted('Fix it with')} ${c.bone('sda login')}`);
    }
  } else if (err instanceof Error) {
    fail(err.message);
  } else {
    fail(String(err));
  }
  process.exit(1);
});
