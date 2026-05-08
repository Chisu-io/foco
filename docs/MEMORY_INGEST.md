# `MEMORY_INGEST.md` — Memoria pipeline para Foco (v0.4 firmable)

**Estado**: borrador firmable v0.4 — 2026-04-23. Bump por consistencia con `SUPABASE_SCHEMA.md v0.2`: idempotency check del pipeline pasa de `content_hash` a `(source_uri, chunk_index)` para evitar colisión cross-document de chunks textualmente idénticos. Pendiente firma final de Jean.

**Scope**: contrato técnico del paquete `@chisu/memory-ingest` (a crear) que materializa la **Memoria** de Foco. Pipeline de ingesta (chunking + embedding + storage) + retrieval (búsqueda semántica) sobre 6 conectores MVP. Sin código hasta firma — este documento es el contrato firmable, paralelo a `LLM_CLIENT.md v1.1`, `UX_FROZEN.md v1.3`, `INGEST_SECURITY.md v1.0`, `PRODUCTION_READINESS.md v1.0`.

**Decisiones firmadas (2026-04-23)**:

- **Scope MVP** = subset social-first 6 conectores: **archivo, GitHub, YouTube, Instagram, Facebook, TikTok**. Los 5 conectores diferidos: link, Drive, MCP, LinkedIn, X — todos quedan como **post-MVP** documentados en §15. Sin código para ellos en v1.0.
- **Embeddings** = OpenAI `text-embedding-3-small`, 1536 dim, ~$0.02 / 1M tokens. Provider único en MVP.
- **Vector store** = Supabase pgvector. Mismo Postgres que `system_audit`, `user_quota`, `user_llm_key`.
- **Privacidad at-rest** = RLS Supabase only. Encriptación de disco vía Supabase nativo, sin envelope encryption KEK-per-user (los chunks no llevan PII fuerte por contrato §2 invariante 4 — el usuario es responsable de qué ingestar).
- **TikTok content extraction** = description + ASR via OpenAI Whisper API. Reusa la BYOK key OpenAI del usuario (misma que embeddings). Coste ~$0.006/min de audio. TikTok pipeline es **async/queue-based** por la latencia del ASR (10-30s/video).

---

## §1 · Alcance del paquete

`@chisu/memory-ingest` resuelve **un solo problema**: dado un usuario y un conjunto de fuentes, mantener un índice semántico consultable que el `assistant-conversation` (Asistente Foco) y la generación de contenido (`script-generation`, `caption-refine`, `hook-brainstorm`) usan para personalizar al usuario.

El paquete **no** decide qué generar, no escribe contenido, no toma decisiones de plan-routing. Esos viven en `@chisu/llm-client`. La Memoria es solo la capa de *retrieval-augmented generation* (RAG) que alimenta a esos consumidores con contexto del usuario.

**Boundary clara con `@chisu/llm-client`**:

- llm-client: provee respuestas LLM. Recibe `messages` + `userId` + `system_prompt`. No sabe nada de Memoria.
- memory-ingest: provee chunks relevantes. Recibe `userId` + `query`. No sabe nada de LLM.
- El **caller** (apps/web orquestador) es quien combina ambos: query → memory-ingest → topK chunks → inyecta al system_prompt → llm-client → respuesta.

**Boundary clara con `INGEST_SECURITY.md v1.0`**:

`INGEST_SECURITY` cubre la **defensa perimetral** del proceso de ingesta (quarantine, ClamAV, MIME sniff, sandbox, SSRF, audit log). Este doc cubre la **lógica de pipeline post-defensa**: cómo chunk, cómo embed, cómo almacenar, cómo recuperar. La defensa siempre corre primero — un upload nunca pasa al pipeline si no superó §INGEST_SECURITY.

```
Upload/URL → INGEST_SECURITY (defensa) → memory-ingest (este doc) → pgvector → retrieval
```

---

## §2 · Invariantes (10) — no negociables

Los 10 invariantes del paquete. Cualquier cambio requiere **bump major + re-firma** (semver semantics como `LLM_CLIENT.md`).

1. **Memoria es por-usuario, siempre**. Todo chunk lleva `user_id`; todo query filtra por `user_id` antes del vector search. Cero cross-tenant leakage. RLS de Supabase enforced en cada SELECT.

2. **El usuario controla qué ingesta**. No hay scraping automático sin acción explícita del usuario. Cada conector requiere consentimiento OAuth (Instagram + Facebook unified Meta, TikTok, GitHub, YouTube cuando aplique) o acción manual (subir archivo).

3. **Right to forget**. `DELETE` masivo por `user_id` debe completarse en <60s para 50k chunks. Borra row en pgvector + chunk_text + metadata + audit entry de la operación.

4. **PII es responsabilidad del caller, no garantía del paquete**. El paquete NO escanea ni redacta PII automáticamente. El usuario es responsable de qué ingesta y de evitar contenido sensible. El sistema **sí puede persistir PII indirecta** proveniente del contenido del usuario (menciones a terceros en captions de IG/FB, nombres en transcripts de TikTok/YouTube, emails en docs subidos, etc.). Este invariante es una **boundary de responsabilidad**, NO una garantía de compliance: la UX layer arriba (warning UI antes de ingestar, opt-in para sources sensibles) es responsable de evitar que PII no consentida entre. El paquete sí evita persistir identifiers **automáticos del conector** (header del JWT del OAuth de Drive/Meta, IDs internos del API, etc.) — solo el contenido textual del documento.

5. **Embedding único**. Un solo provider en MVP (OpenAI text-embedding-3-small). Cambiar provider requiere migración de TODA la base vectorial (los embeddings no son comparables entre providers). Bump major + plan de migración firmado.

6. **Idempotencia por posición de chunk en su documento**. La misma fuente ingestada dos veces produce el mismo `(user_id, source_uri, chunk_index) → mismo chunk_id`. No re-embedea, no duplica. El `content_hash` (SHA-256 del chunk_text normalizado) se almacena como **información secundaria** — útil para queries futuras de dedup cross-document — pero NO es la key de idempotency.

   **Razón del fix v0.4** (peer review de `SUPABASE_SCHEMA.md`): el v0.3 usaba `content_hash` como key de idempotency, lo cual era buggy — dos documentos distintos pueden tener chunks textualmente idénticos (ej. `import { foo } from 'bar'` aparece en muchos archivos del mismo repo) y colisionaban al insertar. La fix correcta: idempotency es por la posición del chunk dentro de su documento (`source_uri + chunk_index`), no por el contenido textual.

