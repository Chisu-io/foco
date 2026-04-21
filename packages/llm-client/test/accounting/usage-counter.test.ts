/**
 * Tests for `UsageRecorder` / `UsageBuffer` / `llm.accounting.write`
 * sub-span. Covers §3.2 (entry shape), §4.3 (buffer + drop semantics),
 * §5.2 (counters + gauge), §5.3 (sub-span attrs + prohibited attrs) of
 * `.cmsgs/iter7-accounting-design.md`.
 *
 * Two test groups:
 *
 *  1. **Recorder semantics** — writer ok / failed / buffer-full /
 *     flush. Uses an `InMemoryMetrics` sink + a configurable fake
 *     writer. No OTel wiring needed.
 *
 *  2. **OTel sub-span** — spans are emitted with the correct
 *     attributes and status, and no prohibited attributes (user_id,
 *     prompt_hash, trace_id, api_key) leak. Wires a real
 *     `BasicTracerProvider` + `InMemorySpanExporter`, same pattern as
 *     `test/observability/tracing.test.ts`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
  USAGE_BUFFER_SIZE_GAUGE,
  USAGE_WRITE_SPAN_NAME,
  USAGE_WRITES_COUNTER,
  USAGE_WRITES_DROPPED_COUNTER,
  USAGE_WRITES_FAILED_COUNTER,
  UsageBuffer,
  classifyWriterFailure,
  createUsageRecorder,
  type UsageEntry,
} from '../../src/accounting/usage-counter.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';
import {
  resetTracer,
  setTracer,
} from '../../src/observability/tracing.js';

// ─── Fixtures ──────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    userId: 'user-abc',
    occurredAt: new Date('2026-04-20T12:00:00.000Z'),
    provider: 'anthropic',
    model: 'claude-haiku-4-5',
    fundingMode: 'byok',
    origin: 'assistant-conversation',
    inputTokens: 100,
    outputTokens: 50,
    latencyMs: 250,
    traceId: 'aaaabbbbccccddddeeeeffff00001111',
    consentMode: 'full',
    promptHash: 'a'.repeat(64),
    kekVersion: 7,
    ...overrides,
  };
}

/**
 * Writer that can be toggled between "always succeed" and "always
 * fail" from the test, and that counts calls per entry (the `Map` is
 * keyed by userId because entries are otherwise identical).
 */
function makeToggleWriter(initial: 'ok' | Error = 'ok') {
  let state: 'ok' | Error = initial;
  const calls: UsageEntry[] = [];
  const writer = async (entry: UsageEntry): Promise<void> => {
    calls.push(entry);
    if (state !== 'ok') throw state;
  };
  return {
    writer,
    calls,
    setOk(): void {
      state = 'ok';
    },
    fail(err: Error): void {
      state = err;
    },
  };
}

// ─── Recorder semantics ────────────────────────────────────────────────

describe('createUsageRecorder — happy path', () => {
  it('writes through to the writer and emits {result:"ok"} + gauge on success', async () => {
    const metrics = new InMemoryMetrics();
    const { writer, calls } = makeToggleWriter('ok');
    const recorder = createUsageRecorder({ writer, metrics });

    await recorder.record(makeEntry());

    expect(calls).toHaveLength(1);
    expect(recorder.bufferSize()).toBe(0);
    expect(
      metrics.readCounter(USAGE_WRITES_COUNTER, {
        consent_mode: 'full',
        funding_mode: 'byok',
        result: 'ok',
      }),
    ).toBe(1);
    expect(metrics.readCounter(USAGE_WRITES_FAILED_COUNTER)).toBe(0);
    expect(metrics.readCounter(USAGE_WRITES_DROPPED_COUNTER)).toBe(0);
    expect(metrics.readGauge(USAGE_BUFFER_SIZE_GAUGE)).toBe(0);
  });

  it('labels the counter with the entry consent_mode and funding_mode verbatim', async () => {
    const metrics = new InMemoryMetrics();
    const { writer } = makeToggleWriter('ok');
    const recorder = createUsageRecorder({ writer, metrics });

    await recorder.record(
      makeEntry({ consentMode: 'minimal', fundingMode: 'managed' }),
    );

    expect(
      metrics.readCounter(USAGE_WRITES_COUNTER, {
        consent_mode: 'minimal',
        funding_mode: 'managed',
        result: 'ok',
      }),
    ).toBe(1);
  });
});

