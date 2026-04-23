/**
 * Narrow contract for reading GrowthBook flag values at runtime.
 *
 * Separated from `flag-defaults.ts` (schema) and `flag-validation.ts`
 * (boot-time validator) so the rest of the package can depend only on
 * the *read* shape without pulling in validators and defaults they do
 * not use.
 *
 * Reading pattern (pull-on-call):
 *   The breaker and the router call `flags.get(...)` on every
 *   decision. GrowthBook-backed implementations keep an in-process
 *   cache of their own (see `@growthbook/growthbook-node`), so we do
 *   NOT add a second cache layer here — that would stack TTLs and
 *   make it harder to reason about how quickly a hot-fixed flag
 *   propagates.
 *
 * @see LLM_CLIENT.md §16 — Feature flags & runtime overrides.
 */

import type {
  LLMFlagName,
  LLMFlagValues,
} from './flag-defaults.js';

/**
 * Reads the current runtime value of any flag. Implementations MUST
 * be synchronous and non-throwing — if the backing store is
 * unavailable, return the signed default instead of throwing.
 */
export interface FlagsReader {
  /**
   * Return the current numeric value of `name`. The caller relies on
   * §16 invariants holding (ranges + cross-invariants); validate at
   * boot with `validateFlags`, not on every read.
   */
  get(name: LLMFlagName): number;
}

/**
 * Minimal in-memory `FlagsReader` backed by a fixed values record.
 *
 * Useful for:
 *  - Tests that want deterministic flag values without a GrowthBook
 *    harness.
 *  - The emergency fallback path during an incident
 *    (`LLM_CLIENT_ALLOW_FLAG_FALLBACK=true`), where the worker boots
 *    from `FLAG_DEFAULTS` instead of GrowthBook.
 */
export function createStaticFlagsReader(values: LLMFlagValues): FlagsReader {
  // Capture the snapshot eagerly so a post-construction mutation of
  // the caller's object cannot retroactively change observed values.
  const frozen: LLMFlagValues = Object.freeze({ ...values });
  return {
    get(name) {
      return frozen[name];
    },
  };
}
