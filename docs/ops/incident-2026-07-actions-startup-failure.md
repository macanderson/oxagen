# Incident: GitHub Actions 100% `startup_failure` since 2026-07-13 (issue #1183)

**Status (2026-08-23):** diagnosed, blocked on an owner-only action.
**Impact:** no workflow in this repository has run since 2026-07-13 17:36 UTC.
The AWS deploy pipeline merged in #1181 has never executed; no PR gets any
check; `mergeable: CLEAN` means "nothing ran", not "nothing is wrong".

This document is the incident record, the evidence trail, the recovery steps,
and the post-recovery verification checklist. Everything below marked
*verified* was reproduced with the exact command shown, on 2026-08-23, with an
org-admin (`repo`+`workflow`-scoped) token.

---

## 1. Exact onset — refining the issue's estimate

The issue estimated ~2026-07-11. The real transition is **2026-07-13**:

- Last real (non-`startup_failure`) runs: `ci-image` **success** at
  `2026-07-13T08:38:59Z`, then `nightly` failure at `11:20:24Z`.
- First `startup_failure`: `2026-07-13T17:36:59Z`. Every one of the
  ~1,167 runs created since then (verified via
  `actions/runs?created=>2026-07-13T17:00:00Z` → `total_count: 1167`) is
  `startup_failure`, 0s, 0 jobs.

```bash
gh api "repos/oxageninc/oxagen-platform/actions/runs?per_page=100&created=2026-07-13T08:00:00Z..2026-07-14T00:00:00Z" \
  --jq '[.workflow_runs[] | {conclusion, created_at}] | sort_by(.created_at)'
```

