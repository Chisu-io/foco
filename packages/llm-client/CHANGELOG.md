# Changelog

All notable changes to `@chisu/llm-client` will be documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and this package adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-04-22 — Release candidate

First tagged version of `@chisu/llm-client`. All of iterations 1–11 of
the signed implementation plan are merged; §18 pendientes (5 items)
closed; `LLM_CLIENT.md v1.1` contract invariants hold.

### State at 0.1.0

- **Coverage**: global 97.68% stmts / 93.78% branch / 97.73% funcs /
  97.68% lines. `src/client.ts` per-file gate ≥95/90/95/95 enforced in
  `vitest.config.ts`.
- **Tests**: 740 specs across 24 files (unit + contract + property).
- **CI gates**: `lint` (ESLint flat config + tseslint strict-type-checked),
  `typecheck` (TS 5.9 strict), `test` (vitest with coverage thresholds),
  `check-keys` (new iter 10 — scans `src/` for literal Anthropic / OpenAI /
  Google key shapes; fails build if any match).
- **Public surface**: `LLMClient` facade with `call` + `close` + `ping`
  + `invalidateUserKey`. Exports for `errors/`, `config/`, `crypto/`,
  `observability/`, `providers/`, `routing/`, `types/`.
- **Flag status**: `llm_routing_enabled` MUST be `false` in production
  GrowthBook until the hosting app (`apps/web/`) wires the
  `UserQuotaRepo` adapter against the Supabase schema. The facade
  rejects calls gracefully if this is not set, but the routing work
  assumes a real quota row exists upstream.

### Added — Iteration 11 (release prep)

- `package.json` version bump `0.0.0` → `0.1.0`.
- `package.json` scripts: new `check-keys` runs the iter 10 linter.
- `README.md` already carries §1–§9 install + usage + contract pointer.
- `CHANGELOG.md` reorganised so the historical iteration notes land
  under `## [Unreleased]` (visible below) and this entry seals the
  cut.

### Added — Iteration 10 (chaos + property-based + CI linter)

- `scripts/check-no-key-in-logs.ts`: standalone TS script (run via
  `tsx`) that walks every `.ts`/`.tsx` file under `src/` and fails
  with exit 1 on any match against three real-shape key patterns:
  Anthropic (`sk-ant-` + 40+ URL-safe), OpenAI (`sk-` / `sk-proj-` +
  40+ alphanumeric), Google (`AIza` + 35 URL-safe). Test fixture
  stubs like `'sk-user'` pass because they fail the length gate.
  Exit codes: 0 clean, 1 matches found, 2 script error.
- `test/property/classify-exhaustive.property.test.ts`: 6 property
  suites exhausting the HTTP status space (0-999) × provider × billing
  combinations. Guarantees `classifyProviderHttpError`:
    1. Never throws, never returns undefined.
    2. `billingError=true` collapses to `quota_exhausted` regardless
       of status.
    3. 5xx (500/502/503/504) always → `provider_down`.
    4. 401/403 always → `invalid_key`.
    5. 429 without billingError → `rate_limit`.
    6. 3xx unknown statuses → `internal` (fail-safe, no silent pass).
- **Not added**: dedicated chaos harness as separate specs. The
  existing unit suite already exercises the fault-injection vectors
  the plan called for — `test/crypto/kek.test.ts` covers KMS
  retry / deadline-skipped-retry; `test/routing/plan-router.test.ts`
  + `test/routing/circuit-breaker.test.ts` cover provider burst /
  fallback / CB transitions; `test/client/client.test.ts`'s `deadline`
  block covers tight-deadline short-circuit. Adding a parallel "chaos"
  directory would duplicate coverage, not extend it. Property-based
  on classification (above) is the genuine gap the plan pointed at.

## [Unreleased]

### Added — Iteration 6 commit 3 (`llm.client.call` root span + `llm.provider.request` sub-span, §10.1)

- `src/routing/plan-router.ts`: emits the two spans defined by
  `LLM_CLIENT.md v1.1` §10.1, using the OTel tracer DI seam shipped in
  iter 6 commit 1 (`getTracer()`).
  - **`llm.client.call`** root span (`SpanKind.CLIENT`) wraps every
    invocation of `route()`. Open attrs: `llm.origin`, `user.id_hash`
    (sha256 hex of `userId` — the raw id never reaches the span).
    Close-success attrs (seven, per the signed mini-spec): `llm.provider`,
    `llm.model`, `llm.input_tokens`, `llm.output_tokens`,
    `llm.funding_mode` (DERIVED from the routing result per R1 — the
    router never receives a `fundingMode` on input), `llm.circuit_state`,
    `llm.latency_ms`. Close-error: only `llm.circuit_state` + status
    `ERROR` with `message = error.kind`. Status `OK` on success.
  - **`llm.provider.request`** sub-span (`SpanKind.CLIENT`) wraps each
    `provider.call(...)` inside `doProviderCall()`. Open attrs:
    `llm.provider`, `llm.model`. Close-success adds `llm.input_tokens`
    + `llm.output_tokens` and status `OK`. Close-error sets status
    `ERROR` with `message = error.kind` (no token counts on failure).
    Breaker-deny short-circuit opens **no** sub-span — the outbound
    HTTP never happens, so there is nothing to observe at the provider
    layer; the root span reflects the denial via `llm.circuit_state`
    at close-error.
  - Active-context propagation: the routing body runs inside
    `context.with(trace.setSpan(context.active(), rootSpan), ...)` so
    the sub-span picks up the root span as parent in production (where
    `@chisu/observability` installs an `AsyncHooksContextManager`). In
    tests without that manager, the sub-span is emitted as an
    independent root — the hermetic specs assert per-span content,
    not hierarchy.
  - `route()` deliberately bypasses the iter 6 commit 1 `withSpan`
    helper. Two reasons (R3 of the signed mini-spec): (1) `route()`
    never throws — it returns `Result<_, LLMCallError>` per §3.5 —
    and `withSpan` would auto-stamp `SpanStatusCode.OK` on return,
    overwriting the manual `ERROR` we set on the `Result.err` branch;
    (2) `LLMCallError` is a tagged union, not an `Error`, so
    `recordException(...)` would lie about the stack. The taxonomy is
    the audit trail per §14.3 — we never `recordException` a
    `Result.err`. The same justification applies to `doProviderCall`'s
    sub-span path, which also uses `tracer.startSpan(...)` directly.
  - Helper `stampRootSpanClose(rootSpan, result, requiredProvider,
    latencyMs)` extracted to keep `route()` readable. Knows the success
    vs error attribute contracts and stamps the manual status.
  - **R2 carve-out**: `trace.idempotency_key_hash` is **deliberately
    omitted** in commit 3. `RouteInput` does not carry an idempotency
    key in the iter 6 surface; the iter 7 client facade owns it and
    will stamp the attribute when it threads its own `idempotencyKey`
    through to the router. A canary test in
    `test/routing/plan-router.test.ts` enforces the omission across
    every emitted span.
  - Latency measured with `performance.now()` to avoid wall-clock
    drift; rounded to integer milliseconds before stamping.
