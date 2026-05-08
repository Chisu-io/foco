# `MCP_GATEWAY.md` — MCP gateway bi-direccional para Foco (v0.2 firmable)

**Estado**: borrador firmable v0.2 — 2026-04-23. Incorpora las 4 correcciones del peer review cruzado (scope explícito, opaque handles, Redis hot-path para rate limits, secret redaction roadmap). Pendiente firma final de Jean.

**Scope**: contrato técnico del paquete `@chisu/mcp-gateway` (a crear) que materializa el **MCP gateway** de Foco. Implementa el **lado servidor** del MCP (Foco expone su Memoria a otras AIs externas como Claude Desktop, Cursor, ChatGPT, Gemini desktop, Raycast, custom). El **lado cliente** (Foco lee de servidores MCP de otras AIs) queda diferido a post-MVP, alineado con `UX_FROZEN.md v1.4 §3.2` y `MEMORY_INGEST.md v0.3 §15`.

**Decisiones firmadas (2026-04-23)**:

- **Scope MVP** = solo lado servidor. Foco-as-server expone su Memoria como herramientas (`memory.search`, `memory.get_item`) MCP-callable bajo scopes granulares + autorización explícita por agente.
- **Transport** = HTTP + SSE (Server-Sent Events). Subdomain dedicado `mcp.foco.chisu.io`. MCP-spec compatible con la base instalada de clientes (Claude Desktop, Cursor, ChatGPT, Gemini desktop, Raycast).
- **Auth** = API key per `(user, agent)` bearer token. Usuario "autoriza nuevo agente" en `settings-mcp` → Foco genera API key (`foco_mcp_<base62>`). Cada request del agente lleva `Authorization: Bearer foco_mcp_<key>`. Revocable + rotable por usuario.
- **Audit log** = híbrido. Aggregated diario por `(user_id, agent_id, scope, day)` en tabla counter; individual rows en `system_audit` SOLO para policy events (deny por scope OFF, rate limit hit, auth fail, kill switch). Bajo volumen + forensics fino donde importa.
- **Rate limits** = combinados. (a) Per-agent: 1k reads/hora base sliding window. (b) Per-user plan-aware: cap total cross-agentes según el plan. (c) Per-scope sensitive: github/docs caps 10x más estrictos que aprendizajes/identidad/social.
- **Rate limit storage** (v0.2) = Redis como hot-path con scripts Lua para atomicidad. Postgres queda como source-of-truth para reconciliación + audit, no para chequeos en el wire-path. Cambio aplicado tras peer review por consideraciones de escalabilidad bajo concurrencia alta y MCP polling agresivo.
- **Scope en queries** (v0.2) = explícito y obligatorio. El gateway NO infiere scopes desde lenguaje natural. `memory.search` requiere `scope: McpScope` top-level; `filters.scope` eliminado.
- **Item identifiers** (v0.2) = opaque handles HMAC-firmados con TTL 5 min. `memory.search` devuelve handles, NO `MemoryItem.id` directos. `memory.get_item` consume handles. Defensa contra enumeration.

---

## §1 · Alcance del paquete

`@chisu/mcp-gateway` resuelve **un solo problema**: dado un usuario y un agente externo autorizado (Claude Desktop / Cursor / etc.), el agente puede consultar la Memoria del usuario a través del protocolo MCP, respetando los scopes que el usuario configuró en `settings-mcp` y los rate limits del plan.

El paquete **no** decide qué generar, no escribe contenido, no embeddea, no toca `@chisu/llm-client`. Es solo el **gateway**: traduce requests MCP a queries `@chisu/memory-ingest` autenticadas + autorizadas, gateando todo por scopes + rate limits + audit.

**Boundary clara**:

- `mcp-gateway`: recibe requests MCP, autentica el agente, autoriza el scope, consulta Memoria, responde MCP. No genera, no embeddea, no decide qué exponer (eso lo decide el usuario en UI).
- `memory-ingest`: provee chunks. No sabe nada de MCP. El gateway lo invoca como cliente normal.
- `llm-client`: no participa. El gateway no llama LLMs.

**Boundary clara con el lado cliente del MCP** (diferido a post-MVP):

El MCP es bi-direccional. El **cliente** (`@chisu/mcp-client` — paquete diferido) sería Foco leyendo de servidores MCP externos (Claude Desktop local, Cursor workspace, etc.) e ingestando ese contenido a Memoria. Eso es post-MVP. **Este doc cubre solo el servidor.** Cuando el cliente entre, será un paquete adyacente con su propio contrato firmado.

```
Agente externo (Claude Desktop, Cursor, …)
        │
        ▼  HTTP + SSE
mcp-gateway  ← este paquete
        │
        ├─→ auth (API key per agent)
        ├─→ scope check (los 6 firmados en UX_FROZEN §3.2)
        ├─→ rate limit (combinado)
        ├─→ memory-ingest.search() (consulta sólo lo permitido)
        ├─→ audit (híbrido)
        └─→ MCP response (SSE stream)
```

---

## §2 · Invariantes (11) — no negociables

1. **No conversaciones IA importadas se re-exponen**. Los chunks que entren a Memoria desde el lado cliente del MCP (post-MVP) están etiquetados con `source: 'mcp-client'` y el scope `conversaciones_importadas_de_otras_ais` está **bloqueado siempre OFF** en el servidor — no hay UI flow que lo pueda activar. Esto evita filtrado transitivo: lo que Foco aprende de Cursor no se devuelve a Claude Desktop. Mismo invariante que `UX_FROZEN.md v1.4 §3.2`.

2. **API key plaintext nunca persiste**. Las API keys generadas para agentes externos se hashean (sha256) antes de persistir en `mcp_agent_token`. El plaintext se muestra al usuario UNA vez en UI (modal "copia este token, no lo veremos otra vez") y se zeroize del proceso. Verificación de auth = sha256(presented) === stored_hash.

