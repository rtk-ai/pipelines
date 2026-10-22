#!/usr/bin/env bash
# One-time repo setup (run by an org admin with `gh` logged in):
#   labels, the `state` branch, the main-branch ruleset, Discussions reminder.
set -euo pipefail
REPO="${REPO:-rtk-ai/pipelines}"

echo "== labels"
while IFS='|' read -r name color desc; do
  gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force >/dev/null && echo "  $name"
done <<'LABELS'
candidate|0E8A16|Review PR opened by the bot
pre-checked|C2E0C6|No author text; canonical egress only
needs-reading|FBCA04|Has text blocks or flagged egress: read every line
update|1D76DB|New commit of an already-listed pipeline
gist|BFD4F2|Submitted as a gist
submit-gist|5319E7|Gist submission issue (bot input)
report|D93F0B|Report about a listed pipeline
recheck|E99695|Approved snapshot fails on a newer rtk
LABELS

echo "== state branch (bot-writable, unprotected)"
if ! git ls-remote --exit-code --heads "https://github.com/$REPO.git" state >/dev/null 2>&1; then
  TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
  git -C "$TMP" init -q -b state
  mkdir -p "$TMP/state"; echo '{}' > "$TMP/state/seen.json"; echo '{}' > "$TMP/state/approvals.json"
  printf '# state branch\n\nBot-written: `state/seen.json` (crawl memory) and `state/approvals.json` (approval metadata, discussion links). Never merged into main.\n' > "$TMP/README.md"
  git -C "$TMP" add -A && git -C "$TMP" -c user.name=rtk-pipelines-bot -c user.email=bot@rtk-ai.app commit -q -m "state: init"
  git -C "$TMP" push -q "https://github.com/$REPO.git" state:state
  echo "  pushed"
else echo "  exists"; fi

echo "== ruleset on main"
gh api -X POST "repos/$REPO/rulesets" --input - >/dev/null <<'JSON' && echo "  created" || echo "  (already exists or insufficient rights — create it in Settings → Rules)"
{
  "name": "main: reviewed allowlist",
  "target": "branch",
  "enforcement": "active",
  "conditions": { "ref_name": { "include": ["refs/heads/main"], "exclude": [] } },
  "bypass_actors": [],
  "rules": [
    { "type": "deletion" },
    { "type": "non_fast_forward" },
    { "type": "required_linear_history" },
    { "type": "pull_request", "parameters": {
        "required_approving_review_count": 1,
        "dismiss_stale_reviews_on_push": true,
        "require_code_owner_review": true,
        "require_last_push_approval": true,
        "required_review_thread_resolution": false,
        "allowed_merge_methods": ["squash"] } },
    { "type": "required_status_checks", "parameters": {
        "strict_required_status_checks_policy": true,
        "required_status_checks": [ { "context": "validate-pr" } ] } }
  ]
}
JSON

cat <<'TXT'
== manual steps
  1. Settings → General → Features: enable Discussions; create a category "Pipelines" (announcement type is fine).
  2. Create the GitHub App "rtk-pipelines-bot" (org-owned): permissions Contents RW, Pull requests RW, Issues RW, Discussions RW, Metadata R.
     Install it on rtk-ai/pipelines. Secrets: BOT_APP_ID, BOT_PRIVATE_KEY.
  3. Secrets: DISCORD_WEBHOOK_URL (optional), LDP_DISPATCH_TOKEN (fine-grained PAT, rtk-ldp: Contents RW).
  4. Variables: CRAWL_ENABLED=true to arm the schedule.
  5. Team @rtk-ai/pipeline-maintainers with write access (CODEOWNERS).
TXT
