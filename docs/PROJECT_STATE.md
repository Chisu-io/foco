# Foco — Project State

> **Purpose:** Single source of truth about "where we are" so any new conversation (human or AI) can get up to speed in under 2 minutes.
> **Owner:** Jean (Chisu). **Updated:** 2026-04-17.

## What Foco is

AI-powered short-form vertical-video studio. Hybrid face-cam + avatar (from user photos/videos) with programmatic element editing. Goal: anyone ("viejito/niño") can make platform-ready shorts.

- Domain: `foco.chisu.io`
- Dual-license: **Apache 2.0** (render-engine, captions, media-primitives) + **Proprietary** (brand-engine, agent, publisher, apps)
- BYOK model: user brings Anthropic API key, or pays us (managed)
- Direct OAuth publishing to TikTok, Meta, LinkedIn, YouTube, X — no third-party scheduler

## Tech stack (2026)

| Layer           | Choice                              |
| --------------- | ----------------------------------- |
| Package manager | pnpm 10.33 + Turborepo 2.9          |
| Runtime         | Node.js 24 LTS                      |
| Language        | TypeScript 6 strict (all flags)     |
| Video engine    | Revideo (MIT fork of Motion Canvas) |
| Agent           | Claude Agent SDK                    |
| DB / Auth       | Supabase                            |
| Storage         | Cloudflare R2                       |
| Compute         | Modal (GPU for AI models)           |
| Workflows       | Inngest (free tier)                 |
| Billing         | Stripe + Customer Portal            |
| Hosting         | Vercel                              |
| AI: TTS         | Kokoro-82M + XTTS v2                |
| AI: ASR         | WhisperX (word-level timestamps)    |
| AI: Avatar      | LivePortrait + SadTalker            |
| AI: Music       | ACE-STEP 1.5 + MusicGen             |
| AI: Matting     | SAM 2 + RMBG-2.0                    |
| AI: Inpaint     | ProPainter + LaMa                   |

## Monorepo layout

```
foco/
├── packages/
│   ├── render-engine/     [Apache 2.0] — Revideo primitives, 9:16 vertical
│   ├── captions/          [Apache 2.0] — SRT/ASS from WhisperX
│   ├── media-primitives/  [Apache 2.0] — FFmpeg utilities, codec profiles
│   ├── brand-engine/      [Proprietary] — brand tokens, template registry
│   ├── agent/             [Proprietary] — Claude Agent SDK orchestration
│   └── publisher/         [Proprietary] — OAuth to TikTok/Meta/LI/YT/X
├── apps/                  (not created yet — web + studio UI)
├── docs/
│   └── PROJECT_STATE.md   (this file)
└── .github/workflows/ci.yml
```

## Quality bar (non-negotiable)

Set in `memory/feedback_foco_quality.md`. Highlights:

- TypeScript strict with `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`
- Vitest coverage ≥80% on public packages
- ESLint + Prettier + Husky + lint-staged
- CI green required to merge: format + lint + typecheck + test + build
- Changesets for versioning (Apache packages will publish to npm)
- a11y audits on UI (WCAG 2.1 AA)

## Current status

- [x] Monorepo scaffolded, 6 packages stubbed
- [x] CI pipeline defined (Node 24, pnpm 10)
- [x] Dual-license files in place
- [x] `pnpm install` clean, `pnpm audit` 0 vulnerabilities
- [x] `git init` done (pending: first commit + push)
- [ ] First commit + GitHub repo `chisu-io/foco` public
- [ ] ESLint flat config
- [ ] First module: port `_pipeline/` utilities → `@chisu/media-primitives`
- [ ] `foco.chisu.io` DNS → Vercel landing
- [ ] Episode 01 recorded

## Content series: "Building Foco in Public"

Roadmap and scripts in `../_series/building_foco/` (outside the repo). 12 episodes, ~10-12 weeks, targeting public beta late June 2026.

## How to resume work with an AI agent

If you (or a future Claude) are starting fresh:

1. Read this file.
2. Read `memory/MEMORY.md` in the agent's memory directory — it indexes all persistent context.
3. Read `../_series/building_foco/README.md` for the content roadmap.
4. Check `git log --oneline -20` for recent activity.
5. Run `pnpm -r list --depth -1` to confirm workspaces are healthy.

## Decision log (the "why" behind the choices)

- **Revideo over Remotion** — MIT vs fair-code; want OSS-compatible core.
- **Direct OAuth over Upload-Post/Late** — cost (free) + full control + moat.
- **BYOK** — users scared of LLM costs; we charge for managed convenience.
- **Stripe over Lemon Squeezy** — Chisu is already on Stripe; Billing Portal handles subs.
- **Inngest over Trigger.dev** — 50K steps/mo free tier covers early beta easily.
- **Modal over Replicate** — pay-per-second GPU, cold starts manageable, Python-native for AI models.
- **Node 24 over 22** — 22 is maintenance LTS in Apr 2026, 24 is active LTS.
- **TypeScript 6 over 5** — released Q1 2026, strict-mode improvements worth the migration cost at day 0.
