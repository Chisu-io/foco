/**
 * Tiny fake `HttpClient` used by every provider contract test.
 *
 * The whole point of the HTTP abstraction in `src/http/client.ts` is
 * that tests do not need to mock `globalThis.fetch` or spin up
 * `undici`'s `MockAgent` — they inject this fake directly and assert
 * on captured requests.
 *
 * Features:
 *   - Records every request into `received` (FIFO) so tests can
 *     assert on headers, URL and body.
 *   - Accepts either a static `HttpResponse` or a function
 *     `(req) => HttpResponse | Promise<HttpResponse>` that can decide
 *     per call.
 *   - `throwTransport(kind)` returns a client that rejects with
 *     `HttpTransportError` to exercise the transport-error path
 *     without using timers.
 */

import type { HttpClient, HttpRequest, HttpResponse } from '../../src/http/client.js';
import { HttpTransportError } from '../../src/http/client.js';

export interface FakeHttpClient {
  readonly fn: HttpClient;
  readonly received: HttpRequest[];
}

export function fakeHttp(
  resolver:
    | HttpResponse
    | ((req: HttpRequest) => HttpResponse | Promise<HttpResponse>),
): FakeHttpClient {
  const received: HttpRequest[] = [];
  const fn: HttpClient = async (req) => {
    received.push(req);
    return typeof resolver === 'function' ? resolver(req) : resolver;
  };
  return { fn, received };
}

export function throwTransport(
  kind: HttpTransportError['kind'] = 'timeout',
  message = `simulated ${kind}`,
): FakeHttpClient {
  const received: HttpRequest[] = [];
  const fn: HttpClient = async (req) => {
    received.push(req);
    throw new HttpTransportError(kind, message);
  };
  return { fn, received };
}

/**
 * Deterministic timeout factory for tests. Returns a never-aborted
 * signal so per-call timeouts do not touch real timers or leak wall
 * time between tests.
 */
export const neverTimeout = (_ms: number): AbortSignal => {
  return new AbortController().signal;
};

export function jsonResponse(
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): HttpResponse {
  return {
    status,
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  };
}
