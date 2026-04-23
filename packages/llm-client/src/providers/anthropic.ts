/**
 * Anthropic adapter — Messages API.
 *
 * @see LLM_CLIENT.md §9.1 — Anthropic (Messages API)
 *
 * Endpoint:  POST https://api.anthropic.com/v1/messages
 * Auth:      header `x-api-key: <userKey>` (BYOK) or pool key
 * Version:   header `anthropic-version: 2023-06-01`
 *
 * Usage counter mapping:
 *   input_tokens   → inputTokens
 *   output_tokens  → outputTokens
 *   (sum)          → totalTokens
 *
 * Stop reason mapping (response `stop_reason`):
 *   'end_turn'      → 'end_turn'
 *   'max_tokens'    → 'max_tokens'
 *   'stop_sequence' → 'stop_sequence'
 *   'tool_use'      → 'tool_use'
 *   anything else   → 'end_turn' (safe default; `internal` error
 *                     is wrong — we did get a valid completion).
 *
 * Error mapping follows §7.1 via `classifyProviderHttpError`. The
 * only Anthropic-specific handling:
 *   - HTTP 400 with `error.type === 'invalid_request_error'` and
 *     message mentioning "context" or "max_tokens" →
 *     `http400Hint: 'context_length_exceeded'`.
 *   - HTTP 400 with `error.type === 'invalid_request_error'` and
 *     message mentioning "content policy" / "safety" →
 *     `http400Hint: 'content_filter'`.
 *   - HTTP 529 (overloaded) → mapped to `provider_down` by passing
 *     status 503 to the classifier (same semantics).
 */

import { classifyNetworkError } from '../errors/classify.js';
import { classifyProviderHttpError } from '../errors/classify.js';
import { make, type LLMCallError } from '../errors/taxonomy.js';
import {
  fetchHttpClient,
  HttpTransportError,
  transportKindToNetworkKind,
  type HttpClient,
} from '../http/client.js';
import { err, ok, type Result } from '../types.js';

import type {
  Provider,
  ProviderCallInput,
  ProviderPingInput,
} from './provider.js';
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

/** Current stable Anthropic Messages API version. */
export const ANTHROPIC_API_VERSION = '2023-06-01';

/** Endpoint — exposed as a const for test assertions. */
export const ANTHROPIC_ENDPOINT = 'https://api.anthropic.com/v1/messages';

/** Cheapest model used by `ping`. Cost ~fraction of a cent. */
export const ANTHROPIC_PING_MODEL = 'claude-haiku-4-5';

/** Per-call timeout (60s per §7.1 timeout row). */
export const ANTHROPIC_CALL_TIMEOUT_MS = 60_000;

/** Per-ping timeout — short; pings must be snappy. */
export const ANTHROPIC_PING_TIMEOUT_MS = 10_000;

/**
 * Dependencies injected into the provider at construction. Defaults
 * are applied in `createAnthropicProvider` so production call sites
 * don't have to pass anything.
 */
export interface AnthropicDeps {
  readonly http: HttpClient;
  readonly endpoint?: string | undefined;
  readonly apiVersion?: string | undefined;
  /**
   * Factory for per-call timeout signals. Injected so tests can
   * deterministically control timeouts without relying on real
   * timers. Defaults to `AbortSignal.timeout(ms)`.
   */
  readonly timeoutSignal?: ((ms: number) => AbortSignal) | undefined;
}

// ─── Public factory ───────────────────────────────────────────────────

export function createAnthropicProvider(deps?: Partial<AnthropicDeps>): Provider {
  const http = deps?.http ?? fetchHttpClient;
  const endpoint = deps?.endpoint ?? ANTHROPIC_ENDPOINT;
  const apiVersion = deps?.apiVersion ?? ANTHROPIC_API_VERSION;
  const timeoutSignal =
    deps?.timeoutSignal ?? ((ms: number) => AbortSignal.timeout(ms));

  return {
    name: 'anthropic',
    async call(input) {
      return anthropicCall(
        { http, endpoint, apiVersion, timeoutSignal },
        input,
      );
    },
    async ping(input) {
      return anthropicPing(
        { http, endpoint, apiVersion, timeoutSignal },
        input,
      );
    },
  };
}

// ─── Core request flow ────────────────────────────────────────────────

interface ResolvedDeps {
  readonly http: HttpClient;
  readonly endpoint: string;
  readonly apiVersion: string;
  readonly timeoutSignal: (ms: number) => AbortSignal;
}

