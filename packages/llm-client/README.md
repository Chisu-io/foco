# @chisu/llm-client

Plan-aware LLM client for Foco. Implements
[`docs/LLM_CLIENT.md` v1.1](../../docs/LLM_CLIENT.md) — the fourth
anchor contract of Foco.

## Status

Iteration 1 of 9 (see `project_foco_llm_client_implementation_plan`).
**Not production-ready yet.** This iteration ships the error taxonomy
and flag config layer; the client itself (`LLMClient.call()`) lands in
Iteration 7.

## Scope

`@chisu/llm-client` is the single entrypoint for any **generative LLM
call** in Foco. It decides in runtime whether the call routes through
the user's own API key (BYOK — Free / Creator plans) or Foco's
managed pool (Influencer / Celebrity / Studio plans).

Not in scope (use dedicated clients):

- Embeddings (`@chisu/embedding-client`)
- Content moderation (CSAM, NSFW, deepfake)
- ASR (Whisper in Modal)
- TTS / voice cloning

See the contract's §1 for the full boundary.

## Public surface (current)

```ts
import {
  // Error taxonomy (§3.5)
  LLMCallError,
  LLMErrorCode,
  // Classifiers (§7.1)
  classifyProviderHttpError,
  classifyKmsError,
  classifyNetworkError,
  // Flag config (§16)
  FLAG_DEFAULTS,
  validateFlags,
  loadFlagsWithFallback,
  FlagValidationError,
} from '@chisu/llm-client';
```

The `LLMClient.call()` surface lands in Iteration 7.

## Invariants this package enforces

See the contract's §2 for the full list. Highlights relevant to the
current surface:

1. **Zero plaintext of user API keys** in logs, traces, audit bodies,
   errors or span attributes. A CI linter lands in Iteration 8.
2. **Fail-closed with a hard-capped retry budget.** `classifyKmsError`
   returns `{ transient: true }` only for 5xx/throttle; otherwise
   `{ transient: false }` → caller must not retry.
3. **Flag hard-caps.** `validateFlags` treats `llm.kms.retry_count ≤ 1`
   and `llm.dek_cache.ttl_seconds ≤ 300` as invariants of the doc,
   **not** runtime-adjustable. Raising them requires a PR to
   `LLM_CLIENT.md`, not a GrowthBook toggle.

## Development

```bash
pnpm --filter @chisu/llm-client typecheck
pnpm --filter @chisu/llm-client test
pnpm --filter @chisu/llm-client build
```

## License

Proprietary — see [`LICENSE-PROPRIETARY`](../../LICENSE-PROPRIETARY).