- `test/routing/plan-router.test.ts`: new describe block
  `PlanRouter — OTel spans (iter 6 commit 3, §10.1)` with hermetic
  setup (`BasicTracerProvider` + `SimpleSpanProcessor` +
  `InMemorySpanExporter`, injected via `setTracer`; reset via
  `resetTracer` + `exporter.reset()` + `provider.shutdown()` in
  `afterEach`). Ten new specs:
  1. Happy BYOK (Free) — root has all seven close attrs + `OK`;
     sub-span has token counts + `OK`; both kind `CLIENT`.
  2. Happy Managed (Influencer, default `preferMyKey=false`) — root
     stamps `llm.funding_mode='managed'` (R1 — derived from routing
     result, not from input).
  3. BYOK → Managed fallback on `invalid_key` — two sub-spans (BYOK
     `ERROR(invalid_key)`, Managed `OK`); root `OK` with
     `llm.funding_mode='managed'`.
  4. Breaker deny — root `ERROR(provider_down)`, `llm.circuit_state='open'`,
     no sub-span emitted, no `events` (R3 canary — taxonomy is the
     audit trail).
  5. Provider error (`rate_limit` on Free BYOK) — root + sub-span
     both `ERROR(rate_limit)`; sub-span has no token counts; neither
     span has any `events`.
  6. `plan_requires_key` (Free with no key) — root `ERROR`, no
     sub-span (resolver never reached).
  7. Unregistered provider (misconfigured registry) — root
     `ERROR(internal)`, no sub-span.
  8. **R2 canary** — `trace.idempotency_key_hash` is **never** present
     on any emitted span across three representative paths.
  9. **Zero-leak §14.3** — no raw key material (`sk-…`), `Bearer`
     token, `Authorization` header, or raw `userId` appears in any
     span attribute value.
  10. **No-op tracer fallback** — `resetTracer()` then `route()` still
      succeeds; exporter sees zero spans (DI seam contract from iter 6
      commit 1).
- Imports added at the top of `test/routing/plan-router.test.ts`:
  `afterEach` from vitest, `SpanKind` + `SpanStatusCode` from
  `@opentelemetry/api`, `BasicTracerProvider` +
  `InMemorySpanExporter` + `SimpleSpanProcessor` from
  `@opentelemetry/sdk-trace-base`, `hashUserId` + `resetTracer` +
  `setTracer` from `src/observability/tracing.ts`.
- No public surface change. `src/routing/index.ts` barrel is
  untouched — every span emission stays in `plan-router.ts`. No new
  runtime dependency: `@opentelemetry/api` is already a `dependency`
  (added in commit 1) and `@opentelemetry/sdk-trace-base` is already
  a `devDependency`.

### Added — Iteration 6 commit 2 (correlationId threading + provider trace headers)

- `src/routing/events.ts`: two net-new types formalising the
  routing-layer call context (§3.3 lines 285–287 of the signed
  `LLM_CLIENT.md v1.1`). `OriginKind` is a closed three-member union
  (`caption-refine` | `hook-brainstorm` | `mcp-server-callback`) —
  widening it requires a contract amendment per `feedback_foco_three_contracts_rule`.
  `ProviderCallContext` is the **routing-internal** shape with
  `correlationId` (required), optional `deadline` and `idempotencyKey`,
  and `fundingMode` + `origin` (required). Only `correlationId` crosses
  the adapter boundary — the adapter does not see `fundingMode`,
  `origin`, `deadline`, or `idempotencyKey` (keeping adapters BYOK/
  Managed-agnostic and free of attribution concerns).
- `src/routing/plan-router.ts`: `RouteInput` gains `correlationId:
  string` and `origin: OriginKind` — both **required, additive** (P1).
  `doProviderCall()` signature extended with a `correlationId` arg that
  is passed verbatim to `provider.call({ …, correlationId })` at all
  three call sites (BYOK attempt, Managed direct, Managed fallback).
  The internal-error branch at the misconfigured-registry path now
  surfaces `input.correlationId` verbatim instead of minting a fresh
  random id via the old `newCorrelationId()` helper (P10) — this keeps
  the root span (iter 6 commit 3) and the `internal` error on the same
  identity so post-hoc stitching in Grafana + audit_log stays exact.
  The `newCorrelationId()` function has been removed and its
  `node:crypto` `randomBytes` import dropped.
- `src/providers/provider.ts`: `ProviderCallInput` gains
  `correlationId: string` (required, P11). This is the **only** piece
  of `ProviderCallContext` that crosses the adapter boundary. Adapters
  stamp it into the outbound HTTP request; the router, not the adapter,
  owns hashing the `idempotencyKey` and mapping `fundingMode` → span
  attribute.
- `src/providers/anthropic.ts`: outbound HTTP emits header
  `anthropic-trace-id: <correlationId>` (lowercase name per Anthropic's
  convention). The id is written as-is — no hashing, no truncation.
  `ping()` is a probe, not a call-surface; it does NOT emit the header.
