# ADR-110: Review main integrations and report stale-base overlap

- **Status:** Accepted, mechanism corrected by #3485
- **Date:** 2026-09-19
- **Owners:** platform, kernel
- **Related:** #3237, #3222, #3178, #3234, #3482, #3485, ADR-046
- **Delivered by:** `tools/scripts/check-stale-merge-base.mjs`, `tools/scripts/check-machine-key-purpose-coverage.mjs`, and `tools/scripts/audit-stale-squash.mjs`

## Context

A branch integration can discard a fix already on `main`. A later squash then lands that loss. Git's clean three-way merge does not generally replace an untouched file with the branch's older copy. The original version of this ADR incorrectly described that as the mechanism of the #3222/#3178 incident.

The retained Git objects establish this sequence:

1. #3222 landed the CLI-session exemption in `e42e997e61b44a2c0d67661ad14c381ca9d63f0c`.
2. #3178's branch merged that exact commit as the second parent of `d98301fa11af02d8848ec20aa95ae105ee4d1d43`. The integration result discarded the exemption and its regression test.
3. #3178 squashed as `30adbbb3672d54f82b9f62e9fd1cf1704b1c22f2`. Its final merge base with pre-squash `main` was already `e42e997e61b44a2c0d67661ad14c381ca9d63f0c`. The loss was present before the squash.
4. #3234 restored the exemption with a required-person check. The frozen audit tip retains that check in `packages/iam/src/machine-key-scope.ts`.

The [retained incident evidence](../reviews/stale-squash-3485/incident.json) records the commits, parents, and file diffs. Neither the final merge base nor an up-to-date status proves that earlier integration resolutions preserved behavior.

## Decision

Keep the advisory overlap scan and the narrower machine-key-purpose guard. Before merging, integrate current `main`, inspect resolutions, and verify the behavior both sides changed. Do not change the live repository ruleset from this PR.

`check-stale-merge-base.mjs` compares files changed on both sides since their merge base. It reports exact lines added on `main` but absent from the branch. These are review signals. Formatting changes can trigger them, and a clean merge can preserve the reported lines. The check does not inspect earlier branch integrations. Its up-to-date message must state that limitation.

`check-machine-key-purpose-coverage.mjs` runs through `pnpm check:contracts`. It checks for a branch handling every reachable machine-key purpose. This gives the affected IAM boundary a structural check independent of merge mechanics. It does not establish the correctness of every branch's implementation.

### Repository setting

The historical ruleset read reported `strict_required_status_checks_policy: false` on ruleset `17953033`. Requiring up-to-date branches can force integration and fresh checks before merging, at a merge-throughput cost. It cannot prevent an integration from discarding a fix: #3178 had already integrated the relevant fix commit.

That setting remains a maintainer decision. The earlier claim that changing one field would completely prevent this incident class is withdrawn. This revision does not assert the setting's current value or change it.

Read rulesets through `/repos/{owner}/{repo}/rules/branches/{branch}`. The classic `/branches/{branch}/protection` endpoint does not report ruleset protection, so its absence is insufficient evidence that a branch is unprotected.

## Historical audit correction

#3482 appended an audit that compared 86 adjacent pairs and reported 19 raw hits from 87 commits. It did not retain the script, raw results, an exact terminal SHA, or a reproducible time boundary. Its listed categories add to **21**, not 19: `12 + 3 + 2 + 1 + 1 + 2`. The record cannot establish which rows were duplicated or which count was wrong. Both the exact count and the claim of a complete audit are withdrawn.

Adjacent-pair comparisons miss a fix followed by unrelated commits before a later loss. They also fail to reconstruct branch integrations. Deleted branch names do not imply missing PR heads: this pass fetched every scoped head from GitHub's `refs/pull/<number>/head` and verified its recorded object ID.

The replacement [audit record](../reviews/stale-squash-3485/README.md) retains PR metadata, full baselines, raw candidates, incident evidence, and review dispositions. Its executable scans both each PR's actual final merge base and earlier main integration merges in the retained branch history. It includes non-adjacent changes and deleted files. It refuses missing objects and ambiguous merge bases instead of reporting them as empty files.

The replacement record distinguishes candidate counts from confirmed defects. It does not claim that unreviewed exact-line signals establish the absence of live regressions. The addendum below finishes that review.

## Net-effect audit addendum (2026-10-03)

This pass asks one question of every merge: did it take away a change that `main` gained after the merge's branch split off? The raw results, the scripts, and every disposition are in [`net-effect/`](../reviews/stale-squash-3485/net-effect/).

### Result

No lost code change is live on `main` at `f080863dac`. One lost documentation change was live, and this addendum's pull request restores it.

- **C0511 (restored).** #3481 turned `docs/capabilities/_index.md` into a table and dropped the `list_resolved_approvals` row that #3467 had added. The contract and its reference page still exist. The row is back, with the manifest's surfaces.
- **C0525 (closest code case, not live).** #3483 put `bg-app-panel-bg` back on the shell frame over #3491's `bg-app-canvas`, and that class is still there. #4082 later set `--app-panel-bg` to the ink colour in the dark theme, and both tokens are white in the light theme. The shell draws the canvas colour in both themes, so nothing visible is lost.
- **The known incident.** The method flags #3178 dropping #3222's CLI-session exemption (C0187, C0188). #3234 restored it, and today's `machine-key-scope.ts` has it in its stronger form.

