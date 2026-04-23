/**
 * Test fakes for the `LLMClient` facade specs.
 *
 * Scoped to `test/client/` — no prod-facing exports. Mirrors the
 * `test/accounting/_fakes.ts` / `test/scheduler/_fakes.ts` convention
 * (leading underscore, local to the feature area). Kept deliberately
 * minimal: each fake exposes only the assertions the client specs
 * actually need.
 *
 * ## What lives where
 *
 *  - `FakePlanRouter` — the most elaborate fake. Tests queue one
 *    `Result<RouterCallOutput, LLMCallError>` per call via `enqueue(...)`
 *    / `enqueueDelayed(...)`; `callLog` captures every `RouteInput` so
 *    specs assert `abortSignal` / `correlationId` / `origin` propagation.
 *  - `FakeEnvelopeCrypto` — placeholder. The facade never invokes it in
 *    iter 8 c3 (router owns key-decrypt), so the fake only needs to be
 *    pluggable as a dep.
 *  - `FakeUsageBuffer` — controllable `size()` + readonly `capacity`.
 *    Does NOT extend `UsageBuffer` because the facade only reads
 *    `.size()`; a structural subtype is leaner for the assertions.
 *  - `FakeIdempotencyStore` — Map-backed, tracks `getCalls` / `setCalls`
 *    / `clearCalls` + last args, lets tests preseed + inspect.
 *  - `FakeFlushScheduler` — tracks every lifecycle entry point so
 *    "constructor started", "close stopped", "notifyBufferChanged
 *    fired after ok" are all asserted structurally.
 *  - `FakeClock` — monotonic manual clock, advances via `advanceMs(n)`.
 *    Mirrors `test/accounting/_fakes.ts::ManualClock` but local so the
 *    client suite does not cross-import into accounting fakes.
 *  - `FakeLogger` — re-exported from `../scheduler/_fakes.js` (same
 *    shape is needed and the scheduler suite already pins the pattern).
 *  - `makeCallInput(...)` — builder helper; every spec needs a valid
 *    `LLMCallInput` and threading the full shape by hand is noise.
 *  - `makeRouterCallOutput(...)` — builder for the ok-result the router
 *    returns so tests can override single fields without rebuilding.
 *
 * Fakes are deliberately NOT exported from the package surface — the
 * concrete deps land in `apps/web/` wiring; letting doubles leak into
 * `src/` would risk them getting shipped to prod.
 */

import { type LLMCallError } from '../../src/errors/taxonomy.js';
import { err, ok, type Result } from '../../src/types.js';

import type { UsageBuffer } from '../../src/accounting/usage-counter.js';
import type { LLMCallInput } from '../../src/client.js';
import type { EnvelopeCrypto } from '../../src/crypto/envelope.js';
import type { IdempotencyStore } from '../../src/idempotency/store.js';
import type {
  UserQuotaRepo,
  UserQuotaRepoError,
} from '../../src/repos/user-quota-repo.js';
import type {
  PlanRouter,
  RouteInput,
  RoutePingInput,
  RouterCallOutput,
  UserQuota,
} from '../../src/routing/plan-router.js';
import type { FlushScheduler } from '../../src/scheduler/flush-scheduler.js';
import type { FlushTrigger } from '../../src/scheduler/flush-scheduler.js';
import type { NormalizedLLMRequest } from '../../src/types/request.js';
import type { LLMCallOutput, PingOutput } from '../../src/types/response.js';

// Re-export FakeLogger from the scheduler suite so client specs need
// only `from './_fakes.js'`. The shape is identical and pinning it in
// one place avoids a drift hazard across tests.
export { FakeLogger } from '../scheduler/_fakes.js';

// ─── FakeClock ────────────────────────────────────────────────────────

/**
 * Fixed millisecond epoch used as the clock starting point. Same value
 * as `test/accounting/_fakes.ts::FIXED_NOW` so audit timestamps across
 * the whole test surface are comparable when a spec spans multiple
 * fakes.
 */
export const CLIENT_FIXED_NOW = 1_700_000_000_000;

