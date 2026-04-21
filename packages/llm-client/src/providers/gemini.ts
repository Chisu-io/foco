/**
 * Google Gemini adapter — AI Studio `generateContent`.
 *
 * @see LLM_CLIENT.md §9.3 — Gemini (AI Studio)
 *
 * Endpoint:  POST https://generativelanguage.googleapis.com
 *                 /v1beta/models/{model}:generateContent
 * Auth:      header `x-goog-api-key: <userKey>`  (NEVER query param —
 *            contract §2 invariant 1: key material must not appear in
 *            access logs / URLs). BYOK or pool key.
 *
 * Usage counter mapping (§8.1 – §9.3):
 *   usageMetadata.promptTokenCount      → inputTokens
 *   usageMetadata.candidatesTokenCount  → outputTokens
 *   usageMetadata.totalTokenCount       → totalTokens (trusted when
 *                                         present; fallback to sum)
 *
 * FinishReason mapping:
 *   'STOP'       → 'end_turn'
 *   'MAX_TOKENS' → 'max_tokens'
 *   'SAFETY'     → returns `LLMCallError.content_blocked { reason:'safety' }`
 *   'RECITATION' → returns `LLMCallError.content_blocked { reason:'safety' }`
 *   'OTHER'      → 'end_turn' (safe default; we did get content)
 *
 * Wire-format quirks handled here:
 *   - Role translation: `assistant` → `'model'`; `tool` messages fan
 *     out into `functionResponse` parts attached to a `'user'` turn
 *     (Gemini has no dedicated tool role).
 *   - `systemPrompt` is NOT a message — it lives in `systemInstruction`.
 *   - `stopSequences`, `temperature`, `maxOutputTokens` live inside
 *     `generationConfig`, not at the top level.
 *   - Tools are wrapped in a single `{functionDeclarations: [...]}`
 *     container rather than an array of tools.
 *
 * Error mapping follows §7.1 via `classifyProviderHttpError`. Gemini
 * returns `{error:{code, message, status}}` with `status` an enum
 * string (INVALID_ARGUMENT / RESOURCE_EXHAUSTED / PERMISSION_DENIED /
 * UNAUTHENTICATED / INTERNAL / UNAVAILABLE). We translate:
 *   - status 400 + message mentions "API key not valid" → invalid_key
 *     (Google returns 400, not 401, for bad keys).
 *   - status 401 / UNAUTHENTICATED → invalid_key.
 *   - status 403 / PERMISSION_DENIED → invalid_key unless billing
 *     keyword in message, in which case quota_exhausted.
 *   - status 429 / RESOURCE_EXHAUSTED → rate_limit unless billing
 *     keyword, in which case quota_exhausted (billingError=true).
 *   - status 400 + context keyword → context_length_exceeded.
 *   - status 400 + safety / blocked keyword → content_filter.
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

/** Base URL; `{model}:generateContent` is appended per request. */
export const GEMINI_ENDPOINT_BASE =
  'https://generativelanguage.googleapis.com/v1beta/models';

/** Cheapest model used by `ping`. */
export const GEMINI_PING_MODEL = 'gemini-2.5-flash';

/** Per-call timeout (60s per §7.1 timeout row). */
export const GEMINI_CALL_TIMEOUT_MS = 60_000;

/** Per-ping timeout — pings must be snappy. */
export const GEMINI_PING_TIMEOUT_MS = 10_000;

export interface GeminiDeps {
  readonly http: HttpClient;
  /**
   * Override the endpoint base (without the trailing slash). Default
   * is {@link GEMINI_ENDPOINT_BASE}. Exposed so contract tests can
   * point at a loopback URL instead of `generativelanguage.googleapis.com`.
   */
  readonly endpointBase?: string | undefined;
  readonly timeoutSignal?: ((ms: number) => AbortSignal) | undefined;
}

// ─── Public factory ───────────────────────────────────────────────────

