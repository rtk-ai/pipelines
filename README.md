# rtk-ai/pipelines — the reviewed allowlist behind rtk-ai.app/pipelines

Community RTK pipelines are published by their authors with `rtk pipeline share publish`
(a public repo with `pipeline.toml` and the `rtk-pipeline` topic). This repository decides
which of those commits are **listed** on https://www.rtk-ai.app/pipelines/.

There is no backend. GitHub holds every piece of state:

| What | Where |
|---|---|
| The pipeline itself | the author's repo, pinned by commit (`rtk pipeline add github:o/r@<sha>`) |
| Votes / remixes | stars / forks on the author's repo |
| Discussion | one Discussion thread per pipeline, here |
| The allowlist | `approved/<owner>/<repo>/<sha>/` on `main`, merged by a maintainer |
| Bot memory | branch `state` (`state/seen.json`, `state/approvals.json`) |

**A maintainer merging a review PR is the only way a pipeline gets listed.** Branch rules on
`main` require a code-owner review and the `validate-pr` check; the bot has no bypass.

## Flow

```
author: rtk pipeline share publish ──▶ github.com/<owner>/rtk-pipeline-<name>  (topic rtk-pipeline)
                                            │  crawl.yml, every 6 h
                                            ▼
                      scripts/crawl.mjs: fetch pipeline.toml at the default-branch commit
                      scripts/precheck.mjs: stock rtk `pipeline add --shadow` in a throwaway HOME
                                          + structural analysis (analyze.mjs)
                           ├─ refused ──▶ state/seen.json (never re-opened for that commit)
                           └─ else ─────▶ PR "review: <owner>/<repo> @ <sha7>"  labels: candidate + pre-checked|needs-reading
                                            │  validate-pr.yml: snapshot byte-identical upstream, precheck re-run, schemas
                                            │  a maintainer reads the PR body (rtk's disclosure, every text block, egress table) and merges
                                            ▼
                      on-merge.yml: Discussion thread, state/approvals.json, Discord, repository_dispatch → rtk-ldp rebuilds the site
```

## What the bot refuses outright (no PR)

| code | why |
|---|---|
| `rtk_refused` | the pinned `rtk pipeline add` exits non-zero: validation errors, `api_key_command`, no name |
| `file_directive` | `[[directive]] file = …` can read any file on the installer's disk |
| `key_command` / `secret_literal` / `secret_shape` | credential commands, inline keys, key-looking strings |
| `plugins_missing` | a method rtk does not have = third-party native code |
| `hidden_unicode` | zero-width / bidi / control characters |
| `reserved_name` | `official`, `rtk`, `claude`, … (see `reserved.toml`), unless published by rtk-ai |
| `text_over_cap` / `text_total_over_cap` | 1 500 chars per text block, 4 000 total |
| `too_large` / `parse_error` | > 64 KB, or not TOML |

Everything else becomes a PR. **Tiers**: `safe` (transform-only), `structural` (routes, denies,
upstreams, control overrides), `text` (author text reaches your agent or a worker model).
**Labels**: `pre-checked` (safe/structural, provider-default or loopback egress, canonical env vars)
or `needs-reading` (anything with text blocks, custom `base_url`, non-canonical `api_key_env`,
control overrides, warnings).

## Numbers shown next to a pipeline

The site shows a result slot for every listed pipeline, labelled by where the number comes from:

| label on the site | source | produced by |
|---|---|---|
| Measured by RTK | `corpus/` + `rtk pipeline bench` in our CI (phase 2, empty for now) | us |
| Author's benchmark | `benchmark.toml` in the author's repo, read at the same commit as `pipeline.toml` | the author, an A/B run |
| Author's own usage | the "Measured impact" table that `rtk pipeline share publish` writes into README.md | the author's rtk |
| Not measured yet | none of the above | — |

