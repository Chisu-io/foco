# Foco
> AI-powered short-form video production. From recording to published in minutes.

**Product**: [foco.chisu.io](https://foco.chisu.io)
**Company**: [Chisu](https://chisu.io)
**Status**: Pre-alpha. Built in public.

## What is this

Foco turns your raw recordings (face-cam, or photos + audio for an avatar) into polished vertical shorts (9:16, 1080×1920), with automatic subtitles, music, brand consistency, and direct publishing to TikTok, Instagram, LinkedIn, YouTube Shorts, and X.

The target user is anyone — from a founder shipping a product to a grandparent sharing a recipe. Zero jargon, mobile-first, accessible by default.

## Architecture

This is a pnpm + Turborepo monorepo with a dual-license model.

### Public packages (Apache 2.0)

| Package                                                  | Purpose                                                            |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| [`@chisu/render-engine`](./packages/render-engine)       | Revideo-based programmatic video composition primitives            |
| [`@chisu/captions`](./packages/captions)                 | SRT/ASS generation and styling from WhisperX word-level timestamps |
| [`@chisu/media-primitives`](./packages/media-primitives) | FFmpeg utilities, codec profiles, color pipelines                  |

### Proprietary packages

| Package               | Purpose                                                                                       |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `@chisu/brand-engine` | Brand tokens, template registry, style enforcement                                            |
| `@chisu/agent`        | Claude Agent SDK orchestration — script writer, caption polish, music curator, brand enforcer |
| `@chisu/publisher`    | Direct OAuth integrations with TikTok, Meta, LinkedIn, YouTube, X                             |

### Applications

| App           | Purpose                                         |
| ------------- | ----------------------------------------------- |
| `apps/web`    | Next.js 15 dashboard + landing page             |
| `apps/worker` | Modal GPU jobs (TTS, face animation, music gen) |

## Tech stack

- **Language**: TypeScript 6 (strict mode everywhere)
- **Runtime**: Node.js 24 LTS
- **Monorepo**: pnpm 10 workspaces + Turborepo 2
- **Frontend**: Next.js 15 + Tailwind CSS + shadcn/ui
- **Backend**: Next.js API routes + Supabase (Postgres, Auth, Storage)
- **Render**: Revideo (MIT)
- **Post-processing**: FFmpeg
- **GPU inference**: Modal (TTS, face animation, music)
- **Workflows**: Inngest (durable, free tier)
- **Payments**: Stripe (Billing Portal)
- **Email**: Resend
- **Observability**: Sentry + PostHog + structured logging (pino)
- **Testing**: Vitest
- **CI**: GitHub Actions

## AI models (all open source)

| Task                                | Model                                        | License            |
| ----------------------------------- | -------------------------------------------- | ------------------ |
| TTS                                 | Kokoro-82M                                   | Apache 2.0         |
| Voice cloning                       | XTTS v2 (Coqui)                              | MPL 2.0            |
| Speech recognition + word alignment | WhisperX                                     | MIT                |
| Face animation                      | LivePortrait (primary), SadTalker (fallback) | MIT / Apache 2.0   |
| Music generation                    | ACE-STEP 1.5 (primary), MusicGen (fallback)  | Apache 2.0 / MIT   |
| Video segmentation                  | SAM 2 (Meta)                                 | Apache 2.0         |
| Video inpainting                    | ProPainter + LaMa                            | S-Lab / Apache 2.0 |
| Background removal                  | RMBG-2.0                                     | Apache 2.0         |

## Getting started

> Pre-alpha. This section will be expanded as development progresses.

```bash
# Prerequisites: Node 24+, pnpm 10+, FFmpeg in PATH
pnpm install
pnpm build
pnpm test
```

## Quality standards

This repo holds itself to production quality from the first commit:

- TypeScript strict mode — no `any` without justification
- Vitest coverage target ≥80% on public packages
- ESLint + Prettier + Husky pre-commit hooks
- GitHub Actions CI: lint + typecheck + test + build on every PR
- WCAG 2.1 AA compliance on all UI
- Semantic versioning via changesets on public packages
- Structured logging, no `console.log` in production paths
- Zero secrets in repo — all configuration via environment variables

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full contributor guide.

## License

This repository uses a **dual-license** model:

- Public packages (`@chisu/render-engine`, `@chisu/captions`, `@chisu/media-primitives`): [Apache License 2.0](./LICENSE-APACHE-2.0)
- Proprietary packages (`@chisu/brand-engine`, `@chisu/agent`, `@chisu/publisher`) and applications: [proprietary](./LICENSE-PROPRIETARY), all rights reserved by Chisu.

Each package declares its license explicitly in its `package.json`.

## Built in public

The construction of this product is documented episode-by-episode. Follow along:

- Series: `MyAdds/_series/building_foco/` (internal — will be published)
- Channels: TikTok, Instagram, LinkedIn, X, YouTube Shorts
