import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import { mockClient } from 'aws-sdk-client-mock';

import {
  KMS_MAX_ATTEMPTS,
  defaultJitterMs,
  defaultSleep,
  kekAlias,
  kmsDecrypt,
  kmsEncrypt,
  type KmsDeps,
} from '../../src/crypto/kek.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';

const kmsMock = mockClient(KMSClient);

function makeDeps(overrides: Partial<KmsDeps> = {}): {
  deps: KmsDeps;
  metrics: InMemoryMetrics;
  clock: { t: number };
  sleeps: number[];
  jitterValues: number[];
} {
  const metrics = new InMemoryMetrics();
  const clock = { t: 1_000 };
  const sleeps: number[] = [];
  const jitterValues: number[] = [];

  const deps: KmsDeps = {
    kms: new KMSClient({ region: 'us-east-1' }),
    metrics,
    now: () => clock.t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      clock.t += ms;
    },
    jitterMs: (min: number, max: number) => {
      const v = Math.floor((min + max) / 2); // deterministic midpoint
      jitterValues.push(v);
      return v;
    },
    ...overrides,
  };
  return { deps, metrics, clock, sleeps, jitterValues };
}

beforeEach(() => {
  kmsMock.reset();
});

afterEach(() => {
  kmsMock.reset();
});

describe('kekAlias', () => {
  it('builds the canonical AWS alias', () => {
    expect(kekAlias({ kekVersion: 1, shardId: 0 })).toBe(
      'alias/foco/kek/v1/shard-0',
    );
    expect(kekAlias({ kekVersion: 2, shardId: 7 })).toBe(
      'alias/foco/kek/v2/shard-7',
    );
  });

  it('rejects invalid inputs', () => {
    expect(() => kekAlias({ kekVersion: 0, shardId: 0 })).toThrow();
    expect(() => kekAlias({ kekVersion: 1.5, shardId: 0 })).toThrow();
    expect(() => kekAlias({ kekVersion: 1, shardId: -1 })).toThrow();
    expect(() => kekAlias({ kekVersion: 1, shardId: 1.5 })).toThrow();
  });
});