### Method

The window is every commit that landed on `main` from 2026-09-17 00:00 UTC through the #3556 merge. That is 184 commits: 177 PR squashes, 2 merge commits pushed to `main`, and 5 direct pushes. It contains all 161 PRs of the #3556 record and the 123 squashes the original #3482 audit meant to cover.

For each PR squash, the script finds the branch's **fork point**: the oldest `main` commit the PR's history touches. This is where the branch first split off, not the final merge base, which moves forward every time the branch merges `main`. Then, for the squash's diff against the `main` it landed on:

1. A **removed** candidate is a line the squash took away that `git blame <fork point>..<main>` gives to a `main` commit made after the fork point.
2. A **re-added** candidate is a line the squash put back after `main` deleted it since the fork point.
3. A **binary** candidate is a binary file both the squash and `main` changed since the fork point.

This compares each merge with every change `main` gained while its branch was open, so a fix followed by unrelated merges is still compared with the later stale branch. A merge commit pushed to `main` is checked the same way against each parent, from the parents' merge base. A direct push has no branch side and is skipped.

The scan found **745 candidates in 65 commits**: 663 removed, 68 re-added, and 14 binary. 507 of them fall in the original audit's range.

### Review

Automatic checks against `main` at `f080863dac` cleared 381 candidates:

| Check | Candidates |
|---|---:|
| Every lost line is on `main` today, exactly somewhere in the tree or at least 80% similar in the same file | 169 |
| Generated file that CI regenerates and compares, such as `atlas.sum` and `storage-manifest.json` | 97 |
| Documentation file a later commit deleted | 73 |
| Every lost line is in the same file today | 17 |
| Binary file whose copy on `main` today is not the one the squash wrote | 14 |
| Re-added line that is gone from `main` today | 7 |
| Only punctuation or blank lines | 4 |

The other 364 were read by hand against the code at `f080863dac`. Each row of `candidates.csv` names its disposition and the file, line, or commit that shows it.

| Disposition | Candidates |
|---|---:|
| Rewritten: the squash or a later commit replaced the lines with an equivalent or stronger version | 125 |
| Superseded: a later commit removed or replaced the behaviour on purpose, or deleted the file | 111 |
| Comment only: no code line is missing | 39 |
| False signal: a generic re-added line, such as `requiredIn: [],` | 37 |
| Present elsewhere: the behaviour moved to another file | 36 |
| Removed on purpose by the PR itself | 15 |
| Live, restored here | 1 |

The security-relevant candidates all resolved to a newer form. Examples: client IP attribution moved to `packages/oxagen/src/client-ip.ts`, the rate limiter's fail-closed flag became the `degrade-to-local` policy of ADR-082, the role resolver moved to `packages/iam/src/org-role.ts`, the credential probe now refuses redirects, and the ISO 4217 list is one code per line.

`join-3556.json` maps every one of #3556's 588 integration records onto this pass. Of their lost lines, 2,013 appear in a net-effect candidate above. 4,308 were already gone from `main` before the squash, 151 are in the squash result, and 849 are in the squash under a renamed path. The last 9 predate the branch's fork point. So no #3556 record is left without an answer.

### Count reconciliation

The total of 19 was right. The first category was wrong: it holds 10 hits, not 12.

`original_method_rerun.py` reruns #3482's adjacent-pair method and reproduces its numbers exactly: 87 commits, 84 pairs compared, 2 pairs skipped, and 19 raw hits. The generated-file hits are `atlas.sum` 4 times, `storage-manifest.json` 4 times, `docs/capabilities/schemas/_index.json` once, and `docs/capabilities/schemas/README.md` once. The other five categories match their listed counts.

The rerun also explains the 87. #3482 read `main` at its branch base, `79d393a334`, with `git log --since=2026-09-17`. Git fills a date with no time with the current time of day. So the window began on the afternoon of 2026-09-17, not at midnight. Any start from 14:25:36 to 14:59:15 PDT gives the same 87 commits. Eight of them reached `main` through the second parent of the local merge `6e04882511`.

That start time came after #3222 (13:23 PDT) and #3178 (13:25 PDT). The original audit never compared the incident pair it was written to find.

### Limits

- The automatic checks match exact lines or lines at least 80% similar. The tree-wide search skips audit records, reflections, changelogs, release notes, and the retired `apps/app_deprecated`, because they quote old lines word for word. That moved 18 candidates from the automatic checks to the hand review, all from #2997's app rebuild and #3164.
- An 80% match can hide a flipped operator or a dropped `!`. Every similarity match in IAM, auth, API middleware and routes, handler libraries, database, and billing code was read by hand. All 17 were reformatting, an added field, or a later count, and none changed a condition.
- The hand review judged behaviour by reading today's code. "Rewritten" means today's code does the job; it is not a proof of equivalence in every case.
- The five direct pushes in the window have no branch, so this method cannot test them.
- Merges after #3556 are outside the window. `check-stale-merge-base.mjs` still flags overlap on open PRs.
