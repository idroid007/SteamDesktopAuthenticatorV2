import { generateDeviceId } from '../confirmation.js';
import { generateCodeForTime } from '../totp.js';
import { SteamError } from '../types.js';
import type { AuthenticatorSecrets, SessionTokens, StoredAccount } from '../types.js';
import { callApi } from './api.js';

const SERVICE = 'ITwoFactorService';

interface AddAuthenticatorResponse {
  response: {
    status?: number;
    shared_secret?: string;
    identity_secret?: string;
    revocation_code?: string;
    serial_number?: string;
    token_gid?: string;
    secret_1?: string;
    uri?: string;
    server_time?: string;
    account_name?: string;
    phone_number_hint?: string;
  };
}

/** Steam's status codes on AddAuthenticator, translated into something actionable. */
const ADD_STATUS: Record<number, string> = {
  2: 'Steam wants a phone number on this account before it will add an authenticator.',
  29: 'This account already has an authenticator. Remove the old one first, using its revocation code.',
  84: 'Steam is rate limiting you. Wait a few minutes and try again.',
};

export interface LinkStarted {
  /** Save this before going further. Losing it locks you out of the account. */
  secrets: AuthenticatorSecrets;
  /** Steam texts a code to the phone on the account. */
  phoneNumberHint?: string;
}

/**
 * Asks Steam to create an authenticator for the signed-in account.
 *
 * Steam returns the secrets straight away but does not activate them until you
 * confirm the SMS code. Write the revocation code down before calling
 * {@link finalizeLink}, because Steam will not show it again.
 */
export async function startLink(session: SessionTokens): Promise<LinkStarted> {
  const deviceId = generateDeviceId();

  const res = await callApi<AddAuthenticatorResponse>(SERVICE, 'AddAuthenticator', 1, {
    accessToken: session.accessToken,
    params: {
      steamid: session.steamId,
      authenticator_type: 1,
      device_identifier: deviceId,
      sms_phone_id: 1,
      version: 2,
    },
  });

  const r = res.response ?? {};
  if (r.status !== undefined && r.status !== 1) {
    throw new SteamError(
      ADD_STATUS[r.status] ?? `Steam refused to add an authenticator (status ${r.status}).`,
      'ADD_AUTHENTICATOR_FAILED',
      r.status,
    );
  }
  if (!r.shared_secret || !r.identity_secret || !r.revocation_code) {
    throw new SteamError('Steam did not return the authenticator secrets.', 'ADD_AUTHENTICATOR_FAILED');
  }

  return {
    secrets: {
      sharedSecret: r.shared_secret,
      identitySecret: r.identity_secret,
      steamId: session.steamId,
      accountName: r.account_name ?? `steam-${session.steamId}`,
      deviceId,
      revocationCode: r.revocation_code,
      ...(r.serial_number ? { serialNumber: r.serial_number } : {}),
      ...(r.token_gid ? { tokenGid: r.token_gid } : {}),
      ...(r.secret_1 ? { secret1: r.secret_1 } : {}),
      ...(r.uri ? { uri: r.uri } : {}),
      ...(r.server_time ? { serverTime: r.server_time } : {}),
      ...(r.phone_number_hint ? { phoneNumberHint: r.phone_number_hint } : {}),
    },
    ...(r.phone_number_hint ? { phoneNumberHint: r.phone_number_hint } : {}),
  };
}

interface FinalizeResponse {
  response: { success?: boolean; want_more?: boolean; status?: number; server_time?: string };
}

/**
 * Activates the authenticator with the code Steam texted to the phone.
 *
 * Steam sometimes wants a second code from a later time window, which is what
 * `want_more` means, so we walk the clock forward and try again.
 */
export async function finalizeLink(
  session: SessionTokens,
  secrets: AuthenticatorSecrets,
  smsCode: string,
  steamTimeNow: () => Promise<number>,
): Promise<void> {
  let time = await steamTimeNow();

  for (let attempt = 0; attempt < 10; attempt++) {
    const res = await callApi<FinalizeResponse>(SERVICE, 'FinalizeAddAuthenticator', 1, {
      accessToken: session.accessToken,
      params: {
        steamid: session.steamId,
        authenticator_code: generateCodeForTime(secrets.sharedSecret, time),
        authenticator_time: Math.floor(time),
        activation_code: smsCode.trim(),
        validate_sms_code: 1,
      },
    });

    const r = res.response ?? {};
    if (r.status === 89) {
      throw new SteamError('That SMS code is wrong. Check the message and try again.', 'BAD_SMS_CODE', 89);
    }
    if (r.status === 88 && attempt >= 2) {
      throw new SteamError(
        'Steam could not match the codes. Your clock is probably wrong, so sync it and start over.',
        'CLOCK_SKEW',
        88,
      );
    }
    if (r.success) return;

    if (r.want_more) {
      // Steam wants the code from the next window.
      time += 30;
      continue;
    }
    throw new SteamError('Steam would not activate the authenticator.', 'FINALIZE_FAILED', r.status);
  }
  throw new SteamError('Steam kept asking for more codes. Try again later.', 'FINALIZE_FAILED');
}

/**
 * Removes the authenticator from the account.
 *
 * @param scheme 1 puts the account back on emailed codes, 2 turns Steam Guard off
 */
export async function removeAuthenticator(
  session: SessionTokens,
  revocationCode: string,
  scheme: 1 | 2 = 1,
): Promise<void> {
  if (!revocationCode) {
    throw new SteamError(
      'Removing an authenticator needs its revocation code, and this account has none saved.',
      'NO_REVOCATION_CODE',
    );
  }

  const res = await callApi<{ response: { success?: boolean } }>(SERVICE, 'RemoveAuthenticator', 1, {
    accessToken: session.accessToken,
    params: {
      revocation_code: revocationCode,
      revocation_reason: 1,
      steamguard_scheme: scheme,
    },
  });

  if (!res.response?.success) {
    throw new SteamError('Steam refused to remove the authenticator.', 'REMOVE_FAILED');
  }
}

/** Asks Steam whether this account already has an authenticator. */
export async function authenticatorStatus(
  session: SessionTokens,
): Promise<{ hasAuthenticator: boolean; revocationAttemptsRemaining?: number }> {
  const res = await callApi<{
    response: { state?: number; revocation_attempts_remaining?: number };
  }>(SERVICE, 'QueryStatus', 1, {
    accessToken: session.accessToken,
    params: { steamid: session.steamId },
  });

  return {
    hasAuthenticator: res.response?.state === 1,
    ...(res.response?.revocation_attempts_remaining !== undefined
      ? { revocationAttemptsRemaining: res.response.revocation_attempts_remaining }
      : {}),
  };
}

/** A freshly linked account, ready to store. */
export function toStoredAccount(link: LinkStarted, session: SessionTokens): StoredAccount {
  return {
    secrets: link.secrets,
    session,
    fullyEnrolled: false,
    addedAt: new Date().toISOString(),
  };
}
