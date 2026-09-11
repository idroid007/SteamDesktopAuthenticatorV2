import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { describe, it } from 'node:test';
import { confirmationHash, confirmationParams, generateDeviceId } from '../dist/index.js';

const IDENTITY = 'HMSk4iFbfSpq3TxpK4YuKRWfNXo=';

describe('confirmationHash', () => {
  it('signs the timestamp and tag the way Steam expects', () => {
    const time = 1_700_000_000;
    const tag = 'conf';

    // Independent construction: 8-byte big-endian time, then the tag bytes.
    const message = Buffer.concat([Buffer.alloc(8), Buffer.from(tag, 'ascii')]);
    message.writeBigUInt64BE(BigInt(time), 0);
    const expected = createHmac('sha1', Buffer.from(IDENTITY, 'base64'))
      .update(message)
      .digest('base64');

    assert.equal(confirmationHash(IDENTITY, time, tag), expected);
  });

  it('produces a different signature for each operation', () => {
    const time = 1_700_000_000;
    const seen = new Set(
      ['conf', 'details', 'accept', 'reject'].map((tag) => confirmationHash(IDENTITY, time, tag)),
    );
    assert.equal(seen.size, 4);
  });

  it('changes every second, so a captured signature ages out', () => {
    assert.notEqual(
      confirmationHash(IDENTITY, 1_700_000_000, 'conf'),
      confirmationHash(IDENTITY, 1_700_000_001, 'conf'),
    );
  });

  it('emits base64 that survives a URL round trip', () => {
    const hash = confirmationHash(IDENTITY, 1_700_000_000, 'conf');
    assert.match(hash, /^[A-Za-z0-9+/]+=*$/);
    assert.equal(decodeURIComponent(encodeURIComponent(hash)), hash);
  });

  it('rejects an identity secret that is not base64', () => {
    assert.throws(() => confirmationHash('', 1_700_000_000, 'conf'), /base64/);
  });
});

describe('confirmationParams', () => {
  const secrets = {
    identitySecret: IDENTITY,
    deviceId: 'android:11111111-2222-3333-4444-555555555555',
    steamId: '76561198000000000',
  };

  it('sends every field Steam checks', () => {
    const params = confirmationParams(secrets, 1_700_000_000, 'conf');
    assert.deepEqual(Object.keys(params).sort(), ['a', 'k', 'm', 'p', 't', 'tag']);
    assert.equal(params.p, secrets.deviceId);
    assert.equal(params.a, secrets.steamId);
    assert.equal(params.t, '1700000000');
    assert.equal(params.tag, 'conf');
  });

  // Steam started requiring this when it moved confirmations to a React page.
  it('identifies itself as the react client', () => {
    assert.equal(confirmationParams(secrets, 1_700_000_000, 'conf').m, 'react');
  });

  it('explains the problem when a device ID is missing', () => {
    assert.throws(
      () => confirmationParams({ ...secrets, deviceId: '' }, 1_700_000_000, 'conf'),
      /device ID/,
    );
  });
});

describe('generateDeviceId', () => {
  it('looks like an Android device identifier', () => {
    assert.match(
      generateDeviceId(),
      /^android:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('never repeats', () => {
    const ids = new Set(Array.from({ length: 1000 }, generateDeviceId));
    assert.equal(ids.size, 1000);
  });
});
