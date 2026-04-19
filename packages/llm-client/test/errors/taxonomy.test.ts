import { describe, expect, it } from 'vitest';

import {
  DEFAULT_USER_MESSAGES,
  LLM_ERROR_CODES,
  type LLMCallError,
  type LLMErrorCode,
  assertNever,
  make,
} from '../../src/errors/index.js';

describe('LLMCallError taxonomy', () => {
  describe('LLM_ERROR_CODES', () => {
    it('covers exactly the 11 variants of §3.5', () => {
      // Sorted so a regression also fails readably. If the contract
      // adds a new variant, update both the union and this list.
      expect([...LLM_ERROR_CODES].sort()).toEqual(
        [
          'invalid_key',
          'quota_exhausted',
          'rate_limit',
          'provider_down',
          'content_blocked',
          'context_too_long',
          'kms_unavailable',
          'routing_disabled',
          'plan_requires_key',
          'network_error',
          'internal',
        ].sort(),
      );
    });

    it('has no duplicates', () => {
      expect(new Set(LLM_ERROR_CODES).size).toBe(LLM_ERROR_CODES.length);
    });
  });

  describe('constructors', () => {
    it('invalidKey uses a generic user-facing message by default', () => {
      const e = make.invalidKey('anthropic');
      expect(e).toEqual({
        kind: 'invalid_key',
        provider: 'anthropic',
        userMessage: DEFAULT_USER_MESSAGES.invalid_key('anthropic'),
      });
      // No raw provider data leaked.
      expect(e.userMessage).not.toContain('sk-');
    });

    it('invalidKey accepts an override message', () => {
      const e = make.invalidKey('openai', 'custom');
      expect(e.userMessage).toBe('custom');
    });

    it('rateLimit omits retryAfterSec when undefined', () => {
      const e = make.rateLimit('openai');
      expect(e).toEqual({ kind: 'rate_limit', provider: 'openai' });
      expect('retryAfterSec' in e).toBe(false);
    });

    it('rateLimit attaches retryAfterSec when provided', () => {
      const e = make.rateLimit('gemini', 42);
      expect(e).toEqual({
        kind: 'rate_limit',
        provider: 'gemini',
        retryAfterSec: 42,
      });
    });

    it('providerDown carries circuitOpen flag verbatim', () => {
      expect(make.providerDown('anthropic', true).circuitOpen).toBe(true);
      expect(make.providerDown('anthropic', false).circuitOpen).toBe(false);
    });

    it('contentBlocked only accepts the two canonical reasons', () => {
      expect(make.contentBlocked('moderation').reason).toBe('moderation');
      expect(make.contentBlocked('safety').reason).toBe('safety');
    });

    it('kmsUnavailable distinguishes transient vs fail-closed', () => {
      expect(make.kmsUnavailable(true).transient).toBe(true);
      expect(make.kmsUnavailable(false).transient).toBe(false);
    });

    it('quotaExhausted default message mentions upgrading to Influencer', () => {
      expect(DEFAULT_USER_MESSAGES.quota_exhausted('openai')).toMatch(
        /Influencer/,
      );
    });
  });

  describe('assertNever', () => {
    it('narrows exhaustively over every variant', () => {
      // This is mainly a typecheck guard — if a new variant is added
      // to `LLMCallError` without a matching case here, TS fails to
      // compile because the `default` branch would reach a non-never.
      function label(e: LLMCallError): LLMErrorCode {
        switch (e.kind) {
          case 'invalid_key':
          case 'quota_exhausted':
          case 'rate_limit':
          case 'provider_down':
          case 'content_blocked':
          case 'context_too_long':
          case 'kms_unavailable':
          case 'routing_disabled':
          case 'plan_requires_key':
          case 'network_error':
          case 'internal':
            return e.kind;
          default:
            return assertNever(e);
        }
      }

      expect(label(make.internal('abc'))).toBe('internal');
    });

    it('throws when a bogus variant leaks through', () => {
      expect(() =>
        assertNever({ kind: 'not_a_variant' } as never),
      ).toThrow(/Unhandled LLMCallError variant/);
    });
  });
});
