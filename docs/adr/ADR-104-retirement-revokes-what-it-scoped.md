# ADR-104: Retirement revokes what it scoped, rather than refusing while it exists

- **Status:** Accepted
- **Date:** 2026-09-19
- **Owners:** platform, kernel
- **Related:** ADR-059 (mandates); ADR-102 (a limit change merges under the
  mandate row lock); MC spec §6.2, §6.9 part 3; #3124 (this issue); #3123
  (an archived workspace leaves its API keys working — the same question,
  unimplemented here)
- **Decides for:** `retire_agent` (`packages/handlers/src/agent.retire.ts`),
  `request_mandate`, `grant_mandate`, `update_mandate_limits`
  (`packages/handlers/src/mandate.request.ts`, `mandate.grant.ts`,
  `mandate.limits.update.ts`)

## Context

`retire_agent` archives an agent, suspends its principal, and revokes every
live credential and host enrollment in one transaction. It did not touch the
agent's mandates. `resolveAgent`, the lookup `request_mandate` and
`grant_mandate` share with `list_mandates`, `get_mandate` and
`revoke_mandate`, filters on workspace and `deletedAt` and never reads
`agents.status`. So both capabilities — and `update_mandate_limits`, which
locates its subject by mandate id and never resolved an agent at all —
succeeded against a retired identity. The result: a `tools.mandates` row that
reads `active`, with a validity window and remaining authority
`readAuthority` reports, bound to a principal that is suspended and can never
draw on it. A record that describes authority nobody can use is a record that
does not describe the world.

The issue names the general shape: **an object that outlives the thing that
scoped it.** An API key survives its workspace's archival (#3123, unresolved).
A mandate survives its agent's retirement (here). In both cases the parent's
handler already lists what it cleans up on the way out — `retire_agent`
already revokes credentials and enrollments — and the list was missing a
member. Two questions decide the shape of the fix:

1. Does an active mandate **survive** its agent's retirement, so only new
   grants are refused? Or does retirement **revoke** what is live, the way it
   already revokes credentials and enrollments?
2. Should `retire_agent` **refuse** while a live mandate exists, the way
   `archive_workspace` refuses while an agent is still registered?

## Decision

**Retirement revokes; it does not refuse, and it does not leave a live
authority behind.**

- `retire_agent` now also revokes every mandate still `active` or `draft`
  against the agent's principal, in the same transaction that archives the
  agent, suspends the principal, and revokes credentials and hosts. This is
  the fourth member of a list `retire_agent` already owns, not a new kind of
  write: it releases parked reservations and expires open approval requests
  the same way `revoke_mandate` does, under each mandate's row lock, and
  records `revokedReason` as the retirement's own reason.
- `retire_agent` does **not** refuse while a mandate is live. An operator
  retiring an agent — most urgently, one that is compromised or
  misbehaving — needs its authority cut in the same action, not blocked
  behind first tracking down and revoking every mandate by hand. Retirement
  is the kill switch; a switch that refuses to throw while the thing it kills
  is running is not one.
- `request_mandate`, `grant_mandate`, and `update_mandate_limits` refuse to
  create or widen authority against a retired agent, with the typed reason
  `agent_retired` `packages/handlers/src/lib/agent-identity.ts` already uses
  for the other agent-identity writes. `grant_mandate`'s check covers
  activating an existing draft whose agent retired after the request was
  made, because it resolves the agent from `input.agentId` on every path,
  requestId or not.
- `list_mandates`, `get_mandate`, and `revoke_mandate` are unchanged. They
  share `resolveAgent` with `request_mandate` and `grant_mandate`, but that
  resolver does not itself refuse on `status`; the refusal lives in the two
  widening capabilities, which call `assertAgentActive` after it returns. The
  ledger a retired agent left stays readable, and — belt and braces, since
  retirement now revokes everything live on its own — a mandate is still
  revocable by hand if one is ever found active after the fact.

**Why revoke and not refuse-and-require-cleanup-first:** the alternative
(`retire_agent` refuses while a mandate is live, the way `archive_workspace`
refuses while an agent is registered) is right for a *workspace* archival,
where the operator is choosing to wind something down and should see what is
still attached to it before they do. It is wrong for an *agent* retirement,
where the far more common trigger is "this identity should stop being able to
act, now" — a security response, an offboarding, a credential compromise.
Requiring every mandate to be revoked one at a time before the agent can be
retired makes the platform slower than the incident it exists to contain.
Revoking on retirement is also the durable answer under SCR-002: it needs no
runbook step nobody will remember, and it cannot be skipped by a caller in a
hurry.

**#3123 is not resolved by this ADR.** The general principle — a scoped
child's authority does not survive the parent's end unless the parent's
own handler is taught to keep it alive on purpose — applies the same way to a
workspace's API keys. Implementing that fix is left to #3123; this ADR
records that the same reasoning should settle it, so whoever picks it up does
not re-litigate the choice.

**No route or tool change was needed on `api` or `mcp`.** `agent_retired` is a
`HandlerError` with `code: "conflict"`. `apps/api`'s Hono `onError` middleware
(`apps/api/src/middleware/error.ts`, `HANDLER_ERROR_STATUS`) maps every
`HandlerError` generically by `code`, never per reason, so a new reason needs
no route change. `apps/mcp`'s tool wrappers (`apps/mcp/src/tools/mandate.*.ts`)
call `invoke` and return its result with no per-error handling of their own;
a thrown `HandlerError` propagates to xmcp's own generic tool-error response.
The same reason already reaches both surfaces unchanged for
`rotate_agent_credential` and `suspend_agent`, which throw it today.

## Consequences

- A mandate's status, once its agent is retired, is truthful: `revoked` with
  a reason naming the retirement, never a lingering `active` nobody can act
  on.
- `retire_agent`'s output gains `revokedMandates` alongside
  `revokedCredentials` and `revokedHosts`, and its `mandate.revoked` security
  event fires when it revoked at least one.
- The next child resource scoped to an agent (or a workspace) still has to be
  remembered by hand in the parent's retire/archive handler; this ADR does
  not build the shared "what is scoped to X" registry the issue floats as
  future work, because the two-item list `retire_agent` now carries a fourth
  member of is not yet painful enough to generalize.
