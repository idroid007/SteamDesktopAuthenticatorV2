# Security

## Reporting a vulnerability

Use [GitHub's private advisory form](https://github.com/idroid007/SteamDesktopAuthenticatorV2/security/advisories/new).
Please do not open a public issue for anything that puts accounts at risk.

Expect a first reply within 72 hours. If a fix needs coordination, we will agree a
disclosure date with you rather than sit on the report.

## What this software is, and what it is not

This puts your Steam authenticator on a general-purpose computer. Malware running as
your user can read what your user can read. That applies to SDA v1, to steamguard-cli,
to password managers holding Steam secrets, and to this.

Steam's own mobile app keeps the secret on a separate device with a smaller attack
surface. For an account you cannot afford to lose, it remains the safer choice. We
would rather say that plainly than sell you something.

Use this when you have a reason to: you run trading bots, you manage several accounts,
you have no usable phone, or you need confirmations in a script.

## Threat model

### Handled

| Threat | How |
|---|---|
| Someone steals the vault file | scrypt (N=2^17, r=8, p=1) then AES-256-GCM. A guess costs ~134 MB of memory, which takes most of the advantage away from GPUs |
| Someone edits the vault file | GCM authenticates the ciphertext, and the KDF header is bound in as additional data, so nobody can weaken the parameters and still open it |
| A wrong passphrase leaks information | Every failure returns one message. The decrypt path does not distinguish a bad key from a damaged file |
| A malicious dependency | The core has no runtime dependencies. The CLI depends only on the other packages in this repo |
| A tampered release | CI builds every release with npm provenance and publishes SHA256SUMS. `sda verify` checks your copy |
| API token theft | The API exposes codes, never secrets. Rotating the token cuts the attacker off. Your authenticator stays yours |
| A stale Steam session | Access tokens renew in the background against the refresh token, so an expired session does not become a login loop |
| Clock drift | Codes are generated against Steam's own clock, queried at startup and refreshed hourly |
| Path traversal through the web interface | Resolved paths are checked against the UI root before any file is read |
| Passphrase guessing over the network | Unlock attempts back off after three failures |

### Not handled

| Threat | Why |
|---|---|
| Malware running as your user | It can read the vault once you unlock it, log your keystrokes, or read process memory. No user-space program solves this |
| A compromised machine at setup time | If something is already resident when you import your maFiles, it sees them |
| Someone with your unlocked session | Lock the vault when you step away. The app does not lock itself on idle yet |
| Plain HTTP over your LAN | `--allow-lan` serves unencrypted traffic. Anyone sniffing that network sees the token and the codes. Use it on a network you control |
| Steam's own account recovery | Somebody who takes over your email can remove the authenticator through Steam support, whatever this app does |

## Cryptography

| Purpose | Choice |
|---|---|
| Key derivation | scrypt, N=2^17, r=8, p=1, 32-byte random salt |
| Vault encryption | AES-256-GCM, 12-byte random IV, header bound as AAD |
| Login codes | HMAC-SHA1 with RFC 4226 truncation, encoded in Steam's 26-character alphabet |
| Confirmation signing | HMAC-SHA1 over the timestamp and operation tag |
| Password in transit | RSA PKCS#1 v1.5 under a key Steam issues per login attempt |

HMAC-SHA1 appears twice because Steam requires it. We cannot change that half of the
protocol without Steam changing it first. Everything we do control uses something current.

### What changed from SDA v1

SDA v1 derived keys with PBKDF2-SHA1 at 50,000 iterations and encrypted with
AES-256-CBC and no MAC. Two problems follow. A GPU works through PBKDF2-SHA1 quickly,
and unauthenticated CBC lets an attacker alter your vault without detection, with
padding behaviour leaking whether a guess landed close.

scrypt costs memory as well as time. GCM refuses to decrypt anything that was altered.

## Verifying a release

```bash
sda verify              # compare this install against its published checksums
```

Every desktop download has a matching `SHA256SUMS` file on the release. Once the
packages reach npm, `npm audit signatures` will confirm that npm served what our
CI built.

Every release links to the commit and the workflow run that produced it. If a copy of
this software came from anywhere other than
[our repository](https://github.com/idroid007/SteamDesktopAuthenticatorV2) or npm,
check it before you put a Steam secret into it.

## Backups

Copy your vault somewhere safe, and write your revocation codes down somewhere that is
not this computer. Losing both means losing the account, and no one at Steam or here
can undo that for you.
