import type { AuthenticatorSecrets, SessionTokens, StoredAccount } from '../types.js';

/**
 * The maFile shape written by SDA v1, the Android Steam app, and the tools
 * built around them. Field names drifted across versions, so we read every
 * spelling we have seen rather than rejecting a file over capitalisation.
 */
interface RawMaFile {
  shared_secret?: string;
  identity_secret?: string;
  account_name?: string;
  device_id?: string;
  revocation_code?: string;
  serial_number?: string;
  token_gid?: string;
  secret_1?: string;
  uri?: string;
  server_time?: string | number;
  status?: number;
  fully_enrolled?: boolean;
  phone_number_hint?: string;
  steamid?: string | number;
  Session?: RawSession;
  session?: RawSession;
}

interface RawSession {
  SteamID?: string | number;
  steamid?: string | number;
  SessionID?: string;
  AccessToken?: string;
  access_token?: string;
  RefreshToken?: string;
  refresh_token?: string;
  OAuthToken?: string;
  SteamLoginSecure?: string;
}

export class MaFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MaFileError';
  }
}

function str(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim().length > 0) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** Pulls the SteamID out of an `otpauth://` URI when the file omits it elsewhere. */
function steamIdFromUri(uri: string | undefined): string | undefined {
  if (!uri) return undefined;
  const match = /[?&]steamid=(\d{17})/i.exec(uri);
  return match?.[1];
}

/**
 * Recovers the SteamID from the raw text, before JSON.parse can damage it.
 *
 * A SteamID64 like 76561198000000001 is larger than Number.MAX_SAFE_INTEGER,
 * and maFiles store it as a bare JSON number. Parsing that into a double
 * rounds off the last digits, so two different accounts can collapse into one
 * ID and overwrite each other. Reading the digits as text keeps them intact.
 */
function steamIdFromText(json: string): string | undefined {
  const match = /"steam_?id"\s*:\s*"?(\d{17})"?/i.exec(json);
  return match?.[1];
}

/**
 * Reads an maFile into our own shape.
 *
 * @param json the file contents
 * @param sourceName shown in errors so a user with 30 files knows which one failed
 */
export function parseMaFile(json: string, sourceName = 'maFile'): StoredAccount {
  let raw: RawMaFile;
  try {
    raw = JSON.parse(json) as RawMaFile;
  } catch {
    throw new MaFileError(
      `${sourceName} is not valid JSON. If SDA encrypted it, decrypt it in SDA first.`,
    );
  }

  if (raw === null || typeof raw !== 'object') {
    throw new MaFileError(`${sourceName} does not look like an maFile.`);
  }

  const sharedSecret = str(raw.shared_secret);
  const identitySecret = str(raw.identity_secret);
  if (!sharedSecret) {
    throw new MaFileError(`${sourceName} has no shared_secret, so it cannot make login codes.`);
  }

  const session = raw.Session ?? raw.session;
  // Text first, because JSON.parse rounds 17-digit SteamIDs.
  const steamId =
    steamIdFromText(json) ??
    str(raw.steamid) ??
    str(session?.SteamID) ??
    str(session?.steamid) ??
    steamIdFromUri(str(raw.uri));

  if (!steamId) {
    throw new MaFileError(
      `${sourceName} has no SteamID. Confirmations need one, so re-export this account from SDA.`,
    );
  }

  const secrets: AuthenticatorSecrets = {
    sharedSecret,
    identitySecret: identitySecret ?? '',
    steamId,
    accountName: str(raw.account_name) ?? `steam-${steamId}`,
    deviceId: str(raw.device_id) ?? '',
    revocationCode: str(raw.revocation_code) ?? '',
    ...(str(raw.serial_number) ? { serialNumber: str(raw.serial_number)! } : {}),
    ...(str(raw.token_gid) ? { tokenGid: str(raw.token_gid)! } : {}),
    ...(str(raw.secret_1) ? { secret1: str(raw.secret_1)! } : {}),
    ...(str(raw.uri) ? { uri: str(raw.uri)! } : {}),
    ...(str(raw.server_time) ? { serverTime: str(raw.server_time)! } : {}),
    ...(str(raw.phone_number_hint) ? { phoneNumberHint: str(raw.phone_number_hint)! } : {}),
  };

  const accessToken = str(session?.AccessToken) ?? str(session?.access_token);
  const refreshToken = str(session?.RefreshToken) ?? str(session?.refresh_token);
  const tokens: SessionTokens | undefined =
    accessToken && refreshToken ? { steamId, accessToken, refreshToken } : undefined;

  return {
    secrets,
    ...(tokens ? { session: tokens } : {}),
    fullyEnrolled: raw.fully_enrolled ?? raw.status === 1,
    addedAt: new Date().toISOString(),
  };
}

/** Warnings worth showing after an import, without blocking it. */
export function inspectImport(account: StoredAccount): string[] {
  const notes: string[] = [];
  if (!account.secrets.identitySecret) {
    notes.push('No identity_secret, so this account can make login codes but not confirm trades.');
  }
  if (!account.secrets.deviceId) {
    notes.push('No device_id. Steam will refuse confirmations until you re-import a file that has one.');
  }
  if (!account.secrets.revocationCode) {
    notes.push('No revocation code. Without it you cannot remove the authenticator yourself.');
  }
  return notes;
}

/**
 * Writes an maFile that SDA v1 and steamguard-cli can both read.
 *
 * Your data belongs to you, so exporting is a first-class feature rather than
 * something you reverse-engineer out of our storage format.
 */
export function toMaFile(account: StoredAccount): string {
  const s = account.secrets;
  const body: Record<string, unknown> = {
    shared_secret: s.sharedSecret,
    serial_number: s.serialNumber ?? '',
    revocation_code: s.revocationCode,
    uri: s.uri ?? '',
    server_time: Number(s.serverTime ?? 0),
    account_name: s.accountName,
    token_gid: s.tokenGid ?? '',
    identity_secret: s.identitySecret,
    secret_1: s.secret1 ?? '',
    status: account.fullyEnrolled ? 1 : 0,
    device_id: s.deviceId,
    fully_enrolled: account.fullyEnrolled,
    Session: {
      SteamID: STEAMID_PLACEHOLDER,
      AccessToken: account.session?.accessToken ?? '',
      RefreshToken: account.session?.refreshToken ?? '',
      SessionID: '',
      WebCookie: '',
      OAuthToken: '',
    },
  };

  // SDA v1 writes SteamID as a bare number, and the value is too large for a
  // JS double to hold exactly. We serialise a placeholder and swap the real
  // digits in, so the file carries the full ID rather than a rounded one.
  return JSON.stringify(body, null, 2).replace(
    `"${STEAMID_PLACEHOLDER}"`,
    /^\d{1,20}$/.test(s.steamId) ? s.steamId : '0',
  );
}

const STEAMID_PLACEHOLDER = '__SDA_STEAMID__';
