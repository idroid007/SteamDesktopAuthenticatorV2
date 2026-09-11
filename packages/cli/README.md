# @sda/cli

Steam Guard codes and trade confirmations from your terminal. Runs on Windows, macOS,
Linux, and on Android under Termux.

```bash
npm install -g @sda/cli
```

```bash
sda setup                      # create the encrypted vault
sda import ~/SDA/maFiles       # bring accounts across from SDA v1
sda code                       # print the current code
sda code ishu_trades --watch   # live code with a countdown
sda confirm                    # review trades and market listings
sda confirm --accept --all     # clear the queue
sda serve                      # web interface and local API
sda verify                     # check this install against its checksums
```

`sda serve` binds to `127.0.0.1`, requires a bearer token, and serves an interface that
works at phone width. Add `--allow-lan` to reach it from another device on a network
you control.

The API hands out codes and never secrets. No endpoint returns your shared secret,
identity secret or revocation code.

Part of [Steam Desktop Authenticator V2](https://github.com/idroid007/SteamDesktopAuthenticatorV2).
Built by the people behind [nohax.club](https://nohax.club).

MIT
