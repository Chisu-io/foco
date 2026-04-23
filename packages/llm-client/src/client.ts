/**
 * `LLMClient` facade — the public surface of `@chisu/llm-client`.
 *
 * Composes the six signed internals:
 *
 *  - Iter 2: envelope encryption ({@link EnvelopeCrypto}).
 *  - Iter 4: plan-aware {@link PlanRouter} + per-provider circuit breaker.
 *  - Iter 5: CB audit sink (consumed indirectly through the router).
 *  - Iter 6: OTel tracer DI seam + {@link CLIENT_SPAN_NAME} root span.
 *  - Iter 7: token accounting ({@link UsageBuffer} + `UsageRecorder`).
 *  - Iter 8 c1/c2: idempotency ({@link IdempotencyStore} +
 *    {@link buildIdempotencyKey}) + flush scheduler
 *    ({@link FlushScheduler}).
 *
 * Adds, at this layer, what no single lower module owns:
 *
 *  - Idempotency lookup on `call()` entry + `store.set` on router
 *    success (error paths never cache — §4 of
 *    {@link ../../../docs/LLM_CLIENT.md `LLM_CLIENT.md` v1.1}).
 *  - Latency budget via {@link AbortSignal.any} composition of
 *    `options.signal` + `AbortSignal.timeout(deadlineMs)` (Node ≥24).
 *  - Graceful `close()` with inflight drain + scheduler flush +
 *    idempotency cache wipe.
 *  - Root span `llm.client.call` (§10.1) — the router consumes the
 *    active span via the iter 8 forward-compat chore and stamps
 *    close-time attributes on the same span; the facade is responsible
 *    for `.end()` because the router sees `ownsRootSpan === false`.
 *  - `llm_client_inflight_calls` gauge + `llm_client_close_drained_total{result}`
 *    counter (new in iter 8 c3).
 *
 * ## Non-throwing contract (§3.5)
 *
 * `LLMClient.call()` resolves `Promise<Result<LLMCallOutput & {
 *  fromIdempotencyCache: boolean }, LLMCallError>>` — NEVER throws.
 * Unexpected exceptions are caught and translated to
 * `make.internal('client.call: unexpected')`; the span is marked
 * `ERROR` and ended. The only source of `throw` in this file is a
 * construction-time validation (which is not part of the call path).
 *
 * ## Three delegated decisions (signed Jean+Claude 2026-04-21)
 *
 * The iter 8 c3 prompt had three ambiguity points relative to the
 * signed contract. Jean delegated the resolution per
 * `feedback_delegated_decisions.md`. All three resolutions land here
 * without bumping the signed contract:
 *
 *  1. **Deadline encoding.** The taxonomy has no `deadline_exceeded`
 *     variant; §7.1 of the contract explicitly maps "caller deadline
 *     expired" to `network_error` with `transient: false`. The facade
 *     mints `make.networkError(false)` in the pre-router branch AND
 *     also stamps the root span with
 *     `setStatus(ERROR, 'deadline_exceeded')` so dashboards can filter
 *     on the status message. Tests assert both.
 *  2. **Internal `reason`.** The `internal` variant only carries
 *     `correlationId`, so the "closed" and "invalid_input" reasons are
 *     encoded as structured correlationId prefixes (same pattern as
 *     `make.internal('envelope.wrap: empty userId')` in
 *     `crypto/envelope.ts`). For `invalid_input` the span is open, so
 *     the facade stamps `llm.internal_reason='invalid_input'` +
 *     `setStatus(ERROR, 'invalid_input')` before ending. For `closed`
 *     no span is opened (§ step 1) so no attribute is stamped; the
 *     correlationId prefix is the sole evidence.
 *  3. **`LLMCallInput` shape.** §3.3 of LLM_CLIENT.md v1.1 does not
 *     carry `user: UserQuota` but `RouteInput` does. In c3 the facade
 *     accepts a superset (§3.3 + `user`); iter 9 will narrow this
 *     back to §3.3 exactly and introduce a `UserQuotaRepo` DI seam
 *     that hydrates `user` before calling `router.route`. This is a
 *     tracked pendiente on LLM_CLIENT.md (delta commit will
 *     document).
 *
 * @see ../../../docs/LLM_CLIENT.md — signed contract v1.1.
 * @see ../../../.cmsgs/iter8-commit3-prompt.md — signed scope.
 * @see ./errors/taxonomy.ts — `LLMCallError` variants + `make.*`.
 * @see ./routing/plan-router.ts — router open/close contract.
 * @see ./scheduler/flush-scheduler.ts — owned lifecycle.
 */

import { randomUUID } from 'node:crypto';

