# ADR-056: Run control connection points and the model-proxy decision

- **Status:** Accepted; amended 2026-09-15 (run token) and 2026-09-18 (ledger producers exist; the proxy decision is ADR-094)
- **Date:** 2026-09-14
- **Owners:** platform
- **Related:** issue #2953 (run controls: pause, resume, cancel, steer with a
  delivery mode on every run), ADR-043 (Oxagen governs agents and does not
  run them), the Mission Control spec `oxagen-roadmap:docs/oxagen/specs/mission-control/spec.md`
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

The control channel is `tacho.commands.v2`. A host acknowledges in the five
statuses it can assert about itself — `received`, `acknowledged`, `applied`
(with `applied_at_seq`, the frame the effect landed on), `expired` (the
deadline passed with no boundary reached, with the detail) and `failed` —
and receives commands that carry `requested_mode`, `delivery_mode` and
`degraded_reason`. `sent` is Oxagen's own act and stays Oxagen's to record.
A v1 body has no `schema` tag and acknowledges with `outcome`; the strict
shape refuses it.

The `control.steer` frame of §8.2 is chained by the collector as
`oxagen:command_applied` in the wrapper vocabulary, with
`command.requested_mode`, `command.delivery_mode`,
`command.degraded_reason` and `command.interrupted` as attrs and the
event's own `seq` as `delivered_at_seq`. `interrupted` is always `0` at the
hook adapter; the proxy sets it.

### Supersession and expiry

A new command cancels an earlier `queued` command of the same kind on the
same run (`cancelled`, `outcome_detail = superseded_by:<id>`), so a
correction never delivers twice.

Who writes `expired` follows who owns the row. A row is Oxagen's while
`queued` and the host's once it leaves on the wire: the poll's sweep turns a
`queued` row past its expiry into `expired`, and never a `sent`,
`received` or `acknowledged` one. `list_commands` derives `expired` under
the sweep's own predicate — a `queued` row past its expiry — so a report
read before the host's next poll shows what that poll writes, and a host
that stopped polling leaves its queued rows reading `expired`. A row the
host holds reads as recorded: the status shown is one somebody wrote, and
the report carries `expiresAt` so an interface can show a held row as past
expiry and awaiting the host. The host holds that deadline — it refuses a
command already past expiry at receipt, and a steer whose expiry passed
while it waited for a boundary (a session paused past it, then resumed) is
dropped at that boundary with no injection, no `oxagen:command_applied`
frame and an `expired` acknowledgement (`expired before a boundary`), the
one word §7.4 gives that case. A pause or cancel applied at receipt is
acknowledged on the next poll; had an ingest in between swept the row, the
`applied` would have hit `fetch_commands`' terminal fence and the report
would have said `expired` for a command the chain shows applied. With the
sweep and the derivation both bounded to `queued`, every acknowledgement
the host sends lands, no row reads a status the host can overturn, and the
frame chain and the command row cannot disagree.

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

## Amendment 2026-09-15: a ledger-ingested run gets a revocable run token (maintainer decision)

The maintainer decided on 2026-09-15 (decision 11) to build the ledger
ingest contract with a revocable run token now, so Halt and Cancel work on
ledger-ingested runs. A ledger run has no connection point today. No
producer in this tree appends to `@oxagen/run-ledger` and no run token
exists to revoke, so `dispatch_command` refuses a ledger run with
`no_connection_point` (`packages/handlers/src/tacho.command.dispatch.ts:15-18`).
The Run page renders Halt disabled on such a run. This amendment adds a
second connection point beside the hook adapter:

- **The ledger ingest contract.** A producer appends a ledger run's frames
  to `@oxagen/run-ledger` under a run token that Oxagen mints when the run
  opens. The token names the organisation, workspace, run and attempt. It is
  stored as a hash and is short-lived: at most fifteen minutes, refreshed on
  the ingest response, per the run-token rule of the Mission Control spec
  (`oxagen-roadmap:docs/oxagen/specs/mission-control/spec.md:338`).
