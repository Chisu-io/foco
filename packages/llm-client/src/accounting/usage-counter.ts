/**
 * `UsageRecorder` — the writer half of the token-accounting path
 * (§8 of the signed LLM_CLIENT contract, design doc
 * `.cmsgs/iter7-accounting-design.md` §3.2, §4.3, §5.2, §5.3).
 *
 * Iter 7 commit 3 ships:
 *
 *  1. The `UsageEntry` wire shape (carries everything the writer needs
 *     plus the sub-span attributes — notably `kekVersion` which is only
 *     set when `fundingMode === 'byok'`).
 *  2. A non-throwing `UsageRecorder` interface.
 *  3. An in-memory `UsageBuffer` with a hard cap of 1000 entries
 *     (§8 decisión firmada #2) that preserves the original `occurredAt`
 *     while the writer is down.
 *  4. A factory `createUsageRecorder(deps)` that composes the writer +
 *     buffer + metrics + OTel sub-span and exposes a public `flush()`
 *     entry point the facade (iter 8) will schedule every 10 s.
 *
 * Design drivers
 * --------------
 *
 * - **Non-throwing.** The facade and the plan-router MUST NOT see
 *   accounting failures propagate. A DB outage cannot break `.call()`;
 *   the row is either written, buffered, or dropped with a counter
 *   (dropped + `llm_accounting_writes_dropped_total{reason:'buffer_full'}`
 *   raises a P1 alert — see §4.3 of the design doc).
 *
 * - **Public `flush()`, not an internal `setInterval`.** The factory
 *   does not start a timer. Owning the timer inside the module would
 *   make tests impure and force `vi.useFakeTimers()` globally. The
 *   iter 8 facade will register a 10 s scheduler; tests call `flush()`
 *   directly. Same rationale the audit sink used (iter 5).
 *
 * - **Manual OTel span, not `withSpan`.** `withSpan` in
 *   `observability/tracing.ts` is async + *re-throws* and records the
 *   exception — perfect for the provider call, wrong here. Accounting
 *   is non-throwing: a `writer` failure flips the result from `'ok'`
 *   to `'buffered'` (or `'dropped'`), updates the span status, and
 *   returns. Using `withSpan` would rethrow and defeat the whole
 *   point. Pattern mirrors iter 6 commit 4 (§5.3 design doc).
 *
 * - **No PII in spans or metrics.** Span attrs are
 *   `consent_mode`, `funding_mode`, `origin`, `llm.provider`, and
 *   `kek.version` when present. **Prohibited:** `user_id`,
 *   `prompt_hash`, `api_key`, `ciphertext`, `trace_id` (the trace id
 *   flows through the parent span, not as an attribute — see
 *   `tracing.ts` §10.1 invariant).
 *
 * - **`occurredAt` is never rewritten.** A buffered entry carries the
 *   moment the call actually landed. Rewriting it to `flush()` time
 *   would corrupt abuse-detection ventana (heurística 1: "sostenido
 *   3h"). §4.3 design doc.
 *
 * @see docs/LLM_CLIENT.md v1.1 §8, §10.2, §11
 * @see .cmsgs/iter7-accounting-design.md §3.2, §4.3, §5.2, §5.3
 * @see src/routing/audit-sink.ts iter 5 — DI seam precedent
 * @see src/observability/tracing.ts — `withSpan` (not used here — see above)
 */

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';

import type { Metrics } from '../observability/metrics.js';
import { getTracer } from '../observability/tracing.js';
import type { ProviderName } from '../providers/provider.js';
import type { OriginKind } from '../routing/events.js';
import type { ModelId } from '../types/request.js';
import type { ConsentMode } from '../types/repos.js';

// ─── Public shapes ─────────────────────────────────────────────────────

/**
 * Funding mode reported to the accounting layer. Mirrors
 * `ProviderCallContext.fundingMode` so the router can forward verbatim
 * (no translation layer). Local alias keeps the writer's surface
 * self-contained — callers outside `accounting/` shouldn't have to
 * cross-import from `routing/events.ts` just to construct an entry.
 */
export type FundingMode = 'byok' | 'managed';

/**
 * One billable row destined for `llm_token_usage`. Shape is verbatim
 * with `.cmsgs/iter7-accounting-design.md` §3.2 + the `kekVersion`
 * extension signed in §5.3 (sub-span attribute set).
 *
 * All fields are required by the writer. **The writer decides whether
 * to redact `input_tokens` / `output_tokens` to `NULL` based on
 * `consentMode === 'minimal'`** — the plumbing here always carries the
 * real counts so tests and the sub-span have consistent data. Isolates
 * the redaction rule in one place (the concrete Postgres writer that
 * lands in iter 8 / `apps/web`).
 */
