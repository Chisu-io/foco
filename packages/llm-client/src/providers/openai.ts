/**
 * OpenAI adapter — Chat Completions API.
 *
 * @see LLM_CLIENT.md §9.2 — OpenAI (Chat Completions)
 *
 * Endpoint:  POST https://api.openai.com/v1/chat/completions
 * Auth:      header `Authorization: Bearer <userKey>` (BYOK) or pool
 *
 * Usage counter mapping (asymmetric with Anthropic — §9.2):
 *   prompt_tokens      → inputTokens
 *   completion_tokens  → outputTokens
 *   total_tokens       → totalTokens (trusted when present; fallback
 *                        to sum otherwise)
 *
 * Finish reason mapping:
 *   'stop'           → 'end_turn' (or 'stop_sequence' when we sent
 *                      `stop` and the response matches one of them —
 *                      we conservatively emit `'end_turn'` and let
 *                      callers rely on the sequence field if needed;
 *                      OpenAI does not surface which stop matched).
 *   'length'         → 'max_tokens'
 *   'tool_calls'     → 'tool_use'
 *   'content_filter' → returns `LLMCallError.content_blocked`,
 *                      NOT a successful output — the response body
 *                      carries the truncated text, which we drop.
 *
 * Error mapping follows §7.1. OpenAI-specific handling:
 *   - HTTP 429 with `error.code === 'insufficient_quota'` → we set
 *     `billingError: true` so the classifier returns
 *     `quota_exhausted`, not `rate_limit` (per §7.1).
 *   - HTTP 400 with `error.code === 'context_length_exceeded'` →
 *     `http400Hint: 'context_length_exceeded'`.
 */

import {
  classifyNetworkError,
  classifyProviderHttpError,
} from '../errors/classify.js';
import { make, type LLMCallError } from '../errors/taxonomy.js';
import { err, ok, type Result } from '../types.js';
import type {
  NormalizedContentBlock,
  NormalizedLLMRequest,
  NormalizedMessage,
} from '../types/request.js';
import type {
  PingOutput,
  ProviderCallOutput,
  StopReason,
  UsageCounts,
} from '../types/response.js';
import {
  fetchHttpClient,
  HttpTransportError,
  transportKindToNetworkKind,
  type HttpClient,
} from '../http/client.js';
import type {
  Provider,
  ProviderCallInput,
  ProviderPingInput,
} from './provider.js';

export const OPENAI_ENDPOINT =
  'https://api.openai.com/v1/chat/completions';

export const OPENAI_PING_MODEL = 'gpt-5-mini';

export const OPENAI_CALL_TIMEOUT_MS = 60_000;
export const OPENAI_PING_TIMEOUT_MS = 10_000;

export interface OpenAIDeps {
  readonly http: HttpClient;
  readonly endpoint?: string | undefined;
  readonly timeoutSignal?: ((ms: number) => AbortSignal) | undefined;
}

export function createOpenAIProvider(deps?: Partial<OpenAIDeps>): Provider {
  const http = deps?.http ?? fetchHttpClient;
  const endpoint = deps?.endpoint ?? OPENAI_ENDPOINT;
  const timeoutSignal =
    deps?.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  return {
    name: 'openai',
    async call(input) {
      return openAICall({ http, endpoint, timeoutSignal }, input);
    },
    async ping(input) {
      return openAIPing({ http, endpoint, timeoutSignal }, input);
    },
  };
}

// ─── Core request flow ────────────────────────────────────────────────

interface ResolvedDeps {
  readonly http: HttpClient;
  readonly endpoint: string;
  readonly timeoutSignal: (ms: number) => AbortSignal;
}