3. **Scope-deny es el default**. Cualquier scope no explícitamente autorizado por el usuario para el agente → deny silencioso (el agente recibe `tool_not_found` o `unauthorized`, NO una lista de los scopes disponibles que él no tiene). Defensa en profundidad contra fingerprinting.

4. **Rate limit es enforced en server-side, no en cliente**. Aunque el cliente MCP pueda implementar throttling propio, el servidor NO confía en eso — chequea sus propios buckets antes de cada request.

5. **Kill switch global por usuario es atómico**. El usuario puede desactivar el servidor MCP completo desde `settings-mcp`. Tras flip, todas las requests entrantes con cualquier API key del usuario reciben `503 Service Unavailable` con `Retry-After: 0` inmediato. Sin queue, sin gracia. No hay estado parcial.

6. **Audit log nunca puede fallar el response**. Si la escritura del audit falla (Postgres slow, transactional conflict), el response MCP igual procede — pero se emite métrica `mcp_audit_write_failures_total{reason}`. Auditabilidad es importante pero no debe cascade en outage del servicio.

7. **Sin tools de mutación en MVP**. El servidor MCP de Foco expone SOLO tools de lectura (`memory.search`, `memory.get_item`). Tools de escritura (`memory.add`, `memory.delete`) quedan diferidas a post-MVP. Diseño defensivo: un agente externo comprometido no puede modificar la Memoria del usuario.

8. **Idempotencia del request_id**. MCP requests llevan `request_id` opaque. El servidor NO mantiene estado de seen-request-ids — el protocolo MCP es stateless por design. Idempotencia recae en el cliente.

9. **TLS obligatorio**. Conexiones a `mcp.foco.chisu.io` solo TLS 1.3+. HTTP plano rechazado. Cert via Let's Encrypt rotation automática (reusa la infra de `*.foco.chisu.io`).

10. **Auditable**. Cada autorización/revocación de agente, cada kill switch, cada policy event (scope deny, rate limit hit, auth fail) produce un row en `system_audit` con la action correspondiente (§11). Las queries individuales NO se auditan en `system_audit` (volumen prohibitivo) — viven en `mcp_read_aggregate` (§11).

11. **El paquete NO redacta secretos en MVP**. Los chunks que vienen de Memoria pueden contener secretos (claves API embebidas en código de un repo de GitHub, tokens en docs subidos, credenciales en captions). El paquete NO escanea NI reemplaza secretos antes de devolverlos al agente. Defensa actual: defaults conservadores (`repos_de_github` y `documentos_subidos` OFF; el usuario opt-in conscientemente) + responsabilidad del usuario sobre el contenido que ingesta. Secret redaction (entropy scanning + secret classifiers + redact-at-retrieval) queda documentada como roadmap post-MVP en §15. Este invariante es **boundary de responsabilidad explícita**, similar al §2 inv 4 de `MEMORY_INGEST.md v0.3` sobre PII.

---

## §3 · Modelo de datos

### 3.1 · `McpAgentToken` (auth credential del agente externo)

```ts
interface McpAgentToken {
  readonly id: string;             // UUID v7
  readonly userId: string;
  readonly agentLabel: string;     // human-readable: "Claude Desktop @ MacBook"
  readonly tokenHash: string;      // sha256 hex del plaintext token
  /**
   * Scopes autorizados para este agente. Subset de los 6 enumerados
   * en §6. `conversaciones_importadas_de_otras_ais` NUNCA aparece
   * (invariante #1).
   */
  readonly authorizedScopes: readonly McpScope[];
  readonly createdAt: Date;
  readonly lastUsedAt?: Date;
  readonly revokedAt?: Date;
}

type McpScope =
  | 'aprendizajes_del_agente'
  | 'identidad_de_marca'
  | 'documentos_subidos'
  | 'repos_de_github'
  | 'posts_de_redes_sociales';
// `conversaciones_importadas_de_otras_ais` está bloqueado por contrato (§2 inv 1)
```

### 3.2 · `McpReadAggregate` (contador agregado de lecturas — base del audit híbrido)

```ts
interface McpReadAggregate {
  readonly userId: string;
  readonly agentId: string;       // FK a McpAgentToken.id
  readonly scope: McpScope;
  readonly day: Date;             // UTC date (no timestamp)
  readonly readCount: number;     // incremented per request granted
  readonly firstReadAt: Date;
  readonly lastReadAt: Date;
}
// PRIMARY KEY (userId, agentId, scope, day) — atomic upsert per granted read
```

### 3.3 · `McpRateLimitBucket` (sliding window per agente)

In-memory + Postgres-backed (Postgres es source-of-truth, in-memory es cache transparente). Sliding window de 1 hora con buckets de 1 minuto.

```ts
interface McpRateLimitBucket {
  readonly userId: string;
  readonly agentId: string;
  readonly windowStart: Date;     // truncated to minute
  readonly readCount: number;
}
// PRIMARY KEY (userId, agentId, windowStart)
```

### 3.4 · MCP request/response shapes

MCP es JSON-RPC 2.0 over HTTP + SSE. Las request shapes son las del MCP spec — el gateway no inventa shapes nuevas, solo implementa las del protocol:

- `initialize` — handshake.
- `tools/list` — listar tools disponibles.
- `tools/call` — invocar tool con args.

Tools que Foco-as-server expone (§5):

