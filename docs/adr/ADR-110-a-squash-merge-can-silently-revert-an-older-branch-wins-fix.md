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

The replacement record distinguishes candidate counts from confirmed defects. It does not claim that unreviewed exact-line signals establish the absence of live regressions. #3485 remains open until its remaining review and issue-update requirements are satisfied.
