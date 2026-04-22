/**
 * `FlushScheduler` — owns the timer that periodically drains the
 * `UsageBuffer` through a `UsageRecorder`, plus the high-water-mark
 * and graceful-shutdown flush triggers.
 *
 * Implements the "flush.trigger" decision of
 * {@link ../../../../.cmsgs/iter8-prompt.md `iter8-prompt.md`} for
 * iteration 8 commit 2:
 *
 * ```
 * flush.trigger → setInterval(flushIntervalMs, default 5000ms)
 *                 + flush inmediato cuando buffer ≥ thresholdFraction * capacity
 *                 + flush forzado en close()
 *                 + no-op si buffer vacío
 * ```
 *
 * and the signed public shape at "Shape mínimo" of the same prompt.
 *
 * ## Why this is a separate class and not an `setInterval` inside
 * `createUsageRecorder`
 *
 * The iter-7 `UsageRecorder` shipped with an explicit design note (see
 * the "Public `flush()`, not an internal `setInterval`" block in
 * `accounting/usage-counter.ts`): the recorder never owns a timer
 * because tests would then need `vi.useFakeTimers()` globally and
 * `close()` would need to reach into an opaque module to drain the
 * handle. The scheduler is the module the facade wires up to provide
 * that timer, and only the scheduler is exposed to fake timers — the
 * recorder remains pure.
 *
 * ## Responsibilities
 *
 * 1. **Interval trigger.** On `start()`, register a `setInterval` at
 *    `deps.intervalMs`. On each fire, run `recorder.flush()` with
 *    trigger label `'interval'` (no-op if buffer empty).
 * 2. **Threshold trigger.** The facade calls `notifyBufferChanged(size)`
 *    after every successful `.call()`. When the size crosses
 *    `ceil(capacity * thresholdFraction)` **and the trigger is armed**,
 *    we fire a flush with trigger label `'threshold'`. The trigger is
 *    disarmed immediately to prevent a storm — a steady stream of
 *    buffer-changed notifications while the buffer hovers at the mark
 *    would otherwise queue up a flush on every single one. The trigger
 *    re-arms when either (a) the buffer drops below the threshold in a
 *    subsequent `notifyBufferChanged`, or (b) a flush completes and the
 *    post-flush size is below the threshold.
 * 3. **Close trigger.** `stop()` performs a final `'close'` flush and
 *    clears the timer.
 * 4. **Serialisation.** Concurrent callers of `flushNow()` never
 *    overlap. The second caller awaits the first before starting its
 *    own. `UsageRecorder.flush()` internally drains-then-attempts,
 *    so two concurrent drains would lose entries on the failure path;
 *    serialising externally is simpler than making the recorder
 *    reentrant-safe.
 * 5. **Non-throwing.** `flushNow()` never throws. Any `recorder.flush()`
 *    failure (the recorder is contractually non-throwing, so this is
 *    defensive) is caught, passed to `logger.warn`, and the counter is
 *    still emitted — operators see a hit on the counter either way,
 *    and an extra log line tells them which run degraded.
 * 6. **Empty-buffer short-circuit.** If `buffer.size() === 0` at flush
 *    time we skip the recorder call *and* skip the counter emission.
 *    The counter is intended to count real flush attempts; an empty
 *    run tells operators nothing.
 *
 * ## What `stop()` guarantees
 *
 * `stop()` is idempotent and awaits any in-flight flush before clearing
 * the timer. The iter 8 prompt's `close.api` section sequences the
 * facade's shutdown as `scheduler.stop()` → `store.clear()` → envelope
 * cleanup, so `stop()` resolving means the buffer has had one last
 * drain attempt and the timer is no longer scheduling callbacks.
 *
 * After `stop()`, further `notifyBufferChanged` calls are ignored and
 * further `flushNow()` calls are no-ops (they resolve immediately
 * without touching the recorder). `start()` after `stop()` is also a
 * no-op — once a scheduler is stopped it stays stopped; the facade
 * constructs a fresh scheduler on re-init.
 *
 * @see ./index.ts — barrel.
 * @see ../accounting/usage-counter.ts — the `UsageRecorder.flush()` it drives.
 * @see ../observability/metrics.ts — emits `llm_flush_scheduler_runs_total`.
 * @see .cmsgs/iter8-prompt.md — signed scope (commit 2).
 */