- **Cancel revokes the token.** A `cancel` addressed to a ledger run revokes
  the run token in the same transaction that writes the command row. Every
  later ingest call under that token is refused, so a halt holds even if the
  producer ignores the command. The ingest response carries queued commands,
  so the producer learns of the cancel on its next append. The delivery mode
  is resolved at dispatch the same way as for the hook adapter, and both
  modes are recorded on the row.
- **What stays refused.** `steer`, `pause` and `resume` on a ledger run still
  answer `no_connection_point` until a producer carries them. The Run page's
  Halt/Cancel is enabled on a ledger run once the contract lands, and the
  `no_connection_point` copy stays for the kinds that remain refused.

`apps/app/architecture.worklist.json` WL-61 builds it.

## Amendment 2026-09-18: producers now append to the run ledger, and the proxy decision is made

Two sentences above are no longer true at `main` `02278c913`.

**"No producer in this tree calls `createAttempt` or `appendAttemptBatch` on
`@oxagen/run-ledger`"** (§1) and **"No producer in this tree appends to
`@oxagen/run-ledger`"** (the 2026-09-15 amendment). Two producers now do:

- `packages/agent/src/runtime/assistant-run.ts` records the in-app agent's turn
  as a run: it calls `store.createRun`, `store.createAttempt` and appends frames
  through its recorder (ADR-053's 2026-09-15 amendment).
- `packages/handlers/src/run.fork.ts` calls `createAttempt` to mint the attempt
  behind a fork (ADR-058).

Neither is a wrapped harness, so the hook adapter is still the connection point
for Claude Code, Codex and Stella, and the refusal of a command addressed to a
ledger run with no connection point is unchanged.

**"The model proxy is its own decision"** (§1). ADR-094 is that decision:
`tachod` grows into the gateway, with a loopback model proxy. Phase 4 is in
build. When it lands, `interrupt` stops degrading to `next_step` for a run on
the `gateway` tier, and the irreversible-tool guard this ADR deferred to the
proxy has a home.

## Implementation 2026-09-20: ledger ingress cancellation

The ledger boundary now accepts credentials scoped to an existing attempt.
`create_run_token` requires an operator role and refuses ended or cancelled
runs. `ingest_run_frames` derives identity from the credential and refreshes
its fifteen-minute expiry inside the append transaction. It keeps the same
secret so a lost response remains retryable. Only its hash is stored.

Direct Cancel now fences subsequent appends and new attempts, revokes the
run's credentials, and writes an applied command receipt under the same run
lock. The applied outcome means evidence ingress was revoked. It makes no
claim that an external process stopped. The Run page says this before and
after confirmation. Other ledger controls remain refused. Since cancellation
applies immediately and all other ledger controls remain refused, this
revision has no queued ledger commands to return from ingress. The operator
can read the applied receipt through `list_commands`.

Dedicated Postgres planes remain unsupported for credential issuance. The
authentication resolver reads credentials from the shared plane, so issuance
refuses before minting a secret on a dedicated plane. Adding authenticated
plane discovery remains part of #2953. The run read exposes `ingressRevoked`
separately from process status. Repeat cancellation returns the existing
applied receipt, and the Run page disables the cancelled ingress control.

### 2026-09-20: ledger pause and resume

Ledger Pause sets `agent_runs.ingress_paused` under the run row lock. The next evidence append or attempt admission refuses the paused run before writing. Resume clears that fence under the same lock. Both changes and their applied command receipts commit together. Cancellation remains separate and terminal: Resume refuses a cancelled run and never revives revoked credentials. These actions govern evidence admission, not the external process.

The app reads the ingress flag independently of run outcome and labels the pause accordingly. The command receipt keeps the operator's reason. A pause does not extend credential expiry. After a long pause an operator must issue a new credential when resuming evidence delivery.