async function anthropicCall(
  deps: ResolvedDeps,
  input: ProviderCallInput,
): Promise<Result<ProviderCallOutput, LLMCallError>> {
  const body = buildRequestBody(input.request);
  const signal = composeSignal(deps.timeoutSignal(ANTHROPIC_CALL_TIMEOUT_MS), input.abortSignal);

  let response;
  try {
    response = await deps.http({
      method: 'POST',
      url: deps.endpoint,
      headers: authHeaders(input.apiKey, deps.apiVersion, input.correlationId),
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

async function anthropicPing(
  deps: ResolvedDeps,
  input: ProviderPingInput,
): Promise<Result<PingOutput, LLMCallError>> {
  const body = {
    model: ANTHROPIC_PING_MODEL,
    max_tokens: 1,
    messages: [{ role: 'user', content: 'hi' }],
  };
  const signal = composeSignal(deps.timeoutSignal(ANTHROPIC_PING_TIMEOUT_MS), input.abortSignal);

  let response;
  try {
    response = await deps.http({
      method: 'POST',
      url: deps.endpoint,
      // Ping uses `ProviderPingInput`, which carries no correlation
      // id — pings run outside the router's call chain (cron at §6
      // + settings UI probe). Pass `undefined` so `authHeaders`
      // omits `anthropic-trace-id`.
      headers: authHeaders(input.apiKey, deps.apiVersion, undefined),
      body: JSON.stringify(body),
      signal,
    });
  } catch (e) {
    return err(transportErrorToLLMError(e));
  }

  if (response.status >= 200 && response.status < 300) {
    const reqId = response.headers['request-id'] ?? response.headers['anthropic-request-id'];
    const pong: PingOutput = reqId === undefined
      ? { status: 'active', model: ANTHROPIC_PING_MODEL }
      : { status: 'active', model: ANTHROPIC_PING_MODEL, providerRequestId: reqId };
    return ok(pong);
  }

  return err(mapHttpError(response));
}

// ─── Outbound wire format ────────────────────────────────────────────

/**
 * Build Anthropic auth headers.
 *
 * `correlationId` is threaded from `ProviderCallInput.correlationId`
 * (iter 6 commit 2). When present, it travels as `anthropic-trace-id` —
 * Anthropic treats this header as an opaque per-request trace tag that
 * is echoed back in the `request-id` response header and in their
 * support tooling, letting us correlate our logs and Anthropic's own
 * without any extra round-trip.
 *
 * `ping` passes `undefined` — pings run outside the router's call
 * chain so there is no correlation id to stamp. Production call paths
 * always provide one (P11).
 *
 * @see docs/LLM_CLIENT.md §9.1
 * @see .cmsgs/iter6-otel-correlation-design.md §3 (commit 2 scope)
 */
function authHeaders(
  apiKey: string,
  apiVersion: string,
  correlationId: string | undefined,
): Readonly<Record<string, string>> {
  const base = {
    'content-type': 'application/json',
    accept: 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': apiVersion,
  };
  if (correlationId === undefined) {
    return Object.freeze(base);
  }
  return Object.freeze({
    ...base,
    // Anthropic's convention for customer-side trace tagging. Spelling
    // lifted verbatim from the Messages API guide; it is case-
    // insensitive on the wire but we send lowercase to match the rest
    // of this header block and to be deterministic for tests.
    'anthropic-trace-id': correlationId,
  });
}

interface AnthropicRequestBody {
  model: string;
  max_tokens: number;
  messages: readonly {
    role: 'user' | 'assistant';
    content: string | readonly AnthropicContentOut[];
  }[];
  system?: string;
  temperature?: number;
  stop_sequences?: readonly string[];
  tools?: readonly AnthropicTool[];
}

type AnthropicContentOut =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Readonly<Record<string, unknown>>;
    }
  | {
      type: 'tool_result';
      tool_use_id: string;
      content: string;
      is_error?: boolean;
    };

interface AnthropicTool {
  name: string;
  description: string;
  input_schema: Readonly<Record<string, unknown>>;
}

function buildRequestBody(
  request: NormalizedLLMRequest,
): AnthropicRequestBody {
  const messages: AnthropicRequestBody['messages'] = request.messages.map((m) =>
    toAnthropicMessage(m),
  );

  const body: AnthropicRequestBody = {
    model: request.model,
    max_tokens: request.maxTokens,
    messages,
  };

  if (request.systemPrompt !== undefined) {
    body.system = request.systemPrompt;
  }
  if (request.temperature !== undefined) {
    body.temperature = request.temperature;
  }
  if (request.stopSequences !== undefined && request.stopSequences.length > 0) {
    body.stop_sequences = request.stopSequences;
  }
  if (request.toolDefinitions !== undefined && request.toolDefinitions.length > 0) {
    body.tools = request.toolDefinitions.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  return body;
}

/**
 * Translate a `NormalizedMessage` to Anthropic's message shape. Role
 * `'tool'` collapses to `'user'` with a `tool_result` content block —
 * that is how Anthropic's Messages API represents tool returns.
 */
function toAnthropicMessage(
  m: NormalizedMessage,
): {
  role: 'user' | 'assistant';
  content: string | readonly AnthropicContentOut[];
} {
  const role = m.role === 'tool' ? 'user' : m.role;

  if (typeof m.content === 'string') {
    return { role, content: m.content };
  }

  const content: AnthropicContentOut[] = m.content.map((b) => toAnthropicBlock(b));
  return { role, content };
}

function toAnthropicBlock(b: NormalizedContentBlock): AnthropicContentOut {
  switch (b.type) {
    case 'text':
      return { type: 'text', text: b.text };
    case 'tool_use':
      return {
        type: 'tool_use',
        id: b.toolUseId,
        name: b.toolName,
        input: b.input,
      };
    case 'tool_result':
      return b.isError === undefined
        ? {
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: b.output,
          }
        : {
            type: 'tool_result',
            tool_use_id: b.toolUseId,
            content: b.output,
            is_error: b.isError,
          };
  }
}

// ─── Inbound response parsing ────────────────────────────────────────

interface AnthropicResponseBody {
  id?: string;
  type?: string;
  role?: 'assistant';
  model?: string;
  content?: readonly AnthropicContentIn[];
  stop_reason?: string;
  stop_sequence?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

type AnthropicContentIn =
  | { type: 'text'; text: string }
  | {
      type: 'tool_use';
      id: string;
      name: string;
      input: Record<string, unknown>;
    };

/**
 * Narrowed view after the boot-check. Equivalent to
 * `AnthropicResponseBody` with the five fields the parser requires
 * asserted present (`message` type, non-empty content array,
 * usage/stop_reason/model all defined). The predicate below is the
 * sole way to land on this shape.
 */
interface ValidAnthropicResponseBody extends AnthropicResponseBody {
  type: 'message';
  content: readonly AnthropicContentIn[];
  stop_reason: string;
  model: string;
  usage: {
    input_tokens?: number;
    output_tokens?: number;
  };
}

function isAnthropicResponseBody(
  u: unknown,
): u is ValidAnthropicResponseBody {
  if (typeof u !== 'object' || u === null) return false;
  const o = u as Record<string, unknown>;
  if (o.type !== 'message') return false;
  if (!Array.isArray(o.content)) return false;
  if (typeof o.stop_reason !== 'string') return false;
  if (typeof o.model !== 'string') return false;
  if (typeof o.usage !== 'object' || o.usage === null) return false;
  // Each content block is validated inline in the loop — cheaper
  // than a double pass, and the loop already discriminates by
  // `block.type`. Per-block unknown shapes are defensively ignored
  // rather than rejecting the whole envelope.
  return true;
}

function parseCallResponse(
  raw: string,
  headers: Readonly<Record<string, string>>,
): Result<ProviderCallOutput, LLMCallError> {
  // Parse to `unknown` first so the `no-unsafe-*` family doesn't
  // taint every downstream access via `JSON.parse`'s `any` return.
  // The narrow-to-shape happens through the `isAnthropicResponseBody`
  // predicate below, which is a single chokepoint any future
  // shape-validation tightening would pass through.
  let parsedUnknown: unknown;
  try {
    parsedUnknown = JSON.parse(raw);
  } catch {
    return err(classifyProviderHttpError({ provider: 'anthropic', status: 500 }));
  }

  if (!isAnthropicResponseBody(parsedUnknown)) {
    return err(classifyProviderHttpError({ provider: 'anthropic', status: 500 }));
  }

  const parsed = parsedUnknown;

  const content: NormalizedContentBlock[] = [];
  for (const block of parsed.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: block.text });
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- defensive filter: the wire may ship unknown block types (e.g. new variants from a future API version) that the predicate intentionally didn't reject; an explicit discriminator prevents pushing malformed {type: 'tool_use', toolUseId: undefined, ...} for unrelated shapes like {type: 'image'}.
    } else if (block.type === 'tool_use') {
      content.push({
        type: 'tool_use',
        toolUseId: block.id,
        toolName: block.name,
        input: block.input,
      });
    }
    // Other block types are silently dropped (see test:
    // "ignores unknown inbound content block types").
  }

  const message: NormalizedMessage = {
    role: 'assistant',
    content,
  };

  const usage: UsageCounts = {
    inputTokens: parsed.usage.input_tokens ?? 0,
    outputTokens: parsed.usage.output_tokens ?? 0,
    totalTokens:
      (parsed.usage.input_tokens ?? 0) + (parsed.usage.output_tokens ?? 0),
  };

  const stopReason = toNormalizedStopReason(parsed.stop_reason);

  const providerRequestId =
    headers['request-id'] ?? headers['anthropic-request-id'] ?? parsed.id;

  const output: ProviderCallOutput = providerRequestId === undefined
    ? {
        modelUsed: parsed.model,
        providerUsed: 'anthropic',
        message,
        usage,
        stopReason,
      }
    : {
        modelUsed: parsed.model,
        providerUsed: 'anthropic',
        message,
        usage,
        stopReason,
        providerRequestId,
      };
  return ok(output);
}

/** Map Anthropic stop_reason to our normalised set. */
function toNormalizedStopReason(r: string): StopReason {
  switch (r) {
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'tool_use':
      return 'tool_use';
    case 'end_turn':
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
  let parsed: { error?: { type?: string; message?: string } } | undefined;
  try {
    parsed = JSON.parse(response.body) as typeof parsed;
  } catch {
    parsed = undefined;
  }

  const retryAfterSec = readRetryAfterSec(response.headers);
  const message = parsed?.error?.message ?? '';

  // Anthropic-specific 400 classification.
  let http400Hint: 'context_length_exceeded' | 'content_filter' | undefined;
  if (response.status === 400) {
    const m = message.toLowerCase();
    if (m.includes('max_tokens') || m.includes('context') || m.includes('token')) {
      http400Hint = 'context_length_exceeded';
    } else if (m.includes('content policy') || m.includes('safety') || m.includes('harmful')) {
      http400Hint = 'content_filter';
    }
  }

  // Overloaded — some Anthropic deploys surface HTTP 529, others 503.
  // Both map to `provider_down`, which is what status-based
  // classification yields for 503/504. For 529 we funnel it through
  // 503 so the classifier's switch does not drop it.
  const effectiveStatus = response.status === 529 ? 503 : response.status;

  return classifyProviderHttpError({
    provider: 'anthropic',
    status: effectiveStatus,
    retryAfterSec,
    http400Hint,
    body: parsed,
  });
}

/** Parse `retry-after` header (seconds or HTTP-date). */
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
 * Convert an `HttpTransportError` (or any other thrown error) into a
 * classified `LLMCallError`. Non-transport errors land as
 * `internal` with a correlation ID — `make.internal` handles it.
 */
function transportErrorToLLMError(e: unknown): LLMCallError {
  if (e instanceof HttpTransportError) {
    return classifyNetworkError(transportKindToNetworkKind(e.kind));
  }
  return make.internal(randomCorrelationId());
}

function randomCorrelationId(): string {
  // Minimal UUID-ish; good enough for an error the caller only ever
  // uses to look up a log line. We avoid importing `randomUUID` here
  // to keep the adapter footprint tight.
  const a = Math.random().toString(16).slice(2, 10);
  const b = Math.random().toString(16).slice(2, 10);
  return `${a}-${b}`;
}

// ─── Signal composition ──────────────────────────────────────────────

/**
 * Compose two AbortSignals so that `aborted` on either propagates to
 * the returned signal. `AbortSignal.any` is available in Node 20+ —
 * we fall back to a manual listener for older runtimes.
 */
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
  const onAbort = (): void => {
    ctrl.abort();
  };
  primary.addEventListener('abort', onAbort, { once: true });
  secondary.addEventListener('abort', onAbort, { once: true });
  if (primary.aborted || secondary.aborted) ctrl.abort();
  return ctrl.signal;
}
