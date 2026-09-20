# ADR-118: Approved built-in calls resume once

Status: accepted
Date: 2026-09-19
Related: #3127, ADR-053

## Decision

Approving a built-in call parked by the in-app assistant queues that exact call for a durable worker. The worker creates a new evidence run linked to the approval and its original run. It does not ask a model to reconstruct the call.

Store the original arguments in an encrypted envelope using the existing credential encryption key. Store the digest of the schema-validated arguments alongside it. Re-validate at execution and refuse a changed digest. Persistent previews contain the digest rather than plaintext arguments.

Preserve the human requester. Re-read membership, tool admission, IAM, entitlement, budget, decision rules, and kill switches before dispatch. Mandates remain the kernel's responsibility for agent principals. This path accepts the current in-app human context only. API-key and delegated-agent parked contexts are refused until they have a supported reconstruction contract. External MCP tools keep their existing wait path.

The approval update queues delivery in the same transaction as the decision. A periodic worker provides delivery after request-process failure. A conditional update claims the attempt before invoking the capability. Duplicate deliveries cannot claim it again. The invocation retains the capability's sync or async semantics. An async dispatch is recorded as dispatched, not as completed external work.

This is at most one invocation attempt. A process failure after claiming can leave the external outcome unknown. Recovery marks that attempt indeterminate and does not retry it. Operators must inspect the external outcome before requesting a new action. A late result from the original attempt can still replace indeterminate with its recorded outcome.

Within the approval's expiry window, identical arguments from the same requester and conversation reuse the existing approval, including its resolved outcome. A deliberate identical action needs a new conversation or the end of that window. This bound avoids silently authorizing a second attempt while the first is still in flight.

## Scope

Legacy approvals have no replay payload and remain read-only history. The change adds no background model calls and does not resume an external agent. It completes a call the in-app assistant already proposed. ADR-053's per-turn run rule remains: the original run stays sealed and the resumed call gets a fresh run.
