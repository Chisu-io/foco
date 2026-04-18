---
title: Foco · LLM_CLIENT v0.2
status: DRAFT v0.2 (pendiente de segundo peer review + firma)
date: 2026-04-18
owner: Jean Pierre Rojas
reviewer: Jean + AI peer review externo (primera pasada aplicada)
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
    Pendiente segundo peer review (scope: diff v0.1→v0.2) + firma.
---

# Foco · LLM_CLIENT v0.2

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
Completions). Todo worker, edge function, MCP handler o asistente
conversacional que necesite completions pasa por `LLMClient`.

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
6. **Token accounting para todos**, no sólo Managed. En BYOK
   contamos tokens para UI de uso en `settings-integraciones`,
   detección de abuso, y analytics — no para billing.
7. **Circuit breaker por proveedor**. Si Anthropic o OpenAI tienen
   tasa de error >X% en ventana Y, Foco abre el circuito y usa
   fallback (otro proveedor o error estructurado). Ningún caller
   bloquea indefinidamente.
8. **Scope mínimo en las keys de usuario**. La key BYOK solo se
   descifra dentro del proceso worker que hace la llamada. Zero IPC
   con otros workers con ella en claro. **Se permite caching
   in-process por worker** con TTL ≤5 min y zeroización al
   eviction, pero **se prohíbe**: cache en store distribuida
   (Redis, Memcached), serialización a disco o snapshot, y
   cualquier transmisión fuera del proceso. El cache es
   thread-local o per-event-loop, nunca global compartido.
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
  providerHint?: 'anthropic' | 'openai';

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
    | 'gpt-5-mini';
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
  providerUsed: 'anthropic' | 'openai';

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
métrica `llm_circuit_state{provider="anthropic"|"openai"}`.

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

## 5 · Envelope encryption de keys BYOK

### 5.1 Modelo criptográfico

Dos niveles:

- **KEK (Key Encryption Key)**: **una por shard** de ~1.000
  usuarios (asignación determinística:
  `shardId = hash(userId) mod N`, con N dimensionado para mantener
  ~1k users/shard). Vive en **AWS KMS** (decisión cerrada v0.2,
  ver §5.2). Nunca sale del HSM en claro. Se invoca para
  operaciones `Encrypt` / `Decrypt` sobre DEKs; nunca sobre la key
  de usuario directamente. **Rationale de shard**: KEK por usuario
  individual implica ~$1/user/mes en KMS fijo + ops, insostenible
  a volumen Free/Creator. KEK por shard amortiza el fijo a
  ~$0.001/user manteniendo blast radius acotado (un KEK
  comprometido = re-wrap de ~1k users, no toda la plataforma).
  Ver cálculo explícito en §5.2.
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
5. Edge calcula `shardId = hash(userId) mod N` y pide a KMS:
   Encrypt(kekAlias=`foco/kek/shard-${shardId}`, DEK).
   -> { dekCiphertext, kekVersion }