describe('createUsageRecorder — writer failure', () => {
  it('buffers the entry on writer throw and emits {result:"buffered"} + failure reason', async () => {
    const metrics = new InMemoryMetrics();
    const toggle = makeToggleWriter(new Error('connection terminated'));
    const recorder = createUsageRecorder({ writer: toggle.writer, metrics });

    await recorder.record(makeEntry());

    expect(recorder.bufferSize()).toBe(1);
    expect(
      metrics.readCounter(USAGE_WRITES_COUNTER, {
        consent_mode: 'full',
        funding_mode: 'byok',
        result: 'buffered',
      }),
    ).toBe(1);
    // Generic writer error → `db_down` default.
    expect(
      metrics.readCounter(USAGE_WRITES_FAILED_COUNTER, { reason: 'db_down' }),
    ).toBe(1);
    expect(metrics.readGauge(USAGE_BUFFER_SIZE_GAUGE)).toBe(1);
    expect(metrics.readCounter(USAGE_WRITES_DROPPED_COUNTER)).toBe(0);
  });

  it('classifies timeout errors into {reason:"timeout"}', async () => {
    const metrics = new InMemoryMetrics();
    const err = Object.assign(new Error('something went wrong'), {
      name: 'AbortError',
    });
    const toggle = makeToggleWriter(err);
    const recorder = createUsageRecorder({ writer: toggle.writer, metrics });

    await recorder.record(makeEntry());
    expect(
      metrics.readCounter(USAGE_WRITES_FAILED_COUNTER, { reason: 'timeout' }),
    ).toBe(1);
  });

  it('classifies network errors into {reason:"network"}', async () => {
    const metrics = new InMemoryMetrics();
    const toggle = makeToggleWriter(
      new Error('getaddrinfo ENOTFOUND db.internal'),
    );
    const recorder = createUsageRecorder({ writer: toggle.writer, metrics });

    await recorder.record(makeEntry());
    expect(
      metrics.readCounter(USAGE_WRITES_FAILED_COUNTER, { reason: 'network' }),
    ).toBe(1);
  });

  it('never throws out to the caller on writer failure', async () => {
    const metrics = new InMemoryMetrics();
    const toggle = makeToggleWriter(new Error('boom'));
    const recorder = createUsageRecorder({ writer: toggle.writer, metrics });

    await expect(recorder.record(makeEntry())).resolves.toBeUndefined();
  });
});

describe('createUsageRecorder — buffer overflow', () => {
  it('drops new entries when the buffer is full and emits dropped counter + P1 label', async () => {
    const metrics = new InMemoryMetrics();
    const toggle = makeToggleWriter(new Error('db down'));
    const buffer = new UsageBuffer(2); // tiny cap for the test
    const recorder = createUsageRecorder({
      writer: toggle.writer,
      metrics,
      buffer,
    });

    await recorder.record(makeEntry());
    await recorder.record(makeEntry());
    // Buffer is now at capacity (2 entries both failed to write).
    await recorder.record(makeEntry());

    expect(recorder.bufferSize()).toBe(2);
    expect(
      metrics.readCounter(USAGE_WRITES_COUNTER, {
        consent_mode: 'full',
        funding_mode: 'byok',
        result: 'buffered',
      }),
    ).toBe(2);
    expect(
      metrics.readCounter(USAGE_WRITES_COUNTER, {
        consent_mode: 'full',
        funding_mode: 'byok',
        result: 'dropped',
      }),
    ).toBe(1);
    expect(
      metrics.readCounter(USAGE_WRITES_DROPPED_COUNTER, {
        reason: 'buffer_full',
      }),
    ).toBe(1);
  });
});

