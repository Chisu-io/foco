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

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type FlagsReader,
  FLAG_DEFAULTS,
  createStaticFlagsReader,
} from '../../src/config/index.js';
import { make, type LLMCallError } from '../../src/errors/taxonomy.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';
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

function buildRouter(
  provider: FakeProvider,
  resolver: FakeResolver,
  breaker: CircuitBreaker,
  metrics: InMemoryMetrics,
  onByokKeyInvalidated?: (args: {
    readonly userId: string;
    readonly provider: ProviderName;
  }) => void,
): PlanRouter {
  return createPlanRouter({
    providers: registryFor(provider),
    resolver,
    breaker,
    flags: flags(),
    metrics,
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
