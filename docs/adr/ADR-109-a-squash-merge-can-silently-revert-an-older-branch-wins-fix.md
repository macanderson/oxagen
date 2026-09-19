# ADR-109: A squash merge against a stale base gets an advisory check, not a ruleset flip

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** platform, kernel
- **Related:** issue #3237; #3222 (the fix that was lost); #3178 (the squash
  merge that lost it); #3234 (the restore); ADR-046 (per-commit CI concurrency
  on `main`, the reason a strict-status-checks flip has a real merge-speed
  cost)
- **Numbering:** 109. ADR-102 through ADR-108 are taken; several parallel PRs
  in the same P1 batch independently drafted colliding numbers and were
  renumbered at merge time as each collision surfaced.
- **Delivered by:** `tools/scripts/check-stale-merge-base.mjs` (the advisory
  check, wired into `.github/workflows/pipeline.yml`'s `checks` job);
  `tools/scripts/check-machine-key-purpose-coverage.mjs` (the narrower guard,
  wired into `pnpm check:contracts`); `packages/config/src/registry.ts`
  (`STALE_MERGE_BASE_REF`, `STALE_MERGE_BRANCH_REF`)

## Context

A squash merge applies a branch's total diff against its MERGE BASE, the
commit where the branch split from `main`, not against `main`'s current tip.
A branch cut before a later PR's fix landed carries the old copy of any file
that fix touched. When the merge resolves without a textual conflict, GitHub
reports the PR as cleanly mergeable and applies that old copy over the newer
one. Nothing goes red, and nothing in the diff a reviewer reads shows it,
because the diff a reviewer sees is the PR's own diff against ITS base, which
never mentions what changed on `main` after that base.

This is measured, not theoretical. On 2026-09-17, #3222 fixed
`packages/iam/src/machine-key-scope.ts` so a `cli_session_v1` key (what
`oxagen login` mints) is exempt from the machine-key mandate. #3178, cut
earlier and unrelated to that file, squash-merged two minutes later and
silently deleted the exemption and its regression test. The purpose-value
count in that file went from 1 (at #3222) to 0 (at #3178's merge) to 0
(eight hours later, on `main`). Every `cli_session_v1` key was denied every
capability: `oxagen login` was broken in production until #3234 restored the
exemption in a fail-closed form.

An earlier draft of issue #3237 also said `main` carried no branch
protection at all, reading:

```
GET /repos/macanderson/oxagen/branches/main/protection
-> {"message": "Branch not protected"}
```

That was wrong, and the way it was wrong matters for anyone who checks this
again later: a repository RULESET governs `main` (ruleset `17953033`,
`"main branch"`), and rulesets do not show up on the classic branch-protection
endpoint. Reading only `/branches/{branch}/protection` reports a protected
branch as unprotected. The correct read is
`GET /repos/{owner}/{repo}/rules/branches/{branch}`, which shows the ruleset's
actual `required_status_checks`, `pull_request` and `required_status_checks`
policies. This repository has no script or doc that queries branch protection
via the API today (a search for `/branches/.../protection` and
`/rules/branches` across the tree found none), so there is nothing existing to
fix toward the ruleset endpoint; a future script that checks branch
protection here should read the ruleset endpoints from the start.

The one setting on that ruleset that would have prevented this specific
failure is present and set to the permissive value:

```
"required_status_checks": {
  "strict_required_status_checks_policy": false,
  "required_status_checks": [{"context": "checks"}, {"context": "test"}]
}
```

`strict_required_status_checks_policy` is GitHub's "require branches to be up
to date before merging" setting. While it is `false`, a branch can merge
without containing `main`'s latest commit, which is exactly what let #3178's
stale copy win.

## Decision

Implement the safe, code-only half of the fix in this PR: an advisory CI
check, plus a narrower structural guard on the one file that actually broke.
Do not flip the live ruleset setting from an automated session.

### Why not flip `strict_required_status_checks_policy` here

The issue names flipping the ruleset field as option 1, and it closes the gap
completely: with it `true`, every branch's merge base is `main`'s current tip,
so a branch cannot carry a stale copy of any file. It is also, on its own
terms, a live, immediate change to how every future PR on this shared,
actively-worked repository merges, effective the moment it is set:

- **Every session working this repository right now is affected instantly.**
  Several Claude sessions and an automated optimizer work this tree in
  parallel (CLAUDE.md, "Operating mode"). A ruleset flip made from inside one
  of those sessions changes the merge behavior every other concurrent
  session's PR is subject to, with no review and no announcement.
- **It has a real, ongoing merge-speed cost the issue itself names**, and
  ADR-046 already recorded the opposite trade once: giving each push to
  `main` its own CI run, specifically so a burst of merges costs concurrent
  runners rather than a serialized queue. `strict_required_status_checks_policy: true`
  forces every PR to merge in the latest `main` and re-run CI before it can
  merge, which serializes bursts of merges exactly one at a time. Whether
  that cost is worth paying, against how often the ADR-046 burst pattern
  actually happens, is a call about this repository's day-to-day throughput
  under a fleet of concurrent sessions, not a call the incident's severity
  settles by itself.
- **The issue's own framing agrees.** #3237 states this under "Why this
  cannot be fixed in a PR (SCR-004 case: `needs:decision`)": the fix is a
  repository setting, so no PR can contain it, and the trade is the
  maintainer's call.

This PR does not flip the setting. It is recorded here, explicitly, as the
complete, one-field, immediate fix, available to the maintainer at any time
by setting `strict_required_status_checks_policy: true` on ruleset `17953033`
(Settings, or `PUT /repos/macanderson/oxagen/rulesets/17953033`). Nothing in
this PR needs updating if that flip happens later; the advisory check below
keeps working (it degrades to reporting "up to date" on every PR once every
branch is forced current) and the structural guard is unaffected either way.

### What this PR does instead

**Option 2: an advisory CI check**
(`tools/scripts/check-stale-merge-base.mjs`). When a PR's branch does not
contain `origin/main`'s latest commit, it finds every file changed on both
sides since the merge base and, for each, checks whether the branch's own
copy already carries the lines `main` added there since. A file where it does
not is reported as at risk: a squash merge could silently drop exactly that
content. It is wired into `pipeline.yml`'s `checks` job as an ordinary,
non-blocking step, the same way `vision-gate.yml` posts an advisory verdict
without blocking the merge: it prints to the job log and the step summary,
and it never sets `process.exitCode`. It is cheap (a handful of `git diff` and
`git show` calls) and it catches the case while a person can still look,
exactly the trade #3237 describes for option 2. It does not close the gap
completely: someone can still merge past the warning, the same as any other
advisory gate in this repository.

**The narrower guard #3237 calls out regardless of which option is chosen:**
`pnpm check:contracts` now also runs
`tools/scripts/check-machine-key-purpose-coverage.mjs`, which asserts that
`packages/iam/src/machine-key-scope.ts` branches on every scope `purpose`
value a live API key can carry. This protects the one file that actually
broke, structurally, independent of merge mechanics: however a purpose
branch is lost, whether by a stale merge base, a hand edit, or a refactor
that touches the wrong function, a purpose this codebase mints but this file
no longer recognizes fails the build rather than production. It groups
purpose declarations by their string value rather than by constant name,
because several names mint the same value across files (`TACHO_HOST_PURPOSE`
in this file and `TACHO_HOST_SCOPE_PURPOSE` in
`packages/handlers/src/lib/tacho-enrollment.ts` both mint `"tacho_host_v1"`),
and it exempts a value `resolveApiKey` refuses before this gate is ever
reached (`agent_credential_v1`'s `purpose_locked` refusal), so it reports
only a purpose that is meant to reach this gate and does not.

### What this PR does not do

- It does not audit every merge since some cutover date for the same
  pattern. That is a one-time forensic exercise (for each squash merge on
  `main`, whether its merge base is older than the merge before it, and
  whether both touched the same file), not something that belongs in this
  PR's code. If the maintainer wants that audit run, it is a follow-up task,
  named in the PR body rather than filed as a ticket here (the audit itself
  is the deliverable; a ticket that only says "run the audit" adds nothing a
  direct request would not).
- It does not add or change any approval, code-owner review, or other
  ruleset requirement. The issue explicitly scopes itself to one property
  (a merge must not silently revert a fix) and leaves the rest to a separate
  decision.

## Consequences

- A PR whose branch is behind `main` and touches a file `main` also changed
  gets a warning naming the file and what would be lost, while the merge can
  still proceed. The class of failure is not closed, only made visible; a
  merge past the warning can still lose content silently, exactly as before
  this PR, unless the maintainer later takes option 1.
- `machine-key-scope.ts` cannot silently lose a purpose branch again without
  failing `check:contracts`, in CI, on pre-push, and in `pnpm gate`,
  regardless of how the branch is lost.
- The maintainer decision this ADR defers, flipping
  `strict_required_status_checks_policy` on ruleset `17953033`, remains open
  and is not tracked by an issue: SCR-004 treats a decision that blocks a fix
  as `needs:decision` on the issue that carries the fix (#3237), which
  already carries this framing in its own body, not a fresh ticket that would
  only restate it.
