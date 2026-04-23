---
title: Foco · LLM_CLIENT v1.1
status: SIGNED v1.1 (2026-04-18)
date: 2026-04-18
owner: Jean Pierre Rojas
signed_by: Jean Pierre Rojas — 2026-04-18 (v1.1)
reviewers:
  - Jean Pierre Rojas (owner)
  - AI peer review externo, pasada 1 (aplicada en v0.2)
  - AI peer review externo, pasada 2 (aplicada en v0.3)
depends_on:
  - docs/UX_FROZEN.md (v1.3)
  - docs/INGEST_SECURITY.md (v1.0)
  - docs/PRODUCTION_READINESS.md (v1.0)
  - packages/schemas (v0.x — `UserQuota`, `SystemAuditEntry`)
changelog:
  - v0.1 (2026-04-18): primer borrador para peer review. Cubre
    surface pública, plan-aware routing (BYOK vs Managed),
    envelope encryption de keys, validación, taxonomía de errores,
    token accounting, providers MVP (Anthropic + OpenAI),
    observabilidad, audit, SLOs y testing. No firmado.
  - v0.2 (2026-04-18): aplica 6 cambios del primer peer review
    externo. KEK por shard de ~1000 usuarios (no por usuario);
    KMS vendor cerrado = AWS KMS. Retry con jitter ante
    `kms_unavailable` + métrica separada. Cache in-process
    TTL 5min (antes "zero caching" era demasiado estricto).
    Idempotency corrige semántica (no garantiza output textual
    idéntico). Token accounting BYOK explicita razonamiento.
    Circuit breaker thresholds migran a flags GrowthBook.
  - v0.3 (2026-04-18): aplica 7 cambios del segundo peer review
    externo (3 críticos + 3 importantes + 1 nice-to-have). Clarifica
    que NO hay circuit breaker sobre KMS (fail-closed directo);
    añade `kekVersion` al envelope + estrategia de rebalance
    offline; cache key pasa a `(userId, kekVersion)` con
    invalidación completa; deadline propagation desde span padre
    + budget de retry fijo (no flag-configurable a >1); modo
    consent-minimal en token accounting BYOK; tabla min/max de
    validación de flags + fail-fast al arranque; nuevas métricas
    de shard distribution, stale cache hits y retry success ratio.
    1 decisión añadida como abierta (N8 — persistencia de
    providerRequestId en idempotency cache).
  - v1.0 (2026-04-18): firma. Cuarto contrato ancla de Foco.
    Contenido técnico idéntico a v0.3; solo bump de status. A
    partir de ahora el doc es invariante — cualquier cambio en
    los 8 invariantes de §2 requiere nueva ronda de peer review
    + re-firma. `packages/llm-client/` habilitado para
    implementación.
  - v1.1 (2026-04-18): agrega **Google Gemini** como tercer
    proveedor MVP vía **Gemini API directa (AI Studio)**.
    Modelos: `gemini-2.5-pro`, `gemini-2.5-flash`. Cambios
    aditivos en §1.1, §3.1, §3.3, §3.4, §4.2, §9 (nueva §9.3
    Gemini + interface `Provider` renumerada a §9.4) y §15. **No
    toca los 8 invariantes de §2 ni §5 (crypto) ni §8 (accounting)**
    — por eso no requiere nueva ronda de peer review externo, solo
    firma de Jean en este changelog. El path Vertex AI (GCP
    service accounts) explícitamente **sigue fuera del MVP**
    (complejidad operacional innecesaria para BYOK).
---

# Foco · LLM_CLIENT v1.1

> **Principio rector.** Foco trata a cada llamada a un LLM como un
> **evento facturable con superficie de ataque**. Nunca hay plaintext
> de claves de usuario en memoria compartida, logs, audit bodies o
> respuestas. El cliente falla-cerrado cuando cualquier control
> (KMS, proveedor, cuota) es ambiguo. El plan del usuario determina
> tanto el origen del dinero como la superficie criptográfica: esa
> decisión vive **en un único punto** (`LLMClient.call()`), nunca
> se replica en callers.

## 1 · Scope

### 1.1 Qué cubre esta spec

Define el contrato técnico del paquete `@chisu/llm-client` y su
componente runtime `LLMClient`, que es el **único** punto de entrada
de Foco a APIs generativas de LLM (Anthropic Messages, OpenAI Chat
Completions, Google Gemini API). Todo worker, edge function, MCP
handler o asistente conversacional que necesite completions pasa por
`LLMClient`.

### 1.2 Qué NO cubre (fuera de alcance del cliente generativo)

Las siguientes llamadas a modelos **nunca** usan `LLMClient` y viven
en clientes separados porque son invariantes de seguridad o costo
que Foco cubre independientemente del plan (ver
`project_foco_byok_model.md` para el rationale económico):

- **Embeddings** (`text-embedding-3-small` u OSS equivalente) →
  `EmbeddingClient`. Siempre financiado por Foco.
- **Moderación** (NSFW classifier, CSAM hash list, deepfake
  embedding match) → `ModerationClient`. Siempre financiado por
  Foco. Invariante de seguridad.
- **ASR / TTS** (WhisperX, Kokoro/XTTS) → `SpeechClient`. Son parte
  del render pipeline, no del plano conversacional.
- **Render compute** (Revideo + ffmpeg en Modal) → `RenderClient`.
  No es LLM.

Esta separación es **estricta**: un caller que quiera embeddings
no puede obtenerlos vía `LLMClient.call()`, y viceversa. La razón
es que mezclar el routing mezclaría la economía (BYOK vs Managed)
con invariantes de seguridad que nunca deben depender del plan.

### 1.3 Contratos ancla respetados

- **UX_FROZEN v1.3 §3.6** — cuotas por plan, `UserQuota` schema.
- **UX_FROZEN v1.3 §5** — pantalla `settings-integraciones` con
  "API Keys de IA" (Free/Creator obligatorio, Influencer+ opcional
  con toggle de prioridad).
- **INGEST_SECURITY v1.0 §4** — principio "fail-closed" aplicado al
  caso: si KMS no responde, `LLMClient.call()` falla cerrado antes
  de llegar al proveedor.
- **PRODUCTION_READINESS v1.0 §3** — integración con Postgres
  `system_audit` hash chain para todo evento de ciclo de vida de key
  (add/rotate/invalidate).
- **PRODUCTION_READINESS v1.0 §5** — Doppler como fuente de la **KEK
  pool key** y de las credenciales de la **pool de Foco** (Managed).
  Las keys de usuario jamás entran a Doppler.

## 2 · Principios no negociables (invariantes duras)

1. **Zero plaintext de keys de usuario** en cualquier log, trace,
   audit body, error response, métrica, span attribute o stacktrace.
   CI test obligatorio.
2. **Zero-read después del save**. La UI muestra la key enmascarada
   (`sk-ant-...xY7q`) siempre que se lea desde DB; nunca en claro
   post-save inicial. "Edit" es *replace completo*, no *update
   parcial*.
3. **Envelope encryption obligatoria**. Toda key BYOK viaja cifrada
   en reposo con DEK, y la DEK viaja cifrada con KEK administrada
   por KMS. Nunca almacenamos plaintext de la key y nunca la DEK en
   claro en DB.
4. **Plan-aware routing decidido en un punto**. Un caller jamás sabe
   si la llamada será BYOK o Managed; sólo invoca
   `llmClient.call(userId, request)`. La decisión es interna.
5. **Fail-closed con retry acotado**. Ante fallo transitorio de
   KMS (`kms_unavailable { transient: true }`) el cliente hace **1
   retry con jitter aleatorio 50–250ms** antes de fallar; si el
   segundo intento también falla, devuelve error estructurado sin
   vía degradada silenciosa. Para (a) key inválida/sin cuota sin
   fallback, (b) feature-flag `llm_routing_enabled` OFF, o (c)
   `kms_unavailable { transient: false }` (ej. ciphertext
   inválido), el fallo es inmediato sin retry. En ningún caso el
   cliente intenta una vía degradada silenciosa (ej. usar pool de
   Foco sin `preferMyKey` explícito). La métrica
   `llm_kms_induced_failures_total` aísla fallos imputables a KMS
   de fallos del proveedor LLM.
   **Crítico — NO existe circuit breaker sobre KMS**: el circuit
   breaker (§4.2) aplica exclusivamente a proveedores LLM
   (Anthropic, OpenAI, Gemini — y cualquier proveedor añadido en el
   futuro vía §9.4). Sobre KMS el manejo es fail-closed directo
   con retry budget **fijo = 1** (no configurable a >1 vía flag,
   para evitar amplificación de carga sobre una región degradada;
   ver §4.3 y §13.2). La razón: un "CB abierto sobre KMS" no
   ayudaría — no hay fallback criptográfico posible, y abrirlo
   solo agregaría latencia sin cambiar outcome.
6. **Token accounting para todos**, no sólo Managed. En BYOK
   contamos tokens para UI de uso en `settings-integraciones`,
   detección de abuso, y analytics — no para billing.
7. **Circuit breaker por proveedor**. Si Anthropic, OpenAI o Gemini
   tienen tasa de error >X% en ventana Y, Foco abre el circuito y
   usa fallback (otro proveedor o error estructurado). Ningún
   caller bloquea indefinidamente. El invariante es "CB por
   proveedor LLM" — la lista de proveedores concretos vive en §9 y
   crece aditivamente sin tocar este invariante.
8. **Scope mínimo en las keys de usuario**. La key BYOK solo se
   descifra dentro del proceso worker que hace la llamada. Zero IPC
   con otros workers con ella en claro. **Se permite caching
   in-process por worker** con TTL ≤5 min y zeroización al
   eviction, pero **se prohíbe**: cache en store distribuida
   (Redis, Memcached), serialización a disco o snapshot, y
   cualquier transmisión fuera del proceso. El cache es
   thread-local o per-event-loop, nunca global compartido.
   **Clave del cache = `(userId, kekVersion)`** (no solo `userId`):
   ante rotación de KEK o rebalance de shard la entrada vieja queda
   huérfana y se evicciona por TTL o por invalidación explícita
   (`invalidateUserKey` limpia **todas** las entradas del usuario,
   no solo la actual). Cada stale hit se contabiliza en
   `llm_dek_cache_stale_hits_total` para observar rotaciones
   incompletas.
   **Threat model explícito**: un worker comprometido puede
   exfiltrar keys de sus usuarios activos durante una ventana
   ≤5min (el TTL acota el radio); un compromiso de Redis, disco,
   DB replica o dump NO expone keys en claro en ningún momento
   (porque nunca viven ahí).
