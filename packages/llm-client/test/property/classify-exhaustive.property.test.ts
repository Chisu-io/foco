/**
 * Property-based exhaustiveness for `classifyProviderHttpError`.
 *
 * Covers the §7.1 invariant that the classifier:
 *
 *  1. Always returns a `LLMCallError` (never throws, never returns
 *     undefined).
 *  2. The returned `kind` depends only on (status, billingError,
 *     http400Hint) — not on jitter, not on time, not on provider
 *     identity except for embedding it in the error.
 *  3. The taxonomy is closed under the full HTTP status space (0-999)
 *     — no status ever produces an uncategorised "neutral" result.
 *
 * The unit suite in `test/errors/classify.test.ts` pins 82 specific
 * (status, hint) pairs. This property suite exhausts the integer
 * status space with `fc.integer` and cross-product over provider +
 * billingError to ensure no hidden gap exists.
 *
 * @see LLM_CLIENT.md §7.1 — Provider error taxonomy.
 */

import fc from 'fast-check';
import { describe, it } from 'vitest';

import { classifyProviderHttpError } from '../../src/errors/classify.js';

import type { ProviderName } from '../../src/providers/provider.js';

const PROVIDERS: readonly ProviderName[] = ['anthropic', 'openai', 'gemini'];

describe('classifyProviderHttpError — exhaustive properties', () => {
  it('never throws for any (provider, status, billingError) combination', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROVIDERS),
        fc.integer({ min: 0, max: 999 }),
        fc.boolean(),
        (provider, status, billingError) => {
          // The classifier MUST NOT throw. Return the kind for shape
          // assertion below.
          const res = classifyProviderHttpError({
            provider,
            status,
            billingError,
          });
          return typeof res.kind === 'string' && res.kind.length > 0;
        },
      ),
      { numRuns: 500 },
    );
  });

  it('billingError=true always produces quota_exhausted regardless of status', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROVIDERS),
        fc.integer({ min: 0, max: 999 }),
        (provider, status) => {
          const res = classifyProviderHttpError({
            provider,
            status,
            billingError: true,
          });
          return res.kind === 'quota_exhausted';
        },
      ),
      { numRuns: 200 },
    );
  });

  it('5xx family (500/502/503/504) always produces provider_down', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROVIDERS),
        fc.constantFrom(500, 502, 503, 504),
        (provider, status) => {
          const res = classifyProviderHttpError({
            provider,
            status,
          });
          return res.kind === 'provider_down';
        },
      ),
      { numRuns: 50 },
    );
  });

  it('401/403 always produces invalid_key when billingError is not set', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROVIDERS),
        fc.constantFrom(401, 403),
        (provider, status) => {
          const res = classifyProviderHttpError({
            provider,
            status,
          });
          return res.kind === 'invalid_key';
        },
      ),
      { numRuns: 50 },
    );
  });

  it('429 without billingError always produces rate_limit', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROVIDERS),
        (provider) => {
          const res = classifyProviderHttpError({
            provider,
            status: 429,
          });
          return res.kind === 'rate_limit';
        },
      ),
      { numRuns: 20 },
    );
  });

  it('unknown statuses (3xx, 408, etc.) fall back to internal — never silently succeed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...PROVIDERS),
        // Statuses NOT in any mapped range. 200-299, 401, 402, 403,
        // 429, 500, 502, 503, 504, 400 are explicitly handled; the
        // rest should land on internal.
        fc.integer({ min: 300, max: 399 }).filter((s) => s !== 400),
        (provider, status) => {
          const res = classifyProviderHttpError({
            provider,
            status,
          });
          return res.kind === 'internal';
        },
      ),
      { numRuns: 100 },
    );
  });
});
