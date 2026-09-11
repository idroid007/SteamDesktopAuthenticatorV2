import { createHmac, randomUUID } from 'node:crypto';
import { communityGet, communityPost } from './steam/api.js';
import { SteamError } from './types.js';
import type { AuthenticatorSecrets, Confirmation, ConfirmationKind } from './types.js';

/**
 * Steam's confirmation types, from the mobile app.
 *
 * SDA v1 opened Steam's confirmation page inside an embedded Chromium control.
 * Steam later turned that page into a JSON endpoint, so the embed rendered a
 * blank white box and 42 issue threads piled up behind it. We read the JSON
 * and draw the list ourselves, so there is no browser to break.
 */
const CONFIRMATION_TYPES: Record<number, ConfirmationKind> = {
  1: 'generic',
  2: 'trade',
  3: 'market',
  4: 'feature-opt-out',
  5: 'phone-number-change',
  6: 'account-recovery',
  9: 'api-key',
};

/** Steam signs each confirmation request with a tag naming the operation. */
export type ConfirmationTag = 'conf' | 'details' | 'accept' | 'reject';

interface RawConfirmation {
  type: number;
  type_name?: string;
  id: string;
  creator_id: string;
  nonce: string;
  creation_time: number;
  cancel?: string;
  accept?: string;
  icon?: string;
  multi?: boolean;
  headline?: string;
  summary?: string[];
  warn?: string[] | null;
}

interface GetListResponse {
  success: boolean;
  needauth?: boolean;
  message?: string;
  conf?: RawConfirmation[];
}

interface AjaxOpResponse {
  success: boolean;
  message?: string;
  needauth?: boolean;
}

/**
 * Steam ties confirmations to the device that created the authenticator.
 * The format matches what the Android app produces.
 */
export function generateDeviceId(): string {
  return `android:${randomUUID()}`;
}

/**
 * Signs a confirmation request.
 *
 * The message is the 8-byte big-endian timestamp followed by the operation
 * tag, HMAC'd with the identity secret. Steam checks this to prove the request
 * came from a device holding the authenticator.
 */
export function confirmationHash(
  identitySecret: string,
  unixSeconds: number,
  tag: ConfirmationTag,
): string {
  const key = Buffer.from(identitySecret.replace(/\\\//g, '/').trim(), 'base64');
  if (key.length === 0) throw new Error('identity secret is not valid base64');

  const tagBytes = Buffer.from(tag, 'utf8').subarray(0, 32);
  const message = Buffer.alloc(8 + tagBytes.length);
  message.writeBigUInt64BE(BigInt(Math.floor(unixSeconds)));
  tagBytes.copy(message, 8);

  return createHmac('sha1', key).update(message).digest('base64');
}

/** The query Steam expects on every /mobileconf call. */
export function confirmationParams(
  secrets: Pick<AuthenticatorSecrets, 'identitySecret' | 'deviceId' | 'steamId'>,
  unixSeconds: number,
  tag: ConfirmationTag,
): Record<string, string> {
  if (!secrets.deviceId) {
    throw new SteamError(
      'This account has no device ID, so Steam will reject confirmations. Re-import it from a maFile that has one.',
      'NO_DEVICE_ID',
    );
  }
  return {
    p: secrets.deviceId,
    a: secrets.steamId,
    k: confirmationHash(secrets.identitySecret, unixSeconds, tag),
    t: String(Math.floor(unixSeconds)),
    m: 'react',
    tag,
  };
}

function toConfirmation(raw: RawConfirmation): Confirmation {
  const kind = CONFIRMATION_TYPES[raw.type] ?? 'unknown';
  const summary = (raw.summary ?? []).filter((s) => s.length > 0);
  return {
    id: raw.id,
    nonce: raw.nonce,
    kind,
    rawType: raw.type,
    creatorId: raw.creator_id,
    headline: raw.headline ?? raw.type_name ?? 'Steam confirmation',
    summary,
    when: formatAge(raw.creation_time),
    createdAt: raw.creation_time,
    ...(raw.icon ? { icon: raw.icon } : {}),
    ...(raw.cancel ? { cancelText: raw.cancel } : {}),
    ...(raw.accept ? { acceptText: raw.accept } : {}),
  };
}

function formatAge(createdAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000) - createdAt);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export interface ConfirmationContext {
  secrets: AuthenticatorSecrets;
  accessToken: string;
  /** Steam-corrected clock. */
  now: () => Promise<number>;
}

/** Everything waiting for approval on this account. */
export async function fetchConfirmations(ctx: ConfirmationContext): Promise<Confirmation[]> {
  const time = await ctx.now();
  const res = await communityGet<GetListResponse>(
    '/mobileconf/getlist',
    confirmationParams(ctx.secrets, time, 'conf'),
    { steamId: ctx.secrets.steamId, accessToken: ctx.accessToken },
  );

  if (res.needauth) {
    throw new SteamError('Your Steam session expired. Sign in again.', 'SESSION_EXPIRED');
  }
  if (!res.success) {
    // Steam says this when the clock is off or the identity secret is wrong.
    throw new SteamError(
      res.message ?? 'Steam refused the confirmation request.',
      'CONFIRMATIONS_FAILED',
    );
  }
  return (res.conf ?? []).map(toConfirmation);
}

/** Approve or refuse one confirmation. */
export async function respondToConfirmation(
  ctx: ConfirmationContext,
  confirmation: Pick<Confirmation, 'id' | 'nonce'>,
  decision: 'accept' | 'deny',
): Promise<void> {
  const time = await ctx.now();
  const op = decision === 'accept' ? 'allow' : 'cancel';
  const tag: ConfirmationTag = decision === 'accept' ? 'accept' : 'reject';

  const query = new URLSearchParams({
    op,
    ...confirmationParams(ctx.secrets, time, tag),
    cid: confirmation.id,
    ck: confirmation.nonce,
  });

  const res = await communityGet<AjaxOpResponse>(
    '/mobileconf/ajaxop',
    Object.fromEntries(query),
    { steamId: ctx.secrets.steamId, accessToken: ctx.accessToken },
  );

  if (!res.success) {
    throw new SteamError(
      res.message ?? `Steam refused to ${decision} that confirmation.`,
      'CONFIRMATION_REJECTED',
    );
  }
}

/**
 * Approve or refuse several at once.
 *
 * SDA v1 sent one request per confirmation, which trips Steam's rate limiter
 * when a trader clears a backlog. Steam accepts a batch on a single call.
 */
export async function respondToConfirmations(
  ctx: ConfirmationContext,
  confirmations: readonly Pick<Confirmation, 'id' | 'nonce'>[],
  decision: 'accept' | 'deny',
): Promise<void> {
  if (confirmations.length === 0) return;
  if (confirmations.length === 1) {
    return respondToConfirmation(ctx, confirmations[0]!, decision);
  }

  const time = await ctx.now();
  const op = decision === 'accept' ? 'allow' : 'cancel';
  const tag: ConfirmationTag = decision === 'accept' ? 'accept' : 'reject';

  const form = new URLSearchParams({ op, ...confirmationParams(ctx.secrets, time, tag) });
  for (const c of confirmations) {
    form.append('cid[]', c.id);
    form.append('ck[]', c.nonce);
  }

  const res = await communityPost<AjaxOpResponse>('/mobileconf/multiajaxop', form.toString(), {
    steamId: ctx.secrets.steamId,
    accessToken: ctx.accessToken,
  });

  if (!res.success) {
    throw new SteamError(
      res.message ?? `Steam refused to ${decision} those confirmations.`,
      'CONFIRMATION_REJECTED',
    );
  }
}
