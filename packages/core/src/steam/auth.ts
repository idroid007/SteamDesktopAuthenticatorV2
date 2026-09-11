import { encryptPassword } from '../crypto/rsa.js';
import { SteamError } from '../types.js';
import type { SessionTokens } from '../types.js';
import { callApi } from './api.js';
import { EAuthSessionGuardType, EAuthTokenPlatformType, ESessionPersistence, ETokenRenewalType } from './enums.js';

const SERVICE = 'IAuthenticationService';

interface RsaKeyResponse {
  response: { publickey_mod: string; publickey_exp: string; timestamp: string };
}

interface AllowedConfirmation {
  confirmation_type: number;
  associated_message?: string;
}

interface BeginSessionResponse {
  response: {
    client_id?: string;
    request_id?: string;
    interval?: number;
    allowed_confirmations?: AllowedConfirmation[];
    steamid?: string;
    weak_token?: string;
    extended_error_message?: string;
  };
}

interface PollResponse {
  response: {
    new_client_id?: string;
    new_challenge_url?: string;
    refresh_token?: string;
    access_token?: string;
    had_remote_interaction?: boolean;
    account_name?: string;
  };
}

/** What Steam wants before it will hand over tokens. */
export type GuardRequirement =
  | { kind: 'none' }
  | { kind: 'device-code' }
  | { kind: 'email-code'; sentTo?: string }
  | { kind: 'device-confirmation' }
  | { kind: 'email-confirmation'; sentTo?: string };

export interface PendingLogin {
  clientId: string;
  requestId: string;
  steamId: string;
  /** Seconds Steam asks us to wait between polls. */
  pollInterval: number;
  guard: GuardRequirement;
}

/** Shown in the account's list of authorised devices on Steam. */
export const DEFAULT_DEVICE_NAME = 'Steam Desktop Authenticator V2';

function readGuard(confirmations: AllowedConfirmation[] | undefined): GuardRequirement {
  const types = confirmations ?? [];
  const find = (t: number) => types.find((c) => c.confirmation_type === t);

  const deviceCode = find(EAuthSessionGuardType.DeviceCode);
  if (deviceCode) return { kind: 'device-code' };

  const emailCode = find(EAuthSessionGuardType.EmailCode);
  if (emailCode) {
    return emailCode.associated_message
      ? { kind: 'email-code', sentTo: emailCode.associated_message }
      : { kind: 'email-code' };
  }

  const deviceConf = find(EAuthSessionGuardType.DeviceConfirmation);
  if (deviceConf) return { kind: 'device-confirmation' };

  const emailConf = find(EAuthSessionGuardType.EmailConfirmation);
  if (emailConf) {
    return emailConf.associated_message
      ? { kind: 'email-confirmation', sentTo: emailConf.associated_message }
      : { kind: 'email-confirmation' };
  }

  return { kind: 'none' };
}

/**
 * Starts a login.
 *
 * Steam hands out a short-lived RSA key per attempt, so the password is
 * encrypted before it leaves this machine and the plaintext never touches
 * the network or the disk.
 */
export async function beginLogin(
  accountName: string,
  password: string,
  deviceName = DEFAULT_DEVICE_NAME,
): Promise<PendingLogin> {
  const rsa = await callApi<RsaKeyResponse>(SERVICE, 'GetPasswordRSAPublicKey', 1, {
    method: 'GET',
    params: { account_name: accountName },
  });

  const { publickey_mod, publickey_exp, timestamp } = rsa.response ?? {};
  if (!publickey_mod || !publickey_exp) {
    throw new SteamError('Steam did not return a login key for that account name.', 'NO_RSA_KEY');
  }

  const encrypted = encryptPassword(password, publickey_mod, publickey_exp);

  const begin = await callApi<BeginSessionResponse>(SERVICE, 'BeginAuthSessionViaCredentials', 1, {
    params: {
      account_name: accountName,
      encrypted_password: encrypted,
      encryption_timestamp: timestamp,
      remember_login: 1,
      persistence: ESessionPersistence.Persistent,
      // The mobile platform type is what unlocks trade confirmations later.
      platform_type: EAuthTokenPlatformType.MobileApp,
      device_friendly_name: deviceName,
      website_id: 'Mobile',
    },
  });

  const r = begin.response ?? {};
  if (!r.client_id || !r.request_id || !r.steamid) {
    throw new SteamError(
      r.extended_error_message ?? 'Steam rejected that account name or password.',
      'LOGIN_REJECTED',
    );
  }

  return {
    clientId: r.client_id,
    requestId: r.request_id,
    steamId: r.steamid,
    pollInterval: r.interval && r.interval > 0 ? r.interval : 5,
    guard: readGuard(r.allowed_confirmations),
  };
}