export interface UsageEntry {
  readonly userId: string;
  /**
   * Moment the provider call landed. Preserved verbatim if the entry
   * is buffered and flushed later (see §4.3 of the design doc —
   * abuse-detection ventanas depend on this).
   */
  readonly occurredAt: Date;
  readonly provider: ProviderName;
  readonly model: ModelId;
  readonly fundingMode: FundingMode;
  readonly origin: OriginKind;
  /** Real token count — the writer may redact to NULL under `'minimal'`. */
  readonly inputTokens: number;
  /** Real token count — the writer may redact to NULL under `'minimal'`. */
  readonly outputTokens: number;
  readonly latencyMs: number;
  /** OTel trace id (hex). Never stamped as a span attribute here. */
  readonly traceId: string;
  readonly consentMode: ConsentMode;
  /** Full 64-char lowercase hex SHA-256 per `prompt-hash.ts`. */
  readonly promptHash: string;
  /**
   * KEK version that unwrapped the DEK for this call. Present only
   * when `fundingMode === 'byok'` (Managed calls use the pool keys and
   * have no per-user KEK version). Non-PII — categorical integer.
   */
  readonly kekVersion?: number | undefined;
}

/**
 * Low-level writer injected into the factory. Implementations are:
 *
 *  - `apps/web/src/server/llm/usage-recorder.ts` — Postgres-backed
 *    (iter 8 or whenever the concrete row shape firms up).
 *  - In-memory fake in `test/accounting/_fakes.ts` (iter 7 tests).
 *
 * Contract: the writer MAY reject (throw / reject) on any transient or
 * permanent failure. The `UsageRecorder` catches and routes to the
 * buffer-or-drop path based on capacity. The writer MUST NOT swallow
 * errors itself — that would hide DB outages from the observability
 * layer here.
 */
export type UsageWriter = (entry: UsageEntry) => Promise<void>;

/**
 * Public surface consumed by the plan-router (iter 7 commit 4) and,
 * eventually, by the `LLMClient` facade (iter 8).
 *
 * Every method is non-throwing. Failures surface through metrics and
 * the `result` attribute on the sub-span.
 */
export interface UsageRecorder {
  /**
   * Record a single entry. Returns when the entry has been either:
   *
   *  - accepted by the writer (`result='ok'`),
   *  - queued in the in-memory buffer after a writer failure
   *    (`result='buffered'`),
   *  - rejected outright because the buffer is full (`result='dropped'`).
   */
  record(entry: UsageEntry): Promise<void>;
  /**
   * Best-effort drain of any buffered entries. Called by the facade on
   * a 10 s timer (iter 8). Entries that fail on flush stay in the
   * buffer; entries that succeed are removed.
   *
   * Resolves when the current buffer snapshot has been attempted once.
   * Non-throwing.
   */
  flush(): Promise<void>;
  /**
   * Current buffer occupancy. Useful for tests and for a dashboard
   * gauge that does not want to race with flush loop emissions.
   */
  bufferSize(): number;
}

// ─── Buffer ────────────────────────────────────────────────────────────

/**
 * FIFO buffer with a hard cap. Extracted into its own class so:
 *
 *  - the `UsageRecorder` factory stays small and linear,
 *  - tests can exercise overflow semantics without going through the
 *    whole recorder (unit-level confidence in the eviction rule).
 *
 * Eviction policy: drop *new* inserts (not oldest). Reason: oldest
 * entries carry the freshest `occurredAt` offsets relative to wall
 * clock at flush time; dropping them would skew any time-series abuse
 * analytics more than dropping an additional recent one. Both choices
 * are defensible; documenting the pick so operators reading P1 alerts
 * know what "dropped" means.
 */
export class UsageBuffer {
  private readonly entries: UsageEntry[] = [];
  constructor(public readonly capacity: number = DEFAULT_BUFFER_CAPACITY) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new Error(
        `UsageBuffer: capacity must be a positive integer (got ${capacity}).`,
      );
    }
  }

  /** Current occupancy. */
  size(): number {
    return this.entries.length;
  }

  /** `true` when the buffer is at capacity and the next `push` will drop. */
  isFull(): boolean {
    return this.entries.length >= this.capacity;
  }

  /**
   * Enqueue an entry. Returns `true` if accepted, `false` if the
   * buffer was already at capacity (caller should emit the
   * `llm_accounting_writes_dropped_total` counter).
   */
  push(entry: UsageEntry): boolean {
    if (this.entries.length >= this.capacity) return false;
    this.entries.push(entry);
    return true;
  }

  /**
   * Drain the entire buffer into an array, leaving the buffer empty.
   * Used by `flush()` — we snapshot, attempt writer for each, and push
   * failures back via `push()`.
   */
  drain(): UsageEntry[] {
    return this.entries.splice(0, this.entries.length);
  }
}

