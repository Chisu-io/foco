# `SUPABASE_SCHEMA.md` — Schema Postgres de Foco (v0.2 firmable)

**Estado**: borrador firmable v0.2 — 2026-04-23. Incorpora las correcciones del peer review cruzado (UNIQUE constraint en memory_item compatible con chunking, system_audit.sequence wording corregido, vector(1536) future-proof documentado, encryption lifecycle ops como sección nueva). Pendiente firma final de Jean.

**Scope**: contrato técnico **single source of truth** del schema Postgres que sustenta a todo el producto Foco. Consolida las tablas distribuidas en los 6 contratos firmados anteriores (`LLM_CLIENT.md v1.1`, `MEMORY_INGEST.md v0.3`, `MCP_GATEWAY.md v0.2`, `INGEST_SECURITY.md v1.0`, `PRODUCTION_READINESS.md v1.0`, `UX_FROZEN.md v1.4`) en un solo documento ejecutable. Las migrations bajo `apps/web/supabase/migrations/` se derivan de este doc — si el SQL diverge entre la migration y este doc, el doc es la verdad y la migration es bug.

**Decisiones firmadas (2026-04-23)**:

- **Schema namespace** = todo en `public.*` con prefijos descriptivos (`memory_*`, `mcp_*`, `llm_*`, `user_*`, `system_*`). Pattern por defecto Supabase, sin separación cross-domain (audit / billing / mcp como schemas independientes). Reduce fricción operativa.
- **`user_id` integration** = referencia directa a `auth.users.id` (UUID). Cada tabla custom tiene `user_id uuid REFERENCES auth.users(id) ON DELETE CASCADE`. RLS policies usan `auth.uid() = user_id` directo. **Right-to-forget cascadea automáticamente** cuando el auth user se borra — cero lógica custom.
- **Migrations** = Supabase native (`apps/web/supabase/migrations/0001_*.sql` … numbering secuencial). Schema completo gana SemVer; este doc bumps de version cada vez que el schema cambia.
- **Backups** = PITR 7 días (Supabase Pro plan) + snapshots diarios retenidos 30 días. Disaster recovery RTO <1h, RPO <1min.

---

## §1 · Alcance del documento

Este doc define:

1. **Estructura de tablas** — DDL completo en SQL para cada tabla.
2. **RLS policies** — qué query puede hacer qué usuario autenticado.
3. **Indexes + performance** — qué índices existen y por qué.
4. **Cron jobs** — retention, reconciliación, cleanup.
5. **Migration policy** — cómo se modifica el schema sin downtime.
6. **Backups + DR** — cómo recuperamos en disaster.
7. **Roles** — quién puede hacer qué fuera de RLS (admin tooling).

NO define:

- Lógica de negocio (eso vive en los packages `@chisu/*`).
- Cómo se invoca el schema desde TypeScript (eso vive en los repos seam de cada package).
- Datos de seed para development (eso vive en `apps/web/supabase/seed.sql` derivado del schema cuando se necesite).

**Boundary clara con los 6 contratos**:

- `LLM_CLIENT.md v1.1` define **cómo** se usa la BYOK key (envelope encryption, plan-routing, CB). Aquí se define **dónde** vive (`user_llm_key` columns + types).
- `MEMORY_INGEST.md v0.3 §8` ya tenía SQL inline; aquí se consolida verbatim + invariantes adicionales.
- `MCP_GATEWAY.md v0.2 §8` análogamente.
- `PRODUCTION_READINESS.md v1.0 §3` define el hash chain de `system_audit`; aquí se materializa.

---

## §2 · Invariantes (8) — no negociables

1. **`auth.users` es la raíz de identidad**. Toda tabla con datos de usuario tiene `user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE`. El borrado del auth user borra TODOS los datos derivados — right-to-forget en una sola operación SQL.

2. **RLS enforced en todas las tablas con `user_id`**. `ENABLE ROW LEVEL SECURITY` + policy `USING (auth.uid() = user_id)` es obligatorio. Tablas globales (sin `user_id`) NO tienen RLS pero tampoco se exponen vía PostgREST a clients no-admin.

3. **Sin DELETE soft-default**. Cuando una tabla necesita "borrado lógico", se usa `revoked_at timestamptz`/`deleted_at timestamptz`. NO se inventan flags `is_deleted boolean`. La columna timestamp permite filtrar (`WHERE revoked_at IS NULL`) y auditar cuándo.

4. **Timestamps en UTC**. `timestamptz` en TODAS las columnas de tiempo. `DEFAULT NOW()` para inserción. No se usa `timestamp` (sin tz) ni `time`. Milisegundos enteros se almacenan como `bigint` cuando son IDs (UUID v7), no como `int` o `timestamp`.

5. **Migrations son append-only**. Una vez una migration está en main, NO se modifica. Bugs se corrigen con migration siguiente que rolls forward (e.g. `0042_fix_typo_in_0041.sql`). La numeración secuencial es un append log irrevocable.

6. **Sin downtime para deploys**. Nuevas columnas son `NULLABLE` o tienen `DEFAULT`. Drops de columnas son 2-fase: primero stop-using-it (una release), después drop (release siguiente). Renames son add-new + dual-write + remove-old (3 releases mínimo).

7. **`system_audit` es append-only + hash-chained**. Cualquier intento de UPDATE o DELETE sobre `system_audit` falla via trigger BEFORE. Solo INSERT con `prev_hash + row_hash` consistente. Detalles en `PRODUCTION_READINESS.md v1.0 §3`.

8. **Schema bump = doc bump**. Modificar este doc requiere bump SemVer (`v1.0 → v1.1` para adiciones, `v1.0 → v2.0` para breaking changes). No se acepta migration en main que no esté reflejada acá. CI lint check (post-MVP).

---

## §3 · Convenciones

### 3.1 · Naming

- **Tablas**: `snake_case`, plural cuando representa colección (`memory_item` aunque es item; pattern Postgres-idiomatic), singular cuando representa estado de un usuario (`mcp_user_state`).
- **Columnas**: `snake_case`. `id` como PK siempre. FK como `<entity>_id` (`user_id`, `agent_id`).
- **Indexes**: `<table>_<columns>_idx` (`memory_item_user_id_idx`).
- **Constraints**: `<table>_<purpose>_chk` para CHECK; `<table>_<columns>_uniq` para UNIQUE explícito (no via PRIMARY KEY).
- **RLS policies**: `<table>_<purpose>` (`memory_item_self`, `mcp_agent_token_admin_read`).

### 3.2 · Tipos canónicos