- `src/providers/openai.ts`: outbound HTTP emits header
  `X-Request-ID: <correlationId>` (canonical caps per OpenAI's
  convention). Same handling as Anthropic — only `call()`, never
  `ping()`.
- `src/providers/gemini.ts`: Gemini (AI Studio) has no standard trace
  header. The adapter **deliberately emits none** — the correlationId
  still flows into the local span and the audit trail via the router;
  it just does not leave the outbound wire. Documented as an explicit
  non-decision so a future Gemini header (e.g. `x-goog-request-id`)
  can be added behind a feature flag without a contract amendment.
- `test/routing/plan-router.test.ts`: test harness updated. `RouteInput`
  helpers `routeAsFree` and `routeAsInfluencer` seed every route with
  module-level defaults (`DEFAULT_CORR_ID`,
  `DEFAULT_ORIGIN = 'caption-refine'`); the 7 direct `router.route({...})`
  call sites are updated to pass both fields. `FakeProvider.callLog`
  now captures `correlationId` so specs can assert propagation. Three
  new specs: (a) happy-path Influencer-Managed call threads
  `RouteInput.correlationId` verbatim into
  `ProviderCallInput.correlationId`; (b) BYOK → Managed fallback on
  `invalid_key` reuses the **same** correlationId on both physical
  provider calls (from the outside they are one logical LLM call);
  (c) two concurrent `route()` calls with distinct ids keep their ids
  isolated (canary against aliasing bugs in mutable module state).
  The misconfigured-registry spec (internal-error path) was rewritten:
  the assertion changed from a 16-hex regex match to an equality check
  against the caller-supplied correlationId, locking down P10.
- `test/providers/{anthropic,openai,gemini}.test.ts`: every
  `provider.call({...})` site now passes `correlationId: CORR_ID`
  (provider-local constant). New describe blocks assert the trace
  header plumbing end-to-end: Anthropic emits
  `headers['anthropic-trace-id']`, OpenAI emits `headers['X-Request-ID']`,
  Gemini emits NEITHER (nor `x-request-id`). All three specs verify
  the id does not leak into URL or body, and that `ping()` never
  emits the header.
- `test/routing/events.test.ts`: new structural-contract describe
  blocks for `ProviderCallContext` (minimum shape with just
  `correlationId` + `fundingMode` + `origin`; fully-populated shape
  including `deadline` + `idempotencyKey`; `exactOptionalPropertyTypes`
  discipline — absent fields must NOT be set to `undefined` in the
  object literal) and `OriginKind` (exhaustiveness canary: the array
  literal `['caption-refine','hook-brainstorm','mcp-server-callback']`
  typechecks only while the union has exactly three members; `switch`
  exhaustiveness via a `const fallthrough: never = o` branch).
- `src/routing/index.ts` and `src/index.ts` barrels: `OriginKind` and
  `ProviderCallContext` exported. Consumers get them from
  `@chisu/llm-client/routing` directly, or through the package root
  via the existing `export *` pass-through.
- `README.md`: new "§ correlationId + trace headers" section
  documenting the three invariants: (1) the caller supplies a
  `correlationId`, the router threads it, the adapter stamps it; no
  layer mints a new one on the happy path; (2) `ProviderCallContext`
  is routing-internal, `ProviderCallInput` is adapter-facing and only
  `correlationId` crosses the boundary; (3) header conventions are
  provider-specific: Anthropic `anthropic-trace-id`, OpenAI
  `X-Request-ID`, Gemini none.

This commit only **threads** the correlation id — the OTel root span
(`llm.client.call`), the `llm.provider.request` sub-span, and the
`llm.kms.decrypt_dek` sub-span are still deferred to commit 3.
Breaker API (`isCallAllowed` / `record` / `currentState`) stays intact
per P3 of the iter 6 §8.1 divergence-resolution; no `execute(fn)`
method is added (would widen the signed contract without an
adjustment). Deadline propagation into `kek.ts::kmsCallOnce` lands in
commit 5.

### Added — Iteration 6 commit 1 (OTel tracer DI seam + `withSpan` helper)

- `src/observability/tracing.ts`: tracer DI seam (`setTracer(t)` /
  `resetTracer()` / `getTracer()`) plus `withSpan(name, attrs, fn,
  options?)` async helper that drives the
  start → run → setStatus → recordException → end lifecycle of every
  span this package emits. The seam exists so tests can install a
  `BasicTracerProvider` bound to an `InMemorySpanExporter` for
  hermetic span assertions; production resolves the tracer through
  `@opentelemetry/api`'s global registration (no-op when no SDK is
  registered, zero cost at call sites). `withSpan` re-throws after
  recording — callers see the original error, observability stays
  out-of-band.
- `src/observability/tracing.ts`: `hashUserId(userId)` and
  `hashIdempotencyKey(key)` helpers — `sha256(utf8)` hex digests, no
  salt. Used in iter 6 commits 3 and 4 to populate the `user.id_hash`
  and `trace.idempotency_key_hash` span attributes of `llm.client.call`
  per `LLM_CLIENT.md §10.1` and §7(E) of the iter 6 mini-spec
  (`foco/.cmsgs/iter6-otel-correlation-design.md`). Hash-only because
  the digest is a correlation key, not a long-term storage primitive.
- `src/observability/tracing.ts`: re-exports `SpanKind`,
  `SpanStatusCode` (values) and `Span`, `Tracer` (types) from
  `@opentelemetry/api` so consumers do not need to add `@opentelemetry/api`
  as a direct dep just to type a `withSpan` callback.
- `src/observability/index.ts`: barrel extended with the tracing
  surface (`withSpan`, `setTracer`, `resetTracer`, `getTracer`,
  `hashUserId`, `hashIdempotencyKey`, `SpanKind`, `SpanStatusCode`,
  types `Span` / `Tracer` / `SpanAttrs` / `WithSpanOptions`).
  Re-exported through `src/index.ts` as part of the existing
  `observability` star-export — no consumer-side imports change.