import type { UsageBuffer, UsageRecorder } from '../accounting/usage-counter.js';
import type { Logger } from '../observability/logger.js';
import type { Metrics } from '../observability/metrics.js';
import type { Clock } from '../time.js';

/**
 * Metric name emitted once per non-empty flush attempt. Dim:
 * `{trigger}`. Value set firmed in the iter 8 prompt and documented in
 * the header of `observability/metrics.ts`.
 */
export const FLUSH_SCHEDULER_RUNS_COUNTER = 'llm_flush_scheduler_runs_total';

/** Default timer cadence (ms). §4 LLM_CLIENT.md + iter 8 prompt. */
export const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

/**
 * Default high-water mark expressed as a fraction of the underlying
 * `UsageBuffer.capacity`. 0.8 on a 1000-capacity buffer gives the
 * signed "flush inmediato cuando buffer ≥ 800/1000" behaviour.
 */
export const DEFAULT_FLUSH_THRESHOLD_FRACTION = 0.8;

/**
 * Set of legal `trigger` dimension values. Narrow string-literal union
 * keeps tests honest — if a future contributor adds a new trigger they
 * must update this type and the metric doc in one motion.
 */
export type FlushTrigger = 'interval' | 'threshold' | 'close';

/**
 * Construction dependencies. All fields are required — the scheduler
 * has no convenience defaults on `intervalMs` / `thresholdFraction`
 * because the facade (iter 8 commit 3) owns the user-facing defaults
 * via {@link LLMClientConfig} and passes them down. Forcing explicit
 * values here prevents a silent `undefined` becoming `NaN` after an
 * arithmetic op.
 */
export interface FlushSchedulerDeps {
  /**
   * Buffer whose `size()` the scheduler samples before each flush.
   * Not mutated directly — the recorder owns mutation semantics.
   */
  readonly buffer: UsageBuffer;
  /**
   * Recorder whose `flush()` is invoked on every trigger. The
   * recorder contract states `flush()` is non-throwing; the scheduler
   * is defensive anyway.
   */
  readonly recorder: UsageRecorder;
  /** Metrics sink — emits `llm_flush_scheduler_runs_total`. */
  readonly metrics: Metrics;
  /** Logger — receives a single `warn` per degraded flush. */
  readonly logger: Logger;
  /**
   * Clock primitive. Iter 8 commit 2 does not sample it on the hot
   * path (the timer is `setInterval`-driven, not clock-driven), but
   * the dep is wired here because commit 3 will pass the same clock
   * to the facade and the scheduler, and future triggers (e.g. a
   * "max time without flush" dead-man) will want it.
   */
  readonly clock: Clock;
  /** Interval between automatic `'interval'` flushes (ms). */
  readonly intervalMs: number;
  /** High-water-mark as a fraction of `buffer.capacity`. In (0, 1]. */
  readonly thresholdFraction: number;
}

/**
 * Periodic-flush orchestrator. Consumes a `UsageRecorder` + `UsageBuffer`
 * and exposes three flush entry points (interval, threshold, close).
 *
 * Lifecycle:
 *
 * ```
 *   new FlushScheduler(deps)   // validation only, no side effects
 *   scheduler.start()           // registers setInterval
 *   … (running) …
 *   scheduler.notifyBufferChanged(size)   // optional threshold trigger
 *   scheduler.flushNow(trigger)           // manual flush (rare)
 *   await scheduler.stop()                // drain + clearInterval
 * ```
 *
 * Invariants (all verified by tests):
 *
 *  - `start()` / `stop()` are both idempotent.
 *  - `flushNow()` never throws and never leaves a rejected promise
 *    dangling on the event loop (the internal `void`-discarded
 *    promise from `setInterval` callbacks is always caught inside).
 *  - No overlapping `recorder.flush()` calls — serialisation via the
 *    `pendingFlush` promise guard.
 *  - `notifyBufferChanged` after `stop()` is a silent no-op.
 *  - Empty-buffer runs do NOT increment `llm_flush_scheduler_runs_total`.
 *  - Threshold fires at most once between buffer-drop events.
 */