7. **Quotas hard-capped por plan**. Un usuario en plan Free no puede tener >100 chunks (ver §6). Intento de exceder → `quota_exhausted` error con userMessage que apunta al upgrade.

8. **Retrieval estable y reproducible** (NO matemáticamente determinista). Mismo `(userId, query, k, filters)` produce los mismos topK chunks **mientras el índice no haya cambiado entre llamadas**. Importante: `ivfflat` es un algoritmo de búsqueda **aproximada** (ANN — approximate nearest neighbor); tras un rebuild del índice o cambio de `lists`, los topK pueden variar ligeramente para el mismo query. Lo que SÍ se garantiza por el paquete: sin random sampling explícito, sin temperature, sin reranker stochastic, sin shuffling. El algoritmo subyacente (ivfflat probabilities) introduce su propia variabilidad-bajo-rebuild, que es trade-off acceptable para escala >1M chunks. Si en post-MVP se requiere determinismo dura (ej. legal hold), migrar a `hnsw` con `ef_construction` fijo o vector index exhaustivo.

9. **No conversaciones IA en Memoria**. Las salidas del Asistente, scripts generados, captions producidos NO entran a Memoria automáticamente. El usuario puede explícitamente "guardar a Memoria" un output, pero la default es no-persistir. (Coherente con `project_foco_mcp_bidireccional`: conversaciones IA no se re-exponen.)

10. **Auditable**. Cada ingesta + cada delete masivo + cada cambio de scope OAuth produce un row en `system_audit` con la action correspondiente (§11). Las queries de retrieval NO se auditan (volumen prohibitivo + ya quedan en `llm_token_usage` cuando llegan al LLM).

---

## §3 · Modelo de datos

### 3.1 · `MemoryItem` (la unidad de almacenamiento)

```ts
interface MemoryItem {
  readonly id: string;           // UUID v7 — sortable por tiempo
  readonly userId: string;
  readonly source: ConnectorKind;
  readonly sourceUri: string;    // URL canonical o filename + hash
  readonly sourceTitle: string;  // human-readable: "Mi pitch deck Q4"
  readonly contentHash: string;  // sha256 hex del chunk_text post-normalización
  readonly chunkText: string;    // texto plano del chunk
  readonly chunkIndex: number;   // 0-based dentro del documento original
  readonly chunkTotal: number;   // total de chunks del mismo documento
  readonly embedding: Float32Array;
  /**
   * Identifier of the embedding model that produced `embedding`.
   * Pinned to `'text-embedding-3-small'` in MVP. Stored explicitly so
   * post-MVP migrations (e.g. swap to `text-embedding-3-large` or a
   * different provider) can coexist: retrieval queries filter by
   * `embedding_model = currentModel` to avoid comparing vectors from
   * incompatible spaces.
   */
  readonly embeddingModel: string;
  /**
   * Vector dimensionality. Stored alongside `embeddingModel` so a
   * migration that produces shorter/longer vectors is detectable
   * without parsing the model identifier. 1536 in MVP.
   */
  readonly embeddingDim: number;
  readonly metadata: ChunkMetadata;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;     // updated en re-ingesta (idempotente)
}

type ConnectorKind = 'file' | 'github' | 'youtube' | 'instagram' | 'facebook' | 'tiktok';

interface ChunkMetadata {
  readonly mimeType: string;
  readonly language?: string;        // 'es' | 'en' | undefined
  readonly publishedAt?: Date;       // fecha del documento original (no del chunk)
  readonly tags?: readonly string[]; // user-supplied: ["pitch", "Q4 2026"]
  readonly connectorMeta?: Readonly<Record<string, unknown>>;
}
```

`connectorMeta` es **opaque por conector** — Instagram guarda `{ postId, mediaType, postedAt }`; YouTube guarda `{ videoId, channelId, durationSec, transcriptLang }`; TikTok guarda `{ tiktokId, durationSec, asrModel, asrLatencyMs }`; etc. Schema firmado por conector en §9.

### 3.2 · `IngestRequest` (input de ingesta)

```ts
type IngestRequest =
  | { kind: 'file'; userId: string; file: { name: string; mimeType: string; bytes: Uint8Array }; }
  | { kind: 'github'; userId: string; repo: string; ref?: string; paths?: readonly string[]; }
  | { kind: 'youtube'; userId: string; videoUrl: string; }
  | { kind: 'instagram'; userId: string; postUrl: string; }
  | { kind: 'facebook'; userId: string; postUrl: string; }
  | { kind: 'tiktok'; userId: string; videoUrl: string; };
```

Cada variante firma su shape. El orchestrator (apps/web) construye la variante correcta tras OAuth. El paquete nunca ve credenciales de OAuth en plano — el conector las maneja internamente vía el repo seam (§9).

### 3.3 · `RetrievalQuery` (input de búsqueda)

```ts
interface RetrievalQuery {
  readonly userId: string;
  readonly query: string;
  readonly k?: number;              // default 8, max 50
  readonly filters?: RetrievalFilters;
  readonly minScore?: number;       // default 0.65 (cosine sim)
}

interface RetrievalFilters {
  readonly source?: readonly ConnectorKind[];
  readonly tags?: readonly string[];
  readonly publishedAfter?: Date;
  readonly publishedBefore?: Date;
  readonly languages?: readonly string[];
}

interface RetrievalResult {
  readonly chunks: readonly RetrievedChunk[];
  readonly totalCandidates: number; // pre-minScore filter
  readonly latencyMs: number;
}

interface RetrievedChunk {
  readonly item: MemoryItem;
  readonly score: number;           // cosine similarity, 0..1
}
```

`minScore` clampea ruido — un chunk con cosine sim 0.4 raramente es útil al LLM. Default 0.65 es conservative; el caller puede bajarlo si quiere recall más alto.

---

## §4 · Pipeline de ingesta — los 7 pasos

Cada `IngestRequest` recorre 7 pasos en orden. Failure en cualquiera → ingesta falla atómicamente, no parcial. Si pasos 1-4 succeed pero 5 falla, el rollback borra los chunks insertados en pasos 1-4 (transacción Postgres).

**Sync vs async por conector**:

- `file`, `github`, `youtube`, `instagram`, `facebook` corren **synchronous** — la API call del usuario espera la respuesta. p95 esperado <8s.
- `tiktok` corre **async/queue-based** — el ASR de Whisper sobre el audio del video toma 10-30s. La API devuelve `{ status: 'pending', ingestId }` inmediato; el job termina en background y emite `system_audit.memory.ingest` cuando completa. UI poll o websocket para feedback.

### Step 1 — Defensa perimetral (`INGEST_SECURITY`)

`memory-ingest` NO ejecuta este paso — lo asume hecho. El caller (apps/web) corre el pipeline de `INGEST_SECURITY.md` (quarantine, ClamAV, MIME sniff, SSRF, sandbox) **antes** de invocar `memory-ingest.ingest(request)`. Si la defensa rechaza, `memory-ingest` ni se llama.

Si por alguna razón el caller olvidó la defensa, el paquete corre una **última verificación liviana** sobre `request`:

- `userId` presente y válido (zod).
- `kind` en el enum.
- Tamaño máximo del payload (50 MB para `file`, no aplica a otros).

Falla ahí → `make.invalid_input(reason)` sin tocar el resto del pipeline.

### Step 2 — Resolve via conector

Cada conector implementa `Connector.resolve(request) → Promise<Result<RawDocument, ConnectorError>>`. El conector traduce la variante del `IngestRequest` a un `RawDocument` normalizado:

```ts
interface RawDocument {
  readonly source: ConnectorKind;
  readonly sourceUri: string;        // canonical URI for idempotency
  readonly sourceTitle: string;
  readonly mimeType: string;
  readonly bytes?: Uint8Array;       // file
  readonly text?: string;            // youtube transcript, instagram caption, facebook post body
  readonly mediaUrl?: string;        // tiktok — el video pasa a step 3 ASR
  readonly metadata: ChunkMetadata;  // sin chunkIndex/chunkTotal aún
}
```

Un conector que falla en autenticar (token expirado), encontrar (404), o en rate limit → `ConnectorError` que el orchestrator surface.

### Step 3 — Extract text

Convertir `bytes` / `text` / `mediaUrl` a un único string normalizado:

- **PDF / DOCX**: `pdf-parse` / `mammoth`.
- **Markdown / TXT / CSV**: parse trivial.
- **YouTube transcript**: el conector ya devuelve text plano + timestamps en `connectorMeta`.
- **Instagram caption**: text plano (el conector ya canonicalizó hashtags + mentions).
- **Facebook post**: text plano del post body. Imágenes adjuntas no se procesan en MVP (vision queda post-MVP).
- **GitHub README/code**: text plano (la sintaxis es parte del contenido).
- **TikTok**: pipeline async — descarga video desde `mediaUrl`, lo pasa por OpenAI Whisper API (`whisper-1`), concatena `description + "\n\n[ASR]\n" + transcript`. Reusa la BYOK key OpenAI del usuario; falla con `byok_required` si no está configurada. Coste estimado ~$0.006/min de audio.

Output: `string` en utf-8, NFC-normalized, sin null bytes. Vacío → ingesta falla con `empty_content`.

### Step 4 — Chunk

Estrategia por defecto: **fixed-size con overlap**.

- Tamaño: 800 tokens (medido con `tiktoken` `cl100k_base` — el tokenizer del embedder).
- Overlap: 100 tokens.
- Boundary preservation: prefer split en `\n\n` > `\n` > `. ` > tokens.

Cada chunk gana:

- `chunkIndex`, `chunkTotal`.
- `contentHash = sha256(normalize(chunkText))` — `normalize` lowercases + trim + collapsa whitespace múltiple. Idempotency.

Override por conector documentado en §9 (ej. YouTube splits en boundaries de transcript; GitHub respeta function/class boundaries vía tree-sitter).

### Step 5 — Idempotency check

Para cada chunk: `SELECT id FROM memory_item WHERE user_id = $1 AND source_uri = $2 AND chunk_index = $3`. Si existe, **update `last_seen_at`** + comparar `content_hash` para detectar si el contenido cambió:

- **Hit + same content_hash** → skip embedding (ahorra cost), bump `last_seen_at`.
- **Hit + different content_hash** → re-embed con el chunk nuevo + UPDATE `chunk_text`/`embedding`/`content_hash`/`last_seen_at`. Esto cubre el caso de re-ingesta donde el documento cambió pero chunk_index alineó (ej. Drive doc editado en la misma posición).
- **No hit** → sigue al step 6 (insert nuevo).

**Razón del fix v0.4** (peer review de `SUPABASE_SCHEMA.md v0.2`): el v0.3 chequeaba por `content_hash` directo, lo cual fallaba para chunks textualmente idénticos en documentos distintos (mismo `import` line en dos archivos). La fix usa la posición del chunk dentro de su documento como key — coherente con el `UNIQUE (user_id, source_uri, chunk_index)` del schema.

### Step 6 — Embed

Llamada batch a OpenAI: `POST /v1/embeddings` con todos los chunks new-content del `RawDocument` en un solo request (max 100 inputs por batch — la API permite hasta 2048 pero 100 mantiene latencia bounded).

- Modelo: `text-embedding-3-small`.
- Dimensions: 1536.
- Encoding format: `float`.
- BYOK: usa la `userId`'s key vía `@chisu/llm-client.embed()` (método a añadir en bump 0.2.0 — ver §17). Si BYOK no está configurada, falla con `byok_required` (las cuotas Free/Creator de Memoria requieren BYOK — ver §6).

Latency budget: 30s para batch de 100. Timeout → ingesta falla, rollback.

### Step 7 — Upsert + audit

```sql
INSERT INTO memory_item (id, user_id, source, source_uri, chunk_index, ..., embedding, ...)
  VALUES (...)
  ON CONFLICT (user_id, source_uri, chunk_index) DO UPDATE SET
    chunk_text = EXCLUDED.chunk_text,
    content_hash = EXCLUDED.content_hash,
    embedding = EXCLUDED.embedding,
    last_seen_at = NOW()
  RETURNING id;
```

(v0.4: el `ON CONFLICT` target alineado con el `UNIQUE` constraint de
`SUPABASE_SCHEMA.md v0.2 §4.7`. El UPDATE branch refresca el contenido si
el chunk en la misma posición cambió — caso "doc editado en Drive".)

Tras el upsert, audit entry:

