/**
 * Barrel for the accounting layer.
 *
 * Iter 7 commit 2 shipped the `ConsentResolver` DI seam.
 * Iter 7 commit 3 (this) adds the `UsageRecorder` writer + `UsageBuffer`
 * + `prompt-hash` canonicaliser + the `llm.accounting.write` sub-span.
 * Commit 4 will wire both seams into `plan-router.route()`.
 *
 * Consumers outside `packages/llm-client/` (notably the iter 8 facade
 * and `apps/web` concrete implementations) import from the package's
 * public surface — see `src/index.ts`.
 */

export {
  CONSENT_RESOLVED_COUNTER,
  DEFAULT_CONSENT_CACHE_MAX_ENTRIES,
  DEFAULT_CONSENT_CACHE_TTL_MS,
  createConsentResolverFromRepo,
  type ConsentClock,
  type ConsentResolver,
  type ConsentResolverDeps,
  type ConsentSource,
} from './consent.js';

export {
  PROMPT_HASH_SEPARATOR,
  hashNormalizedRequest,
} from './prompt-hash.js';

export {
  DEFAULT_BUFFER_CAPACITY,
  USAGE_BUFFER_SIZE_GAUGE,
  USAGE_WRITE_SPAN_NAME,
  USAGE_WRITES_COUNTER,
  USAGE_WRITES_DROPPED_COUNTER,
  USAGE_WRITES_FAILED_COUNTER,
  UsageBuffer,
  classifyWriterFailure,
  createUsageRecorder,
  type FundingMode,
  type UsageEntry,
  type UsageRecorder,
  type UsageRecorderDeps,
  type UsageWriteFailureReason,
  type UsageWriteResult,
  type UsageWriter,
} from './usage-counter.js';
