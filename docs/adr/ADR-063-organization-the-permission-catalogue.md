# ADR-063: Organization: the permission catalogue

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** platform
- **Related:** issue #2964 (Organization: roles and the permission
  catalogue, workspaces), `apps/app/ARCHITECTURE.md` §1.2 (the `/{org}`
  and `/{org}/roles` rows), §1.5 (which orgs the kernel enforces roles for),
  §3.2 and INV-29 (roles are checked in handlers), the Mission Control
  mockup (`mc.html`: `ROLES`, `PERMS`, `rolesBody`, `roleEditDlg`,
  `roleDelDlg`; `pages/organization-roles.md`), the Mission Control spec
  §6.3 (roles and grants) and Appendix A.4 (`iam`),
  `docs/specs/agent-rbac/spec.md` §3.2–§3.4 (the system agent roles, the
  tier gate, the delegation ceiling), `packages/oxagen/src/iam/resolve.ts`
  (the resolver; rule 7 role grants, rule 7.5 the org Owner),
  `packages/oxagen/src/iam/permission-catalog.ts`,
  `packages/iam/src/delegation-ceiling.ts`,
  `packages/handlers/src/iam.role.{create,grants.set,delete}.ts`

## Context

The mockup's Roles page draws a table of roles and a role editor whose
matrix runs over `PERMS`: seven groups (Runs, Agents, Tools and policy,
Repository, Graph and steering, Money, Audit) of short permission ids such
as `run.read` and `tool.grant`. The tree stores something else. A role in
`iam.roles` carries `iam.role_grants` rows keyed by capability name — one
row per registered contract, with an effect of `allow`, `deny` or
`require_approval` — and the kernel's resolver reads those rows and nothing
coarser. There are ~240 capabilities; a matrix over them is not a dialog a
person edits. The issue asked for a decision on what the catalogue is.

Two more facts shape the decision. The kernel's IAM check runs the resolver
only for the enterprise tier: `checkIAM` returns `allow` for every
capability when `canAccessACL(tier)` is false (§1.5), so for a Free, Build
or Scale organization a role's grants govern nothing. And custom roles have
one binding path today: `assign_agent_role` attaches a non-system role to an
agent principal, gated to the enterprise tier and to the assigner's
delegation ceiling (`docs/specs/agent-rbac/spec.md` §3.4); the seven
membership roles humans hold are the seeded system set and
`change_member_role` moves a member between them.

## Decision

1. **A permission is a named bundle of registered capabilities.** The
   catalogue is a static table in `packages/oxagen/src/iam/permission-catalog.ts`
   — seven groups, the mockup's, each permission with an id, a description
   and the capability names it stands for. It is the vocabulary of the role
   editor and the fold the roles read reports in; it is not a store. A
   ticked permission is written as one `allow` grant per capability it
   names, and a permission reads as held when every capability it names is
   allowed. The resolver is unchanged: it keeps reading `role_grants` per
   capability, so a role written through the catalogue and a role seeded
   from `defaultRoles` are the same kind of row.

2. **The catalogue names only what exists.** A test walks the registry:
   every capability in the catalogue is a registered contract, every
   permission names at least one, every id appears once. The mockup's
   permissions with no capability behind them today — repository writes
   (`repo.branch.write`, `repo.pr.open`, `repo.release.create`,
   `repo.tag.create`, `repo.merge`), mandates (`mandate.draw`,
   `mandate.grant`), the kill switch (`switch.flip`), policy simulation and
   activation, `export.create`, `agent.suspend` — are absent rather than
   listed as grants the kernel would never read. Where three mockup ids map
   to one capability (`run.steer`, `run.pause`, `run.cancel` are all
   `dispatch_command`) the catalogue carries one permission,
   `run.control`, because ticking one of the three would grant the other
   two. `org.*` is not a permission: it is the system org Owner role itself,
   which the resolver allows by rule 7.5 whatever its grants say. A lane
   that adds a capability adds it to the permission it belongs to in the
   same PR, or the catalogue does not cover it.

