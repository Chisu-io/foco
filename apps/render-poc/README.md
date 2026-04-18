# @foco/render-poc

**Proof-of-concept render pipeline** para Foco: toma un `RenderRequest` (contrato `@chisu/schemas`) y produce un MP4 de 3 segundos con cara frontal + captions word-level, en los tres aspect ratios del MVP (9:16 / 1:1 / 16:9).

Este POC cumple **Step 4** del orden técnico en `docs/UX_FROZEN.md` §6.

## Qué prueba este POC

1. El contrato `RenderRequest` (§5.1 de UX_FROZEN) se puede consumir end-to-end sin ambigüedad.
2. El bridge `RenderRequest → RevideoProjectVariables` es puro y testeable sin browser.
3. El motor de render (Revideo) acepta nuestro schema y produce MP4s válidos en los tres aspect ratios que el MVP soporta.
4. Las captions word-level con highlighting (estilo viral TikTok) son factibles con la timeline del schema (`CaptionWord { word, tStart, tEnd }`).

## Estructura

```
apps/render-poc/
├── fixtures/
│   └── face-cam-captions.json   # RenderRequest de ejemplo, validado al cargar
├── src/
│   ├── aspect.ts                # aspect ratio → resolution (solo aquí se habla de pixeles)
│   ├── bridge.ts                # RenderRequest → RevideoProjectVariables (puro)
│   ├── fixture.ts               # carga + valida el JSON fixture contra zod
│   ├── project.ts               # Revideo makeProject wrapper
│   ├── render.ts                # CLI: fixture → 3 MP4s en out/
│   ├── scenes/
│   │   └── face-cam-captions.tsx  # Revideo scene (face-cam + captions word-level)
│   └── index.ts                 # exports públicos (bridge reusable)
└── test/
    └── bridge.test.ts           # tests puros del bridge (sin browser)
```

## Correr los tests del bridge (sin browser)

```bash
pnpm --filter @foco/render-poc install   # primera vez desde el root
pnpm --filter @foco/render-poc test
pnpm --filter @foco/render-poc typecheck
```

Esto no requiere Chrome/Puppeteer. Es lo que corre en CI.

## Renderizar los MP4s (requiere browser)

Revideo usa Puppeteer internamente. En tu PC:

```bash
pnpm --filter @foco/render-poc render                    # 9:16, 1:1, 16:9
pnpm --filter @foco/render-poc render -- --aspect 9:16   # solo uno
```

Salidas en `apps/render-poc/out/foco-poc-{9x16,1x1,16x9}.mp4`.

> **Nota:** `sourceUri` en `fixtures/face-cam-captions.json` apunta a `https://cdn.foco.chisu.io/poc/face-cam-sample.mp4`. Reemplaza por una URL válida (o un path local `file://`) antes del primer render. Cualquier MP4 de 3+ segundos sirve.

## Qué queda fuera del POC

- Layers `avatar`, `overlay` y `bgMusic` (contract-valid pero no implementados en el scene del POC — el bridge los rechaza con error explícito).
- Multi-scene (el POC asume 1 escena).
- Cache por escena/layer (ver `Scene.cacheKey` en el schema — es infraestructura del `render-worker` real).
- Audio mixing (el POC toma el audio del face-cam sin mezclar).

Todo esto se retoma en `workers/render-worker/` cuando empiece el Step 5.

## Contratos que este POC honra

| Contrato                              | Dónde                                                               |
|---------------------------------------|---------------------------------------------------------------------|
| UX_FROZEN v1.3 §5.1 `RenderRequest`   | `fixtures/face-cam-captions.json`, validado al cargar               |
| UX_FROZEN v1.3 §5.1 aspect ratios     | `src/aspect.ts` (9:16 / 1:1 / 16:9, 1080p MVP)                      |
| UX_FROZEN v1.3 §5.1 captions          | `CaptionWord { word, tStart, tEnd }` → scene word-level con kinetic |
| UX_FROZEN v1.3 §6 step 4              | POC render en los 3 ratios — este paquete                           |
