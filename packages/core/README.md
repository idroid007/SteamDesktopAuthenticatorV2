# @sda/core

Steam Guard, as a library. Login codes, trade confirmations, authenticator linking and
an encrypted vault, with **zero runtime dependencies**.

```bash
npm install @sda/core
```

```ts
import { Account, parseMaFile } from '@sda/core';

const account = new Account(parseMaFile(await readFile('trader.maFile', 'utf8')));

const { code, expiresIn } = await account.code();
console.log(`${code}, good for ${expiresIn}s`);

for (const confirmation of await account.confirmations()) {
  console.log(confirmation.kind, confirmation.headline);
}
```

Most libraries in this space pull in a protobuf runtime to reach Steam's auth service.
Steam also accepts plain form-encoded fields and answers with JSON, which is what this
package does, so the dependency count stays at zero and the code you audit is the code
that runs.

Full reference: [packages/core/API.md](https://github.com/idroid007/SteamDesktopAuthenticatorV2/blob/main/packages/core/API.md)

Part of [Steam Desktop Authenticator V2](https://github.com/idroid007/SteamDesktopAuthenticatorV2).
Built by the people behind [nohax.club](https://nohax.club).

MIT