```ts
// Tool: memory.search
interface MemorySearchInput {
  readonly query: string;
  /**
   * Scope explícito y obligatorio (peer review v0.2). El gateway NO
   * infiere scope desde el lenguaje natural del query. El agente
   * declara qué subset de Memoria quiere consultar; si declara un
   * scope no autorizado para él → 403 forbidden + audit. Para
   * consultar múltiples scopes el agente hace múltiples calls
   * (cada llamada es auditable + rate-limit-able independiente).
   */
  readonly scope: McpScope;
  readonly k?: number;            // default 8, max 25 server-side
  readonly filters?: {
    readonly tags?: readonly string[];
    readonly publishedAfter?: string; // ISO 8601
  };
  readonly minScore?: number;     // default 0.65
}

interface MemorySearchOutput {
  readonly chunks: readonly {
    /**
     * Opaque handle HMAC-firmado (peer review v0.2). El agente
     * NO recibe el `MemoryItem.id` real. Para recuperar el chunk
     * completo (text full sin truncar) pasa este handle a
     * `memory.get_item`. Handle structure: base64url de
     * `{ itemId, agentId, expiresAt, hmac }` firmado con secret
     * server-side. TTL 5 min — un handle robado es inútil tras
     * expirar.
     */
    readonly handle: string;
    readonly text: string;          // truncated to 2000 chars
    readonly source: string;
    readonly sourceUri: string;
    readonly sourceTitle: string;
    readonly score: number;
    readonly publishedAt?: string;
  }[];
}

// Tool: memory.get_item — retrieve un chunk específico via opaque handle
interface MemoryGetItemInput {
  /**
   * Opaque handle obtenido de `memory.search`. NO es un
   * `MemoryItem.id` directo (peer review v0.2 — defensa contra
   * enumeration). El handle expira tras 5 min; reusarlo después
   * → 401 unauthorized.
   */
  readonly handle: string;
}

interface MemoryGetItemOutput {
  readonly text: string;            // full text, sin truncar
  readonly source: string;
  readonly sourceUri: string;
  readonly sourceTitle: string;
  readonly publishedAt?: string;
}
```

**Lo que NO se expone**: `memory.list_sources`, `memory.delete_item`, `memory.add_item`. Lectura, no mutación, no enumeración (defensa contra fingerprinting de la Memoria del usuario).

---

## §4 · Auth flow

### 4.1 · Autorización de un nuevo agente

UI flow desde `settings-mcp` (§3.2 de UX_FROZEN):

1. Usuario click "Autorizar nuevo agente" → modal aparece.
2. Modal pide: `agentLabel` (string libre, e.g. "Claude Desktop @ MacBook"), checkboxes para los 5 scopes disponibles (`conversaciones_importadas` no aparece).
3. Usuario marca scopes deseados, click "Generar token".
4. Backend genera token plaintext: `foco_mcp_<base62(32 bytes random)>`, calcula `sha256(plaintext)`, persiste row en `mcp_agent_token` con `tokenHash` + scopes.
5. UI muestra modal "Copia este token, no lo verás de nuevo": `foco_mcp_a8f3...`. Tras click "Listo", el plaintext se zeroize del frontend state. El backend nunca recibe el plaintext después.
6. Audit entry `mcp.agent_authorized` con `agentLabel` + `scopes` + `userId`.

### 4.2 · Request del agente externo

Cliente MCP externo configura su `mcp.foco.chisu.io` server con la API key. Cada request HTTP:

```
POST https://mcp.foco.chisu.io/v1/messages
Authorization: Bearer foco_mcp_a8f3...
Content-Type: application/json

{ "jsonrpc": "2.0", "method": "tools/call", "params": {...}, "id": 42 }
```

Servidor:

1. Lee `Authorization: Bearer <token>`. Si falta o malformed → `401 unauthorized`.
2. Calcula `sha256(token)`, busca en `mcp_agent_token` por `tokenHash`. Si no existe o `revokedAt IS NOT NULL` → `401 unauthorized`. Audit individual `mcp.auth_failed`.
3. Verifica que el scope requerido por el tool esté en `authorizedScopes`. Si no → `403 forbidden`. Audit individual `mcp.scope_denied`.
4. Verifica rate limits (§9). Si excede → `429 too_many_requests` con `Retry-After`. Audit individual `mcp.rate_limit_hit`.
5. Verifica kill switch del usuario. Si activo → `503 service_unavailable`. Audit individual `mcp.kill_switch_active`.
6. Procede a la lógica del tool (§5).
7. Increment `mcp_read_aggregate.readCount` para `(userId, agentId, scope, today)`. Update `lastUsedAt` en `mcp_agent_token`.
8. Response.

### 4.3 · Revocación

Usuario click "Revocar agente" en `settings-mcp` → backend hace `UPDATE mcp_agent_token SET revoked_at = NOW() WHERE id = $1`. Audit entry `mcp.agent_revoked`. El próximo request del agente con esa API key falla en step 2.

### 4.4 · Rotación de API key

Usuario click "Rotar token" → backend genera nuevo plaintext + tokenHash, **inserta nuevo row** + audit `mcp.agent_rotated_new`. Por separado, el row viejo recibe `revoked_at = NOW()` + audit `mcp.agent_rotated_old`. Hay una ventana corta (segundos) donde ambos tokens funcionan, intencional para que el usuario tenga tiempo de copiar el nuevo antes de que el viejo deje de funcionar. Tras 5 min el row viejo se considera completamente expired.

---

## §5 · Surface MCP del servidor (las 2 tools)

### 5.1 · `memory.search`

Búsqueda semántica con scope explícito + handle opaco en la respuesta.

```
POST /v1/messages
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "memory.search",
    "arguments": {
      "query": "qué dije sobre brand voice en Q4",
      "scope": "posts_de_redes_sociales",
      "k": 8
    }
  },
  "id": 42
}
```

Internamente:

1. **Validación de scope explícito (v0.2)**. Si `arguments.scope` falta → `400 invalid_input { reason: 'missing_scope' }`. Si está pero no es uno de los 5 valores válidos → `400 invalid_input { reason: 'unknown_scope' }`. Sin defaults — el agente debe declarar explícitamente. Razón (peer review): inferir scope desde NL complica auditoría, introduce nondeterminismo, y crea riesgo de leaks accidentales.
2. **Verificación de autorización del scope**. Si `scope` no está en `agent.authorizedScopes` → `403 forbidden { scope }` + audit `mcp.scope_denied`.
3. **Mapping a `MemoryItem.source`** server-side (no en el request del agente):
   - `documentos_subidos` → `source ∈ {'file'}`
   - `repos_de_github` → `source ∈ {'github'}`
   - `posts_de_redes_sociales` → `source ∈ {'youtube','instagram','facebook','tiktok'}`
   - `aprendizajes_del_agente` → metadata flag en chunks `metadata.learnable === true` (post-MVP refinement)
   - `identidad_de_marca` → metadata flag `metadata.brandDefining === true` (post-MVP refinement)
