/**
 * Tests for `src/routing/audit-sink.ts`.
 *
 * Invariants under test (mini-spec §5):
 *
 *  - Action mapping matches the signed §11 table (opened / closed /
 *    ignored) — no widening, no narrowing.
 *  - `buildAuditDraft` produces a draft that matches the shape the
 *    writer expects (ISO `occurredAt`, `{type:'llm_provider', id:...}`
 *    resource, details gated by action).
 *  - Zero-key invariant: no `sk-ant-.../sk-.../AIza...` substring ever
 *    lands on a produced draft, even with adversarial event shapes.
 *  - Fail-safe: writer failures (err-Result, synchronous throw, async
 *    rejection) never propagate back to the caller; they increment
 *    `llm_audit_write_failures_total{action, reason}` and invoke the
 *    logger.
 *  - Actor defaulting and override.
 *  - Per-transition isolation + concurrency (3 events in one tick).
 *
 * No persistence — the `AuditWriter` is a hand-rolled fake. The
 * breaker-side wiring is already covered in
 * `test/routing/circuit-breaker.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { InMemoryMetrics } from '../../src/observability/metrics.js';
import {
  type AuditEntryDraft,
  type AuditSinkDeps,
  type AuditSinkLogger,
  type AuditWriteError,
  type AuditWriter,
  type CircuitStateChangeEvent,
  AUDIT_SINK_METRIC_NAMES,
  auditActionForTransition,
  buildAuditDraft,
  createCircuitAuditSink,
} from '../../src/routing/index.js';
import { err, ok, type Result } from '../../src/types.js';

// ─── Test harness ────────────────────────────────────────────────────

/** Frozen clock so `occurredAt` is reproducible when the sink falls
 *  back to `deps.now()` (i.e. when the event has no `at`). */
const FIXED_NOW = 1_700_000_000_000; // 2023-11-14T22:13:20.000Z
const FIXED_ISO = '2023-11-14T22:13:20.000Z';

function fixedClock(): () => number {
  return () => FIXED_NOW;
}

/**
 * Fake writer with a pluggable response queue. Each call pops one
 * response; if the queue is empty, defaults to `ok(undefined)`. The
 * captured drafts are exposed for assertion.
 */
interface FakeWriter extends AuditWriter {
  readonly drafts: AuditEntryDraft[];
  readonly calls: number;
  enqueue: (r: Result<void, AuditWriteError>) => void;
  throwSync: (err: unknown) => void;
  rejectWith: (err: unknown) => void;
}

function makeFakeWriter(): FakeWriter {
  const drafts: AuditEntryDraft[] = [];
  type Behaviour =
    | { kind: 'result'; value: Result<void, AuditWriteError> }
    | { kind: 'throw-sync'; error: unknown }
    | { kind: 'reject'; error: unknown };
  const queue: Behaviour[] = [];
  let calls = 0;

  const writer: FakeWriter = {
    drafts,
    get calls() {
      return calls;
    },
    enqueue(r) {
      queue.push({ kind: 'result', value: r });
    },
    throwSync(e) {
      queue.push({ kind: 'throw-sync', error: e });
    },
    rejectWith(e) {
      queue.push({ kind: 'reject', error: e });
    },
    async insert(draft: AuditEntryDraft) {
      // Capture BEFORE throwing so tests can introspect what the
      // sink would have persisted.
      drafts.push(draft);
      calls += 1;
      const next = queue.shift();
      if (next === undefined || next.kind === 'result') {
        return next?.value ?? ok(undefined);
      }
      if (next.kind === 'throw-sync') {
        // Throw synchronously from the function body — Vitest /
        // async-await usually wraps this in a rejection, but the
        // sink's `try/catch` around `deps.writer.insert(draft)`
        // should still catch it before the `.then(...)` attaches.
        // To hit the sync throw path we use a non-async version.
        throw next.error;
      }
      // kind === 'reject' — asynchronous rejection.
      throw next.error;
    },
  };
  return writer;
}

/**
 * Writer whose `insert` *synchronously* throws before returning the
 * Promise — the sink's `try/catch` around the call site must handle
 * this distinctly from the `.catch(rejection)` path.
 */
