# rtk pipeline · rtk:proxy

**34% of command output removed** — self-reported by the author's own rtk, measured on their traffic. rtk verifies nothing.

## Install

```
rtk pipeline add github:someone/rtk-pipeline-rtk-proxy
```

## What it does

- **before shell** — rewrite -> rtk

## Measured impact

| lever | activity | reduction |
|-------|----------|-----------|
| command filtering (rtk git/npm/…) | 1,172 commands | `███░░░░░░░` **34%** removed |
| delegated reads (`bulk-read`) | 10 reads | **102.1K** kept out of context |
| prompt-cache hit rate | 3751 requests | `██████████` **98%** cached |
| something the author typed | 5 things | **9999%** removed |

_Estimates (≈ bytes/4): ratios reliable, absolutes approximate._

## user pipeline.toml

```toml
schema_version = 1

[pipeline]
extends = "rtk:proxy"
```

Measured by [rtk](https://github.com/rtk-ai/rtk) v1.0.0 on 2026-10-14.