import {
  SpanKind,
  SpanStatusCode,
  context,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { z } from 'zod';

import { hashNormalizedRequest } from './accounting/prompt-hash.js';
import { type LLMCallError, make } from './errors/taxonomy.js';
import { buildIdempotencyKey } from './idempotency/key.js';
import {
  IDEMPOTENCY_HITS_COUNTER,
  IDEMPOTENCY_MISSES_COUNTER,
  type IdempotencyStore,
} from './idempotency/store.js';
import {
  hashIdempotencyKey,
  hashUserId,
} from './observability/tracing.js';
import {
  type PlanRouter,
  type RouteInput,
  type UserQuota,
} from './routing/plan-router.js';
import { type Clock } from './time.js';
import { err, ok, type Result } from './types.js';

import type { UsageBuffer } from './accounting/usage-counter.js';
import type { EnvelopeCrypto } from './crypto/envelope.js';
import type { Logger } from './observability/logger.js';
import type { Metrics } from './observability/metrics.js';
import type { ProviderName } from './providers/provider.js';
import type { UserQuotaRepo } from './repos/user-quota-repo.js';
import type { OriginKind } from './routing/events.js';
import type { FlushScheduler } from './scheduler/flush-scheduler.js';
import type { NormalizedLLMRequest } from './types/request.js';
import type { LLMCallOutput } from './types/response.js';

// ─── Constants ────────────────────────────────────────────────────────
//
// Exported so tests can import a typed symbol instead of hard-coding a
// literal. Any future rename ripples compile-time through both prod and
// test surfaces.

/**
 * Canonical OTel root-span name per §10.1 of LLM_CLIENT.md v1.1. The
 * iter 6 c3 commit firmed this name over `llm.call`; the iter 8
 * forward-compat chore made the router consume this span when the
 * facade opens it.
 */
export const CLIENT_SPAN_NAME = 'llm.client.call';

/**
 * Gauge emitted before/after every inflight-tracking mutation. `value`
 * is the tracker `.size` at the moment of emission. No dimensions —
 * adding per-user or per-provider labels would be a cardinality trap.
 */
export const INFLIGHT_GAUGE = 'llm_client_inflight_calls';

/**
 * Counter incremented exactly once per `close()` call, labelled with
 * whether the inflight drain completed within the budget or timed out.
 * `result ∈ {drained, timeout}`.
 */
export const CLOSE_DRAINED_COUNTER = 'llm_client_close_drained_total';

/**
 * Default idempotency cache TTL — 5 minutes per §4 of LLM_CLIENT.md.
 * Short enough that a repeat of the exact same request within the
 * window is almost certainly intended dedup, long enough to cover a
 * realistic retry/backoff window.
 */
export const DEFAULT_IDEMPOTENCY_TTL_MS = 300_000;

/**
 * Default graceful-shutdown budget — 5 seconds. Beyond this the
 * {@link CLOSE_DRAINED_COUNTER} fires with `result=timeout` and close
 * continues past the still-running calls.
 */
export const DEFAULT_DRAIN_TIMEOUT_MS = 5_000;

/**
 * Canonical structured `correlationId` for the `internal` variant
 * minted when `call()` is invoked after `close()`. Matches the
 * `envelope.wrap: empty userId` precedent in `crypto/envelope.ts` —
 * the prefix signals the mint site, the suffix signals the reason.
 */
const INTERNAL_REASON_CLOSED = 'client.call: closed';

/** Structured `correlationId` when the zod parse of `LLMCallInput` fails. */
const INTERNAL_REASON_INVALID_INPUT = 'client.call: invalid_input';

/**
 * Structured `correlationId` for the `internal` variant emitted when
 * `UserQuotaRepo.get()` returns `{ kind: 'not_found' }`. Matches the
 * precedent set by `INTERNAL_REASON_CLOSED` and
 * `INTERNAL_REASON_INVALID_INPUT`.
 */
const INTERNAL_REASON_QUOTA_NOT_FOUND = 'client.call: quota_not_found';

/**
 * Structured `correlationId` for the `internal` variant emitted when
 * `UserQuotaRepo.get()` returns `{ kind: 'transport' }` — i.e. the
 * repo adapter itself had an IO failure. Not an idempotency- or
 * call-level retry candidate.
 */
const INTERNAL_REASON_QUOTA_TRANSPORT = 'client.call: quota_transport';

/** Span `setStatus` message for quota-resolve failures. */
const QUOTA_NOT_FOUND_SPAN_MESSAGE = 'quota_not_found';
const QUOTA_TRANSPORT_SPAN_MESSAGE = 'quota_transport';

/** Name of the sub-span that wraps the repo call. §10.1 extension. */
export const QUOTA_RESOLVE_SPAN_NAME = 'llm.quota.resolve';

/**
 * Span `setStatus` message for a pre-router deadline expiry. The error
 * returned is `make.networkError(false)` per §7.1; the status message
 * is what dashboards filter on.
 */
const DEADLINE_SPAN_MESSAGE = 'deadline_exceeded';

/** Span `setStatus` message for a zod-parse reject. */
const INVALID_INPUT_SPAN_MESSAGE = 'invalid_input';

// ─── Input schema ─────────────────────────────────────────────────────
//
// Minimal structural validation. The router does its own deeper
// validation (provider lookup, plan gating); the facade's job is to
// reject malformed inputs BEFORE we touch OTel, the idempotency cache,
// or the router.

const normalizedLLMRequestSchema = z
  .object({
    model: z.enum([
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
      'gpt-5',
      'gpt-5-mini',
      'gemini-2.5-pro',
      'gemini-2.5-flash',
    ]),
    messages: z
      .array(
        z.object({
          role: z.enum(['user', 'assistant', 'tool']),
          content: z.unknown(),
        }),
      )
      .min(1),
    systemPrompt: z.string().optional(),
    maxTokens: z.number().int().positive(),
    temperature: z.number().optional(),
    stopSequences: z.array(z.string()).optional(),
    toolDefinitions: z.array(z.unknown()).optional(),
    responseFormat: z.enum(['text', 'json_object']).optional(),
  })
  .passthrough();

const callInputSchema = z
  .object({
    // §3.3 field — the facade resolves `UserQuota` from this via
    // `UserQuotaRepo.get(userId)` before routing (iter 9 c3, §18.1).
    // Prior iter-8 shape had `user: UserQuota` inline; narrowed to
    // just the id here so the input schema matches §3.3 exactly.
    userId: z.string().min(1),
    exposureScope: z.enum(['internal', 'mcp-callable']),
    origin: z.enum([
      'assistant-conversation',
      'script-generation',
      'caption-refine',
      'hook-brainstorm',
      'mcp-server-callback',
    ]),
    request: normalizedLLMRequestSchema,
    providerHint: z.enum(['anthropic', 'openai', 'gemini']).optional(),
    traceparent: z.string(),
    // Iter 9 pendiente 18.3: declared explicitly (prior: accepted via
    // `.passthrough()` only). Empty string is tolerated at parse time
    // but the facade treats it as "absent" and falls back to
    // `traceparent` parsing.
    correlationId: z.string().optional(),
    idempotencyKey: z.string().optional(),
  })
  .passthrough();

// ─── Public types ─────────────────────────────────────────────────────

/**
 * Contract-facing `LLMClient.call()` input — matches §3.3 of
 * LLM_CLIENT.md v1.1 exactly.
 *
 * Fields in §3.3 (verbatim): `userId`, `exposureScope`, `origin`,
 * `request`, `providerHint?`, `traceparent`, `idempotencyKey?`.
 *
 * Iter 9 additions (local, no contract bump):
 *  - 18.3: `correlationId?` declared as typed optional field (caller
 *    override preferred over `traceparent` parsing when non-empty).
 *
 * Iter 9 c3 (§18.1) narrowed this from the iter-8 superset (which
 * inlined `user: UserQuota`) to `userId: string`. The facade resolves
 * the full `UserQuota` via `LLMClientDeps.userQuotaRepo` before any
 * routing or idempotency work. Callers now pass only an identifier;
 * the quota row stays server-side.
 *
 * The `idempotencyKey?` caller override is honoured (iter 9 c2,
 * LLM_CLIENT.md §18.2): when provided and non-empty the facade
 * composes it with `userId` before hashing, preventing cross-tenant
 * collision for deterministic caller patterns (cron, worker job id,
 * replayable fixture). Empty strings fall back to the derived
 * `(userId, promptHash, model)` key.
 */
export interface LLMCallInput {
  /**
   * §3.3. User identifier; the facade resolves the full `UserQuota`
   * row via `userQuotaRepo.get(userId)` inside `call()` (§18.1 /
   * iter 9 c3). Must be non-empty (zod-enforced).
   */
  readonly userId: string;
  /**
   * §3.3. Does not flow to the router in c3 — recorded on span and
   * reserved for §7 audit / exposure-scope gating in iter 9+.
   */
  readonly exposureScope: 'internal' | 'mcp-callable';
  /** §3.3. Flows into span attrs + accounting (via router). */
  readonly origin: OriginKind;
  /** §3.3. The provider-agnostic request (model, messages, maxTokens, …). */
  readonly request: NormalizedLLMRequest;
  /** §3.3. Optional routing hint — forwarded verbatim to the router. */
  readonly providerHint?: ProviderName | undefined;
  /**
   * §3.3 — W3C traceparent header (`version-traceId-spanId-flags`).
   * Used as the default source for `correlationId` when the caller
   * does not provide an explicit one: the facade parses the 32-char
   * `traceId` segment via {@link deriveCorrelationId}; falls back to
   * a fresh `randomUUID()` on malformed input.
   */
  readonly traceparent: string;
  /**
   * Optional caller-supplied correlation id. When provided and
   * non-empty, the facade uses it verbatim instead of parsing
   * `traceparent`; the router stamps it on spans + accounting rows
   * + `make.internal(...)` outputs. Useful for callers that already
   * hold a stable business correlation id (worker job id, external
   * request id, replay trace) and want log correlation without
   * synthesising a W3C traceparent. Empty strings fall back to
   * `traceparent` parsing.
   *
   * Iter 9 pendiente 18.3 landed this as a typed field (prior
   * behaviour: `.passthrough()` only, not declared on the type).
   */
  readonly correlationId?: string | undefined;
  /**
   * §3.3 — Optional caller-supplied idempotency key. When provided and
   * non-empty, the facade composes it with `userId` before hashing so
   * the same key cannot collide across tenants (see
   * {@link buildIdempotencyKey} and LLM_CLIENT.md §18.2). Useful for
   * cron jobs or worker patterns that already hold a stable business
   * identifier. Empty strings fall back to the derived
   * `(userId, promptHash, model)` key.
   */
  readonly idempotencyKey?: string | undefined;
}

/**
 * Optional construction-time knobs. Every field has a signed default
 * so `new LLMClient({ ...deps })` is a valid bootstrap (tests pin the
 * defaults explicitly for clarity).
 */
export interface LLMClientConfig {
  /**
   * Flush scheduler interval. Forwarded verbatim to
   * {@link FlushScheduler} — defaulted there to
   * {@link DEFAULT_FLUSH_INTERVAL_MS}. Accepted here as config so the
   * facade owns the user-facing surface (callers don't construct the
   * scheduler themselves).
   */
  readonly flushIntervalMs?: number | undefined;
  /**
   * High-water-mark fraction. See {@link FlushScheduler} for the
   * exact threshold computation.
   */
  readonly flushThresholdFraction?: number | undefined;
  /**
   * Idempotency cache entry TTL. Defaults to
   * {@link DEFAULT_IDEMPOTENCY_TTL_MS}. Pass `0` to disable caching
   * (the underlying store no-ops on `ttlMs <= 0`).
   */
  readonly idempotencyTtlMs?: number | undefined;
  /**
   * Deadline applied when the caller did not pass `options.deadlineMs`.
   * `undefined` ⇒ no default deadline — the call runs with the
   * caller-supplied signal only, or uncancellable if neither is set.
   */
  readonly defaultDeadlineMs?: number | undefined;
  /**
   * Graceful-shutdown budget for `close()`. Defaults to
   * {@link DEFAULT_DRAIN_TIMEOUT_MS}.
   */
  readonly drainTimeoutMs?: number | undefined;
}

/**
 * Construction deps. All fields required — the only defaulting happens
 * inside {@link LLMClientConfig}.
 *
 * Passing `tracer` explicitly (rather than pulling the global one via
 * `getTracer()`) makes the DI seam uniform across all observability
 * surfaces and lets host applications install a dedicated tracer per
 * `LLMClient` instance. The router still uses `getTracer()` internally
 * — in production both resolve to the same tracer; in tests the spec
 * pins both sides (`setTracer` + `deps.tracer`) to the same fake.
 */
export interface LLMClientDeps {
  readonly router: PlanRouter;
  readonly envelope: EnvelopeCrypto;
  readonly usageBuffer: UsageBuffer;
  readonly idempotencyStore: IdempotencyStore;
  readonly flushScheduler: FlushScheduler;
  readonly metrics: Metrics;
  readonly tracer: Tracer;
  readonly logger: Logger;
  readonly clock: Clock;
  /**
   * Repo used by `call()` to resolve `UserQuota` from `userId`.
   * Added iter 9 c3 (§18.1) — cierra la dependencia implícita que
   * iter 8 c3 tenía sobre un callsite que pasaba `user` inline.
   */
  readonly userQuotaRepo: UserQuotaRepo;
  readonly config?: LLMClientConfig | undefined;
}

/**
 * Per-call knobs. Both are optional; the facade composes them with
 * `config.defaultDeadlineMs` into a single `AbortSignal` via
 * {@link AbortSignal.any}.
 */
export interface LLMCallOptions {
  /** Caller-supplied cancellation signal. Composed with the deadline signal. */
  readonly signal?: AbortSignal;
  /**
   * Per-call latency budget in ms. Overrides
   * {@link LLMClientConfig.defaultDeadlineMs}.
   *
   * A value of `0` means "expire immediately" — useful for tests that
   * need to exercise the pre-router deadline branch. Negative or
   * non-finite values are treated as "no deadline".
   */
  readonly deadlineMs?: number;
}

/**
 * The contract-facing success shape. Extends {@link LLMCallOutput}
 * with a single discriminant revealing whether the result came from
 * the idempotency cache.
 */
export type LLMCallSuccess = LLMCallOutput & {
  readonly fromIdempotencyCache: boolean;
};

// ─── Implementation ───────────────────────────────────────────────────

/**
 * Plan-aware LLM client.
 *
 * Lifecycle:
 *
 *  1. `new LLMClient(deps)` — starts the flush scheduler.
 *  2. `await client.call(input, options?)` — Result<LLMCallSuccess,
 *     LLMCallError>. Never throws.
 *  3. `await client.close(opts?)` — idempotent drain + shutdown.
 *
 * Thread-safety: Node.js single-thread semantics. `inflight` is a
 * plain Set; concurrent `call()` invocations on the same client are
 * allowed and tracked independently.
 */
export class LLMClient {
  private readonly deps: LLMClientDeps;
  /**
   * Inflight tracker — promises resolved when each call's `finally`
   * runs. `close()` snapshots this and races it against the drain
   * timeout. Symbols are not usable here because `close()` needs to
   * `await` each pending call's promise, so we track actual promises.
   */
  private readonly inflight = new Set<Promise<void>>();
  private closed = false;

  constructor(deps: LLMClientDeps) {
    this.deps = deps;
    // Start the flush scheduler immediately. `start()` is idempotent
    // per its own contract, so re-entrant construction (impossible
    // today, but defensive) is safe.
    this.deps.flushScheduler.start();
  }

  /**
   * Issue one LLM call through the plan-aware router, with
   * idempotency-cache lookup, optional latency budget, and OTel root
   * span.
   *
   * Never throws. See §3.5 of the contract; every anticipated failure
   * is expressed as a `Result.err` variant.
   */
  async call(
    input: LLMCallInput,
    options?: LLMCallOptions,
  ): Promise<Result<LLMCallSuccess, LLMCallError>> {
    // Step 1 — closed gate. No span, no inflight, no side effects.
    // The error carries a structured correlationId prefix (see header
    // JSDoc decision #2); no OTel attribute is stamped because no
    // span exists.
    if (this.closed) {
      return err(make.internal(INTERNAL_REASON_CLOSED));
    }

    const start = this.deps.clock();
    const span = this.openSpan(input);

    // Step 6 inflight tracking — registered AFTER the cache miss. We
    // pre-declare the resolver so the `finally` block can flip it
    // regardless of which code path we exit through.
    let resolveInflight: (() => void) | undefined;
    let inflightPromise: Promise<void> | undefined;

    try {
      // Step 3 — zod parse. Run BEFORE any work that depends on
      // `input` being well-formed. A parse failure yields
      // `internal: 'client.call: invalid_input'` with the span stamped
      // `ERROR` and `llm.internal_reason` attribute populated.
      const parsed = callInputSchema.safeParse(input);
      if (!parsed.success) {
        const latencyMs = this.deps.clock() - start;
        span.setAttribute('llm.internal_reason', 'invalid_input');
        span.setAttribute('llm.latency_ms', latencyMs);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: INVALID_INPUT_SPAN_MESSAGE,
        });
        return err(make.internal(INTERNAL_REASON_INVALID_INPUT));
      }

      // Step 4 — inflight registration (pre-quota-resolve). Moved to
      // this position in iter 9 c3 so the quota resolve `await`
      // counts against `close()`'s drain budget — otherwise a caller
      // that invokes `close()` right after `call()` would see a drain
      // snapshot that is empty (the inflight had not yet been added
      // because the facade was parked on `userQuotaRepo.get()`). Since
      // the registration now happens BEFORE the idempotency lookup
      // too, HIT paths transiently touch the gauge; per `close()`'s
      // semantics this is the correct trade-off.
      inflightPromise = new Promise<void>((resolve) => {
        resolveInflight = resolve;
      });
      this.inflight.add(inflightPromise);
      this.deps.metrics.gauge(INFLIGHT_GAUGE, this.inflight.size);

      // Step 5 — quota resolve (iter 9 c3, §18.1). The facade no
      // longer accepts an inline `user: UserQuota`; the repo seam
      // hydrates it from `userId` inside its own sub-span so failures
      // are observable end-to-end without polluting the root span with
      // `llm.quota.*` attrs.
      //
      // Two failure modes:
      //   - `not_found`: the userId does not map to a row. Emitted as
      //     `internal: 'client.call: quota_not_found'` with span
      //     status ERROR + message `quota_not_found`.
      //   - `transport`: repo IO failure. Emitted as
      //     `internal: 'client.call: quota_transport'` — the reason
      //     string from the repo (already PII-free by contract) is
      //     only logged, not returned, per the same precedent as
      //     `invalid_input`.
      const quotaSpan = this.deps.tracer.startSpan(
        QUOTA_RESOLVE_SPAN_NAME,
        { kind: SpanKind.INTERNAL, attributes: { 'user.id_hash': hashUserId(input.userId) } },
      );
      let user: UserQuota;
      try {
        const quotaResult = await context.with(
          trace.setSpan(context.active(), quotaSpan),
          async () => this.deps.userQuotaRepo.get(input.userId),
        );
        if (!quotaResult.ok) {
          if (quotaResult.error.kind === 'not_found') {
            quotaSpan.setStatus({
              code: SpanStatusCode.ERROR,
              message: QUOTA_NOT_FOUND_SPAN_MESSAGE,
            });
            const latencyMs = this.deps.clock() - start;
            span.setAttribute('llm.internal_reason', 'quota_not_found');
            span.setAttribute('llm.latency_ms', latencyMs);
            span.setStatus({
              code: SpanStatusCode.ERROR,
              message: QUOTA_NOT_FOUND_SPAN_MESSAGE,
            });
            return err(make.internal(INTERNAL_REASON_QUOTA_NOT_FOUND));
          }
          // transport
          this.deps.logger.warn('llm-client: quota repo transport error', {
            userId: hashUserId(input.userId),
            reason: quotaResult.error.reason,
          });
          quotaSpan.setStatus({
            code: SpanStatusCode.ERROR,
            message: QUOTA_TRANSPORT_SPAN_MESSAGE,
          });
          const latencyMs = this.deps.clock() - start;
          span.setAttribute('llm.internal_reason', 'quota_transport');
          span.setAttribute('llm.latency_ms', latencyMs);
          span.setStatus({
            code: SpanStatusCode.ERROR,
            message: QUOTA_TRANSPORT_SPAN_MESSAGE,
          });
          return err(make.internal(INTERNAL_REASON_QUOTA_TRANSPORT));
        }
        user = quotaResult.value;
        quotaSpan.setStatus({ code: SpanStatusCode.OK });
      } finally {
        quotaSpan.end();
      }

      // Step 6 — key derivation. `promptHash` is the full 64-char
      // lowercase SHA-256 of the canonicalised request (§8 #1). The
      // idempotency key hashes `(userId + promptHash + model)` again
      // so the raw userId does not leak into the cache key space.
      //
      // Iter 9 c2 (§18.2): honour `input.idempotencyKey` override. When
      // provided and non-empty it composes with `userId` so the same
      // caller-visible key cannot collide across tenants. Empty strings
      // fall through to the derived 3-tuple.
      const promptHash = hashNormalizedRequest(input.request);
      const idemKey = buildIdempotencyKey(
        input.userId,
        promptHash,
        input.request.model,
        input.idempotencyKey,
      );

      // Stamp the remaining two open-time attributes now that the
      // parse has succeeded. `llm.origin` + `user.id_hash` were
      // stamped at span construction; these two depend on the parsed
      // request.
      span.setAttribute('llm.model', input.request.model);
      span.setAttribute(
        'trace.idempotency_key_hash',
        hashIdempotencyKey(idemKey),
      );

      // Step 6 — idempotency lookup. HIT short-circuits the call: no
      // router invocation, no flush notification. The span gets
      // `fromIdempotencyCache=true` + `llm.latency_ms` of the local
      // lookup-only measurement; the `finally` block below unwinds
      // the inflight registration for both HIT and MISS uniformly.
      const cached = await this.deps.idempotencyStore.get(idemKey);
      if (cached !== undefined) {
        this.deps.metrics.counter(IDEMPOTENCY_HITS_COUNTER, {
          reason: 'same_request',
        });
        const latencyMs = this.deps.clock() - start;
        span.setAttribute('fromIdempotencyCache', true);
        span.setAttribute('llm.latency_ms', latencyMs);
        span.setStatus({ code: SpanStatusCode.OK });
        return ok({ ...cached, fromIdempotencyCache: true });
      }
      this.deps.metrics.counter(IDEMPOTENCY_MISSES_COUNTER);

      // Step 7 — signal composition. Layer `options.signal` with the
      // deadline timeout if one was requested. `AbortSignal.any`
      // needs Node ≥24; package.json pins `>=24`.
      const deadlineMs =
        options?.deadlineMs ?? this.deps.config?.defaultDeadlineMs;
      const signals: AbortSignal[] = [];
      if (options?.signal !== undefined) {
        signals.push(options.signal);
      }
      if (
        deadlineMs !== undefined &&
        Number.isFinite(deadlineMs) &&
        deadlineMs >= 0
      ) {
        // `AbortSignal.timeout(0)` fires on the NEXT tick, not
        // synchronously — so the pre-router `composed.aborted` check
        // below would read `false` and the call would race through to
        // the router. The JSDoc on `LLMCallOptions.deadlineMs`
        // promises that `0` means "expire immediately", so use the
        // pre-aborted `AbortSignal.abort()` sentinel for that case.
        signals.push(
          deadlineMs === 0
            ? AbortSignal.abort()
            : AbortSignal.timeout(deadlineMs),
        );
      }
      const composed: AbortSignal | undefined =
        signals.length > 0 ? AbortSignal.any(signals) : undefined;

      // Step 8 — pre-router abort check. If the composed signal is
      // already aborted (deadline of 0, caller aborted before call,
      // etc.) we short-circuit BEFORE invoking the router. The error
      // is `networkError(false)` per §7.1; the span status message is
      // `deadline_exceeded` for dashboard filters.
      if (composed?.aborted === true) {
        const latencyMs = this.deps.clock() - start;
        span.setAttribute('llm.latency_ms', latencyMs);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: DEADLINE_SPAN_MESSAGE,
        });
        return err(make.networkError(false));
      }

      // Step 9 — router invocation inside a `context.with(...)` scope
      // so `trace.getActiveSpan()` in the router's iter-8 forward-compat
      // branch resolves to our span (no new root gets opened).
      //
      // Resolution order for `correlationId` (iter 9 pendiente 18.3):
      //   1. `input.correlationId` if provided and non-empty — caller
      //      owns the value verbatim.
      //   2. Parsed traceId portion of `input.traceparent`.
      //   3. Fresh `randomUUID()` fallback (inside deriveCorrelationId).
      const correlationId =
        typeof input.correlationId === 'string' && input.correlationId.length > 0
          ? input.correlationId
          : deriveCorrelationId(input.traceparent);
      const routeInput = this.buildRouteInput(
        input,
        user,
        correlationId,
        composed,
      );
      const routeResult = await context.with(
        trace.setSpan(context.active(), span),
        async () => this.deps.router.route(routeInput),
      );

      // Step 10 — handle router result.
      if (routeResult.ok) {
        const latencyMs = this.deps.clock() - start;
        const output: LLMCallOutput = buildCallOutput(
          routeResult.value,
          latencyMs,
        );
        await this.deps.idempotencyStore.set(
          idemKey,
          output,
          this.deps.config?.idempotencyTtlMs ?? DEFAULT_IDEMPOTENCY_TTL_MS,
        );
        this.deps.flushScheduler.notifyBufferChanged(
          this.deps.usageBuffer.size(),
        );
        span.setAttribute('fromIdempotencyCache', false);
        return ok({ ...output, fromIdempotencyCache: false });
      }

      // Error path — the router already stamped `llm.circuit_state`
      // and set span status to ERROR with `err.kind` as the message.
      // We neither cache errors (§4) nor notify the scheduler (only
      // successful calls add to the buffer).
      return routeResult;
    } catch (thrown) {
      // The `LLMClient` contract is `never throws`. The only reason
      // this catch exists is defensiveness against an upstream
      // invariant violation (e.g. a fake router that throws). Log
      // once, surface as `internal`, and let the `finally` end the
      // span.
      const message =
        thrown instanceof Error ? thrown.message : String(thrown);
      this.deps.logger.warn('llm-client: unexpected throw in call()', {
        error: message,
      });
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: 'unexpected',
      });
      return err(make.internal(`client.call: unexpected (${message})`));
    } finally {
      // Clear inflight tracking if we registered. `resolveInflight` is
      // set only on the miss path (post-lookup); HIT / zod-fail / pre-
      // lookup paths skip this block harmlessly.
      if (inflightPromise !== undefined && resolveInflight !== undefined) {
        resolveInflight();
        this.inflight.delete(inflightPromise);
        this.deps.metrics.gauge(INFLIGHT_GAUGE, this.inflight.size);
      }
      span.end();
    }
  }

  /**
   * Graceful shutdown. Idempotent: the second call returns
   * immediately without emitting a second `llm_client_close_drained_total`.
   *
   * Order:
   *
   *  1. Flip `closed = true`. New `call()` invocations reject with
   *     `internal('client.call: closed')` immediately.
   *  2. Snapshot and race inflight calls against the drain timeout.
   *     Fires {@link CLOSE_DRAINED_COUNTER} with `result ∈
   *     {drained, timeout}`.
   *  3. `await flushScheduler.stop()` — drains the buffer via the
   *     scheduler's own `'close'` flush.
   *  4. `await idempotencyStore.clear()`.
   *  5. **Skip** envelope cleanup — `EnvelopeCrypto.invalidateAll`
   *     does not exist in c3; iter 9 adds `invalidateUserKey`. Stale
   *     DEKs in the cache are cleaned by their own TTL (≤300 s per
   *     §7 of the contract), so process-level close is fine.
   */
  async close(opts?: { readonly drainTimeoutMs?: number }): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    const drainTimeoutMs =
      opts?.drainTimeoutMs ??
      this.deps.config?.drainTimeoutMs ??
      DEFAULT_DRAIN_TIMEOUT_MS;

    // Snapshot now — later `call()`s short-circuit on `closed`, so no
    // new entries will be added. A concurrent `call()` that sneaked
    // past the closed check before step 1 WILL be in the set
    // (Node single-thread semantics: the closed-check + inflight.add
    // happen in the same microtask frame as our snapshot only if a
    // pre-existing call has already begun).
    const snapshot = Array.from(this.inflight);
    const drainResult = await raceDrain(snapshot, drainTimeoutMs);
    this.deps.metrics.counter(CLOSE_DRAINED_COUNTER, {
      result: drainResult,
    });

    // Continue even on timeout — the inflight calls will finish on
    // their own and resolve their tracking promises (harmless, we
    // already removed them from the set on their own finally path
    // for the drained ones; the timed-out ones are still running but
    // are not our problem past this point).
    await this.deps.flushScheduler.stop();
    await this.deps.idempotencyStore.clear();
  }

  /**
   * Open the `llm.client.call` root span with the defensive subset of
   * attributes that do NOT require a successful zod parse. `llm.model`
   * and `trace.idempotency_key_hash` are stamped later in `call()`
   * after the parse confirms the input is structurally well-formed.
   *
   * Invalid input (non-string `origin`, missing `userId`, etc.) is
   * rare but we do not want to throw on span construction just
   * because the caller passed something off-spec — the span is there
   * to surface the invalid_input failure.
   */
  private openSpan(input: LLMCallInput): Span {
    const attrs: Record<string, string> = {};
    // The input shape is typed non-nullable, but we still guard the
    // length of each string so empty-string callers don't produce
    // useless span attrs. Earlier iter 8 had extra `?.` chains against
    // a looser ad-hoc shape; LLM_CLIENT v1.1 froze the type.
    if (input.origin.length > 0) {
      attrs['llm.origin'] = input.origin;
    }
    if (input.userId.length > 0) {
      attrs['user.id_hash'] = hashUserId(input.userId);
    }
    return this.deps.tracer.startSpan(CLIENT_SPAN_NAME, {
      kind: SpanKind.CLIENT,
      attributes: attrs,
    });
  }

  /**
   * Translate the facade's `LLMCallInput` + resolved `UserQuota` into
   * the router's `RouteInput`. The two shapes are deliberately not
   * identical — `exposureScope` / `traceparent` / `idempotencyKey` /
   * `correlationId` are facade-level concerns; `correlationId` is
   * resolved upstream (typed `input.correlationId` override preferred
   * over `deriveCorrelationId(input.traceparent)` when non-empty).
   *
   * `user` is passed separately (not read from `input`) because iter 9
   * c3 narrowed `LLMCallInput` to `userId: string`; the full
   * `UserQuota` is hydrated by `userQuotaRepo.get()` in `call()` before
   * this helper runs.
   *
   * `exactOptionalPropertyTypes` makes `{ foo: undefined }`
   * structurally different from `{}`, so we only attach `providerHint`
   * and `abortSignal` when we have a value to set.
   */
  private buildRouteInput(
    input: LLMCallInput,
    user: UserQuota,
    correlationId: string,
    composed: AbortSignal | undefined,
  ): RouteInput {
    const base = {
      user,
      request: input.request,
      correlationId,
      origin: input.origin,
    };
    if (input.providerHint !== undefined && composed !== undefined) {
      return {
        ...base,
        providerHint: input.providerHint,
        abortSignal: composed,
      };
    }
    if (input.providerHint !== undefined) {
      return { ...base, providerHint: input.providerHint };
    }
    if (composed !== undefined) {
      return { ...base, abortSignal: composed };
    }
    return base;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────

/**
 * Build a `LLMCallOutput` from the router's `RouterCallOutput` plus
 * the facade-measured latency. Kept standalone so the HIT path can
 * be asserted against the same shape builder without duplication.
 *
 * `providerRequestId` is optional per §3.4; `exactOptionalPropertyTypes`
 * forbids attaching `undefined` so we branch.
 */
function buildCallOutput(
  routerOut: {
    readonly modelUsed: string;
    readonly providerUsed: 'anthropic' | 'openai' | 'gemini';
    readonly fundingMode: 'byok' | 'managed';
    readonly message: LLMCallOutput['message'];
    readonly usage: LLMCallOutput['usage'];
    readonly stopReason: LLMCallOutput['stopReason'];
    readonly providerRequestId?: string | undefined;
  },
  latencyMs: number,
): LLMCallOutput {
  if (routerOut.providerRequestId !== undefined) {
    return {
      modelUsed: routerOut.modelUsed,
      providerUsed: routerOut.providerUsed,
      fundingMode: routerOut.fundingMode,
      message: routerOut.message,
      usage: routerOut.usage,
      stopReason: routerOut.stopReason,
      latencyMs,
      providerRequestId: routerOut.providerRequestId,
    };
  }
  return {
    modelUsed: routerOut.modelUsed,
    providerUsed: routerOut.providerUsed,
    fundingMode: routerOut.fundingMode,
    message: routerOut.message,
    usage: routerOut.usage,
    stopReason: routerOut.stopReason,
    latencyMs,
  };
}

/**
 * Parse the 32-char `traceId` portion of a W3C `traceparent` header
 * (format: `version-traceId-spanId-flags`, e.g.
 * `00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`).
 *
 * On malformed input we fall back to a fresh `randomUUID()` — the
 * router only uses the correlationId for log/audit correlation and
 * to mint `make.internal(correlationId)` on unconfigured-provider
 * paths, so a missing upstream id is recoverable (just not stitched
 * to the caller's trace).
 *
 * Exported only so the c3-internal superset decision can be
 * round-tripped in tests; not part of the public surface.
 */
export function deriveCorrelationId(traceparent: string): string {
  if (typeof traceparent !== 'string') return randomUUID();
  const parts = traceparent.split('-');
  if (parts.length < 4) return randomUUID();
  const traceId = parts[1];
  if (traceId === undefined) return randomUUID();
  if (!/^[0-9a-f]{32}$/i.test(traceId)) return randomUUID();
  // Reject the all-zero trace id (W3C "invalid" sentinel).
  if (/^0{32}$/.test(traceId)) return randomUUID();
  return traceId.toLowerCase();
}

/**
 * Race `Promise.all(tasks)` against a `drainTimeoutMs` budget.
 *
 * Returns `'drained'` when every promise resolved within the window,
 * `'timeout'` otherwise. Never throws — individual task rejections
 * are swallowed (the facade's `call()` is non-throwing by contract;
 * a rejected inflight promise would be a contract violation, not a
 * signal to bail on shutdown).
 *
 * Lives as a free function so the close() body stays flat; also
 * exported for test coverage of the "no inflight" branch (length 0
 * resolves immediately `'drained'`).
 */
async function raceDrain(
  tasks: readonly Promise<void>[],
  drainTimeoutMs: number,
): Promise<'drained' | 'timeout'> {
  if (tasks.length === 0) return 'drained';
  const drained: Promise<'drained'> = Promise.allSettled(tasks).then(
    () => 'drained' as const,
  );
  if (!Number.isFinite(drainTimeoutMs) || drainTimeoutMs <= 0) {
    // Zero / negative / non-finite budget means "don't wait" — emit
    // timeout unless all tasks have already settled synchronously
    // (impossible in Node, but cheap to document).
    return 'timeout';
  }
  const timeout = new Promise<'timeout'>((resolve) => {
    // NodeJS.Timeout — `.unref()` prevents the drain timer from
    // keeping the event loop alive past resolution. `tsconfig` pulls
    // in `@types/node` so the return type is always the rich handle.
    setTimeout(() => {
      resolve('timeout');
    }, drainTimeoutMs).unref();
  });
  return Promise.race([drained, timeout]);
}