| Concepto | Tipo Postgres | Notas |
|---|---|---|
| ID interno | `uuid` (default `uuid_generate_v7()`) | UUID v7 — sortable por timestamp en bytes 0-5 |
| Referencia a usuario | `uuid REFERENCES auth.users(id)` | FK directa |
| Hash sha256 | `text` | 64 chars hex lowercase, NO `bytea` (mejor introspección + debug) |
| Embedding vector | `vector(1536)` | pgvector extension. Pinned a 1536 (text-embedding-3-small) |
| Texto libre | `text` | NEVER `varchar(N)` — Postgres `text` no tiene penalty |
| Booleano | `boolean` | NULL solo si "no sabemos"; default explícito si "sí o no" |
| Cantidad monetaria | `numeric(10, 2)` | USD, 2 decimales |
| Datos opacos JSON | `jsonb` | Indexable, parseable. NEVER `json` (raw, no procesado) |
| Tiempo absoluto | `timestamptz` | UTC |
| Período (date) | `date` | UTC normalized |

### 3.3 · Defaults para `created_at` y `updated_at`

Toda tabla con tracking temporal tiene:

```sql
created_at timestamptz NOT NULL DEFAULT NOW(),
updated_at timestamptz NOT NULL DEFAULT NOW()
```

Más un trigger automático para `updated_at`:

```sql
CREATE OR REPLACE FUNCTION trg_set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;
```

Cada tabla con `updated_at` añade:

```sql
CREATE TRIGGER trg_<table>_updated_at
BEFORE UPDATE ON <table>
FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();
```

### 3.4 · UUID v7 para PKs

Postgres no tiene `uuid_generate_v7()` nativo en 2026 stable; lo añadimos vía función custom (extensión `pg_uuidv7` o función SQL pura). UUID v7 ordenable por tiempo es crítico para:

- Indexes B-tree no fragmentados con inserción append-mostly.
- Pagination "newest first" sin necesidad de columna `created_at` redundante en index.
- Debugging (`SELECT * FROM memory_item WHERE id LIKE '01HG%'` filtra por ventana temporal).

---

## §4 · Tablas — DDL completo

### 4.1 · `auth.users` (Supabase nativo, no se modifica)

Provista por Supabase Auth. **No editamos esta tabla**. Schema de referencia:

```sql
-- Owned by Supabase. Just for reference.
auth.users (
  id          uuid PRIMARY KEY,
  email       text,
  raw_user_meta_data  jsonb,
  created_at  timestamptz,
  ...
);
```

Todo nuestro schema cuelga de `auth.users.id`.

### 4.2 · `user_llm_key` (BYOK encryption envelope)

Vive las API keys del usuario para Anthropic / OpenAI / Gemini bajo envelope encryption KEK-per-shard. Detalles del flujo en `LLM_CLIENT.md v1.1 §5`.

```sql
CREATE TABLE user_llm_key (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('anthropic','openai','gemini')),
  status          text NOT NULL CHECK (status IN ('active','pending','invalid','quota_exhausted','unset'))
                  DEFAULT 'pending',
  -- Envelope shape (LLM_CLIENT.md v1.1 §5):
  kek_version     int NOT NULL,
  shard_id        int NOT NULL,
  dek_ciphertext  bytea NOT NULL,
  key_ciphertext  bytea NOT NULL,
  key_nonce       bytea NOT NULL,
  key_auth_tag    bytea NOT NULL,
  --
  prefer_my_key   boolean NOT NULL DEFAULT false,  -- §4.1 Influencer+ opt-in
  last_validated_at timestamptz,
  invalidated_at  timestamptz,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, provider)  -- one key per (user, provider)
);

CREATE INDEX user_llm_key_user_active_idx ON user_llm_key (user_id)
  WHERE status = 'active' AND invalidated_at IS NULL;

CREATE TRIGGER trg_user_llm_key_updated_at
  BEFORE UPDATE ON user_llm_key
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

-- RLS
ALTER TABLE user_llm_key ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_llm_key_self ON user_llm_key
  USING (auth.uid() = user_id);
```

### 4.3 · `user_quota` (plan + cuotas runtime)

Mirroring de `UX_FROZEN.md v1.4 §3.6` quotas. Source of truth para cuotas runtime.

```sql
CREATE TABLE user_quota (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  plan                 text NOT NULL CHECK (plan IN ('free','creator','influencer','celebrity','studio'))
                       DEFAULT 'free',
  -- Storage caps (MB)
  storage_used_mb      numeric(10, 2) NOT NULL DEFAULT 0,
  storage_cap_mb       int NOT NULL DEFAULT 500,  -- Free default
  -- Daily uploads (resets daily)
  uploads_today        int NOT NULL DEFAULT 0,
  uploads_today_cap    int NOT NULL DEFAULT 10,
  uploads_bytes_today  bigint NOT NULL DEFAULT 0,
  uploads_bytes_cap    bigint NOT NULL DEFAULT 1000000000,  -- 1 GB Free
  -- Monthly videos (renders, resets monthly)
  videos_this_month    int NOT NULL DEFAULT 0,
  videos_month_cap     int NOT NULL DEFAULT 5,  -- Free
  -- Seats
  seats_used           int NOT NULL DEFAULT 1,
  seats_cap            int NOT NULL DEFAULT 1,
  -- Resets
  last_reset_day       date NOT NULL DEFAULT CURRENT_DATE,
  last_reset_month     date NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::date,
  -- Billing state
  upgraded_at          timestamptz,
  current_period_end   timestamptz,
  --
  created_at           timestamptz NOT NULL DEFAULT NOW(),
  updated_at           timestamptz NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_user_quota_updated_at
  BEFORE UPDATE ON user_quota
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

ALTER TABLE user_quota ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_quota_self ON user_quota USING (auth.uid() = user_id);
```

Trigger automático para crear row en `user_quota` cuando un user nuevo registra:

```sql
CREATE OR REPLACE FUNCTION trg_create_user_quota_on_signup() RETURNS trigger AS $$
BEGIN
  INSERT INTO user_quota (user_id) VALUES (NEW.id) ON CONFLICT (user_id) DO NOTHING;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

CREATE TRIGGER trg_auth_users_create_quota
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION trg_create_user_quota_on_signup();
```

### 4.4 · `user_oauth_token` (tokens cifrados de conectores)

Tokens OAuth de los 6 conectores MVP de Memoria (file no aplica; github / youtube / instagram / facebook / tiktok sí). Cifrados con envelope encryption reusando `@chisu/llm-client/crypto`.

