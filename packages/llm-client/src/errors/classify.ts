/**
 * Pure classifiers that turn provider / KMS / network failure hints
 * into the canonical `LLMCallError` discriminated union.
 *
 * Implements the mapping table of
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` §7.1}.
 *
 * Rules the whole file follows:
 *  - **Pure.** No I/O, no logging, no metrics — just a function from
 *    inputs to error values. Callers decide what to emit.
 *  - **Never throws.** §3.5 contract invariant: `LLMClient.call()`
 *    never throws. Classifiers return `LLMCallError`, never throw.
 *  - **No key / prompt leakage.** Classifiers take *hints*, not raw
 *    headers or raw response bodies for transport. A body argument is
 *    only used for last-resort keyword detection and is never echoed
 *    back in the returned error (§7.3).
 */

import { randomUUID } from 'node:crypto';

import { make, type LLMCallError } from './taxonomy.js';

/**
 * Providers known at v1.1 of the contract. Extend together with
 * `LLMCallOutput.providerUsed` + `Provider.name` when a new provider
 * ships (per §9.4 of the contract).
 */
export type ProviderName = 'anthropic' | 'openai' | 'gemini';

// ─── Provider HTTP error classifier ──────────────────────────────────

/**
 * Sub-kind hints provider adapters can pass after parsing their own
 * body format. They are the **authoritative** source; the body-string
 * keyword scan is a last-resort safety net and *must* not override
 * these hints.
 */
export type Http400Hint = 'context_length_exceeded' | 'content_filter';

/** Inputs for classifying a provider HTTP failure. */
export interface ProviderHttpErrorInput {
  readonly provider: ProviderName;
  readonly status: number;
  /**
   * Seconds to wait before retrying, from a `retry-after` header or
   * a provider-specific structured field. Only attached when the
   * value is confidently available; avoid guessing.
   */
  readonly retryAfterSec?: number | undefined;
  /**
   * Set by the adapter when it detects that the error is a billing
   * issue regardless of HTTP status. Takes precedence over
   * status-based classification (e.g. OpenAI returns HTTP 429 for
   * `insufficient_quota`, which is a billing error, not a throttle).
   */
  readonly billingError?: boolean | undefined;
  /**
   * Adapter-parsed category of a 400 response.
   */
  readonly http400Hint?: Http400Hint | undefined;
  /**
   * Token sizing hints to populate `context_too_long`. Adapters that
   * can extract these from a 400 body should pass them; otherwise
   * classify defaults to `{ maxTokens: 0, actual: 0 }` which is a
   * known "unknown — best effort" sentinel.
   */
  readonly contextSizing?:
    | { readonly maxTokens: number; readonly actual: number }
    | undefined;
  /**
   * Explicit hint for the `content_blocked` reason. Defaults to
   * `'moderation'` when not provided. Adapters that can tell safety
   * from moderation (e.g. Gemini `finishReason=SAFETY`) should set
   * this to `'safety'`.
   */
  readonly contentBlockReason?: 'moderation' | 'safety' | undefined;
  /**
   * Raw response body for **last-resort** keyword detection. May be
   * any parsed JSON object, a string, or `undefined`. Classifier only
   * reads known fields and discards the rest (§7.3: never echoed into
   * the returned error).
   */
  readonly body?: unknown;
  /**
   * If the caller knows the circuit-breaker for this provider is
   * currently open, it should set this so `provider_down` reflects
   * reality. Defaults to `false` (CB state is injected by the
   * routing layer in Iteration 4; the classifier is decoupled).
   */
  readonly circuitOpen?: boolean | undefined;
}

/**
 * Map a provider HTTP failure to an `LLMCallError`.
 *
 * @see LLM_CLIENT.md §7.1 — Detección y mapeo desde proveedores
 */
export function classifyProviderHttpError(
  input: ProviderHttpErrorInput,
): LLMCallError {
  const {
    provider,
    status,
    retryAfterSec,
    billingError,
    http400Hint,
    contextSizing,
    contentBlockReason,
    body,
    circuitOpen,
  } = input;

  // Billing hint short-circuits status-based mapping. OpenAI returns
  // HTTP 429 + `code: insufficient_quota` which is a billing error,
  // not a throttle — the hint catches that asymmetry.
  if (billingError === true) {
    return make.quotaExhausted(provider);
  }

  if (status === 401 || status === 403) {
    return make.invalidKey(provider);
  }

  if (status === 402) {
    return make.quotaExhausted(provider);
  }

  if (status === 429) {
    return make.rateLimit(provider, retryAfterSec);
  }

  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return make.providerDown(provider, circuitOpen ?? false);
  }

  if (status === 400) {
    const hint = http400Hint ?? sniff400Body(body);

    if (hint === 'context_length_exceeded') {
      return make.contextTooLong(
        contextSizing?.maxTokens ?? 0,
        contextSizing?.actual ?? 0,
      );
    }
    if (hint === 'content_filter') {
      return make.contentBlocked(contentBlockReason ?? 'moderation');
    }

    // Unknown 400 — could be malformed request from our side, or an
    // adapter bug. `internal` is correct: we don't claim to have
    // classified something we don't understand.
    return make.internal(newCorrelationId());
  }

  // Everything else (3xx, 408, unexpected 2xx-ish errors, etc.)
  // is unmapped per §7.1. Fail safe into `internal`.
  return make.internal(newCorrelationId());
}

