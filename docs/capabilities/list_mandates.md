# list_mandates

**Domain:** mandate
**Mode:** sync
**Scope:** tenant + workspace
**Surfaces:** api, mcp, agent
**Sensitivity:** medium
**Metering:** none (`noBillingGate`, a console read)

## Intent

The ledger view the accountable office reads (Tools › mandates) and the
mandates one agent holds (Agents › mandates), newest first, with remaining
authority by measure from the ledger.

## Input

| Field | Type | Notes |
| --- | --- | --- |
| `agentId` | `string?` | Only this agent's mandates (`agt_…`). |
| `status` | `draft \| active \| expired \| revoked`? | Only this status. |
| `limit` | `number` | 1–100, default 50. |

## Output

`{ items: Mandate[] }`.

The mandate shape (spec §6.9 part 3): `agentId` (`agt_…`), `consequenceTags`,
`limits` (measure → `{ perCall?, perPeriod?, period: daily | weekly | monthly,
currencyOrUnit }`, integer strings: micros for a currency, whole units
otherwise), `targets` (measure → `{ allow, deny }` globs over a text measure),
`tools` (globs over `slug@version` or `slug`), `approval` (`{ humanAbove,
alwaysHumanFor, approvers }`), `purpose`, `validFrom`, `validTo`. Every read
returns the row plus `authority`: per limited measure the period key, the
settled and reserved values this period and `remaining`: `perPeriod` less
those two, floored at zero, the figure the gate reserves against.

## Readers

An org Owner, Admin, Billing or Compliance reads every mandate in the
workspace. `defaultRoles` otherwise matches `request_mandate`'s workspace
grant (Owner, Member, ADR-107): a workspace Owner or Member who may ask for a
mandate reads the mandates of agents they created, and the mandates they
requested themselves for any agent, so the person who requests a mandate can
always read the draft they just made, even for an agent someone else
created. There is no org-scoped "Member" role in this system, so an org
member with no workspace role is refused.

Anyone else (no accountable office role and no workspace role
`request_mandate` admits either) is refused by default, but not always at
the same point, and not always at all. On a Free, Build or Scale org, IAM's
tier gate admits every capability unconditionally regardless of
`defaultRoles`, so a workspace Viewer (or any other role) reaches the
handler and `readerFilter`'s own workspace-role check is what refuses them,
`forbidden`/`org_role_required`. On an enterprise org, `defaultRoles`
refuses a caller with no qualifying built-in role before the handler runs,
the same reason, at the kernel instead. But an enterprise org's own IAM
configuration can also admit a caller through any other explicit allow
path naming `list_mandates` or `get_mandate` (a custom `role_grants`
entry, a workspace or organization direct grant, or an enforced org allow
policy, per `packages/oxagen/src/iam/resolve.ts`), to a role that is neither
an accountable office role nor a built-in workspace Owner/Member: that
caller clears the kernel through the explicit grant, and `readerFilter`
does not re-check the built-in workspace roles on an established
enterprise tier, so they are not refused. They take the same
narrowed-reader scope a workspace Owner/Member gets (agents they created,
mandates they requested), never the unnarrowed office view.

The same skip applies to an agent-run call, on any tier. IAM's tier gate
only bypasses the resolver for a human or service principal; an agent
principal always runs the full delegation-ceiling resolver
(`packages/iam/src/check-iam.ts`), so an agent explicitly authorized for
this capability has already cleared the kernel by the time it reaches
`readerFilter`. The workspace-role check exists only to enforce the roles
`defaultRoles` cannot enforce on a non-enterprise tier for a human/service
call; running it for an agent run would refuse an agent the kernel already
admitted, so `readerFilter` skips it there too and returns the same
narrowed-reader scope.

## Errors

| code | reason | meaning |
| --- | --- | --- |
| `forbidden` | `no_principal` | No signed-in user on the request. |
| `forbidden` | `org_role_required` | Neither an accountable office role, a workspace Owner/Member, nor (on an enterprise org) any other explicit IAM allow path admits the caller; refused by the kernel on an enterprise org with no such grant, or by `readerFilter` itself on a non-enterprise tier (ADR-107). |

## SPEC references

- §6.9 part 3 (the ledger the accountable office reads), App. E; ADR-059