```sql
CREATE TABLE user_oauth_token (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  connector       text NOT NULL CHECK (connector IN ('github','youtube','instagram','facebook','tiktok')),
  -- Envelope shape (mismo pattern que user_llm_key)
  kek_version     int NOT NULL,
  shard_id        int NOT NULL,
  dek_ciphertext  bytea NOT NULL,
  token_ciphertext bytea NOT NULL,
  token_nonce     bytea NOT NULL,
  token_auth_tag  bytea NOT NULL,
  -- OAuth metadata (NOT secret)
  scopes_granted  text[] NOT NULL,
  expires_at      timestamptz,  -- NULL = no expira (algunos providers)
  refresh_token_ciphertext bytea,
  refresh_token_nonce bytea,
  refresh_token_auth_tag bytea,
  --
  revoked_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  updated_at      timestamptz NOT NULL DEFAULT NOW(),

  UNIQUE (user_id, connector) WHERE revoked_at IS NULL
);

CREATE INDEX user_oauth_token_active_idx ON user_oauth_token (user_id, connector)
  WHERE revoked_at IS NULL;

CREATE TRIGGER trg_user_oauth_token_updated_at
  BEFORE UPDATE ON user_oauth_token
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

ALTER TABLE user_oauth_token ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_oauth_token_self ON user_oauth_token USING (auth.uid() = user_id);
```

### 4.5 · `llm_token_usage` (accounting per-call)

`LLM_CLIENT.md v1.1 §4.2` matrix billable. Una row por call wire-touching.

```sql
CREATE TABLE llm_token_usage (
  id                  uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id             uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  occurred_at         timestamptz NOT NULL DEFAULT NOW(),
  provider            text NOT NULL CHECK (provider IN ('anthropic','openai','gemini')),
  model               text NOT NULL,
  funding_mode        text NOT NULL CHECK (funding_mode IN ('byok','managed')),
  origin              text NOT NULL,  -- 'assistant-conversation','script-generation',...
  input_tokens        int NOT NULL DEFAULT 0,
  output_tokens       int NOT NULL DEFAULT 0,
  latency_ms          int NOT NULL,
  trace_id            text,
  consent_mode        text NOT NULL CHECK (consent_mode IN ('full','minimal')),
  prompt_hash         text,  -- 64-char hex sha256 — only when consent_mode = 'full'
  kek_version         int  -- only on byok rows
);

CREATE INDEX llm_token_usage_user_time_idx ON llm_token_usage (user_id, occurred_at DESC);
CREATE INDEX llm_token_usage_billing_idx ON llm_token_usage (user_id, occurred_at DESC, funding_mode)
  WHERE funding_mode = 'managed';

ALTER TABLE llm_token_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY llm_token_usage_self ON llm_token_usage USING (auth.uid() = user_id);
```

### 4.6 · `system_audit` (hash-chained append-only)

`PRODUCTION_READINESS.md v1.0 §3` + actions de los 6 docs firmados.

```sql
CREATE TABLE system_audit (
  id                uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  -- sequence: monotonic global (NOT per-tenant). system_audit es una tabla
  -- cross-user de auditoría compartida; el hash chain encadena rows
  -- sin importar el actor. El v0.1 decía "monotonic per-tenant" — corrección
  -- peer review v0.2: el schema no tiene tenant dimension porque el chain
  -- ES global. Tail-locked write garantiza monotonicidad bajo concurrencia
  -- (ver PRODUCTION_READINESS.md v1.0 §3 implementación).
  sequence          bigint NOT NULL,
  occurred_at       timestamptz NOT NULL,
  actor             jsonb NOT NULL,  -- { kind: 'user'|'service'|'system'|'admin', id?, displayName? }
  action            text NOT NULL,   -- 'memory.ingest', 'mcp.scope_denied', 'llm.circuit_opened', ...
  resource          jsonb,            -- { type, id }
  details           jsonb,            -- arbitrary action-specific body
  prev_hash         text NOT NULL,    -- hex sha256 of prev row's row_hash; '0' for sequence 0
  row_hash          text NOT NULL,    -- sha256(prev_hash || canonicalize(row sin row_hash))
  --
  created_at        timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (sequence)
);

CREATE INDEX system_audit_sequence_idx ON system_audit (sequence);
CREATE INDEX system_audit_action_idx ON system_audit (action, occurred_at DESC);
CREATE INDEX system_audit_actor_user_idx ON system_audit ((actor->>'id')) WHERE actor->>'kind' = 'user';

-- Append-only invariant: prevent UPDATE/DELETE
CREATE OR REPLACE FUNCTION trg_system_audit_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'system_audit is append-only — % rejected', TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_system_audit_no_update BEFORE UPDATE ON system_audit
  FOR EACH ROW EXECUTE FUNCTION trg_system_audit_immutable();
CREATE TRIGGER trg_system_audit_no_delete BEFORE DELETE ON system_audit
  FOR EACH ROW EXECUTE FUNCTION trg_system_audit_immutable();

-- system_audit is GLOBAL (cross-user). NO RLS user policy. Admin role only via PostgREST RPC.
ALTER TABLE system_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY system_audit_admin_only ON system_audit
  USING ((auth.jwt()->>'role') = 'admin');
```

Lista de `action` valores — catálogo definitivo de eventos auditables:

```
-- LLM_CLIENT (§11)
llm.circuit_opened, llm.circuit_closed, llm.key_added, llm.key_rotated, llm.key_invalidated, llm.kek_rotated, llm.managed_call_high_spend, llm.abuse_suspected

-- MEMORY_INGEST (§11)
memory.ingest, memory.delete_one, memory.delete_source, memory.delete_all,
memory.connector_authorized, memory.connector_revoked, memory.async_job_failed, memory.stats_drift_corrected

-- MCP_GATEWAY (§11)
mcp.agent_authorized, mcp.agent_revoked, mcp.agent_rotated_old, mcp.agent_rotated_new,
mcp.kill_switch_on, mcp.kill_switch_off, mcp.auth_failed, mcp.scope_denied,
mcp.rate_limit_hit, mcp.kill_switch_blocked, mcp.handle_invalid, mcp.handle_misuse, mcp.secret_redacted

-- INGEST_SECURITY
ingest.quarantine, ingest.av_positive, ingest.parser_timeout, ingest.ssrf_blocked, ingest.svg_converted

-- billing / quota
quota.upgraded, quota.downgraded, quota.exhausted_storage, quota.exhausted_uploads
```

### 4.7 · `memory_item` (chunks vectorizados — `MEMORY_INGEST.md v0.3 §8`)

