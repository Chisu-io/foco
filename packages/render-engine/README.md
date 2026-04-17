# @chisu/render-engine

> Revideo-based programmatic video composition primitives for vertical short-form video.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE-APACHE-2.0)

## Status

🟡 **Pre-alpha.** API is unstable. Do not use in production yet.

## Purpose

`@chisu/render-engine` is a thin, opinionated layer on top of [Revideo](https://re.video) that encodes the specific constraints of 9:16 short-form video:

- **Canvas**: 1080×1920 at 30 fps, H.264 High profile, 8 Mbps target bitrate
- **Loudness**: -16 LUFS integrated, -1 dBTP peak (TikTok/Instagram spec)
- **Color**: BT.709 Limited, `yuv420p` chroma
- **Safe areas**: Platform-aware top/bottom reserves (TikTok 220px top / 360px bottom, etc.)
- **Subtitle rendering**: libass-compatible ASS styling with consistent word-level timing

## Why

Every short-form platform has implicit visual contracts that will get your post down-ranked if you violate them. This package encodes them as reusable primitives so that consumers don't have to rediscover the hard lessons.

## Install

```bash
pnpm add @chisu/render-engine
```

Peer dependencies: `@revideo/core`, `@revideo/2d`, `@revideo/player-react`.

## Usage

```ts
// Example usage will be documented when the public API stabilizes.
```

## License

Apache 2.0. See [LICENSE-APACHE-2.0](../../LICENSE-APACHE-2.0) in the repository root.