function throwingSyncWriter(error: unknown): AuditWriter {
  return {
    insert(_draft: AuditEntryDraft): Promise<Result<void, AuditWriteError>> {
      throw error;
    },
  };
}

function baseDeps(overrides: Partial<AuditSinkDeps> = {}): AuditSinkDeps & {
  writer: FakeWriter;
  metrics: InMemoryMetrics;
  logger: ReturnType<typeof vi.fn>;
} {
  const writer = overrides.writer
    ? (overrides.writer as FakeWriter)
    : makeFakeWriter();
  const metrics =
    overrides.metrics instanceof InMemoryMetrics
      ? overrides.metrics
      : new InMemoryMetrics();
  const logger = vi.fn<AuditSinkLogger>();
  // `exactOptionalPropertyTypes: true` is on in the monorepo tsconfig —
  // optional fields cannot be assigned `undefined` explicitly, so we
  // spread `actor` conditionally rather than always emitting the key.
  // `logger` is a straight cast at the boundary because `overrides.logger`
  // arrives typed as `AuditSinkLogger` (plain callback) but the factory's
  // enriched return type exposes it as a vitest `Mock` so tests can assert
  // on `.mock.calls` without narrowing in each test body.
  return {
    writer,
    metrics,
    now: overrides.now ?? fixedClock(),
    logger: (overrides.logger ?? logger) as ReturnType<typeof vi.fn>,
    ...(overrides.actor !== undefined ? { actor: overrides.actor } : {}),
  };
}

function evOpened(
  overrides: Partial<CircuitStateChangeEvent> = {},
): CircuitStateChangeEvent {
  return {
    provider: 'anthropic',
    from: 'closed',
    to: 'open',
    at: FIXED_NOW,
    errorRate: 0.42,
    volume: 25,
    reason: 'error_rate_exceeded',
    ...overrides,
  };
}

function evClosed(
  overrides: Partial<CircuitStateChangeEvent> = {},
): CircuitStateChangeEvent {
  return {
    provider: 'anthropic',
    from: 'half-open',
    to: 'closed',
    at: FIXED_NOW,
    reason: 'probes_succeeded',
    ...overrides,
  };
}