4. **Llamar `memoryIngest.search`** con `filters.source` derivado del scope. El agente NO puede pasar `filters.source` directo — solo declara scope, el gateway resuelve.
5. **Generar handles opacos** para cada chunk del resultado. Un handle es:
   ```
   handle = base64url(JSON.stringify({ itemId, agentId, expiresAt: now + 300_000, scope }) + '|' + hmacSha256(secret, payload))
   ```
   El secret HMAC vive en Doppler (`MCP_HANDLE_SECRET`); rota cada 90 días vía cron. Un handle robado: (a) solo es válido para el agente que lo recibió (verificado por agentId en el payload contra el bearer token), (b) expira en 5 min, (c) solo da acceso al scope original (no escala privilegios).
6. **Returns `MemorySearchOutput`** con los chunks ordenados desc por score. `text` truncado a 2000 chars.

Limitaciones server-side:
- `k` clampeado a 25 max (aunque MEMORY_INGEST §3.3 permite hasta 50). Reduce volumen MCP.
- `chunkText` truncado a 2000 chars. El agente puede pedir el full via `memory.get_item` con el handle correspondiente.

### 5.2 · `memory.get_item`

Recupera el `chunkText` completo de un item via handle opaco recibido de un `memory.search` previo. Útil cuando `search` devolvió un chunk truncado y el agente quiere el full.

```
POST /v1/messages
{
  "jsonrpc": "2.0",
  "method": "tools/call",
  "params": {
    "name": "memory.get_item",
    "arguments": { "handle": "eyJpdGVtSWQ..." }
  },
  "id": 43
}
```

Server:

1. **Verificar handle**:
   - Decode base64url. Si malformed → `400 invalid_input { reason: 'malformed_handle' }`.
   - Verify HMAC. Si inválido → `401 unauthorized { reason: 'invalid_handle' }` + audit `mcp.handle_invalid`.
   - Verify `expiresAt > now`. Si expired → `401 unauthorized { reason: 'expired_handle' }`.
   - Verify `agentId` del payload === agentId del bearer token actual. Si no → `403 forbidden { reason: 'handle_agent_mismatch' }` + audit `mcp.handle_misuse`. (Defensa contra: agente A roba handle de agente B.)
   - Verify `scope` del payload sigue autorizado para el agente al momento de get_item (el usuario pudo haber revocado el scope entre search y get_item). Si revocado → `403 forbidden { reason: 'scope_revoked_after_handle_issue' }` + audit `mcp.scope_denied`.
2. **Lookup `MemoryItem` by `itemId`**, restricted to `userId` del agente. Defensa adicional: aunque el HMAC es seguro, el query SQL siempre filtra por userId — si por algún bug el HMAC verifica para un itemId de otro tenant, el SELECT no devuelve rows.
3. **Verificar scope a nivel item**: el `source` del item debe pertenecer al scope del handle. Si por race-condition (ingesta nueva entre search y get_item) el scope no cuadra, `403 forbidden`.
4. **Returns `MemoryGetItemOutput`** con `text` completo (sin truncar).

Razón del diseño con handles (peer review v0.2): aunque el auth bearer está bien, exponer `MemoryItem.id` directamente eventualmente termina siendo target de enumeration/probing. Handles opacos:
- No revelan estructura del id (UUID v7 codifica timestamp).
- No son adivinables (HMAC + base64url).
- No reusables tras expiry.
- No transferibles entre agentes (verificación de agentId en payload).

### 5.3 · MCP discovery (`tools/list`)