/** Hands Steam the 5-character code from the authenticator, or an emailed one. */
export async function submitGuardCode(
  pending: PendingLogin,
  code: string,
  codeType: 'device' | 'email' = 'device',
): Promise<void> {
  await callApi(SERVICE, 'UpdateAuthSessionWithSteamGuardCode', 1, {
    params: {
      client_id: pending.clientId,
      steamid: pending.steamId,
      code: code.trim().toUpperCase(),
      code_type:
        codeType === 'device' ? EAuthSessionGuardType.DeviceCode : EAuthSessionGuardType.EmailCode,
    },
  });
}

export interface PollResult {
  status: 'pending' | 'complete';
  tokens?: SessionTokens;
}

/** Asks Steam once whether the login finished. */
export async function pollLoginOnce(pending: PendingLogin): Promise<PollResult> {
  const res = await callApi<PollResponse>(SERVICE, 'PollAuthSessionStatus', 1, {
    params: { client_id: pending.clientId, request_id: pending.requestId },
  });

  const r = res.response ?? {};
  if (r.refresh_token && r.access_token) {
    return {
      status: 'complete',
      tokens: withExpiry({
        steamId: pending.steamId,
        accessToken: r.access_token,
        refreshToken: r.refresh_token,
      }),
    };
  }
  return { status: 'pending' };
}

export interface WaitOptions {
  /** Give up after this long. Steam sessions themselves expire in a few minutes. */
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Called before each poll, so a UI can count down. */
  onPoll?: (attempt: number) => void;
}

/** Polls until Steam completes the login or the wait runs out. */
export async function waitForLogin(
  pending: PendingLogin,
  { timeoutMs = 3 * 60_000, signal, onPoll }: WaitOptions = {},
): Promise<SessionTokens> {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    if (signal?.aborted) throw new SteamError('Login cancelled.', 'CANCELLED');
    onPoll?.(++attempt);

    const result = await pollLoginOnce(pending);
    if (result.status === 'complete' && result.tokens) return result.tokens;

    await sleep(pending.pollInterval * 1000, signal);
  }
  throw new SteamError('Steam did not confirm the login in time. Start again.', 'LOGIN_TIMEOUT');
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new SteamError('Login cancelled.', 'CANCELLED'));
      },
      { once: true },
    );
  });
}

/**
 * Trades a refresh token for a fresh access token.
 *
 * Access tokens last about a day. SDA v1 handled expiry poorly, which is where
 * the "stuck on Login again" reports came from. We renew in the background and
 * only ask for a password when the refresh token itself runs out.
 */
export async function refreshAccessToken(tokens: SessionTokens): Promise<SessionTokens> {
  const res = await callApi<{ response: { access_token?: string; refresh_token?: string } }>(
    SERVICE,
    'GenerateAccessTokenForApp',
    1,
    {
      params: {
        refresh_token: tokens.refreshToken,
        steamid: tokens.steamId,
        renewal_type: ETokenRenewalType.None,
      },
    },
  );

  const accessToken = res.response?.access_token;
  if (!accessToken) {
    throw new SteamError('Steam would not renew this session. Sign in again.', 'REFRESH_FAILED');
  }
  return withExpiry({
    ...tokens,
    accessToken,
    ...(res.response?.refresh_token ? { refreshToken: res.response.refresh_token } : {}),
  });
}

/** Reads the `exp` claim without verifying the signature. Steam holds the key. */
export function tokenExpiry(jwt: string): number | undefined {
  const payload = jwt.split('.')[1];
  if (!payload) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: number;
    };
    return typeof decoded.exp === 'number' ? decoded.exp : undefined;
  } catch {
    return undefined;
  }
}

function withExpiry(tokens: SessionTokens): SessionTokens {
  const access = tokenExpiry(tokens.accessToken);
  const refresh = tokenExpiry(tokens.refreshToken);
  return {
    ...tokens,
    ...(access ? { accessTokenExpires: access } : {}),
    ...(refresh ? { refreshTokenExpires: refresh } : {}),
  };
}

/** True when the access token has expired or is about to. */
export function needsRefresh(tokens: SessionTokens, skewSeconds = 300): boolean {
  if (!tokens.accessTokenExpires) return true;
  return Math.floor(Date.now() / 1000) + skewSeconds >= tokens.accessTokenExpires;
}
