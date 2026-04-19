export {
  UnknownKekVersionError,
  knownKekVersions,
  shardCountFor,
  shardId,
} from './sharding.js';

export {
  DEK_BYTES,
  GCM_AUTH_TAG_BYTES,
  GCM_NONCE_BYTES,
  DekInvariantError,
  type DekCiphertext,
  decryptWithDek,
  encryptWithDek,
  generateDek,
  zeroize,
} from './dek.js';

export {
  KMS_MAX_ATTEMPTS,
  type KmsCallOptions,
  type KmsDeps,
  type KmsError,
  type KmsOperation,
  defaultJitterMs,
  defaultSleep,
  kekAlias,
  kmsDecrypt,
  kmsEncrypt,
} from './kek.js';

export {
  MAX_DEK_CACHE_TTL_MS,
  type Envelope,
  type EnvelopeDeps,
  type WrapInput,
  type UnwrapInput,
  EnvelopeCrypto,
} from './envelope.js';
