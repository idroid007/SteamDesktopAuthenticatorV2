import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { networkInterfaces } from 'node:os';
import { dirname, extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultVaultPath, SteamError, steamTime } from '@sda/core';
import { json, route } from './api/router.js';
import { Session } from './api/session.js';
import { c, fail, ok, say, warn } from './term.js';

interface Flags {
  _: string[];
  [key: string]: string | boolean | string[];
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

const CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; " +
  "font-src 'self'; " +
  'img-src ' +
  "'self' data: https://community.cloudflare.steamstatic.com https://avatars.steamstatic.com " +
  'https://steamcommunity-a.akamaihd.net https://community.akamai.steamstatic.com; ' +
  "connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

function tokensMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface ApiServerOptions {
  /** 0 picks a free port, which is what the desktop app wants. */
  port?: number;
  allowLan?: boolean;
  vaultPath?: string;
  token?: string;
  /** Unlock at startup instead of showing the lock screen. */
  passphrase?: string;
}

export interface RunningServer {
  url: string;
  token: string;
  port: number;
  vaultPath: string;
  locked: boolean;
  close(): Promise<void>;
}

/**
 * Starts the API and web interface.
 *
 * The desktop app and the `sda serve` command both come through here, so the
 * two can never drift apart in what they expose or how they guard it.
 */
export async function startApiServer(options: ApiServerOptions = {}): Promise<RunningServer> {
  const vaultPath = options.vaultPath ?? defaultVaultPath();
  const allowLan = Boolean(options.allowLan);
  const host = allowLan ? '0.0.0.0' : '127.0.0.1';

  // A missing vault is not an error. Someone who just installed the app has no
  // vault yet, and the interface walks them through making one.
  const session = new Session(vaultPath, allowLan);
  await steamTime.align();

  const passphrase = options.passphrase ?? process.env['SDA_PASSPHRASE'];
  if (passphrase && (await session.vaultFileExists())) {
    await session.unlock(passphrase);
  }

  const token = options.token ?? randomBytes(24).toString('base64url');
  const uiRoot = findUiRoot();

  const server = createServer((req, res) => {
    handle(req, res, session, token, uiRoot).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      const status =
        err instanceof SteamError
          ? err.code === 'LOCKED'
            ? 423
            : err.code === 'SESSION_EXPIRED'
              ? 401
              : err.code === 'LOOPBACK_ONLY'
                ? 403
                : 500
          : 500;
      if (!res.headersSent) json(res, status, { error: message });
      else res.end();
    });
  });

  await new Promise<void>((resolve_, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 7749, host, resolve_);
  });

  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : (options.port ?? 7749);
  const shown = allowLan ? localAddress() : '127.0.0.1';

  return {
    url: `http://${shown}:${port}`,
    token,
    port,
    vaultPath,
    locked: session.locked,
    close: () =>
      new Promise<void>((resolve_) => {
        session.lock();
        server.close(() => resolve_());
      }),
  };
}

export async function startServer(flags: Flags): Promise<void> {
  const allowLan = Boolean(flags['allow-lan']);

  let running: RunningServer;
  try {
    running = await startApiServer({
      port: Number(flags['port'] ?? 7749),
      allowLan,
      ...(typeof flags['vault'] === 'string' ? { vaultPath: flags['vault'] } : {}),
      ...(typeof flags['token'] === 'string' ? { token: flags['token'] } : {}),
    });
  } catch (err) {
    fail(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  say();
  say(
    `  ${c.red('▰▰')} ${c.bold(c.bone('Steam Desktop Authenticator'))} ${c.muted('web interface and API')}`,
  );
  say();
  say(`  ${c.muted('Open')}   ${c.bone(`${running.url}/?token=${running.token}`)}`);
  say(`  ${c.muted('Token')}  ${c.dim(running.token)}`);
  say(
    `  ${c.muted('Vault')}  ${c.dim(running.vaultPath)} ${running.locked ? c.amber('locked') : c.dim('unlocked')}`,
  );
  say();
  if (allowLan) {
    warn('Bound to every interface. Anyone on this network who has the token can read your codes.');
    say(c.muted('  Exports and revocation codes stay switched off while this flag is on.'));
    say();
  }
  say(c.muted('  Press ctrl-c to stop.'));
  say();

  process.on('SIGINT', () => {
    void running.close().then(() => {
      say();
      ok('Stopped. Your secrets were never written anywhere but your own vault.');
      process.exit(0);
    });
  });
}

/**
 * Finds the built web interface.
 *
 * It ships as its own package, so ask Node where that package lives rather than
 * guessing at a relative path that changes between a repo checkout, a global
 * npm install and a packaged desktop app.
 */
function findUiRoot(): string {
  try {
    const require = createRequire(import.meta.url);
    return resolve(dirname(require.resolve('@sda/ui/package.json')), 'dist');
  } catch {
    return resolve(fileURLToPath(new URL('../../ui/dist', import.meta.url)));
  }
}

function localAddress(): string {
  // Best-effort display address. The server still binds every interface.
  for (const iface of Object.values(networkInterfaces())) {
    for (const net of iface ?? []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  token: string,
  uiRoot: string,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');

  if (!url.pathname.startsWith('/v1/')) {
    return serveUi(res, uiRoot, url.pathname);
  }

  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ')
    ? header.slice(7)
    : (url.searchParams.get('token') ?? '');
  if (!tokensMatch(provided, token)) {
    return json(res, 401, { error: 'Bad or missing API token.' });
  }

  return route(req, res, session, url);
}

async function serveUi(res: ServerResponse, uiRoot: string, path: string): Promise<void> {
  const relative = path === '/' ? 'index.html' : normalize(path).replace(/^(\.\.[/\\])+/, '');
  const file = join(uiRoot, relative);

  // Refuse anything that climbed out of the UI folder.
  if (!file.startsWith(uiRoot)) {
    return json(res, 403, { error: 'No.' });
  }

  try {
    const body = await readFile(file);
    const type = MIME[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': body.length,
      // Fonts are content-addressed by build; everything else stays fresh.
      'cache-control': extname(file) === '.woff2' ? 'public, max-age=604800' : 'no-store',
      'x-content-type-options': 'nosniff',
      'content-security-policy': CSP,
    });
    res.end(body);
  } catch {
    if (path === '/' || !extname(path)) {
      return json(res, 404, {
        error: 'The web interface is not built. Run `npm run build` from the repo root.',
      });
    }
    return json(res, 404, { error: 'Not found.' });
  }
}
