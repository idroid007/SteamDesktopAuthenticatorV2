# Library reference

`@sda/core` carries the whole protocol with no runtime dependencies. The CLI, the web
interface and the desktop app are all built on it, and so is anything you write.

```bash
npm install @sda/core
```

## Account

The type you will use most. It wraps one Steam account and keeps the session alive.

```ts
import { Account, parseMaFile } from '@sda/core';

const stored = parseMaFile(await readFile('trader.maFile', 'utf8'));
const account = new Account(stored, {
  onSessionChange: (tokens) => save(tokens), // called when the token renews
});
```

| Member | Returns | Notes |
|---|---|---|
| `code()` | `{ code, expiresIn, generatedAt }` | Aligns to Steam's clock on first use |
| `codeSync()` | same | Uses the cached offset, never touches the network |
| `confirmations()` | `Confirmation[]` | Trades, market listings and the rest |
| `accept(confirmation)` | `void` | |
| `deny(confirmation)` | `void` | |
| `respondAll(list, decision)` | `void` | One request for the batch |
| `ensureSession()` | `SessionTokens` | Renews the access token when it is near expiry |
| `canConfirm` | `boolean` | False when the maFile carried no identity secret |
| `hasSession` | `boolean` | |
| `label`, `accountName`, `steamId`, `revocationCode` | `string` | |

## Codes

```ts
import { generateCodeForTime, secondsRemaining, steamTime } from '@sda/core';

const now = await steamTime.now();          // corrected against Steam
generateCodeForTime(sharedSecret, now);     // "7K4MB"
secondsRemaining(now);                      // 21
```

`steamTime` asks Steam for its clock once, keeps the offset, and refreshes hourly. Wrong
local clocks are the usual reason a code gets rejected, so use this rather than
`Date.now()`.

## Confirmations

```ts
import { fetchConfirmations, respondToConfirmations } from '@sda/core';

const ctx = { secrets, accessToken, now: () => steamTime.now() };

const pending = await fetchConfirmations(ctx);
const markets = pending.filter((c) => c.kind === 'market');
await respondToConfirmations(ctx, markets, 'accept');
```

A `Confirmation` carries `id`, `nonce`, `kind`, `creatorId`, `headline`, `summary[]`,
`when` and `createdAt`. `kind` is one of `trade`, `market`, `generic`,
`phone-number-change`, `account-recovery`, `api-key`, `feature-opt-out` or `unknown`.

For a trade, `creatorId` is the trade offer ID. Steam's own field names leak through
here on purpose, so anything you already wrote against the mobile endpoints still lines up.

## Signing in

```ts
import { beginLogin, submitGuardCode, waitForLogin } from '@sda/core';

const pending = await beginLogin(accountName, password);

if (pending.guard.kind === 'device-code') {
  const { code } = await account.code();
  await submitGuardCode(pending, code);
}

const tokens = await waitForLogin(pending);
```

`pending.guard.kind` is `none`, `device-code`, `email-code`, `device-confirmation` or
`email-confirmation`. The password is encrypted with an RSA key Steam issues for that
attempt, so it never crosses the wire in the clear.

Access tokens last about a day. `refreshAccessToken(tokens)` trades the refresh token for
a new one, and `needsRefresh(tokens)` tells you when to bother.

## Linking and unlinking

```ts
import { startLink, finalizeLink, removeAuthenticator } from '@sda/core';

const link = await startLink(session);
console.log('WRITE THIS DOWN:', link.secrets.revocationCode);

await finalizeLink(session, link.secrets, smsCode, () => steamTime.now());
```

Steam returns the secrets before the authenticator is active. Save the revocation code
before calling `finalizeLink`, because Steam will not show it again.

`removeAuthenticator(session, revocationCode, scheme)` unlinks. Scheme `1` puts the
account back on emailed codes and `2` turns Steam Guard off.

## The vault

```ts
import { readVault, writeVault, defaultVaultPath } from '@sda/core';

const vault = await readVault(passphrase);
vault.accounts.push(stored);
await writeVault(vault, passphrase);
```

Writes go to a temporary file and get renamed over the old one, so a crash mid-write
leaves the previous vault intact. On anything other than Windows the file is chmod 600.

`encryptVault` and `decryptVault` are exported if you want the primitives on their own.
A wrong passphrase raises `WrongPassphraseError`, and so does a file somebody edited,
because GCM cannot tell those apart and neither should we.

## maFiles

```ts
import { parseMaFile, inspectImport, toMaFile } from '@sda/core';

const account = parseMaFile(text, 'trader.maFile');
for (const note of inspectImport(account)) console.warn(note);

await writeFile('out.maFile', toMaFile(account));
```

`parseMaFile` reads what SDA v1, the Android app and the tools around them write,
including the several spellings of the session block. It recovers the SteamID from the
raw text rather than the parsed object, because a SteamID64 is larger than
`Number.MAX_SAFE_INTEGER` and `JSON.parse` quietly rounds it. Two accounts whose IDs
differ in the last digits would otherwise collapse into one.

`toMaFile` writes a file SDA v1 and steamguard-cli both read. Leaving should be as easy
as arriving.

## Errors

Everything protocol-shaped throws `SteamError`, which carries a `code`:

| `code` | Meaning |
|---|---|
| `SESSION_EXPIRED` | Sign in again |
| `NO_SESSION` | This account has no tokens stored |
| `NO_IDENTITY_SECRET` | Codes work, confirmations do not |
| `NO_DEVICE_ID` | Steam will refuse confirmations |
| `LOGIN_REJECTED` | Steam did not accept the name or password |
| `CLOCK_SKEW` | The machine's clock is too far off |
| `NETWORK` | The request never reached Steam |
| `ERESULT` | Steam answered with an error; see `eresult` |

The messages are written for people, so showing `err.message` in your own interface is fine.