```sql
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memory_item (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source IN ('file','github','youtube','instagram','facebook','tiktok')),
  source_uri      text NOT NULL,
  source_title    text NOT NULL,
  content_hash    text NOT NULL,  -- sha256(normalize(chunk_text)); informational, NOT a uniqueness key
  chunk_text      text NOT NULL,
  chunk_index     int NOT NULL,
  chunk_total     int NOT NULL,
  embedding       vector(1536) NOT NULL,  -- MVP pinned: text-embedding-3-small (1536 dim).
                                          -- Multi-dim coexistence post-MVP requiere tabla separada
                                          -- por dim (memory_item_3072) o columna `vector` sin dim;
                                          -- ver §12 extensibilidad.
  embedding_model text NOT NULL DEFAULT 'text-embedding-3-small',
  embedding_dim   int NOT NULL DEFAULT 1536,
  metadata        jsonb NOT NULL DEFAULT '{}',
  created_at      timestamptz NOT NULL DEFAULT NOW(),
  last_seen_at    timestamptz NOT NULL DEFAULT NOW(),

  -- Idempotency real: una posición de chunk única por documento del usuario.
  -- El v0.1 tenía UNIQUE (user_id, content_hash) — incompatible con chunking
  -- porque dos documentos distintos pueden tener chunks textualmente idénticos
  -- (ej. mismo `import` line en dos archivos), produciendo content_hash idéntico
  -- y rechazándose al insertar. Fix peer review v0.2: idempotency es por
  -- (user_id, source_uri, chunk_index) — re-ingestar el mismo doc detecta
  -- chunks ya almacenados; chunks idénticos en docs distintos coexisten OK.
  UNIQUE (user_id, source_uri, chunk_index)
);

CREATE INDEX memory_item_user_id_idx ON memory_item (user_id);
CREATE INDEX memory_item_source_idx ON memory_item (user_id, source);
-- Index secundario sobre content_hash para futuras queries de dedup
-- cross-document (e.g. "¿cuántas veces este chunk aparece en mi corpus?").
-- NO es un constraint UNIQUE — chunks duplicados son legítimos.
CREATE INDEX memory_item_content_hash_idx ON memory_item (user_id, content_hash);
CREATE INDEX memory_item_embedding_idx ON memory_item
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
  WHERE embedding_model = 'text-embedding-3-small';

ALTER TABLE memory_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_item_self ON memory_item USING (auth.uid() = user_id);
```

### 4.8 · `memory_user_stats` (counters runtime — `MEMORY_INGEST.md v0.3 §6.1`)

```sql
CREATE TABLE memory_user_stats (
  user_id              uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  chunks_total         int NOT NULL DEFAULT 0,
  ingests_today        int NOT NULL DEFAULT 0,
  retrievals_today     int NOT NULL DEFAULT 0,
  embed_tokens_month   int NOT NULL DEFAULT 0,
  asr_minutes_month    numeric(10, 2) NOT NULL DEFAULT 0,
  last_reset_day       date NOT NULL DEFAULT CURRENT_DATE,
  last_reset_month     date NOT NULL DEFAULT date_trunc('month', CURRENT_DATE)::date,
  updated_at           timestamptz NOT NULL DEFAULT NOW()
);

CREATE TRIGGER trg_memory_user_stats_updated_at
  BEFORE UPDATE ON memory_user_stats
  FOR EACH ROW EXECUTE FUNCTION trg_set_updated_at();

ALTER TABLE memory_user_stats ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_user_stats_self ON memory_user_stats USING (auth.uid() = user_id);
```

### 4.9 · `memory_async_ingest_job` (queue para TikTok)

```sql
CREATE TABLE memory_async_ingest_job (
  id            uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  source        text NOT NULL CHECK (source IN ('tiktok')),
  source_uri    text NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending','running','succeeded','failed'))
                DEFAULT 'pending',
  request       jsonb NOT NULL,
  error_kind    text,
  error_reason  text,
  enqueued_at   timestamptz NOT NULL DEFAULT NOW(),
  started_at    timestamptz,
  completed_at  timestamptz
);

CREATE INDEX memory_async_job_user_status_idx ON memory_async_ingest_job (user_id, status);
CREATE INDEX memory_async_job_pending_idx ON memory_async_ingest_job (enqueued_at)
  WHERE status = 'pending';

ALTER TABLE memory_async_ingest_job ENABLE ROW LEVEL SECURITY;
CREATE POLICY memory_async_ingest_job_self ON memory_async_ingest_job USING (auth.uid() = user_id);
```

### 4.10 · `mcp_agent_token` (auth credentials de agentes MCP — `MCP_GATEWAY.md v0.2 §8`)

```sql
CREATE TABLE mcp_agent_token (
  id                 uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id            uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_label        text NOT NULL,
  token_hash         text NOT NULL UNIQUE,  -- sha256 hex de plaintext token
  authorized_scopes  text[] NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT NOW(),
  last_used_at       timestamptz,
  revoked_at         timestamptz,

  CONSTRAINT mcp_agent_token_scopes_chk CHECK (
    authorized_scopes <@ ARRAY[
      'aprendizajes_del_agente',
      'identidad_de_marca',
      'documentos_subidos',
      'repos_de_github',
      'posts_de_redes_sociales'
    ]::text[]  -- conversaciones_importadas_de_otras_ais NUNCA listed (§2 inv 1)
  )
);

CREATE INDEX mcp_agent_token_user_idx ON mcp_agent_token (user_id) WHERE revoked_at IS NULL;
CREATE INDEX mcp_agent_token_hash_idx ON mcp_agent_token (token_hash) WHERE revoked_at IS NULL;

ALTER TABLE mcp_agent_token ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_agent_token_self ON mcp_agent_token USING (auth.uid() = user_id);
```

### 4.11 · `mcp_read_aggregate` (audit aggregated)

```sql
CREATE TABLE mcp_read_aggregate (
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id       uuid NOT NULL REFERENCES mcp_agent_token(id) ON DELETE CASCADE,
  scope          text NOT NULL,
  day            date NOT NULL,
  read_count     int NOT NULL DEFAULT 0,
  first_read_at  timestamptz NOT NULL,
  last_read_at   timestamptz NOT NULL,
  PRIMARY KEY (user_id, agent_id, scope, day)
);

CREATE INDEX mcp_read_agg_user_day_idx ON mcp_read_aggregate (user_id, day DESC);

ALTER TABLE mcp_read_aggregate ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_read_agg_self ON mcp_read_aggregate USING (auth.uid() = user_id);
```

