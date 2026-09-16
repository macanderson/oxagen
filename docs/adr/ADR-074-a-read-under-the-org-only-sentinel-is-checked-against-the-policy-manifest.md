# ADR-074: A read under the org-only workspace sentinel is checked against the policy manifest

- **Status:** Accepted
- **Date:** 2026-09-16
- **Owners:** platform, app
- **Related:** ADR-068 (the org-only workspace sentinel is shared; the write
  side of the same rule), ADR-069 (an API key names a workspace),
  ADR-054 (the migration connection carries the RLS bypass),
  `packages/tenancy/src/scope.ts` (`ORG_ONLY_WORKSPACE_ID`),
  `packages/database/src/tenant-policy.manifest.ts`,
  `tools/scripts/gen-rls-migration.ts`,
  `tools/scripts/check-org-sentinel-reads.mjs`,
  `packages/handlers/src/audit.log.query.ts`,
  `packages/handlers/src/iam.role.list.ts`

## Context

An organization-level surface has no workspace. `scoped: true` capabilities and
`runInTenantScope` both want a uuid, so such a surface carries the nil uuid —
the org-only workspace sentinel — as its `workspaceId`.

`tools/scripts/gen-rls-migration.ts:56-84` generates each table's
`tenant_isolation` policy from its class in the policy manifest. Only one class
ignores the workspace GUC. Under the sentinel:

| class | what a read gets |
|---|---|
| `org_only` | the whole org |
| `workspace_nullable` | **only** the rows whose `workspace_id IS NULL` |
| `standard` | **nothing** |
| `workspace_only` | **nothing** |

Postgres RLS hides rather than refuses. There is no error, no log line, no
failing test, and nothing for a `catch` to see. The caller gets a short answer
shaped exactly like a complete one.

That is not hypothetical. On `app-rebuild`, before this decision, it was live in
seven places at once, and the pattern in each was identical: the query's `where`
clause **already carried the correct `eq(table.orgId, orgId)` fence**, so the
tenant scope added nothing the predicate did not already do and subtracted the
workspace-scoped rows.

- `apps/app_deprecated/src/lib/audit-query.ts` is the single read path for the
  audit viewer and the HMAC-signed SOC 2 export, and its own header says it is
  single so that "what you see is what you export". `security.security_events`
  is `workspace_nullable`, so the export omitted every event carrying a
  workspace: `secret.reveal`, `secret.export`, `plugin.credential.*`,
  `tacho.enrollment.*`, and the kernel's own `capability.invoke_allowed` /
  `capability.invoke_denied` envelopes. `queryAuditForExport` propagates errors
  on purpose, "so a DB failure cannot masquerade as a complete-but-short
  export"; RLS raised nothing, so it produced exactly that file, signed.
- The Security overview's posture read `0` denied invocations while the kernel
  was denying, and rendered the tile as a success. The same read decides whether
  SOC 2 CC7.2 shows Active or Partial, and prints its count into the rationale
  an auditor reads.
- The developer tokens panel listed none of the org's API keys, and it is the
  revoke and rotate surface — a key nobody can see is a key nobody can revoke.
- `remove_org_member` soft-deletes a principal's role assignments at every
  scope, deliberately omitting a workspace predicate. RLS put the predicate
  back, so only the org-wide assignments were revoked.

The defect is invisible at the call site and obvious at the seam. Each of those
files reads correctly on its own; what decides whether the read is whole is the
policy class of a table named in another package, and no reviewer holds that
table by table. The sentinel itself made this worse: it was redeclared as a
local `const ORG_ONLY_WS` in more than thirty files, so one copy carried the
reasoning in a comment and the next carried none.

ADR-068 settled the write side of the same rule. Nothing enforced the read side.

## Decision

1. **The sentinel has one home.** `ORG_ONLY_WORKSPACE_ID` is defined in
   `@oxagen/tenancy`, the package that owns the scope, with the table above in
   its doc comment. `@oxagen/oxagen/contracts/audit.log.query` re-exports it, so
   no import path changes and ADR-068's work is unaffected. New code imports it
   rather than writing the literal.