// ─── Factory + constants ───────────────────────────────────────────────

/**
 * Hard cap on buffer occupancy. §8 decisión firmada #2. Sized for
 * ~5 min of p95 MVP load (8 req/min × 5 × factor-of-safety 2 ≈ 80;
 * rounded up two orders of magnitude for burst headroom and to make
 * the drop-alert unambiguous when it fires).
 */
export const DEFAULT_BUFFER_CAPACITY = 1000;

/** Name of the happy/buffered/dropped counter. Dims: `{consent_mode, funding_mode, result}`. */
export const USAGE_WRITES_COUNTER = 'llm_accounting_writes_total';

/** Name of the failure-reason counter. Dim: `{reason}`. */
export const USAGE_WRITES_FAILED_COUNTER =
  'llm_accounting_writes_failed_total';

/** Name of the drop counter — fires the P1 alert. Dim: `{reason}` (currently only `'buffer_full'`). */
export const USAGE_WRITES_DROPPED_COUNTER =
  'llm_accounting_writes_dropped_total';

/** Name of the buffer-size gauge. No dims. */
export const USAGE_BUFFER_SIZE_GAUGE = 'llm_accounting_buffer_size';

/** Canonical sub-span name (§5.3 design doc). */
export const USAGE_WRITE_SPAN_NAME = 'llm.accounting.write';

/**
 * Reason dimension on the failure counter. Narrow so Grafana can alert
 * on specific subsets without a regex.
 */
export type UsageWriteFailureReason =
  | 'db_down'
  | 'timeout'
  | 'network'
  | 'serialization';

/**
 * Result of a single `record()` attempt. Also the value stamped on the
 * sub-span attribute `result` + the label on the writes counter.
 */
export type UsageWriteResult = 'ok' | 'buffered' | 'dropped';

/** Dependencies for {@link createUsageRecorder}. */
export interface UsageRecorderDeps {
  /**
   * The row writer. Typically the Postgres insert — in iter 7 it's a
   * fake from `_fakes.ts`; in iter 8 the `apps/web` Postgres adapter.
   */
  readonly writer: UsageWriter;
  /** Metrics sink. All 4 accounting metrics emit through here. */
  readonly metrics: Metrics;
  /**
   * Optional buffer override. If omitted, a fresh `UsageBuffer` with
   * the default capacity is allocated. Injected in tests to exercise
   * overflow without needing 1000 fake writes.
   */
  readonly buffer?: UsageBuffer;
}

/**
 * Classify a thrown value into one of the 4 failure-reason buckets.
 * Heuristic — the writer surface does not yet expose structured error
 * kinds (the Postgres adapter in iter 8 may refine this). Keep
 * conservative defaults:
 *
 *  - `AbortError` / timeout-looking names ⇒ `'timeout'`
 *  - messages naming ENOTFOUND / ECONNREFUSED / EAI_AGAIN or the
 *    word "network" ⇒ `'network'`
 *  - `SyntaxError` / `TypeError` around JSON shapes ⇒ `'serialization'`
 *  - anything else ⇒ `'db_down'` (default — most outages in this
 *    surface WILL be the database, and dashboards expect that bucket
 *    to carry the generic failure volume).
 */
export function classifyWriterFailure(
  err: unknown,
): UsageWriteFailureReason {
  if (err instanceof Error) {
    const name = err.name;
    const message = err.message;
    if (
      name === 'AbortError' ||
      name === 'TimeoutError' ||
      /timeout/i.test(message)
    ) {
      return 'timeout';
    }
    if (
      /ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|ETIMEDOUT/.test(message) ||
      /network/i.test(message)
    ) {
      return 'network';
    }
    if (
      (name === 'SyntaxError' || name === 'TypeError') &&
      /json|serial/i.test(message)
    ) {
      return 'serialization';
    }
  }
  return 'db_down';
}

