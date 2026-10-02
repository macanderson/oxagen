# ADR-267: A steering PR approval is stored in Oxagen

- **Status:** Accepted. The agent building lane S7 chose this under SCR-002.
  Mac has not ruled on it.
- **Date:** 2026-10-02
- **Owners:** steering
- **Related:** issue #4518 (lane S7, items 5 and 7), ADR-061, ADR-175,
  ADR-213, ADR-232, ADR-263, `packages/handlers/src/steering-repo/merge-queue.ts`
  (`mergeApproval`), `packages/handlers/src/steering.pr.approve.ts`,
  `docs/specs/steering/README.md` (Approval).

## Context

Under the `team` and `regulated` governance modes, `merge_steering_pr` lands
a steering PR only after a workspace member other than the author approves
it at the head that merges. `mergeApproval` read approvals from one place:
the reviews on the host, each linked to an Oxagen user through the person's
GitHub or GitLab account.

The steering PR page has an Approve button (#4518 item 5). It called
`approve_steering_pr`, which nothing registered. Three places could hold the
approval it records:

1. **A review on the host by the Oxagen GitHub App.** GitHub refuses an
   app's approving review of a pull request the app opened, and the Oxagen
   App opens every steering PR. The approval would also name the App, not the
   person.
2. **A review on the host with the person's own token.** Oxagen holds no
   GitHub user token for each member. Item 8 of #4518 stores one token, the
   owner's, for provisioning. Asking every reviewer to authorize a second
   GitHub app to click Approve adds a step and a stored credential per person.
   GitLab would need the same for every member.
3. **A row in Oxagen, at the head the person approved.** The merge reads the
   rows beside the host's reviews.

## Decision

1. **The approval is a row in `agent.steering_pr_approvals`.** It holds the
   proposal, the person, and the PR head they approved, in the workspace's
   tenant scope. One person approves one head once. The row is never updated.
   A push to the branch moves the head, so an older row stops counting and
   stays as the record of what was approved when.

2. **The merge counts both sources under one rule.** `mergeApproval` reads the
   host's reviews and these rows on every call, because the queue asks again
   after each update it makes. An approval counts when it is at a head the
   merge lands (the checked head, or a merge commit the queue made on it), by
   a person other than the author who still holds a role in the workspace, or
   is an org Owner or Admin. A person who approved in both places counts once.
   The `Oxagen-Approved-By` trailer and the promotion line name every approver
   the merge counted, as before. A governance proposal (ADR-232) is approved
   the same way, and still refuses a merge without review.

3. **Only a person signed in to Oxagen approves.** `approve_steering_pr` is on
   the `api` surface only, which the web app reaches with the person's
   session. The handler refuses every API-key call and every call with no user
   (`no_principal`), and an agent run (`agent_run`). API-key auth sets the
   call's user to the person who made the key, so a key an agent holds could
   otherwise approve a change that agent proposed. The capability is off the agent surface for
   the reason ADR-175 gives for `resolve_approval`: a review is a person's
   decision. The author is refused (`author_cannot_approve`), and so is a head
   that moved after the checks ran (`head_moved`), so nobody approves a head
   nobody checked.

4. **`get_steering_pr` answers the approvals recorded in Oxagen at the
   checked head.** It reads the rows and no host, so the page's ten-second
   refresh spends no API budget. A review on the host does not show in the
   count. The merge still counts it.

5. **The managed-block findings of the latest check run are stored on the
   proposal** (#4518 item 7). The check run already reads the files a PR
   changes. When a steering PR in a steering repository changes `AGENTS.md`,
   `CLAUDE.md`, or `README.md`, the run compares the managed block with the
   production branch's and stores each drifted file in
   `steering_proposals.check_findings`. A new run resets it. `get_steering_pr`
   answers it, and the page draws Restore block from it with no host read, for
   the reasons ADR-263 gives for storing code repository findings.

## Consequences

- A steering PR shows no approval on GitHub or GitLab when it was approved in
  Oxagen. The merge commit's `Oxagen-Approved-By` trailer and the ledger line
  name the approver. The host's merge is the App's, as it already was.
- Branch protection that requires a review on the host would refuse the App's
  merge of a PR approved only in Oxagen. Oxagen does not set or read branch
  protection on a steering repository (ADR-237), so this holds only for a
  repository someone configured that way by hand.
- Withdrawing an approval in Oxagen is not built. A push to the branch is the
  way to clear every approval.

## Alternatives considered

- **Keep the host as the only source, and send people to the host to
  approve.** This leaves the Approve button with nothing to do, and a person
  without a linked GitHub or GitLab account could never approve.
- **A JSON column of approvers on the proposal.** One row per approval keeps
  the head each person approved and the time, and needs no read-modify-write
  of a shared column when two people approve at once.
