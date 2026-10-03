# ADR-118: Approved built-in calls resume once

Status: accepted
Date: 2026-09-19
Related: #3127, ADR-053

## Decision

Approving a built-in call parked by the in-app assistant queues that exact call for a durable worker. The worker creates a new evidence run linked to the approval and its original run. It does not ask a model to reconstruct the call.

Store the original arguments in an encrypted envelope using the existing credential encryption key. Store the digest of the schema-validated arguments alongside it. Re-validate at execution and refuse a changed digest. Persistent previews contain the digest rather than plaintext arguments.

Preserve the human requester. Re-read membership, tool admission, IAM, entitlement, budget, decision rules, and kill switches before dispatch. Mandates remain the kernel's responsibility for agent principals. This path accepts the current in-app human context only. API-key and delegated-agent parked contexts are refused until they have a supported reconstruction contract. External MCP tools keep their existing wait path.

The approval update queues delivery in the same transaction as the decision. A periodic worker provides delivery after request-process failure. It scans the shared plane and discovers dedicated workspaces through the control plane, then reads their approvals through tenant routing. A failed dedicated scan is logged and retried on the next pass. A conditional update claims the attempt before invoking the capability. Duplicate deliveries cannot claim it again. The invocation retains the capability's sync or async semantics. An async dispatch is recorded as dispatched, not as completed external work.

This is at most one invocation attempt. A process failure after claiming can leave the external outcome unknown. Recovery marks that attempt indeterminate and does not retry it. Operators must inspect the external outcome before requesting a new action. A late result from the original attempt can still replace indeterminate with its recorded outcome.

Within the approval's expiry window, identical arguments from the same requester and conversation reuse the existing approval, including its resolved outcome. A deliberate identical action needs a new conversation or the end of that window. This bound avoids silently authorizing a second attempt while the first is still in flight.

## Scope

Legacy approvals have no replay payload and remain read-only history. The change adds no background model calls and does not resume an external agent. It completes a call the in-app assistant already proposed. ADR-053's per-turn run rule remains: the original run stays sealed and the resumed call gets a fresh run.

## Checks at execution

Amended 2026-10-03. #3127 asked this ADR to state which checks run again when the approved call runs, and against which snapshot. ADR-235 (2026-09-30) took the workspace's decision rules and customer budgets off Stella's calls, so the list in the Decision section is out of date. This is the rule the code follows now.

Every check reads the state at the moment the call runs. None reads the parked run's `authorization_snapshot`, and the parked run is never reused. The resume opens a new run, and that run's admission is the only snapshot the call answers to.

The resume checks, in this order (`resumeApprovedCall` in `packages/agent/src/runtime/approval-resume.ts`):

1. The stored payload still belongs to this approval, organization, workspace, message and capability, and the arguments still parse to the approved digest.
2. The person who asked still holds an organization or workspace role.
3. A fresh tool listing, built with those roles, still offers the capability. That listing applies IAM, tool admission and every active kill switch or emergency deny.
4. The kill switches are read again at the call. The call is not read-only, so the gate re-reads the deny generation first and picks up a switch flipped since the listing.
5. The approval has not expired.
6. The kernel checks IAM, plugin entitlement, and the credit and billing admission gate at `invoke`.

Three checks skip this call. The workspace's decision rules and customer spend ceilings do not govern Stella (ADR-235). Mandates govern agent principals, and this call runs as the human who asked, so no mandate applies.

A check that refuses records the approval as `failed`, with the refusal's code as its reason, and the call does not run. The person reads the reason on the parked card and in the approval history. The next turn that asks for the same call gets the decision and the reason back instead of a new card. The kernel tells the resume when the handler starts (`onHandlerStart`). Only a failure after that point is `indeterminate`. Before this amendment an IAM or credit refusal at `invoke` read as `indeterminate`, so the person was told to check a run whose call never ran.

The approving request delivers the call itself and answers with the outcome. The periodic worker (`approval/resume`) delivers a call that is still queued because that request stopped. Both deliveries take the same conditional claim, so the call runs once.