describe('createUsageRecorder — flush()', () => {
  it('drains the buffer when the writer has recovered', async () => {
    const metrics = new InMemoryMetrics();
    const toggle = makeToggleWriter(new Error('db down'));
    const recorder = createUsageRecorder({ writer: toggle.writer, metrics });

    await recorder.record(makeEntry());
    await recorder.record(makeEntry());
    expect(recorder.bufferSize()).toBe(2);

    toggle.setOk();
    await recorder.flush();

    expect(recorder.bufferSize()).toBe(0);
    expect(metrics.readGauge(USAGE_BUFFER_SIZE_GAUGE)).toBe(0);
    // Two buffered + two ok (from flush).
    expect(
      metrics.readCounter(USAGE_WRITES_COUNTER, {
        consent_mode: 'full',
        funding_mode: 'byok',
        result: 'ok',
      }),
    ).toBe(2);
  });

  it('partial drain — entries that still fail on flush stay in the buffer', async () => {
    const metrics = new InMemoryMetrics();
    const toggle = makeToggleWriter(new Error('db down'));
    const recorder = createUsageRecorder({ writer: toggle.writer, metrics });

    await recorder.record(makeEntry());
    await recorder.record(makeEntry());
    await recorder.flush(); // writer still failing

    // Both still buffered. Flush re-tried each; they went back in.
    expect(recorder.bufferSize()).toBe(2);
    // `result: buffered` counter increments for both original writes
    // AND both flush re-tries (4 total).
    expect(
      metrics.readCounter(USAGE_WRITES_COUNTER, {
        consent_mode: 'full',
        funding_mode: 'byok',
        result: 'buffered',
      }),
    ).toBe(4);
  });

  it('flush on an empty buffer still emits a fresh gauge reading', async () => {
    const metrics = new InMemoryMetrics();
    const { writer } = makeToggleWriter('ok');
    const recorder = createUsageRecorder({ writer, metrics });

    await recorder.flush();
    expect(metrics.readGauge(USAGE_BUFFER_SIZE_GAUGE)).toBe(0);
  });

  it('preserves the original occurredAt on buffered entries when they flush', async () => {
    const metrics = new InMemoryMetrics();
    const toggle = makeToggleWriter(new Error('db down'));
    const recorder = createUsageRecorder({ writer: toggle.writer, metrics });

    const originalOccurredAt = new Date('2026-04-20T08:00:00.000Z');
    await recorder.record(makeEntry({ occurredAt: originalOccurredAt }));

    toggle.setOk();
    await recorder.flush();

    // The last writer invocation (the flush re-try) got the SAME
    // occurredAt — not the wall-clock time at flush.
    const flushed = toggle.calls[toggle.calls.length - 1]!;
    expect(flushed.occurredAt.toISOString()).toBe(
      originalOccurredAt.toISOString(),
    );
  });
});

// ─── classifyWriterFailure — direct unit coverage ──────────────────────

describe('classifyWriterFailure', () => {
  it('defaults unknown errors to db_down', () => {
    expect(classifyWriterFailure(new Error('rows cannot be null'))).toBe(
      'db_down',
    );
  });

  it('recognises AbortError / TimeoutError as timeout', () => {
    expect(
      classifyWriterFailure(
        Object.assign(new Error('x'), { name: 'AbortError' }),
      ),
    ).toBe('timeout');
    expect(
      classifyWriterFailure(
        Object.assign(new Error('x'), { name: 'TimeoutError' }),
      ),
    ).toBe('timeout');
  });

  it('recognises timeout in the message', () => {
    expect(classifyWriterFailure(new Error('connection timeout'))).toBe(
      'timeout',
    );
  });

  it('recognises common network error codes', () => {
    expect(
      classifyWriterFailure(new Error('getaddrinfo ENOTFOUND pg.internal')),
    ).toBe('network');
    expect(classifyWriterFailure(new Error('connect ECONNREFUSED'))).toBe(
      'network',
    );
  });

  it('recognises serialization errors', () => {
    expect(
      classifyWriterFailure(
        Object.assign(new Error('Unexpected token in JSON'), {
          name: 'SyntaxError',
        }),
      ),
    ).toBe('serialization');
  });

  it('returns db_down for non-Error thrown values', () => {
    expect(classifyWriterFailure('a string')).toBe('db_down');
    expect(classifyWriterFailure(42)).toBe('db_down');
    expect(classifyWriterFailure(null)).toBe('db_down');
  });
});

// ─── UsageBuffer direct unit coverage ──────────────────────────────────

