---
name: oxagen-code-audit
description: Run a full-repo engineering-law audit of the Oxagen monorepo and produce an interactive HTML dashboard of the results. Fans out one auditor per package/app, adversarially verifies every finding to kill false positives, auto-applies the safe fixes in an isolated worktree, files Linear tickets for anything needing approval, and renders a self-contained report. Use when the user asks to "audit my code", "give me an audit report", "check the codebase against my standards / .agents/skills", "what scale or architecture problems will bite me later", "flag over-engineering", or "score the health of each package". Pairs with oxagen-engineering-policy (the law being audited against) and frontend-patterns.
---

# Oxagen code audit

Produces a verified, scored, fix-applied audit of the whole monorepo against the
binding law in `.agents/skills/` — and an interactive HTML dashboard of the
result. This is the standing answer to "give me an audit report for the current
state of my code."

## What it does

A three-phase deterministic workflow (one [`Workflow`](scripts/audit-workflow.js)
run), then a render step:

1. **Audit** — one Sonnet auditor per unit (each package + each app slice +
   one cross-cutting root pass), each reading `oxagen-engineering-policy`
   and `frontend-patterns` for guidance, and scoring the unit 0–100. Auditors report **both** policy violations **and**
   over-engineering / speculative abstraction, plus future-scale landmines
   (N+1, unbounded buffering, missing pagination, single-tenant assumptions).
2. **Verify** — an adversarial verifier re-opens every finding at its
   `file:line`, kills false positives, and independently re-classifies each as
   `auto-fix-safe` or `needs-approval`. An `uncertain` verdict is never
   auto-fixed. (In the baseline run this dropped ~9% of raw findings as
   false-positive.)
3. **Fix** — for each unit, only the **confirmed + auto-fix-safe** findings are
   applied, scoped to that unit's own directories. Reserved boundaries
   (DB schema/migrations, auth/billing/secrets/IAM enforcement, dependency
   add/remove, cross-surface no-drift wiring) are **never** auto-fixed — they
   become Linear tickets.
4. **Render** — [`scripts/render-report.mjs`](scripts/render-report.mjs) turns
   the merged dataset into one portable, dependency-free HTML dashboard styled
   to the Oxagen design system (dark canvas, indigo→green gradient ring, glass
   cards, no emoji): overall + per-unit health gauges, severity/category bars,
   and a filterable/searchable findings table (by unit, severity, category,
   verdict, and fixed/needs-approval).

## How to run it (the recipe)

1. **Confirm the branch.** If the user named a branch, use it. Otherwise default
   to **the current tip of the GitHub remote `main`** (`git fetch origin main`)
   and confirm before proceeding.
2. **Isolate in a worktree** so concurrent in-flight work is never touched:
   ```bash
   git fetch origin main
   git worktree add -b audit/codebase-<date> /Users/macanderson/oxagen-monorepo-audit origin/main
   ```
   Re-`git reset --hard origin/main` the worktree if main advanced during setup,
   and pin the audit to that exact SHA.
3. **Read the law first** so the prompt is grounded: `oxagen-engineering-policy/SKILL.md`
   + `policies/*.md`, plus `frontend-patterns` for web techniques.
4. **Run the workflow.** Invoke `Workflow` with
   [`scripts/audit-workflow.js`](scripts/audit-workflow.js) (adjust the `WT`
   constant to the worktree path and the unit list if the package layout
   changed). It returns the merged `{meta, unitSummaries, rollup, findings,
   fixesApplied, fixesSkipped, tickets}` dataset.
5. **Reconstruct the dataset if needed.** The workflow streams its result to the
   task notification; if it is truncated, rebuild it from the agent transcripts
   with [`scripts/extract-audit.py`](scripts/extract-audit.py) `<run-dir> <out.json>`
   then [`scripts/finalize-audit.py`](scripts/finalize-audit.py) (sets the real
   `applied` flags from git, recomputes the rollup).
6. **Render** the dashboard into `docs/audits/audit-<date>.html`:
   ```bash
   node .agents/skills/oxagen-code-audit/scripts/render-report.mjs \
     --data audit-final.json --out docs/audits/audit-<date>.html \
     --generated-at <ISO>
   ```
7. **Verify the fixes** in the worktree: `pnpm install --frozen-lockfile`, then
   `turbo run typecheck` and `turbo run test`. The auto-fixes must keep the
   build green; if not, revert the offending fix and reclassify it as
   needs-approval.
8. **File Linear tickets** for the `needs-approval` findings, grouped into
   themed parent tickets (one ticket = one PR) per the `Linear` convention in
   the root `CLAUDE.md`: assignee Mac Anderson, `agent-created` + functional-area
   labels, t-shirt estimate, priority, and the full description structure. Do
   **not** file one ticket per finding — group by root cause.
9. **Open one PR** with the fixes **and** the report together, based on the
   audited SHA.

## The dataset shape (what render-report.mjs consumes)

```jsonc
{
  "meta":   { "base": "<sha>", "branch": "...", "generatedFor": "oxagen-monorepo" },
  "rollup": { "units", "totalFindings", "confirmed", "falsePositive", "uncertain",
              "bySeverityConfirmed", "byCategoryConfirmed",
              "fixesApplied", "fixesSkipped", "ticketsNeeded" },
  "unitSummaries": [ { "unit", "healthScore", "summary", "findingCount",
                       "confirmedCount", "applied" } ],
  "findings": [ { "id", "unit", "title", "category", "severity", "rule",
                  "file", "evidence", "recommendation", "effort",
                  "verdict", "verifiedSeverity", "verifiedFixClass",
                  "verifyReasoning", "applied" } ],
  "fixesApplied": [ { "id", "files", "summary", "unit" } ],
  "tickets":      [ <confirmed needs-approval findings> ]
}
```

`render-report.mjs` is pure Node (no deps); the output HTML embeds the dataset as
a JSON island and escapes every dynamic value, so it is safe to commit and open
offline.

## Tuning

- **Scope**: edit the `UNITS` array in `audit-workflow.js` — one entry per
  package/app slice, with a `focus` that names the laws most at risk there.
- **Fix aggressiveness**: the `FIXCLASS` text in the workflow encodes the
  auto-fix vs ticket boundary. The baseline reserves only schema/migration,
  auth/billing/secrets/IAM, dependency changes, and cross-surface wiring.
- **Model**: auditors/verifiers/fixers run on Sonnet by default — enough for
  policy adherence; escalate only if a unit needs deep reasoning.
