import { describe, expect, it } from 'vitest';

import {
  classifyKmsError,
  classifyNetworkError,
  classifyProviderHttpError,
  type ProviderName,
} from '../../src/errors/index.js';

const PROVIDERS = ['anthropic', 'openai', 'gemini'] as const satisfies readonly ProviderName[];

describe('classifyProviderHttpError — §7.1', () => {
  describe.each(PROVIDERS)('provider=%s', (provider: ProviderName) => {
    it('HTTP 401 → invalid_key', () => {
      const e = classifyProviderHttpError({ provider, status: 401 });
      expect(e).toMatchObject({ kind: 'invalid_key', provider });
    });

    it('HTTP 403 → invalid_key', () => {
      const e = classifyProviderHttpError({ provider, status: 403 });
      expect(e).toMatchObject({ kind: 'invalid_key', provider });
    });

    it('HTTP 402 → quota_exhausted', () => {
      const e = classifyProviderHttpError({ provider, status: 402 });
      expect(e).toMatchObject({ kind: 'quota_exhausted', provider });
    });

    it('HTTP 429 without retry-after → rate_limit without retryAfterSec', () => {
      const e = classifyProviderHttpError({ provider, status: 429 });
      expect(e).toEqual({ kind: 'rate_limit', provider });
      expect('retryAfterSec' in e).toBe(false);
    });

    it('HTTP 429 with retry-after → rate_limit with seconds', () => {
      const e = classifyProviderHttpError({
        provider,
        status: 429,
        retryAfterSec: 13,
      });
      expect(e).toEqual({
        kind: 'rate_limit',
        provider,
        retryAfterSec: 13,
      });
    });

    it.each([500, 502, 503, 504])(
      'HTTP %i → provider_down (circuitOpen defaults to false)',
      (status: number) => {
        const e = classifyProviderHttpError({ provider, status });
        expect(e).toEqual({
          kind: 'provider_down',
          provider,
          circuitOpen: false,
        });
      },
    );

    it('HTTP 500 honours circuitOpen=true when caller sets it', () => {
      const e = classifyProviderHttpError({
        provider,
        status: 500,
        circuitOpen: true,
      });
      expect(e).toMatchObject({
        kind: 'provider_down',
        circuitOpen: true,
      });
    });

    it('HTTP 400 with context_length_exceeded hint → context_too_long', () => {
      const e = classifyProviderHttpError({
        provider,
        status: 400,
        http400Hint: 'context_length_exceeded',
        contextSizing: { maxTokens: 200_000, actual: 250_000 },
      });
      expect(e).toEqual({
        kind: 'context_too_long',
        maxTokens: 200_000,
        actual: 250_000,
      });
    });

    it('HTTP 400 with content_filter hint defaults reason=moderation', () => {
      const e = classifyProviderHttpError({
        provider,
        status: 400,
        http400Hint: 'content_filter',
      });
      expect(e).toEqual({ kind: 'content_blocked', reason: 'moderation' });
    });

    it('HTTP 400 with content_filter + explicit safety reason', () => {
      const e = classifyProviderHttpError({
        provider,
        status: 400,
        http400Hint: 'content_filter',
        contentBlockReason: 'safety',
      });
      expect(e).toEqual({ kind: 'content_blocked', reason: 'safety' });
    });

    it('HTTP 400 with unknown body → internal (fail-safe)', () => {
      const e = classifyProviderHttpError({
        provider,
        status: 400,
        body: { some: 'other_error' },
      });
      expect(e.kind).toBe('internal');
    });

    it('body keyword sniff: context length detected', () => {
      const e = classifyProviderHttpError({
        provider,
        status: 400,
        body: { error: { message: 'This model has a context_length_exceeded problem.' } },
      });
      expect(e.kind).toBe('context_too_long');
    });

    it('body keyword sniff: content policy detected', () => {
      const e = classifyProviderHttpError({
        provider,
        status: 400,
        body: { error: { message: 'Request violates our content policy.' } },
      });
      expect(e.kind).toBe('content_blocked');
    });

    it('billingError hint on HTTP 429 → quota_exhausted (overrides rate_limit)', () => {
      // Reproduces the OpenAI `insufficient_quota` + HTTP 429 pattern.
      const e = classifyProviderHttpError({
        provider,
        status: 429,
        billingError: true,
      });
      expect(e).toMatchObject({ kind: 'quota_exhausted', provider });
    });

    it('explicit hint wins over body keyword sniff', () => {
      const e = classifyProviderHttpError({
        provider,
        status: 400,
        http400Hint: 'content_filter',
        body: { error: { message: 'context_length_exceeded keyword' } },
      });
      expect(e.kind).toBe('content_blocked');
    });

    it.each([418, 451, 522])(
      'HTTP %i (unmapped) → internal',
      (status: number) => {
        const e = classifyProviderHttpError({ provider, status });
        expect(e.kind).toBe('internal');
      },
    );
  });

  it('internal errors carry a non-empty correlation id', () => {
    const e = classifyProviderHttpError({ provider: 'anthropic', status: 418 });
    expect(e).toMatchObject({ kind: 'internal' });
    if (e.kind === 'internal') {
      expect(e.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
    }
  });
});

describe('classifyKmsError — §7.1 + §2 invariant 5', () => {
  it.each([
    'InvalidCiphertextException',
    'KMSInvalidStateException',
    'DisabledException',
    'NotFoundException',
    'AccessDeniedException',
  ])('%s → non-transient (fail-closed, no retry)', (name: string) => {
    expect(classifyKmsError({ errorName: name })).toEqual({
      kind: 'kms_unavailable',
      transient: false,
    });
  });

  it.each([
    'ThrottlingException',
    'KMSInternalException',
    'DependencyTimeoutException',
    'ServiceUnavailableException',
    'KeyUnavailableException',
  ])('%s → transient (retry once with jitter)', (name: string) => {
    expect(classifyKmsError({ errorName: name })).toEqual({
      kind: 'kms_unavailable',
      transient: true,
    });
  });

  it('HTTP 5xx without errorName → transient', () => {
    expect(classifyKmsError({ statusCode: 503 })).toEqual({
      kind: 'kms_unavailable',
      transient: true,
    });
  });

  it('HTTP 429 without errorName → transient', () => {
    expect(classifyKmsError({ statusCode: 429 })).toEqual({
      kind: 'kms_unavailable',
      transient: true,
    });
  });

  it('Unknown shape → non-transient (fail-closed default)', () => {
    expect(classifyKmsError({})).toEqual({
      kind: 'kms_unavailable',
      transient: false,
    });
  });

  it('errorName takes precedence over statusCode', () => {
    // A 503 wrapping an InvalidCiphertext should still fail-closed.
    const e = classifyKmsError({
      errorName: 'InvalidCiphertextException',
      statusCode: 503,
    });
    expect(e.transient).toBe(false);
  });
});

describe('classifyNetworkError — §7.1', () => {
  const NETWORK_KINDS = ['timeout', 'dns', 'tcp', 'tls'] as const;
  it.each(NETWORK_KINDS)(
    '%s → network_error { transient: true }',
    (kind: (typeof NETWORK_KINDS)[number]) => {
      expect(classifyNetworkError(kind)).toEqual({
        kind: 'network_error',
        transient: true,
      });
    },
  );
});
