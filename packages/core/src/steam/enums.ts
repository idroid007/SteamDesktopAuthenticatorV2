/** From steammessages_auth.steamclient.proto. */
export const EAuthTokenPlatformType = {
  Unknown: 0,
  SteamClient: 1,
  WebBrowser: 2,
  MobileApp: 3,
} as const;

export const EAuthSessionGuardType = {
  Unknown: 0,
  None: 1,
  EmailCode: 2,
  DeviceCode: 3,
  DeviceConfirmation: 4,
  EmailConfirmation: 5,
  MachineToken: 6,
  LegacyMachineAuth: 7,
} as const;

export const ESessionPersistence = { Ephemeral: 0, Persistent: 1 } as const;

export const ETokenRenewalType = { None: 0, Allow: 1 } as const;

/** Steam's result codes. We surface the ones a user can act on. */
export const EResult: Record<number, string> = {
  1: 'OK',
  2: 'Steam had a general failure.',
  5: 'Steam rejected that password.',
  15: 'Steam denied access to this account.',
  16: 'Steam timed out. Try again.',
  20: 'Steam is having service trouble. Try again shortly.',
  65: 'That Steam Guard code is wrong.',
  84: 'Steam is rate limiting you. Wait a few minutes.',
  85: 'This account needs a Steam Guard code.',
  86: 'That recovery code is wrong.',
  87: 'Steam already used that code.',
  88: 'Steam could not match the two-factor code.',
};