The bot checks shape and bounds only (finite numbers, string caps, at most 50 tasks, repo-relative
paths, no hidden unicode), stores the normalized objects in `report.json` (`benchmark`,
`self_reported`) and snapshots `benchmark.toml` byte-identical next to `pipeline.toml`.
Percentages are always recomputed from the two raw values. Author text is capped and rendered as
text. An invalid `benchmark.toml` is ignored with a note in the PR body; it never blocks the pipeline.
`validate-pr` re-checks the snapshot against upstream and against `report.benchmark`.

### `benchmark.toml` (authors)

```toml
schema_version = 1

[benchmark]
suite          = "SkillsBench"            # required: what you ran
agent          = "Claude Code"            # optional
model          = "claude-opus-5-5"        # optional
baseline       = "stock Claude Code"      # the arm without this pipeline
trials_per_arm = 48
dates          = ["2026-10-18", "2026-10-19"]
details        = "RESULTS.md"             # files in this repo, linked at the reviewed commit
raw            = "results.tsv"
notes          = "..."                    # at most 400 chars, shown as your note

[benchmark.cost]                          # required: mean cost per trial, USD
baseline = 3.587
pipeline = 3.088
per      = "trial"                        # trial | task | session | ...

[benchmark.quality]                       # optional, one metric
metric   = "reward"
baseline = 0.81
pipeline = 0.81
higher_is_better = true

[[benchmark.task]]                        # optional, at most 50
name = "parallel-tfidf-search"
baseline = 1.345
pipeline = 0.946
quality_baseline = 1.0
quality_pipeline = 1.0
```

Commit it next to `pipeline.toml`; the next crawl of that commit picks it up (an already-listed
pipeline gets an update PR).

## Reviewing a PR

Read the body top to bottom: rtk's own disclosure, every text block in full, the egress table,
overrides. Tick the checklist in the PR template. Merge = listed. Close = never again for that
commit (a new commit by the author gets a fresh PR). Repeated abuse → `blocklist.toml`.

To pull a listed pipeline: add it to `revoked.toml` in a PR. The site drops it on the next deploy
and `/pipelines/index.json` lists it under `revoked`.

## Layout

```
approved/<owner>/<repo>/<sha>/pipeline.toml   byte-identical snapshot of the upstream blob
                              benchmark.toml  optional, byte-identical snapshot of the author's benchmark.toml
                              entry.toml      owner, repo, sha, name, tier, source, rtk, pr, submitted_at
                              report.json     precheck output + author numbers (schema in scripts/lib/entry.mjs)
revoked.toml  blocklist.toml  reserved.toml   policy, maintainer-edited via PR
rtk.pin                                        pinned rtk release + sha256 (bumped by rtk-pin-bump.yml)
scripts/      crawl, precheck, report, validate-pr, on-merge, recheck, rtk-pinned.sh, setup-repo.sh
test/         fixtures (hostile candidates, builtin snapshots, a sample approved repo) + node --test
```

## Local use

```bash
pnpm install
RTK_BIN="$(bash scripts/rtk-pinned.sh)"                       # downloads + verifies the pinned release
node scripts/precheck.mjs some/pipeline.toml --key o/r@<sha> --rtk "$RTK_BIN" --out report.json
node scripts/report.mjs report.json                           # the PR body
DRY_RUN=1 GH_TOKEN="$(gh auth token)" RTK_BIN="$RTK_BIN" node scripts/crawl.mjs   # prints what it would open
pnpm test
```

Site side: `rtk-ldp/scripts/prepare-pipelines.mjs` reads this repo (`PIPELINES_REPO_PATH`) and
renders `/pipelines/`. `test/fixtures/sample-repo/` is a ready-made allowlist for local site work.

## One-time setup

`scripts/setup-repo.sh` creates the labels, the `state` branch and the `main` ruleset, then prints
the manual steps: enable Discussions (category "Pipelines"), create the `rtk-pipelines-bot`
GitHub App (secrets `BOT_APP_ID`, `BOT_PRIVATE_KEY`), `LDP_DISPATCH_TOKEN`, `DISCORD_WEBHOOK_URL`,
and set the variable `CRAWL_ENABLED=true` to arm the schedule.
