/**
 * Contract tests for the OpenAI adapter.
 *
 * Coverage targets (per §9.2 and §7.1):
 *   - Outbound: endpoint + `Authorization: Bearer`, body shape
 *     (messages[] with optional system prepended, max_tokens, stop,
 *     response_format, tools as {type:'function', function: {...}}).
 *   - Inbound: parse choices[0].message.content + tool_calls with
 *     JSON-parsed arguments, usage (prompt/completion → input/output),
 *     finish_reason mapping, providerRequestId from `x-request-id`.
 *   - Errors: 401 → invalid_key, 402 → quota_exhausted, 429 plain →
 *     rate_limit, 429 + insufficient_quota → quota_exhausted (billing
 *     short-circuit), 500 → provider_down, 400 + context_length_exceeded
 *     → context_too_long, 400 + content_filter code → content_blocked,
 *     content_filter finish_reason → content_blocked as error (NOT a
 *     successful output), transport → network_error.
 *   - Key hygiene: apiKey never appears in URL / query params.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  OPENAI_ENDPOINT,
  OPENAI_PING_MODEL,
  createOpenAIProvider,
} from '../../src/providers/openai.js';
import type { HttpClient } from '../../src/http/client.js';
import type { NormalizedLLMRequest } from '../../src/types/request.js';

import { fakeHttp, jsonResponse, neverTimeout, throwTransport } from './_fake-http.js';

const KEY = 'sk-openai-test-SECRET';

function req(
  overrides: Partial<NormalizedLLMRequest> = {},
): NormalizedLLMRequest {
  return {
    model: 'gpt-5-mini',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 64,
    ...overrides,
  };
}

function successBody(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chatcmpl_01',
    model: 'gpt-5-mini',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: { role: 'assistant', content: 'hi!' },
      },
    ],
    usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    ...overrides,
  };
}

describe('openai.call — outbound wire format', () => {
  it('POSTs to chat completions with Bearer auth', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({ apiKey: KEY, request: req() });
    const sent = http.received[0]!;
    expect(sent.method).toBe('POST');
    expect(sent.url).toBe(OPENAI_ENDPOINT);
    expect(sent.headers['authorization']).toBe(`Bearer ${KEY}`);
    expect(sent.headers['content-type']).toBe('application/json');
  });

  it('does not leak API key into URL', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({ apiKey: KEY, request: req() });
    expect(http.received[0]!.url).not.toContain(KEY);
  });

  it('prepends systemPrompt as a system message', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      request: req({ systemPrompt: 'be concise' }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.messages[0]).toEqual({ role: 'system', content: 'be concise' });
    expect(body.messages[1]).toEqual({ role: 'user', content: 'hello' });
  });

  it('forwards stopSequences as stop[] and maxTokens as max_tokens', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      request: req({ stopSequences: ['STOP'], temperature: 0.5 }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.stop).toEqual(['STOP']);
    expect(body.max_tokens).toBe(64);
    expect(body.temperature).toBe(0.5);
  });

  it('maps responseFormat=json_object to response_format', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      request: req({ responseFormat: 'json_object' }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('maps toolDefinitions into tools[].function', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      request: req({
        toolDefinitions: [
          { name: 'lookup', description: 'look', parameters: { type: 'object' } },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'lookup',
          description: 'look',
          parameters: { type: 'object' },
        },
      },
    ]);
  });

  it('fans out role=tool into tool_call_id messages', async () => {
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    await provider.call({
      apiKey: KEY,
      request: req({
        messages: [
          {
            role: 'tool',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', output: '42' },
            ],
          },
        ],
      }),
    });
    const body = JSON.parse(http.received[0]!.body ?? '{}');
    expect(body.messages[0]).toEqual({
      role: 'tool',
      tool_call_id: 'call_1',
      content: '42',
    });
  });
});

describe('openai.call — inbound response parsing', () => {
  it('parses text + usage + request id', async () => {
    const http = fakeHttp(
      jsonResponse(200, successBody(), { 'x-request-id': 'req_xyz' }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerUsed).toBe('openai');
    expect(res.value.modelUsed).toBe('gpt-5-mini');
    expect(res.value.usage).toEqual({
      inputTokens: 8,
      outputTokens: 3,
      totalTokens: 11,
    });
    expect(res.value.stopReason).toBe('end_turn');
    expect(res.value.providerRequestId).toBe('req_xyz');
  });

  it('maps finish_reason length → max_tokens', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        choices: [
          {
            index: 0,
            finish_reason: 'length',
            message: { role: 'assistant', content: 'trunc...' },
          },
        ],
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stopReason).toBe('max_tokens');
  });

  it('parses tool_calls into tool_use block with JSON-decoded input', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_7',
                  type: 'function',
                  function: {
                    name: 'search',
                    arguments: '{"q":"x"}',
                  },
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.stopReason).toBe('tool_use');
    expect(res.value.message.content).toEqual([
      {
        type: 'tool_use',
        toolUseId: 'call_7',
        toolName: 'search',
        input: { q: 'x' },
      },
    ]);
  });

  it('content_filter finish_reason → content_blocked error (not success)', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        choices: [
          {
            index: 0,
            finish_reason: 'content_filter',
            message: { role: 'assistant', content: 'partial' },
          },
        ],
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'content_blocked', reason: 'moderation' });
  });
});

describe('openai.call — error mapping (§7.1)', () => {
  it('401 → invalid_key', async () => {
    const http = fakeHttp(
      jsonResponse(401, { error: { code: 'invalid_api_key' } }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: 'bad', request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_key');
  });

  it('429 plain → rate_limit', async () => {
    const http = fakeHttp(
      jsonResponse(429, { error: { code: 'rate_limit_exceeded' } }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('rate_limit');
  });

  it('429 + insufficient_quota code → quota_exhausted (billing short-circuit)', async () => {
    const http = fakeHttp(
      jsonResponse(429, {
        error: { type: 'insufficient_quota', code: 'insufficient_quota' },
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('quota_exhausted');
  });

  it('400 + context_length_exceeded code → context_too_long', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: { code: 'context_length_exceeded', message: 'too long' },
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('context_too_long');
  });

  it('400 + content_filter code → content_blocked', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: { code: 'content_filter', message: 'blocked' },
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('content_blocked');
  });

  it('500 → provider_down', async () => {
    const http = fakeHttp(jsonResponse(500, {}));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('transport error → network_error(transient=true)', async () => {
    const http = throwTransport('tcp');
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toEqual({ kind: 'network_error', transient: true });
  });
});

describe('openai.ping', () => {
  it('returns PingOutput{active} on 200 with rate-limit hints', async () => {
    const http = fakeHttp(
      jsonResponse(200, successBody(), {
        'x-request-id': 'req_p1',
        'x-ratelimit-remaining-requests': '99',
        'x-ratelimit-remaining-tokens': '1234',
        'x-ratelimit-reset-requests': '1m30s',
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.model).toBe(OPENAI_PING_MODEL);
    expect(res.value.providerRequestId).toBe('req_p1');
    expect(res.value.rateLimitHint).toEqual({
      remainingRequests: 99,
      remainingTokens: 1234,
      resetSec: 90,
    });
  });

  it('maps 401 ping to invalid_key', async () => {
    const http = fakeHttp(jsonResponse(401, {}));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: 'bad' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_key');
  });

  it('ping on 200 without request id or rate-limit headers returns bare PingOutput', async () => {
    const http = fakeHttp(jsonResponse(200, successBody(), {}));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.model).toBe(OPENAI_PING_MODEL);
    expect(res.value.providerRequestId).toBeUndefined();
    expect(res.value.rateLimitHint).toBeUndefined();
  });

  it('ping prefers openai-request-id when x-request-id is absent', async () => {
    const http = fakeHttp(
      jsonResponse(200, successBody(), { 'openai-request-id': 'oai_42' }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerRequestId).toBe('oai_42');
  });
});

// ─── Branch-coverage gap tests ────────────────────────────────────────
// These cover the uncovered lines from the coverage report:
//   413, 434-440, 483-484, 504-510, 528, 530-536,
//   583-584, 592-602, 610-617, 624-636
// (see commit message iter3-providers.txt for context)

describe('openai — inbound tool_calls parsing edge cases', () => {
  it('skips tool_calls lacking id or function (defensive guard)', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                // malformed: no id
                { type: 'function', function: { name: 'x', arguments: '{}' } },
                // malformed: no function field
                { id: 'call_noo', type: 'function' },
                // good entry survives
                {
                  id: 'call_ok',
                  type: 'function',
                  function: { name: 'good', arguments: '{"k":1}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.message.content).toEqual([
      {
        type: 'tool_use',
        toolUseId: 'call_ok',
        toolName: 'good',
        input: { k: 1 },
      },
    ]);
  });

  it('wraps unparseable tool_call arguments in __raw fallback', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_bad',
                  type: 'function',
                  function: { name: 'search', arguments: 'not-json' },
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.message.content[0]).toMatchObject({
      type: 'tool_use',
      input: { __raw: 'not-json' },
    });
  });

  it('falls back to toolName="" when function.name is missing', async () => {
    const http = fakeHttp(
      jsonResponse(200, {
        ...successBody(),
        choices: [
          {
            index: 0,
            finish_reason: 'tool_calls',
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_x',
                  type: 'function',
                  function: { arguments: '{}' },
                },
              ],
            },
          },
        ],
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.message.content[0]).toMatchObject({
      type: 'tool_use',
      toolName: '',
    });
  });

  it('omits providerRequestId when no header and no id in body', async () => {
    const http = fakeHttp(
      jsonResponse(
        200,
        {
          model: 'gpt-5-mini',
          choices: [
            {
              index: 0,
              finish_reason: 'stop',
              message: { role: 'assistant', content: 'hi' },
            },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
        {},
      ),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerRequestId).toBeUndefined();
  });

  it('falls back to body.id when neither header is present', async () => {
    const http = fakeHttp(jsonResponse(200, successBody(), {}));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.providerRequestId).toBe('chatcmpl_01');
  });

  it('malformed JSON response body → provider_down', async () => {
    const http = fakeHttp({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    });
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });

  it('missing required top-level fields → provider_down', async () => {
    // no model / no usage / no choice
    const http = fakeHttp(jsonResponse(200, { id: 'x', choices: [] }));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('provider_down');
  });
});

describe('openai — error body & hint fallback heuristics', () => {
  it('non-JSON error body is tolerated (parsed stays undefined)', async () => {
    const http = fakeHttp({
      status: 401,
      headers: { 'content-type': 'text/html' },
      body: '<html>Unauthorized</html>',
    });
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: 'bad', request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_key');
  });

  it('429 with billing_hard_limit_reached code → quota_exhausted', async () => {
    const http = fakeHttp(
      jsonResponse(429, {
        error: { code: 'billing_hard_limit_reached' },
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('quota_exhausted');
  });

  it('400 with "context length" message (no code) → context_too_long', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: { message: 'This model has a maximum context length of 8192.' },
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('context_too_long');
  });

  it('400 with "maximum context" message (no code) → context_too_long', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: { message: 'Request exceeded maximum context window.' },
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('context_too_long');
  });

  it('400 with "content policy" message (no code) → content_blocked', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: { message: 'Blocked by content policy.' },
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('content_blocked');
  });

  it('400 with "safety system" message (no code) → content_blocked', async () => {
    const http = fakeHttp(
      jsonResponse(400, {
        error: { message: 'Flagged by the safety system.' },
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('content_blocked');
  });

  it('400 with unknown message (no hint) → internal per §7.1', async () => {
    const http = fakeHttp(
      jsonResponse(400, { error: { message: 'unrecognised 400' } }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('internal');
  });
});

describe('openai — retry-after header parsing', () => {
  it('429 with integer retry-after surfaces retryAfterSec', async () => {
    const http = fakeHttp(
      jsonResponse(429, { error: { code: 'rate_limit_exceeded' } }, {
        'retry-after': '42',
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ kind: 'rate_limit', retryAfterSec: 42 });
  });

  it('429 with HTTP-date retry-after in the future returns positive delta', async () => {
    const future = new Date(Date.now() + 60_000).toUTCString();
    const http = fakeHttp(
      jsonResponse(429, { error: { code: 'rate_limit_exceeded' } }, {
        'retry-after': future,
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    if (res.error.kind !== 'rate_limit') throw new Error('expected rate_limit');
    expect(res.error.retryAfterSec).toBeGreaterThan(0);
  });

  it('429 with HTTP-date retry-after in the past collapses to 0', async () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    const http = fakeHttp(
      jsonResponse(429, { error: { code: 'rate_limit_exceeded' } }, {
        'retry-after': past,
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatchObject({ kind: 'rate_limit', retryAfterSec: 0 });
  });

  it('429 with unparseable retry-after returns undefined', async () => {
    const http = fakeHttp(
      jsonResponse(429, { error: { code: 'rate_limit_exceeded' } }, {
        'retry-after': 'garbage-value',
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('rate_limit');
    if (res.error.kind !== 'rate_limit') return;
    expect(res.error.retryAfterSec).toBeUndefined();
  });
});

describe('openai — rate-limit duration parsing', () => {
  // These exercise parseDurationSec across its unit branches via ping.
  async function pingWithReset(reset: string): Promise<number | undefined> {
    const http = fakeHttp(
      jsonResponse(200, successBody(), {
        'x-ratelimit-reset-requests': reset,
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    if (!res.ok) throw new Error('ping failed');
    return res.value.rateLimitHint?.resetSec;
  }

  it('parses "500ms" → 1 (ceiled)', async () => {
    expect(await pingWithReset('500ms')).toBe(1);
  });

  it('parses "2h" → 7200', async () => {
    expect(await pingWithReset('2h')).toBe(7200);
  });

  it('parses compound "2h10m" → 7800', async () => {
    expect(await pingWithReset('2h10m')).toBe(7800);
  });

  it('parses plain integer (no unit) as seconds', async () => {
    expect(await pingWithReset('45')).toBe(45);
  });

  it('returns undefined for unparseable duration', async () => {
    expect(await pingWithReset('xx')).toBeUndefined();
  });

  it('rate-limit hint object built from only some headers', async () => {
    const http = fakeHttp(
      jsonResponse(200, successBody(), {
        'x-ratelimit-remaining-requests': '7',
        // no remaining-tokens, no reset
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.rateLimitHint).toEqual({ remainingRequests: 7 });
  });

  it('non-numeric toInt → undefined', async () => {
    const http = fakeHttp(
      jsonResponse(200, successBody(), {
        'x-ratelimit-remaining-requests': 'n/a',
        'x-ratelimit-remaining-tokens': 'n/a',
      }),
    );
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.ping({ apiKey: KEY });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.rateLimitHint).toEqual({});
  });
});

describe('openai — transport + signal composition edge cases', () => {
  it('non-HttpTransportError thrown from http client → internal', async () => {
    const fn: HttpClient = async () => {
      throw new TypeError('unexpected runtime failure');
    };
    const provider = createOpenAIProvider({
      http: fn,
      timeoutSignal: neverTimeout,
    });
    const res = await provider.call({ apiKey: KEY, request: req() });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('internal');
  });

  it('composeSignal — AbortSignal.any path (Node 20+)', async () => {
    // With an abortSignal passed in and AbortSignal.any present, the
    // fast path is taken.
    const http = fakeHttp(jsonResponse(200, successBody()));
    const provider = createOpenAIProvider({
      http: http.fn,
      timeoutSignal: neverTimeout,
    });
    const ctrl = new AbortController();
    await provider.call({ apiKey: KEY, request: req(), abortSignal: ctrl.signal });
    expect(http.received).toHaveLength(1);
    // Signal is composed; the mock simply forwarded the request.
    expect(http.received[0]!.signal).toBeDefined();
  });

  describe('composeSignal fallback (no AbortSignal.any)', () => {
    let originalAny: unknown;
    beforeEach(() => {
      originalAny = (
        AbortSignal as unknown as { any?: unknown }
      ).any;
      // Simulate an older runtime without AbortSignal.any.
      (AbortSignal as unknown as { any?: unknown }).any = undefined;
    });
    afterEach(() => {
      (AbortSignal as unknown as { any?: unknown }).any = originalAny;
    });

    it('manually composed signal still forwards to fetch', async () => {
      const http = fakeHttp(jsonResponse(200, successBody()));
      const provider = createOpenAIProvider({
        http: http.fn,
        timeoutSignal: neverTimeout,
      });
      const ctrl = new AbortController();
      await provider.call({
        apiKey: KEY,
        request: req(),
        abortSignal: ctrl.signal,
      });
      expect(http.received[0]!.signal).toBeDefined();
    });

    it('manually composed signal reflects pre-aborted secondary', async () => {
      const http = fakeHttp(jsonResponse(200, successBody()));
      const provider = createOpenAIProvider({
        http: http.fn,
        timeoutSignal: neverTimeout,
      });
      const ctrl = new AbortController();
      ctrl.abort(); // pre-aborted before the composition
      await provider.call({
        apiKey: KEY,
        request: req(),
        abortSignal: ctrl.signal,
      });
      expect(http.received[0]!.signal?.aborted).toBe(true);
    });
  });
});

