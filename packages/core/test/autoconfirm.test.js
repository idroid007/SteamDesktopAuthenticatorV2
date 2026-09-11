import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { DEFAULT_AUTO_CONFIRM, planAutoConfirm, RateCeiling, toAccept } from '../dist/index.js';

const NOW = 1_700_000_000;

function conf(kind, overrides = {}) {
  return {
    id: Math.random().toString(36).slice(2),
    nonce: 'n',
    kind,
    rawType: kind === 'trade' ? 2 : 3,
    creatorId: '1',
    headline: kind === 'trade' ? 'kopke_trades' : 'Sell - AWP | Asiimov',
    summary: [],
    when: 'just now',
    // Old enough to clear the hold window unless a test says otherwise.
    createdAt: NOW - 600,
    ...overrides,
  };
}

const rules = (over = {}) => ({ ...DEFAULT_AUTO_CONFIRM, enabled: true, ...over });

describe('planAutoConfirm', () => {
  it('holds everything while automatic approval is off', () => {
    const decisions = planAutoConfirm(
      [conf('market'), conf('trade')],
      DEFAULT_AUTO_CONFIRM,
      new RateCeiling(100),
      NOW,
    );
    assert.equal(toAccept(decisions).length, 0);
    assert.ok(decisions.every((d) => d.reason.includes('switched off')));
  });

  // The default that matters: selling is automatic, giving items away is not.
  it('accepts market listings and holds trades by default', () => {
    const decisions = planAutoConfirm(
      [conf('market'), conf('trade')],
      rules(),
      new RateCeiling(100),
      NOW,
    );
    assert.equal(toAccept(decisions).length, 1);
    assert.equal(toAccept(decisions)[0].kind, 'market');
    const trade = decisions.find((d) => d.confirmation.kind === 'trade');
    assert.match(trade.reason, /Trades always wait/);
  });

  it('holds trades even when enabled, unless the partner is on the list', () => {
    const decisions = planAutoConfirm(
      [conf('trade', { headline: 'stranger' })],
      rules({ trades: true, allowedPartners: ['kopke_trades'] }),
      new RateCeiling(100),
      NOW,
    );
    assert.equal(toAccept(decisions).length, 0);
    assert.match(decisions[0].reason, /not on your allow list/);
  });

  it('accepts a trade from an allowed partner, ignoring case and padding', () => {
    const decisions = planAutoConfirm(
      [conf('trade', { headline: 'KoPke_Trades' })],
      rules({ trades: true, allowedPartners: ['  kopke_trades '] }),
      new RateCeiling(100),
      NOW,
    );
    assert.equal(toAccept(decisions).length, 1);
  });

  it('treats an empty allow list as allowing nobody', () => {
    const decisions = planAutoConfirm(
      [conf('trade')],
      rules({ trades: true, allowedPartners: [] }),
      new RateCeiling(100),
      NOW,
    );
    assert.equal(toAccept(decisions).length, 0);
  });

  // Account recovery and phone changes are exactly what an attacker needs.
  it('never automates account recovery, phone changes or API keys', () => {
    for (const kind of ['account-recovery', 'phone-number-change', 'api-key', 'unknown']) {
      const decisions = planAutoConfirm(
        [conf(kind)],
        rules({ trades: true, market: true, allowedPartners: ['anyone'] }),
        new RateCeiling(100),
        NOW,
      );
      assert.equal(toAccept(decisions).length, 0, kind);
      assert.match(decisions[0].reason, /always needs you/);
    }
  });

  it('waits out the hold window before approving', () => {
    const fresh = conf('market', { createdAt: NOW - 5 });
    const decisions = planAutoConfirm([fresh], rules({ holdSeconds: 30 }), new RateCeiling(100), NOW);
    assert.equal(toAccept(decisions).length, 0);
    assert.match(decisions[0].reason, /Waiting 25s/);
  });

  // This is the answer to issue #832: a stolen API key cannot empty an
  // inventory in minutes, because the ceiling stops it.
  it('stops at the hourly ceiling', () => {
    const many = Array.from({ length: 40 }, () => conf('market'));
    const decisions = planAutoConfirm(many, rules({ maxPerHour: 10 }), new RateCeiling(10), NOW);
    assert.equal(toAccept(decisions).length, 10);
    assert.match(decisions.at(-1).reason, /ceiling of 10/);
  });

  it('counts approvals already made this hour against the ceiling', () => {
    const ceiling = new RateCeiling(10);
    ceiling.record(8);
    const decisions = planAutoConfirm(
      Array.from({ length: 5 }, () => conf('market')),
      rules({ maxPerHour: 10 }),
      ceiling,
      NOW,
    );
    assert.equal(toAccept(decisions).length, 2);
  });

  it('gives every held confirmation a reason worth showing', () => {
    const decisions = planAutoConfirm(
      [conf('trade'), conf('market', { createdAt: NOW })],
      rules({ holdSeconds: 30 }),
      new RateCeiling(100),
      NOW,
    );
    for (const d of decisions.filter((x) => x.action === 'hold')) {
      assert.ok(d.reason.length > 0);
      assert.ok(!d.reason.includes('undefined'));
    }
  });
});

describe('RateCeiling', () => {
  it('reports what is left', () => {
    const ceiling = new RateCeiling(5);
    assert.equal(ceiling.remaining, 5);
    ceiling.record(2);
    assert.equal(ceiling.used, 2);
    assert.equal(ceiling.remaining, 3);
  });

  it('knows when it is spent', () => {
    const ceiling = new RateCeiling(3);
    ceiling.record(3);
    assert.ok(ceiling.exhausted);
    ceiling.reset();
    assert.ok(!ceiling.exhausted);
  });
});
