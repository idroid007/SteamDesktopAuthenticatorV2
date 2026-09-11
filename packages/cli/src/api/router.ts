import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  beginLogin,
  finalizeLink,
  inspectImport,
  parseMaFile,
  pollLoginOnce,
  removeAuthenticator,
  startLink,
  steamTime,
  submitGuardCode,
  toMaFile,
  SteamError,
  type Account,
  type Confirmation,
} from '@sda/core';
import type { Session } from './session.js';

/* -------------------------------------------------------------- helpers */

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  });
  res.end(payload);
}

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    // maFile imports are the largest thing this accepts, and they are tiny.
    if (size > 2 * 1024 * 1024) throw new Error('Request body too large.');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('Body is not valid JSON.');
  }
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');

const VERSION = '2.0.0-alpha.1';

/**
 * A read-only view of an account.
 *
 * The shared secret, the identity secret and the revocation code never cross
 * this boundary. Somebody holding your API token can ask for codes. They
 * cannot walk off with the authenticator.
 */
function publicAccount(account: Account) {
  return {
    id: account.steamId,
    label: account.label,
    accountName: account.accountName,
    canConfirm: account.canConfirm,
    signedIn: account.hasSession,
    hasRevocationCode: account.revocationCode.length > 0,
  };
}

/* --------------------------------------------------------------- router */

