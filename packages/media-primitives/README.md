# @chisu/media-primitives

> FFmpeg utilities, codec profiles, and color pipelines for short-form vertical video.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](../../LICENSE-APACHE-2.0)

## Status

🟡 **Pre-alpha.** API is unstable. Do not use in production yet.

## Purpose

Low-level, composable FFmpeg operations tuned for social short-form video:

- **Codec profiles**: H.264 High @ 1080×1920 / 30fps / 8 Mbps, H.265 variants, AV1 experimental
- **Audio pipeline**: `loudnorm` two-pass to -16 LUFS / -1 dBTP / 11 LU, with pass-through when already compliant
- **Color pipeline**: BT.709 Limited + `yuv420p`, with explicit `-colorspace`, `-color_primaries`, `-color_trc` tagging
- **Windows/MSYS path handling**: `cygpath -m` helpers for filtergraph paths on Windows
- **Concat utilities**: Demuxer-based concat with automatic `concat.txt` generation
- **Probe utilities**: Typed wrappers around `ffprobe` with cached invocations

## Why

FFmpeg is the most capable media tool ever built, and also the easiest to misuse. This package encodes the exact flags and pipeline shapes that pass platform ingest checks, so callers don't have to study the `ffmpeg -filters` output at 2 AM.

## Install

```bash
pnpm add @chisu/media-primitives
```

System dependency: `ffmpeg ≥ 6` must be on `PATH`.

## License

Apache 2.0. See [LICENSE-APACHE-2.0](../../LICENSE-APACHE-2.0) in the repository root.
