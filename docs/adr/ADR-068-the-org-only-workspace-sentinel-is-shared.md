# ADR-068: One org-only workspace sentinel, shared by every surface

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** platform
- **Related:** issue #3029 (the org-only REST mount for `create_workspace`
  passes an empty workspace id the kernel refuses), issue #2964,
  `packages/oxagen/src/types.ts`, `packages/oxagen/src/kernel.ts` (the
  `withScope` wrapper), `packages/tenancy/src/scope.ts` (`assertUuid`),
  `apps/api/src/lib/context.ts`, `apps/app/src/server/kernel.ts`,
  `apps/app/ARCHITECTURE.md` §3.2 step 4

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

The org-only shape is sound for the tables involved: `workspace.workspaces`,
`iam.roles` and `iam.role_grants` carry `org_only` RLS policies and ignore
the workspace GUC.

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

## Consequences

- The org-only mount reaches its handler, and the route test asserts the
  context shape the kernel accepts rather than a mocked `invoke` call.
- A later surface that needs an org-only scope has one constant to use and
  one place to change.
- The sentinel is still a value that names no workspace. It is legible in a
  scope assertion and in RLS, and nothing resolves it to a row.