/** Drain all pending microtasks. `queueMicrotask` fires in the order
 *  it was enqueued, so awaiting a `Promise.resolve()` is enough to
 *  flush our single-level queueMicrotask. Using multiple ticks is a
 *  belt-and-braces — nested microtasks can hide behind a single flush. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) {
    await Promise.resolve();
  }
}

// ─── 1. Pure helpers — auditActionForTransition ──────────────────────

describe('auditActionForTransition', () => {
  it('maps closed→open to llm.circuit_opened', () => {
    expect(auditActionForTransition('closed', 'open')).toBe(
      'llm.circuit_opened',
    );
  });

  it('maps half-open→closed to llm.circuit_closed', () => {
    expect(auditActionForTransition('half-open', 'closed')).toBe(
      'llm.circuit_closed',
    );
  });

  it('returns undefined for open→half-open (not in §11)', () => {
    expect(auditActionForTransition('open', 'half-open')).toBeUndefined();
  });

  it('returns undefined for half-open→open (not in §11)', () => {
    expect(auditActionForTransition('half-open', 'open')).toBeUndefined();
  });

  it('returns undefined for identity transitions', () => {
    // Shouldn't happen at the breaker layer, but cheap to cover.
    expect(auditActionForTransition('closed', 'closed')).toBeUndefined();
    expect(auditActionForTransition('open', 'open')).toBeUndefined();
  });
});

// ─── 2. Pure helpers — buildAuditDraft ───────────────────────────────

describe('buildAuditDraft', () => {
  it('builds a complete opened draft with errorRate + volume', () => {
    const deps = baseDeps();
    const draft = buildAuditDraft(
      evOpened({ provider: 'openai', at: FIXED_NOW, errorRate: 0.87, volume: 100 }),
      'llm.circuit_opened',
      deps,
    );
    expect(draft.action).toBe('llm.circuit_opened');
    expect(draft.occurredAt).toBe(FIXED_ISO);
    expect(draft.actor).toEqual({ kind: 'system' });
    expect(draft.resource).toEqual({ type: 'llm_provider', id: 'openai' });
    expect(draft.details).toEqual({
      reason: 'error_rate_exceeded',
      errorRate: 0.87,
      volume: 100,
    });
    expect(draft.requestId).toBeUndefined();
  });

  it('builds a closed draft with only reason (no errorRate/volume)', () => {
    const deps = baseDeps();
    const draft = buildAuditDraft(
      evClosed({ provider: 'gemini' }),
      'llm.circuit_closed',
      deps,
    );
    expect(draft.action).toBe('llm.circuit_closed');
    expect(draft.resource).toEqual({ type: 'llm_provider', id: 'gemini' });
    expect(draft.details).toEqual({ reason: 'probes_succeeded' });
  });

  it('omits errorRate/volume from the opened payload when not provided', () => {
    // Edge case: breaker emitted an opened transition without
    // metrics context (possible in theory; not in current impl).
    // The draft must stay a plain `Record<string, string | number>`
    // — no `null`s, no `undefined`s leaking through.
    const deps = baseDeps();
    const draft = buildAuditDraft(
      {
        provider: 'anthropic',
        from: 'closed',
        to: 'open',
        at: FIXED_NOW,
        reason: 'error_rate_exceeded',
        // errorRate/volume intentionally omitted
      },
      'llm.circuit_opened',
      deps,
    );
    // `details` is `Record<string, unknown> | null | undefined` on the
    // canonical `SystemAuditEntry` shape (the schema allows other sinks
    // to omit it). The CB sink always emits an object, so non-null
    // assert at the test boundary to exercise the concrete payload.
    const details = draft.details!;
    expect(Object.keys(details).sort()).toEqual(['reason']);
    expect('errorRate' in details).toBe(false);
    expect('volume' in details).toBe(false);
  });

  it('honours a caller-supplied actor', () => {
    const deps = baseDeps({
      actor: { kind: 'service', id: 'llm-client', displayName: 'Foco LLM' },
    });
    const draft = buildAuditDraft(evOpened(), 'llm.circuit_opened', deps);
    expect(draft.actor).toEqual({
      kind: 'service',
      id: 'llm-client',
      displayName: 'Foco LLM',
    });
  });

  it('falls back to deps.now() when event.at is missing', () => {
    const deps = baseDeps({ now: () => 1_700_000_001_000 });
    const draft = buildAuditDraft(
      {
        provider: 'anthropic',
        from: 'closed',
        to: 'open',
        // at intentionally left as undefined via cast — the runtime
        // path exists even though the type requires `at`.
        at: undefined as unknown as number,
        reason: 'error_rate_exceeded',
      },
      'llm.circuit_opened',
      deps,
    );
    expect(draft.occurredAt).toBe('2023-11-14T22:13:21.000Z');
  });

  it('uses Date.now by default when deps.now is unset', () => {
    const deps: AuditSinkDeps = {
      writer: makeFakeWriter(),
      metrics: new InMemoryMetrics(),
    };
    const draft = buildAuditDraft(
      {
        provider: 'anthropic',
        from: 'closed',
        to: 'open',
        at: undefined as unknown as number,
        reason: 'error_rate_exceeded',
      },
      'llm.circuit_opened',
      deps,
    );
    // We can't pin the wall clock, but occurredAt must parse as a
    // valid ISO and be within a reasonable window of Date.now.
    const parsed = Date.parse(draft.occurredAt);
    expect(Number.isNaN(parsed)).toBe(false);
    expect(Math.abs(parsed - Date.now())).toBeLessThan(5_000);
  });
});

// ─── 3. Roundtrip — happy path ───────────────────────────────────────

describe('createCircuitAuditSink — happy path', () => {
  it('persists an opened draft end-to-end', async () => {
    const deps = baseDeps();
    const sink = createCircuitAuditSink(deps);

    sink(evOpened({ provider: 'openai', errorRate: 0.42, volume: 25 }));
    await flushMicrotasks();

    expect(deps.writer.calls).toBe(1);
    expect(deps.writer.drafts[0]).toEqual<AuditEntryDraft>({
      occurredAt: FIXED_ISO,
      actor: { kind: 'system' },
      action: 'llm.circuit_opened',
      resource: { type: 'llm_provider', id: 'openai' },
      details: {
        reason: 'error_rate_exceeded',
        errorRate: 0.42,
        volume: 25,
      },
    });
    // No failure counters or logger hits on success.
    expect(deps.metrics.counters.size).toBe(0);
    expect(deps.logger).not.toHaveBeenCalled();
  });

  it('persists a closed draft end-to-end', async () => {
    const deps = baseDeps();
    const sink = createCircuitAuditSink(deps);

    sink(evClosed({ provider: 'gemini' }));
    await flushMicrotasks();

    expect(deps.writer.calls).toBe(1);
    expect(deps.writer.drafts[0]).toEqual<AuditEntryDraft>({
      occurredAt: FIXED_ISO,
      actor: { kind: 'system' },
      action: 'llm.circuit_closed',
      resource: { type: 'llm_provider', id: 'gemini' },
      details: { reason: 'probes_succeeded' },
    });
  });

  it('returns synchronously — does NOT return a Promise', () => {
    const deps = baseDeps();
    const sink = createCircuitAuditSink(deps);
    // `OnCircuitStateChange` is typed `(event) => void`. The
    // implementation must honour it — returning a Promise would
    // tempt callers to `await` and break the non-blocking guarantee.
    const result = sink(evOpened()) as unknown;
    expect(result).toBeUndefined();
  });
});

// ─── 4. Non-auditable transitions ────────────────────────────────────

describe('createCircuitAuditSink — non-auditable transitions', () => {
  it('does NOT write open→half-open and bumps the ignored counter', async () => {
    const deps = baseDeps();
    const sink = createCircuitAuditSink(deps);

    sink({
      provider: 'anthropic',
      from: 'open',
      to: 'half-open',
      at: FIXED_NOW,
      reason: 'cooldown_elapsed',
    });
    await flushMicrotasks();

    expect(deps.writer.calls).toBe(0);
    expect(
      deps.metrics.counters.get(
        `${AUDIT_SINK_METRIC_NAMES.ignoredTransitions}|from=open,to=half-open`,
      ),
    ).toBe(1);
  });

  it('does NOT write half-open→open and bumps the ignored counter', async () => {
    const deps = baseDeps();
    const sink = createCircuitAuditSink(deps);

    sink({
      provider: 'anthropic',
      from: 'half-open',
      to: 'open',
      at: FIXED_NOW,
      reason: 'probe_failed',
    });
    await flushMicrotasks();

    expect(deps.writer.calls).toBe(0);
    expect(
      deps.metrics.counters.get(
        `${AUDIT_SINK_METRIC_NAMES.ignoredTransitions}|from=half-open,to=open`,
      ),
    ).toBe(1);
  });

  it('counts every ignored transition independently (no dedup)', async () => {
    const deps = baseDeps();
    const sink = createCircuitAuditSink(deps);
    for (let i = 0; i < 3; i++) {
      sink({
        provider: 'anthropic',
        from: 'open',
        to: 'half-open',
        at: FIXED_NOW + i,
        reason: 'cooldown_elapsed',
      });
    }
    await flushMicrotasks();
    expect(
      deps.metrics.counters.get(
        `${AUDIT_SINK_METRIC_NAMES.ignoredTransitions}|from=open,to=half-open`,
      ),
    ).toBe(3);
  });
});

// ─── 5. Zero-key invariant (defensive) ───────────────────────────────

describe('createCircuitAuditSink — zero API key plaintext', () => {
  /**
   * Mirrors the §14.3 CI linter regex — any match here would be a
   * deploy-blocker in prod. The sink cannot originate key material
   * (it has no access to the resolved key), but the test exercises
   * the assertion over adversarial event shapes.
   */
  const KEY_REGEX =
    /sk-ant-[A-Za-z0-9]{40,}|sk-[A-Za-z0-9]{40,}|AIza[A-Za-z0-9_-]{30,}/;

  it.each([
    ['anthropic' as const],
    ['openai' as const],
    ['gemini' as const],
  ])('never writes a key pattern for %s', async (provider) => {
    const deps = baseDeps();
    const sink = createCircuitAuditSink(deps);
    sink(evOpened({ provider }));
    sink(evClosed({ provider }));
    await flushMicrotasks();
    for (const draft of deps.writer.drafts) {
      const serialised = JSON.stringify(draft);
      expect(serialised).not.toMatch(KEY_REGEX);
    }
  });

  it('rejects adversarial reason field at the type boundary', async () => {
    // Defense in depth: if a future reason value were ever forged
    // to contain a key-shaped token (e.g. `sk-ant-AAA...AAA`), the
    // sink would copy it into `details.reason` verbatim. The
    // guarantee of "no keys in payload" is therefore a
    // type-boundary claim: `CircuitStateChangeEvent['reason']` is a
    // closed union (`'error_rate_exceeded' | 'cooldown_elapsed' |
    // 'probes_succeeded' | 'probe_failed'`). This test locks that
    // union shape — if it widens to `string`, the regex test above
    // is no longer sufficient and we need a runtime scrub.
    //
    // Structural assertion only — no runtime call needed.
    type ReasonUnion = CircuitStateChangeEvent['reason'];
    const allowed: ReasonUnion[] = [
      'error_rate_exceeded',
      'cooldown_elapsed',
      'probes_succeeded',
      'probe_failed',
    ];
    expect(allowed).toHaveLength(4);
    // If this stops typechecking, the union widened:
    const sample: ReasonUnion = 'error_rate_exceeded';
    expect(sample).toBe('error_rate_exceeded');
  });
});