2. **An organization-level surface reaches a table that is not `org_only` in one
   of two ways, and never by leaving RLS to narrow it.**
   - `withSystemDb` with an explicit `eq(table.orgId, orgId)` fence on every
     query, which is what `audit.log.query.ts` and `iam.role.list.ts` already
     do over these same tables. The fence is then application code, so a read
     that must be whole also asserts what it can check about its own answer —
     the audit export checks the org fence on the rows that come back and
     refuses to sign a set truncated at `maxRows`.
   - Re-entering a real workspace's scope, when the record names one. The
     tokens panel's revoke and rotate resolve the key's own workspace and invoke
     inside it, which leaves the handlers' `withTenantDb` correct and untouched.

3. **`pnpm check:org-sentinel-reads` enforces it.** The check resolves every
   table a sentinel-scoped tenant read touches through the policy manifest and
   fails, naming the table, its class and what the sentinel does to it. It runs
   in `pnpm gate` and in the CI `checks` job. It covers both forms the defect
   takes:
   - **co-located** — a `runInTenantScope({ …, workspaceId: <sentinel> })` whose
     body reaches `withTenantDb`, which is the app-page and server-action form;
   - **cross-surface** — a sentinel ctx handed to `invoke()`, resolved through
     `packages/handlers/src/register.ts` to the handler and the tables it reads,
     which is the form the kernel sets up and no lint rule can see, because the
     scope and the query are in different packages.

## Alternatives considered

**An ESLint rule.** This was the first shape tried and it does not hold. A rule
sees one file, so it catches the co-located form and none of the cross-surface
one — two of the seven live sites were handlers whose scope is set by the
kernel from a ctx built in another package. Worse, within a file a lint rule
cannot see a table's policy class, so it can only ban the *pattern*: on this
tree that is 22 sites, 8 of which read `org_only` tables and are entirely
correct. A rule that is right two-thirds of the time is fixed with
`eslint-disable` comments, and a wall of unaudited disables is the shape of
protection without the substance. The check ships as a script instead precisely
so it can read the manifest.

**Refusing at the database.** Under an org-only scope, set
`app.current_workspace_id` to a value that is not a uuid. Every policy that
casts the GUC then raises instead of quietly returning nothing, which is the
durable end state: RLS would refuse rather than hide, and the failure would be
impossible to ship. It is not adopted here because `workspace_nullable`
policies reference the GUC too, so a correct org-level read of
`iam.principals` or `iam.principal_role_assignments` would start raising as
well. Turning it on means auditing every sentinel-scoped path in the tree
first, which is a body of work of its own and cannot be verified without a full
suite run. The check is what makes that sweep possible: it enumerates the sites.

**A `runInOrgScope` helper that refuses `withTenantDb`.** Equivalent in effect
to the check's co-located pass, and it requires editing every one of the 22
sites to adopt it, including the correct ones. It would also have to be adopted
to be enforcing — nothing stops the next file from calling `runInTenantScope`
directly — so it needs the check anyway.

## Consequences

- Run against `app-rebuild` before these fixes, the check reports all seven live
  sites and no false positives. Run against the tree with them, it is clean.
- A read of an `org_only` table under the sentinel stays exactly as it was. That
  is most of the sentinel-scoped code in the app and none of it changes.
- The check has blind spots, and they are stated in its header rather than left
  to be discovered: a table reached through a helper that is neither the handler
  module nor one of its direct relative imports (it follows one hop, not a call
  graph); a ctx assembled in a file that never names the sentinel; and anything
  outside Postgres, since Neo4j and ClickHouse scoping is a separate seam. It is
  a net with a known mesh, not a proof.
- Its co-located pass is file-scoped in one direction: a file that scopes to the
  sentinel somewhere and also reads a workspace-scoped table under a real
  workspace elsewhere is reported. That over-reports rather than under-reports,
  and the remedy — scoping the sentinel read correctly — is the same either way.
- `evidence.retention_policy_versions` is `standard` and
  `get_evidence_retention` asks for "the longest window ANY pinned policy
  declares" across the organisation. Tenant-scoped it could never answer that
  for more than one workspace, whatever scope it was called in, so its move to
  `withSystemDb` is a correctness fix independent of the sentinel and the check
  does not report it from any caller on this branch.
