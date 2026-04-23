/**
 * Test fakes for the `FlushScheduler` specs.
 *
 * Scoped to `test/scheduler/` — no prod-facing exports. Mirrors the
 * `test/accounting/_fakes.ts` convention (leading underscore, local to
 * the feature area). Kept deliberately minimal: each fake exposes only
 * the assertions the scheduler specs actually need.
 *
 * @see ../accounting/_fakes.ts — sibling convention.
 */

import type {
  UsageEntry,
  UsageRecorder,
} from '../../src/accounting/usage-counter.js';
import type {
  LogMeta,
  Logger,
} from '../../src/observability/logger.js';

/**
 * Captures `warn` calls so tests can assert the scheduler degraded via
 * the expected log line. `info` / `error` are not part of the iter-8
 * `Logger` surface so the fake has only one method.
 */
export class FakeLogger implements Logger {
  readonly warnings: { msg: string; meta: LogMeta | undefined }[] = [];

  warn(msg: string, meta?: LogMeta): void {
    this.warnings.push({ msg, meta });
  }
}

/**
 * Controllable {@link UsageRecorder} — tests drive flush behaviour
 * without standing up a full `createUsageRecorder(...)` + fake writer.
 *
 *  - `flushCalls` counts every `flush()` invocation, so "no overlapping
 *    flushes" can be asserted via ordering.
 *  - `pendingFlush` lets a test freeze a `flush()` call mid-execution
 *    to verify serialisation (`flushNow()` awaits before starting).
 *  - `nextFlushResult` controls the outcome of the next flush call:
 *    `'resolve'` (default) makes `flush()` resolve, `'throw'` makes
 *    it reject (for the logger-warn spec).
 *  - `pendingEntries` reports a fake buffered count so
 *    `bufferSize()` returns a driven value when a test wants to
 *    decouple the recorder from the `UsageBuffer` injected into the
 *    scheduler.
 */
export class FakeUsageRecorder implements UsageRecorder {
  flushCalls = 0;
  recordCalls = 0;
  /**
   * When set, the NEXT `flush()` call parks on this promise. Tests
   * call `fake.releaseFlush()` to let it proceed. Cleared after use —
   * subsequent flushes resolve instantly.
   */
  private flushGate: Promise<void> | undefined;
  private releaseGate: (() => void) | undefined;
  /** Controls the resolution/rejection of the next `flush()` call. */
  nextFlushResult: 'resolve' | 'throw' = 'resolve';
  /** Error used when `nextFlushResult === 'throw'`. */
  flushError: Error = new Error('fake recorder: flush failed');

  /** Set so the next `flush()` will block until `releaseFlush()` is called. */
  gateNextFlush(): void {
    this.flushGate = new Promise<void>((resolve) => {
      this.releaseGate = resolve;
    });
  }

  /** Release the parked flush (if any). No-op if no flush is parked. */
  releaseFlush(): void {
    this.releaseGate?.();
    this.releaseGate = undefined;
    this.flushGate = undefined;
  }

  async record(_entry: UsageEntry): Promise<void> {
    this.recordCalls += 1;
  }

  async flush(): Promise<void> {
    this.flushCalls += 1;
    if (this.flushGate !== undefined) {
      await this.flushGate;
    }
    if (this.nextFlushResult === 'throw') {
      // Consume the one-shot; a second flush default-resolves.
      this.nextFlushResult = 'resolve';
      throw this.flushError;
    }
  }

  bufferSize(): number {
    return 0;
  }
}
