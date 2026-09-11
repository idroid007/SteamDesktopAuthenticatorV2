import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { CODE_PERIOD_SECONDS, generateCodeForTime, secondsRemaining } from '../dist/index.js';

const ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';

/**
 * RFC 4226 Appendix D publishes the dynamic-truncation output for the secret
 * "12345678901234567890" at counters 0-9. Steam's code generator runs the same
 * HMAC and truncation, then encodes the result in its own alphabet instead of
 * decimal, so these values pin the half of the algorithm Steam did not invent.
 */
const RFC4226_TRUNCATED = [
  1284755224, 1094287082, 137359152, 1726969429, 1640338314, 868254676, 1918287922, 82162583,
  673399871, 645520489,
];

const RFC_SECRET_B64 = Buffer.from('12345678901234567890', 'ascii').toString('base64');

/** Base-26 encode, written independently of the implementation under test. */
function encodeSteamAlphabet(value) {
  const out = [];
  let remaining = value;
  while (out.length < 5) {
    out.push(ALPHABET.charAt(remaining % 26));
    remaining = (remaining - (remaining % 26)) / 26;
  }
  return out.join('');
}

describe('generateCodeForTime', () => {
  it('matches RFC 4226 truncation for every published counter', () => {
    for (const [counter, truncated] of RFC4226_TRUNCATED.entries()) {
      const time = counter * CODE_PERIOD_SECONDS;
      assert.equal(
        generateCodeForTime(RFC_SECRET_B64, time),
        encodeSteamAlphabet(truncated),
        `counter ${counter}`,
      );
    }
  });

  it('derives the same truncation this test computes from scratch', () => {
    const secret = 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=';
    const time = 1_700_000_000;
    const counter = Buffer.alloc(8);
    counter.writeBigUInt64BE(BigInt(Math.floor(time / 30)));
    const mac = createHmac('sha1', Buffer.from(secret, 'base64')).update(counter).digest();
    const offset = mac[19] & 0x0f;
    const slice =
      ((mac[offset] & 0x7f) << 24) |
      ((mac[offset + 1] & 0xff) << 16) |
      ((mac[offset + 2] & 0xff) << 8) |
      (mac[offset + 3] & 0xff);

    assert.equal(generateCodeForTime(secret, time), encodeSteamAlphabet(slice));
  });

  it('returns five characters drawn only from Steam alphabet', () => {
    for (let i = 0; i < 500; i++) {
      const code = generateCodeForTime(RFC_SECRET_B64, 1_600_000_000 + i * 37);
      assert.equal(code.length, 5);
      assert.match(code, /^[23456789BCDFGHJKMNPQRTVWXY]{5}$/);
    }
  });

  it('never emits glyphs that are misread aloud', () => {
    const banned = ['0', 'O', '1', 'I', 'L', 'S', 'U', 'Z', 'A', 'E'];
    for (const ch of banned) {
      assert.ok(!ALPHABET.includes(ch), `alphabet must not contain ${ch}`);
    }
  });

  it('holds a code steady across its 30 second window', () => {
    const base = 1_700_000_040; // aligned to a window boundary
    const first = generateCodeForTime(RFC_SECRET_B64, base);
    for (let offset = 0; offset < 30; offset++) {
      assert.equal(generateCodeForTime(RFC_SECRET_B64, base + offset), first);
    }
    assert.notEqual(generateCodeForTime(RFC_SECRET_B64, base + 30), first);
  });

  it('accepts secrets with escaped slashes, as some exports write them', () => {
    const plain = 'ab/cd+ef/gh+ij/kl+mn/op0M=';
    const escaped = plain.replace(/\//g, '\\/');
    assert.equal(
      generateCodeForTime(escaped, 1_700_000_000),
      generateCodeForTime(plain, 1_700_000_000),
    );
  });

  it('rejects an empty secret instead of returning a wrong code', () => {
    assert.throws(() => generateCodeForTime('', 1_700_000_000), /empty/);
  });
});

describe('secondsRemaining', () => {
  it('counts down to the next rotation', () => {
    assert.equal(secondsRemaining(1_700_000_040), 30);
    assert.equal(secondsRemaining(1_700_000_041), 29);
    assert.equal(secondsRemaining(1_700_000_069), 1);
  });
});
