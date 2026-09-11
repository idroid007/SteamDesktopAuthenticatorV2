import type { SteamTimeSource } from './types.js';

const QUERY_TIME_URL = 'https://api.steampowered.com/ITwoFactorService/QueryTime/v1/';
/** Re-check drift after this long. Steam's own client probes roughly hourly. */
const REALIGN_AFTER_MS = 60 * 60 * 1000;

/**
 * Steam rejects codes generated against a clock that has drifted, which is the
 * cause of a long tail of "my codes don't work" reports. We ask Steam for its
 * own clock once, keep the offset, and apply it to every code after that.
 */
export class SteamTime implements SteamTimeSource {
  private offsetSeconds = 0;
  private alignedAt = 0;
  private inFlight: Promise<void> | null = null;

  /** Drift between this machine and Steam, in seconds. */
  get offset(): number {
    return this.offsetSeconds;
  }

  get isAligned(): boolean {
    return this.alignedAt > 0;
  }

  async now(): Promise<number> {
    if (!this.isAligned || Date.now() - this.alignedAt > REALIGN_AFTER_MS) {
      await this.align();
    }
    return Math.floor(Date.now() / 1000) + this.offsetSeconds;
  }

  /** Local clock plus the last known offset. Never touches the network. */
  nowSync(): number {
    return Math.floor(Date.now() / 1000) + this.offsetSeconds;
  }

  async align(): Promise<void> {
    this.inFlight ??= this.doAlign().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  private async doAlign(): Promise<void> {
    const before = Math.floor(Date.now() / 1000);
    try {
      const res = await fetch(QUERY_TIME_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: 'steamid=0',
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return;
      const body = (await res.json()) as { response?: { server_time?: string } };
      const serverTime = Number(body.response?.server_time);
      if (!Number.isFinite(serverTime)) return;
      this.offsetSeconds = serverTime - before;
      this.alignedAt = Date.now();
    } catch {
      // Offline, or Steam is down. Fall back to the local clock and try later.
    }
  }
}

/** Shared instance. One clock probe serves every account in the app. */
export const steamTime = new SteamTime();
