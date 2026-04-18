---
title: Foco · UX Frozen v1.3
status: FROZEN v1.3 (§6 step 1 renombra `packages/render-schema/` → `packages/schemas/` para reflejar el alcance real del paquete — alberga los 6 contratos ancla, no solo render)
date: 2026-04-18
owner: Jean Pierre Rojas
reviewer: Jean + AI peer review externo
mockup: ./ui-mockup.html
depends_on:
  - ./INGEST_SECURITY.md (spec de seguridad y cuotas — prerequisito técnico)
changelog:
  - v1.3 (2026-04-18): Rename `packages/render-schema/` → `packages/schemas/` en §6 step 1. Justificación: el paquete alberga los 6 contratos ancla (RenderRequest, MemoryItem, UserQuota, IngestAuditEntry, SystemAuditEntry, McpAuthorization), no solo render. Cambio no funcional — solo nombre de carpeta y campo `name` del package.json (`@chisu/schemas`). Aprobado por Jean 2026-04-18.
  - v1.2 (2026-04-17): Se añade §3.5 Seguridad de ingesta y §3.6 Cuotas por plan como invariantes del sistema. MemoryItem extendido con campos de seguridad (§5.2). Nuevos tipos UserQuota e IngestAuditEntry (§5.4). Prerequisito técnico anterior al render-schema (§6.0).
  - v1.1 (2026-04-17): MCP se separa a pantalla propia (§2 #14), "Help" se reclasifica en grupo Ajustes, se añade principio #6 de agrupación funcional.
  - v1.0 (2026-04-17): Congelación inicial con 13 pantallas.
---

# Foco — UX congelado (MVP v1.0)

Este documento es la **única fuente de verdad de UX** para el MVP de Foco. A partir de esta fecha:
- Ningún cambio visual o de flujo se implementa sin reabrir este doc y aprobar explícitamente.
- El equipo técnico (schemas, workers, SDK, packages) trabaja **contra este contrato**.
- El mockup navegable (`ui-mockup.html`) es el artefacto de referencia. Toda discrepancia entre código y mockup es bug hasta decidir otra cosa.

## 1 · Principios de diseño (no negociables)

1. **Accesible para 8 a 80 años.** Tipografía base 17 px, touch targets ≥ 48 px, WCAG AAA. Dark mode primario.
2. **Un agente, no un editor.** Flujo conversacional: el usuario dice qué quiere, Foco entrega. El editor es para retocar, no para construir desde cero.
3. **Memoria como ventaja competitiva.** Todo lo que el usuario aporta alimenta al agente. El usuario ve qué sabe Foco y puede editarlo.
4. **Transparencia radical sobre datos.** El usuario siempre sabe qué se comparte, con quién, y puede revocar.
5. **Híbrido face-cam + avatar.** El diferenciador visual. El avatar es opcional; la cámara frontal es el default.
6. **Agrupación funcional estricta.** Toda área de configuración, customización, integraciones, claves, facturación, ayuda y soporte vive bajo el grupo **Ajustes**. La Memoria expone solo contenido (qué sabe el agente); los controles del sistema no se mezclan con ella. Regla aprobada por Jean 2026-04-17: *"cualquier area de configuración/customización/asistencia, etc, del sistema debe quedar junta"*.

## 2 · Inventario de pantallas (14)

Las pantallas se distribuyen en cuatro grupos funcionales: **Onboarding** (3), **App** (4 — flujos de creación, contenido y contexto), **Flujo crear** (5) y **Ajustes** (5 — todo lo relacionado con configuración, customización, integraciones y asistencia, según §1.6).

| # | ID | Grupo | Propósito |
|---|---|---|---|
| 1 | `onboarding` | Onboarding | Bienvenida, objetivo, nombre |
| 1b | `onboarding-2` | Onboarding | Subir fotos para entrenar avatar |
| 1c | `onboarding-3` | Onboarding | Conectar primera red (opcional) |
| 2 | `dashboard` | App | Inicio: próximo post, métricas, racha |
| 3 | `create-1` | Flujo crear | Paso 1 — idea o gancho |
| 4 | `create-2` | Flujo crear | Paso 2 — guion generado + voz |
| 5 | `create-3` | Flujo crear | Paso 3 — elegir avatar/estilo |
| 6 | `editor` | Flujo crear | Editor con preview dual + 4 tracks |
| 7 | `publish` | Flujo crear | Publicar/agendar en redes |
| 8 | `library` | App | Biblioteca de videos generados |
| 13 | `memory` | App | **Memoria del agente** — solo contenido del contexto (ver §3). La configuración del MCP sale a la pantalla 14. |
| 9 | `settings-brand` | Ajustes | Marca, colores, tipografía, voz |
| 10 | `settings-integrations` | Ajustes | API keys, BYOK, redes conectadas |
| 14 | `settings-mcp` | Ajustes | **MCP Gateway** — bi-direccional, scopes, audit log, kill switch (ver §3.2) |
| 11 | `settings-billing` | Ajustes | Plan y cobro |
| 12 | `help` | Ajustes | Ayuda, tutoriales, soporte (reclasificado desde "App" a "Ajustes" en v1.1) |

## 3 · Memoria — contrato funcional

### 3.1 Fuentes MVP (11, cerradas)

| # | Fuente | Mecanismo | Notas |
|---|---|---|---|
| 1 | Archivo | Drop zone upload | PDF, DOCX, MD, TXT, XLSX, CSV, MP3, WAV, MP4, MOV, PNG, JPG, SVG · máx 500 MB/file |
| 2 | Link suelto | Paste URL → fetch + extract | Artículo, PDF web, página pública |
| 3 | Google Drive | OAuth + sync continuo | Docs, Sheets, Slides, PDFs |
| 4 | GitHub | OAuth + webhook | Repos, README, issues, commits |
| 5 | **MCP gateway** | Bi-direccional (ver §3.2) | Claude Desktop, ChatGPT, Cursor, Gemini, Raycast, custom |
| 6 | YouTube | OAuth + API | Videos propios, captions, canal |
| 7 | TikTok | OAuth + API | Videos, métricas |
| 8 | Facebook | OAuth + Graph API | Páginas, posts |
| 9 | LinkedIn | OAuth | Posts, perfil |
| 10 | Instagram | OAuth + Graph API | Reels, feed, bio |
| 11 | X.com | OAuth | Threads, replies |

**Nota libre:** vive como acción secundaria del drop zone ("Escribir una nota"). No es un conector aparte.

**Fuera del MVP (próximamente con voting):** Notion, Dropbox, OneDrive, Figma, Slack, Discord, Gmail, Calendar, Threads, Spotify Podcasts, crawl sitio completo, RSS/blog, WhatsApp, Linear, Airtable.

### 3.2 MCP Gateway — bi-direccional con control granular

> **Ubicación en UI:** la **configuración** completa del gateway vive en la pantalla dedicada `settings-mcp` (§2 #14), dentro del grupo **Ajustes**. La Memoria (`memory`, §2 #13) sólo muestra un **widget-resumen compacto** con estado del gateway y CTA "Configurar → settings-mcp". Esta separación aplica la regla §1.6: configuración del sistema no se mezcla con contenido de contexto.

**Cliente MCP (Foco lee):**
- Foco se conecta a servidores MCP del usuario (Claude Desktop local, Cursor workspace, ChatGPT export JSON, Gemini, Raycast, custom).
- Extrae conversaciones, notas, contexto compartido por el protocolo.
- El usuario ve exactamente qué clientes están conectados y qué han aportado a la memoria.

**Servidor MCP (Foco expone):**
- Foco expone la memoria del usuario como servidor MCP para que otros agentes externos la consulten.
- Control granular por tipo de contenido (switches independientes):
  - Aprendizajes del agente → **ON por defecto**
  - Identidad de marca → **ON por defecto**
  - Documentos subidos → **OFF por defecto** (puede contener info sensible)
  - Repos de GitHub → **OFF por defecto** (puede contener secretos)
  - Posts de redes sociales → **ON por defecto** (todo es público)
  - Conversaciones importadas de otras AIs → **bloqueado, siempre OFF** (evita filtrado transitivo)
- Autorización explícita por agente externo (pide clave API + scope).
- Audit log de todas las lecturas/escrituras, con timestamp, agente, recurso, resultado (permitido / bloqueado).
- Botón de rotación de API key y desactivación total del servidor en cualquier momento.

**Elementos mínimos que debe tener `settings-mcp` (contrato UX):**
1. Tarjeta "Conexiones activas" con dos columnas (Foco lee ↓ / Otras AIs leen ↑), listado de agentes, botones "Autorizar nuevo agente" y "Conectar nueva AI".
2. Tarjeta "¿Qué comparte Foco como servidor MCP?" con los 6 scopes y el scope "Conversaciones importadas" bloqueado (icono candado, switch deshabilitado visible pero no actuable).
3. Tarjeta "Audit log" con últimos 7 días visibles y botón "Exportar log".
4. Tarjeta "Zona delicada" con "Rotar API key" y "Desactivar MCP servidor" (kill switch).

**Widget en Memoria (SCREEN 13):** debe mostrar *solo* (a) badge bi-direccional, (b) contador de agentes que leen y exponen, (c) micro-indicadores de audit log al día, (d) CTA "Configurar gateway" que navega a `settings-mcp`. No duplicar scopes, audit log ni acciones destructivas aquí. El botón "Vaciar memoria" sí permanece en Zona delicada de Memoria (es una acción del contenido, no del MCP).

**Why esta arquitectura (registro de decisión):** el MCP bi-direccional convierte a Foco en el **hub de contexto del creador**. Sin él, Foco es una isla; con él, Foco es el cerebro que alimenta a todos los agentes del usuario. La contrapartida de riesgo (filtrar info sensible) se mitiga con scope granular + defaults conservadores + audit + kill switch, aprobados por Jean 2026-04-17. La separación a pantalla propia (v1.1) refuerza la regla §1.6 y evita sobrecargar la Memoria con controles de sistema.

### 3.3 Privacidad — switches globales de la Memoria

- Compartir memoria con mi equipo → OFF (plan Team)
- Olvidar elementos no usados hace 90 días → ON
- Permitir que Foco aprenda de mis publicaciones → ON

### 3.4 Zona delicada (irreversible)

- **En SCREEN 13 (`memory`):** Vaciar memoria completa (borra todo el contenido de contexto).
- **En SCREEN 14 (`settings-mcp`):** Rotar API key + Desactivar MCP servidor (kill switches del gateway).

Los dos bloques están físicamente separados siguiendo §1.6 (contenido vs. configuración), pero ambos son acciones destructivas e irreversibles y comparten el mismo tratamiento visual (borde `rose-900`, iconografía de alerta).

### 3.5 Seguridad de ingesta (invariante del sistema)

Toda entrada de contenido a la Memoria — venga del upload directo o de los 10 conectores restantes — pasa por un pipeline de seguridad obligatorio, documentado en `INGEST_SECURITY.md`. **El documento de seguridad es prerequisito técnico para escribir cualquier parser o `MemoryItem`**; no se empieza ingesta sin spec firmada.

**Invariantes duras (copiadas aquí para que el equipo técnico las vea sin navegar):**
1. **Quarantine-first.** Todo archivo entra primero a bucket R2 de cuarentena. Solo pasa a main tras validación completa.
2. **MIME real por magic bytes** (libmagic). Nunca confiar en extensión ni en `Content-Type` declarado.
3. **Whitelist estricta** de los 13 formatos del §3.1. Cualquier otro = rechazo.
4. **Escaneo antivirus síncrono (ClamAV)** antes de parsear. Fail-closed: si AV no responde, el upload falla.
5. **Parser sandboxed** (Modal `allow_internet=False`, memoria acotada, timeout 60s).
6. **SVG nunca se sirve crudo**: sanitizar o convertir a PNG.
7. **URLs con SSRF defense**: rechazar IPs privadas / link-local.
8. **Hash SHA-256** para dedup + detección de archivos conocidos maliciosos.
9. **Audit log sincrónico** de cada ingest event. Si el log falla, la operación falla.
10. **Aplica a conectores externos también** (Drive, GitHub, socials, MCP) — no solo al upload directo.

**Reflejo en UX:**
- SCREEN 13 (Memoria): cada item muestra chip de verdict AV ("limpio") y metadata de hash + MIME real (colapsable).
- Al rechazar un upload: mensaje accionable con razón específica (MIME inválido, AV positivo, cuota, etc.).
- SVG que fue convertido a PNG muestra nota "Imagen vectorial convertida a PNG por seguridad".

### 3.6 Cuotas de almacenamiento por plan (firmadas 2026-04-17)

El usuario no puede subir contenido ilimitado. Storage y throughput escalan con el plan. Precios y nombres definitivos del MVP:

| Plan | Precio | Modelo IA | Storage | Uploads/día | Máx archivo | Videos/mes | Seats |
|---|---|---|---|---|---|---|---|
| Free | $0 | BYOK obligatorio | 500 MB | 10/día, 1 GB/día | 100 MB | 5 | 1 |
| Creator | **$39/mo** | **BYOK (el usuario aporta su API key)** | 10 GB | 100/día, 10 GB/día | 500 MB | 60 | 1 |
| Influencer | **$99/mo** | Managed (Foco cubre LLM) | 50 GB | 500/día, 50 GB/día | 500 MB | 300 | 1 |
| Celebrity | **$199/mo** | Managed · render prioritario | 200 GB | 2.000/día, 200 GB/día | 2 GB | 1.000 | hasta 3 |
| Studio | **Custom (contact us)** | Managed · SLA · SSO · DPA | Custom | Custom | Custom | Custom | Custom |

> **BYOK** (Bring Your Own Key) en Free y Creator: el usuario agrega su propia API key de Anthropic u OpenAI desde `settings-integraciones`. Foco siempre cubre embeddings, moderación (CSAM + deepfake) y render; la key del usuario cubre únicamente el asistente conversacional y las llamadas del MCP server. Ver `INGEST_SECURITY.md §4.1` para criptografía y manejo.

**Reflejo en UX:**
- **SCREEN 13 (Memoria):** widget de cuota visible arriba de la pantalla. Barra `used / total` + CTA "Aumentar plan" cuando >80%.
- **Drop zone:** conoce la cuota restante antes del drop; bloquea visualmente archivos que excedan.
- **SCREEN 11 (Billing):** comparativa completa de tiers con precio, storage, uploads, videos, seats, e indicador BYOK vs Managed.
- **Settings-integraciones:** sección nueva para gestión de API keys del usuario en Free/Creator (obligatorio) y Influencer+ (opcional, como fallback).
- **Upgrade = inmediato.** Downgrade respeta cuota vigente hasta fin del ciclo.
- **Eviction automática** (la de §3.3 "Olvidar >90d"): **ON por default en Free** (opt-out), **OFF por default en Creator+** (opt-in).
- **Suspensión por infección:** banner persistente en dashboard con countdown y motivo (archivo + engine + signature) según `INGEST_SECURITY.md §4.3`.

## 4 · Sistema visual

- **Tipografía:** Inter, base 17 px, scale base/lg/xl/2xl/3xl/4xl (17/19/22/28/36/44 px).
- **Paleta brand:** escala 50-900 morado (primario 600 `#7c3aed`, hover 500 `#8b5cf6`).
- **Dark mode primario**, con toggle a light.
- **Touch targets mínimos:** 48 × 48 px.
- **Bordes redondeados:** rounded-xl (12 px) para cards, rounded-2xl (16 px) para contenedores grandes.
- **Íconos:** lucide-icons, tamaño default 20 px en UI, 24-48 px en CTAs grandes.
- **Motion:** transitions 150-200 ms; no animaciones largas.

## 5 · Contratos críticos (input a la capa técnica)

Estos contratos de UX se convierten en tipos y APIs del backend:

### 5.1 `RenderRequest` (input al render-worker)

La timeline del editor (SCREEN 6) tiene 4 tracks (video, captions, audio, overlays) y el avatar aparece como un layer sobre video. El schema `RenderRequest` (en `packages/schemas/`) debe reflejar:
- Aspect ratio: `9:16` | `1:1` | `16:9`
- Scenes: array de `{ start, end, layers[] }` con hash para cache.
- Layers: `faceCam | avatar | caption | overlay | bgMusic`.
- Captions: intervals `{ word, tStart, tEnd, style }` (segment-based, binary search O(log n)).
- Caching: hash por escena, por layer, por caption precompute.
- Targets: Fase 1 ≤ 30s para 3s de video. Fase 2 ≤ 10s con cache.

### 5.2 `MemoryItem` (input al ingestor)

```ts
type MemoryItem = {
  id: string
  source:
    | 'file' | 'link' | 'drive' | 'github' | 'mcp'
    | 'youtube' | 'tiktok' | 'facebook' | 'linkedin' | 'instagram' | 'x'
  kind: 'document' | 'link' | 'video' | 'post' | 'note' | 'conversation' | 'learning' | 'website-section'
  title: string
  summary: string
  chunks: number // indexed into pgvector
  mcpExposed: boolean // per-item override (respecting §3.2 defaults)
  sensitive: boolean
  learnedFrom?: string[] // ids of sources a 'learning' was synthesized from
  syncStatus: 'live' | 'paused' | 'error' | 'manual'
  createdAt, updatedAt, lastSyncedAt

  // Seguridad (§3.5) — obligatorio para cualquier item con bytes asociados
  sha256: string
  sizeBytes: number
  mimeReal: string       // resultado de libmagic, no del Content-Type
  avVerdict: 'clean' | 'infected' | 'unknown' | 'not-applicable'
  avEngine: string       // 'clamav-1.3.0' etc.
  avScannedAt: Date | null
  sanitized: boolean     // true si SVG→PNG, macros stripped, etc.
  quotaBytesCharged: number  // cuenta contra el storage del plan (§3.6)
}
```

### 5.4 `UserQuota` y `IngestAuditEntry` (ver `INGEST_SECURITY.md`)

```ts
type UserQuota = {
  userId: string
  plan: 'free' | 'starter' | 'pro' | 'business' | 'enterprise'
  storageUsedBytes: number
  storageLimitBytes: number
  uploadsToday: number
  uploadsDailyLimit: number
  bytesToday: number
  bytesDailyLimit: number
  resetsAt: Date    // medianoche UTC del usuario
}

type IngestAuditEntry = {
  id: string
  userId: string
  source: MemoryItem['source']
  filename: string | null
  sizeBytes: number
  mimeDeclared: string | null
  mimeReal: string | null
  sha256: string | null
  avVerdict: 'clean' | 'infected' | 'unknown' | 'skipped-not-applicable' | 'error'
  avEngine: string | null
  scanDurationMs: number | null
  verdict: 'accepted' | 'rejected' | 'quarantined' | 'error'
  reason: string | null      // 'mime-not-whitelisted', 'av-positive', 'quota-exceeded', etc.
  timestamp: Date
}
```

### 5.3 `McpAuthorization`

```ts
type McpAuthorization = {
  agentId: string       // e.g. 'claude-desktop-local-8f3a'
  displayName: string   // e.g. 'Claude Desktop'
  apiKey: string        // hashed, rotatable
  scopes: Array<'learnings' | 'brand' | 'documents' | 'github' | 'socials'>
  createdAt: Date
  lastUsedAt: Date | null
  revokedAt: Date | null
}
```

## 6 · Próximos pasos técnicos (orden estricto)

0. **`INGEST_SECURITY.md` firmado v1.0** (2026-04-17) y **`PRODUCTION_READINESS.md` firmado v1.0** (2026-04-17). Estas specs son ancla obligatoria para cualquier código. No hay grey areas: cuotas, BYOK, escalamiento por infección, observability stack, moderación y postura regulatoria están cerrados.
1. **Escribir los 6 contratos ancla como JSON Schema 2020-12 (SSoT)** → `packages/schemas/` (paquete `@chisu/schemas`). Incluye RenderRequest, MemoryItem, UserQuota, IngestAuditEntry, SystemAuditEntry, McpAuthorization. (Puede paralelizarse con el punto 0.)
2. **Generar tipos zod (TS) + pydantic (Python)** para los 6 contratos de `packages/schemas/`. zod a mano (preservar DX); pydantic via `datamodel-code-generator` para workers Python.
3. **Stubs de packages y workers:** `packages/render-sdk/`, `workers/render-worker/`, `workers/ingest-quarantine/`, `workers/av-scanner/`, `workers/parser-*` (Modal + uv + ruff + mypy + Pillow + PyAV + ffmpeg-python + python-magic + pyclam).
4. **POC render:** 3s face-cam con caption word-level en 9:16 / 1:1 / 16:9.
5. **Pipeline de ingesta seguro v1** (tras firma de §0):
   - Edge handler con quota check + MIME sniff + R2 quarantine put.
   - `workers/av-scanner` con ClamAV + `freshclam` daily.
   - Parsers sandboxed por formato (13 de §5 en `INGEST_SECURITY.md`).
   - SVG→PNG + macro stripping + SSRF defense.
   - Audit log tabla Supabase + métricas Prometheus.
6. **MCP gateway** (prioridad alta — pieza diferenciadora):
   - Cliente MCP: parsers para Claude Desktop (SQLite local), Cursor, ChatGPT JSON, Gemini.
   - Servidor MCP: `@modelcontextprotocol/sdk` en TS, expone scopes §3.2.
   - Auth + audit log + UI integrada a SCREEN 14 (`settings-mcp`).
7. **Widget de cuota en SCREEN 13** + tabla de tiers en SCREEN 11 (Billing) — se implementan junto con el pipeline de §5.

## 7 · Qué queda explícitamente fuera del MVP

- Fuentes próximamente (ver §3.1).
- Plan Team (memoria compartida con equipo).
- Multi-idioma más allá de ES/EN.
- Renders 4K (MVP es 1080p).
- Agentes autónomos publicando sin aprobación del usuario.
- Marketplace de templates.

---

**Aprobado por Jean 2026-04-17 (v1.2) y 2026-04-18 (v1.3).** Cualquier cambio requiere reabrir este documento y firmar una nueva versión.