describe('UsageBuffer', () => {
  it('rejects invalid capacities', () => {
    expect(() => new UsageBuffer(0)).toThrow(/positive integer/);
    expect(() => new UsageBuffer(-1)).toThrow(/positive integer/);
    expect(() => new UsageBuffer(1.5)).toThrow(/positive integer/);
  });

  it('reports isFull correctly', () => {
    const buf = new UsageBuffer(1);
    expect(buf.isFull()).toBe(false);
    buf.push(makeEntry());
    expect(buf.isFull()).toBe(true);
  });

  it('drain empties the buffer and returns a snapshot', () => {
    const buf = new UsageBuffer(5);
    buf.push(makeEntry());
    buf.push(makeEntry());
    const snap = buf.drain();
    expect(snap).toHaveLength(2);
    expect(buf.size()).toBe(0);
  });
});

// ─── OTel sub-span ─────────────────────────────────────────────────────

describe('llm.accounting.write sub-span', () => {
  let exporter: InMemorySpanExporter;
  let provider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    setTracer(provider.getTracer('test'));
  });

  afterEach(async () => {
    resetTracer();
    exporter.reset();
    await provider.shutdown();
  });

  it('emits a CLIENT span with the expected attributes and status OK on success', async () => {
    const metrics = new InMemoryMetrics();
    const { writer } = makeToggleWriter('ok');
    const recorder = createUsageRecorder({ writer, metrics });

    await recorder.record(makeEntry({ kekVersion: 12 }));

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe(USAGE_WRITE_SPAN_NAME);
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['llm.provider']).toBe('anthropic');
    expect(span.attributes['consent_mode']).toBe('full');
    expect(span.attributes['funding_mode']).toBe('byok');
    expect(span.attributes['origin']).toBe('assistant-conversation');
    expect(span.attributes['kek.version']).toBe(12);
    expect(span.attributes['result']).toBe('ok');
    expect(span.status.code).toBe(SpanStatusCode.OK);
  });

  it('omits kek.version when the entry has no KEK version (managed calls)', async () => {
    const metrics = new InMemoryMetrics();
    const { writer } = makeToggleWriter('ok');
    const recorder = createUsageRecorder({ writer, metrics });

    await recorder.record(
      makeEntry({ fundingMode: 'managed', kekVersion: undefined }),
    );

    const span = exporter.getFinishedSpans()[0]!;
    expect('kek.version' in span.attributes).toBe(false);
    expect(span.attributes['funding_mode']).toBe('managed');
  });

  it('sets ERROR status with message=reason when the writer fails and entry is buffered', async () => {
    const metrics = new InMemoryMetrics();
    const toggle = makeToggleWriter(new Error('timeout waiting for pg'));
    const recorder = createUsageRecorder({ writer: toggle.writer, metrics });

    await recorder.record(makeEntry());

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('timeout');
    expect(span.attributes['result']).toBe('buffered');
    // No recordException — accounting spans must not leak the raw
    // writer error into the OTel event bag.
    expect(span.events).toHaveLength(0);
  });

  it('sets ERROR status with message=buffer_full when the buffer overflows', async () => {
    const metrics = new InMemoryMetrics();
    const toggle = makeToggleWriter(new Error('db down'));
    const buffer = new UsageBuffer(1);
    const recorder = createUsageRecorder({
      writer: toggle.writer,
      metrics,
      buffer,
    });

    await recorder.record(makeEntry()); // fills the buffer
    exporter.reset();
    await recorder.record(makeEntry()); // overflow

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('buffer_full');
    expect(span.attributes['result']).toBe('dropped');
  });

  it('never stamps prohibited attributes (user_id, prompt_hash, trace_id, api_key)', async () => {
    const metrics = new InMemoryMetrics();
    const { writer } = makeToggleWriter('ok');
    const recorder = createUsageRecorder({ writer, metrics });

    await recorder.record(makeEntry());

    const span = exporter.getFinishedSpans()[0]!;
    const attrKeys = Object.keys(span.attributes);
    for (const forbidden of [
      'user_id',
      'user.id',
      'prompt_hash',
      'trace_id',
      'api_key',
      'ciphertext',
    ]) {
      expect(attrKeys).not.toContain(forbidden);
    }
  });
});