/**
 * Build a {@link UsageRecorder} around a raw writer.
 *
 * Behaviour:
 *
 *  - `record(entry)` opens a `llm.accounting.write` CLIENT sub-span,
 *    awaits `writer(entry)`, and:
 *      - on success: emits `{result:'ok'}`, updates the gauge to the
 *        current buffer size (unchanged unless a prior flush left it
 *        non-empty), closes the span with `OK`.
 *      - on writer throw: if the buffer has room, pushes the entry and
 *        emits `{result:'buffered'}` + `llm_accounting_writes_failed_total`
 *        tagged with the inferred reason; closes the span with
 *        `ERROR, message=reason`. If the buffer is full, emits
 *        `{result:'dropped'}` + `llm_accounting_writes_dropped_total`
 *        and closes the span with `ERROR, message='buffer_full'`.
 *
 *  - `flush()` snapshots the buffer (drain), attempts `writer(entry)`
 *    for each entry, and pushes any failure back. Non-throwing. Used
 *    on the 10 s background loop owned by the facade (iter 8).
 *
 *  - `bufferSize()` is a cheap read for the gauge + tests.
 *
 * Span attributes:
 *
 *  - `llm.provider`, `consent_mode`, `funding_mode`, `origin` —
 *    always present.
 *  - `kek.version` — present only when `entry.kekVersion !== undefined`.
 *  - `result` — `'ok' | 'buffered' | 'dropped'`, stamped at the end.
 *
 * **Prohibited span attributes** (enforced by tests):
 *  - `user.id`, `user_id`
 *  - `prompt_hash`, `trace_id`, `api_key`, `ciphertext`
 *    (trace id flows through the parent span context).
 */
export function createUsageRecorder(
  deps: UsageRecorderDeps,
): UsageRecorder {
  const buffer = deps.buffer ?? new UsageBuffer();

  function emitBufferGauge(): void {
    deps.metrics.gauge(USAGE_BUFFER_SIZE_GAUGE, buffer.size());
  }

  function emitWriteResult(
    entry: UsageEntry,
    result: UsageWriteResult,
  ): void {
    deps.metrics.counter(USAGE_WRITES_COUNTER, {
      consent_mode: entry.consentMode,
      funding_mode: entry.fundingMode,
      result,
    });
  }

  async function attemptWrite(entry: UsageEntry): Promise<UsageWriteResult> {
    const tracer = getTracer();
    // Build the attribute bag verbatim; optional keys are added only
    // when defined to avoid stamping `undefined` on the span (the OTel
    // SDK tolerates it but the prohibited-attrs invariant is clearer
    // if we never emit an unexpected key at all).
    const attrs: Record<string, string | number | boolean> = {
      'llm.provider': entry.provider,
      consent_mode: entry.consentMode,
      funding_mode: entry.fundingMode,
      origin: entry.origin,
    };
    if (entry.kekVersion !== undefined) {
      attrs['kek.version'] = entry.kekVersion;
    }

    const span = tracer.startSpan(USAGE_WRITE_SPAN_NAME, {
      kind: SpanKind.CLIENT,
      attributes: attrs,
    });

    let result: UsageWriteResult;
    try {
      await deps.writer(entry);
      result = 'ok';
      span.setAttribute('result', result);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      const reason = classifyWriterFailure(err);
      deps.metrics.counter(USAGE_WRITES_FAILED_COUNTER, { reason });

      if (buffer.push(entry)) {
        result = 'buffered';
        span.setAttribute('result', result);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: reason,
        });
      } else {
        result = 'dropped';
        deps.metrics.counter(USAGE_WRITES_DROPPED_COUNTER, {
          reason: 'buffer_full',
        });
        span.setAttribute('result', result);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: 'buffer_full',
        });
      }
      // Deliberately do NOT call `span.recordException(err)`. Accounting
      // failures are observable via the status + metrics — attaching
      // the raw exception would leak the writer's internal error shape
      // into the OTel attribute bag, which some backends surface in
      // trace UIs with no redaction.
      return result;
    } finally {
      span.end();
    }
  }

  return {
    async record(entry: UsageEntry): Promise<void> {
      const result = await attemptWrite(entry);
      emitWriteResult(entry, result);
      emitBufferGauge();
    },

    async flush(): Promise<void> {
      const snapshot = buffer.drain();
      if (snapshot.length === 0) {
        emitBufferGauge();
        return;
      }
      for (const entry of snapshot) {
        // `attemptWrite` handles its own span + reason counter. On
        // success we emit `{result:'ok'}`; on failure the entry is
        // pushed back into the buffer by `attemptWrite`, and we count
        // the attempt as `'buffered'` (not `'dropped'`) — the entry
        // did not leave the pipeline, just stayed queued. `'dropped'`
        // is reserved for the buffer-full case, which cannot happen
        // here because we just drained.
        const result = await attemptWrite(entry);
        emitWriteResult(entry, result);
      }
      emitBufferGauge();
    },

    bufferSize(): number {
      return buffer.size();
    },
  };
}