/**
 * Monotonic manual clock. Starts at {@link CLIENT_FIXED_NOW} and only
 * moves when the test calls `advanceMs(n)`. Exposed via `.now` as a
 * bound method so it satisfies the `Clock = () => number` type when
 * passed as `deps.clock`.
 */
export class FakeClock {
  private t: number;

  constructor(start: number = CLIENT_FIXED_NOW) {
    this.t = start;
  }

  readonly now = (): number => this.t;

  advanceMs(delta: number): void {
    this.t += delta;
  }

  set(ts: number): void {
    this.t = ts;
  }
}

// ─── FakePlanRouter ───────────────────────────────────────────────────

/**
 * Controllable {@link PlanRouter} for facade specs.
 *
 * Tests queue outcomes via `enqueue(result)` or `enqueueDelayed(result,
 * ms)`; each `.route()` call shifts one off the queue. An empty queue
 * falls back to `fallbackResult`, defaulting to a
 * `make.internal('fake-router: no queued result')` so a forgotten
 * seed fails loudly.
 */
export class FakePlanRouter implements PlanRouter {
  /** Captured arg from every `.route()` call (in invocation order). */
  readonly callLog: RouteInput[] = [];

  /** Queue of outcomes; shifts on every call. */
  private readonly queue: {
    readonly result: Result<RouterCallOutput, LLMCallError>;
    readonly delayMs: number;
  }[] = [];

  /** Used when the queue is empty. Tests override for fallthrough specs. */
  fallbackResult: Result<RouterCallOutput, LLMCallError> = err({
    kind: 'internal',
    correlationId: 'fake-router: no queued result',
  });

  /**
   * Optional per-call observer. Fires before the delay. Lets specs
   * assert state mid-flight (e.g. inflight size while a long call
   * is pending). `signature: (input) => void`.
   */
  onRoute: ((input: RouteInput) => void) | undefined;

  /** Queue a resolved result to hand out on the next `.route()` call. */
  enqueue(result: Result<RouterCallOutput, LLMCallError>): void {
    this.queue.push({ result, delayMs: 0 });
  }

  /**
   * Queue an outcome that only resolves after `delayMs` of real
   * wall-clock time. Used by the deadline specs to force the
   * `AbortSignal.timeout` to fire DURING the router call.
   */
  enqueueDelayed(
    result: Result<RouterCallOutput, LLMCallError>,
    delayMs: number,
  ): void {
    this.queue.push({ result, delayMs });
  }

  async route(
    input: RouteInput,
  ): Promise<Result<RouterCallOutput, LLMCallError>> {
    this.callLog.push(input);
    this.onRoute?.(input);
    const next = this.queue.shift() ?? {
      result: this.fallbackResult,
      delayMs: 0,
    };
    if (next.delayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, next.delayMs).unref();
      });
    }
    return next.result;
  }

  // ─── Ping support (iter 9 c4, §18.5) ────────────────────────────────

  /** Captured arg from every `.ping()` call (invocation order). */
  readonly pingLog: RoutePingInput[] = [];

  /** Queue of ping outcomes; shifts on every call. */
  private readonly pingQueue: Result<PingOutput, LLMCallError>[] = [];

  /** Used when the ping queue is empty. */
  pingFallback: Result<PingOutput, LLMCallError> = err({
    kind: 'internal',
    correlationId: 'fake-router: no queued ping result',
  });

  enqueuePing(result: Result<PingOutput, LLMCallError>): void {
    this.pingQueue.push(result);
  }

  async ping(
    input: RoutePingInput,
  ): Promise<Result<PingOutput, LLMCallError>> {
    this.pingLog.push(input);
    return this.pingQueue.shift() ?? this.pingFallback;
  }
}

// ─── FakeEnvelopeCrypto ───────────────────────────────────────────────

/**
 * Placeholder for {@link EnvelopeCrypto}. The facade does NOT call
 * `wrap` / `unwrap` in iter 8 c3 — those live inside the router's
 * resolver path — so this fake only exists to satisfy the dep slot.
 *
 * Calling any method is a test-authoring mistake and throws with a
 * message pointing at the c3 scope.
 */