9. **Keys jamás se exportan vía DSR**. En un export de GDPR/CCPA, el
   usuario recibe `llmKeyProvider` y `llmKeyStatus` pero no la key
   (porque Foco nunca puede leerla en claro bajo demanda legal).
10. **Los conversaciones generativas del asistente interno NO se
    re-exponen vía MCP server** (alineado con
    `project_foco_mcp_bidireccional.md`). El `LLMClient` sabe su
    contexto y marca el request como `exposureScope: 'internal'` o
    `'mcp-callable'`; el MCP gateway respeta el flag.

## 3 · Interface pública

### 3.1 Paquete y ubicación

```
foco/packages/llm-client/
  src/
    index.ts          # exports
    client.ts         # LLMClient (runtime)
    providers/
      anthropic.ts    # Provider para Claude Messages API
      openai.ts       # Provider para OpenAI Chat Completions
      gemini.ts       # Provider para Google Gemini API (AI Studio)
      provider.ts     # interface Provider
    crypto/
      envelope.ts     # envelope encryption (DEK + KEK)
      kms.ts          # adapter KMS (AWS KMS | Supabase Vault)
      masking.ts      # utilidades de masking para UI
    routing/
      plan-router.ts  # plan-aware routing logic
      fallback.ts     # fallback chain
    accounting/
      tokens.ts       # counters + aggregation
    errors.ts         # taxonomía de errores
    audit.ts          # integración con SystemAuditEntry
    types.ts          # tipos públicos
  test/
    client.test.ts
    crypto.test.ts
    routing.test.ts
    providers/*.test.ts
  package.json
  tsconfig.json
```

Workspace entry como `@chisu/llm-client` con publishConfig
source-first → dist-first (mismo patrón que `@chisu/schemas`).

### 3.2 Firma de `LLMClient`

```ts
export interface LLMClient {
  /**
   * Ejecuta una completion. El routing (BYOK vs Managed), la
   * selección de proveedor, la envolvente criptográfica de la key
   * y el accounting de tokens son internos. El caller solo
   * proporciona contexto de usuario y el request normalizado.
   */
  call(input: LLMCallInput): Promise<LLMCallOutput>;

  /**
   * Valida una API key de proveedor contra un endpoint "ping"
   * barato. Usado desde la UI de settings-integraciones al añadir
   * o editar una key. Retorna capabilities detectadas.
   */
  validateKey(input: ValidateKeyInput): Promise<ValidateKeyOutput>;

  /**
   * Rota la KEK de un tenant. No re-cifra DEKs individualmente;
   * marca DEKs como `legacyKekVersion` y las re-cifra bajo demanda
   * en la próxima call() (rotación perezosa).
   */
  rotateKek(tenantId: string): Promise<void>;

  /**
   * Invalida la key BYOK de un usuario (por ejemplo si el
   * proveedor revocó la key o si el usuario la quitó en UI).
   * Escribe audit entry y limpia caches.
   */
  invalidateUserKey(
    userId: string,
    reason: InvalidationReason,
  ): Promise<void>;
}
```

### 3.3 Shape de `LLMCallInput`

```ts
export interface LLMCallInput {
  /** ID del usuario dueño del request (determina plan + key BYOK). */
  userId: string;

  /** Contexto de exposición — crítico para defensa MCP. */
  exposureScope: 'internal' | 'mcp-callable';

  /** Origen lógico del request (para tracing + audit). */
  origin:
    | 'assistant-conversation'   // chat con asistente de Foco
    | 'script-generation'         // generación de guion de video
    | 'caption-refine'            // refinamiento de captions
    | 'hook-brainstorm'           // ideación de hooks
    | 'mcp-server-callback';      // respuesta a IA externa via MCP

  /** Request normalizado (provider-agnóstico). */
  request: NormalizedLLMRequest;

  /** Hint de proveedor preferido; el router puede ignorarlo. */
  providerHint?: 'anthropic' | 'openai' | 'gemini';

  /** W3C traceparent del span padre. Obligatorio en producción. */
  traceparent: string;

  /** Idempotency key para retries seguros del caller. */
  idempotencyKey?: string;
}

export interface NormalizedLLMRequest {
  model:
    | 'claude-opus-4-6'
    | 'claude-sonnet-4-6'
    | 'claude-haiku-4-5'
    | 'gpt-5'                      // placeholder — confirmar al lanzar
    | 'gpt-5-mini'
    | 'gemini-2.5-pro'
    | 'gemini-2.5-flash';
  messages: NormalizedMessage[];
  systemPrompt?: string;
  maxTokens: number;               // obligatorio, no default
  temperature?: number;            // [0, 1]
  stopSequences?: string[];
  toolDefinitions?: NormalizedTool[];
  responseFormat?: 'text' | 'json_object';
}

export interface NormalizedMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | NormalizedContentBlock[];
}
```

### 3.4 Shape de `LLMCallOutput`

```ts
export interface LLMCallOutput {
  /** Modelo efectivamente usado (puede diferir de request.model
      si hubo fallback). */
  modelUsed: string;

  /** Proveedor que atendió la llamada. */
  providerUsed: 'anthropic' | 'openai' | 'gemini';

  /** Modo de financiación resuelto — para analytics, nunca UI. */
  fundingMode: 'byok' | 'managed';

  /** Mensaje de respuesta normalizado. */
  message: NormalizedMessage;

  /** Tokens consumidos. Siempre presente (BYOK también cuenta). */
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };

  /** Razón de terminación. */
  stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'tool_use';

  /** Latencia end-to-end en ms (incluye descifrado de key). */
  latencyMs: number;

  /** ID del request en el proveedor (para debugging con soporte). */
  providerRequestId?: string;
}
```

### 3.5 Taxonomía de errores

```ts
export type LLMCallError =
  | { kind: 'invalid_key'; provider: string; userMessage: string }
  | { kind: 'quota_exhausted'; provider: string; userMessage: string }
  | { kind: 'rate_limit'; provider: string; retryAfterSec?: number }
  | { kind: 'provider_down'; provider: string; circuitOpen: boolean }
  | { kind: 'content_blocked'; reason: 'moderation' | 'safety' }
  | { kind: 'context_too_long'; maxTokens: number; actual: number }
  | { kind: 'kms_unavailable'; transient: boolean }
  | { kind: 'routing_disabled'; flag: string }
  | { kind: 'plan_requires_key'; plan: 'free' | 'creator' }
  | { kind: 'network_error'; transient: boolean }
  | { kind: 'internal'; correlationId: string };
```

`LLMClient.call()` **nunca lanza**; siempre resuelve
`Promise<Result<LLMCallOutput, LLMCallError>>`. Esto fuerza a los
callers a tratar errores explícitamente en vez de caer en el
`catch` genérico que pierde estructura.

## 4 · Plan-aware routing

### 4.1 Matriz de decisión

| Plan        | Modo primario | Fallback si primario falla | `llmKeyProvider` requerido |
|-------------|---------------|-----------------------------|----------------------------|
| Free        | BYOK          | *ninguno* → `plan_requires_key` error | Sí (obligatorio) |
| Creator     | BYOK          | *ninguno* → `plan_requires_key` error | Sí (obligatorio) |
| Influencer  | Managed       | BYOK del usuario si tiene `preferMyKey=true` + key válida | Opcional |
| Celebrity   | Managed       | BYOK del usuario si tiene `preferMyKey=true` + key válida | Opcional |
| Studio      | Managed       | Pool alternativa configurada por SLA | Opcional |

El `preferMyKey` toggle en `settings-integraciones` solo tiene
efecto en Influencer+. Para Free/Creator, BYOK es el único modo;
no hay fallback a pool de Foco (sería regalo gratis del modelo
económico). Si un Free/Creator no tiene key válida, devolvemos
`plan_requires_key` y la UI muestra modal "agrega tu API key para
continuar" con deep-link a `settings-integraciones`.

### 4.2 Fallback chain y circuit breakers

Orden de intento por cada llamada:

```
1. Proveedor primario según plan (BYOK o pool).
   Si circuit-breaker abierto para ese proveedor → saltar.
2. Si Influencer+ con preferMyKey=true y BYOK válido → usar BYOK.
3. Si Studio con pool alternativa configurada → usar alternativa.
4. Si ningún candidato viable → devolver error estructurado.
```

**Nunca se prueba silenciosamente** una key del usuario como
fallback si él no la tiene marcada en `preferMyKey`. La autoridad
de esa decisión es del usuario, no del sistema.

**Circuit breaker por proveedor**: ventana deslizante de 60s.
Abre cuando error rate >30% y volumen >20 requests. Estado
`open` por 30s, luego `half-open` permite 3 probes; si fallan,
re-abre. Implementado en `routing/fallback.ts`, observable vía
métrica `llm_circuit_state{provider="anthropic"|"openai"|"gemini"}`.

### 4.3 Idempotency y retries

Si el caller proporciona `idempotencyKey`, `LLMClient` persiste el
resultado del primer intento en Redis (cluster regional de Upstash)
por 10min y lo devuelve tal cual en reintentos con la misma key.
Sin `idempotencyKey`, cada `.call()` es un request nuevo.

**Semántica precisa de la idempotency** (corregida tras peer
review): garantiza que **no se duplican side-effects** (billing de
tokens, audit entries, incremento de cuotas, llamada facturable al
proveedor). **No garantiza determinismo del output textual** del
LLM, porque los modelos generativos no son determinísticos aunque
reciban el mismo input (ni Anthropic ni OpenAI prometen
determinismo contractual, ni siquiera con `temperature=0`).

Consecuencia operacional: si el caller invoca `.call()` con
idempotencyKey K y recibe output O1, una re-invocación con la
misma K devuelve O1 (servido del cache). Pero si la primera call
falla post-timeout **antes de escribir el cache** y el caller
reintenta sin idempotencyKey, **puede obtener O2 ≠ O1** — eso no
es un bug, es la naturaleza del modelo generativo. Los consumidores
del cliente deben documentarlo en sus propios contratos si O1
ya era observado externamente.

Retries internos del cliente (distintos de idempotency):
- Para `network_error { transient: true }` y `rate_limit` con
  backoff exponencial (1s, 2s, 4s; máx 3 intentos).
- Para `kms_unavailable { transient: true }`: 1 retry con jitter
  50–250ms (ver §2 invariante 5).
- **Nunca reintentamos**: `invalid_key`, `quota_exhausted`,
  `content_blocked`, `context_too_long`,
  `kms_unavailable { transient: false }`, `plan_requires_key`,
  `routing_disabled`.

**Deadline propagation (protección contra amplificación de
carga)**. Todo retry respeta el deadline del span padre de
OpenTelemetry:

