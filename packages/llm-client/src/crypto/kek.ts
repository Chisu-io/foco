/**
 * KEK (Key Encryption Key) operations against AWS KMS.
 *
 * Implements the envelope-side of
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` §5} and the
 * retry / deadline semantics of §2 invariant 5 + §4.3.
 *
 * Responsibilities:
 *
 *  1. Translate `(kekVersion, shardId)` into a KMS alias.
 *  2. Issue `Encrypt` / `Decrypt` commands against an injected
 *     `KMSClient` (no custom wrapper — inject the SDK directly so
 *     `aws-sdk-client-mock` can substitute it in tests; per Jean
 *     2026-04-18).
 *  3. Enforce the hard-capped retry budget (`MAX_ATTEMPTS = 2` =
 *     original + 1 retry) with 50–250 ms jitter.
 *  4. Enforce deadline-aware skipping: if the projected wake-up time
 *     of a retry would exceed the span deadline, emit
 *     `llm_retries_skipped_deadline_total` and fail-close immediately.
 *
 * **No circuit breaker over KMS** (§2 invariant 5). Opening a CB here
 * would add latency without changing outcome — there is no fallback
 * path for a missing KEK.
 *
 * This module does not import `@chisu/llm-client`'s public surface to
 * keep the graph acyclic; it depends only on error taxonomy helpers
 * and the metrics abstraction.
 */

import {
  DecryptCommand,
  EncryptCommand,
  type KMSClient,
} from '@aws-sdk/client-kms';

import { classifyKmsError } from '../errors/classify.js';
import { make, type LLMCallError } from '../errors/taxonomy.js';
import type { Metrics } from '../observability/metrics.js';
import { err, ok, type Result } from '../types.js';

/** The KMS operations we instrument. */
export type KmsOperation = 'encrypt' | 'decrypt';

/**
 * Compute the canonical KMS alias for a (kekVersion, shardId) pair.
 *
 * Format per §5.1 step 5:  `alias/foco/kek/v${kekVersion}/shard-${shardId}`.
 * The `alias/` prefix is the AWS-required form when using `KeyId` to
 * reference an alias (not the name alone).
 */
export function kekAlias(input: {
  readonly kekVersion: number;
  readonly shardId: number;
}): string {
  if (!Number.isInteger(input.kekVersion) || input.kekVersion < 1) {
    throw new Error(`kekAlias: kekVersion must be a positive integer.`);
  }
  if (!Number.isInteger(input.shardId) || input.shardId < 0) {
    throw new Error(`kekAlias: shardId must be a non-negative integer.`);
  }
  return `alias/foco/kek/v${input.kekVersion}/shard-${input.shardId}`;
}

/** Dependencies required by every KMS operation. */
export interface KmsDeps {
  /** Injected AWS SDK v3 client — replaced with `aws-sdk-client-mock` in tests. */
  readonly kms: KMSClient;
  /** Metrics sink (NOOP_METRICS is acceptable for shallow callers). */
  readonly metrics: Metrics;
  /** Monotonic-ish clock in milliseconds. `Date.now` in production, fake in tests. */
  readonly now: () => number;
  /** Sleep helper. `setTimeout`-based in production, fake in tests. */
  readonly sleep: (ms: number) => Promise<void>;
  /** RNG for jitter. Injectable so tests become deterministic. */
  readonly jitterMs: (minMs: number, maxMs: number) => number;
}

/** Per-call tuning knobs. All optional. */
export interface KmsCallOptions {
  /**
   * Absolute deadline timestamp (ms since epoch). If the projected
   * retry would finish past this timestamp, the retry is skipped and
   * the last transient error is returned as-is (§4.3).
   */
  readonly deadlineMs?: number | undefined;
  /** Min jitter override (default 50ms). */
  readonly jitterMinMs?: number | undefined;
  /** Max jitter override (default 250ms, exclusive upper bound). */
  readonly jitterMaxMs?: number | undefined;
}

/**
 * Hard-capped attempt count: original call + 1 retry. §2 invariant 5
 * forbids raising this via flag — it is *not* part of the §16 flag
 * table.
 */
export const KMS_MAX_ATTEMPTS = 2;

/** Default jitter window from §2 invariant 5 / §16 defaults. */
const DEFAULT_JITTER_MIN_MS = 50;
const DEFAULT_JITTER_MAX_MS = 250;

/**
 * Error returned by `kmsEncrypt` / `kmsDecrypt`. Always
 * `kms_unavailable` — the classifier decides transient vs non-transient.
 */
export type KmsError = Extract<LLMCallError, { kind: 'kms_unavailable' }>;

/**
 * Encrypt plaintext under the KEK referenced by `alias`.
 *
 * Returns the opaque ciphertext blob on success (a `Uint8Array` that
 * should be stored verbatim in DB as `dekCiphertext`), or a classified
 * `kms_unavailable` error.
 */
export async function kmsEncrypt(
  deps: KmsDeps,
  input: { readonly alias: string; readonly plaintext: Uint8Array },
  options: KmsCallOptions = {},
): Promise<Result<Uint8Array, KmsError>> {
  return attempt(deps, options, 'encrypt', async () => {
    const cmd = new EncryptCommand({
      KeyId: input.alias,
      Plaintext: input.plaintext,
    });
    const out = await deps.kms.send(cmd);
    const blob = out.CiphertextBlob;
    if (!blob || blob.length === 0) {
      // Shouldn't happen per SDK contract, but treat as internal-
      // grade anomaly: throw a synthetic error so the classifier
      // routes us to a non-transient `kms_unavailable`.
      const syntheticError = Object.assign(
        new Error('KMS Encrypt returned empty CiphertextBlob.'),
        { name: 'InvalidCiphertextException' },
      );
      throw syntheticError;
    }
    return toUint8Array(blob);
  });
}

