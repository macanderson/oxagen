# ADR-056: Run control connection points and the model-proxy decision

- **Status:** Accepted
- **Date:** 2026-09-14
- **Owners:** platform
- **Related:** issue #2953 (run controls: pause, resume, cancel, steer with a
  delivery mode on every run), ADR-043 (Oxagen governs agents and does not
  run them), the Mission Control spec `docs/specs/mission-control/spec.md`
  §7.3 (steering into the loop), §7.4 (halting and commands), §7.6 (messages
  and mass steering), §8.2 (the `control.command` and `control.steer`
  frames), Appendix A.6 (`control.commands`) and Appendix E
  (`dispatch_command`, `fetch_commands`), `docs/specs/tacho/spec.md` §7.4
  (amended for this ADR), `packages/database/src/schema/tacho.ts`
  (`tacho.control_commands`), `packages/tacho/src/wire.ts` (the collector
  protocol), `packages/handlers/src/tacho.command.dispatch.ts`

## Context

The Mission Control spec describes three connection points through which
Oxagen reaches a running agent: the model proxy, the tool gateway and the
hook adapter. Its delivery modes (§7.3) are enforceable in full only at
`gateway` tier, "because the proxy is in the path of every request". The
tree has one connection point: the hook adapter, the Tacho collector that
wraps Claude Code and Codex through their hook surfaces. No model proxy
exists, and ADR-043 says Oxagen governs agents and does not run them, so a
proxy is a governor component the maintainer scopes rather than something a
lane adds on the way to a page.

Before this decision, `dispatch_tacho_command` queued seven commands for a
host or one of its sessions with no delivery mode and a five-word outcome
set (`pending`, `delivered`, `applied`, `expired`, `failed`) that merges the
distinctions §7.4 exists to keep: `delivered` covers *sent*, *received* and
*acknowledged* alike, `pending` covers *draft* and *queued*, and an operator
who changed their mind reads the same as a run that never reached a
boundary. `steer`, the command §7.3 is written around, did not exist, and
nothing could address a run by its id, an agent by its key, or the
workspace.

Issue #2953 leaves three decisions to the maintainer, each with a
recommendation. This ADR adopts the recommendations and records what they
mean in code.

## Decision

### 1. The hook adapter is the connection point of this revision; the model proxy is its own decision

Every command is delivered through the Tacho collector. The delivery mode is
resolved per recipient at dispatch, at or below the mode requested, by what
the hook adapter can carry: it injects prompt content at the next prompt
boundary and cannot stop a call in flight, so `next_step` and
`turn_boundary` land as asked and `interrupt` degrades to `next_step` with
`degraded_reason = harness_tier`. Both modes are recorded on the row, and
every interface shows the achieved one (§7.3, §7.1).

The irreversible-tool rule of §7.3 (`degraded_reason =
irreversible_tool_in_flight`) belongs to the proxy connection point, the
only one at which an `interrupt` could otherwise abandon a call. It is not
implemented here, and no code names that reason, because nothing in this
tree can produce it. It arrives with the proxy.

A run at `observe` tier has no adapter in its path. A command addressed to
it directly is refused (`conflict` / `observe_tier`), never queued; a
broadcast records it as `failed` with that reason so the delivery report is
complete (§7.6).

A run recorded through the evidence ledger (`arun_…`) has no connection
point at all. No producer in this tree calls `createAttempt` or
`appendAttemptBatch` on `@oxagen/run-ledger`, and no run token exists, so
there is no ingest boundary a `pause` could refuse and nothing a `cancel`
could revoke. A command addressed to a ledger run is refused (`conflict` /
`no_connection_point`); a broadcast enumerates recipients over the
connection point and does not reach it. The row shape (`target_kind = run`,
`host_id` nullable) is ready for the day a ledger producer polls for
commands, which is when the ledger path of the issue's spec becomes
buildable.

### 2. `tacho.control_commands` is widened; the spec's `control.commands` is a later view

The table keeps its lifecycle columns and gains `target_kind`, `target_id`,
`requested_mode`, `delivery_mode`, `degraded_reason` and `reason`; `host_id`
becomes nullable; the `command` CHECK admits `steer`; the `outcome` CHECK
carries the nine words of §7.4, with `pending → queued` and `delivered →
sent` mapped in the same migration. A rename to `control.commands`
mid-lane would cost the collector a protocol bump for no behaviour; the
protocol is bumped once, for the vocabulary (below), and the spec's name can
be registered as a view when the schema realignment reaches it.

