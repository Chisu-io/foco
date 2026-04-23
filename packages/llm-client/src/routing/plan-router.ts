/**
 * Plan-aware router for `@chisu/llm-client`.
 *
 * Implements the decision matrix of
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` §4.1 + §4.2 + §4.3}:
 *
 *  - **Free / Creator** → BYOK required. No Managed fallback. The
 *    user's key must match the request model's provider family; if
 *    not, the router returns `plan_requires_key` with an extended
 *    user-facing message (the UI guides them to Settings →
 *    Integraciones).
 *  - **Influencer / Celebrity** → Managed primary. If the user has
 *    opted into `preferMyKey=true` AND their stored key is `active`,
 *    try BYOK first; on any transient-per-key BYOK error —
 *    `invalid_key`, `quota_exhausted`, `rate_limit`, `network_error` —
 *    fall back to Managed (per Ajuste 6 firmado 2026-04-18 + review
 *    2026-04-19). `rate_limit` is per-key by design in
 *    Anthropic/OpenAI/Gemini (bucket lives on the API key, not on the
 *    provider), so a Managed key has an independent bucket. A fresh
 *    `network_error` retry via the Managed pool may resolve via a
 *    different DNS/keepalive path. Only `provider_down` (shared
 *    infrastructure) and resolver/infra failures are NOT fallbacked
 *    — the per-provider circuit breaker of §4.2 already covers
 *    `provider_down` upstream, so adding Managed fallback there is
 *    redundant; the breaker's `deny_open` decision will short-circuit
 *    any downstream call anyway. The invalidation callback
 *    (`onByokKeyInvalidated`) fires ONLY on `invalid_key` — the
 *    user's key really is bad; the other fallback triggers are
 *    transient or per-call and leave the key row untouched.
 *  - **Studio** → Managed. Alternate-pool rotation is a later iter
 *    (§4.1 "Studio" footnote) — the router keeps a seam for it (see
 *    the `onByokKeyInvalidated` / `observeFallbackUsed` metric) but
 *    does not rotate in iter 4.
 *
 * Per-provider circuit-breaker calls are short-circuited with
 * `provider_down { circuitOpen: true }` so the caller never pays the
 * HTTP latency of a call we already know will fail.
 *
 * Invariants (§3.5, §9.4):
 *  - Never throws. Every path resolves to
 *    `Result<RouterCallOutput, LLMCallError>`.
 *  - Does not log key material or request bodies. Only records plan,
 *    provider, funding mode, outcome on the metric sink.
 *  - `providerHint` is informational only for MVP — the 1:1 model →
 *    provider map leaves no routing degree of freedom to respect it.
 *
 * **Iter 7 commit 4 additions (accounting wiring — §4.1 + §4.2):**
 *
 *  The router consumes the `ConsentResolver` (reader) and
 *  `UsageRecorder` (writer) seams introduced in iter 7 commits 2 and
 *  3. Every `.call()` emits ONE `UsageEntry` per wire-touching attempt
 *  per the signed §4.2 matrix — billable kinds (`rate_limit`,
 *  `quota_exhausted`, `provider_down`, `content_blocked`,
 *  `network_error`, `internal`) record a 0/0-token row; pre-call
 *  rejects (`invalid_key`, `context_too_long`, `kms_unavailable`,
 *  `routing_disabled`, `plan_requires_key`) record NO row. CB deny,
 *  router-minted `internal` from an unregistered provider, and
 *  router-resolver failures never touch the wire → no row. Consent +
 *  `promptHash` + `traceId` are computed once per `.call()` and
 *  shared across the two attempts of a BYOK→Managed fallback so
 *  abuse-detection sees one logical call across two rows.
 */

import {
  context,
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
} from '@opentelemetry/api';

import {
  hashNormalizedRequest,
  type ConsentResolver,
  type UsageEntry,
  type UsageRecorder,
} from '../accounting/index.js';
import { make, type LLMCallError } from '../errors/taxonomy.js';
import { getTracer, hashUserId } from '../observability/tracing.js';
import { type Result, err, ok } from '../types.js';
import { classifyOutcomeForBreaker, type OriginKind } from './events.js';

import type { CircuitBreaker } from './circuit-breaker.js';
import type { FlagsReader } from '../config/flag-reader.js';
import type { Metrics } from '../observability/metrics.js';
import type { Provider, ProviderName } from '../providers/provider.js';
import type { ConsentMode } from '../types/repos.js';
import type { ModelId, NormalizedLLMRequest } from '../types/request.js';
import type { PingOutput, ProviderCallOutput } from '../types/response.js';


/**
 * Plan tiers in Foco. Kept as a local literal so this module does
 * not import from `@chisu/schemas` (the pricing package lands in a
 * later integration step). Widen together with the pricing package
 * if a tier is added.
 */
export type Plan = 'free' | 'creator' | 'influencer' | 'celebrity' | 'studio';

/**
 * Stored status of a user's BYOK key. Mirrors
 * `user_llm_key.status` from §12 of the contract.
 *
 *  - `active`          — last ping returned 200.
 *  - `pending`         — user saved a key but the cron has not yet
 *                        validated it.
 *  - `invalid`         — a call returned `invalid_key` or the 24h
 *                        cron got 401/403.
 *  - `quota_exhausted` — provider signalled billing/quota.
 *  - `unset`           — user has no key on file.
 */
