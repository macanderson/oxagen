# ADR-039: Centralize SCR enforcement in oxagen rather than replicating it

- Status: accepted
- Date: 2026-08-26

## Context

ADR-038 replicated the SCR corpus (`docs/scr/`) byte-identically across the
five org repos — oxagen, context-graph-protocol, cgp-website, arenabench,
stella — and named cross-repo drift as a known, accepted cost. The residue
filed against that rollout asks for three enforcement mechanisms, each phrased
in terms of all five repos:

- **#1320** — a check that the five `docs/scr/` trees have not diverged.
- **#1321** — a merge check binding SCR-003: a PR must link the issue it
  closes, and the DoD must be verified before the close.
- **#1322** — a scheduled sweep auditing merged PRs for unfiled residue
  (SCR-004).

Read literally, each is "add this workflow to five repositories". Doing that
would put five independently-editable copies of every enforcement mechanism
into the org — including five copies of the check whose entire purpose is
detecting that five copies have drifted apart. A bug fixed in one would have
to be re-fixed four times, and the copies would drift exactly the way the
corpus can drift, but with no check watching *them*.

Replication was the right call for the corpus and is the wrong call here, and
the difference is worth naming. The corpus is **content that must be readable
where it is used**: an agent working in stella needs SCR-001 on disk in
stella, and a shared steering repo would mean an agent whose context depends
on a second checkout. Enforcement is **behavior**, and behavior does not have
to be local to be binding — a GitHub Action can read another repository over
the API and a workflow can be called across repositories.

## Decision

Each enforcement mechanism has exactly one implementation, in oxagen.

1. **Org-wide scheduled jobs run only in oxagen and reach the other four
   through the API.** This covers the corpus drift check (#1320) and the
   residue sweep (#1322). Nothing is installed in the other four repos at
   all; oxagen holds the schedule, the logic, and the credentials.

2. **Per-repo PR checks ship as `workflow_call` reusable workflows in
   oxagen**, and each consumer repo carries a caller stub of roughly a dozen
   lines. This covers the DoD check and its close guard (#1321). All five
   repos are public, so `uses: macanderson/oxagen/.github/workflows/…@main`
   resolves without additional credentials.

3. **The shared logic lives in plain, dependency-free ES modules under
   `tools/scripts/`,** with the pure decisions exported and unit-tested, and
   the workflow reduced to I/O. Reusable workflows fetch the module with a
   sparse `actions/checkout` of oxagen.

4. **oxagen runs the reusable workflows on its own PRs through the same file
   it exports,** rather than through a copy. The exported implementation is
   therefore exercised on every oxagen PR and can never be stale relative to
   what the four consumers call.

The caller stubs are the only replicated bytes. They name a workflow and pass
no logic, so a change to *what* the check does never touches them; only
adding or removing a check does.

## Why durable

The failure this avoids is specific and observed: a rule enforced by five
copies of a script decays into five slightly different rules, and the decay
is invisible because each repo's CI is green against its own copy. One
implementation cannot disagree with itself. The reader in 2036 asking "what
does the DoD check actually do?" has exactly one file to read and one test
suite to trust.

The mechanisms chosen are all boring and native to the platform — scheduled
workflows, `workflow_call`, `actions/github-script`, ES modules with no
dependencies. Nothing here needs a bespoke runner, a shared package registry,
or a service to stay alive. If the reusable-workflow mechanism is ever
withdrawn, each consumer stub degrades into an obvious place to inline the
check; if a repo leaves the org, deleting its stub is the whole migration.

Keeping the logic dependency-free is deliberate rather than minimalist: it
means the health of the *process* checks does not ride on the health of the
*product's* dependency tree. A broken lockfile in oxagen must not be able to
stop the org from noticing that its steering corpus has drifted.

## Consequences

- oxagen becomes a load-bearing dependency of the other four repos' CI. This
  is already true of the corpus (oxagen is the drift reference), so the
  coupling is acknowledged rather than new. A consumer repo whose stub cannot
  resolve fails loudly.
- Checks pinned to `@main` pick up changes immediately, with no per-repo
  rollout. The tradeoff is that a bad change to a reusable workflow can break
  four repos at once — mitigated by point 4, since oxagen's own PRs run the
  same file first.
- The drift check reads the other four repos with `GITHUB_TOKEN`, which works
  only because all five are public. Should one turn private, the check fails
  as "could not run" rather than reporting a false green, and a PAT
  (`SCR_CORPUS_TOKEN`) is the documented remedy.

## Alternatives considered

- **Replicate every workflow into all five repos.** Rejected: creates the
  drift the corpus check exists to detect, multiplied across three
  mechanisms, with no check watching the enforcement itself.
- **A shared `.github` repository for org-level defaults.** GitHub's org-wide
  workflow-defaults mechanism is scoped to organizations; these repos are
  owned by a user account, so the feature is not available. Revisit if the
  repos ever move under an org.
- **Publish the shared logic as an npm package.** Rejected as heavier than
  the problem: it adds a release cycle and a registry dependency between
  "fix the check" and "the check is fixed", to avoid a sparse checkout.
