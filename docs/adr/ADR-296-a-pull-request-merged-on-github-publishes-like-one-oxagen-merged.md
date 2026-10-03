# ADR-296: A pull request merged on GitHub publishes like one Oxagen merged

- **Status:** Accepted
- **Date:** 2026-10-03
- **Owners:** steering
- **Amends:** ADR-237 (its rule that each change after the published commit
  must be a pull request the Oxagen App merged).
- **Supersedes:** the constraint in #5195 that adopting a host merge must be a
  person's decision in Oxagen, and the `adopt_steering_merges` capability
  #5379 built on it.
- **Related:** issue #5430, ADR-184 (the registry follows the production
  branch), `packages/handlers/src/steering-repo/diverged.ts`.

## Context

A person with write access to a GitHub steering repo can merge a steering PR
on GitHub. Since ADR-237, steering repos use no rulesets so they work on GitHub
Free, and nothing on GitHub stops that merge.

ADR-237 also said every change after the published commit must be a pull
request that GitHub records as merged by the Oxagen App. So a merge on GitHub
always read `diverged`. The repo showed as unhealthy, Oxagen emailed the org's
owners and admins, the "Oxagen steering" check failed on every open steering
PR, and Oxagen opened a pull request to revert main. The sync refused to
publish, so the merged change never went live. #5379 added a manual way out:
someone pressed Adopt in Oxagen.

The webhook already fires on every merge and asks for a health read and a
sync. The sync already handles a merge on the host. It marks the proposal
merged with no approver, and it records a governance change made outside
Oxagen as `steering.governance_overridden`. Only the provenance judge stopped
it.

Mac ruled on 2026-10-03 that a merge on GitHub must not read as unhealthy:
Oxagen cannot stop a customer from merging outside the product, and it has to
take the webhook's word for it.

## Decision

1. **A merged pull request counts, whoever merged it.** A commit after the
   published commit counts when GitHub records a pull request merged into the
   steering repo's production branch as exactly that commit. The merger can be
   Oxagen's App, a person, or another app.
2. **A commit no pull request merged still reads `diverged`.** That covers a
   direct push and a rewritten main. Repair still offers the revert for it.
   Commit trailers and authors still prove nothing.
3. **One judge for every reader.** The health read and the commit check the
   sync, the merge queue, and publication use (`assertGithubSteeringCommit`)
   share the judge, so they agree without an extra step.
4. **The manual adoption goes.** `adopt_steering_merges` has nothing left to
   do, so its contract, handler, API route, and MCP tool are removed.

GitLab keeps its trailer checks. Its baseline protects main so only Oxagen's
bot can merge, and a change to that shows as settings drift.

## Consequences

- A merge on GitHub publishes on the webhook's sync. The proposal reads
  `merged` with no approver, as ADR-184 already records it.
- In `team` and `regulated` modes, a merge on GitHub skips Oxagen's
  separation of duties. Only GitHub's own permissions decide who can merge
  there. ADR-237 already said a healthy repo does not certify that GitHub
  prevents direct writes. The proposal's empty approver shows that nobody
  approved the merge in Oxagen.
- The health reason now says "main holds a commit that no pull request
  merged". The old "Oxagen did not merge" text would be wrong for an accepted
  merge on GitHub.
- A repo that reads `diverged` today only because of merges on GitHub reads
  `healthy` on its next health read, and the open revert pull request closes.

## Alternatives

- **Adopt automatically from the webhook.** Calling the adopt path from the
  webhook would need a signed-in person and a proposal row for each pull
  request. A merge on GitHub has neither, and the judge change does the same
  work with less code.
- **Keep the manual Adopt.** Every merge on GitHub would still email owners
  and open a revert until someone pressed Adopt.
