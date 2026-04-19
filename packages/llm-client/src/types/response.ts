/**
 * Normalized response shapes for `@chisu/llm-client`.
 *
 * Split into two layers on purpose:
 *
 *  - `LLMCallOutput` (contract-facing, §3.4) is what `LLMClient.call()`
 *    resolves with. It carries `modelUsed`, `providerUsed`, `usage`,
 *    and `latencyMs` so the caller can display / log without peeking
 *    at a provider-specific shape.
 *  - `ProviderCallOutput` (adapter-facing) is what each `Provider.call`
 *    returns internally. It excludes `fundingMode` and `latencyMs`
 *    because those are resolved by the routing / orchestration layer
 *    (Iterations 4 & 7), not the adapter.
 *
 * Keeping them separate means the adapter layer cannot accidentally
 * fabricate fields it does not own.
 */

import type { NormalizedMessage } from './request.js';

/**
 * Canonical reason the provider stopped generating. Gemini and
 * Anthropic both surface richer reasons; adapters normalise them to
 * this set or return `content_blocked` in `LLMCallError` instead.
 *
 * @see LLM_CLIENT.md §9.3 — Gemini FinishReason mapping
 */
export type StopReason =
  | 'end_turn'
  | 'max_tokens'
  | 'stop_sequence'
  | 'tool_use';

/**
 * Token usage. Always present on successful calls; BYOK and Managed
 * share the same shape so `llm_token_usage` inserts are uniform
 * (§8.1 of the contract).
 */
export interface UsageCounts {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
}

/**
 * Contract-facing response.
 *
 * @see LLM_CLIENT.md §3.4 — Shape de `LLMCallOutput`
 */
export interface LLMCallOutput {
  /** Model effectively used (may differ from request.model if fallback). */
  readonly modelUsed: string;

  /** Provider that served the call. */
  readonly providerUsed: 'anthropic' | 'openai' | 'gemini';

  /** Funding mode resolved by the router. Analytics only — never UI. */
  readonly fundingMode: 'byok' | 'managed';

  readonly message: NormalizedMessage;
  readonly usage: UsageCounts;
  readonly stopReason: StopReason;

  /** End-to-end latency in ms (includes key decrypt). */
  readonly latencyMs: number;

  /** Provider-side request ID for customer-support correlation. */
  readonly providerRequestId?: string | undefined;
}

/**
 * Adapter-facing response. The router / orchestrator wraps this with
 * `fundingMode` and `latencyMs` before returning to the caller.
 *
 * Implementation note: `providerUsed` is **still present** here so
 * the router can trust the provider's own self-identification rather
 * than infer it from the `Provider.name`. This matters when a call
 * transparently fails over from primary to fallback and the router
 * needs to know which provider actually answered.
 */
export interface ProviderCallOutput {
  readonly modelUsed: string;
  readonly providerUsed: 'anthropic' | 'openai' | 'gemini';
  readonly message: NormalizedMessage;
  readonly usage: UsageCounts;
  readonly stopReason: StopReason;
  readonly providerRequestId?: string | undefined;
}

/**
 * Result of a cheap-validation ping. Exposed via `Provider.ping`.
 *
 * `status` mirrors the semantics of `user_llm_key.status` in
 * §6 "Key lifecycle": `active` after a 200 OK, `invalid` after
 * 401 / 403, `quota_exhausted` after 429 with insufficient_quota or
 * a billing error. Everything else maps to `LLMCallError` and never
 * reaches the caller as a `PingOutput`.
 */
export interface PingOutput {
  readonly status: 'active';
  readonly model: string;
  readonly providerRequestId?: string | undefined;
  /**
   * Provider-reported remaining requests / tokens for the current
   * window when available (response headers). Opportunistic — no
   * guarantees.
   */
  readonly rateLimitHint?:
    | {
        readonly remainingRequests?: number | undefined;
        readonly remainingTokens?: number | undefined;
        readonly resetSec?: number | undefined;
      }
    | undefined;
}
