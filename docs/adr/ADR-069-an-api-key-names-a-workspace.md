# ADR-069: An API key names a workspace, and so does the page that mints it

- **Status:** Accepted
- **Date:** 2026-09-16
- **Owners:** platform, app
- **Related:** ADR-068 (the org-only workspace sentinel is shared),
  ADR-067/#3063 (a key acts for its creator), issue #2964,
  `packages/database/src/schema/auth.ts` (`auth.api_keys`),
  `packages/database/src/tenant-policy.manifest.ts`,
  `packages/auth/src/resolvers/api-key.ts`,
  `packages/handlers/src/api.key.list.ts`,
  `packages/handlers/src/api.key.create.ts`,
  `apps/app/src/server/kernel.ts`,
  `apps/app/src/app/[org]/api-keys/page.tsx`,
  `apps/app/ARCHITECTURE.md` §1.2 (the API keys row) and §3.3 (the `org` port)

## Context

`auth.api_keys` carries `orgScopeMixin`: `org_id` and `workspace_id` are both
`NOT NULL`. `packages/database/src/tenant-policy.manifest.ts:83` records the
table as policy class `standard`, and `tools/scripts/gen-rls-migration.ts:87`
generates that class as

```sql
USING      (… OR (org_id = current_org_id AND workspace_id = current_workspace_id))
WITH CHECK (… OR (org_id = current_org_id AND workspace_id = current_workspace_id))
```

The stored workspace is not a label on the key. `resolveApiKey`
(`packages/auth/src/resolvers/api-key.ts:115-160`) reads `org_id` and
`workspace_id` off the row and returns them, and every bearer surface builds
its `CapabilityContext` — and therefore its `runInTenantScope` — from that
pair. A key's workspace is the tenant scope of every request the key
authenticates.

`/{org}/api-keys` was built as an organization page over an `OrgCtx`
(ARCHITECTURE.md §3.3, `apiKeys(ctx: OrgCtx)`). The app's kernel seam
translates an `OrgCtx` to `ORG_ONLY_WORKSPACE_ID`, the nil-uuid sentinel
ADR-068 shares between the app and the API. Against a `standard` table that
sentinel has two effects, and the page had both:

- **The roster listed nothing that exists.** `list_api_keys` filters on
  `org_id` AND `ctx.workspaceId` (`api.key.list.ts:93-96`), and the RLS
  `USING` clause compares the same column to the same GUC. Under the sentinel
  every key bound to a real workspace is outside both, so an org Owner saw
  none of the organization's credentials and could rotate or revoke none of
  them.
- **Minting wrote a key into a workspace that does not exist.**
  `create_api_key` persists `ctx.workspaceId` (`api.key.create.ts:139`). The
  sentinel equals the GUC, so `WITH CHECK` passes and the insert succeeds —
  this is the one write ADR-068's exception class does not catch, because it
  is not refused. The secret shown once then names a workspace no row
  answers to, so the credential authenticates into nothing.

ADR-068 settled what a surface with no workspace may touch: `org_only` tables
directly, and a workspace-GUC-scoped table only by re-entering the target
workspace's scope. `auth.api_keys` is not `org_only`. The rule therefore
applies, and the question this ADR answers is which workspace an organization
page re-enters.

Two designs were on the table.

**Make the key genuinely org-scoped** — `workspace_id` nullable, the table
reclassified `workspace_nullable`, the RLS regenerated. This changes the
credential rather than the page. Every consumer of `resolveApiKey` — the API's
auth middleware, the MCP server's context, the tacho host, the Stella
telemetry ingress — derives a tenant scope from the key's workspace, and a key
with none could reach no `standard` or `workspace_only` table, which is nearly
every table an agent's work touches. It would enlarge the blast radius while
making the credential weaker, and the nullable column would put the nil
sentinel's ambiguity into the schema instead of taking it out.

**Name a real workspace** — the page picks one, the viewer resolves into it,
and the key is minted and listed in that workspace's scope. This is what the
CLI consent page already does at the one other place in the app that mints a
key: `approveCliAuth` reads an org slug and a workspace slug from the form and
passes both to `requireViewer` (`apps/app/src/features/auth/cli-actions.ts:45-48`).

## Decision

1. **An API key names a workspace.** The schema, the policy class and the
   resolver stay as they are. `workspace_id` on `auth.api_keys` is part of the
   credential's identity, not a filter over it.

2. **`/{org}/api-keys` names a workspace too.** The workspace is a query
   value on the existing route — `?workspace=<slug>` — so the page count and
   `e2e/routes.ts` are unchanged (§1.2, the same move Spend makes for its tab
   and drill). The page offers the workspaces `list_workspaces` returns the
   viewer a membership in, defaults to the first, and resolves the chosen one
   through `requireViewer(org, ws)`, which is where workspace membership is
   checked (INV-15).

3. **The `org` port splits by scope.** `org.apiKeys` takes a `WsCtx`; a new
   `org.workspaces` takes the `OrgCtx` and reads `list_workspaces` for the
   picker. `ApiKeys` reads no keys at all when the organization has no
   workspace the viewer may enter, and says so.

4. **The three writes take the workspace slug.** `createApiKey`,
   `rotateApiKey` and `revokeApiKey` take `(org, ws, …)` and resolve
   `requireViewer(org, ws)`. They take slugs, never tenant ids, so INV-19's
   rule that an action reads no org or workspace id off its input still holds.

5. **ARCHITECTURE.md §3.3's `apiKeys(ctx: OrgCtx)` is amended** to
   `apiKeys(ctx: WsCtx)` beside `workspaces(ctx: OrgCtx)`, and the §1.2 API
   keys row records the workspace query value.

## Consequences

- An org Owner or Admin sees, rotates and revokes the keys of each workspace
  they are a member of, one workspace at a time, and every key they mint is
  usable. Before this, they saw none and minted unusable ones.
- A key in a workspace the viewer holds no membership in is not on this page.
  That is the same boundary every other workspace-scoped surface in the app
  keeps — Fleet, Run, Agents and Spend all take a `WsCtx` — and it is the
  boundary the credential itself carries. An organization-wide roster across
  workspaces the viewer is not in is a different read: it would enumerate the
  organization's workspaces and re-enter each scope under ADR-068's rule, and
  it needs its own contract and its own decision. It is not this page.
- The nil sentinel keeps exactly the meaning ADR-068 gave it. Nothing here
  relaxes a policy or widens what the sentinel may touch; the page stops
  handing it to a `standard` table, which is what ADR-068 already said to do.
- Keys already written with the nil workspace by this page before it shipped
  authenticate into no workspace and are inert. They are listed by no scope
  and revoked by none. Cleaning them up is a data task against
  `auth.api_keys WHERE workspace_id = '00000000-0000-0000-0000-000000000000'`,
  not an app change, and it is safe to run at any time because no such key
  can succeed at `resolveApiKey`'s callers.
- Rotation still inherits the rotated key's expiry (`api.key.rotate.ts:151`),
  so the page offers Rotate only on a key that has not expired; an expired key
  keeps Revoke. That is a UI consequence of the contract, recorded here so the
  next change to `rotate_api_key` knows what the page depends on.
