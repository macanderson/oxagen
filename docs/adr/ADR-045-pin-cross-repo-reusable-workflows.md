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

stella's header already argued the case, and nothing had carried it to the other
three. So a merge in oxagen changed what ran in three repositories with no commit
in any of them — which is how a parser change would have shipped into three repos
the moment it landed (#2664's own example).

## Decision

**A cross-repo `uses:` names a commit SHA.**

Two reasons, and the second is the one that survives disagreement about the
first:

1. A moving ref lets another repository change what runs here without a commit
   in this one. The change is real, it is enforcement behaviour, and it arrives
   with no diff for a reviewer to read.
2. `action-pins`, the guard stella already runs, fails an unpinned cross-repo
   reference. Three of the four stubs were passing only because that guard does
   not run in those repositories.

Each stub's header says which commit it points at and why, so re-pinning is a
reviewable one-line diff naming the version it moved to.

## What this costs, stated plainly

**A fix in the implementation does not reach the callers until each one re-pins.**
That is the real price, and it is the argument for `@main` that this decision
rejects.

It is accepted because the alternative is worse in the direction that matters:
an unreviewed change to an enforcement gate is a change nobody agreed to, while
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

This is stated rather than fixed. Closing it means passing the intended ref in as
an input and having every caller keep two pins in step, which trades a real
inconsistency for a bookkeeping burden that will itself drift. The exposure is
bounded by what that file is: parsing functions with unit tests in oxagen, whose
behaviour changing without those tests noticing is the smaller risk.

## Consequences

- Adding a consumer means copying a stub and pinning it, not inventing a policy.
- Changing the shared implementation is a two-step release: land it in oxagen,
  then re-pin each consumer. #2664 is the sweep that brought the four into line
  at `2dd72c9`.
- `action-pins` can be adopted by the other three repositories without their
  stubs failing it, which was not true before this.
