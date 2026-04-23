/**
 * Tests for {@link LLMClient} — the iter 8 commit 3 facade.
 *
 * Scope: the 20+ scenarios enumerated in
 * `.cmsgs/iter8-commit3-prompt.md` lines 311–351, plus a handful of
 * coverage-filler specs for the helper surface (`deriveCorrelationId`,
 * `raceDrain` edge cases, constructor-time `start()`).
 *
 * Span assertions use the same `BasicTracerProvider` +
 * `InMemorySpanExporter` harness as `test/observability/tracing.test.ts`
 * + `test/routing/plan-router.test.ts` so the facade's root span is
 * observed end-to-end (including the router's iter-8 forward-compat
 * path that reuses the active span).
 *
 * What the specs do NOT assert:
 *
 *  - Token accounting (router's job — facade never touches `UsageRecorder`).
 *  - Envelope decrypt (router's job — facade never touches `EnvelopeCrypto`).
 *  - Sub-span shape (`llm.kms.decrypt_dek`, `llm.provider.request`,
 *    `llm.accounting.write`). Those land under the router's test file;
 *    duplicating here would couple the suites.
 *  - Internal flush-scheduler serialisation. Covered in
 *    `test/scheduler/flush-scheduler.test.ts`; facade only asserts
 *    that it calls `start` / `stop` / `notifyBufferChanged` with the
 *    right args.
 */

import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';


import {
  asEnvelopeCrypto,
  asFlushScheduler,
  asUsageBuffer,
  DEFAULT_CORRELATION_ID,
  DEFAULT_REQUEST,
  DEFAULT_TRACEPARENT,
  DEFAULT_USER,
  FakeClock,
  FakeEnvelopeCrypto,
  FakeFlushScheduler,
  FakeIdempotencyStore,
  FakeLogger,
  FakePlanRouter,
  FakeUsageBuffer,
  FakeUserQuotaRepo,
  makeCallInput,
  makeRouterCallOutput,
  okRouterOutput,
} from './_fakes.js';
import { hashNormalizedRequest } from '../../src/accounting/prompt-hash.js';
import {
  CLIENT_SPAN_NAME,
  CLOSE_DRAINED_COUNTER,
  DEFAULT_DRAIN_TIMEOUT_MS,
  DEFAULT_IDEMPOTENCY_TTL_MS,
  INFLIGHT_GAUGE,
  KEY_INVALIDATIONS_COUNTER,
  LLMClient,
  PING_SPAN_NAME,
  QUOTA_RESOLVE_SPAN_NAME,
  deriveCorrelationId,
  type LLMClientDeps,
  type LLMCallInput,
} from '../../src/client.js';
import { make } from '../../src/errors/taxonomy.js';
import { buildIdempotencyKey } from '../../src/idempotency/key.js';
import {
  IDEMPOTENCY_HITS_COUNTER,
  IDEMPOTENCY_MISSES_COUNTER,
} from '../../src/idempotency/store.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';
import {
  hashIdempotencyKey,
  hashUserId,
  resetTracer,
  setTracer,
} from '../../src/observability/tracing.js';
import { err, ok } from '../../src/types.js';

// ─── OTel test harness ────────────────────────────────────────────────

let exporter: InMemorySpanExporter;
let tracerProvider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });
  // The iter-6 `setTracer` seam is how the router resolves the tracer
  // when looking up the active span — pinning both ends to the same
  // provider ensures the router's `trace.getActiveSpan()` sees the
  // facade-opened span.
  setTracer(tracerProvider.getTracer('client-test'));
});

afterEach(async () => {
  resetTracer();
  exporter.reset();
  await tracerProvider.shutdown();
  vi.useRealTimers();
});

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Assemble a full `LLMClientDeps` with fresh fakes. Individual specs
 * override the fields they care about. Returns the deps plus each fake
 * in its concrete type so the test can reach in and assert.
 */
function makeDeps(overrides: {
  config?: LLMClientDeps['config'];
} = {}) {
  const router = new FakePlanRouter();
  const envelope = new FakeEnvelopeCrypto();
  const usageBuffer = new FakeUsageBuffer(1000);
  const idempotencyStore = new FakeIdempotencyStore();
  const flushScheduler = new FakeFlushScheduler();
  const metrics = new InMemoryMetrics();
  const logger = new FakeLogger();
  const clock = new FakeClock();
  const userQuotaRepo = new FakeUserQuotaRepo();
  // Seed the default tenant so happy-path specs don't have to opt in.
  // Failure specs can overwrite with `seedError(...)`.
  userQuotaRepo.seedQuota(DEFAULT_USER);

  const deps: LLMClientDeps = {
    router,
    envelope: asEnvelopeCrypto(envelope),
    usageBuffer: asUsageBuffer(usageBuffer),
    idempotencyStore,
    flushScheduler: asFlushScheduler(flushScheduler),
    metrics,
    tracer: tracerProvider.getTracer('client-test'),
    logger,
    clock: clock.now,
    userQuotaRepo,
    ...(overrides.config !== undefined ? { config: overrides.config } : {}),
  };
  return {
    deps,
    router,
    envelope,
    usageBuffer,
    idempotencyStore,
    flushScheduler,
    metrics,
    logger,
    clock,
    userQuotaRepo,
  };
}

