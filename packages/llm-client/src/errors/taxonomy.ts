/**
 * Error taxonomy for `@chisu/llm-client`.
 *
 * Implements the discriminated union defined in
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` §3.5}.
 *
 * Contract invariant (§3.5): `LLMClient.call()` **never throws** — it
 * always resolves `Promise<Result<LLMCallOutput, LLMCallError>>`. This
 * file therefore exports **types and pure constructors only**; no
 * `Error` subclasses, no `throw` helpers.
 *
 * The union is kept **verbatim** with the signed contract. Any change
 * here requires a bump + signature of `LLM_CLIENT.md` per
 * `feedback_foco_three_contracts_rule`.
 */

/**
 * Canonical error shape returned by every path of the `LLMClient`.
 *
 * Each variant is narrowable by `kind` and carries only non-sensitive
 * fields — **no key material, no prompt content, no response body**
 * (contract §2 invariant 1, §7.3).
 *
 * @see LLM_CLIENT.md §3.5 — Taxonomía de errores
 * @see LLM_CLIENT.md §7.1 — Detección y mapeo desde proveedores
 * @see LLM_CLIENT.md §7.3 — Redacción de errores en logs/audit
 */
export type LLMCallError =
  | { kind: 'invalid_key'; provider: string; userMessage: string }
  | { kind: 'quota_exhausted'; provider: string; userMessage: string }
  | { kind: 'rate_limit'; provider: string; retryAfterSec?: number }
  | { kind: 'provider_down'; provider: string; circuitOpen: boolean }
  | { kind: 'content_blocked'; reason: 'moderation' | 'safety' }
  | { kind: 'context_too_long'; maxTokens: number; actual: number }
  | { kind: 'kms_unavailable'; transient: boolean }
  | { kind: 'routing_disabled'; flag: string }
  | { kind: 'plan_requires_key'; plan: 'free' | 'creator' }
  | { kind: 'network_error'; transient: boolean }
  | { kind: 'internal'; correlationId: string };

/**
 * Extracts the set of valid `kind` discriminants.
 *
 * Exported for ergonomics in switch-exhaustiveness checks elsewhere in
 * the client (e.g. mapping to metrics labels in Iteration 6).
 */
export type LLMErrorCode = LLMCallError['kind'];

/**
 * Runtime-checkable tuple of every error kind. Useful for tests and
 * for metrics label whitelisting so `llm_requests_total{outcome=...}`
 * cannot be polluted by an off-spec label from a future change.
 */
export const LLM_ERROR_CODES = [
  'invalid_key',
  'quota_exhausted',
  'rate_limit',
  'provider_down',
  'content_blocked',
  'context_too_long',
  'kms_unavailable',
  'routing_disabled',
  'plan_requires_key',
  'network_error',
  'internal',
] as const satisfies readonly LLMErrorCode[];

/**
 * Type-level assertion that `LLM_ERROR_CODES` and `LLMErrorCode` stay
 * in sync. If a variant is added to `LLMCallError` without being
 * added to `LLM_ERROR_CODES` (or vice versa), this fails typecheck.
 */
type _AssertErrorCodesComplete = Exclude<
  LLMErrorCode,
  (typeof LLM_ERROR_CODES)[number]
> extends never
  ? Exclude<(typeof LLM_ERROR_CODES)[number], LLMErrorCode> extends never
    ? true
    : false
  : false;

/**
 * Exported so `noUnusedLocals` lets it live. Its only job is to fail
 * compilation when `LLM_ERROR_CODES` and `LLMErrorCode` drift apart.
 */
export const ERROR_CODES_COMPLETE: _AssertErrorCodesComplete = true;

// ─── Pure constructors ────────────────────────────────────────────────
//
// These are thin, unopinionated constructors used by `classify.ts` and,
// later, by each provider adapter. They exist to give us a single place
// to enforce the discriminant + defaults, and to make the call sites in
// classifiers read like prose.
//
// Do not add logging, formatting or side-effects here.

