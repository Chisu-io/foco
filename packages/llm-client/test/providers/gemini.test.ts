/**
 * Contract tests for the Gemini adapter.
 *
 * Coverage targets (per §9.3 and §7.1):
 *   - Outbound: endpoint is `{base}/{model}:generateContent`,
 *     `x-goog-api-key` header carries the key (NEVER in URL — §2
 *     invariant 1), body has contents/parts, role translation
 *     (assistant → 'model', tool → 'user' + functionResponse part),
 *     systemInstruction separate from contents, generationConfig
 *     holds maxOutputTokens + temperature + stopSequences +
 *     responseMimeType, tools wrapped in functionDeclarations.
 *   - Inbound: parses candidates[0] text, functionCall → tool_use,
 *     usageMetadata mapping, modelVersion → modelUsed.
 *   - Safety: finishReason SAFETY/RECITATION → content_blocked with
 *     reason='safety' (NOT a success); promptFeedback.blockReason
 *     ⇒ content_blocked.
 *   - Errors: 400 "API key not valid" → invalid_key; 401 →
 *     invalid_key; 403 → invalid_key (or quota_exhausted with
 *     billing keyword); 429 + billing keyword → quota_exhausted;
 *     429 plain → rate_limit; 500 → provider_down; 400+context
 *     → context_too_long; transport → network_error.
 *   - Ping: uses gemini-2.5-flash at {base}/gemini-2.5-flash:generateContent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeHttp, jsonResponse, neverTimeout, throwTransport } from './_fake-http.js';
import {
  GEMINI_ENDPOINT_BASE,
  GEMINI_PING_MODEL,
  createGeminiProvider,
} from '../../src/providers/gemini.js';

import type { HttpClient } from '../../src/http/client.js';
import type { NormalizedLLMRequest } from '../../src/types/request.js';


const KEY = 'AIzaSyTESTKEY';
// Iter 6 commit 2 (P11): every `provider.call` now requires a
// `correlationId`. Tests share one sentinel so we can assert that
// Gemini — unlike Anthropic / OpenAI — does NOT emit any trace
// header (no standard `x-google-trace-id` equivalent; see
// `src/providers/gemini.ts` JSDoc).
const CORR_ID = 'corr-gemini-test-0001';

function req(
  overrides: Partial<NormalizedLLMRequest> = {},
): NormalizedLLMRequest {
  return {
    model: 'gemini-2.5-flash',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 64,
    ...overrides,
  };
}

function successBody(overrides: Record<string, unknown> = {}) {
  return {
    candidates: [
      {
        content: {
          role: 'model',
          parts: [{ text: 'hi!' }],
        },
        finishReason: 'STOP',
        index: 0,
      },
    ],
    usageMetadata: {
      promptTokenCount: 8,
      candidatesTokenCount: 3,
      totalTokenCount: 11,
    },
    modelVersion: 'gemini-2.5-flash-002',
    ...overrides,
  };
}

describe('gemini.call — outbound wire format', () => {
  it('POSTs to {base}/{model}:generateContent', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(http.received[0]!.method).toBe('POST');
    expect(http.received[0]!.url).toBe(
      `${GEMINI_ENDPOINT_BASE}/gemini-2.5-flash:generateContent`,
    );
  });

  it('sends x-goog-api-key header, NEVER puts key in URL', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    const sent = http.received[0]!;
    expect(sent.headers['x-goog-api-key']).toBe(KEY);
    expect(sent.url).not.toContain(KEY);
    expect(sent.url).not.toContain('key=');
  });

  it('puts systemPrompt into systemInstruction, not contents[]', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: CORR_ID,
      request: req({ systemPrompt: 'be concise' }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.systemInstruction).toEqual({
      parts: [{ text: 'be concise' }],
    });
    // systemPrompt must not end up as a user turn.
    expect(body.contents.some((c: { role: string }) => c.role === 'system')).toBe(false);
  });

  it('nests maxTokens/temperature/stopSequences in generationConfig', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: CORR_ID,
      request: req({
        temperature: 0.3,
        stopSequences: ['STOP'],
        responseFormat: 'json_object',
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 64,
      temperature: 0.3,
      stopSequences: ['STOP'],
      responseMimeType: 'application/json',
    });
  });

  it('translates assistant role → "model" in contents[]', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: CORR_ID,
      request: req({
        messages: [
          { role: 'user', content: 'q?' },
          { role: 'assistant', content: 'a.' },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.contents.map((c: { role: string }) => c.role)).toEqual([
      'user',
      'model',
    ]);
  });

  it('translates tool role into functionResponse part on a user turn', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: CORR_ID,
      request: req({
        messages: [
          {
            role: 'tool',
            content: [
              { type: 'tool_result', toolUseId: 'search', output: '42' },
            ],
          },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.contents[0].role).toBe('user');
    expect(body.contents[0].parts[0]).toEqual({
      functionResponse: {
        name: 'search',
        response: { output: '42' },
      },
    });
  });

  it('wraps toolDefinitions inside functionDeclarations', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: CORR_ID,
      request: req({
        toolDefinitions: [
          { name: 'lookup', description: 'look', parameters: { type: 'object' } },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.tools).toEqual([
      {
        functionDeclarations: [
          { name: 'lookup', description: 'look', parameters: { type: 'object' } },
        ],
      },
    ]);
  });
});

describe('gemini.call — inbound response parsing', () => {
  it('parses text + usage + modelVersion → modelUsed', async () => {
    const http = fakeHttp(
      jsonResponse(200, successBody(), { 'x-goog-request-id': 'g-req-1' }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerUsed).toBe('gemini');
    expect(res.value.modelUsed).toBe('gemini-2.5-flash-002');
    expect(res.value.usage).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
    });
    expect(res.value.stopReason).toBe('end_turn');
    expect(res.value.providerRequestId).toBe('g-req-1');
  });

  it('maps MAX_TOKENS finishReason', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'trunc...' }] },
            finishReason: 'MAX_TOKENS',
            index: 0,
          },
        ],
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stopReason).toBe('max_tokens');
  });

  it('parses functionCall parts into tool_use blocks with tool_use stop', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'search',
                    args: { q: 'x' },
                  },
                },
              ],
            },
            finishReason: 'STOP',
            index: 0,
          },
        ],
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // §9.3: Gemini lacks a tool_use finishReason — adapter upgrades.
    expect(res.value.stopReason).toBe('tool_use');
    expect(res.value.message.content[0]).toMatchObject({
      type: 'tool_use',
      toolName: 'search',
      input: { q: 'x' },
    });
  });

  it('SAFETY finishReason → content_blocked{safety}', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        candidates: [
          {
            content: { role: 'model', parts: [] },
            finishReason: 'SAFETY',
            index: 0,
          },
        ],
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'content_blocked', reason: 'safety' });
  });

  it('RECITATION finishReason → content_blocked{safety}', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        candidates: [
          {
            content: { role: 'model', parts: [] },
            finishReason: 'RECITATION',
            index: 0,
          },
        ],
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'content_blocked', reason: 'safety' });
  });

  it('promptFeedback.blockReason → content_blocked{safety}', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        promptFeedback: { blockReason: 'SAFETY' },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'content_blocked', reason: 'safety' });
  });
});

describe('gemini.call — error mapping (§7.1)', () => {
  it('400 with "API key not valid" message → invalid_key', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          code: 400,
          message: 'API key not valid. Please pass a valid API key.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: 'bad', request: req(), correlationId: CORR_ID });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_key');
  });

  it('401 UNAUTHENTICATED → invalid_key', async () => {
    const http = fakeHttp(
      jsonResponse(401, {
        error: { code: 401, message: 'auth', status: 'UNAUTHENTICATED' },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_key');
  });

  it('403 PERMISSION_DENIED with billing keyword → quota_exhausted', async () => {
    const http = fakeHttp(
      jsonResponse(403, {
        error: {
          code: 403,
          message: 'Billing has not been enabled for this project.',
          status: 'PERMISSION_DENIED',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('quota_exhausted');
  });

  it('403 PERMISSION_DENIED without billing keyword → invalid_key', async () => {
    const http = fakeHttp(
      jsonResponse(403, {
        error: {
          code: 403,
          message: 'The caller does not have permission.',
          status: 'PERMISSION_DENIED',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_key');
  });

  it('429 RESOURCE_EXHAUSTED with billing keyword → quota_exhausted', async () => {
    const http = fakeHttp(
      jsonResponse(429, {
        error: {
          code: 429,
          message: 'You exceeded your current quota, please check billing.',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('quota_exhausted');
  });

  it('429 RESOURCE_EXHAUSTED without billing keyword → rate_limit', async () => {
    const http = fakeHttp(
      jsonResponse(
        429,
        {
          error: {
            code: 429,
            message: 'Requests per minute quota exceeded for this model.',
            status: 'RESOURCE_EXHAUSTED',
          },
        },
        { 'retry-after': '30' },
      ),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ kind: 'rate_limit', retryAfterSec: 30 });
  });

  it('400 with context keyword → context_too_long', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          code: 400,
          message: 'The input token count exceeds the maximum number of tokens.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('context_too_long');
  });

  it.each([500, 502, 503, 504])(
    '%i → provider_down',
    async (status: number) => {
      const http = fakeHttp(jsonResponse(status, {}));
      const provider = createGeminiProvider({
        http: http.fn,
        timeoutSignal: neverTimeout,
      });
      const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('provider_down');
    },
  );

  it('transport error → network_error(transient=true)', async () => {
    const http = throwTransport('tls');
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'network_error', transient: true });
  });
});

describe('gemini.ping', () => {
  it('hits {base}/gemini-2.5-flash:generateContent with apiKey header', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('active');
    expect(res.value.model).toBe(GEMINI_PING_MODEL);
    expect(http.received[0]!.url).toBe(
      `${GEMINI_ENDPOINT_BASE}/${GEMINI_PING_MODEL}:generateContent`,
    );
    expect(http.received[0]!.headers['x-goog-api-key']).toBe(KEY);
  });

  it('maps 400 "API key not valid" ping to invalid_key', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: { code: 400, message: 'API key not valid.', status: 'INVALID_ARGUMENT' },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: 'bad' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_key');
  });

  it('ping on 200 without request id returns bare PingOutput', async () => {
    const http = fakeHttp(jsonResponse(200, successBody(), {}));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerRequestId).toBeUndefined();
  });

  it('ping falls back to x-request-id when x-goog-request-id is absent', async () => {
    const http = fakeHttp(
      jsonResponse(200, successBody(), { 'x-request-id': 'gx-42' }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerRequestId).toBe('gx-42');
  });
});

// ─── Branch-coverage gap tests ────────────────────────────────────────
// Covers uncovered ranges from the coverage report:
//   355 (empty text), 357-362 (tool_use outbound),
//   571-572 (error body parse fallback),
//   630-632 + 636-642 (403/400 keyword branches),
//   663-669 (retry-after parsing),
//   675-682 (non-HttpTransportError path),
//   691-703 (composeSignal fallback).

describe('gemini — outbound parts conversion edges', () => {
  it('drops empty-text content blocks from parts', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: CORR_ID,
      request: req({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: '' }, // dropped
              { type: 'text', text: 'real' },
            ],
          },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.contents[0].parts).toEqual([{ text: 'real' }]);
  });

  it('drops messages whose parts all collapse to empty', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: CORR_ID,
      request: req({
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: '' }],
          },
          { role: 'user', content: 'kept' },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].parts).toEqual([{ text: 'kept' }]);
  });

  it('drops empty-string message content entirely', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: CORR_ID,
      request: req({
        messages: [
          { role: 'user', content: '' },
          { role: 'user', content: 'second' },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.contents).toHaveLength(1);
  });

  it('assistant tool_use → functionCall part', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: CORR_ID,
      request: req({
        messages: [
          {
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                toolUseId: 'search-0',
                toolName: 'search',
                input: { q: 'foo' },
              },
            ],
          },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.contents[0].role).toBe('model');
    expect(body.contents[0].parts[0]).toEqual({
      functionCall: { name: 'search', args: { q: 'foo' } },
    });
  });
});

describe('gemini — inbound edges', () => {
  it('promptFeedback with empty blockReason is ignored (not blocked)', async () => {
    const http = fakeHttp(
      jsonResponse(200, { ...successBody(), promptFeedback: { blockReason: '' } }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
  });

  it('promptFeedback BLOCK_REASON_UNSPECIFIED is not treated as blocked', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        promptFeedback: { blockReason: 'BLOCK_REASON_UNSPECIFIED' },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
  });

  it('missing usageMetadata → provider_down', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'hi' }] },
            finishReason: 'STOP',
          },
        ],
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('malformed JSON response → provider_down', async () => {
    const http = fakeHttp({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('falls back to requested model when modelVersion is missing', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        candidates: successBody().candidates,
        usageMetadata: successBody().usageMetadata,
        // no modelVersion
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.modelUsed).toBe('gemini-2.5-flash');
  });

  it('omits providerRequestId when neither header is present', async () => {
    const http = fakeHttp(jsonResponse(200, successBody(), {}));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerRequestId).toBeUndefined();
  });

  it('falls back to x-request-id when x-goog-request-id is absent', async () => {
    const http = fakeHttp(
      jsonResponse(200, successBody(), { 'x-request-id': 'fallback-id' }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerRequestId).toBe('fallback-id');
  });

  it('falls back to inTokens+outTokens when totalTokenCount is missing', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 7 },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      totalTokens: 12,
    });
  });

  it('FINISH_REASON_UNSPECIFIED with tool_use is promoted to tool_use', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{ functionCall: { name: 'f', args: {} } }],
            },
            finishReason: 'FINISH_REASON_UNSPECIFIED',
          },
        ],
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stopReason).toBe('tool_use');
  });

  it('OTHER finishReason collapses to end_turn', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        candidates: [
          {
            content: { role: 'model', parts: [{ text: 'ok' }] },
            finishReason: 'OTHER',
          },
        ],
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stopReason).toBe('end_turn');
  });

  it('functionCall without a name is skipped', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                { functionCall: { args: {} } }, // no name
                { text: 'saved' },
              ],
            },
            finishReason: 'STOP',
          },
        ],
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.message.content).toEqual([{ type: 'text', text: 'saved' }]);
  });
});

describe('gemini — error mapping extra keyword paths', () => {
  it('non-JSON error body is tolerated', async () => {
    const http = fakeHttp({
      status: 500,
      headers: { 'content-type': 'text/html' },
      body: '<html>Bad Gateway</html>',
    });
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('400 with message "invalid authentication" → invalid_key', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: { code: 400, message: 'Invalid authentication credentials.' },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_key');
  });

  it('403 with "quota" keyword → quota_exhausted', async () => {
    const http = fakeHttp(
      jsonResponse(403, {
        error: {
          code: 403,
          message: 'Quota project is not set.',
          status: 'PERMISSION_DENIED',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('quota_exhausted');
  });

  it('403 with "consumer has been suspended" → quota_exhausted', async () => {
    const http = fakeHttp(
      jsonResponse(403, {
        error: {
          code: 403,
          message: 'Consumer has been suspended.',
          status: 'PERMISSION_DENIED',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('quota_exhausted');
  });

  it('403 with "payment" keyword → quota_exhausted', async () => {
    const http = fakeHttp(
      jsonResponse(403, {
        error: {
          code: 403,
          message: 'Payment required to continue.',
          status: 'PERMISSION_DENIED',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('quota_exhausted');
  });

  it('429 with "free tier" keyword → quota_exhausted', async () => {
    const http = fakeHttp(
      jsonResponse(429, {
        error: {
          code: 429,
          message: 'Free tier quota has been exhausted.',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('quota_exhausted');
  });

  it('429 with "daily" keyword → quota_exhausted', async () => {
    const http = fakeHttp(
      jsonResponse(429, {
        error: {
          code: 429,
          message: 'Daily quota hit.',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('quota_exhausted');
  });

  it('429 with "free quota" keyword → quota_exhausted', async () => {
    const http = fakeHttp(
      jsonResponse(429, {
        error: {
          code: 429,
          message: 'Free quota exceeded.',
          status: 'RESOURCE_EXHAUSTED',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('quota_exhausted');
  });

  it('400 with "too long" keyword → context_too_long', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          code: 400,
          message: 'Input is too long for this model.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('context_too_long');
  });

  it('400 with "context window" keyword → context_too_long', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          code: 400,
          message: 'Exceeded context window.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('context_too_long');
  });

  it('400 with "context length" keyword → context_too_long', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          code: 400,
          message: 'Context length exceeded.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('context_too_long');
  });

  it('400 with "maximum number of tokens" → context_too_long', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          code: 400,
          message: 'Request has the maximum number of tokens exceeded.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('context_too_long');
  });

  it('400 with "safety" keyword → content_blocked{safety}', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          code: 400,
          message: 'Blocked by safety settings.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'content_blocked', reason: 'safety' });
  });

  it('400 with "harm_category" keyword → content_blocked{safety}', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          code: 400,
          message: 'harm_category triggered',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'content_blocked', reason: 'safety' });
  });

  it('400 with "content policy" keyword → content_blocked{safety}', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          code: 400,
          message: 'Violates content policy.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'content_blocked', reason: 'safety' });
  });

  it('400 with "blocked" keyword → content_blocked{safety}', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          code: 400,
          message: 'Request was blocked.',
          status: 'INVALID_ARGUMENT',
        },
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'content_blocked', reason: 'safety' });
  });
});

describe('gemini — retry-after parsing', () => {
  it('429 with integer retry-after → retryAfterSec set', async () => {
    const http = fakeHttp(
      jsonResponse(429, { error: { status: 'RESOURCE_EXHAUSTED' } }, {
        'retry-after': '7',
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ kind: 'rate_limit', retryAfterSec: 7 });
  });

  it('429 with HTTP-date retry-after in the future → positive delta', async () => {
    const future = new Date(Date.now() + 120_000).toUTCString();
    const http = fakeHttp(
      jsonResponse(429, { error: { status: 'RESOURCE_EXHAUSTED' } }, {
        'retry-after': future,
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    if (res.error.kind !== 'rate_limit') throw new Error('expected rate_limit');
    expect(res.error.retryAfterSec).toBeGreaterThan(0);
  });

  it('429 with HTTP-date retry-after in the past → 0', async () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    const http = fakeHttp(
      jsonResponse(429, { error: { status: 'RESOURCE_EXHAUSTED' } }, {
        'retry-after': past,
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ kind: 'rate_limit', retryAfterSec: 0 });
  });

  it('429 with unparseable retry-after → undefined', async () => {
    const http = fakeHttp(
      jsonResponse(429, { error: { status: 'RESOURCE_EXHAUSTED' } }, {
        'retry-after': 'garbage',
      }),
    );
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    if (res.error.kind !== 'rate_limit') throw new Error('expected rate_limit');
    expect(res.error.retryAfterSec).toBeUndefined();
  });
});

describe('gemini — transport + signal composition edges', () => {
  it('non-HttpTransportError thrown from http client → internal', async () => {
    const fn: HttpClient = async () => {
      throw new RangeError('unexpected runtime failure');
    };
    const provider = createGeminiProvider({
      http: fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('internal');
  });

  it('custom endpointBase with trailing slash is normalised', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      endpointBase: 'https://example.test/v1beta/models/',
      timeoutSignal: neverTimeout,
    });
    await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(http.received[0]!.url).toBe(
      'https://example.test/v1beta/models/gemini-2.5-flash:generateContent',
    );
  });

  describe('composeSignal fallback (no AbortSignal.any)', () => {
    let originalAny: unknown;
    beforeEach(() => {
      originalAny = (AbortSignal as unknown as { any?: unknown }).any;
      (AbortSignal as unknown as { any?: unknown }).any = undefined;
    });
    afterEach(() => {
      (AbortSignal as unknown as { any?: unknown }).any = originalAny;
    });

    it('manually composed signal forwards to fetch', async () => {
      const http = fakeHttp(jsonResponse(200, successBody()));
      const provider = createGeminiProvider({
        http: http.fn,
        timeoutSignal: neverTimeout,
      });
      const ctrl = new AbortController();
      await provider.call({
        apiKey: KEY,
        correlationId: CORR_ID,
        request: req(),
        abortSignal: ctrl.signal,
      });
      expect(http.received[0]!.signal).toBeDefined();
    });

    it('manually composed signal reflects pre-aborted secondary', async () => {
      const http = fakeHttp(jsonResponse(200, successBody()));
      const provider = createGeminiProvider({
        http: http.fn,
        timeoutSignal: neverTimeout,
      });
      const ctrl = new AbortController();
      ctrl.abort();
      await provider.call({
        apiKey: KEY,
        correlationId: CORR_ID,
        request: req(),
        abortSignal: ctrl.signal,
      });
      expect(http.received[0]!.signal?.aborted).toBe(true);
    });
  });
});

describe('gemini — correlationId header plumbing (iter 6 commit 2)', () => {
  it('does NOT emit any trace header on call() — Gemini has no standard equivalent', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: 'corr-gemini-trace-stamped-XYZ',
      request: req(),
    });

    const sent = http.received[0]!;
    // Anthropic and OpenAI both have documented client-trace headers
    // (`anthropic-trace-id`, `X-Request-ID`); the Gemini AI Studio
    // surface does not. Asserting the absence of the two known
    // sibling headers is the strictest invariant we can keep without
    // pinning ourselves to an implementation choice that Google may
    // later publish.
    expect(
      Object.prototype.hasOwnProperty.call(sent.headers, 'anthropic-trace-id'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(sent.headers, 'X-Request-ID'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(sent.headers, 'x-request-id'),
    ).toBe(false);
    // The id must also stay out of the URL + body — the JSDoc on the
    // adapter promises "no header emission, no echo anywhere".
    expect(sent.url).not.toContain('corr-gemini-trace-stamped-XYZ');
    expect(sent.body ?? '').not.toContain('corr-gemini-trace-stamped-XYZ');
  });

  it('ping() also emits no trace header', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createGeminiProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);

    const sent = http.received[0]!;
    expect(
      Object.prototype.hasOwnProperty.call(sent.headers, 'anthropic-trace-id'),
    ).toBe(false);
    expect(
      Object.prototype.hasOwnProperty.call(sent.headers, 'X-Request-ID'),
    ).toBe(false);
  });
});