/** Expected default idempotencyKey for `DEFAULT_USER` + `DEFAULT_REQUEST`. */
function expectedDefaultIdempotencyKey(): string {
  return buildIdempotencyKey(
    DEFAULT_USER.userId,
    hashNormalizedRequest(DEFAULT_REQUEST),
    DEFAULT_REQUEST.model,
  );
}

// ─── Specs ────────────────────────────────────────────────────────────

describe('LLMClient — construction', () => {
  it('starts the flush scheduler at construction', () => {
    const { deps, flushScheduler } = makeDeps();
    new LLMClient(deps);
    expect(flushScheduler.startCalls).toBe(1);
  });
});

describe('LLMClient.call — happy path', () => {
  it('returns ok with fromIdempotencyCache:false, calls router once, caches output, notifies scheduler', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    const result = await client.call(makeCallInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fromIdempotencyCache).toBe(false);
      expect(result.value.providerUsed).toBe('anthropic');
      expect(result.value.fundingMode).toBe('managed');
      // latencyMs is set by the facade (facade measures via clock()).
      expect(typeof result.value.latencyMs).toBe('number');
    }
    expect(fakes.router.callLog).toHaveLength(1);
    expect(fakes.idempotencyStore.setCalls).toBe(1);
    expect(fakes.idempotencyStore.lastSetArgs?.ttlMs).toBe(
      DEFAULT_IDEMPOTENCY_TTL_MS,
    );
    expect(fakes.flushScheduler.notifyBufferChangedCalls).toEqual([0]);
  });

  it('opens exactly one llm.client.call span per call (router reuses the active span)', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    await client.call(makeCallInput());

    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === CLIENT_SPAN_NAME);
    expect(spans).toHaveLength(1);
  });
});

describe('LLMClient.call — idempotency', () => {
  it('HIT: second identical call short-circuits, no router invocation, counter+1', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    const first = await client.call(makeCallInput());
    expect(first.ok).toBe(true);
    const firstCallCount = fakes.router.callLog.length;

    const second = await client.call(makeCallInput());
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.value.fromIdempotencyCache).toBe(true);
    }
    // Second call DID NOT touch the router.
    expect(fakes.router.callLog.length).toBe(firstCallCount);
    expect(
      fakes.metrics.readCounter(IDEMPOTENCY_HITS_COUNTER, {
        reason: 'same_request',
      }),
    ).toBe(1);
  });

  it('MISS emits the misses counter before invoking the router', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    await client.call(makeCallInput());

    expect(fakes.metrics.readCounter(IDEMPOTENCY_MISSES_COUNTER)).toBe(1);
    expect(
      fakes.metrics.readCounter(IDEMPOTENCY_HITS_COUNTER, {
        reason: 'same_request',
      }),
    ).toBe(0);
  });

  it('billable router error (rate_limit) does NOT cache', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(err(make.rateLimit('anthropic', 30)));
    const client = new LLMClient(fakes.deps);

    const result = await client.call(makeCallInput());

    expect(result.ok).toBe(false);
    expect(fakes.idempotencyStore.setCalls).toBe(0);
    expect(fakes.flushScheduler.notifyBufferChangedCalls).toEqual([]);
  });

  it('pre-call router error (invalid_key) does NOT cache', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(err(make.invalidKey('anthropic')));
    const client = new LLMClient(fakes.deps);

    const result = await client.call(makeCallInput());

    expect(result.ok).toBe(false);
    expect(fakes.idempotencyStore.setCalls).toBe(0);
  });

  it('uses buildIdempotencyKey(userId, promptHash, model) — deterministic under identical input', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    await client.call(makeCallInput());

    expect(fakes.idempotencyStore.lastSetArgs?.key).toBe(
      expectedDefaultIdempotencyKey(),
    );
  });

  it('accepts caller-provided idempotencyKey scoped to userId (§18.2)', async () => {
    // §18.2: when `input.idempotencyKey` is non-empty, the facade
    // composes it with `userId` before hashing. Two tenants passing
    // the same caller-visible key must produce DIFFERENT cache keys
    // (no cross-tenant collision), and the empty-string case MUST
    // fall back to the derived 3-tuple so iter-8 cache entries stay
    // reachable.
    const callerKey = 'cron-daily-summary-2026-04-22';

    // Case 1: non-empty override → digest differs from the derived key.
    const fakes1 = makeDeps();
    fakes1.router.enqueue(okRouterOutput());
    const client1 = new LLMClient(fakes1.deps);
    await client1.call({
      ...makeCallInput(),
      idempotencyKey: callerKey,
    });
    const overriddenKey = fakes1.idempotencyStore.lastSetArgs?.key;
    expect(overriddenKey).toBeDefined();
    expect(overriddenKey).not.toBe(expectedDefaultIdempotencyKey());
    expect(overriddenKey).toBe(
      buildIdempotencyKey(
        DEFAULT_USER.userId,
        hashNormalizedRequest(DEFAULT_REQUEST),
        DEFAULT_REQUEST.model,
        callerKey,
      ),
    );

    // Case 2: same caller-visible key across tenants → different cache keys.
    const fakes2 = makeDeps();
    fakes2.userQuotaRepo.seedQuota({ ...DEFAULT_USER, userId: 'tenant-B' });
    fakes2.router.enqueue(okRouterOutput());
    const client2 = new LLMClient(fakes2.deps);
    await client2.call({
      ...makeCallInput(),
      userId: 'tenant-B',
      idempotencyKey: callerKey,
    });
    expect(fakes2.idempotencyStore.lastSetArgs?.key).not.toBe(overriddenKey);

    // Case 3: empty-string override → falls back to derived key.
    const fakes3 = makeDeps();
    fakes3.router.enqueue(okRouterOutput());
    const client3 = new LLMClient(fakes3.deps);
    await client3.call({
      ...makeCallInput(),
      idempotencyKey: '',
    });
    expect(fakes3.idempotencyStore.lastSetArgs?.key).toBe(
      expectedDefaultIdempotencyKey(),
    );
  });
});

