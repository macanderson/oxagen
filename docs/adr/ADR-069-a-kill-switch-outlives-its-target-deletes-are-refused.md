# ADR-069: A kill switch outlives its target — deleting what it names is refused

- **Status:** Accepted
- **Date:** 2026-09-16
- **Supersedes:** nothing. Extends ADR-068 (tools: classification vocabulary, assurance hosting, observed-schema source), which introduced kill switches.
- **Context:** #2958, PR #3025 review

## Context

A kill switch (`set_kill_switch`, MC spec §6.11) is an `iam.emergency_denies`
row that names its target in `target_kind` / `target_id` — public ids an
operator recognises — and carries, beside that, the typed deny the live checks
actually match. ADR-068 §4 fixed what that deny is:

| Target kind | Deny |
|---|---|
| `tool_version` | `capability` deny on `mcp.<mcp_servers.id>.<name>` |
| `tool_server` | `resource_scope` deny over `resourceScopeDigestOf({ kind: "tool_server", id: mcp_servers.id })` |
| `connection` | `resource_scope` deny over `resourceScopeDigestOf({ kind: "connection", id: mcp_credentials.id })` |
| `agent`, `operator`, `workspace`, `org` | `resource_scope` deny over the public id or the tenant id |

The first three key on an **internal uuid**, because that is what the gateway
carries at call time. Two of the rows behind those uuids are **hard-deleted**
by ordinary, unprivileged workspace actions:

- `deleteWorkspaceSecret` (`packages/plugins/src/credentials/workspace-credential.ts`)
  — the "Remove authentication" button, reached through
  `revoke_plugin_credential`. It deletes the `mcp.credentials` row.
- `plugin.org.uninstall` (`packages/handlers/src/plugin.org.uninstall.ts`) —
  it hard-deletes the listing's `mcp.mcp_servers` rows.

Neither needs an org Owner or Admin role; a kill switch needs both. Re-adding
either mints a fresh `uuid_generate_v7()`.

So: security flips a kill switch on a leaking connection. Live grants are
revoked, the row is written, the deny generation bumps,
`list_kill_switches` reports the switch **on**. A workspace member presses
"Remove authentication" and re-authenticates. The new credential row has a new
uuid; `callScopeDigests` emits a digest matching no active deny; the connection
is live again. `list_kill_switches` still says the switch is on and still names
the id of a row that no longer exists. The operator gets no signal at all. The
same holds for `tool_server` and `tool_version` through uninstall then
reinstall.

That is the worst failure mode this product has: an emergency safety control
that reports success while it is not in effect.

`kill_switch.set.ts` already anticipated deletion for the **off** flip — round 4
of the PR made the off flip do no lookup, so a switch whose target was deleted
can still be cleared. It did not anticipate the **on** state remaining
effective.

## Decision

**A delete may not dismantle a kill switch.** While a switch that is on names a
row, deleting that row is refused with `HandlerError { code: "conflict", reason:
"kill_switch_on" }`, naming the switch and its target, and saying that turning
the switch off is the way through.

One helper, `assertNoActiveKillSwitch` (`packages/iam/src/kill-switch-guard.ts`),
over one query, `readActiveKillSwitchesForTargets`
(`packages/iam/src/kill-switch.ts`). It runs **in the caller's transaction**, so
the check and the delete commit or roll back together and a flip racing the
delete cannot slip between them. Two call sites:

- `deleteWorkspaceSecret` reads the credential rows it is about to delete,
  and refuses while a `connection` switch names one of their public ids.
- `plugin.org.uninstall` reads the `mcp_servers` rows it is about to delete and
  the `agent.tool_versions` rows of tools belonging to them, and refuses while
  a `tool_server` or `tool_version` switch names any of them.

Soft-delete paths (`delete_mcp_server`, agent deletion) are untouched: the row
keeps its uuid, so the deny keeps matching, and a switch on a deleted-then-
recreated *server registration* is genuinely a switch on a different server.

## Alternatives considered

**(b) Re-key the digests onto something stable** — digest `connection` over
`org_listing_id` and `tool_server` over `(org_listing_id, endpoint_url)`, so a
re-add inherits the switch. Rejected on three grounds:

1. It changes what the switch names. An operator flips a switch on *the
   connection they are looking at*; under (b) they would silently be flipping it
   on "any credential this workspace ever holds for this listing", including one
   minted months later by someone who never saw the incident. A control whose
   blast radius is larger than its label is its own hazard.
2. It needs the gateway to carry the same key at
   `packages/agent/src/runtime/plugin-types/mcp.ts`, and `tool_version` would
   stay uuid-keyed regardless — the capability id `mcp.<server uuid>.<name>` is
   what `materializeTools` governs a call under. So (b) fixes two of the three
   kinds and leaves the third.
3. It leaves the underlying wrong intact: a control can still be dismantled from
   below, just not by these two buttons.

**(c) Cascade: deleting the target turns the switch off.** Rejected outright.
It makes "remove authentication" a way for any workspace member to clear a
security decision, which is the attack, not the fix.

**(d) Leave it, warn in the UI.** Rejected. The UI does not exist yet
(the six contracts in this lane declare no `app` layer), and a warning is not a
control.

(a) is the honest behaviour: dismantling a control by deleting what it points at
should not be possible, and the refusal says exactly what to do instead.

## Consequences

- A workspace member who hits the refusal cannot proceed without an org Owner or
  Admin clearing the switch. That is the intent: the person who set the control
  decides when it comes off.
- `revoke_plugin_credential` and `uninstall_plugin` gain a `conflict` outcome
  their surfaces already map (API → 409, app kernel seam → `conflict`).
- The guard costs one indexed read per delete
  (`emergency_denies_switch_idx`), on a path that is not hot.
- A switch naming a row that was deleted **before** this ADR landed stays
  clearable: the off flip does no lookup (ADR-068 round 4). Nothing has to be
  backfilled.

## Related

- ADR-068 — kill switches, the classification vocabulary, and the deny shapes.
- MC spec §6.11 (kill switches), §7.4 (when an authorization change takes
  effect).
- `packages/iam/src/kill-switch-guard.test.ts`, and the delete-and-recreate
  cases in `packages/plugins/src/credentials/workspace-credential-delete.test.ts`
  and `packages/handlers/src/plugin.org.uninstall.test.ts`.