- Si el span padre tiene `deadline` explícito y
  `timeout_remaining < (max_jitter_ms + latencia_esperada_p95)`,
  el retry **se suprime** y el error se propaga inmediato. Esto
  evita que el retry cueste más de lo que al caller le queda de
  presupuesto de tiempo y evita amplificar carga sobre un
  downstream degradado cuando el cliente de todos modos ya habrá
  timed-out.
- En código: cada call path lee `traceparent.deadline` (o en su
  defecto `AbortSignal.timeout_remaining`) antes de decidir
  reintentar.
- Métrica: `llm_retries_skipped_deadline_total{reason=...}` para
  observar cuántos retries se suprimen por deadline propagation.

**Retry budget KMS fijo (no flag-configurable a >1)**. El flag
`llm.kms.retry_count` existe en §16 pero su validación al arranque
(§16 "Validación de flags") impone `max = 1`. Razón operativa: un
retry = ok; 2+ retries simultáneos desde N workers amplifican la
presión sobre una región KMS ya degradada y alargan el radio del
incidente. Si se necesitara subir más allá de 1 en una emergencia,
requiere PR al doc + deploy (cambio auditable en git), no un toggle
de flag.

## 5 · Envelope encryption de keys BYOK

### 5.1 Modelo criptográfico

Dos niveles:

- **KEK (Key Encryption Key)**: **una por shard** de ~1.000
  usuarios (asignación determinística:
  `shardId = hash(userId, kekVersion) mod N`, con N dimensionado
  para mantener ~1k users/shard **dentro de una `kekVersion`
  dada**). Vive en **AWS KMS** (decisión cerrada v0.2,
  ver §5.2). Nunca sale del HSM en claro. Se invoca para
  operaciones `Encrypt` / `Decrypt` sobre DEKs; nunca sobre la key
  de usuario directamente. **Rationale de shard**: KEK por usuario
  individual implica ~$1/user/mes en KMS fijo + ops, insostenible
  a volumen Free/Creator. KEK por shard amortiza el fijo a
  ~$0.001/user manteniendo blast radius acotado (un KEK
  comprometido = re-wrap de ~1k users, no toda la plataforma).
  Ver cálculo explícito en §5.2.

  **Sharding version (`kekVersion`)**: cada DEK persiste junto con
  el `kekVersion` bajo el cual su `shardId` fue calculado. `N` (el
  número de shards) es **inmutable dentro de una `kekVersion`**; si
  el crecimiento de usuarios requiere rebalance (ej. de N=10 a
  N=100 al pasar de 10k a 100k usuarios activos), se introduce
  `kekVersion = prev + 1` con nuevo `N`, y las DEKs migran a la
  nueva versión por **re-wrap offline en batch** (ver §5.3
  "Rebalance"). Nunca se hace un rehash sobre `kekVersion` vigente.
- **DEK (Data Encryption Key)**: generada aleatoriamente (AES-256
  via `crypto.randomBytes(32)`) cada vez que el usuario *agrega* o
  *rota* su key BYOK. Cifra la key del proveedor con AES-256-GCM.
  Se almacena en DB junto al ciphertext de la key, cifrada con KEK.

Flujo al **agregar** una key BYOK:

```
1. UI -> API edge: { provider: 'anthropic', key: 'sk-ant-...' }
   vía TLS 1.3, HSTS, CSP estricta.
2. Edge valida TLS + session + CSRF token.
3. Edge genera DEK = randomBytes(32).
4. Edge cifra key_plaintext con DEK (AES-256-GCM, nonce aleatorio).
   -> { ciphertext, nonce, authTag }
5. Edge lee `kekVersion = current_kek_version()` (global, leído
   de config de deploy; single source of truth). Calcula
   `shardId = hash(userId, kekVersion) mod N(kekVersion)` y pide
   a KMS: Encrypt(
     kekAlias=`foco/kek/v${kekVersion}/shard-${shardId}`, DEK
   ) -> dekCiphertext.
6. DB insert a `user_llm_key`:
   {
     userId, kekVersion, shardId, provider,
     keyCiphertext, keyNonce, keyAuthTag, dekCiphertext,
     maskedHint: 'sk-ant-...xY7q',  // últimos 4 chars para UI
     status: 'pending_validation',
     createdAt, updatedAt
   }
7. Edge dispara validateKey() asincrónico; al volver "valid",
   marca status='active'.
8. key_plaintext y DEK se zeroizan en memoria del edge tras paso 5.
```

Flujo al **leer** una key en runtime (dentro de `LLMClient.call()`):

```
1. Worker fetch de row `user_llm_key` por userId. Row incluye
   {kekVersion, shardId, dekCiphertext, keyCiphertext, ...}.
2. Worker consulta cache in-process (`dek_cache`) con
   key = (userId, kekVersion). Hit: salta al paso 4 con DEK del
   cache. Miss por kekVersion distinta (row re-wrapped por
   rotación/rebalance): cuenta como stale_hit
   (`llm_dek_cache_stale_hits_total{reason=version_mismatch}`),
   purga la entrada vieja del userId, sigue a paso 3.
3. Worker pide a KMS: Decrypt(
     kekAlias=`foco/kek/v${kekVersion}/shard-${shardId}`,
     dekCiphertext
   ) -> DEK. Si KMS falla con error transitorio **y el deadline
   del span padre lo permite** (ver §4.3 "Deadline propagation"),
   1 retry con jitter 50–250ms. Si el retry falla o el deadline
   no alcanza, fail-closed con `kms_unavailable`.
4. Worker descifra keyCiphertext con DEK -> key_plaintext.
5. Worker usa key_plaintext durante el request HTTP al proveedor;
   al cerrar el request, zeroiza key_plaintext con `buffer.fill(0)`
   sobre el buffer original.
6. DEK permanece en cache in-process del worker con TTL ≤5 min
   (configurable vía flag `llm.dek_cache.ttl_seconds`, default
   300; ver §16 "Validación de flags" para bounds). Al eviction,
   se zeroiza también. Al invocar `invalidateUserKey(userId)` se
   purgan **todas** las entradas del cache cuya primera
   componente sea ese userId, sin importar la `kekVersion`
   (invalidación cross-version completa). El cache NO es
   distribuido, NO se serializa, NO cruza procesos. Ver §2
   invariante 8 para el threat model.
```

### 5.2 KMS selection

**Decisión cerrada v0.2: AWS KMS**, con alias
`alias/foco/kek/shard-${shardId}` y política IAM restringida al rol
`role/foco-llm-client-worker`. Justificación:

- FIPS 140-2 Level 2 (HSM certificado).
- `CreateKey` + `ScheduleKeyDeletion` + audit CloudTrail maduro.
- Rotación automática anual de material criptográfico soportada
  nativamente.
- Integración con KMS Condition Keys para requerir VPC endpoint
  (evita leaks sobre internet público).

**Cálculo de costo con KEK por shard** (cerrado en primer peer
review). Asumiendo $1/KEK/mes + $0.03 por 10k ops Encrypt/Decrypt y
N = 1 KEK por cada 1.000 usuarios activos; volumen estimado 100
calls/usuario/día × 30 días = 3.000 ops/usuario/mes antes de cache:

| Usuarios | KEKs | Fijo KEK | Ops/mes (sin cache) | Costo ops | Total/mes | Por usuario |
|----------|------|----------|---------------------|-----------|-----------|-------------|
| 1.000    | 1    | $1       | 3M                  | $9        | $10       | $0.010      |
| 10.000   | 10   | $10      | 30M                 | $90       | $100      | $0.010      |
| 100.000  | 100  | $100     | 300M                | $900      | $1.000    | $0.010      |

Comparativa: KEK por usuario individual escalaría a ~$1.009/usuario
(tres órdenes de magnitud más caro). Cache in-process de DEK (§2
invariante 8) reduce ops/mes entre ×10 y ×100 según hit rate,
dejando el costo operativo real muy por debajo de $0.010/usuario.

**Alternativa descartada: Supabase Vault**. Motivo: no provee
rotación automática ni attestation HSM; su threat model asume
adversary con Postgres superuser puede leer (lo que rompe
invariante 3). El ahorro hipotético no justifica el debilitamiento
criptográfico.

### 5.3 Rotación y revocación

**KEK rotation** (tenant-level, cada 12 meses o a demanda, **sin
cambio de `N` shards**):

- Nueva KEK-v2 creada en KMS, alias
  `foco/kek/v2/shard-${shardId}` creado para cada shard; la
  partición `N` permanece idéntica.
- DEKs existentes permanecen cifradas con KEK-v1 (`kekVersion=1`).
- En la próxima `.call()` de ese usuario, si `kekVersion < current`,
  el cliente re-cifra la DEK con KEK-v2 y hace UPDATE atómico de la
  row (incluyendo `kekVersion = 2`). Rotación perezosa. Cache
  in-process invalida la entrada vieja como stale_hit (ver §5.1
  flujo de lectura, paso 2).
- KEK-v1 se marca `PendingDeletion` en KMS con ventana de 30 días
  (safety net en caso de bug de migración).

**Rebalance de sharding** (cambio de `N`, típicamente cuando el
volumen de usuarios crece 10×):

- Rebalance es un evento **offline planificado**, no on-the-fly.
  Se documenta en `docs/runbooks/llm-kek-rebalance.md` (pendiente,
  owner: DevOps); aquí fijamos el contrato.
- Un rebalance de `N_old → N_new` requiere una **nueva
  `kekVersion`** (no re-usar la actual con más shards, porque
  `hash(userId, kekVersion) mod N` cambiaría con `N` y romperían
  todos los lookups en flight).
- Procedimiento:
  1. Crear KEK-v(k+1) con N_new shards en KMS.
  2. Job batch offline lee cada row de `user_llm_key` con
     `kekVersion = k`, descifra DEK con KEK-vk, calcula nuevo
     `shardId_new = hash(userId, k+1) mod N_new`, re-cifra DEK con
     KEK-v(k+1) correspondiente, UPDATE atómico de la row con
     `{kekVersion = k+1, shardId = shardId_new, dekCiphertext =
     nuevo}`.
  3. Durante la ventana de rebalance (horas), lecturas concurrentes
     siguen sirviéndose por `kekVersion` en la row (cada row apunta
     a su versión vigente). Workers nuevos reciben nueva config de
     `current_kek_version` tras finalizar el batch.
  4. KEK-vk entra a `PendingDeletion` tras 30 días.
- Invariante de rebalance: **un usuario nunca tiene dos rows
  activas** — la transición de k→k+1 es UPDATE atómico, no
  INSERT + DELETE. Query lookup siempre devuelve exactamente la
  versión correcta.