describe('LLMClient.call — zod parse', () => {
  it('rejects malformed input with internal(client.call: invalid_input), stamps span, no router call', async () => {
    const fakes = makeDeps();
    const client = new LLMClient(fakes.deps);

    // Break the model enum so the parse fails.
    const bad = {
      ...makeCallInput(),
      request: { ...DEFAULT_REQUEST, model: 'not-a-real-model' },
    } as unknown as LLMCallInput;

    const result = await client.call(bad);

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'internal') {
      expect(result.error.correlationId).toBe('client.call: invalid_input');
    } else {
      throw new Error('expected internal error');
    }
    expect(fakes.router.callLog).toHaveLength(0);
    expect(fakes.idempotencyStore.setCalls).toBe(0);
    expect(fakes.flushScheduler.notifyBufferChangedCalls).toEqual([]);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === CLIENT_SPAN_NAME);
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe('invalid_input');
    expect(span!.attributes['llm.internal_reason']).toBe('invalid_input');
  });
});

describe('LLMClient.call — quota resolve (§18.1 / iter 9 c3)', () => {
  it('happy path: consults userQuotaRepo once, opens the quota sub-span, propagates the resolved UserQuota to the router', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    const result = await client.call(makeCallInput());

    expect(result.ok).toBe(true);
    expect(fakes.userQuotaRepo.getCalls).toBe(1);
    expect(fakes.userQuotaRepo.lastGetUserId).toBe(DEFAULT_USER.userId);

    // The resolved UserQuota object (not a stand-in) landed on the
    // router's RouteInput.
    expect(fakes.router.callLog[0]!.user).toEqual(DEFAULT_USER);

    // The sub-span `llm.quota.resolve` opens and closes ok, nested
    // inside `llm.client.call` via the active-span seam.
    const quotaSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === QUOTA_RESOLVE_SPAN_NAME);
    expect(quotaSpan).toBeDefined();
    expect(quotaSpan!.status.code).toBe(SpanStatusCode.OK);
    expect(quotaSpan!.attributes['user.id_hash']).toBe(
      hashUserId(DEFAULT_USER.userId),
    );
  });

  it('repo not_found → internal(client.call: quota_not_found), stamps ERROR status on both spans, no router call', async () => {
    const fakes = makeDeps();
    fakes.userQuotaRepo.seedError({
      kind: 'not_found',
      userId: DEFAULT_USER.userId,
    });
    const client = new LLMClient(fakes.deps);

    const result = await client.call(makeCallInput());

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'internal') {
      expect(result.error.correlationId).toBe('client.call: quota_not_found');
    } else {
      throw new Error('expected internal error');
    }
    expect(fakes.router.callLog).toHaveLength(0);
    expect(fakes.idempotencyStore.setCalls).toBe(0);

    const rootSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === CLIENT_SPAN_NAME);
    expect(rootSpan).toBeDefined();
    expect(rootSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan!.status.message).toBe('quota_not_found');
    expect(rootSpan!.attributes['llm.internal_reason']).toBe(
      'quota_not_found',
    );

    const quotaSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === QUOTA_RESOLVE_SPAN_NAME);
    expect(quotaSpan).toBeDefined();
    expect(quotaSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(quotaSpan!.status.message).toBe('quota_not_found');
  });

  it('repo transport → internal(client.call: quota_transport), logs reason, no router call', async () => {
    const fakes = makeDeps();
    fakes.userQuotaRepo.seedError({
      kind: 'transport',
      reason: 'connection_refused',
    });
    const client = new LLMClient(fakes.deps);

    const result = await client.call(makeCallInput());

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'internal') {
      expect(result.error.correlationId).toBe('client.call: quota_transport');
    } else {
      throw new Error('expected internal error');
    }
    expect(fakes.router.callLog).toHaveLength(0);

    // The adapter-provided reason lands in the structured log — the
    // contract promises "not echoed to callers", but observability is
    // allowed to see it.
    const warnCall = fakes.logger.warnings.find(
      (l) => l.msg === 'llm-client: quota repo transport error',
    );
    expect(warnCall).toBeDefined();
    expect(warnCall!.meta).toMatchObject({ reason: 'connection_refused' });
    // The raw userId MUST NOT appear in the log meta — only the hash.
    expect((warnCall!.meta as Record<string, unknown>).userId).toBe(
      hashUserId(DEFAULT_USER.userId),
    );

    const rootSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === CLIENT_SPAN_NAME);
    expect(rootSpan).toBeDefined();
    expect(rootSpan!.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan!.status.message).toBe('quota_transport');
  });
});

