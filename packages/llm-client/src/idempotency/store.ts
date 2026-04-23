/**
 * Idempotency cache for `LLMClient.call()`.
 *
 * Implements the dedup half of §4 "Latency & Idempotency" of
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md`} v1.1 and the
 * Iteration 8 prompt at
 * {@link ../../../../.cmsgs/iter8-prompt.md `iter8-prompt.md`}
 * ("idempotency.backend" decision: in-memory LRU cap 10k;
 * Redis-backed impl ships in iteration 9).
 *
 * ## Why "get / set / clear" and nothing else
 *
 * The facade is the only caller. It needs exactly three operations:
 *
 *  1. `get(key)` before a router call, returning the cached
 *     `LLMCallOutput` or `undefined`.
 *  2. `set(key, value, ttlMs)` after a successful router call.
 *  3. `clear()` during `close()` so a fresh `LLMClient` starts clean.
 *
 * No `delete(key)` — the router never invalidates individual entries
 * (keys include the prompt hash, so "invalidate on model change" is a
 * no-op) and exposing one would invite misuse.
 *
 * No `has(key)` — semantically collapsible with `get`, and a separate
 * method invites TOCTOU races when a future Redis impl lands.
 *
 * No async iterator or `entries()` — the store is a black box; tests
 * assert behaviour through `get` / `set` only, never by snapshotting
 * internal state. Keeps the interface honest when Redis takes over.
 *
 * ## TTL semantics: expiry-on-read
 *
 * The in-memory impl does **not** sweep expired entries on a timer.
 * Expiry is checked at read time only. Rationale:
 *
 *  - A 10k-entry cap with ~300 s TTL means expired entries can
 *    occupy, at worst, every slot. That is fine — they get evicted
 *    LRU-style as new entries come in, and a `get()` on one returns
 *    `undefined` (fresh miss). No observer sees stale data; the only
 *    cost is a constant memory footprint, which is bounded by
 *    `capacity` anyway.
 *  - A background sweeper would need a timer handle, which would need
 *    to be drained in `close()`, which multiplies the number of
 *    moving parts in the facade. For an in-memory cache that a
 *    process restart already wipes, the sweeper is not worth its
 *    keep. (If Redis-backed Iter 9 adopts a different strategy, that
 *    is that impl's concern — the interface does not force the
 *    choice.)
 *
 * ## LRU policy
 *
 * Standard `Map` insertion-order trick: on `get` and `set` we
 * `delete(key)` then `set(key, value)` so the most recently touched
 * entry moves to the tail. Eviction pops `entries().next().value`
 * (head). O(1) on both paths.
 *
 * @see LLM_CLIENT.md §4 — Latency & Idempotency
 * @see .cmsgs/iter8-prompt.md — signed scope
 */

import { defaultClock, type Clock } from '../time.js';

import type { LLMCallOutput } from '../types/response.js';

/**
 * Maximum number of entries the in-memory LRU will retain. Signed in
 * the iter 8 prompt ("idempotency.backend → interface
 * `IdempotencyStore` + impl in-memory LRU cap 10k"). Exposed as a
 * constant so test assertions and the Redis impl (iter 9) can share a
 * single source of truth for the cap.
 */
export const DEFAULT_IDEMPOTENCY_CAPACITY = 10_000;

/**
 * Metric name emitted by the facade on an idempotency HIT. Dim:
 * `{reason}`. Currently only `same_request` — future reasons (e.g.
 * `same_key_diff_consent`) would extend the dimension without
 * renaming the counter.
 *
 * The store does **not** emit this itself — the facade is the layer
 * that knows the semantic difference between "cache miss" and "cache
 * disabled", so centralising emission there keeps the store dumb.
 * This constant lives here so call sites import a typed symbol
 * instead of retyping the literal.
 */
export const IDEMPOTENCY_HITS_COUNTER = 'llm_idempotency_hits_total';

/** Metric name emitted by the facade on an idempotency MISS. No dims. */
export const IDEMPOTENCY_MISSES_COUNTER = 'llm_idempotency_misses_total';

/**
 * Narrow write surface exposed by any idempotency backend.
 *
 * Methods are async so a Redis-backed impl (iter 9) fits without
 * breaking callers. The in-memory impl resolves synchronously via
 * `Promise.resolve` — there is no `setTimeout` side-channel, so tests
 * using `vi.useFakeTimers()` are unaffected.
 */
export interface IdempotencyStore {
  /**
   * Look up `key`. Returns the cached output if present and not
   * expired; `undefined` otherwise. MUST NOT throw — a backend outage
   * should be surfaced as "miss" from the facade's perspective so the
   * call falls through to the router.
   */
  get(key: string): Promise<LLMCallOutput | undefined>;