export async function route(
  req: IncomingMessage,
  res: ServerResponse,
  session: Session,
  url: URL,
): Promise<void> {
  const segments = url.pathname.split('/').filter(Boolean).slice(1);
  const method = req.method ?? 'GET';
  const head = segments[0];

  /* ---------------- works while locked ---------------- */

  if (head === 'state' && method === 'GET') {
    if (session.idleExpired) session.lock();
    return json(res, 200, {
      version: VERSION,
      vaultExists: await session.vaultFileExists(),
      locked: session.locked,
      vault: session.vaultPath,
      exposedToNetwork: session.exposedToNetwork,
      accounts: session.locked ? 0 : session.vault.contents.accounts.length,
    });
  }

  /** Creates the vault on first run, so nobody needs a terminal to start. */
  if (head === 'setup' && method === 'POST') {
    const body = await readBody(req);
    await session.createVault(str(body['passphrase']));
    return json(res, 200, { locked: false, created: true });
  }

  if (head === 'unlock' && method === 'POST') {
    const wait = session.cooldownMs;
    if (wait > 0) {
      return json(res, 429, { error: `Too many attempts. Wait ${Math.ceil(wait / 1000)} seconds.` });
    }
    const body = await readBody(req);
    try {
      await session.unlock(str(body['passphrase']));
      return json(res, 200, { locked: false });
    } catch (err) {
      session.noteFailure();
      if (err instanceof Error && err.name === 'WrongPassphraseError') {
        return json(res, 401, { error: 'That passphrase does not open this vault.' });
      }
      throw err;
    }
  }

  if (head === 'lock' && method === 'POST') {
    session.lock();
    return json(res, 200, { locked: true });
  }

  if (head === 'time' && method === 'GET') {
    return json(res, 200, { offset: steamTime.offset, now: steamTime.nowSync() });
  }

  /* ---------------- everything below needs the vault open ---------------- */

  if (head === 'settings') {
    if (method === 'GET') return json(res, 200, { settings: session.settings });
    if (method === 'PUT') {
      const body = await readBody(req);
      const incoming = (body['settings'] ?? {}) as Record<string, unknown>;
      const current = session.vault.contents.settings;

      session.vault.contents.settings = {
        ...current,
        ...incoming,
        autoConfirm: {
          ...current.autoConfirm,
          ...((incoming['autoConfirm'] ?? {}) as Record<string, unknown>),
        },
      } as typeof current;

      await session.vault.save();
      return json(res, 200, { settings: session.vault.contents.settings });
    }
  }

  if (head === 'accounts' && segments.length === 1 && method === 'GET') {
    return json(res, 200, { accounts: session.vault.accounts().map(publicAccount) });
  }

  /** Import maFiles. The browser reads the files; we only see their contents. */
  if (head === 'accounts' && segments[1] === 'import' && method === 'POST') {
    const body = await readBody(req);
    const files = Array.isArray(body['files'])
      ? (body['files'] as { name?: string; content?: string }[])
      : [];
    if (files.length === 0) return json(res, 400, { error: 'No files were sent.' });

    const imported: { name: string; account: string; notes: string[] }[] = [];
    const failed: { name: string; error: string }[] = [];

    for (const file of files) {
      const name = str(file.name) || 'maFile';
      try {
        const account = parseMaFile(str(file.content), name);
        const existing = session.vault.contents.accounts.findIndex(
          (a) => a.secrets.steamId === account.secrets.steamId,
        );
        if (existing >= 0) session.vault.contents.accounts[existing] = account;
        else session.vault.contents.accounts.push(account);

        imported.push({
          name,
          account: account.secrets.accountName,
          notes: inspectImport(account),
        });
      } catch (err) {
        failed.push({ name, error: err instanceof Error ? err.message : String(err) });
      }
    }

    if (imported.length > 0) await session.vault.save();
    return json(res, 200, { imported, failed });
  }

  /* ---------------- linking a brand new authenticator ---------------- */

  if (head === 'link') {
    // The revocation code comes back once at the end, so this flow stays on
    // the machine running the app.
    session.requireLoopback('Adding an authenticator');

    if (segments[1] === 'login' && method === 'POST') {
      const body = await readBody(req);
      const accountName = str(body['accountName']);
      const password = str(body['password']);
      if (!accountName || !password) {
        return json(res, 400, { error: 'Give an account name and a password.' });
      }

      const pending = await beginLogin(accountName, password);
      if (pending.guard.kind === 'none') {
        const result = await pollLoginOnce(pending);
        if (result.tokens) {
          const id = session.rememberPending({
            pending,
            accountName,
            forLinking: true,
            tokens: result.tokens,
          });
          return json(res, 200, { pendingId: id, ready: true });
        }
      }

      const id = session.rememberPending({ pending, accountName, forLinking: true });
      return json(res, 200, {
        pendingId: id,
        ready: false,
        guard: pending.guard.kind,
        sentTo: 'sentTo' in pending.guard ? pending.guard.sentTo : undefined,
      });
    }

    if (segments[1] === 'guard' && method === 'POST') {
      const body = await readBody(req);
      const auth = session.takePending(str(body['pendingId']));
      const kind = auth.pending.guard.kind === 'email-code' ? 'email' : 'device';
      await submitGuardCode(auth.pending, str(body['code']), kind);

      const result = await pollLoginOnce(auth.pending);
      if (!result.tokens) {
        return json(res, 200, { ready: false, error: 'Steam has not confirmed that yet.' });
      }
      auth.tokens = result.tokens;
      return json(res, 200, { ready: true });
    }

    if (segments[1] === 'begin' && method === 'POST') {
      const body = await readBody(req);
      const auth = session.takePending(str(body['pendingId']));
      if (!auth.tokens) return json(res, 400, { error: 'Sign in first.' });

      const link = await startLink(auth.tokens);
      session.linkDraft = { secrets: link.secrets, session: auth.tokens };

      return json(res, 200, {
        phoneHint: link.phoneNumberHint ?? null,
        // Shown once, written down by the user, then never sent again.
        revocationCode: link.secrets.revocationCode,
      });
    }

    if (segments[1] === 'finalize' && method === 'POST') {
      const body = await readBody(req);
      const draft = session.linkDraft;
      if (!draft) return json(res, 400, { error: 'No authenticator is being added.' });

      await finalizeLink(draft.session, draft.secrets, str(body['smsCode']), () => steamTime.now());

      session.vault.contents.accounts.push({
        secrets: draft.secrets,
        session: draft.session,
        fullyEnrolled: true,
        addedAt: new Date().toISOString(),
      });
      await session.vault.save();
      session.linkDraft = undefined;

      return json(res, 200, { added: draft.secrets.accountName, steamId: draft.secrets.steamId });
    }
  }

  /* ---------------- per-account ---------------- */

  if (head === 'accounts' && segments[1]) {
    const accounts = session.vault.accounts();
    const account = accounts.find((a) => a.steamId === segments[1] || a.accountName === segments[1]);
    if (!account) return json(res, 404, { error: 'No account with that id.' });

    const tail = segments[2];

    if (!tail && method === 'PATCH') {
      const body = await readBody(req);
      const label = str(body['label']).trim();
      const stored = session.vault.contents.accounts.find(
        (a) => a.secrets.steamId === account.steamId,
      );
      if (stored) {
        if (label) stored.label = label;
        else delete stored.label;
        await session.vault.save();
      }
      return json(res, 200, { ok: true });
    }

    if (!tail && method === 'DELETE') {
      session.vault.contents.accounts = session.vault.contents.accounts.filter(
        (a) => a.secrets.steamId !== account.steamId,
      );
      await session.vault.save();
      return json(res, 200, { removed: account.steamId });
    }

    if (tail === 'code' && method === 'GET') {
      const { code, expiresIn, generatedAt } = await account.code();
      return json(res, 200, { code, expiresIn, generatedAt });
    }

    if (tail === 'login' && method === 'POST') {
      const body = await readBody(req);
      const password = str(body['password']);
      if (!password) return json(res, 400, { error: 'A password is needed.' });

      const pending = await beginLogin(account.accountName, password);

      // We hold this account's authenticator, so answer Steam's own prompt.
      if (pending.guard.kind === 'device-code') {
        const { code } = await account.code();
        await submitGuardCode(pending, code);
      }

      if (pending.guard.kind === 'email-code' || pending.guard.kind === 'email-confirmation') {
        const id = session.rememberPending({ pending, accountName: account.accountName });
        return json(res, 200, {
          ready: false,
          pendingId: id,
          guard: pending.guard.kind,
          sentTo: 'sentTo' in pending.guard ? pending.guard.sentTo : undefined,
        });
      }

      const result = await pollLoginOnce(pending);
      if (!result.tokens) {
        const id = session.rememberPending({ pending, accountName: account.accountName });
        return json(res, 200, { ready: false, pendingId: id, guard: pending.guard.kind });
      }

      account.setSession(result.tokens);
      await session.vault.save();
      return json(res, 200, { ready: true });
    }

    if (tail === 'confirmations') {
      if (method === 'GET' && segments.length === 3) {
        return json(res, 200, { confirmations: await account.confirmations() });
      }
      if (method === 'POST' && segments[3] === 'batch') {
        const body = await readBody(req);
        const decision = body['decision'] === 'deny' ? 'deny' : 'accept';
        const ids = Array.isArray(body['ids']) ? (body['ids'] as string[]) : undefined;
        const pending = await account.confirmations();
        const chosen = ids?.length ? pending.filter((c) => ids.includes(c.id)) : pending;
        await account.respondAll(chosen, decision);
        return json(res, 200, { answered: chosen.length, decision });
      }
      if (method === 'POST' && segments[3]) {
        const body = await readBody(req);
        const decision = body['decision'] === 'deny' ? 'deny' : 'accept';
        const pending = await account.confirmations();
        const target = pending.find((c) => c.id === segments[3]);
        if (!target) return json(res, 404, { error: 'That confirmation is already gone.' });
        if (decision === 'accept') await account.accept(target);
        else await account.deny(target);
        return json(res, 200, { id: target.id, decision });
      }
    }

    if (tail === 'autoconfirm' && method === 'POST') {
      const outcome = await session.runAutoConfirm(account);
      return json(res, 200, {
        accepted: outcome.accepted,
        held: outcome.held,
        remaining: session.ceilingFor(account.steamId).remaining,
        reasons: outcome.decisions
          .filter((d) => d.action === 'hold')
          .map((d) => ({ id: d.confirmation.id, reason: d.reason })),
      });
    }

    // Both of these hand over a secret, so they never leave this machine.
    if (tail === 'export' && method === 'GET') {
      session.requireLoopback('Exporting an maFile');
      return json(res, 200, {
        filename: `${account.accountName}.maFile`,
        content: toMaFile(account.toJSON()),
      });
    }

    if (tail === 'revocation' && method === 'GET') {
      session.requireLoopback('Showing a revocation code');
      if (!account.revocationCode) {
        return json(res, 404, { error: 'This account has no revocation code saved.' });
      }
      return json(res, 200, { revocationCode: account.revocationCode });
    }

    /** Removes the authenticator from Steam itself, not only from this vault. */
    if (tail === 'unlink' && method === 'POST') {
      session.requireLoopback('Removing an authenticator');
      const body = await readBody(req);
      const scheme = body['scheme'] === 2 ? 2 : 1;
      const tokens = await account.ensureSession();
      await removeAuthenticator(tokens, account.revocationCode, scheme);

      session.vault.contents.accounts = session.vault.contents.accounts.filter(
        (a) => a.secrets.steamId !== account.steamId,
      );
      await session.vault.save();
      return json(res, 200, { unlinked: account.steamId, scheme });
    }
  }

  if (head === 'events' && method === 'GET') {
    return streamEvents(req, res, session);
  }

  return json(res, 404, { error: 'No such endpoint.' });
}