describe('LLMClient.call — deadline', () => {
  it('deadlineMs=0 short-circuits pre-router with networkError(transient:false)', async () => {
    const fakes = makeDeps();
    // Queue a result the router would have returned if it had been
    // called — we assert it WAS NOT consumed.
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    const result = await client.call(makeCallInput(), { deadlineMs: 0 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network_error');
      if (result.error.kind === 'network_error') {
        expect(result.error.transient).toBe(false);
      }
    }
    expect(fakes.router.callLog).toHaveLength(0);
    expect(fakes.idempotencyStore.setCalls).toBe(0);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === CLIENT_SPAN_NAME);
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe('deadline_exceeded');
  });

  it('defaultDeadlineMs applies when options.deadlineMs is undefined', async () => {
    const fakes = makeDeps({ config: { defaultDeadlineMs: 0 } });
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    const result = await client.call(makeCallInput());

    expect(result.ok).toBe(false);
    expect(fakes.router.callLog).toHaveLength(0);
  });

  it('router receives the composed AbortSignal so it can abort mid-flight', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    const externalAc = new AbortController();
    await client.call(makeCallInput(), {
      signal: externalAc.signal,
      deadlineMs: 5_000,
    });

    expect(fakes.router.callLog).toHaveLength(1);
    const passedSignal = fakes.router.callLog[0]!.abortSignal;
    expect(passedSignal).toBeInstanceOf(AbortSignal);
    // Aborting the external signal propagates to the composed one.
    externalAc.abort();
    expect(passedSignal!.aborted).toBe(true);
  });

  it('router returning a billable error (e.g. network_error transient:true) is surfaced verbatim with no caching', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(err(make.networkError(true)));
    const client = new LLMClient(fakes.deps);

    const result = await client.call(makeCallInput(), { deadlineMs: 50 });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('network_error');
    }
    expect(fakes.idempotencyStore.setCalls).toBe(0);
  });
});

describe('LLMClient.call — inflight tracking', () => {
  it('gauge reflects size before and after the call', async () => {
    const fakes = makeDeps();
    let gaugeDuringCall: number | undefined;
    fakes.router.onRoute = () => {
      // Router is the first hook that sees a non-empty inflight set.
      gaugeDuringCall = fakes.metrics.readGauge(INFLIGHT_GAUGE);
    };
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    await client.call(makeCallInput());

    expect(gaugeDuringCall).toBe(1);
    expect(fakes.metrics.readGauge(INFLIGHT_GAUGE)).toBe(0);
  });

  it('concurrent calls push the gauge to 2 before each resolves', async () => {
    const fakes = makeDeps();
    fakes.router.enqueueDelayed(okRouterOutput(), 20);
    fakes.router.enqueueDelayed(
      okRouterOutput({
        message: { role: 'assistant', content: 'pong2' },
      }),
      20,
    );
    // Use distinct inputs so the two calls produce distinct idempotency
    // keys and the second call does not HIT the first's cache entry.
    const client = new LLMClient(fakes.deps);

    const p1 = client.call(makeCallInput());
    const p2 = client.call(
      makeCallInput({
        request: {
          ...DEFAULT_REQUEST,
          messages: [{ role: 'user', content: 'ping-2' }],
        },
      }),
    );

    // Micro-yield so both calls have entered the inflight tracker.
    await new Promise<void>((r) => setTimeout(r, 5));
    expect(fakes.metrics.readGauge(INFLIGHT_GAUGE)).toBe(2);

    await Promise.all([p1, p2]);
    expect(fakes.metrics.readGauge(INFLIGHT_GAUGE)).toBe(0);
  });
});

