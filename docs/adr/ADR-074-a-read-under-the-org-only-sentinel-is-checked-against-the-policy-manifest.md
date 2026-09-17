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

   **A conversion off `withTenantDb` says, per call site, which plane the
   table is on.** `withTenantDb` resolves the organisation's data plane and
   calls `assertDataPlaneUsable`; `withSystemDb` does neither. Substituting one
   for the other therefore drops a guarantee that nothing in the diff, and
   nothing `check:org-sentinel-reads` can see, will mention — the loss that
   produced this change's own regression. A table ADR-042 §2 places on the
   shared plane loses nothing it had; a table §2 calls tenant data does, and
   until the plane-aware organisation-wide seam exists (#3132) it carries the
   two calls explicitly, as `billing.evidence_retention.ts` does. Whichever it
   is, the call site says so in a comment, because the next reader cannot
   recover it from the code.

3. **`pnpm check:org-sentinel-reads` enforces it.** The check resolves every
   table a sentinel-scoped tenant read touches through the policy manifest and
   fails, naming the table, its class and what the sentinel does to it. It runs
   in `pnpm gate` and in the CI `checks` job. It covers both forms the defect
   takes:
   - **co-located** — a `runInTenantScope({ …, workspaceId: <sentinel> })` whose
     body reaches `withTenantDb`, which is the app-page and server-action form;
   - **waived** — a live instance whose fix belongs to another change, listed in
     `tools/scripts/org-sentinel-reads-baseline.json` with its reason and the
     change that closes it. One entry today — `org.apiKeys` in the rebuild,
     closed by #3116.

     **The property, stated exactly**, because a looser version of it was
     claimed here first and was wrong: a waiver matches ONE site, ONE
     capability and ONE exact set of offending tables. An entry matching no
     finding is an error, so a waiver cannot outlive the defect it waives; and
     because the table set is part of the identity, a handler that later
     narrows a SECOND table produces a new finding AND a stale waiver rather
     than silently absorbing the new defect into the old entry. Keyed on site
     and capability alone — as it was at first — that second defect would have
     been suppressed by a waiver still reading as live, which is the same rot
     one level down.
   - **not scanned at all** — `*.test.ts` and `*.test.tsx`. A test naming the
     sentinel is not a production read, and a fixture that builds a sentinel ctx
     to exercise a handler is the normal way to test one. This exemption is
     load-bearing for code arriving beside this ADR: of the four PRs open
     against `app-rebuild` when it was written, #3116's
     `apps/app/src/features/organization/actions.test.ts` is the only file that
     names the sentinel at all, and it is exempt for this reason.
   - **the app kernel seam** — `apps/app`, the Mission Control rebuild, calls
     `invoke()` in no page at all. A data adapter under `src/data/live/` calls
     `kernelRead` / `kernelWrite`, and the single `invoke()` and the sentinel
     conversion both live in `src/server/kernel.ts`, where `capabilityContext`
     maps an `OrgCtx` to the sentinel and leaves a `WsCtx` its workspace. The
     two halves the cross-surface pass looks for are in different files by
     design, so it matched neither. This pass models that named seam directly —
     `src/data/ports.ts` declares which port methods take an `OrgCtx` — rather
     than trying to infer indirection in general.
   - **cross-surface** — a sentinel ctx handed to `invoke()`, resolved through
     `packages/handlers/src/register.ts` to the handler and the tables it reads,
     which is the form the kernel sets up and no lint rule can see, because the
     scope and the query are in different packages. The capability is resolved
     whether it is named as a string or as a contract export's `.name`, and
     when it reaches `invoke()` as neither — behind a
     `readCapability(viewer, name, input)` helper, as on `main` — every
     capability the file names in either form is checked instead.

## The two things RLS was also doing

`withSystemDb` is not "the same read without the workspace narrowing". Row-Level
Security was providing two properties beyond row-narrowing, and a conversion
drops both. A security review of this PR found three P1s that are all this one
root, and the audit one is the sharpest possible version of the lesson the rest
of this ADR is about: **RLS hiding rows was doing two jobs, and the reason
nobody noticed it was doing the second is the same reason nobody noticed it was
breaking the first.**

**1. Confidentiality, by accident.** The audit viewer gated on membership and
was kept narrow by Postgres. Fixing the read without fixing the gate turned a
silently-incomplete signed export into a correctly-complete unauthorized read:
every org member, every workspace's actor identities, IP addresses, user agents,
request ids and capability outcomes. The signed export beside it had gated on
Owner/Admin since it was written, and the two share one read path on purpose —
so the viewer was the half that was wrong, and RLS was covering for it.

**The rule: the governed capability is the specification.** Where a surface's
own gate and the capability that answers the same question disagree, the surface
is wrong. `query_audit_log` answers organization-wide only for an org Owner or
Admin; `list_api_keys` is `sensitivity: "high"`, Owner/Admin. Every converted
read below now carries the gate its capability requires.

**2. Data-plane resolution.** `withTenantDb` calls `resolveDataPlane` and opens
the organisation's plane. `withSystemDb` ALWAYS opens the shared-plane
singleton and never consults the resolver — deliberately, for the three reasons
in its docblock. ADR-042 §2 puts billing, IAM, auth, org and the plugin catalog
on the shared plane always, and gives a dedicated plane tenant data only:
traces, **evidence**, graph, memory, context records, conversations, ingestion
state. So **`withSystemDb` is the right seam only for shared-plane tables**, and
that is a load-bearing caveat on the advice this ADR gives. For a table ADR-042
places on a dedicated plane, an explicit `eq(orgId)` fence does not save it: the
read is correctly fenced against the wrong database.

### The sweep

Every `withSystemDb` read this change introduces, against both properties. No
exceptions, including the sites no review flagged. Six of the eight are
**conversions** — a `runInTenantScope` + `withTenantDb` region replaced in
place, which is the shape where a guarantee can be dropped silently. The two in
`developer/tokens/api-key.ts` are **new code**: that file held no database
access at all in the base, so they have no prior seam to have lost anything
from. The distinction is load-bearing for the plane question below, so the
table carries it.

| `withSystemDb` read | conv. | who may see it | which plane |
|---|---|---|---|
| `lib/audit-query.ts` — `security.security_events` | converted | **was membership; now Owner/Admin.** `security/audit/page.tsx` gated with `assertOrgMember`; it now uses `assertSecurityManager`, matching `query_audit_log`'s `ORG_AUDIT_ROLES` and the export route beside it, which already checked `SECURITY_MANAGER_ROLES` | shared. Not named literally by ADR-042 §2, but `emitSecurityEvent` writes it through `withSystemDb` and the governed `audit.log.query` handler reads it through `withSystemDb`: the spine is shared-plane by construction, or nothing written would ever be read |
| `security/posture.ts` — `security.security_events`, `auth.api_keys` | converted | **was membership; now Owner/Admin.** Not flagged in review. Counts rather than rows, so a smaller leak — but it is still every workspace's posture, and it is the SOC 2 dashboard summarising the feed above. `assertSecurityManager` | shared, as above and `auth` is named by ADR-042 §2 |
| `developer/tokens/tokens-body.tsx` — `auth.api_keys` | converted | **was membership; now Owner/Admin.** The three actions on the same panel already gated (`buildApiKeyCtx` → `assertOrgAdmin`); the listing did not. `list_api_keys` is high-sensitivity Owner/Admin | shared (`auth`) |
| `developer/mcp/page.tsx` and `workbench/tools/mcp/page.tsx` — `auth.api_keys` | n/a | **the read is gone.** See below | n/a |
| `developer/tokens/api-key.ts` — `auth.api_keys`, `workspace.workspaces`, `workspace.workspace_users` (two calls) | **new** | already Owner/Admin: both helpers run after `buildApiKeyCtx`, which calls `assertOrgAdmin` before either | shared. `auth` is named; the two `workspace.*` tables are not named by either list, and this is org structure rather than tenant data — the base's own `new-workspace/actions.ts` creates both through `withSystemDb`. Stated as an inference from that precedent, not a citation |
| `org.member.remove.ts` — `iam.*`, `org.org_users`, `auth.api_keys`, `workspace.*` (two calls) | converted | already Owner/Admin: this is the governed capability, and its own actor gate runs before the transaction | shared (`IAM`, `org`, `auth`; `workspace.*` as above) |
| `billing.evidence_retention.ts` — `billing.org_billing_settings`, `billing.credit_ledger` | converted | governed capability; kernel IAM applies | shared (`billing`) |
| `billing.evidence_retention.ts` — `evidence.retention_policy_versions` | converted | governed capability | **dedicated, and this is the one that was wrong.** ADR-042 §2 names evidence as tenant data. See below |

**One substitution needed more than a fence.** Of the eight `withSystemDb` calls
this change introduces across six files, seven read tables ADR-042 §2 puts on
the shared plane always — `auth`, `iam`, `org`, `billing`, and the security
spine, which `emitSecurityEvent` writes through `withSystemDb` too.

The eighth stands in for a plane-aware read, and `withTenantDb` was doing **two**
things there: resolving the plane and calling `assertDataPlaneUsable`, which
refuses any binding that is not `active`. Replacing it with a plane-mode check
kept the first and dropped the second, so an organisation whose shared binding
an operator had explicitly disabled or marked degraded would have had its
retention posture read off that plane anyway — **the data-plane kill switch,
bypassed by the fix for a different bug.** Both checks are there now, mode
first so a dedicated plane refuses for the reason that actually applies.

#### Why the other six conversions do not get the same assertion

The first version of this section cleared them on the ground that
`withSystemDb` is the canonical seam for a shared-plane table and that no other
caller in the tree asserts a binding. **That argument does not survive the
sentence above it.** `assertDataPlaneUsable` refuses on `status`, before it
looks at `mode` — so if a disabled *shared* binding is what refuses the
evidence-retention read, then "these tables are on the shared plane" cannot be
the reason the others need no check. *Shared* says which plane, not whether that
plane is usable. And the precedent cited for it, `audit.log.query.ts` and
`iam.role.list.ts`, is not a precedent at all: both were always `withSystemDb`
and never held an assertion to lose. Six of these were **converted from
`withTenantDb`**, which is exactly the case the cited files are not.

The real reason is narrower, and it is three separate facts.

**1. No code path in this tree produces a `shared` binding that is not
`active`.** `set_data_plane` is the only writer of `org.data_planes`, and it
hard-codes `status: "active"` on both the insert and the update path; its
contract carries no `status` field at all. ADR-042 §3's `degraded` marking
belongs to the per-plane migration runners, which §"Consequences" defers to a
later body of work and which mark a *dedicated* plane whose schema version
lags. `narrowStatus` fails closed on an unrecognised value, but the column's
CHECK admits only the three known ones. The state the assertion would catch
here is reachable only by an operator's hand-written UPDATE.

**2. On the axis that *is* reachable — `dedicated` — the conversion is a fix,
not a regression.** Take the audit spine, the sharpest case, because it ends in
an HMAC-signed SOC 2 file. `security.security_events` is written *only* through
`withSystemDb` (`packages/database/src/security.ts`, the one inserter), so the
rows are on the shared plane by construction. The pre-conversion
`withTenantDb` therefore asserted the org's *postgres* binding and then opened
whichever plane it named — and for a dedicated-plane organisation that is a
database the events were never written to. It would have rendered, and signed,
an empty export. The assertion was guarding a plane the data is not on.

**3. Even in the hand-made case, the refusal was one-sided.** If an operator
disables an organisation's *shared* binding, `emitSecurityEvent` keeps writing
that organisation's events, `query_audit_log` keeps serving them, and identity
resolution, billing and IAM keep answering — all through `withSystemDb`, none
of which consults the binding. A read refusal on one app page while the write
path stays open is not a kill switch. It is a divergence between an app library
and the governed capability over the same table, and it is the divergence this
conversion removes.

So the fix for the six is not to give each caller its own
`resolveDataPlane` + `assertDataPlaneUsable`. That would gate a shared-plane
platform read on a tenant's Postgres binding — the blanket assertion inside
`withSystemDb` that its own docblock rules out, spelled once per caller — and
would re-open the app-library/handler divergence deliberately closed here. The
evidence-retention site gets the assertion because its table is tenant data
under ADR-042 §2 and `withSystemDb` there is an acknowledged stand-in for a
seam that does not exist: refusing is the honest behaviour for a read that
would otherwise answer off the wrong plane. The other six are on the seam that
is already correct for them.

**What is actually missing is the seam, and it is #3132's step 2.**
`withTenantDb` resolves the plane but demands a workspace; `withSystemDb` needs
no workspace but is shared-plane by construction. An organisation-wide read of a
tenant table has no correct seam today, and inventing one inside this change
would be a storage-boundary decision made in a PR about a static check. It is
recorded there and not built here.

The shape is worth naming because it is the mirror of the one this ADR is
about: there, a tenant scope was doing confidentiality work nobody had asked it
for; here, a helper was carrying a guarantee its replacement did not. **A call
site that replaces a helper inherits everything the helper was doing, and the
loss is invisible in the diff** — nothing in the replacement looks wrong.

### The read that should not have been fixed at all

Two MCP install pages read the org's first active key to inject it into the
client snippets. Correcting that read — one to `withSystemDb`, the other to the
real workspace — made the page worse, and review caught it: `auth.api_keys`
keeps only `key_prefix` and `key_hash`, so the most either page can build is
`ox_abc••••••••`, and `buildSnippets` embeds whatever it is handed as the bearer
credential. A copied Claude or Cursor configuration would then be *guaranteed*
to fail authentication, where the `$OXAGEN_API_KEY` placeholder resolves to the
secret the operator actually saved.

Both reads are deleted. The raw key is shown once at creation and cannot be read
back, so the environment variable is the only thing on that page that can be
right, and a snippet that cannot work is worse than one that asks for the secret
because it looks copy-pasteable.

It is this PR's own failure a third time: correct the read, then print something
that cannot be right. Worth recording because the instinct the check encourages
— "this read is narrowed, widen it" — is not always the right move. Sometimes
the read should not exist.

### The seam that does not exist

`@oxagen/database` has `withTenantDb` (plane-aware, demands a workspace) and
`withSystemDb` (needs no workspace, shared-plane by construction). It has no
plane-aware organisation-wide read, which is exactly what an org-wide aggregate
over a tenant table needs. Building one is a change to the store client and not
a handler's to make.

So `get_evidence_retention` resolves the plane and refuses rather than guessing:
a dedicated-plane organisation gets a typed 5xx naming the gap, and every
organisation is shared today (ADR-042 §1 — absence of a row means shared, and
the dedicated mode has no customer yet), so nothing in service reaches the
refusal. A wrong number that looks right is what that capability exists to
avoid. **The missing seam is recorded as a gap for the maintainer, not
improvised here.**

### Every wrapper around `invoke()`, and which ones the check models

Three of these were found by review, each after the previous one was closed;
the fourth by enumerating rather than waiting. The list is the point: a check
that models call sites cannot be trusted further than the set of shapes it
reads, so the set is written down here instead of being rediscovered.

**Every row below was verified against a real call in the tree, not against the
form its author had in mind.** An earlier version of this table claimed
coverage of "an `invoke()` with a ctx literal" that the check did not have: the
regex required the third argument to end in an identifier, so a genuinely
inline `{ …, workspaceId: ORG_ONLY_WS }` — both calls in
`settings/privacy/org-privacy-actions.ts` — was never examined. A table whose
value is being something to diff against is worse than no table when a row
overstates, so each row now names the file it was checked on.

| shape | verified on | modelled |
|---|---|---|
| `invoke(name, input, { … })`, ctx inline | `settings/privacy/org-privacy-actions.ts` (2/2 calls) | **yes** |
| `invoke(name, input, ctx)`, ctx from a local factory | `members/member-actions.ts` → `buildCtx` (2/2) | **yes** — the identifier resolves to its declaration and then to the object the factory returns |
| `readCapability(viewer, name, input)`, ctx and invoke inside the helper | `main`'s billing governed-actions page | **yes** — the indirect fallback, which checks every capability the file names |
| `kernelRead` / `kernelWrite` on an `OrgCtx` port method | `apps/app` `data/live/*`, driven by the 13 `OrgCtx` methods in `data/ports.ts` | **yes** |
| `capabilityContext(c, { requireWorkspace: false })` | `apps/api/src/routes/v1/workspace.create.ts` (1/1) | **yes** |
| `invokeOrgCapability(orgId, userId, name, input)` | `governance/capabilities/page.tsx` (1/1) | **yes** — found by enumerating, not by review |
| `buildContext(headers())` | `apps/mcp/src/context.ts:143` | **not needed** — it refuses an empty org or workspace, so an MCP key always carries a real workspace and there is no org-only path |

**A complete enumeration is not possible in general, and this table is a
snapshot rather than a proof.** Nothing stops the next surface adding an eighth
shape, and the check would be silent about it exactly as it was silent about the
first four. What the table buys is that the question has a written answer to
diff against.

### Parsed, not matched

The call-site analysis is a TypeScript syntactic parse (`ts.createSourceFile` —
no program, no type checker, no tsconfig), not a set of regexes. It started as
regexes and failed four times in one review cycle, every time the same way:

1. a prose mention of `withTenantDb` in a header comment read as a call;
2. a capability named at a helper's call sites rather than at the `invoke()`;
3. a capability named through `kernelRead`, in another file;
4. an `invoke()` whose third argument is an inline object literal.

None of those errored. Each **reported clean on a shape it could not read**,
which in a mandatory CI check is worse than having no check, because it converts
"nobody has verified this" into "CI says it is fine". A regex that recognises
arbitrary object literals with nested braces, strings and comments will fail on
the fifth shape too.

The parse also made the check more precise in two ways it was quietly wrong
before. Comments and string literals are not nodes, so nothing has to be
stripped and a table name inside a SQL string is not a table reference. And the
co-located pass now counts only the `withTenantDb` calls lexically inside a
sentinel-carrying `runInTenantScope` callback, where before it answered per
file: `_shared/conversation-page.tsx` scopes one `org_only` `credit_lots` read
to the sentinel and everything else to the real workspace, and the file-level
answer called that a finding when it is not one.

### Per unit, not in aggregate

The fifth failure was on a different axis from the first four. They were about
*which call sites the check can read*; this was about *how it associates a fact
with the thing the fact belongs to*.

`pinsNullWorkspace` counted two totals across a whole file — how many statements
touched the table, how many `isNull(schema.<table>.workspaceId)` predicates
appeared — and inferred a per-statement property from the pair. One query
carrying the predicate twice, which `and(isNull(x), or(isNull(x), …))` does
naturally, made the totals match while a second, entirely unpinned
organisation-wide read of the same table went unreported. The same pooling
leaked across scopes, because the co-located pass hands it the regions of every
sentinel-carrying scope in the file at once.

It now walks out to each statement's own Drizzle chain and asks that chain
whether it pins the predicate. Every statement answers for itself, and the
table is exempt only when all of them do.

**The rest of the checker was audited for the same shape and no other instance
was found.** The remaining `.length` comparisons are existence checks
(`regions.length === 0`, `bad.length > 0`) or exact set differences (the stale
waiver list, the waived count), and `offenders` judges each table on its own
policy class with nothing pooled. Recorded because "are there other places this
reasons in aggregate" is the question worth asking after a finding like this,
and the answer should be written rather than assumed.

### This check is best-effort, and it does not converge

Twelve failures were found in it during one review cycle. **Every one reported
clean rather than erroring**, which is the property that makes a green
mandatory check worse than no check: it turns "nobody has verified this" into
"CI says it is fine". They fall on six axes, and the axes are the point —
above all the split between *reading something wrong* and *never looking*.

One of them, #12, is worse than either. A false positive normally costs time.
This one **failed CI on a correct org-level read and told its author the read
was narrowed**, and the remedy the message recommends is `withSystemDb` or a
baseline waiver — so the check would have pushed someone into an RLS bypass on
a read that was already right. A gate that recommends the defect it exists to
prevent is a different category of wrong from a gate that stays quiet.

| # | axis | what it could not do |
|---|---|---|
| 1-4 | which call sites carry a sentinel context | read a helper, `kernelRead`, `capabilityContext`, an inline object |
| 5, 8 | whether a predicate constrains the statement it belongs to | it compared totals across a file; it accepted an `isNull` inside an `or`, which is an alternative rather than a constraint |
| 6 | which table a read touches | it matched the literal identifier `schema` |
| 7, 9, 10 | **whether it looked at all** — coverage, not precision | it read one registry, so `@oxagen/agent`'s 45 handlers were never examined; it discarded a handler's helper for having no transaction of its own; it did not scan for capability names when `invokeOrgCapability` was reached through a wrapper |
| 11 | **what the seam it recommends stops doing** — coverage | it judges a read on table policy class against seam, and holds no model of what `withTenantDb` was doing *besides* narrowing: the data-plane resolution and `assertDataPlaneUsable` that a conversion to `withSystemDb` silently drops |
| 12 | **which classes the sentinel can narrow** — precision, and the harmful direction | its safe set held `org_only` alone and omitted `org_or_global`, whose USING clause is `org_id IS NULL OR org_id = ORG` and never names the workspace GUC |

Each was closed. Closing axis 1 took the call-site analysis from regexes to a
TypeScript parse. Closing axis 3 — resolving `import { schema as db }` and
`const se = schema.securityEvents`, both live in this tree — **immediately
produced a false positive on `list_members`**, because that handler branches on
`input.scope` and the check pools the tables of every `withTenantDb` region in a
handler. Knowing which branch a sentinel-scoped call takes means evaluating a
condition on an input supplied in another file: path sensitivity, then
interprocedural constant propagation. A fourth axis, opened by closing the
third.

**Four of these are a different kind, and the distinction is the stopping
rule.** Most were the check looking at something and reading it wrong, which
costs a false negative in CI. Four were the check **never looking**, which is
worse for the job this check has left: an incomplete inventory sends #3132's
conversion out short, and the runtime refusal then starts raising on paths
nobody reviewed. A coverage gap gets fixed; a precision gap gets written into
the residual list below.

The four coverage gaps:

1. **A second registry.** `readHandlerModules` parsed
   `packages/handlers/src/register.ts` alone: `readHandlerModules` parsed
`packages/handlers/src/register.ts` alone, so every capability registered by
`@oxagen/agent` — its registry, approval, MCP, memory, role and trace handlers,
45 of them — resolved to no module, and `handlerFindings` returned an empty
array for each. **An empty array is indistinguishable from "looked and found
nothing."** That is a coverage hole, it was cheap to close by parsing the second
registry, and an unresolvable handler module is now an error rather than an
empty result, because that is the one condition under which this check's silence
means nothing.

2. **A handler's queries in its helper.** A handler often opens `withTenantDb`
   and hands `tx` to a direct import — `plugin.registry.add.ts` opens the
   transaction and `registry-default.ts` is where `schema.mcpRegistries` is
   touched. The helper was discarded for having no transaction of its own,
   which is backwards: it has none *because the caller opened one*. Once the
   entry has a tenant region, each direct import is judged whole.

3. **`invokeOrgCapability` through a wrapper.** `governance/page.tsx` has a
   `safeInvoke(orgId, userId, name, input)` that forwards its `name` parameter,
   so the capability strings are at the wrapper's call sites and every
   org-sentinel invocation on that page was unexamined. The direct `invoke()`
   path already scanned the file's capability names when its argument did not
   resolve; this one now takes the same branch.

4. **What the recommended seam stops doing.** The check reasons about one
   property of a read — is this table narrowed by RLS when it should not be —
   and its remedy is "move it to `withSystemDb` with an org fence". It holds no
   model of the *other* things `withTenantDb` does. That helper resolves the
   organisation's data plane and calls `assertDataPlaneUsable`; `withSystemDb`
   does neither, by design. So a conversion the check asks for can drop a
   guarantee the check cannot name, and it reports clean either way — which is
   how the evidence-retention regression above got into this change with the
   checker green over it. Unlike the other three, **this one is not closed**,
   and it is not closable at this layer: deciding whether a converted read still
   needs the binding asserted means knowing which plane its table lives on, and
   ADR-042 §2's split is prose, not a manifest the script can read. It is
   recorded here rather than fixed because it is the gap that matters most to
   #3132, whose step 2 is a mass conversion of exactly this shape. The
   mitigation is procedural and is stated in the Decision: a conversion off
   `withTenantDb` states, per call site, which plane the table is on and why the
   dropped assertion is not needed.

Closing (2) produced one false positive, and closing it was the same kind of
work as the other named seams: `workspace-bootstrap` calls
`setTransactionWorkspaceScope` before writing `workspace.workspace_users`,
which is ADR-068 §5's sanctioned re-entry onto the workspace being created, so
the transaction is at a real workspace by then. Statements after that call are
skipped, by position, so a statement before it is still judged.

**That is the answer to whether this converges: it does not.** The residual is
structural, not a backlog:

- **Naming a table.** Resolvable now: the plain form, an import alias, a local
  binding, a destructured binding. Not resolvable: a table imported straight
  from a schema module (module resolution across packages), a table passed as a
  parameter (dataflow). A table chosen at runtime is over-approximated when both
  candidates are spelled in the file and missed when they are not.
  `residualTableForms` in the script publishes this list and the tests assert
  each case, so the boundary moves deliberately.
- **Reaching a capability.** Seven wrapper shapes are modelled by name. Nothing
  stops an eighth, and the check would be as silent about it as it was about the
  first four.
- **Which code actually runs.** Branching, and anything that depends on a value
  from another module.
- **What a predicate guarantees.** The pin must be a mandatory conjunct — true
  on every path — and `isMandatoryPin` propagates through `and` and refuses
  `or`. That is right for the shapes Drizzle produces, and it is still a
  syntactic reading of a boolean expression rather than a decision procedure
  for one.

A `ts.createProgram` with the real type checker would close the alias and
import-resolution cases by construction and move the frontier. It would not
close path sensitivity or dataflow, it costs build time on every PR, and — the
deciding point — **it addresses only axis 3 of three.** It buys one axis for a
large increase in cost and complexity. That is not where the remaining value is.

### Where the enforcement belongs

The static check is trying to prove a negative about every call site: that no
workspace-scoped table is read under a sentinel workspace id. The property would
be far better enforced where the table is already known — **in Postgres.**

Under an org-only scope, set `app.current_workspace_id` to a value that is not a
uuid. Every `tenant_isolation` policy that casts the GUC then raises instead of
quietly returning nothing. **RLS stops hiding and starts refusing**, and no
alias, wrapper, parameter, branch or runtime table choice can defeat it, because
the check is performed by the relation itself. It is the difference between
proving that nobody does the wrong thing and making the wrong thing impossible.

It is not enabled here because `workspace_nullable` policies reference the GUC
too, so correct org-level reads of `iam.principals` and
`iam.principal_role_assignments` would start raising along with the incorrect
ones. Those call sites have to be converted first.

**That reframes what this check is for.** Its durable value is not as a
permanent gate but as the instrument that enumerates the call sites so the
runtime refusal can be turned on — and then it becomes redundant, which is the
right end for it. Tracked as #3132, whose definition of done includes deleting
this script and its baseline. That is also why closing the coverage hole
mattered more than the precision gaps: the agent package's call sites were
invisible, so a conversion driven by this inventory would have missed all 45. Until that lands it is worth keeping, because a net with a
known mesh catches more than no net. It should not be read as proof that the
tree is clean. It is best-effort, its limits are listed above and asserted in
its tests, and `check-org-sentinel-reads` reporting clean means "none of the
shapes this check can see", never "none exist".

### What the check can and cannot tell you

`check:org-sentinel-reads` answers one question: *is this read narrowed by RLS
when it should not be.* These findings are a second question in the same
neighbourhood: *is this read unnarrowed without an authorization gate that
matches its governed capability, and is it on the right plane.*

The plane half is checkable and worth building: the table is known statically,
ADR-042 §2's split is a fixed list, and `withSystemDb` against a dedicated-plane
table is a mechanical finding. The authorization half is not, at least not
reliably — the gate can be a layout three directories up, a middleware, a role
derived at runtime, or a capability invoked instead of a direct read, and a
check that guesses would either miss the audit viewer or flag every correct page
in the app. **Saying so is the point.** The check drives people toward
`withSystemDb` and cannot tell them to gate it, which is a sharp edge on the
advice, and the sweep table above is what covers it for this change. Anyone
converting a read after this one owes that table two more rows, and the ADR is
where the obligation is written down rather than in a reviewer's memory.

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
  graph); a ctx assembled in a file that never names the sentinel; **any wrapper
  around `invoke()` other than the two the app-kernel pass knows by name**; and
  anything outside Postgres, since Neo4j and ClickHouse scoping is a separate
  seam. It is a net with a known mesh, not a proof.