### 4.12 · `mcp_rate_limit_bucket` (Postgres reconciliación; hot-path en Redis)

```sql
CREATE TABLE mcp_rate_limit_bucket (
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  agent_id       uuid NOT NULL REFERENCES mcp_agent_token(id) ON DELETE CASCADE,
  window_start   timestamptz NOT NULL,
  read_count     int NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, agent_id, window_start)
);

CREATE INDEX mcp_rate_limit_window_idx ON mcp_rate_limit_bucket (user_id, agent_id, window_start DESC);

ALTER TABLE mcp_rate_limit_bucket ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_rate_limit_self ON mcp_rate_limit_bucket USING (auth.uid() = user_id);
```

### 4.13 · `mcp_user_state` (kill switch)

```sql
CREATE TABLE mcp_user_state (
  user_id           uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  server_active     boolean NOT NULL DEFAULT true,
  toggled_at        timestamptz NOT NULL DEFAULT NOW()
);

ALTER TABLE mcp_user_state ENABLE ROW LEVEL SECURITY;
CREATE POLICY mcp_user_state_self ON mcp_user_state USING (auth.uid() = user_id);
```

### 4.14 · `ingest_audit_entry` (defensa perimetral — `INGEST_SECURITY.md v1.0`)

Audit específico de `INGEST_SECURITY` (separate de `system_audit` por volumen y schema diferente).

```sql
CREATE TABLE ingest_audit_entry (
  id              uuid PRIMARY KEY DEFAULT uuid_generate_v7(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  occurred_at     timestamptz NOT NULL DEFAULT NOW(),
  source          text NOT NULL,
  source_uri      text NOT NULL,
  verdict         text NOT NULL CHECK (verdict IN ('clean','quarantined','rejected_av','rejected_mime','rejected_ssrf','timeout')),
  mime_real       text,
  mime_declared   text,
  size_bytes      bigint,
  sha256          text,
  av_engine       text,
  av_signature    text,
  details         jsonb
);

CREATE INDEX ingest_audit_entry_user_time_idx ON ingest_audit_entry (user_id, occurred_at DESC);
CREATE INDEX ingest_audit_entry_verdict_idx ON ingest_audit_entry (verdict, occurred_at DESC)
  WHERE verdict != 'clean';

ALTER TABLE ingest_audit_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingest_audit_entry_self ON ingest_audit_entry USING (auth.uid() = user_id);
```

### 4.15 · `feature_flag_override` (GrowthBook caching local — opcional, post-MVP)

Diferida a post-MVP. Pendiente decisión: cachear flags GrowthBook en Postgres para reducir round-trips, o consumir directo desde GrowthBook SDK en runtime. Default actual: directo desde SDK. Si se necesita cache, esta tabla materializa.

---

## §5 · Resumen RLS (todas las policies)

| Tabla | Policy | RLS predicate |
|---|---|---|
| `user_llm_key` | `user_llm_key_self` | `auth.uid() = user_id` |
| `user_quota` | `user_quota_self` | `auth.uid() = user_id` |
| `user_oauth_token` | `user_oauth_token_self` | `auth.uid() = user_id` |
| `llm_token_usage` | `llm_token_usage_self` | `auth.uid() = user_id` |
| `system_audit` | `system_audit_admin_only` | `(auth.jwt()->>'role') = 'admin'` |
| `memory_item` | `memory_item_self` | `auth.uid() = user_id` |
| `memory_user_stats` | `memory_user_stats_self` | `auth.uid() = user_id` |
| `memory_async_ingest_job` | `memory_async_ingest_job_self` | `auth.uid() = user_id` |
| `mcp_agent_token` | `mcp_agent_token_self` | `auth.uid() = user_id` |
| `mcp_read_aggregate` | `mcp_read_agg_self` | `auth.uid() = user_id` |
| `mcp_rate_limit_bucket` | `mcp_rate_limit_self` | `auth.uid() = user_id` |
| `mcp_user_state` | `mcp_user_state_self` | `auth.uid() = user_id` |
| `ingest_audit_entry` | `ingest_audit_entry_self` | `auth.uid() = user_id` |

**Total**: 13 tablas con RLS, 12 policies user-self + 1 admin-only.

**Service role bypass**: el service role key de Supabase (server-side, NEVER en frontend) bypasea RLS. Los workers backend (Modal jobs, crons, audit reconciliación) usan service role; el frontend siempre usa anon role + JWT del usuario autenticado.

---

## §6 · Indexes y performance

### 6.1 · Critical path indexes (queries de hot-path)

| Tabla | Query | Index |
|---|---|---|
| `memory_item` | retrieval semántico | `memory_item_embedding_idx` (ivfflat lists=100) |
| `memory_item` | filter por source | `memory_item_source_idx (user_id, source)` |
| `mcp_agent_token` | auth lookup | `mcp_agent_token_hash_idx (token_hash) WHERE revoked_at IS NULL` |
| `mcp_rate_limit_bucket` | rate check | `mcp_rate_limit_window_idx (user_id, agent_id, window_start DESC)` |
| `llm_token_usage` | billing query | `llm_token_usage_billing_idx (user_id, occurred_at DESC, funding_mode) WHERE managed` |
| `memory_async_ingest_job` | worker pickup | `memory_async_job_pending_idx (enqueued_at) WHERE status = 'pending'` |
| `system_audit` | event lookup by action | `system_audit_action_idx (action, occurred_at DESC)` |

### 6.2 · ivfflat re-index policy

`memory_item_embedding_idx` se recrea cuando `count(memory_item) > 2 * lists * (lists)` aproximadamente. En MVP con `lists=100`, eso es ~20k chunks. Cron mensual chequea y rebuild si necesario; alerta si rebuild excede 5min.

### 6.3 · Connection pooling

PgBouncer en transaction mode (default Supabase). Compatible con todo nuestro stack excepto:

- `LISTEN/NOTIFY`: no soportado en transaction mode. **No usamos** en MVP.
- Prepared statements: limitado en transaction mode. **No usamos prepared statements server-managed**; cada query es ad-hoc parameterizado.

---

## §7 · Migration policy

### 7.1 · Numbering + naming

`apps/web/supabase/migrations/<NNNN>_<description>.sql` donde:

- `NNNN` es decimal 4-dígitos zero-padded (`0001`, `0042`, `0123`).
- `description` es kebab-case + descriptive (`add_memory_item_embedding_model`).
- Una migration es atómica — un cambio lógico = un archivo. Si necesitas múltiples cambios coordinados, son múltiples archivos consecutivos.

