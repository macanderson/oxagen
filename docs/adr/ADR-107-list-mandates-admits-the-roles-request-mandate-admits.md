# ADR-107: `list_mandates` and `get_mandate` admit the roles `request_mandate` admits

## Status

Accepted

## Context

`request_mandate`, `list_mandates` and `get_mandate` govern the same flow (a
workspace member asks for a mandate, then reads the list, then opens the
mandate they created), and their `defaultRoles` disagreed about who may act
in it:

```
request_mandate   org: { Owner, Admin, Member }                    workspace: { Owner, Member }
list_mandates      org: { Owner, Admin, Billing, Compliance }       workspace: {}
get_mandate        org: { Owner, Admin, Billing, Compliance }       workspace: {}
```

A workspace Owner or Member in an enterprise org, holding none of the four
accountable roles (Owner, Admin, Billing, Compliance), could request a
mandate and then could not read the draft they had just created:
`list_mandates`' kernel-level IAM check refused the call before its handler
ran (#3138).

`request_mandate`'s own `org` grant was also wrong in a second way, unrelated
to the narrowing question: this system has no org-scoped "Member" role.
`tools/scripts/seed-iam-defaults.ts`'s `ORG_ROLES` constant, the source of
truth `db:seed-iam` walks every contract's `defaultRoles` against, is Owner,
Admin, Compliance and Billing only. An org `Member` entry in a contract's
`defaultRoles.org` is silently skipped there: it never becomes a seeded
`iam.role_grants` row, so it grants nothing, on any org tier. Worse,
`request_mandate`'s org set (Owner, Admin, Member) never named Billing or
Compliance at all, while the handler's own `assertOrgRole` call already
admits all four (`ACCOUNTABLE_ORG_ROLES`). So an enterprise-org Billing or
Compliance user was refused by the kernel before ever reaching that check.

`packages/handlers/src/_mandate.ts`'s `readerFilter` already implements a
narrower read for exactly the non-accountable caller. It returns the acting
user's id when `assertOrgRole` refuses the accountable roles, and
`mandate.list.ts` (and `mandate.get.ts`) use that id to limit the result to
the agents that user created. Its own comment says the rule: *"an accountable
org role reads every mandate; any other acting user … reads the mandates of
agents they created."* Under the grants above, that branch could never run:
the kernel's IAM check refuses the caller before the handler's own
`readerFilter` gets to. `apps/app`'s `blindSpotOf`
(`apps/app/src/data/contracts/mandates.ts`) carries the surface half of the
same rule in its `reader_scope` branch, equally unreachable until the grants
matched. `get_mandate` carried the identical mismatch one page deeper: even
once `list_mandates` admitted the requester, the mandate detail page each row
links to still refused them, because its `defaultRoles.workspace` stayed
empty.

Two readings were possible: widen `list_mandates` (and `get_mandate`) to
match `request_mandate`, or narrow `request_mandate` (or hide the request
affordance) to match them. The second was rejected on the merits, not on
convenience. `request_mandate`'s workspace roles are the ones the product
needs: a workspace member proposing a mandate for an agent they operate, for
the accountable office to grant or decline. Narrowing them would take that
action away from exactly the people it exists for. Hiding the button was
raised in review on #3117 and rejected in this issue's own write-up for the
same reason: it removes the capability rather than fixing the mismatch, and
leaves `readerFilter`'s narrowing branch dead forever.

## Decision

**`list_mandates` and `get_mandate` admit exactly the same roles
`request_mandate`'s handler already enforces, and no contract in this family
grants a nonexistent org "Member" role:**

```
org:       Owner, Admin, Billing, Compliance (allow, unnarrowed)
workspace: Owner, Member (allow, narrowed)
```

The read rule, stated once: an accountable org role (Owner, Admin, Billing,
Compliance) reads every mandate in the workspace. A workspace Owner or Member
(the same set `request_mandate` admits) reads the mandates of the agents
they created, and the mandates they requested themselves for any agent.
Anyone outside both sets is refused before the handler runs, exactly as
before.

This is enforcement matching a filter that was already written, not new
narrowing logic: `readerFilter` and `blindSpotOf`'s `reader_scope` branch
already implement and render the creator half of this rule. Widening the
grants is what makes it reachable, on both the list and the detail page. The
requester half is new: `request_mandate` admits a workspace Owner or Member
to request a mandate for any agent, not only one they created (that is the
point of the role; see Context above), so a narrowing that only checked the
agent's creator left a requester unable to read back a draft they made for
an agent someone else operates. `mandate.list.ts` and `mandate.get.ts` now
admit a mandate row when the caller created its agent OR is the mandate's
own `requestedBy`, two independent grants of visibility rather than one
narrowed by the other.

`readerFilter` (`packages/handlers/src/_mandate.ts`) runs its own workspace
role check (`assertOrgRole(ctx, { org: [], workspace: ["Owner", "Member"] })`)
rather than treating every caller its accountable-role check refuses as a
narrowed reader. That distinction matters beyond an enterprise org:
`checkIAM` allows every capability unconditionally on a non-enterprise tier
(`packages/iam/src/check-iam.ts`'s `tier_gate` step), so this handler-level
check is the only gate a Free, Build or Scale org actually runs, and the
earlier version admitted a workspace Viewer, or an Owner/Member demoted
after creating an agent, as a narrowed reader on those tiers.

## Consequences

- A workspace Owner or Member can now read the mandates of the agents they
  created on both `list_mandates` and `get_mandate`, and the mandates they
  requested themselves for any agent, including a draft they just requested
  for an agent someone else operates and the detail page its row links to.
- They still cannot read another operator's agent's mandates they did not
  request themselves, or the workspace's full ledger: `readerFilter` narrows
  every such read to `createdById = actingUserId OR requestedBy =
  actingUserId`.
- A workspace Viewer, or a role outside Owner/Member entirely, is refused on
  every tier, not only an enterprise org: `readerFilter`'s own workspace
  role check enforces it directly, since `defaultRoles` alone only gates an
  enterprise org.
- `apps/app` needed no logic change: `blindSpotOf`'s `reader_scope` branch
  already tells a narrowed reader their view is limited instead of reporting
  "no mandate" when mandates are only hidden from them, and now renders on a
  live path instead of a theoretical one. It did need a copy fix: the
  `partial`-view strings in `apps/app/messages/{tools,agents,mandate}.json`
  described only the creator grant, and were updated to also name the
  requester grant once that landed (below).
- The API route, MCP tool and CLI carry no capability-specific role logic
  (the kernel enforces `defaultRoles` centrally), so no other surface needed
  a change beyond these two contracts.
- **Existing enterprise orgs need `pnpm db:seed-iam` re-run in production.**
  A contract's `defaultRoles` only takes effect for an already-provisioned
  enterprise org once its role grants are materialized into
  `iam.role_grants`; `db:seed-iam` does that (idempotently, via
  `ON CONFLICT DO NOTHING`) but is not part of `db:migrate` or any deploy
  workflow, so it is a genuine external action this PR cannot perform from
  its own commits. A non-enterprise org is unaffected either way: `checkIAM`
  gives it an unconditional allow, so this fix already applies there the
  moment the deploy lands.

## Alternatives considered

- **Narrow `request_mandate` to the accountable roles.** Rejected: it removes
  the "propose a mandate" action from the operators it was built for, and the
  problem this issue reports (two capabilities in one flow disagreeing about
  the same user) is exactly as present after removing the wider side as after
  widening the narrower one. Only the direction of the fix differs, and the
  wider direction is the one the product needs.
- **Hide the "Request a mandate" button for non-accountable roles.** Rejected
  for the same reason, plus: it treats a permissions bug as a UI problem,
  leaves `readerFilter`'s narrowing branch permanently dead, and still
  disagrees with `request_mandate`'s own grants unless that contract is also
  changed, at which point it is the first alternative.
- **Grant an org-scoped "Member" role to match the issue's own comparison
  table.** Rejected: no such role exists anywhere else in this system, and
  inventing one to patch a documentation mismatch would need a real
  enforcement path (a new `iam.roles` seed, provisioning logic, and every
  consumer of `SystemOrgRole` updated) for a grant `request_mandate`'s own
  handler was never going to check. The workspace-scoped roles already carry
  the narrowing this issue asks for.
