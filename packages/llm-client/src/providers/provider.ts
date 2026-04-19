/**
 * `Provider` interface — adapter contract for every LLM proveedor in
 * `@chisu/llm-client`.
 *
 * Verbatim with §9.4 of the signed contract
 * ({@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md`}). Adding a
 * proveedor is "implement this interface + widen three unions +
 * write contract tests" — no other touch-points in the client.
 *
 * Invariants every implementation MUST uphold:
 *
 *  1. **Never throws.** All anticipated failures return
 *     `Result<ProviderCallOutput | PingOutput, LLMCallError>`. Only
 *     truly unexpected bugs (e.g. a shape assertion in our own code)
 *     are allowed to reject the promise — and the orchestration
 *     layer wraps those into `internal` with a correlation ID.
 *  2. **No key material in errors.** The returned `LLMCallError`
 *     variants carry `provider`, `userMessage`, `retryAfterSec`,
 *     etc. — nothing from the inbound key, the outbound request body
 *     or the provider response body (§7.3).
 *  3. **No logging / metrics.** Providers are pure wire-format
 *     translators. Instrumentation is the orchestrator's job
 *     (Iteration 6) so tests can assert I/O without mocking a
 *     metrics sink for each adapter.
 *  4. **Body buffering only.** Streaming is out of MVP (§9.x). The
 *     adapter reads the full response body and returns a single
 *     normalised message.
 */

import type { LLMCallError } from '../errors/taxonomy.js';
import type { Result } from '../types.js';
import type { NormalizedLLMRequest } from '../types/request.js';
import type { PingOutput, ProviderCallOutput } from '../types/response.js';

/**
 * Canonical provider identifier. Widen together with
 * `LLMCallOutput.providerUsed`, `LLMCallInput.providerHint`,
 * `ProviderCallOutput.providerUsed` and the `ProviderName` type in
 * `errors/classify.ts` when adding a proveedor (§9.4).
 */
export type ProviderName = 'anthropic' | 'openai' | 'gemini';

/**
 * Minimum input to `Provider.call`. Kept tighter than
 * `LLMCallInput` (§3.3) on purpose — adapters do NOT need to know
 * the plan, funding mode, exposure scope or idempotency key; those
 * are routing concerns.
 */
export interface ProviderCallInput {
  readonly apiKey: string;
  readonly request: NormalizedLLMRequest;
  /**
   * Caller's abort signal. Adapters wire this into their HTTP
   * client so that deadlines + cancellations reach the socket. A
   * missing signal means "no external deadline" — the adapter still
   * applies its own per-call timeout.
   */
  readonly abortSignal?: AbortSignal | undefined;
}

/**
 * Minimum input to `Provider.ping`. The ping uses a synthesised
 * micro-request (1-token completion) against the provider's cheapest
 * model; adapters choose the model themselves so the caller doesn't
 * accidentally ping with Opus.
 *
 * `abortSignal` is optional because pings are short-lived — the
 * 24h cron (§6) does not pass one, but a UI-triggered validation
 * from `settings-integraciones` may pass one tied to the UI modal.
 */
export interface ProviderPingInput {
  readonly apiKey: string;
  readonly abortSignal?: AbortSignal | undefined;
}

/**
 * Every adapter in `src/providers/` implements this interface. The
 * dispatch / routing layer in Iteration 4 picks the right one for a
 * given `LLMCallInput.request.model` and calls into it.
 */
export interface Provider {
  readonly name: ProviderName;

  /**
   * Translate a `NormalizedLLMRequest` to the proveedor's wire
   * format, send it, and return the response normalised or an error
   * classified per §7.1.
   */
  call(
    input: ProviderCallInput,
  ): Promise<Result<ProviderCallOutput, LLMCallError>>;

  /**
   * Cheap validation against the proveedor — single micro-request
   * against the provider's cheapest model. Used to surface
   * `user_llm_key.status` in the UI (§6). Never throws.
   */
  ping(
    input: ProviderPingInput,
  ): Promise<Result<PingOutput, LLMCallError>>;
}
