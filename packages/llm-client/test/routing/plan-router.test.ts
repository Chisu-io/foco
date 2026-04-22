/**
 * Tests for the plan-aware router (§4.1) — Iteration 4.
 *
 * Covers the full decision matrix of LLM_CLIENT.md §4:
 *
 *  - Free / Creator (BYOK mandatory, no Managed fallback):
 *    · missing key → `plan_requires_key`
 *    · provider mismatch → `plan_requires_key`
 *    · stored status ∉ {active, pending} → `plan_requires_key`
 *    · resolver failure → surfaced
 *    · successful call → stamps `fundingMode: 'byok'`
 *    · provider returns `invalid_key` → replaced with `plan_requires_key`
 *      AND `onByokKeyInvalidated` fires
 *
 *  - Influencer / Celebrity (Managed primary, optional BYOK fallback):
 *    · `preferMyKey=false` → Managed direct
 *    · `preferMyKey=true` + success → BYOK used, `fundingMode: 'byok'`
 *    · `preferMyKey=true` + `invalid_key` → Managed fallback
 *      (Jean's explicit test case — ajuste 6) + callback fired
 *    · `preferMyKey=true` + `quota_exhausted` → Managed fallback, no callback
 *    · `preferMyKey=true` + `rate_limit` → Managed fallback, no callback
 *      (per-key bucket; Ajuste 6 FULL review 2026-04-19)
 *    · `preferMyKey=true` + `network_error` → Managed fallback, no callback
 *      (recoverable per-call transient)
 *    · `preferMyKey=true` + `provider_down` → surfaced (CB of §4.2
 *      already covers provider-wide outages upstream)
 *    · `preferMyKey=true` + resolver fails → surfaced (KMS likely infra-wide)
 *    · key provider doesn't match requested model → BYOK skipped → Managed
 *
 *  - Studio → Managed direct.
 *
 *  - Circuit-breaker integration: open breaker short-circuits to
 *    `provider_down { circuitOpen: true }` without an HTTP call.
 *
 *  - `providerForModel` + `routingMismatchUserMessage` helpers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  context,
  ROOT_CONTEXT,
  SpanKind,
  SpanStatusCode,
  trace,
  type Context,
} from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
  type FlagsReader,
  FLAG_DEFAULTS,
  createStaticFlagsReader,
} from '../../src/config/index.js';
import { make, type LLMCallError } from '../../src/errors/taxonomy.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';
import {
  hashUserId,
  resetTracer,
  setTracer,
} from '../../src/observability/tracing.js';
import type {
  Provider,
  ProviderCallInput,
  ProviderName,
  ProviderPingInput,
} from '../../src/providers/provider.js';
import {
  type CircuitBreaker,
  type ApiKeyRequest,
  type ApiKeyResolver,
  type OriginKind,
  type PlanRouter,
  type ProviderRegistry,
  type ResolvedKey,
  type RouteInput,
  ROUTER_METRIC_NAMES,
  createCircuitBreaker,
  createPlanRouter,
  providerForModel,
  routingMismatchUserMessage,
} from '../../src/routing/index.js';
import { err, ok, type Result } from '../../src/types.js';
import { hashNormalizedRequest } from '../../src/accounting/index.js';
import type {
  ConsentResolver,
  UsageEntry,
  UsageRecorder,
} from '../../src/accounting/index.js';
import type { ConsentMode } from '../../src/types/repos.js';
import type {
  ModelId,
  NormalizedLLMRequest,
} from '../../src/types/request.js';
import type { ProviderCallOutput } from '../../src/types/response.js';

// ─── Test harness ─────────────────────────────────────────────────────
//
// Iter 6 commit 2 (P1, P10): `RouteInput` now requires `correlationId`
// + `origin`. Tests default to these sentinels; specs that care about
// identity pass their own value explicitly.

/** Default correlation id for routing-layer specs. */
const DEFAULT_CORR_ID = 'route-test-corr-0000000000000001';

/** Default producer-surface origin — caption-refine is the most common call path. */
const DEFAULT_ORIGIN: OriginKind = 'caption-refine';

function flags(): FlagsReader {
  return createStaticFlagsReader(FLAG_DEFAULTS);
}

/**
 * Stub `Provider.call` queue. Each `enqueue*` pushes one canned outcome
 * that `call()` will consume FIFO.
 */
class FakeProvider implements Provider {
  readonly name: ProviderName;
  private readonly outcomes: Array<Result<ProviderCallOutput, LLMCallError>> =
    [];
  readonly callLog: Array<{
    apiKey: string;
    abortSignal: AbortSignal | undefined;
    /**
     * Captured from `ProviderCallInput.correlationId` — iter 6 commit 2
     * (P11) threaded this field through the adapter boundary. The test
     * harness records it so specs can assert the router propagates the
     * caller's id verbatim (no minting, no rewriting).
     */
    correlationId: string;
  }> = [];

  constructor(name: ProviderName) {
    this.name = name;
  }

  enqueueSuccess(overrides: Partial<ProviderCallOutput> = {}): this {
    this.outcomes.push(
      ok({
        modelUsed: 'claude-sonnet-4-6',
        providerUsed: this.name,
        message: { role: 'assistant', content: 'hi' },
        usage: { inputTokens: 10, outputTokens: 4, totalTokens: 14 },
        stopReason: 'end_turn',
        ...overrides,
      }),
    );
    return this;
  }

  enqueueError(e: LLMCallError): this {
    this.outcomes.push(err(e));
    return this;
  }

  async call(
    input: ProviderCallInput,
  ): Promise<Result<ProviderCallOutput, LLMCallError>> {
    this.callLog.push({
      apiKey: input.apiKey,
      abortSignal: input.abortSignal,
      correlationId: input.correlationId,
    });
    const next = this.outcomes.shift();
    if (next === undefined) {
      throw new Error(
        `FakeProvider(${this.name}) exhausted — no more queued outcomes`,
      );
    }
    return next;
  }

  async ping(
    _input: ProviderPingInput,
  ): Promise<Result<never, LLMCallError>> {
    throw new Error('ping not used in router tests');
  }
}

/** Registry that returns the given provider only when names match. */
function registryFor(p: Provider): ProviderRegistry {
  return {
    get(name) {
      return name === p.name ? p : undefined;
    },
  };
}

function emptyRegistry(): ProviderRegistry {
  return { get: () => undefined };
}

/**
 * Scriptable resolver. Each call to `resolve()` consumes one queued
 * response; tests enqueue specific outcomes per `mode`.
 */
class FakeResolver implements ApiKeyResolver {
  private readonly byokQueue: Array<Result<ResolvedKey, LLMCallError>> = [];
  private readonly managedQueue: Array<Result<ResolvedKey, LLMCallError>> =
    [];
  readonly log: ApiKeyRequest[] = [];

  enqueueByokSuccess(
    apiKey: string,
    provider: ProviderName,
    kekVersion?: number,
  ): this {
    this.byokQueue.push(
      ok({
        apiKey,
        provider,
        mode: 'byok',
        ...(kekVersion !== undefined ? { kekVersion } : {}),
      }),
    );
    return this;
  }

  enqueueByokError(e: LLMCallError): this {
    this.byokQueue.push(err(e));
    return this;
  }

  enqueueManagedSuccess(
    apiKey: string,
    provider: ProviderName,
  ): this {
    this.managedQueue.push(
      ok({ apiKey, provider, mode: 'managed' }),
    );
    return this;
  }

  enqueueManagedError(e: LLMCallError): this {
    this.managedQueue.push(err(e));
    return this;
  }

  async resolve(
    req: ApiKeyRequest,
  ): Promise<Result<ResolvedKey, LLMCallError>> {
    this.log.push(req);
    const q = req.mode === 'byok' ? this.byokQueue : this.managedQueue;
    const next = q.shift();
    if (next === undefined) {
      throw new Error(
        `FakeResolver.${req.mode} queue exhausted for provider=${req.provider}`,
      );
    }
    return next;
  }
}

/** Always-closed circuit breaker — removes CB short-circuiting from the picture. */
function closedBreaker(): CircuitBreaker {
  return {
    isCallAllowed: () => 'allow',
    record: () => {},
    currentState: () => 'closed',
  };
}

/** Always-open circuit breaker. */
function openBreaker(): CircuitBreaker {
  return {
    isCallAllowed: () => 'deny_open',
    record: () => {},
    currentState: () => 'open',
  };
}

function baseRequest(
  overrides: Partial<NormalizedLLMRequest> = {},
): NormalizedLLMRequest {
  return {
    model: 'claude-sonnet-4-6',
    messages: [{ role: 'user', content: 'ping' }],
    maxTokens: 128,
    ...overrides,
  };
}

/**
 * Iter 7 commit 4: fixed clock for `UsageEntry.occurredAt`. Pinned to
 * a round epoch so specs can assert the `occurredAt` is preserved
 * verbatim by the recorder. Tests that care about per-call timing
 * do their own recording inspection.
 */
const TEST_USAGE_CLOCK_MS = 1_700_000_000_000;

/**
 * Iter 7 commit 4: non-throwing consent fake. Defaults to `'full'` for
 * all specs that don't care; `enqueue(mode)` pushes a one-shot override
 * consumed FIFO. `log` captures every userId the router asked about so
 * specs can assert "consent resolved once per call".
 */
