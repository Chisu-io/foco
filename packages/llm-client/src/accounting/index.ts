/**
 * Barrel for the accounting layer.
 *
 * Iter 7 commit 2 ships the `ConsentResolver` DI seam. Commits 3 and 4
 * will add `UsageRecorder` + its buffer and then wire both seams into
 * `plan-router.route()`.
 *
 * Consumers outside `packages/llm-client/` (notably the iter 8 facade
 * and `apps/web` concrete implementations) import from the package's
 * public surface — see `src/index.ts`.
 */

export {
  CONSENT_RESOLVED_COUNTER,
  DEFAULT_CONSENT_CACHE_MAX_ENTRIES,
  DEFAULT_CONSENT_CACHE_TTL_MS,
  createConsentResolverFromRepo,
  type ConsentClock,
  type ConsentResolver,
  type ConsentResolverDeps,
  type ConsentSource,
} from './consent.js';