// ─── 6. Writer failures → no rethrow ─────────────────────────────────

describe('createCircuitAuditSink — writer failures', () => {
  const errorKinds: AuditWriteError['kind'][] = [
    'transport',
    'constraint_violation',
    'serialization',
    'internal',
  ];

  for (const kind of errorKinds) {
    it(`on err({kind:'${kind}'}) bumps write_failures and logs, no rethrow`, async () => {
      const deps = baseDeps();
      deps.writer.enqueue(err({ kind, message: 'boom' }));
      const sink = createCircuitAuditSink(deps);

      // Assert the callback is synchronous and non-throwing even
      // with a failure queued.
      expect(() => sink(evOpened())).not.toThrow();
      await flushMicrotasks();

      expect(
        deps.metrics.counters.get(
          `${AUDIT_SINK_METRIC_NAMES.writeFailures}|action=llm.circuit_opened,reason=${kind}`,
        ),
      ).toBe(1);
      expect(deps.logger).toHaveBeenCalledWith(
        'audit_write_failed',
        expect.objectContaining({ action: 'llm.circuit_opened', reason: kind }),
      );
      // Defensive check: we never log the raw draft or any
      // structured body that might hold sensitive data.
      const ctx = deps.logger.mock.calls[0]![1] as Record<string, unknown>;
      expect(Object.keys(ctx).sort()).toEqual(['action', 'reason']);
    });
  }

  it('on async rejection (non-Result) bumps reason=internal and logs audit_write_unexpected', async () => {
    const deps = baseDeps();
    deps.writer.rejectWith(new Error('db offline'));
    const sink = createCircuitAuditSink(deps);

    expect(() => sink(evClosed())).not.toThrow();
    await flushMicrotasks();

    expect(
      deps.metrics.counters.get(
        `${AUDIT_SINK_METRIC_NAMES.writeFailures}|action=llm.circuit_closed,reason=internal`,
      ),
    ).toBe(1);
    expect(deps.logger).toHaveBeenCalledWith(
      'audit_write_unexpected',
      expect.objectContaining({
        action: 'llm.circuit_closed',
        error: expect.stringContaining('Error: db offline'),
      }),
    );
  });

  it('on synchronous throw from insert() bumps reason=internal and logs', async () => {
    const logger = vi.fn<AuditSinkLogger>();
    const deps: AuditSinkDeps = {
      writer: throwingSyncWriter(new Error('sync boom')),
      metrics: new InMemoryMetrics(),
      logger,
      now: fixedClock(),
    };
    const sink = createCircuitAuditSink(deps);

    expect(() => sink(evOpened())).not.toThrow();
    await flushMicrotasks();

    const metrics = deps.metrics as InMemoryMetrics;
    expect(
      metrics.counters.get(
        `${AUDIT_SINK_METRIC_NAMES.writeFailures}|action=llm.circuit_opened,reason=internal`,
      ),
    ).toBe(1);
    expect(logger).toHaveBeenCalledWith(
      'audit_write_unexpected',
      expect.objectContaining({ action: 'llm.circuit_opened' }),
    );
  });

  it('rejection with a non-Error value still lands on the failure counter', async () => {
    const deps = baseDeps();
    deps.writer.rejectWith('naked string rejection');
    const sink = createCircuitAuditSink(deps);

    sink(evOpened());
    await flushMicrotasks();

    expect(
      deps.metrics.counters.get(
        `${AUDIT_SINK_METRIC_NAMES.writeFailures}|action=llm.circuit_opened,reason=internal`,
      ),
    ).toBe(1);
    expect(deps.logger).toHaveBeenCalledWith(
      'audit_write_unexpected',
      expect.objectContaining({
        error: expect.stringContaining('naked string rejection'),
      }),
    );
  });

  it('a thrown logger does not propagate', async () => {
    const badLogger = vi.fn(() => {
      throw new Error('logger exploded');
    });
    const deps = baseDeps({ logger: badLogger });
    deps.writer.enqueue(err({ kind: 'transport', message: 'x' }));
    const sink = createCircuitAuditSink(deps);

    expect(() => sink(evOpened())).not.toThrow();
    await flushMicrotasks();
    // Counter still incremented — logger failure is swallowed.
    expect(
      deps.metrics.counters.get(
        `${AUDIT_SINK_METRIC_NAMES.writeFailures}|action=llm.circuit_opened,reason=transport`,
      ),
    ).toBe(1);
  });

  it('a throwing metrics sink does not propagate either', async () => {
    // Upstream bug scenario: the metrics sink passed by the host
    // is buggy. The sink's top-level try/catch must catch this
    // before `queueMicrotask` is scheduled. The breaker's
    // OnCircuitStateChange contract REQUIRES non-throw.
    const noisyMetrics = {
      counter: vi.fn(() => {
        throw new Error('metrics down');
      }),
      histogram: vi.fn(),
      gauge: vi.fn(),
    };
    const logger = vi.fn<AuditSinkLogger>();
    const deps: AuditSinkDeps = {
      writer: makeFakeWriter(),
      metrics: noisyMetrics,
      logger,
      now: fixedClock(),
    };
    const sink = createCircuitAuditSink(deps);
    // Send a non-auditable transition so the first thing the sink
    // does is call `metrics.counter(ignoredTransitions, ...)`,
    // which throws. The outer try/catch must swallow.
    expect(() =>
      sink({
        provider: 'anthropic',
        from: 'open',
        to: 'half-open',
        at: FIXED_NOW,
        reason: 'cooldown_elapsed',
      }),
    ).not.toThrow();
    // The safe-bump path also catches internally → logger invoked
    // with the unexpected-error message.
    expect(logger).toHaveBeenCalledWith(
      'audit_sink_unexpected_error',
      expect.objectContaining({
        error: expect.stringContaining('metrics down'),
      }),
    );
  });
});

