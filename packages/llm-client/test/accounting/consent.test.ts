/**
 * Tests for `src/accounting/consent.ts` — iter 7 commit 2.
 *
 * Invariants under test (mini-spec §3.1, §8 decisión #8):
 *
 *  - Fresh repo read populates the cache; immediate re-read hits cache.
 *  - `undefined` from repo ⇒ resolver returns `'full'` (Privacy Policy
 *    default for rows that never existed) and the default is cached.
 *  - Explicit `'minimal'` / `'full'` from repo round-trip faithfully.
 *  - TTL expiry forces a second repo read; new value is reflected.
 *  - Repo throw ⇒ resolver returns `'minimal'` and does NOT cache
 *    (next call retries the repo).
 *  - Empty user id ⇒ `'minimal'` without touching the repo.
 *  - The `llm_consent_mode_resolved_total{mode, source}` counter is
 *    emitted for every resolution with the right labels.
 *  - `cacheMaxEntries` enforces a hard cap under insert pressure.
 *
 * Non-goals for this commit: call-site wiring (lands in commit 4),
 * `UsageRecorder` coupling (lands in commit 3). Those land with their
 * own tests and do not retroactively relax these invariants.
 */

import { describe, expect, it } from 'vitest';

import {
  ExplodingUserLLMKeyRepo,
  FIXED_NOW,
  InMemoryUserLLMKeyRepo,
  ManualClock,
} from './_fakes.js';
import {
  CONSENT_RESOLVED_COUNTER,
  DEFAULT_CONSENT_CACHE_MAX_ENTRIES,
  DEFAULT_CONSENT_CACHE_TTL_MS,
  createConsentResolverFromRepo,
} from '../../src/accounting/consent.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';

