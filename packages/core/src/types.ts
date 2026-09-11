/** A Steam account's authenticator secrets, as stored by Steam's mobile app. */
export interface AuthenticatorSecrets {
  /** Base64. Seeds the 5-character login code. */
  sharedSecret: string;
  /** Base64. Signs trade and market confirmation requests. */
  identitySecret: string;
  /** 64-bit SteamID, as a decimal string. */
  steamId: string;
  /** Steam login name. */
  accountName: string;
  /** Looks like `android:8e9f...`. Steam ties confirmations to it. */
  deviceId: string;
  /** The `R-XXXXX-XXXXX-XXXXX` code that removes the authenticator. Losing it locks you out. */
  revocationCode: string;
  serialNumber?: string;
  tokenGid?: string;
  secret1?: string;
  uri?: string;
  /** Steam sends this when the authenticator is not yet active. */
  serverTime?: string;
  phoneNumberHint?: string;
}

/** Tokens from a Steam login. Access tokens last about a day, refresh tokens far longer. */
export interface SessionTokens {
  steamId: string;
  accessToken: string;
  refreshToken: string;
  /** Unix seconds, decoded from the access token's `exp` claim. */
  accessTokenExpires?: number;
  refreshTokenExpires?: number;
}

export interface StoredAccount {
  secrets: AuthenticatorSecrets;
  session?: SessionTokens;
  /** Set once the authenticator is live on the account. */
  fullyEnrolled: boolean;
  /** User-chosen label shown in the UI. Falls back to accountName. */
  label?: string;
  addedAt: string;
}

export type ConfirmationKind =
  | 'unknown'
  | 'generic'
  | 'trade'
  | 'market'
  | 'feature-opt-out'
  | 'phone-number-change'
  | 'account-recovery'
  | 'api-key';

export interface Confirmation {
  id: string;
  /** Steam calls this the nonce. Needed to accept or deny. */
  nonce: string;
  kind: ConfirmationKind;
  rawType: number;
  /** Trade offer ID for trades, listing ID for market listings. */
  creatorId: string;
  /** "Sell - AK-47 | Redline" or a trade partner's name. */
  headline: string;
  /** Extra lines Steam supplies, such as the item name and price. */
  summary: string[];
  /** "2 minutes ago" style string from Steam. */
  when: string;
  createdAt: number;
  icon?: string;
  /** Steam marks some confirmations as cancel-only. */
  cancelText?: string;
  acceptText?: string;
  /** Present on trade confirmations. Lets the UI link to a reputation check. */
  tradePartnerSteamId?: string;
}

export interface SteamTimeSource {
  /** Unix seconds, corrected for clock drift against Steam's server. */
  now(): Promise<number>;
}

export class SteamError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly eresult?: number,
    readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'SteamError';
  }
}
