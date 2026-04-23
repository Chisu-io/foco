/**
 * OpenTelemetry tracer DI seam + `withSpan` helper for
 * `@chisu/llm-client`.
 *
 * Implements §4 (tracing infrastructure) of the signed mini-spec at
 * {@link ../../../../.cmsgs/iter6-otel-correlation-design.md `iter6-otel-correlation-design.md`}
 * and §10.1 of
 * {@link ../../../../docs/LLM_CLIENT.md `LLM_CLIENT.md`} (signed v1.1,
 * 2026-04-18).
 *
 * ## Why a DI seam
 *
 * `@opentelemetry/api` returns a no-op tracer when the hosting app has
 * not registered an SDK. That is the correct production behaviour (zero
 * cost when no collector is wired). Tests, however, need to assert on
 * emitted spans — so we expose `setTracer(t)` / `resetTracer()` so a
 * test can install a `BasicTracerProvider` bound to an
 * `InMemorySpanExporter` for the duration of a single spec.
 *
 * Invariants:
 *
 *  - Every span creation in the package goes through `withSpan(...)`.
 *    No other file imports `tracer.startSpan` from
 *    `@opentelemetry/api` directly. This is how we guarantee the
 *    attribute-redaction rule of §10.1 ("Prohibido: `llm.api_key`,
 *    `llm.key_ciphertext`, contenido de prompts/responses") can be
 *    enforced by a CI grep in iter 8.
 *  - `withSpan` is `async` — the span lives for the full lifetime of
 *    the callback, closes on both success and failure, and records
 *    exceptions verbatim. On error the span status is
 *    `SpanStatusCode.ERROR` and the exception is attached via
 *    `span.recordException`. The error is re-thrown.
 *  - `hashUserId` is `sha256(userId)` plain (no salt) per §7(E) of the
 *    mini-spec. The hash is used for log/span correlation, not for
 *    long-term storage.
 *
 * @see LLM_CLIENT.md §10.1 — Tracing (OpenTelemetry)
 * @see .cmsgs/iter6-otel-correlation-design.md §4 — Infraestructura de tracing
 */

import { createHash } from 'node:crypto';

import {
  SpanKind,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer,
} from '@opentelemetry/api';

/**
 * Canonical instrumentation name/version pair exposed by
 * `trace.getTracer`. Kept stable across iterations so Prometheus /
 * Tempo dashboards label-match.
 *
 * The version reads the package version lazily; we keep the literal in
 * one place so bumping `package.json` does not force a code change
 * (the tracer name already disambiguates this package from any other
 * instrumentation in the host process).
 */
const TRACER_NAME = '@chisu/llm-client';
const TRACER_VERSION = '0.0.0';

/**
 * Injected tracer for tests. `undefined` in production → we fall back
 * to `trace.getTracer(...)` which returns the globally registered
 * tracer or a no-op when none is installed.
 */
let injectedTracer: Tracer | undefined;

/**
 * Install a tracer for tests. Callers MUST pair this with
 * `resetTracer()` in an `afterEach` / `afterAll` so a failure in one
 * spec does not leak state into the next.
 */
export function setTracer(t: Tracer): void {
  injectedTracer = t;
}

/** Clear any injected tracer. Idempotent. */
export function resetTracer(): void {
  injectedTracer = undefined;
}

/**
 * Resolve the active tracer. Exported only for test assertions that
 * want to verify the DI seam itself; production code should not call
 * this directly — use `withSpan` instead.
 */
export function getTracer(): Tracer {
  return injectedTracer ?? trace.getTracer(TRACER_NAME, TRACER_VERSION);
}

/**
 * Span attribute bag accepted by `withSpan`. OTel itself allows
 * arrays, but every attribute in §10.1 of the contract is a scalar, so
 * we narrow the type to keep `withSpan` call-sites honest.
 */
export type SpanAttrs = Readonly<
  Record<string, string | number | boolean>
>;

/**
 * Options forwarded to `tracer.startSpan`. `kind` defaults to
 * `SpanKind.INTERNAL`. Pass `SpanKind.CLIENT` for spans that wrap an
 * outbound HTTP or KMS call.
 */
export interface WithSpanOptions {
  readonly kind?: SpanKind;
}

/**
 * Run `fn` inside a new span named `name` with the initial attributes
 * `attrs`.
 *
 * Lifecycle:
 *
 *  1. `startSpan(name, { kind, attributes: attrs })`
 *  2. `await fn(span)`
 *     - success → `setStatus({ code: OK })`, return the result
 *     - throw   → `setStatus({ code: ERROR, message })`,
 *                 `recordException(err)`, rethrow
 *  3. `span.end()` (always, in `finally`)
 *
 * The callback receives the live span so it can stamp additional
 * attributes that are only known at the end (e.g. `llm.input_tokens`,
 * `http.status_code`).
 *
 * Why async: every call site in `llm-client` is async (HTTP, KMS).
 * Forcing the helper to be async keeps `try/finally` honest — a
 * synchronous version would have to duplicate branching for
 * sync/async callbacks and is easy to get wrong.
 */
export async function withSpan<T>(
  name: string,
  attrs: SpanAttrs,
  fn: (span: Span) => Promise<T>,
  options?: WithSpanOptions,
): Promise<T> {
  const tracer = getTracer();
  const span = tracer.startSpan(name, {
    kind: options?.kind ?? SpanKind.INTERNAL,
    attributes: { ...attrs },
  });
  try {
    const out = await fn(span);
    span.setStatus({ code: SpanStatusCode.OK });
    return out;
  } catch (err) {
    const errorObj =
      err instanceof Error ? err : new Error(String(err));
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: errorObj.message,
    });
    span.recordException(errorObj);
    throw err;
  } finally {
    span.end();
  }
}

/**
 * Deterministic identifier for a user that never leaks the raw
 * `userId` into traces, logs or metric labels. Used for the
 * `user.id_hash` span attribute in §10.1.
 *
 * Hash-only (no salt): the hash is a correlation key, not an
 * authenticator. If cross-service unlinkability becomes a requirement,
 * we add per-environment salt via a signed adjustment to §10.1.
 */
export function hashUserId(userId: string): string {
  return createHash('sha256').update(userId, 'utf8').digest('hex');
}

/**
 * Same hashing function applied to an idempotency key. Exposed as a
 * named alias so call sites at the span emission layer (iter 6
 * commit 3) read naturally: `hashIdempotencyKey(ctx.idempotencyKey)`
 * maps 1:1 to the `trace.idempotency_key_hash` attribute in §10.1.
 */
export function hashIdempotencyKey(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/**
 * Re-export the subset of `@opentelemetry/api` that consumers of this
 * package need to build span kinds. Keeps the dependency surface
 * single-point in the barrel.
 */
export { SpanKind, SpanStatusCode } from '@opentelemetry/api';
export type { Span, Tracer } from '@opentelemetry/api';
