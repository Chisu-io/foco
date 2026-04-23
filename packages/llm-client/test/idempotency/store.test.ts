/**
 * Tests for {@link InMemoryIdempotencyStore}.
 *
 * Contract the tests encode (iter 8 commit 1, §4 LLM_CLIENT.md):
 *
 *  1. Default capacity is 10 000 — signed in the iter 8 prompt.
 *  2. Capacity validation: non-integers, zero, negatives throw at
 *     construction time (no silent clamping).
 *  3. `get` on an unknown key → `undefined`, no side effects.
 *  4. `set` then `get` within TTL returns the stored value.
 *  5. `set` with `ttlMs <= 0` is a no-op (caller disabled caching).
 *  6. TTL is expiry-on-read: at the moment the clock crosses
 *     `setTime + ttlMs`, the next `get` returns `undefined` AND
 *     evicts the expired entry (verified via `size()`).
 *  7. LRU eviction: at capacity, the least-recently-used key is
 *     dropped when a fresh key is set.
 *  8. `get` touches: reading a key moves it to the MRU end so the
 *     next eviction targets some OTHER key.
 *  9. Re-`set` of an existing key moves it to MRU AND does not
 *     count toward capacity (no eviction triggered).
 * 10. `clear()` empties the store — subsequent `get` on previously
 *     stored keys returns `undefined`.
 *
 * All tests use a `ManualClock` so they are hermetic and never touch
 * real time. The store resolves its async contract synchronously
 * (no `setTimeout`), so no `vi.useFakeTimers()` is required.
 */

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_IDEMPOTENCY_CAPACITY,
  IDEMPOTENCY_HITS_COUNTER,
  IDEMPOTENCY_MISSES_COUNTER,
  InMemoryIdempotencyStore,
} from '../../src/idempotency/store.js';

import type { LLMCallOutput } from '../../src/types/response.js';

/**
 * Fixed start timestamp — mirrors the `FIXED_NOW` constant used in
 * `test/accounting/_fakes.ts` (2023-11-14T22:13:20.000Z) so any future
 * cross-module helper lands on a single date.
 */
const FIXED_NOW = 1_700_000_000_000;

class ManualClock {
  private t: number;
  constructor(start: number = FIXED_NOW) {
    this.t = start;
  }
  now = (): number => this.t;
  advanceMs(delta: number): void {
    this.t += delta;
  }
}

/**
 * Minimal `LLMCallOutput` factory for tests — every field required
 * by the §3.4 contract is populated, with `providerRequestId`
 * derived from the `tag` so tests can distinguish cached outputs by
 * their provider-side id.
 */
function outputFor(tag: string): LLMCallOutput {
  return {
    modelUsed: 'claude-3-5-sonnet-20241022',
    providerUsed: 'anthropic',
    fundingMode: 'byok',
    message: {
      role: 'assistant',
      content: [{ type: 'text', text: `stored ${tag}` }],
    },
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    stopReason: 'end_turn',
    latencyMs: 123,
    providerRequestId: `req-${tag}`,
  };
}

