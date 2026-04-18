---
title: Foco · Production Readiness & Compliance
status: v1.0 (firmado 2026-04-17 — §15 resuelto; operativo como contrato de producción)
date: 2026-04-17
owner: Jean Pierre Rojas
depends_on: UX_FROZEN.md v1.2, INGEST_SECURITY.md v0.1
applies_to: todo el sistema Foco (web app, workers, MCP gateway, APIs, infra, terceros)
changelog:
  - v1.0 2026-04-17 Jean firmó las 11 decisiones pendientes de §15. Stack definido para MVP → escala.
---

# Foco — Production Readiness & Compliance

Este documento es el contrato operativo que Foco debe cumplir para estar en producción. Vive al mismo nivel que `UX_FROZEN.md` e `INGEST_SECURITY.md` y los tres juntos forman el trío de specs que cualquier commit de producción debe respetar. Cubre observabilidad, audit, compliance de privacidad, borrado de datos, seguridad de aplicación e infra, testing, incident response, moderación y SLOs.

> **Principio rector.** Foco maneja memoria personal del usuario, keys de sus redes, conversaciones privadas de sus AIs y contenido publicable. Cualquier falla de auditoría, privacidad o borrado es potencialmente un incidente de confianza pública. Se diseña **assumir breach** y construir las barreras y las trazas que demuestran control cuando algo falla.

---

## 1 · Principios de producción (no negociables)

1. **Observable por default.** Nada se desplegará sin log estructurado, métrica y traza. Si un bug requiere reproducirlo en prod para diagnosticarlo, la observabilidad falló.
2. **Audit-first.** Toda acción del usuario que modifique estado, cambie permisos o acceda a datos sensibles se registra en un log inmutable con trace de quién/qué/cuándo. El log del sistema es fuente de verdad ante disputas.
3. **Privacy by design.** Cumple GDPR, CCPA, PIPEDA y Ley 1581 de Colombia desde el primer commit. Minimización, consentimiento explícito, retención justificada, borrado verificable.
4. **Least privilege siempre.** Humanos y servicios tienen el permiso mínimo necesario. Escalación temporal auditada, no permanente.
5. **Fail-closed.** Lo mismo que en ingesta: si un control de seguridad no responde, la operación falla, no pasa.
6. **Reproducibilidad.** Cualquier build de producción debe poder reconstruirse byte-a-byte desde el commit hash. Imágenes firmadas, SBOM adjunto.
7. **Resilience proportional al blast radius.** Un error en publicación de un post no tumba el render; un error en el render no tumba el MCP; un error en MCP no tumba la auth.
8. **Transparencia con el usuario.** El usuario siempre puede ver quién accedió a sus datos, qué tiene guardado Foco sobre él, y borrarlo.

---

## 2 · Observabilidad

### 2.1 Logging estructurado

Formato **JSON line** único en todo el stack. Campos obligatorios:

```
{ ts, level, service, env, traceId, spanId, userId?, requestId, msg, ...ctx }
```

- `pino` para TS (edge, control plane). `structlog` para Python (workers).
- Nunca `console.log` en producción. Lint rule bloqueante.
- **PII redaction automática.** Campos conocidos (`email`, `phone`, `address`, `apiKey`, `password`, `token`, SSN-like, tarjetas) se redactan en ingestión del logger antes de salir del proceso. Librería central `@foco/logger` con allowlist de campos seguros.
- Sampling: `info` 100%, `debug` 10% en prod (config por servicio). `error` y `warn` siempre 100%.
- Retención de logs: 30 días hot (Grafana Loki), 1 año warm (R2), 7 años cold para logs de auditoría (R2 Glacier-equivalent con Object Lock).

### 2.2 Métricas

- **OpenTelemetry** como estándar. Collector → Prometheus → Grafana.
- **Golden signals** por servicio: rate, errors, duration, saturation.
- **SLI específicos:** ver §12.
- Métricas de negocio separadas (signups, videos generados, publishes exitosos, upgrades de plan) en namespace `foco_business_*` para que no contaminen el alerting técnico.

### 2.3 Tracing distribuido

- OpenTelemetry tracing end-to-end. Un `traceId` conecta la request del usuario → edge → control plane → worker → DB → callbacks a terceros (OAuth publish).
- `traceId` propagado por headers W3C traceparent. Incluido en todos los logs y en el Sentry issue.
- Sampling: 100% de errores, 10% de requests OK (ajustable por ruta).

### 2.4 Error tracking

