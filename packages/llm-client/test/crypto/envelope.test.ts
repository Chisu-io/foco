import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DecryptCommand,
  EncryptCommand,
  KMSClient,
} from '@aws-sdk/client-kms';
import { mockClient } from 'aws-sdk-client-mock';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';

import {
  EnvelopeCrypto,
  MAX_DEK_CACHE_TTL_MS,
  type Envelope,
  type EnvelopeDeps,
} from '../../src/crypto/envelope.js';
import { generateDek, zeroize } from '../../src/crypto/dek.js';
import { kekAlias } from '../../src/crypto/kek.js';
import { shardId } from '../../src/crypto/sharding.js';
import { InMemoryMetrics } from '../../src/observability/metrics.js';
import { resetTracer, setTracer } from '../../src/observability/tracing.js';

const kmsMock = mockClient(KMSClient);

/**
 * Helper — builds an EnvelopeCrypto with a fully fake clock and a
 * mutable kekVersion so rotation scenarios are controllable.
 */
function makeEnvCrypto(overrides: {
  readonly cacheTtlMs?: number;
  readonly initialKekVersion?: number;
} = {}): {
  env: EnvelopeCrypto;
  metrics: InMemoryMetrics;
  clock: { t: number };
  versionBox: { v: number };
} {
  const metrics = new InMemoryMetrics();
  const clock = { t: 10_000 };
  const versionBox = { v: overrides.initialKekVersion ?? 1 };

  const deps: EnvelopeDeps = {
    kms: new KMSClient({ region: 'us-east-1' }),
    metrics,
    now: () => clock.t,
    currentKekVersion: () => versionBox.v,
    cacheTtlMs: overrides.cacheTtlMs ?? 60_000,
    sleep: async (ms) => {
      clock.t += ms;
    },
    jitterMs: (min, max) => Math.floor((min + max) / 2),
  };

  return { env: new EnvelopeCrypto(deps), metrics, clock, versionBox };
}

beforeEach(() => {
  kmsMock.reset();
});
afterEach(() => {
  kmsMock.reset();
});

describe('EnvelopeCrypto.ctor', () => {
  it('rejects TTL above the §16 hard-cap', () => {
    expect(
      () =>
        new EnvelopeCrypto({
          kms: new KMSClient({ region: 'us-east-1' }),
          metrics: new InMemoryMetrics(),
          now: () => 0,
          currentKekVersion: () => 1,
          cacheTtlMs: MAX_DEK_CACHE_TTL_MS + 1,
        }),
    ).toThrow(/hard-cap/);
  });

  it('rejects negative / NaN TTL', () => {
    const base = {
      kms: new KMSClient({ region: 'us-east-1' }),
      metrics: new InMemoryMetrics(),
      now: () => 0,
      currentKekVersion: () => 1,
    };
    expect(() => new EnvelopeCrypto({ ...base, cacheTtlMs: -1 })).toThrow();
    expect(
      () => new EnvelopeCrypto({ ...base, cacheTtlMs: Number.NaN }),
    ).toThrow();
  });
});