3. **Roles are edited only where the kernel reads them.** `create_role` and
   `set_role_grants` refuse an organization whose tier does not run the
   resolver with `forbidden` / `enterprise_tier_required`. `list_iam_roles`
   reports `enforcement: { tier, enforced }` so the Roles page can say, for
   a Free, Build or Scale org, that the matrix is documentation and the
   kernel does not enforce roles for its tier; enterprise orgs edit it.
   `delete_role` has no tier gate: removing a role narrows nothing.

4. **A granter cannot hand out more than they hold.** The delegation
   ceiling the agent-RBAC spec states for `assign_agent_role` is the same
   rule for the editor: every capability a role would confer is resolved for
   the granting user through the pure resolver with their own roles and
   assignments, and one that resolves to less than `allow` refuses the whole
   set with the capabilities named (`forbidden` /
   `delegation_ceiling_exceeded`). The rule has one implementation,
   `findDelegationCeilingViolations` in `@oxagen/iam`, which
   `assertWithinDelegationCeiling` in `packages/agent` and the role handlers
   both call inside their own transaction. The system org Owner passes by
   rule 7.5; a user with no principal falls through to each contract's
   default effect and is refused.

5. **Custom roles are agent roles; system roles are read-only.** A role the
   editor creates is `is_system_default = false` and `kind: "agent"` in the
   read: `assign_agent_role` is what binds it, to an agent principal, and
   `change_member_role` keeps moving people between the seeded membership
   roles. The seeded roles — the four org roles, the three workspace roles,
   the three agent roles — are read-only in the editor (`conflict` /
   `system_role_readonly`); duplicating one through `create_role` is the
   path to a custom one. A role with an active assignment is not deleted
   (`conflict` / `role_in_use`); the holders are reassigned first.

6. **A role name is unique per organization and scope kind, and a custom
   role name is unique per organization.** The seeded set carries an org
   `Owner` and a workspace `Owner`, so the index over every role is
   `(org_id, scope_kind, lower(name))` (`roles_org_scope_name_uq`, migration
   `20260915140000`), not `(org_id, name)` as #2158 proposed. Custom roles
   add `(org_id, lower(name)) WHERE NOT is_system_default`
   (`roles_org_custom_name_uq`, migration `20260915141000`):
   `assign_agent_role`, `revoke_agent_role` and `get_agent_role` take a name
   with no scope, so a custom org role and a custom workspace role of one
   name would bind whichever row the lookup returned. `create_role`'s
   lower-case name pattern keeps a custom name from equalling a seeded one.
   `create_role` reads either violation as `conflict` / `role_exists`.

7. **Role writes are recorded.** `iam.role_created`, `iam.role_grants_set`
   and `iam.role_deleted` join the security-event taxonomy (migration
   `20260915140500`), beside `org.role_changed`, which stays the membership
   event. None of the three is a governed action: every role and workspace
   write of the lane declares `noBillingGate: true` (ADR-052 exclusion 2,
   INV-28), whatever the mockup's dialog copy says about billing as one
   action.

## Consequences

- The Roles page has one read (`list_iam_roles`: rows folded into
  permissions, the catalogue, the enforcement flag) and three writes, and
  binds no other contract. The app half of #2964 renders the matrix from
  `catalog` and the row's `permissions`, disables Edit and Delete on a
  system role and Delete on a held role, and prints the enforcement copy
  from `enforcement`.
- A seeded role's `permissions` can be partial: `defaultRoles` grants
  capabilities one at a time, and a permission is held only when every
  capability it names is allowed. The row's `grants` stay in the output for
  the case the fold hides.
- A capability outside the catalogue cannot be granted through the editor.
  That is the point: the editor's vocabulary is the seven groups, and
  growing it is a catalogue edit with the registry test as its check.
- The mockup's `kind` (`human`, `agent`, `service`) and `scope`
  (`organization`, `workspace`, `repository`) collapse to what the store
  holds: `kind` is derived (system membership roles are `human`, everything
  else `agent`) and `scopeKind` is `org` or `workspace`. Repository-scoped
  roles bound to a named repository at assignment, and a `service` kind for
  API-key principals, are not built; the row shape leaves room for both.
- `assign_agent_role` keeps its own error class over the shared ceiling;
  the app's kernel seam maps the editor's `HandlerError`s to `denied`,
  `not_found` and `conflict` (§3.2).
