/**
 * `UserQuotaRepo` — the DI seam that hydrates a `UserQuota` from a
 * `userId` inside `LLMClient.call()`.
 *
 * Closes `LLM_CLIENT.md §18.1`: iter 8 commit 3 shipped `LLMCallInput`
 * as a **superset** of §3.3 with an inline `user: UserQuota` because
 * the router needed the full quota shape and iter 8 had no repo layer.
 * Iter 9 c3 narrows the input to §3.3 exactly (`userId` only) and
 * resolves the full quota via this seam before routing.
 *
 * ## Why an interface, not a concrete class
 *
 * Same rationale as `IdempotencyStore`, `EnvelopeCrypto.KEKProvider`,
 * and `AuditWriter`: the concrete adapter (Postgres, Supabase, cache
 * tier) lives in the hosting app. The `@chisu/llm-client` package
 * only owns the seam + the `Result<UserQuota, UserQuotaRepoError>`
 * shape so the facade can react to repo failures without knowing the
 * storage layer.
 *
 * ## Error taxonomy
 *
 * Two kinds — narrow and PII-free:
 *
 *  - `not_found`: the `userId` does not map to any quota row.
 *    Usually surfaces as `make.internal('client.call: quota_not_found')`
 *    on the caller side (not a `network_error` — the request never
 *    reached a provider). The facade turns this into
 *    `internal:client.call: quota_not_found` so observability can
 *    filter on the structured correlationId prefix.
 *  - `transport`: the repo itself had an IO failure (DB timeout,
 *    connection refused, serialization error). The facade maps this
 *    to `make.internal('client.call: quota_transport')` — a persistent
 *    infra issue, not an idempotency- or call-level retry candidate.
 *
 * We intentionally do NOT expose the underlying error message here:
 * it can contain DB-internal identifiers (row hashes, schema names)
 * that are not safe to echo to callers. The adapter logs the raw
 * error server-side; the repo surface stays narrow.
 *
 * ## Testing
 *
 * A `FakeUserQuotaRepo` lives in `test/client/_fakes.ts` and is
 * pre-seeded with `DEFAULT_USER` for happy-path specs. Failure specs
 * use `seedError({ kind: 'not_found' })` / `seedError({ kind: 'transport' })`
 * to drive the facade into each error branch.
 *
 * @see LLM_CLIENT.md §18.1 — deuda firmada iter 8 c3
 * @see ../client.ts — `LLMClient.call()` step 3.5 (quota resolve)
 */

import type { UserQuota } from '../routing/plan-router.js';
import type { Result } from '../types.js';

/**
 * Error shape returned by `UserQuotaRepo.get()` when the lookup fails.
 * Kept narrow + PII-free — the adapter is responsible for logging the
 * raw cause server-side; this surface carries only the taxonomy.
 */
export type UserQuotaRepoError =
  | { readonly kind: 'not_found'; readonly userId: string }
  | { readonly kind: 'transport'; readonly reason: string };

/**
 * Repo seam for resolving `UserQuota` inside the facade. Implementations
 * live in `apps/web/` (Postgres/Supabase) and in `test/client/_fakes.ts`
 * (in-memory). The only operation the facade needs is `get` — future
 * iterations may add `invalidate(userId)` to pair with the iter 9 c4
 * `LLMClient.invalidateUserKey()` closure, but that is out of scope
 * here.
 *
 * MUST NOT throw. All IO failures return `err({ kind: 'transport' })`;
 * the facade propagates as `internal` with a structured correlationId.
 */
export interface UserQuotaRepo {
  /**
   * Resolve the `UserQuota` row for `userId`. `userId` is non-empty
   * per the zod parse in `LLMCallInput`; implementations may assume
   * it is a well-formed string.
   */
  get(userId: string): Promise<Result<UserQuota, UserQuotaRepoError>>;
}
