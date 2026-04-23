/**
 * Contract tests for `fetchHttpClient` + cause-chain walker
 * (`src/http/client.ts`).
 *
 * The provider test suites use a fake `HttpClient` injected via DI,
 * so they never exercise the real `fetchHttpClient` or its
 * transport-error mapping. But that mapping is load-bearing: it is
 * the single point that turns an undici `TypeError: fetch failed`
 * into the `kind` enum that `classifyNetworkError` consumes. If the
 * cause-chain walker drifts, every `network_error{transient:true}`
 * turns into `'other' → tcp` and the retry/circuit-breaker layer
 * loses signal.
 *
 * These tests stub `globalThis.fetch` directly (not undici's
 * MockAgent — we want isolation from the runtime's network layer).
 * Every rejection constructs a plausible undici error shape:
 *
 *     TypeError('fetch failed', { cause: Error({ code: 'X' }) })
 *
 * and we assert that the emitted `HttpTransportError.kind` matches
 * the mapping documented in the source file.
 *
 * @see LLM_CLIENT.md §7.1 (error taxonomy — network_error kinds)
 * @see src/http/client.ts#toTransportError and #readErrorCode
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fetchHttpClient,
  HttpTransportError,
  transportKindToNetworkKind,
} from '../../src/http/client.js';

// --- Helpers ----------------------------------------------------------------

/**
 * Build an `Error` whose `.cause` is another `Error`, recursively.
 * Returns the outermost error; the deepest one carries the `code`.
 */
function causeChain(codeAtDepth: number, code: string): Error {
   
  let inner: any = new Error(`root-${code}`);
  (inner as { code: string }).code = code;
  for (let i = 0; i < codeAtDepth; i++) {
    const outer = new Error(`layer-${String(i)}`);
    (outer as { cause: unknown }).cause = inner;
    inner = outer;
  }
  return inner as Error;
}

/**
 * Build a minimal Response-like object (what undici hands us from a
 * successful fetch). We don't need real streams — just the three
 * surface calls `fetchHttpClient` makes: `.status`, `.headers.forEach`,
 * `.text()`.
 */
function fakeOkResponse(opts: {
  status: number;
  headers?: Record<string, string>;
  body?: string;
  textThrows?: unknown;
}): unknown {
  const h = opts.headers ?? {};
  return {
    status: opts.status,
    headers: {
      forEach(
        cb: (value: string, key: string) => void,
      ): void {
        for (const [k, v] of Object.entries(h)) cb(v, k);
      },
    },
    text: async (): Promise<string> => {
      if (opts.textThrows !== undefined) {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- test helper mirrors the real fetch API which can reject with arbitrary values
        throw opts.textThrows;
      }
      return opts.body ?? '';
    },
  };
}

const baseReq = {
  method: 'POST' as const,
  url: 'https://example.test/api',
  headers: { 'content-type': 'application/json' },
};

// --- Lifecycle --------------------------------------------------------------

const originalFetch = globalThis.fetch;

beforeEach(() => {
  // vi.stubGlobal lets each test swap fetch atomically
});

afterEach(() => {
  vi.unstubAllGlobals();
  // Safety: restore the real fetch in case stubGlobal missed it
  // (e.g. if a test skipped the stub).
  globalThis.fetch = originalFetch;
});

// --- Success path -----------------------------------------------------------

describe('fetchHttpClient — success', () => {
  it('buffers status + lower-cased headers + body', async () => {
    const res = fakeOkResponse({
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-RateLimit-Remaining': '42',
      },
      body: '{"ok":true}',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    const out = await fetchHttpClient({ ...baseReq, body: '{"x":1}' });

    expect(out.status).toBe(200);
    expect(out.body).toBe('{"ok":true}');
    // Keys are lower-cased — critical for the adapters' retry-after
    // and rate-limit hint parsing.
    expect(out.headers['content-type']).toBe('application/json');
    expect(out.headers['x-ratelimit-remaining']).toBe('42');
  });

  it('passes body and signal through to fetch init', async () => {
    const res = fakeOkResponse({ status: 204 });
    const spy = vi.fn().mockResolvedValue(res);
    vi.stubGlobal('fetch', spy);

    const signal = new AbortController().signal;
    await fetchHttpClient({
      ...baseReq,
      body: 'hello',
      signal,
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(baseReq.url);
    expect(init.method).toBe('POST');
    expect(init.body).toBe('hello');
    expect(init.signal).toBe(signal);
  });

  it('omits body and signal when undefined (exactOptionalPropertyTypes)', async () => {
    const res = fakeOkResponse({ status: 200 });
    const spy = vi.fn().mockResolvedValue(res);
    vi.stubGlobal('fetch', spy);

    await fetchHttpClient(baseReq);

    const [, init] = spy.mock.calls[0] as [string, RequestInit];
    expect('body' in init).toBe(false);
    expect('signal' in init).toBe(false);
  });

  it('wraps text() rejection as HttpTransportError("other")', async () => {
    const textErr = new Error('stream aborted mid-read');
    (textErr as unknown as { code: string }).code = 'ERR_STREAM_DESTROYED';
    const res = fakeOkResponse({ status: 200, textThrows: textErr });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res));

    await expect(fetchHttpClient(baseReq)).rejects.toMatchObject({
      name: 'HttpTransportError',
      kind: 'other',
    });
  });
});

// --- Transport error mapping -----------------------------------------------

describe('fetchHttpClient — transport error mapping', () => {
  it.each([
    ['ETIMEDOUT', 'timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
    ['UND_ERR_BODY_TIMEOUT', 'timeout'],
  ])('%s → kind=timeout', async (code: string, expected: string) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(causeChain(1, code)),
    );
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HttpTransportError);
    expect((err as HttpTransportError).kind).toBe(expected);
  });

  it.each([
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
  ])('%s → kind=dns', async (code: string, expected: string) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(causeChain(1, code)),
    );
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe(expected);
  });

  it.each([
    ['ECONNREFUSED', 'tcp'],
    ['ECONNRESET', 'tcp'],
    ['EPIPE', 'tcp'],
    ['UND_ERR_SOCKET', 'tcp'],
  ])('%s → kind=tcp', async (code: string, expected: string) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(causeChain(1, code)),
    );
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe(expected);
  });

  it.each([
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
  ])('%s → kind=tls', async (code: string, expected: string) => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(causeChain(1, code)),
    );
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe(expected);
  });

  it('AbortError short-circuits to kind=abort (before cause-chain walk)', async () => {
    const abortErr = new Error('The user aborted a request.');
    abortErr.name = 'AbortError';
    // Even with a misleading `code` downstream, AbortError wins.
    (abortErr as unknown as { code: string }).code = 'ETIMEDOUT';
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortErr));

    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe('abort');
  });

  it('unknown code → kind=other', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(causeChain(1, 'E_NEVERHEARDOFIT')),
    );
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe('other');
  });

  it('Error without .cause → kind=other (no walker hop)', async () => {
    const plain = new Error('fetch failed');
    // No `code`, no `cause`.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(plain));

    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe('other');
    expect((err as HttpTransportError).message).toBe('fetch failed');
  });

  it('thrown non-Error value → kind=other with stringified message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue('raw string weirdness'));
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe('other');
    expect((err as HttpTransportError).message).toBe('raw string weirdness');
  });

  it('re-throws an HttpTransportError unchanged (idempotent)', async () => {
    const original = new HttpTransportError('tls', 'pre-wrapped');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(original));
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect(err).toBe(original);
    expect((err as HttpTransportError).kind).toBe('tls');
  });
});

