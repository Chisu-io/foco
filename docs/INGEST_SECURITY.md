---
title: Foco · Seguridad y cuotas de ingesta
status: v1.0 (firmado 2026-04-17 — todas las decisiones §10 resueltas)
version: 1.0
date: 2026-04-17
owner: Jean Pierre Rojas
depends_on: UX_FROZEN.md v1.2, PRODUCTION_READINESS.md v1.0
changelog:
  - v0.1 2026-04-17 Primera versión draft con pipeline, invariantes, propuestas de cuotas y whitelist.
  - v1.0 2026-04-17 Jean firmó todas las decisiones de §10. Cuotas finales con BYOK en Creator, plan Studio custom, escalamiento por reincidencia definido, ClamAV como stack primario con extensibility para VirusTotal.
---

# Foco — Seguridad y cuotas de ingesta

Esta spec define el contrato de seguridad y las cuotas de almacenamiento que gobiernan cualquier contenido que entre a la Memoria de Foco, venga del upload directo o de los conectores externos (Drive, GitHub, redes, MCP). Es prerequisito técnico para escribir cualquier parser, `MemoryItem` o render-schema.

> **Principio rector:** el sistema asume que todo input es hostil hasta que se demuestre lo contrario. Fallar cerrado (fail-closed), nunca abierto. Ante duda, rechazar.

## 1 · Amenazas que este documento cubre

| # | Amenaza | Vector | Mitigación |
|---|---|---|---|
| T1 | Malware ejecutable | Upload directo, descarga de link, archivos en repos GitHub | AV scan + whitelist MIME + sandbox parser |
| T2 | Spoofing de tipo | Extensión `.pdf` con contenido `.exe` | Magic bytes (libmagic); se ignora extensión y `Content-Type` declarado |
| T3 | Parser exploit | PDF malicioso con stream inyectado, DOCX con XXE, SVG con script | Parser en contenedor sin red, timeout, memoria acotada, filesystem mínimo |
| T4 | SSRF | URL apuntando a `169.254.169.254` o IP interna | Resolver DNS, rechazar IPs privadas y link-local |
| T5 | Zip bomb / decompression bomb | DOCX/XLSX con ratio de expansión absurdo | Límite de tamaño descomprimido por entrada + ratio máx |
| T6 | XXE en XML (DOCX, SVG, XLSX) | Entidades externas que filtran archivos del servidor | Parser con `resolve_entities=False` por default |
| T7 | Macros VBA | XLSX/DOCX con VBAProject | Stripping de `vbaProject.bin`; rechazo si hay macros activas |
| T8 | Almacenamiento abusivo | Subida masiva de archivos legítimos para saturar costos R2 | Cuotas por plan + rate limit (ver §4) |
| T9 | Uploads automatizados | Bot subiendo hash único mil veces | Rate limit + captcha tras umbral + fingerprinting de device |
| T10 | Exfiltración vía SVG sanitization bypass | CSS con `url()` externa | Sanitización estricta + conversión a PNG para preview |

## 2 · Pipeline de ingesta (single source of truth)

```
 [source]                 [edge / api]                [quarantine worker]                   [main]
    │                         │                              │                                 │
    ├─ upload directo ────────┤                              │                                 │
    ├─ fetch link ────────────┤                              │                                 │
    ├─ pull drive/github ─────┤                              │                                 │
    ├─ pull social ───────────┤                              │                                 │
    │                         │                              │                                 │
    │                         ▼                              │                                 │
    │                    [1] quota check  ──reject──▶ user   │                                 │
    │                    [2] size check                      │                                 │
    │                    [3] MIME sniff (libmagic)           │                                 │
    │                    [4] whitelist check                 │                                 │
    │                    [5] sha256 + R2 put (quarantine/)   │                                 │
    │                    [6] audit log "received"            │                                 │
    │                         │                              │                                 │
    │                         └──▶ enqueue ingest job ──────▶│                                 │
    │                                                        ▼                                 │
    │                                                   [7] AV scan (ClamAV)                   │
    │                                                   [8] format-specific validator          │
    │                                                       (zip bomb, XXE, macro, struct ok?) │
    │                                                   [9] sandboxed parser ──extracted──▶    │
    │                                                  [10] sanitize (SVG→PNG, strip macros)   │
    │                                                  [11] chunk + embed                      │
    │                                                  [12] move R2: quarantine/ → main/       │
    │                                                  [13] pgvector insert + MemoryItem upsert│
    │                                                  [14] audit log "accepted" o "infected"  │
    │                                                                                          │
    └──────────────────────────────────────────────────── user sees new item ─────────────────▶│
```