describe('ConsentResolver — iter 7 commit 2', () => {
  it('reads from repo on first call and caches for subsequent calls within TTL', async () => {
    const repo = new InMemoryUserLLMKeyRepo();
    repo.setMode('user-a', 'minimal');
    const metrics = new InMemoryMetrics();
    const clock = new ManualClock();
    const resolver = createConsentResolverFromRepo({
      repo,
      metrics,
      clock: clock.now,
    });

    expect(await resolver.resolve('user-a')).toBe('minimal');
    expect(await resolver.resolve('user-a')).toBe('minimal');
    expect(await resolver.resolve('user-a')).toBe('minimal');

    // One repo call, two cache hits.
    expect(repo.calls).toBe(1);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'minimal',
        source: 'repo',
      }),
    ).toBe(1);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'minimal',
        source: 'cache',
      }),
    ).toBe(2);
  });

  it('maps undefined from repo to the `full` default and caches that default', async () => {
    // Row doesn't exist — user has accepted PP but never saved a BYOK
    // key. Per UserLLMKeyRepo JSDoc, the resolver defaults to `full`.
    const repo = new InMemoryUserLLMKeyRepo();
    const metrics = new InMemoryMetrics();
    const resolver = createConsentResolverFromRepo({
      repo,
      metrics,
      clock: () => FIXED_NOW,
    });

    expect(await resolver.resolve('never-saved-key')).toBe('full');
    expect(await resolver.resolve('never-saved-key')).toBe('full');

    // Only one repo call — the default was cached.
    expect(repo.calls).toBe(1);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'full',
        source: 'repo',
      }),
    ).toBe(1);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'full',
        source: 'cache',
      }),
    ).toBe(1);
  });

  it('forces a repo re-read after TTL elapses and reflects the new value', async () => {
    const repo = new InMemoryUserLLMKeyRepo();
    repo.setMode('user-flip', 'full');
    const metrics = new InMemoryMetrics();
    const clock = new ManualClock();

    const resolver = createConsentResolverFromRepo({
      repo,
      metrics,
      clock: clock.now,
      cacheTtlMs: 1_000,
    });

    expect(await resolver.resolve('user-flip')).toBe('full');

    // Within TTL — still `full` from cache.
    clock.advanceMs(500);
    expect(await resolver.resolve('user-flip')).toBe('full');
    expect(repo.calls).toBe(1);

    // User flips to `minimal` in the meantime. TTL not yet up.
    repo.setMode('user-flip', 'minimal');
    clock.advanceMs(499);
    expect(await resolver.resolve('user-flip')).toBe('full'); // stale OK
    expect(repo.calls).toBe(1);

    // Now TTL elapses — the next call must re-hit the repo.
    clock.advanceMs(2); // total elapsed: 1001ms
    expect(await resolver.resolve('user-flip')).toBe('minimal');
    expect(repo.calls).toBe(2);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'minimal',
        source: 'repo',
      }),
    ).toBe(1);
  });

  it('returns `minimal` and increments `default_on_failure` when the repo throws', async () => {
    const repo = new ExplodingUserLLMKeyRepo();
    const metrics = new InMemoryMetrics();
    const resolver = createConsentResolverFromRepo({
      repo,
      metrics,
      clock: () => FIXED_NOW,
    });

    expect(await resolver.resolve('any-user')).toBe('minimal');
    expect(await resolver.resolve('any-user')).toBe('minimal');

    // Both calls re-hit the repo — failure is NOT cached (§8 decisión
    // #8: transient outage shouldn't pin a degraded state).
    expect(repo.calls).toBe(2);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'minimal',
        source: 'default_on_failure',
      }),
    ).toBe(2);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'minimal',
        source: 'cache',
      }),
    ).toBe(0);
  });

  it('rejects empty user id with `minimal` without touching the repo', async () => {
    const repo = new InMemoryUserLLMKeyRepo();
    const metrics = new InMemoryMetrics();
    const resolver = createConsentResolverFromRepo({
      repo,
      metrics,
      clock: () => FIXED_NOW,
    });

    expect(await resolver.resolve('')).toBe('minimal');
    expect(repo.calls).toBe(0);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'minimal',
        source: 'default_on_failure',
      }),
    ).toBe(1);
  });

  it('isolates cache entries per userId', async () => {
    const repo = new InMemoryUserLLMKeyRepo();
    repo.setMode('alice', 'full');
    repo.setMode('bob', 'minimal');
    const metrics = new InMemoryMetrics();
    const resolver = createConsentResolverFromRepo({
      repo,
      metrics,
      clock: () => FIXED_NOW,
    });

    expect(await resolver.resolve('alice')).toBe('full');
    expect(await resolver.resolve('bob')).toBe('minimal');
    expect(await resolver.resolve('alice')).toBe('full');
    expect(await resolver.resolve('bob')).toBe('minimal');

    // Two repo calls (one per distinct user), two cache hits total.
    expect(repo.calls).toBe(2);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'full',
        source: 'cache',
      }),
    ).toBe(1);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'minimal',
        source: 'cache',
      }),
    ).toBe(1);
  });

  it('enforces `cacheMaxEntries` as a hard cap (oldest-expiry eviction)', async () => {
    const repo = new InMemoryUserLLMKeyRepo();
    // Seed 3 users, all `minimal`.
    for (const u of ['u1', 'u2', 'u3']) {
      repo.setMode(u, 'minimal');
    }
    const metrics = new InMemoryMetrics();
    const clock = new ManualClock();

    // Cap: 2 entries. Each insert bumps the clock by 10ms so expiry
    // timestamps are strictly ordered — the trim-by-oldest-expiry
    // rule has a deterministic target.
    const resolver = createConsentResolverFromRepo({
      repo,
      metrics,
      clock: clock.now,
      cacheMaxEntries: 2,
      cacheTtlMs: 60_000,
    });

    // t=0: insert u1 (expires 60_000). Size: 1.
    await resolver.resolve('u1');

    clock.advanceMs(10);
    // t=10: insert u2 (expires 60_010). Size: 2 — at cap.
    await resolver.resolve('u2');

    clock.advanceMs(10);
    // t=20: insert u3 (expires 60_020). Size briefly 3, trim evicts
    // u1 (smallest expiresAt). Cache now: {u2, u3}.
    await resolver.resolve('u3');

    // u2 + u3 are still in cache — these should hit.
    await resolver.resolve('u2');
    await resolver.resolve('u3');

    // u1 was evicted — next resolve hits the repo again and triggers
    // another eviction (u2 now has smallest expiresAt = 60_010).
    await resolver.resolve('u1');

    // 4 repo calls total (u1 twice, u2 + u3 once each).
    expect(repo.calls).toBe(4);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'minimal',
        source: 'repo',
      }),
    ).toBe(4);
    // 2 cache hits total (u2 + u3 each hit once on the second pass).
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'minimal',
        source: 'cache',
      }),
    ).toBe(2);
  });

  it('exposes correctly-named defaults for the TTL and capacity knobs', () => {
    // Invariant-pin: the defaults are published constants so callers
    // can reason about the cache without re-reading the source. If
    // these numbers change, the design doc (§3.1) must change with
    // them.
    expect(DEFAULT_CONSENT_CACHE_TTL_MS).toBe(5 * 60 * 1000);
    expect(DEFAULT_CONSENT_CACHE_MAX_ENTRIES).toBe(10_000);
    expect(CONSENT_RESOLVED_COUNTER).toBe('llm_consent_mode_resolved_total');
  });

  it('rejects nonsensical cache configuration at construction time', () => {
    const repo = new InMemoryUserLLMKeyRepo();
    const metrics = new InMemoryMetrics();

    expect(() =>
      createConsentResolverFromRepo({
        repo,
        metrics,
        cacheTtlMs: -1,
      }),
    ).toThrow(/cacheTtlMs/);

    expect(() =>
      createConsentResolverFromRepo({
        repo,
        metrics,
        cacheTtlMs: Number.NaN,
      }),
    ).toThrow(/cacheTtlMs/);

    expect(() =>
      createConsentResolverFromRepo({
        repo,
        metrics,
        cacheMaxEntries: 0,
      }),
    ).toThrow(/cacheMaxEntries/);

    expect(() =>
      createConsentResolverFromRepo({
        repo,
        metrics,
        cacheMaxEntries: 1.5,
      }),
    ).toThrow(/cacheMaxEntries/);
  });

  it('bypasses the cache when `cacheTtlMs` is 0 (every resolve hits the repo)', async () => {
    const repo = new InMemoryUserLLMKeyRepo();
    repo.setMode('user-x', 'full');
    const metrics = new InMemoryMetrics();
    const resolver = createConsentResolverFromRepo({
      repo,
      metrics,
      clock: () => FIXED_NOW,
      cacheTtlMs: 0,
    });

    await resolver.resolve('user-x');
    await resolver.resolve('user-x');
    await resolver.resolve('user-x');

    expect(repo.calls).toBe(3);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'full',
        source: 'cache',
      }),
    ).toBe(0);
    expect(
      metrics.readCounter(CONSENT_RESOLVED_COUNTER, {
        mode: 'full',
        source: 'repo',
      }),
    ).toBe(3);
  });
});
