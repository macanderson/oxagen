# ADR-204: Containment is a setting of the runtime

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** agents, tacho
- **Amended:** 2026-09-30, §4 (issue #4474)
- **Related:** issue #4372, issue #4369, ADR-198 (an agent is one operator on
  one runtime with one harness), ADR-152 (the contained launcher and the
  tier), ADR-096 (the contained tier), ADR-057 (the agent definition file,
  superseded by ADR-198)

## Context

ADR-198 removed the agent definition file. Its migration copied each
version's `[budget]` and `[containment]` tables into
`agent_versions.config`, and the host bundle kept reading both from the
active version. After that change, no surface could edit either value, so
an agent that required the contained launcher (ADR-152) kept the
requirement and nobody could change it. An agent that did not require it
could not be made to.

Containment describes the machine an agent runs on, not the agent. The
contained launcher is a Docker container on the host, and the tier the
server grants follows from what that host measures. ADR-198 already made
the runtime the named slot a host enrolls against. An owner who wants a
build VM to run only contained agents means every agent on that VM,
including the next one registered there.

A budget is different. It limits one agent's spend, whatever machine the
agent runs on, and the record already charges spend to the agent.

## Decision

### 1. The runtime records containment

`agent.runtimes.containment_required` is a boolean, false by default. When
it is true, every agent on the runtime runs only under the contained
launcher.

- `create_runtime` takes an optional `containmentRequired`, false when
  omitted.
- `update_runtime` is new. It renames a runtime, changes
  `containmentRequired`, or both. A field left out keeps its value, and the
  slug does not follow a rename.
- Both check the org role in the handler (`assertOrgRole`, INV-29): Owner or
  Admin, the bar `create_runtime` already set. Both skip the billing gate.
- `update_runtime` locks the row while it reads and writes it. A change to
  containment writes a `capability.invoke_allowed` security event in the
  same transaction, with the value before and after
  (`RuntimeContainmentChangeDetail`). A call that changes nothing writes
  nothing.
- `list_runtimes` answers each runtime's `containmentRequired`.

### 2. The host bundle reads containment from the host's runtime

`resolveHostMandate` reads `containment_required` from the runtime the host
enrollment binds (`tacho.hosts.runtime_id`). A host that binds no runtime
falls back to the agent's current runtime. A host with neither reads no
runtime and requires nothing.

- The read does not filter on `deleted_at`. A host still bound to a
  deleted runtime keeps the requirement that runtime had, so deleting a
  runtime cannot lift containment from a machine that is still enrolled.
- The read sits outside the budget's error handling. A budget the host
  cannot read still suspends governed actions, and the envelope still
  carries the runtime's containment.
- The wire shape does not change. The envelope carries
  `containment: { required: true }` or nothing, so the tacho client needs no
  change.
- A host picks up a change on its next bundle fetch.

### 3. The bundle no longer reads the version's containment table

`agentVersionContainment` and the mandate's version fallback are removed.
The host bundle ignores a `containment` table left in a version's config.
Before this change, a malformed table (`{ required: "yes" }`, say)
suspended governed actions on the host as an invalid agent config. It now
suspends nothing. A malformed budget still suspends governed actions.

One read of the table remains. A host enrollment for an agent on no runtime
reads it on the agent's first enrollment on a runtime, to carry the
requirement to that runtime (§4). Only `required: true` counts there, and
any other shape carries nothing.

### 4. The migration carries every requirement over

`20260926230000_runtime_containment_required.sql` adds the column and sets
it true on each runtime where a live agent's active version required
containment. An agent counts as on a runtime when its own `runtime_id`
names it, or when a host enrollment bound to the runtime belongs to the
agent, because the bundle reads the host's runtime. A revoked host does not
count, so a runtime an agent has moved off does not inherit its
requirement. The migration reports how many runtimes it switched and how
many live hosts sit on them. The version configs keep their tables, so a
rollback that drops the column returns the previous answer.

An agent on no runtime has no runtime to carry the requirement to. Its
version config holds it until a host enrollment binds the runtime named
after the host. The agent's first enrollment on each runtime turns
containment on for that runtime when the agent's active version required
it (`findOrCreateHostRuntime`). A later enrollment of the agent on a runtime
where it already had a host, revoked or not, carries nothing, so an owner
who turned containment off on that runtime keeps that answer. An enrollment
never turns containment off.

That rule has one gap. A host revoked before this migration ran was not
counted by the backfill, and it still counts as the agent's first
enrollment on its runtime. An agent on no runtime whose every host was
revoked before the migration, re-enrolled on the same machine, runs
uncontained until an owner turns containment on for that runtime. A new
machine is not affected.