describe('EnvelopeCrypto.wrap', () => {
  it('produces an envelope with all fields and a KMS-encrypted DEK', async () => {
    kmsMock.on(EncryptCommand).resolves({
      CiphertextBlob: new Uint8Array([0xaa, 0xbb]),
    });

    const { env } = makeEnvCrypto();
    const res = await env.wrap({
      userId: 'user-1',
      keyPlaintext: Buffer.from('sk-ant-xxxx-yyyy', 'utf8'),
    });

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const e = res.value;
    expect(e.kekVersion).toBe(1);
    expect(e.shardId).toBe(shardId('user-1', 1));
    expect(Array.from(e.dekCiphertext)).toEqual([0xaa, 0xbb]);
    expect(e.keyNonce.length).toBe(12);
    expect(e.keyAuthTag.length).toBe(16);
    expect(e.keyCiphertext.length).toBeGreaterThan(0);

    // Verify KMS was called with the correct alias.
    const call = kmsMock.commandCalls(EncryptCommand)[0]!;
    expect(call.args[0].input.KeyId).toBe(
      kekAlias({ kekVersion: 1, shardId: e.shardId }),
    );
  });

  it('does NOT populate the cache on wrap (cross-process safety)', async () => {
    kmsMock.on(EncryptCommand).resolves({
      CiphertextBlob: new Uint8Array([1]),
    });
    const { env } = makeEnvCrypto();
    await env.wrap({
      userId: 'user-1',
      keyPlaintext: Buffer.from('sk-ant'),
    });
    expect(env.size).toBe(0);
  });

  it('propagates non-transient KMS failure up as the error variant', async () => {
    const e = Object.assign(new Error('denied'), {
      name: 'AccessDeniedException',
    });
    kmsMock.on(EncryptCommand).rejects(e);

    const { env } = makeEnvCrypto();
    const res = await env.wrap({
      userId: 'user-1',
      keyPlaintext: Buffer.from('k'),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.kind).toBe('kms_unavailable');
      if (res.error.kind === 'kms_unavailable') {
        expect(res.error.transient).toBe(false);
      }
    }
  });

  it('rejects empty userId', async () => {
    const { env } = makeEnvCrypto();
    const res = await env.wrap({
      userId: '',
      keyPlaintext: Buffer.from('k'),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('internal');
  });
});

/**
 * Helper to build a valid envelope + DEK pair using a fixed DEK so
 * both wrap and unwrap can operate against a mocked KMS.
 */
async function buildEnvelope(opts: {
  userId: string;
  keyPlaintext: Buffer;
  kekVersion: number;
  dek?: Buffer;
}): Promise<{ envelope: Envelope; dek: Buffer }> {
  const dek = opts.dek ?? generateDek();
  const { encryptWithDek } = await import('../../src/crypto/dek.js');
  const body = encryptWithDek(opts.keyPlaintext, dek);
  const envelope: Envelope = {
    kekVersion: opts.kekVersion,
    shardId: shardId(opts.userId, opts.kekVersion),
    // `dekCiphertext` is an opaque marker here; the KMS mock returns
    // the real DEK back regardless of what goes in.
    dekCiphertext: new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
    keyCiphertext: new Uint8Array(body.ciphertext),
    keyNonce: new Uint8Array(body.nonce),
    keyAuthTag: new Uint8Array(body.authTag),
  };
  return { envelope, dek };
}

describe('EnvelopeCrypto.unwrap', () => {
  it('returns the user plaintext on cache miss + KMS success', async () => {
    const userId = 'user-1';
    const key = Buffer.from('sk-ant-user-key', 'utf8');
    const { envelope, dek } = await buildEnvelope({
      userId,
      keyPlaintext: key,
      kekVersion: 1,
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(dek) });

    const { env, metrics } = makeEnvCrypto();
    const res = await env.unwrap({ userId, envelope, provider: 'anthropic' });

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.value.equals(key)).toBe(true);
    expect(metrics.readCounter('llm_dek_cache_misses_total')).toBe(1);
    expect(metrics.readCounter('llm_dek_cache_hits_total')).toBe(0);
    expect(env.size).toBe(1);
  });

  it('serves subsequent calls from cache (no second KMS hit)', async () => {
    const userId = 'user-1';
    const key = Buffer.from('sk-ant-user-key', 'utf8');
    const { envelope, dek } = await buildEnvelope({
      userId,
      keyPlaintext: key,
      kekVersion: 1,
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(dek) });

    const { env, metrics } = makeEnvCrypto();
    await env.unwrap({ userId, envelope, provider: 'anthropic' });
    await env.unwrap({ userId, envelope, provider: 'anthropic' });
    await env.unwrap({ userId, envelope, provider: 'anthropic' });

    // `as never` cast: aws-sdk-client-mock@4.1 types `commandCalls`
    // for an older SDK constructor signature (`new(input: TInput |
    // undefined)`) — @aws-sdk/client-kms@3.900 tightened the input to
    // non-undefined. The runtime contract is unchanged; this is a
    // type-level narrowing only.
    expect(kmsMock.commandCalls(DecryptCommand as never).length).toBe(1);
    expect(metrics.readCounter('llm_dek_cache_misses_total')).toBe(1);
    expect(metrics.readCounter('llm_dek_cache_hits_total')).toBe(2);
  });

  it('evicts + zeroises on TTL expiry and re-fetches DEK', async () => {
    const userId = 'user-1';
    const key = Buffer.from('sk-ant-user-key', 'utf8');
    const { envelope, dek } = await buildEnvelope({
      userId,
      keyPlaintext: key,
      kekVersion: 1,
    });
    // Use callsFake to return a FRESH Uint8Array per call — matches
    // real KMS behaviour. `.resolves(value)` shares the same reference
    // across calls, which would be zeroised by envelope.ts after the
    // first Decrypt (hygiene per §2 invariant 1: no key plaintext
    // outside our owned Buffer) and break the second call.
    kmsMock
      .on(DecryptCommand)
      .callsFake(() => ({ Plaintext: new Uint8Array(dek) }));

    const { env, metrics, clock } = makeEnvCrypto({ cacheTtlMs: 1_000 });
    await env.unwrap({ userId, envelope, provider: 'anthropic' });
    // Advance past TTL.
    clock.t += 2_000;
    const res = await env.unwrap({ userId, envelope, provider: 'anthropic' });
    expect(res.ok).toBe(true);

    expect(kmsMock.commandCalls(DecryptCommand as never).length).toBe(2);
    expect(
      metrics.readCounter('llm_dek_cache_evictions_total', { reason: 'ttl' }),
    ).toBe(1);
    expect(metrics.readCounter('llm_dek_cache_misses_total')).toBe(2);
  });

  it('sweepExpired evicts and zeroises in bulk', async () => {
    const userId = 'user-1';
    const { envelope, dek } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('k'),
      kekVersion: 1,
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(dek) });

    const { env, metrics, clock } = makeEnvCrypto({ cacheTtlMs: 500 });
    await env.unwrap({ userId, envelope, provider: 'anthropic' });
    clock.t += 1_000;
    const removed = env.sweepExpired();
    expect(removed).toBe(1);
    expect(env.size).toBe(0);
    expect(
      metrics.readCounter('llm_dek_cache_evictions_total', { reason: 'ttl' }),
    ).toBe(1);
  });

  it('counts a stale_hit when a different kekVersion is cached for same userId', async () => {
    const userId = 'user-1';
    const { envelope: v1env, dek: v1dek } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('key'),
      kekVersion: 1,
    });
    const { envelope: v2env, dek: v2dek } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('key'),
      kekVersion: 1, // fabricate envelope shape but stamp v2 below
    });

    // Force the new envelope to claim kekVersion=2 (shardId may or
    // may not match — that's fine for this test, we only care about
    // the cache-level stale detection).
    const v2 = { ...v2env, kekVersion: 2 } as Envelope;

    kmsMock.on(DecryptCommand).callsFake((input) => {
      const keyId = (input as { KeyId?: string }).KeyId ?? '';
      if (keyId.includes('/v1/')) return { Plaintext: new Uint8Array(v1dek) };
      if (keyId.includes('/v2/')) return { Plaintext: new Uint8Array(v2dek) };
      throw new Error(`unexpected alias ${keyId}`);
    });

    const { env, metrics } = makeEnvCrypto();
    // Prime v1.
    const r1 = await env.unwrap({ userId, envelope: v1env, provider: 'anthropic' });
    expect(r1.ok).toBe(true);
    // Now unwrap v2 — triggers stale detection for the v1 entry.
    const r2 = await env.unwrap({ userId, envelope: v2, provider: 'anthropic' });
    expect(r2.ok).toBe(true);

    expect(
      metrics.readCounter('llm_dek_cache_stale_hits_total', {
        reason: 'version_mismatch',
      }),
    ).toBe(1);
    expect(
      metrics.readCounter('llm_dek_cache_evictions_total', { reason: 'stale' }),
    ).toBe(1);
  });

  it('invalidateUserKey purges every version for that user', async () => {
    const userId = 'user-1';
    const { envelope: v1env, dek: v1dek } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('key'),
      kekVersion: 1,
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(v1dek) });

    const { env, metrics } = makeEnvCrypto();
    await env.unwrap({ userId, envelope: v1env, provider: 'anthropic' });
    expect(env.size).toBe(1);

    const removed = env.invalidateUserKey(userId);
    expect(removed).toBe(1);
    expect(env.size).toBe(0);
    expect(
      metrics.readCounter('llm_dek_cache_evictions_total', { reason: 'manual' }),
    ).toBe(1);
  });

  it('invalidateUserKey does not touch other users', async () => {
    const { envelope: eA, dek: dA } = await buildEnvelope({
      userId: 'alice',
      keyPlaintext: Buffer.from('ka'),
      kekVersion: 1,
    });
    const { envelope: eB, dek: dB } = await buildEnvelope({
      userId: 'bob',
      keyPlaintext: Buffer.from('kb'),
      kekVersion: 1,
    });

    kmsMock.on(DecryptCommand).callsFake((input) => {
      const keyId = (input as { KeyId?: string }).KeyId ?? '';
      const sA = kekAlias({ kekVersion: 1, shardId: shardId('alice', 1) });
      if (keyId === sA) return { Plaintext: new Uint8Array(dA) };
      return { Plaintext: new Uint8Array(dB) };
    });

    const { env } = makeEnvCrypto();
    await env.unwrap({ userId: 'alice', envelope: eA, provider: 'anthropic' });
    await env.unwrap({ userId: 'bob', envelope: eB, provider: 'anthropic' });
    expect(env.size).toBe(2);

    const removed = env.invalidateUserKey('alice');
    expect(removed).toBe(1);
    expect(env.size).toBe(1);
  });

  it('maps a tampered body to internal', async () => {
    const userId = 'user-1';
    const { envelope, dek } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('key'),
      kekVersion: 1,
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(dek) });

    const tampered: Envelope = {
      ...envelope,
      keyCiphertext: new Uint8Array(
        Array.from(envelope.keyCiphertext, (b) => b ^ 0x01),
      ),
    };

    const { env } = makeEnvCrypto();
    const res = await env.unwrap({ userId, envelope: tampered, provider: 'anthropic' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('internal');
  });

  it('propagates KMS non-transient failure without touching cache', async () => {
    const userId = 'user-1';
    const { envelope } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('k'),
      kekVersion: 1,
    });
    kmsMock.on(DecryptCommand).rejects(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    );

    const { env } = makeEnvCrypto();
    const res = await env.unwrap({ userId, envelope, provider: 'anthropic' });
    expect(res.ok).toBe(false);
    expect(env.size).toBe(0);
  });

  it('rejects empty userId', async () => {
    const { env } = makeEnvCrypto();
    const { envelope } = await buildEnvelope({
      userId: 'x',
      keyPlaintext: Buffer.from('k'),
      kekVersion: 1,
    });
    const res = await env.unwrap({ userId: '', envelope, provider: 'anthropic' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('internal');
  });

  it('wrap → unwrap roundtrip through EnvelopeCrypto', async () => {
    // Track the (DEK, encrypted) pair so the mock can return the
    // right plaintext on decrypt.
    let capturedDek: Uint8Array | null = null;
    kmsMock.on(EncryptCommand).callsFake((input) => {
      const pt = (input as { Plaintext?: Uint8Array }).Plaintext!;
      capturedDek = new Uint8Array(pt); // copy before zeroise
      return { CiphertextBlob: new Uint8Array([1, 2, 3, 4]) };
    });
    kmsMock.on(DecryptCommand).callsFake(() => {
      if (!capturedDek) throw new Error('encrypt first');
      return { Plaintext: new Uint8Array(capturedDek) };
    });

    const { env } = makeEnvCrypto();
    const plaintext = Buffer.from('sk-ant-full-roundtrip', 'utf8');
    const wrapped = await env.wrap({ userId: 'user-1', keyPlaintext: plaintext });
    expect(wrapped.ok).toBe(true);
    if (!wrapped.ok) return;

    const unwrapped = await env.unwrap({
      userId: 'user-1',
      envelope: wrapped.value,
      provider: 'anthropic',
    });
    expect(unwrapped.ok).toBe(true);
    if (unwrapped.ok) {
      expect(unwrapped.value.equals(plaintext)).toBe(true);
      zeroize(unwrapped.value);
    }
  });
});