/* --------------------------------------------------------------- events */

/** Server-sent events, so a page or a bot learns about new confirmations. */
function streamEvents(req: IncomingMessage, res: ServerResponse, session: Session): void {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
  });

  const seen = new Set<string>();
  let stopped = false;

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };

  const tick = async () => {
    if (stopped || session.locked) return;
    for (const account of session.vault.accounts()) {
      if (!account.canConfirm || !account.hasSession) continue;
      try {
        const auto = await session.runAutoConfirm(account);
        if (auto.accepted > 0) {
          send('auto-confirmed', { account: account.steamId, count: auto.accepted });
        }

        const pending: Confirmation[] = await account.confirmations();
        for (const confirmation of pending) {
          const key = `${account.steamId}:${confirmation.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          send('confirmation', {
            account: account.steamId,
            label: account.label,
            confirmation,
          });
        }
      } catch (err) {
        // A dead session on one account should not kill the stream.
        if (err instanceof SteamError && err.code === 'SESSION_EXPIRED') {
          send('signed-out', { account: account.steamId, label: account.label });
        }
      }
    }
    send('ping', Date.now());
  };

  void tick();
  const interval = Math.max(10, session.locked ? 30 : session.settings.checkIntervalSeconds);
  const timer = setInterval(() => void tick(), interval * 1000);

  req.on('close', () => {
    stopped = true;
    clearInterval(timer);
  });
}
