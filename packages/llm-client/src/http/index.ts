/**
 * Public subpath export for the HTTP abstraction. Adapters and tests
 * import from here; nothing outside the client should need to touch
 * these types.
 */

export {
  type HttpClient,
  type HttpMethod,
  type HttpRequest,
  type HttpResponse,
  HttpTransportError,
  fetchHttpClient,
  transportKindToNetworkKind,
} from './client.js';