/**
 * §10.1 — sub-span `llm.kms.decrypt_dek`.
 *
 * Emitted ONLY on cache-miss (§8 decisión #2 firmada del mini-spec
 * `iter6-otel-correlation-design.md`). Cache-hit NO emite el span.
 *
 * Hermetic scaffold: `BasicTracerProvider` + `SimpleSpanProcessor` +
 * `InMemorySpanExporter` montado vía el DI seam `setTracer/resetTracer`
 * (mismo patrón que commit 3 para `plan-router.ts`). Sin
 * `AsyncHooksContextManager` → aserts son sobre presencia del span,
 * atributos y count; NO sobre `parentSpanId`.
 */
describe('EnvelopeCrypto.unwrap — OTel `llm.kms.decrypt_dek` span (iter 6 commit 4, §10.1)', () => {
  let exporter: InMemorySpanExporter;
  let tracerProvider: BasicTracerProvider;

  beforeEach(() => {
    exporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    setTracer(tracerProvider.getTracer('envelope-test'));
  });

  afterEach(async () => {
    resetTracer();
    exporter.reset();
    await tracerProvider.shutdown();
  });

  it('cache-miss emite span con los 3 attrs + SpanKind.CLIENT + OK', async () => {
    const userId = 'u-obs-1';
    const { envelope, dek } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('sk-anth'),
      kekVersion: 1,
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(dek) });

    const { env } = makeEnvCrypto();
    const res = await env.unwrap({ userId, envelope, provider: 'anthropic' });
    expect(res.ok).toBe(true);

    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'llm.kms.decrypt_dek');
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes).toEqual({
      'llm.provider': 'anthropic',
      'kek.version': 1,
      'kek.shard_id': envelope.shardId,
    });
    expect(span.status.code).toBe(SpanStatusCode.OK);
    expect(span.events).toHaveLength(0);
  });

  it('cache-hit NO emite span (§8 decisión #2 firmada)', async () => {
    const userId = 'u-obs-2';
    const { envelope, dek } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('sk-anth'),
      kekVersion: 1,
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(dek) });

    const { env } = makeEnvCrypto();
    // Primer unwrap → cache-miss → debe emitir.
    await env.unwrap({ userId, envelope, provider: 'anthropic' });
    // Reset exporter antes del segundo → aislar el assert al cache-hit.
    exporter.reset();
    // Segundo unwrap misma `(userId, kekVersion)` → cache-hit → NO emite.
    const res = await env.unwrap({ userId, envelope, provider: 'anthropic' });
    expect(res.ok).toBe(true);

    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'llm.kms.decrypt_dek');
    expect(spans).toHaveLength(0);
  });

  it('KMS error → ERROR con message=kind, sin recordException (R3)', async () => {
    const userId = 'u-obs-3';
    const { envelope } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('sk-anth'),
      kekVersion: 1,
    });
    kmsMock.on(DecryptCommand).rejects(
      Object.assign(new Error('denied'), { name: 'AccessDeniedException' }),
    );

    const { env } = makeEnvCrypto();
    const res = await env.unwrap({ userId, envelope, provider: 'openai' });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.kind).toBe('kms_unavailable');

    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'llm.kms.decrypt_dek');
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    // R1: el `message` del status debe ser exactamente el `kind` del
    // error, no una cadena libre derivada.
    expect(span.status.message).toBe('kms_unavailable');
    // R3: `LLMCallError` es tagged union → NO llamar `recordException`.
    // `recordException` añadiría un event `exception`; asertamos que no
    // se emitió ningún event.
    expect(span.events).toHaveLength(0);
    // Coherencia: el provider pasado a `unwrap` se estampó aunque la
    // llamada fallara.
    expect(span.attributes['llm.provider']).toBe('openai');
  });

  it('attrs del span nunca filtran userId crudo, alias, ciphertext ni api key', async () => {
    const rawUserId = 'u-raw-should-not-appear';
    const rawKey = 'sk-ant-should-never-leak-abc123';
    const { envelope, dek } = await buildEnvelope({
      userId: rawUserId,
      keyPlaintext: Buffer.from(rawKey),
      kekVersion: 1,
    });
    kmsMock.on(DecryptCommand).resolves({ Plaintext: new Uint8Array(dek) });

    const { env } = makeEnvCrypto();
    await env.unwrap({ userId: rawUserId, envelope, provider: 'gemini' });

    const spans = exporter
      .getFinishedSpans()
      .filter((s) => s.name === 'llm.kms.decrypt_dek');
    expect(spans).toHaveLength(1);
    const span = spans[0]!;

    // Claves EXACTAS de §10.1 — ni una más, ni una menos.
    expect(Object.keys(span.attributes).sort()).toEqual([
      'kek.shard_id',
      'kek.version',
      'llm.provider',
    ]);

    // El alias y el ciphertext jamás pueden filtrarse.
    const alias = kekAlias({
      kekVersion: envelope.kekVersion,
      shardId: envelope.shardId,
    });
    const haystack = Object.values(span.attributes)
      .map((v) => (typeof v === 'string' ? v : String(v)))
      .join('|');
    expect(haystack).not.toContain(rawUserId);
    expect(haystack).not.toContain(rawKey);
    expect(haystack).not.toContain(alias);
    // `dekCiphertext` es Uint8Array — representación string no debe
    // aparecer en atributos.
    expect(haystack).not.toContain(Array.from(envelope.dekCiphertext).join(','));
    // No hay campo `llm.api_key` ni `llm.key_ciphertext` (§10.1
    // prohibited set).
    expect(span.attributes['llm.api_key']).toBeUndefined();
    expect(span.attributes['llm.key_ciphertext']).toBeUndefined();
    // No hay campo `alias` o `ciphertext` crudo.
    expect(span.attributes['alias']).toBeUndefined();
    expect(span.attributes['ciphertext']).toBeUndefined();
    expect(span.attributes['user.id']).toBeUndefined();
    // Sanity: el provider pasado sí está estampado.
    expect(span.attributes['llm.provider']).toBe('gemini');
  });
});