### 7.2 · Schema bumps + SemVer

Este doc tiene SemVer:

- **MAJOR** (`v1.0 → v2.0`): breaking changes — drop columna no-`NULL`, drop tabla, change tipo de columna no-compatible, RLS policy más restrictiva.
- **MINOR** (`v1.0 → v1.1`): aditivo — nueva tabla, nueva columna nullable o con default, nuevo índice, nuevo trigger.
- **PATCH** (`v1.0 → v1.0.1`): no-functional — comments, docstrings, rephrase invariantes sin cambio semántico.

Cada bump añade entrada al changelog del doc. La migration que materializa el bump cita el doc en el SQL comment.

### 7.3 · Sin downtime — patrones obligatorios

| Cambio | Pattern |
|---|---|
| Add nullable column | Single migration. |
| Add NOT NULL column | Pasos: (a) add nullable, (b) backfill con data, (c) `ALTER ... SET NOT NULL`. Tres migrations consecutivas; (b) puede ser background. |
| Drop column | Pasos: (a) stop using en código (release), (b) drop en migration (release siguiente). Dos releases mínimo. |
| Rename column | Pasos: (a) add new column nullable, (b) dual-write código (release), (c) backfill, (d) switch reads to new (release), (e) drop old. Tres a cinco releases. |
| Change type compatible (e.g. `int` → `bigint`) | `ALTER COLUMN TYPE ... USING expr`. Single migration; cuidado con queries en vuelo (lock breve). |
| Change type incompatible (e.g. `text` → `int`) | NO permitted en migration directa. Crear nueva columna, migrate, drop vieja. |

### 7.4 · CI gates

- Migration debe correr clean en Supabase local (CI test).
- Migration debe ser reversible o documentar irreversibilidad (e.g. drop column es irreversible — el rollback exige PITR).
- Migration **no** puede modificar `system_audit` (append-only).
- Lint: este doc se check contra el SQL real (post-MVP) para evitar drift.

---

## §8 · Backups + DR

### 8.1 · Política firmada

- **PITR**: 7 días, granularidad segundo. Plan Supabase Pro.
- **Snapshots diarios**: retenidos 30 días como cold backup.
- **RTO**: <1 hora (Supabase claim).
- **RPO**: <1 minuto (PITR).

### 8.2 · Restore procedure

Documentado en runbook separado `apps/web/supabase/RESTORE_RUNBOOK.md` (a crear). Pasos abreviados:

1. Identificar el timestamp objetivo del restore (e.g. "antes del bug deployed at 14:32 UTC").
2. Supabase dashboard → Database → Backups → Point-in-Time Restore.
3. Confirmar restore. Supabase crea nueva DB derivada.
4. Validar (smoke tests SQL).
5. Promote la nueva DB como primary; actualizar `DATABASE_URL` en Doppler.
6. Audit entry `db.pitr_restore_executed` en `system_audit` con `restored_to_timestamp` + `executed_by`.

### 8.3 · Disaster scenarios cubiertos

- **Corrupción aplicacional** (bug que escribe data inválida): PITR a antes del deploy.
- **Drop accidental de tabla**: PITR + restore selectivo (export tabla del backup, import en producción actual).
- **Borrado masivo accidental**: PITR igual.
- **Region outage Supabase**: cobertura del SLA Supabase. Sin failover cross-region en MVP — RTO depende del Supabase incident response.

---

## §9 · Cron jobs (retention + reconciliación)

| Cron | Frequency | Purpose |
|---|---|---|
| `memory.cron.reset_daily` | diaria 00:00 UTC | resetea `memory_user_stats.ingests_today` + `retrievals_today` si `last_reset_day < CURRENT_DATE` |
| `memory.cron.reset_monthly` | día 1 mes 00:00 UTC | resetea `memory_user_stats.embed_tokens_month` + `asr_minutes_month` |
| `memory.cron.reconcile_stats` | diaria 02:00 UTC | reconcilia `memory_user_stats.chunks_total` con `count(memory_item)` |
| `memory.cron.reindex_ivfflat` | mensual primer día | rebuild `memory_item_embedding_idx` si `lists < sqrt(N_total)/2` |
| `mcp.cron.cleanup_rate_limits` | horaria | borra `mcp_rate_limit_bucket` con `window_start < NOW() - interval '2 hours'` |
| `mcp.cron.cleanup_aggregates` | diaria | borra `mcp_read_aggregate` con `day < CURRENT_DATE - interval '90 days'` |
| `mcp.cron.reconcile_rate_limits` | horaria | copia buckets de Redis a Postgres `mcp_rate_limit_bucket` para audit/compliance |
| `quota.cron.reset_daily` | diaria | resetea `user_quota.uploads_today` + `uploads_bytes_today` |
| `quota.cron.reset_monthly` | día 1 mes | resetea `user_quota.videos_this_month` |

Implementación: Supabase pg_cron extension (gratis, in-database). Failure mode: si un cron falla, alerta `cron_failed_total{name}` métrica + retry next tick.

---

## §10 · Roles y permisos

### 10.1 · Roles canónicos

| Role | Use case | Acceso |
|---|---|---|
| `anon` | Frontend antes de login | Solo lectura de tablas públicas (ninguna en MVP — requerimos auth siempre) |
| `authenticated` | Frontend post-login | RLS gate, ve solo sus propias rows |
| `service_role` | Backend workers + crons | Bypass RLS — usado en jobs que cruzan usuarios (reconciliación, cleanup) |
| `admin` | Tooling interno + investigaciones | Acceso a `system_audit`, can run support queries cross-user. JWT con `role: 'admin'` claim, emitido manualmente por Jean. NO accesible vía signup |

### 10.2 · Service role guidelines

- NUNCA en frontend bundle. Solo en server-side: API routes Next.js, Modal workers, Supabase Edge Functions privadas.
- Almacenado en Doppler (`SUPABASE_SERVICE_ROLE_KEY`).
- Las queries con service role DEBEN setear `user_id` explícitamente cuando aplican a un usuario — RLS no protege.

---

## §11 · Testing & validation

### 11.1 · Migration tests

- Cada migration corre en Supabase local con `supabase db push --local`. CI gate.
- Property-based: aplicar todas las migrations en orden N veces (sequential), reset y reaplicar — output schema idempotente.
- Schema diff entre `apps/web/supabase/migrations/` materializadas y este doc — drift = fail.

### 11.2 · RLS tests

Cada policy debe tener un test de pares (positive + negative):