export class FakeEnvelopeCrypto {
  async wrap(): Promise<never> {
    throw new Error(
      'FakeEnvelopeCrypto.wrap called — facade must not touch crypto in iter 8 c3',
    );
  }
  async unwrap(): Promise<never> {
    throw new Error(
      'FakeEnvelopeCrypto.unwrap called — facade must not touch crypto in iter 8 c3',
    );
  }
  /**
   * Tracks every call so iter 9 c4 specs can assert the facade wiring.
   * Iter 8 c3 used to throw here (the facade didn't call it yet); iter
   * 9 c4 enabled `LLMClient.invalidateUserKey()` so the fake must now
   * match the real envelope's shape: `(userId: string): number`. Tests
   * that need to drive a specific return value spy on this method
   * directly via `vi.spyOn(envelope, 'invalidateUserKey')`.
   */
  readonly invalidateUserKeyCalls: string[] = [];
  invalidateUserKey(userId: string): number {
    this.invalidateUserKeyCalls.push(userId);
    return 0;
  }
}

/**
 * Typed export so specs can write `const envelope: EnvelopeCrypto =
 * new FakeEnvelopeCrypto() as unknown as EnvelopeCrypto`. The cast
 * through `unknown` avoids importing the concrete class at test time
 * (it pulls AWS SDK types we don't need).
 */
export function asEnvelopeCrypto(f: FakeEnvelopeCrypto): EnvelopeCrypto {
  return f as unknown as EnvelopeCrypto;
}

// ─── FakeUsageBuffer ──────────────────────────────────────────────────

/**
 * Structural stand-in for {@link UsageBuffer}. The facade only reads
 * `.size()` + `.capacity` — `push`/`drain` are not part of its
 * surface. The fake exposes `setSize(n)` so tests drive the number
 * the facade reads without spinning a real buffer.
 */
export class FakeUsageBuffer {
  private _size = 0;
  constructor(public readonly capacity = 1000) {}

  size(): number {
    return this._size;
  }

  setSize(n: number): void {
    this._size = n;
  }

  // The real UsageBuffer exposes push/drain/isFull; the facade never
  // calls them. These stubs satisfy the structural contract so
  // `as unknown as UsageBuffer` is not required in consumer code.
  push(): boolean {
    return false;
  }
  drain(): unknown[] {
    return [];
  }
  isFull(): boolean {
    return this._size >= this.capacity;
  }
}

/** Cast helper: `FakeUsageBuffer` satisfies the minimal surface. */
export function asUsageBuffer(f: FakeUsageBuffer): UsageBuffer {
  return f as unknown as UsageBuffer;
}

// ─── FakeIdempotencyStore ─────────────────────────────────────────────

/**
 * Map-backed {@link IdempotencyStore}. Tracks call counts + last args
 * so specs verify "HIT path did not call set", "close called clear",
 * etc., without inspecting an opaque black box.
 */
export class FakeIdempotencyStore implements IdempotencyStore {
  readonly entries = new Map<string, LLMCallOutput>();

  getCalls = 0;
  setCalls = 0;
  clearCalls = 0;

  lastGetKey: string | undefined;
  lastSetArgs: {
    key: string;
    value: LLMCallOutput;
    ttlMs: number;
  } | undefined;

  /**
   * If set, the next `.get(key)` returns this value instead of the
   * Map's contents. Lets specs simulate a HIT without having to
   * pre-populate the Map via `.set()` (which would also bump
   * `setCalls`).
   */
  private nextGetOverride: LLMCallOutput | undefined;

  /** Force the NEXT `get()` to return `value`. */
  seedHit(value: LLMCallOutput): void {
    this.nextGetOverride = value;
  }

  async get(key: string): Promise<LLMCallOutput | undefined> {
    this.getCalls += 1;
    this.lastGetKey = key;
    if (this.nextGetOverride !== undefined) {
      const v = this.nextGetOverride;
      this.nextGetOverride = undefined;
      return v;
    }
    return this.entries.get(key);
  }