6. DB insert a `user_llm_key`:
   {
     userId, shardId, provider, keyCiphertext, keyNonce, keyAuthTag,
     dekCiphertext, kekVersion,
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
1. Worker fetch de row `user_llm_key` por userId (incluye shardId).
2. Worker consulta cache in-process (`dek_cache`) con key=userId.
   Hit: salta al paso 4 con DEK del cache. Miss: pide a KMS.
3. Worker pide a KMS: Decrypt(
     kekAlias=`foco/kek/shard-${shardId}`,
     dekCiphertext, kekVersion
   ) -> DEK. Si KMS falla con error transitorio, 1 retry con
   jitter 50–250ms (ver §2 invariante 5). Si falla otra vez,
   fail-closed con `kms_unavailable`.
4. Worker descifra keyCiphertext con DEK -> key_plaintext.
5. Worker usa key_plaintext durante el request HTTP al proveedor;
   al cerrar el request, zeroiza key_plaintext con `buffer.fill(0)`
   sobre el buffer original.
6. DEK permanece en cache in-process del worker con TTL ≤5 min
   (configurable vía flag `llm.dek_cache.ttl_seconds`, default
   300). Al eviction, se zeroiza también. El cache NO es
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

**KEK rotation** (tenant-level, cada 12 meses o a demanda):

- Nueva KEK-v2 creada en KMS, alias apuntado a v2.
- DEKs existentes permanecen cifradas con KEK-v1 (`kekVersion=1`).
- En la próxima `.call()` de ese usuario, si `kekVersion < current`,
  el cliente re-cifra la DEK con KEK-v2 y hace UPDATE atómico de la
  row. Rotación perezosa.
- KEK-v1 se marca `PendingDeletion` en KMS con ventana de 30 días
  (safety net en caso de bug de migración).

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

### 8.1 Contadores por request

Cada `.call()` exitoso escribe una row a `llm_token_usage`:

```sql
CREATE TABLE llm_token_usage (
  id              UUID PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES auth.users(id),
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  provider        TEXT NOT NULL,           -- 'anthropic'|'openai'
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

### 9.3 Interface `Provider`

```ts
export interface Provider {
  readonly name: 'anthropic' | 'openai';

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
añadir el enum correspondiente en `LLMCallOutput.providerUsed`.
MVP no incluye Azure OpenAI, Google Vertex, Mistral, AWS Bedrock;
están contemplados post-MVP (ver §15).

## 10 · Observability

### 10.1 Tracing (OpenTelemetry)

Cada `.call()` crea un span `llm.client.call` con atributos:

```
llm.provider               = "anthropic" | "openai"
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
llm_calls_total{provider, funding_mode, origin, status}       counter
llm_latency_ms{provider, model}                               histogram
llm_tokens_total{provider, model, direction=in|out}           counter
llm_errors_total{provider, kind}                              counter
llm_circuit_state{provider}                                   gauge (0|1|2)
llm_kms_latency_ms{operation=encrypt|decrypt}                 histogram
llm_kms_induced_failures_total{operation, transient}          counter
llm_kms_retries_total{operation, outcome=success|fail}        counter
llm_key_invalidations_total{provider, reason}                 counter
llm_dek_cache_hits_total{worker}                              counter
llm_dek_cache_misses_total{worker}                            counter
llm_dek_cache_evictions_total{worker, reason=ttl|manual}      counter
```

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
  llmKeyProvider: 'anthropic' | 'openai' | null;
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

| Fallo                                  | Comportamiento esperado                                |
|----------------------------------------|--------------------------------------------------------|
| KMS throttle / 5xx transitorio         | `kms_unavailable { transient: true }`, 1 retry con jitter, luego fail-closed |
| KMS region down prolongado             | Retries agotados → circuit KMS abre, modal P1, cache in-process sirve hits mientras dure el TTL |
| Postgres `user_llm_key` lectura falla  | `internal` error, sin fallback a pool                 |
| Redis idempotency down                 | Degrada a sin-idempotency, log warn                   |
| Provider primario circuit abierto      | Usa fallback según matriz §4.1                        |
| Ambos proveedores abajo                | `provider_down { circuitOpen: true }` para todos      |
| Worker OOM en middle de call           | Request se pierde, caller reintenta con idempotency   |
| KEK marked `PendingDeletion` in error  | Bloqueo escrituras, alerta P1, manual recovery       |

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
con keys sandbox de Anthropic y OpenAI (no las de pool) contra
modelos mini (`haiku`, `gpt-5-mini`) para detectar breaking changes
de proveedor antes de que afecten producción. Tests:

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
- **Proveedores adicionales**: Azure OpenAI, Google Vertex,
  Mistral, Bedrock. Contemplados pero fuera MVP.
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

### Feature flags expuestos en GrowthBook

Los siguientes valores son **configuración runtime** (no constantes
de código) y viven en GrowthBook con defaults conservadores;
requieren cambio de flag (auditable, versionado) para ajustar.
Migración a flags cerrada en v0.2 — los valores de la tabla son
los defaults iniciales, no decisiones abiertas:

| Flag                                            | Default | Descripción |
|-------------------------------------------------|---------|-------------|
| `llm.circuit_breaker.error_threshold`           | `0.30`  | Error rate para abrir circuito (0–1) |
| `llm.circuit_breaker.volume_threshold`          | `20`    | Mínimo de requests en ventana para evaluar |
| `llm.circuit_breaker.window_seconds`            | `60`    | Ventana deslizante |
| `llm.circuit_breaker.open_cooldown_seconds`     | `30`    | Tiempo en `open` antes de `half-open` |
| `llm.circuit_breaker.half_open_probes`          | `3`     | Requests de prueba en `half-open` |
| `llm.kms.retry_count`                           | `1`     | Retries ante `kms_unavailable { transient: true }` |
| `llm.kms.retry_jitter_ms_min`                   | `50`    | Jitter mínimo |
| `llm.kms.retry_jitter_ms_max`                   | `250`   | Jitter máximo |
| `llm.dek_cache.ttl_seconds`                     | `300`   | TTL del cache in-process de DEK |
| `llm.idempotency.ttl_seconds`                   | `600`   | TTL del cache de idempotency en Redis |
| `llm.abuse.tokens_per_hour_free`                | `10000` | Umbral de detección tokens/hora Free/Creator |
| `llm.abuse.sustained_hours`                     | `3`     | Horas sostenidas para disparar audit |
| `llm.abuse.duplicate_prompt_hash_per_day`       | `100`   | Disparador anti-scraping |

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

  Pendiente: **segundo peer review con scope solo sobre estos 6
  cambios** (no el doc completo) antes de promover a v1.0 + firma.

## 18 · Relación con otros documentos

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

**Estado**: DRAFT v0.2 — **pendiente de segundo peer review
(scope: diff v0.1→v0.2) + firma de Jean**. Next: enviar los 6
cambios del changelog v0.2 a una segunda AI de peer review (no el
doc completo), aplicar ajustes si los hay, promover a v1.0 y
firmar en frontmatter `status:`. Solo entonces se abre
`packages/llm-client/` para implementación.