El servidor responde con SOLO las tools que el agente puede invocar dado sus scopes. Si el agente no tiene autorizado ningún scope que mapee a una tool, `tools/list` devuelve array vacío. NO se devuelve la tool con un mensaje "you don't have permission" — defensa contra fingerprinting (invariante #3).

---

## §6 · Scopes (los 6, firmados en `UX_FROZEN.md v1.4 §3.2`)

| Scope | Default UI | Mapping a `MemoryItem.source` | Razón del default |
|---|---|---|---|
| `aprendizajes_del_agente` | ON | (metadata flag — post-MVP) | Diseño explícito del usuario; bajo riesgo. |
| `identidad_de_marca` | ON | (metadata flag — post-MVP) | El usuario quiere agentes que conozcan su marca. |
| `documentos_subidos` | OFF | `file` | Puede contener info confidencial. Opt-in explícito. |
| `repos_de_github` | OFF | `github` | Puede contener secretos / código privado. Opt-in. |
| `posts_de_redes_sociales` | ON | `youtube`, `instagram`, `facebook`, `tiktok` | Todo es público en origen. |
| `conversaciones_importadas_de_otras_ais` | **BLOQUEADO** | (post-MVP cliente MCP) | Filtrado transitivo cross-AI prohibido (§2 inv 1). |

Los 5 scopes activables son **subset autorizable** por agente. Default conservador en `documentos_subidos` y `repos_de_github` por sensitivity.

---

## §7 · Errors (taxonomía)

```ts
type McpGatewayError =
  | { kind: 'unauthorized'; reason: 'no_token' | 'invalid_token' | 'revoked_token' | 'expired_token' }
  | { kind: 'forbidden'; reason: 'scope_denied'; scope: McpScope }
  | { kind: 'rate_limit_exceeded'; reason: 'per_agent' | 'per_user' | 'per_scope'; retryAfterSec: number }
  | { kind: 'kill_switch_active' }
  | { kind: 'tool_not_found'; toolName: string }
  | { kind: 'invalid_input'; reason: string }
  | { kind: 'memory_unavailable'; reason: string } // upstream from memory-ingest
  | { kind: 'internal'; correlationId: string };
```

HTTP status mapping:

| `kind` | HTTP status |
|---|---|
| `unauthorized` | 401 |
| `forbidden` | 403 |
| `rate_limit_exceeded` | 429 (con `Retry-After: <sec>`) |
| `kill_switch_active` | 503 |
| `tool_not_found` | 404 |
| `invalid_input` | 400 |
| `memory_unavailable` | 502 |
| `internal` | 500 |

**Nunca throws**. Pattern Result mismo que `LLM_CLIENT.md` y `MEMORY_INGEST.md`.

---

## §8 · Storage shape (Postgres)

```sql
CREATE TABLE mcp_agent_token (
  id                 uuid PRIMARY KEY,
  user_id            text NOT NULL,
  agent_label        text NOT NULL,
  token_hash         text NOT NULL UNIQUE,  -- sha256 hex
  authorized_scopes  text[] NOT NULL,       -- subset de los 5 scopes activables
  created_at         timestamptz NOT NULL DEFAULT NOW(),
  last_used_at       timestamptz,
  revoked_at         timestamptz
);

CREATE INDEX mcp_agent_token_user_idx ON mcp_agent_token (user_id) WHERE revoked_at IS NULL;
CREATE INDEX mcp_agent_token_hash_idx ON mcp_agent_token (token_hash) WHERE revoked_at IS NULL;

-- Audit aggregate (high volume, low cardinality per row)
CREATE TABLE mcp_read_aggregate (
  user_id        text NOT NULL,
  agent_id       uuid NOT NULL REFERENCES mcp_agent_token(id) ON DELETE CASCADE,
  scope          text NOT NULL,
  day            date NOT NULL,
  read_count     int NOT NULL DEFAULT 0,
  first_read_at  timestamptz NOT NULL,
  last_read_at   timestamptz NOT NULL,
  PRIMARY KEY (user_id, agent_id, scope, day)
);

CREATE INDEX mcp_read_agg_user_day_idx ON mcp_read_aggregate (user_id, day DESC);

-- Rate limit buckets — Postgres es source-of-truth para reconciliación
-- y compliance audit, NO para hot-path (peer review v0.2).
-- Hot-path runtime usa Redis con scripts Lua (ver §9). Postgres
-- guarda snapshots horarios consolidados desde Redis; queries de
-- "uso del último mes" se sirven desde aquí, no desde Redis.
CREATE TABLE mcp_rate_limit_bucket (
  user_id        text NOT NULL,
  agent_id       uuid NOT NULL REFERENCES mcp_agent_token(id) ON DELETE CASCADE,
  window_start   timestamptz NOT NULL,  -- truncated to minute
  read_count     int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, agent_id, window_start)
);

CREATE INDEX mcp_rate_limit_window_idx ON mcp_rate_limit_bucket (user_id, agent_id, window_start DESC);

-- Reconciliation cron: cada hora copia los buckets de Redis al
-- Postgres mediante MGET + INSERT batch. Tras copiar, los buckets
-- viejos en Redis se borran (TTL 2h cubre + 1h margin). Si Redis
-- está caído, el cron skip y reintenta la próxima hora; los
-- buckets en Redis sobreviven hasta su TTL natural.
-- mcp.cron.reconcile_rate_limits

-- Kill switch state (one row per user)
CREATE TABLE mcp_user_state (
  user_id           text PRIMARY KEY,
  server_active     boolean NOT NULL DEFAULT true,
  toggled_at        timestamptz NOT NULL DEFAULT NOW()
);

-- RLS
ALTER TABLE mcp_agent_token ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_agent_token_self ON mcp_agent_token
  USING (user_id = (SELECT auth.uid()::text));

ALTER TABLE mcp_read_aggregate ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_read_agg_self ON mcp_read_aggregate
  USING (user_id = (SELECT auth.uid()::text));

ALTER TABLE mcp_rate_limit_bucket ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_rate_limit_self ON mcp_rate_limit_bucket
  USING (user_id = (SELECT auth.uid()::text));

ALTER TABLE mcp_user_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_user_state_self ON mcp_user_state
  USING (user_id = (SELECT auth.uid()::text));
```

Cleanup background:
- `mcp_rate_limit_bucket`: cron horario borra rows con `window_start < NOW() - interval '2 hours'` (la ventana sliding es 1 hora; 2h margin para reconciliación).
- `mcp_read_aggregate`: retención 90 días por default. Cron diario borra rows con `day < CURRENT_DATE - interval '90 days'`.

---

## §9 · Rate limits

Tres capas, ANDed (un request pasa solo si todas las capas lo permiten):

### 9.1 · Per-agent (sliding window 1h)

Cada API key tiene su bucket. Default: **1,000 reads/hora**. Configurable via flag `mcp.agent_rate_limit_per_hour` (default 1000, min 100, max 10000).

**Storage hot-path: Redis sorted set** (peer review v0.2 — Postgres no escala bajo concurrencia + MCP polling agresivo).

```
ZADD rl:agent:{userId}:{agentId} <timestamp_ms> <request_id>
ZREMRANGEBYSCORE rl:agent:{userId}:{agentId} 0 <now_ms - 3600_000>
ZCARD rl:agent:{userId}:{agentId} -> reads_last_hour
EXPIRE rl:agent:{userId}:{agentId} 7200  -- TTL 2h
```

Las 4 ops corren atomic en un script Lua:

```lua
-- KEYS[1] = rl:agent:userId:agentId
-- ARGV[1] = now_ms ; ARGV[2] = window_ms (3600000) ; ARGV[3] = cap ; ARGV[4] = request_id
local cutoff = tonumber(ARGV[1]) - tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], 0, cutoff)
local count = redis.call('ZCARD', KEYS[1])
if count >= tonumber(ARGV[3]) then
  return {0, count}  -- denied, current count
end
redis.call('ZADD', KEYS[1], ARGV[1], ARGV[4])
redis.call('EXPIRE', KEYS[1], 7200)
return {1, count + 1}  -- granted, new count
```

Si Redis devuelve `denied` → `429 rate_limit_exceeded { reason: 'per_agent' }` + `Retry-After` calculado como `(oldest_score_in_set + 3600_000 - now_ms) / 1000`.

**Fail-open vs fail-closed para Redis down**: si Redis no responde dentro de 50ms (timeout), el gateway **fail-OPEN** (permite el request, emite métrica `mcp_rate_limit_redis_unavailable_total`). Razón: Redis-down no debe traducirse en outage del MCP server entero. Trade-off: rate limits temporalmente sin enforcement; aceptable porque el endpoint público está protegido por Cloudflare WAF que también caps requests per-IP.

### 9.2 · Per-user plan-aware

Cap total cross-agentes según el plan del usuario. Sliding window 24h.

| Plan | Reads/24h cross-agentes |
|---|---|
| Free | 100 |
| Creator | 1,000 |
| Influencer | 10,000 |
| Celebrity | 50,000 |
| Studio | unlimited |

Mismo patrón Redis sorted set (§9.1) con clave `rl:user:{userId}` y window 24h (86,400 ms). Single Lua script ejecuta las 3 capas (per-agent + per-user + per-scope) atómicamente — si cualquiera deny, ninguna otra incrementa. Esto evita el race "request exitosamente pasa per-agent pero per-user falla, dejando counter de per-agent inflated".

Si excede → `429` con `Retry-After` calculado al rollover de las 24h.

### 9.3 · Per-scope sensitive

Caps 10x más estrictos para scopes sensibles:

| Scope | Multiplicador del cap del agente | Cap default agente (1000/h) |
|---|---|---|
| `documentos_subidos` | 0.1 | 100/h |
| `repos_de_github` | 0.1 | 100/h |
| `aprendizajes_del_agente` | 1.0 | 1000/h |
| `identidad_de_marca` | 1.0 | 1000/h |
| `posts_de_redes_sociales` | 1.0 | 1000/h |

Razón: docs y repos son los scopes con más probabilidad de contener info crítica. Un agente comprometido puede drenar info sensible 10x más lento, ganando tiempo de detección.

Si excede el cap del scope → `429 rate_limit_exceeded { reason: 'per_scope', scope: 'documentos_subidos' }`.

---

## §10 · Observability

Spans:

- `mcp.gateway.request` (CLIENT) — wraps todo el handling. Attrs: `mcp.method`, `mcp.tool`, `mcp.agent_id_hash`, `mcp.user.id_hash`, `mcp.latency_ms`, `mcp.outcome`.
- `mcp.auth` (sub) — verifica token. Attrs: `mcp.auth_outcome`.
- `mcp.scope_check` (sub) — verifica scope. Attrs: `mcp.scope_required`, `mcp.scope_outcome`.
- `mcp.rate_limit_check` (sub) — chequea las 3 capas. Attrs: `mcp.rate_limit_outcome`, `mcp.rate_limit_layer` (per_agent/per_user/per_scope cuando deny).
- `mcp.tool.execute` (sub) — invoca memory-ingest. Attrs: `mcp.tool`, `memory.retrieval_latency_ms`.

Metrics:

```
mcp_requests_total{tool, outcome}             Counter
mcp_auth_failures_total{reason}                Counter
mcp_scope_denials_total{scope}                 Counter
mcp_rate_limit_hits_total{layer}               Counter
mcp_kill_switch_blocks_total                   Counter
mcp_active_tokens                              Gauge (per-user gauge)
mcp_request_latency_ms{tool}                   Histogram
mcp_audit_write_failures_total{reason}          Counter
mcp_aggregate_reads_per_user_today             Gauge
```

Dashboards en Grafana paralelos a los del `LLM_CLIENT.md §10`.

Alertas iniciales:

- `mcp_auth_failures_total{reason=invalid_token}` rate > 100/min → page (probable brute force).
- `mcp_rate_limit_hits_total{layer=per_user}` rate > 1k/min → ticket (usuario en abuse loop).
- `mcp_request_latency_ms p99 > 1000` → ticket (Memoria slow upstream).
- `mcp_kill_switch_blocks_total` rate > 0 mantenido por >1h → ticket (usuario olvidó desactivar el kill switch).

---

## §11 · Audit — modelo híbrido

### 11.1 · Aggregated (alto volumen, baja resolución temporal)

Cada read GRANTED incrementa atómicamente `mcp_read_aggregate(user_id, agent_id, scope, day)`. Una sola row por `(usuario, agente, scope, día)`. Volumen estimado: 100k usuarios × 3 agentes × 5 scopes = 1.5M rows ACTIVOS, +1.5M nuevos/día. Manejable en Postgres con índice por `user_id` + retención 90 días.

UPSERT atomic:
```sql
INSERT INTO mcp_read_aggregate (user_id, agent_id, scope, day, read_count, first_read_at, last_read_at)
VALUES ($1, $2, $3, CURRENT_DATE, 1, NOW(), NOW())
ON CONFLICT (user_id, agent_id, scope, day)
DO UPDATE SET
  read_count = mcp_read_aggregate.read_count + 1,
  last_read_at = NOW();
```

### 11.2 · Individual (baja volumen, alta resolución forensic)

Solo policy events (no reads exitosas) van a `system_audit` (la tabla ya firmada en `PRODUCTION_READINESS.md §3`). Actions:

| action | trigger | body |
|---|---|---|
| `mcp.agent_authorized` | usuario autoriza nuevo agente | agentLabel, scopes |
| `mcp.agent_revoked` | usuario revoca agente | agentLabel |
| `mcp.agent_rotated_old` | rotación: row viejo deprecated | agentLabel |
| `mcp.agent_rotated_new` | rotación: row nuevo creado | agentLabel, scopes |
| `mcp.kill_switch_on` | usuario activa kill switch | — |
| `mcp.kill_switch_off` | usuario desactiva kill switch | — |
| `mcp.auth_failed` | request con token inválido/revocado/expired | reason |
| `mcp.scope_denied` | agente intentó tool fuera de scope autorizado | agentId, scopeRequested, toolName |
| `mcp.rate_limit_hit` | request rejected por rate limit | agentId, layer (per_agent/per_user/per_scope), bucketReadCount |
| `mcp.kill_switch_blocked` | request rejected por kill switch activo | agentId |

Granted reads NO van a `system_audit` — viven en `mcp_read_aggregate`.

---

## §12 · Schema migrations

Migraciones bajo `apps/web/supabase/migrations/`:

- `0010_mcp_agent_token.sql` — tabla + indexes + RLS.
- `0011_mcp_read_aggregate.sql` — tabla + indexes + RLS.
- `0012_mcp_rate_limit_bucket.sql` — tabla + indexes + RLS + cron de cleanup horario.
- `0013_mcp_user_state.sql` — tabla kill switch + RLS.

Migraciones de retención (cron):
- `mcp.cron.cleanup_rate_limits` — horario, borra `mcp_rate_limit_bucket` con `window_start < NOW() - interval '2 hours'`.
- `mcp.cron.cleanup_aggregates` — diario, borra `mcp_read_aggregate` con `day < CURRENT_DATE - interval '90 days'`.

---

## §13 · Metrics surface (resumen)

Total ~10 metrics nuevas. Cardinalidad bounded: `tool` (2 valores en MVP), `scope` (5), `layer` (3), `outcome` (5-6). Dashboards en Grafana paralelos a los de `MEMORY_INGEST.md §10`.

Alertas críticas listadas en §10.

---

## §14 · Testing & security

### Tests

- **Unit**:
  - Token hashing + verification (sha256).
  - Scope mapping `McpScope ↔ MemoryItem.source`.
  - Rate limit algorithm (sliding window math).
  - Kill switch atomic semantics.
- **Property-based**:
  - `fc.assert(verify(hash(plaintext)) === true)` con plaintext arbitrario.
  - `fc.assert(grantedRead(scope) implies scope ∈ authorizedScopes)`.
- **Integration** end-to-end con Supabase locally:
  - Auth flow: authorize → use → revoke → use deniedmig.
  - Scope flow: authorize subset → request out-of-scope → 403 + audit.
  - Rate limit: burst 1k+1 reads → último 429 + audit.
  - Kill switch: enable → request → 503 + audit. Disable → request → 200.
  - RLS: agente del userA con tokenHash de userB → 401.
- **Chaos**: Postgres slow on audit write (>500ms), audit failure path → response procede + métrica increment.

Coverage gates: stmts ≥90, branches ≥85, funcs ≥90, lines ≥90 (mismo gate que llm-client global).

### Security

- **CI key-leak linter** — extender `scripts/check-no-key-in-logs.ts` al nuevo paquete con un patrón adicional para detectar literales `foco_mcp_<base62>` en src/.
- **TLS 1.3+ obligatorio** (§2 invariante 9). Cert via Let's Encrypt rotation automática.
- **Brute force protection** — `mcp.auth_failed` rate > 10/min por IP origin → IP bloqueada por 1h vía Cloudflare WAF rule. Configurada infra-side, no en código del paquete.
- **API keys con shape verificable** — el prefijo `foco_mcp_` permite scanners externos (Truffleshog, Gitleaks) detectar keys leaked en repos públicos del usuario.
- **Pen-test pre-launch** — auth + scope + rate limit son surface alta-prioridad. Ronda externa requerida antes de liberar el endpoint público de mcp.foco.chisu.io.

---

## §15 · Extensibilidad post-MVP

**Secret redaction en retrieval (post-MVP)** — alineado con §2 invariante 11.

El gateway NO redacta secretos en MVP por scope; los chunks se devuelven tal cual el usuario los ingestó. Plan post-MVP, en orden de implementación:

1. **Entropy scanning**: heurística sobre cada chunk pre-respuesta. Strings de 20+ chars con entropía Shannon >4.5 → marca como sospechoso.
2. **Secret classifiers regex**: patrones conocidos (Anthropic `sk-ant-...`, OpenAI `sk-...`, AWS `AKIA...`, GitHub PAT `ghp_...`, Stripe `sk_live_...`, JWT `eyJ...`). Matched → reemplaza por `[REDACTED:<provider>]` y emite métrica `mcp_secrets_redacted_total{type, scope}`.
3. **ML classifier**: modelo entrenado para detectar credentials en código. Llama a un servicio interno (no llm-client — sería over-engineering); más caro que regex pero atrapa edge cases.
4. **Redact-at-retrieval, no at-ingest**: la decisión de redactar se toma al retorno del request MCP, no al momento de ingest. Razón: el usuario puede legítimamente subir un repo con secretos para uso interno (Claude generándole docs sobre la app); pero NO quiere que esos secretos se filtren a otros agentes externos vía MCP. Two-phase defense.
5. **Audit individual de redactions**: cada chunk redactado emite row en `system_audit` con `mcp.secret_redacted` para forensics.

Defaults conservadores actuales (`repos_de_github` y `documentos_subidos` OFF) NO sustituyen secret redaction — un usuario que opt-in a esos scopes con buena fe pero un repo accidentalmente con secretos sigue expuesto. El roadmap es additive a los defaults.

---

**Lado cliente del MCP** (Foco lee de servers externos): paquete adyacente `@chisu/mcp-client`. Diseño análogo, OAuth-flow para autorizar a Foco contra el MCP server externo, ingesta a Memoria con `source: 'mcp-client'` + tag `connector_meta.mcp_origin: 'claude-desktop'`. Diferido junto con la implementación del paquete `@chisu/memory-ingest` (ver `MEMORY_INGEST.md v0.3 §15`).

**Tools de mutación** (`memory.add_item`, `memory.delete_item`):
- Diferidos por seguridad. Un agente comprometido NO puede modificar la Memoria del usuario en MVP.
- Cuando entren post-MVP: requieren scope adicional `memory_write` (default OFF), audit individual de cada mutación, idempotency key obligatoria.

**Lista de tools post-MVP**:
- `memory.list_sources` — enumerar fuentes activas (con risk de fingerprinting; defer hasta tener trust signal del agente).
- `memory.get_aggregate_stats` — estadísticas (total chunks, distribución por source).
- `memory.subscribe` — long-running subscription a updates de Memoria (notify cuando un chunk nuevo entra). Requiere infra de WebSockets o long-polling.

**OAuth 2.0 client credentials** como auth alternativo (post-MVP) — para integraciones B2B con SSO empresarial. El bearer token by-default sigue siendo válido; OAuth se agrega como segunda forma de auth.

**Hybrid + reranker** en la Memoria search (delegado a `memory-ingest` según firmado en su §16) — el gateway no necesita cambiar; consume lo que `memory-ingest` exponga.

---

## §16 · Decisiones cerradas (firmadas 2026-04-23)

Las 4 decisiones críticas iniciales + 4 decisiones del peer review v0.2 — todas resueltas en sesión 2026-04-23:

**Iniciales (v0.1)**:

1. **Transport** — ✅ FIRMADO. HTTP + SSE en MVP. Streamable queda como opcional post-MVP cuando >50% de los clientes MCP populares lo soporten.
2. **Auth** — ✅ FIRMADO. API key per `(user, agent)` bearer token. Plaintext sha256-hashed at rest, mostrado UNA vez al usuario al generar. OAuth queda diferido a post-MVP para casos B2B/SSO.
3. **Audit log** — ✅ FIRMADO. Híbrido: aggregated diario por `(user, agent, scope, day)` + individual rows en `system_audit` solo para policy events.
4. **Rate limits** — ✅ FIRMADO. Combinado: per-agent (1k/h base) + per-user plan-aware (Free 100/24h → Studio unlim) + per-scope sensitive (`documentos_subidos`/`repos_de_github` 10x más estrictos).

**Del peer review (v0.2)**:

5. **Scope explícito en queries** — ✅ FIRMADO. `memory.search` requiere `scope: McpScope` top-level y obligatorio. El gateway NO infiere scope desde lenguaje natural. Razón: NL inference complica auditoría, introduce nondeterminismo, crea riesgo de leaks accidentales.
6. **Opaque handles para item identifiers** — ✅ FIRMADO. `memory.search` devuelve handles HMAC-firmados con TTL 5 min en vez de `MemoryItem.id` directos. `memory.get_item` consume handles. Defensa contra enumeration/probing aunque el auth esté bien.
7. **Rate limit hot-path en Redis** — ✅ FIRMADO. Redis sorted sets + Lua scripts para los 3 chequeos atómicos. Postgres queda solo para reconciliación horaria + audit. Razón: Postgres no escala bajo concurrencia alta + MCP polling agresivo. Fail-open si Redis no responde en 50ms (Cloudflare WAF como defensa de respaldo).
8. **Secret redaction roadmap explícito** — ✅ FIRMADO. Invariante #11 nuevo: el paquete NO redacta secretos en MVP — boundary de responsabilidad explícita (similar a §2 inv 4 PII en `MEMORY_INGEST.md v0.3`). Roadmap post-MVP en §15: entropy scanning + regex classifiers + ML classifier + redact-at-retrieval + audit individual. Defaults conservadores (`repos_de_github`/`documentos_subidos` OFF) son defensa parcial, no sustituto.

Ningún ítem queda abierto. Pendiente solo firma final de Jean.

---

## §17 · Relación con otros documentos

- **`UX_FROZEN.md v1.4 §3.2`** — define la pantalla `settings-mcp` y los 6 scopes con defaults. Este doc es el backend que esa pantalla consume. Compatible 100% con la firma v1.4.
- **`MEMORY_INGEST.md v0.3`** — provee la search/get_item que el gateway expone. El gateway es cliente de memory-ingest (no inverso). Cualquier mejora de retrieval (hybrid, reranker, HyDE post-MVP) la consume el gateway transparentemente.
- **`PRODUCTION_READINESS.md v1.0 §3 (system_audit)`** — el audit log compartido. Las 10 actions individuales de §11 caen en esa tabla.
- **`INGEST_SECURITY.md v1.0`** — el gateway NO ingesta directamente. El lado cliente del MCP (post-MVP) sí ingestará via memory-ingest, que aplica INGEST_SECURITY como cualquier otro conector.
- **`LLM_CLIENT.md v1.1`** — sin relación directa. El gateway no llama LLMs (no genera, solo expone Memoria).

---

## Changelog

- **v0.1 — 2026-04-23**. Borrador inicial firmable. Las 4 decisiones críticas (transport, auth, audit, rate limits) firmadas en la misma sesión. Estructura paralela a `MEMORY_INGEST.md v0.3`.
- **v0.2 — 2026-04-23**. Incorpora las 4 correcciones del peer review cruzado:
  1. **Scope explícito** (no inferido desde NL): `memory.search` requiere `scope` top-level obligatorio. §3.4 + §5.1 actualizados.
  2. **Opaque handles** (no `MemoryItem.id` directos): `memory.search` devuelve handles HMAC-firmados TTL 5 min; `memory.get_item` consume handles. §3.4 + §5.2 actualizados.
  3. **Redis hot-path para rate limits**: §8 + §9 reescritos. Postgres queda solo para reconciliación horaria + audit. Lua script atómico para los 3 chequeos.
  4. **Secret redaction roadmap**: §2 invariante #11 nuevo (boundary de responsabilidad), §15 con plan post-MVP de 5 pasos. Pendiente firma final de Jean.
