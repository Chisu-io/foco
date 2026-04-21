/**
 * Consent-mode resolution for the token-accounting path (§8 of the
 * LLM_CLIENT contract).
 *
 * Iter 7 commit 2 introduces only the DI seam + an in-process TTL cache
 * in front of a `UserLLMKeyRepo`. No call-site wires it yet — the
 * plan-router consumes this resolver in commit 4, after the
 * `UsageRecorder` lands in commit 3.
 *
 * Design drivers (from `.cmsgs/iter7-accounting-design.md` §3.1, §8):
 *
 *  1. The resolver is the ONLY component that reads `consent_mode` from
 *     user state. The router and the writer receive the resolved value
 *     through inputs — they never touch the repo directly. This keeps
 *     the consent-read side-effect in one testable place.
 *
 *  2. **Failure is degraded to `'minimal'`, not propagated.** If the
 *     repo throws (DB down, network partition, serialisation bug), the
 *     resolver logs via the metrics counter and returns `'minimal'` —
 *     the more restrictive mode. This is `§8 decisión firmada #8`:
 *     honouring consent is a safety invariant; failing open to `'full'`
 *     would silently over-collect. Users experience transient UI
 *     degradation (call count only) — never over-collection.
 *
 *  3. **Cache is process-local + TTL-bounded.** Consent changes apply
 *     from the audit timestamp forward (§8 contract); stale reads
 *     during the cache window are acceptable and consistent with that
 *     invariant. TTL default = 5 min (same ceiling as the DEK cache in
 *     §2 invariant 8 — keeps operators' mental model uniform).
 *
 *  4. **Cache hits, misses, and failure-fallbacks are metrics-labelled
 *     distinctly.** The counter
 *     `llm_consent_mode_resolved_total{mode, source}` lets Grafana
 *     separate cache efficacy (`source='cache'`) from repo load
 *     (`source='repo'`) and from degraded state
 *     (`source='default_on_failure'`). See §5.2 of the design doc.
 *
 * Not emitted by this module: OTel spans. The consent lookup is hot
 * enough (p50 <1ms under cache hit) that a full span per call would
 * double the observability overhead for no operational win. The router
 * can add a span attribute `llm.consent_mode` to its existing
 * `llm.call` span in commit 4 if operators ask.
 *
 * @see docs/LLM_CLIENT.md v1.1 §8
 * @see .cmsgs/iter7-accounting-design.md §3.1, §5.2, §8 decisión #8
 */

import type { Metrics } from '../observability/metrics.js';
import type { ConsentMode, UserLLMKeyRepo } from '../types/repos.js';

/**
 * Default TTL of a cached `ConsentMode`. Matches the DEK-cache TTL
 * ceiling (§2 invariant 8 / §16) so operators learn one number. The
 * practical lower bound is "long enough to amortise one repo query per
 * active caller"; 5 min is comfortable without letting a `'full'`→
 * `'minimal'` flip linger past a user's expectations.
 */
export const DEFAULT_CONSENT_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Hard cap on cache entries. Same order of magnitude as a single
 * worker's active-user working set. Prevents unbounded growth if the
 * resolver is fed a stream of unique user ids (e.g. replay of a stale
 * audit log feeding synthetic workloads). An LRU-style trim by oldest
 * expiry runs on insert when the cap is reached.
 */
export const DEFAULT_CONSENT_CACHE_MAX_ENTRIES = 10_000;

/**
 * Source dimension on the `llm_consent_mode_resolved_total` counter.
 * The dashboard uses this to partition cache hits vs repo load vs the
 * degraded-state fallback.
 */
export type ConsentSource = 'cache' | 'repo' | 'default_on_failure';

/**
 * Minimal clock abstraction so tests can assert TTL behaviour without
 * real timers. Shape chosen to match `Date.now()` so production code
 * passes `Date.now` directly. See `dek-cache`-style clock for the same
 * pattern used in the crypto layer.
 */
export type ConsentClock = () => number;

/**
 * Reader surface consumed by the plan-router (commit 4) and by the
 * future facade. Implementations are:
 *
 *  - non-throwing: any failure surfaces as a resolved `'minimal'`
 *    value, never a rejected promise;
 *  - idempotent under retry: safe to call twice for the same user id
 *    within the cache TTL;
 *  - async by contract: the cache layer is in-process but the
 *    underlying repo is Postgres-backed, so callers must `await`.
 */
export interface ConsentResolver {
  resolve(userId: string): Promise<ConsentMode>;
}

/** Dependencies for {@link createConsentResolverFromRepo}. */
export interface ConsentResolverDeps {
  /** Reader over `user_llm_key` rows. */
  readonly repo: UserLLMKeyRepo;
  /** Metrics sink — required so the counter is always emitted. */
  readonly metrics: Metrics;
  /**
   * Clock. Defaults to `Date.now`. Injected separately in tests to
   * drive TTL expiry deterministically.
   */
  readonly clock?: ConsentClock;
  /**
   * Override cache TTL. Defaults to
   * {@link DEFAULT_CONSENT_CACHE_TTL_MS}. Set to `0` to effectively
   * disable caching (every resolve hits the repo).
   */
  readonly cacheTtlMs?: number;
  /**
   * Override max cache entries. Defaults to
   * {@link DEFAULT_CONSENT_CACHE_MAX_ENTRIES}.
   */
  readonly cacheMaxEntries?: number;
}