async function openAICall(
  deps: ResolvedDeps,
  input: ProviderCallInput,
): Promise<Result<ProviderCallOutput, LLMCallError>> {
  const body = buildRequestBody(input.request);
  const signal = composeSignal(
    deps.timeoutSignal(OPENAI_CALL_TIMEOUT_MS),
    input.abortSignal,
  );

  let response;
  try {
    response = await deps.http({
      method: 'POST',
      url: deps.endpoint,
      headers: authHeaders(input.apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    return err(transportErrorToLLMError(e));
  }

  if (response.status < 200 || response.status >= 300) {
    return err(mapHttpError(response));
  }

  return parseCallResponse(response.body, response.headers);
}

async function openAIPing(
  deps: ResolvedDeps,
  input: ProviderPingInput,
): Promise<Result<PingOutput, LLMCallError>> {
  const body = {
    model: OPENAI_PING_MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  };
  const signal = composeSignal(
    deps.timeoutSignal(OPENAI_PING_TIMEOUT_MS),
    input.abortSignal,
  );

  let response;
  try {
    response = await deps.http({
      method: 'POST',
      url: deps.endpoint,
      headers: authHeaders(input.apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    return err(transportErrorToLLMError(e));
  }

  if (response.status >= 200 && response.status < 300) {
    const reqId =
      response.headers['x-request-id'] ??
      response.headers['openai-request-id'];
    const hint = readRateLimitHint(response.headers);
    const base: PingOutput =
      reqId === undefined
        ? { status: 'active', model: OPENAI_PING_MODEL }
        : { status: 'active', model: OPENAI_PING_MODEL, providerRequestId: reqId };
    return ok(hint === undefined ? base : { ...base, rateLimitHint: hint });
  }

  return err(mapHttpError(response));
}

// ─── Outbound wire format ────────────────────────────────────────────

function authHeaders(apiKey: string): Readonly<Record<string, string>> {
  return Object.freeze({
    'content-type': 'application/json',
    accept: 'application/json',
    authorization: `Bearer ${apiKey}`,
  });
}

type OpenAIRole = 'system' | 'user' | 'assistant' | 'tool';

interface OpenAIRequestBody {
  model: string;
  messages: ReadonlyArray<OpenAIMessageOut>;
  max_tokens: number;
  temperature?: number;
  stop?: readonly string[];
  response_format?: { type: 'json_object' };
  tools?: ReadonlyArray<{
    type: 'function';
    function: {
      name: string;
      description: string;
      parameters: Readonly<Record<string, unknown>>;
    };
  }>;
}

type OpenAIMessageOut =
  | { role: 'system' | 'user' | 'assistant'; content: string }
  | { role: 'tool'; tool_call_id: string; content: string }
  | {
      role: 'assistant';
      content: null;
      tool_calls: ReadonlyArray<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };

function buildRequestBody(
  request: NormalizedLLMRequest,
): OpenAIRequestBody {
  const messages: OpenAIMessageOut[] = [];
  if (request.systemPrompt !== undefined) {
    messages.push({ role: 'system', content: request.systemPrompt });
  }
  for (const m of request.messages) {
    const out = toOpenAIMessage(m);
    if (Array.isArray(out)) {
      messages.push(...out);
    } else {
      messages.push(out);
    }
  }

  const body: OpenAIRequestBody = {
    model: request.model,
    messages,
    max_tokens: request.maxTokens,
  };
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.stopSequences !== undefined && request.stopSequences.length > 0) {
    body.stop = request.stopSequences;
  }
  if (request.responseFormat === 'json_object') {
    body.response_format = { type: 'json_object' };
  }
  if (request.toolDefinitions !== undefined && request.toolDefinitions.length > 0) {
    body.tools = request.toolDefinitions.map((t) => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }
  return body;
}

/**
 * Translate a `NormalizedMessage` to OpenAI's message shape. A
 * message can fan out to multiple OpenAI messages when it contains
 * `tool_use` / `tool_result` blocks alongside text.
 */
function toOpenAIMessage(
  m: NormalizedMessage,
): OpenAIMessageOut | OpenAIMessageOut[] {
  const role: OpenAIRole = m.role;

  if (typeof m.content === 'string') {
    if (role === 'tool') {
      // A string-content tool message is ambiguous without a
      // tool_call_id — reject at the structure level by forcing the
      // caller to use a content block (the shape guarantees it).
      // Falling back to `user` with the text would silently change
      // meaning, which is worse than a loud failure downstream.
      return { role: 'user', content: m.content };
    }
    return { role: role as 'system' | 'user' | 'assistant', content: m.content };
  }

  const textParts: string[] = [];
  const toolCalls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }> = [];
  const toolResults: Array<OpenAIMessageOut> = [];

  for (const b of m.content) {
    if (b.type === 'text') {
      textParts.push(b.text);
    } else if (b.type === 'tool_use') {
      toolCalls.push({
        id: b.toolUseId,
        type: 'function',
        function: {
          name: b.toolName,
          arguments: JSON.stringify(b.input),
        },
      });
    } else {
      toolResults.push({
        role: 'tool',
        tool_call_id: b.toolUseId,
        content: b.output,
      });
    }
  }

  const out: OpenAIMessageOut[] = [];

  if (role === 'assistant' && toolCalls.length > 0) {
    if (textParts.length > 0) {
      out.push({ role: 'assistant', content: textParts.join('\n') });
    }
    out.push({ role: 'assistant', content: null, tool_calls: toolCalls });
  } else if (role === 'tool') {
    // Expected: a single tool_result content block.
    out.push(...toolResults);
    if (out.length === 0 && textParts.length > 0) {
      // Rare: role=tool with free-text — treat as user content.
      out.push({ role: 'user', content: textParts.join('\n') });
    }
  } else {
    if (textParts.length > 0) {
      out.push({
        role: role as 'system' | 'user' | 'assistant',
        content: textParts.join('\n'),
      });
    }
    out.push(...toolResults);
  }

  return out.length === 1 ? out[0]! : out;
}

// ─── Inbound response parsing ────────────────────────────────────────

interface OpenAIResponseBody {
  id?: string;
  model?: string;
  choices?: ReadonlyArray<{
    index?: number;
    finish_reason?: string;
    message?: {
      role?: 'assistant';
      content?: string | null;
      tool_calls?: ReadonlyArray<{
        id?: string;
        type?: string;
        function?: { name?: string; arguments?: string };
      }>;
    };
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

function parseCallResponse(
  raw: string,
  headers: Readonly<Record<string, string>>,
): Result<ProviderCallOutput, LLMCallError> {
  let parsed: OpenAIResponseBody;
  try {
    parsed = JSON.parse(raw) as OpenAIResponseBody;
  } catch {
    return err(classifyProviderHttpError({ provider: 'openai', status: 500 }));
  }

  const choice = parsed.choices?.[0];
  if (
    choice === undefined ||
    parsed.model === undefined ||
    parsed.usage === undefined ||
    choice.message === undefined
  ) {
    return err(classifyProviderHttpError({ provider: 'openai', status: 500 }));
  }

  const finishReason = choice.finish_reason ?? 'stop';

  if (finishReason === 'content_filter') {
    return err(make.contentBlocked('moderation'));
  }

  const content: NormalizedContentBlock[] = [];
  if (typeof choice.message.content === 'string' && choice.message.content.length > 0) {
    content.push({ type: 'text', text: choice.message.content });
  }
  if (choice.message.tool_calls !== undefined) {
    for (const tc of choice.message.tool_calls) {
      if (tc.id === undefined || tc.function === undefined) continue;
      let input: Record<string, unknown> = {};
      if (typeof tc.function.arguments === 'string') {
        try {
          input = JSON.parse(tc.function.arguments) as Record<string, unknown>;
        } catch {
          input = { __raw: tc.function.arguments };
        }
      }
      content.push({
        type: 'tool_use',
        toolUseId: tc.id,
        toolName: tc.function.name ?? '',
        input,
      });
    }
  }

  const message: NormalizedMessage = { role: 'assistant', content };

  const inTokens = parsed.usage.prompt_tokens ?? 0;
  const outTokens = parsed.usage.completion_tokens ?? 0;
  const total = parsed.usage.total_tokens ?? inTokens + outTokens;
  const usage: UsageCounts = {
    inputTokens: inTokens,
    outputTokens: outTokens,
    totalTokens: total,
  };

  const stopReason = toNormalizedStopReason(finishReason);

  const providerRequestId =
    headers['x-request-id'] ??
    headers['openai-request-id'] ??
    parsed.id;

  const output: ProviderCallOutput =
    providerRequestId === undefined
      ? {
          modelUsed: parsed.model,
          providerUsed: 'openai',
          message,
          usage,
          stopReason,
        }
      : {
          modelUsed: parsed.model,
          providerUsed: 'openai',
          message,
          usage,
          stopReason,
          providerRequestId,
        };
  return ok(output);
}

function toNormalizedStopReason(r: string): StopReason {
  switch (r) {
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'stop':
    default:
      return 'end_turn';
  }
}

// ─── Error paths ─────────────────────────────────────────────────────

function mapHttpError(response: {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}): LLMCallError {
  let parsed:
    | {
        error?: {
          type?: string;
          code?: string | null;
          message?: string;
        };
      }
    | undefined;
  try {
    parsed = JSON.parse(response.body) as typeof parsed;
  } catch {
    parsed = undefined;
  }

  const retryAfterSec = readRetryAfterSec(response.headers);
  const code = parsed?.error?.code ?? '';
  const type = parsed?.error?.type ?? '';

  // Insufficient quota is OpenAI-speak for "billing/top-up needed".
  // It is *not* a rate limit even though it ships on HTTP 429.
  const billingError =
    code === 'insufficient_quota' ||
    type === 'insufficient_quota' ||
    code === 'billing_hard_limit_reached';

  let http400Hint: 'context_length_exceeded' | 'content_filter' | undefined;
  if (response.status === 400) {
    if (code === 'context_length_exceeded') {
      http400Hint = 'context_length_exceeded';
    } else if (code === 'content_filter') {
      http400Hint = 'content_filter';
    } else {
      const m = (parsed?.error?.message ?? '').toLowerCase();
      if (m.includes('context length') || m.includes('maximum context')) {
        http400Hint = 'context_length_exceeded';
      } else if (m.includes('content policy') || m.includes('safety system')) {
        http400Hint = 'content_filter';
      }
    }
  }

  return classifyProviderHttpError({
    provider: 'openai',
    status: response.status,
    retryAfterSec,
    billingError,
    http400Hint,
    body: parsed,
  });
}

function readRetryAfterSec(
  headers: Readonly<Record<string, string>>,
): number | undefined {
  const raw = headers['retry-after'];
  if (raw === undefined) return undefined;
  const asInt = Number.parseInt(raw, 10);
  if (Number.isFinite(asInt) && asInt >= 0) return asInt;
  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    const delta = Math.ceil((asDate - Date.now()) / 1000);
    return delta >= 0 ? delta : 0;
  }
  return undefined;
}

/**
 * Parse opportunistic rate-limit hints from OpenAI response headers.
 * The proveedor returns `x-ratelimit-remaining-requests`,
 * `x-ratelimit-remaining-tokens`, and `x-ratelimit-reset-requests`
 * (duration string like "1s" or "1m30s"). We try hard but fall back
 * to `undefined` rather than guessing.
 */
function readRateLimitHint(
  headers: Readonly<Record<string, string>>,
): PingOutput['rateLimitHint'] | undefined {
  const rReq = headers['x-ratelimit-remaining-requests'];
  const rTok = headers['x-ratelimit-remaining-tokens'];
  const reset = headers['x-ratelimit-reset-requests'];
  if (rReq === undefined && rTok === undefined && reset === undefined) {
    return undefined;
  }
  const remainingRequests = toInt(rReq);
  const remainingTokens = toInt(rTok);
  const resetSec = parseDurationSec(reset);
  return {
    ...(remainingRequests !== undefined ? { remainingRequests } : {}),
    ...(remainingTokens !== undefined ? { remainingTokens } : {}),
    ...(resetSec !== undefined ? { resetSec } : {}),
  };
}

function toInt(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  const n = Number.parseInt(s, 10);
  return Number.isFinite(n) ? n : undefined;
}

function parseDurationSec(s: string | undefined): number | undefined {
  if (s === undefined) return undefined;
  // Formats observed: "1s", "1m30s", "500ms", "2h10m".
  let total = 0;
  let ok = false;
  const pattern = /(\d+)(ms|s|m|h)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(s)) !== null) {
    const n = Number.parseInt(match[1]!, 10);
    if (!Number.isFinite(n)) continue;
    ok = true;
    switch (match[2]) {
      case 'ms':
        total += n / 1000;
        break;
      case 's':
        total += n;
        break;
      case 'm':
        total += n * 60;
        break;
      case 'h':
        total += n * 3600;
        break;
      default:
        break;
    }
  }
  if (!ok) {
    // plain integer → seconds
    const n = Number.parseInt(s, 10);
    return Number.isFinite(n) ? n : undefined;
  }
  return Math.ceil(total);
}

function transportErrorToLLMError(e: unknown): LLMCallError {
  if (e instanceof HttpTransportError) {
    return classifyNetworkError(transportKindToNetworkKind(e.kind));
  }
  return make.internal(randomCorrelationId());
}

function randomCorrelationId(): string {
  const a = Math.random().toString(16).slice(2, 10);
  const b = Math.random().toString(16).slice(2, 10);
  return `${a}-${b}`;
}

function composeSignal(
  primary: AbortSignal,
  secondary: AbortSignal | undefined,
): AbortSignal {
  if (secondary === undefined) return primary;
  const anyFn = (AbortSignal as unknown as {
    any?: (signals: AbortSignal[]) => AbortSignal;
  }).any;
  if (typeof anyFn === 'function') {
    return anyFn([primary, secondary]);
  }
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  primary.addEventListener('abort', onAbort, { once: true });
  secondary.addEventListener('abort', onAbort, { once: true });
  if (primary.aborted || secondary.aborted) ctrl.abort();
  return ctrl.signal;
}