The only `main` commit in the gap (`87063206b`, 10:36 PT — DB zombie-table
drop, #1006) landed **after** real runs had already succeeded that morning and
touched nothing under `.github/`. No repository change coincides with the
onset.

### There was a prior, identical, self-resolving episode

2026-06-16 05:10 UTC → 2026-06-17 ~20:34 UTC: ~99 consecutive
`startup_failure` runs of the same shape, then normal `failure`/`success`
conclusions resume at `2026-06-17T23:33:50Z` **with no repository change**.
An outage that starts and clears with no commit is account-side by
construction. The July episode is the same failure that never cleared.

## 2. What the failing runs actually are

Every webhook-triggered run since onset binds to **one phantom workflow**:

```bash
gh api "repos/oxageninc/oxagen-platform/actions/workflows/296643227"
# {"name":"", "path":"BuildFailed", "state":"deleted",
#  "created_at":"2026-06-15T18:33:03-07:00", ...}
```

`BuildFailed` is GitHub's internal placeholder for "run creation failed before
a workflow file was selected" — note its `created_at` is the **June** episode's
onset night. All 9 real workflows report `state: active`.

**Decisive probe** (verified): a `workflow_dispatch` of `pipeline.yml` on
`main` (run `32629558219`, 2026-08-23) *does* resolve the workflow — the run
records `name: "CI"`, `path: ".github/workflows/pipeline.yml"` — and **still**
completes `startup_failure` in 0s with 0 jobs and an empty check suite. So the
failure is not YAML, not file selection, not a broken default branch: run
creation itself is refused after resolution. No change to any file in this
repository can affect that.

Also verified:

- `repos/.../actions/permissions` → `{"enabled":true,"allowed_actions":"all"}`.
- Check suites on a failing commit: `github-actions` app = `startup_failure`
  with **zero check runs**; `cubic-dev-ai` = `skipped`; Vercel absent (account
  suspended, 402).
- Repo is `archived: false, disabled: false, private: true`.
- Cross-owner control: `macanderson/cgp-website` (personal account, same
  machine, same token) ran `deploy` to **success** on 2026-08-22. GitHub
  Actions the product is fine; the block is scoped to the `oxageninc` org.
- Other `oxageninc` repos (`vera`, `.github`) have zero workflow runs ever, so
  they neither confirm nor deny scope — but nothing contradicts org scoping.

## 3. Root cause: an org-level billing lock on `oxageninc`

The enhanced billing API (readable with plain `repo` scope, unlike the retired
`settings/billing/actions` endpoint that now 410s) shows the money trail:

| Month | Actions net billed | Interpretation |
| --- | --- | --- |
| 2026-06 | $115.87 (22,312 Linux min) | normal paid usage |
| 2026-07 | $517.14 (Linux + macOS) | heavy usage until the 13th, then dead |
| 2026-08 | **$0.00 compute** (storage only) | nothing has run all month |

```bash
gh api "orgs/oxageninc/settings/billing/usage?year=2026&month=8" \
  --jq '[.usageItems[] | select(.product=="actions")]'
```

The org's own budgets **cannot** be the blocker — verified:

```bash
gh api "orgs/oxageninc/settings/billing/budgets"
# actions: $600, prevent_further_usage: FALSE  (alert-only)
# codespaces: $100, prevent: true; ai_credits: $10, prevent: false
```

An alert-only budget never stops runs. What *does* produce exactly this
run-creation failure shape, org-wide, for weeks, is a **payment failure /
billing hold** (or a legacy spending-limit lock surfaced the same way).
Corroboration: Vercel suspended the same owner's account over an unpaid
balance in the same period (every Vercel-fronted site answers 402 — noted
in #1181), and the June episode's timing + self-recovery matches a card
decline
that a payment retry later cleared; the July one never cleared.

This is inferred from shape, not observed directly: payment status is not
readable from any token available here (the endpoints that might show it need
`admin:org`, and the payment method itself is web-UI-only).

## 4. The fix — owner action required

Nothing in this repository can fix this; the two candidate causes live on the
same page. The org owner (`macanderson`) must:

1. Open **<https://github.com/organizations/oxageninc/settings/billing>**.
2. Look for a payment-failure banner / past-due balance → update the payment
   method and settle the balance. Also check
   **Billing → Spending limits / Budgets** for any lock the API view above
   might not surface.
3. If the page shows nothing wrong (or the lock persists after payment), open
   a ticket at <https://support.github.com> — at six-plus weeks a stale hold
   may need manual release. Reference: org `oxageninc`, all Actions runs
   `startup_failure` at creation since 2026-07-13T17:36Z, sample run id
   `32629558219`.

## 5. Post-recovery verification (the issue's definition of done)

### DoD-3 — pre-`--delete` safety check: **DONE, safe** (2026-08-23)

The first `deploy-web` run executes `aws s3 sync apps/web s3://... --delete`,
which destroys any bucket object not in the repo. Verified against the live
bucket `oxagen-web-578673726240` with the job's exact exclusion set:

- Bucket holds **17 objects**; the repo's publishable set is **identical**
  (byte-for-byte name parity, `diff` clean). `overview-video.html` — the file
  #1181 flagged as hand-uploaded-only — **is committed** at
  `apps/web/overview-video.html`. Nothing exists only in the bucket.
- The `apps/docs` / `apps/app` standalone concern: `STANDALONE=1` build
  support is on `main` (#1181, `next.config.mjs` + `package-for-node.sh`),
  and `ship-to-node` only ever `aws s3 cp`-overwrites
  `_deploy/<service>-standalone.tgz` — it deletes nothing. The hand-shipped
  `docs-standalone.tgz` (2026-08-21) in the deploy bucket is simply replaced
  by the first CI-built artifact.

**The first deploy run is safe to let through.** Re-check parity only if
someone hand-touches the bucket between now and recovery:

```bash
aws s3 ls --recursive s3://oxagen-web-578673726240/ | awk '{print $4}' | sort > /tmp/bucket.txt
(cd apps/web && find . -type f -not -name package.json -not -name vercel.json \
  -not -name README.md -not -name '.*' -not -path '*/.*' | sed 's|^\./||' | sort) > /tmp/repo.txt
diff /tmp/bucket.txt /tmp/repo.txt   # must be empty
```

### DoD-1 — run creation works again

```bash
gh workflow run pipeline.yml --repo oxageninc/oxagen-platform --ref main
sleep 20
gh api "repos/oxageninc/oxagen-platform/actions/runs?per_page=1&event=workflow_dispatch" \
  --jq '.workflow_runs[0] | {id, status, conclusion}'
# want: status "in_progress"/"queued" with real jobs — anything but
# instant "startup_failure"
```

(Note: a dispatch run intentionally skips the test/check jobs via
`if: github.event_name != 'workflow_dispatch'` guards — it exists to reach the
`migrate` path. Reaching `in_progress` with jobs is the signal.)

### DoD-2 — the five services actually ship

The deploy jobs are gated `if: push && ref == main`, so the real test is a
push to `main` (the merge of this very document works). Then:

```bash
gh run watch --repo oxageninc/oxagen-platform   # deploy oxagen.sh + 4× deploy <svc>.oxagen.sh
for h in oxagen.sh docs.oxagen.sh app.oxagen.sh api.oxagen.sh mcp.oxagen.sh; do
  printf '%-16s %s\n' "$h" "$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "https://$h/" || echo 000)"
done
```

Expect `deploy-web` + all four `deploy-node` matrix legs green, and 200s (or
the services' documented root-path status) on all five hosts. Watch the first
`deploy-node` runs closely — #1181's own body notes the first real run is the
test and it has never executed.

### Aftermath check

Six weeks of merges (everything after `13714bf74`, 2026-07-13) landed with
**no CI at all**. After recovery, the first `main` run is also the first time
lint/typecheck/tests/migrations have run on any of it; triage its failures as
a backlog burn-down, not as regressions of the commit that happens to trigger
it.
