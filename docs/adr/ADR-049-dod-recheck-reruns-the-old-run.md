# ADR-049: The DoD recheck re-runs the old run rather than reporting a new check

- **Status:** Accepted
- **Date:** 2026-09-07
- **Owners:** platform
- **Related:** issue #2661 (the live half), issue #2638 (the problem), issue
  #2551 (what a partial re-pin costs), ADR-039 (one implementation, four
  stubs), ADR-045 (stubs pin a commit),
  `.github/workflows/dod-recheck.yml`, `tools/scripts/check-dod-stub-parity.mjs`

## Context

`dod-check` judges a linked issue's checklist and fires on pull request events.
Those are two different objects. Ticking the last box — the remedy the failure
message names — raises no pull request event, so a red required check stood at a
verdict that was no longer true until somebody happened to touch the pull
request.

The obvious fix, a workflow that hears `issues: edited` and reports a verdict,
has a problem that is easy to miss: branch protection reads *the last check run
with a given name on a given commit*. A newly reported check appears beside the
original rather than replacing it, and the name GitHub assigns differs between a
workflow triggered directly and one invoked through `uses:`. Getting that wrong
produces a second, non-required check that fools nobody — or, worse, leaves
every pull request in five repositories unable to reach a passing `dod`.

## Decision

**Re-run the existing failed run. Do not report a new check.**

`dod-recheck.yml` hears its own repository's issue edits, finds the open pull
requests whose body names the edited issue, and re-runs the `dod` run that
failed on each. The re-run reports under the same name on the same commit, which
is exactly what branch protection reads — so nothing here has to name a head
commit the issue event does not own, and nothing has to predict the check name a
`workflow_call` invocation produces.

The scope is the failing runs only. A pull request whose `dod` already passes is
left alone, which is what stops one issue edit fanning out across every pull
request that ever named it.

**The four caller repos carry a stub subscribing to their own issue edits**,
because an `issues: edited` event fires in the repository the issue lives in —
oxagen hearing its own edits does nothing for theirs.

### The one exception, named rather than discovered later

`macanderson/stella` implements the recheck itself, in `scripts/dod-recheck.sh`,
with its own tests and `make` target, documented in its AGENTS.md. That is not
the duplication ADR-039 exists to prevent: the **verdict** still comes from one
implementation here. Stella's file only subscribes to its own issue edits and
asks for a re-run, which is a per-repo event subscription rather than a second
copy of the rule.

`check-dod-stub-parity.mjs` records that exception, so a fifth shape fails
instead of quietly joining it.

## How the check-name question was settled

By running it, in a caller repo, rather than reasoning about it.

A probe issue and pull request were opened in `macanderson/arenabench` with one
unticked box. `dod / dod` concluded `failure`. The box was ticked on the issue,
and nothing else was touched:

| | |
|---|---|
| tick | `2026-09-08T01:18:51Z` |
| `dod-recheck` run 34176228447 created | `2026-09-08T01:18:56Z`, event `issues` |
| that run's conclusion | `success` |
| `dod / dod` on the pull request | `failure` → `success`, same name, same commit |

No push to the branch. The probe was closed afterwards.

## Rollback

Delete `.github/workflows/dod-recheck.yml` here and the stub in each caller. The
`dod` check itself is untouched by this change and keeps working exactly as it
did — a pull request goes green when its author pushes, which is the behaviour
this replaces rather than depends on. Nothing else reads the recheck, and no
state survives it, so removing the files is the whole rollback.

The stub-parity guard fails open and is not a required check, so it can be
deleted or ignored without blocking anything.

## Consequences

- A required check across five repositories now re-runs on an event none of
  those repositories' pull requests raised. The blast radius is bounded by the
  scope rule above: only failing runs, only pull requests naming the edited
  issue.
- Re-running an old run means the new conclusion carries the old run's inputs.
  That is correct here — the verdict reads the issue live — and would not be for
  a check whose inputs come from the commit.
- Four stubs are four things to keep in step. That is ADR-039's standing cost,
  and `check-dod-stub-parity.mjs` is what makes a partial rollout fail rather
  than sit unnoticed, which is what #2551 cost when the pins went out of step.