export type BYOKStatus =
  | 'active'
  | 'pending'
  | 'invalid'
  | 'quota_exhausted'
  | 'unset';

/**
 * Subset of `UserQuota` the router needs. Intentionally tighter than
 * §12's full row so deep joins and denormalisation never leak into
 * routing.
 */
export interface UserQuota {
  readonly userId: string;
  readonly plan: Plan;
  /**
   * Provider of the user's stored BYOK key, if any. `undefined` when
   * they have not configured a key.
   */
  readonly llmKeyProvider?: ProviderName | undefined;
  readonly llmKeyStatus?: BYOKStatus | undefined;
  /** Influencer+ opt-in to route BYOK before Managed. */
  readonly llmPreferMyKey?: boolean | undefined;
}

/**
 * Resolved API key returned by `ApiKeyResolver`. The `mode`
 * discriminant tells the router which budget / metric bucket to
 * attribute the call to.
 */
export interface ResolvedKey {
  readonly apiKey: string;
  readonly provider: ProviderName;
  readonly mode: 'byok' | 'managed';
  /**
   * KEK version of the envelope that produced this DEK. Populated
   * only for BYOK-decrypted keys. Iter 6 consumes it for the
   * `kek_version` label on `llm_kms_latency_ms`; iter 4 just
   * forwards it opaquely.
   */
  readonly kekVersion?: number | undefined;
}

/** Parameters for `ApiKeyResolver.resolve`. */
export type ApiKeyRequest =
  | {
      readonly mode: 'byok';
      readonly userId: string;
      readonly provider: ProviderName;
      readonly abortSignal?: AbortSignal | undefined;
    }
  | {
      readonly mode: 'managed';
      readonly provider: ProviderName;
      readonly abortSignal?: AbortSignal | undefined;
    };

/**
 * Resolves an API key for the requested provider + funding mode.
 *
 * Iter 4 only uses the interface; the concrete implementations land
 * in iteration 5 (Managed pool rotation, envelope.unwrap for BYOK).
 * Modelled as `Result<_, LLMCallError>` so the router never has to
 * convert exceptions into its own error space.
 */
export interface ApiKeyResolver {
  resolve(
    req: ApiKeyRequest,
  ): Promise<Result<ResolvedKey, LLMCallError>>;
}

/** Read-only lookup from `ProviderName` to a configured `Provider`. */
export interface ProviderRegistry {
  get(name: ProviderName): Provider | undefined;
}

/** Dependencies of `createPlanRouter`. */
export interface PlanRouterDeps {
  readonly providers: ProviderRegistry;
  readonly resolver: ApiKeyResolver;
  readonly breaker: CircuitBreaker;
  readonly flags: FlagsReader;
  readonly metrics: Metrics;
  /**
   * Consent-mode reader (iter 7 commit 2 seam). Consulted once per
   * `.call()` AFTER the unregistered-provider short-circuit so a
   * deployment misconfiguration still returns `internal` without
   * paying a consent round-trip. Non-throwing by contract (§8
   * decisión firmada #8 — failures degrade to `'minimal'` inside
   * the resolver).
   */
  readonly consentResolver: ConsentResolver;
  /**
   * Usage writer (iter 7 commit 3 seam). Called once per
   * wire-touching attempt per §4.2. The router never awaits
   * `usageRecorder.flush()` — that is the iter 8 facade's job on the
   * 10 s timer.
   */
  readonly usageRecorder: UsageRecorder;
  /**
   * Clock used to stamp `UsageEntry.occurredAt`. Defaults to
   * `() => new Date()`. Tests pin it for deterministic assertions.
   */
  readonly usageClock?: (() => Date) | undefined;
  /**
   * Invoked when a BYOK call returns `invalid_key` and the router
   * decides to fall back to Managed (Influencer+ `preferMyKey`) or
   * to surface `plan_requires_key` (Free/Creator). Iter 4 stubs the
   * side-effect; iter 5 wires it to a DB `UPDATE user_llm_key SET
   * status='invalid'` + an async transactional email.
   *
   * Must not throw. The router does not await this callback; it is
   * invoked synchronously and any async bookkeeping is the
   * implementation's responsibility.
   */
  readonly onByokKeyInvalidated?:
    | ((args: {
        readonly userId: string;
        readonly provider: ProviderName;
      }) => void)
    | undefined;
  /** Clock override for tests. */
  readonly now?: (() => number) | undefined;
}

/**
 * Full input to `PlanRouter.route` (§3.3 minus keys).
 *
 * **Iter 6 commit 2 additions (P1, P10, commit-2 design §3):**
 *
 *  - `correlationId` (required) — identity threaded into every outbound
 *    trace header (Anthropic `anthropic-trace-id`, OpenAI
 *    `X-Request-ID`; Gemini omits) and into the `internal` error
 *    minted when a supported model maps to an unregistered provider
 *    (P10 — no more ad-hoc `newCorrelationId()` per call site). Iter 6
 *    commit 3 will also use it to open the router's root span.
 *  - `origin` (required) — producer-surface label that flows into
 *    span attributes + audit without leaking request content. Must be
 *    one of the {@link OriginKind} literals.
 *
 *  Note on `deadline` + `idempotencyKey`: both live on
 *  `ProviderCallContext` (see `./events.ts`) and are populated by
 *  `LLMClient.call()` in iter 7. They do **not** yet appear on
 *  `RouteInput` because commit 2 only threads correlation id through
 *  the wire; deadline propagation is commit 5's scope.
 */
