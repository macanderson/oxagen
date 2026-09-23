# ADR-155: Runtime installations, harness principals, and accountable operators

Date: 2026-09-23
Status: Proposed implementation plan. The user approved the identity model and necessary migrations. No migration has been applied for this ADR.

## Problem

A `tacho.hosts` row currently combines an enrolled installation, one agent binding, and an array of harness names. Its partial unique index permits only one live enrollment per agent key. A copied device key cannot prove unique physical hardware, and a hostname cannot identify an installation. The agent's delegated IAM principal often names its registering human through `parent_user_id`, but old rows can lack that relationship and removing a member does not suspend every delegated agent.

The Runtimes page needs durable installation identity and explicit agent bindings. Every agent that may act needs an accountable human operator. Neither requirement needs a second IAM system.

## Decision

Reuse `iam.principals`. Runtime and harness installations have `kind = service`; agents retain `kind = agent`; accountable operators retain `kind = human`. Typed Postgres associations explain what a service principal represents. Names, versions, operating-system users, and hostnames are reported attributes, not authority or identity keys.

The control plane governs activity at these identities. It does not execute the agent workload. An installation principal identifies enrolled software and its key, not a verified physical computer.

## Records and invariants

| Record | Scope and identity | Required associations |
| --- | --- | --- |
| Runtime installation | Organization, new `rti_` public ID | One service principal and enrollment device public key/fingerprint |
| Harness installation | Runtime, new `hri_` public ID | One service principal, runtime ID, stable local installation UUID, harness name, and reported version |
| Agent binding | Existing `tacho.hosts` enrollment ID and credentials | Runtime ID, registered agent ID/principal, and explicit harness-installation binding rows |
| Agent accountability | Existing agent/principal | An active human principal in the same organization, backed by that person's active organization membership |

Use separate `tacho.runtime_installations`, `tacho.harness_installations`, and `tacho.host_harness_bindings` tables. Add `runtime_installation_id` to `tacho.hosts`. Keep the existing enrollment, session, gateway-key, evidence, and receipt IDs unchanged.

Require one live host binding per `(org_id, workspace_id, runtime_installation_id, agent_id)`. Harness associations are unique per `(host_id, harness_installation_id)`. A harness installation's local UUID is unique within its runtime. The old `(org_id, agent_key)` live-host index is removed only after the replacement constraints and binding checks exist.

Use the existing agent principal's `parent_user_id` as its accountable auth-user reference, and resolve that user's human principal through the existing organization IAM mapping. Do not add a competing operator relationship in metadata. New agent creation requires an explicit operator public ID; the UI may preselect the registering human but must submit the choice. Reassignment uses a governed capability and validates active same-organization membership. The database must reject activation of an agent principal without an operator reference. Runtime authorization must also reject a missing, suspended, deleted, or nonmember operator.

## Enrollment and local state

Creating a runtime installation requires an authorized human and records its device key. Adding an agent binding to an existing runtime requires both human enrollment authority and proof of possession of that runtime key. Use a server-issued, short-lived, single-use challenge bound to organization, runtime, agent, workspace, and requested harness-installation IDs. Verify its Ed25519 signature before consuming the enrollment token and minting keys, within the same transaction. A caller-supplied runtime ID or matching hostname is insufficient.

The collector persists its installation UUID and device key independently from per-agent enrollment documents. Each harness installation has its own stable UUID; upgrading its version changes an attribute, not its principal. Enrollment tokens and signed enrollment claims carry the resulting typed runtime and harness references. Existing host IDs stay the binding IDs. An old client can enroll a new isolated runtime binding during transition, but cannot attach to an existing runtime without proof.

Do not deduplicate historical rows by hostname or fingerprint. Backfill one runtime per existing enrollment and one harness installation per recorded harness entry. Shared-key consolidation is a later authorized operation that requires ownership and proof. A cloned installation key still represents that installation; the UI states that limit.

## Enforcement and revocation

The existing kernel machine-key gate checks the enrollment binding before its tier shortcuts: active runtime service principal, active harness association when the request names a harness, active agent principal, and valid accountable human. Keep each existing credential purpose's capability allowlist. No ordinary caller-authored key scope can create or claim a runtime binding.

Runtime revocation suspends its service principal and every child harness principal, revokes all live agent enrollments under it, retires every server-owned host/gateway credential through `retireEnrollmentKeys`, and queues the existing revoke commands. Revoking an agent revokes only that agent's bindings and keys, leaving other agents on the runtime intact. A server revoke does not claim that local hooks were removed.

Removing an operator either reassigns their agents to another validated human in the same transaction or suspends those agents and their authorization immediately. Default to suspension if no replacement was supplied. An agent cannot be resumed until an operator is assigned. Check this in all member-removal and agent-resume paths, not only in the new UI.

## Migration and rollout

1. Add typed installation and binding tables, tenant policies, grants, and columns without deleting historical records. Backfill conservative installation identities and IAM service principals. Keep revocation and suspension state.
2. Preserve valid existing agent operator associations. Suspend agents with missing, invalid, or departed operators and mark assignment required. Do not choose a creator or an organization owner as a guess. Retire their live machine credentials so older runtime paths also fail closed.
3. Install the replacement binding uniqueness, agent activation check, and immutable tenant relationships. Then remove the one-live-host-per-agent index.
4. Deploy enrollment, IAM checks, lifecycle cascades, and collector local-state migration with the schema. Existing signed historical claims remain verifiable; current authorization resolves the stored binding rather than rewriting old claims.
5. Ship organization-scoped Runtimes list/detail and existing enrollment controls with installation principals, human operators, harness names/versions, reported health, and separate per-run earned tiers. Use the shared harness icons. Do not present configured policy or reported hook health as earned enforcement.

Before mutation, review the exact Atlas SQL and sanitized target. Apply migration before dependent code. Verify counts, missing associations, blocked unknown-operator agents, and credential retirement. Retain a backup and the pre-migration counts. Roll back application traffic if verification fails; do not drop the new associations or reactivate suspended unknown identities to make a rollback appear healthy.

## Verification

CI must cover two agents on one runtime, one agent on two runtimes, multiple harness installations, cross-organization proof replay, consumed/expired challenges, foreign operator assignment, departure during a request, resume without operator, agent-only revocation, runtime cascade, and legacy backfill without hostname deduplication. Assert SQL predicates and resulting authorization rather than mocks that discard tenant filters. Keep existing CLI-session and every machine-purpose regression test.

Component tests cover operator selection, assignment-required states, runtime bindings, forbidden mutations, and reported-versus-earned labels. No local test suite, build, or typecheck is authorized outside configured git hooks for this work.

## Boundaries

This ADR does not introduce witness, proof-of-value, or product DoD. Containment remains separate and must use these enrollment bindings when resumed. Historical evidence remains attributed to its original enrollment IDs and claims.