class FakeConsentResolver implements ConsentResolver {
  readonly log: string[] = [];
  private readonly queue: ConsentMode[] = [];
  private defaultMode: ConsentMode = 'full';

  setDefault(mode: ConsentMode): this {
    this.defaultMode = mode;
    return this;
  }

  enqueue(mode: ConsentMode): this {
    this.queue.push(mode);
    return this;
  }

  async resolve(userId: string): Promise<ConsentMode> {
    this.log.push(userId);
    return this.queue.shift() ?? this.defaultMode;
  }
}

/**
 * Iter 7 commit 4: in-memory recorder fake. `recorded` captures every
 * entry the router hands us; `flush` + `bufferSize` are no-ops because
 * the router never calls them.
 */
class FakeUsageRecorder implements UsageRecorder {
  readonly recorded: UsageEntry[] = [];

  async record(entry: UsageEntry): Promise<void> {
    this.recorded.push(entry);
  }

  async flush(): Promise<void> {
    /* no-op */
  }

  bufferSize(): number {
    return 0;
  }
}

interface BuildRouterExtras {
  readonly consentResolver?: ConsentResolver;
  readonly usageRecorder?: UsageRecorder;
  readonly usageClock?: () => Date;
}

function buildRouter(
  provider: FakeProvider,
  resolver: FakeResolver,
  breaker: CircuitBreaker,
  metrics: InMemoryMetrics,
  onByokKeyInvalidated?: (args: {
    readonly userId: string;
    readonly provider: ProviderName;
  }) => void,
  extras: BuildRouterExtras = {},
): PlanRouter {
  return createPlanRouter({
    providers: registryFor(provider),
    resolver,
    breaker,
    flags: flags(),
    metrics,
    consentResolver: extras.consentResolver ?? new FakeConsentResolver(),
    usageRecorder: extras.usageRecorder ?? new FakeUsageRecorder(),
    usageClock: extras.usageClock ?? ((): Date => new Date(TEST_USAGE_CLOCK_MS)),
    ...(onByokKeyInvalidated !== undefined
      ? { onByokKeyInvalidated }
      : {}),
  });
}

// ─── providerForModel ────────────────────────────────────────────────

describe('providerForModel', () => {
  it('maps Anthropic models to anthropic', () => {
    expect(providerForModel('claude-opus-4-6')).toBe('anthropic');
    expect(providerForModel('claude-sonnet-4-6')).toBe('anthropic');
    expect(providerForModel('claude-haiku-4-5')).toBe('anthropic');
  });

  it('maps OpenAI models to openai', () => {
    expect(providerForModel('gpt-5')).toBe('openai');
    expect(providerForModel('gpt-5-mini')).toBe('openai');
  });

  it('maps Gemini models to gemini', () => {
    expect(providerForModel('gemini-2.5-pro')).toBe('gemini');
    expect(providerForModel('gemini-2.5-flash')).toBe('gemini');
  });

  it('throws on an unknown ModelId (exhaustiveness guard)', () => {
    expect(() =>
      providerForModel('not-a-real-model' as unknown as ModelId),
    ).toThrow(/No provider mapping/);
  });
});

describe('routingMismatchUserMessage', () => {
  it('names the required and current provider in the copy', () => {
    const msg = routingMismatchUserMessage('anthropic', 'openai');
    expect(msg).toContain('Anthropic');
    expect(msg).toContain('Openai');
    expect(msg).toMatch(/Settings.*Integrations/);
  });
});

// ─── Free / Creator — BYOK mandatory ──────────────────────────────────

describe('PlanRouter — Free / Creator (BYOK mandatory)', () => {
  let provider: FakeProvider;
  let resolver: FakeResolver;
  let metrics: InMemoryMetrics;

  beforeEach(() => {
    provider = new FakeProvider('anthropic');
    resolver = new FakeResolver();
    metrics = new InMemoryMetrics();
  });

  function routeAsFree(
    userOverrides: Partial<RouteInput['user']> = {},
    requestOverrides: Partial<NormalizedLLMRequest> = {},
    onByokKeyInvalidated?: (args: {
      readonly userId: string;
      readonly provider: ProviderName;
    }) => void,
  ): ReturnType<PlanRouter['route']> {
    const router = buildRouter(
      provider,
      resolver,
      closedBreaker(),
      metrics,
      onByokKeyInvalidated,
    );
    return router.route({
      user: {
        userId: 'u-1',
        plan: 'free',
        ...userOverrides,
      },
      request: baseRequest(requestOverrides),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
  }

  it('no key on file → plan_requires_key + resolveFailures counter', async () => {
    const res = await routeAsFree({
      llmKeyProvider: undefined,
      llmKeyStatus: 'unset',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual(make.planRequiresKey('free'));
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan: 'free',
        reason: 'no_key',
      }),
    ).toBe(1);
    expect(provider.callLog).toHaveLength(0);
    expect(resolver.log).toHaveLength(0);
  });

  it('key status field undefined also counts as "no key"', async () => {
    const res = await routeAsFree({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: undefined,
    });
    expect(res.ok).toBe(false);
  });

  it('provider mismatch → plan_requires_key + provider_mismatch reason', async () => {
    const res = await routeAsFree({
      llmKeyProvider: 'openai',
      llmKeyStatus: 'active',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('plan_requires_key');
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan: 'free',
        reason: 'provider_mismatch',
      }),
    ).toBe(1);
    // No provider call attempted.
    expect(provider.callLog).toHaveLength(0);
  });

  it('key status invalid → plan_requires_key with reason label', async () => {
    const res = await routeAsFree({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'invalid',
    });
    expect(res.ok).toBe(false);
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan: 'free',
        reason: 'key_status_invalid',
      }),
    ).toBe(1);
  });

  it('key status quota_exhausted → plan_requires_key', async () => {
    const res = await routeAsFree({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'quota_exhausted',
    });
    expect(res.ok).toBe(false);
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan: 'free',
        reason: 'key_status_quota_exhausted',
      }),
    ).toBe(1);
  });

  it('key status pending is accepted (lets the first call confirm the key)', async () => {
    resolver.enqueueByokSuccess('sk-pending-ok', 'anthropic');
    provider.enqueueSuccess();

    const res = await routeAsFree({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'pending',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fundingMode).toBe('byok');
    expect(provider.callLog[0]!.apiKey).toBe('sk-pending-ok');
  });

  it('resolver fails → surfaces resolver error untouched', async () => {
    resolver.enqueueByokError(make.kmsUnavailable(true));
    const res = await routeAsFree({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'active',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('kms_unavailable');
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan: 'free',
        reason: 'resolve_error',
      }),
    ).toBe(1);
  });

  it('successful call → ok with fundingMode byok + requests counter', async () => {
    resolver.enqueueByokSuccess('sk-byok', 'anthropic');
    provider.enqueueSuccess({ modelUsed: 'claude-sonnet-4-6' });

    const res = await routeAsFree({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'active',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fundingMode).toBe('byok');
    expect(res.value.providerUsed).toBe('anthropic');
    expect(res.value.modelUsed).toBe('claude-sonnet-4-6');
    expect(provider.callLog[0]!.apiKey).toBe('sk-byok');
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.requests, {
        plan: 'free',
        provider: 'anthropic',
        fundingMode: 'byok',
        outcome: 'ok',
      }),
    ).toBe(1);
  });

  it('BYOK invalid_key → plan_requires_key AND onByokKeyInvalidated fires', async () => {
    const invalidateSpy = vi.fn();
    resolver.enqueueByokSuccess('sk-will-fail', 'anthropic');
    provider.enqueueError(make.invalidKey('anthropic'));

    const res = await routeAsFree(
      {
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      {},
      invalidateSpy,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Free/Creator surfaces plan_requires_key, not raw invalid_key.
    expect(res.error).toEqual(make.planRequiresKey('free'));
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(invalidateSpy).toHaveBeenCalledWith({
      userId: 'u-1',
      provider: 'anthropic',
    });
  });

  it('creator plan routes through the same BYOK-only path', async () => {
    resolver.enqueueByokSuccess('sk-creator', 'anthropic');
    provider.enqueueSuccess();

    const res = await routeAsFree({
      plan: 'creator',
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'active',
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fundingMode).toBe('byok');
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.requests, {
        plan: 'creator',
        provider: 'anthropic',
        fundingMode: 'byok',
        outcome: 'ok',
      }),
    ).toBe(1);
  });

  it('BYOK provider returns provider_down → surfaces it (not plan_requires_key)', async () => {
    resolver.enqueueByokSuccess('sk-ok', 'anthropic');
    provider.enqueueError(make.providerDown('anthropic', false));

    const res = await routeAsFree({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'active',
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.requests, {
        plan: 'free',
        provider: 'anthropic',
        fundingMode: 'byok',
        outcome: 'provider_down',
      }),
    ).toBe(1);
  });
});

// ─── Influencer / Celebrity — Managed + optional BYOK ─────────────────