describe('kmsEncrypt', () => {
  it('returns the CiphertextBlob on success and emits latency', async () => {
    kmsMock.on(EncryptCommand).resolves({
      CiphertextBlob: new Uint8Array([1, 2, 3, 4]),
    });
    const { deps, metrics, clock } = makeDeps();
    // Advance clock during send so latency is non-zero.
    const realSend = deps.kms.send.bind(deps.kms);
    vi.spyOn(deps.kms, 'send').mockImplementation(
      async (...args: Parameters<typeof realSend>) => {
        clock.t += 12;
        return realSend(...args);
      },
    );

    const res = await kmsEncrypt(deps, {
      alias: 'alias/foco/kek/v1/shard-0',
      plaintext: new Uint8Array([9, 9, 9]),
    });

    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(Array.from(res.value)).toEqual([1, 2, 3, 4]);
    }
    const samples = metrics.readHistogram('llm_kms_latency_ms', {
      operation: 'encrypt',
    });
    expect(samples.length).toBe(1);
    expect(samples[0]!.value).toBe(12);
    expect(
      metrics.readCounter('llm_kms_retries_total', {
        operation: 'encrypt',
        outcome: 'success',
      }),
    ).toBe(0);
  });

  it('wraps an empty CiphertextBlob as non-transient kms_unavailable', async () => {
    kmsMock.on(EncryptCommand).resolves({});
    const { deps } = makeDeps();
    const res = await kmsEncrypt(deps, {
      alias: 'alias/foco/kek/v1/shard-0',
      plaintext: new Uint8Array([1]),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe('kms_unavailable');
      expect(res.error.transient).toBe(false);
    }
  });

  it('retries exactly once on a transient error, then succeeds', async () => {
    const err = Object.assign(new Error('throttled'), {
      name: 'ThrottlingException',
    });
    kmsMock
      .on(EncryptCommand)
      .rejectsOnce(err)
      .resolves({ CiphertextBlob: new Uint8Array([7]) });

    const { deps, metrics, sleeps, jitterValues } = makeDeps();
    const res = await kmsEncrypt(deps, {
      alias: 'alias/foco/kek/v1/shard-0',
      plaintext: new Uint8Array([1]),
    });

    expect(res.ok).toBe(true);
    expect(sleeps.length).toBe(1);
    expect(jitterValues[0]).toBeGreaterThanOrEqual(50);
    expect(jitterValues[0]).toBeLessThanOrEqual(250);

    expect(
      metrics.readCounter('llm_kms_induced_failures_total', {
        operation: 'encrypt',
        transient: 'true',
      }),
    ).toBe(1);
    expect(
      metrics.readCounter('llm_kms_retries_total', {
        operation: 'encrypt',
        outcome: 'success',
      }),
    ).toBe(1);
    expect(metrics.kmsRetrySuccessRatio()).toBe(1);
  });

  it('does NOT retry on a non-transient error (fail-closed immediately)', async () => {
    const err = Object.assign(new Error('bad key'), {
      name: 'InvalidCiphertextException',
    });
    kmsMock.on(DecryptCommand).rejects(err);

    const { deps, metrics, sleeps } = makeDeps();
    const res = await kmsDecrypt(deps, {
      alias: 'alias/foco/kek/v1/shard-0',
      ciphertext: new Uint8Array([9]),
    });

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.transient).toBe(false);
    expect(sleeps.length).toBe(0); // no retry attempted
    expect(
      metrics.readCounter('llm_kms_induced_failures_total', {
        operation: 'decrypt',
        transient: 'false',
      }),
    ).toBe(1);
    expect(
      metrics.readCounter('llm_kms_retries_total', {
        operation: 'decrypt',
        outcome: 'fail',
      }),
    ).toBe(0); // budget not touched
  });

  it('budget is hard-capped at 2 attempts (1 retry) even on repeated transient errors', async () => {
    const err = Object.assign(new Error('500'), {
      name: 'InternalException',
    });
    kmsMock.on(EncryptCommand).rejects(err);

    const { deps, metrics } = makeDeps();
    const res = await kmsEncrypt(deps, {
      alias: 'alias/foco/kek/v1/shard-0',
      plaintext: new Uint8Array([1]),
    });

    expect(res.ok).toBe(false);
    expect(kmsMock.commandCalls(EncryptCommand).length).toBe(KMS_MAX_ATTEMPTS);
    expect(
      metrics.readCounter('llm_kms_retries_total', {
        operation: 'encrypt',
        outcome: 'fail',
      }),
    ).toBe(1);
  });

  it('deadline-aware: skips retry when projected completion exceeds deadline', async () => {
    const err = Object.assign(new Error('throttled'), {
      name: 'ThrottlingException',
    });
    kmsMock.on(DecryptCommand).rejects(err);

    const { deps, metrics, clock } = makeDeps();
    // First attempt consumes 40ms before throwing.
    const realSend = deps.kms.send.bind(deps.kms);
    vi.spyOn(deps.kms, 'send').mockImplementation(
      async (...args: Parameters<typeof realSend>) => {
        clock.t += 40;
        return realSend(...args);
      },
    );

    // Deadline 60ms in the future from the start (t=1000).
    const res = await kmsDecrypt(
      deps,
      { alias: 'alias/foco/kek/v1/shard-0', ciphertext: new Uint8Array([1]) },
      { deadlineMs: 1060 },
    );

    expect(res.ok).toBe(false);
    // No sleep issued — deadline cut off the retry.
    expect(
      metrics.readCounter('llm_retries_skipped_deadline_total', {
        operation: 'decrypt',
      }),
    ).toBe(1);
    // Only the first attempt was issued. `as never` cast: see note in
    // envelope.test.ts — aws-sdk-client-mock@4.1 vs
    // @aws-sdk/client-kms@3.900 constructor signature drift.
    expect(kmsMock.commandCalls(DecryptCommand as never).length).toBe(1);
  });

  it('deadline-aware (encrypt): skips retry when projected completion exceeds deadline', async () => {
    // Symmetrical to the decrypt test above — closes the label matrix
    // for `llm_retries_skipped_deadline_total{operation}`. The retry
    // loop in `kek.ts::attempt<T>()` is shared by encrypt and decrypt,
    // so this test guards against a regression that would accidentally
    // gate the deadline check on one operation only.
    const err = Object.assign(new Error('throttled'), {
      name: 'ThrottlingException',
    });
    kmsMock.on(EncryptCommand).rejects(err);

    const { deps, metrics, clock } = makeDeps();
    const realSend = deps.kms.send.bind(deps.kms);
    vi.spyOn(deps.kms, 'send').mockImplementation(
      async (...args: Parameters<typeof realSend>) => {
        clock.t += 40;
        return realSend(...args);
      },
    );

    const res = await kmsEncrypt(
      deps,
      { alias: 'alias/foco/kek/v1/shard-0', plaintext: new Uint8Array([1]) },
      { deadlineMs: 1060 },
    );

    expect(res.ok).toBe(false);
    expect(
      metrics.readCounter('llm_retries_skipped_deadline_total', {
        operation: 'encrypt',
      }),
    ).toBe(1);
    // No retry issued — only the first attempt.
    expect(kmsMock.commandCalls(EncryptCommand).length).toBe(1);
  });

  it('deadline-aware: retry proceeds when projected completion is within deadline', async () => {
    // Happy-path complement to the skip tests. Documents §4.3: when
    // `deadlineMs` leaves ample headroom for jitter + projected retry
    // latency, the retry fires and `llm_retries_skipped_deadline_total`
    // stays 0. The second attempt succeeds, so the call returns `ok`.
    const err = Object.assign(new Error('throttled'), {
      name: 'ThrottlingException',
    });
    kmsMock
      .on(DecryptCommand)
      .rejectsOnce(err)
      .resolves({ Plaintext: new Uint8Array([42]) });

    const { deps, metrics, clock, sleeps } = makeDeps();
    const realSend = deps.kms.send.bind(deps.kms);
    vi.spyOn(deps.kms, 'send').mockImplementation(
      async (...args: Parameters<typeof realSend>) => {
        clock.t += 10;
        return realSend(...args);
      },
    );

    // Ample headroom: 10s past start (t=1000).
    const res = await kmsDecrypt(
      deps,
      { alias: 'alias/foco/kek/v1/shard-0', ciphertext: new Uint8Array([1]) },
      { deadlineMs: 11_000 },
    );

    expect(res.ok).toBe(true);
    expect(sleeps.length).toBe(1);
    expect(
      metrics.readCounter('llm_retries_skipped_deadline_total', {
        operation: 'decrypt',
      }),
    ).toBe(0);
  });

  it('deadline undefined: retry path unaffected (§8 decisión #5)', async () => {
    // When `deadlineMs` is omitted, the router imposes no deadline and
    // retries run free up to `KMS_MAX_ATTEMPTS`. This is the explicit
    // contract in `.cmsgs/iter6-otel-correlation-design.md` §8 decisión
    // #5 — asserting it here guards against a future well-meaning
    // default that would silently cap retry budgets.
    const err = Object.assign(new Error('throttled'), {
      name: 'ThrottlingException',
    });
    kmsMock
      .on(DecryptCommand)
      .rejectsOnce(err)
      .resolves({ Plaintext: new Uint8Array([7]) });

    const { deps, metrics, sleeps } = makeDeps();
    const res = await kmsDecrypt(deps, {
      alias: 'alias/foco/kek/v1/shard-0',
      ciphertext: new Uint8Array([1]),
    });

    expect(res.ok).toBe(true);
    // Retry did fire (sleep issued, second attempt succeeded).
    expect(sleeps.length).toBe(1);
    expect(
      metrics.readCounter('llm_retries_skipped_deadline_total', {
        operation: 'decrypt',
      }),
    ).toBe(0);
  });

  it('classifies an unrecognised SDK name using HTTP status', async () => {
    const err = Object.assign(new Error('unknown'), {
      name: 'SomethingElse',
      $metadata: { httpStatusCode: 503 },
    });
    kmsMock.on(EncryptCommand).rejects(err);

    const { deps } = makeDeps();
    const res = await kmsEncrypt(deps, {
      alias: 'alias/foco/kek/v1/shard-0',
      plaintext: new Uint8Array([1]),
    });
    // 503 → transient → retry → still 503 → fail
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.transient).toBe(true);
    expect(kmsMock.commandCalls(EncryptCommand).length).toBe(KMS_MAX_ATTEMPTS);
  });
});

