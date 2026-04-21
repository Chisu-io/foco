/**
 * Repository abstractions for stored user state that `llm-client`
 * reads on the hot path.
 *
 * These interfaces are **data-access seams**. Concrete implementations
 * (Postgres-backed, Supabase-backed, etc.) live in `apps/` or a future
 * `packages/llm-data-access/` — never inside this package. Keeping
 * persistence outside of `llm-client` preserves the invariant that
 * the package is a pure library: deterministic, side-effect-free in
 * its construction, trivially swappable in tests.
 *
 * Iter 7 introduces only the subset needed by consent resolution
 * (the `ConsentResolver` DI seam). The interface grows in iter 8
 * when `BYOKKeystore` materialises as the consumer of
 * `EnvelopeCrypto.unwrap(...)` for API key material.
 *
 * @see LLM_CLIENT.md §8 — consent modes
 * @see LLM_CLIENT.md §12 — UserQuota contract
 */

/**
 * Telemetry consent granted by a user for LLM calls (§8 of the
 * contract). Default on a freshly-created `user_llm_key` row is
 * `'full'` (Privacy Policy acceptance path); users opt into
 * `'minimal'` from `settings-integraciones → Privacidad`.
 *
 * Row shape in `llm_token_usage` depends on this value:
 *
 *  - `'full'` — full row: `input_tokens`, `output_tokens`, `model`,
 *    `origin`, `latency_ms`. UI shows usage detail; abuse detector
 *    runs both token-rate + prompt-hash heuristics; analytics include
 *    this user's aggregates.
 *  - `'minimal'` — `{user_id, occurred_at, provider, funding_mode}`
 *    only (`input_tokens`, `output_tokens` left `NULL`). UI degrades
 *    to request count; abuse detector runs only request-rate
 *    heuristic; analytics exclude this user.
 *
 * The mode is monotonic from the user's perspective: a change applies
 * from the audit timestamp onward, historic rows are NOT rewritten.
 */
export type ConsentMode = 'full' | 'minimal';

/**
 * Reader surface over `user_llm_key` rows. Scoped intentionally to
 * what iter 7 consumes; extensions land with iter 8 when
 * `BYOKKeystore` materialises.
 *
 * Implementations are expected to:
 *  - NEVER surface decrypted API key material from this interface.
 *    Key material flows through `EnvelopeCrypto.unwrap(...)`, not
 *    through repos. Surfacing it here would make every consumer a
 *    potential leak site.
 *  - Propagate storage errors as thrown `Error`s; callers wrap into
 *    `Result` or degrade to a safe fallback. The `ConsentResolver`
 *    in iter 7 catches and degrades to `'minimal'` on failure
 *    (§8 decisión #8 firmada 2026-04-20).
 *  - Be idempotent under retry; callers may retry on transient
 *    failure. `getConsentMode(u)` is a pure read — no side effects.
 */
export interface UserLLMKeyRepo {
  /**
   * Read the caller's current consent mode. Returns `undefined` when
   * no `user_llm_key` row exists for the user (the user has never
   * added a BYOK key and therefore has no explicit consent record).
   *
   * The `ConsentResolver` maps `undefined` to its caller-configured
   * default — iter 7 uses `'full'` because all Foco surfaces that
   * invoke `.call()` run after Privacy Policy acceptance
   * (UX_FROZEN §2.8 — onboarding terms gate), so the absence of a
   * row is "user has PP-accepted but never saved a BYOK key" rather
   * than "no consent decision has been made".
   */
  getConsentMode(userId: string): Promise<ConsentMode | undefined>;
}
