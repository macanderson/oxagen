# ADR-203: A machine holds one tacho enrollment per agent

- **Status:** Accepted
- **Date:** 2026-09-26
- **Owners:** platform
- **Refines:** ADR-198 (its consequence that `tacho enroll` keeps one
  enrollment per machine, so a second agent on a runtime cannot enroll its
  host without revoking the first).
- **Related:** issue #4371,
  `packages/tacho/src/host/{paths,agents}.ts`,
  `packages/tacho/src/cli/{enroll,unenroll,reassign,status,agent-deps,daemon-service}.ts`,
  `packages/tacho/src/collector/run.ts`,
  `packages/tacho/src/claude-code/hook-process.ts`,
  `apps/desktop/src-tauri/src/machine.rs`.

## Context

ADR-198 made an agent one operator on one runtime with one harness. A laptop
that runs Claude Code and Codex for one person is therefore two agents, and
the register page gives each its own one-time token and its own command,
`oxagen agent enroll --token <token> --harness <harness>`.

Tacho kept one enrollment per machine, in `host.json` in the tacho directory
(`~/.config/oxagen/tacho`, or `TACHO_HOME`). A token presented on an enrolled
machine was refused, and `--force` replaced the live enrollment. The second
agent could enroll only by revoking the first (#4371).

An enrollment is more than `host.json`. It owns a device key, a run-token key,
a sealed credential store and its key, a collector port and a model proxy
port, a WAL, a spool, a quarantine, the daemon's state files, a hook-id
journal, and the install receipts and backups for the harness files it
wrote. Every hook entry names its enrollment
(`tacho hook --enrollment tch_…`). The harness config files are different:
Claude Code's settings, Codex's and Cursor's hooks files, Stella's config, and
Claude Desktop's MCP config belong to the person, and more than one agent
writes into them.

Most runtimes will run more than one harness. A layout that treats the first
agent as special makes every command ask which agent it is looking at, and
makes the second agent a different kind of thing from the first.

## Decision

### 1. One directory per agent, all alike

Every agent on a machine has a directory at `<tachoDir>/agents/<id>/`. No
enrollment lives in the tacho directory itself. Each agent directory holds the
same files under the same names: `host.json`, the keys, the credential
store, the WAL, the spool, the quarantine, the daemon state, the hook-id
journal, and the harness receipts and backups.

`host/paths.ts` splits the paths in two:

- `TachoHome` is the machine: the tacho directory, `agents/`, the service's
  pid file, its log, and its Windows launcher, plus the person's harness
  config files.
- `TachoPaths` extends `TachoHome` with one agent's `dir` and the files in
  it. `agentPaths(home, id)` builds it, and `AGENT_FILES` names every file,
  so a new per-agent file is added in one place.

Every function that takes `TachoPaths` works on any agent unchanged. A
command acting on one agent overlays the harness file paths that agent's
enroll recorded (`withRecordedHarnessFiles`).

The id is 8 random hex characters (`newAgentId`). It is opaque, and it never
changes for the life of the directory. It is short because the agent's Unix
socket path must fit the 104 bytes macOS allows.

`host/agents.ts` reads the directories. `listAgents` returns every agent
with a `host.json`, oldest enrollment first, then by id, with an unreadable
`host.json` last. The file format stays `tacho.host.v1`.

### 2. One live agent per harness

An agent is live when its `host.json` has no `revoked_at` and its host status
is not `revoked`. A harness belongs to at most one live agent, and
`agentHolding` finds it. A hook, a run token, a credential helper call, or a
model call for a harness therefore has one enrollment to go to.

`enrollTarget` (`cli/enroll.ts`) decides which agent an enroll acts on:

- An enroll that names no harness, on a machine that holds one agent, acts
  on that agent whatever it hooks. The desktop app's Re-apply runs
  `tacho enroll` with no flags. With more agents, it names `claude-code`.
- Harnesses a live agent already hooks stay with that agent. The enroll
  re-applies it, or with `--force` replaces that agent's enrollment alone.
  An enroll that names one of the agent's harnesses and a new one adds the
  new one to that agent.
- Harnesses that two different agents hold are refused, because one enroll
  cannot cover two agents.
- Otherwise the most recent retired agent that hooked one of the harnesses
  is enrolled again in its own directory, keeping its device key and ports.
- Otherwise the enroll gets a new agent directory, and nothing is revoked.
  A token enroll and an operator enroll take the same path.

A new agent takes a collector port whose model proxy port is also free, and
neither may be a port another agent the daemon serves holds (`portsInUse`).
An enroll that fails before `host.json` is written removes the new
directory, so a failed enroll leaves no agent behind.

Routing follows the same rule. A hook entry carries `--enrollment <id>`, and
`agentPathsForEnrollment` picks the agent with that enrollment id, live or
retired, so a stale entry is answered by its own agent's check. It reads two
fields of each `host.json` and parses nothing else, because every hook calls
it. A command that names only a harness reaches the live agent that hooks it
(`depsForHarness`): the model credential helper, the Git credential helper,
`tacho run`, and `tacho verify`. A command that names nothing acts on the
oldest live agent (`defaultAgentPaths`).

Directories are named by opaque id, not by harness and not by enrollment id.
`reassign` and `enroll --force` mint a new enrollment id, and a harness can
move between agents, so a directory named by either would have to move.

### 3. One daemon for every agent

The service, its pid file, its log, and its Windows launcher belong to the
machine. `host/service.ts` names one service on every platform
(`sh.oxagen.tachod` on macOS). The one `tachod` process starts a collector
for each agent not retired on this machine (`daemonAgents` in
`collector/run.ts`). When every agent is retired, the oldest still runs, as a
lone enrollment always has, because its revoke may still be pending.

Each collector listens on its agent's ports and ships from its agent's WAL.
Exactly one watches Claude Code transcripts: the live agent that hooks Claude
Code, else the first agent served. An agent that fails to start is logged
and the others start. The process fails only when no agent starts. With more
than one agent, each log line begins with `tachod [<id>]`, and SIGHUP
refreshes every agent's bundle.

The cost is memory. Each collector holds its own state in the one process, so
the daemon grows with each agent on the machine.

The alternative was one service per agent. That needs a label, a unit file, a
pid file, a log, and a launcher per agent, and every command that installs,
checks, or removes the service would have to enumerate them.

### 4. Service restart for the remaining agents

`tacho unenroll` uninstalls the one service, whichever agent it removes. A
`tacho reassign` that fails after its revoke leaves the service removed too.
Both then call `restartForRemaining` (`cli/unenroll.ts`). When the service
was installed before the command, is gone after it, and a live agent remains,
it installs the service again and prints
`Starting the <kind> service again for <agent keys>`.

The other agents have no collector and no model proxy from the uninstall to
the reinstall. A hook that fires in that window decides from the cached
bundle and writes its event to its own agent's spool, which the collector
drains when it starts. A model call routed through the proxy fails until the
service is back. When the reinstall fails, the command warns that the
remaining agents have no collector or model proxy, names them, says to run
`tacho enroll --harness <list>` with the first agent's harness list, and
exits 1. That enroll finds the agent, sends no request, and installs the
service again.

This outage is accepted. Stopping one collector while the others keep running
needs a way to tell a running `tachod` which agent to drop, and it has none:
SIGHUP refreshes bundles and nothing more. Uninstalling and installing the
service again reuses paths `unenroll` and `enroll` already exercise.

### 5. Commands that act on one agent name it

- `tacho unenroll` on a machine with more than one agent refuses and lists
  them. `--harness <name>` removes the agent that hooks that harness. `--all`
  removes every agent, oldest first. A bare unenroll that removed every
  agent is the defect #4371 describes, and one that picked an agent would be
  guessing. An unenroll removes the agent's directory once it is empty, then
  `agents/`, then the tacho directory, so a machine with nothing enrolled
  looks like one that never was.
- `tacho reassign` on a machine with more than one agent requires
  `--harness`. The list names the agent whose harnesses it shares and
  replaces that agent's harness list. A list that touches two agents is
  refused.
- `tacho status` prints one report per agent, with its directory, when the
  machine holds more than one. `--json` always carries `enrollments`, one
  report per agent with its `id` and `dir`, oldest first. The top-level
  fields repeat the first enrolled agent, so a reader that knows one
  enrollment still reads a working agent. The command exits 1 when any agent
  is not shipping.
- `tacho unenroll --purge` keeps the collector log while another agent on
  the machine is live, because one log serves every agent.

### 6. Machines enrolled before this ADR

A machine enrolled before this change keeps its one enrollment in the tacho
directory itself. `listAgents` reads it there as the agent `legacy`, so every
command works on it before it moves. `tachod` moves it when it starts, before
any collector runs (`migrateLegacyLayout`):

1. It fills `agents/.migrating-<id>/` with every per-agent file and moves
   `host.json` last, so until the move ends every reader finds the
   enrollment where it was.
2. It renames the staging directory to `agents/<id>/`.
3. It sweeps into the new directory any spool or quarantine entry a hook
   wrote into the old place while the move ran.

A start that finds a `.migrating-` directory finishes that move instead of
starting another. `listAgents` skips directories whose names start with a
dot. An enroll never migrates: it leaves the legacy enrollment to the daemon.

### 7. The desktop app

The desktop app reads the same layout (`apps/desktop/src-tauri/src/machine.rs`):
every agent under `agents/`, and a legacy enrollment until `tachod` moves it.
Its uninstall runs `tacho unenroll --all --purge` and removes every agent.

## Consequences

- A second agent enrolls on a machine without revoking the first, and gets a
  directory identical to the first agent's.
- No command, reader, or test treats the first agent differently from the
  others.
- The daemon's memory grows with each agent on the machine.
- The bundled desktop daemon reads `agents/` only once the desktop app ships
  with this tacho. Until then, a machine on the old bundled daemon keeps its
  legacy layout, and an enroll from this CLI writes into `agents/`, which the
  old daemon does not read.
- **Known gap: scripts must name the agent.** A bare `tacho unenroll` or
  `tacho reassign` on a machine with two agents refuses. A script that ran
  either must pass `--harness`, or `--all` to unenroll every agent.
- **Known gap: reassign drops a token-enrolled agent's registration.**
  `tacho reassign` enrolls again through the CLI session (`cli/reassign.ts`
  passes no token). `create_tacho_enrollment` then derives the agent key from
  the hostname and mints a host row with no agent
  (`packages/handlers/src/tacho.enrollment.create.ts`). Reassigning an agent
  enrolled with a one-time token therefore returns it under a different key,
  unlinked from the agent registered on the Agents page and from that agent's
  mandate. Before its revoke, such a reassign prints a warning that names the
  agent key and says how to keep the link: unenroll that agent, register it
  in the target workspace, and run the command its page shows. When it fails
  after its revoke, the error sends the operator to the Agents page too.
  #4410 tracks carrying the agent link through a reassign.

## Alternatives considered

- **Keep the first enrollment in the tacho directory and give later agents
  their own directories.** This was the first version of this ADR. It kept
  the old layout for a machine with one agent, but it made the first agent a
  different kind of thing: commands, the daemon, the desktop app, and the
  tests each had to handle a root case and an agent case, and an operator
  enroll could still revoke the root to add a harness. Rejected because most
  runtimes will run more than one harness, so the special case would be the
  common case.
- **A map of enrollments in `host.json`.** A map still needs a device key, a
  credential store, a WAL, a spool, and two ports for each entry, so it needs
  per-agent paths anyway. It would also change the stored `tacho.host.v1`
  format that the desktop app, the install rig, and older binaries parse.
- **One service per agent.** Rejected for the reasons in decision 3.
- **Replace the enrollment when a second token arrives.** This was the
  behavior before this ADR, through `--force`. Rejected because it revokes the
  first agent, which is #4371.
- **Directories named by harness or by enrollment id.** Rejected because a
  harness can move between agents, and the enrollment id changes on every
  `reassign` and `enroll --force`, so the directory would move with either.
- **A bare `tacho unenroll` that removes every agent.** Rejected because a
  command that names no agent should not take all of them off the machine.