```ts
{
  action: 'memory.ingest',
  actor: { kind: 'user', id: hashUserId(userId) },
  resource: { type: 'memory_source', id: sourceUri },
  details: { source, chunksAdded, chunksSkipped, totalTokens, asrCostUsd? }
}
```

Para TikTok, `asrCostUsd` se incluye con el costo computado de Whisper (visible en UI billing breakdown).

---

## §5 · Retrieval — los 4 pasos

```
query → embed(query) → SQL SELECT con vector op → filter → rank → topK
```

### Step 1 — Embed query

Mismo modelo (`text-embedding-3-small`), single-input call. ~50-100ms p50.

### Step 2 — SQL vector search

```sql
-- The embedding_model filter is critical post-migration: comparing
-- vectors across different models produces meaningless cosine
-- distances. In MVP only one model exists so the filter is no-op,
-- but the query is shaped today so v0.4+ migrations don't have to
-- rewrite call-sites.
SELECT id, chunk_text, source, source_uri, metadata,
       1 - (embedding <=> $1) AS score
FROM memory_item
WHERE user_id = $2
  AND embedding_model = $7  -- always passed by caller; default 'text-embedding-3-small' in MVP
  AND ($3::text[] IS NULL OR source = ANY($3))
  AND ($4::text[] IS NULL OR metadata->'tags' ?| $4)
  AND ($5::timestamptz IS NULL OR (metadata->>'publishedAt')::timestamptz >= $5)
ORDER BY embedding <=> $1
LIMIT $6;
```

`<=>` es cosine distance en pgvector. `1 - distance = similarity`. Index: `ivfflat` con `lists = sqrt(N_total_chunks)`, recreated cuando N crece >2x.

### Step 3 — Filter por minScore

Cualquier chunk con `score < minScore` (default 0.65) se descarta post-SQL. Si quedan menos de `k`, se devuelve lo que hay (no se rebaja minScore automáticamente — eso es decisión del caller).

### Step 4 — Return topK

`RetrievalResult` con `chunks: RetrievedChunk[]`, ordenado descendente por score.

**No reranker en MVP**. Reranker (Cohere rerank-3 o Voyage rerank-2) queda como decisión abierta (§16).

---

## §6 · Quotas por plan (PROPUESTA — pendiente firma)

| Plan       | Total chunks | Ingestas / día | Retrieval calls / día | Embedding tokens / mes | ASR minutos / mes (TikTok) |
|------------|--------------|----------------|------------------------|--------------------------|------------------------------|
| Free       | 100          | 10             | 50                     | 100k                     | 10                           |
| Creator    | 1,000        | 50             | 500                    | 1M                       | 60                           |
| Influencer | 10,000       | 200            | unlimited              | 10M                      | 600                          |
| Celebrity  | 50,000       | unlimited      | unlimited              | 50M                      | unlimited                    |
| Studio     | unlimited    | unlimited      | unlimited              | unlimited                | unlimited                    |

**Free / Creator requieren BYOK** para embeddings + ASR Whisper, igual que para LLM calls (`LLM_CLIENT.md §4.1`). Coherente: si Foco no paga el LLM en estos planes, tampoco paga embeddings ni ASR.

**ASR minutos** son un cap **adicional** al embedding tokens — un usuario con 100 videos de 5 min = 500 min de ASR (overflow del cap Influencer 600 min, pasa por upgrade). Whisper es ~$0.006/min, así que el cap protege contra runaways de costo.

**Decisión abierta**: ¿estos números son los firmables o ajustamos? Pendiente §16.

`memory-ingest` consulta el `UserQuotaRepo` (mismo seam que `llm-client`) para resolver el plan + counts antes de cada ingesta. Counts viven en una tabla nueva `memory_user_stats` con `chunks_total`, `ingests_today`, `retrievals_today`, `asr_minutes_month`, refreshed en cada operación.

### 6.1 · `memory_user_stats` drift policy

`memory_user_stats` es **denormalizada pero source of truth para quotas en runtime**. Las decisiones de cuota se hacen contra esta tabla (no contra `SELECT count(*) FROM memory_item`); ese count() es O(N) y prohibitivo a escala.

Drift es real (la tabla puede desincronizarse del estado autoritativo de `memory_item`). Política explícita:

1. **Update transactional**: cada operación que cambia counts (ingest, delete, retrieval, embed-call, ASR-call) actualiza `memory_user_stats` **en la misma transacción Postgres** que la operación principal. Si la transacción falla, ambas se revierten — no hay path donde un chunk se inserte y el counter no se incremente, ni viceversa.

2. **Daily/monthly resets**: cron diario (`memory.cron.reset_daily`) verifica `last_reset_day < CURRENT_DATE`; si cierto, resetea `ingests_today` y `retrievals_today` a 0, actualiza `last_reset_day`. Mismo patrón para `last_reset_month` con `embed_tokens_month` y `asr_minutes_month`.

3. **Reconciliación periódica**: cron diario (`memory.cron.reconcile_stats`) compara, **por usuario activo en últimas 30 días**, el `chunks_total` denormalizado contra `SELECT count(*) FROM memory_item WHERE user_id = $1`. Drift detectado:
   - Emite métrica `memory_stats_drift_total{metric, direction}` con `direction ∈ {high, low}` (denormalizado mayor o menor que real).
   - Corrige el valor denormalizado al count autoritativo.
   - Si drift > 5% del cap del plan del usuario, audit entry `memory.stats_drift_corrected` con `before/after` para forensics.