- Triggers: rebalance se considera cuando (a) promedio users/shard
  > 2.000 (carga), (b) std-dev de shards > 30% del promedio (hot
  shards detectados vía `llm_kek_shard_distribution`), o (c)
  crecimiento proyectado del orden de magnitud en 90 días.

**Key revocation** (el usuario quita su key en UI, o el proveedor
la invalida):

- Row `user_llm_key` UPDATE status='revoked', `revokedAt=now()`.
- `keyCiphertext`, `dekCiphertext`, `maskedHint` se setean a NULL.
  Solo queda la row como tombstone para audit.
- Audit entry `llm_key_invalidated` escrito en
  `system_audit` con hash chain (ver §11).
- Caches en workers se limpian via mensaje Redis
  `llm_key_invalidated:<userId>`; los workers drop sus memoizations.

### 5.4 Zero-read policy

Post-save, la key de usuario **nunca** es legible por humanos
(incluyendo DevOps de Foco con acceso a DB):

- La row `user_llm_key` tiene RLS en Postgres: solo accesible por
  `role/foco-llm-client-worker` vía service-role-key que vive en
  Doppler.
- No hay endpoint HTTP que devuelva la key en claro. Ni en DSR
  export, ni en admin panel, ni en logs de depuración.
- La UI de `settings-integraciones` muestra `maskedHint`
  (`sk-ant-...xY7q`) como único texto visible. Para "editar" la
  key, el usuario ingresa una nueva completa (que reemplaza la
  anterior atómicamente); no hay "show current key".
- CI test: grep sobre logs de pre-prod en últimos 7 días para
  patrones `sk-ant-[a-zA-Z0-9]{40,}` y `sk-[a-zA-Z0-9]{40,}`; si
  match, bloquea el deploy.

## 6 · Validación al setup

Cuando el usuario agrega o edita una key en
`settings-integraciones`, `LLMClient.validateKey()` hace un **ping
barato** al proveedor para confirmar que la key funciona:

| Proveedor  | Endpoint ping                  | Cuerpo                                  | Coste aprox. |
|------------|--------------------------------|-----------------------------------------|--------------|
| Anthropic  | `POST /v1/messages`            | `claude-haiku-4-5`, 1 msg, max_tokens=1 | ~$0.00001    |
| OpenAI     | `POST /v1/chat/completions`    | `gpt-5-mini`, 1 msg, max_tokens=1       | ~$0.00001    |

El costo lo asume el usuario (es su key). El ping extrae del
response:

- **Validez**: si 200 OK → `status='active'`; si 401/403 →
  `status='invalid'`; si 429 → `status='quota_exhausted'`.
- **Capabilities** (stretch v0.2): lista de modelos accesibles,
  rate limits reportados por el proveedor. Guardado en
  `user_llm_key.capabilities` para UI hints ("Tu key tiene acceso
  a Opus 4.6 ✓").

El ping también corre **periódicamente** (cada 24h vía cron job de
Inngest) para proactivamente detectar keys revocadas o sin cuota
antes de que el usuario intente generar. En caso de cambio de
estado, UI push vía Supabase Realtime + email notificación.

## 7 · Error handling en runtime

### 7.1 Detección y mapeo desde proveedores

| Síntoma del proveedor                | `LLMCallError.kind`       |
|--------------------------------------|----------------------------|
| HTTP 401 / 403                       | `invalid_key`              |
| HTTP 429 con `retry-after`           | `rate_limit`               |
| HTTP 402 / billing error             | `quota_exhausted`          |
| HTTP 500/502/503/504                 | `provider_down`            |
| HTTP 400 `context_length_exceeded`   | `context_too_long`         |
| HTTP 400 content filter / policy     | `content_blocked`          |
| TCP / DNS / TLS error                | `network_error { transient: true }` |
| Timeout (>60s total)                 | `network_error { transient: true }` |
| KMS API error (5xx, throttle)        | `kms_unavailable { transient: true }`, 1 retry con jitter (§2 inv. 5) |
| KMS `InvalidCiphertextException`     | `kms_unavailable { transient: false }`, no retry |
| Feature flag `llm_routing_enabled`=off | `routing_disabled`       |
| Free/Creator sin key                 | `plan_requires_key`        |
| Caso no mapeado                      | `internal`                 |

### 7.2 UX de errores (modal no-bloqueante)

Siguiendo `project_foco_byok_model.md` §"Error handling":

- `invalid_key` / `quota_exhausted` → modal con 3 opciones:
  "[Ver dashboard de <proveedor>]", "[Cambiar key]", "[Upgrade a
  Influencer]". No cobra el plan del usuario mientras el estado
  sea `invalid` (confianza).
- `rate_limit` → toast "Reintentando en Xs…" sin interacción,
  retry interno del cliente.
- `provider_down` → banner global "Servicio de IA degradado" +
  email status-page.
- `content_blocked` → modal "El contenido fue bloqueado por
  políticas de <proveedor>. Intenta reformular." (sin detalles
  para no enseñar bypass).
- `plan_requires_key` → onboarding modal con CTA directa a
  `settings-integraciones`.

### 7.3 Redacción de errores en logs/audit

Los errores se serializan en logs/audit con **solo** estos campos:
`kind`, `provider`, `correlationId`, `timestamp`, `userId` (hash).
Nunca `keyCiphertext`, `keyNonce`, `traceparent` completo,
contenido del prompt, ni response body del proveedor.

## 8 · Token accounting

**Por qué contamos tokens también en BYOK (no solo en Managed).**
Aunque Free/Creator pagan su propio LLM vía BYOK, Foco cuenta
tokens en todos los planes por tres razones **explícitas y
declaradas al usuario** (Privacy Policy + texto de consentimiento
en `settings-integraciones`):

1. **UI de uso**: el usuario ve su consumo mensual en
   `settings-integraciones` → "Uso de IA" (sparkline + totales por
   origen). Es transparencia sobre cuánto está gastando en su
   propia cuenta del proveedor.
2. **Detección de abuso**: heurísticas de §8.3 previenen
   distilación de modelo, scraping sistemático y otros usos fuera
   de Términos de Servicio de Foco (que el usuario acepta al
   registrarse).
3. **Analytics de producto**: distribución agregada de `origin`
   (asistente vs generación vs MCP) informa priorización de
   features. Los datos son agregados y anonimizados; no se
   correlacionan con identidad fuera del equipo de producto.

**Nunca** se usa el conteo BYOK para billing directo al usuario.
Es consentimiento informado, no tracking encubierto. Esta posición
está publicada en Privacy Policy (en construcción) y reforzada en
el consent modal de `settings-integraciones` cuando el usuario
agrega su primera key.

**Dos modos de accounting según el consent** (el usuario controla
explícitamente el nivel de telemetría sobre su uso BYOK):

- **`consent_mode = 'full'`** (default al aceptar Privacy Policy):
  se contabiliza todo lo descrito en §8.1 — `input_tokens`,
  `output_tokens`, `model`, `origin`, `provider`, `latency_ms`.
  Habilita la UI de uso detallada, detección de abuso, y analytics
  agregadas.
- **`consent_mode = 'minimal'`** (opt-out explícito en
  `settings-integraciones → Privacidad`): solo se escribe una row
  mínima a `llm_token_usage` con `{user_id, occurred_at, provider,
  input_tokens = NULL, output_tokens = NULL}`. Queda `COUNT(*)` por
  usuario/hora para detección de abuso (razón 2 arriba), pero la
  UI de uso degrada a "X llamadas este mes" sin totales de tokens,
  y las analytics agregadas excluyen a estos usuarios. La
  detección de abuso por volumen de requests sigue funcionando; la
  heurística de `tokens/hora` (§8.3) se salta para estos usuarios
  y aplica solo `requests/hora`.

El campo `user_llm_key.consent_mode = 'full' | 'minimal'` es
auditable (`llm.consent_mode_changed` entry en `system_audit`).
El usuario puede cambiar de modo en cualquier momento; el cambio
aplica de ahí en adelante, sin migrar rows históricas.

### 8.1 Contadores por request

Cada `.call()` exitoso escribe una row a `llm_token_usage`:

```sql
CREATE TABLE llm_token_usage (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider        TEXT NOT NULL,           -- 'anthropic'|'openai'|'gemini'
  model           TEXT NOT NULL,
  funding_mode    TEXT NOT NULL,           -- 'byok'|'managed'
  origin          TEXT NOT NULL,           -- enum de LLMCallInput.origin
  input_tokens    INT NOT NULL,
  output_tokens   INT NOT NULL,
  latency_ms      INT NOT NULL,
  trace_id        TEXT NOT NULL            -- para joins con Tempo
);
CREATE INDEX idx_llm_usage_user_day
  ON llm_token_usage (user_id, date_trunc('day', occurred_at));
```

### 8.2 Agregación diaria y mensual

Vista materializada `llm_usage_daily` refrescada cada hora:

```sql
CREATE MATERIALIZED VIEW llm_usage_daily AS
SELECT
  user_id,
  date_trunc('day', occurred_at) AS day,
  funding_mode,
  SUM(input_tokens + output_tokens) AS total_tokens,
  COUNT(*) AS call_count
FROM llm_token_usage
GROUP BY user_id, day, funding_mode;
```

Alimenta:

- UI de `settings-integraciones` → sección "Uso de IA" con sparkline.
- Endpoint de `UserQuota.usage.llmTokensThisPeriod` consultado por
  el dashboard.
- Panel Grafana `foco-llm-usage` para ingeniería.

### 8.3 Detección de abuso

Heurísticas que disparan audit entry `llm_abuse_suspected`:

- Free/Creator con >10k tokens/hora sostenido 3h → posible
  distilación de modelo.
- Mismo prompt hash repetido >100 veces/día → posible scraping.
- `fundingMode=managed` con costo estimado >3× la media p95 del
  plan → revisar manualmente.

Las heurísticas NO bloquean automáticamente (falsos positivos son
caros). Solo escriben audit + notifican a #foco-abuse en Slack via
incident.io.

## 9 · Proveedores soportados en MVP

### 9.1 Anthropic (Messages API)

- Endpoint base: `https://api.anthropic.com/v1/messages`
- Auth header: `x-api-key: <userKey>` (BYOK) o clave de pool
  (`ANTHROPIC_API_KEY` en Doppler, path `foco/prod/llm/anthropic/pool/primary`).
- Modelos MVP: `claude-opus-4-6`, `claude-sonnet-4-6`,
  `claude-haiku-4-5`.
- Feature support mapeado: tool use ✓, system prompts ✓,
  stop sequences ✓, streaming (fuera de MVP v0.1).
- Peculiaridades: response.usage devuelve
  `{input_tokens, output_tokens}` separadamente — mapeo directo a
  `LLMCallOutput.usage`.

