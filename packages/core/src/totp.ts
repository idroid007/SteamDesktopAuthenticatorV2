import { createHmac } from 'node:crypto';

/**
 * Steam encodes login codes in a 26-character alphabet. Vowels and easily
 * confused glyphs (0/O, 1/I/L, 5/S, Z) never appear, so a code read aloud
 * over voice chat survives the trip.
 */
const ALPHABET = '23456789BCDFGHJKMNPQRTVWXY';
const CODE_LENGTH = 5;
const PERIOD_SECONDS = 30;

/** Steam rotates codes every 30 seconds. */
export const CODE_PERIOD_SECONDS = PERIOD_SECONDS;

function decodeSecret(sharedSecret: string): Buffer {
  const cleaned = sharedSecret.trim();
  if (cleaned.length === 0) {
    throw new Error('shared secret is empty');
  }
  // Steam hands out base64. Some exports wrap it in quotes or escape slashes.
  const unescaped = cleaned.replace(/\\\//g, '/').replace(/^"|"$/g, '');
  const buf = Buffer.from(unescaped, 'base64');
  if (buf.length === 0) {
    throw new Error('shared secret is not valid base64');
  }
  return buf;
}

function bigEndian64(value: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(Math.floor(value)));
  return buf;
}

/**
 * Builds the 5-character Steam Guard code for a point in time.
 *
 * The shape is RFC 4226 HOTP with a 30 second counter, except Steam replaces
 * the decimal truncation step with repeated division into its own alphabet.
 *
 * @param sharedSecret base64 secret from the authenticator
 * @param unixSeconds Steam-corrected wall clock in seconds
 */
export function generateCodeForTime(sharedSecret: string, unixSeconds: number): string {
  const key = decodeSecret(sharedSecret);
  const counter = Math.floor(unixSeconds / PERIOD_SECONDS);
  const mac = createHmac('sha1', key).update(bigEndian64(counter)).digest();

  // Dynamic truncation: the low nibble of the last byte picks the offset.
  const offset = mac[19]! & 0x0f;
  let slice =
    ((mac[offset]! & 0x7f) << 24) |
    ((mac[offset + 1]! & 0xff) << 16) |
    ((mac[offset + 2]! & 0xff) << 8) |
    (mac[offset + 3]! & 0xff);

  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += ALPHABET[slice % ALPHABET.length];
    slice = Math.floor(slice / ALPHABET.length);
  }
  return code;
}

/** Seconds left before the current code rotates. */
export function secondsRemaining(unixSeconds: number): number {
  return PERIOD_SECONDS - (Math.floor(unixSeconds) % PERIOD_SECONDS);
}

/** How far through the current 30 second window we are, from 0 to 1. */
export function periodProgress(unixSeconds: number): number {
  return (unixSeconds % PERIOD_SECONDS) / PERIOD_SECONDS;
}