- `test/observability/tracing.test.ts`: 14 specs covering happy path,
  attribute pass-through (initial + late `setAttribute`), `SpanKind`
  honored, error path (`SpanStatusCode.ERROR` + `recordException` +
  rethrow + `span.end()`), non-`Error` throw wrapped into `Error` for
  `recordException`, attribute-bag cloned (mutating the original
  post-emit does not retroactively change recorded attrs), DI seam
  round-trip (`setTracer` / `resetTracer` / `getTracer` identity),
  no-op fallback path completes without error, `hashUserId`
  determinism + 64-char hex + canonical sha256 known-value + utf-8
  handling, `hashIdempotencyKey` aliasing semantics. Tests build
  spans through a real `BasicTracerProvider` with `spanProcessors`
  passed in the constructor (OTel JS ≥1.26 contract — the legacy
  `addSpanProcessor` API is deprecated) feeding an
  `InMemorySpanExporter`; provider is shut down in `afterEach` to
  avoid cross-spec leakage.
- `package.json`: `@opentelemetry/api` added to `dependencies` at
  `^1.9.0` per §7(C) of the iter 6 mini-spec; the API package is
  no-op without an SDK, so the runtime cost is exactly the
  `try/finally` of `withSpan`. `@opentelemetry/sdk-trace-base` added
  to `devDependencies` at `^1.29.0` so tests can wire a hermetic
  exporter without dragging the SDK into the runtime bundle.
- `README.md`: new "Observability — tracing" section documents the
  five invariants (single point of span creation; no global side
  effect; tests inject tracer; hash plain-sha256; scalar-only
  attributes), the typical call shape, and the iter 8 facade
  policy for `correlationId` (fail-closed in prod, auto-gen in dev).
  Listed in the "Public surface" example so consumers see the new
  exports alongside `NOOP_METRICS` / `InMemoryMetrics`.

This commit only ships infrastructure — no span is actually emitted
by any production call site yet. Spans land in iter 6 commits 3
(`llm.client.call` root + `llm.provider.request` HTTP sub-span) and
4 (`llm.kms.decrypt_dek` BYOK sub-span); commit 2 threads the
required `correlationId: string` through router + providers; commit 5
wires deadline propagation onto the existing KMS retry loop in
`kek.ts::kmsCallOnce` per §6 of the mini-spec (the breaker keeps its
current `isCallAllowed` / `record` / `currentState` API — no `execute`
method is added in iter 6 because that would widen `LLM_CLIENT.md`
without a signed adjustment, per P3 of the §8.1 divergence resolution).

### Added — Iteration 5 (audit sink for CB state transitions)

- `src/routing/audit-sink.ts`: `createCircuitAuditSink(deps)` factory.
  Returns an `OnCircuitStateChange` callback — pluggable into
  `createCircuitBreaker({ onStateChange })` — that maps CB transitions
  to `SystemAuditEntry` **drafts** (`LLM_CLIENT.md §11`) and delegates
  persistence to an injected `AuditWriter`. The other two transitions
  (`open→half-open`, `half-open→open`) are NOT auditable per §11 — they
  increment `llm_audit_ignored_transitions_total{from,to}` instead. The
  writer owns the hash chain (`id` / `sequence` / `prevHash` /
  `rowHash`) per `PRODUCTION_READINESS.md §3`; `llm-client` stays
  DB-agnostic (no `pg` / `drizzle` / `supabase-js` dep — the writer
  adapter is the integration point). `AuditEntryDraft` is declared as
  `Omit<SystemAuditEntry, 'id' | 'sequence' | 'prevHash' | 'rowHash'>`
  with `SystemAuditEntry` / `SystemActor` / `SystemActorKind` imported
  **type-only** from `@chisu/schemas` — the draft shape is compile-
  time-coupled to the signed schema, so any upstream addition of a
  kind or field becomes a compile-time error inside this package
  rather than a runtime validation failure at the hosting boundary.
  Fire-and-forget via
  `queueMicrotask`; failure paths catch synchronous writer throws,
  `Promise<err(...)>` returns, non-Result promise rejections, throwing
  loggers, and throwing metric sinks — all land on
  `llm_audit_write_failures_total{action, reason}` without
  rethrowing. CB audit is diagnostic, not legal (the `llm.key_*` sinks
  in later iterations will `await` with bounded retry from the
  handler that originated the mutation). Actor defaults to
  `{ kind: 'system' }` — CB transitions are not user-triggered.
  `event.at` is the authoritative transition timestamp; `deps.now()`
  (or `Date.now`) is only used as a fallback when `at` is absent.
- `src/routing/audit-sink.ts` exports the pure helpers
  `auditActionForTransition(from, to)` (maps the 2 auditable pairs to
  `'llm.circuit_opened'` / `'llm.circuit_closed'`, `undefined` for the
  2 non-auditable ones) and `buildAuditDraft(event, action, deps)`
  (extracted so tests can exercise the mapping independently from the
  async write path). Both are covered end-to-end + through the sink.
- `src/routing/index.ts`: barrel extended with the new public surface
  (`createCircuitAuditSink`, `buildAuditDraft`,
  `auditActionForTransition`, `AUDIT_SINK_METRIC_NAMES`, the types
  `AuditEntryDraft` / `AuditSinkDeps` / `AuditSinkLogger` /
  `AuditWriter` / `AuditWriteError`, and the `SystemActor` /
  `SystemActorKind` re-exports from `@chisu/schemas` for consumer
  convenience). No new subpath export — everything ships from the
  existing `@chisu/llm-client/routing` entry point.
- `package.json`: new workspace dependency `@chisu/schemas:
  workspace:*` in `dependencies` (not `peerDependencies`). Rationale:
  the package already has a hard runtime dep on `zod` for the same
  purpose (normalised request validation), so the coupling to the
  signed schema workspace is already established on the runtime
  axis — declaring `@chisu/schemas` as a regular dep is consistent
  with that and makes the compile-time coupling explicit. The
  `import` is type-only so there is zero runtime/bundle impact; a
  later move to `peerDependencies` is reversible if/when
  `@chisu/llm-client` is published independently.
