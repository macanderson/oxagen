# ADR-104: `list_mandates` admits the roles `request_mandate` admits

## Status

Accepted

## Context

`request_mandate` and `list_mandates` govern the same flow — a workspace
member asks for a mandate, then the page that asked refreshes by reading the
ledger — and their `defaultRoles` disagreed about who may act in it:

```
request_mandate   org: { Owner, Admin, Member }   workspace: { Owner, Member }
list_mandates     org: { Owner, Admin, Billing, Compliance }   workspace: {}
```

A workspace Owner or Member in an enterprise org, holding none of the four
accountable roles (Owner, Admin, Billing, Compliance), could request a
mandate and then could not read the draft they had just created:
`list_mandates`' kernel-level IAM check refused the call before its handler
ran (#3138).

`packages/handlers/src/_mandate.ts`'s `readerFilter` already implements a
narrower read for exactly this caller — it returns the acting user's id when
`assertOrgRole` refuses the accountable roles, and `mandate.list.ts` uses that
id to limit the result to the agents that user created. Its own comment says
the rule: *"an accountable org role reads every mandate; any other acting
user … reads the mandates of agents they created."* Under the grants above
that branch could never run — the kernel's IAM check refuses the caller
before the handler's own `readerFilter` gets to. `apps/app`'s
`blindSpotOf` (`apps/app/src/data/contracts/mandates.ts`) carries the
surface half of the same rule in its `reader_scope` branch, equally
unreachable until the grants matched.

Two readings were possible: widen `list_mandates` to match `request_mandate`,
or narrow `request_mandate` (or hide the request affordance) to match
`list_mandates`. The second was rejected on the merits, not on convenience:
`request_mandate`'s roles are the ones the product needs — a workspace member
proposing a mandate for an agent they operate, for the accountable office to
grant or decline — and narrowing them would take that action away from
exactly the people it exists for. Hiding the button was raised in review on
#3117 and rejected in this issue's own write-up for the same reason: it
removes the capability rather than fixing the mismatch, and leaves
`readerFilter`'s narrowing branch dead forever.

## Decision

**`list_mandates`'s `defaultRoles` matches `request_mandate`'s exactly, plus
the accountable-office roles that read every mandate:**

```
org:       Owner, Admin, Billing, Compliance (allow, unnarrowed) + Member (allow, narrowed)
workspace: Owner, Member (allow, narrowed)
```

The read rule, stated once: an accountable org role (Owner, Admin, Billing,
Compliance) reads every mandate in the workspace. Anyone else who may
*request* a mandate — an org Member, or a workspace Owner or Member — reads
only the mandates of the agents they created. Anyone outside both sets is
refused before the handler runs, exactly as before.

This is enforcement matching a filter that was already written, not new
narrowing logic: `readerFilter` and `blindSpotOf`'s `reader_scope` branch
already implement and render this rule. Widening the grants is what makes
them reachable.

## Consequences

- A workspace Owner or Member (and an org Member) can now read the mandates
  of the agents they created, including a draft they just requested.
- They still cannot read another operator's agent's mandates, or the
  workspace's full ledger — `readerFilter` narrows every such read to
  `createdById = actingUserId`.
- `apps/app` needed no change: `blindSpotOf`'s `reader_scope` branch already
  tells a narrowed reader their view is limited instead of reporting "no
  mandate" when mandates are only hidden from them, and now renders on a live
  path instead of a theoretical one.
- The API route, MCP tool and CLI carry no capability-specific role logic (the
  kernel enforces `defaultRoles` centrally), so no other surface needed a
  change beyond this contract.

## Alternatives considered

- **Narrow `request_mandate` to the accountable roles.** Rejected: it removes
  the "propose a mandate" action from the operators it was built for, and the
  problem this issue reports — two capabilities in one flow disagreeing about
  the same user — is exactly as present after removing the wider side as
  after widening the narrower one. Only the direction of the fix differs, and
  the wider direction is the one the product needs.
- **Hide the "Request a mandate" button for non-accountable roles.** Rejected
  for the same reason, plus: it treats a permissions bug as a UI problem,
  leaves `readerFilter`'s narrowing branch permanently dead, and still
  disagrees with `request_mandate`'s own grants unless that contract is also
  changed — at which point it is the first alternative.
