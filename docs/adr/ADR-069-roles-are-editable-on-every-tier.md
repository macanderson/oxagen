# ADR-069: Roles are editable on every tier

- **Status:** Accepted
- **Date:** 2026-09-15
- **Owners:** platform
- **Supersedes:** ADR-063 decision 3 ("Roles are edited only where the
  kernel reads them")
- **Related:** issue #2964 (Organization: roles and the permission
  catalogue, workspaces), `apps/app/ARCHITECTURE.md` §1.5 (which
  organizations the kernel enforces roles for), `packages/handlers/src/iam.role.{create,grants.set}.ts`,
  `packages/iam/src/delegation-ceiling.ts`,
  `packages/iam/src/check-iam.ts:157-182`,
  `apps/app/src/features/organization/roles.tsx`

## Context

ADR-063 decision 3 refused `create_role` and `set_role_grants` for an
organization whose tier does not run the IAM resolver, with `forbidden` /
`enterprise_tier_required`. The reasoning was that a role the kernel never
reads is documentation, so storing one is misleading.

The maintainer's scope decision of 2026-09-15 is that no feature is gated on
the enterprise licence: custom roles and the IAM controls are on for every
tier. That leaves two questions, and the tree answers both.

The first is whether the refusal protected anything. It did not. The
delegation ceiling is the control that stops a granter handing out more than
they hold, and `packages/iam/src/delegation-ceiling.ts` reads no tier: it
resolves every conferred capability for the granter through the pure
resolver. The only `canAccessACL` call is in `packages/iam/src/check-iam.ts`,
the kernel's runtime check. Removing the tier gate therefore removes a
refusal, not a safeguard.

The second is how a customer learns that their roles are recorded rather
than resolved. `list_iam_roles` already answers it: the read carries
`enforcement: { tier, enforced }`.

## Decision

1. **`create_role`, `set_role_grants` and `assign_agent_role` run on every
   tier.** The `enterprise_tier_required` refusal, `assertRolesEnforced` and
   the `enforcement` dependency of the role-editor handlers are deleted.
   `delete_role` never had the gate.

   `assign_agent_role` was added to this list on 2026-09-16 (PR #3110). The
   first version of this decision named only the two editor handlers, and
   `packages/agent/src/handlers/agent.role.assign.ts` kept its own
   `canAccessACL` check refusing every non-system role with `TierDeniedError`.
   Custom roles are agent roles and `assign_agent_role` is their only binder,
   so on Free, Build and Scale the editor this ADR opened created and edited
   roles that nothing could then bind: a working editor and an invisible wall
   at the last step. An entitlement that stops there is worse than one that
   refuses at the start, because the operator meets it only after doing the
   work.

2. **The delegation ceiling and the role gate are unchanged.** An org Owner
   or Admin edits roles (`assertOrgRole`, INV-29, on the acting user), and a
   granter is still refused a set above their own with
   `delegation_ceiling_exceeded`. Both hold on every plan.

   The ceiling's *enterprise wrapper* is not a feature gate and stays.
   `assertWithinDelegationCeiling` reads no tier and resolves the assigner
   through the pure resolver, while below the enterprise tier `checkIAM`'s
   fast-path allows every capability without consulting a grant. Running the
   comparison there would resolve an assigner who holds no explicit grant to
   nothing and refuse every assignment — so `if (canAccessACL(tier))` around
   that one call mirrors the kernel rather than gating a feature. The same
   wrapper, for the same reason, guards `assertToolsWithinCeiling` in
   `agent.definition.commit.ts`.

3. **The page states what the record supports.** Organization › Roles prints
   `enforcement` either way: for an organization the resolver runs for, that
   Oxagen checks these grants on governed calls; otherwise that they are
   recorded, not enforced, and that every governed action is allowed whatever
   a role says. The words are the observe-mode words, because the situation
   is the same one.

## Consequences

- A Free, Build or Scale organization can write the roles it intends to
  enforce before it moves to a tier that resolves them, and the roles are
  already there when it does.
- A role stored below the enterprise tier governs nothing until then. The
  page says so, and the honesty of the claim rests on `enforcement` coming
  from the read rather than from the page.
- Two handler tests go with the guard they covered. The ceiling and role-gate
  negatives stay, and they are the ones that carry the security properties.
- What a Free, Build or Scale organization can do with custom roles, stated
  once: create them, edit their grants, delete them, and bind them to an
  agent's principal. What it cannot do is have the kernel resolve them — every
  governed call by a human is allowed whatever a role says, and `enforcement`
  on `list_iam_roles` is how the page says so. Agent principals are the
  exception the Roles page now names: `checkIAM` resolves them before the tier
  fast-path, so an agent's grants bind on every tier.
- The surfaces that spoke of custom roles as enterprise-only were corrected
  with the gate: the `assign_agent_role` contract's prose and `description`,
  the Appendix E `set_agent_role` definition, and the deprecated app's role
  picker, whose "Custom agent roles are an Enterprise capability" hint is gone
  with the refusal it described.
- `roleEnforcementOf` keeps its one caller, the `list_iam_roles` handler.
