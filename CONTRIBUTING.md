# Contributing

Thanks for looking. This project holds people's Steam accounts, so a few of the rules
below are firmer than you might expect from a repository this young.

## Getting set up

```bash
git clone https://github.com/idroid007/SteamDesktopAuthenticatorV2
cd SteamDesktopAuthenticatorV2
npm install
npm run build
npm test
```

To run the desktop app while you work on it:

```bash
npm run desktop
```

To work on the interface without Electron in the way:

```bash
node packages/cli/dist/bin.js serve
```

## The rules that do not bend

**`@sda/core` takes no runtime dependencies.** Not one. The security pitch of this
project is that you can read the code that handles your secrets in an afternoon, and
every dependency added takes that away. CI fails the build if `dependencies` in
`packages/core/package.json` stops being empty. If something looks impossible without a
library, open an issue and let us work on it together.

**No telemetry, no analytics, no update pings that carry identity.** The app talks to
Steam. A patch that adds a call to anything else will be closed.

**Nothing writes a secret outside the vault.** No debug logging of shared secrets,
identity secrets or revocation codes, not even behind a flag. People paste logs into
issue threads.

**The API returns codes, never secrets.** Adding an endpoint that exposes
`shared_secret`, `identity_secret` or a revocation code breaks the promise the README
makes.

## Tests

`npm test` runs the core suite. Protocol code needs a test, and the interesting ones
already show the shape:

- Code generation is pinned against the RFC 4226 vectors, since Steam's algorithm is
  RFC 4226 with a different final encoding.
- Vault tests cover a flipped ciphertext bit, a forged auth tag and a weakened KDF header.
- maFile tests cover the SteamID precision trap that made two accounts overwrite each other.

Write a test that fails before your fix. That is the one that proves the fix works.

## Writing

User-facing text follows two rules. Say what happened and what the reader can do about
it. Avoid the tells of machine-written prose: no em dashes, no adverbs propping up a
weak sentence, no "Here's what" openers, no "not X, it's Y" contrasts.

Error messages get the same care as anything else. `Steam returned GeneralFailure` sent
people to a 22-comment issue thread. `Steam is rate limiting you. Wait a few minutes.`
tells them what to do.

## Style

TypeScript in strict mode, with `noUncheckedIndexedAccess` on. Comments explain why,
not what. When a piece of code exists to work around Steam's behaviour, say so in a
comment, because the next person will otherwise assume it is a mistake and remove it.

## Security reports

Do not open a public issue. See [SECURITY.md](SECURITY.md).

## Pull requests

One change per pull request. Describe what a user notices, and link the SDA v1 issue
number if you are fixing something inherited from there. The old tracker is a useful
backlog and we are working through it.