/**
 * Decrypt an opaque KMS `ciphertext` previously produced by
 * {@link kmsEncrypt} under the same alias (§5.1 read flow, step 3).
 */
export async function kmsDecrypt(
  deps: KmsDeps,
  input: { readonly alias: string; readonly ciphertext: Uint8Array },
  options: KmsCallOptions = {},
): Promise<Result<Uint8Array, KmsError>> {
  return attempt(deps, options, 'decrypt', async () => {
    const cmd = new DecryptCommand({
      KeyId: input.alias,
      CiphertextBlob: input.ciphertext,
    });
    const out = await deps.kms.send(cmd);
    const blob = out.Plaintext;
    if (!blob || blob.length === 0) {
      const syntheticError = Object.assign(
        new Error('KMS Decrypt returned empty Plaintext.'),
        { name: 'InvalidCiphertextException' },
      );
      throw syntheticError;
    }
    return toUint8Array(blob);
  });
}

/**
 * Shared retry / metrics wrapper. Generic over the return type so
 * both operations reuse the same budget enforcement.
 */
async function attempt<T>(
  deps: KmsDeps,
  opts: KmsCallOptions,
  operation: KmsOperation,
  fn: () => Promise<T>,
): Promise<Result<T, KmsError>> {
  const jitterMin = opts.jitterMinMs ?? DEFAULT_JITTER_MIN_MS;
  const jitterMax = opts.jitterMaxMs ?? DEFAULT_JITTER_MAX_MS;
  if (jitterMin >= jitterMax) {
    throw new Error(
      `kmsCall: jitterMinMs (${jitterMin}) must be < jitterMaxMs (${jitterMax}).`,
    );
  }

  let lastError: KmsError | undefined;
  let observedLatencyMs = 0;

  for (let attemptNo = 1; attemptNo <= KMS_MAX_ATTEMPTS; attemptNo++) {
    const startedAt = deps.now();
    try {
      const value = await fn();
      observedLatencyMs = deps.now() - startedAt;
      deps.metrics.histogram('llm_kms_latency_ms', observedLatencyMs, {
        operation,
      });
      if (attemptNo > 1) {
        deps.metrics.counter('llm_kms_retries_total', {
          operation,
          outcome: 'success',
        });
      }
      return ok(value);
    } catch (raw) {
      observedLatencyMs = deps.now() - startedAt;
      deps.metrics.histogram('llm_kms_latency_ms', observedLatencyMs, {
        operation,
      });

      const classified = classifyKmsError({
        errorName: readErrorName(raw),
        statusCode: readHttpStatus(raw),
      });

      deps.metrics.counter('llm_kms_induced_failures_total', {
        operation,
        transient: classified.transient ? 'true' : 'false',
      });
      lastError = classified;

      if (!classified.transient) {
        // Fail-closed immediately. No retry credit consumed.
        return err(classified);
      }

      if (attemptNo === KMS_MAX_ATTEMPTS) {
        // Budget exhausted.
        deps.metrics.counter('llm_kms_retries_total', {
          operation,
          outcome: 'fail',
        });
        return err(classified);
      }

      // Deadline check BEFORE sleeping — if the sleep + a projected
      // retry taking at least `observedLatencyMs` would exceed the
      // deadline, skip the retry (§4.3).
      const jitter = deps.jitterMs(jitterMin, jitterMax);
      if (opts.deadlineMs !== undefined) {
        const projectedCompletion =
          deps.now() + jitter + observedLatencyMs;
        if (projectedCompletion > opts.deadlineMs) {
          deps.metrics.counter('llm_retries_skipped_deadline_total', {
            operation,
          });
          deps.metrics.counter('llm_kms_retries_total', {
            operation,
            outcome: 'fail',
          });
          return err(classified);
        }
      }

      await deps.sleep(jitter);
      // Loop continues — second attempt.
    }
  }

  // Unreachable — loop always returns. This exists only to satisfy
  // the non-void return type without a cast.
  return err(lastError ?? make.kmsUnavailable(false));
}

function readErrorName(raw: unknown): string | undefined {
  if (raw !== null && typeof raw === 'object' && 'name' in raw) {
    const name = (raw as { name?: unknown }).name;
    return typeof name === 'string' ? name : undefined;
  }
  return undefined;
}

function readHttpStatus(raw: unknown): number | undefined {
  if (raw !== null && typeof raw === 'object' && '$metadata' in raw) {
    const meta = (raw as { $metadata?: { httpStatusCode?: unknown } }).$metadata;
    const code = meta?.httpStatusCode;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}

/**
 * Normalise whatever the SDK handed back (Uint8Array, Buffer, or
 * ArrayBuffer-ish) to a plain Uint8Array so callers don't depend on
 * SDK internals.
 */
function toUint8Array(blob: Uint8Array | ArrayBufferLike): Uint8Array {
  if (blob instanceof Uint8Array) {
    return blob;
  }
  return new Uint8Array(blob);
}

/**
 * Default sleep helper. Exported so envelope wiring can use it without
 * reaching for globals. Safe under fake timers in Vitest.
 */
export function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default jitter helper. Returns an integer in `[min, max)`.
 * Accepts `min === max` by returning `min` (useful in tests that
 * want a deterministic pause).
 */
export function defaultJitterMs(min: number, max: number): number {
  if (min === max) return min;
  const lo = Math.ceil(min);
  const hi = Math.floor(max);
  return Math.floor(Math.random() * (hi - lo)) + lo;
}
