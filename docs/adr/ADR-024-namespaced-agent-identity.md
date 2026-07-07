# ADR-024 — Namespaced, immutable agent identity (`org_ns.workspace_ns.agent_slug`)

Status: Accepted · Date: 2026-07-07
Related: ADR-022 (capability naming), `docs/specs/a2a-agent-identity/spec.md`, `docs/specs/agent-rbac/spec.md`.

## Context

Agents need a human-readable identifier that is globally unique across every
tenant and stable for the agent's entire life. Today an agent is addressed by
a workspace-scoped slug (A2A `metadata.skillId`), a `agt_…` public id, or a
raw UUID — none of which is simultaneously human-readable, global, and
immutable. Org and workspace **slugs cannot serve as the global prefix**: both
are renameable by design (`org_slug_history` / `workspace_slug_history` exist
precisely to track renames), and they are uncapped in length.

This is wedge-relevant: the accountability chain (identity → knowledge scope →
permitted action → billing → audit) needs one identity string that a customer
can put in a bill, an audit row, an A2A address, or an IAM grant and trust it
never dangles or gets recycled.

## Decision

1. **Namespaces, not slugs.** Organizations and workspaces each get a
   `namespace` column: citext, `^[a-z0-9]{2,6}$`, auto-derived from the slug
   at creation (stripped of non-alphanumerics, truncated, numerically
   de-conflicted). Org namespaces are globally unique; workspace namespaces
   unique per org. Like Linear team keys, namespaces are a short, permanent
   prefix identity, deliberately decoupled from the renameable display slug.
2. **The agent key.** `agentKey = org_namespace + "." + workspace_namespace +
   "." + agent_slug`. New agent slugs are capped at 18 characters, so a new
   agent's full key never exceeds **32 characters** (6+1+6+1+18). Existing
   agents with longer slugs are grandfathered — their keys are still unique
   and immutable, merely longer.
3. **100% immutable, enforced in the database.** BEFORE UPDATE triggers reject
   any change to `organizations.namespace`, `workspaces.namespace`, and
   `agent.agents.slug`; a BEFORE INSERT trigger rejects new agent slugs over
   18 chars (INSERT-only, so grandfathered rows keep updating). Contract and
   UI immutability are conveniences; the trigger is the guarantee.
4. **Exposure.** `agent.definition.get`/`.list` return `agentKey` (nullable
   only pre-backfill). UI surfaces show the key as the copyable identifier —
   never the raw UUID (per the existing citation rule).

## Consequences

- A2A addressing, IAM principals (agent RBAC spec), billing line items, and
  audit rows can all reference one stable string; renames of org/workspace
  slugs never affect it.
- Namespace collisions at derivation are resolved once, at creation time —
  the cost of a slightly less pretty namespace, in exchange for permanence.
- **Deleted agents permanently reserve their slug** (like npm package names).
  The previous partial unique index (`WHERE deleted_at IS NULL`) would have
  let a new agent claim a deleted agent's key; uniqueness now covers
  soft-deleted rows, so a key can never point at two different agents across
  time. Audit rows still carry the `agt_…` public id alongside the key.
- Namespaces are not user-editable in v1 (auto-derived). A creation-time
  namespace picker can be added later — it only relaxes derivation, never
  immutability.