export interface RouteInput {
  readonly user: UserQuota;
  readonly request: NormalizedLLMRequest;
  readonly providerHint?: ProviderName | undefined;
  readonly abortSignal?: AbortSignal | undefined;
  /**
   * Trace / correlation id minted by `LLMClient.call()` (iter 7) or
   * supplied by the caller. Required — there is no routing path that
   * should run without an identity.
   */
  readonly correlationId: string;
  /**
   * Producer surface invoking the router. Flows into span attributes
   * + audit logs. Required — every Foco call path knows which
   * surface it is.
   */
  readonly origin: OriginKind;
}

/**
 * Return shape of `PlanRouter.route`.
 *
 * Extends `ProviderCallOutput` with the routing-resolved `fundingMode`.
 * The orchestrator in iteration 7 wraps this with `latencyMs` (and
 * anything else it owns) to produce the contract-facing
 * `LLMCallOutput`.
 */
export interface RouterCallOutput extends ProviderCallOutput {
  readonly fundingMode: 'byok' | 'managed';
}


/**
 * Input to `PlanRouter.ping` — healthcheck / BYOK key validation
 * (iter 9 c4, `LLM_CLIENT.md §18.5`). Tighter than `RouteInput`:
 *
 *  - No `request`: `Provider.ping` synthesises its own 1-token probe.
 *  - No `origin` + no accounting: ping is non-billable (§4.2).
 *  - `provider` is explicit: ping is provider-scoped by design (you
 *    ping "anthropic" to validate your anthropic key, not a model).
 *  - `fundingMode` is explicit: the facade decides based on the plan
 *    + the user's BYOK state, not the router. Router honours the
 *    caller's choice verbatim.
 */
export interface RoutePingInput {
  readonly user: UserQuota;
  readonly provider: ProviderName;
  readonly fundingMode: 'byok' | 'managed';
  readonly correlationId: string;
  readonly abortSignal?: AbortSignal | undefined;
}
/** Public surface of the router. */
export interface PlanRouter {
  route(
    input: RouteInput,
  ): Promise<Result<RouterCallOutput, LLMCallError>>;
  /**
   * Provider-scoped healthcheck / BYOK key validation. Added iter 9
   * c4 (§18.5). Resolves the key for `input.provider` under
   * `input.fundingMode`, gates through the circuit breaker, and
   * delegates to `Provider.ping`. Never emits a `UsageEntry`
   * (non-wire-billable per §4.2) but DOES record CB outcome so a
   * degraded provider still opens the breaker.
   */
  ping(
    input: RoutePingInput,
  ): Promise<Result<PingOutput, LLMCallError>>;
}

/** Metric names emitted by the router. */
export const ROUTER_METRIC_NAMES = Object.freeze({
  requests: 'llm_router_requests_total',
  fallbacks: 'llm_router_fallbacks_total',
  resolveFailures: 'llm_router_resolve_failures_total',
  cbDenies: 'llm_router_cb_denies_total',
});

/**
 * Map a `ModelId` to its serving provider. 1:1 in the MVP; widen the
 * switch together with `ModelId` if a new provider joins.
 */
export function providerForModel(model: ModelId): ProviderName {
  switch (model) {
    case 'claude-opus-4-6':
    case 'claude-sonnet-4-6':
    case 'claude-haiku-4-5':
      return 'anthropic';
    case 'gpt-5':
    case 'gpt-5-mini':
      return 'openai';
    case 'gemini-2.5-pro':
    case 'gemini-2.5-flash':
      return 'gemini';
    default:
      return assertNeverModel(model);
  }
}

/**
 * §4.2 accounting matrix — which `LLMCallError` kinds record a
 * billable `UsageEntry` and which do not.
 *
 *  - **record (billable)**: `rate_limit`, `quota_exhausted`,
 *    `provider_down`, `content_blocked`, `network_error`, `internal`.
 *    These all imply the wire WAS touched (or, for `internal`, that a
 *    real call produced an unexpected shape — which we attribute).
 *  - **skip (pre-call reject)**: `invalid_key`, `context_too_long`,
 *    `kms_unavailable`, `routing_disabled`, `plan_requires_key`.
 *    These are user-environment errors that we rejected BEFORE the
 *    wire call — no billable work was done.
 *
 * Paired with {@link assertNeverErrorKind} for exhaustiveness:
 * widening the `LLMCallError` taxonomy fails typecheck at this switch,
 * so the matrix never silently drifts.
 */
export function shouldRecordError(kind: LLMCallError['kind']): boolean {
  switch (kind) {
    case 'rate_limit':
    case 'quota_exhausted':
    case 'provider_down':
    case 'content_blocked':
    case 'network_error':
    case 'internal':
      return true;
    case 'invalid_key':
    case 'context_too_long':
    case 'kms_unavailable':
    case 'routing_disabled':
    case 'plan_requires_key':
      return false;
    default:
      return assertNeverErrorKind(kind);
  }
}

/**
 * Per-`.call()` accounting context threaded through the router.
 *
 * Computed once in `route()` and forwarded verbatim into
 * `routeByokOnly` / `routeManagedWithOptionalByok` / `doProviderCall`.
 * The two attempts of a BYOK→Managed fallback share the same
 * `AccountingCtx` — that is the signal that they are attempts of ONE
 * logical `.call()` in downstream abuse-detection (§4.2 + §4.3).
 */