describe('LLMClient.close', () => {
  it('no inflight: drains immediately with result=drained, stops scheduler, clears store', async () => {
    const fakes = makeDeps();
    const client = new LLMClient(fakes.deps);

    await client.close();

    expect(
      fakes.metrics.readCounter(CLOSE_DRAINED_COUNTER, { result: 'drained' }),
    ).toBe(1);
    expect(fakes.flushScheduler.stopCalls).toBe(1);
    expect(fakes.idempotencyStore.clearCalls).toBe(1);
  });

  it('close with generous drain budget waits for inflight calls to finish', async () => {
    const fakes = makeDeps();
    fakes.router.enqueueDelayed(okRouterOutput(), 20);
    fakes.router.enqueueDelayed(
      okRouterOutput({
        message: { role: 'assistant', content: 'pong2' },
      }),
      20,
    );
    const client = new LLMClient(fakes.deps);

    const p1 = client.call(makeCallInput());
    const p2 = client.call(
      makeCallInput({
        request: {
          ...DEFAULT_REQUEST,
          messages: [{ role: 'user', content: 'ping-2' }],
        },
      }),
    );

    await client.close({ drainTimeoutMs: 500 });

    // Both calls resolved successfully — the drain waited for them.
    const r1 = await p1;
    const r2 = await p2;
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(
      fakes.metrics.readCounter(CLOSE_DRAINED_COUNTER, { result: 'drained' }),
    ).toBe(1);
    expect(
      fakes.metrics.readCounter(CLOSE_DRAINED_COUNTER, { result: 'timeout' }),
    ).toBe(0);
  });

  it('close with short drain budget records result=timeout without throwing', async () => {
    const fakes = makeDeps();
    fakes.router.enqueueDelayed(okRouterOutput(), 100);
    const client = new LLMClient(fakes.deps);

    const pending = client.call(makeCallInput());

    await client.close({ drainTimeoutMs: 5 });

    expect(
      fakes.metrics.readCounter(CLOSE_DRAINED_COUNTER, { result: 'timeout' }),
    ).toBe(1);
    // scheduler.stop + store.clear ran anyway.
    expect(fakes.flushScheduler.stopCalls).toBe(1);
    expect(fakes.idempotencyStore.clearCalls).toBe(1);

    // Draining the pending call so vitest does not flag an unhandled promise.
    await pending;
  });

  it('second close() is a no-op — no second counter increment', async () => {
    const fakes = makeDeps();
    const client = new LLMClient(fakes.deps);

    await client.close();
    await client.close();

    expect(
      fakes.metrics.readCounter(CLOSE_DRAINED_COUNTER, { result: 'drained' }),
    ).toBe(1);
    expect(fakes.flushScheduler.stopCalls).toBe(1);
    expect(fakes.idempotencyStore.clearCalls).toBe(1);
  });

  it('call() after close() returns internal(client.call: closed), no span, no inflight', async () => {
    const fakes = makeDeps();
    const client = new LLMClient(fakes.deps);
    await client.close();
    exporter.reset();

    const result = await client.call(makeCallInput());

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'internal') {
      expect(result.error.correlationId).toBe('client.call: closed');
    } else {
      throw new Error('expected internal(closed)');
    }
    // No new span was opened.
    const postCloseSpans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === CLIENT_SPAN_NAME);
    expect(postCloseSpans).toHaveLength(0);
    // Router never saw it either.
    expect(fakes.router.callLog).toHaveLength(0);
  });

  it('uses config.drainTimeoutMs when opts.drainTimeoutMs is undefined', async () => {
    const fakes = makeDeps({ config: { drainTimeoutMs: 5 } });
    fakes.router.enqueueDelayed(okRouterOutput(), 100);
    const client = new LLMClient(fakes.deps);

    const pending = client.call(makeCallInput());
    await client.close();

    expect(
      fakes.metrics.readCounter(CLOSE_DRAINED_COUNTER, { result: 'timeout' }),
    ).toBe(1);

    await pending;
  });

  it('default drain timeout is DEFAULT_DRAIN_TIMEOUT_MS when neither opts nor config sets it', async () => {
    expect(DEFAULT_DRAIN_TIMEOUT_MS).toBe(5_000);
    const fakes = makeDeps();
    const client = new LLMClient(fakes.deps);
    await client.close();
    expect(
      fakes.metrics.readCounter(CLOSE_DRAINED_COUNTER, { result: 'drained' }),
    ).toBe(1);
  });
});

describe('LLMClient — flush-scheduler wiring', () => {
  it('successful call triggers notifyBufferChanged with the current buffer size', async () => {
    const fakes = makeDeps();
    fakes.usageBuffer.setSize(42);
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    await client.call(makeCallInput());

    expect(fakes.flushScheduler.notifyBufferChangedCalls).toEqual([42]);
  });

  it('router error does NOT trigger notifyBufferChanged', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(err(make.rateLimit('anthropic')));
    const client = new LLMClient(fakes.deps);

    await client.call(makeCallInput());

    expect(fakes.flushScheduler.notifyBufferChangedCalls).toEqual([]);
  });

  it('idempotency HIT does NOT trigger notifyBufferChanged (router was not called)', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    await client.call(makeCallInput());
    // First call notified once (size=0).
    expect(fakes.flushScheduler.notifyBufferChangedCalls).toEqual([0]);
    await client.call(makeCallInput()); // HIT
    // No new notify.
    expect(fakes.flushScheduler.notifyBufferChangedCalls).toEqual([0]);
  });
});

