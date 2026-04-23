/**
 * Tests for {@link FlushScheduler}.
 *
 * Contract the tests encode (iter 8 commit 2, `.cmsgs/iter8-prompt.md`
 * "Shape mínimo" + "flush.trigger" + "Tests mínimos"):
 *
 *  1. **Defaults + validation.**
 *     - `intervalMs <= 0`, non-finite → throw at construction.
 *     - `thresholdFraction` outside `(0, 1]` → throw at construction.
 *     - Accepts `thresholdFraction === 1` (inclusive).
 *     - Counter name + default constants are the signed values.
 *  2. **`start()` / `stop()` idempotency.**
 *     - Double `start()` registers one timer.
 *     - Double `stop()` resolves once, no errors.
 *     - `start()` after `stop()` is a no-op (stopped stays stopped).
 *  3. **Interval trigger.**
 *     - Timer fires `flushNow('interval')` at each `intervalMs`.
 *     - Counter increments with `{trigger:'interval'}` on non-empty runs.
 *  4. **Threshold trigger.**
 *     - `notifyBufferChanged(size)` with `size >= thresholdSize` fires
 *       ONE flush; subsequent calls above threshold do not re-fire
 *       until the buffer drops below (storm prevention).
 *     - Re-arm on a later `notifyBufferChanged(size < threshold)`.
 *     - Re-arm on a successful flush that drains below the threshold.
 *     - `notifyBufferChanged` after `stop()` is a silent no-op.
 *  5. **Close trigger.**
 *     - `stop()` runs a final `'close'` flush.
 *     - Non-empty buffer at close → counter increment
 *       `{trigger:'close'}`. Empty buffer → no counter emission.
 *  6. **Empty-buffer short-circuit.**
 *     - `runFlush` on empty buffer does NOT increment the counter and
 *       does NOT call `recorder.flush()`.
 *  7. **Non-throwing + logger.warn on recorder failure.**
 *     - A rejected `recorder.flush()` is caught; a single `warn` fires
 *       with `{trigger, error}` metadata; counter still increments
 *       (operators see the attempted run).
 *  8. **Concurrent serialisation.**
 *     - Two concurrent `flushNow()` calls do not overlap — the second
 *       starts after the first resolves.
 *
 * All timer-driven specs use `vi.useFakeTimers()` so no real time
 * passes during the suite.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeLogger, FakeUsageRecorder } from './_fakes.js';
import { UsageBuffer } from '../../src/accounting/usage-counter.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';
import {
  DEFAULT_FLUSH_INTERVAL_MS,
  DEFAULT_FLUSH_THRESHOLD_FRACTION,
  FLUSH_SCHEDULER_RUNS_COUNTER,
  FlushScheduler,
  type FlushSchedulerDeps,
} from '../../src/scheduler/flush-scheduler.js';

/**
 * Factory that produces a scheduler + all fakes with sensible defaults.
 * Tests override what they need and leave the rest defaulted.
 *
 * `seedBuffer` primes the buffer with N entries so a flush is
 * non-empty. The entry shape is only read by the recorder fake (which
 * ignores it), so a cast is the cheapest way to satisfy the type.
 */
function makeScheduler(
  overrides: Partial<Pick<FlushSchedulerDeps, 'intervalMs' | 'thresholdFraction'>> & {
    bufferCapacity?: number;
    seedBuffer?: number;
  } = {},
) {
  const buffer = new UsageBuffer(overrides.bufferCapacity ?? 10);
  if (overrides.seedBuffer !== undefined) {
    for (let i = 0; i < overrides.seedBuffer; i += 1) {
      // Cast: recorder fake never reads the entry — a typed placeholder
      // is not worth the import surface.
      buffer.push({ userId: `u-${String(i)}` } as never);
    }
  }
  const recorder = new FakeUsageRecorder();
  const metrics = new InMemoryMetrics();
  const logger = new FakeLogger();
  const clock = (): number => 0;
  const scheduler = new FlushScheduler({
    buffer,
    recorder,
    metrics,
    logger,
    clock,
    intervalMs: overrides.intervalMs ?? 5_000,
    thresholdFraction:
      overrides.thresholdFraction ?? DEFAULT_FLUSH_THRESHOLD_FRACTION,
  });
  return { buffer, recorder, metrics, logger, scheduler };
}

