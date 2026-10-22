<!-- Review PRs are opened by the bot. The body above the line is generated; the checklist below is yours. Merge = listed. -->

## Reviewer checklist

- [ ] validates on the pinned rtk; bot refusals: none (the `validate-pr` check is green)
- [ ] egress: every host is a known provider default or loopback; any custom `base_url` is justified by the README, otherwise reject
- [ ] credentials: `api_key_env` is the canonical variable for its provider (never `GITHUB_TOKEN`, `AWS_*`, `SSH_*`, …), or a clearly pipeline-specific one for a local service
- [ ] text blocks read in full: only about reading, compressing, delegating; no commands to run, no URLs, no "ignore previous…", no secret handling, no instructions aimed at other tools
- [ ] overrides do not disable built-in deny/route/rewrite rules without a stated reason in the README
- [ ] no plugins, no `file` directives, no hidden Unicode (bot-verified, see "Bot notes")
- [ ] name not impersonating anyone; owner visible; account age reasonable for what it claims
- [ ] for an **update**: the diff is what the README says changed

Rejecting? Close the PR with one line of reason; the bot remembers the commit and will not re-open it. To block an author entirely, add them to `blocklist.toml` in a separate PR.
