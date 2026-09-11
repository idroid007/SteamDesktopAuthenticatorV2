import { SteamError } from '../types.js';
import { EResult } from './enums.js';

export const STEAM_API = 'https://api.steampowered.com';
export const STEAM_COMMUNITY = 'https://steamcommunity.com';

/**
 * Steam's mobile app identifies itself this way. The /mobileconf endpoints
 * check it, so confirmations fail without it.
 */
export const MOBILE_USER_AGENT = 'Dalvik/2.1.0 (Linux; U; Android 9; Valve Steam App Version/3)';

const DEFAULT_TIMEOUT_MS = 20_000;

export interface ApiCallOptions {
  method?: 'GET' | 'POST';
  params?: Record<string, string | number | undefined>;
  accessToken?: string;
  timeoutMs?: number;
  headers?: Record<string, string>;
}

function formBody(params: Record<string, string | number | undefined>): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined) usp.set(k, String(v));
  }
  return usp.toString();
}

/**
 * Calls a Steam WebAPI service method.
 *
 * Steam exposes these as protobuf services, and most libraries pull in a
 * protobuf runtime to talk to them. Steam also accepts plain form-encoded
 * fields and answers with JSON, which is what we do. That keeps this package
 * at zero runtime dependencies, so there is less code for you to audit and
 * less for an attacker to slip something into.
 */
export async function callApi<T>(
  service: string,
  method: string,
  version: number,
  options: ApiCallOptions = {},
): Promise<T> {
  const {
    method: httpMethod = 'POST',
    params = {},
    accessToken,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const url = new URL(`${STEAM_API}/${service}/${method}/v${version}/`);
  if (accessToken) url.searchParams.set('access_token', accessToken);

  const headers: Record<string, string> = {
    'user-agent': MOBILE_USER_AGENT,
    accept: 'application/json',
    ...options.headers,
  };

  let body: string | undefined;
  if (httpMethod === 'GET') {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  } else {
    headers['content-type'] = 'application/x-www-form-urlencoded; charset=UTF-8';
    body = formBody(params);
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method: httpMethod,
      headers,
      ...(body === undefined ? {} : { body }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed';
    throw new SteamError(`The request to Steam ${reason}. Check your connection.`, 'NETWORK');
  }

  // Steam reports protobuf service errors in a header, not the body.
  const eresultHeader = res.headers.get('x-eresult');
  const eresult = eresultHeader ? Number(eresultHeader) : undefined;
  const errorMessage = res.headers.get('x-error_message') ?? undefined;

  if (eresult !== undefined && eresult !== 1) {
    throw new SteamError(
      EResult[eresult] ?? errorMessage ?? `Steam returned error ${eresult}.`,
      'ERESULT',
      eresult,
      res.status,
    );
  }

  if (!res.ok) {
    throw new SteamError(
      `Steam answered ${res.status} for ${service}/${method}.`,
      'HTTP',
      eresult,
      res.status,
    );
  }

  const text = await res.text();
  if (text.trim().length === 0) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SteamError('Steam sent a response we could not read.', 'BAD_JSON', eresult, res.status);
  }
}

/**
 * Steam authenticates community requests with a cookie built from the SteamID
 * and access token. The mobile app does the same thing.
 */
export function sessionCookie(steamId: string, accessToken: string): string {
  return `steamLoginSecure=${encodeURIComponent(`${steamId}||${accessToken}`)}`;
}

export interface CommunityRequestOptions {
  steamId: string;
  accessToken: string;
  timeoutMs?: number;
}

/** GET against steamcommunity.com carrying a mobile session. */
export async function communityGet<T>(
  path: string,
  query: Record<string, string>,
  opts: CommunityRequestOptions,
): Promise<T> {
  const url = new URL(path, STEAM_COMMUNITY);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  return communityFetch<T>(url, { method: 'GET' }, opts);
}

/** POST a form to steamcommunity.com carrying a mobile session. */
export async function communityPost<T>(
  path: string,
  form: string,
  opts: CommunityRequestOptions,
): Promise<T> {
  const url = new URL(path, STEAM_COMMUNITY);
  return communityFetch<T>(
    url,
    {
      method: 'POST',
      body: form,
      headers: { 'content-type': 'application/x-www-form-urlencoded; charset=UTF-8' },
    },
    opts,
  );
}

async function communityFetch<T>(
  url: URL,
  init: RequestInit & { headers?: Record<string, string> },
  { steamId, accessToken, timeoutMs = DEFAULT_TIMEOUT_MS }: CommunityRequestOptions,
): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        'user-agent': MOBILE_USER_AGENT,
        accept: 'application/json, text/plain, */*',
        origin: STEAM_COMMUNITY,
        referer: `${STEAM_COMMUNITY}/mobileconf/conf`,
        cookie: `${sessionCookie(steamId, accessToken)}; mobileClient=android; mobileClientVersion=777777 3.6.4`,
        ...init.headers,
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const reason = err instanceof Error && err.name === 'TimeoutError' ? 'timed out' : 'failed';
    throw new SteamError(`The request to Steam ${reason}. Check your connection.`, 'NETWORK');
  }

  // A redirect to the login page means the session died.
  if (res.status >= 300 && res.status < 400) {
    throw new SteamError(
      'Your Steam session expired. Sign in again.',
      'SESSION_EXPIRED',
      undefined,
      res.status,
    );
  }
  if (res.status === 401 || res.status === 403) {
    throw new SteamError(
      'Your Steam session expired. Sign in again.',
      'SESSION_EXPIRED',
      undefined,
      res.status,
    );
  }
  if (!res.ok) {
    throw new SteamError(`Steam answered ${res.status}.`, 'HTTP', undefined, res.status);
  }

  const text = await res.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    // Steam serves an HTML login page when the cookie is stale.
    if (text.includes('<!DOCTYPE') || text.includes('<html')) {
      throw new SteamError('Your Steam session expired. Sign in again.', 'SESSION_EXPIRED');
    }
    throw new SteamError('Steam sent a response we could not read.', 'BAD_JSON');
  }
}