export class FlushScheduler {
  private readonly deps: FlushSchedulerDeps;
  /**
   * Absolute buffer size that triggers a `'threshold'` flush. Computed
   * once in the constructor — `buffer.capacity` is a `readonly` field
   * on `UsageBuffer`, so this never drifts. `Math.ceil` so a 0.8
   * fraction on a 1000-capacity buffer lands on 800 exactly.
   */
  private readonly thresholdSize: number;
  private timerHandle: ReturnType<typeof setInterval> | undefined;
  /**
   * Lifecycle flags. `started` guards against a double `start()` that
   * would register two timers. `stopped` poisons the scheduler so a
   * late `notifyBufferChanged` or `start()` after `stop()` is a no-op.
   * A stopped scheduler stays stopped — reuse is not supported.
   */
  private started = false;
  private stopped = false;
  /**
   * In-flight flush promise. `flushNow()` awaits this before starting a
   * new run; on resolution the field is cleared. `undefined` means "no
   * flush is currently running". Serialisation is test-visible — see
   * the "concurrent flushNow calls serialise" spec.
   */
  private pendingFlush: Promise<void> | undefined;
  /**
   * Threshold-trigger arming flag. `true` ⇒ the next
   * `notifyBufferChanged(size)` with `size >= thresholdSize` fires a
   * flush; `false` ⇒ we already fired and are waiting for the buffer
   * to drop below the threshold before firing again. Storm prevention:
   * a steady stream of increments while the buffer hovers at the mark
   * must not queue up one flush per increment.
   */
  private thresholdArmed = true;

  constructor(deps: FlushSchedulerDeps) {
    if (!Number.isFinite(deps.intervalMs) || deps.intervalMs <= 0) {
      throw new Error(
        `FlushScheduler: intervalMs must be a positive finite number (got ${String(
          deps.intervalMs,
        )}).`,
      );
    }
    if (
      !Number.isFinite(deps.thresholdFraction) ||
      deps.thresholdFraction <= 0 ||
      deps.thresholdFraction > 1
    ) {
      throw new Error(
        `FlushScheduler: thresholdFraction must be in (0, 1] (got ${String(
          deps.thresholdFraction,
        )}).`,
      );
    }
    this.deps = deps;
    this.thresholdSize = Math.max(
      1,
      Math.ceil(deps.buffer.capacity * deps.thresholdFraction),
    );
  }

  /**
   * Exposed for tests + commit 3's facade-level assertions. The
   * threshold is a pure function of constructor inputs, so a getter is
   * enough — no need to surface it as a field.
   */
  get thresholdSizeForTests(): number {
    return this.thresholdSize;
  }

  /**
   * Register the interval timer. Idempotent — calling `start()` twice
   * does not register a second timer. No-op after `stop()` (a stopped
   * scheduler stays stopped).
   *
   * The timer fires `flushNow('interval')` via `void` because
   * `setInterval` callbacks must be synchronous; unhandled rejections
   * are impossible because `flushNow` is non-throwing by contract.
   */
  start(): void {
    if (this.stopped) return;
    if (this.started) return;
    this.started = true;
    this.timerHandle = setInterval(() => {
      // Fire-and-forget. The promise is awaited nowhere; `flushNow`
      // owns its own error handling so there is no dangling rejection.
      void this.flushNow('interval');
    }, this.deps.intervalMs);
  }

  /**
   * The facade calls this after every successful `.call()` with the
   * fresh buffer size. Two behaviours:
   *
   *  - size < threshold: re-arm the threshold trigger (if we fired
   *    recently, we are now eligible to fire again).
   *  - size ≥ threshold AND armed: fire `flushNow('threshold')` and
   *    disarm. Re-arm happens either here (on a later call with a
   *    smaller size) or at the end of `runFlush` when the post-drain
   *    size lands below the mark.
   *
   * After `stop()` this is a silent no-op. The facade may race a
   * final buffer-changed against `stop()`; ignoring late notifications
   * is cheaper than a strict ordering contract.
   */
  notifyBufferChanged(size: number): void {
    if (this.stopped) return;
    if (size < this.thresholdSize) {
      this.thresholdArmed = true;
      return;
    }
    if (!this.thresholdArmed) return;
    this.thresholdArmed = false;
    void this.flushNow('threshold');
  }