- **Sentry** (self-hosted o cloud — decisión de §15). Todos los servicios lo integran.
- Alerta automática: nueva issue en `prod` → PagerDuty según severidad (§10.1).
- Source maps y symbols subidos al deploy. Stack traces human-readable siempre.

### 2.5 Alerting

- **PagerDuty** para páginas 24/7 (o alternativa — §15).
- Policies por severidad; solo **sev-1 y sev-2** pagan a humano fuera de horas.
- **Runbook obligatorio** por cada alerta. Alerta sin runbook = bloqueo de merge hasta que exista.
- Suppressions con expiración obligatoria. No hay silencios indefinidos.

### 2.6 Dashboards

Dashboards Grafana mínimos para estar en prod:

1. **Salud general** (todas las SLIs de §12, verde/amarillo/rojo).
2. **Ingesta** (uploads/min, AV verdicts, quota utilization por plan, parser latency).
3. **Render** (jobs/min, duration p50/p95/p99 por aspect ratio, cache hit rate, failure rate por causa).
4. **MCP** (conexiones activas, scope usage, audit events/min, bloqueos).
5. **Publicación** (OAuth renovations, publish attempts por red, failures por razón — rate limit, token expirado, etc.).
6. **Costos** (R2 bytes, Modal GPU-hours, Supabase rows, Anthropic/OpenAI tokens — por día, por usuario activo).

---

## 3 · Audit logs del sistema

Extiende el audit log de ingesta a todo el sistema. Tabla Supabase `system_audit` particionada por mes, **append-only**, con hash chain (cada fila incluye `prevHash`; alteración detectable).

### 3.1 Eventos obligatorios a registrar

| Categoría | Ejemplos |
|---|---|
| **Auth** | login ok, login fail, logout, password reset, MFA enrolled, MFA used, session revoked |
| **Permission** | MCP agente autorizado, scope toggled, plan upgrade/downgrade, admin access granted/revoked |
| **Data access sensitive** | export de memoria, descarga de render, lectura MCP por agente externo, acceso de staff a cuenta de usuario (con reason) |
| **Data mutation destructive** | vaciar memoria, borrar item, rotar API key, desactivar MCP, borrar cuenta |
| **Billing** | pago exitoso, pago fallido, refund, cambio de método de pago |
| **Ingest** | ya cubierto por `IngestAuditEntry` (§5.4 UX_FROZEN) |
| **Render** | job start, job complete, job failed, job retried |
| **Publish** | intento, éxito, fallo con razón, revocación de token OAuth |
| **Admin/staff** | cualquier acción de Foco staff sobre cuenta de usuario (ver §6.3) |

### 3.2 Esquema de `SystemAuditEntry`

```ts
type SystemAuditEntry = {
  id: string                // uuid v7 (ordenable temporalmente)
  ts: Date
  prevHash: string          // hash del entry anterior (hash chain)
  hash: string              // hash(prevHash + payload)
  actor:
    | { kind: 'user'; userId: string }
    | { kind: 'staff'; staffId: string; reason: string }
    | { kind: 'service'; serviceName: string }
    | { kind: 'external-agent'; agentId: string }  // MCP
  action: string            // 'mcp.scope.toggle', 'account.delete', etc.
  target:
    | { kind: 'memoryItem'; id: string }
    | { kind: 'mcpAuth'; id: string }
    | { kind: 'account'; userId: string }
    | { kind: 'render'; id: string }
    | { kind: 'publish'; id: string }
    | null
  result: 'ok' | 'denied' | 'error'
  reason?: string           // razón específica si denied/error
  ip?: string               // solo si es relevante legalmente
  userAgent?: string
  traceId: string
  ctx?: Record<string, unknown>
}
```

### 3.3 Retención e integridad

- **Retención:** 7 años en cold storage (R2 con Object Lock compliance mode, immutable hasta el vencimiento).
- **Integridad:** el hash chain se verifica cada 24h por un job que recalcula hash de cada fila. Si la cadena se rompe, alerta sev-1 inmediata.
- **Visibilidad al usuario:** en `settings-mcp` ya se ve el log de MCP; en `settings-privacy` (nueva, ver §4) el usuario puede ver los últimos 90 días de eventos de auth + permisos de su cuenta. Pide un "Data export" para descargar historial completo.
- **Acceso interno:** staff acceso requiere MFA + justificación registrada (que también queda en audit).

---

## 4 · Privacidad y compliance

### 4.1 Jurisdicciones cubiertas

