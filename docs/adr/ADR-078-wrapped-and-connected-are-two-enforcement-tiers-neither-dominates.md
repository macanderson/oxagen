# ADR-078: Wrapped and connected are two enforcement tiers, and neither dominates the other

- **Status:** Accepted; §1 amended 2026-09-18 by ADR-095 (the ladder has four words and `gateway` is computed from what was routed); §4 amended 2026-09-19 (closes #3151: the identity a gateway-forwarded call is attributed to, in evidence, versus the identity its authorization decision runs against)
- **Date:** 2026-09-16
- **Owners:** platform
- **Related:** `docs/specs/tacho/spec.md` §2 item 2 and §6.3 (the `enforcement_tier`
  field and the honesty rule), `docs/specs/oxagen-desktop/spec.md` §6 (the wrapper
  table), ADR-040 §4 (attestation versus gateway enforcement), ADR-043 (runtime
  excision — Oxagen governs agents, it does not run them), ADR-066 (an agent
  requests a system, scope or action; a decision rule answers), ADR-067 (Mission
  Control leads, the control plane is the category), ADR-080 (Stella is wrapped
  through its hooks)

## Context

The desktop app wraps coding agents. Every harness it supports — Claude Code,
Codex, Stella — has a hook surface, so Tacho installs a `PreToolUse` command
hook and from then on sees every action the agent takes, including the
harness's own built-in Bash and Edit, and can answer `deny`
(`packages/tacho/src/claude-code/hooks.ts:308`).

The AI applications a non-developer actually runs — Claude Desktop and its
kin — have no hook surface. They have an MCP client config. If Oxagen is to be
the control plane for every AI app on a machine rather than only the coding
ones, it has to govern something it cannot hook.

There is exactly one thing it can govern there: the tools it serves. So the
enrollment writes one MCP server entry into the app's config, pointing at a
gateway the collector daemon already has a process for, and the gateway serves
the workspace's toolbelt under the mandate. Nothing else about that app is
visible to Oxagen.

This is a genuinely different relationship from wrapping, and the product will
lie to a security team if it renders the two the same way. It is also
tempting to describe the new one as weaker, which is equally wrong.

The repository already carries the vocabulary. `ENFORCEMENT_TIERS` in
`packages/tacho/src/envelope.ts:63` is `["gateway", "harness", "observe"]`,
denormalised onto every session row (`packages/database/src/schema/tacho.ts:382`,
`packages/telemetry/src/migrations/0027_tacho_events.sql:25`) and exposed on
`sessionSummarySchema`. The Tacho spec §2 already settles what those words
mean: a hook that denies a tool call inside a process Oxagen does not own is
**attestation with harness-level enforcement**, graded `client_attested`; only
calls routed through Oxagen's governed gateway are **gateway-enforced**. §401
item 13 adds the honesty rule: the fleet UI, exports and reports never use the
word "enforced" for a `harness` or `observe` session.

What the tree does not yet have is a *host*-level statement of which tier a
given AI app on a given machine can reach at all, or any code that puts an
Oxagen server into a connected app's config.

## Decision

### 1. The two tiers are named, and they are the two that already exist

The product speaks of **wrapped** and **connected** agents. On the wire and in
the record these are the existing `enforcement_tier` values. No fourth value is
minted.

| Product word | `enforcement_tier` | Harnesses | Mechanism |
|---|---|---|---|
| **Wrapped** | `harness` | Claude Code, Codex, Stella, any agent calling `tacho hook --agent` | `PreToolUse` command hook |
| **Connected** | `gateway` | Claude Desktop, Cowork, any MCP client | an Oxagen MCP server in the app's client config |

`observe` is unchanged and orthogonal: it is what a wrapped host reports when
its policy bundle is in observe-only mode.

### 2. Neither tier dominates the other, and the product must never imply it does

This is the substance of the decision, and it is the thing a reasonable reader
gets backwards.

**Wrapped is broader and weaker.** It sees every action — the model's tool
calls, the harness's own Bash, its file edits, its network calls — and produces
a full step record with a hash chain. But the hook runs inside a process Oxagen
does not own. A user can delete the hook entry, run with `--dangerously-skip-permissions`,
or run a build of the harness that ignores hooks. The record is `client_attested`:
an action the agent did not report is one Oxagen never saw, not one it can flag
as skipped. Tacho detects removal after the fact (`oxagen:hooks_removed`,
`oxagen:unobserved_session`) but cannot prevent it.

**Connected is narrower and stronger.** Oxagen sees only what routes through
its gateway — nothing else the app does, nothing the user types, no other tool
the app has. But for what it does see, the kernel evaluates IAM, entitlement,
tool RBAC, consent and the decision-rules gate **on the server**, and a denied
call does not execute. That is not attestation. It is refusal.

So a security team gets *breadth* from wrapping and *certainty* from
connection, and the two are not substitutes. A copy line, a badge, a column or
a report that puts them on one axis — "fully governed" versus "partially
governed" — is wrong in both directions and is banned. The desktop panel and
the fleet surface state, per row, both what the tier records and what it does
not.

### 3. The connected tier can be routed around, and this is a property, not a bug to hide

A connected app's config is a file the user owns. Nothing stops them adding a
second MCP server beside ours, and a tool served by that server never touches
Oxagen. Every connected surface therefore reports the count and the names of
the other MCP servers configured in that app
(`oxagenMcpPresence().otherServers`), because the size of the gap is a fact the
operator is entitled to.

**Closing that gap is not a code change in this repository.** It requires the
vendor to offer an administrator-controlled policy file that constrains which
MCP servers a user may add, distributed by MDM — the same shape as Claude
Code's managed settings with `allowManagedHooksOnly`, which Tacho already
renders (`renderManagedSettings`, spec §5.5). Where a vendor offers one, Oxagen
renders it for MDM distribution and says so; where a vendor does not, Oxagen
says the tier is advisory on that app and does not pretend otherwise. We do not
ship a watcher that fights the user for their own config file: a control that
can be turned off by the person it constrains is theatre, and claiming it as a
control is worse than not having it.

### 4. The local gateway is a proxy, not a second materialiser

`@oxagen/tacho` is a leaf package with no `@oxagen/*` runtime dependency
(`packages/tacho/package.json`), and that constraint is kept. The collector's
gateway therefore does **not** import `materializeTools`, `mcp-rbac` or
`tool-budget`. It forwards the MCP JSON-RPC envelope to the workspace MCP
endpoint over HTTPS, carrying a credential minted for exactly this job.

**Not the host key.** The first draft of this ADR said attribution rode the
host's own API key, on the grounds that it is already an Oxagen key bound to
the enrolling org and workspace. That was wrong, in the direction that matters.
An API-key principal has no `org_users` row, so `assertCallerRole` returns
early for one and every role gate passes; `checkIAM` then allows every
non-enterprise org through a tier fast-path; and the host key's creator is the
enrolling Owner or Admin. A connected app forwarding through the gateway
therefore held **owner authority over the workspace** and could call MCP-only
operations such as `set_model_credential`. The mandate this ADR is about was
decoration.

Two things fix it, and both are load-bearing:

1. **A key's purpose is enforced.** `machineKeyDenial`
   (`packages/iam/src/machine-key-scope.ts`) runs in the kernel's IAM adapter
   *before* `checkIAM`, so it sits ahead of the tier fast-path and on the
   single `invoke()` path rather than in each handler — the pattern that
   produced the bug. A key whose scope names a purpose may invoke only what
   that purpose is for, and an unrecognised purpose is allowed nothing.
   `tacho_host_v1` is held to the three calls the control client makes.
2. **The gateway has its own credential.** Enrollment mints a second key with
   purpose `tacho_gateway_v1`, and the gateway presents that. Its mandate is a
   rule rather than a list: a capability on the `mcp` surface that does not
   mutate and is not high-sensitivity. A host with no gateway key serves no
   tools and never falls back to the host key.

Consequences, all of them intended:

- there is exactly one tool materialiser, one RBAC evaluation and one meter,
  and they are the ones that already exist;
- the gateway runs no turn, calls no model and spawns no worker, so ADR-043
  holds without an exception;
- a call that cannot be attributed to an org and a workspace is refused rather
  than defaulted, because attribution rides the gateway key and a host without
  one has nothing to present;
- when the control plane refuses a turn for exceeding a provider's tool cap,
  the gateway surfaces that message — which names the model, the limit and the
  count — rather than replacing it with a gateway error.

**The AI app never holds an Oxagen credential.** The gateway holds it; the app
holds a loopback URL. A non-developer will not paste a token into a JSON file,
and asking them to would move the credential onto the least protected surface
on the machine. The app *is* the credential.

### 5. What the evidence ledger holds, per tier

Stated plainly, because this is the claim an auditor will test.

| | Wrapped (`harness`) | Connected (`gateway`) |
|---|---|---|
| Session boundary | yes — `SessionStart` … `SessionEnd`, hash-chained | no — there is no session, only individual calls |
| The user's prompt | yes (`UserPromptSubmit`) | no |
| Model calls, token counts | yes, via the harness's OpenTelemetry export | no |
| The agent's built-in Bash, Edit, file and network activity | yes | no — invisible |
| Tool calls to Oxagen capabilities | yes | yes |
| Tool calls to *other* MCP servers in that app | yes, if the harness is wrapped | no — invisible |
| A denied call | recorded as a deny; the harness is trusted to honour it | recorded as a deny; the call did not execute |
| Grade | `client_attested` | server-enforced |
| Chain | one chain per session | per-call records on the host chain |

A connected row therefore has no step record, and nothing in the app, the CLI,
the docs or an attestation report may present one.

### 6. Both tiers can hold on one machine, and on one app

Enrollment is per host, and a host carries a tier per harness, not one tier
overall. A machine with Claude Code wrapped and Claude Desktop connected is the
normal case, not an edge case, and `host.json` carries the harness list with a
tier for each.

An app can in principle be both — a future harness with a hook surface *and* an
MCP client. When that happens it is wrapped **and** connected, its sessions
carry `gateway` for the calls that routed through Oxagen and `harness` for the
rest, and the surfaces show both. Nothing here assumes the two are exclusive.

## Consequences

- `HARNESSES` in the desktop app and `tachoHarnessSchema` in
  `packages/tacho/src/wire.ts` grow beyond the three coding agents, and every
  surface that renders a harness row must read its tier before choosing words.
- `host.json` gains a tier map. Its schema version moves forward and older
  files must keep loading, since a host enrolled by an earlier build is a host
  in the fleet.
- The writer layer generalises from "hooks" to "whatever this harness's config
  file wants". `mcp-config-writer.ts` is the connected-tier sibling of
  `settings-writer.ts` and keeps its contract exactly: pure functions over a
  parsed document, idempotent, marker-scoped to one enrollment, foreign entries
  preserved, collisions displaced and restored rather than lost.
- The collector's loopback listener stops being reachable only by processes we
  installed and becomes reachable by any MCP client on the machine. It is
  therefore hardened as an externally reachable surface: bearer required on
  every request, bound to `127.0.0.1`, and `Origin`/`Host` checked so a web
  page in the user's browser cannot reach it by DNS rebinding.
- Per-harness detection replaces "is a coding agent installed". The first-run
  flow for a machine with no developer harness detected offers the AI apps it
  found and leaves PATH linking, shell-profile edits and CLI sidecars off.

## Alternatives considered

**One tier, and call the connected one "monitored".** Rejected: it invites the
reading that connected is a weaker wrapped, which is false in the direction that
matters — a connected deny actually prevents the call and a wrapped one does not.

**Import `materializeTools` into the collector.** Rejected: it breaks the leaf
constraint, puts a second materialiser on the machine that can disagree with the
server's, and drags the agent runtime into a process on the user's laptop, which
is the thing ADR-043 excised.

**Ship a watcher that reverts unauthorised MCP servers in a connected app's
config.** Rejected under §3. It is losable by construction, it fights the user
for a file they own, and claiming it as a control would be the exact dishonesty
§2 exists to prevent.

**Wait for vendors to ship hook surfaces.** Rejected: it is a dependency this
repo does not control, and the connected tier is worth shipping on its own —
server-enforced refusal on every Oxagen tool call is a real control, whatever
else the app does.

## Amendment 2026-09-18: the ladder has four words

Maintainer decision of 2026-09-18, recorded in ADR-095.

Two sentences in §1 change. **"No fourth value is minted."** `contained` is the
fourth, added in Phase 5 (ADR-096). **"Connected | `gateway`"**: `gateway` is no
longer only the connected tier. From Phase 4 (ADR-094) it is any run whose model
or MCP traffic was routed through `tachod`, and the tier is computed from what
was routed, not assigned from the harness name.

§2 stands. Breadth and certainty are different things, no surface renders a tier
as a score or as "fully governed", and every surface states what the tier
records and what it does not. §3 to §6 stand unchanged. At `main` the MCP
gateway is still registered only into Claude Desktop
(`CONNECTED_HARNESSES = ["claude-desktop"]`).

## Amendment 2026-09-19: which model closes #3151, and the identity split it needed

§4 named the fix: the gateway's own credential, plus `machineKeyDenial`'s
purpose-based mandate. But #3151 asked a sharper question the original text
did not settle: is the fix "give the host its own agent identity with a fixed
mandate", or "refuse the machine key outright at the generic endpoint"? Answer:
**neither, precisely.** The shipped model is a third option, and this
amendment records it as the decision rather than leaving it to be inferred
from the diff.

**The decision.** A connected app is not modelled as its own agent principal
with delegated role grants (option 1). Tacho hosts are not agent principals
at all yet, and inventing one only for the gateway would duplicate the
mandate mechanism this ADR already built. Nor is the generic MCP endpoint
closed to purpose-scoped keys outright (option 2): that would take a
connected app's toolbelt to zero, which is the outcome §2 says a security
team must never be sold as a strengthening. The mandate stays a RULE
evaluated by `machineKeyDenial` against the key's *purpose*, not against any
principal's role grants, decided once, unconditionally, before `checkIAM`
runs on any tier. That rule is what a connected app may reach:

- **`tacho_gateway_v1`**: any capability on the `mcp` surface that does not
  mutate and is not `sensitivity: "high"`. `set_model_credential` and
  `delete_model_credential` fail both tests and are refused by name, at every
  org tier, including non-enterprise (the tier `checkIAM`'s fast-path would
  otherwise wave through with no policy consulted at all). `gatewayMayInvoke`
  (`packages/iam/src/machine-key-scope.ts`) is the rule; nothing else decides
  it.
- **`tacho_host_v1`**: exactly the three calls the control client makes
  (`ingest_tacho_events`, `get_tacho_bundle`, `fetch_commands`), enumerated
  rather than derived, because a host's job is fixed at mint time.

**The residual identity question, named rather than left implicit.** Closing
`org.model_credential.set` did not by itself settle whose IDENTITY a
*permitted* gateway call runs under. `fetchAuthz` still resolves a
purpose-scoped key to its creator's role grants for the enterprise-tier full
resolver. That is unchanged, and load-bearing: that inheritance is what lets a
machine key pass the resolver on an enterprise org at all, since an API-key
principal holds no `org_users` row of its own. The two remaining questions
that inheritance raised are:

1. *Does that mean a purpose-scoped key "acts for a person"?* No, and
   `fetchAuthz`'s own docstring now says so, reconciled with
   `resolveOperatorUserId`'s existing rule, which already refused a
   purpose-scoped key for the operator-management handlers that call it
   directly. Both functions now agree: inheriting a role grant to pass a
   resolver is not the same act as a person requesting something, and
   neither function was in a position to CHANGE that inheritance without
   breaking the machine flows (`ingest_tacho_events`, `get_tacho_bundle`)
   that `defaultEffect: "deny"` on non-enterprise tiers would otherwise
   strand. The mandate rule above is what decides reachability; the
   inheritance is only how an enterprise org's role grants apply on top of
   it, and it can only narrow, never widen, what the mandate already
   permits.
2. *Does the evidence say so too?* Before this amendment, no. The audit row
   for an allowed gateway call recorded the enroller's own principal, because
   that is what `fetchAuthz` returned and `checkIAM` audited without
   question. `checkIAM` now attributes such a call's audit row to the
   credential (`tacho_gateway_v1` or `tacho_host_v1`), never the enroller,
   on every tier, including the tier-bypass path, which previously recorded
   an anonymous zero-id principal and now identifies the actual key. The
   kernel's `resolvedPrincipal`, which feeds `runInTenantScope`'s RLS
   GUC and is documented as a genuine `iam.principals.id`, is deliberately
   untouched by this: an API key's id is not a row in that table, and
   widening the swap to cover it would trade a real vulnerability for a
   dangling foreign reference RLS predicates could misread. Evidence
   attribution and role-grant resolution are answered by the same key, but
   they are not required to be answered with the same VALUE, and after this
   amendment they are not.

**What a connected app may reach, stated plainly, because this is the claim
an auditor tests.** Read-only, non-mutating, non-high-sensitivity `mcp`
capabilities: nothing that changes workspace state, nothing that reveals a
secret, credential, or audit record, and never an org-admin action such as
`set_model_credential` regardless of which Owner or Admin enrolled the
machine. Every call it does make is recorded against the gateway credential,
so the fleet record shows what the connected app itself did, not what the
enrolling operator could have done.

## Alternatives considered (added 2026-09-19)

**Model the host as its own agent principal with delegated role grants
(candidate 1 from #3151).** Rejected for now: Tacho hosts carry no agent
principal today, and building one only to re-derive the same mandate
`machineKeyDenial` already enforces by rule would be a second mechanism
answering a question the first already answers, with no capability gained:
the mandate is already independent of any person's grants. Revisit if a
connected app's mandate ever needs to vary per host rather than per
organisation-wide rule.

**Refuse `tacho_gateway_v1` outright at the generic MCP endpoint (candidate 2
from #3151).** Rejected: it takes a connected app's toolbelt to zero, which
is the "connected is a weaker wrapped" reading §2 already bans the product
from implying. A control that leaves a security team with no governed
surface for the AI apps they cannot hook is not a stronger control. It is
an absent one dressed as caution.