  async set(key: string, value: LLMCallOutput, ttlMs: number): Promise<void> {
    this.setCalls += 1;
    this.lastSetArgs = { key, value, ttlMs };
    this.entries.set(key, value);
  }

  async clear(): Promise<void> {
    this.clearCalls += 1;
    this.entries.clear();
  }
}

// ─── FakeFlushScheduler ───────────────────────────────────────────────

/**
 * Minimal {@link FlushScheduler} double. Tracks every entry-point
 * invocation and exposes a controllable `stop()` promise so specs
 * verifying `close()` serialisation (stop blocks on a gate) can
 * drive the shutdown ordering deterministically.
 */
export class FakeFlushScheduler {
  startCalls = 0;
  stopCalls = 0;
  /** Arg history for every `notifyBufferChanged(size)` call. */
  readonly notifyBufferChangedCalls: number[] = [];
  /** Arg history for every `flushNow(trigger)` call. */
  readonly flushNowCalls: FlushTrigger[] = [];

  /**
   * When set, `stop()` awaits this promise before resolving. Used in
   * the close-serialisation spec ("flushScheduler.stop is awaited
   * before idempotencyStore.clear").
   */
  private stopGate: Promise<void> | undefined;
  private releaseStopGate: (() => void) | undefined;

  gateStop(): void {
    this.stopGate = new Promise<void>((resolve) => {
      this.releaseStopGate = resolve;
    });
  }

  releaseStop(): void {
    this.releaseStopGate?.();
    this.releaseStopGate = undefined;
    this.stopGate = undefined;
  }

  start(): void {
    this.startCalls += 1;
  }

  notifyBufferChanged(size: number): void {
    this.notifyBufferChangedCalls.push(size);
  }

  async flushNow(trigger: FlushTrigger): Promise<void> {
    this.flushNowCalls.push(trigger);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
    if (this.stopGate !== undefined) {
      await this.stopGate;
    }
  }
}

/** Cast helper: expose the fake as the nominal `FlushScheduler` type. */
export function asFlushScheduler(f: FakeFlushScheduler): FlushScheduler {
  return f as unknown as FlushScheduler;
}

// ─── FakeUserQuotaRepo ────────────────────────────────────────────────

/**
 * In-memory {@link UserQuotaRepo} seeded by default with
 * `DEFAULT_USER`. Specs override via `seedQuota(user)` for multi-tenant
 * scenarios, or `seedError({ kind })` for failure-path specs.
 *
 * Mirrors the shape the prod adapter will ship from `apps/web/` once
 * §18.1 is materialised server-side: one row per `userId`, typed return
 * via `Result<UserQuota, UserQuotaRepoError>`, NEVER throws.
 */
export class FakeUserQuotaRepo implements UserQuotaRepo {
  /** Call-count for assertions ("was the repo consulted once and only once"). */
  getCalls = 0;
  /** Last `userId` that landed on `.get()`. */
  lastGetUserId: string | undefined;

  private readonly store = new Map<string, UserQuota>();
  private nextError: UserQuotaRepoError | undefined;

  /** Seed a quota row. Called by default in `makeDeps` with DEFAULT_USER. */
  seedQuota(user: UserQuota): void {
    this.store.set(user.userId, user);
  }

  /**
   * Force the NEXT `get()` call to fail with the given error. After
   * firing once the error is cleared; subsequent calls fall back to
   * the `store` lookup.
   */
  seedError(e: UserQuotaRepoError): void {
    this.nextError = e;
  }

  async get(userId: string): Promise<Result<UserQuota, UserQuotaRepoError>> {
    this.getCalls += 1;
    this.lastGetUserId = userId;
    if (this.nextError !== undefined) {
      const e = this.nextError;
      this.nextError = undefined;
      return err(e);
    }
    const hit = this.store.get(userId);
    if (hit === undefined) {
      return err({ kind: 'not_found', userId });
    }
    return ok(hit);
  }
}

