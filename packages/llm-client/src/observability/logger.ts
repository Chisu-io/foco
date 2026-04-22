/**
 * Minimal structured-logger surface shared by `llm-client` internals.
 *
 * ## Why this lives in `observability/` and not in a top-level `logging/`
 *
 * Every other iter-8 module that needs a logger (the {@link
 * ../scheduler/flush-scheduler.ts FlushScheduler} and the upcoming
 * `LLMClient` facade in iter 8 commit 3) treats logging as an
 * observability side-effect alongside metrics and tracing. Colocating
 * the type with `Metrics` and `Tracer` signals that expectation: a
 * logger call is instrumentation, never a primary flow dependency.
 *
 * ## Why a fresh interface and not the iter 5 `AuditSinkLogger`
 *
 * `routing/audit-sink.ts` declared a functional alias
 * (`(msg, ctx) => void`) before a general logger was needed. Iter 8
 * introduces the first **object** logger because the scheduler and
 * facade will accumulate more than one level over time (commit 3 may
 * add `info` / `error`). Keeping the audit-sink alias unchanged avoids
 * a ripple refactor into iter 5's test surface.
 *
 * ## Contract
 *
 * Implementations MUST NOT throw. All callers treat the logger as a
 * fire-and-forget side channel: a logger bug must not crash the timer
 * callback, the facade, or a test. Tests assert on captured calls (see
 * the `FakeLogger` in `test/scheduler/_fakes.ts`).
 *
 * The interface is intentionally narrow — only `warn` today. `info` /
 * `error` are additive and will be introduced the moment a caller
 * needs them (commit 3 at the earliest). Under-specifying is cheaper
 * than over-designing: each level adds a contract that all fakes and
 * production adapters (pino, winston, console) must honour.
 *
 * @see ./metrics.ts  — sibling observability surface.
 * @see ./tracing.ts  — sibling observability surface.
 */

/**
 * Structured-log metadata bag. `Readonly` so adapters cannot mutate the
 * caller's object; values are `unknown` because different sites attach
 * heterogeneous context (numbers, strings, the raw error message).
 * The adapter is responsible for serialising safely — callers MUST
 * NOT include PII here (same invariant as `MetricLabels`).
 */
export type LogMeta = Readonly<Record<string, unknown>>;

/**
 * Narrow logger surface. Iter 8 commit 2 only requires `warn` (the
 * scheduler's one call site on a downstream recorder failure). Adding
 * levels later is an additive, non-breaking change.
 *
 * Production wiring will typically be a `pino` or `console.warn`
 * adapter supplied by the host application; `llm-client` ships no
 * concrete logger — the package stays observability-sink-agnostic just
 * like it does for {@link ./metrics.ts Metrics}.
 */
export interface Logger {
  /**
   * Emit a warning. MUST NOT throw. The adapter decides whether to
   * serialise `meta` as structured fields or a flat string; the
   * scheduler passes only plain scalar values, never PII.
   */
  warn(msg: string, meta?: LogMeta): void;
}

/**
 * No-op logger. Useful as a safe default in production wiring that
 * forgot to inject one, and as a baseline in tests that do not care
 * about log capture. Mirrors the `NOOP_METRICS` pattern from
 * {@link ./metrics.ts}.
 */
export const NOOP_LOGGER: Logger = Object.freeze({
  warn(): void {},
});
