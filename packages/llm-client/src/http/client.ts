/**
 * Narrow HTTP client abstraction for provider adapters.
 *
 * Why an abstraction at all?
 *
 *  1. **Contract tests.** Each adapter needs deterministic tests over
 *     headers, body, response parsing and error mapping. Injecting a
 *     fake `HttpClient` gives us that without pulling in `undici`'s
 *     `MockAgent` or `msw` as a runtime dependency.
 *  2. **Security hardening seam.** A single choke point makes it easy
 *     to enforce future policies: mTLS, allowlisted egress (§2
 *     invariant 1), redaction of outbound headers in traces, and so
 *     on.
 *  3. **Body-buffering discipline.** The whole client assumes a
 *     request/response model with buffered bodies (no streaming in
 *     MVP v0.1, §9.1/§9.2/§9.3). The interface enforces that shape
 *     so an adapter cannot accidentally hand us a stream.
 *
 * The interface is intentionally **shape-only**: no retry logic, no
 * redaction, no metrics. Providers layer those concerns on top
 * *inside their own module* because the right place for retries is
 * the routing + circuit-breaker layer (Iteration 4), not HTTP.
 */

/**
 * Scalar HTTP methods used by the three MVP providers. If a future
 * adapter needs PUT/DELETE we can widen this, but keeping it narrow
 * catches typos at compile time.
 */
export type HttpMethod = 'GET' | 'POST';

/**
 * Outbound HTTP request. Headers are a plain object to avoid forcing
 * callers to allocate a `Headers` instance and to keep the shape
 * trivially serialisable for test assertions.
 *
 * `body` is always a string — adapters JSON.stringify before calling.
 * This means the adapter owns the `Content-Type: application/json`
 * header and there is no ambiguity about content negotiation.
 */
export interface HttpRequest {
  readonly method: HttpMethod;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string | undefined;
  /**
   * Caller's abort signal. Propagated to the underlying fetch so
   * that deadline / user-cancel semantics reach the socket. Timeouts
   * per call live on top of this via `AbortSignal.timeout`.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Inbound HTTP response. `body` is the raw text; adapters parse it
 * with `JSON.parse` inside a try/catch and classify parse failures as
 * `internal` (per §7.1 "Caso no mapeado").
 *
 * `headers` is a plain map with lower-cased keys so adapters can
 * read `retry-after` without worrying about fetch-impl quirks.
 */
export interface HttpResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
}

/**
 * A function that sends one HTTP request and returns the full
 * buffered response, or throws for *transport* failures (DNS, TCP,
 * TLS, timeout). HTTP 4xx and 5xx do **not** throw — they resolve
 * with the response so the adapter can classify them via
 * `classifyProviderHttpError` (§7.1).
 *
 * Transport failures surface as `HttpTransportError` so the adapter
 * can map them to `network_error { transient: true }` without
 * inspecting the raw error type of a particular runtime.
 */
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

/**
 * Thrown by the default `fetchHttpClient` when transport fails
 * (DNS / TCP / TLS / timeout / abort / offline). Adapters catch this
 * and return `classifyNetworkError(kind)`.
 *
 * Deliberately a class and not a typed object so it threads through
 * `Promise.reject` without ambiguity about its discriminant.
 */
export class HttpTransportError extends Error {
  readonly kind: 'timeout' | 'dns' | 'tcp' | 'tls' | 'abort' | 'other';

  constructor(
    kind: 'timeout' | 'dns' | 'tcp' | 'tls' | 'abort' | 'other',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options as ErrorOptions);
    this.name = 'HttpTransportError';
    this.kind = kind;
  }
}

/**
 * Default implementation backed by `globalThis.fetch` (Node 24+
 * ships `undici`-based fetch). Normalises header access (lower-cased
 * keys) and converts transport failures into `HttpTransportError` so
 * adapters have a single exception class to catch.
 *
 * Never adds authorization / x-api-key / x-goog-api-key itself — the
 * adapter is authoritative about auth headers (§2 invariant 1: key
 * material only ever sits on the exact request it authorises).
 */
export const fetchHttpClient: HttpClient = async (req) => {
  let res: Response;
  try {
    const init: RequestInit = {
      method: req.method,
      headers: req.headers as Record<string, string>,
    };
    if (req.body !== undefined) {
      (init as { body: string }).body = req.body;
    }
    if (req.signal !== undefined) {
      (init as { signal: AbortSignal }).signal = req.signal;
    }
    res = await fetch(req.url, init);
  } catch (e) {
    throw toTransportError(e);
  }

  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  let body: string;
  try {
    body = await res.text();
  } catch (e) {
    throw toTransportError(e);
  }

  return {
    status: res.status,
    headers,
    body,
  };
};

/**
 * Map a thrown transport-level error to `HttpTransportError`.
 *
 * Node's `fetch` (undici) surfaces rich `cause` errors. We read the
 * cause chain for `code` hints but fall back to `'other'` when the
 * hint is unrecognised — adapters always classify that as
 * `network_error { transient: true }` which is safe.
 */
function toTransportError(e: unknown): HttpTransportError {
  if (e instanceof HttpTransportError) return e;

  if (e instanceof Error && e.name === 'AbortError') {
    return new HttpTransportError('abort', e.message, { cause: e });
  }

  const code = readErrorCode(e);
  const message = e instanceof Error ? e.message : String(e);

  switch (code) {
    case 'UND_ERR_CONNECT_TIMEOUT':
    case 'UND_ERR_HEADERS_TIMEOUT':
    case 'UND_ERR_BODY_TIMEOUT':
    case 'ETIMEDOUT':
      return new HttpTransportError('timeout', message, { cause: e });
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new HttpTransportError('dns', message, { cause: e });
    case 'ECONNREFUSED':
    case 'ECONNRESET':
    case 'EPIPE':
    case 'UND_ERR_SOCKET':
      return new HttpTransportError('tcp', message, { cause: e });
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'CERT_HAS_EXPIRED':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
      return new HttpTransportError('tls', message, { cause: e });
    case undefined:
    default:
      return new HttpTransportError('other', message, { cause: e });
  }
}

/**
 * Walk the `cause` chain (capped at 5 hops) looking for a `code`.
 * Undici raises a thin `TypeError: fetch failed` whose real detail
 * lives at `e.cause.code`.
 */
function readErrorCode(e: unknown): string | undefined {
  let cur: unknown = e;
  for (let i = 0; i < 5 && cur !== null && cur !== undefined; i++) {
    if (typeof cur === 'object' && 'code' in cur) {
      const code = (cur as { code?: unknown }).code;
      if (typeof code === 'string') return code;
    }
    if (typeof cur === 'object' && 'cause' in cur) {
      cur = (cur as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return undefined;
}

/**
 * Map `HttpTransportError.kind` to the `NetworkErrorKind` tag used by
 * `classifyNetworkError`. Abort is treated as a timeout-equivalent
 * because the adapter only sets an abort signal for deadline-reached
 * cases (§4.3). Callers that cancel voluntarily handle `AbortError`
 * before it ever reaches the classifier.
 */
export function transportKindToNetworkKind(
  kind: HttpTransportError['kind'],
): 'timeout' | 'dns' | 'tcp' | 'tls' {
  switch (kind) {
    case 'timeout':
    case 'abort':
      return 'timeout';
    case 'dns':
      return 'dns';
    case 'tcp':
      return 'tcp';
    case 'tls':
      return 'tls';
    case 'other':
      return 'tcp';
  }
}
