/**
 * Contract tests for the Anthropic adapter.
 *
 * Coverage targets (per §9.1 and §7.1):
 *   - Outbound request: endpoint + method, required headers
 *     (`x-api-key`, `anthropic-version`, JSON content), body shape
 *     (model + max_tokens + messages + optional system/temperature/
 *     stop_sequences/tools), role translation (`tool` → `user` with
 *     tool_result block).
 *   - Inbound: successful parse of content blocks (text + tool_use),
 *     usage (input_tokens/output_tokens/sum), stop_reason mapping,
 *     providerRequestId from `request-id` header.
 *   - Errors: 401 → invalid_key, 402 → quota_exhausted, 429 plain →
 *     rate_limit, 500/502/503/504 → provider_down, 529 → provider_down,
 *     400+context → context_too_long, 400+policy → content_blocked,
 *     transport timeout → network_error(transient=true).
 *   - Ping: PingOutput on 200, maps error on 4xx, forwards apiKey.
 *   - Key hygiene: apiKey never appears in URL / query params.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fakeHttp, jsonResponse, neverTimeout, throwTransport } from './_fake-http.js';
import {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_ENDPOINT,
  ANTHROPIC_PING_MODEL,
  createAnthropicProvider,
} from '../../src/providers/anthropic.js';

import type { HttpClient } from '../../src/http/client.js';
import type { NormalizedLLMRequest } from '../../src/types/request.js';


const KEY = 'sk-ant-test-KEYSEC';
// Iter 6 commit 2 (P11): every `provider.call` now requires a
// `correlationId`. Tests share one sentinel so an eyeball grep can
// verify it is echoed into the `anthropic-trace-id` request header
// and nowhere else.
const CORR_ID = 'corr-anthropic-test-0001';

function req(
  overrides: Partial<NormalizedLLMRequest> = {},
): NormalizedLLMRequest {
  return {
    model: 'claude-haiku-4-5',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 64,
    ...overrides,
  };
}

function successBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg_01ABCDEF',
    type: 'message',
    role: 'assistant',
    model: 'claude-haiku-4-5',
    content: [{ type: 'text', text: 'hi!' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 8, output_tokens: 3 },
    ...overrides,
  };
}

describe('anthropic.call — outbound wire format', () => {
  it('sends POST to /v1/messages with x-api-key + version headers', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });

    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });

    expect(res.ok).toBe(true);
    expect(http.received).toHaveLength(1);
    const sent = http.received[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(ANTHROPIC_ENDPOINT);
    expect(sent.headers['x-api-key']).toBe(KEY);
    expect(sent.headers['anthropic-version']).toBe(ANTHROPIC_API_VERSION);
    expect(sent.headers['content-type']).toBe('application/json');
  });

  it('never leaks the API key into URL or query params', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(http.received[0]!.url).not.toContain(KEY);
  });

  it('serialises body with model, max_tokens, messages, optional fields', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: CORR_ID,
      request: req({
        systemPrompt: 'be helpful',
        temperature: 0.3,
        stopSequences: ['STOP'],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.max_tokens).toBe(64);
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }]);
    expect(body.system).toBe('be helpful');
    expect(body.temperature).toBe(0.3);
    expect(body.stop_sequences).toEqual(['STOP']);
  });

  it('translates role=tool into role=user + tool_result block', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
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
              { type: 'tool_result', toolUseId: 'tu_1', output: '42' },
            ],
          },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.messages[0].role).toBe('user');
    expect(body.messages[0].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_1',
      content: '42',
    });
  });

  it('maps toolDefinitions to tools[].input_schema', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: CORR_ID,
      request: req({
        toolDefinitions: [
          {
            name: 'lookup',
            description: 'find it',
            parameters: { type: 'object' },
          },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.tools).toEqual([
      {
        name: 'lookup',
        description: 'find it',
        input_schema: { type: 'object' },
      },
    ]);
  });
});

describe('anthropic.call — inbound response parsing', () => {
  it('parses text-only response with usage and request id', async () => {
    const http = fakeHttp(
      jsonResponse(200, successBody(), { 'request-id': 'req_ab12' }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerUsed).toBe('anthropic');
    expect(res.value.modelUsed).toBe('claude-haiku-4-5');
    expect(res.value.message.role).toBe('assistant');
    expect(res.value.usage).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
    });
    expect(res.value.stopReason).toBe('end_turn');
    expect(res.value.providerRequestId).toBe('req_ab12');
  });

  it('parses tool_use content block', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        content: [
          { type: 'text', text: 'using tool' },
          {
            type: 'tool_use',
            id: 'tu_42',
            name: 'search',
            input: { q: 'x' },
          },
        ],
        stop_reason: 'tool_use',
      }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stopReason).toBe('tool_use');
    expect(res.value.message.content).toEqual([
      { type: 'text', text: 'using tool' },
      {
        type: 'tool_use',
        toolUseId: 'tu_42',
        toolName: 'search',
        input: { q: 'x' },
      },
    ]);
  });

  it('falls back to internal on malformed JSON', async () => {
    const http = fakeHttp({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // 500 bucket classifier → provider_down
    expect(res.error.kind).toBe('provider_down');
  });

  it('maps max_tokens stop_reason', async () => {
    const http = fakeHttp(
      jsonResponse(200, { ...successBody(), stop_reason: 'max_tokens' }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stopReason).toBe('max_tokens');
  });
});

describe('anthropic.call — error mapping (§7.1)', () => {
  it('401 → invalid_key', async () => {
    const http = fakeHttp(
      jsonResponse(401, { error: { type: 'authentication_error' } }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_key');
  });

  it('402 → quota_exhausted', async () => {
    const http = fakeHttp(jsonResponse(402, {}));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('quota_exhausted');
  });

  it('429 + retry-after → rate_limit with retryAfterSec', async () => {
    const http = fakeHttp(jsonResponse(429, {}, { 'retry-after': '17' }));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ kind: 'rate_limit', retryAfterSec: 17 });
  });

  it.each([500, 502, 503, 504])(
    '%i → provider_down',
    async (status: number) => {
      const http = fakeHttp(jsonResponse(status, {}));
      const provider = createAnthropicProvider({
        http: http.fn,
        timeoutSignal: neverTimeout,
      });
      const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.kind).toBe('provider_down');
    },
  );

  it('529 (overloaded) → provider_down via 503 collapse', async () => {
    const http = fakeHttp(jsonResponse(529, {}));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('400 with context keyword → context_too_long', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          type: 'invalid_request_error',
          message: 'prompt is longer than the model context window of 200000',
        },
      }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('context_too_long');
  });

  it('400 with content policy keyword → content_blocked', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          type: 'invalid_request_error',
          message: 'blocked by content policy',
        },
      }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('content_blocked');
  });

  it('transport timeout → network_error(transient=true)', async () => {
    const http = throwTransport('timeout');
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'network_error', transient: true });
  });

  it('transport dns failure → network_error', async () => {
    const http = throwTransport('dns');
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('network_error');
  });
});

describe('anthropic.ping', () => {
  it('returns PingOutput{active} on 200', async () => {
    const http = fakeHttp(
      jsonResponse(200, successBody(), { 'request-id': 'req_ping' }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.status).toBe('active');
    expect(res.value.model).toBe(ANTHROPIC_PING_MODEL);
    expect(res.value.providerRequestId).toBe('req_ping');
  });

  it('sends x-api-key + uses haiku-4-5 and max_tokens=1', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.ping({ apiKey: KEY });
    expect(http.received[0]!.headers['x-api-key']).toBe(KEY);
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.model).toBe(ANTHROPIC_PING_MODEL);
    expect(body.max_tokens).toBe(1);
  });

  it('maps 401 ping to invalid_key', async () => {
    const http = fakeHttp(jsonResponse(401, {}));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: 'bad' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_key');
  });

  it('returns bare PingOutput when no request-id/anthropic-request-id headers', async () => {
    // No request-id / anthropic-request-id header → providerRequestId
    // is omitted entirely (not emitted as `undefined`).
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value).toEqual({
      status: 'active',
      model: ANTHROPIC_PING_MODEL,
    });
    expect('providerRequestId' in res.value).toBe(false);
  });

  it('falls back to anthropic-request-id when request-id absent (ping)', async () => {
    const http = fakeHttp(
      jsonResponse(200, successBody(), { 'anthropic-request-id': 'req_ping_alt' }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerRequestId).toBe('req_ping_alt');
  });

  it('ping maps 503 to provider_down via mapHttpError', async () => {
    // Forces anthropicPing's `mapHttpError` branch (else of 2xx).
    const http = fakeHttp(jsonResponse(503, { error: { message: 'down' } }));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('ping propagates transport failure as network_error', async () => {
    const http = throwTransport('dns');
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('network_error');
  });
});

// ─── Branch-gap coverage (lines 296-303, 311-316, 363-364, 398-404,
//     482-488, 499-509, 523-535 from the v8 coverage report). Each
//     `describe` targets one named cluster so a regression points
//     straight at the responsible branch.

describe('anthropic — outbound block translation edges', () => {
  it('assistant message with tool_use block → Anthropic tool_use', async () => {
    // Covers toAnthropicBlock line 297-303 (tool_use case of the
    // switch). Assistant emits a structured tool_use in its content
    // array; we must keep `id`, `name`, and `input` intact.
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
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
                toolUseId: 'tu_abc',
                toolName: 'search',
                input: { q: 'vancouver' },
              },
            ],
          },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.messages[0].role).toBe('assistant');
    expect(body.messages[0].content[0]).toEqual({
      type: 'tool_use',
      id: 'tu_abc',
      name: 'search',
      input: { q: 'vancouver' },
    });
  });

  it('assistant content with plain text block → { type:"text", text }', async () => {
    // Covers toAnthropicBlock line 295-296 (text case). The content
    // array form (not a bare string) is what exercises the switch.
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
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
            content: [{ type: 'text', text: 'thinking out loud' }],
          },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.messages[0].content).toEqual([
      { type: 'text', text: 'thinking out loud' },
    ]);
  });

  it('tool_result with isError:true → is_error field present as true', async () => {
    // Covers line 311-316 else-branch of the `isError === undefined`
    // ternary, with the true variant of the boolean.
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
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
              {
                type: 'tool_result',
                toolUseId: 'tu_err',
                output: 'boom',
                isError: true,
              },
            ],
          },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.messages[0].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_err',
      content: 'boom',
      is_error: true,
    });
  });

  it('tool_result with isError:false → is_error field present as false', async () => {
    // Covers the same line 311-316 else-branch with the false variant.
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
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
              {
                type: 'tool_result',
                toolUseId: 'tu_ok',
                output: 'all good',
                isError: false,
              },
            ],
          },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.messages[0].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'tu_ok',
      content: 'all good',
      is_error: false,
    });
  });
});

describe('anthropic — inbound response parse guards', () => {
  // Each of the following five variants collapses at the `if (...)`
  // guard at lines 356-364 and returns provider_down (500 bucket).
  // Exercising all five pins every branch of the `||` chain.

  it('type !== "message" → provider_down', async () => {
    const http = fakeHttp(
      jsonResponse(200, { ...successBody(), type: 'error' }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('content not an array → provider_down', async () => {
    const http = fakeHttp(
      jsonResponse(200, { ...successBody(), content: 'nope' }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('usage undefined → provider_down', async () => {
    const http = fakeHttp(
      jsonResponse(200, { ...successBody(), usage: undefined }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('stop_reason undefined → provider_down', async () => {
    const http = fakeHttp(
      jsonResponse(200, { ...successBody(), stop_reason: undefined }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('model undefined → provider_down', async () => {
    const http = fakeHttp(
      jsonResponse(200, { ...successBody(), model: undefined }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('usage.input_tokens/output_tokens missing → totals default to 0', async () => {
    // parseCallResponse uses nullish coalescing (line 386-389). Without
    // either count the sums collapse to 0, which is the branch we had
    // not hit.
    const http = fakeHttp(
      jsonResponse(200, { ...successBody(), usage: {} }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it('unknown stop_reason string defaults to end_turn', async () => {
    // toNormalizedStopReason line 425-427 (default branch).
    const http = fakeHttp(
      jsonResponse(200, { ...successBody(), stop_reason: 'mystery_value' }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stopReason).toBe('end_turn');
  });

  it('stop_sequence stop_reason → stop_sequence', async () => {
    const http = fakeHttp(
      jsonResponse(200, { ...successBody(), stop_reason: 'stop_sequence' }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stopReason).toBe('stop_sequence');
  });

  it('ignores unknown inbound content block types', async () => {
    // For-loop at 367-378 only pushes `text` and `tool_use` — anything
    // else is silently dropped. Exercises the implicit else branch.
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        content: [
          { type: 'text', text: 'before' },
          { type: 'future_block', data: 'ignored' },
          { type: 'text', text: 'after' },
        ],
      }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.message.content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: 'after' },
    ]);
  });
});

describe('anthropic — providerRequestId fallback paths', () => {
  it('no request-id, no anthropic-request-id, no body.id → undefined', async () => {
    // Covers the else-branch of line 397-404: when nothing matches,
    // providerRequestId is omitted from the output object entirely.
    const http = fakeHttp(
      jsonResponse(200, { ...successBody(), id: undefined }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect('providerRequestId' in res.value).toBe(false);
  });

  it('anthropic-request-id header is used when request-id is absent', async () => {
    // Nullish-coalescing chain at line 394-395: request-id absent,
    // anthropic-request-id present.
    const http = fakeHttp(
      jsonResponse(200, successBody(), { 'anthropic-request-id': 'req_alt' }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerRequestId).toBe('req_alt');
  });

  it('falls back to body.id when no request-id headers present', async () => {
    // Final fallback in the chain: headers missing, body.id is the
    // last resort.
    const http = fakeHttp(jsonResponse(200, { ...successBody(), id: 'msg_body_only' }));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerRequestId).toBe('msg_body_only');
  });
});

describe('anthropic — retry-after parsing', () => {
  it('429 with HTTP-date retry-after in the future → positive delta', async () => {
    // readRetryAfterSec line 482-485: date in the future yields a
    // positive integer delta.
    const future = new Date(Date.now() + 120_000).toUTCString();
    const http = fakeHttp(jsonResponse(429, {}, { 'retry-after': future }));
    const provider = createAnthropicProvider({
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
    // Line 485: delta < 0 is clamped to 0.
    const past = new Date(Date.now() - 60_000).toUTCString();
    const http = fakeHttp(jsonResponse(429, {}, { 'retry-after': past }));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ kind: 'rate_limit', retryAfterSec: 0 });
  });

  it('429 with unparseable retry-after → undefined', async () => {
    // Line 487: both parseInt and Date.parse reject; we fall through
    // to `undefined`.
    const http = fakeHttp(jsonResponse(429, {}, { 'retry-after': 'not a date' }));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    if (res.error.kind !== 'rate_limit') throw new Error('expected rate_limit');
    expect(res.error.retryAfterSec).toBeUndefined();
  });

  it('429 with negative integer retry-after → clamped to 0', async () => {
    // Line 481: parseInt returns -5 (finite, but the `asInt >= 0`
    // guard rejects it). Node's V8 `Date.parse('-5')` then accepts
    // "-5" as a negotiated year (extended ISO), yielding an epoch
    // far in the past. Line 485 computes a negative delta and the
    // `delta >= 0 ? delta : 0` guard clamps to 0 — not undefined.
    // The undefined path is covered by the 'not a date' test above.
    const http = fakeHttp(jsonResponse(429, {}, { 'retry-after': '-5' }));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ kind: 'rate_limit', retryAfterSec: 0 });
  });
});

describe('anthropic — 400 + unknown message shape', () => {
  it('400 with non-JSON body → internal via sniff400Body miss', async () => {
    // mapHttpError catches JSON.parse failure and passes `parsed =
    // undefined` (line 441-443) to classifyProviderHttpError. With no
    // hint and no body, the classifier falls through to `internal`.
    const http = fakeHttp({
      status: 400,
      headers: { 'content-type': 'text/plain' },
      body: 'bad request',
    });
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('internal');
  });

  it('400 with "max_tokens" keyword → context_too_long', async () => {
    // Exercises the m.includes('max_tokens') branch of line 452.
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          type: 'invalid_request_error',
          message: 'max_tokens exceeds the model ceiling',
        },
      }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('context_too_long');
  });

  it('400 with "harmful" keyword → content_blocked', async () => {
    // Exercises the m.includes('harmful') branch of line 454.
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          type: 'invalid_request_error',
          message: 'Request refused as potentially harmful content.',
        },
      }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('content_blocked');
  });

  it('400 with "safety" keyword → content_blocked', async () => {
    // Exercises the m.includes('safety') branch of line 454.
    const http = fakeHttp(
      jsonResponse(400, {
        error: {
          type: 'invalid_request_error',
          message: 'Blocked by safety policy.',
        },
      }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('content_blocked');
  });

  it('400 with empty error.message → no hint, classified as internal', async () => {
    // message === '' falls through both conditionals; parsed body has
    // no sniff-able keyword either.
    const http = fakeHttp(
      jsonResponse(400, { error: { type: 'invalid_request_error' } }),
    );
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('internal');
  });
});

describe('anthropic — transport + signal composition edges', () => {
  it('non-HttpTransportError thrown from http client → internal', async () => {
    // Covers transportErrorToLLMError line 499 else-branch and
    // randomCorrelationId() at 502-508.
    const fn: HttpClient = async () => {
      throw new RangeError('unexpected runtime failure');
    };
    const provider = createAnthropicProvider({
      http: fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('internal');
  });

  it('transport tcp failure → network_error', async () => {
    // Additional HttpTransportError kind to pin the
    // transportKindToNetworkKind branch inside transportErrorToLLMError.
    const http = throwTransport('tcp');
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('network_error');
  });

  it('transport tls failure → network_error', async () => {
    const http = throwTransport('tls');
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('network_error');
  });

  it('composeSignal — AbortSignal.any fast path (Node 20+)', async () => {
    // With an abortSignal and AbortSignal.any present, the fast path
    // is taken and the composed signal lands on the outbound request.
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
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

  describe('composeSignal fallback (no AbortSignal.any)', () => {
    let originalAny: unknown;
    beforeEach(() => {
      originalAny = (AbortSignal as unknown as { any?: unknown }).any;
      // Simulate an older runtime without AbortSignal.any so the
      // manual listener path at line 529-535 is exercised.
      (AbortSignal as unknown as { any?: unknown }).any = undefined;
    });
    afterEach(() => {
      (AbortSignal as unknown as { any?: unknown }).any = originalAny;
    });

    it('manually composed signal still forwards to fetch', async () => {
      const http = fakeHttp(jsonResponse(200, successBody()));
      const provider = createAnthropicProvider({
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
      // Hits the `primary.aborted || secondary.aborted` guard at line
      // 533 — we start with the secondary already aborted so the
      // controller's signal must come out aborted too.
      const http = fakeHttp(jsonResponse(200, successBody()));
      const provider = createAnthropicProvider({
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

    it('no secondary signal → primary returned as-is (early return)', async () => {
      // Covers line 522 `if (secondary === undefined) return primary`.
      const http = fakeHttp(jsonResponse(200, successBody()));
      const provider = createAnthropicProvider({
        http: http.fn,
        timeoutSignal: neverTimeout,
      });
      await provider.call({ apiKey: KEY, correlationId: CORR_ID, request: req() });
      expect(http.received[0]!.signal).toBeDefined();
    });
  });
});

describe('anthropic — correlationId header plumbing (iter 6 commit 2)', () => {
  it('stamps the caller-supplied correlationId as the anthropic-trace-id header on call()', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      correlationId: 'corr-anth-trace-stamped-XYZ',
      request: req(),
    });

    const sent = http.received[0]!;
    // Verbatim with §10.1: Anthropic's upstream trace header is
    // lowercase `anthropic-trace-id`. Must equal the caller's id so
    // the provider's backend trace stitches back to our root span.
    expect(sent.headers['anthropic-trace-id']).toBe(
      'corr-anth-trace-stamped-XYZ',
    );
    // Must NOT leak into URL or body.
    expect(sent.url).not.toContain('corr-anth-trace-stamped-XYZ');
    expect(sent.body ?? '').not.toContain('corr-anth-trace-stamped-XYZ');
  });

  it('ping() omits the anthropic-trace-id header — pings have no router-owned correlationId', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createAnthropicProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);

    const sent = http.received[0]!;
    // `ProviderPingInput` is intentionally not plumbed with a
    // correlation id (see `provider.ts` JSDoc); therefore the header
    // must be absent — never empty-string, never `undefined`.
    expect(
      Object.prototype.hasOwnProperty.call(sent.headers, 'anthropic-trace-id'),
    ).toBe(false);
  });
});
