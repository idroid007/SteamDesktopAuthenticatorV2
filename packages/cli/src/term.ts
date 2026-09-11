import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

const useColor =
  stdout.isTTY && process.env['NO_COLOR'] === undefined && process.env['TERM'] !== 'dumb';

function wrap(open: string, close: string) {
  return (text: string) => (useColor ? `[${open}m${text}[${close}m` : text);
}

/** Palette borrowed from nohax.club so the terminal matches the app. */
export const c = {
  bold: wrap('1', '22'),
  dim: wrap('2', '22'),
  red: wrap('38;2;220;40;40', '39'),
  bone: wrap('38;2;237;234;228', '39'),
  muted: wrap('38;2;142;139;134', '39'),
  green: wrap('38;2;0;187;127', '39'),
  amber: wrap('38;2;249;156;0', '39'),
  cyan: wrap('38;2;0;183;215', '39'),
  underline: wrap('4', '24'),
};

export function say(message = ''): void {
  stdout.write(`${message}\n`);
}

export function ok(message: string): void {
  say(`${c.green('✓')} ${message}`);
}

export function warn(message: string): void {
  say(`${c.amber('!')} ${message}`);
}

export function fail(message: string): void {
  process.stderr.write(`${c.red('✗')} ${message}\n`);
}

export function heading(title: string): void {
  say();
  say(c.bold(c.bone(title)));
  say(c.dim('─'.repeat(Math.min(title.length + 8, 56))));
}

export async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(`${c.muted('?')} ${question} `)).trim();
  } finally {
    rl.close();
  }
}

/**
 * Reads a passphrase without echoing it.
 *
 * Terminals that cannot hide input get told so, rather than quietly printing
 * a vault passphrase into scrollback where it stays.
 */
export async function askSecret(question: string): Promise<string> {
  if (!stdin.isTTY) {
    throw new Error('A passphrase is needed, but this terminal cannot hide typing.');
  }

  stdout.write(`${c.muted('?')} ${question} `);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  return new Promise((resolve, reject) => {
    let value = '';
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        switch (ch) {
          case '': // ctrl-c
            cleanup();
            stdout.write('\n');
            reject(new Error('Cancelled.'));
            return;
          case '\r':
          case '\n':
            cleanup();
            stdout.write('\n');
            resolve(value);
            return;
          case '': // backspace
          case '\b':
            if (value.length > 0) {
              value = value.slice(0, -1);
              stdout.write('\b \b');
            }
            break;
          default:
            if (ch >= ' ') {
              value += ch;
              stdout.write(c.dim('•'));
            }
        }
      }
    };
    const cleanup = () => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
    };
    stdin.on('data', onData);
  });
}

export async function confirm(question: string, fallback = false): Promise<boolean> {
  const hint = fallback ? 'Y/n' : 'y/N';
  const answer = (await ask(`${question} ${c.dim(`[${hint}]`)}`)).toLowerCase();
  if (answer === '') return fallback;
  return answer === 'y' || answer === 'yes';
}

/** Copies text to the clipboard using whatever the OS provides. */
export async function copyToClipboard(text: string): Promise<boolean> {
  const { spawn } = await import('node:child_process');
  const candidates: [string, string[]][] =
    process.platform === 'win32'
      ? [['clip', []]]
      : process.platform === 'darwin'
        ? [['pbcopy', []]]
        : [
            ['wl-copy', []],
            ['xclip', ['-selection', 'clipboard']],
            ['xsel', ['--clipboard', '--input']],
          ];

  for (const [cmd, args] of candidates) {
    const done = await new Promise<boolean>((resolve) => {
      try {
        const child = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'ignore'] });
        child.on('error', () => resolve(false));
        child.on('close', (code) => resolve(code === 0));
        child.stdin.end(text);
      } catch {
        resolve(false);
      }
    });
    if (done) return true;
  }
  return false;
}

/** A 30 second countdown bar for the live code view. */
export function progressBar(remaining: number, total = 30, width = 24): string {
  const filled = Math.max(0, Math.min(width, Math.round((remaining / total) * width)));
  const colour = remaining <= 5 ? c.red : remaining <= 10 ? c.amber : c.green;
  return `${colour('█'.repeat(filled))}${c.dim('░'.repeat(width - filled))}`;
}