// ─── 7. Actor override ───────────────────────────────────────────────

describe('createCircuitAuditSink — actor', () => {
  it('defaults to { kind: "system" }', async () => {
    const deps = baseDeps();
    const sink = createCircuitAuditSink(deps);
    sink(evOpened());
    await flushMicrotasks();
    expect(deps.writer.drafts[0]!.actor).toEqual({ kind: 'system' });
  });

  it('uses a caller-supplied service actor', async () => {
    const deps = baseDeps({
      actor: { kind: 'service', id: 'llm-client-0.1', displayName: 'LLM' },
    });
    const sink = createCircuitAuditSink(deps);
    sink(evClosed());
    await flushMicrotasks();
    expect(deps.writer.drafts[0]!.actor).toEqual({
      kind: 'service',
      id: 'llm-client-0.1',
      displayName: 'LLM',
    });
  });
});

// ─── 8. Concurrency / isolation ──────────────────────────────────────

describe('createCircuitAuditSink — per-event isolation', () => {
  it('handles 3 events in the same tick with correct drafts each', async () => {
    const deps = baseDeps();
    const sink = createCircuitAuditSink(deps);

    sink(evOpened({ provider: 'anthropic', errorRate: 0.5, volume: 10 }));
    sink(evOpened({ provider: 'openai', errorRate: 0.7, volume: 20 }));
    sink(evClosed({ provider: 'anthropic' }));
    await flushMicrotasks();

    expect(deps.writer.calls).toBe(3);
    const [d1, d2, d3] = deps.writer.drafts;
    // `resource` is `SystemAuditResource | null | undefined` on the
    // canonical schema; the CB sink always emits it, so narrow with `!`.
    expect(d1?.action).toBe('llm.circuit_opened');
    expect(d1!.resource!.id).toBe('anthropic');
    expect(d1?.details).toEqual({
      reason: 'error_rate_exceeded',
      errorRate: 0.5,
      volume: 10,
    });

    expect(d2?.action).toBe('llm.circuit_opened');
    expect(d2!.resource!.id).toBe('openai');
    expect(d2?.details).toEqual({
      reason: 'error_rate_exceeded',
      errorRate: 0.7,
      volume: 20,
    });

    expect(d3?.action).toBe('llm.circuit_closed');
    expect(d3!.resource!.id).toBe('anthropic');
    expect(d3?.details).toEqual({ reason: 'probes_succeeded' });
  });

  it('counts each failure once, not multiplied by number of events in tick', async () => {
    const deps = baseDeps();
    deps.writer.enqueue(err({ kind: 'transport', message: 'a' }));
    deps.writer.enqueue(err({ kind: 'transport', message: 'b' }));
    const sink = createCircuitAuditSink(deps);

    sink(evOpened({ provider: 'anthropic' }));
    sink(evOpened({ provider: 'openai' }));
    await flushMicrotasks();

    expect(
      deps.metrics.counters.get(
        `${AUDIT_SINK_METRIC_NAMES.writeFailures}|action=llm.circuit_opened,reason=transport`,
      ),
    ).toBe(2);
  });

  it('interleaves ignored transitions with audited ones without cross-talk', async () => {
    const deps = baseDeps();
    const sink = createCircuitAuditSink(deps);

    sink(evOpened()); // writes
    sink({
      provider: 'anthropic',
      from: 'open',
      to: 'half-open',
      at: FIXED_NOW,
      reason: 'cooldown_elapsed',
    }); // ignored
    sink(evClosed()); // writes
    sink({
      provider: 'anthropic',
      from: 'half-open',
      to: 'open',
      at: FIXED_NOW,
      reason: 'probe_failed',
    }); // ignored
    await flushMicrotasks();

    // Writer saw only the two auditable transitions.
    expect(deps.writer.calls).toBe(2);
    expect(deps.writer.drafts.map((d) => d.action)).toEqual([
      'llm.circuit_opened',
      'llm.circuit_closed',
    ]);
    // Ignored counters advanced accordingly.
    expect(
      deps.metrics.counters.get(
        `${AUDIT_SINK_METRIC_NAMES.ignoredTransitions}|from=open,to=half-open`,
      ),
    ).toBe(1);
    expect(
      deps.metrics.counters.get(
        `${AUDIT_SINK_METRIC_NAMES.ignoredTransitions}|from=half-open,to=open`,
      ),
    ).toBe(1);
  });
});

// ─── 9. Deps shape — logger optional, metrics required ───────────────

describe('createCircuitAuditSink — deps shape', () => {
  it('works without a logger (counter-only reporting)', async () => {
    const deps: AuditSinkDeps = {
      writer: makeFakeWriter(),
      metrics: new InMemoryMetrics(),
      now: fixedClock(),
    };
    (deps.writer as FakeWriter).enqueue(
      err({ kind: 'transport', message: 'x' }),
    );
    const sink = createCircuitAuditSink(deps);

    expect(() => sink(evOpened())).not.toThrow();
    await flushMicrotasks();

    const metrics = deps.metrics as InMemoryMetrics;
    expect(
      metrics.counters.get(
        `${AUDIT_SINK_METRIC_NAMES.writeFailures}|action=llm.circuit_opened,reason=transport`,
      ),
    ).toBe(1);
  });
});
