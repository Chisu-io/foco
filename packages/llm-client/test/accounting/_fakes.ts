/**
 * Test fakes for the accounting layer.
 *
 * Kept in a shared `_fakes.ts` (leading underscore mirrors the
 * convention already in use at `test/providers/_fake-http.ts`) so
 * commit 3's `UsageRecorder` tests can import the same `InMemoryRepo`
 * and hand-rolled `FakeRepo` builders without duplicating setup.
 *
 * These fakes are deliberately NOT exported from the package surface.
 * The concrete Postgres implementation lands in `apps/web/` (iter 8);
 * letting test doubles leak into `src/` would risk them getting wired
 * into production.
 */

import type {
  ConsentMode,
  UserLLMKeyRepo,
} from '../../src/types/repos.js';

/**
 * Trivial in-memory repo. Good for straight-line happy-path assertions
 * where the test only needs to seed values and read them back through
 * the resolver.
 */
export class InMemoryUserLLMKeyRepo implements UserLLMKeyRepo {
  /** `userId → mode`. Absent keys ⇒ resolver sees `undefined`. */
  private readonly modes = new Map<string, ConsentMode>();
  /** Number of `getConsentMode` calls — lets tests assert caching. */
  public calls = 0;

  setMode(userId: string, mode: ConsentMode): void {
    this.modes.set(userId, mode);
  }

  clearMode(userId: string): void {
    this.modes.delete(userId);
  }

  async getConsentMode(userId: string): Promise<ConsentMode | undefined> {
    this.calls += 1;
    return this.modes.get(userId);
  }
}

/**
 * Repo that throws on every call. Used to exercise the
 * `default_on_failure` path without having to juggle promise-rejection
 * setup inside each test.
 */
export class ExplodingUserLLMKeyRepo implements UserLLMKeyRepo {
  public calls = 0;
  constructor(private readonly err: Error = new Error('boom: repo down')) {}

  async getConsentMode(_userId: string): Promise<ConsentMode | undefined> {
    this.calls += 1;
    throw this.err;
  }
}

/**
 * Mutable clock. Starts at `FIXED_NOW` (matches `audit-sink.test.ts`
 * convention) and exposes `advanceMs` so tests can drive TTL expiry
 * without `vi.useFakeTimers()` — the resolver talks to the clock
 * directly, so no timer involvement is needed.
 */
export const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z

export class ManualClock {
  private t: number;
  constructor(start: number = FIXED_NOW) {
    this.t = start;
  }
  now = (): number => this.t;
  advanceMs(delta: number): void {
    this.t += delta;
  }
  set(ts: number): void {
    this.t = ts;
  }
}
