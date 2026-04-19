/**
 * Hardcoded defaults for the 13 GrowthBook feature flags defined in
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` §16}.
 *
 * These values are the fail-safe the worker boots with when GrowthBook
 * is unreachable AND the operator has set
 * `LLM_CLIENT_ALLOW_FLAG_FALLBACK=true` during an incident. Under
 * normal operation the values come from GrowthBook and are validated
 * against this same schema (see `./flag-validation.ts`).
 *
 * **Do not** treat these as "the current production values" — they
 * are the **doc defaults**. Current values live in GrowthBook and are
 * auditable via the `llm.flag_changed` entry.
 *
 * **Hard-caps of §16** (cannot be raised via flag — raising requires
 * a PR to `LLM_CLIENT.md`, re-review, and re-signing):
 *  - `llm.kms.retry_count` max is **1**.
 *  - `llm.dek_cache.ttl_seconds` max is **300**.
 */

/** Name of every flag defined in §16. */
export type LLMFlagName =
  | 'llm.circuit_breaker.error_threshold'
  | 'llm.circuit_breaker.volume_threshold'
  | 'llm.circuit_breaker.window_seconds'
  | 'llm.circuit_breaker.open_cooldown_seconds'
  | 'llm.circuit_breaker.half_open_probes'
  | 'llm.kms.retry_count'
  | 'llm.kms.retry_jitter_ms_min'
  | 'llm.kms.retry_jitter_ms_max'
  | 'llm.dek_cache.ttl_seconds'
  | 'llm.idempotency.ttl_seconds'
  | 'llm.abuse.tokens_per_hour_free'
  | 'llm.abuse.sustained_hours'
  | 'llm.abuse.duplicate_prompt_hash_per_day';

/**
 * Metadata about a flag: default value, legal range, brief prose, and
 * whether the `max` is a doc-level hard-cap (immutable via flag).
 */
export interface LLMFlagSpec {
  readonly name: LLMFlagName;
  readonly default: number;
  readonly min: number;
  readonly max: number;
  readonly hardCap: boolean;
  readonly description: string;
}

/**
 * Full schema of §16. Frozen so no consumer can mutate the table at
 * runtime.
 */
export const LLM_FLAGS = Object.freeze({
  'llm.circuit_breaker.error_threshold': Object.freeze({
    name: 'llm.circuit_breaker.error_threshold',
    default: 0.3,
    min: 0.05,
    max: 0.9,
    hardCap: false,
    description: 'Error rate (0–1) at which the CB opens.',
  }),
  'llm.circuit_breaker.volume_threshold': Object.freeze({
    name: 'llm.circuit_breaker.volume_threshold',
    default: 20,
    min: 5,
    max: 500,
    hardCap: false,
    description: 'Minimum request count in window before CB evaluates.',
  }),
  'llm.circuit_breaker.window_seconds': Object.freeze({
    name: 'llm.circuit_breaker.window_seconds',
    default: 60,
    min: 10,
    max: 600,
    hardCap: false,
    description: 'CB sliding window length in seconds.',
  }),
  'llm.circuit_breaker.open_cooldown_seconds': Object.freeze({
    name: 'llm.circuit_breaker.open_cooldown_seconds',
    default: 30,
    min: 5,
    max: 300,
    hardCap: false,
    description: 'Time in `open` before transitioning to `half-open`.',
  }),
  'llm.circuit_breaker.half_open_probes': Object.freeze({
    name: 'llm.circuit_breaker.half_open_probes',
    default: 3,
    min: 1,
    max: 20,
    hardCap: false,
    description: 'Probe requests allowed while CB is `half-open`.',
  }),
  'llm.kms.retry_count': Object.freeze({
    name: 'llm.kms.retry_count',
    default: 1,
    min: 0,
    max: 1,
    hardCap: true,
    description:
      'Retries on `kms_unavailable { transient: true }`. Hard-capped ' +
      'at 1 by §2 invariant 5 — raising requires a PR to LLM_CLIENT.md.',
  }),
  'llm.kms.retry_jitter_ms_min': Object.freeze({
    name: 'llm.kms.retry_jitter_ms_min',
    default: 50,
    min: 10,
    max: 500,
    hardCap: false,
    description: 'Lower bound of KMS retry jitter (ms).',
  }),
  'llm.kms.retry_jitter_ms_max': Object.freeze({
    name: 'llm.kms.retry_jitter_ms_max',
    default: 250,
    min: 50,
    max: 2000,
    hardCap: false,
    description:
      'Upper bound of KMS retry jitter (ms). Must be > retry_jitter_ms_min.',
  }),
  'llm.dek_cache.ttl_seconds': Object.freeze({
    name: 'llm.dek_cache.ttl_seconds',
    default: 300,
    min: 60,
    max: 300,
    hardCap: true,
    description:
      'TTL of the in-process DEK cache. Hard-capped at 300s (5min) by ' +
      '§2 invariant 8.',
  }),
  'llm.idempotency.ttl_seconds': Object.freeze({
    name: 'llm.idempotency.ttl_seconds',
    default: 600,
    min: 60,
    max: 3600,
    hardCap: false,
    description: 'TTL of the idempotency cache in Redis (seconds).',
  }),
  'llm.abuse.tokens_per_hour_free': Object.freeze({
    name: 'llm.abuse.tokens_per_hour_free',
    default: 10_000,
    min: 1_000,
    max: 1_000_000,
    hardCap: false,
    description: 'Hourly token ceiling before abuse heuristics fire (Free/Creator).',
  }),
  'llm.abuse.sustained_hours': Object.freeze({
    name: 'llm.abuse.sustained_hours',
    default: 3,
    min: 1,
    max: 24,
    hardCap: false,
    description: 'Consecutive hours above token ceiling before audit entry.',
  }),
  'llm.abuse.duplicate_prompt_hash_per_day': Object.freeze({
    name: 'llm.abuse.duplicate_prompt_hash_per_day',
    default: 100,
    min: 10,
    max: 10_000,
    hardCap: false,
    description: 'Anti-scraping: duplicate prompt hashes per user per day.',
  }),
}) satisfies Readonly<Record<LLMFlagName, LLMFlagSpec>>;