Foco arranca sirviendo a:
- **UE/EEA** → **GDPR** (Reglamento 2016/679).
- **California** → **CCPA/CPRA**.
- **Canadá** → **PIPEDA** (federal) + **Law 25 Québec** si hay usuarios de Québec.
- **Colombia** (mercado LATAM inicial, Jean vive en Vancouver pero tiene red en CO) → **Ley 1581 de 2012 y Decreto 1377**.
- **EE.UU. federal** → compromiso best-effort con propuestas como CCRAA/APRA aunque no estén en vigor.

### 4.2 Derechos del usuario (Data Subject Rights)

Debe existir un flujo visible en UI para cada derecho:

| Derecho | GDPR | CCPA | PIPEDA | Ley 1581 | UX de Foco |
|---|---|---|---|---|---|
| Acceso a los datos | Art. 15 | 1798.110 | Principio 9 | Art. 14 | "Descargar mi memoria" en Privacidad |
| Portabilidad | Art. 20 | 1798.130(a)(3) | — | — | Export JSON + archivos en ZIP |
| Rectificación | Art. 16 | 1798.106 | Principio 9 | Art. 14 | Edición inline de items de Memoria |
| **Borrado / "right to be forgotten"** | Art. 17 | 1798.105 | Principio 5 | Art. 14 | "Eliminar mi cuenta" |
| Oposición / restricción | Art. 18, 21 | 1798.120 | Principio 3 | Art. 9 | Kill switch MCP + desactivar conectores |
| Objeción a decisión automatizada | Art. 22 | — | — | — | Revisión humana del contenido sugerido (ya es el UX por default) |

### 4.3 Cuenta: borrado completo verificable

Cuando el usuario pide borrado (desde `settings-privacy` o vía email a privacy@chisu.io):

1. **Grace period** de 30 días (reversible) → cuenta marcada `pendingDeletion`, login bloqueado, MCP desactivado, publicaciones programadas canceladas. Email de confirmación con link "cancelar borrado".
2. Al vencer 30 días o si el usuario confirma inmediato: job `hardDeleteAccount`:
   - Purge filas en Postgres con cascade (`users`, `memory_items`, `mcp_authorizations`, `renders`, `publishes`, `user_quotas`).
   - Purge embeddings en pgvector.
   - Purge archivos en R2 `foco-memory/<userId>/*` y `foco-renders/<userId>/*`.
   - Purge logs de app que contengan `userId` (log índice tiene `userId` como tag → PII redaction retroactiva).
   - Revocar tokens OAuth de las 6 redes sociales (API de revocación por red).
   - Desactivar el servidor MCP para ese usuario.
3. **Se preservan 7 años** (obligación legal, proporcional y con base justificada): `system_audit` anonimizado con `userId` hash irreversible; y `billing_invoices` por obligación fiscal (sin PII más allá de lo requerido por facturación). El usuario recibe documentación de qué queda y por qué.
4. **Prueba de borrado:** el usuario recibe un "Certificado de eliminación" con hash del job, fecha y lista de sistemas purgados. Archivable por él para auditorías propias.
5. **Backups:** los backups se invalidan al próximo ciclo (ver §7.5). Mientras tanto, si se restaura un backup, corre automáticamente un job que re-aplica los hard-deletes pendientes.

### 4.4 Retención de datos (por categoría)

| Categoría | Duración | Base legal |
|---|---|---|
| Memoria del usuario (archivos, chunks, embeddings) | Mientras la cuenta esté activa | Consentimiento (GDPR 6.1.a) |
| Renders generados | 90 días desde creación, luego purge si `saved=false` | Legítimo interés proporcional |
| Logs técnicos con PII | 30 días | Legítimo interés — debug operacional |
| Audit log | 7 años (Object Lock) | Obligación legal / defensa ante reclamos |
| Facturación | 7 años (US/EU), 10 años (CO) | Obligación legal fiscal |
| Cookies analíticas | 13 meses máx | ePrivacy Directive |
| Tokens OAuth | Hasta revocación del usuario o 12 meses de inactividad | Necesidad contractual |

Cada categoría tiene un job de purga con el periodo anterior y el job lo registra en `system_audit`.

### 4.5 Consentimiento y cookies

- **Banner de consent** granular (necessary, analytics, marketing). Necessary-only es funcional; analytics y marketing son opt-in explícito.
- **Sin cookies de terceros.** Si se añade un vendor de tracking, requiere DPIA separada.
- **Preferencias de consent** revocables en `settings-privacy` con un clic.
- No oscurecemos el botón de rechazo. "Rechazar todo" es igual de visible que "Aceptar todo".