interface AccountingCtx {
  readonly userId: string;
  readonly origin: OriginKind;
  readonly consentMode: ConsentMode;
  readonly promptHash: string;
  readonly traceId: string;
}

/**
 * Extended user-facing message when a Free/Creator BYOK key belongs
 * to a provider that cannot serve the requested model.
 */
function mismatchMessage(
  requiredProvider: ProviderName,
  currentProvider: ProviderName,
): string {
  return (
    `To use this model you need a ${capitalize(requiredProvider)} API key. ` +
    `Your current key is for ${capitalize(currentProvider)} — add or ` +
    `switch providers in Settings → Integrations.`
  );
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s.charAt(0).toUpperCase() + s.slice(1);
}

export function createPlanRouter(deps: PlanRouterDeps): PlanRouter {
  const {
    providers,
    resolver,
    breaker,
    metrics,
    consentResolver,
    usageRecorder,
    onByokKeyInvalidated,
  } = deps;
  const usageClock = deps.usageClock ?? ((): Date => new Date());

  /**
   * Centralised `UsageRecorder.record` call so all fields of
   * `UsageEntry` are stamped from the same source of truth.
   *
   * `kekVersion` is attached conditionally — TS
   * `exactOptionalPropertyTypes` makes `{ kekVersion: undefined }` a
   * structurally different type from `{}`, so we branch at build
   * time.
   */
  function recordUsage(args: {
    readonly ctx: AccountingCtx;
    readonly provider: ProviderName;
    readonly model: ModelId;
    readonly fundingMode: 'byok' | 'managed';
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly latencyMs: number;
    readonly kekVersion?: number | undefined;
  }): void {
    const base: UsageEntry = {
      userId: args.ctx.userId,
      occurredAt: usageClock(),
      provider: args.provider,
      model: args.model,
      fundingMode: args.fundingMode,
      origin: args.ctx.origin,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      latencyMs: args.latencyMs,
      traceId: args.ctx.traceId,
      consentMode: args.ctx.consentMode,
      promptHash: args.ctx.promptHash,
      ...(args.kekVersion !== undefined ? { kekVersion: args.kekVersion } : {}),
    };
    // Fire-and-forget — the recorder is non-throwing by contract.
    // Swallowing the Promise here is intentional: the router must
    // not block on DB / buffer state.
    void usageRecorder.record(base);
  }

  async function doProviderCall(
    resolved: ResolvedKey,
    provider: Provider,
    request: NormalizedLLMRequest,
    abortSignal: AbortSignal | undefined,
    correlationId: string,
    accountingCtx: AccountingCtx,
  ): Promise<Result<RouterCallOutput, LLMCallError>> {
    const decision = breaker.isCallAllowed(provider.name);
    if (decision === 'deny_open' || decision === 'deny_probes_exhausted') {
      metrics.counter(ROUTER_METRIC_NAMES.cbDenies, {
        provider: provider.name,
        decision,
      });
      // Iter 6 commit 3 (§10.1): breaker-deny does NOT open a
      // `llm.provider.request` span. The outbound HTTP never happens, so
      // there is nothing to observe at the provider layer. The root
      // `llm.client.call` span reflects the denial via
      // `llm.circuit_state` at close-error.
      //
      // Iter 7 commit 4 (§4.2): no `UsageEntry` either — the wire
      // was never touched. `provider_down { circuitOpen: true }` is
      // a billable kind on wire-touching attempts but here the CB
      // short-circuits BEFORE the wire, so no row.
      return err(make.providerDown(provider.name, true));
    }

    // Iter 6 commit 3 (§10.1): open a CLIENT sub-span around the
    // outbound provider call. Initial attributes are `llm.provider`
    // + `llm.model`; token counts and status land at close. No
    // `recordException` — `provider.call(...)` returns
    // `Result<_, LLMCallError>` and LLMCallError is a tagged union, not
    // an Error instance. Status is set manually on the Result branch.
    const tracer = getTracer();
    const subSpan = tracer.startSpan('llm.provider.request', {
      kind: SpanKind.CLIENT,
      attributes: {
        'llm.provider': provider.name,
        'llm.model': request.model,
      },
    });

    // Iter 7 commit 4 (§5.3): per-attempt latency. Measured around
    // `provider.call(...)` so two fallback attempts emit two
    // independent `UsageEntry.latencyMs` values. Intentionally
    // distinct from the root span's `llm.latency_ms` which is the
    // `.call()` total.
    const callStartHrMs = performance.now();

    try {
      // Iter 6 commit 2 (P1, P11): `correlationId` is threaded into the
      // adapter so Anthropic + OpenAI can stamp their trace header. See
      // `provider.ts` → `ProviderCallInput.correlationId`. The breaker
      // call above does NOT receive it — breaker state is provider-wide
      // and correlation-agnostic by design (iter 4 invariant).
      const callResult = await provider.call({
        apiKey: resolved.apiKey,
        request,
        correlationId,
        ...(abortSignal !== undefined ? { abortSignal } : {}),
      });

      const attemptLatencyMs = Math.round(performance.now() - callStartHrMs);

      if (callResult.ok) {
        subSpan.setAttribute(
          'llm.input_tokens',
          callResult.value.usage.inputTokens,
        );
        subSpan.setAttribute(
          'llm.output_tokens',
          callResult.value.usage.outputTokens,
        );
        subSpan.setStatus({ code: SpanStatusCode.OK });
        breaker.record(provider.name, 'success');

        // Iter 7 commit 4 (§4.2): record the successful attempt with
        // real token counts. KEK version forwarded on BYOK rows only.
        recordUsage({
          ctx: accountingCtx,
          provider: callResult.value.providerUsed,
          model: request.model,
          fundingMode: resolved.mode,
          inputTokens: callResult.value.usage.inputTokens,
          outputTokens: callResult.value.usage.outputTokens,
          latencyMs: attemptLatencyMs,
          ...(resolved.mode === 'byok' && resolved.kekVersion !== undefined
            ? { kekVersion: resolved.kekVersion }
            : {}),
        });

        return ok({ ...callResult.value, fundingMode: resolved.mode });
      }

      subSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: callResult.error.kind,
      });
      breaker.record(
        provider.name,
        classifyOutcomeForBreaker(callResult.error),
      );

      // Iter 7 commit 4 (§4.2): record billable errors only. 0/0
      // tokens — the wire was touched but no content exchanged. KEK
      // version stays on BYOK error rows because the key WAS used to
      // produce the failed call.
      if (shouldRecordError(callResult.error.kind)) {
        recordUsage({
          ctx: accountingCtx,
          provider: provider.name,
          model: request.model,
          fundingMode: resolved.mode,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: attemptLatencyMs,
          ...(resolved.mode === 'byok' && resolved.kekVersion !== undefined
            ? { kekVersion: resolved.kekVersion }
            : {}),
        });
      }

      return err(callResult.error);
    } finally {
      subSpan.end();
    }
  }

  /**
   * Path 1: Free / Creator. BYOK is mandatory; no Managed fallback.
   *
   * Ordering:
   *  1. User has no key → `plan_requires_key`.
   *  2. Key provider does not match the request model's provider →
   *     `plan_requires_key` with an extended message.
   *  3. Key status is not `active` → `plan_requires_key`.
   *  4. Resolve key → call provider → classify failures. If the
   *     provider returns `invalid_key`, fire the invalidation
   *     callback so iter 5 can mark the key row as invalid and notify
   *     the user.
   */
  async function routeByokOnly(
    input: RouteInput,
    requiredProvider: ProviderName,
    provider: Provider,
    accountingCtx: AccountingCtx,
  ): Promise<Result<RouterCallOutput, LLMCallError>> {
    const { user, request } = input;
    const plan = user.plan as 'free' | 'creator';

    if (
      user.llmKeyProvider === undefined ||
      user.llmKeyStatus === undefined ||
      user.llmKeyStatus === 'unset'
    ) {
      metrics.counter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan,
        reason: 'no_key',
      });
      return err(make.planRequiresKey(plan));
    }

    if (user.llmKeyProvider !== requiredProvider) {
      // Provider mismatch — user has an Anthropic BYOK but requested
      // a GPT model (or vice versa). The taxonomy's
      // `plan_requires_key` variant carries only `{ kind, plan }`; the
      // UI looks up the extended message via `routingMismatchUserMessage`
      // so this module stays verbatim with §3.5.
      metrics.counter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan,
        reason: 'provider_mismatch',
      });
      return err(make.planRequiresKey(plan));
    }

    if (user.llmKeyStatus !== 'active' && user.llmKeyStatus !== 'pending') {
      metrics.counter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan,
        reason: `key_status_${user.llmKeyStatus}`,
      });
      return err(make.planRequiresKey(plan));
    }

    const resolvedResult = await resolver.resolve({
      mode: 'byok',
      userId: user.userId,
      provider: requiredProvider,
      ...(input.abortSignal !== undefined
        ? { abortSignal: input.abortSignal }
        : {}),
    });
    if (!resolvedResult.ok) {
      metrics.counter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan,
        reason: 'resolve_error',
      });
      return err(resolvedResult.error);
    }

    const outcome = await doProviderCall(
      resolvedResult.value,
      provider,
      request,
      input.abortSignal,
      input.correlationId,
      accountingCtx,
    );

    metrics.counter(ROUTER_METRIC_NAMES.requests, {
      plan,
      provider: provider.name,
      fundingMode: 'byok',
      outcome: outcome.ok ? 'ok' : outcome.error.kind,
    });

    if (!outcome.ok && outcome.error.kind === 'invalid_key') {
      // Fire invalidation side-effect so iter 5 can mark the key row
      // as invalid + notify the user.
      onByokKeyInvalidated?.({
        userId: user.userId,
        provider: requiredProvider,
      });
      // Replace the raw BYOK error with plan_requires_key so the UI
      // sends the user to Settings → Integrations with the right
      // copy. The invalid_key's `userMessage` is also correct, but
      // on Free/Creator the mental model is "your plan requires a
      // key and yours isn't working" — so plan_requires_key is the
      // authoritative shape.
      return err(make.planRequiresKey(plan));
    }

    return outcome;
  }

  /**
   * Path 2: Influencer / Celebrity / Studio. Managed is primary.
   *
   * Influencer+ may opt into `preferMyKey`: we try BYOK first,
   * falling back to Managed on any per-key transient:
   * `invalid_key`, `quota_exhausted`, `rate_limit`, `network_error`
   * (Ajuste 6 FULL, review 2026-04-19). `provider_down` is NOT a
   * fallback trigger — the circuit breaker of §4.2 already covers
   * provider-wide outages upstream, so a Managed retry would either
   * be short-circuited by the same breaker or hit the same provider
   * regardless. Resolver / infra failures (`kms_unavailable`) are
   * surfaced — Managed uses the same KMS.
   *
   * Studio today behaves like Influencer+ with `preferMyKey=false`;
   * alternate-pool rotation is deferred to iter 7.
   */
  async function routeManagedWithOptionalByok(
    input: RouteInput,
    provider: Provider,
    accountingCtx: AccountingCtx,
  ): Promise<Result<RouterCallOutput, LLMCallError>> {
    const { user, request } = input;
    const plan = user.plan;

    const shouldTryByokFirst =
      (plan === 'influencer' || plan === 'celebrity') &&
      user.llmPreferMyKey === true &&
      user.llmKeyProvider === provider.name &&
      user.llmKeyStatus === 'active';

    if (shouldTryByokFirst) {
      const byokResolve = await resolver.resolve({
        mode: 'byok',
        userId: user.userId,
        provider: provider.name,
        ...(input.abortSignal !== undefined
          ? { abortSignal: input.abortSignal }
          : {}),
      });

      if (byokResolve.ok) {
        const byokOutcome = await doProviderCall(
          byokResolve.value,
          provider,
          request,
          input.abortSignal,
          input.correlationId,
          accountingCtx,
        );
        if (byokOutcome.ok) {
          metrics.counter(ROUTER_METRIC_NAMES.requests, {
            plan,
            provider: provider.name,
            fundingMode: 'byok',
            outcome: 'ok',
          });
          return byokOutcome;
        }

        const kind = byokOutcome.error.kind;
        // Ajuste 6 FULL (firmado 2026-04-18 + review 2026-04-19):
        // fall back to Managed on any per-key transient. `rate_limit`
        // and `network_error` are genuinely per-key — a Managed key
        // has an independent provider bucket and a fresh network
        // call may land on a different DNS/keepalive path.
        // `provider_down` is deliberately NOT here: the CB of §4.2
        // already short-circuits provider-wide outages, so forwarding
        // to Managed is redundant. Invalidation callback fires ONLY
        // on `invalid_key` — that is the only signal that the key
        // row itself needs to be marked invalid.
        const shouldFallback =
          kind === 'invalid_key' ||
          kind === 'quota_exhausted' ||
          kind === 'rate_limit' ||
          kind === 'network_error';

        if (!shouldFallback) {
          metrics.counter(ROUTER_METRIC_NAMES.requests, {
            plan,
            provider: provider.name,
            fundingMode: 'byok',
            outcome: kind,
          });
          return byokOutcome;
        }

        metrics.counter(ROUTER_METRIC_NAMES.fallbacks, {
          plan,
          provider: provider.name,
          reason: kind,
        });
        if (kind === 'invalid_key') {
          onByokKeyInvalidated?.({
            userId: user.userId,
            provider: provider.name,
          });
        }
        // Fall through to the Managed path.
      } else {
        // Resolver itself failed (e.g. kms_unavailable). Do NOT fall
        // back to Managed — the failure is infra-wide and Managed
        // will hit the same KMS. Surface it.
        metrics.counter(ROUTER_METRIC_NAMES.resolveFailures, {
          plan,
          mode: 'byok',
          reason: 'resolve_error',
        });
        return err(byokResolve.error);
      }
    }

    const managedResolve = await resolver.resolve({
      mode: 'managed',
      provider: provider.name,
      ...(input.abortSignal !== undefined
        ? { abortSignal: input.abortSignal }
        : {}),
    });
    if (!managedResolve.ok) {
      metrics.counter(ROUTER_METRIC_NAMES.resolveFailures, {
        plan,
        mode: 'managed',
        reason: 'resolve_error',
      });
      return err(managedResolve.error);
    }

    const managedOutcome = await doProviderCall(
      managedResolve.value,
      provider,
      request,
      input.abortSignal,
      input.correlationId,
      accountingCtx,
    );

    metrics.counter(ROUTER_METRIC_NAMES.requests, {
      plan,
      provider: provider.name,
      fundingMode: 'managed',
      outcome: managedOutcome.ok ? 'ok' : managedOutcome.error.kind,
    });

    return managedOutcome;
  }

  async function route(
    input: RouteInput,
  ): Promise<Result<RouterCallOutput, LLMCallError>> {
    // Iter 6 commit 3 (§10.1): open the `llm.client.call` root span.
    // We do NOT delegate to `withSpan` here because:
    //  1. `route()` never throws — it returns `Result<_, LLMCallError>`
    //     (§3.5 of the contract). `withSpan` would auto-stamp
    //     `SpanStatusCode.OK` on return, overwriting the manual
    //     `ERROR` we set on the Result.err branch (R3 of the mini-spec).
    //  2. `LLMCallError` is a tagged union, not an `Error` instance, so
    //     `recordException(...)` (also part of `withSpan`'s catch)
    //     would lie about the stack. The taxonomy is the audit trail
    //     per §14.3 — we never recordException a Result.err.
    //
    // Attribute-close contract (from the signed mini-spec):
    //  - On open: `llm.origin`, `user.id_hash`.
    //  - On close-success (seven effective attributes): `llm.provider`,
    //    `llm.model`, `llm.input_tokens`, `llm.output_tokens`,
    //    `llm.funding_mode` (DERIVED from the routing result per R1 —
    //    the router never receives a `fundingMode` on input),
    //    `llm.circuit_state`, `llm.latency_ms`.
    //  - On close-error: ONLY `llm.circuit_state` + status ERROR with
    //    `message = result.error.kind`. No `recordException`.
    //
    // `trace.idempotency_key_hash` is deliberately omitted in commit 3
    // (R2 of the mini-spec); the iter 8 client facade owns it because
    // `RouteInput` does not carry an idempotency key.
    //
    // Iter 8 forward-compat (signed Jean+Claude 2026-04-21): when a
    // caller (the `LLMClient` facade of iter 8 commit 3) already opened
    // the `llm.client.call` root span and made it the active span, we
    // reuse it instead of opening a sibling. This keeps §10.1's
    // "one span per `.call()`" invariant satisfied whether the router
    // is driven by the facade OR by a standalone caller (router tests,
    // legacy callers, iter 6 hermetic specs). Attributes and end-of-span
    // lifecycle are split by ownership:
    //   - Open attributes (`llm.origin`, `user.id_hash`) are stamped
    //     by whoever opened the span. If the router opened it
    //     (`ownsRootSpan === true`), we stamp them in the `startSpan`
    //     attributes bag below. If the facade opened it, the facade
    //     already stamped them (plus the facade-owned `llm.model` and
    //     `trace.idempotency_key_hash`) — we do NOT duplicate.
    //   - Close attributes (the 7 of §10.1) are ALWAYS stamped by the
    //     router via `stampRootSpanClose`, regardless of ownership. The
    //     router is the authoritative source for them (circuit state,
    //     provider chosen after fallback, etc.).
    //   - `rootSpan.end()` fires ONLY when `ownsRootSpan === true`. If
    //     the facade owns the span, the facade ends it in its finally.
    const tracer = getTracer();
    const startHrMs = performance.now();
    const requiredProvider = providerForModel(input.request.model);

    const activeSpan = trace.getActiveSpan();
    const rootSpan: Span =
      activeSpan?.isRecording() === true
        ? activeSpan
        : tracer.startSpan('llm.client.call', {
            kind: SpanKind.CLIENT,
            attributes: {
              'llm.origin': input.origin,
              'user.id_hash': hashUserId(input.user.userId),
            },
          });
    const ownsRootSpan = rootSpan !== activeSpan;

    // Iter 7 commit 4: kick off consent resolution BEFORE entering
    // `context.with(...)` so the async repo read overlaps with the
    // synchronous registry lookup. `consentResolver.resolve(...)` is
    // non-throwing by contract (§8 decisión firmada #8). `promptHash`
    // is computed once per `.call()` — the fallback shares the hash
    // across both attempts so abuse-detection sees one logical call
    // (§8 decisión firmada #1 — full 64-char SHA-256 hex).
    //
    // `traceId` comes from the root span's context. With the no-op
    // tracer (production without an SDK installed) this is the
    // 32-char zero hex — still valid, still non-PII. Tests with a
    // `BasicTracerProvider` get a real trace id.
    const consentPromise = consentResolver.resolve(input.user.userId);
    const promptHash = hashNormalizedRequest(input.request);
    const traceId = rootSpan.spanContext().traceId;

    try {
      // Make the root span the active span so any child span started
      // inside `routeByokOnly` / `routeManagedWithOptionalByok` (and,
      // in particular, `doProviderCall`'s `llm.provider.request`) picks
      // it up as parent. In tests without an `AsyncHooksContextManager`
      // the active context is lost across `await`, so the sub-span is
      // emitted as an independent root — the hermetic specs assert on
      // the presence and attributes of each span, not on parent linkage.
      const result = await context.with(
        trace.setSpan(context.active(), rootSpan),
        async (): Promise<Result<RouterCallOutput, LLMCallError>> => {
          const provider = providers.get(requiredProvider);
          if (provider === undefined) {
            // Deployment misconfiguration — a supported model maps to
            // an unconfigured provider. Surface `internal` with the
            // caller's correlation id (P10 of iter 6 commit 2): we no
            // longer mint a fresh id here, because the client already
            // owns the identity for this call and downstream observers
            // (OTel root span, audit log) must be able to stitch this
            // error back to the same request.
            //
            // Iter 7 commit 4 (§4.2): no `UsageEntry` either — the
            // wire was never touched. Router-minted `internal` has no
            // truthful `fundingMode` to attribute, so we deliberately
            // skip recording. Consent WAS resolved (overlap above),
            // but we discard the value — this is the cost of the
            // non-throwing contract.
            return err(make.internal(input.correlationId));
          }

          // Await the consent resolution now that we know the call
          // has a chance to touch the wire. Resolver is non-throwing
          // (§8 decisión firmada #8) so no try/catch needed.
          const consentMode = await consentPromise;
          const accountingCtx: AccountingCtx = {
            userId: input.user.userId,
            origin: input.origin,
            consentMode,
            promptHash,
            traceId,
          };

          if (
            input.user.plan === 'free' ||
            input.user.plan === 'creator'
          ) {
            return routeByokOnly(
              input,
              requiredProvider,
              provider,
              accountingCtx,
            );
          }
          return routeManagedWithOptionalByok(input, provider, accountingCtx);
        },
      );

      const latencyMs = Math.round(performance.now() - startHrMs);
      stampRootSpanClose(rootSpan, result, requiredProvider, latencyMs);
      return result;
    } finally {
      // Iter 8 forward-compat: only end the span when the router opened
      // it. If the facade passed us an active span, the facade ends it
      // in its own finally (it paid for the open, it pays for the
      // close — avoids double-end on the same span).
      if (ownsRootSpan) {
        rootSpan.end();
      }
    }
  }

  /**
   * Stamp the close-time attributes + status on the `llm.client.call`
   * root span.
   *
   * Success path (seven attributes): `llm.provider`, `llm.model`,
   * `llm.input_tokens`, `llm.output_tokens`, `llm.funding_mode`,
   * `llm.circuit_state`, `llm.latency_ms`. Status OK.
   *
   * Error path (ONE attribute + status): `llm.circuit_state`. Status
   * ERROR with `message = result.error.kind`. No `recordException` —
   * `LLMCallError` is a tagged union per §3.5, not an `Error`.
   */
  function stampRootSpanClose(
    rootSpan: Span,
    result: Result<RouterCallOutput, LLMCallError>,
    requiredProvider: ProviderName,
    latencyMs: number,
  ): void {
    if (result.ok) {
      rootSpan.setAttribute('llm.provider', result.value.providerUsed);
      rootSpan.setAttribute('llm.model', result.value.modelUsed);
      rootSpan.setAttribute(
        'llm.input_tokens',
        result.value.usage.inputTokens,
      );
      rootSpan.setAttribute(
        'llm.output_tokens',
        result.value.usage.outputTokens,
      );
      rootSpan.setAttribute('llm.funding_mode', result.value.fundingMode);
      rootSpan.setAttribute(
        'llm.circuit_state',
        breaker.currentState(result.value.providerUsed),
      );
      rootSpan.setAttribute('llm.latency_ms', latencyMs);
      rootSpan.setStatus({ code: SpanStatusCode.OK });
      return;
    }
    rootSpan.setAttribute(
      'llm.circuit_state',
      breaker.currentState(requiredProvider),
    );
    rootSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: result.error.kind,
    });
  }


  /**
   * Provider-scoped healthcheck / BYOK key validation (iter 9 c4,
   * §18.5). Reuses the resolver + circuit breaker but NOT the
   * consent/accounting path — ping is non-billable (§4.2).
   *
   * Flow:
   *  1. Registry lookup — return `make.internal(...)` if the provider
   *     is not registered (deployment bug, not a user error).
   *  2. CB check — `deny_open` / `deny_probes_exhausted` short-circuit
   *     with `make.providerDown(provider, true)` and emit
   *     `llm_router_cb_denies_total{provider, decision}`.
   *  3. Resolver — same `ApiKeyResolver` the `route()` path uses, with
   *     `mode = input.fundingMode`. Failures surface verbatim
   *     (`invalid_key`, `plan_requires_key`, `kms_unavailable`, …).
   *  4. `Provider.ping({ apiKey, abortSignal? })` — the adapter
   *     synthesises its own 1-token probe.
   *  5. Record CB outcome via `classifyOutcomeForBreaker` so the
   *     breaker sees ping results too. No UsageEntry is emitted.
   *
   * Never throws. Never logs key material.
   */
  async function routePing(
    input: RoutePingInput,
  ): Promise<Result<PingOutput, LLMCallError>> {
    const provider = providers.get(input.provider);
    if (provider === undefined) {
      return err(
        make.internal(
          `router.ping: unregistered provider ${input.provider}`,
        ),
      );
    }

    const decision = breaker.isCallAllowed(input.provider);
    if (decision === 'deny_open' || decision === 'deny_probes_exhausted') {
      metrics.counter(ROUTER_METRIC_NAMES.cbDenies, {
        provider: input.provider,
        decision,
      });
      return err(make.providerDown(input.provider, true));
    }

    const keyReq: ApiKeyRequest =
      input.fundingMode === 'byok'
        ? {
            mode: 'byok',
            userId: input.user.userId,
            provider: input.provider,
            ...(input.abortSignal !== undefined
              ? { abortSignal: input.abortSignal }
              : {}),
          }
        : {
            mode: 'managed',
            provider: input.provider,
            ...(input.abortSignal !== undefined
              ? { abortSignal: input.abortSignal }
              : {}),
          };
    const keyResult = await resolver.resolve(keyReq);
    if (!keyResult.ok) {
      return err(keyResult.error);
    }

    const pingResult = await provider.ping({
      apiKey: keyResult.value.apiKey,
      ...(input.abortSignal !== undefined
        ? { abortSignal: input.abortSignal }
        : {}),
    });

    if (pingResult.ok) {
      breaker.record(input.provider, 'success');
    } else {
      breaker.record(
        input.provider,
        classifyOutcomeForBreaker(pingResult.error),
      );
    }
    return pingResult;
  }

  return Object.freeze({ route, ping: routePing });
}

/**
 * User-facing message helper for `plan_requires_key` when the cause is
 * a BYOK provider mismatch. The taxonomy's `plan_requires_key` variant
 * does not carry a `userMessage` field — the UI looks it up via this
 * helper when it has the plan + the mismatch context.
 *
 * Exported so the UI layer (iter 7+) has a single source of truth.
 */
export function routingMismatchUserMessage(
  requiredProvider: ProviderName,
  currentProvider: ProviderName,
): string {
  return mismatchMessage(requiredProvider, currentProvider);
}

function assertNeverModel(x: never): never {
  throw new Error(`No provider mapping for model ${JSON.stringify(x)}`);
}

function assertNeverErrorKind(x: never): never {
  throw new Error(
    `Unhandled LLMCallError kind in shouldRecordError: ${JSON.stringify(x)}`,
  );
}