#### Amendment 2026-09-30: placements written during the deploy

The backfill ran before the code that reads the runtime flag was live
(#4474). `migration-gate` applied it at 08:09 UTC on 2026-09-27, in CI run
36299501166 for commit `7eed65652`. The same run's `deploy-node` legs
replaced the old code after it: the app at 08:18, the API at 08:20, and MCP,
the last, at 08:33. For those 24 minutes the old `move_agent` could put an
agent that required containment on a runtime the backfill had passed. The old
host enrollment could bind an unplaced agent's first host to a runtime without
the carry, and that host then counts as the first enrollment, so the carry
never runs there.

`20260930120700_runtime_containment_reconcile.sql` turns containment on for
those runtimes. It applies the backfill's test again, and counts an agent only
when the write that put it on the runtime falls between 08:08 and 08:34 UTC:
the agent's latest `registered` or `runtime_changed` version names the runtime
and was written then, or the agent's first host on the runtime was enrolled
then. The window sits at least 40 seconds outside the recorded job steps on
each side.

- **An owner's choice stands.** A runtime whose containment an Owner or Admin
  has set with `update_runtime` is skipped, whatever the value. The handler
  writes a `capability.invoke_allowed` security event with
  `detail.feature = "runtime_containment"` in the same transaction as each
  change, and it is the only write that turns containment off, so the event
  tells an owner's "off" apart from a missed carry. `agent.runtimes.updated_at`
  cannot: a rename moves it too. Besides `update_runtime`, only
  `findOrCreateHostRuntime` updates the row, and only to turn containment on.
  No heartbeat or routine job touches it.
- **A placement after the window stays as the new code left it.** A move there
  takes the new runtime's containment, as Consequences says, and a first
  enrollment carries the requirement itself. Running the whole backfill again
  would undo those moves, so the reconcile does not.
- **The pre-migration gap above stays.** An agent whose first host on a runtime
  predates the window is not counted.

Neither migration's count reaches the `migration-gate` log. Atlas prints each
statement and its timing, and drops a server notice: the log of the backfill's
apply (CI job 108576755615) shows the `DO` block and `-- ok`, and no count. The
count is visible in a `psql` session that applies the file.

### 5. The budget stays per agent and read-only

The per-run and per-day ceilings stay in `agent_versions.config`, and the
host bundle enforces them exactly as before. No surface edits them yet. The
agent's Permissions tab shows them read-only and says a per-agent budget
field comes later.

### 6. The agent page shows containment as the runtime's

`get_agent` answers `limits.containmentRequired` from the agent's current
runtime, false for an agent on no named runtime, and apart from whether the
budget could be read. The Permissions tab shows it read-only, names the
runtime, and links to the runtime's page, where an Owner or Admin changes
it.

## Consequences

- Turning containment on for a runtime applies it to every agent on that
  runtime, including agents registered later. There is no per-agent
  exception. An owner who wants one uncontained agent on a machine gives it
  its own runtime.
- Turning containment on changes what each host on the runtime does at its
  next bundle fetch. A host whose tacho predates the `containment` bundle
  feature is suspended, because it cannot read the requirement. On a host
  in enforce mode, a session not started with `tacho run --contained`
  (which needs Docker) has its governed actions refused with
  `containment_required`. A host in observe mode records and refuses
  nothing.
- Moving an agent to another runtime (`move_agent`) changes its containment
  to the new runtime's. `move_agent` revokes the agent's hosts on the old
  runtime, so the new host enrolls and reads the new runtime.
- A backfill can turn containment on for agents that did not require it:
  when two agents shared a runtime and only one required containment, both
  now do. That errs toward the stricter setting, and an owner can turn it
  off on the runtime's page.
- A deleted runtime's setting outlives it for hosts still bound to it.
- Agent-scope budgets still wait on a decision about where agent limits
  live. This record does not decide it.

## Alternatives considered

- **Keep containment on the agent version and add an editor for it.**
  Rejected: the setting follows the machine, and an editor per agent would
  let two agents on one container host disagree about whether the host is
  contained.
- **Put containment on the host enrollment.** Rejected: a host is replaced
  when its machine is, and ADR-198 made the runtime the record that outlives
  the machine. The setting would be lost on every re-enrollment.
- **Move the budget to the runtime as well.** Rejected: spend is charged to
  the agent, and one runtime can run several agents with different budgets.
