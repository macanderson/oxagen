# ADR-099: A workspace is born with its main repository, and a repository is main for at most one workspace

- **Status:** Accepted
- **Date:** 2026-09-18
- **Owners:** platform, app, cli
- **Related:** Mission Control spec §10.1 (one main repo, any number of
  linked repos), §7 line 222 (the onboarding gate and its 14-day provisional
  window), §11.4 (what linking a repository does in full), §17 M0 (the
  acceptance test); ADR-042 (data planes, which bound the uniqueness guard);
  ADR-090 (`.oxagen/skills.toml` is read through the repository binding);
  ADR-097 (steering reads the main repository's `.oxagen/rules/`);
  `docs/capabilities/workspace.create.md`, `repository.link.md`,
  `repository.unlink.md`, `repository.list.md`, `repository.main.bind.md`
- **Numbering:** 099. ADR-098 is taken by #3310 and ADR-091 by "one record
  steers one agent"; neither is reused
- **Delivered by:** `create_workspace` with a required `mainRepo`,
  `link_repository`, `unlink_repository`, `list_repositories`, the migration
  `20260918040000_repository_main_binding_is_exclusive.sql`, the Create
  workspace and Workspace settings dialogs in `apps/app`, and `oxagen repo`
  in `apps/cli`

## Context

A workspace's governance lives in a git repository. Steering resolution reads
`.oxagen/rules/` through the workspace's repository binding
(`packages/handlers/src/context.steering.github.ts`), agent definitions are
committed to `.oxagen/agents/` through the same binding
(`agent.definition.commit.ts`), and ADR-090 reads `.oxagen/skills.toml` the
same way. The spec calls that repository the **main** repository and says
three things about it in §10.1: exactly one per workspace, required at
creation, and "a workspace without a main repo cannot exist". It also names a
second kind, **linked**: the repositories the workspace's agents work on, zero
or more, each a valid grant target, each allowed to carry repository-scoped
records under its own `.oxagen/rules/`. A repository may be linked to many
workspaces. It is main for at most one.

Before this decision the tree held half of that. `bind_main_repository`
(#2967) could bind a main repository to an existing workspace, and
`repository_binding_heads` had no `role` column, so every head was main by
construction. `create_workspace` wrote a workspace with no repository at all.
Nothing stopped two workspaces from binding the same main repository: the
bind's advisory lock is keyed on the workspace, so two binds in two
workspaces never serialised against each other. Two workspaces on one main
repository write their records into the same files under the same `set_id`
and each reads the other's records back as its own. Nothing errors. The
migration header spells out the second hazard: a local checkout resolves to a
workspace through its repository, so a repository that is main for two
workspaces makes "whose mandate, whose budget, whose trace" unanswerable.

The §17 M0 acceptance test is the bar: a workspace cannot be created without
a main repo, and a second repo can be linked and unlinked.

## Decision

### 1. Two roles, and a workspace is written with its main head

`repository_binding_heads.role` is `main` or `linked` (a `CHECK`, default
`main` so every pre-existing head keeps its meaning). Every reader that
resolves the repository a workspace steers by pins `role = 'main'`:
`context.steering.github.ts`, `agent.definition.commit.ts` and
`repository.main.get.ts`. A linked head beside the main one changes none of
their answers.

`create_workspace` takes `mainRepo: { provider, owner, name }` and it is
required. The handler writes the workspace row, the caller's owner
membership, the default tool registry, a `connected` GitHub connection with
the installation attached, the version-1 repository binding and its
`role = 'main'` head in **one transaction**. A creation that cannot bind
writes nothing. The one shared writer of a new head is
`repository.binding-write.ts`; `bind_main_repository` keeps its own because
it also repairs and re-approves an existing head in place.

### 2. The installation is resolved from the repository's owner, never supplied

At creation the workspace does not exist, so there is no workspace GitHub
connection to take an installation from. The organization's stored GitHub
authorization does exist (`ingestion.oauth_accounts` is keyed by org). The
handler asks `GET /user/installations` with that authorization, through the
one resolver `list_github_installations` and `attach_github_installation`
already use, and picks the installation whose account login equals the
repository's owner, compared case-insensitively because GitHub logins are.
One App installation exists per account and a repository's owner is the
account it is installed on, so the owner picks the installation.

No input field names an installation, on any of the four capabilities. An
installation id a caller could choose would let one tenant mint tokens for
another account's installation: the token the repository capabilities mint
through an installation carries no caller entitlement, GitHub asks who the
App is, not who asked. The refusals say which step failed:
`conflict: github_not_authorized` (no usable authorization on the org),
`not_found: installation_unreachable` (the App is not installed on that
owner, or the authorization cannot reach it), and
`not_found: repository_not_installed` (the installation cannot see the
repository). All three run before the transaction opens.

### 3. One main claim per repository, guarded by a global unique index

`repository_binding_heads_main_repository_uq` is a unique index on
`(provider, provider_repository_id) WHERE role = 'main'`. It carries neither
`org_id` nor `workspace_id`, because scoping it per organization would still
admit the case the rule is mostly about: the same repository claimed as main
by two organizations, which is how one tenant's steering reaches another's
agents. `provider` is in the key because repository ids are only unique
within a provider.

Every writer of a main head reads the claim first, through `withSystemDb`
because the heads table is tenant-scoped, so the ordinary case refuses with a
sentence (`conflict: main_repo_claimed`). The index is the guarantee: a lost
race surfaces as the same unique violation, and the catch around the
transaction turns it into the same refusal. The refusal names neither the
organization nor the workspace holding the claim, because the read that
found it crossed tenants. The migration demotes any pre-existing duplicate
main heads to `linked`, keeping the oldest by `(created_at, id)`, before it
builds the index.

The index is global only within one Postgres. ADR-042 lets an organization
carry a dedicated plane, and ingestion is tenant data such a plane would
hold, so `assertGlobalClaimIsKnowable` refuses the claim
(`conflict: main_repo_plane_unsupported`) when the caller's plane is not
shared or any organization's is dedicated, and `assertPlaneStillShared`
re-asks inside the transaction. No organization is dedicated today, so
nothing in service reaches either refusal.

### 4. Linking another workspace's main repository is refused

`link_repository` refuses with `conflict: main_repo_claimed` when the
repository is any other workspace's main. §10.1 opens repository-scoped
Context PRs on the linked repository itself, and another workspace's main
repository holds that workspace's `.oxagen/` governance tree. Linking it
would hand this workspace a door into that tree. A repository that is
nobody's main may be linked by any number of workspaces, in the same
organization or not. The workspace's own main repository is refused as
`conflict: main_repo` (it is already bound), and a second link of the same
repository as `conflict: repository_already_linked`.

### 5. Unlink deletes the head; binding versions are evidence

`unlink_repository` takes the `rpb_…` binding id and deletes the binding
**head**, the mutable pointer that says "this workspace sees this
repository". Every row in `ingestion.repository_bindings` stays. A binding
version is immutable evidence that runs admitted against it cite, and
`repository_bindings_repository_version_uq` is on
`(connection, repository, version)`, so linking the repository again reuses
the latest version when nothing it records has moved and writes version + 1
when something has. A main head refuses with
`conflict: main_repo_unlink_refused`: a workspace without a main repository
cannot exist. Changing which repository is main is an org-owner action
recorded as a security event (§10.1), and it has no capability yet.

### 6. The organization's first workspace is the one exception

`create_org` writes the organization's first workspace without a main
repository. That is the spec's own exception, §7 line 222: onboarding binds
the main repo in a later step through the installer, which reads the git
remote of the directory it ran in and offers it with one click. A workspace
that skips that step is provisional for 14 days. Runs record and spend
counts, and steering, records and agent definitions stay off until
`bind_main_repository` closes the window. `workspace-bootstrap.ts` names its
two callers as standing on opposite sides of the rule, and a third caller
has to answer for the main repository one way or the other.

### 7. Reads and surfaces

`list_repositories` answers one row per head with the binding version it
points at, main first, with `connectionLive` false when the connection
behind a head has been retired. It makes no GitHub call. All four
capabilities are on `api` and `mcp`; the three repository ones are also on
`cli` as `oxagen repo list`, `oxagen repo link <owner/name>` and
`oxagen repo unlink <bindingId>`. The Create workspace dialog collects the
main repository and the Workspace settings dialog lists and links.

## Consequences

- A cross-tenant probe finds no path from one workspace's steering to
  another's through a shared main repository. The unique index holds it
  whatever a handler does.
- `create_workspace` now calls GitHub twice before it writes. A workspace
  cannot be created while GitHub is down, and cannot be created at all by an
  organization that has never authorized GitHub. That is the spec's rule, and
  the first workspace, which `create_org` writes, is unaffected.
- The `main` role on every pre-existing head is a default, not an
  observation. A head written before this migration is main because it was
  the only kind there was.
- The plane guard refuses a real customer's bind the day any organization is
  moved to a dedicated plane. The repair is a plane-aware global claim check
  in the store seam, and it is owed before that day.

## Deferred

The §11.4 follow-through is not part of this decision. Linking a repository
in full does four things: confirm the production branch, subscribe the App to
events, import issues, and build the code graph. This decision does the
first, by recording GitHub's default branch as the binding's configured ref,
and none of the other three. `unlink_repository` purges nothing from the
graph. The v2 descriptors in
`packages/oxagen/src/contracts/v2/link-repository.ts` and
`v2/unlink-repository.ts` carry that target shape until their cutover, and
`repository.link.md` and `repository.unlink.md` say so. `set_main_repository`,
the org-owner action that moves the main claim, has no contract either.

## Alternatives considered

- **A `role` on the binding version instead of the head.** Rejected. Role is
  a fact about how the workspace sees the repository now, and it changes
  without the repository changing. Versions are immutable evidence.
- **An installation id on `create_workspace`.** Rejected for the reason in
  §2. It is also unnecessary: the owner already names the account.
- **Scoping the uniqueness per organization.** Rejected in §3. The
  cross-organization case is the one the rule exists for.
- **Unlink deletes the binding versions.** Rejected in §5. Admitted runs
  cite them, and a binding a run cited cannot be made to disappear.
- **Letting the first workspace require a main repository too.** Rejected.
  It contradicts §7 line 222, and the onboarding gate is the only path a new
  organization has.
