import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCb,
  timingSafeEqual,
} from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (
  password: string | Buffer,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * SDA v1 derived keys with PBKDF2-SHA1 at 50,000 iterations and encrypted with
 * AES-256-CBC and no MAC. Two problems follow from that. A GPU chews through
 * PBKDF2-SHA1, and unauthenticated CBC lets someone flip bits in your vault
 * without you noticing, with padding errors leaking whether a guess was close.
 *
 * We use scrypt, which costs memory as well as time, and AES-256-GCM, which
 * refuses to decrypt data that has been altered.
 */
export const KDF_DEFAULTS = {
  /** 2^17. Costs about 134 MB per guess, so a GPU farm loses most of its edge. */
  N: 131072,
  r: 8,
  p: 1,
} as const;

const KEY_BYTES = 32;
const SALT_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAXMEM = 512 * 1024 * 1024;

export interface VaultHeader {
  format: 'sda-vault';
  version: 2;
  kdf: { algo: 'scrypt'; N: number; r: number; p: number; salt: string };
  cipher: { algo: 'aes-256-gcm'; iv: string };
}

export interface EncryptedVault extends VaultHeader {
  ciphertext: string;
  tag: string;
}

async function deriveKey(passphrase: string, header: VaultHeader): Promise<Buffer> {
  const { N, r, p, salt } = header.kdf;
  return scrypt(passphrase.normalize('NFKC'), Buffer.from(salt, 'base64'), KEY_BYTES, {
    N,
    r,
    p,
    maxmem: MAXMEM,
  });
}

/**
 * The header is bound into the ciphertext as additional authenticated data, so
 * nobody can weaken your KDF settings by editing the file and have it still open.
 */
function aad(header: VaultHeader): Buffer {
  return Buffer.from(
    JSON.stringify({
      format: header.format,
      version: header.version,
      kdf: header.kdf,
      cipher: header.cipher,
    }),
    'utf8',
  );
}

export async function encryptVault(
  plaintext: string,
  passphrase: string,
  params: { N: number; r: number; p: number } = KDF_DEFAULTS,
): Promise<EncryptedVault> {
  if (passphrase.length === 0) throw new Error('passphrase is empty');

  const header: VaultHeader = {
    format: 'sda-vault',
    version: 2,
    kdf: { algo: 'scrypt', ...params, salt: randomBytes(SALT_BYTES).toString('base64') },
    cipher: { algo: 'aes-256-gcm', iv: randomBytes(IV_BYTES).toString('base64') },
  };

  const key = await deriveKey(passphrase, header);
  try {
    const cipher = createCipheriv('aes-256-gcm', key, Buffer.from(header.cipher.iv, 'base64'));
    cipher.setAAD(aad(header));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return {
      ...header,
      ciphertext: ciphertext.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
  } finally {
    key.fill(0);
  }
}

export class WrongPassphraseError extends Error {
  constructor() {
    super('That passphrase does not open this vault.');
    this.name = 'WrongPassphraseError';
  }
}

export async function decryptVault(vault: EncryptedVault, passphrase: string): Promise<string> {
  if (vault.format !== 'sda-vault') throw new Error('not an SDA vault file');
  if (vault.version !== 2) throw new Error(`unsupported vault version ${vault.version}`);

  const tag = Buffer.from(vault.tag, 'base64');
  if (tag.length !== TAG_BYTES) throw new Error('vault auth tag is malformed');

  const key = await deriveKey(passphrase, vault);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(vault.cipher.iv, 'base64'));
    decipher.setAAD(aad(vault));
    decipher.setAuthTag(tag);
    const out = Buffer.concat([
      decipher.update(Buffer.from(vault.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return out.toString('utf8');
  } catch {
    // GCM cannot tell a wrong key from a tampered file, and neither can we.
    throw new WrongPassphraseError();
  } finally {
    key.fill(0);
  }
}

/** Constant-time compare, for confirming a passphrase the user typed twice. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