4. **Retries en transacción**: las transacciones que fallan por contención (deadlock, serialization conflict) se reintentan con backoff exponencial 50-500ms, max 3 intentos. Tras 3 intentos fallidos → operación falla con `storage_unavailable`, NO se incrementa el counter. Eso garantiza la propiedad transaccional (#1).

5. **Cuotas hard-capped son consultas, no escrituras**: el chequeo de "¿este usuario excedió cap del plan?" es un `SELECT` puro contra `memory_user_stats`. La operación que excede el cap NUNCA se ejecuta — el chequeo se hace pre-transaction. Esto evita la race "dos requests concurrentes pasan ambos el chequeo y cada uno incrementa, terminando 1 sobre el cap". El chequeo + increment es atómico vía `SELECT FOR UPDATE` o equivalent locking row-level.

---

## §7 · Errors (taxonomía)

```ts
type MemoryError =
  | { kind: 'invalid_input'; reason: string }
  | { kind: 'connector_unavailable'; connector: ConnectorKind; retryAfterSec?: number }
  | { kind: 'connector_unauthorized'; connector: ConnectorKind } // OAuth expired
  | { kind: 'connector_not_found'; connector: ConnectorKind; uri: string }
  | { kind: 'extract_failed'; mimeType: string; reason: string }
  | { kind: 'asr_failed'; provider: 'openai_whisper'; reason: string }
  | { kind: 'empty_content' }
  | { kind: 'embed_failed'; reason: string } // delegated to llm-client errors
  | { kind: 'quota_exhausted'; metric: 'chunks' | 'ingests' | 'retrievals' | 'embed_tokens' | 'asr_minutes' }
  | { kind: 'byok_required'; provider: 'openai' }
  | { kind: 'storage_unavailable' } // Postgres down
  | { kind: 'internal'; correlationId: string };
```

**Nunca throws**. Toda falla → `Result<T, MemoryError>`. Mismo patrón que `LLM_CLIENT.md §3.5`.

---

## §8 · Storage shape (Postgres / pgvector)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_item (
  id              uuid PRIMARY KEY,
  user_id         text NOT NULL,
  source          text NOT NULL CHECK (source IN ('file','github','youtube','instagram','facebook','tiktok')),
  source_uri      text NOT NULL,
  source_title    text NOT NULL,
  content_hash    text NOT NULL,
  chunk_text      text NOT NULL,
  chunk_index     int NOT NULL,
  chunk_total     int NOT NULL,
  embedding       vector(1536) NOT NULL,
  -- Embedding versioning (added v0.3 per peer review).
  -- MVP pins to ('text-embedding-3-small', 1536). Post-MVP migrations
  -- coexist by filtering retrieval queries by embedding_model.
  embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
  embedding_dim   int NOT NULL DEFAULT 1536,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at    timestamptz NOT NULL DEFAULT NOW(),

  -- Idempotency real: una posición de chunk única por documento del usuario.
  -- Coherente con SUPABASE_SCHEMA.md v0.2 §4.7. El v0.3 usaba
  -- UNIQUE (user_id, content_hash) — buggy, colisionaba para chunks
  -- textualmente idénticos cross-document. Fix: la posición es la key.
  UNIQUE (user_id, source_uri, chunk_index)
);

CREATE INDEX memory_item_user_id_idx ON memory_item (user_id);
CREATE INDEX memory_item_source_idx ON memory_item (user_id, source);
-- Composite ANN index per (user, embedding_model) so retrieval over
-- mixed-version corpora stays fast post-migration.
CREATE INDEX memory_item_embedding_idx ON memory_item
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
  WHERE embedding_model = 'text-embedding-3-small';

CREATE TABLE memory_user_stats (
  user_id              text PRIMARY KEY,
  chunks_total         int NOT NULL DEFAULT 0,
  ingests_today        int NOT NULL DEFAULT 0,
  retrievals_today     int NOT NULL DEFAULT 0,
  embed_tokens_month   int NOT NULL DEFAULT 0,
  asr_minutes_month    numeric(10,2) NOT NULL DEFAULT 0,
  last_reset_day       date NOT NULL DEFAULT CURRENT_DATE,
  last_reset_month     date NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)
);

CREATE TABLE memory_async_ingest_job (
  id            uuid PRIMARY KEY,
  user_id       text NOT NULL,
  source        text NOT NULL CHECK (source IN ('tiktok')),
  source_uri    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending','running','succeeded','failed')),
  request       jsonb NOT NULL,
  error_kind    text,
  error_reason  text,
  enqueued_at   timestamptz NOT NULL DEFAULT NOW(),
  started_at    timestamptz,
  completed_at  timestamptz
);

CREATE INDEX memory_async_job_user_status_idx ON memory_async_ingest_job (user_id, status);

-- RLS
ALTER TABLE memory_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_item_self ON memory_item
  USING (user_id = (SELECT auth.uid()::text));

ALTER TABLE memory_user_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_stats_self ON memory_user_stats
  USING (user_id = (SELECT auth.uid()::text));

ALTER TABLE memory_async_ingest_job ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_async_job_self ON memory_async_ingest_job
  USING (user_id = (SELECT auth.uid()::text));
```

`ivfflat` con `lists=100` es bueno hasta ~1M chunks total (todos los usuarios sumados). Más allá, recrear el índice con `lists = sqrt(N_total)`. Cron mensual (§14).

`memory_async_ingest_job` solo tiene `'tiktok'` como source en MVP. Otros conectores son sync. La tabla queda preparada por si más conectores migran a async (ej. video largo de YouTube post-MVP).

---

## §9 · Conectores (los 6) — shapes y peculiaridades

### 9.1 · `file`
Upload directo. MIME types soportados: `application/pdf`, `text/plain`, `text/markdown`, `text/csv`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`. Tamaño max: 50 MB (§INGEST_SECURITY).

`sourceUri` = `"file://" + sha256(bytes)`.

Modo: **sync**.

