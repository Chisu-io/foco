# Contributing to Foco

Thanks for your interest in Foco. This document covers how to set up the project locally, the quality bar we hold, and the contribution workflow.

## Scope of contribution

Only the following packages accept external contributions:

- `@chisu/render-engine`
- `@chisu/captions`
- `@chisu/media-primitives`

All three are licensed under Apache 2.0. By submitting a PR you agree your contribution is licensed under Apache 2.0.

Proprietary packages (`@chisu/brand-engine`, `@chisu/agent`, `@chisu/publisher`, `apps/*`) do not accept external contributions. Bug reports and security disclosures on these components are welcome via `security@chisu.io`.

## Prerequisites

- Node.js ≥ 24 (active LTS)
- pnpm ≥ 10
- FFmpeg ≥ 6 in PATH
- Git ≥ 2.40

We recommend using [Volta](https://volta.sh) or `.nvmrc` + nvm for Node version management.

## Setup

```bash
git clone https://github.com/chisu-io/foco.git
cd foco
pnpm install
pnpm build
pnpm test
```

## Working on a package

```bash
# Start a package in dev mode
pnpm --filter @chisu/render-engine dev

# Run its tests in watch mode
pnpm --filter @chisu/render-engine test:watch

# Typecheck
pnpm --filter @chisu/render-engine typecheck
```

## Quality bar

Every PR must pass the following before merge:

1. `pnpm lint` — zero errors, zero warnings in changed files
2. `pnpm typecheck` — TypeScript strict mode, no `@ts-ignore` without justification
3. `pnpm test` — all tests pass, coverage does not regress below 80% on public packages
4. `pnpm build` — all packages build cleanly
5. `pnpm format:check` — Prettier formatting verified
6. Changeset committed if any public package API changed (`pnpm changeset`)

CI runs all of these on every PR via GitHub Actions.

## Code style

- TypeScript strict mode. No `any` without a comment justifying it.
- Errors are typed. Prefer custom Error classes or Result types over `throw new Error("...")`.
- Structured logging with `pino`. Never `console.log` in production code paths.
- No `console.log` in committed code — use the logger.
- Imports: use `type` imports where possible (`import type { Foo } from '...'`).
- File names: `kebab-case.ts`, class names: `PascalCase`, variables: `camelCase`.
- One default export per file when it improves clarity; named exports otherwise.

## Commit messages

Follow [Conventional Commits](https://www.conventionalcommits.org):

```
feat(render-engine): add support for vertical 1080x1920 templates
fix(captions): correct SRT parsing when last line has no trailing newline
docs(readme): document FFmpeg version requirement
chore(deps): bump revideo to 1.2.0
```

Scope is the package name without the `@chisu/` prefix, or `repo` for root-level changes.

## Pull request workflow

1. Fork and create a branch: `git checkout -b feat/your-feature`
2. Make your changes, add tests, update docs
3. Run `pnpm changeset` if you touched a public package's API
4. Commit using Conventional Commits
5. Push and open a PR against `main`
6. Ensure CI passes
7. Request review; address feedback; squash-merge after approval

## Security

Do not open public issues for security vulnerabilities. Email `security@chisu.io` with details. We aim to respond within 48 hours.

## License

By contributing to the Apache 2.0-licensed packages, you agree that your contributions will be licensed under the Apache License 2.0. See [LICENSE-APACHE-2.0](./LICENSE-APACHE-2.0).
