# ADR-074: A read under the org-only workspace sentinel is checked against the policy manifest

- **Status:** Accepted
- **Date:** 2026-09-16
- **Owners:** platform, app
- **Related:** ADR-068 (one org-only workspace sentinel, shared by every
  surface — this ADR enforces the rule stated there), ADR-073 (an API key names
  a workspace; #3116, not yet landed),
  ADR-054 (the migration connection carries the RLS bypass),
  `packages/oxagen/src/types.ts` (`ORG_ONLY_WORKSPACE_ID`),
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

ADR-068 settled all of this in prose. Its Context sets out what each policy
class does under the sentinel, names `workspace_nullable` as "the quiet one",
and §6 states the rule outright: an org-wide read of such a table goes through
`withSystemDb` with an explicit `org_id` fence. It found one instance —
`delete_role` counting a role's holders — and fixed it, and it holds the write
side against a real Postgres in
`packages/database/integration/org-only-scope-writes.test.ts`.

What it did not do is check the rest of the tree. The six sites above were all
live on `app-rebuild` while that ADR was being written, every one of them the
`workspace_nullable` or `standard` read it warns about. A rule that is correct,
written down, and unenforced is worth what the next author happens to remember
of it. This ADR is the enforcement.

## Decision

1. **The sentinel keeps the home ADR-068 gave it**, `packages/oxagen/src/types.ts`,
   exported from `@oxagen/oxagen`. An earlier draft of this change moved it to
   `@oxagen/tenancy`, where the scope lives; ADR-068 decision 2 rules that out
   by name, because `apps/app/src/**` may not import `@oxagen/tenancy`
   (ARCHITECTURE.md §2, INV-03) and a definition there could not be shared with
   the app. Nothing here moves it. New code imports that constant rather than
   writing the literal, which is what the thirty-odd files carrying a local
   `const ORG_ONLY_WS` did.

2. **An organization-level surface reaches a table that is not `org_only` in one
   of two ways, and never by leaving RLS to narrow it.**
   - `withSystemDb` with an explicit `eq(table.orgId, orgId)` fence on every
     query, which is what `audit.log.query.ts` and `iam.role.list.ts` already
     do over these same tables. The fence is then application code, so a read
     that must be whole also asserts what it can check about its own answer —
     the audit export checks the org fence on the rows that come back and
     refuses to sign a set truncated at `maxRows`. This is ADR-068 §6's rule,
     unchanged.
   - Re-entering a real workspace's scope, when the record names one — ADR-068
     §5's move, applied to a read. The tokens panel's revoke and rotate resolve
     the key's own workspace and invoke inside it, which leaves the handlers'
     `withTenantDb` correct and untouched.

3. **`pnpm check:org-sentinel-reads` enforces it.** The check resolves every
   table a sentinel-scoped tenant read touches through the policy manifest and
   fails, naming the table, its class and what the sentinel does to it. It runs
   in `pnpm gate` and in the CI `checks` job. It covers both forms the defect
   takes:
   - **co-located** — a `runInTenantScope({ …, workspaceId: <sentinel> })` whose
     body reaches `withTenantDb`, which is the app-page and server-action form;
   - **not scanned at all** — `*.test.ts` and `*.test.tsx`. A test naming the
     sentinel is not a production read, and a fixture that builds a sentinel ctx
     to exercise a handler is the normal way to test one. This exemption is
     load-bearing for code arriving beside this ADR: of the four PRs open
     against `app-rebuild` when it was written, #3116's
     `apps/app/src/features/organization/actions.test.ts` is the only file that
     names the sentinel at all, and it is exempt for this reason.
   - **cross-surface** — a sentinel ctx handed to `invoke()`, resolved through
     `packages/handlers/src/register.ts` to the handler and the tables it reads,
     which is the form the kernel sets up and no lint rule can see, because the
     scope and the query are in different packages. The capability is resolved
     whether it is named as a string or as a contract export's `.name`, and
     when it reaches `invoke()` as neither — behind a
     `readCapability(viewer, name, input)` helper, as on `main` — every
     capability the file names in either form is checked instead.

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
  a net with a known mesh, not a proof. One blind spot was found by running it
  against `main` and closed rather than documented: an `invoke()` behind a
  helper reported nothing, because the capability is named at the helper's call
  sites. That is the indirect fallback above, and it is why the check reports
  twelve sites on `main` where it reported five before.
- Its co-located pass is file-scoped in one direction: a file that scopes to the
  sentinel somewhere and also reads a workspace-scoped table under a real
  workspace elsewhere is reported. That over-reports rather than under-reports,
  and the remedy — scoping the sentinel read correctly — is the same either way.
- **The near-instance worth naming**, because it is the clearest argument for
  the gate preceding the surface. `packages/handlers/src/notification.list.ts`
  and `packages/agent/src/handlers/agent.approval.resolve.ts` (both arriving
  with #3055) read `notification.notifications`, which is `workspace_nullable`.
  Every caller today passes a real workspace, so the check reports nothing and
  there is no defect to fix. An organization-level notifications surface built
  on `list_notifications` — a reasonable thing to build — would silently be
  answered only the rows carrying no workspace, which is finding 1 again in a
  different table. The check fails the moment that caller exists. That is the
  whole value of landing it before the surface rather than after.

- Two of the sites this decision was written for are on `main` and not on
  `app-rebuild`: `get_action_usage`, whose per-capability breakdown over
  `security.security_events` contradicted its own header — the rows are "an
  UPPER BOUND on billed actions" and RLS inverted that invariant — and the
  billing page that invoked it and `get_evidence_retention` under the sentinel.
  #3022 retired `get_action_usage` on this branch and the billing page it was
  read from does not exist here. The check reports both when run against `main`.

- `evidence.retention_policy_versions` is `standard` and
  `get_evidence_retention` asks for "the longest window ANY pinned policy
  declares" across the organisation. Tenant-scoped it could never answer that
  for more than one workspace, whatever scope it was called in, so its move to
  `withSystemDb` is a correctness fix independent of the sentinel and the check
  does not report it from any caller on this branch.