/**
 * Canonical user-facing messages for `invalid_key` and
 * `quota_exhausted`. Deliberately generic so we never leak the
 * provider's raw error body (§7.3).
 *
 * Callers — in particular `classifyProviderHttpError` — pass the
 * right string; nothing prevents adapters from passing their own.
 */
export const DEFAULT_USER_MESSAGES = {
  invalid_key: (provider: string) =>
    `Your ${capitalize(provider)} API key is invalid or was revoked. ` +
    `Update it in Settings → Integrations to continue generating.`,
  quota_exhausted: (provider: string) =>
    `Your ${capitalize(provider)} account ran out of credit. ` +
    `Top it up in your ${capitalize(provider)} dashboard or upgrade ` +
    `your Foco plan to Influencer and let us cover the LLM calls.`,
} as const;

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Compact constructors. Each returns a fully-typed `LLMCallError`
 * variant with the `kind` discriminant filled in.
 */
export const make = {
  invalidKey(
    provider: string,
    userMessage: string = DEFAULT_USER_MESSAGES.invalid_key(provider),
  ): Extract<LLMCallError, { kind: 'invalid_key' }> {
    return { kind: 'invalid_key', provider, userMessage };
  },

  quotaExhausted(
    provider: string,
    userMessage: string = DEFAULT_USER_MESSAGES.quota_exhausted(provider),
  ): Extract<LLMCallError, { kind: 'quota_exhausted' }> {
    return { kind: 'quota_exhausted', provider, userMessage };
  },

  rateLimit(
    provider: string,
    retryAfterSec?: number,
  ): Extract<LLMCallError, { kind: 'rate_limit' }> {
    // `exactOptionalPropertyTypes` forbids `{ retryAfterSec: undefined }`,
    // so only attach the field when we have a value to set.
    return retryAfterSec === undefined
      ? { kind: 'rate_limit', provider }
      : { kind: 'rate_limit', provider, retryAfterSec };
  },

  providerDown(
    provider: string,
    circuitOpen: boolean,
  ): Extract<LLMCallError, { kind: 'provider_down' }> {
    return { kind: 'provider_down', provider, circuitOpen };
  },

  contentBlocked(
    reason: 'moderation' | 'safety',
  ): Extract<LLMCallError, { kind: 'content_blocked' }> {
    return { kind: 'content_blocked', reason };
  },

  contextTooLong(
    maxTokens: number,
    actual: number,
  ): Extract<LLMCallError, { kind: 'context_too_long' }> {
    return { kind: 'context_too_long', maxTokens, actual };
  },

  kmsUnavailable(
    transient: boolean,
  ): Extract<LLMCallError, { kind: 'kms_unavailable' }> {
    return { kind: 'kms_unavailable', transient };
  },

  routingDisabled(
    flag: string,
  ): Extract<LLMCallError, { kind: 'routing_disabled' }> {
    return { kind: 'routing_disabled', flag };
  },

  planRequiresKey(
    plan: 'free' | 'creator',
  ): Extract<LLMCallError, { kind: 'plan_requires_key' }> {
    return { kind: 'plan_requires_key', plan };
  },

  networkError(
    transient: boolean,
  ): Extract<LLMCallError, { kind: 'network_error' }> {
    return { kind: 'network_error', transient };
  },

  internal(
    correlationId: string,
  ): Extract<LLMCallError, { kind: 'internal' }> {
    return { kind: 'internal', correlationId };
  },
} as const;

/**
 * Exhaustive-check helper. Place `assertNever(variant)` in the default
 * branch of a switch over `LLMCallError['kind']` to have TypeScript
 * prove that every variant is handled.
 */
export function assertNever(x: never): never {
  throw new Error(
    `Unhandled LLMCallError variant: ${JSON.stringify(x)}`,
  );
}