describe('FlushScheduler — constants + construction validation', () => {
  it('exports the signed default interval', () => {
    expect(DEFAULT_FLUSH_INTERVAL_MS).toBe(5_000);
  });

  it('exports the signed default threshold fraction', () => {
    expect(DEFAULT_FLUSH_THRESHOLD_FRACTION).toBe(0.8);
  });

  it('exports the signed counter name', () => {
    expect(FLUSH_SCHEDULER_RUNS_COUNTER).toBe(
      'llm_flush_scheduler_runs_total',
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['+Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('throws on invalid intervalMs (%s)', (_label, invalid) => {
    expect(() => makeScheduler({ intervalMs: invalid })).toThrow(
      /intervalMs must be a positive finite number/,
    );
  });

  it.each([
    ['zero', 0],
    ['negative', -0.1],
    ['greater than 1', 1.01],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('throws on invalid thresholdFraction (%s)', (_label, invalid) => {
    expect(() => makeScheduler({ thresholdFraction: invalid })).toThrow(
      /thresholdFraction must be in \(0, 1]/,
    );
  });

  it('accepts thresholdFraction === 1 (upper bound inclusive)', () => {
    expect(() =>
      makeScheduler({ thresholdFraction: 1, bufferCapacity: 10 }),
    ).not.toThrow();
  });

  it('computes thresholdSize as ceil(capacity * fraction)', () => {
    const { scheduler } = makeScheduler({
      bufferCapacity: 1000,
      thresholdFraction: 0.8,
    });
    expect(scheduler.thresholdSizeForTests).toBe(800);
  });

  it('thresholdSize floors at 1 on tiny buffers so the trigger can still fire', () => {
    // capacity=1, fraction=0.01 → 0.01 → ceil → 1 (the `max(1, ...)` path
    // only matters for the degenerate ceil-rounds-to-zero case, which
    // `Math.ceil` on a positive number never does. The guard is belt-
    // and-braces for future contributors who might substitute `floor`.)
    const { scheduler } = makeScheduler({
      bufferCapacity: 1,
      thresholdFraction: 0.01,
    });
    expect(scheduler.thresholdSizeForTests).toBe(1);
  });
});

describe('FlushScheduler — start() / stop() idempotency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('double start() registers one timer only', async () => {
    const { recorder, scheduler } = makeScheduler({
      intervalMs: 1_000,
      seedBuffer: 1,
    });
    scheduler.start();
    scheduler.start();
    await vi.advanceTimersByTimeAsync(1_000);
    // One call, not two — a second timer would have fired in parallel.
    expect(recorder.flushCalls).toBe(1);
    await scheduler.stop();
  });

  it('double stop() resolves without error', async () => {
    const { scheduler } = makeScheduler({ seedBuffer: 0 });
    scheduler.start();
    await scheduler.stop();
    await expect(scheduler.stop()).resolves.toBeUndefined();
  });

  it('start() after stop() is a no-op (stopped stays stopped)', async () => {
    const { recorder, scheduler } = makeScheduler({
      intervalMs: 1_000,
      seedBuffer: 1,
    });
    scheduler.start();
    await scheduler.stop();
    scheduler.start(); // should NOT resurrect the timer
    await vi.advanceTimersByTimeAsync(5_000);
    // Only the `close` flush fired on stop, nothing since.
    expect(recorder.flushCalls).toBe(1);
  });
});

describe('FlushScheduler — interval trigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires on each intervalMs tick with a non-empty buffer', async () => {
    const { recorder, metrics, scheduler } = makeScheduler({
      intervalMs: 1_000,
      seedBuffer: 1,
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(recorder.flushCalls).toBe(3);
    expect(
      metrics.readCounter(FLUSH_SCHEDULER_RUNS_COUNTER, {
        trigger: 'interval',
      }),
    ).toBe(3);

    await scheduler.stop();
  });

  it('does NOT increment counter on empty-buffer interval ticks', async () => {
    const { recorder, metrics, scheduler } = makeScheduler({
      intervalMs: 1_000,
      // seedBuffer omitted → buffer stays empty
    });
    scheduler.start();

    await vi.advanceTimersByTimeAsync(3_000);

    expect(recorder.flushCalls).toBe(0);
    expect(
      metrics.readCounter(FLUSH_SCHEDULER_RUNS_COUNTER, {
        trigger: 'interval',
      }),
    ).toBe(0);

    await scheduler.stop();
  });
});

describe('FlushScheduler — threshold trigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fires one flush when buffer crosses threshold', async () => {
    const { buffer, recorder, metrics, scheduler } = makeScheduler({
      bufferCapacity: 10,
      thresholdFraction: 0.8,
      seedBuffer: 8, // = threshold
    });
    scheduler.notifyBufferChanged(buffer.size());
    // Drain any microtasks scheduled by the `void flushNow()` call.
    await vi.advanceTimersByTimeAsync(0);

    expect(recorder.flushCalls).toBe(1);
    expect(
      metrics.readCounter(FLUSH_SCHEDULER_RUNS_COUNTER, {
        trigger: 'threshold',
      }),
    ).toBe(1);
  });

  it('does not re-fire while buffer stays above threshold (storm prevention)', async () => {
    const { buffer, recorder, scheduler } = makeScheduler({
      bufferCapacity: 10,
      thresholdFraction: 0.8,
      seedBuffer: 8,
    });
    // Recorder leaves buffer untouched in this fake — the entries do
    // not drain. That mimics a down writer / buffered-only scenario.
    recorder.gateNextFlush();

    scheduler.notifyBufferChanged(buffer.size()); // fires
    scheduler.notifyBufferChanged(buffer.size()); // armed=false, no-op
    scheduler.notifyBufferChanged(buffer.size()); // no-op
    await vi.advanceTimersByTimeAsync(0);

    expect(recorder.flushCalls).toBe(1);
    recorder.releaseFlush();
  });

  it('re-arms when notifyBufferChanged reports size below threshold', async () => {
    const { buffer, recorder, scheduler } = makeScheduler({
      bufferCapacity: 10,
      thresholdFraction: 0.8,
      seedBuffer: 8,
    });
    scheduler.notifyBufferChanged(buffer.size()); // fires (1)
    await vi.advanceTimersByTimeAsync(0);
    scheduler.notifyBufferChanged(0); // re-arms
    buffer.push({ userId: 'u' } as never);
    // Fill back up to threshold the "natural" way — just re-notify.
    for (let i = 0; i < 7; i += 1) buffer.push({ userId: `u-${String(i)}` } as never);
    scheduler.notifyBufferChanged(buffer.size()); // fires (2)
    await vi.advanceTimersByTimeAsync(0);

    expect(recorder.flushCalls).toBe(2);
  });

  it('re-arms after a flush drains the buffer below threshold', async () => {
    // After the first flush, `recorder.flush()` resolves and the test's
    // UsageBuffer is manually drained (simulating the recorder's real
    // drain behaviour) so the post-flush `runFlush` re-arm path fires.
    const { buffer, recorder, scheduler } = makeScheduler({
      bufferCapacity: 10,
      thresholdFraction: 0.8,
      seedBuffer: 8,
    });
    // Swap in a recorder that drains the real buffer on flush.
    const origFlush = recorder.flush.bind(recorder);
    recorder.flush = async (): Promise<void> => {
      buffer.drain(); // simulate the recorder actually clearing entries
      await origFlush();
    };

    scheduler.notifyBufferChanged(buffer.size()); // fires (1)
    await vi.advanceTimersByTimeAsync(0);
    expect(recorder.flushCalls).toBe(1);
    expect(buffer.size()).toBe(0);

    // Refill above threshold — threshold should fire again because
    // runFlush saw size < thresholdSize after the drain and re-armed.
    for (let i = 0; i < 8; i += 1) buffer.push({ userId: `u-${String(i)}` } as never);
    scheduler.notifyBufferChanged(buffer.size()); // fires (2)
    await vi.advanceTimersByTimeAsync(0);
    expect(recorder.flushCalls).toBe(2);
  });

  it('ignores notifyBufferChanged after stop()', async () => {
    const { buffer, recorder, scheduler } = makeScheduler({
      bufferCapacity: 10,
      thresholdFraction: 0.8,
      seedBuffer: 0,
    });
    await scheduler.stop();
    buffer.push({ userId: 'late' } as never);
    scheduler.notifyBufferChanged(buffer.size());
    await vi.advanceTimersByTimeAsync(0);

    // No flushes were triggered by the late notify. (The empty-buffer
    // `close` flush at `stop()` is the only flushNow call we made, and
    // it short-circuits on size === 0 so `flushCalls` stays at 0.)
    expect(recorder.flushCalls).toBe(0);
  });
});

