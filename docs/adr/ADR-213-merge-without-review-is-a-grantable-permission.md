# ADR-213: Merge without review is a grantable permission

- **Status:** Accepted
- **Date:** 2026-09-27
- **Owners:** steering, iam
- **Related:** issue #4449 (the steering merge queue), issue #4504 (GitLab
  approvals bind to a head), ADR-061 (governance modes), ADR-063 (the
  permission catalogue).

## Context

Outside solo mode, `merge_context_pr` merges a steering PR only when a
workspace member other than the author approved it at the head that merges.
An org Owner or a workspace Owner may merge without one, and the trailer and
the promotion line record that nobody reviewed the change.

The merge already asked a second question, `holdsMergeWithoutReview`, for
members who are not owners. Nothing answered it. The seam defaulted to
false, no capability of that name was registered, and a role could not be
granted it. The approval rule therefore bound everyone but owners, with no
way for an organization to widen it.

The kernel cannot answer the question either. Its IAM gate (`checkIAM`)
allows every call from an organization below the enterprise tier, so asking
it would make every member a holder on most plans.

## Decision

1. **`merge_pr_without_review` is a registered capability.** It is sync,
   high sensitivity, `api` only, and `defaultEffect: deny`. Its default roles
   are org Owner and workspace Owner. Its input and output are
   `merge_context_pr`'s. The API mounts it at
   `POST /v1/context/prs/merge-without-review`.
2. **The handler asks the IAM resolver itself.** `holdsCapability`
   (`packages/handlers/src/lib/capability-holder.ts`) reads the caller's IAM
   data with `fetchAuthz` and runs the resolver with the contract's own
   `defaultEffect`. Only `allow` holds. A role grant of `require_approval`
   does not, because no approval step runs inside a handler. A caller who
   does not hold it is refused `merge_without_review_not_held` before
   anything is read.
3. **A holder runs the `merge_context_pr` handler with the approval gate
   lifted.** Every other gate stays: the checks, the governance mode's
   reviewer rule, repository health, the pinned head, and on GitLab the
   "Reset approvals on push" setting and an `approved_at` time on every
   approval (`approvals_not_head_bound`). An approval that already stands at
   the head is recorded as that approval.
   The `steering.published` event carries `merge_pr_without_review`.
4. **`merge_context_pr` asks the same question in production.**
   `productionMergeSeams` binds `holdsMergeWithoutReview` to
   `holdsCapability`, so a holder who calls `merge_context_pr` with no
   approval merges too, with the same trailer.
5. **The role editor grants it as `pr.merge_without_review`.** The
   permission sits in the Repository group and names this one capability.
6. **The check writes no audit row of its own.** The kernel's
   `capability.invoke_*` row records the call. The `Oxagen-Approved-By:
   none; merged without review by <user id>` trailer and the promotion
   line's `without_review: true` record the bypass.

## Consequences

- An org Owner holds the capability through the resolver's rule 7.5 on
  every organization, with or without a seeded grant.
- An organization created before this change has no role grant for the new
  capability until its IAM roles are seeded again. Its owners still merge
  without review through `merge_context_pr`'s owner rule, as before.
- A workspace Owner holds it through IAM only when their workspace Owner
  role carries the grant. `merge_context_pr` still lets them merge without
  review.
- The governance mode still decides who may merge at all. In team mode a
  workspace Member who holds the grant is refused `org_role_required`. In
  practice the grant lets an org Admin merge without review in team and
  regulated mode.
- Regulated mode does not exclude the bypass. A holder merges without an
  approval there too, and the trailer names them.
- On a GitLab project that keeps approvals after a push, holders and owners
  are refused, because the merge cannot tell whether it is bypassing an
  approval.
- GitLab does not say which commit an approval covers. The merge counts an
  approval for the newest diff version GitLab recorded before it. GitLab
  keeps approvals across a rebase, so after the merge queue rebases a
  GitLab branch the reviewer approves again. A holder who merges then
  merges without review, and the trailer says so.
- An API key carries no user and is refused `no_principal`.

## Alternatives rejected

- **The kernel's IAM gate.** It allows every call below the enterprise tier,
  so every member would hold the capability.
- **The resolver with `defaultEffect: allow`, as
  `capability-policy-recheck.ts` runs it.** That guard asks whether a
  policy revoked a capability the caller already holds. This question is
  whether the caller holds it at all, so an allow default would make every
  member a holder.
- **A `withoutReview` flag on `merge_context_pr`'s input.** IAM grants a
  capability, not an input field, so a role could not hold the flag.
- **Reading the owner roles only.** That is the rule that existed, and it
  gave an organization no way to let a trusted member merge without review.