**Cualquier paso que falle resulta en:** archivo borrado del bucket de cuarentena, log escrito con razón específica, notificación al usuario (para uploads directos) o error silencioso con log (para conectores automáticos).

## 3 · Invariantes de código (no negociables)

1. **Fail-closed.** Si el servicio AV no está disponible, el upload **falla**. Nunca se pasa sin escanear.
2. **Quarantine-first.** Ningún archivo se sirve al usuario ni se indexa antes de completar el pipeline completo.
3. **MIME real > declarado.** Solo el resultado de `libmagic` determina el tipo. Si no coincide con la extensión, el conflicto se loggea pero el MIME real manda.
4. **Whitelist estricta.** Formatos del MVP (§5) son los únicos aceptados. Cualquier otro = rechazo con mensaje claro.
5. **Parser sin red.** Containers Modal con `allow_internet=False`. Cualquier side-effect de red dentro de un parser es indicativo de exploit.
6. **SVG nunca crudo.** Se sanitiza o se convierte a PNG antes de retornar al cliente.
7. **SSRF defense obligatorio.** URLs se resuelven antes de fetch; IPs privadas = rechazo.
8. **Audit log sincrónico.** Si escribir el log falla, la operación falla. Sin excepciones.
9. **Hash antes de indexar.** SHA-256 se calcula y almacena. Archivos con hash ya conocido (y marcado infectado) se rechazan sin re-escanear.
10. **Retención de infectados = 0.** Se borran del bucket inmediatamente tras log.

## 4 · Cuotas de almacenamiento por plan (firmadas 2026-04-17)

Las cuotas limitan (a) cuánto puede almacenar el usuario en Memoria, (b) cuántos uploads puede disparar, y (c) cuánto cómputo de IA consume. Los precios son la fuente de verdad; el resto de límites se ajusta a ellos.

| Plan | Precio | Modelo IA | Storage Memoria | Uploads/día | Tamaño máx por archivo | Videos/mes | Seats |
|---|---|---|---|---|---|---|---|
| **Free** | $0 | BYOK obligatorio | 500 MB | 10/día, 1 GB/día | 100 MB | 5 | 1 |
| **Creator** | **$39/mo** | **BYOK (usuario aporta su key de Anthropic/OpenAI)** | 10 GB | 100/día, 10 GB/día | 500 MB | 60 | 1 |
| **Influencer** | **$99/mo** | Managed (Foco cubre llamadas LLM) | 50 GB | 500/día, 50 GB/día | 500 MB | 300 | 1 |
| **Celebrity** | **$199/mo** | Managed · render prioritario | 200 GB | 2.000/día, 200 GB/día | 2 GB | 1.000 | hasta 3 (manager + asistente) |
| **Studio** | **Custom (contact us)** | Managed · SLA · SSO · DPA · priority queue | Custom | Custom | Custom | Custom | Custom |

### 4.1 BYOK (Bring Your Own Key) — aplica a Free y Creator

- El usuario agrega su propia API key de Anthropic (Claude) u OpenAI (GPT) desde `settings-integraciones`.
- La key se cifra con **envelope encryption** (AES-256-GCM con KEK rotatoria en Supabase Vault / AWS KMS), nunca guardada en plaintext ni en logs.
- En runtime, el worker descifra la key en memoria y la inyecta en la llamada al proveedor LLM. Nunca se loggea ni se expone en UI.
- **Foco siempre cubre** (independiente del plan): embeddings, moderación (CSAM + deepfake detection), render compute, storage. La key del usuario cubre únicamente las llamadas del asistente conversacional (generación de guiones, hooks, ideas) y las llamadas del MCP server.
- Si la key del usuario agota cuota con su proveedor, Foco muestra error claro con enlace a su dashboard del proveedor y pausa las generaciones — no cobramos su plan mientras su IA esté sin cuota.
- Al upgrade a Influencer+, la key del usuario queda opcional (puede quitarla o mantenerla como fallback).

### 4.2 Reglas de enforcement