### 9.2 · `github`
OAuth GitHub user-scope. Repo del usuario (private OK), ref opcional (default branch), paths opcional (default README + docs/**).

Files: `*.md`, `*.txt`, código en `*.{ts,tsx,js,jsx,py,go,rs,java,rb,cpp,c,h}`. Otros tipos skipped.

`sourceUri` = `"github://" + repo + "@" + ref + ":" + path`.

`connectorMeta` = `{ repo, ref, path, language, sha }`.

Chunking override: code respeta function/class boundaries vía tree-sitter cuando posible; markdown respeta headers.

Modo: **sync**.

### 9.3 · `youtube`
Public video URL. Transcript via `youtube-transcript-api` (no OAuth needed for public videos). Si no tiene transcript → falla `extract_failed`.

`sourceUri` = `"youtube://" + videoId`.

`connectorMeta` = `{ videoId, channelId, durationSec, language, hasManualCaptions }`.

Chunking override: split en boundaries de transcript (segments naturales del video, ~5-15s cada uno), grouped hasta llegar a 800 tokens.

Modo: **sync**.

### 9.4 · `instagram`
OAuth Meta unified (Instagram Basic Display API). Soporta posts del propio usuario (no de terceros). Caption + alt-text de la imagen como texto principal.

`sourceUri` = `"instagram://" + postId`.

`connectorMeta` = `{ postId, mediaType, postedAt, caption, alt }`.

OAuth scope: `user_profile`, `user_media`. Restricción: solo posts del usuario autenticado, no del feed general.

Modo: **sync**.

### 9.5 · `facebook`
OAuth Meta unified (Pages API + User Posts). Soporta posts del usuario propio + posts de Pages que administra. Caption / post body como texto principal. Comentarios y reacciones no se ingestan.

`sourceUri` = `"facebook://" + postId`.

`connectorMeta` = `{ postId, pageId?, postedAt, postType }`.

OAuth scope: `pages_read_user_content`, `user_posts`. Mismo OAuth flow que Instagram (Meta unified) — un solo consent screen captura ambos providers.

Imágenes/videos adjuntos no se procesan en MVP (vision = post-MVP).

Modo: **sync**.

### 9.6 · `tiktok`
OAuth TikTok Login Kit + Display API. Soporta videos públicos del usuario propio (no del feed general). El contenido textual es **description + ASR del audio del video** (TikTok no provee transcripts nativos).

`sourceUri` = `"tiktok://" + videoId`.

`connectorMeta` = `{ videoId, durationSec, postedAt, asrModel: 'whisper-1', asrLatencyMs, asrCostUsd }`.

OAuth scope: `user.info.basic`, `video.list` (Login Kit). Restricción TikTok plataforma: solo videos públicos del usuario autenticado, no privados/drafts. **Aplicación a TikTok for Developers requerida** — proceso de review ~2-4 semanas, gate operacional para release de Memoria 1.0.

Pipeline (extiende §4 step 3):

1. Resolver download URL del video via Display API (`video.list` + `video.url`).
2. Descargar el archivo (típicamente <50 MB para video TikTok estándar).
3. POST a OpenAI `/v1/audio/transcriptions` con `model: 'whisper-1'`, `response_format: 'text'`, language hint si está disponible.
4. Concatenar `description + "\n\n[ASR]\n" + transcript` como texto a chunkar.
5. Cleanup del archivo descargado (zeroize buffer + delete temp).

**Costo y latencia**:

- Whisper API: ~$0.006/min de audio ⇒ video TikTok típico de 30s = $0.003.
- Latencia: 5-30s p95 (download + ASR).
- BYOK obligatorio: usa la OpenAI key del usuario. Mismo seam que embeddings.

Modo: **async/queue-based**. La API call de `ingest({ kind: 'tiktok', ... })` devuelve `{ status: 'pending', ingestId }` inmediato. El job corre en background (Modal/Trigger.dev worker), termina en 5-30s, emite `system_audit.memory.ingest` con `asrCostUsd` en `details`. UI poll por `ingestId` o websocket para feedback.

---

## §10 · Observability

Spans:

- `memory.ingest` (CLIENT) — wraps todo el pipeline. Attrs: `user.id_hash`, `memory.source`, `memory.chunks_added`, `memory.chunks_skipped`, `memory.tokens_embedded`, `memory.latency_ms`, `memory.async` (bool).
- `memory.connector.resolve` (sub) — por conector. Attrs: `memory.source`, `memory.connector_latency_ms`.
- `memory.extract` (sub) — text extraction.
- `memory.asr` (sub, solo TikTok) — Whisper call. Attrs: `memory.asr_model`, `memory.asr_audio_sec`, `memory.asr_latency_ms`, `memory.asr_cost_usd`.
- `memory.embed` (sub) — OpenAI embedding call. Attrs: `llm.provider`, `llm.model`, `llm.input_tokens`.
- `memory.upsert` (sub) — DB write.
- `memory.retrieval` (CLIENT) — wraps query. Attrs: `user.id_hash`, `memory.retrieval_k`, `memory.retrieval_total_candidates`, `memory.retrieval_latency_ms`.

Metrics:

```
memory_ingest_total{source}                 Counter
memory_ingest_failures_total{source, kind}  Counter
memory_chunks_added_total{source}           Counter
memory_chunks_skipped_idempotent_total      Counter
memory_embed_tokens_total                   Counter
memory_embed_latency_ms{model}              Histogram
memory_asr_minutes_total                    Counter
memory_asr_cost_usd_total                   Counter
memory_asr_latency_ms                       Histogram
memory_retrieval_total                      Counter
memory_retrieval_latency_ms                 Histogram
memory_retrieval_topk_score{rank}           Histogram (rank=1..k)
memory_quota_exhausted_total{metric}        Counter
memory_user_chunks_total                    Gauge (per-user)
memory_async_jobs_pending                   Gauge
memory_async_jobs_failed_total{reason}      Counter
```

---

## §11 · Audit (§ adyacente a `LLM_CLIENT.md §11`)

Audit actions emitted to `system_audit`:

| action                          | trigger                                       | body                                                       |
|---------------------------------|-----------------------------------------------|------------------------------------------------------------|
| `memory.ingest`                 | success de ingest pipeline (sync o async)     | source, chunksAdded, chunksSkipped, totalTokens, asrCostUsd? |
| `memory.delete_one`             | user borra un MemoryItem                      | source, sourceUri, chunksRemoved                           |
| `memory.delete_source`          | user borra todos los chunks de una source     | source, chunksRemoved                                       |
| `memory.delete_all`             | right-to-forget masivo                        | chunksRemoved                                               |
| `memory.connector_authorized`   | OAuth grant exitoso                           | connector, scopes                                          |
| `memory.connector_revoked`      | OAuth revocation (user o automatic on expiry) | connector                                                  |
| `memory.async_job_failed`       | job async falla post-enqueue                  | source, sourceUri, errorKind, errorReason                  |

Quota-exhausted attempts NO emiten audit (sería ruido — el counter `memory_quota_exhausted_total` ya los visibiliza).

---

## §12 · Schema migrations

Migraciones bajo `apps/web/supabase/migrations/`:

- `0001_memory_item.sql` — tabla + indexes + RLS.
- `0002_memory_user_stats.sql` — tabla counters.
- `0003_memory_async_ingest_job.sql` — tabla queue para TikTok.
- Migración subsecuente cuando crece el dataset: `re-index ivfflat` (manual op tras consultar contador `memory_user_chunks_total` y `lists = sqrt(N_total)`).

---

## §13 · Metrics surface (resumen)

Total ~16 metrics nuevas. Etiquetas controladas (cardinalidad bounded por plan + 6 sources). Dashboards en Grafana paralelos a los del `LLM_CLIENT.md §10`.

Alertas iniciales:

- `memory_ingest_failures_total{kind=connector_unavailable}` rate > 10/min → page (probable infra issue).
- `memory_retrieval_latency_ms p99 > 2000` → ticket (degradación del index).
- `memory_async_jobs_pending` count > 100 → page (worker behind).
- `memory_async_jobs_failed_total{reason=asr_failed}` rate > 5/min → ticket (Whisper API issue o rate limit).
- `memory_user_chunks_total` count(*) where value > 90% del cap del plan → notificación al usuario (UI prompts upgrade).

---

## §14 · Testing & security

### Tests

- **Unit** por conector — tests aislados con HTTP mocks (mismo patrón que `test/providers/` en llm-client).
- **Property-based** sobre chunking — `fc.assert(roundtrip(chunk(text)).join('') === normalize(text))` con overlap.
- **Integration** end-to-end con Supabase locally (testcontainers o supabase CLI):
  - Ingest → retrieve happy path por conector.
  - Idempotency: ingest dos veces, verify `chunksSkipped > 0`.
  - Right-to-forget: delete masivo, verify count(*) = 0.
  - RLS: query con userA's auth.uid() devuelve cero rows de userB.
  - Async job: enqueue TikTok, fake worker corre, verify `system_audit` row.
- **Chaos** — embed timeout, Whisper timeout, Postgres down mid-transaction (rollback), conector 429.

Coverage gates: stmts ≥90, branches ≥85, funcs ≥90, lines ≥90 (mismo gate que llm-client global).

### Security

- **CI key-leak linter** — extender `scripts/check-no-key-in-logs.ts` de llm-client al nuevo paquete (mismo `tsx` script, ejecutado vía `pnpm --filter @chisu/memory-ingest run check-keys`).
- **OAuth tokens nunca persistidos en plano** — los tokens viven en `user_oauth_token` (tabla a definir) cifrados con KEK-per-user via `@chisu/llm-client/crypto`. Memory-ingest los obtiene plaintext solo en stack-local, zeroize post-uso.
- **Audio de TikTok zeroized** — el archivo de video descargado vive en /tmp del worker, se borra inmediatamente post-ASR. El audio raw nunca se persiste; solo el transcript final entra a Postgres.
- **PII scan opcional** — flag `memory.pii_scan_on_ingest` (default OFF en MVP). Si ON, ejecuta `regex + ML classifier liviano` sobre el texto pre-embed; si detecta SSN/CC/etc., warning UI antes de proceder. Post-MVP.

---

## §15 · Extensibilidad post-MVP

**Conectores diferidos (post-MVP)**: link, Drive, MCP, LinkedIn, X. Cada uno = nueva entrada en `ConnectorKind` enum + nuevo `Connector` impl + tests + entrada en §9 + bump minor del contrato (sin requerir peer review si no toca §2 invariantes — patrón establecido en `LLM_CLIENT.md` con Gemini).

Razones de diferimiento explícitas:

- **link**: simple técnicamente (fetch + readability) pero baja prioridad para marca personal — el contenido del usuario vive más en redes sociales que en URLs random. Reactivar fácil.
- **Drive**: alto valor (Google Docs es donde la gente escribe largo), pero requiere OAuth Google + DPA legal. Defer hasta tener compliance bandwidth.
- **MCP**: requiere `MCP_GATEWAY.md` firmado primero. Memoria como source → MCP server expone `memory.search` como tool, no al revés.
- **LinkedIn**: API restrictiva, requiere LinkedIn Marketing Developer Platform application. Defer.
- **X (Twitter)**: API monetizada agresivamente desde 2023. Costo + ROI cuestionable para MVP. Defer hasta evidencia de demanda usuario.

**Migración de embedding model post-MVP** (habilitada por el versioning de v0.3):

- Cuando se introduce un nuevo modelo (ej. `text-embedding-3-large` o un nuevo provider), el sistema soporta **coexistencia** durante la migración.
- Plan: (a) cron job background re-embedea chunks viejos con el nuevo modelo, escribe rows nuevos con el nuevo `embedding_model` SIN borrar los viejos. (b) Retrieval queries filtran por `embedding_model = currentDefault`. (c) Una vez la cobertura del nuevo modelo llega a >99%, deprecation switch flip al nuevo modelo como default. (d) Cron de cleanup borra los chunks con el modelo viejo.
- Sin downtime, sin "big bang" migration. Costo: storage temporal x2 durante la migración.

**Mejoras de retrieval post-MVP**:

- **Hybrid search** (BM25 + vector). Requiere extension `pg_trgm` o `pg_search`. Decisión abierta §16.
- **Reranker** (Cohere rerank-3 o Voyage rerank-2). Llama post-vector-search sobre topK*3, devuelve topK ordenado por reranker. +50-100ms latencia, +5-15% precision en benchmarks. Decisión abierta §16.
- **Query rewriting** (HyDE — Hypothetical Document Embeddings). LLM genera respuesta sintética del query, embed esa respuesta, busca con ese embedding. +1 LLM call, mucho mejor recall en queries cortos. Decisión abierta §16.

**Mejoras de chunking post-MVP**:

- **Semantic chunking** (split en breakpoints de embedding similarity en vez de fixed-size). +1-2% precision, +30% costo de embedding (sample chunks para detectar breakpoints). Probablemente no vale en MVP.
- **Chunk summarization** (cada chunk lleva su summary 50-token + el text full; summary se embed para retrieval, text full se devuelve). Reduce token cost de retrieval. Diferido.

**Mejoras de extract post-MVP**:

- **Vision para imágenes adjuntas** (Instagram, Facebook): GPT-4o-mini sobre la imagen genera descripción textual; entra al chunk. Costo extra + latencia. Defer.
- **Async para conectores grandes**: YouTube videos >2h pueden migrar a async (mismo pattern que TikTok). Trigger: latencia p95 > 8s en producción.

---

## §16 · Decisiones cerradas (firmadas 2026-04-23)

Las 8 decisiones que iter v0.1 dejó abiertas quedan resueltas en v0.2. Cualquier modificación posterior requiere bump menor + nueva firma.

1. **Quota numbers** — ✅ FIRMADO 2026-04-23. Los números de §6 quedan como están: Free 100 chunks / 10 ingests/día / 50 retrievals/día / 100k embed tokens/mes / 10 ASR min/mes; Creator 1k/50/500/1M/60; Influencer 10k/200/unlim/10M/600; Celebrity 50k/unlim/unlim/50M/unlim; Studio todo unlim. Conservador en Free, generoso en Influencer+. Reajustables post-launch si métricas indican fricción.
2. **Hybrid search** — ✅ FIRMADO 2026-04-23. Solo vector en MVP. pgvector + cosine similarity es suficiente para ~1M chunks. BM25 + vector queda diferido a post-MVP (requiere `pg_trgm` + lógica re-ranking).
3. **Reranker** — ✅ FIRMADO 2026-04-23. Sin reranker en MVP. Devolvemos topK directo del vector search. Cohere rerank-3 / Voyage rerank-2 quedan diferidos a post-MVP cuando haya signal de que precision insuficiente.
4. **Query rewriting (HyDE)** — ✅ FIRMADO 2026-04-23. Sin HyDE en MVP. Embeddamos el query directo. HyDE diferido a post-MVP cuando se observe que queries cortos del Asistente fallan retrieval.
5. **Auto-sync conectores** — ✅ FIRMADO 2026-04-23. Manual refresh en MVP. UI muestra botón "refresh" por conector. Auto-sync (webhooks GitHub + polling) queda diferido a post-MVP cuando exista el endpoint público estable (parte de Bloque B wiring apps/web).
6. **Chunking override por conector** — ✅ FIRMADO 2026-04-23. Overrides desde v1.0 para `github` (tree-sitter, function/class boundaries) y `youtube` (transcript segment boundaries). Los otros 4 conectores (`file`, `instagram`, `facebook`, `tiktok`) usan fixed-size 800 tokens / overlap 100. Costo: ~150 LoC extra justificados por mejora significativa de precision en code/video retrieval.
7. **Retención** — ✅ FIRMADO 2026-04-23. Persistencia indefinida hasta que el usuario borre o exceda quota. LRU eviction por `last_seen_at` solo cuando se llega al cap del plan. Sin caducidad por tiempo (ni Free/Creator ni planes superiores). El usuario tiene control total.
8. **TikTok API approval timeline** — ✅ FIRMADO 2026-04-23. Opción A: empezar la aplicación a TikTok for Developers (Login Kit + Display API) en paralelo a la implementación de los otros 5 conectores. TikTok ships cuando tengamos approval (puede ser después de los demás 5; el contrato no bloquea release de Memoria 1.0 sobre los demás conectores).

---

## §17 · Relación con otros documentos

- **`LLM_CLIENT.md v1.1`** — provee el embedding via OpenAI BYOK path. Memoria es un nuevo consumer de `llm-client.embed()` (método a añadir post-firma — actualmente solo soporta `call()`/`ping()`/`invalidateUserKey()`). Bump 0.1.0 → 0.2.0 del paquete llm-client. Adición pequeña (~50 LoC + tests), sin re-firmar `LLM_CLIENT.md`. **Mismo seam también soporta Whisper API para TikTok** (`/v1/audio/transcriptions`) — un solo método `embed()` es insuficiente; necesitamos también `transcribe()` para Whisper. Ambos con la misma BYOK key del usuario.
- **`INGEST_SECURITY.md v1.0`** — defensa perimetral antes del pipeline. Boundary clara: §INGEST_SECURITY no toca embeddings/ASR, este doc no toca quarantine/ClamAV.
- **`UX_FROZEN.md v1.3 §3.4 (Memoria)`** — define la pantalla de Memoria, los conectores visibles, las acciones del usuario (ingest, search, delete). Este doc es el backend que UX consume. **Note**: UX_FROZEN actualmente lista los 11 conectores aprobados; al cambiar a subset social-first 6, UX necesita actualizar la pantalla — los conectores diferidos pasan a "Próximamente".
- **`PRODUCTION_READINESS.md v1.0 §3 (system_audit)`** — el audit log compartido. Las 7 actions de §11 caen en esa tabla.
- **`MCP_GATEWAY.md`** (próximo) — MCP gateway puede exponer `memory.search` como herramienta MCP-callable bajo scope explícito. Requiere coordinación entre los dos docs.

---

## Changelog

- **v0.1 — 2026-04-23**. Borrador inicial firmable. **Cambio de scope vs propuesta inicial**: los 6 conectores MVP son social-first (file + github + youtube + instagram + facebook + tiktok), reemplazando link + drive (diferidos a post-MVP). TikTok añade pipeline async + dependencia de Whisper API.
- **v0.2 — 2026-04-23**. Las 8 decisiones abiertas de §16 firmadas en una sola sesión. Sin cambios estructurales del doc, solo materialización de defaults en decisiones explícitas.
- **v0.4 — 2026-04-23**. Fix de drift con `SUPABASE_SCHEMA.md v0.2` (peer review #1 de schema): idempotency check del pipeline pasa de `content_hash` a `(source_uri, chunk_index)` para evitar colisión cross-document de chunks textualmente idénticos. Cambios en §2 invariante 6, §4 step 5 (chequeo + branch para re-embed cuando contenido cambió en la misma posición), §4 step 7 (`ON CONFLICT` target alineado), §8 storage (`UNIQUE` constraint). El `content_hash` queda como columna informational con índice secundario, NO uniqueness key. Las semantics de idempotency mejoran — re-ingest de un documento editado en la misma posición ahora se detecta y refresca correctamente.
- **v0.3 — 2026-04-23**. Incorpora las 4 correcciones del peer review cruzado:
  1. **§2 invariante 4**: reformulado de "Sin PII fuerte en chunks" → "PII es responsabilidad del caller, no garantía del paquete". Boundary de responsabilidad explícita; el sistema sí persistirá PII indirecta del contenido del usuario.
  2. **§2 invariante 8**: reformulado de "Retrieval determinista" → "Retrieval estable y reproducible (no matemáticamente determinista)". `ivfflat` es ANN (approximate); el wording lo refleja.
  3. **§6.1 (nuevo)**: drift policy explícita para `memory_user_stats`. Update transactional, daily/monthly resets, reconciliación periódica con audit, retries con backoff, atomic cap-check.
  4. **§3.1 + §8 + §5**: embedding versioning. Nuevos campos `embeddingModel` + `embeddingDim` en `MemoryItem` y schema. Retrieval filtra por modelo. §15 documenta plan de migración futura coexistente. Pendiente firma final de Jean.