- **Ten failures were found after the check was first written. All ten were
  closed; the count of KNOWN blind spots shrank each round and the rate of
  discovery did not.** Ten rounds in, there is no evidence the set is finite,
  and the section above says plainly that it is not. An earlier draft of this
  ADR claimed the incompleteness was "written down and shrinking"; the writing
  is accurate, the shrinking is not a claim this can support, and the sentence
  is withdrawn.

- **How each was found, because the pattern is the useful part.** Against
  `main`, an
  `invoke()` behind a `readCapability(viewer, name, input)` helper reported
  nothing, because the capability is named at the helper's call sites; that is
  the indirect fallback, and it took `main` from five sites to twelve. Against
  `apps/app` — the rebuild this very branch sits beside — the checker reported
  nothing at all, because that app calls `invoke()` in no page and routes
  everything through `kernelRead`; that is the app-kernel pass, and it found one
  live instance the check had been blind to for a whole review cycle. And in
  `apps/api`, an org-scoped route holds only `const ctx = capabilityContext(c,
  { requireWorkspace: false })`, so the sentinel appears in neither the route
  nor any literal there. **The rule the three of them make is that a checker
  must be run against every tree and every surface it will guard, not only the
  one it was written on** — and that the wrappers it models should be
  enumerated deliberately rather than discovered one review at a time, which is
  what the table above is for. A fourth wrapper
  (`invokeOrgCapability`, in the deprecated app's governance pages) was found
  that way rather than by review.
- The co-located pass used to be file-scoped, reporting a file that scoped to
  the sentinel somewhere and read a workspace-scoped table under a real
  workspace elsewhere. The parse ended that: it counts only the `withTenantDb`
  calls lexically inside a sentinel-carrying callback.
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