describe('LLMClient — span attributes', () => {
  it('stamps llm.origin, user.id_hash, llm.model, trace.idempotency_key_hash on open', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    await client.call(makeCallInput());

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === CLIENT_SPAN_NAME);
    expect(span).toBeDefined();
    expect(span!.attributes['llm.origin']).toBe('assistant-conversation');
    expect(span!.attributes['user.id_hash']).toBe(hashUserId(DEFAULT_USER.userId));
    // Raw userId must never land on the span.
    expect(span!.attributes['user.id_hash']).not.toBe(DEFAULT_USER.userId);
    expect(span!.attributes['llm.model']).toBe(DEFAULT_REQUEST.model);
    expect(span!.attributes['trace.idempotency_key_hash']).toBe(
      hashIdempotencyKey(expectedDefaultIdempotencyKey()),
    );
    // The RAW idempotency key must never land on the span.
    expect(span!.attributes['trace.idempotency_key_hash']).not.toBe(
      expectedDefaultIdempotencyKey(),
    );
    expect(span!.attributes.fromIdempotencyCache).toBe(false);
  });

  it('idempotency HIT stamps fromIdempotencyCache=true + llm.latency_ms, no router subspans', async () => {
    const fakes = makeDeps();
    // Pre-seed the store so the first call's `get` returns the value.
    fakes.idempotencyStore.seedHit({
      modelUsed: 'claude-sonnet-4-6',
      providerUsed: 'anthropic',
      fundingMode: 'managed',
      message: { role: 'assistant', content: 'cached' },
      usage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 },
      stopReason: 'end_turn',
      latencyMs: 99,
    });
    const client = new LLMClient(fakes.deps);

    const result = await client.call(makeCallInput());

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.fromIdempotencyCache).toBe(true);
    }
    // Router WAS NOT called.
    expect(fakes.router.callLog).toHaveLength(0);

    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === CLIENT_SPAN_NAME);
    expect(span).toBeDefined();
    expect(span!.attributes.fromIdempotencyCache).toBe(true);
    expect(typeof span!.attributes['llm.latency_ms']).toBe('number');
    expect(span!.status.code).toBe(SpanStatusCode.OK);
  });
});

describe('LLMClient.call — providerHint propagation', () => {
  it('forwards providerHint verbatim to the router', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput({ providerUsed: 'openai' }));
    const client = new LLMClient(fakes.deps);

    await client.call(makeCallInput({ providerHint: 'openai' }));

    expect(fakes.router.callLog[0]!.providerHint).toBe('openai');
  });

  it('correlationId is the traceId portion of traceparent', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    await client.call(makeCallInput());

    expect(fakes.router.callLog[0]!.correlationId).toBe(DEFAULT_CORRELATION_ID);
  });

  // iter 9 pendiente 18.3 — typed `correlationId?` override.
  it('uses input.correlationId verbatim when provided and non-empty', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);
    const callerId = 'job-7f3a1b-replay-2';

    await client.call(makeCallInput({ correlationId: callerId }));

    // Caller-supplied id wins over the traceparent-derived one.
    expect(fakes.router.callLog[0]!.correlationId).toBe(callerId);
    expect(fakes.router.callLog[0]!.correlationId).not.toBe(
      DEFAULT_CORRELATION_ID,
    );
  });

  // iter 9 pendiente 18.3 — empty string falls back to traceparent parse.
  it('falls back to traceparent parse when input.correlationId is an empty string', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    await client.call(makeCallInput({ correlationId: '' }));

    expect(fakes.router.callLog[0]!.correlationId).toBe(DEFAULT_CORRELATION_ID);
  });

  it('origin + user flow into the router RouteInput unchanged', async () => {
    const fakes = makeDeps();
    fakes.router.enqueue(okRouterOutput());
    const client = new LLMClient(fakes.deps);

    await client.call(
      makeCallInput({ origin: 'caption-refine' }),
    );

    expect(fakes.router.callLog[0]!.origin).toBe('caption-refine');
    expect(fakes.router.callLog[0]!.user.userId).toBe(DEFAULT_USER.userId);
    expect(fakes.router.callLog[0]!.user.plan).toBe(DEFAULT_USER.plan);
  });
});

describe('LLMClient.call — defensive throw handling', () => {
  it('router throwing is translated to internal(...) and logged', async () => {
    const fakes = makeDeps();
    fakes.router.fallbackResult = ok(makeRouterCallOutput());
    fakes.router.route = async () => {
      throw new Error('fake router exploded');
    };
    const client = new LLMClient(fakes.deps);

    const result = await client.call(makeCallInput());

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'internal') {
      expect(result.error.correlationId).toMatch(/client\.call: unexpected/);
    } else {
      throw new Error('expected internal(unexpected)');
    }
    expect(
      fakes.logger.warnings.some((w) =>
        w.msg.includes('unexpected throw in call'),
      ),
    ).toBe(true);
  });
});

