/**
 * Tests for `hashNormalizedRequest` — the deterministic canonical-form
 * SHA-256 hex used by the accounting layer (`prompt_hash` column per
 * §8.1 LLM_CLIENT.md and §8 decisión firmada #1 of iter 7).
 *
 * Contract the tests encode:
 *
 *  1. Output shape: 64-char lowercase hex digest (SHA-256 full).
 *  2. Idempotency: same input → same digest across two calls.
 *  3. Object-key order invariance: reordering keys inside a nested
 *     object (e.g. `toolDefinitions[0].parameters`) does NOT change
 *     the digest.
 *  4. Message order sensitivity: reordering `messages[]` produces a
 *     different digest (sequence carries meaning).
 *  5. `systemPrompt: undefined` ≡ `systemPrompt: ''` — both normalise
 *     to an empty system string at the head of the canonical form.
 *
 * The prompt hash never leaves this module as the pre-image — tests
 * operate on the public `hashNormalizedRequest` entry point, exactly
 * like the router will in commit 4.
 */

import { describe, expect, it } from 'vitest';

import {
  PROMPT_HASH_SEPARATOR,
  hashNormalizedRequest,
} from '../../src/accounting/prompt-hash.js';

import type { NormalizedLLMRequest } from '../../src/types/request.js';

const baseRequest: NormalizedLLMRequest = {
  model: 'claude-haiku-4-5',
  maxTokens: 128,
  messages: [
    { role: 'user', content: 'hello world' },
    { role: 'assistant', content: 'hi there' },
  ],
};

describe('hashNormalizedRequest', () => {
  it('returns a 64-char lowercase hex digest', () => {
    const h = hashNormalizedRequest(baseRequest);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent — same request → same digest across calls', () => {
    const a = hashNormalizedRequest(baseRequest);
    const b = hashNormalizedRequest(baseRequest);
    expect(a).toBe(b);
  });

  it('is invariant to object-key order inside tool parameters', () => {
    const req1: NormalizedLLMRequest = {
      ...baseRequest,
      toolDefinitions: [
        {
          name: 'search',
          description: 'search the web',
          parameters: {
            type: 'object',
            properties: { query: { type: 'string' }, limit: { type: 'number' } },
            required: ['query'],
          },
        },
      ],
    };
    // Same request, but the top-level `parameters` keys are in a
    // different insertion order, and the nested `properties` keys are
    // reshuffled. The canonical form must sort them.
    const req2: NormalizedLLMRequest = {
      ...baseRequest,
      toolDefinitions: [
        {
          name: 'search',
          description: 'search the web',
          parameters: {
            required: ['query'],
            properties: { limit: { type: 'number' }, query: { type: 'string' } },
            type: 'object',
          },
        },
      ],
    };
    expect(hashNormalizedRequest(req1)).toBe(hashNormalizedRequest(req2));
  });

  it('is sensitive to message order — reordering messages changes the digest', () => {
    const reordered: NormalizedLLMRequest = {
      ...baseRequest,
      messages: [...baseRequest.messages].reverse(),
    };
    expect(hashNormalizedRequest(reordered)).not.toBe(
      hashNormalizedRequest(baseRequest),
    );
  });

  it('treats `systemPrompt: undefined` and `systemPrompt: ""` as equivalent', () => {
    const withoutSystem: NormalizedLLMRequest = { ...baseRequest };
    const withEmptySystem: NormalizedLLMRequest = {
      ...baseRequest,
      systemPrompt: '',
    };
    expect(hashNormalizedRequest(withEmptySystem)).toBe(
      hashNormalizedRequest(withoutSystem),
    );
  });

  it('changes when the system prompt changes', () => {
    const withSystem: NormalizedLLMRequest = {
      ...baseRequest,
      systemPrompt: 'you are a helpful assistant',
    };
    expect(hashNormalizedRequest(withSystem)).not.toBe(
      hashNormalizedRequest(baseRequest),
    );
  });

  it('exposes the canonical separator as a stable constant', () => {
    // Pin the literal. Any change here is a hash-breaking change — the
    // migration plan would need to be spelled out in a signed adjustment.
    expect(PROMPT_HASH_SEPARATOR).toBe('\n---\n');
  });

  it('handles content-block arrays with number/boolean/null inputs (stableStringify branches)', () => {
    // A tool_use block carries an `input: Record<string, unknown>`. We
    // flex the canonicaliser across every primitive branch the body
    // of `stableStringify` can take:
    //   - object keys sorted
    //   - string / number / boolean primitives
    //   - `null` preserved
    //   - `undefined` dropped
    //   - nested arrays preserve order
    const req: NormalizedLLMRequest = {
      ...baseRequest,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              toolUseId: 't1',
              toolName: 'calculate',
              input: {
                value: 42,
                precise: true,
                label: 'answer',
                note: null,
                missing: undefined,
                tags: ['primary', 'numeric'],
              },
            },
          ],
        },
      ],
    };
    // Same call, but the top-level `input` keys arrive in a different
    // insertion order, and the enclosing block fields are reshuffled.
    // The canonical form must sort them identically.
    const reordered: NormalizedLLMRequest = {
      ...baseRequest,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              toolName: 'calculate',
              toolUseId: 't1',
              input: {
                tags: ['primary', 'numeric'],
                missing: undefined,
                note: null,
                label: 'answer',
                precise: true,
                value: 42,
              },
            },
          ],
        },
      ],
    };
    expect(hashNormalizedRequest(req)).toBe(hashNormalizedRequest(reordered));
  });

  it('is sensitive to array order inside a tool_use input (sequence carries meaning)', () => {
    // The same set of tags in a different order is NOT the same input —
    // arrays preserve order in the canonical form.
    const makeReq = (tags: readonly string[]): NormalizedLLMRequest => ({
      ...baseRequest,
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              toolUseId: 't1',
              toolName: 'tag',
              input: { tags },
            },
          ],
        },
      ],
    });
    expect(hashNormalizedRequest(makeReq(['a', 'b']))).not.toBe(
      hashNormalizedRequest(makeReq(['b', 'a'])),
    );
  });
});