### 4.6 Transferencias internacionales

- Stack primario en Cloudflare (R2, Workers) + Supabase (AWS us-east/eu-west). Para usuarios EU se usa región EU de Supabase y R2 jurisdictional restrictions EU.
- **Standard Contractual Clauses 2021** con todos los sub-procesadores.
- Lista pública de sub-procesadores en `/legal/subprocessors` actualizada antes de añadir uno nuevo.

### 4.7 DPIA obligatorias

Se ejecuta Data Protection Impact Assessment antes de activar:

1. **MCP servidor** (compartición con terceros controlada por usuario — ya cubierto por UX_FROZEN §3.2 + audit log).
2. **Embeddings en pgvector** (procesamiento inferencial sobre datos personales).
3. **Training de voice cloning / avatar** (datos biométricos — Art. 9 GDPR, categoría especial).
4. **Integración nueva cualquiera** que procese datos personales.

DPIAs versionadas en `foco/docs/dpia/*.md`.

---

## 5 · Seguridad de aplicación

### 5.1 Autenticación

- **Primary:** email + password + WebAuthn (passkeys) como fuerte.
- **MFA obligatoria** para: admin staff, planes Business y Enterprise.
- **MFA opcional fuerte** para Free/Starter/Pro, incentivada en onboarding.
- Password policy NIST 800-63B: min 12 chars, check contra haveibeenpwned k-anonymity, no requirements arbitrarios de símbolos.
- Rate limit de login: 5 intentos en 10 min por IP+email, luego captcha; 20 en 1h bloquea cuenta 1h.
- Session: JWT de 15 min + refresh token de 14 días, rotación, reuse detection invalidita la cadena completa.
- OAuth sign-in: Google, Apple (obligatorio si publicamos en App Store), GitHub opcional.

### 5.2 Autorización

- **RBAC** con roles: `user`, `staff-support`, `staff-eng`, `admin`.
- **Row-Level Security en Postgres** activa. Cada tabla con `userId` tiene policy `userId = auth.uid()` por default.
- Permisos escalados (staff accediendo a cuenta de usuario) requieren justificación escrita + aprobación de segundo staff member, registrado en audit.
- API keys del usuario (BYOK) cifradas en reposo con per-user key derivation (`kms derive key by userId`).

### 5.3 Secrets management

- **Ningún secreto en el repo.** Gitleaks en pre-commit y en CI.
- **Doppler** (o Vault — §15) para secrets de servicios. Rotación automática donde el provider lo permite.
- Customer API keys (BYOK de Anthropic/OpenAI/ElevenLabs) cifradas con AWS KMS envelope encryption, nunca loggeadas.
- Servicio de re-encryption anual para KEKs.

### 5.4 Crypto y transporte

- **TLS 1.3 obligatorio** en todo endpoint público. TLS 1.2 solo temporal para clientes legacy si hay evidencia de uso.
- **HSTS** con `includeSubDomains; preload` y registro en el preload list.
- **Certificate transparency** monitoreado (alertas si aparece un cert de chisu.io que no emitimos).
- **CSP** estricta: `default-src 'self'; script-src 'self' 'strict-dynamic' 'nonce-...'; frame-ancestors 'none'`.
- **COEP/COOP/CORP** activas para preparar a cross-origin isolation cuando necesitemos SharedArrayBuffer en render client-side.
- Cookies: `Secure`, `HttpOnly`, `SameSite=Lax` (`Strict` en cookies de auth críticos).

### 5.5 Input / Output

- **Zod** valida todo input en el boundary del edge. Pydantic idem en workers.
- Sanitización de HTML usuario-facing con DOMPurify.
- Output encoding consistente (React escapa por default — ESLint rule contra `dangerouslySetInnerHTML` sin allowlist).
- SQL siempre parametrizado; ningún string interpolation en queries. Lint rule.
- Uploads ya cubiertos por `INGEST_SECURITY.md`.

### 5.6 Dependencies y supply chain

- `pnpm audit` + Snyk en CI, bloqueo de merge si vulnerabilidad `high`/`critical` sin waiver documentado.
- Dependabot semanal.
- **SBOM** (CycloneDX) generado por build y publicado como artifact del release.
- Imágenes Docker firmadas (cosign) con provenance (SLSA level 2 como baseline, level 3 post-SOC 2).
- Pin de versiones exactas (`package.json` con versiones sin `^` en producción via pnpm lockfile + `--frozen-lockfile`).