export function createGeminiProvider(deps?: Partial<GeminiDeps>): Provider {
  const http = deps?.http ?? fetchHttpClient;
  const endpointBase = deps?.endpointBase ?? GEMINI_ENDPOINT_BASE;
  const timeoutSignal =
    deps?.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  return {
    name: 'gemini',
    async call(input) {
      return geminiCall({ http, endpointBase, timeoutSignal }, input);
    },
    async ping(input) {
      return geminiPing({ http, endpointBase, timeoutSignal }, input);
    },
  };
}

// ─── Core request flow ────────────────────────────────────────────────

interface ResolvedDeps {
  readonly http: HttpClient;
  readonly endpointBase: string;
  readonly timeoutSignal: (ms: number) => AbortSignal;
}

async function geminiCall(
  deps: ResolvedDeps,
  input: ProviderCallInput,
): Promise<Result<ProviderCallOutput, LLMCallError>> {
  const body = buildRequestBody(input.request);
  const url = buildEndpoint(deps.endpointBase, input.request.model);
  const signal = composeSignal(
    deps.timeoutSignal(GEMINI_CALL_TIMEOUT_MS),
    input.abortSignal,
  );

  // Iter 6 commit 2 (P11): `input.correlationId` is REQUIRED on
  // `ProviderCallInput` for every adapter, but Gemini intentionally
  // does NOT emit a trace header. Google AI Studio's
  // generateContent endpoint has no documented client-supplied
  // request-id header — sending an unspecified one risks leaking
  // into access logs in a way that downstream tooling cannot
  // interpret. The router/orchestrator still uses the correlation
  // id for the provider sub-span (iter 6 commit 3) and for any
  // `internal` error minted on this call path.
  void input.correlationId;

  let response;
  try {
    response = await deps.http({
      method: 'POST',
      url,
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

  return parseCallResponse(response.body, response.headers, input.request.model);
}

async function geminiPing(
  deps: ResolvedDeps,
  input: ProviderPingInput,
): Promise<Result<PingOutput, LLMCallError>> {
  const body = {
    contents: [{ role: 'user' as const, parts: [{ text: 'hi' }] }],
    generationConfig: { maxOutputTokens: 1 },
  };
  const url = buildEndpoint(deps.endpointBase, GEMINI_PING_MODEL);
  const signal = composeSignal(
    deps.timeoutSignal(GEMINI_PING_TIMEOUT_MS),
    input.abortSignal,
  );

  let response;
  try {
    response = await deps.http({
      method: 'POST',
      url,
      headers: authHeaders(input.apiKey),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    return err(transportErrorToLLMError(e));
  }

  if (response.status >= 200 && response.status < 300) {
    // Google surfaces an opaque server trace id in `x-goog-request-id`
    // (sometimes `x-request-id`); surfacing it helps correlate with
    // support cases when a user hits an edge-case error later.
    const reqId =
      response.headers['x-goog-request-id'] ??
      response.headers['x-request-id'];
    const pong: PingOutput =
      reqId === undefined
        ? { status: 'active', model: GEMINI_PING_MODEL }
        : { status: 'active', model: GEMINI_PING_MODEL, providerRequestId: reqId };
    return ok(pong);
  }

  return err(mapHttpError(response));
}

// ─── Outbound wire format ────────────────────────────────────────────

function buildEndpoint(base: string, model: string): string {
  // Strip trailing slash so callers supplying either form get the
  // same result; then glue the per-model suffix.
  const clean = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${clean}/${encodeURIComponent(model)}:generateContent`;
}

function authHeaders(apiKey: string): Readonly<Record<string, string>> {
  return Object.freeze({
    'content-type': 'application/json',
    accept: 'application/json',
    // Per §2 invariant 1, the key MUST travel in a header (never in
    // the URL / query string) so it does not hit access logs.
    'x-goog-api-key': apiKey,
  });
}

type GeminiRole = 'user' | 'model';

type GeminiPartOut =
  | { text: string }
  | {
      functionCall: {
        name: string;
        args: Readonly<Record<string, unknown>>;
      };
    }
  | {
      functionResponse: {
        name: string;
        response: Readonly<Record<string, unknown>>;
      };
    };

interface GeminiContentOut {
  role: GeminiRole;
  parts: readonly GeminiPartOut[];
}

interface GeminiGenerationConfig {
  maxOutputTokens: number;
  temperature?: number;
  stopSequences?: readonly string[];
  responseMimeType?: string;
}

interface GeminiRequestBody {
  contents: readonly GeminiContentOut[];
  systemInstruction?: { parts: readonly [{ text: string }] };
  generationConfig: GeminiGenerationConfig;
  tools?: readonly [
    {
      functionDeclarations: ReadonlyArray<{
        name: string;
        description: string;
        parameters: Readonly<Record<string, unknown>>;
      }>;
    },
  ];
}

function buildRequestBody(
  request: NormalizedLLMRequest,
): GeminiRequestBody {
  const contents: GeminiContentOut[] = [];
  for (const m of request.messages) {
    const out = toGeminiContent(m);
    if (out !== undefined) contents.push(out);
  }

  const generationConfig: GeminiGenerationConfig = {
    maxOutputTokens: request.maxTokens,
  };
  if (request.temperature !== undefined) {
    generationConfig.temperature = request.temperature;
  }
  if (
    request.stopSequences !== undefined &&
    request.stopSequences.length > 0
  ) {
    generationConfig.stopSequences = request.stopSequences;
  }
  if (request.responseFormat === 'json_object') {
    // Gemini's canonical knob for structured output.
    generationConfig.responseMimeType = 'application/json';
  }

  const body: GeminiRequestBody = {
    contents,
    generationConfig,
  };

  if (request.systemPrompt !== undefined) {
    body.systemInstruction = { parts: [{ text: request.systemPrompt }] };
  }

  if (
    request.toolDefinitions !== undefined &&
    request.toolDefinitions.length > 0
  ) {
    body.tools = [
      {
        functionDeclarations: request.toolDefinitions.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        })),
      },
    ];
  }

  return body;
}

/**
 * Translate a `NormalizedMessage` to a Gemini `contents[]` entry.
 *
 *  - `assistant` → `'model'`
 *  - `tool`      → `'user'` turn carrying `functionResponse` parts.
 *    Gemini fuses tool returns into the next user turn, matching the
 *    "tools are multi-turn user inputs" mental model.
 *
 * Returns `undefined` for an empty message so the output stays tight.
 */
function toGeminiContent(
  m: NormalizedMessage,
): GeminiContentOut | undefined {
  const role: GeminiRole = m.role === 'assistant' ? 'model' : 'user';

  if (typeof m.content === 'string') {
    if (m.content.length === 0) return undefined;
    return { role, parts: [{ text: m.content }] };
  }

  const parts: GeminiPartOut[] = [];
  for (const b of m.content) {
    const p = toGeminiPart(b);
    if (p !== undefined) parts.push(p);
  }
  if (parts.length === 0) return undefined;
  return { role, parts };
}

function toGeminiPart(
  b: NormalizedContentBlock,
): GeminiPartOut | undefined {
  switch (b.type) {
    case 'text':
      return b.text.length === 0 ? undefined : { text: b.text };
    case 'tool_use':
      return {
        functionCall: {
          name: b.toolName,
          args: b.input,
        },
      };
    case 'tool_result':
      // Gemini expects a structured response object. Our normalised
      // `output` is a string; wrap it in a stable envelope so the
      // model can still read it and the adapter does not need to
      // guess at schemas.
      return {
        functionResponse: {
          // Gemini matches tool results to calls via `name`; the
          // caller is responsible for tracking which call a result
          // belongs to since our `toolUseId` has no first-class
          // equivalent in Gemini's wire format.
          name: b.toolUseId,
          response: { output: b.output },
        },
      };
  }
}

// ─── Inbound response parsing ────────────────────────────────────────

type GeminiFinishReason =
  | 'STOP'
  | 'MAX_TOKENS'
  | 'SAFETY'
  | 'RECITATION'
  | 'OTHER'
  | 'FINISH_REASON_UNSPECIFIED'
  | string;

type GeminiPartIn =
  | { text?: string }
  | {
      functionCall?: {
        name?: string;
        args?: Record<string, unknown>;
      };
    };

interface GeminiResponseBody {
  candidates?: ReadonlyArray<{
    content?: {
      role?: string;
      parts?: ReadonlyArray<GeminiPartIn>;
    };
    finishReason?: GeminiFinishReason;
    index?: number;
  }>;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    totalTokenCount?: number;
  };
  modelVersion?: string;
  promptFeedback?: {
    blockReason?: string;
  };
}

function parseCallResponse(
  raw: string,
  headers: Readonly<Record<string, string>>,
  requestedModel: string,
): Result<ProviderCallOutput, LLMCallError> {
  let parsed: GeminiResponseBody;
  try {
    parsed = JSON.parse(raw) as GeminiResponseBody;
  } catch {
    return err(classifyProviderHttpError({ provider: 'gemini', status: 500 }));
  }

  // `promptFeedback.blockReason` means Gemini rejected the *prompt*
  // before producing any candidates. Treat as content blocked.
  const promptBlock = parsed.promptFeedback?.blockReason;
  if (
    promptBlock !== undefined &&
    promptBlock.length > 0 &&
    promptBlock !== 'BLOCK_REASON_UNSPECIFIED'
  ) {
    return err(make.contentBlocked('safety'));
  }

  const candidate = parsed.candidates?.[0];
  if (candidate === undefined || parsed.usageMetadata === undefined) {
    return err(classifyProviderHttpError({ provider: 'gemini', status: 500 }));
  }

  const finish = candidate.finishReason ?? 'STOP';

  if (finish === 'SAFETY' || finish === 'RECITATION') {
    // §9.3: Gemini returns a 200 with truncated content when safety
    // filters trip. Contract treats it as a failed call, not a success
    // with empty text, so callers cannot mistake it for a normal
    // response.
    return err(make.contentBlocked('safety'));
  }

  const partsIn = candidate.content?.parts ?? [];
  const content: NormalizedContentBlock[] = [];
  for (const p of partsIn) {
    if ('text' in p && typeof p.text === 'string' && p.text.length > 0) {
      content.push({ type: 'text', text: p.text });
    } else if (
      'functionCall' in p &&
      p.functionCall !== undefined &&
      typeof p.functionCall.name === 'string'
    ) {
      content.push({
        type: 'tool_use',
        // Gemini has no per-call id; synthesise one from the function
        // name plus an ordinal so results can be correlated back.
        toolUseId: `${p.functionCall.name}-${content.length}`,
        toolName: p.functionCall.name,
        input: p.functionCall.args ?? {},
      });
    }
  }

  const message: NormalizedMessage = { role: 'assistant', content };

  const inTokens = parsed.usageMetadata.promptTokenCount ?? 0;
  const outTokens = parsed.usageMetadata.candidatesTokenCount ?? 0;
  const total =
    parsed.usageMetadata.totalTokenCount ?? inTokens + outTokens;
  const usage: UsageCounts = {
    inputTokens: inTokens,
    outputTokens: outTokens,
    totalTokens: total,
  };

  const stopReason = toNormalizedStopReason(
    finish,
    content.some((b) => b.type === 'tool_use'),
  );

  const providerRequestId =
    headers['x-goog-request-id'] ?? headers['x-request-id'];

  // Gemini echoes `modelVersion` in some responses — prefer it so the
  // logged `modelUsed` reflects the concrete build, else fall back to
  // the model the caller requested.
  const modelUsed = parsed.modelVersion ?? requestedModel;

  const output: ProviderCallOutput =
    providerRequestId === undefined
      ? {
          modelUsed,
          providerUsed: 'gemini',
          message,
          usage,
          stopReason,
        }
      : {
          modelUsed,
          providerUsed: 'gemini',
          message,
          usage,
          stopReason,
          providerRequestId,
        };
  return ok(output);
}

/**
 * Map Gemini finishReason to our normalised set.
 *
 * Note: Gemini does not surface a `tool_use`-equivalent finish reason.
 * When the candidate carries `functionCall` parts, the finish reason
 * is 'STOP' — we upgrade it to `'tool_use'` so downstream routers can
 * decide whether to loop.
 */
function toNormalizedStopReason(
  r: GeminiFinishReason,
  hasToolUse: boolean,
): StopReason {
  if (hasToolUse && (r === 'STOP' || r === 'FINISH_REASON_UNSPECIFIED')) {
    return 'tool_use';
  }
  switch (r) {
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'STOP':
    case 'OTHER':
    case 'FINISH_REASON_UNSPECIFIED':
    default:
      return 'end_turn';
  }
}

// ─── Error paths ─────────────────────────────────────────────────────

interface GeminiErrorBody {
  error?: {
    code?: number;
    message?: string;
    status?: string;
    details?: unknown;
  };
}

function mapHttpError(response: {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: string;
}): LLMCallError {
  let parsed: GeminiErrorBody | undefined;
  try {
    parsed = JSON.parse(response.body) as GeminiErrorBody;
  } catch {
    parsed = undefined;
  }

  const retryAfterSec = readRetryAfterSec(response.headers);
  const apiStatus = parsed?.error?.status ?? '';
  const message = (parsed?.error?.message ?? '').toLowerCase();

  // Google surfaces bad keys as HTTP 400 with message "API key not
  // valid" OR HTTP 401 (UNAUTHENTICATED). Both collapse to invalid_key
  // before the generic classifier touches them — otherwise a 400 would
  // land as `internal` via §7.1's unknown-400 fallback.
  const looksLikeBadKey =
    apiStatus === 'UNAUTHENTICATED' ||
    (response.status === 400 &&
      (message.includes('api key not valid') ||
        message.includes('api key') ||
        message.includes('invalid authentication'))) ||
    response.status === 401;

  if (looksLikeBadKey) {
    return make.invalidKey('gemini');
  }

  // PERMISSION_DENIED: either the key lacks the API, the project has
  // no billing set up, or the account is suspended. We inspect the
  // message to decide between invalid_key and quota_exhausted.
  if (response.status === 403 || apiStatus === 'PERMISSION_DENIED') {
    if (
      message.includes('billing') ||
      message.includes('quota') ||
      message.includes('consumer has been suspended') ||
      message.includes('payment')
    ) {
      return make.quotaExhausted('gemini');
    }
    return make.invalidKey('gemini');
  }

  // RESOURCE_EXHAUSTED: may be per-minute throttle (rate_limit) OR
  // daily/billing quota depletion (quota_exhausted). Keyword scan.
  let billingError = false;
  if (response.status === 429 || apiStatus === 'RESOURCE_EXHAUSTED') {
    if (
      message.includes('billing') ||
      message.includes('free tier') ||
      message.includes('free quota') ||
      message.includes('daily') ||
      message.includes('exceeded your current quota')
    ) {
      billingError = true;
    }
  }

  // HTTP 400 classification — context vs. safety vs. unknown.
  let http400Hint: 'context_length_exceeded' | 'content_filter' | undefined;
  if (response.status === 400 || apiStatus === 'INVALID_ARGUMENT') {
    if (
      message.includes('context length') ||
      message.includes('input token') ||
      message.includes('too long') ||
      message.includes('maximum number of tokens') ||
      message.includes('context window')
    ) {
      http400Hint = 'context_length_exceeded';
    } else if (
      message.includes('safety') ||
      message.includes('blocked') ||
      message.includes('harm_category') ||
      message.includes('content policy')
    ) {
      http400Hint = 'content_filter';
    }
  }

  return classifyProviderHttpError({
    provider: 'gemini',
    status: response.status,
    retryAfterSec,
    billingError,
    http400Hint,
    contentBlockReason: 'safety',
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

// ─── Signal composition ──────────────────────────────────────────────

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
