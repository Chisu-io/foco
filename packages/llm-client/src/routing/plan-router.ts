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
 */

import { randomBytes } from 'node:crypto';

import type { FlagsReader } from '../config/flag-reader.js';
import { make, type LLMCallError } from '../errors/taxonomy.js';
import type { Metrics } from '../observability/metrics.js';
import type { Provider, ProviderName } from '../providers/provider.js';
import { type Result, err, ok } from '../types.js';
import type { ModelId, NormalizedLLMRequest } from '../types/request.js';
import type { ProviderCallOutput } from '../types/response.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import { classifyOutcomeForBreaker } from './events.js';

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

/** Full input to `PlanRouter.route` (§3.3 minus keys). */
export interface RouteInput {
  readonly user: UserQuota;
  readonly request: NormalizedLLMRequest;
  readonly providerHint?: ProviderName | undefined;
  readonly abortSignal?: AbortSignal | undefined;
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

/** Public surface of the router. */
export interface PlanRouter {
  route(
    input: RouteInput,
  ): Promise<Result<RouterCallOutput, LLMCallError>>;
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
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

export function createPlanRouter(deps: PlanRouterDeps): PlanRouter {
  const {
    providers,
    resolver,
    breaker,
    metrics,
    onByokKeyInvalidated,
  } = deps;

  async function doProviderCall(
    resolved: ResolvedKey,
    provider: Provider,
    request: NormalizedLLMRequest,
    abortSignal: AbortSignal | undefined,
  ): Promise<Result<RouterCallOutput, LLMCallError>> {
    const decision = breaker.isCallAllowed(provider.name);
    if (decision === 'deny_open' || decision === 'deny_probes_exhausted') {
      metrics.counter(ROUTER_METRIC_NAMES.cbDenies, {
        provider: provider.name,
        decision,
      });
      return err(make.providerDown(provider.name, true));
    }

    const callResult = await provider.call({
      apiKey: resolved.apiKey,
      request,
      ...(abortSignal !== undefined ? { abortSignal } : {}),
    });

    if (callResult.ok) {
      breaker.record(provider.name, 'success');
      return ok({ ...callResult.value, fundingMode: resolved.mode });
    }

    breaker.record(
      provider.name,
      classifyOutcomeForBreaker(callResult.error),
    );
    return err(callResult.error);
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
    const requiredProvider = providerForModel(input.request.model);
    const provider = providers.get(requiredProvider);
    if (provider === undefined) {
      // Deployment misconfiguration — a supported model maps to an
      // unconfigured provider. Mint `internal` with a correlation
      // id the UI can surface to support.
      return err(make.internal(newCorrelationId()));
    }

    if (input.user.plan === 'free' || input.user.plan === 'creator') {
      return routeByokOnly(input, requiredProvider, provider);
    }
    return routeManagedWithOptionalByok(input, provider);
  }

  return Object.freeze({ route });
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

/**
 * Correlation-id minter. 8 random bytes from `node:crypto` rendered
 * as hex — correlation ids are for customer-support grep, not
 * security, but using CSPRNG bytes is cheaper than a thinking
 * moment about collision probabilities.
 *
 * Iter 6 will replace this with an OTel span id once the tracer is
 * wired up.
 */
function newCorrelationId(): string {
  return randomBytes(8).toString('hex');
}

function assertNeverModel(x: never): never {
  throw new Error(`No provider mapping for model ${JSON.stringify(x)}`);
}