### 9.2 OpenAI (Chat Completions)

- Endpoint base: `https://api.openai.com/v1/chat/completions`
- Auth header: `Authorization: Bearer <userKey>` (BYOK) o pool.
- Modelos MVP: `gpt-5`, `gpt-5-mini` (nombres placeholders;
  confirmar al lanzar).
- Feature support: tool use ✓, response_format `json_object` ✓,
  stop sequences ✓.
- Peculiaridades: `usage.prompt_tokens` + `usage.completion_tokens`
  (nombres distintos a Anthropic — traducción interna).

### 9.3 Google Gemini (AI Studio / Gemini API directa)

- Endpoint base:
  `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`
- Auth: API key vía query param `?key=<userKey>` **o** header
  `x-goog-api-key: <userKey>` (Foco usa el header para que la key
  **no aparezca en el access log**; query params quedarían
  logueados por default en balancers y CDNs — invariante §2 #1).
- Modelos MVP: `gemini-2.5-pro`, `gemini-2.5-flash`.
- **Path deliberadamente elegido**: Gemini API directa (AI Studio),
  **no** Vertex AI. Rationale: el usuario BYOK consigue su key en
  aistudio.google.com en <1 min; Vertex requeriría proyecto GCP +
  service account JSON — hostil para Free/Creator. Vertex AI sigue
  fuera del MVP (§15).
- Feature support: tool use ✓ (nombre `functionDeclarations`),
  `response_mime_type: 'application/json'` como equivalente a
  `json_object` ✓, stop sequences ✓ (campo `stopSequences` en
  `generationConfig`), streaming ✗ (fuera de MVP como Anthropic/
  OpenAI).
- Peculiaridades del wire format:
  - **Mensajes**: `contents: [{ role: 'user'|'model', parts: [...] }]`
    — nota `'model'` en vez de `'assistant'`. Traducción interna
    del `NormalizedMessage`.
  - **System prompt**: campo separado `systemInstruction`, no va
    dentro de `contents`.
  - **`generationConfig`**: agrupa `maxOutputTokens` (no
    `max_tokens`), `temperature`, `stopSequences`, `topP`, `topK`.
  - **Usage**: `usageMetadata: { promptTokenCount,
    candidatesTokenCount, totalTokenCount }` — mapeo a
    `LLMCallOutput.usage` como `inputTokens=promptTokenCount`,
    `outputTokens=candidatesTokenCount`,
    `totalTokens=totalTokenCount`.
  - **Stop reason**: `candidates[0].finishReason` ∈ `{'STOP',
    'MAX_TOKENS', 'SAFETY', 'RECITATION', 'OTHER'}` — mapeo a
    `stopReason`: `STOP`→`end_turn`, `MAX_TOKENS`→`max_tokens`,
    `SAFETY`/`RECITATION`→devolver `LLMCallError.content_blocked`
    (no normalizar como output exitoso).
  - **Errores**: HTTP 400 con `error.status='INVALID_ARGUMENT'` y
    `error.message` conteniendo "API key not valid" →
    `invalid_key`; `RESOURCE_EXHAUSTED` → `rate_limit` o
    `quota_exhausted` según cuerpo; `PERMISSION_DENIED` sin billing
    habilitado → `quota_exhausted`.
- **Circuit breaker**: misma ventana y umbrales que Anthropic/
  OpenAI (flags compartidos — ver §16). Estado observable en
  `llm_circuit_state{provider="gemini"}`.
- **Pool Managed**: key en Doppler path
  `foco/prod/llm/gemini/pool/primary`.

### 9.4 Interface `Provider`

```ts
export interface Provider {
  readonly name: 'anthropic' | 'openai' | 'gemini';

  /**
   * Mapea un `NormalizedLLMRequest` al wire format del proveedor,
   * ejecuta el request HTTP, y devuelve el response normalizado o
   * un error clasificado.
   */
  call(
    apiKey: string,
    request: NormalizedLLMRequest,
    abortSignal: AbortSignal,
  ): Promise<Result<ProviderCallOutput, LLMCallError>>;

  /** Ping barato para validación. */
  ping(apiKey: string): Promise<Result<PingOutput, LLMCallError>>;
}
```

Agregar un proveedor nuevo requiere implementar esta interface +
añadir el enum correspondiente en `LLMCallOutput.providerUsed`,
`LLMCallInput.providerHint` y `Provider.name`. MVP v1.1 incluye
Anthropic + OpenAI + Gemini (vía AI Studio). Post-MVP contemplados:
Azure OpenAI, Google **Vertex AI** (path alternativo a Gemini con
service account GCP), Mistral, AWS Bedrock. Ver §15.

## 10 · Observability

### 10.1 Tracing (OpenTelemetry)

Cada `.call()` crea un span `llm.client.call` con atributos:

```
llm.provider               = "anthropic" | "openai" | "gemini"
llm.model                  = <model usado>
llm.funding_mode           = "byok" | "managed"
llm.origin                 = <origin enum>
llm.input_tokens           = <int>
llm.output_tokens          = <int>
llm.latency_ms             = <int>
llm.circuit_state          = "closed" | "half-open" | "open"
user.id_hash               = sha256(userId)         # nunca userId en claro
trace.idempotency_key_hash = sha256(idempotencyKey) # opcional
```

Sub-spans:
- `llm.kms.decrypt_dek` (solo BYOK, latencia KMS aislada)
- `llm.provider.request` (latencia HTTP pura)
- `llm.accounting.write` (insert a `llm_token_usage`)

**Nunca** como atributo: `llm.api_key`, `llm.key_ciphertext`, o
cualquier contenido de prompt/response bodies.

### 10.2 Métricas (Mimir via OTel)

```
llm_calls_total{provider, funding_mode, origin, status}         counter
llm_latency_ms{provider, model}                                 histogram
llm_tokens_total{provider, model, direction=in|out}             counter
llm_errors_total{provider, kind}                                counter
llm_circuit_state{provider}                                     gauge (0|1|2)
llm_kms_latency_ms{operation=encrypt|decrypt}                   histogram
llm_kms_induced_failures_total{operation, transient}            counter
llm_kms_retries_total{operation, outcome=success|fail}          counter
llm_kms_retry_success_ratio                                     gauge
llm_retries_skipped_deadline_total{operation}                   counter
llm_key_invalidations_total{provider, reason}                   counter
llm_dek_cache_hits_total{worker}                                counter
llm_dek_cache_misses_total{worker}                              counter
llm_dek_cache_stale_hits_total{worker, reason=version_mismatch} counter
llm_dek_cache_evictions_total{worker, reason=ttl|manual}        counter
llm_kek_shard_distribution{kek_version, shard_id}               gauge
llm_kek_rebalance_progress{from_version, to_version}            gauge (0-1)
```

Notas operativas:

- `llm_kms_retry_success_ratio` = `llm_kms_retries_total{outcome="success"}`
  / `llm_kms_retries_total{*}`. Si cae bajo 0.5 sostenido 10min → alerta
  (el retry no está ayudando; probablemente region down).
- `llm_kek_shard_distribution` se emite una vez por minuto desde un job
  de observabilidad (no por request). Permite detectar hot shards
  (std-dev > 30% del promedio dispara warning Grafana).
- `llm_retries_skipped_deadline_total` alto indica spans con deadlines
  demasiado ajustados; señal para revisar UX timeouts.

### 10.3 Logs (pino → Loki)

Solo estos niveles, con redacción automática:

```ts
logger.info({ event: 'llm_call_started', userId_hash, provider, origin });
logger.info({ event: 'llm_call_completed', userId_hash, provider,
              inputTokens, outputTokens, latencyMs });
logger.warn({ event: 'llm_fallback_used', userId_hash, primary,
              fallback, reason });
logger.error({ event: 'llm_call_failed', userId_hash, provider,
               errorKind, correlationId });
```

El logger lleva un transport de redacción que detecta patrones
`sk-ant-[a-zA-Z0-9]{40,}`, `sk-[a-zA-Z0-9]{40,}` y cualquier
string con `apiKey`/`api_key`/`x-api-key` como key de objeto, y
reemplaza por `[REDACTED]`. Test de CI: inyectar payload con key
fake y verificar que el output no contiene el plaintext.

## 11 · Audit entries

Toda mutación del ciclo de vida de key BYOK o llamada Managed de
costo notable escribe `SystemAuditEntry` (schema firmado en
`@chisu/schemas`). Eventos:

| `action`                      | Cuándo                                   | Body relevante |
|-------------------------------|------------------------------------------|----------------|
| `llm.key_added`               | Usuario agrega key en UI                 | provider, maskedHint, validationStatus |
| `llm.key_rotated`             | Usuario reemplaza key                    | provider, oldMaskedHint, newMaskedHint |
| `llm.key_invalidated`         | Revocación (user-triggered o detectada)  | provider, reason, maskedHint |
| `llm.kek_rotated`             | KEK pool rotation ejecutada              | tenantId, oldKekVersion, newKekVersion |
| `llm.managed_call_high_spend` | Managed single call con costo > p95 × 3  | userId_hash, provider, model, tokens, estimatedCost |
| `llm.abuse_suspected`         | Trigger de heurística §8.3               | userId_hash, heuristic, window |
| `llm.circuit_opened`          | Circuit breaker transición closed→open   | provider, errorRate, volume |
| `llm.circuit_closed`          | Transición half-open→closed              | provider |

Todas las entries respetan el hash chain de
`PRODUCTION_READINESS.md §3` (append-only, firmado con cosign en
dump mensual a R2 Object Lock).

## 12 · Integración con `UserQuota`

El schema `UserQuota` (firmado en `@chisu/schemas`) se extiende
con los campos declarados en `project_foco_byok_model.md`:

```ts
export interface UserQuota {
  // ... campos existentes de UX_FROZEN §3.6 ...
  llmKeyProvider: 'anthropic' | 'openai' | 'gemini' | null;
  llmKeyStatus:
    | 'active'
    | 'invalid'
    | 'quota_exhausted'
    | 'not_set'
    | 'pending_validation';
  llmPreferMyKey: boolean;                    // Influencer+ toggle
  llmTokensThisPeriod: {
    byok:    { input: number; output: number };
    managed: { input: number; output: number };
  };
}
```

Este bloque es **derivado** de `user_llm_key` + `llm_usage_daily`;
nunca es fuente de verdad. El endpoint `GET /api/v1/user/quota`
lo computa en lectura.

## 13 · SLOs y failure modes

### 13.1 SLOs del cliente

| Métrica                                        | SLO (MVP)        |
|------------------------------------------------|------------------|
| `.call()` p50 latency (excluyendo modelo)      | < 200ms          |
| `.call()` p95 latency (excluyendo modelo)      | < 600ms          |
| `.call()` p50 latency end-to-end (Haiku)       | < 2.0s           |
| `.call()` p95 latency end-to-end (Opus)        | < 20s            |
| KMS `Decrypt` p99 latency                      | < 150ms          |
| Error rate (no contando `invalid_key` usuario) | < 0.5% / 7 días  |
| Circuit breaker false-open rate                | < 1 / mes        |

### 13.2 Failure modes documentados

**Importante — scope del circuit breaker**. El circuit breaker
descrito en §4.2 aplica **exclusivamente a proveedores LLM**
(Anthropic, OpenAI, Gemini — y cualquier proveedor futuro añadido
vía §9.4). NO existe circuit breaker sobre KMS. Frases
como "circuit KMS abre" que pudieran aparecer en versiones
anteriores son lenguaje figurativo para describir el estado
"retries agotados + entradas en cache in-process expirando →
fail-closed sostenido sobre todas las lecturas BYOK". El manejo
de KMS es fail-closed directo (§2 invariante 5, §4.3 "Retry
budget KMS fijo").

| Fallo                                  | Comportamiento esperado                                |
|----------------------------------------|--------------------------------------------------------|
| KMS throttle / 5xx transitorio         | `kms_unavailable { transient: true }`, 1 retry con jitter (si deadline alcanza), luego fail-closed |
| KMS region down prolongado             | Retries agotados (budget=1), cache in-process sirve hits mientras dure el TTL (≤5min); pasado el TTL, fail-closed en todas las lecturas BYOK del shard afectado. Alerta P1, modal "IA degradada" al usuario, dashboard status-page actualizado. SIN circuit breaker sobre KMS (ver nota arriba). Sin failover automático a otra región (multi-region KMS es post-MVP, §15). |
| KMS `InvalidCiphertextException`       | `kms_unavailable { transient: false }`, no retry, audit entry `llm.kms.ciphertext_invalid` P1 (señal de corrupción o bug de migración) |
| Postgres `user_llm_key` lectura falla  | `internal` error, sin fallback a pool                 |
| Redis idempotency down                 | Degrada a sin-idempotency, log warn                   |
| Provider LLM primario circuit abierto  | Usa fallback según matriz §4.1 (solo Influencer+ con preferMyKey o Studio con pool alt) |
| Ambos proveedores LLM abajo            | `provider_down { circuitOpen: true }` para todos      |
| Worker OOM en middle de call           | Request se pierde, caller reintenta con idempotency   |
| KEK marked `PendingDeletion` in error  | Bloqueo escrituras, alerta P1, manual recovery       |
| Rebalance batch falla mid-job          | Job es re-entrante (idempotent); rows con `kekVersion=k` y `kekVersion=k+1` coexisten en DB, cada una sirve lecturas por su versión. Job retoma desde último UPDATE exitoso. Ver §5.3 "Rebalance". |
| Flag GrowthBook fuera de rango min/max | Worker fail-fast al arranque; rollback a valor por default hardcoded como safety net. Alerta P1. Ver §16 "Validación de flags". |

## 14 · Testing strategy

### 14.1 Unit tests (vitest)

- **`crypto.test.ts`**: envelope encryption roundtrip con KMS mock.
  Verifica que DEK nunca sale en claro, que la key cifrada no se
  parece al plaintext, y que `buffer.fill(0)` ocurre.
- **`routing.test.ts`**: matriz §4.1 con cada combinación (plan,
  preferMyKey, circuit_state, keyStatus) → expected route.
- **`providers/anthropic.test.ts`**: mock fetch, verifica mapeo
  correcto a `NormalizedLLMRequest` y parsing del response.
- **`client.test.ts`**: end-to-end con todos mocks, verifica
  accounting rows escritas, audit entries emitidas.

### 14.2 Contract tests (sandbox keys)

Un workflow CI separado `llm-contract-tests.yml` corre **semanal**
con keys sandbox de Anthropic, OpenAI y Gemini (no las de pool)
contra modelos mini (`haiku`, `gpt-5-mini`, `gemini-2.5-flash`)
para detectar breaking changes de proveedor antes de que afecten
producción. Tests:

- Ping básico → 200 OK, formato de response esperado.
- Completion corta con tool use → response mapeable.
- Completion con stop sequence → respeta la señal.
- Token accounting field presente y no-negativo.

Las sandbox keys viven en GitHub Actions Secrets, nunca en repo.

### 14.3 Linter CI — zero plaintext keys

Blocker de deploy:

```yaml
- name: Scan logs for leaked API keys
  run: |
    grep -rE 'sk-ant-[a-zA-Z0-9]{40,}|sk-[a-zA-Z0-9]{40,}' \
      artifacts/logs/ && exit 1 || exit 0
```

Y un test unitario:

```ts
it('redacts API keys from log messages', () => {
  const fakeKey = 'sk-ant-' + 'x'.repeat(50);
  const logged = captureLog(() => logger.info({ apiKey: fakeKey }));
  expect(logged).not.toContain(fakeKey);
  expect(logged).toContain('[REDACTED]');
});
```

### 14.4 Chaos drills (post-MVP)

- Inyectar KMS 5xx rate 50% durante 10min → verificar
  `kms_unavailable` errors + circuit NO se abre por error no
  imputable al proveedor.
- Forzar circuit abierto de Anthropic → verificar fallback
  funciona para Influencer+ con preferMyKey.
- Matar worker en medio de `.call()` → verificar idempotency
  reemits el mismo resultado.

## 15 · Qué queda fuera del MVP

- **Streaming responses**. `claude-*` y GPT soportan streaming
  token-a-token; para la UI conversational sería ideal. Post-MVP
  v0.2 porque añade complejidad de SSE + cancel semantics +
  accounting parcial.
- **Proveedores adicionales**: Azure OpenAI, **Google Vertex AI**
  (path GCP con service account para Gemini; el path AI Studio sí
  está en MVP §9.3), Mistral, AWS Bedrock. Contemplados pero fuera
  MVP.
- **Prompt caching / context caching**. Anthropic lo ofrece; puede
  reducir costo 10× en Managed. Post-MVP v0.3.
- **Batching**. Algunos workers de ingesta podrían batchear N
  prompts. Fuera MVP.
- **Self-hosted OSS models** (Llama 3 via Ollama, etc.). Fuera de
  MVP; contemplar para Studio si clientes enterprise lo piden.
- **Cost predictor pre-call**. Estimar tokens y costo antes del
  request para mostrar confirmación al usuario. Fuera MVP.
- **Fine-tuning**. Fuera MVP; Foco no hace training.
- **Multi-region KMS**. MVP US-primary. Multi-region en línea con
  `PRODUCTION_READINESS.md §11` (activación diferida).

## 16 · Decisiones abiertas / Pendiente de aprobación

### Cerradas en v0.2 (ya no requieren decisión)

- ✅ **KMS vendor**: AWS KMS con KEK por shard (§5.2). Cerrada tras
  primer peer review y cálculo de costo explícito.
- ✅ **Circuit breaker y retry thresholds**: migrados a feature
  flags en GrowthBook (tabla abajo), no hardcoded. Cerrada.

### Aún abiertas

1. **Trial para Free/Creator sin key**: ¿bloquear generación
   totalmente, o permitir un *generous trial* del pool Foco por
   tiempo limitado (ej. primeras 10 generaciones)? Jean decide.
2. **Respuesta a `content_blocked`**: ¿mostrar al usuario la razón
   del bloqueo (más útil para refinar) o mensaje genérico (menos
   bypass-friendly)? Recomendación Claude: genérico.
3. **Nombres `gpt-5` / `gpt-5-mini`**: placeholders hasta lanzar.
   Actualizar tabla §9 cuando OpenAI publique modelos finales.
4. **Exposición de `providerUsed` al usuario** en UI: ¿mostrar que
   el request fue routed a Anthropic vs OpenAI, o dejarlo interno?
   Recomendación Claude: mostrar (transparencia radical).
5. **Umbrales iniciales de abuso §8.3**: `10k tokens/hora × 3h` es
   placeholder. Calibrar con datos reales post-launch. Los valores
   viven en GrowthBook (tabla abajo); requieren decisión inicial.
6. **Política de retención de `llm_token_usage`**: ¿90 días? ¿1
   año? Depende de necesidades de analytics vs costo Postgres.
7. **Persistencia de `providerRequestId` en idempotency cache**
   (propuesta segundo peer review, N8): hoy el cache de idempotency
   almacena `LLMCallOutput` incluido `providerRequestId`. Peer
   review sugirió persistirlo por separado indexado para soporte
   de "replay debugging" (cliente consulta por providerRequestId y
   encuentra su request original). Decisión diferida a v1.1 por
   no ser bloqueante de MVP.

### Feature flags expuestos en GrowthBook

Los siguientes valores son **configuración runtime** (no constantes
de código) y viven en GrowthBook con defaults conservadores;
requieren cambio de flag (auditable, versionado) para ajustar.
Migración a flags cerrada en v0.2 — los valores de la tabla son
los defaults iniciales, no decisiones abiertas:

| Flag                                            | Default | Min  | Max   | Descripción |
|-------------------------------------------------|---------|------|-------|-------------|
| `llm.circuit_breaker.error_threshold`           | `0.30`  | 0.05 | 0.90  | Error rate para abrir circuito (0–1) |
| `llm.circuit_breaker.volume_threshold`          | `20`    | 5    | 500   | Mínimo de requests en ventana para evaluar |
| `llm.circuit_breaker.window_seconds`            | `60`    | 10   | 600   | Ventana deslizante |
| `llm.circuit_breaker.open_cooldown_seconds`     | `30`    | 5    | 300   | Tiempo en `open` antes de `half-open` |
| `llm.circuit_breaker.half_open_probes`          | `3`     | 1    | 20    | Requests de prueba en `half-open` |
| `llm.kms.retry_count`                           | `1`     | 0    | **1** | Retries ante `kms_unavailable { transient: true }`. **Max hard-capped en 1** — subir más requiere PR al doc, no toggle de flag. Ver §4.3. |
| `llm.kms.retry_jitter_ms_min`                   | `50`    | 10   | 500   | Jitter mínimo |
| `llm.kms.retry_jitter_ms_max`                   | `250`   | 50   | 2000  | Jitter máximo (debe ser > `retry_jitter_ms_min`) |
| `llm.dek_cache.ttl_seconds`                     | `300`   | 60   | **300** | TTL del cache in-process de DEK. **Max hard-capped en 300 (5min)** por invariante 8 del §2. |
| `llm.idempotency.ttl_seconds`                   | `600`   | 60   | 3600  | TTL del cache de idempotency en Redis |
| `llm.abuse.tokens_per_hour_free`                | `10000` | 1000 | 1e6   | Umbral de detección tokens/hora Free/Creator |
| `llm.abuse.sustained_hours`                     | `3`     | 1    | 24    | Horas sostenidas para disparar audit |
| `llm.abuse.duplicate_prompt_hash_per_day`       | `100`   | 10   | 10000 | Disparador anti-scraping |

### Validación de flags (guardrails)

Los flags arriba tienen dos capas de validación:

1. **Fail-fast al arranque del worker**. En `llm-client` boot, se
   lee cada flag de GrowthBook; si alguno está fuera de `[min,
   max]` o si invariantes cruzadas fallan
   (`retry_jitter_ms_min > retry_jitter_ms_max`,
   `open_cooldown_seconds > window_seconds × 5`), el worker **no
   arranca** y emite log estructurado `llm_flag_validation_failed`
   + alerta P1 Grafana. Fallback de emergencia: defaults
   hardcoded en `src/config/flag-defaults.ts` (los mismos valores
   de la columna "Default"), aplicados solo si el proceso deployer
   fuerza `LLM_CLIENT_ALLOW_FLAG_FALLBACK=true` (variable de env
   para recovery de emergencia en un incidente donde GrowthBook
   esté caído).
2. **Alerta Grafana en cambios fuera de recomendado**. Un
   dashboard `foco-llm-flags-watch` monitorea cambios de flag vía
   GrowthBook webhook + audit entry `llm.flag_changed`
   ({actor, flag, old, new, timestamp}). Warning si un valor nuevo
   está en `[min, max]` pero fuera del rango recomendado
   (ej. `error_threshold > 0.50` — técnicamente legal pero
   operativamente sospechoso); P2 si fuera de `[min, max]` (no
   debería ocurrir porque GrowthBook rechazaría, pero doble net).

Los hard-caps marcados en negrita en la columna "Max"
(`retry_count = 1`, `dek_cache.ttl_seconds = 300`) son
invariantes del doc: cambiarlos requiere PR al doc + re-review,
no un toggle de flag. La razón es que esos dos tienen
implicaciones de seguridad/disponibilidad que deben quedar
revisables en git history, no enterradas en historial de
GrowthBook.

## 17 · Changelog

- **v0.1** (2026-04-18) — Primer borrador completo. Cubre surface,
  plan-aware routing, envelope encryption, validación, taxonomía
  de errores, token accounting, providers MVP, observabilidad,
  audit, UserQuota interop, SLOs, testing, fuera de alcance,
  decisiones abiertas. No firmado; pendiente peer review externo.
- **v0.2** (2026-04-18) — Aplica 6 cambios del primer peer review
  externo:
  1. Envelope encryption: KEK **por shard de ~1.000 usuarios**, no
     por usuario. KMS vendor cerrado = AWS KMS con cálculo de
     costo explícito (§5.1, §5.2). Blast radius acotado a 1k users
     por compromise; costo fijo amortizado a $0.010/usuario/mes.
  2. Fail-closed con retry acotado: 1 retry con jitter 50–250ms
     ante `kms_unavailable { transient: true }`. Métrica
     `llm_kms_induced_failures_total` separa fallos KMS de fallos
     del proveedor LLM (§2 inv. 5, §7.1, §10.2, §13.2).
  3. Cache in-process permitido: TTL ≤5min, zeroize al eviction,
     per-worker, con threat model explícito. "Zero caching" de
     v0.1 era demasiado estricto para la latencia real de KMS
     (§2 inv. 8, §5.1 flujo de lectura).
  4. Idempotency semantics corregida: previene side-effects
     duplicados pero **no garantiza determinismo textual** del
     output (§4.3).
  5. Token accounting BYOK: explicita las 3 razones (UI, abuso,
     analytics) y declara consentimiento informado en Privacy
     Policy + consent modal (§8 intro nueva).
  6. Circuit breaker + retry thresholds migran a feature flags
     GrowthBook (§16). Valores por defecto documentados como
     tabla; cambios runtime son auditables vía GrowthBook history.

  Segundo peer review aplicado en v0.3 (siguiente entrada).
- **v0.3** (2026-04-18) — Aplica 7 cambios del segundo peer review
  externo (3 críticos + 3 importantes + 1 nice-to-have). Scope
  estricto sobre diff v0.2→v0.3:
  1. **C1 — CB scope clarificado**: el circuit breaker aplica
     exclusivamente a proveedores LLM. NO hay CB sobre KMS; el
     manejo es fail-closed directo con retry budget fijo. §2 inv.
     5, §13.2 nota al inicio de tabla.
  2. **C2 — Shard versioning + rebalance**: se introduce
     `kekVersion` explícito al envelope (`hash(userId, kekVersion)
     mod N(kekVersion)`). `N` es inmutable dentro de una
     `kekVersion`; rebalance requiere nueva versión con re-wrap
     offline en batch (procedimiento detallado). §5.1 rationale,
     §5.1 flujo agregar/leer, §5.3 "Rebalance de sharding" nueva.
  3. **C3 — Validación runtime de flags**: tabla min/max en §16
     tabla de flags. Fail-fast del worker al arranque si flag
     fuera de rango o invariante cruzada falla. Hard-caps:
     `retry_count ≤ 1` y `dek_cache.ttl ≤ 300s`. Alerta Grafana
     `foco-llm-flags-watch` sobre cambios. §16 nueva subsección.
  4. **I4 — Consent modes en token accounting**: dos modos
     `full`/`minimal`. `minimal` escribe solo `COUNT(*)` por
     usuario/hora (abuso funciona; UI de uso degrada a "X
     llamadas"). Campo `user_llm_key.consent_mode` auditable. §8
     intro.
  5. **I5 — Cache key `(userId, kekVersion)` + invalidación
     completa**: cache key pasa de `userId` a tupla con versión;
     stale hits por `kekVersion` mismatch se cuentan en métrica
     nueva `llm_dek_cache_stale_hits_total`. `invalidateUserKey`
     purga todas las versiones del userId. §2 inv. 8, §5.1 flujo
     de lectura.
  6. **I6 — Deadline propagation + retry budget fijo**: retry KMS
     se suprime si el span padre tiene
     `timeout_remaining < (max_jitter + latency_p95)`. Métrica
     `llm_retries_skipped_deadline_total`. `retry_count` hard-cap
     en 1 en §16. §4.3 subsección nueva.
  7. **N7 — Métricas adicionales**: `llm_kek_shard_distribution`,
     `llm_kek_rebalance_progress`, `llm_kms_retry_success_ratio`.
     §10.2.

  Diferido a v1.1 (N8): persistencia de `providerRequestId` en
  idempotency cache para replay debugging — no bloqueante MVP.
  Añadido a §16 "Aún abiertas" como #7.

  Opción A acordada — sin tercer peer review porque los cambios
  son aclaratorios / cierran gaps, no introducen superficie nueva.
- **v1.0** (2026-04-18) — **Firma**. Cuarto contrato ancla de
  Foco firmado por Jean Pierre Rojas tras dos pasadas de peer
  review externo aplicadas. Sin cambios técnicos respecto a
  v0.3 más allá del frontmatter, título y este changelog. El
  contenido queda invariante: cualquier modificación de los 8
  invariantes de §2 requiere nueva ronda de peer review + re-
  firma. `packages/llm-client/` queda habilitado para
  implementación.
- **v1.1** (2026-04-18) — Agrega **Google Gemini** como tercer
  proveedor MVP. Cambios aditivos, **NO toca los 8 invariantes de
  §2**, §5 (crypto) ni §8 (accounting) — por eso no requiere
  nueva ronda de peer review externo, solo firma de Jean en este
  changelog (regla de `feedback_foco_three_contracts_rule.md`).
  Scope estricto:
  1. **§1.1** — menciona Gemini en la lista de APIs generativas
     cubiertas.
  2. **§3.1** — añade `gemini.ts` al tree del paquete.
  3. **§3.3** — `NormalizedLLMRequest.model` extiende con
     `'gemini-2.5-pro'` y `'gemini-2.5-flash'`; `providerHint`
     extiende con `'gemini'`.
  4. **§3.4** — `LLMCallOutput.providerUsed` extiende con
     `'gemini'`.
  5. **§4.2** — métrica `llm_circuit_state` añade la etiqueta
     `provider="gemini"`.
  6. **§9.3 NUEVA** — "Google Gemini (AI Studio / Gemini API
     directa)": endpoint `generativelanguage.googleapis.com`,
     auth vía header `x-goog-api-key` (NO query param, para no
     loggear la key en balancers/CDN — invariante #1),
     peculiaridades del wire format (`contents` en vez de
     `messages`, `'model'` en vez de `'assistant'`,
     `systemInstruction` separado, `generationConfig`,
     `usageMetadata`, mapeo de `finishReason` a `stopReason` /
     `content_blocked`), mapeo de errores (`INVALID_ARGUMENT`,
     `RESOURCE_EXHAUSTED`, `PERMISSION_DENIED`).
  7. **§9.3 (antigua)** — renumerada a **§9.4** (interface
     `Provider`); se expande `Provider.name` a `'anthropic' |
     'openai' | 'gemini'` y se documenta que agregar proveedor
     requiere extender también `providerHint` y
     `providerUsed`.
  8. **§15** — explicita que **Vertex AI queda fuera del MVP**
     aunque Gemini (vía AI Studio) entra. Decisión
     deliberada: Vertex requeriría service account GCP y es
     hostil para BYOK Free/Creator; el path AI Studio cubre
     todos los casos de uso MVP.

  **Flags GrowthBook no cambian**: circuit breaker, KMS retries,
  DEK cache e idempotency son parametrizados por `provider` con
  los mismos umbrales. Post-MVP se podría segmentar por
  proveedor si los SLOs divergen — no hoy.

  **No resuelve decisión abierta #3** sobre nombres `gpt-5`
  (sigue como placeholder hasta que OpenAI publique final). Las
  otras 6 decisiones abiertas (§16 "Aún abiertas") quedan igual.

## 18 · Pendientes iter 9 (deuda técnica post-iter-8)

Estas son concesiones conscientes que iter 8 commit 3 firmó
como "delegated decisions" para cerrar el facade `LLMClient` sin
re-abrir contratos ni bloquear la cadena de commits. Cada
pendiente tiene un plan ejecutable que iter 9 resuelve antes del
release candidate. Ninguno viola los 8 invariantes de §2 ni la
matriz billable-vs-pre-call de §4.2 — son *strictness gaps*, no
comportamiento.

**Regla de re-firma**: cualquier pendiente cuyo plan termine
tocando un invariante de §2 o la superficie pública de
`@chisu/schemas` requiere nueva ronda de peer review + bump semver
antes de mergear; los demás se cierran con commits convencionales
dentro de iter 9.

### 18.1 · `LLMCallInput` superset → §3.3 exact — ✅ CERRADO iter 9 c3

**Qué era**: `LLMCallInput` aceptaba `user: UserQuota` más los
campos §3.3, para que `plan-router` pudiera consumir salida del
planner sin remapeo. Iter 8 c3 firmó esto como decisión
delegada #3.

**Qué cambió (iter 9 c3)**:

- **Nuevo archivo** `src/repos/user-quota-repo.ts` define la
  interface `UserQuotaRepo { get(userId): Promise<Result<UserQuota,
  UserQuotaRepoError>> }` con taxonomía de error narrow
  (`not_found` / `transport`) — PII-free, adapter-opaque.
- `LLMCallInput` ahora carga **`userId: string`** (no el quota
  entero). Matchea §3.3 verbatim.
- `LLMClientDeps` gana el campo `userQuotaRepo`. El facade lo
  consulta en un nuevo **step 3.5** (entre zod parse y
  derivación de idempotencyKey), dentro de un sub-span
  `llm.quota.resolve` con atributo `user.id_hash` para
  observabilidad sin leak de id crudo.
- Dos nuevos `correlationId` estructurados:
  `client.call: quota_not_found` y `client.call: quota_transport`.
  Ambos stampean span root ERROR con mensaje
  `quota_not_found` / `quota_transport` respectivamente. Ningún
  path toca el router ni el idempotency store.
- `buildRouteInput` recibe el `UserQuota` resuelto como
  parámetro separado en lugar de leerlo del input.
- El constante `QUOTA_RESOLVE_SPAN_NAME = 'llm.quota.resolve'`
  se exporta para que specs externas (apps/web wiring, iter 10
  chaos harness) puedan asertar la sub-span sin hardcodear el
  string.

3 specs nuevas en `test/client/client.test.ts`:
- Happy path (repo consult + sub-span ok + user propagado al
  router).
- Fail `not_found` (internal error con correlation correcto +
  ambos spans ERROR + no router call).
- Fail `transport` (internal error + log estructurado con hash
  de userId, reason no echoeada al caller).

Coste real: 1 archivo nuevo (56 LoC), edit en `client.ts`
(~75 LoC), `_fakes.ts` gana `FakeUserQuotaRepo` (~50 LoC), 3
specs nuevas en `client.test.ts` (~110 LoC).

### 18.2 · `input.idempotencyKey?` override ignorado — ✅ CERRADO iter 9 c2

**Qué era**: si el caller pasaba `input.idempotencyKey`, el
facade lo ignoraba y derivaba siempre desde `(userId,
hashNormalizedRequest, model)`. Iter 8 c3 firmó esto como
decisión delegada #3.

**Qué cambió (iter 9 c2)**:

- `buildIdempotencyKey(userId, promptHash, model, callerKey?)`
  acepta un 4° argumento opcional. Cuando `callerKey` es string
  no-vacío, compone el pre-image como
  `${userId}:${callerKey}:${promptHash}:${model}`; cuando está
  ausente o vacío, mantiene el pre-image de 3-tuplas original —
  entradas de cache pre-iter-9 siguen reachable.
- `src/client.ts` pasa `input.idempotencyKey` al builder como 4°
  argumento sin validación extra (el zod mirror ya normaliza
  string/undefined).
- JSDoc de `LLMCallInput.idempotencyKey` actualizado explicando
  semantics + edge case del string vacío.
- 6 specs unitarias nuevas en `test/idempotency/key.test.ts`
  (shape con callerKey, fallback con empty/undefined, scoping
  cross-tenant, determinismo, canonical pre-image de 4 tuplas).
- 1 spec integration en `test/client/client.test.ts`:
  `accepts caller-provided idempotencyKey scoped to userId`
  verificando los 3 casos (override non-empty → diff, mismo
  callerKey cross-tenant → diff, empty → fallback).

Coste real: 18 LoC producción + 85 LoC tests + JSDoc.

### 18.3 · `correlationId?` no declarado como campo tipado — ✅ CERRADO iter 9 c1

**Qué era**: el commit message de iter 8 c3 afirmaba que
`correlationId?` estaba en schema; la realidad era que entraba
vía `.passthrough()` del zod mirror, no como campo declarado.
`deriveCorrelationId()` lo extraía pero TypeScript no lo veía en
el tipo público.

**Alcance firmado iter 9 c1**: **local a `@chisu/llm-client`**,
no cross-cut a `@chisu/schemas`. `LLMCallInput` vive en
`packages/llm-client/src/client.ts`, no en schemas — el campo
aditivo-opcional no requiere bump semver ni re-firma. El zod
mirror de `@chisu/schemas` sigue aceptando el campo vía
`.passthrough()`; el facade lo declara localmente como
sub-typing legítimo del contrato canonical.

**Qué cambió**:
- `LLMCallInput.correlationId?: string | undefined` declarado.
- `callInputSchema` zod mirror local declara el campo
  explícitamente (además del `.passthrough()`).
- Facade step 9 resuelve en orden:
  (1) `input.correlationId` si es string no-vacío →
  (2) `deriveCorrelationId(input.traceparent)` →
  (3) fallback `randomUUID()` dentro de `deriveCorrelationId`.
- 2 specs añadidas: "uses input.correlationId verbatim when
  provided and non-empty" + "falls back to traceparent parse
  when input.correlationId is an empty string".

Coste real: 11 LoC producción + 22 LoC tests + JSDoc/comments.

### 18.4 · Coverage per-file de `src/client.ts` bajo umbral — ✅ CERRADO iter 9 c5

**Qué**: coverage global 97.77/94.05/97.69 ✅; per-file
`src/client.ts` 94.08/90.54/100 — statements 94.08% contra
umbral 95%.

**Por qué deuda**: las líneas no cubiertas (723-728, 762-772,
835-836) son paths defensivos:
- **723-728**: rama de fallback cuando `trace.getActiveSpan()`
  retorna span no-recording (test environment con tracer no-op
  parcial).
- **762-772**: manejo de `err` dentro de `raceDrain` cuando un
  inflight rechaza con error no-envuelto.
- **835-836**: guard de `resolveInflight` undefined en cleanup
  (TS narrow que nunca dispara en runtime pero el compilador
  pide).

**Qué hace iter 9**: subir a ≥95/90/95 per-file añadiendo 3-4
specs que ejerciten esos paths con doubles específicos (tracer
non-recording, inflight que lanza `Error` puro, cleanup-race).
Coste: <80 LoC de test, 0 cambios de producción.

### 18.5 · `LLMClient.ping()` + `LLMClient.invalidateUserKey()` fuera del facade — ✅ CERRADO iter 9 c4

**Qué**: el facade expone solo `call()` y `close()`. Las
operaciones adyacentes (`ping` para healthcheck, `invalidateUserKey`
para forzar re-lookup de DEK tras rotación) están implementadas en
`plan-router` y `EnvelopeCrypto` respectivamente, pero no tienen
entry point en el facade público.

**Por qué deuda**: callers (UI settings-integraciones, cron de
healthcheck, webhook de rotación KMS) deben bypass el facade y
hablar con internals. Rompe encapsulación.

**Qué hace iter 9**:
- `LLMClient.ping(userId: string, provider?: ProviderId): Promise<PingOutput>`
  — delega a `plan-router.ping()` (existe) + consume cuota 0,
  no emite `UsageEntry`, pasa por circuit breaker (si abierto,
  rechaza con `provider_down`).
- `LLMClient.invalidateUserKey(userId: string): Promise<void>`
  — delega a `EnvelopeCrypto.invalidateAll(userId)` (requiere
  añadir método nuevo que purga entradas de DEK cache por userId
  en todas las kekVersion). Emite métrica
  `llm_key_invalidations_total{origin='explicit'}`.

Si `EnvelopeCrypto.invalidateAll()` toca la superficie firmada de
`@chisu/llm-client/crypto`, requiere peer review. Coste estimado:
<60 LoC producción + <120 LoC specs.

---

**Planeado como commits independientes iter 9** (regla
commit-per-step): cada pendiente 18.1-18.5 es su propio commit
convencional. Orden sugerido: 18.3 (tipo) → 18.2 (idempotency
override) → 18.1 (UserQuotaRepo) → 18.5 (ping/invalidate) → 18.4
(coverage bump, cierra iter 9). 18.3 y 18.5 son los dos
candidatos a requerir re-firma según alcance final.

## 19 · Relación con otros documentos

- **`UX_FROZEN.md v1.3 §3.6` + `§5 settings-integraciones`**:
  define las cuotas por plan y la pantalla de gestión de keys que
  este cliente alimenta.
- **`INGEST_SECURITY.md v1.0 §4`**: el principio "fail-closed" se
  aplica aquí al caso KMS/proveedor ambiguo.
- **`PRODUCTION_READINESS.md v1.0 §3`** (audit hash chain) y
  **`§5`** (Doppler como store de secrets de pool): integración
  obligatoria.
- **`packages/schemas` (`UserQuota`, `SystemAuditEntry`)**:
  contratos consumidos. Cualquier campo nuevo aquí requiere bump
  semver del paquete + firma nueva.
- **`project_foco_byok_model.md`** (memoria): fuente de verdad del
  rationale económico BYOK. Esta spec lo implementa
  técnicamente.
- **`project_foco_mcp_bidireccional.md`** (memoria): motivo del
  campo `exposureScope` en `LLMCallInput`. Conversaciones internas
  jamás se re-exponen.

---

**Estado**: **SIGNED v1.1** (2026-04-18). Firmado por Jean Pierre
Rojas. Historial: v0.1→v0.2 (primer peer review externo, 6
cambios), v0.2→v0.3 (segundo peer review externo, 7 cambios),
v0.3→v1.0 (firma inicial), v1.0→v1.1 (extensión aditiva con
Google Gemini como tercer proveedor MVP vía AI Studio). Este doc
es el cuarto contrato ancla de Foco junto con UX_FROZEN v1.3,
INGEST_SECURITY v1.0 y PRODUCTION_READINESS v1.0.
`packages/llm-client/` queda habilitado para implementación con
Anthropic + OpenAI + Gemini en MVP. Cualquier cambio en los 8
invariantes de §2 requiere nueva ronda de peer review + re-firma;
las extensiones aditivas (nuevos proveedores, nuevos modelos
dentro de proveedores existentes) solo requieren bump minor +
firma de Jean en changelog.
