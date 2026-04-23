/**
 * Hermetic tests for the OTel tracer DI seam + `withSpan` helper.
 *
 * Strategy: every spec wires a fresh `BasicTracerProvider` whose only
 * processor is a `SimpleSpanProcessor` feeding an
 * `InMemorySpanExporter`. We `setTracer(provider.getTracer(...))` so
 * the helper picks up the test tracer instead of OTel's no-op default,
 * then assert on the exporter's `getFinishedSpans()`.
 *
 * Coverage targets (per `feedback_foco_quality` + vitest.config.ts
 * thresholds):
 *
 *  - Happy-path span creation, attribute pass-through, status `OK`.
 *  - Error path: `setStatus(ERROR)`, `recordException`, rethrow,
 *    span.end() still called.
 *  - Non-Error rejection (string thrown) — must be wrapped into an
 *    `Error` for `recordException`.
 *  - DI fallback: with `resetTracer()` the helper falls through to
 *    `trace.getTracer(...)` (no-op tracer in test env, but the call
 *    site must not throw).
 *  - `setTracer` / `resetTracer` round-trip.
 *  - `withSpan` honours `kind` (CLIENT vs INTERNAL default).
 *  - `hashUserId` / `hashIdempotencyKey` — sha256(utf8) hex,
 *    deterministic, distinct inputs produce distinct outputs.
 */

import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';

import {
  getTracer,
  hashIdempotencyKey,
  hashUserId,
  resetTracer,
  setTracer,
  withSpan,
} from '../../src/observability/tracing.js';

let exporter: InMemorySpanExporter;
let provider: BasicTracerProvider;

beforeEach(() => {
  exporter = new InMemorySpanExporter();
  // OTel JS ≥1.26 expects span processors via the constructor; passing
  // them after construction is deprecated and will be removed.
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

describe('withSpan', () => {
  it('emits a span with the supplied name + initial attributes and status OK on success', async () => {
    const result = await withSpan(
      'llm.test.basic',
      { 'llm.provider': 'anthropic', 'llm.input_tokens': 42 },
      async () => 'ok',
    );

    expect(result).toBe('ok');
    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('llm.test.basic');
    expect(span.attributes['llm.provider']).toBe('anthropic');
    expect(span.attributes['llm.input_tokens']).toBe(42);
    expect(span.status.code).toBe(SpanStatusCode.OK);
    // Default kind = INTERNAL (we did not pass `options`).
    expect(span.kind).toBe(SpanKind.INTERNAL);
  });

  it('lets the callback stamp additional attributes mid-flight', async () => {
    await withSpan(
      'llm.test.late-attrs',
      { 'llm.provider': 'openai' },
      async (span) => {
        span.setAttribute('llm.output_tokens', 17);
        span.setAttribute('llm.latency_ms', 250);
      },
    );

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes['llm.output_tokens']).toBe(17);
    expect(span.attributes['llm.latency_ms']).toBe(250);
  });

  it('honours an explicit SpanKind option', async () => {
    await withSpan(
      'llm.test.kind',
      { 'llm.provider': 'gemini' },
      async () => undefined,
      { kind: SpanKind.CLIENT },
    );

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.kind).toBe(SpanKind.CLIENT);
  });

  it('records exceptions, sets status ERROR, ends the span and rethrows', async () => {
    const boom = new Error('kaboom');
    await expect(
      withSpan('llm.test.error', { 'llm.provider': 'anthropic' }, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('kaboom');
    expect(span.events).toHaveLength(1);
    const evt = span.events[0]!;
    expect(evt.name).toBe('exception');
    // The OTel SimpleSpanProcessor exports event attributes as a flat map.
    expect(evt.attributes?.['exception.message']).toBe('kaboom');
    // ended → endTime is non-zero
    expect(span.endTime[0] + span.endTime[1]).toBeGreaterThan(0);
  });

  it('wraps non-Error throws into an Error before recordException', async () => {
    await expect(
      withSpan('llm.test.string-throw', { 'llm.provider': 'openai' }, async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw 'literal-string';
      }),
    ).rejects.toBe('literal-string');

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('literal-string');
    expect(span.events[0]?.attributes?.['exception.message']).toBe(
      'literal-string',
    );
  });

  it('still calls span.end() when the callback throws synchronously', async () => {
    // Even if the callback synchronously throws inside the async fn,
    // `finally` must still close the span.
    await expect(
      withSpan('llm.test.sync-throw', { 'llm.provider': 'gemini' }, async () => {
        throw new Error('sync');
      }),
    ).rejects.toThrow('sync');

    const spans = exporter.getFinishedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0]!.status.code).toBe(SpanStatusCode.ERROR);
  });

  it('clones the attribute bag so callers cannot mutate post-emit', async () => {
    const attrs = { 'llm.provider': 'anthropic' as const };
    await withSpan('llm.test.clone', attrs, async () => undefined);
    // Mutating the original after the span ends must not retroactively
    // change the recorded attributes (we copy via `{ ...attrs }`).
    (attrs as Record<string, string>)['llm.provider'] = 'openai';

    const span = exporter.getFinishedSpans()[0]!;
    expect(span.attributes['llm.provider']).toBe('anthropic');
  });
});