interface CacheEntry {
  readonly mode: ConsentMode;
  /** Absolute expiry timestamp (ms). Compared against `clock()`. */
  readonly expiresAt: number;
}

/**
 * The default name of the counter emitted on every resolution.
 * Dimensions: `{mode, source}`.
 *
 * Exported so tests can assert on the exact metric name without
 * hand-keeping a string literal in two places.
 */
export const CONSENT_RESOLVED_COUNTER = 'llm_consent_mode_resolved_total';

/**
 * Build a {@link ConsentResolver} that reads `consent_mode` from the
 * supplied repo, with an in-process TTL cache in front.
 *
 * Behaviour contract:
 *
 *  - **Cache hit** (entry exists + `expiresAt > now`): return cached
 *    mode, increment `{source: 'cache'}`.
 *  - **Cache miss / expired**: call `repo.getConsentMode(userId)`.
 *    - `undefined` ⇒ no row yet ⇒ default to `'full'` (Privacy Policy
 *      acceptance path, see `UserLLMKeyRepo` JSDoc). The default is
 *      cached so repeat callers within the TTL don't hammer the repo
 *      for users that haven't set a BYOK key yet.
 *    - Non-undefined value ⇒ cached + returned.
 *    - Both paths increment `{source: 'repo'}`.
 *  - **Repo throws**: the exception is caught. Resolver returns
 *    `'minimal'`, increments `{source: 'default_on_failure'}`, and
 *    does **NOT** populate the cache (so the next call retries the
 *    repo — we don't want to pin a transient DB outage into the
 *    cache).
 *
 * Thread-safety: single-threaded V8. The `Map` operations are atomic.
 */
export function createConsentResolverFromRepo(
  deps: ConsentResolverDeps,
): ConsentResolver {
  const clock: ConsentClock = deps.clock ?? Date.now;
  const ttlMs = deps.cacheTtlMs ?? DEFAULT_CONSENT_CACHE_TTL_MS;
  const maxEntries = deps.cacheMaxEntries ?? DEFAULT_CONSENT_CACHE_MAX_ENTRIES;

  if (!Number.isFinite(ttlMs) || ttlMs < 0) {
    throw new Error(
      `createConsentResolverFromRepo: cacheTtlMs must be a non-negative ` +
        `finite number (got ${ttlMs}).`,
    );
  }
  if (!Number.isInteger(maxEntries) || maxEntries < 1) {
    throw new Error(
      `createConsentResolverFromRepo: cacheMaxEntries must be a positive ` +
        `integer (got ${maxEntries}).`,
    );
  }

  const cache = new Map<string, CacheEntry>();

  function enforceCapacity(): void {
    // Only one over-cap entry is inserted per call, so a single trim
    // is sufficient. Trim the entry with the smallest `expiresAt` —
    // approximates LRU without a linked list.
    if (cache.size <= maxEntries) return;
    let oldestKey: string | undefined;
    let oldestExpiresAt = Number.POSITIVE_INFINITY;
    for (const [k, v] of cache.entries()) {
      if (v.expiresAt < oldestExpiresAt) {
        oldestExpiresAt = v.expiresAt;
        oldestKey = k;
      }
    }
    if (oldestKey !== undefined) {
      cache.delete(oldestKey);
    }
  }

  function recordResolution(
    mode: ConsentMode,
    source: ConsentSource,
  ): void {
    deps.metrics.counter(CONSENT_RESOLVED_COUNTER, { mode, source });
  }

  return {
    async resolve(userId: string): Promise<ConsentMode> {
      if (!userId) {
        // Empty-string user id is always a programming bug. Fail
        // closed to `'minimal'` — never return `'full'` for an empty
        // id, because that value might accidentally be written as a
        // row key downstream.
        recordResolution('minimal', 'default_on_failure');
        return 'minimal';
      }

      const now = clock();

      const hit = cache.get(userId);
      if (hit !== undefined && hit.expiresAt > now) {
        recordResolution(hit.mode, 'cache');
        return hit.mode;
      }

      // Expired entry — drop before issuing the repo call. The new
      // value (or the `undefined` → `'full'` default) repopulates.
      if (hit !== undefined) {
        cache.delete(userId);
      }

      let mode: ConsentMode;
      try {
        const repoValue = await deps.repo.getConsentMode(userId);
        mode = repoValue ?? 'full';
      } catch {
        // Deliberately swallow — this is the §8 decisión #8 fallback.
        // Do NOT cache (transient outage shouldn't pin a degraded
        // state). Next call retries the repo.
        recordResolution('minimal', 'default_on_failure');
        return 'minimal';
      }

      if (ttlMs > 0) {
        cache.set(userId, {
          mode,
          expiresAt: now + ttlMs,
        });
        enforceCapacity();
      }

      recordResolution(mode, 'repo');
      return mode;
    },
  };
}
