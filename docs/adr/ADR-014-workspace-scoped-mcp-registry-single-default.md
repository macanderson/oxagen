# ADR-014 — Workspace-scoped MCP registries with a single-default state machine

**Date:** 2026-06-17
**Status:** Accepted
**Epic:** Marketplace workspace-scoping migration

## Context

`mcp.registries` previously mixed two concepts that do not belong together:

1. **Global seed rows** (`org_id IS NULL`, `is_default_seed = true`) — a single platform-wide official MCP registry record used to populate the plugin catalog via a periodic sync job.
2. **Org-added rows** (`org_id = <uuid>`, `is_default_seed = false`) — registries an org admin added for their own use, but without workspace scope.

This caused several problems:

- **No workspace isolation.** All workspaces in an org shared the same registry list. Adding a registry in one workspace exposed it to every other workspace — violating the tenant isolation model.
- **RLS gap.** Rows with `org_id IS NULL` bypassed org-scoped RLS policies. The `plugin.registry.list` handler explicitly included these via `OR org_id IS NULL`, which leaked global rows into every tenant's response.
- **Dead catalog-sync machinery.** The `is_default_seed` + `last_synced_at` + `last_synced_cursor` columns existed solely to drive a catalog sync cron that was replaced by a direct `installed_plugins` query in the marketplace rebuild. These columns were referenced in live code but served no purpose.
- **Removability guard was wrong.** `plugin.registry.remove` blocked deletion of `is_default_seed=true` rows at the application layer, not the DB layer — creating an inconsistent invariant that was impossible to enforce correctly with multiple concurrent writers.

Three options were considered for the default-registry invariant:

**Option A — DB CHECK constraint.** Enforce "exactly one default per workspace" via a CHECK constraint. Not expressible as a standard CHECK (requires aggregate); would need a trigger or application-layer enforcement anyway.

**Option B — Partial unique index + application state machine.** A `UNIQUE (org_id, workspace_id) WHERE is_default = true` partial unique index enforces *at most one* default at the DB level. The application state machine enforces *at least one* when any row exists. This gives a clean invariant with DB-backed safety and no triggers.

**Option C — Separate `default_registry_id` column on workspaces.** Store the default pointer on the workspace row. Avoids the partial unique index but creates a foreign-key circular dependency (workspace → registry → workspace) and complicates the workspace-creation transaction.

## Decision

**Adopt Option B.** Rebuild `mcp.registries` as fully workspace-scoped with a single-default state machine enforced by a partial unique index and two pure helper functions.

### Schema changes (Task 1–3)

- `org_id NOT NULL` — every registry is owned by an org.
- `workspace_id NOT NULL` — every registry is scoped to a workspace.
- `is_default BOOLEAN NOT NULL DEFAULT false` — replaces `is_default_seed`.
- Removed columns: `is_default_seed`, `last_synced_at`, `last_synced_cursor`.
- Added partial unique index: `UNIQUE (org_id, workspace_id) WHERE is_default = true` — at most one default per workspace, enforced at the DB layer.
- Added composite unique index: `UNIQUE (org_id, workspace_id, base_url)` — prevents duplicate registry URLs per workspace.

### State machine (Task 4)

Two helpers in `packages/handlers/src/registry-default.ts` implement all transitions. Both accept a caller-owned `Tx` so they participate in the caller's transaction atomically.

**`addRegistry(tx, { orgId, workspaceId, name, baseUrl })`**

1. `COUNT(*)` registries for `(orgId, workspaceId)` within the same `tx`.
2. If count = 0 → insert with `isDefault = true`.
3. If count ≥ 1 → insert with `isDefault = false`.
4. There is no user-facing API to designate a default on add — the rule is automatic.

**`removeRegistry(tx, { orgId, workspaceId, registryId })`**

1. `DELETE` the row scoped to `(orgId, workspaceId, registryId)` and `RETURNING { id, isDefault }`.
2. If no row matched → return `{ removed: false, promotedId: null }`.
3. If removed row was NOT the default → return `{ removed: true, promotedId: null }`.
4. If removed row WAS the default:
   - Query remaining rows ordered by `created_at DESC LIMIT 1`.
   - If none remain → return `{ removed: true, promotedId: null }`.
   - If a row exists → `UPDATE ... SET is_default = true` on that row and return `{ removed: true, promotedId: <id> }`.

Delete-first ordering is intentional: the partial unique index would conflict if we promoted before deleting (two `is_default = true` rows momentarily). Delete first removes the constraint, then promotion is a clean single-row update.

### Invariant

> With exactly one registry for a workspace, it is always `is_default = true`. There is no `set_default` capability and none will be added — the state machine maintains the invariant automatically.

### Contract updates

`plugin.registry.{add,remove,list}` contracts updated to `scoped: true` with workspace `defaultRoles`, ensuring `ctx.workspaceId` is always populated. Output schemas updated: `isDefault` replaces `isDefaultSeed`/`lastSyncedAt`; `remove` now returns `{ ok, promotedId }`.

### Co-located fix

`organization.create.ts` contained a fire-and-forget call that looked up the global seed registry by `isDefaultSeed = true` to trigger a one-shot catalog sync. This call referenced the now-dropped column and the now-gone global-seed concept. It was removed; the default registry is now seeded per-workspace by `seedWorkspaceDefaultRegistry` at workspace creation time.

## Consequences

**Positive:**
- Workspace isolation enforced at the DB layer — no RLS leakage from global rows.
- Default invariant is DB-backed (partial unique index) and application-backed (state machine helpers) with no triggers.
- Dead columns and dead catalog-sync code removed — simpler schema, no misleading references.
- The `addRegistry` / `removeRegistry` helpers are pure (accept `Tx`), unit-testable without a live DB, and reusable by future bulk-import paths.

**Negative / trade-offs:**
- Delete-first ordering is a subtle correctness constraint — future contributors modifying `removeRegistry` must preserve this ordering or the partial unique index will cause a conflict. The comment in `registry-default.ts` documents this.
- The `seedWorkspaceDefaultRegistry` idempotent seeder is now the only source of the first registry for a workspace. Any workspace-creation path that omits this call will start with zero registries (though `addRegistry` will correctly mark the first user-added one as default).
- API route and MCP surface updates (Task 9) must be completed before the new `scoped: true` contracts are callable from those surfaces.
