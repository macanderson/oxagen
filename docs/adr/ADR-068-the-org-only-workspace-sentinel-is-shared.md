# ADR-068: One org-only workspace sentinel, shared by every surface

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** platform
- **Related:** issue #3029 (the org-only REST mount for `create_workspace`
  passes an empty workspace id the kernel refuses), issue #2964,
  `packages/oxagen/src/types.ts`, `packages/oxagen/src/kernel.ts` (the
  `withScope` wrapper), `packages/tenancy/src/scope.ts` (`assertUuid`),
  `apps/api/src/lib/context.ts`, `apps/app/src/server/kernel.ts`,
  `apps/app/ARCHITECTURE.md` §3.2 step 4,
  `packages/database/src/tenant-policy.manifest.ts`,
  `packages/handlers/src/workspace.settings.write.ts`,
  `packages/handlers/src/workspace-bootstrap.ts`

## Context

`invoke` wraps every scoped capability in `runInTenantScope`, which asserts
that both tenant ids are uuids. A surface that has an organization but no
workspace had no legal value to pass.

`apps/app` solved it with a uuid-shaped constant that names no workspace,
declared in its kernel seam, and §3.2 step 4 said the sentinel "lives in this
builder and nowhere else". `apps/api` did not have it: `capabilityContext(c,
{ requireWorkspace: false })` passed `""`, so `POST /v1/:org_slug/workspaces`
raised `TenantScopeError` before its handler ran, and the API's error
middleware had no mapping for that error, so the caller got a 500. The route
test mocked `invoke`, which is why the mount read as working.

The sentinel is only sound for tables whose RLS policy ignores the workspace
GUC, and that is a property of the TABLE, not of the capability. Postgres
evaluates `tenant_isolation` per relation against
`app.current_workspace_id`, which `withTenantDb` sets from the scope — so
under an org-only scope that GUC holds the nil sentinel, which names no row.
`packages/database/src/tenant-policy.manifest.ts` is where each table's class
is recorded:

- `org_only` (`workspace.workspaces`, `iam.roles`, `iam.role_grants`) keys on
  `app.current_org_id` alone and genuinely ignores the workspace GUC. The
  reads and writes an org-only surface was built for stay inside this set.
- `standard` (org + workspace, both `NOT NULL`) and `workspace_only`
  (workspace only) compare the row's `workspace_id` against the workspace
  GUC in both `USING` and `WITH CHECK`. A row carrying a real workspace id
  written under the sentinel fails that check and Postgres raises `42501`.
- `workspace_nullable` (org `NOT NULL`, workspace nullable) is the quiet
  one. Its predicate is `org_id = <org GUC> AND (workspace_id IS NULL OR
  workspace_id = <workspace GUC>)`, so under the sentinel a read is answered
  the org-wide rows and nothing else: every row scoped to a real workspace is
  absent, and nothing is raised. A write is refused with `42501` like the
  other two; a READ is simply short. That is worse than a refusal, because a
  refusal stops. `packages/handlers/src/lib/iam-roles.ts`
  (`activeAssignmentCount`, on `iam.principal_role_assignments`) is the case
  that found this: `delete_role` counted a role's holders on the caller's own
  transaction, was answered zero, and deleted the role and its grants out from
  under live assignment rows.

Three capabilities reachable from an org-only scope leave the `org_only` set.
Neither write was caught before the sentinel shipped, because `42501` is not
`23505` and so escapes the `isUniqueViolation` catch each handler has — it
surfaces as a 500. The read was caught later still, because it raised nothing
at all:

- `update_workspace_settings` inserts into `workspace.workspace_slug_history`
  (`standard`) on every slug change. A name-only edit works, which is why
  this read as sound; the re-slug does not.
- `create_workspace` bootstraps `workspace.workspace_users`
  (`workspace_only`), `agent.agents` and `environments.environments`
  (`standard`), on the caller's transaction (issue #3029).
- `delete_role` counts the role's holders in
  `iam.principal_role_assignments` (`workspace_nullable`) before deleting it.
  Under the sentinel that count sees only the org-wide assignments, so a role
  held in a workspace read as held by nobody.

**The rule, and its exception class.** A capability reached from an org-only
scope may read and write `org_only` tables directly. An ORG-WIDE READ of a
`workspace_nullable` table must not be made in the caller's scope at all —
there is no single workspace to re-enter, because the question spans every
workspace of the organization — so it goes through `withSystemDb` with the
`org_id` predicate written out at the call site, the way `list_iam_roles`
already answered the same question. A write that touches a
workspace-GUC-scoped table MUST first re-enter the target workspace's scope
— `runInTenantScope({ ...getPrincipalAttribution(), orgId, workspaceId })`
around the `withTenantDb` that performs it, the way `archive_workspace`
already does for `agent.agents`. Where the target workspace does not exist
until the transaction is under way, as in the create bootstrap, the same
move is made inside that one transaction with
`setTransactionWorkspaceScope`, so the workspace and everything that makes it
usable still commit together. The sentinel is not a licence to write
workspace-scoped rows without a workspace.

Three options were on the table in #3029: share the app's sentinel, add a
kernel-side rule that a scoped capability may declare it needs no workspace,
or drop the org-only mount. The second changes the kernel's contract surface
for one route. The third removes the only way a session with no workspace
creates one over REST.

## Decision

1. **`ORG_ONLY_WORKSPACE_ID` is exported from `@oxagen/oxagen`**
   (`packages/oxagen/src/types.ts`), beside `CapabilityContext`, which is
   what every surface builder already imports. It is the one definition.

2. **Both surface builders use it.** `apps/app`'s kernel seam passes it for
   an `OrgCtx`, and `apps/api`'s `capabilityContext` passes it when the route
   requires no workspace and an organization is in scope. It is not placed in
   `@oxagen/tenancy`: `apps/app/src/**` may not import that package
   (ARCHITECTURE.md §2, INV-03), so a definition there could not be shared
   with the app.

3. **`TenantScopeError` is a 4xx on the API.** The error middleware
   duck-types the error's `code` the way the kernel does, so the middleware
   takes no dependency on `@oxagen/tenancy`, and answers 400
   `invalid_tenant_scope`. A scope the kernel refuses to enter is a bad
   request from the surface that built the context, never a server fault.

4. **ARCHITECTURE.md §3.2 step 4 is amended.** The sentence that the sentinel
   lives in the app's builder and nowhere else is replaced by the shared
   constant and its two callers.

5. **A write reached from an org-only scope that touches a workspace-GUC-scoped
   table re-enters the target workspace's scope**, as set out in Context. The
   two known cases are fixed accordingly: `workspace.settings.write` wraps its
   update and slug-history capture in `runInTenantScope` on the resolved
   target, and `workspace-bootstrap` moves the transaction's workspace scope
   onto the new row with `setTransactionWorkspaceScope` before writing anything
   workspace-scoped. `packages/database/integration/org-only-scope-writes.test.ts`
   holds both halves against a real Postgres with RLS enforced.

6. **An org-wide read of a `workspace_nullable` table goes through
   `withSystemDb` with an explicit `org_id` fence.**
   `postgresRoleStore.activeAssignmentCount` does, so `delete_role` is answered
   the organization's holders rather than the scope's. The same integration
   suite holds this half: it seeds one workspace-scoped and one org-wide
   assignment of a role and asserts the sentinel's scope is shown one of them,
   another workspace's scope one, the target workspace's scope both, and an
   `rls_bypass` read with the org fence both.

## Consequences

- The org-only mount reaches its handler, and the route test asserts the
  context shape the kernel accepts rather than a mocked `invoke` call.
- A later surface that needs an org-only scope has one constant to use and
  one place to change.
- The sentinel is still a value that names no workspace. It is legible in a
  scope assertion and in RLS, and nothing resolves it to a row.
- Because it names no workspace, it is refused by every `standard` and
  `workspace_only` policy rather than silently matching one. That is the
  behaviour we want — a scope that names no workspace must not be able to
  write a workspace's rows — and it is why the exception class above is a
  rule about re-entering scope and never about relaxing a policy.
- The policy classes this ADR reasons about live in
  `packages/database/src/tenant-policy.manifest.ts`, and
  `integration/manifest-coverage.test.ts` fails CI when a table's class drifts
  from the live schema. A future table that an org-only surface reaches is
  therefore visible, and the rule above says what to do about it.