- `test/routing/audit-sink.test.ts`: ~810 lines with a fake
  `AuditWriter` harness (`makeFakeWriter()` with a behaviour queue;
  `throwingSyncWriter(err)` for the synchronous-throw branch),
  `flushMicrotasks()` that drains 4 ticks so the `queueMicrotask` →
  `.then` / `.catch` chain settles, and pinned-clock deps (`FIXED_NOW`
  → `'2023-11-14T22:13:20.000Z'`). 9 describe blocks:
  `auditActionForTransition` (5 tests: opened, closed, 2 ignored,
  identity); `buildAuditDraft` (6 tests: opened full body, closed
  minimal body, omit-undefined discipline, actor override, `deps.now`
  fallback when `event.at` is absent, `Date.now` default);
  happy-path roundtrip (opened, closed, sync void return);
  non-auditable transitions (`open→half-open`, `half-open→open`,
  `llm_audit_ignored_transitions_total` not dedup'd across calls);
  zero-key invariant (§14.3 regex scan over each produced draft,
  parameterised across 3 providers + a closed-union lock on
  `CircuitStateChangeEvent['reason']`); writer failures (all 4
  `AuditWriteError` kinds looped + async non-Result rejection +
  synchronous throw + non-Error rejection + throwing logger +
  throwing metrics, all land on the counter with reason
  `'internal'` where applicable); actor default + service override;
  per-event isolation + concurrency (3 interleaved events, failure
  count not multiplied, audited / ignored interleaving); deps shape
  (works with logger omitted).
- `test/routing/events.test.ts`: ~80 lines, 4 test cases covering the
  defensive default branches of `gaugeValueForState` and
  `classifyOutcomeForBreaker` (lines 53, 125, 212–220 of
  `events.ts`). Bypasses TypeScript with `as unknown as CircuitState`
  / `as unknown as LLMCallError` to reach the
  `assertNeverState` / `assertNeverKind` bottoms — these branches are
  unreachable from correctly-typed call sites but exist to catch
  drift if a future variant lands without updating the switch. The
  happy-path assertions for both helpers remain in
  `circuit-breaker.test.ts`; this file is strictly about the
  defensive branches, kept in its own commit (`test(llm-client): cover
  events.ts exhaustiveness helpers`) so the intent is legible in diff.
  Closes the iter 4 coverage gap flagged during verification
  (75.6 stmts / 50 funcs on `events.ts`).
- Invariants (README §9–12): audit sink is non-blocking and
  non-throwing; audit draft carries no key material; hash chain stays
  with the writer; only §11 transitions are persisted.

### Deferred from Iteration 5

- **No `system_audit` migration in this iteration.** `packages/db/`
  doesn't exist yet in the monorepo; the migration + schema SQL
  belongs to the hosting app iteration (iter 7+) where the DB
  dependency lives. The writer adapter is the integration point.
- **No `correlationId` added to `CircuitStateChangeEvent`.** CB
  transitions are window-threshold-crossing (global per provider),
  not per-request — propagating an individual request's correlation
  id into the transition would misattribute the signal. Adding it
  would require a signed §4.2 adjustment to the contract.

### Added — Iteration 4 (plan-aware routing + circuit breaker)

- `src/routing/events.ts`: types-only foundation for the routing layer.
  `CircuitState` (`closed` | `half-open` | `open`), `CircuitOutcome`
  (`success` | `failure` | `neutral`), `CircuitDecision` (`allow` |
  `probe` | `deny_open` | `deny_probes_exhausted`),
  `CircuitStateChangeEvent` (carries `errorRate` + `volume` on
  `closed → open`, omitted on the other three), `OnCircuitStateChange`
  callback alias. Pure helpers `gaugeValueForState` (§10.2 gauge
  encoding: `closed=0 · half-open=1 · open=2`) and
  `classifyOutcomeForBreaker(err)` — total function over
  `LLMCallError['kind']`, maps `provider_down` / `network_error` /
  `rate_limit` / `internal` → `failure`; everything else → `neutral`
  (including `quota_exhausted` per iter 4 BYOK policy; iter 7 router
  will override this for the Managed pool rotation signal).
- `src/config/flag-reader.ts`: narrow `FlagsReader` contract
  (`get<K extends LLMFlagName>(name: K): number`) separated from
  `flag-defaults.ts` (schema) and `flag-validation.ts` (boot-time
  validator). `createStaticFlagsReader(values)` snapshots the values
  eagerly via `Object.freeze({...values})` so post-construction
  mutation of the caller's object cannot retroactively change observed
  values. Pull-on-call pattern — no second cache layer stacked on top
  of GrowthBook's own.
- `src/routing/circuit-breaker.ts`: `createCircuitBreaker(deps)`
  factory. Per-provider sliding-window breaker. Volume counts only
  failures + successes (neutrals observed but excluded from both
  volume and rate). Tripping check is **strictly `errorRate >
  errorThreshold`** so a rate exactly at threshold does not open the
  circuit. Lazy cooldown resolution (`maybeOpenToHalfOpen` called at
  the top of every public method — no `setTimeout`). Recovery
  (`half-open → closed`) resets the window so old failures don't drag
  the provider back open after a fresh sample or two. Neutral probes
  release their reservation slot but do NOT count toward the success
  quota — the breaker stays `half-open` until a real signal arrives.
  `probesInFlight` clamped at 0 on the decrement path to tolerate
  out-of-order `record()` calls. Emits `llm_circuit_state{provider}`
  gauge + `llm_circuit_transitions_total{provider,from,to,reason}` +
  `llm_circuit_decisions_total{provider,decision}` +
  `llm_circuit_outcomes_total{provider,outcome}` (§10.2). Invokes
  `onStateChange` synchronously on every transition; audit wiring for
  `llm.circuit_opened` / `llm.circuit_closed` (§11) lands in iter 6
  behind this hook. State gauge is seeded on first `stateFor()` touch
  so Prometheus doesn't render a gap before the first transition.
- `src/routing/plan-router.ts`: `createPlanRouter(deps)` factory
  implementing the §4.1 decision matrix. Free / Creator route
  **BYOK-mandatory** — provider mismatch, `status ∉ {active, pending}`
  and resolver errors all short-circuit before any HTTP work, incrementing
  `llm_router_resolve_failures_total{plan,reason}`. On a successful
  BYOK call the router stamps `fundingMode: 'byok'` onto the provider
  output; on `invalid_key` it **replaces the raw error with
  `plan_requires_key` and fires `onByokKeyInvalidated`** so iter 5 can
  mark the `user_llm_key` row invalid and notify the user.
  Influencer / Celebrity with `preferMyKey=true` tries BYOK first;
  falls back to Managed on any per-key transient —
  `invalid_key` | `quota_exhausted` | `rate_limit` | `network_error` —
  per **Ajuste 6 FULL** (signed 2026-04-18, review 2026-04-19).
  `rate_limit` buckets live on the API key in all three MVP providers
  so Managed has an independent bucket; `network_error` is per-call
  transient and a Managed retry may land on a different
  DNS/keepalive path. The invalidation callback fires **only** on
  `invalid_key` — the other three triggers leave the `user_llm_key`
  row untouched. `provider_down` is NOT a fallback trigger because
  the §4.2 circuit breaker already short-circuits provider-wide
  outages upstream. Resolver failure (e.g. `kms_unavailable`) is
  surfaced because Managed uses the same KMS. Studio routes Managed;
  alternate-pool rotation is deferred to iter 7 behind the same
  callback seam. Circuit-breaker
  integration: `breaker.isCallAllowed(provider)` is consulted before
  every HTTP call — `deny_open` / `deny_probes_exhausted` short-circuit
  to `provider_down{circuitOpen: true}` and increment
  `llm_router_cb_denies_total`. Successful calls and errors classified
  by `classifyOutcomeForBreaker` are recorded with
  `breaker.record(...)`. `providerForModel(model)` exhaustively maps
  the 7 MVP `ModelId`s; `routingMismatchUserMessage` is exported so
  the UI (iter 7+) has a single source of truth for the mismatch copy
  (the taxonomy's `plan_requires_key` variant carries only `{ kind,
  plan }` — no `userMessage` field). Correlation IDs from
  `node:crypto` `randomBytes(8).toString('hex')` (iter 6 will swap for
  OTel span ids).
- `src/routing/index.ts`: barrel re-exporting the CircuitBreaker +
  PlanRouter public surface, metric-name tables (`CB_METRIC_NAMES`,
  `ROUTER_METRIC_NAMES`), types (`CircuitState`, `CircuitOutcome`,
  `CircuitDecision`, `CircuitStateChangeEvent`, `OnCircuitStateChange`,
  `Plan`, `BYOKStatus`, `UserQuota`, `ResolvedKey`, `ApiKeyRequest`,
  `ApiKeyResolver`, `ProviderRegistry`, `RouteInput`,
  `RouterCallOutput`, `PlanRouter`, `PlanRouterDeps`), and helpers
  (`providerForModel`, `routingMismatchUserMessage`,
  `classifyOutcomeForBreaker`, `gaugeValueForState`).
- Public surface: new subpath export `@chisu/llm-client/routing` —
  and the matching entry in `publishConfig.exports`.
- `test/routing/circuit-breaker.test.ts`: ~500 lines. Covers
  `gaugeValueForState`, `classifyOutcomeForBreaker` (failure + neutral
  mappings including `quota_exhausted → neutral`), closed-state
  behaviour (initial allow, gauge seed on first touch, below-volume
  stays closed, strict `>` threshold, neutral exclusion, pruning),
  `open → half-open → closed` (deny while open, lazy cooldown via
  injected clock, probe budget exhaustion, recovery after N successes
  with window reset, `half-open → open` on first probe failure,
  neutral probes release slot but keep state half-open), metrics
  surface (CB_METRIC_NAMES counters + gauge), `onStateChange` sync
  invocation + safe omission, per-provider isolation, `Date.now`
  default, and `FlagsReader` contract (all 5 §16 CB flags exposed,
  post-construction mutation ignored).
- `test/routing/plan-router.test.ts`: ~600 lines with `FakeProvider` +
  `FakeResolver` harnesses (queue-per-mode resolver; queue-per-call
  provider). Includes **Jean's explicit ajuste-6 test case**:
  Influencer+ `preferMyKey=true`, BYOK returns `invalid_key` → router
  calls managed resolver + provider, stamps `providerUsed`,
  increments `llm_router_fallbacks_total{reason=invalid_key}`, AND
  fires `onByokKeyInvalidated` with the correct provider. Decision
  matrix tests cover Free/Creator (no key, mismatch, `invalid`,
  `quota_exhausted`, `pending` status accepted, resolver failure,
  success, `invalid_key` → `plan_requires_key` + callback,
  `provider_down` surfaced), Influencer/Celebrity (`preferMyKey=false`
  → Managed direct; `preferMyKey=true` + success → BYOK;
  `preferMyKey=true` + `invalid_key` → Managed fallback + callback;
  `preferMyKey=true` + `quota_exhausted` → Managed fallback, NO
  callback; `preferMyKey=true` + `rate_limit` → Managed fallback, NO
  callback (Ajuste 6 FULL); `preferMyKey=true` + `network_error` →
  Managed fallback, NO callback (Ajuste 6 FULL);
  `preferMyKey=true` + `provider_down` → surfaced (CB covers it);
  `preferMyKey=true` + BYOK resolver fails → surfaced;
  mismatched BYOK provider → Managed direct; non-active BYOK status
  → Managed direct; Managed resolver failure surfaced; celebrity
  treated like influencer), Studio (Managed direct even with
  `preferMyKey=true`), CB integration (open breaker short-circuits
  with no HTTP call; real breaker tripped after 3 provider_downs
  produces `provider_down{circuitOpen:true}`), deployment
  misconfiguration (`internal` error with 16-hex correlationId when
  provider is not registered), and AbortSignal plumbing.

### Added — Iteration 3 (provider adapters)

- `src/types/request.ts`: `ModelId` union (7 MVP model ids across the
  three providers), `NormalizedLLMRequest` / `NormalizedMessage` /
  `NormalizedContentBlock` / `NormalizedTool` / `ResponseFormat` — the
  wire-format-agnostic shape the router hands to a provider. Role
  `'tool'` is represented as a first-class discriminant so the OpenAI
  and Gemini adapters can fold it into their provider-specific layout
  without string-matching.
- `src/types/response.ts`: `ProviderCallOutput` / `PingOutput` /
  `LLMCallOutput` / `UsageCounts` / `StopReason`. Deliberately excludes
  `fundingMode` and `latencyMs` — those are the router's job per
  LLM_CLIENT.md §9.4.
- `src/http/client.ts`: narrow `HttpClient` abstraction
  (`(HttpRequest) => Promise<HttpResponse>`) + `HttpTransportError`
  discriminated class. `fetchHttpClient` is the default implementation,
  walks the `cause` chain up to 5 hops mapping undici / node error
  codes (`ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, `ECONNREFUSED`,
  `EAI_AGAIN`, `ENOTFOUND`, `ECONNRESET`, TLS …) to a kind enum. DI
  seam keeps `msw` and `undici.MockAgent` out of the provider test
  harness entirely.