describe('FlushScheduler — close trigger', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs a final flush with trigger=close when buffer non-empty', async () => {
    const { recorder, metrics, scheduler } = makeScheduler({
      intervalMs: 10_000,
      seedBuffer: 2,
    });
    scheduler.start();
    await scheduler.stop();

    expect(recorder.flushCalls).toBe(1);
    expect(
      metrics.readCounter(FLUSH_SCHEDULER_RUNS_COUNTER, {
        trigger: 'close',
      }),
    ).toBe(1);
  });

  it('does NOT increment counter on close with empty buffer', async () => {
    const { recorder, metrics, scheduler } = makeScheduler({
      intervalMs: 10_000,
      seedBuffer: 0,
    });
    scheduler.start();
    await scheduler.stop();

    expect(recorder.flushCalls).toBe(0);
    expect(
      metrics.readCounter(FLUSH_SCHEDULER_RUNS_COUNTER, {
        trigger: 'close',
      }),
    ).toBe(0);
  });

  it('clears the interval timer — no further callbacks fire after stop()', async () => {
    const { recorder, scheduler } = makeScheduler({
      intervalMs: 1_000,
      seedBuffer: 1,
    });
    scheduler.start();
    await scheduler.stop();
    const callsAtStop = recorder.flushCalls; // should be 1 from `close`

    await vi.advanceTimersByTimeAsync(10_000);

    expect(recorder.flushCalls).toBe(callsAtStop);
  });

  it('stop() awaits an in-flight interval flush before clearing', async () => {
    const { recorder, scheduler } = makeScheduler({
      intervalMs: 1_000,
      seedBuffer: 1,
    });
    recorder.gateNextFlush();
    scheduler.start();

    // Fire the first interval — it parks on the gate.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(recorder.flushCalls).toBe(1);

    const stopPromise = scheduler.stop();
    // Release the in-flight flush; stop() should still resolve cleanly
    // after awaiting it.
    recorder.releaseFlush();
    await stopPromise;

    // `close` flush ran too (buffer still has the seed entry).
    expect(recorder.flushCalls).toBe(2);
  });
});