### 5.7 SAST / DAST

- **CodeQL** (GitHub Advanced Security) y **Semgrep** con ruleset propio para patterns anti-foco (regex que detectan `console.log` con objetos, queries no parametrizadas, redirects sin validar, etc.).
- **OWASP ZAP** contra staging semanal.
- **Pen test** externo anual; bug bounty público post 6 meses en producción estable.

---

## 6 · Seguridad de infraestructura

### 6.1 Identidad y acceso

- SSO corporativo para staff (Google Workspace + SSO a Cloudflare/AWS/Supabase/Modal).
- Just-in-time access para prod (aprobación + expiración 4h). Tool: Teleport o equivalente post-MVP; MVP: approval manual documentado.
- Service accounts con keys rotables y scope mínimo.
- Breakglass account físicamente guardada (hardware token + overnight rotation).

### 6.2 Red

- **Cloudflare** al frente de todo: WAF, Bot Management, DDoS, rate limit.
- **Egress control:** workers salen solo a destinos allowlisted (las APIs de redes sociales oficiales + OAuth endpoints + LLM providers). Everything else bloqueado.
- VPN interna no necesaria inicialmente (todo es cloud-native); si aparece necesidad, Tailscale.
- IPv6 habilitado.

### 6.3 Staff access a datos de usuario

- **Ningún staff puede leer memoria de usuario por default.** Tabla con RLS deniega staff.
- Para soporte: flujo "Request user assist" → el usuario genera un token temporal en su UI (settings-privacy → "Permitir soporte por 1 hora") que eleva un staff específico a read-only sobre su cuenta. Token expira automáticamente y se registra en audit.
- Para incidentes sev-1 (breach de seguridad, por ejemplo): dos staff-admin firman el break-glass, se loggea la razón, se notifica al usuario dentro de 72h.

### 6.4 Backups y disaster recovery

- **Postgres:** PITR (point-in-time recovery) 30 días en Supabase.
- **R2:** versioning + object lock en buckets críticos (audit, facturación).
- **RPO** (recovery point objective): 15 min para Postgres, 1h para R2.
- **RTO** (recovery time objective): 4h para servicios P0 (auth, render, publish), 12h para secundarios (dashboard, analytics).
- **DR drill** trimestral en staging, documentado.
- **Region failover:** solo para Enterprise inicialmente; MVP es single-region con multi-AZ.

### 6.5 Hardening containers / Modal

- Read-only filesystem excepto `/tmp`.
- `allow_internet=False` en parsers y en AV scanner (ya en INGEST_SECURITY).
- Seccomp y AppArmor profiles por defecto.
- Imágenes distroless donde sea posible; si no, Chainguard images.
- CVE scanning (Trivy) en CI, bloqueo `high`/`critical`.

### 6.6 Cost controls (aka "no quiero la factura de $40K por un bug")

- Presupuestos por mes con alertas a 50/80/100%.
- Circuit breakers automáticos:
  - Cap de GPU-hours Modal por día.
  - Cap de tokens de LLM por usuario por día.
  - Cap de bytes egress Cloudflare por hora (previene abuso).
- Anomalía → alerta antes de cortar; corte si no hay respuesta humana en 30 min.

---

## 7 · Testing y calidad

### 7.1 Pirámide de tests

- **Unit** (Vitest TS, pytest Python): 80%+ cobertura en líneas de lógica de negocio. No se exige cobertura en código trivial (adapters, DTOs).
- **Integration** (Testcontainers Postgres + Redis + S3-mock): 100% de paths críticos (auth, ingest, render, publish, billing, MCP).
- **E2E** (Playwright): smoke de flujos happy-path + regression de bugs resueltos. Corre en staging cada merge.
- **Accessibility** (axe-core + manual): WCAG AAA auditado en cada pantalla antes del release.
- **Visual regression** (Chromatic o Percy): snapshots por pantalla, revisión humana si hay diff.
- **Load tests** (k6) contra staging antes de cada release importante.
- **Chaos engineering** (Gremlin o tooling propio) post-launch estable.

### 7.2 CI bloqueante

Un PR no se puede mergear si:
- Lint falla.
- Tipos fallan.
- Tests fallan.
- Cobertura cae bajo el baseline.
- Scan de secretos encuentra algo.
- `pnpm audit` tiene `high`/`critical` sin waiver.
- CodeQL o Semgrep tienen findings nuevos.
- No hay review aprobada (solo owners pueden bypass con justificación en el commit).

### 7.3 Feature flags