describe('deriveCorrelationId — helper', () => {
  it('extracts the 32-char traceId from a well-formed W3C traceparent', () => {
    expect(deriveCorrelationId(DEFAULT_TRACEPARENT)).toBe(
      DEFAULT_CORRELATION_ID,
    );
  });

  it('falls back to randomUUID on a short / malformed traceparent', () => {
    const out = deriveCorrelationId('00-short');
    expect(out).not.toBe('');
    expect(out).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('falls back to randomUUID on non-hex traceId', () => {
    const out = deriveCorrelationId('00-XXXXXXXX-00f067aa0ba902b7-01');
    expect(out).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('falls back to randomUUID on all-zero traceId (W3C invalid sentinel)', () => {
    const out = deriveCorrelationId(
      '00-00000000000000000000000000000000-0000000000000000-00',
    );
    expect(out).toMatch(/^[0-9a-f-]{36}$/);
    expect(out).not.toBe('00000000000000000000000000000000');
  });

  it('normalises uppercase traceId to lowercase', () => {
    const upper = '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01';
    expect(deriveCorrelationId(upper)).toBe(DEFAULT_CORRELATION_ID);
  });

  it('falls back to randomUUID on empty string', () => {
    const out = deriveCorrelationId('');
    expect(out).toMatch(/^[0-9a-f-]{36}$/);
  });
});


// ─── Iter 9 c4 (§18.5) — ping + invalidateUserKey ────────────────────

describe('LLMClient.ping — quota resolve + router delegation', () => {
  it('happy path: resolves quota, picks byok for active BYOK user, delegates to router.ping, stamps span OK', async () => {
    const fakes = makeDeps();
    fakes.router.enqueuePing(
      ok({
        status: 'active',
        model: 'claude-haiku-4-5',
      }),
    );
    const client = new LLMClient(fakes.deps);

    const result = await client.ping({
      userId: DEFAULT_USER.userId,
      provider: 'anthropic',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.status).toBe('active');
    }
    // Router consulted exactly once; no route() call.
    expect(fakes.router.pingLog).toHaveLength(1);
    expect(fakes.router.callLog).toHaveLength(0);
    const pingInput = fakes.router.pingLog[0]!;
    expect(pingInput.provider).toBe('anthropic');
    // DEFAULT_USER has llmKeyProvider='anthropic' + llmKeyStatus='active'
    // → facade defaults to byok.
    expect(pingInput.fundingMode).toBe('byok');
    expect(pingInput.user.userId).toBe(DEFAULT_USER.userId);

    // Span stamped with provider + funding_mode, status OK.
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === PING_SPAN_NAME);
    expect(span).toBeDefined();
    expect(span!.status.code).toBe(SpanStatusCode.OK);
    expect(span!.attributes['llm.provider']).toBe('anthropic');
    expect(span!.attributes['llm.funding_mode']).toBe('byok');
    expect(span!.attributes['user.id_hash']).toBe(
      hashUserId(DEFAULT_USER.userId),
    );
  });

  it('caller-provided fundingMode override: managed beats the byok default', async () => {
    const fakes = makeDeps();
    fakes.router.enqueuePing(ok({ status: 'active', model: 'gpt-5-mini' }));
    const client = new LLMClient(fakes.deps);

    await client.ping({
      userId: DEFAULT_USER.userId,
      provider: 'anthropic',
      fundingMode: 'managed',
    });

    expect(fakes.router.pingLog[0]!.fundingMode).toBe('managed');
  });

  it('omitted provider: falls back to quota.llmKeyProvider', async () => {
    const fakes = makeDeps();
    fakes.router.enqueuePing(ok({ status: 'active', model: 'claude-haiku-4-5' }));
    const client = new LLMClient(fakes.deps);

    await client.ping({ userId: DEFAULT_USER.userId });

    expect(fakes.router.pingLog[0]!.provider).toBe(
      DEFAULT_USER.llmKeyProvider,
    );
  });

  it('omitted provider AND quota.llmKeyProvider undefined → internal(client.ping: no_provider), no router call', async () => {
    const fakes = makeDeps();
    fakes.userQuotaRepo.seedQuota({
      userId: 'user_no_key',
      plan: 'free',
      // llmKeyProvider intentionally absent.
    });
    const client = new LLMClient(fakes.deps);

    const result = await client.ping({ userId: 'user_no_key' });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'internal') {
      expect(result.error.correlationId).toBe('client.ping: no_provider');
    } else {
      throw new Error('expected internal(no_provider)');
    }
    expect(fakes.router.pingLog).toHaveLength(0);
  });

  it('quota not_found: internal(quota_not_found), no router call', async () => {
    const fakes = makeDeps();
    fakes.userQuotaRepo.seedError({ kind: 'not_found', userId: 'ghost' });
    const client = new LLMClient(fakes.deps);

    const result = await client.ping({
      userId: 'ghost',
      provider: 'anthropic',
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'internal') {
      expect(result.error.correlationId).toBe('client.call: quota_not_found');
    } else {
      throw new Error('expected internal(quota_not_found)');
    }
    expect(fakes.router.pingLog).toHaveLength(0);
  });

  it('router returns invalid_key: surfaced verbatim, span ERROR with error.kind as message', async () => {
    const fakes = makeDeps();
    fakes.router.enqueuePing(err(make.invalidKey('anthropic')));
    const client = new LLMClient(fakes.deps);

    const result = await client.ping({
      userId: DEFAULT_USER.userId,
      provider: 'anthropic',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('invalid_key');
    }
    const span = exporter
      .getFinishedSpans()
      .find((s) => s.name === PING_SPAN_NAME);
    expect(span!.status.code).toBe(SpanStatusCode.ERROR);
    expect(span!.status.message).toBe('invalid_key');
  });

  it('after close(): returns internal(client.call: closed), no span, no router call', async () => {
    const fakes = makeDeps();
    const client = new LLMClient(fakes.deps);
    await client.close();
    exporter.reset();

    const result = await client.ping({
      userId: DEFAULT_USER.userId,
      provider: 'anthropic',
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'internal') {
      expect(result.error.correlationId).toBe('client.call: closed');
    }
    expect(
      exporter.getFinishedSpans().filter((s) => s.name === PING_SPAN_NAME),
    ).toHaveLength(0);
    expect(fakes.router.pingLog).toHaveLength(0);
  });

  it('uses input.correlationId verbatim when provided and non-empty', async () => {
    const fakes = makeDeps();
    fakes.router.enqueuePing(ok({ status: 'active', model: 'claude-haiku-4-5' }));
    const client = new LLMClient(fakes.deps);

    await client.ping({
      userId: DEFAULT_USER.userId,
      provider: 'anthropic',
      correlationId: 'my-stable-corr-id',
    });

    expect(fakes.router.pingLog[0]!.correlationId).toBe('my-stable-corr-id');
  });

  it('quota transport error: internal(quota_transport), logs reason, no router call', async () => {
    const fakes = makeDeps();
    fakes.userQuotaRepo.seedError({
      kind: 'transport',
      reason: 'db_timeout',
    });
    const client = new LLMClient(fakes.deps);

    const result = await client.ping({
      userId: DEFAULT_USER.userId,
      provider: 'anthropic',
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'internal') {
      expect(result.error.correlationId).toBe('client.call: quota_transport');
    } else {
      throw new Error('expected internal(quota_transport)');
    }
    expect(fakes.router.pingLog).toHaveLength(0);
    expect(
      fakes.logger.warnings.some(
        (w) => w.msg === 'llm-client: quota repo transport error',
      ),
    ).toBe(true);
  });

  it('router throwing is translated to internal(client.ping: unexpected ...) and logged', async () => {
    const fakes = makeDeps();
    fakes.router.ping = async () => {
      throw new Error('fake router ping exploded');
    };
    const client = new LLMClient(fakes.deps);

    const result = await client.ping({
      userId: DEFAULT_USER.userId,
      provider: 'anthropic',
    });

    expect(result.ok).toBe(false);
    if (!result.ok && result.error.kind === 'internal') {
      expect(result.error.correlationId).toContain('client.ping: unexpected');
      expect(result.error.correlationId).toContain('fake router ping exploded');
    } else {
      throw new Error('expected internal(unexpected)');
    }
    expect(
      fakes.logger.warnings.some((w) =>
        w.msg.includes('unexpected throw in ping'),
      ),
    ).toBe(true);
  });
});

describe('LLMClient.invalidateUserKey — cache purge + metric', () => {
  it('calls EnvelopeCrypto.invalidateUserKey(userId) and emits counter', async () => {
    const fakes = makeDeps();
    const client = new LLMClient(fakes.deps);

    await client.invalidateUserKey(DEFAULT_USER.userId);

    expect(fakes.envelope.invalidateUserKeyCalls).toEqual([
      DEFAULT_USER.userId,
    ]);
    expect(
      fakes.metrics.readCounter(KEY_INVALIDATIONS_COUNTER, {
        origin: 'explicit',
      }),
    ).toBe(1);
  });

  it('empty userId: warns, does not touch envelope, does not emit counter', async () => {
    const fakes = makeDeps();
    const client = new LLMClient(fakes.deps);

    await client.invalidateUserKey('');

    expect(fakes.envelope.invalidateUserKeyCalls).toEqual([]);
    expect(
      fakes.metrics.readCounter(KEY_INVALIDATIONS_COUNTER, {
        origin: 'explicit',
      }),
    ).toBe(0);
    expect(
      fakes.logger.warnings.some((w) =>
        w.msg.includes('invalidateUserKey called with empty userId'),
      ),
    ).toBe(true);
  });

  it('two calls with the same userId emit two counter rows (not idempotent on the counter)', async () => {
    const fakes = makeDeps();
    const client = new LLMClient(fakes.deps);

    await client.invalidateUserKey(DEFAULT_USER.userId);
    await client.invalidateUserKey(DEFAULT_USER.userId);

    expect(fakes.envelope.invalidateUserKeyCalls).toEqual([
      DEFAULT_USER.userId,
      DEFAULT_USER.userId,
    ]);
    expect(
      fakes.metrics.readCounter(KEY_INVALIDATIONS_COUNTER, {
        origin: 'explicit',
      }),
    ).toBe(2);
  });
});