/**
 * Concrete runtime values for every flag. This is what the rest of
 * the package consumes — `LLMFlagSpec` is metadata, `LLMFlagValues`
 * is a record of numbers keyed by name.
 */
export type LLMFlagValues = {
  readonly [K in LLMFlagName]: number;
};

/**
 * The defaults of §16 as a plain `LLMFlagValues` record. Use this as
 * the fail-safe when `LLM_CLIENT_ALLOW_FLAG_FALLBACK=true` during a
 * GrowthBook outage. Frozen — mutating throws in strict mode.
 */
export const FLAG_DEFAULTS: LLMFlagValues = Object.freeze({
  'llm.circuit_breaker.error_threshold': LLM_FLAGS['llm.circuit_breaker.error_threshold'].default,
  'llm.circuit_breaker.volume_threshold':
    LLM_FLAGS['llm.circuit_breaker.volume_threshold'].default,
  'llm.circuit_breaker.window_seconds':
    LLM_FLAGS['llm.circuit_breaker.window_seconds'].default,
  'llm.circuit_breaker.open_cooldown_seconds':
    LLM_FLAGS['llm.circuit_breaker.open_cooldown_seconds'].default,
  'llm.circuit_breaker.half_open_probes':
    LLM_FLAGS['llm.circuit_breaker.half_open_probes'].default,
  'llm.kms.retry_count': LLM_FLAGS['llm.kms.retry_count'].default,
  'llm.kms.retry_jitter_ms_min': LLM_FLAGS['llm.kms.retry_jitter_ms_min'].default,
  'llm.kms.retry_jitter_ms_max': LLM_FLAGS['llm.kms.retry_jitter_ms_max'].default,
  'llm.dek_cache.ttl_seconds': LLM_FLAGS['llm.dek_cache.ttl_seconds'].default,
  'llm.idempotency.ttl_seconds': LLM_FLAGS['llm.idempotency.ttl_seconds'].default,
  'llm.abuse.tokens_per_hour_free': LLM_FLAGS['llm.abuse.tokens_per_hour_free'].default,
  'llm.abuse.sustained_hours': LLM_FLAGS['llm.abuse.sustained_hours'].default,
  'llm.abuse.duplicate_prompt_hash_per_day':
    LLM_FLAGS['llm.abuse.duplicate_prompt_hash_per_day'].default,
});

/** Exhaustive list of every flag name. Useful for iteration in tests. */
export const LLM_FLAG_NAMES = Object.freeze(
  Object.keys(LLM_FLAGS) as readonly LLMFlagName[],
);