- `src/providers/provider.ts`: `Provider` interface (`call` + `ping`
  returning `Result<ProviderCallOutput|PingOutput, LLMCallError>`),
  four documented invariants (never throws, no key material in
  errors, no I/O side-effects beyond HTTP, body buffering).
- `src/providers/anthropic.ts`: `createAnthropicProvider` factory.
  Targets `POST https://api.anthropic.com/v1/messages` with
  `x-api-key` + `anthropic-version: 2023-06-01`. Translates
  `system`/`user`/`assistant`/`tool` messages to Anthropic's
  `messages` + `system` fields, tool_use ↔ tool_result blocks,
  `input_tokens`/`output_tokens` → `UsageCounts`, `stop_reason`
  enum → `StopReason`. HTTP 529 (overloaded) collapsed to 503 per
  §7.1. `ping` uses Haiku + `max_tokens: 1` to keep the probe cheap.
- `src/providers/openai.ts`: `createOpenAIProvider` factory. Targets
  `POST https://api.openai.com/v1/chat/completions` with
  `Authorization: Bearer`. `systemPrompt` is prepended as a `system`
  message (OpenAI has no separate field). Tool calls are emitted as
  assistant `tool_calls[]` with JSON-stringified `arguments`;
  provider-side JSON-decoded back into `NormalizedContentBlock.input`
  on the inbound path. Rate-limit headers (`x-ratelimit-remaining-*`,
  `x-ratelimit-reset-*`) parsed — including compound durations like
  `"1m30s"` — into `rateLimitHints`. **`finish_reason: content_filter`
  short-circuits to `err(make.contentBlocked('policy'))`** — it is an
  error, not a successful completion. `insufficient_quota` error code
  on HTTP 429 is promoted to `quota_exhausted{billingError: true}`
  per the §7.1 billing short-circuit.
