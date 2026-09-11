import { constants, createPublicKey, publicEncrypt } from 'node:crypto';

/** Strips a leading zero byte so the value reads as unsigned, per JWK rules. */
function hexToBase64Url(hex: string): string {
  const clean = hex.length % 2 === 0 ? hex : `0${hex}`;
  let buf = Buffer.from(clean, 'hex');
  let start = 0;
  while (start < buf.length - 1 && buf[start] === 0) start++;
  if (start > 0) buf = buf.subarray(start);
  return buf.toString('base64url');
}

/**
 * Steam hands out a fresh RSA public key per login as a hex modulus and
 * exponent, then expects the password encrypted under PKCS#1 v1.5 and
 * base64 encoded. Your password never crosses the wire in the clear.
 */
export function encryptPassword(password: string, modulusHex: string, exponentHex: string): string {
  const key = createPublicKey({
    key: { kty: 'RSA', n: hexToBase64Url(modulusHex), e: hexToBase64Url(exponentHex) },
    format: 'jwk',
  });
  const encrypted = publicEncrypt(
    { key, padding: constants.RSA_PKCS1_PADDING },
    Buffer.from(password, 'utf8'),
  );
  return encrypted.toString('base64');
}
