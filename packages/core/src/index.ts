/**
 * Steam Guard, as a library.
 *
 * Generates login codes, reads and answers trade confirmations, links and
 * unlinks authenticators, and keeps the secrets in an encrypted vault on this
 * machine. No runtime dependencies, so the code you audit is the code that runs.
 */

export type {
  AuthenticatorSecrets,
  Confirmation,
  ConfirmationKind,
  SessionTokens,
  SteamTimeSource,
  StoredAccount,
} from './types.js';
export { SteamError } from './types.js';

export { CODE_PERIOD_SECONDS, generateCodeForTime, periodProgress, secondsRemaining } from './totp.js';
export { SteamTime, steamTime } from './time.js';

export {
  confirmationHash,
  confirmationParams,
  fetchConfirmations,
  generateDeviceId,
  respondToConfirmation,
  respondToConfirmations,
} from './confirmation.js';
export type { ConfirmationContext, ConfirmationTag } from './confirmation.js';

export {
  decryptVault,
  encryptVault,
  KDF_DEFAULTS,
  safeEqual,
  WrongPassphraseError,
} from './crypto/vault.js';
export type { EncryptedVault, VaultHeader } from './crypto/vault.js';
export { encryptPassword } from './crypto/rsa.js';

export {
  beginLogin,
  DEFAULT_DEVICE_NAME,
  needsRefresh,
  pollLoginOnce,
  refreshAccessToken,
  submitGuardCode,
  tokenExpiry,
  waitForLogin,
} from './steam/auth.js';
export type { GuardRequirement, PendingLogin, PollResult, WaitOptions } from './steam/auth.js';

export {
  authenticatorStatus,
  finalizeLink,
  removeAuthenticator,
  startLink,
  toStoredAccount,
} from './steam/linker.js';
export type { LinkStarted } from './steam/linker.js';

export {
  callApi,
  communityGet,
  communityPost,
  MOBILE_USER_AGENT,
  sessionCookie,
  STEAM_API,
  STEAM_COMMUNITY,
} from './steam/api.js';
export {
  EAuthSessionGuardType,
  EAuthTokenPlatformType,
  EResult,
  ESessionPersistence,
  ETokenRenewalType,
} from './steam/enums.js';

export { inspectImport, MaFileError, parseMaFile, toMaFile } from './storage/mafile.js';
export {
  backupVault,
  DEFAULT_SETTINGS,
  defaultVaultPath,
  emptyVault,
  readVault,
  vaultExists,
  writeVault,
} from './storage/vaultfile.js';
export type { VaultContents, VaultSettings } from './storage/vaultfile.js';

export { Account } from './account.js';

export { DEFAULT_AUTO_CONFIRM, planAutoConfirm, RateCeiling, toAccept } from './autoconfirm.js';
export type { AutoAction, AutoConfirmRules, AutoDecision } from './autoconfirm.js';
