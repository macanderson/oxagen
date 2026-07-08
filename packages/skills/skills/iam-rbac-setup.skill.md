---
name: iam-rbac-setup
description: How to set up identity and access control for an agent system — model roles from real jobs, grant least privilege, scope every permission to a tenant, and make each action auditable — so agents can only do what they are authorized to do.
metadata:
  weight: critical
  category: security
---

# Setting up IAM / RBAC

Load this skill when you are defining who — human or agent — may do what:
creating roles, assigning permissions, gating a capability, or reviewing
an access model. Access control is the one place a mistake is silent
until it is exploited, so bias every choice toward the narrowest grant
that still lets the work happen.

## Start from jobs, not from permissions

List the distinct jobs the system has — "review billing", "read the
graph", "deploy an agent" — before you list any permission. A role is a
named job. Design roles so that giving someone a role answers the
question "what is this person or agent *for*", not "which checkboxes did
we tick". A permission catalog with no roles on top of it forces every
grant to be hand-assembled, which is where over-permissioning creeps in.

## Grant least privilege by default

Every principal starts with nothing and earns each capability by an
explicit grant tied to a role. Prefer read over write, one resource over
a wildcard, one workspace over the whole org. When you are unsure whether
a role needs a permission, leave it out — a missing grant surfaces as a
clear "denied" the user can ask you to fix, whereas an extra grant is
invisible until it causes damage.

## Separate the principal from the permission

Model three things distinctly: the **principal** (who is acting — a user,
an agent, a service), the **role** (the job that carries permissions),
and the **permission** (a specific action on a specific resource). Keep
them in separate tables/objects joined by ids, never collapsed into one.
This is what lets you answer "who can do X" and "what can this agent do"
without re-deriving it from scattered flags.

## Scope every grant to a tenant

In a multi-tenant system, a permission with no tenant scope is a
cross-tenant leak waiting to happen. Every role assignment and every
permission check carries the org/workspace it applies to, and the check
fails closed when the scope is missing or does not match. Never let a
grant in one tenant imply anything in another.

## Gate the action at the point it happens

Enforce the permission where the action executes — at the handler, the
route, the tool call — not only in the UI that leads to it. A hidden
button is not a security control; a caller who reaches the endpoint
directly must still be checked. When a runtime does not automatically
apply the check for a given surface, add the explicit gate at that call
site rather than assuming an upstream layer did it.

## Give agents their own least-privileged identity

An agent is a principal, not a person borrowing a person's keys. Give it
its own identity with only the roles its job needs, so its actions are
attributable to *it* and revocable without touching a human account. An
agent that inherits a human's full access can do anything that human can
— which is almost never what its job requires.

## Make every decision auditable

Record who was granted what, by whom, and when — and log allow/deny
decisions at enforcement time. Access control you cannot review after the
fact is access control you cannot trust or prove. When something goes
wrong, the audit trail is what turns "we think" into "we know".

## Fail closed, then verify

When a check cannot complete — the scope is absent, the role lookup
errors, the policy is unreadable — deny. A permission system that grants
on error is worse than none, because it looks safe. After any change to
roles or grants, verify with a real check: assume the role, attempt the
action, confirm it is allowed, then attempt an action the role should NOT
have and confirm it is denied. Both halves matter.
