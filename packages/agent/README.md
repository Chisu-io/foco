# @chisu/agent

> Claude Agent SDK orchestration layer for Foco.

**⚠️ Proprietary — not open source.** See [LICENSE-PROPRIETARY](../../LICENSE-PROPRIETARY).

## Status

🟡 **Pre-alpha.** Internal to Chisu.

## Purpose

The agent package wraps the [Claude Agent SDK](https://docs.claude.com) with Foco-specific tools, prompts, skills, and orchestration. It is the "brain" that decides what to do with a user's raw recording.

Responsibilities:

- **Tool surface**: exposed tools for the agent (transcribe, caption, music-match, face-animate, brand-check, publish)
- **Skill loading**: Anthropic design skills + Foco-specific skills for script editing, caption polish, brand enforcement
- **Workflow orchestration**: durable workflows via Inngest, with retry, idempotency, and partial-progress resumption
- **BYOK support**: per-request Anthropic API key resolution from user settings or managed billing
- **Cost accounting**: token and GPU-second attribution per render job for billing

## Why proprietary

The agent encodes the product's core intelligence — the prompts, the tool contracts, the skill compositions, the fallback policies. It is not licensed for redistribution.

## License

Proprietary. Copyright © 2026 Chisu. See [LICENSE-PROPRIETARY](../../LICENSE-PROPRIETARY).