`target_kind` admits `host` and `run`. A row is addressed to the recipient
that carries it: a host (a `revoke` queued by `revoke_tacho_enrollment`) or
one run. Appendix A.6's wider set (`agent`, `workspace`, `org`, `class`,
`tool_server`, `connection`, `tool_version`) describes addressing, and
addressing is resolved to recipient rows at dispatch: `@agents` and
`@<agent-key>` are recorded in `payload.address` on every row of the
dispatch, never as a row of their own, so `list_commands` for a run finds
every command that reached it with one predicate.

### 3. Operator steer and mass steer ship; agent-originated messages wait

`dispatch_command` carries `steer` and `message` from an operator to one
run, to every live run of an agent, or to every live run in the workspace.
Dispatch is held by org Owners and Admins for any run, and by a workspace
Owner or Member for the runs of the workspace the call is scoped to,
checked in the handler (`assertOrgRole` with the workspace leg, INV-29).
The issue's "a Member can steer a run of an agent they operate" resolves to
the workspace role: every recipient is resolved inside the caller's
workspace, and no narrower operator-to-agent relation is recorded. Agent-to-agent messages (§7.6 "an
agent's message enters as quoted evidence with the sender named") wait for
`send_message` and the taint marking of §6.7; the delivery queue they will
use is this table with `command = message`.

### The collector protocol

The control channel is `tacho.commands.v2`. A host acknowledges in the four
statuses it can assert about itself — `received`, `acknowledged`, `applied`
(with `applied_at_seq`, the frame the effect landed on) and `failed` — and
receives commands that carry `requested_mode`, `delivery_mode` and
`degraded_reason`. `sent` is Oxagen's own act and `expired` Oxagen's clock;
neither is a host's to report, and a host that finds a command past its
expiry reports `failed` with the reason. A v1 body has no `schema` tag and
acknowledges with `outcome`; the strict shape refuses it.

The `control.steer` frame of §8.2 is chained by the collector as
`oxagen:command_applied` in the wrapper vocabulary, with
`command.requested_mode`, `command.delivery_mode`,
`command.degraded_reason` and `command.interrupted` as attrs and the
event's own `seq` as `delivered_at_seq`. `interrupted` is always `0` at the
hook adapter; the proxy sets it.

### Supersession and expiry

A new command cancels an earlier `queued` command of the same kind on the
same run (`cancelled`, `outcome_detail = superseded_by:<id>`), so a
correction never delivers twice. A row that is not terminal and whose
expiry has passed reads `expired` from `list_commands`, which derives it at
read time so the report is right for a host that stopped polling.

Who writes `expired` follows who owns the row. A row is Oxagen's while
`queued` and the host's once it leaves on the wire: the poll's sweep turns a
`queued` row past its expiry into `expired`, and never a `sent`,
`received` or `acknowledged` one. The host holds the deadline instead — it
refuses a command already past expiry at receipt, and a steer whose expiry
passed while it waited for a boundary (a session paused past it, then
resumed) is dropped at that boundary with no injection, no
`oxagen:command_applied` frame and a `failed` acknowledgement
(`expired before a boundary`). A pause or cancel applied at receipt is
acknowledged on the next poll; had an ingest in between swept the row, the
`applied` would have hit `fetch_commands`' terminal fence and the report
would have said `expired` for a command the chain shows applied. With the
sweep bounded to `queued`, every acknowledgement the host sends lands, and
the frame chain and the command row cannot disagree.

## Consequences

- `dispatch_tacho_command` and `fetch_tacho_commands` are gone, replaced
  without alias by `dispatch_command` and `fetch_commands` (ADR-025). Host
  targeting leaves the dispatch contract: `revoke_tacho_enrollment` queues
  the host `revoke` itself, `refresh_bundle` is redundant with the etag on
  every control envelope, and `kill` folds into `cancel` (§7.4). The wire
  and the CHECK still admit the retired kinds so a row queued before this
  decision stays readable.
- The Run page's Halt becomes Cancel on a wrapped run and stays disabled on
  a ledger run with the `no_connection_point` copy; a delivery report and a
  steer dialog can be built on `list_commands` and `dispatch_command`
  (issue #2953, app half).
- The model proxy, when scoped, adds a connection point that resolves
  `interrupt` in full, sets `interrupted` and `interrupted_step`, and
  produces `irreversible_tool_in_flight`. Nothing in this decision needs to
  change for it: the row records both modes already, and the resolver in
  `tacho.command.dispatch.ts` is where the proxy's ceiling joins the
  adapter's.