describe('InMemoryIdempotencyStore — shape and defaults', () => {
  it('exposes the signed default capacity constant (10 000)', () => {
    expect(DEFAULT_IDEMPOTENCY_CAPACITY).toBe(10_000);
  });

  it('exposes the facade-emitted counter names', () => {
    expect(IDEMPOTENCY_HITS_COUNTER).toBe('llm_idempotency_hits_total');
    expect(IDEMPOTENCY_MISSES_COUNTER).toBe('llm_idempotency_misses_total');
  });

  it('defaults capacity to DEFAULT_IDEMPOTENCY_CAPACITY when omitted', () => {
    const store = new InMemoryIdempotencyStore();
    expect(store.capacity).toBe(DEFAULT_IDEMPOTENCY_CAPACITY);
  });

  it('accepts a custom capacity', () => {
    const store = new InMemoryIdempotencyStore({ capacity: 3 });
    expect(store.capacity).toBe(3);
  });

  it.each([
    ['0', 0],
    ['negative', -1],
    ['float', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])(
    'rejects invalid capacity (%s) at construction',
    (_label, invalid) => {
      expect(
        () => new InMemoryIdempotencyStore({ capacity: invalid }),
      ).toThrow(/capacity must be a positive integer/);
    },
  );
});

describe('InMemoryIdempotencyStore — get/set basics', () => {
  it('returns undefined for an unknown key', async () => {
    const store = new InMemoryIdempotencyStore();
    await expect(store.get('missing')).resolves.toBeUndefined();
  });

  it('returns the stored value inside TTL', async () => {
    const clock = new ManualClock();
    const store = new InMemoryIdempotencyStore({ clock: clock.now });
    const value = outputFor('a');
    await store.set('key-a', value, 1000);
    clock.advanceMs(500);
    await expect(store.get('key-a')).resolves.toEqual(value);
  });

  it.each([
    ['zero ttl', 0],
    ['negative ttl', -100],
    ['NaN ttl', Number.NaN],
    ['-Infinity ttl', Number.NEGATIVE_INFINITY],
  ])('set with %s is a no-op', async (_label, ttlMs) => {
    const store = new InMemoryIdempotencyStore();
    await store.set('key-skip', outputFor('x'), ttlMs);
    expect(store.size()).toBe(0);
    await expect(store.get('key-skip')).resolves.toBeUndefined();
  });

  it('rejects Infinity TTL as a no-op (see set contract)', async () => {
    // Rationale: Number.isFinite(Infinity) === false, so the guard
    // treats Infinity the same way as NaN. The iter 8 prompt does not
    // sanction infinite TTLs; callers wanting "keep forever" must pick
    // a large finite ms count.
    const store = new InMemoryIdempotencyStore();
    await store.set('key-inf', outputFor('x'), Number.POSITIVE_INFINITY);
    expect(store.size()).toBe(0);
  });
});

describe('InMemoryIdempotencyStore — TTL expiry-on-read', () => {
  it('returns undefined exactly when the clock crosses setTime + ttl', async () => {
    const clock = new ManualClock();
    const store = new InMemoryIdempotencyStore({ clock: clock.now });
    await store.set('key-a', outputFor('a'), 1000);

    clock.advanceMs(999);
    await expect(store.get('key-a')).resolves.toBeDefined();

    clock.advanceMs(1); // now == setTime + 1000 → expired (<= check)
    await expect(store.get('key-a')).resolves.toBeUndefined();
  });

  it('evicts the expired entry from internal state on the read that observed expiry', async () => {
    const clock = new ManualClock();
    const store = new InMemoryIdempotencyStore({ clock: clock.now });
    await store.set('key-a', outputFor('a'), 1000);
    expect(store.size()).toBe(1);
    clock.advanceMs(2000);
    await store.get('key-a');
    expect(store.size()).toBe(0);
  });

  it('does not bleed expiry between independent keys', async () => {
    const clock = new ManualClock();
    const store = new InMemoryIdempotencyStore({ clock: clock.now });
    await store.set('short', outputFor('s'), 100);
    await store.set('long', outputFor('l'), 10_000);
    clock.advanceMs(500);
    await expect(store.get('short')).resolves.toBeUndefined();
    await expect(store.get('long')).resolves.toEqual(outputFor('l'));
  });
});

describe('InMemoryIdempotencyStore — LRU eviction at capacity', () => {
  it('evicts the least-recently-used key when a new key overflows', async () => {
    const store = new InMemoryIdempotencyStore({ capacity: 3 });
    await store.set('a', outputFor('a'), 10_000);
    await store.set('b', outputFor('b'), 10_000);
    await store.set('c', outputFor('c'), 10_000);
    // At capacity. Next set evicts 'a' (head of insertion order).
    await store.set('d', outputFor('d'), 10_000);

    expect(store.size()).toBe(3);
    await expect(store.get('a')).resolves.toBeUndefined();
    await expect(store.get('b')).resolves.toEqual(outputFor('b'));
    await expect(store.get('c')).resolves.toEqual(outputFor('c'));
    await expect(store.get('d')).resolves.toEqual(outputFor('d'));
  });

  it('get() touches a key — the next eviction targets a different one', async () => {
    const store = new InMemoryIdempotencyStore({ capacity: 3 });
    await store.set('a', outputFor('a'), 10_000);
    await store.set('b', outputFor('b'), 10_000);
    await store.set('c', outputFor('c'), 10_000);

    // Touch 'a' → 'b' becomes the oldest.
    await store.get('a');
    await store.set('d', outputFor('d'), 10_000);

    await expect(store.get('a')).resolves.toEqual(outputFor('a'));
    await expect(store.get('b')).resolves.toBeUndefined();
    await expect(store.get('c')).resolves.toEqual(outputFor('c'));
    await expect(store.get('d')).resolves.toEqual(outputFor('d'));
  });

  it('re-setting an existing key moves it to MRU without evicting', async () => {
    const store = new InMemoryIdempotencyStore({ capacity: 3 });
    await store.set('a', outputFor('a'), 10_000);
    await store.set('b', outputFor('b'), 10_000);
    await store.set('c', outputFor('c'), 10_000);

    // Overwrite 'a' → size stays 3, order becomes b, c, a.
    await store.set('a', outputFor('a2'), 10_000);
    expect(store.size()).toBe(3);

    // Next new key evicts 'b' (now the oldest), not the re-set 'a'.
    await store.set('d', outputFor('d'), 10_000);
    await expect(store.get('b')).resolves.toBeUndefined();
    await expect(store.get('a')).resolves.toEqual(outputFor('a2'));
    await expect(store.get('c')).resolves.toEqual(outputFor('c'));
    await expect(store.get('d')).resolves.toEqual(outputFor('d'));
  });

  it('capacity=1 degenerate case: each new key evicts the previous', async () => {
    const store = new InMemoryIdempotencyStore({ capacity: 1 });
    await store.set('a', outputFor('a'), 10_000);
    await store.set('b', outputFor('b'), 10_000);
    expect(store.size()).toBe(1);
    await expect(store.get('a')).resolves.toBeUndefined();
    await expect(store.get('b')).resolves.toEqual(outputFor('b'));
  });
});

describe('InMemoryIdempotencyStore — clear', () => {
  it('empties the store', async () => {
    const store = new InMemoryIdempotencyStore({ capacity: 5 });
    await store.set('a', outputFor('a'), 10_000);
    await store.set('b', outputFor('b'), 10_000);
    expect(store.size()).toBe(2);

    await store.clear();

    expect(store.size()).toBe(0);
    await expect(store.get('a')).resolves.toBeUndefined();
    await expect(store.get('b')).resolves.toBeUndefined();
  });

  it('is idempotent — calling clear twice is safe', async () => {
    const store = new InMemoryIdempotencyStore();
    await store.set('a', outputFor('a'), 10_000);
    await store.clear();
    await store.clear();
    expect(store.size()).toBe(0);
  });
});