/**
 * §4.3 — deadline propagation end-to-end (iter 6 commit 5).
 *
 * `kek.ts::attempt<T>()` already enforces the deadline skip-retry
 * logic; `envelope.ts` already plumbs `input.deadlineMs` into
 * `kmsOpts.deadlineMs` for both wrap and unwrap. These tests close
 * the contract end-to-end by exercising the observable boundary —
 * the `llm_retries_skipped_deadline_total` counter — through the
 * envelope layer. If propagation ever regresses (e.g. someone drops
 * the `deadlineMs` field from the `kmsOpts` literal) the skip-deadline
 * path stops firing and these tests fail.
 *
 * Per `.cmsgs/iter6-otel-correlation-design.md` §8 decisión #5, when
 * `deadlineMs` is undefined the router imposes no deadline and retries
 * run free; the last test here asserts that contract at the envelope
 * surface as well.
 *
 * Determinismo del harness: `makeEnvCrypto` fija `jitterMs = 150`
 * (midpoint de 50-250) y `clock.t` no avanza durante `kms.send` (el
 * mock resuelve sync). Entonces `observedLatencyMs = 0` y la
 * proyección del retry colapsa a `clock.t + 150`. Cualquier
 * `deadlineMs < clock.t + 150` dispara el skip path deterministicamente.
 */