- `src/providers/gemini.ts`: `createGeminiProvider` factory. Targets
  `POST {base}/{model}:generateContent` with **`x-goog-api-key`
  header — never `?key=` query param** (§2 invariant 1 — no key
  material in URL). Role translation: `assistant` → `'model'`,
  `tool` → `'user'` with a `functionResponse` part.
  `systemInstruction` is a separate top-level field (Gemini does not
  accept a system role inside `contents[]`). `tools` wraps all
  definitions in a single `functionDeclarations` container.
  `FinishReason: SAFETY | RECITATION` and `promptFeedback.blockReason`
  short-circuit to `err(make.contentBlocked('safety'))`. HTTP 400
  with body containing `"API key not valid"` → `invalid_key` (Google
  uses 400 where others use 401). 403 / 429 with a billing keyword
  (`billing` / `quota project` / `free tier` / `daily limit`) is
  classified as `quota_exhausted{billingError: true}`; otherwise 403
  → `invalid_key` and 429 plain → `rate_limit`. `functionCall` parts
  synthesise a `toolUseId` of `${name}-${ordinal}` (Gemini has no
  first-class tool_use id) and promote `STOP` → `'tool_use'` when
  present.
- `src/providers/index.ts`: barrel re-exporting the three factories,
  their `*Deps` types, the endpoint / model / timeout constants, and
  the `Provider` / `ProviderCallInput` / `ProviderPingInput` types.
  `ProviderName` is intentionally **not** re-exported here — it stays
  canonical at `./errors` per §9.4 to avoid an `export *` collision
  at the package root.
- Public surface: new subpath exports `@chisu/llm-client/http`,
  `@chisu/llm-client/providers`, `@chisu/llm-client/types` — and the
  matching entries in `publishConfig.exports` for when the package
  publishes its built `dist/`.
- `test/providers/_fake-http.ts`: `fakeHttp(resolver)`,
  `throwTransport(kind)`, `jsonResponse(status, body, headers?)`,
  and `neverTimeout` — the minimal test harness for all three
  adapters. No real timers, no real sockets, no MSW.
- `test/providers/anthropic.test.ts`: ~350 lines covering outbound
  wire format (endpoint, headers, role translation, `input_schema`
  propagation, no key in URL), inbound parsing (text + usage +
  `providerRequestId`, tool_use blocks, stop_reason mapping,
  malformed JSON → `provider_down`), and §7.1 error mapping for
  401/402/429 (with `retry-after`)/500/502/503/504/**529 collapsed
  to 503**/400+context/400+policy, plus transport timeout / DNS
  failure, and a `ping` success.