  /**
   * Store `value` under `key` for at most `ttlMs` milliseconds from
   * now. Ignores non-positive TTLs (treated as "do not store"). MUST
   * NOT throw — a backend outage degrades to "miss on next read".
   */
  set(key: string, value: LLMCallOutput, ttlMs: number): Promise<void>;

  /**
   * Drop every entry. Called by `LLMClient.close()` so a fresh
   * `LLMClient` over the same process does not leak state. MUST NOT
   * throw.
   */
  clear(): Promise<void>;
}

/**
 * Construction options for {@link InMemoryIdempotencyStore}. All
 * fields are optional — a bare `new InMemoryIdempotencyStore()` is
 * valid and picks production defaults.
 */
export interface InMemoryIdempotencyStoreOptions {
  /**
   * Hard cap on retained entries. Defaults to
   * {@link DEFAULT_IDEMPOTENCY_CAPACITY}. Must be a positive integer;
   * invalid values throw at construction so the misconfiguration is
   * not silently accepted.
   */
  readonly capacity?: number;

  /**
   * Clock for TTL comparisons. Defaults to {@link defaultClock}
   * ({@link Date.now}). Tests inject a `ManualClock.now`.
   */
  readonly clock?: Clock;
}

interface Entry {
  readonly value: LLMCallOutput;
  /**
   * Absolute expiry timestamp (ms since epoch). `Infinity` is NOT
   * supported — TTLs are bounded in practice, and an infinite TTL
   * would collide with "do not store" (non-positive TTL). Callers
   * that want "keep forever" should pick a large finite ms count.
   */
  readonly expiresAt: number;
}

/**
 * Bounded in-memory LRU idempotency store with expiry-on-read.
 *
 * Shape contract:
 *
 *  - `get` on a missing or expired key returns `undefined` and
 *    evicts the expired entry as a side effect (so the hit rate
 *    reflects true capacity, not accounting for expired slots).
 *  - `set` moves the key to the MRU end; if the store is at
 *    capacity and the key is new, the LRU entry (head of the Map)
 *    is evicted.
 *  - `set` with `ttlMs <= 0` is a no-op. Rationale: the iter 8
 *    prompt's default TTL is 300 000 ms and a caller passing 0 is
 *    almost certainly disabling caching for one request; the right
 *    behaviour is "do not remember", not "remember for 0 ms then
 *    immediately expire".
 *
 * The store is intentionally NOT thread-safe (Node.js single-thread
 * semantics). A worker-thread deployment would need a different
 * backend (Redis, iter 9).
 */
export class InMemoryIdempotencyStore implements IdempotencyStore {
  /**
   * MRU order is `Map` insertion order. `entries().next().value` is
   * the LRU head; the most recently `set()` key is at the tail.
   */
  private readonly entries = new Map<string, Entry>();

  readonly capacity: number;

  private readonly clock: Clock;

  constructor(options: InMemoryIdempotencyStoreOptions = {}) {
    const capacity = options.capacity ?? DEFAULT_IDEMPOTENCY_CAPACITY;
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(
        `InMemoryIdempotencyStore: capacity must be a positive integer (got ${String(
          capacity,
        )}).`,
      );
    }
    this.capacity = capacity;
    this.clock = options.clock ?? defaultClock;
  }

  /** Test helper: current occupancy. Never production-relevant. */
  size(): number {
    return this.entries.size;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- `IdempotencyStore.get` is contractually `Promise<T>`; the in-memory adapter has no IO to await but must match the interface other adapters (Redis, SQL) fulfil with real async work.
  async get(key: string): Promise<LLMCallOutput | undefined> {
    const entry = this.entries.get(key);
    if (entry === undefined) return undefined;
    if (entry.expiresAt <= this.clock()) {
      // Expired — evict so a follow-up `set` does not see a ghost
      // entry and waste its eviction budget on our corpse.
      this.entries.delete(key);
      return undefined;
    }
    // Touch: move to MRU end by re-inserting.
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry.value;
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- `IdempotencyStore.set` is contractually `Promise<void>`; in-memory adapter has no IO to await but must match the interface.
  async set(
    key: string,
    value: LLMCallOutput,
    ttlMs: number,
  ): Promise<void> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) return;
    const expiresAt = this.clock() + ttlMs;
    // If the key already exists, `delete` first so the re-insert
    // lands at the MRU end regardless of prior position.
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.capacity) {
      // Evict LRU head. `entries().next()` on an empty Map is `done`,
      // but we already established `size >= capacity >= 1` so the
      // iterator yields at least one value.
      const oldest = this.entries.keys().next();
      if (!oldest.done) {
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, { value, expiresAt });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- `IdempotencyStore.clear` is contractually `Promise<void>`; in-memory adapter has no IO to await but must match the interface.
  async clear(): Promise<void> {
    this.entries.clear();
  }
}