// --- Cause-chain depth (walker invariant) ----------------------------------

describe('readErrorCode — cause-chain walker', () => {
  it('finds code at depth 1 (undici canonical shape)', async () => {
    // causeChain(1, ...) wraps once: outer.cause = inner(code=X)
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(causeChain(1, 'ECONNREFUSED')),
    );
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe('tcp');
  });

  it('finds code at depth 3', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(causeChain(3, 'ETIMEDOUT')),
    );
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe('timeout');
  });

  it('finds code at depth 4 (last reachable hop — i=0..4 inclusive)', async () => {
    // The walker iterates i=0..4, so depth 4 is the last hop it can
    // inspect. Depth 5+ is unreachable.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(causeChain(4, 'ENOTFOUND')),
    );
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe('dns');
  });

  it('does NOT walk past depth 5 (code at depth 6 → kind=other)', async () => {
    // Ensure the 5-hop cap is load-bearing: if a code is buried below
    // the cap, we must NOT see it — fall back to 'other'.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(causeChain(6, 'ECONNREFUSED')),
    );
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe('other');
  });

  it('stops at chain break (object without .cause)', async () => {
    // Outer has no .cause at all → walker halts on hop 1, code not
    // found, kind='other'.
    const outer = new Error('fetch failed');
     
    const weirdCause: any = { notAStandardError: true };
    (outer as { cause: unknown }).cause = weirdCause;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(outer));
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe('other');
  });

  it('ignores non-string code values', async () => {
    // Some tools stuff numeric codes into Errors. We only accept
    // strings — anything else is treated as "no code found".
    const err = new Error('weird');
    (err as unknown as { code: number }).code = 500;
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(err));
    const out = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((out as HttpTransportError).kind).toBe('other');
  });

  it('returns the first (shallowest) code on the chain', async () => {
    // Outer has code=ETIMEDOUT, inner has code=ECONNREFUSED. Walker
    // MUST take the outer one (depth-first from the top).
    const inner = new Error('inner');
    (inner as unknown as { code: string }).code = 'ECONNREFUSED';
    const outer = new Error('outer');
    (outer as unknown as { code: string }).code = 'ETIMEDOUT';
    (outer as unknown as { cause: unknown }).cause = inner;

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(outer));
    const err = await fetchHttpClient(baseReq).catch((e: unknown) => e);
    expect((err as HttpTransportError).kind).toBe('timeout');
  });
});

// --- transportKindToNetworkKind -------------------------------------------

describe('transportKindToNetworkKind', () => {
  it.each([
    ['timeout', 'timeout'],
    ['abort', 'timeout'],
    ['dns', 'dns'],
    ['tcp', 'tcp'],
    ['tls', 'tls'],
    ['other', 'tcp'],
  ] as const)('%s → %s', (input, expected) => {
    expect(transportKindToNetworkKind(input)).toBe(expected);
  });
});

// --- HttpTransportError class surface --------------------------------------

describe('HttpTransportError', () => {
  it('exposes kind and preserves cause via Error options', () => {
    const cause = new Error('root cause');
    const err = new HttpTransportError('tls', 'cert expired', { cause });
    expect(err.kind).toBe('tls');
    expect(err.name).toBe('HttpTransportError');
    expect(err.message).toBe('cert expired');
    // Error.cause is supported in Node 16+ via ErrorOptions.
    expect((err as { cause?: unknown }).cause).toBe(cause);
  });

  it('defaults cause to undefined when options omitted', () => {
    const err = new HttpTransportError('other', 'naked');
    expect((err as { cause?: unknown }).cause).toBeUndefined();
  });
});