describe('PlanRouter — Influencer / Celebrity (Managed + optional BYOK)', () => {
  let provider: FakeProvider;
  let resolver: FakeResolver;
  let metrics: InMemoryMetrics;

  beforeEach(() => {
    provider = new FakeProvider('anthropic');
    resolver = new FakeResolver();
    metrics = new InMemoryMetrics();
  });

  function routeAsInfluencer(
    userOverrides: Partial<RouteInput['user']> = {},
    requestOverrides: Partial<NormalizedLLMRequest> = {},
    onByokKeyInvalidated?: (args: {
      readonly userId: string;
      readonly provider: ProviderName;
    }) => void,
  ): ReturnType<PlanRouter['route']> {
    const router = buildRouter(
      provider,
      resolver,
      closedBreaker(),
      metrics,
      onByokKeyInvalidated,
    );
    return router.route({
      user: {
        userId: 'u-inf',
        plan: 'influencer',
        ...userOverrides,
      },
      request: baseRequest(requestOverrides),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
  }

  it('preferMyKey=false → Managed direct, BYOK not attempted', async () => {
    resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
    provider.enqueueSuccess();

    const res = await routeAsInfluencer({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'active',
      llmPreferMyKey: false,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fundingMode).toBe('managed');
    expect(provider.callLog[0]!.apiKey).toBe('sk-managed');
    // Only a managed resolve happened — never a BYOK resolve.
    expect(resolver.log).toEqual([
      { mode: 'managed', provider: 'anthropic' },
    ]);
  });

  it('preferMyKey=true + active BYOK + success → BYOK used, funded byok', async () => {
    resolver.enqueueByokSuccess('sk-byok-inf', 'anthropic');
    provider.enqueueSuccess();

    const res = await routeAsInfluencer({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'active',
      llmPreferMyKey: true,
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fundingMode).toBe('byok');
    expect(provider.callLog[0]!.apiKey).toBe('sk-byok-inf');
    // Only one resolve call — BYOK.
    expect(resolver.log).toHaveLength(1);
    expect(resolver.log[0]).toMatchObject({ mode: 'byok' });
  });

  // ── Jean's explicit test case (ajuste 6) ─────────────────────────────
  it(
    'Influencer+ preferMyKey=true + BYOK invalid_key → router falls back ' +
      'to Managed, stamps providerUsed, fires invalidation callback, ' +
      'increments fallbacks{reason=invalid_key}',
    async () => {
      const invalidateSpy = vi.fn();
      // BYOK path: resolver succeeds, provider returns invalid_key.
      resolver.enqueueByokSuccess('sk-invalid', 'anthropic');
      provider.enqueueError(make.invalidKey('anthropic'));
      // Managed fallback path: resolver + provider both succeed.
      resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
      provider.enqueueSuccess({ providerUsed: 'anthropic' });

      const res = await routeAsInfluencer(
        {
          llmKeyProvider: 'anthropic',
          llmKeyStatus: 'active',
          llmPreferMyKey: true,
        },
        {},
        invalidateSpy,
      );

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.fundingMode).toBe('managed');
      expect(res.value.providerUsed).toBe('anthropic');
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
      expect(invalidateSpy).toHaveBeenCalledWith({
        userId: 'u-inf',
        provider: 'anthropic',
      });
      expect(
        metrics.readCounter(ROUTER_METRIC_NAMES.fallbacks, {
          plan: 'influencer',
          provider: 'anthropic',
          reason: 'invalid_key',
        }),
      ).toBe(1);
      // Provider was called exactly twice — BYOK then Managed.
      expect(provider.callLog.map((c) => c.apiKey)).toEqual([
        'sk-invalid',
        'sk-managed',
      ]);
      expect(
        metrics.readCounter(ROUTER_METRIC_NAMES.requests, {
          plan: 'influencer',
          provider: 'anthropic',
          fundingMode: 'managed',
          outcome: 'ok',
        }),
      ).toBe(1);
    },
  );

  it('preferMyKey=true + BYOK quota_exhausted → Managed fallback, NO invalidation callback', async () => {
    const invalidateSpy = vi.fn();
    resolver.enqueueByokSuccess('sk-exhausted', 'anthropic');
    provider.enqueueError(make.quotaExhausted('anthropic'));
    resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
    provider.enqueueSuccess();

    const res = await routeAsInfluencer(
      {
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
        llmPreferMyKey: true,
      },
      {},
      invalidateSpy,
    );

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fundingMode).toBe('managed');
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.fallbacks, {
        plan: 'influencer',
        provider: 'anthropic',
        reason: 'quota_exhausted',
      }),
    ).toBe(1);
  });

  it('preferMyKey=true + BYOK provider_down → surfaced, NO Managed fallback', async () => {
    const invalidateSpy = vi.fn();
    resolver.enqueueByokSuccess('sk-ok', 'anthropic');
    provider.enqueueError(make.providerDown('anthropic', false));

    const res = await routeAsInfluencer(
      {
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
        llmPreferMyKey: true,
      },
      {},
      invalidateSpy,
    );

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.fallbacks, {
        plan: 'influencer',
        provider: 'anthropic',
        reason: 'invalid_key',
      }),
    ).toBe(0);
    // No second provider call — fallback was NOT attempted.
    expect(provider.callLog).toHaveLength(1);
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.requests, {
        plan: 'influencer',
        provider: 'anthropic',
        fundingMode: 'byok',
        outcome: 'provider_down',
      }),
    ).toBe(1);
  });

  it(
    'preferMyKey=true + BYOK rate_limit → Managed fallback, NO invalidation callback ' +
      '(Ajuste 6 FULL: per-key bucket, Managed has independent bucket)',
    async () => {
      const invalidateSpy = vi.fn();
      resolver.enqueueByokSuccess('sk-throttled', 'anthropic');
      provider.enqueueError(make.rateLimit('anthropic', 5));
      resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
      provider.enqueueSuccess({ providerUsed: 'anthropic' });

      const res = await routeAsInfluencer(
        {
          llmKeyProvider: 'anthropic',
          llmKeyStatus: 'active',
          llmPreferMyKey: true,
        },
        {},
        invalidateSpy,
      );

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.fundingMode).toBe('managed');
      expect(res.value.providerUsed).toBe('anthropic');
      // NO invalidation — the key is fine, just rate-limited.
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(
        metrics.readCounter(ROUTER_METRIC_NAMES.fallbacks, {
          plan: 'influencer',
          provider: 'anthropic',
          reason: 'rate_limit',
        }),
      ).toBe(1);
      // BYOK then Managed.
      expect(provider.callLog.map((c) => c.apiKey)).toEqual([
        'sk-throttled',
        'sk-managed',
      ]);
      expect(
        metrics.readCounter(ROUTER_METRIC_NAMES.requests, {
          plan: 'influencer',
          provider: 'anthropic',
          fundingMode: 'managed',
          outcome: 'ok',
        }),
      ).toBe(1);
    },
  );

  it(
    'preferMyKey=true + BYOK network_error → Managed fallback, NO invalidation callback ' +
      '(Ajuste 6 FULL: transient per-call; Managed retry may land on a different path)',
    async () => {
      const invalidateSpy = vi.fn();
      resolver.enqueueByokSuccess('sk-ok', 'anthropic');
      provider.enqueueError(make.networkError(true));
      resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
      provider.enqueueSuccess({ providerUsed: 'anthropic' });

      const res = await routeAsInfluencer(
        {
          llmKeyProvider: 'anthropic',
          llmKeyStatus: 'active',
          llmPreferMyKey: true,
        },
        {},
        invalidateSpy,
      );

      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.fundingMode).toBe('managed');
      expect(invalidateSpy).not.toHaveBeenCalled();
      expect(
        metrics.readCounter(ROUTER_METRIC_NAMES.fallbacks, {
          plan: 'influencer',
          provider: 'anthropic',
          reason: 'network_error',
        }),
      ).toBe(1);
      expect(provider.callLog).toHaveLength(2);
      expect(
        metrics.readCounter(ROUTER_METRIC_NAMES.requests, {
          plan: 'influencer',
          provider: 'anthropic',
          fundingMode: 'managed',
          outcome: 'ok',
        }),
      ).toBe(1);
    },
  );

  it('preferMyKey=true but BYOK resolver fails → surfaced (KMS likely infra-wide)', async () => {
    resolver.enqueueByokError(make.kmsUnavailable(false));

    const res = await routeAsInfluencer({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'active',
      llmPreferMyKey: true,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('kms_unavailable');
    // Provider was never reached.
    expect(provider.callLog).toHaveLength(0);
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan: 'influencer',
        mode: 'byok',
        reason: 'resolve_error',
      }),
    ).toBe(1);
  });

  it('preferMyKey=true but BYOK provider mismatches model → Managed direct', async () => {
    // Request is for anthropic, user's BYOK is for openai — skip BYOK.
    resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
    provider.enqueueSuccess();

    const res = await routeAsInfluencer({
      llmKeyProvider: 'openai',
      llmKeyStatus: 'active',
      llmPreferMyKey: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fundingMode).toBe('managed');
    // Only Managed was consulted.
    expect(resolver.log).toEqual([
      { mode: 'managed', provider: 'anthropic' },
    ]);
  });

  it('preferMyKey=true but BYOK status is not active → Managed direct', async () => {
    resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
    provider.enqueueSuccess();

    const res = await routeAsInfluencer({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'invalid',
      llmPreferMyKey: true,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fundingMode).toBe('managed');
    expect(resolver.log[0]).toMatchObject({ mode: 'managed' });
  });

  it('Managed resolver failure surfaces + counter', async () => {
    resolver.enqueueManagedError(make.kmsUnavailable(false));

    const res = await routeAsInfluencer({
      llmKeyProvider: 'anthropic',
      llmKeyStatus: 'active',
      llmPreferMyKey: false,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('kms_unavailable');
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan: 'influencer',
        mode: 'managed',
        reason: 'resolve_error',
      }),
    ).toBe(1);
  });

  it('celebrity plan is treated like influencer (BYOK fallback path)', async () => {
    const invalidateSpy = vi.fn();
    resolver.enqueueByokSuccess('sk-celeb', 'anthropic');
    provider.enqueueError(make.invalidKey('anthropic'));
    resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
    provider.enqueueSuccess();

    const res = await routeAsInfluencer(
      {
        plan: 'celebrity',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
        llmPreferMyKey: true,
      },
      {},
      invalidateSpy,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fundingMode).toBe('managed');
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  it('fires invalidation callback even when no spy configured (no throw)', async () => {
    // Router is built without onByokKeyInvalidated — the fallback path
    // must still work, the optional callback is a no-op.
    resolver.enqueueByokSuccess('sk-invalid', 'anthropic');
    provider.enqueueError(make.invalidKey('anthropic'));
    resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
    provider.enqueueSuccess();

    const router = buildRouter(
      provider,
      resolver,
      closedBreaker(),
      metrics,
    );

    const res = await router.route({
      user: {
        userId: 'u-inf',
        plan: 'influencer',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
        llmPreferMyKey: true,
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fundingMode).toBe('managed');
  });
});

// ─── Studio ───────────────────────────────────────────────────────────

describe('PlanRouter — Studio', () => {
  it('Studio with preferMyKey=true still routes Managed (no BYOK seam in iter 4)', async () => {
    const provider = new FakeProvider('anthropic');
    const resolver = new FakeResolver();
    const metrics = new InMemoryMetrics();
    resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
    provider.enqueueSuccess();

    const router = buildRouter(
      provider,
      resolver,
      closedBreaker(),
      metrics,
    );

    const res = await router.route({
      user: {
        userId: 'u-studio',
        plan: 'studio',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
        llmPreferMyKey: true,
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.fundingMode).toBe('managed');
    expect(resolver.log).toEqual([
      { mode: 'managed', provider: 'anthropic' },
    ]);
  });
});

// ─── Circuit-breaker integration ──────────────────────────────────────

describe('PlanRouter — circuit-breaker integration', () => {
  it('CB open short-circuits to provider_down{circuitOpen:true} with no HTTP call', async () => {
    const provider = new FakeProvider('anthropic');
    const resolver = new FakeResolver();
    resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
    // No queued provider outcome — test fails if one is consumed.
    const metrics = new InMemoryMetrics();

    const router = buildRouter(
      provider,
      resolver,
      openBreaker(),
      metrics,
    );

    const res = await router.route({
      user: { userId: 'u-1', plan: 'influencer' },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });

    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual(make.providerDown('anthropic', true));
    expect(provider.callLog).toHaveLength(0);
    expect(
      metrics.readCounter(ROUTER_METRIC_NAMES.cbDenies, {
        provider: 'anthropic',
        decision: 'deny_open',
      }),
    ).toBe(1);
  });

  it('records success + failure on the breaker (real breaker)', async () => {
    const provider = new FakeProvider('anthropic');
    const resolver = new FakeResolver();
    const metrics = new InMemoryMetrics();
    // Tight thresholds to trip quickly.
    const breaker = createCircuitBreaker({
      flags: createStaticFlagsReader({
        ...FLAG_DEFAULTS,
        'llm.circuit_breaker.volume_threshold': 3,
        'llm.circuit_breaker.error_threshold': 0.3,
      }),
      metrics: new InMemoryMetrics(),
      now: () => 1_700_000_000_000,
    });

    const router = createPlanRouter({
      providers: registryFor(provider),
      resolver,
      breaker,
      flags: flags(),
      metrics,
      consentResolver: new FakeConsentResolver(),
      usageRecorder: new FakeUsageRecorder(),
      usageClock: (): Date => new Date(TEST_USAGE_CLOCK_MS),
    });

    // Three managed failures in a row — should trip the breaker.
    for (let i = 0; i < 3; i++) {
      resolver.enqueueManagedSuccess(`sk-${i}`, 'anthropic');
      provider.enqueueError(make.providerDown('anthropic', false));
    }
    const user = { userId: 'u', plan: 'influencer' as const };

    for (let i = 0; i < 3; i++) {
      const res = await router.route({
        user,
        request: baseRequest(),
        correlationId: DEFAULT_CORR_ID,
        origin: DEFAULT_ORIGIN,
      });
      expect(res.ok).toBe(false);
    }

    expect(breaker.currentState('anthropic')).toBe('open');

    // Fourth call — breaker is open, provider NOT called.
    resolver.enqueueManagedSuccess('sk-unreachable', 'anthropic');
    const res = await router.route({
      user,
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual(make.providerDown('anthropic', true));
    // Provider was called 3 times (the failures), NOT 4.
    expect(provider.callLog).toHaveLength(3);
  });
});

// ─── correlationId plumbing (iter 6 commit 2 — P10/P11) ──────────────

describe('PlanRouter — correlationId propagation', () => {
  /**
   * P11 (LLM_CLIENT v1.1 §11): the caller's correlationId must reach
   * the adapter verbatim so the provider call, the root span, and the
   * audit log share the same identifier. If the router ever rewrites
   * or mints a new id on the happy path, root-to-leaf stitching breaks
   * silently in production dashboards.
   */
  it('threads RouteInput.correlationId into ProviderCallInput.correlationId verbatim on the happy path', async () => {
    const provider = new FakeProvider('anthropic');
    const resolver = new FakeResolver();
    const metrics = new InMemoryMetrics();
    resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
    provider.enqueueSuccess();

    const router = buildRouter(
      provider,
      resolver,
      closedBreaker(),
      metrics,
    );

    const passedCorrId = 'happy-path-corr-0123456789abcdef';
    const res = await router.route({
      user: { userId: 'u-corr-1', plan: 'influencer' },
      request: baseRequest(),
      correlationId: passedCorrId,
      origin: 'hook-brainstorm',
    });

    expect(res.ok).toBe(true);
    // One call, one id — same id as the caller supplied.
    expect(provider.callLog).toHaveLength(1);
    expect(provider.callLog[0]!.correlationId).toBe(passedCorrId);
  });

  /**
   * Fallback path also threads the caller's id: both the BYOK attempt
   * and the Managed retry must share the same correlationId, because
   * from the outside they are a single logical LLM call. The commit-2
   * invariant is "one RouteInput.correlationId → every physical
   * provider call on its behalf".
   */
  it('reuses the same correlationId for BYOK attempt + Managed fallback (Influencer invalid_key retry)', async () => {
    const provider = new FakeProvider('anthropic');
    const resolver = new FakeResolver();
    const metrics = new InMemoryMetrics();
    resolver.enqueueByokSuccess('sk-byok', 'anthropic');
    provider.enqueueError(make.invalidKey('anthropic'));
    resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
    provider.enqueueSuccess();

    const router = buildRouter(
      provider,
      resolver,
      closedBreaker(),
      metrics,
      () => {},
    );

    const passedCorrId = 'fallback-corr-fedcba9876543210';
    const res = await router.route({
      user: {
        userId: 'u-corr-2',
        plan: 'influencer',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
        llmPreferMyKey: true,
      },
      request: baseRequest(),
      correlationId: passedCorrId,
      origin: 'caption-refine',
    });

    expect(res.ok).toBe(true);
    expect(provider.callLog).toHaveLength(2);
    expect(provider.callLog[0]!.correlationId).toBe(passedCorrId);
    expect(provider.callLog[1]!.correlationId).toBe(passedCorrId);
  });

  /**
   * Two parallel `route()` calls with different ids must keep their
   * ids separate — a dumb aliasing bug (e.g. a module-level mutable
   * holder) would only surface under concurrency.
   */
  it('isolates correlationIds across concurrent route() calls', async () => {
    const provider = new FakeProvider('anthropic');
    const resolver = new FakeResolver();
    const metrics = new InMemoryMetrics();
    // Two managed resolves + two provider successes, consumed FIFO.
    resolver.enqueueManagedSuccess('sk-m1', 'anthropic');
    resolver.enqueueManagedSuccess('sk-m2', 'anthropic');
    provider.enqueueSuccess();
    provider.enqueueSuccess();

    const router = buildRouter(
      provider,
      resolver,
      closedBreaker(),
      metrics,
    );

    const corrA = 'concurrent-corr-AAAAAAAAAAAAAAAA';
    const corrB = 'concurrent-corr-BBBBBBBBBBBBBBBB';
    await Promise.all([
      router.route({
        user: { userId: 'u-a', plan: 'influencer' },
        request: baseRequest(),
        correlationId: corrA,
        origin: DEFAULT_ORIGIN,
      }),
      router.route({
        user: { userId: 'u-b', plan: 'influencer' },
        request: baseRequest(),
        correlationId: corrB,
        origin: DEFAULT_ORIGIN,
      }),
    ]);

    expect(provider.callLog).toHaveLength(2);
    const seen = new Set(provider.callLog.map((e) => e.correlationId));
    expect(seen).toEqual(new Set([corrA, corrB]));
  });
});

// ─── Misconfigured registry → internal ────────────────────────────────

describe('PlanRouter — deployment misconfiguration', () => {
  it('returns `internal` stamped with the caller-supplied correlationId when the provider is not registered', async () => {
    // P10 (LLM_CLIENT v1.1 §10): the router must NOT mint its own
    // correlation id on the internal-error path — it must reuse
    // `input.correlationId` so the root span + audit log stay
    // stitchable. See iter 6 commit 2.
    const resolver = new FakeResolver();
    const metrics = new InMemoryMetrics();
    const router = createPlanRouter({
      providers: emptyRegistry(),
      resolver,
      breaker: closedBreaker(),
      flags: flags(),
      metrics,
      consentResolver: new FakeConsentResolver(),
      usageRecorder: new FakeUsageRecorder(),
      usageClock: (): Date => new Date(TEST_USAGE_CLOCK_MS),
    });

    const passedCorrId = 'misconfig-corr-aabbccddeeff0011';
    const res = await router.route({
      user: { userId: 'u', plan: 'free' },
      request: baseRequest(),
      correlationId: passedCorrId,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('internal');
    if (res.error.kind !== 'internal') return;
    // Equality, NOT a regex match: the router surfaces the caller's id
    // verbatim. If this ever flips back to a minted id, the contract
    // with the caller (which already stamped a root span with the id)
    // silently drifts.
    expect(res.error.correlationId).toBe(passedCorrId);
  });
});

// ─── AbortSignal plumbing ─────────────────────────────────────────────

describe('PlanRouter — AbortSignal plumbing', () => {
  it('forwards abortSignal to the provider call when supplied', async () => {
    const provider = new FakeProvider('anthropic');
    const resolver = new FakeResolver();
    const metrics = new InMemoryMetrics();
    resolver.enqueueManagedSuccess('sk-managed', 'anthropic');
    provider.enqueueSuccess();

    const router = buildRouter(
      provider,
      resolver,
      closedBreaker(),
      metrics,
    );
    const ac = new AbortController();

    const res = await router.route({
      user: { userId: 'u', plan: 'influencer' },
      request: baseRequest(),
      abortSignal: ac.signal,
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });

    expect(res.ok).toBe(true);
    expect(provider.callLog[0]!.abortSignal).toBe(ac.signal);
  });
});

// ─── OTel spans — iter 6 commit 3 (§10.1) ─────────────────────────────
//
// Hermetic test block for the `llm.client.call` root span +
// `llm.provider.request` sub-span emitted by `plan-router.ts`. Each
// spec wires a fresh `BasicTracerProvider` with a
// `SimpleSpanProcessor` feeding an `InMemorySpanExporter` — then
// injects that tracer via the commit-1 DI seam (`setTracer`). Specs
// assert on the exporter's `getFinishedSpans()`.
//
// Parent-child linkage across `await` requires an
// `AsyncHooksContextManager` that we do NOT install in tests (prod
// installs one in the `@chisu/observability` package). Without it,
// the sub-span is emitted as an independent root — the specs below
// assert on presence + attributes + kind + status of each span
// individually, not on hierarchy. This matches the contract: OTel
// parentage is a runtime-level concern, span content is a
// code-level concern.
//
// Signed constraints enforced (iter 6 commit 3 mini-spec,
// 2026-04-20):
//  - R1: `llm.funding_mode` is stamped at close-success only, and is
//    DERIVED from the routing result (never from input).
//  - R2: `trace.idempotency_key_hash` is NEVER present on any span —
//    iter 7 facade owns it because `RouteInput` has no idempotency
//    key.
//  - R3: error path uses manual `setStatus(ERROR)` — NEVER
//    `recordException` (route() returns `Result<_, LLMCallError>`;
//    LLMCallError is a tagged union, not an `Error`).

describe('PlanRouter — OTel spans (iter 6 commit 3, §10.1)', () => {
  let exporter: InMemorySpanExporter;
  let tracerProvider: BasicTracerProvider;
  let provider: FakeProvider;
  let resolver: FakeResolver;
  let metrics: InMemoryMetrics;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    // OTel JS ≥1.26 — spanProcessors via constructor; post-hoc
    // `addSpanProcessor` is deprecated.
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    setTracer(tracerProvider.getTracer('plan-router-test'));

    provider = new FakeProvider('anthropic');
    resolver = new FakeResolver();
    metrics = new InMemoryMetrics();
  });

  afterEach(async () => {
    resetTracer();
    exporter.reset();
    await tracerProvider.shutdown();
  });

  /** Convenience: build + invoke the router with the shared stubs. */
  function routeWith(
    input: RouteInput,
    breaker: CircuitBreaker = closedBreaker(),
    onByokKeyInvalidated?: (args: {
      readonly userId: string;
      readonly provider: ProviderName;
    }) => void,
  ): ReturnType<PlanRouter['route']> {
    const router = buildRouter(
      provider,
      resolver,
      breaker,
      metrics,
      onByokKeyInvalidated,
    );
    return router.route(input);
  }

  it('happy BYOK (Free) — root span OK has the seven close attrs; sub-span OK has token counts', async () => {
    resolver.enqueueByokSuccess('sk-byok-xyz', 'anthropic');
    provider.enqueueSuccess({
      modelUsed: 'claude-sonnet-4-6',
      providerUsed: 'anthropic',
    });

    const res = await routeWith({
      user: {
        userId: 'u-obs-1',
        plan: 'free',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(true);

    const spans = exporter.getFinishedSpans();
    const rootSpan = spans.find((s) => s.name === 'llm.client.call');
    const subSpan = spans.find((s) => s.name === 'llm.provider.request');
    expect(rootSpan).toBeDefined();
    expect(subSpan).toBeDefined();

    // Root open attrs.
    expect(rootSpan!.kind).toBe(SpanKind.CLIENT);
    expect(rootSpan!.attributes['llm.origin']).toBe('caption-refine');
    // user.id_hash: sha256(userId) — never the raw id.
    expect(rootSpan!.attributes['user.id_hash']).toBe(hashUserId('u-obs-1'));
    expect(rootSpan!.attributes['user.id_hash']).not.toBe('u-obs-1');
    expect(String(rootSpan!.attributes['user.id_hash'])).toMatch(
      /^[0-9a-f]{64}$/,
    );

    // Root close-success attrs (seven total per §10.1 / R1).
    expect(rootSpan!.attributes['llm.provider']).toBe('anthropic');
    expect(rootSpan!.attributes['llm.model']).toBe('claude-sonnet-4-6');
    expect(rootSpan!.attributes['llm.input_tokens']).toBe(10);
    expect(rootSpan!.attributes['llm.output_tokens']).toBe(4);
    expect(rootSpan!.attributes['llm.funding_mode']).toBe('byok');
    expect(rootSpan!.attributes['llm.circuit_state']).toBe('closed');
    expect(typeof rootSpan!.attributes['llm.latency_ms']).toBe('number');
    expect(rootSpan!.attributes['llm.latency_ms']).toBeGreaterThanOrEqual(0);
    expect(rootSpan!.status.code).toBe(SpanStatusCode.OK);

    // Sub-span attrs.
    expect(subSpan!.kind).toBe(SpanKind.CLIENT);
    expect(subSpan!.attributes['llm.provider']).toBe('anthropic');
    expect(subSpan!.attributes['llm.model']).toBe('claude-sonnet-4-6');
    expect(subSpan!.attributes['llm.input_tokens']).toBe(10);
    expect(subSpan!.attributes['llm.output_tokens']).toBe(4);
    expect(subSpan!.status.code).toBe(SpanStatusCode.OK);
  });

  it('happy Managed (Influencer, preferMyKey default off) — root stamps llm.funding_mode=managed (R1 — derived, not from input)', async () => {
    resolver.enqueueManagedSuccess('sk-mng', 'anthropic');
    provider.enqueueSuccess();

    const res = await routeWith({
      user: { userId: 'u-obs-2', plan: 'influencer' },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(true);

    const rootSpan = exporter
      .getFinishedSpans()
      .find((s) => s.name === 'llm.client.call');
    expect(rootSpan!.attributes['llm.funding_mode']).toBe('managed');
    expect(rootSpan!.attributes['llm.provider']).toBe('anthropic');
    expect(rootSpan!.status.code).toBe(SpanStatusCode.OK);
  });

  it('BYOK → Managed fallback on invalid_key — two sub-spans (first ERROR, second OK); root OK with funding_mode=managed', async () => {
    resolver.enqueueByokSuccess('sk-user-bad', 'anthropic');
    resolver.enqueueManagedSuccess('sk-mng-good', 'anthropic');
    provider.enqueueError(make.invalidKey('anthropic'));
    provider.enqueueSuccess();

    const res = await routeWith({
      user: {
        userId: 'u-fb',
        plan: 'influencer',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
        llmPreferMyKey: true,
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(true);

    const spans = exporter.getFinishedSpans();
    const subSpans = spans.filter((s) => s.name === 'llm.provider.request');
    expect(subSpans).toHaveLength(2);
    // SimpleSpanProcessor exports in end-order: BYOK (error) first,
    // Managed (ok) second.
    expect(subSpans[0]!.status.code).toBe(SpanStatusCode.ERROR);
    expect(subSpans[0]!.status.message).toBe('invalid_key');
    expect(subSpans[0]!.attributes['llm.input_tokens']).toBeUndefined();
    expect(subSpans[1]!.status.code).toBe(SpanStatusCode.OK);
    expect(subSpans[1]!.attributes['llm.input_tokens']).toBe(10);

    const rootSpan = spans.find((s) => s.name === 'llm.client.call')!;
    expect(rootSpan.status.code).toBe(SpanStatusCode.OK);
    expect(rootSpan.attributes['llm.funding_mode']).toBe('managed');
  });

  it('breaker deny — root ERROR with llm.circuit_state=open; no sub-span (provider.call never attempted)', async () => {
    resolver.enqueueManagedSuccess('sk-mng', 'anthropic');
    // provider.outcomes stays empty — breaker short-circuits first.

    const res = await routeWith(
      {
        user: { userId: 'u-open', plan: 'influencer' },
        request: baseRequest(),
        correlationId: DEFAULT_CORR_ID,
        origin: DEFAULT_ORIGIN,
      },
      openBreaker(),
    );
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');

    const spans = exporter.getFinishedSpans();
    expect(
      spans.filter((s) => s.name === 'llm.provider.request'),
    ).toHaveLength(0);

    const rootSpan = spans.find((s) => s.name === 'llm.client.call')!;
    expect(rootSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan.status.message).toBe('provider_down');
    expect(rootSpan.attributes['llm.circuit_state']).toBe('open');
    // Error path stamps only llm.circuit_state — no close-success attrs.
    expect(rootSpan.attributes['llm.funding_mode']).toBeUndefined();
    expect(rootSpan.attributes['llm.latency_ms']).toBeUndefined();
    expect(rootSpan.attributes['llm.input_tokens']).toBeUndefined();
    expect(rootSpan.attributes['llm.output_tokens']).toBeUndefined();
    // R3: error path NEVER records an exception — the taxonomy is the
    // audit trail. `LLMCallError` is a tagged union, not an Error.
    expect(rootSpan.events).toHaveLength(0);
  });

  it('provider error (rate_limit on Free BYOK) — root ERROR + sub-span ERROR, both with status message=rate_limit; no span events', async () => {
    resolver.enqueueByokSuccess('sk-rl', 'anthropic');
    provider.enqueueError(make.rateLimit('anthropic'));

    const res = await routeWith({
      user: {
        userId: 'u-rl',
        plan: 'free',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('rate_limit');

    const spans = exporter.getFinishedSpans();
    const subSpan = spans.find((s) => s.name === 'llm.provider.request')!;
    expect(subSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(subSpan.status.message).toBe('rate_limit');
    expect(subSpan.attributes['llm.input_tokens']).toBeUndefined();
    expect(subSpan.attributes['llm.output_tokens']).toBeUndefined();
    expect(subSpan.events).toHaveLength(0); // R3 — no recordException

    const rootSpan = spans.find((s) => s.name === 'llm.client.call')!;
    expect(rootSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan.status.message).toBe('rate_limit');
    expect(rootSpan.attributes['llm.circuit_state']).toBe('closed');
    expect(rootSpan.events).toHaveLength(0); // R3 — no recordException
  });

  it('plan_requires_key (Free with no key on file) — root ERROR with message=plan_requires_key; no sub-span (resolver never reached)', async () => {
    const res = await routeWith({
      user: {
        userId: 'u-nk',
        plan: 'free',
        llmKeyProvider: undefined,
        llmKeyStatus: 'unset',
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('plan_requires_key');

    const spans = exporter.getFinishedSpans();
    expect(
      spans.filter((s) => s.name === 'llm.provider.request'),
    ).toHaveLength(0);
    const rootSpan = spans.find((s) => s.name === 'llm.client.call')!;
    expect(rootSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan.status.message).toBe('plan_requires_key');
    expect(rootSpan.attributes['llm.circuit_state']).toBe('closed');
  });

  it('unregistered provider (misconfigured registry) — root ERROR with message=internal; no sub-span', async () => {
    const router = createPlanRouter({
      providers: emptyRegistry(),
      resolver,
      breaker: closedBreaker(),
      flags: flags(),
      metrics,
      consentResolver: new FakeConsentResolver(),
      usageRecorder: new FakeUsageRecorder(),
      usageClock: (): Date => new Date(TEST_USAGE_CLOCK_MS),
    });

    const res = await router.route({
      user: { userId: 'u-mis', plan: 'influencer' },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('internal');

    const spans = exporter.getFinishedSpans();
    expect(
      spans.filter((s) => s.name === 'llm.provider.request'),
    ).toHaveLength(0);
    const rootSpan = spans.find((s) => s.name === 'llm.client.call')!;
    expect(rootSpan.status.code).toBe(SpanStatusCode.ERROR);
    expect(rootSpan.status.message).toBe('internal');
  });

  it('R2 canary — `trace.idempotency_key_hash` is NEVER present on any emitted span (commit 3 omits it by design)', async () => {
    // Three representative paths — happy BYOK, happy Managed, BYOK
    // error — so the canary exercises every span the router can emit.
    resolver.enqueueByokSuccess('sk-1', 'anthropic');
    provider.enqueueSuccess();
    await routeWith({
      user: {
        userId: 'u-r2-a',
        plan: 'free',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      request: baseRequest(),
      correlationId: 'corr-r2-a',
      origin: 'caption-refine',
    });

    resolver.enqueueManagedSuccess('sk-2', 'anthropic');
    provider.enqueueSuccess();
    await routeWith({
      user: { userId: 'u-r2-b', plan: 'influencer' },
      request: baseRequest(),
      correlationId: 'corr-r2-b',
      origin: 'hook-brainstorm',
    });

    resolver.enqueueByokSuccess('sk-3', 'anthropic');
    provider.enqueueError(make.rateLimit('anthropic'));
    await routeWith({
      user: {
        userId: 'u-r2-c',
        plan: 'free',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      request: baseRequest(),
      correlationId: 'corr-r2-c',
      origin: 'mcp-server-callback',
    });

    const spans = exporter.getFinishedSpans();
    // 3 root + 3 sub = 6 spans. Resolver errors / breaker denies in
    // other specs open no sub-span; happy paths here give one of each.
    expect(spans.length).toBeGreaterThanOrEqual(6);
    for (const span of spans) {
      expect(span.attributes['trace.idempotency_key_hash']).toBeUndefined();
    }
  });

  it('zero-leak §14.3 — no raw key material, Bearer token, Authorization header, or raw userId appears in any span attribute value', async () => {
    const rawKey = 'sk-should-never-leak-abc123';
    const rawUserId = 'u-raw-should-not-appear';
    resolver.enqueueByokSuccess(rawKey, 'anthropic');
    provider.enqueueSuccess();

    await routeWith({
      user: {
        userId: rawUserId,
        plan: 'free',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });

    const spans = exporter.getFinishedSpans();
    // Attribute-value leak patterns we must never emit (§14.3).
    const leakPatterns: readonly RegExp[] = [
      /^sk-/, // API key sentinel (Anthropic/OpenAI-style)
      /bearer\s/i, // "Bearer <token>"
      /authorization/i, // "Authorization" header name or value
    ];
    for (const span of spans) {
      for (const value of Object.values(span.attributes)) {
        // attributes can be string | number | boolean | arrays — coerce
        // to string for a broad substring scan. OTel attribute values
        // are never objects in our emission sites.
        const str =
          typeof value === 'string'
            ? value
            : Array.isArray(value)
              ? value.join('|')
              : String(value);
        expect(str).not.toContain(rawKey);
        expect(str).not.toContain(rawUserId);
        for (const pat of leakPatterns) {
          expect(str).not.toMatch(pat);
        }
      }
    }
  });

  it('no-op tracer fallback — after resetTracer(), route() still succeeds; exporter sees zero spans', async () => {
    // Drop the injected tracer so `getTracer()` falls through to the
    // global no-op tracer (per commit 1 DI seam). The call site must
    // not throw and the caller must receive a correct Result.
    resetTracer();
    resolver.enqueueByokSuccess('sk-noop', 'anthropic');
    provider.enqueueSuccess();

    const res = await routeWith({
      user: {
        userId: 'u-np',
        plan: 'free',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(true);
    // No-op tracer does not feed our exporter — the contract is
    // "withSpan / startSpan must not throw without an SDK".
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });

  // ─── iter 8 forward-compat (signed 2026-04-21) ───────────────────
  //
  // The `LLMClient` facade of iter 8 commit 3 owns the `llm.client.call`
  // root span. When it calls `router.route(...)` the facade has already
  // made that span active via `tracer.startActiveSpan(...)`, so the
  // router must reuse it — NOT open a sibling. The two specs below
  // lock that behaviour:
  //   1. `trace.getActiveSpan()` recording → router reuses it
  //      (exactly one span named `llm.client.call`, with close-time
  //      attributes stamped by the router).
  //   2. When reusing, the router must NOT call `.end()` — ownership
  //      stays with the caller (the facade will end it in its own
  //      `finally`).
  // Standalone behaviour (the 670 specs above) is preserved because
  // they run WITHOUT a global context manager installed — in that
  // regime `context.with(ctx, fn)` is a no-op and
  // `trace.getActiveSpan()` returns `undefined`, so the router's
  // `startSpan` fallback keeps firing exactly as before. No test here
  // needs to reassert that; the rest of this describe block already
  // covers it.
  //
  // Nested describe block below: installs a synchronous-only stack
  // `ContextManager` scoped to just these two specs, enabling real
  // `trace.getActiveSpan()` propagation through `context.with(...)`.
  // It does NOT persist across `await` boundaries — but the router
  // calls `trace.getActiveSpan()` synchronously in the prelude of
  // `route()`, before any `await`, so a single-tick stack manager is
  // sufficient. `afterEach` disables it to prevent bleed-through.

  describe('iter 8 forward-compat (facade parity)', () => {
    class StackContextManager {
      private _stack: Context[] = [];
      active(): Context {
        return this._stack[this._stack.length - 1] ?? ROOT_CONTEXT;
      }
      with<A extends unknown[], F extends (...args: A) => ReturnType<F>>(
        ctx: Context,
        fn: F,
        thisArg?: ThisParameterType<F>,
        ...args: A
      ): ReturnType<F> {
        this._stack.push(ctx);
        try {
          return fn.call(thisArg as ThisParameterType<F>, ...args);
        } finally {
          this._stack.pop();
        }
      }
      bind<T>(_ctx: Context, target: T): T {
        return target;
      }
      enable(): this {
        return this;
      }
      disable(): this {
        this._stack = [];
        return this;
      }
    }

    beforeEach(() => {
      context.setGlobalContextManager(new StackContextManager());
    });
    afterEach(() => {
      context.disable();
    });

  it('forward-compat — reuses active span as root when caller already opened one (facade parity)', async () => {
    // Arrange — the "facade" opens and activates its own root span.
    const facadeTracer = tracerProvider.getTracer('facade-test');
    const callerSpan = facadeTracer.startSpan('llm.client.call', {
      kind: SpanKind.CLIENT,
      attributes: {
        'llm.origin': 'caption-refine',
        'user.id_hash': hashUserId('u-fwd-1'),
        // Facade-only attribute (R2 — router never stamps this):
        'trace.idempotency_key_hash':
          'f'.repeat(64),
      },
    });

    resolver.enqueueByokSuccess('sk-fwd-1', 'anthropic');
    provider.enqueueSuccess({
      modelUsed: 'claude-sonnet-4-6',
      providerUsed: 'anthropic',
    });

    // Act — run route() with callerSpan active. The router must pick
    // it up via `trace.getActiveSpan()` instead of opening its own.
    const res = await context.with(
      trace.setSpan(context.active(), callerSpan),
      () =>
        routeWith({
          user: {
            userId: 'u-fwd-1',
            plan: 'free',
            llmKeyProvider: 'anthropic',
            llmKeyStatus: 'active',
          },
          request: baseRequest(),
          correlationId: DEFAULT_CORR_ID,
          origin: DEFAULT_ORIGIN,
        }),
    );
    expect(res.ok).toBe(true);

    // While the caller still owns the span (not yet ended), the
    // exporter has NOT emitted it. Only the sub-span from the router
    // has finished.
    const finishedBeforeEnd = exporter.getFinishedSpans();
    expect(
      finishedBeforeEnd.filter((s) => s.name === 'llm.client.call'),
    ).toHaveLength(0);

    // The "facade" now ends the span.
    callerSpan.end();

    const spans = exporter.getFinishedSpans();
    const rootSpans = spans.filter((s) => s.name === 'llm.client.call');
    // Exactly ONE root span named `llm.client.call` — the one the
    // caller opened. If the router had opened a sibling we would see
    // two here.
    expect(rootSpans).toHaveLength(1);

    const rootSpan = rootSpans[0]!;
    // Open-time attrs (stamped by the caller) preserved.
    expect(rootSpan.attributes['llm.origin']).toBe('caption-refine');
    expect(rootSpan.attributes['user.id_hash']).toBe(hashUserId('u-fwd-1'));
    expect(rootSpan.attributes['trace.idempotency_key_hash']).toBe(
      'f'.repeat(64),
    );

    // Close-time attrs (stamped by the router onto the shared span).
    expect(rootSpan.attributes['llm.provider']).toBe('anthropic');
    expect(rootSpan.attributes['llm.model']).toBe('claude-sonnet-4-6');
    expect(rootSpan.attributes['llm.input_tokens']).toBe(10);
    expect(rootSpan.attributes['llm.output_tokens']).toBe(4);
    expect(rootSpan.attributes['llm.funding_mode']).toBe('byok');
    expect(rootSpan.attributes['llm.circuit_state']).toBe('closed');
    expect(typeof rootSpan.attributes['llm.latency_ms']).toBe('number');
    expect(rootSpan.status.code).toBe(SpanStatusCode.OK);
  });

  it('forward-compat — does NOT end the reused span (caller keeps ownership)', async () => {
    // Arrange — open a caller span and track whether anyone ends it.
    const facadeTracer = tracerProvider.getTracer('facade-test');
    const callerSpan = facadeTracer.startSpan('llm.client.call', {
      kind: SpanKind.CLIENT,
      attributes: {
        'llm.origin': 'caption-refine',
        'user.id_hash': hashUserId('u-fwd-2'),
      },
    });
    const originalEnd = callerSpan.end.bind(callerSpan);
    let endCallCount = 0;
    callerSpan.end = ((...args: Parameters<typeof originalEnd>) => {
      endCallCount += 1;
      return originalEnd(...args);
    }) as typeof callerSpan.end;

    resolver.enqueueByokSuccess('sk-fwd-2', 'anthropic');
    provider.enqueueSuccess();

    await context.with(
      trace.setSpan(context.active(), callerSpan),
      () =>
        routeWith({
          user: {
            userId: 'u-fwd-2',
            plan: 'free',
            llmKeyProvider: 'anthropic',
            llmKeyStatus: 'active',
          },
          request: baseRequest(),
          correlationId: DEFAULT_CORR_ID,
          origin: DEFAULT_ORIGIN,
        }),
    );

    // After route() returned, the router must NOT have ended the span
    // (it doesn't own it). The caller will end it later.
    expect(endCallCount).toBe(0);
    // And the exporter has not received it yet.
    expect(
      exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'llm.client.call'),
    ).toHaveLength(0);

    // The caller ends the span exactly once — symmetric with the
    // facade's own `finally { span.end() }`.
    callerSpan.end();
    expect(endCallCount).toBe(1);
    expect(
      exporter
        .getFinishedSpans()
        .filter((s) => s.name === 'llm.client.call'),
    ).toHaveLength(1);
  });
  });
});

// ─── iter 7 commit 4 — accounting wiring (§4.2 matrix) ────────────────
//
// One row per wire-touching attempt per the signed matrix. Billable
// kinds record a 0/0-token row; pre-call rejects record no row. CB
// deny and router-minted `internal` skip recording because the wire
// was never touched. A BYOK→Managed fallback emits TWO rows (except
// when `invalid_key` triggers it — `invalid_key` is never billable).

describe('PlanRouter — iter 7 commit 4 — accounting wiring (§4.2 matrix)', () => {
  let provider: FakeProvider;
  let resolver: FakeResolver;
  let consent: FakeConsentResolver;
  let usage: FakeUsageRecorder;
  let metrics: InMemoryMetrics;
  let exporter: InMemorySpanExporter;
  let tracerProvider: BasicTracerProvider;

  beforeEach(() => {
    provider = new FakeProvider('anthropic');
    resolver = new FakeResolver();
    consent = new FakeConsentResolver();
    usage = new FakeUsageRecorder();
    metrics = new InMemoryMetrics();
    exporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    setTracer(tracerProvider.getTracer('plan-router-commit4-test'));
  });

  afterEach(async () => {
    resetTracer();
    exporter.reset();
    await tracerProvider.shutdown();
  });

  function buildForCommit4(): PlanRouter {
    return buildRouter(provider, resolver, closedBreaker(), metrics, undefined, {
      consentResolver: consent,
      usageRecorder: usage,
      usageClock: (): Date => new Date(TEST_USAGE_CLOCK_MS),
    });
  }

  function expectedPromptHash(request: NormalizedLLMRequest): string {
    // Mirrors what the router computes — single call to the signed
    // canonicaliser. If the two drift, this helper flags it.
    return hashNormalizedRequest(request);
  }

  it('Free BYOK happy path — 1 row, real tokens, consentMode=full, kekVersion forwarded, promptHash + traceId stamped', async () => {
    consent.setDefault('full');
    resolver.enqueueByokSuccess('sk-byok-1', 'anthropic', 7);
    provider.enqueueSuccess({
      usage: { inputTokens: 42, outputTokens: 13, totalTokens: 55 },
    });
    const router = buildForCommit4();

    const req = baseRequest();
    const res = await router.route({
      user: {
        userId: 'u-c4-1',
        plan: 'free',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      request: req,
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(true);

    expect(usage.recorded).toHaveLength(1);
    const entry = usage.recorded[0]!;
    expect(entry.userId).toBe('u-c4-1');
    expect(entry.provider).toBe('anthropic');
    expect(entry.model).toBe(req.model);
    expect(entry.fundingMode).toBe('byok');
    expect(entry.origin).toBe(DEFAULT_ORIGIN);
    expect(entry.inputTokens).toBe(42);
    expect(entry.outputTokens).toBe(13);
    expect(entry.consentMode).toBe('full');
    expect(entry.kekVersion).toBe(7);
    expect(entry.promptHash).toBe(expectedPromptHash(req));
    expect(entry.promptHash).toMatch(/^[0-9a-f]{64}$/);
    expect(entry.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(entry.occurredAt.getTime()).toBe(TEST_USAGE_CLOCK_MS);
    expect(typeof entry.latencyMs).toBe('number');
    expect(entry.latencyMs).toBeGreaterThanOrEqual(0);

    // Consent was consulted exactly once for this userId.
    expect(consent.log).toEqual(['u-c4-1']);
  });

  it('Influencer Managed happy path — 1 row, fundingMode=managed, kekVersion strictly absent', async () => {
    consent.setDefault('full');
    resolver.enqueueManagedSuccess('sk-managed-1', 'anthropic');
    provider.enqueueSuccess({
      usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
    });
    const router = buildForCommit4();

    const res = await router.route({
      user: { userId: 'u-c4-2', plan: 'influencer' },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(true);

    expect(usage.recorded).toHaveLength(1);
    const entry = usage.recorded[0]!;
    expect(entry.fundingMode).toBe('managed');
    expect(entry.inputTokens).toBe(3);
    expect(entry.outputTokens).toBe(5);
    // kekVersion is STRICTLY absent (not present with undefined value)
    // — the router branches at build time under exactOptionalPropertyTypes.
    expect('kekVersion' in entry).toBe(false);
  });

  it('consentMode=minimal is threaded verbatim (writer layer does redaction)', async () => {
    consent.setDefault('minimal');
    resolver.enqueueByokSuccess('sk-min', 'anthropic');
    provider.enqueueSuccess({
      usage: { inputTokens: 99, outputTokens: 1, totalTokens: 100 },
    });
    const router = buildForCommit4();

    const res = await router.route({
      user: {
        userId: 'u-c4-3',
        plan: 'free',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(true);

    expect(usage.recorded).toHaveLength(1);
    const entry = usage.recorded[0]!;
    expect(entry.consentMode).toBe('minimal');
    // Real tokens — the router never redacts; that's the writer's job.
    expect(entry.inputTokens).toBe(99);
    expect(entry.outputTokens).toBe(1);
  });

  it('Free BYOK rate_limit — 1 row, 0/0 tokens, kekVersion still present (wire WAS touched)', async () => {
    consent.setDefault('full');
    resolver.enqueueByokSuccess('sk-rl', 'anthropic', 11);
    provider.enqueueError(make.rateLimit('anthropic'));
    const router = buildForCommit4();

    const res = await router.route({
      user: {
        userId: 'u-c4-4',
        plan: 'free',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(false);

    expect(usage.recorded).toHaveLength(1);
    const entry = usage.recorded[0]!;
    expect(entry.inputTokens).toBe(0);
    expect(entry.outputTokens).toBe(0);
    expect(entry.fundingMode).toBe('byok');
    expect(entry.kekVersion).toBe(11);
  });

  it('Managed provider_down — 1 row, 0/0, fundingMode=managed', async () => {
    consent.setDefault('full');
    resolver.enqueueManagedSuccess('sk-down', 'anthropic');
    provider.enqueueError(make.providerDown('anthropic', false));
    const router = buildForCommit4();

    const res = await router.route({
      user: { userId: 'u-c4-5', plan: 'influencer' },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(false);

    expect(usage.recorded).toHaveLength(1);
    const entry = usage.recorded[0]!;
    expect(entry.inputTokens).toBe(0);
    expect(entry.outputTokens).toBe(0);
    expect(entry.fundingMode).toBe('managed');
    expect('kekVersion' in entry).toBe(false);
  });

  it('Free BYOK invalid_key — NO row (pre-call reject per §4.2)', async () => {
    consent.setDefault('full');
    resolver.enqueueByokSuccess('sk-bad', 'anthropic', 3);
    provider.enqueueError(make.invalidKey('anthropic'));
    const router = buildForCommit4();

    const res = await router.route({
      user: {
        userId: 'u-c4-6',
        plan: 'free',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(false);
    // Free/Creator maps invalid_key to plan_requires_key for UI
    // clarity — either way, invalid_key is NOT billable.
    expect(usage.recorded).toHaveLength(0);
  });

  it('plan_requires_key (no key on file) — NO row; resolver + provider never consulted; consent IS resolved (overlap)', async () => {
    consent.setDefault('full');
    const router = buildForCommit4();

    const res = await router.route({
      user: { userId: 'u-c4-7', plan: 'free' },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(false);

    expect(usage.recorded).toHaveLength(0);
    expect(provider.callLog).toHaveLength(0);
    expect(resolver.log).toHaveLength(0);
    // Consent WAS resolved — it's kicked off in parallel before the
    // unregistered-provider short-circuit and awaited after. The
    // plan_requires_key path is downstream of that await.
    expect(consent.log).toEqual(['u-c4-7']);
  });

  it('CB deny — NO row, provider.call never attempted', async () => {
    consent.setDefault('full');
    resolver.enqueueByokSuccess('sk-cb', 'anthropic');
    const router = buildRouter(
      provider,
      resolver,
      openBreaker(),
      metrics,
      undefined,
      {
        consentResolver: consent,
        usageRecorder: usage,
        usageClock: (): Date => new Date(TEST_USAGE_CLOCK_MS),
      },
    );

    const res = await router.route({
      user: {
        userId: 'u-c4-8',
        plan: 'free',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(false);
    expect(usage.recorded).toHaveLength(0);
    expect(provider.callLog).toHaveLength(0);
  });

  it('Unregistered provider — router-minted internal — NO row', async () => {
    consent.setDefault('full');
    const router = createPlanRouter({
      providers: emptyRegistry(),
      resolver,
      breaker: closedBreaker(),
      flags: flags(),
      metrics,
      consentResolver: consent,
      usageRecorder: usage,
      usageClock: (): Date => new Date(TEST_USAGE_CLOCK_MS),
    });

    const res = await router.route({
      user: { userId: 'u-c4-9', plan: 'influencer' },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(false);
    expect(usage.recorded).toHaveLength(0);
  });

  it('Fallback: BYOK quota_exhausted + Managed success → 2 rows (BYOK 0/0, Managed real); shared traceId + promptHash + consentMode', async () => {
    consent.setDefault('full');
    resolver.enqueueByokSuccess('sk-qe', 'anthropic', 9);
    provider.enqueueError(make.quotaExhausted('anthropic'));
    resolver.enqueueManagedSuccess('sk-managed-fb', 'anthropic');
    provider.enqueueSuccess({
      usage: { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
    });
    const router = buildForCommit4();

    const req = baseRequest();
    const res = await router.route({
      user: {
        userId: 'u-c4-10',
        plan: 'influencer',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
        llmPreferMyKey: true,
      },
      request: req,
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(true);

    expect(usage.recorded).toHaveLength(2);
    const [byokRow, managedRow] = usage.recorded;

    // BYOK attempt: 0/0 + kekVersion (wire was touched).
    expect(byokRow ! .fundingMode).toBe('byok');
    expect(byokRow ! .inputTokens).toBe(0);
    expect(byokRow ! .outputTokens).toBe(0);
    expect(byokRow ! .kekVersion).toBe(9);

    // Managed attempt: real tokens, no kekVersion.
    expect(managedRow ! .fundingMode).toBe('managed');
    expect(managedRow ! .inputTokens).toBe(12);
    expect(managedRow ! .outputTokens).toBe(3);
    expect('kekVersion' in managedRow ! ).toBe(false);

    // Shared identity across both attempts of ONE logical .call().
    expect(byokRow ! .traceId).toBe(managedRow ! .traceId);
    expect(byokRow ! .promptHash).toBe(managedRow ! .promptHash);
    expect(byokRow ! .promptHash).toBe(expectedPromptHash(req));
    expect(byokRow ! .consentMode).toBe('full');
    expect(managedRow ! .consentMode).toBe('full');

    // Consent was resolved exactly once for the .call().
    expect(consent.log).toEqual(['u-c4-10']);
  });

  it('Fallback: BYOK invalid_key + Managed success → 1 row (Managed only); invalid_key is never billable', async () => {
    consent.setDefault('full');
    resolver.enqueueByokSuccess('sk-bad-fb', 'anthropic', 4);
    provider.enqueueError(make.invalidKey('anthropic'));
    resolver.enqueueManagedSuccess('sk-managed-rescue', 'anthropic');
    provider.enqueueSuccess({
      usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 },
    });
    const router = buildForCommit4();

    const res = await router.route({
      user: {
        userId: 'u-c4-11',
        plan: 'influencer',
        llmKeyProvider: 'anthropic',
        llmKeyStatus: 'active',
        llmPreferMyKey: true,
      },
      request: baseRequest(),
      correlationId: DEFAULT_CORR_ID,
      origin: DEFAULT_ORIGIN,
    });
    expect(res.ok).toBe(true);

    // Only ONE row — the Managed one. BYOK invalid_key is pre-call
    // per §4.2 even on the fallback path.
    expect(usage.recorded).toHaveLength(1);
    const entry = usage.recorded[0]!;
    expect(entry.fundingMode).toBe('managed');
    expect(entry.inputTokens).toBe(7);
    expect(entry.outputTokens).toBe(2);
    expect('kekVersion' in entry).toBe(false);
  });
});