- **GrowthBook** (open source, self-hostable) o LaunchDarkly — §15.
- Cada feature nueva va detrás de flag por 1 ciclo mínimo.
- Kill switch global por servicio listo en dashboard.

---

## 8 · Deployment y release

- **Trunk-based** con feature flags, sin long-lived branches.
- **Blue-green** para control plane (TS); rolling con health checks para workers (Python Modal).
- **Canary 5% → 25% → 100%** por 20 min en cada escalón, con rollback automático si error rate o latency p99 exceden baseline 2x.
- **Commits firmados** obligatorios para main. Tags de release firmados con cosign.
- **Changelog** automático (conventional commits) publicado en docs públicos.
- **Deprecation policy:** 90 días de aviso para breaking changes de API pública, con versioned endpoints.

---

## 9 · Content moderation

### 9.1 Qué se modera

- **Generación ilegal (bloqueo duro):** prohibición de CSAM (stack de §15 punto 7: NCMEC hash match + OSS NSFW classifier → PhotoDNA → Thorn Safer), violencia explícita contra menores, incitación a violencia contra grupos identificables, fraude contra terceros identificables.
- **Uso del avatar del usuario:** permitido solo para el propio usuario (verificado con face/voice embedding del onboarding §1b) o personas que firmaron consentimiento verificable documentado.
- **Uso de voz clonada:** idem, con el mismo detector comparando contra voice embedding del onboarding.
- **Deepfakes de personas reales sin consentimiento (warning + opt-in, no bloqueo):** si el detector ve una cara o voz cuyo match coseno con el embedding del usuario es < 0.85, **el render se pausa antes de ejecutarse** y aparece modal:
  > "Detectamos una cara/voz que no coincide con la tuya. ¿Tienes autorización para usar la imagen/voz de esa persona?"
  Opciones:
  1. **"Tengo autorización firmada"** → se escribe `system_audit` entry: `{ type: 'third_party_likeness_consent_acknowledged', userId, contentHash, detectorScore, sessionId, ts, acknowledgedText }`. Usuario asume responsabilidad legal contractual según ToS. Se procede al render.
  2. **"Usar mi avatar Foco"** → pipeline re-enruta a render con avatar del usuario (mismo guion, mismo audio, cara/voz sustituida). Sin audit entry especial.
  3. **"Cancelar"** → no render. Audit entry: `{ type: 'third_party_likeness_canceled', ... }`.
- **Misinformation:** no moderamos opinión; sí bloqueamos falsedades específicas contra personas identificadas sin consentimiento (deepfake + narrativa falsa verificable). Cola de moderación humana.

### 9.2 Flujo

- Pre-generación: prompt classifier (lightweight LLM check) que rechaza intenciones claramente prohibidas (violencia contra menores, CSAM textual, etc.) antes de que el worker arranque.
- Face/voice detector sobre los inputs visuales y de audio (si hay face-cam o voz clonada). Dispara el modal de §9.1 cuando aplique.
- Post-generación, pre-publicación: scan de `ModerationScanner` obligatorio en cada render (CSAM hash + NSFW + categoría violencia).
- Reportes de usuarios: formulario `settings-privacy/report` → cola de moderación humana SLA 24h para sev-alto, 72h resto.
- DMCA: agente designado + formulario + takedown en 48h. Template en `/legal/dmca`.
- Bans: progresivos (warning → 7d → 30d → permanent), apelables a través de `settings/appeal`.

### 9.3 Transparencia

- Reporte semestral de moderación publicado (número de takedowns por categoría, países).
- Government requests reportados anualmente.

---

## 10 · Incident response

### 10.1 Severidades

| Sev | Impacto | Response | Ejemplos |
|---|---|---|---|
| **sev-1** | Servicio caído para >10% de usuarios, o breach de datos personales confirmado, o cualquier CSAM detectado | On-call pageado <5min, war room, status page actualizada, CEO notificado | DB corrupción, exfiltración, MCP exponiendo scopes no autorizados |
| **sev-2** | Degradación significativa, o breach probable pero no confirmado | On-call pageado <15min | Render workers caídos, AV service down |
| **sev-3** | Bug importante, workaround existe | Ticket prioritario, horario laboral | Publicación a TikTok fallando |
| **sev-4** | Bug menor | Backlog |

### 10.2 Playbooks

Runbook markdown en `foco/runbooks/` por cada tipo de incidente conocido. Mínimo al launch:
- Breach de datos (notificación 72h GDPR).
- DB down.
- AV service down (ingesta se detiene).
- Modal region down.
- OAuth de una red revoca masivamente.
- Rate limit en proveedor de LLM.
- CSAM detectado en generación.

