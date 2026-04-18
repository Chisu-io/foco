# Prompt para segundo peer review — LLM_CLIENT v0.2

> **Uso**: copiar todo el bloque del prompt (desde "ROL:" hasta el
> final) y pegarlo en la AI externa (ChatGPT / Gemini / Claude web
> / etc.) **junto con el contenido completo de `docs/LLM_CLIENT.md`
> v0.2** (aproximadamente 550 líneas). La AI ya tiene el doc en
> contexto; el prompt le acota el scope y le pide formato concreto
> de respuesta.

---

## Prompt a copiar

ROL: Eres un senior security / distributed systems engineer revisando
un contrato técnico de ingeniería para un producto SaaS de video-
generación con IA (Foco, de Chisu). El producto está en fase de specs
firmados — este documento, LLM_CLIENT.md, será el cuarto contrato
ancla tras UX_FROZEN, INGEST_SECURITY, y PRODUCTION_READINESS, que ya
están firmados y son invariantes.

CONTEXTO DEL DOCUMENTO:
- LLM_CLIENT.md especifica el paquete @chisu/llm-client: punto único
  de entrada de Foco a APIs generativas de LLM (Anthropic Messages,
  OpenAI Chat Completions).
- Es plan-aware: Free/Creator usan key del usuario (BYOK obligatorio)
  y Influencer+ usan pool de Foco (Managed, con fallback opcional a
  BYOK del usuario via toggle "preferMyKey").
- Usa envelope encryption (KEK en AWS KMS + DEK por key BYOK con
  AES-256-GCM) para que ni DevOps de Foco pueda leer la key del
  usuario en claro post-save.
- Integra con Postgres audit hash chain, OpenTelemetry (Grafana Cloud
  Tempo/Loki/Mimir), Doppler (secrets pool), GrowthBook (flags).

SCOPE DE ESTE PEER REVIEW — crítico respetar:
Este es el SEGUNDO peer review. El primero (realizado previamente)
produjo 6 cambios que son lo único que debes evaluar en esta pasada:

  1. KEK por shard de ~1.000 usuarios (no por usuario individual).
     KMS vendor cerrado = AWS KMS. Ver §5.1 ("Modelo criptográfico")
     y §5.2 ("KMS selection") con tabla de costo.
  2. Fail-closed con retry acotado: 1 retry con jitter 50–250ms ante
     kms_unavailable { transient: true }; fail-closed en
     transient: false. Métrica llm_kms_induced_failures_total
     separada. Ver §2 inv. 5, §4.3 (retries), §7.1 (mapeo de
     errores), §10.2 (métricas), §13.2 (failure modes).
  3. Cache in-process de DEK permitido con TTL ≤5min, zeroize al
     eviction, per-worker, threat model explícito. Reemplaza "zero
     caching" de v0.1. Ver §2 inv. 8 y §5.1 flujo de lectura de key.
  4. Idempotency semantics: garantiza no-duplicación de side-effects
     pero NO determinismo textual del output. Ver §4.3.
  5. Token accounting BYOK: nueva intro de §8 explicita las 3
     razones (UI de uso, detección de abuso, analytics) y consent
     informado en Privacy Policy + settings-integraciones.
  6. Circuit breaker + retry thresholds migran de hardcoded a
     feature flags en GrowthBook (13 flags con defaults
     conservadores). Ver §16 nueva tabla de flags.

NO debes reabrir temas que el primer peer review ya cerró (el
vendor KMS, la existencia del cache, la forma básica del envelope
encryption). Si detectas algo crítico que afecta lo que YA estaba
firmado, márcalo como "fuera de scope de v0.2 pero crítico" y nos
abrimos un issue — pero no uses el slot principal del review para
revolver decisiones cerradas.

CRITERIOS DE EVALUACIÓN (aplicar sobre cada uno de los 6 cambios):

  A. **Ejecución**: ¿el cambio está bien implementado técnicamente?
     ¿la especificación es precisa y no ambigua? ¿hay edge cases
     no considerados?
  B. **Consistencia**: ¿el cambio crea inconsistencias con otras
     partes del doc (§3 interface, §4 routing, §7 errores, §10
     observability, §13 SLOs, §14 testing)?
  C. **Completitud**: ¿falta algo para que el cambio sea accionable
     en implementación (ej. un error kind nuevo, una métrica, un
     test CI, un flag, un campo en SystemAuditEntry)?
  D. **Efectos secundarios**: ¿qué rompe este cambio que antes
     funcionaba? ¿qué nuevos riesgos operativos introduce?
  E. **Seguridad / Privacy**: ¿el cambio abre alguna superficie
     nueva (exfil de keys, leak en logs, timing attack, side-channel)?

FORMATO DE RESPUESTA REQUERIDO:

Para cada uno de los 6 cambios, responde con la siguiente
estructura (Markdown, sin emojis):

  ### Cambio N — <título>

  **Veredicto**: [Aprobado / Aprobado con ajustes / Requiere
  reescritura]

  **A — Ejecución**: <crítica concreta sobre la ejecución técnica
  del cambio. Si hay edge cases faltantes, enumerarlos>

  **B — Consistencia**: <inconsistencias detectadas con otras
  secciones, citar §X.Y>

  **C — Completitud**: <qué falta para que el cambio sea
  implementable sin ambigüedad>

  **D — Efectos secundarios**: <riesgos operativos nuevos, cosas
  que antes estaban implícitas y ahora quedaron sueltas>

  **E — Seguridad / Privacy**: <vectores nuevos; si no aplica,
  decir "no aplica">

  **Acción sugerida concreta**: <qué editar en el doc. Si ninguna,
  "ninguna, listo para firma">

Al final, **ÚNICA sección adicional**:

  ### Recomendación global

  ¿Puede v0.2 promoverse a v1.0 y firmarse tal cual, o requiere
  v0.3 con ajustes antes de firma?

  - Si "firma directa": justificar que los 6 cambios están completos.
  - Si "requiere v0.3": listar los cambios mínimos necesarios,
    priorizados (crítico > importante > nice-to-have).

RESTRICCIONES:
- Sé técnicamente específico. "Esto podría fallar" sin caso concreto
  no aporta. "Si el worker recibe KMSRegionFailure durante la
  ventana de half-open del circuit breaker, el retry del punto 2
  amplifica la presión sobre una región degradada" sí aporta.
- No sugieras "considera añadir tests" como única acción — los tests
  ya están en §14. Sugiere test específico con caso y aserción si
  detectas gap.
- Si un cambio te parece bien, dilo claramente con "Aprobado". No
  tengas bias a encontrar algo siempre.

DOCUMENTO A REVISAR: (pegar aquí el contenido completo de
docs/LLM_CLIENT.md v0.2)

---

## Cómo proceder cuando llegue la respuesta

1. **Si el veredicto global es "firma directa"** (ningún cambio
   crítico): Jean firma en frontmatter `status: SIGNED v1.0` + fecha
   + reviewer, y se hace `docs(contract): sign LLM_CLIENT v1.0`.
   Implementación de `packages/llm-client/` puede arrancar.
2. **Si el veredicto es "requiere v0.3"**: aplicamos los ajustes
   mínimos críticos, commit `docs(contract): revise LLM_CLIENT.md
   to v0.3 post second peer review`, y opcionalmente una tercera
   pasada antes de firma (solo si los ajustes tocan áreas nuevas).
3. **Si el review reabre decisiones ya cerradas** (ej. "reconsidera
   AWS KMS vs Vault"): Jean decide si acepta la apertura o no. Si
   acepta, v0.3 reopens scope; si no, se documenta la discrepancia
   en §16 y se firma v1.0 con la nota.