```sql
-- positive: user A reads own data → returns row
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claims" = '{"sub":"<user_a_id>"}';
SELECT * FROM memory_item WHERE user_id = '<user_a_id>';  -- expects row(s)

-- negative: user A reads B's data → returns nothing
SET LOCAL "request.jwt.claims" = '{"sub":"<user_a_id>"}';
SELECT * FROM memory_item WHERE user_id = '<user_b_id>';  -- expects 0 rows
```

Suite ejecutada en CI por cada PR que modifica RLS.

### 11.3 · Cron tests

Cada cron job tiene un test que:
1. Setup: insertar data que el cron debería procesar.
2. Run: ejecutar el cron sync (`SELECT cron.schedule_at_now('<job>')` o similar).
3. Assert: data fue procesada correctamente.

---

## §12 · Extensibilidad post-MVP

**Nuevas tablas anticipadas**:

- `feature_flag_override` — cache local de GrowthBook (decisión abierta §13).
- `team_membership` — Studio plan + multi-seat (`UX_FROZEN.md §3.6` Studio tier).
- `usage_billing_period` — cierre de billing periods con resumen agregado para invoicing.
- `chunk_redaction_event` — audit de secret redactions cuando entre §15 de `MCP_GATEWAY.md`.

**Cambios anticipados**:

- `memory_item` post-MVP: añadir columnas `is_learnable boolean`, `is_brand_defining boolean` para soportar scopes `aprendizajes_del_agente` + `identidad_de_marca` del MCP gateway.
- `user_oauth_token` post-MVP: extender enum de `connector` cuando entren los 5 diferidos (link/drive/MCP-cliente/LinkedIn/X).

**Multi-dimension embedding coexistence** (post-MVP, peer review v0.2):

`memory_item.embedding` está pinned a `vector(1536)` en MVP. Cuando entren modelos de dimensión distinta (`text-embedding-3-large` 3072 dim, embeddings locales de 768 dim, etc.), tres opciones de migración:

1. **Tabla separada por dimensión** (recomendado): `memory_item_1536` (renombrada actual), `memory_item_3072` (nueva). Cada una con su propio ivfflat index dimensional. Retrieval queries select FROM la tabla cuya dim corresponde al modelo del query. Trade-off: schema fork, pero tipos exactos y indexes optimales.

2. **Columna `vector` sin dim** (`vector` no-tipado): pgvector soporta dim variable. Pierde algunas optimizations de index (no se puede crear `ivfflat` específico). Útil si las dims son heterogéneas pero no muchas.

3. **Generic `bytea` + cast aplicacional**: descartado — pierde toda la expresividad de pgvector.

Decisión preferida: opción 1 con bump major del schema (v2.0) que renombra y añade tabla nueva. Migración gradual coexistente como ya documentado en `MEMORY_INGEST.md v0.3 §15`.


**Sharding `memory_item` por user_id** (cuando >1M chunks):

- pgvector `lists` se incrementa siguiendo `sqrt(N_total)`.
- `memory_item` puede particionarse por `user_id` hash si hot users dominan IO. Postgres declarative partitioning + RLS funciona pero requiere care.

---

## §13 · Decisiones cerradas (firmadas 2026-04-23)

1. **Schema namespace** — ✅ FIRMADO. Todo en `public.*` con prefijos descriptivos. Sin schemas separados.
2. **`user_id` integration** — ✅ FIRMADO. UUID FK directo a `auth.users(id)` con `ON DELETE CASCADE`. RLS usa `auth.uid() = user_id` directo.
3. **Migrations** — ✅ FIRMADO. Supabase native + numbering secuencial 4-dígitos + schema SemVer. Nada de Drizzle/Prisma.
4. **Backups** — ✅ FIRMADO. PITR 7 días + snapshots diarios 30 días (Supabase Pro plan).

---

## §14 · Decisiones abiertas (firmable)

4 decisiones con defaults en código pero pendientes de resolución antes de release de `v1.0` definitivo:

1. **Feature flag caching local**: ¿activar tabla `feature_flag_override` para cachear flags GrowthBook? Default: NO en MVP (consumir directo del SDK; la latencia GrowthBook es <50ms p99).
2. **Hash chain implementation de `system_audit`**: el hash chain está documentado en `PRODUCTION_READINESS.md v1.0 §3` pero la función SQL (`compute_row_hash()`) no está aquí. Decisión abierta: ¿implementación trigger-based en Postgres (atómica, lock por sequence) o app-level (Modal worker)? Default: trigger-based.
3. **Particionamiento de `system_audit`**: a 100M+ rows, particionado por `occurred_at` mensual. Default: NO en MVP (single-table, reindex cuando sea necesario).
4. **Separar policy de DDL en docs distintos** (peer review v0.2): cuando este doc supere ~1500 líneas, partirlo en (a) `SUPABASE_SCHEMA.md` puro DDL + RLS, (b) `SCHEMA_POLICIES.md` invariantes + convenciones, (c) `OPERATIONS.md` cron + backups + DR + roles, (d) `MIGRATION_GUIDE.md` patterns sin downtime. Default: monolítico hasta v1.5; si crece más, partir. Decisión cosmética, no afecta ejecución.

---

## §15 · Relación con otros documentos

- **`LLM_CLIENT.md v1.1`** — define la lógica de envelope encryption + key resolution. Aquí materializa el storage (`user_llm_key`).
- **`MEMORY_INGEST.md v0.3 §8`** — definía SQL inline; aquí se consolida verbatim + reorganiza con resto del schema.
- **`MCP_GATEWAY.md v0.2 §8`** — análogo. La nota de Redis hot-path se mantiene en MCP_GATEWAY; aquí solo Postgres reconciliation.
- **`INGEST_SECURITY.md v1.0`** — define las reglas de defensa perimetral. Aquí aparece `ingest_audit_entry` como tabla específica de ese audit.
- **`PRODUCTION_READINESS.md v1.0 §3`** — define el contrato `system_audit` (hash chain + actor + sequence). Aquí materializa.
- **`UX_FROZEN.md v1.4 §3.6`** — define los 5 planes + cuotas. Aquí materializa en `user_quota`.

Cualquier modificación de este doc que afecte a las tablas referenciadas en los 6 docs anteriores requiere **bump cruzado** del doc receptor — no se permite drift.

---

## §16 · Encryption operations lifecycle (peer review v0.2)

