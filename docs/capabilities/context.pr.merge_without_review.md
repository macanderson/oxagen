# merge_pr_without_review

**Name:** `merge_pr_without_review`
**Domain:** context
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api
**Why api only:** The merger is a signed-in user. An API key (the MCP bearer) carries none and is refused `no_principal`, so the MCP surface is not declared.
**Risk level:** high (requires approval on the agent surface)
**Billing:** `noBillingGate: true`
**Mutates:** yes
**Roles:** org Owner and workspace Owner by default (`defaultEffect: deny`). An org Owner or Admin grants it to another role as the permission `pr.merge_without_review`. The handler asks the IAM resolver on every plan.

## Intent

This capability merges a Context PR that nobody approved ([ADR-213](../adr/ADR-213-merge-without-review-is-a-grantable-permission.md)). It is [`merge_context_pr`](context.pr.merge.md) with one gate moved.

Outside `solo` mode, `merge_context_pr` needs an approval on the host at the head that merges. An owner may merge without one. This capability lets a member of any role the organization grants it merge without one too.

The handler first asks the IAM resolver whether the caller holds `merge_pr_without_review` in the workspace. The kernel's IAM gate allows every call below the enterprise tier, so the handler does not rely on it. A caller who does not hold the capability is refused `merge_without_review_not_held`, and nothing is read or merged.

A holder then runs the `merge_context_pr` handler. Every other refusal still applies:

- Every check must have passed.
- The governance mode must let the caller merge. In `team` mode that is an org Owner or Admin, or a workspace Owner, other than the author. A workspace Member who holds this capability is still refused `org_role_required`.
- The repository must be healthy.
- The head must be the commit the checks ran on.
- On GitLab, the project must reset approvals on push. Otherwise the merge is refused `approvals_not_head_bound`, holders included. An approval counts for the newest diff version GitLab recorded before it, as [`merge_context_pr`](context.pr.merge.md) describes.

An approval that already stands at the head is recorded as that approval. Without one, the `Oxagen-Approved-By` trailer reads `none; merged without review by <user id>`, and in a steering repo the promotion line records `without_review: true`. The `steering.published` audit event carries this capability's name. The trailer and the promotion line, not the event, say whether anybody reviewed the change.

`merge_context_pr` asks the same IAM question. A holder who calls it without an approval also merges, with the same trailer. This capability exists so that a caller can ask for the bypass by name, and so that a role can hold it.

A governance proposal (#4795) never merges without review. This capability refuses one `review_required`, and `merge_context_pr` refuses a holder with no approval the same way. Apply now in `set_governance_mode` is the recorded override for a governance change ([ADR-232](../adr/ADR-232-a-steering-repositorys-governance-mode-changes-through-a-steering-pr.md)).

## Input

`{ proposalId: prp_… }`, the input of `merge_context_pr`.

## Output

The output of `merge_context_pr`.

| Field | Type | Notes |
| --- | --- | --- |
| `proposalId` | `string` | |
| `status` | `"merged"` | |
| `record` | `{ id (ctr_…), lineageId, version, path }` | The published record and the version this merge created |
| `mergedCommit` | `string` | The host's merge commit |
| `promotionEvent` | `{ id (ctp_…), seq, chainDigest }` | The ledger entry |
| `bundleVersion` | `{ before, after }` | The number of promotion ledger entries before and after. It counts merged records, not steering versions |
| `publishedVersion` | `number` or `null` | The steering version this merge published, the number in its `Oxagen-Version` trailer. Null in a legacy repository, and null when publish() did not make the version live |

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | The call carries no signed-in user (an API key). Nothing is read. |
| `forbidden` | `merge_without_review_not_held` | The caller does not hold `merge_pr_without_review` in the workspace. Nothing is read or merged. |
| every other | | Each refusal of [`merge_context_pr`](context.pr.merge.md#errors) except `approval_required`, which a holder never meets. |
