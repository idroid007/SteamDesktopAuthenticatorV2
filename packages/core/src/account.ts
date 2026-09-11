import {
  fetchConfirmations,
  respondToConfirmation,
  respondToConfirmations,
} from './confirmation.js';
import { needsRefresh, refreshAccessToken } from './steam/auth.js';
import { steamTime } from './time.js';
import { generateCodeForTime, secondsRemaining } from './totp.js';
import { SteamError } from './types.js';
import type { Confirmation, SessionTokens, StoredAccount } from './types.js';

export interface CodeResult {
  code: string;
  /** Seconds before this code rotates. */
  expiresIn: number;
  /** Steam-corrected timestamp the code was built from. */
  generatedAt: number;
}

/**
 * One Steam account, with the session handling taken care of.
 *
 * SDA v1 left users staring at "Login again" whenever an access token aged out,
 * which drove a long run of issue reports. This class renews the token in the
 * background and only surfaces a problem when the refresh token itself dies.
 */
export class Account {
  #session: SessionTokens | undefined;
  #onSessionChange: ((tokens: SessionTokens) => void) | undefined;

  constructor(
    private readonly stored: StoredAccount,
    options: { onSessionChange?: (tokens: SessionTokens) => void } = {},
  ) {
    this.#session = stored.session;
    this.#onSessionChange = options.onSessionChange;
  }

  get accountName(): string {
    return this.stored.secrets.accountName;
  }

  get label(): string {
    return this.stored.label ?? this.stored.secrets.accountName;
  }

  get steamId(): string {
    return this.stored.secrets.steamId;
  }

  get revocationCode(): string {
    return this.stored.secrets.revocationCode;
  }

  /** False when the maFile carried no identity secret. */
  get canConfirm(): boolean {
    return Boolean(this.stored.secrets.identitySecret && this.stored.secrets.deviceId);
  }

  get hasSession(): boolean {
    return Boolean(this.#session);
  }

  get session(): SessionTokens | undefined {
    return this.#session;
  }

  /** The current login code, against Steam's clock rather than this machine's. */
  async code(): Promise<CodeResult> {
    const now = await steamTime.now();
    return {
      code: generateCodeForTime(this.stored.secrets.sharedSecret, now),
      expiresIn: secondsRemaining(now),
      generatedAt: now,
    };
  }

  /** The current code using the cached clock offset. Never touches the network. */
  codeSync(): CodeResult {
    const now = steamTime.nowSync();
    return {
      code: generateCodeForTime(this.stored.secrets.sharedSecret, now),
      expiresIn: secondsRemaining(now),
      generatedAt: now,
    };
  }

  setSession(tokens: SessionTokens): void {
    this.#session = tokens;
    this.stored.session = tokens;
    this.#onSessionChange?.(tokens);
  }

  /** Renews the access token when it is close to expiring. */
  async ensureSession(): Promise<SessionTokens> {
    const current = this.#session;
    if (!current) {
      throw new SteamError(
        `${this.label} is not signed in to Steam. Sign in to read confirmations.`,
        'NO_SESSION',
      );
    }
    if (!needsRefresh(current)) return current;

    const renewed = await refreshAccessToken(current);
    this.setSession(renewed);
    return renewed;
  }

  #context() {
    const session = this.#session;
    if (!session) {
      throw new SteamError(`${this.label} is not signed in to Steam.`, 'NO_SESSION');
    }
    return {
      secrets: this.stored.secrets,
      accessToken: session.accessToken,
      now: () => steamTime.now(),
    };
  }

  /** Trades, market listings and anything else waiting on this account. */
  async confirmations(): Promise<Confirmation[]> {
    if (!this.canConfirm) {
      throw new SteamError(
        `${this.label} has no identity secret, so Steam will not show its confirmations.`,
        'NO_IDENTITY_SECRET',
      );
    }
    await this.ensureSession();
    return fetchConfirmations(this.#context());
  }

  async accept(confirmation: Pick<Confirmation, 'id' | 'nonce'>): Promise<void> {
    await this.ensureSession();
    return respondToConfirmation(this.#context(), confirmation, 'accept');
  }

  async deny(confirmation: Pick<Confirmation, 'id' | 'nonce'>): Promise<void> {
    await this.ensureSession();
    return respondToConfirmation(this.#context(), confirmation, 'deny');
  }

  /** Answers a batch in one request, which keeps Steam's rate limiter quiet. */
  async respondAll(
    confirmations: readonly Pick<Confirmation, 'id' | 'nonce'>[],
    decision: 'accept' | 'deny',
  ): Promise<void> {
    await this.ensureSession();
    return respondToConfirmations(this.#context(), confirmations, decision);
  }

  toJSON(): StoredAccount {
    return { ...this.stored, ...(this.#session ? { session: this.#session } : {}) };
  }
}
