# ADR-105: An archived workspace accepts no machine credential

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** platform, security
- **Related:** ADR-073 (an API key names a workspace, and so does the page that
  mints it); issue #3123; PR #3116 (the `/{org}/api-keys` workspace picker that
  keeps archived workspaces reachable); `docs/capabilities/workspace.archive.md`
- **Delivered by:** `resolveApiKey` in `packages/auth/src/resolvers/api-key.ts`,
  the `suspendedApiKeys` field on `archive_workspace`

## Context

`archive_workspace` records `archived_at` on the workspace row and changes
nothing else. `resolveApiKey` looks a bearer key up by prefix and hash, checks
soft deletion, expiry and scope purpose, and returns the org and workspace the
key row names. It never read the workspace.

So a key scoped to an archived workspace kept authenticating, on every surface,
for as long as the key existed. Nothing expired it and nothing revoked it. The
product stopped listing those keys, which made it worse: a live credential
nobody could see. #3116 fixed the seeing half by keeping archived workspaces in
the `/{org}/api-keys` picker. What remained is whether the credential should
work at all.

Two answers were on the table in #3123. Refuse to archive while a live key
exists, following the rule that already refuses to archive while an agent is
registered. Or revoke the workspace's keys inside the archival transaction.

Both are worse than the answer below.

**Refusing** leaves the defect standing for every workspace already archived —
the keys stranded in the field keep working, because nothing re-runs the check
for them. It also makes archival a credential hunt: an operator who wants a
workspace out of the way first has to find and destroy every key in it, and the
refusal gives no way to do that in one step. And it is the wrong reading of the
agent precedent. That rule exists because a registered agent is a thing that
would keep acting; it asks the operator to move it. A key is not acting. It is
an authority, and an authority can simply stop being honoured.

**Revoking** destroys credentials as a side effect of a filing action. There is
no `unarchive_workspace` capability in the repo today, but that is a gap, not a
principle — a workspace is archived to get it out of the way, and getting it
back should be possible. A revocation cannot be undone. Choosing it now would
make a one-way door out of a decision that does not need one, and it would
contradict what the contract promises about archival being a shelving.

## Decision

**A key does not authenticate into an archived workspace, and archival revokes
nothing.**

The check lives in `resolveApiKey`, at the one point where a raw key becomes a
tenant scope. After the hash, the expiry and the purpose gates, the resolver
reads the workspace the key names and refuses with a new resolution kind,
`workspace_archived`, when it is archived — or when the workspace row cannot be
read at all, because a scope that cannot be confirmed is not a scope.

`archive_workspace` counts the workspace's live keys in the archival
transaction and returns the number as `suspendedApiKeys`. It writes no key row.
The contract description, the capability doc and the app's confirmation dialog
all say what archival does to credentials.

## Consequences

**Every stranded key is fixed, with no migration.** The check is evaluated per
request against current state, so keys archived away months ago stop
authenticating at the next call. A decision enforced at read time needs no
backfill and cannot be half-applied.

**One chokepoint covers every surface.** `apps/api`'s auth middleware and
`apps/mcp`'s context resolver both call `resolveApiKey`, and so will anything
added later. #3123 noted that the capability is reachable from `api`, `mcp` and
`agent` and that a check on one surface would not enforce it. This is not on a
surface.

**It is reversible.** No credential is destroyed, so restoring a workspace
restores its keys. When `unarchive_workspace` is built it needs no credential
story of its own.

**It costs one indexed read per authenticated request.** A primary-key lookup
on `workspace.workspaces`, on the hot path. That is the price of the check
being evaluated rather than remembered, and it buys the property above. If it
ever shows up in a profile, the workspace state joins the key lookup in a
single query; it does not move out of this resolver.

**The refusal is legible.** `apps/api` answers 401 naming the archived
workspace, and `apps/mcp` carries a `workspace_archived` failure reason rather
than folding it into `invalid_token`. An operator whose script stops working is
told why on the first try.

**The keys stay listed and revocable.** They are suspended, not gone, so the
`/{org}/api-keys` picker from #3116 remains the supported way to reach one and
revoke it for good.