describe('EnvelopeCrypto — deadline propagation (iter 6 commit 5, §4.3)', () => {
  const CLOCK_START = 10_000;
  const JITTER_MID = 150;
  const DEADLINE_TIGHT = CLOCK_START + JITTER_MID - 1; // 10_149 — skip fires
  const DEADLINE_AMPLE = CLOCK_START + JITTER_MID + 100; // 10_250 — retry proceeds

  it('WrapInput.deadlineMs reaches kmsOpts → skip-retry fires on encrypt path', async () => {
    const err = Object.assign(new Error('throttled'), {
      name: 'ThrottlingException',
    });
    kmsMock.on(EncryptCommand).rejects(err);

    const { env, metrics } = makeEnvCrypto();
    const res = await env.wrap({
      userId: 'u-dl-wrap',
      keyPlaintext: Buffer.from('sk-ant-key'),
      deadlineMs: DEADLINE_TIGHT,
    });
    expect(res.ok).toBe(false);

    expect(
      metrics.readCounter('llm_retries_skipped_deadline_total', {
        operation: 'encrypt',
      }),
    ).toBe(1);
    // Only the initial attempt was issued — the retry was cut off.
    expect(kmsMock.commandCalls(EncryptCommand).length).toBe(1);
  });

  it('UnwrapInput.deadlineMs reaches kmsOpts → skip-retry fires on decrypt path', async () => {
    const userId = 'u-dl-unwrap';
    const { envelope } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('sk-ant-key'),
      kekVersion: 1,
    });
    const err = Object.assign(new Error('throttled'), {
      name: 'ThrottlingException',
    });
    kmsMock.on(DecryptCommand).rejects(err);

    const { env, metrics } = makeEnvCrypto();
    const res = await env.unwrap({
      userId,
      envelope,
      provider: 'anthropic',
      deadlineMs: DEADLINE_TIGHT,
    });
    expect(res.ok).toBe(false);

    expect(
      metrics.readCounter('llm_retries_skipped_deadline_total', {
        operation: 'decrypt',
      }),
    ).toBe(1);
    expect(kmsMock.commandCalls(DecryptCommand as never).length).toBe(1);
  });

  it('UnwrapInput.deadlineMs with ample headroom: retry proceeds and call succeeds', async () => {
    const userId = 'u-dl-ample';
    const { envelope, dek } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('sk-ant-key'),
      kekVersion: 1,
    });
    const transientErr = Object.assign(new Error('throttled'), {
      name: 'ThrottlingException',
    });
    kmsMock
      .on(DecryptCommand)
      .rejectsOnce(transientErr)
      .resolves({ Plaintext: new Uint8Array(dek) });

    const { env, metrics } = makeEnvCrypto();
    const res = await env.unwrap({
      userId,
      envelope,
      provider: 'anthropic',
      deadlineMs: DEADLINE_AMPLE,
    });
    expect(res.ok).toBe(true);

    // Deadline was honored but not violated → no skip metric.
    expect(
      metrics.readCounter('llm_retries_skipped_deadline_total', {
        operation: 'decrypt',
      }),
    ).toBe(0);
    // Two attempts issued: initial (transient fail) + retry (success).
    expect(kmsMock.commandCalls(DecryptCommand as never).length).toBe(2);
  });

  it('deadlineMs undefined end-to-end: retry fires (§8 decisión #5)', async () => {
    const userId = 'u-dl-none';
    const { envelope, dek } = await buildEnvelope({
      userId,
      keyPlaintext: Buffer.from('sk-ant-key'),
      kekVersion: 1,
    });
    const transientErr = Object.assign(new Error('throttled'), {
      name: 'ThrottlingException',
    });
    kmsMock
      .on(DecryptCommand)
      .rejectsOnce(transientErr)
      .resolves({ Plaintext: new Uint8Array(dek) });

    const { env, metrics } = makeEnvCrypto();
    // No `deadlineMs` on `UnwrapInput` → §8 decisión #5: the router
    // imposes no deadline and retries run free up to KMS_MAX_ATTEMPTS.
    const res = await env.unwrap({ userId, envelope, provider: 'anthropic' });
    expect(res.ok).toBe(true);
    expect(
      metrics.readCounter('llm_retries_skipped_deadline_total', {
        operation: 'decrypt',
      }),
    ).toBe(0);
    expect(kmsMock.commandCalls(DecryptCommand as never).length).toBe(2);
  });
});