describe('FlushScheduler — empty-buffer short-circuit', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('flushNow on empty buffer does not call recorder nor emit counter', async () => {
    const { recorder, metrics, scheduler } = makeScheduler({
      seedBuffer: 0,
    });
    await scheduler.flushNow('interval');
    expect(recorder.flushCalls).toBe(0);
    expect(
      metrics.readCounter(FLUSH_SCHEDULER_RUNS_COUNTER, {
        trigger: 'interval',
      }),
    ).toBe(0);
  });
});

describe('FlushScheduler — non-throwing + logger.warn on recorder failure', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('catches recorder.flush() rejection, logs warn, still emits counter', async () => {
    const { recorder, metrics, logger, scheduler } = makeScheduler({
      seedBuffer: 1,
    });
    recorder.nextFlushResult = 'throw';
    recorder.flushError = new Error('fake: writer down');

    await expect(scheduler.flushNow('interval')).resolves.toBeUndefined();

    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]!.msg).toMatch(/flush scheduler/i);
    expect(logger.warnings[0]!.meta).toEqual({
      trigger: 'interval',
      error: 'fake: writer down',
    });
    expect(
      metrics.readCounter(FLUSH_SCHEDULER_RUNS_COUNTER, {
        trigger: 'interval',
      }),
    ).toBe(1);
  });

  it('handles non-Error rejection values (String(err) fallback)', async () => {
    const { recorder, logger, scheduler } = makeScheduler({ seedBuffer: 1 });
    recorder.nextFlushResult = 'throw';
    // Force the rejection to be a non-Error primitive.
    recorder.flushError = 'plain string reason' as unknown as Error;

    await scheduler.flushNow('interval');

    expect(logger.warnings).toHaveLength(1);
    expect(logger.warnings[0]!.meta).toEqual({
      trigger: 'interval',
      error: 'plain string reason',
    });
  });
});

describe('FlushScheduler — serialisation of concurrent flushNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('second flushNow waits for the first to finish', async () => {
    const { recorder, scheduler } = makeScheduler({ seedBuffer: 1 });
    recorder.gateNextFlush();

    const a = scheduler.flushNow('interval');
    const b = scheduler.flushNow('threshold');

    // At this point `a` is parked in the recorder; `b` is awaiting `a`.
    // Neither has completed yet.
    let aDone = false;
    let bDone = false;
    void a.then(() => (aDone = true));
    void b.then(() => (bDone = true));

    // Yield so any microtasks settle. Neither should be done yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(aDone).toBe(false);
    expect(bDone).toBe(false);

    // Release → both should resolve in order.
    recorder.releaseFlush();
    await a;
    await b;
    expect(aDone).toBe(true);
    expect(bDone).toBe(true);
    // Recorder.flush was called twice (once per flushNow), never
    // concurrently — the gate enforced ordering.
    expect(recorder.flushCalls).toBe(2);
  });
});