// ─── Input builders ───────────────────────────────────────────────────

/**
 * Default valid `UserQuota` for the Influencer plan (so BYOK preference
 * is plausible but `llmPreferMyKey=false` keeps the router on the
 * Managed path — doesn't matter structurally since the router is
 * faked, but keeps the defaults sensible if the fake ever needs to
 * inspect them).
 *
 * Callers pass `DEFAULT_USER.userId` to `makeCallInput` (the facade's
 * `LLMCallInput` now carries just `userId`, not the full quota —
 * iter 9 c3, §18.1). The full row lives in `FakeUserQuotaRepo` seeded
 * by `makeDeps`.
 */
export const DEFAULT_USER: UserQuota = {
  userId: 'user_test_123',
  plan: 'influencer',
  llmKeyProvider: 'anthropic',
  llmKeyStatus: 'active',
  llmPreferMyKey: false,
};

/**
 * Default valid `NormalizedLLMRequest` — a single-turn user message
 * targeting Anthropic's Sonnet. Used by every happy-path spec. Override
 * fields via `{ ...DEFAULT_REQUEST, model: '...' }` or pass an override
 * to {@link makeCallInput}.
 */
export const DEFAULT_REQUEST: NormalizedLLMRequest = {
  model: 'claude-sonnet-4-6',
  messages: [{ role: 'user', content: 'ping' }],
  maxTokens: 64,
};

/**
 * Canonical traceparent used across specs — matches W3C format
 * `version-traceId-spanId-flags`. The traceId is the 32-char middle
 * segment; the facade derives `correlationId` from it.
 */
export const DEFAULT_TRACEPARENT =
  '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

/** Extracted traceId — the expected `correlationId` for default inputs. */
export const DEFAULT_CORRELATION_ID = '4bf92f3577b34da6a3ce929d0e0e4736';

/**
 * Build a valid {@link LLMCallInput} with sensible defaults. Override
 * any field via the `overrides` param; omitted fields fall back to
 * {@link DEFAULT_USER} / {@link DEFAULT_REQUEST} / etc.
 */
export function makeCallInput(
  overrides: Partial<LLMCallInput> = {},
): LLMCallInput {
  return {
    userId: overrides.userId ?? DEFAULT_USER.userId,
    exposureScope: overrides.exposureScope ?? 'internal',
    origin: overrides.origin ?? 'assistant-conversation',
    request: overrides.request ?? DEFAULT_REQUEST,
    traceparent: overrides.traceparent ?? DEFAULT_TRACEPARENT,
    ...(overrides.providerHint !== undefined
      ? { providerHint: overrides.providerHint }
      : {}),
    ...(overrides.correlationId !== undefined
      ? { correlationId: overrides.correlationId }
      : {}),
    ...(overrides.idempotencyKey !== undefined
      ? { idempotencyKey: overrides.idempotencyKey }
      : {}),
  };
}

/**
 * Build a valid {@link RouterCallOutput} success result. `fundingMode`
 * defaults to `'managed'` because the facade specs never need to
 * exercise the BYOK branch (that is router territory).
 */
export function makeRouterCallOutput(
  overrides: Partial<RouterCallOutput> = {},
): RouterCallOutput {
  return {
    modelUsed: overrides.modelUsed ?? 'claude-sonnet-4-6',
    providerUsed: overrides.providerUsed ?? 'anthropic',
    fundingMode: overrides.fundingMode ?? 'managed',
    message: overrides.message ?? {
      role: 'assistant',
      content: 'pong',
    },
    usage: overrides.usage ?? {
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    },
    stopReason: overrides.stopReason ?? 'end_turn',
    ...(overrides.providerRequestId !== undefined
      ? { providerRequestId: overrides.providerRequestId }
      : {}),
  };
}

/** Convenience: `ok(makeRouterCallOutput(...))`. */
export function okRouterOutput(
  overrides: Partial<RouterCallOutput> = {},
): Result<RouterCallOutput, LLMCallError> {
  return ok(makeRouterCallOutput(overrides));
}