describe('kmsDecrypt', () => {
  it('returns Plaintext on success', async () => {
    kmsMock.on(DecryptCommand).resolves({
      Plaintext: new Uint8Array([42]),
    });
    const { deps } = makeDeps();
    const res = await kmsDecrypt(deps, {
      alias: 'alias/foco/kek/v1/shard-0',
      ciphertext: new Uint8Array([1, 2, 3]),
    });
    expect(res.ok).toBe(true);
    if (res.ok) expect(Array.from(res.value)).toEqual([42]);
  });

  it('empty Plaintext is classified as non-transient', async () => {
    kmsMock.on(DecryptCommand).resolves({});
    const { deps } = makeDeps();
    const res = await kmsDecrypt(deps, {
      alias: 'alias/foco/kek/v1/shard-0',
      ciphertext: new Uint8Array([1]),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.transient).toBe(false);
  });
});

describe('default helpers', () => {
  it('defaultSleep resolves after the given ms', async () => {
    vi.useFakeTimers();
    const p = defaultSleep(30);
    vi.advanceTimersByTime(30);
    await p;
    vi.useRealTimers();
  });

  it('defaultJitterMs returns integer in [min, max)', () => {
    for (let i = 0; i < 100; i++) {
      const v = defaultJitterMs(50, 250);
      expect(v).toBeGreaterThanOrEqual(50);
      expect(v).toBeLessThan(250);
      expect(Number.isInteger(v)).toBe(true);
    }
  });

  it('defaultJitterMs returns min when min === max', () => {
    expect(defaultJitterMs(100, 100)).toBe(100);
  });

  it('rejects inverted jitter bounds at call time', async () => {
    const { deps } = makeDeps();
    kmsMock.on(EncryptCommand).resolves({ CiphertextBlob: new Uint8Array([1]) });
    await expect(
      kmsEncrypt(
        deps,
        { alias: 'alias/foco/kek/v1/shard-0', plaintext: new Uint8Array([1]) },
        { jitterMinMs: 200, jitterMaxMs: 100 },
      ),
    ).rejects.toThrow(/must be </);
  });
});