- **Storage = hard quota.** Rechazar upload si `currentStorage + incomingFileSize > planQuota`. Mensaje al usuario con upsell al plan superior.
- **Uploads/día y GB/día = soft quota** con warning al 80% y bloqueo al 100% hasta reset 00:00 UTC. No afecta capacidad de publicar contenido ya generado.
- **Videos/mes = hard quota** dentro del ciclo de billing. Upsell inline cuando se agota.
- **Eviction automática opcional** (§3.3 UX_FROZEN, "Olvidar elementos no usados hace 90 días"): cuando está ON, `lastAccessedAt > 90d` libera cuota sin intervención del usuario. Free tiene eviction **ON por default** (opt-out); Creator+ tiene eviction **OFF por default** (opt-in).
- **Upgrade inmediato:** cambio de plan aumenta cuota al instante. Downgrade respeta cuota vigente hasta fin del ciclo de billing; si al renovar el plan nuevo tiene menos cuota de la que el usuario ocupa, bloquear uploads hasta que reduzca (no borrar automáticamente su contenido).
- **Rate limit técnico adicional** (independiente de plan): 5 uploads concurrentes por usuario, para proteger el worker pool de escaneo AV.

### 4.3 Escalamiento por archivos infectados

Política firmada 2026-04-17 tras decisión explícita de Jean: "el archivo infectado no puede llegar al servidor; se avisa al usuario y, si reincide, bloqueamos la cuenta temporalmente e incrementamos si reincide."

| Ocurrencia en ventana 30d rolling | Suspensión de uploads | Acción adicional |
|---|---|---|
| 1ra infección | **30 minutos** | Email al usuario con hash + engine verdict + guía de higiene |
| 2da | 12 horas | Audit entry elevado a sev-2, equipo de soporte notificado |
| 3ra | 24 horas | Revisión manual iniciada; si patrón sospechoso → ban permanente |
| 4ta | 72 horas | Ban permanente candidato; apelable vía `settings/appeal` |
| 5ta+ | **Suspensión indefinida** | Cuenta congelada; revisión humana obligatoria antes de reactivar |

- **La suspensión bloquea solo uploads nuevos.** El usuario sigue pudiendo ver y publicar lo que ya tiene, exportar su data (DSR) y eliminar su cuenta.
- **El archivo infectado nunca toca main storage ni DB ni se muestra al usuario como suyo.** Queda en el bucket R2 `foco-quarantine` solo el tiempo que dura el scan, luego se borra y se registra en `ingest_audit` con `verdict: 'infected'`, hash SHA-256, engine, engineVersion, signaturesVersion.
- **Hash repetido = escalación automática a ban permanente.** Si el mismo SHA-256 reincide (el usuario reenvía literalmente el mismo archivo infectado), se interpreta como intencionalidad y escala directo a step 5 sin pasar por los intermedios.
- **Ventana de reincidencia: 30 días rolling.** Sin infecciones por 30 días → contador resetea.
- **Notificación en UI:** la suspensión se muestra en el dashboard con countdown visible y explicación exacta del motivo (qué archivo, qué engine, qué signature).

## 5 · Formatos permitidos (whitelist del MVP)

| Categoría | MIME real requerido | Extensión común | Parser responsable |
|---|---|---|---|
| PDF | `application/pdf` | `.pdf` | pypdfium2 (no pypdf — menos exploits recientes) |
| Word | `application/vnd.openxmlformats-officedocument.wordprocessingml.document` | `.docx` | python-docx con `keep_macros=False` |
| Excel | `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` | `.xlsx` | openpyxl con macro stripping |
| CSV | `text/csv`, `text/plain` | `.csv` | csv stdlib |
| Markdown | `text/markdown`, `text/plain` | `.md` | markdown-it-py sin HTML inline |
| Texto | `text/plain` | `.txt` | stdlib |
| MP3 | `audio/mpeg` | `.mp3` | pyAV decode only |
| WAV | `audio/wav`, `audio/x-wav` | `.wav` | pyAV |
| MP4 | `video/mp4` | `.mp4` | pyAV + ffmpeg probe |
| MOV | `video/quicktime` | `.mov` | pyAV + ffmpeg probe |
| PNG | `image/png` | `.png` | Pillow |
| JPG | `image/jpeg` | `.jpg`, `.jpeg` | Pillow |
| SVG | `image/svg+xml` | `.svg` | sanitize → convertir a PNG con cairosvg/resvg |

Cualquier otro = rechazo.

## 6 · Stack técnico (primera propuesta)

