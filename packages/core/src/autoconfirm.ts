import type { Confirmation } from './types.js';

/**
 * Rules for answering confirmations without a human looking.
 *
 * SDA v1 shipped a plain "auto confirm trades" switch. Issue #832 was a Buff
 * trader pointing out what that costs when someone steals your API key: the
 * inventory empties in minutes, because the tool approves every request that
 * arrives. The switch had no ceiling and no way to tell a sale from a giveaway.
 *
 * So the rules below separate the two cases. Selling on the market is low risk,
 * since you set the price and receive money. A trade hands items to a person,
 * which is where inventories disappear. Trades stay off by default, and a rate
 * ceiling stops any runaway regardless of which switches are on.
 */
export interface AutoConfirmRules {
  enabled: boolean;
  /** Market listings you created. Safe enough to leave on. */
  market: boolean;
  /** Trades. Off by default, and the interface says why. */
  trades: boolean;
  /** Only auto-accept trades whose partner name appears here. Empty means none. */
  allowedPartners: string[];
  /** Stop after this many automatic approvals in an hour. */
  maxPerHour: number;
  /** Wait this long before approving, leaving room to cancel by hand. */
  holdSeconds: number;
}

export const DEFAULT_AUTO_CONFIRM: AutoConfirmRules = {
  enabled: false,
  market: true,
  trades: false,
  allowedPartners: [],
  maxPerHour: 25,
  holdSeconds: 30,
};

export type AutoAction = 'accept' | 'hold';

export interface AutoDecision {
  confirmation: Confirmation;
  action: AutoAction;
  /** Shown in the interface so nobody wonders why something is sitting there. */
  reason: string;
}

/**
 * Counts recent automatic approvals so a compromised account cannot be drained
 * faster than the ceiling allows.
 */
export class RateCeiling {
  #stamps: number[] = [];

  constructor(private readonly maxPerHour: number) {}

  get used(): number {
    this.#prune();
    return this.#stamps.length;
  }

  get remaining(): number {
    return Math.max(0, this.maxPerHour - this.used);
  }

  get exhausted(): boolean {
    return this.remaining === 0;
  }

  record(count = 1): void {
    const now = Date.now();
    for (let i = 0; i < count; i++) this.#stamps.push(now);
  }

  reset(): void {
    this.#stamps = [];
  }

  #prune(): void {
    const cutoff = Date.now() - 60 * 60 * 1000;
    this.#stamps = this.#stamps.filter((t) => t > cutoff);
  }
}

/**
 * Decides what to do with each pending confirmation.
 *
 * Nothing here talks to Steam. It sorts confirmations into accept and hold, so
 * the caller can show the reasoning before acting and a test can check the
 * rules without a network.
 */
export function planAutoConfirm(
  confirmations: readonly Confirmation[],
  rules: AutoConfirmRules,
  ceiling: RateCeiling,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): AutoDecision[] {
  if (!rules.enabled) {
    return confirmations.map((confirmation) => ({
      confirmation,
      action: 'hold',
      reason: 'Automatic approval is switched off.',
    }));
  }

  let budget = ceiling.remaining;

  return confirmations.map((confirmation): AutoDecision => {
    const held = (reason: string): AutoDecision => ({ confirmation, action: 'hold', reason });

    if (confirmation.kind === 'market') {
      if (!rules.market) return held('Market listings are set to wait for you.');
    } else if (confirmation.kind === 'trade') {
      if (!rules.trades) return held('Trades always wait for you.');
      const partner = confirmation.headline.trim().toLowerCase();
      const allowed = rules.allowedPartners.map((p) => p.trim().toLowerCase());
      if (allowed.length === 0) return held('No trade partners are on your allow list.');
      if (!allowed.includes(partner)) {
        return held(`${confirmation.headline} is not on your allow list.`);
      }
    } else {
      // Account recovery, phone changes, API keys. Never automatic.
      return held('This kind of confirmation always needs you.');
    }

    const age = nowSeconds - confirmation.createdAt;
    if (age < rules.holdSeconds) {
      const wait = rules.holdSeconds - age;
      return held(`Waiting ${wait}s, so you can step in.`);
    }

    if (budget <= 0) {
      return held(`Hourly ceiling of ${rules.maxPerHour} reached. Approve the rest yourself.`);
    }

    budget--;
    return { confirmation, action: 'accept', reason: 'Matched your rules.' };
  });
}

/** The confirmations a plan says to approve. */
export function toAccept(decisions: readonly AutoDecision[]): Confirmation[] {
  return decisions.filter((d) => d.action === 'accept').map((d) => d.confirmation);
}