describe('tracer DI seam', () => {
  it('setTracer overrides the global tracer', () => {
    const t = provider.getTracer('test');
    setTracer(t);
    expect(getTracer()).toBe(t);
  });

  it('resetTracer falls back to the global @opentelemetry/api tracer', () => {
    // beforeEach injected `provider.getTracer('test')`; capture it
    // before resetting so we can assert the fallback is NOT the
    // injected instance.
    const injected = getTracer();
    resetTracer();
    const fallback = getTracer();
    // `@opentelemetry/api`'s `trace.getTracer(...)` returns a fresh
    // `ProxyTracer` per call — there is no referential-identity
    // guarantee across invocations. We verify the contract
    // behaviorally instead: after reset, the helper no longer hands
    // back the injected tracer, and what it does hand back has the
    // `ProxyTracer` shape that the global API exposes.
    expect(fallback).not.toBe(injected);
    expect(fallback.constructor.name).toBe('ProxyTracer');
  });

  it('after resetTracer, withSpan still completes (no-op tracer path)', async () => {
    resetTracer();
    await expect(
      withSpan('llm.test.fallback', { 'llm.provider': 'anthropic' }, async () => 'ok'),
    ).resolves.toBe('ok');
    // The default no-op tracer does not feed our exporter — that is
    // the point. The contract is "withSpan must not throw without an
    // SDK"; the assertion above is the contract.
    expect(exporter.getFinishedSpans()).toHaveLength(0);
  });
});

describe('hashUserId / hashIdempotencyKey', () => {
  it('hashUserId returns sha256(utf8) hex — 64 chars, deterministic', () => {
    const a = hashUserId('user-123');
    const b = hashUserId('user-123');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashUserId distinguishes distinct inputs', () => {
    expect(hashUserId('user-a')).not.toBe(hashUserId('user-b'));
  });

  it('hashUserId matches the canonical sha256 hex for a known input', () => {
    // sha256("user-123") computed offline with coreutils sha256sum.
    expect(hashUserId('user-123')).toBe(
      'fcdec6df4d44dbc637c7c5b58efface52a7f8a88535423430255be0bb89bedd8',
    );
  });

  it('hashIdempotencyKey is a separate symbol with the same hashing semantics', () => {
    // Same input → same digest as hashUserId (no domain separation
    // intended in iter 6). Keeping the alias documents intent at call
    // sites.
    expect(hashIdempotencyKey('idem-42')).toBe(hashUserId('idem-42'));
    expect(hashIdempotencyKey('idem-42')).toHaveLength(64);
  });

  it('handles non-ASCII inputs deterministically (utf-8)', () => {
    const a = hashUserId('usér-✨');
    const b = hashUserId('usér-✨');
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