El schema acomoda envelope encryption (KEK + DEK) en 3 tablas: `user_llm_key`, `user_oauth_token`, y futuras tablas de credentials. La **estructura** está bien diseñada (KEK versioning, shard IDs, ciphertext + nonce + auth_tag separados, DEK efímero per-row). La **operación lifecycle** queda parcialmente especificada acá; el detalle completo vive en `LLM_CLIENT.md v1.1 §5` para llm-client y se delega a un runbook separado (`apps/web/docs/ENCRYPTION_RUNBOOK.md`, post-MVP) para operations cross-package.

### 16.1 · Cadence de rotación KEK

- **MVP**: rotación KEK manual por Jean, default cadence anual (cada 12 meses) o ad-hoc por incidente. NO hay cron automático en MVP.
- **Trigger ad-hoc**: sospecha de compromise (ej. AWS KMS console muestra acceso anómalo), audit finding, periodic security review. Jean ejecuta vía runbook.
- **Procedure resumido** (full en `ENCRYPTION_RUNBOOK.md`):
  1. Generar KEK nueva en KMS — incrementa `currentKekVersion()` retornado por `LLMClient`.
  2. Background job re-wraps todas las DEK existentes bajo nueva KEK (`memory.cron.rewrap_keks`, scheduled manualmente).
  3. Tras 100% re-wrap → flag KEK vieja como `deprecated`.
  4. Tras 30 días → KEK vieja retirable (KMS scheduled deletion).
  5. Audit entry `llm.kek_rotated` con `from_version`, `to_version`, `keys_rewrapped`.
- **Post-MVP**: rotación automática anual via `pg_cron` que kick off el job. Decisión abierta §14.

### 16.2 · Re-encrypt failures (partial / replay)

- El job de re-wrap es **idempotente por row**: cada DEK tiene `kek_version` actual stamped; el job solo procesa rows con `kek_version < target`. Si el job falla a mitad, replay procesa solo los pendientes.
- Si una row falla específicamente (ej. AWS KMS rate limit, DEK corrupto): emite métrica `llm_kek_rewrap_failures_total{reason}`, audit entry `llm.kek_rewrap_failed`, mantiene la row en KEK vieja. Operador resuelve manualmente vía runbook.
- **Blast radius por failure**: una row con KEK vieja sigue funcionando hasta que la KEK vieja sea retirada. La ventana de 30 días entre `deprecated` y `retired` cubre casos de re-wrap pendiente.

### 16.3 · Compromise blast radius

- **DEK compromise** (single user_oauth_token / user_llm_key row leaked): impacto = solo ese row. Mitigation: rotar la API key/OAuth token afectado en el provider externo (Anthropic dashboard, GitHub settings, etc.); el DEK que cifra el plaintext ya rotado pierde valor. NO requiere KEK rotation.
- **KEK compromise** (rare, AWS KMS account-level): impacto = todas las DEKs cifradas con esa KEK. Mitigation: re-wrap immediato de todas las rows + rotación de TODAS las API keys/OAuth tokens del usuario afectado (en peor caso, todos los usuarios en ese shard). Audit `llm.kek_emergency_rotated`.
- **Shard compromise** (KEK específica de un shard, no global): impacto = subset de usuarios cuyo `shard_id = compromised_shard`. Sharding limita el blast radius — esa es la razón principal de KEK-per-shard vs KEK-global.

### 16.4 · Recovery / DR for encrypted data

- PITR restore (§8) restaura **ciphertext** + **kek_version** en cada row. Para descifrar, necesitas que la KEK correspondiente exista todavía en KMS.
- Si la KEK fue retirada después del PITR target time → datos cifrados con esa KEK son **irrecuperables** (by design — pérdida de la KEK = pérdida de los datos cifrados). Esa es la garantía criptográfica.
- **Mitigación**: no retirar KEKs antes de 30 días post-deprecation, así el window de PITR (7 días) está totalmente cubierto.

### 16.5 · Audit obligatorio

Toda operación de encryption lifecycle emite audit en `system_audit`:

| action | trigger |
|---|---|
| `llm.kek_rotated` | rotación KEK exitosa completa |
| `llm.kek_rewrap_started` | job de re-wrap arranca |
| `llm.kek_rewrap_completed` | job de re-wrap termina (con counts) |
| `llm.kek_rewrap_failed` | row específica falla durante re-wrap |
| `llm.kek_emergency_rotated` | rotación por compromise |
| `llm.kek_retired` | KEK vieja retirada de KMS |

Esto permite reconstruir el historial completo de encryption operations en compliance audit.

---

## Changelog

- **v0.1 — 2026-04-23**. Borrador inicial firmable. 4 decisiones críticas firmadas (namespace public, user_id FK directo, Supabase native migrations, PITR 7d/30d snapshots). 13 tablas consolidadas. 3 decisiones abiertas en §14.
- **v0.2 — 2026-04-23**. Incorpora 4 correcciones del peer review cruzado:
  1. **`memory_item` UNIQUE constraint** (peer review #1): `UNIQUE (user_id, content_hash)` → `UNIQUE (user_id, source_uri, chunk_index)`. El constraint anterior era buggy con chunking — dos documentos con chunks textualmente idénticos colisionaban al insertar. Fix: idempotency por `(user_id, source_uri, chunk_index)` permite re-ingest del mismo doc detectar chunks ya almacenados; chunks idénticos en docs distintos coexisten OK. Index secundario `memory_item_content_hash_idx` añadido para queries de dedup cross-document futuras.
  2. **`vector(1536)` future-proof documentado** (peer review #2): la columna sigue pinned a 1536 en MVP, pero §12 ahora documenta el plan de migración multi-dim (tablas separadas por dimensión) cuando entren modelos con dims distintas. Decisión documentada antes de necesitarse.
  3. **`system_audit.sequence` wording** (peer review #3): la doc decía "monotonic per-tenant" pero el schema es global. Wording corregido: monotonic GLOBAL (cross-user). Fix de drift entre prosa y SQL real.
  4. **§16 Encryption operations lifecycle** (peer review #5): nueva sección con 5 sub-secciones — cadence de rotación KEK (manual MVP, anual default), re-encrypt failures (idempotente per-row, métrica + audit), compromise blast radius (DEK vs KEK vs shard), recovery/DR para encrypted data (PITR + KEK retention 30d post-deprecation), audit obligatorio (6 actions nuevas en `system_audit`). Lifecycle ops detallado completo en runbook separado post-MVP.
  - **§14 decisiones abiertas**: añadida #4 sobre separar este doc en monolítico vs (DDL/policies/operations/migration-guide) cuando supere 1500 líneas. Default: monolítico hasta v1.5.

  Pendiente firma final de Jean.
