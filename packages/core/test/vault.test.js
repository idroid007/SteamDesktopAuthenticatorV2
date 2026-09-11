import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decryptVault, encryptVault, WrongPassphraseError } from '../dist/index.js';

// Keep the KDF cheap so the suite stays fast. Production uses N=131072.
const FAST = { N: 1024, r: 8, p: 1 };

const SECRET_PAYLOAD = JSON.stringify({
  accounts: [{ sharedSecret: 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=', accountName: 'trader' }],
});

describe('vault encryption', () => {
  it('returns the same data it was given', async () => {
    const sealed = await encryptVault(SECRET_PAYLOAD, 'correct horse battery staple', FAST);
    assert.equal(await decryptVault(sealed, 'correct horse battery staple'), SECRET_PAYLOAD);
  });

  it('uses a fresh salt and IV on every write', async () => {
    const a = await encryptVault(SECRET_PAYLOAD, 'pw', FAST);
    const b = await encryptVault(SECRET_PAYLOAD, 'pw', FAST);
    assert.notEqual(a.kdf.salt, b.kdf.salt);
    assert.notEqual(a.cipher.iv, b.cipher.iv);
    assert.notEqual(a.ciphertext, b.ciphertext);
  });

  it('refuses a wrong passphrase', async () => {
    const sealed = await encryptVault(SECRET_PAYLOAD, 'right', FAST);
    await assert.rejects(() => decryptVault(sealed, 'wrong'), WrongPassphraseError);
  });

  it('leaks nothing about how close a guess was', async () => {
    const sealed = await encryptVault(SECRET_PAYLOAD, 'passphrase', FAST);
    const near = await decryptVault(sealed, 'passphrasf').catch((e) => e.message);
    const far = await decryptVault(sealed, 'x').catch((e) => e.message);
    assert.equal(near, far);
  });

  // SDA v1 used AES-CBC with no MAC, so edited ciphertext decrypted to garbage
  // rather than failing. GCM rejects it outright.
  it('detects a flipped bit in the ciphertext', async () => {
    const sealed = await encryptVault(SECRET_PAYLOAD, 'pw', FAST);
    const bytes = Buffer.from(sealed.ciphertext, 'base64');
    bytes[0] ^= 0x01;
    const tampered = { ...sealed, ciphertext: bytes.toString('base64') };
    await assert.rejects(() => decryptVault(tampered, 'pw'), WrongPassphraseError);
  });

  it('detects a forged auth tag', async () => {
    const sealed = await encryptVault(SECRET_PAYLOAD, 'pw', FAST);
    const tag = Buffer.from(sealed.tag, 'base64');
    tag[0] ^= 0xff;
    await assert.rejects(
      () => decryptVault({ ...sealed, tag: tag.toString('base64') }, 'pw'),
      WrongPassphraseError,
    );
  });

  // The header is authenticated, so nobody can downgrade the KDF and still open it.
  it('refuses a vault whose KDF settings were weakened', async () => {
    const sealed = await encryptVault(SECRET_PAYLOAD, 'pw', FAST);
    const downgraded = { ...sealed, kdf: { ...sealed.kdf, N: 2 } };
    await assert.rejects(() => decryptVault(downgraded, 'pw'), WrongPassphraseError);
  });

  it('refuses a file that is not an SDA vault', async () => {
    await assert.rejects(
      () => decryptVault({ format: 'something-else', version: 2 }, 'pw'),
      /not an SDA vault/,
    );
  });

  it('refuses an empty passphrase rather than storing secrets in the clear', async () => {
    await assert.rejects(() => encryptVault(SECRET_PAYLOAD, '', FAST), /empty/);
  });

  it('treats visually identical passphrases as equal after normalising', async () => {
    // The same character composed two ways in Unicode.
    const composed = 'café';
    const decomposed = 'café';
    const sealed = await encryptVault(SECRET_PAYLOAD, composed, FAST);
    assert.equal(await decryptVault(sealed, decomposed), SECRET_PAYLOAD);
  });
});