| Componente | Elección primaria | Por qué |
|---|---|---|
| AV engine | **ClamAV** containerizado en Modal (firmado MVP) | OSS, definiciones actualizadas vía `freshclam` diario, determinista, auditable. No saca data del perímetro. Detrás de interface `AVScanner` para agregar VirusTotal (segunda opinión) sin rewrite. |
| MIME sniff | `python-magic` (workers) + `file-type` (edge TS) | Estándar de industria. |
| Hashing | SHA-256 (`hashlib`) | Colisión-resistente, rápido. |
| Quarantine bucket | R2 `foco-quarantine` con lifecycle: delete tras 24h sin progreso | Separa responsabilidad del bucket main. |
| Main bucket | R2 `foco-memory` cifrado server-side | Donde viven los archivos ya validados. |
| SSRF defense | Librería propia (~50 líneas) + block IANA reserved ranges | Sin dependencias grandes; auditable. |
| Sandbox | Modal container `allow_internet=False`, memory 512MB, timeout 60s | Configurable por parser. |
| SVG → PNG | `cairosvg` o `resvg-py` | Bien mantenidos. |
| Audit log | Supabase tabla `ingest_audit` particionada por mes | Query-able + retención configurable. |

**AV stack firmado (2026-04-17):** ClamAV para MVP. Bases arquitectónicas listas para sumar **VirusTotal como segunda opinión** (lookup por hash primero, upload solo si hash desconocido y el usuario es plan Influencer+) sin rewrite del pipeline. La abstracción `AVScanner` con fallback y resultado agregable (`[clamav_verdict, virustotal_verdict?]`) se diseña desde el primer commit. AWS GuardDuty no se considera en MVP (requiere S3 en vez de R2).

## 7 · UX implicado

1. **SCREEN 13 (Memoria):** widget de cuota visible arriba. Barra de progreso con `used / total` y CTA "Aumentar plan" cuando > 80%.
2. **Drop zone:** antes de permitir el drag, la UI ya conoce el remaining quota y bloquea visualmente drops que excedan.
3. **Al rechazar un upload:** mensaje accionable. "No podemos procesar `archivo.pdf` (motivo: MIME real `application/octet-stream` no está en la lista permitida)" o "Tu cuota está llena. Borra algo o actualiza a Pro (+20 GB)".
4. **SCREEN 11 (Billing):** comparativa visible de los tiers con storage + uploads/día + videos/mes.
5. **Pantalla de item individual de Memoria:** muestra hash, tamaño, MIME real, fecha de ingesta, verdict AV (chip verde "limpio"). Si el item tuvo que pasar por sanitización (p.ej. SVG convertido), mostrar nota.

## 8 · Telemetría y alertas

- **Métricas:** `ingest_requests_total{result, mime}`, `av_scan_duration_seconds`, `quarantine_bucket_bytes`, `quota_usage_percent{plan}`, `ssrf_blocked_total`, `parser_crash_total{parser}`.
- **Alertas:** tasa de rechazos > 5% sostenida = posible ataque; cualquier `av_verdict: infected` = notificación al usuario + SOC ticket; `parser_crash_total` > umbral = rollback del parser involucrado.

## 9 · Qué queda fuera de v0.1 (siguiente iteración)

- Integración con VirusTotal para segunda opinión cuando ClamAV da verdict sospechoso.
- OCR de PDFs escaneados (no afecta seguridad, pero requiere Tesseract en sandbox).
- Análisis de macros con oletools para decidir si solo stripping o rechazo completo.
- Content-based similarity hashing (perceptual hash de imágenes/videos) para detectar contenido duplicado con pequeñas mutaciones.
- DLP (Data Loss Prevention): detectar y advertir cuando el usuario sube un secreto (API key, password) para evitar que entre a pgvector.

## 10 · Decisiones firmadas (2026-04-17)

1. **Cuotas por plan:** ✅ firmadas en §4. Free ($0, BYOK) / Creator ($39, BYOK) / Influencer ($99, managed) / Celebrity ($199, managed) / Studio (custom, contact us). Nombres y precios definitivos para el MVP.
2. **AV stack:** ✅ ClamAV para MVP con interface `AVScanner` que permite sumar VirusTotal como segunda opinión a futuro sin rewrite.
3. **Plan Studio:** ✅ custom, sin listing público de features. Todo sales-assisted.
4. **Política de archivos infectados:** ✅ firmada en §4.3. Escalamiento 30min → 12h → 24h → 72h → indefinido, ventana 30d rolling, hash repetido → ban automático.
5. **Eviction automática:** ✅ **ON por default en Free** (forzar rotación, ayuda a respetar los 500MB), **OFF por default en Creator+** (el usuario pagando espera control total). Ambos configurables en `settings-ajustes`.
6. **Región primaria:** ✅ US start, código multi-region-ready desde commit 1 (ver `PRODUCTION_READINESS.md §15 punto 9`). EU activable en <4h cuando haya justificación comercial.

Todas las decisiones de ingesta quedan cerradas. Cambios futuros requieren reabrir este documento y firmar una nueva versión.
