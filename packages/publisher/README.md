# @chisu/publisher

> Direct OAuth integrations with TikTok, Meta, LinkedIn, YouTube, and X for publishing.

**⚠️ Proprietary — not open source.** See [LICENSE-PROPRIETARY](../../LICENSE-PROPRIETARY).

## Status

🟡 **Pre-alpha.** Internal to Chisu.

## Purpose

Reliable, user-friendly publishing across every major short-form platform. The "viejito/niño" user should only ever see "Connect TikTok" and "Publish" — this package handles everything underneath.

Responsibilities per platform:

| Platform             | API                 | Scope                                             |
| -------------------- | ------------------- | ------------------------------------------------- |
| TikTok               | Content Posting API | `video.upload` + `video.publish`                  |
| Instagram / Facebook | Meta Graph API      | `instagram_content_publish`, `pages_manage_posts` |
| LinkedIn             | Share API v2        | `w_member_social`                                 |
| YouTube Shorts       | YouTube Data API v3 | `youtube.upload`                                  |
| X                    | v2 API              | `tweet.write`, `media.write`                      |

Cross-cutting features:

- **Encrypted token storage** via Supabase Vault (AES-256)
- **Automatic refresh token rotation** with lead-time refresh (5 days before expiry)
- **Rate limit handling** with per-platform backoff policies
- **Scheduled publishing** via Inngest durable jobs
- **Idempotency keys** to prevent duplicate posts on retry

## UX contract

This package must make publishing feel like one button. Non-negotiable:

- One-time OAuth connect per platform
- Never surface platform-specific errors raw; translate to human-friendly messages
- Preflight checks (duration, aspect ratio, caption length) before submit, with actionable fixes

## Why proprietary

Publishing is a compliance-sensitive surface (platform ToS, data handling, rate limit strategy). It is not licensed for redistribution.

## License

Proprietary. Copyright © 2026 Chisu. See [LICENSE-PROPRIETARY](../../LICENSE-PROPRIETARY).