### 10.3 Post-mortem

- Blameless, plantilla fija.
- Publicado internamente en 5 días hábiles; extracto público si el incidente afectó a usuarios.
- Action items trackeados con owner y fecha. No se cierra el post-mortem sin ellos.

### 10.4 Breach notification

- GDPR: 72h a la autoridad competente si hay riesgo para derechos de personas. Usuarios afectados notificados sin demora indebida.
- CCPA: notification sin demora.
- Ley 1581: a la SIC en 15 días hábiles.
- Plantillas preaprobadas en `foco/docs/breach-templates/`.

---

## 11 · Legal y documentación pública

- **Privacy Policy** (EN + ES) publicada antes del launch. Versionada; cambios materiales notificados a usuarios con 30 días de antelación.
- **Terms of Service** (EN + ES).
- **Data Processing Addendum** disponible para planes Business y Enterprise.
- **Acceptable Use Policy** alineada con §9.
- **Subprocessor list** pública y mantenida.
- **Security page** con resumen de controles + form de bug bounty.
- **Transparency page** con reporte de moderación y gov requests.
- **Status page** (Statuspage, Cachet o propia) con uptime de cada componente.

---

## 12 · SLOs / SLIs

### 12.1 Targets v1.0 (pueden ajustarse post-métricas reales)

| Servicio | SLI | SLO |
|---|---|---|
| Auth / API pública | Availability | 99.9% mensual |
| Auth / API pública | Latency p95 | < 300 ms |
| Auth / API pública | Error rate | < 0.1% |
| Ingesta | AV scan duration p95 | < 5s |
| Ingesta | End-to-end quarantine→main p95 | < 30s |
| Render worker | Job success rate | > 99% (MVP: 97%) |
| Render worker | Fase 1 duration p95 (3s video) | ≤ 30s |
| Render worker | Fase 2 duration p95 (cached) | ≤ 10s |
| MCP gateway | Availability | 99.9% |
| MCP gateway | Audit log write success | 100% (fail-closed) |
| Publish | Success rate (excluding platform rate limits) | > 97% |

### 12.2 Error budgets

- Budget = (1 − SLO) × periodo. Cuando se consume el 50%, freeze de features en el servicio; 100%, solo hotfixes hasta recuperación.

---

## 13 · Roadmap de certificaciones

| Certificación | Target | Por qué |
|---|---|---|
| **SOC 2 Type I** | +6 meses del launch | Unlock enterprise deals |
| **SOC 2 Type II** | +18 meses del launch | Maduración del control |
| **GDPR compliance statement** | Launch | Mercados EU desde día 1 |
| **ISO 27001** | +24 meses (opcional) | Europa, sector regulado |
| **HIPAA BAA** | Solo si verticalizamos a salud (no MVP) | N/A |
| **PCI DSS** | N/A | Delegamos a Stripe, no almacenamos cards |

---

## 14 · Checklist bloqueante pre-launch público

Marcar cada item con evidencia linkable antes del launch:

- [ ] Privacy Policy + ToS publicados (EN + ES), revisados por abogado.
- [ ] Flujo de "Eliminar mi cuenta" end-to-end probado con certificate de borrado funcional.
- [ ] Data export funcionando (ZIP con JSON + archivos + logs de actividad).
- [ ] MFA disponible, cookie consent banner funcionando.
- [ ] Audit log escribiendo con hash chain, job de verificación corriendo.
- [ ] Sentry + métricas + traces visibles en Grafana para auth, ingest, render, publish, MCP.
- [ ] Incident runbooks listados en §10.2, on-call rotation activa.
- [ ] Status page operativa.
- [ ] Backups verificados con restore drill.
- [ ] Pen test externo o al menos Snyk/ZAP full scan con hallazgos resueltos o waived con justificación.
- [ ] Subprocesadores listados públicamente.
- [ ] DPIAs firmadas para MCP, embeddings y avatar training.
- [ ] Content moderation (CSAM scan + deepfake detection) activas en pipeline de render.
- [ ] Cost circuit breakers activados.
- [ ] Error budgets configurados en dashboards.

---

## 15 · Decisiones firmadas (2026-04-17)

Jean firmó las 11 decisiones pendientes. Stack de producción v1.0:

1. **Observabilidad:** ✅ **Grafana Cloud free tier** (Loki + Mimir + Tempo gestionado). Trigger de migración a self-hosted: cuando el free tier nos limite o `data retention` necesite >30d hot. Exit plan documentado en §2.2.
2. **Error tracking:** ✅ **Sentry Cloud free** hasta volumen. Trigger de migración a self-hosted: >100k events/mes o requisito de residencia de datos EU. Source maps + symbols subidos en cada deploy.
3. **Paging / incident management:** ✅ **incident.io free tier**. Cubre on-call rotation, Slack-first, runbooks embebidos y auto-generación de post-mortems. Fallback a **Opsgenie** si al mes 6 no escala.
4. **Feature flags:** ✅ **GrowthBook self-hosted** (contenedor Modal + Postgres). OSS, simple, sin vendor lock-in. Schema de flags versionado en repo (`config/flags/`).
5. **Secrets manager:** ✅ **Doppler**. Integración nativa con Vercel, Modal, GitHub Actions. Rotation policy por secret. Acceso por role (dev / staging / prod) con audit log de Doppler.
6. **Audit log storage:** ✅ **Postgres `system_audit` + dump mensual a R2 Object Lock** (retención 7 años). Job dockerizado corre el 1º de cada mes, exporta `WHERE ts < now() - interval '30 days'`, firma el dump con cosign, escribe hash en `audit_dump_manifest`.
7. **Content moderation provider:** ✅ **Pipeline en 3 fases**:
   - **MVP:** OSS NSFW classifier (open_nsfw2, Hugging Face) + match contra **NCMEC hash list pública** (disponible sin aplicación formal).
   - **Mes 2-4:** aplicación a **PhotoDNA** (Microsoft, gratis para startups elegibles; proceso dura 2-4 meses).
   - **Año 1:** migrar a **Thorn Safer** como end-state (cobertura más amplia: CSAM + contenido violento + deepfakes conocidos).
   Abstracción detrás de interface `ModerationScanner.scan(bytes, type) → { verdict, categories, matches, engine, engineVersion }`.
8. **Deepfake policy:** ✅ **Warning + consentimiento explícito con alternativa avatar**. Detector compara face/voice embedding contra el registrado en onboarding. Si match < threshold (~0.85 coseno), antes del render aparece modal: "Detectamos una cara/voz que no coincide con la tuya. ¿Tienes autorización para usar la imagen/voz de esa persona?" con 3 opciones: `Tengo autorización firmada` (acknowledge + audit entry con timestamp, user_hash, content_hash, session_id; usuario asume responsabilidad contractual por ToS) / `Usar mi avatar Foco` (re-render con avatar del usuario) / `Cancelar`. Audit entry es prueba legal en caso de complaint. Ver §9.1 actualizado.
9. **Región primaria EU:** ✅ **Start US, código multi-region-ready**. Supabase EU no es gratis adicional; activación diferida hasta: (a) primer enterprise customer EU con contrato, o (b) >10% de tráfico mensual desde EU. **Requisito desde commit 1:** migraciones Postgres idempotentes y reproducibles, sin región hardcodeada; clave de cifrado por región; export/import cross-region probado en CI; DPA referencia "región del cliente donde aplique". Activación EU: provisionar segundo proyecto Supabase EU + R2 EU + update DNS latency-routing → operativo en <4h sin rewrite.
10. **Bug bounty:** ✅ **HackerOne público mes 6 post-launch**. Antes de eso: pen test externo al mes 3 (budget $8-15k), hallazgos resueltos o formally waived antes de abrir el programa al público. Scope inicial: web app + API + MCP gateway. Excluido inicialmente: infra interna, empleados, phishing social.
11. **Regulatory filings:** ✅ **UK ICO desde launch** (£40/año, trámite digital en 30 min). Postura preparada para CNIL (Francia), AEPD (España), y la DPA holandesa (fácil desde Supabase EU cuando se active). SIC Colombia registro cuando abramos operación comercial doméstica. Data Processing Agreement template pública en `/legal/dpa` en launch.

**Puntos 3 y 7 fueron elegidos por mí bajo mandato "lo que consideres" — revisables si cambian las prioridades, pero activos desde hoy.**

---

## 16 · Relación con otros documentos

- `UX_FROZEN.md` define **qué ve** el usuario; este documento define **qué garantiza** el sistema detrás.
- `INGEST_SECURITY.md` define el pipeline de entrada; este documento lo extiende al resto del sistema.
- Cambios a cualquiera de los tres pueden requerir actualizar los otros — el commit debe tocar los tres si es el caso.
