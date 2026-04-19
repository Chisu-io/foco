export {
  type LLMCallError,
  type LLMErrorCode,
  LLM_ERROR_CODES,
  DEFAULT_USER_MESSAGES,
  ERROR_CODES_COMPLETE,
  make,
  assertNever,
} from './taxonomy.js';

export {
  type ProviderName,
  type NetworkErrorKind,
  type KmsErrorHint,
  classifyProviderHttpError,
  classifyKmsError,
  classifyNetworkError,
} from './classify.js';