  /**
   * Public flush entry point. Serialises against any in-flight flush,
   * then performs one `recorder.flush()` attempt (skipped if the
   * buffer is empty), emits the counter, and resolves.
   *
   * Never throws. A `recorder.flush()` error (contractually impossible
   * but handled defensively) is logged via `logger.warn` and the
   * counter is still incremented so operators see the run.
   */
  async flushNow(trigger: FlushTrigger): Promise<void> {
    // After `stop()` the scheduler is inert — a late call from the
    // interval callback that fired just before `clearInterval` landed
    // is harmless, but doing more work would race with the facade's
    // shutdown sequence.
    if (this.stopped && trigger !== 'close') return;

    // Serialise: if a flush is already running, let it finish first.
    // The caller's own trigger then runs unconditionally — `'close'`
    // following `'interval'` must still drain anything that arrived
    // while `'interval'` was executing.
    while (this.pendingFlush !== undefined) {
      const awaited = this.pendingFlush;
      try {
        await awaited;
      } catch {
        // swallow — `runFlush` never throws, but be defensive.
      }
      // If another caller replaced `pendingFlush` while we awaited,
      // loop and wait for the new one. Guards against a rare but
      // legal case where two triggers queue in quick succession.
      if (this.pendingFlush === awaited) break;
    }

    const p = this.runFlush(trigger);
    this.pendingFlush = p;
    try {
      await p;
    } finally {
      // Only clear if no later caller has chained another flush on
      // top of ours (shouldn't happen — the `await p` above is what
      // the next caller is waiting on — but the check is cheap).
      if (this.pendingFlush === p) this.pendingFlush = undefined;
    }
  }

  /**
   * Internal single-attempt flush. Does NOT serialise — that is
   * `flushNow()`'s job. Does NOT throw — the `try`/`catch` is
   * defensive; the recorder is contractually non-throwing.
   *
   * Side effects, in order:
   *
   *  1. Sample `buffer.size()`. If 0, return without emitting the
   *     counter (empty runs do not count).
   *  2. `await recorder.flush()`, catching any thrown/rejected value
   *     and logging a single `warn`.
   *  3. Emit `llm_flush_scheduler_runs_total{trigger}` — exactly one
   *     increment, whether the recorder succeeded or failed.
   *  4. If post-flush size is below threshold, re-arm the threshold
   *     trigger. This closes the loop for the degenerate case where
   *     the buffer drained via a flush rather than via a
   *     `notifyBufferChanged` from the facade.
   */
  private async runFlush(trigger: FlushTrigger): Promise<void> {
    if (this.deps.buffer.size() === 0) return;

    try {
      await this.deps.recorder.flush();
    } catch (err) {
      // Defensive: `UsageRecorder.flush()` is documented non-throwing,
      // but a custom writer or a future Postgres adapter bug could in
      // principle leak. Log once, continue — we still emit the counter
      // so operators see the run attempted.
      const message = err instanceof Error ? err.message : String(err);
      this.deps.logger.warn('llm-client: flush scheduler run failed', {
        trigger,
        error: message,
      });
    }

    this.deps.metrics.counter(FLUSH_SCHEDULER_RUNS_COUNTER, { trigger });

    if (this.deps.buffer.size() < this.thresholdSize) {
      this.thresholdArmed = true;
    }
  }

  /**
   * Graceful shutdown. Idempotent.
   *
   * Order:
   *
   *  1. Flip `stopped = true` so `notifyBufferChanged` / `start()` /
   *     non-`close` `flushNow()` become no-ops immediately.
   *  2. Clear the interval timer first so no new `'interval'` callback
   *     can enqueue work while we're draining.
   *  3. Await any in-flight flush (the interval that fired just
   *     before step 2 may still be running).
   *  4. Run a final `'close'` flush to drain whatever accumulated
   *     during the await in step 3.
   *
   * The `'close'` counter emission follows from step 4 via the normal
   * `runFlush` path, so `llm_flush_scheduler_runs_total{trigger=close}`
   * increments iff the buffer was non-empty at close time.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    // (2) Stop the timer first so no `'interval'` callback lands mid-shutdown.
    if (this.timerHandle !== undefined) {
      clearInterval(this.timerHandle);
      this.timerHandle = undefined;
    }

    // (3) Drain any in-flight flush. Errors are swallowed — `runFlush`
    // is non-throwing and we are on the shutdown path.
    if (this.pendingFlush !== undefined) {
      try {
        await this.pendingFlush;
      } catch {
        // impossible in practice — runFlush catches — but defensive.
      }
    }

    // (4) Final drain. We bypass the `stopped` guard in `flushNow`
    // because `'close'` is explicitly allowed post-stop.
    await this.flushNow('close');
  }
}
