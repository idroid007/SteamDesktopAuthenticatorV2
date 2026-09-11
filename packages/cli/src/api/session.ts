import { randomUUID } from 'node:crypto';
import {
  emptyVault,
  vaultExists,
  writeVault,
  RateCeiling,
  SteamError,
  planAutoConfirm,
  toAccept,
  type Account,
  type PendingLogin,
  type SessionTokens,
  type VaultSettings,
} from '@sda/core';
import { openVaultWithPassphrase, type OpenVault } from '../vault.js';

/** A login waiting on a code from the user. Dropped after a few minutes. */
interface PendingAuth {
  pending: PendingLogin;
  accountName: string;
  createdAt: number;
  /** Set when this login exists to link a brand new authenticator. */
  forLinking?: boolean;
  tokens?: SessionTokens;
}

const PENDING_TTL_MS = 5 * 60_000;

/**
 * Holds the unlocked vault for the life of the process.
 *
 * Locking drops the reference, so the passphrase and the decrypted secrets stop
 * being reachable. Nothing is written anywhere on the way out.
 */
export class Session {
  #vault: OpenVault | undefined;
  #failures = 0;
  #lockedUntil = 0;
  #pending = new Map<string, PendingAuth>();
  #ceilings = new Map<string, RateCeiling>();
  #lastActivity = Date.now();

  /** Set when a linking flow is mid-flight, holding the secrets until finalised. */
  linkDraft: { secrets: import('@sda/core').AuthenticatorSecrets; session: SessionTokens } | undefined;

  constructor(
    readonly vaultPath: string,
    /** True when bound to something other than loopback. */
    readonly exposedToNetwork: boolean,
  ) {}

  get locked(): boolean {
    return this.#vault === undefined;
  }

  get vault(): OpenVault {
    if (!this.#vault) throw new SteamError('The vault is locked.', 'LOCKED');
    this.touch();
    return this.#vault;
  }

  get settings(): VaultSettings {
    return this.vault.contents.settings;
  }

  adopt(vault: OpenVault): void {
    this.#vault = vault;
    this.#failures = 0;
    this.touch();
  }

  lock(): void {
    this.#vault = undefined;
    this.#pending.clear();
    this.linkDraft = undefined;
  }

  touch(): void {
    this.#lastActivity = Date.now();
  }

  /** True once the idle window in settings has passed. Zero disables it. */
  get idleExpired(): boolean {
    if (this.locked) return false;
    const minutes = this.#vault?.contents.settings.lockAfterIdleMinutes ?? 0;
    if (minutes <= 0) return false;
    return Date.now() - this.#lastActivity > minutes * 60_000;
  }

  /** Slows down guessing against a passphrase typed into a network-facing form. */
  get cooldownMs(): number {
    return Math.max(0, this.#lockedUntil - Date.now());
  }

  noteFailure(): void {
    this.#failures++;
    if (this.#failures >= 3) {
      this.#lockedUntil = Date.now() + Math.min(60_000, 2 ** (this.#failures - 3) * 2000);
    }
  }

  async unlock(passphrase: string): Promise<void> {
    this.adopt(await openVaultWithPassphrase(passphrase, this.vaultPath));
  }

  async vaultFileExists(): Promise<boolean> {
    return vaultExists(this.vaultPath);
  }

  /**
   * Creates the vault and opens it.
   *
   * Someone who downloaded the app has no vault and no terminal. This is the
   * first thing the interface offers them, so the whole product works without
   * ever typing a command.
   */
  async createVault(passphrase: string): Promise<void> {
    if (await this.vaultFileExists()) {
      throw new SteamError('A vault already exists here.', 'VAULT_EXISTS');
    }
    if (passphrase.length < 8) {
      throw new SteamError('Use a passphrase of at least 8 characters.', 'WEAK_PASSPHRASE');
    }
    await writeVault(emptyVault(), passphrase, this.vaultPath);
    await this.unlock(passphrase);
  }

  /* ----------------------------------------------------- pending logins */

  rememberPending(auth: Omit<PendingAuth, 'createdAt'>): string {
    this.#sweep();
    const id = randomUUID();
    this.#pending.set(id, { ...auth, createdAt: Date.now() });
    return id;
  }

  takePending(id: string): PendingAuth {
    this.#sweep();
    const found = this.#pending.get(id);
    if (!found) {
      throw new SteamError('That sign-in attempt expired. Start again.', 'LOGIN_TIMEOUT');
    }
    return found;
  }

  forgetPending(id: string): void {
    this.#pending.delete(id);
  }

  #sweep(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [id, auth] of this.#pending) {
      if (auth.createdAt < cutoff) this.#pending.delete(id);
    }
  }

  /* ------------------------------------------------------- auto confirm */

  ceilingFor(steamId: string): RateCeiling {
    const rules = this.settings.autoConfirm;
    let ceiling = this.#ceilings.get(steamId);
    if (!ceiling) {
      ceiling = new RateCeiling(rules.maxPerHour);
      this.#ceilings.set(steamId, ceiling);
    }
    return ceiling;
  }

  /**
   * Applies the auto-confirm rules to one account.
   *
   * Returns what it approved and what it left alone, so the interface can say
   * why something is still sitting there rather than looking broken.
   */
  async runAutoConfirm(account: Account) {
    const rules = this.settings.autoConfirm;
    if (!rules.enabled || !account.canConfirm || !account.hasSession) {
      return { accepted: 0, held: 0, decisions: [] as ReturnType<typeof planAutoConfirm> };
    }

    const pending = await account.confirmations();
    const ceiling = this.ceilingFor(account.steamId);
    const decisions = planAutoConfirm(pending, rules, ceiling);
    const accept = toAccept(decisions);

    if (accept.length > 0) {
      await account.respondAll(accept, 'accept');
      ceiling.record(accept.length);
    }

    return {
      accepted: accept.length,
      held: decisions.length - accept.length,
      decisions,
    };
  }

  /* ------------------------------------------------------------- guards */

  /**
   * Refuses operations that would put a secret on the wire when the server is
   * reachable from the network. Exporting an maFile and revealing a revocation
   * code stay on the machine running the app.
   */
  requireLoopback(what: string): void {
    if (this.exposedToNetwork) {
      throw new SteamError(
        `${what} is refused while the server is open to the network. Run without --allow-lan.`,
        'LOOPBACK_ONLY',
      );
    }
  }
}
