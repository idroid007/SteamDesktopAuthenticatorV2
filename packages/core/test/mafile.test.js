import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspectImport, MaFileError, parseMaFile, toMaFile } from '../dist/index.js';

/** The shape SDA v1 writes. Secrets here are random, not from a real account. */
const SDA_V1 = JSON.stringify({
  shared_secret: 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=',
  serial_number: '7011637984399520000',
  revocation_code: 'R12345',
  uri: 'otpauth://totp/Steam:trader?secret=OJZ2BL7SU5FLUD5G3NQNBRSELZIPOAFU&issuer=Steam',
  server_time: 1700000000,
  account_name: 'trader',
  token_gid: 'a1b2c3d4e5f6',
  identity_secret: 'HMSk4iFbfSpq3TxpK4YuKRWfNXo=',
  secret_1: 'kZ8n2vQ1pL0xR7tY4uI9oP3aS6dF=',
  status: 1,
  device_id: 'android:11111111-2222-3333-4444-555555555555',
  fully_enrolled: true,
  Session: {
    SessionID: 'abc123',
    SteamID: 76561198000000000,
    AccessToken: 'eyJhbGciOiJFUzI1NiJ9.payload.sig',
    RefreshToken: 'eyJhbGciOiJFUzI1NiJ9.refresh.sig',
  },
});

describe('parseMaFile', () => {
  it('reads a file written by SDA v1', () => {
    const account = parseMaFile(SDA_V1);
    assert.equal(account.secrets.accountName, 'trader');
    assert.equal(account.secrets.steamId, '76561198000000000');
    assert.equal(account.secrets.sharedSecret, 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=');
    assert.equal(account.secrets.revocationCode, 'R12345');
    assert.equal(account.fullyEnrolled, true);
    assert.equal(account.session?.accessToken, 'eyJhbGciOiJFUzI1NiJ9.payload.sig');
  });

  it('accepts lowercase session keys from other tools', () => {
    const account = parseMaFile(
      JSON.stringify({
        shared_secret: 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=',
        identity_secret: 'HMSk4iFbfSpq3TxpK4YuKRWfNXo=',
        account_name: 'trader',
        device_id: 'android:x',
        session: { steamid: '76561198000000000', access_token: 'a', refresh_token: 'b' },
      }),
    );
    assert.equal(account.secrets.steamId, '76561198000000000');
    assert.equal(account.session?.refreshToken, 'b');
  });

  it('recovers the SteamID from the otpauth URI when nothing else carries it', () => {
    const account = parseMaFile(
      JSON.stringify({
        shared_secret: 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=',
        account_name: 'trader',
        uri: 'otpauth://totp/Steam:trader?secret=ABC&issuer=Steam&steamid=76561198000000000',
      }),
    );
    assert.equal(account.secrets.steamId, '76561198000000000');
  });

  it('treats status 1 as enrolled when fully_enrolled is absent', () => {
    const account = parseMaFile(
      JSON.stringify({
        shared_secret: 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=',
        account_name: 'trader',
        steamid: '76561198000000000',
        status: 1,
      }),
    );
    assert.equal(account.fullyEnrolled, true);
  });

  it('names the file in the error so a bulk import says which one broke', () => {
    assert.throws(() => parseMaFile('{not json', 'alt_account.maFile'), (err) => {
      assert.ok(err instanceof MaFileError);
      assert.match(err.message, /alt_account\.maFile/);
      return true;
    });
  });

  it('points at SDA when handed an encrypted file', () => {
    assert.throws(() => parseMaFile('9f8a7b6c5d4e3f2a1b=='), /decrypt it in SDA first/);
  });

  it('refuses a file with no shared secret', () => {
    assert.throws(
      () => parseMaFile(JSON.stringify({ account_name: 'trader', steamid: '76561198000000000' })),
      /no shared_secret/,
    );
  });

  it('refuses a file with no SteamID, since confirmations need one', () => {
    assert.throws(
      () => parseMaFile(JSON.stringify({ shared_secret: 'abc', account_name: 'trader' })),
      /no SteamID/,
    );
  });
});

describe('inspectImport', () => {
  it('stays quiet on a complete file', () => {
    assert.deepEqual(inspectImport(parseMaFile(SDA_V1)), []);
  });

  it('warns when confirmations will not work', () => {
    const account = parseMaFile(
      JSON.stringify({
        shared_secret: 'cnOgv/KdpLoP6Nbh0GMkXkPXALQ=',
        account_name: 'trader',
        steamid: '76561198000000000',
      }),
    );
    const notes = inspectImport(account);
    assert.equal(notes.length, 3);
    assert.ok(notes.some((n) => n.includes('identity_secret')));
    assert.ok(notes.some((n) => n.includes('device_id')));
    assert.ok(notes.some((n) => n.includes('revocation code')));
  });
});

describe('toMaFile', () => {
  it('round trips through our own parser', () => {
    const original = parseMaFile(SDA_V1);
    const reparsed = parseMaFile(toMaFile(original));
    assert.deepEqual(reparsed.secrets, original.secrets);
    assert.equal(reparsed.fullyEnrolled, original.fullyEnrolled);
  });

  it('writes the field names SDA v1 and steamguard-cli look for', () => {
    const written = JSON.parse(toMaFile(parseMaFile(SDA_V1)));
    for (const key of [
      'shared_secret',
      'identity_secret',
      'revocation_code',
      'account_name',
      'device_id',
      'Session',
    ]) {
      assert.ok(key in written, `missing ${key}`);
    }
    assert.equal(typeof written.Session.SteamID, 'number');
  });
});

/**
 * SteamID64 values sit above Number.MAX_SAFE_INTEGER, and maFiles store them
 * as bare JSON numbers. Parsing one into a double drops the low digits, which
 * made two separate accounts collapse onto a single ID during an import.
 */
describe('SteamID precision', () => {
  const big = (id) =>
    `{"shared_secret":"cnOgv/KdpLoP6Nbh0GMkXkPXALQ=","account_name":"a","Session":{"SteamID":${id}}}`;

  it('keeps all 17 digits of a SteamID stored as a JSON number', () => {
    assert.equal(parseMaFile(big('76561198000000001')).secrets.steamId, '76561198000000001');
    assert.equal(parseMaFile(big('76561199123456789')).secrets.steamId, '76561199123456789');
  });

  it('keeps neighbouring accounts distinct', () => {
    const a = parseMaFile(big('76561198000000001')).secrets.steamId;
    const b = parseMaFile(big('76561198000000002')).secrets.steamId;
    assert.notEqual(a, b);
  });

  it('shows the rounding this guards against', () => {
    // Proof the naive path really does lose the value.
    assert.equal(JSON.parse('{"id":76561198000000001}').id, 76561198000000000);
  });

  it('writes the exact digits back out', () => {
    const account = parseMaFile(big('76561198000000001'));
    const written = toMaFile(account);
    assert.match(written, /"SteamID":\s*76561198000000001/);
    assert.equal(parseMaFile(written).secrets.steamId, '76561198000000001');
  });
});
