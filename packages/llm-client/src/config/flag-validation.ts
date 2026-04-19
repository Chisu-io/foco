/**
 * Flag validation and emergency fallback loader.
 *
 * Implements the two validation layers of
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` §16}:
 *
 *  1. **Fail-fast at worker boot.** Every flag value must satisfy
 *     `[min, max]` from §16 **and** the cross-invariants
 *     (`retry_jitter_ms_min < retry_jitter_ms_max`,
 *     `open_cooldown_seconds ≤ window_seconds × 5`). Hard-caps
 *     (`retry_count ≤ 1`, `dek_cache.ttl_seconds ≤ 300`) are baked
 *     into the per-flag `max` and cannot be moved by flag toggle.
 *  2. **Emergency fallback.** When GrowthBook is unreachable during
 *     an incident, the operator sets
 *     `LLM_CLIENT_ALLOW_FLAG_FALLBACK=true`, boots the worker, and
 *     the loader returns `FLAG_DEFAULTS` with a structured warning so
 *     an alert can fire (`llm_flag_validation_failed`).
 *
 * This module is pure — no logging, no audit. Callers decide how to
 * surface results (pino, OTel, alertmanager etc.). The emit step
 * lands in Iteration 6.
 */

import {
  FLAG_DEFAULTS,
  LLM_FLAGS,
  LLM_FLAG_NAMES,
  type LLMFlagName,
  type LLMFlagValues,
} from './flag-defaults.js';

/** One entry in a validation failure report. */
export interface FlagValidationIssue {
  readonly flag: LLMFlagName | 'cross_invariant';
  /**
   * Stable identifier so alert rules can match a specific violation.
   * - `out_of_range` — value outside `[min, max]` for the flag.
   * - `not_a_finite_number` — missing, `NaN`, or `Infinity`.
   * - `jitter_order` — `retry_jitter_ms_min` ≥ `retry_jitter_ms_max`.
   * - `cooldown_over_window` — `open_cooldown > window × 5`.
   */
  readonly code:
    | 'out_of_range'
    | 'not_a_finite_number'
    | 'jitter_order'
    | 'cooldown_over_window';
  readonly message: string;
  readonly received: unknown;
  readonly expected?:
    | { readonly min: number; readonly max: number }
    | { readonly rule: string };
}

/** Structured failure emitted by `validateFlags` (never thrown). */
export class FlagValidationError extends Error {
  override readonly name = 'FlagValidationError';
  readonly issues: readonly FlagValidationIssue[];

  constructor(issues: readonly FlagValidationIssue[]) {
    super(
      `Invalid llm-client flag values (${issues.length} issue${
        issues.length === 1 ? '' : 's'
      }). ` + issues.map((i) => `[${i.flag}:${i.code}]`).join(' '),
    );
    this.issues = Object.freeze([...issues]);
  }
}

/** Success result of `validateFlags`. */
export interface ValidationOk {
  readonly ok: true;
  readonly values: LLMFlagValues;
}

/** Failure result of `validateFlags`. */
export interface ValidationErr {
  readonly ok: false;
  readonly error: FlagValidationError;
}

export type ValidationResult = ValidationOk | ValidationErr;

/**
 * Pure, total validator. Accepts any shape and checks it against the
 * §16 schema. Never throws; returns a discriminated union.
 *
 * Validation order:
 *  1. Every flag is a finite number.
 *  2. Every flag is inside its `[min, max]`.
 *  3. Cross-invariants (jitter ordering, cooldown vs window).
 *
 * Cross-invariants only run when the relevant flags passed steps 1+2
 * — otherwise we'd produce confusing follow-on errors.
 */
export function validateFlags(input: unknown): ValidationResult {
  const issues: FlagValidationIssue[] = [];

  // Start from an empty record with the right shape; we fill it as
  // each flag validates successfully.
  const partial: { [K in LLMFlagName]?: number } = {};
  const record =
    input !== null && typeof input === 'object'
      ? (input as Record<string, unknown>)
      : undefined;

  for (const name of LLM_FLAG_NAMES) {
    const raw = record?.[name];
    const spec = LLM_FLAGS[name];

    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      issues.push({
        flag: name,
        code: 'not_a_finite_number',
        message: `Flag ${name} is not a finite number.`,
        received: raw,
      });
      continue;
    }

    if (raw < spec.min || raw > spec.max) {
      issues.push({
        flag: name,
        code: 'out_of_range',
        message:
          `Flag ${name}=${raw} is out of range [${spec.min}, ${spec.max}]` +
          (spec.hardCap ? ' (hard-cap of §16 — not changeable by flag)' : ''),
        received: raw,
        expected: { min: spec.min, max: spec.max },
      });
      continue;
    }

    partial[name] = raw;
  }

  // Cross-invariants — only evaluate when inputs are present and in
  // range. Otherwise the per-flag error is enough.
  const jMin = partial['llm.kms.retry_jitter_ms_min'];
  const jMax = partial['llm.kms.retry_jitter_ms_max'];
  if (jMin !== undefined && jMax !== undefined && jMin >= jMax) {
    issues.push({
      flag: 'cross_invariant',
      code: 'jitter_order',
      message:
        `llm.kms.retry_jitter_ms_min (${jMin}) must be strictly less ` +
        `than llm.kms.retry_jitter_ms_max (${jMax}).`,
      received: { min: jMin, max: jMax },
      expected: { rule: 'retry_jitter_ms_min < retry_jitter_ms_max' },
    });
  }

  const cooldown = partial['llm.circuit_breaker.open_cooldown_seconds'];
  const window = partial['llm.circuit_breaker.window_seconds'];
  if (
    cooldown !== undefined &&
    window !== undefined &&
    cooldown > window * 5
  ) {
    issues.push({
      flag: 'cross_invariant',
      code: 'cooldown_over_window',
      message:
        `llm.circuit_breaker.open_cooldown_seconds (${cooldown}) must be ` +
        `≤ llm.circuit_breaker.window_seconds × 5 (${window * 5}).`,
      received: { cooldown, window },
      expected: {
        rule: 'open_cooldown_seconds ≤ window_seconds × 5',
      },
    });
  }

  if (issues.length > 0) {
    return { ok: false, error: new FlagValidationError(issues) };
  }

  // At this point `partial` has every key filled. Cast is safe
  // because the iteration above covered every member of
  // `LLM_FLAG_NAMES`.
  return { ok: true, values: partial as LLMFlagValues };
}