/**
 * Best-effort keyword sniff over a 400 response body. Only used when
 * the adapter didn't supply `http400Hint`. Intentionally conservative
 * — unknown shapes return `undefined` rather than a false positive.
 */
function sniff400Body(body: unknown): Http400Hint | undefined {
  const s = asLowerString(body);
  if (s === undefined) return undefined;

  // Keyword set is intentionally small. Providers change error copy
  // often; adapters should carry the authoritative `http400Hint`.
  if (s.includes('context_length_exceeded') || s.includes('context length')) {
    return 'context_length_exceeded';
  }
  if (
    s.includes('content_filter') ||
    s.includes('content policy') ||
    s.includes('safety')
  ) {
    return 'content_filter';
  }
  return undefined;
}

function asLowerString(body: unknown): string | undefined {
  if (typeof body === 'string') return body.toLowerCase();
  if (body && typeof body === 'object') {
    try {
      return JSON.stringify(body).toLowerCase();
    } catch {
      return undefined;
    }
  }
  return undefined;
}

// ─── KMS classifier ──────────────────────────────────────────────────

/**
 * Hint describing a KMS (AWS) exception. `errorName` should be the
 * AWS SDK v3 error `name` field (e.g. `InvalidCiphertextException`).
 * `statusCode` is the HTTP status attached to the exception when
 * available.
 */
export interface KmsErrorHint {
  readonly errorName?: string | undefined;
  readonly statusCode?: number | undefined;
}

/**
 * Map a KMS exception to `kms_unavailable { transient }`.
 *
 * Contract §2 invariant 5 and §7.1:
 *  - Transient (retry once with 50–250ms jitter): throttling,
 *    service-side 5xx, dependency timeouts.
 *  - Non-transient (fail-closed, no retry): bad ciphertext, disabled
 *    / invalid key state, not-found, access denied.
 *
 * @see LLM_CLIENT.md §2 invariant 5 — fail-closed con retry acotado
 * @see LLM_CLIENT.md §7.1 — fila KMS
 */
export function classifyKmsError(
  hint: KmsErrorHint,
): Extract<LLMCallError, { kind: 'kms_unavailable' }> {
  const { errorName, statusCode } = hint;

  // Non-transient: these mean "something is wrong with the data or
  // the key itself, retrying won't help."
  const NON_TRANSIENT = new Set<string>([
    'InvalidCiphertextException',
    'KMSInvalidStateException',
    'DisabledException',
    'NotFoundException',
    'AccessDeniedException',
    'InvalidKeyUsageException',
    'IncorrectKeyException',
    'KMSAccessDeniedException',
  ]);

  // Transient: throttle / service / dependency / 5xx.
  const TRANSIENT = new Set<string>([
    'ThrottlingException',
    'KMSThrottlingException',
    'InternalException',
    'KMSInternalException',
    'DependencyTimeoutException',
    'ServiceUnavailableException',
    'KeyUnavailableException',
  ]);

  if (errorName !== undefined && NON_TRANSIENT.has(errorName)) {
    return make.kmsUnavailable(false);
  }
  if (errorName !== undefined && TRANSIENT.has(errorName)) {
    return make.kmsUnavailable(true);
  }

  // Status-based fallback for cases where the SDK didn't surface a
  // recognizable `name` (e.g. raw HTTP). 5xx → transient; everything
  // else → non-transient (fail-closed is the safe default — contract
  // §2 invariant 5).
  if (statusCode !== undefined && statusCode >= 500 && statusCode < 600) {
    return make.kmsUnavailable(true);
  }
  if (statusCode === 429) {
    return make.kmsUnavailable(true);
  }

  return make.kmsUnavailable(false);
}

// ─── Network classifier ──────────────────────────────────────────────

/**
 * Strict enum of transport-level failures covered by §7.1. All map to
 * `network_error { transient: true }` — a retry *can* help if callers
 * choose to (the retry budget is enforced elsewhere).
 *
 * Application-level aborts (deadline reached, caller cancelled) are
 * **not** listed here intentionally: their `transient` flag depends on
 * caller intent, so they are built by the caller directly via
 * `make.networkError(false)`.
 */
export type NetworkErrorKind = 'timeout' | 'dns' | 'tcp' | 'tls';

/**
 * Map a transport-level failure to `network_error { transient: true }`.
 *
 * @see LLM_CLIENT.md §7.1 — filas TCP/DNS/TLS y Timeout
 */
export function classifyNetworkError(
  _kind: NetworkErrorKind,
): Extract<LLMCallError, { kind: 'network_error' }> {
  // `_kind` is deliberately unused at runtime — it exists as a
  // structural hint so adapters can't call the function without
  // claiming which bucket their failure belongs to. Per §7.1, all
  // four buckets collapse to the same error variant.
  return make.networkError(true);
}

// ─── Correlation IDs ─────────────────────────────────────────────────

/**
 * RFC 4122 v4 UUID for `internal` errors. Uses `node:crypto`
 * `randomUUID`, stable in the Node target of this package (>=24).
 *
 * Wrapped in a module-private function so tests can stub it via
 * Vitest's module mocking.
 */
function newCorrelationId(): string {
  return randomUUID();
}
