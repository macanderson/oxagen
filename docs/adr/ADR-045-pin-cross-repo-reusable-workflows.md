# ADR-045: Cross-repo reusable workflows are pinned to a commit

- **Status:** Accepted
- **Date:** 2026-09-07
- **Owners:** platform
- **Related:** issue #2664 (the four caller stubs disagreed on pinning), issue
  #2638 (the recheck the callers also needed), ADR-039 (one implementation of
  the SCR checks, called from four repos), `.github/workflows/dod-check.yml`,
  `.github/workflows/dod-recheck.yml`

## Context

SCR-003 is enforced in five repositories by one implementation living in oxagen,
called from a ~12-line stub in each consumer (ADR-039). Each stub names the
implementation with a cross-repo `uses:`, and that reference needs a ref.

Read on 2026-09-05, the four stubs did not agree:

| repo | ref |
| --- | --- |
| macanderson/stella | a commit SHA |
| macanderson/arenabench | `@main` |
| macanderson/cgp-website | `@main` |
| macanderson/context-graph-protocol | `@main` |

stella's header already gave the reason to pin; the other three stubs did not
pin. A merge in oxagen changed what ran in three repositories with no commit in
any of them; a parser change would have shipped into three repos the moment it
landed (#2664's own example).

## Decision

**A cross-repo `uses:` names a commit SHA.**

Reasons (the second holds even if the first is disputed):

1. A moving ref lets another repository change what runs here without a commit
   in this one. The change is to enforcement behaviour, and it arrives with no
   diff for a reviewer to read.
2. `action-pins`, the guard stella already runs, fails an unpinned cross-repo
   reference. Three of the four stubs were passing only because that guard does
   not run in those repositories.

Each stub's header says which commit it points at and why, so re-pinning is a
reviewable one-line diff naming the version it moved to.

## What this costs, stated plainly

**A fix in the implementation does not reach the callers until each one re-pins.**
This is the argument for `@main` that this decision rejects.

The cost is accepted because an unreviewed change to an enforcement gate is a change nobody agreed to, while
a delayed fix is a change nobody has yet asked for. A repo that needs the fix
sooner re-pins sooner, and that is a one-line PR.

## What it does not do

**Pinning the workflow does not pin the script it runs.** `dod-check.yml` and
`dod-recheck.yml` both fetch `tools/scripts/scr-dod-check.mjs` from oxagen with:

```yaml
ref: ${{ github.repository == 'macanderson/oxagen' && github.sha || 'main' }}
```

Inside a called workflow, `github.sha` is the *caller's* commit, which does not
exist in oxagen — so a caller always resolves `main` for the checker even when
the workflow itself is pinned. The pin covers the steps; the logic they run
floats.

This ADR does not fix it. Closing it means passing the intended ref in as an
input and having every caller keep two pins in step, which trades the
inconsistency for a bookkeeping burden that will itself drift. The exposure is
bounded by what that file is: parsing functions with unit tests in oxagen, whose
behaviour changing without those tests noticing is the smaller risk.

## Consequences

- Adding a consumer means copying a stub and pinning it.
- Changing the shared implementation is a two-step release: land it in oxagen,
  then re-pin each consumer. #2664 is the sweep that brought the four into line
  at `2dd72c9`.
- `action-pins` can be adopted by the other three repositories without their
  stubs failing it, which was not true before this.

## Amendment: compare resolved workflows (#2989)

The 2026-09-15 maintainer decision keeps commit pins and compares the resolved
workflow blob SHAs for both the DoD check and the close guard. Different commits
may carry identical workflow files. Their callers run the same steps, so that
case passes. A missing pinned workflow or different file content still fails.

The four caller repositories exclude `macanderson/oxagen` reusable workflows
from Dependabot actions updates. Maintainers coordinate re-pins when the shared
workflow changes. Other action updates continue normally.

Raw commit comparison was rejected because unrelated changes raised false drift.
Ignoring all pin differences was rejected because it misses changed workflow
steps. Moving references remain rejected for the reasons above. Dependabot
suppression alone would leave the checker comparing the wrong fact.

The checker-script exposure recorded above is unchanged: called workflows read
Oxagen's main branch for their script, even while their workflow steps are pinned.