/**
 * Environment variable that, when set to `'true'`, allows the worker
 * to boot with `FLAG_DEFAULTS` when GrowthBook is unavailable.
 *
 * Exported so deploy scripts and tests can reference the canonical
 * name instead of hard-coding the string.
 */
export const FLAG_FALLBACK_ENV_VAR = 'LLM_CLIENT_ALLOW_FLAG_FALLBACK';

/** Return shape of `loadFlagsWithFallback` when it succeeds. */
export interface LoadOk {
  readonly ok: true;
  readonly values: LLMFlagValues;
  /** Where the values came from. */
  readonly source: 'growthbook' | 'emergency_defaults';
  /** Populated when `source === 'emergency_defaults'`. */
  readonly warning?: {
    readonly reason: 'growthbook_unreachable' | 'growthbook_invalid';
    readonly underlyingIssues?: readonly FlagValidationIssue[];
  };
}

/** Return shape of `loadFlagsWithFallback` when it must refuse to boot. */
export interface LoadErr {
  readonly ok: false;
  readonly reason: 'growthbook_unreachable' | 'growthbook_invalid';
  readonly error: FlagValidationError | Error;
}

export type LoadResult = LoadOk | LoadErr;

/** Input to `loadFlagsWithFallback`. */
export interface LoadFlagsInput {
  /**
   * Raw bag of flag values as fetched from GrowthBook. Unknown shape
   * on purpose — `validateFlags` is the sole source of truth for
   * whether the bag is acceptable.
   *
   * Set to `null` when GrowthBook is unreachable.
   */
  readonly growthbookValues: unknown | null;
  /**
   * Process env map. Defaults to `process.env`. Tests inject a
   * plain object for hermeticity.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Boot-time loader. Wraps `validateFlags` with the emergency-fallback
 * policy of §16.
 *
 * Decision table:
 *
 *   growthbookValues | env fallback | → result
 *   -----------------+--------------+----------------------------------
 *   present & valid  | *            | ok: growthbook
 *   present & invalid| true         | ok: defaults (with warning)
 *   present & invalid| false        | err: growthbook_invalid
 *   null (unreach.)  | true         | ok: defaults (with warning)
 *   null (unreach.)  | false        | err: growthbook_unreachable
 *
 * The caller decides what to do with the failure — typically log
 * structured `llm_flag_validation_failed` and exit with non-zero so
 * the orchestrator holds the rollout.
 */
export function loadFlagsWithFallback(input: LoadFlagsInput): LoadResult {
  const env = input.env ?? (process.env as Record<string, string | undefined>);
  const fallbackAllowed = env[FLAG_FALLBACK_ENV_VAR] === 'true';

  if (input.growthbookValues === null) {
    if (fallbackAllowed) {
      return {
        ok: true,
        values: FLAG_DEFAULTS,
        source: 'emergency_defaults',
        warning: { reason: 'growthbook_unreachable' },
      };
    }
    return {
      ok: false,
      reason: 'growthbook_unreachable',
      error: new Error(
        'GrowthBook is unreachable and ' +
          `${FLAG_FALLBACK_ENV_VAR}!=='true'; refusing to boot.`,
      ),
    };
  }

  const result = validateFlags(input.growthbookValues);

  if (result.ok) {
    return { ok: true, values: result.values, source: 'growthbook' };
  }

  if (fallbackAllowed) {
    return {
      ok: true,
      values: FLAG_DEFAULTS,
      source: 'emergency_defaults',
      warning: {
        reason: 'growthbook_invalid',
        underlyingIssues: result.error.issues,
      },
    };
  }

  return {
    ok: false,
    reason: 'growthbook_invalid',
    error: result.error,
  };
}
