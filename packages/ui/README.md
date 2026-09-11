# @sda/ui

The web interface for [Steam Desktop Authenticator V2](https://github.com/idroid007/SteamDesktopAuthenticatorV2).
Plain TypeScript and CSS, no framework.

Electron loads it on the desktop, and `sda serve` serves the same files to a browser,
so one design covers Windows, macOS, Linux, Android and iOS. Fonts ship with the
package, so the interface asks Google for nothing at runtime.

You will not install this on its own. It arrives with `@sda/cli`.

MIT