- `test/providers/openai.test.ts`: ~370 lines covering Bearer auth,
  system-prompt prepending, sampling params, tool fan-out,
  `tool_call_id` messages, `finish_reason: length → max_tokens`,
  `tool_calls` JSON-decoded to `NormalizedContentBlock.input`,
  **`finish_reason: content_filter` → `content_blocked` error (not
  success)**, 401 / 402 / 429 plain / 429 + `insufficient_quota`
  (billing short-circuit) / 400 + `context_length_exceeded` / 400 +
  `content_filter` / 500 / TCP transport, and ping with rate-limit
  hints (`remainingRequests: 99`, `remainingTokens: 1234`,
  `resetSec: 90` parsed from `"1m30s"`).
- `test/providers/gemini.test.ts`: ~400 lines covering
  `{base}/{model}:generateContent` URL composition,
  `x-goog-api-key` header with **explicit `expect(url).not.toContain
  ('key=')` assertion**, separate `systemInstruction`,
  `generationConfig` nesting, `assistant → 'model'` and
  `tool → functionResponse` role translation, `functionDeclarations`
  wrapping, `candidates` / `usageMetadata` / `modelVersion` parsing,
  `MAX_TOKENS`, `functionCall` → `tool_use` with stop `'tool_use'`,
  `SAFETY` / `RECITATION` / `promptFeedback.blockReason` →
  `content_blocked{safety}`, **HTTP 400 + `"API key not valid"` →
  `invalid_key`**, 401 `UNAUTHENTICATED` → `invalid_key`, 403 +
  billing → `quota_exhausted`, 403 plain → `invalid_key`, 429 +
  billing → `quota_exhausted`, 429 plain → `rate_limit{retryAfterSec:30}`,
  400 + context, 500/502/503/504, TLS transport, and ping.

### Added — Iteration 2 (envelope encryption)

- `src/crypto/sharding.ts`: `shardCountFor(kekVersion)` (function, not
  constant — extension point for §5.3 rebalance) and `shardId(userId,
  kekVersion)` using SHA-256 + BigInt mod for unbiased uniform
  distribution. `v1` registered with `N = 8` (capacity ≈8 000 users,
  power of two). `knownKekVersions()` for the rebalance runbook.
- `src/crypto/dek.ts`: AES-256-GCM primitives — `generateDek`,
  `encryptWithDek`, `decryptWithDek`, plus `zeroize(Buffer|Uint8Array)`.
  Nonce is 12 bytes, auth tag is 16 bytes; defensive assertions against
  wrong sizes. Pure (no I/O, no KMS).
- `src/crypto/kek.ts`: `@aws-sdk/client-kms` v3 wrappers `kmsEncrypt` /
  `kmsDecrypt` with the canonical alias `alias/foco/kek/v${v}/shard-${s}`.
  `KMSClient` is dependency-injected (no custom wrapper) so
  `aws-sdk-client-mock` can substitute it cleanly in tests. Hard-capped
  retry budget `KMS_MAX_ATTEMPTS = 2` (original + 1), jitter 50–250ms
  (configurable within those ends), and deadline-aware skip per §4.3 —
  emits `llm_retries_skipped_deadline_total` when a retry would land
  past the span deadline.
- `src/crypto/envelope.ts`: `EnvelopeCrypto` façade with `wrap` /
  `unwrap` / `invalidateUserKey` / `sweepExpired`. DEK cache keyed by
  `(userId, kekVersion)` per §2 invariant 8, TTL hard-capped at 300 s
  (constructor refuses higher). On every `unwrap`, stale cache entries
  for the same `userId` but a different `kekVersion` are zeroised +
  evicted + counted as `llm_dek_cache_stale_hits_total{reason=version_mismatch}`.
- `src/observability/metrics.ts`: narrow `Metrics` interface with
  `NOOP_METRICS` and `InMemoryMetrics` (test helper). Derives
  `llm_kms_retry_success_ratio` from `llm_kms_retries_total{outcome}`
  per §10.2 operational notes — natural to include alongside the
  rest of the crypto metric set (Jean, 2026-04-18).
- `src/types.ts`: shared `Result<T, E>` with `ok` / `err` constructors.
- Public surface: new subpath exports `@chisu/llm-client/crypto` and
  `@chisu/llm-client/observability` (plus re-exports from the root).
- New devDependencies: `aws-sdk-client-mock`, `fast-check`. New
  dependency: `@aws-sdk/client-kms`.

### Added — Iteration 1 (bootstrap)

- Package skeleton (`package.json`, `tsconfig.json`,
  `tsconfig.build.json`) matching the Foco monorepo ESM + `tsc`
  convention.
- `src/errors/taxonomy.ts`: `LLMCallError` discriminated union from
  `LLM_CLIENT.md §3.5` + `LLMErrorCode` helper + compact constructors.
- `src/errors/classify.ts`: pure classifiers `classifyProviderHttpError`,
  `classifyKmsError`, `classifyNetworkError` — implement the mapping
  table of `LLM_CLIENT.md §7.1`.
- `src/config/flag-defaults.ts`: `FLAG_DEFAULTS` frozen record of
  the 13 GrowthBook flags from `LLM_CLIENT.md §16`.
- `src/config/flag-validation.ts`: `validateFlags` (min/max +
  cross-invariants + hard-caps) and `loadFlagsWithFallback`
  (honours `LLM_CLIENT_ALLOW_FLAG_FALLBACK` env var for emergency
  recovery when GrowthBook is down).
- Unit test coverage for all of the above.

### Notes

- Build tool is `tsc` (not `tsup`). The plan in
  `project_foco_llm_client_implementation_plan` mentioned `tsup` for
  dual ESM/CJS; this iteration keeps `tsc` to match the rest of the
  monorepo (ESM-only). Revisit if/when `@chisu/llm-client` is
  published independently.
- License is proprietary. The package encodes Foco-specific plan
  pricing and the BYOK/Managed routing rules — not OSS material.
- **No new runtime dependency in Iteration 3.** Providers use
  `globalThis.fetch` (Node ≥24 ships undici's fetch). The
  `HttpClient` DI seam keeps `msw` / `undici.MockAgent` out of the
  test harness — the three provider test files (`anthropic.test.ts`,
  `openai.test.ts`, `gemini.test.ts`) use a ~40-line `_fake-http.ts`
  helper instead.
