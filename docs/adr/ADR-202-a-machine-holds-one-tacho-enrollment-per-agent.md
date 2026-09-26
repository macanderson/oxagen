# ADR-202: A machine holds one tacho enrollment per agent

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** platform
- **Refines:** ADR-198 (its consequence that `tacho enroll` keeps one
  enrollment per machine, so a second agent on a runtime cannot enroll its
  host without revoking the first).
- **Related:** issue #4371,
  `packages/tacho/src/host/slots.ts`,
  `packages/tacho/src/cli/{enroll,unenroll,reassign,status,slot-deps,daemon-service}.ts`,
  `packages/tacho/src/collector/run.ts`,
  `packages/tacho/src/claude-code/hook-process.ts`,
  `apps/desktop/src-tauri/src/machine.rs`.

## Context

ADR-198 made an agent one operator on one runtime with one harness. A laptop
that runs Claude Code and Codex for one person is therefore two agents, and
the register page gives each its own one-time token and its own command,
`oxagen agent enroll --token <token> --harness <harness>`.

Tacho kept one enrollment per machine, in `host.json` under the tacho root
(`~/.config/oxagen/tacho`, or `TACHO_HOME`). A token presented on an enrolled
machine was refused, and `--force` replaced the live enrollment. The second
agent could enroll only by revoking the first (#4371).

An enrollment is more than `host.json`. It owns a device key, a run-token key,
a sealed credential store and its key, a collector port and a model proxy
port, a WAL, a spool, a quarantine, the daemon's state files, and a hook-id
journal. Every hook entry names its enrollment
(`tacho hook --enrollment tch_…`). The harness config files are different:
Claude Code's settings, Codex's and Cursor's hooks files, Stella's config, and
Claude Desktop's MCP config belong to the person, and more than one agent
writes into them.

## Decision

### 1. Slot directories

The first enrollment stays where it always was, directly under the tacho root.
This is the root slot. Each later agent gets a slot directory at
`<root>/agents/<harness>/`, named for the one harness its token enrolled. A
slot holds the same per-enrollment files the root holds, under the same file
names.

`slotPaths` (`host/slots.ts`) builds a slot's `TachoPaths` by moving every
per-enrollment field into the slot directory. Every function that takes
`TachoPaths` therefore works on a slot unchanged. The fields that move are
listed in `SLOT_STATE`, so a new `TachoPaths` field fails to compile until
someone decides whether it belongs to the enrollment or to the person. The
harness config paths stay at user level, and a command acting on a slot
overlays the harness files that slot's enroll recorded
(`withRecordedHarnessFiles`).

The alternative was a map of enrollments inside `host.json`. A map still
needs a device key, a credential store, a WAL, a spool, and two ports for each
entry, so it needs per-enrollment paths anyway. It would also change the
stored `tacho.host.v1` format, which other code parses: the desktop app's
Rust (`apps/desktop/src-tauri/src/{machine,lib,cli_install}.rs`), the install
rig (`install_rig_tests.rs`), and older tacho binaries still on machines. A
slot leaves the root `host.json` in its old format, so each of those readers
keeps reading the first agent.

### 2. One live slot per harness

A slot is live when its `host.json` has no `revoked_at` and its host status
is not `revoked`. A harness belongs to at most one live slot, and
`slotHolding` finds it. A hook, a run token, a credential helper call, or a
model call for a harness therefore has one enrollment to go to.

`enrollTarget` (`cli/enroll.ts`) decides where an enroll goes:

- A harness a live slot already hooks stays in that slot. The enroll
  re-applies it, or with `--force` replaces that slot's enrollment alone.
- Harnesses that two different slots hold are refused, because one enroll
  cannot cover two agents.
- With no live root, or with no token, the enroll goes to the root. An
  operator enroll (`oxagen tacho enroll`) that adds a harness still revokes
  the root enrollment and enrolls it again with both harnesses. An operator
  enroll names no agent, so there is no second agent to put in a slot.
- With a live root and a one-time token, the token's one harness goes into a
  new slot, and nothing is revoked. A token with more than one harness is
  refused, because the agent it names has one harness.

A new slot takes a collector port whose model proxy port is also free, and
neither may be a port another live slot holds (`portsInUse`).

Routing follows the same rule. A hook entry carries `--enrollment <id>`, and
`slotPathsForEnrollment` picks the slot with that id, live or retired, so a
stale entry is answered by its own slot's check. A command that names only a
harness reaches the live slot that hooks it (`depsForHarness`): the model
credential helper, the Git credential helper, `tacho run`, and
`tacho verify`. A custom agent's `tacho hook --agent <name>` carries no
enrollment id and reports under the root slot.

Slots are named by harness, not by enrollment id. `reassign` and
`enroll --force` mint a new enrollment id, and a directory named by id would
move on each of them.

### 3. One daemon for every slot

The service, its pid file, its log, and its Windows launcher stay at the
root. `host/service.ts` names one service on every platform
(`sh.oxagen.tachod` on macOS). The one `tachod` process starts a collector
per slot (`collector/run.ts`):

- each sub slot not retired on this machine
- the root, unless it was retired on this machine while another agent is
  live

Each collector listens on its slot's ports and ships from its slot's WAL.
Exactly one watches Claude Code transcripts: the slot that hooks Claude Code,
else the root. A slot that fails to start is logged and the others start. The
process fails only when no slot starts. A sub slot's log lines begin with
`tachod [<harness>]`, and SIGHUP refreshes every slot's bundle.

The cost is memory. Each collector holds its own state in the one process, so
the daemon grows with each agent on the machine.

The alternative was one service per agent. That needs a label, a unit file, a
pid file, a log, and a launcher per slot, and every command that installs,
checks, or removes the service would have to enumerate them. With one
service, a machine with one agent runs what it ran before this change.

### 4. Service restart for the remaining agents

`tacho unenroll` uninstalls the one service, whichever slot it removes. A
`tacho reassign` that fails after its revoke leaves the service removed too.
Both then call `restartForRemaining` (`cli/unenroll.ts`). When the service
was installed before the command, is gone after it, and a live slot remains,
it installs the service again and prints
`Starting the <kind> service again for <agent keys>`.

The other agents have no collector and no model proxy from the uninstall to
the reinstall. A hook that fires in that window decides from the cached
bundle and writes its event to its own slot's spool, which the collector
drains when it starts. A model call routed through the proxy fails until the
service is back. When the reinstall fails, the command warns that the
remaining agents have no collector or model proxy, names them, says to run
`tacho enroll --harness <list>` with the first agent's harness list, and
exits 1. That enroll finds the agent's slot, sends no request, and installs
the service again.

This outage is accepted. Stopping one collector while the others keep running
needs a way to tell a running `tachod` which slot to drop, and it has none:
SIGHUP refreshes bundles and nothing more. Uninstalling and installing the
service again reuses paths `unenroll` and `enroll` already exercise.

The commands that act on one agent name it:

- `tacho unenroll` on a machine with more than one enrollment refuses and
  lists them. `--harness <name>` removes the agent that hooks that harness.
  `--all` removes every slot, the sub slots first and the root last. A bare
  unenroll that removed every agent is the defect #4371 describes, and one
  that picked an agent would be guessing.
- `tacho reassign` on a machine with more than one enrollment requires
  `--harness`. The list names the agent, as the slot whose harnesses it
  shares, and replaces that agent's harness list. A list that touches two
  agents is refused.
- `tacho status` prints one report per enrollment. `--json` keeps its
  top-level fields as the first enrollment not retired on this machine and
  adds `enrollments`, one report per enrollment with its `slot` directory.
  `enrollments` is present only when the machine holds more than one. The
  command exits 1 when any enrollment is not shipping. The top level stays a
  single report so a reader that knows one enrollment, the desktop app among
  them, still reads a working agent.
- `tacho unenroll --purge` keeps the collector log while another agent on
  the machine is live, because one log serves every slot.

### 5. Room for a multi-tenant collector

A later collector that serves several enrollments from one listener can take
over the sub slots as they are. Each slot is a complete enrollment in the
root's own file format, and the root's layout did not change, so moving to
such a collector needs no data migration.

## Consequences

- A second agent enrolls on a machine without revoking the first. The
  register page's command creates its slot.
- A machine with one agent keeps its layout, its service, its `tacho status`
  output, and its `tacho unenroll` behavior.
- The daemon's memory grows with each agent on the machine.
- Only a one-time token creates a slot. An operator enroll that adds a
  harness still adds it to the root enrollment.
- **Known gap: the desktop app shows the first agent only.**
  `apps/desktop/src-tauri/src/machine.rs` reads the root `host.json` alone
  (lines 195 and 228). The top level of `tacho status --json` is the first
  enrollment too, so the panels agree with each other. Uninstall runs
  `tacho unenroll --all --purge` and removes every agent. The app's report of
  a revoke still owed reads the root alone, so after an offline uninstall it
  does not name a sub slot's agent for the fleet page.
- **Known gap: scripts must name the agent.** A bare `tacho unenroll` or
  `tacho reassign` on a machine with two agents refuses. A script that ran
  either must pass `--harness`, or `--all` to unenroll every agent.
- **Known gap: reassign drops a token-enrolled agent's registration.**
  `tacho reassign` enrolls again through the CLI session (`cli/reassign.ts`
  passes no token). `create_tacho_enrollment` then derives the agent key from
  the hostname and mints a host row with no agent
  (`packages/handlers/src/tacho.enrollment.create.ts`). A sub slot is
  token-enrolled by construction, so reassigning one returns an agent under a
  different key, unlinked from the agent registered on the Agents page and
  from that agent's mandate. Before its revoke, a reassign of a sub slot
  prints a warning that names the agent key and says how to keep the link:
  unenroll that agent, register it in the target workspace, and run the
  command its page shows. #4410 tracks carrying the agent link through a
  reassign.

## Alternatives considered

- **A map of enrollments in `host.json`.** Rejected for the reasons in
  decision 1: it still needs per-enrollment paths, and it breaks the stored
  format that the desktop app, the install rig, and older binaries read.
- **One service per agent.** Rejected for the reasons in decision 3.
- **Replace the enrollment when a second token arrives.** This was the
  behavior before this ADR, through `--force`. Rejected because it revokes the
  first agent, which is #4371.
- **Slots named by enrollment id.** Rejected because the id changes on every
  `reassign` and `enroll --force`, and the directory would move with it.
- **A bare `tacho unenroll` that removes every agent.** Rejected because a
  command that names no agent should not take all of them off the machine.
